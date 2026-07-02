// SPDX-License-Identifier: Apache-2.0

/**
 * OpenTelemetry runtime: providers, exporters, resource, and instruments.
 *
 * Design invariant — NO GLOBAL REGISTRATION. We build `NodeTracerProvider` /
 * `MeterProvider` instances and pull the tracer/meter from them directly. We
 * never call `trace.setGlobalTracerProvider` / `metrics.setGlobalMeterProvider`
 * / `provider.register()`. That keeps the plugin's OTel state private to its
 * own bundle, so a self-contained build never collides with OpenClaw's built-in
 * `diagnostics.otel` over the `@opentelemetry/api` globalThis singleton — which
 * is what lets us ship one file with zero runtime deps. The plugin threads span
 * context explicitly via the trace-context store rather than the global active
 * context.
 */

import { ProxyTracerProvider } from "@opentelemetry/api";
import type { Tracer, Meter, Counter, Histogram } from "@opentelemetry/api";
import { Metadata } from "@grpc/grpc-js";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { Resource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-node";
import type { Sampler } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter as OTLPTraceExporterHTTP } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as OTLPTraceExporterGRPC } from "@opentelemetry/exporter-trace-otlp-grpc";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter as OTLPMetricExporterHTTP } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as OTLPMetricExporterGRPC } from "@opentelemetry/exporter-metrics-otlp-grpc";

import type { OtelObservabilityConfig } from "./config";
import { PLUGIN_ID, PLUGIN_VERSION } from "./version";
import { resolveHostVersion } from "./host-version";
import { SCHEMA_VERSION, OTEL_SEMCONV_SCHEMA_URL } from "./contract";
import {
  RESOURCE_OPENCLAW_PLUGIN,
  RESOURCE_OPENCLAW_SCHEMA_VERSION,
  RESOURCE_OPENCLAW_VERSION,
  METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
  METRIC_OPENCLAW_SESSION_STALLED,
  METRIC_OPENCLAW_CRON_RUNS,
  METRIC_OPENCLAW_HEARTBEAT_RUNS,
} from "./semconv";

/** Instrumentation-scope name on every emitted span and metric. */
export const INSTRUMENTATION_SCOPE = "@zotdotbot/openclaw-otel";

/** Minimal logger surface (matches the OpenClaw gateway logger / console). */
export interface TelemetryLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

/**
 * The frozen-contract metric instruments. `sessionStalled` is read by the
 * consumer; the two histograms feed external dashboards; the two run counters
 * (`cronRuns`/`heartbeatRuns`) are opt-in convenience series for cheap
 * `rate(...{status='error'})` alerting (the cron/heartbeat spans remain the
 * source of truth). Additional internal instruments, if ever needed, are
 * created by their call sites — they are not part of this contract surface.
 */
export interface TelemetryInstruments {
  /** `gen_ai.client.token.usage` histogram (standard GenAI semconv). */
  tokenUsage: Histogram;
  /** `gen_ai.client.operation.duration` histogram (standard GenAI semconv). */
  operationDuration: Histogram;
  /** `openclaw.session.stalled` counter — the one consumer-read metric. */
  sessionStalled: Counter;
  /** `openclaw.cron.runs` counter — keyed by status + job_id (opt-in alerting). */
  cronRuns: Counter;
  /** `openclaw.heartbeat.runs` counter — keyed by status (opt-in alerting). */
  heartbeatRuns: Counter;
}

export interface TelemetryRuntime {
  tracer: Tracer;
  meter: Meter;
  instruments: TelemetryInstruments;
  /** Number of real exporting providers built (0 when both signals disabled).
   *  Lets callers/tests assert the disabled path created nothing. */
  readonly providerCount: number;
  /** Non-destructive: drain pending spans/metrics; providers stay usable
   *  afterwards (safe on OpenClaw config hot-reload). No-op after shutdown. */
  flush: () => Promise<void>;
  /** Destructive: shut providers down (process exit / plugin disable).
   *  Idempotent. */
  shutdown: () => Promise<void>;
}

/** Providers expose forceFlush()/shutdown(); captured structurally so the
 *  runtime can drain/close whichever signals were enabled. */
interface FlushableProvider {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

// ── Resource ────────────────────────────────────────────────────────────────

/** The four Resource keys that carry the plugin's contract identity. An operator
 *  override of any of these would silently break the consumer's
 *  `service.name`-keyed ingestion (a total telemetry blackout with no error), so
 *  they are set AFTER operator extras and a collision is warned, not honored. */
const RESERVED_RESOURCE_KEYS: readonly string[] = [
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  RESOURCE_OPENCLAW_PLUGIN,
  RESOURCE_OPENCLAW_SCHEMA_VERSION,
];

/** Build the OTel Resource carrying the four contract resource attributes plus
 *  any operator-supplied extras, tagged with the pinned semconv schema URL.
 *  Operator extras are spread FIRST so the contract identity always wins (see
 *  {@link RESERVED_RESOURCE_KEYS}); a reserved-key collision is logged.
 *  `hostVersion` (callers pass {@link resolveHostVersion}) stamps the
 *  BEST-EFFORT `openclaw.version`: a resolved value wins over an operator
 *  extra (ground truth beats config, no warning — it is not an identity key);
 *  when unresolved, an operator-supplied `openclaw.version` passes through as
 *  the manual escape hatch. */
export function buildResource(
  config: OtelObservabilityConfig,
  logger?: TelemetryLogger,
  hostVersion?: string,
): Resource {
  const collisions = RESERVED_RESOURCE_KEYS.filter(
    (k) => k in config.resourceAttributes,
  );
  if (collisions.length > 0) {
    logger?.warn?.(
      `[otel] ignoring resourceAttributes override of reserved key(s) ` +
        `${collisions.join(", ")} — these carry the plugin's contract identity; ` +
        `overriding them would break consumer ingestion.`,
    );
  }
  return resourceFromAttributes(
    {
      ...config.resourceAttributes,
      ...(hostVersion !== undefined
        ? { [RESOURCE_OPENCLAW_VERSION]: hostVersion }
        : {}),
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: PLUGIN_VERSION,
      [RESOURCE_OPENCLAW_PLUGIN]: PLUGIN_ID,
      [RESOURCE_OPENCLAW_SCHEMA_VERSION]: SCHEMA_VERSION,
    },
    { schemaUrl: OTEL_SEMCONV_SCHEMA_URL },
  );
}

// ── Sampler ───────────────────────────────────────────────────────────────

/**
 * Head-based sampler. When `sampleRate` is set we wrap a ratio sampler in a
 * ParentBasedSampler so child spans inherit the root decision and distributed
 * traces stay coherent. When unset we return `undefined` so the SDK default
 * (`parentbased_always_on`) applies — we intentionally omit the key rather than
 * pass `undefined`.
 */
export function buildSampler(config: OtelObservabilityConfig): Sampler | undefined {
  if (config.sampleRate === undefined) return undefined;
  return new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(config.sampleRate),
  });
}

// ── Exporters ───────────────────────────────────────────────────────────────

/**
 * Build an OTLP/HTTP signal URL. Strips trailing slashes so the appended path
 * never doubles up, and is idempotent if the operator already supplied a
 * signal-qualified endpoint (e.g. `http://host:4318/v1/traces`) — appending
 * again would 404 on strict collectors.
 */
export function httpSignalUrl(endpoint: string, signalPath: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith(signalPath) ? base : `${base}${signalPath}`;
}

/**
 * Translate config headers into gRPC Metadata. The OTLP/gRPC exporter accepts
 * `metadata` (grpc.Metadata), NOT `headers` — passing `headers` is silently
 * dropped (the SDK warns via the OTel diag logger, which this plugin never
 * registers), so an operator using gRPC with auth headers would lose every
 * export with no signal. Exported for direct unit testing of that translation.
 *
 * grpc `Metadata.set()` throws on keys outside its grammar (spaces, non-ASCII,
 * uppercase-only edge cases, etc.). We skip an offending header rather than let
 * one bad key abort exporter construction and disable all telemetry.
 */
export function grpcMetadata(
  headers: Record<string, string>,
  logger?: TelemetryLogger,
): Metadata {
  const md = new Metadata();
  for (const [key, value] of Object.entries(headers)) {
    try {
      md.set(key, value);
    } catch {
      // Skip this header (invalid gRPC metadata key) but keep the rest — AND
      // surface it. Silently dropping an auth header is a nasty silent 401.
      logger?.warn?.(
        `[otel] dropped OTLP header with invalid gRPC metadata key: ${key}`,
      );
    }
  }
  return md;
}

/**
 * Strip URL userinfo (`user:pass@`) from an endpoint for safe display/logging.
 * An endpoint like `https://user:token@collector:4318` would otherwise leak the
 * embedded credential into logs AND — via the `otel_status` tool / `.status` RPC
 * — to the LLM. The exporters still dial the full endpoint; only display does.
 */
export function redactEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    if (!u.username && !u.password) return endpoint;
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    // Not a parseable URL — best-effort strip of the WHOLE `//userinfo@` segment.
    // `[^/]+@` (greedy, up to the last @ before the host) so a credential that
    // itself contains an @ is fully removed, not truncated at the first @.
    return endpoint.replace(/\/\/[^/]+@/, "//");
  }
}

export function buildSpanExporter(
  config: OtelObservabilityConfig,
  logger?: TelemetryLogger,
) {
  if (config.protocol === "grpc") {
    return new OTLPTraceExporterGRPC({
      url: config.endpoint,
      metadata: grpcMetadata(config.headers, logger),
    });
  }
  return new OTLPTraceExporterHTTP({
    url: httpSignalUrl(config.endpoint, "/v1/traces"),
    headers: config.headers,
  });
}

export function buildMetricExporter(
  config: OtelObservabilityConfig,
  logger?: TelemetryLogger,
) {
  if (config.protocol === "grpc") {
    return new OTLPMetricExporterGRPC({
      url: config.endpoint,
      metadata: grpcMetadata(config.headers, logger),
    });
  }
  return new OTLPMetricExporterHTTP({
    url: httpSignalUrl(config.endpoint, "/v1/metrics"),
    headers: config.headers,
  });
}

// ── Instruments ─────────────────────────────────────────────────────────────

export function buildInstruments(meter: Meter): TelemetryInstruments {
  return {
    tokenUsage: meter.createHistogram(METRIC_GEN_AI_CLIENT_TOKEN_USAGE, {
      description: "Number of input and output tokens used per GenAI operation",
      unit: "{token}",
    }),
    operationDuration: meter.createHistogram(METRIC_GEN_AI_CLIENT_OPERATION_DURATION, {
      description: "GenAI operation duration",
      unit: "s",
    }),
    sessionStalled: meter.createCounter(METRIC_OPENCLAW_SESSION_STALLED, {
      description: "Sessions that stalled (wedged, never completed)",
      unit: "{session}",
    }),
    cronRuns: meter.createCounter(METRIC_OPENCLAW_CRON_RUNS, {
      description: "Cron scheduler firings, keyed by status + job_id",
      unit: "{run}",
    }),
    heartbeatRuns: meter.createCounter(METRIC_OPENCLAW_HEARTBEAT_RUNS, {
      description: "Heartbeat ticks emitted on the bus, keyed by status",
      unit: "{run}",
    }),
  };
}

// ── Runtime ───────────────────────────────────────────────────────────────

/**
 * Build the telemetry runtime from config. Honors the per-signal toggles:
 * a disabled signal gets a no-op tracer/meter (the API's global proxy, which
 * is a NoopTracerProvider because we never register a real one) and creates no
 * provider, so nothing is exported.
 */
export function initTelemetry(
  config: OtelObservabilityConfig,
  logger?: TelemetryLogger,
): TelemetryRuntime {
  const resource = buildResource(config, logger, resolveHostVersion(process.argv[1]));
  const providers: FlushableProvider[] = [];

  // ── Traces ──
  let tracer: Tracer;
  if (config.traces) {
    const sampler = buildSampler(config);
    const tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(buildSpanExporter(config, logger))],
      ...(sampler ? { sampler } : {}),
    });
    providers.push(tracerProvider);
    tracer = tracerProvider.getTracer(INSTRUMENTATION_SCOPE, PLUGIN_VERSION, {
      schemaUrl: OTEL_SEMCONV_SCHEMA_URL,
    });
    logger?.info?.(
      `[otel] trace exporter → ${config.endpoint} (${config.protocol})` +
        (sampler ? ` sampler=parentbased_ratio(${config.sampleRate})` : ""),
    );
  } else {
    // Disabled: a delegate-less ProxyTracerProvider yields a genuine NoopTracer
    // without reading or registering any global, so a host-registered global
    // TracerProvider (e.g. OpenClaw's diagnostics.otel) cannot capture our
    // "disabled" spans.
    tracer = new ProxyTracerProvider().getTracer(INSTRUMENTATION_SCOPE, PLUGIN_VERSION);
  }

  // ── Metrics ──
  let meter: Meter;
  if (config.metrics) {
    const meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: buildMetricExporter(config, logger),
          exportIntervalMillis: config.metricsIntervalMs,
        }),
      ],
    });
    providers.push(meterProvider);
    meter = meterProvider.getMeter(INSTRUMENTATION_SCOPE, PLUGIN_VERSION, {
      schemaUrl: OTEL_SEMCONV_SCHEMA_URL,
    });
    logger?.info?.(
      `[otel] metric exporter → ${config.endpoint} ` +
        `(${config.protocol}, interval=${config.metricsIntervalMs}ms)`,
    );
  } else {
    // Disabled: a LOCAL readerless MeterProvider is a genuine, isolated noop —
    // with no reader nothing collects or exports the measurements, no timer is
    // created, and it reads/writes no global state, so a host-registered global
    // meter provider (OpenClaw's diagnostics.otel) cannot capture our disabled
    // metrics. Not added to `providers` (nothing to flush/shut down).
    meter = new MeterProvider({ resource }).getMeter(
      INSTRUMENTATION_SCOPE,
      PLUGIN_VERSION,
    );
  }

  const instruments = buildInstruments(meter);

  // Guard so a post-shutdown flush (e.g. service.stop firing after gateway_stop)
  // is a clean no-op instead of triggering "force flush after shutdown" SDK
  // warnings, and so shutdown is idempotent.
  let shutDown = false;

  const flush = async (): Promise<void> => {
    if (shutDown) return;
    for (const p of providers) {
      try {
        await p.forceFlush();
      } catch (err) {
        logger?.warn?.(`[otel] flush error: ${String(err)}`);
      }
    }
  };

  const shutdown = async (): Promise<void> => {
    if (shutDown) return;
    shutDown = true;
    for (const p of providers) {
      try {
        await p.shutdown();
      } catch (err) {
        logger?.warn?.(`[otel] shutdown error: ${String(err)}`);
      }
    }
  };

  return {
    tracer,
    meter,
    instruments,
    providerCount: providers.length,
    flush,
    shutdown,
  };
}
