// Export-surface parity: src/crypto.js  <->  node:crypto
// captured from real Node v24.20.0 (node:crypto)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/crypto.js';

const EXPECTED = ["Certificate","Cipheriv","Decipheriv","DiffieHellman","DiffieHellmanGroup","ECDH","Hash","Hmac","KeyObject","Sign","Verify","X509Certificate","argon2","argon2Sync","checkPrime","checkPrimeSync","constants","createCipheriv","createDecipheriv","createDiffieHellman","createDiffieHellmanGroup","createECDH","createHash","createHmac","createPrivateKey","createPublicKey","createSecretKey","createSign","createVerify","decapsulate","default","diffieHellman","encapsulate","generateKey","generateKeyPair","generateKeyPairSync","generateKeySync","generatePrime","generatePrimeSync","getCipherInfo","getCiphers","getCurves","getDiffieHellman","getFips","getHashes","getRandomValues","hash","hkdf","hkdfSync","pbkdf2","pbkdf2Sync","privateDecrypt","privateEncrypt","publicDecrypt","publicEncrypt","randomBytes","randomFill","randomFillSync","randomInt","randomUUID","randomUUIDv7","scrypt","scryptSync","secureHeapUsed","setEngine","setFips","sign","subtle","timingSafeEqual","verify","webcrypto"];

test('node:crypto export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
