// SPDX-License-Identifier: Apache-2.0
//
// Packaging-contract tests. These guard the invariants that make the PUBLISHED
// artifact correct and trivially installable — the whole premise of this clean
// build. They are deliberately fast and I/O-light (they only read manifest
// files), so they belong in the unit suite. The end-to-end proof that the
// packed tarball actually installs and loads with no runtime deps present lives
// in `scripts/verify-package.mjs`, run as its own CI job.
//
// What would silently break a release that these catch:
//   - a runtime `dependencies` entry creeping in (kills the zero-dep install)
//   - `main` / `openclaw.extensions` / `files` drifting out of agreement so the
//     tarball ships without its own entry point
//   - the version skewing across package.json, the plugin manifest, and the
//     baked-in `service.version`

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { PLUGIN_VERSION, PLUGIN_ID } from "../src/version";
import { parseConfig } from "../src/config";

const root = new URL("../", import.meta.url);
const readJson = (rel: string) =>
  JSON.parse(readFileSync(new URL(rel, root), "utf8"));

const pkg = readJson("package.json");
const manifest = readJson("openclaw.plugin.json");

const ENTRY = "./dist/index.js";

describe("zero runtime dependencies", () => {
  it("declares no `dependencies` (every OTel package is bundled at build time)", () => {
    // The headline guarantee: `npm install @zotdotbot/openclaw-otel` pulls nothing
    // else. Adding a single runtime dep silently reintroduces the
    // node_modules/symlink/peer friction this rewrite exists to remove.
    const deps = pkg.dependencies ?? {};
    expect(Object.keys(deps)).toEqual([]);
  });

  it("keeps the OTel SDK as devDependencies only", () => {
    expect(Object.keys(pkg.devDependencies)).toEqual(
      expect.arrayContaining(["@opentelemetry/sdk-trace-node", "esbuild"]),
    );
  });
});

describe("published entry point", () => {
  it("agrees on the single bundled entry across main, exports, and openclaw.extensions", () => {
    // The OpenClaw entry point is declared by package.json's `openclaw.extensions`
    // (openclaw.plugin.json carries id/config/UI metadata, not the entry file).
    expect(pkg.main).toBe(ENTRY);
    expect(pkg.exports?.["."]).toBe(ENTRY);
    expect(pkg.openclaw?.extensions?.[0]).toBe(ENTRY);
  });

  it("ships dist plus the docs/manifest/license, and nothing source-shaped", () => {
    const files: string[] = pkg.files;
    expect(files).toEqual(
      expect.arrayContaining([
        "dist/",
        "openclaw.plugin.json",
        "CONTRACT.md",
        "README.md",
        "LICENSE",
      ]),
    );
    // Source, tests, and build tooling must never end up in the tarball.
    for (const leak of ["src", "src/", "tests", "tests/", "scripts", "scripts/"]) {
      expect(files).not.toContain(leak);
    }
  });
});

describe("version and identity stay in sync", () => {
  it("pins one version across package.json, the manifest, and service.version", () => {
    expect(pkg.version).toBe(PLUGIN_VERSION);
    expect(manifest.version).toBe(PLUGIN_VERSION);
  });

  it("pins one plugin id across the manifest and the baked-in identity", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(PLUGIN_ID).toBe("openclaw-otel");
  });
});

describe("manifest config schema ↔ parser parity", () => {
  // The gateway validates plugins.entries.<id>.config against the manifest's
  // configSchema BEFORE the plugin loads, and the schema is additionalProperties:
  // false — so any key the parser accepts but the manifest omits makes the WHOLE
  // gateway refuse to start (a crash loop, not a soft warning). This caught the
  // real 1.6.0 incident where `heartbeat` reached parseConfig but not the manifest.
  it("declares additionalProperties:false (a closed schema the parser must match)", () => {
    expect(manifest.configSchema.additionalProperties).toBe(false);
  });

  it("declares every top-level config key parseConfig accepts", () => {
    const declared = new Set(Object.keys(manifest.configSchema.properties));
    // parseConfig({}) emits every always-present field; sampleRate is the lone
    // field omitted unless explicitly set, so include it.
    const accepted = new Set([...Object.keys(parseConfig({})), "sampleRate"]);
    const missing = [...accepted].filter((k) => !declared.has(k));
    expect(missing).toEqual([]);
  });
});

describe("publish wiring", () => {
  it("is Apache-2.0 and ships the LICENSE", () => {
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.files).toContain("LICENSE");
  });

  it("scopes publish access explicitly (so a scoped package is never made public by accident)", () => {
    expect(pkg.publishConfig?.access).toBeDefined();
  });

  it("rebuilds the bundle before publish and exposes the install smoke test", () => {
    expect(pkg.scripts.prepublishOnly).toBe("npm run build");
    // The offline pack→install→import proof, wired into CI.
    expect(pkg.scripts["verify:package"]).toBeTruthy();
  });
});
