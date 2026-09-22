/*!
 * path-web/win32 — node:path/win32 for browsers & bundlers
 * MIT License.
 * Node.js parity: node:path/win32 @ v24.20.0
 *
 * Re-exports the Win32 implementation from `./path`. In Node, `path/win32`
 * gives you the Win32 implementation unconditionally, regardless of the host
 * OS; this module does the same.
 */

import path from '../path.js';

// ---------------------------------------------------------------------------
// Named exports — every member of the Win32 API
// ---------------------------------------------------------------------------

export const {
  sep,
  delimiter,
  resolve,
  normalize,
  isAbsolute,
  join,
  relative,
  toNamespacedPath,
  dirname,
  basename,
  extname,
  format,
  parse,
  matchesGlob,
  posix,    // the posix implementation, preserved for parity
  win32,    // self-referential, preserved for parity
  _makeLong,
} = path.win32;

/** The win32 object itself, for consumers that do `import win32 from 'path/win32'`. */
export default path.win32;
