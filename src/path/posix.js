/*!
 * path-web/posix — node:path/posix for browsers & bundlers
 * MIT License.
 * Node.js parity: node:path/posix @ Node 0.1.90+
 * Dependencies: path-browserify (via ./path)
 * Limitations:
 *   - resolve() has no process.cwd(); falls back to '/'.
 *   - Identical to the default ./path export — path-browserify is POSIX-only.
 */

/**
 * @packageDocumentation
 * Re-exports the POSIX surface of `./path` as `node:path/posix`.
 * In Node, `path/posix` gives you the POSIX implementation unconditionally,
 * regardless of the host OS. In browser environments there is only one
 * implementation (POSIX), so this module is a clean re-export of `./path`.
 */

import path from '../path';

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
  dirname,
  basename,
  extname,
  format,
  parse,
  posix,    // self-referential, preserved for parity
  win32,    // alias to posix in browser, preserved for parity
} = path.posix;

/** The posix object itself, for consumers that do `import posix from 'path/posix'`. */
export default path.posix;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import posix, { join, resolve, dirname } from './path/posix';
//
// posix.join('/foo', 'bar', '..', 'baz')   // → '/foo/baz'
// join('/foo', 'bar', '..', 'baz')         // → '/foo/baz'
// resolve('foo', 'bar')                    // → '/foo/bar'  (cwd assumed '/')
// dirname('/home/user/file.txt')           // → '/home/user'
//
// // Always POSIX — forward slashes, ':' delimiter
// posix.sep          // → '/'
// posix.delimiter    // → ':'
