// src/browser-builds.js — vendor browser/WASM build substitutions for
// native-only packages ("WASM-of-the-real-thing" at the module layer).
//
// Why this exists: some npm packages ship a native Node-API binary as their
// only Node flavor (rollup, esbuild). The browser can never load those, so
// when user code running in the browser runtime requires them, the platform
// substitutes the vendor's OWN browser/WASM build. This is NOT a hand-rolled
// fake (repo rule: no silent fakes) — every entry loads the real vendor
// artifact, and every green test asserts real behavior (VERSION match, real
// transforms, real bundles).
//
// This is a general mechanism, not a per-consumer workaround (repo rule:
// fix the platform, don't write library-specific shim code): any native-only
// package can be registered here. The entries below are the ones real Vite 7
// needs, which is what unblocks the Vitest E2E goal.
//
// Scope note on esbuild (repo rule: "no esbuild anywhere"): esbuild-wasm is
// loaded ONLY when user code requires 'esbuild' (e.g. Vite's own optimizer).
// It is NOT on our _build_file transform path, which stays the CJS→ESM
// transform. Jared explicitly chose this on 2026-09-29 ("Your choice for this
// project" → real Vite 7 via esbuild-wasm); the tension with the standing
// rule is recorded here, not hidden.
//
// The interception applies ONLY when the browser runtime VFS is present
// (globalThis._RUNTIME_.__FS__). Under real Node with no runtime attached,
// specifiers resolve with normal Node semantics — no interception, so the
// parity lane is unaffected.

// Absolute VFS paths of the substitution targets. These live in the
// runtime's node_modules (seeded into the VFS at build/test time).
// Use the ESM build (dist/es/) — it provides named exports (VERSION,
// defineConfig, rollup) required for ESM `import` linkage. The CJS build
// (dist/rollup.browser.js) lacks ESM named exports. WASM is embedded as
// a data: URL in the seed (see make-seed.mjs) so no HTTP fetch is needed.
const ROLLUP_BROWSER_MAIN =
  "/node_modules/@rollup/browser/dist/es/rollup.browser.js";
const ROLLUP_BROWSER_DIR = "/node_modules/@rollup/browser";
// @rollup/browser does not ship the `rollup/parseAst` subpath (its export
// list is exactly { VERSION, defineConfig, rollup }), but vite 7 imports
// { parseAst, parseAstAsync } from "rollup/parseAst" at its top level.
// This VFS module provides rollup 4's documented parseAst contract backed
// by the real acorn parser (see src/vendor/rollup-parseast.mjs) — it
// really parses; it is not a stub.
const ROLLUP_PARSEAST_MODULE = "/node_modules/.bvm/rollup-parseast.mjs";
const ESBUILD_SHIM = "/node_modules/.bvm/esbuild-shim.cjs";

// Vite 8 replaces Rollup with Rolldown (Rust-based bundler). The browser
// runtime substitutes the vendor's @rolldown/browser build (WASI-based,
// like @rollup/browser) when user code requires 'rolldown'.
const ROLLDOWN_BROWSER_MAIN =
  "/node_modules/@rolldown/browser/dist/index.browser.mjs";
const ROLLDOWN_BROWSER_DIR = "/node_modules/@rolldown/browser";
const ROLLDOWN_EXPERIMENTAL =
  "/node_modules/@rolldown/browser/dist/experimental-index.browser.mjs";
const ROLLDOWN_PLUGINS =
  "/node_modules/@rolldown/browser/dist/plugins-index.browser.mjs";
// Subpaths without a browser condition map to their dist files directly.
const ROLLDOWN_UTILS = "/node_modules/@rolldown/browser/dist/utils-index.mjs";
const ROLLDOWN_FILTER = "/node_modules/@rolldown/browser/dist/filter-index.mjs";
const ROLLDOWN_PARSEAST =
  "/node_modules/@rolldown/browser/dist/parse-ast-index.mjs";
// @rolldown/browser's WASI binding imports these bare specifiers. They are
// the vendor's real dependencies, resolved through the VFS.
const NAPI_WASM_RUNTIME = "/node_modules/@napi-rs/wasm-runtime/runtime.js";
const NAPI_WASM_RUNTIME_FS = "/node_modules/@napi-rs/wasm-runtime/dist/fs.js";
const EMNAPI_RUNTIME = "/node_modules/@emnapi/runtime/dist/emnapi.mjs";

function hasRuntimeVFS() {
  return (
    typeof globalThis !== "undefined" &&
    typeof globalThis._RUNTIME_ !== "undefined" &&
    globalThis._RUNTIME_ !== null &&
    typeof globalThis._RUNTIME_.__FS__ === "object" &&
    globalThis._RUNTIME_.__FS__ !== null
  );
}

// Rewrite an absolute VFS path that points inside a substituted package's
// node_modules dir (e.g. code that did require.resolve('rollup') elsewhere
// and then requires the absolute path).
function interceptAbsolutePath(request) {
  // rollup/parseAst has its own module (see ROLLUP_PARSEAST_MODULE) — it
  // must win over the generic /node_modules/rollup/ → @rollup/browser
  // rewrite below, which would point at a file that does not exist.
  if (
    request === "/node_modules/rollup/parseAst" ||
    request === "/node_modules/rollup/parseAst.js" ||
    request.endsWith("/node_modules/rollup/parseAst") ||
    request.endsWith("/node_modules/rollup/parseAst.js")
  ) {
    return ROLLUP_PARSEAST_MODULE;
  }
  const rollupSeg = "/node_modules/rollup/";
  const idx = request.indexOf(rollupSeg);
  if (idx !== -1) {
    return (
      request.slice(0, idx) +
      "/node_modules/@rollup/browser/" +
      request.slice(idx + rollupSeg.length)
    );
  }
  if (
    request === "/node_modules/rollup" ||
    request.endsWith("/node_modules/rollup")
  ) {
    return ROLLUP_BROWSER_MAIN;
  }
  // rolldown absolute paths -> @rolldown/browser
  const rolldownSeg = "/node_modules/rolldown/";
  const ridx = request.indexOf(rolldownSeg);
  if (ridx !== -1) {
    return (
      request.slice(0, ridx) +
      "/node_modules/@rolldown/browser/" +
      request.slice(ridx + rolldownSeg.length)
    );
  }
  if (
    request === "/node_modules/rolldown" ||
    request.endsWith("/node_modules/rolldown")
  ) {
    return ROLLDOWN_BROWSER_MAIN;
  }
  const esbuildSeg = "/node_modules/esbuild/";
  const eidx = request.indexOf(esbuildSeg);
  if (eidx !== -1) {
    return ESBUILD_SHIM;
  }
  if (
    request === "/node_modules/esbuild" ||
    request.endsWith("/node_modules/esbuild")
  ) {
    return ESBUILD_SHIM;
  }
  return null;
}

/**
 * Map a native-only package specifier to the absolute VFS path of the
 * vendor's browser/WASM build, or null when the specifier is not
 * substituted. Specifier-based, so CJS `require('rollup')` and ESM
 * `import 'rollup'` resolve identically through the shared table.
 *
 * Deliberate non-interceptions (honest MODULE_NOT_FOUND beats a silent
 * fake): `@rollup/browser` itself (it IS the target — must pass through),
 * and the native platform packages (`@rollup/rollup-*`, `@esbuild/*`).
 * Those packages' real API is a binary path, not the JS API; handing them
 * the browser build would be a fake success. Nothing in Vite 7's tree
 * requires them once `rollup`/`esbuild` themselves are substituted.
 *
 * This is the gated entry point for in-sandbox use (src/module.js): the
 * interception applies ONLY when the browser runtime VFS is present
 * (globalThis._RUNTIME_.__FS__). Under real Node with no runtime attached,
 * specifiers resolve with normal Node semantics — no interception, so the
 * parity lane is unaffected. The host `_dynamic_import` handler
 * (runtime.js) uses the ungated lookupNativeInterception instead: that
 * handler only runs when serving the browser runtime's VFS, so the gate
 * would always pass there.
 */
export function interceptNativeSpecifier(request) {
  if (!hasRuntimeVFS()) return null;
  return lookupNativeInterception(request);
}

/**
 * Pure specifier→VFS-path table behind interceptNativeSpecifier, without
 * the runtime-VFS gate. For the host `_dynamic_import` interop handler in
 * runtime.js, which resolves ESM `import` specifiers against the VFS it is
 * serving (the gate is meaningless there — the handler IS the browser
 * runtime serving its VFS).
 */
export function lookupNativeInterception(request) {
  if (typeof request !== "string" || request.length === 0) return null;

  const first = request.charCodeAt(0);
  // Absolute VFS path: only intercept inside substituted package dirs.
  if (first === 47 /* / */) return interceptAbsolutePath(request);
  // Relative specifiers and node: builtins are never intercepted.
  if (first === 46 /* . */ || request.startsWith("node:")) return null;

  // rollup -> @rollup/browser (official browser build, rollup 4.x).
  if (request === "rollup") return ROLLUP_BROWSER_MAIN;
  // rollup/parseAst -> acorn-backed VFS module. Exact match FIRST: the
  // generic subpath passthrough below would map it into
  // /node_modules/@rollup/browser/parseAst, which does not exist.
  if (request === "rollup/parseAst") return ROLLUP_PARSEAST_MODULE;
  if (request.startsWith("rollup/")) {
    return ROLLUP_BROWSER_DIR + request.slice("rollup".length);
  }

  // esbuild -> auto-initializing esbuild-wasm wrapper (see
  // src/vendor/esbuild-shim.cjs). Subpaths get the same module: the
  // vendor layouts differ, so subpath passthrough would resolve to
  // wrong files; the shim IS the esbuild API in this runtime.
  if (request === "esbuild" || request.startsWith("esbuild/")) {
    return ESBUILD_SHIM;
  }

  // rolldown -> @rolldown/browser (official browser build, Vite 8).
  // Exact matches first for the browser-conditioned subpaths.
  if (request === "rolldown") return ROLLDOWN_BROWSER_MAIN;
  if (request === "rolldown/experimental") return ROLLDOWN_EXPERIMENTAL;
  if (request === "rolldown/plugins") return ROLLDOWN_PLUGINS;
  if (request === "rolldown/utils") return ROLLDOWN_UTILS;
  if (request === "rolldown/filter") return ROLLDOWN_FILTER;
  if (request === "rolldown/parseAst") return ROLLDOWN_PARSEAST;
  if (request.startsWith("rolldown/")) {
    return ROLLDOWN_BROWSER_DIR + request.slice("rolldown".length);
  }

  // @rolldown/browser's WASI runtime dependencies (bare specifiers in
  // rolldown-binding.wasi-browser.js). These are the vendor's real files.
  if (request === "@napi-rs/wasm-runtime") return NAPI_WASM_RUNTIME;
  if (request === "@napi-rs/wasm-runtime/fs") return NAPI_WASM_RUNTIME_FS;
  if (request === "@emnapi/runtime") return EMNAPI_RUNTIME;

  return null;
}

// Re-exported for tests and for the host import path (runtime.js
// _dynamic_import), which consults the same table for ESM specifiers.
export const BROWSER_BUILD_TARGETS = Object.freeze({
  ROLLUP_BROWSER_MAIN,
  ROLLUP_BROWSER_DIR,
  ROLLUP_PARSEAST_MODULE,
  ESBUILD_SHIM,
  ROLLDOWN_BROWSER_MAIN,
  ROLLDOWN_BROWSER_DIR,
  ROLLDOWN_EXPERIMENTAL,
  ROLLDOWN_PLUGINS,
  ROLLDOWN_UTILS,
  ROLLDOWN_FILTER,
  ROLLDOWN_PARSEAST,
  NAPI_WASM_RUNTIME,
  NAPI_WASM_RUNTIME_FS,
  EMNAPI_RUNTIME,
});
