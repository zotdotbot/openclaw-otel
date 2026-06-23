// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { parseConfig, normalizeContentCapturePolicy } from "../src/config";

describe("parseConfig sanitation", () => {
  it("drops non-string header and resourceAttribute values", () => {
    const cfg = parseConfig({
      headers: { authorization: "Bearer x", "x-bad": 42, "x-obj": { a: 1 } },
      resourceAttributes: { "deployment.environment": "prod", weight: 3.5 },
    });
    expect(cfg.headers).toEqual({ authorization: "Bearer x" });
    expect(cfg.resourceAttributes).toEqual({ "deployment.environment": "prod" });
  });

  it("coerces garbage map inputs to empty objects", () => {
    const cfg = parseConfig({ headers: "nope", resourceAttributes: [1, 2] });
    expect(cfg.headers).toEqual({});
    expect(cfg.resourceAttributes).toEqual({});
  });

  it("applies defaults for missing fields", () => {
    const cfg = parseConfig(undefined);
    expect(cfg.protocol).toBe("http");
    expect(cfg.serviceName).toBe("openclaw-gateway");
    expect(cfg.traces).toBe(true);
    expect(cfg.metrics).toBe(true);
    expect(cfg.logs).toBe(false);
    expect(cfg.heartbeat).toBe(false);
    expect(cfg.captureContent.toolOutputs).toBe(false);
  });

  it("parses the opt-in heartbeat flag (default off, boolean-only)", () => {
    expect(parseConfig({ heartbeat: true }).heartbeat).toBe(true);
    expect(parseConfig({ heartbeat: false }).heartbeat).toBe(false);
    expect(parseConfig({ heartbeat: "yes" }).heartbeat).toBe(false); // non-boolean → default
  });

  it("prefers an explicit endpoint over the env fallback", () => {
    expect(parseConfig({ endpoint: "http://x:4318" }).endpoint).toBe("http://x:4318");
  });

  it("falls back to OTEL_EXPORTER_OTLP_ENDPOINT when no endpoint is set", () => {
    const prev = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318";
    try {
      expect(parseConfig({}).endpoint).toBe("http://collector:4318");
    } finally {
      if (prev === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prev;
    }
  });

  it("defaults the zero-config endpoint to the protocol's port (gRPC 4317, HTTP 4318)", () => {
    const prev = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    try {
      // gRPC must NOT default to the HTTP port — that silently fails every export.
      expect(parseConfig({ protocol: "grpc" }).endpoint).toBe("http://localhost:4317");
      expect(parseConfig({ protocol: "http" }).endpoint).toBe("http://localhost:4318");
      expect(parseConfig({}).endpoint).toBe("http://localhost:4318");
    } finally {
      if (prev === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prev;
    }
  });

  it("the env-var endpoint overrides the protocol default for both protocols", () => {
    const prev = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4317";
    try {
      expect(parseConfig({ protocol: "grpc" }).endpoint).toBe("http://collector:4317");
      expect(parseConfig({ protocol: "http" }).endpoint).toBe("http://collector:4317");
    } finally {
      if (prev === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prev;
    }
  });
});

describe("sampleRate", () => {
  it("warns that sampleRate=0 drops all traces but still honors it", () => {
    const warnings: string[] = [];
    const cfg = parseConfig({ sampleRate: 0 }, { warn: (m) => warnings.push(m) });
    expect(cfg.sampleRate).toBe(0);
    expect(warnings.some((w) => w.includes("sampleRate=0"))).toBe(true);
  });

  it("accepts a valid in-range rate without warning", () => {
    const warnings: string[] = [];
    const cfg = parseConfig({ sampleRate: 0.25 }, { warn: (m) => warnings.push(m) });
    expect(cfg.sampleRate).toBe(0.25);
    expect(warnings).toHaveLength(0);
  });
});

describe("normalizeContentCapturePolicy", () => {
  it("true enables every category, false/undefined disables every category", () => {
    expect(normalizeContentCapturePolicy(true)).toEqual({
      inputMessages: true,
      outputMessages: true,
      toolInputs: true,
      toolOutputs: true,
      systemPrompt: true,
      cronSummary: true,
    });
    expect(normalizeContentCapturePolicy(false).inputMessages).toBe(false);
    expect(normalizeContentCapturePolicy(undefined).systemPrompt).toBe(false);
  });

  it("an object selects categories individually over a disabled baseline", () => {
    const p = normalizeContentCapturePolicy({ toolInputs: true, bogus: true });
    expect(p.toolInputs).toBe(true);
    expect(p.inputMessages).toBe(false);
    expect((p as unknown as Record<string, unknown>).bogus).toBeUndefined();
  });
});
