// Regression tests for Vitest E2E gap #3: synchronous builtin access for
// createRequire()/Module._load.
//
// Executed failure (2026-09-28, true Vitest 5.0.2 E2E through the real
// iframe/runtime path):
//   Cannot find module 'fs' in./shared/parse-WKtEKiA6.mjs
//   at node_modules/rolldown/dist/parse-ast-index.mjs
// Rolldown does `createRequire(import.meta.url)` then synchronously
// `require('fs')`. dist/module.js's loadBuiltinModule() can only use the
// sandbox RT.loadModule() when it returns synchronously — it never does —
// so it falls through to process.getBuiltinModule(), which always returned
// `undefined` (src/process.js) / did not exist on the sandbox global, and
// the require died with MODULE_NOT_FOUND.
//
// The fix:
//  1. runtime.js's inline sandbox copy gains a working cache-backed
//     process.getBuiltinModule (validates like Node: non-string id throws
//     ERR_INVALID_ARG_TYPE; unknown ids return undefined) backed by a
//     sandbox-init preload of every manifest builtin into _builtinCache.
//  2. src/process.js (the dist/process.js shim) delegates to the live
//     sandbox global's getBuiltinModule when it isn't its own installed
//     copy, falling back to the pre-install host process (real Node).
//
// runtime.js cannot be imported under Node (demo DOM at module scope), so —
// like tests/sync_require_bare_builtins.test.js — these tests extract the
// exact shipped source and evaluate it.

import { describe, test, expect, jest, afterAll } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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


function extractBlock(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1)
    throw new Error("start marker not found in runtime.js: " + startMarker);
  const end = src.indexOf(endMarker, start);
  if (end === -1)
    throw new Error("end marker not found in runtime.js: " + endMarker);
  return src.slice(start, end);
}

const GBM_START = "// --- begin sandbox getBuiltinModule (gap #3) ---";
const GBM_END = "// --- end sandbox getBuiltinModule (gap #3) ---";
const UNWRAP_START = "// --- begin sync builtin require interop (gap #3) ---";
const UNWRAP_END = "// --- end sync builtin require interop (gap #3) ---";

// The extracted source is a method `getBuiltinModule(id) {...}` inside the
// sandbox process object literal. Rebuild it as a standalone function with
// the sandbox-scope free variables (_builtinManifest, _builtinCache,
// _builtinRequireValue) injected as parameters.
function loadSandboxGetBuiltinModule(manifest, cache) {
  const unwrapSrc = extractBlock(TEMPLATE_SRC, UNWRAP_START, UNWRAP_END);
  const methodSrc = extractBlock(TEMPLATE_SRC, GBM_START, GBM_END)
    .replace(GBM_START, "")
    .replace(GBM_END, "");
  const factory = new Function(
    "_builtinManifest",
    "_builtinCache",
    `${unwrapSrc}\nreturn ({ ${methodSrc} }).getBuiltinModule;`,
  );
  return factory(manifest, cache);
}

function makeCache(entries) {
  return new Map(Object.entries(entries));
}

const FAKE_FS = { readFileSync() {}, promises: {} };
const FAKE_PATH = { join() {}, sep: "/" };

describe("sandbox process.getBuiltinModule (gap #3)", () => {
  test("returns the cached builtin for a bare id", () => {
    const gbm = loadSandboxGetBuiltinModule(
      { fs: "fs.js" },
      makeCache({ fs: FAKE_FS }),
    );
    expect(gbm("fs")).toBe(FAKE_FS);
  });

  test("strips the node: prefix ('node:fs' === 'fs')", () => {
    const gbm = loadSandboxGetBuiltinModule(
      { fs: "fs.js" },
      makeCache({ fs: FAKE_FS }),
    );
    expect(gbm("node:fs")).toBe(FAKE_FS);
  });

  test("supports subpath builtins (fs/promises)", () => {
    const gbm = loadSandboxGetBuiltinModule(
      { "fs/promises": "fs_promises.js" },
      makeCache({ "fs/promises": FAKE_FS.promises }),
    );
    expect(gbm("fs/promises")).toBe(FAKE_FS.promises);
  });

  test("unwraps single-default interop like sync require()", () => {
    const onlyDefault = { default: FAKE_PATH };
    const gbm = loadSandboxGetBuiltinModule(
      { path: "path.js" },
      makeCache({ path: onlyDefault }),
    );
    expect(gbm("path")).toBe(FAKE_PATH);
  });

  test("multi-key namespaces are returned as-is", () => {
    const ns = { join() {}, sep: "/", default: undefined };
    const gbm = loadSandboxGetBuiltinModule(
      { path: "path.js" },
      makeCache({ path: ns }),
    );
    expect(gbm("path")).toBe(ns);
  });

  test("non-string id throws ERR_INVALID_ARG_TYPE (Node parity)", () => {
    const gbm = loadSandboxGetBuiltinModule({ fs: "fs.js" }, makeCache({}));
    expect(() => gbm(123)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(() => gbm(undefined)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  test("unknown builtin returns undefined (Node v24 parity — no throw)", () => {
    const gbm = loadSandboxGetBuiltinModule({ fs: "fs.js" }, makeCache({}));
    expect(gbm("nope")).toBeUndefined();
    expect(gbm("node:nope")).toBeUndefined();
  });

  test("manifest-listed but un-preloaded builtin throws a clear sync error, not silent undefined", () => {
    const gbm = loadSandboxGetBuiltinModule(
      { fs: "fs.js" },
      makeCache({/* preload missed fs */}),
    );
    // The old behavior returned undefined, which loadBuiltinModule turned
    // into MODULE_NOT_FOUND far from the cause. A sync require() can never
    // wait for the async loader, so say so explicitly.
    expect(() => gbm("fs")).toThrow(
      expect.objectContaining({ code: "ERR_REQUIRE_ASYNC_MODULE" }),
    );
    expect(() => gbm("fs")).toThrow(/synchronously/);
  });

  test("RUNTIME:NODE_GLOBALS is not treated as a node builtin", () => {
    // The real _builtinManifest has no RUNTIME: keys (the preload skips
    // them); getBuiltinModule must not resolve them either.
    const gbm = loadSandboxGetBuiltinModule({ fs: "fs.js" }, makeCache({}));
    expect(gbm("RUNTIME:NODE_GLOBALS")).toBeUndefined();
  });
});

// --- src/process.js delegation --------------------------------------------

const realProcess = globalThis.process;
const SHIM = "../src/process.js";
let shimSeq = 0;

async function freshShim() {
  delete globalThis._RUNTIME_;
  jest.resetModules();
  const ns = await import(`${SHIM}?fresh=${++shimSeq}`);
  const installed = globalThis.process; // what the module installed
  globalThis.process = realProcess; // give the runner its process back
  delete globalThis._RUNTIME_;
  return { ns, installed };
}

afterAll(() => {
  globalThis.process = realProcess;
  delete globalThis._RUNTIME_;
  jest.resetModules();
});

describe("src/process.js getBuiltinModule delegation (gap #3)", () => {
  test("delegates to the bundleVFS template process via __bvm_process_final__", async () => {
    const { ns } = await freshShim();
    const sentinel = { readFileSync() {} };
    // The sandbox template saves its authoritative process (with the
    // preloaded builtin cache) as globalThis.__bvm_process_final__.
    globalThis.__bvm_process_final__ = {
      getBuiltinModule: (id) =>
        id === "fs" || id === "node:fs" ? sentinel : undefined,
    };
    try {
      expect(ns.getBuiltinModule("fs")).toBe(sentinel);
      expect(ns.getBuiltinModule("node:fs")).toBe(sentinel);
      expect(ns.getBuiltinModule("nope")).toBeUndefined();
    } finally {
      delete globalThis.__bvm_process_final__;
    }
  });

  test("does not consult native process.getBuiltinModule (stubbed to throw)", async () => {
    // Standing rule: test shims through the project's own runtime only —
    // never the native bridge. Under direct Node import (no bundleVFS
    // runtime) getBuiltinModule must return undefined, not call native.
    const nativeGBM = realProcess.getBuiltinModule;
    realProcess.getBuiltinModule = () => {
      throw new Error("native delegation!");
    };
    try {
      const { ns } = await freshShim();
      expect(ns.getBuiltinModule("fs")).toBeUndefined();
      expect(ns.getBuiltinModule("node:path")).toBeUndefined();
    } finally {
      realProcess.getBuiltinModule = nativeGBM;
    }
  });

  test("non-string id throws ERR_INVALID_ARG_TYPE before any delegation", async () => {
    const { ns } = await freshShim();
    expect(() => ns.getBuiltinModule(123)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  test("returns undefined when no bundleVFS runtime is present", async () => {
    const { ns } = await freshShim();
    // No __bvm_process_final__: honest undefined, never a throw, never native.
    delete globalThis.__bvm_process_final__;
    expect(ns.getBuiltinModule("fs")).toBeUndefined();
  });
});
