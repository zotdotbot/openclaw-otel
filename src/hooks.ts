// SPDX-License-Identifier: Apache-2.0

/**
 * OpenClaw hook → OTel span pipeline.
 *
 * Maps the OpenClaw gateway's lifecycle hooks onto the frozen contract's five
 * emitted spans, stitched into one connected trace per turn:
 *
 *   openclaw.request (SERVER)
 *     └─ openclaw.agent.turn (INTERNAL)   ← gen_ai.usage.* rollup
 *        ├─ chat <model> (CLIENT)
 *        └─ execute_tool <tool> (INTERNAL)
 *   openclaw.message.sent (INTERNAL)      ← joins the request trace
 *
 * Parent context is threaded EXPLICITLY through the TraceContextStore (we never
 * register a global OTel context manager — see telemetry.ts), using
 * trace.setSpan over ROOT_CONTEXT. Requests/turns are keyed by session key,
 * matching OpenClaw's per-session serialization; tool spans by tool-call id.
 *
 * Scope: this is the contract surface only. OpenClaw's diagnostic stream also
 * surfaces session/dispatch/llm.call/subagent/cron/webhook/finalize events that the
 * consumer does not read — intentionally omitted to keep the build lean. Token
 * usage here comes from the agent_end event payload; the diagnostic-event
 * held-open rollup is layered on in diagnostics.ts.
 */

import {
  trace,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  type Span,
  type Context,
  type Attributes,
  type Histogram,
} from "@opentelemetry/api";

import type { ContentCapturePolicy } from "./config";
import { TraceContextStore } from "./trace-context-store";
import type { UsageCoordinator } from "./diagnostics";
import type { CronRegistry } from "./cron";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_RESPONSE_ID,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_TOOL_NAME,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  OP_CHAT,
  OP_EXECUTE_TOOL,
  OP_INVOKE_AGENT,
  OPENCLAW_SESSION_KEY,
  OPENCLAW_MESSAGE_CHANNEL,
  OPENCLAW_MESSAGE_DIRECTION,
  OPENCLAW_MESSAGE_FROM,
  OPENCLAW_MESSAGE_TO,
  OPENCLAW_MESSAGE_CHARS,
  OPENCLAW_TRIGGER,
  OPENCLAW_CRON_JOB_ID,
  OPENCLAW_CRON_JOB_NAME,
  OPENCLAW_CRON_RUN_ID,
  OPENCLAW_CRON_SCHEDULE_KIND,
  OPENCLAW_CRON_SCHEDULE_EXPR,
  OPENCLAW_CRON_SCHEDULE_EVERY_MS,
  OPENCLAW_CRON_SCHEDULE_TZ,
  OPENCLAW_AGENT_SUCCESS,
  OPENCLAW_TOOL_NAME,
  OPENCLAW_TOOL_IS_SYNTHETIC,
  OPENCLAW_TOOL_RESULT_CHARS,
  OPENCLAW_TOOL_INPUT_PREVIEW,
  OPENCLAW_TOOL_ERROR,
  OPENCLAW_MODEL_CALL_TTFB_MS,
  OPENCLAW_MODEL_CALL_REQUEST_BYTES,
  OPENCLAW_MODEL_CALL_RESPONSE_BYTES,
  OPENCLAW_EXEC_EXIT_CODE,
  OPENCLAW_EXEC_TIMED_OUT,
  OPENCLAW_CONTENT_INPUT_MESSAGE,
  OPENCLAW_CONTENT_OUTPUT_MESSAGE,
  OPENCLAW_CONTENT_PROMPT,
  OPENCLAW_CONTENT_MESSAGES,
  OPENCLAW_CONTENT_SYSTEM_PROMPT,
  OPENCLAW_CONTENT_TOOL_INPUT,
  OPENCLAW_CONTENT_TOOL_OUTPUT,
  TOOL_INPUT_CAPTURE_OFF,
  SPAN_OPENCLAW_REQUEST,
  SPAN_OPENCLAW_AGENT_TURN,
  SPAN_OPENCLAW_MESSAGE_SENT,
  spanNameChat,
  spanNameExecuteTool,
} from "./semconv";

/** OpenClaw passes plain event objects; field names vary, so we read loosely. */
type AnyEvent = Record<string, any>;

export interface HooksDeps {
  tracer: Tracer;
  store: TraceContextStore;
  capture: ContentCapturePolicy;
  /** When present, agent_end hands the turn span here to be held open for the
   *  model.usage diagnostic; absent ⇒ the turn ends immediately with the
   *  event-payload usage. */
  usage?: UsageCoordinator;
  /** Optional `gen_ai.client.operation.duration` histogram (external dashboards),
   *  recorded per model call. */
  operationDuration?: Histogram;
  /** Optional override for "now" (ms) — injected by tests for determinism. */
  now?: () => number;
  /** Shared cron registry (written by the cron hooks) — lets the turn hooks stamp
   *  cron name/schedule onto a cron-triggered turn (the turn event carries only
   *  the jobId). Absent ⇒ cron turns still get job_id, just no name/schedule. */
  cronRegistry?: CronRegistry;
}

/** Max UTF-16 code units of captured content per attribute. */
export const CONTENT_MAX_CHARS = 8192;
/** Max preview length for tool input. */
const INPUT_PREVIEW_MAX = 1000;
/** How long a completed request root is retained so a late message.sent can
 *  still join its trace (mirrors the contract's 10-minute window). */
const COMPLETED_ROOT_TTL_MS = 600_000;
/** Background sweep cadence + thresholds for leaked store entries. */
const SWEEP_INTERVAL_MS = 60_000;
/** Evict a request/turn only after this long with NO activity (model-call or
 *  tool event refreshes liveness via store.touchActivity). Set well above the
 *  realistic max turn duration so a long-running turn — e.g. a single extended
 *  generation with no intervening events — isn't force-ended mid-flight (which
 *  would orphan its child spans and skip the end-of-turn token rollup). This is
 *  a leak backstop, not a turn-duration cap. */
const STALE_ENTRY_MS = 1_800_000;
const IDLE_SESSION_MS = 1_800_000;

// ── small helpers ───────────────────────────────────────────────────────────

const firstString = (...vals: unknown[]): string | undefined => {
  for (const v of vals) if (typeof v === "string" && v.length > 0) return v;
  return undefined;
};

const num = (...vals: unknown[]): number | undefined => {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
};

const truncate = (s: string, max = CONTENT_MAX_CHARS): string =>
  s.length <= max ? s : s.slice(0, max);

/** Room reserved inside `max` for the tail-truncation marker so the result stays
 *  bounded by `max` (the marker for realistic sizes is < 48 chars). */
const TRUNCATE_MARKER_BUDGET = 48;

/**
 * Tail-biased truncation: keep the LAST `max` chars behind a marker recording how
 * many earlier chars were dropped. Used for FAILED tool output (issue #13) —
 * error text (stderr, a nonzero-exit line, an HTTP status) sits at the END of a
 * tool result far more often than the start, so a head slice would cut exactly
 * the line that names the failure class. Stays bounded by `max`, like {@link truncate}.
 */
const truncateTail = (s: string, max = CONTENT_MAX_CHARS): string => {
  if (s.length <= max) return s;
  const keep = max - TRUNCATE_MARKER_BUDGET;
  const omitted = s.length - keep;
  return `…[${omitted} earlier chars truncated]\n${s.slice(-keep)}`;
};

/** True when a tool result signals failure — mirrors the error branch in
 *  finishToolSpan so the output excerpt and the error status agree. */
const isErrorResult = (message: AnyEvent | undefined, event: AnyEvent): boolean =>
  !!(message?.is_error || message?.isError || firstString(event.error));

/** Bounded tool-result excerpt: tail-biased on failure (keep the trailing error),
 *  head-biased on success (read-tool output reads from the top). */
const toolOutputExcerpt = (outText: string, isError: boolean): string =>
  isError ? truncateTail(outText) : truncate(outText);

/** Build an Attributes object dropping undefined values (OTel dislikes them). */
function attrs(obj: Record<string, string | number | boolean | string[] | undefined>): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/** Stringify a tool-input value (object → JSON, primitive → String). */
function stringifyInput(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Max length of the sanitized tool-error message (issue #7: bounded, no body). */
const TOOL_ERROR_MAX = 200;

/** Collapse whitespace to single spaces and hard-cap length — a short, single-
 *  line error summary safe to export (never the full, potentially sensitive
 *  tool output). */
function sanitizeError(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, TOOL_ERROR_MAX);
}

/**
 * The real, short error for an errored tool call.
 *
 * Prefers OpenClaw's already-extracted `event.error` (a bounded summary from
 * `extractToolErrorMessage`), which is safe to surface. Falls back to the tool
 * result's own text ONLY when output capture is enabled — otherwise that text is
 * the raw tool output (potential PII/secrets) whose capture the operator has
 * deliberately left off, and even a 200-char slice of it would be a leak through
 * the span status message (which the consumer renders). With capture off and no
 * pre-extracted error, emit a non-leaking marker carrying only the size.
 *
 * Surfaces the raw (sanitized) reason rather than parsing a code out of it:
 * OpenClaw 2026.5.28 exposes NO structured error fields (only this string + an
 * is_error boolean), so any `openclaw.errorCode` would be a guess — and the real
 * reason, with whatever code it already contains, rides the status message.
 */
function toolErrorDetail(
  event: AnyEvent,
  allowBodyText: boolean,
  outText: string | undefined,
): string {
  const direct = firstString(event.error);
  if (direct) return sanitizeError(direct);
  if (allowBodyText && outText) return sanitizeError(outText);
  // Capture off (or no text): never slice the body into the error.
  return outText !== undefined
    ? `tool_execution_error (${outText.length} chars, capture off)`
    : "tool_execution_error";
}

function extractToolOutputText(message: unknown): string | undefined {
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    const m = message as AnyEvent;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const parts = m.content
        .map((p: AnyEvent) => (typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean);
      if (parts.length) return parts.join("");
    }
    if (typeof m.text === "string") return m.text;
  }
  return undefined;
}

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
  model?: string;
}

function extractUsage(event: AnyEvent): Usage {
  let u: AnyEvent | undefined = event?.usage;
  if (!u && Array.isArray(event?.messages)) {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const msg = event.messages[i];
      if (msg?.role === "assistant" && msg?.usage) {
        u = msg.usage;
        break;
      }
    }
  }
  if (!u) return {};
  return {
    input: num(u.input_tokens, u.inputTokens, u.input),
    output: num(u.output_tokens, u.outputTokens, u.output),
    cacheRead: num(u.cache_read_input_tokens, u.cacheReadInputTokens, u.cacheRead),
    cacheCreation: num(
      u.cache_creation_input_tokens,
      u.cacheCreationInputTokens,
      u.cacheCreation,
    ),
    model: firstString(u.model),
  };
}

// ── registration ────────────────────────────────────────────────────────────

/**
 * Register all contract hooks on the OpenClaw plugin `api`. Returns a cleanup
 * function that clears the background sweep timer (call it from service.stop).
 */
export function registerHooks(api: any, deps: HooksDeps): () => void {
  const { tracer, store, capture } = deps;
  const now = deps.now ?? Date.now;

  // Sessions whose outbound span was already emitted at `message_sending` (the
  // hook that reliably fires and carries the reply text + session key). The
  // value is the last emit time; it lets a later `message_sent` — which does NOT
  // fire on the 2026.5.28 Slack delivery path, but does on other versions —
  // dedup so the span is never emitted twice. Bounded by the background sweep.
  const emittedOutbound = new Map<string, number>();
  // How long a message_sending emit suppresses a follow-up message_sent for the
  // same session (delivery status normally lands within ~1s).
  const OUTBOUND_DEDUP_MS = 30_000;
  // Completed request roots are retained in the shared store (store.retainCompletedRoot
  // / getCompletedRoot), so BOTH the outbound message.sent AND re-homed end-of-turn
  // diagnostic spans (harness.run / message.delivery) join the finished turn's trace.

  const sessionKeyOf = (event: AnyEvent, ctx?: AnyEvent): string | undefined =>
    firstString(event?.sessionKey, ctx?.sessionKey, event?.session?.key);

  const parseChannelFromSessionKey = (key: string): string | undefined => {
    // Session key format 'agent:<id>:<channel>:...' — channel is segment 3.
    const parts = key.split(":");
    return parts.length >= 3 && parts[2] ? parts[2] : undefined;
  };
  // openclaw.message.channel is a REQUIRED contract attribute on openclaw.request;
  // never leave it undefined. Prefer the event/ctx channel, then the session's
  // stored channel, then the channel parsed from the session key, then "unknown".
  const channelOf = (key: string, event: AnyEvent, ctx?: AnyEvent): string =>
    firstString(
      event?.channel,
      ctx?.channel,
      store.getSession(key)?.channel,
      parseChannelFromSessionKey(key),
    ) ?? "unknown";

  const on = (event: string, handler: (e: AnyEvent, ctx?: AnyEvent) => void, priority: number) => {
    const wrapped = (e: AnyEvent, ctx?: AnyEvent) => {
      try {
        handler(e ?? {}, ctx);
      } catch {
        // A telemetry hook must never break the gateway turn it observes.
      }
    };
    if (typeof api.on === "function") api.on(event, wrapped, { priority });
  };

  // ── request root ──
  on("message_received", (event, ctx) => {
    const key = sessionKeyOf(event, ctx);
    if (!key) return;
    // A new inbound message invalidates any retained completed root AND the
    // outbound-emit marker for this session — a late reply must not join the
    // PREVIOUS turn's trace.
    store.deleteCompletedRoot(key);
    emittedOutbound.delete(key);
    const text = firstString(event.content, event.text, event.message);
    const rootSpan = tracer.startSpan(
      SPAN_OPENCLAW_REQUEST,
      {
        kind: SpanKind.SERVER,
        attributes: attrs({
          [OPENCLAW_SESSION_KEY]: key,
          [GEN_AI_CONVERSATION_ID]: key,
          [OPENCLAW_MESSAGE_CHANNEL]: channelOf(key, event, ctx),
          [OPENCLAW_MESSAGE_DIRECTION]: "inbound",
          [OPENCLAW_MESSAGE_FROM]: firstString(event.from, event.senderId),
          [OPENCLAW_TRIGGER]: firstString(event.trigger, ctx?.trigger),
        }),
      },
      ROOT_CONTEXT,
    );
    if (capture.inputMessages && text) {
      rootSpan.setAttribute(OPENCLAW_CONTENT_INPUT_MESSAGE, truncate(text));
    }
    const rootContext = trace.setSpan(ROOT_CONTEXT, rootSpan);
    store.setRequest(key, { rootSpan, rootContext, startedAt: now() });
    store.touchSession(key, now());
  }, 100);

  // ── session tier (context only; no contract span) ──
  on("session_start", (event, ctx) => {
    const key = sessionKeyOf(event, ctx);
    if (!key) return;
    store.setSession(key, {
      startedAt: now(),
      requestCount: 0,
      channel: firstString(event.channel, ctx?.channel),
      lastActivityAt: now(),
    });
  }, 110);

  on("session_end", (event, ctx) => {
    const key = sessionKeyOf(event, ctx);
    if (key) store.deleteSession(key);
  }, -110);

  // ── agent turn start ──
  on("before_model_resolve", (event, ctx) => {
    const key = sessionKeyOf(event, ctx);
    if (!key) return;
    let req = store.getRequest(key);
    if (!req) {
      // Synthetic root for triggers that skip message_received (cron/heartbeat).
      const rootSpan = tracer.startSpan(
        SPAN_OPENCLAW_REQUEST,
        {
          kind: SpanKind.SERVER,
          attributes: attrs({
            [OPENCLAW_SESSION_KEY]: key,
            [GEN_AI_CONVERSATION_ID]: key,
            [OPENCLAW_MESSAGE_CHANNEL]: channelOf(key, event, ctx),
            [OPENCLAW_MESSAGE_DIRECTION]: "inbound",
            [OPENCLAW_TRIGGER]: firstString(event.trigger, ctx?.trigger) ?? "synthetic",
          }),
        },
        ROOT_CONTEXT,
      );
      const rootContext = trace.setSpan(ROOT_CONTEXT, rootSpan);
      req = { rootSpan, rootContext, startedAt: now() };
      store.setRequest(key, req);
    }
    // A turn span already in flight for this key means the previous turn never
    // reached agent_end (re-resolve / retry). End it (and any in-flight model
    // call) before overwriting the slot, so it EXPORTS instead of being stranded
    // until the stale sweep.
    const stranded = store.getAgentTurn(key);
    if (stranded) {
      try {
        stranded.modelCallSpan?.end();
        stranded.span.end();
      } catch {
        // already ended / provider gone — nothing to do
      }
    }
    const turnSpan = tracer.startSpan(
      SPAN_OPENCLAW_AGENT_TURN,
      {
        kind: SpanKind.INTERNAL,
        attributes: attrs({
          [OPENCLAW_SESSION_KEY]: key,
          [GEN_AI_CONVERSATION_ID]: key,
          [GEN_AI_OPERATION_NAME]: OP_INVOKE_AGENT,
        }),
      },
      req.rootContext,
    );
    const turnContext = trace.setSpan(req.rootContext, turnSpan);
    store.setAgentTurn(key, { span: turnSpan, context: turnContext, startedAt: now() });
    store.touchSession(key, now());
    // Cron enrichment (1.6.0): a cron-triggered turn carries the jobId on its
    // context/session key but not the job's name/schedule — stamp first-class
    // cron attributes onto the turn + request so a consumer groups by job_id and
    // reads name/schedule without parsing the session key. Name/schedule come
    // from the shared cron registry (seeded by the cron hooks).
    const trigger = firstString(event.trigger, ctx?.trigger);
    if (trigger === "cron" || key.includes(":cron:")) {
      const cm = /:cron:([^:]+)(?::run:(.+))?/.exec(key);
      const jobId = firstString(ctx?.jobId, event.jobId, cm?.[1]);
      if (jobId) {
        const meta = deps.cronRegistry?.get(jobId);
        const cronAttrs = attrs({
          [OPENCLAW_CRON_JOB_ID]: jobId,
          [OPENCLAW_CRON_RUN_ID]: firstString(ctx?.runId, event.runId, cm?.[2]),
          [OPENCLAW_CRON_JOB_NAME]: meta?.name,
          [OPENCLAW_CRON_SCHEDULE_KIND]: meta?.scheduleKind,
          [OPENCLAW_CRON_SCHEDULE_EXPR]: meta?.scheduleExpr,
          [OPENCLAW_CRON_SCHEDULE_EVERY_MS]: meta?.scheduleEveryMs,
          [OPENCLAW_CRON_SCHEDULE_TZ]: meta?.scheduleTz,
        });
        turnSpan.setAttributes(cronAttrs);
        req.rootSpan.setAttributes(cronAttrs);
      }
    }
  }, 90);

  // ── agent turn enrichment (content) ──
  on("before_prompt_build", (event, ctx) => {
    const key = sessionKeyOf(event, ctx);
    if (!key) return;
    const turn = store.getAgentTurn(key);
    if (!turn) return;
    if (capture.inputMessages) {
      const prompt = firstString(event.prompt);
      if (prompt) turn.span.setAttribute(OPENCLAW_CONTENT_PROMPT, truncate(prompt));
      if (Array.isArray(event.messages)) {
        turn.span.setAttribute(
          OPENCLAW_CONTENT_MESSAGES,
          truncate(stringifyInput(event.messages) ?? ""),
        );
      }
    }
    if (capture.systemPrompt) {
      const sys = firstString(event.systemPrompt, event.system);
      if (sys) turn.span.setAttribute(OPENCLAW_CONTENT_SYSTEM_PROMPT, truncate(sys));
    }
  }, 80);

  // ── model call ──
  on("model_call_started", (event, ctx) => {
    const key = sessionKeyOf(event, ctx);
    if (!key) return;
    store.touchActivity(key, now()); // turn is doing work — keep it off the stale sweep
    const turn = store.getAgentTurn(key);
    const parent = turn?.context ?? store.resolveContext(key) ?? ROOT_CONTEXT;
    // No placeholder fallback: when the host event carries no model/provider
    // (OpenRouter/DeepSeek on 2026.5.28), the attrs are OMITTED and the span
    // name falls back to bare "chat". A literal "unknown" masks the real model
    // for every consumer downstream (issue #5).
    const model = firstString(event.model, event.requestModel);
    const chatSpan = tracer.startSpan(
      spanNameChat(model),
      {
        kind: SpanKind.CLIENT,
        attributes: attrs({
          [GEN_AI_OPERATION_NAME]: OP_CHAT,
          [GEN_AI_PROVIDER_NAME]: firstString(event.provider),
          [GEN_AI_REQUEST_MODEL]: model,
          [GEN_AI_CONVERSATION_ID]: key,
        }),
      },
      parent,
    );
    if (turn) {
      // A turn may make MULTIPLE model calls (tool-use loop). End any prior
      // in-flight model-call span before the single-slot overwrite so it isn't
      // orphaned.
      if (turn.modelCallSpan) turn.modelCallSpan.end();
      turn.modelCallSpan = chatSpan;
      turn.modelCallStartTime = now();
    } else {
      // No turn to hang it on — end immediately so it isn't leaked.
      chatSpan.end();
    }
  }, 75);

  on("model_call_ended", (event, ctx) => {
    const key = sessionKeyOf(event, ctx);
    if (!key) return;
    const turn = store.getAgentTurn(key);
    const chatSpan = turn?.modelCallSpan;
    if (!chatSpan) return;
    const usage = extractUsage(event);
    const responseModel = firstString(event.responseModel, event.model);
    chatSpan.setAttributes(
      attrs({
        [GEN_AI_RESPONSE_MODEL]: responseModel,
        [GEN_AI_RESPONSE_ID]: firstString(event.responseId, event.id),
        [GEN_AI_USAGE_INPUT_TOKENS]: usage.input,
        [GEN_AI_USAGE_OUTPUT_TOKENS]: usage.output,
        [GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: usage.cacheRead,
        [GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: usage.cacheCreation,
      }),
    );
    if (Array.isArray(event.finishReasons)) {
      chatSpan.setAttribute(GEN_AI_RESPONSE_FINISH_REASONS, event.finishReasons.map(String));
    }
    // Per-call latency/size detail rides ON the chat span (the model_call_ended
    // event carries it directly), so the consumer reads it from the connected
    // convention without a separate model.call span that would double the count.
    const ttfb = num(event.timeToFirstByteMs);
    if (ttfb !== undefined) chatSpan.setAttribute(OPENCLAW_MODEL_CALL_TTFB_MS, ttfb);
    const reqBytes = num(event.requestPayloadBytes);
    if (reqBytes !== undefined) chatSpan.setAttribute(OPENCLAW_MODEL_CALL_REQUEST_BYTES, reqBytes);
    const respBytes = num(event.responseStreamBytes);
    if (respBytes !== undefined) chatSpan.setAttribute(OPENCLAW_MODEL_CALL_RESPONSE_BYTES, respBytes);
    if (event.error) {
      chatSpan.setStatus({ code: SpanStatusCode.ERROR, message: sanitizeError(String(event.error)) });
    }
    chatSpan.end();
    if (turn) {
      if (deps.operationDuration && turn.modelCallStartTime) {
        deps.operationDuration.record(
          (now() - turn.modelCallStartTime) / 1000,
          attrs({
            [GEN_AI_RESPONSE_MODEL]: responseModel,
            [GEN_AI_PROVIDER_NAME]: firstString(event.provider),
          }),
        );
      }
      turn.modelCallSpan = undefined;
    }
  }, -75);

  // ── tool execution ──
  // Stable per-session fallback when no real tool-call id is present: derive it
  // from session + tool name (NOT now(), which would differ between
  // before_tool_call and after_tool_call and break span pairing/dedup).
  const toolCallKey = (key: string, event: AnyEvent): string =>
    firstString(event.toolCallId, event.callId) ??
    `${key}:${firstString(event.toolName) ?? "tool"}`;

  const startToolSpan = (
    key: string,
    callId: string,
    event: AnyEvent,
    synthetic: boolean,
  ): Span => {
    const turn = store.getAgentTurn(key);
    const parent = turn?.context ?? store.resolveContext(key) ?? ROOT_CONTEXT;
    const toolName = firstString(event.toolName) ?? "unknown";
    const span = tracer.startSpan(
      spanNameExecuteTool(toolName),
      {
        kind: SpanKind.INTERNAL,
        attributes: attrs({
          [GEN_AI_OPERATION_NAME]: OP_EXECUTE_TOOL,
          [GEN_AI_TOOL_NAME]: toolName,
          [GEN_AI_TOOL_CALL_ID]: callId,
          [GEN_AI_CONVERSATION_ID]: key,
          [OPENCLAW_TOOL_NAME]: toolName,
          [OPENCLAW_TOOL_IS_SYNTHETIC]: synthetic ? true : undefined,
        }),
      },
      parent,
    );
    // Tool input: real value when captured, else the '{}' capture-off sentinel
    // (the consumer treats '{}' as "capture off", so it must be present).
    const inputStr = stringifyInput(
      event.params ?? event.input ?? event.toolInput ?? event.args,
    );
    if (capture.toolInputs && inputStr !== undefined) {
      span.setAttribute(OPENCLAW_CONTENT_TOOL_INPUT, truncate(inputStr));
      span.setAttribute(OPENCLAW_TOOL_INPUT_PREVIEW, truncate(inputStr, INPUT_PREVIEW_MAX));
    } else {
      span.setAttribute(OPENCLAW_CONTENT_TOOL_INPUT, TOOL_INPUT_CAPTURE_OFF);
    }
    return span;
  };

  const finishToolSpan = (span: Span, startTime: number, event: AnyEvent) => {
    span.setAttribute("openclaw.tool.duration_ms", now() - startTime);
    const message = event.message ?? event.result;
    const outText = extractToolOutputText(message);
    const errored = isErrorResult(message, event);
    if (outText !== undefined) {
      span.setAttribute(OPENCLAW_TOOL_RESULT_CHARS, outText.length);
      if (capture.toolOutputs) {
        span.setAttribute(OPENCLAW_CONTENT_TOOL_OUTPUT, toolOutputExcerpt(outText, errored));
      }
    }
    if (errored) {
      // Issue #7: surface the REAL error instead of a constant. The consumer
      // reads the span status message, so a bare "Error" is replaced by the
      // actual reason; the same sanitized text is mirrored on openclaw.tool.error.
      const detail = toolErrorDetail(event, capture.toolOutputs, outText);
      span.setAttribute(OPENCLAW_TOOL_ERROR, detail);
      span.setStatus({ code: SpanStatusCode.ERROR, message: detail });
    }
    // Shell exec detail (exit code / timeout) when the tool result carries it —
    // rides on the execute_tool span (no separate openclaw.exec span, which would
    // double the tool count). Defensive: only set when present.
    const details = (message as AnyEvent | undefined)?.details as AnyEvent | undefined;
    const exitCode = num(details?.exitCode, details?.exit_code, details?.code);
    if (exitCode !== undefined) span.setAttribute(OPENCLAW_EXEC_EXIT_CODE, exitCode);
    const timedOut = details?.timedOut ?? details?.timed_out;
    if (typeof timedOut === "boolean") span.setAttribute(OPENCLAW_EXEC_TIMED_OUT, timedOut);
    span.end();
  };

  on("before_tool_call", (event, ctx) => {
    const key = sessionKeyOf(event, ctx);
    if (!key) return;
    store.touchActivity(key, now()); // tool starting — keep the turn off the stale sweep
    const callId = toolCallKey(key, event);
    const span = startToolSpan(key, callId, event, false);
    store.setToolSpan(callId, { span, startTime: now(), lastActivityAt: now() });
  }, 70);

  on("after_tool_call", (event, ctx) => {
    const key = sessionKeyOf(event, ctx);
    if (!key) return;
    const callId = toolCallKey(key, event);
    const active = store.getToolSpan(callId);
    if (!active) return;
    finishToolSpan(active.span, active.startTime, event);
    store.deleteToolSpan(callId);
  }, -70);

  on("tool_result_persist", (event, ctx) => {
    const key = sessionKeyOf(event, ctx);
    if (!key) return;
    store.touchActivity(key, now()); // tool produced a result — turn is still live
    const callId = toolCallKey(key, event);
    const active = store.getToolSpan(callId);
    if (active) {
      // Real span already in flight — enrich output only; after_tool_call ends it.
      active.lastActivityAt = now();
      const outText = extractToolOutputText(event.message);
      if (capture.toolOutputs && outText !== undefined) {
        const errored = isErrorResult(event.message as AnyEvent | undefined, event);
        active.span.setAttribute(OPENCLAW_CONTENT_TOOL_OUTPUT, toolOutputExcerpt(outText, errored));
      }
      return;
    }
    // No timed span fired — emit a synthetic echo (deduped downstream via
    // openclaw.tool.is_synthetic + the shared gen_ai.tool.call.id).
    const span = startToolSpan(key, callId, event, true);
    finishToolSpan(span, now(), event);
  }, -100);

  // ── outbound reply ──
  // The reply text, routing, AND session key ride `message_sending` (the
  // "rewrite outbound content" hook), which fires reliably for every outbound
  // message. On OpenClaw 2026.5.28 the `message_sent` delivery-status hook is
  // NOT dispatched on the Slack path (verified live: message_sending fires,
  // message_sent never does), so the span is emitted HERE. `message_sent` stays
  // as a dedup-guarded fallback for gateway versions/paths where IT is the
  // outbound signal instead.
  const resolveOutboundParent = (key: string | undefined): Context =>
    (key ? store.getRequest(key)?.rootContext : undefined) ??
    (key ? store.getCompletedRoot(key) : undefined) ??
    (key ? store.resolveContext(key) : undefined) ??
    ROOT_CONTEXT;

  const channelForOutbound = (key: string | undefined, event: AnyEvent, ctx?: AnyEvent): string | undefined =>
    firstString(event.channel, ctx?.channel, ctx?.channelId, key ? parseChannelFromSessionKey(key) : undefined);

  const emitOutboundSpan = (
    key: string | undefined,
    channel: string | undefined,
    to: string | undefined,
    text: string | undefined,
    success: boolean | undefined,
    errorMsg: string | undefined,
  ) => {
    const corrKey = key ?? "unknown";
    const sentSpan = tracer.startSpan(
      SPAN_OPENCLAW_MESSAGE_SENT,
      {
        kind: SpanKind.INTERNAL,
        attributes: attrs({
          [OPENCLAW_SESSION_KEY]: corrKey,
          [GEN_AI_CONVERSATION_ID]: corrKey,
          [OPENCLAW_MESSAGE_DIRECTION]: "outbound",
          [OPENCLAW_MESSAGE_CHARS]: text ? text.length : 0,
          [OPENCLAW_MESSAGE_CHANNEL]: channel,
          [OPENCLAW_MESSAGE_TO]: to,
        }),
      },
      resolveOutboundParent(key),
    );
    if (capture.outputMessages && text) {
      sentSpan.setAttribute(OPENCLAW_CONTENT_OUTPUT_MESSAGE, truncate(text));
    }
    if (success === false) {
      sentSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMsg ? sanitizeError(errorMsg) : "delivery_failed",
      });
    }
    sentSpan.end();
  };

  on("message_sending", (event, ctx) => {
    const key = sessionKeyOf(event, ctx);
    const text = firstString(event.content, event.text, event.message);
    const to = firstString(event.to, event.recipientId);
    // Emit optimistically (pre-delivery): message_sending is the reliable signal
    // and carries the reply content + session key. Delivery FAILURES, when they
    // occur, surface separately via the built-in message.delivery.error path.
    emitOutboundSpan(key, channelForOutbound(key, event, ctx), to, text, undefined, undefined);
    if (key) emittedOutbound.set(key, now());
  }, -90);

  on("message_sent", (event, ctx) => {
    const key = sessionKeyOf(event, ctx);
    // When message_sending already emitted the span for this session (the common
    // path), this delivery-status event is a no-op — the span is ended, so its
    // status cannot be back-filled. Only emit when message_sending did NOT fire
    // (gateway versions where message_sent is the sole outbound signal).
    const recent = key ? emittedOutbound.get(key) : undefined;
    if (key) emittedOutbound.delete(key);
    if (recent !== undefined && now() - recent < OUTBOUND_DEDUP_MS) return;
    const text = firstString(event.content, event.text, event.message);
    const to = firstString(event.to, event.recipientId);
    emitOutboundSpan(key, channelForOutbound(key, event, ctx), to, text, event.success, firstString(event.error));
  }, -90);

  // ── turn + root close ──
  on("agent_end", (event, ctx) => {
    const key = sessionKeyOf(event, ctx);
    if (!key) return;
    const turn = store.getAgentTurn(key);
    const req = store.getRequest(key);
    const usage = extractUsage(event);
    if (turn) {
      // Close any orphaned model-call span first.
      if (turn.modelCallSpan) {
        turn.modelCallSpan.end();
        turn.modelCallSpan = undefined;
      }
      turn.span.setAttributes(
        attrs({
          [OPENCLAW_SESSION_KEY]: key,
          [GEN_AI_CONVERSATION_ID]: key,
          [GEN_AI_USAGE_INPUT_TOKENS]: usage.input ?? 0,
          [GEN_AI_USAGE_OUTPUT_TOKENS]: usage.output ?? 0,
          // Omitted (never "unknown") when the event carries no model; the
          // model.usage diagnostic back-fills the real name on the held-open
          // span via enrichSpanWithUsage when it lands (issue #5).
          [GEN_AI_RESPONSE_MODEL]: firstString(event.responseModel, event.model, usage.model),
          [OPENCLAW_AGENT_SUCCESS]: event.success !== false,
          [GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: usage.cacheRead && usage.cacheRead > 0 ? usage.cacheRead : undefined,
          [GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]:
            usage.cacheCreation && usage.cacheCreation > 0 ? usage.cacheCreation : undefined,
        }),
      );
      if (event.error) {
        turn.span.setStatus({ code: SpanStatusCode.ERROR, message: sanitizeError(String(event.error)) });
      }
      store.deleteAgentTurn(key);
      // Hand the turn to the usage coordinator (held open for the model.usage
      // diagnostic) when diagnostics are wired; otherwise end it now with the
      // event-payload usage already set above.
      const endTime = now();
      if (deps.usage) deps.usage.handleTurnEnd(key, turn.span, endTime);
      else turn.span.end();
    }
    if (req) {
      req.rootSpan.end();
      // Retain the root context briefly (in the shared store) so a late
      // message.sent AND re-homed end-of-turn diagnostic spans still join.
      store.retainCompletedRoot(key, req.rootContext, now());
      store.deleteRequest(key);
    }
  }, -100);

  // ── background sweep (bounds the store + the emit-dedup map) ──
  // Completed roots are swept by store.sweepStale; only the local
  // emittedOutbound dedup map needs cleaning here.
  const sweep = () => {
    const t = now();
    store.sweepStale(STALE_ENTRY_MS, t);
    store.sweepIdleSessions(IDLE_SESSION_MS, t);
    for (const [k, ts] of emittedOutbound) {
      if (t - ts > COMPLETED_ROOT_TTL_MS) emittedOutbound.delete(k);
    }
  };
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();

  return () => {
    clearInterval(timer);
    emittedOutbound.clear();
    // End any in-flight spans still in the store (and clear retained roots) so
    // partial traces export (truncated, errored) instead of leaking on teardown.
    store.endAndClear();
  };
}
