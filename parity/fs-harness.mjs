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

// Route process.chdir/process.cwd through a virtual cwd (Jared's finding:
// these 3 failures are not inherent — the shim can track virtual cwd). The
// fs shim resolves relative paths via the global process.cwd(), so patching
// the globals makes relative-path resolution follow the virtual cwd.
// Harness-only; src/ is untouched.
const _origProcessCwd = process.cwd.bind(process);
let _virtualCwd = null; // set on first chdir; null = use real cwd
process.cwd = () => _virtualCwd ?? _origProcessCwd();
process.chdir = (dir) => {
  if (typeof dir !== "string")
    throw new TypeError(`The "directory" argument must be of type string`);
  syncArgs([dir]);
  // Resolve against current virtual cwd (mirrors src/process.js _absPath).
  const base = _virtualCwd ?? _origProcessCwd();
  const target = realPath.resolve(base, dir);
  // Ensure the target exists in memfs so the shim's path resolution works.
  // For paths outside the test roots (e.g. restoring the real originalCwd
  // at test end), mkdir -p an empty placeholder — the test doesn't read
  // through it, it just needs chdir not to throw.
  try {
    raw.mkdirSync(target, { recursive: true });
  } catch {}
  // Publish to the __FS__ singleton: shim's process.cwd() reads fs_.cwd.
  const fsSingleton = globalThis._RUNTIME_ && globalThis._RUNTIME_.__FS__;
  if (fsSingleton) fsSingleton.cwd = target;
  _virtualCwd = target;
};

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
// is scratch (cleaned per test process); fixtures is read-only test data.
// testRoot covers the test files themselves (tests open __filename).
const syncRoots = [tmpdir, fixturesDir, testRoot];

// Raw shim methods for the sync itself — never the wrapped versions below,
// or syncPath would recurse into itself.
const raw = shimFs;

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
    // Skip null-byte paths: they're invalid (ERR_INVALID_ARG_VALUE), let the
    // shim's validatePath throw instead of syncing garbage.
    if (p && p.includes("\0")) continue;
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

function wrapFn(fn, methodName) {
  // new-aware: classes (Dir, ReadStream, …) are constructed in the tests
  // (`new fs.Dir()`, `new ReadStream(tmpfile)`), so route construction
  // through Reflect.construct instead of breaking it with .apply().
  function wrapped(...args) {
    // If the test chdir'd into a directory and then deleted it, relative
    // paths must fail with ENOENT (real Node: the OS can't resolve against
    // a deleted cwd). Check before syncing.
    if (_virtualCwd) {
      let cwdExists = false;
      try {
        raw.statSync(_virtualCwd);
        cwdExists = true;
      } catch {}
      if (!cwdExists) {
        for (const a of args) {
          let p = null;
          if (typeof a === "string") p = a;
          else if (typeof Buffer !== "undefined" && Buffer.isBuffer(a))
            p = a.toString();
          if (p && !realPath.isAbsolute(p)) {
            const syscall = (methodName || "open").replace(/Sync$/, "");
            const err = new Error(
              `ENOENT: no such file or directory, ${syscall} '${p}'`,
            );
            err.code = "ENOENT";
            err.syscall = syscall;
            err.path = p;
            // Async (callback-style) APIs deliver via callback, not throw.
            const lastArg = args[args.length - 1];
            if (typeof lastArg === "function" && !methodName.endsWith("Sync")) {
              // Defer to match Node's async error delivery.
              queueMicrotask(() => lastArg(err));
              return;
            }
            throw err;
          }
        }
      }
    }
    syncArgs(args);
    if (new.target) return Reflect.construct(fn, args, new.target);
    return Reflect.apply(fn, this, args);
  }
  Object.setPrototypeOf(wrapped, Object.getPrototypeOf(fn));
  if (fn.prototype) wrapped.prototype = fn.prototype;
  // Preserve .native (realpath.native, realpathSync.native) and other
  // own function properties that tests access.
  for (const k of Object.getOwnPropertyNames(fn)) {
    if (
      k !== "length" &&
      k !== "name" &&
      k !== "prototype" &&
      !(k in wrapped)
    ) {
      try {
        const d = Object.getOwnPropertyDescriptor(fn, k);
        if (d) Object.defineProperty(wrapped, k, d);
      } catch {}
    }
  }
  return wrapped;
}

function wrapObj(obj) {
  const out = { ...obj };
  for (const k of Object.keys(out)) {
    if (typeof out[k] === "function") out[k] = wrapFn(out[k], k);
  }
  // Symbol keys (e.g. util.promisify.custom) must survive the wrap.
  for (const s of Object.getOwnPropertySymbols(obj)) {
    if (typeof obj[s] === "function") out[s] = wrapFn(obj[s], s.toString());
  }
  // Non-enumerable getter-only props (F_OK/R_OK/W_OK/X_OK) must survive:
  // spread skips them, but tests assert assignment throws TypeError.
  for (const k of ["F_OK", "R_OK", "W_OK", "X_OK"]) {
    const d = Object.getOwnPropertyDescriptor(obj, k);
    if (d && !Object.getOwnPropertyDescriptor(out, k)) {
      Object.defineProperty(out, k, d);
    }
  }
  // constants is non-enumerable in some builds; ensure it's present.
  if (!("constants" in out) && "constants" in obj) {
    out.constants = obj.constants;
  }
  return out;
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
