// Export-surface parity: src/stream.js  <->  node:stream
// captured from real Node v24.20.0 (node:stream)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/stream.js';

const EXPECTED = ["Duplex","PassThrough","Readable","Stream","Transform","Writable","_isArrayBufferView","_isUint8Array","_uint8ArrayToBuffer","addAbortSignal","compose","default","destroy","duplexPair","finished","getDefaultHighWaterMark","isDestroyed","isDisturbed","isErrored","isReadable","isWritable","pipeline","promises","setDefaultHighWaterMark"];

test('node:stream export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
