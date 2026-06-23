// SPDX-License-Identifier: Apache-2.0

/**
 * Heartbeat lifecycle → telemetry (schema 1.6.0, config-gated default-off).
 *
 * OpenClaw runs a periodic "heartbeat" self-check per agent. Most ticks never
 * run a model turn (they're skipped — quiet-hours, no-tasks-due, contended
 * lanes, …) so the agent-turn path can't surface heartbeat HEALTH. OpenClaw
 * publishes each EMITTED tick on the `onHeartbeatEvent` in-process bus (a
 * `globalThis` singleton shared with the gateway runner), which this module
 * turns into one span:
 *
 *   - `openclaw.heartbeat.run` — one per emitted tick: status (sent / ok-token /
 *     ok-empty / skipped / failed), reason, channel, duration. A standalone
 *     INTERNAL marker (the bus event carries no session key, and the turn it may
 *     have produced is already visible via `openclaw.trigger='heartbeat'`).
 *
 * COVERAGE CAVEAT (documented, not a bug): idle/disabled/quiet-hours/
 * no-tasks-due skips early-return WITHOUT emitting a bus event, so this span
 * counts EMITTED ticks only (sent/failed + contended skips), not every wake.
 *
 * Subscription mirrors src/diagnostics.ts: a dynamic import of the host's
 * `plugin-sdk/heartbeat-runtime` barrel, with an absolute-path fallback for the
 * standalone zero-dependency install where bare `openclaw` does not resolve.
 * NO recipient/content (`to`/`accountId`/`preview`) is ever emitted.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Tracer, Counter, Attributes } from "@opentelemetry/api";
import type { TelemetryLogger } from "./telemetry";
import { pluginSdkRuntimeCandidates } from "./diagnostics";
import {
  SPAN_OPENCLAW_HEARTBEAT_RUN,
  OPENCLAW_HEARTBEAT_STATUS,
  OPENCLAW_HEARTBEAT_REASON,
  OPENCLAW_HEARTBEAT_CHANNEL,
  OPENCLAW_HEARTBEAT_DURATION_MS,
  OPENCLAW_HEARTBEAT_SILENT,
  OPENCLAW_HEARTBEAT_HAS_MEDIA,
  OPENCLAW_HEARTBEAT_INDICATOR,
  OPENCLAW_TRIGGER,
  OPENCLAW_SESSION_KEY,
  GEN_AI_CONVERSATION_ID,
} from "./semconv";

type AnyEvent = Record<string, any>;

/** A heartbeat-bus subscription primitive: takes a listener, returns unsubscribe. */
type HeartbeatSource = (listener: (evt: AnyEvent) => void) => () => void;

// ── small coercion helpers (local, mirror cron.ts/hooks.ts) ──────────────────
const firstString = (...vals: unknown[]): string | undefined => {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
};
const num = (...vals: unknown[]): number | undefined => {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
};
/** Drop undefined values — OTel setAttributes rejects them. */
const pruned = (a: Record<string, string | number | boolean | undefined>): Attributes => {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(a)) if (v !== undefined) out[k] = v;
  return out;
};

// ── Pure attribute extractor (unit-testable without a bus) ───────────────────

/**
 * Attributes for an `openclaw.heartbeat.run` span. The bus payload carries no
 * jobId/sessionKey, so the correlation keys are synthesized as `heartbeat`
 * (`heartbeat:<channel>` when a channel is present). Deliberately omits the
 * PII/content fields `to` / `accountId` / `preview`.
 */
export function heartbeatRunAttrs(event: AnyEvent): Attributes {
  const channel = firstString(event.channel);
  const corr = channel ? `heartbeat:${channel}` : "heartbeat";
  return pruned({
    [OPENCLAW_HEARTBEAT_STATUS]: firstString(event.status) ?? "unknown",
    [OPENCLAW_HEARTBEAT_REASON]: firstString(event.reason),
    [OPENCLAW_HEARTBEAT_CHANNEL]: channel,
    [OPENCLAW_HEARTBEAT_DURATION_MS]: num(event.durationMs),
    [OPENCLAW_HEARTBEAT_SILENT]:
      typeof event.silent === "boolean" ? event.silent : undefined,
    [OPENCLAW_HEARTBEAT_HAS_MEDIA]:
      typeof event.hasMedia === "boolean" ? event.hasMedia : undefined,
    [OPENCLAW_HEARTBEAT_INDICATOR]: firstString(event.indicatorType),
    [OPENCLAW_TRIGGER]: "heartbeat",
    // Correlation keys are required on every emitted span by the contract.
    [GEN_AI_CONVERSATION_ID]: corr,
    [OPENCLAW_SESSION_KEY]: corr,
  });
}

// ── Listener (pure; drive directly in tests) ─────────────────────────────────

export interface HeartbeatDeps {
  tracer: Tracer;
  /** Opt-in per-tick counter, keyed by status (created only when metrics on). */
  heartbeatRuns?: Counter;
  /** Override for "now" (ms) — injected by tests for deterministic timing. */
  now?: () => number;
  logger?: TelemetryLogger;
}

/**
 * Build the heartbeat-bus listener: emits one `openclaw.heartbeat.run` span (and
 * increments the opt-in counter) per tick. Pure (no bus I/O); exported so tests
 * drive it without the dynamic SDK import. The bus calls listeners SYNCHRONOUSLY
 * before the next tick, so this is cheap and never throws.
 */
export function makeHeartbeatListener(deps: HeartbeatDeps): (evt: AnyEvent) => void {
  const { tracer, heartbeatRuns, logger } = deps;
  const now = deps.now ?? Date.now;
  return (evt) => {
    try {
      const event = evt ?? {};
      const status = firstString(event.status) ?? "unknown";
      const endMs = num(event.ts) ?? now();
      const dur = num(event.durationMs);
      // Only a NON-negative duration backs the start off from `endMs`. A negative
      // durationMs (clock skew / malformed event) would make start > end, which
      // the SDK silently clamps to a zero-duration span at the wrong time. Mirror
      // diagnostics.ts's `durationMs >= 0` guard.
      const startMs = dur !== undefined && dur >= 0 ? endMs - dur : endMs;
      const span = tracer.startSpan(
        SPAN_OPENCLAW_HEARTBEAT_RUN,
        { kind: SpanKind.INTERNAL, attributes: heartbeatRunAttrs(event), startTime: startMs },
        ROOT_CONTEXT,
      );
      if (status === "failed") {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: firstString(event.reason) ?? "heartbeat failed",
        });
      }
      span.end(endMs);
      heartbeatRuns?.add(1, { [OPENCLAW_HEARTBEAT_STATUS]: status });
    } catch (err) {
      // A heartbeat-bus listener must never throw — it would block the next tick.
      logger?.warn?.(`[otel] heartbeat listener error: ${String(err)}`);
    }
  };
}

// ── Source resolution (mirror src/diagnostics.ts) ────────────────────────────

/**
 * Resolve OpenClaw's `onHeartbeatEvent` bus subscriber. Tried in order:
 *   1. bare `openclaw/plugin-sdk/heartbeat-runtime` (resolves when the host makes
 *      `openclaw` bare-importable from the plugin — dev/test, some loaders);
 *   2. the same barrel by ABSOLUTE PATH via the gateway entry — required for a
 *      standalone zero-dependency install where bare `openclaw` does not resolve.
 * Returns null (→ no-op) if neither resolves.
 */
async function loadHeartbeatSource(): Promise<HeartbeatSource | null> {
  // 1. Bare subpath (bare-resolvable contexts).
  try {
    const rt = (await import("openclaw/plugin-sdk/heartbeat-runtime")) as {
      onHeartbeatEvent?: unknown;
    };
    if (typeof rt.onHeartbeatEvent === "function") {
      return rt.onHeartbeatEvent as HeartbeatSource;
    }
  } catch {
    /* subpath not bare-resolvable from a standalone install — try absolute path */
  }

  // 2. By absolute path, located via the gateway entry.
  for (const cand of pluginSdkRuntimeCandidates(process.argv[1], "heartbeat-runtime.js")) {
    if (!existsSync(cand)) continue;
    try {
      const rt = (await import(pathToFileURL(cand).href)) as {
        onHeartbeatEvent?: unknown;
      };
      if (typeof rt.onHeartbeatEvent === "function") {
        return rt.onHeartbeatEvent as HeartbeatSource;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Subscribe to OpenClaw's heartbeat-event bus and emit `openclaw.heartbeat.run`
 * spans. Returns an unsubscribe function. If the SDK is unavailable, logs once
 * and returns a no-op (heartbeat telemetry is simply absent, never fatal).
 * Call ONLY when `config.heartbeat` is enabled.
 */
export async function initHeartbeat(deps: HeartbeatDeps): Promise<() => void> {
  const source = await loadHeartbeatSource();
  if (!source) {
    deps.logger?.warn?.(
      "[otel] OpenClaw heartbeat bus unavailable — openclaw.heartbeat.run spans disabled",
    );
    return () => {};
  }
  try {
    const unsubscribe = source(makeHeartbeatListener(deps));
    deps.logger?.info?.("[otel] subscribed to OpenClaw heartbeat bus (openclaw.heartbeat.run)");
    return typeof unsubscribe === "function" ? unsubscribe : () => {};
  } catch (err) {
    // A throwing subscribe must not reject init or break register(); degrade.
    deps.logger?.warn?.(`[otel] heartbeat subscription failed: ${String(err)}`);
    return () => {};
  }
}
