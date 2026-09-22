/*!
 * string_decoder-web — node:string_decoder for browsers & bundlers.
 *
 * Reimplements Node.js lib/string_decoder.js @ v24.20.0 (MIT License —
 * Joyent, Inc. and other Node contributors) in dependency-free ESM.
 *
 * Node v24 implements the decoding in C++ (src/string_decoder.cc, via
 * `internalBinding('string_decoder')`); there is no portable JS source to
 * extract, so the algorithms below are a faithful JS transcription of that
 * C++ implementation, verified differentially against the real thing:
 *   - the incomplete-character buffering / boundary scan in DecodeData,
 *   - the FlushData replacement semantics,
 *   - the exact error codes (ERR_UNKNOWN_ENCODING, ERR_INVALID_ARG_TYPE,
 *     ERR_INVALID_THIS, ERR_STRING_TOO_LONG).
 *
 * Byte-to-string conversion notes (no Buffer dependency):
 *   - utf8: TextDecoder with { fatal: false, ignoreBOM: true }. Node decodes
 *     via V8's own UTF-8 decoder (v8::String::NewFromUtf8); TextDecoder was
 *     verified byte-identical to Buffer.toString('utf8') over 100k+ random
 *     and adversarial buffers. ignoreBOM:true preserves a leading U+FEFF,
 *     which Node does NOT strip.
 *   - utf16le/ascii/latin1/hex/base64/base64url: tiny manual codecs that are
 *     exact by construction (no invalid-input ambiguity in these codecs).
 *
 * Browser adaptations (documented, not silent):
 *   - No `process` access at all; the only platform API used is the
 *     universal TextDecoder (present in Node >= 12 and all modern browsers).
 *   - v8::String::kMaxLength (0x1fffffe8 on 64-bit builds) is used as the
 *     ERR_STRING_TOO_LONG threshold, exactly as in Node's MakeString.
 */

'use strict';

// ---------------------------------------------------------------------------
// Node-style errors
// ---------------------------------------------------------------------------

function codedTypeError(code, message) {
  const err = new TypeError(message);
  err.code = code;
  return err;
}

function errUnknownEncoding(encoding) {
  // E('ERR_UNKNOWN_ENCODING', 'Unknown encoding: %s', TypeError):
  // %s follows util.format semantics (objects without a user-defined
  // toString are inspected).
  return codedTypeError('ERR_UNKNOWN_ENCODING',
                        `Unknown encoding: ${formatS(encoding)}`);
}

// util.format %s semantics, enough for error messages.
function formatS(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const toString = value.toString;
    if (typeof toString === 'function' &&
        toString !== Object.prototype.toString &&
        toString !== Array.prototype.toString) {
      try { return String(value); } catch { /* fall through to inspect */ }
    }
  }
  return inspectLike(value);
}

// Minimal util.inspect replacement, just enough for error messages.
function inspectLike(value, depth = 2) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'string') return `'${value.replace(/'/g, "\\'")}'`;
  if (t === 'number') {
    if (value === 0) return 1 / value === -Infinity ? '-0' : '0';
    return String(value);
  }
  if (t === 'bigint') return `${value}n`;
  if (t === 'boolean') return String(value);
  if (t === 'symbol') return String(value);
  if (t === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (Array.isArray(value)) {
    if (depth < 0) return '[Array]';
    if (value.length === 0) return '[]';
    return `[ ${value.map((v) => inspectLike(v, depth - 1)).join(', ')} ]`;
  }
  if (t === 'object') {
    if (depth < 0) return '[Object]';
    const keys = Object.keys(value);
    if (keys.length === 0) {
      const ctor = value.constructor;
      return ctor && ctor.name && ctor.name !== 'Object' ? `${ctor.name} {}` : '{}';
    }
    const ctor = value.constructor;
    const prefix = ctor && ctor.name && ctor.name !== 'Object' ?
      `${ctor.name} ` : '';
    const props = keys.map(
      (k) => `${k}: ${inspectLike(value[k], depth - 1)}`);
    return `${prefix}{ ${props.join(', ')} }`;
  }
  return String(value);
}

function errInvalidArgType(name, expected, actual) {
  // Faithful port of the ERR_INVALID_ARG_TYPE message builder in
  // internal/errors.js @ v24.20.0.
  if (!Array.isArray(expected)) expected = [expected];
  let msg = 'The ';
  if (name.endsWith(' argument')) {
    // For cases like 'first argument'
    msg += `${name} `;
  } else {
    msg += `"${name}" ${name.includes('.') ? 'property' : 'argument'} `;
  }
  msg += 'must be ';

  const types = [];
  const instances = [];
  const other = [];
  for (const value of expected) {
    if (kArgTypes.includes(value)) {
      types.push(value.toLowerCase());
    } else if (classRegExp.test(value)) {
      instances.push(value);
    } else {
      other.push(value);
    }
  }

  // Special handle `object` in case other instances are allowed to outline
  // the differences between each other.
  if (instances.length > 0) {
    const pos = types.indexOf('object');
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push('Object');
    }
  }

  if (types.length > 0) {
    msg += `${types.length > 1 ? 'one of type' : 'of type'} ` +
      formatList(types, 'or');
    if (instances.length > 0 || other.length > 0) msg += ' or ';
  }

  if (instances.length > 0) {
    msg += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0) msg += ' or ';
  }

  if (other.length > 0) {
    if (other.length > 1) {
      msg += `one of ${formatList(other, 'or')}`;
    } else {
      if (other[0].toLowerCase() !== other[0]) msg += 'an ';
      msg += `${other[0]}`;
    }
  }

  msg += `. Received ${determineSpecificType(actual)}`;
  return codedTypeError('ERR_INVALID_ARG_TYPE', msg);
}

// internal/errors.js @ v24.20.0
const kArgTypes = [
  'string',
  'function',
  'number',
  'object',
  // Accept 'Function' and 'Object' as alternative to the lower cased version.
  'Function',
  'Object',
  'boolean',
  'bigint',
  'symbol',
];
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;

function formatList(list, conjunction) {
  switch (list.length) {
    case 0: return '';
    case 1: return String(list[0]);
    case 2: return `${list[0]} ${conjunction} ${list[1]}`;
    default:
      return `${list.slice(0, -1).join(', ')}, ${conjunction} ` +
        list[list.length - 1];
  }
}

// internal/errors.js determineSpecificType @ v24.20.0
function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) {
        return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      } else if (value !== value) { // eslint-disable-line no-self-compare
        return 'type number (NaN)';
      } else if (value === Infinity) {
        return 'type number (Infinity)';
      } else if (value === -Infinity) {
        return 'type number (-Infinity)';
      }
      return `type number (${value})`;
    case 'boolean':
      return `type boolean (${value})`;
    case 'symbol':
      return `type symbol (${String(value)})`;
    case 'function':
      return `function ${value.name}`;
    case 'object':
      if (value.constructor && 'name' in value.constructor) {
        return `an instance of ${value.constructor.name}`;
      }
      return inspectLike(value);
    case 'string': {
      let v = value;
      if (v.length > 28) v = `${v.slice(0, 25)}...`;
      if (!v.includes("'")) return `type string ('${v}')`;
      return `type string (${JSON.stringify(v)})`;
    }
  }
  return inspectLike(value);
}

function errInvalidThis(kind) {
  return codedTypeError(
    'ERR_INVALID_THIS',
    `Value of "this" must be of type ${kind}`
  );
}

function errStringTooLong() {
  return codedTypeError(
    'ERR_STRING_TOO_LONG',
    'Cannot create a string longer than 0x1fffffe8 characters'
  );
}

// ---------------------------------------------------------------------------
// Encoding normalization (exact port of internal/util normalizeEncoding)
// ---------------------------------------------------------------------------

function normalizeEncoding(enc) {
  if (enc == null || enc === 'utf8' || enc === 'utf-8') return 'utf8';
  return slowCases(enc);
}

function slowCases(enc) {
  switch (enc.length) {
    case 4:
      if (enc === 'UTF8') return 'utf8';
      if (enc === 'ucs2' || enc === 'UCS2') return 'utf16le';
      enc = enc.toLowerCase();
      if (enc === 'utf8') return 'utf8';
      if (enc === 'ucs2') return 'utf16le';
      break;
    case 3:
      if (enc === 'hex' || enc === 'HEX' ||
          enc.toLowerCase() === 'hex')
        return 'hex';
      break;
    case 5:
      if (enc === 'ascii') return 'ascii';
      if (enc === 'ucs-2') return 'utf16le';
      if (enc === 'UTF-8') return 'utf8';
      if (enc === 'ASCII') return 'ascii';
      if (enc === 'UCS-2') return 'utf16le';
      enc = enc.toLowerCase();
      if (enc === 'utf-8') return 'utf8';
      if (enc === 'ascii') return 'ascii';
      if (enc === 'ucs-2') return 'utf16le';
      break;
    case 6:
      if (enc === 'base64') return 'base64';
      if (enc === 'latin1' || enc === 'binary') return 'latin1';
      if (enc === 'BASE64') return 'base64';
      if (enc === 'LATIN1' || enc === 'BINARY') return 'latin1';
      enc = enc.toLowerCase();
      if (enc === 'base64') return 'base64';
      if (enc === 'latin1' || enc === 'binary') return 'latin1';
      break;
    case 7:
      if (enc === 'utf16le' || enc === 'UTF16LE' ||
          enc.toLowerCase() === 'utf16le')
        return 'utf16le';
      break;
    case 8:
      if (enc === 'utf-16le' || enc === 'UTF-16LE' ||
          enc.toLowerCase() === 'utf-16le')
        return 'utf16le';
      break;
    case 9:
      if (enc === 'base64url' || enc === 'BASE64URL' ||
          enc.toLowerCase() === 'base64url')
        return 'base64url';
      break;
    default:
      if (enc === '') return 'utf8';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Byte-to-string codecs (exact, dependency-free)
// ---------------------------------------------------------------------------

let utf8Decoder;
function utf8Decode(bytes) {
  // Matches V8's decoder used by Node (verified over 100k+ random buffers).
  // ignoreBOM:true — Node does not strip a leading U+FEFF.
  if (utf8Decoder === undefined) {
    utf8Decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  }
  return utf8Decoder.decode(bytes);
}

// Chunked String.fromCharCode to stay clear of argument-count limits.
function fromCharCodes(codes) {
  let out = '';
  for (let i = 0; i < codes.length; i += 8192) {
    out += String.fromCharCode.apply(null, codes.subarray(i, i + 8192));
  }
  return out;
}

function utf16leDecode(bytes) {
  const codes = new Uint16Array(Math.floor(bytes.length / 2));
  for (let i = 0, k = 0; i + 1 < bytes.length; i += 2, k++) {
    codes[k] = bytes[i] | (bytes[i + 1] << 8);
  }
  return fromCharCodes(codes);
}

function asciiDecode(bytes) {
  const codes = new Uint16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) codes[i] = bytes[i] & 0x7F;
  return fromCharCodes(codes);
}

function latin1Decode(bytes) {
  const codes = new Uint16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) codes[i] = bytes[i];
  return fromCharCodes(codes);
}

const hexTable = Array.from(
  { length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function hexEncode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    const end = Math.min(i + 8192, bytes.length);
    const parts = new Array(end - i);
    for (let j = i, k = 0; j < end; j++, k++) parts[k] = hexTable[bytes[j]];
    out += parts.join('');
  }
  return out;
}

const base64Alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64UrlAlphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64Encode(bytes, urlSafe) {
  const alpha = urlSafe ? base64UrlAlphabet : base64Alphabet;
  const n = bytes.length;
  const full = n - (n % 3);
  const parts = [];
  for (let i = 0; i < full; i += 3) {
    const x = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    parts.push(alpha[x >> 18],
               alpha[(x >> 12) & 63],
               alpha[(x >> 6) & 63],
               alpha[x & 63]);
  }
  const rem = n - full;
  if (rem === 1) {
    const x = bytes[full] << 16;
    parts.push(alpha[x >> 18], alpha[(x >> 12) & 63]);
    if (!urlSafe) parts.push('==');
  } else if (rem === 2) {
    const x = (bytes[full] << 16) | (bytes[full + 1] << 8);
    parts.push(alpha[x >> 18], alpha[(x >> 12) & 63], alpha[(x >> 6) & 63]);
    if (!urlSafe) parts.push('=');
  }
  return parts.join('');
}

function decodeBytes(bytes, encoding) {
  switch (encoding) {
    case 'utf8': return utf8Decode(bytes);
    case 'utf16le': return utf16leDecode(bytes);
    case 'base64': return base64Encode(bytes, false);
    case 'base64url': return base64Encode(bytes, true);
    case 'ascii': return asciiDecode(bytes);
    case 'latin1': return latin1Decode(bytes);
    case 'hex': return hexEncode(bytes);
    default: throw errUnknownEncoding(encoding); // unreachable
  }
}

// v8::String::kMaxLength on 64-bit builds; Node throws ERR_STRING_TOO_LONG
// from MakeString when a single decode would exceed it.
const kMaxStringLength = 0x1fffffe8;

function checkOutputLength(encoding, byteLength) {
  // Exact output-length bounds per encoding (output length is a pure
  // function of the input length for these codecs).
  let maxBytes;
  switch (encoding) {
    case 'utf8':
    case 'ascii':
    case 'latin1':
      maxBytes = kMaxStringLength;
      break;
    case 'utf16le':
      maxBytes = kMaxStringLength * 2;
      break;
    case 'hex':
      maxBytes = Math.floor(kMaxStringLength / 2);
      break;
    case 'base64':
    case 'base64url':
      maxBytes = Math.floor(kMaxStringLength / 4) * 3;
      break;
    default:
      maxBytes = kMaxStringLength;
  }
  if (byteLength > maxBytes) throw errStringTooLong();
}

// ---------------------------------------------------------------------------
// Decoder state
// ---------------------------------------------------------------------------

const kState = Symbol('kState');

// lastChar must expose .equals() like Node's Buffer-backed view does.
class IncompleteCharBuffer extends Uint8Array {
  equals(other) {
    if (other == null || other.length !== this.length) return false;
    for (let i = 0; i < this.length; i++) {
      if (this[i] !== other[i]) return false;
    }
    return true;
  }
}

// Normalize any ArrayBufferView (Buffer, TypedArray, DataView) to a
// byte-level Uint8Array, honoring byteOffset/byteLength.
function toBytes(view) {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

// ---------------------------------------------------------------------------
// Core decode — JS transcription of StringDecoder::DecodeData
// (src/string_decoder.cc @ v24.20.0)
// ---------------------------------------------------------------------------

function decodeData(state, data) {
  const encoding = state.encoding;
  let nread = data.length;
  let prepend = '';

  if (encoding === 'utf8' || encoding === 'utf16le' ||
      encoding === 'base64' || encoding === 'base64url') {
    // Finish a character split across the previous chunk boundary, if any.
    if (state.missing > 0) {
      if (encoding === 'utf8') {
        // Special treatment to align with the V8 decoder: if a byte that
        // should continue the incomplete character does not, stop the
        // incomplete character here (keeping its bytes buffered for the
        // prepend below) and let the new byte start a fresh character.
        for (let i = 0; i < nread && i < state.missing; i++) {
          if ((data[i] & 0xC0) !== 0x80) {
            state.missing = 0;
            state.charBuf.set(data.subarray(0, i), state.buffered);
            state.buffered += i;
            data = data.subarray(i);
            nread -= i;
            break;
          }
        }
      }

      const found = Math.min(nread, state.missing);
      state.charBuf.set(data.subarray(0, found), state.buffered);
      data = data.subarray(found);
      nread -= found;
      state.missing -= found;
      state.buffered += found;

      if (state.missing === 0) {
        prepend = decodeBytes(state.charBuf.subarray(0, state.buffered),
                              encoding);
        state.buffered = 0;
      }
    }

    let body;
    if (nread === 0) {
      // The fill above consumed the whole chunk.
      body = prepend;
      prepend = '';
    } else {
      // Look for a character cut off at the end of this chunk that the
      // next write() will have to finish.
      if (encoding === 'utf8' && (data[nread - 1] & 0x80) !== 0) {
        for (let i = nread - 1; ; i--) {
          state.buffered++;
          if ((data[i] & 0xC0) === 0x80) {
            // Trailing byte: keep scanning backwards for the lead byte.
            if (state.buffered >= 4 || i === 0) {
              // Four or more trailing bytes, or no lead byte in this chunk
              // at all: invalid UTF-8, let the decoder handle it inline.
              state.buffered = 0;
              break;
            }
          } else {
            // Found the lead byte; derive the expected character length.
            if ((data[i] & 0xE0) === 0xC0) state.missing = 2;
            else if ((data[i] & 0xF0) === 0xE0) state.missing = 3;
            else if ((data[i] & 0xF8) === 0xF0) state.missing = 4;
            else {
              // Lead byte outside the representable range: invalid.
              state.buffered = 0;
              break;
            }
            if (state.buffered >= state.missing) {
              // Have at least as many trailing bytes as the lead indicates:
              // either complete (nothing to buffer) or invalid anyway.
              state.missing = 0;
              state.buffered = 0;
            }
            state.missing -= state.buffered;
            break;
          }
        }
      } else if (encoding === 'utf16le') {
        if (nread % 2 === 1) {
          // Half a code unit; need its second byte.
          state.buffered = 1;
          state.missing = 1;
        } else if ((data[nread - 1] & 0xFC) === 0xD8) {
          // Split surrogate pair; need the low surrogate.
          state.buffered = 2;
          state.missing = 2;
        }
      } else if (encoding === 'base64' || encoding === 'base64url') {
        // base64 / base64url: incomplete trailing quantum.
        state.buffered = nread % 3;
        if (state.buffered > 0) state.missing = 3 - state.buffered;
      }
      // (utf8 with an ASCII last byte needs no boundary buffering.)

      if (state.buffered > 0) {
        nread -= state.buffered;
        state.charBuf.set(data.subarray(nread, nread + state.buffered), 0);
      }

      checkOutputLength(encoding, nread);
      body = nread > 0 ? decodeBytes(data.subarray(0, nread), encoding) : '';
    }

    return prepend !== '' ? prepend + body : body;
  }

  // ascii, hex, latin1: no cross-chunk state.
  checkOutputLength(encoding, nread);
  return decodeBytes(data, encoding);
}

// JS transcription of StringDecoder::FlushData.
function flushData(state) {
  if (state.encoding === 'utf16le' && state.buffered % 2 === 1) {
    // Ignore a single trailing byte, like Node's decoder does.
    state.missing--;
    state.buffered--;
  }
  if (state.buffered === 0) return '';
  const ret = decodeBytes(state.charBuf.subarray(0, state.buffered),
                          state.encoding);
  state.missing = 0;
  state.buffered = 0;
  return ret;
}

// ---------------------------------------------------------------------------
// StringDecoder
// ---------------------------------------------------------------------------

/**
 * StringDecoder provides an interface for efficiently splitting a series of
 * buffers into a series of JS strings without breaking apart multibyte
 * characters.
 * @param {string} [encoding]
 */
function StringDecoder(encoding) {
  const normalized = normalizeEncoding(encoding);
  if (normalized === undefined) {
    throw errUnknownEncoding(encoding);
  }
  this.encoding = normalized;
  this[kState] = {
    encoding: normalized,
    charBuf: new IncompleteCharBuffer(4),
    missing: 0,   // kMissingBytes: bytes still needed to finish the char
    buffered: 0,  // kBufferedBytes: bytes held in charBuf
  };
}

/**
 * Returns a decoded string, omitting any incomplete multi-byte characters
 * at the end of the Buffer, or TypedArray, or DataView.
 * @param {string | Buffer | TypedArray | DataView} buf
 * @returns {string}
 */
StringDecoder.prototype.write = function write(buf) {
  if (typeof buf === 'string') return buf;
  if (!ArrayBuffer.isView(buf)) {
    throw errInvalidArgType('buf', ['Buffer', 'TypedArray', 'DataView'], buf);
  }
  const state = this[kState];
  if (!state) {
    throw errInvalidThis('StringDecoder');
  }
  return decodeData(state, toBytes(buf));
};

/**
 * Returns any remaining input stored in the internal buffer as a string.
 * After end() is called, the stringDecoder object can be reused for new
 * input.
 * @param {string | Buffer | TypedArray | DataView} [buf]
 * @returns {string}
 */
StringDecoder.prototype.end = function end(buf) {
  const ret = buf === undefined ? '' : this.write(buf);
  const state = this[kState];
  if (state.buffered > 0) return ret + flushData(state);
  return ret;
};

/* Everything below this line is undocumented legacy stuff. */
/**
 * @param {string | Buffer | TypedArray | DataView} buf
 * @param {number} offset
 * @returns {string}
 */
StringDecoder.prototype.text = function text(buf, offset) {
  const state = this[kState];
  state.missing = 0;
  state.buffered = 0;
  return this.write(buf.slice(offset));
};

Object.defineProperties(StringDecoder.prototype, {
  lastChar: {
    __proto__: null,
    configurable: true,
    enumerable: true,
    get() {
      return this[kState].charBuf.subarray(0, 4);
    },
  },
  lastNeed: {
    __proto__: null,
    configurable: true,
    enumerable: true,
    get() {
      return this[kState].missing;
    },
  },
  lastTotal: {
    __proto__: null,
    configurable: true,
    enumerable: true,
    get() {
      return this[kState].buffered + this[kState].missing;
    },
  },
});

export { StringDecoder };
// Default export mirrors the CJS module.exports shape ({ StringDecoder }),
// so require('string_decoder').StringDecoder keeps working through interop.
export default { StringDecoder };
