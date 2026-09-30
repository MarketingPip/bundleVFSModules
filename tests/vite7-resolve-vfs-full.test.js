import { describe, test, expect, afterEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Full VFS-aware require.resolve() verification (Jared, 2026-09-29).
//
// Node.js CJS resolution semantics in the browser runtime's sync-require
// path. The previous resolveSyncRequest() only handled relative/absolute
// paths with blind `.js` appending and threw ERR_MODULE_NOT_FOUND for all
// bare specifiers. This suite pins the complete behavior:
//
// - Bare package resolution via node_modules walk (nearest wins)
// - package.json "main" entry points (no execution during resolve)
// - Extension probing: exact, .js, .json (in that order)
// - Directory resolution: package.json main, then index.js, index.json
// - require('./config.json') returns the parsed JSON object
// - require.resolve() never executes the module
// - Builtins resolve to their specifier
//
// Like tests/vite7-syncrequire-abspath.test.js, these tests extract the
// exact shipped source from the generate() template and evaluate it —
// runtime.js cannot be imported under Node (demo DOM at module scope).

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
    "function vfsLoadAsDirectory(dirPath, vfs",
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
  for (const marker of markers)
    code += extractFunction(templateSrc, marker) + "\n";
  // var-declared shared constants (condition lists) the helpers close over.
  const cmStart = templateSrc.indexOf("var VFS_SYNC_EXPORT_CONDITIONS");
  if (cmStart === -1)
    throw new Error("VFS_SYNC_EXPORT_CONDITIONS not found in runtime.js");
  code +=
    templateSrc.slice(cmStart, templateSrc.indexOf(";", cmStart) + 1) + "\n";
  code = code.replace(/\$\{config\.uuid\}/g, TEST_UUID);
  const factory = new Function(
    code +
      "\nreturn { resolveSyncRequest, vfsLookup, readModuleSourceLiveFirst, unflattenUserFiles, createSyncRequire };",
  );
  return factory();
}

afterEach(() => {
  delete globalThis["_RUNTIME" + TEST_UUID + "_"];
});

// Fixture VFS exercising every resolution branch.
const FILES = {
  "/pkg/main.js": "module.exports = {};",
  "/pkg/util.js": "module.exports = { util: true };",
  "/pkg/config.json": '{ "theme": "dark", "version": 2 }',
  "/pkg/sub/index.js": "module.exports = { sub: true };",
  "/pkg/lib/package.json": '{ "main": "entry.js" }',
  "/pkg/lib/entry.js": "module.exports = { entry: true };",
  "/pkg/exact.js": "module.exports = { exact: true };",
  // "/pkg/exact.json" intentionally absent: exact file must win.
  "/node_modules/lodash/package.json": '{ "main": "lodash.js" }',
  "/node_modules/lodash/lodash.js": "module.exports = { lodash: true };",
  "/node_modules/lodash/fp.js": "module.exports = { fp: true };",
  "/node_modules/no-main/index.js": "module.exports = { noMain: true };",
  "/app/deep/module.js": "module.exports = {};",
  "/app/deep/node_modules/local/package.json": '{ "main": "main.js" }',
  "/app/deep/node_modules/local/main.js": "module.exports = { local: true };",
};

function makeVfs() {
  const { unflattenUserFiles } = loadHelpers();
  return unflattenUserFiles(FILES);
}

function makeRequire(parentPath) {
  const { unflattenUserFiles, createSyncRequire } = loadHelpers();
  return createSyncRequire(parentPath, unflattenUserFiles(FILES));
}

describe("resolveSyncRequest: bare package resolution", () => {
  test("resolves bare package via package.json main", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(resolveSyncRequest("lodash", "/app/module.js", makeVfs())).toBe(
      "/node_modules/lodash/lodash.js",
    );
  });

  test("resolves bare package subpath", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(resolveSyncRequest("lodash/fp", "/app/module.js", makeVfs())).toBe(
      "/node_modules/lodash/fp.js",
    );
  });

  test("node_modules walk prefers nearest", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(resolveSyncRequest("local", "/app/deep/module.js", makeVfs())).toBe(
      "/app/deep/node_modules/local/main.js",
    );
  });

  test("node_modules walk falls back to ancestor dirs", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(resolveSyncRequest("lodash", "/app/deep/module.js", makeVfs())).toBe(
      "/node_modules/lodash/lodash.js",
    );
  });

  test("bare package without main falls back to index.js", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(resolveSyncRequest("no-main", "/app/module.js", makeVfs())).toBe(
      "/node_modules/no-main/index.js",
    );
  });

  test("missing bare package throws ERR_MODULE_NOT_FOUND", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(() =>
      resolveSyncRequest("does-not-exist-xyz", "/app/module.js", makeVfs()),
    ).toThrow(/ERR_MODULE_NOT_FOUND/);
  });
});

describe("resolveSyncRequest: extension and directory probing", () => {
  test("probes .js extension", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(resolveSyncRequest("./util", "/pkg/main.js", makeVfs())).toBe(
      "/pkg/util.js",
    );
  });

  test("probes .json extension when .js absent", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(resolveSyncRequest("./config", "/pkg/main.js", makeVfs())).toBe(
      "/pkg/config.json",
    );
  });

  test("exact file wins over extension probing", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(resolveSyncRequest("./exact.js", "/pkg/main.js", makeVfs())).toBe(
      "/pkg/exact.js",
    );
  });

  test("directory resolves via package.json main", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(resolveSyncRequest("./lib", "/pkg/main.js", makeVfs())).toBe(
      "/pkg/lib/entry.js",
    );
  });

  test("directory resolves via index.js fallback", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(resolveSyncRequest("./sub", "/pkg/main.js", makeVfs())).toBe(
      "/pkg/sub/index.js",
    );
  });

  test("missing relative path throws ERR_MODULE_NOT_FOUND", () => {
    const { resolveSyncRequest } = loadHelpers();
    expect(() =>
      resolveSyncRequest("./nope", "/pkg/main.js", makeVfs()),
    ).toThrow(/ERR_MODULE_NOT_FOUND/);
  });
});

describe("syncRequire: JSON and resolve-without-execution", () => {
  test("require('./config.json') returns parsed object", () => {
    const req = makeRequire("/pkg/main.js");
    const config = req("./config.json");
    expect(config).toEqual({ theme: "dark", version: 2 });
  });

  test("require('./config') resolves .json and returns parsed object", () => {
    const req = makeRequire("/pkg/main.js");
    expect(req("./config")).toEqual({ theme: "dark", version: 2 });
  });

  test("require('lodash') loads the bare package", () => {
    const req = makeRequire("/app/module.js");
    expect(req("lodash")).toEqual({ lodash: true });
  });

  test("require.resolve() locates without executing", () => {
    const req = makeRequire("/app/module.js");
    const spy = { calls: 0 };
    // Poison the module cache check: resolve must not populate it.
    const resolved = req.resolve("lodash");
    expect(resolved).toBe("/node_modules/lodash/lodash.js");
    expect(req.cache.has(resolved)).toBe(false);
    expect(spy.calls).toBe(0);
  });

  test("require.resolve() works for relative and JSON paths", () => {
    const req = makeRequire("/pkg/main.js");
    expect(req.resolve("./util")).toBe("/pkg/util.js");
    expect(req.resolve("./config")).toBe("/pkg/config.json");
    expect(req.resolve("./sub")).toBe("/pkg/sub/index.js");
  });

  test("require.resolve() throws for missing modules", () => {
    const req = makeRequire("/pkg/main.js");
    expect(() => req.resolve("./missing")).toThrow(/ERR_MODULE_NOT_FOUND/);
    expect(() => req.resolve("missing-pkg")).toThrow(/ERR_MODULE_NOT_FOUND/);
  });
});
