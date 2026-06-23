// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { SpanKind, trace, ROOT_CONTEXT } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";

import { TraceContextStore } from "../src/trace-context-store";
import { registerHooks } from "../src/hooks";
import { CONTENT_POLICY_DISABLED, CONTENT_POLICY_ENABLED } from "../src/config";
import {
  CronRegistry,
  registerCronHooks,
  cronRunAttrs,
  cronDefinitionAttrs,
  metaFromJob,
  type CronMeta,
} from "../src/cron";

const JOB = {
  id: "job-1",
  name: "Daily Briefing",
  enabled: true,
  schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "America/New_York" },
  state: { nextRunAtMs: 1_000, lastRunAtMs: 900, lastRunStatus: "ok" },
};

function cronHarness(capture = CONTENT_POLICY_DISABLED) {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "test" }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("test");
  const store = new TraceContextStore();
  const registry = new CronRegistry();
  const counts: Array<{ n: number; attrs: any }> = [];
  const cronRuns = { add: (n: number, attrs: any) => counts.push({ n, attrs }) } as any;
  const hooks: Record<string, (e: any, c?: any) => void> = {};
  const api = { on: (e: string, h: any) => { hooks[e] = h; } };
  const cleanup = registerCronHooks(api, { tracer, store, registry, capture, cronRuns });
  return {
    fire: (e: string, p: any = {}, c?: any) => hooks[e]?.(p, c),
    spans: () => exporter.getFinishedSpans(),
    byName: (n: string): ReadableSpan[] => exporter.getFinishedSpans().filter((s) => s.name === n),
    tracer,
    store,
    registry,
    counts,
    cleanup,
  };
}

describe("CronRegistry + metaFromJob", () => {
  it("extracts name + cron schedule + next-run from a job", () => {
    const m = metaFromJob(JOB);
    expect(m).toMatchObject({
      name: "Daily Briefing",
      enabled: true,
      scheduleKind: "cron",
      scheduleExpr: "0 9 * * 1-5",
      scheduleTz: "America/New_York",
      nextRunAtMs: 1_000,
    });
  });
  it("handles the 'every' schedule variant", () => {
    const m = metaFromJob({ id: "x", schedule: { kind: "every", everyMs: 600_000 } });
    expect(m.scheduleKind).toBe("every");
    expect(m.scheduleEveryMs).toBe(600_000);
    expect(m.scheduleExpr).toBeUndefined();
  });
  it("upsert MERGES so a later partial update keeps name/schedule", () => {
    const r = new CronRegistry();
    r.upsert("j", metaFromJob(JOB));
    r.upsert("j", { nextRunAtMs: 2_000 } as CronMeta);
    expect(r.get("j")).toMatchObject({ name: "Daily Briefing", nextRunAtMs: 2_000 });
  });
});

describe("cronRunAttrs (pure)", () => {
  it("prefers event.job, defaults a missing status to 'unknown', carries NO gen_ai.usage", () => {
    const a = cronRunAttrs(
      { jobId: "job-1", runId: "r1", durationMs: 1234, delivered: true, deliveryStatus: "delivered", model: "claude", provider: "anthropic", sessionKey: "agent:7:cron:job-1:run:r1", job: JOB },
      new CronRegistry(),
      CONTENT_POLICY_DISABLED,
    );
    expect(a["openclaw.cron.job_id"]).toBe("job-1");
    expect(a["openclaw.cron.job_name"]).toBe("Daily Briefing");
    expect(a["openclaw.cron.status"]).toBe("unknown"); // not silently "ok"
    expect(a["openclaw.cron.duration_ms"]).toBe(1234);
    expect(a["openclaw.cron.delivered"]).toBe(true);
    expect(a["openclaw.cron.schedule_expr"]).toBe("0 9 * * 1-5");
    expect(a["openclaw.trigger"]).toBe("cron");
    expect(a["openclaw.session.key"]).toBe("agent:7:cron:job-1:run:r1");
    expect(a["gen_ai.response.model"]).toBe("claude");
    // NO token usage on the run span (avoids double-count vs agent.turn)
    expect(a["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(a["gen_ai.usage.output_tokens"]).toBeUndefined();
  });
  it("falls back to the registry cache for name/schedule/next-run when event.job is absent", () => {
    const r = new CronRegistry();
    r.upsert("job-1", metaFromJob(JOB));
    const a = cronRunAttrs({ jobId: "job-1", status: "skipped" }, r, CONTENT_POLICY_DISABLED);
    expect(a["openclaw.cron.job_name"]).toBe("Daily Briefing");
    expect(a["openclaw.cron.schedule_expr"]).toBe("0 9 * * 1-5");
    expect(a["openclaw.cron.status"]).toBe("skipped");
    // next_run_at_ms not on the event → recovered from the registry cache
    expect(a["openclaw.cron.next_run_at_ms"]).toBe(1_000);
    // no session key on the event → synthesized correlation key
    expect(a["openclaw.session.key"]).toBe("cron:job-1");
  });
  it("gates the summary behind captureContent.cronSummary", () => {
    const ev = { jobId: "job-1", summary: "did the thing  with\nnewlines" };
    expect(cronRunAttrs(ev, new CronRegistry(), CONTENT_POLICY_DISABLED)["openclaw.cron.summary"]).toBeUndefined();
    const on = cronRunAttrs(ev, new CronRegistry(), CONTENT_POLICY_ENABLED);
    expect(on["openclaw.cron.summary"]).toBe("did the thing with newlines"); // bounded + single-line
  });
});

describe("cronDefinitionAttrs (pure)", () => {
  it("marks a removed action with the tombstone", () => {
    const a = cronDefinitionAttrs({ action: "removed", jobId: "job-1" });
    expect(a["openclaw.cron.removed"]).toBe(true);
    expect(a["openclaw.cron.action"]).toBe("removed");
    expect(a["openclaw.session.key"]).toBe("cron:job-1");
  });

  it("recovers name/schedule from the registry when a removed tombstone omits job", () => {
    const r = new CronRegistry();
    r.upsert("job-1", metaFromJob(JOB));
    const a = cronDefinitionAttrs({ action: "removed", jobId: "job-1" }, r);
    expect(a["openclaw.cron.removed"]).toBe(true);
    expect(a["openclaw.cron.job_name"]).toBe("Daily Briefing"); // not lost
    expect(a["openclaw.cron.schedule_expr"]).toBe("0 9 * * 1-5");
  });
});

describe("registerCronHooks (cron_changed)", () => {
  it("emits openclaw.cron.run on finished, with status + ids", () => {
    const h = cronHarness();
    h.fire("cron_changed", { action: "finished", jobId: "job-1", runId: "r1", status: "ok", durationMs: 50, runAtMs: 1_000, sessionKey: "agent:7:cron:job-1:run:r1", job: JOB });
    const run = h.byName("openclaw.cron.run")[0];
    expect(run).toBeDefined();
    expect(run.attributes["openclaw.cron.job_id"]).toBe("job-1");
    expect(run.attributes["openclaw.cron.status"]).toBe("ok");
    expect(run.attributes["openclaw.cron.job_name"]).toBe("Daily Briefing");
  });

  it("sets ERROR span status when the run failed", () => {
    const h = cronHarness();
    h.fire("cron_changed", { action: "finished", jobId: "job-1", status: "error", error: "boom" });
    const run = h.byName("openclaw.cron.run")[0];
    expect(run.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it("increments the opt-in cron.runs counter on finished, keyed by status + job_id", () => {
    const h = cronHarness();
    h.fire("cron_changed", { action: "finished", jobId: "job-1", status: "error", error: "boom" });
    h.fire("cron_changed", { action: "added", jobId: "job-1", job: JOB }); // non-finished: no count
    expect(h.counts).toHaveLength(1);
    expect(h.counts[0]!.attrs["openclaw.cron.status"]).toBe("error");
    expect(h.counts[0]!.attrs["openclaw.cron.job_id"]).toBe("job-1");
  });

  it("emits a SERVER root for a turn-less run, INTERNAL when joined to a live turn", () => {
    const h = cronHarness();
    // turn-less (no matching turn in the store) → SERVER root
    h.fire("cron_changed", { action: "finished", jobId: "job-1", status: "skipped", sessionKey: "cron:job-1" });
    const turnless = h.byName("openclaw.cron.run")[0];
    expect(turnless.kind).toBe(SpanKind.SERVER);

    // a retained/live turn for the session key → INTERNAL, parented. Build a
    // REAL OTel context (a fake {id} object lacks getValue and startSpan throws).
    const sk = "agent:7:cron:job-1:run:r2";
    const root = h.tracer.startSpan("turn-root-for-test");
    h.store.retainCompletedRoot(sk, trace.setSpan(ROOT_CONTEXT, root), 1);
    h.fire("cron_changed", { action: "finished", jobId: "job-1", status: "ok", sessionKey: sk });
    root.end();
    const joined = h.byName("openclaw.cron.run").find((s) => s.attributes["openclaw.session.key"] === sk)!;
    expect(joined.kind).toBe(SpanKind.INTERNAL);
  });

  it("guards a negative durationMs on the run span (no backwards span)", () => {
    const h = cronHarness();
    h.fire("cron_changed", { action: "finished", jobId: "job-1", status: "ok", runAtMs: 1_000, durationMs: -50 });
    const run = h.byName("openclaw.cron.run")[0];
    expect(run.duration[0] * 1000 + run.duration[1] / 1e6).toBe(0); // not [1000, 950]
  });

  it("seeds the registry + emits definition snapshots from getCron() on gateway_start", async () => {
    const h = cronHarness();
    const ctx = { getCron: () => ({ list: async () => [JOB] }) };
    h.fire("gateway_start", {}, ctx);
    await new Promise((r) => setTimeout(r, 0)); // let the async list() chain resolve
    expect(h.registry.get("job-1")?.name).toBe("Daily Briefing");
    const def = h.byName("openclaw.cron.definition").find((s) => s.attributes["openclaw.cron.job_id"] === "job-1");
    expect(def).toBeDefined();
    expect(def!.attributes["openclaw.cron.schedule_expr"]).toBe("0 9 * * 1-5");
  });

  it("emits openclaw.cron.definition + seeds the registry on added; tombstones + prunes on removed", () => {
    const h = cronHarness();
    h.fire("cron_changed", { action: "added", jobId: "job-1", job: JOB });
    const def = h.byName("openclaw.cron.definition")[0];
    expect(def.attributes["openclaw.cron.job_name"]).toBe("Daily Briefing");
    expect(def.attributes["openclaw.cron.schedule_expr"]).toBe("0 9 * * 1-5");
    expect(h.registry.get("job-1")?.name).toBe("Daily Briefing");

    h.fire("cron_changed", { action: "removed", jobId: "job-1", job: JOB });
    const removed = h.byName("openclaw.cron.definition").at(-1)!;
    expect(removed.attributes["openclaw.cron.removed"]).toBe(true);
    expect(h.registry.get("job-1")).toBeUndefined();
  });
});

describe("Phase 1: cron turn enrichment (hooks.ts)", () => {
  it("stamps cron job_id + name/schedule (from the registry) onto the turn + request spans", () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ "service.name": "test" }),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer("test");
    const store = new TraceContextStore();
    const registry = new CronRegistry();
    registry.upsert("job-1", metaFromJob(JOB)); // seeded (as gateway_start/cron_changed would)
    const hooks: Record<string, (e: any, c?: any) => void> = {};
    const api = { on: (e: string, h: any) => { hooks[e] = h; } };
    const cleanup = registerHooks(api, { tracer, store, capture: CONTENT_POLICY_DISABLED, cronRegistry: registry });

    const sk = "agent:7:cron:job-1:run:r1";
    hooks["before_model_resolve"]({ sessionKey: sk }, { trigger: "cron", jobId: "job-1" });
    hooks["agent_end"]({ sessionKey: sk, success: true }); // no usage coordinator → ends turn now

    const turn = exporter.getFinishedSpans().find((s) => s.name === "openclaw.agent.turn")!;
    expect(turn.attributes["openclaw.cron.job_id"]).toBe("job-1");
    expect(turn.attributes["openclaw.cron.job_name"]).toBe("Daily Briefing");
    expect(turn.attributes["openclaw.cron.schedule_expr"]).toBe("0 9 * * 1-5");
    expect(turn.attributes["openclaw.cron.run_id"]).toBe("r1");
    cleanup();
  });
});
