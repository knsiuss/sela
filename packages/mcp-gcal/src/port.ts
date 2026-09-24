/** Availability value exposed by the package boundary. */
export interface AppointmentSlot {
  id: string;
  start_iso: string;
  end_iso: string;
  staff?: string;
  resource?: string;
}

/** Input for creating a calendar booking. */
export interface CreateBookingInput {
  idempotency_key: string;
  slot_id?: string;
  start_iso: string;
  end_iso: string;
  summary: string;
  description?: string;
}

/** Input for moving an existing calendar booking. */
export interface UpdateBookingInput {
  booking_id: string;
  idempotency_key: string;
  start_iso: string;
  end_iso: string;
  summary: string;
  description?: string;
}

/** Booking result returned by a package-level calendar port. */
export interface BookingResult {
  booking_id: string;
  idempotency_key: string;
  start_iso: string;
  end_iso: string;
  summary: string;
}

/**
 * Package-owned calendar port used by adapters and servers.
 *
 * This contract intentionally has no dependency on application state or error
 * classes. Application-specific adapters translate their own domain failures
 * at the application boundary.
 */
export interface AppointmentCalendarPort {
  /** List approximate availability slots in a half-open window. */
  list_slots(window_start_iso: string, window_end_iso: string): Promise<AppointmentSlot[]>;

  /** Create a booking and return the stable idempotency key. */
  create_booking(input: CreateBookingInput): Promise<BookingResult>;

  /** Update a booking while preserving the same idempotent write contract. */
  update_booking(input: UpdateBookingInput): Promise<BookingResult>;

  /** Cancel a booking; an already-absent booking is an idempotent outcome. */
  cancel_booking(booking_id: string): Promise<void>;
}
