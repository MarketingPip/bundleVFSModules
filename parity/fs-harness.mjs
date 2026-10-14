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
// System files the official tests read directly (not under syncRoots).
// These exist on real disk in the harness (Node) but not in memfs;
// sync them on demand so the shim can read them (e.g. /proc files on Linux).
const systemFiles = [
  "/proc/sys/kernel/hostname",
  "/usr/bin/node",
  process.execPath,
].filter((p, i, a) => p && a.indexOf(p) === i);

// Raw shim methods for the sync itself — a SNAPSHOT of the pristine functions,
// never the wrapped versions below, or syncPath would recurse into itself.
// (The harness wraps shimFs in place further down so test monkey-patches land
// on the same object the shim's streams look up at call time; `raw` must keep
// pointing at the originals.)
const raw = {};
for (const k of Object.keys(shimFs)) raw[k] = shimFs[k];
for (const s of Object.getOwnPropertySymbols(shimFs)) raw[s] = shimFs[s];
raw.promises = {};
for (const k of Object.keys(shimFs.promises))
  raw.promises[k] = shimFs.promises[k];
for (const s of Object.getOwnPropertySymbols(shimFs.promises))
  raw.promises[s] = shimFs.promises[s];

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
  syncRoots.some((r) => p === r || p.startsWith(r + realPath.sep)) ||
  systemFiles.includes(p) ||
  p.startsWith(repoRoot + realPath.sep + "test" + realPath.sep);
const syncedDirs = new Map(); // real dir path -> real mtimeMs at sync time

function syncPath(p) {
  // Redirect Node.js repo-layout paths (test/...) to the parity mirror
  // (parity/node-test/...). Official tests assume the Node.js repo root.
  const repoTestPrefix = repoRoot + realPath.sep + "test" + realPath.sep;
  let srcPath = p;
  if (p.startsWith(repoTestPrefix)) {
    srcPath = realPath.join(testRoot, p.slice(repoTestPrefix.length));
  }
  let st;
  try {
    st = realFs.lstatSync(srcPath);
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
        raw.symlinkSync(realFs.readlinkSync(srcPath), p);
      } catch {}
    }
    return;
  }
  if (st.isDirectory()) {
    if (syncedDirs.get(srcPath) === st.mtimeMs) return;
    syncedDirs.set(srcPath, st.mtimeMs);
    try {
      raw.mkdirSync(p, { recursive: true });
    } catch {}
    let names;
    try {
      names = realFs.readdirSync(srcPath);
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
    // Preserve the real-disk mtimes so tests that compare link vs target
    // mtimes (test-fs-symlink-buffer-path.js) see the real age gap, not
    // two files both stamped "now".
    if (!cur || st.mtimeMs > cur.mtimeMs) {
      try {
        raw.mkdirSync(realPath.dirname(p), { recursive: true });
        raw.writeFileSync(p, realFs.readFileSync(srcPath));
        raw.utimesSync(p, st.atime, st.mtime);
      } catch {}
    }
  }
  // sockets, fifos, etc: leave to the shim
}

function syncArgs(args, methodName) {
  // For link/symlink, args[0] is the TARGET: its parent chain must not be
  // eagerly created (the target's parent may itself be a symlink the test
  // creates later — test-fs-realpath.js test_deep_symlink_mix). The dedicated
  // target sync in wrapFn handles targets; syncArgs only prepares link paths.
  const skipTarget =
    methodName === "symlink" ||
    methodName === "symlinkSync" ||
    methodName === "link" ||
    methodName === "linkSync";
  for (let i = 0; i < args.length; i++) {
    if (skipTarget && i === 0) continue;
    const a = args[i];
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
      // Exception: mkdtemp/mkdtempSync must fail with ENOENT when the parent
      // doesn't exist — don't create it for them (test-fs-error-messages).
      if (methodName !== "mkdtemp" && methodName !== "mkdtempSync") {
        try {
          raw.mkdirSync(realPath.dirname(p), { recursive: true });
        } catch {}
      }
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
    syncArgs(args, methodName);
    // Symlink/hardlink targets: a test may link to an absolute path under a
    // sync root (e.g. fixtures.path("cycles", "root.js")) that exists on real
    // disk but was never passed to an fs call itself. Resolve the target the
    // way the filesystem does (relative to the link's directory) and sync it
    // so the shim's memfs can resolve through the link
    // (test-fs-realpath.js deep-relative symlinks,
    // test-fs-symlink-buffer-path.js Buffer target).
    if (
      methodName === "symlink" ||
      methodName === "symlinkSync" ||
      methodName === "link" ||
      methodName === "linkSync"
    ) {
      let target = args[0];
      let linkPath = args[1];
      if (typeof Buffer !== "undefined" && Buffer.isBuffer(target))
        target = target.toString();
      if (typeof Buffer !== "undefined" && Buffer.isBuffer(linkPath))
        linkPath = linkPath.toString();
      if (typeof target === "string" && typeof linkPath === "string") {
        const absTarget = realPath.resolve(realPath.dirname(linkPath), target);
        if (underSyncRoot(absTarget)) syncPath(absTarget);
      }
    }
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
  // Preserve symbol-keyed own properties (e.g. util.promisify.custom).
  for (const s of Object.getOwnPropertySymbols(fn)) {
    if (!(s in wrapped)) {
      try {
        const d = Object.getOwnPropertyDescriptor(fn, s);
        if (d) Object.defineProperty(wrapped, s, d);
      } catch {}
    }
  }
  return wrapped;
}

// Wrap the shim's methods IN PLACE (not on a copy). Node's contract is that
// streams look up fs methods on the fs module object at call time, so a test
// monkey-patch (fs.close = ..., t.mock.method(fs, "fsync")) must land on the
// SAME object the shim closes over — otherwise the patch is invisible to
// already-created streams (test-fs-write-stream.js, test-fs-write-stream-err.js,
// test-fs-*-flush.js). The sync engine keeps using `raw` (snapshot above).
function wrapInPlace(obj) {
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === "function") obj[k] = wrapFn(obj[k], k);
  }
  // Symbol keys (e.g. util.promisify.custom) must survive the wrap.
  for (const s of Object.getOwnPropertySymbols(obj)) {
    if (typeof obj[s] === "function") obj[s] = wrapFn(obj[s], s.toString());
  }
}

wrapInPlace(shimFs);
wrapInPlace(shimFs.promises);

export default shimFs;

// src/fs.js's non-function named exports (classes / utils): re-export raw.
export { Stats, Dirent, Utf8Stream, _toUnixTimestamp } from "../src/fs.js";

// Named function exports, wrapped (list generated from src/fs.js).
export const access = shimFs.access;
export const accessSync = shimFs.accessSync;
export const appendFile = shimFs.appendFile;
export const appendFileSync = shimFs.appendFileSync;
export const chmod = shimFs.chmod;
export const chmodSync = shimFs.chmodSync;
export const chown = shimFs.chown;
export const chownSync = shimFs.chownSync;
export const close = shimFs.close;
export const closeSync = shimFs.closeSync;
export const copyFile = shimFs.copyFile;
export const copyFileSync = shimFs.copyFileSync;
export const cp = shimFs.cp;
export const cpSync = shimFs.cpSync;
export const createReadStream = shimFs.createReadStream;
export const createWriteStream = shimFs.createWriteStream;
export const exists = shimFs.exists;
export const existsSync = shimFs.existsSync;
export const fchmod = shimFs.fchmod;
export const fchmodSync = shimFs.fchmodSync;
export const fchown = shimFs.fchown;
export const fchownSync = shimFs.fchownSync;
export const fdatasync = shimFs.fdatasync;
export const fdatasyncSync = shimFs.fdatasyncSync;
export const fstat = shimFs.fstat;
export const fstatSync = shimFs.fstatSync;
export const fsync = shimFs.fsync;
export const fsyncSync = shimFs.fsyncSync;
export const ftruncate = shimFs.ftruncate;
export const ftruncateSync = shimFs.ftruncateSync;
export const futimes = shimFs.futimes;
export const futimesSync = shimFs.futimesSync;
export const glob = shimFs.glob;
export const globSync = shimFs.globSync;
export const lchmod = shimFs.lchmod;
export const lchmodSync = shimFs.lchmodSync;
export const lchown = shimFs.lchown;
export const lchownSync = shimFs.lchownSync;
export const link = shimFs.link;
export const linkSync = shimFs.linkSync;
export const lstat = shimFs.lstat;
export const lstatSync = shimFs.lstatSync;
export const lutimes = shimFs.lutimes;
export const lutimesSync = shimFs.lutimesSync;
export const mkdir = shimFs.mkdir;
export const mkdirSync = shimFs.mkdirSync;
export const mkdtemp = shimFs.mkdtemp;
export const mkdtempSync = shimFs.mkdtempSync;
export const mkdtempDisposableSync = shimFs.mkdtempDisposableSync;
export const open = shimFs.open;
export const openSync = shimFs.openSync;
export const openAsBlob = shimFs.openAsBlob;
export const opendir = shimFs.opendir;
export const opendirSync = shimFs.opendirSync;
export const read = shimFs.read;
export const readSync = shimFs.readSync;
export const readdir = shimFs.readdir;
export const readdirSync = shimFs.readdirSync;
export const readFile = shimFs.readFile;
export const readFileSync = shimFs.readFileSync;
export const readlink = shimFs.readlink;
export const readlinkSync = shimFs.readlinkSync;
export const readv = shimFs.readv;
export const readvSync = shimFs.readvSync;
export const realpath = shimFs.realpath;
export const realpathSync = shimFs.realpathSync;
export const rename = shimFs.rename;
export const renameSync = shimFs.renameSync;
export const rm = shimFs.rm;
export const rmSync = shimFs.rmSync;
export const rmdir = shimFs.rmdir;
export const rmdirSync = shimFs.rmdirSync;
export const stat = shimFs.stat;
export const statSync = shimFs.statSync;
export const statfs = shimFs.statfs;
export const statfsSync = shimFs.statfsSync;
export const symlink = shimFs.symlink;
export const symlinkSync = shimFs.symlinkSync;
export const truncate = shimFs.truncate;
export const truncateSync = shimFs.truncateSync;
export const unlink = shimFs.unlink;
export const unlinkSync = shimFs.unlinkSync;
export const utimes = shimFs.utimes;
export const utimesSync = shimFs.utimesSync;
export const watch = shimFs.watch;
export const watchFile = shimFs.watchFile;
export const unwatchFile = shimFs.unwatchFile;
export const write = shimFs.write;
export const writeSync = shimFs.writeSync;
export const writeFile = shimFs.writeFile;
export const writeFileSync = shimFs.writeFileSync;
export const writev = shimFs.writev;
export const writevSync = shimFs.writevSync;
export const Dir = shimFs.Dir;
export const ReadStream = shimFs.ReadStream;
export const WriteStream = shimFs.WriteStream;
export const FileReadStream = shimFs.FileReadStream;
export const FileWriteStream = shimFs.FileWriteStream;
export const promises = shimFs.promises;
export const constants = shimFs.constants;
