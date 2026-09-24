// Export-surface parity: src/_http_common.js  <->  node:_http_common
// captured from real Node v24.20.0 (node:_http_common)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/_http_common.js';

const EXPECTED = ["CRLF","HTTPParser","_checkInvalidHeaderChar","_checkIsHttpToken","calculateLenientFlags","chunkExpression","continueExpression","default","freeParser","isLenient","kIncomingMessage","kSkipPendingData","methods","parsers","prepareError"];

test('node:_http_common export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
