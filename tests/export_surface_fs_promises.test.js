// Export-surface parity: src/fs/promises.js  <->  node:fs/promises
// captured from real Node v24.20.0 (node:fs/promises)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/fs/promises.js';

const EXPECTED = ["access","appendFile","chmod","chown","constants","copyFile","cp","default","glob","lchmod","lchown","link","lstat","lutimes","mkdir","mkdtemp","mkdtempDisposable","open","opendir","readFile","readdir","readlink","realpath","rename","rm","rmdir","stat","statfs","symlink","truncate","unlink","utimes","watch","writeFile"];

test('node:fs/promises export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
