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
import { codes as streamCodes } from "./stream/errors.js";
const { ERR_STREAM_DESTROYED } = streamCodes;
import { Minimatch, GLOBSTAR } from "minimatch";

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
// Browser-safe setImmediate (real setImmediate under Node, setTimeout(0)
// otherwise): macrotask deferral, so async I/O interleaves with timers the
// way real threadpool I/O does. fs.read uses this (not nextTick): a
// microtask-only read starves the writer's setInterval between a short read
// and the EOF check, and test-fs-read-stream-pos never sees the
// short-chunk-then-more-data sequence it needs to exit.
function setImmediateSafe(fn, ...args) {
  try {
    if (typeof setImmediate === "function") {
      setImmediate(fn, ...args);
      return;
    }
  } catch {
    /* ignore */
  }
  setTimeout(() => fn(...args), 0);
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
  // Real Node stringifies coded validation errors as
  // `TypeError [ERR_INVALID_ARG_TYPE]: ...`.
  Object.defineProperty(err, "toString", {
    value: function () {
      return `${this.name} [${this.code}]: ${this.message}`;
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return err;
}
// Property variant: `The "options.recursive" property must be of type ...`.
function errInvalidPropType(prop, expected, received) {
  const err = errInvalidArgType(prop, expected, received);
  err.message = err.message.replace(
    `The "${prop}" argument must be of type`,
    `The "${prop}" property must be of type`,
  );
  return err;
}
// Real Node rejects odd-length hex string writes:
// `The argument 'encoding' is invalid for data of length 3. Received 'hex'`.
function validateHexWrite(data, encoding) {
  if (encoding === "hex" && data.length % 2 !== 0) {
    const err = new TypeError(
      `The argument 'encoding' is invalid for data of length ${data.length}. Received 'hex'`,
    );
    err.code = "ERR_INVALID_ARG_VALUE";
    Object.defineProperty(err, "toString", {
      value: function () {
        return `${this.name} [${this.code}]: ${this.message}`;
      },
      enumerable: false,
      configurable: true,
      writable: true,
    });
    throw err;
  }
}

// JS-level validation errors carry no syscall/errno in real Node.
const NO_ENRICH_CODES = new Set([
  "ERR_INVALID_ARG_TYPE",
  "ERR_OUT_OF_RANGE",
  "ERR_DIR_CLOSED",
  "ERR_INVALID_ARG_VALUE",
  "ERR_INVALID_OPT_VALUE",
  "ERR_INCOMPATIBLE_OPTION_PAIR",
  "ERR_INVALID_RETURN_VALUE",
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

// Node v24's ERR_INVALID_STATE for FileHandle pull/pullSync/writer state
// errors (closed/locked). Probed against v24.20.0: plain Error (not
// TypeError), message "Invalid state: <msg>", code ERR_INVALID_STATE.
function errInvalidState(message) {
  const err = new Error(`Invalid state: ${message}`);
  err.code = "ERR_INVALID_STATE";
  return err;
}
// The writer's post-close write/writev/end path uses the TypeError variant
// (probed: name "TypeError", same code and message).
function errInvalidStateTypeError(message) {
  const err = new TypeError(`Invalid state: ${message}`);
  err.code = "ERR_INVALID_STATE";
  return err;
}
function errOutOfRange(name, expected, received) {
  const err = new RangeError(
    `The value of "${name}" is out of range. It must be ${expected}. Received ${received}`,
  );
  err.code = "ERR_OUT_OF_RANGE";
  return err;
}
// Options-property variant of errInvalidArgType: Node reports
// `The "options.autoClose" property must be of type boolean.` for option
// props (vs "argument" for positional args).
function errInvalidArgTypeProp(name, expected, received) {
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
    `The "${name}" property must be of type ${expected}. Received ${what}`,
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
}

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
function errArgType(name, expected, received) {
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
function errOutOfRangeFmt(name, expected, received) {
  const err = new RangeError(
    `The value of "${name}" is out of range. It must be ${expected}. Received ${_outOfRangeReceived(received)}`,
  );
  err.code = "ERR_OUT_OF_RANGE";
  return err;
}

// Mirrors Node's internal validateInteger (default max = MAX_SAFE_INTEGER).
function validateInteger(
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

// Mirrors Node's internal validateBuffer.
function validateBuffer(buffer, name = "buffer") {
  if (!ArrayBuffer.isView(buffer))
    throw errArgType(name, ["Buffer", "TypedArray", "DataView"], buffer);
}

// Mirrors lib/internal/fs/utils.js validatePosition(position, name, length).
function validatePosition(position, name, length) {
  if (typeof position === "number") {
    validateInteger(position, name, -1);
  } else if (typeof position === "bigint") {
    const maxPosition = 2n ** 63n - 1n - BigInt(length);
    if (!(position >= -1n && position <= maxPosition)) {
      throw errOutOfRangeFmt(name, `>= -1 && <= ${maxPosition}`, position);
    }
  } else {
    throw errArgType(name, ["bigint", "integer"], position);
  }
  return position;
}

// Mirrors lib/internal/fs/utils.js validateOffsetLengthRead.
function validateOffsetLengthRead(offset, length, bufferLength) {
  if (offset < 0) throw errOutOfRangeFmt("offset", ">= 0", offset);
  if (length < 0) throw errOutOfRangeFmt("length", ">= 0", length);
  if (offset + length > bufferLength)
    throw errOutOfRangeFmt("length", `<= ${bufferLength - offset}`, length);
}

// Mirrors Node's internal validateObject with kValidateObjectAllowNullable.
function validateOptionsObject(value, name) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value) || typeof value !== "object")
    throw errArgType(name, "Object", value);
}

// Mirrors Node's internal validateBoolean.
function validateBoolean(value, name) {
  if (typeof value !== "boolean") throw errArgType(name, "boolean", value);
}

// Mirrors lib/internal/fs/utils.js getValidatedFd (type/range only; the
// EBADF existence/readability check stays in checkFdReadable).
function getValidatedFd(fd, name = "fd") {
  if (Object.is(fd, -0)) return 0;
  validateInteger(fd, name, 0, 2147483647);
  return fd;
}

// util.inspect rendering of an empty ArrayBufferView, for the
// ERR_INVALID_ARG_VALUE 'buffer is empty' message.
function _inspectEmptyView(view) {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(view))
    return "<Buffer >";
  const ctor = view && view.constructor ? view.constructor.name : "Uint8Array";
  return `${ctor}(${view ? view.byteLength : 0}) []`;
}
function errBufferEmpty(name = "buffer", buffer) {
  const err = new TypeError(
    `The argument '${name}' is empty and cannot be written. Received ${_inspectEmptyView(buffer)}`,
  );
  err.code = "ERR_INVALID_ARG_VALUE";
  return err;
}

// ── readFile `buffer` option (Node v24 lib/internal/fs/utils.js) ──────────
function validateReadFileBufferOptions(options) {
  const buffer = options ? options.buffer : undefined;
  if (
    buffer !== undefined &&
    typeof buffer !== "function" &&
    !ArrayBuffer.isView(buffer)
  ) {
    throw errArgType(
      "options.buffer",
      ["Buffer", "TypedArray", "DataView", "Function"],
      buffer,
    );
  }
}
function getReadFileBufferByteLengthName(options) {
  return typeof options.buffer === "function"
    ? "options.buffer().byteLength"
    : "options.buffer.byteLength";
}
function getReadFileBuffer(options, size) {
  let buffer = options.buffer;
  if (typeof buffer === "function") {
    buffer = options.buffer(size);
    validateBuffer(buffer, "options.buffer()");
  }
  if (buffer === undefined) return undefined;
  if (typeof Buffer !== "undefined" && !Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  if (size > buffer.byteLength) {
    const err = new TypeError(
      `The argument '${getReadFileBufferByteLengthName(options)}' is smaller than the file size of ${size} bytes. Received ${buffer.byteLength}`,
    );
    err.code = "ERR_INVALID_ARG_VALUE";
    throw err;
  }
  return buffer;
}
function readFileBufferTooSmallError(name, byteLength) {
  const err = new TypeError(
    `The argument '${name}' is too small to contain the entire file. Received ${byteLength}`,
  );
  err.code = "ERR_INVALID_ARG_VALUE";
  return err;
}

// ── New-streams (stream/iter) batch helpers for FileHandle.pull/pullSync/
// writer (Node v24 --experimental-stream-iter). Batches are Uint8Array[].
// ──────────────────────────────────────────────────────────────────────────
const kIterDefaultChunkSize = 131072;

function iterToUint8Array(chunk) {
  if (typeof chunk === "string") {
    return typeof Buffer !== "undefined"
      ? Buffer.from(chunk, "utf8")
      : new TextEncoder().encode(chunk);
  }
  if (chunk instanceof Uint8Array) return chunk;
  throw errInvalidArgType("chunk", "string or Uint8Array", chunk);
}
function iterConvertChunks(chunks) {
  if (!Array.isArray(chunks))
    throw errInvalidArgType("chunks", "Array", chunks);
  return chunks.map(iterToUint8Array);
}
function isIterPullOptions(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !("transform" in value) &&
    !("write" in value)
  );
}
function isIterTransform(value) {
  return (
    typeof value === "function" ||
    (value !== null &&
      typeof value === "object" &&
      typeof value.transform === "function")
  );
}
// Variadic (transform..., options?) parsing, mirroring Node's
// internal/streams/iter/utils parsePullArgs.
function parseIterPullArgs(args) {
  let transforms;
  let options;
  if (args.length === 0) {
    transforms = [];
    options = undefined;
  } else {
    const last = args[args.length - 1];
    if (isIterPullOptions(last)) {
      transforms = args.slice(0, -1);
      options = last;
    } else {
      transforms = args.slice();
      options = undefined;
    }
  }
  for (let i = 0; i < transforms.length; i++) {
    if (!isIterTransform(transforms[i])) {
      throw errInvalidArgType(
        `transforms[${i}]`,
        "Function or Object with transform()",
        transforms[i],
      );
    }
  }
  return { transforms, options };
}
// Validate one integer pull/writer option: non-number -> ERR_INVALID_ARG_TYPE,
// non-integer or below min -> ERR_OUT_OF_RANGE (matches Node's validateInteger).
function validateIterIntOption(opts, key, min) {
  const value = opts[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number")
    throw errInvalidArgType(`options.${key}`, "number", value);
  if (!Number.isSafeInteger(value))
    throw errOutOfRange(`options.${key}`, "an integer", value);
  if (value < min) throw errOutOfRange(`options.${key}`, `>= ${min}`, value);
  return value;
}
function validateIterAutoClose(opts) {
  const value = opts.autoClose;
  if (value === undefined) return false;
  if (typeof value !== "boolean")
    throw errInvalidArgTypeProp("options.autoClose", "boolean", value);
  return value;
}
// Normalize one transform result to a Uint8Array[] batch (or null to skip).
function normalizeIterBatch(item) {
  if (item === null || item === undefined) return null;
  if (Array.isArray(item)) {
    if (item.length === 0) return null;
    let allBytes = true;
    for (const c of item) {
      if (!(c instanceof Uint8Array)) {
        allBytes = false;
        break;
      }
    }
    if (allBytes) return item;
    const out = [];
    for (const c of item) {
      const b = normalizeIterBatch(c);
      if (b) out.push(...b);
    }
    return out.length > 0 ? out : null;
  }
  if (item instanceof Uint8Array) return [item];
  if (typeof item === "string") return [iterToUint8Array(item)];
  if (typeof ArrayBuffer !== "undefined" && item instanceof ArrayBuffer)
    return [new Uint8Array(item)];
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(item))
    return [
      new Uint8Array(item.buffer, item.byteOffset, item.byteLength).slice(),
    ];
  if (typeof item[Symbol.iterator] === "function") {
    const out = [];
    for (const c of item) {
      const b = normalizeIterBatch(c);
      if (b) out.push(...b);
    }
    return out.length > 0 ? out : null;
  }
  return null;
}
function appendIterBatch(list, result) {
  const batch = normalizeIterBatch(result);
  if (batch) list.push(batch);
}
// Stateless function transforms, fused per batch, with a null flush at the
// end (mirrors Node's applyFusedStatelessAsyncTransforms).
async function* applyFusedStatelessAsync(source, run, signal) {
  for await (const chunks of source) {
    let current = chunks;
    for (const fn of run) {
      let result = fn(current, { __proto__: null, signal });
      if (result !== null && typeof result?.then === "function")
        result = await result;
      if (result === null) {
        current = null;
        break;
      }
      current = result;
    }
    if (current === null) continue;
    const batch = normalizeIterBatch(current);
    if (batch && batch.length > 0) yield batch;
  }
  // Flush: earlier flush output feeds later transforms, like Node.
  let pending = [];
  for (const fn of run) {
    const next = [];
    for (const p of pending)
      appendIterBatch(next, await fn(p, { __proto__: null, signal }));
    appendIterBatch(next, await fn(null, { __proto__: null, signal }));
    pending = next;
  }
  for (const b of pending) yield b;
}
// Stateful transform object: transform(source, options) is a (async)
// generator; a trailing null batch is the flush signal (mirrors Node's
// withFlushAsync + applyStatefulAsyncTransform; validated zlib transforms
// treat the null batch as their flush signal and won't double-finalize).
async function* withFlushAsyncGen(source) {
  yield* source;
  yield null;
}
async function* applyStatefulAsync(source, transformFn, signal) {
  const output = transformFn(withFlushAsyncGen(source), {
    __proto__: null,
    signal,
  });
  for await (const item of output) {
    if (item === null) continue;
    const batch = normalizeIterBatch(item);
    if (batch && batch.length > 0) yield batch;
  }
}
async function* applyIterTransformsAsync(source, transforms, signal) {
  // Node's pipeline always hands transforms a live AbortSignal (from its
  // internal controller); zlib's transforms call signal.addEventListener
  // unconditionally, so synthesize one when the caller passed none.
  const sig = signal ?? new AbortController().signal;
  let current = source;
  let run = [];
  for (const t of transforms) {
    if (typeof t === "function") {
      run.push(t);
      continue;
    }
    if (run.length > 0) {
      current = applyFusedStatelessAsync(current, run, sig);
      run = [];
    }
    current = applyStatefulAsync(current, t.transform, sig);
  }
  if (run.length > 0) current = applyFusedStatelessAsync(current, run, sig);
  yield* current;
}
// Sync counterparts for pullSync.
function* withFlushSyncGen(source) {
  yield* source;
  yield null;
}
function* applyFusedStatelessSync(source, run) {
  for (const chunks of source) {
    let current = chunks;
    for (const fn of run) {
      const result = fn(current);
      if (result === null) {
        current = null;
        break;
      }
      current = result;
    }
    if (current === null) continue;
    const batch = normalizeIterBatch(current);
    if (batch && batch.length > 0) yield batch;
  }
  let pending = [];
  for (const fn of run) {
    const next = [];
    for (const p of pending) appendIterBatch(next, fn(p));
    appendIterBatch(next, fn(null));
    pending = next;
  }
  for (const b of pending) yield b;
}
function* applyStatefulSync(source, transformFn) {
  const output = transformFn(withFlushSyncGen(source));
  for (const item of output) {
    if (item === null) continue;
    const batch = normalizeIterBatch(item);
    if (batch && batch.length > 0) yield batch;
  }
}
function* applyIterTransformsSync(source, transforms) {
  let current = source;
  let run = [];
  for (const t of transforms) {
    if (typeof t === "function") {
      run.push(t);
      continue;
    }
    if (run.length > 0) {
      current = applyFusedStatelessSync(current, run);
      run = [];
    }
    current = applyStatefulSync(current, t.transform);
  }
  if (run.length > 0) current = applyFusedStatelessSync(current, run);
  yield* current;
}

// Node's ERR_INVALID_ARG_VALUE for the watch ignore option (probed
// v24.20.0): `The property 'options.ignore' must be a non-empty string.
// Received ''`.
function errInvalidArgValueNonEmptyString(name, value) {
  const err = new TypeError(
    `The property '${name}' must be a non-empty string. Received '${value}'`,
  );
  err.code = "ERR_INVALID_ARG_VALUE";
  return err;
}
// Node's ignore-option element validation (lib/internal/validators.js):
// string (non-empty), RegExp, or Function. The type error reads
// `The "options.ignore" property must be one of type string or function
// or an instance of RegExp. Received type number (123)` (probed v24.20.0).
function errIgnoreArgType(name, received) {
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
    `The "${name}" property must be one of type string or function or an ` +
      `instance of RegExp. Received ${what}`,
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
}
function validateIgnoreOptionElement(value, name) {
  if (typeof value === "string") {
    if (value.length === 0) throw errInvalidArgValueNonEmptyString(name, value);
    return;
  }
  if (value instanceof RegExp) return;
  if (typeof value === "function") return;
  throw errIgnoreArgType(name, value);
}
function validateIgnoreOption(value, name = "options.ignore") {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++)
      validateIgnoreOptionElement(value[i], `${name}[${i}]`);
    return;
  }
  validateIgnoreOptionElement(value, name);
}
// Creates an ignore matcher from the fs.watch `ignore` option, mirroring
// Node's lib/internal/fs/watchers.js createIgnoreMatcher: glob strings via
// minimatch (matchBase so `*.log` matches `subdir/file.log`), RegExps, and
// predicate functions. Returns null when no ignore option is set.
function createIgnoreMatcher(ignore) {
  if (ignore == null) return null;
  const matchers = Array.isArray(ignore) ? ignore : [ignore];
  const compiled = matchers.map((matcher) => {
    if (typeof matcher === "string") {
      const mm = new Minimatch(matcher, {
        nonegate: true,
        nocomment: true,
        // matchBase allows patterns without slashes to match the basename,
        // e.g. '*.log' matches 'subdir/file.log' (Node's option).
        matchBase: true,
      });
      return (filename) => mm.match(filename);
    }
    if (matcher instanceof RegExp) {
      return (filename) => matcher.test(filename);
    }
    return matcher;
  });
  return (filename) => {
    for (const fn of compiled) {
      if (fn(filename)) return true;
    }
    return false;
  };
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
        // whose message is already rewritten there). Kept sticky (not
        // deleted): callback→promise boundaries re-enrich the same error
        // object (definePromise), and the throwing site's syscall stays
        // authoritative through every layer.
        err.syscall = err._syscallOverride;
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
    if (typeof value !== "number") {
      const err = new TypeError(
        `The "${name}" argument must be of type number. Received ${String(value)}`,
      );
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    if (!Number.isInteger(value) || value < -1 || value > 0xffffffff) {
      const err = new RangeError(
        `The value of "${name}" is out of range. It must be >= -1 && <= 4294967295. Received ${value}`,
      );
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
  }
}
function validatePath(p, name = "path") {
  if (typeof p !== "string" && !isUint8ArrayLike(p) && !isURLLike(p)) {
    // Match Node's exact message format (lib/internal/errors.js
    // determineSpecificType): functions render as `function ${name}`.
    let received;
    if (p === null) received = "null";
    else if (p === undefined) received = "undefined";
    else if (typeof p === "function") received = `function ${p.name || ""}`;
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
// Validate open() flags: string (e.g. 'r', 'w+') or number. Memfs does the
// detailed parsing; this just ensures the type is sane.
function validateFlags(flags) {
  if (flags === undefined || flags === null) return "r";
  if (typeof flags === "string" || typeof flags === "number") return flags;
  const err = new TypeError(
    `The "flags" argument must be of type string or number. Received type ${typeof flags}`,
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  throw err;
}
// Validate open() mode: number or octal string (or undefined for default).
function validateMode(mode, def = undefined) {
  if (mode === undefined || mode === null) return def;
  if (typeof mode === "number") {
    if (!Number.isInteger(mode)) {
      const err = new RangeError(
        `The value of "mode" is out of range. It must be an integer. Received ${mode}`,
      );
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    if (mode < 0 || mode > 4294967295) {
      const err = new RangeError(
        `The value of "mode" is out of range. It must be >= 0 && <= 4294967295. Received ${mode}`,
      );
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    return mode;
  }
  if (typeof mode === "string") {
    // Must be a valid octal string (e.g. "0o666", "666").
    if (!/^(0o)?[0-7]+$/.test(mode)) {
      const err = new TypeError(
        `The argument 'mode' must be a valid octal string or number. Received '${mode}'`,
      );
      err.code = "ERR_INVALID_ARG_VALUE";
      throw err;
    }
    return mode;
  }
  const err = new TypeError(
    `The "mode" argument must be of type number or string. Received type ${typeof mode}`,
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  throw err;
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
// memfs resolves relative paths against process.cwd(); mirror that so the
// shim absolutizes the same way memfs will.
function shimCwd() {
  try {
    if (typeof process !== "undefined" && typeof process.cwd === "function")
      return process.cwd().replace(/\/+/g, "/");
  } catch {
    /* ignore */
  }
  return "/";
}
// Normalize a posix path lexically (resolves . and .., collapses slashes).
function posixNormalize(p) {
  const abs = p.startsWith("/");
  const out = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(part);
  }
  const r = (abs ? "/" : "") + out.join("/");
  if (r === "") return abs ? "/" : ".";
  return r;
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

// UV_DIRENT_* type constants (stable ABI, mirror src/constants.js).
const UV_DIRENT_UNKNOWN = 0,
  UV_DIRENT_FILE = 1,
  UV_DIRENT_DIR = 2,
  UV_DIRENT_LINK = 3,
  UV_DIRENT_FIFO = 4,
  UV_DIRENT_SOCKET = 5,
  UV_DIRENT_CHAR = 6,
  UV_DIRENT_BLOCK = 7;

function modeToDirentType(mode) {
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

function toStats(m, options) {
  const bigint = !!(options && (options.bigint || options === true));
  return new Stats(m, bigint);
}

// ── 6. Node-shaped Dirent ───────────────────────────────────────────────────
// Enumerable own keys: name, parentPath only.
class Dirent {
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
  // Real Node's template here is `must be an instance of ...` (no "of type").
  const err = errInvalidArgType(
    name,
    "an instance of Date or an Time in seconds",
    time,
  );
  err.message = err.message.replace(
    "must be of type an instance of",
    "must be an instance of",
  );
  throw err;
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

  // Normalize raw ArrayBuffer/DataView/TypedArray inputs for read/write data
  // args. memfs stringifies non-Buffer views (Int8Array -> "65,66"), so every
  // view becomes a Buffer/Uint8Array of its bytes before touching the volume
  // (test-fs-write-file-typedarrays.js).
  function normalizeDataArg(data) {
    if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (
      typeof ArrayBuffer !== "undefined" &&
      ArrayBuffer.isView(data) &&
      !(typeof Buffer !== "undefined" && Buffer.isBuffer(data))
    ) {
      return typeof Buffer !== "undefined"
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return data;
  }
  // Concatenate normalized write buffers (Buffer/Uint8Array) for the
  // writev partial-write retry path.
  function concatBuffers(buffers) {
    if (typeof Buffer !== "undefined") return Buffer.concat(buffers);
    const total = buffers.reduce((a, b) => a + b.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of buffers) {
      out.set(b, off);
      off += b.byteLength;
    }
    return out;
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
            err.message.slice(0, -tail.length) + `'${srcStr}' -> '${destStr}'`;
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
        // Two-path ops (linkSync, symlinkSync, etc.): validate the dest path too.
        if (destIdx != null && destIdx !== 0)
          validatePath(args[destIdx], "dest");
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
        // Two-path ops (link, symlink, etc.): validate the dest path too.
        if (destIdx != null && destIdx !== 0)
          validatePath(args[destIdx], "dest");
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
      [
        "string",
        "Buffer",
        "TypedArray",
        "DataView",
        "Iterable",
        "AsyncIterable",
      ],
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
        : chunks.reduce((acc, c) => {
            const out = new Uint8Array(acc.length + c.length);
            out.set(acc);
            out.set(c, acc.length);
            return out;
          }, new Uint8Array(0));
    }
    throw errInvalidArgType(
      "data",
      [
        "string",
        "Buffer",
        "TypedArray",
        "DataView",
        "Iterable",
        "AsyncIterable",
      ],
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
      // Match readFileSyncManual: fail fast with ERR_FS_FILE_TOO_LARGE for
      // files > 2GiB instead of attempting the read (test-fs-readfile.js).
      // Only for path args; fd reads go through the fd's own state.
      if (typeof p === "string" || Buffer.isBuffer(p) || p instanceof URL) {
        try {
          const st = vol.statSync(p);
          if (st.size > 2 ** 31 - 1) {
            const err = new RangeError(
              `File size (${st.size}) is greater than 2 GiB`,
            );
            err.code = "ERR_FS_FILE_TOO_LARGE";
            nextTick(callback, err);
            return;
          }
        } catch (e) {
          // stat failed (e.g. ENOENT) — let origReadFile produce the error.
          if (e.code !== "ENOENT") {
            nextTick(callback, e);
            return;
          }
        }
      }
      return origReadFile.call(this, p, options, callback);
    }, 1);

    // writeFile(file-descriptor, …): write at the fd's current position,
    // never truncate; EBADF when the fd is not writable.
    function writeFileToFd(fd, data, options, callback, flush) {
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
      if (flush) {
        fs.fsync(fd, (syncErr) => {
          if (syncErr) return callback(enrichErr(syncErr, "write"));
          nextTick(callback, null);
        });
        return;
      }
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
      const flush = validateFlushOpt(options);
      if (typeof file === "number") {
        writeFileToFd(file, data, options, callback, flush);
        return;
      }
      // A read-only open flag ("r", "rs", "sr") fails the write with EBADF
      // (memfs silently writes anyway).
      const flag =
        options !== null && typeof options === "object"
          ? options.flag
          : undefined;
      if (typeof flag === "string" && /^(rs?|sr)$/.test(flag)) {
        const err = makeFsError(
          "EBADF",
          "write",
          undefined,
          "bad file descriptor",
        );
        err.errno = -9;
        nextTick(callback, err);
        return;
      }
      if (flush) {
        // Manual open/write/fsync/close so the fd is available for fsync
        // (memfs closes its fd internally).
        const o =
          options !== null && typeof options === "object" ? options : {};
        const f = o.flag || "w";
        const mode = o.mode !== undefined ? o.mode : 0o666;
        fs.open(file, f, mode, (openErr, fd) => {
          if (openErr) return callback(enrichErr(openErr, "write"));
          let buf;
          try {
            buf = dataToBuffer(data, options);
          } catch (e) {
            fs.close(fd, () => callback(enrichErr(e, "write")));
            return;
          }
          fs.write(fd, buf, 0, buf.byteLength, null, (writeErr) => {
            if (writeErr) {
              fs.close(fd, () => callback(enrichErr(writeErr, "write")));
              return;
            }
            fs.fsync(fd, (syncErr) => {
              if (syncErr) {
                fs.close(fd, () => callback(enrichErr(syncErr, "write")));
                return;
              }
              fs.close(fd, callback);
            });
          });
        });
        return;
      }
      return origWriteFile.call(
        this,
        file,
        dataToBuffer(data, options),
        options,
        callback,
      );
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
      const flush = validateFlushOpt(options);
      // fd variant: current-position write, no truncation (memfs truncates).
      if (typeof file === "number") {
        const flush =
          options !== null && typeof options === "object"
            ? (options.flush ?? false)
            : false;
        validateBoolean(flush, "options.flush");
        checkFdWritable(file, "write");
        const buf = dataToBuffer(data, options);
        vol.writeSync(file, buf, 0, buf.byteLength, null);
        if (flush) fs.fsyncSync(file);
        emitFs("fs", "writeFileSync", file, buf.byteLength);
        return;
      }
      if (flush) {
        // Manual open/write/fsync/close so the fd is available for fsync.
        const o =
          options !== null && typeof options === "object" ? options : {};
        const flag = o.flag || "w";
        const mode = o.mode !== undefined ? o.mode : 0o666;
        const fd = fs.openSync(file, flag, mode);
        try {
          const buf = dataToBuffer(data, options);
          vol.writeSync(fd, buf, 0, buf.byteLength, null);
          fs.fsyncSync(fd);
          emitFs("fs", "writeFileSync", file, buf.byteLength);
        } finally {
          fs.closeSync(fd);
        }
        return;
      }
      return origWriteFileSync.call(
        this,
        file,
        dataToBuffer(data, options),
        options,
      );
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
          if (wantDirent)
            out.push(new Dirent(name, modeToDirentType(st.mode), dir));
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
        return new Dirent(name, modeToDirentType(mode), p);
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

  // ── readSync/read: Node v24 arg parsing + validation (lib/fs.js) ──────
  // Position -1/null/undefined means "current position" (the fd cursor
  // advances); an explicit position leaves the cursor alone (memfs moves it,
  // so save/restore). memfs cannot address -1 or huge positions (its
  // Buffer.copy throws ERR_OUT_OF_RANGE "sourceStart"), so normalize first:
  // -1 -> null (cursor), huge (>= file size) -> 0 bytes like real Node.
  function allocReadBuffer(length) {
    return typeof Buffer !== "undefined"
      ? Buffer.alloc(length)
      : new Uint8Array(length);
  }
  // Shared memfs read core. `position` is -1 (current) or a validated
  // explicit number/bigint. Returns bytesRead.
  function readMemfs(fd, buf, off, len, position, syscall) {
    const atCursor = position === -1 || position === -1n;
    const savedPos = atCursor ? undefined : getPosition(fd);
    let posArg;
    if (atCursor) {
      posArg = null;
    } else {
      const num = typeof position === "bigint" ? Number(position) : position;
      let size = -1;
      try {
        size = vol.fstatSync(fd).size;
      } catch {}
      if (size >= 0 && num >= size) {
        if (savedPos !== undefined) setPosition(fd, savedPos);
        return 0;
      }
      posArg = num;
    }
    let n;
    try {
      n = vol.readSync(fd, buf, off, len, posArg);
    } catch (e) {
      throw enrichErr(e, syscall);
    } finally {
      if (savedPos !== undefined) setPosition(fd, savedPos);
    }
    return n;
  }
  {
    fs.readSync = function (...args) {
      // readSync(fd, buffer, offset, length, position) or
      // readSync(fd, buffer, options)
      let [fd, buffer, offsetOrOptions, length, position] = args;
      getValidatedFd(fd);
      validateBuffer(buffer);
      let offset = offsetOrOptions;
      if (
        args.length <= 3 ||
        (offsetOrOptions !== null && typeof offsetOrOptions === "object")
      ) {
        if (offsetOrOptions !== undefined)
          validateOptionsObject(offsetOrOptions, "options");
        ({
          offset = 0,
          length = buffer.byteLength - offset,
          position = null,
        } = offsetOrOptions ?? {});
      }
      if (offset === undefined) {
        offset = 0;
      } else {
        validateInteger(offset, "offset", 0);
      }
      length |= 0;
      if (position == null) {
        position = -1;
      } else {
        validatePosition(position, "position", length);
      }
      if (length === 0) return 0;
      if (buffer.byteLength === 0) throw errBufferEmpty("buffer", buffer);
      validateOffsetLengthRead(offset, length, buffer.byteLength);
      checkFdReadable(fd, "read");
      const n = readMemfs(fd, buffer, offset, length, position, "readSync");
      emitFs("fs", "readSync", fd, n);
      return n;
    };
  }
  {
    fs.read = function (...args) {
      // read(fd, buffer, offset, length, position, callback),
      // read(fd, buffer, options, callback), read(fd, options, callback),
      // read(fd, callback) — see lib/fs.js read().
      let [fd, buffer, offsetOrOptions, length, position, callback] = args;
      getValidatedFd(fd);
      let offset = offsetOrOptions;
      let params = null;
      if (args.length <= 4) {
        if (args.length === 4) {
          // read(fd, buffer, options, callback)
          validateOptionsObject(offsetOrOptions, "options");
          callback = length;
          params = offsetOrOptions;
        } else if (args.length === 3) {
          // read(fd, bufferOrParams, callback)
          if (!ArrayBuffer.isView(buffer)) {
            // read(fd, params, callback)
            params = buffer;
            ({ buffer = allocReadBuffer(16384) } = params ?? {});
          }
          callback = offsetOrOptions;
        } else {
          // read(fd, callback)
          callback = buffer;
          buffer = allocReadBuffer(16384);
        }
        if (params !== undefined) validateOptionsObject(params, "options");
        ({
          offset = 0,
          length = buffer?.byteLength - offset,
          position = null,
        } = params ?? {});
      }
      validateBuffer(buffer);
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      if (offset == null) {
        offset = 0;
      } else {
        validateInteger(offset, "offset", 0);
      }
      length |= 0;
      if (position == null) {
        position = -1;
      } else {
        validatePosition(position, "position", length);
      }
      if (length === 0) {
        nextTick(callback, null, 0, buffer);
        return;
      }
      if (buffer.byteLength === 0) throw errBufferEmpty("buffer", buffer);
      validateOffsetLengthRead(offset, length, buffer.byteLength);
      try {
        checkFdReadable(fd, "read");
      } catch (e) {
        nextTick(callback, enrichErr(e, "read"));
        return;
      }
      const buf = buffer,
        off = offset,
        len = length,
        pos = position;
      const run = () => {
        let bytesRead;
        try {
          bytesRead = readMemfs(fd, buf, off, len, pos, "read");
        } catch (e) {
          nextTick(callback, e);
          return;
        }
        emitFs("fs", "read", fd, bytesRead);
        nextTick(callback, null, bytesRead, buf);
      };
      // Macrotask, not microtask: real threadpool reads interleave with
      // timers; a microtask-only read would starve a concurrent writer
      // (test-fs-read-stream-pos).
      setImmediateSafe(run);
    };
    // util.promisify(fs.read) resolves { bytesRead, buffer } (Node's
    // kCustomPromisifyArgsSymbol). The symbol is module-local in Node, so use
    // the public util.promisify.custom (global registry). It lives on the
    // function's prototype chain so the harness's in-place wrapFn (which
    // copies only string keys) still exposes it.
    const kPromisifyCustom = Symbol.for("nodejs.util.promisify.custom");
    const readProto = Object.create(Function.prototype);
    Object.defineProperty(readProto, kPromisifyCustom, {
      value: function (...args) {
        return new Promise((resolve, reject) => {
          fs.read(...args, (err, bytesRead, buffer) =>
            err ? reject(err) : resolve({ bytesRead, buffer }),
          );
        });
      },
      configurable: true,
    });
    Object.setPrototypeOf(fs.read, readProto);
  }

  // ── writeSync/write: Node v24 argument validation, EBADF on wrong-direction
  // fd, cursor preservation. Validation (fd type, buffer type, offset/length,
  // encoding) throws synchronously like Node; only binding-level errors
  // (EBADF for a valid-but-closed fd) go to the callback for fs.write.
  {
    const orig = fs.writeSync;
    fs.writeSync = function (fd, data, ...rest) {
      validateFd(fd);
      const args = parseWriteArgs(data, rest, false);
      checkFdWritable(fd, "write");
      const savedPos =
        typeof args.position === "number" ? getPosition(fd) : undefined;
      let n;
      try {
        n =
          args.encoding !== undefined
            ? orig.call(this, fd, args.buf, args.position, args.encoding)
            : orig.call(
                this,
                fd,
                args.buf,
                args.offset,
                args.length,
                args.position,
              );
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
      validateFd(fd);
      const args = parseWriteArgs(data, rest, true);
      const callback = args.callback;
      try {
        checkFdWritable(fd, "write");
      } catch (e) {
        nextTick(callback, enrichErr(e, "write"));
        return;
      }
      const savedPos =
        typeof args.position === "number" ? getPosition(fd) : undefined;
      // Node's wrapper retains the original buffer for the callback.
      const origData = data;
      const cb = (err, written) => {
        if (savedPos !== undefined) setPosition(fd, savedPos);
        if (err) return callback(enrichErr(err, "write"));
        emitFs("fs", "write", fd, written);
        callback(null, written || 0, origData);
      };
      try {
        if (args.encoding !== undefined) {
          return orig.call(
            this,
            fd,
            args.buf,
            args.position,
            args.encoding,
            cb,
          );
        }
        return orig.call(
          this,
          fd,
          args.buf,
          args.offset,
          args.length,
          args.position,
          cb,
        );
      } catch (e) {
        throw enrichErr(e, "write");
      }
    };
    // util.promisify(fs.write) resolves { bytesWritten, buffer }.
    fs.write[Symbol.for("nodejs.util.promisify.custom")] = function (
      fd,
      data,
      ...args
    ) {
      return new Promise((resolve, reject) => {
        fs.write(fd, data, ...args, (err, bytesWritten, buf) =>
          err ? reject(err) : resolve({ bytesWritten, buffer: buf }),
        );
      });
    };
  }

  // ── readv/writev (+Sync) ──
  // Mirrors Node's internal validateBufferArray.
  function validateBufferArray(buffers, name = "buffers") {
    if (!Array.isArray(buffers))
      throw errArgType(name, "ArrayBufferView[]", buffers);
    for (const b of buffers) {
      if (!ArrayBuffer.isView(b))
        throw errArgType(name, "ArrayBufferView[]", buffers);
    }
  }
  function readvSyncImpl(fd, buffers, position) {
    checkFdReadable(fd, "readv");
    validateBufferArray(buffers);
    if (buffers.length === 0)
      throw makeFsError("EINVAL", "read", undefined, "invalid argument");
    if (typeof position !== "number") position = null;
    if (position !== null) {
      // memfs cannot address huge positions (see readMemfs); real Node
      // reads 0 bytes at/after EOF.
      let size = -1;
      try {
        size = vol.fstatSync(fd).size;
      } catch {}
      if (size >= 0 && position >= size) return 0;
    }
    const savedPos = position !== null ? getPosition(fd) : undefined;
    let total = 0;
    try {
      for (const buf of buffers) {
        const n = vol.readSync(
          fd,
          buf,
          0,
          buf.byteLength,
          position !== null ? position + total : null,
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
    validateBufferArrayShim(buffers);
    // A negative position means "current position" in Node (uv_fs_write
    // with offset < 0 writes at the cursor); memfs would throw.
    if (typeof position !== "number" || position < 0) position = null;
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
      getValidatedFd(fd);
      result = readvSyncImpl(fd, buffers, position);
    } catch (e) {
      throw enrichErr(e, "readvSync");
    }
    emitFs("fs", "readvSync", fd, result);
    return result;
  };
  fs.writevSync = function (fd, buffers, position) {
    // Node validates the buffers first and returns 0 for an empty array
    // without touching the fd.
    validateBufferArrayShim(buffers);
    if (buffers.length === 0) return 0;
    validateFd(fd);
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
    try {
      getValidatedFd(fd);
      validateBufferArray(buffers);
    } catch (e) {
      throw enrichErr(e, "readv");
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
  // util.promisify(fs.readv) resolves { bytesRead, buffers } — see the
  // fs.read note above for why the symbol lives on the prototype chain.
  {
    const kPromisifyCustom = Symbol.for("nodejs.util.promisify.custom");
    const readvProto = Object.create(Function.prototype);
    Object.defineProperty(readvProto, kPromisifyCustom, {
      value: function (...args) {
        return new Promise((resolve, reject) => {
          fs.readv(...args, (err, bytesRead, buffers) =>
            err ? reject(err) : resolve({ bytesRead, buffers }),
          );
        });
      },
      configurable: true,
    });
    Object.setPrototypeOf(fs.readv, readvProto);
  }
  fs.writev = function (fd, buffers, position, callback) {
    // Node validates fd and buffers synchronously (getValidatedFd +
    // validateBufferArray); an empty array short-circuits to
    // nextTick(callback, null, 0, buffers) without touching the fd.
    validateFd(fd);
    validateBufferArrayShim(buffers);
    if (typeof position === "function") {
      callback = position;
      position = undefined;
    }
    if (typeof callback !== "function")
      throw errInvalidArgType("cb", "function", callback);
    if (buffers.length === 0) {
      nextTick(callback, null, 0, buffers);
      return;
    }
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
    if (typeof mode !== "number") {
      // Real Node's message for a bad access mode.
      const err = new Error("mode must be int32 or null/undefined");
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    // Real Node: NaN/Infinity -> "mode is out of range"; outside [0,7] ->
    // "mode is out of range: >= 0 && <= 7". Non-integers inside range pass
    // (truncated by the bitwise checks below).
    if (Number.isNaN(mode) || !Number.isFinite(mode)) {
      const err = new RangeError("mode is out of range");
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    if (mode < 0 || mode > 7) {
      const err = new RangeError("mode is out of range: >= 0 && <= 7");
      err.code = "ERR_OUT_OF_RANGE";
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
  // options.recursive must be a boolean when present (throws synchronously,
  // even for the async mkdir — verified against Node v24).
  function validateMkdirOptions(options) {
    if (
      options !== null &&
      typeof options === "object" &&
      options.recursive !== undefined &&
      typeof options.recursive !== "boolean"
    ) {
      throw errInvalidArgTypeProp(
        "options.recursive",
        "boolean",
        options.recursive,
      );
    }
  }
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
    } else opts = { ...(options || {}) };
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
      // Real Node's recursive mkdir returns the first created path (or
      // undefined when nothing was created); memfs returns the full path.
      const firstCreated = (function () {
        const norm = p.replace(/\/+$/, "") || "/";
        const segs = norm.split("/");
        let cur = "";
        for (let i = 1; i < segs.length; i++) {
          cur += "/" + segs[i];
          let exists = false;
          try {
            vol.statSync(cur);
            exists = true;
          } catch {
            /* ignore */
          }
          if (!exists) return cur;
        }
        return undefined;
      })();
      try {
        vol.mkdirSync(p, opts);
      } catch (e) {
        // Real Node reports the full path for recursive-mkdir ENOTDIR
        // (nodejs/node#28015); memfs reports the offending component.
        if (e && e.code === "ENOTDIR") e.path = p;
        throw e;
      }
      return firstCreated;
    }
    return vol.mkdirSync(p, opts);
  }
  {
    const orig = fs.mkdir;
    fs.mkdirSync = function (p, options) {
      validatePath(p);
      validateMkdirOptions(options);
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
      validateMkdirOptions(options);
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
      validatePath(oldPath, "oldPath");
      validatePath(newPath, "newPath");
      try {
        checkRename(oldPath, newPath);
        origSync.call(this, toPathString(oldPath), toPathString(newPath));
        moveSymlinkTarget(oldPath, newPath);
      } catch (e) {
        throw enrichDestErr(e, "renameSync", oldPath, newPath);
      }
      emitFs("fs", "renameSync", oldPath, undefined);
    };
    fs.rename = function (oldPath, newPath, callback) {
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validatePath(oldPath, "oldPath");
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
              moveSymlinkTarget(oldPath, newPath);
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
      // lstat: a symlink to a directory is still unlinkable (real Node
      // allows unlink on dir symlinks; stat would wrongly report EISDIR).
      st = vol.lstatSync(ps);
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
    // rmdir expects a directory; only rm rejects non-recursive directory
    // removal with ERR_FS_EISDIR.
    if (
      syscallName !== "rmdir" &&
      st &&
      st.isDirectory() &&
      !opts.recursive &&
      !opts.force
    ) {
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
  // DEP0147 fires once per process in real Node (verified against v24:
  // repeated rmdir(path, { recursive: true }) calls warn only once).
  let rmdirRecursiveWarned = false;
  function warnRmdirRecursive() {
    if (rmdirRecursiveWarned) return;
    rmdirRecursiveWarned = true;
    if (
      typeof process !== "undefined" &&
      typeof process.emitWarning === "function"
    ) {
      process.emitWarning(
        "In future versions of Node.js, fs.rmdir(path, { recursive: true }) " +
          "will be removed. Use fs.rm(path, { recursive: true }) instead",
        "DeprecationWarning",
        "DEP0147",
      );
    }
  }
  // Real Node's recursive rmdir removes the tree (lstat-walk: symlinks are
  // unlinked, never followed). memfs's recursive rmdirBase merely detaches
  // the dir link, leaking children; do it properly here.
  function rmdirRecursiveSync(ps) {
    let st;
    try {
      st = vol.lstatSync(ps);
    } catch (e) {
      throw e; // ENOENT surfaces (test-fs-rmdir-recursive-sync-warns-not-found)
    }
    if (!st.isDirectory()) {
      throw makeFsError("ENOTDIR", "rmdir", ps, "not a directory");
    }
    for (const name of vol.readdirSync(ps)) {
      const child = ps + "/" + name;
      const cst = vol.lstatSync(child);
      if (cst.isDirectory()) rmdirRecursiveSync(child);
      else vol.unlinkSync(child);
    }
    vol.rmdirSync(ps);
  }
  for (const [syncName, cbName] of [["rmSync", "rm"]]) {
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
  // rmdir/rmdirSync: plain rmdir removes an empty dir (memfs raises
  // ENOTEMPTY/ENOTDIR/ENOENT itself); recursive rmdir warns DEP0147 once and
  // removes the tree. Never the rm EISDIR path (test-fs-mkdir-rmdir).
  {
    const origSync = fs.rmdirSync,
      origCb = fs.rmdir;
    fs.rmdirSync = function (p, options) {
      validatePath(p);
      const ps = toPathString(p);
      const recursive = !!(
        options &&
        typeof options === "object" &&
        options.recursive
      );
      if (recursive) warnRmdirRecursive();
      try {
        if (recursive) rmdirRecursiveSync(ps);
        else origSync.call(this, ps, options);
      } catch (e) {
        throw enrichErr(e, "rmdirSync");
      }
      emitFs("fs", "rmdirSync", p, undefined);
    };
    fs.rmdir = function (p, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validatePath(p);
      const ps = toPathString(p);
      const recursive = !!(
        options &&
        typeof options === "object" &&
        options.recursive
      );
      if (recursive) warnRmdirRecursive();
      nextTick(() => {
        try {
          if (recursive) rmdirRecursiveSync(ps);
          else
            origCb.call(this, ps, options, (err) => {
              if (err) return callback(enrichErr(err, "rmdir"));
              emitFs("fs", "rmdir", p, undefined);
              callback(null);
            });
          if (recursive) {
            emitFs("fs", "rmdir", p, undefined);
            callback(null);
          }
        } catch (e) {
          callback(enrichErr(e, "rmdir"));
        }
      });
    };
  }

  // ── truncate: len must be a number (ERR_INVALID_ARG_TYPE); fractional/NaN
  // → ERR_OUT_OF_RANGE; negative → 0. Async variants validate len before the
  // callback and throw synchronously (verified against Node v24).
  function normalizeTruncateLen(len) {
    if (len === undefined) return 0;
    if (typeof len !== "number") throw errInvalidArgType("len", "number", len);
    const n = len;
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
      // len validates before cb/path (Node v24) and throws synchronously.
      const norm = normalizeTruncateLen(len);
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validatePath(p);
      origCb.call(this, toPathString(p), norm, (err) => {
        if (err) return callback(enrichErr(err, "truncate"));
        emitFs("fs", "truncate", p, undefined);
        callback(null);
      });
    };
    fs.ftruncateSync = function (fd, len) {
      let result;
      try {
        // Validation order (Node v24): len, then fd.
        const norm = normalizeTruncateLen(len);
        validateFd(fd);
        result = origFSync.call(this, fd, norm);
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
      // Validation order (Node v24): len, then cb, then fd; throws sync.
      const norm = normalizeTruncateLen(len);
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validateFd(fd);
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
  // ── write/writeSync/writev argument validation (Node v24 lib/fs.js) ──
  function errOutOfRange(name, range, received) {
    const err = new RangeError(
      `The value of "${name}" is out of range. It must be ${range}. Received ${received}`,
    );
    err.code = "ERR_OUT_OF_RANGE";
    return err;
  }
  // Node's internal validateInteger(value, name, min = 0, max = MAX_SAFE_INTEGER).
  function validateIntegerArg(
    value,
    name,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
  ) {
    if (typeof value !== "number")
      throw errInvalidArgType(name, "number", value);
    if (!Number.isInteger(value))
      throw errOutOfRange(name, "an integer", String(value));
    if (value < min || value > max)
      throw errOutOfRange(name, `>= ${min} && <= ${max}`, String(value));
  }
  // Node's internal/fs/utils validateOffsetLengthWrite.
  function validateOffsetLengthWrite(offset, length, byteLength) {
    if (offset > byteLength)
      throw errOutOfRange("offset", `<= ${byteLength}`, String(offset));
    if (length > byteLength - offset)
      throw errOutOfRange(
        "length",
        `<= ${byteLength - offset}`,
        String(length),
      );
    if (length < 0) throw errOutOfRange("length", ">= 0", String(length));
    // validateInt32(length, 'length', 0): integer and <= 2^31-1.
    validateIntegerArg(length, "length", 0, 2147483647);
  }
  // Node's internal/fs/utils validateBufferArray (writev): every element
  // must be an ArrayBufferView; the reported value is the whole array.
  function validateBufferArrayShim(buffers) {
    if (
      !Array.isArray(buffers) ||
      buffers.some(
        (b) =>
          !(b instanceof Uint8Array) &&
          !(typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(b)),
      )
    ) {
      throw errInvalidArgType("buffers", "ArrayBufferView[]", buffers);
    }
  }
  // Node's ERR_INVALID_ARG_VALUE, e.g. hex encoding with odd-length data.
  function errInvalidArgValue(name, value, reason) {
    const err = new TypeError(
      `The argument '${name}' ${reason}. Received '${value}'`,
    );
    err.code = "ERR_INVALID_ARG_VALUE";
    return err;
  }
  // Node v24's internal validateEncoding for write paths: only the
  // hex-with-odd-length case throws (unknown encodings are tolerated).
  function validateWriteEncoding(str, encoding) {
    const enc =
      encoding === undefined || encoding === null ? "utf8" : String(encoding);
    if (enc.toLowerCase() === "hex" && str.length % 2 !== 0) {
      throw errInvalidArgValue(
        "encoding",
        encoding,
        `is invalid for data of length ${str.length}`,
      );
    }
  }
  // Node's writeFile/writeFileSync/createWriteStream `flush` option:
  // null/undefined -> false, otherwise must be a boolean.
  function validateFlushOpt(options) {
    const flush =
      options !== null && typeof options === "object"
        ? options.flush
        : undefined;
    if (flush != null && typeof flush !== "boolean")
      throw errInvalidArgType("options.flush", "boolean", flush);
    return flush === true;
  }
  // Shared fs.write / fs.writeSync / FileHandle.write argument parsing,
  // mirroring Node v24 lib/fs.js exactly (including the options-object form
  // `write(fd, buffer, { offset, length, position })`). All validation throws
  // synchronously like Node. Returns
  // { buf, offset, length, position, encoding, callback } where buf is the
  // normalized Buffer/Uint8Array for views and the original string for
  // strings; encoding is set only on the string path.
  function parseWriteArgs(data, args, isAsync) {
    const isStr = typeof data === "string";
    if (!isStr) validateDataArg(data, "buffer");
    let [offset, length, position, callback] = args;
    if (isStr) {
      // ── string path ──
      if (isAsync) {
        if (typeof position !== "function") {
          if (typeof offset === "function") {
            position = offset;
            offset = null;
          } else {
            position = length;
          }
          length = "utf8";
        }
        const encoding = length;
        validateWriteEncoding(data, encoding);
        callback = position;
        if (typeof callback !== "function")
          throw errInvalidArgType("cb", "function", callback);
        position = offset;
        if (typeof position !== "number" || position < 0) position = null;
        return {
          buf: data,
          offset: 0,
          length: undefined,
          position,
          encoding,
          callback,
        };
      }
      const encoding = length;
      validateWriteEncoding(data, encoding);
      position = offset;
      if (typeof position !== "number" || position < 0) position = null;
      return {
        buf: data,
        offset: 0,
        length: undefined,
        position,
        encoding,
        callback: undefined,
      };
    }
    // ── buffer path ──
    if (isAsync) {
      callback ||= position || length || offset;
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
    }
    if (typeof offset === "object") {
      // Named-parameters form (typeof null === "object"; null -> defaults).
      ({
        offset = 0,
        length = data.byteLength - offset,
        position = null,
      } = offset || {});
    }
    if (offset == null || typeof offset === "function") offset = 0;
    else validateIntegerArg(offset, "offset", 0);
    if (typeof length !== "number") length = data.byteLength - offset;
    validateOffsetLengthWrite(offset, length, data.byteLength);
    if (typeof position !== "number" || position < 0) position = null;
    return {
      buf: normalizeDataArg(data),
      offset,
      length,
      position,
      encoding: undefined,
      callback,
    };
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
  // util.promisify(fs.exists) must resolve with the boolean (exists has no
  // err argument, so the default promisify would reject with `true`).
  fs.exists[Symbol.for("nodejs.util.promisify.custom")] = function (p) {
    return new Promise((resolve) => fs.exists(p, resolve));
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
      validatePath(src, "src");
      validatePath(dest, "dest");
      const m = validateCopyFileMode(mode);
      try {
        const r = origSync.call(this, toPathString(src), toPathString(dest), m);
        // Node's copyfile copies the source file's mode onto dest
        // (libuv fchmod(dst, src_st_mode)). memfs's copyFileSync leaves
        // dest at its default mode, so set it explicitly.
        fs.chmodSync(toPathString(dest), fs.statSync(toPathString(src)).mode);
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
      validatePath(src, "src");
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
            // Node's copyfile copies the source file's mode onto dest
            // (libuv fchmod(dst, src_st_mode)). memfs's copyFile leaves
            // dest at its default mode, so set it explicitly.
            try {
              fs.chmodSync(
                toPathString(dest),
                fs.statSync(toPathString(src)).mode,
              );
            } catch (e) {
              return userCb(enrichDestErr(e, "copyFile", src, dest));
            }
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
  // Faithful port of Node v24's cp (lib/internal/fs/cp/cp.js, cp-sync.js and
  // the C++ CpSyncCheckPaths / CpSyncCopyDir / CpSyncOverrideFile), probed
  // against v24.20.0. The async and sync variants genuinely differ:
  //  - filter: cp awaits it; cpSync throws ERR_INVALID_RETURN_VALUE when it
  //    returns a promise.
  //  - top-level src stat for the checks: sync stats lstat when dereference
  //    is set and stat otherwise (inverted vs the async version, which
  //    honors dereference); a symlink src therefore counts as a directory
  //    for the sync checks and needs recursive.
  //  - sync dir copies without a filter run the C++ fast-path semantics:
  //    symlink children are re-created as absolute-resolved symlinks even
  //    with dereference:true; a dest symlink is FOLLOWED (not replaced)
  //    when overwriting with a regular file. With a filter (or async),
  //    symlinks are dereferenced and dest symlinks are unlinked first.
  //  - a new dest dir gets the src mode in async / sync-with-filter, but
  //    not in the sync fast path.
  //  - options are validated synchronously, before the paths (Node order:
  //    callback, options, src, dest).

  function errIncompatibleOptionPair(opt1, opt2) {
    const err = new TypeError(
      `Option "${opt1}" cannot be used in combination with option "${opt2}"`,
    );
    err.code = "ERR_INCOMPATIBLE_OPTION_PAIR";
    return err;
  }
  function errInvalidReturnValue(expected, name, value) {
    let got;
    if (value && value.constructor && value.constructor.name)
      got = `instance of ${value.constructor.name}`;
    else got = `type ${typeof value}`;
    const err = new TypeError(
      `Expected ${expected} to be returned from the "${name}" function but got ${got}.`,
    );
    err.code = "ERR_INVALID_RETURN_VALUE";
    return err;
  }
  function cpIsPromise(v) {
    if (v instanceof Promise) return true;
    return (
      v !== null &&
      (typeof v === "object" || typeof v === "function") &&
      typeof v.then === "function" &&
      v[Symbol.toStringTag] === "Promise"
    );
  }

  const defaultCpOptions = {
    dereference: false,
    errorOnExist: false,
    filter: undefined,
    force: true,
    preserveTimestamps: false,
    recursive: false,
    verbatimSymlinks: false,
  };
  function validateCpMode(mode) {
    if (mode === undefined || mode === null) return 0;
    if (typeof mode !== "number")
      throw errInvalidArgType("mode", "number", mode);
    if (!Number.isInteger(mode) || mode < 0 || mode > 7)
      throw errOutOfRange("mode", ">= 0 && <= 7", mode);
    return mode;
  }
  // Mirrors Node's validateCpOptions (lib/internal/fs/utils.js): defaults,
  // boolean checks per option, mode range, the dereference/verbatimSymlinks
  // pair check, filter-is-function. Never mutates the caller's object
  // (tests wrap it in a mutation-detecting proxy).
  function validateCpOptions(options) {
    if (options === undefined) return { ...defaultCpOptions, mode: 0 };
    if (options === null || typeof options !== "object")
      throw errInvalidArgType("options", "object", options);
    const opts = { ...defaultCpOptions, ...options };
    for (const k of [
      "dereference",
      "errorOnExist",
      "force",
      "preserveTimestamps",
      "recursive",
      "verbatimSymlinks",
    ]) {
      if (typeof opts[k] !== "boolean")
        throw errInvalidArgTypeProp(`options.${k}`, "boolean", opts[k]);
    }
    opts.mode = validateCpMode(options.mode);
    if (opts.dereference && opts.verbatimSymlinks)
      throw errIncompatibleOptionPair("dereference", "verbatimSymlinks");
    if (opts.filter !== undefined && typeof opts.filter !== "function")
      throw errInvalidArgType("options.filter", "function", opts.filter);
    return opts;
  }

  // ── symlink target fidelity ──
  // memfs resolves relative symlink targets against process.cwd() at
  // creation and readlink replays the resolved path; Node stores the target
  // verbatim. Pre-resolve relative targets against the link's own directory
  // (so following the link resolves correctly) and remember the raw target
  // for verbatim readlink — cp's verbatimSymlinks depends on it.
  const symlinkRawTargets = new Map();
  function symlinkMapKey(p) {
    return cpAbsPath(toPathString(p));
  }
  function rememberSymlinkTarget(linkPath, rawTarget) {
    const k = symlinkMapKey(linkPath);
    if (typeof rawTarget === "string") symlinkRawTargets.set(k, rawTarget);
    else symlinkRawTargets.delete(k);
  }
  function forgetSymlinkTargetsUnder(p) {
    const k = symlinkMapKey(p);
    symlinkRawTargets.delete(k);
    const prefix = k.endsWith("/") ? k : k + "/";
    for (const key of [...symlinkRawTargets.keys()]) {
      if (key.startsWith(prefix)) symlinkRawTargets.delete(key);
    }
  }
  function moveSymlinkTarget(oldP, newP) {
    const o = symlinkMapKey(oldP),
      n = symlinkMapKey(newP);
    const oprefix = o.endsWith("/") ? o : o + "/";
    for (const [key, val] of [...symlinkRawTargets.entries()]) {
      if (key === o || key.startsWith(oprefix)) {
        symlinkRawTargets.delete(key);
        symlinkRawTargets.set(key === o ? n : n + key.slice(o.length), val);
      }
    }
  }
  // Resolve a raw link target the way the filesystem does: relative targets
  // are relative to the link's own directory.
  function cpResolveLinkTarget(linkPathStr, rawTarget) {
    const lp = toPathString(linkPathStr);
    return rawTarget.startsWith("/")
      ? cpPosixNormalize(rawTarget)
      : cpPosixNormalize(cpPosixDirname(lp) + "/" + rawTarget);
  }
  // memfs's traversal restarts from root with node.symlink steps, so the
  // node must hold link-dir-resolved absolute steps even when the raw
  // target is relative.
  function cpFixupSymlinkNode(linkPath, rawTarget) {
    try {
      const lp = toPathString(linkPath);
      const link = vol.getLink(lp.split("/").filter(Boolean));
      if (!link) return;
      link.getNode().symlink = cpResolveLinkTarget(lp, rawTarget)
        .split("/")
        .filter(Boolean);
    } catch {}
  }
  function cpReadlinkRaw(p) {
    const raw = symlinkRawTargets.get(symlinkMapKey(p));
    if (raw !== undefined) return raw;
    return vol.readlinkSync(p);
  }
  // readlink returning the verbatim target; self-healing against stale
  // entries (unlink/rm reach vol directly, bypassing the wrapper).
  function readlinkRaw(p) {
    const ps = toPathString(p);
    let lst;
    try {
      lst = vol.lstatSync(ps);
    } catch (e) {
      throw e;
    }
    if (!lst.isSymbolicLink()) {
      symlinkRawTargets.delete(symlinkMapKey(ps));
      return vol.readlinkSync(ps); // throws EINVAL like Node
    }
    return cpReadlinkRaw(ps);
  }

  // ── cp path helpers (posix; memfs paths are posix) ──
  function shimCwd() {
    try {
      if (
        typeof process !== "undefined" &&
        process &&
        typeof process.cwd === "function"
      )
        return process.cwd();
    } catch {}
    return "/";
  }
  function cpPosixNormalize(p) {
    const abs = p.startsWith("/");
    const out = [];
    for (const part of p.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        out.pop();
        continue;
      }
      out.push(part);
    }
    const r = (abs ? "/" : "") + out.join("/");
    return r || (abs ? "/" : ".");
  }
  function cpAbsPath(p) {
    const ps = toPathString(p);
    return cpPosixNormalize(ps.startsWith("/") ? ps : shimCwd() + "/" + ps);
  }
  function cpPosixDirname(p) {
    const ap = cpAbsPath(p);
    const i = ap.lastIndexOf("/");
    if (i <= 0) return "/";
    return ap.slice(0, i);
  }
  // Node's isSrcSubdir: both paths resolved, dest starts with src.
  function cpIsSrcSubdir(s, d) {
    const sArr = cpAbsPath(s).split("/").filter(Boolean);
    const dArr = cpAbsPath(d).split("/").filter(Boolean);
    if (sArr.length > dArr.length) return false;
    return sArr.every((part, i) => dArr[i] === part);
  }
  // The OS reports ENAMETOOLONG for absurd names; memfs just says ENOENT.
  function cpCheckNameLength(p, syscall) {
    const ps = toPathString(p);
    for (const part of ps.split("/")) {
      if (part.length > 255) {
        throw makeFsError("ENAMETOOLONG", syscall, ps, "file name too long");
      }
    }
    if (ps.length > 4096) {
      throw makeFsError("ENAMETOOLONG", syscall, ps, "file name too long");
    }
  }
  // Single-volume equivalent of Node's areIdentical (ino+dev): memfs dev is
  // always 0, but ino uniquely identifies a node in the volume.
  function cpAreIdentical(a, b) {
    return !!(a && b && a.ino && b.ino && a.ino === b.ino);
  }
  function cpErr(code, path, message, errno) {
    const err = makeFsError(code, "cp", path, message);
    // Keep enrichErr from rewriting the syscall to the probed "lstat".
    err._syscallOverride = "cp";
    if (errno !== undefined) err.errno = errno;
    return err;
  }

  // Top-level src/dest checks. isAsync=false reproduces the C++
  // CpSyncCheckPaths (note the inverted src stat vs the async version).
  function cpCheckPaths(s, d, opts, isAsync) {
    const deref = opts.dereference;
    const srcSyscall = isAsync
      ? deref
        ? "stat"
        : "lstat"
      : deref
        ? "lstat"
        : "stat";
    cpCheckNameLength(s, srcSyscall);
    cpCheckNameLength(d, deref ? "stat" : "lstat");
    const srcStatFn = isAsync
      ? deref
        ? (p) => vol.statSync(p)
        : (p) => vol.lstatSync(p)
      : deref
        ? (p) => vol.lstatSync(p)
        : (p) => vol.statSync(p);
    const destStatFn = deref ? (p) => vol.statSync(p) : (p) => vol.lstatSync(p);
    let srcStat;
    try {
      srcStat = srcStatFn(s);
    } catch (e) {
      throw e;
    }
    let destStat = null;
    try {
      destStat = destStatFn(d);
    } catch (e) {
      if (!e || e.code !== "ENOENT") throw e;
    }
    const srcIsDir = isAsync
      ? srcStat.isDirectory()
      : srcStat.isDirectory() || (deref && srcStat.isSymbolicLink());
    if (destStat) {
      if (cpIdenticalCheck(s, d, srcStat, destStat, isAsync)) {
        throw cpErr(
          "ERR_FS_CP_EINVAL",
          d,
          "src and dest cannot be the same",
          22,
        );
      }
      const destIsDir = destStat.isDirectory();
      if (srcIsDir && !destIsDir) {
        throw cpErr(
          "ERR_FS_CP_DIR_TO_NON_DIR",
          d,
          `cannot overwrite non-directory ${d} with directory ${s}`,
          21,
        );
      }
      if (!srcIsDir && destIsDir) {
        throw cpErr(
          "ERR_FS_CP_NON_DIR_TO_DIR",
          d,
          `cannot overwrite directory ${d} with non-directory ${s}`,
          20,
        );
      }
    }
    if (srcIsDir && cpIsSrcSubdir(s, d)) {
      throw cpErr(
        "ERR_FS_CP_EINVAL",
        d,
        `cannot copy ${s} to a subdirectory of self ${d}`,
        22,
      );
    }
    return { srcStat, destStat, srcIsDir };
  }
  function cpIdenticalCheck(s, d, srcStat, destStat, isAsync) {
    if (isAsync) return cpAreIdentical(srcStat, destStat);
    // C++ equivalent(): follows symlinks on both sides.
    let a = null,
      b = null;
    try {
      a = vol.statSync(s);
    } catch {}
    try {
      b = vol.statSync(d);
    } catch {}
    if (!a || !b) return false;
    return cpAreIdentical(a, b);
  }
  // Node's checkParentPaths (async) / the C++ equivalent() parent walk
  // (sync): walk dest's parents following symlinks, comparing against src.
  // compareStat: async → checkPaths' srcStat; sync → following stat of src
  // (null when that stat fails, matching the C++ early break).
  function cpCheckParentPaths(s, d, compareStat, isAsync) {
    if (!compareStat) return;
    const srcParent = cpPosixDirname(s);
    let destParent = cpPosixDirname(d);
    let guard = 0;
    while (destParent !== srcParent && destParent !== "/" && guard++ < 512) {
      let st = null;
      try {
        st = vol.statSync(destParent);
      } catch (e) {
        // async: only ENOENT stops the walk; sync (C++): any stat error.
        if (isAsync && (!e || e.code !== "ENOENT")) throw e;
        return;
      }
      if (cpAreIdentical(compareStat, st)) {
        throw cpErr(
          "ERR_FS_CP_EINVAL",
          d,
          `cannot copy ${s} to a subdirectory of self ${d}`,
          22,
        );
      }
      const next = cpPosixDirname(destParent);
      if (next === destParent) return;
      destParent = next;
    }
  }
  function cpMkdirParent(d) {
    const parent = cpPosixDirname(d);
    try {
      vol.mkdirSync(parent, { recursive: true });
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
    }
  }
  function cpFilterCheckSync(filter, from, to) {
    const r = filter(from, to);
    if (cpIsPromise(r)) throw errInvalidReturnValue("boolean", "filter", r);
    return !!r;
  }

  // Set times with ms precision. memfs's utimesSync round-trips through
  // float seconds (new Date(sec * 1000)) and loses milliseconds, so write
  // the node times directly (same technique as lutimesImpl).
  function cpSetTimesExact(d, s) {
    let st;
    try {
      st = vol.statSync(s);
    } catch {
      return;
    }
    try {
      const link = vol.getLink(toPathString(d).split("/").filter(Boolean));
      if (!link) return;
      const node = link.getNode();
      node.atime = new Date(st.atimeMs);
      node.mtime = new Date(st.mtimeMs);
    } catch {}
  }
  function cpHandleTimestamps(srcMode, s, d) {
    // Node makes the dest writable before utimes (EPERM otherwise on
    // readonly files), then sets times, then restores the src mode.
    // Order note: memfs's chmod touches mtime (real chmod only touches
    // ctime), so the exact times must be written LAST.
    if ((srcMode & 0o200) === 0) {
      try {
        vol.chmodSync(d, srcMode | 0o200);
      } catch {}
    }
    try {
      vol.chmodSync(d, srcMode);
    } catch {}
    cpSetTimesExact(d, s);
  }
  // COPYFILE_FICLONE_FORCE: a virtual FS has no copy-on-write reflinks —
  // fail honestly (ENOTSUP, syscall 'copyfile'), like Node on a platform
  // without CoW support. Plain COPYFILE_FICLONE falls back to a regular
  // copy, exactly like Node (test-fs-cp-{sync,async,promises}-mode-flags).
  function cpThrowIfFicloneForce(s, d, opts) {
    if (opts.mode & fs.constants.COPYFILE_FICLONE_FORCE) {
      const err = new Error(
        `ENOTSUP: operation not supported, copyfile '${s}' -> '${d}'`,
      );
      err.code = "ENOTSUP";
      err.errno = -95;
      err.syscall = "copyfile";
      err.path = s;
      // enrichErr would otherwise rewrite the syscall to the cp
      // boundary's canonical 'lstat'.
      err._syscallOverride = "copyfile";
      throw err;
    }
  }
  function cpCopyFile(s, d, srcStat, opts) {
    cpThrowIfFicloneForce(s, d, opts);
    vol.copyFileSync(s, d, opts.mode);
    // Node's copy leaves dest with the src mode exactly (probed: 0o666
    // survives a 007 umask); memfs does not preserve it.
    try {
      vol.chmodSync(d, srcStat.mode);
    } catch {}
    if (opts.preserveTimestamps) cpHandleTimestamps(srcStat.mode, s, d);
  }
  // Top-level / JS-path file copy: Node unlinks dest first (async
  // mayCopyFile / C++ CpSyncOverrideFile), so a dest symlink is replaced
  // rather than followed.
  function cpOnFile(s, d, srcStat, destStat, opts) {
    if (!destStat) {
      cpCopyFile(s, d, srcStat, opts);
      return;
    }
    if (opts.force) {
      try {
        vol.unlinkSync(d);
      } catch (e) {
        if (!e || e.code !== "ENOENT") throw e;
      }
      cpCopyFile(s, d, srcStat, opts);
      return;
    }
    if (opts.errorOnExist) {
      throw cpErr("ERR_FS_CP_EEXIST", d, `${d} already exists`, 17);
    }
    // !force && !errorOnExist: skip silently.
  }
  function cpSymlinkStore(target, d) {
    // target is what readlink(dest) must return (resolved absolute for the
    // default mode, raw for verbatim). memfs resolves relative targets
    // against process.cwd() at creation, so pre-resolve against the link's
    // dir for the stored node and fix up traversal steps.
    const store = target.startsWith("/")
      ? target
      : cpAbsPath(cpPosixDirname(d) + "/" + target);
    vol.symlinkSync(store, d);
    rememberSymlinkTarget(d, target);
    cpFixupSymlinkNode(d, target);
  }
  // Shared JS onLink (async cp.js and sync cp-sync.js are identical here).
  function cpOnLink(s, d, destStat, opts) {
    const rawSrc = readlinkRaw(s);
    let resolvedSrc = rawSrc;
    if (!opts.verbatimSymlinks && !resolvedSrc.startsWith("/")) {
      resolvedSrc = cpAbsPath(cpPosixDirname(s) + "/" + resolvedSrc);
    }
    if (!destStat) {
      cpSymlinkStore(resolvedSrc, d);
      return;
    }
    let resolvedDest;
    try {
      resolvedDest = readlinkRaw(d);
    } catch (e) {
      if (e && (e.code === "EINVAL" || e.code === "UNKNOWN")) {
        // Dest exists and is not a symlink: symlink() throws EEXIST.
        cpSymlinkStore(resolvedSrc, d);
        return;
      }
      throw e;
    }
    if (!resolvedDest.startsWith("/")) {
      resolvedDest = cpAbsPath(cpPosixDirname(d) + "/" + resolvedDest);
    }
    let srcIsDir = false;
    try {
      srcIsDir = vol.statSync(s).isDirectory();
    } catch {}
    if (srcIsDir && cpIsSrcSubdir(resolvedSrc, resolvedDest)) {
      throw cpErr(
        "ERR_FS_CP_EINVAL",
        d,
        `cannot copy ${resolvedSrc} to a subdirectory of self ${resolvedDest}`,
        22,
      );
    }
    let destIsDir = false;
    try {
      destIsDir = vol.statSync(d).isDirectory();
    } catch {}
    if (destIsDir && cpIsSrcSubdir(resolvedDest, resolvedSrc)) {
      throw cpErr(
        "ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY",
        d,
        `cannot overwrite ${resolvedDest} with ${resolvedSrc}`,
        22,
      );
    }
    try {
      vol.unlinkSync(d);
    } catch (e) {
      if (!e || e.code !== "ENOENT") throw e;
    }
    cpSymlinkStore(resolvedSrc, d);
  }
  function cpOnDir(s, d, srcStat, destStat, opts, isAsync) {
    const useJsPath = isAsync || !!opts.filter;
    const doChmod = () => {
      try {
        vol.chmodSync(d, srcStat.mode);
      } catch {}
    };
    if (!destStat) {
      if (useJsPath) {
        // async mkDirAndCopy / sync-with-filter copyDir(mkDir): mkdir,
        // copy, then chmod the new dir to the src mode.
        vol.mkdirSync(d);
        if (isAsync) return cpCopyDir(s, d, opts, isAsync).then(doChmod);
        cpCopyDir(s, d, opts, isAsync);
        doChmod();
        return;
      }
      // sync fast path (C++ CpSyncCopyDir): no chmod of the new dir.
      cpCopyDirFast(s, d, opts);
      return;
    }
    if (isAsync && opts.errorOnExist && !opts.force) {
      throw cpErr("ERR_FS_CP_EEXIST", d, `${d} already exists`, 17);
    }
    if (useJsPath) {
      if (isAsync) return cpCopyDir(s, d, opts, isAsync);
      cpCopyDir(s, d, opts, isAsync);
      return;
    }
    cpCopyDirFast(s, d, opts);
  }
  function cpCopyDir(s, d, opts, isAsync) {
    if (isAsync) return cpCopyDirAsync(s, d, opts);
    return cpCopyDirSyncFiltered(s, d, opts);
  }
  async function cpCopyDirAsync(s, d, opts) {
    const sp = cpDirPhys(s, opts);
    const names = vol.readdirSync(sp);
    for (const name of names) {
      const si = s + "/" + name;
      const di = d + "/" + name;
      // async checkPaths: filter (awaited) + full checks, no parent walk.
      if (opts.filter && !(await opts.filter(si, di))) continue;
      const { srcStat, destStat } = cpCheckPaths(si, di, opts, true);
      await cpGetStatsForCopy(si, di, srcStat, destStat, opts, true);
    }
  }
  function cpCopyDirSyncFiltered(s, d, opts) {
    const sp = cpDirPhys(s, opts);
    const names = vol.readdirSync(sp);
    const statFn = opts.dereference
      ? (p) => vol.statSync(p)
      : (p) => vol.lstatSync(p);
    for (const name of names) {
      const si = s + "/" + name;
      const di = d + "/" + name;
      if (!cpFilterCheckSync(opts.filter, si, di)) continue;
      // Node's sync-with-filter getStats: stat-only dispatch, no checkPaths.
      let srcStat;
      try {
        srcStat = statFn(si);
      } catch (e) {
        throw e;
      }
      let destStat = null;
      try {
        destStat = statFn(di);
      } catch (e) {
        if (!e || e.code !== "ENOENT") throw e;
      }
      cpGetStatsForCopy(si, di, srcStat, destStat, opts, false);
    }
  }
  // Resolve symlink components for memfs traversal: memfs's lstatSync
  // cannot traverse a symlinked dir, and its realpath mishandles
  // link/child. Only needed with dereference (otherwise symlinked dirs
  // are copied as links, never traversed).
  function cpDirPhys(s, opts) {
    if (!opts.dereference) return s;
    let cur = s;
    for (let i = 0; i < 40; i++) {
      let lst;
      try {
        lst = vol.lstatSync(cur);
      } catch {
        return cur;
      }
      if (!lst.isSymbolicLink()) return cur;
      const raw = readlinkRaw(cur);
      cur = raw.startsWith("/")
        ? raw
        : cpAbsPath(cpPosixDirname(cur) + "/" + raw);
    }
    return cur;
  }
  function cpGetStatsForCopy(s, d, srcStat, destStat, opts, isAsync) {
    if (srcStat.isDirectory() && opts.recursive) {
      return cpOnDir(s, d, srcStat, destStat, opts, isAsync);
    }
    if (srcStat.isDirectory()) {
      throw cpErr(
        "ERR_FS_EISDIR",
        s,
        isAsync
          ? `${s} is a directory (not copied)`
          : `Recursive option not enabled, cannot copy a directory: ${s}`,
        21,
      );
    }
    if (srcStat.isFile()) {
      cpOnFile(s, d, srcStat, destStat, opts);
      return;
    }
    if (srcStat.isSymbolicLink()) {
      cpOnLink(s, d, destStat, opts);
      return;
    }
    if (typeof srcStat.isSocket === "function" && srcStat.isSocket()) {
      throw cpErr("ERR_FS_CP_SOCKET", d, `cannot copy a socket file: ${d}`, 22);
    }
    if (typeof srcStat.isFIFO === "function" && srcStat.isFIFO()) {
      throw cpErr(
        "ERR_FS_CP_FIFO_PIPE",
        d,
        `cannot copy a FIFO pipe: ${d}`,
        22,
      );
    }
    throw cpErr(
      "ERR_FS_CP_UNKNOWN",
      d,
      `cannot copy an unknown file type: ${d}`,
      22,
    );
  }
  // Sync fast path (C++ CpSyncCopyDir) for filter-less dir copies.
  function cpCopyDirFast(s, d, opts) {
    const sp = cpDirPhys(s, opts);
    try {
      vol.mkdirSync(d, { recursive: true });
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
    }
    const names = vol.readdirSync(sp);
    for (const name of names) {
      const spi = sp + "/" + name;
      const di = d + "/" + name;
      const lst = vol.lstatSync(spi);
      if (lst.isSymbolicLink()) {
        let childIsDir = false;
        try {
          childIsDir = vol.statSync(spi).isDirectory();
        } catch {}
        cpFastLink(spi, di, opts, childIsDir);
      } else if (lst.isDirectory()) {
        try {
          vol.mkdirSync(di);
        } catch (e) {
          if (!e || e.code !== "EEXIST") throw e;
        }
        cpCopyDirFast(spi, di, opts);
      } else {
        cpFastFile(spi, di, opts);
      }
    }
  }
  function cpFastFile(s, d, opts) {
    cpThrowIfFicloneForce(s, d, opts);
    // C++ file_copy_opts: force → overwrite_existing; errorOnExist &&
    // !force → EEXIST; else skip_existing.
    let destStat = null;
    try {
      destStat = vol.lstatSync(d);
    } catch (e) {
      if (!e || e.code !== "ENOENT") throw e;
    }
    if (destStat) {
      if (!opts.force) {
        if (opts.errorOnExist) {
          throw cpErr("ERR_FS_CP_EEXIST", d, `${d} already exists`, 17);
        }
        return;
      }
      // force: C++ overwrites in place — a dest symlink is FOLLOWED, not
      // replaced (memfs copyFileSync follows dest symlinks too).
    }
    const srcStat = vol.statSync(s);
    vol.copyFileSync(s, d, opts.mode);
    try {
      vol.chmodSync(d, srcStat.mode);
    } catch {}
    if (opts.preserveTimestamps) cpHandleTimestamps(srcStat.mode, s, d);
  }
  function cpFastLink(s, d, opts, childIsDir) {
    const rawTarget = readlinkRaw(s);
    if (opts.verbatimSymlinks) {
      let exists = false;
      try {
        vol.lstatSync(d);
        exists = true;
      } catch {}
      if (exists) {
        throw cpErr("EEXIST", d, "file already exists");
      }
      cpSymlinkStore(rawTarget, d);
      return;
    }
    const targetAbs = rawTarget.startsWith("/")
      ? rawTarget
      : cpAbsPath(cpPosixDirname(s) + "/" + rawTarget);
    let destStat = null;
    try {
      destStat = vol.lstatSync(d);
    } catch (e) {
      if (!e || e.code !== "ENOENT") throw e;
    }
    if (destStat) {
      if (destStat.isSymbolicLink()) {
        const rawDest = readlinkRaw(d);
        const destTargetAbs = rawDest.startsWith("/")
          ? rawDest
          : cpAbsPath(cpPosixDirname(d) + "/" + rawDest);
        if (
          !opts.dereference &&
          childIsDir &&
          cpIsSrcSubdir(targetAbs, destTargetAbs)
        ) {
          throw cpErr(
            "ERR_FS_CP_EINVAL",
            d,
            `cannot copy ${targetAbs} to a subdirectory of self ${destTargetAbs}`,
            22,
          );
        }
        let destIsDir = false;
        try {
          destIsDir = vol.statSync(d).isDirectory();
        } catch {}
        if (destIsDir && cpIsSrcSubdir(destTargetAbs, targetAbs)) {
          throw cpErr(
            "ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY",
            d,
            `cannot overwrite ${destTargetAbs} with ${targetAbs}`,
            22,
          );
        }
        try {
          vol.unlinkSync(d);
        } catch (e) {
          if (!e || e.code !== "ENOENT") throw e;
        }
      } else {
        // Regular file or dir: EEXIST (C++ throws, or the OS-level
        // create_symlink fails over an existing path).
        throw cpErr("EEXIST", d, "file already exists");
      }
    }
    vol.symlinkSync(targetAbs, d);
    forgetSymlinkTargetsUnder(d);
  }
  function cpCheckFileType(srcStat, d) {
    if (srcStat.isDirectory() || srcStat.isFile() || srcStat.isSymbolicLink())
      return;
    if (typeof srcStat.isSocket === "function" && srcStat.isSocket()) {
      throw cpErr("ERR_FS_CP_SOCKET", d, `cannot copy a socket file: ${d}`, 22);
    }
    if (typeof srcStat.isFIFO === "function" && srcStat.isFIFO()) {
      throw cpErr(
        "ERR_FS_CP_FIFO_PIPE",
        d,
        `cannot copy a FIFO pipe: ${d}`,
        22,
      );
    }
    throw cpErr(
      "ERR_FS_CP_UNKNOWN",
      d,
      `cannot copy an unknown file type: ${d}`,
      22,
    );
  }
  function cpDispatch(s, d, destStat, opts, isAsync) {
    const statFn = opts.dereference
      ? (p) => vol.statSync(p)
      : (p) => vol.lstatSync(p);
    return cpGetStatsForCopy(s, d, statFn(s), destStat, opts, isAsync);
  }
  function cpSyncTop(s, d, opts) {
    if (opts.filter && !cpFilterCheckSync(opts.filter, s, d)) return;
    const { srcStat, destStat, srcIsDir } = cpCheckPaths(s, d, opts, false);
    // C++ parent walk uses a following stat of src (null → skip, like the
    // C++ early break on error).
    let compareStat = null;
    try {
      compareStat = vol.statSync(s);
    } catch {}
    cpCheckParentPaths(s, d, compareStat, false);
    if (srcIsDir && !opts.recursive) {
      throw cpErr(
        "ERR_FS_EISDIR",
        s,
        `Recursive option not enabled, cannot copy a directory: ${s}`,
        21,
      );
    }
    // C++ type switch (socket/fifo/unknown) runs before dest parent setup.
    cpCheckFileType(srcStat, d);
    cpMkdirParent(d);
    cpDispatch(s, d, destStat, opts, false);
  }
  async function cpAsyncTop(s, d, opts) {
    if (opts.filter && !(await opts.filter(s, d))) return;
    const { srcStat, destStat } = cpCheckPaths(s, d, opts, true);
    cpCheckParentPaths(s, d, srcStat, true);
    cpMkdirParent(d);
    await cpDispatch(s, d, destStat, opts, true);
  }
  fs.cpSync = function (src, dest, options) {
    const opts = validateCpOptions(options);
    validatePath(src);
    validatePath(dest, "dest");
    try {
      cpSyncTop(toPathString(src), toPathString(dest), opts);
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
    const opts = validateCpOptions(options);
    validatePath(src);
    validatePath(dest, "dest");
    const s = toPathString(src),
      d = toPathString(dest);
    nextTick(() => {
      cpAsyncTop(s, d, opts).then(
        () => {
          emitFs("fs", "cp", src, undefined);
          callback(null);
        },
        (e) => callback(enrichErr(e, "cp")),
      );
    });
  };

  // Node validates the encoding (string options, or options.encoding) via
  // getOptions BEFORE the path: an unknown encoding is a synchronous
  // ERR_INVALID_ARG_VALUE TypeError (test-fs-assert-encoding-error.js).
  function validateEncodingOpt(options, allowBuffer) {
    const enc =
      typeof options === "string"
        ? options
        : options !== null && typeof options === "object"
          ? options.encoding
          : undefined;
    if (enc === undefined || enc === null) return;
    // 'buffer' is a valid pseudo-encoding for realpath/readlink/mkdtemp.
    if (allowBuffer && enc === "buffer") return;
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

  // writeFileSync/appendFileSync with { flush: true }: open, write, fsync
  // (through the fs object so spies observe it), close. `existed` mirrors
  // the umask fix-up in the shared wrapper.
  function writeFileSyncWithFlush(fp, data, options, syncName, existed) {
    const isUserFd = typeof fp === "number";
    const opts = options !== null && typeof options === "object" ? options : {};
    const flag = syncName === "appendFileSync" ? "a" : opts.flag || "w";
    const fd = isUserFd ? fp : vol.openSync(fp, flag, opts.mode || 0o666);
    try {
      if (isUserFd && syncName === "appendFileSync") {
        const st = vol.fstatSync(fd);
        vol.writeSync(fd, data, 0, data.byteLength, st.size);
      } else {
        vol.writeSync(fd, data, 0, data.byteLength, null);
      }
      fs.fsyncSync(fd);
    } finally {
      if (!isUserFd) {
        try {
          vol.closeSync(fd);
        } catch {}
      }
    }
    if (!existed && !isUserFd && opts.mode === undefined) {
      try {
        vol.chmodSync(fp, applyUmask(0o666));
      } catch {}
    }
  }
  // ── readFile/writeFile/appendFile: accept fd-or-path ──
  function fileArg(p) {
    if (typeof p === "number") return p;
    validatePath(p);
    return toPathString(p);
  }
  function hasReadFileBufferOpt(options) {
    return (
      options !== null &&
      typeof options === "object" &&
      options.buffer !== undefined
    );
  }
  function normalizeReadFileOptions(options) {
    if (options === undefined || options === null) return {};
    if (typeof options === "string") return { encoding: options };
    return options;
  }
  // Manual readFile core: fd (reads from the CURRENT position, unlike
  // memfs's position-0 read) or path, with Node v24's `buffer` option
  // (Buffer or (size) => Buffer). `fp` is a validated fd or path string.
  function readFileSyncManual(fp, options) {
    options = normalizeReadFileOptions(options);
    validateReadFileBufferOptions(options);
    const isUserFd = typeof fp === "number";
    const fd = isUserFd ? fp : vol.openSync(fp, options.flag || "r");
    try {
      checkFdReadable(fd, "read");
      const st = vol.fstatSync(fd);
      if (st.size > 2 ** 31 - 1) {
        const err = new RangeError(
          `File size (${st.size}) is greater than 2 GiB`,
        );
        err.code = "ERR_FS_FILE_TOO_LARGE";
        throw err;
      }
      const size = st.isFile() ? st.size : 0;
      const hasUserBuffer = options.buffer !== undefined;
      let buffer;
      let buffers;
      if (hasUserBuffer) {
        buffer = getReadFileBuffer(options, size);
      } else if (size === 0) {
        buffers = [];
      } else {
        buffer = allocReadBuffer(size);
      }
      let pos = 0;
      let bytesRead;
      if (hasUserBuffer) {
        if (size !== 0) {
          do {
            bytesRead = readMemfs(fd, buffer, pos, size - pos, -1, "read");
            pos += bytesRead;
          } while (bytesRead !== 0 && pos < size);
        } else {
          // Unknown size (pipes, fstat tricks): fill the user buffer,
          // then probe one extra byte for the too-small error.
          while (pos < buffer.byteLength) {
            bytesRead = readMemfs(
              fd,
              buffer,
              pos,
              buffer.byteLength - pos,
              -1,
              "read",
            );
            pos += bytesRead;
            if (bytesRead === 0) break;
          }
          const extra = allocReadBuffer(1);
          bytesRead = readMemfs(fd, extra, 0, 1, -1, "read");
          if (bytesRead !== 0) {
            throw readFileBufferTooSmallError(
              getReadFileBufferByteLengthName(options),
              buffer.byteLength,
            );
          }
        }
      } else if (size !== 0) {
        do {
          bytesRead = readMemfs(fd, buffer, pos, size - pos, -1, "read");
          pos += bytesRead;
        } while (bytesRead !== 0 && pos < size);
      } else {
        do {
          buffer = allocReadBuffer(8192);
          bytesRead = readMemfs(fd, buffer, 0, 8192, -1, "read");
          if (bytesRead !== 0) buffers.push(buffer.subarray(0, bytesRead));
          pos += bytesRead;
        } while (bytesRead !== 0);
      }
      let result;
      if (hasUserBuffer) result = buffer.subarray(0, pos);
      else if (size === 0) {
        result =
          typeof Buffer !== "undefined"
            ? Buffer.concat(buffers, pos)
            : buffers.reduce((acc, b) => {
                const out = new Uint8Array(acc.length + b.length);
                out.set(acc, 0);
                out.set(b, acc.length);
                return out;
              }, new Uint8Array(0));
      } else if (pos < size) result = buffer.subarray(0, pos);
      else result = buffer;
      if (options.encoding) result = result.toString(options.encoding);
      return result;
    } finally {
      if (!isUserFd) {
        try {
          vol.closeSync(fd);
        } catch {}
      }
    }
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
      if (syncName === "readFileSync" && typeof fp === "number") {
        getValidatedFd(fp);
      }
      if (
        syncName === "readFileSync" &&
        (typeof fp === "number" || hasReadFileBufferOpt(rest[0]))
      ) {
        // fd reads from the current position (memfs reads from 0); the
        // `buffer` option needs the manual path too.
        let result;
        try {
          result = readFileSyncManual(fp, rest[0]);
        } catch (e) {
          throw enrichErr(e, syncName);
        }
        emitFs("fs", syncName, p, result);
        return result;
      }
      // memfs doesn't apply the umask on file creation; fix the mode if we
      // created the file and no explicit mode was given.
      let existed = true;
      try {
        vol.statSync(fp);
      } catch {
        existed = false;
      }
      // writeFile/appendFile `flush` option (Node v22+): validate the flag,
      // then write + fsync through the fs object (so spies observe it).
      let flush = false;
      if (syncName === "writeFileSync" || syncName === "appendFileSync") {
        const options = rest[1];
        flush =
          options !== null && typeof options === "object"
            ? (options.flush ?? false)
            : false;
        validateBoolean(flush, "options.flush");
      }
      let result;
      try {
        if (flush) {
          writeFileSyncWithFlush(fp, data, rest[1], syncName, existed);
        } else {
          // readFileSync: fail fast with ERR_FS_FILE_TOO_LARGE for files
          // > 2GiB (test-fs-readfile.js). The manual path above already
          // checks; this covers the memfs fast path for path args.
          if (syncName === "readFileSync" && typeof fp !== "number") {
            try {
              const st = vol.statSync(fp);
              if (st.size > 2 ** 31 - 1) {
                const err = new RangeError(
                  `File size (${st.size}) is greater than 2 GiB`,
                );
                err.code = "ERR_FS_FILE_TOO_LARGE";
                throw err;
              }
            } catch (e) {
              if (e.code === "ERR_FS_FILE_TOO_LARGE") throw e;
              // stat failed (e.g. ENOENT) — let origSync produce the error.
            }
          }
          result = origSync.call(this, fp, data, ...rest.slice(1));
        }
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
      if (
        cbName === "readFile" &&
        (typeof fp === "number" || hasReadFileBufferOpt(args[0]))
      ) {
        // fd reads from the current position; the `buffer` option needs
        // the manual path too. Async via nextTick (memfs is synchronous).
        nextTick(() => {
          let result;
          try {
            if (typeof fp === "number") getValidatedFd(fp);
            result = readFileSyncManual(fp, args[0]);
          } catch (e) {
            callback(enrichErr(e, cbName));
            return;
          }
          emitFs("fs", cbName, p, result);
          callback(null, result);
        });
        return;
      }
      if (cbName === "writeFile" || cbName === "appendFile") {
        // `flush` validated synchronously (Node's getOptions order); the
        // manual dance runs async.
        const options = args[1];
        const flush =
          options !== null && typeof options === "object"
            ? (options.flush ?? false)
            : false;
        validateBoolean(flush, "options.flush");
        if (flush) {
          writeFileWithFlushAsync(fp, args[0], options, cbName, callback, p);
          return;
        }
      }
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

  // writeFile/appendFile with { flush: true } (async): open, write, fsync
  // via the fs object (so spies observe fs.fsync), close.
  function writeFileWithFlushAsync(fp, data, options, cbName, callback, p) {
    const isUserFd = typeof fp === "number";
    const opts = options !== null && typeof options === "object" ? options : {};
    const flag = cbName === "appendFile" ? "a" : opts.flag || "w";
    let fd;
    try {
      fd = isUserFd ? fp : vol.openSync(fp, flag, opts.mode || 0o666);
    } catch (e) {
      nextTick(callback, enrichErr(e, cbName));
      return;
    }
    const done = (err) => {
      if (!isUserFd) {
        try {
          vol.closeSync(fd);
        } catch {}
      }
      if (err) {
        callback(enrichErr(err, cbName));
        return;
      }
      emitFs("fs", cbName, p, undefined);
      callback(null);
    };
    nextTick(() => {
      try {
        if (isUserFd && cbName === "appendFile") {
          const st = vol.fstatSync(fd);
          vol.writeSync(fd, data, 0, data.byteLength, st.size);
        } else {
          vol.writeSync(fd, data, 0, data.byteLength, null);
        }
      } catch (e) {
        done(e);
        return;
      }
      try {
        fs.fsync(fd, (syncErr) => done(syncErr));
      } catch (e) {
        done(e);
      }
    });
  }

  // ── opendir/opendirSync + Dir (auto-close after for-await) ──
  function dirClosedError() {
    const err = new Error("Directory is closed");
    err.code = "ERR_DIR_CLOSED";
    return err;
  }
  function dirConcurrentError() {
    const err = new Error(
      "Cannot do synchronous work on directory handle with concurrent asynchronous operations",
    );
    err.code = "ERR_DIR_CONCURRENT_OPERATION";
    return err;
  }
  class Dir {
    constructor(path) {
      if (arguments.length === 0) {
        const err = new TypeError('The "path" argument must be specified');
        err.code = "ERR_MISSING_ARGS";
        throw err;
      }
      this._path = path;
      this._closed = false;
      this._entries = null;
      this._readInFlight = false;
    }
    _ensure() {
      if (this._closed) throw dirClosedError();
      if (!this._entries) {
        const names = vol.readdirSync(this._path);
        this._entries = names.map((name) => {
          let mode = 0;
          try {
            mode = vol.lstatSync(this._path + "/" + name).mode;
          } catch {
            /* ignore */
          }
          return new Dirent(name, modeToDirentType(mode), this.path);
        });
        this._index = 0;
      }
    }
    readSync() {
      if (this._readInFlight) throw dirConcurrentError();
      this._ensure();
      if (this._index >= this._entries.length) return null;
      return this._entries[this._index++];
    }
    read(callback) {
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      this._readInFlight = true;
      nextTick(() => {
        this._readInFlight = false;
        try {
          callback(null, this.readSync());
        } catch (e) {
          callback(e);
        }
      });
    }
    closeSync() {
      if (this._readInFlight) throw dirConcurrentError();
      if (this._closed) throw dirClosedError();
      this._closed = true;
      emitFs("fs", "Dir.closeSync", this._path, undefined);
    }
    close(callback) {
      if (callback === undefined)
        return Promise.resolve().then(() => this.closeSync());
      if (typeof callback !== "function")
        throw errInvalidArgType("callback", "function", callback);
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
  // Real Node exposes Dir#path as a prototype getter that throws
  // ERR_INVALID_THIS when accessed on anything but a Dir instance.
  Object.defineProperty(Dir.prototype, "path", {
    enumerable: false,
    configurable: true,
    get() {
      if (!(this instanceof Dir)) {
        const err = new TypeError('Value of "this" must be of type Dir');
        err.code = "ERR_INVALID_THIS";
        throw err;
      }
      return this._path;
    },
  });
  fs.Dir = Dir;
  // Mirrors Node's opendir options validation: encoding via assertEncoding,
  // bufferSize must be a number in [1, 4294967295] (integer).
  function validateOpendirOptions(options) {
    validateEncodingOpt(options);
    const bufferSize =
      options !== null && typeof options === "object"
        ? options.bufferSize
        : undefined;
    if (bufferSize === undefined) return;
    if (typeof bufferSize !== "number") {
      // Same "property" phrasing Node uses for options.bufferSize.
      const what =
        bufferSize === null
          ? "null"
          : typeof bufferSize === "object"
            ? `an instance of ${bufferSize.constructor ? bufferSize.constructor.name : "Object"}`
            : `type ${typeof bufferSize} (${typeof bufferSize === "string" ? `'${bufferSize}'` : String(bufferSize)})`;
      const err = new TypeError(
        `The "options.bufferSize" property must be of type number. Received ${what}`,
      );
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    if (!Number.isInteger(bufferSize)) {
      const err = new RangeError(
        `The value of "options.bufferSize" is out of range. It must be an integer. Received ${bufferSize}`,
      );
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    if (bufferSize < 1 || bufferSize > 4294967295) {
      const err = new RangeError(
        `The value of "options.bufferSize" is out of range. It must be >= 1 && <= 4294967295. Received ${bufferSize}`,
      );
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
  }
  fs.opendirSync = function (p, options) {
    validatePath(p);
    validateOpendirOptions(options);
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
    // Node order: path, options (encoding/bufferSize), callback.
    validatePath(p);
    validateOpendirOptions(options);
    if (typeof callback !== "function")
      throw errInvalidArgType("callback", "function", callback);
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
  // Sync port of Node's internal glob walker (lib/internal/fs/glob.js, v24):
  // a queue of (path, patterns); each pattern is a minimatch segment list of
  // literal strings, RegExps (magic), or GLOBSTAR (**). Symlinked dirs are
  // descended at most once per pattern chain (Node's symlinks-set rule);
  // followSymlinks:true switches to realpath cycle detection.

  function gNormalize(p) {
    return posixNormalize(p);
  }
  function gJoin(a, b) {
    if (b.startsWith("/")) return gNormalize(b);
    if (b === "") return gNormalize(a);
    return gNormalize(a + "/" + b);
  }
  function gResolve(root, p) {
    return p.startsWith("/") ? gNormalize(p) : gNormalize(root + "/" + p);
  }
  function gBasename(p) {
    const i = p.lastIndexOf("/");
    return i < 0 ? p : p.slice(i + 1);
  }
  function gDirname(p) {
    const i = p.lastIndexOf("/");
    if (i < 0) return ".";
    if (i === 0) return "/";
    return p.slice(0, i);
  }

  class GlobPattern {
    constructor(segs, globStrings) {
      this.segs = segs;
      this.globStrings = globStrings;
      this.indexes = new Set([0]);
      this.symlinks = new Set();
      this.realpaths = new Set();
      this.last = segs.length - 1;
    }
    at(i) {
      if (i < 0) i = this.segs.length + i;
      return this.segs[i];
    }
    isLast(isDirectory) {
      return (
        this.indexes.has(this.last) ||
        (this.at(-1) === "" &&
          isDirectory &&
          this.indexes.has(this.last - 1) &&
          this.at(-2) === GLOBSTAR)
      );
    }
    isFirst() {
      return this.indexes.has(0);
    }
    get hasSeenSymlinks() {
      for (const i of this.indexes) if (!this.symlinks.has(i)) return true;
      return false;
    }
    child(indexes, symlinks, realpaths) {
      const p = new GlobPattern(this.segs, this.globStrings);
      p.indexes = indexes;
      p.symlinks = symlinks === undefined ? new Set() : symlinks;
      p.realpaths = realpaths === undefined ? this.realpaths : realpaths;
      return p;
    }
    test(index, name) {
      if (index > this.segs.length) return false;
      const s = this.segs[index];
      if (s === GLOBSTAR) return true;
      if (typeof s === "string") return s === name;
      if (s instanceof RegExp) return s.test(name);
      return false;
    }
    cacheKey(index) {
      let key = "";
      for (let i = index; i < this.globStrings.length; i++) {
        key += this.globStrings[i];
        if (i !== this.globStrings.length - 1) key += "/";
      }
      return key;
    }
  }

  function globImpl(patterns, options) {
    let pats;
    if (typeof patterns === "string") pats = [patterns];
    else if (Array.isArray(patterns)) {
      pats = patterns;
      for (let i = 0; i < pats.length; i++) {
        if (typeof pats[i] !== "string")
          throw errInvalidArgType(`patterns[${i}]`, "string", pats[i]);
      }
    } else {
      throw errInvalidArgType("patterns", ["string", "string[]"], patterns);
    }
    const opts = options === undefined ? {} : options;
    if (opts === null || typeof opts !== "object" || Array.isArray(opts))
      throw errInvalidArgType("options", "object", options);
    const { exclude, cwd, followSymlinks, withFileTypes } = opts;
    if (exclude !== undefined && exclude !== null) {
      if (Array.isArray(exclude)) {
        for (let i = 0; i < exclude.length; i++) {
          if (typeof exclude[i] !== "string")
            throw errInvalidArgType(
              `options.exclude[${i}]`,
              "string",
              exclude[i],
            );
        }
      } else if (typeof exclude !== "function") {
        throw errInvalidArgType(
          "options.exclude",
          ["string[]", "function"],
          exclude,
        );
      }
    }
    if (
      followSymlinks !== undefined &&
      followSymlinks !== null &&
      typeof followSymlinks !== "boolean"
    ) {
      throw errInvalidArgType(
        "options.followSymlinks",
        "boolean",
        followSymlinks,
      );
    }
    const follow = followSymlinks === true;
    const withTypes = !!withFileTypes;

    let root = cwd === undefined || cwd === null ? "/" : toPathString(cwd);
    root = root.startsWith("/") ? gNormalize(root) : gNormalize("/" + root);

    const mmOpts = {
      windowsPathsNoEscape: true,
      nonegate: true,
      nocomment: true,
      optimizationLevel: 2,
      platform: "posix",
      nocaseMagicOnly: true,
    };
    let excludeMatchers = null;
    let excludeFn = null;
    if (Array.isArray(exclude)) {
      excludeMatchers = exclude.map(
        (p) => new Minimatch(gResolve(root, p), mmOpts),
      );
    } else if (typeof exclude === "function") {
      excludeFn = exclude;
    }
    const isExcludedPath = (absPath) =>
      excludeMatchers !== null && excludeMatchers.some((m) => m.match(absPath));

    // — per-run caches (lstat Dirents, readdir, realpath, follow-stat, seen) —
    const statCache = new Map();
    const readdirCache = new Map();
    const realpathCache = new Map();
    const followStatCache = new Map();
    const seenCache = new Map();
    const volPathCache = new Map();

    // memfs does not resolve symlinks in the middle of a path (real Node
    // does for every syscall). Resolve intermediate symlinks ourselves so
    // the walker can traverse through them; the walker's lexical paths are
    // unaffected (only the vol-level path is rewritten).
    function resolveVolPath(absPath, followFinal) {
      const key = (followFinal ? "F" : "L") + "\n" + absPath;
      if (volPathCache.has(key)) return volPathCache.get(key);
      const r = resolveVolPathUncached(absPath, followFinal);
      volPathCache.set(key, r);
      return r;
    }
    function resolveVolPathUncached(absPath, followFinal) {
      let p = gNormalize(absPath);
      let hops = 0;
      for (;;) {
        if (p === "/") return "/";
        const parts = p.split("/").filter((s) => s !== "");
        const lastIdx = parts.length - 1;
        let resolved = "";
        let progressed = false;
        for (let i = 0; i < parts.length; i++) {
          const isLast = i === lastIdx;
          const cur = resolved + "/" + parts[i];
          let st;
          try {
            st = vol.lstatSync(cur);
          } catch {
            return null;
          }
          if (st.isSymbolicLink() && (followFinal || !isLast)) {
            if (++hops > 40) return null; // ELOOP
            let target;
            try {
              target = vol.readlinkSync(cur);
            } catch {
              return null;
            }
            const base = resolved === "" ? "/" : resolved;
            const absTarget = target.startsWith("/")
              ? target
              : base + "/" + target;
            p = gNormalize(absTarget + "/" + parts.slice(i + 1).join("/"));
            progressed = true;
            break;
          }
          resolved = cur;
        }
        if (!progressed) return resolved === "" ? "/" : resolved;
      }
    }

    function gStat(absPath) {
      if (statCache.has(absPath)) return statCache.get(absPath);
      let d = null;
      const vp = resolveVolPath(absPath, false);
      if (vp !== null) {
        try {
          const st = vol.lstatSync(vp);
          d = new Dirent(
            gBasename(absPath),
            modeToDirentType(st.mode),
            gDirname(absPath),
          );
        } catch {
          d = null;
        }
      }
      statCache.set(absPath, d);
      return d;
    }
    function gReaddir(absPath) {
      if (readdirCache.has(absPath)) return readdirCache.get(absPath);
      let out = [];
      const vp = resolveVolPath(absPath, true);
      if (vp !== null) {
        try {
          const names = vol.readdirSync(vp);
          out = [];
          for (const name of names) {
            const fp = vp === "/" ? "/" + name : vp + "/" + name;
            let d = null;
            try {
              const st = vol.lstatSync(fp);
              d = new Dirent(name, modeToDirentType(st.mode), absPath);
            } catch {
              d = null;
            }
            if (d) out.push({ name, dirent: d });
          }
        } catch {
          out = [];
        }
      }
      readdirCache.set(absPath, out);
      return out;
    }
    function gRealpath(absPath) {
      if (realpathCache.has(absPath)) return realpathCache.get(absPath);
      // resolveVolPath already canonicalizes; that IS the realpath.
      const r = resolveVolPath(absPath, true);
      realpathCache.set(absPath, r);
      return r;
    }
    function gFollowStat(absPath) {
      if (followStatCache.has(absPath)) return followStatCache.get(absPath);
      let s = null;
      const vp = resolveVolPath(absPath, true);
      if (vp !== null) {
        try {
          s = vol.statSync(vp);
        } catch {
          s = null;
        }
      }
      followStatCache.set(absPath, s);
      return s;
    }
    function cacheAdd(relPath, pattern) {
      let set = seenCache.get(relPath);
      if (!set) {
        set = new Set();
        seenCache.set(relPath, set);
      }
      const before = set.size;
      for (const i of pattern.indexes) set.add(pattern.cacheKey(i));
      // Matches Node's Cache#add exactly: "seen" unless every key was new.
      return set.size !== before + pattern.indexes.size;
    }
    function cacheSeen(relPath, pattern, index) {
      const set = seenCache.get(relPath);
      return !!set && set.has(pattern.cacheKey(index));
    }

    function isDirectorySync(absPath, dirent, pattern) {
      if (dirent && dirent.isDirectory()) return true;
      if (!dirent || !dirent.isSymbolicLink()) return false;
      if (follow) {
        const st = gFollowStat(absPath);
        return !!st && st.isDirectory();
      }
      return pattern.hasSeenSymlinks;
    }
    function isCyclicSync(absPath, isDir, pattern) {
      if (!follow || !isDir) return false;
      const real = gRealpath(absPath);
      return real !== null && pattern.realpaths.has(real);
    }
    function nextRealpathsSync(absPath, isDir, pattern) {
      if (!follow || !isDir) return pattern.realpaths;
      const real = gRealpath(absPath);
      if (real === null) return pattern.realpaths;
      const s = new Set(pattern.realpaths);
      s.add(real);
      return s;
    }

    const results = new Set();
    function addResult(relPath) {
      if (isExcludedPath(gResolve(root, relPath))) return;
      results.add(relPath);
    }

    const queue = [];
    const subpatterns = new Map();
    function addSubpattern(relPath, pattern) {
      if (isExcludedPath(gResolve(root, relPath))) return;
      const fullpath = gResolve(root, relPath);
      if (isExcludedPath(fullpath + "/")) {
        const d = gStat(fullpath);
        if (d && d.isDirectory()) return;
      }
      if (excludeFn) {
        if (withTypes) {
          const st = gStat(fullpath);
          if (st !== null && excludeFn(st)) return;
        } else if (excludeFn(relPath)) {
          return;
        }
      }
      const arr = subpatterns.get(relPath);
      if (arr) arr.push(pattern);
      else subpatterns.set(relPath, [pattern]);
    }

    function addSubpatterns(relPath, pattern) {
      if (cacheAdd(relPath, pattern)) return;
      const fullpath = gResolve(root, relPath);
      const stat = gStat(fullpath);
      const last = pattern.last;
      const isDir = isDirectorySync(fullpath, stat, pattern);
      const isLast = pattern.isLast(isDir);
      const isFirst = pattern.isFirst();

      if (isExcludedPath(fullpath)) return;

      if (isFirst && pattern.at(0) === "") {
        // Absolute path, go to root
        addSubpattern("/", pattern.child(new Set([1])));
        return;
      }
      if (isFirst && pattern.at(0) === "..") {
        // Start with .., go to parent
        addSubpattern("../", pattern.child(new Set([1])));
        return;
      }
      if (isFirst && pattern.at(0) === ".") {
        // Start with ., proceed
        addSubpattern(".", pattern.child(new Set([1])));
        return;
      }

      if (isLast && typeof pattern.at(-1) === "string") {
        // Add result if it exists
        const p = pattern.at(-1);
        const st = gStat(gJoin(fullpath, p));
        if (st && (p || isDir)) addResult(gJoin(relPath, p));
        if (pattern.indexes.size === 1 && pattern.indexes.has(last)) return;
      } else if (
        isLast &&
        pattern.at(-1) === GLOBSTAR &&
        (relPath !== "." || pattern.at(0) === "." || (last === 0 && stat))
      ) {
        // If pattern ends with **, add to results; if path is ".", add it
        // only if pattern starts with "." or pattern is exactly "**".
        addResult(relPath);
      }

      if (!isDir || isCyclicSync(fullpath, isDir, pattern)) return;
      const nextRealpaths = nextRealpathsSync(fullpath, isDir, pattern);

      let children;
      let firstPattern;
      if (pattern.indexes.size === 1) {
        firstPattern = pattern.at(pattern.indexes.values().next().value);
      } else {
        firstPattern = false;
      }
      if (typeof firstPattern === "string") {
        const st = gStat(gJoin(fullpath, firstPattern));
        if (st) {
          st.name = firstPattern;
          children = [{ name: firstPattern, dirent: st }];
        } else {
          return;
        }
      } else {
        children = gReaddir(fullpath);
      }

      for (const { name: entryName, dirent: entry } of children) {
        const entryPath = gJoin(relPath, entryName);
        const entryFullpath = gJoin(fullpath, entryName);
        statCache.set(entryFullpath, entry);
        const entryIsDir =
          entry.isDirectory() ||
          (follow &&
            entry.isSymbolicLink() &&
            (() => {
              const s = gFollowStat(entryFullpath);
              return !!s && s.isDirectory();
            })());

        const subSet = new Set();
        const nSymlinks = new Set();
        for (const index of pattern.indexes) {
          const current = pattern.at(index);
          const nextIndex = index + 1;
          const next = pattern.at(nextIndex);
          const fromSymlink = !follow && pattern.symlinks.has(index);

          if (current === GLOBSTAR) {
            const isDot = entryName[0] === ".";
            const nextMatches = pattern.test(nextIndex, entryName);
            let nextNonGlobIndex = nextIndex;
            while (pattern.at(nextNonGlobIndex) === GLOBSTAR)
              nextNonGlobIndex++;
            const matchesDot =
              isDot && pattern.test(nextNonGlobIndex, entryName);
            if (
              (isDot && !matchesDot) ||
              (excludeFn && excludeFn(withTypes ? entry : entryName))
            ) {
              continue;
            }
            if (!fromSymlink && entryIsDir) {
              // If directory, add ** to its potential patterns
              subSet.add(index);
            } else if (!fromSymlink && index === last) {
              // If ** is last, add to results
              addResult(entryPath);
            }
            // Any pattern after ** is also a potential pattern
            // so we can already test it here
            if (nextMatches && nextIndex === last && !isLast) {
              // If next pattern is the last one, add to results
              addResult(entryPath);
            } else if (nextMatches && entryIsDir) {
              // Pattern matched, meaning two patterns forward
              // are also potential patterns
              subSet.add(index + 2);
            }
            if (
              (nextMatches || pattern.at(0) === ".") &&
              (entryIsDir || entry.isSymbolicLink()) &&
              !fromSymlink
            ) {
              // If pattern after ** matches, or pattern starts with "."
              // and entry is a directory or symlink, add to potential patterns
              subSet.add(nextIndex);
            }
            if (!follow && entry.isSymbolicLink()) nSymlinks.add(index);
            if (next === ".." && entryIsDir) {
              // In case pattern is "**/..", both parent and current
              // directory should be added to the queue; if this is the
              // last pattern, add to results instead.
              const parent = gJoin(relPath, "..");
              if (nextIndex < last) {
                if (
                  !subpatterns.has(relPath) &&
                  !cacheSeen(relPath, pattern, nextIndex + 1)
                ) {
                  subpatterns.set(relPath, [
                    pattern.child(new Set([nextIndex + 1])),
                  ]);
                }
                if (
                  !subpatterns.has(parent) &&
                  !cacheSeen(parent, pattern, nextIndex + 1)
                ) {
                  subpatterns.set(parent, [
                    pattern.child(new Set([nextIndex + 1])),
                  ]);
                }
              } else {
                if (!cacheSeen(relPath, pattern, nextIndex)) {
                  cacheAdd(relPath, pattern.child(new Set([nextIndex])));
                  addResult(relPath);
                }
                if (
                  !cacheSeen(relPath, pattern, nextIndex) ||
                  !cacheSeen(parent, pattern, nextIndex)
                ) {
                  cacheAdd(parent, pattern.child(new Set([nextIndex])));
                  addResult(parent);
                }
              }
            }
          }
          if (typeof current === "string") {
            if (pattern.test(index, entryName) && index !== last) {
              // If current pattern matches entry name
              // the next pattern is a potential pattern
              subSet.add(nextIndex);
            } else if (current === "." && pattern.test(nextIndex, entryName)) {
              // If current pattern is ".", proceed to test next pattern
              if (nextIndex === last) addResult(entryPath);
              else subSet.add(nextIndex + 1);
            }
          }
          if (
            typeof current === "object" &&
            current !== null &&
            pattern.test(index, entryName)
          ) {
            // If current pattern is a regex that matches entry name
            // (e.g *.js): add next pattern to potential patterns, or to
            // results if it's the last pattern
            if (index === last) addResult(entryPath);
            else if (entryIsDir) subSet.add(nextIndex);
          }
        }
        if (subSet.size > 0) {
          // If there are potential patterns, add to queue
          addSubpattern(
            entryPath,
            pattern.child(subSet, nSymlinks, nextRealpaths),
          );
        }
      }
    }

    const startPatterns = [];
    for (const pat of pats) {
      const mm = new Minimatch(pat, mmOpts);
      for (let i = 0; i < mm.set.length; i++) {
        startPatterns.push(new GlobPattern(mm.set[i], mm.globParts[i]));
      }
    }
    queue.push({ path: ".", patterns: startPatterns });
    while (queue.length > 0) {
      const item = queue.pop();
      for (const p of item.patterns) addSubpatterns(item.path, p);
      for (const [p, arr] of subpatterns)
        queue.push({ path: p, patterns: arr });
      subpatterns.clear();
    }

    const out = [];
    for (const r of results) {
      if (withTypes) {
        const d = gStat(gResolve(root, r));
        if (d) out.push(d);
      } else {
        out.push(r);
      }
    }
    return out;
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
      // Only the glob itself is guarded: a throw inside the user callback
      // must propagate (uncaughtException), never re-enter the callback.
      let result, err;
      try {
        result = globImpl(patterns, options);
      } catch (e) {
        err = enrichErr(e, "glob");
      }
      if (!err) emitFs("fs", "glob", patterns, result);
      if (callback) {
        if (err) callback(err);
        else callback(null, result);
      } else if (err) {
        throw err;
      } else {
        return result;
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
    // Port of Node's internal toUnixTimestamp: negative numbers mean "now".
    const at = _toUnixTimestamp(atime, "atime"),
      mt = _toUnixTimestamp(mtime, "mtime");
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
    node.atime = new Date(at * 1000);
    node.mtime = new Date(mt * 1000);
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
  function statfsImpl(p, options) {
    const ps = toPathString(p);
    try {
      vol.statSync(ps);
    } catch (e) {
      throw e;
    }
    const bigint = !!(options && options.bigint);
    const n = (v) => (bigint ? BigInt(v) : v);
    return {
      type: n(0x65735546), // FUSE_SUPER_MAGIC-ish placeholder
      bsize: n(4096),
      frsize: n(4096),
      blocks: n(1024 * 1024),
      bfree: n(512 * 1024),
      bavail: n(512 * 1024),
      files: n(1024 * 1024),
      ffree: n(512 * 1024),
    };
  }
  fs.statfsSync = function (p, options) {
    validatePath(p);
    let result;
    try {
      result = statfsImpl(p, options);
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
        const result = statfsImpl(p, options);
        emitFs("fs", "statfs", p, result);
        callback(null, result);
      } catch (e) {
        callback(enrichErr(e, "statfs"));
      }
    });
  };

  // ── mkdtemp/mkdtempSync + Disposable variants ──
  // The "templates ending with X are not portable" warning fires once per
  // process in real Node (verified against v24).
  let mkdtempXWarned = false;
  function mkdtempImpl(prefix, options) {
    const pre = toPathString(prefix);
    if (
      !mkdtempXWarned &&
      pre.endsWith("X") &&
      typeof process !== "undefined" &&
      typeof process.emitWarning === "function"
    ) {
      mkdtempXWarned = true;
      process.emitWarning(
        "mkdtemp() templates ending with X are not portable. " +
          "For details see: https://nodejs.org/api/fs.html",
      );
    }
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
    validateEncodingOpt(options, true);
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
    validateEncodingOpt(options, true);
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
    // .path is the path as created (relative stays relative); removal uses
    // the absolute path captured now so a later process.chdir() cannot
    // redirect it (verified against Node v24).
    const absDir = posixResolve(shimCwd(), toPathString(dir));
    const disp = {
      path: dir,
      remove() {
        try {
          vol.rmSync(absDir, { recursive: true, force: true });
        } catch {}
      },
      [Symbol.dispose]() {
        disp.remove();
      },
    };
    return disp;
  };
  fs.mkdtempDisposable = async function (prefix, options) {
    const dir = await new Promise((resolve, reject) => {
      fs.mkdtemp(prefix, options, (err, d) => (err ? reject(err) : resolve(d)));
    });
    const absDir = posixResolve(shimCwd(), toPathString(dir));
    const disp = {
      path: dir,
      remove() {
        return new Promise((resolve) => {
          fs.rm(absDir, { recursive: true, force: true }, () => resolve());
        });
      },
      [Symbol.asyncDispose]() {
        return disp.remove();
      },
    };
    return disp;
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
    if (options && typeof Buffer !== "undefined") {
      const enc = options.encoding;
      if (enc === "buffer") return Buffer.from(resolved);
      // Non-utf8 string encodings are transcoded (test-fs-realpath-buffer-encoding).
      if (typeof enc === "string" && enc !== "utf8" && enc !== "utf-8") {
        return Buffer.from(resolved, "utf8").toString(enc);
      }
    }
    return resolved;
  }
  function normalizeRealpathOptions(options) {
    return typeof options === "string" ? { encoding: options } : options;
  }
  function makeRealpathSync(native) {
    return function (p, options) {
      validateEncodingOpt(options, true);
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
      validateEncodingOpt(options, true);
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
  // memfs resolves relative symlink targets against process.cwd() instead of
  // the link's dirname (POSIX: relative to the link). Store the absolute
  // target in the volume, but remember the literal target so readlink stays
  // faithful to what was passed.
  const symlinkLiterals = new Map();
  function symlinkVolTarget(target, linkPath) {
    const t = toPathString(target);
    if (t.startsWith("/")) return { vol: t, literal: t };
    const dir = posixDirname(toPathString(linkPath));
    return { vol: posixNormalize(dir + "/" + t), literal: t };
  }
  function readlinkLiteral(linkPath) {
    if (!symlinkLiterals.has(linkPath)) return undefined;
    try {
      const st = vol.lstatSync(linkPath);
      if (st && st.isSymbolicLink()) return symlinkLiterals.get(linkPath);
    } catch {}
    symlinkLiterals.delete(linkPath);
    return undefined;
  }
  function applyReadlinkEncoding(literal, options) {
    const enc =
      typeof options === "string"
        ? options
        : (options && options.encoding) || "utf8";
    if (typeof Buffer !== "undefined") {
      const b = Buffer.from(literal, "utf8");
      return enc === "buffer" ? b : b.toString(enc);
    }
    return literal;
  }
  wrapSync("linkSync", null, true, 1);
  wrapCb("link", null, true, 1);
  wrapSync("symlinkSync", null, true, 1);
  wrapCb("symlink", null, true, 1);
  // Node stores symlink targets verbatim and resolves relative targets
  // against the link's directory at access time; memfs resolves them against
  // process.cwd() at creation. Absolutize here so access resolves correctly
  // (test-fs-realpath, test-fs-symlink-dir). Also: real Node names the args
  // "target"/"path" and validates `type` first with ERR_INVALID_ARG_VALUE.
  function validateSymlinkType(type) {
    if (
      type !== undefined &&
      type !== null &&
      type !== "dir" &&
      type !== "file" &&
      type !== "junction"
    ) {
      const received = typeof type === "string" ? `'${type}'` : String(type);
      const err = new TypeError(
        "The argument 'type' must be one of: 'dir', 'file', 'junction', " +
          `null, undefined. Received ${received}`,
      );
      err.code = "ERR_INVALID_ARG_VALUE";
      throw err;
    }
  }
  function absolutizeSymlinkTarget(target, linkPath) {
    const t = toPathString(target);
    if (t.startsWith("/")) return t;
    let lp = toPathString(linkPath);
    if (!lp.startsWith("/")) lp = posixResolve(shimCwd(), lp);
    // memfs normalizes ".." when it resolves this absolute path.
    return posixDirname(lp) + "/" + t;
  }
  {
    const innerSync = fs.symlinkSync,
      innerCb = fs.symlink;
    fs.symlinkSync = function (target, p, type) {
      validateSymlinkType(type);
      validatePath(target, "target");
      validatePath(p, "path");
      return innerSync.call(this, absolutizeSymlinkTarget(target, p), p, type);
    };
    fs.symlink = function (target, p, type, callback) {
      if (typeof type === "function") {
        callback = type;
        type = undefined;
      }
      validatePath(target, "target");
      validatePath(p, "path");
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validateSymlinkType(type);
      return innerCb.call(
        this,
        absolutizeSymlinkTarget(target, p),
        p,
        type,
        callback,
      );
    };
  }
  wrapSync("readlinkSync", null, true);
  wrapCb("readlink", null, true);
  // readlink validates the encoding before the path (getOptions order).
  {
    const oS = fs.readlinkSync,
      oC = fs.readlink;
    fs.readlinkSync = function (p, options) {
      validateEncodingOpt(options, true);
      return oS.call(this, p, options);
    };
    fs.readlink = function (p, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      validateEncodingOpt(options, true);
      return oC.call(this, p, options, callback);
    };
  }
  // ── Symlink target fidelity (cp parity) ──
  // Real Node stores the symlink target verbatim: readlinkSync returns
  // exactly the string passed to symlinkSync, even when relative (probed
  // v24.20.0: readlinkSync -> "foo.js", not cwd-resolved). The raw-target
  // map and node fixup helpers live in the cp section above
  // (rememberSymlinkTarget, cpFixupSymlinkNode); the wrappers here just
  // hook creation and readlink.
  {
    const oSymlinkSync = fs.symlinkSync,
      oSymlink = fs.symlink;
    fs.symlinkSync = function (target, newPath, type) {
      const raw = toPathString(target);
      const r = oSymlinkSync.call(this, target, newPath, type);
      rememberSymlinkTarget(newPath, raw);
      cpFixupSymlinkNode(newPath, raw);
      return r;
    };
    fs.symlink = function (target, newPath, type, callback) {
      if (typeof type === "function") {
        callback = type;
        type = undefined;
      }
      const raw = toPathString(target);
      return oSymlink.call(this, target, newPath, type, (err) => {
        // Remember only on success (and only after the path validated):
        // remembering up front would poison readlinkSync for paths that
        // fail validation (test-fs-null-bytes).
        if (!err) {
          rememberSymlinkTarget(newPath, raw);
          cpFixupSymlinkNode(newPath, raw);
        }
        if (typeof callback === "function") callback(err);
      });
    };
    const oReadlinkSync = fs.readlinkSync,
      oReadlink = fs.readlink;
    const rawEncoding = (options) => {
      const enc =
        typeof options === "string"
          ? options
          : options && options.encoding
            ? options.encoding
            : "utf8";
      return enc;
    };
    const rememberedRaw = (p) => {
      try {
        return symlinkRawTargets.get(symlinkMapKey(p));
      } catch {
        return undefined;
      }
    };
    fs.readlinkSync = function (p, options) {
      validateEncodingOpt(options);
      const raw = rememberedRaw(p);
      if (raw !== undefined)
        return rawEncoding(options) === "buffer" ? Buffer.from(raw) : raw;
      return oReadlinkSync.call(this, p, options);
    };
    fs.readlink = function (p, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      validateEncodingOpt(options);
      const raw = rememberedRaw(p);
      if (raw !== undefined) {
        const out = rawEncoding(options) === "buffer" ? Buffer.from(raw) : raw;
        if (typeof callback === "function") nextTick(() => callback(null, out));
        return;
      }
      return oReadlink.call(this, p, options, callback);
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
  {
    const origSync = fs.fchownSync;
    fs.fchownSync = function (fd, uid, gid) {
      validateFd(fd);
      validateUidGid(uid, gid);
      [uid, gid] = resolveUidGid(uid, gid, () => vol.fstatSync(fd));
      try {
        const r = origSync.call(this, fd, uid, gid);
        emitFs("fs", "fchownSync", fd, r);
        return r;
      } catch (e) {
        throw enrichErr(e, "fchownSync");
      }
    };
  }
  {
    const orig = fs.fchown;
    fs.fchown = function (fd, uid, gid, callback) {
      // Real Node validates uid, then gid, then callback, then fd.
      validateUidGid(uid, gid);
      if (typeof callback !== "function")
        throw errInvalidArgType("cb", "function", callback);
      validateFd(fd);
      let resolved;
      try {
        resolved = resolveUidGid(uid, gid, () => vol.fstatSync(fd));
      } catch (e) {
        nextTick(callback, enrichErr(e, "fchown"));
        return;
      }
      orig.call(this, fd, resolved[0], resolved[1], (err) => {
        if (err) return callback(enrichErr(err, "fchown"));
        emitFs("fs", "fchown", fd, undefined);
        callback(null);
      });
    };
  }
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
      // memfs's FSWatcher keeps the event loop alive via a 1e6ms ref'd
      // `this._timer` (started when persistent is true). Node's FSWatcher
      // ref()/unref() control that hold; make ours do the same instead of
      // no-ops, otherwise unref()'d watchers keep the process alive forever
      // (test-fs-watch-ref-unref.js).
      if (typeof w.ref !== "function") {
        w.ref = function () {
          if (w._timer && typeof w._timer.ref === "function") w._timer.ref();
          return w;
        };
      }
      if (typeof w.unref !== "function") {
        w.unref = function () {
          if (w._timer && typeof w._timer.unref === "function")
            w._timer.unref();
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
  // Fixed replacement for memfs's per-link recursive-watch handlers.
  // See the call site in the fs.watch wrapper for the rationale.
  function hardenRecursiveWatcher(w) {
    const rootLink = w && w._link;
    if (!rootLink) return;
    const watchedRoot = w._filename;
    const relName = (absPath) => {
      if (absPath === watchedRoot) return "";
      const prefix = watchedRoot.endsWith("/")
        ? watchedRoot
        : watchedRoot + "/";
      if (absPath.startsWith(prefix)) return absPath.slice(prefix.length);
      const a = watchedRoot.split("/").filter(Boolean);
      const b = absPath.split("/").filter(Boolean);
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
    };
    // Mirror of memfs's watchLinkNodeChanged (already applied to existing
    // links during start(); used here for links added after watch began).
    const attachNodeWatch = (link) => {
      let node;
      try {
        node = link.getNode();
      } catch {
        return;
      }
      const filepath = link.getPath();
      const onNodeChange = () => {
        let filename = relName(filepath);
        if (!filename) filename = w._getName();
        w.emit("change", "change", filename);
      };
      node.on("change", onNodeChange);
      const removers = w._listenerRemovers.get(node.ino) || [];
      removers.push(() => {
        node.removeListener("change", onNodeChange);
      });
      w._listenerRemovers.set(node.ino, removers);
    };
    // memfs's removeLinkNodeListeners without the '.'/'..' cycle.
    const cleanSubtree = (link) => {
      const seen = new Set();
      const clean = (cur) => {
        if (!cur || seen.has(cur)) return;
        seen.add(cur);
        let ino;
        try {
          ino = cur.getNode().ino;
        } catch {
          return;
        }
        const removers = w._listenerRemovers.get(ino);
        if (removers) {
          for (const r of removers) {
            try {
              r();
            } catch {
              /* ignore */
            }
          }
          w._listenerRemovers.delete(ino);
        }
        const children = cur.children || {};
        for (const name of Object.keys(children)) {
          if (name === "." || name === "..") continue;
          clean(children[name]);
        }
      };
      clean(link);
    };
    const fixLink = (link) => {
      if (!link || typeof link.on !== "function") return;
      let fixups = link.__fsWatchFixups;
      if (!fixups) {
        fixups = [];
        try {
          Object.defineProperty(link, "__fsWatchFixups", {
            value: fixups,
            writable: true,
            configurable: true,
          });
        } catch {
          link.__fsWatchFixups = fixups;
        }
      }
      if (fixups.some((f) => f.w === w)) return;
      const onAdd = (added) => {
        // Synchronous attach: memfs defers a tick and misses files created
        // in the same tick as the new directory. The node 'change' watcher
        // stays deferred (memfs parity: no 'change' for the initial write).
        fixLink(added);
        setTimeout(() => attachNodeWatch(added), 0);
        w.emit("change", "rename", relName(added.getPath()));
      };
      const onDelete = (deleted) => {
        cleanSubtree(deleted);
        w.emit("change", "rename", relName(deleted.getPath()));
      };
      // Drop memfs's handlers (its delete handler stack-overflows) and
      // re-add other live watchers' fixups so overlapping recursive
      // watches on one directory coexist.
      link.removeAllListeners("child:add");
      link.removeAllListeners("child:delete");
      for (const f of fixups) {
        link.on("child:add", f.onAdd);
        link.on("child:delete", f.onDelete);
      }
      link.on("child:add", onAdd);
      link.on("child:delete", onDelete);
      fixups.push({ w, onAdd, onDelete });
      let ino;
      try {
        ino = link.getNode().ino;
      } catch {
        ino = -1;
      }
      const removers = w._listenerRemovers.get(ino) || [];
      removers.push(() => {
        link.removeListener("child:add", onAdd);
        link.removeListener("child:delete", onDelete);
        const i = fixups.findIndex((f) => f.w === w);
        if (i >= 0) fixups.splice(i, 1);
      });
      w._listenerRemovers.set(ino, removers);
      // Existing children already have memfs's node watchers; only the
      // child add/delete handlers need replacing.
      const children = link.children || {};
      for (const name of Object.keys(children)) {
        if (name === "." || name === "..") continue;
        fixLink(children[name]);
      }
    };
    fixLink(rootLink);
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
      // Node validates options.ignore in the FSWatcher constructor.
      const ignore =
        options !== null && typeof options === "object"
          ? options.ignore
          : undefined;
      validateIgnoreOption(ignore);
      validateEncodingOpt(options);
      // On platforms without a native recursive watcher (Linux: libuv has
      // none, Node uses internal/fs/recursive_watch), truthy non-boolean
      // `recursive` throws ERR_INVALID_ARG_TYPE (validateBoolean).
      const recursive =
        options !== null && typeof options === "object"
          ? options.recursive
          : undefined;
      if (recursive && typeof recursive !== "boolean")
        throw errInvalidArgType("options.recursive", "boolean", recursive);
      validatePath(p);
      const ps = toPathString(p);
      let w;
      try {
        w = orig.call(this, ps, options, listener);
      } catch (e) {
        throw enrichErr(e, "watch");
      }
      patchWatcher(w, ps);
      // Filter change events whose filename matches the ignore option, like
      // Node's watcher (which drops them before emitting).
      const ignoreMatcher = createIgnoreMatcher(ignore);
      if (ignoreMatcher) {
        const origEmit = w.emit.bind(w);
        w.emit = function (event, ...args) {
          if (event === "change" && args[1] != null && ignoreMatcher(args[1])) {
            return false;
          }
          return origEmit(event, ...args);
        };
      }
      // ── memfs recursive-watch hardening ──
      // memfs's recursive FSWatcher has two defects we must work around:
      // 1. Deleting a watched subtree throws RangeError (its
      //    removeLinkNodeListeners recurses through the '.'/'..' links).
      // 2. Its re-attach after a 'child:add' is deferred a tick, so a file
      //    created in the same tick as a new directory is never reported.
      // Replace memfs's per-link 'child:add'/'child:delete' handlers with
      // fixed versions (node 'change' watchers memfs attached during
      // start() are fine and are left alone).
      const recursiveOpt =
        options !== null && typeof options === "object"
          ? options.recursive
          : undefined;
      if (recursiveOpt && w && w._link) {
        hardenRecursiveWatcher(w);
      }
      if (signal) {
        // Aborting closes the watcher (its 'close' event fires as usual).
        if (signal.aborted) nextTick(() => w.close());
        else signal.addEventListener("abort", () => w.close(), { once: true });
      }
      emitFs("fs", "watch", p, w);
      return w;
    };
  }
  // watchFile: poll-based StatWatcher, mirroring Node's semantics:
  // one shared EventEmitter per resolved filename, 'change'/'stop' events,
  // stop() emits 'stop' asynchronously, ref()/unref() control the poll
  // timer's hold on the event loop.
  function resolveWatchFileKey(ps) {
    // Minimal POSIX path.resolve for the per-filename watcher key.
    let p = ps;
    const cwd =
      typeof process !== "undefined" &&
      process &&
      typeof process.cwd === "function"
        ? process.cwd()
        : "/";
    if (!p.startsWith("/")) p = cwd + "/" + p;
    const parts = [];
    for (const seg of p.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return "/" + parts.join("/");
  }
  function validateWatchFileInterval(interval) {
    // Node's validateUint32(interval, 'interval').
    if (typeof interval !== "number")
      throw errInvalidArgType("interval", "number", interval);
    if (!Number.isInteger(interval))
      throw errOutOfRange("interval", "an integer", interval);
    if (interval < 0 || interval > 4294967295)
      throw errOutOfRange("interval", ">= 0 && <= 4294967295", interval);
  }
  class StatWatcher extends _FsEventEmitter {
    constructor() {
      super();
      this._timer = null;
      this._stopped = false;
    }
    _start(ps, persistent, interval, bigint) {
      let prev = null;
      try {
        prev = toStats(vol.statSync(ps), { bigint });
      } catch {
        /* missing file: prev stays null */
      }
      let first = true;
      const tick = () => {
        let curr = null;
        try {
          curr = toStats(vol.statSync(ps), { bigint });
        } catch {
          /* ignore */
        }
        const changed =
          // Node's first poll reports only when the file is missing
          // (uv_fs_poll's initial callback with zero stats); an existing
          // file produces no event until it actually changes.
          (first && !prev) ||
          (!prev && curr) ||
          (prev && !curr) ||
          (prev &&
            curr &&
            (prev.mtimeMs !== curr.mtimeMs || prev.size !== curr.size));
        if (changed) {
          const zero = () => toStats({}, { bigint });
          // No try/catch: like Node's EventEmitter, listener exceptions
          // propagate (uncaught) instead of stalling the watcher silently.
          this.emit("change", curr || zero(), prev || zero());
        }
        first = false;
        prev = curr;
      };
      this._timer = setInterval(tick, interval);
      if (!persistent && this._timer.unref) this._timer.unref();
    }
    // Node: noop when the watcher was never started / already stopped.
    // Emits 'stop' asynchronously, exactly once per stop() of a live watcher.
    stop() {
      if (this._timer === null || this._stopped) return;
      this._stopped = true;
      clearInterval(this._timer);
      this._timer = null;
      // Like Node's emitStop: listener exceptions propagate via nextTick.
      nextTick(() => this.emit("stop"));
    }
    ref() {
      if (this._timer && this._timer.ref) this._timer.ref();
      return this;
    }
    unref() {
      if (this._timer && this._timer.unref) this._timer.unref();
      return this;
    }
  }
  const _statWatchers = new Map(); // resolved filename -> StatWatcher
  fs.watchFile = function (p, options, listener) {
    // Node validates the path before the listener, and shifts non-object
    // options (including null) into the listener slot.
    validatePath(p);
    const ps = toPathString(p);
    if (options === null || typeof options !== "object") {
      listener = options;
      options = null;
    }
    const opts = { interval: 5007, persistent: true, ...(options || {}) };
    if (typeof listener !== "function")
      throw errInvalidArgType("listener", "function", listener);
    const key = resolveWatchFileKey(ps);
    let watcher = _statWatchers.get(key);
    if (!watcher) {
      validateWatchFileInterval(opts.interval);
      watcher = new StatWatcher();
      watcher._start(ps, !!opts.persistent, opts.interval, !!opts.bigint);
      _statWatchers.set(key, watcher);
    }
    watcher.on("change", listener);
    emitFs("fs", "watchFile", p, watcher);
    return watcher;
  };
  fs.unwatchFile = function (p, listener) {
    validatePath(p);
    const ps = toPathString(p);
    const key = resolveWatchFileKey(ps);
    const watcher = _statWatchers.get(key);
    if (watcher !== undefined) {
      if (typeof listener === "function") {
        watcher.removeListener("change", listener);
      } else {
        watcher.removeAllListeners("change");
      }
      if (watcher.listenerCount("change") === 0) {
        watcher.stop();
        _statWatchers.delete(key);
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
    const doClose = () => {
      try {
        stream._impl.close(fd, () => {});
      } catch {
        try {
          vol.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    };
    if (stream.flush) {
      // Node: flush:true fsyncs the fd before close
      // (test-fs-write-stream-flush.js).
      try {
        stream._impl.fsync(fd, () => doClose());
      } catch {
        doClose();
      }
      return;
    }
    doClose();
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
  // Node's _construct hack for monkey-patched open(): when `callback` is
  // given (WriteStream._construct), an 'error' from the patched open goes to
  // the construct callback — the stream machinery then emits 'error' exactly
  // once — mirroring lib/internal/fs/streams.js. Without a callback
  // (ReadStream's constructor arming) the error is emitted directly.
  function openWithPatchedOpen(stream, callback) {
    const origEmit = stream.emit;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      callback(err);
    };
    stream.emit = function (...args) {
      if (args[0] === "open") {
        stream.emit = origEmit;
        stream._openPending = false;
        stream._opened = true;
        return Reflect.apply(origEmit, stream, args);
      }
      if (args[0] === "error") {
        stream.emit = origEmit;
        stream._openPending = false;
        // An 'error' from the patched open destroys the stream (real Node
        // routes it through destroy: destroyed===true and 'close' fires).
        // destroy() re-emits 'error' async for the user's handler.
        stream.destroy(args[1]);
        return true;
      }
      if (args[0] === "error" && typeof callback === "function") {
        finish(args[1] || new Error("open failed"));
        return;
      }
      const r = Reflect.apply(origEmit, stream, args);
      if (args[0] === "open" && typeof callback === "function")
        finish(undefined);
      return r;
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
  // Node's getValidatedFd for the stream fd option: a non-negative 32-bit
  // integer or a FileHandle; anything else throws (probed v24.20.0).
  // Returns null (path mode), the number, or the FileHandle.
  function validateStreamFd(fdOpt) {
    if (fdOpt === undefined || fdOpt === null) return null;
    const handle = asFileHandle(fdOpt);
    if (handle) return handle;
    if (typeof fdOpt !== "number")
      throw errInvalidArgTypeProp(
        "options.fd",
        "number or an instance of FileHandle",
        fdOpt,
      );
    if (!Number.isSafeInteger(fdOpt))
      throw errOutOfRange("fd", "an integer", fdOpt);
    if (fdOpt < 0 || fdOpt > 0x7fffffff)
      throw errOutOfRange("fd", ">= 0 && <= 2147483647", fdOpt);
    return fdOpt;
  }
  // Node validates the effective fs object's function props at stream
  // construction (lib/internal/fs/streams.js): options.fs.open in path
  // mode, .read/.write/.writev always, .close when autoDestroy.
  function validateFsFnProp(value, name) {
    if (typeof value !== "function")
      throw errInvalidArgTypeProp(name, "function", value);
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
      fsync: (fd, cb) => {
        handle.sync().then(
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
      super(streamOpts(options || {}));
      this._initReadStream(path, options);
    }
    // Initialization factored out so ReadStreamFactory can run it on an
    // existing `this` for the fs.ReadStream.call(this, ...) subclass
    // compat pattern (test-fs-stream-construct-compat-error-read.js).
    _initReadStream(path, options) {
      // options.signal validated for every stream (invalid type throws).
      const opts = options || {};
      const signal = validateAbortSignal(opts.signal);
      const fdValidated = validateStreamFd(opts.fd);
      const handle =
        fdValidated !== null && typeof fdValidated !== "number"
          ? fdValidated
          : null;
      this.fd = typeof fdValidated === "number" ? fdValidated : null;
      // Node leaves .path unset (undefined) when fd is specified. Path
      // validation only applies in path mode (fdValidated === null) — a
      // FileHandle fd also lands this.fd at null mid-construction.
      if (fdValidated === null) {
        validatePath(path);
        this.path = toPathString(path);
      }
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
      if (handle && opts.fs) {
        // Node: FileHandle is not supported with custom fs operations
        // (importFd throws before any function validation).
        const err = new Error(
          "The FileHandle with fs method is not implemented",
        );
        err.code = "ERR_METHOD_NOT_IMPLEMENTED";
        throw err;
      }
      // Node validates the effective fs object's function props at
      // construction (lib/internal/fs/streams.js).
      const kFs = opts.fs || fs;
      if (fdValidated === null) validateFsFnProp(kFs.open, "options.fs.open");
      validateFsFnProp(kFs.read, "options.fs.read");
      if (this.autoClose) validateFsFnProp(kFs.close, "options.fs.close");
      if (handle) {
        this.fd = typeof handle.fd === "number" ? handle.fd : null;
        this._fileHandle = handle;
        this._impl = handleStreamImpl(handle);
        // Node: the stream closes itself when the handle emits 'close'.
        if (typeof handle.on === "function")
          handle.on("close", () => this.close());
      } else {
        const defaultOr =
          (name) =>
          (...a) =>
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
      if (this.fd === null && !opts._skipOpenSchedule) {
        if (this.open !== readStreamOpenNoop) {
          // open() was monkey-patched: Node's _construct hack.
          this._openPending = true;
          nextTick(() => openWithPatchedOpen(this));
        } else {
          // Deferred so handlers attached after construction still fire.
          this._openPending = true;
          nextTick(() => this._openWithImpl());
        }
      } else if (this.fd !== null) {
        // A caller-provided fd is already open (Node closes it on destroy
        // when autoClose, like a stream-opened fd).
        this._opened = true;
        nextTick(() => {
          this.emit("open", this.fd);
          this.emit("ready");
        });
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
        this.fd = fd;
        this._opened = true;
        // Node emits 'open' even when destroy() ran while the open was in
        // flight (test-fs-stream-double-close); the destroy machinery then
        // releases the fd — run _cleanup now since _destroy already ran.
        this.emit("open", fd);
        this.emit("ready");
        if (this.destroyed) this._cleanup();
      });
    }
    // Node: pending is true until the fd is open (fd === null).
    get pending() {
      return this.fd === null;
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
      let chunk = buf;
      if (n !== buf.length) {
        // Shrink to fit: copy into an exact-size, unpooled ArrayBuffer
        // instead of slice()ing, so the small chunk doesn't retain the
        // large backing store (Node uses allocUnsafeSlow for the same
        // reason; test-fs-read-stream-concurrent-reads asserts this).
        const ab = new ArrayBuffer(n);
        new Uint8Array(ab).set(buf.subarray(0, n));
        chunk =
          typeof Buffer !== "undefined" ? Buffer.from(ab) : new Uint8Array(ab);
      }
      this.push(chunk);
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
    // asserts no leaked fds across close()/destroy()). Like Node's
    // finished(), a callback on an already-closed stream fires on next
    // tick instead of waiting for a 'close' that already happened.
    close(cb) {
      if (typeof cb === "function") {
        if (this.closed) nextTick(cb);
        else this.once("close", cb);
      }
      this.destroy();
    }
  }
  // Node exposes autoClose as a prototype accessor proxying the stream
  // state's autoDestroy; touching it on the bare prototype throws
  // ERR_INVALID_THIS (lib/internal/fs/streams.js).
  function errInvalidThis(className) {
    const err = new TypeError(`Value of "this" must be of type ${className}`);
    err.code = "ERR_INVALID_THIS";
    return err;
  }
  Object.defineProperty(FsReadStream.prototype, "autoClose", {
    configurable: true,
    get() {
      if (
        typeof this !== "object" ||
        this === null ||
        !Object.prototype.hasOwnProperty.call(this, "_readableState")
      )
        throw errInvalidThis("ReadStream");
      return this._readableState.autoDestroy;
    },
    set(val) {
      if (
        typeof this !== "object" ||
        this === null ||
        !Object.prototype.hasOwnProperty.call(this, "_readableState")
      )
        throw errInvalidThis("ReadStream");
      this._readableState.autoDestroy = val;
    },
  });
  class FsWriteStream extends Writable {
    constructor(path, options) {
      validateStreamOptions(options);
      const opts = options || {};
      // Every synchronous validation runs BEFORE super(): real Node never
      // schedules _construct on a half-constructed stream — createWriteStream(46),
      // {start:'4'}, and invalid options.fs fns all throw with no zombie
      // instance left behind (a zombie _construct would crash on
      // this._impl === undefined; verified against real Node v24).
      const signal = validateAbortSignal(opts.signal);
      const fdValidated = validateStreamFd(opts.fd);
      const handle =
        fdValidated !== null && typeof fdValidated !== "number"
          ? fdValidated
          : null;
      // Node leaves .path unset (undefined) when fd is specified. Path
      // validation only applies in path mode (fdValidated === null) — a
      // FileHandle fd also lands this.fd at null mid-construction.
      if (fdValidated === null) validatePath(path);
      const start = opts.start;
      // Node validates start for write streams too (integer, >= 0).
      if (start !== undefined) validateIntegerInRange(start, "start", 0);
      const autoClose = opts.autoClose !== false;
      // Node's streams call the PUBLIC fs.open/read/write/close (lib/fs.js),
      // so user monkey-patches are observed. options.fs overrides
      // individual operations. Looked up lazily so patches apply at call
      // time.
      const customFs = opts.fs || {};
      if (handle && opts.fs) {
        // Node: FileHandle is not supported with custom fs operations
        // (importFd throws before any function validation).
        const err = new Error(
          "The FileHandle with fs method is not implemented",
        );
        err.code = "ERR_METHOD_NOT_IMPLEMENTED";
        throw err;
      }
      // Node validates the effective fs object's function props at
      // construction (lib/internal/fs/streams.js).
      const kFs = opts.fs || fs;
      if (fdValidated === null) validateFsFnProp(kFs.open, "options.fs.open");
      if (!kFs.write && !kFs.writev)
        throw errInvalidArgTypeProp("options.fs.write", "function", kFs.write);
      if (kFs.write) validateFsFnProp(kFs.write, "options.fs.write");
      if (kFs.writev) validateFsFnProp(kFs.writev, "options.fs.writev");
      if (autoClose) validateFsFnProp(kFs.close, "options.fs.close");
      const flushOpt = opts.flush;
      if (flushOpt != null) {
        if (typeof flushOpt !== "boolean")
          throw errInvalidArgType("options.flush", "boolean", flushOpt);
        validateFsFnProp(kFs.fsync, "options.fs.fsync");
      }
      super(streamOpts(opts));
      this.fd = typeof fdValidated === "number" ? fdValidated : null;
      if (fdValidated === null) this.path = toPathString(path);
      this.flags = opts.flags || "w";
      this.mode = opts.mode || 0o666;
      this.start = start;
      this.autoClose = autoClose;
      this._pos = this.start;
      this._opened = false;
      if (handle) {
        this.fd = typeof handle.fd === "number" ? handle.fd : null;
        this._fileHandle = handle;
        this._impl = handleStreamImpl(handle);
        // Node: the stream closes itself when the handle emits 'close'.
        if (typeof handle.on === "function")
          handle.on("close", () => this.close());
      } else {
        const defaultOr =
          (name) =>
          (...a) =>
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
          fsync: defaultOr("fsync"),
        };
      }
      // writev batching only when the impl provides it (installing _writev
      // unconditionally would change batching for the default path).
      if (this._impl.writev) {
        this._writev = (chunks, callback) => this._writevImpl(chunks, callback);
      }
      // Node: options.encoding sets the stream's default encoding
      // (test-fs-write-stream-encoding.js).
      if (opts.encoding) this.setDefaultEncoding(opts.encoding);
      // Node's `flush` option: fsync the fd before close
      // (test-fs-write-stream-flush.js). Validated pre-super above.
      this.flush = opts.flush == null ? false : opts.flush;
      armStreamSignal(this, signal);
      emitFs("fs", "createWriteStream", this.path, this);
      // The open runs from _construct (Node's lib/internal/fs/streams.js),
      // so 'open' always fires before any _write/_final — e.g. stream.end()
      // immediately after construction (test-fs-write-stream-end.js).
    }
    _construct(callback) {
      if (this._constructDefused) {
        // Transplanted subclass instance (fs.WriteStream.call(this, ...)):
        // the deferred open was re-armed on the real `this` by the factory.
        callback();
        return;
      }
      if (this.fd !== null) {
        // A caller-provided fd is already open (Node closes it on destroy
        // when autoClose, like a stream-opened fd).
        this._opened = true;
        nextTick(() => {
          this.emit("open", this.fd);
          this.emit("ready");
        });
        callback();
        return;
      }
      this._openPending = true;
      if (this.open !== writeStreamOpenNoop) {
        // open() was monkey-patched: Node's _construct hack.
        openWithPatchedOpen(this, callback);
      } else {
        this._openWithImpl(callback);
      }
    }
    _openWithImpl(callback) {
      this._impl.open(this.path, this.flags, this.mode, (err, fd) => {
        this._openPending = false;
        if (err || fd === undefined || fd === null) {
          callback(
            enrichErr(err || new Error("open failed"), "createWriteStream"),
          );
          return;
        }
        this.fd = fd;
        this._opened = true;
        // Node emits 'open' even when destroy() ran while the open was in
        // flight (test-fs-stream-double-close); the destroy machinery then
        // releases the fd — run _cleanup now since _destroy already ran.
        // (Checked via _destroyCalled, not the `destroyed` getter, which
        // tests can mock to true without destroy() ever running.)
        this.emit("open", fd);
        this.emit("ready");
        callback();
        if (this._destroyCalled) this._cleanup();
      });
    }
    // Node: pending is true until the fd is open (fd === null).
    get pending() {
      return this.fd === null;
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
      this._writeAll(data, pos, callback);
    }
    // Node's lib/internal/fs/streams.js writeAll: EAGAIN counts as a
    // zero-byte write and is retried; partial writes loop until the whole
    // chunk lands; more than 5 consecutive zero-byte writes fail the write
    // (test-fs-write-stream-eagain.mjs).
    _writeAll(data, pos, callback) {
      const size = data.byteLength;
      const step = (offset, retries) => {
        const remaining = size - offset;
        if (remaining <= 0) {
          if (pos !== null && pos !== undefined) this._pos = pos + size;
          emitFs("fs", "writeStream.write", this.path, size);
          callback(null);
          return;
        }
        const chunk = offset === 0 ? data : data.slice(offset);
        const p = pos === null || pos === undefined ? pos : pos + offset;
        this._impl.write(this.fd, chunk, 0, remaining, p, (err, n) => {
          if (err && err.code === "EAGAIN") err = null;
          if (this.destroyed || err) {
            callback(
              err ? enrichErr(err, "write") : new ERR_STREAM_DESTROYED("write"),
            );
            return;
          }
          const written = typeof n === "number" ? n : remaining;
          const nextRetries = written ? 0 : retries + 1;
          if (nextRetries > 5) {
            const e = new Error("write failed");
            e.code = "ERR_SYSTEM_ERROR";
            callback(e);
            return;
          }
          step(offset + written, nextRetries);
        });
      };
      step(0, 0);
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
      // Node's writevAll: same EAGAIN/partial-write retry loop as _writeAll.
      const total = buffers.reduce((a, b) => a + b.byteLength, 0);
      const step = (offset, retries) => {
        const remaining = total - offset;
        if (remaining <= 0) {
          if (pos !== null && pos !== undefined) this._pos = pos + total;
          emitFs("fs", "writeStream.write", this.path, total);
          callback(null);
          return;
        }
        const rest =
          offset === 0 ? buffers : [concatBuffers(buffers).slice(offset)];
        const p = pos === null || pos === undefined ? pos : pos + offset;
        this._impl.writev(this.fd, rest, p, (err, n) => {
          if (err && err.code === "EAGAIN") err = null;
          if (this.destroyed || err) {
            callback(
              err
                ? enrichErr(err, "write")
                : new ERR_STREAM_DESTROYED("writev"),
            );
            return;
          }
          const written = typeof n === "number" ? n : remaining;
          const nextRetries = written ? 0 : retries + 1;
          if (nextRetries > 5) {
            const e = new Error("writev failed");
            e.code = "ERR_SYSTEM_ERROR";
            callback(e);
            return;
          }
          step(offset + written, nextRetries);
        });
      };
      step(0, 0);
    }
    _final(callback) {
      this._cleanup();
      callback(null);
    }
    _cleanup() {
      closeStreamFd(this);
    }
    _destroy(err, callback) {
      this._destroyCalled = true;
      this._cleanup();
      callback(err);
    }
    // Node's WriteStream.prototype.close(cb): same contract as ReadStream.
    close(cb) {
      if (typeof cb === "function") {
        if (this.closed) nextTick(cb);
        else this.once("close", cb);
      }
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
    if (new.target === undefined && this instanceof FsReadStream) {
      // Subclass compat: fs.ReadStream.call(this, ...) must initialize
      // `this` in place (test-fs-stream-construct-compat-error-read.js).
      // Readable is a plain function, so it can run on the existing `this`;
      // the rest of the constructor is factored as _initReadStream.
      validateStreamOptions(options);
      Readable.call(this, streamOpts(options || {}));
      this._initReadStream(path, options);
      return this;
    }
    return new FsReadStream(path, options);
  }
  function WriteStreamFactory(path, options) {
    validateEncodingOpt(options);
    if (new.target === undefined && this instanceof WriteStreamFactory) {
      // Legacy subclass compat: fs.WriteStream.call(this, ...) must
      // initialize `this` in place, like Node's old-style function
      // constructor (test-fs-stream-construct-compat-error-write.js).
      // Build a correctly-prototyped instance, transplant its state onto
      // `this`, defuse its scheduled _construct, and re-arm the deferred
      // open on the real `this`.
      const inst = Reflect.construct(
        FsWriteStream,
        [path, options],
        this.constructor,
      );
      inst._constructDefused = true;
      for (const key of Reflect.ownKeys(inst)) {
        Object.defineProperty(
          this,
          key,
          Object.getOwnPropertyDescriptor(inst, key),
        );
      }
      this._openPending = true;
      nextTick(() => {
        if (this.open !== writeStreamOpenNoop) openWithPatchedOpen(this);
        else this._openWithImpl(() => {});
      });
      return this;
    }
    return new FsWriteStream(path, options);
  }
  ReadStreamFactory.prototype = FsReadStream.prototype;
  WriteStreamFactory.prototype = FsWriteStream.prototype;
  // WriteStream autoClose accessor (placed after the class is defined).
  Object.defineProperty(FsWriteStream.prototype, "autoClose", {
    configurable: true,
    get() {
      if (
        typeof this !== "object" ||
        this === null ||
        !Object.prototype.hasOwnProperty.call(this, "_writableState")
      )
        throw errInvalidThis("WriteStream");
      return this._writableState.autoDestroy;
    },
    set(val) {
      if (
        typeof this !== "object" ||
        this === null ||
        !Object.prototype.hasOwnProperty.call(this, "_writableState")
      )
        throw errInvalidThis("WriteStream");
      this._writableState.autoDestroy = val;
    },
  });
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
      // filehandle.read(buffer[, offset[, length[, position]]]) /
      // filehandle.read(options) / filehandle.read(buffer, options) —
      // see lib/internal/fs/promises.js read().
      let buffer = arg1;
      let offset = arg2;
      let length = arg3;
      let position = arg4;
      if (!ArrayBuffer.isView(buffer)) {
        // read(params)
        if (buffer !== undefined) validateOptionsObject(buffer, "options");
        ({
          buffer = allocReadBuffer(16384),
          offset = 0,
          length = buffer.byteLength - offset,
          position = null,
        } = buffer ?? {});
        validateBuffer(buffer);
      }
      if (offset !== null && typeof offset === "object") {
        // read(buffer, options)
        ({
          offset = 0,
          length = buffer.byteLength - offset,
          position = null,
        } = offset);
      }
      if (offset == null) {
        offset = 0;
      } else {
        validateInteger(offset, "offset", 0);
      }
      if (length === undefined || length === null)
        length = buffer.byteLength - offset;
      if (position == null) {
        position = -1;
      } else {
        validatePosition(position, "position", length);
      }
      if (length === 0) return { bytesRead: 0, buffer };
      if (buffer.byteLength === 0) throw errBufferEmpty("buffer", buffer);
      validateOffsetLengthRead(offset, length, buffer.byteLength);
      checkFdReadable(this.fd, "read");
      const bytesRead = readMemfs(
        this.fd,
        buffer,
        offset,
        length,
        position,
        "read",
      );
      emitFs("fs", "promises.read", this.fd, bytesRead);
      return { bytesRead, buffer };
    }
    async write(arg1, arg2, arg3, arg4) {
      // Node's FileHandle.write shares lib/fs.js write() validation
      // (options-object form included); it resolves { bytesWritten, buffer }
      // with the ORIGINAL data (a string stays a string).
      const data = arg1;
      if (typeof data !== "string") validateDataArg(data, "buffer");
      const args = parseWriteArgs(data, [arg2, arg3, arg4], false);
      let buf = args.buf;
      let offset = args.offset;
      let length = args.length;
      if (typeof buf === "string") {
        buf =
          typeof Buffer !== "undefined"
            ? Buffer.from(buf, args.encoding)
            : new TextEncoder().encode(buf);
        offset = 0;
        length = buf.byteLength;
      }
      checkFdWritable(this.fd, "write");
      const savedPos =
        typeof args.position === "number" ? getPosition(this.fd) : undefined;
      let bytesWritten;
      try {
        bytesWritten = vol.writeSync(
          this.fd,
          buf,
          offset,
          length,
          args.position,
        );
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
      validateEncodingOpt(options);
      try {
        // Reads from the fd's current position (memfs reads from 0) and
        // honors the `buffer` option — see readFileSyncManual.
        const data = readFileSyncManual(this.fd, options);
        emitFs("fs", "promises.readFile", this.fd, data);
        return data;
      } catch (e) {
        throw enrichErr(e, "readFile");
      }
    }
    async writeFile(data, options) {
      const signal = promiseSignal(options);
      await throwIfAborted(signal);
      const encoding =
        typeof options === "string" ? options : options?.encoding;
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
      const encoding =
        typeof options === "string" ? options : options?.encoding;
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
        validateUidGid(uid, gid);
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
    _closeSync() {
      // Synchronous close core. close() delegates; pullSync autoClose and
      // writer fail()/endSync() need the sync form (Node's kCloseSync).
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
    async close() {
      // Node: fd becomes -1, 'close' is emitted once, and a second close()
      // is a silent no-op (probed against real Node v24.20.0).
      this._closeSync();
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
    // ── New-streams pull/pullSync/writer (Node v24 --experimental-stream-iter)
    // Probed semantics against v24.20.0 (lib/internal/fs/promises.js):
    // pull() yields Uint8Array[] batches via an AsyncIterable; pullSync() the
    // sync counterpart; writer() returns a {write,writev,writeSync,
    // writevSync,end,endSync,fail} object. One of pull/pullSync/writer holds
    // the handle lock (_iterLocked) at a time; it releases when the stream
    // is fully consumed / writer ends or fails.
    _checkIterUsable() {
      if (this.fd === -1) throw errInvalidState("The FileHandle is closed");
      if (this._iterLocked) throw errInvalidState("The FileHandle is locked");
    }
    // Read one chunk for pull/pullSync: explicit position reads must not
    // disturb the fd cursor (memfs moves it — save/restore).
    _iterRead(fd, length, position) {
      const buf =
        typeof Buffer !== "undefined"
          ? Buffer.allocUnsafe(length)
          : new Uint8Array(length);
      const explicit = position >= 0;
      const savedPos = explicit ? getPosition(fd) : undefined;
      let bytesRead;
      try {
        bytesRead = vol.readSync(
          fd,
          buf,
          0,
          length,
          explicit ? position : null,
        );
      } catch (e) {
        throw enrichErr(e, "read");
      } finally {
        if (savedPos !== undefined) setPosition(fd, savedPos);
      }
      return bytesRead === 0
        ? null
        : bytesRead < length
          ? buf.subarray(0, bytesRead)
          : buf;
    }
    pull(...args) {
      this._checkIterUsable();
      const { transforms, options } = parseIterPullArgs(args);
      const opts = options || {};
      const autoClose = validateIterAutoClose(opts);
      let pos = validateIterIntOption(opts, "start", 0);
      if (pos === undefined) pos = -1;
      let remaining = validateIterIntOption(opts, "limit", 1);
      if (remaining === undefined) remaining = -1;
      let readSize = validateIterIntOption(opts, "chunkSize", 1);
      if (readSize === undefined) readSize = kIterDefaultChunkSize;
      const signal =
        opts.signal === undefined
          ? undefined
          : validateAbortSignal(opts.signal, "options.signal");
      checkFdReadable(this.fd, "read");

      const handle = this;
      const fd = this.fd;
      this._iterLocked = true;

      const source = {
        async *[Symbol.asyncIterator]() {
          try {
            while (remaining !== 0) {
              if (signal?.aborted)
                throw signal.reason ?? makeAbortError(signal);
              const toRead =
                remaining > 0 ? Math.min(readSize, remaining) : readSize;
              const chunk = handle._iterRead(fd, toRead, pos);
              if (chunk === null) break;
              if (pos >= 0) pos += chunk.byteLength;
              if (remaining > 0) remaining -= chunk.byteLength;
              yield [chunk];
            }
          } finally {
            handle._iterLocked = false;
            if (autoClose) await handle.close();
          }
        },
      };
      if (transforms.length > 0)
        return applyIterTransformsAsync(source, transforms, signal);
      return source;
    }
    pullSync(...args) {
      this._checkIterUsable();
      const { transforms, options } = parseIterPullArgs(args);
      const opts = options || {};
      const autoClose = validateIterAutoClose(opts);
      let pos = validateIterIntOption(opts, "start", 0);
      if (pos === undefined) pos = -1;
      let remaining = validateIterIntOption(opts, "limit", 1);
      if (remaining === undefined) remaining = -1;
      let readSize = validateIterIntOption(opts, "chunkSize", 1);
      if (readSize === undefined) readSize = kIterDefaultChunkSize;
      checkFdReadable(this.fd, "read");

      const handle = this;
      const fd = this.fd;
      this._iterLocked = true;

      function cleanup() {
        handle._iterLocked = false;
        if (autoClose) handle._closeSync();
      }
      const source = {
        [Symbol.iterator]() {
          let done = false;
          return {
            next() {
              if (done || remaining === 0) {
                if (!done) {
                  done = true;
                  cleanup();
                }
                return { value: undefined, done: true };
              }
              const toRead =
                remaining > 0 ? Math.min(readSize, remaining) : readSize;
              let chunk;
              try {
                chunk = handle._iterRead(fd, toRead, pos);
              } catch (err) {
                done = true;
                cleanup();
                throw err;
              }
              if (chunk === null) {
                done = true;
                cleanup();
                return { value: undefined, done: true };
              }
              if (pos >= 0) pos += chunk.byteLength;
              if (remaining > 0) remaining -= chunk.byteLength;
              return { value: [chunk], done: false };
            },
            return() {
              if (!done) {
                done = true;
                cleanup();
              }
              return { value: undefined, done: true };
            },
          };
        },
      };
      if (transforms.length > 0)
        return applyIterTransformsSync(source, transforms);
      return source;
    }
    writer(options = undefined) {
      this._checkIterUsable();
      if (options === undefined || options === null) options = {};
      if (typeof options !== "object")
        throw errInvalidArgType("options", "Object", options);
      const autoClose = validateIterAutoClose(options);
      let pos = validateIterIntOption(options, "start", 0);
      if (pos === undefined) pos = -1;
      let bytesRemaining = validateIterIntOption(options, "limit", 1);
      if (bytesRemaining === undefined) bytesRemaining = -1;
      let syncWriteThreshold = validateIterIntOption(options, "chunkSize", 1);
      if (syncWriteThreshold === undefined)
        syncWriteThreshold = kIterDefaultChunkSize;

      const handle = this;
      const fd = this.fd;
      let totalBytesWritten = 0;
      let closed = false;
      let closing = false;
      let pendingEndPromise = null;
      let error = null;
      let asyncPending = false;
      this._iterLocked = true;

      // Single writeSync with the fd cursor preserved for explicit
      // positions (memfs moves it — save/restore like _iterRead).
      function writeOneSync(buf, offset, length, position) {
        const explicit = position >= 0;
        const savedPos = explicit ? getPosition(fd) : undefined;
        try {
          return vol.writeSync(
            fd,
            buf,
            offset,
            length,
            explicit ? position : null,
          );
        } finally {
          if (savedPos !== undefined) setPosition(fd, savedPos);
        }
      }
      // Full async write with EAGAIN-style retry (memfs never partial-writes;
      // the loop is a safety net matching Node's writeAll shape).
      async function writeAll(buf, offset, length, position, signal) {
        asyncPending = true;
        // Yield once so asyncPending is observably true until the write
        // actually completes (Node's binding.writeBuffer always defers to
        // the threadpool; memfs writes are synchronous, so without this the
        // flag would clear before write() even returns its promise).
        await Promise.resolve();
        try {
          let retries = 0;
          while (length > 0) {
            let bytesWritten;
            try {
              bytesWritten = writeOneSync(buf, offset, length, position);
            } catch (e) {
              throw enrichErr(e, "write");
            }
            signal?.throwIfAborted();
            if (bytesWritten === 0) {
              if (++retries > 5)
                throw errOutOfRange("write", "a successful write", 0);
            } else {
              retries = 0;
            }
            totalBytesWritten += bytesWritten;
            offset += bytesWritten;
            length -= bytesWritten;
            if (position >= 0) position += bytesWritten;
          }
        } finally {
          asyncPending = false;
        }
      }
      async function writevAll(buffers, position, signal) {
        asyncPending = true;
        await Promise.resolve();
        try {
          let totalSize = 0;
          for (const b of buffers) totalSize += b.byteLength;
          let retries = 0;
          while (totalSize > 0) {
            // memfs has no single-syscall writev; write buffers in order.
            let bytesWritten = 0;
            try {
              for (const b of buffers) {
                if (b.byteLength === 0) continue;
                const n = writeOneSync(
                  b,
                  0,
                  b.byteLength,
                  position >= 0 ? position + bytesWritten : -1,
                );
                bytesWritten += n;
                if (n < b.byteLength) break;
              }
            } catch (e) {
              throw enrichErr(e, "writev");
            }
            signal?.throwIfAborted();
            if (bytesWritten === 0) {
              if (++retries > 5)
                throw errOutOfRange("writev", "a successful write", 0);
            } else {
              retries = 0;
            }
            totalBytesWritten += bytesWritten;
            totalSize -= bytesWritten;
            if (position >= 0) position += bytesWritten;
            if (totalSize > 0) {
              // Partial write: continue with the remaining tail.
              let skip = bytesWritten;
              const rest = [];
              for (const b of buffers) {
                if (skip >= b.byteLength) {
                  skip -= b.byteLength;
                  continue;
                }
                rest.push(skip === 0 ? b : b.subarray(skip, b.byteLength));
                skip = 0;
              }
              buffers = rest;
            }
          }
        } finally {
          asyncPending = false;
        }
      }
      // Complete a partial sync write (cannot return false: the bytes are
      // already on disk, and pipeTo would re-send them).
      function writeSyncAll(buf, offset, length, position) {
        let retries = 0;
        while (length > 0) {
          let bytesWritten;
          try {
            bytesWritten = writeOneSync(buf, offset, length, position);
          } catch (e) {
            throw enrichErr(e, "write");
          }
          if (bytesWritten === 0) {
            if (++retries > 5)
              throw errOutOfRange("write", "a successful write", 0);
          } else {
            retries = 0;
          }
          totalBytesWritten += bytesWritten;
          offset += bytesWritten;
          length -= bytesWritten;
          if (position >= 0) position += bytesWritten;
        }
      }
      async function cleanup() {
        if (closed) return;
        closed = true;
        handle._iterLocked = false;
        if (autoClose) await handle.close();
      }
      // Node validates write/writev/end options synchronously (throw, not
      // reject); only a pre-aborted signal rejects.
      function validateWriteOptions(opts) {
        if (opts === undefined) return undefined;
        if (opts === null || typeof opts !== "object")
          throw errInvalidArgType("options", "Object", opts);
        if (opts.signal !== undefined)
          validateAbortSignal(opts.signal, "options.signal");
        return opts.signal;
      }

      return {
        __proto__: null,
        write(chunk, options = undefined) {
          if (error) return Promise.reject(error);
          if (closed)
            return Promise.reject(
              errInvalidStateTypeError("The writer is closed"),
            );
          const signal = validateWriteOptions(options);
          if (signal?.aborted) return Promise.reject(signal.reason);
          chunk = iterToUint8Array(chunk);
          if (bytesRemaining >= 0 && chunk.byteLength > bytesRemaining) {
            return Promise.reject(
              errOutOfRange(
                "write",
                `<= ${bytesRemaining} bytes`,
                chunk.byteLength,
              ),
            );
          }
          if (bytesRemaining > 0) bytesRemaining -= chunk.byteLength;
          const position = pos;
          if (pos >= 0) pos += chunk.byteLength;
          return writeAll(chunk, 0, chunk.byteLength, position, signal);
        },
        writev(chunks, options = undefined) {
          if (error) return Promise.reject(error);
          if (closed)
            return Promise.reject(
              errInvalidStateTypeError("The writer is closed"),
            );
          const signal = validateWriteOptions(options);
          if (signal?.aborted) return Promise.reject(signal.reason);
          chunks = iterConvertChunks(chunks);
          let totalSize = 0;
          for (const b of chunks) totalSize += b.byteLength;
          if (bytesRemaining >= 0 && totalSize > bytesRemaining) {
            return Promise.reject(
              errOutOfRange("writev", `<= ${bytesRemaining} bytes`, totalSize),
            );
          }
          if (bytesRemaining > 0) bytesRemaining -= totalSize;
          const position = pos;
          if (pos >= 0) pos += totalSize;
          return writevAll(chunks, position, signal);
        },
        writeSync(chunk) {
          if (error || closed || asyncPending) return false;
          chunk = iterToUint8Array(chunk);
          const length = chunk.byteLength;
          if (length > syncWriteThreshold) return false;
          if (length === 0) return true;
          if (bytesRemaining >= 0 && length > bytesRemaining) return false;
          const position = pos;
          let bytesWritten;
          try {
            bytesWritten = writeOneSync(chunk, 0, length, position);
          } catch {
            return false;
          }
          totalBytesWritten += bytesWritten;
          if (position >= 0) pos = position + bytesWritten;
          if (bytesWritten === length) {
            if (bytesRemaining > 0) bytesRemaining -= length;
            return true;
          }
          // Partial write — bytes are on disk; must complete or throw.
          writeSyncAll(
            chunk,
            bytesWritten,
            length - bytesWritten,
            position >= 0 ? position + bytesWritten : -1,
          );
          if (bytesRemaining > 0) bytesRemaining -= length;
          return true;
        },
        writevSync(chunks) {
          if (error || closed || asyncPending) return false;
          chunks = iterConvertChunks(chunks);
          let totalSize = 0;
          for (const b of chunks) totalSize += b.byteLength;
          if (totalSize > syncWriteThreshold) return false;
          if (totalSize === 0) return true;
          if (bytesRemaining >= 0 && totalSize > bytesRemaining) return false;
          const position = pos;
          let bytesWritten = 0;
          try {
            for (const b of chunks) {
              if (b.byteLength === 0) continue;
              const n = writeOneSync(
                b,
                0,
                b.byteLength,
                position >= 0 ? position + bytesWritten : -1,
              );
              bytesWritten += n;
              if (n < b.byteLength) break;
            }
          } catch {
            return false;
          }
          totalBytesWritten += bytesWritten;
          if (position >= 0) pos = position + bytesWritten;
          if (bytesWritten === totalSize) {
            if (bytesRemaining > 0) bytesRemaining -= totalSize;
            return true;
          }
          // Partial writev — complete the tail synchronously or throw.
          let skip = bytesWritten;
          const rest = [];
          for (const b of chunks) {
            if (skip >= b.byteLength) {
              skip -= b.byteLength;
              continue;
            }
            rest.push(skip === 0 ? b : b.subarray(skip));
            skip = 0;
          }
          const tail = Buffer.concat
            ? Buffer.concat(rest.map((b) => Buffer.from(b)))
            : rest.reduce((acc, b) => {
                const n = new Uint8Array(acc.length + b.length);
                n.set(acc, 0);
                n.set(b, acc.length);
                return n;
              }, new Uint8Array(0));
          writeSyncAll(
            tail,
            0,
            tail.byteLength,
            position >= 0 ? position + bytesWritten : -1,
          );
          if (bytesRemaining > 0) bytesRemaining -= totalSize;
          return true;
        },
        end(options = undefined) {
          if (error) return Promise.reject(error);
          if (closed) return Promise.resolve(totalBytesWritten);
          if (closing) return pendingEndPromise;
          const signal = validateWriteOptions(options);
          if (signal?.aborted) return Promise.reject(signal.reason);
          closing = true;
          pendingEndPromise = cleanup().then(() => totalBytesWritten);
          return pendingEndPromise;
        },
        endSync() {
          if (error) return -1;
          if (closed) return totalBytesWritten;
          if (asyncPending) return -1;
          closed = true;
          handle._iterLocked = false;
          if (autoClose) handle._closeSync();
          return totalBytesWritten;
        },
        fail(reason) {
          if (closed || error) return;
          error = reason ?? errInvalidState("Failed");
          closed = true;
          handle._iterLocked = false;
          if (autoClose) handle._closeSync();
        },
        [Symbol.asyncDispose]() {
          if (closing) return pendingEndPromise ?? Promise.resolve();
          if (!closed && !error) this.fail();
          return Promise.resolve();
        },
        [Symbol.dispose]() {
          this.fail();
        },
      };
    }
  }
  // Real Node rejects FileHandle method calls on non-FileHandle receivers:
  // ERR_INTERNAL_ASSERTION "handle must be an instance of FileHandle".
  for (const m of [
    "stat",
    "read",
    "write",
    "readv",
    "writev",
    "readFile",
    "writeFile",
    "appendFile",
    "truncate",
    "chmod",
    "chown",
    "utimes",
    "datasync",
    "sync",
    "close",
    "readableWebStream",
    "createReadStream",
    "createWriteStream",
    "readLines",
    "pull",
    "pullSync",
  ]) {
    const orig = FileHandle.prototype[m];
    if (typeof orig !== "function") continue;
    const isAsync = orig.constructor.name === "AsyncFunction";
    FileHandle.prototype[m] = function (...args) {
      if (!(this instanceof FileHandle)) {
        const err = new Error("handle must be an instance of FileHandle");
        err.code = "ERR_INTERNAL_ASSERTION";
        // Async methods reject; sync methods throw (matches real Node).
        if (isAsync) return Promise.reject(err);
        throw err;
      }
      return orig.apply(this, args);
    };
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
        return Promise.reject(restackAtBoundary(enrichErr(e, name)));
      }
      return Promise.resolve(result).then(
        (val) => {
          emitFs("fs", `promises.${name}`, ...args, val);
          return val;
        },
        (err) => {
          emitFs("fs", `promises.${name}`, ...args, undefined);
          throw restackAtBoundary(enrichErr(err, name));
        },
      );
    };
  };
  // Node hides its internal frames (hideStackFrames); without this, promise
  // rejections carry memfs/vol stack frames that real Node never shows
  // (e.g. test-fs-promises.js asserts the stack contains the test's async
  // frame, not Volume.statBase). Re-capture the stack at the public
  // boundary; V8 async stack traces link it to the caller's await.
  function restackAtBoundary(err) {
    if (!err || typeof err !== "object" || typeof err.stack !== "string")
      return err;
    const frames = String(new Error().stack);
    const nl = frames.indexOf("\n");
    try {
      err.stack = err.toString() + (nl < 0 ? "" : frames.slice(nl));
    } catch {}
    return err;
  }

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
              dir._readInFlight = true;
              nextTick(() => {
                dir._readInFlight = false;
                try {
                  res(dir.readSync());
                } catch (e) {
                  rej(enrichErr(e, "opendir"));
                }
              });
            });
          const origClose = dir.close.bind(dir);
          dir.close = (cb) => {
            if (cb === undefined) {
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
            }
            // Non-function callback throws ERR_INVALID_ARG_TYPE (via Dir#close).
            return origClose(cb);
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
  definePromise("cp", (src, dest, options) => {
    // promises.cp validates options directly (no callback shifting):
    // a function options is ERR_INVALID_ARG_TYPE, not a callback.
    validateCpOptions(options);
    return new Promise((resolve, reject) => {
      fs.cp(src, dest, options, (err) => (err ? reject(err) : resolve()));
    });
  });
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
    // Validate `ignore` with the shared validator (throws on iteration
    // start, like real Node).
    try {
      validateIgnoreOption(options && options.ignore);
    } catch (err) {
      return (async function* () {
        throw err;
      })();
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
    const err = new Error("The lchmod() method is not implemented");
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

// fs.constants is the 56-key fs-only subset of node:constants, on a
// null-prototype object (matches real Node: Object.getPrototypeOf(fs.constants)
// === null, and fs.promises.constants === fs.constants). Not frozen in real
// Node either.
const FS_CONSTANT_NAMES = [
  "UV_FS_SYMLINK_DIR",
  "UV_FS_SYMLINK_JUNCTION",
  "O_RDONLY",
  "O_WRONLY",
  "O_RDWR",
  "UV_DIRENT_UNKNOWN",
  "UV_DIRENT_FILE",
  "UV_DIRENT_DIR",
  "UV_DIRENT_LINK",
  "UV_DIRENT_FIFO",
  "UV_DIRENT_SOCKET",
  "UV_DIRENT_CHAR",
  "UV_DIRENT_BLOCK",
  "S_IFMT",
  "S_IFREG",
  "S_IFDIR",
  "S_IFCHR",
  "S_IFBLK",
  "S_IFIFO",
  "S_IFLNK",
  "S_IFSOCK",
  "O_CREAT",
  "O_EXCL",
  "UV_FS_O_FILEMAP",
  "O_NOCTTY",
  "O_TRUNC",
  "O_APPEND",
  "O_DIRECTORY",
  "O_NOATIME",
  "O_NOFOLLOW",
  "O_SYNC",
  "O_DSYNC",
  "O_DIRECT",
  "O_NONBLOCK",
  "S_IRWXU",
  "S_IRUSR",
  "S_IWUSR",
  "S_IXUSR",
  "S_IRWXG",
  "S_IRGRP",
  "S_IWGRP",
  "S_IXGRP",
  "S_IRWXO",
  "S_IROTH",
  "S_IWOTH",
  "S_IXOTH",
  "F_OK",
  "R_OK",
  "W_OK",
  "X_OK",
  "UV_FS_COPYFILE_EXCL",
  "COPYFILE_EXCL",
  "UV_FS_COPYFILE_FICLONE",
  "COPYFILE_FICLONE",
  "UV_FS_COPYFILE_FICLONE_FORCE",
  "COPYFILE_FICLONE_FORCE",
];

function buildFsConstants() {
  const c = Object.create(null);
  for (const k of FS_CONSTANT_NAMES) c[k] = nodeConstants[k];
  return c;
}

function buildSingleton() {
  const rt = getRuntime();
  if (rt && rt.__FS__) return rt.__FS__;
  const vol = createVolume();
  const fs = buildApi(vol);
  // readdirImpl builds the module-scope Dirent class; expose that same
  // class as fs.Dirent so `dirent instanceof fs.Dirent` holds.
  fs.Dirent = Dirent;
  fs._vol = vol;
  fs.constants = buildFsConstants();
  fs.promises.constants = fs.constants;
  // memfs's createFsFromVolume attaches its own Dirent class; the shim must
  // expose ours (Dirent instances from readdir/opendir/glob are ours).
  fs.Dirent = Dirent;
  // memfs also attaches its own Stats; expose our PublicStats (14-arg,
  // DEP0180-emitting) instead.
  fs.Stats = PublicStats;
  // memfs's createFsFromVolume copies Node's internal toUnixTimestamp;
  // expose our validating _toUnixTimestamp instead.
  fs._toUnixTimestamp = _toUnixTimestamp;
  // Real Node exposes F_OK/R_OK/W_OK/X_OK on the fs namespace as getter-only,
  // NON-enumerable properties (memfs's createFsFromVolume copies them as
  // writable enumerable data props); assignment must throw TypeError in
  // strict mode. Reading any of them emits DEP0176 — once per process,
  // shared across all four keys.
  let dep0176Warned = false;
  for (const k of ["F_OK", "R_OK", "W_OK", "X_OK"]) {
    const v = fs[k];
    Object.defineProperty(fs, k, {
      enumerable: false,
      configurable: true,
      get: () => {
        if (!dep0176Warned) {
          dep0176Warned = true;
          try {
            if (
              typeof process !== "undefined" &&
              typeof process.emitWarning === "function"
            ) {
              process.emitWarning(
                `fs.${k} is deprecated, use fs.constants.${k} instead`,
                "DeprecationWarning",
                "DEP0176",
              );
            }
          } catch {}
        }
        return v;
      },
    });
  }
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
