// Shared fs internals (Node lib/internal/fs/utils.js): the argument
// validators, Stats/Dirent classes, and flag parsing the shim and the
// parity `internal/fs/utils` adapter both build on.
//
// These live here — NOT as named exports of src/fs.js — because
// tests/export_surface_fs.test.js asserts src/fs.js's export surface
// equals real node:fs exactly, and none of these names are on it
// (BigIntStats, DirentFromStats, stringToFlags, and the validators are
// internal/fs/utils surface, not node:fs surface). src/fs.js imports what
// it uses; the parity adapter imports the rest directly from here.
//
// Everything below is moved verbatim from src/fs.js (same Node v24.20.0
// ports, same comments) — no behavior change, only location.
import nodeConstants from "../constants.js";

// ── Node v24-exact ERR_INVALID_ARG_TYPE builder ───────────────────────────
// Mirrors lib/internal/errors.js determineSpecificType + the type/instance
// list formatting: kTypes entries ('number', 'Object', 'Function', …) are
// lowercased to "of type X"; ClassName entries use "an instance of X";
// functions render as `function ${name}` (not `type function (...)`).
function _fmtTypeList(list, orWord) {
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} ${orWord} ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, ${orWord} ${list[list.length - 1]}`;
}
function _specificType(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "function") return `function ${value.name || ""}`;
  if (t === "object") {
    if (value.constructor && "name" in value.constructor)
      return `an instance of ${value.constructor.name}`;
    return "an instance of Object";
  }
  if (t === "bigint") return `type bigint (${value}n)`;
  if (t === "number") {
    if (Object.is(value, -0)) return "type number (-0)";
    if (Number.isNaN(value)) return "type number (NaN)";
    if (value === Infinity) return "type number (Infinity)";
    if (value === -Infinity) return "type number (-Infinity)";
    return `type number (${value})`;
  }
  if (t === "boolean") return `type boolean (${value})`;
  if (t === "symbol") return `type symbol (${String(value)})`;
  // string
  let s = value;
  if (s.length > 28) s = `${s.slice(0, 25)}...`;
  if (!s.includes("'")) return `type string ('${s}')`;
  return `type string (${JSON.stringify(s)})`;
}
export function errArgType(name, expected, received) {
  const list = Array.isArray(expected) ? expected : [expected];
  const types = [];
  const instances = [];
  for (const e of list) {
    if (/^[A-Z][a-zA-Z0-9]*$/.test(e)) instances.push(e);
    else types.push(e.toLowerCase());
  }
  const kind = name.includes(".") ? "property" : "argument";
  let msg = `The "${name}" ${kind} must be `;
  const parts = [];
  if (types.length > 0)
    parts.push(
      `${types.length > 1 ? "one of type" : "of type"} ${_fmtTypeList(types, "or")}`,
    );
  if (instances.length > 0)
    parts.push(`an instance of ${_fmtTypeList(instances, "or")}`);
  msg += parts.join(" or ");
  msg += `. Received ${_specificType(received)}`;
  const err = new TypeError(msg);
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
}

// Node's addNumericalSeparator for ERR_OUT_OF_RANGE received values.
function _numSep(s) {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}
function _outOfRangeReceived(value) {
  if (typeof value === "bigint") {
    const neg = value < 0;
    let s = String(neg ? -value : value);
    if (value > 2n ** 32n || value < -(2n ** 32n)) s = _numSep(s);
    return (neg ? "-" : "") + s + "n";
  }
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    if (Number.isInteger(value) && Math.abs(value) > 2 ** 32)
      return _numSep(String(value));
    return String(value);
  }
  return _specificType(value);
}
export function errOutOfRangeFmt(name, expected, received) {
  const err = new RangeError(
    `The value of "${name}" is out of range. It must be ${expected}. Received ${_outOfRangeReceived(received)}`,
  );
  err.code = "ERR_OUT_OF_RANGE";
  return err;
}

// Mirrors Node's internal validateInteger (default max = MAX_SAFE_INTEGER).
export function validateInteger(
  value,
  name,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
) {
  if (typeof value !== "number") throw errArgType(name, "number", value);
  if (!Number.isInteger(value))
    throw errOutOfRangeFmt(name, "an integer", value);
  if (value < min || value > max)
    throw errOutOfRangeFmt(name, `>= ${min} && <= ${max}`, value);
  return value;
}

// Mirrors lib/internal/fs/utils.js validateOffsetLengthRead.
export function validateOffsetLengthRead(offset, length, bufferLength) {
  if (offset < 0) throw errOutOfRangeFmt("offset", ">= 0", offset);
  if (length < 0) throw errOutOfRangeFmt("length", ">= 0", length);
  if (offset + length > bufferLength)
    throw errOutOfRangeFmt("length", `<= ${bufferLength - offset}`, length);
}

// Mirrors lib/internal/fs/utils.js validateOffsetLengthWrite.
export function validateOffsetLengthWrite(offset, length, byteLength) {
  if (offset > byteLength)
    throw errOutOfRangeFmt("offset", `<= ${byteLength}`, offset);
  if (length > byteLength - offset)
    throw errOutOfRangeFmt("length", `<= ${byteLength - offset}`, length);
  if (length < 0) throw errOutOfRangeFmt("length", ">= 0", length);
  // validateInt32(length, 'length', 0): integer and <= 2^31-1.
  validateInteger(length, "length", 0, 2147483647);
}

// Mirrors lib/internal/fs/utils.js stringToFlags. O_* values come from the
// same constants table fs.constants is built from, so the open-flags test's
// strictEqual against fs.constants holds by construction.
export function stringToFlags(flags, name = "flags") {
  if (typeof flags === "number") {
    validateInteger(flags, name, -2147483648, 2147483647);
    // Coerce -0 to +0.
    return flags + 0;
  }
  if (flags == null) return nodeConstants.O_RDONLY;
  switch (flags) {
    case "r":
      return nodeConstants.O_RDONLY;
    case "rs":
    case "sr":
      return nodeConstants.O_RDONLY | nodeConstants.O_SYNC;
    case "r+":
      return nodeConstants.O_RDWR;
    case "rs+":
    case "sr+":
      return nodeConstants.O_RDWR | nodeConstants.O_SYNC;
    case "w":
      return (
        nodeConstants.O_TRUNC | nodeConstants.O_CREAT | nodeConstants.O_WRONLY
      );
    case "wx":
    case "xw":
      return (
        nodeConstants.O_TRUNC |
        nodeConstants.O_CREAT |
        nodeConstants.O_WRONLY |
        nodeConstants.O_EXCL
      );
    case "w+":
      return (
        nodeConstants.O_TRUNC | nodeConstants.O_CREAT | nodeConstants.O_RDWR
      );
    case "wx+":
    case "xw+":
      return (
        nodeConstants.O_TRUNC |
        nodeConstants.O_CREAT |
        nodeConstants.O_RDWR |
        nodeConstants.O_EXCL
      );
    case "a":
      return (
        nodeConstants.O_APPEND | nodeConstants.O_CREAT | nodeConstants.O_WRONLY
      );
    case "ax":
    case "xa":
      return (
        nodeConstants.O_APPEND |
        nodeConstants.O_CREAT |
        nodeConstants.O_WRONLY |
        nodeConstants.O_EXCL
      );
    case "a+":
      return (
        nodeConstants.O_APPEND | nodeConstants.O_CREAT | nodeConstants.O_RDWR
      );
    case "ax+":
    case "xa+":
      return (
        nodeConstants.O_APPEND |
        nodeConstants.O_CREAT |
        nodeConstants.O_RDWR |
        nodeConstants.O_EXCL
      );
    case "as":
    case "sa":
      return (
        nodeConstants.O_APPEND |
        nodeConstants.O_CREAT |
        nodeConstants.O_WRONLY |
        nodeConstants.O_SYNC
      );
    case "as+":
    case "sa+":
      return (
        nodeConstants.O_APPEND |
        nodeConstants.O_CREAT |
        nodeConstants.O_RDWR |
        nodeConstants.O_SYNC
      );
  }
  // Node's ERR_INVALID_ARG_VALUE: `The argument 'flags' is invalid.
  // Received 'rw'`. Only code + name are asserted by the open-flags test;
  // the received rendering below matches Node for strings, booleans,
  // numbers, null, and plain objects (ponytail: full util.inspect
  // fidelity is out of scope).
  const received =
    typeof flags === "string"
      ? `'${flags.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
      : flags !== null && typeof flags === "object"
        ? (() => {
            try {
              return JSON.stringify(flags) ?? String(flags);
            } catch {
              return String(flags);
            }
          })()
        : String(flags);
  const err = new TypeError(
    `The argument '${name}' is invalid. Received ${received}`,
  );
  err.code = "ERR_INVALID_ARG_VALUE";
  throw err;
}

export const S_IFMT = 0o170000,
  S_IFREG = 0o100000,
  S_IFDIR = 0o040000,
  S_IFLNK = 0o120000,
  S_IFBLK = 0o060000,
  S_IFCHR = 0o020000,
  S_IFIFO = 0o010000,
  S_IFSOCK = 0o140000;

// UV_DIRENT_* type constants (stable ABI, mirror src/constants.js).
export const UV_DIRENT_UNKNOWN = 0,
  UV_DIRENT_FILE = 1,
  UV_DIRENT_DIR = 2,
  UV_DIRENT_LINK = 3,
  UV_DIRENT_FIFO = 4,
  UV_DIRENT_SOCKET = 5,
  UV_DIRENT_CHAR = 6,
  UV_DIRENT_BLOCK = 7;

export function modeToDirentType(mode) {
  const fmt = mode & S_IFMT;
  if (fmt === S_IFREG) return UV_DIRENT_FILE;
  if (fmt === S_IFDIR) return UV_DIRENT_DIR;
  if (fmt === S_IFLNK) return UV_DIRENT_LINK;
  if (fmt === S_IFIFO) return UV_DIRENT_FIFO;
  if (fmt === S_IFSOCK) return UV_DIRENT_SOCKET;
  if (fmt === S_IFCHR) return UV_DIRENT_CHAR;
  if (fmt === S_IFBLK) return UV_DIRENT_BLOCK;
  return UV_DIRENT_UNKNOWN;
}

export class Stats {
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
    this.blksize = num(m.blksize ?? 4096);
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
  // Real Node lazily defines own enumerable date properties on first
  // access (test-fs-stat-date.mjs asserts Object.keys includes them after
  // .getTime() is read).
  _lazyDate(prop, key) {
    const v = this[key];
    Object.defineProperty(this, prop, {
      value: v,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return v;
  }
  get atime() {
    return this._lazyDate("atime", "_atime");
  }
  set atime(v) {
    this._atime = v;
  }
  get mtime() {
    return this._lazyDate("mtime", "_mtime");
  }
  set mtime(v) {
    this._mtime = v;
  }
  get ctime() {
    return this._lazyDate("ctime", "_ctime");
  }
  set ctime(v) {
    this._ctime = v;
  }
  get birthtime() {
    return this._lazyDate("birthtime", "_birthtime");
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

// Node's BigIntStats (lib/internal/fs/utils.js): same shape as Stats but
// every field a bigint, and *Ns are the authoritative time values (the *Ms
// fields are ns / 1e6). Subclassing Stats keeps the is*() methods and the
// lazy date getters; the class identity is what deepStrictEqual checks
// (test-fs-watchfile-bigint). ponytail: no is*() overrides — Number(bigint)
// is exact for mode values, so the inherited checks are identical.
export class BigIntStats extends Stats {
  constructor(
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
    atimeNs,
    mtimeNs,
    ctimeNs,
    birthtimeNs,
  ) {
    super(
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
        atimeMs: Number(atimeNs ?? 0n) / 1e6,
        mtimeMs: Number(mtimeNs ?? 0n) / 1e6,
        ctimeMs: Number(ctimeNs ?? 0n) / 1e6,
        birthtimeMs: Number(birthtimeNs ?? 0n) / 1e6,
      },
      true,
    );
    // super() derives *Ns from ms (ms * 1e6, truncated); restore the exact
    // ns values Node's constructor stores — float rounding can lose a digit.
    this.atimeNs = atimeNs ?? 0n;
    this.mtimeNs = mtimeNs ?? 0n;
    this.ctimeNs = ctimeNs ?? 0n;
    this.birthtimeNs = birthtimeNs ?? 0n;
  }
}

export class Dirent {
  // Real Node signature: new Dirent(name, type, parentPath) where type is
  // a UV_DIRENT_* constant.
  constructor(name, type, parentPath) {
    this.name = name;
    this.parentPath = parentPath;
    // Non-enumerable: real Node Dirent exposes only name/parentPath.
    Object.defineProperty(this, "_type", { value: type, enumerable: false });
  }
  isFile() {
    return this._type === UV_DIRENT_FILE;
  }
  isDirectory() {
    return this._type === UV_DIRENT_DIR;
  }
  isSymbolicLink() {
    return this._type === UV_DIRENT_LINK;
  }
  isBlockDevice() {
    return this._type === UV_DIRENT_BLOCK;
  }
  isCharacterDevice() {
    return this._type === UV_DIRENT_CHAR;
  }
  isFIFO() {
    return this._type === UV_DIRENT_FIFO;
  }
  isSocket() {
    return this._type === UV_DIRENT_SOCKET;
  }
}

// Node's DirentFromStats (lib/internal/fs/utils.js): a Dirent whose type
// checks delegate to a Stats object instead of a UV_DIRENT_* constant.
// Used by the internal/fs/utils adapter's getDirent/getDirents for
// UV_DIRENT_UNKNOWN entries (Node lstats to resolve the type).
export class DirentFromStats extends Dirent {
  constructor(name, stats, parentPath) {
    super(name, UV_DIRENT_UNKNOWN, parentPath);
    Object.defineProperty(this, "_stats", {
      value: stats,
      enumerable: false,
    });
  }
  isFile() {
    return this._stats.isFile();
  }
  isDirectory() {
    return this._stats.isDirectory();
  }
  isSymbolicLink() {
    return this._stats.isSymbolicLink();
  }
  isBlockDevice() {
    return this._stats.isBlockDevice();
  }
  isCharacterDevice() {
    return this._stats.isCharacterDevice();
  }
  isFIFO() {
    return this._stats.isFIFO();
  }
  isSocket() {
    return this._stats.isSocket();
  }
}
