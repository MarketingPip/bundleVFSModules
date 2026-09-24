// Port of Node.js `buffer` module (lib/buffer.js + lib/internal/buffer.js)
// from Node.js v24.20.0, dependency-free ESM.
//
// Where Node uses C++ internalBinding('buffer') helpers (slices, writes,
// fill, compare, indexOf, swap, isUtf8/isAscii, ...), this port implements
// them in pure JavaScript with identical observable semantics (error codes,
// messages, bounds checks, return values).
//
// Browser-safe: no Node builtin imports; everything is implemented here.
// `Blob`/`resolveObjectURL` and the `util.inspect` extras formatter use the
// host's real implementations when running under Node (via
// `process.getBuiltinModule`), with dependency-free fallbacks otherwise.
// The Buffer class itself is always the pure-JS implementation below so the
// parity tests exercise this code, not the native builtin.
//
// Limitations vs. Node:
// - `Buffer.allocUnsafe()` returns zero-filled memory (JS cannot allocate
//   uninitialized memory); pooling layout still matches Node.
// - `markAsUntransferable` is a no-op (no detach-key concept in pure JS).
// - `transcode()` supports Node's built-in encodings; other ICU encodings
//   fall back to TextDecoder where available.

const hasProcess =
  typeof process !== 'undefined' && process !== null &&
  typeof process === 'object';

/** Reach the real builtin module without going through any loader patches. */
function getBuiltinModuleSafe(name) {
  try {
    if (hasProcess && typeof process.getBuiltinModule === 'function') {
      return process.getBuiltinModule(name);
    }
  } catch {
    // Continue with the pure-JS fallbacks.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// kMaxLength: internalBinding('buffer').kMaxLength (2^53 - 1, max TypedArray).
const kMaxLength = 9007199254740991;
// kStringMaxLength: internalBinding('buffer').kStringMaxLength
// (String::kMaxLength, 2^29 - 24 on 64-bit).
const kStringMaxLength = 536870888;

// ---------------------------------------------------------------------------
// internal/errors lite — exact Node v24.20.0 message formats
// ---------------------------------------------------------------------------

const kTypes = [
  'string', 'function', 'number', 'object',
  'Function', 'Object', 'boolean', 'bigint', 'symbol',
];
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;

function formatList(array, type = 'and') {
  switch (array.length) {
    case 0: return '';
    case 1: return `${array[0]}`;
    case 2: return `${array[0]} ${type} ${array[1]}`;
    case 3: return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default:
      return `${array.slice(0, -1).join(', ')}, ${type} ${array[array.length - 1]}`;
  }
}

function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  switch (type) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      if (value !== value) return 'type number (NaN)';
      if (value === Infinity) return 'type number (Infinity)';
      if (value === -Infinity) return 'type number (-Infinity)';
      return `type number (${value})`;
    case 'boolean': return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name}`;
    case 'object':
      if (value.constructor && 'name' in value.constructor) {
        return `an instance of ${value.constructor.name}`;
      }
      return miniInspect(value);
    case 'string': {
      let v = value;
      if (v.length > 28) v = `${v.slice(0, 25)}...`;
      return `type string ('${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`;
    }
    default: return `type ${type}`;
  }
}

function addNumericalSeparator(val) {
  let res = '';
  let i = val.length;
  const start = val[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) {
    res = `_${val.slice(i - 3, i)}${res}`;
  }
  return `${val.slice(0, i)}${res}`;
}

// Minimal util.inspect substitute for error "Received ..." rendering.
function miniInspect(value, depth = 2) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return `${String(value)}${t === 'bigint' ? 'n' : ''}`;
  if (t === 'symbol') return String(value);
  if (t === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (typeof value === 'object') {
    // Buffer-like: match util.inspect's <Buffer ..> rendering.
    if (isUint8Array(value)) {
      const tag = value.constructor && value.constructor.name !== 'Uint8Array'
        ? value.constructor.name : 'Buffer';
      const n = Math.min(value.length, 50);
      let hex = '';
      for (let i = 0; i < n; i++) {
        hex += (i > 0 ? ' ' : '') + value[i].toString(16).padStart(2, '0');
      }
      let s = `<${tag}${hex ? ' ' + hex : ''}>`;
      if (value.length > 50) s = `<${tag}${hex ? ' ' + hex : ''} ... ${value.length - 50} more bytes>`;
      return s;
    }
    if (depth < 0) return '[Object]';
    if (Array.isArray(value)) {
      return `[ ${value.map((v) => miniInspect(v, depth - 1)).join(', ')} ]`;
    }
    const keys = Object.keys(value);
    // Match util.inspect: null-prototype objects get the [Object: null prototype] prefix.
    const prefix = Object.getPrototypeOf(value) === null ? '[Object: null prototype] ' : '';
    if (keys.length === 0) return `${prefix}{}`;
    return `${prefix}{ ${keys.map((k) => `${k}: ${miniInspect(value[k], depth - 1)}`).join(', ')} }`;
  }
  return String(value);
}

function ERR_INVALID_ARG_TYPE(name, expected, actual) {
  if (!Array.isArray(expected)) expected = [expected];
  let msg = 'The ';
  if (name.endsWith(' argument')) {
    msg += `${name} `;
  } else {
    const type = name.includes('.') ? 'property' : 'argument';
    msg += `"${name}" ${type} `;
  }
  msg += 'must be ';
  const types = [];
  const instances = [];
  const other = [];
  for (const value of expected) {
    if (kTypes.includes(value)) {
      types.push(value.toLowerCase());
    } else if (classRegExp.exec(value) !== null) {
      instances.push(value);
    } else {
      other.push(value);
    }
  }
  if (instances.length > 0) {
    const pos = types.indexOf('object');
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push('Object');
    }
  }
  if (types.length > 0) {
    msg += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
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
  const err = new TypeError(msg);
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

function ERR_OUT_OF_RANGE(str, range, input) {
  let msg = `The value of "${str}" is out of range.`;
  let received;
  if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
    received = addNumericalSeparator(String(input));
  } else if (typeof input === 'bigint') {
    received = String(input);
    if (input > 2n ** 32n || input < -(2n ** 32n)) {
      received = addNumericalSeparator(received);
    }
    received += 'n';
  } else {
    received = miniInspect(input);
  }
  msg += ` It must be ${range}. Received ${received}`;
  const err = new RangeError(msg);
  err.code = 'ERR_OUT_OF_RANGE';
  return err;
}

function ERR_BUFFER_OUT_OF_BOUNDS(name = undefined) {
  const msg = name ? `"${name}" is outside of buffer bounds`
    : 'Attempt to access memory outside buffer bounds';
  const err = new RangeError(msg);
  err.code = 'ERR_BUFFER_OUT_OF_BOUNDS';
  return err;
}

function ERR_UNKNOWN_ENCODING(encoding) {
  const err = new TypeError(`Unknown encoding: ${encoding}`);
  err.code = 'ERR_UNKNOWN_ENCODING';
  return err;
}

function ERR_INVALID_BUFFER_SIZE(size) {
  const err = new RangeError(`Buffer size must be a multiple of ${size}`);
  err.code = 'ERR_INVALID_BUFFER_SIZE';
  return err;
}

function ERR_INVALID_ARG_VALUE(name, value, reason = 'is invalid') {
  let inspected = miniInspect(value);
  if (inspected.length > 128) inspected = `${inspected.slice(0, 128)}...`;
  const type = name.includes('.') ? 'property' : 'argument';
  const err = new TypeError(`The ${type} '${name}' ${reason}. Received ${inspected}`);
  err.code = 'ERR_INVALID_ARG_VALUE';
  return err;
}

function ERR_MISSING_ARGS(name) {
  const err = new TypeError(`The "${name}" argument must be specified`);
  err.code = 'ERR_MISSING_ARGS';
  return err;
}

function ERR_STRING_TOO_LONG() {
  const err = new Error('Cannot create a string longer than 0x1fffffe8 characters');
  err.code = 'ERR_STRING_TOO_LONG';
  return err;
}

function ERR_INVALID_STATE(message) {
  const err = new Error(message);
  err.code = 'ERR_INVALID_STATE';
  return err;
}

// Matches the C++ THROW_ERR_OUT_OF_RANGE(env, "Index out of range") used by
// the buffer binding argument parser (ParseArrayIndex).
function ERR_OUT_OF_RANGE_INDEX() {
  const err = new RangeError('Index out of range');
  err.code = 'ERR_OUT_OF_RANGE';
  return err;
}

// Matches the C++ THROW_AND_RETURN_IF_NOT_STRING used by the StringWrite
// binding (buf.hexWrite etc. require a primitive string).
function ERR_STRING_EXPECTED() {
  const err = new TypeError('argument must be a string');
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

// Pure-JS equivalent of the C++ ParseArrayIndex() used by the buffer
// bindings: undefined selects the default; otherwise ToIntegerOrInfinity
// (NaN -> 0, fractions truncated); negatives throw ERR_OUT_OF_RANGE.
function parseArrayIndex(value, def) {
  if (value === undefined) return def;
  let n = Number(value);
  n = Number.isNaN(n) ? 0 : Math.trunc(n);
  if (n < 0) throw ERR_OUT_OF_RANGE_INDEX();
  return n;
}

// ---------------------------------------------------------------------------
// internal/validators lite
// ---------------------------------------------------------------------------

function validateArray(value, name, minLength = 0) {
  if (!Array.isArray(value)) {
    throw ERR_INVALID_ARG_TYPE(name, 'Array', value);
  }
  if (value.length < minLength) {
    throw ERR_INVALID_ARG_VALUE(name, value, `must have a length of at least ${minLength}`);
  }
}

function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!Number.isInteger(value)) throw ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max) throw ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}

// validateInteger() with kMaxLength as the default maximum value.
const validateOffset = (value, name, min = 0, max = kMaxLength) =>
  validateInteger(value, name, min, max);

function validateNumber(value, name, min = undefined, max = undefined) {
  if (typeof value !== 'number') throw ERR_INVALID_ARG_TYPE(name, 'number', value);
  if ((min != null && value < min) || (max != null && value > max) ||
      ((min != null || max != null) && Number.isNaN(value))) {
    throw ERR_OUT_OF_RANGE(
      name,
      `${min != null ? `>= ${min}` : ''}${min != null && max != null ? ' && ' : ''}${max != null ? `<= ${max}` : ''}`,
      value);
  }
}

function validateString(value, name) {
  if (typeof value !== 'string') throw ERR_INVALID_ARG_TYPE(name, 'string', value);
}

function validateBuffer(buffer, name = 'buffer') {
  if (!ArrayBuffer.isView(buffer)) {
    throw ERR_INVALID_ARG_TYPE(name, ['Buffer', 'TypedArray', 'DataView'], buffer);
  }
}

// ---------------------------------------------------------------------------
// internal/util/types lite
// ---------------------------------------------------------------------------

function isUint8Array(value) {
  return value instanceof Uint8Array;
}

function isAnyArrayBuffer(value) {
  if (value === null || typeof value !== 'object') return false;
  // The DataView constructor validates the genuine internal
  // ArrayBuffer/SharedArrayBuffer slot: it accepts real buffers from any
  // realm (including resizable ones) but rejects fake subclasses built via
  // setPrototypeOf (no internal slot) and Symbol.toStringTag spoofs, which
  // `instanceof` alone cannot distinguish.
  try {
    new DataView(value);
    return true;
  } catch {
    return false;
  }
}

function isArrayBufferView(value) {
  return ArrayBuffer.isView(value);
}

function isTypedArray(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

// ---------------------------------------------------------------------------
// Encodings
// ---------------------------------------------------------------------------

// Port of internal/util normalizeEncoding().
function normalizeEncoding(enc) {
  if (enc == null || enc === 'utf8' || enc === 'utf-8') return 'utf8';
  return slowCasesEncoding(enc);
}

function slowCasesEncoding(enc) {
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
      break;
  }
  return undefined;
}

// Encoding ids mirroring internal/util encodingsMap order
// (utf8, utf16le, latin1, ascii, base64, base64url, hex).
const encodingsMap = {
  __proto__: null,
  utf8: 0, utf16le: 1, latin1: 2, ascii: 3, base64: 4, base64url: 5, hex: 6,
};

// ---------------------------------------------------------------------------
// Pure-JS codec implementations (replacing the C++ StringSlice/StringWrite,
// byteLengthUtf8, asciiWriteStatic, ... bindings)
// ---------------------------------------------------------------------------

const kU8Max = kStringMaxLength;

function checkSliceLength(start, end, factor) {
  // Node throws ERR_STRING_TOO_LONG when the decoded string would exceed
  // String::kMaxLength.
  if ((end - start) * factor > kU8Max) throw ERR_STRING_TOO_LONG();
}

// Validates (start, end) like the C++ StringSlice binding: ParseArrayIndex
// semantics, end clamped to >= start (empty result), end > byteLength throws.
function sliceBounds(buf, start, end) {
  const len = buf.byteLength;
  start = parseArrayIndex(start, 0);
  end = parseArrayIndex(end, len);
  if (end > len) throw ERR_OUT_OF_RANGE_INDEX();
  if (end < start) end = start;
  return [start, end];
}

// --- UTF-8 decode (WHATWG algorithm, matches Node/simdutf) ---

function utf8Slice(buf, start, end) {
  [start, end] = sliceBounds(buf, start, end);
  checkSliceLength(start, end, 1);
  let out = '';
  let i = start;
  while (i < end) {
    const b0 = buf[i];
    let cp;
    let bytesNeeded = 0;
    let lower = 0x80;
    let upper = 0xbf;
    if (b0 <= 0x7f) {
      out += String.fromCharCode(b0);
      i++;
      continue;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      bytesNeeded = 1;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      bytesNeeded = 2;
      if (b0 === 0xe0) lower = 0xa0;
      else if (b0 === 0xed) upper = 0x9f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      bytesNeeded = 3;
      if (b0 === 0xf0) lower = 0x90;
      else if (b0 === 0xf4) upper = 0x8f;
    } else {
      out += '\ufffd';
      i++;
      continue;
    }
    // Accumulate continuation bytes.
    cp = b0 & (bytesNeeded === 1 ? 0x1f : bytesNeeded === 2 ? 0x0f : 0x07);
    let j = 1;
    let ok = true;
    for (; j <= bytesNeeded; j++) {
      if (i + j >= end) { ok = false; break; }
      const b = buf[i + j];
      const lo = j === 1 ? lower : 0x80;
      const hi = j === 1 ? upper : 0xbf;
      if (b < lo || b > hi) { ok = false; break; }
      cp = (cp << 6) | (b & 0x3f);
    }
    if (!ok) {
      out += '\ufffd';
      i += j; // consume lead + valid continuations seen so far
      continue;
    }
    i += bytesNeeded + 1;
    if (cp <= 0xffff) {
      out += String.fromCharCode(cp);
    } else {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

function byteLengthUtf8(string) {
  let len = 0;
  for (let i = 0; i < string.length; i++) {
    let code = string.charCodeAt(i);
    if (code <= 0x7f) { len += 1; continue; }
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < string.length) {
      const next = string.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { len += 4; i++; continue; }
    }
    len += code <= 0x7ff ? 2 : 3;
  }
  return len;
}

// Writes UTF-8 bytes of `string` into buf at offset, at most `length` bytes.
// Returns bytes written. Lone surrogates encode as U+FFFD (like Node).
function utf8WriteStatic(buf, string, offset, length) {
  const end = Math.min(offset + length, buf.length);
  let pos = offset;
  for (let i = 0; i < string.length && pos < end; i++) {
    let code = string.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < string.length) {
      const next = string.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code <= 0x7f) {
      buf[pos++] = code;
    } else if (code <= 0x7ff) {
      if (pos + 2 > end) break;
      buf[pos++] = 0xc0 | (code >> 6);
      buf[pos++] = 0x80 | (code & 0x3f);
    } else if (code <= 0xffff) {
      if (pos + 3 > end) break;
      buf[pos++] = 0xe0 | (code >> 12);
      buf[pos++] = 0x80 | ((code >> 6) & 0x3f);
      buf[pos++] = 0x80 | (code & 0x3f);
    } else {
      if (pos + 4 > end) break;
      buf[pos++] = 0xf0 | (code >> 18);
      buf[pos++] = 0x80 | ((code >> 12) & 0x3f);
      buf[pos++] = 0x80 | ((code >> 6) & 0x3f);
      buf[pos++] = 0x80 | (code & 0x3f);
    }
  }
  return pos - offset;
}

// --- ASCII / latin1 ---

function asciiSlice(buf, start, end) {
  [start, end] = sliceBounds(buf, start, end);
  checkSliceLength(start, end, 1);
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(buf[i] & 0x7f);
  return out;
}

function latin1Slice(buf, start, end) {
  [start, end] = sliceBounds(buf, start, end);
  checkSliceLength(start, end, 1);
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(buf[i]);
  return out;
}

function asciiWriteStatic(buf, string, offset, length) {
  const end = Math.min(offset + length, buf.length);
  let pos = offset;
  for (let i = 0; i < string.length && pos < end; i++, pos++) {
    // Node's ascii encoding writes the low byte (same as latin1 here).
    buf[pos] = string.charCodeAt(i) & 0xff;
  }
  return pos - offset;
}

function latin1WriteStatic(buf, string, offset, length) {
  const end = Math.min(offset + length, buf.length);
  let pos = offset;
  for (let i = 0; i < string.length && pos < end; i++, pos++) {
    buf[pos] = string.charCodeAt(i) & 0xff;
  }
  return pos - offset;
}

// --- hex ---

const hexDigits = '0123456789abcdef';

function hexSlice(buf, start, end) {
  [start, end] = sliceBounds(buf, start, end);
  checkSliceLength(start, end, 2);
  let out = '';
  for (let i = start; i < end; i++) {
    const b = buf[i];
    out += hexDigits[b >> 4] + hexDigits[b & 15];
  }
  return out;
}

function hexVal(c) {
  if (c >= 48 && c <= 57) return c - 48; // 0-9
  if (c >= 97 && c <= 102) return c - 97 + 10; // a-f
  if (c >= 65 && c <= 70) return c - 65 + 10; // A-F
  return -1;
}

function hexWrite(buf, string, offset, length) {
  const end = Math.min(offset + length, buf.length);
  let pos = offset;
  let i = 0;
  const strLen = string.length;
  while (i + 1 < strLen && pos < end) {
    const hi = hexVal(string.charCodeAt(i));
    const lo = hexVal(string.charCodeAt(i + 1));
    if (hi < 0 || lo < 0) break;
    buf[pos++] = (hi << 4) | lo;
    i += 2;
  }
  return pos - offset;
}

// --- UCS2 / UTF-16LE ---

function ucs2Slice(buf, start, end) {
  [start, end] = sliceBounds(buf, start, end);
  checkSliceLength(start, end, 0.5);
  let out = '';
  const alignedEnd = end - ((end - start) & 1);
  for (let i = start; i < alignedEnd; i += 2) {
    out += String.fromCharCode(buf[i] | (buf[i + 1] << 8));
  }
  return out;
}

function ucs2Write(buf, string, offset, length) {
  const end = Math.min(offset + length, buf.length);
  let pos = offset;
  for (let i = 0; i < string.length && pos + 1 < end; i++) {
    const code = string.charCodeAt(i);
    buf[pos++] = code & 0xff;
    buf[pos++] = code >> 8;
  }
  return pos - offset;
}

// --- base64 / base64url ---

const b64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64urlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function b64Encode(buf, start, end, alphabet, pad) {
  let out = '';
  let i = start;
  const n = end - ((end - start) % 3);
  for (; i < n; i += 3) {
    const b0 = buf[i], b1 = buf[i + 1], b2 = buf[i + 2];
    out += alphabet[b0 >> 2] + alphabet[((b0 & 3) << 4) | (b1 >> 4)] +
           alphabet[((b1 & 15) << 2) | (b2 >> 6)] + alphabet[b2 & 63];
  }
  const rem = end - i;
  if (rem === 1) {
    const b0 = buf[i];
    out += alphabet[b0 >> 2] + alphabet[(b0 & 3) << 4] + (pad ? '==' : '');
  } else if (rem === 2) {
    const b0 = buf[i], b1 = buf[i + 1];
    out += alphabet[b0 >> 2] + alphabet[((b0 & 3) << 4) | (b1 >> 4)] +
           alphabet[(b1 & 15) << 2] + (pad ? '=' : '');
  }
  return out;
}

function base64Slice(buf, start, end) {
  [start, end] = sliceBounds(buf, start, end);
  checkSliceLength(start, end, 4 / 3 + 0.01);
  return b64Encode(buf, start, end, b64Alphabet, true);
}

function base64urlSlice(buf, start, end) {
  [start, end] = sliceBounds(buf, start, end);
  checkSliceLength(start, end, 4 / 3 + 0.01);
  return b64Encode(buf, start, end, b64urlAlphabet, false);
}

function b64DecodeTable(urlSafe) {
  const table = new Int8Array(256).fill(-1);
  const alpha = urlSafe ? b64urlAlphabet : b64Alphabet;
  for (let i = 0; i < 64; i++) table[alpha.charCodeAt(i)] = i;
  return table;
}
const b64Table = b64DecodeTable(false);
const b64urlTable = b64DecodeTable(true);
// Node's Buffer base64/base64url DECODER accepts both alphabets in either
// mode (only the encoder distinguishes them). atob() keeps the strict table.
const b64DecodeTableBoth = (() => {
  const table = new Int8Array(256).fill(-1);
  for (let i = 0; i < 64; i++) {
    table[b64Alphabet.charCodeAt(i)] = i;
    table[b64urlAlphabet.charCodeAt(i)] = i;
  }
  return table;
})();

// Decodes base64/base64url from `string` into buf at offset, at most `length`
// bytes. Matches Node (simdutf): non-alphabet chars are skipped, '=' ends
// decoding (padding handled per quantum). Returns bytes written.
function b64Write(buf, string, offset, length, urlSafe) {
  // Both alphabets decode in either mode; urlSafe only matters to callers
  // that pre-validate (none do — Node is lenient here too).
  const table = b64DecodeTableBoth;
  const end = Math.min(offset + length, buf.length);
  let pos = offset;
  const quads = [];
  const strLen = string.length;
  let i = 0;
  outer: while (i < strLen && pos < end) {
    quads.length = 0;
    let real = 0;
    while (quads.length < 4 && i < strLen) {
      const c = string.charCodeAt(i++);
      if (c === 61) { // '=': padding ends decoding.
        // Consume any further '=' chars, then decode this final quantum.
        while (i < strLen && string.charCodeAt(i) === 61) i++;
        if (real >= 2) {
          const v = (quads[0] << 18) | (quads[1] << 12) | (quads[2] << 6);
          buf[pos++] = (v >> 16) & 0xff;
          if (real === 3 && pos < end) buf[pos++] = (v >> 8) & 0xff;
        }
        break outer;
      }
      const v = c < 256 ? table[c] : -1;
      if (v < 0) continue; // skip non-alphabet chars (incl. whitespace)
      quads.push(v);
      real++;
    }
    // Write the quantum's bytes, truncated if the length limit cuts
    // mid-quantum (Node writes partial quanta, then stops).
    if (quads.length >= 2) {
      const v = (quads[0] << 18) | (quads[1] << 12) |
                ((quads[2] || 0) << 6) | (quads[3] || 0);
      buf[pos++] = (v >> 16) & 0xff;
      if (quads.length >= 3 && pos < end) buf[pos++] = (v >> 8) & 0xff;
      if (quads.length === 4 && pos < end) buf[pos++] = v & 0xff;
    }
    // 0 or 1 leftover chars: dropped.
  }
  return pos - offset;
}

function base64Write(buf, string, offset, length) {
  return b64Write(buf, string, offset, length, false);
}

function base64urlWrite(buf, string, offset, length) {
  return b64Write(buf, string, offset, length, true);
}

function base64ByteLength(str, bytes) {
  // Handle padding (mirrors Node's base64ByteLength).
  if (str.charCodeAt(bytes - 1) === 0x3d) bytes--;
  if (bytes > 1 && str.charCodeAt(bytes - 1) === 0x3d) bytes--;
  // Base64 ratio: 3/4
  return (bytes * 3) >>> 2;
}

// --- encoding ops table (mirrors lib/buffer.js encodingOps) ---

function indexOfBufferOp(buf, val, byteOffset, encVal, dir, end) {
  return bindingIndexOfBuffer(buf, val, byteOffset, encVal, dir, end);
}
function indexOfStringOp(buf, val, byteOffset, encVal, dir, end) {
  return bindingIndexOfString(buf, val, byteOffset, encVal, dir, end);
}

const encodingOps = {
  utf8: {
    encoding: 'utf8', encodingVal: encodingsMap.utf8,
    byteLength: byteLengthUtf8, write: utf8Write, slice: utf8Slice,
    indexOf: (buf, val, byteOffset, dir, end) =>
      indexOfStringOp(buf, val, byteOffset, encodingsMap.utf8, dir, end),
  },
  ucs2: {
    encoding: 'ucs2', encodingVal: encodingsMap.utf16le,
    byteLength: (string) => string.length * 2, write: ucs2Write, slice: ucs2Slice,
    indexOf: (buf, val, byteOffset, dir, end) =>
      indexOfStringOp(buf, val, byteOffset, encodingsMap.utf16le, dir, end),
  },
  utf16le: {
    encoding: 'utf16le', encodingVal: encodingsMap.utf16le,
    byteLength: (string) => string.length * 2, write: ucs2Write, slice: ucs2Slice,
    indexOf: (buf, val, byteOffset, dir, end) =>
      indexOfStringOp(buf, val, byteOffset, encodingsMap.utf16le, dir, end),
  },
  latin1: {
    encoding: 'latin1', encodingVal: encodingsMap.latin1,
    byteLength: (string) => string.length, write: latin1Write, slice: latin1Slice,
    indexOf: (buf, val, byteOffset, dir, end) =>
      indexOfStringOp(buf, val, byteOffset, encodingsMap.latin1, dir, end),
  },
  ascii: {
    encoding: 'ascii', encodingVal: encodingsMap.ascii,
    byteLength: (string) => string.length, write: asciiWrite, slice: asciiSlice,
    indexOf: (buf, val, byteOffset, dir, end) =>
      indexOfBufferOp(buf, fromStringFast(val, encodingOps.ascii),
                      byteOffset, encodingsMap.ascii, dir, end),
  },
  base64: {
    encoding: 'base64', encodingVal: encodingsMap.base64,
    byteLength: (string) => base64ByteLength(string, string.length),
    write: base64Write, slice: base64Slice,
    indexOf: (buf, val, byteOffset, dir, end) =>
      indexOfBufferOp(buf, fromStringFast(val, encodingOps.base64),
                      byteOffset, encodingsMap.base64, dir, end),
  },
  base64url: {
    encoding: 'base64url', encodingVal: encodingsMap.base64url,
    byteLength: (string) => base64ByteLength(string, string.length),
    write: base64urlWrite, slice: base64urlSlice,
    indexOf: (buf, val, byteOffset, dir, end) =>
      indexOfBufferOp(buf, fromStringFast(val, encodingOps.base64url),
                      byteOffset, encodingsMap.base64url, dir, end),
  },
  hex: {
    encoding: 'hex', encodingVal: encodingsMap.hex,
    byteLength: (string) => string.length >>> 1, write: hexWrite, slice: hexSlice,
    indexOf: (buf, val, byteOffset, dir, end) =>
      indexOfBufferOp(buf, fromStringFast(val, encodingOps.hex),
                      byteOffset, encodingsMap.hex, dir, end),
  },
};

function getEncodingOps(encoding) {
  encoding += '';
  switch (encoding.length) {
    case 4:
      if (encoding === 'utf8') return encodingOps.utf8;
      if (encoding === 'ucs2') return encodingOps.ucs2;
      encoding = encoding.toLowerCase();
      if (encoding === 'utf8') return encodingOps.utf8;
      if (encoding === 'ucs2') return encodingOps.ucs2;
      break;
    case 5:
      if (encoding === 'utf-8') return encodingOps.utf8;
      if (encoding === 'ascii') return encodingOps.ascii;
      if (encoding === 'ucs-2') return encodingOps.ucs2;
      encoding = encoding.toLowerCase();
      if (encoding === 'utf-8') return encodingOps.utf8;
      if (encoding === 'ascii') return encodingOps.ascii;
      if (encoding === 'ucs-2') return encodingOps.ucs2;
      break;
    case 7:
      if (encoding === 'utf16le' || encoding.toLowerCase() === 'utf16le')
        return encodingOps.utf16le;
      break;
    case 8:
      if (encoding === 'utf-16le' || encoding.toLowerCase() === 'utf-16le')
        return encodingOps.utf16le;
      break;
    case 6:
      if (encoding === 'latin1' || encoding === 'binary') return encodingOps.latin1;
      if (encoding === 'base64') return encodingOps.base64;
      encoding = encoding.toLowerCase();
      if (encoding === 'latin1' || encoding === 'binary') return encodingOps.latin1;
      if (encoding === 'base64') return encodingOps.base64;
      break;
    case 3:
      if (encoding === 'hex' || encoding.toLowerCase() === 'hex') return encodingOps.hex;
      break;
    case 9:
      if (encoding === 'base64url' || encoding.toLowerCase() === 'base64url')
        return encodingOps.base64url;
      break;
    default:
      break;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pure-JS replacements for the remaining C++ binding helpers
// ---------------------------------------------------------------------------

// binding: compare — memcmp semantics.
function bindingCompare(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

// binding: compareOffset(this, target, targetStart, sourceStart, targetEnd, sourceEnd)
function bindingCompareOffset(buf, target, targetStart, sourceStart, targetEnd, sourceEnd) {
  let a = sourceStart;
  let c = targetStart;
  while (a < sourceEnd && c < targetEnd) {
    if (buf[a] !== target[c]) return buf[a] < target[c] ? -1 : 1;
    a++; c++;
  }
  const aLen = sourceEnd - a;
  const cLen = targetEnd - c;
  if (aLen === 0 && cLen === 0) return 0;
  // One side exhausted: shorter-is-smaller only if the other still has bytes.
  if (aLen < cLen) return -1;
  if (aLen > cLen) return 1;
  return 0;
}

// Mirrors the C++ IndexOfOffset helper in node_buffer.cc.
function indexOfOffset(length, offset, needleLength, isForward) {
  if (offset < 0) {
    if (offset + length >= 0) {
      // Negative offsets count backwards from the end of the buffer.
      return length + offset;
    } else if (isForward || needleLength === 0) {
      // indexOf from before the start of the buffer: search the whole buffer.
      return 0;
    }
    // lastIndexOf from before the start of the buffer: no match.
    return -1;
  }
  if (offset + needleLength <= length) {
    // Valid positive offset.
    return offset;
  } else if (needleLength === 0) {
    // Out of buffer bounds, but empty needle: point to end of buffer.
    return length;
  } else if (isForward) {
    // indexOf from past the end of the buffer: no match.
    return -1;
  }
  // lastIndexOf from past the end of the buffer: search the whole buffer.
  return length - 1;
}

// Normalizes the `end` argument the way the C++ bindings do
// (ToInteger, then clamped to [0, length]).
function toSearchEnd(end, length) {
  let e = end === undefined ? length : Math.trunc(end);
  if (Number.isNaN(e)) e = 0;
  return Math.min(Math.max(e, 0), length);
}

function searchBytesForward(haystack, needle, searchEnd, needleLen, offset) {
  const stop = searchEnd - needleLen;
  for (let i = offset; i <= stop; i++) {
    let found = true;
    for (let j = 0; j < needleLen; j++) {
      if (haystack[i + j] !== needle[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

function searchBytesBackward(haystack, needle, searchEnd, needleLen, offset) {
  const stop = Math.min(offset, searchEnd - needleLen);
  for (let i = stop; i >= 0; i--) {
    let found = true;
    for (let j = 0; j < needleLen; j++) {
      if (haystack[i + j] !== needle[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

// UCS2 searches operate on 16-bit little-endian units.
function getU16LE(arr, unit) {
  return arr[unit * 2] | (arr[unit * 2 + 1] << 8);
}

function searchUnitsForward(haystack, needle, searchEndUnits, needleUnits, offsetUnits) {
  const stop = searchEndUnits - needleUnits;
  for (let i = offsetUnits; i <= stop; i++) {
    let found = true;
    for (let j = 0; j < needleUnits; j++) {
      if (getU16LE(haystack, i + j) !== getU16LE(needle, j)) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

function searchUnitsBackward(haystack, needle, searchEndUnits, needleUnits, offsetUnits) {
  const stop = Math.min(offsetUnits, searchEndUnits - needleUnits);
  for (let i = stop; i >= 0; i--) {
    let found = true;
    for (let j = 0; j < needleUnits; j++) {
      if (getU16LE(haystack, i + j) !== getU16LE(needle, j)) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

// binding: indexOfNumber(buffer, val, byteOffset, dir, end)
function bindingIndexOfNumber(buffer, val, byteOffset, dir, end) {
  // The native binding passes the value to memchr(), which truncates it to
  // a single byte (e.g. indexOf(0x6973) searches for 0x73).
  val &= 0xff;
  const len = buffer.length;
  const optOffset = indexOfOffset(len, byteOffset, 1, dir);
  if (optOffset <= -1 || len === 0) return -1;
  const offset = optOffset;
  // search_end is the exclusive upper bound of the search range.
  const searchEnd = toSearchEnd(end, len);
  if (dir) {
    if (offset >= searchEnd) return -1;
    for (let i = offset; i < searchEnd; i++) {
      if (buffer[i] === val) return i;
    }
    return -1;
  }
  const backwardEnd = Math.min(offset + 1, searchEnd);
  if (backwardEnd === 0) return -1;
  for (let i = backwardEnd - 1; i >= 0; i--) {
    if (buffer[i] === val) return i;
  }
  return -1;
}

// Encode a search string to bytes for the given encoding id.
function encodeSearchString(val, encVal) {
  switch (encVal) {
    case encodingsMap.utf8: {
      const n = byteLengthUtf8(val);
      const tmp = new Uint8Array(n);
      utf8WriteStatic(tmp, val, 0, n);
      return tmp;
    }
    case encodingsMap.utf16le: {
      const tmp = new Uint8Array(val.length * 2);
      ucs2Write(tmp, val, 0, tmp.length);
      return tmp;
    }
    case encodingsMap.latin1: {
      const tmp = new Uint8Array(val.length);
      latin1WriteStatic(tmp, val, 0, tmp.length);
      return tmp;
    }
    case encodingsMap.ascii: {
      const tmp = new Uint8Array(val.length);
      asciiWriteStatic(tmp, val, 0, tmp.length);
      return tmp;
    }
    case encodingsMap.base64: {
      const tmp = new Uint8Array(val.length);
      const n = base64Write(tmp, val, 0, tmp.length);
      return tmp.subarray(0, n);
    }
    case encodingsMap.base64url: {
      const tmp = new Uint8Array(val.length);
      const n = base64urlWrite(tmp, val, 0, tmp.length);
      return tmp.subarray(0, n);
    }
    case encodingsMap.hex: {
      const tmp = new Uint8Array(val.length >>> 1);
      const n = hexWrite(tmp, val, 0, tmp.length);
      return tmp.subarray(0, n);
    }
    default: return new Uint8Array(0);
  }
}

// binding: indexOfBuffer(buffer, val(uint8array), byteOffset, encVal, dir, end)
function bindingIndexOfBuffer(buffer, val, byteOffset, encVal, dir, end) {
  const len = buffer.length;
  const valLen = val.length;
  const isUcs2 = encVal === encodingsMap.utf16le;

  // search_end is the exclusive upper bound of the search range.
  let searchEnd = toSearchEnd(end, len);
  if (isUcs2) searchEnd &= ~1;

  const optOffset = indexOfOffset(len, byteOffset, valLen, dir);

  if (valLen === 0) {
    // Match String#indexOf() and String#lastIndexOf() behavior,
    // but clamp to search_end.
    return Math.min(optOffset, searchEnd);
  }

  if (len === 0) return -1;
  if (optOffset <= -1) return -1;

  let offset = optOffset;
  // For backward search, clamp start to within the search range.
  if (!dir && offset >= searchEnd) {
    if (searchEnd === 0) return -1;
    offset = searchEnd - 1;
  } else if (dir && offset >= searchEnd) {
    return -1;
  }
  if ((dir && valLen + offset > searchEnd) || valLen > searchEnd) {
    return -1;
  }

  if (isUcs2) {
    if (searchEnd < 2 || valLen < 2) return -1;
    const result = dir
      ? searchUnitsForward(buffer, val, searchEnd / 2, Math.floor(valLen / 2),
                            Math.floor(offset / 2))
      : searchUnitsBackward(buffer, val, searchEnd / 2, Math.floor(valLen / 2),
                             Math.floor(offset / 2));
    return result === -1 ? -1 : result * 2;
  }

  return dir
    ? searchBytesForward(buffer, val, searchEnd, valLen, offset)
    : searchBytesBackward(buffer, val, searchEnd, valLen, offset);
}

// binding: indexOfString(buffer, val(string), byteOffset, encVal, dir, end)
function bindingIndexOfString(buffer, val, byteOffset, encVal, dir, end) {
  const encoded = encodeSearchString(val, encVal);
  return bindingIndexOfBuffer(buffer, encoded, byteOffset, encVal, dir, end);
}

// binding: isUtf8 — strict UTF-8 validity check over the whole view.
function bindingIsUtf8(input) {
  const buf = input instanceof Uint8Array
    ? input
    : new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength);
  const len = buf.length;
  let i = 0;
  while (i < len) {
    const b0 = buf[i];
    if (b0 <= 0x7f) { i++; continue; }
    let needed, lower = 0x80, upper = 0xbf;
    if (b0 >= 0xc2 && b0 <= 0xdf) needed = 1;
    else if (b0 >= 0xe0 && b0 <= 0xef) {
      needed = 2;
      if (b0 === 0xe0) lower = 0xa0;
      else if (b0 === 0xed) upper = 0x9f;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      needed = 3;
      if (b0 === 0xf0) lower = 0x90;
      else if (b0 === 0xf4) upper = 0x8f;
    } else return false;
    if (i + needed >= len) return false;
    for (let j = 1; j <= needed; j++) {
      const b = buf[i + j];
      const lo = j === 1 ? lower : 0x80;
      const hi = j === 1 ? upper : 0xbf;
      if (b < lo || b > hi) return false;
    }
    i += needed + 1;
  }
  return true;
}

// binding: isAscii — every byte < 0x80.
function bindingIsAscii(input) {
  const buf = input instanceof Uint8Array
    ? input
    : new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength);
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] >= 0x80) return false;
  }
  return true;
}

// binding: fill — returns -1 when a string value encodes to zero bytes
// (invalid fill value), -2 on OOB (JS checks first, so unreachable here).
function bindingFill(buf, value, offset, end, encoding) {
  const fillLength = end - offset;
  if (fillLength <= 0) return 0;
  let pattern;
  let patternLen;
  if (isUint8Array(value)) {
    pattern = value;
    patternLen = value.length;
  } else if (typeof value === 'string') {
    const ops = encoding === undefined ? encodingOps.utf8 : getEncodingOps(encoding);
    const byteLen = ops.byteLength(value);
    const tmp = new Uint8Array(Math.max(byteLen, 1));
    patternLen = ops.write(tmp, value, 0, tmp.length);
    pattern = tmp;
  } else {
    // Coerce: ToUint32(value) & 0xff (matches C++ Uint32Value path).
    const num = Number(value);
    const byte = Number.isNaN(num) ? 0 : (num >>> 0) & 0xff;
    buf.fill(byte, offset, end);
    return 0;
  }
  if (patternLen === 0) return -1;
  // Copy the pattern once, then double it across the range (matches C++).
  const first = Math.min(patternLen, fillLength);
  for (let i = 0; i < first; i++) buf[offset + i] = pattern[i];
  let inThere = first;
  while (inThere < fillLength) {
    const chunk = Math.min(inThere, fillLength - inThere);
    for (let i = 0; i < chunk; i++) buf[offset + inThere + i] = buf[offset + i];
    inThere += chunk;
  }
  return 0;
}

// binding: swap16/32/64 — byte-swap in place.
function bindingSwap16(buf) {
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const t = buf[i]; buf[i] = buf[i + 1]; buf[i + 1] = t;
  }
}
function bindingSwap32(buf) {
  for (let i = 0; i + 3 < buf.length; i += 4) {
    let t = buf[i]; buf[i] = buf[i + 3]; buf[i + 3] = t;
    t = buf[i + 1]; buf[i + 1] = buf[i + 2]; buf[i + 2] = t;
  }
}
function bindingSwap64(buf) {
  for (let i = 0; i + 7 < buf.length; i += 8) {
    for (let j = 0; j < 4; j++) {
      const t = buf[i + j]; buf[i + j] = buf[i + 7 - j]; buf[i + 7 - j] = t;
    }
  }
}

// ---------------------------------------------------------------------------
// Port of lib/internal/buffer.js (pure-JS parts)
// ---------------------------------------------------------------------------

// Temporary buffers to convert numbers.
const float32Array = new Float32Array(1);
const uInt8Float32Array = new Uint8Array(float32Array.buffer);
const float64Array = new Float64Array(1);
const uInt8Float64Array = new Uint8Array(float64Array.buffer);

// Check endianness.
float32Array[0] = -1; // 0xBF800000
// Either it is [0, 0, 128, 191] or [191, 128, 0, 0].
const bigEndian = uInt8Float32Array[3] === 0;

function checkBounds(buf, offset, byteLength) {
  validateNumber(offset, 'offset');
  if (buf[offset] === undefined || buf[offset + byteLength] === undefined)
    boundsError(offset, buf.length - (byteLength + 1));
}

function checkInt(value, min, max, buf, offset, byteLength) {
  if (value > max || value < min) {
    const n = typeof min === 'bigint' ? 'n' : '';
    let range;
    if (byteLength > 3) {
      if (min === 0 || min === 0n) {
        range = `>= 0${n} and < 2${n} ** ${(byteLength + 1) * 8}${n}`;
      } else {
        range = `>= -(2${n} ** ${(byteLength + 1) * 8 - 1}${n}) and ` +
                `< 2${n} ** ${(byteLength + 1) * 8 - 1}${n}`;
      }
    } else {
      range = `>= ${min}${n} and <= ${max}${n}`;
    }
    throw ERR_OUT_OF_RANGE('value', range, value);
  }
  checkBounds(buf, offset, byteLength);
}

function boundsError(value, length, type) {
  if (Math.floor(value) !== value) {
    validateNumber(value, type);
    throw ERR_OUT_OF_RANGE(type || 'offset', 'an integer', value);
  }

  if (length < 0)
    throw ERR_BUFFER_OUT_OF_BOUNDS();

  throw ERR_OUT_OF_RANGE(type || 'offset',
                         `>= ${type ? 1 : 0} and <= ${length}`,
                         value);
}

// Read integers.
function readBigUInt64LE(offset = 0) {
  validateNumber(offset, 'offset');
  const first = this[offset];
  const last = this[offset + 7];
  if (first === undefined || last === undefined)
    boundsError(offset, this.length - 8);

  const lo = first +
    this[++offset] * 2 ** 8 +
    this[++offset] * 2 ** 16 +
    this[++offset] * 2 ** 24;
  const hi = this[++offset] +
    this[++offset] * 2 ** 8 +
    this[++offset] * 2 ** 16 +
    last * 2 ** 24;
  return BigInt(lo) + (BigInt(hi) << 32n);
}

function readBigUInt64BE(offset = 0) {
  validateNumber(offset, 'offset');
  const first = this[offset];
  const last = this[offset + 7];
  if (first === undefined || last === undefined)
    boundsError(offset, this.length - 8);

  const hi = first * 2 ** 24 +
    this[++offset] * 2 ** 16 +
    this[++offset] * 2 ** 8 +
    this[++offset];
  const lo = this[++offset] * 2 ** 24 +
    this[++offset] * 2 ** 16 +
    this[++offset] * 2 ** 8 +
    last;
  return (BigInt(hi) << 32n) + BigInt(lo);
}

function readBigInt64LE(offset = 0) {
  validateNumber(offset, 'offset');
  const first = this[offset];
  const last = this[offset + 7];
  if (first === undefined || last === undefined)
    boundsError(offset, this.length - 8);

  const val = this[offset + 4] +
    this[offset + 5] * 2 ** 8 +
    this[offset + 6] * 2 ** 16 +
    (last << 24); // Overflow
  return (BigInt(val) << 32n) +
    BigInt(first +
    this[++offset] * 2 ** 8 +
    this[++offset] * 2 ** 16 +
    this[++offset] * 2 ** 24);
}

function readBigInt64BE(offset = 0) {
  validateNumber(offset, 'offset');
  const first = this[offset];
  const last = this[offset + 7];
  if (first === undefined || last === undefined)
    boundsError(offset, this.length - 8);

  const val = (first << 24) + // Overflow
    this[++offset] * 2 ** 16 +
    this[++offset] * 2 ** 8 +
    this[++offset];
  return (BigInt(val) << 32n) +
    BigInt(this[++offset] * 2 ** 24 +
    this[++offset] * 2 ** 16 +
    this[++offset] * 2 ** 8 +
    last);
}

function readUIntLE(offset, byteLength) {
  if (offset === undefined)
    throw ERR_INVALID_ARG_TYPE('offset', 'number', offset);
  if (byteLength === 6)
    return readUInt48LE(this, offset);
  if (byteLength === 5)
    return readUInt40LE(this, offset);
  if (byteLength === 3)
    return readUInt24LE(this, offset);
  if (byteLength === 4)
    return readUInt32LE(this, offset);
  if (byteLength === 2)
    return readUInt16LE(this, offset);
  if (byteLength === 1)
    return readUInt8(this, offset);

  boundsError(byteLength, 6, 'byteLength');
}

function readUInt48LE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 5];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 6);

  return first +
    buf[++offset] * 2 ** 8 +
    buf[++offset] * 2 ** 16 +
    buf[++offset] * 2 ** 24 +
    buf[++offset] * 2 ** 32 +
    last * 2 ** 40;
}

function readUInt40LE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 4];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 5);

  return first +
    buf[++offset] * 2 ** 8 +
    buf[++offset] * 2 ** 16 +
    buf[++offset] * 2 ** 24 +
    last * 2 ** 32;
}

function readUInt32LE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 3];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 4);

  return first +
    buf[++offset] * 2 ** 8 +
    buf[++offset] * 2 ** 16 +
    last * 2 ** 24;
}

function readUInt24LE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 2];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 3);

  return first + buf[++offset] * 2 ** 8 + last * 2 ** 16;
}

function readUInt16LE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 1];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 2);

  return first + last * 2 ** 8;
}

function readUInt8(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const val = buf[offset];
  if (val === undefined)
    boundsError(offset, buf.length - 1);

  return val;
}

function readUIntBE(offset, byteLength) {
  if (offset === undefined)
    throw ERR_INVALID_ARG_TYPE('offset', 'number', offset);
  if (byteLength === 6)
    return readUInt48BE(this, offset);
  if (byteLength === 5)
    return readUInt40BE(this, offset);
  if (byteLength === 3)
    return readUInt24BE(this, offset);
  if (byteLength === 4)
    return readUInt32BE(this, offset);
  if (byteLength === 2)
    return readUInt16BE(this, offset);
  if (byteLength === 1)
    return readUInt8(this, offset);

  boundsError(byteLength, 6, 'byteLength');
}

function readUInt48BE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 5];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 6);

  return first * 2 ** 40 +
    buf[++offset] * 2 ** 32 +
    buf[++offset] * 2 ** 24 +
    buf[++offset] * 2 ** 16 +
    buf[++offset] * 2 ** 8 +
    last;
}

function readUInt40BE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 4];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 5);

  return first * 2 ** 32 +
    buf[++offset] * 2 ** 24 +
    buf[++offset] * 2 ** 16 +
    buf[++offset] * 2 ** 8 +
    last;
}

function readUInt32BE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 3];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 4);

  return first * 2 ** 24 +
    buf[++offset] * 2 ** 16 +
    buf[++offset] * 2 ** 8 +
    last;
}

function readUInt24BE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 2];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 3);

  return first * 2 ** 16 + buf[++offset] * 2 ** 8 + last;
}

function readUInt16BE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 1];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 2);

  return first * 2 ** 8 + last;
}

function readIntLE(offset, byteLength) {
  if (offset === undefined)
    throw ERR_INVALID_ARG_TYPE('offset', 'number', offset);
  if (byteLength === 6)
    return readInt48LE(this, offset);
  if (byteLength === 5)
    return readInt40LE(this, offset);
  if (byteLength === 3)
    return readInt24LE(this, offset);
  if (byteLength === 4)
    return readInt32LE(this, offset);
  if (byteLength === 2)
    return readInt16LE(this, offset);
  if (byteLength === 1)
    return readInt8(this, offset);

  boundsError(byteLength, 6, 'byteLength');
}

function readInt48LE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 5];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 6);

  const val = first +
    buf[++offset] * 2 ** 8 +
    buf[++offset] * 2 ** 16 +
    buf[++offset] * 2 ** 24 +
    buf[++offset] * 2 ** 32 +
    last * 2 ** 40;
  return val > 2 ** 47 ? val - 2 ** 48 : val;
}

function readInt40LE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 4];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 5);

  const val = first +
    buf[++offset] * 2 ** 8 +
    buf[++offset] * 2 ** 16 +
    buf[++offset] * 2 ** 24 +
    last * 2 ** 32;
  return val > 2 ** 39 ? val - 2 ** 40 : val;
}

function readInt32LE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 3];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 4);

  return first +
    buf[++offset] * 2 ** 8 +
    buf[++offset] * 2 ** 16 +
    (last << 24);
}

function readInt24LE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 2];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 3);

  const val = first + buf[++offset] * 2 ** 8 + last * 2 ** 16;
  return val > 2 ** 23 ? val - 2 ** 24 : val;
}

function readInt16LE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 1];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 2);

  const val = first + last * 2 ** 8;
  return val | (val & 2 ** 15) * 0x1fffe;
}

function readInt8(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const val = buf[offset];
  if (val === undefined)
    boundsError(offset, buf.length - 1);

  return val | (val & 2 ** 7) * 0x1fffffe;
}

function readIntBE(offset, byteLength) {
  if (offset === undefined)
    throw ERR_INVALID_ARG_TYPE('offset', 'number', offset);
  if (byteLength === 6)
    return readInt48BE(this, offset);
  if (byteLength === 5)
    return readInt40BE(this, offset);
  if (byteLength === 3)
    return readInt24BE(this, offset);
  if (byteLength === 4)
    return readInt32BE(this, offset);
  if (byteLength === 2)
    return readInt16BE(this, offset);
  if (byteLength === 1)
    return readInt8(this, offset);

  boundsError(byteLength, 6, 'byteLength');
}

function readInt48BE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 5];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 6);

  const val = first * 2 ** 40 +
    buf[++offset] * 2 ** 32 +
    buf[++offset] * 2 ** 24 +
    buf[++offset] * 2 ** 16 +
    buf[++offset] * 2 ** 8 +
    last;
  return val > 2 ** 47 ? val - 2 ** 48 : val;
}

function readInt40BE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 4];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 5);

  const val = first * 2 ** 32 +
    buf[++offset] * 2 ** 24 +
    buf[++offset] * 2 ** 16 +
    buf[++offset] * 2 ** 8 +
    last;
  return val > 2 ** 39 ? val - 2 ** 40 : val;
}

function readInt32BE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 3];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 4);

  return (first << 24) +
    buf[++offset] * 2 ** 16 +
    buf[++offset] * 2 ** 8 +
    last;
}

function readInt24BE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 2];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 3);

  const val = first * 2 ** 16 + buf[++offset] * 2 ** 8 + last;
  return val > 2 ** 23 ? val - 2 ** 24 : val;
}

function readInt16BE(buf, offset = 0) {
  validateNumber(offset, 'offset');
  const first = buf[offset];
  const last = buf[offset + 1];
  if (first === undefined || last === undefined)
    boundsError(offset, buf.length - 2);

  const val = first * 2 ** 8 + last;
  return val | (val & 2 ** 15) * 0x1fffe;
}

// Read floats.
function readFloatForwards(offset = 0) {
  validateNumber(offset, 'offset');
  const first = this[offset];
  const last = this[offset + 3];
  if (first === undefined || last === undefined)
    boundsError(offset, this.length - 4);

  uInt8Float32Array[0] = first;
  uInt8Float32Array[1] = this[++offset];
  uInt8Float32Array[2] = this[++offset];
  uInt8Float32Array[3] = last;
  return float32Array[0];
}

function readFloatBackwards(offset = 0) {
  validateNumber(offset, 'offset');
  const first = this[offset];
  const last = this[offset + 3];
  if (first === undefined || last === undefined)
    boundsError(offset, this.length - 4);

  uInt8Float32Array[3] = first;
  uInt8Float32Array[2] = this[++offset];
  uInt8Float32Array[1] = this[++offset];
  uInt8Float32Array[0] = last;
  return float32Array[0];
}

function readDoubleForwards(offset = 0) {
  validateNumber(offset, 'offset');
  const first = this[offset];
  const last = this[offset + 7];
  if (first === undefined || last === undefined)
    boundsError(offset, this.length - 8);

  uInt8Float64Array[0] = first;
  uInt8Float64Array[1] = this[++offset];
  uInt8Float64Array[2] = this[++offset];
  uInt8Float64Array[3] = this[++offset];
  uInt8Float64Array[4] = this[++offset];
  uInt8Float64Array[5] = this[++offset];
  uInt8Float64Array[6] = this[++offset];
  uInt8Float64Array[7] = last;
  return float64Array[0];
}

function readDoubleBackwards(offset = 0) {
  validateNumber(offset, 'offset');
  const first = this[offset];
  const last = this[offset + 7];
  if (first === undefined || last === undefined)
    boundsError(offset, this.length - 8);

  uInt8Float64Array[7] = first;
  uInt8Float64Array[6] = this[++offset];
  uInt8Float64Array[5] = this[++offset];
  uInt8Float64Array[4] = this[++offset];
  uInt8Float64Array[3] = this[++offset];
  uInt8Float64Array[2] = this[++offset];
  uInt8Float64Array[1] = this[++offset];
  uInt8Float64Array[0] = last;
  return float64Array[0];
}

// Write integers.
function writeBigU_Int64LE(buf, value, offset, min, max) {
  checkInt(value, min, max, buf, offset, 7);

  let lo = Number(value & 0xffffffffn);
  buf[offset++] = lo;
  lo = lo >> 8;
  buf[offset++] = lo;
  lo = lo >> 8;
  buf[offset++] = lo;
  lo = lo >> 8;
  buf[offset++] = lo;
  let hi = Number(value >> 32n & 0xffffffffn);
  buf[offset++] = hi;
  hi = hi >> 8;
  buf[offset++] = hi;
  hi = hi >> 8;
  buf[offset++] = hi;
  hi = hi >> 8;
  buf[offset++] = hi;
  return offset;
}

function writeBigUInt64LE(value, offset = 0) {
  return writeBigU_Int64LE(this, value, offset, 0n, 0xffffffffffffffffn);
}

function writeBigU_Int64BE(buf, value, offset, min, max) {
  checkInt(value, min, max, buf, offset, 7);

  let lo = Number(value & 0xffffffffn);
  buf[offset + 7] = lo;
  lo = lo >> 8;
  buf[offset + 6] = lo;
  lo = lo >> 8;
  buf[offset + 5] = lo;
  lo = lo >> 8;
  buf[offset + 4] = lo;
  let hi = Number(value >> 32n & 0xffffffffn);
  buf[offset + 3] = hi;
  hi = hi >> 8;
  buf[offset + 2] = hi;
  hi = hi >> 8;
  buf[offset + 1] = hi;
  hi = hi >> 8;
  buf[offset] = hi;
  return offset + 8;
}

function writeBigUInt64BE(value, offset = 0) {
  return writeBigU_Int64BE(this, value, offset, 0n, 0xffffffffffffffffn);
}

function writeBigInt64LE(value, offset = 0) {
  return writeBigU_Int64LE(
    this, value, offset, -0x8000000000000000n, 0x7fffffffffffffffn);
}

function writeBigInt64BE(value, offset = 0) {
  return writeBigU_Int64BE(
    this, value, offset, -0x8000000000000000n, 0x7fffffffffffffffn);
}

function writeUIntLE(value, offset, byteLength) {
  if (byteLength === 6)
    return writeU_Int48LE(this, value, offset, 0, 0xffffffffffff);
  if (byteLength === 5)
    return writeU_Int40LE(this, value, offset, 0, 0xffffffffff);
  if (byteLength === 3)
    return writeU_Int24LE(this, value, offset, 0, 0xffffff);
  if (byteLength === 4)
    return writeU_Int32LE(this, value, offset, 0, 0xffffffff);
  if (byteLength === 2)
    return writeU_Int16LE(this, value, offset, 0, 0xffff);
  if (byteLength === 1)
    return writeU_Int8(this, value, offset, 0, 0xff);

  boundsError(byteLength, 6, 'byteLength');
}

function writeU_Int48LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 5);

  const newVal = Math.floor(value * 2 ** -32);
  buf[offset++] = value;
  value = value >>> 8;
  buf[offset++] = value;
  value = value >>> 8;
  buf[offset++] = value;
  value = value >>> 8;
  buf[offset++] = value;
  buf[offset++] = newVal;
  buf[offset++] = (newVal >>> 8);
  return offset;
}

function writeU_Int40LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 4);

  const newVal = value;
  buf[offset++] = value;
  value = value >>> 8;
  buf[offset++] = value;
  value = value >>> 8;
  buf[offset++] = value;
  value = value >>> 8;
  buf[offset++] = value;
  buf[offset++] = Math.floor(newVal * 2 ** -32);
  return offset;
}

function writeU_Int32LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 3);

  buf[offset++] = value;
  value = value >>> 8;
  buf[offset++] = value;
  value = value >>> 8;
  buf[offset++] = value;
  value = value >>> 8;
  buf[offset++] = value;
  return offset;
}

function writeUInt32LE(value, offset = 0) {
  return writeU_Int32LE(this, value, offset, 0, 0xffffffff);
}

function writeU_Int24LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 2);

  buf[offset++] = value;
  value = value >>> 8;
  buf[offset++] = value;
  value = value >>> 8;
  buf[offset++] = value;
  return offset;
}

function writeU_Int16LE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 1);

  buf[offset++] = value;
  buf[offset++] = (value >>> 8);
  return offset;
}

function writeUInt16LE(value, offset = 0) {
  return writeU_Int16LE(this, value, offset, 0, 0xffff);
}

function writeU_Int8(buf, value, offset, min, max) {
  value = +value;
  // `checkInt()` can not be used here because it checks two entries.
  validateNumber(offset, 'offset');
  if (value > max || value < min) {
    throw ERR_OUT_OF_RANGE('value', `>= ${min} and <= ${max}`, value);
  }
  if (buf[offset] === undefined)
    boundsError(offset, buf.length - 1);

  buf[offset] = value;
  return offset + 1;
}

function writeUInt8(value, offset = 0) {
  return writeU_Int8(this, value, offset, 0, 0xff);
}

function writeUIntBE(value, offset, byteLength) {
  if (byteLength === 6)
    return writeU_Int48BE(this, value, offset, 0, 0xffffffffffff);
  if (byteLength === 5)
    return writeU_Int40BE(this, value, offset, 0, 0xffffffffff);
  if (byteLength === 3)
    return writeU_Int24BE(this, value, offset, 0, 0xffffff);
  if (byteLength === 4)
    return writeU_Int32BE(this, value, offset, 0, 0xffffffff);
  if (byteLength === 2)
    return writeU_Int16BE(this, value, offset, 0, 0xffff);
  if (byteLength === 1)
    return writeU_Int8(this, value, offset, 0, 0xff);

  boundsError(byteLength, 6, 'byteLength');
}

function writeU_Int48BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 5);

  const newVal = Math.floor(value * 2 ** -32);
  buf[offset++] = (newVal >>> 8);
  buf[offset++] = newVal;
  buf[offset + 3] = value;
  value = value >>> 8;
  buf[offset + 2] = value;
  value = value >>> 8;
  buf[offset + 1] = value;
  value = value >>> 8;
  buf[offset] = value;
  return offset + 4;
}

function writeU_Int40BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 4);

  buf[offset++] = Math.floor(value * 2 ** -32);
  buf[offset + 3] = value;
  value = value >>> 8;
  buf[offset + 2] = value;
  value = value >>> 8;
  buf[offset + 1] = value;
  value = value >>> 8;
  buf[offset] = value;
  return offset + 5;
}

function writeU_Int32BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 3);

  buf[offset + 3] = value;
  value = value >>> 8;
  buf[offset + 2] = value;
  value = value >>> 8;
  buf[offset + 1] = value;
  value = value >>> 8;
  buf[offset] = value;
  return offset + 4;
}

function writeUInt32BE(value, offset = 0) {
  return writeU_Int32BE(this, value, offset, 0, 0xffffffff);
}

function writeU_Int24BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 2);

  buf[offset + 2] = value;
  value = value >>> 8;
  buf[offset + 1] = value;
  value = value >>> 8;
  buf[offset] = value;
  return offset + 3;
}

function writeU_Int16BE(buf, value, offset, min, max) {
  value = +value;
  checkInt(value, min, max, buf, offset, 1);

  buf[offset + 1] = value;
  value = value >>> 8;
  buf[offset] = value;
  return offset + 2;
}

function writeUInt16BE(value, offset = 0) {
  return writeU_Int16BE(this, value, offset, 0, 0xffff);
}

function writeIntLE(value, offset, byteLength) {
  if (byteLength === 6)
    return writeU_Int48LE(this, value, offset, -0x800000000000, 0x7fffffffffff);
  if (byteLength === 5)
    return writeU_Int40LE(this, value, offset, -0x8000000000, 0x7fffffffff);
  if (byteLength === 3)
    return writeU_Int24LE(this, value, offset, -0x800000, 0x7fffff);
  if (byteLength === 4)
    return writeU_Int32LE(this, value, offset, -0x80000000, 0x7fffffff);
  if (byteLength === 2)
    return writeU_Int16LE(this, value, offset, -0x8000, 0x7fff);
  if (byteLength === 1)
    return writeU_Int8(this, value, offset, -0x80, 0x7f);

  boundsError(byteLength, 6, 'byteLength');
}

function writeInt8(value, offset = 0) {
  return writeU_Int8(this, value, offset, -0x80, 0x7f);
}

function writeInt16LE(value, offset = 0) {
  return writeU_Int16LE(this, value, offset, -0x8000, 0x7fff);
}

function writeInt32LE(value, offset = 0) {
  return writeU_Int32LE(this, value, offset, -0x80000000, 0x7fffffff);
}

function writeIntBE(value, offset, byteLength) {
  if (byteLength === 6)
    return writeU_Int48BE(this, value, offset, -0x800000000000, 0x7fffffffffff);
  if (byteLength === 5)
    return writeU_Int40BE(this, value, offset, -0x8000000000, 0x7fffffffff);
  if (byteLength === 3)
    return writeU_Int24BE(this, value, offset, -0x800000, 0x7fffff);
  if (byteLength === 4)
    return writeU_Int32BE(this, value, offset, -0x80000000, 0x7fffffff);
  if (byteLength === 2)
    return writeU_Int16BE(this, value, offset, -0x8000, 0x7fff);
  if (byteLength === 1)
    return writeU_Int8(this, value, offset, -0x80, 0x7f);

  boundsError(byteLength, 6, 'byteLength');
}

function writeInt8Alias(value, offset = 0) {
  return writeU_Int8(this, value, offset, -0x80, 0x7f);
}

function writeInt16BE(value, offset = 0) {
  return writeU_Int16BE(this, value, offset, -0x8000, 0x7fff);
}

function writeInt32BE(value, offset = 0) {
  return writeU_Int32BE(this, value, offset, -0x80000000, 0x7fffffff);
}

// Write floats.
function writeDoubleForwards(val, offset = 0) {
  val = +val;
  checkBounds(this, offset, 7);

  float64Array[0] = val;
  this[offset++] = uInt8Float64Array[0];
  this[offset++] = uInt8Float64Array[1];
  this[offset++] = uInt8Float64Array[2];
  this[offset++] = uInt8Float64Array[3];
  this[offset++] = uInt8Float64Array[4];
  this[offset++] = uInt8Float64Array[5];
  this[offset++] = uInt8Float64Array[6];
  this[offset++] = uInt8Float64Array[7];
  return offset;
}

function writeDoubleBackwards(val, offset = 0) {
  val = +val;
  checkBounds(this, offset, 7);

  float64Array[0] = val;
  this[offset++] = uInt8Float64Array[7];
  this[offset++] = uInt8Float64Array[6];
  this[offset++] = uInt8Float64Array[5];
  this[offset++] = uInt8Float64Array[4];
  this[offset++] = uInt8Float64Array[3];
  this[offset++] = uInt8Float64Array[2];
  this[offset++] = uInt8Float64Array[1];
  this[offset++] = uInt8Float64Array[0];
  return offset;
}

function writeFloatForwards(val, offset = 0) {
  val = +val;
  checkBounds(this, offset, 3);

  float32Array[0] = val;
  this[offset++] = uInt8Float32Array[0];
  this[offset++] = uInt8Float32Array[1];
  this[offset++] = uInt8Float32Array[2];
  this[offset++] = uInt8Float32Array[3];
  return offset;
}

function writeFloatBackwards(val, offset = 0) {
  val = +val;
  checkBounds(this, offset, 3);

  float32Array[0] = val;
  this[offset++] = uInt8Float32Array[3];
  this[offset++] = uInt8Float32Array[2];
  this[offset++] = uInt8Float32Array[1];
  this[offset++] = uInt8Float32Array[0];
  return offset;
}

class FastBuffer extends Uint8Array {}

function asciiWrite(buf, string, offset = 0, length = buf.byteLength - offset) {
  if (offset < 0 || offset > buf.byteLength) {
    throw ERR_BUFFER_OUT_OF_BOUNDS('offset');
  }
  if (length < 0 || length > buf.byteLength - offset) {
    throw ERR_BUFFER_OUT_OF_BOUNDS('length');
  }
  return asciiWriteStatic(buf, string, offset, length);
}

function latin1Write(buf, string, offset = 0, length = buf.byteLength - offset) {
  if (offset < 0 || offset > buf.byteLength) {
    throw ERR_BUFFER_OUT_OF_BOUNDS('offset');
  }
  if (length < 0 || length > buf.byteLength - offset) {
    throw ERR_BUFFER_OUT_OF_BOUNDS('length');
  }
  return latin1WriteStatic(buf, string, offset, length);
}

function utf8Write(buf, string, offset = 0, length = buf.byteLength - offset) {
  if (offset < 0 || offset > buf.byteLength) {
    throw ERR_BUFFER_OUT_OF_BOUNDS('offset');
  }
  if (length < 0 || length > buf.byteLength - offset) {
    throw ERR_BUFFER_OUT_OF_BOUNDS('length');
  }
  return utf8WriteStatic(buf, string, offset, length);
}

// Validating adapter mirroring the C++ StringWrite binding used for the
// hex/base64/base64url/ucs2 prototype write methods.
function stringWriteChecked(buf, string, offset, length, writeFn) {
  if (typeof string !== 'string') throw ERR_STRING_EXPECTED();
  offset = parseArrayIndex(offset, 0);
  if (offset > buf.byteLength) {
    throw ERR_BUFFER_OUT_OF_BOUNDS('offset');
  }
  let maxLength = parseArrayIndex(length, buf.byteLength - offset);
  maxLength = Math.min(buf.byteLength - offset, maxLength);
  if (maxLength === 0) return 0;
  return writeFn(buf, string, offset, maxLength);
}

function addBufferPrototypeMethods(proto) {
  proto.readBigUInt64LE = readBigUInt64LE;
  proto.readBigUInt64BE = readBigUInt64BE;
  proto.readBigUint64LE = readBigUInt64LE;
  proto.readBigUint64BE = readBigUInt64BE;
  proto.readBigInt64LE = readBigInt64LE;
  proto.readBigInt64BE = readBigInt64BE;
  proto.writeBigUInt64LE = writeBigUInt64LE;
  proto.writeBigUInt64BE = writeBigUInt64BE;
  proto.writeBigUint64LE = writeBigUInt64LE;
  proto.writeBigUint64BE = writeBigUInt64BE;
  proto.writeBigInt64LE = writeBigInt64LE;
  proto.writeBigInt64BE = writeBigInt64BE;

  proto.readUIntLE = readUIntLE;
  proto.readUInt32LE = function (offset) { return readUInt32LE(this, offset); };
  proto.readUInt16LE = function (offset) { return readUInt16LE(this, offset); };
  proto.readUInt8 = function (offset) { return readUInt8(this, offset); };
  proto.readUIntBE = readUIntBE;
  proto.readUInt32BE = function (offset) { return readUInt32BE(this, offset); };
  proto.readUInt16BE = function (offset) { return readUInt16BE(this, offset); };
  proto.readUintLE = readUIntLE;
  proto.readUint32LE = proto.readUInt32LE;
  proto.readUint16LE = proto.readUInt16LE;
  proto.readUint8 = proto.readUInt8;
  proto.readUintBE = readUIntBE;
  proto.readUint32BE = proto.readUInt32BE;
  proto.readUint16BE = proto.readUInt16BE;
  proto.readIntLE = readIntLE;
  proto.readInt32LE = function (offset) { return readInt32LE(this, offset); };
  proto.readInt16LE = function (offset) { return readInt16LE(this, offset); };
  proto.readInt8 = function (offset) { return readInt8(this, offset); };
  proto.readIntBE = readIntBE;
  proto.readInt32BE = function (offset) { return readInt32BE(this, offset); };
  proto.readInt16BE = function (offset) { return readInt16BE(this, offset); };

  proto.writeUIntLE = writeUIntLE;
  proto.writeUInt32LE = writeUInt32LE;
  proto.writeUInt16LE = writeUInt16LE;
  proto.writeUInt8 = writeUInt8;
  proto.writeUIntBE = writeUIntBE;
  proto.writeUInt32BE = writeUInt32BE;
  proto.writeUInt16BE = writeUInt16BE;
  proto.writeUintLE = writeUIntLE;
  proto.writeUint32LE = writeUInt32LE;
  proto.writeUint16LE = writeUInt16LE;
  proto.writeUint8 = writeUInt8;
  proto.writeUintBE = writeUIntBE;
  proto.writeUint32BE = writeUInt32BE;
  proto.writeUint16BE = writeUInt16BE;
  proto.writeIntLE = writeIntLE;
  proto.writeInt32LE = writeInt32LE;
  proto.writeInt16LE = writeInt16LE;
  proto.writeInt8 = writeInt8;
  proto.writeIntBE = writeIntBE;
  proto.writeInt32BE = writeInt32BE;
  proto.writeInt16BE = writeInt16BE;

  proto.readFloatLE = bigEndian ? readFloatBackwards : readFloatForwards;
  proto.readFloatBE = bigEndian ? readFloatForwards : readFloatBackwards;
  proto.readDoubleLE = bigEndian ? readDoubleBackwards : readDoubleForwards;
  proto.readDoubleBE = bigEndian ? readDoubleForwards : readDoubleBackwards;
  proto.writeFloatLE = bigEndian ? writeFloatBackwards : writeFloatForwards;
  proto.writeFloatBE = bigEndian ? writeFloatForwards : writeFloatBackwards;
  proto.writeDoubleLE = bigEndian ? writeDoubleBackwards : writeDoubleForwards;
  proto.writeDoubleBE = bigEndian ? writeDoubleForwards : writeDoubleBackwards;

  // Internal binding-style helpers exposed on the prototype (mirrors Node,
  // where addBufferPrototypeMethods also installs these).
  proto.asciiSlice = function (start, end) { return asciiSlice(this, start, end); };
  proto.base64Slice = function (start, end) { return base64Slice(this, start, end); };
  proto.base64urlSlice = function (start, end) { return base64urlSlice(this, start, end); };
  proto.latin1Slice = function (start, end) { return latin1Slice(this, start, end); };
  proto.hexSlice = function (start, end) { return hexSlice(this, start, end); };
  proto.ucs2Slice = function (start, end) { return ucs2Slice(this, start, end); };
  proto.utf8Slice = function (start, end) { return utf8Slice(this, start, end); };
  proto.asciiWrite = function (string, offset, length) { return asciiWrite(this, string, offset, length); };
  proto.base64Write = function (string, offset, length) {
    return stringWriteChecked(this, string, offset, length, base64Write);
  };
  proto.base64urlWrite = function (string, offset, length) {
    return stringWriteChecked(this, string, offset, length, base64urlWrite);
  };
  proto.latin1Write = function (string, offset, length) { return latin1Write(this, string, offset, length); };
  proto.hexWrite = function (string, offset, length) {
    return stringWriteChecked(this, string, offset, length, hexWrite);
  };
  proto.ucs2Write = function (string, offset, length) {
    return stringWriteChecked(this, string, offset, length, ucs2Write);
  };
  proto.utf8Write = function (string, offset, length) { return utf8Write(this, string, offset, length); };
}

// No detach-key concept in pure JS; matches Node's pool marking as a no-op.
function markAsUntransferable() {}

function createUnsafeBuffer(size) {
  return new FastBuffer(size);
}

// ---------------------------------------------------------------------------
// Port of lib/buffer.js (pure-JS; C++ internalBinding('buffer') replaced by
// the dependency-free implementations above)
// ---------------------------------------------------------------------------

const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');
const kIsEncodingSymbol = Symbol('kIsEncodingSymbol');

// Property filter values mirroring internalBinding('util').constants.
const ALL_PROPERTIES = 0;
const ONLY_ENUMERABLE = 1;

function getOwnNonIndexProperties(obj, filter) {
  const stringKeys = filter === ALL_PROPERTIES
    ? Object.getOwnPropertyNames(obj)
    : Object.keys(obj);
  const symbolKeys = filter === ALL_PROPERTIES
    ? Object.getOwnPropertySymbols(obj)
    : Object.getOwnPropertySymbols(obj).filter((s) =>
        Object.getOwnPropertyDescriptor(obj, s).enumerable);
  const keys = [...stringKeys, ...symbolKeys];
  return keys.filter((k) => typeof k !== 'string' || !isArrayIndexKey(k));
}

function isArrayIndexKey(k) {
  if (k === '' || k.length > 10) return false;
  const n = Number(k);
  return Number.isInteger(n) && n >= 0 && n < 4294967295 && String(n) === k;
}

const constants = Object.defineProperties({}, {
  MAX_LENGTH: {
    __proto__: null,
    value: kMaxLength,
    writable: false,
    enumerable: true,
  },
  MAX_STRING_LENGTH: {
    __proto__: null,
    value: kStringMaxLength,
    writable: false,
    enumerable: true,
  },
});

let INSPECT_MAX_BYTES = 50;

function Buffer(arg, encodingOrOffset, length) {
  showFlaggedDeprecation();
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new ERR_INVALID_ARG_TYPE('string', 'string', arg);
    }
    return Buffer.alloc(arg);
  }
  return Buffer.from(arg, encodingOrOffset, length);
}

FastBuffer.prototype.constructor = Buffer;
Buffer.prototype = FastBuffer.prototype;
addBufferPrototypeMethods(Buffer.prototype);

// Cross-copy Buffer identification: Symbol.for is shared across all realms
// and all copies of this module (sandbox template vs dist VFS builds).
// instanceof fails when two different Buffer classes exist (e.g. globalThis.Buffer
// from RUNTIME_NODE_GLOBALS vs require('node:buffer').Buffer), so isBuffer
// checks this marker as a fallback.
const kIsBufferMarker = Symbol.for('bvm.buffer.isBuffer');
Object.defineProperty(Buffer.prototype, kIsBufferMarker, {
  value: true,
  writable: false,
  enumerable: false,
  configurable: false,
});

Buffer.poolSize = 64 * 1024;
let poolSize, poolOffset, allocPool, allocBuffer;

function createPool() {
  poolSize = Buffer.poolSize;
  allocBuffer = createUnsafeBuffer(poolSize);
  allocPool = allocBuffer.buffer;
  markAsUntransferable(allocPool);
  poolOffset = 0;
}
createPool();

function alignPool() {
  // Ensure aligned slices
  if (poolOffset & 0x7) {
    poolOffset |= 0x7;
    poolOffset++;
  }
}

let bufferWarningAlreadyEmitted = false;
let nodeModulesCheckCounter = 0;
const bufferWarning = 'Buffer() is deprecated due to security and usability ' +
                      'issues. Please use the Buffer.alloc(), ' +
                      'Buffer.allocUnsafe(), or Buffer.from() methods instead.';

// URL of this module, used to recognize internal frames in deprecation
// stack traces (so the node_modules check inspects the actual caller,
// even through the Buffer facade or vm contexts with custom filenames).
const thisModuleURL = (() => {
  try {
    return import.meta.url || '';
  } catch {
    return '';
  }
})();

function captureStackFrames() {
  // Temporarily disable a user-installed prepareStackTrace so capturing the
  // stack here cannot recurse back into Buffer() (see
  // test-buffer-constructor-deprecation-error.js).
  const origPrepare = Error.prepareStackTrace;
  const origLimit = Error.stackTraceLimit;
  Error.prepareStackTrace = undefined;
  try {
    Error.stackTraceLimit = 32;
    const stack = new Error().stack || '';
    return stack.split('\n').slice(1);
  } finally {
    Error.prepareStackTrace = origPrepare;
    Error.stackTraceLimit = origLimit;
  }
}

// Pure-JS equivalent of the C++ isInsideNodeModules() helper: finds the
// topmost stack frame outside this module (skipping internal frames) and
// reports whether its location is inside a node_modules directory.
function isInsideNodeModules() {
  const frames = captureStackFrames();
  for (const frame of frames) {
    const m = /\(([^)]+)\)/.exec(frame) || /at\s+(\S+)/.exec(frame);
    const loc = m ? m[1] : '';
    // Skip internal frames: this module and node: builtins.
    if (thisModuleURL !== '' && loc.startsWith(thisModuleURL)) continue;
    if (loc.startsWith('node:')) continue;
    return loc.includes('node_modules');
  }
  return false;
}

function hasPendingDeprecationFlag() {
  try {
    if (typeof process !== 'undefined' && process !== null) {
      if (process.env && process.env.NODE_PENDING_DEPRECATION === '1')
        return true;
      if (Array.isArray(process.execArgv) &&
          process.execArgv.includes('--pending-deprecation'))
        return true;
    }
  } catch {}
  return false;
}

function showFlaggedDeprecation() {
  if (bufferWarningAlreadyEmitted ||
      ++nodeModulesCheckCounter > 10000 ||
      (!hasPendingDeprecationFlag() && isInsideNodeModules())) {
    // We don't emit a warning, because we either:
    // - Already did so, or
    // - Already checked too many times whether a call is coming
    //   from node_modules and want to stop slowing down things, or
    // - We aren't running with `--pending-deprecation` enabled,
    //   and the code is inside `node_modules`.
    // - If the topmost non-internal frame is not inside `node_modules`.
    return;
  }

  if (typeof process !== 'undefined' && process !== null &&
      typeof process.emitWarning === 'function') {
    process.emitWarning(bufferWarning, 'DeprecationWarning', 'DEP0005');
  }
  bufferWarningAlreadyEmitted = true;
}

function toInteger(n, defaultVal) {
  n = +n;
  if (!Number.isNaN(n) &&
      n >= Number.MIN_SAFE_INTEGER &&
      n <= Number.MAX_SAFE_INTEGER) {
    return ((n % 1) === 0 ? n : Math.floor(n));
  }
  return defaultVal;
}

// Pure-JS replacement for the C++ Buffer::Copy binding (memmove semantics).
function bindingCopy(source, target, targetStart, sourceStart, nb) {
  // Byte-level copy: offsets are byte offsets into each view's buffer, so
  // copying into a Uint16Array (or any other view type) packs bytes rather
  // than assigning elements. TypedArray.prototype.set clones the source
  // when both views share an ArrayBuffer (per ECMA-262), so overlapping
  // copies are safe.
  const srcBytes = new Uint8Array(
    source.buffer, source.byteOffset + sourceStart, nb);
  new Uint8Array(
    target.buffer, target.byteOffset + targetStart, nb).set(srcBytes);
}

function copyImpl(source, target, targetStart, sourceStart, sourceEnd) {
  if (!ArrayBuffer.isView(source))
    throw new ERR_INVALID_ARG_TYPE('source', ['Buffer', 'Uint8Array'], source);
  if (!ArrayBuffer.isView(target))
    throw new ERR_INVALID_ARG_TYPE('target', ['Buffer', 'Uint8Array'], target);

  if (targetStart === undefined) {
    targetStart = 0;
  } else {
    targetStart = Number.isInteger(targetStart) ? targetStart : toInteger(targetStart, 0);
    if (targetStart < 0)
      throw new ERR_OUT_OF_RANGE('targetStart', '>= 0', targetStart);
  }

  if (sourceStart === undefined) {
    sourceStart = 0;
  } else {
    sourceStart = Number.isInteger(sourceStart) ? sourceStart : toInteger(sourceStart, 0);
    if (sourceStart < 0 || sourceStart > source.byteLength)
      throw new ERR_OUT_OF_RANGE('sourceStart', `>= 0 && <= ${source.byteLength}`, sourceStart);
  }

  if (sourceEnd === undefined) {
    sourceEnd = source.byteLength;
  } else {
    sourceEnd = Number.isInteger(sourceEnd) ? sourceEnd : toInteger(sourceEnd, 0);
    if (sourceEnd < 0)
      throw new ERR_OUT_OF_RANGE('sourceEnd', '>= 0', sourceEnd);
  }

  if (targetStart >= target.byteLength || sourceStart >= sourceEnd)
    return 0;

  return _copyActual(source, target, targetStart, sourceStart, sourceEnd);
}

function _copyActual(source, target, targetStart, sourceStart, sourceEnd, isUint8Copy = false) {
  if (sourceEnd - sourceStart > target.byteLength - targetStart)
    sourceEnd = sourceStart + target.byteLength - targetStart;

  let nb = sourceEnd - sourceStart;
  const sourceLen = source.byteLength - sourceStart;
  if (nb > sourceLen)
    nb = sourceLen;

  if (nb <= 0)
    return 0;

  if (sourceStart === 0 && nb === sourceLen && (isUint8Copy || isUint8Array(target))) {
    target.set(source, targetStart);
  } else {
    bindingCopy(source, target, targetStart, sourceStart, nb);
  }

  return nb;
}

Object.defineProperty(Buffer, Symbol.species, {
  __proto__: null,
  enumerable: false,
  configurable: true,
  get() { return FastBuffer; },
});

Buffer.from = function from(value, encodingOrOffset, length) {
  if (typeof value === 'string')
    return fromString(value, encodingOrOffset);

  if (typeof value === 'object' && value !== null) {
    if (isAnyArrayBuffer(value))
      return fromArrayBuffer(value, encodingOrOffset, length);

    const valueOf = value.valueOf && value.valueOf();
    if (valueOf != null &&
        valueOf !== value &&
        (typeof valueOf === 'string' || typeof valueOf === 'object')) {
      return from(valueOf, encodingOrOffset, length);
    }

    const b = fromObject(value);
    if (b)
      return b;

    if (typeof value[Symbol.toPrimitive] === 'function') {
      const primitive = value[Symbol.toPrimitive]('string');
      if (typeof primitive === 'string') {
        return fromString(primitive, encodingOrOffset);
      }
    }
  }

  throw new ERR_INVALID_ARG_TYPE(
    'first argument',
    ['string', 'Buffer', 'ArrayBuffer', 'Array', 'Array-like Object'],
    value,
  );
};

Buffer.copyBytesFrom = function copyBytesFrom(view, offset, length) {
  if (!isTypedArray(view)) {
    throw new ERR_INVALID_ARG_TYPE('view', ['TypedArray'], view);
  }

  const viewLength = view.length;
  if (viewLength === 0) {
    return new FastBuffer();
  }

  let start = 0;
  let end = viewLength;

  if (offset !== undefined) {
    validateInteger(offset, 'offset', 0);
    if (offset >= viewLength) return new FastBuffer();
    start = offset;
  }

  if (length !== undefined) {
    validateInteger(length, 'length', 0);
    // The old code used TypedArrayPrototypeSlice which clamps internally.
    end = Math.min(start + length, viewLength);
  }

  if (end <= start) return new FastBuffer();

  const viewByteLength = view.byteLength;
  const elementSize = viewByteLength / viewLength;
  const srcByteOffset = view.byteOffset + start * elementSize;
  const srcByteLength = (end - start) * elementSize;

  return fromArrayLike(new Uint8Array(
    view.buffer,
    srcByteOffset,
    srcByteLength));
};

// Identical to the built-in %TypedArray%.of(), but avoids using the deprecated
// Buffer() constructor. Must use arrow function syntax to avoid automatically
// adding a `prototype` property and making the function a constructor.
const of = (...items) => {
  const len = items.length;
  const newObj = new FastBuffer(len); // In heap for small sizes
  for (let k = 0; k < len; k++)
    newObj[k] = items[k];
  return newObj;
};
Buffer.of = of;

Object.setPrototypeOf(Buffer, Uint8Array);

Buffer.alloc = function alloc(size, fill, encoding) {
  validateNumber(size, 'size', 0, kMaxLength);
  if (fill !== undefined && fill !== 0 && size > 0) {
    const buf = createUnsafeBuffer(size);
    return _fill(buf, fill, 0, buf.length, encoding);
  }
  return new FastBuffer(size);
};

Buffer.allocUnsafe = function allocUnsafe(size) {
  validateNumber(size, 'size', 0, kMaxLength);
  return allocate(size);
};

Buffer.allocUnsafeSlow = function allocUnsafeSlow(size) {
  validateNumber(size, 'size', 0, kMaxLength);
  return createUnsafeBuffer(size);
};

// If --zero-fill-buffers command line argument is set, a zero-filled
// buffer is returned.
function SlowBuffer(size) {
  validateNumber(size, 'size', 0, kMaxLength);
  return createUnsafeBuffer(size);
}

Object.setPrototypeOf(SlowBuffer.prototype, Buffer.prototype);
Object.setPrototypeOf(SlowBuffer, Buffer);

function allocate(size) {
  if (size <= 0) {
    return new FastBuffer();
  }
  if (size < (Buffer.poolSize >>> 1)) {
    if (size > (poolSize - poolOffset))
      createPool();
    const b = new FastBuffer(allocPool, poolOffset, size);
    poolOffset += size;
    alignPool();
    return b;
  }
  return createUnsafeBuffer(size);
}

function fromStringFast(string, ops) {
  const maxLength = Buffer.poolSize >>> 1;

  let length = string.length; // Min length

  if (length >= maxLength)
    return createFromString(string, ops);

  length *= 4; // Max length (4 bytes per character)

  if (length >= maxLength)
    length = ops.byteLength(string); // Actual length

  if (length >= maxLength)
    return createFromString(string, ops, length);

  if (length > (poolSize - poolOffset))
    createPool();

  const actual = ops.write(allocBuffer, string, poolOffset, length);
  const b = new FastBuffer(allocPool, poolOffset, actual);

  poolOffset += actual;
  alignPool();
  return b;
}

function createFromString(string, ops, length = ops.byteLength(string)) {
  const buf = Buffer.allocUnsafeSlow(length);
  const actual = ops.write(buf, string, 0, length);
  return actual < length ? new FastBuffer(buf.buffer, 0, actual) : buf;
}

function fromString(string, encoding) {
  let ops;
  if (!encoding || encoding === 'utf8' || typeof encoding !== 'string') {
    ops = encodingOps.utf8;
  } else {
    ops = getEncodingOps(encoding);
    if (ops === undefined)
      throw new ERR_UNKNOWN_ENCODING(encoding);
  }

  return string.length === 0 ? new FastBuffer() : fromStringFast(string, ops);
}

function fromArrayBuffer(obj, byteOffset, length) {
  // Convert byteOffset to integer
  if (byteOffset === undefined) {
    byteOffset = 0;
  } else {
    byteOffset = +byteOffset;
    if (Number.isNaN(byteOffset))
      byteOffset = 0;
  }

  const maxLength = obj.byteLength - byteOffset;

  if (maxLength < 0)
    throw new ERR_BUFFER_OUT_OF_BOUNDS('offset');

  if (length !== undefined) {
    // Convert length to non-negative integer.
    length = +length;
    if (length > 0) {
      if (length > maxLength)
        throw new ERR_BUFFER_OUT_OF_BOUNDS('length');
    } else {
      length = 0;
    }
  }

  return new FastBuffer(obj, byteOffset, length);
}

function fromArrayLike(obj) {
  const { length } = obj;
  if (length <= 0)
    return new FastBuffer();
  if (length < (Buffer.poolSize >>> 1)) {
    if (length > (poolSize - poolOffset))
      createPool();
    const b = new FastBuffer(allocPool, poolOffset, length);
    b.set(obj, 0);
    poolOffset += length;
    alignPool();
    return b;
  }
  return new FastBuffer(obj);
}

function fromObject(obj) {
  if (obj.length !== undefined || isAnyArrayBuffer(obj.buffer)) {
    if (typeof obj.length !== 'number') {
      return new FastBuffer();
    }
    return fromArrayLike(obj);
  }

  if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return fromArrayLike(obj.data);
  }
}

// Static methods

Buffer.isBuffer = function isBuffer(b) {
  // instanceof covers the common single-copy case; the Symbol.for marker
  // covers cross-copy cases (e.g. globalThis.Buffer vs node:buffer Buffer
  // from a separately-built bundle). Symbol.for is realm-shared, so the
  // marker works even when the Buffer classes differ.
  return b instanceof Buffer ||
    (b != null && (typeof b === 'object' || typeof b === 'function') &&
      b[Symbol.for('bvm.buffer.isBuffer')] === true);
};

Buffer.compare = function compare(buf1, buf2) {
  if (!isUint8Array(buf1)) {
    throw new ERR_INVALID_ARG_TYPE('buf1', ['Buffer', 'Uint8Array'], buf1);
  }

  if (!isUint8Array(buf2)) {
    throw new ERR_INVALID_ARG_TYPE('buf2', ['Buffer', 'Uint8Array'], buf2);
  }

  if (buf1 === buf2) {
    return 0;
  }

  return bindingCompare(buf1, buf2);
};

Buffer.isEncoding = function isEncoding(encoding) {
  return typeof encoding === 'string' && encoding.length !== 0 &&
         normalizeEncoding(encoding) !== undefined;
};
Buffer[kIsEncodingSymbol] = Buffer.isEncoding;

Buffer.concat = function concat(list, length) {
  validateArray(list, 'list');

  if (list.length === 0)
    return new FastBuffer();

  if (length === undefined) {
    length = 0;
    for (let i = 0; i < list.length; i++) {
      const buf = list[i];
      if (!isUint8Array(buf)) {
        // TODO(BridgeAR): This should not be of type ERR_INVALID_ARG_TYPE.
        // Instead, find the proper error code for this.
        throw new ERR_INVALID_ARG_TYPE(
          `list[${i}]`, ['Buffer', 'Uint8Array'], buf);
      }
      length += buf.byteLength;
    }

    const buffer = allocate(length);
    let pos = 0;
    for (let i = 0; i < list.length; i++) {
      const buf = list[i];
      const bufLength = buf.byteLength;
      buffer.set(buf, pos);
      pos += bufLength;
    }

    if (pos < length) {
      TypedArrayPrototypeFill.call(buffer, 0, pos, length);
    }
    return buffer;
  }

  validateOffset(length, 'length');
  for (let i = 0; i < list.length; i++) {
    if (!isUint8Array(list[i])) {
      // TODO(BridgeAR): This should not be of type ERR_INVALID_ARG_TYPE.
      // Instead, find the proper error code for this.
      throw new ERR_INVALID_ARG_TYPE(
        `list[${i}]`, ['Buffer', 'Uint8Array'], list[i]);
    }
  }

  const buffer = allocate(length);
  let pos = 0;
  for (let i = 0; i < list.length; i++) {
    const buf = list[i];
    const bufLength = buf.byteLength;
    if (pos + bufLength > length) {
      buffer.set(buf.subarray(0, length - pos), pos);
      pos = length;
      break;
    }
    buffer.set(buf, pos);
    pos += bufLength;
  }

  // Note: `length` is always equal to `buffer.length` at this point
  if (pos < length) {
    // Zero-fill the remaining bytes if the specified `length` was more than
    // the actual total length, i.e. if we have some remaining allocated bytes
    // there were not initialized.
    TypedArrayPrototypeFill.call(buffer, 0, pos, length);
  }

  return buffer;
};

function byteLength(string, encoding) {
  if (typeof string !== 'string') {
    if (isArrayBufferView(string) || isAnyArrayBuffer(string)) {
      return string.byteLength;
    }

    throw new ERR_INVALID_ARG_TYPE(
      'string', ['string', 'Buffer', 'ArrayBuffer'], string,
    );
  }

  const len = string.length;
  if (len === 0)
    return 0;

  if (!encoding || encoding === 'utf8') {
    return byteLengthUtf8(string);
  }

  if (encoding === 'ascii') {
    return len;
  }

  const ops = getEncodingOps(encoding);
  if (ops === undefined) {
    // TODO (ronag): Makes more sense to throw here.
    // throw new ERR_UNKNOWN_ENCODING(encoding);
    return byteLengthUtf8(string);
  }

  return ops.byteLength(string);
}

Buffer.byteLength = byteLength;

// For backwards compatibility.
Object.defineProperty(Buffer.prototype, 'parent', {
  __proto__: null,
  enumerable: true,
  get() {
    if (!(this instanceof Buffer))
      return undefined;
    return this.buffer;
  },
});
Object.defineProperty(Buffer.prototype, 'offset', {
  __proto__: null,
  enumerable: true,
  get() {
    if (!(this instanceof Buffer))
      return undefined;
    return this.byteOffset;
  },
});

Buffer.prototype.copy =
  function copy(target, targetStart, sourceStart, sourceEnd) {
    return copyImpl(this, target, targetStart, sourceStart, sourceEnd);
  };

// No need to verify that "buf.length <= MAX_UINT32" since it's a read-only
// property of a typed array.
// This behaves neither like String nor Uint8Array in that we set start/end
// to their upper/lower bounds if the value passed is out of range.
Buffer.prototype.toString = function toString(encoding, start, end) {
  if (arguments.length === 0) {
    return utf8Slice(this, 0, this.length);
  }

  const bufferLength = this.length;

  if (start <= 0)
    start = 0;
  else if (start >= bufferLength)
    return '';
  else
    start = Math.trunc(start) || 0;

  if (end === undefined || end > bufferLength)
    end = bufferLength;
  else
    end = Math.trunc(end) || 0;

  if (end <= start)
    return '';

  if (encoding === undefined)
    return utf8Slice(this, start, end);

  const ops = getEncodingOps(encoding);
  if (ops === undefined)
    throw new ERR_UNKNOWN_ENCODING(encoding);

  return ops.slice(this, start, end);
};

Buffer.prototype.equals = function equals(otherBuffer) {
  if (!isUint8Array(otherBuffer)) {
    throw new ERR_INVALID_ARG_TYPE(
      'otherBuffer', ['Buffer', 'Uint8Array'], otherBuffer);
  }

  if (this === otherBuffer)
    return true;
  const len = this.byteLength;
  if (len !== otherBuffer.byteLength)
    return false;

  return len === 0 || bindingCompare(this, otherBuffer) === 0;
};

function getNodeUtilInspect() {
  // Optional host functionality (inspect extras): prefer the host's own
  // util.inspect when running under Node, so custom-inspect output matches
  // the host byte-for-byte.
  try {
    if (typeof process !== 'undefined' && process !== null &&
        typeof process.getBuiltinModule === 'function') {
      const util = process.getBuiltinModule('util');
      if (util && typeof util.inspect === 'function')
        return util.inspect;
    }
  } catch {}
  return undefined;
}

// Override how buffers are presented by util.inspect().
Buffer.prototype[customInspectSymbol] = function inspect(recurseTimes, ctx) {
  const max = INSPECT_MAX_BYTES;
  const actualMax = Math.min(max, this.length);
  const remaining = this.length - max;
  let str = hexSlice(this, 0, actualMax).replace(/(.{2})/g, '$1 ').trim();
  if (remaining > 0)
    str += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;
  // Inspect special properties as well, if possible.
  if (ctx) {
    let extras = false;
    const filter = ctx.showHidden ? ALL_PROPERTIES : ONLY_ENUMERABLE;
    const obj = { __proto__: null };
    for (const key of getOwnNonIndexProperties(this, filter)) {
      extras = true;
      obj[key] = this[key];
    }
    if (extras) {
      if (this.length !== 0)
        str += ', ';
      const utilInspect = getNodeUtilInspect();
      if (utilInspect) {
        // '[Object: null prototype] {'.length === 26
        // This is guarded with a test.
        str += utilInspect(obj, {
          ...ctx,
          breakLength: Infinity,
          compact: true,
        }).slice(27, -2);
      } else {
        // Browser-safe fallback when the host util is unavailable.
        str += Object.keys(obj).map((k) => {
          let v;
          try { v = String(obj[k]); } catch { v = '?'; }
          return `${String(k)}: ${v}`;
        }).join(', ');
      }
    }
  }
  let constructorName = 'Buffer';
  try {
    const { constructor } = this;
    if (typeof constructor === 'function' &&
        Object.prototype.hasOwnProperty.call(constructor, 'name')) {
      constructorName = constructor.name;
    }
  } catch { /* Ignore error and use default name */ }
  return `<${constructorName} ${str}>`;
};
Buffer.prototype.inspect = Buffer.prototype[customInspectSymbol];

Buffer.prototype.compare = function compare(target,
                                            targetStart,
                                            targetEnd,
                                            sourceStart,
                                            sourceEnd) {
  if (!isUint8Array(target)) {
    throw new ERR_INVALID_ARG_TYPE('target', ['Buffer', 'Uint8Array'], target);
  }
  if (arguments.length === 1)
    return bindingCompare(this, target);

  if (targetStart === undefined)
    targetStart = 0;
  else
    validateOffset(targetStart, 'targetStart');

  if (targetEnd === undefined)
    targetEnd = target.length;
  else
    validateOffset(targetEnd, 'targetEnd', 0, target.length);

  if (sourceStart === undefined)
    sourceStart = 0;
  else
    validateOffset(sourceStart, 'sourceStart');

  if (sourceEnd === undefined)
    sourceEnd = this.length;
  else
    validateOffset(sourceEnd, 'sourceEnd', 0, this.length);

  if (sourceStart >= sourceEnd)
    return (targetStart >= targetEnd ? 0 : -1);
  if (targetStart >= targetEnd)
    return 1;

  return bindingCompareOffset(this, target, targetStart, sourceStart, targetEnd,
                              sourceEnd);
};

// Normalize any ArrayBuffer view (Buffer, TypedArray, DataView) to a
// Uint8Array view over the same bytes for the indexOf implementations.
function toUint8View(view) {
  return view instanceof Uint8Array
    ? view
    : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - end - absolute exclusive end of the search range
// - encoding - an optional encoding, relevant if val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf(buffer, val, byteOffset, end, encoding, dir) {
  validateBuffer(buffer);

  if (typeof byteOffset === 'string') {
    encoding = byteOffset;
    byteOffset = undefined;
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff;
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000;
  }
  // Coerce to Number. Values like null and [] become 0.
  byteOffset = +byteOffset;
  // If the offset is undefined, "foo", {}, coerces to NaN, search whole buffer.
  if (Number.isNaN(byteOffset)) {
    byteOffset = dir ? 0 : (buffer.length || buffer.byteLength);
  } else {
    // The native bindings receive the offset as an integer (ToInteger).
    byteOffset = Math.trunc(byteOffset);
  }
  dir = !!dir;  // Cast to bool.

  if (typeof val === 'number')
    return bindingIndexOfNumber(toUint8View(buffer), val >>> 0, byteOffset, dir, end);

  let ops;
  if (encoding === undefined)
    ops = encodingOps.utf8;
  else
    ops = getEncodingOps(encoding);

  if (typeof val === 'string') {
    if (ops === undefined)
      throw new ERR_UNKNOWN_ENCODING(encoding);
    return ops.indexOf(toUint8View(buffer), val, byteOffset, dir, end);
  }

  if (isUint8Array(val)) {
    const encodingVal =
      (ops === undefined ? encodingsMap.utf8 : ops.encodingVal);
    return bindingIndexOfBuffer(toUint8View(buffer), val, byteOffset, encodingVal, dir, end);
  }

  throw new ERR_INVALID_ARG_TYPE(
    'value', ['number', 'string', 'Buffer', 'Uint8Array'], val,
  );
}

Buffer.prototype.indexOf = function indexOf(val, offset, end, encoding) {
  if (typeof end === 'string') {
    encoding = end;
    end = this.length;
  } else if (end === undefined) {
    end = this.length;
  }
  return bidirectionalIndexOf(this, val, offset, end, encoding, true);
};

Buffer.prototype.lastIndexOf = function lastIndexOf(val, offset, end, encoding) {
  if (typeof end === 'string') {
    encoding = end;
    end = this.length;
  } else if (end === undefined) {
    end = this.length;
  }
  return bidirectionalIndexOf(this, val, offset, end, encoding, false);
};

Buffer.prototype.includes = function includes(val, offset, end, encoding) {
  if (typeof end === 'string') {
    encoding = end;
    end = this.length;
  } else if (end === undefined) {
    end = this.length;
  }
  return bidirectionalIndexOf(this, val, offset, end, encoding, true) !== -1;
};

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill(value, offset, end, encoding) {
  return _fill(this, value, offset, end, encoding);
};

// The original %TypedArray%.prototype.fill, captured before
// Buffer.prototype.fill overrides it on the FastBuffer prototype chain.
const TypedArrayPrototypeFill = Uint8Array.prototype.fill;

function _fill(buf, value, offset, end, encoding) {
  if (typeof value === 'string') {
    if (offset === undefined || typeof offset === 'string') {
      encoding = offset;
      offset = 0;
      end = buf.length;
    } else if (typeof end === 'string') {
      encoding = end;
      end = buf.length;
    }

    const normalizedEncoding = normalizeEncoding(encoding);
    if (normalizedEncoding === undefined) {
      validateString(encoding, 'encoding');
      throw new ERR_UNKNOWN_ENCODING(encoding);
    }

    if (value.length === 0) {
      // If value === '' default to zero.
      value = 0;
    } else if (value.length === 1) {
      // Fast path: If `value` fits into a single byte, use that numeric value.
      // ASCII shares this branch with utf8 since code < 128 covers the full
      // ASCII range; anything outside falls through to the generic fill.
      if (normalizedEncoding === 'utf8' || normalizedEncoding === 'ascii') {
        const code = value.charCodeAt(0);
        if (code < 128) {
          value = code;
        }
      } else if (normalizedEncoding === 'latin1') {
        value = value.charCodeAt(0);
      }
    }
  } else {
    encoding = undefined;
  }

  if (offset === undefined) {
    offset = 0;
    end = buf.length;
  } else {
    validateOffset(offset, 'offset');
    // Invalid ranges are not set to a default, so can range check early.
    if (end === undefined) {
      end = buf.length;
    } else {
      validateOffset(end, 'end', 0, buf.length);
    }
    if (offset >= end)
      return buf;
  }


  if (typeof value === 'number') {
    // OOB check
    const byteLen = buf.byteLength;
    const fillLength = end - offset;
    if (offset > end || fillLength + offset > byteLen)
      throw new ERR_BUFFER_OUT_OF_BOUNDS();

    TypedArrayPrototypeFill.call(buf, value, offset, end);
  } else {
    const res = bindingFill(buf, value, offset, end, encoding);
    if (res < 0) {
      if (res === -1)
        throw new ERR_INVALID_ARG_VALUE('value', value);
      throw new ERR_BUFFER_OUT_OF_BOUNDS();
    }
  }

  return buf;
}

Buffer.prototype.write = function write(string, offset, length, encoding) {
  const bufferLength = this.length;
  // Buffer#write(string);
  if (offset === undefined) {
    return utf8Write(this, string, 0, bufferLength);
  }
  // Buffer#write(string, encoding)
  if (length === undefined && typeof offset === 'string') {
    encoding = offset;
    length = bufferLength;
    offset = 0;

  // Buffer#write(string, offset[, length][, encoding])
  } else {
    validateOffset(offset, 'offset', 0, bufferLength);

    const remaining = bufferLength - offset;

    if (length === undefined) {
      length = remaining;
    } else if (typeof length === 'string') {
      encoding = length;
      length = remaining;
    } else {
      validateOffset(length, 'length', 0, bufferLength);
      if (length > remaining)
        length = remaining;
    }
  }

  if (!encoding || encoding === 'utf8')
    return utf8Write(this, string, offset, length);
  if (encoding === 'ascii')
    return asciiWrite(this, string, offset, length);

  const ops = getEncodingOps(encoding);
  if (ops === undefined)
    throw new ERR_UNKNOWN_ENCODING(encoding);
  return ops.write(this, string, offset, length);
};

Buffer.prototype.toJSON = function toJSON() {
  const bufferLength = this.length;
  if (bufferLength > 0) {
    const data = new Array(bufferLength);
    for (let i = 0; i < bufferLength; ++i)
      data[i] = this[i];
    return { type: 'Buffer', data };
  }
  return { type: 'Buffer', data: [] };
};

function adjustOffset(offset, length) {
  // Use Math.trunc() to convert offset to an integer value that can be larger
  // than an Int32. Hence, don't use offset | 0 or similar techniques.
  offset = Math.trunc(offset);
  if (offset === 0) {
    return 0;
  }
  if (offset < 0) {
    offset += length;
    return offset > 0 ? offset : 0;
  }
  if (offset < length) {
    return offset;
  }
  return Number.isNaN(offset) ? 0 : length;
}

Buffer.prototype.subarray = function subarray(start, end) {
  const srcLength = this.length;
  start = adjustOffset(start, srcLength);
  end = end !== undefined ? adjustOffset(end, srcLength) : srcLength;
  const newLength = end > start ? end - start : 0;
  return new FastBuffer(this.buffer, this.byteOffset + start, newLength);
};

Buffer.prototype.slice = function slice(start, end) {
  return this.subarray(start, end);
};

function swap(b, n, m) {
  const i = b[n];
  b[n] = b[m];
  b[m] = i;
}

Buffer.prototype.swap16 = function swap16() {
  const len = this.length;
  if (len % 2 !== 0)
    throw new ERR_INVALID_BUFFER_SIZE('16-bits');
  if (len <= 32) {
    for (let i = 0; i < len; i += 2)
      swap(this, i, i + 1);
    return this;
  }
  bindingSwap16(this);
  return this;
};

Buffer.prototype.swap32 = function swap32() {
  const len = this.length;
  if (len % 4 !== 0)
    throw new ERR_INVALID_BUFFER_SIZE('32-bits');
  if (len <= 32) {
    for (let i = 0; i < len; i += 4) {
      swap(this, i, i + 3);
      swap(this, i + 1, i + 2);
    }
    return this;
  }
  bindingSwap32(this);
  return this;
};

Buffer.prototype.swap64 = function swap64() {
  const len = this.length;
  if (len % 8 !== 0)
    throw new ERR_INVALID_BUFFER_SIZE('64-bits');
  if (len < 48) {
    for (let i = 0; i < len; i += 8) {
      swap(this, i, i + 7);
      swap(this, i + 1, i + 6);
      swap(this, i + 2, i + 5);
      swap(this, i + 3, i + 4);
    }
    return this;
  }
  bindingSwap64(this);
  return this;
};

Buffer.prototype.toLocaleString = Buffer.prototype.toString;

// Transcodes the Buffer from one encoding to another, returning a new
// Buffer instance. Pure-JS: supports the ICU text encodings implemented by
// this module (utf8, utf16le, latin1, ascii); other encodings throw the same
// shape of error Node's ICU binding produces.
function transcode(source, fromEncoding, toEncoding) {
  if (!isUint8Array(source)) {
    throw new ERR_INVALID_ARG_TYPE('source',
                                   ['Buffer', 'Uint8Array'], source);
  }
  if (source.length === 0) return new FastBuffer();

  const from = normalizeEncoding(fromEncoding) || fromEncoding;
  const to = normalizeEncoding(toEncoding) || toEncoding;
  // ICU-backed transcodable text encodings (base64/hex are not valid here).
  const transcodingOps = (name) =>
    name === 'utf8' ? encodingOps.utf8 :
    name === 'utf16le' ? encodingOps.utf16le :
    name === 'latin1' ? encodingOps.latin1 :
    name === 'ascii' ? encodingOps.ascii : undefined;
  const fromOps = transcodingOps(from);
  const toOps = transcodingOps(to);
  if (fromOps === undefined || toOps === undefined) {
    const err = new Error(
      'Unable to transcode Buffer [U_ILLEGAL_ARGUMENT_ERROR]');
    err.code = 'U_ILLEGAL_ARGUMENT_ERROR';
    err.errno = 1;
    throw err;
  }
  return fromStringFast(fromOps.slice(source, 0, source.length), toOps);
}

function getDOMException() {
  if (typeof DOMException !== 'undefined') return DOMException;
  return class DOMException extends Error {
    constructor(message, name) {
      super(message);
      this.name = name;
    }
  };
}

function btoa(input) {
  // The implementation here has not been performance optimized in any way and
  // should not be.
  // Refs: https://github.com/nodejs/node/pull/38433#issuecomment-828426932
  if (arguments.length === 0) {
    throw new ERR_MISSING_ARGS('input');
  }
  const str = `${input}`;
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code > 0xff) {
      throw new (getDOMException())('Invalid character', 'InvalidCharacterError');
    }
    bytes[i] = code;
  }
  return base64Slice(bytes, 0, bytes.length);
}

function atob(input) {
  if (arguments.length === 0) {
    throw new ERR_MISSING_ARGS('input');
  }
  const str = `${input}`;
  // Strip ASCII whitespace (WHATWG forgiving-base64).
  let cleaned = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20)
      continue;
    cleaned += str[i];
  }
  // Validate characters and padding placement.
  let dataEnd = cleaned.length;
  if (dataEnd >= 1 && cleaned.charCodeAt(dataEnd - 1) === 0x3d) dataEnd--;
  if (dataEnd >= 1 && cleaned.charCodeAt(dataEnd - 1) === 0x3d) dataEnd--;
  for (let i = 0; i < dataEnd; i++) {
    const v = cleaned.charCodeAt(i) < 256 ? b64Table[cleaned.charCodeAt(i)] : -1;
    if (v < 0) {
      throw new (getDOMException())('Invalid character', 'InvalidCharacterError');
    }
  }
  for (let i = dataEnd; i < cleaned.length; i++) {
    if (cleaned.charCodeAt(i) !== 0x3d) {
      throw new (getDOMException())('Invalid character', 'InvalidCharacterError');
    }
  }
  if (dataEnd % 4 === 1) {
    throw new (getDOMException())(
      'The string to be decoded is not correctly encoded.',
      'InvalidCharacterError');
  }
  const out = new Uint8Array((dataEnd * 3) >> 2);
  const n = base64Write(out, cleaned.slice(0, dataEnd), 0, out.length);
  return latin1Slice(out, 0, n);
}

function isUtf8(input) {
  if (isTypedArray(input) || isAnyArrayBuffer(input)) {
    return bindingIsUtf8(input);
  }
  // A detached genuine ArrayBuffer fails the DataView probe inside
  // isAnyArrayBuffer; Node reports ERR_INVALID_STATE for it rather than
  // ERR_INVALID_ARG_TYPE.
  if (isDetachedArrayBuffer(input)) {
    throw new ERR_INVALID_STATE('Cannot validate on a detached buffer');
  }

  throw new ERR_INVALID_ARG_TYPE('input', ['ArrayBuffer', 'Buffer', 'TypedArray'], input);
}

function isAscii(input) {
  if (isTypedArray(input) || isAnyArrayBuffer(input)) {
    return bindingIsAscii(input);
  }
  if (isDetachedArrayBuffer(input)) {
    throw new ERR_INVALID_STATE('Cannot validate on a detached buffer');
  }

  throw new ERR_INVALID_ARG_TYPE('input', ['ArrayBuffer', 'Buffer', 'TypedArray'], input);
}

// Detects a genuine but detached ArrayBuffer/SharedArrayBuffer: the class
// tag survives detachment while the DataView internal-slot probe throws.
function isDetachedArrayBuffer(value) {
  if (value === null || typeof value !== 'object') return false;
  const tag = Object.prototype.toString.call(value);
  if (tag !== '[object ArrayBuffer]' && tag !== '[object SharedArrayBuffer]') {
    return false;
  }
  if (typeof value.byteLength !== 'number') return false;
  try {
    new DataView(value);
    return false;
  } catch {
    return true;
  }
}

// Minimal equivalent of internal/util's deprecate() for the SlowBuffer export.
function deprecate(fn, msg, code) {
  let warned = false;
  function deprecated(...args) {
    if (!warned) {
      warned = true;
      try {
        if (typeof process !== 'undefined' && process !== null &&
            typeof process.emitWarning === 'function') {
          process.emitWarning(msg, 'DeprecationWarning', code);
        }
      } catch {}
    }
    return fn.apply(this, args);
  }
  Object.setPrototypeOf(deprecated, Object.getPrototypeOf(fn));
  Object.setPrototypeOf(deprecated.prototype, Uint8Array.prototype);
  return deprecated;
}

const SlowBufferDeprecated = deprecate(
  SlowBuffer,
  'SlowBuffer() is deprecated. Please use Buffer.allocUnsafeSlow()',
  'DEP0030');

// Optional host functionality (Blob, File, resolveObjectURL), resolved lazily
// like Node's defineLazyProperties.
function getHostBufferModule() {
  try {
    if (typeof process !== 'undefined' && process !== null &&
        typeof process.getBuiltinModule === 'function') {
      return process.getBuiltinModule('buffer');
    }
  } catch {}
  return undefined;
}

function resolveHostExport(name) {
  const mod = getHostBufferModule();
  if (mod && mod[name] !== undefined) return mod[name];
  if (typeof globalThis !== 'undefined' && globalThis[name] !== undefined)
    return globalThis[name];
  return undefined;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const bufferExports = {
  Buffer,
  SlowBuffer: SlowBufferDeprecated,
  transcode,
  isUtf8,
  isAscii,

  // Legacy
  kMaxLength,
  kStringMaxLength,
  btoa,
  atob,
};

Object.defineProperties(bufferExports, {
  constants: {
    __proto__: null,
    configurable: false,
    enumerable: true,
    value: constants,
  },
  INSPECT_MAX_BYTES: {
    __proto__: null,
    configurable: true,
    enumerable: true,
    get() { return INSPECT_MAX_BYTES; },
    set(val) {
      validateNumber(val, 'INSPECT_MAX_BYTES', 0);
      INSPECT_MAX_BYTES = val;
    },
  },
  Blob: {
    __proto__: null,
    configurable: true,
    enumerable: true,
    get() { return resolveHostExport('Blob'); },
  },
  File: {
    __proto__: null,
    configurable: true,
    enumerable: true,
    get() { return resolveHostExport('File'); },
  },
  resolveObjectURL: {
    __proto__: null,
    configurable: true,
    enumerable: true,
    get() { return resolveHostExport('resolveObjectURL'); },
  },
});

export default bufferExports;

export {
  Buffer,
  transcode,
  isUtf8,
  isAscii,
  kMaxLength,
  kStringMaxLength,
  btoa,
  atob,
  constants,
  INSPECT_MAX_BYTES,
  SlowBufferDeprecated as SlowBuffer,
};
export const Blob = resolveHostExport('Blob');
export const File = resolveHostExport('File');
export const resolveObjectURL = resolveHostExport('resolveObjectURL');
