// Export-surface parity: src/ws.js  <->  node:ws
// custom runtime module (no node:ws counterpart); surface below is the defined contract
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/ws.js';

const EXPECTED = ["Server","WebSocket","WebSocketServer","createWebSocketStream","default"];

test('node:ws export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
