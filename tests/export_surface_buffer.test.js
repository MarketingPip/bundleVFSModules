// Export-surface parity: src/buffer.js  <->  node:buffer
// captured from real Node v24.20.0 (node:buffer)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/buffer.js';

const EXPECTED = ["Blob","Buffer","File","INSPECT_MAX_BYTES","SlowBuffer","atob","btoa","constants","default","isAscii","isUtf8","kMaxLength","kStringMaxLength","resolveObjectURL","transcode"];

test('node:buffer export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
