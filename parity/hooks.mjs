// Parity ESM loader hooks.
//
// Redirects `import 'path'` / `import 'node:path'` (and subpaths like
// `path/posix`) to the repo's polyfill files, but ONLY when the importer
// lives under parity/node-test/parallel/. Node's own test helper
// (test/common) keeps using the real builtins.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(repoRoot, 'parity', 'node-test', 'parallel') + path.sep;
const target = process.env.PARITY_TARGET; // e.g. "path" — only redirect this module

function polyfillURL(specifier) {
  const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  if (name.startsWith('.') || path.isAbsolute(name)) return null;
  const parts = name.split('/');
  if (target && parts[0] !== target) return null;
  const candidate = path.join(repoRoot, 'src', ...parts) + '.js';
  if (!fs.existsSync(candidate)) return null;
  return pathToFileURL(candidate).href;
}

export async function resolve(specifier, context, nextResolve) {
  let parentPath = '';
  try {
    parentPath = fileURLToPath(context.parentURL ?? '');
  } catch { /* ignore */ }
  if (parentPath.startsWith(testsDir)) {
    const url = polyfillURL(specifier);
    if (url) return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
