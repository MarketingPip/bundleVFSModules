import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import * as shim from "../src/module.js";
import {
  interceptNativeSpecifier,
  lookupNativeInterception,
} from "../src/browser-builds.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The "rollup" specifier must resolve to the ESM browser build with correct
 * ESM named linkage. The CJS dist/rollup.browser.js cannot satisfy
 * `import { rollup } from "rollup"` — Node throws
 * "SyntaxError: Named export 'rollup' not found" at link time. That is the
 * regression this file pins: the interception target must stay the ESM
 * build at ROLLUP_BROWSER_MAIN.
 *
 * Every green below imports the REAL installed vendor file found at the
 * table's target (never a fixture), so a table regression back to the CJS
 * path fails these tests instead of silently shipping broken linkage.
 *
 * Two table entry points, matching the two consumption paths:
 * - lookupNativeInterception: ungated pure table, used by the host
 *   _dynamic_import handler (the ESM `import "rollup"` path).
 * - interceptNativeSpecifier: gated on the browser-lane VFS
 *   (globalThis._RUNTIME_.__FS__), used by src/module.js (the
 *   createRequire path). Needs the lane mock attached (beforeAll below).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NM = path.join(__dirname, "..", "node_modules");
const ROLLUP_BROWSER_MAIN =
  "/node_modules/@rollup/browser/dist/es/rollup.browser.js";
const ROLLUP_VERSION = JSON.parse(
  fs.readFileSync(path.join(NM, "@rollup/browser", "package.json"), "utf8"),
).version;

// Browser-lane mock: the require path consumes the build through CJS
// interop, so this seeds the CJS content exactly as build-vfs.mjs does for
// the require lane. The ESM linkage is pinned by the import tests below.
const laneFiles = {
  "/vapp/main.js": "module.exports = 1;",
  "/node_modules/@rollup/browser/package.json": fs.readFileSync(
    path.join(NM, "@rollup/browser", "package.json"),
    "utf8",
  ),
  [ROLLUP_BROWSER_MAIN]: fs.readFileSync(
    path.join(NM, "@rollup/browser", "dist", "rollup.browser.js"),
    "utf8",
  ),
};
const enoent = (p) =>
  Object.assign(new Error(`ENOENT: '${p}'`), { code: "ENOENT" });
const laneFS = {
  readFileSync(p, enc) {
    const c = laneFiles[p];
    if (c === undefined) throw enoent(p);
    return enc ? c : Buffer.from(c);
  },
  statSync(p) {
    const isF = Object.prototype.hasOwnProperty.call(laneFiles, p);
    const prefix = p.endsWith("/") ? p : `${p}/`;
    const isD = Object.keys(laneFiles).some((k) => k.startsWith(prefix));
    if (!isF && !isD) throw enoent(p);
    return { isFile: () => isF, isDirectory: () => !isF && isD };
  },
  realpathSync: (p) => p,
};

let savedGetBuiltin, savedRT;
beforeAll(() => {
  savedGetBuiltin = process.getBuiltinModule;
  process.getBuiltinModule = () => {
    throw new Error("native delegation disabled for browser lane");
  };
  savedRT = globalThis._RUNTIME_;
  globalThis._RUNTIME_ = {
    __FS__: laneFS,
    process: { env: {} },
    loadModule: () => undefined,
  };
  shim._initPaths();
});
afterAll(() => {
  process.getBuiltinModule = savedGetBuiltin;
  if (savedRT === undefined) delete globalThis._RUNTIME_;
  else globalThis._RUNTIME_ = savedRT;
  shim._initPaths();
});

// The table target is a VFS path (/node_modules/...); map it onto the real
// install for execution. Copies to a temp dir with the WASM beside it,
// exactly as the VFS seed lays them out.
async function importTargetAsEsm() {
  const target = lookupNativeInterception("rollup");
  expect(target).toBe(ROLLUP_BROWSER_MAIN);
  const realJs = path.join(NM, target.replace(/^\/node_modules\//, ""));
  const realWasm = path.join(
    path.dirname(path.dirname(realJs)),
    "bindings_wasm_bg.wasm",
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rollup-esm-target-"));
  fs.copyFileSync(realJs, path.join(dir, "rollup.browser.js"));
  fs.copyFileSync(realWasm, path.join(dir, "bindings_wasm_bg.wasm"));
  return import(pathToFileURL(path.join(dir, "rollup.browser.js")).href);
}

describe("red: the CJS build fails ESM named linkage", () => {
  // NOTE: loaded via data: URLs, which are always parsed as pure ESM —
  // exactly how the browser sandbox consumes the served file (no Node CJS
  // interop). Under plain Node file-URL import, cjs-module-lexer's static
  // analysis happens to detect the exports; the browser has no such lane.
  const cjsDataUrl = () =>
    "data:text/javascript;base64," +
    Buffer.from(
      fs.readFileSync(
        path.join(NM, "@rollup/browser", "dist", "rollup.browser.js"),
        "utf8",
      ),
    ).toString("base64");

  test("static import { rollup } from the CJS build throws at link time", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rollup-cjs-link-"));
    const entry = path.join(dir, "entry.mjs");
    fs.writeFileSync(
      entry,
      `import { rollup } from ${JSON.stringify(cjsDataUrl())};\n` +
        `globalThis.__rollup = rollup;\n`,
    );
    await expect(import(pathToFileURL(entry).href)).rejects.toThrow(
      /does not provide an export named 'rollup'/,
    );
  });

  test("CJS build loaded as ESM exposes no named exports", async () => {
    const ns = await import(cjsDataUrl());
    expect(ns.rollup).toBeUndefined();
    expect(ns.VERSION).toBeUndefined();
    expect(ns.defineConfig).toBeUndefined();
  });
});

describe("green: 'rollup' resolves to the ESM build with named exports", () => {
  test("host table (lookupNativeInterception) points 'rollup' at the ESM build", () => {
    expect(lookupNativeInterception("rollup")).toBe(ROLLUP_BROWSER_MAIN);
  });

  test("lane table (interceptNativeSpecifier) points 'rollup' at the ESM build", () => {
    expect(interceptNativeSpecifier("rollup")).toBe(ROLLUP_BROWSER_MAIN);
  });

  test("real ESM import of the target exposes VERSION, defineConfig, rollup", async () => {
    const mod = await importTargetAsEsm();
    expect(mod.VERSION).toBe(ROLLUP_VERSION);
    expect(typeof mod.defineConfig).toBe("function");
    expect(typeof mod.rollup).toBe("function");
  });

  test("static named import from the target links without SyntaxError", async () => {
    const target = lookupNativeInterception("rollup");
    const realJs = path.join(NM, target.replace(/^\/node_modules\//, ""));
    const realWasm = path.join(
      path.dirname(path.dirname(realJs)),
      "bindings_wasm_bg.wasm",
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rollup-esm-static-"));
    fs.copyFileSync(realJs, path.join(dir, "rollup.browser.js"));
    fs.copyFileSync(realWasm, path.join(dir, "bindings_wasm_bg.wasm"));
    const entry = path.join(dir, "entry.mjs");
    fs.writeFileSync(
      entry,
      `import { rollup, VERSION, defineConfig } from "./rollup.browser.js";\n` +
        `export const check = [typeof rollup, typeof defineConfig, VERSION].join(",");\n`,
    );
    const ns = await import(pathToFileURL(entry).href);
    expect(ns.check).toBe(`function,function,${ROLLUP_VERSION}`);
  });
});

describe("green: createRequire('rollup') resolves to the same target", () => {
  test("createRequire('/vapp/main.js')('rollup') exposes VERSION, defineConfig, rollup", () => {
    const req = shim.createRequire("/vapp/main.js");
    const mod = req("rollup");
    expect(mod.VERSION).toBe(ROLLUP_VERSION);
    expect(typeof mod.defineConfig).toBe("function");
    expect(typeof mod.rollup).toBe("function");
  });

  test("require.resolve('rollup') === ROLLUP_BROWSER_MAIN", () => {
    const req = shim.createRequire("/vapp/main.js");
    expect(req.resolve("rollup")).toBe(ROLLUP_BROWSER_MAIN);
  });
});
