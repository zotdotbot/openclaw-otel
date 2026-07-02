// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, expect } from "vitest";

import { hostPackageJsonCandidates, resolveHostVersion } from "../src/host-version";

/** Build a fake install tree under a fresh temp root; returns the root. */
function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-otel-hostver-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  roots.push(root);
  return root;
}
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const openclawPkg = JSON.stringify({ name: "openclaw", version: "2026.6.11" });

describe("hostPackageJsonCandidates", () => {
  it("returns [] for an undefined entry", () => {
    expect(hostPackageJsonCandidates(undefined)).toEqual([]);
  });

  it("walks up from the entry, yielding one package.json candidate per level", () => {
    const cands = hostPackageJsonCandidates("/app/dist/entrypoint.js");
    expect(cands[0]).toBe(join("/app/dist", "package.json"));
    expect(cands).toContain(join("/app", "package.json"));
  });
});

describe("resolveHostVersion", () => {
  it("reads the version from the nearest package.json named 'openclaw'", () => {
    const root = makeTree({
      "package.json": openclawPkg,
      "dist/entry.js": "",
    });
    expect(resolveHostVersion(join(root, "dist/entry.js"))).toBe("2026.6.11");
  });

  it("skips non-openclaw package.json files and keeps walking up", () => {
    // npm-style layout: entry inside node_modules/openclaw, with an unrelated
    // wrapper package.json closer to the entry.
    const root = makeTree({
      "node_modules/openclaw/package.json": openclawPkg,
      "node_modules/openclaw/dist/wrapper/package.json": JSON.stringify({
        name: "some-wrapper",
        version: "9.9.9",
      }),
      "node_modules/openclaw/dist/wrapper/entry.js": "",
    });
    expect(
      resolveHostVersion(join(root, "node_modules/openclaw/dist/wrapper/entry.js")),
    ).toBe("2026.6.11");
  });

  it("returns undefined when no openclaw package.json is found", () => {
    const root = makeTree({
      "package.json": JSON.stringify({ name: "not-openclaw", version: "1.0.0" }),
      "dist/entry.js": "",
    });
    expect(resolveHostVersion(join(root, "dist/entry.js"))).toBeUndefined();
  });

  it("tolerates malformed package.json files (skips, keeps walking)", () => {
    const root = makeTree({
      "package.json": openclawPkg,
      "dist/package.json": "{not json",
      "dist/entry.js": "",
    });
    expect(resolveHostVersion(join(root, "dist/entry.js"))).toBe("2026.6.11");
  });

  it("returns undefined for a matching name with a non-string version", () => {
    const root = makeTree({
      "package.json": JSON.stringify({ name: "openclaw", version: 42 }),
      "entry.js": "",
    });
    expect(resolveHostVersion(join(root, "entry.js"))).toBeUndefined();
  });

  it("returns undefined for an undefined entry (no argv fallback in tests)", () => {
    expect(resolveHostVersion(undefined)).toBeUndefined();
  });
});
