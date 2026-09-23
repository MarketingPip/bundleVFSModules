// src/fs/promises.js — Node v24.20.0 `fs/promises` surface for the browser runtime.
//
// Thin ESM facade over the promises namespace published by `../fs.js`
// (which owns the virtual-filesystem singleton). Named exports mirror
// `node:fs/promises` exactly; the default export is the namespace object.

import fs from '../fs.js';

const p = fs.promises;

export const {
  access,
  appendFile,
  chmod,
  chown,
  constants,
  copyFile,
  cp,
  glob,
  lchmod,
  lchown,
  link,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  mkdtempDisposable,
  open,
  opendir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  symlink,
  truncate,
  unlink,
  utimes,
  watch,
  writeFile,
} = p;

export default p;
