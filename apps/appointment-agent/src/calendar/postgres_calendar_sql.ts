/** Parameterized SQL owned by the durable Postgres calendar adapter. */

export const LOCK_OPERATION_SQL = `
  SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
`;

export const LOAD_OPERATION_SQL = `
  SELECT operation_type, request_fingerprint, result
  FROM calendar_operations
  WHERE tenant_id = $1 AND operation_key = $2
  LIMIT 1
`;

export const INSERT_OPERATION_SQL = `
  INSERT INTO calendar_operations (
    tenant_id, operation_key, operation_type, request_fingerprint, result
  )
  VALUES ($1, $2, $3, $4, $5::jsonb)
  RETURNING operation_type
`;

export const LIST_BLOCKERS_SQL = `
  SELECT resource_id::TEXT AS resource_id, starts_at, ends_at
  FROM appointments
  WHERE tenant_id = $1
    AND status IN ('held', 'confirmed')
    AND deleted_at IS NULL
    AND starts_at < $3::timestamptz
    AND ends_at > $2::timestamptz
  ORDER BY starts_at, id
`;

export const INSERT_HELD_APPOINTMENT_SQL = `
  INSERT INTO appointments (
    id, tenant_id, resource_id, service_id, customer_ref, status,
    starts_at, ends_at, hold_expires_at, idempotency_key, version
  )
  VALUES ($1, $2, $3, NULL, $4, 'held', $5::timestamptz, $6::timestamptz,
          $7::timestamptz, $8, 1)
  RETURNING id::TEXT AS appointment_id
`;

export const INSERT_HOLD_SQL = `
  INSERT INTO appointment_holds (
    tenant_id, resource_id, slot_start, slot_end, token, expires_at,
    slot_id, operation_key, appointment_id, status, contract_version, updated_at
  )
  VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6::timestamptz,
          $7, $8, $9, 'held', 2, now())
  RETURNING token AS hold_id
`;

export const LOCK_HOLD_SQL = `
  SELECT h.token AS hold_id,
         h.slot_id,
         h.resource_id::TEXT AS resource_id,
         h.slot_start,
         h.slot_end,
         h.expires_at,
         h.expires_at > now() AS is_live,
         h.status AS hold_status,
         h.appointment_id::TEXT AS held_appointment_id,
         a.status AS held_status,
         a.starts_at AS held_starts_at,
         a.ends_at AS held_ends_at,
         a.resource_id::TEXT AS held_resource_id
  FROM appointment_holds AS h
  JOIN appointments AS a ON a.id = h.appointment_id AND a.tenant_id = h.tenant_id
  WHERE h.tenant_id = $1 AND h.token = $2 AND h.contract_version = 2
  LIMIT 1
  FOR UPDATE OF h, a
`;

export const CONFIRM_HELD_APPOINTMENT_SQL = `
  UPDATE appointments
  SET status = 'confirmed', hold_expires_at = NULL
  WHERE tenant_id = $1 AND id = $2 AND status = 'held' AND deleted_at IS NULL
  RETURNING id::TEXT AS appointment_id
`;

export const MARK_HOLD_CONFIRMED_SQL = `
  UPDATE appointment_holds
  SET status = 'confirmed', confirmed_appointment_id = $3, updated_at = now()
  WHERE tenant_id = $1 AND token = $2 AND status = 'held'
  RETURNING token AS hold_id
`;

export const MARK_HELD_APPOINTMENT_RELEASED_SQL = `
  UPDATE appointments
  SET status = 'cancelled', deleted_at = COALESCE(deleted_at, now())
  WHERE tenant_id = $1 AND id = $2 AND status = 'held' AND deleted_at IS NULL
  RETURNING id::TEXT AS appointment_id
`;

export const MARK_HOLD_RELEASED_SQL = `
  UPDATE appointment_holds
  SET status = 'released', updated_at = now()
  WHERE tenant_id = $1 AND token = $2 AND status = 'held'
  RETURNING token AS hold_id
`;

export const MARK_HOLD_EXPIRED_SQL = `
  UPDATE appointment_holds
  SET status = 'expired', updated_at = now()
  WHERE tenant_id = $1 AND token = $2 AND status = 'held'
  RETURNING token AS hold_id
`;

export const CANCEL_BOOKING_SQL = `
  UPDATE appointments
  SET status = 'cancelled', deleted_at = COALESCE(deleted_at, now())
  WHERE tenant_id = $1 AND id = $2 AND status = 'confirmed'
  RETURNING id::TEXT AS appointment_id
`;

export const LOCK_SOURCE_APPOINTMENT_SQL = `
  SELECT id::TEXT AS appointment_id,
         tenant_id::TEXT AS tenant_id,
         version,
         status
  FROM appointments
  WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL AND resource_id IS NOT NULL
  LIMIT 1
  FOR UPDATE
`;

export const MOVE_APPOINTMENT_SQL = `
  UPDATE appointments
  SET resource_id = $4,
      starts_at = $5::timestamptz,
      ends_at = $6::timestamptz
  WHERE tenant_id = $1
    AND id = $2
    AND version = $3
    AND status = 'confirmed'
    AND deleted_at IS NULL
  RETURNING version
`;

export const INSERT_AUDIT_SQL = `
  INSERT INTO audit_log (tenant_id, actor, action, entity_type, entity_id, diff)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb)
`;

export const INSERT_REJECTION_AUDIT_SQL = `
  INSERT INTO audit_log (tenant_id, actor, action, entity_type, entity_id, diff)
  VALUES ($1, 'appointment-agent', $2, 'appointment', $3, $4::jsonb)
`;
