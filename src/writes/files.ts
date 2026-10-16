import { createHash } from "node:crypto";
import { z } from "zod";
import { ServiceError } from "../errors.js";

export const MAX_UPLOAD_BYTES = 5_000_000;
export const fileInput = {
  file: z.object({
    download_url: z.string().max(16_384), file_id: z.string().min(1).max(256),
    mime_type: z.string().max(128).optional(), file_name: z.string().max(180).optional(),
  }).optional(),
  filename: z.string().max(180).optional(),
  text: z.string().max(MAX_UPLOAD_BYTES).optional(),
  contentBase64: z.string().max(6_666_668).optional(),
};
export const fileSourceSchema = z.object(fileInput);
export type FileSource = z.infer<typeof fileSourceSchema>;
export interface UploadFile { name: string; mime: string; bytes: Buffer; sha256: string }

export function fileFingerprint(source: FileSource) {
  const { file, ...rest } = source;
  return { ...rest, ...(file ? { file: { file_id: file.file_id, file_name: file.file_name, mime_type: file.mime_type } } : {}) };
}

function downloadUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ServiceError("UPLOAD_URL_REJECTED", "The file download URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !["oaiusercontent.com", "usercontent.openai.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new ServiceError("UPLOAD_URL_REJECTED", "Only HTTPS ChatGPT file download addresses are supported.");
  }
  return url;
}

export async function resolveUpload(source: FileSource, fetcher: typeof fetch = fetch): Promise<UploadFile> {
  const choices = Number(source.file !== undefined) + Number(source.text !== undefined) + Number(source.contentBase64 !== undefined);
  if (choices !== 1) throw new ServiceError("INVALID_UPLOAD", "Provide exactly one of file, text or contentBase64.");
  const name = source.filename ?? source.file?.file_name;
  if (!name || name.length > 180 || name === "." || name === ".." || /[\\/:*?"<>|\x00-\x1f\x7f]/.test(name) || name.endsWith(".") || name.endsWith(" ")) {
    throw new ServiceError("INVALID_UPLOAD", "Provide a filename without path separators, control characters or reserved characters.");
  }
  const mime = source.file?.mime_type ?? (source.text !== undefined ? "text/plain" : "application/octet-stream");
  if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mime)) {
    throw new ServiceError("INVALID_UPLOAD", "The file MIME type is invalid.");
  }
  let bytes: Buffer;
  if (source.file) {
    const url = downloadUrl(source.file.download_url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetcher(url, { method: "GET", redirect: "manual", credentials: "omit", signal: controller.signal });
      reader = response.body?.getReader();
      if (response.status !== 200) throw new ServiceError("UPLOAD_DOWNLOAD_FAILED", `File download returned HTTP ${response.status}. Request a fresh ChatGPT file address.`);
      if (Number(response.headers.get("content-length")) > MAX_UPLOAD_BYTES) throw new ServiceError("UPLOAD_TOO_LARGE", "Uploads must be no larger than 5 MB.");
      if (!reader) throw new ServiceError("INVALID_UPLOAD", "The downloaded file is empty.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_UPLOAD_BYTES) throw new ServiceError("UPLOAD_TOO_LARGE", "Uploads must be no larger than 5 MB.");
        chunks.push(value);
      }
      bytes = Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError("UPLOAD_DOWNLOAD_FAILED", "The ChatGPT file could not be downloaded. Request a fresh file address.");
    } finally {
      await reader?.cancel().catch(() => {});
      clearTimeout(timeout);
    }
  } else if (source.text !== undefined) bytes = Buffer.from(source.text, "utf8");
  else {
    const encoded = source.contentBase64!;
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new ServiceError("INVALID_UPLOAD", "contentBase64 must contain standard base64 without a data URL prefix.");
    }
    bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new ServiceError("INVALID_UPLOAD", "contentBase64 contains invalid padding or non-canonical data.");
  }
  if (bytes.byteLength === 0) throw new ServiceError("INVALID_UPLOAD", "The file is empty.");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new ServiceError("UPLOAD_TOO_LARGE", "Uploads must be no larger than 5 MB.");
  return { name, mime, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
