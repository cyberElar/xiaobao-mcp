import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { z } from "zod";
import { SCOPE, WRITE_SCOPE } from "../auth.js";
import { ServiceError } from "../errors.js";
import { result, toolMetadata } from "../tool-result.js";
import { submissionPath } from "../microsoft/writes.js";
import { fileInput } from "./files.js";
import type { WriteServices } from "./services.js";

const requestId = z.uuid();
const schoolId = z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,19}$/)]).transform(String);
const graphId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const submission = { classId: graphId, assignmentId: graphId, submissionId: graphId };
const writeMetadata = {
  annotations: { ...toolMetadata.annotations, readOnlyHint: false, idempotentHint: true },
  _meta: { securitySchemes: [{ type: "oauth2", scopes: [SCOPE, WRITE_SCOPE] }] },
};
const uploadMetadata = { ...writeMetadata, _meta: { ...writeMetadata._meta, "openai/fileParams": ["file"] } };
const official = (source: string, data: unknown) => ({ source, official: true, data });

async function writeResult(auth: AuthInfo | undefined, perform: () => Promise<unknown>) {
  if (!auth?.scopes.includes(WRITE_SCOPE) || !auth.scopes.includes(SCOPE)) {
    const response = await result(() => { throw new ServiceError("INSUFFICIENT_SCOPE", "Authorize schoolis.write to use write tools. The existing read grant remains read-only."); });
    const resource = auth?.resource ? `, resource_metadata="${getOAuthProtectedResourceMetadataUrl(auth.resource)}"` : "";
    return { ...response, _meta: { "mcp/www_authenticate": [`Bearer error="insufficient_scope", scope="${SCOPE} ${WRITE_SCOPE}"${resource}`] } };
  }
  return result(perform);
}

export function registerWriteTools(server: McpServer, services?: WriteServices) {
  const service = () => {
    if (!services) throw new ServiceError("WRITES_NOT_CONFIGURED", "The server write services are not configured.");
    return services;
  };
  server.registerTool("get_write_capabilities", {
    ...toolMetadata, description: "Check MCP write authorization, school connection and Microsoft education/calendar/file write grants. Does not upload, submit or create anything. Connection does not prove a specific assignment is editable.",
    inputSchema: {},
  }, (_input, extra) => result(async () => ({
    mcpWriteAuthorized: extra.authInfo?.scopes.includes(WRITE_SCOPE) ?? false,
    requiredMcpScope: WRITE_SCOPE, ...await service().capabilities(),
  })));
  server.registerTool("upload_assignment_attachment", {
    ...uploadMetadata, description: "Upload a file for an editable Schoolis assignment. Accept exactly one ChatGPT file object, UTF-8 text or base64 file content, max 5 MB; provide a filename. Returns a signed uploadReceipt, does not submit the assignment. Reuse requestId on retries.",
    inputSchema: { learningTaskId: schoolId, requestId, ...fileInput },
  }, (input, extra) => writeResult(extra.authInfo, async () => official("schoolis", await service().school.upload(input.learningTaskId, input.requestId, input))));
  server.registerTool("submit_assignment", {
    ...writeMetadata, annotations: { ...writeMetadata.annotations, destructiveHint: true },
    description: "Submit or resubmit the authenticated student's Schoolis assignment. Omitted remark preserves the existing answer. Signed uploadReceipts add uploaded attachments. Existing attachments are retained by default; keepExistingAttachments=false replaces them. Reuse requestId for the same operation; inspect state after uncertain results.",
    inputSchema: {
      learningTaskId: schoolId, requestId, remark: z.string().max(50_000).optional(),
      uploadReceipts: z.array(z.string().min(1).max(16_384)).max(30).default([]),
      keepExistingAttachments: z.boolean().default(true),
    },
  }, (input, extra) => writeResult(extra.authInfo, async () => official("schoolis", await service().school.submit(input))));
  server.registerTool("upload_teams_attachment", {
    ...uploadMetadata, description: "Upload and attach a file to the bound student's editable Teams submission, without submitting it. Requires EduAssignments.ReadWrite and Files.ReadWrite. Stored filenames get a unique prefix to avoid overwrites; display name preserves the original filename. Reuse requestId on retries.",
    inputSchema: { ...submission, requestId, ...fileInput },
  }, (input, extra) => writeResult(extra.authInfo, async () => official("microsoft_graph",
    await service().microsoft.upload(submissionPath(input.classId, input.assignmentId, input.submissionId), input.requestId, input))));
  for (const action of ["submit", "unsubmit"] as const) {
    server.registerTool(`${action}_teams_assignment`, {
      ...writeMetadata, annotations: { ...writeMetadata.annotations, destructiveHint: true },
      description: `${action === "submit" ? "Submit" : "Withdraw"} the bound student's own Teams assignment submission. Requires EduAssignments.ReadWrite, ownership and an eligible submission status. Reuse requestId on retries; this operation changes submission status.`,
      inputSchema: { ...submission, requestId },
    }, (input, extra) => writeResult(extra.authInfo, async () => official("microsoft_graph",
      await service().microsoft.submission(action, submissionPath(input.classId, input.assignmentId, input.submissionId), input.requestId))));
  }
  server.registerTool("create_outlook_event", {
    ...writeMetadata, description: "Create an event in the bound Microsoft account's primary calendar, without attendees or invitation messages. Requires Calendars.ReadWrite. Times require explicit ISO offsets and an ordered range up to 31 days. requestId is also the Graph transactionId; reuse it on retries.",
    inputSchema: {
      requestId, subject: z.string().trim().min(1).max(250), startDateTime: z.iso.datetime({ offset: true }),
      endDateTime: z.iso.datetime({ offset: true }), body: z.string().max(20_000).default(""),
      location: z.string().max(300).optional(), reminderMinutes: z.number().int().min(0).max(10_080).optional(),
    },
  }, (input, extra) => writeResult(extra.authInfo, async () => official("microsoft_graph", await service().microsoft.createEvent(input))));
}
