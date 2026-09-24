# @repo/mcp-gcal

Dependency-free Google Calendar v3 client and a minimal stdio MCP connector for Sela. The package uses native `fetch`; it does not include a Google SDK or an MCP SDK.

The implementation was checked against the official [freebusy query reference](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query), [push notifications guide](https://developers.google.com/workspace/calendar/api/guides/push), [quota guide](https://developers.google.com/workspace/calendar/api/guides/quota), and [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server).

## Boundary and contracts

- `GoogleOAuthClient` exchanges a tenant refresh token for an in-memory access token. Access tokens are not configuration values, are never logged, and are cached with an expiry buffer.
- `GoogleCalendarClient` exposes `freebusy_query`, `list_events`, `insert_event`, `patch_event`, `delete_event`, and `watch_events` using Calendar API v3 HTTP paths.
- `AppointmentCalendarPort` is the package-owned port. It has no imports from `apps/*`; the appointment-agent owns its own `CalendarPort` adapter.
- `GoogleCalendarMcpServer` implements JSON-RPC 2.0 over newline-delimited stdio for `initialize`, `tools/list`, and `tools/call`.
- Upstream failures are represented by `GoogleCalendarError` with `status` and `code_upstream`. Response bodies are parsed only for those safe fields and are not retained or returned.

`list_events` follows `nextPageToken` automatically. Set `paginate: false` when a caller deliberately needs one page and its cursor.

## Environment and secrets

The application supplies secrets from its environment or a secret manager; do not commit them:

```text
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_OAUTH_REFRESH_TOKEN
GOOGLE_CALENDAR_ID
GOOGLE_QUOTA_USER       # optional quotaUser value
GOOGLE_CALENDAR_TIME_ZONE
```

The library does not read `process.env` implicitly; the host maps these values to constructor options and the tenant secret provider.

`GOOGLE_OAUTH_REFRESH_TOKEN` is tenant-scoped. A multi-tenant process should create one `GoogleOAuthClient` per tenant or inject a `refresh_token_provider` keyed by a non-secret tenant token key. The client sends the client id, client secret, grant type, and refresh token in a form-encoded request body to `https://oauth2.googleapis.com/token`; the client secret is never placed in the URL.

### Authorization flow

1. Register a Google OAuth client and enable the Google Calendar API.
2. Run the Google authorization-code flow for the tenant with offline access so a refresh token is issued, using the minimum Calendar scopes the deployment needs.
3. Store the client secret and refresh token in the deployment secret store.
4. Construct `GoogleOAuthClient` with those values and a stable non-secret `token_key`.
5. Construct `GoogleCalendarClient` with the tenant calendar id and the OAuth client.

Do not use a service account for arbitrary consumer Gmail accounts. Domain-wide delegation is appropriate only for a Workspace domain that the operator administers; consumer Gmail requires the tenant user's OAuth grant.

## MCP tools

The stdio server exposes:

| Tool | Input | Result |
| --- | --- | --- |
| `list_availability` | `window_start_iso`, `window_end_iso`, optional `time_zone` | Google freebusy busy blocks |
| `create_booking` | `idempotency_key`, `start_iso`, `end_iso`, `summary`, optional `description`, `time_zone` | booking id and echoed idempotency key |
| `reschedule_booking` | `booking_id`, `idempotency_key`, `start_iso`, `end_iso`, `summary`, optional `description`, `time_zone` | booking id and echoed idempotency key |
| `cancel_booking` | `booking_id`, `idempotency_key` | cancellation result and echoed idempotency key |

Every booking mutation result includes the caller's `idempotency_key`. Tool failures are returned as MCP results with `isError: true`; they do not crash the stdio process. JSON-RPC parse, unknown-method, and malformed-request failures retain JSON-RPC error responses.

A host can start the stdio loop with `start_google_calendar_mcp_server({ client })`, or use `GoogleCalendarMcpServer.handle_request()` for an embedded transport. The stdio process is the local trust boundary: construct the client only after the host has resolved and authorized the tenant's OAuth secret.

### Example initialize and tool call

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "create_booking",
    "arguments": {
      "idempotency_key": "conversation-123:booking-1",
      "start_iso": "2026-10-01T08:00:00Z",
      "end_iso": "2026-10-01T08:30:00Z",
      "summary": "Appointment"
    }
  }
}
```

The create path derives a calendar-scoped deterministic event id from the idempotency key. A retry therefore does not intentionally create a second event; callers must still handle a safe upstream conflict according to their deployment policy.

## Operational limitations

- Calendar API quota is currently documented as 10,000 requests per minute per project, 600 per minute per user/project, and 1,000,000 per day per project. Handle quota errors and monitor usage; this client does not add automatic retries.
- The client uses bounded request timeouts and does not retry automatically. Retry policy belongs to the caller and must be idempotency-aware.
- Push channels require an HTTPS callback with a valid certificate. The optional channel token is verification data, not a place for OAuth/access tokens. Google sends header-only notifications; consumers must re-fetch changed resources. Notification delivery is not 100% reliable and channels require renewal.
- `freebusy.query` returns busy intervals, not service-duration slots. Any slot generation is an approximation based on configured working hours, service duration, and timezone assumptions; it is not a precise provider availability guarantee.
- Google Calendar has no native appointment hold primitive. The appointment-agent adapter represents a hold as an event description marker with an expiry, then patches or deletes that event. This is an application-level convention and can leave a stale event if the process fails before cleanup.
