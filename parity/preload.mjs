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
import { fileURLToPath, pathToFileURL } from "node:url";

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

// Harness-only global Buffer install for buffer parity: most official
// buffer tests exercise the *global* Buffer and never require('buffer'),
// so `SlowBuffer(4) instanceof Buffer` and `buffer.INSPECT_MAX_BYTES`
// (set via require('buffer')) must see the same Buffer class. Installs
// the polyfill as globalThis.Buffer, the way Node's own bootstrap
// installs the real Buffer. src/buffer.js itself is untouched.
// Harness-only global Buffer install for buffer parity: most official
// buffer tests exercise the *global* Buffer and never require('buffer'),
// so `SlowBuffer(4) instanceof Buffer` and `buffer.INSPECT_MAX_BYTES`
// (set via require('buffer')) must see the same Buffer class. Installs
// the polyfill as globalThis.Buffer, the way Node's own bootstrap
// installs the real Buffer. src/buffer.js itself is untouched.
let bufferPoly = null;
if (target === "buffer") {
  const polyfillURL = pathToFileURL(
    path.join(repoRoot, "src", "buffer.js"),
  ).href;
  bufferPoly = await import(polyfillURL);
  globalThis.Buffer = bufferPoly.Buffer;
}

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
  // Harness-only timer-globals restore for stream parity
  // (parity/stream-harness.mjs): the stream shim (via async_hooks → events)
  // replaces timer globals on import, tripping Node's global-leak detector.
  // The harness restores the originals snapshotted in preload.mjs.
  // src/stream.js itself is untouched.
  if (target === "stream" && name === "stream") {
    return path.join(repoRoot, "parity", "stream-harness.mjs");
  }
  // Harness-only timer-globals restore for async_hooks parity
  // (parity/async-hooks-harness.mjs): the async_hooks shim (als-browser)
  // replaces timer globals on import, tripping Node's global-leak detector.
  // The harness restores the originals snapshotted in preload.mjs.
  // src/async_hooks.js itself is untouched.
  if (target === "async_hooks" && name === "async_hooks") {
    return path.join(repoRoot, "parity", "async-hooks-harness.mjs");
  }
  // Harness-only timer-globals restore for tty parity
  // (parity/tty-harness.mjs): the tty shim imports ./stream.js (via
  // async_hooks → events → stream), which replaces timer globals on import,
  // tripping Node's global-leak detector. The harness restores the
  // originals snapshotted in preload.mjs. src/tty.js itself is untouched.
  if (target === "tty" && name === "tty") {
    return path.join(repoRoot, "parity", "tty-harness.mjs");
  }
  // Harness-only timer-globals restore for http parity
  // (parity/http-harness.mjs): the http shim imports ./stream.js (for
  // OutgoingMessage/IncomingMessage via async_hooks → events → stream),
  // which replaces timer globals on import, tripping Node's global-leak
  // detector. The harness restores the originals snapshotted in preload.mjs.
  // src/http.js itself is untouched.
  if (target === "http" && name === "http") {
    return path.join(repoRoot, "parity", "http-harness.mjs");
  }
  // Harness-only timer-globals restore for http2 parity
  // (parity/http2-harness.mjs): the http2 shim imports ./events.js (via
  // async_hooks → als-browser), which replaces timer globals on import,
  // tripping Node's global-leak detector. The harness restores the
  // originals snapshotted in preload.mjs. src/http2.js itself is untouched.
  if (target === "http2" && name === "http2") {
    return path.join(repoRoot, "parity", "http2-harness.mjs");
  }
  // Harness-only timer-globals restore for https parity
  // (parity/https-harness.mjs): the https shim imports ./http.js (which
  // pulls in async_hooks → als-browser via stream), replacing timer globals
  // on import and tripping Node's global-leak detector. The harness restores
  // the originals snapshotted in preload.mjs. src/https.js itself is untouched.
  if (target === "https" && name === "https") {
    return path.join(repoRoot, "parity", "https-harness.mjs");
  }
  // Harness-only timer-globals restore for child_process parity
  // (parity/child_process-harness.mjs): the child_process shim imports
  // ./events.js and ./stream.js (which pull in async_hooks → als-browser),
  // replacing timer globals on import and tripping Node's global-leak
  // detector. The harness restores the originals snapshotted in preload.mjs.
  // src/child_process.js itself is untouched.
  if (target === "child_process" && name === "child_process") {
    return path.join(repoRoot, "parity", "child_process-harness.mjs");
  }
  // Harness-only timer-globals restore for net parity
  // (parity/net-harness.mjs): the net shim imports ./stream.js (for Socket
  // via Duplex, which pulls in async_hooks → als-browser), replacing timer
  // globals on import and tripping Node's global-leak detector. The harness
  // restores the originals snapshotted in preload.mjs. src/net.js itself is
  // untouched.
  if (target === "net" && name === "net") {
    return path.join(repoRoot, "parity", "net-harness.mjs");
  }
  const candidate = path.join(repoRoot, "src", ...parts) + ".js";
  return fs.existsSync(candidate) ? candidate : null;
}

const origLoad = Module._load;
// Wrap of require('crypto') for buffer parity: randomBytes must return the
// polyfill Buffer, not a native one, or deepStrictEqual(polyResult,
// nativeInput) in the concat tests fails on prototype identity (a harness
// artifact: in real Node, and in any real polyfill deployment, there is
// only one Buffer).
let wrappedCrypto = null;
function getWrappedCrypto(request, parent, isMain) {
  if (wrappedCrypto) return wrappedCrypto;
  const nativeCrypto = origLoad.call(this, request, parent, isMain);
  wrappedCrypto = new Proxy(nativeCrypto, {
    get(target, prop, receiver) {
      if (prop === "randomBytes") {
        return (size, callback) => {
          const buf = bufferPoly.Buffer.from(target.randomBytes(size));
          if (typeof callback === "function") {
            process.nextTick(() => callback(null, buf));
          }
          return buf;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return wrappedCrypto;
}
Module._load = function (request, parent, isMain) {
  const parentFile = parent?.filename ?? "";
  // Buffer target: redirect require('crypto') from the vendored test tree
  // to the wrapped version so randomBytes returns polyfill Buffers.
  if (target === "buffer" && bufferPoly) {
    const bareCrypto = request.startsWith("node:") ? request.slice(5) : request;
    if (bareCrypto === "crypto" && parentFile.startsWith(testsDir)) {
      return getWrappedCrypto.call(this, request, parent, isMain);
    }
  }
  // For the fs target, common/fs.js (directory-comparison helpers) also
  // needs the shim: it reads the cp dest out of memfs.
  const isFsHelper =
    target === "fs" &&
    (parentFile ===
      path.join(repoRoot, "parity", "node-test", "common", "fs.js") ||
      // tmpdir.refresh() must run against the shim's memfs, not real disk:
      // otherwise its rmSync/mkdirSync clear real-disk .tmp.0 while the
      // test's memfs .tmp.0 keeps stale entries (test-fs-realpath.js
      // test_up_multiple EEXIST).
      parentFile ===
        path.join(repoRoot, "parity", "node-test", "common", "tmpdir.js"));
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
        (target === "fs" && bare === "fs/promises") ||
        (target === "dns" && bare === "dns/promises") ||
        (target === "timers" && bare === "timers/promises") ||
        (target === "util" && bare === "util/types"))
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
      // dns/promises: require('dns/promises') === require('dns').promises
      // (reference equality, per test-dns-promises-exists.js).
      if (target === "dns" && bare === "dns/promises") return def.promises;
      // timers/promises: require('timers/promises') === require('timers').promises
      // (reference equality, per test-timers-promises.js).
      if (target === "timers" && bare === "timers/promises")
        return def.promises;
      // util/types: require('util/types') === require('util').types
      // (reference equality, per test-util-types-exists.js).
      if (target === "util" && bare === "util/types") return def.types;
      // console: require('console') === globalThis.console (reference equality,
      // per test-console-instance.js). src/console.js installs itself as
      // globalThis.console, but only when globalThis._RUNTIME_ is undefined —
      // and the preload defines _RUNTIME_ before any shim loads (to force the
      // shim lane). So install the same object require() returns.
      // src/console.js itself is untouched.
      if (target === "console" && bare === "console") {
        globalThis.console = def;
      }
      // perf_hooks: performance.timerify === require('perf_hooks').timerify
      // and performance.eventLoopUtilization ===
      // require('perf_hooks').eventLoopUtilization (reference equality, per
      // test-perf-hooks-timerify-basic.js and
      // test-perf-hooks-eventlooputilization.js).
      // src/perf_hooks.js patches globalThis.performance.timerify at load,
      // but the testsDir branch returns ns.default while other loaders get
      // the namespace — different module instances mean the patch may not
      // cover the instance the test file receives. Install the same
      // functions the test file gets, mirroring the console fix above.
      if (target === "perf_hooks" && bare === "perf_hooks") {
        try {
          for (const key of ["timerify", "eventLoopUtilization"]) {
            if (
              globalThis.performance &&
              typeof def[key] === "function" &&
              globalThis.performance[key] !== def[key]
            ) {
              Object.defineProperty(globalThis.performance, key, {
                value: def[key],
                writable: true,
                enumerable: true,
                configurable: true,
              });
            }
          }
        } catch {
          // If the global cannot be patched, the alias test fails; the
          // rest of the shim still works.
        }
      }
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
