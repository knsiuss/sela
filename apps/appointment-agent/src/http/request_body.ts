import type { IncomingMessage } from "node:http";

/** Signals a streamed request body exceeded the ingress limit. */
export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("webhook-body-too-large");
    this.name = "RequestBodyTooLargeError";
  }
}

/** Signals that the HTTP request stream failed before a complete body arrived. */
export class RequestReadError extends Error {
  constructor() {
    super("webhook-body-read-failed");
    this.name = "RequestReadError";
  }
}

/** Return a scalar header value and reject repeated header values. */
export function get_single_header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** Reject a declared body length before allocating or buffering payload bytes. */
export function assert_content_length_allowed(
  request: IncomingMessage,
  max_bytes: number,
): void {
  const content_length = get_single_header(request, "content-length");
  if (content_length === undefined || !/^\d+$/.test(content_length)) return;
  if (Number(content_length) <= max_bytes) return;
  request.resume();
  throw new RequestBodyTooLargeError();
}

/** Read exact request bytes while stopping once the configured limit is exceeded. */
export function read_raw_body(request: IncomingMessage, max_bytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byte_count = 0;
    let is_settled = false;
    const fail = (error: Error): void => {
      if (is_settled) return;
      is_settled = true;
      reject(error);
    };
    request.on("data", (chunk: Buffer | string) => {
      if (is_settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byte_count += buffer.length;
      if (byte_count > max_bytes) {
        request.resume();
        fail(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", () => {
      if (is_settled) return;
      is_settled = true;
      resolve(Buffer.concat(chunks, byte_count));
    });
    request.once("error", () => fail(new RequestReadError()));
    request.once("aborted", () => fail(new RequestReadError()));
  });
}
