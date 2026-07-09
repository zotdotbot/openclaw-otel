// SPDX-License-Identifier: Apache-2.0
//
// The EMIT ORACLE. Drives a simulated OpenClaw turn through the real hook
// pipeline + a real OTel SDK (InMemorySpanExporter) and asserts the emitted
// spans against the frozen contract: span names, kinds, required attributes,
// parent linkage (one turn = one connected trace), and the capture-off sentinel.

import { describe, it, expect } from "vitest";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";

import { CONTENT_POLICY_DISABLED, CONTENT_POLICY_ENABLED } from "../src/config";
import { UsageCoordinator } from "../src/diagnostics";
import { findSpanContract } from "../src/contract";
import { harness, runTurn, parentId, spanId, traceId, SESSION } from "./_emit-harness";

describe("emit oracle — connected trace topology", () => {
  it("produces the five contract spans, one connected trace, correct kinds + parents", () => {
    const h = harness();
    runTurn(h);

    const request = h.byName("openclaw.request")!;
    const turn = h.byName("openclaw.agent.turn")!;
    const chat = h.byPrefix("chat ")!;
    const tool = h.byPrefix("execute_tool ")!;
    const sent = h.byName("openclaw.message.sent")!;

    expect(request).toBeDefined();
    expect(turn).toBeDefined();
    expect(chat).toBeDefined();
    expect(tool).toBeDefined();
    expect(sent).toBeDefined();

    // Kinds
    expect(request.kind).toBe(SpanKind.SERVER);
    expect(turn.kind).toBe(SpanKind.INTERNAL);
    expect(chat.kind).toBe(SpanKind.CLIENT);
    expect(tool.kind).toBe(SpanKind.INTERNAL);
    expect(sent.kind).toBe(SpanKind.INTERNAL);

    // Names embed the runtime model/tool
    expect(chat.name).toBe("chat claude-opus-4-6");
    expect(tool.name).toBe("execute_tool exec");

    // One connected trace: request → turn → {chat, tool}; sent joins request
    expect(parentId(turn)).toBe(spanId(request));
    expect(parentId(chat)).toBe(spanId(turn));
    expect(parentId(tool)).toBe(spanId(turn));
    expect(parentId(sent)).toBe(spanId(request));
    const tid = traceId(request);
    for (const s of [turn, chat, tool, sent]) expect(traceId(s)).toBe(tid);

    h.cleanup();
  });

  it("sets the required attributes on each contract span", () => {
    const h = harness();
    runTurn(h);
    const a = (n: string) => h.byName(n)!.attributes;
    const ap = (p: string) => h.byPrefix(p)!.attributes;

    expect(a("openclaw.request")).toMatchObject({
      "openclaw.session.key": SESSION,
      "gen_ai.conversation.id": SESSION,
      "openclaw.message.channel": "slack",
      "openclaw.message.direction": "inbound",
    });
    expect(a("openclaw.agent.turn")).toMatchObject({
      "openclaw.session.key": SESSION,
      "gen_ai.conversation.id": SESSION,
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 50,
      "gen_ai.response.model": "claude-opus-4-6",
      "openclaw.agent.success": true,
      "gen_ai.usage.cache_read.input_tokens": 10,
    });
    expect(ap("chat ")).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-opus-4-6",
      "gen_ai.conversation.id": SESSION,
    });
    expect(ap("execute_tool ")).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "exec",
      "gen_ai.tool.call.id": "call-1",
      "gen_ai.conversation.id": SESSION,
      "openclaw.tool.name": "exec",
    });
    expect(a("openclaw.message.sent")).toMatchObject({
      "openclaw.session.key": SESSION,
      "gen_ai.conversation.id": SESSION,
      "openclaw.message.direction": "outbound",
      "openclaw.message.chars": 7,
    });

    h.cleanup();
  });
});

describe("emit oracle — content capture policy", () => {
  it("emits the '{}' capture-off sentinel and no content when capture is disabled", () => {
    const h = harness(CONTENT_POLICY_DISABLED);
    runTurn(h);
    expect(h.byPrefix("execute_tool ")!.attributes["openclaw.content.tool_input"]).toBe("{}");
    expect(h.byName("openclaw.request")!.attributes["openclaw.content.input_message"]).toBeUndefined();
    expect(h.byName("openclaw.message.sent")!.attributes["openclaw.content.output_message"]).toBeUndefined();
    h.cleanup();
  });

  it("captures real content on every category when enabled", () => {
    const h = harness(CONTENT_POLICY_ENABLED);
    runTurn(h);
    expect(h.byName("openclaw.request")!.attributes["openclaw.content.input_message"]).toBe("hello");
    expect(h.byName("openclaw.agent.turn")!.attributes["openclaw.content.prompt"]).toBe("hello");
    expect(h.byName("openclaw.agent.turn")!.attributes["openclaw.content.system_prompt"]).toBe("you are helpful");
    expect(h.byPrefix("execute_tool ")!.attributes["openclaw.content.tool_input"]).toBe('{"cmd":"ls"}');
    expect(h.byPrefix("execute_tool ")!.attributes["openclaw.content.tool_output"]).toBe("ok");
    expect(h.byName("openclaw.message.sent")!.attributes["openclaw.content.output_message"]).toBe("hi back");
    h.cleanup();
  });
});

describe("emit oracle — tool echo dedup + completed-root retention", () => {
  it("a timed tool call is NOT synthetic; a persist-only echo IS synthetic and shares the call id", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });

    // timed path
    h.fire("before_tool_call", { sessionKey: SESSION, toolName: "read", toolCallId: "c1", params: {} });
    h.fire("after_tool_call", { sessionKey: SESSION, toolName: "read", toolCallId: "c1", message: { content: "r" } });
    // persist-only path (no before/after)
    h.fire("tool_result_persist", { sessionKey: SESSION, toolName: "web", toolCallId: "c2", message: { content: "w" } });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });

    const tools = h.spans().filter((s) => s.name.startsWith("execute_tool "));
    const timed = tools.find((s) => s.attributes["gen_ai.tool.call.id"] === "c1")!;
    const echo = tools.find((s) => s.attributes["gen_ai.tool.call.id"] === "c2")!;
    expect(timed.attributes["openclaw.tool.is_synthetic"]).toBeUndefined();
    expect(echo.attributes["openclaw.tool.is_synthetic"]).toBe(true);
    h.cleanup();
  });

  it("a message.sent arriving AFTER agent_end still joins the request trace", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    // reply delivered after the turn closed
    h.fire("message_sent", { sessionKey: SESSION, content: "late reply", success: true });

    const request = h.byName("openclaw.request")!;
    const sent = h.byName("openclaw.message.sent")!;
    expect(parentId(sent)).toBe(spanId(request));
    expect(traceId(sent)).toBe(traceId(request));
    h.cleanup();
  });
});

describe("emit oracle — required attributes are never dropped", () => {
  it("every emitted span carries all of its contract requiredAttributes", () => {
    const h = harness();
    runTurn(h);
    for (const span of h.spans()) {
      const c = findSpanContract(span.name);
      if (!c || !c.emittedByPlugin) continue;
      for (const attr of c.requiredAttributes) {
        expect(span.attributes[attr], `${span.name} missing required ${attr}`).toBeDefined();
      }
    }
    h.cleanup();
  });

  it("a modelless turn (no model/provider on any event) still satisfies every requiredAttribute", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, channel: "slack", from: "slack:U1", content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("model_call_started", { sessionKey: SESSION });
    h.fire("model_call_ended", { sessionKey: SESSION, usage: { input_tokens: 1, output_tokens: 1 } });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    for (const span of h.spans()) {
      const c = findSpanContract(span.name);
      if (!c || !c.emittedByPlugin) continue;
      for (const attr of c.requiredAttributes) {
        expect(span.attributes[attr], `${span.name} missing required ${attr}`).toBeDefined();
      }
    }
    h.cleanup();
  });

  it("a synthetic-root turn (no message_received) still sets the required message.channel", () => {
    const h = harness();
    const key = "agent:1:discord:x";
    h.fire("session_start", { sessionKey: key, channel: "discord" });
    h.fire("before_model_resolve", { sessionKey: key, trigger: "cron" });
    h.fire("agent_end", { sessionKey: key, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    const request = h.byName("openclaw.request")!;
    expect(request).toBeDefined();
    expect(request.attributes["openclaw.message.channel"]).toBe("discord"); // recovered from session
    h.cleanup();
  });

  it("message.channel falls back to 'unknown' when absent and underivable", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: "nokey", content: "x" });
    h.fire("agent_end", { sessionKey: "nokey", success: true });
    expect(h.byName("openclaw.request")!.attributes["openclaw.message.channel"]).toBe("unknown");
    h.cleanup();
  });
});

describe("emit oracle — multi-call + id-less tool lifecycle", () => {
  it("ends the prior model-call span when a turn makes multiple model calls", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("model_call_started", { sessionKey: SESSION, model: "m1", provider: "p" });
    h.fire("model_call_started", { sessionKey: SESSION, model: "m2", provider: "p" }); // before m1 ended
    h.fire("model_call_ended", { sessionKey: SESSION, responseModel: "m2", usage: { input_tokens: 1, output_tokens: 1 } });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    const chats = h.spans().filter((s) => s.name.startsWith("chat ")).map((s) => s.name).sort();
    expect(chats).toEqual(["chat m1", "chat m2"]); // both ended, neither leaked
    h.cleanup();
  });

  it("pairs before/after tool spans even with no toolCallId (no now()-drift, no dup echo)", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("before_tool_call", { sessionKey: SESSION, toolName: "read", params: {} }); // no toolCallId
    h.fire("after_tool_call", { sessionKey: SESSION, toolName: "read", message: { content: "r" } });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    const tools = h.spans().filter((s) => s.name.startsWith("execute_tool "));
    expect(tools).toHaveLength(1); // matched + ended once, no synthetic duplicate
    expect(tools[0]!.attributes["openclaw.tool.is_synthetic"]).toBeUndefined();
    h.cleanup();
  });

  it("records the operation-duration histogram once per model call", () => {
    const durations: number[] = [];
    const opDur = { record: (v: number) => durations.push(v) } as any;
    const h = harness(CONTENT_POLICY_DISABLED, undefined, opDur);
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("model_call_started", { sessionKey: SESSION, model: "m", provider: "p" });
    h.fire("model_call_ended", { sessionKey: SESSION, responseModel: "m", usage: { input_tokens: 1, output_tokens: 1 } });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    expect(durations).toHaveLength(1);
    expect(durations[0]).toBeGreaterThanOrEqual(0); // seconds
    h.cleanup();
  });
});

describe("emit oracle — tool error surfacing (issue #7)", () => {
  it("puts the REAL error on the span status + openclaw.tool.error, not the constant or the body", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("before_tool_call", { sessionKey: SESSION, toolName: "pdf", toolCallId: "t1", params: {} });
    // after_tool_call carries the gateway's already-extracted error string, plus
    // the full result body flagged is_error (which must NEVER become the error).
    h.fire("after_tool_call", {
      sessionKey: SESSION,
      toolName: "pdf",
      toolCallId: "t1",
      error: "Not Found 404 example.com",
      message: { is_error: true, content: "<html>full page not found body…</html>" },
    });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });

    const tool = h.byPrefix("execute_tool ")!;
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(tool.status.message).toBe("Not Found 404 example.com"); // real error, not "tool_execution_error"
    expect(tool.attributes["openclaw.tool.error"]).toBe("Not Found 404 example.com");
    // the real reason already carries the "404" the consumer renders as "Error 404"
    expect(tool.status.message).toContain("404");
    expect(String(tool.attributes["openclaw.tool.error"])).not.toContain("<html>"); // body never leaks
    h.cleanup();
  });

  it("with capture OFF and no event.error, emits a non-leaking marker (never a body slice)", () => {
    const h = harness(CONTENT_POLICY_DISABLED);
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("before_tool_call", { sessionKey: SESSION, toolName: "exec", toolCallId: "t2", params: {} });
    h.fire("after_tool_call", {
      sessionKey: SESSION,
      toolName: "exec",
      toolCallId: "t2",
      message: { isError: true, content: "SECRET_TOKEN=sk-abc " + "x".repeat(500) },
    });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });

    const tool = h.byPrefix("execute_tool ")!;
    const err = String(tool.attributes["openclaw.tool.error"]);
    // capture is off — the raw body (incl. its secret) must NOT slice into the error.
    expect(err).not.toContain("SECRET_TOKEN");
    expect(err).toContain("capture off"); // marker with size only
    expect(String(tool.status.message)).not.toContain("SECRET_TOKEN");
    h.cleanup();
  });

  it("with output capture ON and no event.error, surfaces the result text bounded to 200 chars single-line", () => {
    const h = harness(CONTENT_POLICY_ENABLED);
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("before_tool_call", { sessionKey: SESSION, toolName: "exec", toolCallId: "t2", params: {} });
    h.fire("after_tool_call", {
      sessionKey: SESSION,
      toolName: "exec",
      toolCallId: "t2",
      message: { isError: true, content: "boom\nwith newlines\n" + "x".repeat(500) },
    });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });

    const err = String(h.byPrefix("execute_tool ")!.attributes["openclaw.tool.error"]);
    expect(err.length).toBeLessThanOrEqual(200);
    expect(err.startsWith("boom with newlines")).toBe(true); // whitespace collapsed
    h.cleanup();
  });

  it("a successful tool call carries no error attributes or status", () => {
    const h = harness();
    runTurn(h); // tool returns { content: "ok" }
    const tool = h.byPrefix("execute_tool ")!;
    expect(tool.attributes["openclaw.tool.error"]).toBeUndefined();
    expect(tool.attributes["openclaw.errorCode"]).toBeUndefined();
    expect(tool.status.code).not.toBe(SpanStatusCode.ERROR);
    h.cleanup();
  });
});

describe("emit oracle — bounded tool-result excerpt (issue #13)", () => {
  const CAP = 8192; // CONTENT_MAX_CHARS

  it("tail-biases tool_output on a FAILED call so trailing stderr survives truncation", () => {
    const h = harness(CONTENT_POLICY_ENABLED);
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("before_tool_call", { sessionKey: SESSION, toolName: "exec", toolCallId: "e1", params: { cmd: "./run" } });
    const stderrTail = "sh: 1: source: not found";
    // Output larger than the cap with the real error at the END (the common
    // exec shape). A head-biased excerpt would drop exactly this line.
    const body = "O".repeat(9000) + "\n" + stderrTail;
    h.fire("after_tool_call", {
      sessionKey: SESSION, toolName: "exec", toolCallId: "e1",
      message: { is_error: true, content: body, details: { exitCode: 127 } },
    });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    const tool = h.byPrefix("execute_tool ")!;
    const out = String(tool.attributes["openclaw.content.tool_output"]);
    expect(out.endsWith(stderrTail)).toBe(true);      // the failure class is preserved
    expect(out.length).toBeLessThanOrEqual(CAP);
    expect(out).toMatch(/truncated/);                 // marker signals the head was dropped
    expect(out).not.toContain("O".repeat(9000));      // head content dropped
    // the cheap size signal still reflects the FULL result, not the excerpt
    expect(tool.attributes["openclaw.tool.result_chars"]).toBe(body.length);
    h.cleanup();
  });

  it("head-biases tool_output on a SUCCESSFUL call (unchanged) so read-tool output starts at the top", () => {
    const h = harness(CONTENT_POLICY_ENABLED);
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("before_tool_call", { sessionKey: SESSION, toolName: "read", toolCallId: "r1", params: {} });
    const head = "FIRST_LINE_OF_FILE";
    const body = head + "y".repeat(9000);
    h.fire("after_tool_call", { sessionKey: SESSION, toolName: "read", toolCallId: "r1", message: { content: body } });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    const out = String(h.byPrefix("execute_tool ")!.attributes["openclaw.content.tool_output"]);
    expect(out.startsWith(head)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(CAP);
    h.cleanup();
  });

  it("leaves short failed-call output unchanged (no truncation marker)", () => {
    const h = harness(CONTENT_POLICY_ENABLED);
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("before_tool_call", { sessionKey: SESSION, toolName: "exec", toolCallId: "s1", params: {} });
    h.fire("after_tool_call", { sessionKey: SESSION, toolName: "exec", toolCallId: "s1", message: { is_error: true, content: "boom: exit 1" } });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    expect(h.byPrefix("execute_tool ")!.attributes["openclaw.content.tool_output"]).toBe("boom: exit 1");
    h.cleanup();
  });

  it("omits tool_output entirely when output capture is off, even on failure", () => {
    const h = harness(CONTENT_POLICY_DISABLED);
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("before_tool_call", { sessionKey: SESSION, toolName: "exec", toolCallId: "o1", params: {} });
    h.fire("after_tool_call", { sessionKey: SESSION, toolName: "exec", toolCallId: "o1", message: { is_error: true, content: "x".repeat(9000) + "\nfatal: boom" } });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    expect(h.byPrefix("execute_tool ")!.attributes["openclaw.content.tool_output"]).toBeUndefined();
    h.cleanup();
  });
});

describe("emit oracle — skill.used span from the diagnostic", () => {
  it("emits openclaw.skill.used joined to the live turn trace, with name + source", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    // Skills have no plugin hook — they arrive on the internal diagnostic stream.
    h.fireDiagnostic({
      type: "skill.used",
      sessionKey: SESSION,
      skillName: "fill-daily",
      skillSource: "bundled",
      activation: "invoked",
      toolName: "read",
    });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });

    const skill = h.byName("openclaw.skill.used")!;
    expect(skill).toBeDefined();
    expect(skill.kind).toBe(SpanKind.INTERNAL);
    expect(skill.attributes["openclaw.skill.name"]).toBe("fill-daily");
    expect(skill.attributes["openclaw.skill.source"]).toBe("bundled");
    expect(skill.attributes["openclaw.skill.activation"]).toBe("invoked");
    expect(skill.attributes["openclaw.tool.name"]).toBe("read");
    expect(skill.attributes["openclaw.session.key"]).toBe(SESSION);
    expect(skill.attributes["gen_ai.conversation.id"]).toBe(SESSION);
    // joined to the same trace as the request so the consumer can attribute it
    expect(traceId(skill)).toBe(traceId(h.byName("openclaw.request")!));
    h.cleanup();
  });

  it("defaults skill source to 'unknown' so the required attribute is always present", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fireDiagnostic({ type: "skill.used", sessionKey: SESSION, skillName: "x" });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    expect(h.byName("openclaw.skill.used")!.attributes["openclaw.skill.source"]).toBe("unknown");
    h.cleanup();
  });
});

describe("emit oracle — re-homed operational spans from the diagnostic stream", () => {
  it("emits context.assembled (mid-turn) joined to the live trace, with sizing attrs", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fireDiagnostic({
      type: "context.assembled",
      sessionKey: SESSION,
      promptChars: 207,
      systemPromptChars: 65932,
      messageCount: 3,
      historyTextChars: 1024,
      contextTokenBudget: 1048576,
      ts: Date.now(),
    });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });

    const ctx = h.byName("openclaw.context.assembled")!;
    expect(ctx).toBeDefined();
    expect(ctx.kind).toBe(SpanKind.INTERNAL);
    expect(ctx.attributes["openclaw.context.prompt_chars"]).toBe(207);
    expect(ctx.attributes["openclaw.context.system_prompt_chars"]).toBe(65932);
    expect(ctx.attributes["openclaw.context.message_count"]).toBe(3);
    expect(ctx.attributes["openclaw.context.token_budget"]).toBe(1048576);
    expect(ctx.attributes["openclaw.session.key"]).toBe(SESSION);
    expect(traceId(ctx)).toBe(traceId(h.byName("openclaw.request")!));
    h.cleanup();
  });

  it("emits harness.run (end-of-turn) joined via the retained completed root", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    // harness.run.completed arrives AFTER agent_end — must still join the trace.
    h.fireDiagnostic({
      type: "harness.run.completed",
      sessionKey: SESSION,
      itemLifecycle: { startedCount: 5, completedCount: 5, activeCount: 0 },
      outcome: "completed",
      durationMs: 100,
      ts: Date.now(),
    });
    const harn = h.byName("openclaw.harness.run")!;
    expect(harn).toBeDefined();
    expect(harn.attributes["openclaw.harness.items.started"]).toBe(5);
    expect(harn.attributes["openclaw.harness.items.completed"]).toBe(5);
    expect(harn.attributes["openclaw.outcome"]).toBe("completed");
    expect(traceId(harn)).toBe(traceId(h.byName("openclaw.request")!));
    h.cleanup();
  });

  it("emits message.processed with ERROR status when the inbound outcome is error", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    h.fireDiagnostic({
      type: "message.processed",
      sessionKey: SESSION,
      channel: "slack",
      outcome: "error",
      reason: "handler_threw",
      ts: Date.now(),
    });
    const mp = h.byName("openclaw.message.processed")!;
    expect(mp).toBeDefined();
    expect(mp.attributes["openclaw.outcome"]).toBe("error");
    expect(mp.attributes["openclaw.channel"]).toBe("slack");
    expect(mp.attributes["openclaw.reason"]).toBe("handler_threw");
    expect(mp.status.code).toBe(SpanStatusCode.ERROR);
    expect(traceId(mp)).toBe(traceId(h.byName("openclaw.request")!));
    h.cleanup();
  });

  it("emits message.delivery with kind/result_count/outcome", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    h.fireDiagnostic({
      type: "message.delivery.completed",
      sessionKey: SESSION,
      channel: "slack",
      deliveryKind: "reply",
      resultCount: 1,
      ts: Date.now(),
    });
    const md = h.byName("openclaw.message.delivery")!;
    expect(md.attributes["openclaw.delivery.kind"]).toBe("reply");
    expect(md.attributes["openclaw.delivery.result_count"]).toBe(1);
    expect(md.attributes["openclaw.outcome"]).toBe("completed");
    expect(traceId(md)).toBe(traceId(h.byName("openclaw.request")!));
    h.cleanup();
  });

  it("suppresses orphans: a diagnostic for a session with no live turn emits nothing", () => {
    const h = harness();
    // The instance that did NOT run the turn has a session context (and maybe a
    // gateway) but no request/agent.turn for it. A turn-scoped diagnostic span
    // must SKIP here, not orphan onto the session/gateway root — the instance
    // that ran the turn emits the (joined) copy.
    h.fire("session_start", { sessionKey: SESSION, channel: "slack" });
    h.fireDiagnostic({ type: "context.assembled", sessionKey: SESSION, promptChars: 10, ts: Date.now() });
    h.fireDiagnostic({ type: "harness.run.completed", sessionKey: SESSION, itemLifecycle: { startedCount: 1, completedCount: 1 }, ts: Date.now() });
    h.fireDiagnostic({ type: "skill.used", sessionKey: SESSION, skillName: "x", skillSource: "bundled" });
    expect(h.byName("openclaw.context.assembled")).toBeUndefined();
    expect(h.byName("openclaw.harness.run")).toBeUndefined();
    expect(h.byName("openclaw.skill.used")).toBeUndefined();
    h.cleanup();
  });

  it("does NOT re-home model/tool/root-duplicating kinds (no within-trace count collision)", () => {
    const h = harness();
    runTurn(h);
    // These diagnostic kinds describe operations the plugin already spans
    // (chat / execute_tool / request / agent.turn rollup); re-homing them would
    // double-count model calls or tools in the consumer. They must be ignored.
    h.fireDiagnostic({ type: "model.call.completed", sessionKey: SESSION, callId: "c:model:1", timeToFirstByteMs: 12, ts: Date.now() });
    h.fireDiagnostic({ type: "exec.process.completed", sessionKey: SESSION, exitCode: 0, ts: Date.now() });
    h.fireDiagnostic({ type: "run.completed", sessionKey: SESSION, outcome: "completed", ts: Date.now() });
    h.fireDiagnostic({ type: "tool.execution.completed", sessionKey: SESSION, toolName: "exec", toolCallId: "t1", ts: Date.now() });
    expect(h.byName("openclaw.model.call")).toBeUndefined();
    expect(h.byName("openclaw.exec")).toBeUndefined();
    expect(h.byName("openclaw.run")).toBeUndefined();
    expect(h.byName("openclaw.tool.execution")).toBeUndefined();
    h.cleanup();
  });
});

describe("emit oracle — outbound reply emitted from message_sending (2026.5.28 path)", () => {
  // On OpenClaw 2026.5.28's Slack delivery path, message_sending fires (with the
  // reply text + session key) but message_sent never does — verified live. So the
  // span is emitted from message_sending; message_sent is a deduped fallback.
  it("emits message.sent from message_sending, joined to the turn, with content + routing", () => {
    const h = harness(CONTENT_POLICY_ENABLED);
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("message_sending", { content: "the reply", to: "slack:U1" }, { sessionKey: SESSION, channelId: "slack" });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });

    const sent = h.spans().filter((s) => s.name === "openclaw.message.sent");
    expect(sent).toHaveLength(1); // exactly one — no double-emit
    const s = sent[0]!;
    expect(traceId(s)).toBe(traceId(h.byName("openclaw.request")!)); // joined to the turn trace
    expect(s.attributes["openclaw.session.key"]).toBe(SESSION);
    expect(s.attributes["openclaw.content.output_message"]).toBe("the reply");
    expect(s.attributes["openclaw.message.to"]).toBe("slack:U1");
    expect(s.attributes["openclaw.message.direction"]).toBe("outbound");
    h.cleanup();
  });

  it("joins the request trace even when the reply is delivered AFTER agent_end (completed-root retention)", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    h.fire("message_sending", { content: "late reply", to: "u" }, { sessionKey: SESSION });

    const sent = h.byName("openclaw.message.sent")!;
    expect(sent).toBeDefined();
    expect(parentId(sent)).toBe(spanId(h.byName("openclaw.request")!));
    expect(traceId(sent)).toBe(traceId(h.byName("openclaw.request")!));
    h.cleanup();
  });

  it("message_sent is a deduped no-op when message_sending already emitted (no double span)", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("message_sending", { content: "hi", to: "u" }, { sessionKey: SESSION });
    h.fire("message_sent", { content: "hi", success: true }, { sessionKey: SESSION }); // versions where it ALSO fires
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    expect(h.spans().filter((s) => s.name === "openclaw.message.sent")).toHaveLength(1);
    h.cleanup();
  });

  it("message_sent emits as a fallback when message_sending did not fire (other gateway versions)", () => {
    const h = harness(CONTENT_POLICY_ENABLED);
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    h.fire("message_sent", { content: "reply via message_sent", to: "u", success: true }, { sessionKey: SESSION });
    const sent = h.spans().filter((s) => s.name === "openclaw.message.sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.attributes["openclaw.content.output_message"]).toBe("reply via message_sent");
    h.cleanup();
  });

  it("a new inbound turn clears the emit marker so the next turn's fallback message_sent still emits", () => {
    const h = harness();
    // Turn N: message_sending emits + marks the session.
    h.fire("message_received", { sessionKey: SESSION, content: "n" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("message_sending", { content: "reply N", to: "u" }, { sessionKey: SESSION });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    // Turn N+1: NO message_sending, only a fallback message_sent — the prior
    // marker must have been cleared on the new inbound or N+1 would be deduped away.
    h.fire("message_received", { sessionKey: SESSION, content: "n+1" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    h.fire("message_sent", { content: "reply N+1", success: true }, { sessionKey: SESSION });
    expect(h.spans().filter((s) => s.name === "openclaw.message.sent")).toHaveLength(2);
    h.cleanup();
  });

  it("never silently drops the span when no session key is present", () => {
    const h = harness();
    h.fire("message_sending", { content: "orphan reply", to: "u" }); // no sessionKey anywhere
    const sent = h.byName("openclaw.message.sent")!;
    expect(sent).toBeDefined();
    expect(sent.attributes["openclaw.message.direction"]).toBe("outbound");
    expect(sent.attributes["openclaw.message.chars"]).toBe("orphan reply".length);
    h.cleanup();
  });
});

describe("emit oracle — held-open turn token rollup", () => {
  it("holds the turn open until model.usage arrives, then enriches (overriding event usage)", () => {
    const coordinator = new UsageCoordinator();
    const h = harness(CONTENT_POLICY_DISABLED, coordinator);
    runTurn(h); // agent_end fires with event usage {100,50} → turn PARKED (held open)

    // The turn span is not exported yet — it's held open awaiting the diagnostic.
    expect(h.byName("openclaw.agent.turn")).toBeUndefined();

    // The model.usage diagnostic lands with the accurate counts.
    coordinator.onUsage(SESSION, { input: 999, output: 7, cacheRead: 3 });

    const turn = h.byName("openclaw.agent.turn")!;
    expect(turn).toBeDefined();
    expect(turn.attributes["gen_ai.usage.input_tokens"]).toBe(999); // diagnostic overrides event 100
    expect(turn.attributes["gen_ai.usage.output_tokens"]).toBe(7);
    expect(turn.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(3);
    expect(turn.attributes["openclaw.agent.success"]).toBe(true);
    h.cleanup();
  });
});

describe("emit oracle — per-call detail on chat / execute_tool (ttfb, exec exit code)", () => {
  it("sets ttfb + request/response bytes on the chat span from model_call_ended", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("model_call_started", { sessionKey: SESSION, model: "m", provider: "p" });
    h.fire("model_call_ended", {
      sessionKey: SESSION, responseModel: "m",
      usage: { input_tokens: 1, output_tokens: 1 },
      timeToFirstByteMs: 17, requestPayloadBytes: 113837, responseStreamBytes: 7028,
    });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    const chat = h.byPrefix("chat ")!;
    expect(chat.attributes["openclaw.model_call.time_to_first_byte_ms"]).toBe(17);
    expect(chat.attributes["openclaw.model_call.request_bytes"]).toBe(113837);
    expect(chat.attributes["openclaw.model_call.response_bytes"]).toBe(7028);
    h.cleanup();
  });

  it("sets exec exit_code + timed_out on execute_tool from the result details", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("before_tool_call", { sessionKey: SESSION, toolName: "exec", toolCallId: "c1", params: { cmd: "ls" } });
    h.fire("after_tool_call", {
      sessionKey: SESSION, toolName: "exec", toolCallId: "c1",
      message: { content: "no such dir", is_error: true, details: { exitCode: 2, timedOut: false } },
    });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    const tool = h.byPrefix("execute_tool ")!;
    expect(tool.attributes["openclaw.exec.exit_code"]).toBe(2);
    expect(tool.attributes["openclaw.exec.timed_out"]).toBe(false);
    h.cleanup();
  });

  it("omits exec attrs when the tool result carries no exit detail", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("before_tool_call", { sessionKey: SESSION, toolName: "read", toolCallId: "c2", params: {} });
    h.fire("after_tool_call", { sessionKey: SESSION, toolName: "read", toolCallId: "c2", message: { content: "data" } });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    const tool = h.byPrefix("execute_tool ")!;
    expect(tool.attributes["openclaw.exec.exit_code"]).toBeUndefined();
    expect(tool.attributes["openclaw.exec.timed_out"]).toBeUndefined();
    h.cleanup();
  });
});

describe('emit oracle — no literal "unknown" in gen_ai attrs (issue #5)', () => {
  // OpenRouter/DeepSeek path on 2026.5.28: model_call_started / agent_end carry
  // NO model or provider fields. A populated "unknown" is indistinguishable
  // from a real value and poisons downstream cost attribution — the attribute
  // must be ABSENT instead (GenAI semconv), and the span name falls back to
  // the bare operation name "chat".

  /** A full turn whose events never carry a model or provider. */
  const runModellessTurn = (h: ReturnType<typeof harness>) => {
    h.fire("message_received", { sessionKey: SESSION, channel: "slack", from: "slack:U1", content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("model_call_started", { sessionKey: SESSION });
    h.fire("model_call_ended", { sessionKey: SESSION, usage: { input_tokens: 1, output_tokens: 1 } });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
  };

  it("names the modelless chat span bare 'chat' and omits gen_ai.request.model / provider.name", () => {
    const h = harness();
    runModellessTurn(h);
    const chat = h.byName("chat")!;
    expect(chat).toBeDefined();
    expect(chat.attributes["gen_ai.request.model"]).toBeUndefined();
    expect(chat.attributes["gen_ai.provider.name"]).toBeUndefined();
    expect(chat.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(chat.attributes["gen_ai.conversation.id"]).toBe(SESSION);
    h.cleanup();
  });

  it("omits gen_ai.response.model on the turn rollup when no model is resolvable", () => {
    const h = harness();
    runModellessTurn(h);
    const turn = h.byName("openclaw.agent.turn")!;
    expect(turn).toBeDefined();
    expect(turn.attributes["gen_ai.response.model"]).toBeUndefined();
    h.cleanup();
  });

  it("never emits the literal 'unknown' for any gen_ai.* attribute on a modelless turn", () => {
    const h = harness();
    runModellessTurn(h);
    for (const s of h.spans()) {
      for (const [k, v] of Object.entries(s.attributes)) {
        if (k.startsWith("gen_ai.")) expect(v, `${s.name} ${k}`).not.toBe("unknown");
      }
    }
    h.cleanup();
  });

  it("recovers the real model on the held-open turn from the model.usage diagnostic", () => {
    const coordinator = new UsageCoordinator();
    const h = harness(CONTENT_POLICY_DISABLED, coordinator);
    runModellessTurn(h); // agent_end parks the turn awaiting the diagnostic
    expect(h.byName("openclaw.agent.turn")).toBeUndefined();
    h.fireDiagnostic({
      type: "model.usage",
      sessionKey: SESSION,
      model: "deepseek/deepseek-v4-pro",
      usage: { input: 5, output: 2 },
    });
    const turn = h.byName("openclaw.agent.turn")!;
    expect(turn).toBeDefined();
    expect(turn.attributes["gen_ai.response.model"]).toBe("deepseek/deepseek-v4-pro");
    // The chat span ended at model_call_ended, BEFORE the diagnostic — the
    // back-fill must touch only the held-open turn, never rename or enrich
    // the already-exported chat span.
    const chat = h.byName("chat")!;
    expect(chat).toBeDefined();
    expect(chat.attributes["gen_ai.request.model"]).toBeUndefined();
    h.cleanup();
  });
});
