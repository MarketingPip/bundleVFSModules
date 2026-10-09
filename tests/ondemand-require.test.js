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
// The sandbox template now lives in src/sandbox-template.js; extract the
// template VALUE (JSON-decode the exported string) for template extractions.
const TEMPLATE_FILE = fs.readFileSync(
  path.join(REPO_ROOT, "src", "sandbox-template.js"),
  "utf8",
);
const TEMPLATE_SRC = JSON.parse(
  TEMPLATE_FILE.match(
    /export const SANDBOX_TEMPLATE = ("(?:[^"\\]|\\.)*");/s,
  )[1],
);

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
  if (start === -1)
    throw new Error("marker not found in runtime.js: " + marker);
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
  if (start === -1)
    throw new Error("marker not found in runtime.js: " + marker);
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
    extractFunction(
      RUNTIME_SRC,
      "function generateImportBinding(node, liftedVar)",
    ) +
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
    cachedBvmSrc =
      // _bvmRequirePending is a template-scope var in the real generated
      // script (declared next to _builtinCache); the extracted function
      // references it, so the harness provides it. The cold path calls
      // globalThis._RUNTIME_.loadModule (the bare loadModule binding is not
      // reliably resolvable in the es-module-shims-executed sandbox); the
      // harness shadows globalThis with a fake carrying the injected loader.
      "var _bvmRequirePending = new Map();\n" +
      extractFunction(TEMPLATE_SRC, "function __bvmRequireSync(request)");
  const src = cachedBvmSrc;
  return {
    src,
    make: (manifest, cache, requireValue, loadModule) => {
      const fakeGlobal = {
        _RUNTIME_: {
          loadModule:
            loadModule ||
            (() => Promise.reject(new Error("loadModule unexpectedly called"))),
        },
      };
      return new Function(
        "globalThis",
        "_builtinManifest",
        "_builtinCache",
        "_builtinRequireValue",
        src + "\nreturn __bvmRequireSync;",
      )(fakeGlobal, manifest, cache, requireValue);
    },
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
    const t = new Function("__bvmRequireSync", out.code + "\nreturn t;")(
      (req) => {
        calls.push(req);
        return { fake: true };
      },
    );
    expect(calls).toEqual([]); // definition alone: zero loader interaction
    const ret = t(); // now call it
    expect(calls).toEqual(["fs"]);
    expect(ret).toEqual({ fake: true });
  });

  test("top-level builtin require still hoists to await loadModule", () => {
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule(
      "uuid",
      "const fs = require('fs');",
    );
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

  test("dynamic require(moduleName) rewrites the callee to __bvmRequireSync", () => {
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule(
      "uuid",
      "function t(){ return require(name); }",
    );
    expect(out.code).toContain("__bvmRequireSync(name)");
    expect(out.code).not.toContain("loadModule");
  });

  test("top-level dynamic require(moduleName) also defers to __bvmRequireSync", () => {
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule(
      "uuid",
      "const x = require(name);",
    );
    expect(out.code).toContain("__bvmRequireSync(name)");
    expect(out.code).not.toContain("loadModule");
  });

  test("dynamic require with a template literal defers too", () => {
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule(
      "uuid",
      "function t(){ return require(`fs`); }",
    );
    expect(out.code).toContain("__bvmRequireSync(`fs`)");
  });

  test("bare require() with no arguments is left alone", () => {
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule("uuid", "require();");
    expect(out.code).toContain("require()");
    expect(out.code).not.toContain("__bvmRequireSync");
  });

  test("preserveRequireCalls still leaves dynamic require() intact (CJS build)", () => {
    const { transformImportsToLoadModule } = loadTransform();
    const out = transformImportsToLoadModule(
      "uuid",
      "function t(){ return require(name); }",
      null,
      null,
      {
        preserveRequireCalls: true,
      },
    );
    expect(out.code).toContain("require(name)");
    expect(out.code).not.toContain("__bvmRequireSync");
  });
});

// ---------------------------------------------------------------------------
// Part 2 — __bvmRequireSync runtime unit tests (real extracted source)
// ---------------------------------------------------------------------------
describe("__bvmRequireSync", () => {
  const MANIFEST = { fs: "fs.js", "fs/promises": "fs_promises.js" };

  test("cold builtin returns a promise for the module instead of throwing", async () => {
    // Lazy-on-call: a synchronous require() cannot block the event loop on
    // the async loader, so the cold call triggers loadModule() and returns
    // its promise. The caller awaits it; the loadModule _builtinCache hook
    // makes later calls synchronous.
    const { make } = loadBvmRequireSync();
    const fakeModule = { parse() {}, tag: "fake-qs-v1" };
    const seen = [];
    const fakeLoadModule = (req) => {
      seen.push(req);
      return Promise.resolve(fakeModule);
    };
    const f = make(MANIFEST, new Map(), (m) => m, fakeLoadModule);
    const ret = f("fs");
    expect(ret && typeof ret.then).toBe("function"); // a promise, not a throw
    expect(seen).toEqual(["fs"]); // the load was triggered by the call
    expect(await ret).toEqual(fakeModule);
  });

  test("cold require applies the same _builtinRequireValue unwrap as the warm path", async () => {
    const { make } = loadBvmRequireSync();
    // class default (like events.js): sync require returns the class itself
    class FakeEmitter {}
    const ns = { default: FakeEmitter, extra: 1 };
    const f = make(
      MANIFEST,
      new Map(),
      (mod) => (mod && typeof mod.default === "function" ? mod.default : mod),
      () => Promise.resolve(ns),
    );
    expect(await f("fs")).toBe(FakeEmitter);
  });

  test("concurrent cold requires share one loadModule call and one instance", async () => {
    const { make } = loadBvmRequireSync();
    const fakeModule = { tag: "shared" };
    let calls = 0;
    const fakeLoadModule = () => {
      calls++;
      return new Promise((resolve) =>
        setTimeout(() => resolve(fakeModule), 10),
      );
    };
    const f = make(MANIFEST, new Map(), (m) => m, fakeLoadModule);
    const p1 = f("fs");
    const p2 = f("fs");
    expect(p2).toBe(p1); // same cached promise, not a second load
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(r1).toBe(r2);
    expect(r1).toEqual(fakeModule);
  });

  test("failed cold load clears the pending entry: the next call retries", async () => {
    const { make } = loadBvmRequireSync();
    const fakeModule = { tag: "retry-ok" };
    let calls = 0;
    const fakeLoadModule = () => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(fakeModule);
    };
    const f = make(MANIFEST, new Map(), (m) => m, fakeLoadModule);
    await expect(f("fs")).rejects.toThrow("boom");
    expect(calls).toBe(1);
    await expect(f("fs")).resolves.toEqual(fakeModule); // retried, not a cached rejection
    expect(calls).toBe(2);
  });

  test("node:-prefixed cold require loads under the same pending key", async () => {
    const { make } = loadBvmRequireSync();
    const fakeModule = { tag: "node-prefixed" };
    const seen = [];
    const fakeLoadModule = (req) => {
      seen.push(req);
      return Promise.resolve(fakeModule);
    };
    const f = make(MANIFEST, new Map(), (m) => m, fakeLoadModule);
    const p1 = f("node:fs");
    const p2 = f("fs");
    expect(p2).toBe(p1); // bare and node:-prefixed share the manifest key
    expect(await p1).toEqual(fakeModule);
    expect(seen).toEqual(["node:fs"]);
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

  test("non-string request throws ERR_REQUIRE_ASYNC_MODULE without crashing", () => {
    const { make } = loadBvmRequireSync();
    const f = make(MANIFEST, new Map(), (m) => m);
    for (const bad of [123, null, undefined]) {
      const err = throwCode(() => f(bad));
      expect(err.code).toBe("ERR_REQUIRE_ASYNC_MODULE");
    }
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
  // NOTE: these tests diff against origin/main (the PR base), not the local
  // `main` branch — the local branch layout does not survive rebasing, but
  // the PR base is stable. They are skipped when the diff is empty (i.e.
  // running on main itself post-merge), where there is no branch footprint
  // to guard.
  const diffBase = "origin/main...HEAD";

  test("dist/ is untouched by the branch", () => {
    const out = execSync(`git diff --stat ${diffBase} -- dist/`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(out.trim()).toBe("");
  });

  test("branch footprint outside tests/ is exactly the allowlist (catches strays)", () => {
    const out = execSync(`git diff --name-only ${diffBase}`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const files = out
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("tests/"));
    if (files.length === 0) return; // on main post-merge: nothing to guard
    // The branch footprint is the union of the committed work on it
    // (feat/test-autorun-and-modularization, Items 1+2: --test auto-run moves
    // into the node:test shim; sandbox fragments re-synced and generate() cut
    // over to SANDBOX_TEMPLATE): src/test.js owns the trigger, runtime.js
    // drops the template interception and the inline template, playground.js
    // updates the tests example, docs record the contract, CI gates the
    // template freshness. tests/ is excluded above.
    expect(files.sort()).toEqual(
      [
        ".github/workflows/run.yaml",
        "docs/E2E_FEATURE_MATRIX.md",
        "docs/RUNTIME.md",
        "runtime.js",
        "src/build-sandbox.mjs",
        "src/sandbox-template.js",
        "src/sandbox/00-runtime-object.js",
        "src/sandbox/05-vitest-mocks.js",
        "src/sandbox/10-task-tracker.js",
        "src/sandbox/20-module-loader.js",
        "src/sandbox/21-sync-require.js",
        "src/sandbox/30-interop.js",
        "src/sandbox/31-node-globals.js",
        "src/sandbox/32-path-resolve.js",
        "src/sandbox/40-console.js",
        "src/sandbox/41-events-warnings.js",
        "src/sandbox/50-process.js",
        "src/sandbox/60-timers.js",
        "src/sandbox/70-fetch.js",
        "src/sandbox/71-xhr.js",
        "src/sandbox/80-errors.js",
        "src/sandbox/85-keydecoder.js",
        "src/sandbox/90-server-request.js",
        "src/sandbox/95-init.js",
        "src/sandbox/96-user-code.js",
        "src/sandbox/97-finalize.js",
        "src/test.js",
        "src/ui/playground.js",
      ].sort(),
    );
  });

  test("no new function declarations added by the branch diff", () => {
    // Post-merge of PR #199, __bvmRequireSync pre-exists on the base, so the
    // old expectation (exactly one added `+function __bvmRequireSync`) is
    // stale. This change modifies __bvmRequireSync and the require()
    // CallExpression handler but declares no new functions; neither does the
    // sibling inlineWasmDataUrls dedupe.
    const out = execSync(`git diff ${diffBase} -- runtime.js`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const addedFns = out.split("\n").filter((l) => l.startsWith("+function "));
    expect(addedFns).toEqual([]);
  });

  test("no new import statements added to runtime.js", () => {
    const out = execSync(`git diff ${diffBase} -- runtime.js`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const addedImports = out
      .split("\n")
      .filter((l) => l.startsWith("+import "));
    // Item 2 cutover: generate() imports the built sandbox template and the
    // log-token table. These two are the only expected additions.
    expect(addedImports.sort()).toEqual(
      [
        '+import { LOG_TOKENS } from "./src/sandbox/log-tokens.js";',
        '+import { SANDBOX_TEMPLATE } from "./src/sandbox-template.js";',
      ].sort(),
    );
  });
});
