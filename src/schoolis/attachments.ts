import { Worker } from "node:worker_threads";
import { z } from "zod";
import { ServiceError } from "../errors.js";
import type { SchoolisClient } from "./client.js";

const MAX_BYTES = 5_000_000;
const SOURCE_FIELDS = {
  assignment: "learningTaskDocuments",
  submission: "learningTaskStudentDocuments",
  feedback: "teacherCommentDocuments",
} as const;
const documentSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d{0,19}$/)]).transform(String),
  name: z.string(), url: z.string(),
  type: z.string().optional(), size: z.number().nonnegative().optional(),
});
type Source = keyof typeof SOURCE_FIELDS;
export interface ReadOptions {
  learningTaskId: string;
  documentId: string;
  source: Source;
  startPage: number;
  maxPages: number;
  maxChars: number;
  textOffset: number;
}
interface PdfText {
  format: "pdf";
  pages: { page: number; text: string }[];
  totalPages: number;
  nextPage: number | null;
  nextOffset: number;
  truncated: boolean;
  ocrPerformed: false;
}
interface PlainText {
  format: "text";
  text: string;
  nextOffset: number | null;
  truncated: boolean;
}
let activeReads = 0;

function attachmentUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new ServiceError("ATTACHMENT_URL_REJECTED", "School returned an invalid attachment URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "cdn.schoolis.cn" ||
      url.username || url.password || (url.port && url.port !== "443")) {
    throw new ServiceError("ATTACHMENT_URL_REJECTED", "The attachment URL is outside the supported school CDN.");
  }
  return url;
}

export async function assignmentAttachments(client: SchoolisClient, learningTaskId: string) {
  const detail = z.record(z.string(), z.unknown()).parse(await client.query("/api/LearningTask/GetDetail", { learningTaskId }));
  return Object.entries(SOURCE_FIELDS).flatMap(([source, field]) => {
    const documents = z.array(documentSchema).parse(detail[field] ?? []);
    return documents.map(document => ({ ...document, source: source as Source }));
  });
}

async function download(url: URL, fetcher: typeof fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    // Never send the school cookie jar or follow a CDN redirect.
    const response = await fetcher(url, {
      headers: { Accept: "application/pdf, text/plain", "User-Agent": "XiaobaoMCPtool/0.1" },
      redirect: "manual", signal: controller.signal, credentials: "omit",
    });
    reader = response.body?.getReader();
    if (response.status >= 300 && response.status < 400) {
      throw new ServiceError("ATTACHMENT_REDIRECT_REJECTED", "The attachment CDN returned a redirect.");
    }
    if (response.status !== 200) {
      throw new ServiceError("ATTACHMENT_HTTP_ERROR", `Attachment download returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500);
    }
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!["application/pdf", "text/plain", "application/octet-stream"].includes(type)) {
      throw new ServiceError("UNSUPPORTED_ATTACHMENT_TYPE", "Only PDF and plain text attachments can be read.");
    }
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
      throw new ServiceError("ATTACHMENT_TOO_LARGE", "Attachments must be no larger than 5 MB.");
    }
    if (!reader) throw new ServiceError("ATTACHMENT_EMPTY", "The attachment has no content.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new ServiceError("ATTACHMENT_TOO_LARGE", "Attachments must be no larger than 5 MB.");
      chunks.push(value);
    }
    return { bytes: Buffer.concat(chunks), type };
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    if (controller.signal.aborted) throw new ServiceError("ATTACHMENT_TIMEOUT", "Attachment download timed out.", true);
    throw new ServiceError("ATTACHMENT_UNAVAILABLE", "Attachment download failed.", true);
  } finally {
    await reader?.cancel().catch(() => {});
    clearTimeout(timeout);
  }
}

async function pdfText(bytes: Uint8Array, options: ReadOptions): Promise<PdfText> {
  const workerFile = import.meta.url.endsWith(".ts") ? "./pdf-worker.ts" : "./pdf-worker.js";
  const worker = new Worker(new URL(workerFile, import.meta.url), {
    workerData: { bytes: new Uint8Array(bytes), ...options },
    execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 96 },
    stdout: true, stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new ServiceError("ATTACHMENT_TIMEOUT", "PDF extraction timed out.", true)), 10_000);
      worker.once("message", (data: PdfText | { error: string }) => {
        if ("error" in data) {
          reject(new ServiceError(data.error, data.error === "PDF_EXTRACTION_FAILED"
            ? "The PDF cannot be read. It may be encrypted, damaged, or exceed parser limits."
            : "The requested page or text offset is outside the attachment."));
        } else resolve(data);
      });
      worker.once("error", () => reject(new ServiceError("PDF_EXTRACTION_FAILED", "The PDF exceeded parser limits or could not be read.")));
      worker.once("exit", () => reject(new ServiceError("PDF_EXTRACTION_FAILED", "The PDF parser exited before returning text.")));
    });
  } finally {
    clearTimeout(timeout);
    await worker.terminate();
  }
}

export async function readAssignmentAttachment(client: SchoolisClient, options: ReadOptions, fetcher: typeof fetch = fetch) {
  if (activeReads >= 2) throw new ServiceError("ATTACHMENT_BUSY", "Two attachment reads are already in progress. Retry shortly.", true);
  activeReads++;
  try {
    const documents = await assignmentAttachments(client, options.learningTaskId);
    const document = documents.find(item => item.id === options.documentId && item.source === options.source);
    if (!document) throw new ServiceError("ATTACHMENT_NOT_FOUND", "This attachment is not listed in the requested assignment and source.");
    const url = attachmentUrl(document.url);
    if (document.size !== undefined && document.size > MAX_BYTES) {
      throw new ServiceError("ATTACHMENT_TOO_LARGE", "Attachments must be no larger than 5 MB.");
    }
    const { bytes, type } = await download(url, fetcher);
    let content: PdfText | PlainText;
    if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
      content = await pdfText(bytes, options);
    } else {
      if (type !== "text/plain" || !/\.txt$/i.test(document.name)) {
        throw new ServiceError("UNSUPPORTED_ATTACHMENT_TYPE", "The attachment is not a PDF or plain text document.");
      }
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
        throw new ServiceError("UNSUPPORTED_TEXT_ENCODING", "Plain text attachments must use UTF-8.");
      }
      if (text.includes("\0")) throw new ServiceError("UNSUPPORTED_ATTACHMENT_TYPE", "The attachment contains binary data.");
      if (options.startPage !== 1 || options.textOffset > text.length) {
        throw new ServiceError("INVALID_OFFSET", "The requested page or text offset is outside the attachment.");
      }
      const part = text.slice(options.textOffset, options.textOffset + options.maxChars);
      const nextOffset = options.textOffset + part.length;
      content = { format: "text", text: part, nextOffset: nextOffset < text.length ? nextOffset : null, truncated: nextOffset < text.length };
    }
    return {
      document: { id: document.id, name: document.name, source: document.source, size: bytes.length },
      ...content, untrustedContent: true,
    };
  } finally {
    activeReads--;
  }
}
