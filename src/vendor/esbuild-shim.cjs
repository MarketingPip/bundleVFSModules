// src/vendor/esbuild-shim.cjs — what `require("esbuild")` / `import "esbuild"`
// resolves to inside the browser runtime (see src/browser-builds.js).
//
// This loads the REAL esbuild-wasm browser build — the vendor's own WASM
// port of esbuild, not a reimplementation — and auto-initializes it from
// the WASM bytes in the runtime VFS. Vite imports esbuild synchronously
// and never calls initialize(); the wrapper performs the one-time async
// init transparently on first use, so unmodified Vite works.
//
// Scope note (repo rule: "no esbuild anywhere", AGENTS.md rule 11):
// esbuild-wasm is loaded ONLY when user code requires 'esbuild' (Vite's own
// optimizer). It is NOT on our _build_file transform path, which stays the
// CJS→ESM transform. Jared explicitly chose this on 2026-09-29 ("Your choice
// for this project" → real Vite 7 via esbuild-wasm); the tension with the
// standing rule is recorded here, not hidden.
//
// Runs through the runtime's CJS loader: `require` below is the
// runtime-provided require bound to this file's VFS path
// (/node_modules/.bvm/esbuild-shim.cjs), so the relative require reaches
// the real vendor file. `globalThis._RUNTIME_` is the sandbox-rewritten
// runtime handle (guarded for the host test lane).
"use strict";

// The vendor browser build copies globals off `self` when running its Go
// service on the main thread (`worker: false`). Every real browser context
// (window, worker, service worker) defines `self`; the Node test lane does
// not, so alias it there. Skipped where `self` already exists.
if (typeof self === "undefined") {
  globalThis.self = globalThis;
}

const vendor = require("../esbuild-wasm/lib/browser.js");

// VFS path of the real vendor WASM artifact, seeded into the runtime's
// node_modules at build/test time (byte-identical to the npm package).
const WASM_VFS_PATH = "/node_modules/esbuild-wasm/esbuild.wasm";

let initPromise = null;

function readWasmBytes() {
  const rt = globalThis._RUNTIME_;
  const fs = rt && rt.__FS__;
  if (!fs || typeof fs.readFileSync !== "function") {
    throw new Error(
      "esbuild-shim: browser runtime VFS (globalThis._RUNTIME_.__FS__) is not available",
    );
  }
  // No encoding: raw WASM bytes for WebAssembly.compile.
  return fs.readFileSync(WASM_VFS_PATH);
}

function ensureInitialized() {
  if (!initPromise) {
    initPromise = (async () => {
      const wasmModule = await WebAssembly.compile(readWasmBytes());
      // worker:false — run the Go service on this thread. The runtime has
      // no Worker/Blob-URL plumbing; the vendor build supports main-thread
      // operation and this keeps init to one await.
      await vendor.initialize({ wasmModule, worker: false });
    })();
  }
  return initPromise;
}

// Gate an async vendor API behind the one-time WASM init. The vendor's
// *Sync APIs are deliberately NOT wrapped: the browser build's sync
// variants throw honest "only works in node" errors, and wrapping them
// would turn that loud failure into a silent lie (repo rule: no silent
// fakes).
function gated(fn) {
  return function (...args) {
    return ensureInitialized().then(() => fn(...args));
  };
}

// NOTE: plain object literal, not a Proxy. cjs-module-lexer reads named
// exports statically off the literal, so Vite's
// `import esbuild, { build, formatMessages, transform } from "esbuild"`
// keeps resolving through the runtime's ESM interop. A Proxy would hide
// the named exports from static analysis and break that import.
module.exports = {
  ...vendor,
  // Idempotent by construction: the shim owns WASM init (it always comes
  // from the VFS; caller options are not applicable in this runtime) and
  // the vendor build throws if initialized twice.
  initialize: () => ensureInitialized().then(() => undefined),
  transform: gated(vendor.transform),
  build: gated(vendor.build),
  context: gated(vendor.context),
  analyzeMetafile: gated(vendor.analyzeMetafile),
  formatMessages: gated(vendor.formatMessages),
  stop: gated(vendor.stop),
};
