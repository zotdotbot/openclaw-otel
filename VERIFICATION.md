# Conformance verification

This plugin emits a **frozen wire contract** that an out-of-tree consumer parses.
"Conformance" means: the bytes this plugin puts on the wire are exactly what a
downstream consumer reads. It is verified in two layers, in CI, with no network.

## Layer 1 — emit oracle (`tests/emit.test.ts`)

Drives a simulated turn through the **real hook pipeline + a real OTel SDK**
(`InMemorySpanExporter`) and asserts the emitted spans against the frozen
contract in `src/contract.ts`: span names, kinds, parent linkage (one turn = one
connected trace), every required attribute, the content-capture policy, and the
`'{}'` capture-off sentinel.

> plugin → real OTel SDK → emitted spans **==** `src/contract.ts`

## Layer 2 — consumer parity (`tests/consumer-parity.test.ts`)

A **faithful port** of a real downstream consumer's load-bearing read logic, run
over the same real emitted spans. Each ported function transcribes the behavior
of the consumer's read surface; it is a transcription, not a re-derivation.
It covers the parts of the contract that are easy to break silently:

- span **classification** by name (`ROLE_ROOT` / `MODEL` / `TOOL` / `OTHER`);
- the **synthetic tool-echo** demotion that prevents double-counting;
- **channel** derivation from the two load-bearing string formats
  (`openclaw.message.from` = `<channel>:…`, `openclaw.session.key` =
  `agent:<id>:<channel>:…`);
- **conversation-id** resolution on every consumer-read span;
- `openclaw.agent.success` emitted as a **boolean** but read by the consumer as
  a lowercased string compared to `"false"` (the most subtle decision — both paths tested);
- the **token rollup** the consumer's `token_usage_totals()` trusts;
- the **tool-name** fallback chain;
- the `'{}'` tool-input **sentinel**.

> consumer port (a faithful model of a real consumer) applied to the plugin's real spans → correct values

## Why the two layers are sufficient

Layer 1 proves *emitted output == our contract*. Layer 2 proves *our output is
read correctly by a faithful model of the real consumer*. Together, by
transitivity, the plugin's actual OTLP output is correctly consumed by a real
downstream consumer — checked over the **load-bearing** attributes and string
formats the contract depends on, not just the ones a single sample turn happens
to exercise.

## What is NOT covered here (and the live check)

These tests do **not** run a live OpenClaw gateway: the runtime isn't installed
in CI, and a real turn needs LLM credentials and a running collector. The
consumer port is also only as current as the consumer's read surface at the time
it was ported — if a consumer changes what it reads, bump `SCHEMA_VERSION` and
update the port in lockstep (see the compatibility rule in `src/contract.ts`).

Two consumer read-paths are intentionally **out of scope** for the port, because
they only fire on built-in spans this plugin does not emit (documented in
`src/contract.ts` as `emittedByPlugin: false`):

- `_channel()`'s preferential read of `openclaw.channel` / `openclaw.trigger`
  (the plugin derives channel via `openclaw.message.from` / `openclaw.session.key`,
  which the port *does* cover);
- `token_usage_totals()`'s dedup that drops `openclaw.model.usage` spans when a
  turn rollup is present (the plugin never emits `openclaw.model.usage`, so a
  mixed-vocabulary trace can't arise from this plugin's output alone).

When a gateway **is** available, the end-to-end live check is:

1. `npm install @zotdotbot/openclaw-otel` into the gateway; enable it in
   `openclaw.json` with `hooks.allowConversationAccess: true` and an `endpoint`
   pointing at an OTLP collector (e.g. SigNoz).
2. Drive one real turn (any channel).
3. Confirm the convention parses the captured trace — the root classifies as
   `ROLE_ROOT`, the turn's `gen_ai.usage.*` rollup is read, the channel resolves,
   and `openclaw.session.stalled` is the metric surfaced.
