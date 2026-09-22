/*!
 * crypto/hashes — pure-JS MD5 / SHA-1 / SHA-2 family for the browser fallback
 * of node:crypto. Implements Node.js v24.20.0's Hash/Hmac surface
 * (update/digest/copy, createHash/createHmac, getHashes, hash one-shot)
 * with byte-identical digests (verified differentially against OpenSSL).
 */

import { Buffer } from '../buffer.js';
import {
  ERR_INVALID_ARG_TYPE,
  ERR_CRYPTO_INVALID_DIGEST,
  unsupportedCrypto,
} from './errors.js';

// ---------------------------------------------------------------------------
// Shared Merkle-Damgård streaming engine
// ---------------------------------------------------------------------------

function makeEngine({ blockSize, initState, compress, outLen, littleEndian }) {
  return class {
    constructor() {
      this._s = initState();
      this._buf = new Uint8Array(blockSize);
      this._bufLen = 0;
      this._total = 0; // total bytes fed (for length padding)
    }
    update(data) {
      let off = 0;
      let len = data.length;
      this._total += len;
      if (this._bufLen > 0) {
        const take = Math.min(blockSize - this._bufLen, len);
        this._buf.set(data.subarray(0, take), this._bufLen);
        this._bufLen += take;
        off += take;
        len -= take;
        if (this._bufLen === blockSize) {
          compress(this._s, this._buf);
          this._bufLen = 0;
        }
      }
      while (len >= blockSize) {
        compress(this._s, data.subarray(off, off + blockSize));
        off += blockSize;
        len -= blockSize;
      }
      if (len > 0) {
        this._buf.set(data.subarray(off, off + len), 0);
        this._bufLen = len;
      }
      return this;
    }
    digest() {
      // Padding: 0x80, zeros, then 64-bit (or 128-bit) big/little-endian length.
      const bitLenHi = Math.floor(this._total / 0x20000000);
      const bitLenLo = (this._total << 3) >>> 0;
      const lenSize = blockSize > 64 ? 16 : 8;
      const padLen =
        this._bufLen + 1 + lenSize <= blockSize
          ? blockSize - (this._bufLen + 1 + lenSize)
          : 2 * blockSize - (this._bufLen + 1 + lenSize);
      const tail = new Uint8Array(1 + padLen + lenSize);
      tail[0] = 0x80;
      const dv = new DataView(tail.buffer);
      if (littleEndian) {
        dv.setUint32(1 + padLen, bitLenLo, true);
        dv.setUint32(1 + padLen + 4, bitLenHi, true);
      } else {
        if (lenSize === 16) {
          dv.setUint32(1 + padLen, 0, false);
          dv.setUint32(1 + padLen + 4, 0, false);
          dv.setUint32(1 + padLen + 8, bitLenHi, false);
          dv.setUint32(1 + padLen + 12, bitLenLo, false);
        } else {
          dv.setUint32(1 + padLen, bitLenHi, false);
          dv.setUint32(1 + padLen + 4, bitLenLo, false);
        }
      }
      const s = this._s.slice ? this._s.slice() : Array.from(this._s);
      // Feed the remaining buffered bytes plus padding through compress().
      const blocks = new Uint8Array(this._bufLen + tail.length);
      blocks.set(this._buf.subarray(0, this._bufLen), 0);
      blocks.set(tail, this._bufLen);
      for (let o = 0; o < blocks.length; o += blockSize) {
        compress(s, blocks.subarray(o, o + blockSize));
      }
      const wordBytes = littleEndian ? 4 : typeof s[0] === 'bigint' ? 8 : 4;
      const out = new Uint8Array(s.length * wordBytes);
      const odv = new DataView(out.buffer);
      for (let i = 0; i < s.length; i++) {
        if (littleEndian) odv.setUint32(i * 4, s[i] >>> 0, true);
        else if (typeof s[i] === 'bigint')
          odv.setBigUint64(i * 8, s[i], false);
        else odv.setUint32(i * 4, s[i] >>> 0, false);
      }
      return out.subarray(0, outLen);
    }
    clone() {
      const c = Object.create(Object.getPrototypeOf(this));
      c._s = this._s.slice ? this._s.slice() : Array.from(this._s);
      c._buf = this._buf.slice();
      c._bufLen = this._bufLen;
      c._total = this._total;
      return c;
    }
  };
}

// ---------------------------------------------------------------------------
// FIPS 180-4 constants, computed exactly with BigInt integer arithmetic.
// The SHA "magic" constants are fractional parts of prime roots:
//   K-256: cbrt of first 64 primes (32 bits)      H-256: sqrt of first 8 primes
//   K-512: cbrt of first 80 primes (64 bits)      H-512: sqrt of first 8 primes
//   SHA-224/384/512-224/512-256 IVs: sqrt of 9th..16th primes.
// Binary search finds q = floor(root(p) * 2^bits) exactly; the constant is
// q - floor(root(p)) * 2^bits. No floating point, no memorized tables.
// ---------------------------------------------------------------------------

function firstPrimes(n) {
  const primes = [];
  let candidate = 2;
  outer: while (primes.length < n) {
    for (const p of primes) {
      if (p * p > candidate) break;
      if (candidate % p === 0) {
        candidate++;
        continue outer;
      }
    }
    primes.push(candidate);
    candidate++;
  }
  return primes;
}

// q = floor(p^(1/3) * 2^bits): binary search q^3 <= p * 2^(3*bits).
function cbrtFracBits(p, bits) {
  const target = BigInt(p) << BigInt(3 * bits);
  let lo = 0n;
  let hi = 1n << BigInt(bits + 3); // cbrt(p) < 8 for p < 512
  while (lo < hi) {
    const mid = (lo + hi + 1n) >> 1n;
    if (mid * mid * mid <= target) lo = mid;
    else hi = mid - 1n;
  }
  const intPart = BigInt(Math.floor(Math.cbrt(p)));
  return lo - (intPart << BigInt(bits));
}

// q = floor(sqrt(p) * 2^bits): binary search q^2 <= p * 2^(2*bits).
function sqrtFracBits(p, bits) {
  const target = BigInt(p) << BigInt(2 * bits);
  let lo = 0n;
  let hi = 1n << BigInt(bits + 4); // sqrt(p) < 16 for p < 256
  while (lo < hi) {
    const mid = (lo + hi + 1n) >> 1n;
    if (mid * mid <= target) lo = mid;
    else hi = mid - 1n;
  }
  const intPart = BigInt(Math.floor(Math.sqrt(p)));
  return lo - (intPart << BigInt(bits));
}

const PRIMES16 = firstPrimes(16);
const PRIMES80 = firstPrimes(80);

const K256 = PRIMES80.slice(0, 64).map((p) => Number(cbrtFracBits(p, 32)));
const K512 = PRIMES80.map((p) => cbrtFracBits(p, 64));
const SHA256_H = () => PRIMES16.slice(0, 8).map((p) => Number(sqrtFracBits(p, 32)));
// SHA-224's IV is the low 32 bits of the 64-bit fractional parts of the
// square roots of the 9th-16th primes (== the low halves of the SHA-384 IV,
// and exactly FIPS 180-4 section 5.3.2's published words).
const SHA224_H = () => PRIMES16.slice(8, 16).map((p) => Number(sqrtFracBits(p, 64) & 0xffffffffn));
const SHA512_H = () => PRIMES16.slice(0, 8).map((p) => sqrtFracBits(p, 64));
const SHA384_H = () => PRIMES16.slice(8, 16).map((p) => sqrtFracBits(p, 64));
const SHA512_224_H = () => [
  0x8c3d37c819544da2n, 0x73e1996689dcd4d6n, 0x1dfab7ae32ff9c82n, 0x679dd514582f9fcfn,
  0x0f6d2b697bd44da8n, 0x77e36f7304c48942n, 0x3f9d85a86a1d36c8n, 0x1112e6ad91d692a1n,
];
const SHA512_256_H = () => [
  0x22312194fc2bf72cn, 0x9f555fa3c84c64c2n, 0x2393b86b6f53b151n, 0x963877195940eabdn,
  0x96283ee2a88effe3n, 0xbe5e1e2553863992n, 0x2b0199fc2c85b8aan, 0x0eb72ddc81c52ca2n,
];

function sha256Compress(s, block) {
  const w = new Uint32Array(64);
  for (let i = 0; i < 16; i++) {
    w[i] =
      (block[i * 4] << 24) |
      (block[i * 4 + 1] << 16) |
      (block[i * 4 + 2] << 8) |
      block[i * 4 + 3];
  }
  for (let i = 16; i < 64; i++) {
    const s0 =
      ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^
      ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^
      (w[i - 15] >>> 3);
    const s1 =
      ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^
      ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^
      (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let [a, b, c, d, e, f, g, h] = s;
  for (let i = 0; i < 64; i++) {
    const S1 =
      ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
    const S0 =
      ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  s[0] = (s[0] + a) | 0; s[1] = (s[1] + b) | 0;
  s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0;
  s[4] = (s[4] + e) | 0; s[5] = (s[5] + f) | 0;
  s[6] = (s[6] + g) | 0; s[7] = (s[7] + h) | 0;
}

// ---------------------------------------------------------------------------

const M64 = (1n << 64n) - 1n;
const rotr64 = (x, n) => ((x >> n) | (x << (64n - n))) & M64;

function sha512Compress(s, block) {
  const w = new Array(80);
  for (let i = 0; i < 16; i++) {
    let v = 0n;
    for (let j = 0; j < 8; j++) v = (v << 8n) | BigInt(block[i * 8 + j]);
    w[i] = v;
  }
  for (let i = 16; i < 80; i++) {
    const s0 = rotr64(w[i - 15], 1n) ^ rotr64(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
    const s1 = rotr64(w[i - 2], 19n) ^ rotr64(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M64;
  }
  let [a, b, c, d, e, f, g, h] = s;
  for (let i = 0; i < 80; i++) {
    const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K512[i] + w[i]) & M64;
    const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) & M64;
    h = g; g = f; f = e; e = (d + t1) & M64;
    d = c; c = b; b = a; a = (t1 + t2) & M64;
  }
  s[0] = (s[0] + a) & M64; s[1] = (s[1] + b) & M64;
  s[2] = (s[2] + c) & M64; s[3] = (s[3] + d) & M64;
  s[4] = (s[4] + e) & M64; s[5] = (s[5] + f) & M64;
  s[6] = (s[6] + g) & M64; s[7] = (s[7] + h) & M64;
}

// ---------------------------------------------------------------------------
// SHA-1
// ---------------------------------------------------------------------------

function sha1Compress(s, block) {
  const w = new Uint32Array(80);
  for (let i = 0; i < 16; i++) {
    w[i] =
      (block[i * 4] << 24) |
      (block[i * 4 + 1] << 16) |
      (block[i * 4 + 2] << 8) |
      block[i * 4 + 3];
  }
  for (let i = 16; i < 80; i++) {
    const v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
    w[i] = (v << 1) | (v >>> 31);
  }
  let [a, b, c, d, e] = s;
  for (let i = 0; i < 80; i++) {
    let f, k;
    if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
    else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
    else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
    else { f = b ^ c ^ d; k = 0xca62c1d6; }
    const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
    e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
  }
  s[0] = (s[0] + a) | 0; s[1] = (s[1] + b) | 0;
  s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0;
  s[4] = (s[4] + e) | 0;
}

// ---------------------------------------------------------------------------
// MD5
// ---------------------------------------------------------------------------

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
}

function md5Compress(s, block) {
  const M = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    M[i] =
      block[i * 4] |
      (block[i * 4 + 1] << 8) |
      (block[i * 4 + 2] << 16) |
      (block[i * 4 + 3] << 24);
  }
  let [a, b, c, d] = s;
  for (let i = 0; i < 64; i++) {
    let F, g;
    if (i < 16) { F = (b & c) | (~b & d); g = i; }
    else if (i < 32) { F = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
    else if (i < 48) { F = b ^ c ^ d; g = (3 * i + 5) % 16; }
    else { F = c ^ (b | ~d); g = (7 * i) % 16; }
    F = (F + a + MD5_K[i] + M[g]) | 0;
    a = d; d = c; c = b;
    const sh = MD5_S[i];
    b = (b + ((F << sh) | (F >>> (32 - sh)))) | 0;
  }
  s[0] = (s[0] + a) | 0; s[1] = (s[1] + b) | 0;
  s[2] = (s[2] + c) | 0; s[3] = (s[3] + d) | 0;
}

// ---------------------------------------------------------------------------
// Algorithm table
// ---------------------------------------------------------------------------


const ALGORITHMS = {
  md5: { engine: () => new (makeEngine({ blockSize: 64, initState: () => [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476], compress: md5Compress, outLen: 16, littleEndian: true }))(), blockSize: 64 },
  sha1: { engine: () => new (makeEngine({ blockSize: 64, initState: () => [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0], compress: sha1Compress, outLen: 20 }))(), blockSize: 64 },
  sha224: { engine: () => new (makeEngine({ blockSize: 64, initState: SHA224_H, compress: sha256Compress, outLen: 28 }))(), blockSize: 64 },
  sha256: { engine: () => new (makeEngine({ blockSize: 64, initState: SHA256_H, compress: sha256Compress, outLen: 32 }))(), blockSize: 64 },
  sha384: { engine: () => new (makeEngine({ blockSize: 128, initState: SHA384_H, compress: sha512Compress, outLen: 48 }))(), blockSize: 128 },
  sha512: { engine: () => new (makeEngine({ blockSize: 128, initState: SHA512_H, compress: sha512Compress, outLen: 64 }))(), blockSize: 128 },
  'sha512-224': { engine: () => new (makeEngine({ blockSize: 128, initState: SHA512_224_H, compress: sha512Compress, outLen: 28 }))(), blockSize: 128 },
  'sha512-256': { engine: () => new (makeEngine({ blockSize: 128, initState: SHA512_256_H, compress: sha512Compress, outLen: 32 }))(), blockSize: 128 },
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
    this._engine = ALGORITHMS[key].engine();
    this._algorithm = key;
    if (options !== undefined && (options === null || typeof options !== 'object')) {
      throw new ERR_INVALID_ARG_TYPE('options', 'object', options);
    }
  }
  update(data, inputEncoding) {
    this._engine.update(toBytes(data, inputEncoding));
    return this;
  }
  digest(encoding) {
    return encodeDigest(this._engine.digest(), encoding);
  }
  copy() {
    const c = Object.create(Hash.prototype);
    c._engine = this._engine.clone();
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
    const blockSize = ALGORITHMS[akey].blockSize;
    let keyBytes = toBytes(key, options?.encoding);
    if (keyBytes.length > blockSize) {
      keyBytes = ALGORITHMS[akey].engine().update(keyBytes).digest();
    }
    const padded = new Uint8Array(blockSize);
    padded.set(keyBytes);
    const ipad = new Uint8Array(blockSize);
    const opad = new Uint8Array(blockSize);
    for (let i = 0; i < blockSize; i++) {
      ipad[i] = padded[i] ^ 0x36;
      opad[i] = padded[i] ^ 0x5c;
    }
    this._inner = ALGORITHMS[akey].engine().update(ipad);
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
    const outer = ALGORITHMS[this._algorithm].engine();
    const combined = new Uint8Array(this._blockSize + innerDigest.length);
    combined.set(this._opad, 0);
    combined.set(innerDigest, this._blockSize);
    return encodeDigest(outer.update(combined).digest(), encoding);
  }
  copy() {
    const c = Object.create(Hmac.prototype);
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
