// SPDX-License-Identifier: Apache-2.0

/**
 * Plugin configuration: types, defaults, and a tolerant parser.
 *
 * Config arrives untyped from `openclaw.json` (`plugins.entries.<id>.config`).
 * {@link parseConfig} normalizes it into a fully-populated
 * {@link OtelObservabilityConfig} with every field defaulted, so the rest of
 * the plugin never deals with `undefined`.
 *
 * Zero-config goal: with no `endpoint` set, the plugin falls back to the
 * standard `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable, then to
 * localhost. An operator who already runs an OTel collector needs to set
 * nothing.
 */

// ───────────────────────────────────────────────────────────────────────────
// Content-capture policy
// ───────────────────────────────────────────────────────────────────────────

/**
 * Per-category content-capture policy. Each flag gates capture of one class of
 * (potentially sensitive) content attribute. Everything is OFF by default; no
 * redaction is applied, so enable only when you control the backend and its
 * retention.
 *
 *   - inputMessages  → openclaw.content.input_message / .messages / .prompt
 *   - outputMessages → openclaw.content.output_message
 *   - toolInputs     → openclaw.content.tool_input
 *   - toolOutputs    → openclaw.content.tool_output
 *   - systemPrompt   → openclaw.content.system_prompt
 *   - cronSummary    → openclaw.cron.summary (a cron run's agent-output summary)
 */
export interface ContentCapturePolicy {
  inputMessages: boolean;
  outputMessages: boolean;
  toolInputs: boolean;
  toolOutputs: boolean;
  systemPrompt: boolean;
  cronSummary: boolean;
}

/** Accepted shapes for `captureContent`: a single boolean (legacy all-on /
 *  all-off) or a partial per-category object. */
export type ContentCaptureInput = boolean | Partial<ContentCapturePolicy>;

export const CONTENT_POLICY_DISABLED: ContentCapturePolicy = Object.freeze({
  inputMessages: false,
  outputMessages: false,
  toolInputs: false,
  toolOutputs: false,
  systemPrompt: false,
  cronSummary: false,
});

export const CONTENT_POLICY_ENABLED: ContentCapturePolicy = Object.freeze({
  inputMessages: true,
  outputMessages: true,
  toolInputs: true,
  toolOutputs: true,
  systemPrompt: true,
  cronSummary: true,
});

/**
 * Normalize loose `captureContent` input into a fully-populated policy:
 *   - `true`              → every category on
 *   - `false` / nullish   → every category off
 *   - object              → field-by-field merge over the disabled baseline
 * Unknown keys are ignored; non-boolean values coerce to `false`.
 */
export function normalizeContentCapturePolicy(
  input: unknown,
): ContentCapturePolicy {
  if (input === true) return { ...CONTENT_POLICY_ENABLED };
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { ...CONTENT_POLICY_DISABLED };
  }
  const obj = input as Record<string, unknown>;
  const policy: ContentCapturePolicy = { ...CONTENT_POLICY_DISABLED };
  for (const key of Object.keys(CONTENT_POLICY_DISABLED) as Array<
    keyof ContentCapturePolicy
  >) {
    if (key in obj) policy[key] = obj[key] === true;
  }
  return policy;
}

// ───────────────────────────────────────────────────────────────────────────
// Plugin config
// ───────────────────────────────────────────────────────────────────────────

export interface OtelObservabilityConfig {
  /** OTLP endpoint URL (`http://host:4318` for HTTP, `:4317` for gRPC). */
  endpoint: string;
  /** OTLP export protocol. */
  protocol: "http" | "grpc";
  /** OTel `service.name`. */
  serviceName: string;
  /** Extra OTLP headers (e.g. backend auth). */
  headers: Record<string, string>;
  /** Per-signal toggles. */
  traces: boolean;
  metrics: boolean;
  logs: boolean;
  /**
   * Subscribe to the OpenClaw heartbeat-event bus and emit one
   * `openclaw.heartbeat.run` span per emitted tick (+ the opt-in
   * `openclaw.heartbeat.runs` counter when `metrics` is on). Off by default:
   * it taps an internal in-process bus and most deployments don't run
   * heartbeats. Turn on to surface heartbeat health (skipped / failed ticks).
   */
  heartbeat: boolean;
  /** Normalized per-category content-capture policy. */
  captureContent: ContentCapturePolicy;
  /** Metrics export interval, milliseconds. */
  metricsIntervalMs: number;
  /** Optional head-based trace sampling rate in [0, 1]. Omitted ⇒ keep all. */
  sampleRate?: number;
  /** Extra OTel resource attributes. */
  resourceAttributes: Record<string, string>;
}

/** Minimal logger surface used for parse-time diagnostics. */
export interface ParseConfigLogger {
  warn: (msg: string) => void;
}

/**
 * Default endpoint: prefer the standard OTel env var, else localhost OTLP on the
 * protocol's conventional port. gRPC (4317) and HTTP (4318) use different default
 * ports; a protocol-agnostic default would point gRPC at the HTTP port, so every
 * export would fail silently (the plugin registers no OTel diag logger to surface
 * it). The env var is protocol-agnostic by the OTel spec — honored as-is.
 */
function defaultEndpoint(protocol: "http" | "grpc"): string {
  const fromEnv = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv;
  return protocol === "grpc" ? "http://localhost:4317" : "http://localhost:4318";
}

const DEFAULTS: Omit<OtelObservabilityConfig, "endpoint" | "captureContent"> = {
  protocol: "http",
  serviceName: "openclaw-gateway",
  headers: {},
  traces: true,
  metrics: true,
  logs: false,
  heartbeat: false,
  metricsIntervalMs: 60_000,
  resourceAttributes: {},
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Coerce a loose value into a string→string map, dropping any non-string
 * entries. OTLP headers and OTel resource attributes must be strings; a
 * number/object slipping through from JSON config would otherwise reach the
 * exporter / Resource and throw or serialize oddly.
 */
function stringRecord(v: unknown): Record<string, string> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function parseSampleRate(
  obj: Record<string, unknown>,
  logger?: ParseConfigLogger,
): number | undefined {
  if (!("sampleRate" in obj)) return undefined;
  const raw = obj.sampleRate;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1) {
    if (raw === 0) {
      // Valid, but a silent footgun: head sampling at 0 drops EVERY trace. Keep
      // honoring it (some operators disable traces this way) but make it loud.
      logger?.warn(
        `[otel] sampleRate=0 drops ALL traces (head sampling). Use a value in ` +
          `(0, 1] to keep a fraction, or omit it to keep all traces.`,
      );
    }
    return raw;
  }
  logger?.warn(
    `[otel] Ignoring invalid sampleRate=${String(raw)} (expected a finite ` +
      `number in [0, 1]); keeping all traces.`,
  );
  return undefined;
}

/**
 * Parse untyped plugin config into a fully-populated config. Tolerant of
 * missing/garbage fields — every one falls back to a sane default.
 */
export function parseConfig(
  raw: unknown,
  logger?: ParseConfigLogger,
): OtelObservabilityConfig {
  const obj = isPlainObject(raw) ? raw : {};
  const protocol: "http" | "grpc" =
    obj.protocol === "grpc" ? "grpc" : DEFAULTS.protocol;
  return {
    endpoint:
      typeof obj.endpoint === "string" && obj.endpoint.trim() !== ""
        ? obj.endpoint
        : defaultEndpoint(protocol),
    protocol,
    serviceName:
      typeof obj.serviceName === "string" && obj.serviceName.trim() !== ""
        ? obj.serviceName
        : DEFAULTS.serviceName,
    headers: stringRecord(obj.headers),
    traces: typeof obj.traces === "boolean" ? obj.traces : DEFAULTS.traces,
    metrics: typeof obj.metrics === "boolean" ? obj.metrics : DEFAULTS.metrics,
    logs: typeof obj.logs === "boolean" ? obj.logs : DEFAULTS.logs,
    heartbeat:
      typeof obj.heartbeat === "boolean" ? obj.heartbeat : DEFAULTS.heartbeat,
    captureContent: normalizeContentCapturePolicy(obj.captureContent),
    metricsIntervalMs:
      typeof obj.metricsIntervalMs === "number" && obj.metricsIntervalMs >= 1000
        ? obj.metricsIntervalMs
        : DEFAULTS.metricsIntervalMs,
    sampleRate: parseSampleRate(obj, logger),
    resourceAttributes: stringRecord(obj.resourceAttributes),
  };
}
