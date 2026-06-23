// SPDX-License-Identifier: Apache-2.0

/**
 * Cron lifecycle → telemetry (schema 1.6.0).
 *
 * OpenClaw's cron scheduler fires jobs that may or may not run an agent turn.
 * The turn path (hooks.ts) only sees `agentTurn`-kind jobs that actually run a
 * model turn; turn-less `systemEvent` jobs, scheduler-`skipped` runs, and
 * CLI-provider crons are invisible there. The `cron_changed` GATEWAY hook fires
 * for EVERY scheduler outcome, so this module turns it into two spans:
 *
 *   - `openclaw.cron.run`        — one per scheduler firing (action=finished).
 *     Joined to its `openclaw.agent.turn` (when a turn ran) by (job_id, run_id);
 *     carries NO `gen_ai.usage.*` so token totals are never double-counted.
 *   - `openclaw.cron.definition` — registry change (added/updated/removed) +
 *     a gateway_start snapshot. Latest-per-`job_id` = the live cron list with
 *     schedule, so a consumer can list crons even when they haven't run yet.
 *
 * It also keeps a small {@link CronRegistry} (jobId → name/schedule/next-run),
 * seeded from `getCron().list()` at gateway_start and kept current from
 * cron_changed, so the turn hooks can stamp name/schedule onto cron TURN spans
 * (the turn event carries only the jobId) and a `removed`/just-deleted finished
 * event (which may omit `job`) still resolves its name/schedule.
 *
 * NO new global registration and NO new runtime deps — this reuses the plugin's
 * own tracer + trace-context store.
 */

import { trace, ROOT_CONTEXT, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Tracer, Span, Context, Attributes, Counter } from "@opentelemetry/api";
import type { TraceContextStore } from "./trace-context-store";
import type { ContentCapturePolicy } from "./config";
import type { TelemetryLogger } from "./telemetry";
import {
  SPAN_OPENCLAW_CRON_RUN,
  SPAN_OPENCLAW_CRON_DEFINITION,
  OPENCLAW_CRON_JOB_ID,
  OPENCLAW_CRON_JOB_NAME,
  OPENCLAW_CRON_RUN_ID,
  OPENCLAW_CRON_ACTION,
  OPENCLAW_CRON_STATUS,
  OPENCLAW_CRON_SCHEDULE_KIND,
  OPENCLAW_CRON_SCHEDULE_EXPR,
  OPENCLAW_CRON_SCHEDULE_EVERY_MS,
  OPENCLAW_CRON_SCHEDULE_TZ,
  OPENCLAW_CRON_NEXT_RUN_AT_MS,
  OPENCLAW_CRON_LAST_RUN_AT_MS,
  OPENCLAW_CRON_LAST_RUN_STATUS,
  OPENCLAW_CRON_ENABLED,
  OPENCLAW_CRON_REMOVED,
  OPENCLAW_CRON_DURATION_MS,
  OPENCLAW_CRON_DELIVERED,
  OPENCLAW_CRON_DELIVERY_STATUS,
  OPENCLAW_CRON_SUMMARY,
  OPENCLAW_SESSION_KEY,
  OPENCLAW_TRIGGER,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_PROVIDER_NAME,
} from "./semconv";

type AnyEvent = Record<string, any>;

/** Max length of the bounded, single-line cron run summary. */
const CRON_SUMMARY_MAX = 200;

// ── small coercion helpers (local, mirror hooks.ts) ──────────────────────────
const firstString = (...vals: unknown[]): string | undefined => {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
};
const num = (...vals: unknown[]): number | undefined => {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
};
const bounded = (s: unknown): string | undefined =>
  typeof s === "string" && s.length > 0
    ? s.replace(/\s+/g, " ").trim().slice(0, CRON_SUMMARY_MAX)
    : undefined;
/** Drop undefined values — OTel setAttributes rejects them. */
const pruned = (a: Record<string, string | number | boolean | undefined>): Attributes => {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(a)) if (v !== undefined) out[k] = v;
  return out;
};

// ── Cron metadata registry ───────────────────────────────────────────────────

export interface CronMeta {
  name?: string;
  scheduleKind?: string;
  scheduleExpr?: string;
  scheduleEveryMs?: number;
  scheduleTz?: string;
  nextRunAtMs?: number;
  enabled?: boolean;
}

/**
 * In-memory cron job registry (jobId → metadata), shared with the turn hooks so
 * cron TURN spans can be stamped with name/schedule — the turn event carries only
 * the jobId, never the job object. Seeded from `getCron().list()` at
 * gateway_start and kept current from cron_changed. Upserts MERGE so a later
 * event carrying only `nextRunAtMs` doesn't wipe a cached name/schedule.
 */
export class CronRegistry {
  private readonly jobs = new Map<string, CronMeta>();
  upsert(jobId: string, meta: CronMeta): void {
    const prev = this.jobs.get(jobId);
    this.jobs.set(jobId, prev ? { ...prev, ...stripUndefined(meta) } : meta);
  }
  remove(jobId: string): void {
    this.jobs.delete(jobId);
  }
  get(jobId: string): CronMeta | undefined {
    return this.jobs.get(jobId);
  }
  get size(): number {
    return this.jobs.size;
  }
}

function stripUndefined(m: CronMeta): CronMeta {
  const out: CronMeta = {};
  for (const [k, v] of Object.entries(m)) if (v !== undefined) (out as AnyEvent)[k] = v;
  return out;
}

/** Pull {@link CronMeta} out of a PluginHookGatewayCronJob (the `job` on cron events). */
export function metaFromJob(job: AnyEvent | undefined): CronMeta {
  const s = job?.schedule as AnyEvent | undefined;
  return {
    name: firstString(job?.name),
    enabled: typeof job?.enabled === "boolean" ? job.enabled : undefined,
    nextRunAtMs: num(job?.state?.nextRunAtMs),
    scheduleKind: firstString(s?.kind),
    scheduleExpr: firstString(s?.expr),
    scheduleEveryMs: num(s?.everyMs),
    scheduleTz: firstString(s?.tz),
  };
}

// ── Pure attribute extractors (unit-testable without a gateway) ───────────────

/**
 * Attributes for an `openclaw.cron.definition` span (registry row). Prefers the
 * event's own `job` for name/schedule, falling back to the registry cache when
 * `job` is omitted — notably the `removed` tombstone, which often carries only
 * the jobId yet the registry still holds the job's metadata (the row is pruned
 * AFTER this span is emitted), so the tombstone stays self-describing.
 */
export function cronDefinitionAttrs(event: AnyEvent, registry?: CronRegistry): Attributes {
  const job = event.job as AnyEvent | undefined;
  const jobId = firstString(event.jobId, job?.id) ?? "unknown";
  const m = job ? metaFromJob(job) : registry?.get(jobId) ?? {};
  const corr = `cron:${jobId}`;
  return pruned({
    [OPENCLAW_CRON_JOB_ID]: jobId,
    [OPENCLAW_CRON_JOB_NAME]: m.name,
    [OPENCLAW_CRON_ACTION]: firstString(event.action),
    [OPENCLAW_CRON_SCHEDULE_KIND]: m.scheduleKind,
    [OPENCLAW_CRON_SCHEDULE_EXPR]: m.scheduleExpr,
    [OPENCLAW_CRON_SCHEDULE_EVERY_MS]: m.scheduleEveryMs,
    [OPENCLAW_CRON_SCHEDULE_TZ]: m.scheduleTz,
    [OPENCLAW_CRON_ENABLED]: m.enabled,
    [OPENCLAW_CRON_NEXT_RUN_AT_MS]: num(m.nextRunAtMs, job?.state?.nextRunAtMs),
    [OPENCLAW_CRON_LAST_RUN_AT_MS]: num(job?.state?.lastRunAtMs),
    [OPENCLAW_CRON_LAST_RUN_STATUS]: firstString(job?.state?.lastRunStatus),
    [OPENCLAW_CRON_REMOVED]: event.action === "removed" ? true : undefined,
    // Correlation keys are required on every emitted span by the contract.
    [GEN_AI_CONVERSATION_ID]: corr,
    [OPENCLAW_SESSION_KEY]: corr,
  });
}

/**
 * Attributes for an `openclaw.cron.run` span (one scheduler firing). Prefers the
 * event's own `job` for name/schedule, falling back to the registry cache for the
 * `removed`/just-deleted case where `job` is omitted. Deliberately carries NO
 * `gen_ai.usage.*` — the joined `openclaw.agent.turn` is the token record.
 */
export function cronRunAttrs(
  event: AnyEvent,
  registry: CronRegistry,
  capture: ContentCapturePolicy,
): Attributes {
  const jobId = firstString(event.jobId, event.job?.id) ?? "unknown";
  const m = event.job ? metaFromJob(event.job) : registry.get(jobId) ?? {};
  const sessionKey = firstString(event.sessionKey) ?? `cron:${jobId}`;
  return pruned({
    [OPENCLAW_CRON_JOB_ID]: jobId,
    [OPENCLAW_CRON_JOB_NAME]: m.name,
    [OPENCLAW_CRON_RUN_ID]: firstString(event.runId),
    // A `finished` event always carries status; default to `unknown` (NOT `ok`)
    // so a malformed/future host event is never silently counted as a success.
    [OPENCLAW_CRON_STATUS]: firstString(event.status) ?? "unknown",
    [OPENCLAW_CRON_DURATION_MS]: num(event.durationMs),
    [OPENCLAW_CRON_DELIVERED]: typeof event.delivered === "boolean" ? event.delivered : undefined,
    [OPENCLAW_CRON_DELIVERY_STATUS]: firstString(event.deliveryStatus),
    [OPENCLAW_CRON_NEXT_RUN_AT_MS]: num(event.nextRunAtMs, m.nextRunAtMs),
    [OPENCLAW_CRON_SCHEDULE_KIND]: m.scheduleKind,
    [OPENCLAW_CRON_SCHEDULE_EXPR]: m.scheduleExpr,
    [OPENCLAW_CRON_SCHEDULE_EVERY_MS]: m.scheduleEveryMs,
    [OPENCLAW_CRON_SCHEDULE_TZ]: m.scheduleTz,
    [OPENCLAW_TRIGGER]: "cron",
    [GEN_AI_RESPONSE_MODEL]: firstString(event.model),
    [GEN_AI_PROVIDER_NAME]: firstString(event.provider),
    [GEN_AI_CONVERSATION_ID]: sessionKey,
    [OPENCLAW_SESSION_KEY]: sessionKey,
    // Content: agent output — only when the operator opts in.
    [OPENCLAW_CRON_SUMMARY]: capture.cronSummary ? bounded(event.summary) : undefined,
  });
}

// ── Hook registration ─────────────────────────────────────────────────────────

export interface CronHooksDeps {
  tracer: Tracer;
  store: TraceContextStore;
  /** Shared with the turn hooks (hooks.ts reads it for Phase-1 turn enrichment). */
  registry: CronRegistry;
  capture: ContentCapturePolicy;
  /** Opt-in per-firing counter, keyed by status + job_id (created only when
   *  metrics on). Incremented on `finished`. */
  cronRuns?: Counter;
  logger?: TelemetryLogger;
}

/**
 * Register the `cron_changed` + `gateway_start` gateway hooks. Returns a cleanup
 * (currently a no-op — there is no timer to clear; hooks are discarded on the
 * gateway's register-once restart). Wrapped so a telemetry failure never breaks
 * the gateway.
 */
export function registerCronHooks(api: any, deps: CronHooksDeps): () => void {
  const { tracer, store, registry, capture, cronRuns, logger } = deps;

  const on = (event: string, handler: (e: AnyEvent, ctx?: AnyEvent) => void) => {
    const wrapped = (e: AnyEvent, ctx?: AnyEvent) => {
      try {
        handler(e ?? {}, ctx);
      } catch (err) {
        logger?.warn?.(`[otel] cron hook ${event} error: ${String(err)}`);
      }
    };
    if (typeof api.on === "function") api.on(event, wrapped, { priority: 0 });
  };

  const emitDefinition = (event: AnyEvent): void => {
    const span = tracer.startSpan(
      SPAN_OPENCLAW_CRON_DEFINITION,
      { kind: SpanKind.INTERNAL, attributes: cronDefinitionAttrs(event, registry) },
      ROOT_CONTEXT,
    );
    span.end();
  };

  on("cron_changed", (event) => {
    const action = firstString(event.action);
    const job = event.job as AnyEvent | undefined;
    const jobId = firstString(event.jobId, job?.id);
    // Keep the registry current from any event that carries the job object.
    if (job && jobId) registry.upsert(jobId, metaFromJob(job));

    if (action === "removed") {
      emitDefinition(event);
      if (jobId) registry.remove(jobId);
      return;
    }
    if (action === "added" || action === "updated") {
      emitDefinition(event);
      return;
    }
    if (action === "finished") {
      // Join the just-finished turn's trace when it's still resolvable (the
      // request root is retained briefly after agent_end); else a standalone root.
      const sessionKey = firstString(event.sessionKey) ?? (jobId ? `cron:${jobId}` : undefined);
      const parent: Context | undefined = sessionKey
        ? store.resolveTurnContext(sessionKey)
        : undefined;
      const startMs = num(event.runAtMs);
      const span: Span = tracer.startSpan(
        SPAN_OPENCLAW_CRON_RUN,
        {
          kind: parent ? SpanKind.INTERNAL : SpanKind.SERVER,
          attributes: cronRunAttrs(event, registry, capture),
          ...(startMs !== undefined ? { startTime: startMs } : {}),
        },
        parent ?? ROOT_CONTEXT,
      );
      if (firstString(event.status) === "error") {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: bounded(event.error) ?? "cron run failed",
        });
      }
      const dur = num(event.durationMs);
      // Extend the span by a NON-negative duration only. A negative durationMs
      // would make end < start (the SDK then clamps to zero duration at the wrong
      // time); a missing one has no length. In both cases fall back to a point
      // span at startMs (or `now` when runAtMs is also absent).
      span.end(
        startMs !== undefined && dur !== undefined && dur >= 0 ? startMs + dur : startMs,
      );
      cronRuns?.add(1, {
        [OPENCLAW_CRON_STATUS]: firstString(event.status) ?? "unknown",
        [OPENCLAW_CRON_JOB_ID]: jobId ?? "unknown",
      });
      return;
    }
    // action === "started": registry already upserted above; the run span is
    // emitted on "finished", so nothing else to do here.
  });

  // Cold-start: seed the registry + emit a definition snapshot from the live cron
  // service so cron TURN enrichment + the "list all crons" view work from the
  // very first run, even for jobs created before the plugin loaded.
  on("gateway_start", (_event, ctx) => {
    const svc = ctx?.getCron?.();
    if (!svc || typeof svc.list !== "function") return;
    Promise.resolve(svc.list({ includeDisabled: true }))
      .then((jobs: AnyEvent[]) => {
        for (const job of jobs ?? []) {
          const jobId = firstString(job?.id);
          if (!jobId) continue;
          registry.upsert(jobId, metaFromJob(job));
          emitDefinition({ action: "added", jobId, job });
        }
        logger?.info?.(`[otel] cron registry seeded: ${registry.size} job(s)`);
      })
      .catch((err) => logger?.warn?.(`[otel] cron registry seed failed: ${String(err)}`));
  });

  return () => {
    // No timer/state to tear down; hooks are discarded on gateway restart.
  };
}
