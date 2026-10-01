/** Runtime composition for the tenant-aware HTTP server and worker. */

import type { Server as NodeHttpServer } from "node:http";
import { z } from "zod";
import { InMemoryMessageDedupe } from "./ingress/dedupe.js";
import {
  InMemoryInboundMessageStore,
  PostgresInboundMessageStore,
  DEFAULT_INBOUND_RETENTION_DAYS,
  type InboundMessageStore,
} from "./ingress/inbound_store.js";
import {
  InMemoryTenantResolver,
  SqlTenantResolver,
  type TenantResolver,
} from "./ingress/tenant_resolver.js";
import { load_server_config, start_http_server } from "./http/server.js";
import { InMemoryWebhookQueue, type WebhookJobQueue } from "./webhook_handler.js";
import { PostgresMessageDedupe } from "./ingress/postgres_dedupe.js";
import {
  PostgresAtomicIngressStore,
  type AtomicIngressStore,
} from "./ingress/postgres_atomic_ingress.js";
import { PostgresWebhookJobQueue } from "./queue/postgres_outbox_queue.js";
import { PgSqlClient, load_pg_config } from "./persistence/pg_client.js";
import type { SqlClient, TransactionalSqlClient } from "./persistence/sql_client.js";
import {
  InMemoryAppointmentRepository,
  PostgresAppointmentRepository,
  type AppointmentRepository,
} from "./appointments/appointment_repository.js";
import { PostgresCalendarWriter } from "./calendar/postgres_calendar.js";
import { time_slot_schema } from "./calendar/calendar_models.js";
import { SlotServiceAdapter } from "./tools/slot_service_adapter.js";
import {
  InMemoryRescheduleSessionStore,
  type RescheduleSessionStore,
} from "./reschedule/session_store.js";
import { PostgresRescheduleSessionStore } from "./reschedule/postgres_session_store.js";
import { RescheduleTurnProcessor } from "./reschedule/turn_processor.js";
import {
  InMemoryRescheduleAudit,
  PostgresRescheduleAudit,
  type RescheduleAudit,
} from "./reschedule/audit.js";
import type { CalendarPort } from "./tools/calendar.js";
import type { TimeSlot } from "./state.js";
import { build_graph } from "./graph.js";
import { PostgresJobClaimer, type JobClaimer } from "./worker/job_claim.js";
import {
  InMemoryJobLifecycleStore,
  PostgresJobLifecycleStore,
  type JobLifecycleStore,
} from "./worker/job_store.js";
import { StoreInboundLoader, type InboundLoader } from "./worker/inbound_loader.js";
import { process_job, JobProcessingError, type GraphRunner, type OutboundDraft } from "./worker/process_job.js";
import {
  run_worker_loop,
  type OutboundSenderPort,
  type OutboundSenderRegistry,
  type WorkerLoopCounters,
} from "./worker/loop.js";
import { build_runtime_sender, resolve_runtime_tenant_id } from "./outbound/runtime_sender.js";
import {
  InMemoryOutboundLedgerStore,
  type OutboundLedgerStore,
} from "./outbound/outbound_ledger.js";
import { PostgresOutboundLedgerStore } from "./outbound/postgres_outbound_ledger.js";
import { DurableOutboundSenderRegistry } from "./outbound/durable_outbound_registry.js";
import {
  InMemoryTenantRateLimiter,
  PostgresTenantRateLimiter,
  type TenantRateLimiter,
} from "./rate_limit/tenant_rate_limiter.js";
import { MetricsRegistry } from "./observability/metrics.js";
import { handle_operator_action, type OperatorApiOptions } from "./http/operator_api.js";
import {
  is_multi_tenant_sender_registry,
  SingleTenantOutboundSenderRegistry,
} from "./outbound/sender_registry.js";
import {
  EphemeralRecipientCipher,
  RECIPIENT_CIPHER_KEY_ENV,
  type RecipientCipher,
} from "./security/recipient_cipher.js";
import {
  parse_recipient_key_ring,
  RECIPIENT_KEY_RING_ENV,
} from "./security/recipient_key_ring.js";
import { RotatingRecipientCipher } from "./security/rotating_recipient_cipher.js";
import type { SecretAccessSink } from "./security/secret_manager.js";

/** Clear failure when runtime persistence is not configured safely. */
export class CompositionConfigurationError extends Error {
  /** Create a safe composition error. */
  constructor(reason: string) {
    super(`composition-configuration-invalid: ${reason}`);
    this.name = "CompositionConfigurationError";
  }
}

/** Factory used to create the graph for one tenant-scoped calendar. */
export type GraphFactory = (calendar: CalendarPort) => GraphRunner;

/** Optional dependencies supplied by a deployment composition root. */
export interface CompositionOptions {
  env?: Record<string, string | undefined>;
  /** Legacy per-sender injection; composition wraps it in a tenant binding. */
  sender?: OutboundSenderPort;
  /** Tenant-aware production sender boundary. */
  sender_registry?: OutboundSenderRegistry;
  calendar_factory?: (tenant_id: string) => CalendarPort;
  graph_factory?: GraphFactory;
  appointment_repository?: AppointmentRepository;
  reschedule_audit?: RescheduleAudit;
  recipient_cipher?: RecipientCipher;
  slots?: readonly TimeSlot[];
  rate_limiter?: TenantRateLimiter;
  outbound_ledger?: OutboundLedgerStore;
  metrics?: MetricsRegistry;
  /** Optional sink for PII-free secret access audit events. */
  secret_access_sink?: SecretAccessSink;
  outbound_provider?: string;
  operator_api_options?: OperatorApiOptions;
}

/** Running resources and lifecycle methods for one application instance. */
export interface AppComposition {
  sql_client?: SqlClient;
  dedupe_store: InMemoryMessageDedupe | PostgresMessageDedupe;
  atomic_ingress_store?: AtomicIngressStore;
  inbound_store: InboundMessageStore;
  tenant_resolver: TenantResolver;
  recipient_cipher: RecipientCipher;
  job_queue: WebhookJobQueue;
  job_claimer: JobClaimer;
  lifecycle: JobLifecycleStore;
  reschedule_session_store: RescheduleSessionStore;
  appointment_repository: AppointmentRepository;
  graph_factory: GraphFactory;
  rate_limiter: TenantRateLimiter;
  outbound_ledger: OutboundLedgerStore;
  metrics: MetricsRegistry;
  /** Resolved provider registry before the durable delivery wrapper. */
  sender_registry: OutboundSenderRegistry;
  /** Durable registry actually used by worker delivery. */
  durable_sender_registry: DurableOutboundSenderRegistry;
  /** Tenant admission scope; undefined only for an explicit multi-tenant registry. */
  worker_tenant_id?: string;
  server?: NodeHttpServer;
  start_server(): Promise<void>;
  start_worker(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  worker_counters(): Promise<WorkerLoopCounters>;
}

/**
 * Build the runtime dependency graph without starting network services.
 *
 * DATABASE_URL selects Postgres. In-memory adapters are allowed only when
 * USE_IN_MEMORY is exactly `true`; the default fails closed rather than
 * silently moving production data into process memory.
 *
 * @param options - Environment and optional sender-registry/calendar injections.
 * @returns A stoppable composition object.
 * @throws CompositionConfigurationError or adapter configuration errors.
 */
export function build_composition(options: CompositionOptions = {}): AppComposition {
  const env = options.env ?? process.env;
  const use_in_memory = env["USE_IN_MEMORY"] === "true";
  const database_url = env["DATABASE_URL"];
  const has_database_url = typeof database_url === "string" && database_url.trim() !== "";
  if (!has_database_url && !use_in_memory) {
    throw new CompositionConfigurationError("DATABASE_URL is required unless USE_IN_MEMORY=true");
  }
  if (has_database_url && use_in_memory) {
    throw new CompositionConfigurationError("DATABASE_URL and USE_IN_MEMORY=true are mutually exclusive");
  }
  const configured_slots = validate_calendar_slots(
    options.slots ?? parse_calendar_slots(env["CALENDAR_SLOTS_JSON"], has_database_url),
    has_database_url,
  );
  const recipient_cipher = resolve_recipient_cipher(
    env,
    has_database_url,
    options.recipient_cipher,
  );
  const sql_client = has_database_url
    ? new PgSqlClient({ ...load_pg_config(env), connection_string: database_url })
    : undefined;
  const transactional_sql_client = sql_client as TransactionalSqlClient | undefined;
  const metrics = options.metrics ?? new MetricsRegistry();
  const rate_limiter = options.rate_limiter ?? (sql_client === undefined
    ? new InMemoryTenantRateLimiter()
    : new PostgresTenantRateLimiter(sql_client));
  const outbound_ledger = options.outbound_ledger ?? (transactional_sql_client === undefined
    ? new InMemoryOutboundLedgerStore()
    : new PostgresOutboundLedgerStore(transactional_sql_client));
  const retention_days = parse_retention_days(
    env["INBOUND_MESSAGE_RETENTION_DAYS"] ?? env["INBOUND_RETENTION_DAYS"],
  );

  const dedupe_store = sql_client === undefined
    ? new InMemoryMessageDedupe()
    : new PostgresMessageDedupe(sql_client);
  const atomic_ingress_store = sql_client === undefined
    ? undefined
    : new PostgresAtomicIngressStore(sql_client);
  const inbound_store: InboundMessageStore = sql_client === undefined
    ? new InMemoryInboundMessageStore()
    : new PostgresInboundMessageStore(sql_client, { retention_days });
  const reschedule_session_store: RescheduleSessionStore = sql_client === undefined
    ? new InMemoryRescheduleSessionStore()
    : new PostgresRescheduleSessionStore(sql_client);
  const appointment_repository = options.appointment_repository
    ?? (sql_client === undefined
      ? new InMemoryAppointmentRepository()
      : new PostgresAppointmentRepository(sql_client));
  const reschedule_audit = options.reschedule_audit
    ?? (sql_client === undefined
      ? new InMemoryRescheduleAudit()
      : new PostgresRescheduleAudit(sql_client));
  const in_memory_queue = sql_client === undefined ? new InMemoryWebhookQueue() : undefined;
  const job_queue: WebhookJobQueue = in_memory_queue ?? new PostgresWebhookJobQueue(sql_client!);
  const tenant_resolver = sql_client === undefined
    ? make_in_memory_resolver(env)
    : new SqlTenantResolver(sql_client);
  const job_claimer: JobClaimer = in_memory_queue === undefined
    ? new PostgresJobClaimer(sql_client!)
    : { claim_next_job: (tenant_id?: string) => in_memory_queue.claim_next_job(tenant_id) };
  const lifecycle: JobLifecycleStore = sql_client === undefined
    ? new InMemoryJobLifecycleStore()
    : new PostgresJobLifecycleStore(sql_client);

  const default_calendars = new Map<string, CalendarPort>();
  const calendar_factory = options.calendar_factory ?? ((tenant_id: string): CalendarPort => {
    const cached = default_calendars.get(tenant_id);
    if (cached !== undefined) return cached;
    const calendar = transactional_sql_client === undefined
      ? new SlotServiceAdapter({ tenant_id, slots: configured_slots })
      : new PostgresCalendarWriter({
          sql_client: transactional_sql_client,
          tenant_id,
          slots: configured_slots,
        });
    default_calendars.set(tenant_id, calendar);
    return calendar;
  });
  const loader: InboundLoader = new StoreInboundLoader(inbound_store);
  const graph_factory: GraphFactory = options.graph_factory ?? ((calendar: CalendarPort): GraphRunner => {
    const graph = build_graph(calendar);
    return { invoke: (state) => graph.invoke(state) };
  });
  const max_attempts = parse_positive_integer(env["WORKER_MAX_ATTEMPTS"] ?? "3", "WORKER_MAX_ATTEMPTS");
  const poll_interval_ms = parse_positive_integer(env["WORKER_POLL_INTERVAL_MS"] ?? "1000", "WORKER_POLL_INTERVAL_MS");
  const batch_size = parse_positive_integer(env["WORKER_BATCH_SIZE"] ?? "10", "WORKER_BATCH_SIZE");
  let server: NodeHttpServer | undefined;
  let worker_controller: AbortController | undefined;
  let worker_promise: Promise<WorkerLoopCounters> | undefined;
  const sender_registry = resolve_outbound_sender(options, env, has_database_url, metrics);
  const rate_limit_config = resolve_rate_limit_config(env);
  const durable_sender_registry = new DurableOutboundSenderRegistry({
    registry: sender_registry,
    ledger: outbound_ledger,
    provider: options.outbound_provider ?? env["OUTBOUND_PROVIDER"] ?? "whatsapp",
    rate_limiter,
    outbound_limit: rate_limit_config.outbound_limit,
    outbound_window_seconds: rate_limit_config.outbound_window_seconds,
    allow_synthetic_ack: !has_database_url,
    metrics,
  });
  const worker_tenant_id = resolve_worker_tenant_scope(options, env, has_database_url, sender_registry);
  const deliver = async (tenant_id: string, drafts: readonly OutboundDraft[]): Promise<void> => {
    for (const draft of drafts) await durable_sender_registry.send(tenant_id, draft);
  };

  const process_job_fn = (job: Parameters<typeof process_job>[0]["job"]): Promise<OutboundDraft[]> => {
    const tenant_id = job.tenant_id ?? "unknown";
    const calendar = calendar_factory(tenant_id);
    const turn_processor = new RescheduleTurnProcessor({
      session_store: reschedule_session_store,
      appointment_repository,
      reschedule_audit,
      calendar,
      graph_runner: graph_factory(calendar),
    });
    return process_job({
      job,
      inbound_loader: loader,
      recipient_cipher,
      calendar,
      turn_processor,
      lifecycle,
      deliver,
      metrics,
      max_attempts,
    });
  };

  const composition: AppComposition = {
    sql_client,
    dedupe_store,
    atomic_ingress_store,
    inbound_store,
    tenant_resolver,
    recipient_cipher,
    job_queue,
    job_claimer,
    lifecycle,
    reschedule_session_store,
    appointment_repository,
    graph_factory,
    rate_limiter,
    outbound_ledger,
    metrics,
    sender_registry,
    durable_sender_registry,
    worker_tenant_id,
    start_server: async () => {
      if (server !== undefined) return;
      const config = load_server_config(env);
      server = await start_http_server(config, {
        dedupe_store,
        job_queue,
        atomic_ingress: atomic_ingress_store,
        tenant_resolver,
        inbound_store,
        recipient_cipher,
        inbound_retention_days: retention_days,
        rate_limiter,
        outbound_ledger,
        metrics,
        ...(options.operator_api_options === undefined ? {} : {
          operator_handler: handle_operator_action,
          operator_api_options: {
            ...options.operator_api_options,
            rate_limiter: options.operator_api_options.rate_limiter ?? rate_limiter,
            operator_limit: options.operator_api_options.operator_limit ?? rate_limit_config.operator_limit,
            operator_window_seconds: options.operator_api_options.operator_window_seconds ?? rate_limit_config.operator_window_seconds,
          },
        }),
        inbound_rate_limit: rate_limit_config.webhook_limit,
        inbound_rate_window_seconds: rate_limit_config.webhook_window_seconds,
      });
    },
    start_worker: () => {
      if (worker_promise !== undefined) return;
      worker_controller = new AbortController();
      worker_promise = run_worker_loop({
        claimer: job_claimer,
        tenant_id: worker_tenant_id,
        process: process_job_fn,
        poll_interval_ms,
        batch_size,
        signal: worker_controller.signal,
        on_error: (error, job) => {
          metrics.increment("worker_loop_errors_total", { error: error instanceof Error ? error.name : "UnknownError" });
          console.error(JSON.stringify({
            event: "worker_loop_error",
            job_id: job?.id,
            tenant_id: job?.tenant_id,
            error_name: error instanceof Error ? error.name : "UnknownError",
            ...(error instanceof JobProcessingError ? { error_code: error.code } : {}),
          }));
        },
      });
      void worker_promise.catch(() => undefined);
    },
    start: async () => {
      await composition.start_server();
      composition.start_worker();
    },
    stop: async () => {
      worker_controller?.abort();
      if (worker_promise !== undefined) await worker_promise;
      worker_promise = undefined;
      worker_controller = undefined;
      if (server !== undefined) {
        await new Promise<void>((resolve, reject) => {
          server?.close((error) => (error === undefined ? resolve() : reject(error)));
        });
        server = undefined;
      }
      await sql_client?.close?.();
    },
    worker_counters: async () => worker_promise ?? { processed: 0, failed: 0, skipped: 0 },
  };
  return composition;
}

let active_composition: AppComposition | undefined;

/** Start the HTTP server and worker using process environment composition. */
export async function start_all(): Promise<void> {
  active_composition ??= build_composition();
  await active_composition.start();
}

/** Start only the worker using process environment composition. */
export async function start_worker_only(): Promise<void> {
  active_composition ??= build_composition();
  active_composition.start_worker();
}

/** Stop the active composition, if one was started. */
export async function stop_all(): Promise<void> {
  if (active_composition === undefined) return;
  const composition = active_composition;
  active_composition = undefined;
  await composition.stop();
}

function resolve_outbound_sender(
  options: CompositionOptions,
  env: Record<string, string | undefined>,
  is_database_backed: boolean,
  metrics: MetricsRegistry,
): OutboundSenderRegistry {
  if (options.sender_registry !== undefined) {
    if (options.sender !== undefined) {
      throw new CompositionConfigurationError("sender-and-sender-registry-are-mutually-exclusive");
    }
    if (!is_outbound_sender_registry(options.sender_registry)) {
      throw new CompositionConfigurationError("sender-registry-invalid");
    }
    return options.sender_registry;
  }
  if (options.sender !== undefined) {
    if (!is_outbound_sender_port(options.sender)) {
      throw new CompositionConfigurationError("sender-invalid");
    }
    const tenant_id = resolve_runtime_tenant_id(env, is_database_backed);
    return new SingleTenantOutboundSenderRegistry(tenant_id, options.sender);
  }
  return build_runtime_sender(env, {
    secret_access_sink: options.secret_access_sink,
    metrics,
  });
}

function is_outbound_sender_registry(value: unknown): value is OutboundSenderRegistry {
  return typeof value === "object" && value !== null && typeof (value as { send?: unknown }).send === "function";
}

function is_outbound_sender_port(value: unknown): value is OutboundSenderPort {
  return typeof value === "object" && value !== null && typeof (value as { send?: unknown }).send === "function";
}

/**
 * Resolve the worker's queue admission scope.
 *
 * An injected or secret-backed multi-tenant registry is an explicit
 * deployment contract and may use the global claimer. Without that contract,
 * the worker is bound to the same single tenant as the injected sender.
 */
function resolve_worker_tenant_scope(
  options: CompositionOptions,
  env: Record<string, string | undefined>,
  is_database_backed: boolean,
  sender_registry: OutboundSenderRegistry,
): string | undefined {
  if (is_multi_tenant_sender_registry(sender_registry)) return undefined;
  const configured_tenant_id = env["TENANT_ID"]?.trim();
  if (options.sender_registry === undefined || (configured_tenant_id !== undefined && configured_tenant_id !== "")) {
    return resolve_runtime_tenant_id(env, is_database_backed);
  }
  throw new CompositionConfigurationError("multi-tenant-registry-required");
}

function make_in_memory_resolver(env: Record<string, string | undefined>): InMemoryTenantResolver {
  const phone_number_id = env["WHATSAPP_PHONE_NUMBER_ID"];
  const tenant_id = resolve_runtime_tenant_id(env, false);
  return phone_number_id === undefined || phone_number_id === ""
    ? new InMemoryTenantResolver()
    : new InMemoryTenantResolver({ [phone_number_id]: tenant_id });
}

function resolve_recipient_cipher(
  env: Record<string, string | undefined>,
  is_database_backed: boolean,
  injected_cipher: RecipientCipher | undefined,
): RecipientCipher {
  if (injected_cipher !== undefined) return injected_cipher;
  if (is_database_backed) {
    if (
      (env[RECIPIENT_CIPHER_KEY_ENV] === undefined || env[RECIPIENT_CIPHER_KEY_ENV] === "") &&
      (env[RECIPIENT_KEY_RING_ENV] === undefined || env[RECIPIENT_KEY_RING_ENV] === "")
    ) {
      throw new CompositionConfigurationError(`${RECIPIENT_CIPHER_KEY_ENV}-required`);
    }
    const ring = parse_recipient_key_ring(env);
    try {
      return new RotatingRecipientCipher(ring.keys, ring.active_key_id);
    } finally {
      for (const key of ring.keys.values()) key.fill(0);
    }
  }
  return new EphemeralRecipientCipher();
}

function parse_calendar_slots(value: string | undefined, is_database_backed: boolean): TimeSlot[] {
  if (value === undefined || value.trim() === "") {
    if (is_database_backed) throw new CompositionConfigurationError("CALENDAR_SLOTS_JSON-required");
    return [];
  }
  if (value.length > 65_536) throw new CompositionConfigurationError("CALENDAR_SLOTS_JSON-invalid");
  try {
    return z.array(time_slot_schema).max(500).parse(JSON.parse(value));
  } catch {
    throw new CompositionConfigurationError("CALENDAR_SLOTS_JSON-invalid");
  }
}

function validate_calendar_slots(slots: readonly TimeSlot[], is_database_backed: boolean): TimeSlot[] {
  let parsed: TimeSlot[];
  try {
    parsed = z.array(time_slot_schema).max(500).parse(slots);
  } catch {
    throw new CompositionConfigurationError("CALENDAR_SLOTS_JSON-invalid");
  }
  if (is_database_backed && parsed.length === 0) {
    throw new CompositionConfigurationError("CALENDAR_SLOTS_JSON-required");
  }
  if (is_database_backed && parsed.some((slot) => slot.resource_id === undefined)) {
    throw new CompositionConfigurationError("CALENDAR_SLOTS_JSON-resource_id-required");
  }
  return parsed;
}

function parse_retention_days(value: string | undefined): number {
  return parse_positive_integer(value ?? String(DEFAULT_INBOUND_RETENTION_DAYS), "INBOUND_MESSAGE_RETENTION_DAYS");
}

interface RateLimitConfig {
  webhook_limit: number;
  webhook_window_seconds: number;
  outbound_limit: number;
  outbound_window_seconds: number;
  operator_limit: number;
  operator_window_seconds: number;
}

function resolve_rate_limit_config(env: Record<string, string | undefined>): RateLimitConfig {
  return {
    webhook_limit: bounded_setting(env["RATE_LIMIT_WEBHOOK_MAX_REQUESTS"] ?? "120", "RATE_LIMIT_WEBHOOK_MAX_REQUESTS", 100_000),
    webhook_window_seconds: bounded_setting(env["RATE_LIMIT_WEBHOOK_WINDOW_SECONDS"] ?? "60", "RATE_LIMIT_WEBHOOK_WINDOW_SECONDS", 86_400),
    outbound_limit: bounded_setting(env["RATE_LIMIT_OUTBOUND_MAX_REQUESTS"] ?? "60", "RATE_LIMIT_OUTBOUND_MAX_REQUESTS", 100_000),
    outbound_window_seconds: bounded_setting(env["RATE_LIMIT_OUTBOUND_WINDOW_SECONDS"] ?? "60", "RATE_LIMIT_OUTBOUND_WINDOW_SECONDS", 86_400),
    operator_limit: bounded_setting(env["RATE_LIMIT_OPERATOR_MAX_REQUESTS"] ?? "60", "RATE_LIMIT_OPERATOR_MAX_REQUESTS", 100_000),
    operator_window_seconds: bounded_setting(env["RATE_LIMIT_OPERATOR_WINDOW_SECONDS"] ?? "60", "RATE_LIMIT_OPERATOR_WINDOW_SECONDS", 86_400),
  };
}

function bounded_setting(value: string, field_name: string, maximum: number): number {
  const parsed = parse_positive_integer(value, field_name);
  if (parsed > maximum) throw new CompositionConfigurationError(`${field_name}-invalid`);
  return parsed;
}

function parse_positive_integer(value: string, field_name: string): number {
  if (!/^\d+$/.test(value)) throw new CompositionConfigurationError(`${field_name}-invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CompositionConfigurationError(`${field_name}-invalid`);
  }
  return parsed;
}
