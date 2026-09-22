/*!
 * querystring-web — node:querystring for browsers & bundlers
 * MIT License.
 * Node.js parity: node:querystring @ v24.20.0
 *
 * Ported from Node.js lib/querystring.js and lib/internal/querystring.js
 * (MIT License — Joyent, Inc. and other Node contributors). The port is
 * dependency-free ESM: Node internals (primordials, internal/errors,
 * internal/querystring, buffer) are replaced with native equivalents below.
 * The quirky legacy escape/unescape semantics are ported faithfully, not
 * "improved".
 *
 * Browser adaptations (documented, not silent):
 *  - `unescapeBuffer()` returns a Uint8Array subclass with a UTF-8
 *    `.toString()` instead of a Node Buffer (indexed byte access works the
 *    same; `.toString()` decodes UTF-8 like Buffer#toString()). Decoding
 *    uses the platform TextDecoder API, present in every browser, worker,
 *    bundler runtime, and Node.js.
 */

// ---------------------------------------------------------------------------
// Node-style error used by the encoder (cf. internal/errors ERR_INVALID_URI)
// ---------------------------------------------------------------------------

class ERR_INVALID_URI extends URIError {
  constructor() {
    super('URI malformed');
    this.code = 'ERR_INVALID_URI';
  }
}
// Node's internal error classes do not shadow `constructor` on their
// prototype, so `err.constructor` (and `constructor.name`) resolve to the
// base URIError — match that exactly.
delete ERR_INVALID_URI.prototype.constructor;

// ---------------------------------------------------------------------------
// internal/querystring (inlined): hexTable, isHexTable, encodeStr
// ---------------------------------------------------------------------------

const hexTable = new Array(256);
for (let i = 0; i < 256; ++i)
  hexTable[i] = '%' +
                ((i < 16 ? '0' : '') + i.toString(16)).toUpperCase();

const isHexTable = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 32 - 47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48 - 63
  0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 64 - 79
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 80 - 95
  0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 96 - 111
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 112 - 127
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 128 ...
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  // ... 256
]);

/**
 * @param {string} str
 * @param {Int8Array} noEscapeTable
 * @param {string[]} hexTable
 * @returns {string}
 */
function encodeStr(str, noEscapeTable, hexTable) {
  const len = str.length;
  if (len === 0)
    return '';

  let out = '';
  let lastPos = 0;
  let i = 0;

  outer:
  for (; i < len; i++) {
    let c = str.charCodeAt(i);

    // ASCII
    while (c < 0x80) {
      if (noEscapeTable[c] !== 1) {
        if (lastPos < i)
          out += str.slice(lastPos, i);
        lastPos = i + 1;
        out += hexTable[c];
      }

      if (++i === len)
        break outer;

      c = str.charCodeAt(i);
    }

    if (lastPos < i)
      out += str.slice(lastPos, i);

    // Multi-byte characters ...
    if (c < 0x800) {
      lastPos = i + 1;
      out += hexTable[0xC0 | (c >> 6)] +
             hexTable[0x80 | (c & 0x3F)];
      continue;
    }
    if (c < 0xD800 || c >= 0xE000) {
      lastPos = i + 1;
      out += hexTable[0xE0 | (c >> 12)] +
             hexTable[0x80 | ((c >> 6) & 0x3F)] +
             hexTable[0x80 | (c & 0x3F)];
      continue;
    }
    // Surrogate pair
    ++i;

    // This branch should never happen because all URLSearchParams entries
    // should already be converted to USVString. But, included for
    // completion's sake anyway.
    if (i >= len)
      throw new ERR_INVALID_URI();

    const c2 = str.charCodeAt(i) & 0x3FF;

    lastPos = i + 1;
    c = 0x10000 + (((c & 0x3FF) << 10) | c2);
    out += hexTable[0xF0 | (c >> 18)] +
           hexTable[0x80 | ((c >> 12) & 0x3F)] +
           hexTable[0x80 | ((c >> 6) & 0x3F)] +
           hexTable[0x80 | (c & 0x3F)];
  }
  if (lastPos === 0)
    return str;
  if (lastPos < len)
    return out + str.slice(lastPos);
  return out;
}

// ---------------------------------------------------------------------------
// Minimal Buffer stand-in for unescapeBuffer() (browser-safe).
// Supports indexed byte access and UTF-8 .toString(), like Node's Buffer
// for the operations the querystring API performs.
// ---------------------------------------------------------------------------

class QueryStringBuffer extends Uint8Array {
  toString() {
    return new TextDecoder().decode(this);
  }
  static allocUnsafe(length) {
    return new QueryStringBuffer(length);
  }
}

// ---------------------------------------------------------------------------
// lib/querystring.js (ported)
// ---------------------------------------------------------------------------

const unhexTable = new Int8Array([
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 0 - 15
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 16 - 31
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 32 - 47
  +0, +1, +2, +3, +4, +5, +6, +7, +8, +9, -1, -1, -1, -1, -1, -1, // 48 - 63
  -1, 10, 11, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 64 - 79
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 80 - 95
  -1, 10, 11, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 96 - 111
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 112 - 127
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, // 128 ...
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,  // ... 255
]);

/**
 * A safe fast alternative to decodeURIComponent
 * @param {string} s
 * @param {boolean} decodeSpaces
 * @returns {Uint8Array}
 */
function unescapeBuffer(s, decodeSpaces) {
  const out = QueryStringBuffer.allocUnsafe(s.length);
  let index = 0;
  let outIndex = 0;
  let currentChar;
  let nextChar;
  let hexHigh;
  let hexLow;
  const maxLength = s.length - 2;
  // Flag to know if some hex chars have been decoded
  let hasHex = false;
  while (index < s.length) {
    currentChar = s.charCodeAt(index);
    if (currentChar === 43 /* '+' */ && decodeSpaces) {
      out[outIndex++] = 32; // ' '
      index++;
      continue;
    }
    if (currentChar === 37 /* '%' */ && index < maxLength) {
      currentChar = s.charCodeAt(++index);
      hexHigh = unhexTable[currentChar];
      if (!(hexHigh >= 0)) {
        out[outIndex++] = 37; // '%'
        continue;
      } else {
        nextChar = s.charCodeAt(++index);
        hexLow = unhexTable[nextChar];
        if (!(hexLow >= 0)) {
          out[outIndex++] = 37; // '%'
          index--;
        } else {
          hasHex = true;
          currentChar = hexHigh * 16 + hexLow;
        }
      }
    }
    out[outIndex++] = currentChar;
    index++;
  }
  return hasHex ? out.slice(0, outIndex) : out;
}

/**
 * @param {string} s
 * @param {boolean} decodeSpaces
 * @returns {string}
 */
function qsUnescape(s, decodeSpaces) {
  try {
    return decodeURIComponent(s);
  } catch {
    return querystring.unescapeBuffer(s, decodeSpaces).toString();
  }
}


// These characters do not need escaping when generating query strings:
// ! - . _ ~
// ' ( ) *
// digits
// alpha (uppercase)
// alpha (lowercase)
const noEscape = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0, // 32 - 47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48 - 63
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 64 - 79
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, // 80 - 95
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 96 - 111
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0,  // 112 - 127
]);

/**
 * QueryString.escape() replaces encodeURIComponent()
 * @see https://www.ecma-international.org/ecma-262/5.1/#sec-15.1.3.4
 * @param {any} str
 * @returns {string}
 */
function qsEscape(str) {
  if (typeof str !== 'string') {
    if (typeof str === 'object')
      str = String(str);
    else
      str += '';
  }

  return encodeStr(str, noEscape, hexTable);
}

/**
 * @param {string | number | bigint | boolean | symbol | undefined | null} v
 * @returns {string}
 */
function stringifyPrimitive(v) {
  if (typeof v === 'string')
    return v;
  if (typeof v === 'number' && Number.isFinite(v))
    return '' + v;
  if (typeof v === 'bigint')
    return '' + v;
  if (typeof v === 'boolean')
    return v ? 'true' : 'false';
  return '';
}

/**
 * @param {string | number | bigint | boolean} v
 * @param {(v: string) => string} encode
 * @returns {string}
 */
function encodeStringified(v, encode) {
  if (typeof v === 'string')
    return (v.length ? encode(v) : '');
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Values >= 1e21 automatically switch to scientific notation which requires
    // escaping due to the inclusion of a '+' in the output
    return (Math.abs(v) < 1e21 ? '' + v : encode('' + v));
  }
  if (typeof v === 'bigint')
    return '' + v;
  if (typeof v === 'boolean')
    return v ? 'true' : 'false';
  return '';
}

/**
 * @param {string | number | boolean | null} v
 * @param {(v: string) => string} encode
 * @returns {string}
 */
function encodeStringifiedCustom(v, encode) {
  return encode(stringifyPrimitive(v));
}

/**
 * @param {Record<string, string | number | boolean
 * | ReadonlyArray<string | number | boolean> | null>} obj
 * @param {string} [sep]
 * @param {string} [eq]
 * @param {{ encodeURIComponent?: (v: string) => string }} [options]
 * @returns {string}
 */
function stringify(obj, sep, eq, options) {
  sep ||= '&';
  eq ||= '=';

  // Read off the exported object (not a captured binding) so that a
  // reassigned querystring.escape is honored, exactly like Node.
  let encode = querystring.escape;
  if (options && typeof options.encodeURIComponent === 'function') {
    encode = options.encodeURIComponent;
  }
  const convert =
    (encode === qsEscape ? encodeStringified : encodeStringifiedCustom);

  if (obj !== null && typeof obj === 'object') {
    const keys = Object.keys(obj);
    const len = keys.length;
    let fields = '';
    for (let i = 0; i < len; ++i) {
      const k = keys[i];
      const v = obj[k];
      let ks = convert(k, encode);
      ks += eq;

      if (Array.isArray(v)) {
        const vlen = v.length;
        if (vlen === 0) continue;
        if (fields)
          fields += sep;
        for (let j = 0; j < vlen; ++j) {
          if (j)
            fields += sep;
          fields += ks;
          fields += convert(v[j], encode);
        }
      } else {
        if (fields)
          fields += sep;
        fields += ks;
        fields += convert(v, encode);
      }
    }
    return fields;
  }
  return '';
}

/**
 * @param {string} str
 * @returns {number[]}
 */
function charCodes(str) {
  if (str.length === 0) return [];
  if (str.length === 1) return [str.charCodeAt(0)];
  const ret = new Array(str.length);
  for (let i = 0; i < str.length; ++i)
    ret[i] = str.charCodeAt(i);
  return ret;
}
const defSepCodes = [38]; // &
const defEqCodes = [61]; // =

function addKeyVal(obj, key, value, keyEncoded, valEncoded, decode) {
  if (key.length > 0 && keyEncoded)
    key = decodeStr(key, decode);
  if (value.length > 0 && valEncoded)
    value = decodeStr(value, decode);

  if (obj[key] === undefined) {
    obj[key] = value;
  } else {
    const curValue = obj[key];
    // A simple Array-specific property check is enough here to
    // distinguish from a string value and is faster and still safe
    // since we are generating all of the values being assigned.
    if (curValue.pop)
      curValue[curValue.length] = value;
    else
      obj[key] = [curValue, value];
  }
}

/**
 * Parse a key/val string.
 * @param {string} qs
 * @param {string} sep
 * @param {string} eq
 * @param {{
 *   maxKeys?: number,
 *   decodeURIComponent?: (v: string) => string,
 * }} [options]
 * @returns {Record<string, string | string[]>}
 */
function parse(qs, sep, eq, options) {
  const obj = { __proto__: null };

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  const sepCodes = (!sep ? defSepCodes : charCodes(String(sep)));
  const eqCodes = (!eq ? defEqCodes : charCodes(String(eq)));
  const sepLen = sepCodes.length;
  const eqLen = eqCodes.length;

  let pairs = 1000;
  if (options && typeof options.maxKeys === 'number') {
    // -1 is used in place of a value like Infinity for meaning
    // "unlimited pairs" because of additional checks V8 (at least as of v5.4)
    // has to do when using variables that contain values like Infinity. Since
    // `pairs` is always decremented and checked explicitly for 0, -1 works
    // effectively the same as Infinity, while providing a significant
    // performance boost.
    pairs = (options.maxKeys > 0 ? options.maxKeys : -1);
  }

  // Read off the exported object (not a captured binding) so that a
  // reassigned querystring.unescape is honored, exactly like Node.
  let decode = querystring.unescape;
  if (options && typeof options.decodeURIComponent === 'function') {
    decode = options.decodeURIComponent;
  }
  const customDecode = (decode !== qsUnescape);

  let lastPos = 0;
  let sepIdx = 0;
  let eqIdx = 0;
  let key = '';
  let value = '';
  let keyEncoded = customDecode;
  let valEncoded = customDecode;
  const plusChar = (customDecode ? '%20' : ' ');
  let encodeCheck = 0;
  for (let i = 0; i < qs.length; ++i) {
    const code = qs.charCodeAt(i);

    // Try matching key/value pair separator (e.g. '&')
    if (code === sepCodes[sepIdx]) {
      if (++sepIdx === sepLen) {
        // Key/value pair separator match!
        const end = i - sepIdx + 1;
        if (eqIdx < eqLen) {
          // We didn't find the (entire) key/value separator
          if (lastPos < end) {
            // Treat the substring as part of the key instead of the value
            key += qs.slice(lastPos, end);
          } else if (key.length === 0) {
            // We saw an empty substring between separators
            if (--pairs === 0)
              return obj;
            lastPos = i + 1;
            sepIdx = eqIdx = 0;
            continue;
          }
        } else if (lastPos < end) {
          value += qs.slice(lastPos, end);
        }

        addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

        if (--pairs === 0)
          return obj;
        keyEncoded = valEncoded = customDecode;
        key = value = '';
        encodeCheck = 0;
        lastPos = i + 1;
        sepIdx = eqIdx = 0;
      }
    } else {
      sepIdx = 0;
      // Try matching key/value separator (e.g. '=') if we haven't already
      if (eqIdx < eqLen) {
        if (code === eqCodes[eqIdx]) {
          if (++eqIdx === eqLen) {
            // Key/value separator match!
            const end = i - eqIdx + 1;
            if (lastPos < end)
              key += qs.slice(lastPos, end);
            encodeCheck = 0;
            lastPos = i + 1;
          }
          continue;
        } else {
          eqIdx = 0;
          if (!keyEncoded) {
            // Try to match an (valid) encoded byte once to minimize unnecessary
            // calls to string decoding functions
            if (code === 37/* % */) {
              encodeCheck = 1;
              continue;
            } else if (encodeCheck > 0) {
              if (isHexTable[code] === 1) {
                if (++encodeCheck === 3)
                  keyEncoded = true;
                continue;
              } else {
                encodeCheck = 0;
              }
            }
          }
        }
        if (code === 43/* + */) {
          if (lastPos < i)
            key += qs.slice(lastPos, i);
          key += plusChar;
          lastPos = i + 1;
          continue;
        }
      }
      if (code === 43/* + */) {
        if (lastPos < i)
          value += qs.slice(lastPos, i);
        value += plusChar;
        lastPos = i + 1;
      } else if (!valEncoded) {
        // Try to match an (valid) encoded byte (once) to minimize unnecessary
        // calls to string decoding functions
        if (code === 37/* % */) {
          encodeCheck = 1;
        } else if (encodeCheck > 0) {
          if (isHexTable[code] === 1) {
            if (++encodeCheck === 3)
              valEncoded = true;
          } else {
            encodeCheck = 0;
          }
        }
      }
    }
  }

  // Deal with any leftover key or value data
  if (lastPos < qs.length) {
    if (eqIdx < eqLen)
      key += qs.slice(lastPos);
    else if (sepIdx < sepLen)
      value += qs.slice(lastPos);
  } else if (eqIdx === 0 && key.length === 0) {
    // We ended on an empty substring
    return obj;
  }

  addKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

  return obj;
}


/**
 * V8 does not optimize functions with try-catch blocks, so we isolate them here
 * to minimize the damage (Note: no longer true as of V8 5.4 -- but still will
 * not be inlined).
 * @param {string} s
 * @param {(v: string) => string} decoder
 * @returns {string}
 */
function decodeStr(s, decoder) {
  try {
    return decoder(s);
  } catch {
    // Dynamic read so a reassigned querystring.unescape is honored.
    return querystring.unescape(s, true);
  }
}

// ---------------------------------------------------------------------------
// Exports. The default export is the module object; internal references
// above read `querystring.escape` / `.unescape` / `.unescapeBuffer` off this
// same object so monkey-patching works exactly like Node's module.exports.
// ---------------------------------------------------------------------------

const querystring = {
  unescapeBuffer,
  // `unescape()` is a JS global, so we need to use a different local name
  unescape: qsUnescape,

  // `escape()` is a JS global, so we need to use a different local name
  escape: qsEscape,

  stringify,
  encode: stringify,

  parse,
  decode: parse,
};

export default querystring;
export {
  unescapeBuffer,
  qsUnescape as unescape,
  qsEscape as escape,
  stringify,
  stringify as encode,
  parse,
  parse as decode,
};
