/*!
 * sea — node:sea for browsers & bundlers, backed by a virtual asset store
 * MIT License.
 * Node.js parity: node:sea @ Node v24.20.0
 * Dependencies: none
 *
 * A browser sandbox is never a Single Executable Application *binary*, but
 * the host runtime can embed assets into the sandbox exactly the way a SEA
 * binary embeds them. When it does, this module serves them for real:
 *
 *   - isSea()            → true when the virtual store holds ≥1 asset,
 *                           false otherwise
 *   - getRawAsset(key)   → ArrayBuffer copy of the asset bytes (or undefined)
 *   - getAsset(key)      → Uint8Array copy of the asset bytes (or undefined)
 *   - getAsset(key, enc) → decoded string (or undefined)
 *   - getAssetAsBlob(key[, options]) → Blob (or undefined)
 *   - getAssetKeys()     → string[] of embedded keys (or [])
 *
 * Population (host side — there is deliberately NO injectAsset() in this
 * module; assets flow host → sandbox, never the reverse):
 *
 *   1. Build-time (preferred): pass `seaAssets` in the sandbox options —
 *      `new Sandbox({ ..., seaAssets: { 'config.json': '{"a":1}',
 *                                          'app.wasm': wasmBytes } })`.
 *      Values may be a string (utf8), a Uint8Array / ArrayBuffer (binary),
 *      or a pre-normalized { encoding: 'utf8'|'base64', data } entry.
 *      The runtime normalizes this (see normalizeSeaAssets in runtime.js)
 *      and publishes it on the per-sandbox runtime object as
 *      `globalThis._RUNTIME_.__SEA_ASSETS__`, mirroring how the `fs` option
 *      becomes `__USER_FILES__`. The key is omitted entirely when no assets
 *      are configured.
 *   2. Runtime: a host may assign/extend
 *      `globalThis._RUNTIME_.__SEA_ASSETS__` directly. Entries may use the
 *      normalized { encoding, data } shape, or the lenient shapes above
 *      (plain string / Uint8Array / ArrayBuffer); malformed entries read
 *      back as undefined rather than throwing.
 *
 * isSea() semantics (deliberate, documented): real Node keys isSea() off
 * whether the process image is a SEA binary. Here it reports whether the
 * sandbox is running as a bundled, asset-carrying application — i.e. whether
 * the virtual store is present and non-empty. The embedding mechanism
 * (native binary vs. sandbox bundle) is an implementation detail; what
 * node:sea's contract promises user code is "am I a bundled app with
 * embedded assets I can read", and with __SEA_ASSETS__ populated the honest
 * answer is yes. This also makes isSea() a reliable feature-detect:
 * `if (sea.isSea()) { sea.getAsset(k) }` never fabricates data.
 *
 * When no store is present the module keeps the honest empty behavior:
 * isSea() → false, getters → undefined / []. Per this project's
 * noop-over-throw rule for browser-impossible APIs, missing assets return
 * empty values instead of throwing
 * ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION the way real Node does outside
 * a SEA binary. Argument validation (ERR_INVALID_ARG_TYPE) is preserved
 * exactly, including Node's message rendering, since validation happens
 * before the SEA check in real Node.
 *
 * Deliberate deviations from real Node (documented, not hidden):
 *   1. Real Node throws ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION for valid
 *      getter calls when not in a SEA binary; this module returns
 *      undefined / [] when no virtual store is present (noop over throw).
 *   2. isSea() reflects the virtual asset store, not the process image.
 *   3. getAsset(key) without an encoding returns a Uint8Array instead of a
 *      Buffer. This module stays dependency-free; our Buffer is a
 *      Uint8Array subclass, so Buffer.from(sea.getAsset(k)) is trivial
 *      where a real Buffer is needed.
 *   4. There is intentionally NO injectAsset() export and no
 *      __SEA_INJECT__ build-time hook on this module: asset injection is a
 *      host/runtime capability (sandbox options / __SEA_ASSETS__), not a
 *      guest API.
 */

// ---------------------------------------------------------------------------
// Error factories — match Node's ERR_INVALID_ARG_TYPE shape exactly.
// Message rendering mirrors Node's internal "Received ..." formatting:
//   primitives → `type <typeof> (<repr>)`   e.g. `type number (1)`
//   null/undefined → `null` / `undefined`
//   objects → `an instance of <CtorName>`  e.g. `an instance of Array`
// ---------------------------------------------------------------------------

/** @param {unknown} v @returns {string} */
function inspectReceived(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'function') return `function ${v.name}`;
  if (t === 'object') {
    const ctor = v.constructor;
    if (typeof ctor === 'function' && typeof ctor.name === 'string' && ctor.name !== '') {
      return `an instance of ${ctor.name}`;
    }
    // Null-prototype objects: Node falls back to an inspect-style tag.
    // Observed Node v24 rendering: empty → `[Object: null prototype] {}`,
    // non-empty → `[Object: null prototype]`; arrays analogously.
    if (Array.isArray(v)) {
      return v.length === 0 ? '[Array(0): null prototype] []' : '[Array: null prototype]';
    }
    return Object.keys(v).length === 0 ? '[Object: null prototype] {}' : '[Object: null prototype]';
  }
  let repr;
  if (t === 'bigint') repr = `${String(v)}n`;
  else if (t === 'number' && Object.is(v, -0)) repr = '-0';
  else repr = String(v);
  return `type ${t} (${repr})`;
}

/**
 * @param {string} name
 * @param {unknown} received
 * @returns {TypeError}
 */
function errInvalidArgType(name, received) {
  return Object.assign(
    new TypeError(
      `The "${name}" argument must be of type string. Received ${inspectReceived(received)}`,
    ),
    { code: 'ERR_INVALID_ARG_TYPE' },
  );
}

/**
 * @param {unknown} encoding
 * @returns {Error}
 */
function errUnknownEncoding(encoding) {
  return Object.assign(new Error(`Unknown encoding: ${encoding}`), {
    code: 'ERR_UNKNOWN_ENCODING',
  });
}

// ---------------------------------------------------------------------------
// Internal validation (matches real Node: validation runs before the SEA
// check, so invalid args throw even when no asset store is present)
// ---------------------------------------------------------------------------

/** @param {unknown} v @param {string} name */
function validateString(v, name) {
  if (typeof v !== 'string') throw errInvalidArgType(name, v);
}

// ---------------------------------------------------------------------------
// Virtual asset store
// ---------------------------------------------------------------------------

/**
 * Read the host-published store. Looked up lazily on every call (never
 * cached at module scope) so hosts may populate __SEA_ASSETS__ after this
 * module has loaded, and so the module still imports cleanly outside the
 * sandbox (tests, direct import) where globalThis._RUNTIME_ is undefined.
 *
 * NOTE: the source MUST spell `globalThis._RUNTIME_` exactly — the runtime
 * AST-rewrites that MemberExpression to the per-sandbox
 * `globalThis._RUNTIME<uuid>_` in _build_file.
 *
 * @returns {object|undefined}
 */
function getStore() {
  if (typeof globalThis._RUNTIME_ === 'undefined') return undefined;
  const store = globalThis._RUNTIME_.__SEA_ASSETS__;
  if (!store || typeof store !== 'object') return undefined;
  return store;
}

/** @returns {boolean} true when the virtual store holds at least one asset. */
function hasAssets() {
  const store = getStore();
  return !!store && Object.keys(store).length > 0;
}

/** @param {string} s @returns {Uint8Array} */
function base64ToBytes(s) {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** @param {Uint8Array} bytes @returns {string} */
function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Decode one store entry to fresh bytes. Accepts the normalized
 * { encoding: 'utf8'|'base64', data: string } shape written by the runtime,
 * plus lenient host-assigned shapes (plain string → utf8, ArrayBuffer view
 * or ArrayBuffer → raw bytes). Malformed entries yield undefined instead of
 * throwing — a corrupt entry reads as "no asset", never as a crash.
 *
 * @param {unknown} entry
 * @returns {Uint8Array|undefined}
 */
function entryBytes(entry) {
  if (typeof entry === 'string') return new TextEncoder().encode(entry);
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(entry)) {
    if (entry instanceof DataView) return undefined;
    return new Uint8Array(entry.buffer.slice(entry.byteOffset, entry.byteOffset + entry.byteLength));
  }
  if (
    entry &&
    typeof entry === 'object' &&
    Object.prototype.toString.call(entry) === '[object ArrayBuffer]'
  ) {
    return new Uint8Array(entry.slice(0));
  }
  if (entry && typeof entry === 'object' && typeof entry.data === 'string') {
    try {
      if (entry.encoding === 'utf8' || entry.encoding === 'utf-8') {
        return new TextEncoder().encode(entry.data);
      }
      if (entry.encoding === 'base64') {
        return base64ToBytes(entry.data);
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Look up `key` in the virtual store.
 * @param {string} key
 * @returns {Uint8Array|undefined} fresh bytes, or undefined when the store
 * is absent, the key is missing, or the entry is malformed.
 */
function lookupBytes(key) {
  const store = getStore();
  if (!store) return undefined;
  return entryBytes(store[key]);
}

/**
 * Decode bytes with a Node-style encoding name.
 * @param {Uint8Array} bytes
 * @param {string} encoding
 * @returns {string}
 */
function decodeWithEncoding(bytes, encoding) {
  const name = String(encoding).toLowerCase();
  switch (name) {
    case 'utf8':
    case 'utf-8':
      return new TextDecoder('utf-8').decode(bytes);
    case 'utf16le':
    case 'utf-16le':
    case 'ucs2':
    case 'ucs-2':
      return new TextDecoder('utf-16le').decode(bytes);
    case 'latin1':
    case 'binary':
      return new TextDecoder('latin1').decode(bytes);
    case 'ascii': {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0x7f);
      return s;
    }
    case 'base64':
      return bytesToBase64(bytes);
    case 'hex': {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
      return s;
    }
    default:
      throw errUnknownEncoding(encoding);
  }
}

// ---------------------------------------------------------------------------
// Public API — mirrors node:sea's export surface exactly
// ---------------------------------------------------------------------------

/**
 * Whether the current process is running as a bundled, asset-carrying
 * application. True when the host runtime embedded a non-empty virtual
 * asset store (__SEA_ASSETS__); false otherwise. Extra arguments are
 * ignored, matching real Node.
 *
 * @returns {boolean}
 */
export function isSea() {
  return hasAssets();
}

/**
 * Returns the raw asset bytes for `key` as an ArrayBuffer (a fresh copy —
 * mutating it cannot corrupt the store), or undefined when no store is
 * present, the key is missing, or the entry is malformed.
 *
 * @param {string} key
 * @returns {ArrayBuffer|undefined}
 */
export function getRawAsset(key) {
  validateString(key, 'key');
  const bytes = lookupBytes(key);
  return bytes ? bytes.buffer : undefined;
}

/**
 * Returns the asset for `key`: a fresh Uint8Array copy of the raw bytes
 * when `encoding` is omitted, or a decoded string when it is given.
 * Returns undefined when no store is present, the key is missing, or the
 * entry is malformed. Unknown encodings throw ERR_UNKNOWN_ENCODING,
 * matching real Node.
 *
 * @param {string} key
 * @param {string} [encoding]
 * @returns {Uint8Array|string|undefined}
 */
export function getAsset(key, encoding) {
  validateString(key, 'key');
  if (encoding !== undefined) validateString(encoding, 'encoding');
  const bytes = lookupBytes(key);
  if (!bytes) return undefined;
  if (encoding === undefined) return bytes;
  return decodeWithEncoding(bytes, encoding);
}

/**
 * Returns the asset for `key` wrapped in a Blob, or undefined when no store
 * is present, the key is missing, or the entry is malformed. Like real Node,
 * `options` is not validated (only options.type is honored when present);
 * unlike real Node this is synchronous — real Node's getAssetAsBlob is also
 * synchronous (returns Blob, not a Promise).
 *
 * @param {string} key
 * @param {BlobPropertyBag} [options]
 * @returns {Blob|undefined}
 */
export function getAssetAsBlob(key, options) {
  validateString(key, 'key');
  const bytes = lookupBytes(key);
  if (!bytes) return undefined;
  const type =
    options != null && typeof options === 'object' && typeof options.type === 'string'
      ? options.type
      : '';
  return new Blob([bytes], type ? { type } : undefined);
}

/**
 * Returns the keys of all embedded assets — a fresh array per call.
 * Returns [] when no store is present (noop over throw, per project rule).
 *
 * @returns {string[]}
 */
export function getAssetKeys() {
  const store = getStore();
  return store ? Object.keys(store) : [];
}

export default { isSea, getRawAsset, getAsset, getAssetAsBlob, getAssetKeys };
