import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ServiceError } from "../src/errors.js";
import { WriteJournal } from "../src/writes/journal.js";
import { resolveUpload } from "../src/writes/files.js";
import { WriteServices } from "../src/writes/services.js";
import { SchoolisClient } from "../src/schoolis/client.js";
import { MicrosoftClient } from "../src/microsoft/client.js";
import { sessionWithTokens } from "../src/microsoft/session.js";
import { writePrivateJson } from "../src/storage.js";
import { fixture } from "./helpers.js";

const requestId = "33333333-3333-4333-8333-333333333333";
const secondId = "44444444-4444-4444-8444-444444444444";
const thirdId = "55555555-5555-4555-8555-555555555555";
const application = { clientId: "11111111-1111-4111-8111-111111111111", tenantId: "22222222-2222-4222-8222-222222222222" };
const tokens = {
  access_token: "access", refresh_token: "refresh", token_type: "bearer" as const, expires_in: 3600,
  scope: "User.Read EduRoster.ReadBasic EduAssignments.Read EduAssignments.ReadWrite Calendars.Read Calendars.ReadWrite Files.ReadWrite",
};
const path = "/v1.0/education/classes/class-1/assignments/assignment-1/submissions/own";

test("write journal deduplicates concurrent and restarted requests, rejects input reuse and preserves uncertain outcomes", async t => {
  const { config } = fixture(t);
  const journal = new WriteJournal(config.writeStateFile);
  let writes = 0;
  let finish!: () => void;
  const held = new Promise<void>(resolve => { finish = resolve; });
  const run = () => journal.run("owner", "submit", requestId, "assignment", { value: "private-answer" }, async () => { writes++; await held; return { accepted: true }; });
  const first = run();
  const duplicate = run();
  await assert.rejects(new WriteJournal(config.writeStateFile).run("owner", "submit", requestId, "assignment", { value: "private-answer" }, async () => ({})), { code: "WRITE_OUTCOME_UNKNOWN" });
  await assert.rejects(journal.run("owner", "submit", secondId, "assignment", {}, async () => ({})), { code: "WRITE_IN_PROGRESS" });
  finish();
  assert.deepEqual(await first, await duplicate);
  assert.equal(writes, 1);
  assert.deepEqual(await new WriteJournal(config.writeStateFile).run("owner", "submit", requestId, "assignment", { value: "private-answer" }, async () => { throw new Error("Must not repeat"); }), { accepted: true });
  await assert.rejects(journal.run("owner", "submit", requestId, "assignment", { value: "changed" }, async () => ({})), { code: "WRITE_REQUEST_CONFLICT" });
  let attempts = 0;
  const uncertain = () => journal.run("owner", "submit", secondId, "assignment", {}, async () => { attempts++; throw new ServiceError("MICROSOFT_TIMEOUT", "timeout", true); });
  await assert.rejects(uncertain(), { code: "WRITE_OUTCOME_UNKNOWN" });
  await assert.rejects(uncertain(), { code: "WRITE_OUTCOME_UNKNOWN" });
  assert.equal(attempts, 1);
  assert.ok(!readFileSync(config.writeStateFile, "utf8").includes("private-answer"));
});

test("upload sources enforce size, canonical base64 and trusted ChatGPT origins without forwarding credentials", async () => {
  const source = { filename: "answer.txt", file: { file_id: "file-1", download_url: "https://files.oaiusercontent.com/file-1?signature=private", mime_type: "text/plain" } };
  const resolved = await resolveUpload(source, async (_input, init) => {
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    assert.equal(new Headers(init?.headers).has("Cookie"), false);
    return new Response("answer");
  });
  assert.equal(resolved.bytes.toString(), "answer");
  assert.equal((await resolveUpload({ filename: "answer.txt", text: "answer" })).mime, "text/plain");
  const binary = Buffer.alloc(150_000, 7);
  assert.deepEqual((await resolveUpload({ filename: "binary.bin", contentBase64: binary.toString("base64") })).bytes, binary);
  await assert.rejects(resolveUpload({ filename: "answer.txt", text: "a", contentBase64: "YQ==" }), { code: "INVALID_UPLOAD" });
  await assert.rejects(resolveUpload({ filename: "../answer.txt", text: "a" }), { code: "INVALID_UPLOAD" });
  await assert.rejects(resolveUpload({ filename: "answer.txt", contentBase64: "YR==" }), { code: "INVALID_UPLOAD" });
  await assert.rejects(resolveUpload({ filename: "answer.txt", text: "a".repeat(5_000_001) }), { code: "UPLOAD_TOO_LARGE" });
  for (const url of ["https://127.0.0.1/private", "https://files.oaiusercontent.com.other.example/file", "http://files.oaiusercontent.com/file"]) {
    await assert.rejects(resolveUpload({ ...source, file: { ...source.file, download_url: url } }, async () => { throw new Error("Must not fetch"); }), { code: "UPLOAD_URL_REJECTED" });
  }
  await assert.rejects(resolveUpload(source, async () => new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/" } })), { code: "UPLOAD_DOWNLOAD_FAILED" });
  await assert.rejects(resolveUpload(source, async () => new Response("", { headers: { "Content-Length": "5000001" } })), { code: "UPLOAD_TOO_LARGE" });
});

test("school uploads use multipart and bound receipts; submission preserves existing files and does not repeat Save", async t => {
  const { config } = fixture(t);
  let uploads = 0;
  let saves = 0;
  let state = 2;
  let closed = false;
  let answer = "existing answer";
  let documents = [{ id: 9, name: "existing.txt", type: ".txt", size: 10, url: "https://cdn.schoolis.cn/existing.txt", pdfUrl: "" }];
  const client = new SchoolisClient(config, async (input, init) => {
    const url = new URL(String(input));
    let data: unknown;
    if (url.pathname.endsWith("GetCurrentStudentInfo")) data = { loginName: "student" };
    else if (url.pathname.endsWith("GetDetail")) data = {
      id: Number(url.searchParams.get("learningTaskId")), learningTaskState: state,
      isFirstSubmissionClosed: closed, remark: answer, learningTaskStudentDocuments: documents,
    };
    else if (url.pathname.endsWith("ContinueAnswerForLearningtask")) data = true;
    else if (url.pathname.endsWith("UploadDocument")) {
      uploads++;
      assert.equal(init?.method, "POST");
      assert.ok(init?.body instanceof FormData);
      const file = init.body.get("fileBase") as File;
      assert.equal(file.name, "answer.txt");
      assert.equal(await file.text(), "new file");
      assert.equal(new Headers(init.headers).has("Content-Type"), false);
      data = { url: "https://cdn.schoolis.cn/new.txt", pdfUrl: null };
    } else if (url.pathname.endsWith("/Save")) {
      saves++;
      const body = JSON.parse(String(init?.body));
      answer = body.remark;
      documents = body.learningTaskStudentDocuments;
      state = 3;
      data = true;
    } else throw new Error("Unexpected school endpoint.");
    return Response.json({ state: 0, data });
  });
  const services = new WriteServices(config, client, new MicrosoftClient(config));
  const upload = await services.school.upload("7", requestId, { filename: "answer.txt", text: "new file" });
  assert.equal(upload.submitted, false);
  assert.equal(saves, 0);
  const input = { learningTaskId: "7", requestId: secondId, remark: "new answer", uploadReceipts: [upload.uploadReceipt], keepExistingAttachments: true };
  const result = await services.school.submit(input);
  assert.equal(result.accepted, true);
  assert.equal(result.attachmentCount, 2);
  assert.equal(documents[0]!.id, 9);
  assert.equal(documents[1]!.name, "answer.txt");
  assert.deepEqual(await new WriteServices(config, client, new MicrosoftClient(config)).school.submit(input), result);
  assert.equal(saves, 1);
  assert.equal(uploads, 1);
  await assert.rejects(services.school.submit({ ...input, learningTaskId: "8", requestId: thirdId }), { code: "INVALID_UPLOAD_RECEIPT" });
  assert.equal(saves, 1);
  closed = true;
  await assert.rejects(services.school.upload("9", secondId, { filename: "answer.txt", text: "new file" }), { code: "ASSIGNMENT_NOT_EDITABLE" });
  assert.equal(uploads, 1);
  await assert.rejects(client.query("/api/LearningTask/Save", {}, {}), { code: "INVALID_ENDPOINT" });
});

test("Teams submission writes verify ownership and status, handle empty 204 responses and stop at missing file permissions", async t => {
  const { config } = fixture(t);
  writePrivateJson(config.microsoftFile, sessionWithTokens(application, "owner", { ...tokens, scope: tokens.scope.replace(" Files.ReadWrite", "") }));
  let state = "working";
  let owner = "owner";
  const writes: string[] = [];
  const microsoft = new MicrosoftClient(config, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1.0/me") return Response.json({ id: "owner" });
    if (init?.method === "GET") return Response.json({ recipient: { userId: owner }, status: state });
    writes.push(url.pathname);
    assert.equal(init?.method, "POST");
    if (url.pathname.endsWith("/submit")) { state = "submitted"; return Response.json({ status: state }); }
    state = "working";
    return new Response(null, { status: 204 });
  });
  const service = new WriteServices(config, new SchoolisClient(config), microsoft).microsoft;
  await assert.rejects(microsoft.mutate("/v1.0/me/sendMail", {}), { code: "MICROSOFT_INVALID_ENDPOINT" });
  await service.submission("submit", path, requestId);
  assert.equal(state, "submitted");
  await service.submission("submit", path, requestId);
  assert.equal(writes.length, 1);
  await service.submission("unsubmit", path, secondId);
  assert.equal(state, "working");
  await assert.rejects(service.upload(path, thirdId, { filename: "answer.txt", text: "answer" }), { code: "MICROSOFT_WRITE_PERMISSION_REQUIRED" });
  assert.equal(writes.length, 2);
  owner = "another-account";
  await assert.rejects(service.submission("submit", path, thirdId), { code: "MICROSOFT_NOT_OWN_SUBMISSION" });
  assert.equal(writes.length, 2);
  owner = "owner";
  state = "released";
  await assert.rejects(service.submission("unsubmit", path, thirdId), { code: "SUBMISSION_NOT_EDITABLE" });
  assert.equal(writes.length, 2);
});

test("Teams upload performs folder, file and attachment stages, retains write grants during refresh and reports partial failures", async t => {
  const { config } = fixture(t);
  const session = sessionWithTokens(application, "owner", tokens);
  session.expiresAt = 0;
  writePrivateJson(config.microsoftFile, session);
  let fileWrites = 0;
  let attaches = 0;
  let failAttach = false;
  let folderExists = false;
  const microsoft = new MicrosoftClient(config, async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "login.microsoftonline.com") {
      assert.ok(new URLSearchParams(String(init?.body)).get("scope")!.includes("Files.ReadWrite"));
      return Response.json(tokens);
    }
    if (url.pathname === "/v1.0/me") return Response.json({ id: "owner" });
    if (init?.method === "GET" && url.pathname === path) return Response.json({
      recipient: { userId: "owner" }, status: "working",
      resourcesFolderUrl: folderExists ? "https://graph.microsoft.com/v1.0/drives/b!drive/items/folder" : null,
    });
    if (init?.method === "GET") return Response.json({ allowStudentsToAddResources: true });
    if (url.pathname.endsWith("/setUpResourcesFolder")) {
      folderExists = true;
      return Response.json({ resourcesFolderUrl: "https://graph.microsoft.com/v1.0/drives/b!drive/items/folder" });
    }
    if (init?.method === "PUT") {
      fileWrites++;
      assert.match(decodeURIComponent(url.pathname), /mcp-[a-f0-9-]+-answer.txt/);
      assert.equal(Buffer.from(init.body as Uint8Array).toString(), "answer");
      return Response.json({ id: `item-${fileWrites}`, name: "stored-answer.txt" }, { status: 201 });
    }
    assert.ok(url.pathname.endsWith("/resources"));
    attaches++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.resource.displayName, "answer.txt");
    assert.equal(body.resource["@odata.type"], "#microsoft.graph.educationFileResource");
    assert.equal(body.resource.fileUrl, `https://graph.microsoft.com/v1.0/drives/b!drive/items/item-${fileWrites}`);
    return failAttach ? Response.json({ error: { code: "Forbidden" } }, { status: 403 }) : Response.json({ id: "resource-1" }, { status: 201 });
  });
  const service = new WriteServices(config, new SchoolisClient(config), microsoft).microsoft;
  const source = { filename: "answer.txt", text: "answer" };
  const result = await service.upload(path, requestId, source);
  assert.equal(result.resourceId, "resource-1");
  assert.equal(result.submitted, false);
  await service.upload(path, requestId, source);
  assert.equal(fileWrites, 1);
  failAttach = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(service.upload(path, secondId, source), error => {
      assert.equal((error as ServiceError).code, "WRITE_OUTCOME_UNKNOWN");
      assert.equal((error as ServiceError).details?.stage, "fileUploaded");
      return true;
    });
  }
  assert.equal(fileWrites, 2);
  assert.equal(attaches, 2);
});

test("Outlook creation uses UTC, a stable transactionId and no attendees, and write invalidates cached calendar results", async t => {
  const { config } = fixture(t);
  writePrivateJson(config.microsoftFile, sessionWithTokens(application, "owner", tokens));
  let creations = 0;
  let calendarReads = 0;
  const microsoft = new MicrosoftClient(config, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1.0/me") return Response.json({ id: "owner" });
    if (init?.method === "GET") { calendarReads++; return Response.json({ value: [] }); }
    creations++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.start.dateTime, "2026-10-17T02:00:00.000");
    assert.equal(body.start.timeZone, "UTC");
    assert.equal(body.transactionId, requestId);
    assert.equal(body.attendees, undefined);
    return Response.json({ id: "event-1", subject: body.subject, start: body.start, end: body.end }, { status: 201 });
  });
  const service = new WriteServices(config, new SchoolisClient(config), microsoft).microsoft;
  await microsoft.page("/v1.0/me/calendarView");
  const input = { requestId, subject: "Study", startDateTime: "2026-10-17T10:00:00+08:00", endDateTime: "2026-10-17T11:00:00+08:00", body: "Plan" };
  await service.createEvent(input);
  await service.createEvent(input);
  assert.equal(creations, 1);
  await microsoft.page("/v1.0/me/calendarView");
  assert.equal(calendarReads, 2);
  await assert.rejects(service.createEvent({ ...input, subject: "Changed" }), { code: "WRITE_REQUEST_CONFLICT" });
});
