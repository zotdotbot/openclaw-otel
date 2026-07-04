# OpenClaw compatibility

Verified live on **OpenClaw 2026.5.28** (production baseline) and
source-compatible through **2026.6.10** (latest). **Recommended: 2026.6.5+**,
where `openclaw plugins install` runs with no install flag. Older hosts run the
plugin with documented, graceful degradation — nothing crashes anywhere in the
range.

| OpenClaw | Support | Notes |
| --- | --- | --- |
| **2026.6.5 – 2026.6.10** | ✅ **Recommended** | Native `openclaw plugins install` is flag-free (install scanner removed at 6.5). Core + heartbeat + cron all work. |
| 2026.5.28 – 2026.6.4 | ✅ Supported | Live-verified baseline (2026.5.28). All telemetry works. Install scanner still active → `openclaw plugins install` may need `--dangerously-force-unsafe-install`, or use `npm install` + manual config. |
| 2026.4.29 – 2026.5.27 | ◐ Source-compatible¹ | All features present (core, heartbeat, cron). Same install caveat. |
| 2026.4.27 – 2026.4.28 | ◐ Core + heartbeat¹ | Accurate token/cost rollups + heartbeat; cron telemetry needs ≥ 2026.4.29. |
| 2026.4.21 – 2026.4.26 | ◐ Core, degraded¹ | Traces / metrics / logs emit, but token/cost is approximate (accurate path needs 2026.4.27) and per-model-call spans need 2026.4.25. No heartbeat/cron. |
| `< 2026.4.21` | ✗ Unsupported | Below the analyzed floor. |

¹ Source-analysis compatible (symbol/signature presence at each OpenClaw release
tag), not runtime-tested below 2026.5.28. Graceful degradation is the rule — a
missing host surface means a missing span/metric or a no-op opt-in, never a
gateway crash.
