# Telemetry contract

The span/metric vocabulary this plugin emits over OTLP, and that downstream
consumers parse. The machine-readable source of truth is
[`src/contract.ts`](src/contract.ts); the constants are in
[`src/semconv.ts`](src/semconv.ts); the contract test
([`tests/contract.test.ts`](tests/contract.test.ts)) enforces it.

Every signal carries the resource attribute `openclaw.schema.version` (currently
**`1.8.0`**). `1.8.0` is a **loosening** bump over `1.7.0`
([issue #5](https://github.com/zotdotbot/openclaw-otel/issues/5)):
`gen_ai.request.model` + `gen_ai.provider.name` on `chat` spans and
`gen_ai.response.model` on `openclaw.agent.turn` are now **optional** — the
plugin **omits** them (never the literal `"unknown"`) when the host events carry
no model/provider (e.g. OpenRouter/DeepSeek on OpenClaw 2026.5.28), and the chat
span name falls back to the bare `chat`. A populated placeholder is
indistinguishable from a real model and poisons downstream cost attribution;
an absent attribute lets consumers coalesce correctly. When the `model.usage`
diagnostic carries the model, the held-open turn span is still back-filled with
the real name. `1.7.0` was an **additive** bump over `1.6.0` adding the
**best-effort** `openclaw.version` resource attribute — the HOST OpenClaw
gateway version, resolved from the host's `package.json` at startup and
**omitted** when resolution fails, so consumers must treat it as optional
(distinct from `service.version`, which is this plugin's own version; an
operator-supplied `resourceAttributes["openclaw.version"]` acts as a manual
fallback when resolution fails, and is overridden when it succeeds).
`1.6.0` was an **additive** bump over `1.5.0` covering cron and
heartbeat lifecycle: the cron spans `openclaw.cron.run` / `openclaw.cron.definition`
(driven by the `cron_changed` gateway hook), the opt-in default-off
`openclaw.heartbeat.run` span (driven by the `onHeartbeatEvent` bus), the
`openclaw.cron.*` / `openclaw.heartbeat.*` attributes (with cron `job_id`/`name`/
`schedule_*` also stamped onto cron turn spans), and the opt-in run counters
`openclaw.cron.runs` / `openclaw.heartbeat.runs`. See **Cron lifecycle** and
**Heartbeat lifecycle** below. `1.5.0` **re-homed** the operational spans
`openclaw.context.assembled`, `openclaw.harness.run`, `openclaw.message.processed`,
and `openclaw.message.delivery` — synthesized from OpenClaw's internal diagnostic
stream and parented into the live turn trace (session-correlated, unlike the
built-in `diagnostics.otel`'s orphan fragments) — and added per-call detail
(`openclaw.model_call.time_to_first_byte_ms` / `.request_bytes` / `.response_bytes`
on `chat`; `openclaw.exec.exit_code` / `.timed_out` on `execute_tool`), so one
plugin can fully replace the built-in `diagnostics.otel` with no double-counting.
(`1.4.0` added the `openclaw.skill.used` span, the `openclaw.tool.error`/
`openclaw.errorCode` attributes, and reliable `openclaw.message.sent`.) **Bump the
version only when a span name, a required attribute, a metric, a resource
attribute, or one of the load-bearing string formats below changes — and update
downstream consumers in lockstep.**

## Emitted spans (one turn = one trace)

| Span | Name | Kind | Required attributes | Content (policy-gated) |
| --- | --- | --- | --- | --- |
| Request root | `openclaw.request` | SERVER | `openclaw.session.key`, `gen_ai.conversation.id`, `openclaw.message.channel`, `openclaw.message.direction` | `openclaw.content.input_message` |
| Agent turn | `openclaw.agent.turn` | INTERNAL | `openclaw.session.key`, `gen_ai.conversation.id`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `openclaw.agent.success` (`gen_ai.response.model` optional since 1.8.0 — omitted when unresolvable, never `"unknown"`) | `openclaw.content.prompt`, `.messages`, `.system_prompt` |
| Model call | `chat <model>` (bare `chat` when the model is unresolvable, 1.8.0) | CLIENT | `gen_ai.operation.name`, `gen_ai.conversation.id` (`gen_ai.request.model`, `gen_ai.provider.name` optional since 1.8.0 — omitted when unresolvable, never `"unknown"`) | — |
| Tool call | `execute_tool <tool>` | INTERNAL | `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.conversation.id`, `openclaw.tool.name` | `openclaw.content.tool_input`, `.tool_output` |
| Outbound reply | `openclaw.message.sent` | INTERNAL | `openclaw.session.key`, `gen_ai.conversation.id`, `openclaw.message.direction`, `openclaw.message.chars` | `openclaw.content.output_message` |
| Skill activation | `openclaw.skill.used` | INTERNAL | `openclaw.session.key`, `gen_ai.conversation.id`, `openclaw.skill.name`, `openclaw.skill.source` | — |
| Context assembly | `openclaw.context.assembled` | INTERNAL | `openclaw.session.key`, `gen_ai.conversation.id` | — (sizing: `openclaw.context.prompt_chars`, `.system_prompt_chars`, `.message_count`, `.token_budget`) |
| Harness loop | `openclaw.harness.run` | INTERNAL | `openclaw.session.key`, `gen_ai.conversation.id` | — (`openclaw.harness.items.started`/`.completed`/`.active`, `.result_classification`, `openclaw.outcome`) |
| Inbound outcome | `openclaw.message.processed` | INTERNAL | `openclaw.session.key`, `gen_ai.conversation.id` | — (`openclaw.outcome`, `openclaw.channel`, `openclaw.reason`) |
| Outbound delivery | `openclaw.message.delivery` | INTERNAL | `openclaw.session.key`, `gen_ai.conversation.id` | — (`openclaw.delivery.kind`, `.result_count`, `openclaw.outcome`) |
| Cron run | `openclaw.cron.run` | INTERNAL¹ | `openclaw.session.key`, `gen_ai.conversation.id`, `openclaw.cron.job_id`, `openclaw.cron.status` | `openclaw.cron.summary` |
| Cron definition | `openclaw.cron.definition` | INTERNAL | `openclaw.session.key`, `gen_ai.conversation.id`, `openclaw.cron.job_id` | — |
| Heartbeat run² | `openclaw.heartbeat.run` | INTERNAL | `openclaw.session.key`, `gen_ai.conversation.id`, `openclaw.heartbeat.status` | — |

¹ `openclaw.cron.run` is INTERNAL when it joins its just-finished turn trace, SERVER when standalone (turn-less / skipped / CLI-provider run). See **Cron lifecycle** below.
² `openclaw.heartbeat.run` is emitted **only when `heartbeat` is enabled** (default off). See **Heartbeat lifecycle** below.

Cache tokens (`gen_ai.usage.cache_read.input_tokens`,
`gen_ai.usage.cache_creation.input_tokens`) ride the turn when nonzero; cost
(`openclaw.llm.cost_usd`) appears when known. Per-call latency/size rides `chat`
(`openclaw.model_call.time_to_first_byte_ms`, `.request_bytes`, `.response_bytes`)
and shell exit detail rides `execute_tool` (`openclaw.exec.exit_code`,
`.timed_out`) — on the connected-convention spans, not separate `model.call`/`exec`
spans, so model-call and tool counts are never doubled.

## Cron lifecycle (1.6.0)

OpenClaw's cron scheduler is observed via the `cron_changed` **gateway** hook, not
the agent-turn path — so coverage holds for runs the turn path never sees:
turn-less `systemEvent` jobs, scheduler-`skipped` runs, and CLI-provider crons
(which never fire `before_model_resolve`).

- **`openclaw.cron.run`** — one per scheduler firing (`action=finished`).
  `openclaw.cron.status` is `ok` | `error` | `skipped` (or `unknown` if a host
  event ever omits status — never defaulted to `ok`; the authoritative per-run
  status, since `openclaw.agent.success` only covers turn-bearing runs). Carries
  `openclaw.cron.{job_id,job_name,run_id,duration_ms,delivered,delivery_status,next_run_at_ms}`
  + the schedule snapshot, `gen_ai.response.model`/`provider.name`, and
  `openclaw.trigger="cron"`. It is classified **ROLE_OTHER** and **deliberately
  carries no `gen_ai.usage.*`** — the joined `openclaw.agent.turn` is the token
  record. A consumer counting RUNS uses this span; summing TOKENS uses the turn.
  When the just-finished turn trace is still resolvable it is emitted INTERNAL and
  parented into that trace; otherwise it is a standalone SERVER root.
- **`openclaw.cron.definition`** — registry row, emitted on
  `added`/`updated`/`removed` and once per job at gateway start (`getCron().list()`).
  The **latest per `openclaw.cron.job_id`** is the live cron list with
  `openclaw.cron.{job_name,schedule_kind,schedule_expr,schedule_every_ms,schedule_tz,enabled,next_run_at_ms,last_run_at_ms,last_run_status}`,
  so a consumer can list crons that haven't run in the query window.
  `openclaw.cron.removed=true` is a tombstone (drop the job). Its
  `openclaw.session.key`/`gen_ai.conversation.id` are `cron:<job_id>` (a registry
  row has no real session).

**Joins & rules.** A cron turn's `openclaw.agent.turn`/`openclaw.request` is also
stamped with `openclaw.cron.{job_id,job_name,run_id,schedule_*}`, so a consumer
joins a run to its turn by `(openclaw.cron.job_id, openclaw.cron.run_id)`.
`openclaw.cron.summary` is **content** (agent output) — emitted only when
`captureContent.cronSummary` is enabled (default off). Schedule + job name are NOT
on the raw `cron_changed` finished event; they are sourced from the in-memory
registry seeded at gateway start, so a `removed`/just-deleted run still resolves
them. **Missed runs** (the scheduler never fired) emit no event — a consumer infers
them from `openclaw.cron.next_run_at_ms` in the past with no newer run.

## Heartbeat lifecycle (1.6.0, opt-in)

OpenClaw runs a periodic per-agent "heartbeat" self-check. Most ticks run no
model turn, so the agent-turn path can't surface heartbeat **health**. When the
`heartbeat` config flag is enabled, the plugin subscribes to OpenClaw's
`onHeartbeatEvent` in-process bus and emits one span per **emitted** tick:

- **`openclaw.heartbeat.run`** — `openclaw.heartbeat.status` is
  `sent` | `ok-empty` | `ok-token` | `skipped` | `failed` (ERROR span status on
  `failed`, carrying the reason). Also carries `openclaw.heartbeat.{reason,channel,duration_ms,silent,has_media,indicator}`
  and `openclaw.trigger="heartbeat"`. Classified **ROLE_OTHER**; a standalone
  INTERNAL marker. The bus payload has no session key, so
  `openclaw.session.key`/`gen_ai.conversation.id` are synthesized as `heartbeat`
  (`heartbeat:<channel>` when a channel is present).

**Default off** — it taps an internal bus and most deployments don't run
heartbeats. **Coverage caveat (not a bug):** idle/disabled/quiet-hours/
no-tasks-due skips early-return **without** a bus event, so this span counts
emitted ticks only (sent/failed + contended skips), **not every wake** — its
absence does not mean "heartbeat down". The recipient/content fields
(`to`/`accountId`/`preview`) are **deliberately never emitted** (PII/content).

## Topology guarantees

- `openclaw.request` → `openclaw.agent.turn` → `chat *` / `execute_tool *`.
- Token usage rides the **turn rollup**. The `chat *` spans may duplicate it
  verbatim — consumers must **not** sum both.
- Each tool call may emit a near-0s synthetic persist echo carrying
  `openclaw.tool.is_synthetic` in addition to the timed span; consumers dedupe
  on `gen_ai.tool.call.id` (the timed span is the real one).
- `openclaw.message.sent` fires after the turn ends; it still joins the
  request's trace via completed-root retention (10-min window). On the 2026.5.28
  delivery path the status event can arrive with no session key — the reply text,
  routing, and parent context are captured on `message_sending` and joined by the
  **conversation id**, so the span is never dropped.
- `openclaw.skill.used` is driven by the `skill.used` internal diagnostic (skills
  have no plugin hook); it is parented to the live turn at the diagnostic's
  timestamp so the consumer's per-skill window attribution sees correct ordering.
- `openclaw.context.assembled` / `openclaw.harness.run` / `openclaw.message.processed`
  / `openclaw.message.delivery` are likewise synthesized from the internal
  diagnostic stream and parented into the turn (end-of-turn ones join via the
  retained completed root). The plugin observes that stream in **both** the gateway
  and embedded-runner contexts; a diagnostic-driven span is emitted **only** in the
  instance that actually holds the turn's trace context (`resolveTurnContext`), so
  it is never duplicated as an orphan onto the session/gateway root. We deliberately
  do **not** synthesize `openclaw.run` / `model.call` / `tool.execution` / `exec` /
  `model.usage` (the plugin already spans those as `request`/`chat`/`execute_tool`/
  the turn rollup) — re-homing them would double-count model calls and tool calls.
- `gen_ai.conversation.id` (= the OpenClaw session key, thread-level on Slack)
  is on every span for cross-trace correlation; `openclaw.session.key` is the
  fallback and the stalled-metric groupBy.

## Metrics

| Metric | Instrument | Read by consumer |
| --- | --- | --- |
| `openclaw.session.stalled` | Counter (grouped by `openclaw.session.key`) | **yes — load-bearing** |
| `gen_ai.client.token.usage` | Histogram | no (external dashboards) |
| `gen_ai.client.operation.duration` | Histogram | no (external dashboards) |
| `openclaw.cron.runs` | Counter (keyed by `openclaw.cron.status` + `openclaw.cron.job_id`) | no (opt-in alerting) |
| `openclaw.heartbeat.runs` | Counter (keyed by `openclaw.heartbeat.status`) | no (opt-in alerting) |

The two run counters (1.6.0) are **opt-in convenience** for cheap
`rate(...{status='error'})` alerting without a span→metric pipeline; they are
emitted only when `metrics` is on (and, for heartbeat, `heartbeat` is on). The
`openclaw.cron.run` / `openclaw.heartbeat.run` spans remain the source of truth.

## Load-bearing details (verified against the consumer)

- **String formats are contract.** `openclaw.message.from` is `"<channel>:..."`
  and `openclaw.session.key` is `"agent:<id>:<channel>:..."`; the consumer parses
  channel/correlation out of them. Changing the format breaks parsing even if the
  key stays.
- **Capture-off sentinel.** When tool-input capture is off, emit the literal
  `"{}"` (never null/absent) for `openclaw.content.tool_input` — the consumer
  treats `"{}"` as empty and otherwise mis-detects capture state.
- **Model-name fallback.** The consumer reads `openclaw.model` as a fallback to
  `gen_ai.request.model` on model/usage spans. Emit whichever is known; when
  neither is resolvable (1.8.0, issue #5) both are **absent** — never the
  literal `"unknown"`, which consumers cannot distinguish from a real model —
  and the consumer excludes the span from its models list.
- **Tool errors carry the real reason (issue #7).** On a tool error the span
  **status message** holds the real, sanitized error (≤200 chars, single line,
  never the tool's full output) — the consumer reads `statusMessage`, so a bare
  `Error` is replaced by the actual reason (which already contains any embedded
  code, e.g. `… 404`). The same text is mirrored on `openclaw.tool.error`.
  `openclaw.errorCode` / `openclaw.errorCategory` stay consumer reads but are not
  synthesized here — 2026.5.28 exposes no structured error fields, so a derived
  code would be a guess.

## Built-ins this plugin does NOT emit

A consumer may recognize both the plugin vocabulary above and OpenClaw's
**built-in** `diagnostics.otel` vocabulary, mapping them to the same roles. Normal
request/turn/model/tool flows are fully covered by the plugin spans. Two built-ins
are intentionally not produced:

- `openclaw.run` — built-in trace root. Covered: `openclaw.request` maps to the
  same `ROLE_ROOT`.
- `openclaw.model.usage` — built-in per-turn usage span the SigNoz **Cost page**
  filters by exact name (reading `openclaw.tokens.{input,output,cache_read,cache_write}`).
  The plugin routes token accounting through `gen_ai.usage.*` on the turn
  instead (folding gen_ai cache tokens onto a usage span would double-count).
  **Caveat:** a plugin-only deployment yields nothing for that exact Cost-page
  query — confirm the Cost page has a plugin path or it under-reports.

Skill attribution **is** produced by the plugin: `openclaw.skill.used` (above)
mirrors the built-in skill span, driven by the `skill.used` internal diagnostic.
Other built-in-only signals (exec telemetry `openclaw.exec.*`, context sizing
`openclaw.context.*`, harness counters `openclaw.harness.*`) belong to OpenClaw's
built-in emitter and are simply empty for plugin-only deployments — the plugin is
not expected to reproduce them.
