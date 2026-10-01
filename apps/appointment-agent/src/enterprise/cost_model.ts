/** Cost-per-appointment and cost-per-message accounting for tenant locations. */

/** Closed spend categories so chargeback reports cannot drift between runs. */
export type CostCategory = "whatsapp_message" | "llm_call" | "database_operation" | "observability_event";

/** Approved category set, ordered so reports render deterministically. */
export const COST_CATEGORIES: readonly CostCategory[] = Object.freeze([
  "whatsapp_message",
  "llm_call",
  "database_operation",
  "observability_event",
]);

/**
 * Unit prices expressed in micro-currency units.
 *
 * Integer micro-units keep a summed total exactly reproducible; float currency
 * accumulation drifts and makes a chargeback figure unreconcilable.
 */
export type UnitRates = Readonly<Record<CostCategory, number>>;

/** One bounded usage increment recorded against a tenant location. */
export interface UsageEntry {
  tenant_id: string;
  location_id: string;
  category: CostCategory;
  units: number;
}

/** Accumulated usage for one tenant location within the tracked period. */
export interface UsageTotals {
  units: Readonly<Record<CostCategory, number>>;
  appointments_performed: number;
  messages_sent: number;
}

/** Derived spend for one tenant with per-unit economics resolved. */
export interface TenantCostSummary {
  tenant_id: string;
  by_category: Readonly<Record<CostCategory, number>>;
  total_micro: number;
  appointments_performed: number;
  messages_sent: number;
  /** Null when no appointment completed yet, so no misleading zero or Infinity. */
  cost_per_appointment_micro: number | null;
  /** Null when no message was sent yet. */
  cost_per_message_micro: number | null;
}

/** One chargeback line attributed to a tenant location. */
export interface ChargebackLine {
  location_id: string;
  by_category: Readonly<Record<CostCategory, number>>;
  total_micro: number;
}

/** Safe failure for malformed cost input or exhausted ledger capacity. */
export class CostModelError extends Error {
  readonly code = "cost_model_invalid";

  /** Create a sanitized cost-model failure. */
  constructor(reason: string) {
    super(reason);
    this.name = "CostModelError";
  }
}

const MAX_TRACKED_LOCATIONS = 10_000;
const MAX_UNITS = 1_000_000_000;
const MAX_RATE_MIC = 1_000_000_000;
const CONTROL_CHARACTER_CEILING = 0x1f;
const DELETE_CHARACTER = 0x7f;

/**
 * Explicit process-local cost ledger for deterministic tests and pilot mode.
 *
 * The ledger is intentionally bounded: production accounting belongs in a
 * durable store, so exhausting capacity fails loudly instead of silently
 * dropping usage that a later chargeback report would understate.
 */
export class InMemoryCostLedger {
  private readonly rates: UnitRates;
  private readonly totals = new Map<string, UsageTotals>();

  /** Create a ledger priced by the supplied unit rates. */
  constructor(rates: UnitRates) {
    this.rates = validate_rates(rates);
  }

  /** Accumulate one usage increment, failing fast when capacity is exhausted. */
  record(entry: UsageEntry): void {
    const normalized = validate_usage(entry);
    const key = scope_key(normalized.tenant_id, normalized.location_id);
    if (!this.totals.has(key) && this.totals.size >= MAX_TRACKED_LOCATIONS) {
      throw new CostModelError("cost-ledger-capacity-exceeded");
    }
    const current = this.totals.get(key) ?? empty_totals();
    this.totals.set(key, {
      units: { ...current.units, [normalized.category]: current.units[normalized.category] + normalized.units },
      appointments_performed: current.appointments_performed,
      messages_sent: current.messages_sent,
    });
  }

  /** Record completed appointments and sent messages used as unit denominators. */
  record_outcome(tenant_id: string, location_id: string, appointments: number, sent_messages: number): void {
    const key = scope_key(tenant_id_value(tenant_id), safe_identifier(location_id));
    const appointment_delta = non_negative_integer(appointments, "cost-appointments-invalid");
    const message_delta = non_negative_integer(sent_messages, "cost-messages-invalid");
    const current = this.totals.get(key) ?? empty_totals();
    this.totals.set(key, {
      units: { ...current.units },
      appointments_performed: current.appointments_performed + appointment_delta,
      messages_sent: current.messages_sent + message_delta,
    });
  }

  /** Resolve spend and per-unit economics for one tenant. */
  summarize(target_tenant_id: string): TenantCostSummary {
    const tenant = tenant_id_value(target_tenant_id);
    const by_category = this.priced_by_category(tenant);
    const total_micro = sum_of(by_category);
    const appointments = this.outcome_total(tenant, "appointments_performed");
    const messages = this.outcome_total(tenant, "messages_sent");
    return Object.freeze({
      tenant_id: tenant,
      by_category: Object.freeze(by_category),
      total_micro,
      appointments_performed: appointments,
      messages_sent: messages,
      cost_per_appointment_micro: divide(total_micro, appointments),
      cost_per_message_micro: divide(total_micro, messages),
    });
  }

  /** Resolve per-location chargeback lines for one tenant. */
  chargeback_lines(target_tenant_id: string): readonly ChargebackLine[] {
    const tenant = tenant_id_value(target_tenant_id);
    const lines: ChargebackLine[] = [];
    for (const [key, totals] of this.totals) {
      if (!key.startsWith(`${tenant}|`)) continue;
      const by_category = this.price_units(totals);
      lines.push(Object.freeze({
        location_id: key.slice(`${tenant}|`.length),
        by_category: Object.freeze(by_category),
        total_micro: sum_of(by_category),
      }));
    }
    return Object.freeze(lines);
  }

  private priced_by_category(tenant: string): Record<CostCategory, number> {
    const totals_by_category = zeroed_categories();
    for (const [key, totals] of this.totals) {
      if (!key.startsWith(`${tenant}|`)) continue;
      for (const category of COST_CATEGORIES) {
        totals_by_category[category] += price(totals.units[category], this.rates[category]);
      }
    }
    return totals_by_category;
  }

  private price_units(totals: UsageTotals): Record<CostCategory, number> {
    const priced = zeroed_categories();
    for (const category of COST_CATEGORIES) priced[category] = price(totals.units[category], this.rates[category]);
    return priced;
  }

  private outcome_total(tenant: string, field: "appointments_performed" | "messages_sent"): number {
    let total = 0;
    for (const [key, totals] of this.totals) {
      if (key.startsWith(`${tenant}|`)) total += totals[field];
    }
    return total;
  }
}

function validate_rates(value: UnitRates): UnitRates {
  if (typeof value !== "object" || value === null) throw new CostModelError("cost-rates-invalid");
  const record = value as Record<string, unknown>;
  const rates = {} as Record<CostCategory, number>;
  for (const category of COST_CATEGORIES) {
    rates[category] = bounded_rate(record[category]);
  }
  return Object.freeze(rates);
}

function validate_usage(value: UsageEntry): UsageEntry {
  if (typeof value !== "object" || value === null) throw new CostModelError("cost-usage-invalid");
  if (!is_category(value.category)) throw new CostModelError("cost-category-invalid");
  return {
    tenant_id: tenant_id_value(value.tenant_id),
    location_id: safe_identifier(value.location_id),
    category: value.category,
    units: bounded_units(value.units),
  };
}

function empty_totals(): UsageTotals {
  return { units: Object.freeze(zeroed_categories()), appointments_performed: 0, messages_sent: 0 };
}

function zeroed_categories(): Record<CostCategory, number> {
  const zeroed = {} as Record<CostCategory, number>;
  for (const category of COST_CATEGORIES) zeroed[category] = 0;
  return zeroed;
}

function sum_of(values: Readonly<Record<CostCategory, number>>): number {
  const total = COST_CATEGORIES.reduce((sum, category) => sum + values[category], 0);
  if (!Number.isSafeInteger(total)) throw new CostModelError("cost-total-overflow");
  return total;
}

/** Price one line, refusing any product that would lose integer precision. */
function price(units: number, rate: number): number {
  const amount = units * rate;
  if (!Number.isSafeInteger(amount)) throw new CostModelError("cost-amount-overflow");
  return amount;
}

function divide(total_micro: number, units: number): number | null {
  return units === 0 ? null : total_micro / units;
}

function scope_key(tenant: string, location: string): string {
  return `${tenant}|${location}`;
}

function is_category(value: unknown): value is CostCategory {
  return typeof value === "string" && (COST_CATEGORIES as readonly string[]).includes(value);
}

function tenant_id_value(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) throw new CostModelError("cost-tenant-invalid");
  return value;
}

function safe_identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    has_control_character(value)
  ) {
    throw new CostModelError("cost-location-invalid");
  }
  return value;
}

function bounded_units(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_UNITS) {
    throw new CostModelError("cost-units-invalid");
  }
  return value;
}

function bounded_rate(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_RATE_MIC) {
    throw new CostModelError("cost-rates-invalid");
  }
  return value;
}

function non_negative_integer(value: unknown, reason: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_UNITS) {
    throw new CostModelError(reason);
  }
  return value;
}

function has_control_character(value: string): boolean {
  for (const character of value) {
    const code_point = character.codePointAt(0) ?? 0;
    if (code_point <= CONTROL_CHARACTER_CEILING || code_point === DELETE_CHARACTER) return true;
  }
  return false;
}