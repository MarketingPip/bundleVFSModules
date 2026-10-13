// parity/fs-promises-harness.mjs — harness wrapper for node:fs/promises.
//
// Re-exports the wrapped promises API from fs-harness.mjs (which syncs
// real-disk tmpdir/fixtures into memfs on access and restores the timer
// globals that als-browser pollutes). Harness-only; src/ is untouched.
import { promises as _p } from "./fs-harness.mjs";

export default _p;
export const constants = _p.constants;
export const access = _p.access;
export const open = _p.open;
export const readFile = _p.readFile;
export const writeFile = _p.writeFile;
export const appendFile = _p.appendFile;
export const truncate = _p.truncate;
export const copyFile = _p.copyFile;
export const rename = _p.rename;
export const unlink = _p.unlink;
export const mkdir = _p.mkdir;
export const mkdtemp = _p.mkdtemp;
export const mkdtempDisposable = _p.mkdtempDisposable;
export const opendir = _p.opendir;
export const readdir = _p.readdir;
export const rmdir = _p.rmdir;
export const rm = _p.rm;
export const stat = _p.stat;
export const lstat = _p.lstat;
export const link = _p.link;
export const symlink = _p.symlink;
export const readlink = _p.readlink;
export const realpath = _p.realpath;
export const chmod = _p.chmod;
export const chown = _p.chown;
export const lchown = _p.lchown;
export const utimes = _p.utimes;
export const lutimes = _p.lutimes;
export const cp = _p.cp;
export const statfs = _p.statfs;
export const glob = _p.glob;
export const watch = _p.watch;
export const lchmod = _p.lchmod;
