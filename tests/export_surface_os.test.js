// Export-surface parity: src/os.js  <->  node:os
// captured from real Node v24.20.0 (node:os)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/os.js';

const EXPECTED = ["EOL","arch","availableParallelism","constants","cpus","default","devNull","endianness","freemem","getPriority","homedir","hostname","loadavg","machine","networkInterfaces","platform","release","setPriority","tmpdir","totalmem","type","uptime","userInfo","version"];

test('node:os export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
