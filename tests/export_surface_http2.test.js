// Export-surface parity: src/http2.js  <->  node:http2
// captured from real Node v24.20.0 (node:http2)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/http2.js';

const EXPECTED = ["Http2ServerRequest","Http2ServerResponse","connect","constants","createSecureServer","createServer","default","getDefaultSettings","getPackedSettings","getUnpackedSettings","performServerHandshake","sensitiveHeaders"];

test('node:http2 export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
