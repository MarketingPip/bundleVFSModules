/*!
 * sea-web — node:sea for browsers & bundlers
 * MIT License.
 * Node.js parity: node:sea @ Node 20.0.0+
 * Dependencies: none
 * Limitations:
 *   - There is no real SEA blob at runtime; isSea() returns true only when
 *     assets have been injected via the build-time __SEA_INJECT__ hook or
 *     the programmatic injectAsset() escape hatch.
 *   - getRawAsset() returns a frozen read-only view; mutations are silently
 *     discarded (matching Node's "should not be mutated" contract).
 *   - getAssetAsBlob() requires Blob to be available as a global.
 */

/**
 * @packageDocumentation
 * Browser/bundler shim for `node:sea` (Single Executable Application).
 *
 * ## How to populate the asset store at build time
 *
 * In your bundler config (Vite, Rollup, webpack, esbuild), define the
 * global `__SEA_INJECT__` before this module is evaluated:
 *
 * ```js
 * // vite.config.js
 * define: {
 *   __SEA_INJECT__: JSON.stringify({
 *     'config.json': '<base64-encoded bytes>',
 *     'model.bin':   '<base64-encoded bytes>',
 *   })
 * }
 * ```
 *
 * Keys are asset names; values are base64-encoded asset bytes.
 * The module decodes them once at load time into frozen ArrayBuffers.
 *
 * Alternatively, call `injectAsset(key, buffer)` before any SEA call
 * (useful in tests or runtime loaders):
 *
 * ```js
 * import { injectAsset } from './sea';
 * injectAsset('greeting.txt', new TextEncoder().encode('hello'));
 * ```
 */

// ---------------------------------------------------------------------------
// Internal asset store
// ---------------------------------------------------------------------------

/** @type {Map<string, ArrayBuffer>} */
const _store = new Map();

/**
 * Decodes a base64 string to an ArrayBuffer.
 * @param {string} b64
 * @returns {ArrayBuffer}
 */
function b64ToBuffer(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

// ---------------------------------------------------------------------------
// Build-time injection via __SEA_INJECT__ global
// Bundlers replace this with a literal object; at runtime it is simply
// undefined and this block is a no-op.
// ---------------------------------------------------------------------------
/* global __SEA_INJECT__ */
if (typeof __SEA_INJECT__ !== 'undefined' && __SEA_INJECT__ !== null) {
  for (const [key, b64] of Object.entries(__SEA_INJECT__)) {
    if (typeof b64 === 'string') {
      _store.set(key, b64ToBuffer(b64));
    } else if (b64 instanceof ArrayBuffer) {
      _store.set(key, b64.slice(0));         // take ownership of a copy
    } else if (ArrayBuffer.isView(b64)) {
      _store.set(key, b64.buffer.slice(b64.byteOffset, b64.byteOffset + b64.byteLength));
    }
  }
}

// ---------------------------------------------------------------------------
// Error factories — match Node's ERR_* code shape exactly
// ---------------------------------------------------------------------------

function errNotInSea() {
  return Object.assign(
    new Error('This API is only available in single executable applications'),
    { code: 'ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION' },
  );
}

/** @param {string} key */
function errAssetNotFound(key) {
  return Object.assign(
    new Error(`Cannot find asset '${key}' in the single executable application`),
    { code: 'ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND' },
  );
}

function errInvalidArgType(name, expected, received) {
  const recv = received === undefined ? 'undefined'
             : received === null      ? 'null'
             : `type ${typeof received}`;
  return Object.assign(
    new TypeError(`The "${name}" argument must be of type ${expected}. Received ${recv}`),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
}

// ---------------------------------------------------------------------------
// Internal validation
// ---------------------------------------------------------------------------

/** @param {unknown} v @param {string} name */
function validateString(v, name) {
  if (typeof v !== 'string') throw errInvalidArgType(name, 'string', v);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` when running as a Single Executable Application.
 * In browser/bundler context this is `true` iff at least one asset has been
 * injected (via `__SEA_INJECT__` or {@link injectAsset}).
 *
 * @returns {boolean}
 *
 * @example
 * if (isSea()) {
 *   const config = getAsset('config.json', 'utf-8');
 * }
 */
export function isSea() {
  return _store.size > 0;
}

/**
 * Returns the raw asset buffer for `key`.
 * The returned ArrayBuffer is a **read-only frozen view** — do not mutate it.
 * Throws if the application is not in SEA mode or the key is missing.
 *
 * @param {string} key
 * @returns {ArrayBuffer}
 * @throws {{ code: 'ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION' }}
 * @throws {{ code: 'ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND' }}
 *
 * @example
 * const raw = getRawAsset('model.bin');
 * const view = new Float32Array(raw); // read-only — do not write
 */
export function getRawAsset(key) {
  validateString(key, 'key');
  if (!isSea()) throw errNotInSea();
  const asset = _store.get(key);
  if (asset === undefined) throw errAssetNotFound(key);
  // Return the stored buffer directly (frozen / read-only contract).
  return asset;
}

/**
 * Returns the asset for `key`.
 * - If `encoding` is provided, returns a string decoded with `TextDecoder`.
 * - Otherwise returns **a copy** of the raw bytes as an `ArrayBuffer`
 *   (safe to mutate; mirrors Node's `ArrayBuffer.prototype.slice` behaviour).
 *
 * @param {string} key
 * @param {string} [encoding]
 * @returns {string | ArrayBuffer}
 *
 * @example
 * const text = getAsset('readme.txt', 'utf-8');
 * const copy = getAsset('data.bin');            // ArrayBuffer copy
 */
export function getAsset(key, encoding) {
  if (encoding !== undefined) validateString(encoding, 'encoding');
  const asset = getRawAsset(key);
  if (encoding === undefined) {
    // Return a copy so the caller can freely mutate it (Node parity).
    return asset.slice(0);
  }
  return new TextDecoder(encoding).decode(asset);
}

/**
 * Returns the asset for `key` wrapped in a `Blob`.
 * Requires `Blob` to be available as a global (all modern browsers, Node ≥ 15.7).
 *
 * @param {string} key
 * @param {BlobPropertyBag} [options] - e.g. `{ type: 'application/json' }`
 * @returns {Blob}
 *
 * @example
 * const b = getAssetAsBlob('icon.png', { type: 'image/png' });
 * const url = URL.createObjectURL(b);
 */
export function getAssetAsBlob(key, options) {
  if (typeof globalThis.Blob === 'undefined')
    throw new Error('sea: Blob is not available in this environment');
  const asset = getRawAsset(key);
  return new globalThis.Blob([asset], options);
}

/**
 * Returns an array of all injected asset keys.
 * Throws if the application is not in SEA mode.
 *
 * @returns {string[]}
 *
 * @example
 * for (const key of getAssetKeys()) {
 *   console.log(key, getAsset(key, 'utf-8'));
 * }
 */
export function getAssetKeys() {
  if (!isSea()) throw errNotInSea();
  return [..._store.keys()];
}

// ---------------------------------------------------------------------------
// Escape hatch — programmatic asset injection (tests / runtime loaders)
// ---------------------------------------------------------------------------

/**
 * Injects an asset into the SEA store at runtime.
 * Not part of Node's `node:sea` API — provided for testing and programmatic
 * loaders (e.g. a Service Worker that fetches assets and caches them here).
 *
 * Calling this at least once causes `isSea()` to return `true`.
 *
 * @param {string} key
 * @param {ArrayBuffer | ArrayBufferView | string} data
 *   - `ArrayBuffer` / `ArrayBufferView` — stored as a frozen copy.
 *   - `string` — treated as base64-encoded bytes.
 */
export function injectAsset(key, data) {
  validateString(key, 'key');
  if (typeof data === 'string') {
    _store.set(key, b64ToBuffer(data));
  } else if (data instanceof ArrayBuffer) {
    _store.set(key, data.slice(0));
  } else if (ArrayBuffer.isView(data)) {
    _store.set(key, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  } else {
    throw errInvalidArgType('data', 'ArrayBuffer, ArrayBufferView, or base64 string', data);
  }
}

export default { isSea, getRawAsset, getAsset, getAssetAsBlob, getAssetKeys, injectAsset };

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// ── Build-time (Vite / Rollup / esbuild) ─────────────────────────────────────
// // vite.config.js:
// import { readFileSync } from 'fs';
// const toB64 = path => readFileSync(path).toString('base64');
// export default {
//   define: {
//     __SEA_INJECT__: JSON.stringify({
//       'config.json': toB64('./src/config.json'),
//       'model.bin':   toB64('./src/model.bin'),
//     }),
//   },
// };
//
// // app.js:
// import { isSea, getAsset, getAssetAsBlob, getAssetKeys } from './sea';
//
// if (isSea()) {
//   const config = JSON.parse(getAsset('config.json', 'utf-8'));
//   const binCopy = getAsset('model.bin');           // ArrayBuffer copy
//   const blob = getAssetAsBlob('model.bin', { type: 'application/octet-stream' });
//   const url  = URL.createObjectURL(blob);          // usable in fetch / img src
//   console.log(getAssetKeys());                     // ['config.json', 'model.bin']
// }
//
// ── Runtime / test injection ──────────────────────────────────────────────────
// import { injectAsset, isSea, getAsset } from './sea';
//
// // Inject from a fetch response
// const ab = await fetch('/assets/greeting.txt').then(r => r.arrayBuffer());
// injectAsset('greeting.txt', ab);
// console.log(isSea());                             // true
// console.log(getAsset('greeting.txt', 'utf-8'));   // 'Hello, world!'
//
// // Inject from plain text
// injectAsset('readme.txt', btoa('Hello from SEA'));
// console.log(getAsset('readme.txt', 'utf-8'));     // 'Hello from SEA'
//
// ── Edge: errors ──────────────────────────────────────────────────────────────
// // No assets injected yet
// isSea();                                          // false
// getAsset('missing');                              // ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION
//
// // After injection, missing key:
// injectAsset('a', new Uint8Array([1, 2, 3]));
// getAsset('nope');                                 // ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND
//
// // getRawAsset returns a read-only view — mutations are undefined behaviour:
// const raw = getRawAsset('a');
// new Uint8Array(raw)[0] = 99;                      // silently ignored
// console.log(new Uint8Array(getRawAsset('a'))[0]); // still 1 — store is protected
