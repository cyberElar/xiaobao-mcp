import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { SchoolisClient } from "../src/schoolis/client.js";
import { assignmentAttachments, readAssignmentAttachment, type ReadOptions } from "../src/schoolis/attachments.js";
import { fixture } from "./helpers.js";

const defaults: ReadOptions = {
  learningTaskId: "7", documentId: "8", source: "assignment",
  startPage: 1, maxPages: 5, maxChars: 30_000, textOffset: 0,
};
const attachment = { id: 8, name: "attachment.pdf", type: "pdf", url: "https://cdn.schoolis.cn/assignment.pdf?signature=private" };
const pdf = readFileSync(new URL("./fixtures/attachment.pdf", import.meta.url));

function school(t: TestContext, document = attachment, source = "learningTaskDocuments") {
  const { config } = fixture(t);
  return new SchoolisClient(config, async input => Response.json({
    state: 0, data: String(input).includes("GetCurrentStudentInfo") ? { loginName: "student" } : { [source]: [document] },
  }));
}

test("PDF attachments are resolved from assignment metadata, parsed by page and resumed without forwarding credentials", async t => {
  const client = school(t);
  const documents = await assignmentAttachments(client, "7");
  assert.equal(documents[0]!.id, "8");
  assert.equal(documents[0]!.source, "assignment");
  const download: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).hostname, "cdn.schoolis.cn");
    const headers = new Headers(init?.headers);
    assert.equal(headers.has("Cookie"), false);
    assert.equal(headers.has("Authorization"), false);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    return new Response(pdf, { headers: { "Content-Type": "application/pdf" } });
  };
  const first = await readAssignmentAttachment(client, { ...defaults, maxPages: 1 }, download);
  assert.ok(first.format === "pdf");
  assert.equal(first.totalPages, 2);
  assert.equal(first.nextPage, 2);
  assert.equal(first.truncated, true);
  assert.match((first.pages as { text: string }[])[0]!.text, /School attachment first page/);
  assert.equal(JSON.stringify(first).includes("signature"), false);
  const last = await readAssignmentAttachment(client, { ...defaults, startPage: 2 }, download);
  assert.ok(last.format === "pdf");
  assert.equal(last.nextPage, null);
  assert.equal(last.ocrPerformed, false);
  assert.match((last.pages as { text: string }[])[0]!.text, /School attachment second page/);
  const clipped = await readAssignmentAttachment(client, { ...defaults, maxChars: 6 }, download);
  assert.ok(clipped.format === "pdf");
  assert.equal(clipped.nextPage, 1);
  assert.equal(clipped.nextOffset, 6);
  const resumed = await readAssignmentAttachment(client, { ...defaults, maxPages: 1, textOffset: 6 }, download);
  assert.ok(resumed.format === "pdf");
  assert.match((resumed.pages as { text: string }[])[0]!.text, /attachment first page/);
  await assert.rejects(readAssignmentAttachment(client, { ...defaults, startPage: 3 }, download), { code: "INVALID_PAGE" });
  await assert.rejects(readAssignmentAttachment(client, { ...defaults, textOffset: 1000 }, download), { code: "INVALID_OFFSET" });
});

test("attachment resolution rejects missing IDs, wrong sources and external URLs before any download", async t => {
  let downloads = 0;
  const download: typeof fetch = async () => { downloads++; return new Response(""); };
  await assert.rejects(readAssignmentAttachment(school(t), { ...defaults, documentId: "9" }, download), { code: "ATTACHMENT_NOT_FOUND" });
  const submission = school(t, attachment, "learningTaskStudentDocuments");
  assert.equal((await assignmentAttachments(submission, "7"))[0]!.source, "submission");
  await assert.rejects(readAssignmentAttachment(submission, defaults, download), { code: "ATTACHMENT_NOT_FOUND" });
  const credentialUrl = new URL(attachment.url);
  credentialUrl.username = "example";
  for (const url of [
    "http://cdn.schoolis.cn/file.pdf", "https://cdn.schoolis.cn.evil.example/file.pdf",
    "https://127.0.0.1/file.pdf", credentialUrl.href,
    "https://cdn.schoolis.cn:444/file.pdf",
  ]) {
    await assert.rejects(readAssignmentAttachment(school(t, { ...attachment, url }), defaults, download), { code: "ATTACHMENT_URL_REJECTED" });
  }
  assert.equal(downloads, 0);
});

test("attachment download rejects redirects, oversized bodies, non-documents and corrupt PDFs", async t => {
  const client = school(t);
  const cases: [() => Response, string][] = [
    [() => new Response("", { status: 302, headers: { Location: "https://127.0.0.1/" } }), "ATTACHMENT_REDIRECT_REJECTED"],
    [() => new Response("", { status: 403 }), "ATTACHMENT_HTTP_ERROR"],
    [() => new Response("{}", { headers: { "Content-Type": "application/json" } }), "UNSUPPORTED_ATTACHMENT_TYPE"],
    [() => new Response("<html>Login</html>", { headers: { "Content-Type": "application/pdf" } }), "UNSUPPORTED_ATTACHMENT_TYPE"],
    [() => new Response("", { headers: { "Content-Type": "application/pdf", "Content-Length": "5000001" } }), "ATTACHMENT_TOO_LARGE"],
    [() => new Response(new Uint8Array(5_000_001), { headers: { "Content-Type": "application/pdf" } }), "ATTACHMENT_TOO_LARGE"],
    [() => new Response("%PDF-broken", { headers: { "Content-Type": "application/pdf" } }), "PDF_EXTRACTION_FAILED"],
    [() => new Response(pdf, { status: 206, headers: { "Content-Type": "application/pdf" } }), "ATTACHMENT_HTTP_ERROR"],
  ];
  for (const [response, code] of cases) {
    await assert.rejects(readAssignmentAttachment(client, defaults, async () => response()), { code });
  }
});

test("plain text attachments support offsets and reject binary content and invalid encodings", async t => {
  const client = school(t, { ...attachment, name: "notes.txt", type: "txt" });
  const download: typeof fetch = async () => new Response("Hello school", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const first = await readAssignmentAttachment(client, { ...defaults, maxChars: 6 }, download);
  assert.ok(first.format === "text");
  assert.equal(first.text, "Hello ");
  assert.equal(first.nextOffset, 6);
  const last = await readAssignmentAttachment(client, { ...defaults, textOffset: 6 }, download);
  assert.ok(last.format === "text");
  assert.equal(last.text, "school");
  assert.equal(last.truncated, false);
  await assert.rejects(readAssignmentAttachment(client, { ...defaults, textOffset: 100 }, download), { code: "INVALID_OFFSET" });
  await assert.rejects(readAssignmentAttachment(client, defaults, async () => new Response("x\0x")), { code: "UNSUPPORTED_ATTACHMENT_TYPE" });
  await assert.rejects(readAssignmentAttachment(client, defaults, async () => new Response(new Uint8Array([255]), { headers: { "Content-Type": "text/plain" } })), { code: "UNSUPPORTED_TEXT_ENCODING" });
});
