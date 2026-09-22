/*!
 * path-web/posix — node:path/posix for browsers & bundlers
 * MIT License.
 * Node.js parity: node:path/posix @ v24.20.0
 *
 * Re-exports the POSIX implementation from `./path`. In Node, `path/posix`
 * gives you the POSIX implementation unconditionally, regardless of the host
 * OS; this module does the same.
 */

import path from '../path.js';

// ---------------------------------------------------------------------------
// Named exports — every member of the POSIX API
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
  posix,    // self-referential, preserved for parity
  win32,    // the win32 implementation, preserved for parity
  _makeLong,
} = path.posix;

/** The posix object itself, for consumers that do `import posix from 'path/posix'`. */
export default path.posix;
