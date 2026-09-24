// Export-surface parity: src/specials/bundler.js  <->  node:RUNTIME_BUNDLER
// custom runtime module (no node:RUNTIME_BUNDLER counterpart); surface below is the defined contract
// NOTE: static contract test — the shim imports https://esm.sh/acorn at module
// scope, which Jest cannot resolve, so exports are extracted from source text
// instead of by importing the module.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXPECTED = ["bundle"];

function staticExports(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const names = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/);
      const nm = (t[1] || t[0] || '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.add(nm);
    }
  }
  if (/\bexport\s+default\b/.test(code)) names.add('default');
  return [...names].sort();
}

test('node:RUNTIME_BUNDLER export surface matches the defined contract', () => {
  const actual = staticExports(path.join(__dirname, '../src/specials/bundler.js'));
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
