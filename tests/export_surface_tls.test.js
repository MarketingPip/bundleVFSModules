// Export-surface parity: src/tls.js  <->  node:tls
// captured from real Node v24.20.0 (node:tls)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/tls.js';

const EXPECTED = ["CLIENT_RENEG_LIMIT","CLIENT_RENEG_WINDOW","DEFAULT_CIPHERS","DEFAULT_ECDH_CURVE","DEFAULT_MAX_VERSION","DEFAULT_MIN_VERSION","SecureContext","Server","TLSSocket","checkServerIdentity","connect","convertALPNProtocols","createSecureContext","createServer","default","getCACertificates","getCertificateCompressionAlgorithms","getCiphers","rootCertificates","setDefaultCACertificates"];

test('node:tls export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
