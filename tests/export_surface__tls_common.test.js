// Export-surface parity: src/_tls_common.js  <->  node:_tls_common
// captured from real Node v24.20.0 (node:_tls_common)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/_tls_common.js';

const EXPECTED = ["SecureContext","createSecureContext","default","translatePeerCertificate"];

test('node:_tls_common export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
