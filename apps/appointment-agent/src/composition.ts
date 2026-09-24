/** Runtime composition for the tenant-aware HTTP server and worker. */

import type { Server as NodeHttpServer } from "node:http";
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
import { PostgresWebhookJobQueue } from "./queue/postgres_outbox_queue.js";
import { PgSqlClient, load_pg_config } from "./persistence/pg_client.js";
import type { SqlClient } from "./persistence/sql_client.js";
import { SlotServiceAdapter } from "./tools/slot_service_adapter.js";
import {
  InMemoryRescheduleSessionStore,
  type RescheduleSessionStore,
} from "./reschedule/session_store.js";
import { PostgresRescheduleSessionStore } from "./reschedule/postgres_session_store.js";
import { RescheduleTurnProcessor } from "./reschedule/turn_processor.js";
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
import { run_worker_loop, type OutboundSenderPort, type WorkerLoopCounters } from "./worker/loop.js";
import { build_runtime_sender } from "./outbound/runtime_sender.js";
import {
  AesGcmRecipientCipher,
  EphemeralRecipientCipher,
  parse_recipient_cipher_key,
  RECIPIENT_CIPHER_KEY_ENV,
  type RecipientCipher,
} from "./security/recipient_cipher.js";

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
  sender?: OutboundSenderPort;
  calendar_factory?: (tenant_id: string) => CalendarPort;
  graph_factory?: GraphFactory;
  recipient_cipher?: RecipientCipher;
  slots?: readonly TimeSlot[];
}

/** Running resources and lifecycle methods for one application instance. */
export interface AppComposition {
  sql_client?: SqlClient;
  dedupe_store: InMemoryMessageDedupe | PostgresMessageDedupe;
  inbound_store: InboundMessageStore;
  tenant_resolver: TenantResolver;
  recipient_cipher: RecipientCipher;
  job_queue: WebhookJobQueue;
  job_claimer: JobClaimer;
  lifecycle: JobLifecycleStore;
  reschedule_session_store: RescheduleSessionStore;
  graph_factory: GraphFactory;
  sender: OutboundSenderPort;
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
 * @param options - Environment and optional sender/calendar injections.
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
  const recipient_cipher = resolve_recipient_cipher(
    env,
    has_database_url,
    options.recipient_cipher,
  );
  const sql_client = has_database_url
    ? new PgSqlClient({ ...load_pg_config(env), connection_string: database_url })
    : undefined;
  const retention_days = parse_retention_days(
    env["INBOUND_MESSAGE_RETENTION_DAYS"] ?? env["INBOUND_RETENTION_DAYS"],
  );

  const dedupe_store = sql_client === undefined
    ? new InMemoryMessageDedupe()
    : new PostgresMessageDedupe(sql_client);
  const inbound_store: InboundMessageStore = sql_client === undefined
    ? new InMemoryInboundMessageStore()
    : new PostgresInboundMessageStore(sql_client, { retention_days });
  const reschedule_session_store: RescheduleSessionStore = sql_client === undefined
    ? new InMemoryRescheduleSessionStore()
    : new PostgresRescheduleSessionStore(sql_client);
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
    const calendar = new SlotServiceAdapter({ tenant_id, slots: options.slots ?? [] });
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
  const sender = options.sender ?? build_runtime_sender(env);
  const deliver = async (drafts: readonly OutboundDraft[]): Promise<void> => {
    for (const draft of drafts) await sender.send(draft);
  };

  const process_job_fn = (job: Parameters<typeof process_job>[0]["job"]): Promise<OutboundDraft[]> => {
    const tenant_id = job.tenant_id ?? "unknown";
    const calendar = calendar_factory(tenant_id);
    const turn_processor = new RescheduleTurnProcessor({
      session_store: reschedule_session_store,
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
      max_attempts,
    });
  };

  const composition: AppComposition = {
    sql_client,
    dedupe_store,
    inbound_store,
    tenant_resolver,
    recipient_cipher,
    job_queue,
    job_claimer,
    lifecycle,
    reschedule_session_store,
    graph_factory,
    sender,
    start_server: async () => {
      if (server !== undefined) return;
      const config = load_server_config(env);
      server = await start_http_server(config, {
        dedupe_store,
        job_queue,
        tenant_resolver,
        inbound_store,
        recipient_cipher,
        inbound_retention_days: retention_days,
      });
    },
    start_worker: () => {
      if (worker_promise !== undefined) return;
      worker_controller = new AbortController();
      worker_promise = run_worker_loop({
        claimer: job_claimer,
        process: process_job_fn,
        poll_interval_ms,
        batch_size,
        signal: worker_controller.signal,
        on_error: (error) => {
          console.error(JSON.stringify({
            event: "worker_loop_error",
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

function make_in_memory_resolver(env: Record<string, string | undefined>): InMemoryTenantResolver {
  const phone_number_id = env["WHATSAPP_PHONE_NUMBER_ID"];
  const tenant_id = env["TENANT_ID"] ?? "1";
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
    const encoded_key = env[RECIPIENT_CIPHER_KEY_ENV];
    if (encoded_key === undefined || encoded_key === "") {
      throw new CompositionConfigurationError(`${RECIPIENT_CIPHER_KEY_ENV}-required`);
    }
    const key = parse_recipient_cipher_key(encoded_key);
    try {
      return new AesGcmRecipientCipher(key);
    } finally {
      key.fill(0);
    }
  }
  return new EphemeralRecipientCipher();
}

function parse_retention_days(value: string | undefined): number {
  return parse_positive_integer(value ?? String(DEFAULT_INBOUND_RETENTION_DAYS), "INBOUND_MESSAGE_RETENTION_DAYS");
}

function parse_positive_integer(value: string, field_name: string): number {
  if (!/^\d+$/.test(value)) throw new CompositionConfigurationError(`${field_name}-invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CompositionConfigurationError(`${field_name}-invalid`);
  }
  return parsed;
}
