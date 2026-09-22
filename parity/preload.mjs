// Parity preload (run with: node --import ./parity/preload.mjs <testfile>).
//
// 1. Patches CJS Module._load so require('path') / require('node:path') inside
//    parity/node-test/parallel/*.js resolves to the polyfill instead of the
//    real builtin. (Loader resolve hooks don't reliably intercept CJS.)
// 2. Registers the ESM hooks (hooks.mjs) for `import` specifiers.
//
// Only the module named in PARITY_TARGET is redirected, and only for
// importers under parity/node-test/parallel/. Everything else — including
// test/common — keeps real Node builtins.
import Module from 'node:module';
import { register } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(repoRoot, 'parity', 'node-test', 'parallel') + path.sep;
const target = process.env.PARITY_TARGET;

function polyfillPath(request) {
  const name = request.startsWith('node:') ? request.slice(5) : request;
  if (name.startsWith('.') || path.isAbsolute(name)) return null;
  const parts = name.split('/');
  if (target && parts[0] !== target) return null;
  const candidate = path.join(repoRoot, 'src', ...parts) + '.js';
  return fs.existsSync(candidate) ? candidate : null;
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const parentFile = parent?.filename ?? '';
  if (parentFile.startsWith(testsDir)) {
    const poly = polyfillPath(request);
    if (poly) request = poly;
  }
  return origLoad.call(this, request, parent, isMain);
};

register('./hooks.mjs', import.meta.url);
