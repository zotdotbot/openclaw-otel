# Contributing to @zotdotbot/openclaw-otel

Thanks for your interest in improving the plugin! This document covers how to
get a working dev setup, what we expect from changes, and the one rule that is
different from most repos: **the telemetry vocabulary is a frozen wire
contract.**

## Dev setup

Requirements: Node.js ≥ 18.19 (see `engines` in `package.json`).

```bash
git clone https://github.com/zotdotbot/openclaw-otel.git
cd openclaw-otel
npm install
npm test              # vitest — full suite, must be green
npm run typecheck     # tsc --noEmit
npm run build         # bundles src/ into dist/index.js (esbuild)
npm run verify:package  # packs the tarball and installs it into a clean project
```

The plugin ships as **one bundled file with zero runtime dependencies** — every
`@opentelemetry/*` package is inlined at build time. Don't add runtime
dependencies; add devDependencies and let the bundler inline them (and update
`THIRD-PARTY-NOTICES.md` if the bundled set changes).

## The wire contract (read this before changing any span or attribute)

Downstream consumers parse the exact span names, attribute keys, and string
formats this plugin emits. That vocabulary is frozen and machine-readable in
[`src/contract.ts`](src/contract.ts), documented in [`CONTRACT.md`](CONTRACT.md),
and enforced by the contract tests and the emit oracle
([`tests/contract.test.ts`](tests/contract.test.ts),
[`tests/emit.test.ts`](tests/emit.test.ts)).

If your change touches a span name, a required attribute, a metric, a resource
attribute, or a load-bearing string format:

1. Update `src/contract.ts` **and** `CONTRACT.md` in the same PR.
2. Bump `OPENCLAW_SCHEMA_VERSION` in `src/semconv.ts` and document the bump in
   both changelog comments (semconv) and the CONTRACT.md header.
3. Never emit placeholder values (e.g. the literal `"unknown"`) for attributes
   you can't resolve — omit the attribute instead (see issue #5).

If the wire output is unchanged, keep the schema version unchanged.

## Plugin config keys

The manifest's `configSchema` in `openclaw.plugin.json` is
`additionalProperties: false`, and the OpenClaw gateway validates config against
it **before** the plugin loads. Any key `parseConfig` accepts but the manifest
omits makes the whole gateway refuse to start. If you add a config key, add it
to **both** `src/config.ts` and `openclaw.plugin.json` — the packaging parity
test enforces this.

## Tests

Every behavior change needs test coverage — this repo's suite drives a real
OTel SDK through the actual hook pipeline (see `tests/_emit-harness.ts`), so
most changes can be tested end-to-end cheaply. Write the failing test first
when practical. CI must be green.

## Versioning & releases

The version lives in **three places that must stay in sync** (enforced by
tests): `package.json`, `openclaw.plugin.json`, and `src/version.ts`.
Maintainers publish to npm and create a matching GitHub release; contributors
don't need to touch versions unless asked.

## Commit / PR conventions

- Conventional-commit style, imperative mood (`fix: …`, `feat: …`, `docs: …`).
- One logical change per PR.
- Fill in the PR template — especially the contract-impact checklist.

## Questions

Open a [discussion or issue](https://github.com/zotdotbot/openclaw-otel/issues).
For security reports, **do not open a public issue** — see
[SECURITY.md](SECURITY.md).
