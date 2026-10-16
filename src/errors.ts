export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function publicError(error: unknown) {
  return error instanceof ServiceError
    ? { code: error.code, message: error.message, retryable: error.retryable, ...(error.details ? { details: error.details } : {}) }
    : { code: "INTERNAL_ERROR", message: "The request could not be completed.", retryable: false };
}
