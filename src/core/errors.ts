export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public next_action = "Retry after checking the configuration.",
    public retryable = false,
    public write_state?: string,
  ) {
    super(message);
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      next_action: this.next_action,
      retryable: this.retryable,
      ...(this.write_state ? { write_state: this.write_state } : {}),
    };
  }
}
export function safeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const e = error as {
    name?: string;
    code?: string;
    status?: number;
    authenticationFailed?: boolean;
    serverResponseCode?: string;
  };
  if (e.authenticationFailed || e.status === 401)
    return new AppError(
      "AUTH_FAILED",
      "iCloud rejected the credentials.",
      "Run apple2agent setup with a valid app-specific password.",
    );
  if (e.status === 403)
    return new AppError(
      "PERMISSION_DENIED",
      "iCloud denied this operation.",
      "Choose an allowed writable calendar or folder.",
    );
  if (e.status === 404)
    return new AppError(
      "NOT_FOUND",
      "The resource no longer exists.",
      "List or search again.",
    );
  if (e.serverResponseCode === "NONEXISTENT")
    return new AppError(
      "NOT_FOUND",
      "The mail folder no longer exists.",
      "List folders again.",
    );
  if (e.serverResponseCode === "BADCHARSET")
    return new AppError(
      "ENDPOINT_UNSUPPORTED",
      "The server does not support this search character set.",
      "Use narrower supported header/date filters.",
    );
  if (e.serverResponseCode === "NOPERM")
    return new AppError(
      "PERMISSION_DENIED",
      "The server denied mailbox access.",
      "Choose an accessible folder.",
    );
  if (
    e.name === "AbortError" ||
    e.name === "TimeoutError" ||
    e.code === "ETIMEDOUT"
  )
    return new AppError(
      "TIMEOUT",
      "The operation exceeded its deadline.",
      "Retry reads; reuse the same request_id for writes.",
      true,
    );
  return new AppError(
    "NETWORK_ERROR",
    "The upstream operation failed.",
    "Check connectivity and run apple2agent doctor. Raw protocol errors are not logged.",
    true,
  );
}
export function invalid(message: string): never {
  throw new AppError("INVALID_INPUT", message, "Correct the input and retry.");
}
