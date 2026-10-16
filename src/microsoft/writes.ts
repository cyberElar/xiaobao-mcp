import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ServiceError, publicError } from "../errors.js";
import { fileFingerprint, resolveUpload, type FileSource } from "../writes/files.js";
import type { WriteJournal } from "../writes/journal.js";
import type { MicrosoftClient } from "./client.js";

const editable = new Set(["working", "returned", "reassigned"]);
export const submissionPath = (classId: string, assignmentId: string, submissionId: string) =>
  `/v1.0/education/classes/${classId}/assignments/${assignmentId}/submissions/${submissionId}`;
const resourceFolder = (value: string) => {
  const url = new URL(value);
  const match = /^\/v1\.0\/drives\/([A-Za-z0-9_!.-]{1,512})\/items\/([A-Za-z0-9_-]{1,256})$/.exec(url.pathname);
  if (url.origin !== "https://graph.microsoft.com" || url.username || url.password || url.search || url.hash || !match) {
    throw new ServiceError("MICROSOFT_INVALID_ENDPOINT", "The submission resource folder is not a supported Graph drive folder.");
  }
  return { path: url.pathname, driveId: match[1]! };
};

export class MicrosoftWrites {
  constructor(private readonly client: MicrosoftClient, private readonly journal: WriteJournal, private readonly fetcher: typeof fetch = fetch) {}

  async submission(action: "submit" | "unsubmit", path: string, requestId: string) {
    await this.client.requireWritePermission("education");
    const account = await this.client.accountKey();
    return this.journal.run(account, `teams.${action}`, requestId, path, { path }, async () => {
      const current = await this.client.ownSubmission(path);
      if (action === "submit" && current.status === "submitted") return { accepted: true, alreadyApplied: true, status: current.status };
      if (action === "unsubmit" && current.status === "working") return { accepted: true, alreadyApplied: true, status: current.status };
      if (action === "submit" ? !editable.has(current.status) : current.status !== "submitted") {
        throw new ServiceError("SUBMISSION_NOT_EDITABLE", `The ${current.status} submission does not permit ${action}.`);
      }
      const data = await this.client.mutate(`${path}/${action}`, {});
      const status = z.object({ status: z.string() }).safeParse(data).data?.status;
      return { accepted: true, alreadyApplied: false, ...(status ? { status } : {}) };
    });
  }

  async upload(path: string, requestId: string, source: FileSource) {
    await this.client.requireWritePermission("education");
    await this.client.requireWritePermission("file");
    const account = await this.client.accountKey();
    return this.journal.run(account, "teams.upload", requestId, path, { path, source: fileFingerprint(source) }, async () => {
      const current = await this.client.ownSubmission(path);
      if (!editable.has(current.status)) throw new ServiceError("SUBMISSION_NOT_EDITABLE", "Unsubmit this assignment before uploading a new attachment.");
      const assignment = z.record(z.string(), z.unknown()).parse(await this.client.fresh(path.slice(0, path.lastIndexOf("/submissions/"))));
      if (assignment.allowStudentsToAddResources === false) throw new ServiceError("SUBMISSION_NOT_EDITABLE", "The teacher disabled additional student resources.");
      const file = await resolveUpload(source, this.fetcher);
      let stage = "preflight";
      let uploadedFile: Record<string, unknown> | undefined;
      try {
        let folderUrl = current.resourcesFolderUrl;
        if (!folderUrl) {
          const created = z.object({ resourcesFolderUrl: z.string() }).parse(await this.client.mutate(`${path}/setUpResourcesFolder`, {}));
          folderUrl = created.resourcesFolderUrl;
        }
        stage = "resourcesFolderReady";
        const folder = resourceFolder(folderUrl);
        const storedName = `mcp-${randomUUID()}-${file.name}`;
        const uploaded = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), name: z.string() }).parse(
          await this.client.mutate(`${folder.path}:/${encodeURIComponent(storedName)}:/content`, file.bytes, "PUT", file.mime),
        );
        uploadedFile = { driveId: folder.driveId, itemId: uploaded.id, storedName: uploaded.name };
        stage = "fileUploaded";
        const fileUrl = `https://graph.microsoft.com/v1.0/drives/${folder.driveId}/items/${uploaded.id}`;
        const attached = z.object({ id: z.string() }).parse(await this.client.mutate(`${path}/resources`, {
          resource: { "@odata.type": "#microsoft.graph.educationFileResource", displayName: file.name, fileUrl },
        }));
        return { resourceId: attached.id, name: file.name, size: file.bytes.length, sha256: file.sha256, submitted: false, uploadedFile };
      } catch (error) {
        if (stage === "preflight") throw error;
        throw new ServiceError("WRITE_PARTIAL_FAILURE", "The attachment upload may have partially completed. Inspect submission resources before retrying.", false, {
          stage, cause: publicError(error).code, ...(uploadedFile ? { uploadedFile } : {}),
        });
      }
    });
  }

  async createEvent(input: { requestId: string; subject: string; startDateTime: string; endDateTime: string; body: string; location?: string; reminderMinutes?: number }) {
    const start = Date.parse(input.startDateTime);
    const end = Date.parse(input.endDateTime);
    if (end <= start || end - start > 31 * 86400_000) throw new ServiceError("INVALID_DATE_RANGE", "Use an ordered event time range no longer than 31 days.");
    await this.client.requireWritePermission("calendar");
    const account = await this.client.accountKey();
    return this.journal.run(account, "outlook.create", input.requestId, "calendar", input, async () => {
      const event = z.object({ id: z.string(), subject: z.string(), start: z.unknown(), end: z.unknown(), webLink: z.string().optional() }).parse(
        await this.client.mutate("/v1.0/me/events", {
          subject: input.subject, body: { contentType: "text", content: input.body },
          start: { dateTime: new Date(start).toISOString().replace(/Z$/, ""), timeZone: "UTC" },
          end: { dateTime: new Date(end).toISOString().replace(/Z$/, ""), timeZone: "UTC" },
          ...(input.location ? { location: { displayName: input.location } } : {}),
          ...(input.reminderMinutes === undefined ? {} : { isReminderOn: true, reminderMinutesBeforeStart: input.reminderMinutes }),
          transactionId: input.requestId,
        }),
      );
      return { created: true, event };
    });
  }
}
