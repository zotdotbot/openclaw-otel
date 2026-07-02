// SPDX-License-Identifier: Apache-2.0

/**
 * Best-effort resolution of the HOST OpenClaw gateway version, stamped on the
 * Resource as `openclaw.version`. The plugin SDK exposes no host version, so we
 * locate the host's `package.json` the same way the diagnostics module locates
 * internal SDK barrels (see `pluginSdkRuntimeCandidates` in diagnostics.ts):
 * walk up from the gateway entry (`process.argv[1]`, a shared process). Any
 * failure degrades to `undefined` — the attribute is simply omitted.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The npm package name the host's package.json must carry to be trusted as
 *  the gateway. A wrapper/fork with a different name yields no stamp rather
 *  than a wrong one. */
const HOST_PACKAGE_NAME = "openclaw";

/**
 * Absolute-path `package.json` candidates, nearest-first, derived from the
 * gateway entry. Mirrors the 5-level walk of `pluginSdkRuntimeCandidates`.
 * Exported for testing.
 */
export function hostPackageJsonCandidates(entry: string | undefined): string[] {
  if (!entry) return [];
  let real: string;
  try {
    real = realpathSync(resolve(entry));
  } catch {
    real = resolve(entry);
  }
  const out: string[] = [];
  let dir = dirname(real);
  for (let i = 0; i < 5 && dir && dir !== dirname(dir); i++) {
    out.push(join(dir, "package.json"));
    dir = dirname(dir);
  }
  return out;
}

/**
 * The host gateway's version, from the nearest ancestor `package.json` whose
 * `name` is exactly `openclaw`. Non-matching or malformed files are skipped
 * (the entry may sit under a wrapper package); `undefined` when nothing
 * matches. Callers pass `process.argv[1]`.
 */
export function resolveHostVersion(entry: string | undefined): string | undefined {
  for (const cand of hostPackageJsonCandidates(entry)) {
    if (!existsSync(cand)) continue;
    try {
      const pkg = JSON.parse(readFileSync(cand, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        pkg.name === HOST_PACKAGE_NAME &&
        typeof pkg.version === "string" &&
        pkg.version.length > 0
      ) {
        return pkg.version;
      }
    } catch {
      /* unreadable/malformed — keep walking */
    }
  }
  return undefined;
}
