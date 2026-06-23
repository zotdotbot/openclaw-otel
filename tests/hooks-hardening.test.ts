// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { harness, SESSION } from "./_emit-harness";

describe("hooks hardening", () => {
  it("ends a stranded turn span when before_model_resolve fires again without agent_end", () => {
    const h = harness();
    h.fire("message_received", { sessionKey: SESSION, channel: "slack", content: "x" });
    h.fire("before_model_resolve", { sessionKey: SESSION });
    // A second resolve with no intervening agent_end (re-resolve / retry): the
    // first turn span must be ENDED (exported), not stranded until the sweep.
    h.fire("before_model_resolve", { sessionKey: SESSION });
    const turns = h.spans().filter((s) => s.name === "openclaw.agent.turn");
    expect(turns).toHaveLength(1); // the first turn, now ended; the second is still in flight
    h.cleanup();
  });

  it("bounds and single-lines a long agent_end error in the turn span status", () => {
    const h = harness();
    h.fire("before_model_resolve", { sessionKey: SESSION });
    const longErr = "first line\n" + "x".repeat(500);
    h.fire("agent_end", { sessionKey: SESSION, success: false, error: longErr });
    const turn = h.byName("openclaw.agent.turn");
    expect(turn?.status.message).toBeDefined();
    expect(turn!.status.message!.length).toBeLessThanOrEqual(200);
    expect(turn!.status.message).not.toContain("\n");
    h.cleanup();
  });

  it("bounds a long model_call_ended error in the chat span status", () => {
    const h = harness();
    h.fire("before_model_resolve", { sessionKey: SESSION });
    h.fire("model_call_started", { sessionKey: SESSION, model: "claude-opus-4-6", provider: "anthropic" });
    h.fire("model_call_ended", { sessionKey: SESSION, error: "boom\n" + "y".repeat(500) });
    const chat = h.byPrefix("chat ");
    expect(chat?.status.message).toBeDefined();
    expect(chat!.status.message!.length).toBeLessThanOrEqual(200);
    expect(chat!.status.message).not.toContain("\n");
    h.cleanup();
  });
});
