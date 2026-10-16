import { ServiceError } from "../errors.js";

export async function microsoftJson(url: URL, init: RequestInit, timeoutMs: number, fetcher: typeof fetch) {
  if (url.protocol !== "https:" || !["graph.microsoft.com", "login.microsoftonline.com"].includes(url.hostname) ||
      url.username || url.password || url.port || url.hash) {
    throw new ServiceError("MICROSOFT_INVALID_ENDPOINT", "Unsupported Microsoft endpoint.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(url, { ...init, redirect: "manual", signal: controller.signal });
    reader = response.body?.getReader();
    if (response.status >= 300 && response.status < 400) {
      throw new ServiceError("MICROSOFT_REDIRECT_REJECTED", "Microsoft returned an unexpected redirect.");
    }
    if (response.status === 204) return { status: response.status, data: null };
    if (!response.headers.get("content-type")?.includes("json") || !reader) {
      throw new ServiceError("MICROSOFT_FORMAT_ERROR", "Microsoft returned a non-JSON or empty response.");
    }
    if (Number(response.headers.get("content-length")) > 5_000_000) {
      throw new ServiceError("RESPONSE_TOO_LARGE", "Reduce the Microsoft query range or pageSize.");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 5_000_000) throw new ServiceError("RESPONSE_TOO_LARGE", "Reduce the Microsoft query range or pageSize.");
      chunks.push(value);
    }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
      throw new ServiceError("MICROSOFT_FORMAT_ERROR", "Microsoft returned invalid JSON.");
    }
    return { status: response.status, data };
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    if (controller.signal.aborted) throw new ServiceError("MICROSOFT_TIMEOUT", "Microsoft request timed out.", true);
    throw new ServiceError("MICROSOFT_UNAVAILABLE", "Microsoft request failed.", true);
  } finally {
    await reader?.cancel().catch(() => {});
    clearTimeout(timeout);
  }
}

export interface GraphRequest { method: "GET" | "POST" | "PUT"; body?: BodyInit; contentType?: string }

export async function graphJson(url: URL, token: string, timeoutMs: number, fetcher: typeof fetch, request: GraphRequest = { method: "GET" }) {
  if (url.origin !== "https://graph.microsoft.com") throw new ServiceError("MICROSOFT_INVALID_ENDPOINT", "Unsupported Graph origin.");
  const response = await microsoftJson(url, {
    method: request.method, credentials: "omit", body: request.body,
    headers: {
      Accept: "application/json", Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"',
      ...(request.contentType ? { "Content-Type": request.contentType } : {}),
    },
  }, timeoutMs, fetcher);
  if (response.status === 401) throw new ServiceError("MICROSOFT_UNAUTHORIZED", "Microsoft rejected the access token.");
  if (response.status === 403) throw new ServiceError("MICROSOFT_FORBIDDEN", "Microsoft denied this operation. Check granted permissions and school policy.");
  if (response.status < 200 || response.status >= 300) {
    throw new ServiceError("MICROSOFT_HTTP_ERROR", `Microsoft returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500);
  }
  return response.data;
}
