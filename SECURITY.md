# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | ✅        |
| < 0.2   | ❌ — upgrade to the latest release |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub
issues.**

Use GitHub's private vulnerability reporting instead:
[Security → Report a vulnerability](https://github.com/zotdotbot/openclaw-otel/security/advisories/new).
You should receive an initial response within a few days. Please include a
proof of concept or reproduction steps where possible.

## Scope notes specific to this plugin

- **Content capture is opt-in and off by default.** When
  `captureContent` is enabled, prompts, replies, and tool inputs/outputs are
  exported to the OTLP endpoint you configure. Treat that backend as part of
  your trust boundary; do not enable content capture toward backends that
  shouldn't hold conversation data.
- **OTLP headers may carry backend credentials** (e.g. ingestion keys) in your
  OpenClaw config. The plugin never logs header values, but your
  `openclaw.json` should be permissioned accordingly.
- The plugin runs inside the OpenClaw gateway process with the gateway's
  privileges; it registers no network listeners of its own and only makes
  outbound OTLP connections to the configured endpoint.
