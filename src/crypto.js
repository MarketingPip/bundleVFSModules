/*!
 * crypto-web — node:crypto for browsers & bundlers.
 *
 * Faithful ESM port of Node.js v24.20.0 `lib/crypto.js` surface.
 * Dependency-free, browser-safe.
 *
 * Design — two layers (same pattern as the repo's `os` port):
 *  1. Native bridge: when running under genuine Node (detected via
 *     `process.getBuiltinModule`), every export delegates to the real
 *     builtin, so behavior — including OpenSSL-backed ciphers, key
 *     objects, X.509, DH/ECDH, scrypt/argon2 — is identical to Node.
 *  2. Browser fallback: dependency-free pure-JS implementations for the
 *     deterministic parts (hashes, HMAC, HKDF/PBKDF2, randomness), the
 *     platform WebCrypto `subtle`/`webcrypto` where available, and
 *     explicit, honest "requires OpenSSL" errors for everything else.
 *     `process.getBuiltinModule` never enters a browser bundle as
 *     anything but a guarded, undefined lookup.
 *
 * Fallback coverage (browser):
 *  - randomBytes / randomFill / randomFillSync / randomInt /
 *    randomUUID / randomUUIDv7 / timingSafeEqual / getRandomValues
 *  - createHash / createHmac / hash / Hash / Hmac
 *    (md5, sha1, sha224, sha256, sha384, sha512, sha512-224, sha512-256)
 *  - pbkdf2 / pbkdf2Sync / hkdf / hkdfSync (HMAC-based, RFC 2898/5869)
 *  - getHashes / getCiphers ([]) / getCurves ([]) / getCipherInfo
 *    (undefined) / getFips (0) / secureHeapUsed (zeros)
 *  - webcrypto / subtle from the platform when available
 *  - prng / pseudoRandomBytes / rng (deprecated aliases of randomBytes)
 *
 * Everything OpenSSL-only (ciphers, DiffieHellman/ECDH, Sign/Verify,
 * KeyObject, X509Certificate, Certificate, scrypt, argon2, generateKey*,
 * publicEncrypt/privateDecrypt, encapsulate/decapsulate, setEngine,
 * setFips, checkPrime, generatePrime) throws a clear error naming the
 * missing OpenSSL backing instead of silently misbehaving.
 */

import {
  createHash as _createHash,
  createHmac as _createHmac,
  hash as _hash,
  Hash as _Hash,
  Hmac as _Hmac,
} from './crypto/hashes.js';
import {
  getRandomValues as _getRandomValues,
  randomBytes as _randomBytes,
  randomFill as _randomFill,
  randomFillSync as _randomFillSync,
  randomInt as _randomInt,
  randomUUID as _randomUUID,
  randomUUIDv7 as _randomUUIDv7,
  timingSafeEqual as _timingSafeEqual,
} from './crypto/random.js';
import {
  ERR_INVALID_ARG_TYPE,
  ERR_OUT_OF_RANGE,
  unsupportedCrypto,
} from './crypto/errors.js';
import { Buffer as PolyBuffer } from './buffer.js';

// ---------------------------------------------------------------------------
// Native bridge detection (browser-safe).
// ---------------------------------------------------------------------------

function getBuiltinModuleSafe(name) {
  try {
    if (
      typeof process !== 'undefined' &&
      process !== null &&
      typeof process.getBuiltinModule === 'function'
    ) {
      return process.getBuiltinModule(name);
    }
  } catch {
    /* not genuine Node — fall through to the pure-JS fallback */
  }
  return undefined;
}

const native = getBuiltinModuleSafe('crypto');

// ---------------------------------------------------------------------------
// Browser fallback pieces beyond hashes.js / random.js.
// ---------------------------------------------------------------------------

const FALLBACK_HASHES = Object.freeze([
  'md5',
  'sha1',
  'sha224',
  'sha256',
  'sha384',
  'sha512',
  'sha512-224',
  'sha512-256',
]);

function toBytesCompat(data, name) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer || data instanceof SharedArrayBuffer) {
    return new Uint8Array(data);
  }
  throw new ERR_INVALID_ARG_TYPE(name, 'string|Uint8Array|ArrayBufferView', data);
}

/** RFC 5869 HKDF-Extract + HKDF-Expand, HMAC-based (sync core). */
function hkdfSyncFallback(digest, ikm, salt, info, keylen) {
  if (typeof digest !== 'string')
    throw new ERR_INVALID_ARG_TYPE('digest', 'string', digest);
  const ikmB = toBytesCompat(ikm, 'ikm');
  const saltB =
    salt === undefined || salt === null || (salt instanceof Uint8Array && salt.length === 0)
      ? new Uint8Array(32)
      : toBytesCompat(salt, 'salt');
  const infoB = info === undefined || info === null ? new Uint8Array(0) : toBytesCompat(info, 'info');
  if (!Number.isInteger(keylen) || keylen < 0)
    throw new ERR_OUT_OF_RANGE('keylen', '>= 0', keylen);
  // Extract
  const prk = _createHmac(digest, saltB).update(ikmB).digest();
  // Expand
  const hashLen = prk.length;
  if (keylen > 255 * hashLen) throw new ERR_OUT_OF_RANGE('keylen', `<= ${255 * hashLen}`, keylen);
  const n = Math.ceil(keylen / hashLen);
  let t = new Uint8Array(0);
  const okm = new Uint8Array(keylen);
  let offset = 0;
  for (let i = 1; i <= n; i++) {
    const h = _createHmac(digest, prk);
    h.update(t);
    h.update(infoB);
    h.update(new Uint8Array([i]));
    t = h.digest();
    const take = Math.min(t.length, keylen - offset);
    okm.set(t.subarray(0, take), offset);
    offset += take;
  }
  return okm.buffer.slice(0, keylen);
}

/** RFC 2898 PBKDF2, HMAC-based (sync core). */
function pbkdf2SyncFallback(password, salt, iterations, keylen, digest) {
  const passB = toBytesCompat(password, 'password');
  const saltB = toBytesCompat(salt, 'salt');
  if (!Number.isInteger(iterations) || iterations < 1)
    throw new ERR_OUT_OF_RANGE('iterations', '>= 1', iterations);
  if (!Number.isInteger(keylen) || keylen < 0)
    throw new ERR_OUT_OF_RANGE('keylen', '>= 0', keylen);
  const dk = new Uint8Array(keylen);
  const hashLen = _createHmac(digest, passB).digest().length;
  const blocks = Math.ceil(keylen / hashLen);
  let offset = 0;
  for (let block = 1; block <= blocks; block++) {
    const saltBlock = new Uint8Array(saltB.length + 4);
    saltBlock.set(saltB, 0);
    saltBlock[saltB.length] = (block >>> 24) & 0xff;
    saltBlock[saltB.length + 1] = (block >>> 16) & 0xff;
    saltBlock[saltB.length + 2] = (block >>> 8) & 0xff;
    saltBlock[saltB.length + 3] = block & 0xff;
    let u = _createHmac(digest, passB).update(saltBlock).digest();
    const t = u.slice();
    for (let i = 1; i < iterations; i++) {
      u = _createHmac(digest, passB).update(u).digest();
      for (let j = 0; j < t.length; j++) t[j] ^= u[j];
    }
    const take = Math.min(t.length, keylen - offset);
    dk.set(t.subarray(0, take), offset);
    offset += take;
  }
  return PolyBuffer.from(dk);
}

function asyncWrap(fn) {
  return (...args) => {
    const cb = args[args.length - 1];
    if (typeof cb !== 'function')
      throw new ERR_INVALID_ARG_TYPE('callback', 'function', cb);
    const params = args.slice(0, -1);
    const run =
      typeof queueMicrotask === 'function'
        ? queueMicrotask
        : (f) => setTimeout(f, 0);
    run(() => {
      let result;
      try {
        result = fn(...params);
      } catch (err) {
        cb(err);
        return;
      }
      cb(null, result);
    });
  };
}

const _pbkdf2Fallback = asyncWrap(pbkdf2SyncFallback);
const _hkdfFallback = asyncWrap(hkdfSyncFallback);

function makeUnsupported(name) {
  const fn = function () {
    throw unsupportedCrypto(name);
  };
  try {
    Object.defineProperty(fn, 'name', { value: name, configurable: true });
  } catch {
    /* ignore */
  }
  return fn;
}

const _platformWebCrypto =
  typeof globalThis !== 'undefined' && globalThis.crypto ? globalThis.crypto : undefined;

// ---------------------------------------------------------------------------
// Export table — native under genuine Node, fallback otherwise.
// Static `export const` bindings keep bundlers tree-shakeable.
// ---------------------------------------------------------------------------

const pick = (name, fallback) => (native ? native[name] : fallback);

export const Certificate = pick('Certificate', makeUnsupported('Certificate'));
export const Cipheriv = pick('Cipheriv', makeUnsupported('Cipheriv'));
export const Decipheriv = pick('Decipheriv', makeUnsupported('Decipheriv'));
export const DiffieHellman = pick('DiffieHellman', makeUnsupported('DiffieHellman'));
export const DiffieHellmanGroup = pick('DiffieHellmanGroup', makeUnsupported('DiffieHellmanGroup'));
export const ECDH = pick('ECDH', makeUnsupported('ECDH'));
export const Hash = pick('Hash', _Hash);
export const Hmac = pick('Hmac', _Hmac);
export const KeyObject = pick('KeyObject', makeUnsupported('KeyObject'));
export const Sign = pick('Sign', makeUnsupported('Sign'));
export const Verify = pick('Verify', makeUnsupported('Verify'));
export const X509Certificate = pick('X509Certificate', makeUnsupported('X509Certificate'));

export const argon2 = pick('argon2', makeUnsupported('argon2'));
export const argon2Sync = pick('argon2Sync', makeUnsupported('argon2Sync'));
export const checkPrime = pick('checkPrime', makeUnsupported('checkPrime'));
export const checkPrimeSync = pick('checkPrimeSync', makeUnsupported('checkPrimeSync'));
export const constants = pick('constants', Object.freeze({}));
export const createCipheriv = pick('createCipheriv', makeUnsupported('createCipheriv'));
export const createDecipheriv = pick('createDecipheriv', makeUnsupported('createDecipheriv'));
export const createDiffieHellman = pick(
  'createDiffieHellman',
  makeUnsupported('createDiffieHellman'),
);
export const createDiffieHellmanGroup = pick(
  'createDiffieHellmanGroup',
  makeUnsupported('createDiffieHellmanGroup'),
);
export const createECDH = pick('createECDH', makeUnsupported('createECDH'));
export const createHash = pick('createHash', _createHash);
export const createHmac = pick('createHmac', _createHmac);
export const createPrivateKey = pick('createPrivateKey', makeUnsupported('createPrivateKey'));
export const createPublicKey = pick('createPublicKey', makeUnsupported('createPublicKey'));
export const createSecretKey = pick('createSecretKey', makeUnsupported('createSecretKey'));
export const createSign = pick('createSign', makeUnsupported('createSign'));
export const createVerify = pick('createVerify', makeUnsupported('createVerify'));
export const decapsulate = pick('decapsulate', makeUnsupported('decapsulate'));
export const diffieHellman = pick('diffieHellman', makeUnsupported('diffieHellman'));
export const encapsulate = pick('encapsulate', makeUnsupported('encapsulate'));
export const generateKey = pick('generateKey', makeUnsupported('generateKey'));
export const generateKeyPair = pick('generateKeyPair', makeUnsupported('generateKeyPair'));
export const generateKeyPairSync = pick(
  'generateKeyPairSync',
  makeUnsupported('generateKeyPairSync'),
);
export const generateKeySync = pick('generateKeySync', makeUnsupported('generateKeySync'));
export const generatePrime = pick('generatePrime', makeUnsupported('generatePrime'));
export const generatePrimeSync = pick('generatePrimeSync', makeUnsupported('generatePrimeSync'));
export const getCipherInfo = pick('getCipherInfo', () => undefined);
export const getCiphers = pick('getCiphers', () => []);
export const getCurves = pick('getCurves', () => []);
export const getDiffieHellman = pick('getDiffieHellman', makeUnsupported('getDiffieHellman'));
export const getFips = pick('getFips', () => 0);
export const getHashes = pick('getHashes', () => [...FALLBACK_HASHES]);
export const getRandomValues = pick('getRandomValues', _getRandomValues);
export const hash = pick('hash', _hash);
export const hkdf = pick('hkdf', _hkdfFallback);
export const hkdfSync = pick('hkdfSync', hkdfSyncFallback);
export const pbkdf2 = pick('pbkdf2', _pbkdf2Fallback);
export const pbkdf2Sync = pick('pbkdf2Sync', pbkdf2SyncFallback);
export const privateDecrypt = pick('privateDecrypt', makeUnsupported('privateDecrypt'));
export const privateEncrypt = pick('privateEncrypt', makeUnsupported('privateEncrypt'));
export const publicDecrypt = pick('publicDecrypt', makeUnsupported('publicDecrypt'));
export const publicEncrypt = pick('publicEncrypt', makeUnsupported('publicEncrypt'));
export const randomBytes = pick('randomBytes', _randomBytes);
export const randomFill = pick('randomFill', _randomFill);
export const randomFillSync = pick('randomFillSync', _randomFillSync);
export const randomInt = pick('randomInt', _randomInt);
export const randomUUID = pick('randomUUID', _randomUUID);
export const randomUUIDv7 = pick('randomUUIDv7', _randomUUIDv7);
export const scrypt = pick('scrypt', makeUnsupported('scrypt'));
export const scryptSync = pick('scryptSync', makeUnsupported('scryptSync'));
export const secureHeapUsed = pick('secureHeapUsed', () => ({
  total: 0,
  used: 0,
  utilization: 0,
  min: 0,
}));
export const setEngine = pick('setEngine', makeUnsupported('setEngine'));
export const setFips = pick('setFips', makeUnsupported('setFips'));
export const sign = pick('sign', makeUnsupported('sign'));
export const subtle = pick('subtle', _platformWebCrypto ? _platformWebCrypto.subtle : undefined);
export const timingSafeEqual = pick('timingSafeEqual', _timingSafeEqual);
export const verify = pick('verify', makeUnsupported('verify'));
export const webcrypto = pick('webcrypto', _platformWebCrypto);

// Deprecated aliases (Node: same function object as randomBytes). Kept as
// locals for the default export only — real node:crypto does NOT expose them
// as named ESM exports.
const prng = native ? native.prng : _randomBytes;
const pseudoRandomBytes = native ? native.pseudoRandomBytes : _randomBytes;
const rng = native ? native.rng : _randomBytes;

const defaultExport = {
  Certificate,
  Cipheriv,
  Decipheriv,
  DiffieHellman,
  DiffieHellmanGroup,
  ECDH,
  Hash,
  Hmac,
  KeyObject,
  Sign,
  Verify,
  X509Certificate,
  argon2,
  argon2Sync,
  checkPrime,
  checkPrimeSync,
  constants,
  createCipheriv,
  createDecipheriv,
  createDiffieHellman,
  createDiffieHellmanGroup,
  createECDH,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  createSign,
  createVerify,
  decapsulate,
  diffieHellman,
  encapsulate,
  generateKey,
  generateKeyPair,
  generateKeyPairSync,
  generateKeySync,
  generatePrime,
  generatePrimeSync,
  getCipherInfo,
  getCiphers,
  getCurves,
  getDiffieHellman,
  getFips,
  getHashes,
  getRandomValues,
  hash,
  hkdf,
  hkdfSync,
  pbkdf2,
  pbkdf2Sync,
  privateDecrypt,
  privateEncrypt,
  publicDecrypt,
  publicEncrypt,
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  randomUUID,
  randomUUIDv7,
  scrypt,
  scryptSync,
  secureHeapUsed,
  setEngine,
  setFips,
  sign,
  subtle,
  timingSafeEqual,
  verify,
  webcrypto,
};

// Deprecated aliases: present on require('crypto') in real Node as
// non-enumerable, configurable own properties (asserted by
// test-crypto-random.js), so define them the same way here.
for (const [aliasName, aliasFn] of [
  ['prng', prng],
  ['pseudoRandomBytes', pseudoRandomBytes],
  ['rng', rng],
]) {
  Object.defineProperty(defaultExport, aliasName, {
    value: aliasFn,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

export default defaultExport;
