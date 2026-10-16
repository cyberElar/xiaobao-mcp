import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { OwnerOAuthProvider, SCOPE, WRITE_SCOPE } from "../src/auth.js";
import { SchoolisClient } from "../src/schoolis/client.js";
import { MicrosoftClient } from "../src/microsoft/client.js";
import { sessionWithTokens } from "../src/microsoft/session.js";
import { writePrivateJson } from "../src/storage.js";
import { fixture, localServer } from "./helpers.js";

test("OAuth, MCP discovery and calculation work through the HTTP contract with PKCE and resource binding", async t => {
  const { config } = fixture(t);
  const { server, origin } = await localServer(t);
  config.publicUrl = new URL(origin);
  config.resourceUrl = new URL("/mcp", origin);
  let validSchoolSession = false;
  let schoolRequest: URL | undefined;
  let uploadBytes = 0;
  const school = new SchoolisClient(config, async (input, init) => {
    const url = new URL(String(input));
    schoolRequest = url;
    const response = !validSchoolSession ? { state: 999901, data: "" }
      : url.pathname.endsWith("GetCurrentStudentInfo") ? { state: 0, data: { loginName: "student" } }
      : url.pathname.endsWith("GetDetail") ? { state: 0, data: { id: 7, learningTaskState: 2, learningTaskStudentDocuments: [] } }
      : url.pathname.endsWith("UploadDocument") ? { state: 0, data: { url: "https://cdn.schoolis.cn/upload.bin" } }
      : { state: 0, data: { list: [{ id: 7 }], totalCount: 2 } };
    if (url.pathname.endsWith("UploadDocument")) {
      assert.ok(init?.body instanceof FormData);
      uploadBytes = (init.body.get("fileBase") as File).size;
    }
    return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } });
  });
  let eventWrites = 0;
  const microsoft = new MicrosoftClient(config, async (input, init) => {
    if (new URL(String(input)).pathname === "/v1.0/me") return Response.json({ id: "ms-owner" });
    eventWrites++;
    assert.equal(init?.method, "POST");
    const event = JSON.parse(String(init?.body));
    return Response.json({ id: "event-1", subject: event.subject, start: event.start, end: event.end }, { status: 201 });
  });
  const { app } = createApp(config, school, microsoft);
  server.on("request", app);
  const unauthorized = await fetch(`${origin}/mcp`, { method: "POST" });
  assert.equal(unauthorized.status, 401);
  assert.ok(unauthorized.headers.get("www-authenticate")?.includes("/.well-known/oauth-protected-resource/mcp"));
  const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`).then(res => res.json());
  assert.equal(metadata.resource, config.resourceUrl.href);
  const authMetadata = await fetch(`${origin}/.well-known/oauth-authorization-server`).then(res => res.json());
  assert.deepEqual(authMetadata.code_challenge_methods_supported, ["S256"]);

  const redirectUri = "https://client.example/callback";
  const registered = await fetch(`${origin}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Local contract test", redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
    }),
  });
  assert.equal(registered.status, 201);
  const registration = await registered.json();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${origin}/authorize`);
  authorize.search = new URLSearchParams({
    client_id: registration.client_id, redirect_uri: redirectUri, response_type: "code",
    code_challenge: challenge, code_challenge_method: "S256", scope: SCOPE,
    resource: config.resourceUrl.href, state: "test-state",
  }).toString();
  const consent = await fetch(authorize);
  assert.equal(consent.status, 200);
  assert.equal(consent.headers.get("referrer-policy"), "same-origin");
  assert.ok(consent.headers.get("content-security-policy")?.includes("form-action 'self' https://client.example;"));
  const cookie = consent.headers.getSetCookie()[0]!.split(";")[0]!;
  const html = await consent.text();
  const transaction = /name="transaction" value="([^"]+)"/.exec(html)![1]!;
  const approve = (key: string, includeCookie = true, consentOrigin: string | null = origin) => fetch(`${origin}/consent`, {
    method: "POST", redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(consentOrigin === null ? {} : { Origin: consentOrigin }),
      ...(includeCookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams({ transaction, ownerKey: key }),
  });
  for (const consentOrigin of [null, "null", "https://untrusted.example"]) {
    assert.equal((await approve(config.ownerKey, true, consentOrigin)).status, 403);
  }
  assert.equal((await approve(config.ownerKey, false)).status, 400);
  assert.equal((await approve("incorrect")).status, 403);
  const approved = await approve(config.ownerKey);
  assert.equal(approved.status, 302);
  const callback = new URL(approved.headers.get("location")!);
  assert.equal(callback.searchParams.get("state"), "test-state");
  const code = callback.searchParams.get("code")!;
  const tokenRequest = (parameters: Record<string, string>) => fetch(`${origin}/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: registration.client_id, ...parameters }),
  });
  const grant = {
    grant_type: "authorization_code", code, code_verifier: verifier,
    redirect_uri: redirectUri, resource: config.resourceUrl.href,
  };
  assert.equal((await tokenRequest({ ...grant, code_verifier: "incorrect" })).status, 400);
  assert.equal((await tokenRequest({ ...grant, resource: "https://wrong.example/mcp" })).status, 400);
  const tokenResponse = await tokenRequest(grant);
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.equal((await tokenRequest(grant)).status, 400);
  assert.ok(!readFileSync(config.oauthFile, "utf8").includes(tokens.access_token));
  assert.equal(statSync(config.oauthFile).mode & 0o777, 0o600);
  const restored = new OwnerOAuthProvider(config);
  assert.equal((await restored.verifyAccessToken(tokens.access_token)).resource.href, config.resourceUrl.href);

  const transport = new StreamableHTTPClientTransport(config.resourceUrl, { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } });
  const mcp = new Client({ name: "contract-test", version: "1" });
  t.after(() => mcp.close());
  await mcp.connect(transport);
  const discovery = await mcp.listTools();
  assert.equal(discovery.tools.length, 39);
  assert.equal(discovery.tools.filter(tool => tool.annotations?.readOnlyHint === true).length, 33);
  assert.equal(discovery.tools.filter(tool => tool.annotations?.readOnlyHint === false).length, 6);
  for (const tool of discovery.tools.filter(tool => tool.annotations?.readOnlyHint === false)) {
    assert.deepEqual((tool._meta!.securitySchemes as { scopes: string[] }[])[0]!.scopes, [SCOPE, WRITE_SCOPE]);
  }
  assert.deepEqual(discovery.tools.find(tool => tool.name === "upload_assignment_attachment")!._meta!["openai/fileParams"], ["file"]);
  assert.equal(discovery.tools.find(tool => tool.name === "simulate_grades")!.annotations!.readOnlyHint, true);
  const calculated = await mcp.callTool({
    name: "calculate_gpa", arguments: { courses: [{ id: "math", name: "AP Math", score: 97 }] },
  });
  assert.equal(calculated.isError, undefined);
  assert.equal((calculated.structuredContent as { weightedGpa: number }).weightedGpa, 4.8);
  const simulated = await mcp.callTool({ name: "simulate_grades", arguments: {
    categories: [{ id: "a", name: "A", weight: 1, tasks: [{ id: "a1", score: 80, totalScore: 100 }] }],
    changes: [{ categoryId: "a", taskId: "a2", action: "add", score: 100, totalScore: 100 }],
  } });
  assert.equal(simulated.isError, undefined);
  assert.equal((simulated.structuredContent as { predicted: { score: number } }).predicted.score, 90);
  const sessionMissing = await mcp.callTool({ name: "get_profile", arguments: {} });
  assert.equal(sessionMissing.isError, true);
  assert.equal((sessionMissing.structuredContent as { error: { code: string } }).error.code, "SESSION_EXPIRED");
  const microsoftMissing = await mcp.callTool({ name: "get_microsoft_profile", arguments: {} });
  assert.equal((microsoftMissing.structuredContent as { error: { code: string } }).error.code, "MICROSOFT_NOT_CONNECTED");
  validSchoolSession = true;
  const assignments = await mcp.callTool({ name: "list_assignments", arguments: {
    semesterId: 5, beginTime: "2026-10-01", endTime: "2026-10-15", pageSize: 1, pageIndex: 1,
  } });
  assert.equal(assignments.isError, undefined);
  assert.equal((assignments.structuredContent as { pagination: { hasMore: boolean } }).pagination.hasMore, true);
  assert.equal(schoolRequest!.searchParams.get("semesterId"), "5");
  assert.equal(schoolRequest!.searchParams.get("beginTime"), "2026-10-01");
  assert.equal(schoolRequest!.searchParams.get("subjectId"), "null");
  const invalidSchedule = await mcp.callTool({ name: "get_schedule", arguments: {
    beginTime: "2026-10-01", endTime: "2026-11-03",
  } });
  assert.equal((invalidSchedule.structuredContent as { error: { code: string } }).error.code, "INVALID_DATE_RANGE");

  const eventArgs = {
    requestId: "33333333-3333-4333-8333-333333333333", subject: "Study",
    startDateTime: "2026-10-17T10:00:00+08:00", endDateTime: "2026-10-17T11:00:00+08:00",
  };
  const deniedWrite = await mcp.callTool({ name: "create_outlook_event", arguments: eventArgs });
  assert.equal((deniedWrite.structuredContent as { error: { code: string } }).error.code, "INSUFFICIENT_SCOPE");
  assert.ok(JSON.stringify(deniedWrite._meta!["mcp/www_authenticate"]).includes(WRITE_SCOPE));
  assert.equal(eventWrites, 0);
  const writeVerifier = randomBytes(32).toString("base64url");
  const writeAuthorize = new URL(authorize);
  writeAuthorize.searchParams.set("scope", `${SCOPE} ${WRITE_SCOPE}`);
  writeAuthorize.searchParams.set("code_challenge", createHash("sha256").update(writeVerifier).digest("base64url"));
  const writeConsent = await fetch(writeAuthorize);
  assert.equal(writeConsent.status, 200);
  const writeHtml = await writeConsent.text();
  assert.ok(writeHtml.includes("写入权限"));
  const writeTransaction = /name="transaction" value="([^"]+)"/.exec(writeHtml)![1]!;
  const writeApproved = await fetch(`${origin}/consent`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, Cookie: writeConsent.headers.getSetCookie()[0]!.split(";")[0]! },
    body: new URLSearchParams({ transaction: writeTransaction, ownerKey: config.ownerKey }),
  });
  assert.equal(writeApproved.status, 302);
  const writeCode = new URL(writeApproved.headers.get("location")!).searchParams.get("code")!;
  const writeTokensResponse = await tokenRequest({ ...grant, code: writeCode, code_verifier: writeVerifier });
  assert.equal(writeTokensResponse.status, 200);
  const writeTokens = await writeTokensResponse.json();
  assert.equal(writeTokens.scope, `${SCOPE} ${WRITE_SCOPE}`);
  writePrivateJson(config.microsoftFile, sessionWithTokens({
    clientId: "11111111-1111-4111-8111-111111111111", tenantId: "22222222-2222-4222-8222-222222222222",
  }, "ms-owner", { access_token: "ms-access", refresh_token: "ms-refresh", expires_in: 3600, token_type: "bearer", scope: "User.Read Calendars.ReadWrite" }));
  const writer = new Client({ name: "write-contract-test", version: "1" });
  t.after(() => writer.close());
  await writer.connect(new StreamableHTTPClientTransport(config.resourceUrl, { requestInit: { headers: { Authorization: `Bearer ${writeTokens.access_token}` } } }));
  const created = await writer.callTool({ name: "create_outlook_event", arguments: eventArgs });
  assert.equal(created.isError, undefined);
  assert.equal((created.structuredContent as { data: { created: boolean } }).data.created, true);
  await writer.callTool({ name: "create_outlook_event", arguments: eventArgs });
  assert.equal(eventWrites, 1);
  const uploaded = await writer.callTool({ name: "upload_assignment_attachment", arguments: {
    learningTaskId: 7, requestId: eventArgs.requestId, filename: "upload.bin", contentBase64: Buffer.alloc(150_000, 1).toString("base64"),
  } });
  assert.equal(uploaded.isError, undefined);
  assert.equal(uploadBytes, 150_000);
  assert.equal((await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, scope: `${SCOPE} ${WRITE_SCOPE}` })).status, 400);
  const refreshedResponse = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: config.resourceUrl.href });
  assert.equal(refreshedResponse.status, 200);
  const refreshed = await refreshedResponse.json();
  assert.equal((await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status, 400);
  assert.equal((await fetch(`${origin}/mcp`, { headers: { Authorization: `Bearer ${refreshed.access_token}` } })).status, 401);
});

test("server rejects foreign origins and Host headers before exposing MCP data", async t => {
  const { config } = fixture(t);
  const { server, origin } = await localServer(t);
  config.publicUrl = new URL(origin);
  config.resourceUrl = new URL("/mcp", origin);
  server.on("request", createApp(config).app);
  assert.equal((await fetch(`${origin}/mcp`, { method: "POST", headers: { Origin: "https://untrusted.example" } })).status, 403);
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(`${origin}/healthz`, { headers: { Host: "untrusted.example" } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(hostStatus, 403);
});
