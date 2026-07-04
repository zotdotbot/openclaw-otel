# Changelog

All notable changes are documented in the
[GitHub releases](https://github.com/zotdotbot/openclaw-otel/releases). This
file is the quick index.

## [0.2.0](https://github.com/zotdotbot/openclaw-otel/releases/tag/v0.2.0) — 2026-07-03

- **Fixed:** never emit the literal `"unknown"` for `gen_ai.request.model` /
  `gen_ai.provider.name` (chat spans) or `gen_ai.response.model` (turn
  rollups) — the attribute is omitted when unresolvable and the chat span name
  falls back to the bare `chat` (#5, #6).
- **Changed:** wire schema `1.7.0` → `1.8.0` (loosening — the three attributes
  above are now optional).
- Includes the unpublished 0.1.3 changes below.

## [0.1.3](https://github.com/zotdotbot/openclaw-otel/releases/tag/v0.1.3) — 2026-07-02

_Not published to npm; ships in 0.2.0._

- **Added:** best-effort `openclaw.version` resource attribute (host gateway
  version), omitted when unresolvable (#4). Wire schema `1.6.0` → `1.7.0`
  (additive).

## [0.1.2](https://github.com/zotdotbot/openclaw-otel/releases/tag/v0.1.2) — 2026-06-26

- **Docs:** OpenClaw version compatibility table in the README (#2).

## [0.1.1](https://github.com/zotdotbot/openclaw-otel/releases/tag/v0.1.1) — 2026-06-24

- **Fixed:** `openclaw plugins install` on OpenClaw 2026.5.28 —
  `minHostVersion` now uses the required `>=` semver-floor form; documented
  per-plugin `hooks.allowConversationAccess` (#1).

## [0.1.0](https://github.com/zotdotbot/openclaw-otel/releases/tag/v0.1.0) — 2026-06-24

- Initial public release. Wire schema `1.6.0`.
