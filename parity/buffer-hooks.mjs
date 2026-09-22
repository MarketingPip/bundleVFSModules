// Buffer-specific ESM loader hooks.
//
// Redirects `import 'buffer'` / `import 'node:buffer'` to the repo's
// src/buffer.js polyfill, for any importer under parity/node-test/
// (the official tests in parallel/ AND the fixture packages under
// fixtures/, which spawned child processes load). Node internals and
// everything outside the vendored test tree keep the real builtin:
// their parentURL never maps into parity/node-test/.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeTestDir = path.join(repoRoot, 'parity', 'node-test') + path.sep;
const polyfillURL = pathToFileURL(path.join(repoRoot, 'src', 'buffer.js')).href;

// Only the official test files (parallel/) and their fixture packages
// (fixtures/, loaded by spawned child processes) are redirected.
// test/common and the rest of the harness keep the real builtins:
// common/index.js destructures atob/btoa from require('buffer') for its
// global-leak detector, so it must keep seeing the native module.
const redirectDirs = [
  path.join(nodeTestDir, 'parallel') + path.sep,
  path.join(nodeTestDir, 'fixtures') + path.sep,
];

function shouldRedirect(parentFile) {
  return redirectDirs.some((dir) => parentFile.startsWith(dir));
}

export async function resolve(specifier, context, nextResolve) {
  const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  if (name === 'buffer') {
    let parentPath = '';
    try {
      parentPath = fileURLToPath(context.parentURL ?? '');
    } catch { /* ignore: node: parent URLs stay native */ }
    if (parentPath !== '' && redirectDirs.some((dir) => parentPath.startsWith(dir))) {
      return { url: polyfillURL, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
