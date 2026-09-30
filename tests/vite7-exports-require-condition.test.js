import { describe, test, expect, afterEach } from "@jest/globals";
import * as shim from "../src/module.js";

/**
 * vite7-exports-require-condition.test.js
 *
 * Red-first regression test for the sync `require.resolve()` gap
 * (2026-09-30-vite7-consumption-e2e).
 *
 * `src/module.js`'s `tryPackage` (the node:module shim's own resolution,
 * used by `createRequire(import.meta.url)` inside the sandbox for
 * `require.resolve(...)`) only consulted package.json `main` and ignored
 * the `exports` field — so a package that ships `exports` with no `main`
 * (like the E2E fixture `express`) threw MODULE_NOT_FOUND.
 *
 * Node parity: when `exports` is present, `main` is ignored entirely, and
 * resolution uses the `require` condition set ["node", "require", "default"]
 * for `require()`/`require.resolve()` (vs ["node", "import", "default"]
 * for `import`).
 *
 * This test drives the REAL `Module._resolveFilename` from src/module.js
 * against a fake `globalThis._RUNTIME_.__FS__` VFS — no copies.
 */

const Module = shim.Module || shim.default;

const FILES = {
  "/node_modules/express/package.json": JSON.stringify({
    name: "express",
    exports: { ".": { require: "./cjs.js", import: "./esm.js" } },
  }),
  "/node_modules/express/cjs.js": 'module.exports = { flavor: "cjs" };',
  "/node_modules/express/esm.js": 'export const flavor = "esm";',
  // exports wins over main when both are present.
  "/node_modules/both-pkg/package.json": JSON.stringify({
    name: "both-pkg",
    main: "./legacy.js",
    exports: { ".": { require: "./cjs.js", import: "./esm.js" } },
  }),
  "/node_modules/both-pkg/cjs.js": "module.exports = { cjs: true };",
  "/node_modules/both-pkg/esm.js": "module.exports = { esm: true };",
  "/node_modules/both-pkg/legacy.js": "module.exports = { legacy: true };",
  // exports present but subpath not exported: honest miss.
  "/node_modules/locked-pkg/package.json": JSON.stringify({
    name: "locked-pkg",
    exports: { ".": "./index.js" },
  }),
  "/node_modules/locked-pkg/index.js": "module.exports = { locked: true };",
  "/node_modules/locked-pkg/secret.js": "module.exports = { secret: true };",
  "/consumer.mjs": "x",
};

function installVfs() {
  globalThis._RUNTIME_ = {
    __FS__: {
      statSync(p) {
        if (FILES[p] !== undefined)
          return { isDirectory: () => false, isFile: () => true };
        const pref = p.endsWith("/") ? p : p + "/";
        if (Object.keys(FILES).some((k) => k.startsWith(pref)))
          return { isDirectory: () => true, isFile: () => false };
        const e = new Error(
          "ENOENT: no such file or directory, stat '" + p + "'",
        );
        e.code = "ENOENT";
        throw e;
      },
      readFileSync(p) {
        if (FILES[p] === undefined) {
          const e = new Error(
            "ENOENT: no such file or directory, open '" + p + "'",
          );
          e.code = "ENOENT";
          throw e;
        }
        return FILES[p];
      },
    },
  };
}

afterEach(() => {
  delete globalThis._RUNTIME_;
});

describe("Module._resolveFilename: package exports field (require condition)", () => {
  // Drive the genuine entry path: createRequire("/consumer.mjs").resolve()
  // (what the sandbox does for createRequire(import.meta.url)).
  test("exports-only package resolves via the require condition", () => {
    installVfs();
    const require = Module.createRequire("/consumer.mjs");
    expect(require.resolve("express")).toBe("/node_modules/express/cjs.js");
  });

  test("exports wins over main when both are present", () => {
    installVfs();
    const require = Module.createRequire("/consumer.mjs");
    expect(require.resolve("both-pkg")).toBe("/node_modules/both-pkg/cjs.js");
  });

  test("unexported subpath is an honest miss even when the file exists", () => {
    installVfs();
    const require = Module.createRequire("/consumer.mjs");
    expect(() => require.resolve("locked-pkg/secret")).toThrow(
      /NOT_EXPORTED|MODULE_NOT_FOUND/,
    );
  });
});
