// SPDX-License-Identifier: Apache-2.0
//
// CONSUMER-PARITY VERIFICATION (Phase 6).
//
// The emit oracle (emit.test.ts) proves the plugin emits what *our* frozen
// contract (src/contract.ts) describes. This file closes the other half: it
// proves the plugin's REAL emitted spans are read correctly by an ACTUAL
// downstream consumer — a real-world `openclaw` convention.
//
// We cannot stand up a live OpenClaw gateway here (the runtime isn't installed,
// and a real turn needs LLM credentials + a collector). Instead we take the
// rigorous static substitute: a FAITHFUL, MINIMAL PORT of the consumer's
// load-bearing read logic — each function transcribes the consumer's read
// behavior verbatim — run over spans produced by the real hook
// pipeline + a real OTel SDK. If the plugin's emitted span names, attribute
// keys, value coercions, or the load-bearing STRING FORMATS ever drift from
// what the convention parses, these assertions fail.
//
// Keep the port aligned with the consumer. It is a transcription, not a
// re-derivation — if you change it, change it to match the consumer's behavior.

import { describe, it, expect } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-node";

import {
  CONTENT_POLICY_DISABLED,
  CONTENT_POLICY_ENABLED,
} from "../src/config";
import { harness, runTurn, SESSION } from "./_emit-harness";

// ───────────────────────────────────────────────────────────────────────────
// Faithful port of the consumer convention's load-bearing read surface.
// ───────────────────────────────────────────────────────────────────────────

type Attrs = Record<string, unknown>;
type Role = "ROOT" | "MODEL" | "TOOL" | "CONTEXT" | "OTHER";

const attrsOf = (s: ReadableSpan): Attrs => s.attributes as Attrs;

// consumer classify(). Span name ONLY — never gen_ai.operation.name.
// Check order is transcribed verbatim from the consumer; it is load-bearing.
const TOOL_SPANS = new Set(["openclaw.tool.execution", "openclaw.exec"]);
function classify(op: string, attrs: Attrs): Role {
  if (TOOL_SPANS.has(op)) return "TOOL";
  if (op === "openclaw.model.call") return "MODEL";
  if (op === "openclaw.run" || op === "openclaw.request") return "ROOT";
  if (op === "openclaw.context.assembled") return "CONTEXT";
  if (op.startsWith("execute_tool")) {
    // echo span (key present) demotes to OTHER so tool calls don't double-count.
    return "openclaw.tool.is_synthetic" in attrs ? "OTHER" : "TOOL";
  }
  if (op.startsWith("chat ") || op === "chat") return "MODEL";
  return "OTHER"; // falls through — agent.turn / model.usage / message.sent handled elsewhere
}

// consumer _plugin_channel(). Both string formats are load-bearing.
function pluginChannel(attrs: Attrs): string {
  const frm = (attrs["openclaw.message.from"] as string) || "";
  if (frm.includes(":")) return frm.split(":")[0]!; // consumer takes the substring before the first ':'
  const key =
    (attrs["openclaw.session.key"] as string) ||
    (attrs["gen_ai.conversation.id"] as string) ||
    "";
  const parts = key.split(":");
  if (parts.length >= 3 && parts[0] === "agent") return parts[2]!; // 'agent:<id>:<channel>:...'
  return "";
}

// consumer _conversation_id()
function conversationId(attrs: Attrs): string {
  return (
    (attrs["gen_ai.conversation.id"] as string) ||
    (attrs["openclaw.session.key"] as string) ||
    ""
  );
}

// consumer _turn_failed() — the agent.success clause, read as a string.
function successField(attrs: Attrs): string {
  return String(attrs["openclaw.agent.success"] ?? "").trim().toLowerCase();
}

// consumer tool_call() name resolution (first truthy, then derive from name).
const TOOL_NAME_ATTRS = ["gen_ai.tool.name", "openclaw.toolName", "openclaw.tool.name"];
function toolName(op: string, attrs: Attrs): string {
  for (const a of TOOL_NAME_ATTRS) {
    const v = attrs[a];
    if (v) return String(v);
  }
  const prefix = "execute_tool ";
  if (op.startsWith(prefix)) return op.slice(prefix.length).trim();
  return "";
}

// consumer _tool_input() — the '{}' capture-off sentinel.
function toolInput(attrs: Attrs): string {
  for (const a of ["openclaw.content.tool_input", "openclaw.tool.input_preview"]) {
    const raw = attrs[a];
    const v = (raw ? String(raw) : "").trim(); // consumer treats a missing/empty value as ""
    if (v && v !== "{}") return v.slice(0, 300);
  }
  return "";
}

// consumer tool_call() — error-message assembly. statusMessage is the
// base; errorCategory then errorCode are folded in when not already present.
function statusMessage(s: ReadableSpan): string {
  return (s as any).status?.message ?? "";
}
function spanHasError(s: ReadableSpan): boolean {
  return (s as any).status?.code === 2; // SpanStatusCode.ERROR
}
function toolCallError(s: ReadableSpan): { has_error: boolean; error_msg: string } {
  const tags = attrsOf(s);
  let msg = statusMessage(s);
  const cat = tags["openclaw.errorCategory"];
  if (cat && !msg.includes(String(cat))) msg = msg ? `${cat}: ${msg}` : String(cat);
  const code = tags["openclaw.errorCode"];
  if (code && !msg.includes(String(code))) msg = (msg ? `${msg} ${code}` : String(code)).trim();
  return { has_error: spanHasError(s), error_msg: msg };
}

// consumer skill_usage() — the read surface: each openclaw.skill.used
// span yields one entry keyed by name + source.
function skillUsage(spans: ReadableSpan[]): Array<{ name: string; source: string }> {
  return spans
    .filter((s) => s.name === "openclaw.skill.used")
    .map((s) => {
      const t = attrsOf(s);
      return {
        name: (t["openclaw.skill.name"] as string) || "skill",
        source: (t["openclaw.skill.source"] as string) || "",
      };
    });
}

// consumer evidence/conversation — the reply is harvested off whatever
// span carries openclaw.content.output_message, by attribute key.
function outputMessages(spans: ReadableSpan[]): string[] {
  return spans
    .map((s) => attrsOf(s)["openclaw.content.output_message"])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

// consumer token rollup on agent.turn (integer parse, default 0).
function turnTokens(attrs: Attrs) {
  const n = (k: string) => {
    const v = Number(attrs[k]);
    return Number.isFinite(v) ? v : 0;
  };
  return {
    input: n("gen_ai.usage.input_tokens"),
    output: n("gen_ai.usage.output_tokens"),
    cacheRead: n("gen_ai.usage.cache_read.input_tokens"),
    cacheWrite: n("gen_ai.usage.cache_creation.input_tokens"),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Verification: run the consumer's logic over the plugin's real output.
// ───────────────────────────────────────────────────────────────────────────

describe("consumer parity — span classification", () => {
  it("classifies the five emitted spans exactly as the consumer would", () => {
    const h = harness();
    runTurn(h);
    const roleOf = (s: ReadableSpan) => classify(s.name, attrsOf(s));

    expect(roleOf(h.byName("openclaw.request")!)).toBe("ROOT");
    expect(roleOf(h.byName("openclaw.agent.turn")!)).toBe("OTHER"); // rollup, handled specially
    expect(roleOf(h.byPrefix("chat ")!)).toBe("MODEL");
    expect(roleOf(h.byPrefix("execute_tool ")!)).toBe("TOOL");
    expect(roleOf(h.byName("openclaw.message.sent")!)).toBe("OTHER");
    h.cleanup();
  });

  it("demotes the synthetic tool echo to OTHER so tool calls are not double-counted", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("before_tool_call", { sessionKey: SESSION, toolName: "read", toolCallId: "c1", params: {} });
    h.fire("after_tool_call", { sessionKey: SESSION, toolName: "read", toolCallId: "c1", message: { content: "r" } });
    h.fire("tool_result_persist", { sessionKey: SESSION, toolName: "web", toolCallId: "c2", message: { content: "w" } });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });

    const tools = h.spans().filter((s) => s.name.startsWith("execute_tool "));
    const real = tools.find((s) => s.attributes["gen_ai.tool.call.id"] === "c1")!;
    const echo = tools.find((s) => s.attributes["gen_ai.tool.call.id"] === "c2")!;
    expect(classify(real.name, attrsOf(real))).toBe("TOOL");
    expect(classify(echo.name, attrsOf(echo))).toBe("OTHER");
    h.cleanup();
  });
});

describe("consumer parity — correlation key parsing", () => {
  it("derives the channel from message.from and from the session-key format", () => {
    const h = harness();
    runTurn(h);
    const req = attrsOf(h.byName("openclaw.request")!);

    // message.from = 'slack:U1' → prefix before first ':'.
    expect(pluginChannel(req)).toBe("slack");
    // session-key-only path: 'agent:<id>:<channel>:...' → parts[2].
    expect(pluginChannel({ "openclaw.session.key": SESSION })).toBe("slack");
    h.cleanup();
  });

  it("recovers the channel from a synthetic-root (cron) turn with no inbound message", () => {
    const h = harness();
    const key = "agent:1:discord:x";
    h.fire("session_start", { sessionKey: key, channel: "discord" });
    h.fire("before_model_resolve", { sessionKey: key, trigger: "cron" });
    h.fire("agent_end", { sessionKey: key, success: true, usage: { input_tokens: 1, output_tokens: 1 } });

    const req = attrsOf(h.byName("openclaw.request")!);
    // openclaw.message.from is absent on a synthetic root; the consumer falls
    // back to the session-key split → channel 'discord'.
    expect(pluginChannel(req)).toBe("discord");
    h.cleanup();
  });

  it("resolves the conversation id on every consumer-read span", () => {
    const h = harness();
    runTurn(h);
    for (const name of ["openclaw.request", "openclaw.agent.turn"]) {
      expect(conversationId(attrsOf(h.byName(name)!))).toBe(SESSION);
    }
    expect(conversationId(attrsOf(h.byPrefix("chat ")!))).toBe(SESSION);
    expect(conversationId(attrsOf(h.byPrefix("execute_tool ")!))).toBe(SESSION);
    h.cleanup();
  });
});

describe("consumer parity — agent.success is a boolean the consumer reads as a string", () => {
  // The single most subtle contract decision: the plugin emits a BOOLEAN, while
  // the consumer reads it as a trimmed, lowercased string compared to "false". Prove both paths.
  it("a successful turn is not flagged failed", () => {
    const h = harness();
    runTurn(h);
    const turn = attrsOf(h.byName("openclaw.agent.turn")!);
    expect(turn["openclaw.agent.success"]).toBe(true); // emitted as a boolean
    expect(successField(turn)).toBe("true"); // boolean true → the string "true"
    expect(successField(turn) === "false").toBe(false); // → not failed
    h.cleanup();
  });

  it("a failed turn IS flagged failed under the consumer's string check", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, channel: "slack", from: "slack:U1", content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("agent_end", { sessionKey: SESSION, success: false, usage: { input_tokens: 1, output_tokens: 1 } });

    const turn = attrsOf(h.byName("openclaw.agent.turn")!);
    expect(turn["openclaw.agent.success"]).toBe(false); // emitted as a boolean
    expect(successField(turn)).toBe("false"); // boolean false → the string "false"
    expect(successField(turn) === "false").toBe(true); // → failed
    h.cleanup();
  });
});

describe("consumer parity — token rollup, tool name, and content sentinel", () => {
  it("exposes the turn token rollup the consumer's token_usage_totals trusts", () => {
    const h = harness();
    runTurn(h);
    expect(turnTokens(attrsOf(h.byName("openclaw.agent.turn")!))).toEqual({
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 0,
    });
    h.cleanup();
  });

  it("resolves the tool name via the consumer's fallback chain", () => {
    const h = harness();
    runTurn(h);
    const tool = h.byPrefix("execute_tool ")!;
    // gen_ai.tool.name (first in the chain) is present → resolves to 'exec'.
    expect(toolName(tool.name, attrsOf(tool))).toBe("exec");
    h.cleanup();
  });

  it("treats the '{}' sentinel as capture-off and real JSON as captured input", () => {
    const off = harness(CONTENT_POLICY_DISABLED);
    runTurn(off);
    expect(off.byPrefix("execute_tool ")!.attributes["openclaw.content.tool_input"]).toBe("{}");
    expect(toolInput(attrsOf(off.byPrefix("execute_tool ")!))).toBe(""); // sentinel → empty
    off.cleanup();

    const on = harness(CONTENT_POLICY_ENABLED);
    runTurn(on);
    expect(toolInput(attrsOf(on.byPrefix("execute_tool ")!))).toBe('{"cmd":"ls"}');
    on.cleanup();
  });
});

describe("consumer parity — issue #7 tool error reads as the real reason, not 'Error'", () => {
  it("the consumer's tool_call() error path yields the real error and code from our span", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("before_tool_call", { sessionKey: SESSION, toolName: "pdf", toolCallId: "t1", params: {} });
    h.fire("after_tool_call", {
      sessionKey: SESSION, toolName: "pdf", toolCallId: "t1",
      error: "Not Found 404 example.com",
      message: { is_error: true, content: "<html>body</html>" },
    });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });

    const tc = toolCallError(h.byPrefix("execute_tool ")!);
    expect(tc.has_error).toBe(true);
    // the consumer renders the real reason (and the 404 it already contains),
    // not the old bare "Error" / "tool_execution_error".
    expect(tc.error_msg).toBe("Not Found 404 example.com");
    expect(tc.error_msg).not.toContain("tool_execution_error");
    h.cleanup();
  });
});

describe("consumer parity — skills are attributed from openclaw.skill.used", () => {
  it("the consumer's skill_usage() reads the plugin's emitted skill spans", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fireDiagnostic({ type: "skill.used", sessionKey: SESSION, skillName: "fill-weekly", skillSource: "workspace" });
    h.fireDiagnostic({ type: "skill.used", sessionKey: SESSION, skillName: "whoop", skillSource: "bundled" });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });

    expect(skillUsage(h.spans())).toEqual([
      { name: "fill-weekly", source: "workspace" },
      { name: "whoop", source: "bundled" },
    ]);
    h.cleanup();
  });
});

describe("consumer parity — the agent reply is harvested from message.sent content", () => {
  it("the consumer reads output_message off message.sent when capture is on", () => {
    const h = harness(CONTENT_POLICY_ENABLED);
    runTurn(h);
    expect(outputMessages(h.spans())).toContain("hi back");
    h.cleanup();
  });

  it("no transcript content leaks when capture is off (only the span itself)", () => {
    const h = harness(CONTENT_POLICY_DISABLED);
    runTurn(h);
    expect(h.byName("openclaw.message.sent")).toBeDefined();
    expect(outputMessages(h.spans())).toEqual([]);
    h.cleanup();
  });
});

// The consumer reads the re-homed operational spans the SAME way it reads the
// built-in diagnostics.otel ones (same names + attrs). These ports confirm the
// consumer consumes our synthesized spans with NO change — and, crucially, that
// they classify as CONTEXT/OTHER so they never inflate model-call or tool counts.

// consumer _context_bits() — prompt-assembly sizing read off
// openclaw.context.assembled.
function contextBits(s: ReadableSpan) {
  const t = attrsOf(s);
  const n = (k: string) => (t[k] === undefined ? undefined : Number(t[k]));
  return {
    prompt_chars: n("openclaw.context.prompt_chars"),
    system_prompt_chars: n("openclaw.context.system_prompt_chars"),
    message_count: n("openclaw.context.message_count"),
  };
}

// consumer harness completion check (done < started → warn).
function harnessItems(s: ReadableSpan) {
  const t = attrsOf(s);
  return {
    started: Number(t["openclaw.harness.items.started"]),
    completed: Number(t["openclaw.harness.items.completed"]),
  };
}

describe("consumer parity — re-homed operational spans", () => {
  it("classifies the new spans as CONTEXT/OTHER — never MODEL/TOOL/ROOT (no count collision)", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fireDiagnostic({ type: "context.assembled", sessionKey: SESSION, promptChars: 10, ts: Date.now() });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    h.fireDiagnostic({ type: "harness.run.completed", sessionKey: SESSION, itemLifecycle: { startedCount: 2, completedCount: 2 }, ts: Date.now() });
    h.fireDiagnostic({ type: "message.processed", sessionKey: SESSION, channel: "slack", outcome: "completed", ts: Date.now() });
    h.fireDiagnostic({ type: "message.delivery.completed", sessionKey: SESSION, deliveryKind: "reply", resultCount: 1, ts: Date.now() });

    const roleOf = (name: string) =>
      classify(name, attrsOf(h.byName(name)!));
    expect(roleOf("openclaw.context.assembled")).toBe("CONTEXT");
    expect(roleOf("openclaw.harness.run")).toBe("OTHER");
    expect(roleOf("openclaw.message.processed")).toBe("OTHER");
    expect(roleOf("openclaw.message.delivery")).toBe("OTHER");

    // The whole point: a turn with these extra spans still counts exactly ONE
    // model call and ONE tool call (the plugin's chat / execute_tool), not two.
    const modelCalls = h.spans().filter((s) => classify(s.name, attrsOf(s)) === "MODEL").length;
    const toolCalls = h.spans().filter((s) => classify(s.name, attrsOf(s)) === "TOOL").length;
    expect(modelCalls).toBe(0); // this fixture fires no model_call_* / tool hooks
    expect(toolCalls).toBe(0);
    h.cleanup();
  });

  it("classifies cron + heartbeat spans as OTHER — never MODEL/TOOL/ROOT", () => {
    // These names fall through the consumer's classify() to ROLE_OTHER, so they
    // carry operational signal without inflating model/tool/root counts.
    for (const name of [
      "openclaw.cron.run",
      "openclaw.cron.definition",
      "openclaw.heartbeat.run",
    ]) {
      expect(classify(name, {})).toBe("OTHER");
    }
  });

  it("reads context-assembly sizing off openclaw.context.assembled", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fireDiagnostic({
      type: "context.assembled", sessionKey: SESSION,
      promptChars: 207, systemPromptChars: 65932, messageCount: 3, ts: Date.now(),
    });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    expect(contextBits(h.byName("openclaw.context.assembled")!)).toEqual({
      prompt_chars: 207, system_prompt_chars: 65932, message_count: 3,
    });
    h.cleanup();
  });

  it("reads harness item lifecycle (started/completed) for the loop-completion check", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("agent_end", { sessionKey: SESSION, success: true, usage: { input_tokens: 1, output_tokens: 1 } });
    h.fireDiagnostic({
      type: "harness.run.completed", sessionKey: SESSION,
      itemLifecycle: { startedCount: 5, completedCount: 4, activeCount: 1 }, ts: Date.now(),
    });
    const items = harnessItems(h.byName("openclaw.harness.run")!);
    expect(items).toEqual({ started: 5, completed: 4 });
    expect(items.completed < items.started).toBe(true); // the consumer's warn condition
    h.cleanup();
  });
});
