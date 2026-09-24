// Export-surface parity: src/stream/web.js  <->  node:stream_web
// custom runtime module (no node:stream_web counterpart); surface below is the defined contract
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/stream/web.js';

const EXPECTED = ["ByteLengthQueuingStrategy","CompressionStream","CountQueuingStrategy","DecompressionStream","ReadableByteStreamController","ReadableStream","ReadableStreamBYOBReader","ReadableStreamBYOBRequest","ReadableStreamDefaultController","ReadableStreamDefaultReader","ReadableStreamTee","TextDecoderStream","TextEncoderStream","TransformStream","TransformStreamDefaultController","WritableStream","WritableStreamDefaultController","WritableStreamDefaultWriter","default"];

test('node:stream_web export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
