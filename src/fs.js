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

import { Volume, createFsFromVolume } from 'memfs';
import { Readable, Writable } from './stream.js';

// Browser-safe nextTick (process.nextTick under Node, queueMicrotask otherwise).
function nextTick(fn, ...args) {
  try {
    if (typeof process !== 'undefined' && typeof process.nextTick === 'function') {
      process.nextTick(fn, ...args);
      return;
    }
  } catch { /* ignore */ }
  if (typeof queueMicrotask === 'function') queueMicrotask(() => fn(...args));
  else setTimeout(() => fn(...args), 0);
}

// ── 1. Runtime bridge (guarded) ─────────────────────────────────────────────
// Always spell the host reference exactly `globalThis._RUNTIME_`.
function getRuntime() {
  return (typeof globalThis._RUNTIME_ !== "undefined") ? globalThis._RUNTIME_ : undefined;
}
function emitFs(...args) {
  if (typeof globalThis.emitMe === 'function') {
    try { globalThis.emitMe(...args); } catch { /* observability only */ }
  }
}

// ── 2. Error infrastructure ─────────────────────────────────────────────────
// Numeric errno values (negative, as in process.binding('uv')).
const ERRNO_BY_CODE = {
  EPERM: -1, ENOENT: -2, ESRCH: -3, EINTR: -4, EIO: -5, ENXIO: -6,
  EBADF: -9, EAGAIN: -11, ENOMEM: -12, EACCES: -13, EFAULT: -14,
  EBUSY: -16, EEXIST: -17, EXDEV: -18, ENODEV: -19, ENOTDIR: -20,
  EISDIR: -21, EINVAL: -22, ENFILE: -23, EMFILE: -24, ETXTBSY: -26,
  EFBIG: -27, ENOSPC: -28, ESPIPE: -29, EROFS: -30, EMLINK: -31,
  EPIPE: -32, EDOM: -33, ERANGE: -34, ENOLCK: -37, ENOSYS: -38,
  ELOOP: -40, ENODATA: -61, ETIME: -62, ENOTEMPTY: -66, EOVERFLOW: -75,
  EOPNOTSUPP: -95,
  // Node JS-level fs errors that still carry errno/syscall:
  ERR_FS_EISDIR: 21, ERR_FS_CP_EINVAL: 22, ERR_FS_CP_NON_DIR_TO_DIR: 22,
  ERR_FS_CP_DIR_TO_NON_DIR: 22,
};

// syscall probe results against real Node v24.20.0.
const SYSCALL_BY_METHOD = {
  readFile: 'open', writeFile: 'open', appendFile: 'open',
  stat: 'stat', lstat: 'lstat', fstat: 'fstat',
  readdir: 'scandir', mkdir: 'mkdir', unlink: 'unlink', rename: 'rename',
  copyFile: 'copyfile', rmdir: 'rmdir', realpath: 'realpath',
  readlink: 'readlink', access: 'access', open: 'open', opendir: 'opendir',
  rm: 'rm', cp: 'lstat', lutimes: 'lutime', mkdtemp: 'mkdtemp',
  statfs: 'statfs', chmod: 'chmod', lchmod: 'chmod', utimes: 'utime',
  futimes: 'futime', truncate: 'open', ftruncate: 'ftruncate',
  close: 'close', read: 'read', write: 'write', fsync: 'fsync',
  fdatasync: 'fdatasync', link: 'link', symlink: 'symlink',
  chown: 'chown', lchown: 'lchown', fchmod: 'fchmod', fchown: 'fchown',
};

function makeFsError(code, syscall, path, message) {
  const err = new Error(`${code}: ${message}, ${syscall}${path !== undefined ? ` '${path}'` : ''}`);
  err.code = code;
  // errno is filled by enrichErr from ERRNO_BY_CODE; JS validation errors
  // (ERR_*) carry no errno in real Node, so no default is set here.
  err.syscall = syscall;
  if (path !== undefined) err.path = path;
  return err;
}

function errInvalidArgType(name, expected, received) {
  const what = received === undefined ? 'undefined'
    : received === null ? 'null'
    : `type ${typeof received}`;
  const err = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${what}`);
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

// JS-level validation errors carry no syscall/errno in real Node.
const NO_ENRICH_CODES = new Set([
  'ERR_INVALID_ARG_TYPE', 'ERR_OUT_OF_RANGE', 'ERR_DIR_CLOSED',
  'ERR_INVALID_ARG_VALUE', 'ERR_INVALID_OPT_VALUE',
]);

function enrichErr(err, methodName) {
  if (err && typeof err === 'object' && err.code) {
    // memfs reports unknown encodings as ERR_INVALID_OPT_VALUE_ENCODING;
    // real Node uses ERR_INVALID_ARG_VALUE here.
    if (err.code === 'ERR_INVALID_OPT_VALUE_ENCODING') {
      try { err.code = 'ERR_INVALID_ARG_VALUE'; } catch { /* ignore */ }
    }
    if (NO_ENRICH_CODES.has(err.code)) return err;
    if (!err.syscall) {
      const base = methodName.endsWith('Sync') ? methodName.slice(0, -4) : methodName;
      try { err.syscall = SYSCALL_BY_METHOD[base] || methodName; } catch { /* ignore */ }
    }
    if (err.errno === undefined && ERRNO_BY_CODE[err.code] !== undefined) {
      try { err.errno = ERRNO_BY_CODE[err.code]; } catch { /* ignore */ }
    }
  }
  return err;
}

// ── 3. Path helpers ─────────────────────────────────────────────────────────
function isUint8ArrayLike(v) {
  return typeof Uint8Array !== 'undefined' && v instanceof Uint8Array;
}
function validatePath(p, name = 'path') {
  if (typeof p !== 'string' && !isUint8ArrayLike(p)) {
    // Match Node's exact message format.
    let received;
    if (p === null) received = 'null';
    else if (p === undefined) received = 'undefined';
    else if (typeof p === 'object') {
      received = `an instance of ${p.constructor ? p.constructor.name : 'Object'}`;
    } else {
      received = `type ${typeof p} (${String(p)})`;
    }
    const err = new TypeError(
      `The "${name}" argument must be of type string or an instance of Buffer or URL. Received ${received}`);
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
}
function toPathString(p) {
  if (typeof p === 'string') return p;
  if (isUint8ArrayLike(p)) {
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(p)) return p.toString('utf8');
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(p);
    let s = '';
    for (let i = 0; i < p.length; i++) s += String.fromCharCode(p[i]);
    return s;
  }
  return String(p);
}
function posixDirname(p) {
  const i = p.lastIndexOf('/');
  if (i <= 0) return '/';
  return p.slice(0, i);
}
function posixResolve(cwd, p) {
  if (p.startsWith('/')) return p;
  return (cwd + '/' + p).replace(/\/+/g, '/');
}

// ── 4. Volume creation + seeding ────────────────────────────────────────────
function getUmask() {
  try {
    if (typeof process !== 'undefined' && typeof process.umask === 'function') {
      return process.umask();
    }
  } catch { /* ignore */ }
  const rt = getRuntime();
  try {
    if (rt && rt.process && typeof rt.process.umask === 'function') return rt.process.umask();
  } catch { /* ignore */ }
  return 0o022;
}

function seedVolume(vol, files) {
  if (!files || typeof files !== 'object') return;
  for (const rawPath of Object.keys(files)) {
    const p = toPathString(rawPath);
    const data = files[rawPath];
    try {
      const dir = posixDirname(p);
      if (dir !== '/') vol.mkdirSync(dir, { recursive: true });
      vol.writeFileSync(p, data);
    } catch { /* best-effort seeding */ }
  }
}

function createVolume() {
  const vol = new Volume();
  // Real Node returns 0 for reads positioned at/beyond EOF; memfs throws
  // ERR_OUT_OF_RANGE. Short-circuit here (no cursor is touched, so this is
  // safe at the volume level for every read path).
  const origReadBase = vol.readBase.bind(vol);
  vol.readBase = function (fd, buffer, offset, length, position) {
    if (typeof position === 'number' && position >= 0) {
      try {
        if (position >= vol.fstatSync(fd).size) return 0;
      } catch { /* fall through; orig throws the real error */ }
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
const STAT_KEYS = ['dev', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'blksize',
  'ino', 'size', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs'];
const BIGINT_NS_KEYS = ['atimeNs', 'mtimeNs', 'ctimeNs', 'birthtimeNs'];

const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000,
  S_IFLNK = 0o120000, S_IFBLK = 0o060000, S_IFCHR = 0o020000,
  S_IFIFO = 0o010000, S_IFSOCK = 0o140000;

class Stats {
  constructor(m, bigint = false) {
    const asNum = (v) => typeof v === 'bigint' ? Number(v) : Number(v);
    const num = (v) => bigint ? BigInt(Math.trunc(asNum(v) || 0)) : (asNum(v) || 0);
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
    const atimeMs = ms(m.atimeMs), mtimeMs = ms(m.mtimeMs),
      ctimeMs = ms(m.ctimeMs), birthtimeMs = ms(m.birthtimeMs);
    this.atimeMs = bigint ? BigInt(Math.trunc(atimeMs)) : atimeMs;
    this.mtimeMs = bigint ? BigInt(Math.trunc(mtimeMs)) : mtimeMs;
    this.ctimeMs = bigint ? BigInt(Math.trunc(ctimeMs)) : ctimeMs;
    this.birthtimeMs = bigint ? BigInt(Math.trunc(birthtimeMs)) : birthtimeMs;
    if (bigint) {
      const ns = (v) => BigInt(Math.trunc(v * 1e6));
      this.atimeNs = ns(atimeMs); this.mtimeNs = ns(mtimeMs);
      this.ctimeNs = ns(ctimeMs); this.birthtimeNs = ns(birthtimeMs);
    }
    // Backing millisecond values for the prototype Date getters.
    Object.defineProperties(this, {
      _atimeMs: { value: atimeMs }, _mtimeMs: { value: mtimeMs },
      _ctimeMs: { value: ctimeMs }, _birthtimeMs: { value: birthtimeMs },
    });
  }
  get atime() { return new Date(this._atimeMs); }
  get mtime() { return new Date(this._mtimeMs); }
  get ctime() { return new Date(this._ctimeMs); }
  get birthtime() { return new Date(this._birthtimeMs); }
  isFile() { return (Number(this.mode) & S_IFMT) === S_IFREG; }
  isDirectory() { return (Number(this.mode) & S_IFMT) === S_IFDIR; }
  isSymbolicLink() { return (Number(this.mode) & S_IFMT) === S_IFLNK; }
  isBlockDevice() { return (Number(this.mode) & S_IFMT) === S_IFBLK; }
  isCharacterDevice() { return (Number(this.mode) & S_IFMT) === S_IFCHR; }
  isFIFO() { return (Number(this.mode) & S_IFMT) === S_IFIFO; }
  isSocket() { return (Number(this.mode) & S_IFMT) === S_IFSOCK; }
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
    Object.defineProperty(this, '_mode', { value: mode, enumerable: false });
  }
  isFile() { return (this._mode & S_IFMT) === S_IFREG; }
  isDirectory() { return (this._mode & S_IFMT) === S_IFDIR; }
  isSymbolicLink() { return (this._mode & S_IFMT) === S_IFLNK; }
  isBlockDevice() { return (this._mode & S_IFMT) === S_IFBLK; }
  isCharacterDevice() { return (this._mode & S_IFMT) === S_IFCHR; }
  isFIFO() { return (this._mode & S_IFMT) === S_IFIFO; }
  isSocket() { return (this._mode & S_IFMT) === S_IFSOCK; }
}

// ── 6b. Node-shaped Utf8Stream ──────────────────────────────────────────────
// Minimal port of Node's internal Utf8Stream (lib/fs.js): a small buffered
// UTF-8 file writer. Real Node uses native handles; here writes go through
// the virtual volume via fs.writeSync when a real fd is available, otherwise
// they are buffered and emitted as 'data' events (honest browser fallback).
import { EventEmitter as _FsEventEmitter } from './events.js';
class Utf8Stream extends _FsEventEmitter {
  constructor(options = {}) {
    super();
    this.path = options.dest ?? null;
    this.fd = options.fd ?? -1;
    this.minLength = options.minLength ?? 0;
    this.maxLength = options.maxLength ?? Infinity;
    this.sync = !!options.sync;
    this._buf = '';
    this._destroyed = false;
  }
  write(data, cb) {
    if (this._destroyed) { if (cb) cb(new Error('write after destroy')); return false; }
    const s = String(data ?? '');
    if (this._buf.length + s.length > this.maxLength) {
      const err = new Error('write buffer exceeded maxLength');
      if (cb) cb(err); else this.emit('error', err);
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
    this._buf = '';
    this.emit('data', chunk);
  }
  end(data, cb) {
    if (data !== undefined) this.write(data);
    this._flush();
    this.emit('finish');
    if (cb) cb(null);
  }
  destroy(err) {
    this._destroyed = true;
    this._buf = '';
    if (err) this.emit('error', err);
    this.emit('close');
  }
}

// Port of Node's internal toUnixTimestamp (lib/fs.js).
function _toUnixTimestamp(time, name = 'time') {
  if (typeof time === 'string' && +time == time) {
    return +time;
  }
  if (Number.isFinite(time)) {
    if (time < 0) {
      return Date.now() / 1000;
    }
    return time;
  }
  if (Object.prototype.toString.call(time) === '[object Date]') {
    // Convert to 123.456 UNIX timestamp
    return time.getTime() / 1000;
  }
  throw new TypeError(
    `The "${name}" argument must be of type Date or time in seconds. Received ${time}`
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
    if (f && typeof pos === 'number') f.position = pos;
  }
  function checkFdReadable(fd, syscallName) {
    const f = fdEntry(fd);
    if (!f) {
      const err = makeFsError('EBADF', syscallName, undefined, 'bad file descriptor');
      err.errno = -9;
      throw err;
    }
    // O_RDONLY=0, O_RDWR=2 are readable; O_WRONLY=1, O_APPEND-only are not.
    const accmode = f.flags & 3;
    if (accmode === 1) {
      const err = makeFsError('EBADF', syscallName, undefined, 'bad file descriptor');
      err.errno = -9;
      throw err;
    }
  }
  function checkFdWritable(fd, syscallName) {
    const f = fdEntry(fd);
    if (!f) {
      const err = makeFsError('EBADF', syscallName, undefined, 'bad file descriptor');
      err.errno = -9;
      throw err;
    }
    const accmode = f.flags & 3;
    if (accmode === 0) {
      const err = makeFsError('EBADF', syscallName, undefined, 'bad file descriptor');
      err.errno = -9;
      throw err;
    }
  }

  // Normalize raw ArrayBuffer/DataView inputs for read/write data args.
  function normalizeDataArg(data) {
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (typeof DataView !== 'undefined' && data instanceof DataView) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return data;
  }
  // Validate write data like real Node (string | Buffer | TypedArray | DataView).
  function validateDataArg(data, name) {
    if (typeof data === 'string') return;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return;
    if (typeof ArrayBuffer !== 'undefined' && (
      data instanceof ArrayBuffer || ArrayBuffer.isView(data))) return;
    // Blob is allowed in real Node's writeFile.
    if (typeof Blob !== 'undefined' && data instanceof Blob) return;
    throw errInvalidArgType(name || 'data',
      ['string', 'Buffer', 'TypedArray', 'DataView'], data);
  }

  // ── generic wrappers ──
  function wrapSync(name, impl, validatePathFirst) {
    const orig = fs[name];
    fs[name] = function (...args) {
      let result;
      try {
        if (validatePathFirst) validatePath(args[0]);
        result = (impl || orig).apply(this, args);
      } catch (e) { throw enrichErr(e, name); }
      emitFs('fs', name, ...args, result);
      return result;
    };
  }
  // Node callback result arity (number of args after err) per function.
  // memfs sometimes passes extra undefined/null args; trim to match Node.
  const cbResultArity = {
    close: 0, unlink: 0, mkdir: 1, rmdir: 0, rm: 0, rename: 0,
    link: 0, symlink: 0, chmod: 0, fchmod: 0, lchmod: 0,
    chown: 0, fchown: 0, lchown: 0, utimes: 0, futimes: 0, lutimes: 0,
    fsync: 0, fdatasync: 0, truncate: 0, ftruncate: 0,
    write: 2, // (bytesWritten, buffer)
    read: 2,  // (bytesRead, buffer)
    readv: 2, writev: 2,
    open: 1, opendir: 1, mkdtemp: 1,
    readdir: 1, readFile: 1, appendFile: 0, writeFile: 0, copyFile: 0, cp: 0,
    stat: 1, lstat: 1, fstat: 1, statfs: 1,
    readlink: 1, realpath: 1, access: 0, exists: 1,
    mkdtempDisposable: 1,
  };
  function wrapCb(name, impl, validatePathFirst) {
    const orig = fs[name];
    const arity = cbResultArity[name];
    fs[name] = function (...args) {
      const last = args[args.length - 1];
      if (typeof last !== 'function') throw errInvalidArgType('cb', 'function', last);
      const userCb = last;
      args[args.length - 1] = function (err, ...rest) {
        if (err) err = enrichErr(err, name);
        const trimmed = arity !== undefined ? rest.slice(0, arity) : rest;
        emitFs('fs', name, ...args.slice(0, -1), trimmed[0]);
        userCb(err, ...trimmed);
      };
      try {
        if (validatePathFirst) validatePath(args[0]);
        return (impl || orig).apply(this, args);
      } catch (e) { throw enrichErr(e, name); }
    };
  }
  function wrapPromise(p, name, impl) {
    const orig = (impl ? null : p[name]);
    p[name] = function (...args) {
      let result;
      try {
        result = (impl || orig).apply(this, args);
      } catch (e) { return Promise.reject(enrichErr(e, name)); }
      return Promise.resolve(result).then(
        (val) => { emitFs('fs', `promises.${name}`, ...args, val); return val; },
        (err) => { emitFs('fs', `promises.${name}`, ...args, undefined); throw enrichErr(err, name); }
      );
    };
  }

  // ── stat/lstat/fstat → NodeStats ──
  for (const name of ['statSync', 'lstatSync']) {
    const orig = fs[name];
    fs[name] = function (p, options) {
      validatePath(p);
      let m;
      try {
        m = orig.call(this, toPathString(p), options);
      } catch (e) { throw enrichErr(e, name); }
      const st = toStats(m, options);
      emitFs('fs', name, p, st);
      return st;
    };
  }
  {
    const orig = fs.fstatSync;
    fs.fstatSync = function (fd, options) {
      let m;
      try {
        m = orig.call(this, fd, options);
      } catch (e) { throw enrichErr(e, 'fstatSync'); }
      const st = toStats(m, options);
      emitFs('fs', 'fstatSync', fd, st);
      return st;
    };
  }
  for (const name of ['stat', 'lstat']) {
    const orig = fs[name];
    fs[name] = function (p, options, callback) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
      validatePath(p);
      orig.call(this, toPathString(p), options, (err, m) => {
        if (err) return callback(enrichErr(err, name));
        const st = toStats(m, options);
        emitFs('fs', name, p, st);
        callback(null, st);
      });
    };
  }
  {
    const orig = fs.fstat;
    fs.fstat = function (fd, options, callback) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
      orig.call(this, fd, options, (err, m) => {
        if (err) return callback(enrichErr(err, 'fstat'));
        const st = toStats(m, options);
        emitFs('fs', 'fstat', fd, st);
        callback(null, st);
      });
    };
  }

  // ── readdir/readdirSync: Dirent shape + recursive ──
  function readdirImpl(p, options, wantDirent) {
    const names = vol.readdirSync(p);
    if (options && options.recursive) {
      const out = [];
      const walk = (dir, rel) => {
        for (const name of vol.readdirSync(dir)) {
          const full = dir + '/' + name;
          const rp = rel ? rel + '/' + name : name;
          let st;
          try { st = vol.lstatSync(full); } catch { continue; }
          if (wantDirent) out.push(new Dirent(name, dir, st.mode));
          else out.push(rp);
          if (st.isDirectory()) walk(full, rp);
        }
      };
      walk(p, '');
      return out;
    }
    if (wantDirent) {
      return names.map((name) => {
        let mode = 0;
        try { mode = vol.lstatSync(p + '/' + name).mode; } catch { /* ignore */ }
        return new Dirent(name, p, mode);
      });
    }
    return names;
  }
  {
    const orig = fs.readdirSync;
    fs.readdirSync = function (p, options) {
      validatePath(p);
      const ps = toPathString(p);
      let result;
      try {
        if (options && (options.withFileTypes || options.recursive)) {
          result = readdirImpl(ps, options, !!(options.withFileTypes));
        } else {
          result = orig.call(this, ps, options);
        }
      } catch (e) { throw enrichErr(e, 'readdirSync'); }
      emitFs('fs', 'readdirSync', p, result);
      return result;
    };
  }
  {
    const orig = fs.readdir;
    fs.readdir = function (p, options, callback) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
      validatePath(p);
      const ps = toPathString(p);
      const done = (err, result) => {
        if (err) return callback(enrichErr(err, 'readdir'));
        emitFs('fs', 'readdir', p, result);
        callback(null, result);
      };
      if (options && (options.withFileTypes || options.recursive)) {
        try {
          done(null, readdirImpl(ps, options, !!(options.withFileTypes)));
        } catch (e) { done(e); }
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
    if (bufferOrOptions && typeof bufferOrOptions === 'object' &&
        !(bufferOrOptions instanceof Uint8Array) && !ArrayBuffer.isView(bufferOrOptions)) {
      const o = bufferOrOptions;
      return { fd, buffer: o.buffer, offset: o.offset || 0, length: o.length, position: o.position, opts: true };
    }
    return { fd, buffer: bufferOrOptions, offset, length, position };
  }
  {
    const orig = fs.readSync;
    fs.readSync = function (...args) {
      const { fd, buffer, offset, length, position } = parseReadArgs(args);
      checkFdReadable(fd, 'read');
      let buf = buffer;
      if (!(buf instanceof Uint8Array) && !ArrayBuffer.isView(buf)) {
        // allocate like Node does when buffer is omitted
        const len = typeof length === 'number' ? length : 16384;
        buf = typeof Buffer !== 'undefined' ? Buffer.alloc(len) : new Uint8Array(len);
      }
      const off = offset || 0;
      const len = length === undefined || length === null ? buf.byteLength - off : length;
      const savedPos = typeof position === 'number' ? getPosition(fd) : undefined;
      let n;
      try {
        n = orig.call(this, fd, buf, off, len, position === undefined ? null : position);
      } catch (e) { throw enrichErr(e, 'readSync'); }
      finally {
        if (savedPos !== undefined) setPosition(fd, savedPos);
      }
      const result = args.length === 2 || (args[1] && typeof args[1] === 'object' && !(args[1] instanceof Uint8Array) && !ArrayBuffer.isView(args[1]))
        ? { bytesRead: n, buffer: buf }
        : n;
      emitFs('fs', 'readSync', fd, result);
      return result;
    };
  }
  {
    const orig = fs.read;
    fs.read = function (...args) {
      const callback = args[args.length - 1];
      if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
      const { fd, buffer, offset, length, position } = parseReadArgs(args.slice(0, -1));
      let buf = buffer;
      if (!(buf instanceof Uint8Array) && !ArrayBuffer.isView(buf)) {
        const len = typeof length === 'number' ? length : 16384;
        buf = typeof Buffer !== 'undefined' ? Buffer.alloc(len) : new Uint8Array(len);
      }
      const off = offset || 0;
      const len = length === undefined || length === null ? buf.byteLength - off : length;
      try {
        checkFdReadable(fd, 'read');
      } catch (e) { nextTick(callback, enrichErr(e, 'read')); return; }
      const savedPos = typeof position === 'number' ? getPosition(fd) : undefined;
      const cb = (err, bytesRead, b) => {
        if (savedPos !== undefined) setPosition(fd, savedPos);
        if (err) return callback(enrichErr(err, 'read'));
        emitFs('fs', 'read', fd, bytesRead);
        callback(null, bytesRead, b || buf);
      };
      try {
        return orig.call(this, fd, buf, off, len, position === undefined ? null : position, cb);
      } catch (e) { throw enrichErr(e, 'read'); }
    };
  }

  // ── writeSync/write: EBADF on wrong-direction fd, cursor preservation ──
  {
    const orig = fs.writeSync;
    fs.writeSync = function (fd, data, ...rest) {
      checkFdWritable(fd, 'write');
      validateDataArg(data, 'buffer');
      data = normalizeDataArg(data);
      // writeSync(fd, string[, position[, encoding]]) or writeSync(fd, buffer, offset, length, position)
      let position;
      if (typeof data === 'string') {
        position = rest[0];
      } else {
        position = rest[2];
      }
      const savedPos = typeof position === 'number' ? getPosition(fd) : undefined;
      let n;
      try {
        n = orig.call(this, fd, data, ...rest);
      } catch (e) { throw enrichErr(e, 'writeSync'); }
      finally {
        if (savedPos !== undefined) setPosition(fd, savedPos);
      }
      emitFs('fs', 'writeSync', fd, n);
      return n;
    };
  }
  {
    const orig = fs.write;
    fs.write = function (fd, data, ...rest) {
      const callback = rest[rest.length - 1];
      if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
      const args = rest.slice(0, -1);
      try {
        checkFdWritable(fd, 'write');
        validateDataArg(data, 'buffer');
      } catch (e) {
        nextTick(callback, enrichErr(e, 'write'));
        return;
      }
      data = normalizeDataArg(data);
      let position;
      if (typeof data === 'string') position = args[0];
      else position = args[2];
      const savedPos = typeof position === 'number' ? getPosition(fd) : undefined;
      const cb = (err, written, d) => {
        if (savedPos !== undefined) setPosition(fd, savedPos);
        if (err) return callback(enrichErr(err, 'write'));
        emitFs('fs', 'write', fd, written);
        callback(null, written, d);
      };
      try {
        return orig.call(this, fd, data, ...args, cb);
      } catch (e) { throw enrichErr(e, 'write'); }
    };
  }

  // ── readv/writev (+Sync) ──
  function readvSyncImpl(fd, buffers, position) {
    checkFdReadable(fd, 'readv');
    if (!Array.isArray(buffers)) throw errInvalidArgType('buffers', 'Array', buffers);
    const savedPos = typeof position === 'number' ? getPosition(fd) : undefined;
    let total = 0;
    try {
      for (const b of buffers) {
        const buf = b instanceof Uint8Array || ArrayBuffer.isView(b) ? b
          : (typeof Buffer !== 'undefined' ? Buffer.alloc(0) : new Uint8Array(0));
        const n = vol.readSync(fd, buf, 0, buf.byteLength,
          typeof position === 'number' ? position + total : null);
        total += n;
        if (n < buf.byteLength) break;
      }
    } finally {
      if (savedPos !== undefined) setPosition(fd, savedPos);
    }
    return total;
  }
  function writevSyncImpl(fd, buffers, position) {
    checkFdWritable(fd, 'writev');
    if (!Array.isArray(buffers)) throw errInvalidArgType('buffers', 'Array', buffers);
    const savedPos = typeof position === 'number' ? getPosition(fd) : undefined;
    let total = 0;
    try {
      for (const b of buffers) {
        const buf = normalizeDataArg(b);
        const n = vol.writeSync(fd, buf, 0, buf.byteLength,
          typeof position === 'number' ? position + total : null);
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
    try { result = readvSyncImpl(fd, buffers, position); }
    catch (e) { throw enrichErr(e, 'readvSync'); }
    emitFs('fs', 'readvSync', fd, result);
    return result;
  };
  fs.writevSync = function (fd, buffers, position) {
    let result;
    try { result = writevSyncImpl(fd, buffers, position); }
    catch (e) { throw enrichErr(e, 'writevSync'); }
    emitFs('fs', 'writevSync', fd, result);
    return result;
  };
  fs.readv = function (fd, buffers, position, callback) {
    if (typeof position === 'function') { callback = position; position = undefined; }
    if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
    const run = () => {
      try {
        const bytesRead = readvSyncImpl(fd, buffers, position);
        emitFs('fs', 'readv', fd, bytesRead);
        callback(null, bytesRead, buffers);
      } catch (e) { callback(enrichErr(e, 'readv')); }
    };
    nextTick(run);
  };
  fs.writev = function (fd, buffers, position, callback) {
    if (typeof position === 'function') { callback = position; position = undefined; }
    if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
    const run = () => {
      try {
        const bytesWritten = writevSyncImpl(fd, buffers, position);
        emitFs('fs', 'writev', fd, bytesWritten);
        callback(null, bytesWritten, buffers);
      } catch (e) { callback(enrichErr(e, 'writev')); }
    };
    nextTick(run);
  };

  // ── access/accessSync: mode validation + permission enforcement ──
  function accessCheck(path, mode) {
    validatePath(path);
    if (mode === undefined || mode === null) mode = fs.constants.F_OK;
    if (typeof mode !== 'number' || !Number.isInteger(mode)) {
      // Real Node's message for a bad access mode.
      const err = new Error('mode must be int32 or null/undefined');
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    const p = toPathString(path);
    const st = vol.statSync(p); // throws ENOENT
    const m = st.mode;
    const fail = () => { throw enrichErr(makeFsError('EACCES', 'access', p, 'permission denied'), 'access'); };
    if ((mode & fs.constants.W_OK) && !(m & 0o222)) fail();
    if ((mode & fs.constants.R_OK) && !(m & 0o444)) fail();
    if ((mode & fs.constants.X_OK) && !(m & 0o111)) fail();
  }
  fs.accessSync = function (path, mode) {
    try { accessCheck(path, mode); }
    catch (e) { throw enrichErr(e, 'accessSync'); }
    emitFs('fs', 'accessSync', path, undefined);
  };
  fs.access = function (path, mode, callback) {
    if (typeof mode === 'function') { callback = mode; mode = undefined; }
    if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
    nextTick(() => {
      try {
        accessCheck(path, mode);
        emitFs('fs', 'access', path, undefined);
        callback(null);
      } catch (e) { callback(enrichErr(e, 'access')); }
    });
  };

  // ── mkdir/mkdirSync: recursive on existing file → EEXIST; umask ──
  function mkdirImpl(p, options) {
    const opts = typeof options === 'number' ? { mode: options } : (options || {});
    if (opts.mode !== undefined) opts.mode = applyUmask(opts.mode);
    if (opts.recursive) {
      // Real Node: recursive mkdir on an existing *file* reports EEXIST.
      let st = null;
      try { st = vol.statSync(p); } catch { /* ignore */ }
      if (st && !st.isDirectory()) {
        throw enrichErr(makeFsError('EEXIST', 'mkdir', p, 'file already exists'), 'mkdir');
      }
    }
    return vol.mkdirSync(p, opts);
  }
  {
    const orig = fs.mkdir;
    fs.mkdirSync = function (p, options) {
      validatePath(p);
      let result;
      try { result = mkdirImpl(toPathString(p), options); }
      catch (e) { throw enrichErr(e, 'mkdirSync'); }
      emitFs('fs', 'mkdirSync', p, result);
      return result;
    };
    fs.mkdir = function (p, options, callback) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
      validatePath(p);
      nextTick(() => {
        try {
          const result = mkdirImpl(toPathString(p), options);
          emitFs('fs', 'mkdir', p, result);
          callback(null, options && options.recursive ? result : undefined);
        } catch (e) { callback(enrichErr(e, 'mkdir')); }
      });
    };
  }

  // ── rename/renameSync: enforce dir/file type rules (memfs is lax) ──
  function renameTypeError(code, message, src, dest) {
    const err = new Error(`${code}: ${message}, rename '${src}' -> '${dest}'`);
    err.code = code;
    err.errno = ERRNO_BY_CODE[code];
    err.syscall = 'rename';
    err.path = src;
    return err;
  }
  function checkRename(oldPath, newPath) {
    const src = toPathString(oldPath), dest = toPathString(newPath);
    let srcSt = null, destSt = null;
    try { srcSt = vol.statSync(src); } catch { /* ignore */ }
    try { destSt = vol.statSync(dest); } catch { /* ignore */ }
    if (srcSt && destSt) {
      if (srcSt.isDirectory() && !destSt.isDirectory()) {
        throw renameTypeError('ENOTDIR', 'not a directory', src, dest);
      }
      if (!srcSt.isDirectory() && destSt.isDirectory()) {
        throw renameTypeError('EISDIR', 'illegal operation on a directory', src, dest);
      }
    }
  }
  {
    const origSync = fs.renameSync, origCb = fs.rename;
    fs.renameSync = function (oldPath, newPath) {
      validatePath(oldPath); validatePath(newPath, 'newPath');
      try {
        checkRename(oldPath, newPath);
        origSync.call(this, toPathString(oldPath), toPathString(newPath));
      } catch (e) { throw enrichErr(e, 'renameSync'); }
      emitFs('fs', 'renameSync', oldPath, undefined);
    };
    fs.rename = function (oldPath, newPath, callback) {
      if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
      validatePath(oldPath); validatePath(newPath, 'newPath');
      nextTick(() => {
        try {
          checkRename(oldPath, newPath);
          origCb.call(this, toPathString(oldPath), toPathString(newPath), (err) => {
            if (err) return callback(enrichErr(err, 'rename'));
            emitFs('fs', 'rename', oldPath, undefined);
            callback(null);
          });
        } catch (e) { callback(enrichErr(e, 'rename')); }
      });
    };
  }

  // ── unlink/rm: directory errors ──
  function checkUnlink(p, syscallName) {
    const ps = toPathString(p);
    let st = null;
    try { st = vol.statSync(ps); } catch { /* ignore */ }
    if (st && st.isDirectory()) {
      throw enrichErr(makeFsError('EISDIR', syscallName, ps, 'illegal operation on a directory'), syscallName);
    }
  }
  function checkRm(p, options, syscallName) {
    const ps = toPathString(p);
    const opts = options || {};
    let st = null;
    try { st = vol.statSync(ps); } catch { /* ignore */ }
    if (st && st.isDirectory() && !opts.recursive && !opts.force) {
      // Real Node message shape (no code prefix, no quotes, no syscall).
      const err = new Error(`Path is a directory: rm returned EISDIR (is a directory) ${ps}`);
      err.code = 'ERR_FS_EISDIR';
      err.errno = 21;
      err.syscall = syscallName;
      err.path = ps;
      throw err;
    }
  }
  {
    const origSync = fs.unlinkSync, origCb = fs.unlink;
    fs.unlinkSync = function (p) {
      validatePath(p);
      try {
        checkUnlink(p, 'unlink');
        origSync.call(this, toPathString(p));
      } catch (e) { throw enrichErr(e, 'unlinkSync'); }
      emitFs('fs', 'unlinkSync', p, undefined);
    };
    fs.unlink = function (p, callback) {
      if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
      validatePath(p);
      nextTick(() => {
        try {
          checkUnlink(p, 'unlink');
          origCb.call(this, toPathString(p), (err) => {
            if (err) return callback(enrichErr(err, 'unlink'));
            emitFs('fs', 'unlink', p, undefined);
            callback(null);
          });
        } catch (e) { callback(enrichErr(e, 'unlink')); }
      });
    };
  }
  for (const [syncName, cbName] of [['rmSync', 'rm'], ['rmdirSync', 'rmdir']]) {
    const origSync = fs[syncName], origCb = fs[cbName];
    fs[syncName] = function (p, options) {
      validatePath(p);
      try {
        checkRm(p, options, syncName.replace('Sync', ''));
        origSync.call(this, toPathString(p), options);
      } catch (e) { throw enrichErr(e, syncName); }
      emitFs('fs', syncName, p, undefined);
    };
    fs[cbName] = function (p, options, callback) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
      validatePath(p);
      nextTick(() => {
        try {
          checkRm(p, options, cbName);
          origCb.call(this, toPathString(p), options, (err) => {
            if (err) return callback(enrichErr(err, cbName));
            emitFs('fs', cbName, p, undefined);
            callback(null);
          });
        } catch (e) { callback(enrichErr(e, cbName)); }
      });
    };
  }

  // ── truncate: negative → 0; fractional/NaN → ERR_OUT_OF_RANGE ──
  function normalizeTruncateLen(len) {
    if (len === undefined || len === null) return 0;
    const n = Number(len);
    if (!Number.isInteger(n)) {
      const err = new RangeError(`The value of "len" is out of range. It must be an integer. Received ${len}`);
      err.code = 'ERR_OUT_OF_RANGE';
      throw err;
    }
    return n < 0 ? 0 : n;
  }
  {
    const origSync = fs.truncateSync, origCb = fs.truncate;
    const origFSync = fs.ftruncateSync, origF = fs.ftruncate;
    fs.truncateSync = function (p, len) {
      validatePath(p);
      let result;
      try { result = origSync.call(this, toPathString(p), normalizeTruncateLen(len)); }
      catch (e) { throw enrichErr(e, 'truncateSync'); }
      emitFs('fs', 'truncateSync', p, result);
      return result;
    };
    fs.truncate = function (p, len, callback) {
      if (typeof len === 'function') { callback = len; len = undefined; }
      if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
      validatePath(p);
      let norm;
      try { norm = normalizeTruncateLen(len); }
      catch (e) { nextTick(callback, enrichErr(e, 'truncate')); return; }
      origCb.call(this, toPathString(p), norm, (err) => {
        if (err) return callback(enrichErr(err, 'truncate'));
        emitFs('fs', 'truncate', p, undefined);
        callback(null);
      });
    };
    fs.ftruncateSync = function (fd, len) {
      let result;
      try { result = origFSync.call(this, fd, normalizeTruncateLen(len)); }
      catch (e) { throw enrichErr(e, 'ftruncateSync'); }
      emitFs('fs', 'ftruncateSync', fd, result);
      return result;
    };
    fs.ftruncate = function (fd, len, callback) {
      if (typeof len === 'function') { callback = len; len = undefined; }
      if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
      let norm;
      try { norm = normalizeTruncateLen(len); }
      catch (e) { nextTick(callback, enrichErr(e, 'ftruncate')); return; }
      origF.call(this, fd, norm, (err) => {
        if (err) return callback(enrichErr(err, 'ftruncate'));
        emitFs('fs', 'ftruncate', fd, undefined);
        callback(null);
      });
    };
  }

  // ── open/openSync: umask on creation mode ──
  {
    const origSync = fs.openSync, origCb = fs.open;
    fs.openSync = function (p, flags, mode) {
      validatePath(p);
      let fd;
      try { fd = origSync.call(this, toPathString(p), flags, applyUmask(mode)); }
      catch (e) { throw enrichErr(e, 'openSync'); }
      emitFs('fs', 'openSync', p, fd);
      return fd;
    };
    fs.open = function (p, flags, mode, callback) {
      if (typeof mode === 'function') { callback = mode; mode = undefined; }
      if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
      validatePath(p);
      origCb.call(this, toPathString(p), flags, applyUmask(mode), (err, fd) => {
        if (err) return callback(enrichErr(err, 'open'));
        emitFs('fs', 'open', p, fd);
        callback(null, fd);
      });
    };
  }
  wrapSync('closeSync');
  wrapCb('close');

  // ── exists/existsSync: false for invalid paths (never throws) ──
  fs.existsSync = function (p) {
    try {
      if (typeof p !== 'string' && !isUint8ArrayLike(p)) return false;
      vol.statSync(toPathString(p));
      return true;
    } catch { return false; }
  };
  fs.exists = function (p, callback) {
    if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
    nextTick(() => callback(null, fs.existsSync(p)));
  };

  // ── copyFile: delegate + enrich ──
  wrapSync('copyFileSync', null, true);
  wrapCb('copyFile', null, true);

  // ── cp/cpSync ──
  function cpCheckRange(options) {
    const mode = options && options.mode;
    if (mode !== undefined && mode !== null) {
      const m = Number(mode);
      if (!Number.isInteger(m) || m < 0 || m > 7) {
        const err = new RangeError(`The value of "mode" is out of range. It must be >= 0 && <= 7. Received ${mode}`);
        err.code = 'ERR_OUT_OF_RANGE';
        throw err;
      }
    }
  }
  function cpImpl(src, dest, options) {
    const opts = options || {};
    cpCheckRange(opts);
    const s = toPathString(src), d = toPathString(dest);
    let srcLstat = null;
    try { srcLstat = vol.lstatSync(s); } catch (e) {
      throw enrichErr(e, 'cp');
    }
    const deref = !!opts.dereference;
    const srcIsDir = srcLstat.isSymbolicLink() && !deref ? false
      : (() => { try { return vol.statSync(s).isDirectory(); } catch { return srcLstat.isDirectory(); } })();
    let destSt = null;
    try { destSt = vol.statSync(d); } catch { /* ignore */ }

    if (s === d) {
      const err = makeFsError('ERR_FS_CP_EINVAL', 'cp', s, 'Invalid src or dest: cp returned EINVAL');
      err.errno = 22;
      throw err;
    }
    if (srcIsDir) {
      if (!opts.recursive) {
        const err = makeFsError('ERR_FS_EISDIR', 'cp', s, 'Path is a directory: cp returned EISDIR');
        err.errno = 21;
        throw err;
      }
      if (destSt && !destSt.isDirectory()) {
        const err = makeFsError('ERR_FS_CP_DIR_TO_NON_DIR', 'cp', s, 'Invalid src or dest: cp returned EINVAL');
        err.errno = 22;
        throw err;
      }
      // dest inside src?
      if (d === s || d.startsWith(s + '/')) {
        const err = makeFsError('ERR_FS_CP_EINVAL', 'cp', s, 'Invalid src or dest: cp returned EINVAL');
        err.errno = 22;
        throw err;
      }
    } else if (destSt && destSt.isDirectory()) {
      const err = makeFsError('ERR_FS_CP_NON_DIR_TO_DIR', 'cp', s, 'Invalid src or dest: cp returned EINVAL');
      err.errno = 22;
      throw err;
    }

    const filter = opts.filter;
    const doCopy = (from, to) => {
      if (filter && !filter(from, to)) return;
      let lst;
      try { lst = vol.lstatSync(from); } catch { return; }
      if (lst.isSymbolicLink() && !deref) {
        const target = vol.readlinkSync(from);
        const linkTarget = opts.verbatimSymlinks ? target
          : (target.startsWith('/') ? target : posixResolve(posixDirname(from), target));
        try { vol.symlinkSync(linkTarget, to); }
        catch (e) {
          if (opts.force !== false) { try { vol.unlinkSync(to); } catch {} vol.symlinkSync(linkTarget, to); }
          else throw e;
        }
        return;
      }
      const st = vol.statSync(from);
      if (st.isDirectory()) {
        try { vol.mkdirSync(to, { recursive: true }); } catch { /* ignore */ }
        for (const name of vol.readdirSync(from)) {
          doCopy(from + '/' + name, to + '/' + name);
        }
        // timestamps
        try { vol.utimesSync(to, st.atime, st.mtime); } catch {}
      } else {
        const existsDest = (() => { try { vol.statSync(to); return true; } catch { return false; } })();
        if (existsDest && opts.force === false && !opts.errorOnExist) return;
        if (existsDest && opts.errorOnExist) {
          throw enrichErr(makeFsError('EEXIST', 'cp', to, 'file already exists'), 'cp');
        }
        vol.copyFileSync(from, to);
        const srcStat = vol.statSync(from);
        try { vol.utimesSync(to, srcStat.atime, srcStat.mtime); } catch {}
        if (opts.preserveTimestamps) {
          try {
            vol.utimesSync(to, srcStat.atime, srcStat.mtime);
            vol.chmodSync(to, srcStat.mode);
          } catch {}
        }
      }
    };

    const finalDest = (srcIsDir || (destSt && destSt.isDirectory())) ? d : d;
    if (srcIsDir) {
      try { vol.mkdirSync(finalDest, { recursive: true }); } catch {}
      for (const name of vol.readdirSync(s)) {
        doCopy(s + '/' + name, finalDest + '/' + name);
      }
    } else {
      const target = (destSt && destSt.isDirectory()) ? finalDest + '/' + s.slice(s.lastIndexOf('/') + 1) : finalDest;
      doCopy(s, target);
    }
  }
  fs.cpSync = function (src, dest, options) {
    validatePath(src); validatePath(dest, 'dest');
    try { cpImpl(src, dest, options); }
    catch (e) { throw enrichErr(e, 'cpSync'); }
    emitFs('fs', 'cpSync', src, undefined);
  };
  fs.cp = function (src, dest, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
    validatePath(src); validatePath(dest, 'dest');
    nextTick(() => {
      try {
        cpImpl(src, dest, options);
        emitFs('fs', 'cp', src, undefined);
        callback(null);
      } catch (e) { callback(enrichErr(e, 'cp')); }
    });
  };

  // ── readFile/writeFile/appendFile: accept fd-or-path ──
  function fileArg(p) {
    if (typeof p === 'number') return p;
    validatePath(p);
    return toPathString(p);
  }
  for (const [syncName, cbName] of [['readFileSync', 'readFile'], ['writeFileSync', 'writeFile'], ['appendFileSync', 'appendFile']]) {
    const origSync = fs[syncName], origCb = fs[cbName];
    fs[syncName] = function (p, ...rest) {
      let data = rest[0];
      if (syncName !== 'readFileSync') {
        validateDataArg(data, 'data');
        data = normalizeDataArg(data);
      }
      let result;
      try { result = origSync.call(this, fileArg(p), data, ...rest.slice(1)); }
      catch (e) { throw enrichErr(e, syncName); }
      emitFs('fs', syncName, p, result);
      return result;
    };
    fs[cbName] = function (p, ...rest) {
      const callback = rest[rest.length - 1];
      if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
      const args = rest.slice(0, -1);
      if (cbName !== 'readFile') {
        // Real Node validates data synchronously (throws, not callback error).
        validateDataArg(args[0], 'data');
        args[0] = normalizeDataArg(args[0]);
      }
      let fp;
      try { fp = fileArg(p); }
      catch (e) { nextTick(callback, enrichErr(e, cbName)); return; }
      origCb.call(this, fp, ...args, (err, result) => {
        if (err) return callback(enrichErr(err, cbName));
        emitFs('fs', cbName, p, result);
        callback(null, result);
      });
    };
  }

  // ── opendir/opendirSync + Dir (auto-close after for-await) ──
  function dirClosedError() {
    const err = new Error('Directory is closed');
    err.code = 'ERR_DIR_CLOSED';
    return err;
  }
  class Dir {
    constructor(path) {
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
          try { mode = vol.lstatSync(this.path + '/' + name).mode; } catch { /* ignore */ }
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
      if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
      nextTick(() => {
        try { callback(null, this.readSync()); }
        catch (e) { callback(e); }
      });
    }
    closeSync() {
      if (this._closed) throw dirClosedError();
      this._closed = true;
      emitFs('fs', 'Dir.closeSync', this.path, undefined);
    }
    close(callback) {
      if (typeof callback !== 'function') return Promise.resolve().then(() => this.closeSync());
      nextTick(() => {
        try { this.closeSync(); callback(null); }
        catch (e) { callback(e); }
      });
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
        throw enrichErr(makeFsError('ENOTDIR', 'opendir', ps, 'not a directory'), 'opendirSync');
      }
      dir = new Dir(ps);
    } catch (e) { throw enrichErr(e, 'opendirSync'); }
    emitFs('fs', 'opendirSync', p, dir);
    return dir;
  };
  fs.opendir = function (p, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
    validatePath(p);
    nextTick(() => {
      try {
        const dir = fs.opendirSync(p, options);
        callback(null, dir);
      } catch (e) { callback(enrichErr(e, 'opendir')); }
    });
  };

  // ── glob/globSync ──
  function globMatch(pattern, path) {
    // Convert a glob pattern to a RegExp (supports *, **, ?).
    let re = '';
    let i = 0;
    while (i < pattern.length) {
      const c = pattern[i];
      if (c === '*') {
        if (pattern[i + 1] === '*') {
          // **/ or /** or **
          if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 3; }
          else { re += '.*'; i += 2; }
        } else { re += '[^/]*'; i += 1; }
      } else if (c === '?') { re += '[^/]'; i += 1; }
      else if ('+^${}()|[]\\.'.includes(c)) { re += '\\' + c; i += 1; }
      else { re += c; i += 1; }
    }
    return new RegExp('^' + re + '$').test(path);
  }
  function globImpl(patterns, options) {
    const opts = options || {};
    const cwd = opts.cwd ? toPathString(opts.cwd) : '/';
    const pats = Array.isArray(patterns) ? patterns : [patterns];
    const exclude = opts.exclude ? (Array.isArray(opts.exclude) ? opts.exclude : [opts.exclude]) : [];
    const withFileTypes = !!opts.withFileTypes;
    const results = [];
    const seen = new Set();
    // Collect all files/dirs under cwd.
    const all = [];
    const walk = (dir) => {
      let names;
      try { names = vol.readdirSync(dir); } catch { return; }
      for (const name of names) {
        const full = dir === '/' ? '/' + name : dir + '/' + name;
        all.push(full);
        let st;
        try { st = vol.lstatSync(full); } catch { continue; }
        if (st.isDirectory() && !st.isSymbolicLink()) walk(full);
      }
    };
    walk(cwd);
    for (let pat of pats) {
      const p = toPathString(pat);
      const absPat = p.startsWith('/') ? p : cwd + '/' + p;
      for (const full of all) {
        if (!globMatch(absPat, full)) continue;
        if (exclude.some((e) => globMatch(toPathString(e).startsWith('/') ? toPathString(e) : cwd + '/' + toPathString(e), full))) continue;
        // Relative patterns yield cwd-relative results; absolute yield absolute.
        const out = p.startsWith('/') ? full : full.slice(cwd.length + 1);
        if (seen.has(out)) continue;
        seen.add(out);
        if (withFileTypes) {
          let mode = 0;
          try { mode = vol.lstatSync(full).mode; } catch { /* ignore */ }
          results.push(new Dirent(full.slice(full.lastIndexOf('/') + 1), full.slice(0, full.lastIndexOf('/') + 1).replace(/\/$/, '') || '/', mode));
        } else {
          results.push(out);
        }
      }
    }
    return results;
  }
  fs.globSync = function (patterns, options) {
    let result;
    try { result = globImpl(patterns, options); }
    catch (e) { throw enrichErr(e, 'globSync'); }
    emitFs('fs', 'globSync', patterns, result);
    return result;
  };
  fs.glob = function (patterns, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (callback && typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
    const run = () => {
      try {
        const result = globImpl(patterns, options);
        emitFs('fs', 'glob', patterns, result);
        if (callback) callback(null, result);
        return result;
      } catch (e) {
        const err = enrichErr(e, 'glob');
        if (callback) callback(err);
        else throw err;
      }
    };
    if (callback) { nextTick(run); return undefined; }
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
    if (typeof v === 'number' || typeof v === 'string') {
      const d = new Date(typeof v === 'number' ? v * 1000 : v);
      if (isNaN(d.getTime())) throw errInvalidArgType(name, 'Date', v);
      return d;
    }
    throw errInvalidArgType(name, 'Date', v);
  }
  function lutimesImpl(p, atime, mtime) {
    const ps = toPathString(p);
    const at = toDate(atime, 'atime'), mt = toDate(mtime, 'mtime');
    const steps = ps.split('/').filter(Boolean);
    let link = null;
    try { link = vol.getLink(steps); } catch { link = null; }
    if (!link) {
      // Match memfs/Node ENOENT shape for a missing path.
      try { vol.lstatSync(ps); } catch (e) { throw e; }
      throw enrichErr(makeFsError('ENOENT', 'lstat', ps, 'no such file or directory'), 'lutimes');
    }
    const node = link.getNode();
    node.atime = at;
    node.mtime = mt;
  }
  fs.lutimesSync = function (p, atime, mtime) {
    validatePath(p);
    try { lutimesImpl(p, atime, mtime); }
    catch (e) { throw enrichErr(e, 'lutimesSync'); }
    emitFs('fs', 'lutimesSync', p, undefined);
  };
  fs.lutimes = function (p, atime, mtime, callback) {
    if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
    validatePath(p);
    nextTick(() => {
      try {
        lutimesImpl(p, atime, mtime);
        emitFs('fs', 'lutimes', p, undefined);
        callback(null);
      } catch (e) { callback(enrichErr(e, 'lutimes')); }
    });
  };

  // ── statfs/statfsSync (memfs lacks these) ──
  function statfsImpl(p) {
    const ps = toPathString(p);
    try { vol.statSync(ps); } catch (e) { throw e; }
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
    try { result = statfsImpl(p); }
    catch (e) { throw enrichErr(e, 'statfsSync'); }
    emitFs('fs', 'statfsSync', p, result);
    return result;
  };
  fs.statfs = function (p, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
    validatePath(p);
    nextTick(() => {
      try {
        const result = statfsImpl(p);
        emitFs('fs', 'statfs', p, result);
        callback(null, result);
      } catch (e) { callback(enrichErr(e, 'statfs')); }
    });
  };

  // ── mkdtemp/mkdtempSync + Disposable variants ──
  function mkdtempImpl(prefix, options) {
    const pre = toPathString(prefix);
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let attempt = 0; attempt < 10; attempt++) {
      let rand = '';
      for (let i = 0; i < 6; i++) rand += chars[(Math.random() * chars.length) | 0];
      const dir = pre + rand;
      try {
        vol.mkdirSync(dir);
        return (options && options.encoding === 'buffer' && typeof Buffer !== 'undefined')
          ? Buffer.from(dir) : dir;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    throw enrichErr(makeFsError('EEXIST', 'mkdtemp', pre, 'file already exists'), 'mkdtemp');
  }
  fs.mkdtempSync = function (prefix, options) {
    validatePath(prefix, 'prefix');
    let result;
    try { result = mkdtempImpl(prefix, options); }
    catch (e) { throw enrichErr(e, 'mkdtempSync'); }
    emitFs('fs', 'mkdtempSync', prefix, result);
    return result;
  };
  fs.mkdtemp = function (prefix, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
    validatePath(prefix, 'prefix');
    nextTick(() => {
      try {
        const result = mkdtempImpl(prefix, options);
        emitFs('fs', 'mkdtemp', prefix, result);
        callback(null, result);
      } catch (e) { callback(enrichErr(e, 'mkdtemp')); }
    });
  };
  fs.mkdtempDisposableSync = function (prefix, options) {
    const dir = fs.mkdtempSync(prefix, options);
    return {
      path: dir,
      [Symbol.dispose]() { try { vol.rmSync(toPathString(dir), { recursive: true, force: true }); } catch {} },
    };
  };
  fs.mkdtempDisposable = async function (prefix, options) {
    const dir = await new Promise((resolve, reject) => {
      fs.mkdtemp(prefix, options, (err, d) => err ? reject(err) : resolve(d));
    });
    return {
      path: dir,
      [Symbol.asyncDispose]() {
        return new Promise((resolve) => {
          fs.rm(toPathString(dir), { recursive: true, force: true }, () => resolve());
        });
      },
    };
  };

  // ── openAsBlob ──
  fs.openAsBlob = async function (p, options) {
    validatePath(p);
    const ps = toPathString(p);
    let data;
    try { data = vol.readFileSync(ps); }
    catch (e) { throw enrichErr(e, 'openAsBlob'); }
    emitFs('fs', 'openAsBlob', p, undefined);
    const type = (options && options.type) || '';
    if (typeof Blob !== 'undefined') return new Blob([data], { type });
    // Minimal Blob fallback.
    return { size: data.length, type, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), text: async () => new TextDecoder().decode(data) };
  };

  // ── realpath/realpathSync + .native ──
  function realpathImpl(p, options) {
    const ps = toPathString(p);
    let resolved;
    try { resolved = vol.realpathSync(ps); }
    catch (e) { throw e; }
    if (options && options.encoding === 'buffer' && typeof Buffer !== 'undefined') {
      return Buffer.from(resolved);
    }
    return resolved;
  }
  fs.realpathSync = function (p, options) {
    validatePath(p);
    let result;
    try { result = realpathImpl(p, typeof options === 'string' ? { encoding: options } : options); }
    catch (e) { throw enrichErr(e, 'realpathSync'); }
    emitFs('fs', 'realpathSync', p, result);
    return result;
  };
  fs.realpathSync.native = fs.realpathSync;
  fs.realpath = function (p, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (typeof callback !== 'function') throw errInvalidArgType('cb', 'function', callback);
    validatePath(p);
    nextTick(() => {
      try {
        const result = realpathImpl(p, typeof options === 'string' ? { encoding: options } : options);
        emitFs('fs', 'realpath', p, result);
        callback(null, result);
      } catch (e) { callback(enrichErr(e, 'realpath')); }
    });
  };
  fs.realpath.native = fs.realpath;

  // ── link/symlink/readlink: delegate + enrich/emit ──
  wrapSync('linkSync', null, true); wrapCb('link', null, true);
  wrapSync('symlinkSync', null, true); wrapCb('symlink', null, true);
  wrapSync('readlinkSync', null, true); wrapCb('readlink', null, true);
  wrapSync('chmodSync', null, true); wrapCb('chmod', null, true);
  wrapSync('fchmodSync'); wrapCb('fchmod');
  wrapSync('chownSync', null, true); wrapCb('chown', null, true);
  wrapSync('fchownSync'); wrapCb('fchown');
  wrapSync('lchownSync', null, true); wrapCb('lchown', null, true);
  wrapSync('utimesSync', null, true); wrapCb('utimes', null, true);
  wrapSync('futimesSync'); wrapCb('futimes');
  wrapSync('fsyncSync'); wrapCb('fsync');
  wrapSync('fdatasyncSync'); wrapCb('fdatasync');
  // lchmod/lchmodSync are undefined on Linux (Node behavior).
  try {
    if (typeof process !== 'undefined' && process.platform === 'linux') {
      fs.lchmod = undefined;
      fs.lchmodSync = undefined;
    } else {
      wrapSync('lchmodSync'); wrapCb('lchmod');
    }
  } catch { /* ignore */ }

  // ── watch/watchFile: add ref()/unref(), emit events ──
  function patchWatcher(w, path) {
    if (w && typeof w === 'object') {
      if (typeof w.ref !== 'function') {
        w.ref = function () { return w; };
      }
      if (typeof w.unref !== 'function') {
        w.unref = function () { return w; };
      }
      const origClose = w.close ? w.close.bind(w) : null;
      if (origClose) {
        w.close = function (...args) {
          emitFs('fs', 'watcher.close', path, undefined);
          return origClose(...args);
        };
      }
    }
    return w;
  }
  {
    const orig = fs.watch;
    fs.watch = function (p, options, listener) {
      if (typeof options === 'function') { listener = options; options = undefined; }
      validatePath(p);
      const ps = toPathString(p);
      let w;
      try { w = orig.call(this, ps, options, listener); }
      catch (e) { throw enrichErr(e, 'watch'); }
      patchWatcher(w, ps);
      emitFs('fs', 'watch', p, w);
      return w;
    };
  }
  // watchFile: poll-based, safe replacement.
  const _watchFileTimers = new Map();
  fs.watchFile = function (p, options, listener) {
    if (typeof options === 'function') { listener = options; options = undefined; }
    if (typeof listener !== 'function') throw errInvalidArgType('listener', 'function', listener);
    validatePath(p);
    const ps = toPathString(p);
    const interval = (options && options.interval) || 5007;
    let prev = null;
    try { prev = toStats(vol.statSync(ps)); } catch { /* ignore */ }
    const timer = setInterval(() => {
      let curr = null;
      try { curr = toStats(vol.statSync(ps)); } catch { /* ignore */ }
      const changed = (!prev && curr) || (prev && !curr) ||
        (prev && curr && (prev.mtimeMs !== curr.mtimeMs || prev.size !== curr.size));
      if (changed) {
        try { listener(curr || prev, prev); } catch { /* ignore */ }
      }
      prev = curr;
    }, interval);
    if (timer.unref) timer.unref();
    const key = ps + '\x00' + interval;
    if (!_watchFileTimers.has(key)) _watchFileTimers.set(key, new Set());
    _watchFileTimers.get(key).add(timer);
    const statWatcher = {
      ref() { if (timer.ref) timer.ref(); return statWatcher; },
      unref() { if (timer.unref) timer.unref(); return statWatcher; },
    };
    emitFs('fs', 'watchFile', p, statWatcher);
    return statWatcher;
  };
  fs.unwatchFile = function (p, listener) {
    validatePath(p);
    const ps = toPathString(p);
    for (const [key, timers] of _watchFileTimers) {
      if (key.startsWith(ps + '\x00')) {
        for (const t of timers) clearInterval(t);
        _watchFileTimers.delete(key);
      }
    }
    emitFs('fs', 'unwatchFile', p, undefined);
  };

  // ── createReadStream/createWriteStream (project's local stream impl) ──
  class FsReadStream extends Readable {
    constructor(path, options) {
      super(options);
      const opts = options || {};
      this.path = toPathString(path);
      this.fd = opts.fd === undefined || opts.fd === null ? null : opts.fd;
      this.flags = opts.flags || 'r';
      this.mode = opts.mode || 0o666;
      this.start = opts.start;
      this.end = opts.end;
      this.autoClose = opts.autoClose !== false;
      this._pos = this.start || 0;
      this._opened = false;
      emitFs('fs', 'createReadStream', this.path, this);
      if (this.fd === null) {
        try {
          this.fd = vol.openSync(this.path, this.flags, this.mode);
          this._opened = true;
        } catch (e) {
          nextTick(() => this.destroy(enrichErr(e, 'createReadStream')));
          return;
        }
      }
      nextTick(() => this.emit('open', this.fd));
    }
    _read(size) {
      const doRead = () => {
        let toRead = size || 16384;
        if (this.end !== undefined) toRead = Math.min(toRead, this.end - this._pos + 1);
        if (toRead <= 0) {
          this.push(null);
          this._cleanup();
          return;
        }
        const buf = typeof Buffer !== 'undefined' ? Buffer.alloc(toRead) : new Uint8Array(toRead);
        let n;
        try {
          n = vol.readSync(this.fd, buf, 0, toRead, this._pos);
        } catch (e) {
          this.destroy(enrichErr(e, 'read'));
          return;
        }
        if (n === 0) {
          this.push(null);
          this._cleanup();
          return;
        }
        this._pos += n;
        this.push(buf.slice(0, n));
      };
      nextTick(doRead);
    }
    _cleanup() {
      if (this.autoClose && this._opened && this.fd !== null) {
        try { vol.closeSync(this.fd); } catch { /* ignore */ }
        this.fd = null;
      }
    }
    _destroy(err, callback) {
      this._cleanup();
      callback(err);
    }
  }
  class FsWriteStream extends Writable {
    constructor(path, options) {
      super(options);
      const opts = options || {};
      this.path = toPathString(path);
      this.fd = opts.fd === undefined || opts.fd === null ? null : opts.fd;
      this.flags = opts.flags || 'w';
      this.mode = opts.mode || 0o666;
      this.start = opts.start;
      this.autoClose = opts.autoClose !== false;
      this._pos = this.start;
      this._opened = false;
      emitFs('fs', 'createWriteStream', this.path, this);
      if (this.fd === null) {
        try {
          this.fd = vol.openSync(this.path, this.flags, this.mode);
          this._opened = true;
        } catch (e) {
          nextTick(() => this.destroy(enrichErr(e, 'createWriteStream')));
          return;
        }
      }
      nextTick(() => this.emit('open', this.fd));
    }
    _write(chunk, encoding, callback) {
      let data = chunk;
      if (typeof data === 'string') {
        data = typeof Buffer !== 'undefined' ? Buffer.from(data, encoding) : new TextEncoder().encode(data);
      }
      data = normalizeDataArg(data);
      try {
        const pos = this._pos === undefined || this._pos === null ? null : this._pos;
        const n = vol.writeSync(this.fd, data, 0, data.byteLength, pos);
        if (pos !== null && pos !== undefined) this._pos = pos + n;
        emitFs('fs', 'writeStream.write', this.path, n);
        callback(null);
      } catch (e) {
        callback(enrichErr(e, 'write'));
      }
    }
    _final(callback) {
      this._cleanup();
      callback(null);
    }
    _cleanup() {
      // A FileHandle-owned fd (or autoClose:false) is never closed by us.
      if (this.autoClose && this._opened && this.fd !== null) {
        try { vol.closeSync(this.fd); } catch { /* ignore */ }
        this.fd = null;
      }
    }
    _destroy(err, callback) {
      this._cleanup();
      callback(err);
    }
  }
  fs.createReadStream = function (p, options) { return new FsReadStream(p, options); };
  fs.createWriteStream = function (p, options) { return new FsWriteStream(p, options); };
  fs.ReadStream = FsReadStream;
  fs.WriteStream = FsWriteStream;
  fs.FileReadStream = FsReadStream;
  fs.FileWriteStream = FsWriteStream;

  // ── FileHandle (internal; never exposed publicly) ──
  const MemFileHandle = fs.promises.FileHandle;
  class FileHandle extends MemFileHandle {
    constructor(fd) {
      super(fd);
      this.fd = fd;
    }
    async stat(options) {
      try {
        const m = vol.fstatSync(this.fd);
        const st = toStats(m, options);
        emitFs('fs', 'promises.stat', this.fd, st);
        return st;
      } catch (e) { throw enrichErr(e, 'stat'); }
    }
    async read(arg1, arg2, arg3, arg4) {
      // read([buffer[, offset[, length[, position]]]]) / read(options)
      let buffer, offset = 0, length, position = null;
      if (arg1 && typeof arg1 === 'object' && !(arg1 instanceof Uint8Array) && !ArrayBuffer.isView(arg1)) {
        buffer = arg1.buffer; offset = arg1.offset || 0; length = arg1.length; position = arg1.position !== undefined ? arg1.position : null;
      } else {
        buffer = arg1; offset = arg2 || 0; length = arg3; position = arg4 !== undefined ? arg4 : null;
      }
      if (!(buffer instanceof Uint8Array) && !ArrayBuffer.isView(buffer)) {
        const len = typeof length === 'number' ? length : 16384;
        buffer = typeof Buffer !== 'undefined' ? Buffer.alloc(len) : new Uint8Array(len);
      }
      if (length === undefined || length === null) length = buffer.byteLength - offset;
      checkFdReadable(this.fd, 'read');
      const savedPos = typeof position === 'number' ? getPosition(this.fd) : undefined;
      let bytesRead;
      try {
        bytesRead = vol.readSync(this.fd, buffer, offset, length, position);
      } catch (e) { throw enrichErr(e, 'read'); }
      finally {
        if (savedPos !== undefined) setPosition(this.fd, savedPos);
      }
      emitFs('fs', 'promises.read', this.fd, bytesRead);
      return { bytesRead, buffer };
    }
    async write(arg1, arg2, arg3, arg4) {
      // write(string[, position[, encoding]]) / write(buffer[, offset[, length[, position]]])
      let data = arg1, position;
      let offset = 0, length, encoding = 'utf8';
      if (typeof data === 'string') {
        position = arg2 !== undefined ? arg2 : null; encoding = arg3 || 'utf8';
        data = typeof Buffer !== 'undefined' ? Buffer.from(data, encoding) : new TextEncoder().encode(data);
      } else {
        data = normalizeDataArg(data);
        offset = arg2 || 0; length = arg3; position = arg4 !== undefined ? arg4 : null;
      }
      if (length === undefined || length === null) length = data.byteLength - offset;
      checkFdWritable(this.fd, 'write');
      const savedPos = typeof position === 'number' ? getPosition(this.fd) : undefined;
      let bytesWritten;
      try {
        bytesWritten = vol.writeSync(this.fd, data, offset, length, position);
      } catch (e) { throw enrichErr(e, 'write'); }
      finally {
        if (savedPos !== undefined) setPosition(this.fd, savedPos);
      }
      emitFs('fs', 'promises.write', this.fd, bytesWritten);
      return { bytesWritten, buffer: data };
    }
    async readv(buffers, position) {
      try {
        const bytesRead = readvSyncImpl(this.fd, buffers, position === undefined ? null : position);
        const result = { bytesRead, buffers };
        emitFs('fs', 'promises.readv', this.fd, result);
        return result;
      } catch (e) { throw enrichErr(e, 'readv'); }
    }
    async writev(buffers, position) {
      try {
        const bytesWritten = writevSyncImpl(this.fd, buffers, position === undefined ? null : position);
        const result = { bytesWritten, buffers };
        emitFs('fs', 'promises.writev', this.fd, result);
        return result;
      } catch (e) { throw enrichErr(e, 'writev'); }
    }
    async readFile(options) {
      try {
        const data = vol.readFileSync(this.fd, options);
        emitFs('fs', 'promises.readFile', this.fd, data);
        return data;
      } catch (e) { throw enrichErr(e, 'readFile'); }
    }
    async writeFile(data, options) {
      validateDataArg(data, 'data');
      data = normalizeDataArg(data);
      try {
        // Write at position 0 and truncate, mirroring writeFile-on-fd.
        vol.writeFileSync(this.fd, data, options);
        emitFs('fs', 'promises.writeFile', this.fd, undefined);
      } catch (e) { throw enrichErr(e, 'writeFile'); }
    }
    async appendFile(data, options) {
      data = normalizeDataArg(data);
      try {
        const st = vol.fstatSync(this.fd);
        vol.writeSync(this.fd, data, 0, data.byteLength, st.size);
        emitFs('fs', 'promises.appendFile', this.fd, undefined);
      } catch (e) { throw enrichErr(e, 'appendFile'); }
    }
    async truncate(len) {
      try {
        vol.ftruncateSync(this.fd, normalizeTruncateLen(len));
        emitFs('fs', 'promises.truncate', this.fd, undefined);
      } catch (e) { throw enrichErr(e, 'truncate'); }
    }
    async chmod(mode) {
      try { vol.fchmodSync(this.fd, mode); emitFs('fs', 'promises.chmod', this.fd, undefined); }
      catch (e) { throw enrichErr(e, 'chmod'); }
    }
    async chown(uid, gid) {
      try { vol.fchownSync(this.fd, uid, gid); emitFs('fs', 'promises.chown', this.fd, undefined); }
      catch (e) { throw enrichErr(e, 'chown'); }
    }
    async utimes(atime, mtime) {
      try { vol.futimesSync(this.fd, toDate(atime, 'atime'), toDate(mtime, 'mtime')); emitFs('fs', 'promises.utimes', this.fd, undefined); }
      catch (e) { throw enrichErr(e, 'utimes'); }
    }
    async datasync() {
      try { vol.fdatasyncSync(this.fd); } catch (e) { throw enrichErr(e, 'datasync'); }
    }
    async sync() {
      try { vol.fsyncSync(this.fd); } catch (e) { throw enrichErr(e, 'sync'); }
    }
    async close() {
      try { vol.closeSync(this.fd); emitFs('fs', 'promises.close', this.fd, undefined); }
      catch (e) { throw enrichErr(e, 'close'); }
    }
    async readableWebStream(options) {
      const stream = this.createReadStream(options);
      if (typeof Readable.toWeb === 'function') return Readable.toWeb(stream);
      // Minimal WHATWG fallback.
      const reader = stream[Symbol.asyncIterator]();
      return new ReadableStream({
        async pull(controller) {
          const { value, done } = await reader.next();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel() { stream.destroy(); },
      });
    }
    createReadStream(options) {
      return new FsReadStream(null, { ...options, fd: this.fd, autoClose: false });
    }
    createWriteStream(options) {
      return new FsWriteStream(null, { ...options, fd: this.fd, autoClose: false });
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
        let leftover = '';
        for await (const chunk of stream) {
          const text = leftover + chunk.toString();
          const lines = text.split('\n');
          leftover = lines.pop();
          for (const line of lines) yield line;
        }
        if (leftover) yield leftover;
      })();
    }
  }

  // ── promises assembly ──
  const promises = {};
  const definePromise = (name, fn) => {
    promises[name] = function (...args) {
      let result;
      try { result = fn.apply(this, args); }
      catch (e) { return Promise.reject(enrichErr(e, name)); }
      return Promise.resolve(result).then(
        (val) => { emitFs('fs', `promises.${name}`, ...args, val); return val; },
        (err) => { emitFs('fs', `promises.${name}`, ...args, undefined); throw enrichErr(err, name); }
      );
    };
  };

  definePromise('access', (p, mode) => new Promise((resolve, reject) => {
    fs.access(p, mode, (err) => err ? reject(err) : resolve());
  }));
  definePromise('open', (p, flags, mode) => new Promise((resolve, reject) => {
    fs.open(p, flags, mode, (err, fd) => {
      if (err) return reject(err);
      resolve(new FileHandle(fd));
    });
  }));
  definePromise('readFile', (p, options) => {
    if (p instanceof FileHandle) return p.readFile(options);
    return new Promise((resolve, reject) => {
      fs.readFile(p, options, (err, data) => err ? reject(err) : resolve(data));
    });
  });
  definePromise('writeFile', (p, data, options) => {
    if (p instanceof FileHandle) return p.writeFile(data, options);
    return new Promise((resolve, reject) => {
      fs.writeFile(p, data, options, (err) => err ? reject(err) : resolve());
    });
  });
  definePromise('appendFile', (p, data, options) => {
    if (p instanceof FileHandle) {
      // Append via handle: write at end.
      return p.stat().then((st) => p.write(data, Number(st.size)).then(() => {}));
    }
    return new Promise((resolve, reject) => {
      fs.appendFile(p, data, options, (err) => err ? reject(err) : resolve());
    });
  });
  definePromise('truncate', (p, len) => new Promise((resolve, reject) => {
    fs.truncate(p, len, (err) => err ? reject(err) : resolve());
  }));
  definePromise('copyFile', (src, dest, mode) => new Promise((resolve, reject) => {
    fs.copyFile(src, dest, mode, (err) => err ? reject(err) : resolve());
  }));
  definePromise('rename', (a, b) => new Promise((resolve, reject) => {
    fs.rename(a, b, (err) => err ? reject(err) : resolve());
  }));
  definePromise('unlink', (p) => new Promise((resolve, reject) => {
    fs.unlink(p, (err) => err ? reject(err) : resolve());
  }));
  definePromise('mkdir', (p, options) => new Promise((resolve, reject) => {
    fs.mkdir(p, options, (err, made) => err ? reject(err) : resolve(made));
  }));
  definePromise('mkdtemp', (prefix, options) => new Promise((resolve, reject) => {
    fs.mkdtemp(prefix, options, (err, dir) => err ? reject(err) : resolve(dir));
  }));
  definePromise('mkdtempDisposable', (prefix, options) => fs.mkdtempDisposable(prefix, options));
  definePromise('opendir', (p, options) => new Promise((resolve, reject) => {
    fs.opendir(p, options, (err, dir) => {
      if (err) return reject(err);
      // Promise-flavoured Dir: read()/close() return promises.
      dir.read = () => new Promise((res, rej) => {
        nextTick(() => {
          try { res(dir.readSync()); }
          catch (e) { rej(enrichErr(e, 'opendir')); }
        });
      });
      const origClose = dir.close.bind(dir);
      dir.close = (cb) => {
        if (typeof cb === 'function') return origClose(cb);
        return new Promise((res, rej) => {
          nextTick(() => {
            try { dir.closeSync(); res(); }
            catch (e) { rej(enrichErr(e, 'opendir')); }
          });
        });
      };
      resolve(dir);
    });
  }));
  definePromise('readdir', (p, options) => new Promise((resolve, reject) => {
    fs.readdir(p, options, (err, names) => err ? reject(err) : resolve(names));
  }));
  definePromise('rmdir', (p, options) => new Promise((resolve, reject) => {
    fs.rmdir(p, options, (err) => err ? reject(err) : resolve());
  }));
  definePromise('rm', (p, options) => new Promise((resolve, reject) => {
    fs.rm(p, options, (err) => err ? reject(err) : resolve());
  }));
  definePromise('stat', (p, options) => new Promise((resolve, reject) => {
    fs.stat(p, options, (err, st) => err ? reject(err) : resolve(st));
  }));
  definePromise('lstat', (p, options) => new Promise((resolve, reject) => {
    fs.lstat(p, options, (err, st) => err ? reject(err) : resolve(st));
  }));
  definePromise('link', (a, b) => new Promise((resolve, reject) => {
    fs.link(a, b, (err) => err ? reject(err) : resolve());
  }));
  definePromise('symlink', (t, p, type) => new Promise((resolve, reject) => {
    fs.symlink(t, p, type, (err) => err ? reject(err) : resolve());
  }));
  definePromise('readlink', (p, options) => new Promise((resolve, reject) => {
    fs.readlink(p, options, (err, s) => err ? reject(err) : resolve(s));
  }));
  definePromise('realpath', (p, options) => new Promise((resolve, reject) => {
    fs.realpath(p, options, (err, s) => err ? reject(err) : resolve(s));
  }));
  definePromise('chmod', (p, mode) => new Promise((resolve, reject) => {
    fs.chmod(p, mode, (err) => err ? reject(err) : resolve());
  }));
  definePromise('chown', (p, uid, gid) => new Promise((resolve, reject) => {
    fs.chown(p, uid, gid, (err) => err ? reject(err) : resolve());
  }));
  definePromise('lchown', (p, uid, gid) => new Promise((resolve, reject) => {
    fs.lchown(p, uid, gid, (err) => err ? reject(err) : resolve());
  }));
  definePromise('utimes', (p, atime, mtime) => new Promise((resolve, reject) => {
    fs.utimes(p, atime, mtime, (err) => err ? reject(err) : resolve());
  }));
  definePromise('lutimes', (p, atime, mtime) => new Promise((resolve, reject) => {
    fs.lutimes(p, atime, mtime, (err) => err ? reject(err) : resolve());
  }));
  definePromise('cp', (src, dest, options) => new Promise((resolve, reject) => {
    fs.cp(src, dest, options, (err) => err ? reject(err) : resolve());
  }));
  definePromise('statfs', (p, options) => new Promise((resolve, reject) => {
    fs.statfs(p, options, (err, s) => err ? reject(err) : resolve(s));
  }));
  // glob returns an async iterable directly (Node's promises API).
  promises.glob = function (patterns, options) {
    const result = fs.glob(patterns, options);
    // fs.glob without callback returns an async iterator; expose it directly.
    if (result && typeof result[Symbol.asyncIterator] === 'function') return result;
    // Sync-shaped fallback: wrap array results.
    return (async function* () {
      const arr = await result;
      if (Array.isArray(arr)) for (const p of arr) yield p;
    })();
  };
  // watch returns an async-iterable watcher in real Node's promises API.
  promises.watch = function (p, options) {
    // Validate `ignore` like real Node (throws on iteration start).
    const ignore = options && options.ignore;
    if (ignore !== undefined) {
      const isValid = typeof ignore === 'string' || ignore instanceof RegExp;
      if (!isValid) {
        const err = errInvalidArgType('options.ignore', ['string', 'RegExp'], ignore);
        return (async function* () { throw err; })();
      }
      if (ignore === '') {
        const err = new TypeError('The "options.ignore" argument must not be empty');
        err.code = 'ERR_INVALID_ARG_VALUE';
        return (async function* () { throw err; })();
      }
    }
    const w = fs.watch(p, options);
    // Attach async iteration yielding { eventType, filename }.
    if (!w[Symbol.asyncIterator]) {
      w[Symbol.asyncIterator] = async function* () {
        const queue = [];
        let resolve;
        const onEvent = (eventType, filename) => {
          if (resolve) { const r = resolve; resolve = null; r({ eventType, filename }); }
          else queue.push({ eventType, filename });
        };
        w.on('change', onEvent);
        try {
          for (;;) {
            if (queue.length) yield queue.shift();
            else yield await new Promise((res) => { resolve = res; });
          }
        } finally {
          w.off('change', onEvent);
        }
      };
    }
    return w;
  };
  // lchmod on Linux: present and rejects with ERR_METHOD_NOT_IMPLEMENTED.
  promises.lchmod = function (p, mode) {
    const err = new Error('Method not implemented');
    err.code = 'ERR_METHOD_NOT_IMPLEMENTED';
    return Promise.reject(err);
  };
  promises.constants = null; // set below after constants are attached
  // FileHandle stays internal: never published on fs or fs.promises.

  fs.promises = promises;
  return fs;
}

// ── 8. Singleton assembly ───────────────────────────────────────────────────
import nodeConstants from './constants.js';

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
  access, accessSync, appendFile, appendFileSync,
  chmod, chmodSync, chown, chownSync,
  close, closeSync, copyFile, copyFileSync, cp, cpSync,
  createReadStream, createWriteStream,
  exists, existsSync,
  fchmod, fchmodSync, fchown, fchownSync, fdatasync, fdatasyncSync,
  fstat, fstatSync, fsync, fsyncSync, ftruncate, ftruncateSync, futimes, futimesSync,
  glob, globSync,
  lchmod, lchmodSync, lchown, lchownSync, link, linkSync,
  lstat, lstatSync, lutimes, lutimesSync,
  mkdir, mkdirSync, mkdtemp, mkdtempSync, mkdtempDisposableSync,
  open, openSync, openAsBlob, opendir, opendirSync,
  read, readSync, readdir, readdirSync, readFile, readFileSync,
  readlink, readlinkSync, readv, readvSync,
  realpath, realpathSync, rename, renameSync, rm, rmSync, rmdir, rmdirSync,
  stat, statSync, statfs, statfsSync,
  symlink, symlinkSync, truncate, truncateSync,
  unlink, unlinkSync, utimes, utimesSync,
  watch, watchFile, unwatchFile,
  write, writeSync, writeFile, writeFileSync, writev, writevSync,
  Dir, ReadStream, WriteStream, FileReadStream, FileWriteStream,
  promises, constants,
} = fs;

// Class/function exports mirroring node:fs (not on the fs singleton object).
export { Stats, Dirent, Utf8Stream, _toUnixTimestamp };
