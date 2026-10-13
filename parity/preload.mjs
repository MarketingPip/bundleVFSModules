// Parity preload (run with: node --import ./parity/preload.mjs <testfile>).
//
// 1. Patches CJS Module._load so require('path') / require('node:path') inside
//    parity/node-test/parallel/*.js resolves to the polyfill instead of the
//    real builtin. (Loader resolve hooks don't reliably intercept CJS.)
// 2. Registers the ESM hooks (hooks.mjs) for `import` specifiers.
//
// Only the module named in PARITY_TARGET is redirected, and only for
// importers under parity/node-test/parallel/. Everything else — including
// test/common — keeps real Node builtins.
import Module from "node:module";
import { register } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const testsDir =
  path.join(repoRoot, "parity", "node-test", "parallel") + path.sep;
const target = process.env.PARITY_TARGET;

// Shim lane is the default: parity always tests our runtime shims, never
// native delegation. PARITY_NATIVE=1 opts into the bridge diagnostic lane
// (official tests run against Node itself — a tautology, not a shim test).
// PARITY_FORCE_SHIM=1 is accepted for backwards compatibility and is a no-op:
// the shim lane is already the default.
// The marker is defined before any test or shim loads, so native bridges
// (child_process loadNativeChildProcess, os _nativeOs, …) stay off and
// Node's official tests run against the code that actually executes in
// Jared's sandbox. Only the marker is defined — no other sandbox services
// are faked.
if (
  process.env.PARITY_NATIVE !== "1" &&
  typeof globalThis._RUNTIME_ === "undefined"
) {
  // Non-enumerable: Node's own test/common global-leak detector
  // (`for (const val in globalThis)` on process 'exit') only sees
  // enumerable properties, so the marker stays invisible to it.
  Object.defineProperty(globalThis, "_RUNTIME_", {
    value: { parityForceShim: true },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

// Snapshot the timer globals before any shim loads: als-browser (pulled in
// via async_hooks → events → stream → fs) replaces them on import, which
// trips Node's official-test global-leak detector. The fs harness
// (parity/fs-harness.mjs) restores these after the shim loads. Non-enumerable
// so the leak detector never sees the snapshot itself.
Object.defineProperty(globalThis, "__PARITY_ORIG_TIMERS__", {
  value: {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    setImmediate: globalThis.setImmediate,
    queueMicrotask: globalThis.queueMicrotask,
  },
  writable: true,
  configurable: true,
  enumerable: false,
});

function polyfillPath(request) {
  const name = request.startsWith("node:") ? request.slice(5) : request;
  if (name.startsWith(".") || path.isAbsolute(name)) return null;
  const parts = name.split("/");
  if (target && parts[0] !== target) return null;
  // Harness-only tmpdir sync for fs parity (parity/fs-harness.mjs): the
  // official tests stage fixtures on real disk, which the memfs-backed shim
  // cannot see. The wrapper syncs real-disk tmpdir state into memfs on
  // access. src/fs.js itself is untouched.
  if (target === "fs" && name === "fs") {
    return path.join(repoRoot, "parity", "fs-harness.mjs");
  }
  const candidate = path.join(repoRoot, "src", ...parts) + ".js";
  return fs.existsSync(candidate) ? candidate : null;
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const parentFile = parent?.filename ?? "";
  // For the fs target, common/fs.js (directory-comparison helpers) also
  // needs the shim: it reads the cp dest out of memfs.
  const isFsHelper =
    target === "fs" &&
    parentFile ===
      path.join(repoRoot, "parity", "node-test", "common", "fs.js");
  if (parentFile.startsWith(testsDir) || isFsHelper) {
    // Mirror real CJS builtins: require('path') is module.exports (the
    // default export), and require('path/posix') / require('path/win32')
    // are the identical objects as require('path').posix / .win32.
    // (require() of an ESM file would otherwise hand back the module
    // namespace object, breaking reference equality.)
    const bare = request.startsWith("node:") ? request.slice(5) : request;
    if (
      target &&
      (bare === target ||
        bare === `${target}/posix` ||
        bare === `${target}/win32` ||
        bare === `${target}/strict` ||
        (target === "fs" && bare === "fs/promises"))
    ) {
      const ns = origLoad.call(this, polyfillPath(target), parent, isMain);
      if (bare === `${target}/posix`) return ns.posix;
      if (bare === `${target}/win32`) return ns.win32;
      const def = ns.default ?? ns;
      // Node: require('assert/strict') === require('assert').strict.
      if (bare === `${target}/strict`) return def.strict;
      // fs/promises goes through the harness wrapper too (timer-globals
      // restore + tmpdir sync); the wrapper's .promises is the wrapped API.
      if (target === "fs" && bare === "fs/promises") return def.promises;
      return def;
    }
    const poly = polyfillPath(request);
    if (poly) request = poly;
    // The events tests also cover Node's internal event_target wiring
    // (CustomEvent, kEvents, kWeakHandler, NodeEventTarget). That module
    // needs --expose-internals in real Node; the adapter re-exports the
    // real globals plus discovered symbols so the tests run unmodified.
    if (target === "events" && bare === "internal/event_target") {
      return origLoad.call(
        this,
        path.join(repoRoot, "parity", "internal-event-target-adapter.mjs"),
        parent,
        isMain,
      );
    }
  }
  return origLoad.call(this, request, parent, isMain);
};

register("./hooks.mjs", import.meta.url);
