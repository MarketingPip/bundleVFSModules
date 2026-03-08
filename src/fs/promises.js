/**
 * fs/promises — Node.js-compliant drop-in for the custom runtime.
 *
 * Pulls from the already-patched `fs.promises` (which wraps memfs and
 * calls globalThis.emitMe) so every operation is observable by the
 * runtime exactly the same way the callback-style fs is.
 *
 * Usage:
 *   import { readFile, writeFile } from './fs-promises.js';
 *   // or
 *   import fsPromises from './fs-promises.js';
 */

import fs from '../fs.js';          // your existing patched fs module
import { constants } from '../fs.js';

const p = fs.promises;

// ── Core file I/O ─────────────────────────────────────────────────────────────

export const access    = (path, mode = constants.F_OK)        => p.access(path, mode);
export const open      = (path, flags, mode)                  => p.open(path, flags, mode);
export const readFile  = (path, options)                      => p.readFile(path, options);
export const writeFile = (path, data, options)                => p.writeFile(path, data, options);
export const appendFile= (path, data, options)                => p.appendFile(path, data, options);
export const truncate  = (path, len = 0)                      => p.truncate(path, len);
export const copyFile  = (src, dest, mode)                    => p.copyFile(src, dest, mode);
export const rename    = (oldPath, newPath)                   => p.rename(oldPath, newPath);
export const unlink    = (path)                               => p.unlink(path);

// ── Directory operations ───────────────────────────────────────────────────────

export const mkdir   = (path, options)         => p.mkdir(path, options);
export const mkdtemp = (prefix, options)       => p.mkdtemp(prefix, options);
export const opendir = (path, options)         => p.opendir(path, options);
export const readdir = (path, options)         => p.readdir(path, options);
export const rmdir   = (path, options)         => p.rmdir(path, options);
export const rm      = (path, options)         => p.rm(path, options);

// ── Stat & metadata ───────────────────────────────────────────────────────────

export const stat    = (path, options)         => p.stat(path, options);
export const lstat   = (path, options)         => p.lstat(path, options);
export const fstat   = (handle, options)       => p.fstat(handle, options);   // FileHandle compat
export const utimes  = (path, atime, mtime)    => p.utimes(path, atime, mtime);
export const futimes = (handle, atime, mtime)  => p.futimes(handle, atime, mtime);

// ── Links ─────────────────────────────────────────────────────────────────────

export const link      = (existingPath, newPath) => p.link(existingPath, newPath);
export const symlink   = (target, path, type)    => p.symlink(target, path, type);
export const readlink  = (path, options)         => p.readlink(path, options);
export const realpath  = (path, options)         => p.realpath(path, options);

// ── Permissions ───────────────────────────────────────────────────────────────

export const chmod  = (path, mode)              => p.chmod(path, mode);
export const lchmod = (path, mode)              => p.lchmod(path, mode);
export const chown  = (path, uid, gid)          => p.chown(path, uid, gid);
export const lchown = (path, uid, gid)          => p.lchown(path, uid, gid);

// ── Low-level read/write (FileHandle-style) ───────────────────────────────────
// memfs exposes these via the opened file descriptor handle returned by open().
// We wrap them here so callers get a consistent interface.

export const read = (handle, buffer, offset, length, position) =>
  p.read
    ? p.read(handle, buffer, offset, length, position)
    : Promise.reject(new Error('fs.promises.read not supported by this runtime'));

export const write = (handle, buffer, offset, length, position) =>
  p.write
    ? p.write(handle, buffer, offset, length, position)
    : Promise.reject(new Error('fs.promises.write not supported by this runtime'));

// ── Constants re-export ───────────────────────────────────────────────────────
// Node's `fs/promises` does NOT export constants itself — callers are expected
// to import them from `fs` or `fs/promises` depending on version.
// We export them anyway for convenience, matching the Node ≥18 behaviour.

export { constants };

// ── Default export (mirrors `import fsPromises from 'fs/promises'`) ───────────

const fsPromises = {
  access,
  open,
  readFile,
  writeFile,
  appendFile,
  truncate,
  copyFile,
  rename,
  unlink,
  mkdir,
  mkdtemp,
  opendir,
  readdir,
  rmdir,
  rm,
  stat,
  lstat,
  fstat,
  utimes,
  futimes,
  link,
  symlink,
  readlink,
  realpath,
  chmod,
  lchmod,
  chown,
  lchown,
  read,
  write,
  constants,
};

export default fsPromises;
