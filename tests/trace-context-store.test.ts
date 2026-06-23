// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import type { Context, Span } from "@opentelemetry/api";

import { TraceContextStore } from "../src/trace-context-store";

// Minimal stand-ins — the store only stores and returns these, never calls them.
const span = (id: string): Span => ({ id }) as unknown as Span;
const ctx = (id: string): Context => ({ id }) as unknown as Context;
const ctxId = (c: Context | undefined): string | undefined =>
  (c as unknown as { id?: string } | undefined)?.id;

/** A span stand-in that records whether it was ended. */
function recSpan() {
  let ended = false;
  return {
    setStatus: () => {},
    end: () => {
      ended = true;
    },
    get ended() {
      return ended;
    },
  } as any;
}

describe("TraceContextStore tiers", () => {
  let store: TraceContextStore;
  beforeEach(() => {
    store = new TraceContextStore();
  });

  it("round-trips each tier and deletes", () => {
    store.setGateway({ span: span("g"), context: ctx("g"), startedAt: 1 });
    store.setSession("k", { context: ctx("s"), startedAt: 1, requestCount: 0 });
    store.setRequest("k", { rootSpan: span("r"), rootContext: ctx("r"), startedAt: 1 });
    store.setAgentTurn("k", { span: span("t"), context: ctx("t"), startedAt: 1 });
    store.setCronJob("j", { span: span("c"), context: ctx("c"), jobName: "nightly", startedAt: 1 });
    store.setToolSpan("call-1", { span: span("tool"), startTime: 1 });

    expect(store.getGateway()).not.toBeNull();
    expect(store.getSession("k")).toBeDefined();
    expect(store.getRequest("k")).toBeDefined();
    expect(store.getAgentTurn("k")).toBeDefined();
    expect(store.getCronJob("j")?.jobName).toBe("nightly");
    expect(store.getToolSpan("call-1")).toBeDefined();

    expect(store.deleteSession("k")).toBe(true);
    expect(store.getSession("k")).toBeUndefined();
    expect(store.deleteToolSpan("call-1")).toBe(true);
    expect(store.getToolSpan("call-1")).toBeUndefined();
  });
});

describe("resolveContext lookup order (agentTurn → request → session → gateway)", () => {
  let store: TraceContextStore;
  beforeEach(() => {
    store = new TraceContextStore();
    store.setGateway({ span: span("g"), context: ctx("gateway"), startedAt: 1 });
    store.setSession("k", { context: ctx("session"), startedAt: 1, requestCount: 1 });
    store.setRequest("k", { rootSpan: span("r"), rootContext: ctx("request"), startedAt: 1 });
    store.setAgentTurn("k", { span: span("t"), context: ctx("turn"), startedAt: 1 });
  });

  it("prefers the agent turn", () => {
    expect(ctxId(store.resolveContext("k"))).toBe("turn");
  });
  it("falls back to request, then session, then gateway", () => {
    store.deleteAgentTurn("k");
    expect(ctxId(store.resolveContext("k"))).toBe("request");
    store.deleteRequest("k");
    expect(ctxId(store.resolveContext("k"))).toBe("session");
    store.deleteSession("k");
    expect(ctxId(store.resolveContext("k"))).toBe("gateway");
    store.clearGateway();
    expect(store.resolveContext("k")).toBeUndefined();
  });
  it("resolveParentSpan follows the same order", () => {
    expect((store.resolveParentSpan("k") as unknown as { id: string }).id).toBe("t");
    store.deleteAgentTurn("k");
    expect((store.resolveParentSpan("k") as unknown as { id: string }).id).toBe("r");
  });

  it("a retained completed root keeps late spans in-trace after the turn is torn down", () => {
    // After agent_end deletes the request + turn, a retained completed root keeps
    // late spans (message.sent, re-homed end-of-turn diagnostics) in the SAME trace
    // — preferred over the session/gateway fallback.
    store.retainCompletedRoot("k", ctx("completed"), 1);
    store.deleteAgentTurn("k");
    store.deleteRequest("k");
    expect(ctxId(store.resolveContext("k"))).toBe("completed"); // not "session"
    expect(ctxId(store.getCompletedRoot("k"))).toBe("completed");
    store.deleteCompletedRoot("k");
    expect(ctxId(store.resolveContext("k"))).toBe("session"); // now falls through
  });

  it("sweepStale evicts a stale completed root (bounded retention)", () => {
    store.deleteAgentTurn("k");
    store.deleteRequest("k");
    store.retainCompletedRoot("stale", ctx("c"), 0);
    store.sweepStale(30_000, 1_000_000);
    expect(store.getCompletedRoot("stale")).toBeUndefined();
  });

  it("resolveTurnContext is turn-tier ONLY (no session/gateway) so orphan diagnostics skip", () => {
    // agentTurn → request → completedRoot, then undefined (NOT session/gateway).
    expect(ctxId(store.resolveTurnContext("k"))).toBe("turn");
    store.deleteAgentTurn("k");
    expect(ctxId(store.resolveTurnContext("k"))).toBe("request");
    store.deleteRequest("k");
    store.retainCompletedRoot("k", ctx("completed"), 1);
    expect(ctxId(store.resolveTurnContext("k"))).toBe("completed");
    store.deleteCompletedRoot("k");
    // session + gateway still registered, but resolveTurnContext ignores them →
    // the orphan instance emits nothing.
    expect(store.resolveTurnContext("k")).toBeUndefined();
    expect(ctxId(store.resolveContext("k"))).toBe("session"); // resolveContext still falls back
  });
});

describe("maintenance", () => {
  let store: TraceContextStore;
  beforeEach(() => {
    store = new TraceContextStore();
  });

  it("sweeps entries older than maxAge and keeps recent ones", () => {
    const now = 1_000_000;
    store.setRequest("old", { rootSpan: span("o"), rootContext: ctx("o"), startedAt: now - 60_000 });
    store.setRequest("new", { rootSpan: span("n"), rootContext: ctx("n"), startedAt: now - 1_000 });
    store.setToolSpan("old-tool", { span: span("ot"), startTime: now - 60_000 });

    const removed = store.sweepStale(30_000, now);
    expect(removed).toBe(2);
    expect(store.getRequest("old")).toBeUndefined();
    expect(store.getRequest("new")).toBeDefined();
    expect(store.getToolSpan("old-tool")).toBeUndefined();
  });

  it("reports sizes and clears", () => {
    store.setGateway({ span: span("g"), context: ctx("g"), startedAt: 1 });
    store.setSession("k", { startedAt: 1, requestCount: 0 });
    expect(store.sizes()).toMatchObject({ gateway: 1, sessions: 1 });
    store.clear();
    expect(store.sizes()).toMatchObject({ gateway: 0, sessions: 0, requests: 0 });
  });

  it("sweepStale does NOT evict sessions (long-lived tier)", () => {
    const now = 1_000_000;
    store.setSession("old", { startedAt: now - 60_000, requestCount: 1 });
    store.setRequest("old", { rootSpan: span("o"), rootContext: ctx("o"), startedAt: now - 60_000 });
    const removed = store.sweepStale(30_000, now);
    expect(removed).toBe(1); // only the request
    expect(store.getSession("old")).toBeDefined();
  });

  it("touchActivity keeps a long-running request/turn off the stale sweep", () => {
    const now = 1_000_000;
    // Started 20 min ago — would be swept on startedAt alone…
    store.setRequest("live", { rootSpan: span("r"), rootContext: ctx("r"), startedAt: now - 1_200_000 });
    store.setAgentTurn("live", { span: span("t"), context: ctx("t"), startedAt: now - 1_200_000 });
    store.touchActivity("live", now - 1_000); // …but it did work 1s ago
    const removed = store.sweepStale(600_000, now);
    expect(removed).toBe(0);
    expect(store.getRequest("live")).toBeDefined();
    expect(store.getAgentTurn("live")).toBeDefined();
  });

  it("sweepStale still evicts a request/turn gone silent past the threshold", () => {
    const now = 1_000_000;
    store.setRequest("silent", { rootSpan: span("r"), rootContext: ctx("r"), startedAt: now - 100 });
    store.setAgentTurn("silent", { span: span("t"), context: ctx("t"), startedAt: now - 100 });
    store.touchActivity("silent", now - 700_000); // last activity ~11.6 min ago
    const removed = store.sweepStale(600_000, now);
    expect(removed).toBe(2);
    expect(store.getRequest("silent")).toBeUndefined();
    expect(store.getAgentTurn("silent")).toBeUndefined();
  });

  it("touchActivity refreshes the base session under a composite key", () => {
    const now = 1_000_000;
    store.setSession("sess", { startedAt: now - 100_000, requestCount: 1 });
    store.setRequest("sess#r1", { rootSpan: span("r"), rootContext: ctx("r"), startedAt: now - 100_000 });
    store.touchActivity("sess#r1", now - 1_000); // composite key → reduces to base session
    const removed = store.sweepIdleSessions(30_000, now);
    expect(removed).toBe(0);
    expect(store.getSession("sess")).toBeDefined();
  });
});

describe("session idle sweep + concurrency keying", () => {
  it("touchSession refreshes activity so an idle sweep keeps active sessions", () => {
    const store = new TraceContextStore();
    const now = 1_000_000;
    store.setSession("a", { startedAt: now - 100_000, requestCount: 1 });
    store.setSession("b", { startedAt: now - 100_000, requestCount: 1 });
    store.touchSession("a", now - 1_000); // 'a' was just active
    const removed = store.sweepIdleSessions(30_000, now);
    expect(removed).toBe(1);
    expect(store.getSession("a")).toBeDefined();
    expect(store.getSession("b")).toBeUndefined();
  });

  it("concurrent requests in one session don't collide under composite keys", () => {
    const store = new TraceContextStore();
    store.setSession("sess", { context: ctx("session"), startedAt: 1, requestCount: 2 });
    store.setRequest("sess#r1", { rootSpan: span("r1"), rootContext: ctx("r1"), startedAt: 1 });
    store.setRequest("sess#r2", { rootSpan: span("r2"), rootContext: ctx("r2"), startedAt: 1 });
    expect(ctxId(store.resolveContext("sess#r1"))).toBe("r1");
    expect(ctxId(store.resolveContext("sess#r2"))).toBe("r2");
    // a session-key lookup still resolves to the session tier
    expect(ctxId(store.resolveContext("sess"))).toBe("session");
  });

  it("a composite key falls back to the BASE session tier when no request/turn exists", () => {
    const store = new TraceContextStore();
    store.setGateway({ span: span("g"), context: ctx("gateway"), startedAt: 1 });
    store.setSession("sess", { span: span("s"), context: ctx("session"), startedAt: 1, requestCount: 0 });
    // Nothing registered under the composite key → must reduce to "sess".
    expect(ctxId(store.resolveContext("sess#r9"))).toBe("session");
    expect((store.resolveParentSpan("sess#r9") as unknown as { id: string }).id).toBe("s");
    // With no session either, it reduces further to the gateway.
    store.deleteSession("sess");
    expect(ctxId(store.resolveContext("sess#r9"))).toBe("gateway");
  });
});

describe("orphaned-span ending (sweep + teardown export partial traces)", () => {
  it("sweepStale ENDS orphaned spans before deleting (not silently dropped)", () => {
    const store = new TraceContextStore();
    const now = 1_000_000;
    const rootSpan = recSpan();
    const turnSpan = recSpan();
    const modelSpan = recSpan();
    store.setRequest("old", { rootSpan, rootContext: ctx("o"), startedAt: now - 60_000 });
    store.setAgentTurn("old", { span: turnSpan, context: ctx("t"), startedAt: now - 60_000, modelCallSpan: modelSpan });
    store.sweepStale(30_000, now);
    expect(rootSpan.ended).toBe(true);
    expect(turnSpan.ended).toBe(true);
    expect(modelSpan.ended).toBe(true);
    expect(store.getRequest("old")).toBeUndefined();
  });

  it("endAndClear ends every in-flight span across tiers and clears", () => {
    const store = new TraceContextStore();
    const r = recSpan();
    const t = recSpan();
    const m = recSpan();
    const tool = recSpan();
    store.setRequest("k", { rootSpan: r, rootContext: ctx("r"), startedAt: 1 });
    store.setAgentTurn("k", { span: t, context: ctx("t"), startedAt: 1, modelCallSpan: m });
    store.setToolSpan("c", { span: tool, startTime: 1 });
    store.endAndClear();
    expect(r.ended).toBe(true);
    expect(t.ended).toBe(true);
    expect(m.ended).toBe(true);
    expect(tool.ended).toBe(true);
    expect(store.sizes()).toMatchObject({ requests: 0, agentTurns: 0, toolSpans: 0 });
  });
});
