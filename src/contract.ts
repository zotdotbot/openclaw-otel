// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Zot. Authored from scratch as Zot's own expression of the
// frozen OpenClaw telemetry wire contract — not derived from any upstream file.

/**
 * THE FROZEN TELEMETRY WIRE CONTRACT.
 *
 * This module is the single, machine-readable source of truth for the span,
 * metric, and resource vocabulary this plugin emits over OTLP and that
 * downstream consumers parse. It exists for two reasons:
 *
 *   1. SELF-DOCUMENTATION. The typed tables below describe, per span, the
 *      exact name (or name pattern), span kind, the attributes that MUST be
 *      present, the content attributes present when content capture is on,
 *      whether a consumer reads the span, and the load-bearing semantics the
 *      consumer depends on. Read this file to understand the vocabulary.
 *
 *   2. TEST ENFORCEMENT. The data is exported as plain, typed values so a
 *      contract test can drive a real OTel SDK through a simulated turn and
 *      assert every emitted span/metric against this table. An accidental
 *      rename, a dropped required attribute, or a changed string format fails
 *      CI here instead of silently thinning what consumers can read downstream.
 *
 * COMPATIBILITY RULE. This is a wire contract shared with out-of-tree
 * consumers. It is frozen at
 * {@link SCHEMA_VERSION}. Any change to a span name, a required attribute, a
 * metric name/instrument, a resource attribute, or one of the load-bearing
 * STRING FORMATS noted below is a breaking change: bump {@link SCHEMA_VERSION}
 * AND update consumers in lockstep. Same wire output ⇒ keep the version.
 *
 * The OTel semconv schema URL on the emitted Resource is pinned separately
 * (see {@link OTEL_SEMCONV_SCHEMA_URL}); it tells backends which generation of
 * `gen_ai.*` / `code.*` names this plugin speaks. Bump neither casually.
 */

import { OPENCLAW_SCHEMA_VERSION, OTEL_SCHEMA_URL } from "./semconv";

/** Frozen plugin-domain schema version, ridden on every span as
 *  `openclaw.schema.version`. Re-exported from {@link OPENCLAW_SCHEMA_VERSION}
 *  in semconv.ts (the single source) — see there for the changelog. Bump
 *  in that one place and update consumers in lockstep. */
export const SCHEMA_VERSION = OPENCLAW_SCHEMA_VERSION;

/** Pinned OTel semantic-conventions schema URL on the emitted Resource.
 *  Re-exported from {@link OTEL_SCHEMA_URL} in semconv.ts (the single source). */
export const OTEL_SEMCONV_SCHEMA_URL = OTEL_SCHEMA_URL;

// ───────────────────────────────────────────────────────────────────────────
// Span kinds
// ───────────────────────────────────────────────────────────────────────────

/** The OTel SpanKind values used by this contract. Encoded as strings so the
 *  contract is consumable without importing the OTel SDK enum. */
export type SpanKind = "SERVER" | "CLIENT" | "INTERNAL";

// ───────────────────────────────────────────────────────────────────────────
// Span contract
// ───────────────────────────────────────────────────────────────────────────

/**
 * Distinguishes a fixed span name from one whose name embeds a runtime value
 * (a model or tool name). `exact` ⇒ assert `span.name === name`. `prefix` ⇒
 * assert `span.name.startsWith(name)` (note the trailing space is significant,
 * e.g. `"chat "` and `"execute_tool "`).
 */
export type SpanNameMatch = "exact" | "prefix";

/** One span in the frozen vocabulary. */
export interface ContractSpan {
  /** The span name (when {@link match} is `exact`) or its leading prefix
   *  including the trailing space (when {@link match} is `prefix`). */
  readonly name: string;
  /** How {@link name} is compared against an emitted span's name. */
  readonly match: SpanNameMatch;
  /** OTel SpanKind this span is emitted with. */
  readonly kind: SpanKind;
  /**
   * True when a downstream consumer reads this span. Note this can be
   * true for spans the plugin does NOT emit (consumer-demanded built-ins):
   * those are documented here for completeness and to record WHY the plugin is
   * not required to emit them — see {@link emittedByPlugin} and {@link notes}.
   */
  readonly readByConsumer: boolean;
  /** True when THIS plugin actually emits a span of this name. False entries
   *  are consumer-demanded built-ins covered by an emitted equivalent. */
  readonly emittedByPlugin: boolean;
  /** Attributes that MUST be present on every emitted span of this kind. */
  readonly requiredAttributes: readonly string[];
  /** Attributes present when the relevant content-capture policy is enabled.
   *  Absent (or the `"{}"` capture-off sentinel for tool input) otherwise. */
  readonly contentAttributes: readonly string[];
  /**
   * Attributes the consumer reads OPPORTUNISTICALLY if present. Never gate
   * classification or required-attribute assertions on these — they enrich
   * model/tool/error surfaces only. Includes the fallback keys the adversarial
   * audit flagged as genuinely consumer-read (e.g. `openclaw.model`,
   * `openclaw.errorCategory`) so the contract does not misreport them as
   * unread. Harmless to omit today because a required attribute always covers
   * the same datum, but keep at least one of each documented pair.
   */
  readonly optionalReadAttributes: readonly string[];
  /** Load-bearing semantics: classification rules, string formats, retention
   *  windows, double-count hazards. Changing behavior described here is a
   *  breaking change even if the name and required attributes are untouched. */
  readonly notes: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Metric contract
// ───────────────────────────────────────────────────────────────────────────

/** Supported OTel instrument kinds in this contract. */
export type InstrumentKind = "Counter" | "Histogram" | "Gauge";

/** One metric in the frozen vocabulary. */
export interface ContractMetric {
  /** Metric instrument name as emitted. */
  readonly name: string;
  /** OTel instrument kind. */
  readonly instrument: InstrumentKind;
  /** True when a downstream consumer reads this metric. Exactly one
   *  metric (`openclaw.session.stalled`) is read; it is load-bearing and must
   *  not be dropped. The two `gen_ai.client.*` histograms are emitted but
   *  unread by the consumer (still used by external dashboards — do not trim
   *  without checking those). */
  readonly readByConsumer: boolean;
  /** Attributes the consumer groups/keys by on this metric, if any. */
  readonly keyedBy: readonly string[];
  readonly notes: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Spans
// ───────────────────────────────────────────────────────────────────────────

export const CONTRACT_SPANS: readonly ContractSpan[] = [
  {
    name: "openclaw.request",
    match: "exact",
    kind: "SERVER",
    readByConsumer: true,
    emittedByPlugin: true,
    requiredAttributes: [
      "openclaw.session.key",
      "gen_ai.conversation.id",
      "openclaw.message.channel",
      "openclaw.message.direction",
    ],
    contentAttributes: ["openclaw.content.input_message"],
    optionalReadAttributes: [
      // Consumer also reads the channel-bearing `from` string and the trigger.
      "openclaw.message.from",
      "openclaw.trigger",
      // Cron enrichment (1.6.0) — present only on cron-triggered turns; absent on
      // normal/heartbeat turns, so OPTIONAL (never required).
      "openclaw.cron.job_id",
      "openclaw.cron.job_name",
      "openclaw.cron.run_id",
      "openclaw.cron.schedule_kind",
      "openclaw.cron.schedule_expr",
      "openclaw.cron.schedule_every_ms",
      "openclaw.cron.schedule_tz",
    ],
    notes:
      "Trace root: one turn = one trace. The consumer classifies this as ROLE_ROOT " +
      "(_PLUGIN_ROOT_SPAN), the SAME role it maps the consumer-demanded built-in " +
      "openclaw.run to. Emitted with SpanKind.SERVER. The consumer derives the " +
      "channel from openclaw.message.from, whose format is '<channel>:...' — that " +
      "STRING FORMAT is load-bearing, not just the key's presence. Keep the name " +
      "and all four required attributes verbatim.",
  },
  {
    name: "openclaw.agent.turn",
    match: "exact",
    kind: "INTERNAL",
    readByConsumer: true,
    emittedByPlugin: true,
    requiredAttributes: [
      "openclaw.session.key",
      "gen_ai.conversation.id",
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
      "openclaw.agent.success",
    ],
    contentAttributes: [
      "openclaw.content.prompt",
      "openclaw.content.messages",
      "openclaw.content.system_prompt",
    ],
    optionalReadAttributes: [
      // OPTIONAL since 1.8.0 (issue #5): omitted when the agent_end event and
      // the model.usage diagnostic carry no model — NEVER the literal "unknown",
      // which masks the real model for downstream cost attribution. When the
      // model.usage diagnostic carries a model, enrichSpanWithUsage back-fills
      // it on the held-open span.
      "gen_ai.response.model",
      // Split-out cache token attrs MUST stay when nonzero; the rollup folds them.
      "gen_ai.usage.cache_read.input_tokens",
      "gen_ai.usage.cache_creation.input_tokens",
      // Cron enrichment (1.6.0) — present only on cron-triggered turns. The
      // (cron.job_id, cron.run_id) pair joins this turn to its openclaw.cron.run.
      "openclaw.cron.job_id",
      "openclaw.cron.job_name",
      "openclaw.cron.run_id",
      "openclaw.cron.schedule_kind",
      "openclaw.cron.schedule_expr",
      "openclaw.cron.schedule_every_ms",
      "openclaw.cron.schedule_tz",
    ],
    notes:
      "_PLUGIN_TURN_SPAN — the authoritative token rollup the consumer's " +
      "token_usage_totals() trusts. The split cache attrs " +
      "gen_ai.usage.cache_read.input_tokens / cache_creation.input_tokens MUST be " +
      "emitted when nonzero or cache tokens are lost. openclaw.agent.success is a " +
      "boolean (the consumer reads it as a lowercased string); false marks a failed " +
      "turn. The span is held open until the model usage " +
      "diagnostic lands or a 10s grace elapses, so gen_ai.usage.* is deterministic. " +
      "Content keys are the fully-qualified openclaw.content.{prompt,messages," +
      "system_prompt}. Cost/context attrs may ride here but are NOT read by the consumer.",
  },
  {
    name: "chat ",
    match: "prefix",
    kind: "CLIENT",
    readByConsumer: true,
    emittedByPlugin: true,
    requiredAttributes: [
      "gen_ai.operation.name",
      "gen_ai.conversation.id",
    ],
    contentAttributes: [],
    optionalReadAttributes: [
      // OPTIONAL since 1.8.0 (issue #5): omitted when the model_call_started
      // event carries no model/provider (OpenRouter/DeepSeek on 2026.5.28) —
      // NEVER the literal "unknown", which is indistinguishable from a real
      // value and poisons downstream cost attribution.
      "gen_ai.request.model",
      "gen_ai.provider.name",
      // Model-name FALLBACK actually read by the consumer (audit-confirmed):
      // it IS read — do not relabel it as consumer-ignored. When BOTH
      // gen_ai.request.model and openclaw.model are absent, the consumer
      // excludes the span from its models list — the correct behavior.
      "openclaw.model",
      // Per-call latency/size, read from the model_call_ended hook event and set
      // HERE (on chat) rather than a separate openclaw.model.call span (which
      // would double the model-call count). The consumer reads ttfb for slow-call
      // detection; it must read these off ROLE_MODEL chat spans, not only model.call.
      "openclaw.model_call.time_to_first_byte_ms",
      "openclaw.model_call.request_bytes",
      "openclaw.model_call.response_bytes",
    ],
    notes:
      "Name = 'chat ' + model, or the bare 'chat' when no model is resolvable " +
      "(1.8.0, issue #5). The consumer matches the span-name prefix 'chat ' AND the " +
      "exact 'chat' => ROLE_MODEL; classification is by SPAN NAME ONLY, never by " +
      "gen_ai.operation.name. This span MAY duplicate the turn's gen_ai.usage.* " +
      "verbatim — the consumer must NOT sum both. operational_signals reads " +
      "gen_ai.request.model off this span (with openclaw.model as fallback) for " +
      "the models list.",
  },
  {
    name: "execute_tool ",
    match: "prefix",
    kind: "INTERNAL",
    readByConsumer: true,
    emittedByPlugin: true,
    requiredAttributes: [
      "gen_ai.operation.name",
      "gen_ai.tool.name",
      "gen_ai.tool.call.id",
      "gen_ai.conversation.id",
      "openclaw.tool.name",
    ],
    contentAttributes: [
      "openclaw.content.tool_input",
      "openclaw.content.tool_output",
    ],
    optionalReadAttributes: [
      "openclaw.tool.is_synthetic",
      "openclaw.tool.result_chars",
      "openclaw.tool.input_preview",
      "gen_ai.tool.type",
      // Read in the consumer's tool_call() error path; enrich the error string
      // only, never gate classification. Set on errored plugin execute_tool spans.
      "openclaw.errorCategory",
      "openclaw.errorCode",
      // Shell exec detail, read from the exec tool's after_tool_call result and set
      // HERE (on execute_tool) rather than a separate openclaw.exec span (which
      // would double the tool count). The consumer must read these off the
      // execute_tool span, not only openclaw.exec.
      "openclaw.exec.exit_code",
      "openclaw.exec.timed_out",
    ],
    notes:
      "Name = 'execute_tool ' + tool. The span-name prefix 'execute_tool' => ROLE_TOOL " +
      "UNLESS openclaw.tool.is_synthetic is present (the echo span => ROLE_OTHER). " +
      "is_synthetic MUST stay on the echo or tool calls double-count; " +
      "gen_ai.tool.call.id pairs the real span with its echo. The consumer's " +
      "tool-name fallback chain is (gen_ai.tool.name, openclaw.toolName, " +
      "openclaw.tool.name): this plugin emits the first and third (NOT camelCase " +
      "openclaw.toolName), which covers it. CAPTURE-OFF SENTINEL: emit the literal " +
      "'{}' (never null/absent) for openclaw.content.tool_input when input capture " +
      "is off — the consumer treats '{}' as empty and mis-detects capture state " +
      "otherwise. ERROR SURFACING (issue #7): on a tool error the span STATUS " +
      "MESSAGE carries the real, sanitized error (≤200 chars, single line, no " +
      "body) — the consumer reads statusMessage, so a bare 'Error' is replaced by " +
      "the real reason (which already contains any code, e.g. '... 404'). The same " +
      "text is mirrored on openclaw.tool.error. openclaw.errorCode / " +
      "openclaw.errorCategory remain consumer reads but are NOT synthesized here: " +
      "2026.5.28 exposes no structured error fields, so a regex-derived code would " +
      "be a guess. The full tool output is NEVER emitted as the error.",
  },
  {
    name: "openclaw.message.sent",
    match: "exact",
    kind: "INTERNAL",
    readByConsumer: false,
    emittedByPlugin: true,
    requiredAttributes: [
      "openclaw.session.key",
      "gen_ai.conversation.id",
      "openclaw.message.direction",
      "openclaw.message.chars",
    ],
    contentAttributes: ["openclaw.content.output_message"],
    optionalReadAttributes: [
      // Harvested by attr key wherever it lands, regardless of span role.
      "openclaw.message.to",
    ],
    notes:
      "The span NAME is not mapped to a consumer role constant => ROLE_OTHER, hence " +
      "readByConsumer=false at the span level. The span is STILL required: the consumer " +
      "harvests openclaw.content.output_message and openclaw.message.to by ATTR " +
      "KEY wherever they land, and the span joins its trace via completed-root " +
      "retention (a 10-minute window). Keep the span plus its content and routing " +
      "attributes.",
  },
  {
    name: "openclaw.skill.used",
    match: "exact",
    kind: "INTERNAL",
    readByConsumer: true,
    emittedByPlugin: true,
    requiredAttributes: [
      "openclaw.session.key",
      "gen_ai.conversation.id",
      "openclaw.skill.name",
      "openclaw.skill.source",
    ],
    contentAttributes: [],
    optionalReadAttributes: [
      "openclaw.skill.activation",
      // When a skill is activated by a tool read, the tool name rides along.
      "openclaw.tool.name",
    ],
    notes:
      "Per-skill attribution span. Skills are NOT exposed via a plugin hook on " +
      "OpenClaw 2026.5.28 — this span is driven by the `skill.used` INTERNAL " +
      "diagnostic (same channel as model.usage), emitted with the SAME name and " +
      "attributes as the built-in diagnostics.otel skill span so the consumer's " +
      "skill_usage()/evidence_signals() read it with NO consumer change. Parented " +
      "to the session's live trace context (resolveContext by session key) and " +
      "started at the diagnostic timestamp, giving the consumer real activation " +
      "ordering for its per-skill window attribution. A ~0-duration marker span. " +
      "openclaw.skill.name and openclaw.skill.source are the load-bearing reads; " +
      "source is one of bundled/workspace/unknown.",
  },
  {
    name: "openclaw.context.assembled",
    match: "exact",
    kind: "INTERNAL",
    readByConsumer: true,
    emittedByPlugin: true,
    requiredAttributes: ["openclaw.session.key", "gen_ai.conversation.id"],
    contentAttributes: [],
    optionalReadAttributes: [
      "openclaw.context.prompt_chars",
      "openclaw.context.system_prompt_chars",
      "openclaw.context.message_count",
      "openclaw.context.history_text_chars",
      "openclaw.context.token_budget",
    ],
    notes:
      "Prompt-assembly sizing (ROLE_CONTEXT). Re-homed from the `context.assembled` " +
      "INTERNAL diagnostic — no plugin hook exposes it. Same name + attrs as the " +
      "built-in diagnostics.otel, parented into the live turn trace by session key, " +
      "so the consumer's _context_bits()/evidence_signals() read it unchanged. " +
      "ROLE_CONTEXT does not collide with model/tool/root counts.",
  },
  {
    name: "openclaw.harness.run",
    match: "exact",
    kind: "INTERNAL",
    readByConsumer: true,
    emittedByPlugin: true,
    requiredAttributes: ["openclaw.session.key", "gen_ai.conversation.id"],
    contentAttributes: [],
    optionalReadAttributes: [
      "openclaw.harness.items.started",
      "openclaw.harness.items.completed",
      "openclaw.harness.items.active",
      "openclaw.harness.result_classification",
      "openclaw.outcome",
    ],
    notes:
      "Agentic-loop item lifecycle (ROLE_OTHER). Re-homed from `harness.run.completed`" +
      "/`harness.run.error`. The consumer flags incomplete loops (completed < started). " +
      "Spans [end - durationMs, end]; ERROR status on harness.run.error.",
  },
  {
    name: "openclaw.message.processed",
    match: "exact",
    kind: "INTERNAL",
    readByConsumer: true,
    emittedByPlugin: true,
    requiredAttributes: ["openclaw.session.key", "gen_ai.conversation.id"],
    contentAttributes: [],
    optionalReadAttributes: ["openclaw.channel", "openclaw.outcome", "openclaw.reason"],
    notes:
      "Inbound-message outcome (ROLE_OTHER) — the consumer's top error source. " +
      "Re-homed from `message.processed`; ERROR status + reason when outcome=error.",
  },
  {
    name: "openclaw.message.delivery",
    match: "exact",
    kind: "INTERNAL",
    readByConsumer: true,
    emittedByPlugin: true,
    requiredAttributes: ["openclaw.session.key", "gen_ai.conversation.id"],
    contentAttributes: [],
    optionalReadAttributes: [
      "openclaw.channel",
      "openclaw.delivery.kind",
      "openclaw.delivery.result_count",
      "openclaw.outcome",
    ],
    notes:
      "Outbound-delivery outcome (ROLE_OTHER). Re-homed from " +
      "`message.delivery.completed`/`message.delivery.error`. Distinct from " +
      "openclaw.message.sent (which carries the reply content); this carries " +
      "delivery kind/result_count/outcome.",
  },
  {
    name: "openclaw.cron.run",
    match: "exact",
    kind: "INTERNAL",
    readByConsumer: true,
    emittedByPlugin: true,
    requiredAttributes: [
      "openclaw.session.key",
      "gen_ai.conversation.id",
      "openclaw.cron.job_id",
      "openclaw.cron.status",
    ],
    contentAttributes: ["openclaw.cron.summary"],
    optionalReadAttributes: [
      "openclaw.cron.job_name",
      "openclaw.cron.run_id",
      "openclaw.cron.duration_ms",
      "openclaw.cron.delivered",
      "openclaw.cron.delivery_status",
      "openclaw.cron.next_run_at_ms",
      "openclaw.cron.schedule_kind",
      "openclaw.cron.schedule_expr",
      "openclaw.cron.schedule_every_ms",
      "openclaw.cron.schedule_tz",
      "openclaw.trigger",
      "gen_ai.response.model",
      "gen_ai.provider.name",
    ],
    notes:
      "One per scheduler firing (1.6.0), emitted from the cron_changed GATEWAY hook " +
      "(action=finished) — so it exists for turn-less systemEvent jobs, scheduler- " +
      "skipped runs (openclaw.cron.status='skipped'), and CLI-provider crons that " +
      "never fire before_model_resolve. Classified ROLE_OTHER (does NOT inflate " +
      "model/tool/root counts). SpanKind.INTERNAL when joined to its just-finished " +
      "turn trace (session.key resolves to a live/retained turn), else SERVER root. " +
      "Joins openclaw.agent.turn by (openclaw.cron.job_id, openclaw.cron.run_id). " +
      "DELIBERATELY carries NO gen_ai.usage.* — the agent.turn is the token record; " +
      "a consumer counting RUNS uses this span, summing TOKENS uses agent.turn. " +
      "openclaw.cron.summary is content (agent output) — emitted only when " +
      "captureContent.cronSummary is on (default off).",
  },
  {
    name: "openclaw.cron.definition",
    match: "exact",
    kind: "INTERNAL",
    readByConsumer: true,
    emittedByPlugin: true,
    requiredAttributes: [
      "openclaw.session.key",
      "gen_ai.conversation.id",
      "openclaw.cron.job_id",
    ],
    contentAttributes: [],
    optionalReadAttributes: [
      "openclaw.cron.job_name",
      "openclaw.cron.action",
      "openclaw.cron.schedule_kind",
      "openclaw.cron.schedule_expr",
      "openclaw.cron.schedule_every_ms",
      "openclaw.cron.schedule_tz",
      "openclaw.cron.enabled",
      "openclaw.cron.next_run_at_ms",
      "openclaw.cron.last_run_at_ms",
      "openclaw.cron.last_run_status",
      "openclaw.cron.removed",
    ],
    notes:
      "Cron registry row (1.6.0): emitted on cron_changed added/updated/removed AND " +
      "once per job at gateway_start from getCron().list(). The LATEST per " +
      "openclaw.cron.job_id is the live cron list (name + schedule + next_run_at) — " +
      "lets a consumer list crons that haven't run in the query window. " +
      "openclaw.cron.removed=true is a tombstone (drop the job from the list). " +
      "session.key/conversation.id are set to 'cron:<job_id>' (a registry row has no " +
      "real session). ~0-duration, standalone root, ROLE_OTHER.",
  },
  {
    name: "openclaw.heartbeat.run",
    match: "exact",
    kind: "INTERNAL",
    readByConsumer: true,
    emittedByPlugin: true,
    requiredAttributes: [
      "openclaw.session.key",
      "gen_ai.conversation.id",
      "openclaw.heartbeat.status",
    ],
    contentAttributes: [],
    optionalReadAttributes: [
      "openclaw.heartbeat.reason",
      "openclaw.heartbeat.channel",
      "openclaw.heartbeat.duration_ms",
      "openclaw.heartbeat.silent",
      "openclaw.heartbeat.has_media",
      "openclaw.heartbeat.indicator",
      "openclaw.trigger",
    ],
    notes:
      "One per EMITTED heartbeat tick (1.6.0), from the onHeartbeatEvent bus — " +
      "CONFIG-GATED behind `heartbeat` (default off). A standalone INTERNAL marker " +
      "(ROLE_OTHER; never inflates model/tool/root counts). The bus payload carries " +
      "no jobId/sessionKey, so session.key/conversation.id are synthesized as " +
      "'heartbeat' ('heartbeat:<channel>' when a channel is present). " +
      "openclaw.heartbeat.status is the load-bearing read (sent|ok-empty|ok-token|" +
      "skipped|failed); ERROR span status on 'failed'. COVERAGE CAVEAT: " +
      "idle/disabled/quiet-hours/no-tasks-due skips early-return WITHOUT a bus event, " +
      "so this counts EMITTED ticks only (sent/failed + contended skips), NOT every " +
      "wake — do not treat its absence as 'heartbeat down'. The recipient/content " +
      "fields (to/accountId/preview) are DELIBERATELY never emitted (PII/content).",
  },
  {
    name: "openclaw.run",
    match: "exact",
    kind: "SERVER",
    readByConsumer: true,
    emittedByPlugin: false,
    requiredAttributes: [],
    contentAttributes: [],
    optionalReadAttributes: [],
    notes:
      "CONSUMER-DEMANDED built-in _ROOT_SPAN (ROLE_ROOT). NOT emitted by this " +
      "plugin. Coverage holds because the consumer maps openclaw.request to the SAME " +
      "ROLE_ROOT. The rewrite need NOT emit this name as long as openclaw.request " +
      "stays. readByConsumer=true means it WOULD be read if present.",
  },
  {
    name: "openclaw.model.usage",
    match: "exact",
    kind: "INTERNAL",
    readByConsumer: true,
    emittedByPlugin: false,
    requiredAttributes: [],
    contentAttributes: [],
    optionalReadAttributes: [
      // The SigNoz Cost page filters this exact span name and reads these
      // float64 token attrs plus a model-name pair (gen_ai.request.model,
      // openclaw.model). None are emitted by this plugin.
      "openclaw.tokens.input",
      "openclaw.tokens.output",
      "openclaw.tokens.cache_read",
      "openclaw.tokens.cache_write",
      "gen_ai.request.model",
      "openclaw.model",
    ],
    notes:
      "CONSUMER-DEMANDED built-in _USAGE_SPAN. signoz.list_usage_spans filters by " +
      "this EXACT name and reads openclaw.tokens.{input,output,cache_read," +
      "cache_write} as float64 for the Cost page. NOT emitted by this plugin BY " +
      "DESIGN — folding gen_ai cache tokens here would double-count. The plugin " +
      "substitute is gen_ai.usage.* on openclaw.agent.turn (token_usage_totals " +
      "handles it). RISK: a plugin-only trace yields nothing for the Cost-page " +
      "query keyed to this span name; confirm the Cost page has a plugin path or " +
      "it under-reports. The rewrite is NOT expected to emit this span.",
  },
] as const;

// ───────────────────────────────────────────────────────────────────────────
// Metrics
// ───────────────────────────────────────────────────────────────────────────

export const CONTRACT_METRICS: readonly ContractMetric[] = [
  {
    name: "gen_ai.client.token.usage",
    instrument: "Histogram",
    readByConsumer: false,
    keyedBy: ["gen_ai.token.type"],
    notes:
      "Standard GenAI token-usage histogram, recorded once per token type " +
      "(input/output/cache_read/cache_creation). Emitted but unread by the consumer. " +
      "Used by external Dynatrace/SigNoz dashboards — do not trim without " +
      "checking them.",
  },
  {
    name: "gen_ai.client.operation.duration",
    instrument: "Histogram",
    readByConsumer: false,
    keyedBy: [],
    notes:
      "Standard GenAI operation-duration histogram. Emitted but unread by " +
      "the consumer. Used by external dashboards — do not trim without checking them.",
  },
  {
    name: "openclaw.session.stalled",
    instrument: "Counter",
    readByConsumer: true,
    keyedBy: ["openclaw.session.key"],
    notes:
      "THE single load-bearing metric the rewrite cannot drop. Incremented on a " +
      "'session.stalled' diagnostic, grouped by openclaw.session.key (which the " +
      "consumer's stalled-metric groupBy requires). The consumer reads only this " +
      "metric from the entire emitted metric surface.",
  },
  {
    name: "openclaw.cron.runs",
    instrument: "Counter",
    readByConsumer: false,
    keyedBy: ["openclaw.cron.status", "openclaw.cron.job_id"],
    notes:
      "Opt-in (1.6.0) cron-firing counter, incremented once per cron_changed " +
      "'finished' alongside the openclaw.cron.run span (only when metrics enabled). " +
      "Convenience for cheap rate(...{openclaw.cron.status='error'}) alerting WITHOUT " +
      "a span->metric pipeline; the openclaw.cron.run span remains the source of " +
      "truth. Low cardinality (status x job_id). Downstream consumers read the " +
      "SPAN, not this counter.",
  },
  {
    name: "openclaw.heartbeat.runs",
    instrument: "Counter",
    readByConsumer: false,
    keyedBy: ["openclaw.heartbeat.status"],
    notes:
      "Opt-in (1.6.0) heartbeat-tick counter, incremented once per emitted bus tick " +
      "alongside the openclaw.heartbeat.run span (only when BOTH metrics and " +
      "heartbeat are enabled). Convenience for rate(...{openclaw.heartbeat.status=" +
      "'failed'}) alerting; the openclaw.heartbeat.run span remains the source of " +
      "truth. Same emitted-ticks-only coverage caveat as that span.",
  },
] as const;

// ───────────────────────────────────────────────────────────────────────────
// Resource attributes
// ───────────────────────────────────────────────────────────────────────────

/** Attributes carried on the emitted OTel Resource. `openclaw.schema.version`
 *  always equals {@link SCHEMA_VERSION}; the Resource also carries the pinned
 *  {@link OTEL_SEMCONV_SCHEMA_URL} as its schema URL. `openclaw.version`
 *  (1.7.0) is the HOST gateway version, BEST-EFFORT: resolved from the host's
 *  package.json at startup and OMITTED when resolution fails — consumers must
 *  treat it as optional. */
export const RESOURCE_ATTRIBUTES: readonly string[] = [
  "service.name",
  "service.version",
  "openclaw.plugin",
  "openclaw.schema.version",
  "openclaw.version",
] as const;

// ───────────────────────────────────────────────────────────────────────────
// Correlation keys
// ───────────────────────────────────────────────────────────────────────────

/**
 * The keys the consumer uses to stitch spans and metrics into a conversation.
 * `_conversation_id()` tries `gen_ai.conversation.id` then falls back to
 * `openclaw.session.key`; the stalled-metric groupBy uses `openclaw.session.key`.
 * BOTH must appear (in order) on every span and metric, and their STRING
 * FORMATS are load-bearing:
 *   - openclaw.session.key: 'agent:<id>:<channel>:...'
 *   - openclaw.message.from: '<channel>:...'
 * Changing either format breaks channel parsing and conversation correlation.
 * Note: threadId/resourceId are hardcoded '' for OpenClaw, so the canonical
 * record's sessionId is effectively empty — do not rely on it for correlation.
 */
export const CORRELATION_KEYS = [
  "gen_ai.conversation.id",
  "openclaw.session.key",
] as const;

// ───────────────────────────────────────────────────────────────────────────
// Aggregate contract object
// ───────────────────────────────────────────────────────────────────────────

/** The whole frozen contract as one machine-readable, typed value. This is the
 *  object a contract test asserts emitted telemetry against. */
export const CONTRACT = {
  schemaVersion: SCHEMA_VERSION,
  otelSemconvSchemaUrl: OTEL_SEMCONV_SCHEMA_URL,
  spans: CONTRACT_SPANS,
  metrics: CONTRACT_METRICS,
  resourceAttributes: RESOURCE_ATTRIBUTES,
  correlationKeys: CORRELATION_KEYS,
} as const;

export type Contract = typeof CONTRACT;

// ───────────────────────────────────────────────────────────────────────────
// Convenience accessors (no logic, just typed lookups for tests/docs)
// ───────────────────────────────────────────────────────────────────────────

/** All span entries this plugin is expected to actually emit. */
export const EMITTED_SPANS: readonly ContractSpan[] = CONTRACT_SPANS.filter(
  (s) => s.emittedByPlugin,
);

/** Consumer-demanded built-in spans this plugin does NOT emit (covered by an
 *  emitted equivalent or accepted as a documented gap). */
export const CONSUMER_ONLY_SPANS: readonly ContractSpan[] = CONTRACT_SPANS.filter(
  (s) => !s.emittedByPlugin,
);

/** Look up a span contract by an emitted span's name, honoring exact vs prefix
 *  matching. A prefix entry also matches its bare trimmed name (e.g. the
 *  modelless `chat` span, 1.8.0) — mirroring the consumer's classifier, which
 *  accepts `op.startsWith("chat ") || op === "chat"`. Returns the matching
 *  {@link ContractSpan} or `undefined`. */
export function findSpanContract(spanName: string): ContractSpan | undefined {
  return CONTRACT_SPANS.find((s) =>
    s.match === "exact"
      ? spanName === s.name
      : spanName.startsWith(s.name) || spanName === s.name.trimEnd(),
  );
}
