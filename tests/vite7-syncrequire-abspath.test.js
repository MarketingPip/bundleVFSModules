import { describe, test, expect, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression tests: sandbox CJS require() must resolve to ABSOLUTE VFS paths.
//
// Background (2026-09-29, vite7-browser M3): booting real vite@7 in the
// browser died inside picomatch with:
//   [ERR_MODULE_NOT_FOUND]: Cannot find module './scan' (resolved: lib/scan.js)
// Two defects combined:
//   B1. loadModule's require branch bound __syncRequire__ to `modulePath`
//       (the as-written request, e.g. './lib/picomatch') instead of the
//       module's RESOLVED absolute VFS path, so nested relative requires
//       resolved against a relative directory.
//   B2. createSyncRequire's path normalization dropped the leading '/'
//       (empty segments were filtered unconditionally), so even an absolute
//       parent produced a relative resolved path and a non-canonical
//       __filename.
// The general mechanism (Node semantics): a module's require() resolves
// relative to the module's own resolved filename, which is always an
// absolute VFS path.
//
// runtime.js cannot be imported under Node (it wires a demo DOM at module
// scope), so — like tests/sync_require.test.js — these tests extract the
// exact shipped source from the generate() template and evaluate it.

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
  return src.slice(start, i + 1);
}

// Sandbox-side sync-require helpers, extracted verbatim from the generate()
// template. ${config.uuid} is pinned to a test id.
const TEST_UUID = "testuuid";
function loadSyncRequireHelpers() {
  const parts = [
    "function readModuleSourceLiveFirst(resolved, vfs)",
    "function vfsLookup(path, vfs)",
    "function unflattenUserFiles(flatObj)",
    // VFS-aware resolver and its probing helpers (resolveSyncRequest is
    // called by createSyncRequire).
    "function vfsNodeAt(path, vfs)",
    "function vfsLiveFs()",
    "function vfsIsFile(path, vfs)",
    "function vfsIsDir(path, vfs)",
    "function vfsReadText(path, vfs)",
    "function vfsNormalizePath(path)",
    "function vfsDirname(path)",
    "function vfsNodeModulePaths(from)",
    "function vfsLoadAsFile(basePath, vfs)",
    "function vfsLoadAsDirectory(dirPath, vfs)",
    "function vfsLoadAsFileOrDirectory(basePath, vfs)",
    "function vfsModuleNotFound(request)",
    "function vfsIsRelativeRequest(request)",
    "function resolveSyncRequest(request,",
    "function createSyncRequire(parentPath, vfs",
  ];
  const templateStart = RUNTIME_SRC.indexOf(
    "// Read a CJS module's source for the sync require path",
  );
  if (templateStart === -1)
    throw new Error("sync-require template block not found");
  const templateSrc = RUNTIME_SRC.slice(templateStart);
  let code = "const _builtinManifest = {};\nconst _builtinCache = new Map();\n";
  for (const marker of parts)
    code += extractFunction(templateSrc, marker) + "\n";
  code = code.replace(/\$\{config\.uuid\}/g, TEST_UUID);
  const factory = new Function(
    code +
      "\nreturn { vfsLookup, readModuleSourceLiveFirst, unflattenUserFiles, createSyncRequire };",
  );
  return factory();
}

afterEach(() => {
  delete globalThis["_RUNTIME" + TEST_UUID + "_"];
});

// Picomatch-shaped fixture: index.js requires ./lib/picomatch.js which
// requires ./scan.js. All files live at absolute VFS paths.
const PICOMATCH_FILES = {
  "/node_modules/picomatch/index.js":
    'module.exports = require("./lib/picomatch.js");',
  "/node_modules/picomatch/lib/picomatch.js":
    'const scan = require("./scan.js");\nmodule.exports = { scan, filename: __filename, dirname: __dirname };',
  "/node_modules/picomatch/lib/scan.js":
    "module.exports = { scanned: true, filename: __filename };",
};

function makeRequire(parentPath, files = PICOMATCH_FILES) {
  const { unflattenUserFiles, createSyncRequire } = loadSyncRequireHelpers();
  return createSyncRequire(parentPath, unflattenUserFiles(files));
}

describe("createSyncRequire resolves to absolute VFS paths", () => {
  test("absolute parentPath keeps nested resolutions absolute (__filename)", () => {
    const req = makeRequire("/node_modules/picomatch/lib/picomatch.js");
    const scan = req("./scan.js");
    expect(scan.scanned).toBe(true);
    expect(scan.filename).toBe("/node_modules/picomatch/lib/scan.js");
  });

  test("full picomatch-shaped chain resolves absolutely from the index", () => {
    const req = makeRequire("/node_modules/picomatch/index.js");
    const pm = req("./lib/picomatch.js");
    expect(pm.scan.scanned).toBe(true);
    expect(pm.filename).toBe("/node_modules/picomatch/lib/picomatch.js");
    expect(pm.dirname).toBe("/node_modules/picomatch/lib");
    expect(pm.scan.filename).toBe("/node_modules/picomatch/lib/scan.js");
  });

  test("absolute request against a relative parent stays absolute", () => {
    const { unflattenUserFiles, createSyncRequire } = loadSyncRequireHelpers();
    const req = createSyncRequire(
      "index.js",
      unflattenUserFiles({
        "/abs/mod.js": "module.exports = { filename: __filename };",
      }),
    );
    expect(req("/abs/mod.js").filename).toBe("/abs/mod.js");
  });

  test("parent traversal (..) cannot escape the VFS root", () => {
    const { unflattenUserFiles, createSyncRequire } = loadSyncRequireHelpers();
    const req = createSyncRequire(
      "/a.js",
      unflattenUserFiles({
        "/top.js": "module.exports = { filename: __filename };",
      }),
    );
    expect(req("/../top.js").filename).toBe("/top.js");
  });
});

describe("loadModule binds sync require to the resolved module path", () => {
  // Extract the `if (moduleType === 'require')` block from the inline
  // loadModule (the live require path, not the dead requiredSupportedYet
  // branch) and assert it binds __syncRequire__ to buildFileName — the
  // module's resolved absolute VFS path — rather than modulePath, the
  // as-written request which may be relative (B1).
  function extractLiveRequireBranch() {
    const lmStart = RUNTIME_SRC.indexOf(
      "async function loadModule(modulePath, moduleType, entryPoint, parentEntryPoint)",
    );
    if (lmStart === -1) throw new Error("inline loadModule not found");
    const ifStart = RUNTIME_SRC.indexOf(
      "if (moduleType === 'require') {",
      lmStart,
    );
    if (ifStart === -1) throw new Error("live require branch not found");
    let i = RUNTIME_SRC.indexOf("{", ifStart);
    let depth = 0;
    for (; i < RUNTIME_SRC.length; i++) {
      if (RUNTIME_SRC[i] === "{") depth++;
      else if (RUNTIME_SRC[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    return RUNTIME_SRC.slice(ifStart, i + 1);
  }

  test("require branch uses buildFileName, not modulePath", () => {
    const branch = extractLiveRequireBranch();
    expect(branch).toContain("createSyncRequire(buildFileName,");
    expect(branch).not.toContain("createSyncRequire(modulePath,");
  });
});
