import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { MicrosoftClient } from "../src/microsoft/client.js";
import { MicrosoftOAuth } from "../src/microsoft/oauth.js";
import { bindMicrosoftSession, sessionWithTokens } from "../src/microsoft/session.js";
import { SchoolisClient } from "../src/schoolis/client.js";
import { writePrivateJson } from "../src/storage.js";
import { createMcpServer } from "../src/tools.js";
import { fixture } from "./helpers.js";

const app = { clientId: "11111111-1111-4111-8111-111111111111", tenantId: "22222222-2222-4222-8222-222222222222" };
const tokens = {
  access_token: "old-access", refresh_token: "old-refresh", expires_in: 3600, token_type: "bearer" as const,
  scope: "User.Read EduRoster.ReadBasic EduAssignments.Read Calendars.Read",
};
const classesPath = "/v1.0/education/me/classes";
const assignmentPath = "/v1.0/education/classes/class-1/assignments/assignment-1";

function bound(t: TestContext, expired = false) {
  const { config } = fixture(t);
  const session = sessionWithTokens(app, "owner", tokens);
  if (expired) session.expiresAt = 0;
  writePrivateJson(config.microsoftFile, session);
  return { config, session };
}

test("Microsoft expiry and concurrent reads share one refresh, verify identity and persist rotated private tokens", async t => {
  const { config } = bound(t, true);
  let refreshes = 0;
  const methods: string[] = [];
  const client = new MicrosoftClient(config, async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "login.microsoftonline.com") {
      refreshes++;
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("refresh_token"), "old-refresh");
      assert.equal(form.get("client_id"), app.clientId);
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.ok(!form.get("scope")!.includes("ReadWrite"));
      return Response.json({ ...tokens, access_token: "new-access", refresh_token: "new-refresh" });
    }
    methods.push(init!.method!);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer new-access");
    assert.equal(new Headers(init?.headers).has("Cookie"), false);
    return Response.json(url.pathname === "/v1.0/me" ? { id: "owner", displayName: "Student" } : { value: [{ id: "class-1" }] });
  });
  const profiles = await Promise.all([client.getProfile(), client.getProfile(), client.page(classesPath, { $top: "5" })]);
  assert.equal(refreshes, 1);
  assert.deepEqual(profiles[0], { id: "owner", displayName: "Student" });
  assert.ok(methods.every(method => method === "GET"));
  const saved = JSON.parse(readFileSync(config.microsoftFile, "utf8"));
  assert.equal(saved.refreshToken, "new-refresh");
  assert.equal(saved.accountId, "owner");
  assert.ok(saved.expiresAt > Date.now());
  assert.equal(statSync(config.microsoftFile).mode & 0o777, 0o600);
});

test("Microsoft 401 recovery refreshes once while 403 and invalid refresh grants stop without repeated login", async t => {
  const { config } = bound(t);
  let refreshes = 0;
  let rejectAccess = true;
  const client = new MicrosoftClient(config, async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "login.microsoftonline.com") {
      refreshes++;
      rejectAccess = false;
      return Response.json({ ...tokens, access_token: "new-access" });
    }
    if (rejectAccess) return Response.json({ error: { code: "InvalidAuthenticationToken" } }, { status: 401 });
    return url.pathname === "/v1.0/me" ? Response.json({ id: "owner" }) : Response.json({ error: { code: "Forbidden" } }, { status: 403 });
  });
  assert.equal((await client.getProfile()).id, "owner");
  await assert.rejects(client.page(classesPath), { code: "MICROSOFT_FORBIDDEN" });
  assert.equal(refreshes, 1);
  const saved = JSON.parse(readFileSync(config.microsoftFile, "utf8"));
  saved.expiresAt = 0;
  writePrivateJson(config.microsoftFile, saved);
  const invalid = new MicrosoftClient(config, async () => {
    refreshes++;
    return Response.json({ error: "invalid_grant", error_description: "sensitive upstream information" }, { status: 400 });
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(invalid.getProfile(), error => {
      assert.equal((error as { code: string }).code, "MICROSOFT_REAUTH_REQUIRED");
      assert.ok(!(error as Error).message.includes("sensitive"));
      return true;
    });
  }
  assert.equal(refreshes, 2);
});

test("Microsoft refuses account drift before reading data and keeps the previous binding on failed refresh verification", async t => {
  const { config } = bound(t);
  const before = readFileSync(config.microsoftFile, "utf8");
  let graphReads = 0;
  const changed = new MicrosoftClient(config, async () => { graphReads++; return Response.json({ id: "another-account" }); });
  await assert.rejects(changed.page(classesPath), { code: "MICROSOFT_IDENTITY_MISMATCH" });
  assert.equal(graphReads, 1);
  assert.equal(readFileSync(config.microsoftFile, "utf8"), before);
  const expired = JSON.parse(before);
  expired.expiresAt = 0;
  writePrivateJson(config.microsoftFile, expired);
  const previous = readFileSync(config.microsoftFile, "utf8");
  const refresh = new MicrosoftClient(config, async input => new URL(String(input)).hostname === "login.microsoftonline.com"
    ? Response.json({ ...tokens, access_token: "changed-account" }) : Response.json({ id: "another-account" }));
  await assert.rejects(refresh.getProfile(), { code: "MICROSOFT_IDENTITY_MISMATCH" });
  assert.equal(readFileSync(config.microsoftFile, "utf8"), previous);
});

test("Graph cursors bind account, endpoint and filters and reject foreign next links without forwarding credentials", async t => {
  const { config } = bound(t);
  let requests = 0;
  let foreignNext = false;
  const client = new MicrosoftClient(config, async input => {
    requests++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://graph.microsoft.com");
    if (url.pathname === "/v1.0/me") return Response.json({ id: "owner" });
    if (url.searchParams.has("$skiptoken")) return Response.json({ value: [{ id: "class-2" }] });
    return Response.json({ value: [{ id: "class-1" }], "@odata.nextLink": foreignNext
      ? "https://other.example/steal" : `https://graph.microsoft.com${classesPath}?$skiptoken=next` });
  });
  const first = await client.page(classesPath, { $top: "5" });
  assert.equal(first.pagination.hasMore, true);
  assert.ok(!("@odata.nextLink" in first.data));
  const cursor = first.pagination.cursor!;
  const next = await client.page(classesPath, { $top: "5" }, cursor);
  assert.deepEqual(next.data.value, [{ id: "class-2" }]);
  assert.equal(next.pagination.hasMore, false);
  const before = requests;
  for (const [path, params, value] of [
    [classesPath, { $top: "6" }, cursor],
    [assignmentPath, { $top: "5" }, cursor],
    [classesPath, { $top: "5" }, cursor + "tampered"],
    [classesPath, { $top: "5" }, "https://graph.microsoft.com/v1.0/me/messages"],
  ] as const) await assert.rejects(client.page(path, params, value), { code: "MICROSOFT_INVALID_CURSOR" });
  await assert.rejects(client.query("/v1.0/users/another-account"), { code: "MICROSOFT_INVALID_ENDPOINT" });
  assert.equal(requests, before);
  foreignNext = true;
  await assert.rejects(client.page(classesPath, { $top: "7" }), { code: "MICROSOFT_INVALID_CURSOR" });
  const session = JSON.parse(readFileSync(config.microsoftFile, "utf8"));
  session.accountId = "another-account";
  writePrivateJson(config.microsoftFile, session);
  const another = new MicrosoftClient(config, async () => Response.json({ id: "another-account" }));
  await assert.rejects(another.page(classesPath, { $top: "5" }, cursor), { code: "MICROSOFT_INVALID_CURSOR" });
});

test("Teams submissions are restricted to the owner and outcomes expose published fields only", async t => {
  const { config } = bound(t);
  let outcomesReads = 0;
  const client = new MicrosoftClient(config, async input => {
    const url = new URL(String(input));
    if (url.pathname === "/v1.0/me") return Response.json({ id: "owner" });
    if (url.pathname.endsWith("/outcomes")) {
      outcomesReads++;
      return Response.json({ value: [
        { id: "points", "@odata.type": "#microsoft.graph.educationPointsOutcome", score: { points: 95 }, publishedScore: { points: 80 } },
        { id: "feedback", feedback: { text: "draft" }, publishedFeedback: { text: "published" } },
      ] });
    }
    if (url.pathname.endsWith("/submissions/other")) return Response.json({ recipient: { userId: "another-account" } });
    if (url.pathname.endsWith("/submissions/own")) return Response.json({ recipient: { userId: "owner" } });
    return Response.json({ value: [{ id: "own", recipient: { userId: "owner" } }, { id: "other", recipient: { userId: "another-account" } }] });
  });
  const own = await client.ownSubmissions(`${assignmentPath}/submissions`, {});
  assert.deepEqual(own.data.value, [{ id: "own", recipient: { userId: "owner" } }]);
  const outcomes = await client.publishedOutcomes(`${assignmentPath}/submissions/own`, {});
  assert.deepEqual(outcomes.data.value, [
    { id: "points", "@odata.type": "#microsoft.graph.educationPointsOutcome", publishedScore: { points: 80 } },
    { id: "feedback", publishedFeedback: { text: "published" } },
  ]);
  await assert.rejects(client.publishedOutcomes(`${assignmentPath}/submissions/other`, {}), { code: "MICROSOFT_NOT_OWN_SUBMISSION" });
  assert.equal(outcomesReads, 1);
});

test("device login uses the configured public application, read-only scopes and supported verification origins", async () => {
  let polls = 0;
  const oauth = new MicrosoftOAuth(app, 1000, async (input, init) => {
    const url = new URL(String(input));
    const body = new URLSearchParams(String(init?.body));
    assert.equal(url.origin, "https://login.microsoftonline.com");
    assert.ok(url.pathname.includes(app.tenantId));
    assert.equal(body.get("client_id"), app.clientId);
    assert.equal(body.has("client_secret"), false);
    if (url.pathname.endsWith("/devicecode")) {
      assert.ok(!body.get("scope")!.includes("ReadWrite"));
      return Response.json({ device_code: "private-device-code", user_code: "PHONECODE", verification_uri: "https://login.microsoft.com/device", expires_in: 900, interval: 1 });
    }
    assert.equal(body.get("device_code"), "private-device-code");
    polls++;
    if (polls < 3) return Response.json({ error: polls === 1 ? "authorization_pending" : "slow_down" }, { status: 400 });
    return Response.json(tokens);
  });
  const pending = await oauth.startDeviceLogin();
  assert.equal(pending.interval, 5);
  assert.equal((await oauth.pollDeviceLogin(pending)).state, "pending");
  assert.equal((await oauth.pollDeviceLogin(pending)).state, "slow_down");
  assert.equal((await oauth.pollDeviceLogin(pending)).state, "complete");
  await assert.rejects(oauth.pollDeviceLogin({ ...pending, expiresAt: 0 }), { code: "MICROSOFT_REAUTH_REQUIRED" });
  const foreign = new MicrosoftOAuth(app, 1000, async () => Response.json({
    device_code: "private", user_code: "CODE", verification_uri: "https://other.example/device", expires_in: 900,
  }));
  await assert.rejects(foreign.startDeviceLogin(), { code: "MICROSOFT_FORMAT_ERROR" });
});

test("initial Microsoft binding verifies identity before replacing private state and rejects redirects and large responses", async t => {
  const { config } = bound(t);
  const previous = readFileSync(config.microsoftFile, "utf8");
  await assert.rejects(bindMicrosoftSession(config, app, tokens, async () => Response.json({})), { code: "MICROSOFT_IDENTITY_UNVERIFIED" });
  await assert.rejects(bindMicrosoftSession(config, app, tokens, async () => Response.json({ id: "another-account" }), "owner"), { code: "MICROSOFT_IDENTITY_MISMATCH" });
  assert.equal(readFileSync(config.microsoftFile, "utf8"), previous);
  await bindMicrosoftSession(config, app, tokens, async () => Response.json({ id: "owner", displayName: "Student" }));
  assert.equal(statSync(config.microsoftFile).mode & 0o777, 0o600);
  for (const [response, code] of [
    [() => new Response(null, { status: 302, headers: { Location: "https://other.example/" } }), "MICROSOFT_REDIRECT_REJECTED"],
    [() => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "5000001" } }), "RESPONSE_TOO_LARGE"],
    [() => Response.json({ error: { code: "TooManyRequests" } }, { status: 429 }), "MICROSOFT_HTTP_ERROR"],
  ] as const) {
    await assert.rejects(new MicrosoftClient(config, async () => response()).getProfile(), { code });
  }
});

test("Microsoft MCP tools work independently of school login and preserve read-only schemas and Graph pagination", async t => {
  const { config } = bound(t);
  const requested: URL[] = [];
  const microsoft = new MicrosoftClient(config, async (input, init) => {
    const url = new URL(String(input));
    requested.push(url);
    assert.equal(init?.method, "GET");
    if (url.pathname === "/v1.0/me") return Response.json({ id: "owner" });
    if (url.pathname.endsWith("/submissions/own")) return Response.json({ recipient: { userId: "owner" } });
    if (url.pathname === assignmentPath) return Response.json({ id: "assignment-1", instructions: { content: "Task" }, access_token: "private" });
    return Response.json({ value: [{ id: "own", recipient: { userId: "owner" }, publishedScore: { points: 80 } }] });
  });
  const school = new SchoolisClient(config, async () => { throw new Error("Microsoft tools must not access Schoolis."); });
  const server = createMcpServer(school, microsoft);
  const client = new Client({ name: "microsoft-tools-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  for (const [name, args] of [
    ["get_microsoft_profile", {}],
    ["list_teams_classes", {}],
    ["list_teams_assignments", { classId: "class-1" }],
    ["get_teams_assignment_detail", { classId: "class-1", assignmentId: "assignment-1" }],
    ["list_teams_submissions", { classId: "class-1", assignmentId: "assignment-1" }],
    ["get_teams_submission_outcomes", { classId: "class-1", assignmentId: "assignment-1", submissionId: "own" }],
    ["get_outlook_calendar", { startDateTime: "2026-10-01T00:00:00+08:00", endDateTime: "2026-10-08T00:00:00+08:00" }],
  ] as const) {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent!.source, "microsoft_graph");
    assert.ok(!JSON.stringify(result).includes("private"));
  }
  assert.ok(requested.some(url => url.pathname === classesPath && url.searchParams.get("$top") === "50"));
  const before = requested.length;
  const invalid = CallToolResultSchema.parse(await client.callTool({ name: "get_outlook_calendar", arguments: {
    startDateTime: "2026-10-01T00:00:00Z", endDateTime: "2026-11-02T00:00:00Z",
  } }));
  assert.equal((invalid.structuredContent!.error as { code: string }).code, "INVALID_DATE_RANGE");
  assert.equal(requested.length, before);
});
