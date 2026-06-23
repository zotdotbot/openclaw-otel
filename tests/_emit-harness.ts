// SPDX-License-Identifier: Apache-2.0
//
// Shared emit harness: drives a simulated OpenClaw turn through the real hook
// pipeline + a real OTel SDK (InMemorySpanExporter) so a test can assert the
// actual emitted spans. Used by the emit oracle (emit.test.ts) and the
// consumer-parity verification (consumer-parity.test.ts).

import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";

import { registerHooks } from "../src/hooks";
import { TraceContextStore } from "../src/trace-context-store";
import { CONTENT_POLICY_DISABLED, type ContentCapturePolicy } from "../src/config";
import { UsageCoordinator, makeDiagnosticListener } from "../src/diagnostics";

/** A no-op Counter — the diagnostic listener needs the stalled counter, but
 *  harness tests only exercise skill spans. */
const noopCounter = { add() {} } as any;

/** Canonical session key in the load-bearing `agent:<id>:<channel>:...` format. */
export const SESSION = "agent:7:slack:thread-9";

export function harness(
  capture: ContentCapturePolicy = CONTENT_POLICY_DISABLED,
  usage?: UsageCoordinator,
  operationDuration?: any,
) {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "test" }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("test");
  const store = new TraceContextStore();
  const hooks: Record<string, (e: any, ctx?: any) => void> = {};
  const api = { on: (e: string, h: any) => { hooks[e] = h; } };
  const cleanup = registerHooks(api, { tracer, store, capture, usage, operationDuration });
  const fire = (event: string, payload: any = {}, ctx?: any) => hooks[event]?.(payload, ctx);
  // The real diagnostic listener (model.usage / session.stalled / skill.used),
  // wired against this harness's tracer + store so a fired `skill.used` event
  // emits an openclaw.skill.used span joined to the live turn trace.
  const diagnostic = makeDiagnosticListener({
    coordinator: usage ?? new UsageCoordinator(),
    sessionStalled: noopCounter,
    tracer,
    store,
  });
  const fireDiagnostic = (evt: any) => diagnostic(evt);
  const spans = () => exporter.getFinishedSpans();
  const byName = (n: string) => spans().find((s) => s.name === n);
  const byPrefix = (p: string) => spans().find((s) => s.name.startsWith(p));
  return { exporter, provider, fire, fireDiagnostic, store, cleanup, spans, byName, byPrefix };
}

export const parentId = (s: ReadableSpan): string | undefined =>
  (s as any).parentSpanContext?.spanId ?? (s as any).parentSpanId;
export const spanId = (s: ReadableSpan): string => s.spanContext().spanId;
export const traceId = (s: ReadableSpan): string => s.spanContext().traceId;

/** A complete, successful turn: inbound message → model call → tool call →
 *  outbound reply → agent_end with token usage. The standard fixture. */
export function runTurn(h: ReturnType<typeof harness>) {
  h.fire("session_start", { sessionKey: SESSION, channel: "slack" });
  h.fire("message_received", { sessionKey: SESSION, channel: "slack", from: "slack:U1", content: "hello" });
  h.fire("before_model_resolve", { sessionKey: SESSION });
  h.fire("before_prompt_build", {
    sessionKey: SESSION,
    prompt: "hello",
    messages: [{ role: "user", content: "hello" }],
    systemPrompt: "you are helpful",
  });
  h.fire("model_call_started", { sessionKey: SESSION, model: "claude-opus-4-6", provider: "anthropic" });
  h.fire("model_call_ended", {
    sessionKey: SESSION,
    responseModel: "claude-opus-4-6",
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  h.fire("before_tool_call", { sessionKey: SESSION, toolName: "exec", toolCallId: "call-1", params: { cmd: "ls" } });
  h.fire("after_tool_call", { sessionKey: SESSION, toolName: "exec", toolCallId: "call-1", message: { content: "ok" } });
  h.fire("message_sending", { sessionKey: SESSION, content: "hi back" });
  h.fire("message_sent", { sessionKey: SESSION, content: "hi back", channel: "slack", to: "slack:U1", success: true });
  h.fire("agent_end", {
    sessionKey: SESSION,
    success: true,
    responseModel: "claude-opus-4-6",
    usage: { input_tokens: 100, output_tokens: 50, cacheReadInputTokens: 10 },
  });
}
