// Export-surface parity: src/_readable_stream.js  <->  node:_stream_readable
// captured from real Node v24.20.0 (node:_stream_readable)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/_readable_stream.js';

const EXPECTED = ["ReadableState","_fromList","default","from","fromWeb","toWeb","wrap"];

test('node:_stream_readable export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
