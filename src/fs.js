// src/fs.js — memfs-backed node:fs for the browser runtime.
//
// The filesystem engine is memfs (an in-memory Node fs implementation,
// declared in package.json dependencies). This module wraps it in a
// Node.js v24-shaped façade: Node-shaped Stats/Dirent, numeric errno +
// syscall enrichment, error-message parity, and the runtime integration
// contract below.
//
// Runtime contract (see AGENTS.md "The _RUNTIME_ contract"):
// - Reference the host only through the exact expression
//   `globalThis._RUNTIME_` (the runtime AST-rewrites that MemberExpression
//   per sandbox); guard with `typeof globalThis._RUNTIME_ !== "undefined"`
//   so the module also loads standalone (tests, direct import).
// - Publish/reuse the singleton `globalThis._RUNTIME_.__FS__`.
// - `__FS__._vol` is the actual memfs Volume (the runtime calls
//   `_vol.toJSON()` and `readFileSync()` on it).
// - The volume is seeded from `globalThis._RUNTIME_.__USER_FILES__`
//   (flat `{ "/path": contents }`).
// - Every operation emits `emitMe('fs', ...)` for runtime observability.
// - Read/write streams use the project's local stream implementation
//   (src/stream.js), never memfs's.

import { Volume, createFsFromVolume } from "memfs";
import { Readable, Writable } from "./stream.js";
import { errorOrDestroy } from "./stream/destroy.js";

// Browser-safe nextTick (process.nextTick under Node, queueMicrotask otherwise).
function nextTick(fn, ...args) {
  try {
    if (
      typeof process !== "undefined" &&
      typeof process.nextTick === "function"
    ) {
      process.nextTick(fn, ...args);
      return;
    }
  } catch {
    /* ignore */
  }
  if (typeof queueMicrotask === "function") queueMicrotask(() => fn(...args));
  else setTimeout(() => fn(...args), 0);
}

// ── 1. Runtime bridge (guarded) ─────────────────────────────────────────────
// Always spell the host reference exactly `globalThis._RUNTIME_`.
function getRuntime() {
  return typeof globalThis._RUNTIME_ !== "undefined"
    ? globalThis._RUNTIME_
    : undefined;
}
function emitFs(...args) {
  if (typeof globalThis.emitMe === "function") {
    try {
      globalThis.emitMe(...args);
    } catch {
      /* observability only */
    }
  }
}

// ── 2. Error infrastructure ─────────────────────────────────────────────────
// Numeric errno values (negative, as in process.binding('uv')).
const ERRNO_BY_CODE = {
  EPERM: -1,
  ENOENT: -2,
  ESRCH: -3,
  EINTR: -4,
  EIO: -5,
  ENXIO: -6,
  EBADF: -9,
  EAGAIN: -11,
  ENOMEM: -12,
  EACCES: -13,
  EFAULT: -14,
  EBUSY: -16,
  EEXIST: -17,
  EXDEV: -18,
  ENODEV: -19,
  ENOTDIR: -20,
  EISDIR: -21,
  EINVAL: -22,
  ENFILE: -23,
  EMFILE: -24,
  ETXTBSY: -26,
  EFBIG: -27,
  ENOSPC: -28,
  ESPIPE: -29,
  EROFS: -30,
  EMLINK: -31,
  EPIPE: -32,
  EDOM: -33,
  ERANGE: -34,
  ENOLCK: -37,
  ENOSYS: -38,
  ELOOP: -40,
  ENODATA: -61,
  ETIME: -62,
  ENOTEMPTY: -39,
  EOVERFLOW: -75,
  EOPNOTSUPP: -95,
  // Node JS-level fs errors that still carry errno/syscall:
  ERR_FS_EISDIR: 21,
  ERR_FS_CP_EINVAL: 22,
  ERR_FS_CP_NON_DIR_TO_DIR: 22,
  ERR_FS_CP_DIR_TO_NON_DIR: 22,
};

// syscall probe results against real Node v24.20.0.
const SYSCALL_BY_METHOD = {
  readFile: "open",
  writeFile: "open",
  appendFile: "open",
  stat: "stat",
  lstat: "lstat",
  fstat: "fstat",
  readdir: "scandir",
  mkdir: "mkdir",
  unlink: "unlink",
  rename: "rename",
  copyFile: "copyfile",
  rmdir: "rmdir",
  realpath: "realpath",
  readlink: "readlink",
  access: "access",
  open: "open",
  opendir: "opendir",
  rm: "rm",
  cp: "lstat",
  lutimes: "lutime",
  mkdtemp: "mkdtemp",
  statfs: "statfs",
  chmod: "chmod",
  lchmod: "chmod",
  utimes: "utime",
  futimes: "futime",
  truncate: "open",
  ftruncate: "ftruncate",
  close: "close",
  read: "read",
  write: "write",
  fsync: "fsync",
  fdatasync: "fdatasync",
  link: "link",
  symlink: "symlink",
  chown: "chown",
  lchown: "lchown",
  fchmod: "fchmod",
  fchown: "fchown",
};

function makeFsError(code, syscall, path, message) {
  const err = new Error(
    `${code}: ${message}, ${syscall}${path !== undefined ? ` '${path}'` : ""}`,
  );
  err.code = code;
  // errno is filled by enrichErr from ERRNO_BY_CODE; JS validation errors
  // (ERR_*) carry no errno in real Node, so no default is set here.
  err.syscall = syscall;
  if (path !== undefined) err.path = path;
  return err;
}

function errInvalidArgType(name, expected, received) {
  // Matches Node's format exactly, e.g.:
  // `The "fd" argument must be of type number. Received type string ('')`
  // `The "fd" argument must be of type number. Received an instance of Object`
  let what;
  if (received === undefined) what = "undefined";
  else if (received === null) what = "null";
  else if (typeof received === "object") {
    what = `an instance of ${
      received.constructor ? received.constructor.name : "Object"
    }`;
  } else {
    const inspected =
      typeof received === "string"
        ? `'${received.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
        : String(received);
    what = `type ${typeof received} (${inspected})`;
  }
  const err = new TypeError(
    `The "${name}" argument must be of type ${expected}. Received ${what}`,
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
}

// JS-level validation errors carry no syscall/errno in real Node.
const NO_ENRICH_CODES = new Set([
  "ERR_INVALID_ARG_TYPE",
  "ERR_OUT_OF_RANGE",
  "ERR_DIR_CLOSED",
  "ERR_INVALID_ARG_VALUE",
  "ERR_INVALID_OPT_VALUE",
  "ABORT_ERR",
  "ERR_FS_FILE_TOO_LARGE",
]);

// Node's fs AbortError: name "AbortError", code "ABORT_ERR", message
// "The operation was aborted", cause = signal.reason when provided
// (probed against real Node v24.20.0).
function makeAbortError(signal) {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  if (signal && signal.reason !== undefined) err.cause = signal.reason;
  return err;
}

// Mirrors Node's internal validateAbortSignal: undefined passes, anything
// that is not an AbortSignal throws ERR_INVALID_ARG_TYPE.
function validateAbortSignal(signal, name = "options.signal") {
  if (signal === undefined) return undefined;
  if (
    signal === null ||
    (typeof signal !== "object" && typeof signal !== "function") ||
    !("aborted" in Object(signal)) ||
    typeof signal.addEventListener !== "function"
  ) {
    throw errInvalidArgType(name, "AbortSignal", signal);
  }
  return signal;
}

// Wrap a (…, callback) fs function with AbortSignal support. The options
// object sits at args[optionsIndex] (a string options value, e.g. an
// encoding, carries no signal). Semantics match Node: an invalid signal
// type throws synchronously; an already-aborted signal invokes the
// callback with an AbortError on the next tick; an abort that lands while
// the operation is in flight replaces the result with an AbortError.
function withAbortSignal(fn, optionsIndex) {
  return function (...args) {
    const callback = args[args.length - 1];
    const options = args[optionsIndex];
    const signal =
      options !== null && typeof options === "object"
        ? validateAbortSignal(options.signal)
        : undefined;
    if (!signal) return Reflect.apply(fn, this, args);
    if (signal.aborted) {
      nextTick(callback, makeAbortError(signal));
      return undefined;
    }
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      callback(makeAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    args[args.length - 1] = (err, ...rest) => {
      if (settled) return;
      settled = true;
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {}
      callback(err, ...rest);
    };
    return Reflect.apply(fn, this, args);
  };
}

// For promise-returning APIs: reject with AbortError when the signal is
// (or becomes) aborted. When a signal is present we yield a full macrotask
// before doing the synchronous-under-the-hood work, so an abort queued via
// process.nextTick OR setImmediate before the call lands first — matching
// Node, where the threadpool round-trip always loses that race.
async function throwIfAborted(signal) {
  if (!signal) return;
  if (signal.aborted) throw makeAbortError(signal);
  await new Promise((resolve) => {
    try {
      if (typeof setImmediate === "function") setImmediate(resolve);
      else nextTick(resolve);
    } catch {
      nextTick(resolve);
    }
  });
  if (signal.aborted) throw makeAbortError(signal);
}

function enrichErr(err, methodName) {
  if (err && typeof err === "object" && err.code) {
    // memfs reports unknown encodings as ERR_INVALID_OPT_VALUE_ENCODING;
    // real Node uses ERR_INVALID_ARG_VALUE here.
    if (err.code === "ERR_INVALID_OPT_VALUE_ENCODING") {
      try {
        err.code = "ERR_INVALID_ARG_VALUE";
      } catch {
        /* ignore */
      }
    }
    if (NO_ENRICH_CODES.has(err.code)) return err;
    const base = methodName.endsWith("Sync")
      ? methodName.slice(0, -4)
      : methodName;
    const canonical = SYSCALL_BY_METHOD[base];
    try {
      if (err._syscallOverride !== undefined) {
        // Set explicitly by the throwing site (e.g. realpath's lstat ENOENT,
        // whose message is already rewritten there).
        err.syscall = err._syscallOverride;
        delete err._syscallOverride;
      } else if (canonical !== undefined) {
        // Probed canonical syscall for this method (overrides memfs's
        // internal syscall leaking into the message, e.g. chmod's ENOENT
        // surfaces as chmod, not open). SYSCALL_BY_METHOD was probed against
        // real Node v24.20.0.
        if (typeof err.message === "string") {
          err.message = err.message.replace(
            /, [A-Za-z]+(?= '|$)/,
            `, ${canonical}`,
          );
        }
        err.syscall = canonical;
      } else if (!err.syscall) {
        err.syscall = methodName;
      }
    } catch {
      /* ignore */
    }
    if (err.errno === undefined && ERRNO_BY_CODE[err.code] !== undefined) {
      try {
        err.errno = ERRNO_BY_CODE[err.code];
      } catch {
        /* ignore */
      }
    }
  }
  return err;
}

// ── 3. Path helpers ─────────────────────────────────────────────────────────
function isUint8ArrayLike(v) {
  return typeof Uint8Array !== "undefined" && v instanceof Uint8Array;
}
// Duck-type URL check (cross-realm safe: a URL from another realm fails
// `instanceof URL` but still has protocol/pathname).
function isURLLike(p) {
  return (
    p !== null &&
    typeof p === "object" &&
    typeof p.protocol === "string" &&
    typeof p.pathname === "string"
  );
}
function fileURLToPathString(url) {
  if (url.protocol !== "file:") {
    const e = new TypeError("The URL must be of scheme file");
    e.code = "ERR_INVALID_URL_SCHEME";
    throw e;
  }
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    const e = new TypeError("Invalid URL");
    e.code = "ERR_INVALID_URL";
    throw e;
  }
  return pathname;
}
function validateUidGid(uid, gid) {
  for (const [name, value] of [
    ["uid", uid],
    ["gid", gid],
  ]) {
    if (!Number.isInteger(value) || value < -1 || value > 0xffffffff) {
      const err = new TypeError(
        `The "${name}" argument must be of type number. Received ${String(value)}`,
      );
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
  }
}
// Minimal util.inspect for validation error messages (enough for the
// shapes the official tests assert: code + name, message best-effort).
function inspectValue(v) {
  if (typeof v === "string") return `'${v}'`;
  try {
    const j = JSON.stringify(v);
    return j === undefined ? String(v) : j;
  } catch {
    return String(v);
  }
}
// Node's open() flag validation (lib/fs.js), probed against v24.20.0:
// undefined/null -> 'r'; numbers pass through (O_* constants); known flag
// strings pass; everything else throws ERR_INVALID_ARG_VALUE.
const OPEN_FLAG_STRINGS = new Set([
  "r", "r+", "rs", "rs+",
  "w", "wx", "w+", "wx+",
  "a", "ax", "a+", "ax+",
]);
function validateFlags(flags) {
  if (flags === undefined || flags === null) return "r";
  if (typeof flags === "number") return flags;
  if (typeof flags === "string" && OPEN_FLAG_STRINGS.has(flags)) return flags;
  const err = new TypeError(
    `The argument 'flags' is invalid. Received ${inspectValue(flags)}`,
  );
  err.code = "ERR_INVALID_ARG_VALUE";
  throw err;
}
// Node's open() mode validation, probed against v24.20.0:
// undefined/null -> default; octal strings parsed; numbers must be
// 32-bit unsigned integers; other types -> ERR_INVALID_ARG_TYPE.
function validateMode(mode, def = 0o666) {
  if (mode === undefined || mode === null) return def;
  if (typeof mode === "string") {
    if (/^[0-7]+$/.test(mode)) return parseInt(mode, 8);
    const err = new TypeError(
      "The argument 'mode' must be a 32-bit unsigned integer or an octal " +
        `string. Received ${inspectValue(mode)}`,
    );
    err.code = "ERR_INVALID_ARG_VALUE";
    throw err;
  }
  if (typeof mode !== "number") throw errInvalidArgType("mode", "number", mode);
  if (!Number.isInteger(mode)) {
    const err = new RangeError(
      `The value of "mode" is out of range. It must be an integer. Received ${mode}`,
    );
    err.code = "ERR_OUT_OF_RANGE";
    throw err;
  }
  if (mode < 0 || mode > 0xffffffff) {
    const err = new RangeError(
      'The value of "mode" is out of range. It must be >= 0 && <= 4294967295. ' +
        `Received ${mode}`,
    );
    err.code = "ERR_OUT_OF_RANGE";
    throw err;
  }
  return mode;
}
function validatePath(p, name = "path") {
  if (typeof p !== "string" && !isUint8ArrayLike(p) && !isURLLike(p)) {
    // Match Node's exact message format.
    let received;
    if (p === null) received = "null";
    else if (p === undefined) received = "undefined";
    else if (typeof p === "object") {
      received = `an instance of ${p.constructor ? p.constructor.name : "Object"}`;
    } else {
      received = `type ${typeof p} (${String(p)})`;
    }
    const err = new TypeError(
      `The "${name}" argument must be of type string or an instance of Buffer or URL. Received ${received}`,
    );
    err.code = "ERR_INVALID_ARG_TYPE";
    throw err;
  }
  // Node.js fs accepts file: URL objects; non-file schemes are rejected.
  if (isURLLike(p)) fileURLToPathString(p);
  // Null bytes are rejected with ERR_INVALID_ARG_VALUE (test-fs-null-bytes).
  const ps = toPathString(p);
  if (ps.includes("\0")) {
    const err = new TypeError(
      `The argument '${name}' must be a string, Uint8Array, or URL without null bytes. Received '${ps.replace(/\0/g, "\\x00")}'`,
    );
    err.code = "ERR_INVALID_ARG_VALUE";
    throw err;
  }
}
function toPathString(p) {
  if (typeof p === "string") return p;
  if (isURLLike(p)) return fileURLToPathString(p);
  if (isUint8ArrayLike(p)) {
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(p))
      return p.toString("utf8");
    if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(p);
    let s = "";
    for (let i = 0; i < p.length; i++) s += String.fromCharCode(p[i]);
    return s;
  }
  return String(p);
}
function posixDirname(p) {
  const i = p.lastIndexOf("/");
  if (i <= 0) return "/";
  return p.slice(0, i);
}
function posixResolve(cwd, p) {
  if (p.startsWith("/")) return p;
  return (cwd + "/" + p).replace(/\/+/g, "/");
}

// ── 4. Volume creation + seeding ────────────────────────────────────────────
function getUmask() {
  try {
    if (typeof process !== "undefined" && typeof process.umask === "function") {
      return process.umask();
    }
  } catch {
    /* ignore */
  }
  const rt = getRuntime();
  try {
    if (rt && rt.process && typeof rt.process.umask === "function")
      return rt.process.umask();
  } catch {
    /* ignore */
  }
  return 0o022;
}

// Decode a { encoding: 'utf8'|'base64', data: string } seed envelope back to
// its file content. The envelope is the JSON-safe form flattenFileTree
// (runtime.js) produces for binary seeds: raw bytes cannot survive the
// JSON.stringify of __USER_FILES__ into the sandbox bootstrap. Strict shape
// (exactly two keys) so a user directory that merely happens to contain
// `encoding`/`data` files is never silently reinterpreted.
function decodeSeedValue(data) {
  if (
    data !== null &&
    typeof data === "object" &&
    !ArrayBuffer.isView(data) &&
    (data.encoding === "utf8" || data.encoding === "base64") &&
    typeof data.data === "string" &&
    Object.keys(data).length === 2
  ) {
    if (data.encoding === "utf8") return data.data;
    const bin = atob(data.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return data;
}
function seedVolume(vol, files) {
  if (!files || typeof files !== "object") return;
  for (const rawPath of Object.keys(files)) {
    const p = toPathString(rawPath);
    const data = decodeSeedValue(files[rawPath]);
    try {
      const dir = posixDirname(p);
      if (dir !== "/") vol.mkdirSync(dir, { recursive: true });
      vol.writeFileSync(p, data);
    } catch {
      /* best-effort seeding */
    }
  }
}

function createVolume() {
  const vol = new Volume();
  // Real Node returns 0 for reads positioned at/beyond EOF; memfs throws
  // ERR_OUT_OF_RANGE. Short-circuit here (no cursor is touched, so this is
  // safe at the volume level for every read path).
  const origReadBase = vol.readBase.bind(vol);
  vol.readBase = function (fd, buffer, offset, length, position) {
    if (typeof position === "number" && position >= 0) {
      try {
        if (position >= vol.fstatSync(fd).size) return 0;
      } catch {
        /* fall through; orig throws the real error */
      }
    }
    return origReadBase(fd, buffer, offset, length, position);
  };
  const rt = getRuntime();
  if (rt && rt.__USER_FILES__) seedVolume(vol, rt.__USER_FILES__);
  return vol;
}

// memfs hardcodes default creation modes; real Node applies the process
// umask. Wrap open/openSync/mkdir/mkdirSync so modes respect the umask.
function applyUmask(mode) {
  if (mode === undefined || mode === null) return mode;
  const m = Number(mode);
  if (!Number.isInteger(m)) return mode;
  return m & ~getUmask();
}

// ── 5. Node-shaped Stats ────────────────────────────────────────────────────
// Enumerable own keys exactly as in real Node:
//   dev,mode,nlink,uid,gid,rdev,blksize,ino,size,blocks,
//   atimeMs,mtimeMs,ctimeMs,birthtimeMs (+ *Ns for bigint).
// Date fields are prototype getters, not own enumerable properties.
const STAT_KEYS = [
  "dev",
  "mode",
  "nlink",
  "uid",
  "gid",
  "rdev",
  "blksize",
  "ino",
  "size",
  "blocks",
  "atimeMs",
  "mtimeMs",
  "ctimeMs",
  "birthtimeMs",
];
const BIGINT_NS_KEYS = ["atimeNs", "mtimeNs", "ctimeNs", "birthtimeNs"];

const S_IFMT = 0o170000,
  S_IFREG = 0o100000,
  S_IFDIR = 0o040000,
  S_IFLNK = 0o120000,
  S_IFBLK = 0o060000,
  S_IFCHR = 0o020000,
  S_IFIFO = 0o010000,
  S_IFSOCK = 0o140000;

class Stats {
  constructor(m, bigint = false) {
    const asNum = (v) => (typeof v === "bigint" ? Number(v) : Number(v));
    const num = (v) =>
      bigint ? BigInt(Math.trunc(asNum(v) || 0)) : asNum(v) || 0;
    this.dev = num(m.dev || 0);
    this.mode = num(m.mode || 0);
    this.nlink = num(m.nlink || 0);
    this.uid = num(m.uid || 0);
    this.gid = num(m.gid || 0);
    this.rdev = num(m.rdev || 0);
    this.blksize = num(m.blksize || 4096);
    this.ino = num(m.ino || 0);
    this.size = num(m.size || 0);
    this.blocks = num(m.blocks || 0);
    const ms = (v) => asNum(v) || 0;
    const atimeMs = ms(m.atimeMs),
      mtimeMs = ms(m.mtimeMs),
      ctimeMs = ms(m.ctimeMs),
      birthtimeMs = ms(m.birthtimeMs);
    this.atimeMs = bigint ? BigInt(Math.trunc(atimeMs)) : atimeMs;
    this.mtimeMs = bigint ? BigInt(Math.trunc(mtimeMs)) : mtimeMs;
    this.ctimeMs = bigint ? BigInt(Math.trunc(ctimeMs)) : ctimeMs;
    this.birthtimeMs = bigint ? BigInt(Math.trunc(birthtimeMs)) : birthtimeMs;
    if (bigint) {
      const ns = (v) => BigInt(Math.trunc(v * 1e6));
      this.atimeNs = ns(atimeMs);
      this.mtimeNs = ns(mtimeMs);
      this.ctimeNs = ns(ctimeMs);
      this.birthtimeNs = ns(birthtimeMs);
    }
    // Date properties are prototype getters/setters in real Node.
    // The setter stores the raw value; the getter returns it.
    Object.defineProperties(this, {
      _atime: { value: new Date(atimeMs), writable: true },
      _mtime: { value: new Date(mtimeMs), writable: true },
      _ctime: { value: new Date(ctimeMs), writable: true },
      _birthtime: { value: new Date(birthtimeMs), writable: true },
    });
  }
  get atime() {
    return this._atime;
  }
  set atime(v) {
    this._atime = v;
  }
  get mtime() {
    return this._mtime;
  }
  set mtime(v) {
    this._mtime = v;
  }
  get ctime() {
    return this._ctime;
  }
  set ctime(v) {
    this._ctime = v;
  }
  get birthtime() {
    return this._birthtime;
  }
  set birthtime(v) {
    this._birthtime = v;
  }
  isFile() {
    return (Number(this.mode) & S_IFMT) === S_IFREG;
  }
  isDirectory() {
    return (Number(this.mode) & S_IFMT) === S_IFDIR;
  }
  isSymbolicLink() {
    return (Number(this.mode) & S_IFMT) === S_IFLNK;
  }
  isBlockDevice() {
    return (Number(this.mode) & S_IFMT) === S_IFBLK;
  }
  isCharacterDevice() {
    return (Number(this.mode) & S_IFMT) === S_IFCHR;
  }
  isFIFO() {
    return (Number(this.mode) & S_IFMT) === S_IFIFO;
  }
  isSocket() {
    return (Number(this.mode) & S_IFMT) === S_IFSOCK;
  }
}

function toStats(m, options) {
  const bigint = !!(options && (options.bigint || options === true));
  return new Stats(m, bigint);
}

// ── 6. Node-shaped Dirent ───────────────────────────────────────────────────
// Enumerable own keys: name, parentPath only.
class Dirent {
  constructor(name, parentPath, mode) {
    this.name = name;
    this.parentPath = parentPath;
    // Non-enumerable: real Node Dirent exposes only name/parentPath.
    Object.defineProperty(this, "_mode", { value: mode, enumerable: false });
  }
  isFile() {
    return (this._mode & S_IFMT) === S_IFREG;
  }
  isDirectory() {
    return (this._mode & S_IFMT) === S_IFDIR;
  }
  isSymbolicLink() {
    return (this._mode & S_IFMT) === S_IFLNK;
  }
  isBlockDevice() {
    return (this._mode & S_IFMT) === S_IFBLK;
  }
  isCharacterDevice() {
    return (this._mode & S_IFMT) === S_IFCHR;
  }
  isFIFO() {
    return (this._mode & S_IFMT) === S_IFIFO;
  }
  isSocket() {
    return (this._mode & S_IFMT) === S_IFSOCK;
  }
}

// ── 6b. Node-shaped Utf8Stream ──────────────────────────────────────────────
// Minimal port of Node's internal Utf8Stream (lib/fs.js): a small buffered
// UTF-8 file writer. Real Node uses native handles; here writes go through
// the virtual volume via fs.writeSync when a real fd is available, otherwise
// they are buffered and emitted as 'data' events (honest browser fallback).
import { EventEmitter as _FsEventEmitter } from "./events.js";
class Utf8Stream extends _FsEventEmitter {
  constructor(options = {}) {
    super();
    this.path = options.dest ?? null;
    this.fd = options.fd ?? -1;
    this.minLength = options.minLength ?? 0;
    this.maxLength = options.maxLength ?? Infinity;
    this.sync = !!options.sync;
    this._buf = "";
    this._destroyed = false;
  }
  write(data, cb) {
    if (this._destroyed) {
      if (cb) cb(new Error("write after destroy"));
      return false;
    }
    const s = String(data ?? "");
    if (this._buf.length + s.length > this.maxLength) {
      const err = new Error("write buffer exceeded maxLength");
      if (cb) cb(err);
      else this.emit("error", err);
      return false;
    }
    this._buf += s;
    if (this._buf.length >= this.minLength) this._flush();
    if (cb) cb(null);
    return true;
  }
  _flush() {
    if (!this._buf.length) return;
    const chunk = this._buf;
    this._buf = "";
    this.emit("data", chunk);
  }
  end(data, cb) {
    if (data !== undefined) this.write(data);
    this._flush();
    this.emit("finish");
    if (cb) cb(null);
  }
  destroy(err) {
    this._destroyed = true;
    this._buf = "";
    if (err) this.emit("error", err);
    this.emit("close");
  }
}

// Port of Node's internal toUnixTimestamp (lib/fs.js).
function _toUnixTimestamp(time, name = "time") {
  if (typeof time === "string" && +time == time) {
    return +time;
  }
  if (Number.isFinite(time)) {
    if (time < 0) {
      return Date.now() / 1000;
    }
    return time;
  }
  if (Object.prototype.toString.call(time) === "[object Date]") {
    // Convert to 123.456 UNIX timestamp
    return time.getTime() / 1000;
  }
  throw new TypeError(
    `The "${name}" argument must be of type Date or time in seconds. Received ${time}`,
  );
}

// ── 7. API builder ──────────────────────────────────────────────────────────
function buildApi(vol) {
  const fs = createFsFromVolume(vol);

  // ── fd helpers ──
  function fdEntry(fd) {
    return vol.fds ? vol.fds[fd] : undefined;
  }
  function getPosition(fd) {
    const f = fdEntry(fd);
    return f ? f.position : undefined;
  }
  function setPosition(fd, pos) {
    const f = fdEntry(fd);
    if (f && typeof pos === "number") f.position = pos;
  }
  function checkFdReadable(fd, syscallName) {
    const f = fdEntry(fd);
    if (!f) {
      const err = makeFsError(
        "EBADF",
        syscallName,
        undefined,
        "bad file descriptor",
      );
      err.errno = -9;
      throw err;
    }
    // O_RDONLY=0, O_RDWR=2 are readable; O_WRONLY=1, O_APPEND-only are not.
    const accmode = f.flags & 3;
    if (accmode === 1) {
      const err = makeFsError(
        "EBADF",
        syscallName,
        undefined,
        "bad file descriptor",
      );
      err.errno = -9;
      throw err;
    }
  }
  function checkFdWritable(fd, syscallName) {
    const f = fdEntry(fd);
    if (!f) {
      const err = makeFsError(
        "EBADF",
        syscallName,
        undefined,
        "bad file descriptor",
      );
      err.errno = -9;
      throw err;
    }
    const accmode = f.flags & 3;
    if (accmode === 0) {
      const err = makeFsError(
        "EBADF",
        syscallName,
        undefined,
        "bad file descriptor",
      );
      err.errno = -9;
      throw err;
    }
  }

  // Normalize raw ArrayBuffer/DataView inputs for read/write data args.
  function normalizeDataArg(data) {
    if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (typeof DataView !== "undefined" && data instanceof DataView) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return data;
  }
  // Validate write data like real Node (string | Buffer | TypedArray | DataView).
  function validateDataArg(data, name) {
    if (typeof data === "string") return;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return;
    if (
      typeof ArrayBuffer !== "undefined" &&
      (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
    )
      return;
    // Blob is allowed in real Node's writeFile.
    if (typeof Blob !== "undefined" && data instanceof Blob) return;
    throw errInvalidArgType(
      name || "data",
      ["string", "Buffer", "TypedArray", "DataView"],
      data,
    );
  }

  // ── generic wrappers ──
  // Two-path operations (link, symlink, rename, copyFile): Node sets
  // err.dest and formats the message as `CODE: msg, syscall 'src' -> 'dest'`
  // (test-fs-error-messages.js).
  function enrichDestErr(err, methodName, src, dest) {
    err = enrichErr(err, methodName);
    if (!err || typeof err !== "object" || !err.code) return err;
    try {
      const srcStr = toPathString(src);
      const destStr = toPathString(dest);
      err.dest = destStr;
      if (typeof err.message === "string" && !err.message.includes(" -> ")) {
        const tail = `'${srcStr}'`;
        if (err.message.endsWith(tail)) {
          err.message =
            err.message.slice(0, -tail.length) +
            `'${srcStr}' -> '${destStr}'`;
        }
      }
    } catch {}
    return err;
  }
  function wrapSync(name, impl, validatePathFirst, destIdx, fdFirst) {
    const orig = fs[name];
    const needsUidGid = /chown/i.test(name);
    fs[name] = function (...args) {
      let result;
      try {
        // fd-based ops validate the fd first (test-fs-fchmod).
        if (fdFirst) validateFd(args[0]);
        if (validatePathFirst) validatePath(args[0]);
        // Two-path ops: the destination is a path too (null-byte check etc.).
        if (destIdx != null) validatePath(args[destIdx], "dest");
        if (needsUidGid) validateUidGid(args[1], args[2]);
        result = (impl || orig).apply(this, args);
      } catch (e) {
        throw destIdx != null
          ? enrichDestErr(e, name, args[0], args[destIdx])
          : enrichErr(e, name);
      }
      emitFs("fs", name, ...args, result);
      return result;
    };
  }
  // Node callback result arity (number of args after err) per function.
  // memfs sometimes passes extra undefined/null args; trim to match Node.
  const cbResultArity = {
    close: 0,
    unlink: 0,
    mkdir: 1,
    rmdir: 0,
    rm: 0,
    rename: 0,
    link: 0,
    symlink: 0,
    chmod: 0,
    fchmod: 0,
    lchmod: 0,
    chown: 0,
    fchown: 0,
    lchown: 0,
    utimes: 0,
    futimes: 0,
    lutimes: 0,
    fsync: 0,
    fdatasync: 0,
    truncate: 0,
    ftruncate: 0,
    write: 2, // (bytesWritten, buffer)
    read: 2, // (bytesRead, buffer)
    readv: 2,
    writev: 2,
    open: 1,
    opendir: 1,
    mkdtemp: 1,
    readdir: 1,
    readFile: 1,
    appendFile: 0,
    writeFile: 0,
    copyFile: 0,
    cp: 0,
    stat: 1,
    lstat: 1,
    fstat: 1,
    statfs: 1,
    readlink: 1,
    realpath: 1,
    access: 0,
    exists: 1,
    mkdtempDisposable: 1,
  };
  function wrapCb(name, impl, validatePathFirst, destIdx, fdFirst) {
    const orig = fs[name];
    const arity = cbResultArity[name];
    const needsUidGid = /chown/i.test(name);
    fs[name] = function (...args) {
      // fd-based ops validate the fd before the callback (test-fs-fchmod).
      if (fdFirst) validateFd(args[0]);
      const last = args[args.length - 1];
      if (typeof last !== "function")
        throw errInvalidArgType("cb", "function", last);
      const userCb = last;
      args[args.length - 1] = function (err, ...rest) {
        if (err)
          err =
            destIdx != null
              ? enrichDestErr(err, name, args[0], args[destIdx])
              : enrichErr(err, name);
        const trimmed = arity !== undefined ? rest.slice(0, arity) : rest;
        emitFs("fs", name, ...args.slice(0, -1), trimmed[0]);
        userCb(err, ...trimmed);
      };
      try {
        if (validatePathFirst) validatePath(args[0]);
        // Two-path ops: the destination is a path too (null-byte check etc.).
        if (destIdx != null) validatePath(args[destIdx], "dest");
        if (needsUidGid) validateUidGid(args[1], args[2]);
        return (impl || orig).apply(this, args);
      } catch (e) {
        throw destIdx != null
          ? enrichDestErr(e, name, args[0], args[destIdx])
          : enrichErr(e, name);
      }
    };
  }
  function wrapPromise(p, name, impl) {
    const orig = impl ? null : p[name];
    p[name] = function (...args) {
      let result;
      try {
        result = (impl || orig).apply(this, args);
      } catch (e) {
        return Promise.reject(enrichErr(e, name));
      }
      return Promise.resolve(result).then(
        (val) => {
          emitFs("fs", `promises.${name}`, ...args, val);
          return val;
        },
        (err) => {
          emitFs("fs", `promises.${name}`, ...args, undefined);
          throw enrichErr(err, name);
        },
      );
    };
  }

  // ── stat/lstat/fstat → NodeStats ──
  // fds 0/1/2 (stdio) are not open in memfs; synthesize minimal stats.
  function stdioStats(fd) {
    if (fd === 0 || Object.is(fd, -0)) {
      return toStats(
        {
          dev: 0,
          mode: 0o020000, // character device
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: 0,
          blksize: 4096,
          ino: 0,
          size: 0,
          blocks: 0,
          atimeMs: Date.now(),
          mtimeMs: Date.now(),
          ctimeMs: Date.now(),
          birthtimeMs: Date.now(),
        },
        undefined,
      );
    }
    return null;
  }
  for (const name of ["statSync", "lstatSync"]) {
    const orig = fs[name];
    fs[name] = function (p, options) {
      validatePath(p);
      const throwIfNoEntry = !options || options.throwIfNoEntry !== false;
      let m;
      try {
        m = orig.call(this, toPathString(p), options);
      } catch (e) {
        // throwIfNoEntry:false returns undefined on ENOENT (test-fs-stat).
        if (!throwIfNoEntry && e && e.code === "ENOENT") return undefined;
        throw enrichErr(e, name);
      }
      const st = m === undefined ? undefined : toStats(m, options);
      emitFs("fs", name, p, st);
      return st;
    };
  }
  {
    const orig = fs.fstatSync;
    fs.fstatSync = function (fd, options) {
      validateFd(fd);
      const stdio = stdioStats(fd);
      if (stdio) return stdio;
      let m;
      try {
        m = orig.call(this, fd, options);
      } catch (e) {
        throw enrichErr(e, "fstatSync");
      }
      const st = toStats(m, options);
      emitFs("fs", "fstatSync", fd, st);
      return st;
    };
  }
  for (const name of ["stat", "lstat"]) {
    const orig = fs[name];
    // withAbortSignal composes outside: it validates options.signal before
    // the path (Node's getOptions order) and swaps the callback for the
    // abort-aware one. The inner wrapper keeps its arg normalization.
    fs[name] = withAbortSignal(function (p, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validatePath(p);
      orig.call(this, toPathString(p), options, (err, m) => {
        if (err) return callback(enrichErr(err, name));
        // throwIfNoEntry:false yields (null, undefined) on missing paths.
        const st = m === undefined ? undefined : toStats(m, options);
        emitFs("fs", name, p, st);
        callback(null, st);
      });
    }, 1);
  }
  {
    const orig = fs.fstat;
    fs.fstat = function (fd, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      validateFd(fd);
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      const stdio = stdioStats(fd);
      if (stdio) {
        emitFs("fs", "fstat", fd, stdio);
        nextTick(callback, null, stdio);
        return;
      }
      orig.call(this, fd, options, (err, m) => {
        if (err) return callback(enrichErr(err, "fstat"));
        const st = toStats(m, options);
        emitFs("fs", "fstat", fd, st);
        callback(null, st);
      });
    };
  }

  // ── readFile/writeFile/appendFile: AbortSignal + fd-position fidelity ──
  // memfs ignores options.signal entirely and its writeFile-on-fd truncates
  // at position 0 (real Node writes at the fd's current position without
  // truncating) and never checks writability (real Node: EBADF on O_RDONLY).
  // String data -> bytes honoring options.encoding (string or object form).
  function dataToBuffer(data, options) {
    if (typeof data === "string") {
      const encoding =
        typeof options === "string" ? options : options?.encoding;
      return typeof Buffer !== "undefined"
        ? Buffer.from(data, encoding)
        : new TextEncoder().encode(data);
    }
    return normalizeDataArg(data);
  }
  // Normalize writeFile/appendFile data: string | Buffer | TypedArray |
  // DataView | ArrayBuffer | Blob | Readable | Iterable | AsyncIterable.
  // Anything else (numbers, plain objects, null, …) is ERR_INVALID_ARG_TYPE,
  // matching Node. Stream/iterable chunks are validated element-wise.
  function coerceWriteChunk(chunk, encoding) {
    if (typeof chunk === "string")
      return typeof Buffer !== "undefined"
        ? Buffer.from(chunk, encoding)
        : new TextEncoder().encode(chunk);
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(chunk)) return chunk;
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(chunk)) {
      return typeof Buffer !== "undefined"
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    throw errInvalidArgType(
      "data",
      ["string", "Buffer", "TypedArray", "DataView", "Iterable", "AsyncIterable"],
      chunk,
    );
  }
  async function coerceWriteData(data, encoding, signal) {
    if (typeof data === "string")
      return typeof Buffer !== "undefined"
        ? Buffer.from(data, encoding)
        : new TextEncoder().encode(data);
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) return data;
    if (typeof ArrayBuffer !== "undefined") {
      if (ArrayBuffer.isView(data)) return coerceWriteChunk(data, encoding);
      if (
        data instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== "undefined" &&
          data instanceof SharedArrayBuffer)
      )
        return new Uint8Array(data);
    }
    if (typeof Blob !== "undefined" && data instanceof Blob)
      return new Uint8Array(await data.arrayBuffer());
    if (
      data !== null &&
      (typeof data === "object" || typeof data === "function") &&
      (typeof data[Symbol.asyncIterator] === "function" ||
        typeof data[Symbol.iterator] === "function")
    ) {
      const chunks = [];
      for await (const chunk of data) {
        if (signal && signal.aborted) throw makeAbortError(signal);
        chunks.push(coerceWriteChunk(chunk, encoding));
      }
      return typeof Buffer !== "undefined"
        ? Buffer.concat(chunks)
        : chunks.reduce(
            (acc, c) => {
              const out = new Uint8Array(acc.length + c.length);
              out.set(acc);
              out.set(c, acc.length);
              return out;
            },
            new Uint8Array(0),
          );
    }
    throw errInvalidArgType(
      "data",
      ["string", "Buffer", "TypedArray", "DataView", "Iterable", "AsyncIterable"],
      data,
    );
  }
  // Validate options.signal for the promise APIs (invalid type rejects).
  function promiseSignal(options) {
    return options !== null && typeof options === "object"
      ? validateAbortSignal(options.signal)
      : undefined;
  }
  {
    const origReadFile = fs.readFile;
    fs.readFile = withAbortSignal(function (p, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      return origReadFile.call(this, p, options, callback);
    }, 1);

    // writeFile(file-descriptor, …): write at the fd's current position,
    // never truncate; EBADF when the fd is not writable.
    function writeFileToFd(fd, data, options, callback) {
      let buf;
      try {
        checkFdWritable(fd, "write");
        buf = dataToBuffer(data, options);
      } catch (e) {
        nextTick(callback, enrichErr(e, "write"));
        return;
      }
      let n;
      try {
        n = vol.writeSync(fd, buf, 0, buf.byteLength, null);
      } catch (e) {
        nextTick(callback, enrichErr(e, "write"));
        return;
      }
      emitFs("fs", "writeFile", fd, n);
      nextTick(callback, null);
    }
    const origWriteFile = fs.writeFile;
    fs.writeFile = withAbortSignal(function (file, data, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      if (typeof file === "number") {
        writeFileToFd(file, data, options, callback);
        return;
      }
      // A read-only open flag ("r", "rs", "sr") fails the write with EBADF
      // (memfs silently writes anyway).
      const flag =
        options !== null && typeof options === "object"
          ? options.flag
          : undefined;
      if (typeof flag === "string" && /^(rs?|sr)$/.test(flag)) {
        const err = makeFsError("EBADF", "write", undefined, "bad file descriptor");
        err.errno = -9;
        nextTick(callback, err);
        return;
      }
      return origWriteFile.call(this, file, data, options, callback);
    }, 2);
    const origAppendFile = fs.appendFile;
    fs.appendFile = withAbortSignal(function (path, data, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      return origAppendFile.call(this, path, data, options, callback);
    }, 2);

    const origWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = function (file, data, options) {
      // fd variant: current-position write, no truncation (memfs truncates).
      if (typeof file === "number") {
        checkFdWritable(file, "write");
        const buf = dataToBuffer(data, options);
        vol.writeSync(file, buf, 0, buf.byteLength, null);
        emitFs("fs", "writeFileSync", file, buf.byteLength);
        return;
      }
      return origWriteFileSync.call(this, file, data, options);
    };
  }

  // ── readdir/readdirSync: Dirent shape + recursive ──
  function readdirImpl(p, options, wantDirent) {
    const names = vol.readdirSync(p);
    if (options && options.recursive) {
      const out = [];
      const walk = (dir, rel) => {
        for (const name of vol.readdirSync(dir)) {
          const full = dir + "/" + name;
          const rp = rel ? rel + "/" + name : name;
          let st;
          try {
            st = vol.lstatSync(full);
          } catch {
            continue;
          }
          if (wantDirent) out.push(new Dirent(name, dir, st.mode));
          else out.push(rp);
          if (st.isDirectory()) walk(full, rp);
        }
      };
      walk(p, "");
      return out;
    }
    if (wantDirent) {
      return names.map((name) => {
        let mode = 0;
        try {
          mode = vol.lstatSync(p + "/" + name).mode;
        } catch {
          /* ignore */
        }
        return new Dirent(name, p, mode);
      });
    }
    return names;
  }
  {
    const orig = fs.readdirSync;
    fs.readdirSync = function (p, options) {
      validateEncodingOpt(options);
      validatePath(p);
      const ps = toPathString(p);
      let result;
      try {
        if (options && (options.withFileTypes || options.recursive)) {
          result = readdirImpl(ps, options, !!options.withFileTypes);
        } else {
          result = orig.call(this, ps, options);
        }
      } catch (e) {
        throw enrichErr(e, "readdirSync");
      }
      emitFs("fs", "readdirSync", p, result);
      return result;
    };
  }
  {
    const orig = fs.readdir;
    fs.readdir = function (p, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validateEncodingOpt(options);
      validatePath(p);
      const ps = toPathString(p);
      const done = (err, result) => {
        if (err) return callback(enrichErr(err, "readdir"));
        emitFs("fs", "readdir", p, result);
        callback(null, result);
      };
      if (options && (options.withFileTypes || options.recursive)) {
        try {
          done(null, readdirImpl(ps, options, !!options.withFileTypes));
        } catch (e) {
          done(e);
        }
        return;
      }
      orig.call(this, ps, options, (err, result) => {
        if (err) return done(err);
        done(null, result);
      });
    };
  }

  // ── readSync/read: EBADF on wrong-direction fd, cursor preservation ──
  function parseReadArgs(args) {
    // readSync(fd, buffer, offset, length, position) or readSync(fd, options)
    const [fd, bufferOrOptions, offset, length, position] = args;
    if (
      bufferOrOptions &&
      typeof bufferOrOptions === "object" &&
      !(bufferOrOptions instanceof Uint8Array) &&
      !ArrayBuffer.isView(bufferOrOptions)
    ) {
      const o = bufferOrOptions;
      return {
        fd,
        buffer: o.buffer,
        offset: o.offset || 0,
        length: o.length,
        position: o.position,
        opts: true,
      };
    }
    return { fd, buffer: bufferOrOptions, offset, length, position };
  }
  {
    const orig = fs.readSync;
    fs.readSync = function (...args) {
      const { fd, buffer, offset, length, position } = parseReadArgs(args);
      checkFdReadable(fd, "read");
      let buf = buffer;
      if (!(buf instanceof Uint8Array) && !ArrayBuffer.isView(buf)) {
        // allocate like Node does when buffer is omitted
        const len = typeof length === "number" ? length : 16384;
        buf =
          typeof Buffer !== "undefined"
            ? Buffer.alloc(len)
            : new Uint8Array(len);
      }
      const off = offset || 0;
      const len =
        length === undefined || length === null ? buf.byteLength - off : length;
      const savedPos =
        typeof position === "number" ? getPosition(fd) : undefined;
      let n;
      try {
        n = orig.call(
          this,
          fd,
          buf,
          off,
          len,
          position === undefined ? null : position,
        );
      } catch (e) {
        throw enrichErr(e, "readSync");
      } finally {
        if (savedPos !== undefined) setPosition(fd, savedPos);
      }
      const result =
        args.length === 2 ||
        (args[1] &&
          typeof args[1] === "object" &&
          !(args[1] instanceof Uint8Array) &&
          !ArrayBuffer.isView(args[1]))
          ? { bytesRead: n, buffer: buf }
          : n;
      emitFs("fs", "readSync", fd, result);
      return result;
    };
  }
  {
    const orig = fs.read;
    fs.read = function (...args) {
      const callback = args[args.length - 1];
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      const { fd, buffer, offset, length, position } = parseReadArgs(
        args.slice(0, -1),
      );
      let buf = buffer;
      if (!(buf instanceof Uint8Array) && !ArrayBuffer.isView(buf)) {
        const len = typeof length === "number" ? length : 16384;
        buf =
          typeof Buffer !== "undefined"
            ? Buffer.alloc(len)
            : new Uint8Array(len);
      }
      const off = offset || 0;
      const len =
        length === undefined || length === null ? buf.byteLength - off : length;
      try {
        checkFdReadable(fd, "read");
      } catch (e) {
        nextTick(callback, enrichErr(e, "read"));
        return;
      }
      const savedPos =
        typeof position === "number" ? getPosition(fd) : undefined;
      const cb = (err, bytesRead, b) => {
        if (savedPos !== undefined) setPosition(fd, savedPos);
        if (err) return callback(enrichErr(err, "read"));
        emitFs("fs", "read", fd, bytesRead);
        callback(null, bytesRead, b || buf);
      };
      try {
        return orig.call(
          this,
          fd,
          buf,
          off,
          len,
          position === undefined ? null : position,
          cb,
        );
      } catch (e) {
        throw enrichErr(e, "read");
      }
    };
  }

  // ── writeSync/write: EBADF on wrong-direction fd, cursor preservation ──
  {
    const orig = fs.writeSync;
    fs.writeSync = function (fd, data, ...rest) {
      // Node validates the buffer before touching the fd (writeSync(1, true)
      // is ERR_INVALID_ARG_TYPE, not EBADF).
      validateDataArg(data, "buffer");
      checkFdWritable(fd, "write");
      data = normalizeDataArg(data);
      // writeSync(fd, string[, position[, encoding]]) or writeSync(fd, buffer, offset, length, position)
      let position;
      if (typeof data === "string") {
        position = rest[0];
      } else {
        position = rest[2];
      }
      const savedPos =
        typeof position === "number" ? getPosition(fd) : undefined;
      let n;
      try {
        n = orig.call(this, fd, data, ...rest);
      } catch (e) {
        throw enrichErr(e, "writeSync");
      } finally {
        if (savedPos !== undefined) setPosition(fd, savedPos);
      }
      emitFs("fs", "writeSync", fd, n);
      return n;
    };
  }
  {
    const orig = fs.write;
    fs.write = function (fd, data, ...rest) {
      const callback = rest[rest.length - 1];
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      const args = rest.slice(0, -1);
      try {
        checkFdWritable(fd, "write");
        validateDataArg(data, "buffer");
      } catch (e) {
        nextTick(callback, enrichErr(e, "write"));
        return;
      }
      data = normalizeDataArg(data);
      let position;
      if (typeof data === "string") position = args[0];
      else position = args[2];
      const savedPos =
        typeof position === "number" ? getPosition(fd) : undefined;
      const cb = (err, written, d) => {
        if (savedPos !== undefined) setPosition(fd, savedPos);
        if (err) return callback(enrichErr(err, "write"));
        emitFs("fs", "write", fd, written);
        callback(null, written, d);
      };
      try {
        return orig.call(this, fd, data, ...args, cb);
      } catch (e) {
        throw enrichErr(e, "write");
      }
    };
  }

  // ── readv/writev (+Sync) ──
  function readvSyncImpl(fd, buffers, position) {
    checkFdReadable(fd, "readv");
    if (!Array.isArray(buffers))
      throw errInvalidArgType("buffers", "Array", buffers);
    const savedPos = typeof position === "number" ? getPosition(fd) : undefined;
    let total = 0;
    try {
      for (const b of buffers) {
        const buf =
          b instanceof Uint8Array || ArrayBuffer.isView(b)
            ? b
            : typeof Buffer !== "undefined"
              ? Buffer.alloc(0)
              : new Uint8Array(0);
        const n = vol.readSync(
          fd,
          buf,
          0,
          buf.byteLength,
          typeof position === "number" ? position + total : null,
        );
        total += n;
        if (n < buf.byteLength) break;
      }
    } finally {
      if (savedPos !== undefined) setPosition(fd, savedPos);
    }
    return total;
  }
  function writevSyncImpl(fd, buffers, position) {
    checkFdWritable(fd, "writev");
    if (!Array.isArray(buffers))
      throw errInvalidArgType("buffers", "Array", buffers);
    const savedPos = typeof position === "number" ? getPosition(fd) : undefined;
    let total = 0;
    try {
      for (const b of buffers) {
        const buf = normalizeDataArg(b);
        const n = vol.writeSync(
          fd,
          buf,
          0,
          buf.byteLength,
          typeof position === "number" ? position + total : null,
        );
        total += n;
        if (n < buf.byteLength) break;
      }
    } finally {
      if (savedPos !== undefined) setPosition(fd, savedPos);
    }
    return total;
  }
  fs.readvSync = function (fd, buffers, position) {
    let result;
    try {
      result = readvSyncImpl(fd, buffers, position);
    } catch (e) {
      throw enrichErr(e, "readvSync");
    }
    emitFs("fs", "readvSync", fd, result);
    return result;
  };
  fs.writevSync = function (fd, buffers, position) {
    let result;
    try {
      result = writevSyncImpl(fd, buffers, position);
    } catch (e) {
      throw enrichErr(e, "writevSync");
    }
    emitFs("fs", "writevSync", fd, result);
    return result;
  };
  fs.readv = function (fd, buffers, position, callback) {
    if (typeof position === "function") {
      callback = position;
      position = undefined;
    }
    if (typeof callback !== "function")
      throw errInvalidArgType("cb", "function", callback);
    const run = () => {
      try {
        const bytesRead = readvSyncImpl(fd, buffers, position);
        emitFs("fs", "readv", fd, bytesRead);
        callback(null, bytesRead, buffers);
      } catch (e) {
        callback(enrichErr(e, "readv"));
      }
    };
    nextTick(run);
  };
  fs.writev = function (fd, buffers, position, callback) {
    if (typeof position === "function") {
      callback = position;
      position = undefined;
    }
    if (typeof callback !== "function")
      throw errInvalidArgType("cb", "function", callback);
    const run = () => {
      try {
        const bytesWritten = writevSyncImpl(fd, buffers, position);
        emitFs("fs", "writev", fd, bytesWritten);
        callback(null, bytesWritten, buffers);
      } catch (e) {
        callback(enrichErr(e, "writev"));
      }
    };
    nextTick(run);
  };

  // ── access/accessSync: mode validation + permission enforcement ──
  function accessCheck(path, mode) {
    validatePath(path);
    if (mode === undefined || mode === null) mode = fs.constants.F_OK;
    if (typeof mode !== "number" || !Number.isInteger(mode)) {
      // Real Node's message for a bad access mode.
      const err = new Error("mode must be int32 or null/undefined");
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    const p = toPathString(path);
    const st = vol.statSync(p); // throws ENOENT
    const m = st.mode;
    const fail = () => {
      throw enrichErr(
        makeFsError("EACCES", "access", p, "permission denied"),
        "access",
      );
    };
    if (mode & fs.constants.W_OK && !(m & 0o222)) fail();
    if (mode & fs.constants.R_OK && !(m & 0o444)) fail();
    if (mode & fs.constants.X_OK && !(m & 0o111)) fail();
  }
  fs.accessSync = function (path, mode) {
    try {
      accessCheck(path, mode);
    } catch (e) {
      throw enrichErr(e, "accessSync");
    }
    emitFs("fs", "accessSync", path, undefined);
  };
  fs.access = function (path, mode, callback) {
    if (typeof mode === "function") {
      callback = mode;
      mode = undefined;
    }
    if (typeof callback !== "function")
      throw errInvalidArgType("cb", "function", callback);
    // Path validation is synchronous in Node (throws before any async work).
    validatePath(path);
    nextTick(() => {
      try {
        accessCheck(path, mode);
        emitFs("fs", "access", path, undefined);
        callback(null);
      } catch (e) {
        callback(enrichErr(e, "access"));
      }
    });
  };

  // ── mkdir/mkdirSync: recursive on existing file → EEXIST; umask ──
  function mkdirImpl(p, options) {
    let opts;
    if (typeof options === "number") opts = { mode: options };
    else if (typeof options === "string") {
      // String modes are parsed as octal (fs.mkdirSync(dir, "644")).
      const m = parseInt(options, 8);
      if (Number.isNaN(m)) {
        const err = new TypeError(
          `The value of "mode" is out of range. It must be an integer. Received '${options}'`,
        );
        err.code = "ERR_OUT_OF_RANGE";
        throw err;
      }
      opts = { mode: m };
    } else opts = options || {};
    if (opts.mode !== undefined) opts.mode = applyUmask(opts.mode);
    if (opts.recursive) {
      // Real Node: recursive mkdir on an existing *file* reports EEXIST.
      let st = null;
      try {
        st = vol.statSync(p);
      } catch {
        /* ignore */
      }
      if (st && !st.isDirectory()) {
        throw enrichErr(
          makeFsError("EEXIST", "mkdir", p, "file already exists"),
          "mkdir",
        );
      }
    }
    return vol.mkdirSync(p, opts);
  }
  {
    const orig = fs.mkdir;
    fs.mkdirSync = function (p, options) {
      validatePath(p);
      let result;
      try {
        result = mkdirImpl(toPathString(p), options);
      } catch (e) {
        throw enrichErr(e, "mkdirSync");
      }
      emitFs("fs", "mkdirSync", p, result);
      return result;
    };
    fs.mkdir = function (p, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validatePath(p);
      nextTick(() => {
        try {
          const result = mkdirImpl(toPathString(p), options);
          emitFs("fs", "mkdir", p, result);
          callback(null, options && options.recursive ? result : undefined);
        } catch (e) {
          callback(enrichErr(e, "mkdir"));
        }
      });
    };
  }

  // ── rename/renameSync: enforce dir/file type rules (memfs is lax) ──
  function renameTypeError(code, message, src, dest) {
    const err = new Error(`${code}: ${message}, rename '${src}' -> '${dest}'`);
    err.code = code;
    err.errno = ERRNO_BY_CODE[code];
    err.syscall = "rename";
    err.path = src;
    err.dest = dest;
    return err;
  }
  function checkRename(oldPath, newPath) {
    const src = toPathString(oldPath),
      dest = toPathString(newPath);
    let srcSt = null,
      destSt = null;
    try {
      srcSt = vol.statSync(src);
    } catch {
      /* ignore */
    }
    try {
      destSt = vol.statSync(dest);
    } catch {
      /* ignore */
    }
    if (srcSt && destSt) {
      if (srcSt.isDirectory() && !destSt.isDirectory()) {
        throw renameTypeError("ENOTDIR", "not a directory", src, dest);
      }
      if (!srcSt.isDirectory() && destSt.isDirectory()) {
        throw renameTypeError(
          "EISDIR",
          "illegal operation on a directory",
          src,
          dest,
        );
      }
      // Node refuses to rename onto a non-empty directory (ENOTEMPTY);
      // memfs is lax here.
      if (srcSt.isDirectory() && destSt.isDirectory()) {
        let entries = [];
        try {
          entries = vol.readdirSync(dest);
        } catch {}
        if (entries.length > 0) {
          throw renameTypeError("ENOTEMPTY", "directory not empty", src, dest);
        }
      }
    }
  }
  {
    const origSync = fs.renameSync,
      origCb = fs.rename;
    fs.renameSync = function (oldPath, newPath) {
      validatePath(oldPath);
      validatePath(newPath, "newPath");
      try {
        checkRename(oldPath, newPath);
        origSync.call(this, toPathString(oldPath), toPathString(newPath));
      } catch (e) {
        throw enrichDestErr(e, "renameSync", oldPath, newPath);
      }
      emitFs("fs", "renameSync", oldPath, undefined);
    };
    fs.rename = function (oldPath, newPath, callback) {
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validatePath(oldPath);
      validatePath(newPath, "newPath");
      nextTick(() => {
        try {
          checkRename(oldPath, newPath);
          origCb.call(
            this,
            toPathString(oldPath),
            toPathString(newPath),
            (err) => {
              if (err)
                return callback(enrichDestErr(err, "rename", oldPath, newPath));
              emitFs("fs", "rename", oldPath, undefined);
              callback(null);
            },
          );
        } catch (e) {
          callback(enrichDestErr(e, "rename", oldPath, newPath));
        }
      });
    };
  }

  // ── unlink/rm: directory errors ──
  function checkUnlink(p, syscallName) {
    const ps = toPathString(p);
    let st = null;
    try {
      st = vol.statSync(ps);
    } catch {
      /* ignore */
    }
    if (st && st.isDirectory()) {
      throw enrichErr(
        makeFsError(
          "EISDIR",
          syscallName,
          ps,
          "illegal operation on a directory",
        ),
        syscallName,
      );
    }
  }
  function checkRm(p, options, syscallName) {
    const ps = toPathString(p);
    const opts = options || {};
    let st = null;
    try {
      st = vol.statSync(ps);
    } catch {
      /* ignore */
    }
    if (st && st.isDirectory() && !opts.recursive && !opts.force) {
      // Real Node message shape (no code prefix, no quotes, no syscall).
      const err = new Error(
        `Path is a directory: rm returned EISDIR (is a directory) ${ps}`,
      );
      err.code = "ERR_FS_EISDIR";
      err.errno = 21;
      err.syscall = syscallName;
      err.path = ps;
      throw err;
    }
  }
  {
    const origSync = fs.unlinkSync,
      origCb = fs.unlink;
    fs.unlinkSync = function (p) {
      validatePath(p);
      try {
        checkUnlink(p, "unlink");
        origSync.call(this, toPathString(p));
      } catch (e) {
        throw enrichErr(e, "unlinkSync");
      }
      emitFs("fs", "unlinkSync", p, undefined);
    };
    fs.unlink = function (p, callback) {
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validatePath(p);
      nextTick(() => {
        try {
          checkUnlink(p, "unlink");
          origCb.call(this, toPathString(p), (err) => {
            if (err) return callback(enrichErr(err, "unlink"));
            emitFs("fs", "unlink", p, undefined);
            callback(null);
          });
        } catch (e) {
          callback(enrichErr(e, "unlink"));
        }
      });
    };
  }
  for (const [syncName, cbName] of [
    ["rmSync", "rm"],
    ["rmdirSync", "rmdir"],
  ]) {
    const origSync = fs[syncName],
      origCb = fs[cbName];
    fs[syncName] = function (p, options) {
      validatePath(p);
      try {
        checkRm(p, options, syncName.replace("Sync", ""));
        origSync.call(this, toPathString(p), options);
      } catch (e) {
        throw enrichErr(e, syncName);
      }
      emitFs("fs", syncName, p, undefined);
    };
    fs[cbName] = function (p, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validatePath(p);
      nextTick(() => {
        try {
          checkRm(p, options, cbName);
          origCb.call(this, toPathString(p), options, (err) => {
            if (err) return callback(enrichErr(err, cbName));
            emitFs("fs", cbName, p, undefined);
            callback(null);
          });
        } catch (e) {
          callback(enrichErr(e, cbName));
        }
      });
    };
  }

  // ── truncate: negative → 0; fractional/NaN → ERR_OUT_OF_RANGE ──
  function normalizeTruncateLen(len) {
    if (len === undefined || len === null) return 0;
    const n = Number(len);
    if (!Number.isInteger(n)) {
      const err = new RangeError(
        `The value of "len" is out of range. It must be an integer. Received ${len}`,
      );
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    return n < 0 ? 0 : n;
  }
  {
    const origSync = fs.truncateSync,
      origCb = fs.truncate;
    const origFSync = fs.ftruncateSync,
      origF = fs.ftruncate;
    fs.truncateSync = function (p, len) {
      validatePath(p);
      let result;
      try {
        result = origSync.call(
          this,
          toPathString(p),
          normalizeTruncateLen(len),
        );
      } catch (e) {
        throw enrichErr(e, "truncateSync");
      }
      emitFs("fs", "truncateSync", p, result);
      return result;
    };
    fs.truncate = function (p, len, callback) {
      if (typeof len === "function") {
        callback = len;
        len = undefined;
      }
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validatePath(p);
      let norm;
      try {
        norm = normalizeTruncateLen(len);
      } catch (e) {
        nextTick(callback, enrichErr(e, "truncate"));
        return;
      }
      origCb.call(this, toPathString(p), norm, (err) => {
        if (err) return callback(enrichErr(err, "truncate"));
        emitFs("fs", "truncate", p, undefined);
        callback(null);
      });
    };
    fs.ftruncateSync = function (fd, len) {
      let result;
      try {
        result = origFSync.call(this, fd, normalizeTruncateLen(len));
      } catch (e) {
        throw enrichErr(e, "ftruncateSync");
      }
      emitFs("fs", "ftruncateSync", fd, result);
      return result;
    };
    fs.ftruncate = function (fd, len, callback) {
      if (typeof len === "function") {
        callback = len;
        len = undefined;
      }
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      let norm;
      try {
        norm = normalizeTruncateLen(len);
      } catch (e) {
        nextTick(callback, enrichErr(e, "ftruncate"));
        return;
      }
      origF.call(this, fd, norm, (err) => {
        if (err) return callback(enrichErr(err, "ftruncate"));
        emitFs("fs", "ftruncate", fd, undefined);
        callback(null);
      });
    };
  }

  // ── open/openSync: umask on creation mode ──
  {
    const origSync = fs.openSync,
      origCb = fs.open;
    fs.openSync = function (p, flags, mode) {
      validatePath(p);
      flags = validateFlags(flags);
      mode = validateMode(mode);
      let fd;
      try {
        fd = origSync.call(this, toPathString(p), flags, applyUmask(mode));
      } catch (e) {
        throw enrichErr(e, "openSync");
      }
      emitFs("fs", "openSync", p, fd);
      return fd;
    };
    fs.open = function (p, flags, mode, callback) {
      if (typeof flags === "function") {
        callback = flags;
        flags = undefined;
        mode = undefined;
      } else if (typeof mode === "function") {
        callback = mode;
        mode = undefined;
      }
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validatePath(p);
      flags = validateFlags(flags);
      mode = validateMode(mode);
      origCb.call(this, toPathString(p), flags, applyUmask(mode), (err, fd) => {
        if (err) return callback(enrichErr(err, "open"));
        emitFs("fs", "open", p, fd);
        callback(null, fd);
      });
    };
  }
  // ── close/closeSync: fd validates before the callback (test-fs-close-errors) ──
  // Node's fd validation (probed v24.20.0): type, integer, range 0..2^31-1.
  function validateFd(fd) {
    if (typeof fd !== "number") throw errInvalidArgType("fd", "number", fd);
    if (!Number.isInteger(fd)) {
      const err = new RangeError(
        `The value of "fd" is out of range. It must be an integer. Received ${fd}`,
      );
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    if (fd < 0 || fd > 2147483647) {
      const err = new RangeError(
        `The value of "fd" is out of range. It must be >= 0 && <= 2147483647. Received ${fd}`,
      );
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
  }
  {
    const origSync = fs.closeSync;
    fs.closeSync = function (fd) {
      validateFd(fd);
      try {
        const r = origSync.call(this, fd);
        emitFs("fs", "closeSync", fd, r);
        return r;
      } catch (e) {
        throw enrichErr(e, "closeSync");
      }
    };
  }
  {
    const orig = fs.close;
    fs.close = function (fd, callback) {
      validateFd(fd);
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      const userCb = callback;
      try {
        return orig.call(this, fd, (err) => {
          if (err) return userCb(enrichErr(err, "close"));
          emitFs("fs", "close", fd, undefined);
          userCb(null);
        });
      } catch (e) {
        throw enrichErr(e, "close");
      }
    };
  }

  // ── exists/existsSync: false for invalid paths (never throws) ──
  let existsSyncWarned = false;
  fs.existsSync = function (p) {
    try {
      if (typeof p !== "string" && !isUint8ArrayLike(p) && !isURLLike(p)) {
        // DEP0187: deprecated, warns once, still returns false.
        if (!existsSyncWarned) {
          existsSyncWarned = true;
          try {
            if (
              typeof process !== "undefined" &&
              typeof process.emitWarning === "function"
            ) {
              process.emitWarning(
                "Passing invalid argument types to fs.existsSync is deprecated",
                "DeprecationWarning",
                "DEP0187",
              );
            }
          } catch {}
        }
        return false;
      }
      vol.statSync(toPathString(p));
      return true;
    } catch {
      return false;
    }
  };
  fs.exists = function (p, callback) {
    if (typeof callback !== "function")
      throw errInvalidArgType("cb", "function", callback);
    // Node's exists callback receives only the boolean (no err argument).
    nextTick(() => callback(fs.existsSync(p)));
  };

  // ── copyFile: delegate + enrich + sync mode validation ──
  // Node validates mode synchronously for both forms (probed v24.20.0):
  // non-number -> ERR_INVALID_ARG_TYPE; NaN/±Infinity -> ERR_OUT_OF_RANGE
  // ("mode is out of range"); ToInt32 outside 0..7 -> ERR_OUT_OF_RANGE.
  function validateCopyFileMode(mode) {
    if (mode === undefined || mode === null) return 0;
    if (typeof mode !== "number") {
      const err = new TypeError("mode must be int32 or null/undefined");
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    if (Number.isNaN(mode) || mode === Infinity || mode === -Infinity) {
      const err = new RangeError("mode is out of range");
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    const int = Math.trunc(mode);
    if (int < 0 || int > 7) {
      const err = new RangeError("mode is out of range: >= 0 && <= 7");
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    return int;
  }
  {
    const origSync = fs.copyFileSync;
    fs.copyFileSync = function (src, dest, mode) {
      validatePath(src);
      validatePath(dest, "dest");
      const m = validateCopyFileMode(mode);
      try {
        const r = origSync.call(this, toPathString(src), toPathString(dest), m);
        emitFs("fs", "copyFileSync", src, r);
        return r;
      } catch (e) {
        throw enrichDestErr(e, "copyFileSync", src, dest);
      }
    };
  }
  {
    const orig = fs.copyFile;
    fs.copyFile = function (src, dest, mode, callback) {
      if (typeof mode === "function") {
        callback = mode;
        mode = undefined;
      }
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validatePath(src);
      validatePath(dest, "dest");
      const m = validateCopyFileMode(mode);
      const userCb = callback;
      try {
        return orig.call(
          this,
          toPathString(src),
          toPathString(dest),
          m,
          (err) => {
            if (err) return userCb(enrichDestErr(err, "copyFile", src, dest));
            emitFs("fs", "copyFile", src, undefined);
            userCb(null);
          },
        );
      } catch (e) {
        throw enrichDestErr(e, "copyFile", src, dest);
      }
    };
  }

  // ── cp/cpSync ──
  function cpCheckRange(options) {
    const mode = options && options.mode;
    if (mode !== undefined && mode !== null) {
      const m = Number(mode);
      if (!Number.isInteger(m) || m < 0 || m > 7) {
        const err = new RangeError(
          `The value of "mode" is out of range. It must be >= 0 && <= 7. Received ${mode}`,
        );
        err.code = "ERR_OUT_OF_RANGE";
        throw err;
      }
    }
  }
  function cpImpl(src, dest, options) {
    const opts = options || {};
    cpCheckRange(opts);
    const s = toPathString(src),
      d = toPathString(dest);
    let srcLstat = null;
    try {
      srcLstat = vol.lstatSync(s);
    } catch (e) {
      throw enrichErr(e, "cp");
    }
    const deref = !!opts.dereference;
    const srcIsDir =
      srcLstat.isSymbolicLink() && !deref
        ? false
        : (() => {
            try {
              return vol.statSync(s).isDirectory();
            } catch {
              return srcLstat.isDirectory();
            }
          })();
    let destSt = null;
    try {
      // With dereference:false, lstat the dest so a symlink-to-dir is not
      // mistaken for a directory (test-fs-cp-sync-dereference).
      destSt = deref ? vol.statSync(d) : vol.lstatSync(d);
    } catch {
      /* ignore */
    }

    if (s === d) {
      const err = makeFsError(
        "ERR_FS_CP_EINVAL",
        "cp",
        s,
        "Invalid src or dest: cp returned EINVAL",
      );
      err.errno = 22;
      throw err;
    }
    if (srcIsDir) {
      if (!opts.recursive) {
        const err = makeFsError(
          "ERR_FS_EISDIR",
          "cp",
          s,
          "Path is a directory: cp returned EISDIR",
        );
        err.errno = 21;
        throw err;
      }
      if (destSt && !destSt.isDirectory()) {
        const err = makeFsError(
          "ERR_FS_CP_DIR_TO_NON_DIR",
          "cp",
          s,
          "Invalid src or dest: cp returned EINVAL",
        );
        err.errno = 22;
        throw err;
      }
      // dest inside src?
      if (d === s || d.startsWith(s + "/")) {
        const err = makeFsError(
          "ERR_FS_CP_EINVAL",
          "cp",
          s,
          "Invalid src or dest: cp returned EINVAL",
        );
        err.errno = 22;
        throw err;
      }
    } else if (destSt && destSt.isDirectory()) {
      const err = makeFsError(
        "ERR_FS_CP_NON_DIR_TO_DIR",
        "cp",
        s,
        "Invalid src or dest: cp returned EINVAL",
      );
      err.errno = 22;
      throw err;
    }

    const filter = opts.filter;
    const doCopy = (from, to) => {
      if (filter && !filter(from, to)) return;
      let lst;
      try {
        lst = vol.lstatSync(from);
      } catch {
        return;
      }
      if (lst.isSymbolicLink() && !deref) {
        const target = vol.readlinkSync(from);
        const linkTarget = opts.verbatimSymlinks
          ? target
          : target.startsWith("/")
            ? target
            : posixResolve(posixDirname(from), target);
        try {
          vol.symlinkSync(linkTarget, to);
        } catch (e) {
          if (opts.force !== false) {
            try {
              vol.unlinkSync(to);
            } catch {}
            vol.symlinkSync(linkTarget, to);
          } else throw e;
        }
        return;
      }
      const st = vol.statSync(from);
      if (st.isDirectory()) {
        try {
          vol.mkdirSync(to, { recursive: true });
        } catch {
          /* ignore */
        }
        for (const name of vol.readdirSync(from)) {
          doCopy(from + "/" + name, to + "/" + name);
        }
        // timestamps
        try {
          vol.utimesSync(to, st.atime, st.mtime);
        } catch {}
      } else {
        const existsDest = (() => {
          try {
            vol.statSync(to);
            return true;
          } catch {
            return false;
          }
        })();
        if (existsDest && opts.force === false && !opts.errorOnExist) return;
        if (existsDest && opts.errorOnExist) {
          throw enrichErr(
            makeFsError("EEXIST", "cp", to, "file already exists"),
            "cp",
          );
        }
        // With dereference:false, a dest symlink must be replaced, not
        // followed (memfs's copyFileSync follows it into EISDIR).
        if (!deref) {
          try {
            if (vol.lstatSync(to).isSymbolicLink()) vol.unlinkSync(to);
          } catch {}
        }
        vol.copyFileSync(from, to);
        const srcStat = vol.statSync(from);
        try {
          vol.utimesSync(to, srcStat.atime, srcStat.mtime);
        } catch {}
        if (opts.preserveTimestamps) {
          try {
            vol.utimesSync(to, srcStat.atime, srcStat.mtime);
            vol.chmodSync(to, srcStat.mode);
          } catch {}
        }
      }
    };

    const finalDest = srcIsDir || (destSt && destSt.isDirectory()) ? d : d;
    if (srcIsDir) {
      try {
        vol.mkdirSync(finalDest, { recursive: true });
      } catch {}
      for (const name of vol.readdirSync(s)) {
        doCopy(s + "/" + name, finalDest + "/" + name);
      }
    } else {
      const target =
        destSt && destSt.isDirectory()
          ? finalDest + "/" + s.slice(s.lastIndexOf("/") + 1)
          : finalDest;
      doCopy(s, target);
    }
  }
  fs.cpSync = function (src, dest, options) {
    validatePath(src);
    validatePath(dest, "dest");
    try {
      cpImpl(src, dest, options);
    } catch (e) {
      throw enrichErr(e, "cpSync");
    }
    emitFs("fs", "cpSync", src, undefined);
  };
  fs.cp = function (src, dest, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    if (typeof callback !== "function")
      throw errInvalidArgType("cb", "function", callback);
    validatePath(src);
    validatePath(dest, "dest");
    nextTick(() => {
      try {
        cpImpl(src, dest, options);
        emitFs("fs", "cp", src, undefined);
        callback(null);
      } catch (e) {
        callback(enrichErr(e, "cp"));
      }
    });
  };

  // Node validates the encoding (string options, or options.encoding) via
  // getOptions BEFORE the path: an unknown encoding is a synchronous
  // ERR_INVALID_ARG_VALUE TypeError (test-fs-assert-encoding-error.js).
  function validateEncodingOpt(options) {
    const enc =
      typeof options === "string"
        ? options
        : options !== null && typeof options === "object"
          ? options.encoding
          : undefined;
    if (enc === undefined || enc === null) return;
    let ok = false;
    if (typeof enc === "string") {
      ok =
        typeof Buffer !== "undefined" && Buffer.isEncoding
          ? Buffer.isEncoding(enc)
          : /^(utf-?8|ascii|latin1|binary|base64|base64url|hex|ucs-?2|utf-?16le)$/i.test(
              enc,
            );
    }
    if (!ok) {
      const err = new TypeError(
        `The argument 'encoding' is invalid encoding. Received '${String(enc)}'`,
      );
      err.code = "ERR_INVALID_ARG_VALUE";
      throw err;
    }
  }

  // ── readFile/writeFile/appendFile: accept fd-or-path ──
  function fileArg(p) {
    if (typeof p === "number") return p;
    validatePath(p);
    return toPathString(p);
  }
  for (const [syncName, cbName] of [
    ["readFileSync", "readFile"],
    ["writeFileSync", "writeFile"],
    ["appendFileSync", "appendFile"],
  ]) {
    const origSync = fs[syncName],
      origCb = fs[cbName];
    fs[syncName] = function (p, ...rest) {
      // Encoding validated before the path (Node's getOptions order).
      validateEncodingOpt(syncName === "readFileSync" ? rest[0] : rest[1]);
      let data = rest[0];
      if (syncName !== "readFileSync") {
        validateDataArg(data, "data");
        data = normalizeDataArg(data);
      }
      const fp = fileArg(p);
      // memfs doesn't apply the umask on file creation; fix the mode if we
      // created the file and no explicit mode was given.
      let existed = true;
      try {
        vol.statSync(fp);
      } catch {
        existed = false;
      }
      let result;
      try {
        result = origSync.call(this, fp, data, ...rest.slice(1));
      } catch (e) {
        throw enrichErr(e, syncName);
      }
      if (!existed) {
        // File was created: apply umask if no explicit mode was given.
        // (For readFileSync, options is rest[0]; for write/append, rest[1].)
        const options = syncName === "readFileSync" ? rest[0] : rest[1];
        const optMode =
          options && typeof options === "object" ? options.mode : undefined;
        if (optMode === undefined) {
          try {
            vol.chmodSync(fp, applyUmask(0o666));
          } catch {}
        }
      }
      emitFs("fs", syncName, p, result);
      return result;
    };
    fs[cbName] = function (p, ...rest) {
      const callback = rest[rest.length - 1];
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      const args = rest.slice(0, -1);
      if (cbName !== "readFile") {
        // Real Node validates data synchronously (throws, not callback error).
        validateDataArg(args[0], "data");
        args[0] = normalizeDataArg(args[0]);
      }
      // Encoding validated before the path (Node's getOptions order).
      validateEncodingOpt(cbName === "readFile" ? args[0] : args[1]);
      // Path validation (incl. null bytes) also throws synchronously in Node.
      const fp = fileArg(p);
      origCb.call(this, fp, ...args, (err, result) => {
        if (err) return callback(enrichErr(err, cbName));
        emitFs("fs", cbName, p, result);
        // Node calls writeFile/appendFile callbacks with a single argument
        // (no result); readFile passes (null, data).
        if (cbName === "readFile") callback(null, result);
        else callback(null);
      });
    };
  }

  // ── opendir/opendirSync + Dir (auto-close after for-await) ──
  function dirClosedError() {
    const err = new Error("Directory is closed");
    err.code = "ERR_DIR_CLOSED";
    return err;
  }
  class Dir {
    constructor(path) {
      if (arguments.length === 0) {
        const err = new TypeError('The "path" argument must be specified');
        err.code = "ERR_MISSING_ARGS";
        throw err;
      }
      this.path = path;
      this._closed = false;
      this._entries = null;
    }
    _ensure() {
      if (this._closed) throw dirClosedError();
      if (!this._entries) {
        const names = vol.readdirSync(this.path);
        this._entries = names.map((name) => {
          let mode = 0;
          try {
            mode = vol.lstatSync(this.path + "/" + name).mode;
          } catch {
            /* ignore */
          }
          return new Dirent(name, this.path, mode);
        });
        this._index = 0;
      }
    }
    readSync() {
      this._ensure();
      if (this._index >= this._entries.length) return null;
      return this._entries[this._index++];
    }
    read(callback) {
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      nextTick(() => {
        try {
          callback(null, this.readSync());
        } catch (e) {
          callback(e);
        }
      });
    }
    closeSync() {
      if (this._closed) throw dirClosedError();
      this._closed = true;
      emitFs("fs", "Dir.closeSync", this.path, undefined);
    }
    close(callback) {
      if (typeof callback !== "function")
        return Promise.resolve().then(() => this.closeSync());
      nextTick(() => {
        try {
          this.closeSync();
          callback(null);
        } catch (e) {
          callback(e);
        }
      });
    }
    // Explicit resource management; repeat invocations are silent no-ops
    // (unlike closeSync, which throws ERR_DIR_CLOSED when already closed).
    [Symbol.dispose]() {
      if (!this._closed) this.closeSync();
    }
    [Symbol.asyncDispose]() {
      if (!this._closed) this.closeSync();
      return Promise.resolve();
    }
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const entry = this.readSync();
          if (entry === null) break;
          yield entry;
        }
      } finally {
        // Real Node auto-closes the Dir when for-await completes.
        if (!this._closed) this.closeSync();
      }
    }
  }
  fs.Dir = Dir;
  fs.opendirSync = function (p, options) {
    validatePath(p);
    const ps = toPathString(p);
    let dir;
    try {
      const st = vol.statSync(ps);
      if (!st.isDirectory()) {
        throw enrichErr(
          makeFsError("ENOTDIR", "opendir", ps, "not a directory"),
          "opendirSync",
        );
      }
      dir = new Dir(ps);
    } catch (e) {
      throw enrichErr(e, "opendirSync");
    }
    emitFs("fs", "opendirSync", p, dir);
    return dir;
  };
  fs.opendir = function (p, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    if (typeof callback !== "function")
      throw errInvalidArgType("cb", "function", callback);
    validatePath(p);
    nextTick(() => {
      try {
        const dir = fs.opendirSync(p, options);
        callback(null, dir);
      } catch (e) {
        callback(enrichErr(e, "opendir"));
      }
    });
  };

  // ── glob/globSync ──
  function globMatch(pattern, path) {
    // Convert a glob pattern to a RegExp (supports *, **, ?).
    let re = "";
    let i = 0;
    while (i < pattern.length) {
      const c = pattern[i];
      if (c === "*") {
        if (pattern[i + 1] === "*") {
          // **/ or /** or **
          if (pattern[i + 2] === "/") {
            re += "(?:.*/)?";
            i += 3;
          } else {
            re += ".*";
            i += 2;
          }
        } else {
          re += "[^/]*";
          i += 1;
        }
      } else if (c === "?") {
        re += "[^/]";
        i += 1;
      } else if ("+^${}()|[]\\.".includes(c)) {
        re += "\\" + c;
        i += 1;
      } else {
        re += c;
        i += 1;
      }
    }
    return new RegExp("^" + re + "$").test(path);
  }
  function globImpl(patterns, options) {
    const opts = options || {};
    const cwd = opts.cwd ? toPathString(opts.cwd) : "/";
    const pats = Array.isArray(patterns) ? patterns : [patterns];
    const exclude = opts.exclude
      ? Array.isArray(opts.exclude)
        ? opts.exclude
        : [opts.exclude]
      : [];
    const withFileTypes = !!opts.withFileTypes;
    const results = [];
    const seen = new Set();
    // Collect all files/dirs under cwd.
    const all = [];
    const walk = (dir) => {
      let names;
      try {
        names = vol.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const full = dir === "/" ? "/" + name : dir + "/" + name;
        all.push(full);
        let st;
        try {
          st = vol.lstatSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory() && !st.isSymbolicLink()) walk(full);
      }
    };
    walk(cwd);
    for (let pat of pats) {
      const p = toPathString(pat);
      const absPat = p.startsWith("/") ? p : cwd + "/" + p;
      for (const full of all) {
        if (!globMatch(absPat, full)) continue;
        if (
          exclude.some((e) =>
            globMatch(
              toPathString(e).startsWith("/")
                ? toPathString(e)
                : cwd + "/" + toPathString(e),
              full,
            ),
          )
        )
          continue;
        // Relative patterns yield cwd-relative results; absolute yield absolute.
        const out = p.startsWith("/") ? full : full.slice(cwd.length + 1);
        if (seen.has(out)) continue;
        seen.add(out);
        if (withFileTypes) {
          let mode = 0;
          try {
            mode = vol.lstatSync(full).mode;
          } catch {
            /* ignore */
          }
          results.push(
            new Dirent(
              full.slice(full.lastIndexOf("/") + 1),
              full.slice(0, full.lastIndexOf("/") + 1).replace(/\/$/, "") ||
                "/",
              mode,
            ),
          );
        } else {
          results.push(out);
        }
      }
    }
    return results;
  }
  fs.globSync = function (patterns, options) {
    let result;
    try {
      result = globImpl(patterns, options);
    } catch (e) {
      throw enrichErr(e, "globSync");
    }
    emitFs("fs", "globSync", patterns, result);
    return result;
  };
  fs.glob = function (patterns, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    if (callback && typeof callback !== "function")
      throw errInvalidArgType("cb", "function", callback);
    const run = () => {
      try {
        const result = globImpl(patterns, options);
        emitFs("fs", "glob", patterns, result);
        if (callback) callback(null, result);
        return result;
      } catch (e) {
        const err = enrichErr(e, "glob");
        if (callback) callback(err);
        else throw err;
      }
    };
    if (callback) {
      nextTick(run);
      return undefined;
    }
    // No callback → return async iterator (real Node) — also usable as promise via then? No:
    // real Node's glob without callback returns an AsyncIterable.
    async function* gen() {
      const result = globImpl(patterns, options);
      for (const r of result) yield r;
    }
    return gen();
  };

  // ── lutimes/lutimesSync (via vol.getLink; memfs lacks these) ──
  function toDate(v, name) {
    if (v instanceof Date) return v;
    if (typeof v === "number" || typeof v === "string") {
      const d = new Date(typeof v === "number" ? v * 1000 : v);
      if (isNaN(d.getTime())) throw errInvalidArgType(name, "Date", v);
      return d;
    }
    throw errInvalidArgType(name, "Date", v);
  }
  function lutimesImpl(p, atime, mtime) {
    const ps = toPathString(p);
    const at = toDate(atime, "atime"),
      mt = toDate(mtime, "mtime");
    const steps = ps.split("/").filter(Boolean);
    let link = null;
    try {
      link = vol.getLink(steps);
    } catch {
      link = null;
    }
    if (!link) {
      // Match memfs/Node ENOENT shape for a missing path.
      try {
        vol.lstatSync(ps);
      } catch (e) {
        throw e;
      }
      throw enrichErr(
        makeFsError("ENOENT", "lstat", ps, "no such file or directory"),
        "lutimes",
      );
    }
    const node = link.getNode();
    node.atime = at;
    node.mtime = mt;
  }
  fs.lutimesSync = function (p, atime, mtime) {
    validatePath(p);
    try {
      lutimesImpl(p, atime, mtime);
    } catch (e) {
      throw enrichErr(e, "lutimesSync");
    }
    emitFs("fs", "lutimesSync", p, undefined);
  };
  fs.lutimes = function (p, atime, mtime, callback) {
    if (typeof callback !== "function")
      throw errInvalidArgType("cb", "function", callback);
    validatePath(p);
    nextTick(() => {
      try {
        lutimesImpl(p, atime, mtime);
        emitFs("fs", "lutimes", p, undefined);
        callback(null);
      } catch (e) {
        callback(enrichErr(e, "lutimes"));
      }
    });
  };

  // ── statfs/statfsSync (memfs lacks these) ──
  function statfsImpl(p) {
    const ps = toPathString(p);
    try {
      vol.statSync(ps);
    } catch (e) {
      throw e;
    }
    return {
      type: 0x65735546, // FUSE_SUPER_MAGIC-ish placeholder
      bsize: 4096,
      frsize: 4096,
      blocks: 1024 * 1024,
      bfree: 512 * 1024,
      bavail: 512 * 1024,
      files: 1024 * 1024,
      ffree: 512 * 1024,
    };
  }
  fs.statfsSync = function (p, options) {
    validatePath(p);
    let result;
    try {
      result = statfsImpl(p);
    } catch (e) {
      throw enrichErr(e, "statfsSync");
    }
    emitFs("fs", "statfsSync", p, result);
    return result;
  };
  fs.statfs = function (p, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    if (typeof callback !== "function")
      throw errInvalidArgType("cb", "function", callback);
    validatePath(p);
    nextTick(() => {
      try {
        const result = statfsImpl(p);
        emitFs("fs", "statfs", p, result);
        callback(null, result);
      } catch (e) {
        callback(enrichErr(e, "statfs"));
      }
    });
  };

  // ── mkdtemp/mkdtempSync + Disposable variants ──
  function mkdtempImpl(prefix, options) {
    const pre = toPathString(prefix);
    const chars =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for (let attempt = 0; attempt < 10; attempt++) {
      let rand = "";
      for (let i = 0; i < 6; i++)
        rand += chars[(Math.random() * chars.length) | 0];
      const dir = pre + rand;
      try {
        vol.mkdirSync(dir);
        return options &&
          options.encoding === "buffer" &&
          typeof Buffer !== "undefined"
          ? Buffer.from(dir)
          : dir;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    }
    throw enrichErr(
      makeFsError("EEXIST", "mkdtemp", pre, "file already exists"),
      "mkdtemp",
    );
  }
  fs.mkdtempSync = function (prefix, options) {
    validateEncodingOpt(options);
    validatePath(prefix, "prefix");
    let result;
    try {
      result = mkdtempImpl(prefix, options);
    } catch (e) {
      throw enrichErr(e, "mkdtempSync");
    }
    emitFs("fs", "mkdtempSync", prefix, result);
    return result;
  };
  fs.mkdtemp = function (prefix, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    if (typeof callback !== "function")
      throw errInvalidArgType("cb", "function", callback);
    validateEncodingOpt(options);
    validatePath(prefix, "prefix");
    nextTick(() => {
      try {
        const result = mkdtempImpl(prefix, options);
        emitFs("fs", "mkdtemp", prefix, result);
        callback(null, result);
      } catch (e) {
        callback(enrichErr(e, "mkdtemp"));
      }
    });
  };
  fs.mkdtempDisposableSync = function (prefix, options) {
    const dir = fs.mkdtempSync(prefix, options);
    return {
      path: dir,
      [Symbol.dispose]() {
        try {
          vol.rmSync(toPathString(dir), { recursive: true, force: true });
        } catch {}
      },
    };
  };
  fs.mkdtempDisposable = async function (prefix, options) {
    const dir = await new Promise((resolve, reject) => {
      fs.mkdtemp(prefix, options, (err, d) => (err ? reject(err) : resolve(d)));
    });
    return {
      path: dir,
      [Symbol.asyncDispose]() {
        return new Promise((resolve) => {
          fs.rm(toPathString(dir), { recursive: true, force: true }, () =>
            resolve(),
          );
        });
      },
    };
  };

  // ── openAsBlob ──
  fs.openAsBlob = async function (p, options) {
    validatePath(p);
    const ps = toPathString(p);
    let data;
    try {
      data = vol.readFileSync(ps);
    } catch (e) {
      throw enrichErr(e, "openAsBlob");
    }
    emitFs("fs", "openAsBlob", p, undefined);
    const type = (options && options.type) || "";
    if (typeof Blob !== "undefined") return new Blob([data], { type });
    // Minimal Blob fallback.
    return {
      size: data.length,
      type,
      arrayBuffer: async () =>
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      text: async () => new TextDecoder().decode(data),
    };
  };

  // ── realpath/realpathSync + .native ──
  // Node's JS realpath resolves by lstat()ing each path component, so a
  // missing path surfaces as an lstat ENOENT; realpath.native goes to the
  // binding and surfaces a realpath ENOENT (test-fs-error-messages).
  function realpathImpl(p, options, native) {
    const ps = toPathString(p);
    let resolved;
    try {
      resolved = vol.realpathSync(ps);
    } catch (e) {
      if (!native && e && e.code === "ENOENT") {
        // Node's JS realpath surfaces the lstat ENOENT (message rewritten
        // here; enrichErr honors the _syscallOverride marker).
        try {
          e._syscallOverride = "lstat";
          if (typeof e.message === "string") {
            e.message = e.message.replace(/, realpath '/, ", lstat '");
          }
        } catch {}
      }
      throw e;
    }
    if (
      options &&
      options.encoding === "buffer" &&
      typeof Buffer !== "undefined"
    ) {
      return Buffer.from(resolved);
    }
    return resolved;
  }
  function normalizeRealpathOptions(options) {
    return typeof options === "string" ? { encoding: options } : options;
  }
  function makeRealpathSync(native) {
    return function (p, options) {
      validateEncodingOpt(options);
      validatePath(p);
      let result;
      try {
        result = realpathImpl(p, normalizeRealpathOptions(options), native);
      } catch (e) {
        throw enrichErr(e, "realpathSync");
      }
      emitFs("fs", "realpathSync", p, result);
      return result;
    };
  }
  fs.realpathSync = makeRealpathSync(false);
  fs.realpathSync.native = makeRealpathSync(true);
  function makeRealpath(native) {
    return function (p, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validateEncodingOpt(options);
      validatePath(p);
      nextTick(() => {
        try {
          const result = realpathImpl(
            p,
            normalizeRealpathOptions(options),
            native,
          );
          emitFs("fs", "realpath", p, result);
          callback(null, result);
        } catch (e) {
          callback(enrichErr(e, "realpath"));
        }
      });
    };
  }
  fs.realpath = makeRealpath(false);
  fs.realpath.native = makeRealpath(true);

  // ── link/symlink/readlink: delegate + enrich/emit ──
  wrapSync("linkSync", null, true, 1);
  wrapCb("link", null, true, 1);
  wrapSync("symlinkSync", null, true, 1);
  wrapCb("symlink", null, true, 1);
  wrapSync("readlinkSync", null, true);
  wrapCb("readlink", null, true);
  // readlink validates the encoding before the path (getOptions order).
  {
    const oS = fs.readlinkSync,
      oC = fs.readlink;
    fs.readlinkSync = function (p, options) {
      validateEncodingOpt(options);
      return oS.call(this, p, options);
    };
    fs.readlink = function (p, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      validateEncodingOpt(options);
      return oC.call(this, p, options, callback);
    };
  }
  wrapSync("chmodSync", null, true);
  wrapCb("chmod", null, true);
  // ── fchmod/fchmodSync: fd, then mode, then callback (test-fs-fchmod) ──
  // fchmod's mode is stricter than open()'s: null/undefined are rejected.
  function validateFchmodMode(mode) {
    if (mode === undefined || mode === null)
      throw errInvalidArgType("mode", "number", mode);
    return validateMode(mode, 0o666);
  }
  {
    const origSync = fs.fchmodSync;
    fs.fchmodSync = function (fd, mode) {
      validateFd(fd);
      const m = validateFchmodMode(mode);
      try {
        const r = origSync.call(this, fd, m);
        emitFs("fs", "fchmodSync", fd, r);
        return r;
      } catch (e) {
        throw enrichErr(e, "fchmodSync");
      }
    };
  }
  {
    const orig = fs.fchmod;
    fs.fchmod = function (fd, mode, callback) {
      validateFd(fd);
      const m = validateFchmodMode(mode);
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      try {
        return orig.call(this, fd, m, (err) => {
          if (err) return callback(enrichErr(err, "fchmod"));
          emitFs("fs", "fchmod", fd, undefined);
          callback(null);
        });
      } catch (e) {
        throw enrichErr(e, "fchmod");
      }
    };
  }
  // ── chown/fchown/lchown: uid/gid -1 means "don't change" (POSIX) ──
  function resolveUidGid(uid, gid, getStats) {
    if (uid === -1 || gid === -1) {
      const st = getStats();
      if (uid === -1) uid = st.uid;
      if (gid === -1) gid = st.gid;
    }
    return [uid, gid];
  }
  {
    const origSync = fs.chownSync;
    fs.chownSync = function (p, uid, gid) {
      validatePath(p);
      validateUidGid(uid, gid);
      const ps = toPathString(p);
      [uid, gid] = resolveUidGid(uid, gid, () => vol.statSync(ps));
      try {
        const r = origSync.call(this, ps, uid, gid);
        emitFs("fs", "chownSync", p, r);
        return r;
      } catch (e) {
        throw enrichErr(e, "chownSync");
      }
    };
  }
  {
    const orig = fs.chown;
    fs.chown = function (p, uid, gid, callback) {
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validatePath(p);
      validateUidGid(uid, gid);
      const ps = toPathString(p);
      let resolved;
      try {
        resolved = resolveUidGid(uid, gid, () => vol.statSync(ps));
      } catch (e) {
        nextTick(callback, enrichErr(e, "chown"));
        return;
      }
      orig.call(this, ps, resolved[0], resolved[1], (err) => {
        if (err) return callback(enrichErr(err, "chown"));
        emitFs("fs", "chown", p, undefined);
        callback(null);
      });
    };
  }
  wrapSync("fchownSync", null, null, null, true);
  wrapCb("fchown", null, null, null, true);
  {
    const origSync = fs.lchownSync;
    fs.lchownSync = function (p, uid, gid) {
      validatePath(p);
      validateUidGid(uid, gid);
      const ps = toPathString(p);
      [uid, gid] = resolveUidGid(uid, gid, () => vol.lstatSync(ps));
      try {
        const r = origSync.call(this, ps, uid, gid);
        emitFs("fs", "lchownSync", p, r);
        return r;
      } catch (e) {
        throw enrichErr(e, "lchownSync");
      }
    };
  }
  {
    const orig = fs.lchown;
    fs.lchown = function (p, uid, gid, callback) {
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validatePath(p);
      validateUidGid(uid, gid);
      const ps = toPathString(p);
      let resolved;
      try {
        resolved = resolveUidGid(uid, gid, () => vol.lstatSync(ps));
      } catch (e) {
        nextTick(callback, enrichErr(e, "lchown"));
        return;
      }
      orig.call(this, ps, resolved[0], resolved[1], (err) => {
        if (err) return callback(enrichErr(err, "lchown"));
        emitFs("fs", "lchown", p, undefined);
        callback(null);
      });
    };
  }
  wrapSync("utimesSync", null, true);
  wrapCb("utimes", null, true);
  wrapSync("futimesSync", null, null, null, true);
  wrapCb("futimes", null, null, null, true);
  wrapSync("fsyncSync", null, null, null, true);
  wrapCb("fsync", null, null, null, true);
  wrapSync("fdatasyncSync", null, null, null, true);
  wrapCb("fdatasync", null, null, null, true);
  // lchmod/lchmodSync are undefined on Linux (Node behavior).
  try {
    if (typeof process !== "undefined" && process.platform === "linux") {
      fs.lchmod = undefined;
      fs.lchmodSync = undefined;
    } else {
      wrapSync("lchmodSync");
      wrapCb("lchmod");
    }
  } catch {
    /* ignore */
  }

  // ── watch/watchFile: add ref()/unref(), emit events ──
  function patchWatcher(w, path) {
    if (w && typeof w === "object") {
      if (typeof w.ref !== "function") {
        w.ref = function () {
          return w;
        };
      }
      if (typeof w.unref !== "function") {
        w.unref = function () {
          return w;
        };
      }
      const origClose = w.close ? w.close.bind(w) : null;
      if (origClose) {
        // memfs's FSWatcher.close() never emits 'close'; Node emits it
        // asynchronously (and once). AbortSignal integration and the
        // promises.watch async iterator both depend on it.
        let closeEmitted = false;
        w.close = function (...args) {
          emitFs("fs", "watcher.close", path, undefined);
          const cb = args.find((a) => typeof a === "function");
          if (cb) w.once("close", cb);
          const r = origClose(...args);
          if (!closeEmitted) {
            closeEmitted = true;
            nextTick(() => {
              try {
                w.emit("close");
              } catch {}
            });
          }
          return r;
        };
      }
    }
    return w;
  }
  {
    const orig = fs.watch;
    fs.watch = function (p, options, listener) {
      if (typeof options === "function") {
        listener = options;
        options = undefined;
      }
      // Node's getOptions: options must be an object, a string, or absent.
      if (
        options !== undefined &&
        options !== null &&
        typeof options !== "object" &&
        typeof options !== "string"
      ) {
        throw errInvalidArgType("options", ["Object", "string"], options);
      }
      // Node validates options.signal before the path (getOptions order).
      const signal =
        options !== null && typeof options === "object"
          ? validateAbortSignal(options.signal)
          : undefined;
      validateEncodingOpt(options);
      validatePath(p);
      const ps = toPathString(p);
      let w;
      try {
        w = orig.call(this, ps, options, listener);
      } catch (e) {
        throw enrichErr(e, "watch");
      }
      patchWatcher(w, ps);
      if (signal) {
        // Aborting closes the watcher (its 'close' event fires as usual).
        if (signal.aborted) nextTick(() => w.close());
        else signal.addEventListener("abort", () => w.close(), { once: true });
      }
      emitFs("fs", "watch", p, w);
      return w;
    };
  }
  // watchFile: poll-based, safe replacement.
  const _watchFileTimers = new Map();
  fs.watchFile = function (p, options, listener) {
    if (typeof options === "function") {
      listener = options;
      options = undefined;
    }
    if (typeof listener !== "function")
      throw errInvalidArgType("listener", "function", listener);
    validatePath(p);
    const ps = toPathString(p);
    const interval = (options && options.interval) || 5007;
    let prev = null;
    try {
      prev = toStats(vol.statSync(ps));
    } catch {
      /* ignore */
    }
    const timer = setInterval(() => {
      let curr = null;
      try {
        curr = toStats(vol.statSync(ps));
      } catch {
        /* ignore */
      }
      const changed =
        (!prev && curr) ||
        (prev && !curr) ||
        (prev &&
          curr &&
          (prev.mtimeMs !== curr.mtimeMs || prev.size !== curr.size));
      if (changed) {
        try {
          listener(curr || prev, prev);
        } catch {
          /* ignore */
        }
      }
      prev = curr;
    }, interval);
    if (timer.unref) timer.unref();
    const key = ps + "\x00" + interval;
    if (!_watchFileTimers.has(key)) _watchFileTimers.set(key, new Set());
    _watchFileTimers.get(key).add(timer);
    const statWatcher = {
      ref() {
        if (timer.ref) timer.ref();
        return statWatcher;
      },
      unref() {
        if (timer.unref) timer.unref();
        return statWatcher;
      },
    };
    emitFs("fs", "watchFile", p, statWatcher);
    return statWatcher;
  };
  fs.unwatchFile = function (p, listener) {
    validatePath(p);
    const ps = toPathString(p);
    for (const [key, timers] of _watchFileTimers) {
      if (key.startsWith(ps + "\x00")) {
        for (const t of timers) clearInterval(t);
        _watchFileTimers.delete(key);
      }
    }
    emitFs("fs", "unwatchFile", p, undefined);
  };

  // ── createReadStream/createWriteStream (project's local stream impl) ──
  // Node's fs streams close their fd through the PUBLIC fs.close (not the
  // internal volume), so user monkey-patches and observability hooks see it
  // (test-fs-write-stream.js replaces fs.close and asserts it is called).
  function closeStreamFd(stream) {
    // A handle-backed stream closes the handle on destroy (Node's
    // streams.js _close -> FileHandleOperations.close -> handle.close()),
    // even with autoClose:false (FileHandle.createReadStream passes it).
    if (stream._fileHandle) {
      const h = stream._fileHandle;
      stream._fileHandle = null;
      try {
        const r = h.close();
        if (r && typeof r.catch === "function") r.catch(() => {});
      } catch {}
      return;
    }
    // A FileHandle-owned fd (or autoClose:false) is never closed by us.
    if (!stream.autoClose || !stream._opened || stream.fd === null) return;
    const fd = stream.fd;
    stream.fd = null;
    stream._opened = false;
    // Through the impl's close (default: the public fs.close), so user
    // monkey-patches and observability hooks see it, as in Node.
    try {
      stream._impl.close(fd, () => {});
    } catch {
      try {
        vol.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  // Build the options object for the stream super() call: preserve the
  // prototype chain (official tests sneak options in via __proto__, e.g.
  // { __proto__: { encoding: "utf8" } } in test-fs-read-stream-inherit.js —
  // a spread would drop them), then apply Node's fs-stream defaults:
  // autoDestroy = autoClose (default true), highWaterMark 64KB.
  function streamOpts(opts) {
    // A string options argument is the encoding
    // (fs.createReadStream(path, "utf8") — documented Node API).
    if (typeof opts === "string") opts = { encoding: opts };
    const o = Object.create(Object.getPrototypeOf(opts) || null);
    Object.assign(o, opts);
    o.autoDestroy = opts.autoClose === undefined ? true : opts.autoClose;
    if (o.highWaterMark === undefined) o.highWaterMark = 64 * 1024;
    return o;
  }
  // Node's start/end validation for fs streams (lib/internal/fs/streams.js),
  // probed via test-fs-read-stream-throw-type-error.js.
  function validateIntegerInRange(value, name, min) {
    if (typeof value !== "number")
      throw errInvalidArgType(name, "number", value);
    if (!Number.isSafeInteger(value)) {
      const err = new RangeError(
        `The value of "${name}" is out of range. It must be an integer. Received ${value}`,
      );
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    if (value < min) {
      const err = new RangeError(
        `The value of "${name}" is out of range. It must be >= ${min}. Received ${value}`,
      );
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
  }
  function validateStreamStartEnd(opts) {
    const start = opts.start;
    const end = opts.end;
    if (start !== undefined) validateIntegerInRange(start, "start", 0);
    if (end === undefined) return Infinity;
    if (end !== Infinity) {
      validateIntegerInRange(end, "end", 0);
      if (start !== undefined && start > end) {
        const err = new RangeError(
          `The value of "start" is out of range. It must be <= "end" (here: ${end}). Received ${start}`,
        );
        err.code = "ERR_OUT_OF_RANGE";
        throw err;
      }
    }
    return end;
  }
  // The options argument itself: object, string (encoding), null, or
  // undefined. Anything else is ERR_INVALID_ARG_TYPE.
  function validateStreamOptions(options) {
    if (
      options !== undefined &&
      options !== null &&
      typeof options !== "string" &&
      typeof options !== "object"
    ) {
      throw errInvalidArgType("options", "Object", options);
    }
  }
  // DEP0135: ReadStream.prototype.open() / WriteStream.prototype.open()
  // are deprecated noops kept for backwards compat. Overriding open() is
  // still honored (Node's _construct hack; test-fs-read-stream-patch-open).
  // Returns the canonical noop so the override check below can compare
  // against the original, not the (possibly mutated) prototype.
  function deprecateStreamOpen(prototype, kind) {
    let warned = false;
    const noop = function () {
      if (!warned) {
        warned = true;
        try {
          if (
            typeof process !== "undefined" &&
            typeof process.emitWarning === "function"
          ) {
            process.emitWarning(
              `${kind}.prototype.open() is deprecated`,
              "DeprecationWarning",
              "DEP0135",
            );
          }
        } catch {}
      }
    };
    prototype.open = noop;
    return noop;
  }
  // Node's _construct backwards-compat hack for monkey-patched open():
  // when the instance's open() differs from the prototype's deprecated
  // noop, call it and settle when it emits 'open' or 'error'
  // (test-fs-read-stream-patch-open.js).
  function openWithPatchedOpen(stream) {
    const origEmit = stream.emit;
    stream.emit = function (...args) {
      if (args[0] === "open" || args[0] === "error") {
        stream.emit = origEmit;
        stream._openPending = false;
        if (args[0] === "open") stream._opened = true;
      }
      return Reflect.apply(origEmit, stream, args);
    };
    try {
      stream.open();
    } catch (e) {
      stream.emit("error", e);
    }
  }
  // A FileHandle passed as options.fd (Node allows `fd` to be a FileHandle;
  // test-fs-read-stream-file-handle.js passes the handle object itself).
  // Duck-typed on the handle's method surface.
  function asFileHandle(fdOpt) {
    if (
      fdOpt !== null &&
      typeof fdOpt === "object" &&
      typeof fdOpt.read === "function" &&
      typeof fdOpt.write === "function" &&
      typeof fdOpt.close === "function"
    ) {
      return fdOpt;
    }
    return null;
  }
  // Node's FileHandleOperations (lib/internal/fs/streams.js): route the
  // stream's I/O through the handle's promise API, adapted to callbacks.
  // Destroying a handle-backed stream closes the handle.
  function handleStreamImpl(handle) {
    return {
      open: (p, flags, mode, cb) => nextTick(cb, null, handle.fd),
      read: (fd, buf, offset, length, pos, cb) => {
        handle.read(buf, offset, length, pos).then(
          (r) => cb(null, r.bytesRead, r.buffer),
          (err) => cb(err, 0, buf),
        );
      },
      write: (fd, buf, offset, length, pos, cb) => {
        handle.write(buf, offset, length, pos).then(
          (r) => cb(null, r.bytesWritten, r.buffer),
          (err) => cb(err, 0, buf),
        );
      },
      writev:
        typeof handle.writev === "function"
          ? (fd, buffers, pos, cb) => {
              handle.writev(buffers, pos).then(
                (r) => cb(null, r.bytesWritten, r.buffers),
                (err) => cb(err, 0, buffers),
              );
            }
          : null,
      close: (fd, cb) => {
        handle.close().then(
          () => cb(null),
          (err) => cb(err),
        );
      },
    };
  }
  // AbortSignal for fs streams: invalid type throws; an already-aborted
  // signal destroys the stream with an AbortError; a later abort does the
  // same (stream emits 'error' then 'close', no data flows).
  function armStreamSignal(stream, signal) {
    if (!signal) return;
    if (signal.aborted) {
      nextTick(() => stream.destroy(makeAbortError(signal)));
      return;
    }
    const onAbort = () => stream.destroy(makeAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    stream.once("close", () => {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {}
    });
  }
  class FsReadStream extends Readable {
    constructor(path, options) {
      validateStreamOptions(options);
      const opts = options || {};
      super(streamOpts(opts));
      // options.signal validated for every stream (invalid type throws).
      const signal = validateAbortSignal(opts.signal);
      const handle = asFileHandle(opts.fd);
      this.fd = opts.fd === undefined || opts.fd === null ? null : opts.fd;
      // Node leaves .path unset (undefined) when fd is specified.
      if (this.fd === null) this.path = toPathString(path);
      this.flags = opts.flags || "r";
      this.mode = opts.mode || 0o666;
      this.start = opts.start;
      // Full Node validation: integer/range checks plus start <= end.
      this.end = validateStreamStartEnd(opts);
      this.autoClose = opts.autoClose !== false;
      this._pos = this.start || 0;
      this._opened = false;
      this.bytesRead = 0;
      // Node's streams call the PUBLIC fs.open/read/write/close (lib/fs.js),
      // so user monkey-patches are observed
      // (test-fs-read-stream-fd-leak.js). options.fs overrides individual
      // operations (test-fs-read-stream.js, test-fs-write-stream-fs.js).
      // Looked up lazily so patches apply at call time.
      const customFs = opts.fs || {};
      if (handle) {
        // Node: FileHandle is not supported with custom fs operations.
        for (const k of ["open", "read", "write", "writev", "close"]) {
          if (typeof customFs[k] === "function") {
            const err = new Error("The FileHandle with fs method is not implemented");
            err.code = "ERR_METHOD_NOT_IMPLEMENTED";
            throw err;
          }
        }
        this.fd = typeof handle.fd === "number" ? handle.fd : null;
        this._fileHandle = handle;
        this._impl = handleStreamImpl(handle);
        // Node: the stream closes itself when the handle emits 'close'.
        if (typeof handle.on === "function")
          handle.on("close", () => this.close());
      } else {
        const defaultOr = (name) => (...a) =>
          typeof customFs[name] === "function"
            ? customFs[name](...a)
            : fs[name](...a);
        this._impl = {
          open: defaultOr("open"),
          read: defaultOr("read"),
          write: defaultOr("write"),
          writev:
            typeof customFs.writev === "function"
              ? (...a) => customFs.writev(...a)
              : null,
          close: defaultOr("close"),
        };
      }
      armStreamSignal(this, signal);
      emitFs("fs", "createReadStream", this.path, this);
      if (this.fd === null) {
        if (this.open !== readStreamOpenNoop) {
          // open() was monkey-patched: Node's _construct hack.
          this._openPending = true;
          nextTick(() => openWithPatchedOpen(this));
        } else {
          // Deferred so handlers attached after construction still fire.
          this._openPending = true;
          nextTick(() => this._openWithImpl());
        }
      } else {
        nextTick(() => this.emit("open", this.fd));
      }
    }
    _openWithImpl() {
      this._impl.open(this.path, this.flags, this.mode, (err, fd) => {
        this._openPending = false;
        if (err || fd === undefined || fd === null) {
          errorOrDestroy(
            this,
            enrichErr(err || new Error("open failed"), "createReadStream"),
          );
          return;
        }
        if (this.destroyed) {
          // Destroyed while the open was in flight: release the fd
          // immediately instead of leaking it.
          this._impl.close(fd, () => {});
          return;
        }
        this.fd = fd;
        this._opened = true;
        this.emit("open", fd);
      });
    }
    _read(size) {
      const doRead = () => {
        if (this._openPending) {
          // Async open hasn't completed; retry once it fires.
          this.once("open", doRead);
          return;
        }
        let toRead = size || 16384;
        if (this.end !== undefined)
          toRead = Math.min(toRead, this.end - this._pos + 1);
        if (toRead <= 0) {
          this.push(null);
          this._cleanup();
          return;
        }
        const buf =
          typeof Buffer !== "undefined"
            ? Buffer.alloc(toRead)
            : new Uint8Array(toRead);
        // Always through the public fs.read (see _impl above).
        this._impl.read(this.fd, buf, 0, toRead, this._pos, (err, n) => {
          if (err) {
            errorOrDestroy(this, enrichErr(err, "read"));
            return;
          }
          this._finishRead(n, buf);
        });
      };
      nextTick(doRead);
    }
    _finishRead(n, buf) {
      if (n === 0) {
        this.push(null);
        this._cleanup();
        return;
      }
      this._pos += n;
      this.bytesRead += n;
      this.push(buf.slice(0, n));
    }
    _cleanup() {
      closeStreamFd(this);
    }
    _destroy(err, callback) {
      this._cleanup();
      callback(err);
    }
    // Node's ReadStream.prototype.close(cb): destroys the stream; the fd
    // is released via _destroy -> _cleanup (test-fs-read-stream-fd-leak.js
    // asserts no leaked fds across close()/destroy()).
    close(cb) {
      if (typeof cb === "function") this.once("close", cb);
      this.destroy();
    }
  }
  class FsWriteStream extends Writable {
    constructor(path, options) {
      validateStreamOptions(options);
      const opts = options || {};
      super(streamOpts(opts));
      // options.signal validated for every stream (invalid type throws).
      const signal = validateAbortSignal(opts.signal);
      const handle = asFileHandle(opts.fd);
      this.fd = opts.fd === undefined || opts.fd === null ? null : opts.fd;
      // Node leaves .path unset (undefined) when fd is specified.
      if (this.fd === null) this.path = toPathString(path);
      this.flags = opts.flags || "w";
      this.mode = opts.mode || 0o666;
      this.start = opts.start;
      // Node validates start for write streams too (integer, >= 0).
      if (this.start !== undefined)
        validateIntegerInRange(this.start, "start", 0);
      this.autoClose = opts.autoClose !== false;
      this._pos = this.start;
      this._opened = false;
      // Node's streams call the PUBLIC fs.open/read/write/close (lib/fs.js),
      // so user monkey-patches are observed. options.fs overrides
      // individual operations. Looked up lazily so patches apply at call
      // time.
      const customFs = opts.fs || {};
      if (handle) {
        // Node: FileHandle is not supported with custom fs operations.
        for (const k of ["open", "read", "write", "writev", "close"]) {
          if (typeof customFs[k] === "function") {
            const err = new Error("The FileHandle with fs method is not implemented");
            err.code = "ERR_METHOD_NOT_IMPLEMENTED";
            throw err;
          }
        }
        this.fd = typeof handle.fd === "number" ? handle.fd : null;
        this._fileHandle = handle;
        this._impl = handleStreamImpl(handle);
        // Node: the stream closes itself when the handle emits 'close'.
        if (typeof handle.on === "function")
          handle.on("close", () => this.close());
      } else {
        const defaultOr = (name) => (...a) =>
          typeof customFs[name] === "function"
            ? customFs[name](...a)
            : fs[name](...a);
        this._impl = {
          open: defaultOr("open"),
          read: defaultOr("read"),
          write: defaultOr("write"),
          writev:
            typeof customFs.writev === "function"
              ? (...a) => customFs.writev(...a)
              : null,
          close: defaultOr("close"),
        };
      }
      // writev batching only when the impl provides it (installing _writev
      // unconditionally would change batching for the default path).
      if (this._impl.writev) {
        this._writev = (chunks, callback) => this._writevImpl(chunks, callback);
      }
      armStreamSignal(this, signal);
      emitFs("fs", "createWriteStream", this.path, this);
      if (this.fd === null) {
        if (this.open !== writeStreamOpenNoop) {
          // open() was monkey-patched: Node's _construct hack.
          this._openPending = true;
          nextTick(() => openWithPatchedOpen(this));
        } else {
          // Deferred so handlers attached after construction still fire.
          this._openPending = true;
          nextTick(() => this._openWithImpl());
        }
      } else {
        nextTick(() => this.emit("open", this.fd));
      }
    }
    _openWithImpl() {
      this._impl.open(this.path, this.flags, this.mode, (err, fd) => {
        this._openPending = false;
        if (err || fd === undefined || fd === null) {
          errorOrDestroy(
            this,
            enrichErr(err || new Error("open failed"), "createWriteStream"),
          );
          return;
        }
        if (this.destroyed) {
          // Destroyed while the open was in flight: release the fd
          // immediately instead of leaking it.
          this._impl.close(fd, () => {});
          return;
        }
        this.fd = fd;
        this._opened = true;
        this.emit("open", fd);
      });
    }
    _write(chunk, encoding, callback) {
      if (this._openPending) {
        // Async open hasn't completed; retry once it fires.
        this.once("open", () => this._write(chunk, encoding, callback));
        return;
      }
      let data = chunk;
      if (typeof data === "string") {
        data =
          typeof Buffer !== "undefined"
            ? Buffer.from(data, encoding)
            : new TextEncoder().encode(data);
      }
      data = normalizeDataArg(data);
      // Always through the public fs.write (see _impl above).
      const pos =
        this._pos === undefined || this._pos === null ? null : this._pos;
      this._impl.write(this.fd, data, 0, data.byteLength, pos, (err, n) => {
        if (err) {
          callback(enrichErr(err, "write"));
          return;
        }
        const written = typeof n === "number" ? n : data.byteLength;
        if (pos !== null && pos !== undefined) this._pos = pos + written;
        emitFs("fs", "writeStream.write", this.path, written);
        callback(null);
      });
    }
    _writevImpl(chunks, callback) {
      // Custom writev: buffers in one call (test-fs-write-stream-fs.js).
      const buffers = chunks.map((c) => {
        let data = c.chunk;
        if (typeof data === "string") {
          data =
            typeof Buffer !== "undefined"
              ? Buffer.from(data, c.encoding)
              : new TextEncoder().encode(data);
        }
        return normalizeDataArg(data);
      });
      const pos =
        this._pos === undefined || this._pos === null ? null : this._pos;
      this._impl.writev(this.fd, buffers, pos, (err, n) => {
        if (err) {
          callback(enrichErr(err, "write"));
          return;
        }
        const written =
          typeof n === "number"
            ? n
            : buffers.reduce((a, b) => a + b.byteLength, 0);
        if (pos !== null && pos !== undefined) this._pos = pos + written;
        emitFs("fs", "writeStream.write", this.path, written);
        callback(null);
      });
    }
    _final(callback) {
      this._cleanup();
      callback(null);
    }
    _cleanup() {
      closeStreamFd(this);
    }
    _destroy(err, callback) {
      this._cleanup();
      callback(err);
    }
    // Node's WriteStream.prototype.close(cb): same contract as ReadStream.
    close(cb) {
      if (typeof cb === "function") this.once("close", cb);
      this.destroy();
    }
  }
  fs.createReadStream = function (p, options) {
    validateEncodingOpt(options);
    return new FsReadStream(p, options);
  };
  fs.createWriteStream = function (p, options) {
    validateEncodingOpt(options);
    return new FsWriteStream(p, options);
  };
  const readStreamOpenNoop = deprecateStreamOpen(
    FsReadStream.prototype,
    "ReadStream",
  );
  const writeStreamOpenNoop = deprecateStreamOpen(
    FsWriteStream.prototype,
    "WriteStream",
  );
  // Node's fs.ReadStream/fs.WriteStream are old-style functions with an
  // `instanceof` guard, so calling them WITHOUT `new` returns an instance
  // (test-fs-write-stream.js does `fs.WriteStream(file)`). Plain ES classes
  // throw "Class constructor ... cannot be invoked without 'new'". Export
  // new-safe factory functions that share the class prototype, so both
  // `new fs.WriteStream()` and `fs.WriteStream()` work and instanceof
  // checks hold in both directions.
  function ReadStreamFactory(path, options) {
    validateEncodingOpt(options);
    return new FsReadStream(path, options);
  }
  function WriteStreamFactory(path, options) {
    validateEncodingOpt(options);
    return new FsWriteStream(path, options);
  }
  ReadStreamFactory.prototype = FsReadStream.prototype;
  WriteStreamFactory.prototype = FsWriteStream.prototype;
  fs.ReadStream = ReadStreamFactory;
  fs.WriteStream = WriteStreamFactory;
  fs.FileReadStream = ReadStreamFactory;
  fs.FileWriteStream = WriteStreamFactory;

  // ── FileHandle (internal; never exposed publicly) ──
  const MemFileHandle = fs.promises.FileHandle;
  class FileHandle extends MemFileHandle {
    constructor(fd) {
      super(fd);
      // EventEmitter state init (the class itself can't be .call()ed).
      _FsEventEmitter.init.call(this);
      this.fd = fd;
    }
    async stat(options) {
      try {
        const m = vol.fstatSync(this.fd);
        const st = toStats(m, options);
        emitFs("fs", "promises.stat", this.fd, st);
        return st;
      } catch (e) {
        // Node reports the fstat syscall for FileHandle.stat.
        throw enrichErr(e, "fstat");
      }
    }
    async read(arg1, arg2, arg3, arg4) {
      // read([buffer[, offset[, length[, position]]]]) / read(options)
      let buffer,
        offset = 0,
        length,
        position = null;
      if (
        arg1 &&
        typeof arg1 === "object" &&
        !(arg1 instanceof Uint8Array) &&
        !ArrayBuffer.isView(arg1)
      ) {
        buffer = arg1.buffer;
        offset = arg1.offset || 0;
        length = arg1.length;
        position = arg1.position !== undefined ? arg1.position : null;
      } else {
        buffer = arg1;
        offset = arg2 || 0;
        length = arg3;
        position = arg4 !== undefined ? arg4 : null;
      }
      if (!(buffer instanceof Uint8Array) && !ArrayBuffer.isView(buffer)) {
        const len = typeof length === "number" ? length : 16384;
        buffer =
          typeof Buffer !== "undefined"
            ? Buffer.alloc(len)
            : new Uint8Array(len);
      }
      if (length === undefined || length === null)
        length = buffer.byteLength - offset;
      checkFdReadable(this.fd, "read");
      const savedPos =
        typeof position === "number" ? getPosition(this.fd) : undefined;
      let bytesRead;
      try {
        bytesRead = vol.readSync(this.fd, buffer, offset, length, position);
      } catch (e) {
        throw enrichErr(e, "read");
      } finally {
        if (savedPos !== undefined) setPosition(this.fd, savedPos);
      }
      emitFs("fs", "promises.read", this.fd, bytesRead);
      return { bytesRead, buffer };
    }
    async write(arg1, arg2, arg3, arg4) {
      // write(string[, position[, encoding]]) / write(buffer[, offset[, length[, position]]])
      let data = arg1,
        position;
      let offset = 0,
        length,
        encoding = "utf8";
      if (typeof data === "string") {
        position = arg2 !== undefined ? arg2 : null;
        encoding = arg3 || "utf8";
        data =
          typeof Buffer !== "undefined"
            ? Buffer.from(data, encoding)
            : new TextEncoder().encode(data);
      } else {
        data = normalizeDataArg(data);
        offset = arg2 || 0;
        length = arg3;
        position = arg4 !== undefined ? arg4 : null;
      }
      if (length === undefined || length === null)
        length = data.byteLength - offset;
      checkFdWritable(this.fd, "write");
      const savedPos =
        typeof position === "number" ? getPosition(this.fd) : undefined;
      let bytesWritten;
      try {
        bytesWritten = vol.writeSync(this.fd, data, offset, length, position);
      } catch (e) {
        throw enrichErr(e, "write");
      } finally {
        if (savedPos !== undefined) setPosition(this.fd, savedPos);
      }
      emitFs("fs", "promises.write", this.fd, bytesWritten);
      return { bytesWritten, buffer: data };
    }
    async readv(buffers, position) {
      try {
        const bytesRead = readvSyncImpl(
          this.fd,
          buffers,
          position === undefined ? null : position,
        );
        const result = { bytesRead, buffers };
        emitFs("fs", "promises.readv", this.fd, result);
        return result;
      } catch (e) {
        throw enrichErr(e, "readv");
      }
    }
    async writev(buffers, position) {
      try {
        const bytesWritten = writevSyncImpl(
          this.fd,
          buffers,
          position === undefined ? null : position,
        );
        const result = { bytesWritten, buffers };
        emitFs("fs", "promises.writev", this.fd, result);
        return result;
      } catch (e) {
        throw enrichErr(e, "writev");
      }
    }
    async readFile(options) {
      const signal =
        options !== null && typeof options === "object"
          ? validateAbortSignal(options.signal)
          : undefined;
      await throwIfAborted(signal);
      try {
        // Node refuses reads past 2 GiB - 1 (kIoMaxLength).
        const st = vol.fstatSync(this.fd);
        if (st.size > 2 ** 31 - 1) {
          const err = new RangeError(
            `File size (${st.size}) is greater than 2 GiB`,
          );
          err.code = "ERR_FS_FILE_TOO_LARGE";
          throw err;
        }
        const data = vol.readFileSync(this.fd, options);
        emitFs("fs", "promises.readFile", this.fd, data);
        return data;
      } catch (e) {
        throw enrichErr(e, "readFile");
      }
    }
    async writeFile(data, options) {
      const signal = promiseSignal(options);
      await throwIfAborted(signal);
      const encoding = typeof options === "string" ? options : options?.encoding;
      // Node writes at the fd's current position without truncating
      // (memfs's writeFileSync-on-fd truncates at 0).
      const buf = await coerceWriteData(data, encoding, signal);
      try {
        checkFdWritable(this.fd, "write");
        vol.writeSync(this.fd, buf, 0, buf.byteLength, null);
        emitFs("fs", "promises.writeFile", this.fd, undefined);
      } catch (e) {
        throw enrichErr(e, "writeFile");
      }
    }
    async appendFile(data, options) {
      const signal = promiseSignal(options);
      await throwIfAborted(signal);
      const encoding = typeof options === "string" ? options : options?.encoding;
      const buf = await coerceWriteData(data, encoding, signal);
      const chunks = buf instanceof Uint8Array ? buf : normalizeDataArg(buf);
      try {
        const st = vol.fstatSync(this.fd);
        vol.writeSync(this.fd, chunks, 0, chunks.byteLength, st.size);
        emitFs("fs", "promises.appendFile", this.fd, undefined);
      } catch (e) {
        throw enrichErr(e, "appendFile");
      }
    }
    async truncate(len) {
      try {
        vol.ftruncateSync(this.fd, normalizeTruncateLen(len));
        emitFs("fs", "promises.truncate", this.fd, undefined);
      } catch (e) {
        throw enrichErr(e, "truncate");
      }
    }
    async chmod(mode) {
      try {
        vol.fchmodSync(this.fd, mode);
        emitFs("fs", "promises.chmod", this.fd, undefined);
      } catch (e) {
        throw enrichErr(e, "chmod");
      }
    }
    async chown(uid, gid) {
      try {
        vol.fchownSync(this.fd, uid, gid);
        emitFs("fs", "promises.chown", this.fd, undefined);
      } catch (e) {
        throw enrichErr(e, "chown");
      }
    }
    async utimes(atime, mtime) {
      try {
        vol.futimesSync(
          this.fd,
          toDate(atime, "atime"),
          toDate(mtime, "mtime"),
        );
        emitFs("fs", "promises.utimes", this.fd, undefined);
      } catch (e) {
        throw enrichErr(e, "utimes");
      }
    }
    async datasync() {
      try {
        vol.fdatasyncSync(this.fd);
      } catch (e) {
        throw enrichErr(e, "datasync");
      }
    }
    async sync() {
      try {
        vol.fsyncSync(this.fd);
      } catch (e) {
        throw enrichErr(e, "sync");
      }
    }
    async close() {
      // Node: fd becomes -1, 'close' is emitted once, and a second close()
      // is a silent no-op (probed against real Node v24.20.0).
      if (this._closed) return;
      this._closed = true;
      const fd = this.fd;
      try {
        vol.closeSync(fd);
        emitFs("fs", "promises.close", fd, undefined);
      } catch (e) {
        throw enrichErr(e, "close");
      }
      this.fd = -1;
      this.emit("close");
    }
    // Explicit resource management: `using h = await open(...)`.
    [Symbol.dispose]() {
      return this.close();
    }
    [Symbol.asyncDispose]() {
      return this.close();
    }
    async readableWebStream(options) {
      const stream = this.createReadStream(options);
      if (typeof Readable.toWeb === "function") return Readable.toWeb(stream);
      // Minimal WHATWG fallback.
      const reader = stream[Symbol.asyncIterator]();
      return new ReadableStream({
        async pull(controller) {
          const { value, done } = await reader.next();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel() {
          stream.destroy();
        },
      });
    }
    createReadStream(options) {
      // Node passes the handle itself (not the raw fd): the stream routes
      // I/O through the handle's methods and closes it on destroy.
      return new FsReadStream(null, {
        ...options,
        fd: this,
        autoClose: false,
      });
    }
    createWriteStream(options) {
      return new FsWriteStream(null, {
        ...options,
        fd: this,
        autoClose: false,
      });
    }
    async *[Symbol.asyncIterator]() {
      const stream = this.createReadStream();
      try {
        for await (const chunk of stream) yield chunk;
      } finally {
        stream.destroy();
      }
    }
    readLines(options) {
      const stream = this.createReadStream(options);
      // Line-splitting async iterator.
      const self = this;
      return (async function* () {
        let leftover = "";
        for await (const chunk of stream) {
          const text = leftover + chunk.toString();
          const lines = text.split("\n");
          leftover = lines.pop();
          for (const line of lines) yield line;
        }
        if (leftover) yield leftover;
      })();
    }
  }

  // Node's FileHandle is an EventEmitter (emits 'close'). Mixin the
  // instance methods; the constructor already ran _FsEventEmitter.call.
  for (const k of Object.getOwnPropertyNames(_FsEventEmitter.prototype)) {
    if (k !== "constructor" && !(k in FileHandle.prototype)) {
      try {
        FileHandle.prototype[k] = _FsEventEmitter.prototype[k];
      } catch {}
    }
  }

  // ── promises assembly ──
  const promises = {};
  const definePromise = (name, fn) => {
    promises[name] = function (...args) {
      let result;
      try {
        result = fn.apply(this, args);
      } catch (e) {
        return Promise.reject(enrichErr(e, name));
      }
      return Promise.resolve(result).then(
        (val) => {
          emitFs("fs", `promises.${name}`, ...args, val);
          return val;
        },
        (err) => {
          emitFs("fs", `promises.${name}`, ...args, undefined);
          throw enrichErr(err, name);
        },
      );
    };
  };

  definePromise(
    "access",
    (p, mode) =>
      new Promise((resolve, reject) => {
        fs.access(p, mode, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "open",
    (p, flags, mode) =>
      new Promise((resolve, reject) => {
        fs.open(p, flags, mode, (err, fd) => {
          if (err) return reject(err);
          resolve(new FileHandle(fd));
        });
      }),
  );
  definePromise("readFile", (p, options) => {
    if (p instanceof FileHandle) return p.readFile(options);
    return new Promise((resolve, reject) => {
      fs.readFile(p, options, (err, data) =>
        err ? reject(err) : resolve(data),
      );
    });
  });
  definePromise("writeFile", async (p, data, options) => {
    const signal = promiseSignal(options);
    await throwIfAborted(signal);
    const encoding = typeof options === "string" ? options : options?.encoding;
    const buf = await coerceWriteData(data, encoding, signal);
    if (p instanceof FileHandle) return p.writeFile(buf, options);
    return new Promise((resolve, reject) => {
      fs.writeFile(p, buf, options, (err) => (err ? reject(err) : resolve()));
    });
  });
  definePromise("appendFile", async (p, data, options) => {
    const signal = promiseSignal(options);
    await throwIfAborted(signal);
    const encoding = typeof options === "string" ? options : options?.encoding;
    const buf = await coerceWriteData(data, encoding, signal);
    if (p instanceof FileHandle) return p.appendFile(buf, options);
    return new Promise((resolve, reject) => {
      fs.appendFile(p, buf, options, (err) => (err ? reject(err) : resolve()));
    });
  });
  definePromise(
    "truncate",
    (p, len) =>
      new Promise((resolve, reject) => {
        fs.truncate(p, len, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "copyFile",
    (src, dest, mode) =>
      new Promise((resolve, reject) => {
        fs.copyFile(src, dest, mode, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "rename",
    (a, b) =>
      new Promise((resolve, reject) => {
        fs.rename(a, b, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "unlink",
    (p) =>
      new Promise((resolve, reject) => {
        fs.unlink(p, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "mkdir",
    (p, options) =>
      new Promise((resolve, reject) => {
        fs.mkdir(p, options, (err, made) =>
          err ? reject(err) : resolve(made),
        );
      }),
  );
  definePromise(
    "mkdtemp",
    (prefix, options) =>
      new Promise((resolve, reject) => {
        fs.mkdtemp(prefix, options, (err, dir) =>
          err ? reject(err) : resolve(dir),
        );
      }),
  );
  definePromise("mkdtempDisposable", (prefix, options) =>
    fs.mkdtempDisposable(prefix, options),
  );
  definePromise(
    "opendir",
    (p, options) =>
      new Promise((resolve, reject) => {
        fs.opendir(p, options, (err, dir) => {
          if (err) return reject(err);
          // Promise-flavoured Dir: read()/close() return promises.
          dir.read = () =>
            new Promise((res, rej) => {
              nextTick(() => {
                try {
                  res(dir.readSync());
                } catch (e) {
                  rej(enrichErr(e, "opendir"));
                }
              });
            });
          const origClose = dir.close.bind(dir);
          dir.close = (cb) => {
            if (typeof cb === "function") return origClose(cb);
            return new Promise((res, rej) => {
              nextTick(() => {
                try {
                  dir.closeSync();
                  res();
                } catch (e) {
                  rej(enrichErr(e, "opendir"));
                }
              });
            });
          };
          resolve(dir);
        });
      }),
  );
  definePromise(
    "readdir",
    (p, options) =>
      new Promise((resolve, reject) => {
        fs.readdir(p, options, (err, names) =>
          err ? reject(err) : resolve(names),
        );
      }),
  );
  definePromise(
    "rmdir",
    (p, options) =>
      new Promise((resolve, reject) => {
        fs.rmdir(p, options, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "rm",
    (p, options) =>
      new Promise((resolve, reject) => {
        fs.rm(p, options, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "stat",
    (p, options) =>
      new Promise((resolve, reject) => {
        fs.stat(p, options, (err, st) => (err ? reject(err) : resolve(st)));
      }),
  );
  definePromise(
    "lstat",
    (p, options) =>
      new Promise((resolve, reject) => {
        fs.lstat(p, options, (err, st) => (err ? reject(err) : resolve(st)));
      }),
  );
  definePromise(
    "link",
    (a, b) =>
      new Promise((resolve, reject) => {
        fs.link(a, b, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "symlink",
    (t, p, type) =>
      new Promise((resolve, reject) => {
        fs.symlink(t, p, type, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "readlink",
    (p, options) =>
      new Promise((resolve, reject) => {
        fs.readlink(p, options, (err, s) => (err ? reject(err) : resolve(s)));
      }),
  );
  definePromise(
    "realpath",
    (p, options) =>
      new Promise((resolve, reject) => {
        fs.realpath(p, options, (err, s) => (err ? reject(err) : resolve(s)));
      }),
  );
  definePromise(
    "chmod",
    (p, mode) =>
      new Promise((resolve, reject) => {
        fs.chmod(p, mode, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "chown",
    (p, uid, gid) =>
      new Promise((resolve, reject) => {
        fs.chown(p, uid, gid, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "lchown",
    (p, uid, gid) =>
      new Promise((resolve, reject) => {
        fs.lchown(p, uid, gid, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "utimes",
    (p, atime, mtime) =>
      new Promise((resolve, reject) => {
        fs.utimes(p, atime, mtime, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "lutimes",
    (p, atime, mtime) =>
      new Promise((resolve, reject) => {
        fs.lutimes(p, atime, mtime, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "cp",
    (src, dest, options) =>
      new Promise((resolve, reject) => {
        fs.cp(src, dest, options, (err) => (err ? reject(err) : resolve()));
      }),
  );
  definePromise(
    "statfs",
    (p, options) =>
      new Promise((resolve, reject) => {
        fs.statfs(p, options, (err, s) => (err ? reject(err) : resolve(s)));
      }),
  );
  // glob returns an async iterable directly (Node's promises API).
  promises.glob = function (patterns, options) {
    const result = fs.glob(patterns, options);
    // fs.glob without callback returns an async iterator; expose it directly.
    if (result && typeof result[Symbol.asyncIterator] === "function")
      return result;
    // Sync-shaped fallback: wrap array results.
    return (async function* () {
      const arr = await result;
      if (Array.isArray(arr)) for (const p of arr) yield p;
    })();
  };
  // Node's promises.watch validates these options at iteration start
  // (before the handle starts): persistent/recursive booleans,
  // maxQueue integer, overflow one-of, encoding validity. Returns the
  // error to throw, or null when valid.
  function validateWatchOptions(options) {
    if (options === undefined || options === null) return null;
    if (typeof options !== "object") return null; // fs.watch reports it
    for (const k of ["persistent", "recursive"]) {
      const v = options[k];
      if (v !== undefined && typeof v !== "boolean")
        return errInvalidArgType(`options.${k}`, "boolean", v);
    }
    const maxQueue = options.maxQueue;
    if (maxQueue !== undefined && !Number.isInteger(maxQueue))
      return errInvalidArgType("options.maxQueue", "integer", maxQueue);
    const overflow = options.overflow;
    if (
      overflow !== undefined &&
      overflow !== "ignore" &&
      overflow !== "error"
    ) {
      const err = new TypeError(
        `The "options.overflow" argument must be one of: ignore, error. Received ${String(overflow)}`,
      );
      err.code = "ERR_INVALID_ARG_VALUE";
      return err;
    }
    const encoding = options.encoding;
    if (encoding !== undefined && encoding !== null) {
      const ok =
        typeof encoding === "string" &&
        (typeof Buffer !== "undefined" && Buffer.isEncoding
          ? Buffer.isEncoding(encoding)
          : /^(utf-?8|ascii|latin1|binary|base64|base64url|hex|ucs-?2|utf-?16le)$/i.test(
              encoding,
            ));
      if (!ok) {
        const err = new TypeError(
          `The "options.encoding" argument is invalid encoding: ${String(encoding)}`,
        );
        err.code = "ERR_INVALID_ARG_VALUE";
        return err;
      }
    }
    return null;
  }
  // watch returns an async-iterable watcher in real Node's promises API.
  promises.watch = function (p, options) {
    // Validate `ignore` like real Node (throws on iteration start).
    const ignore = options && options.ignore;
    if (ignore !== undefined) {
      const isValid = typeof ignore === "string" || ignore instanceof RegExp;
      if (!isValid) {
        const err = errInvalidArgType(
          "options.ignore",
          ["string", "RegExp"],
          ignore,
        );
        return (async function* () {
          throw err;
        })();
      }
      if (ignore === "") {
        const err = new TypeError(
          'The "options.ignore" argument must not be empty',
        );
        err.code = "ERR_INVALID_ARG_VALUE";
        return (async function* () {
          throw err;
        })();
      }
    }
    // Node validates persistent/recursive/maxQueue/overflow/encoding at
    // iteration start (before the handle starts). A throwing generator
    // keeps the "rejects on first next()" semantics.
    const watchOptErr = validateWatchOptions(options);
    if (watchOptErr) {
      const err = watchOptErr;
      return (async function* () {
        throw err;
      })();
    }
    const w = fs.watch(p, options);
    // Attach async iteration yielding { eventType, filename }.
    // Memoized per watcher: like Node's native async generator, a second
    // for-await over the same watcher resumes the exhausted generator
    // (a no-op) instead of starting a fresh wait on a closed watcher.
    if (!w[Symbol.asyncIterator]) {
      // Signal validated up front: invalid type rejects at iteration start
      // (like the ignore validation above), an aborted signal rejects the
      // iteration with an AbortError, and a mid-iteration abort closes the
      // watcher and rejects the pending next().
      let signal;
      try {
        signal =
          options !== null && typeof options === "object"
            ? validateAbortSignal(options.signal)
            : undefined;
      } catch (e) {
        const err = e;
        w[Symbol.asyncIterator] = () =>
          (async function* () {
            throw err;
          })();
        return w;
      }
      let gen = null;
      const makeIterator = () =>
        (async function* () {
          const queue = [];
          let resolve;
          let reject;
          const onEvent = (eventType, filename) => {
            if (resolve) {
              const r = resolve;
              resolve = null;
              reject = null;
              r({ eventType, filename });
            } else queue.push({ eventType, filename });
          };
          const onClose = () => {
            // An aborted signal turns watcher close into an AbortError
            // (carrying signal.reason as cause); a plain close ends the
            // iteration.
            const done =
              signal && signal.aborted
                ? { error: makeAbortError(signal) }
                : { done: true };
            if (resolve) {
              const r = resolve;
              const j = reject;
              resolve = null;
              reject = null;
              if (done.error) j(done.error);
              else r({ value: undefined, done: true });
            } else if (done.error) {
              queue.push(done);
            } else {
              queue.push({ done: true });
            }
          };
          w.on("change", onEvent);
          w.on("close", onClose);
          try {
            for (;;) {
              if (queue.length) {
                const item = queue.shift();
                if (item.done) return;
                if (item.error) throw item.error;
                yield item;
              } else {
                const item = await new Promise((res, rej) => {
                  resolve = res;
                  reject = rej;
                });
                if (item && item.done) return;
                yield item;
              }
            }
          } finally {
            w.off("change", onEvent);
            w.off("close", onClose);
            // Node's promises.watch generator closes the watcher when the
            // iteration ends (break/throw/return) — otherwise the process
            // hangs on the open watcher.
            try {
              w.close();
            } catch {}
          }
        })();
      w[Symbol.asyncIterator] = () => {
        if (!gen) gen = makeIterator();
        return gen;
      };
    }
    return w;
  };
  // lchmod on Linux: present and rejects with ERR_METHOD_NOT_IMPLEMENTED.
  promises.lchmod = function (p, mode) {
    const err = new Error("Method not implemented");
    err.code = "ERR_METHOD_NOT_IMPLEMENTED";
    return Promise.reject(err);
  };
  promises.constants = null; // set below after constants are attached
  // FileHandle stays internal: never published on fs or fs.promises.

  fs.promises = promises;
  fs.Utf8Stream = Utf8Stream;
  return fs;
}

// ── 8. Singleton assembly ───────────────────────────────────────────────────
import nodeConstants from "./constants.js";

function buildSingleton() {
  const rt = getRuntime();
  if (rt && rt.__FS__) return rt.__FS__;
  const vol = createVolume();
  const fs = buildApi(vol);
  fs._vol = vol;
  fs.constants = nodeConstants;
  fs.promises.constants = nodeConstants;
  if (rt) rt.__FS__ = fs;
  return fs;
}

const fs = buildSingleton();

// ── 9. Exports ──────────────────────────────────────────────────────────────
// Default export is the singleton (reused via __FS__ when a runtime exists).
export default fs;

// Named exports mirroring node:fs.
export const {
  access,
  accessSync,
  appendFile,
  appendFileSync,
  chmod,
  chmodSync,
  chown,
  chownSync,
  close,
  closeSync,
  copyFile,
  copyFileSync,
  cp,
  cpSync,
  createReadStream,
  createWriteStream,
  exists,
  existsSync,
  fchmod,
  fchmodSync,
  fchown,
  fchownSync,
  fdatasync,
  fdatasyncSync,
  fstat,
  fstatSync,
  fsync,
  fsyncSync,
  ftruncate,
  ftruncateSync,
  futimes,
  futimesSync,
  glob,
  globSync,
  lchmod,
  lchmodSync,
  lchown,
  lchownSync,
  link,
  linkSync,
  lstat,
  lstatSync,
  lutimes,
  lutimesSync,
  mkdir,
  mkdirSync,
  mkdtemp,
  mkdtempSync,
  mkdtempDisposableSync,
  open,
  openSync,
  openAsBlob,
  opendir,
  opendirSync,
  read,
  readSync,
  readdir,
  readdirSync,
  readFile,
  readFileSync,
  readlink,
  readlinkSync,
  readv,
  readvSync,
  realpath,
  realpathSync,
  rename,
  renameSync,
  rm,
  rmSync,
  rmdir,
  rmdirSync,
  stat,
  statSync,
  statfs,
  statfsSync,
  symlink,
  symlinkSync,
  truncate,
  truncateSync,
  unlink,
  unlinkSync,
  utimes,
  utimesSync,
  watch,
  watchFile,
  unwatchFile,
  write,
  writeSync,
  writeFile,
  writeFileSync,
  writev,
  writevSync,
  Dir,
  ReadStream,
  WriteStream,
  FileReadStream,
  FileWriteStream,
  promises,
  constants,
} = fs;

// Class/function exports mirroring node:fs (not on the fs singleton object).
export { Dirent, Utf8Stream, _toUnixTimestamp };
const _InternalStats = Stats;
export { _InternalStats };
// Public fs.Stats: 14-arg positional function emitting DEP0180
// (test-fs-stat). Callable without `new` like real Node. Internal code
// uses the (m, bigint) signature via _InternalStats.
function PublicStats(
  dev,
  mode,
  nlink,
  uid,
  gid,
  rdev,
  blksize,
  ino,
  size,
  blocks,
  atimeMs,
  mtimeMs,
  ctimeMs,
  birthtimeMs,
) {
  if (typeof process !== "undefined" && process.emitWarning) {
    // Emit async to match Node's emitWarning timing (test-fs-stat calls
    // expectWarning after constructing).
    const emit = () =>
      process.emitWarning(
        "fs.Stats constructor is deprecated.",
        "DeprecationWarning",
        "DEP0180",
      );
    if (typeof setImmediate !== "undefined") setImmediate(emit);
    else emit();
  }
  return new _InternalStats(
    {
      dev,
      mode,
      nlink,
      uid,
      gid,
      rdev,
      blksize,
      ino,
      size,
      blocks,
      atimeMs,
      mtimeMs,
      ctimeMs,
      birthtimeMs,
    },
    false,
  );
}
export { PublicStats as Stats };
