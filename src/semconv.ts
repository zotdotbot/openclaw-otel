/*
 * Copyright The @zotdotbot/openclaw-otel Authors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Semantic-convention identifiers for the OpenClaw OpenTelemetry plugin.
 *
 * Every span attribute, span name, span-name prefix, metric name, resource
 * attribute, schema-version key/value, and enum value referenced anywhere in
 * this package is declared here exactly once. Call sites import the constant
 * rather than re-typing the literal, so the wire contract observed by
 * downstream consumers stays stable and greppable in one place.
 *
 * The identifiers fall into two families:
 *
 *   - `gen_ai.*` — OpenTelemetry GenAI semantic conventions (standard).
 *   - `openclaw.*` — plugin-domain attributes for OpenClaw concepts that the
 *     standard GenAI conventions do not cover (derived/plugin-specific).
 *
 * Wire stability is load-bearing: a downstream consumer classifies spans by
 * name and reads specific attribute keys verbatim. Renaming any exported
 * value here is a breaking change to that contract. See CONTRACT.md.
 */

// ─────────────────────────────────────────────────────────────────────────────
// GenAI semantic-convention attribute keys (standard)
// ─────────────────────────────────────────────────────────────────────────────

/** GenAI operation name, e.g. `chat`, `execute_tool`. Set on CLIENT/tool spans. */
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
/** GenAI provider identifier (replaces the deprecated `gen_ai.system`). */
export const GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";

/** Model requested for an operation. Required on the `chat <model>` span. */
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
/** Optional request knobs — emitted but not read by the consumer. */
export const GEN_AI_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens";
export const GEN_AI_REQUEST_STREAM = "gen_ai.request.stream";

/** Model that actually served the response. Required on `openclaw.agent.turn`. */
export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
/** Optional response metadata — emitted but not read by the consumer. */
export const GEN_AI_RESPONSE_ID = "gen_ai.response.id";
export const GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons";

/**
 * Conversation correlation id. Required on every consumer-read span; the
 * consumer's `_conversation_id()` tries this key first, then falls back to
 * {@link OPENCLAW_SESSION_KEY}. Both MUST be present on every span.
 */
export const GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id";

/** Optional agent identity — emitted but not read by the consumer. */
export const GEN_AI_AGENT_ID = "gen_ai.agent.id";
export const GEN_AI_AGENT_NAME = "gen_ai.agent.name";

/** Tool name on `execute_tool <tool>` spans (first link in the consumer's tool-name chain). */
export const GEN_AI_TOOL_NAME = "gen_ai.tool.name";
/** Tool-call id; pairs the `execute_tool` span with its synthetic echo span. */
export const GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id";
/** Optional tool classification — emitted but not read by the consumer. */
export const GEN_AI_TOOL_TYPE = "gen_ai.tool.type";

/** Token counts that the consumer's `token_usage_totals()` rolls up. */
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
/**
 * Split-out cache token counts. Emitted on `openclaw.agent.turn` only when
 * nonzero; keep both keys verbatim or cache accounting silently drops.
 */
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = "gen_ai.usage.cache_read.input_tokens";
export const GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS =
  "gen_ai.usage.cache_creation.input_tokens";

/** Dimension on the `gen_ai.client.token.usage` histogram (`input` / `output`). */
export const GEN_AI_TOKEN_TYPE = "gen_ai.token.type";

// ─────────────────────────────────────────────────────────────────────────────
// GenAI operation-name values (standard)
// ─────────────────────────────────────────────────────────────────────────────

/** `gen_ai.operation.name` value for a model chat completion. */
export const OP_CHAT = "chat";
/** `gen_ai.operation.name` value for a tool invocation. */
export const OP_EXECUTE_TOOL = "execute_tool";
/** `gen_ai.operation.name` value for an agent invocation. */
export const OP_INVOKE_AGENT = "invoke_agent";

// ─────────────────────────────────────────────────────────────────────────────
// OpenClaw plugin-domain attribute keys (derived)
// ─────────────────────────────────────────────────────────────────────────────

// Session / correlation -------------------------------------------------------

/**
 * Canonical session key. String format is load-bearing:
 * `agent:<id>:<channel>:...` — the consumer parses channel and correlation
 * out of it. Required on every consumer-read span and the stalled metric's
 * groupBy. Also the second correlation fallback after
 * {@link GEN_AI_CONVERSATION_ID}.
 */
export const OPENCLAW_SESSION_KEY = "openclaw.session.key";

// Message routing -------------------------------------------------------------

/** Channel the turn arrived on. Emitted directly on `openclaw.request`. */
export const OPENCLAW_MESSAGE_CHANNEL = "openclaw.message.channel";
/** `inbound` / `outbound`. Required on `openclaw.request` and `openclaw.message.sent`. */
export const OPENCLAW_MESSAGE_DIRECTION = "openclaw.message.direction";
/**
 * Sender address. String format is load-bearing: `<channel>:...` — the
 * consumer derives the channel from it. Read off `openclaw.request`.
 */
export const OPENCLAW_MESSAGE_FROM = "openclaw.message.from";
/** Recipient address. Harvested by the consumer off `openclaw.message.sent`. */
export const OPENCLAW_MESSAGE_TO = "openclaw.message.to";
/** Character count of the message body. Required on `openclaw.message.sent`. */
export const OPENCLAW_MESSAGE_CHARS = "openclaw.message.chars";

/** What triggered the turn. Read off `openclaw.request`. */
export const OPENCLAW_TRIGGER = "openclaw.trigger";

// Agent turn ------------------------------------------------------------------

/**
 * Turn outcome, emitted as a boolean. The consumer reads it type-tolerantly
 * (as a trimmed, lowercased string), so a JS boolean is correct; `false` marks a
 * failed turn.
 */
export const OPENCLAW_AGENT_SUCCESS = "openclaw.agent.success";
/**
 * Model-name fallback. Read by the consumer on the `chat <model>` and usage
 * spans when {@link GEN_AI_REQUEST_MODEL} is absent; also part of the Cost
 * page's `_USAGE_MODEL_ATTRS`. Harmless today (gen_ai.request.model is
 * present) but it IS a consumer read — keep at least one of
 * {gen_ai.request.model, openclaw.model} on model/usage spans.
 */
export const OPENCLAW_MODEL = "openclaw.model";
/** Optional agent metadata — emitted but not read by the consumer. */
export const OPENCLAW_AGENT_ID = "openclaw.agent.id";
export const OPENCLAW_AGENT_MODEL = "openclaw.agent.model";
export const OPENCLAW_AGENT_DURATION_MS = "openclaw.agent.duration_ms";
export const OPENCLAW_AGENT_ERROR = "openclaw.agent.error";

// Cron lifecycle (1.6.0) ------------------------------------------------------
// First-class cron attributes. job_id/job_name/schedule_* ride the turn/request
// spans of a cron-triggered turn AND the openclaw.cron.run / .definition spans.
// Plugin-domain (the built-in diagnostics.otel never modeled cron lifecycle).

/** Stable cron job id. First-class join key — replaces parsing it out of the
 *  session key `agent:<id>:cron:<jobId>:run:<token>`. */
export const OPENCLAW_CRON_JOB_ID = "openclaw.cron.job_id";
/** Human cron job name (from the cron registry; absent on run events, so sourced
 *  from the cron-metadata cache seeded via getCron()). */
export const OPENCLAW_CRON_JOB_NAME = "openclaw.cron.job_name";
/** Per-run id (distinct from the session-key run token). Correlates an
 *  openclaw.cron.run to its openclaw.agent.turn when a turn actually ran. */
export const OPENCLAW_CRON_RUN_ID = "openclaw.cron.run_id";
/** Registry action on openclaw.cron.definition: `added` | `updated` | `removed`. */
export const OPENCLAW_CRON_ACTION = "openclaw.cron.action";
/** Scheduler outcome on openclaw.cron.run: `ok` | `error` | `skipped` (or
 *  `unknown` if a host `finished` event ever omits status — never defaulted to
 *  `ok`, so a malformed run is not silently counted a success). The authoritative
 *  per-run status (openclaw.agent.success only covers turn-bearing runs;
 *  `skipped` / turn-less runs have no turn). */
export const OPENCLAW_CRON_STATUS = "openclaw.cron.status";
/** Schedule discriminant: `cron` | `at` | `every`. */
export const OPENCLAW_CRON_SCHEDULE_KIND = "openclaw.cron.schedule_kind";
/** Cron expression when schedule_kind=`cron`, e.g. `0 9 * * 1-5`. */
export const OPENCLAW_CRON_SCHEDULE_EXPR = "openclaw.cron.schedule_expr";
/** Interval in ms when schedule_kind=`every`. */
export const OPENCLAW_CRON_SCHEDULE_EVERY_MS = "openclaw.cron.schedule_every_ms";
/** IANA timezone for the schedule, when present. */
export const OPENCLAW_CRON_SCHEDULE_TZ = "openclaw.cron.schedule_tz";
/** Next scheduled run, epoch ms — lets a consumer show "next run" + infer misses. */
export const OPENCLAW_CRON_NEXT_RUN_AT_MS = "openclaw.cron.next_run_at_ms";
/** Last observed run time / status on openclaw.cron.definition. */
export const OPENCLAW_CRON_LAST_RUN_AT_MS = "openclaw.cron.last_run_at_ms";
export const OPENCLAW_CRON_LAST_RUN_STATUS = "openclaw.cron.last_run_status";
/** Whether the job is enabled (openclaw.cron.definition). */
export const OPENCLAW_CRON_ENABLED = "openclaw.cron.enabled";
/** Tombstone marker on a `removed` definition span. */
export const OPENCLAW_CRON_REMOVED = "openclaw.cron.removed";
/** Run wall-clock duration, ms (openclaw.cron.run). */
export const OPENCLAW_CRON_DURATION_MS = "openclaw.cron.duration_ms";
/** Whether the run's reply was delivered, and the raw delivery-status string. */
export const OPENCLAW_CRON_DELIVERED = "openclaw.cron.delivered";
export const OPENCLAW_CRON_DELIVERY_STATUS = "openclaw.cron.delivery_status";
/** Bounded, single-line run summary (agent output) — emitted ONLY when
 *  captureContent.cronSummary is enabled (default off; may carry content). */
export const OPENCLAW_CRON_SUMMARY = "openclaw.cron.summary";

// Heartbeat lifecycle (1.6.0) -------------------------------------------------
// Driven by the `onHeartbeatEvent` bus (NOT a hook), config-gated default-off.
// A heartbeat tick is a periodic, turn-less self-check; this captures its
// outcome so an operator can see heartbeat health (sent vs skipped vs failed)
// that the agent-turn path can't surface (most ticks run no model turn). The
// payload carries no jobId/sessionKey, so the span synthesizes a `heartbeat`
// correlation key. NO recipient/content (`to`/`accountId`/`preview`) is emitted.

/** Heartbeat tick outcome: `sent` | `ok-empty` | `ok-token` | `skipped` | `failed`. */
export const OPENCLAW_HEARTBEAT_STATUS = "openclaw.heartbeat.status";
/** Skip/failure reason on a `skipped`/`failed` tick (e.g. `quiet-hours`,
 *  `cron-in-progress`, `agent-runner-failure`). Categorical, not content. */
export const OPENCLAW_HEARTBEAT_REASON = "openclaw.heartbeat.reason";
/** Channel the heartbeat targeted (e.g. `slack`), when present. */
export const OPENCLAW_HEARTBEAT_CHANNEL = "openclaw.heartbeat.channel";
/** Tick wall-clock duration, ms (includes model latency for sent/failed ticks). */
export const OPENCLAW_HEARTBEAT_DURATION_MS = "openclaw.heartbeat.duration_ms";
/** Whether the ok-acknowledgement was silently suppressed (showOk:false). */
export const OPENCLAW_HEARTBEAT_SILENT = "openclaw.heartbeat.silent";
/** Whether the heartbeat reply carried media attachments. */
export const OPENCLAW_HEARTBEAT_HAS_MEDIA = "openclaw.heartbeat.has_media";
/** UI status indicator the tick resolved to: `ok` | `alert` | `error`. */
export const OPENCLAW_HEARTBEAT_INDICATOR = "openclaw.heartbeat.indicator";

// Tool execution --------------------------------------------------------------

/** Plugin tool name (third link in the consumer's tool-name chain). */
export const OPENCLAW_TOOL_NAME = "openclaw.tool.name";
/**
 * Marks an echo span as synthetic so the consumer maps it to ROLE_OTHER
 * instead of double-counting the tool call. Keep on echo spans.
 */
export const OPENCLAW_TOOL_IS_SYNTHETIC = "openclaw.tool.is_synthetic";
/** Optional tool diagnostics — read opportunistically by the consumer. */
export const OPENCLAW_TOOL_RESULT_CHARS = "openclaw.tool.result_chars";
export const OPENCLAW_TOOL_INPUT_PREVIEW = "openclaw.tool.input_preview";
/** Mirror of {@link GEN_AI_TOOL_CALL_ID}; consumer reads the gen_ai key, not this. */
export const OPENCLAW_TOOL_CALL_ID = "openclaw.tool.call_id";
/** Optional tool result metadata — emitted but not read by the consumer. */
export const OPENCLAW_TOOL_RESULT_PARTS = "openclaw.tool.result_parts";

/**
 * Optional tool-error category. Read by the consumer's `tool_call()` on
 * plugin `execute_tool` spans, folded into the error string. It only
 * enriches the error text — it never gates classification — but it IS a
 * consumer read on a plugin span, so it is declared here.
 */
export const OPENCLAW_ERROR_CATEGORY = "openclaw.errorCategory";
/**
 * Optional tool-error CODE. Read by the consumer's `tool_call()` and appended
 * to the rendered error (e.g. a bare `Error` becomes `Error 404`). The consumer
 * reads it, but THIS plugin does not synthesize it: OpenClaw 2026.5.28 exposes
 * no structured error code (only a free-text message + an is_error boolean), so
 * a regex-derived code would be a guess. The real reason — with any embedded
 * code — rides {@link OPENCLAW_TOOL_ERROR} and the span status message instead.
 * Declared for the consumer contract; never gates classification.
 */
export const OPENCLAW_ERROR_CODE = "openclaw.errorCode";
/**
 * Short, sanitized tool-error message. The forward-compatible error attribute
 * named in issue #7: a bounded (≤200 char), single-line summary of the real
 * tool failure — NOT the tool's full output (which may carry PII/secrets and
 * is gated separately behind `toolOutputs` capture). Set on `execute_tool`
 * spans when a tool errors; the span status message carries the same text so
 * the current consumer (which reads `statusMessage`) gets the real error today.
 */
export const OPENCLAW_TOOL_ERROR = "openclaw.tool.error";

// Skill activation ------------------------------------------------------------

/**
 * Skill name on `openclaw.skill.used` spans. Read by the consumer's
 * `skill_usage()` / `evidence_signals()` for per-skill attribution. Mirrors the
 * built-in `diagnostics.otel` skill span so the consumer needs no change.
 */
export const OPENCLAW_SKILL_NAME = "openclaw.skill.name";
/** Skill provenance (`bundled` / `workspace` / `unknown`). Read by the consumer. */
export const OPENCLAW_SKILL_SOURCE = "openclaw.skill.source";
/** How the skill was activated (e.g. `invoked`). Emitted; opportunistic read. */
export const OPENCLAW_SKILL_ACTIVATION = "openclaw.skill.activation";

// Re-homed operational diagnostics --------------------------------------------
// These attributes ride spans we synthesize from OpenClaw's internal diagnostic
// stream (context.assembled / harness.run.* / message.processed /
// message.delivery.*) and PARENT into the live turn trace. The names mirror the
// built-in `diagnostics.otel` exactly, so an existing consumer reads them unchanged
// — but unlike the built-in's orphan fragments, ours are session-correlated.

/** Generic outcome on message.processed / message.delivery (`completed` / `error`). */
export const OPENCLAW_OUTCOME = "openclaw.outcome";
/** Free-text reason on message.processed (e.g. an error category). */
export const OPENCLAW_REASON = "openclaw.reason";
/** Channel on message.processed / message.delivery (e.g. `slack`). */
export const OPENCLAW_CHANNEL = "openclaw.channel";
/** Outbound delivery kind on message.delivery (e.g. `reply`). */
export const OPENCLAW_DELIVERY_KIND = "openclaw.delivery.kind";
/** Number of delivery results on message.delivery. */
export const OPENCLAW_DELIVERY_RESULT_COUNT = "openclaw.delivery.result_count";

/** Prompt-assembly sizing on openclaw.context.assembled (consumer-read). */
export const OPENCLAW_CONTEXT_PROMPT_CHARS = "openclaw.context.prompt_chars";
export const OPENCLAW_CONTEXT_SYSTEM_PROMPT_CHARS = "openclaw.context.system_prompt_chars";
export const OPENCLAW_CONTEXT_MESSAGE_COUNT = "openclaw.context.message_count";
export const OPENCLAW_CONTEXT_HISTORY_TEXT_CHARS = "openclaw.context.history_text_chars";
export const OPENCLAW_CONTEXT_TOKEN_BUDGET = "openclaw.context.token_budget";

/** Harness agentic-loop item lifecycle on openclaw.harness.run (consumer-read). */
export const OPENCLAW_HARNESS_ITEMS_STARTED = "openclaw.harness.items.started";
export const OPENCLAW_HARNESS_ITEMS_COMPLETED = "openclaw.harness.items.completed";
export const OPENCLAW_HARNESS_ITEMS_ACTIVE = "openclaw.harness.items.active";
export const OPENCLAW_HARNESS_RESULT_CLASSIFICATION = "openclaw.harness.result_classification";

// Per-call detail (read from the connected convention's chat / execute_tool spans)
// The `model_call_ended` hook event carries ttfb + payload byte sizes directly;
// the exec tool's `after_tool_call` result carries the shell exit code. These ride
// on our existing `chat`/`execute_tool` spans (not separate model.call/exec spans,
// which would double-count). Names mirror the built-in's model.call/exec attrs.

/** Time-to-first-byte on the `chat <model>` span (from model_call_ended). */
export const OPENCLAW_MODEL_CALL_TTFB_MS = "openclaw.model_call.time_to_first_byte_ms";
/** Request/response payload byte sizes on the `chat <model>` span. */
export const OPENCLAW_MODEL_CALL_REQUEST_BYTES = "openclaw.model_call.request_bytes";
export const OPENCLAW_MODEL_CALL_RESPONSE_BYTES = "openclaw.model_call.response_bytes";
/** Shell exit code / timeout on the `execute_tool exec` span (from after_tool_call). */
export const OPENCLAW_EXEC_EXIT_CODE = "openclaw.exec.exit_code";
export const OPENCLAW_EXEC_TIMED_OUT = "openclaw.exec.timed_out";

// Content capture -------------------------------------------------------------
// Fully-qualified `openclaw.content.*` keys. The consumer harvests these by
// attribute key wherever they land on the trace.

/** Inbound user message. On `openclaw.request`. */
export const OPENCLAW_CONTENT_INPUT_MESSAGE = "openclaw.content.input_message";
/** Outbound reply body. On `openclaw.message.sent`. */
export const OPENCLAW_CONTENT_OUTPUT_MESSAGE = "openclaw.content.output_message";
/** Assembled prompt / messages / system prompt. On `openclaw.agent.turn`. */
export const OPENCLAW_CONTENT_PROMPT = "openclaw.content.prompt";
export const OPENCLAW_CONTENT_MESSAGES = "openclaw.content.messages";
export const OPENCLAW_CONTENT_SYSTEM_PROMPT = "openclaw.content.system_prompt";
/**
 * Tool input / output. On `execute_tool <tool>`. When input capture is OFF
 * the input value MUST be the literal `"{}"` (not null/absent) — the
 * consumer treats `"{}"` as the capture-off sentinel.
 */
export const OPENCLAW_CONTENT_TOOL_INPUT = "openclaw.content.tool_input";
export const OPENCLAW_CONTENT_TOOL_OUTPUT = "openclaw.content.tool_output";

/** Capture-off sentinel value for {@link OPENCLAW_CONTENT_TOOL_INPUT}. */
export const TOOL_INPUT_CAPTURE_OFF = "{}";

// Optional / cost / context (emitted, not read by the consumer) --------------------

export const OPENCLAW_REQUEST_DURATION_MS = "openclaw.request.duration_ms";
export const OPENCLAW_LLM_COST_USD = "openclaw.llm.cost_usd";
export const OPENCLAW_CONTEXT_LIMIT = "openclaw.context.limit";
export const OPENCLAW_CONTEXT_USED = "openclaw.context.used";
export const OPENCLAW_PROVIDER = "openclaw.provider";

// ─────────────────────────────────────────────────────────────────────────────
// Cost-page token attributes (read by the SigNoz Cost page on the usage span)
// ─────────────────────────────────────────────────────────────────────────────
// `signoz.list_usage_spans` reads these float64 values off the
// `openclaw.model.usage` span. The plugin does NOT emit that span (gen_ai
// cache folding would double-count); token accounting flows through the
// gen_ai.usage.* keys on `openclaw.agent.turn` instead. Declared for the
// consumer contract.

export const OPENCLAW_TOKENS_INPUT = "openclaw.tokens.input";
export const OPENCLAW_TOKENS_OUTPUT = "openclaw.tokens.output";
export const OPENCLAW_TOKENS_CACHE_READ = "openclaw.tokens.cache_read";
export const OPENCLAW_TOKENS_CACHE_WRITE = "openclaw.tokens.cache_write";

// ─────────────────────────────────────────────────────────────────────────────
// Span names and name prefixes
// ─────────────────────────────────────────────────────────────────────────────

/** Trace-root span (SERVER). One turn = one trace. Consumer ROLE_ROOT. */
export const SPAN_OPENCLAW_REQUEST = "openclaw.request";
/** Agent-turn span (INTERNAL). The token rollup the consumer trusts. */
export const SPAN_OPENCLAW_AGENT_TURN = "openclaw.agent.turn";
/** Outbound-message span (INTERNAL). Carries reply content / routing attrs. */
export const SPAN_OPENCLAW_MESSAGE_SENT = "openclaw.message.sent";
/**
 * Skill-activation span (INTERNAL). Emitted from the `skill.used` internal
 * diagnostic (skills are not exposed via a plugin hook). Same name + attributes
 * as the built-in `diagnostics.otel` skill span, so the consumer's existing
 * `skill_usage()` reads it with no change.
 */
export const SPAN_OPENCLAW_SKILL_USED = "openclaw.skill.used";

/**
 * Re-homed operational spans (INTERNAL), synthesized from the internal
 * diagnostic stream and parented into the live turn trace. Same names + attrs as
 * the built-in `diagnostics.otel`, so the consumer reads them unchanged. Their
 * consumer roles (ROLE_CONTEXT / ROLE_OTHER) don't collide with the plugin's
 * model/tool/root spans, so emitting them adds operational signal WITHOUT
 * double-counting model calls or tool calls.
 */
export const SPAN_OPENCLAW_CONTEXT_ASSEMBLED = "openclaw.context.assembled";
export const SPAN_OPENCLAW_HARNESS_RUN = "openclaw.harness.run";
export const SPAN_OPENCLAW_MESSAGE_PROCESSED = "openclaw.message.processed";
export const SPAN_OPENCLAW_MESSAGE_DELIVERY = "openclaw.message.delivery";

/**
 * Cron lifecycle spans (NEW in 1.6.0). Driven by the `cron_changed` GATEWAY hook
 * (not the agent-turn path), so they cover EVERY scheduled run — including
 * turn-less `systemEvent` jobs, scheduler-`skipped` runs, and CLI-provider crons
 * that never fire `before_model_resolve`. Consumer role ROLE_OTHER: they carry no
 * model/tool/root semantics, so they never inflate those counts.
 *   - openclaw.cron.run        — one per scheduler firing (from action=finished),
 *                                joined to its openclaw.agent.turn (when a turn
 *                                ran) by (job_id, run_id); carries NO gen_ai.usage
 *                                so token totals are not double-counted.
 *   - openclaw.cron.definition — registry change / startup snapshot; latest-per
 *                                job_id is the live cron list with schedule.
 */
export const SPAN_OPENCLAW_CRON_RUN = "openclaw.cron.run";
export const SPAN_OPENCLAW_CRON_DEFINITION = "openclaw.cron.definition";

/**
 * Heartbeat lifecycle span (NEW in 1.6.0, config-gated default-off). One per
 * EMITTED heartbeat tick, driven by the `onHeartbeatEvent` bus. Covers ticks the
 * agent-turn path never surfaces: turn-less `skipped`/`ok-empty` ticks and
 * `failed` ticks. NOTE: idle/disabled/quiet-hours/no-tasks-due skips emit no bus
 * event, so this span counts emitted ticks only (sent/failed + contended skips),
 * NOT every wake. Consumer role ROLE_OTHER (no model/tool/root semantics).
 */
export const SPAN_OPENCLAW_HEARTBEAT_RUN = "openclaw.heartbeat.run";

/**
 * Consumer-demanded built-in root span name. NOT emitted by the plugin; the
 * consumer maps {@link SPAN_OPENCLAW_REQUEST} to the same ROLE_ROOT, so this
 * name need not be produced. Declared because the consumer reads it if present.
 */
export const SPAN_OPENCLAW_RUN = "openclaw.run";
/**
 * Consumer-demanded built-in usage span name. NOT emitted by the plugin (by
 * design — gen_ai cache folding would double-count). `signoz.list_usage_spans`
 * filters on this exact name for the Cost page. Declared for the contract.
 */
export const SPAN_OPENCLAW_MODEL_USAGE = "openclaw.model.usage";

/** Prefix for chat spans: `"chat " + model`. Consumer classifies by name. */
export const SPAN_PREFIX_CHAT = "chat ";
/** Prefix for tool spans: `"execute_tool " + tool`. Consumer classifies by name. */
export const SPAN_PREFIX_EXECUTE_TOOL = "execute_tool ";

/**
 * Build the CLIENT model span name from a model id. When the host events carry
 * no model (OpenRouter/DeepSeek on 2026.5.28), the name is the bare operation
 * "chat" per GenAI semconv — NEVER a placeholder like "chat unknown", which
 * consumers can't distinguish from a real model (issue #5). The consumer
 * classifies both forms as ROLE_MODEL (`op.startsWith("chat ") || op === "chat"`).
 */
export const spanNameChat = (model?: string): string =>
  model ? `${SPAN_PREFIX_CHAT}${model}` : "chat";
/** Build the INTERNAL tool span name from a tool name. */
export const spanNameExecuteTool = (tool: string): string =>
  `${SPAN_PREFIX_EXECUTE_TOOL}${tool}`;

// ─────────────────────────────────────────────────────────────────────────────
// Metric names
// ─────────────────────────────────────────────────────────────────────────────

/** GenAI token usage histogram (standard). Emitted; not read by the consumer. */
export const METRIC_GEN_AI_CLIENT_TOKEN_USAGE = "gen_ai.client.token.usage";
/** GenAI operation duration histogram (standard). Emitted; not read by the consumer. */
export const METRIC_GEN_AI_CLIENT_OPERATION_DURATION = "gen_ai.client.operation.duration";
/**
 * Stalled-session counter. The single load-bearing metric the consumer reads;
 * grouped by {@link OPENCLAW_SESSION_KEY}. MUST NOT be dropped.
 */
export const METRIC_OPENCLAW_SESSION_STALLED = "openclaw.session.stalled";

/**
 * Opt-in cron/heartbeat run counters (NEW in 1.6.0). Emitted only when
 * `metrics` is enabled (and, for heartbeat, `heartbeat` is enabled). They make
 * `rate(...{status='error'})`-style alerting cheap WITHOUT a span→metric
 * pipeline; the openclaw.cron.run / openclaw.heartbeat.run spans remain the
 * source of truth. Low cardinality (keyed by status [+ job_id]).
 */
export const METRIC_OPENCLAW_CRON_RUNS = "openclaw.cron.runs";
export const METRIC_OPENCLAW_HEARTBEAT_RUNS = "openclaw.heartbeat.runs";

// ─────────────────────────────────────────────────────────────────────────────
// Resource attributes
// ─────────────────────────────────────────────────────────────────────────────

/** Standard service-identity resource attributes. */
export const RESOURCE_SERVICE_NAME = "service.name";
export const RESOURCE_SERVICE_VERSION = "service.version";
/** Plugin identity. */
export const RESOURCE_OPENCLAW_PLUGIN = "openclaw.plugin";
/** Carries {@link OPENCLAW_SCHEMA_VERSION} on the Resource. */
export const RESOURCE_OPENCLAW_SCHEMA_VERSION = "openclaw.schema.version";
/**
 * The HOST OpenClaw gateway version (1.7.0, BEST-EFFORT): resolved from the
 * host's `package.json` at startup (see host-version.ts) and omitted when
 * resolution fails, so consumers must treat it as optional. Distinct from
 * `service.version`, which is this plugin's own version.
 */
export const RESOURCE_OPENCLAW_VERSION = "openclaw.version";

/**
 * OpenTelemetry semantic-conventions schema URL emitted on the Resource — the
 * SINGLE SOURCE (contract.ts re-exports this as `OTEL_SEMCONV_SCHEMA_URL`).
 * Pinned to the supported semconv generation — do not bump in lockstep with the
 * plugin schema version; the two version independently.
 */
export const OTEL_SCHEMA_URL = "https://opentelemetry.io/schemas/1.41.1" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Schema version
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Plugin-domain schema version — the SINGLE SOURCE of truth (contract.ts
 * re-exports this as `SCHEMA_VERSION`); rides on every span/Resource as
 * `openclaw.schema.version`. `1.7.0` is an ADDITIVE bump over `1.6.0` adding
 * the BEST-EFFORT `openclaw.version` resource attribute (host gateway version,
 * omitted when unresolvable — consumers must not require it). `1.6.0` was an
 * ADDITIVE bump over `1.5.0` covering cron AND heartbeat lifecycle:
 *   - cron-lifecycle spans `openclaw.cron.run` + `openclaw.cron.definition`
 *     (driven by the `cron_changed` gateway hook, covering turn-less / skipped /
 *     CLI-provider runs the agent-turn path never sees) and the `openclaw.cron.*`
 *     attributes, stamping `cron.job_id`/`job_name`/`schedule_*` onto cron turn
 *     spans too;
 *   - the heartbeat-lifecycle span `openclaw.heartbeat.run` (driven by the
 *     `onHeartbeatEvent` bus, config-gated default-off) + `openclaw.heartbeat.*`;
 *   - opt-in run counters `openclaw.cron.runs` / `openclaw.heartbeat.runs`.
 * (`1.5.0` re-homed the operational diagnostic spans + per-call detail; `1.4.0`
 * added `openclaw.skill.used` + tool-error attrs over `1.3.0`.) All-new span
 * names, attributes, and metrics only, so older consumers ignore them.
 *
 * `1.8.0` is a LOOSENING bump over `1.7.0` (issue #5): `gen_ai.request.model` +
 * `gen_ai.provider.name` on `chat ` spans and `gen_ai.response.model` on
 * `openclaw.agent.turn` are now OPTIONAL — omitted (never the literal
 * `"unknown"`) when the host events carry no model/provider, and the chat span
 * name falls back to bare `"chat"`. Consumers that coalesce absent → fallback
 * are unaffected; consumers that required these attrs must relax them.
 */
export const OPENCLAW_SCHEMA_VERSION = "1.8.0" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Token-type enum values
// ─────────────────────────────────────────────────────────────────────────────

export const TOKEN_TYPE_INPUT = "input";
export const TOKEN_TYPE_OUTPUT = "output";
export const TOKEN_TYPE_CACHE_READ = "cache_read";
export const TOKEN_TYPE_CACHE_CREATION = "cache_creation";
