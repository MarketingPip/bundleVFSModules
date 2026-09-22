// src/sys.js — Port of Node.js v24.20.0 lib/sys.js to dependency-free,
// browser-safe ESM.
//
// The sys module was renamed to 'util'. This shim remains to keep old programs
// working. `sys` is deprecated and shouldn't be used.
//
// Note to maintainers: Although this module has been deprecated for a while
// we do not plan to remove it. See: https://github.com/nodejs/node/pull/35407#issuecomment-700693439
//
// Like Node's own lib/sys.js (`module.exports = require('util')`), this module
// re-exports the *real* `node:util` — not the sibling src/util.js polyfill — so
// that `require('sys') === require('util')` holds exactly, as the official
// test-sys.js asserts. (Aliasing the polyfill instead would break that identity
// under the parity harness, where `require('util')` resolves to the real
// builtin.) The `node:` import is externalized by the VFS build, exactly like
// the `node:path` / `node:querystring` imports already used in src/url.js.
'use strict';

import util from 'node:util';

// Node emits DEP0025 eagerly when the module is first loaded, once per process
// (the loaded module is cached). `process.emitWarning` doesn't exist in
// browsers, so guard it to stay browser-safe.
if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
  process.emitWarning('sys is deprecated. Use util instead.',
                      'DeprecationWarning', 'DEP0025');
}

// Re-export the whole util namespace, so the default import AND named imports
// (`import { format } from 'sys'`) behave exactly like 'util'.
export * from 'node:util';
export default util;
