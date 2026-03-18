// Import path from path-browserify
import path from "path-browserify";
import win32 from './path/win32.js'; // Optional: custom win32 implementation

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
  posix,       // self-referential, preserved for parity
  win32: win32Alias = win32, // alias to win32 import or path.win32
} = path;

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

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
  posix,       // self-referential, preserved for parity
  win32: win32Alias,  // alias to win32
};
