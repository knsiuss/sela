/** Public API of the slot-engine package. */

export {
  DEFAULT_HOLD_TTL_SECONDS,
  MAX_HOLD_TTL_SECONDS,
  appointment_schema,
  appointment_status_schema,
  availability_query_schema,
  build_slot_key,
  confirm_request_schema,
  hold_request_schema,
  hold_schema,
  reschedule_request_schema,
  type Appointment,
  type AppointmentStatus,
  type AvailabilityQuery,
  type ConfirmRequest,
  type Hold,
  type HoldRequest,
  type RescheduleRequest,
  type SlotKeyParts,
} from "./slot_types.js";
export {
  HoldStore,
  type AcquireHoldParams,
  type FindHoldParams,
  type ReleaseHoldParams,
  type SlotHeldQuery,
} from "./hold_store.js";
export {
  AppointmentNotFoundError,
  HoldExpiredError,
  SlotService,
  SlotUnavailableError,
  type GetAppointmentParams,
  type ReleaseHoldRequest,
  type SlotServiceOptions,
} from "./slot_service.js";
