// Regression tests for Vitest E2E gap #6: `node:`-prefixed dynamic imports
// not recognized as builtins.
//
// The probe (2026-09-28) ran `await import('node:child_process')` in entry
// code and got `400 https://esm.sh/node:child_process`. The sandbox-side
// loader's `isStrippable` check only covered builtins whose listed names
// literally contain `node:` (node:sea, node:sqlite, node:test,
// node:test/reporters), so every other `node:X` specifier fell through to
// the esm.sh CDN path. Node treats `node:X` and `X` identically for every
// builtin — the runtime must too.
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

function extractBlock(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1)
    throw new Error("start marker not found in runtime.js: " + startMarker);
  const end = src.indexOf(endMarker, start);
  if (end === -1)
    throw new Error("end marker not found in runtime.js: " + endMarker);
  return src.slice(start, end);
}

// Representative builtin list mirroring the shape of the real
// `builtinModules` in runtime.js: mostly bare names, a few literal
// `node:`-prefixed entries, and the RUNTIME: special key.
const NODE_BUILTINS = [
  "child_process",
  "fs",
  "fs/promises",
  "test",
  "node:sea",
  "node:sqlite",
  "node:test",
  "node:test/reporters",
  "RUNTIME:NODE_GLOBALS",
];

function loadNormalizer() {
  const code = extractBlock(
    RUNTIME_SRC,
    "// --- begin node: builtin normalization (gap #6) ---",
    "// --- end node: builtin normalization (gap #6) ---",
  );
  const factory = new Function(code + "\nreturn normalizeBuiltinSpecifier;");
  return factory();
}

describe("normalizeBuiltinSpecifier (gap #6)", () => {
  test("node:child_process is recognized as the child_process builtin", () => {
    const normalize = loadNormalizer();
    expect(normalize("node:child_process", NODE_BUILTINS)).toEqual({
      isNodeBuiltIn: true,
      modulePath: "child_process",
    });
  });

  test("node:fs and node:fs/promises normalize to their bundle keys", () => {
    const normalize = loadNormalizer();
    expect(normalize("node:fs", NODE_BUILTINS)).toEqual({
      isNodeBuiltIn: true,
      modulePath: "fs",
    });
    expect(normalize("node:fs/promises", NODE_BUILTINS)).toEqual({
      isNodeBuiltIn: true,
      modulePath: "fs_promises",
    });
  });

  test("bare builtin names still resolve unchanged", () => {
    const normalize = loadNormalizer();
    expect(normalize("child_process", NODE_BUILTINS)).toEqual({
      isNodeBuiltIn: true,
      modulePath: "child_process",
    });
  });

  test("legacy node:-prefixed list entries keep their old mapping", () => {
    const normalize = loadNormalizer();
    expect(normalize("node:test", NODE_BUILTINS)).toEqual({
      isNodeBuiltIn: true,
      modulePath: "test",
    });
    expect(normalize("node:test/reporters", NODE_BUILTINS)).toEqual({
      isNodeBuiltIn: true,
      modulePath: "test_reporters",
    });
    expect(normalize("node:sea", NODE_BUILTINS)).toEqual({
      isNodeBuiltIn: true,
      modulePath: "sea",
    });
  });

  test("RUNTIME:NODE_GLOBALS keeps its RUNTIME_ mapping", () => {
    const normalize = loadNormalizer();
    expect(normalize("RUNTIME:NODE_GLOBALS", NODE_BUILTINS)).toEqual({
      isNodeBuiltIn: true,
      modulePath: "RUNTIME_NODE_GLOBALS",
    });
  });

  test("non-builtins pass through untouched", () => {
    const normalize = loadNormalizer();
    expect(normalize("./foo.js", NODE_BUILTINS)).toEqual({
      isNodeBuiltIn: false,
      modulePath: "./foo.js",
    });
    expect(normalize("vite", NODE_BUILTINS)).toEqual({
      isNodeBuiltIn: false,
      modulePath: "vite",
    });
    expect(normalize("node:nonexistent", NODE_BUILTINS)).toEqual({
      isNodeBuiltIn: false,
      modulePath: "node:nonexistent",
    });
    expect(normalize("https://esm.sh/react", NODE_BUILTINS)).toEqual({
      isNodeBuiltIn: false,
      modulePath: "https://esm.sh/react",
    });
  });
});

describe("ImportResolver builtin pass-through wiring (gap #6, generalized by gap #5)", () => {
  test("_transformSource guards recognized builtins before the CDN fallback", () => {
    // The guard delegates to normalizeBuiltinSpecifier (unit-tested above);
    // this pins the wiring so a future edit cannot silently drop the guard
    // and reintroduce the esm.sh 400 (gap #6) or the esm.sh shim
    // substitution (gap #5). Gap #5 generalized the guard from
    // `node:`-prefixed to all recognized builtins (Node treats `node:X`
    // and `X` identically). Behavioral coverage lives in
    // tests/sync_require_bare_builtins.test.js; the iframe probe is the
    // real proof.
    const start = RUNTIME_SRC.indexOf("_transformSource(source, kind) {");
    expect(start).not.toBe(-1);
    const fallback = RUNTIME_SRC.indexOf("this.cdnBase}", start);
    expect(fallback).not.toBe(-1);
    const guardRe =
      /normalizeBuiltinSpecifier\(\s*transformed\s*,\s*builtinModules\s*,?\s*\)/g;
    guardRe.lastIndex = start;
    const guardMatch = guardRe.exec(RUNTIME_SRC);
    expect(guardMatch).not.toBeNull();
    const guardCall = guardMatch.index;
    expect(guardCall).toBeLessThan(fallback);
    expect(RUNTIME_SRC.slice(guardCall, fallback)).toContain("isNodeBuiltIn");
  });
});
