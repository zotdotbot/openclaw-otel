// SPDX-License-Identifier: Apache-2.0

/**
 * Diagnostic-event integration: enrich the agent turn with accurate token/cost
 * data from OpenClaw's `model.usage` diagnostic, and emit the one consumer-read
 * metric (`openclaw.session.stalled`).
 *
 * The `model.usage` event can arrive AFTER `agent_end` has fired (it loses the
 * race). So the turn span is "held open": at agent_end the hook hands it to the
 * {@link UsageCoordinator}, which parks it with its recorded end time until
 * either the usage event arrives (enrich, then end with the recorded time) or a
 * grace period expires (end unenriched). Token data stays accurate without
 * distorting the turn's duration.
 *
 * `model.usage` is an INTERNAL diagnostic, delivered by `onInternalDiagnosticEvent`
 * from `openclaw/plugin-sdk/diagnostic-runtime` (the public `onDiagnosticEvent`
 * does not carry it). A standalone, zero-dependency install cannot resolve the
 * bare `openclaw` specifier from its own directory, so we also locate the host
 * barrel by ABSOLUTE PATH via the gateway entry (`process.argv[1]`, a shared
 * process) — see {@link diagnosticRuntimeCandidates}. If nothing resolves we
 * degrade gracefully to event-payload usage only.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Span, Counter, Histogram, Tracer } from "@opentelemetry/api";
import type { TraceContextStore } from "./trace-context-store";
import {
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_TOKEN_TYPE,
  OPENCLAW_LLM_COST_USD,
  OPENCLAW_SESSION_KEY,
  OPENCLAW_TOOL_NAME,
  SPAN_OPENCLAW_SKILL_USED,
  OPENCLAW_SKILL_NAME,
  OPENCLAW_SKILL_SOURCE,
  OPENCLAW_SKILL_ACTIVATION,
  TOKEN_TYPE_INPUT,
  TOKEN_TYPE_OUTPUT,
  TOKEN_TYPE_CACHE_READ,
  TOKEN_TYPE_CACHE_CREATION,
  SPAN_OPENCLAW_CONTEXT_ASSEMBLED,
  SPAN_OPENCLAW_HARNESS_RUN,
  SPAN_OPENCLAW_MESSAGE_PROCESSED,
  SPAN_OPENCLAW_MESSAGE_DELIVERY,
  OPENCLAW_OUTCOME,
  OPENCLAW_REASON,
  OPENCLAW_CHANNEL,
  OPENCLAW_DELIVERY_KIND,
  OPENCLAW_DELIVERY_RESULT_COUNT,
  OPENCLAW_CONTEXT_PROMPT_CHARS,
  OPENCLAW_CONTEXT_SYSTEM_PROMPT_CHARS,
  OPENCLAW_CONTEXT_MESSAGE_COUNT,
  OPENCLAW_CONTEXT_HISTORY_TEXT_CHARS,
  OPENCLAW_CONTEXT_TOKEN_BUDGET,
  OPENCLAW_HARNESS_ITEMS_STARTED,
  OPENCLAW_HARNESS_ITEMS_COMPLETED,
  OPENCLAW_HARNESS_ITEMS_ACTIVE,
  OPENCLAW_HARNESS_RESULT_CLASSIFICATION,
} from "./semconv";

/** How long agent_end holds a turn span open awaiting its model.usage event. */
export const AWAITING_USAGE_GRACE_MS = 10_000;
/**
 * How long a usage that arrives BEFORE its agent_end stays claimable. Kept ==
 * the grace window so a pending entry can't outlive the turn it belongs to and
 * get mis-attributed to a later turn in the same (serialized) session.
 */
export const PENDING_USAGE_TTL_MS = 10_000;

type AnyEvent = Record<string, any>;

const firstString = (...vals: unknown[]): string | undefined => {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
};
const num = (...vals: unknown[]): number | undefined => {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
};

export interface UsageData {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number;
  model?: string;
}

/**
 * Apply token/cost usage onto a turn span (diagnostic data overrides any
 * event-payload baseline the hook already set).
 *
 * INVARIANT — overwrite, do NOT sum. OpenClaw emits exactly ONE `model.usage`
 * per turn, carrying the per-turn AGGREGATE: it fires once in the run's
 * finalization (not in the tool-use loop) with the final assistant message's
 * usage, whose `input_tokens` already accounts for the whole conversation. So a
 * straight `setAttributes` overwrite is correct and matches the upstream fork's
 * value byte-for-byte; summing successive usages would double-count. This holds
 * only while emission stays one-aggregate-per-turn (verified on OpenClaw
 * 2026.5.28, agent-runner finalization). If a future version switched to
 * per-call emission, this would silently keep the LAST call instead of the
 * total — guard via the OpenClaw-drift check, not by summing here.
 */
export function enrichSpanWithUsage(span: Span, usage: UsageData): void {
  const set: Record<string, number | string> = {};
  if (usage.input !== undefined) set[GEN_AI_USAGE_INPUT_TOKENS] = usage.input;
  if (usage.output !== undefined) set[GEN_AI_USAGE_OUTPUT_TOKENS] = usage.output;
  if (usage.cacheRead !== undefined && usage.cacheRead > 0) {
    set[GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS] = usage.cacheRead;
  }
  if (usage.cacheWrite !== undefined && usage.cacheWrite > 0) {
    set[GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS] = usage.cacheWrite;
  }
  if (usage.model) set[GEN_AI_RESPONSE_MODEL] = usage.model;
  if (usage.costUsd !== undefined && usage.costUsd > 0) {
    set[OPENCLAW_LLM_COST_USD] = usage.costUsd;
  }
  span.setAttributes(set);
}

/** End a parked turn span, swallowing an already-ended / provider-gone throw.
 *  Used on every parked-span end path (immediate, fast-followup, grace timer,
 *  flush) so they are uniformly defensive — the detached timer in particular has
 *  no caller to catch a throw. */
function endSpanQuietly(span: Span, endTime?: number): void {
  try {
    span.end(endTime);
  } catch {
    // already ended / provider gone — nothing to do
  }
}

/**
 * Record the standard GenAI token-usage histogram, one observation per token
 * type (input/output/cache_read/cache_creation). Emitted for external
 * dashboards; the consumer does not read it. No-op without an instrument.
 */
export function recordTokenUsage(histogram: Histogram | undefined, usage: UsageData): void {
  if (!histogram) return;
  const base = usage.model ? { [GEN_AI_RESPONSE_MODEL]: usage.model } : {};
  // Record a point per token type only for known, positive counts — skip
  // undefined AND 0 uniformly across all four types (a 0-token observation is
  // just noise, and consistency matters).
  const rec = (value: number | undefined, tokenType: string) => {
    if (value !== undefined && value > 0) {
      histogram.record(value, { ...base, [GEN_AI_TOKEN_TYPE]: tokenType });
    }
  };
  rec(usage.input, TOKEN_TYPE_INPUT);
  rec(usage.output, TOKEN_TYPE_OUTPUT);
  rec(usage.cacheRead, TOKEN_TYPE_CACHE_READ);
  rec(usage.cacheWrite, TOKEN_TYPE_CACHE_CREATION);
}

/** Pull `{ key, usage }` out of a `model.usage` diagnostic event. */
export function extractUsageFromEvent(
  evt: AnyEvent,
): { key: string; usage: UsageData } | undefined {
  if (evt?.type !== "model.usage") return undefined;
  const u: AnyEvent = evt.usage ?? {};
  return {
    key: firstString(evt.sessionKey) ?? "unknown",
    usage: {
      input: num(u.input, u.inputTokens, u.input_tokens),
      output: num(u.output, u.outputTokens, u.output_tokens),
      cacheRead: num(u.cacheRead, u.cacheReadInputTokens, u.cache_read),
      cacheWrite: num(u.cacheWrite, u.cacheCreationInputTokens, u.cache_creation),
      costUsd: num(evt.costUsd, evt.cost),
      model: firstString(evt.model, u.model),
    },
  };
}

export interface SkillUsedData {
  sessionKey: string;
  skillName: string;
  skillSource: string;
  activation?: string;
  toolName?: string;
  /** Diagnostic timestamp (ms); used as the span's start so the consumer sees
   *  real activation ordering for its per-skill window attribution. */
  ts?: number;
}

/** Pull skill fields out of a `skill.used` internal diagnostic event. Skills are
 *  NOT exposed via a plugin hook on 2026.5.28 — this internal diagnostic is the
 *  only signal. `skillSource` defaults to `unknown` (the built-in's enum value)
 *  so the contract's required attribute is always present. */
export function extractSkillFromEvent(evt: AnyEvent): SkillUsedData | undefined {
  if (evt?.type !== "skill.used") return undefined;
  return {
    sessionKey: firstString(evt.sessionKey) ?? "unknown",
    skillName: firstString(evt.skillName) ?? "skill",
    skillSource: firstString(evt.skillSource) ?? "unknown",
    activation: firstString(evt.activation),
    toolName: firstString(evt.toolName),
    ts: num(evt.ts),
  };
}

/**
 * Emit an `openclaw.skill.used` span parented to the session's live trace
 * context (resolveContext by session key), mirroring the built-in
 * diagnostics.otel skill span so the consumer's `skill_usage()` reads it unchanged.
 * A ~0-duration marker started at the diagnostic timestamp.
 */
export function emitSkillUsedSpan(
  tracer: Tracer,
  store: TraceContextStore,
  skill: SkillUsedData,
  now: () => number,
): void {
  // Only the instance that actually ran the turn has its trace context; the other
  // (gateway vs embedded runner) skips rather than orphaning a duplicate.
  const parent = store.resolveTurnContext(skill.sessionKey);
  if (!parent) return;
  // Clamp the diagnostic timestamp into [turn start, now] so the marker sorts
  // AFTER its parent root: the consumer attributes activity to skills by start
  // time, and a ts that precedes the turn (clock skew, an early-resolved skill)
  // would shift its t0/window math. Falls back to `now` when ts is absent.
  const current = now();
  const floor =
    store.getAgentTurn(skill.sessionKey)?.startedAt ??
    store.getRequest(skill.sessionKey)?.startedAt;
  let ts = skill.ts ?? current;
  if (ts > current) ts = current;
  if (floor !== undefined && ts < floor) ts = floor;
  const attributes: Record<string, string> = {
    [OPENCLAW_SESSION_KEY]: skill.sessionKey,
    [GEN_AI_CONVERSATION_ID]: skill.sessionKey,
    [OPENCLAW_SKILL_NAME]: skill.skillName,
    [OPENCLAW_SKILL_SOURCE]: skill.skillSource,
  };
  if (skill.activation) attributes[OPENCLAW_SKILL_ACTIVATION] = skill.activation;
  if (skill.toolName) attributes[OPENCLAW_TOOL_NAME] = skill.toolName;
  const span = tracer.startSpan(
    SPAN_OPENCLAW_SKILL_USED,
    { kind: SpanKind.INTERNAL, startTime: ts, attributes },
    parent,
  );
  span.end(ts);
}

// ── Re-homed operational spans ───────────────────────────────────────────────
// context.assembled / harness.run / message.processed / message.delivery carry
// operational signal the plugin's connected convention lacks. They have NO plugin
// hook, so we synthesize them from the internal diagnostic stream and PARENT them
// into the live turn trace. Their consumer roles (ROLE_CONTEXT / ROLE_OTHER) don't
// collide with the plugin's model/tool/root spans, so this adds signal WITHOUT
// double-counting model calls or tool calls (which re-homing model.call/exec would).

/** A diagnostic-derived span to synthesize into the live turn trace. */
export interface DiagnosticSpanData {
  spanName: string;
  sessionKey: string;
  /** Diagnostic end timestamp (ms). */
  ts?: number;
  /** Span duration (ms); when present, start = end - durationMs (point marker otherwise). */
  durationMs?: number;
  attributes: Record<string, string | number | boolean>;
  /** When set, the span status is ERROR with this message. */
  errorMessage?: string;
}

/**
 * Map a `context.assembled` / `harness.run.*` / `message.processed` /
 * `message.delivery.*` internal diagnostic event into a {@link DiagnosticSpanData}.
 * Attribute names mirror the built-in `diagnostics.otel` exactly, so the consumer
 * reads them unchanged. Returns undefined for any other event (or one lacking a
 * sessionKey to parent by).
 */
export function extractDiagnosticSpan(evt: AnyEvent): DiagnosticSpanData | undefined {
  const sessionKey = firstString(evt?.sessionKey);
  if (!sessionKey) return undefined;
  const ts = num(evt.ts);
  const durationMs = num(evt.durationMs);
  const attrs: Record<string, string | number | boolean> = {};
  const setNum = (k: string, v: number | undefined) => {
    if (v !== undefined) attrs[k] = v;
  };
  const setStr = (k: string, v: string | undefined) => {
    if (v !== undefined) attrs[k] = v;
  };

  switch (evt?.type) {
    case "context.assembled": {
      setNum(OPENCLAW_CONTEXT_PROMPT_CHARS, num(evt.promptChars));
      setNum(OPENCLAW_CONTEXT_SYSTEM_PROMPT_CHARS, num(evt.systemPromptChars));
      setNum(OPENCLAW_CONTEXT_MESSAGE_COUNT, num(evt.messageCount));
      setNum(OPENCLAW_CONTEXT_HISTORY_TEXT_CHARS, num(evt.historyTextChars));
      setNum(OPENCLAW_CONTEXT_TOKEN_BUDGET, num(evt.contextTokenBudget));
      return { spanName: SPAN_OPENCLAW_CONTEXT_ASSEMBLED, sessionKey, ts, attributes: attrs };
    }
    case "harness.run.completed":
    case "harness.run.error": {
      const il: AnyEvent = evt.itemLifecycle ?? {};
      setNum(OPENCLAW_HARNESS_ITEMS_STARTED, num(il.startedCount));
      setNum(OPENCLAW_HARNESS_ITEMS_COMPLETED, num(il.completedCount));
      setNum(OPENCLAW_HARNESS_ITEMS_ACTIVE, num(il.activeCount));
      setStr(OPENCLAW_HARNESS_RESULT_CLASSIFICATION, firstString(evt.resultClassification));
      const isErr = evt.type === "harness.run.error";
      setStr(OPENCLAW_OUTCOME, firstString(evt.outcome) ?? (isErr ? "error" : undefined));
      return {
        spanName: SPAN_OPENCLAW_HARNESS_RUN, sessionKey, ts, durationMs, attributes: attrs,
        errorMessage: isErr ? firstString(evt.errorCategory) ?? "error" : undefined,
      };
    }
    case "message.processed": {
      setStr(OPENCLAW_CHANNEL, firstString(evt.channel));
      const outcome = firstString(evt.outcome);
      setStr(OPENCLAW_OUTCOME, outcome);
      setStr(OPENCLAW_REASON, firstString(evt.reason));
      return {
        spanName: SPAN_OPENCLAW_MESSAGE_PROCESSED, sessionKey, ts, durationMs, attributes: attrs,
        errorMessage: outcome === "error" ? firstString(evt.reason) ?? "error" : undefined,
      };
    }
    case "message.delivery.completed":
    case "message.delivery.error": {
      const isErr = evt.type === "message.delivery.error";
      setStr(OPENCLAW_CHANNEL, firstString(evt.channel));
      setStr(OPENCLAW_DELIVERY_KIND, firstString(evt.deliveryKind));
      setNum(OPENCLAW_DELIVERY_RESULT_COUNT, num(evt.resultCount));
      setStr(OPENCLAW_OUTCOME, isErr ? "error" : firstString(evt.outcome) ?? "completed");
      return {
        spanName: SPAN_OPENCLAW_MESSAGE_DELIVERY, sessionKey, ts, durationMs, attributes: attrs,
        errorMessage: isErr ? firstString(evt.errorCategory) ?? "error" : undefined,
      };
    }
    default:
      return undefined;
  }
}

/**
 * Emit a re-homed diagnostic span, parented to the session's live (or just-
 * completed, via the store's retained root) turn trace. Timestamps clamp into
 * [turn start, now]: a span with a duration covers [end - durationMs, end]; a
 * point event is a ~0-duration marker at `end`.
 */
export function emitDiagnosticSpan(
  tracer: Tracer,
  store: TraceContextStore,
  data: DiagnosticSpanData,
  now: () => number,
): void {
  // Emit only in the instance that holds this turn's trace (agentTurn / request /
  // retained completed root); the other observer of the diagnostic stream skips,
  // so the span isn't duplicated as an orphan onto the session/gateway root.
  const parent = store.resolveTurnContext(data.sessionKey);
  if (!parent) return;
  const current = now();
  const floor =
    store.getAgentTurn(data.sessionKey)?.startedAt ??
    store.getRequest(data.sessionKey)?.startedAt;
  let end = data.ts ?? current;
  if (end > current) end = current;
  if (floor !== undefined && end < floor) end = floor;
  let start = end;
  if (data.durationMs !== undefined && data.durationMs >= 0) {
    start = end - data.durationMs;
    if (floor !== undefined && start < floor) start = floor;
  }
  const attributes: Record<string, string | number | boolean> = {
    [OPENCLAW_SESSION_KEY]: data.sessionKey,
    [GEN_AI_CONVERSATION_ID]: data.sessionKey,
    ...data.attributes,
  };
  const span = tracer.startSpan(
    data.spanName,
    { kind: SpanKind.INTERNAL, startTime: start, attributes },
    parent,
  );
  if (data.errorMessage) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: data.errorMessage });
  }
  span.end(end);
}

/**
 * Coordinates the held-open turn span between `agent_end` (the hook) and the
 * `model.usage` diagnostic. Single-threaded; no locking needed.
 */
export class UsageCoordinator {
  private armed = true;
  private readonly parked = new Map<
    string,
    { span: Span; endTime: number; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly pending = new Map<string, { usage: UsageData; at: number }>();

  constructor(
    private readonly opts: {
      graceMs?: number;
      pendingTtlMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * Called by `agent_end`. If `model.usage` already arrived for this turn,
   * enrich and end immediately; otherwise PARK the span (held open) until the
   * usage event lands or the grace period expires. When the coordinator is
   * disarmed (no diagnostics SDK), end immediately — nothing will ever enrich it.
   */
  handleTurnEnd(key: string, span: Span, endTime: number): void {
    if (!this.armed) {
      endSpanQuietly(span, endTime);
      return;
    }
    const ttl = this.opts.pendingTtlMs ?? PENDING_USAGE_TTL_MS;
    const p = this.pending.get(key);
    if (p) {
      this.pending.delete(key);
      if (this.now() - p.at <= ttl) {
        enrichSpanWithUsage(span, p.usage);
        endSpanQuietly(span, endTime);
        return;
      }
    }
    // A turn for this session is already parked (a fast follow-up landed a
    // second agent_end within the grace window): close it NOW so it is neither
    // leaked nor cross-deleted by the stale timer below.
    const prev = this.parked.get(key);
    if (prev) {
      clearTimeout(prev.timer);
      this.parked.delete(key);
      endSpanQuietly(prev.span, prev.endTime);
    }
    const timer = setTimeout(() => {
      // Identity-guard: only evict OUR entry, never a newer turn's that may have
      // replaced it under the same key.
      if (this.parked.get(key)?.timer === timer) this.parked.delete(key);
      endSpanQuietly(span, endTime); // grace expired — end unenriched
    }, this.opts.graceMs ?? AWAITING_USAGE_GRACE_MS);
    if (typeof timer.unref === "function") timer.unref();
    this.parked.set(key, { span, endTime, timer });
  }

  /** Called when a `model.usage` diagnostic arrives. */
  onUsage(key: string, usage: UsageData): void {
    const parked = this.parked.get(key);
    if (parked) {
      clearTimeout(parked.timer);
      this.parked.delete(key);
      enrichSpanWithUsage(parked.span, usage);
      endSpanQuietly(parked.span, parked.endTime);
      return;
    }
    // Usage beat agent_end — stash it (claimed by the next handleTurnEnd), and
    // drop any pending that has aged past the TTL so the map stays bounded even
    // if some turns never reach agent_end.
    this.pending.set(key, { usage, at: this.now() });
    this.prunePending();
  }

  private prunePending(): void {
    const cutoff = this.now() - (this.opts.pendingTtlMs ?? PENDING_USAGE_TTL_MS);
    for (const [k, v] of this.pending) if (v.at < cutoff) this.pending.delete(k);
  }

  /** Stop parking (no diagnostics SDK): end any parked spans now and end
   *  subsequent turns immediately. */
  disarm(): void {
    this.armed = false;
    this.flushParked();
  }

  /** End any still-parked spans (plugin shutdown). */
  shutdown(): void {
    this.flushParked();
    this.pending.clear();
  }

  private flushParked(): void {
    for (const { span, endTime, timer } of this.parked.values()) {
      clearTimeout(timer);
      endSpanQuietly(span, endTime);
    }
    this.parked.clear();
  }
}

export interface DiagnosticsLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface DiagnosticsDeps {
  coordinator: UsageCoordinator;
  /** The `openclaw.session.stalled` counter (the one consumer-read metric). */
  sessionStalled: Counter;
  /** Optional `gen_ai.client.token.usage` histogram (external dashboards). */
  tokenUsage?: Histogram;
  /** Optional sink that turns each diagnostic event into an OTel LogRecord
   *  (wired when config.logs is on). */
  emitLog?: (event: Record<string, unknown>) => void;
  /** Tracer + store to emit `openclaw.skill.used` spans from the `skill.used`
   *  diagnostic (skills have no plugin hook). BOTH are required for skill spans;
   *  if either is absent, skill events are simply not turned into spans. */
  tracer?: Tracer;
  store?: TraceContextStore;
  /** Override for "now" (ms) — injected by tests for determinism. */
  now?: () => number;
  logger?: DiagnosticsLogger;
}

/**
 * Build the diagnostic-event listener: routes `model.usage` to the coordinator,
 * `session.stalled`/`session.stuck` to the counter, and `skill.used` to an
 * `openclaw.skill.used` span. Pure (no I/O); exported so tests can drive it
 * without the dynamic SDK import. The optional log bridge runs first and is
 * isolated so a logging failure can't skip core handling.
 */
export function makeDiagnosticListener(deps: DiagnosticsDeps): (evt: AnyEvent) => void {
  const now = deps.now ?? Date.now;
  return (evt) => {
    try {
      if (deps.emitLog) {
        try {
          deps.emitLog(evt);
        } catch {
          /* log bridge failure — ignore */
        }
      }
      if (evt?.type === "model.usage") {
        const ex = extractUsageFromEvent(evt);
        if (ex) {
          deps.coordinator.onUsage(ex.key, ex.usage);
          recordTokenUsage(deps.tokenUsage, ex.usage);
        }
      } else if (evt?.type === "session.stalled" || evt?.type === "session.stuck") {
        deps.sessionStalled.add(1, {
          [OPENCLAW_SESSION_KEY]: firstString(evt.sessionKey) ?? "unknown",
        });
      } else if (evt?.type === "skill.used" && deps.tracer && deps.store) {
        const skill = extractSkillFromEvent(evt);
        if (skill) emitSkillUsedSpan(deps.tracer, deps.store, skill, now);
      } else if (deps.tracer && deps.store) {
        // context.assembled / harness.run.* / message.processed / message.delivery.*
        // → operational spans parented into the turn trace (no-op for other types).
        const ds = extractDiagnosticSpan(evt);
        if (ds) emitDiagnosticSpan(deps.tracer, deps.store, ds, now);
      }
    } catch {
      // A diagnostics listener must never break the gateway.
    }
  };
}

type DiagnosticSource = (listener: (evt: AnyEvent) => void) => () => void;

/**
 * Absolute-path candidates for a host `plugin-sdk/<barrel>.js` barrel, derived
 * from the gateway entry (`process.argv[1]`). The plugin runs in the gateway's
 * process, so its entry locates the gateway's compiled `dist` — the only way to
 * reach an internal SDK barrel when the plugin is installed standalone (no
 * `node_modules/openclaw` on the bare-specifier resolution path from the plugin
 * directory). Walks up a few levels and, at each, tries both
 * `<dir>/dist/plugin-sdk/<barrel>.js` (entry at the package root, e.g.
 * `/app/openclaw.mjs` → `/app/dist/…`) and `<dir>/plugin-sdk/<barrel>.js`
 * (entry already inside `dist`). Shared by the diagnostic + heartbeat sources.
 * Exported for testing.
 */
export function pluginSdkRuntimeCandidates(
  entry: string | undefined,
  barrelFile: string,
): string[] {
  if (!entry) return [];
  let real: string;
  try {
    real = realpathSync(resolve(entry));
  } catch {
    real = resolve(entry);
  }
  const tail = join("plugin-sdk", barrelFile);
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  let dir = dirname(real);
  for (let i = 0; i < 5 && dir && dir !== dirname(dir); i++) {
    add(join(dir, "dist", tail));
    add(join(dir, tail));
    dir = dirname(dir);
  }
  return out;
}

/** Absolute-path candidates for `plugin-sdk/diagnostic-runtime`. Thin wrapper
 *  over {@link pluginSdkRuntimeCandidates}; exported for testing. */
export function diagnosticRuntimeCandidates(entry: string | undefined): string[] {
  return pluginSdkRuntimeCandidates(entry, "diagnostic-runtime.js");
}

/**
 * Resolve OpenClaw's diagnostic event source. `model.usage` is an INTERNAL
 * diagnostic carried by `onInternalDiagnosticEvent`. Tried in order:
 *   1. bare `openclaw/plugin-sdk/diagnostic-runtime` (resolves when the host
 *      makes `openclaw` bare-importable from the plugin — dev/test, some loaders);
 *   2. the same barrel by ABSOLUTE PATH via the gateway entry — required for a
 *      standalone zero-dependency install where bare `openclaw` does not resolve
 *      from the plugin directory;
 *   3. the public `openclaw/plugin-sdk` `onDiagnosticEvent` as a last resort.
 * Returns null (→ graceful event-payload fallback) if none resolve.
 */
async function loadDiagnosticSource(): Promise<DiagnosticSource | null> {
  // 1. Internal source via the host SDK subpath (bare-resolvable contexts).
  try {
    const rt = (await import("openclaw/plugin-sdk/diagnostic-runtime")) as {
      onInternalDiagnosticEvent?: unknown;
    };
    if (typeof rt.onInternalDiagnosticEvent === "function") {
      return rt.onInternalDiagnosticEvent as DiagnosticSource;
    }
  } catch {
    /* subpath not bare-resolvable from a standalone install — try absolute path */
  }

  // 2. Internal source by absolute path, located via the gateway entry.
  for (const cand of diagnosticRuntimeCandidates(process.argv[1])) {
    if (!existsSync(cand)) continue;
    try {
      const rt = (await import(pathToFileURL(cand).href)) as {
        onInternalDiagnosticEvent?: unknown;
      };
      if (typeof rt.onInternalDiagnosticEvent === "function") {
        return rt.onInternalDiagnosticEvent as DiagnosticSource;
      }
    } catch {
      /* try the next candidate */
    }
  }

  // 3. Public diagnostic source — last resort; may not carry model.usage.
  try {
    const sdk = await import("openclaw/plugin-sdk");
    const fn = sdk.onDiagnosticEvent;
    if (typeof fn === "function") return fn as DiagnosticSource;
  } catch {
    /* not resolvable */
  }
  return null;
}

/**
 * Subscribe to OpenClaw diagnostics: route `model.usage` to the coordinator and
 * `session.stalled`/`session.stuck` to the counter. Returns an unsubscribe
 * function. If the SDK is unavailable, disarms the coordinator (turns end
 * immediately on event-payload usage) and returns a no-op.
 */
export async function initDiagnostics(deps: DiagnosticsDeps): Promise<() => void> {
  const source = await loadDiagnosticSource();
  if (!source) {
    deps.coordinator.disarm();
    deps.logger?.warn?.(
      "[otel] OpenClaw diagnostics SDK unavailable — token rollup uses event-payload usage only",
    );
    return () => {};
  }
  const unsubscribe = source(makeDiagnosticListener(deps));
  deps.logger?.info?.(
    "[otel] subscribed to OpenClaw diagnostics (model.usage, session.stalled/stuck, skill.used, " +
      "context.assembled, harness.run, message.processed, message.delivery)",
  );
  return typeof unsubscribe === "function" ? unsubscribe : () => {};
}
