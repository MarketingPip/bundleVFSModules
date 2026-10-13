// parity/fs-harness.mjs — harness-only wrapper around the fs shim.
//
// Why this exists: Node's official fs tests stage fixtures on REAL disk
// (test/common tmpdir), but the shim under test is memfs-backed and cannot
// see them — 227/349 tests failed with ENOENT for this reason alone. This
// wrapper syncs real-disk state under the test tmpdir into the shim's memfs
// volume on access (sync-on-access: tests create files mid-test, so
// pre-seeding is insufficient).
//
// Harness-only: src/fs.js is untouched. In the browser there is no real
// disk, so this mismatch exists only in the parity harness. Fix the
// harness, never the product.
import realFs from "node:fs";
import realPath from "node:path";
import { fileURLToPath } from "node:url";

import shimFs from "../src/fs.js";

// als-browser (pulled in via async_hooks → events → stream → fs) replaces
// the timer globals on import, which trips Node's official-test global-leak
// detector. Restore the originals snapshotted in preload.mjs: the shim keeps
// working (it captured its own references). Harness-only; src/ is untouched.
const _origTimers = globalThis.__PARITY_ORIG_TIMERS__;
if (_origTimers) {
  for (const k of Object.keys(_origTimers)) {
    try {
      globalThis[k] = _origTimers[k];
    } catch {}
  }
}

const repoRoot = realPath.resolve(
  realPath.dirname(fileURLToPath(import.meta.url)),
  "..",
);
// Mirror parity/node-test/common/tmpdir.js.
const testRoot = process.env.NODE_TEST_DIR
  ? realFs.realpathSync(process.env.NODE_TEST_DIR)
  : realPath.join(repoRoot, "parity", "node-test");
const tmpdir = realPath.join(
  testRoot,
  ".tmp." + (process.env.TEST_SERIAL_ID || process.env.TEST_THREAD_ID || "0"),
);
const fixturesDir = realPath.join(testRoot, "fixtures");
// Sync roots: real-disk trees the official tests treat as readable. tmpdir
// is scratch (cleaned per test process); fixtures is read-only test data;
// the parallel dir holds the test files themselves (__filename).
const syncRoots = [tmpdir, fixturesDir, realPath.join(testRoot, "parallel")];

// Raw shim methods for the sync itself — never the wrapped versions below,
// or syncPath would recurse into itself. wrapObj() below wraps IN PLACE
// (so test monkey-patches hit the same object the stream internals use),
// so snapshot the unwrapped methods FIRST — after wrapping, `raw` would be
// the wrapped versions and syncPath would recurse forever.
const raw = {};
for (const k of Object.keys(shimFs)) {
  if (typeof shimFs[k] === "function") raw[k] = shimFs[k];
}
if (shimFs.promises) {
  raw.promises = {};
  for (const k of Object.keys(shimFs.promises)) {
    if (typeof shimFs.promises[k] === "function")
      raw.promises[k] = shimFs.promises[k];
  }
}

// Hermetic tmpdir per test process (mirrors common.refresh()): stale files
// from earlier runs must not leak into memfs via the sync below.
try {
  realFs.rmSync(tmpdir, { recursive: true, force: true });
} catch {}
try {
  realFs.mkdirSync(tmpdir, { recursive: true });
} catch {}
// The tmpdir itself must exist in memfs too: common creates it via real fs,
// but the test writes through the shim (e.g. writeFileSync into tmpdir).
try {
  raw.mkdirSync(tmpdir, { recursive: true });
} catch {}

const underSyncRoot = (p) =>
  syncRoots.some((r) => p === r || p.startsWith(r + realPath.sep));
const syncedDirs = new Map(); // real dir path -> real mtimeMs at sync time

function syncPath(p) {
  let st;
  try {
    st = realFs.lstatSync(p);
  } catch {
    return; // nothing on disk: the shim's own ENOENT stands
  }
  if (st.isSymbolicLink()) {
    // Mirror the link itself, not its target.
    let cur = null;
    try {
      cur = raw.lstatSync(p);
    } catch {}
    if (!cur) {
      try {
        raw.mkdirSync(realPath.dirname(p), { recursive: true });
        raw.symlinkSync(realFs.readlinkSync(p), p);
      } catch {}
    }
    return;
  }
  if (st.isDirectory()) {
    if (syncedDirs.get(p) === st.mtimeMs) return;
    syncedDirs.set(p, st.mtimeMs);
    try {
      raw.mkdirSync(p, { recursive: true });
    } catch {}
    let names;
    try {
      names = realFs.readdirSync(p);
    } catch {
      return;
    }
    for (const n of names) syncPath(realPath.join(p, n));
    return;
  }
  if (st.isFile()) {
    let cur = null;
    try {
      cur = raw.statSync(p);
    } catch {}
    // Never clobber something the test wrote through the shim after the
    // real file appeared: copy only when memfs lacks it or disk is newer.
    if (!cur || st.mtimeMs > cur.mtimeMs) {
      try {
        raw.mkdirSync(realPath.dirname(p), { recursive: true });
        raw.writeFileSync(p, realFs.readFileSync(p));
      } catch {}
    }
  }
  // sockets, fifos, etc: leave to the shim
}

function syncArgs(args) {
  for (const a of args) {
    let p = null;
    if (typeof a === "string") p = a;
    else if (typeof Buffer !== "undefined" && Buffer.isBuffer(a))
      p = a.toString();
    else if (a instanceof URL && a.protocol === "file:") p = fileURLToPath(a);
    if (p && underSyncRoot(p)) {
      // The test may create this path through the shim (it won't exist on
      // real disk): make sure its parent chain exists in memfs first.
      try {
        raw.mkdirSync(realPath.dirname(p), { recursive: true });
      } catch {}
      syncPath(p);
    }
  }
}

function wrapFn(fn) {
  // new-aware: classes (Dir, ReadStream, …) are constructed in the tests
  // (`new fs.Dir()`, `new ReadStream(tmpfile)`), so route construction
  // through Reflect.construct instead of breaking it with .apply().
  function wrapped(...args) {
    syncArgs(args);
    if (new.target) return Reflect.construct(fn, args, new.target);
    return Reflect.apply(fn, this, args);
  }
  Object.setPrototypeOf(wrapped, Object.getPrototypeOf(fn));
  if (fn.prototype) wrapped.prototype = fn.prototype;
  return wrapped;
}

function wrapObj(obj) {
  // Wrap IN PLACE (not a copy): the tests monkey-patch the required fs
  // object (e.g. test-fs-write-stream.js replaces fs.close and asserts the
  // stream calls it), and the stream internals in src/fs.js call fs.close
  // on that same object. A copy would hide the patch from the internals.
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === "function") obj[k] = wrapFn(obj[k]);
  }
  return obj;
}

const wrapped = wrapObj(shimFs);
wrapped.promises = wrapObj(shimFs.promises);

export default wrapped;

// src/fs.js's non-function named exports (classes / utils): re-export raw.
export { Stats, Dirent, Utf8Stream, _toUnixTimestamp } from "../src/fs.js";

// Named function exports, wrapped (list generated from src/fs.js).
export const access = wrapped.access;
export const accessSync = wrapped.accessSync;
export const appendFile = wrapped.appendFile;
export const appendFileSync = wrapped.appendFileSync;
export const chmod = wrapped.chmod;
export const chmodSync = wrapped.chmodSync;
export const chown = wrapped.chown;
export const chownSync = wrapped.chownSync;
export const close = wrapped.close;
export const closeSync = wrapped.closeSync;
export const copyFile = wrapped.copyFile;
export const copyFileSync = wrapped.copyFileSync;
export const cp = wrapped.cp;
export const cpSync = wrapped.cpSync;
export const createReadStream = wrapped.createReadStream;
export const createWriteStream = wrapped.createWriteStream;
export const exists = wrapped.exists;
export const existsSync = wrapped.existsSync;
export const fchmod = wrapped.fchmod;
export const fchmodSync = wrapped.fchmodSync;
export const fchown = wrapped.fchown;
export const fchownSync = wrapped.fchownSync;
export const fdatasync = wrapped.fdatasync;
export const fdatasyncSync = wrapped.fdatasyncSync;
export const fstat = wrapped.fstat;
export const fstatSync = wrapped.fstatSync;
export const fsync = wrapped.fsync;
export const fsyncSync = wrapped.fsyncSync;
export const ftruncate = wrapped.ftruncate;
export const ftruncateSync = wrapped.ftruncateSync;
export const futimes = wrapped.futimes;
export const futimesSync = wrapped.futimesSync;
export const glob = wrapped.glob;
export const globSync = wrapped.globSync;
export const lchmod = wrapped.lchmod;
export const lchmodSync = wrapped.lchmodSync;
export const lchown = wrapped.lchown;
export const lchownSync = wrapped.lchownSync;
export const link = wrapped.link;
export const linkSync = wrapped.linkSync;
export const lstat = wrapped.lstat;
export const lstatSync = wrapped.lstatSync;
export const lutimes = wrapped.lutimes;
export const lutimesSync = wrapped.lutimesSync;
export const mkdir = wrapped.mkdir;
export const mkdirSync = wrapped.mkdirSync;
export const mkdtemp = wrapped.mkdtemp;
export const mkdtempSync = wrapped.mkdtempSync;
export const mkdtempDisposableSync = wrapped.mkdtempDisposableSync;
export const open = wrapped.open;
export const openSync = wrapped.openSync;
export const openAsBlob = wrapped.openAsBlob;
export const opendir = wrapped.opendir;
export const opendirSync = wrapped.opendirSync;
export const read = wrapped.read;
export const readSync = wrapped.readSync;
export const readdir = wrapped.readdir;
export const readdirSync = wrapped.readdirSync;
export const readFile = wrapped.readFile;
export const readFileSync = wrapped.readFileSync;
export const readlink = wrapped.readlink;
export const readlinkSync = wrapped.readlinkSync;
export const readv = wrapped.readv;
export const readvSync = wrapped.readvSync;
export const realpath = wrapped.realpath;
export const realpathSync = wrapped.realpathSync;
export const rename = wrapped.rename;
export const renameSync = wrapped.renameSync;
export const rm = wrapped.rm;
export const rmSync = wrapped.rmSync;
export const rmdir = wrapped.rmdir;
export const rmdirSync = wrapped.rmdirSync;
export const stat = wrapped.stat;
export const statSync = wrapped.statSync;
export const statfs = wrapped.statfs;
export const statfsSync = wrapped.statfsSync;
export const symlink = wrapped.symlink;
export const symlinkSync = wrapped.symlinkSync;
export const truncate = wrapped.truncate;
export const truncateSync = wrapped.truncateSync;
export const unlink = wrapped.unlink;
export const unlinkSync = wrapped.unlinkSync;
export const utimes = wrapped.utimes;
export const utimesSync = wrapped.utimesSync;
export const watch = wrapped.watch;
export const watchFile = wrapped.watchFile;
export const unwatchFile = wrapped.unwatchFile;
export const write = wrapped.write;
export const writeSync = wrapped.writeSync;
export const writeFile = wrapped.writeFile;
export const writeFileSync = wrapped.writeFileSync;
export const writev = wrapped.writev;
export const writevSync = wrapped.writevSync;
export const Dir = wrapped.Dir;
export const ReadStream = wrapped.ReadStream;
export const WriteStream = wrapped.WriteStream;
export const FileReadStream = wrapped.FileReadStream;
export const FileWriteStream = wrapped.FileWriteStream;
export const promises = wrapped.promises;
export const constants = wrapped.constants;
