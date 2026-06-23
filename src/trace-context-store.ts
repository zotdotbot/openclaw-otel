// SPDX-License-Identifier: Apache-2.0

/**
 * Tiered trace-context store.
 *
 * Because the plugin never registers a global OTel context manager (see
 * telemetry.ts), it cannot rely on `context.active()` to find a span's parent.
 * Instead it threads context explicitly: hooks stash the live span + Context at
 * the right tier here, and child-span creation looks the parent up by session
 * key. This is what stitches a turn into one connected trace
 * (`openclaw.request` → `openclaw.agent.turn` → `chat *` / `execute_tool *`).
 *
 * Tiers, longest-lived first:
 *   1. gateway   — the gateway process lifetime (at most one)
 *   2. session   — one per conversation (may span many requests)
 *   3. request   — one per inbound message → agent_end cycle
 *   4. agentTurn — one per model-resolve → agent_end cycle
 *   5. cronJob   — one per cron execution
 *
 * Parent lookup order for a new child span: agentTurn → request → session →
 * gateway (see {@link TraceContextStore.resolveContext}).
 *
 * NOTE on what the CURRENT hooks populate: the store is a general tiered
 * abstraction (all five tiers are implemented and unit-tested), but the
 * OpenClaw 2026.5.28 hook set only stashes span context into the request and
 * agentTurn tiers (plus the briefly-retained completedRoot). It calls
 * `setSession` without a span/context, and never `setGateway`/`setCronJob`. So
 * the parent chain that actually resolves in production is
 * agentTurn → request → completedRoot; the session/gateway/cron rungs are
 * structural fallbacks awaiting (or guarding against) hooks that populate them.
 *
 * KEYING CONTRACT. The `key` passed to the request, agentTurn and tool tiers
 * must UNIQUELY identify one in-flight unit. If a single session can have
 * concurrent in-flight requests/turns, the caller MUST use a composite key
 * `${sessionKey}${SESSION_KEY_SEPARATOR}${requestId}` for those tiers and pass
 * that same key to {@link TraceContextStore.resolveContext} — keying solely by
 * session id would let concurrent requests overwrite each other's context.
 * resolveContext/resolveParentSpan split composite keys on
 * {@link SESSION_KEY_SEPARATOR} to recover the base session key for the
 * session-tier fallback, so the fallback chain stays intact. The session and
 * gateway tiers are stored under stable keys (the session key / a singleton). This store is
 * a plain in-memory structure with no locking; correctness relies on this
 * keying discipline, not on synchronization (Node is single-threaded, so the
 * only hazard is logical key collision, which unique keys prevent).
 */

import { SpanStatusCode } from "@opentelemetry/api";
import type { Context, Span } from "@opentelemetry/api";

/**
 * Separator between a session key and a per-in-flight discriminator in a
 * composite key (e.g. `agent:1:slack#req-42`). {@link TraceContextStore.resolveContext}
 * and {@link TraceContextStore.resolveParentSpan} split on the FIRST occurrence
 * to recover the base session key when falling back to the session tier.
 * Callers composing keys for the request/turn/tool tiers MUST use this separator.
 */
export const SESSION_KEY_SEPARATOR = "#";

/** Recover the base session key from a (possibly composite) tier key. */
function baseSessionKey(key: string): string {
  const i = key.indexOf(SESSION_KEY_SEPARATOR);
  return i === -1 ? key : key.slice(0, i);
}

// ── Tier shapes ───────────────────────────────────────────────────────────

export interface GatewayContext {
  span: Span;
  context: Context;
  startedAt: number;
}

export interface SessionContext {
  span?: Span;
  context?: Context;
  startedAt: number;
  requestCount: number;
  channel?: string;
  /** Last time a request/turn touched this session. Used by
   *  {@link TraceContextStore.sweepIdleSessions} to evict idle conversations
   *  without dropping active ones. Falls back to `startedAt` when unset. */
  lastActivityAt?: number;
}

export interface RequestContext {
  rootSpan: Span;
  rootContext: Context;
  startedAt: number;
  /** Last time an in-turn signal (model-call start, tool start/result) touched
   *  this request. {@link TraceContextStore.sweepStale} ages entries on this,
   *  falling back to `startedAt` when unset, so a turn still doing work is not
   *  force-ended on its start time alone. */
  lastActivityAt?: number;
}

export interface AgentTurnContext {
  span: Span;
  context: Context;
  startedAt: number;
  /** Optional in-flight model-call span tracking (set by hooks). */
  modelCallSpan?: Span;
  modelCallStartTime?: number;
  /** Liveness timestamp; see {@link RequestContext.lastActivityAt}. */
  lastActivityAt?: number;
}

export interface CronJobContext {
  span: Span;
  context: Context;
  jobName: string;
  startedAt: number;
}

/** An in-flight tool span, keyed by tool-call id. */
export interface ActiveToolSpan {
  span: Span;
  startTime: number;
  approvalRequested?: boolean;
  approvalResolvedAt?: number;
  /** Liveness timestamp; see {@link RequestContext.lastActivityAt}. Aged by
   *  {@link TraceContextStore.sweepStale}, falling back to `startTime`. */
  lastActivityAt?: number;
}

// ── Store ───────────────────────────────────────────────────────────────────

export class TraceContextStore {
  private gateway: GatewayContext | null = null;
  private readonly sessions = new Map<string, SessionContext>();
  private readonly requests = new Map<string, RequestContext>();
  private readonly agentTurns = new Map<string, AgentTurnContext>();
  private readonly cronJobs = new Map<string, CronJobContext>();
  private readonly toolSpans = new Map<string, ActiveToolSpan>();
  // A request root retained briefly AFTER its turn ends, so late-arriving spans
  // (the outbound message.sent, and re-homed end-of-turn diagnostic spans like
  // harness.run / message.delivery) still join the turn's trace instead of
  // orphaning into a new one. Swept by `sweepStale`.
  private readonly completedRoots = new Map<string, { context: Context; at: number }>();

  // Gateway tier (singleton) ------------------------------------------------

  setGateway(ctx: GatewayContext): void {
    this.gateway = ctx;
  }
  getGateway(): GatewayContext | null {
    return this.gateway;
  }
  clearGateway(): void {
    this.gateway = null;
  }

  // Session tier ------------------------------------------------------------

  setSession(key: string, ctx: SessionContext): void {
    this.sessions.set(key, ctx);
  }
  getSession(key: string): SessionContext | undefined {
    return this.sessions.get(key);
  }
  deleteSession(key: string): boolean {
    return this.sessions.delete(key);
  }
  /** Refresh a session's activity timestamp so an idle sweep won't evict it
   *  while it is still in use. No-op if the session is unknown. */
  touchSession(key: string, now: number): void {
    const session = this.sessions.get(key);
    if (session) session.lastActivityAt = now;
  }

  /**
   * Refresh request + agent-turn (and the base session) liveness for `key` so
   * {@link sweepStale} won't force-end a turn that is still doing work. Call on
   * each in-turn signal (model-call start, tool start, tool result). No-op for
   * absent tiers. Keeps the whole chain alive together so a long-running turn's
   * request isn't swept out from under its live turn.
   */
  touchActivity(key: string, now: number): void {
    const req = this.requests.get(key);
    if (req) req.lastActivityAt = now;
    const turn = this.agentTurns.get(key);
    if (turn) turn.lastActivityAt = now;
    const session = this.sessions.get(baseSessionKey(key));
    if (session) session.lastActivityAt = now;
  }

  // Request tier ------------------------------------------------------------

  setRequest(key: string, ctx: RequestContext): void {
    this.requests.set(key, ctx);
  }
  getRequest(key: string): RequestContext | undefined {
    return this.requests.get(key);
  }
  deleteRequest(key: string): boolean {
    return this.requests.delete(key);
  }

  // Agent-turn tier ---------------------------------------------------------

  setAgentTurn(key: string, ctx: AgentTurnContext): void {
    this.agentTurns.set(key, ctx);
  }
  getAgentTurn(key: string): AgentTurnContext | undefined {
    return this.agentTurns.get(key);
  }
  deleteAgentTurn(key: string): boolean {
    return this.agentTurns.delete(key);
  }

  // Cron-job tier -----------------------------------------------------------

  setCronJob(key: string, ctx: CronJobContext): void {
    this.cronJobs.set(key, ctx);
  }
  getCronJob(key: string): CronJobContext | undefined {
    return this.cronJobs.get(key);
  }
  deleteCronJob(key: string): boolean {
    return this.cronJobs.delete(key);
  }

  // In-flight tool spans ----------------------------------------------------

  setToolSpan(callId: string, span: ActiveToolSpan): void {
    this.toolSpans.set(callId, span);
  }
  getToolSpan(callId: string): ActiveToolSpan | undefined {
    return this.toolSpans.get(callId);
  }
  deleteToolSpan(callId: string): boolean {
    return this.toolSpans.delete(callId);
  }

  // Completed-root retention ------------------------------------------------

  /** Retain a finished request root's Context so late spans still join its
   *  trace. Call at agent_end with the request's rootContext. */
  retainCompletedRoot(key: string, context: Context, at: number): void {
    this.completedRoots.set(key, { context, at });
  }
  /** The retained root Context for a finished turn, if still within the sweep
   *  window. */
  getCompletedRoot(key: string): Context | undefined {
    return this.completedRoots.get(key)?.context;
  }
  /** Drop a retained root (e.g. a new inbound message starts a fresh turn). */
  deleteCompletedRoot(key: string): boolean {
    return this.completedRoots.delete(key);
  }

  // Parent resolution -------------------------------------------------------

  /**
   * The Context a new child span should attach to for the given session key,
   * tried most-specific first: agentTurn → request → session → gateway.
   * Returns `undefined` when nothing is registered (span becomes a new root).
   */
  resolveContext(key: string): Context | undefined {
    const turn = this.agentTurns.get(key);
    if (turn) return turn.context;
    const req = this.requests.get(key);
    if (req) return req.rootContext;
    // After the turn's request/agent.turn are torn down (agent_end), a briefly
    // retained completed root keeps late spans (outbound message, end-of-turn
    // diagnostics) in the SAME trace rather than orphaning them.
    const completed = this.completedRoots.get(key);
    if (completed) return completed.context;
    // Sessions are stored under the BASE key; a composite request/turn key must
    // be reduced before the session-tier fallback or the chain silently breaks.
    const session = this.sessions.get(baseSessionKey(key));
    if (session?.context) return session.context;
    if (this.gateway) return this.gateway.context;
    return undefined;
  }

  /**
   * The Context for a TURN-scoped span: agentTurn → request → retained completed
   * root ONLY — never the session/gateway fallback. Used by diagnostic-driven
   * spans (skill.used, context.assembled, harness.run, message.*), which must
   * attach to an actual turn or NOT emit. The plugin runs in both the gateway and
   * the embedded-runner contexts and both observe the diagnostic stream; only the
   * instance that actually ran the turn has its trace context here, so the other
   * returns undefined and skips emission instead of orphaning a duplicate span
   * onto the session/gateway root.
   */
  resolveTurnContext(key: string): Context | undefined {
    const turn = this.agentTurns.get(key);
    if (turn) return turn.context;
    const req = this.requests.get(key);
    if (req) return req.rootContext;
    return this.completedRoots.get(key)?.context;
  }

  /** The parent Span counterpart to {@link resolveContext}, same lookup order. */
  resolveParentSpan(key: string): Span | undefined {
    const turn = this.agentTurns.get(key);
    if (turn) return turn.span;
    const req = this.requests.get(key);
    if (req) return req.rootSpan;
    const session = this.sessions.get(baseSessionKey(key));
    if (session?.span) return session.span;
    return this.gateway?.span;
  }

  // Maintenance -------------------------------------------------------------

  /**
   * Drop request/agent-turn/cron/tool entries whose LAST ACTIVITY is older than
   * `maxAgeMs` relative to `now` (falling back to start time when no activity has
   * been recorded). Liveness — not start time — is the primary signal: a turn is
   * refreshed via {@link touchActivity} on each model-call/tool event, so a
   * long-running turn is kept alive instead of being force-ended mid-flight (which
   * would orphan its child spans and skip the end-of-turn token rollup). The age
   * threshold is the backstop for a turn that goes genuinely silent (e.g. a single
   * very long model generation with no intervening events) or never reaches its
   * terminal hook; set it well above the realistic max turn duration.
   *
   * SESSIONS are intentionally NOT swept here: they are the long-lived tier
   * (one per conversation, spanning many requests), so an age sweep keyed on
   * `startedAt` would evict a still-active conversation and break parent
   * resolution / trace continuity for its later requests. Sessions are evicted
   * explicitly on session end (see {@link deleteSession}) or via {@link clear}.
   *
   * Returns the number of entries removed.
   */
  sweepStale(maxAgeMs: number, now: number): number {
    const cutoff = now - maxAgeMs;
    let removed = 0;
    for (const [key, v] of this.requests) {
      if ((v.lastActivityAt ?? v.startedAt) < cutoff) {
        this.endOrphaned(v.rootSpan);
        this.requests.delete(key);
        removed++;
      }
    }
    for (const [key, v] of this.agentTurns) {
      if ((v.lastActivityAt ?? v.startedAt) < cutoff) {
        this.endOrphaned(v.modelCallSpan);
        this.endOrphaned(v.span);
        this.agentTurns.delete(key);
        removed++;
      }
    }
    for (const [key, v] of this.cronJobs) {
      if (v.startedAt < cutoff) {
        this.endOrphaned(v.span);
        this.cronJobs.delete(key);
        removed++;
      }
    }
    for (const [key, v] of this.completedRoots) {
      if (v.at < cutoff) {
        this.completedRoots.delete(key);
        removed++;
      }
    }
    for (const [key, v] of this.toolSpans) {
      if ((v.lastActivityAt ?? v.startTime) < cutoff) {
        this.endOrphaned(v.span);
        this.toolSpans.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * End a still-in-flight span with an error marker so a partial trace EXPORTS
   * rather than vanishing when a turn never reached its terminal hook. No-op if
   * absent; tolerant of already-ended spans.
   */
  private endOrphaned(span?: Span): void {
    if (!span) return;
    try {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "orphaned" });
      span.end();
    } catch {
      // already ended / provider gone — nothing to do
    }
  }

  /**
   * End every in-flight span across all tiers, then clear. Call on plugin
   * teardown so in-flight turns/tools/model-calls export (truncated, errored)
   * instead of being silently dropped.
   */
  endAndClear(): void {
    if (this.gateway) this.endOrphaned(this.gateway.span);
    for (const s of this.sessions.values()) this.endOrphaned(s.span);
    for (const r of this.requests.values()) this.endOrphaned(r.rootSpan);
    for (const t of this.agentTurns.values()) {
      this.endOrphaned(t.modelCallSpan);
      this.endOrphaned(t.span);
    }
    for (const c of this.cronJobs.values()) this.endOrphaned(c.span);
    for (const t of this.toolSpans.values()) this.endOrphaned(t.span);
    this.clear();
  }

  /**
   * Evict sessions idle longer than `idleMs` — no request/turn activity since
   * `lastActivityAt` (falling back to `startedAt`). Sessions are the long-lived
   * tier and are normally evicted explicitly on session end; this is the
   * backstop that bounds memory if a session-end signal is ever missed, without
   * dropping an active conversation (each request refreshes activity via
   * {@link touchSession}). Returns the number of sessions removed.
   */
  sweepIdleSessions(idleMs: number, now: number): number {
    const cutoff = now - idleMs;
    let removed = 0;
    for (const [key, session] of this.sessions) {
      if ((session.lastActivityAt ?? session.startedAt) < cutoff) {
        this.endOrphaned(session.span);
        this.sessions.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Per-tier entry counts (diagnostics / leak detection). */
  sizes(): Record<string, number> {
    return {
      gateway: this.gateway ? 1 : 0,
      sessions: this.sessions.size,
      requests: this.requests.size,
      agentTurns: this.agentTurns.size,
      cronJobs: this.cronJobs.size,
      toolSpans: this.toolSpans.size,
    };
  }

  /** Drop every tier (plugin stop / reset). */
  clear(): void {
    this.gateway = null;
    this.sessions.clear();
    this.requests.clear();
    this.agentTurns.clear();
    this.cronJobs.clear();
    this.toolSpans.clear();
    this.completedRoots.clear();
  }
}
