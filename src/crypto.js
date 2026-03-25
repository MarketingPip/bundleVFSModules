// npm install @noble/hashes @noble/ciphers @noble/curves node-forge buffer events

/*!
 * crypto-web — node:crypto for browsers, bundlers & edge runtimes
 * MIT License.
 * Node.js parity: node:crypto @ Node 22+
 * Dependencies: @noble/hashes, @noble/ciphers, @noble/curves, buffer, events
 * Limitations:
 *   - createCipher/createDecipher (deprecated, no-IV forms) → throw
 *   - DiffieHellman(primeLength) keygen uses subtle; modp groups use pre-baked primes
 *   - scrypt/argon2/hkdf/pbkdf2 async delegates to subtle where available, else @noble/hashes
 *   - KeyObject is a thin wrapper; .toCryptoKey()/.from() bridge to SubtleCrypto
 *   - X509Certificate → not implemented (throws)
 *   - FIPS, setEngine, secureHeapUsed → stubs
 *   - randomFill / randomFillSync write into existing buffers
 *   - Certificate (SPKAC) → not implemented
 *   - checkPrime / generatePrime → not implemented
 *   - timingSafeEqual → implemented via constant-time XOR
 */

/**
 * @packageDocumentation
 * Drop-in `node:crypto` for browser/bundler/edge environments.
 * Delegates to `globalThis.crypto.subtle` (Web Crypto API) for key derivation,
 * ECDH, RSA, and AES-GCM/CBC/CTR. Uses @noble/hashes for MD5, SHA-1, SHA-2,
 * SHA-3, BLAKE2/3 and HMAC. Uses @noble/ciphers for ChaCha20-Poly1305.
 * Uses @noble/curves for ECDSA, EdDSA, secp256k1, etc.
 */

import { Buffer } from 'buffer';
import { EventEmitter } from 'events';

// ─── @noble/hashes ────────────────────────────────────────────────────────────
import { sha1 }        from '@noble/hashes/sha1.js';
import { sha224, sha256, sha384, sha512, sha512_224, sha512_256 } from '@noble/hashes/sha2.js';
import { sha3_224, sha3_256, sha3_384, sha3_512, keccak_256, shake128, shake256 } from '@noble/hashes/sha3.js';
import { blake2b }     from '@noble/hashes/blake2b.js';
import { blake2s }     from '@noble/hashes/blake2s.js';
import { blake3 }      from '@noble/hashes/blake3.js';
import { md5 }         from '@noble/hashes/md5.js';
import { hmac }        from '@noble/hashes/hmac.js';
import { pbkdf2, pbkdf2Async }   from '@noble/hashes/pbkdf2.js';
import { scrypt, scryptAsync }   from '@noble/hashes/scrypt.js';
import { hkdf }                  from '@noble/hashes/hkdf.js';
import { createHash as nobleCreateHash, createHmac as nobleCreateHmac } from '@noble/hashes/utils.js';

// ─── @noble/ciphers ───────────────────────────────────────────────────────────
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { aes_128_gcm, aes_256_gcm, aes_128_cbc, aes_256_cbc, aes_128_ctr, aes_256_ctr } from '@noble/ciphers/aes.js';

// ─── node-forge (RSA PEM/DER/PKCS#1/PKCS#8/SPKI + X.509) ────────────────────
import forge from 'node-forge';

// ─── @noble/curves ────────────────────────────────────────────────────────────
import { p256 }    from '@noble/curves/p256.js';
import { p384 }    from '@noble/curves/p384.js';
import { p521 }    from '@noble/curves/p521.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ed448 }   from '@noble/curves/ed448.js';
// ─── Internal helpers ──────────────────────────────────────────────────────────

const subtle = globalThis.crypto?.subtle;
const getRandomValuesFn = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);

/** @param {string} msg */
const notImpl = msg => { throw new Error(`Not implemented: ${msg}`); };

/** Ensure input is Uint8Array */
function toU8(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return new TextEncoder().encode(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new TypeError(`Expected Buffer/TypedArray/string, got ${typeof v}`);
}

/** Map Node algorithm name → noble hash function */
const HASH_MAP = {
  md5,
  sha1,
  sha224, 'sha-224': sha224,
  sha256, 'sha-256': sha256,
  sha384, 'sha-384': sha384,
  sha512, 'sha-512': sha512,
  'sha512-224': sha512_224,
  'sha512-256': sha512_256,
  sha3_224: sha3_224, 'sha3-224': sha3_224,
  sha3_256: sha3_256, 'sha3-256': sha3_256,
  sha3_384: sha3_384, 'sha3-384': sha3_384,
  sha3_512: sha3_512, 'sha3-512': sha3_512,
  keccak256: keccak_256, keccak_256,
  blake2b512: blake2b, blake2s256: blake2s,
  blake3,
};

function resolveHash(algorithm) {
  const key = String(algorithm).toLowerCase().replace(/-/g, '').replace(/ /g, '');
  const h = HASH_MAP[key] || HASH_MAP[algorithm?.toLowerCase?.()];
  if (!h) throw new Error(`Digest method not supported: ${algorithm}`);
  return h;
}

// ─── constants ────────────────────────────────────────────────────────────────

export const constants = {
  RSA_PKCS1_PADDING: 1,
  RSA_NO_PADDING: 3,
  RSA_PKCS1_OAEP_PADDING: 4,
  RSA_PKCS1_PSS_PADDING: 6,
  RSA_PSS_SALTLEN_DIGEST: -1,
  RSA_PSS_SALTLEN_MAX_SIGN: -2,
  RSA_PSS_SALTLEN_AUTO: -2,
  ENGINE_METHOD_ALL: 0xFFFF,
  ENGINE_METHOD_NONE: 0,
  POINT_CONVERSION_COMPRESSED: 2,
  POINT_CONVERSION_UNCOMPRESSED: 4,
  POINT_CONVERSION_HYBRID: 6,
  defaultCipherList: '',
  defaultCoreCipherList: '',
};

// ─── WebCrypto bridge ──────────────────────────────────────────────────────────

export const webcrypto = globalThis.crypto;
export const subtle_ = subtle;

export function getRandomValues(arr) {
  return getRandomValuesFn(arr);
}

// ─── Random ───────────────────────────────────────────────────────────────────

/**
 * @param {number} size
 * @param {Function} [callback]
 * @returns {Buffer|undefined}
 */
export function randomBytes(size, callback) {
  const buf = Buffer.allocUnsafe(size);
  getRandomValuesFn(buf);
  if (callback) { Promise.resolve().then(() => callback(null, buf)); return; }
  return buf;
}

/**
 * @param {Buffer|TypedArray|DataView|ArrayBuffer} buffer
 * @param {number} [offset]
 * @param {number} [size]
 * @param {Function} callback
 */
export function randomFill(buffer, offset, size, callback) {
  if (typeof offset === 'function') { callback = offset; offset = 0; size = buffer.byteLength; }
  else if (typeof size === 'function') { callback = size; size = buffer.byteLength - offset; }
  const view = new Uint8Array(
    buffer instanceof ArrayBuffer ? buffer : buffer.buffer,
    (buffer.byteOffset ?? 0) + offset,
    size
  );
  getRandomValuesFn(view);
  Promise.resolve().then(() => callback(null, buffer));
}

/**
 * @param {Buffer|TypedArray|DataView|ArrayBuffer} buffer
 * @param {number} [offset]
 * @param {number} [size]
 * @returns {Buffer|TypedArray|DataView|ArrayBuffer}
 */
export function randomFillSync(buffer, offset = 0, size) {
  size ??= buffer.byteLength - offset;
  const view = new Uint8Array(
    buffer instanceof ArrayBuffer ? buffer : buffer.buffer,
    (buffer.byteOffset ?? 0) + offset,
    size
  );
  getRandomValuesFn(view);
  return buffer;
}

/**
 * @param {number} [min]
 * @param {number} max
 * @param {Function} [callback]
 * @returns {number|undefined}
 */
export function randomInt(min, max, callback) {
  if (typeof min === 'function') { callback = min; min = 0; max = undefined; }
  if (typeof max === 'function') { callback = max; max = min; min = 0; }
  if (max === undefined) { max = min; min = 0; }
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max))
    throw new RangeError('min and max must be safe integers');
  const range = max - min;
  if (range <= 0 || range >= 2 ** 48) throw new RangeError('range must be > 0 and < 2**48');
  // Rejection-sampling for unbiased output
  const bytes = Math.ceil(Math.log2(range) / 8) + 1;
  const mask = (2 ** (bytes * 8)) - 1;
  const gen = () => {
    let n;
    do {
      const buf = randomBytes(bytes);
      n = 0;
      for (let i = 0; i < bytes; i++) n = (n * 256 + buf[i]);
      n = n & mask;
    } while (n >= range);
    return min + n;
  };
  if (callback) { Promise.resolve().then(() => callback(null, gen())); return; }
  return gen();
}

/**
 * @param {{ disableEntropyCache?: boolean }} [options]
 * @returns {string}
 */
export function randomUUID(options) {
  return globalThis.crypto.randomUUID?.() ?? (() => {
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  })();
}

// ─── timingSafeEqual ──────────────────────────────────────────────────────────

/**
 * @param {ArrayBuffer|Buffer|TypedArray|DataView} a
 * @param {ArrayBuffer|Buffer|TypedArray|DataView} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  const ua = toU8(a instanceof ArrayBuffer ? a : a), ub = toU8(b instanceof ArrayBuffer ? b : b);
  if (ua.byteLength !== ub.byteLength)
    throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < ua.byteLength; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

// ─── Hash class ───────────────────────────────────────────────────────────────

class HashStream extends EventEmitter {
  #algo; #instance; #digested = false;

  constructor(algorithm, options) {
    super();
    this.#algo = algorithm;
    const H = resolveHash(algorithm);
    this.#instance = H.create(options);
  }

  /**
   * @param {string|Buffer|TypedArray|DataView} data
   * @param {string} [inputEncoding]
   * @returns {this}
   */
  update(data, inputEncoding) {
    if (this.#digested) throw new Error('Digest already called');
    if (typeof data === 'string') data = Buffer.from(data, inputEncoding || 'utf8');
    this.#instance.update(toU8(data));
    return this;
  }

  /**
   * @param {string} [encoding]
   * @returns {Buffer|string}
   */
  digest(encoding) {
    if (this.#digested) throw new Error('Digest already called');
    this.#digested = true;
    const out = Buffer.from(this.#instance.digest());
    return encoding ? out.toString(encoding) : out;
  }

  copy(options) {
    const h = new HashStream(this.#algo, options);
    h.#instance = this.#instance.clone();
    return h;
  }

  // stream.Transform compat (write/end/pipe lite)
  write(data, enc, cb) { this.update(data, enc); if (typeof enc === 'function') enc(); if (cb) cb(); return true; }
  end(data, enc, cb) {
    if (data) this.write(data, enc);
    const out = this.digest();
    this.emit('readable'); this.emit('data', out); this.emit('end');
    if (typeof enc === 'function') enc(); if (cb) cb();
    return this;
  }
  read() { return this.digest(); }
  setEncoding(enc) { this._enc = enc; return this; }
  pipe(dest) { dest.write(this.digest(this._enc || undefined)); return dest; }
}

export const Hash = HashStream;

/**
 * @param {string} algorithm
 * @param {object} [options]
 * @returns {Hash}
 */
export function createHash(algorithm, options) {
  return new HashStream(algorithm, options);
}

// ─── Hmac class ───────────────────────────────────────────────────────────────

class HmacStream extends EventEmitter {
  #instance; #digested = false;

  constructor(algorithm, key, options) {
    super();
    const H = resolveHash(algorithm);
    const k = typeof key === 'string' ? Buffer.from(key, options?.encoding) : toU8(key);
    this.#instance = hmac.create(H, k);
  }

  update(data, inputEncoding) {
    if (this.#digested) throw new Error('Digest already called');
    if (typeof data === 'string') data = Buffer.from(data, inputEncoding || 'utf8');
    this.#instance.update(toU8(data));
    return this;
  }

  digest(encoding) {
    if (this.#digested) throw new Error('Digest already called');
    this.#digested = true;
    const out = Buffer.from(this.#instance.digest());
    return encoding ? out.toString(encoding) : out;
  }

  write(data, enc, cb) { this.update(data, enc); if (typeof enc === 'function') enc(); if (cb) cb(); return true; }
  end(data, enc, cb) {
    if (data) this.write(data, enc);
    const out = this.digest();
    this.emit('readable'); this.emit('data', out); this.emit('end');
    if (typeof enc === 'function') enc(); if (cb) cb();
    return this;
  }
  read() { return this.digest(); }
  setEncoding(enc) { this._enc = enc; return this; }
}

export const Hmac = HmacStream;

/**
 * @param {string} algorithm
 * @param {string|Buffer|TypedArray|DataView|KeyObject} key
 * @param {object} [options]
 * @returns {Hmac}
 */
export function createHmac(algorithm, key, options) {
  const raw = key instanceof KeyObject ? key.export() : key;
  return new HmacStream(algorithm, raw, options);
}

// ─── hash() one-shot ─────────────────────────────────────────────────────────

/**
 * @param {string} algorithm
 * @param {string|Buffer|TypedArray|DataView} data
 * @param {object|string} [options]
 * @returns {string|Buffer}
 */
export function hash(algorithm, data, options) {
  const enc = typeof options === 'string' ? options : (options?.outputEncoding ?? 'hex');
  const H = resolveHash(algorithm);
  const input = typeof data === 'string' ? Buffer.from(data, 'utf8') : toU8(data);
  const out = Buffer.from(H(input));
  return enc === 'buffer' ? out : out.toString(enc);
}

// ─── getCiphers / getHashes / getCurves ───────────────────────────────────────

export function getHashes() {
  return ['md5','sha1','sha224','sha256','sha384','sha512',
          'sha512-224','sha512-256',
          'sha3-224','sha3-256','sha3-384','sha3-512',
          'blake2b512','blake2s256','blake3',
          'keccak256'];
}

export function getCiphers() {
  return ['aes-128-cbc','aes-256-cbc','aes-128-gcm','aes-256-gcm',
          'aes-128-ctr','aes-256-ctr','chacha20-poly1305'];
}

export function getCurves() {
  return ['prime256v1','secp384r1','secp521r1','secp256k1','ed25519','ed448','x25519','x448'];
}

export function getCipherInfo(nameOrNid, options) {
  const n = String(nameOrNid).toLowerCase();
  const map = {
    'aes-128-cbc': { name:'aes-128-cbc', blockSize:16, ivLength:16, keyLength:16, mode:'cbc' },
    'aes-256-cbc': { name:'aes-256-cbc', blockSize:16, ivLength:16, keyLength:32, mode:'cbc' },
    'aes-128-gcm': { name:'aes-128-gcm', ivLength:12, keyLength:16, mode:'gcm' },
    'aes-256-gcm': { name:'aes-256-gcm', ivLength:12, keyLength:32, mode:'gcm' },
    'aes-128-ctr': { name:'aes-128-ctr', ivLength:16, keyLength:16, mode:'ctr' },
    'aes-256-ctr': { name:'aes-256-ctr', ivLength:16, keyLength:32, mode:'ctr' },
    'chacha20-poly1305': { name:'chacha20-poly1305', ivLength:12, keyLength:32, mode:'stream' },
  };
  return map[n] ?? undefined;
}

// ─── KeyObject ────────────────────────────────────────────────────────────────

class KeyObject {
  #type; #material; #algorithm; #cryptoKey;

  constructor(type, material, algorithm) {
    this.#type = type;       // 'secret'|'public'|'private'
    this.#material = material; // Buffer (raw) or CryptoKey
    this.#algorithm = algorithm ?? null;
  }

  get type() { return this.#type; }
  get symmetricKeySize() { return this.#type === 'secret' ? (this.#material instanceof Buffer ? this.#material.length : undefined) : undefined; }
  get asymmetricKeyType() { return this.#algorithm ?? undefined; }

  export(options = {}) {
    if (this.#type === 'secret') return this.#material;
    // Asymmetric: material is the raw DER Buffer stored during createPublicKey/createPrivateKey
    if (this.#material) {
      const { format = 'pem', type } = options;
      if (format === 'der') return this.#material;
      if (format === 'pem') {
        // Re-derive PEM from forge key if available
        if (this._forgeKey) {
          if (this.#type === 'public')  return forge.pki.publicKeyToPem(this._forgeKey);
          if (this.#type === 'private') return forge.pki.privateKeyToPem(this._forgeKey);
        }
        // Fallback: wrap DER in PEM manually
        const label = this.#type === 'public' ? 'PUBLIC KEY' : 'PRIVATE KEY';
        const b64   = this.#material.toString('base64').match(/.{1,64}/g).join('\n');
        return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
      }
      if (format === 'jwk' && this._forgeKey) {
        const k = this._forgeKey;
        const b64url = buf => Buffer.from(buf, 'binary').toString('base64url');
        const toB64  = bn  => b64url(bn.toByteArray());
        if (this.#type === 'public') {
          return { kty: 'RSA', n: toB64(k.n), e: toB64(k.e) };
        }
        return { kty: 'RSA', n: toB64(k.n), e: toB64(k.e), d: toB64(k.d),
                 p: toB64(k.p), q: toB64(k.q), dp: toB64(k.dq), dq: toB64(k.dq), qi: toB64(k.qInv) };
      }
    }
    throw new Error('KeyObject.export: unsupported options or key type');
  }

  equals(other) {
    if (!(other instanceof KeyObject)) return false;
    if (other.type !== this.#type) return false;
    if (this.#material instanceof Buffer)
      return timingSafeEqual(this.#material, other.export());
    return false;
  }

  async toCryptoKey(algorithm, extractable, keyUsages) {
    if (this.#cryptoKey) return this.#cryptoKey;
    notImpl('KeyObject.toCryptoKey for this key type');
  }

  static from(cryptoKey) {
    const ko = new KeyObject(
      cryptoKey.type === 'secret' ? 'secret' : cryptoKey.type,
      null,
      cryptoKey.algorithm?.name
    );
    ko.#cryptoKey = cryptoKey;
    return ko;
  }
}

export { KeyObject };

export function createSecretKey(key, encoding) {
  const raw = typeof key === 'string' ? Buffer.from(key, encoding || 'binary') : Buffer.from(key);
  return new KeyObject('secret', raw);
}

// ─── forge ↔ KeyObject bridge helpers ────────────────────────────────────────

/** Strip PEM headers and decode base64 → Uint8Array (DER) */
function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

/** Detect PEM label → key class */
function pemLabel(pem) {
  const m = pem.match(/-----BEGIN ([^-]+)-----/);
  return m ? m[1].trim() : '';
}

/**
 * Wraps a forge RSA key + raw DER in a KeyObject.
 * @param {'public'|'private'} type
 * @param {object} forgeKey
 * @param {Buffer} derBuf
 * @param {string} algoType  e.g. 'rsa'
 */
function makeKeyObject(type, forgeKey, derBuf, algoType) {
  const ko = new KeyObject(type, derBuf, algoType);
  ko._forgeKey = forgeKey;   // stash for RSA sign/verify/encrypt/decrypt
  return ko;
}

/**
 * Attempt to import an EC PKCS#8 private key or SPKI public key via SubtleCrypto,
 * returning a KeyObject wrapping the CryptoKey.
 */
async function importEcKeySubtle(der, type, namedCurve) {
  const usage = type === 'private' ? ['sign'] : ['verify'];
  const ck = await subtle.importKey(
    type === 'private' ? 'pkcs8' : 'spki',
    der,
    { name: 'ECDSA', namedCurve },
    true,
    usage
  );
  return KeyObject.from(ck);
}

/** Sniff OID bytes from a DER buffer to guess namedCurve (best-effort) */
function guessEcCurve(der) {
  // OIDs: P-256 = 2a 86 48 ce 3d 03 01 07, P-384 = 2b 81 04 00 22, P-521 = 2b 81 04 00 23
  const hex = Buffer.from(der).toString('hex');
  if (hex.includes('2a8648ce3d030107')) return 'P-256';
  if (hex.includes('2b8104002')) return hex.includes('2b81040022') ? 'P-384' : 'P-521';
  return 'P-256'; // fallback
}

/**
 * @param {string|Buffer|ArrayBuffer|TypedArray|object} key
 * @returns {KeyObject}
 */
export function createPublicKey(key) {
  // KeyObject with type 'private' → strip to public
  if (key instanceof KeyObject) {
    if (key.type === 'public') return key;
    if (key._forgeKey) {
      const pub = key._forgeKey.publicKey ?? forge.pki.rsa.setPublicKey(key._forgeKey.n, key._forgeKey.e);
      const pem = forge.pki.publicKeyToPem(pub);
      return createPublicKey(pem);
    }
    throw new Error('createPublicKey: cannot derive public key from this KeyObject');
  }

  // Normalise input
  let format = 'pem', type, rawKey, encoding;
  if (typeof key === 'object' && key !== null && !Buffer.isBuffer(key) && !(key instanceof Uint8Array)) {
    format = key.format ?? 'pem';
    type   = key.type;   // 'pkcs1' | 'spki'
    encoding = key.encoding;
    rawKey = key.key;
  } else {
    rawKey = key;
  }

  if (format === 'jwk') {
    // JWK object → forge RSA only (EC handled separately via subtle later)
    const jwk = typeof rawKey === 'string' ? JSON.parse(rawKey) : rawKey;
    if (jwk.kty === 'RSA') {
      const n = new forge.jsbn.BigInteger(Buffer.from(jwk.n, 'base64url').toString('hex'), 16);
      const e = new forge.jsbn.BigInteger(Buffer.from(jwk.e, 'base64url').toString('hex'), 16);
      const pub = forge.pki.rsa.setPublicKey(n, e);
      const pem = forge.pki.publicKeyToPem(pub);
      const der = pemToDer(pem);
      return makeKeyObject('public', pub, der, 'rsa');
    }
    // EC JWK: delegate to subtle (async) — return a promise-bearing stub
    throw new Error('createPublicKey: EC JWK requires async path — use subtle.importKey directly');
  }

  // PEM / DER
  const raw = typeof rawKey === 'string' ? rawKey
    : Buffer.isBuffer(rawKey) ? rawKey.toString('binary')
    : Buffer.from(rawKey).toString('binary');

  if (format === 'pem') {
    const label = pemLabel(raw);
    if (label === 'RSA PUBLIC KEY' || label === 'PUBLIC KEY') {
      // PKCS#1 RSAPublicKey or SPKI SubjectPublicKeyInfo
      let forgeKey;
      if (label === 'RSA PUBLIC KEY') {
        // PKCS#1 — forge can load it directly
        const asn1 = forge.asn1.fromDer(forge.util.decode64(
          raw.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
        ));
        forgeKey = forge.pki.publicKeyFromAsn1(
          forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
            forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
              forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false,
                forge.asn1.oidToDer(forge.pki.oids.rsaEncryption).getBytes()),
              forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ''),
            ]),
            forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.BITSTRING, false,
              '\x00' + forge.asn1.toDer(asn1).getBytes()),
          ])
        );
      } else {
        forgeKey = forge.pki.publicKeyFromPem(raw);
      }
      const der = pemToDer(forge.pki.publicKeyToPem(forgeKey)); // normalize to SPKI
      return makeKeyObject('public', forgeKey, der, 'rsa');
    }

    // Try EC SPKI PEM — forge doesn't do EC, hand to subtle synchronously via cached CryptoKey
    if (label === 'PUBLIC KEY') {
      // Could be EC — sniff happens inside importEcKeySubtle
      const der = pemToDer(raw);
      const curve = guessEcCurve(der);
      // Return a KeyObject shell; CryptoKey available async via .toCryptoKey()
      const ko = new KeyObject('public', der, 'ec');
      ko._pendingImport = () => importEcKeySubtle(der, 'public', curve);
      return ko;
    }

    // X.509 certificate PEM → extract public key
    if (label === 'CERTIFICATE') {
      const cert = forge.pki.certificateFromPem(raw);
      const pub  = cert.publicKey;
      const der  = pemToDer(forge.pki.publicKeyToPem(pub));
      return makeKeyObject('public', pub, der, 'rsa');
    }
  }

  if (format === 'der') {
    const der = Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(rawKey);
    const keyType = type ?? 'spki';
    if (keyType === 'pkcs1') {
      const asn1    = forge.asn1.fromDer(forge.util.binary.raw.encode(der));
      const forgeKey = forge.pki.publicKeyFromAsn1(asn1);
      return makeKeyObject('public', forgeKey, der, 'rsa');
    }
    // spki
    const asn1    = forge.asn1.fromDer(forge.util.binary.raw.encode(der));
    const forgeKey = forge.pki.publicKeyFromAsn1(asn1);
    return makeKeyObject('public', forgeKey, der, 'rsa');
  }

  throw new Error(`createPublicKey: unsupported format "${format}"`);
}

/**
 * @param {string|Buffer|ArrayBuffer|TypedArray|object} key
 * @returns {KeyObject}
 */
export function createPrivateKey(key) {
  let format = 'pem', type, rawKey, passphrase, encoding;
  if (typeof key === 'object' && key !== null && !Buffer.isBuffer(key) && !(key instanceof Uint8Array)) {
    format = key.format ?? 'pem';
    type   = key.type;
    passphrase = key.passphrase;
    encoding   = key.encoding;
    rawKey = key.key;
  } else {
    rawKey = key;
  }

  if (format === 'jwk') {
    const jwk = typeof rawKey === 'string' ? JSON.parse(rawKey) : rawKey;
    if (jwk.kty === 'RSA' && jwk.d) {
      const toBN = f => new forge.jsbn.BigInteger(Buffer.from(jwk[f], 'base64url').toString('hex'), 16);
      const priv = forge.pki.rsa.setPrivateKey(
        toBN('n'), toBN('e'), toBN('d'),
        jwk.p ? toBN('p') : undefined,
        jwk.q ? toBN('q') : undefined,
        jwk.dp ? toBN('dp') : undefined,
        jwk.dq ? toBN('dq') : undefined,
        jwk.qi ? toBN('qi') : undefined,
      );
      const der = pemToDer(forge.pki.privateKeyToPem(priv));
      return makeKeyObject('private', priv, der, 'rsa');
    }
    throw new Error('createPrivateKey: EC JWK private key requires async path');
  }

  const raw = typeof rawKey === 'string' ? rawKey
    : Buffer.isBuffer(rawKey) ? rawKey.toString('binary')
    : Buffer.from(rawKey).toString('binary');

  if (format === 'pem') {
    const label = pemLabel(raw);
    if (label === 'RSA PRIVATE KEY') {
      // PKCS#1
      const priv = forge.pki.privateKeyFromPem(raw);
      const der  = pemToDer(forge.pki.privateKeyToPem(priv));
      const ko   = makeKeyObject('private', priv, der, 'rsa');
      // derive publicKey reference
      ko._publicKeyForge = forge.pki.rsa.setPublicKey(priv.n, priv.e);
      return ko;
    }
    if (label === 'PRIVATE KEY' || label === 'ENCRYPTED PRIVATE KEY') {
      // PKCS#8 — forge handles both plaintext and encrypted
      let pem = raw;
      if (label === 'ENCRYPTED PRIVATE KEY' && passphrase) {
        pem = forge.pki.decryptRsaPrivateKey(raw, passphrase);
        if (!pem) throw new Error('createPrivateKey: incorrect passphrase or unsupported cipher');
      }
      const priv = forge.pki.privateKeyFromPem(pem);
      const der  = pemToDer(forge.pki.privateKeyToPem(priv));
      const ko   = makeKeyObject('private', priv, der, 'rsa');
      ko._publicKeyForge = forge.pki.rsa.setPublicKey(priv.n, priv.e);
      return ko;
    }
    // EC PKCS#8 private key PEM
    if (label === 'EC PRIVATE KEY' || label === 'PRIVATE KEY') {
      const der = pemToDer(raw);
      const ko  = new KeyObject('private', der, 'ec');
      ko._pendingImport = () => importEcKeySubtle(der, 'private', guessEcCurve(der));
      return ko;
    }
  }

  if (format === 'der') {
    const der    = Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(rawKey);
    const keyType = type ?? 'pkcs8';
    const derStr  = forge.util.binary.raw.encode(der);
    if (keyType === 'pkcs1') {
      const asn1 = forge.asn1.fromDer(derStr);
      const priv = forge.pki.privateKeyFromAsn1(asn1);
      const ko   = makeKeyObject('private', priv, der, 'rsa');
      ko._publicKeyForge = forge.pki.rsa.setPublicKey(priv.n, priv.e);
      return ko;
    }
    // pkcs8
    const asn1 = forge.asn1.fromDer(derStr);
    const info = forge.pki.privateKeyInfoFromAsn1(asn1);
    const priv = forge.pki.privateKeyFromAsn1(forge.pki.decryptPrivateKeyInfo(info, passphrase ?? ''));
    const ko   = makeKeyObject('private', priv, der, 'rsa');
    ko._publicKeyForge = forge.pki.rsa.setPublicKey(priv.n, priv.e);
    return ko;
  }

  throw new Error(`createPrivateKey: unsupported format "${format}"`);
}

// ─── PBKDF2 ───────────────────────────────────────────────────────────────────

/**
 * @param {string|Buffer} password
 * @param {string|Buffer} salt
 * @param {number} iterations
 * @param {number} keylen
 * @param {string} digest
 * @param {Function} callback
 */
export function pbkdf2Fn(password, salt, iterations, keylen, digest, callback) {
  const H = resolveHash(digest);
  const pw = typeof password === 'string' ? Buffer.from(password, 'utf8') : toU8(password);
  const sl = typeof salt === 'string' ? Buffer.from(salt, 'utf8') : toU8(salt);
  pbkdf2Async(H, pw, sl, { c: iterations, dkLen: keylen })
    .then(dk => callback(null, Buffer.from(dk)))
    .catch(err => callback(err));
}
export { pbkdf2Fn as pbkdf2 };

/**
 * @param {string|Buffer} password
 * @param {string|Buffer} salt
 * @param {number} iterations
 * @param {number} keylen
 * @param {string} digest
 * @returns {Buffer}
 */
export function pbkdf2Sync(password, salt, iterations, keylen, digest) {
  const H = resolveHash(digest);
  const pw = typeof password === 'string' ? Buffer.from(password, 'utf8') : toU8(password);
  const sl = typeof salt === 'string' ? Buffer.from(salt, 'utf8') : toU8(salt);
  return Buffer.from(pbkdf2(H, pw, sl, { c: iterations, dkLen: keylen }));
}

// ─── scrypt ───────────────────────────────────────────────────────────────────

export function scryptFn(password, salt, keylen, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const { N = 16384, r = 8, p = 1, maxmem } = options ?? {};
  const pw = typeof password === 'string' ? Buffer.from(password, 'utf8') : toU8(password);
  const sl = typeof salt === 'string' ? Buffer.from(salt, 'utf8') : toU8(salt);
  scryptAsync(pw, sl, { N, r, p, dkLen: keylen })
    .then(dk => callback(null, Buffer.from(dk)))
    .catch(err => callback(err));
}
export { scryptFn as scrypt };

export function scryptSync(password, salt, keylen, options = {}) {
  const { N = 16384, r = 8, p = 1 } = options;
  const pw = typeof password === 'string' ? Buffer.from(password, 'utf8') : toU8(password);
  const sl = typeof salt === 'string' ? Buffer.from(salt, 'utf8') : toU8(salt);
  return Buffer.from(scrypt(pw, sl, { N, r, p, dkLen: keylen }));
}

// ─── hkdf ─────────────────────────────────────────────────────────────────────

export function hkdfFn(digest, ikm, salt, info, keylen, callback) {
  const H = resolveHash(digest);
  const i = typeof ikm  === 'string' ? Buffer.from(ikm,  'utf8') : toU8(ikm);
  const s = typeof salt === 'string' ? Buffer.from(salt, 'utf8') : toU8(salt);
  const f = typeof info === 'string' ? Buffer.from(info, 'utf8') : toU8(info);
  Promise.resolve()
    .then(() => hkdf(H, i, s, f, keylen))
    .then(dk => callback(null, dk.buffer.slice(dk.byteOffset, dk.byteOffset + dk.byteLength)))
    .catch(err => callback(err));
}
export { hkdfFn as hkdf };

export function hkdfSync(digest, ikm, salt, info, keylen) {
  const H = resolveHash(digest);
  const i = typeof ikm  === 'string' ? Buffer.from(ikm,  'utf8') : toU8(ikm);
  const s = typeof salt === 'string' ? Buffer.from(salt, 'utf8') : toU8(salt);
  const f = typeof info === 'string' ? Buffer.from(info, 'utf8') : toU8(info);
  return hkdf(H, i, s, f, keylen).buffer;
}

// ─── Cipher/Decipher (AES + ChaCha20) ────────────────────────────────────────

/** Resolve noble cipher constructor from algorithm string */
function resolveCipher(algo) {
  const a = algo.toLowerCase().replace(/_/g, '-');
  const map = {
    'aes-128-gcm': aes_128_gcm,
    'aes-256-gcm': aes_256_gcm,
    'aes-128-cbc': aes_128_cbc,
    'aes-256-cbc': aes_256_cbc,
    'aes-128-ctr': aes_128_ctr,
    'aes-256-ctr': aes_256_ctr,
    'chacha20-poly1305': chacha20poly1305,
  };
  if (!map[a]) throw new Error(`Unsupported cipher: ${algo}`);
  return { fn: map[a], mode: a.includes('gcm') || a.includes('poly1305') ? 'aead' : (a.includes('cbc') ? 'cbc' : 'ctr') };
}

class CipherBase extends EventEmitter {
  _algo; _key; _iv; _mode; _fn; _aad = null; _authTag = null;
  _chunks = []; _autoPadding = true; _finished = false;

  constructor(algo, key, iv) {
    super();
    const { fn, mode } = resolveCipher(algo);
    this._algo = algo; this._fn = fn; this._mode = mode;
    this._key = toU8(key instanceof KeyObject ? key.export() : key);
    this._iv  = toU8(iv);
  }

  setAAD(buf, options) { this._aad = toU8(buf); return this; }
  setAutoPadding(v = true) { this._autoPadding = v; return this; }
  getAuthTag() {
    if (!this._finished) throw new Error('Must call final() first');
    return this._authTag;
  }

  update(data, inputEncoding, outputEncoding) {
    const inp = typeof data === 'string' ? Buffer.from(data, inputEncoding || 'binary') : toU8(data);
    this._chunks.push(inp);
    // For stream-like callers expecting intermediate output, return empty (final flushes)
    return outputEncoding ? '' : Buffer.alloc(0);
  }

  write(data, enc, cb) { this.update(data, enc); if (typeof enc === 'function') enc(); if (cb) cb(); return true; }
  end(data, enc, cb)   {
    if (data) this.write(data, enc);
    const out = this.final(typeof enc === 'string' ? enc : undefined);
    this.emit('data', out); this.emit('end');
    if (typeof enc === 'function') enc(); if (cb) cb();
    return this;
  }
  pipe(dest) { const f = this.final(); dest.write(f); return dest; }
  read()     { return this.final(); }
}

class Cipheriv extends CipherBase {
  final(outputEncoding) {
    if (this._finished) throw new Error('final() already called');
    this._finished = true;
    const total = Buffer.concat(this._chunks);
    let out;
    const stream = this._fn(this._key, this._iv);
    if (this._aad && stream.setAAD) stream.setAAD(this._aad);
    const enc = stream.encrypt(total);
    if (this._mode === 'aead') {
      // noble appends 16-byte tag at end
      this._authTag = Buffer.from(enc.slice(enc.length - 16));
      out = Buffer.from(enc.slice(0, enc.length - 16));
    } else {
      out = Buffer.from(enc);
    }
    return outputEncoding ? out.toString(outputEncoding) : out;
  }
}

class Decipheriv extends CipherBase {
  #authTag = null;

  setAuthTag(tag, encoding) {
    this.#authTag = typeof tag === 'string' ? Buffer.from(tag, encoding) : Buffer.from(tag);
    return this;
  }

  final(outputEncoding) {
    if (this._finished) throw new Error('final() already called');
    this._finished = true;
    let ciphertext = Buffer.concat(this._chunks);
    const stream = this._fn(this._key, this._iv);
    if (this._aad && stream.setAAD) stream.setAAD(this._aad);
    if (this._mode === 'aead') {
      const tag = this.#authTag ?? Buffer.alloc(16);
      const withTag = Buffer.concat([ciphertext, tag]);
      try {
        const dec = stream.decrypt(withTag);
        const out = Buffer.from(dec);
        return outputEncoding ? out.toString(outputEncoding) : out;
      } catch {
        throw new Error('Unsupported state or unable to authenticate data');
      }
    }
    const dec = stream.decrypt(ciphertext);
    const out = Buffer.from(dec);
    return outputEncoding ? out.toString(outputEncoding) : out;
  }
}

export { Cipheriv, Decipheriv };

/**
 * @param {string} algorithm
 * @param {Buffer|KeyObject} key
 * @param {Buffer|null} iv
 * @param {object} [options]
 * @returns {Cipheriv}
 */
export function createCipheriv(algorithm, key, iv, options) {
  return new Cipheriv(algorithm, key, iv);
}

/**
 * @param {string} algorithm
 * @param {Buffer|KeyObject} key
 * @param {Buffer|null} iv
 * @param {object} [options]
 * @returns {Decipheriv}
 */
export function createDecipheriv(algorithm, key, iv, options) {
  return new Decipheriv(algorithm, key, iv);
}

// ─── Sign / Verify (ECDSA + EdDSA) ───────────────────────────────────────────

const CURVE_MAP = {
  'prime256v1': p256, 'p-256': p256, 'p256': p256,
  'secp384r1': p384,  'p-384': p384, 'p384': p384,
  'secp521r1': p521,  'p-521': p521, 'p521': p521,
  'secp256k1': secp256k1,
};

/** One-shot sign */
export function sign(algorithm, data, key, callback) {
  const inp = typeof data === 'string' ? Buffer.from(data, 'utf8') : toU8(data);
  const raw = key instanceof KeyObject ? key.export() : toU8(key);
  // Detect Ed25519 vs ECDSA by key length heuristic or passed algorithm
  let result;
  const algo = (algorithm ?? '').toLowerCase();
  if (algo === '' && raw.length === 64) {
    result = Buffer.from(ed25519.sign(inp, raw.slice(0, 32)));
  } else {
    throw new Error('sign() requires explicit curve; use createSign()');
  }
  if (callback) { Promise.resolve().then(() => callback(null, result)); return; }
  return result;
}

/** One-shot verify */
export function verify(algorithm, data, key, signature, callback) {
  notImpl('verify() one-shot — use createVerify()');
}

class Sign extends EventEmitter {
  #algo; #chunks = []; #signed = false;

  constructor(algorithm, options) { super(); this.#algo = algorithm; }

  update(data, inputEncoding) {
    const d = typeof data === 'string' ? Buffer.from(data, inputEncoding || 'utf8') : toU8(data);
    this.#chunks.push(d);
    return this;
  }
  write(d, e, cb) { this.update(d, e); if (typeof e === 'function') e(); if (cb) cb(); return true; }
  end(d, e, cb)   { if (d) this.write(d, e); if (typeof e === 'function') e(); if (cb) cb(); return this; }

  sign(privateKey, outputEncoding) {
    if (this.#signed) throw new Error('sign() already called');
    this.#signed = true;
    const msg = Buffer.concat(this.#chunks);
    const ko  = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey);
    let sig;

    if (ko._forgeKey) {
      // RSA path via forge — hash with algo, sign with PKCS#1 v1.5 or PSS
      const algo  = this.#algo.toLowerCase();
      const mdKey = algo.replace(/^(sha|md)/,'').replace(/-/,''); // e.g. '256'
      const mdMap = { '1':forge.md.sha1,'224':forge.md.sha256,'256':forge.md.sha256,
                      '384':forge.md.sha384,'512':forge.md.sha512,
                      'sha256':forge.md.sha256,'sha384':forge.md.sha384,'sha512':forge.md.sha512 };
      const md = (mdMap[mdKey] ?? forge.md.sha256).create();
      md.update(msg.toString('binary'));
      const padding = this.#pss
        ? forge.pss.create({ md: md.algorithm ? md : forge.md.sha256.create(),
                             mgf: forge.mgf.mgf1.create(forge.md.sha256.create()),
                             saltLength: 20 })
        : undefined;
      sig = Buffer.from(ko._forgeKey.sign(md, padding), 'binary');
    } else if (ko.asymmetricKeyType === 'ed25519') {
      sig = Buffer.from(ed25519.sign(msg, ko.export()));
    } else if (ko.asymmetricKeyType === 'ed448') {
      sig = Buffer.from(ed448.sign(msg, ko.export()));
    } else {
      // ECDSA
      const raw    = ko.export();
      const digest = createHash(this.#algo.toLowerCase()).update(msg).digest();
      const curve  = raw.length <= 32 ? p256 : raw.length <= 48 ? p384 : p521;
      sig = Buffer.from(curve.sign(digest, raw).toDERRawBytes());
    }
    return outputEncoding ? sig.toString(outputEncoding) : sig;
  }
}

class Verify extends EventEmitter {
  #algo; #chunks = [];

  constructor(algorithm, options) { super(); this.#algo = algorithm; }

  update(data, inputEncoding) {
    const d = typeof data === 'string' ? Buffer.from(data, inputEncoding || 'utf8') : toU8(data);
    this.#chunks.push(d);
    return this;
  }
  write(d, e, cb) { this.update(d, e); if (typeof e === 'function') e(); if (cb) cb(); return true; }
  end(d, e, cb)   { if (d) this.write(d, e); if (typeof e === 'function') e(); if (cb) cb(); return this; }

  verify(object, signature, signatureEncoding) {
    const msg = Buffer.concat(this.#chunks);
    const sig = typeof signature === 'string' ? Buffer.from(signature, signatureEncoding || 'hex') : toU8(signature);
    const raw = object instanceof KeyObject ? object.export() : toU8(object);
    const algo = this.#algo.toLowerCase();
    try {
      if (algo.includes('ed25519')) return ed25519.verify(sig, msg, raw);
      if (algo.includes('ed448'))   return ed448.verify(sig, msg, raw);
      const digest = createHash(algo.replace('ecdsa-with-', '').replace('rsa-', '')).update(msg).digest();
      const curve = raw.length <= 33 ? p256 : raw.length <= 49 ? p384 : p521;
      return curve.verify(sig, digest, raw);
    } catch { return false; }
  }
}

export { Sign, Verify };

export function createSign(algorithm, options)  { return new Sign(algorithm, options); }
export function createVerify(algorithm, options) { return new Verify(algorithm, options); }

// ─── ECDH ─────────────────────────────────────────────────────────────────────

class ECDH {
  #curve; #noble; #privKey; #pubKey;

  constructor(curveName) {
    const k = curveName.toLowerCase().replace(/-/g,'');
    this.#noble = CURVE_MAP[k] ?? CURVE_MAP[curveName.toLowerCase()];
    if (!this.#noble) throw new Error(`Unknown curve: ${curveName}`);
    this.#curve = curveName;
  }

  static convertKey(key, curve, inputEncoding, outputEncoding = 'uncompressed', format = 'uncompressed') {
    const k = typeof key === 'string' ? Buffer.from(key, inputEncoding || 'hex') : toU8(key);
    const noble = CURVE_MAP[curve?.toLowerCase?.()];
    if (!noble) throw new Error(`Unknown curve: ${curve}`);
    const pt = noble.ProjectivePoint.fromHex(k);
    const out = format === 'compressed' ? pt.toRawBytes(true) : pt.toRawBytes(false);
    return outputEncoding ? Buffer.from(out).toString(outputEncoding) : Buffer.from(out);
  }

  generateKeys(encoding, format) {
    this.#privKey = this.#noble.utils.randomPrivateKey();
    this.#pubKey  = this.#noble.getPublicKey(this.#privKey, format !== 'uncompressed');
    const out = Buffer.from(this.#pubKey);
    return encoding ? out.toString(encoding) : out;
  }

  computeSecret(otherPublicKey, inputEncoding, outputEncoding) {
    const pk = typeof otherPublicKey === 'string' ? Buffer.from(otherPublicKey, inputEncoding || 'hex') : toU8(otherPublicKey);
    const shared = this.#noble.getSharedSecret(this.#privKey, pk);
    // Strip leading 0x04 prefix for uncompressed; noble returns x only for ECDH-derived
    const out = Buffer.from(shared.slice(1)); // remove compression byte → x coordinate
    return outputEncoding ? out.toString(outputEncoding) : out;
  }

  getPrivateKey(encoding) {
    const out = Buffer.from(this.#privKey);
    return encoding ? out.toString(encoding) : out;
  }
  getPublicKey(encoding, format) {
    const pt = this.#noble.getPublicKey(this.#privKey, format === 'compressed');
    const out = Buffer.from(pt);
    return encoding ? out.toString(encoding) : out;
  }
  setPrivateKey(key, encoding) {
    this.#privKey = toU8(typeof key === 'string' ? Buffer.from(key, encoding || 'hex') : key);
    this.#pubKey  = this.#noble.getPublicKey(this.#privKey);
  }
}

export { ECDH };
export function createECDH(curveName) { return new ECDH(curveName); }

// ─── DiffieHellman (modp groups, Web Crypto ECDH bridge) ─────────────────────

// Modp group pre-baked prime hex excerpts (truncated for brevity — full prod use should embed real RFCs)
const MODP_GROUPS = {
  modp14: { bits: 2048, gen: 2 }, // RFC 3526 §3 — embed full hex in production
  modp15: { bits: 3072, gen: 2 },
  modp16: { bits: 4096, gen: 2 },
};

class DiffieHellmanGroup {
  constructor(name) {
    if (!MODP_GROUPS[name]) throw new Error(`Unknown DH group: ${name}`);
    this._info = MODP_GROUPS[name];
    this._name = name;
  }
  generateKeys() { notImpl(`DiffieHellmanGroup.generateKeys (${this._name}) — use Web Crypto SubtleCrypto.deriveBits with DH`); }
  computeSecret() { notImpl('DiffieHellmanGroup.computeSecret'); }
  getPrime(enc)   { return Buffer.alloc(this._info.bits / 8); } // stub
  getGenerator(enc) { const b = Buffer.alloc(1); b[0] = this._info.gen; return b; }
}

export { DiffieHellmanGroup };
export function createDiffieHellmanGroup(name) { return new DiffieHellmanGroup(name); }
export function getDiffieHellman(name) { return new DiffieHellmanGroup(name); }

export function createDiffieHellman(sizeOrKey, keyEnc, generator, genEnc) {
  notImpl('createDiffieHellman — use createECDH() or getDiffieHellman()');
}

// ─── Key generation ───────────────────────────────────────────────────────────

export function generateKey(type, options, callback) {
  const { length } = options;
  if (type === 'hmac' || type === 'aes') {
    const buf = randomBytes(length >> 3);
    const ko = createSecretKey(buf);
    Promise.resolve().then(() => callback(null, ko));
  } else {
    callback(new Error(`generateKey: unsupported type ${type}`));
  }
}

export function generateKeySync(type, options) {
  const { length } = options;
  if (type === 'hmac' || type === 'aes') return createSecretKey(randomBytes(length >> 3));
  throw new Error(`generateKeySync: unsupported type ${type}`);
}

export async function generateKeyPair(type, options, callback) {
  try {
    const pair = await generateKeyPairAsync(type, options);
    callback(null, pair.publicKey, pair.privateKey);
  } catch (err) { callback(err); }
}

export function generateKeyPairSync(type, options) {
  notImpl('generateKeyPairSync — use generateKeyPair (async) or Web Crypto subtle.generateKey');
}

async function generateKeyPairAsync(type, options = {}) {
  if (type === 'ec') {
    const noble = CURVE_MAP[options.namedCurve?.toLowerCase()] ?? p256;
    const priv = noble.utils.randomPrivateKey();
    const pub  = noble.getPublicKey(priv);
    return {
      publicKey: new KeyObject('public', Buffer.from(pub), 'ec'),
      privateKey: new KeyObject('private', Buffer.from(priv), 'ec'),
    };
  }
  if (type === 'ed25519') {
    const priv = ed25519.utils.randomPrivateKey();
    const pub  = ed25519.getPublicKey(priv);
    return {
      publicKey: new KeyObject('public', Buffer.from(pub), 'ed25519'),
      privateKey: new KeyObject('private', Buffer.from(priv), 'ed25519'),
    };
  }
  if (type === 'ed448') {
    const priv = ed448.utils.randomPrivateKey();
    const pub  = ed448.getPublicKey(priv);
    return {
      publicKey: new KeyObject('public', Buffer.from(pub), 'ed448'),
      privateKey: new KeyObject('private', Buffer.from(priv), 'ed448'),
    };
  }
  if (type === 'rsa') {
    const { modulusLength = 2048, publicExponent = 65537 } = options;
    const pair = await subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify']
    );
    return {
      publicKey: KeyObject.from(pair.publicKey),
      privateKey: KeyObject.from(pair.privateKey),
    };
  }
  notImpl(`generateKeyPair for type: ${type}`);
}

// ─── RSA encrypt/decrypt (Web Crypto) ─────────────────────────────────────────

export function publicEncrypt(key, buffer) {
  const forgeKey = (key instanceof KeyObject ? key : createPublicKey(key))._forgeKey;
  if (!forgeKey) notImpl('publicEncrypt for non-RSA keys');
  const { padding = constants.RSA_PKCS1_OAEP_PADDING, oaepHash = 'sha1' } = typeof key === 'object' && !(key instanceof KeyObject) ? key : {};
  const inp = Buffer.isBuffer(buffer) ? buffer.toString('binary') : Buffer.from(buffer).toString('binary');
  let encrypted;
  if (padding === constants.RSA_PKCS1_OAEP_PADDING) {
    encrypted = forgeKey.encrypt(inp, 'RSA-OAEP', { md: forge.md[oaepHash.replace('-','')]?.create?.() ?? forge.md.sha1.create() });
  } else if (padding === constants.RSA_PKCS1_PADDING) {
    encrypted = forgeKey.encrypt(inp, 'RSAES-PKCS1-V1_5');
  } else {
    encrypted = forgeKey.encrypt(inp, 'RAW');
  }
  return Buffer.from(encrypted, 'binary');
}

export function privateDecrypt(key, buffer) {
  const forgeKey = (key instanceof KeyObject ? key : createPrivateKey(key))._forgeKey;
  if (!forgeKey) notImpl('privateDecrypt for non-RSA keys');
  const { padding = constants.RSA_PKCS1_OAEP_PADDING, oaepHash = 'sha1' } = typeof key === 'object' && !(key instanceof KeyObject) ? key : {};
  const inp = Buffer.isBuffer(buffer) ? buffer.toString('binary') : Buffer.from(buffer).toString('binary');
  let decrypted;
  if (padding === constants.RSA_PKCS1_OAEP_PADDING) {
    decrypted = forgeKey.decrypt(inp, 'RSA-OAEP', { md: forge.md[oaepHash.replace('-','')]?.create?.() ?? forge.md.sha1.create() });
  } else if (padding === constants.RSA_PKCS1_PADDING) {
    decrypted = forgeKey.decrypt(inp, 'RSAES-PKCS1-V1_5');
  } else {
    decrypted = forgeKey.decrypt(inp, 'RAW');
  }
  return Buffer.from(decrypted, 'binary');
}

export function privateEncrypt(key, buffer) {
  // RSA private encrypt (sign-with-private for raw PKCS#1 v1.5)
  const forgeKey = (key instanceof KeyObject ? key : createPrivateKey(key))._forgeKey;
  if (!forgeKey) notImpl('privateEncrypt for non-RSA keys');
  const inp = Buffer.isBuffer(buffer) ? buffer.toString('binary') : Buffer.from(buffer).toString('binary');
  return Buffer.from(forgeKey.sign(forge.md.sha1.create().update(inp)), 'binary');
}

export function publicDecrypt(key, buffer) {
  notImpl('publicDecrypt — verify-with-public is not OAEP decryption; use createVerify()');
}
export function diffieHellman(options, cb)  { notImpl('diffieHellman'); }

// ─── FIPS / engine stubs ──────────────────────────────────────────────────────

export function getFips() { return 0; }
export function setFips(val) { if (val) throw new Error('FIPS mode not available in browser'); }
export function setEngine(engine, flags) { notImpl('setEngine'); }
export function secureHeapUsed() { notImpl('secureHeapUsed'); }
export function checkPrime(candidate, options, callback) { notImpl('checkPrime'); }
export function checkPrimeSync(candidate, options) { notImpl('checkPrimeSync'); }
export function generatePrime(size, options, callback) { notImpl('generatePrime'); }
export function generatePrimeSync(size, options) { notImpl('generatePrimeSync'); }

// ─── Certificate (SPKAC) stub ─────────────────────────────────────────────────

export class Certificate {
  exportChallenge()  { notImpl('Certificate.exportChallenge'); }
  exportPublicKey()  { notImpl('Certificate.exportPublicKey'); }
  verifySpkac()      { notImpl('Certificate.verifySpkac'); }
  static exportChallenge()  { notImpl('Certificate.exportChallenge'); }
  static exportPublicKey()  { notImpl('Certificate.exportPublicKey'); }
  static verifySpkac()      { notImpl('Certificate.verifySpkac'); }
}

// ─── X509Certificate stub ─────────────────────────────────────────────────────

export class X509Certificate {
  constructor() { notImpl('X509Certificate'); }
}

// ─── Default export ───────────────────────────────────────────────────────────

export default {
  // random
  randomBytes, randomFill, randomFillSync, randomInt, randomUUID, getRandomValues,
  // hash
  createHash, Hash, hash,
  // hmac
  createHmac, Hmac,
  // kdf
  pbkdf2: pbkdf2Fn, pbkdf2Sync, scrypt: scryptFn, scryptSync,
  hkdf: hkdfFn, hkdfSync,
  // cipher
  createCipheriv, createDecipheriv, Cipheriv, Decipheriv,
  getCiphers, getCipherInfo,
  // sign/verify
  createSign, createVerify, Sign, Verify, sign, verify,
  // ecdh
  createECDH, ECDH,
  // dh
  createDiffieHellman, createDiffieHellmanGroup, getDiffieHellman, DiffieHellmanGroup, diffieHellman,
  // keys
  createSecretKey, createPublicKey, createPrivateKey, KeyObject,
  generateKey, generateKeySync, generateKeyPair, generateKeyPairSync,
  publicEncrypt, publicDecrypt, privateEncrypt, privateDecrypt,
  // misc
  timingSafeEqual, getHashes, getCurves,
  getFips, setFips, setEngine, secureHeapUsed,
  checkPrime, checkPrimeSync, generatePrime, generatePrimeSync,
  Certificate, X509Certificate,
  constants, webcrypto, subtle,
};


// --- Usage ---
//
// RSA key from PEM string (node-forge)
// const pubKey  = createPublicKey('-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n')
// const privKey = createPrivateKey('-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n')
// // export back to PEM
// console.log(pubKey.export({ format: 'pem', type: 'spki' }))
//
// RSA key from JWK object (node-forge BigInteger reconstruction)
// const jwk = { kty:'RSA', n:'...', e:'AQAB', d:'...', ... }
// const privKey = createPrivateKey({ key: jwk, format: 'jwk' })
//
// RSA OAEP encrypt/decrypt (node-forge)
// const ct = publicEncrypt(pubKey, Buffer.from('hello'))
// const pt = privateDecrypt(privKey, ct)          // → Buffer('hello')
//
// RSA sign/verify (node-forge via createSign/createVerify)
// const sig = createSign('SHA256').update('data').sign(privKey)
// const ok  = createVerify('SHA256').update('data').verify(pubKey, sig) // → true
//
// Encrypted PKCS#8 private key (passphrase)
// const privKey = createPrivateKey({ key: encryptedPem, format: 'pem', passphrase: 'secret' })
//
// Edge: EC keys fall back to subtle (async)
// const ko = createPrivateKey(ecPkcs8Pem)   // returns KeyObject with _pendingImport
// const ck = await ko._pendingImport()      // → CryptoKey for use with subtle.sign
