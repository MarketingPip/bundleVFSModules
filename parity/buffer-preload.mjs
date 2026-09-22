// Buffer parity preload (run with: node --import ./parity/buffer-preload.mjs <testfile>).
//
// Most official buffer tests exercise the *global* Buffer and never
// require('buffer'), so this buffer-specific adapter:
//   1. Installs the polyfill as globalThis.Buffer, the way Node's own
//      bootstrap installs the real Buffer.
//   2. Redirects require('buffer') / require('node:buffer') issued from
//      files under parity/node-test/ to the polyfill's exports object
//      (mirrors the real CJS shape: require('buffer').Buffer, etc.).
//   3. Registers ./buffer-hooks.mjs so ESM `import 'buffer'` from the
//      vendored tests and their fixtures also resolves to the polyfill.
//   4. Propagates itself to spawned child processes via NODE_OPTIONS, so
//      tests that assert on child behavior (e.g. the DEP0005 deprecation
//      tests using the warning_node_modules fixtures) exercise the
//      polyfill instead of accidentally testing the native Buffer.
//
// This stays buffer-specific on purpose: the shared parity/preload.mjs only
// redirects imports and must leave the global Buffer alone for other modules.
import Module from 'node:module';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeTestDir = path.join(repoRoot, 'parity', 'node-test') + path.sep;
const preloadURL = pathToFileURL(fileURLToPath(import.meta.url)).href;
const polyfillURL = pathToFileURL(path.join(repoRoot, 'src', 'buffer.js')).href;

// Only the official test files (parallel/) and their fixture packages
// (fixtures/, loaded by spawned child processes) are redirected.
// test/common and the rest of the harness keep the real builtins:
// common/index.js destructures atob/btoa from require('buffer') for its
// global-leak detector, so it must keep seeing the native module.
const redirectDirs = [
  path.join(nodeTestDir, 'parallel') + path.sep,
  path.join(nodeTestDir, 'fixtures') + path.sep,
];

const poly = await import(polyfillURL);

// 1. Install the polyfill as the global Buffer.
globalThis.Buffer = poly.Buffer;

// 2. CJS redirect for the vendored test tree.
const origLoad = Module._load;
// Wrap of require('crypto'): randomBytes must return the polyfill Buffer,
// not a native one, or deepStrictEqual(polyResult, nativeInput) in the
// concat tests fails on prototype identity (a harness artifact: in real
// Node, and in any real polyfill deployment, there is only one Buffer).
let wrappedCrypto = null;
function getWrappedCrypto(request, parent, isMain) {
  if (wrappedCrypto) return wrappedCrypto;
  const nativeCrypto = origLoad.call(this, request, parent, isMain);
  wrappedCrypto = new Proxy(nativeCrypto, {
    get(target, prop, receiver) {
      if (prop === 'randomBytes') {
        return (size, callback) => {
          const buf = poly.Buffer.from(target.randomBytes(size));
          if (typeof callback === 'function') {
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
  const parentFile = parent?.filename ?? '';
  if (redirectDirs.some((dir) => parentFile.startsWith(dir))) {
    const bare = request.startsWith('node:') ? request.slice(5) : request;
    if (bare === 'buffer') {
      return poly.default;
    }
    if (bare === 'crypto') {
      return getWrappedCrypto.call(this, request, parent, isMain);
    }
  }
  return origLoad.call(this, request, parent, isMain);
};

// 3. ESM redirect for the vendored test tree.
register(pathToFileURL(path.join(repoRoot, 'parity', 'buffer-hooks.mjs')));

// 4. Make spawned `node` children load this adapter too, so child-process
// tests exercise the polyfill. Guarded so the flag is appended only once.
const importFlag = `--import ${preloadURL}`;
const nodeOptions = process.env.NODE_OPTIONS ?? '';
if (!nodeOptions.includes(preloadURL)) {
  process.env.NODE_OPTIONS =
    nodeOptions === '' ? importFlag : `${nodeOptions} ${importFlag}`;
}
