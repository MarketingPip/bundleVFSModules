/*!
 * sea-stub — node:sea for browsers & bundlers
 * MIT License.
 * Node.js parity: node:sea @ Node v24.20.0 (non-SEA behaviour)
 * Dependencies: none
 *
 * Honest stub. A browser sandbox is NEVER a Single Executable Application
 * binary, so:
 *   - isSea()            → false, always
 *   - getRawAsset()      → undefined (no asset data exists to return)
 *   - getAsset()         → undefined (never fabricates asset data)
 *   - getAssetAsBlob()   → undefined (never fabricates a Blob)
 *   - getAssetKeys()     → []        (no assets exist)
 *
 * Real Node v24 throws ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION for these
 * calls outside a SEA binary ("Operation cannot be invoked when not in a
 * single-executable application"). Per this project's noop-over-throw rule
 * for browser-impossible APIs, this shim returns empty values instead of
 * throwing. Argument validation (ERR_INVALID_ARG_TYPE) is preserved exactly,
 * including Node's message rendering, since validation happens before the
 * SEA check in real Node.
 *
 * Deliberate deviations from real Node (documented, not hidden):
 *   1. Real Node throws ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION for valid
 *      getter calls when not in a SEA binary; this stub returns
 *      undefined / [] (noop over throw).
 *   2. There is intentionally NO injectAsset() escape hatch and NO
 *      __SEA_INJECT__ build-time hook: this sandbox can never be a SEA
 *      binary, so accepting injected assets would fabricate SEA-ness.
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

// ---------------------------------------------------------------------------
// Internal validation (matches real Node: validation runs before the SEA
// check, so invalid args throw even though the sandbox is never a SEA binary)
// ---------------------------------------------------------------------------

/** @param {unknown} v @param {string} name */
function validateString(v, name) {
  if (typeof v !== 'string') throw errInvalidArgType(name, v);
}

// ---------------------------------------------------------------------------
// Public API — mirrors node:sea's export surface exactly
// ---------------------------------------------------------------------------

/**
 * Whether the current process is a Single Executable Application.
 * Always `false` in a browser sandbox (it is never a SEA binary).
 * Extra arguments are ignored, matching real Node.
 *
 * @returns {boolean}
 */
export function isSea() {
  return false;
}

/**
 * Returns the raw asset buffer for `key`.
 * Real Node returns an ArrayBuffer inside a SEA binary and throws
 * ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION otherwise; this stub returns
 * `undefined` because no asset data can exist here.
 *
 * @param {string} key
 * @returns {undefined}
 */
export function getRawAsset(key) {
  validateString(key, 'key');
  return undefined;
}

/**
 * Returns the asset for `key` (string when `encoding` is given, otherwise a
 * copy of the raw bytes in real Node). This stub returns `undefined` —
 * it never fabricates asset data.
 *
 * @param {string} key
 * @param {string} [encoding]
 * @returns {undefined}
 */
export function getAsset(key, encoding) {
  validateString(key, 'key');
  if (encoding !== undefined) validateString(encoding, 'encoding');
  return undefined;
}

/**
 * Returns the asset for `key` wrapped in a `Blob`.
 * Real Node returns a Promise<Blob> inside a SEA binary and throws
 * synchronously outside one; this stub returns `undefined` — it never
 * fabricates a Blob. Like real Node in non-SEA mode, `options` is not
 * validated (Node only inspects it on the SEA success path).
 *
 * @param {string} key
 * @param {BlobPropertyBag} [options]
 * @returns {undefined}
 */
export function getAssetAsBlob(key, options) {
  void options;
  validateString(key, 'key');
  return undefined;
}

/**
 * Returns the keys of all assets bundled in the SEA binary.
 * Real Node throws ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION outside a SEA
 * binary; this stub returns `[]` (noop over throw) — a fresh array per call.
 *
 * @returns {string[]}
 */
export function getAssetKeys() {
  return [];
}

export default { isSea, getRawAsset, getAsset, getAssetAsBlob, getAssetKeys };
