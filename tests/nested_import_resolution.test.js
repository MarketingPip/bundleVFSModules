// Regression tests for Vitest E2E gap #1: nested relative imports lost their
// resolved VFS base at import depth ≥2.
//
// Root cause chain (probe 2026-09-28, real Vitest 5.0.2):
//  1. `_build_file` passed the UNRESOLVED request path (e.g.
//     './chunks/cli-api.DL4Bd7Vh.js') as `fileName` into
//     `transformImportsToLoadModule`, whose 3rd param becomes the nested
//     import's `entryPoint` — so at depth ≥2 the `node_modules/vitest/dist/`
//     prefix was lost and the import 404'd.
//  2. `toVFSPath` unconditionally re-joined an already-resolved entryPoint
//     against the parent dir, doubling it:
//     'node_modules/vitest/dist/' + 'node_modules/vitest/dist/chunks/x.js'.
//
// Fix contract: `toVFSPath` is idempotent — an already-resolved VFS path (no
// leading ./ or ../) is returned as-is; and `_dynamic_import` returns
// `{ source, resolvedPath }` so the sandbox threads the resolved path into
// `_build_file` (acceptance: the true E2E probe re-run).
//
// runtime.js cannot be imported under Node (demo DOM at module scope), so —
// like tests/sync_require.test.js — these tests extract the exact shipped
// source and evaluate it.

import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1)
    throw new Error("marker not found in runtime.js: " + marker);
  let p = src.indexOf("(", start);
  let pdepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === "(") pdepth++;
    else if (src[p] === ")") {
      pdepth--;
      if (pdepth === 0) break;
    }
  }
  let i = src.indexOf("{", p);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error("unbalanced braces extracting: " + marker);
  return src.slice(start, i + 1).replace(/^export\s+/, "");
}

function loadToVFSPath() {
  const code = extractFunction(RUNTIME_SRC, "function toVFSPath(");
  const factory = new Function(code + "\nreturn toVFSPath;");
  return factory();
}

describe("toVFSPath idempotency (gap #1)", () => {
  test("already-resolved VFS path is NOT re-joined against the parent dir", () => {
    const toVFSPath = loadToVFSPath();
    // The doubling bug: 'node_modules/vitest/dist/' + 'node_modules/vitest/dist/chunks/x.js'
    expect(
      toVFSPath(
        "node_modules/vitest/dist/chunks/cli-api.DL4Bd7Vh.js",
        "node_modules/vitest/dist/cli.js",
      ),
    ).toBe("node_modules/vitest/dist/chunks/cli-api.DL4Bd7Vh.js");
  });

  test("relative request path still resolves against the importer dir", () => {
    const toVFSPath = loadToVFSPath();
    expect(
      toVFSPath("./chunks/cli-api.js", "node_modules/vitest/dist/cli.js"),
    ).toBe("node_modules/vitest/dist/chunks/cli-api.js");
  });

  test("../ segments still pop correctly", () => {
    const toVFSPath = loadToVFSPath();
    expect(
      toVFSPath("../shared/x.js", "node_modules/vitest/dist/chunks/cli.js"),
    ).toBe("node_modules/vitest/dist/shared/x.js");
  });

  test("top-level relative entry with no parent resolves to VFS root", () => {
    const toVFSPath = loadToVFSPath();
    expect(toVFSPath("./node_modules/vitest/dist/cli.js", null)).toBe(
      "node_modules/vitest/dist/cli.js",
    );
  });

  test("bare top-level file name is returned as-is", () => {
    const toVFSPath = loadToVFSPath();
    expect(toVFSPath("entry.js", null)).toBe("entry.js");
  });
});

describe("_dynamic_import returns resolvedPath (gap #1 threading)", () => {
  test("live handler returns { source, resolvedPath }, not a bare string", () => {
    // The second registerInterop('_dynamic_import', ...) wins; find it and
    // assert its return statements carry the resolved path. This locks the
    // contract the sandbox loader depends on (importResult.resolvedPath).
    // NOTE: matched with a whitespace/quote-tolerant regex so prettier
    // reformatting (arg wrapping, quote style) cannot break the pin.
    const hits = [
      ...RUNTIME_SRC.matchAll(/registerInterop\(\s*["']_dynamic_import["']/g),
    ];
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const first = hits[0].index;
    const live = hits[1].index;
    expect(live).toBeGreaterThan(first);
    const handlerSrc = RUNTIME_SRC.slice(live, live + 4000);
    expect(handlerSrc).toMatch(/return\s*\{\s*source:[^}]*resolvedPath/);
  });
});
