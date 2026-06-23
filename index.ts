// SPDX-License-Identifier: Apache-2.0
//
// @zotdotbot/openclaw-otel — self-contained OpenTelemetry plugin for OpenClaw.
//
// Emits connected traces (request → agent turn → model calls + tools),
// per-turn token/cost rollups, opt-in content capture, and metrics, as
// GenAI-semconv OTLP to any backend. The exact span/attribute vocabulary is a
// frozen wire contract consumed by downstream consumers — see
// src/contract.ts and CONTRACT.md.
//
// ────────────────────────────────────────────────────────────────────────────
// ARCHITECTURE
//
// Plugin entry point. On register it wires:
//   - telemetry init (src/telemetry.ts) — instance-based providers/exporters,
//     no global registration;
//   - the hook→span pipeline (src/hooks.ts) over the tiered trace-context store
//     (src/trace-context-store.ts), emitting one connected trace per turn;
//   - the diagnostics rollup (src/diagnostics.ts) — held-open turn for token
//     usage, the session.stalled metric, and the re-homed operational spans;
//   - logs (src/logs.ts) and W3C trace-context propagation (src/propagation.ts).
//
// The emitted span/metric vocabulary is the frozen contract in src/contract.ts,
// enforced test-first (tests/) by an emit oracle and a consumer-parity port.
// ────────────────────────────────────────────────────────────────────────────

import { parseConfig, type OtelObservabilityConfig } from "./src/config";
import { initTelemetry, redactEndpoint, type TelemetryRuntime } from "./src/telemetry";
import { registerHooks } from "./src/hooks";
import { registerCronHooks, CronRegistry } from "./src/cron";
import { initHeartbeat } from "./src/heartbeat";
import { TraceContextStore } from "./src/trace-context-store";
import { UsageCoordinator, initDiagnostics } from "./src/diagnostics";
import { initLogs, type LogRuntime } from "./src/logs";
import { PLUGIN_ID, PLUGIN_VERSION } from "./src/version";
import { SCHEMA_VERSION } from "./src/contract";

// ── Public re-exports ────────────────────────────────────────────────────────
// W3C trace-context propagation helpers, available without the plugin register
// lifecycle so user code (custom RPC, message queues, sub-agent transports) can
// inject/extract `traceparent` directly.
export {
  injectTraceContext,
  extractTraceContext,
  propagationFields,
  type HeaderCarrier,
} from "./src/propagation";

/** Summarize the content-capture policy for human-readable status output. */
function captureSummary(config: OtelObservabilityConfig): string {
  const policy = config.captureContent;
  const on = (Object.keys(policy) as Array<keyof typeof policy>).filter(
    (k) => policy[k],
  );
  if (on.length === 0) return "none";
  if (on.length === Object.keys(policy).length) return "all";
  return on.join(", ");
}

const openclawOtelPlugin = {
  id: PLUGIN_ID,
  name: "Zot OpenClaw Telemetry",
  description:
    "Connected traces, token/cost rollups, content capture, and metrics for OpenClaw via OpenTelemetry",

  configSchema: {
    parse(value: unknown): OtelObservabilityConfig {
      return parseConfig(value);
    },
  },

  register(api: any) {
    const logger = api.logger ?? console;
    const config = parseConfig(api.pluginConfig, logger);

    // Initialize telemetry at register() time (not in service.start()) so the
    // OTel providers stand up in every OpenClaw context — gateway AND embedded
    // runners (CLI, cron, heartbeat, subagent), where service.start() is a
    // no-op. The hook→span pipeline (Phase 3) attaches to this runtime.
    //
    // register() runs EXACTLY ONCE per gateway process: OpenClaw treats any
    // `plugins.*` config change as a full gateway restart, not an in-process
    // reload (src/gateway/config-reload.ts → `{ prefix: "plugins", kind:
    // "restart" }`), and a restart rebuilds a fresh process + fresh api + fresh
    // registry. There is therefore no stop→register hot-reload cycle to guard
    // against — a single telemetry runtime, unconditional registrations, and a
    // single gateway_stop teardown are correct (and module-level singletons /
    // dedup guards would be wrong: a fresh registry discards prior listeners).
    let telemetry: TelemetryRuntime | null = null;
    let logRuntime: LogRuntime | null = null;
    let stopHooks: (() => void) | null = null;
    let stopCron: (() => void) | null = null;
    let stopDiagnostics: (() => void) | null = null;
    let stopHeartbeat: (() => void) | null = null;
    let diagnosticsReady: Promise<unknown> = Promise.resolve();
    let heartbeatReady: Promise<unknown> = Promise.resolve();
    const usage = new UsageCoordinator();
    try {
      telemetry = initTelemetry(config, logger);
      if (config.logs) {
        try {
          logRuntime = initLogs(config, logger);
        } catch (err) {
          logger.error?.(`[otel] failed to initialize log pipeline: ${String(err)}`);
        }
      }
      // Wire the hook→span pipeline against this runtime's tracer. A shared
      // TraceContextStore threads parent context across hooks so a turn lands
      // as one connected trace; the UsageCoordinator holds the turn open for
      // the model.usage diagnostic.
      const store = new TraceContextStore();
      // Shared cron registry: the cron hooks seed/maintain it; the turn hooks read
      // it to stamp cron name/schedule onto cron-triggered turns.
      const cronRegistry = new CronRegistry();
      stopHooks = registerHooks(api, {
        tracer: telemetry.tracer,
        store,
        capture: config.captureContent,
        usage,
        operationDuration: telemetry.instruments.operationDuration,
        cronRegistry,
      });
      // Cron lifecycle → openclaw.cron.run / openclaw.cron.definition spans
      // (covers turn-less / skipped / CLI-provider runs the turn path never sees).
      stopCron = registerCronHooks(api, {
        tracer: telemetry.tracer,
        store,
        registry: cronRegistry,
        capture: config.captureContent,
        cronRuns: telemetry.instruments.cronRuns,
        logger,
      });
      // Heartbeat lifecycle → openclaw.heartbeat.run spans, from the
      // onHeartbeatEvent bus. Opt-in (config.heartbeat): it taps an internal
      // in-process bus, so only subscribe when explicitly enabled. Async (the
      // SDK barrel is dynamically imported); a no-op when the bus is absent.
      if (config.heartbeat) {
        heartbeatReady = initHeartbeat({
          tracer: telemetry.tracer,
          heartbeatRuns: telemetry.instruments.heartbeatRuns,
          logger,
        })
          .then((unsub) => {
            stopHeartbeat = unsub;
          })
          .catch((err) => {
            logger.warn?.(`[otel] heartbeat init failed: ${String(err)}`);
          });
      }
      // Subscribe to OpenClaw diagnostics for the held-open token rollup and the
      // session.stalled metric. Async (the SDK is dynamically imported); if it's
      // unavailable, initDiagnostics disarms the coordinator so turns end on the
      // event-payload usage instead of waiting.
      diagnosticsReady = initDiagnostics({
        coordinator: usage,
        sessionStalled: telemetry.instruments.sessionStalled,
        tokenUsage: telemetry.instruments.tokenUsage,
        emitLog: logRuntime?.emitEvent,
        // Tracer + store let the `skill.used` diagnostic become an
        // openclaw.skill.used span joined to the turn's trace (skills have no hook).
        tracer: telemetry.tracer,
        store,
        logger,
      })
        .then((unsub) => {
          stopDiagnostics = unsub;
        })
        .catch(() => usage.disarm());
    } catch (err) {
      logger.error?.(`[otel] failed to initialize telemetry/hooks: ${String(err)}`);
    }

    // Teardown: wait for the async diagnostics subscription to settle so we can
    // actually unsubscribe it (even on a fast shutdown), end any held-open
    // turns, clear the hook sweep timer + end in-flight store spans, then shut
    // the providers down.
    api.on?.("gateway_stop", async () => {
      await diagnosticsReady.catch(() => {});
      await heartbeatReady.catch(() => {});
      stopDiagnostics?.();
      stopHeartbeat?.();
      usage.shutdown();
      stopHooks?.();
      stopCron?.();
      await telemetry?.shutdown();
      await logRuntime?.shutdown();
    });

    const statusPayload = () => ({
      initialized: telemetry !== null,
      schemaVersion: SCHEMA_VERSION,
      pluginVersion: PLUGIN_VERSION,
      // Redacted: this payload is surfaced to the LLM via the otel_status tool
      // and over the .status RPC, so any endpoint userinfo must not leak.
      endpoint: redactEndpoint(config.endpoint),
      protocol: config.protocol,
      serviceName: config.serviceName,
      traces: config.traces,
      metrics: config.metrics,
      logs: config.logs,
      heartbeat: config.heartbeat,
      captureContent: config.captureContent,
    });

    logger.info?.(
      `[otel] ${PLUGIN_ID}@${PLUGIN_VERSION} registered — ` +
        `endpoint=${redactEndpoint(config.endpoint)} protocol=${config.protocol} ` +
        `schema=${SCHEMA_VERSION} traces=${config.traces} metrics=${config.metrics}`,
    );

    // ── RPC: status endpoint ──────────────────────────────────────────────
    api.registerGatewayMethod?.(
      `${PLUGIN_ID}.status`,
      ({ respond }: { respond: (ok: boolean, payload?: unknown) => void }) => {
        respond(true, statusPayload());
      },
    );

    // ── CLI command ───────────────────────────────────────────────────────
    api.registerCli?.(
      ({ program }: { program: any }) => {
        program
          .command("otel")
          .description("OpenTelemetry observability status")
          .action(() => {
            const s = statusPayload();
            console.log("🔭 Zot OpenClaw Telemetry");
            console.log("─".repeat(40));
            console.log(`  Schema:          ${s.schemaVersion}`);
            console.log(`  Plugin:          ${PLUGIN_ID}@${s.pluginVersion}`);
            console.log(`  Endpoint:        ${s.endpoint}`);
            console.log(`  Protocol:        ${s.protocol}`);
            console.log(`  Service:         ${s.serviceName}`);
            console.log(`  Traces:          ${s.traces ? "✅" : "❌"}`);
            console.log(`  Metrics:         ${s.metrics ? "✅" : "❌"}`);
            console.log(`  Logs:            ${s.logs ? "✅" : "❌"}`);
            console.log(`  Heartbeat:       ${s.heartbeat ? "✅" : "❌"}`);
            console.log(`  Capture content: ${captureSummary(config)}`);
            console.log(`  Initialized:     ${s.initialized ? "✅" : "❌ (scaffold)"}`);
          });
      },
      { commands: ["otel"] },
    );

    // ── Agent tool: otel_status ───────────────────────────────────────────
    api.registerTool?.(
      {
        name: "otel_status",
        label: "OTel Status",
        description:
          "Check the OpenTelemetry observability plugin status and configuration.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return {
            content: [
              { type: "text", text: JSON.stringify(statusPayload(), null, 2) },
            ],
          };
        },
      },
      { optional: true },
    );

    // ── Background service ─────────────────────────────────────────────────
    api.registerService?.({
      id: PLUGIN_ID,
      start: async () => {
        logger.info?.("[otel] observability service started (gateway-side)");
      },
      stop: async () => {
        // Drain pending telemetry. service.stop() and gateway_stop both fire at
        // gateway shutdown; flush is idempotent and a clean no-op after the
        // gateway_stop shutdown has run.
        await telemetry?.flush();
        await logRuntime?.flush();
        logger.info?.("[otel] observability service stopped (telemetry flushed)");
      },
    });
  },
};

export default openclawOtelPlugin;
