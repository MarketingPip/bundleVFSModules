import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// require.resolve() verification (Jared, 2026-09-29).
//
// Node.js semantics: `require.resolve(request)` locates the module entry
// point on disk (here: the VFS) WITHOUT loading it. This is the CommonJS
// helper for finding where a module lives.
//
// In the browser runtime's sync-require path, `syncRequire.resolve` was a
// stub: `(request) => request` (identity function). It now uses the real
// VFS path resolution logic: the resolver probes the VFS for existence
// (LOAD_AS_FILE then LOAD_AS_DIRECTORY), so tests pass a VFS.
//
// Full bare-package / extension / directory / JSON behavior is pinned in
// tests/vite7-resolve-vfs-full.test.js; this file keeps the basic
// relative/absolute/normalization coverage.

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


function loadResolver() {
  const start = TEMPLATE_SRC.indexOf(
    "// --- VFS existence probing for the sync resolver",
  );
  const end = TEMPLATE_SRC.indexOf("function createSyncRequire(");
  const fnSrc = TEMPLATE_SRC.slice(start, end).replace(/%%UUID%%/g, "testuuid");
  const factory = new Function(`${fnSrc}; return resolveSyncRequest;`);
  // unflattenUserFiles is defined just before the helpers block; slice to
  // the block's opening comment.
  const uStart = TEMPLATE_SRC.indexOf("function unflattenUserFiles(flatObj)");
  const uEnd = TEMPLATE_SRC.indexOf(
    "// --- VFS existence probing for the sync resolver",
  );
  const uSrc = TEMPLATE_SRC.slice(uStart, uEnd).replace(/%%UUID%%/g, "testuuid");
  const uFactory = new Function(`${uSrc}; return unflattenUserFiles;`);
  const resolveSyncRequest = factory();
  return { resolveSyncRequest, unflattenUserFiles: uFactory() };
}

const { resolveSyncRequest, unflattenUserFiles } = loadResolver();

// Minimal VFS for the basic path-shape tests.
const VFS = unflattenUserFiles({
  "/pkg/sub/util.js": "module.exports = {};",
  "/pkg/lib/helper.js": "module.exports = {};",
  "/lib/util.js": "module.exports = {};",
  "/pkg/b.js": "module.exports = {};",
  "/pkg/c.js": "module.exports = {};",
});

describe("require.resolve() VFS resolution", () => {
  test("resolveSyncRequest function exists and is used", () => {
    // The resolution logic should be extracted into a shared function.
    expect(TEMPLATE_SRC).toContain("function resolveSyncRequest(");
    // syncRequire.resolve should use it, not be an identity stub.
    expect(TEMPLATE_SRC).not.toContain(
      "syncRequire.resolve = (request) => request;",
    );
    expect(TEMPLATE_SRC).toContain("syncRequire.resolve = (request) => {");
  });

  test("resolveSyncRequest handles relative paths", () => {
    // Relative from /pkg/sub/module.js
    expect(resolveSyncRequest("./util", "/pkg/sub/module.js", VFS)).toBe(
      "/pkg/sub/util.js",
    );
    expect(resolveSyncRequest("../lib/helper", "/pkg/sub/module.js", VFS)).toBe(
      "/pkg/lib/helper.js",
    );
    // Already has .js
    expect(resolveSyncRequest("./util.js", "/pkg/sub/module.js", VFS)).toBe(
      "/pkg/sub/util.js",
    );
  });

  test("resolveSyncRequest handles absolute paths", () => {
    // Absolute paths ignore parentPath (Node semantics).
    expect(resolveSyncRequest("/lib/util", "/pkg/sub/module.js", VFS)).toBe(
      "/lib/util.js",
    );
    expect(resolveSyncRequest("/lib/util.js", "/other/path.js", VFS)).toBe(
      "/lib/util.js",
    );
  });

  test("resolveSyncRequest normalizes . and .. segments", () => {
    expect(resolveSyncRequest("./a/../b", "/pkg/module.js", VFS)).toBe(
      "/pkg/b.js",
    );
    expect(resolveSyncRequest("././c", "/pkg/module.js", VFS)).toBe(
      "/pkg/c.js",
    );
  });

  test("resolveSyncRequest throws for unresolvable bare specifiers", () => {
    // Bare specifiers walk node_modules (nearest wins). With nothing to
    // find, they throw ERR_MODULE_NOT_FOUND — not return garbage. Full
    // bare-package behavior is pinned in vite7-resolve-vfs-full.test.js.
    expect(() => resolveSyncRequest("lodash", "/pkg/module.js", VFS)).toThrow(
      /ERR_MODULE_NOT_FOUND/,
    );
  });
});
