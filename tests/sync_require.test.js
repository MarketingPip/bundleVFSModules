import { describe, test, expect, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MagicString from "magic-string";
import * as acorn from "acorn";

// Regression tests for the sync require() path in runtime.js.
//
//  1. Leading-slash file keys ('/lib/util.js') must resolve — both the
//     parent-side unflattenFileSystem and the sandbox-side unflattenUserFiles
//     normalize them (a '/lib/util.js'.split('/') phantom '' root segment
//     used to make every lookup miss).
//  2. Nested require() inside CJS modules must stay synchronous:
//     transformImportsToLoadModule preserves require() calls when building
//     with moduleType 'require' (rewriting them to await loadModule() inside
//     the sync CJS wrapper was a SyntaxError), and createSyncRequire binds
//     each module's require to its OWN path so relative requires resolve
//     against the module's directory, not the entry point's.
//  3. The sync loader reads the LIVE memfs via __FS__.readFileSync — files
//     written at runtime with writeFileSync are require-able (and the
//     startup snapshot is only a fallback when __FS__ isn't loaded yet).
//  4. One module cache is shared across the whole require tree, so repeated
//     requires return identical exports and circular requires yield
//     Node-style partial exports instead of infinite recursion.
//
// runtime.js cannot be imported under Node (it wires a demo DOM at module
// scope), so — like tests/runtime_error_stacks.test.js — these tests extract
// the exact shipped source and evaluate it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);
// The sandbox template now lives in src/sandbox-template.js (built from
// src/sandbox/*.js). TEMPLATE_SRC is the decoded template value.
const TEMPLATE_SRC = JSON.parse(
  fs
    .readFileSync(
      path.join(__dirname, "..", "src", "sandbox-template.js"),
      "utf8",
    )
    .match(/export const SANDBOX_TEMPLATE = (".*");/s)[1],
);


function functionEnd(src, start) {
  // start: index of "function name". Returns the index just past the
  // function's closing brace (balanced paren/brace scan).
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
  if (depth !== 0)
    throw new Error("unbalanced braces in runtime.js extraction");
  return i + 1;
}

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1)
    throw new Error("marker not found in runtime.js: " + marker);
  return src.slice(start, functionEnd(src, start)).replace(/^export\s+/, "");
}

// Minimal walk.simple mirroring acorn-walk's contract (visit every node,
// dispatch on node.type). The transform attaches parents itself before
// walking, so we only need to avoid following the 'parent' links back up.
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

function loadTransform() {
  // The transform reads _builtinManifest for every require() call (on-demand
  // require: nested builtin requires rewrite to __bvmRequireSync). Provide
  // the module-scope binding the extracted function expects.
  const code =
    "const _builtinManifest = { fs: 'fs.js', 'fs/promises': 'fs_promises.js' };\n" +
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
    code + "\nreturn { transformImportsToLoadModule };",
  );
  return factory(MagicString, acorn, walk).transformImportsToLoadModule;
}

// Sandbox-side sync-require helpers, extracted verbatim from the generate()
// template. ${config.uuid} is pinned to a test id; tests control
// globalThis._RUNTIMEtestuuid_.__FS__ to switch between live memfs and the
// snapshot fallback.
//
// The whole contiguous block is extracted (readModuleSourceLiveFirst through
// createSyncRequire), not functions by name: createSyncRequire's dependency
// closure (resolveSyncRequest + the vfs* resolvers) lives in this block, and
// the by-name list went stale when resolution moved to the shared
// resolveSyncRequire — the missing binding threw a ReferenceError that
// createSyncRequire's catch re-wrapped as ERR_MODULE_NOT_FOUND.
const TEST_UUID = "testuuid";
function loadSyncRequireHelpers() {
  const blockStart = TEMPLATE_SRC.indexOf(
    "// Read a CJS module's source for the sync require path",
  );
  if (blockStart === -1)
    throw new Error("sync-require template block not found");
  const createStart = TEMPLATE_SRC.indexOf(
    "function createSyncRequire(parentPath, vfs",
    blockStart,
  );
  if (createStart === -1)
    throw new Error("createSyncRequire not found in sync-require block");
  let code = "const _builtinManifest = {};\nconst _builtinCache = new Map();\n";
  code += TEMPLATE_SRC.slice(blockStart, functionEnd(TEMPLATE_SRC, createStart));
  code = code.replace(/%%UUID%%/g, TEST_UUID);
  const factory = new Function(
    code +
      "\nreturn { vfsLookup, readModuleSourceLiveFirst, unflattenUserFiles, createSyncRequire };",
  );
  return factory();
}

function loadParentUnflatten() {
  const code = extractFunction(
    RUNTIME_SRC,
    "function unflattenFileSystem(flatObj)",
  );
  return new Function(code + "\nreturn unflattenFileSystem;")();
}

// In-memory fake for the memfs __FS__ surface the sync loader uses.
// Implements the statSync/readFileSync/writeFileSync surface the real
// buildApi(vol) fs exposes (src/fs.js): the VFS resolvers probe the live
// memfs via statSync, so a fake without it silently disables live-first
// resolution.
function makeFakeFs(seedFiles) {
  const store = new Map(Object.entries(seedFiles));
  const enoent = (op, p) => {
    const e = new Error(
      "ENOENT: no such file or directory, " + op + " '" + p + "'",
    );
    e.code = "ENOENT";
    return e;
  };
  return {
    statSync(p) {
      if (store.has(p)) return { isFile: () => true, isDirectory: () => false };
      const prefix = p.endsWith("/") ? p : p + "/";
      for (const k of store.keys())
        if (k.startsWith(prefix))
          return { isFile: () => false, isDirectory: () => true };
      throw enoent("stat", p);
    },
    readFileSync(p, enc) {
      if (!store.has(p)) throw enoent("open", p);
      return store.get(p);
    },
    writeFileSync(p, data) {
      store.set(p, String(data));
    },
  };
}

afterEach(() => {
  delete globalThis["_RUNTIME" + TEST_UUID + "_"];
});

// ---------------------------------------------------------------------------
// 1. Leading-slash normalization
// ---------------------------------------------------------------------------
describe("leading-slash file keys", () => {
  test("parent unflattenFileSystem strips leading slashes", () => {
    const unflattenFileSystem = loadParentUnflatten();
    const vfs = unflattenFileSystem({
      "/lib/util.js": "U",
      "lib/other.js": "O",
      "/data.txt": "D",
    });
    expect(vfs).toEqual({
      lib: { "util.js": "U", "other.js": "O" },
      "data.txt": "D",
    });
  });

  test("sandbox unflattenUserFiles strips leading slashes", () => {
    const { unflattenUserFiles } = loadSyncRequireHelpers();
    const vfs = unflattenUserFiles({
      "/lib/deep/nested.js": "N",
      "lib/util.js": "U",
    });
    expect(vfs).toEqual({
      lib: { deep: { "nested.js": "N" }, "util.js": "U" },
    });
  });

  test("vfsLookup finds files regardless of key slash style", () => {
    const { unflattenUserFiles, vfsLookup } = loadSyncRequireHelpers();
    for (const files of [
      { "/lib/util.js": "const x = 1;" },
      { "lib/util.js": "const x = 1;" },
    ]) {
      const vfs = unflattenUserFiles(files);
      expect(vfsLookup("lib/util.js", vfs)).toBe("const x = 1;");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Nested require() stays synchronous
// ---------------------------------------------------------------------------
describe("transformImportsToLoadModule preserveRequireCalls", () => {
  test("leaves require() calls intact for CJS modules (moduleType require)", () => {
    const transform = loadTransform();
    const src =
      'const u = require("../util.js");\nmodule.exports = { sum: u.add(1, 2) };';
    const out = transform("some-uuid", src, "lib/deep/nested.js", null, {
      preserveRequireCalls: true,
    });
    expect(out.code).toContain('require("../util.js")');
    expect(out.code).not.toContain("loadModule");
  });

  test("still lifts require() for non-CJS builds", () => {
    const transform = loadTransform();
    const src = 'const u = require("./lib/util.js");\nconsole.log(u.tag);';
    const out = transform("some-uuid", src, "index.js", null, {});
    expect(out.code).not.toContain('require("./lib/util.js")');
    expect(out.code).toContain("loadModule");
  });
});

describe("createSyncRequire", () => {
  const FILES = {
    "/lib/util.js":
      'module.exports = { add: (a, b) => a + b, tag: "util-v1" };',
    "/lib/deep/nested.js":
      'const u = require("../util.js");\nmodule.exports = { nested: true, sum: u.add(20, 22) };',
    "/lib/deep/deep2.js":
      'const n = require("./nested.js");\nmodule.exports = { deep: true, total: n.sum + 1 };',
  };

  function makeRequire(files = FILES) {
    const { unflattenUserFiles, createSyncRequire } = loadSyncRequireHelpers();
    return createSyncRequire("index.js", unflattenUserFiles(files));
  }

  test("top-level require resolves", () => {
    const req = makeRequire();
    expect(req("./lib/util.js")).toEqual({
      add: expect.any(Function),
      tag: "util-v1",
    });
    expect(req("./lib/util.js").add(2, 3)).toBe(5);
  });

  test("nested require resolves against the module's own directory", () => {
    const req = makeRequire();
    expect(req("./lib/deep/nested.js")).toEqual({ nested: true, sum: 42 });
  });

  test("three-level require chain", () => {
    const req = makeRequire();
    expect(req("./lib/deep/deep2.js")).toEqual({ deep: true, total: 43 });
  });

  test("extensionless require appends .js", () => {
    const req = makeRequire();
    expect(req("./lib/util").tag).toBe("util-v1");
  });

  test("missing module throws ERR_MODULE_NOT_FOUND", () => {
    const req = makeRequire();
    expect(() => req("./lib/does-not-exist.js")).toThrow(
      /ERR_MODULE_NOT_FOUND/,
    );
  });

  test("repeated require returns identical (cached) exports", () => {
    const req = makeRequire();
    const a = req("./lib/util.js");
    const b = req("./lib/util.js");
    expect(a).toBe(b);
  });

  test("circular requires yield partial exports instead of hanging", () => {
    const { unflattenUserFiles, createSyncRequire } = loadSyncRequireHelpers();
    const vfs = unflattenUserFiles({
      "/a.js":
        'const b = require("./b.js");\nmodule.exports = { name: "a", bName: b.name };',
      "/b.js":
        'const a = require("./a.js");\nmodule.exports = { name: "b", aName: a.name };',
    });
    const req = createSyncRequire("index.js", vfs);
    const a = req("./a.js");
    expect(a.name).toBe("a");
    expect(a.bName).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// 3. Live memfs reads
// ---------------------------------------------------------------------------
describe("sync require reads live memfs", () => {
  test("file written at runtime via writeFileSync is require-able", () => {
    const { unflattenUserFiles, createSyncRequire } = loadSyncRequireHelpers();
    // Snapshot is EMPTY: the only way this require can succeed is a live read.
    const req = createSyncRequire("index.js", unflattenUserFiles({}));
    globalThis["_RUNTIME" + TEST_UUID + "_"] = { __FS__: makeFakeFs({}) };
    globalThis["_RUNTIME" + TEST_UUID + "_"].__FS__.writeFileSync(
      "/lib/live.js",
      'module.exports = { live: "written-at-runtime" };',
    );
    expect(req("./lib/live.js")).toEqual({ live: "written-at-runtime" });
  });

  test("overwritten file yields new content (no stale snapshot)", () => {
    const { unflattenUserFiles, createSyncRequire } = loadSyncRequireHelpers();
    const fakeFs = makeFakeFs({
      "/lib/util.js": 'module.exports = { tag: "old" };',
    });
    globalThis["_RUNTIME" + TEST_UUID + "_"] = { __FS__: fakeFs };
    const snapshot = unflattenUserFiles({
      "/lib/util.js": 'module.exports = { tag: "old" };',
    });
    fakeFs.writeFileSync("/lib/util.js", 'module.exports = { tag: "new" };');
    const req = createSyncRequire("index.js", snapshot);
    expect(req("./lib/util.js").tag).toBe("new");
  });

  test("falls back to the snapshot tree when __FS__ is not loaded yet", () => {
    const { unflattenUserFiles, createSyncRequire } = loadSyncRequireHelpers();
    // No _RUNTIMEtestuuid_ global at all: pure snapshot path.
    const req = createSyncRequire(
      "index.js",
      unflattenUserFiles({
        "/lib/util.js": 'module.exports = { tag: "util-v1" };',
      }),
    );
    expect(req("./lib/util.js").tag).toBe("util-v1");
  });
});
