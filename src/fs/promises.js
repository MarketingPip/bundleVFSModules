/**
 * fs/promises — re-exports the promises API built by src/fs.js.
 *
 * The full implementation (FileHandle, error enrichment, event emission)
 * lives in ../fs.js; this module only re-exports it so that
 * `node:fs/promises` resolves here, mirroring Node's own layout.
 */

import fs from '../fs.js';

const p = fs.promises;

export const access = p.access.bind(p);
export const appendFile = p.appendFile.bind(p);
export const chmod = p.chmod.bind(p);
export const chown = p.chown.bind(p);
export const copyFile = p.copyFile.bind(p);
export const cp = p.cp.bind(p);
export const glob = p.glob.bind(p);
export const lchmod = p.lchmod.bind(p);
export const lchown = p.lchown.bind(p);
export const link = p.link.bind(p);
export const lstat = p.lstat.bind(p);
export const lutimes = p.lutimes.bind(p);
export const mkdir = p.mkdir.bind(p);
export const mkdtemp = p.mkdtemp.bind(p);
export const mkdtempDisposable = p.mkdtempDisposable.bind(p);
export const open = p.open.bind(p);
export const opendir = p.opendir.bind(p);
export const readdir = p.readdir.bind(p);
export const readFile = p.readFile.bind(p);
export const readlink = p.readlink.bind(p);
export const realpath = p.realpath.bind(p);
export const rename = p.rename.bind(p);
export const rm = p.rm.bind(p);
export const rmdir = p.rmdir.bind(p);
export const stat = p.stat.bind(p);
export const statfs = p.statfs.bind(p);
export const symlink = p.symlink.bind(p);
export const truncate = p.truncate.bind(p);
export const unlink = p.unlink.bind(p);
export const utimes = p.utimes.bind(p);
export const watch = p.watch.bind(p);
export const writeFile = p.writeFile.bind(p);

export const constants = p.constants;

const fsPromises = {
  access, appendFile, chmod, chown, copyFile, cp, glob,
  lchmod, lchown, link, lstat, lutimes, mkdir, mkdtemp,
  mkdtempDisposable, open, opendir, readdir, readFile, readlink, realpath,
  rename, rm, rmdir, stat, statfs, symlink, truncate, unlink,
  utimes, watch, writeFile, constants,
};

export default p;
