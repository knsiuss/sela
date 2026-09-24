import { GoogleCalendarError } from "./calendar_error.js";
import type {
  CalendarFetch,
  DeleteEventInput,
  FreebusyQueryInput,
  GoogleCalendarClientOptions,
  GoogleCalendarEvent,
  GoogleEventList,
  GoogleFreebusyResponse,
  GoogleWatchChannel,
  InsertEventInput,
  ListEventsInput,
  PatchEventInput,
  WatchEventsInput,
} from "./calendar_types.js";

export * from "./calendar_types.js";
export { GoogleCalendarError } from "./calendar_error.js";

const CALENDAR_API_BASE_URL = "https://www.googleapis.com/calendar/v3";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_FREE_BUSY_CALENDARS = 50;
const EVENT_ID_MIN_LENGTH = 5;
const EVENT_ID_MAX_LENGTH = 1024;
const WATCH_ID_MAX_LENGTH = 64;
const WATCH_TOKEN_MAX_LENGTH = 256;

/**
 * Thin Google Calendar v3 REST client.
 *
 * The client deliberately uses native fetch and an injected OAuth token
 * provider. It never logs authorization headers or upstream response bodies and
 * never retries a request automatically.
 */
export class GoogleCalendarClient {
  readonly calendar_id: string;
  private readonly get_access_token: () => Promise<string>;
  private readonly fetch_implementation: CalendarFetch;
  private readonly request_timeout_ms: number;
  private readonly quota_user: string | undefined;

  constructor(options: GoogleCalendarClientOptions) {
    this.calendar_id = require_text(options.calendar_id, "calendar_id");
    if (options.oauth_client === undefined) {
      throw new GoogleCalendarError("configuration_error", "construction", "OAuth client is required");
    }
    this.get_access_token = options.oauth_client.get_access_token.bind(options.oauth_client);
    this.fetch_implementation = options.fetch ?? globalThis.fetch;
    this.request_timeout_ms = positive_integer(
      options.request_timeout_ms,
      "request_timeout_ms",
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.quota_user = optional_text(options.quota_user, "quota_user");
  }

  /**
   * Query busy intervals for a half-open RFC3339 window.
   *
   * The returned busy blocks are Google-owned calendar facts; this method does
   * not infer service-duration slots.
   */
  async freebusy_query(input: FreebusyQueryInput): Promise<GoogleFreebusyResponse> {
    const operation = "freebusy_query";
    const time_min = require_timestamp(input.time_min, "time_min");
    const time_max = require_timestamp(input.time_max, "time_max");
    if (time_max <= time_min) {
      throw new GoogleCalendarError("configuration_error", operation, "time_max must be after time_min");
    }
    const calendar_ids = input.calendar_ids ?? [this.calendar_id];
    if (calendar_ids.length === 0 || calendar_ids.length > MAX_FREE_BUSY_CALENDARS) {
      throw new GoogleCalendarError(
        "configuration_error",
        operation,
        `calendar_ids must contain 1 to ${MAX_FREE_BUSY_CALENDARS} values`,
      );
    }
    const body = {
      timeMin: input.time_min,
      timeMax: input.time_max,
      ...(input.time_zone === undefined ? {} : { timeZone: input.time_zone }),
      ...(input.group_expansion_max === undefined ? {} : { groupExpansionMax: input.group_expansion_max }),
      ...(input.calendar_expansion_max === undefined ? {} : { calendarExpansionMax: input.calendar_expansion_max }),
      items: calendar_ids.map((calendar_id) => ({ id: require_text(calendar_id, "calendar_id") })),
    };
    const query = this.query_string(new URLSearchParams());
    const response = await this.request_json<unknown>(operation, `${CALENDAR_API_BASE_URL}/freeBusy${query}`, {
      method: "POST",
      headers: json_headers(),
      body: JSON.stringify(body),
    });
    if (!is_freebusy_response(response)) {
      throw new GoogleCalendarError("invalid_response", operation, "Google freebusy response was invalid");
    }
    return response;
  }

  /**
   * List events, following Google `nextPageToken` until the result is complete.
   *
   * Set `paginate: false` when a caller intentionally wants one raw page and
   * its `next_page_token` for external cursor handling.
   */
  async list_events(input: ListEventsInput = {}): Promise<GoogleEventList> {
    const operation = "list_events";
    const items: GoogleCalendarEvent[] = [];
    let page_token = optional_text(input.page_token, "page_token");
    let next_page_token: string | undefined;
    const seen_page_tokens = new Set<string>();
    do {
      if (page_token !== undefined) {
        if (seen_page_tokens.has(page_token)) {
          throw new GoogleCalendarError("invalid_response", operation, "Google event pagination repeated a page token");
        }
        seen_page_tokens.add(page_token);
      }
      const page = await this.request_event_page(operation, input, page_token);
      items.push(...page.items);
      next_page_token = page.next_page_token;
      page_token = input.paginate === false ? undefined : page.next_page_token;
    } while (input.paginate !== false && page_token !== undefined);
    return next_page_token === undefined ? { items } : { items, next_page_token };
  }

  /** Create one event using Calendar API insert semantics. */
  async insert_event(input: InsertEventInput): Promise<GoogleCalendarEvent> {
    const operation = "insert_event";
    if (!is_record(input.event)) {
      throw new GoogleCalendarError("configuration_error", operation, "event must be an object");
    }
    const query = this.query_string(insert_query(input));
    const response = await this.request_json<unknown>(operation, `${this.calendar_path()}/events${query}`, {
      method: "POST",
      headers: json_headers(),
      body: JSON.stringify(input.event),
    });
    if (!is_record(response)) {
      throw new GoogleCalendarError("invalid_response", operation, "Google event response was invalid");
    }
    return response as GoogleCalendarEvent;
  }

  /** Apply a partial event update using Calendar API patch semantics. */
  async patch_event(input: PatchEventInput): Promise<GoogleCalendarEvent> {
    const operation = "patch_event";
    const event_id = require_event_id(input.event_id);
    if (!is_record(input.event)) {
      throw new GoogleCalendarError("configuration_error", operation, "event must be an object");
    }
    const query = this.query_string(patch_query(input));
    const response = await this.request_json<unknown>(
      operation,
      `${this.calendar_path()}/events/${encodeURIComponent(event_id)}${query}`,
      { method: "PATCH", headers: json_headers(), body: JSON.stringify(input.event) },
    );
    if (!is_record(response)) {
      throw new GoogleCalendarError("invalid_response", operation, "Google event response was invalid");
    }
    return response as GoogleCalendarEvent;
  }

  /** Delete one event; a successful empty response is treated as success. */
  async delete_event(input: DeleteEventInput): Promise<void> {
    const operation = "delete_event";
    const event_id = require_event_id(input.event_id);
    await this.request_empty(
      operation,
      `${this.calendar_path()}/events/${encodeURIComponent(event_id)}${this.query_string(delete_query(input))}`,
      { method: "DELETE" },
    );
  }

  /** Register an HTTPS event push channel and return its opaque channel data. */
  async watch_events(input: WatchEventsInput): Promise<GoogleWatchChannel> {
    const operation = "watch_events";
    const channel_id = require_text(input.channel_id, "channel_id");
    if (channel_id.length > WATCH_ID_MAX_LENGTH) {
      throw new GoogleCalendarError("configuration_error", operation, "channel_id is too long");
    }
    const address = require_https_url(input.address, "address");
    const token = optional_text(input.token, "token");
    if (token !== undefined && token.length > WATCH_TOKEN_MAX_LENGTH) {
      throw new GoogleCalendarError("configuration_error", operation, "token is too long");
    }
    if (input.expiration !== undefined && !Number.isSafeInteger(input.expiration)) {
      throw new GoogleCalendarError("configuration_error", operation, "expiration must be an integer");
    }
    const body = {
      id: channel_id,
      type: "web_hook",
      address,
      ...(token === undefined ? {} : { token }),
      ...(input.expiration === undefined ? {} : { expiration: input.expiration }),
    };
    const response = await this.request_json<unknown>(operation, `${this.calendar_path()}/events/watch`, {
      method: "POST",
      headers: json_headers(),
      body: JSON.stringify(body),
    });
    if (!is_record(response)) {
      throw new GoogleCalendarError("invalid_response", operation, "Google watch response was invalid");
    }
    return response as GoogleWatchChannel;
  }

  private async request_event_page(
    operation: string,
    input: ListEventsInput,
    page_token: string | undefined,
  ): Promise<GoogleEventList> {
    const query = list_query(input, page_token);
    const payload = await this.request_json<Record<string, unknown>>(
      operation,
      `${this.calendar_path()}/events${this.query_string(query)}`,
      { method: "GET", headers: json_headers() },
    );
    if (!Array.isArray(payload.items)) {
      throw new GoogleCalendarError("invalid_response", operation, "Google event list was invalid");
    }
    const items = payload.items.filter(is_record) as GoogleCalendarEvent[];
    if (items.length !== payload.items.length) {
      throw new GoogleCalendarError("invalid_response", operation, "Google event list was invalid");
    }
    const next_page_token = normalize_page_token(payload.nextPageToken);
    return next_page_token === undefined ? { items } : { items, next_page_token };
  }

  private async request_json<T>(operation: string, url: string, init: RequestInit): Promise<T> {
    const response = await this.request_response(operation, url, init);
    try {
      return (await response.json()) as T;
    } catch {
      throw new GoogleCalendarError("invalid_response", operation, "Google Calendar response was not JSON");
    }
  }

  private async request_empty(operation: string, url: string, init: RequestInit): Promise<void> {
    const response = await this.request_response(operation, url, init);
    if (response.status === 204) return;
    try {
      const body = await response.text();
      if (body.trim() === "") return;
    } catch {
      throw new GoogleCalendarError("invalid_response", operation, "Google Calendar response was unreadable");
    }
  }

  private async request_response(operation: string, url: string, init: RequestInit): Promise<Response> {
    let access_token: string;
    try {
      access_token = await this.get_access_token();
    } catch {
      throw new GoogleCalendarError("configuration_error", operation, "OAuth token provider failed");
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${access_token}`);
    let response: Response;
    try {
      response = await this.fetch_implementation(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.request_timeout_ms),
      });
    } catch (error) {
      if (is_timeout_error(error)) {
        throw new GoogleCalendarError("request_timeout", operation, "Google Calendar request timed out");
      }
      throw new GoogleCalendarError("request_failed", operation, "Google Calendar request failed before a response was received");
    }
    if (!response.ok) {
      const code_upstream = await read_upstream_code(response);
      throw new GoogleCalendarError(
        "upstream_error",
        operation,
        `Google Calendar request failed with status ${response.status}`,
        response.status,
        code_upstream,
      );
    }
    return response;
  }

  private calendar_path(): string {
    return `${CALENDAR_API_BASE_URL}/calendars/${encodeURIComponent(this.calendar_id)}`;
  }

  private query_string(values: URLSearchParams): string {
    if (this.quota_user !== undefined) values.set("quotaUser", this.quota_user);
    const query = values.toString();
    return query === "" ? "" : `?${query}`;
  }
}

function list_query(input: ListEventsInput, page_token: string | undefined): URLSearchParams {
  const query = new URLSearchParams();
  set_optional(query, "timeMin", input.time_min);
  set_optional(query, "timeMax", input.time_max);
  set_optional(query, "timeZone", input.time_zone);
  if (input.max_results !== undefined) {
    if (!Number.isSafeInteger(input.max_results) || input.max_results <= 0 || input.max_results > 2500) {
      throw new GoogleCalendarError("configuration_error", "list_events", "max_results must be between 1 and 2500");
    }
    query.set("maxResults", String(input.max_results));
  }
  set_optional(query, "pageToken", page_token);
  set_optional_boolean(query, "singleEvents", input.single_events);
  set_optional_boolean(query, "showDeleted", input.show_deleted);
  set_optional(query, "q", input.q);
  set_optional(query, "orderBy", input.order_by);
  if (input.private_extended_property !== undefined) {
    const properties = Array.isArray(input.private_extended_property)
      ? input.private_extended_property
      : [input.private_extended_property];
    for (const property of properties) {
      query.append("privateExtendedProperty", require_text(property, "private_extended_property"));
    }
  }
  return query;
}

function insert_query(input: InsertEventInput): URLSearchParams {
  const query = new URLSearchParams();
  set_optional(query, "sendUpdates", input.send_updates);
  set_optional_boolean(query, "supportsAttachments", input.supports_attachments);
  set_optional_integer(query, "conferenceDataVersion", input.conference_data_version);
  return query;
}

function patch_query(input: PatchEventInput): URLSearchParams {
  const query = new URLSearchParams();
  set_optional(query, "sendUpdates", input.send_updates);
  set_optional_boolean(query, "supportsAttachments", input.supports_attachments);
  set_optional_integer(query, "conferenceDataVersion", input.conference_data_version);
  return query;
}

function delete_query(input: DeleteEventInput): URLSearchParams {
  const query = new URLSearchParams();
  set_optional(query, "sendUpdates", input.send_updates);
  return query;
}

function json_headers(): Record<string, string> {
  return { Accept: "application/json", "Content-Type": "application/json" };
}

function set_optional(query: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined) query.set(key, require_text(value, key));
}

function set_optional_boolean(query: URLSearchParams, key: string, value: boolean | undefined): void {
  if (value !== undefined) {
    if (typeof value !== "boolean") throw new GoogleCalendarError("configuration_error", "validation", `${key} must be boolean`);
    query.set(key, String(value));
  }
}

function set_optional_integer(query: URLSearchParams, key: string, value: number | undefined): void {
  if (value !== undefined) {
    if (!Number.isSafeInteger(value)) throw new GoogleCalendarError("configuration_error", "validation", `${key} must be an integer`);
    query.set(key, String(value));
  }
}

function require_event_id(value: string): string {
  const event_id = require_text(value, "event_id");
  if (event_id.length < EVENT_ID_MIN_LENGTH || event_id.length > EVENT_ID_MAX_LENGTH) {
    throw new GoogleCalendarError("configuration_error", "event_id", "event_id has an invalid length");
  }
  return event_id;
}

function require_timestamp(value: string, field_name: string): number {
  const timestamp_ms = Date.parse(require_text(value, field_name));
  if (!Number.isFinite(timestamp_ms)) {
    throw new GoogleCalendarError("configuration_error", field_name, `${field_name} must be a valid timestamp`);
  }
  return timestamp_ms;
}

function require_https_url(value: string, field_name: string): string {
  const address = require_text(value, field_name);
  let parsed_url: URL;
  try {
    parsed_url = new URL(address);
  } catch {
    throw new GoogleCalendarError("configuration_error", field_name, `${field_name} must be a valid HTTPS URL`);
  }
  if (parsed_url.protocol !== "https:") {
    throw new GoogleCalendarError("configuration_error", field_name, `${field_name} must use HTTPS`);
  }
  return address;
}

function require_text(value: string, field_name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GoogleCalendarError("configuration_error", field_name, `${field_name} must not be empty`);
  }
  return value;
}

function optional_text(value: string | undefined, field_name: string): string | undefined {
  if (value === undefined) return undefined;
  return require_text(value, field_name);
}

function positive_integer(value: number | undefined, field_name: string, default_value: number): number {
  if (value === undefined) return default_value;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GoogleCalendarError("configuration_error", field_name, `${field_name} must be a positive integer`);
  }
  return value;
}

function normalize_page_token(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function is_freebusy_response(value: unknown): value is GoogleFreebusyResponse {
  if (!is_record(value) || !is_record(value.calendars)) return false;
  return Object.values(value.calendars).every((calendar) => {
    if (!is_record(calendar)) return false;
    if (calendar.errors !== undefined && !Array.isArray(calendar.errors)) return false;
    if (calendar.busy === undefined) return calendar.errors !== undefined;
    if (!Array.isArray(calendar.busy)) return false;
    return calendar.busy.every((period) => is_record(period) && typeof period.start === "string" && typeof period.end === "string");
  });
}

async function read_upstream_code(response: Response): Promise<string | undefined> {
  try {
    const payload: unknown = await response.json();
    if (!is_record(payload) || !is_record(payload.error)) return undefined;
    const error = payload.error;
    if (typeof error.status === "string" && is_safe_upstream_code(error.status)) return error.status;
    if (typeof error.reason === "string" && is_safe_upstream_code(error.reason)) return error.reason;
    if (typeof error.code === "string" && is_safe_upstream_code(error.code)) return error.code;
    if (typeof error.code === "number" && Number.isSafeInteger(error.code)) return String(error.code);
    if (typeof error.status === "number" && Number.isSafeInteger(error.status)) return String(error.status);
  } catch {
    return undefined;
  }
  return undefined;
}

function is_timeout_error(error: unknown): boolean {
  if (!is_record(error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

function is_safe_upstream_code(value: string): boolean {
  return value.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(value);
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
