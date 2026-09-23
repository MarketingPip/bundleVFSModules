// src/fs.js — browser-native port of node:fs (Node v24.20.0 surface).
//
// Dependency-free ESM. The filesystem is an in-memory virtual volume owned by
// this module and published (when a host runtime is present) as
// `globalThis._RUNTIME_.__FS__` — the singleton the runtime reads for cwd
// checks, import.meta resolution and end-of-run FS serialisation
// (`__FS__._vol.toJSON()` + `__FS__.readFileSync(path)`).
//
// The volume is seeded from `globalThis._RUNTIME_.__USER_FILES__`
// (`{ path: contents }`) when present.
//
// Outside a host runtime (parity tests, direct import) the module works
// standalone: no Node builtins are used for the implementation itself.

import * as _constants from './constants.js';
import { Readable, Writable } from './stream.js';
import { EventEmitter } from './events.js';

// ── 1. Runtime bridge (guarded) ──────────────────────────────────────────────
const RT = (typeof globalThis._RUNTIME_ !== 'undefined' && globalThis._RUNTIME_ !== null)
  ? globalThis._RUNTIME_
  : undefined;

function emitFs(...args) {
  if (typeof globalThis.emitMe === 'function') {
    try { globalThis.emitMe('fs', ...args); } catch { /* observability only */ }
  }
}

// ── 2. Browser-safe globals ──────────────────────────────────────────────────
const _Buffer = typeof globalThis.Buffer !== 'undefined' ? globalThis.Buffer : undefined;
const _TextEncoder = typeof globalThis.TextEncoder !== 'undefined' ? globalThis.TextEncoder : undefined;
const _TextDecoder = typeof globalThis.TextDecoder !== 'undefined' ? globalThis.TextDecoder : undefined;

function bytesFromString(s) {
  if (_TextEncoder) return _TextEncoder.prototype.encode.call(new _TextEncoder(), s);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function stringFromBytes(u8) {
  if (_TextDecoder) return _TextDecoder.prototype.decode.call(new _TextDecoder(), u8);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}
function toBuffer(u8) {
  if (_Buffer) return _Buffer.from(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  return u8.slice();
}
function isUint8Array(v) {
  return v instanceof Uint8Array || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(v));
}

// ── 3. Minimal posix path helpers (self-contained; no cross-builtin import) ──
const CHAR_DOT = 46, CHAR_SLASH = 47;
function isAbsolute(p) { return p.length > 0 && p.charCodeAt(0) === CHAR_SLASH; }
function normalizeString(path, allowAboveRoot) {
  let res = '', lastSlash = -1, dots = 0, code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (code === CHAR_SLASH) break;
    else code = CHAR_SLASH;
    if (code === CHAR_SLASH) {
      if (lastSlash === i - 1 || dots === 1) { /* noop */ }
      else if (dots === 2) {
        if (res.length < 2 || res.charCodeAt(res.length - 1) !== CHAR_DOT ||
            res.charCodeAt(res.length - 2) !== CHAR_DOT) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf('/');
            if (lastSlashIndex === -1) { res = ''; }
            else res = res.slice(0, lastSlashIndex);
          } else if (res.length !== 0) res = '';
          if (allowAboveRoot) res += res.length > 0 ? '/..' : '..';
        } else if (allowAboveRoot) res += res.length > 0 ? '/..' : '..';
      } else {
        if (res.length > 0) res += '/' + path.slice(lastSlash + 1, i);
        else res = path.slice(lastSlash + 1, i);
      }
      lastSlash = i; dots = 0;
    } else if (code === CHAR_DOT && dots !== -1) ++dots;
    else dots = -1;
  }
  return res;
}
function normalize(p) {
  if (p.length === 0) return '.';
  const isAbs = isAbsolute(p);
  const trailing = p.charCodeAt(p.length - 1) === CHAR_SLASH;
  let out = normalizeString(p, !isAbs);
  if (out.length === 0) {
    if (isAbs) return '/';
    return trailing ? './' : '.';
  }
  if (trailing) out += '/';
  return isAbs ? '/' + out : out;
}
function join(...parts) {
  if (parts.length === 0) return '.';
  let joined;
  for (const p of parts) {
    if (typeof p !== 'string') throw makeArgTypeError('path', 'string', p);
    if (p.length > 0) joined = joined === undefined ? p : joined + '/' + p;
  }
  if (joined === undefined) return '.';
  return normalize(joined);
}
function defaultCwd() {
  try {
    if (typeof process !== 'undefined' && process && typeof process.cwd === 'function') {
      const c = process.cwd();
      if (typeof c === 'string' && c.length) return c.replace(/\\/g, '/');
    }
  } catch { /* ignore */ }
  if (RT && RT.process && typeof RT.process.cwd === 'function') {
    try { return String(RT.process.cwd()); } catch { /* ignore */ }
  }
  return '/';
}
function resolve(...parts) {
  let resolvedPath = '', resolvedAbsolute = false;
  for (let i = parts.length - 1; i >= 0 && !resolvedAbsolute; i--) {
    const p = parts[i];
    if (typeof p !== 'string') throw makeArgTypeError('path', 'string', p);
    if (p.length === 0) continue;
    resolvedPath = p + '/' + resolvedPath;
    resolvedAbsolute = isAbsolute(p);
  }
  if (!resolvedAbsolute) {
    resolvedPath = defaultCwd() + '/' + resolvedPath;
    resolvedAbsolute = true;
  }
  resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute);
  if (resolvedAbsolute) return '/' + resolvedPath;
  return resolvedPath.length > 0 ? resolvedPath : '.';
}
function dirname(p) {
  if (p.length === 0) return '.';
  const hasRoot = isAbsolute(p);
  let end = -1, matchedSlash = true;
  for (let i = p.length - 1; i >= 1; --i) {
    if (p.charCodeAt(i) === CHAR_SLASH) {
      if (!matchedSlash) { end = i; break; }
    } else matchedSlash = false;
  }
  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) return '//';
  return p.slice(0, end);
}
function basename(p, ext) {
  let start = 0, end = -1, matchedSlash = true;
  if (ext !== undefined && typeof ext !== 'string') throw makeArgTypeError('ext', 'string', ext);
  for (let i = p.length - 1; i >= 0; --i) {
    if (p.charCodeAt(i) === CHAR_SLASH) {
      if (!matchedSlash) { start = i + 1; break; }
    } else if (end === -1) { matchedSlash = false; end = i + 1; }
  }
  if (end === -1) return '';
  let base = p.slice(start, end);
  if (ext && base.endsWith(ext)) base = base.slice(0, base.length - ext.length);
  return base;
}
function relative(from, to) {
  const f = resolve(from), t = resolve(to);
  if (f === t) return '';
  const fParts = f.split('/').filter(Boolean), tParts = t.split('/').filter(Boolean);
  let i = 0;
  while (i < fParts.length && i < tParts.length && fParts[i] === tParts[i]) i++;
  const up = fParts.length - i;
  return [...Array(up).fill('..'), ...tParts.slice(i)].join('/') || '.';
}

// ── 4. Node-style errors ─────────────────────────────────────────────────────
const ERRNO = {
  EPERM: -1, ENOENT: -2, EIO: -5, ENXIO: -6, EAGAIN: -11, EACCES: -13,
  EEXIST: -17, EXDEV: -18, ENOTDIR: -20, EISDIR: -21, EINVAL: -22,
  ENFILE: -23, EMFILE: -24, EFBIG: -27, ENOSPC: -28, EROFS: -30,
  EMLINK: -31, EPIPE: -32, ENAMETOOLONG: -36, ENOSYS: -38, ENOTEMPTY: -39,
  ELOOP: -40, EOVERFLOW: -75, EOPNOTSUPP: -95,
};
const ERRMSG = {
  EPERM: 'operation not permitted', ENOENT: 'no such file or directory',
  EIO: 'input/output error', ENXIO: 'no such device or address',
  EACCES: 'permission denied', EEXIST: 'file already exists',
  EXDEV: 'cross-device link not permitted', ENOTDIR: 'not a directory',
  EISDIR: 'illegal operation on a directory', EINVAL: 'invalid argument',
  ENFILE: 'file table overflow', EMFILE: 'too many open files',
  EFBIG: 'file too large', ENOSPC: 'no space left on device',
  EROFS: 'read-only file system', ENAMETOOLONG: 'file name too long',
  ENOSYS: 'function not implemented', ENOTEMPTY: 'directory not empty',
  ELOOP: 'too many symbolic links encountered', EOPNOTSUPP: 'operation not supported',
};
function fsError(code, syscall, path, detail) {
  const msg = detail || ERRMSG[code] || 'unknown error';
  const err = new Error(`${code}: ${msg}, ${syscall}${path !== undefined ? ` '${path}'` : ''}`);
  err.code = code;
  err.errno = ERRNO[code];
  err.syscall = syscall;
  if (path !== undefined) err.path = path;
  return err;
}
function fsError2(code, syscall, srcPath, destPath) {
  const err = new Error(`${code}: ${ERRMSG[code] || 'unknown error'}, ${syscall} '${srcPath}' -> '${destPath}'`);
  err.code = code;
  err.errno = ERRNO[code];
  err.syscall = syscall;
  return err;
}
const IS_DARWIN = typeof process !== 'undefined' && process && process.platform === 'darwin';
function currentUmask() {
  try {
    if (typeof process !== 'undefined' && process && typeof process.umask === 'function') {
      return process.umask() & 0o777;
    }
  } catch { /* fall through to the default */ }
  return 0o022;
}
// Like the kernel: permission bits requested at creation time are masked
// by the process umask (open(2)/mkdir(2) semantics).
const applyUmask = (mode) => (mode & 0o7777) & ~currentUmask();
function makeArgTypeError(argName, expected, received) {
  let receivedStr;
  if (received === undefined) receivedStr = 'undefined';
  else if (received === null) receivedStr = 'null';
  else if (typeof received === 'object' && received.constructor && received.constructor.name) {
    receivedStr = `an instance of ${received.constructor.name}`;
  } else receivedStr = `type ${typeof received}`;
  const msg = `The "${argName}" argument must be of type ${expected}. Received ${receivedStr}`;
  const err = new TypeError(msg);
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}
function makeArgValueError(argName, reason, received) {
  const err = new TypeError(
    `The argument '${argName}' ${reason}. Received ${JSON.stringify(String(received)).slice(0, 60)}`);
  err.code = 'ERR_INVALID_ARG_VALUE';
  return err;
}
function makeOutOfRangeError(name, range, received) {
  const err = new RangeError(
    `The value of "${name}" is out of range. It must be ${range}. Received ${received}`);
  err.code = 'ERR_OUT_OF_RANGE';
  return err;
}
// Node's rm/cp raise ERR_FS_EISDIR (not EISDIR) for directory mishandling.
function eisdirError(kind, path) {
  let err;
  if (kind === 'rm') {
    err = new Error(`Path is a directory: rm returned EISDIR (is a directory) ${path}`);
    err.errno = ERRNO.EISDIR; err.syscall = 'rm'; err.path = path;
  } else {
    err = new Error(`Recursive option not enabled, cannot copy a directory: ${path}/`);
  }
  err.code = 'ERR_FS_EISDIR';
  return err;
}
function validatedLength(len) {
  if (typeof len !== 'number' || !Number.isInteger(len)) throw makeOutOfRangeError('len', 'an integer', len);
  return Math.max(0, len); // Node clamps negative lengths to 0 (no throw)
}

// ── 5. constants (reuse the constants port; values verified vs node:fs) ──────
// Node's fs.constants has a null prototype and exactly the 56 fs-specific
// keys below (no errno/SSL/signal constants — those live on os.constants).
const _FS_CONSTANT_NAMES = [
  'COPYFILE_EXCL', 'COPYFILE_FICLONE', 'COPYFILE_FICLONE_FORCE', 'F_OK',
  'O_APPEND', 'O_CREAT', 'O_DIRECT', 'O_DIRECTORY', 'O_DSYNC', 'O_EXCL',
  'O_NOATIME', 'O_NOCTTY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_RDONLY', 'O_RDWR',
  'O_SYNC', 'O_TRUNC', 'O_WRONLY', 'R_OK',
  'S_IFBLK', 'S_IFCHR', 'S_IFDIR', 'S_IFIFO', 'S_IFLNK', 'S_IFMT', 'S_IFREG',
  'S_IFSOCK', 'S_IRGRP', 'S_IROTH', 'S_IRUSR', 'S_IRWXG', 'S_IRWXO', 'S_IRWXU',
  'S_IWGRP', 'S_IWOTH', 'S_IWUSR', 'S_IXGRP', 'S_IXOTH', 'S_IXUSR',
  'UV_DIRENT_BLOCK', 'UV_DIRENT_CHAR', 'UV_DIRENT_DIR', 'UV_DIRENT_FIFO',
  'UV_DIRENT_FILE', 'UV_DIRENT_LINK', 'UV_DIRENT_SOCKET', 'UV_DIRENT_UNKNOWN',
  'UV_FS_COPYFILE_EXCL', 'UV_FS_COPYFILE_FICLONE', 'UV_FS_COPYFILE_FICLONE_FORCE',
  'UV_FS_O_FILEMAP', 'UV_FS_SYMLINK_DIR', 'UV_FS_SYMLINK_JUNCTION',
  'W_OK', 'X_OK',
];
const constants = Object.create(null);
for (const k of _FS_CONSTANT_NAMES) {
  if (_constants[k] !== undefined) constants[k] = _constants[k];
}

// ── 6. Path argument handling ────────────────────────────────────────────────
function getValidatedPath(p, propName = 'path') {
  if (typeof p === 'string') {
    if (p.length === 0) throw makeArgValueError(propName, 'must not be empty', p);
    return p;
  }
  if (isUint8Array(p)) return stringFromBytes(p);
  if (typeof URL !== 'undefined' && p instanceof URL) {
    if (p.protocol !== 'file:') throw makeArgValueError(propName, 'must be a file: URL', p);
    return decodeURIComponent(p.pathname);
  }
  throw makeArgTypeError(propName, ['string', 'Buffer', 'URL'], p);
}
function assertEncoding(enc) {
  if (enc === undefined || enc === null || enc === 'buffer') return;
  const ok = (_Buffer && _Buffer.isEncoding(enc)) ||
    ['utf8', 'utf-8', 'utf16le', 'utf-16le', 'latin1', 'binary', 'base64', 'base64url', 'hex', 'ascii', 'ucs2', 'ucs-2'].includes(String(enc).toLowerCase());
  if (!ok) {
    // Node reports a bad encoding name as ERR_INVALID_ARG_VALUE.
    const received = typeof enc === 'string' && enc.length > 128 ? enc.slice(0, 128) + '...' : enc;
    const err = new TypeError(`The argument 'encoding' is invalid encoding. Received '${received}'`);
    err.code = 'ERR_INVALID_ARG_VALUE';
    throw err;
  }
}
function decodeBytes(u8, encoding) {
  if (encoding === undefined || encoding === null || encoding === 'buffer') return toBuffer(u8);
  const enc = String(encoding).toLowerCase();
  if (enc === 'utf8' || enc === 'utf-8') return stringFromBytes(u8);
  if (_Buffer) return _Buffer.from(u8).toString(encoding);
  return stringFromBytes(u8);
}
function encodeData(data, encoding) {
  if (typeof data === 'string') return bytesFromString(data);
  if (isUint8Array(data)) return data.slice ? data.slice() : new Uint8Array(data);
  if (typeof ArrayBuffer !== 'undefined') {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data instanceof DataView) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer) {
      return new Uint8Array(data);
    }
  }
  throw makeArgTypeError('data', ['string', 'Buffer', 'TypedArray', 'DataView'], data);
}

// ── 7. VFS node model ────────────────────────────────────────────────────────
const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;
let nextIno = 1;
function nowMs() { return Date.now(); }

class VNode {
  constructor(kind, mode) {
    this.kind = kind; // 'file' | 'dir' | 'symlink'
    this.ino = nextIno++;
    this.mode = mode;
    this.uid = 0; this.gid = 0; this.nlink = kind === 'dir' ? 2 : 1;
    this.rdev = 0;
    const t = nowMs();
    this.atimeMs = t; this.mtimeMs = t; this.ctimeMs = t; this.birthtimeMs = t;
    if (kind === 'file') this.data = new Uint8Array(0);
    else if (kind === 'dir') this.children = new Map();
    else this.linkpath = '';
  }
}

const MAX_SYMLINKS = 40;

class Volume {
  constructor() {
    this.root = new VNode('dir', S_IFDIR | 0o777);
    this.cwd = defaultCwd();
    this.fdCounter = 100;
    this.fds = new Map();
  }

  // Resolve `p` to { parent, name, node, path }. Follows symlinks unless
  // `noFollowFinal`. Throws Node-style errors with the given syscall name.
  lookup(p, syscall, { noFollowFinal = false } = {}) {
    const abs = resolve(this.cwd, p);
    const parts = abs.split('/').filter(s => s.length > 0);
    let node = this.root, parent = null, name = '', linkCount = 0;
    // Walk `segs` below the volume root, following any symlinks met.
    // A missing final segment resolves to { parent, name, node: undefined }
    // (creation-style); a missing non-final segment throws ENOENT.
    const walk = (segs, trail) => {
      let n = this.root, tr = [], par = null, nm = '';
      for (let j = 0; j < segs.length; j++) {
        const seg = segs[j];
        const isLast = j === segs.length - 1;
        if (n.kind !== 'dir') throw fsError('ENOTDIR', syscall, p);
        const child = n.children.get(seg);
        if (!child) {
          if (isLast) return { parent: n, name: seg, node: undefined, trail: tr };
          throw fsError('ENOENT', syscall, p);
        }
        if (child.kind === 'symlink') {
          return follow(child, segs.slice(j + 1), tr);
        }
        if (!isLast && child.kind !== 'dir') throw fsError('ENOTDIR', syscall, p);
        par = n; nm = seg; n = child; tr.push(seg);
      }
      return { parent: par, name: nm, node: n, trail: tr };
    };
    const follow = (n, fromParts, trail) => {
      // Resolve symlink node `n` (whose containing dir is `trail`), then
      // continue with the remaining path parts below the target.
      while (n.kind === 'symlink') {
        if (++linkCount > MAX_SYMLINKS) throw fsError('ELOOP', syscall, p);
        const target = n.linkpath;
        const base = isAbsolute(target) ? target : '/' + trail.join('/');
        const resolved = normalize(isAbsolute(target) ? target : base + '/' + target);
        const all = resolved.split('/').filter(s => s.length > 0).concat(fromParts);
        const r = walk(all, []);
        if (r.node && r.node.kind === 'symlink') {
          // Defensive: walk() already follows symlinks via follow(),
          // so this only triggers for a symlink returned as a final
          // unresolved node; loop around to resolve it.
          return follow(r.node, [], r.trail);
        }
        return r;
      }
      return { parent: null, name: '', node: n, trail };
    };
    const traversed = [];
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const isLast = i === parts.length - 1;
      if (node.kind !== 'dir') throw fsError('ENOTDIR', syscall, p);
      const child = node.children.get(seg);
      if (!child) {
        if (isLast) return { parent: node, name: seg, node: undefined, path: abs };
        throw fsError('ENOENT', syscall, p);
      }
      if (child.kind === 'symlink' && (!isLast || !noFollowFinal)) {
        // The symlink target walk consumes the remaining path parts.
        const r = follow(child, parts.slice(i + 1), traversed);
        return { parent: r.parent, name: r.name, node: r.node, path: abs };
      }
      if (!isLast && child.kind !== 'dir') throw fsError('ENOTDIR', syscall, p);
      parent = node; name = seg; node = child; traversed.push(seg);
    }
    return { parent, name, node, path: abs };
  }

  statNode(node, bigint) {
    const size = node.kind === 'file' ? node.data.length
      : node.kind === 'symlink' ? bytesFromString(node.linkpath).length : 0;
    const mk = bigint ? (v) => BigInt(v) : (v) => v;
    const st = new Stats();
    st.dev = mk(1); st.ino = mk(node.ino); st.mode = mk(node.mode);
    st.nlink = mk(node.nlink); st.uid = mk(node.uid); st.gid = mk(node.gid);
    st.rdev = mk(node.rdev); st.size = mk(size); st.blksize = mk(4096);
    st.blocks = mk(Math.ceil(size / 512));
    if (bigint) {
      st.atimeNs = BigInt(Math.round(node.atimeMs * 1e6));
      st.mtimeNs = BigInt(Math.round(node.mtimeMs * 1e6));
      st.ctimeNs = BigInt(Math.round(node.ctimeMs * 1e6));
      st.birthtimeNs = BigInt(Math.round(node.birthtimeMs * 1e6));
    }
    st.atimeMs = mk(node.atimeMs); st.mtimeMs = mk(node.mtimeMs);
    st.ctimeMs = mk(node.ctimeMs); st.birthtimeMs = mk(node.birthtimeMs);
    return st;
  }

  mkdirp(abs, mode, syscall, path) {
    const parts = abs.split('/').filter(Boolean);
    let node = this.root;
    for (const seg of parts) {
      let child = node.children.get(seg);
      if (!child) {
        child = new VNode('dir', S_IFDIR | applyUmask(mode));
        node.children.set(seg, child);
        node.mtimeMs = node.ctimeMs = nowMs();
      } else if (child.kind !== 'dir') {
        throw fsError('ENOTDIR', syscall, path);
      }
      node = child;
    }
    return node;
  }

  // Serialisation view for the host runtime: { absPath: contents }.
  toJSON() {
    const out = {};
    const walk = (node, prefix) => {
      for (const [name, child] of node.children) {
        const p = prefix + '/' + name;
        if (child.kind === 'dir') walk(child, p);
        else if (child.kind === 'file') out[p] = toBuffer(child.data);
      }
    };
    walk(this.root, '');
    return out;
  }

  fromJSON(files) {
    for (const p of Object.keys(files)) {
      const abs = isAbsolute(p) ? normalize(p) : '/' + normalize(p);
      const dir = dirname(abs);
      if (dir !== '/') this.mkdirp(dir, 0o777, 'open', p);
      const data = typeof files[p] === 'string' ? bytesFromString(files[p])
        : isUint8Array(files[p]) ? files[p].slice()
        : Array.isArray(files[p]) ? Uint8Array.from(files[p])
        : bytesFromString(String(files[p]));
      const { parent, name, node } = this.lookup(abs, 'open');
      const file = new VNode('file', S_IFREG | 0o666);
      file.data = data;
      if (node) { parent.children.set(name, file); }
      else parent.children.set(name, file);
    }
  }
}

// ── 8. Stats / Dirent / StatFs ───────────────────────────────────────────────
class Stats {
  constructor() {
    // Property order matches Node's Stats: dev,mode,nlink,uid,gid,rdev,
    // blksize,ino,size,blocks,atimeMs,mtimeMs,ctimeMs,birthtimeMs.
    // atime/mtime/ctime/birthtime are prototype getters (not own keys).
    this.dev = 0; this.mode = 0; this.nlink = 0; this.uid = 0; this.gid = 0;
    this.rdev = 0; this.blksize = 4096; this.ino = 0; this.size = 0;
    this.blocks = 0;
    this.atimeMs = 0; this.mtimeMs = 0; this.ctimeMs = 0; this.birthtimeMs = 0;
  }
  _checkModeProperty(property) { return (this.mode & S_IFMT) === property; }
  isDirectory() { return this._checkModeProperty(S_IFDIR); }
  isFile() { return this._checkModeProperty(S_IFREG); }
  isBlockDevice() { return this._checkModeProperty(0o060000); }
  isCharacterDevice() { return this._checkModeProperty(0o020000); }
  isSymbolicLink() { return this._checkModeProperty(S_IFLNK); }
  isFIFO() { return this._checkModeProperty(0o010000); }
  isSocket() { return this._checkModeProperty(0o140000); }
}
// Date views are prototype accessors in Node, not own enumerable keys.
for (const [key, ms] of [['atime', 'atimeMs'], ['mtime', 'mtimeMs'], ['ctime', 'ctimeMs'], ['birthtime', 'birthtimeMs']]) {
  Object.defineProperty(Stats.prototype, key, {
    get() { return new Date(Number(this[ms])); },
    enumerable: false, configurable: true,
  });
}
class Dirent {
  constructor(name, node, parentPath) {
    this.name = name;
    this.parentPath = parentPath;
    // Internal slots are non-enumerable, like Node's Dirent.
    Object.defineProperties(this, {
      _mode: { value: node.mode, enumerable: false, writable: true },
      _kind: { value: node.kind, enumerable: false, writable: true },
    });
  }
  _checkModeProperty(property) { return (this._mode & S_IFMT) === property; }
  isDirectory() { return this._checkModeProperty(S_IFDIR); }
  isFile() { return this._checkModeProperty(S_IFREG); }
  isBlockDevice() { return this._checkModeProperty(0o060000); }
  isCharacterDevice() { return this._checkModeProperty(0o020000); }
  isSymbolicLink() { return this._checkModeProperty(S_IFLNK); }
  isFIFO() { return this._checkModeProperty(0o010000); }
  isSocket() { return this._checkModeProperty(0o140000); }
}
class StatFs {
  constructor() {
    this.type = 0; this.bsize = 4096; this.frsize = 4096; this.blocks = 1024 * 1024;
    this.bfree = 1024 * 1024; this.bavail = 1024 * 1024;
    this.files = 1024 * 1024; this.ffree = 1024 * 1024;
  }
}
class Dir {
  constructor(vol, abs, node) {
    // No own enumerable keys, like Node's Dir (`path` stays readable).
    Object.defineProperties(this, {
      _vol: { value: vol, enumerable: false, writable: true },
      path: { value: abs, enumerable: false, writable: true },
      _entries: { value: [...node.children.keys()].sort(), enumerable: false, writable: true },
      _idx: { value: 0, enumerable: false, writable: true },
      _closed: { value: false, enumerable: false, writable: true },
    });
  }
  _assertOpen() { if (this._closed) throw fsError('EBADF', 'readdir', this.path); }
  readSync() {
    this._assertOpen();
    if (this._idx >= this._entries.length) return null;
    const name = this._entries[this._idx++];
    const node = this._vol.lookup(this.path + '/' + name, 'readdir').node;
    return new Dirent(name, node, this.path);
  }
  async read() { return this.readSync(); }
  closeSync() { this._closed = true; }
  async close() { this.closeSync(); }
  async *[Symbol.asyncIterator]() {
    let d;
    while ((d = this.readSync()) !== null) yield d;
  }
}

// ── 9. Flags, modes, fd table ────────────────────────────────────────────────
function parseFileFlags(flag) {
  if (typeof flag === 'number') {
    const O = constants;
    const f = { read: false, write: false, create: false, exclusive: false, truncate: false, append: false };
    const acc = flag & 3;
    if (acc === O.O_RDONLY) f.read = true;
    else if (acc === O.O_WRONLY) f.write = true;
    else if (acc === O.O_RDWR) { f.read = true; f.write = true; }
    else throw makeArgValueError('flags', 'must be a valid open flag', flag);
    if (flag & O.O_CREAT) f.create = true;
    if (flag & O.O_EXCL) f.exclusive = true;
    if (flag & O.O_TRUNC) f.truncate = true;
    if (flag & O.O_APPEND) f.append = true;
    return f;
  }
  if (typeof flag !== 'string') throw makeArgTypeError('flags', ['string', 'number'], flag);
  const f = { read: false, write: false, create: false, exclusive: false, truncate: false, append: false };
  switch (flag) {
    case 'r': f.read = true; break;
    case 'rs': case 'sr': f.read = true; break;
    case 'r+': case 'rs+': case 'sr+': f.read = true; f.write = true; break;
    case 'w': f.write = true; f.create = true; f.truncate = true; break;
    case 'wx': case 'xw': f.write = true; f.create = true; f.truncate = true; f.exclusive = true; break;
    case 'w+': f.read = true; f.write = true; f.create = true; f.truncate = true; break;
    case 'wx+': case 'xw+': f.read = true; f.write = true; f.create = true; f.truncate = true; f.exclusive = true; break;
    case 'a': f.write = true; f.create = true; f.append = true; break;
    case 'ax': case 'xa': f.write = true; f.create = true; f.append = true; f.exclusive = true; break;
    case 'a+': f.read = true; f.write = true; f.create = true; f.append = true; break;
    case 'ax+': case 'xa+': f.read = true; f.write = true; f.create = true; f.append = true; f.exclusive = true; break;
    default: {
      const err = new TypeError(`Unknown file open flag: '${flag}'`);
      err.code = 'ERR_INVALID_ARG_VALUE';
      throw err;
    }
  }
  return f;
}
function parseMode(mode, def) {
  if (mode === undefined) return def;
  if (typeof mode === 'string') {
    if (!/^[0-7]+$/.test(mode)) throw makeArgValueError('mode', 'must be a valid octal string', mode);
    return parseInt(mode, 8);
  }
  if (typeof mode !== 'number' || !Number.isInteger(mode)) throw makeArgTypeError('mode', ['string', 'integer'], mode);
  return mode;
}
function applyMode(node, mode, syscall, path) {
  const m = parseMode(mode, 0o666);
  node.mode = (node.mode & S_IFMT) | (m & 0o7777);
  node.ctimeMs = nowMs();
}
function toUnixTimestamp(t, name = 'time') {
  if (typeof t === 'number') {
    if (!Number.isFinite(t)) throw makeArgValueError(name, 'must be finite', t);
    return t;
  }
  if (typeof t === 'string') {
    const n = Number(t);
    if (!Number.isFinite(n) || t.trim() === '') throw makeArgValueError(name, 'must be numeric', t);
    return n;
  }
  if (t instanceof Date) return t.getTime() / 1000;
  throw makeArgTypeError(name, ['number', 'string', 'Date'], t);
}
const RANDOM_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randomChars(n) {
  let s = '';
  const rnd = (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues)
    ? globalThis.crypto.getRandomValues(new Uint8Array(n))
    : null;
  for (let i = 0; i < n; i++) {
    const v = rnd ? rnd[i] : Math.floor(Math.random() * 256);
    s += RANDOM_CHARS[v % 62];
  }
  return s;
}

// The API is built per-volume so the singleton owns exactly one volume.
function buildApi(vol) {
  function getFd(fd, syscall) {
    if (typeof fd !== 'number' || !Number.isInteger(fd)) throw makeArgTypeError('fd', 'integer', fd);
    const h = vol.fds.get(fd);
    if (!h) throw fsError('EBADF', syscall, undefined, 'bad file descriptor');
    return h;
  }

  // ── 10. Synchronous API ──────────────────────────────────────────────────
  function accessSync(p, mode = constants.F_OK) {
    const path = getValidatedPath(p);
    if (typeof mode !== 'number' || !Number.isInteger(mode)) throw makeArgTypeError('mode', 'integer', mode);
    const { node } = vol.lookup(path, 'access');
    if (!node) throw fsError('ENOENT', 'access', path);
    if (mode === constants.F_OK) return undefined;
    const m = node.mode;
    if ((mode & constants.R_OK) && !(m & 0o444)) throw fsError('EACCES', 'access', path);
    if ((mode & constants.W_OK) && !(m & 0o222)) throw fsError('EACCES', 'access', path);
    if ((mode & constants.X_OK) && !(m & 0o111)) throw fsError('EACCES', 'access', path);
    return undefined;
  }
  function existsSync(p) {
    try {
      if (typeof p !== 'string' && !isUint8Array(p) && !(typeof URL !== 'undefined' && p instanceof URL)) return false;
      accessSync(p);
      return true;
    } catch { return false; }
  }
  function statSync(p, options) {
    const path = getValidatedPath(p);
    const opts = options || {};
    if (options !== undefined && (typeof options !== 'object' || options === null)) throw makeArgTypeError('options', 'object', options);
    try {
      const { node } = vol.lookup(path, 'stat');
      if (!node) throw fsError('ENOENT', 'stat', path);
      return vol.statNode(node, !!opts.bigint);
    } catch (e) {
      if (e.code === 'ENOENT' && opts.throwIfNoEntry === false) return undefined;
      throw e;
    }
  }
  function lstatSync(p, options) {
    const path = getValidatedPath(p);
    const opts = options || {};
    if (options !== undefined && (typeof options !== 'object' || options === null)) throw makeArgTypeError('options', 'object', options);
    try {
      const { node } = vol.lookup(path, 'lstat', { noFollowFinal: true });
      if (!node) throw fsError('ENOENT', 'lstat', path);
      return vol.statNode(node, !!opts.bigint);
    } catch (e) {
      if (e.code === 'ENOENT' && opts.throwIfNoEntry === false) return undefined;
      throw e;
    }
  }
  function fstatSync(fd, options) {
    const opts = options || {};
    if (options !== undefined && (typeof options !== 'object' || options === null)) throw makeArgTypeError('options', 'object', options);
    return vol.statNode(getFd(fd, 'fstat').node, !!opts.bigint);
  }
  function statfsSync(p) {
    const path = getValidatedPath(p);
    const { node } = vol.lookup(path, 'statfs');
    if (!node) throw fsError('ENOENT', 'statfs', path);
    return new StatFs();
  }

  function readFileSync(p, options) {
    let encoding, flag = 'r';
    if (typeof options === 'string') encoding = options;
    else if (options !== undefined && options !== null) {
      if (typeof options !== 'object') throw makeArgTypeError('options', ['string', 'object'], options);
      encoding = options.encoding; if (options.flag !== undefined) flag = options.flag;
    }
    if (encoding !== undefined && encoding !== null) assertEncoding(encoding);
    let data, node;
    if (typeof p === 'number') {
      const h = getFd(p, 'read');
      if (h.node.kind !== 'file') throw fsError('EISDIR', 'read', h.path);
      if (!h.readable) throw fsError('EBADF', 'read', h.path, 'bad file descriptor');
      data = h.node.data.slice(h.position);
      h.position = h.node.data.length;
      h.node.atimeMs = nowMs();
    } else {
      const path = getValidatedPath(p);
      parseFileFlags(flag); // validate
      const r = vol.lookup(path, 'open');
      node = r.node;
      if (!node) throw fsError('ENOENT', 'open', path);
      if (node.kind === 'dir') throw fsError('EISDIR', 'read', path);
      data = node.data;
      node.atimeMs = nowMs();
    }
    return decodeBytes(data, encoding === undefined ? null : encoding);
  }

  function writeFileSync(file, data, options) {
    let encoding = 'utf8', mode = 0o666, flag = 'w';
    if (typeof options === 'string') encoding = options;
    else if (options !== undefined && options !== null) {
      if (typeof options !== 'object') throw makeArgTypeError('options', ['string', 'object'], options);
      if (options.encoding !== undefined) encoding = options.encoding;
      if (options.mode !== undefined) mode = parseMode(options.mode, 0o666);
      if (options.flag !== undefined) flag = options.flag;
    }
    assertEncoding(encoding);
    let bytes = typeof data === 'string' && encoding && String(encoding).toLowerCase() !== 'utf8' && String(encoding).toLowerCase() !== 'utf-8'
      ? (_Buffer ? _Buffer.from(data, encoding) : bytesFromString(data))
      : encodeData(data, encoding);
    if (typeof file === 'number') {
      const h = getFd(file, 'write');
      if (h.node.kind !== 'file') throw fsError('EISDIR', 'write', h.path);
      if (!h.writable) throw fsError('EBADF', 'write', h.path, 'bad file descriptor');
      if (h.append) h.position = h.node.data.length;
      const need = h.position + bytes.length;
      if (need > h.node.data.length) {
        const nd = new Uint8Array(need);
        nd.set(h.node.data); h.node.data = nd;
      }
      h.node.data.set(bytes, h.position);
      h.position += bytes.length;
      h.node.mtimeMs = h.node.ctimeMs = nowMs();
      return undefined;
    }
    const path = getValidatedPath(file);
    const fl = parseFileFlags(flag);
    const { parent, name, node } = vol.lookup(path, 'open');
    if (node && node.kind === 'dir') throw fsError('EISDIR', 'open', path);
    if (!node) {
      if (!parent) throw fsError('ENOENT', 'open', path);
      const f = new VNode('file', S_IFREG | applyUmask(mode));
      f.data = bytes;
      parent.children.set(name, f);
      parent.mtimeMs = parent.ctimeMs = nowMs();
      return undefined;
    }
    if (fl.exclusive) throw fsError('EEXIST', 'open', path);
    if (!fl.write && !fl.append) throw fsError('EBADF', 'write', path, 'bad file descriptor');
    if (fl.append) {
      const nd = new Uint8Array(node.data.length + bytes.length);
      nd.set(node.data); nd.set(bytes, node.data.length);
      node.data = nd;
    } else if (!fl.truncate && fl.write) {
      // e.g. 'r+': overwrite from position 0, preserving the tail.
      const need = bytes.length;
      if (need > node.data.length) {
        const nd = new Uint8Array(need);
        nd.set(node.data); node.data = nd;
      }
      node.data.set(bytes, 0);
    } else {
      node.data = bytes;
    }
    node.mtimeMs = node.ctimeMs = nowMs();
    return undefined;
  }
  function appendFileSync(file, data, options) {
    let opts = {};
    if (typeof options === 'string') opts = { encoding: options };
    else if (options && typeof options === 'object') opts = { ...options };
    opts.flag = 'a';
    return writeFileSync(file, data, opts);
  }

  function mkdirSync(p, options) {
    const path = getValidatedPath(p);
    let recursive = false, mode = 0o777;
    if (options !== undefined && options !== null) {
      if (typeof options !== 'object') throw makeArgTypeError('options', 'object', options);
      recursive = !!options.recursive;
      if (options.mode !== undefined) mode = parseMode(options.mode, 0o777);
    }
    const abs = resolve(vol.cwd, path);
    if (recursive) {
      let existing = null, lookupErr = null;
      try { existing = vol.lookup(abs, 'mkdir').node; }
      catch (e) { if (e.code !== 'ENOENT') throw e; lookupErr = e; }
      if (existing) {
        if (existing.kind !== 'dir') throw fsError('EEXIST', 'mkdir', path);
        return undefined;
      }
      vol.mkdirp(abs, mode, 'mkdir', path);
      return undefined;
    }
    const { parent, name, node } = vol.lookup(abs, 'mkdir');
    if (node) throw fsError('EEXIST', 'mkdir', path);
    if (!parent) throw fsError('ENOENT', 'mkdir', path);
    const d = new VNode('dir', S_IFDIR | applyUmask(mode));
    parent.children.set(name, d);
    parent.mtimeMs = parent.ctimeMs = nowMs();
    return undefined;
  }
  function mkdtempSync(prefix, options) {
    if (typeof prefix !== 'string') throw makeArgTypeError('prefix', 'string', prefix);
    let encoding;
    if (typeof options === 'string') encoding = options;
    else if (options && typeof options === 'object') encoding = options.encoding;
    if (encoding !== undefined) assertEncoding(encoding);
    for (let i = 0; i < 10; i++) {
      const candidate = prefix + randomChars(6);
      try {
        mkdirSync(candidate, { mode: 0o700 });
        return encoding ? decodeBytes(bytesFromString(candidate), encoding) : candidate;
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    throw fsError('EEXIST', 'mkdtemp', prefix);
  }
  function mkdtempDisposableSync(prefix, options) {
    const path = mkdtempSync(prefix, options);
    const dirPath = typeof path === 'string' ? path : stringFromBytes(path);
    return {
      path,
      [Symbol.dispose]() { rmSync(dirPath, { recursive: true, force: true }); },
      async [Symbol.asyncDispose]() { rmSync(dirPath, { recursive: true, force: true }); },
    };
  }

  function readdirSync(p, options) {
    const path = getValidatedPath(p);
    let encoding = 'utf8', withFileTypes = false, recursive = false;
    if (typeof options === 'string') encoding = options;
    else if (options && typeof options === 'object') {
      if (options.encoding !== undefined) encoding = options.encoding;
      withFileTypes = !!options.withFileTypes;
      recursive = !!options.recursive;
    }
    if (encoding !== undefined && encoding !== null) assertEncoding(encoding);
    const { node } = vol.lookup(path, 'scandir');
    if (!node) throw fsError('ENOENT', 'scandir', path);
    if (node.kind !== 'dir') throw fsError('ENOTDIR', 'scandir', path);
    const out = [];
    if (!recursive) {
      for (const [name, child] of node.children) {
        out.push(withFileTypes ? new Dirent(name, child, path)
          : (encoding === 'buffer' ? toBuffer(bytesFromString(name)) : name));
      }
    } else {
      const walk = (n, prefix) => {
        for (const [name, child] of n.children) {
          const rel = prefix ? prefix + '/' + name : name;
          out.push(withFileTypes ? new Dirent(rel, child, path)
            : (encoding === 'buffer' ? toBuffer(bytesFromString(rel)) : rel));
          if (child.kind === 'dir') walk(child, rel);
        }
      };
      walk(node, '');
    }
    return out;
  }
  function opendirSync(p, options) {
    const path = getValidatedPath(p);
    if (options !== undefined && (typeof options !== 'object' || options === null)) throw makeArgTypeError('options', 'object', options);
    let node, abs;
    try {
      ({ node, path: abs } = vol.lookup(path, 'opendir'));
    } catch (e) {
      // Node's opendir errors carry no `path` property.
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) throw fsError(e.code, 'opendir');
      throw e;
    }
    if (!node) throw fsError('ENOENT', 'opendir');
    if (node.kind !== 'dir') throw fsError('ENOTDIR', 'opendir');
    return new Dir(vol, abs, node);
  }

  function unlinkSync(p) {
    const path = getValidatedPath(p);
    const { parent, name, node } = vol.lookup(path, 'unlink', { noFollowFinal: true });
    if (!node) throw fsError('ENOENT', 'unlink', path);
    if (node.kind === 'dir') throw fsError('EISDIR', 'unlink', path);
    parent.children.delete(name);
    parent.mtimeMs = parent.ctimeMs = nowMs();
  }
  function rmdirSync(p, options) {
    const path = getValidatedPath(p);
    if (options !== undefined && (typeof options !== 'object' || options === null)) throw makeArgTypeError('options', 'object', options);
    const { parent, name, node } = vol.lookup(path, 'rmdir', { noFollowFinal: true });
    if (!node) throw fsError('ENOENT', 'rmdir', path);
    if (node.kind !== 'dir') throw fsError('ENOTDIR', 'rmdir', path);
    if (node.children.size > 0) throw fsError('ENOTEMPTY', 'rmdir', path);
    parent.children.delete(name);
    parent.mtimeMs = parent.ctimeMs = nowMs();
  }
  function rmSync(p, options) {
    const path = getValidatedPath(p);
    const opts = options && typeof options === 'object' ? options : {};
    if (options !== undefined && options !== null && typeof options !== 'object') throw makeArgTypeError('options', 'object', options);
    const recursive = !!opts.recursive, force = !!opts.force;
    let found;
    try { found = vol.lookup(path, 'lstat', { noFollowFinal: true }); }
    catch (e) { if (e.code === 'ENOENT' && force) return undefined; throw e; }
    const { parent, name, node } = found;
    if (!node) { if (force) return undefined; throw fsError('ENOENT', 'rm', path); }
    if (node.kind === 'dir' && !recursive) throw eisdirError('rm', path);
    if (node.kind === 'dir') {
      if (node.children.size > 0 && !recursive) throw fsError('ENOTEMPTY', 'rm', path);
    }
    parent.children.delete(name);
    parent.mtimeMs = parent.ctimeMs = nowMs();
    return undefined;
  }

  function renameSync(oldPath, newPath) {
    const src = getValidatedPath(oldPath, 'oldPath');
    const dest = getValidatedPath(newPath, 'newPath');
    const s = vol.lookup(src, 'rename', { noFollowFinal: true });
    if (!s.node) throw fsError2('ENOENT', 'rename', src, dest);
    const dAbs = resolve(vol.cwd, dest);
    const d = vol.lookup(dAbs, 'rename', { noFollowFinal: true });
    if (!d.parent) throw fsError2('ENOENT', 'rename', src, dest);
    if (s.node.kind === 'dir') {
      // Cannot move a directory into its own subtree.
      if (dAbs === s.path || dAbs.startsWith(s.path + '/')) {
        throw fsError2('EINVAL', 'rename', src, dest);
      }
      if (d.node) {
        if (d.node.kind !== 'dir') throw fsError2('ENOTDIR', 'rename', src, dest);
        if (d.node.children.size > 0) throw fsError2('ENOTEMPTY', 'rename', src, dest);
      }
    } else if (d.node && d.node.kind === 'dir') {
      throw fsError2('EISDIR', 'rename', src, dest);
    }
    s.parent.children.delete(s.name);
    s.parent.mtimeMs = s.parent.ctimeMs = nowMs();
    d.parent.children.set(d.name, s.node);
    d.parent.mtimeMs = d.parent.ctimeMs = nowMs();
    s.node.ctimeMs = nowMs();
    return undefined;
  }

  function copyFileSync(src, dest, mode = 0) {
    const s = getValidatedPath(src, 'src');
    const d = getValidatedPath(dest, 'dest');
    if (typeof mode !== 'number' || !Number.isInteger(mode)) throw makeArgTypeError('mode', 'integer', mode);
    const { node: sNode } = vol.lookup(s, 'copyfile');
    if (!sNode) throw fsError2('ENOENT', 'copyfile', s, d);
    if (sNode.kind === 'dir') throw fsError2('EISDIR', 'copyfile', s, d);
    const dAbs = resolve(vol.cwd, d);
    const { parent, name, node: dNode } = vol.lookup(dAbs, 'copyfile');
    if (!parent) throw fsError2('ENOENT', 'copyfile', s, d);
    if (dNode) {
      if (mode & constants.COPYFILE_EXCL) throw fsError2('EEXIST', 'copyfile', s, d);
      if (dNode.kind === 'dir') throw fsError2('EISDIR', 'copyfile', s, d);
    }
    const f = new VNode('file', (sNode.mode & S_IFMT) | (sNode.mode & 0o7777));
    f.data = sNode.data.slice();
    f.uid = sNode.uid; f.gid = sNode.gid;
    parent.children.set(name, f);
    parent.mtimeMs = parent.ctimeMs = nowMs();
    return undefined;
  }

  function cpSync(src, dest, options) {
    const s = getValidatedPath(src, 'src');
    const d = getValidatedPath(dest, 'dest');
    const opts = options && typeof options === 'object' ? options : {};
    if (options !== undefined && options !== null && typeof options !== 'object') throw makeArgTypeError('options', 'object', options);
    const dereference = !!opts.dereference;
    const errorOnExist = !!opts.errorOnExist;
    const force = opts.force !== undefined ? !!opts.force : true;
    const recursive = !!opts.recursive;
    const preserveTimestamps = !!opts.preserveTimestamps;
    const verbatimSymlinks = !!opts.verbatimSymlinks;
    const filter = opts.filter;
    const { node: sNode } = vol.lookup(s, 'cp', { noFollowFinal: !dereference });
    if (!sNode) throw fsError('ENOENT', 'cp', s);
    if (sNode.kind === 'dir' && !recursive) throw eisdirError('cp', s);
    const copyOne = (sN, sP, dP, dParent, dName) => {
      if (filter && !filter(sP, dP)) return;
      let kind = sN.kind;
      let targetNode = sN;
      if (kind === 'symlink' && dereference) {
        const r = vol.lookup(sP, 'cp');
        if (!r.node) throw fsError('ENOENT', 'cp', sP);
        targetNode = r.node; kind = targetNode.kind;
      }
      const existing = dParent.children.get(dName);
      if (existing) {
        if (errorOnExist) throw fsError('EEXIST', 'cp', dP);
        if (!force) return;
        // Type mismatches between src and dest.
        if (existing.kind === 'dir' && kind !== 'dir') {
          const err = new Error(`[ERR_FS_CP_NON_DIR_TO_DIR]: Cannot overwrite directory '${dP}' with non-directory '${sP}'`);
          err.code = 'ERR_FS_CP_NON_DIR_TO_DIR'; throw err;
        }
        if (existing.kind !== 'dir' && kind === 'dir') {
          const err = new Error(`[ERR_FS_CP_DIR_TO_NON_DIR]: Cannot overwrite non-directory '${dP}' with directory '${sP}'`);
          err.code = 'ERR_FS_CP_DIR_TO_NON_DIR'; throw err;
        }
      }
      if (kind === 'dir') {
        if (!recursive) {
          const err = new Error(`[ERR_FS_CP_DIR_TO_NON_DIR]: ${sP} is a directory (not copied)`);
          err.code = 'ERR_FS_CP_DIR_TO_NON_DIR'; throw err;
        }
        let dNode = existing && existing.kind === 'dir' ? existing : null;
        if (!dNode) {
          dNode = new VNode('dir', S_IFDIR | (sN.mode & 0o7777));
          dParent.children.set(dName, dNode);
        }
        for (const [name, child] of sN.children) copyOne(child, sP + '/' + name, dP + '/' + name, dNode, name);
        if (preserveTimestamps) { dNode.atimeMs = sN.atimeMs; dNode.mtimeMs = sN.mtimeMs; }
        return;
      }
      if (kind === 'symlink' && !dereference) {
        const l = new VNode('symlink', S_IFLNK | 0o777);
        l.linkpath = verbatimSymlinks ? sN.linkpath : sN.linkpath;
        dParent.children.set(dName, l);
        return;
      }
      const f = new VNode('file', S_IFREG | (targetNode.mode & 0o7777));
      f.data = targetNode.data.slice();
      if (preserveTimestamps) { f.atimeMs = targetNode.atimeMs; f.mtimeMs = targetNode.mtimeMs; }
      dParent.children.set(dName, f);
    };
    const dAbs = resolve(vol.cwd, d);
    const { parent, name, node: dNode } = vol.lookup(dAbs, 'cp', { noFollowFinal: true });
    if (!parent) throw fsError('ENOENT', 'cp', d);
    if (sNode.kind === 'dir') {
      copyOne(sNode, s, dAbs, parent, name);
    } else {
      copyOne(sNode, s, dAbs, parent, name);
    }
    parent.mtimeMs = parent.ctimeMs = nowMs();
    return undefined;
  }

  function symlinkSync(target, p, type) {
    if (typeof target !== 'string' && !isUint8Array(target)) throw makeArgTypeError('target', ['string', 'Buffer'], target);
    const path = getValidatedPath(p);
    const t = typeof target === 'string' ? target : stringFromBytes(target);
    if (type !== undefined && type !== null && !['dir', 'file', 'junction'].includes(type)) {
      throw makeArgValueError('type', 'must be one of: dir, file, junction', type);
    }
    const abs = resolve(vol.cwd, path);
    const { parent, name, node } = vol.lookup(abs, 'symlink', { noFollowFinal: true });
    if (node) throw fsError2('EEXIST', 'symlink', t, path);
    if (!parent) throw fsError2('ENOENT', 'symlink', t, path);
    const l = new VNode('symlink', S_IFLNK | 0o777);
    l.linkpath = t;
    parent.children.set(name, l);
    parent.mtimeMs = parent.ctimeMs = nowMs();
    return undefined;
  }
  function readlinkSync(p, options) {
    const path = getValidatedPath(p);
    let encoding = 'utf8';
    if (typeof options === 'string') encoding = options;
    else if (options && typeof options === 'object' && options.encoding !== undefined) encoding = options.encoding;
    if (encoding !== undefined && encoding !== null) assertEncoding(encoding);
    const { node } = vol.lookup(path, 'readlink', { noFollowFinal: true });
    if (!node) throw fsError('ENOENT', 'readlink', path);
    if (node.kind !== 'symlink') throw fsError('EINVAL', 'readlink', path, 'invalid argument');
    const bytes = bytesFromString(node.linkpath);
    return encoding === 'buffer' ? toBuffer(bytes) : decodeBytes(bytes, encoding || 'utf8');
  }
  function realpathSync(p, options) {
    const path = getValidatedPath(p);
    if (options !== undefined && options !== null && typeof options !== 'object' && typeof options !== 'string') {
      throw makeArgTypeError('options', ['string', 'object'], options);
    }
    let encoding = 'utf8';
    if (typeof options === 'string') encoding = options;
    else if (options && typeof options === 'object' && options.encoding !== undefined) encoding = options.encoding;
    if (encoding !== undefined && encoding !== null) assertEncoding(encoding);
    const abs = resolve(vol.cwd, path);
    const parts = abs.split('/').filter(Boolean);
    const SYSCALL = 'lstat';
    let node = vol.root, trail = [], linkCount = 0;
    const expand = (n, rest, tr) => {
      while (n.kind === 'symlink') {
        if (++linkCount > MAX_SYMLINKS) throw fsError('ELOOP', 'realpath', path);
        const target = n.linkpath;
        const base = isAbsolute(target) ? [] : tr.slice();
        const segs = (isAbsolute(target) ? target : '/' + base.join('/') + '/' + target)
          .split('/').filter(Boolean).concat(rest);
        n = vol.root; tr = [];
        for (let i = 0; i < segs.length; i++) {
          const child = n.kind === 'dir' ? n.children.get(segs[i]) : undefined;
          if (!child) throw fsError('ENOENT', SYSCALL, path);
          if (child.kind === 'symlink') { const r = expand(child, segs.slice(i + 1), tr); n = r.n; tr = r.tr; break; }
          if (child.kind !== 'dir' && i !== segs.length - 1) throw fsError('ENOTDIR', SYSCALL, path);
          n = child; tr.push(segs[i]);
        }
        return { n, tr };
      }
      return { n, tr };
    };
    for (let i = 0; i < parts.length; i++) {
      if (node.kind !== 'dir') throw fsError('ENOTDIR', SYSCALL, path);
      const child = node.children.get(parts[i]);
      if (!child) throw fsError('ENOENT', SYSCALL, path);
      if (child.kind === 'symlink') {
        const r = expand(child, parts.slice(i + 1), trail);
        node = r.n; trail = r.tr; break;
      }
      node = child; trail.push(parts[i]);
    }
    const real = '/' + trail.join('/');
    return encoding === 'buffer' ? toBuffer(bytesFromString(real)) : real;
  }
  function linkSync(existingPath, newPath) {
    const src = getValidatedPath(existingPath, 'existingPath');
    const dest = getValidatedPath(newPath, 'newPath');
    const { node: sNode } = vol.lookup(src, 'link');
    if (!sNode) throw fsError2('ENOENT', 'link', src, dest);
    if (sNode.kind === 'dir') throw fsError2('EPERM', 'link', src, dest);
    const dAbs = resolve(vol.cwd, dest);
    const { parent, name, node } = vol.lookup(dAbs, 'link', { noFollowFinal: true });
    if (node) throw fsError2('EEXIST', 'link', src, dest);
    if (!parent) throw fsError2('ENOENT', 'link', src, dest);
    sNode.nlink++;
    parent.children.set(name, sNode);
    parent.mtimeMs = parent.ctimeMs = nowMs();
    return undefined;
  }

  function truncateSync(p, len = 0) {
    len = validatedLength(len);
    const path = getValidatedPath(p);
    const { node } = vol.lookup(path, 'open');
    if (!node) throw fsError('ENOENT', 'open', path);
    if (node.kind === 'dir') throw fsError('EISDIR', 'truncate', path);
    resizeNode(node, len);
    return undefined;
  }
  function ftruncateSync(fd, len = 0) {
    len = validatedLength(len);
    const h = getFd(fd, 'ftruncate');
    if (h.node.kind !== 'file') throw fsError('EINVAL', 'ftruncate', h.path, 'invalid argument');
    if (!h.writable) throw fsError('EBADF', 'ftruncate', h.path, 'bad file descriptor');
    resizeNode(h.node, len);
    return undefined;
  }
  function resizeNode(node, len) {
    if (len === node.data.length) return;
    const nd = new Uint8Array(len);
    nd.set(node.data.subarray(0, Math.min(len, node.data.length)));
    node.data = nd;
    node.mtimeMs = node.ctimeMs = nowMs();
  }

  function chmodSync(p, mode) { const path = getValidatedPath(p); const { node } = vol.lookup(path, 'chmod'); if (!node) throw fsError('ENOENT', 'chmod', path); applyMode(node, mode, 'chmod', path); }
  function lchmodSync(p, mode) { const path = getValidatedPath(p); const { node } = vol.lookup(path, 'lchmod', { noFollowFinal: true }); if (!node) throw fsError('ENOENT', 'lchmod', path); applyMode(node, mode, 'lchmod', path); }
  function fchmodSync(fd, mode) { applyMode(getFd(fd, 'fchmod').node, mode, 'fchmod'); }
  function chownSync(p, uid, gid) {
    const path = getValidatedPath(p);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw makeArgTypeError(uid !== undefined && !Number.isInteger(uid) ? 'uid' : 'gid', 'integer', null);
    const { node } = vol.lookup(path, 'chown');
    if (!node) throw fsError('ENOENT', 'chown', path);
    node.uid = uid >>> 0; node.gid = gid >>> 0; node.ctimeMs = nowMs();
  }
  function lchownSync(p, uid, gid) {
    const path = getValidatedPath(p);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw makeArgTypeError('uid', 'integer', uid);
    const { node } = vol.lookup(path, 'lchown', { noFollowFinal: true });
    if (!node) throw fsError('ENOENT', 'lchown', path);
    node.uid = uid >>> 0; node.gid = gid >>> 0; node.ctimeMs = nowMs();
  }
  function fchownSync(fd, uid, gid) {
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw makeArgTypeError('uid', 'integer', uid);
    const n = getFd(fd, 'fchown').node;
    n.uid = uid >>> 0; n.gid = gid >>> 0; n.ctimeMs = nowMs();
  }
  function setTimes(node, atime, mtime, syscall, path) {
    node.atimeMs = toUnixTimestamp(atime, 'atime') * 1000;
    node.mtimeMs = toUnixTimestamp(mtime, 'mtime') * 1000;
    node.ctimeMs = nowMs();
  }
  function utimesSync(p, atime, mtime) { const path = getValidatedPath(p); const { node } = vol.lookup(path, 'utime'); if (!node) throw fsError('ENOENT', 'utime', path); setTimes(node, atime, mtime, 'utime', path); }
  function lutimesSync(p, atime, mtime) { const path = getValidatedPath(p); const { node } = vol.lookup(path, 'lutime', { noFollowFinal: true }); if (!node) throw fsError('ENOENT', 'lutime', path); setTimes(node, atime, mtime, 'lutime', path); }
  function futimesSync(fd, atime, mtime) { setTimes(getFd(fd, 'futimes').node, atime, mtime, 'utime'); }

  // ── open / read / write / close ──────────────────────────────────────────
  function openSync(p, flags = 'r', mode = 0o666) {
    const path = getValidatedPath(p);
    const fl = parseFileFlags(flags);
    const m = parseMode(mode, 0o666);
    const abs = resolve(vol.cwd, path);
    const { parent, name, node } = vol.lookup(abs, 'open');
    if (!node) {
      if (!fl.create) throw fsError('ENOENT', 'open', path);
      if (!parent) throw fsError('ENOENT', 'open', path);
      const f = new VNode('file', S_IFREG | applyUmask(m));
      parent.children.set(name, f);
      parent.mtimeMs = parent.ctimeMs = nowMs();
      const fd = vol.fdCounter++;
      vol.fds.set(fd, { node: f, path: abs, position: 0, readable: fl.read, writable: fl.write, append: fl.append });
      return fd;
    }
    if (fl.exclusive) throw fsError('EEXIST', 'open', path);
    if (node.kind === 'dir' && (fl.write || fl.truncate || fl.append)) throw fsError('EISDIR', 'open', path);
    if (fl.truncate && node.kind === 'file') {
      if (!fl.write && !fl.read) throw fsError('EACCES', 'open', path);
      resizeNode(node, 0);
    }
    const fd = vol.fdCounter++;
    vol.fds.set(fd, {
      node, path: abs,
      position: fl.append && node.kind === 'file' ? node.data.length : 0,
      readable: fl.read, writable: fl.write, append: fl.append,
    });
    return fd;
  }
  function closeSync(fd) {
    const h = getFd(fd, 'close');
    vol.fds.delete(fd);
    return undefined;
  }
  function checkRw(h, want, syscall) {
    if (want === 'read' && !h.readable) throw fsError('EBADF', syscall, h.path, 'bad file descriptor');
    if (want === 'write' && !h.writable) throw fsError('EBADF', syscall, h.path, 'bad file descriptor');
    if (h.node.kind !== 'file') throw fsError(want === 'read' ? 'EISDIR' : 'EBADF', syscall, h.path, want === 'read' ? 'illegal operation on a directory' : 'bad file descriptor');
  }
  function readSync(fd, bufferOrOptions, offset, length, position) {
    let buffer, off, len, pos;
    if (bufferOrOptions && typeof bufferOrOptions === 'object' && !isUint8Array(bufferOrOptions)) {
      const o = bufferOrOptions;
      buffer = o.buffer; off = o.offset ?? 0; len = o.length ?? (buffer ? buffer.byteLength - off : 0); pos = o.position ?? null;
    } else { buffer = bufferOrOptions; off = offset ?? 0; len = length ?? (buffer ? buffer.byteLength - off : 0); pos = position ?? null; }
    const h = getFd(fd, 'read');
    checkRw(h, 'read', 'read');
    if (!isUint8Array(buffer)) throw makeArgTypeError('buffer', ['Buffer', 'TypedArray', 'DataView'], buffer);
    if (!Number.isInteger(off) || off < 0) throw makeOutOfRangeError('offset', 'an integer >= 0', off);
    if (!Number.isInteger(len) || len < 0) throw makeOutOfRangeError('length', 'an integer >= 0', len);
    if (pos !== null && pos !== undefined && (!Number.isInteger(pos) || pos < 0)) throw makeOutOfRangeError('position', 'an integer >= 0 or null', pos);
    if (off + len > buffer.byteLength) throw makeOutOfRangeError('length', `<= buffer.byteLength - offset`, len);
    const at = (pos === null || pos === undefined) ? h.position : pos;
    const avail = Math.max(0, h.node.data.length - at);
    const n = Math.min(len, avail);
    if (n > 0) buffer.set(h.node.data.subarray(at, at + n), off);
    if (pos === null || pos === undefined) h.position = at + n;
    h.node.atimeMs = nowMs();
    return n;
  }
  function writeSync(fd, bufferOrString, offset, length, position) {
    const h = getFd(fd, 'write');
    checkRw(h, 'write', 'write');
    let bytes, pos;
    if (typeof bufferOrString === 'string') {
      const enc = typeof length === 'string' ? length : (typeof offset === 'string' ? offset : 'utf8');
      bytes = encodeData(bufferOrString, enc);
      pos = typeof offset === 'number' ? offset : (typeof length === 'number' ? length : null);
    } else {
      if (!isUint8Array(bufferOrString)) throw makeArgTypeError('buffer', ['Buffer', 'TypedArray', 'DataView', 'string'], bufferOrString);
      const off = offset ?? 0, len = length ?? (bufferOrString.byteLength - off);
      if (!Number.isInteger(off) || off < 0) throw makeOutOfRangeError('offset', 'an integer >= 0', off);
      if (!Number.isInteger(len) || len < 0) throw makeOutOfRangeError('length', 'an integer >= 0', len);
      if (off + len > bufferOrString.byteLength) throw makeOutOfRangeError('length', '<= buffer.byteLength - offset', len);
      bytes = bufferOrString.slice(off, off + len);
      pos = position ?? null;
    }
    if (pos !== null && pos !== undefined && (!Number.isInteger(pos) || pos < 0)) throw makeOutOfRangeError('position', 'an integer >= 0 or null', pos);
    let at = (pos === null || pos === undefined) ? h.position : pos;
    if (h.append) at = h.node.data.length;
    const need = at + bytes.length;
    if (need > h.node.data.length) {
      const nd = new Uint8Array(need);
      nd.set(h.node.data); h.node.data = nd;
    }
    h.node.data.set(bytes, at);
    if (pos === null || pos === undefined || h.append) h.position = at + bytes.length;
    h.node.mtimeMs = h.node.ctimeMs = nowMs();
    return bytes.length;
  }
  function readvSync(fd, buffers, position) {
    if (!Array.isArray(buffers)) throw makeArgTypeError('buffers', 'Array', buffers);
    let total = 0;
    const pos = position ?? null;
    for (const b of buffers) {
      const n = readSync(fd, b, 0, b.byteLength, pos === null ? null : pos + total);
      total += n;
      if (n < b.byteLength) break;
    }
    return total;
  }
  function writevSync(fd, buffers, position) {
    if (!Array.isArray(buffers)) throw makeArgTypeError('buffers', 'Array', buffers);
    let total = 0;
    const pos = position ?? null;
    for (const b of buffers) {
      const n = writeSync(fd, b, 0, b.byteLength, pos === null ? null : pos + total);
      total += n;
    }
    return total;
  }
  function fsyncSync(fd) { getFd(fd, 'fsync'); return undefined; }
  function fdatasyncSync(fd) { getFd(fd, 'fdatasync'); return undefined; }

  // ── 11. glob ─────────────────────────────────────────────────────────────
  function segmentToRegExp(seg) {
    let re = '';
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i];
      if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else if (c === '[') {
        const j = seg.indexOf(']', i + 1);
        if (j === -1) re += '\\[';
        else { re += seg.slice(i, j + 1); i = j; }
      } else if ('.+^${}()|\\'.includes(c)) re += '\\' + c;
      else re += c;
    }
    return new RegExp('^' + re + '$', 's');
  }
  function sortedChildren(node) {
    return [...node.children].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  function globSync(pattern, options) {
    const patterns = Array.isArray(pattern) ? pattern.slice() : [pattern];
    for (const p of patterns) if (typeof p !== 'string') throw makeArgTypeError('pattern', ['string', 'Array'], p);
    let cwd = vol.cwd, withFileTypes = false, dot = false, exclude = null;
    if (options !== undefined && options !== null) {
      if (typeof options !== 'object') throw makeArgTypeError('options', 'object', options);
      if (options.cwd !== undefined) cwd = resolve(vol.cwd, getValidatedPath(options.cwd, 'cwd'));
      withFileTypes = !!options.withFileTypes;
      dot = !!options.dot;
      if (options.exclude !== undefined) {
        exclude = (Array.isArray(options.exclude) ? options.exclude : [options.exclude]).map((e) => {
          if (typeof e === 'function') return e;
          if (typeof e !== 'string') throw makeArgTypeError('exclude', ['string', 'Array', 'Function'], e);
          return e;
        });
      }
    }
    // The cwd anchor is resolved lazily: absolute patterns anchor at the
    // volume root and never consult it (matching Node, where an absolute
    // pattern does not depend on process.cwd() existing).
    let _cwdNode = null, _cwdResolved = false;
    const getCwdNode = () => {
      if (!_cwdResolved) {
        _cwdResolved = true;
        const { node } = vol.lookup(cwd, 'glob');
        if (!node) throw fsError('ENOENT', 'glob', cwd);
        if (node.kind !== 'dir') throw fsError('ENOTDIR', 'glob', cwd);
        _cwdNode = node;
      }
      return _cwdNode;
    };
    const seen = new Set();
    const out = [];
    const pushMatch = (absolute, relPath, node) => {
      const finalPath = absolute ? '/' + relPath : relPath;
      if (!seen.has(finalPath) && !isExcluded(absolute, relPath)) {
        seen.add(finalPath);
        if (withFileTypes) {
          // Like Node: Dirent.name is the basename, parentPath the dirname.
          const slash = finalPath.lastIndexOf('/');
          const name = slash < 0 ? finalPath : finalPath.slice(slash + 1);
          const parentPath = slash <= 0 ? (absolute ? '/' : '.') : finalPath.slice(0, slash);
          out.push(new Dirent(name, node, parentPath));
        } else {
          out.push(finalPath);
        }
      }
    };
    const isExcluded = (absolute, relPath) => {
      if (!exclude) return false;
      return exclude.some((e) => {
        if (typeof e === 'function') { try { return !!e(absolute ? '/' + relPath : relPath); } catch { return false; } }
        return minimatchOne(e, absolute);
      });
    };
    const matchHere = (absolute, node, parts, idx, relPath) => {
      if (idx >= parts.length) {
        pushMatch(absolute, relPath, node);
        return;
      }
      const seg = parts[idx];
      if (seg === '**') {
        matchHere(absolute, node, parts, idx + 1, relPath);
        if (node.kind === 'dir') {
          for (const [name, child] of sortedChildren(node)) {
            if (!dot && name.startsWith('.')) continue;
            matchHere(absolute, child, parts, idx, relPath ? relPath + '/' + name : name);
          }
        }
        return;
      }
      if (node.kind !== 'dir') return;
      const re = segmentToRegExp(seg);
      for (const [name, child] of sortedChildren(node)) {
        if (!dot && name.startsWith('.')) continue;
        if (re.test(name)) matchHere(absolute, child, parts, idx + 1, relPath ? relPath + '/' + name : name);
      }
    };
    const minimatchOne = (pat, absolute) => {
      const parts = pat.split('/').filter((s) => s.length > 0);
      const base = absolute ? vol.root : getCwdNode();
      const found = [];
      const probe = (node, idx, rp) => {
        if (idx >= parts.length) { found.push(true); return; }
        const seg = parts[idx];
        if (seg === '**') {
          probe(node, idx + 1, rp);
          if (node.kind === 'dir') {
            for (const [name, child] of sortedChildren(node)) probe(child, idx, rp ? rp + '/' + name : name);
          }
          return;
        }
        if (node.kind !== 'dir') return;
        const re = segmentToRegExp(seg);
        for (const [name, child] of sortedChildren(node)) {
          if (re.test(name)) probe(child, idx + 1, rp ? rp + '/' + name : name);
        }
      };
      probe(base, 0, '');
      return found.length > 0;
    };
    for (const pat of patterns) {
      const absolute = isAbsolute(pat);
      const parts = pat.split('/').filter((s) => s.length > 0);
      matchHere(absolute, absolute ? vol.root : getCwdNode(), parts, 0, '');
    }
    return out;
  }

  // ── 12. watch / watchFile ────────────────────────────────────────────────
  class FSWatcher extends EventEmitter {
    constructor(path) { super(); this._path = path; this._closed = false; }
    close() { if (!this._closed) { this._closed = true; this.emit('close'); } }
    ref() { return this; }
    unref() { return this; }
  }
  function watch(p, options, listener) {
    if (typeof options === 'function') { listener = options; options = {}; }
    const path = getValidatedPath(p);
    if (typeof options === 'string') {
      assertEncoding(options);
      options = { encoding: options };
    }
    if (options !== undefined && options !== null && typeof options !== 'object') throw makeArgTypeError('options', 'object', options);
    if (listener !== undefined && typeof listener !== 'function') throw makeArgTypeError('listener', 'function', listener);
    // Validate the path exists (Node throws ENOENT synchronously otherwise).
    const { node } = vol.lookup(path, 'watch');
    if (!node) throw fsError('ENOENT', 'watch', path);
    const w = new FSWatcher(path);
    if (listener) w.on('change', listener);
    // NOTE: in-memory VFS — no OS notification source exists in the browser,
    // so this watcher is a correctly-shaped noop. Use watchFile for polling.
    return w;
  }
  const statWatchers = new Map(); // absPath -> { timer, listeners:Set, prev }
  function watchFile(p, options, listener) {
    if (typeof options === 'function') { listener = options; options = {}; }
    const opts = options && typeof options === 'object' ? options : {};
    if (options !== undefined && options !== null && typeof options !== 'object' && typeof options !== 'function') {
      throw makeArgTypeError('options', 'object', options);
    }
    if (typeof listener !== 'function') throw makeArgTypeError('listener', 'function', listener);
    const path = getValidatedPath(p);
    const abs = resolve(vol.cwd, path);
    const interval = opts.interval !== undefined ? opts.interval : 5007;
    if (!Number.isInteger(interval) || interval < 0) throw makeOutOfRangeError('interval', 'an integer >= 0', interval);
    const bigint = !!opts.bigint;
    let entry = statWatchers.get(abs);
    if (!entry) {
      let prev = null;
      try { prev = vol.statNode(vol.lookup(abs, 'stat').node, bigint); } catch { prev = null; }
      entry = { listeners: new Set(), prev, timer: null };
      entry.timer = setInterval(() => {
        let curr = null;
        try {
          const { node } = vol.lookup(abs, 'stat');
          if (node) curr = vol.statNode(node, bigint);
        } catch { curr = null; }
        const e = statWatchers.get(abs);
        if (!e) return;
        const changed = (a, b) =>
          (a === null) !== (b === null) || (a && b && a.mtimeMs !== b.mtimeMs);
        if (changed(e.prev, curr)) {
          const pPrev = e.prev, pCurr = curr;
          e.prev = curr;
          for (const l of [...e.listeners]) { try { l(pCurr, pPrev); } catch { /* listener errors are swallowed */ } }
        }
      }, interval);
      if (entry.timer.unref) entry.timer.unref();
      statWatchers.set(abs, entry);
    }
    entry.listeners.add(listener);
    return undefined;
  }
  function unwatchFile(p, listener) {
    const path = getValidatedPath(p);
    const abs = resolve(vol.cwd, path);
    const entry = statWatchers.get(abs);
    if (!entry) return undefined;
    if (listener) entry.listeners.delete(listener);
    else entry.listeners.clear();
    if (entry.listeners.size === 0) {
      clearInterval(entry.timer);
      statWatchers.delete(abs);
    }
    return undefined;
  }

  // ── 13. Streams (built on the repo's stream port) ─────────────────────────
  class ReadStreamBase extends Readable {
    constructor(p, options = {}) {
      if (typeof options === 'string') {
        assertEncoding(options);
        options = { encoding: options };
      }
      super({ highWaterMark: options.highWaterMark, autoDestroy: true, emitClose: true });
      if (options.fd !== undefined && options.fd !== null) {
        if (typeof options.fd !== 'number') throw makeArgTypeError('fd', 'number', options.fd);
        this.fd = options.fd; this._ownsFd = false;
        this.path = getFd(options.fd, 'read').path;
      } else {
        this.path = getValidatedPath(p);
        this.fd = null; this._ownsFd = true;
      }
      this._flags = options.flags !== undefined ? options.flags : 'r';
      this._mode = options.mode !== undefined ? parseMode(options.mode, 0o666) : 0o666;
      this._autoClose = options.autoClose !== false;
      this._pos = options.start !== undefined ? options.start : null;
      this._end = options.end !== undefined ? options.end : null;
      if (this._pos !== null && (!Number.isInteger(this._pos) || this._pos < 0)) throw makeOutOfRangeError('start', 'an integer >= 0', this._pos);
      if (this._end !== null && (!Number.isInteger(this._end) || this._end < 0)) throw makeOutOfRangeError('end', 'an integer >= 0', this._end);
      if (options.encoding) this.setEncoding(options.encoding);
    }
    _construct(cb) {
      queueMicrotask(() => {
        try {
          if (this.fd === null) this.fd = openSync(this.path, this._flags, this._mode);
          this.emit('open', this.fd);
          cb();
        } catch (e) { this.emit('error', e); cb(e); }
      });
    }
    _read() {
      queueMicrotask(() => {
        try {
          const h = getFd(this.fd, 'read');
          const at = this._pos !== null ? this._pos : h.position;
          const size = h.node.kind === 'file' ? h.node.data.length : 0;
          const end = this._end !== null ? Math.min(this._end + 1, size) : size;
          if (at >= end) { this.push(null); return; }
          const chunk = h.node.data.subarray(at, Math.min(at + 64 * 1024, end));
          if (this._pos !== null) this._pos += chunk.length; else h.position = at + chunk.length;
          h.node.atimeMs = nowMs();
          this.push(toBuffer(chunk));
        } catch (e) { this.destroy(e); }
      });
    }
    _destroy(err, cb) {
      if (this._autoClose && this._ownsFd && this.fd !== null) {
        try { closeSync(this.fd); } catch { /* ignore */ }
        this.fd = null;
      }
      queueMicrotask(() => { this.emit('close'); cb(err); });
    }
  }
  class WriteStreamBase extends Writable {
    constructor(p, options = {}) {
      if (typeof options === 'string') {
        assertEncoding(options);
        options = { encoding: options };
      }
      super({ highWaterMark: options.highWaterMark, autoDestroy: true, emitClose: true });
      if (options.fd !== undefined && options.fd !== null) {
        if (typeof options.fd !== 'number') throw makeArgTypeError('fd', 'number', options.fd);
        this.fd = options.fd; this._ownsFd = false;
        this.path = getFd(options.fd, 'write').path;
      } else {
        this.path = getValidatedPath(p);
        this.fd = null; this._ownsFd = true;
      }
      this._flags = options.flags !== undefined ? options.flags : 'w';
      this._mode = options.mode !== undefined ? parseMode(options.mode, 0o666) : 0o666;
      this._autoClose = options.autoClose !== false;
      this._pos = options.start !== undefined ? options.start : null;
      if (this._pos !== null && (!Number.isInteger(this._pos) || this._pos < 0)) throw makeOutOfRangeError('start', 'an integer >= 0', this._pos);
    }
    _construct(cb) {
      queueMicrotask(() => {
        try {
          if (this.fd === null) this.fd = openSync(this.path, this._flags, this._mode);
          this.emit('open', this.fd);
          cb();
        } catch (e) { this.emit('error', e); cb(e); }
      });
    }
    _write(chunk, encoding, cb) {
      queueMicrotask(() => {
        try {
          const bytes = typeof chunk === 'string' ? encodeData(chunk, encoding) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          const n = writeSync(this.fd, bytes, 0, bytes.length, this._pos);
          if (this._pos !== null) this._pos += n;
          cb();
        } catch (e) { cb(e); }
      });
    }
    _destroy(err, cb) {
      if (this._autoClose && this._ownsFd && this.fd !== null) {
        try { closeSync(this.fd); } catch { /* ignore */ }
        this.fd = null;
      }
      queueMicrotask(() => { this.emit('close'); cb(err); });
    }
  }
  // Node's fs.ReadStream / fs.WriteStream are callable without `new`.
  function ReadStream(...args) { return new ReadStreamBase(...args); }
  Object.setPrototypeOf(ReadStream, ReadStreamBase);
  ReadStream.prototype = ReadStreamBase.prototype;
  function WriteStream(...args) { return new WriteStreamBase(...args); }
  Object.setPrototypeOf(WriteStream, WriteStreamBase);
  WriteStream.prototype = WriteStreamBase.prototype;
  function createReadStream(p, options) {
    if (options !== undefined && (typeof options !== 'object' || options === null)) throw makeArgTypeError('options', 'object', options);
    return new ReadStreamBase(p, options || {});
  }
  function createWriteStream(p, options) {
    if (options !== undefined && (typeof options !== 'object' || options === null)) throw makeArgTypeError('options', 'object', options);
    return new WriteStreamBase(p, options || {});
  }
  async function openAsBlob(p, options) {
    const path = getValidatedPath(p);
    if (options !== undefined && (typeof options !== 'object' || options === null)) throw makeArgTypeError('options', 'object', options);
    const type = options && options.type !== undefined ? String(options.type) : '';
    const data = readFileSync(path); // Uint8Array/Buffer
    if (typeof globalThis.Blob === 'undefined') {
      const err = new Error('Blob is not available in this environment');
      err.code = 'ERR_NOT_SUPPORTED'; throw err;
    }
    return new globalThis.Blob([data], { type });
  }

  // ── 14. Callback API ─────────────────────────────────────────────────────
  // AbortSignal support: async fs APIs honor an already-aborted `signal`
  // option (callback gets AbortError, promises reject); sync APIs ignore it.
  function makeAbortError() {
    // Node's fs AbortError: name 'AbortError', code 'ABORT_ERR' (string).
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    e.code = 'ABORT_ERR';
    return e;
  }
  function signalOf(args) {
    for (const a of args) {
      if (a && typeof a === 'object' && 'signal' in a) {
        const s = a.signal;
        if (s !== undefined && s !== null && typeof s === 'object' && typeof s.aborted === 'boolean') return s;
      }
    }
    return undefined;
  }
  function throwIfAborted(args) {
    const s = signalOf(args);
    if (s && s.aborted) throw makeAbortError();
  }
  // Node's fs callbacks fire on the threadpool/poll phase — after nextTick.
  // setImmediate gives that timing (so a nextTick(abort) still cancels).
  const scheduleAsync = (typeof setImmediate !== 'undefined')
    ? setImmediate
    : (fn) => setTimeout(fn, 0);
  function toCallback(syncFn, name, passThrough) {
    return function (...args) {
      const cb = args[args.length - 1];
      if (typeof cb !== 'function') throw makeArgTypeError('cb', 'function', cb);
      const syncArgs = args.slice(0, -1);
      let result, err = null;
      try {
        throwIfAborted(syncArgs);
        result = syncFn(...syncArgs);
      }
      catch (e) {
        if (e && typeof e.code === 'string' && e.code.startsWith('ERR_')) throw e; // arg validation: sync throw
        err = e;
      }
      // Emulate async cancellation: the VFS operation completes synchronously,
      // but if the signal is aborted before the callback fires, Node would
      // have cancelled the in-flight operation — report AbortError instead.
      // (Checked when the callback fires, so a synchronous abort() after the
      // call still cancels, matching Node.)
      emitFs(name, ...syncArgs, err ? undefined : result);
      const extra = passThrough ? passThrough(syncArgs, result, err) : [];
      scheduleAsync(() => {
        if (!err) {
          const sig = signalOf(syncArgs);
          if (sig && sig.aborted) err = makeAbortError();
        }
        // Match Node's callback arity: void ops get exactly (err).
        if (err) cb(err);
        else if (extra.length > 0) cb(null, result, ...extra);
        else if (result !== undefined) cb(null, result);
        else cb(null);
      });
    };
  }
  const _readArgs = (syncArgs) => [syncArgs[1]];
  const _writeArgs = (syncArgs) => [syncArgs[1]];
  const cbApi = {
    access: toCallback(accessSync, 'access'),
    appendFile: toCallback(appendFileSync, 'appendFile'),
    chmod: toCallback(chmodSync, 'chmod'),
    chown: toCallback(chownSync, 'chown'),
    close: toCallback(closeSync, 'close'),
    copyFile: toCallback(copyFileSync, 'copyFile'),
    cp: toCallback(cpSync, 'cp'),
    fchmod: toCallback(fchmodSync, 'fchmod'),
    fchown: toCallback(fchownSync, 'fchown'),
    fdatasync: toCallback(fdatasyncSync, 'fdatasync'),
    fstat: toCallback(fstatSync, 'fstat'),
    fsync: toCallback(fsyncSync, 'fsync'),
    ftruncate: toCallback(ftruncateSync, 'ftruncate'),
    futimes: toCallback(futimesSync, 'futimes'),
    glob: toCallback(globSync, 'glob'),
    lchmod: toCallback(lchmodSync, 'lchmod'),
    lchown: toCallback(lchownSync, 'lchown'),
    link: toCallback(linkSync, 'link'),
    lstat: toCallback(lstatSync, 'lstat'),
    lutimes: toCallback(lutimesSync, 'lutimes'),
    mkdir: toCallback(mkdirSync, 'mkdir'),
    mkdtemp: toCallback(mkdtempSync, 'mkdtemp'),
    open: toCallback(openSync, 'open'),
    opendir: toCallback(opendirSync, 'opendir'),
    readdir: toCallback(readdirSync, 'readdir'),
    readFile: toCallback(readFileSync, 'readFile'),
    readlink: toCallback(readlinkSync, 'readlink'),
    realpath: toCallback(realpathSync, 'realpath'),
    rename: toCallback(renameSync, 'rename'),
    rm: toCallback(rmSync, 'rm'),
    rmdir: toCallback(rmdirSync, 'rmdir'),
    stat: toCallback(statSync, 'stat'),
    statfs: toCallback(statfsSync, 'statfs'),
    symlink: toCallback(symlinkSync, 'symlink'),
    truncate: toCallback(truncateSync, 'truncate'),
    unlink: toCallback(unlinkSync, 'unlink'),
    utimes: toCallback(utimesSync, 'utimes'),
    writeFile: toCallback(writeFileSync, 'writeFile'),
    read: toCallback(readSync, 'read', _readArgs),
    write: toCallback(writeSync, 'write', _writeArgs),
    readv: toCallback(readvSync, 'readv', _readArgs),
    writev: toCallback(writevSync, 'writev', _writeArgs),
  };
  // lchmod exists only on macOS in Node (undefined on Linux/Windows).
  // Mirror that: leave the properties present-but-undefined off darwin.
  if (!IS_DARWIN) {
    cbApi.lchmod = undefined;
  }
  cbApi.realpath.native = cbApi.realpath;
  function exists(p, callback) {
    if (typeof callback !== 'function') throw makeArgTypeError('callback', 'function', callback);
    queueMicrotask(() => callback(existsSync(p)));
  }

  // Async-iterator file watcher. Node returns a native async-iterator object
  // (no own enumerable keys). This VFS has no OS notification source, so the
  // honest noop is an iterator that completes immediately: watching yields
  // no events. Use watchFile for polling instead.
  class WatchAsyncIterator {
    constructor(path) { this._path = path; this._error = null; }
    [Symbol.asyncIterator]() { return this; }
    next() {
      if (this._error) return Promise.reject(this._error);
      return Promise.resolve({ done: true, value: undefined });
    }
    return() { return Promise.resolve({ done: true, value: undefined }); }
    throw(err) { return Promise.reject(err); }
  }
  const newWatchIterator = (path) => {
    const it = new WatchAsyncIterator(path);
    try {
      const { node } = vol.lookup(path, 'watch');
      if (!node) throw fsError('ENOENT', 'watch', path);
    } catch (e) { it._error = e; }
    return it;
  };

  // ── 15. promises API + FileHandle ────────────────────────────────────────
  // fsPromises.readFile/writeFile/appendFile accept a FileHandle; unwrap to fd.
  function unwrapHandle(f) {
    if (typeof FileHandle !== 'undefined' && f instanceof FileHandle) {
      if (f._closed) throw fsError('EBADF', 'filehandle', f._path, 'file closed');
      return f._fd;
    }
    return f;
  }
  class FileHandle {
    constructor(fd, path) {
      this._fd = fd; this._path = path; this._closed = false;
    }
    get fd() { return this._fd; }
    _assertOpen(op) {
      if (this._closed) throw fsError('EBADF', op || 'filehandle', this._path, 'file closed');
    }
    async appendFile(data, options) { throwIfAborted([options]); this._assertOpen('appendFile'); return appendFileSync(this._fd, data, options); }
    async chmod(mode) { this._assertOpen('chmod'); return fchmodSync(this._fd, mode); }
    async chown(uid, gid) { this._assertOpen('chown'); return fchownSync(this._fd, uid, gid); }
    async close() { if (!this._closed) { this._closed = true; closeSync(this._fd); } }
    async datasync() { this._assertOpen('datasync'); return fdatasyncSync(this._fd); }
    async sync() { this._assertOpen('sync'); return fsyncSync(this._fd); }
    async stat(options) { this._assertOpen('stat'); return fstatSync(this._fd, options); }
    async statfs() { this._assertOpen('statfs'); return statfsSync(this._path); }
    async truncate(len) { this._assertOpen('truncate'); return ftruncateSync(this._fd, len); }
    async utimes(atime, mtime) { this._assertOpen('utimes'); return futimesSync(this._fd, atime, mtime); }
    async read(buffer, offset, length, position) {
      this._assertOpen('read');
      if (buffer === undefined || buffer === null) {
        // Node allocates a fresh buffer when none is given.
        buffer = _Buffer ? _Buffer.alloc(16384) : new Uint8Array(16384);
      }
      const bytesRead = readSync(this._fd, buffer, offset, length, position);
      return { bytesRead, buffer };
    }
    async readv(buffers, position) {
      this._assertOpen('readv');
      const bytesRead = readvSync(this._fd, buffers, position);
      return { bytesRead, buffers };
    }
    async write(buffer, offset, length, position) {
      this._assertOpen('write');
      const bytesWritten = writeSync(this._fd, buffer, offset, length, position);
      return { bytesWritten, buffer };
    }
    async writev(buffers, position) {
      this._assertOpen('writev');
      const bytesWritten = writevSync(this._fd, buffers, position);
      return { bytesWritten, buffers };
    }
    async readFile(options) { throwIfAborted([options]); this._assertOpen('readFile'); return readFileSync(this._fd, options); }
    async writeFile(data, options) { throwIfAborted([options]); this._assertOpen('writeFile'); return writeFileSync(this._fd, data, options); }
    createReadStream(options) { this._assertOpen('createReadStream'); return new ReadStreamBase(this._path, { ...(options || {}), fd: this._fd }); }
    createWriteStream(options) { this._assertOpen('createWriteStream'); return new WriteStreamBase(this._path, { ...(options || {}), fd: this._fd }); }
    readableWebStream(options) {
      this._assertOpen('readableWebStream');
      const handle = this;
      let pos = 0;
      return new ReadableStream({
        async pull(controller) {
          const buf = new Uint8Array(64 * 1024);
          const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
          if (bytesRead === 0) { controller.close(); return; }
          pos += bytesRead;
          controller.enqueue(buf.slice(0, bytesRead));
        },
        async cancel() { /* no-op */ },
      });
    }
    async *readLines(options) {
      this._assertOpen('readLines');
      const data = await this.readFile('utf8');
      const lines = data.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i === lines.length - 1 && lines[i] === '') break;
        yield lines[i].replace(/\r$/, '');
      }
    }
    [Symbol.asyncIterator]() { return this.readLines(); }
  }
  const promisesApi = {
    access: async (p, mode) => accessSync(p, mode),
    appendFile: async (f, d, o) => appendFileSync(unwrapHandle(f), d, o),
    chmod: async (p, m) => chmodSync(p, m),
    chown: async (p, u, g) => chownSync(p, u, g),
    copyFile: async (s, d, m) => copyFileSync(s, d, m),
    cp: async (s, d, o) => cpSync(s, d, o),
    glob: async (pat, o) => globSync(pat, o),
    lchmod: async (p, m) => lchmodSync(p, m),
    lchown: async (p, u, g) => lchownSync(p, u, g),
    link: async (e, n) => linkSync(e, n),
    lstat: async (p, o) => lstatSync(p, o),
    lutimes: async (p, a, m) => lutimesSync(p, a, m),
    mkdir: async (p, o) => mkdirSync(p, o),
    mkdtemp: async (prefix, o) => mkdtempSync(prefix, o),
    mkdtempDisposable: async (prefix, o) => mkdtempDisposableSync(prefix, o),
    open: async (p, flags, mode) => new FileHandle(openSync(p, flags, mode), resolve(vol.cwd, getValidatedPath(p))),
    opendir: async (p, o) => opendirSync(p, o),
    readdir: async (p, o) => readdirSync(p, o),
    readFile: async (p, o) => readFileSync(unwrapHandle(p), o),
    readlink: async (p, o) => readlinkSync(p, o),
    realpath: async (p, o) => realpathSync(p, o),
    rename: async (o, n) => renameSync(o, n),
    rm: async (p, o) => rmSync(p, o),
    rmdir: async (p, o) => rmdirSync(p, o),
    stat: async (p, o) => statSync(p, o),
    statfs: async (p, o) => statfsSync(p, o),
    symlink: async (t, p, ty) => symlinkSync(t, p, ty),
    truncate: async (p, l) => truncateSync(p, l),
    unlink: async (p) => unlinkSync(p),
    utimes: async (p, a, m) => utimesSync(p, a, m),
    writeFile: async (f, d, o) => writeFileSync(unwrapHandle(f), d, o),
    watch: (p, o) => newWatchIterator(getValidatedPath(p)),
  };
  promisesApi.constants = constants;
  // Async fs APIs honor an already-aborted `signal` option (reject AbortError).
  // A signal aborted after the call but before the promise settles also
  // rejects: the VFS operation itself is synchronous, so this emulates the
  // cancellation Node would have performed on the in-flight operation.
  for (const k of Object.keys(promisesApi)) {
    const fn = promisesApi[k];
    if (typeof fn === 'function' && k !== 'watch') {
      promisesApi[k] = async (...args) => {
        throwIfAborted(args);
        const result = await fn(...args);
        throwIfAborted(args);
        return result;
      };
    }
  }

  // ── 16. Assemble the fs-like object ──────────────────────────────────────
  const api = {
    ...cbApi,
    exists,
    accessSync, appendFileSync, chmodSync, chownSync, closeSync,
    copyFileSync, cpSync, existsSync, fchmodSync, fchownSync,
    fdatasyncSync, fstatSync, fsyncSync, ftruncateSync, futimesSync,
    globSync, lchmodSync, lchownSync, linkSync, lstatSync, lutimesSync,
    mkdirSync, mkdtempSync, mkdtempDisposableSync, openSync, opendirSync,
    readdirSync, readFileSync, readlinkSync, realpathSync, renameSync,
    rmSync, rmdirSync, statSync, statfsSync, symlinkSync, truncateSync,
    unlinkSync, utimesSync, writeFileSync, readSync, writeSync,
    readvSync, writevSync,
    watch, watchFile, unwatchFile,
    createReadStream, createWriteStream, openAsBlob,
    ReadStream, WriteStream,
    FileReadStream: ReadStream, FileWriteStream: WriteStream,
    Utf8Stream: ReadStream,
    Stats, Dirent, Dir,
    constants,
    promises: promisesApi,
    _toUnixTimestamp: (t) => toUnixTimestamp(t),
    _vol: vol,
  };
  api.realpathSync.native = realpathSync;
  if (!IS_DARWIN) {
    api.lchmodSync = undefined;
    api.promises.lchmod = undefined;
  }
  // Deprecated lazy getters (DEP0176): fs.F_OK etc. — getter-only, so
  // assignment throws TypeError in strict mode, matching Node. The warning
  // fires only once per process (Node dedupes by code).
  let _dep0176Warned = false;
  for (const k of ['F_OK', 'R_OK', 'W_OK', 'X_OK']) {
    Object.defineProperty(api, k, {
      get() {
        if (!_dep0176Warned) {
          _dep0176Warned = true;
          if (typeof process !== 'undefined' && process && typeof process.emitWarning === 'function') {
            try { process.emitWarning(`fs.${k} is deprecated, use fs.constants.${k} instead`, 'DeprecationWarning', 'DEP0176'); } catch { /* ignore */ }
          }
        }
        return constants[k];
      },
      enumerable: false,
      configurable: true,
    });
  }
  return api;
}

// ── 17. Singleton + host-runtime publishing ────────────────────────────────
let _standalone = null;
// Under the official parity harness (PARITY_TARGET=fs), test files address
// Node's scratch dir (parity/node-test/.tmp.N) through the shim, while
// test/common creates it on the real fs. Mirror that empty scratch dir in
// the VFS so tmpdir-based tests see the initial state they expect. This is
// strictly a test-harness affordance: it never activates in the browser
// (where PARITY_TARGET is unset) and performs no native delegation.
function seedParityTmpdir(vol) {
  try {
    const env = (typeof process !== 'undefined' && process && process.env) || {};
    if (env.PARITY_TARGET !== 'fs') return;
    const here = (typeof import.meta !== 'undefined' && import.meta.url) || '';
    if (!here.startsWith('file:')) return;
    const id = env.TEST_THREAD_ID || env.TEST_SERIAL_ID || '0';
    const tmpPath = decodeURIComponent(new URL('../parity/node-test/.tmp.' + id, here).pathname);
    vol.mkdirp(tmpPath, 0o777, 'mkdir', tmpPath);
  } catch { /* best effort; parity still reports real failures */ }
}
function getFs() {
  const rt = (typeof globalThis._RUNTIME_ !== 'undefined' && globalThis._RUNTIME_ !== null)
    ? globalThis._RUNTIME_
    : undefined;
  if (rt) {
    if (!rt.__FS__) {
      const vol = new Volume();
      const seeds = rt.__USER_FILES__;
      if (seeds && typeof seeds === 'object') {
        try { vol.fromJSON(seeds); } catch { /* bad seed data must not break boot */ }
      }
      rt.__FS__ = buildApi(vol);
    }
    return rt.__FS__;
  }
  if (!_standalone) {
    const vol = new Volume();
    seedParityTmpdir(vol);
    _standalone = buildApi(vol);
  }
  return _standalone;
}

const _fs = getFs();

// ── 18. Exports (mirror node:fs public surface) ─────────────────────────────
// The classes and constants below are declared at module scope and are the
// canonical objects also installed on the api; export them directly.
export { Stats, Dirent, Dir, constants };
export const {
  access, appendFile, chmod, chown, close, copyFile, cp, exists,
  fchmod, fchown, fdatasync, fstat, fsync, ftruncate, futimes,
  glob, lchmod, lchown, link, lstat, lutimes, mkdir, mkdtemp,
  open, opendir, readdir, readFile, readlink, realpath, rename,
  rm, rmdir, stat, statfs, symlink, truncate, unlink, utimes,
  writeFile, read, write, readv, writev,
  accessSync, appendFileSync, chmodSync, chownSync, closeSync,
  copyFileSync, cpSync, existsSync, fchmodSync, fchownSync,
  fdatasyncSync, fstatSync, fsyncSync, ftruncateSync, futimesSync,
  globSync, lchmodSync, lchownSync, linkSync, lstatSync, lutimesSync,
  mkdirSync, mkdtempSync, mkdtempDisposableSync, openSync, opendirSync,
  readdirSync, readFileSync, readlinkSync, realpathSync, renameSync,
  rmSync, rmdirSync, statSync, statfsSync, symlinkSync, truncateSync,
  unlinkSync, utimesSync, writeFileSync, readSync, writeSync,
  readvSync, writevSync,
  watch, watchFile, unwatchFile,
  createReadStream, createWriteStream, openAsBlob,
  ReadStream, WriteStream, FileReadStream, FileWriteStream, Utf8Stream,
  promises,
  _toUnixTimestamp,
} = _fs;

export default _fs;
