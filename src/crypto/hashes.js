/*!
 * crypto/hashes — Hash/Hmac surface for node:crypto's browser fallback,
 * backed by the audited, maintained @noble/hashes library (sync API).
 * Implements Node.js v24.20.0's Hash/Hmac surface
 * (update/digest/copy, createHash/createHmac, getHashes, hash one-shot)
 * with byte-identical digests (verified differentially against node:crypto).
 *
 * The Node-exact layers stay local: algorithm name normalization and
 * aliases, input-encoding handling (toBytes), digest-encoding rendering
 * (encodeDigest), and every ERR_* validation/error code and message.
 * Only the raw compression primitives come from @noble/hashes.
 */

import { Buffer } from '../buffer.js';
import { md5, sha1 } from '@noble/hashes/legacy.js';
import {
  sha224,
  sha256,
  sha384,
  sha512,
  sha512_224,
  sha512_256,
} from '@noble/hashes/sha2.js';
import {
  ERR_INVALID_ARG_TYPE,
  ERR_CRYPTO_INVALID_DIGEST,
} from './errors.js';

// ---------------------------------------------------------------------------
// Algorithm table: Node name -> @noble/hashes hasher.
// Each hasher is a createHasher() function: hasher(bytes) is the one-shot
// digest, hasher.create() is a streaming instance with
// update()/digest()/clone(), hasher.blockLen is the HMAC block size.
// ---------------------------------------------------------------------------

const ALGORITHMS = {
  md5,
  sha1,
  sha224,
  sha256,
  sha384,
  sha512,
  'sha512-224': sha512_224,
  'sha512-256': sha512_256,
};

function normalizeAlgorithm(algorithm) {
  if (typeof algorithm !== 'string') {
    throw new ERR_INVALID_ARG_TYPE('algorithm', 'string', algorithm);
  }
  const key = algorithm.toLowerCase();
  // Accept a few common aliases the way OpenSSL does.
  const aliases = {
    'md-5': 'md5', 'sha-1': 'sha1', 'sha-224': 'sha224', 'sha-256': 'sha256',
    'sha-384': 'sha384', 'sha-512': 'sha512', 'sha2-256': 'sha256',
    'sha2-512': 'sha512',
  };
  return ALGORITHMS[key] ? key : aliases[key];
}

export function getHashes() {
  return ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512', 'sha512-224', 'sha512-256'];
}

// ---------------------------------------------------------------------------
// Input / output encoding helpers
// ---------------------------------------------------------------------------

function toBytes(data, encoding) {
  if (typeof data === 'string') {
    const enc = encoding === undefined ? 'utf8' : String(encoding).toLowerCase();
    if (enc === 'utf8' || enc === 'utf-8') {
      return new TextEncoder().encode(data);
    }
    if (enc === 'hex') {
      const clean = data.replace(/\s+/g, '');
      if (clean.length % 2 !== 0) throw new Error('Invalid hex string');
      const out = new Uint8Array(clean.length / 2);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.substr(i * 2, 2), 16);
      }
      return out;
    }
    if (enc === 'base64' || enc === 'base64url') {
      return base64ToBytes(data);
    }
    if (enc === 'binary' || enc === 'latin1' || enc === 'ascii') {
      const out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 0xff;
      return out;
    }
    if (enc === 'ucs2' || enc === 'utf16le' || enc === 'utf-16le') {
      const out = new Uint8Array(data.length * 2);
      for (let i = 0; i < data.length; i++) {
        out[i * 2] = data.charCodeAt(i) & 0xff;
        out[i * 2 + 1] = (data.charCodeAt(i) >> 8) & 0xff;
      }
      return out;
    }
    throw new Error(`Unknown encoding: ${encoding}`);
  }
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer)) {
    return new Uint8Array(data);
  }
  throw new ERR_INVALID_ARG_TYPE(
    'data',
    'string or an instance of Buffer, TypedArray, or DataView',
    data,
  );
}

function base64ToBytes(s) {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = typeof atob === 'function'
    ? atob(norm)
    : Buffer.from(norm, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  if (typeof btoa === 'function') {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  return Buffer.from(bytes).toString('base64');
}

function encodeDigest(bytes, encoding) {
  if (encoding === undefined || encoding === null) {
    return Buffer.from(bytes);
  }
  const enc = String(encoding).toLowerCase().replace(/-/g, '');
  if (enc === 'hex') {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      s += bytes[i].toString(16).padStart(2, '0');
    }
    return s;
  }
  if (enc === 'base64') return bytesToBase64(bytes);
  if (enc === 'base64url') {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  if (enc === 'binary' || enc === 'latin1') {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  if (enc === 'utf8') {
    if (typeof TextDecoder === 'function') return new TextDecoder().decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  if (enc === 'ascii') {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0x7f);
    return s;
  }
  if (enc === 'utf16le' || enc === 'ucs2' || enc === 'ucs-2') {
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-16le').decode(bytes);
    let s = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    return s;
  }
  // Node v24: unrecognized digest encodings (including 'buffer' and '') fall
  // back to returning a Buffer instead of throwing.
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Hash / Hmac classes
// ---------------------------------------------------------------------------

export class Hash {
  constructor(algorithm, options) {
    const key = normalizeAlgorithm(algorithm);
    if (key === undefined) {
      throw new Error('Digest method not supported');
    }
    this._hasher = ALGORITHMS[key];
    this._state = this._hasher.create();
    this._algorithm = key;
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      throw new ERR_INVALID_ARG_TYPE('options', 'object', options);
    }
  }
  update(data, inputEncoding) {
    this._state.update(toBytes(data, inputEncoding));
    return this;
  }
  digest(encoding) {
    return encodeDigest(this._state.digest(), encoding);
  }
  copy() {
    const c = Object.create(Hash.prototype);
    c._hasher = this._hasher;
    c._state = this._state.clone();
    c._algorithm = this._algorithm;
    return c;
  }
}

export class Hmac {
  constructor(algorithm, key, options) {
    const akey = normalizeAlgorithm(algorithm);
    if (akey === undefined) {
      throw new ERR_CRYPTO_INVALID_DIGEST(algorithm);
    }
    if (
      typeof key !== 'string' &&
      !(key instanceof Uint8Array) &&
      !ArrayBuffer.isView(key) &&
      !(key instanceof ArrayBuffer)
    ) {
      throw new ERR_INVALID_ARG_TYPE(
        'key',
        'string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey',
        key,
      );
    }
    const hasher = ALGORITHMS[akey];
    const blockSize = hasher.blockLen;
    let keyBytes = toBytes(key, options?.encoding);
    if (keyBytes.length > blockSize) {
      keyBytes = hasher(keyBytes);
    }
    const padded = new Uint8Array(blockSize);
    padded.set(keyBytes);
    const ipad = new Uint8Array(blockSize);
    const opad = new Uint8Array(blockSize);
    for (let i = 0; i < blockSize; i++) {
      ipad[i] = padded[i] ^ 0x36;
      opad[i] = padded[i] ^ 0x5c;
    }
    this._hasher = hasher;
    this._inner = hasher.create();
    this._inner.update(ipad);
    this._opad = opad;
    this._algorithm = akey;
    this._blockSize = blockSize;
  }
  update(data, inputEncoding) {
    this._inner.update(toBytes(data, inputEncoding));
    return this;
  }
  digest(encoding) {
    const innerDigest = this._inner.digest();
    const outer = this._hasher.create();
    outer.update(this._opad);
    outer.update(innerDigest);
    return encodeDigest(outer.digest(), encoding);
  }
  copy() {
    const c = Object.create(Hmac.prototype);
    c._hasher = this._hasher;
    c._inner = this._inner.clone();
    c._opad = this._opad.slice();
    c._algorithm = this._algorithm;
    c._blockSize = this._blockSize;
    return c;
  }
}

export function createHash(algorithm, options) {
  return new Hash(algorithm, options);
}

export function createHmac(algorithm, key, options) {
  return new Hmac(algorithm, key, options);
}

/** One-shot digest, mirroring Node's crypto.hash(). */
export function hash(algorithm, data, outputEncoding) {
  return createHash(algorithm).update(data).digest(outputEncoding ?? 'hex');
}
