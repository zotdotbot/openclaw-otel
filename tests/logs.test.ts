// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { severityForEvent, eventToAttributes, initLogs } from "../src/logs";
import { parseConfig, CONTENT_POLICY_ENABLED } from "../src/config";
import { CONTENT_MAX_CHARS } from "../src/hooks";

describe("eventToAttributes content gate", () => {
  it("capture OFF (default): emits scalars + content-free objects + safe string keys, drops content", () => {
    const a = eventToAttributes({
      type: "model.usage",
      sessionKey: "s",
      cost: 0.01, // number → always safe
      ok: true, // boolean → always safe
      model: "claude", // safe metadata string key
      prompt: "secret user text", // content string → dropped
      usage: { input: 10, output: 5 }, // structurally content-free object → kept
      tags: ["a", "b"], // string array → dropped
    });
    expect(a["openclaw.session.key"]).toBe("s");
    expect(a["openclaw.diag.cost"]).toBe(0.01);
    expect(a["openclaw.diag.ok"]).toBe(true);
    expect(a["openclaw.diag.model"]).toBe("claude");
    expect(a["openclaw.diag.usage"]).toBe('{"input":10,"output":5}');
    expect(a["openclaw.diag.prompt"]).toBeUndefined(); // content NOT leaked
    expect(a["openclaw.diag.tags"]).toBeUndefined(); // content NOT leaked
  });

  it("capture ON: emits content strings and string-bearing objects/arrays", () => {
    const a = eventToAttributes(
      { type: "x", prompt: "hi", tags: ["a", "b"], params: { q: "find" } },
      CONTENT_POLICY_ENABLED,
    );
    expect(a["openclaw.diag.prompt"]).toBe("hi");
    expect(a["openclaw.diag.tags"]).toBe('["a","b"]');
    expect(a["openclaw.diag.params"]).toBe('{"q":"find"}');
  });

  it("bounds every stringified value to CONTENT_MAX_CHARS", () => {
    const big = "x".repeat(CONTENT_MAX_CHARS + 500);
    const a = eventToAttributes({ type: "x", note: big }, CONTENT_POLICY_ENABLED);
    expect((a["openclaw.diag.note"] as string).length).toBe(CONTENT_MAX_CHARS);
  });

  it("keeps categorical incident codes (errorCode/reason) with capture off", () => {
    const a = eventToAttributes({
      type: "model.error",
      sessionKey: "s",
      errorCode: "rate_limited", // *Code suffix → safe
      reason: "overloaded", // explicit safe key
      message: "upstream said: <user text>", // content → dropped
    });
    expect(a["openclaw.diag.errorCode"]).toBe("rate_limited");
    expect(a["openclaw.diag.reason"]).toBe("overloaded");
    expect(a["openclaw.diag.message"]).toBeUndefined();
  });

  it("does not stack-overflow on a cyclic diagnostic payload (capture off)", () => {
    const cyclic: Record<string, unknown> = { n: 1 };
    cyclic.self = cyclic;
    let a: Record<string, string | number | boolean> = {};
    expect(() => {
      a = eventToAttributes({ type: "x", sessionKey: "s", cyclic });
    }).not.toThrow();
    expect(a["openclaw.session.key"]).toBe("s");
    expect(a["openclaw.diag.cyclic"]).toBeUndefined(); // dropped, not crashed
  });

  it("skips exotic/unserializable values without throwing (capture on)", () => {
    let a: Record<string, string | number | boolean> = {};
    expect(() => {
      a = eventToAttributes(
        { type: "x", ok: 5, big: 10n, fn: () => 1 },
        CONTENT_POLICY_ENABLED,
      );
    }).not.toThrow();
    expect(a["openclaw.diag.ok"]).toBe(5);
    expect(a["openclaw.diag.big"]).toBeUndefined();
    expect(a["openclaw.diag.fn"]).toBeUndefined();
  });
});

describe("severityForEvent", () => {
  it("maps error → ERROR, stall/stuck → WARN, else INFO", () => {
    expect(severityForEvent("model.error")).toBe(SeverityNumber.ERROR);
    expect(severityForEvent("webhook.error")).toBe(SeverityNumber.ERROR);
    expect(severityForEvent("session.stalled")).toBe(SeverityNumber.WARN);
    expect(severityForEvent("session.stuck")).toBe(SeverityNumber.WARN);
    expect(severityForEvent("model.usage")).toBe(SeverityNumber.INFO);
  });

  it("escalates on an error/warn outcome even when the type reads neutrally", () => {
    expect(severityForEvent("tool.execution", "error")).toBe(SeverityNumber.ERROR);
    expect(severityForEvent("session.tick", "timed_out")).toBe(SeverityNumber.WARN);
    expect(severityForEvent("model.usage", "ok")).toBe(SeverityNumber.INFO);
  });
});

describe("initLogs", () => {
  it("builds a runtime that emits a diagnostic event and drains cleanly", async () => {
    const rt = initLogs(parseConfig({ endpoint: "http://localhost:4318" }));
    expect(() =>
      rt.emitEvent({ type: "model.usage", sessionKey: "s", input: 10, model: "m" }),
    ).not.toThrow();
    await expect(rt.flush()).resolves.toBeUndefined();
    await rt.shutdown();
  });

  it("forwards the logger so an invalid gRPC metadata key is surfaced on the logs pipeline", async () => {
    const warnings: string[] = [];
    const rt = initLogs(
      parseConfig({ logs: true, protocol: "grpc", headers: { "bad key": "x" } }),
      { warn: (m) => warnings.push(m) },
    );
    expect(warnings.some((w) => w.includes("bad key"))).toBe(true);
    await rt.shutdown();
  });

  it("flush after shutdown is a no-op and shutdown is idempotent", async () => {
    const rt = initLogs(parseConfig({ logs: true }));
    await rt.shutdown();
    await expect(rt.flush()).resolves.toBeUndefined();
    await expect(rt.shutdown()).resolves.toBeUndefined();
  });
});
