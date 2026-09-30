import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import * as shim from "../src/module.js";
import { interceptNativeSpecifier } from "../src/browser-builds.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * M1 — require-interception: native-only package specifiers are redirected
 * to the vendors' own browser/WASM builds, through the project runtime
 * (browser lane: native delegation disabled, VFS-backed __FS__).
 *
 *   require('rollup') / import 'rollup' -> @rollup/browser (official browser build)
 *   require('esbuild')                -> esbuild-wasm wrapper (M2)
 *
 * No silent fakes: the VFS is seeded with the REAL installed vendor files,
 * and every green asserts real behavior (VERSION match, real exports).
 * Native rollup/esbuild packages are NOT installed, so any load of them
 * would fail — the interception is the only way these specifiers resolve.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NM = path.join(__dirname, "..", "node_modules");

function readVendorFile(pkg, rel) {
  return fs.readFileSync(path.join(NM, pkg, rel), "utf8");
}

const ROLLUP_BROWSER_VERSION = JSON.parse(
  readVendorFile("@rollup/browser", "package.json"),
).version;

const ROLLUP_BROWSER_MAIN =
  "/node_modules/@rollup/browser/dist/es/rollup.browser.js";
const ESBUILD_SHIM_PATH = "/node_modules/.bvm/esbuild-shim.cjs";
const ESBUILD_WASM_VERSION = JSON.parse(
  readVendorFile("esbuild-wasm", "package.json"),
).version;

// The shim wrapper source lives in the repo; the VFS seed loads it like
// build-vfs.mjs will in production. Guarded so M1 stays green while M2 is red.
const esbuildShimSrcPath = path.join(
  __dirname,
  "..",
  "src",
  "vendor",
  "esbuild-shim.cjs",
);

// VFS seed: the real installed vendor builds, byte-identical to node_modules.
const laneFiles = {
  "/vapp/main.js": "module.exports = 1;",
  "/node_modules/@rollup/browser/package.json": readVendorFile(
    "@rollup/browser",
    "package.json",
  ),
  [ROLLUP_BROWSER_MAIN]: readVendorFile(
    "@rollup/browser",
    "dist/rollup.browser.js",
  ),
  "/node_modules/esbuild-wasm/package.json": readVendorFile(
    "esbuild-wasm",
    "package.json",
  ),
  "/node_modules/esbuild-wasm/lib/browser.js": readVendorFile(
    "esbuild-wasm",
    "lib/browser.js",
  ),
  "/node_modules/esbuild-wasm/esbuild.wasm": fs.readFileSync(
    path.join(NM, "esbuild-wasm", "esbuild.wasm"),
  ),
  [ESBUILD_SHIM_PATH]: fs.existsSync(esbuildShimSrcPath)
    ? fs.readFileSync(esbuildShimSrcPath, "utf8")
    : "throw new Error('M2 NOT IMPLEMENTED: esbuild-shim.cjs missing');",
};

function makeLaneFS(files) {
  const enoent = (p) =>
    Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), {
      code: "ENOENT",
    });
  return {
    readFileSync(p, enc) {
      const c = files[p];
      if (c === undefined) throw enoent(p);
      return enc ? c : Buffer.from(c);
    },
    statSync(p) {
      const isF = Object.prototype.hasOwnProperty.call(files, p);
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const isD = Object.keys(files).some((k) => k.startsWith(prefix));
      if (!isF && !isD) throw enoent(p);
      return { isFile: () => isF, isDirectory: () => !isF && isD };
    },
    realpathSync: (p) => p,
  };
}

let savedGetBuiltin;
let savedRT;

beforeAll(() => {
  savedGetBuiltin = process.getBuiltinModule;
  process.getBuiltinModule = () => {
    throw new Error("native delegation disabled for browser lane");
  };
  savedRT = globalThis._RUNTIME_;
  globalThis._RUNTIME_ = {
    __FS__: makeLaneFS(laneFiles),
    process: { env: {} },
    loadModule: () => undefined,
  };
  shim._initPaths(); // re-run as the sandbox would at boot
});

afterAll(() => {
  process.getBuiltinModule = savedGetBuiltin;
  if (savedRT === undefined) delete globalThis._RUNTIME_;
  else globalThis._RUNTIME_ = savedRT;
  shim._initPaths();
});

describe("M1: rollup → @rollup/browser interception", () => {
  test("rewrite table maps bare 'rollup' to the browser build", () => {
    expect(interceptNativeSpecifier("rollup")).toBe(ROLLUP_BROWSER_MAIN);
  });

  test("rollup subpaths map into @rollup/browser", () => {
    expect(interceptNativeSpecifier("rollup/dist/es/rollup.browser.js")).toBe(
      "/node_modules/@rollup/browser/dist/es/rollup.browser.js",
    );
  });

  test("does not intercept @rollup/browser itself, vite, builtins, or relative paths", () => {
    expect(interceptNativeSpecifier("@rollup/browser")).toBeNull();
    expect(interceptNativeSpecifier("vite")).toBeNull();
    expect(interceptNativeSpecifier("node:fs")).toBeNull();
    expect(interceptNativeSpecifier("./relative.js")).toBeNull();
    expect(interceptNativeSpecifier("/absolute/path.js")).toBeNull();
  });

  test("require('rollup') through the runtime returns the browser build", () => {
    const req = shim.createRequire("/vapp/main.js");
    const rollup = req("rollup");
    expect(rollup.VERSION).toBe(ROLLUP_BROWSER_VERSION);
    expect(rollup.VERSION).toMatch(/^4\./);
    expect(typeof rollup.rollup).toBe("function");
  });

  test("require.resolve('rollup') points at the browser build, never a native binding", () => {
    const req = shim.createRequire("/vapp/main.js");
    const resolved = req.resolve("rollup");
    expect(resolved).toBe(ROLLUP_BROWSER_MAIN);
    // No native platform package (@rollup/rollup-linux-*, etc.) in the path.
    expect(resolved).not.toMatch(/@rollup\/rollup-/);
    expect(resolved).not.toContain(".node");
  });

  test("repeated require('rollup') returns the cached module", () => {
    const req = shim.createRequire("/vapp/main.js");
    expect(req("rollup")).toBe(req("rollup"));
  });

  test("import-style specifiers resolve through the same table", () => {
    // The host import path consults the same specifier table; the rewrite
    // is specifier-based, so ESM `import 'rollup'` gets the browser build.
    expect(interceptNativeSpecifier("rollup")).toBe(ROLLUP_BROWSER_MAIN);
    const req = shim.createRequire("/vapp/main.js");
    expect(req.resolve("rollup")).toBe(ROLLUP_BROWSER_MAIN);
  });
});

describe("M2: esbuild → esbuild-wasm interception", () => {
  test("rewrite table maps bare 'esbuild' to the auto-init shim", () => {
    expect(interceptNativeSpecifier("esbuild")).toBe(ESBUILD_SHIM_PATH);
  });

  test("esbuild subpaths map to the shim; native @esbuild/* packages are not faked", () => {
    expect(interceptNativeSpecifier("esbuild/lib/main.js")).toBe(
      ESBUILD_SHIM_PATH,
    );
    expect(interceptNativeSpecifier("@esbuild/linux-x64")).toBeNull();
    expect(interceptNativeSpecifier("@esbuild/darwin-arm64")).toBeNull();
  });

  test("require('esbuild') returns the WASM build and transforms for real", async () => {
    const req = shim.createRequire("/vapp/main.js");
    const esbuild = req("esbuild");
    expect(esbuild.version).toBe(ESBUILD_WASM_VERSION);
    // No explicit initialize() call: the interception handles async init
    // transparently (Vite imports esbuild synchronously and never inits).
    const out = await esbuild.transform("const x: number = 1", {
      loader: "ts",
    });
    expect(out.code).toContain("const x = 1");
  });

  test("explicit initialize() is idempotent through the shim", async () => {
    const req = shim.createRequire("/vapp/main.js");
    const esbuild = req("esbuild");
    await expect(esbuild.initialize()).resolves.toBeUndefined();
    const out = await esbuild.transform("let y: string = 'a'", {
      loader: "ts",
    });
    expect(out.code).toContain('let y = "a"');
  });
});
