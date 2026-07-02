// SPDX-License-Identifier: Apache-2.0

/**
 * Optional OTLP logs pipeline, gated by `config.logs` (default off).
 *
 * Rather than wrapping the gateway logger (the upstream approach, with filters
 * and redaction), this bridges OpenClaw DIAGNOSTIC EVENTS to OTel LogRecords —
 * a lean, genuinely useful "diagnostics → logs" stream (model usage,
 * stalled/stuck sessions, errors). Instance-based LoggerProvider, no global
 * registration. Logs are NOT part of the consumer wire contract.
 *
 * Content is gated by the same `captureContent` policy as the trace path: with
 * capture off (the default) the bridge emits operational metadata only — never
 * prompts/replies/tool I/O — so enabling `logs` cannot leak content. See
 * {@link eventToAttributes}.
 */

import { SeverityNumber } from "@opentelemetry/api-logs";
import type { Logger } from "@opentelemetry/api-logs";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter as OTLPLogExporterHTTP } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as OTLPLogExporterGRPC } from "@opentelemetry/exporter-logs-otlp-grpc";

import type { OtelObservabilityConfig, ContentCapturePolicy } from "./config";
import { CONTENT_POLICY_DISABLED } from "./config";
import {
  buildResource,
  grpcMetadata,
  httpSignalUrl,
  INSTRUMENTATION_SCOPE,
  type TelemetryLogger,
} from "./telemetry";
import { CONTENT_MAX_CHARS } from "./hooks";
import { PLUGIN_VERSION } from "./version";
import { resolveHostVersion } from "./host-version";
import { OTEL_SEMCONV_SCHEMA_URL } from "./contract";
import { OPENCLAW_SESSION_KEY } from "./semconv";

type AnyEvent = Record<string, any>;

export interface LogRuntime {
  /** Emit a LogRecord built from an OpenClaw diagnostic event. */
  emitEvent(event: AnyEvent): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Map a diagnostic event to an OTel severity, keying off BOTH the type string
 *  and the `outcome` field — an error-outcome event whose type reads neutrally
 *  (e.g. `tool.execution` with `outcome:"error"`) should still log at ERROR. */
export function severityForEvent(type: string, outcome?: string): SeverityNumber {
  const s = outcome ? `${type} ${outcome}` : type;
  if (/error|fail/i.test(s)) return SeverityNumber.ERROR;
  if (/stalled|stuck|long_running|timeout|timed_out/i.test(s)) return SeverityNumber.WARN;
  return SeverityNumber.INFO;
}

/**
 * String-valued diagnostic keys that are known operational metadata (ids, model
 * names, categorical outcomes), NOT user/model content. Numbers and booleans are
 * always safe (counts, sizes, durations, costs, flags); only STRING values can
 * carry prompts/replies/tool I/O, so a string is emitted with content capture
 * off only when its key is on this allowlist (or matches {@link SAFE_KEY_SUFFIX}).
 */
const SAFE_STRING_KEYS = new Set<string>([
  "model",
  "provider",
  "outcome",
  "status",
  "channel",
  "direction",
  "phase",
  "kind",
  "tool",
  "toolName",
  "skill",
  "skillName",
  "operation",
  "operationName",
  // Categorical incident metadata — short codes/enums, not free text. Kept
  // available with capture off so logs stay useful during failures.
  "code",
  "reason",
]);

/** Identifier / categorical-code key suffixes that are also safe string keys
 *  (e.g. conversationId, requestId, errorKind, failureKind, errorCategory,
 *  errorCode, statusCode). */
const SAFE_KEY_SUFFIX = /(Id|Kind|Category|Code)$/;

function isSafeStringKey(key: string): boolean {
  return SAFE_STRING_KEYS.has(key) || SAFE_KEY_SUFFIX.test(key);
}

function anyContentEnabled(p: ContentCapturePolicy): boolean {
  return (
    p.inputMessages ||
    p.outputMessages ||
    p.toolInputs ||
    p.toolOutputs ||
    p.systemPrompt
  );
}

/**
 * True if a value is structurally incapable of carrying text content — a number,
 * boolean, null, or an object/array whose every (transitively) contained value
 * is one of those. A token-usage breakdown (`{input,output}`) qualifies; a
 * params/messages object with strings does not. Lets the bridge keep emitting
 * useful numeric structures (the model.usage `usage` object is its headline use
 * case) with content capture off, while never leaking text.
 *
 * Cycle-guarded (a self-referential payload is not safely serializable, so it is
 * treated as NOT content-free → dropped here, and would also fail the guarded
 * JSON.stringify on the capture-on path) — never recurse into a cycle.
 */
function isContentFree(v: unknown, seen?: WeakSet<object>): boolean {
  if (v == null || typeof v === "number" || typeof v === "boolean") return true;
  if (typeof v === "string") return false;
  if (typeof v !== "object") return false; // functions, symbols, bigint
  const guard = seen ?? new WeakSet<object>();
  if (guard.has(v as object)) return false; // cycle — bail safely
  guard.add(v as object);
  if (Array.isArray(v)) return v.every((x) => isContentFree(x, guard));
  return Object.values(v as Record<string, unknown>).every((x) =>
    isContentFree(x, guard),
  );
}

const cap = (s: string): string =>
  s.length <= CONTENT_MAX_CHARS ? s : s.slice(0, CONTENT_MAX_CHARS);

/**
 * Flatten a diagnostic event into LogRecord attributes under the content-capture
 * policy (default: every category off). The diagnostic stream carries event
 * types the plugin does not otherwise handle, whose fields may hold prompts,
 * replies, or tool I/O — so this path is gated exactly like the trace path
 * rather than dumping events verbatim:
 *   - numbers / booleans  → always emitted (counts, sizes, durations, flags);
 *   - strings             → emitted only when capture is on OR the key is known
 *                           operational metadata ({@link isSafeStringKey});
 *   - objects / arrays    → emitted only when capture is on OR they are
 *                           structurally content-free ({@link isContentFree});
 * and every stringified value is bounded to {@link CONTENT_MAX_CHARS}.
 */
export function eventToAttributes(
  event: AnyEvent,
  capture: ContentCapturePolicy = CONTENT_POLICY_DISABLED,
): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {};
  const allowContent = anyContentEnabled(capture);
  if (typeof event?.sessionKey === "string") {
    attributes[OPENCLAW_SESSION_KEY] = event.sessionKey;
  }
  for (const [k, v] of Object.entries(event ?? {})) {
    if (k === "type" || k === "sessionKey") continue;
    if (typeof v === "number" || typeof v === "boolean") {
      attributes[`openclaw.diag.${k}`] = v;
    } else if (typeof v === "string") {
      if (allowContent || isSafeStringKey(k)) {
        attributes[`openclaw.diag.${k}`] = cap(v);
      }
    } else if (v != null && (allowContent || isContentFree(v))) {
      try {
        attributes[`openclaw.diag.${k}`] = cap(JSON.stringify(v));
      } catch {
        // unserializable (circular, BigInt, …) — skip this property
      }
    }
  }
  return attributes;
}

function buildLogExporter(
  config: OtelObservabilityConfig,
  logger?: TelemetryLogger,
) {
  if (config.protocol === "grpc") {
    return new OTLPLogExporterGRPC({
      url: config.endpoint,
      // Forward the logger so an invalid gRPC metadata key (dropped auth header)
      // is surfaced on the logs pipeline too, not silently swallowed.
      metadata: grpcMetadata(config.headers, logger),
    });
  }
  return new OTLPLogExporterHTTP({
    url: httpSignalUrl(config.endpoint, "/v1/logs"),
    headers: config.headers,
  });
}

export function initLogs(
  config: OtelObservabilityConfig,
  logger?: TelemetryLogger,
): LogRuntime {
  const provider = new LoggerProvider({
    resource: buildResource(config, logger, resolveHostVersion(process.argv[1])),
    processors: [new BatchLogRecordProcessor(buildLogExporter(config, logger))],
  });
  const log: Logger = provider.getLogger(INSTRUMENTATION_SCOPE, PLUGIN_VERSION, {
    schemaUrl: OTEL_SEMCONV_SCHEMA_URL,
  });
  logger?.info?.(`[otel] log exporter → ${config.endpoint} (${config.protocol})`);

  // Guard teardown so a flush/shutdown rejection at gateway stop can't reject the
  // shutdown chain, and so flush after shutdown is a clean no-op (mirrors the
  // telemetry runtime).
  let shutDown = false;

  return {
    emitEvent(event) {
      const type = typeof event?.type === "string" ? event.type : "diagnostic";
      const outcome = typeof event?.outcome === "string" ? event.outcome : undefined;
      const severity = severityForEvent(type, outcome);
      // Stamp with the event's own timestamp when present so a batched/late
      // diagnostic isn't mis-dated to emit time; fall back to now otherwise.
      // Number.isFinite rejects NaN/Infinity so a malformed ts can't reach the SDK.
      const timestamp = Number.isFinite(event?.ts) ? (event.ts as number) : undefined;
      log.emit({
        timestamp,
        severityNumber: severity,
        severityText: SeverityNumber[severity],
        body: type,
        attributes: eventToAttributes(event, config.captureContent),
      });
    },
    flush: async () => {
      if (shutDown) return;
      try {
        await provider.forceFlush();
      } catch (err) {
        logger?.warn?.(`[otel] log flush error: ${String(err)}`);
      }
    },
    shutdown: async () => {
      if (shutDown) return;
      shutDown = true;
      try {
        await provider.shutdown();
      } catch (err) {
        logger?.warn?.(`[otel] log shutdown error: ${String(err)}`);
      }
    },
  };
}
