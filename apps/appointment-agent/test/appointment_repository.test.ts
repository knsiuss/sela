import { describe, expect, it, vi } from "vitest";
import {
  AppointmentRepositoryError,
  InMemoryAppointmentRepository,
  PostgresAppointmentRepository,
} from "../src/appointments/appointment_repository.js";

const APPOINTMENT_ID = "00000000-0000-4000-8000-000000000042";
const APPOINTMENT = {
  appointment_id: APPOINTMENT_ID,
  tenant_id: "42",
  version: 3,
  status: "confirmed" as const,
  resource_id: "7",
  starts_at_iso: "2026-10-01T08:00:00.000Z",
  ends_at_iso: "2026-10-01T08:30:00.000Z",
};

describe("appointment repository", () => {
  it("scopes in-memory reads by tenant and returns defensive copies", async () => {
    const repository = new InMemoryAppointmentRepository([APPOINTMENT]);

    await expect(repository.get({ tenant_id: "42", appointment_id: APPOINTMENT_ID }))
      .resolves.toEqual(APPOINTMENT);
    await expect(repository.get({ tenant_id: "43", appointment_id: APPOINTMENT_ID })).resolves.toBeNull();
    const loaded = await repository.get({ tenant_id: "42", appointment_id: APPOINTMENT_ID });
    if (loaded !== null) loaded.version = 99;
    await expect(repository.get({ tenant_id: "42", appointment_id: APPOINTMENT_ID }))
      .resolves.toMatchObject({ version: 3 });
  });

  it("uses explicit tenant and appointment predicates in Postgres", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [{
        appointment_id: APPOINTMENT_ID,
        tenant_id: "42",
        version: 3,
        status: "confirmed",
        resource_id: "7",
        starts_at: new Date(APPOINTMENT.starts_at_iso),
        ends_at: new Date(APPOINTMENT.ends_at_iso),
      }],
      rowCount: 1,
    }));
    const repository = new PostgresAppointmentRepository({ query });

    await expect(repository.get({ tenant_id: "42", appointment_id: APPOINTMENT_ID }))
      .resolves.toEqual(APPOINTMENT);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("tenant_id = $1"), ["42", APPOINTMENT_ID]);
    expect(query.mock.calls[0]?.[0]).toContain("id = $2");
    expect(query.mock.calls[0]?.[0]).toContain("deleted_at IS NULL");
  });

  it("fails closed on malformed scopes, rows, and driver errors", async () => {
    const repository = new InMemoryAppointmentRepository();
    await expect(repository.get({ tenant_id: "0", appointment_id: APPOINTMENT_ID }))
      .rejects.toBeInstanceOf(AppointmentRepositoryError);

    const malformed = new PostgresAppointmentRepository({
      query: vi.fn(async () => ({ rows: [{ tenant_id: "42" }], rowCount: 1 })),
    });
    await expect(malformed.get({ tenant_id: "42", appointment_id: APPOINTMENT_ID }))
      .rejects.toBeInstanceOf(AppointmentRepositoryError);

    const failure = new PostgresAppointmentRepository({
      query: vi.fn(async () => {
        throw new Error("password=secret internal SQL");
      }),
    });
    const error = await failure.get({ tenant_id: "42", appointment_id: APPOINTMENT_ID }).catch((value) => value);
    expect(error).toBeInstanceOf(AppointmentRepositoryError);
    expect(String(error)).not.toMatch(/secret|internal SQL/);
  });
});
