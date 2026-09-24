import type { GoogleOAuthClient } from "./oauth.js";

/** Minimal fetch shape that can be replaced by a test double. */
export type CalendarFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Constructor inputs for one tenant-scoped calendar client. */
export interface GoogleCalendarClientOptions {
  calendar_id: string;
  oauth_client: Pick<GoogleOAuthClient, "get_access_token">;
  fetch?: CalendarFetch;
  request_timeout_ms?: number;
  quota_user?: string;
}

/** RFC3339 interval and calendar selection for a freebusy query. */
export interface FreebusyQueryInput {
  time_min: string;
  time_max: string;
  calendar_ids?: readonly string[];
  time_zone?: string;
  group_expansion_max?: number;
  calendar_expansion_max?: number;
}

/** One busy interval returned by Google freebusy. */
export interface GoogleBusyPeriod {
  start: string;
  end: string;
}

/** Safe normalized shape of a freebusy response. */
export interface GoogleFreebusyCalendar {
  busy: GoogleBusyPeriod[];
  errors?: Array<{ domain?: string; reason?: string }>;
}

/** Google freebusy response used by the connector. */
export interface GoogleFreebusyResponse {
  calendars: Record<string, GoogleFreebusyCalendar>;
  [key: string]: unknown;
}

/** Event time fields accepted by the Calendar API. */
export interface GoogleEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
  [key: string]: unknown;
}

/** Event resource shape with common writable fields and forward-compatible extras. */
export interface GoogleCalendarEvent {
  id?: string;
  summary?: string;
  description?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  status?: string;
  transparency?: string;
  attendees?: unknown[];
  extendedProperties?: {
    private?: Record<string, string>;
    shared?: Record<string, string>;
  };
  [key: string]: unknown;
}

/** Query inputs for event listing. */
export interface ListEventsInput {
  time_min?: string;
  time_max?: string;
  time_zone?: string;
  max_results?: number;
  page_token?: string;
  single_events?: boolean;
  show_deleted?: boolean;
  q?: string;
  order_by?: "startTime" | "updated";
  private_extended_property?: string | readonly string[];
  paginate?: boolean;
}

/** Result of an event-list request after optional automatic pagination. */
export interface GoogleEventList {
  items: GoogleCalendarEvent[];
  next_page_token?: string;
}

/** Input for inserting an event. */
export interface InsertEventInput {
  event: GoogleCalendarEvent;
  send_updates?: "all" | "externalOnly" | "none";
  supports_attachments?: boolean;
  conference_data_version?: 0 | 1;
}

/** Input for applying event patch semantics. */
export interface PatchEventInput {
  event_id: string;
  event: GoogleCalendarEvent;
  send_updates?: "all" | "externalOnly" | "none";
  supports_attachments?: boolean;
  conference_data_version?: 0 | 1;
}

/** Input for deleting an event. */
export interface DeleteEventInput {
  event_id: string;
  send_updates?: "all" | "externalOnly" | "none";
}

/** Input for registering an event push channel. */
export interface WatchEventsInput {
  channel_id: string;
  address: string;
  token?: string;
  expiration?: number;
}

/** Google Calendar notification-channel response. */
export interface GoogleWatchChannel {
  id?: string;
  resourceId?: string;
  resourceUri?: string;
  token?: string;
  expiration?: number;
  [key: string]: unknown;
}
