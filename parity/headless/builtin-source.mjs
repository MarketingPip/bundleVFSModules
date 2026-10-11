#!/usr/bin/env node
// parity/headless/builtin-source.mjs — builtin specifier -> local dist/*.js
// source for the headless host's _dynamic_import.
//
// This mirrors the browser host's fetchBuiltinSource() exactly, except the
// "local /local-repo/dist first, then CDN" fetch becomes a direct read from
// the worktree's dist/ directory:
//
//   - "node:" prefix stripped (Node treats node:X and X identically)
//   - manifest key lookup with the "_" -> "/" fallback
//     (timers_promises -> timers/promises)
//   - "RUNTIME:NODE_GLOBALS" -> dist/RUNTIME_NODE_GLOBALS.js (the sandbox
//     startup wiring)
//   - unknown specifiers get the same honest generic stub the browser host
//     serves (never a throw)
//
// Serving dist/ (the esbuild bundles) instead of src/ is deliberate: it is
// what the real host serves the iframe, so the headless lane executes the
// same artifacts user code runs against.
import fs from "node:fs";
import path from "node:path";
import { builtinManifest, repoRoot } from "./runtime-scope.mjs";

/** Manifest key for a builtin specifier, or null. */
export function builtinKey(specifier) {
  let key = String(specifier).trim();
  if (key.startsWith("node:")) key = key.slice(5);
  if (key.startsWith("RUNTIME:")) return "RUNTIME_NODE_GLOBALS";
  if (Object.prototype.hasOwnProperty.call(builtinManifest, key)) return key;
  if (key.includes("_")) {
    const slash = key.split("_").join("/");
    if (Object.prototype.hasOwnProperty.call(builtinManifest, slash)) {
      return slash;
    }
  }
  return null;
}

/** Absolute dist path for a manifest key, or null if the file is missing. */
export function builtinDistPath(key) {
  // Mirrors fetchBuiltinSource: RUNTIME_* pseudo-builtins map straight to
  // dist/<key>.js without a manifest entry.
  let file = builtinManifest[key];
  if (!file && key.startsWith("RUNTIME_")) file = `${key}.js`;
  if (!file) return null;
  const p = path.join(repoRoot, "dist", file);
  return fs.existsSync(p) ? p : null;
}

/**
 * Source text for a builtin specifier.
 * Returns the honest generic stub when the specifier is unknown or the
 * dist file is missing — the same fallback fetchBuiltinSource uses.
 */
export function builtinSource(specifier) {
  // Node-internal test helper used by the official events suite
  // (test-events-customevent.js, test-events-on-async-iterator.js,
  // test-events-static-geteventlisteners.js). In real Node it requires
  // --expose-internals; the shim lane serves
  // parity/internal-event-target-adapter.mjs. The headless equivalent
  // re-exports the sandbox realm's web-API classes plus the symbols the
  // tests need (same contract as the shim-lane adapter).
  const bare = String(specifier).trim().replace(/^node:/, "");
  if (bare === "internal/event_target") {
    // CJS format: the tests require() it, and the _build_file transform
    // converts CJS→ESM. (The ESM `export` form fails sync require with
    // ERR_REQUIRE_ESM.)
    return [
      "const probe = new AbortController().signal;",
      "const kEvents = Object.getOwnPropertySymbols(probe).find((s) => s.description === 'kEvents');",
      "class NodeEventTarget extends EventTarget {}",
      "const kWeakHandler = Symbol('kWeakHandler');",
      "module.exports = {",
      "  Event: globalThis.Event,",
      "  EventTarget: globalThis.EventTarget,",
      "  CustomEvent: globalThis.CustomEvent,",
      "  NodeEventTarget, kEvents, kWeakHandler,",
      "};",
    ].join("\n");
  }
  const key = builtinKey(specifier);
  const p = key ? builtinDistPath(key) : null;
  if (p) return fs.readFileSync(p, "utf8");
  return "export default {};";
}

/** True when the specifier names a builtin the sandbox serves locally. */
export function isBuiltinSpecifier(specifier, nodeBuiltins) {
  const bare =
    typeof specifier === "string" && specifier.startsWith("node:")
      ? specifier.slice(5)
      : specifier;
  if (bare === "internal/event_target") return true;
  return (
    nodeBuiltins.includes(specifier) ||
    nodeBuiltins.includes(bare) ||
    builtinKey(specifier) !== null
  );
}
