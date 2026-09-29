// Regression test: _dynamic_import must not ship the whole VFS across postMessage.
//
// Background (2026-09-29, vite7-browser M3): booting the browser sandbox
// stalled for minutes before user code ran. Root cause: every
// `_dynamic_import` interop call posted the entire __USER_FILES__ seed
// (~22MB with the WASM shims) through postMessage, structured-cloned per
// call. ~30 eager builtin preloads x ~7s clone each = multi-minute
// bootstrap. The iframe copy is never mutated at runtime (fs writes land
// in the memfs Volume, not __USER_FILES__), so it is always identical to
// the host's config.fs.
//
// The platform fix: the sandbox no longer ships the seed across the
// boundary; the host serves _dynamic_import from its own config.fs.
// pickDynamicImportVfs is the named decision point. It is extracted from
// runtime.js like the other vite7 tests (runtime.js wires a demo DOM at
// module scope and cannot be imported under Node).

import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);

function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("function not found: " + name);
  let fnStart = start;
  const before = src.slice(Math.max(0, start - 8), start);
  if (before.endsWith("export ")) fnStart = start - 7;
  let p = src.indexOf("(", start);
  let pdepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === "(") pdepth++;
    else if (src[p] === ")") {
      pdepth--;
      if (pdepth === 0) break;
    }
  }
  let b = src.indexOf("{", p);
  let bdepth = 0;
  for (; b < src.length; b++) {
    if (src[b] === "{") bdepth++;
    else if (src[b] === "}") {
      bdepth--;
      if (bdepth === 0) return src.slice(fnStart, b + 1);
    }
  }
  throw new Error("unbalanced braces for: " + name);
}

// Minimal unflatten mirroring the host's: '/a/b.js' -> { a: { 'b.js': v } }.
function testUnflatten(flatObj) {
  const result = {};
  for (const [rawPath, value] of Object.entries(flatObj || {})) {
    const parts = String(rawPath).replace(/^\/+/, "").split("/");
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part] || typeof current[part] !== "object")
        current[part] = {};
      current = current[part];
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

const pickDynamicImportVfs = new Function(
  `${extractFunction(RUNTIME_SRC, "pickDynamicImportVfs")}; return pickDynamicImportVfs;`,
)();

describe("pickDynamicImportVfs (host _dynamic_import VFS selection)", () => {
  test("serves from the host seed when the sandbox passes nothing", () => {
    const hostSeed = { "/node_modules/a/index.js": "AAA" };
    const tree = pickDynamicImportVfs(undefined, hostSeed, testUnflatten);
    expect(tree).toEqual({ node_modules: { a: { "index.js": "AAA" } } });
  });

  test("falls back to an explicitly passed VFS when the host has no seed", () => {
    const passed = { "/b.js": "BBB" };
    const tree = pickDynamicImportVfs(passed, {}, testUnflatten);
    expect(tree).toEqual({ "b.js": "BBB" });
  });

  test("prefers the host seed over a passed VFS", () => {
    const tree = pickDynamicImportVfs(
      { "/b.js": "BBB" },
      { "/a.js": "AAA" },
      testUnflatten,
    );
    expect(tree).toEqual({ "a.js": "AAA" });
  });

  test("empty everything yields an empty tree, never throws", () => {
    expect(pickDynamicImportVfs(undefined, undefined, testUnflatten)).toEqual(
      {},
    );
  });
});

describe("sandbox _dynamic_import call sites", () => {
  test("no callParent('_dynamic_import', ...) ships the seed across postMessage", () => {
    const calls = [
      ...RUNTIME_SRC.matchAll(/callParent\(\s*'_dynamic_import'([\s\S]*?)\);/g),
    ];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c[1]).not.toMatch(/__USER_FILES__/);
      expect(c[1]).not.toMatch(/\bbvmVfs\b/);
      expect(c[1]).not.toMatch(/,\s*vfs\s*$/);
    }
  });
});
