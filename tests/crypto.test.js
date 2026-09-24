import { jest, describe, test, expect, beforeAll } from '@jest/globals';

import * as nodeCrypto from 'node:crypto';

// Native-bridge surface: under genuine Node every export delegates to the
// real builtin (verified by identity below and by 129/129 official tests).
import * as crypto from '../src/crypto.js';

const EXPECTED_EXPORTS = [
  'Certificate', 'Cipheriv', 'Decipheriv', 'DiffieHellman',
  'DiffieHellmanGroup', 'ECDH', 'Hash', 'Hmac', 'KeyObject', 'Sign',
  'Verify', 'X509Certificate', 'argon2', 'argon2Sync', 'checkPrime',
  'checkPrimeSync', 'constants', 'createCipheriv', 'createDecipheriv',
  'createDiffieHellman', 'createDiffieHellmanGroup', 'createECDH',
  'createHash', 'createHmac', 'createPrivateKey', 'createPublicKey',
  'createSecretKey', 'createSign', 'createVerify', 'decapsulate',
  'diffieHellman', 'encapsulate', 'generateKey', 'generateKeyPair',
  'generateKeyPairSync', 'generateKeySync', 'generatePrime',
  'generatePrimeSync', 'getCipherInfo', 'getCiphers', 'getCurves',
  'getDiffieHellman', 'getFips', 'getHashes', 'getRandomValues', 'hash',
  'hkdf', 'hkdfSync', 'pbkdf2', 'pbkdf2Sync', 'privateDecrypt',
  'privateEncrypt', 'publicDecrypt', 'publicEncrypt', 'randomBytes',
  'randomFill', 'randomFillSync', 'randomInt', 'randomUUID',
  'randomUUIDv7', 'scrypt', 'scryptSync', 'secureHeapUsed', 'setEngine',
  'setFips', 'sign', 'subtle', 'timingSafeEqual', 'verify', 'webcrypto',
  'default',
];

describe('crypto native bridge (node)', () => {
  test('exports the full node:crypto surface', () => {
    for (const name of EXPECTED_EXPORTS) {
      expect(typeof crypto[name] !== 'undefined').toBe(true);
    }
  });

  test('native exports delegate to the real builtin by identity', () => {
    for (const name of EXPECTED_EXPORTS) {
      if (name === 'default') continue;
      expect(crypto[name]).toBe(nodeCrypto[name]);
    }
  });

  test('deprecated aliases are non-enumerable own props of require shape', () => {
    for (const f of ['pseudoRandomBytes', 'prng', 'rng']) {
      // NOT named ESM exports in real node:crypto — they live only on the
      // default export (require shape), as non-enumerable own properties.
      expect(crypto[f]).toBe(undefined);
      expect(typeof crypto.default[f]).toBe('function');
      expect(crypto.default[f]).toBe(crypto.default.randomBytes);
      const desc = Object.getOwnPropertyDescriptor(crypto.default, f);
      expect(desc).toBeDefined();
      expect(desc.enumerable).toBe(false);
      expect(desc.configurable).toBe(true);
    }
  });

  test('default export carries every named export', () => {
    for (const name of EXPECTED_EXPORTS) {
      if (name === 'default') continue;
      expect(crypto.default[name]).toBe(crypto[name]);
    }
  });

  test('subtle === webcrypto.subtle', () => {
    expect(crypto.subtle).toBe(crypto.webcrypto.subtle);
  });
});

// Browser fallback: force the pure-JS path by hiding getBuiltinModule
// before a cache-busted import.
let fb;
beforeAll(async () => {
  const realGbm = process.getBuiltinModule;
  process.getBuiltinModule = undefined;
  try {
    fb = await import('../src/crypto.js?fallback=jest');
  } finally {
    process.getBuiltinModule = realGbm;
  }
});

const KNOWN = {
  md5: 'd41d8cd98f00b204e9800998ecf8427e',
  sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
  sha224: 'd14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  sha384:
    '38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe' +
    '76f65fbd51ad2f14898b95b',
  sha512:
    'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce' +
    '47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
  'sha512-224': '6ed0dd02806fa89e25de060c19d3ac86cabb87d6a0ddd05c333b84f4',
  'sha512-256':
    'c672b8d1ef56ed28ab87c3622c5114069bdd3ad7b8f9737498d0c01ecef0967a',
};

describe('crypto browser fallback', () => {
  test('hashes match known empty-string vectors', () => {
    for (const [algo, expected] of Object.entries(KNOWN)) {
      expect(fb.createHash(algo).update('').digest('hex')).toBe(expected);
    }
  });

  test('hmac-sha256 matches node', () => {
    expect(fb.createHmac('sha256', 'key').update('data').digest('hex')).toBe(
      nodeCrypto.createHmac('sha256', 'key').update('data').digest('hex'),
    );
  });

  test('one-shot hash matches node', () => {
    expect(fb.hash('sha256', 'x')).toBe(nodeCrypto.hash('sha256', 'x'));
  });

  test('pbkdf2Sync matches node (RFC 2898)', () => {
    const mine = Buffer.from(fb.pbkdf2Sync('password', 'salt', 4096, 32, 'sha256')).toString('hex');
    const ref = nodeCrypto.pbkdf2Sync('password', 'salt', 4096, 32, 'sha256').toString('hex');
    expect(mine).toBe(ref);
  });

  test('hkdfSync matches node (RFC 5869 vector 1)', () => {
    const ikm = Buffer.from('0b'.repeat(22), 'hex');
    const salt = Buffer.from('000102030405060708090a0b0c', 'hex');
    const info = Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex');
    const mine = Buffer.from(fb.hkdfSync('sha256', ikm, salt, info, 42)).toString('hex');
    const ref = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, info, 42)).toString('hex');
    expect(mine).toBe(ref);
    expect(fb.hkdfSync('sha256', ikm, salt, info, 42)).toBeInstanceOf(ArrayBuffer);
  });

  test('async pbkdf2/hkdf wrappers work', async () => {
    const dk = await new Promise((res, rej) =>
      fb.pbkdf2('password', 'salt', 1, 16, 'sha256', (e, d) => (e ? rej(e) : res(d))),
    );
    expect(Buffer.from(dk).toString('hex')).toBe(
      nodeCrypto.pbkdf2Sync('password', 'salt', 1, 16, 'sha256').toString('hex'),
    );
  });

  test('random APIs have the right shape', () => {
    expect(fb.randomBytes(16)).toHaveLength(16);
    expect(fb.randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(fb.randomUUIDv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const r = fb.randomInt(1, 7);
    expect(Number.isInteger(r) && r >= 1 && r < 7).toBe(true);
    const buf = new Uint8Array(8);
    expect(fb.randomFillSync(buf)).toBe(buf);
    expect(() => fb.timingSafeEqual(Buffer.from('a'), Buffer.from('ab'))).toThrow(
      expect.objectContaining({ code: 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH' }),
    );
  });

  test('capability queries are honest', () => {
    expect(fb.getHashes()).toEqual([
      'md5', 'sha1', 'sha224', 'sha256',
      'sha384', 'sha512', 'sha512-224', 'sha512-256',
    ]);
    expect(fb.getCiphers()).toEqual([]);
    expect(fb.getCurves()).toEqual([]);
    expect(fb.getCipherInfo('aes-256-gcm')).toBeUndefined();
    expect(fb.getFips()).toBe(0);
    expect(Object.isFrozen(fb.constants)).toBe(true);
  });

  test('OpenSSL-only APIs throw honest errors', () => {
    for (const name of [
      'createCipheriv', 'createDecipheriv', 'createECDH', 'createDiffieHellman',
      'createSign', 'createVerify', 'scryptSync', 'generateKeyPairSync',
      'publicEncrypt', 'privateDecrypt', 'sign', 'verify',
    ]) {
      expect(() => fb[name]()).toThrow(/OpenSSL/);
    }
  });

  test('createHash rejects unknown digests like node', () => {
    expect(() => fb.createHash('nope')).toThrow('Digest method not supported');
    expect(() => fb.createHmac('nope', 'k')).toThrow(
      expect.objectContaining({ code: 'ERR_CRYPTO_INVALID_DIGEST' }),
    );
  });
});
