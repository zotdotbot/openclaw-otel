// SPDX-License-Identifier: Apache-2.0
//
// Frozen-contract consistency tests. These assert that the machine-readable
// contract (src/contract.ts) and the semconv constants (src/semconv.ts) agree
// with each other and stay internally well-formed. They are the regression
// guard that fails CI the moment the frozen vocabulary drifts.
//
// The full EMIT ORACLE — driving a real OTel SDK through a simulated turn and
// asserting every emitted span/metric against this contract — is implemented
// alongside the telemetry/hooks pipeline (see the `it.todo`s at the bottom).

import { describe, it, expect } from "vitest";

import {
  CONTRACT,
  CONTRACT_SPANS,
  CONTRACT_METRICS,
  EMITTED_SPANS,
  CONSUMER_ONLY_SPANS,
  RESOURCE_ATTRIBUTES,
  CORRELATION_KEYS,
  SCHEMA_VERSION,
  OTEL_SEMCONV_SCHEMA_URL,
  findSpanContract,
} from "../src/contract";
import * as sem from "../src/semconv";

describe("frozen schema version", () => {
  it("is pinned at 1.6.0 across contract and semconv", () => {
    expect(SCHEMA_VERSION).toBe("1.6.0");
    expect(sem.OPENCLAW_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  });

  it("pins the OTel semconv schema URL consistently", () => {
    expect(OTEL_SEMCONV_SCHEMA_URL).toBe(sem.OTEL_SCHEMA_URL);
  });
});

describe("emitted spans", () => {
  it("the plugin emits the connected-trace spans plus skill + re-homed operational spans", () => {
    expect(EMITTED_SPANS.map((s) => s.name)).toEqual([
      "openclaw.request",
      "openclaw.agent.turn",
      "chat ",
      "execute_tool ",
      "openclaw.message.sent",
      "openclaw.skill.used",
      "openclaw.context.assembled",
      "openclaw.harness.run",
      "openclaw.message.processed",
      "openclaw.message.delivery",
      "openclaw.cron.run",
      "openclaw.cron.definition",
      "openclaw.heartbeat.run",
    ]);
  });

  it("carry the primary correlation key as a required attribute", () => {
    for (const span of EMITTED_SPANS) {
      expect(span.requiredAttributes).toContain(CORRELATION_KEYS[0]);
    }
  });

  it("each declare at least one required attribute", () => {
    for (const span of EMITTED_SPANS) {
      expect(span.requiredAttributes.length).toBeGreaterThan(0);
    }
  });

  it("prefix spans embed a trailing space and match runtime names", () => {
    const chat = CONTRACT_SPANS.find((s) => s.name === "chat ")!;
    const tool = CONTRACT_SPANS.find((s) => s.name === "execute_tool ")!;
    expect(chat.match).toBe("prefix");
    expect(tool.match).toBe("prefix");
    expect(chat.name).toBe(sem.SPAN_PREFIX_CHAT);
    expect(tool.name).toBe(sem.SPAN_PREFIX_EXECUTE_TOOL);
    expect(chat.name.endsWith(" ")).toBe(true);
    expect(tool.name.endsWith(" ")).toBe(true);
  });
});

describe("consumer-demanded built-ins", () => {
  it("are documented but NOT emitted by the plugin", () => {
    expect(CONSUMER_ONLY_SPANS.map((s) => s.name)).toEqual([
      "openclaw.run",
      "openclaw.model.usage",
    ]);
    for (const span of CONSUMER_ONLY_SPANS) {
      expect(span.emittedByPlugin).toBe(false);
    }
  });
});

describe("findSpanContract", () => {
  it("resolves exact and prefix span names", () => {
    expect(findSpanContract("openclaw.request")?.name).toBe("openclaw.request");
    expect(findSpanContract("openclaw.agent.turn")?.name).toBe("openclaw.agent.turn");
    expect(findSpanContract(sem.spanNameChat("claude-opus-4-6"))?.name).toBe("chat ");
    expect(findSpanContract(sem.spanNameExecuteTool("exec"))?.name).toBe("execute_tool ");
    expect(findSpanContract("openclaw.message.sent")?.name).toBe("openclaw.message.sent");
  });

  it("returns undefined for an unknown span name", () => {
    expect(findSpanContract("totally.unknown.span")).toBeUndefined();
  });
});

describe("metrics", () => {
  it("declares exactly one consumer-read metric: the stalled-session counter", () => {
    const read = CONTRACT_METRICS.filter((m) => m.readByConsumer);
    expect(read).toHaveLength(1);
    expect(read[0]!.name).toBe(sem.METRIC_OPENCLAW_SESSION_STALLED);
    expect(read[0]!.instrument).toBe("Counter");
    expect(read[0]!.keyedBy).toContain(sem.OPENCLAW_SESSION_KEY);
  });

  it("declares the opt-in cron/heartbeat run counters (status-keyed, not consumer-read)", () => {
    const cron = CONTRACT_METRICS.find((m) => m.name === sem.METRIC_OPENCLAW_CRON_RUNS)!;
    const hb = CONTRACT_METRICS.find((m) => m.name === sem.METRIC_OPENCLAW_HEARTBEAT_RUNS)!;
    expect(cron.instrument).toBe("Counter");
    expect(cron.readByConsumer).toBe(false);
    expect(cron.keyedBy).toContain(sem.OPENCLAW_CRON_STATUS);
    expect(cron.keyedBy).toContain(sem.OPENCLAW_CRON_JOB_ID);
    expect(hb.instrument).toBe("Counter");
    expect(hb.readByConsumer).toBe(false);
    expect(hb.keyedBy).toContain(sem.OPENCLAW_HEARTBEAT_STATUS);
  });
});

describe("resource attributes", () => {
  it("include service identity and the plugin schema version", () => {
    expect(RESOURCE_ATTRIBUTES).toContain("service.name");
    expect(RESOURCE_ATTRIBUTES).toContain("service.version");
    expect(RESOURCE_ATTRIBUTES).toContain(sem.RESOURCE_OPENCLAW_SCHEMA_VERSION);
  });
});

describe("aggregate CONTRACT object", () => {
  it("references the same span/metric tables", () => {
    expect(CONTRACT.spans).toBe(CONTRACT_SPANS);
    expect(CONTRACT.metrics).toBe(CONTRACT_METRICS);
    expect(CONTRACT.schemaVersion).toBe(SCHEMA_VERSION);
    expect(CONTRACT.correlationKeys).toEqual([
      "gen_ai.conversation.id",
      "openclaw.session.key",
    ]);
  });
});
