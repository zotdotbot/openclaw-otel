# @zotdotbot/openclaw-otel

[![npm version](https://img.shields.io/npm/v/%40zotdotbot%2Fopenclaw-otel)](https://www.npmjs.com/package/@zotdotbot/openclaw-otel)
[![CI](https://github.com/zotdotbot/openclaw-otel/actions/workflows/ci.yml/badge.svg)](https://github.com/zotdotbot/openclaw-otel/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

<p align="center">
  <img src="docs/hero.webp" alt="An OpenTelemetry 'O' in a lab coat examines a fully instrumented lobster on an operating table, its vitals streaming to a wall of trace monitors">
</p>

OpenTelemetry plugin for [OpenClaw](https://github.com/openclaw/openclaw). One
connected trace per agent turn, per-turn token/cost rollups, standard GenAI
semconv — exported as OTLP to any backend (SigNoz, Datadog, Grafana, …). Ships
as **one bundled file with zero runtime dependencies**.

```
openclaw.request [28.1s]                      ← one agent turn (any channel), one trace
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

## Why

OpenClaw's built-in exporter scatters each turn across disconnected root spans —
no session correlation, no per-turn token/cost rollup, no `gen_ai.*` semconv, so
OTLP backends can't reconstruct what your agent actually did. This plugin is a
**drop-in replacement**: strictly richer, correlated data, with none of the
`@opentelemetry/api` global-singleton wrangling that breaks the DIY approach.
Full story: [docs/why.md](docs/why.md).

## Install

```bash
openclaw plugins install @zotdotbot/openclaw-otel
```

Flag-free on OpenClaw **2026.6.5+**; older hosts may need an install flag or
plain `npm` — see [docs/compatibility.md](docs/compatibility.md). Then in
`openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-otel": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "endpoint": "http://localhost:4318",
          "serviceName": "my-agent"
        }
      }
    }
  }
}
```

Two things people miss: `hooks.allowConversationAccess: true` is **required**
(per-plugin, not top-level) or conversation spans silently never appear, and
**something must be listening at `endpoint`** or exports are silently dropped —
see [docs/configuration.md](docs/configuration.md) for backends, auth headers,
content capture, and every config key.

## Docs

| | |
| --- | --- |
| [docs/why.md](docs/why.md) | The gaps in the built-in exporter, and how this plugin works |
| [docs/configuration.md](docs/configuration.md) | Every config key, backends/auth, content capture |
| [docs/compatibility.md](docs/compatibility.md) | OpenClaw version support matrix |
| [CONTRACT.md](CONTRACT.md) | The frozen telemetry wire contract (spans, attributes, schema versioning) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, tests, and the contract-change rules |
| [SECURITY.md](SECURITY.md) | Reporting vulnerabilities; content-capture trust boundary |

## License

Apache-2.0 © 2026 Zot. See [LICENSE](LICENSE) and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
