import { z } from "zod";
import { SCOPE } from "./auth.js";
import { publicError, ServiceError } from "./errors.js";

export const toolMetadata = {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _meta: { securitySchemes: [{ type: "oauth2", scopes: [SCOPE] }] },
};

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 30) throw new ServiceError("RESPONSE_TOO_COMPLEX", "The upstream response has excessive nesting.");
  if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/password|cookie|authorization|(?:access|refresh|id)[_-]?token|secret/i.test(key))
      .map(([key, item]) => [key, sanitize(item, depth + 1)]));
  }
  return value;
}

export async function result(handler: () => unknown | Promise<unknown>) {
  try {
    const value = sanitize(await handler());
    const data = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { data: value };
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text) > 1_000_000) throw new ServiceError("RESPONSE_TOO_LARGE", "Narrow the date range or reduce pageSize.");
    return { content: [{ type: "text" as const, text }], structuredContent: data };
  } catch (error) {
    const detail = error instanceof z.ZodError
      ? { code: "UNSUPPORTED_DATA_FORMAT", message: "Input or upstream data does not match the supported schema.", retryable: false }
      : publicError(error);
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(detail) }], structuredContent: { error: detail } };
  }
}
