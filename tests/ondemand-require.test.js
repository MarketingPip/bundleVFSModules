import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import MagicString from "magic-string";
import * as acorn from "acorn";

// Worker C verification tests for the on-demand require branch
// (fix/ondemand-require): Worker A unified the sync/async builtin caches,
// Worker B made the transform hoist top-level require() while rewriting
// nested builtin require() to __bvmRequireSync().
//
// Strategy: runtime.js cannot be imported under Node (it wires a demo DOM
// at module scope), so — like tests/sync_require.test.js — these tests
// extract the exact shipped source and evaluate it:
//   Part 1: the REAL transformImportsToLoadModule (verbatim extraction,
//           with the REAL _builtinManifest from runtime.js).
//   Part 2: the REAL __bvmRequireSync (verbatim extraction, balanced-brace
//           scan — the naive /function __bvmRequireSync\(request\) \{[\s\S]*?\n\}/
//           regex truncates at the first inner closing brace).
//   Part 3: structural git assertions (no dist/ changes, no new shim
//           files, template gained only the __bvmRequireSync function).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const RUNTIME_SRC = fs.readFileSync(path.join(REPO_ROOT, "runtime.js"), "utf8");

// --- Verbatim extraction helpers -------------------------------------------

function blockEnd(src, braceIndex) {
  // braceIndex: index of an opening "{". Returns the index just past its
  // matching closing brace (naive scan — sufficient for these extractions;
  // sync_require.test.js uses the same approach for this file).
  let depth = 0;
  for (let i = braceIndex; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("unbalanced braces in runtime.js extraction");
}

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("marker not found in runtime.js: " + marker);
  // Skip past the balanced parameter list first: the first "{" after "("
  // may belong to a default parameter (e.g. `opts = {}`), not the body.
  let p = src.indexOf("(", start);
  let pdepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === "(") pdepth++;
    else if (src[p] === ")") {
      pdepth--;
      if (pdepth === 0) break;
    }
  }
  const brace = src.indexOf("{", p);
  return src.slice(start, blockEnd(src, brace)).replace(/^export\s+/, "");
}

function extractConstBlock(src, marker) {
  // marker like "const _builtinManifest ="; extracts through the matching "};"
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("marker not found in runtime.js: " + marker);
  const brace = src.indexOf("{", start);
  return src.slice(start, blockEnd(src, brace)) + ";";
}

// Minimal walk.simple mirroring acorn-walk's contract (copied from
// tests/sync_require.test.js): the transform attaches parents itself, so we
// only need to avoid following the 'parent' links back up.
const walk = {
  simple(ast, visitors) {
    const seen = new Set();
    (function visit(node) {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (node.type && typeof visitors[node.type] === "function")
        visitors[node.type](node);
      for (const k of Object.keys(node)) {
        if (k === "parent") continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach(visit);
        else visit(v);
      }
    })(ast);
  },
};

let cachedTransform = null;
function loadTransform() {
  if (cachedTransform) return cachedTransform;
  const code =
    extractConstBlock(RUNTIME_SRC, "const _builtinManifest =") +
    "\n" +
    extractFunction(RUNTIME_SRC, "function generateImportBinding(node, liftedVar)") +
    "\n" +
    extractFunction(RUNTIME_SRC, "function transformImportsToLoadModule(");
  const factory = new Function(
    "MagicString",
    "acorn",
    "walk",
    code + "\nreturn { transformImportsToLoadModule, _builtinManifest };",
  );
  cachedTransform = factory(MagicString, acorn, walk);
  return cachedTransform;
}

let cachedBvmSrc = null;
function loadBvmRequireSync() {
  if (!cachedBvmSrc)
    cachedBvmSrc = extractFunction(RUNTIME_SRC, "function __bvmRequireSync(request)");
  const src = cachedBvmSrc;
  return {
    src,
    make: (manifest, cache, requireValue) =>
      new Function(
        "_builtinManifest",
        "_builtinCache",
        "_builtinRequireValue",
        src + "\nreturn __bvmRequireSync;",
      )(manifest, cache, requireValue),
  };
}

function throwCode(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected function to throw, but it did not");
}

// ---------------------------------------------------------------------------
// Part 1 — transform: lazy on-demand require
// ---------------------------------------------------------------------------
describe("transform: on-demand require hoisting", () => {
  test("nested builtin require rewrites to __bvmRequireSync, not a loadModule hoist", () => {
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule(
      "uuid",
      "function t(){ return require('fs'); }",
    );
    expect(out.code).toContain('__bvmRequireSync("fs")');
    expect(out.code).not.toContain('loadModule("fs"');
    expect(out.code).not.toContain("loadModule");
  });

  test("nested builtin require in an arrow function also defers", () => {
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule(
      "uuid",
      "const t = () => require('fs');",
    );
    expect(out.code).toContain('__bvmRequireSync("fs")');
    expect(out.code).not.toContain("loadModule");
  });

  test("node:-prefixed nested builtin require defers via the manifest", () => {
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule(
      "uuid",
      "function t(){ return require('node:fs'); }",
    );
    expect(out.code).toContain('__bvmRequireSync("node:fs")');
    expect(out.code).not.toContain("loadModule");
  });

  test("subpath builtin require defers too", () => {
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule(
      "uuid",
      "async function t(){ return require('fs/promises'); }",
    );
    expect(out.code).toContain('__bvmRequireSync("fs/promises")');
    expect(out.code).not.toContain("loadModule");
  });

  test("require() inside an uncalled function never triggers a module load", () => {
    // Behavioral check of the transform output: defining the transformed
    // function must not touch the loader; only calling it performs the
    // (synchronous, cache-only) require.
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule(
      "uuid",
      "function t(){ return require('fs'); }",
    );
    const calls = [];
    const t = new Function(
      "__bvmRequireSync",
      out.code + "\nreturn t;",
    )((req) => {
      calls.push(req);
      return { fake: true };
    });
    expect(calls).toEqual([]); // definition alone: zero loader interaction
    const ret = t(); // now call it
    expect(calls).toEqual(["fs"]);
    expect(ret).toEqual({ fake: true });
  });

  test("top-level builtin require still hoists to await loadModule", () => {
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule("uuid", "const fs = require('fs');");
    expect(out.code).toContain("await");
    expect(out.code).toContain('loadModule("fs"');
    expect(out.code).not.toContain("__bvmRequireSync");
  });

  test("top-level block require keeps the hoist (runs at init)", () => {
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule(
      "uuid",
      "if (cond) { const fs = require('fs'); }",
    );
    expect(out.code).toContain('loadModule("fs"');
    expect(out.code).not.toContain("__bvmRequireSync");
  });

  test("nested non-builtin require keeps the existing lift", () => {
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule(
      "uuid",
      "function t(){ return require('./x'); }",
    );
    expect(out.code).toContain('loadModule("./x"');
    expect(out.code).not.toContain("__bvmRequireSync");
  });

  test("nested non-builtin require still rewrites the call site (no raw require left)", () => {
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule(
      "uuid",
      "function t(){ return require('./x'); }",
    );
    expect(out.code).not.toContain("require('./x')");
  });
});

// ---------------------------------------------------------------------------
// Part 2 — __bvmRequireSync runtime unit tests (real extracted source)
// ---------------------------------------------------------------------------
describe("__bvmRequireSync", () => {
  const MANIFEST = { fs: "fs.js", "fs/promises": "fs_promises.js" };

  test("throws ERR_REQUIRE_ASYNC_MODULE on cache miss", () => {
    const { make } = loadBvmRequireSync();
    const f = make(MANIFEST, new Map(), (m) => m);
    const err = throwCode(() => f("fs"));
    expect(err.code).toBe("ERR_REQUIRE_ASYNC_MODULE");
    expect(err.message).toContain("[ERR_REQUIRE_ASYNC_MODULE]");
    expect(err.message).toContain("await import('fs')");
  });

  test("returns the cached instance on hit — no duplication", () => {
    const { make } = loadBvmRequireSync();
    const cache = new Map();
    const fakeModule = { readFileSync() {}, tag: "fake-fs-v1" };
    cache.set("fs", fakeModule); // simulate what the loadModule hook writes
    const f = make(MANIFEST, cache, (m) => m);
    expect(f("fs")).toBe(fakeModule);
    expect(f("fs")).toBe(f("fs")); // stable across calls
  });

  test("unified cache: slash-form key written by the loadModule hook resolves", () => {
    const { make } = loadBvmRequireSync();
    const cache = new Map();
    const fakePromises = { readFile() {} };
    cache.set("fs/promises", fakePromises); // Worker A writes slash-form keys
    const f = make(MANIFEST, cache, (m) => m);
    expect(f("fs/promises")).toBe(fakePromises);
  });

  test("node: prefix resolves the same cache entry", () => {
    const { make } = loadBvmRequireSync();
    const cache = new Map();
    const fakeModule = { tag: "fake-fs-v1" };
    cache.set("fs", fakeModule);
    const f = make(MANIFEST, cache, (m) => m);
    expect(f("node:fs")).toBe(fakeModule);
  });

  test("unknown module (not in manifest) throws ERR_REQUIRE_ASYNC_MODULE", () => {
    const { make } = loadBvmRequireSync();
    const f = make(MANIFEST, new Map(), (m) => m);
    const err = throwCode(() => f("definitely-not-a-module"));
    expect(err.code).toBe("ERR_REQUIRE_ASYNC_MODULE");
    expect(err.message).toContain("unknown module");
  });

  test("shipped source uses string-concat only (no backticks — template-literal constraint)", () => {
    const { src } = loadBvmRequireSync();
    expect(src).toContain("function __bvmRequireSync(request)");
    expect(src).not.toContain("`");
    expect(src).not.toContain("${");
  });
});

// ---------------------------------------------------------------------------
// Part 3 — structural: no new shims, template gained only __bvmRequireSync
// ---------------------------------------------------------------------------
describe("structural: no new shims; template gained only __bvmRequireSync", () => {
  test("dist/ is untouched by the branch", () => {
    const out = execSync("git diff --stat main...HEAD -- dist/", {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(out.trim()).toBe("");
  });

  test("no new files outside tests/ — only runtime.js changed", () => {
    const out = execSync("git diff --name-only main...HEAD", {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const files = out
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("tests/"));
    expect(files).toEqual(["runtime.js"]);
  });

  test("the only new function declaration in the diff is __bvmRequireSync", () => {
    const out = execSync("git diff main...HEAD -- runtime.js", {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const addedFns = out
      .split("\n")
      .filter((l) => l.startsWith("+function "));
    expect(addedFns).toEqual(["+function __bvmRequireSync(request) {"]);
  });

  test("no new import statements added to runtime.js", () => {
    const out = execSync("git diff main...HEAD -- runtime.js", {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const addedImports = out
      .split("\n")
      .filter((l) => l.startsWith("+import "));
    expect(addedImports).toEqual([]);
  });
});
