# @zotdotbot/openclaw-otel

[![npm version](https://img.shields.io/npm/v/%40zotdotbot%2Fopenclaw-otel)](https://www.npmjs.com/package/@zotdotbot/openclaw-otel)
[![CI](https://github.com/zotdotbot/openclaw-otel/actions/workflows/ci.yml/badge.svg)](https://github.com/zotdotbot/openclaw-otel/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Self-contained OpenTelemetry plugin for [OpenClaw](https://github.com/openclaw/openclaw):
connected traces, per-turn token/cost rollups, opt-in conversation content
capture, and metrics — emitted as standard GenAI-semconv OTLP to any backend
(SigNoz, Datadog, Grafana, …).

Ships as **one bundled file with zero runtime dependencies**. Install it, point
it at an OTLP endpoint, done — no `node_modules`, no build step on the server, no
`@opentelemetry/api` singleton wrangling.

```
openclaw.request [28.1s]                      ← one Slack turn, one trace
├─ openclaw.agent.turn [27.3s]                ← gen_ai.usage.* rollup, agent.success
│  ├─ openclaw.context.assembled              ← prompt/system/message sizing, budget
│  ├─ chat claude-opus-4-6 [4.3s]             ← GenAI semconv CLIENT spans (+ ttfb, bytes)
│  ├─ openclaw.skill.used                     ← per-skill activation (name, source)
│  ├─ execute_tool exec [403ms]               ← per-call tool spans (+ exec exit_code)
│  ├─ openclaw.harness.run                    ← agentic-loop item counts
│  └─ chat claude-opus-4-6 [18.8s]
├─ openclaw.message.processed                 ← inbound outcome (top error source)
└─ openclaw.message.sent                      ← outbound reply (joins the trace)
```

## Why this exists

OpenClaw ships a built-in OpenTelemetry exporter (`diagnostics.otel`), but it
leaves real gaps for anyone trying to operate or debug an agent:

- **Fragmented, disconnected traces.** A single agent turn scatters across separate
  traces with no shared parent — each model call, tool call, and inbound/outbound
  message lands as its own root span. You can see *that* something happened, but you
  can't follow one turn end-to-end or see the order of what happened inside it.
- **No session or turn correlation.** No trace context is threaded through the agent
  loop, so nothing ties a turn's spans back to a conversation or run. Backends that
  reconstruct LLM activity from span shape get nothing usable — in one real
  integration a downstream consumer built **zero** records from the built-in's
  output, because the spans carried no `gen_ai.*` or message attributes (just a
  single generic span per turn).
- **No per-turn token/cost rollup.** Usage comes back as coarse, scattered numbers.
  A 15-second, multi-tool response shows up as little more than "message processed,
  40k tokens" — no input / output / cache-read / cache-write breakdown, no cost, and
  no single span to attribute spend to.
- **Not standard GenAI semconv.** Spans aren't shaped as `chat <model>` /
  `execute_tool <name>` with `gen_ai.*` attributes, so OTLP-native backends (SigNoz,
  Datadog, Grafana, Honeycomb) don't render them as model/tool calls and vendor LLM
  views stay empty.
- **A trap to extend the obvious way.** Writing a plugin that *shares* OpenClaw's
  `@opentelemetry/api` to add richer spans is a footgun: if the plugin loads its own
  copy of the API it gets a **separate** global `TracerProvider`, and every span it
  starts silently becomes a no-op (`NonRecordingSpan`) — no error, no data. Avoiding
  that means symlinking `node_modules`, juggling `peerDependencies`, and version-
  pinning across the gateway and the plugin: fragile surgery that breaks on redeploy.

This plugin emits **one connected, session-correlated trace per turn**, as standard
GenAI-semconv OTLP that any backend (SigNoz, Datadog, Grafana, Honeycomb, …) renders
natively — and ships as a single zero-dependency bundle that sidesteps the global-
singleton trap entirely (see [What you get](#what-you-get)). It's a **drop-in
replacement** for the built-in: enable it, turn the built-in's traces off, and you
get strictly richer, correlated data with no double-counting.

## What you get

- **One trace per turn** — root request → agent turn → model/tool/skill calls →
  reply, all under a single trace ID (the diagram above).
- **Per-turn rollups** — input / output / cache-read / cache-write tokens, cost,
  model, and `agent.success` on `openclaw.agent.turn`, not scattered across spans.
- **Standard GenAI semconv** — `chat <model>` / `execute_tool <name>` spans with
  `gen_ai.*` attributes; renders in any OTLP backend, no vendor lock-in.
- **Operational diagnostics, correlated** — context-assembly sizing, agentic-loop
  counts, inbound/outbound message outcomes, per-call ttfb/bytes, and exec exit
  codes folded into the *same* trace (these are uncorrelated in the built-in).
- **Opt-in content capture** — prompts, replies, and tool I/O; off by default,
  with a granular policy, exported only to your backend.
- **Metrics + logs** — GenAI metrics and OTLP logs alongside traces.
- **Zero install friction** — every `@opentelemetry/*` package is inlined at build
  time (esbuild) into one `dist/index.js`, and the plugin uses OTel provider
  *instances* directly, never calling `setGlobalTracerProvider`. So there's no
  `node_modules` on the server, no build step, no shared-singleton symlinking, and
  none of the silent `NonRecordingSpan` no-ops that bite the conventional approach.

## How it works

The plugin registers once when your OpenClaw gateway starts and hooks into its
lifecycle — conversation turns, model calls, tool calls, skills, cron, and
(optionally) heartbeats. It threads W3C trace context across those hooks so each
turn lands as **one connected trace** (root request → agent turn → model / tool /
skill spans → reply), and folds OpenClaw's own diagnostics into a per-turn
token / cost rollup. Everything is exported over OTLP (HTTP or gRPC) to the
endpoint you configure.

It uses OpenTelemetry provider *instances* directly and never calls
`setGlobalTracerProvider`, so it runs alongside OpenClaw's built-in
`diagnostics.otel` without fighting over the `@opentelemetry/api` global. The exact
span and attribute vocabulary is a frozen, versioned wire contract
(`schema.version` `1.8.0`) — see [CONTRACT.md](CONTRACT.md).

## Install & enable

Install straight from npm with OpenClaw's plugin installer — it fetches the
package, unpacks it into your extensions directory, and adds the config entry:

```bash
openclaw plugins install @zotdotbot/openclaw-otel
```

On OpenClaw **2026.6.5+** this needs no flags. On 2026.5.28–6.4 the install-time
scanner is still active, so you may need `--dangerously-force-unsafe-install` (or
use the plain-`npm` path below). See [Compatibility](#compatibility) for the full
version matrix.

Then point it at your OTLP endpoint and, on OpenClaw ≥ 2026.4.23, allow the
conversation hooks. A complete `openclaw.json` entry:

```json
{
  "plugins": {
    "entries": {
      "openclaw-otel": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "endpoint": "http://localhost:4318",
          "protocol": "http",
          "serviceName": "my-agent",
          "traces": true,
          "metrics": true,
          "captureContent": false
        }
      }
    }
  }
}
```

`plugins.entries.openclaw-otel.hooks.allowConversationAccess: true` is required, or
the conversation hooks silently never fire. Note it's a **per-plugin** hook (inside
the entry), not a top-level `hooks` block.

<details>
<summary>Prefer plain npm?</summary>

`npm install @zotdotbot/openclaw-otel` drops the package into `node_modules`; you
then add the same `plugins.entries` block to your `openclaw.json` and point
OpenClaw at the package yourself.
</details>

## Pointing it at a backend

The plugin is an OTLP **exporter** — it doesn't store telemetry itself, it POSTs it
to an OTLP endpoint. Where that goes depends on `endpoint`:

- **Set `endpoint`** and telemetry is sent there — any OTLP-compatible collector or
  backend (an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/),
  SigNoz, Grafana, Datadog, Honeycomb, …).
- **Leave it unset** and it falls back to the standard `OTEL_EXPORTER_OTLP_ENDPOINT`
  env var, then to `http://localhost:4318` (OTLP/HTTP; `4317` for gRPC).

> ⚠️ **If nothing is listening at that endpoint, exports fail silently and the
> telemetry is dropped.** The plugin doesn't buffer to disk and registers no OTel
> error logger, so a missing or wrong endpoint looks like "no data" rather than an
> error. You need either a collector/backend reachable at the default port, or an
> explicit `endpoint`.

To send to a hosted backend, set `endpoint` and pass auth via `headers`:

```json
"config": {
  "endpoint": "https://otlp.your-backend.example",
  "protocol": "http",
  "headers": { "authorization": "Bearer <your-token>" }
}
```

For a gRPC backend set `"protocol": "grpc"` (default port `4317`). A common local
setup is to run an OpenTelemetry Collector on `localhost:4318` and fan out from
there to wherever you want the data to land.

## Compatibility

Verified live on **OpenClaw 2026.5.28** (production baseline) and source-compatible
through **2026.6.10** (latest). **Recommended: 2026.6.5+**, where `openclaw plugins
install` runs with no install flag. Older hosts run the plugin with documented,
graceful degradation — nothing crashes anywhere in the range.

| OpenClaw | Support | Notes |
| --- | --- | --- |
| **2026.6.5 – 2026.6.10** | ✅ **Recommended** | Native `openclaw plugins install` is flag-free (install scanner removed at 6.5). Core + heartbeat + cron all work. |
| 2026.5.28 – 2026.6.4 | ✅ Supported | Live-verified baseline (2026.5.28). All telemetry works. Install scanner still active → `openclaw plugins install` may need `--dangerously-force-unsafe-install`, or use `npm install` + manual config. |
| 2026.4.29 – 2026.5.27 | ◐ Source-compatible¹ | All features present (core, heartbeat, cron). Same install caveat. |
| 2026.4.27 – 2026.4.28 | ◐ Core + heartbeat¹ | Accurate token/cost rollups + heartbeat; cron telemetry needs ≥ 2026.4.29. |
| 2026.4.21 – 2026.4.26 | ◐ Core, degraded¹ | Traces / metrics / logs emit, but token/cost is approximate (accurate path needs 2026.4.27) and per-model-call spans need 2026.4.25. No heartbeat/cron. |
| `< 2026.4.21` | ✗ Unsupported | Below the analyzed floor. |

¹ Source-analysis compatible (symbol/signature presence at each OpenClaw release
tag), not runtime-tested below 2026.5.28. Graceful degradation is the rule — a
missing host surface means a missing span/metric or a no-op opt-in, never a
gateway crash.

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `endpoint` | `$OTEL_EXPORTER_OTLP_ENDPOINT` → `http://localhost:4318` | OTLP endpoint URL |
| `protocol` | `http` | `http` (port 4318) or `grpc` (port 4317) |
| `serviceName` | `openclaw-gateway` | OTel `service.name` |
| `headers` | `{}` | Extra OTLP headers (backend auth) |
| `traces` / `metrics` / `logs` | `true` / `true` / `false` | Per-signal toggles |
| `heartbeat` | `false` | Subscribe to the heartbeat bus → `openclaw.heartbeat.run` spans |
| `captureContent` | `false` | `true`/`false`, or a granular policy object |
| `metricsIntervalMs` | `60000` | Metrics export interval |
| `sampleRate` | — | Optional head-based trace sampling (0.0–1.0) |
| `resourceAttributes` | `{}` | Extra OTel resource attributes |

Content capture is **off by default and unredacted** — enable only when you
control the backend and its retention. `toolOutputs` and `systemPrompt` are the
highest-exposure categories.

## Development

```bash
npm install
npm run typecheck       # tsc --noEmit
npm test                # vitest
npm run build           # → dist/index.js (single self-contained bundle)
npm run verify:package  # pack, install into a clean project, assert zero deps + load
```

## License

Apache-2.0 © 2026 Zot. A clean-room implementation authored by Zot; the wire
contract is kept compatible with prior OpenClaw OTel tooling by design. See
[LICENSE](LICENSE).
