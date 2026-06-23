// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { OTLPTraceExporter as HttpTrace } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as GrpcTrace } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPMetricExporter as HttpMetric } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as GrpcMetric } from "@opentelemetry/exporter-metrics-otlp-grpc";

import { parseConfig } from "../src/config";
import {
  buildResource,
  buildSampler,
  buildSpanExporter,
  buildMetricExporter,
  grpcMetadata,
  httpSignalUrl,
  redactEndpoint,
  initTelemetry,
} from "../src/telemetry";
import { PLUGIN_ID, PLUGIN_VERSION } from "../src/version";
import { SCHEMA_VERSION } from "../src/contract";

describe("buildResource", () => {
  it("carries the four contract resource attributes with correct values", () => {
    const r = buildResource(parseConfig({ serviceName: "svc-x" }));
    expect(r.attributes["service.name"]).toBe("svc-x");
    expect(r.attributes["service.version"]).toBe(PLUGIN_VERSION);
    expect(r.attributes["openclaw.plugin"]).toBe(PLUGIN_ID);
    expect(r.attributes["openclaw.schema.version"]).toBe(SCHEMA_VERSION);
  });

  it("merges operator-supplied resource attributes", () => {
    const r = buildResource(
      parseConfig({ resourceAttributes: { "deployment.environment": "prod" } }),
    );
    expect(r.attributes["deployment.environment"]).toBe("prod");
  });

  it("does NOT let operator resourceAttributes clobber the contract identity keys", () => {
    // A colliding service.name would silently blackhole telemetry at the
    // consumer's service-name-keyed ingestion — identity must win.
    const r = buildResource(
      parseConfig({
        serviceName: "real-svc",
        resourceAttributes: {
          "service.name": "attacker",
          "openclaw.schema.version": "9.9.9",
          "deployment.environment": "prod", // non-reserved extra still merges
        },
      }),
    );
    expect(r.attributes["service.name"]).toBe("real-svc");
    expect(r.attributes["openclaw.schema.version"]).toBe(SCHEMA_VERSION);
    expect(r.attributes["deployment.environment"]).toBe("prod");
  });

  it("warns when resourceAttributes collide with a reserved identity key", () => {
    const warnings: string[] = [];
    buildResource(parseConfig({ resourceAttributes: { "service.name": "x" } }), {
      warn: (m) => warnings.push(m),
    });
    expect(warnings.some((w) => w.includes("service.name"))).toBe(true);
  });
});

describe("buildSampler", () => {
  it("returns undefined when no sampleRate is set (SDK default applies)", () => {
    expect(buildSampler(parseConfig({}))).toBeUndefined();
  });
  it("returns a parent-based sampler when sampleRate is set", () => {
    const sampler = buildSampler(parseConfig({ sampleRate: 0.25 }));
    expect(sampler).toBeDefined();
    expect(sampler!.toString()).toContain("ParentBased");
  });
});

describe("exporter selection by protocol", () => {
  it("picks HTTP exporters for protocol=http", () => {
    expect(buildSpanExporter(parseConfig({ protocol: "http" }))).toBeInstanceOf(HttpTrace);
    expect(buildMetricExporter(parseConfig({ protocol: "http" }))).toBeInstanceOf(HttpMetric);
  });
  it("picks gRPC exporters for protocol=grpc", () => {
    expect(buildSpanExporter(parseConfig({ protocol: "grpc" }))).toBeInstanceOf(GrpcTrace);
    expect(buildMetricExporter(parseConfig({ protocol: "grpc" }))).toBeInstanceOf(GrpcMetric);
  });
});

describe("grpcMetadata", () => {
  it("translates config headers into gRPC metadata so auth survives the gRPC path", () => {
    // Regression guard: the OTLP/gRPC exporter takes `metadata`, not `headers` —
    // passing headers silently drops auth and every export is rejected.
    const md = grpcMetadata({ authorization: "Bearer tok", "x-tenant": "acme" });
    expect(md.get("authorization")).toEqual(["Bearer tok"]);
    expect(md.get("x-tenant")).toEqual(["acme"]);
  });
  it("produces empty metadata for no headers", () => {
    expect(grpcMetadata({}).get("authorization")).toEqual([]);
  });
  it("skips invalid gRPC metadata keys instead of aborting construction", () => {
    let md: ReturnType<typeof grpcMetadata> | undefined;
    expect(() => {
      md = grpcMetadata({ "bad key": "v", authorization: "ok" });
    }).not.toThrow();
    expect(md!.get("authorization")).toEqual(["ok"]);
  });
  it("warns via the logger when a header is dropped (no silent auth loss)", () => {
    const warnings: string[] = [];
    grpcMetadata({ "bad key": "v" }, { warn: (m) => warnings.push(m) });
    expect(warnings.some((w) => w.includes("bad key"))).toBe(true);
  });
});

describe("redactEndpoint", () => {
  it("strips userinfo credentials from an endpoint", () => {
    expect(redactEndpoint("https://user:token@collector:4318")).toBe(
      "https://collector:4318/",
    );
  });
  it("passes a credential-free endpoint through unchanged", () => {
    expect(redactEndpoint("http://localhost:4318")).toBe("http://localhost:4318");
  });
  it("best-effort strips userinfo from a non-URL string", () => {
    expect(redactEndpoint("//user:pass@host")).toBe("//host");
  });
  it("strips the FULL userinfo even when the credential contains @ (fallback path)", () => {
    // Regression guard: the regex must consume up to the LAST @ before the host,
    // or a password with an @ leaks its tail into logs / the otel_status payload.
    expect(redactEndpoint("//user:p@ss@host")).toBe("//host");
  });
});

describe("httpSignalUrl", () => {
  it("appends the signal path to a bare endpoint", () => {
    expect(httpSignalUrl("http://h:4318", "/v1/traces")).toBe("http://h:4318/v1/traces");
  });
  it("normalizes a trailing slash (no double slash)", () => {
    expect(httpSignalUrl("http://h:4318/", "/v1/metrics")).toBe("http://h:4318/v1/metrics");
  });
  it("is idempotent for an already signal-qualified endpoint", () => {
    expect(httpSignalUrl("http://h:4318/v1/traces", "/v1/traces")).toBe(
      "http://h:4318/v1/traces",
    );
  });
});

describe("initTelemetry", () => {
  it("builds a runtime with the contract instruments and two providers, drains cleanly", async () => {
    const rt = initTelemetry(parseConfig({ endpoint: "http://localhost:4318" }));
    expect(rt.providerCount).toBe(2); // traces + metrics both default on
    expect(rt.tracer).toBeDefined();
    expect(rt.meter).toBeDefined();
    expect(rt.instruments.tokenUsage).toBeDefined();
    expect(rt.instruments.operationDuration).toBeDefined();
    expect(rt.instruments.sessionStalled).toBeDefined();
    // Opt-in run counters (Phase 4)
    expect(rt.instruments.cronRuns).toBeDefined();
    expect(rt.instruments.heartbeatRuns).toBeDefined();
    await expect(rt.flush()).resolves.toBeUndefined();
    await rt.shutdown();
  });

  it("builds no exporting providers when both signals are disabled", async () => {
    const rt = initTelemetry(parseConfig({ traces: false, metrics: false }));
    expect(rt.providerCount).toBe(0);
    expect(rt.tracer).toBeDefined();
    expect(rt.instruments.sessionStalled).toBeDefined();
    await expect(rt.flush()).resolves.toBeUndefined();
    await expect(rt.shutdown()).resolves.toBeUndefined();
  });

  it("builds exactly one provider when only one signal is enabled", async () => {
    const rt = initTelemetry(parseConfig({ traces: true, metrics: false }));
    expect(rt.providerCount).toBe(1);
    await rt.shutdown();
  });

  it("flush is a no-op after shutdown (no post-shutdown SDK warnings)", async () => {
    const rt = initTelemetry(parseConfig({ traces: true, metrics: true }));
    await rt.shutdown();
    await expect(rt.flush()).resolves.toBeUndefined();
    await expect(rt.shutdown()).resolves.toBeUndefined();
  });
});
