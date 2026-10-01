// Regression tests for Vitest E2E gap #5: user-code sync
// `require('child_process')` (and bare `import('fs')`) fell through to the
// esm.sh CDN fallback instead of resolving to our dist builtin shims.
//
// The probe (2026-09-28) ran `import('fs')` in entry code and got
// `404 https://esm.sh/fs`; the same ImportResolver path rewrites entry
// `require('child_process')` to `require('https://esm.sh/child_process')`.
// Gap #6 fixed this for `node:`-prefixed specifiers; bare builtin names
// were deliberately left alone. Node treats `node:X` and `X` identically,
// so the entry transform must too: recognized builtins (bare or prefixed)
// pass through to the sandbox builtin interop pipeline, non-builtins keep
// the CDN fallback.
//
// runtime.js cannot be imported under Node (demo DOM at module scope), so —
// like tests/sync_require.test.js — these tests extract the exact shipped
// source and evaluate it.

import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The interception table is pure specifier->VFS-path (no browser deps), so
// the real one is injected into the extracted ImportResolver below.
import { lookupNativeInterception } from "../src/browser-builds.js";

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
// `builtinModules` in runtime.js (bare names + legacy node:-prefixed
// entries + the RUNTIME: special key).
const NODE_BUILTINS = [
  "child_process",
  "fs",
  "fs/promises",
  "assert/strict",
  "node:sea",
  "node:sqlite",
  "node:test",
  "node:test/reporters",
  "RUNTIME:NODE_GLOBALS",
];

function loadImportResolver() {
  const normalizeSrc = extractBlock(
    RUNTIME_SRC,
    "// --- begin node: builtin normalization (gap #6) ---",
    "// --- end node: builtin normalization (gap #6) ---",
  );
  let clsSrc = extractBlock(
    RUNTIME_SRC,
    "export class ImportResolver {",
    "// EXECUTION CONTEXT MODULE",
  );
  clsSrc = clsSrc.replace(
    "export class ImportResolver {",
    "class ImportResolver {",
  );
  const factory = new Function(
    "builtinModules",
    "lookupNativeInterception",
    normalizeSrc + "\n" + clsSrc + "\nreturn ImportResolver;",
  );
  return factory(NODE_BUILTINS, lookupNativeInterception);
}

function makeResolver() {
  const ImportResolver = loadImportResolver();
  // fallbackCDN: true is the production default (runtime.js instantiates
  // with `options.fallbackCDN ?? true`).
  return new ImportResolver({ fallbackCDN: true });
}

describe("ImportResolver bare-builtin routing (gap #5)", () => {
  test("sync require('child_process') is not CDN-mangled", () => {
    const r = makeResolver();
    expect(r._transformSource("child_process", "require")).toBe(
      "child_process",
    );
  });

  test("bare import('fs') is not CDN-mangled", () => {
    const r = makeResolver();
    expect(r._transformSource("fs", "import")).toBe("fs");
    expect(r._transformSource("fs", "dynamic-import")).toBe("fs");
  });

  test("bare subpath builtins pass through (assert/strict)", () => {
    const r = makeResolver();
    expect(r._transformSource("assert/strict", "require")).toBe(
      "assert/strict",
    );
  });

  test("node:-prefixed builtins keep their gap-#6 pass-through", () => {
    const r = makeResolver();
    expect(r._transformSource("node:child_process", "require")).toBe(
      "node:child_process",
    );
    expect(r._transformSource("node:fs", "dynamic-import")).toBe("node:fs");
  });

  test("RUNTIME:NODE_GLOBALS passes through", () => {
    const r = makeResolver();
    expect(r._transformSource("RUNTIME:NODE_GLOBALS", "import")).toBe(
      "RUNTIME:NODE_GLOBALS",
    );
  });

  test("non-builtin bare specifiers keep the CDN fallback", () => {
    const r = makeResolver();
    expect(r._transformSource("vite", "import")).toBe("https://esm.sh/vite");
    expect(r._transformSource("lodash-es", "require")).toBe(
      "https://esm.sh/lodash-es",
    );
  });

  test("unrecognized node: specifiers keep the old CDN fallback", () => {
    const r = makeResolver();
    expect(r._transformSource("node:nonexistent", "import")).toBe(
      "https://esm.sh/node:nonexistent",
    );
  });

  test("relative paths and absolute URLs are untouched", () => {
    const r = makeResolver();
    expect(r._transformSource("./foo.js", "require")).toBe("./foo.js");
    expect(r._transformSource("../bar.js", "import")).toBe("../bar.js");
    expect(r._transformSource("https://esm.sh/react", "import")).toBe(
      "https://esm.sh/react",
    );
  });
});

describe("ImportResolver native-package interception (platform, rule 6)", () => {
  // 2026-10-01: entry `import { rolldown } from "rolldown"` was rewritten
  // to https://esm.sh/rolldown by the CDN fallback BEFORE the interception
  // table was consulted. The browser fetched esm.sh's build of the NATIVE
  // package, whose esm.sh-style `/node/process.mjs` builtin imports died
  // as absolute VFS paths in the esms resolve hook:
  // `[bvm:resolve] _dynamic_import failed for file URL "/node/process.mjs"`.
  // The interception table must win over the CDN fallback at the entry
  // layer too (nested imports already go through it via _dynamic_import).
  test("entry import 'rolldown' resolves to the VFS browser build", () => {
    const r = makeResolver();
    expect(r._transformSource("rolldown", "import")).toBe(
      "/node_modules/@rolldown/browser/dist/index.browser.mjs",
    );
    expect(r._transformSource("rolldown", "dynamic-import")).toBe(
      "/node_modules/@rolldown/browser/dist/index.browser.mjs",
    );
  });

  test("entry import 'rolldown/experimental' resolves to its dist file", () => {
    const r = makeResolver();
    expect(r._transformSource("rolldown/experimental", "import")).toBe(
      "/node_modules/@rolldown/browser/dist/experimental-index.browser.mjs",
    );
  });

  test("entry import 'rollup' resolves to the VFS browser build", () => {
    const r = makeResolver();
    expect(r._transformSource("rollup", "import")).toBe(
      "/node_modules/@rollup/browser/dist/es/rollup.browser.js",
    );
  });

  test("entry import 'esbuild' resolves to the esbuild-wasm shim", () => {
    const r = makeResolver();
    expect(r._transformSource("esbuild", "import")).toBe(
      "/node_modules/.bvm/esbuild-shim.cjs",
    );
  });

  test("non-intercepted bare specifiers still fall back to the CDN", () => {
    const r = makeResolver();
    expect(r._transformSource("vite", "import")).toBe("https://esm.sh/vite");
  });
});
