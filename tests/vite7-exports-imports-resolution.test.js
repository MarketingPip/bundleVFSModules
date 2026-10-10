import { describe, test, expect, afterEach } from "@jest/globals";
import * as shim from "../src/module.js";

/**
 * vite7-exports-imports-resolution.test.js
 *
 * Full Node-semantics `exports` / `imports` field resolution for the
 * sync-require VFS resolver (src/module.js). Every expectation below was
 * verified against real Node v24.20.0 as the oracle (require() over
 * on-disk fixtures in /tmp/exports-oracle) before being pinned here.
 *
 * Covered:
 *  - exports: string, top-level array, conditional object, subpath map,
 *    condition-sugar, mid-string subpath patterns (./features/*.js)
 *  - condition priority is object key insertion order (Node parity:
 *    {"default":...,"node":...} resolves "default" under require())
 *  - a matched condition with a null target is TERMINAL ->
 *    ERR_PACKAGE_PATH_NOT_EXPORTED (no fallthrough to later keys)
 *  - exports targets resolve verbatim: no extension probing, no directory
 *    probing; a missing target file is MODULE_NOT_FOUND
 *  - exports targets must be ./-relative and stay inside the package ->
 *    ERR_INVALID_PACKAGE_TARGET otherwise
 *  - mixed "." and condition keys -> ERR_INVALID_PACKAGE_CONFIG
 *  - encapsulation: subpaths absent from exports throw
 *    ERR_PACKAGE_PATH_NOT_EXPORTED even when the file exists
 *  - exports wins over main when both are present
 *  - imports: # exact, # mid-string patterns, # conditional, # external
 *    bare-specifier targets, nearest-scope wins, verbatim targets
 *    (no extension probing), missing target -> MODULE_NOT_FOUND,
 *    #-prefixed targets are NOT re-resolved through imports
 *
 * Drives the REAL Module._resolveFilename from src/module.js against a
 * fake globalThis._RUNTIME_.__FS__ VFS — no copies.
 */

const Module = shim.Module || shim.default;

const FILES = {
  // --- exports: top-level array form ---
  "/node_modules/arr-pkg/package.json": JSON.stringify({
    name: "arr-pkg",
    exports: ["./a.js", "./b.js"],
  }),
  "/node_modules/arr-pkg/a.js": 'module.exports = "arr-a";',
  "/node_modules/arr-pkg/b.js": 'module.exports = "arr-b";',
  // first array entry missing -> MODULE_NOT_FOUND (no fallback on files)
  "/node_modules/arr-missing-pkg/package.json": JSON.stringify({
    name: "arr-missing-pkg",
    exports: ["./gone.js", "./b.js"],
  }),
  "/node_modules/arr-missing-pkg/b.js": 'module.exports = "arr-b";',

  // --- exports: mid-string subpath patterns ---
  "/node_modules/pat-pkg/package.json": JSON.stringify({
    name: "pat-pkg",
    exports: {
      ".": "./dist/main.js",
      "./features/*.js": "./dist/features/*.js",
    },
  }),
  "/node_modules/pat-pkg/dist/main.js": 'module.exports = "main";',
  "/node_modules/pat-pkg/dist/features/x.js": 'module.exports = "feat-x";',
  "/node_modules/pat-pkg/dist/features/a/b.js": 'module.exports = "feat-ab";',
  "/node_modules/pat-pkg/secret.js": 'module.exports = "secret";',

  // --- exports: matched null condition is terminal ---
  "/node_modules/nullcond-pkg/package.json": JSON.stringify({
    name: "nullcond-pkg",
    exports: { ".": { node: null, default: "./d.js" } },
  }),
  "/node_modules/nullcond-pkg/d.js": 'module.exports = "d";',

  // --- exports: condition priority = key insertion order ---
  "/node_modules/prio-pkg/package.json": JSON.stringify({
    name: "prio-pkg",
    exports: { ".": { default: "./d.js", node: "./n.js", require: "./r.js" } },
  }),
  "/node_modules/prio-pkg/d.js": 'module.exports = "d";',
  "/node_modules/prio-pkg/n.js": 'module.exports = "n";',
  "/node_modules/prio-pkg/r.js": 'module.exports = "r";',

  // --- exports: target file missing -> MODULE_NOT_FOUND ---
  "/node_modules/missfile-pkg/package.json": JSON.stringify({
    name: "missfile-pkg",
    exports: { ".": "./missing.js" },
  }),
  // --- exports: no extension probing on targets ---
  "/node_modules/noext-pkg/package.json": JSON.stringify({
    name: "noext-pkg",
    exports: { ".": "./a" },
  }),
  "/node_modules/noext-pkg/a.js": 'module.exports = "a";',

  // --- exports: mixed subpath + condition keys -> invalid config ---
  "/node_modules/mix-pkg/package.json": JSON.stringify({
    name: "mix-pkg",
    exports: { ".": "./a.js", node: "./b.js" },
  }),
  "/node_modules/mix-pkg/a.js": 'module.exports = "a";',
  "/node_modules/mix-pkg/b.js": 'module.exports = "b";',

  // --- exports: external / escaping targets -> invalid target ---
  "/node_modules/xternal-pkg/package.json": JSON.stringify({
    name: "xternal-pkg",
    exports: { ".": "ext-pkg" },
  }),
  "/node_modules/xternal-pkg/index.js": 'module.exports = "x";',
  "/node_modules/escape-pkg/package.json": JSON.stringify({
    name: "escape-pkg",
    exports: { ".": "../evil.js" },
  }),

  // --- imports fixtures (scope: /app) ---
  "/app/package.json": JSON.stringify({
    name: "app",
    imports: {
      "#utils": "./src/utils.js",
      "#ext": "ext-pkg",
      "#cond": { node: "ext-pkg", default: "./src/d.js" },
      "#lib/*.js": "./src/lib/*.js",
      "#gone": "./gone.js",
      "#noext": "./src/utils",
      "#hash": "#hash",
    },
  }),
  "/app/entry.js": "module.exports = {};",
  "/app/src/utils.js": 'module.exports = "utils";',
  "/app/src/d.js": 'module.exports = "d";',
  "/app/src/lib/x.js": 'module.exports = "lib-x";',
  "/node_modules/ext-pkg/package.json": JSON.stringify({
    name: "ext-pkg",
    main: "./index.js",
  }),
  "/node_modules/ext-pkg/index.js": 'module.exports = "ext";',
  // --- imports at the filesystem root scope ("/") ---
  "/package.json": JSON.stringify({
    name: "root-app",
    imports: { "#root": "./src/root.js" },
  }),
  "/src/root.js": 'module.exports = "root-ok";',
  "/root-entry.js": "module.exports = {};",
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

function resolveFromApp(request) {
  installVfs();
  return Module.createRequire("/app/entry.js").resolve(request);
}

function resolveCode(request) {
  try {
    resolveFromApp(request);
  } catch (e) {
    return e.code;
  }
  return "NO_THROW";
}

describe("exports field: every form (Node oracle v24.20.0)", () => {
  test("top-level array: first entry wins", () => {
    expect(resolveFromApp("arr-pkg")).toBe("/node_modules/arr-pkg/a.js");
  });

  test("top-level array: missing first file is MODULE_NOT_FOUND, not fallback", () => {
    expect(resolveCode("arr-missing-pkg")).toBe("MODULE_NOT_FOUND");
  });

  test("mid-string subpath pattern ./features/*.js", () => {
    expect(resolveFromApp("pat-pkg/features/x.js")).toBe(
      "/node_modules/pat-pkg/dist/features/x.js",
    );
  });

  test("pattern star may span directories", () => {
    expect(resolveFromApp("pat-pkg/features/a/b.js")).toBe(
      "/node_modules/pat-pkg/dist/features/a/b.js",
    );
  });

  test("pattern with empty star does not match", () => {
    expect(resolveCode("pat-pkg/features/.js")).toBe(
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
  });

  test("matched null condition is terminal (no fallthrough to default)", () => {
    expect(resolveCode("nullcond-pkg")).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });

  test("condition priority follows key insertion order", () => {
    // {"default":..., "node":..., "require":...} -> "default" wins under require()
    expect(resolveFromApp("prio-pkg")).toBe("/node_modules/prio-pkg/d.js");
  });

  test("exports target file missing -> MODULE_NOT_FOUND", () => {
    expect(resolveCode("missfile-pkg")).toBe("MODULE_NOT_FOUND");
  });

  test("exports targets resolve verbatim: no extension probing", () => {
    expect(resolveCode("noext-pkg")).toBe("MODULE_NOT_FOUND");
  });

  test("mixed subpath + condition keys -> ERR_INVALID_PACKAGE_CONFIG", () => {
    expect(resolveCode("mix-pkg")).toBe("ERR_INVALID_PACKAGE_CONFIG");
  });

  test("exports external target -> ERR_INVALID_PACKAGE_TARGET", () => {
    expect(resolveCode("xternal-pkg")).toBe("ERR_INVALID_PACKAGE_TARGET");
  });

  test("exports target escaping the package -> ERR_INVALID_PACKAGE_TARGET", () => {
    expect(resolveCode("escape-pkg")).toBe("ERR_INVALID_PACKAGE_TARGET");
  });

  test("unexported subpath is encapsulated even when the file exists", () => {
    expect(resolveCode("pat-pkg/secret.js")).toBe(
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
  });
});

describe("imports field: # specifiers (Node oracle v24.20.0)", () => {
  test("#utils exact mapping", () => {
    expect(resolveFromApp("#utils")).toBe("/app/src/utils.js");
  });

  test("# external bare-specifier target resolves via node_modules", () => {
    expect(resolveFromApp("#ext")).toBe("/node_modules/ext-pkg/index.js");
  });

  test("# conditional with external target picks node condition", () => {
    expect(resolveFromApp("#cond")).toBe("/node_modules/ext-pkg/index.js");
  });

  test("# mid-string pattern #lib/*.js", () => {
    expect(resolveFromApp("#lib/x.js")).toBe("/app/src/lib/x.js");
  });

  test("# target file missing -> MODULE_NOT_FOUND (verbatim, no probing)", () => {
    expect(resolveCode("#gone")).toBe("MODULE_NOT_FOUND");
  });

  test("# target without extension does not probe extensions", () => {
    expect(resolveCode("#noext")).toBe("MODULE_NOT_FOUND");
  });

  test("#-prefixed target is not re-resolved through imports (no hang)", () => {
    expect(resolveCode("#hash")).toBe("MODULE_NOT_FOUND");
  });

  test("unmapped # specifier -> ERR_PACKAGE_IMPORT_NOT_DEFINED", () => {
    expect(resolveCode("#nope")).toBe("ERR_PACKAGE_IMPORT_NOT_DEFINED");
  });

  test("# specifier resolves from the filesystem-root scope", () => {
    installVfs();
    const resolved = Module.createRequire("/root-entry.js").resolve("#root");
    expect(resolved).toBe("/src/root.js");
  });
});
