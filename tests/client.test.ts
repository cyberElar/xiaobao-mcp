import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createHash } from "node:crypto";
import { SchoolisClient } from "../src/schoolis/client.js";
import { passwordPayload } from "../src/schoolis/session.js";
import { writePrivateJson } from "../src/storage.js";
import { fixture, localServer } from "./helpers.js";

test("client identifies HTTP 200 session failures and authenticates at most once during concurrent renewal", async t => {
  const { config } = fixture(t);
  let logins = 0;
  let queries = 0;
  let expired = true;
  const upstream = await localServer(t, (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname.endsWith("GetStudentCaptchaForLogin")) { res.end(JSON.stringify({ state: 0, data: "" })); return; }
    if (url.pathname.endsWith("/Login")) {
      logins++;
      expired = false;
      res.setHeader("Set-Cookie", "session=valid; HttpOnly; Path=/");
      res.end(JSON.stringify({ state: 0, data: true })); return;
    }
    if (expired || req.headers.cookie !== "session=valid") {
      res.end(JSON.stringify({ state: 999901, data: "" })); return;
    }
    if (url.pathname.endsWith("GetCurrentStudentInfo")) {
      res.end(JSON.stringify({ state: 0, data: { loginName: "student" } })); return;
    }
    queries++;
    res.end(JSON.stringify({ state: 0, data: [{ id: 123 }] }));
  });
  config.schoolUrl = new URL(upstream.origin);
  writePrivateJson(config.credentialsFile, { name: "student", password: "Example-password-1" });
  const client = new SchoolisClient(config);
  const results = await Promise.all([
    client.query("/api/School/GetSchoolSemesters"),
    client.query("/api/School/GetSchoolSemesters"),
  ]);
  assert.equal(logins, 1);
  assert.deepEqual(results[0], [{ id: 123 }]);
  assert.equal(client.session.loginName, "student");
  const previousQueries = queries;
  (results[0] as { id: number }[])[0]!.id = 0;
  assert.deepEqual(await client.query("/api/School/GetSchoolSemesters"), [{ id: 123 }]);
  assert.equal(queries, previousQueries);
  assert.ok(!readFileSync(config.sessionFile, "utf8").includes("Example-password-1"));
  expired = true;
  await client.query("/api/LearningTask/GetStuSubjectListForSelect", { semesterId: 123 });
  assert.equal(logins, 2);
});

test("session import accepts browser storage state, validates identity and refuses account drift", async t => {
  const { config } = fixture(t);
  let loginName = "student";
  const upstream = await localServer(t, (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ state: 0, data: { loginName } }));
  });
  config.schoolUrl = new URL(upstream.origin);
  config.cacheTtlMs = 0;
  const client = new SchoolisClient(config);
  await client.session.importCookies({ cookies: [{ name: "session", value: "valid", domain: "127.0.0.1", path: "/", expires: -1 }] });
  client.session.save();
  await client.getProfile();
  loginName = "other-student";
  await assert.rejects(client.getProfile(), { code: "IDENTITY_MISMATCH" });
  const changed = new SchoolisClient(config);
  await assert.rejects(changed.getProfile(), { code: "IDENTITY_MISMATCH" });
});

test("client fails closed for invalid identity, captcha challenges and timeouts", async t => {
  const { config } = fixture(t);
  let mode = "identity";
  const upstream = await localServer(t, (_req, res) => {
    if (mode === "timeout") return;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ state: 0, data: mode === "identity" ? {} : "data:image/png;base64,aGVsbG8=" }));
  });
  config.schoolUrl = new URL(upstream.origin);
  config.timeoutMs = 1000;
  const client = new SchoolisClient(config);
  await assert.rejects(client.getProfile(), { code: "IDENTITY_UNVERIFIED" });
  mode = "captcha";
  await assert.rejects(client.login({ name: "student", password: "example" }), { code: "CAPTCHA_REQUIRED" });
  mode = "timeout";
  config.timeoutMs = 30;
  await assert.rejects(client.getProfile(), { code: "UPSTREAM_TIMEOUT" });
});

test("login payload uses the website's timestamped MD5 protocol without including plaintext", () => {
  const credentials = { name: "student", password: "Example-password-1" };
  const payload = passwordPayload(credentials, 1_700_000_000_000);
  const md5 = (input: string) => createHash("md5").update(input).digest("hex").toUpperCase();
  assert.equal(payload.password, md5(md5(credentials.password) + "1700000000"));
  assert.equal(payload.timestamp, 1700000000);
  assert.equal(payload.isWeekPassword, false);
  assert.ok(!JSON.stringify(payload).includes(credentials.password));
});

test("failed automatic login does not repeatedly submit credentials on subsequent tool calls", async t => {
  const { config } = fixture(t);
  let attempts = 0;
  const upstream = await localServer(t, (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url!.endsWith("GetStudentCaptchaForLogin")) {
      res.end(JSON.stringify({ state: 0, data: "" }));
    } else if (req.url!.startsWith("/api/MemberShip/Login?")) {
      attempts++;
      res.end(JSON.stringify({ state: 1010076, data: "" }));
    } else res.end(JSON.stringify({ state: 999901, data: "" }));
  });
  config.schoolUrl = new URL(upstream.origin);
  writePrivateJson(config.credentialsFile, { name: "student", password: "invalid-test-password" });
  const client = new SchoolisClient(config);
  await assert.rejects(client.getProfile(), { code: "UPSTREAM_BUSINESS_ERROR" });
  await assert.rejects(client.getProfile(), { code: "LOGIN_RETRY_BLOCKED" });
  assert.equal(attempts, 1);
});
