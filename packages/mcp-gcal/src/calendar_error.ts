/** Stable error categories exposed to callers without upstream response bodies. */
export type GoogleCalendarErrorCode =
  | "configuration_error"
  | "request_timeout"
  | "request_failed"
  | "upstream_error"
  | "invalid_response";

/** Error containing only safe operation, status, and upstream status metadata. */
export class GoogleCalendarError extends Error {
  readonly code: GoogleCalendarErrorCode;
  readonly status: number | undefined;
  readonly code_upstream: string | undefined;
  readonly operation: string;

  constructor(
    code: GoogleCalendarErrorCode,
    operation: string,
    message: string,
    status?: number,
    code_upstream?: string,
  ) {
    super(message);
    this.name = "GoogleCalendarError";
    this.code = code;
    this.operation = operation;
    this.status = status;
    this.code_upstream = code_upstream;
  }
}
