# Why this exists

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
GenAI-semconv OTLP that any backend renders natively — and ships as a single
zero-dependency bundle that sidesteps the global-singleton trap entirely. It's a
**drop-in replacement** for the built-in: enable it, turn the built-in's traces
off, and you get strictly richer, correlated data with no double-counting.

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
`diagnostics.otel` without fighting over the `@opentelemetry/api` global. The
exact span and attribute vocabulary is a frozen, versioned wire contract — see
[CONTRACT.md](../CONTRACT.md).
