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
// VFS path resolution logic.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = fs.readFileSync(
  path.join(__dirname, "..", "runtime.js"),
  "utf8",
);

describe("require.resolve() VFS resolution", () => {
  test("resolveSyncRequest function exists and is used", () => {
    // The resolution logic should be extracted into a shared function.
    expect(RUNTIME_SRC).toContain("function resolveSyncRequest(");
    // syncRequire.resolve should use it, not be an identity stub.
    expect(RUNTIME_SRC).not.toContain(
      "syncRequire.resolve = (request) => request;",
    );
    expect(RUNTIME_SRC).toContain("syncRequire.resolve = (request) => {");
  });

  test("resolveSyncRequest handles relative paths", () => {
    // Extract and test the function directly.
    const start = RUNTIME_SRC.indexOf("function resolveSyncRequest(");
    const end = RUNTIME_SRC.indexOf("function createSyncRequire(");
    const fnSrc = RUNTIME_SRC.slice(start, end);
    const resolveSyncRequest = new Function(
      `${fnSrc}; return resolveSyncRequest;`,
    )();

    // Relative from /pkg/sub/module.js
    expect(resolveSyncRequest("./util", "/pkg/sub/module.js")).toBe(
      "/pkg/sub/util.js",
    );
    expect(resolveSyncRequest("../lib/helper", "/pkg/sub/module.js")).toBe(
      "/pkg/lib/helper.js",
    );
    // Already has .js
    expect(resolveSyncRequest("./util.js", "/pkg/sub/module.js")).toBe(
      "/pkg/sub/util.js",
    );
  });

  test("resolveSyncRequest handles absolute paths", () => {
    const start = RUNTIME_SRC.indexOf("function resolveSyncRequest(");
    const end = RUNTIME_SRC.indexOf("function createSyncRequire(");
    const fnSrc = RUNTIME_SRC.slice(start, end);
    const resolveSyncRequest = new Function(
      `${fnSrc}; return resolveSyncRequest;`,
    )();

    // Absolute paths ignore parentPath (Node semantics).
    expect(resolveSyncRequest("/lib/util", "/pkg/sub/module.js")).toBe(
      "/lib/util.js",
    );
    expect(resolveSyncRequest("/lib/util.js", "/other/path.js")).toBe(
      "/lib/util.js",
    );
  });

  test("resolveSyncRequest normalizes . and .. segments", () => {
    const start = RUNTIME_SRC.indexOf("function resolveSyncRequest(");
    const end = RUNTIME_SRC.indexOf("function createSyncRequire(");
    const fnSrc = RUNTIME_SRC.slice(start, end);
    const resolveSyncRequest = new Function(
      `${fnSrc}; return resolveSyncRequest;`,
    )();

    expect(resolveSyncRequest("./a/../b", "/pkg/module.js")).toBe("/pkg/b.js");
    expect(resolveSyncRequest("././c", "/pkg/module.js")).toBe("/pkg/c.js");
  });

  test("resolveSyncRequest throws for bare specifiers", () => {
    const start = RUNTIME_SRC.indexOf("function resolveSyncRequest(");
    const end = RUNTIME_SRC.indexOf("function createSyncRequire(");
    const fnSrc = RUNTIME_SRC.slice(start, end);
    const resolveSyncRequest = new Function(
      `${fnSrc}; return resolveSyncRequest;`,
    )();

    // Bare specifiers (node_modules) not yet implemented — should throw
    // ERR_MODULE_NOT_FOUND, not return garbage.
    expect(() => resolveSyncRequest("lodash", "/pkg/module.js")).toThrow(
      /ERR_MODULE_NOT_FOUND/,
    );
  });
});
