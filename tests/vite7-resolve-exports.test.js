import { describe, test, expect, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Sync require() package exports/imports resolution (Jared, 2026-09-29).
//
// PR #122 solved the package `exports`/`imports` fields for the async
// dynamic-import() path (vfsLookup). The sync require()/require.resolve()
// path that PR #136 rewrote only reads package.json `main` — a package that
// ships `exports` with no `main` resolves via import() but throws
// ERR_MODULE_NOT_FOUND via require(). This suite pins the sync path to
// Node's PACKAGE_EXPORTS_RESOLVE / PACKAGE_IMPORTS_RESOLVE semantics:
//
// - `exports` (string, subpath map, condition-sugar, patterns) with the
//   require condition set ["node", "require", "default"]
// - `exports` wins over `main` when both are present (Node parity)
// - a subpath absent from `exports` is an honest miss even if the file exists
// - `#`-imports resolve against the nearest parent package.json scope
// - scoped packages (@scope/pkg) split correctly
//
// Like tests/vite7-resolve-vfs-full.test.js, these tests extract the exact
// shipped source from runtime.js and evaluate it — runtime.js cannot be
// imported under Node (demo DOM at module scope).

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

const TEST_UUID = "testuuid";
function loadHelpers() {
  const markers = [
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
    "function vfsSplitPackageSpecifier(request)",
    "function vfsResolvePackageTargetSync(target, conditions)",
    "function vfsResolvePackageExportsSync(pkg, subpath)",
    "function vfsReadPackageJson(dirPath, vfs)",
    "function vfsPackageHasExports(dirPath, vfs)",
    "function vfsLoadPackageRoot(packageRoot, subpath, vfs)",
    "function vfsResolvePackageImportsSync(importPath, importerPath, vfs)",
    "function resolveSyncRequest(request,",
    "function readModuleSourceLiveFirst(resolved, vfs)",
    "function vfsLookup(path, vfs)",
    "function unflattenUserFiles(flatObj)",
    "function createSyncRequire(parentPath, vfs",
  ];
  const templateStart = RUNTIME_SRC.indexOf(
    "// Read a CJS module's source for the sync require path",
  );
  if (templateStart === -1)
    throw new Error("sync-require template block not found");
  const templateSrc = RUNTIME_SRC.slice(templateStart);
  let code = "const _builtinManifest = {};\nconst _builtinCache = new Map();\n";
  // var-declared shared constants (condition lists) the helpers close over.
  const constMarkers = ["var VFS_SYNC_EXPORT_CONDITIONS"];
  for (const marker of markers)
    code += extractFunction(templateSrc, marker) + "\n";
  for (const cm of constMarkers) {
    const s = templateSrc.indexOf(cm);
    if (s === -1) throw new Error("const marker not found: " + cm);
    const e = templateSrc.indexOf(";", s);
    code += templateSrc.slice(s, e + 1) + "\n";
  }
  code = code.replace(/\$\{config\.uuid\}/g, TEST_UUID);
  const factory = new Function(
    code +
      "\nreturn { resolveSyncRequest, vfsLookup, readModuleSourceLiveFirst, unflattenUserFiles, createSyncRequire, vfsResolvePackageExportsSync, vfsSplitPackageSpecifier };",
  );
  return factory();
}

afterEach(() => {
  delete globalThis["_RUNTIME" + TEST_UUID + "_"];
});

// Fixture VFS: packages exercising every exports/imports branch.
const FILES = {
  // String-form exports, no main at all.
  "/node_modules/str-pkg/package.json":
    '{ "name": "str-pkg", "exports": "./dist/main.js" }',
  "/node_modules/str-pkg/dist/main.js": "module.exports = { strPkg: true };",
  // Subpath-map exports with conditions; require condition must win.
  "/node_modules/cond-pkg/package.json":
    '{ "name": "cond-pkg", "main": "./legacy.js", "exports": { ".": { "require": "./cjs.js", "import": "./esm.js", "default": "./default.js" }, "./feature": "./feat.js" } }',
  "/node_modules/cond-pkg/cjs.js": "module.exports = { cond: 'cjs' };",
  "/node_modules/cond-pkg/esm.js": "module.exports = { cond: 'esm' };",
  "/node_modules/cond-pkg/default.js": "module.exports = { cond: 'default' };",
  "/node_modules/cond-pkg/feat.js": "module.exports = { feat: true };",
  "/node_modules/cond-pkg/legacy.js": "module.exports = { legacy: true };",
  // exports present but subpath not exported: file exists, must still miss.
  "/node_modules/locked-pkg/package.json":
    '{ "name": "locked-pkg", "exports": { ".": "./index.js" } }',
  "/node_modules/locked-pkg/index.js": "module.exports = { locked: true };",
  "/node_modules/locked-pkg/secret.js": "module.exports = { secret: true };",
  // Pattern exports.
  "/node_modules/pattern-pkg/package.json":
    '{ "name": "pattern-pkg", "exports": { "./features/*": "./src/features/*.js" } }',
  "/node_modules/pattern-pkg/src/features/auth.js":
    "module.exports = { auth: true };",
  // Scoped package with exports.
  "/node_modules/@scope/pkg/package.json":
    '{ "name": "@scope/pkg", "exports": "./main.js" }',
  "/node_modules/@scope/pkg/main.js": "module.exports = { scoped: true };",
  // imports field on the app package.
  "/app/package.json":
    '{ "name": "app", "imports": { "#utils": "./src/utils.js", "#lib/*": "./src/lib/*.js" } }',
  "/app/src/utils.js": "module.exports = { utils: true };",
  "/app/src/lib/helpers.js": "module.exports = { helpers: true };",
  "/app/entry.js": "module.exports = {};",
};

function makeVfs() {
  const { unflattenUserFiles } = loadHelpers();
  return unflattenUserFiles(FILES);
}

describe("sync require(): package exports field", () => {
  test("resolves string-form exports with no main", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(resolveSyncRequest("str-pkg", "/app/entry.js", makeVfs())).toBe(
      "/node_modules/str-pkg/dist/main.js",
    );
  });

  test("picks the require condition from a conditional exports map", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(resolveSyncRequest("cond-pkg", "/app/entry.js", makeVfs())).toBe(
      "/node_modules/cond-pkg/cjs.js",
    );
  });

  test("exports wins over main when both are present", () => {
    const { resolveSyncRequest, createSyncRequire } = loadHelpers();
    const vfs = makeVfs();
    expect(resolveSyncRequest("cond-pkg", "/app/entry.js", vfs)).toBe(
      "/node_modules/cond-pkg/cjs.js",
    );
    const require = createSyncRequire("/app/entry.js", vfs);
    expect(require("cond-pkg")).toEqual({ cond: "cjs" });
  });

  test("resolves an exported subpath", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(
      resolveSyncRequest("cond-pkg/feature", "/app/entry.js", makeVfs()),
    ).toBe("/node_modules/cond-pkg/feat.js");
  });

  test("unexported subpath is an honest miss even when the file exists", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(() =>
      resolveSyncRequest("locked-pkg/secret", "/app/entry.js", makeVfs()),
    ).toThrow(/ERR_MODULE_NOT_FOUND/);
  });

  test("resolves ./x/* pattern exports", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(
      resolveSyncRequest(
        "pattern-pkg/features/auth",
        "/app/entry.js",
        makeVfs(),
      ),
    ).toBe("/node_modules/pattern-pkg/src/features/auth.js");
  });

  test("resolves scoped package exports", () => {
    const { resolveSyncRequest, createSyncRequire } = loadHelpers();
    const vfs = makeVfs();
    expect(resolveSyncRequest("@scope/pkg", "/app/entry.js", vfs)).toBe(
      "/node_modules/@scope/pkg/main.js",
    );
    const require = createSyncRequire("/app/entry.js", vfs);
    expect(require("@scope/pkg")).toEqual({ scoped: true });
  });

  test("require() executes the exports-resolved module", () => {
    const { createSyncRequire } = loadHelpers();
    const require = createSyncRequire("/app/entry.js", makeVfs());
    expect(require("str-pkg")).toEqual({ strPkg: true });
  });

  test("require.resolve() resolves exports without executing", () => {
    const { createSyncRequire } = loadHelpers();
    const require = createSyncRequire("/app/entry.js", makeVfs());
    expect(require.resolve("str-pkg")).toBe(
      "/node_modules/str-pkg/dist/main.js",
    );
    expect(require.cache.has("/node_modules/str-pkg/dist/main.js")).toBe(false);
  });
});

describe("sync require(): package imports field", () => {
  test("resolves a #-import against the nearest parent package.json", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(resolveSyncRequest("#utils", "/app/entry.js", makeVfs())).toBe(
      "/app/src/utils.js",
    );
  });

  test("resolves a #-import pattern", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(resolveSyncRequest("#lib/helpers", "/app/entry.js", makeVfs())).toBe(
      "/app/src/lib/helpers.js",
    );
  });

  test("require() executes the imports-resolved module", () => {
    const { createSyncRequire } = loadHelpers();
    const require = createSyncRequire("/app/entry.js", makeVfs());
    expect(require("#utils")).toEqual({ utils: true });
  });

  test("unknown #-import throws ERR_MODULE_NOT_FOUND", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(() =>
      resolveSyncRequest("#nope", "/app/entry.js", makeVfs()),
    ).toThrow(/ERR_MODULE_NOT_FOUND/);
  });
});

describe("vfsSplitPackageSpecifier", () => {
  test("splits scoped and unscoped specifiers", () => {
    const { vfsSplitPackageSpecifier } = loadHelpers();
    expect(vfsSplitPackageSpecifier("pkg")).toEqual({
      packageName: "pkg",
      subpath: ".",
    });
    expect(vfsSplitPackageSpecifier("pkg/sub/deep")).toEqual({
      packageName: "pkg",
      subpath: "./sub/deep",
    });
    expect(vfsSplitPackageSpecifier("@scope/pkg")).toEqual({
      packageName: "@scope/pkg",
      subpath: ".",
    });
    expect(vfsSplitPackageSpecifier("@scope/pkg/sub")).toEqual({
      packageName: "@scope/pkg",
      subpath: "./sub",
    });
  });
});
