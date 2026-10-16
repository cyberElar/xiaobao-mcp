import { createHmac, timingSafeEqual } from "node:crypto";
import { extname } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { ServiceError, publicError } from "../errors.js";
import { fileFingerprint, resolveUpload, type FileSource } from "../writes/files.js";
import type { WriteJournal } from "../writes/journal.js";
import type { SchoolisClient } from "./client.js";

const attachmentSchema = z.object({
  id: z.number().int().nonnegative(), type: z.string(), size: z.number().nonnegative(),
  name: z.string(), url: z.url(), pdfUrl: z.string().nullish().transform(value => value ?? ""),
});
const detailSchema = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  learningTaskState: z.number().int(), isFirstSubmissionClosed: z.boolean().optional(),
  sourceType: z.number().optional(), remark: z.string().nullable().optional(),
  learningTaskStudentDocuments: z.array(attachmentSchema).nullable().optional(),
}).passthrough();
const receiptSchema = z.object({
  account: z.string(), learningTaskId: z.string(), expiresAt: z.number(), document: attachmentSchema,
});

export class SchoolisWrites {
  constructor(
    private readonly config: Pick<Config, "ownerKey" | "schoolUrl">,
    private readonly client: SchoolisClient, private readonly journal: WriteJournal,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async account() {
    const profile = await this.client.getProfile();
    return `schoolis:${this.config.schoolUrl.origin}:${profile.loginName}`;
  }

  private async editable(learningTaskId: string) {
    const detail = detailSchema.parse(await this.client.fresh("/api/LearningTask/GetDetail", { learningTaskId }));
    if (detail.id !== learningTaskId) throw new ServiceError("ASSIGNMENT_MISMATCH", "The school returned a different assignment.");
    if (detail.isFirstSubmissionClosed || detail.sourceType === 2 || ![2, 3].includes(detail.learningTaskState)) {
      throw new ServiceError("ASSIGNMENT_NOT_EDITABLE", "This assignment is closed, graded, external, or otherwise not editable.");
    }
    if (detail.learningTaskState === 3 && await this.client.query("/api/LearningTask/ContinueAnswerForLearningtask") !== true) {
      throw new ServiceError("ASSIGNMENT_NOT_EDITABLE", "The school does not allow resubmitting this assignment.");
    }
    return detail;
  }

  private signature(payload: string) {
    return createHmac("sha256", this.config.ownerKey).update(`school-upload-v1:${payload}`).digest("base64url");
  }

  private document(receipt: string, account: string, learningTaskId: string) {
    try {
      const [payload, signature, extra] = receipt.split(".");
      const expected = this.signature(payload ?? "");
      if (!payload || !signature || extra !== undefined || signature.length !== expected.length ||
          !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("Invalid signature.");
      const parsed = receiptSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
      if (parsed.account !== account || parsed.learningTaskId !== learningTaskId || parsed.expiresAt <= Date.now()) throw new Error("Receipt binding changed.");
      return parsed.document;
    } catch {
      throw new ServiceError("INVALID_UPLOAD_RECEIPT", "Use an unmodified upload receipt from this account and assignment within seven days.");
    }
  }

  async upload(learningTaskId: string, requestId: string, source: FileSource) {
    const account = await this.account();
    return this.journal.run(account, "schoolis.upload", requestId, `assignment:${learningTaskId}`, { learningTaskId, source: fileFingerprint(source) }, async () => {
      await this.editable(learningTaskId);
      const file = await resolveUpload(source, this.fetcher);
      const form = new FormData();
      form.append("fileBase", new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name);
      const uploaded = z.object({ url: z.url(), pdfUrl: z.string().nullish().transform(value => value ?? "") }).parse(await this.client.mutate("/api/LearningTask/UploadDocument", form));
      if (new URL(uploaded.url).protocol !== "https:") throw new ServiceError("UPSTREAM_FORMAT_ERROR", "The school returned a non-HTTPS attachment address.");
      const document = { id: 0, type: extname(file.name).toLowerCase() || ".bin", size: file.bytes.length, name: file.name, ...uploaded };
      const payload = Buffer.from(JSON.stringify({ account, learningTaskId, expiresAt: Date.now() + 7 * 86400_000, document })).toString("base64url");
      return {
        learningTaskId, name: file.name, size: file.bytes.length, sha256: file.sha256,
        uploadReceipt: `${payload}.${this.signature(payload)}`, submitted: false,
      };
    });
  }

  async submit(input: { learningTaskId: string; requestId: string; remark?: string; uploadReceipts: string[]; keepExistingAttachments: boolean }) {
    const account = await this.account();
    return this.journal.run(account, "schoolis.submit", input.requestId, `assignment:${input.learningTaskId}`, input, async () => {
      const detail = await this.editable(input.learningTaskId);
      const added = input.uploadReceipts.map(receipt => this.document(receipt, account, input.learningTaskId));
      if (new Set(input.uploadReceipts).size !== input.uploadReceipts.length) {
        throw new ServiceError("INVALID_UPLOAD_RECEIPT", "Do not include the same upload receipt more than once.");
      }
      const documents = [...(input.keepExistingAttachments ? detail.learningTaskStudentDocuments ?? [] : []), ...added];
      if (documents.length > 30) throw new ServiceError("INVALID_SUBMISSION", "Use no more than 30 attachments.");
      const remark = input.remark ?? detail.remark ?? "";
      if (!remark.trim() && !documents.length) throw new ServiceError("INVALID_SUBMISSION", "Provide an answer or at least one attachment.");
      await this.client.mutate("/api/LearningTask/Save", { learningTaskId: input.learningTaskId, remark, learningTaskStudentDocuments: documents });
      let verification: Record<string, unknown>;
      try {
        const after = detailSchema.parse(await this.client.fresh("/api/LearningTask/GetDetail", { learningTaskId: input.learningTaskId }));
        verification = { checked: true, state: after.learningTaskState, answerMatches: (after.remark ?? "") === remark, attachmentCount: after.learningTaskStudentDocuments?.length ?? 0 };
      } catch (error) {
        verification = { checked: false, error: publicError(error).code };
      }
      return { learningTaskId: input.learningTaskId, accepted: true, attachmentCount: documents.length, verification };
    });
  }
}
