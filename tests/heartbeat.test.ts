// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";

import { heartbeatRunAttrs, makeHeartbeatListener, initHeartbeat } from "../src/heartbeat";

/** ReadableSpan duration (HrTime [s, ns]) → milliseconds. */
const durMs = (s: ReadableSpan): number => s.duration[0] * 1000 + s.duration[1] / 1e6;

function hbHarness() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "test" }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("test");
  const counts: Array<{ n: number; attrs: any }> = [];
  const heartbeatRuns = { add: (n: number, attrs: any) => counts.push({ n, attrs }) } as any;
  return {
    tracer,
    heartbeatRuns,
    counts,
    runs: (): ReadableSpan[] =>
      exporter.getFinishedSpans().filter((s) => s.name === "openclaw.heartbeat.run"),
  };
}

describe("heartbeatRunAttrs (pure)", () => {
  it("maps status/reason/channel/duration + synthesizes heartbeat:<channel> correlation", () => {
    const a = heartbeatRunAttrs({
      ts: 5_000,
      status: "sent",
      channel: "slack",
      durationMs: 1234,
      silent: false,
      hasMedia: true,
      indicatorType: "ok",
      // PII/content — must NOT leak onto the span:
      to: "slack:U1",
      accountId: "acct-9",
      preview: "secret heartbeat body",
    });
    expect(a["openclaw.heartbeat.status"]).toBe("sent");
    expect(a["openclaw.heartbeat.channel"]).toBe("slack");
    expect(a["openclaw.heartbeat.duration_ms"]).toBe(1234);
    expect(a["openclaw.heartbeat.silent"]).toBe(false);
    expect(a["openclaw.heartbeat.has_media"]).toBe(true);
    expect(a["openclaw.heartbeat.indicator"]).toBe("ok");
    expect(a["openclaw.trigger"]).toBe("heartbeat");
    expect(a["openclaw.session.key"]).toBe("heartbeat:slack");
    expect(a["gen_ai.conversation.id"]).toBe("heartbeat:slack");
    // No PII/content
    expect(a["openclaw.heartbeat.to"]).toBeUndefined();
    expect(a["openclaw.heartbeat.preview"]).toBeUndefined();
    expect(Object.values(a)).not.toContain("secret heartbeat body");
    expect(Object.values(a)).not.toContain("slack:U1");
  });

  it("carries a skip reason and falls back to a bare 'heartbeat' key with no channel", () => {
    const a = heartbeatRunAttrs({ ts: 1, status: "skipped", reason: "quiet-hours" });
    expect(a["openclaw.heartbeat.status"]).toBe("skipped");
    expect(a["openclaw.heartbeat.reason"]).toBe("quiet-hours");
    expect(a["openclaw.session.key"]).toBe("heartbeat");
    expect(a["openclaw.heartbeat.channel"]).toBeUndefined();
  });

  it("defaults a missing status to 'unknown'", () => {
    expect(heartbeatRunAttrs({})["openclaw.heartbeat.status"]).toBe("unknown");
  });
});

describe("makeHeartbeatListener (emit + counter)", () => {
  it("emits one INTERNAL openclaw.heartbeat.run span per tick, spanning [ts-dur, ts]", () => {
    const h = hbHarness();
    const listen = makeHeartbeatListener({ tracer: h.tracer, heartbeatRuns: h.heartbeatRuns });
    listen({ ts: 10_000, status: "sent", durationMs: 200, channel: "slack" });
    const [run] = h.runs();
    expect(run).toBeDefined();
    expect(run.kind).toBe(SpanKind.INTERNAL);
    expect(run.attributes["openclaw.heartbeat.status"]).toBe("sent");
    expect(durMs(run)).toBeCloseTo(200, 3);
    // counter incremented, keyed by status
    expect(h.counts).toHaveLength(1);
    expect(h.counts[0]!.attrs["openclaw.heartbeat.status"]).toBe("sent");
  });

  it("sets ERROR span status (with the reason) when a tick failed", () => {
    const h = hbHarness();
    makeHeartbeatListener({ tracer: h.tracer })({
      ts: 1,
      status: "failed",
      reason: "agent-runner-failure",
    });
    const [run] = h.runs();
    expect(run.status.code).toBe(SpanStatusCode.ERROR);
    expect(run.status.message).toBe("agent-runner-failure");
  });

  it("falls back to injected now() when the event carries no ts", () => {
    const h = hbHarness();
    makeHeartbeatListener({ tracer: h.tracer, now: () => 7_000 })({ status: "ok-empty" });
    const [run] = h.runs();
    expect(run.endTime[0] * 1000 + run.endTime[1] / 1e6).toBeCloseTo(7_000, 0);
  });

  it("never throws on a garbage event (a bus listener must not block the next tick)", () => {
    const h = hbHarness();
    const listen = makeHeartbeatListener({ tracer: h.tracer, heartbeatRuns: h.heartbeatRuns });
    expect(() => listen(undefined as any)).not.toThrow();
    expect(() => listen(null as any)).not.toThrow();
    // degrades to an 'unknown'-status span rather than crashing the bus
    expect(h.runs().every((s) => s.attributes["openclaw.heartbeat.status"] === "unknown")).toBe(true);
  });

  it("guards a negative durationMs — no backwards span (clamps to a point span at ts)", () => {
    const h = hbHarness();
    makeHeartbeatListener({ tracer: h.tracer })({ ts: 5_000, status: "sent", durationMs: -100 });
    const [run] = h.runs();
    expect(durMs(run)).toBe(0); // not a backwards [5000, 4900] span
    expect(run.endTime[0] * 1000 + run.endTime[1] / 1e6).toBeCloseTo(5_000, 0);
  });
});

describe("initHeartbeat (source resolution)", () => {
  it("degrades to a no-op + warns when the heartbeat bus is unavailable (zero-dep test env)", async () => {
    const h = hbHarness();
    const warns: string[] = [];
    const stop = await initHeartbeat({ tracer: h.tracer, logger: { warn: (m) => warns.push(m) } });
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
    expect(warns.some((w) => w.includes("heartbeat bus unavailable"))).toBe(true);
  });
});
