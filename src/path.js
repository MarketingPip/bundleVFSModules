// Import path from path-browserify (POSIX-only implementation)
import path from "path-browserify";
import win32Impl from './path/win32.js'; // Custom win32 implementation (path-browserify has none — its win32 is null)

// ---------------------------------------------------------------------------
// Named exports — every member of the POSIX API, plus win32
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
} = path;

// win32 always uses our custom implementation: path-browserify exposes no
// win32 (its `win32` property is null), so there is nothing to fall back to.
export const win32 = win32Impl;

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
  win32: win32Impl,
};
