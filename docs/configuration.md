# Configuration

All keys live under `plugins.entries.openclaw-otel.config` in `openclaw.json`.

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

Don't forget the **required per-plugin hook** next to `config` (not a top-level
block):

```json
"hooks": { "allowConversationAccess": true }
```

Without it the conversation hooks silently never fire.

## Pointing it at a backend

The plugin is an OTLP **exporter** — it doesn't store telemetry itself, it POSTs
it to an OTLP endpoint. Where that goes depends on `endpoint`:

- **Set `endpoint`** and telemetry is sent there — any OTLP-compatible collector
  or backend (an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/),
  SigNoz, Grafana, Datadog, Honeycomb, …).
- **Leave it unset** and it falls back to the standard
  `OTEL_EXPORTER_OTLP_ENDPOINT` env var, then to `http://localhost:4318`
  (OTLP/HTTP; `4317` for gRPC).

> ⚠️ **If nothing is listening at that endpoint, exports fail silently and the
> telemetry is dropped.** The plugin doesn't buffer to disk and registers no OTel
> error logger, so a missing or wrong endpoint looks like "no data" rather than
> an error. You need either a collector/backend reachable at the default port,
> or an explicit `endpoint`.

To send to a hosted backend, set `endpoint` and pass auth via `headers`:

```json
"config": {
  "endpoint": "https://otlp.your-backend.example",
  "protocol": "http",
  "headers": { "authorization": "Bearer <your-token>" }
}
```

For a gRPC backend set `"protocol": "grpc"` (default port `4317`). A common
local setup is to run an OpenTelemetry Collector on `localhost:4318` and fan out
from there to wherever you want the data to land.

## Content capture

Content capture is **off by default and unredacted** — enable only when you
control the backend and its retention. `toolOutputs` and `systemPrompt` are the
highest-exposure categories. `captureContent` accepts `true`/`false` or a
granular policy object toggling `inputMessages`, `outputMessages`,
`systemPrompt`, `toolInputs`, and `toolOutputs` individually.

## Installing with plain npm

`npm install @zotdotbot/openclaw-otel` drops the package into `node_modules`;
you then add the same `plugins.entries` block to your `openclaw.json` and point
OpenClaw at the package yourself. Useful on OpenClaw versions where
`openclaw plugins install` still runs the install-time scanner — see
[compatibility.md](compatibility.md).
