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
// ponytail: same install for the http target. Without it, http tests see a
// split brain no real deployment has: shim http/net, but the REAL global
// Buffer. test-http-upgrade-server-callback asserts `upgradeHead
// instanceof Buffer`, and the upgrade head is a genuine shim Buffer from
// the parser — which can never pass against the real class. In a real
// deployment (browser, node_globals installed) the global Buffer IS the
// shim Buffer, so the assert passes there; the harness must present the
// same single Buffer. Ceiling: this is harness-only presentation, not a
// product change — if a future http test genuinely needs the real global
// Buffer, that test needs its own harness carve-out, not a product hack.
// No product file changes; src/buffer.js itself is untouched.
if (target === "buffer" || target === "http") {
  const polyfillURL = pathToFileURL(
    path.join(repoRoot, "src", "buffer.js"),
  ).href;
  bufferPoly = await import(polyfillURL);
  globalThis.Buffer = bufferPoly.Buffer;
}

// Extra redirects: modules that must follow the target's shim because the
// target's tests depend on them sharing the shim's virtual state.
// Currently: when PARITY_TARGET=http, `net` is also redirected. Http tests
// use net.createConnection() to speak raw HTTP bytes to the virtual server,
// and real net cannot see the http shim's virtual registry (ECONNREFUSED).
// The net shim shares one virtual registry per realm with the http shim
// (same src/net.js module instance), so the connection reaches the server.
function isExtraRedirect(name) {
  if (target === "http" && name === "net") return true;
  // http tests that require('_http_outgoing') for kHighWaterMark need the
  // shim's module: the shim's symbol identity must match the one on shim
  // req/res objects (real Node's symbol is a different instance, so
  // without this redirect res[kHighWaterMark] reads undefined even when
  // the shim sets it — test-http-server-options-highwatermark,
  // test-http-client-highwatermark, the only two http tests that require
  // it). Mirrors the net redirect above (PR #232 precedent).
  if (target === "http" && name === "_http_outgoing") return true;
  // http tests that require('_http_agent') need the shim's Agent: the
  // real-Node agent's createSocket does a real net.connect against the
  // virtual server port and dies with ECONNREFUSED (only two tests do
  // this: test-http-agent-keepalive, test-http-agent-keepalive-delay).
  // Mirrors the _http_outgoing redirect above (PR #232 precedent).
  if (target === "http" && name === "_http_agent") return true;
  // http tests that require('https') need the shim's https module:
  // test-http-correct-hostname reads req[kOutHeaders] off both the http
  // and the https request with one symbol (from internal/http), so the
  // https request must be a shim request storing under the shim's symbol
  // — the native https request stores under real Node's symbol and the
  // lookup reads undefined. Only six http tests require('https')
  // (correct-hostname, default-port, dns-error, invalid-urls,
  // request-agent, url.parse-https.request); the differential guards the
  // other five. Mirrors the _http_agent redirect above.
  if (target === "http" && name === "https") return true;
  // https tests that require('http') need the shim's IncomingMessage:
  // the shim's https server builds shim requests, so a test asserting
  // `s instanceof http.IncomingMessage` (test-https-set-timeout-server)
  // or extending http.IncomingMessage
  // (test-https-server-options-incoming-message) fails against native
  // http — two classes, same name. Mirrors the https redirect above
  // (PR #232 precedent).
  if (target === "https" && name === "http") return true;
  // https tests that require('tls')/'net' need the shims: tls.connect()
  // dials the virtual server (real tls ECONNREFUSEs on virtual ports),
  // and dropRequest asserts `socket instanceof net.Socket` against the
  // shim's class. 0 passing tests require either, so the redirect cannot
  // regress a passer. Mirrors the http redirect above (PR #232 precedent).
  if (target === "https" && (name === "tls" || name === "net")) return true;
  // net tests that require('events') need the shim's EventEmitter:
  // test-net-server-capture-rejection sets events.captureRejections = true
  // and expects the shim Server's [captureRejectionSymbol] handler to fire
  // via the shim's addCatch machinery — the native flag lives on a
  // different module instance and the shim never sees it (probe-proven:
  // server[kCapture] stayed false while the test's flag read true).
  // Only two net tests require('events'); the differential guards the
  // other (test-net-connect-abort-controller). Mirrors the net redirect
  // above (PR #232 precedent).
  if (target === "net" && name === "events") return true;
  // http tests that require('perf_hooks') need the shim's observer
  // registry: test-http-perf_hooks observes {type:"http"} and the entries
  // are emitted by the shim's http instrumentation through the shared
  // bridge (src/internals/perf-observe.js) — the native observer can never
  // see shim entries. Only test-http-perf_hooks requires it under the http
  // target. Mirrors the net redirect above (PR #232 precedent).
  if (target === "http" && name === "perf_hooks") return true;
  // net tests that require('perf_hooks') need the shim's observer
  // registry: test-net-perf_hooks observes {type:"net"} and the entries
  // are emitted by the shim's net instrumentation through the shared
  // bridge (src/internals/perf-observe.js) — the native observer can never
  // see shim entries. Only test-net-perf_hooks requires it under the net
  // target. Mirrors the http redirect above (PR #232 precedent).
  if (target === "net" && name === "perf_hooks") return true;
  // fs tests that require('child_process') need the native-spawn wrapper:
  // the tests stage fixtures in the shim's memfs but spawn NATIVE children
  // (git, /bin/sh redirections) that cannot see memfs. The wrapper
  // (parity/child_process-fs-harness.mjs) mirrors the memfs tmpdir subtree
  // to real disk before every spawn, then delegates to native child_process
  // with identical semantics. This is NOT the child_process shim — native
  // spawn is required. Mirrors the net redirect above (PR #232 precedent).
  if (target === "fs" && name === "child_process") return true;
  // zlib tests mutate require("buffer").kMaxLength before requiring zlib;
  // zlib must read the same cell (mirrors Node's load-time capture).
  return target === "zlib" && name === "buffer";
}

function polyfillPath(request) {
  const name = request.startsWith("node:") ? request.slice(5) : request;
  if (name.startsWith(".") || path.isAbsolute(name)) return null;
  const parts = name.split("/");
  if (target && parts[0] !== target && !isExtraRedirect(parts[0])) return null;
  // Harness-only tmpdir sync for fs parity (parity/fs-harness.mjs): the
  // official tests stage fixtures on real disk, which the memfs-backed shim
  // cannot see. The wrapper syncs real-disk tmpdir state into memfs on
  // access. src/fs.js itself is untouched.
  if (target === "fs" && name === "fs") {
    return path.join(repoRoot, "parity", "fs-harness.mjs");
  }
  // Harness-only native child_process wrapper for fs parity
  // (parity/child_process-fs-harness.mjs): the official tests stage
  // fixtures in memfs, but spawn NATIVE children (git, /bin/sh
  // redirections) that cannot see memfs. The wrapper mirrors the memfs
  // tmpdir subtree to real disk before every spawn, then delegates to
  // native child_process. This is NOT the child_process shim — native
  // spawn is required here. src/child_process.js itself is untouched.
  if (target === "fs" && name === "child_process") {
    return path.join(repoRoot, "parity", "child_process-fs-harness.mjs");
  }
  // Harness-only timer-globals restore for stream parity
  // (parity/stream-harness.mjs): the stream shim (via async_hooks → events)
  // replaces timer globals on import, tripping Node's global-leak detector.
  // The harness restores the originals snapshotted in preload.mjs.
  // src/stream.js itself is untouched.
  if (target === "stream" && name === "stream") {
    return path.join(repoRoot, "parity", "stream-harness.mjs");
  }
  // Harness-only timer-globals restore for crypto parity
  // (parity/crypto-harness.mjs): the crypto shim imports ./stream.js (for
  // the createMac Transform, via events → async_hooks → als-browser),
  // which replaces timer globals on import, tripping Node's global-leak
  // detector. The harness restores the originals snapshotted in preload.mjs.
  // src/crypto.js itself is untouched.
  if (target === "crypto" && name === "crypto") {
    return path.join(repoRoot, "parity", "crypto-harness.mjs");
  }
  // Harness-only timer-globals restore for async_hooks parity
  // (parity/async-hooks-harness.mjs): the async_hooks shim (als-browser)
  // replaces timer globals on import, tripping Node's global-leak detector.
  // The harness restores the originals snapshotted in preload.mjs.
  // src/async_hooks.js itself is untouched.
  if (target === "async_hooks" && name === "async_hooks") {
    return path.join(repoRoot, "parity", "async-hooks-harness.mjs");
  }
  // Harness-only timer-globals restore for events parity
  // (parity/events-harness.mjs): the events shim imports ./async_hooks.js
  // (als-browser), which replaces timer globals on import, tripping Node's
  // global-leak detector. The harness restores the originals snapshotted
  // in preload.mjs. src/events.js itself is untouched.
  if (target === "events" && name === "events") {
    return path.join(repoRoot, "parity", "events-harness.mjs");
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
  // Harness-only timer-globals restore for http under the https target
  // (parity/http-harness.mjs): https tests that require('http') get the
  // shim so the IncomingMessage class identity matches the shim's https
  // server (test-https-set-timeout-server,
  // test-https-server-options-incoming-message). src/http.js itself is
  // untouched.
  if (target === "https" && name === "http") {
    return path.join(repoRoot, "parity", "http-harness.mjs");
  }
  // Harness-only timer-globals restore for net under the http target
  // (parity/net-harness.mjs): http tests that require('net') get the shim
  // so net.createConnection() reaches the http shim's virtual server.
  // src/net.js itself is untouched.
  if (target === "http" && name === "net") {
    return path.join(repoRoot, "parity", "net-harness.mjs");
  }
  // Harness-only timer-globals restore for tls under the https target
  // (parity/tls-harness.mjs): https tests that require('tls') get the shim
  // so tls.connect() reaches the virtual server. src/tls.js itself is
  // untouched.
  if (target === "https" && name === "tls") {
    return path.join(repoRoot, "parity", "tls-harness.mjs");
  }
  // Harness-only timer-globals restore for net under the https target
  // (parity/net-harness.mjs): https tests that require('net') get the shim
  // so `socket instanceof net.Socket` reads the shim's class.
  // src/net.js itself is untouched.
  if (target === "https" && name === "net") {
    return path.join(repoRoot, "parity", "net-harness.mjs");
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
  // Also used when target === "http": test-http-correct-hostname needs the
  // shim's https request (see isExtraRedirect above).
  if ((target === "https" || target === "http") && name === "https") {
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
  // ponytail: under `--import`, the ESM translator pre-creates the CJS
  // entry via cjsEmplaceModuleCacheEntry(filename) with parent undefined
  // (translators.js:289,404) BEFORE _load is called, and native _load
  // returns that cached instance — so the parent argument never reaches
  // a constructor, and the native `parent` getter keeps reading the
  // translator's undefined instead of null
  // (test-module-parent-deprecation; run_main passes null explicitly).
  // Drop the translator's entry so native _load constructs a fresh
  // Module with parent null (mirroring run_main): the constructor sets
  // both parent slots directly, so no deprecation warning fires (a
  // public `cached.parent = null` set would consume the test's one
  // DEP0144 warning — proven: it flips test-repl-options.js and
  // test-process-env-deprecation.js). Side benefit: the fresh module
  // also gets `id === '.'` and `process.mainModule` like a plain
  // run_main entry, instead of the translator's full-path id. The
  // translator still mirrors exports onto its orphaned instance after
  // _load returns, so the ESM namespace is unaffected. Regular
  // require() calls always pass a real parent with isMain false, so
  // they are untouched.
  if (isMain && parent === undefined) {
    parent = null;
    delete Module._cache[request];
  }
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
  // For the net target, common/index.js also needs the shim: at load it
  // mutates the autoSelectFamily defaults (setDefaultAutoSelectFamily
  // AttemptTimeout(getDefault...() * 10)), and the tests read those
  // defaults back through the shim's net. The redirect gate below only
  // covers parents under testsDir (parallel/), but common/ lives
  // outside it — so the ×10 landed on native net while the test read the
  // shim's untouched 250 (test-net-autoselectfamily-attempt-timeout-
  // default-value, probe-proven in triage-net-2026-11-14). common/index.js
  // uses net for nothing else at load, so this stays a one-file gate.
  const isNetHelper =
    target === "net" &&
    parentFile ===
      path.join(repoRoot, "parity", "node-test", "common", "index.js");
  if (parentFile.startsWith(testsDir) || isFsHelper || isNetHelper) {
    // Mirror real CJS builtins: require('path') is module.exports (the
    // default export), and require('path/posix') / require('path/win32')
    // are the identical objects as require('path').posix / .win32.
    // (require() of an ESM file would otherwise hand back the module
    // namespace object, breaking reference equality.)
    const bare = request.startsWith("node:") ? request.slice(5) : request;
    // Extra redirect: the http target also redirects net (isExtraRedirect):
    // http tests use net.createConnection() against the virtual server.
    // Match on the base name so subpaths (path/posix) still redirect.
    const base = bare.split("/")[0];
    const redirectName =
      base === target ? target : isExtraRedirect(base) ? base : null;
    if (
      redirectName &&
      (bare === redirectName ||
        bare === `${redirectName}/posix` ||
        bare === `${redirectName}/win32` ||
        bare === `${redirectName}/strict` ||
        (redirectName === "fs" && bare === "fs/promises") ||
        (redirectName === "dns" && bare === "dns/promises") ||
        (redirectName === "timers" && bare === "timers/promises") ||
        (redirectName === "util" && bare === "util/types"))
    ) {
      const ns = origLoad.call(
        this,
        polyfillPath(redirectName),
        parent,
        isMain,
      );
      if (bare === `${redirectName}/posix`) return ns.posix;
      if (bare === `${redirectName}/win32`) return ns.win32;
      const def = ns.default ?? ns;
      // Node: require('assert/strict') === require('assert').strict.
      if (bare === `${redirectName}/strict`) return def.strict;
      // fs/promises goes through the harness wrapper too (timer-globals
      // restore + tmpdir sync); the wrapper's .promises is the wrapped API.
      if (redirectName === "fs" && bare === "fs/promises") return def.promises;
      // dns/promises: require('dns/promises') === require('dns').promises
      // (reference equality, per test-dns-promises-exists.js).
      if (redirectName === "dns" && bare === "dns/promises")
        return def.promises;
      // timers/promises: require('timers/promises') === require('timers').promises
      // (reference equality, per test-timers-promises.js).
      if (redirectName === "timers" && bare === "timers/promises")
        return def.promises;
      // util/types: require('util/types') === require('util').types
      // (reference equality, per test-util-types-exists.js).
      if (redirectName === "util" && bare === "util/types") return def.types;
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
    // The http tests' `_http_common` needs the same treatment as
    // `internal/event_target` above, for the same reason: the module must
    // be shared state, not two copies. `http.setMaxIdleHTTPParsers()`
    // (shim) must mutate the `parsers.max` cell the tests read, but the
    // shim's own `_http_common.js` cannot supply the real `HTTPParser`
    // binding that test-http-parser.js and test-http-parser-bad-ref.js
    // depend on. The adapter merges them: real Node's module with the
    // shim's `parsers` cell. See parity/http-common-adapter.mjs.
    if (target === "http" && bare === "_http_common") {
      return origLoad.call(
        this,
        path.join(repoRoot, "parity", "http-common-adapter.mjs"),
        parent,
        isMain,
      );
    }
    // The http timeout-on-connect test reads socket[kTimeout] from
    // `internal/timers`. Same treatment as `internal/event_target` above:
    // the shim's socket carries the timeout slot under a Symbol.for
    // bridge (product code cannot import Node internals), and this
    // adapter exports that bridge key so the test sees the slot. See
    // parity/internal-timers-adapter.mjs and src/net.js.
    if (target === "http" && bare === "internal/timers") {
      return origLoad.call(
        this,
        path.join(repoRoot, "parity", "internal-timers-adapter.mjs"),
        parent,
        isMain,
      );
    }
    // The http server-lifecycle tests read server[kConnectionsChecking-
    // Interval] from `_http_server`. Same treatment: without a redirect
    // the require falls through to native Node's `_http_server`, whose
    // symbol never matches the shim's slot, so the slot always reads
    // undefined. The adapter exports the shim's Symbol.for bridge key
    // (see src/http.js ServerBase). See parity/http-server-adapter.mjs.
    // http + https targets: the https twins (async-dispose,
    // close-destroy-timeout) need the same bridge — the shim https
    // Server extends http's ServerBase, so it carries the identical slot
    // (Node lib/https.js:79 shares setupConnectionsTracking).
    if ((target === "http" || target === "https") && bare === "_http_server") {
      return origLoad.call(
        this,
        path.join(repoRoot, "parity", "http-server-adapter.mjs"),
        parent,
        isMain,
      );
    }
    // test-http-correct-hostname reads req[kOutHeaders] from
    // `internal/http`. Same treatment: without a redirect the require
    // falls through to native Node's `internal/http`, whose symbol never
    // matches the shim's slot, so the lookup always reads undefined.
    // The adapter re-exports real Node's module with the shim's
    // kOutHeaders symbol (see src/internals/http-symbols.js).
    // See parity/internal-http-adapter.mjs.
    if ((target === "http" || target === "https") && bare === "internal/http") {
      return origLoad.call(
        this,
        path.join(repoRoot, "parity", "internal-http-adapter.mjs"),
        parent,
        isMain,
      );
    }
    // test-net-normalize-args reads normalizedArgsSymbol from
    // `internal/net`. Same treatment: without a redirect the require
    // falls through to native Node's `internal/net`, whose symbol never
    // matches the shim's slot, so the test's strictEqual on the symbol
    // always reads undefined. The adapter re-exports real Node's module
    // with the shim's normalizedArgsSymbol (see
    // src/internals/net-symbols.js). See parity/internal-net-adapter.mjs.
    if (target === "net" && bare === "internal/net") {
      return origLoad.call(
        this,
        path.join(repoRoot, "parity", "internal-net-adapter.mjs"),
        parent,
        isMain,
      );
    }
    // test-fs-utils-get-dirents / test-fs-watchfile-bigint need the shim's
    // memfs-backed `internal/fs/utils`: native getDirent lstats the
    // real-disk path (the fixtures live only in memfs → ENOENT) and native
    // toStats returns Stats, not BigIntStats. Same treatment as
    // `internal/net` above: the adapter ports Node's functions over the
    // shim's fs (see parity/internal-fs-utils-adapter.mjs). The redirect
    // also covers the four guard tests that already pass against
    // internal/fs/utils (filehandle/open-flags stringToFlags,
    // rmdir-recursive validateRmdirOptions, util-validateoffsetlength
    // validateOffsetLengthRead/Write) — the adapter re-exports the shim's
    // faithful ports of those. #232 precedent, fs target only.
    if (target === "fs" && bare === "internal/fs/utils") {
      return origLoad.call(
        this,
        path.join(repoRoot, "parity", "internal-fs-utils-adapter.mjs"),
        parent,
        isMain,
      );
    }
    // test-net-end-close's fake handle writes UV_EOF into the
    // `stream_wrap` binding's streamBaseState, and the shim's onStreamRead
    // must read that same cell — but the shim cannot import Node internals
    // (browser build). Same treatment: the adapter re-exports real Node's
    // internal/test/binding with `internalBinding('stream_wrap')`
    // returning real Node's stream_wrap whose streamBaseState /
    // kReadBytesOrError cells are the shim's shared state (see
    // src/internals/stream-wrap-state.js). Every other binding
    // (tcp_wrap, pipe_wrap, uv) is real Node's, so the other five net
    // tests requiring internal/test/binding are unaffected. See
    // parity/internal-test-binding-adapter.mjs.
    if (target === "net" && bare === "internal/test/binding") {
      return origLoad.call(
        this,
        path.join(repoRoot, "parity", "internal-test-binding-adapter.mjs"),
        parent,
        isMain,
      );
    }
    // test-fs-watch-recursive-delete-race requires `internal/fs/watchers`
    // (kFSWatchStart) and `internal/fs/recursive_watch` (FSWatcher). Same
    // treatment: without a redirect the requires fall through to native
    // Node's internals, whose FSWatcher stats the real-disk parent
    // (memfs-only) and throws ENOENT at [kFSWatchStart]. The watchers
    // adapter re-exports real Node's module (symbol identity for
    // kFSWatchStart); the recursive_watch adapter is a port of Node's JS
    // recursive FSWatcher whose fs operations run through the shim (so
    // the test's monkey-patched fs.watch is honored). See
    // parity/internal-fs-watchers-adapter.mjs and
    // parity/internal-fs-recursive-watch-adapter.mjs. (#232 precedent)
    if (target === "fs" && bare === "internal/fs/watchers") {
      return origLoad.call(
        this,
        path.join(repoRoot, "parity", "internal-fs-watchers-adapter.mjs"),
        parent,
        isMain,
      );
    }
    if (target === "fs" && bare === "internal/fs/recursive_watch") {
      return origLoad.call(
        this,
        path.join(
          repoRoot,
          "parity",
          "internal-fs-recursive-watch-adapter.mjs",
        ),
        parent,
        isMain,
      );
    }
    // test-fs-promises-file-handle-aggregate-errors/close-errors/op-errors
    // patch FileHandle.prototype.fd and expect the shim's path-based
    // promises ops to use the patched class. Same treatment: without a
    // redirect the require falls through to native Node's
    // internal/fs/promises, whose FileHandle the shim never sees. The
    // adapter exports the shim's FileHandle class (see
    // parity/internal-fs-promises-adapter.mjs and src/fs.js _FileHandle).
    // Only these three tests require it. Mirrors the internal/net redirect
    // above (PR #232 precedent).
    if (target === "fs" && bare === "internal/fs/promises") {
      return origLoad.call(
        this,
        path.join(repoRoot, "parity", "internal-fs-promises-adapter.mjs"),
        parent,
        isMain,
      );
    }
    // fs target: same adapter, `fs` binding side — the shim routes its
    // readFile-fstat, readdir, and writeFileSync-utf8-fast-path calls
    // through the shared fs binding cell, and the vendored fs tests
    // patch internalBinding('fs') to observe them (net #425 shape).
    if (target === "fs" && bare === "internal/test/binding") {
      return origLoad.call(
        this,
        path.join(repoRoot, "parity", "internal-test-binding-adapter.mjs"),
        parent,
        isMain,
      );
    }
    // test-repl-highlight.js requires `internal/repl/highlight`, new in
    // Node 26 (lib/internal/repl/highlight.js). The host v24.22.1 has no
    // such module, so the require fails before any assertion runs. Same
    // treatment as `internal/http` above: the adapter re-exports the
    // shim's port (see src/internals/repl-highlight.js). Repl target
    // only (R-26 lane L2).
    if (target === "repl" && bare === "internal/repl/highlight") {
      return origLoad.call(
        this,
        path.join(repoRoot, "parity", "internal-repl-highlight-adapter.mjs"),
        parent,
        isMain,
      );
    }
  }
  return origLoad.call(this, request, parent, isMain);
};

// Only register the ESM hooks worker when the process can use it.
// - Under `--permission` without `--allow-worker`, worker creation is
//   denied and register() throws ERR_ACCESS_DENIED at preload load, before
//   any test code runs (process wave L2: execve-permission-*). The CJS
//   redirect above still works without the hooks worker.
// - In forked children (process.send is a function) whose entry point is
//   CJS, the hooks worker is a live thread the child never needs, and its
//   mere presence deterministically flips console's async EPIPE error
//   ordering so the EPIPE protection loses the race (process wave L3:
//   external-stdio-close). The child here never imports ESM.
// Default is to register (current behavior): unknown entry types keep the
// hooks, so a forked child that genuinely needs ESM redirects is unaffected.
// ponytail: the entry-type check mirrors Node's own .js resolution
// (nearest package.json "type", default commonjs); if the package.json
// cannot be read for a reason other than "absent", assume ESM (register)
// rather than risk dropping hooks. A CJS child that later dynamically
// imports an ESM module needing a redirect will not get one — that is the
// ceiling of skipping the worker per-process; restoring hooks lazily is
// impossible because register() must precede the import.
function entryPointNeedsEsmHooks() {
  const entry = process.argv[1];
  if (!entry) return true;
  if (entry.endsWith(".mjs")) return true;
  if (entry.endsWith(".cjs")) return false;
  let dir = path.dirname(entry);
  while (true) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf8"),
      );
      if (pkg && typeof pkg.type === "string") return pkg.type === "module";
      return false;
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
        const parent = path.dirname(dir);
        if (parent === dir) return false;
        dir = parent;
        continue;
      }
      return true;
    }
  }
}

const workersAllowed =
  typeof process.permission?.has !== "function" ||
  process.permission.has("worker");
const isForkedChild = typeof process.send === "function";
const needsEsmHooks = entryPointNeedsEsmHooks();
// W-A (worker_threads threadId offset): each register() spawns a loader-hook
// worker thread that takes the next threadId (Node lib/internal/modules/esm/
// hooks.js: AsyncLoaderHookWorker, one hooks thread per thread; probe-proven:
// first worker gets 2/4/6 under register, 1/2/3 without). For the
// worker_threads target, CJS entries skip register() so spawned workers get
// native IDs (test-worker-event.js, test-worker-messaging.js). The skip is
// safe for this target only: src/worker_threads.js imports just
// "./_cloak.js" (extension present — resolves natively, no hooks needed),
// no worker test uses dynamic import(), and .mjs entries still register
// (needsEsmHooks true). Other targets are untouched — their shims rely on
// the hooks for extensionless relative imports (e.g. src/repl.js "./readline").
// ponytail: target-scoped gate, same shape as isFsHelper/isNetHelper; if a
// future worker_threads test needs ESM redirects from a CJS entry, that test
// needs its own carve-out, not a global re-register (which would re-take ID 1).
const skipRegisterForWorkerThreads =
  target === "worker_threads" && !needsEsmHooks;
if (
  workersAllowed &&
  !(isForkedChild && !needsEsmHooks) &&
  !skipRegisterForWorkerThreads
) {
  register("./hooks.mjs", import.meta.url);
}
