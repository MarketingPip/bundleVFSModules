import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookupNativeInterception } from "../src/browser-builds.js";

/**
 * M1 honesty gap — the dynamic `import` path.
 *
 * The M1 require-path tests prove CJS `require('rollup')` resolves through
 * the interception table (src/module.js `_resolveFilename`). But real Vite 7
 * is ESM: its `import ... from "esbuild"` / `import ... from "rollup"` go
 * through the SANDBOX import path — child `loadModule` → parent
 * `_dynamic_import` interop in runtime.js — which never consulted the table.
 * The M1 "import-style" test only pinned the table, not the executed path.
 *
 * These tests execute the EXACT shipped parent `_dynamic_import` handler
 * source (extracted verbatim from runtime.js, per the established
 * tests/nested_import_resolution.test.js pattern — runtime.js cannot be
 * imported under Node) with its closure neighbors wired in:
 *   - REAL: the handler body, resolveVFS/vfsLookup, toVFSPath,
 *     lookupNativeInterception (the table under test)
 *   - STUBBED (recording): resolveNodeModule, resolvePackageImports,
 *     fetchBuiltinSource — stubs only stand in for neighbors the handler
 *     calls; every assertion is about the handler's own behavior.
 *
 * VFS seeds use the REAL installed vendor files (byte-identical reads from
 * node_modules / src): no silent fakes — a green asserts the handler hands
 * back the real browser build's source.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);
const NM = path.join(__dirname, "..", "node_modules");

const ROLLUP_BROWSER_SRC = fs.readFileSync(
  path.join(NM, "@rollup/browser", "dist", "rollup.browser.js"),
  "utf8",
);
const ESBUILD_SHIM_SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "vendor", "esbuild-shim.cjs"),
  "utf8",
);

// Flat __USER_FILES__-style seed, exactly as the host passes it to the
// handler (the handler unflattens it itself).
const FLAT_VFS = {
  "/node_modules/@rollup/browser/package.json": fs.readFileSync(
    path.join(NM, "@rollup/browser", "package.json"),
    "utf8",
  ),
  "/node_modules/@rollup/browser/dist/rollup.browser.js": ROLLUP_BROWSER_SRC,
  "/node_modules/.bvm/esbuild-shim.cjs": ESBUILD_SHIM_SRC,
  "/node_modules/lodash-es/package.json": JSON.stringify({
    name: "lodash-es",
    version: "4.17.21",
  }),
  "/node_modules/lodash-es/index.js":
    "export function cloneDeep(val) { return JSON.parse(JSON.stringify(val)); }",
};

function extractBalanced(src, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("unbalanced " + openCh + closeCh + " at " + openIdx);
}

// The second registerInterop('_dynamic_import', ...) wins — that is the live
// handler. Returns its exact source: `async (path, ...) => { ... }`.
function extractLiveHandler(src) {
  const hits = [
    ...src.matchAll(/registerInterop\(\s*["']_dynamic_import["']/g),
  ];
  expect(hits.length).toBeGreaterThanOrEqual(2);
  const start = hits[1].index;
  const asyncIdx = src.indexOf("async (", start);
  if (asyncIdx === -1) throw new Error("async ( not found in _dynamic_import");
  const parenOpen = src.indexOf("(", asyncIdx);
  const parenClose = extractBalanced(src, parenOpen, "(", ")");
  const braceOpen = src.indexOf("{", parenClose);
  const braceClose = extractBalanced(src, braceOpen, "{", "}");
  return src.slice(asyncIdx, braceClose + 1);
}

function extractFunction(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1)
    throw new Error("marker not found in runtime.js: " + marker);
  return extractFunctionAt(src, start);
}

// Real pure neighbors, extracted verbatim from runtime.js (constructor
// scope): resolveVFS + its sibling vfsLookup, and toVFSPath.
function realNeighbors() {
  const resolveVFSSrc = extractFunction(RUNTIME_SRC, "function resolveVFS(");
  const vfsLookupIdx = RUNTIME_SRC.indexOf("function vfsLookup(", 8000);
  const vfsLookupSrc = extractFunctionAt(RUNTIME_SRC, vfsLookupIdx);
  const toVFSPathSrc = extractFunction(RUNTIME_SRC, "function toVFSPath(");
  const resolveVFS = new Function(
    `${resolveVFSSrc}\n${vfsLookupSrc}\nreturn resolveVFS;`,
  )();
  const toVFSPath = new Function(`${toVFSPathSrc}\nreturn toVFSPath;`)();
  return { resolveVFSSrc, vfsLookupSrc, toVFSPathSrc, resolveVFS, toVFSPath };
}

function loadHandler(deps) {
  const handlerSrc = extractLiveHandler(RUNTIME_SRC);
  const { resolveVFSSrc, vfsLookupSrc, toVFSPathSrc } = realNeighbors();
  // The live handler now serves the VFS host-side via pickDynamicImportVfs
  // (unflattenFileSystem + this.config.fs); wire the real helpers in and
  // bind a fake host `this` with an empty seed so the handler falls back to
  // the explicitly-passed VFS, as these tests have always done.
  const pickVfsSrc = extractFunction(
    RUNTIME_SRC,
    "function pickDynamicImportVfs(",
  );
  const unflattenSrc = extractFunction(
    RUNTIME_SRC,
    "function unflattenFileSystem(",
  );
  const factory = new Function(
    "fetchBuiltinSource",
    "toVFSPath",
    "resolvePackageImports",
    "resolveNodeModule",
    "resolveVFS",
    "lookupNativeInterception",
    `${resolveVFSSrc}\n${vfsLookupSrc}\n${toVFSPathSrc}\n${pickVfsSrc}\n${unflattenSrc}\nreturn (${handlerSrc});`,
  );
  return factory.call(
    { config: { fs: {} } },
    deps.fetchBuiltinSource,
    deps.toVFSPath,
    deps.resolvePackageImports,
    deps.resolveNodeModule,
    deps.resolveVFS,
    lookupNativeInterception,
  );
}

function extractFunctionAt(src, start) {
  if (start === -1) throw new Error("marker index -1");
  const parenOpen = src.indexOf("(", start);
  const parenClose = extractBalanced(src, parenOpen, "(", ")");
  const braceOpen = src.indexOf("{", parenClose);
  const braceClose = extractBalanced(src, braceOpen, "{", "}");
  return src.slice(start, braceClose + 1).replace(/^export\s+/, "");
}

function makeDeps({ resolveNodeModuleImpl } = {}) {
  const calls = { resolveNodeModule: [] };
  const { resolveVFS, toVFSPath } = realNeighbors();
  const finalStub = (p, importer) => {
    calls.resolveNodeModule.push([p, importer]);
    return resolveNodeModuleImpl ? resolveNodeModuleImpl(p, importer) : null;
  };
  return {
    calls,
    handler: loadHandler({
      fetchBuiltinSource: () => {
        throw new Error("fetchBuiltinSource must not be called here");
      },
      toVFSPath,
      resolvePackageImports: () => null,
      resolveNodeModule: finalStub,
      resolveVFS,
    }),
  };
}

describe("parent _dynamic_import consults the interception table (M1/M2 ESM path)", () => {
  test("import 'rollup' returns the real @rollup/browser source without touching node_modules lookup", async () => {
    const { handler, calls } = makeDeps();
    const result = await handler("rollup", "import", null, null, false, "/", {
      ...FLAT_VFS,
    });
    expect(result.source).toBe(ROLLUP_BROWSER_SRC);
    expect(result.resolvedPath).toBe(
      "/node_modules/@rollup/browser/dist/rollup.browser.js",
    );
    // Interception preempts the normal lookup entirely.
    expect(calls.resolveNodeModule).toEqual([]);
  });

  test("import 'esbuild' returns the real esbuild-shim source", async () => {
    const { handler, calls } = makeDeps();
    const result = await handler("esbuild", "import", null, null, false, "/", {
      ...FLAT_VFS,
    });
    expect(result.source).toBe(ESBUILD_SHIM_SRC);
    expect(result.resolvedPath).toBe("/node_modules/.bvm/esbuild-shim.cjs");
    expect(calls.resolveNodeModule).toEqual([]);
  });

  test("non-intercepted bare specifiers still go through the normal node_modules lookup", async () => {
    const marker = {
      source: "export const x = 1;",
      resolvedPath: "node_modules/lodash-es/index.js",
    };
    const { handler, calls } = makeDeps({
      resolveNodeModuleImpl: () => marker,
    });
    const result = await handler(
      "lodash-es",
      "import",
      null,
      null,
      false,
      "/",
      { ...FLAT_VFS },
    );
    expect(calls.resolveNodeModule.length).toBe(1);
    expect(calls.resolveNodeModule[0][0]).toBe("lodash-es");
    // The handler repackages { source, resolvedPath } — identity is not kept.
    expect(result).toStrictEqual(marker);
  });

  test("native platform packages are NOT intercepted (honest miss, no fake)", async () => {
    const { handler, calls } = makeDeps();
    const result = await handler(
      "@rollup/rollup-linux-x64-gnu",
      "import",
      null,
      null,
      false,
      "/",
      { ...FLAT_VFS },
    );
    expect(calls.resolveNodeModule.length).toBe(1);
    expect(calls.resolveNodeModule[0][0]).toBe("@rollup/rollup-linux-x64-gnu");
    expect(result).toBeNull();
  });

  test("@rollup/browser itself passes through uninterception", async () => {
    const { handler, calls } = makeDeps();
    await handler("rollup", "import", null, null, false, "/", { ...FLAT_VFS });
    expect(calls.resolveNodeModule).toEqual([]);
    const result = await handler(
      "@rollup/browser",
      "import",
      null,
      null,
      false,
      "/",
      { ...FLAT_VFS },
    );
    // Not intercepted: falls to the normal lookup (stubbed null here).
    expect(calls.resolveNodeModule.length).toBe(1);
    expect(calls.resolveNodeModule[0][0]).toBe("@rollup/browser");
    expect(result).toBeNull();
  });
});
