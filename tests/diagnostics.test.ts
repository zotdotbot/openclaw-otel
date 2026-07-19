// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import {
  UsageCoordinator,
  diagnosticRuntimeCandidates,
  pluginSdkRuntimeCandidates,
  emitSkillUsedSpan,
  enrichSpanWithUsage,
  extractDiagnosticSpan,
  extractSkillFromEvent,
  extractUsageFromEvent,
  makeDiagnosticListener,
  recordTokenUsage,
} from "../src/diagnostics";
import { TraceContextStore } from "../src/trace-context-store";

function fakeHistogram() {
  const records: Array<{ value: number; attrs: any }> = [];
  return {
    record: (value: number, attrs: any) => records.push({ value, attrs }),
    get records() {
      return records;
    },
  } as any;
}

/** Minimal Span stand-in capturing setAttributes + end. */
function fakeSpan() {
  const attrs: Record<string, any> = {};
  let ended: number | undefined;
  let endCount = 0;
  return {
    setAttributes: (o: Record<string, any>) => Object.assign(attrs, o),
    setAttribute: (k: string, v: any) => {
      attrs[k] = v;
    },
    end: (t?: number) => {
      ended = t;
      endCount++;
    },
    get attrs() {
      return attrs;
    },
    get ended() {
      return ended;
    },
    get endCount() {
      return endCount;
    },
  } as any;
}

describe("extractUsageFromEvent", () => {
  it("maps a model.usage event to key + usage", () => {
    const r = extractUsageFromEvent({
      type: "model.usage",
      sessionKey: "s",
      model: "m",
      costUsd: 0.01,
      usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
    });
    expect(r).toEqual({
      key: "s",
      usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, costUsd: 0.01, model: "m" },
    });
  });
  it("ignores non-usage events", () => {
    expect(extractUsageFromEvent({ type: "session.stalled" })).toBeUndefined();
  });
});

describe("enrichSpanWithUsage", () => {
  it("sets gen_ai.usage.* + cost, skipping zero cache tokens", () => {
    const span = fakeSpan();
    enrichSpanWithUsage(span, {
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 7,
      costUsd: 0.02,
      model: "m",
    });
    expect(span.attrs["gen_ai.usage.input_tokens"]).toBe(100);
    expect(span.attrs["gen_ai.usage.output_tokens"]).toBe(50);
    expect(span.attrs["gen_ai.usage.cache_read.input_tokens"]).toBeUndefined();
    expect(span.attrs["gen_ai.usage.cache_creation.input_tokens"]).toBe(7);
    expect(span.attrs["gen_ai.response.model"]).toBe("m");
    expect(span.attrs["openclaw.llm.cost_usd"]).toBe(0.02);
  });
});

describe("recordTokenUsage", () => {
  it("records one observation per nonzero token type with token.type + model attrs", () => {
    const h = fakeHistogram();
    recordTokenUsage(h, { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, model: "m" });
    const byType = (t: string) =>
      h.records.find((r: any) => r.attrs["gen_ai.token.type"] === t);
    expect(byType("input").value).toBe(100);
    expect(byType("input").attrs["gen_ai.response.model"]).toBe("m");
    expect(byType("output").value).toBe(50);
    expect(byType("cache_read").value).toBe(10);
    expect(byType("cache_creation")).toBeUndefined(); // zero is not recorded
  });
  it("is a no-op without a histogram", () => {
    expect(() => recordTokenUsage(undefined, { input: 1 })).not.toThrow();
  });
});

describe("UsageCoordinator held-open turn", () => {
  it("usage arriving BEFORE agent_end enriches + ends immediately", () => {
    const c = new UsageCoordinator({ now: () => 1000 });
    c.onUsage("k", { input: 7, output: 3 });
    const span = fakeSpan();
    c.handleTurnEnd("k", span, 1234);
    expect(span.attrs["gen_ai.usage.input_tokens"]).toBe(7);
    expect(span.ended).toBe(1234);
    expect(span.endCount).toBe(1);
  });

  it("agent_end BEFORE usage parks, then onUsage enriches + ends with the recorded time", () => {
    const c = new UsageCoordinator();
    const span = fakeSpan();
    c.handleTurnEnd("k", span, 5000);
    expect(span.endCount).toBe(0); // parked, not ended
    c.onUsage("k", { input: 9, output: 4 });
    expect(span.attrs["gen_ai.usage.input_tokens"]).toBe(9);
    expect(span.ended).toBe(5000); // recorded end time, not "now"
    expect(span.endCount).toBe(1);
  });

  it("grace expiry ends the parked span unenriched with the recorded time", () => {
    vi.useFakeTimers();
    try {
      const c = new UsageCoordinator({ graceMs: 10_000 });
      const span = fakeSpan();
      c.handleTurnEnd("k", span, 6000);
      expect(span.endCount).toBe(0);
      vi.advanceTimersByTime(10_000);
      expect(span.endCount).toBe(1);
      expect(span.ended).toBe(6000);
      expect(span.attrs["gen_ai.usage.input_tokens"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disarm ends parked spans and makes subsequent turns end immediately", () => {
    const c = new UsageCoordinator();
    const parked = fakeSpan();
    c.handleTurnEnd("k1", parked, 1);
    expect(parked.endCount).toBe(0);
    c.disarm();
    expect(parked.endCount).toBe(1);
    const immediate = fakeSpan();
    c.handleTurnEnd("k2", immediate, 2);
    expect(immediate.endCount).toBe(1);
    expect(immediate.ended).toBe(2);
  });

  it("a second agent_end for the same session ends the prior parked turn (no leak/cross-delete)", () => {
    const c = new UsageCoordinator();
    const spanN = fakeSpan();
    c.handleTurnEnd("k", spanN, 100); // turn N parked
    expect(spanN.endCount).toBe(0);
    const spanN1 = fakeSpan();
    c.handleTurnEnd("k", spanN1, 200); // turn N+1, same session, within grace
    expect(spanN.endCount).toBe(1); // N evicted + ended with its recorded time
    expect(spanN.ended).toBe(100);
    expect(spanN1.endCount).toBe(0); // N+1 now parked
    c.onUsage("k", { input: 5 }); // usage belongs to the current parked turn
    expect(spanN1.attrs["gen_ai.usage.input_tokens"]).toBe(5);
    expect(spanN1.ended).toBe(200);
    expect(spanN.endCount).toBe(1); // N not double-ended
  });

  it("a stale pending usage (older than TTL) is not claimed", () => {
    let t = 1000;
    const c = new UsageCoordinator({ pendingTtlMs: 100, now: () => t });
    c.onUsage("k", { input: 1 });
    t = 2000; // beyond TTL
    const span = fakeSpan();
    c.handleTurnEnd("k", span, 3000);
    expect(span.attrs["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(span.endCount).toBe(0); // parked instead of using stale pending
  });
});

describe("diagnosticRuntimeCandidates", () => {
  it("derives the gateway dist barrel from a package-root entry", () => {
    // The live gateway runs `/app/openclaw.mjs`; the barrel is at
    // /app/dist/plugin-sdk/diagnostic-runtime.js.
    const cands = diagnosticRuntimeCandidates("/app/openclaw.mjs");
    expect(cands).toContain("/app/dist/plugin-sdk/diagnostic-runtime.js");
  });

  it("covers an entry that already lives inside dist", () => {
    const cands = diagnosticRuntimeCandidates("/app/dist/index.js");
    expect(cands).toContain("/app/dist/plugin-sdk/diagnostic-runtime.js");
  });

  it("returns [] when there is no entry", () => {
    expect(diagnosticRuntimeCandidates(undefined)).toEqual([]);
    expect(diagnosticRuntimeCandidates("")).toEqual([]);
  });

  it("yields unique candidates and stays bounded as it walks up", () => {
    const cands = diagnosticRuntimeCandidates("/a/b/c/d/e/openclaw.mjs");
    expect(new Set(cands).size).toBe(cands.length);
    expect(cands.length).toBeLessThanOrEqual(12);
  });

  it("generalizes to any plugin-sdk barrel (e.g. heartbeat-runtime)", () => {
    const cands = pluginSdkRuntimeCandidates("/app/openclaw.mjs", "heartbeat-runtime.js");
    expect(cands).toContain("/app/dist/plugin-sdk/heartbeat-runtime.js");
    expect(pluginSdkRuntimeCandidates(undefined, "heartbeat-runtime.js")).toEqual([]);
  });
});

describe("extractSkillFromEvent", () => {
  it("pulls skill fields off a skill.used diagnostic, defaulting source to 'unknown'", () => {
    expect(
      extractSkillFromEvent({ type: "skill.used", sessionKey: "agent:1:slack:t", skillName: "x", skillSource: "bundled", activation: "invoked", toolName: "read", ts: 123 }),
    ).toEqual({ sessionKey: "agent:1:slack:t", skillName: "x", skillSource: "bundled", activation: "invoked", toolName: "read", ts: 123 });
    // missing source/key/name fall back; non-skill events are ignored.
    expect(extractSkillFromEvent({ type: "skill.used" })).toMatchObject({
      sessionKey: "unknown",
      skillName: "skill",
      skillSource: "unknown",
    });
    expect(extractSkillFromEvent({ type: "model.usage" })).toBeUndefined();
  });
});

describe("makeDiagnosticListener — skill.used routing", () => {
  it("emits an openclaw.skill.used span via the tracer + store, only when both are present", () => {
    const started: Array<{ name: string; opts: any }> = [];
    const tracer = {
      startSpan: (name: string, opts: any) => {
        started.push({ name, opts });
        return { end: () => {} };
      },
    } as any;
    const store = new TraceContextStore();
    // A live turn must exist for this session, else the span is suppressed (the
    // orphan guard — only the instance that ran the turn emits).
    store.setRequest("agent:1:slack:t", { rootSpan: {} as any, rootContext: {} as any, startedAt: 1 });
    const listen = makeDiagnosticListener({
      coordinator: new UsageCoordinator(),
      sessionStalled: { add: () => {} } as any,
      tracer,
      store,
    });
    listen({ type: "skill.used", sessionKey: "agent:1:slack:t", skillName: "fill-daily", skillSource: "bundled" });
    expect(started).toHaveLength(1);
    expect(started[0]!.name).toBe("openclaw.skill.used");
    expect(started[0]!.opts.attributes["openclaw.skill.name"]).toBe("fill-daily");
    expect(started[0]!.opts.attributes["openclaw.skill.source"]).toBe("bundled");

    // Without a tracer/store, skill events are silently ignored (no throw).
    const noEmit = makeDiagnosticListener({
      coordinator: new UsageCoordinator(),
      sessionStalled: { add: () => {} } as any,
    });
    expect(() => noEmit({ type: "skill.used", skillName: "y" })).not.toThrow();
  });
});

describe("makeDiagnosticListener — session stall routing", () => {
  it("increments the same keyed counter for session.stalled and session.stuck", () => {
    const adds: any[] = [];
    const sessionStalled = { add: (n: number, attrs: any) => adds.push({ n, attrs }) } as any;
    const listen = makeDiagnosticListener({
      coordinator: new UsageCoordinator(),
      sessionStalled,
    });

    listen({ type: "session.stalled", sessionKey: "agent:1:slack:t" });
    listen({ type: "session.stuck", sessionKey: "agent:2:cron:x" });
    listen({ type: "session.stuck" });

    expect(adds).toEqual([
      { n: 1, attrs: { "openclaw.session.key": "agent:1:slack:t" } },
      { n: 1, attrs: { "openclaw.session.key": "agent:2:cron:x" } },
      { n: 1, attrs: { "openclaw.session.key": "unknown" } },
    ]);
  });
});

describe("emitSkillUsedSpan — timestamp clamp", () => {
  it("clamps the span start into [turn start, now] so it sorts after its parent root", () => {
    const starts: number[] = [];
    const tracer = {
      startSpan: (_n: string, opts: any) => {
        starts.push(opts.startTime);
        return { end: () => {} };
      },
    } as any;
    const store = {
      resolveTurnContext: () => ({}), // a live turn context exists → emits
      getAgentTurn: () => ({ startedAt: 1000 }),
      getRequest: () => undefined,
    } as any;
    const skill = { sessionKey: "k", skillName: "s", skillSource: "bundled" };
    // ts before the turn → floored to the turn start.
    emitSkillUsedSpan(tracer, store, { ...skill, ts: 200 }, () => 5000);
    // ts in the future → capped to now.
    emitSkillUsedSpan(tracer, store, { ...skill, ts: 9_999_999 }, () => 5000);
    // ts within the turn → unchanged.
    emitSkillUsedSpan(tracer, store, { ...skill, ts: 3000 }, () => 5000);
    expect(starts).toEqual([1000, 5000, 3000]);
  });
});

describe("extractDiagnosticSpan — re-homed operational events", () => {
  it("maps context.assembled sizing fields to the consumer's attribute names", () => {
    const ds = extractDiagnosticSpan({
      type: "context.assembled", sessionKey: "s",
      promptChars: 207, systemPromptChars: 65932, messageCount: 3,
      historyTextChars: 50, contextTokenBudget: 1048576, ts: 9,
    })!;
    expect(ds.spanName).toBe("openclaw.context.assembled");
    expect(ds.attributes["openclaw.context.prompt_chars"]).toBe(207);
    expect(ds.attributes["openclaw.context.system_prompt_chars"]).toBe(65932);
    expect(ds.attributes["openclaw.context.message_count"]).toBe(3);
    expect(ds.attributes["openclaw.context.token_budget"]).toBe(1048576);
    expect(ds.errorMessage).toBeUndefined();
  });

  it("flattens harness itemLifecycle and marks harness.run.error as ERROR", () => {
    const ok = extractDiagnosticSpan({
      type: "harness.run.completed", sessionKey: "s",
      itemLifecycle: { startedCount: 5, completedCount: 5, activeCount: 0 },
      outcome: "completed", durationMs: 100, ts: 9,
    })!;
    expect(ok.attributes["openclaw.harness.items.started"]).toBe(5);
    expect(ok.attributes["openclaw.harness.items.completed"]).toBe(5);
    expect(ok.durationMs).toBe(100);
    expect(ok.errorMessage).toBeUndefined();

    const err = extractDiagnosticSpan({
      type: "harness.run.error", sessionKey: "s", errorCategory: "timeout", ts: 9,
    })!;
    expect(err.attributes["openclaw.outcome"]).toBe("error");
    expect(err.errorMessage).toBe("timeout");
  });

  it("maps message.processed/delivery, ERROR on error outcomes", () => {
    const proc = extractDiagnosticSpan({
      type: "message.processed", sessionKey: "s", channel: "slack",
      outcome: "error", reason: "boom", ts: 9,
    })!;
    expect(proc.spanName).toBe("openclaw.message.processed");
    expect(proc.attributes["openclaw.channel"]).toBe("slack");
    expect(proc.errorMessage).toBe("boom");

    const del = extractDiagnosticSpan({
      type: "message.delivery.completed", sessionKey: "s",
      deliveryKind: "reply", resultCount: 2, ts: 9,
    })!;
    expect(del.attributes["openclaw.delivery.kind"]).toBe("reply");
    expect(del.attributes["openclaw.delivery.result_count"]).toBe(2);
    expect(del.attributes["openclaw.outcome"]).toBe("completed");
  });

  it("returns undefined without a sessionKey (cannot parent) and for unhandled types", () => {
    expect(extractDiagnosticSpan({ type: "context.assembled", promptChars: 1 })).toBeUndefined();
    // Operations the plugin already spans must NOT be re-homed (would double-count).
    expect(extractDiagnosticSpan({ type: "model.call.completed", sessionKey: "s", timeToFirstByteMs: 5 })).toBeUndefined();
    expect(extractDiagnosticSpan({ type: "exec.process.completed", sessionKey: "s", exitCode: 0 })).toBeUndefined();
    expect(extractDiagnosticSpan({ type: "run.completed", sessionKey: "s" })).toBeUndefined();
  });
});
