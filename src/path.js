import path from "path-browserify";

import win32 from './path/win32.js';

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
  win32:win32,    // alias to posix in browser, preserved for parity
} = path;

export default {
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
  win32:win32,    // alias to posix in browser, preserved for parity
};              // export default
