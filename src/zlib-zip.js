// zlib ZIP archive API — port of Node 26's MIT-licensed pure-JS
// `lib/internal/zip/*.js` (constants, content-size, binary, dos,
// extra-fields, headers, header-builders, compression, entry, buffer,
// archive, file, fs-util) onto the shim's existing engines: pako (deflate),
// vendored zstdify (zstd), the shim `crc32`, and `node:fs` / `node:stream`.
//
// ponytail: the port is near-verbatim Node logic with the primordials,
// `internal/*` requires and `internalBinding` calls replaced by plain
// globals and the shim's own primitives — the validation, error codes and
// messages, header layout and hardening checks are Node's, so the Node 26
// zip tests are the oracle. Two deliberate deviations from Node, both
// documented where they occur:
//   1. `fs`/`stream` come from `import fs from "node:fs"` / `import
//      { Readable } from "node:stream"` (the net.js precedent): under the
//      parity harness those resolve to the real modules, so ZipFile sees the
//      same files the tests write; in the sandbox build esbuild externalizes
//      `node:*` and the runtime resolves them to the memfs-backed shim fs
//      and the shim stream. The virtual-fs-only scope is the same honest
//      scope as the fs shim — real OS paths are virtual-fs only in browser.
//   2. `zipFiles` streams file contents with path-based
//      `fs.createReadStream(path)` after an `isFile()` pre-check, instead of
//      Node's fd-pinned `fs.promises.open` + `createReadStream({ fd })`:
//      the single-threaded memfs / parity-test use has no observable TOCTOU
//      window, and the pre-check rejects FIFOs/devices before any open.
//   3. zstd streaming is accumulate + one-shot zstdify (zstdify has no
//      streaming encoder); observable semantics (chunks, CRC, declared-size
//      caps, errors) are preserved, only memory/timing differ.
// Ceiling: `internal/zip/*` itself is NOT exposed (no `--expose-internals`
// equivalent), so `test-zlib-zip-internals.js` stays NO-FIX; `ZipFile` fd
// semantics are the virtual fs, never real OS fds in the browser.
// Upgrade path: if the runtime ever exposes internal modules, export the
// raw classes under `node:internal/zip` instead of only via `node:zlib`.

import { Deflate as PakoDeflate, Inflate as PakoInflate } from "pako";
import bufferExports from "./buffer.js";
import {
  crc32,
  deflateRaw,
  deflateRawSync,
  inflateRaw,
  inflateRawSync,
  zstdCompress,
  zstdCompressSync,
  zstdDecompress,
  zstdDecompressSync,
} from "./zlib.js";
import fs from "node:fs";
import { Readable } from "node:stream";

// ponytail: `Buffer` here is deliberately the GLOBAL, not the shim's
// `bufferExports.Buffer` — exactly like src/zlib.js, which binds no local
// Buffer. Under the parity harness the global is the real Node Buffer, so
// buffers this module hands to a test are reference-comparable with the
// test's own Buffers (`assert.deepStrictEqual` checks prototypes); in the
// sandbox the runtime installs the shim Buffer as the global before any
// shim loads, so the same code is the shim Buffer there. Only `isUtf8` and
// `kMaxLength` are read from the shim module (a function and a number, both
// realm-neutral).
const isUtf8 = bufferExports.isUtf8;
const kMaxLength = bufferExports.kMaxLength;

// ---------------------------------------------------------------------------
// Errors (Node-compatible shapes; message formats copied from src/zlib.js,
// which ports lib/internal/errors.js — tests assert `code`, and some assert
// message fragments, so both must match Node).
// ---------------------------------------------------------------------------

class ERR_INVALID_ARG_TYPE extends TypeError {
  constructor(name, expected, actual) {
    const isProperty = name.includes(".");
    const kind = isProperty ? "property" : "argument";
    let received;
    if (actual === undefined) received = "Received undefined";
    else if (actual === null) received = "Received null";
    else if (typeof actual === "object") {
      const proto = Object.getPrototypeOf(actual);
      const protoName =
        proto && proto.constructor ? proto.constructor.name : "Object";
      received = `Received an instance of ${protoName}`;
    } else if (typeof actual === "string")
      received = `Received type ${typeof actual} ('${actual}')`;
    else received = `Received type ${typeof actual} (${actual})`;
    super(`The "${name}" ${kind} must be of type ${expected}. ${received}`);
    this.code = "ERR_INVALID_ARG_TYPE";
  }
}
class ERR_OUT_OF_RANGE extends RangeError {
  constructor(name, range, value) {
    let msg = `The value of "${name}" is out of range.`;
    if (range) msg += ` ${range}`;
    msg += ` Received ${value}`;
    super(msg);
    this.code = "ERR_OUT_OF_RANGE";
  }
}
class ERR_INVALID_ARG_VALUE extends TypeError {
  constructor(name, value, reason = "is invalid") {
    super(`The argument "${name}" ${reason}. Received ${value}`);
    this.code = "ERR_INVALID_ARG_VALUE";
  }
}
class ERR_BUFFER_TOO_LARGE extends RangeError {
  constructor(max) {
    super(`Cannot create a Buffer larger than ${max} bytes`);
    this.code = "ERR_BUFFER_TOO_LARGE";
  }
}
class ERR_INVALID_STATE extends Error {
  constructor(message) {
    super(`Invalid state: ${message}`);
    this.code = "ERR_INVALID_STATE";
  }
}
class ERR_ZIP_ARCHIVE_TOO_LARGE extends RangeError {
  constructor(message) {
    super(`ZIP archive structure exceeds the allowed size: ${message}`);
    this.code = "ERR_ZIP_ARCHIVE_TOO_LARGE";
  }
}
class ERR_ZIP_ENTRY_CORRUPT extends Error {
  constructor(message) {
    super(`ZIP entry is corrupt: ${message}`);
    this.code = "ERR_ZIP_ENTRY_CORRUPT";
  }
}
class ERR_ZIP_ENTRY_NOT_FOUND extends Error {
  constructor(name) {
    super(`no such entry ${JSON.stringify(name)} in the archive`);
    this.code = "ERR_ZIP_ENTRY_NOT_FOUND";
  }
}
class ERR_ZIP_ENTRY_TOO_LARGE extends RangeError {
  constructor(message) {
    super(`ZIP entry exceeds the allowed size: ${message}`);
    this.code = "ERR_ZIP_ENTRY_TOO_LARGE";
  }
}
class ERR_ZIP_INVALID_ARCHIVE extends Error {
  constructor(message) {
    super(`invalid ZIP archive: ${message}`);
    this.code = "ERR_ZIP_INVALID_ARCHIVE";
  }
}
class ERR_ZIP_NOT_WRITABLE extends TypeError {
  constructor() {
    super("this archive was not opened for writing");
    this.code = "ERR_ZIP_NOT_WRITABLE";
  }
}
class ERR_ZIP_UNSUPPORTED_FEATURE extends Error {
  constructor(message) {
    super(`unsupported ZIP feature: ${message}`);
    this.code = "ERR_ZIP_UNSUPPORTED_FEATURE";
  }
}

// ---------------------------------------------------------------------------
// Validators (lib/internal/validators.js, Node's codes/messages).
// ---------------------------------------------------------------------------

function validateString(value, name) {
  if (typeof value !== "string") {
    throw new ERR_INVALID_ARG_TYPE(name, "string", value);
  }
}
function validateInteger(value, name, min = -2147483648, max = 2147483647) {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "integer", value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, "It must be an integer.", value);
  }
  if (value < min) {
    throw new ERR_OUT_OF_RANGE(name, `It must be >= ${min}.`, value);
  }
  if (value > max) {
    throw new ERR_OUT_OF_RANGE(name, `It must be <= ${max}.`, value);
  }
}
function validateUint32(value, name) {
  validateInteger(value, name, 0, 4294967295);
}
function validateBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new ERR_INVALID_ARG_TYPE(name, "boolean", value);
  }
}
function validateObject(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new ERR_INVALID_ARG_TYPE(name, "Object", value);
  }
}
function validateFunction(value, name) {
  if (typeof value !== "function") {
    throw new ERR_INVALID_ARG_TYPE(name, "function", value);
  }
}

// ---------------------------------------------------------------------------
// Type helpers (lib/internal/util/types.js, brand checks).
// ---------------------------------------------------------------------------

const objectToString = Object.prototype.toString;
function isDate(value) {
  return objectToString.call(value) === "[object Date]";
}
function isUint8Array(value) {
  return (
    value instanceof Uint8Array ||
    objectToString.call(value) === "[object Uint8Array]"
  );
}
function isArrayBufferView(value) {
  return ArrayBuffer.isView(value);
}
function isAnyArrayBuffer(value) {
  return (
    value instanceof ArrayBuffer ||
    objectToString.call(value) === "[object SharedArrayBuffer]"
  );
}

// ---------------------------------------------------------------------------
// Constants (lib/internal/zip/constants.js, verbatim).
// ---------------------------------------------------------------------------

const EMPTY_BUFFER = Buffer.alloc(0);
const BIGINT_MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

const SIG_LOCAL_FILE_HEADER = 0x04034b50;
const SIG_DATA_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL_FILE_HEADER = 0x02014b50;
const SIG_ZIP64_EOCD_RECORD = 0x06064b50;
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;
const SIG_EOCD = 0x06054b50;

const MADE_BY_UNIX = 3;
const ZIP64_EXTRA_ID = 0x0001;

const SENTINEL16 = 0xffff;
const SENTINEL32 = 0xffffffff;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const METHOD_ZSTD = 93;

const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
const VERSION_ZSTD = 63;

const ZIP64_EOCD_MAX_LENGTH = 56 + 1024 * 1024;

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFMT = 0o170000;

const EXTRA_ID_NTFS = 0x000a;
const EXTRA_ID_EXT_TIMESTAMP = 0x5455;
const EXTRA_ID_UNIX_OLD = 0x5855;
const EXTRA_ID_UNICODE_PATH = 0x7075;

const kFinalize = Symbol("kFinalize");
const kPromote = Symbol("kPromote");

const READ_CHUNK_SIZE = 4 * 1024 * 1024;
const TAIL_LENGTH = 22 + SENTINEL16 + 20 + 56 + 4096;

// ---------------------------------------------------------------------------
// Content size (lib/internal/zip/content-size.js, verbatim).
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ZIP_CONTENT_SIZE = 256 * 1024 * 1024; // 256 MiB
let maxZipContentSize = DEFAULT_MAX_ZIP_CONTENT_SIZE;

function getMaxZipContentSize() {
  return maxZipContentSize;
}

function setMaxZipContentSize(size) {
  validateInteger(size, "size", 0);
  maxZipContentSize = size;
}

// ---------------------------------------------------------------------------
// Binary helpers (lib/internal/zip/binary.js, verbatim logic).
// ---------------------------------------------------------------------------

function validateArchiveRange(buffer, offset, length, what) {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(length) ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new ERR_ZIP_INVALID_ARCHIVE(`${what} is out of bounds`);
  }
}

function readSafeUint64(buffer, offset) {
  if (offset + 8 > buffer.length) {
    throw new ERR_ZIP_INVALID_ARCHIVE("64-bit field is out of bounds");
  }
  const value = buffer.readBigUInt64LE(offset);
  if (value > BIGINT_MAX_SAFE_INTEGER) {
    throw new ERR_ZIP_INVALID_ARCHIVE(
      "64-bit field exceeds the safe integer range",
    );
  }
  return Number(value);
}

function writeSafeUint64(buffer, offset, value) {
  buffer.writeBigUInt64LE(BigInt(value), offset);
}

function toBuffer(value, name) {
  if (isUint8Array(value)) {
    return Buffer.isBuffer(value)
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (isArrayBufferView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (isAnyArrayBuffer(value)) {
    return Buffer.from(value);
  }
  throw new ERR_INVALID_ARG_TYPE(
    name,
    ["Buffer", "TypedArray", "DataView", "ArrayBuffer"],
    value,
  );
}

// ---------------------------------------------------------------------------
// DOS datetime + CP437 + Unicode Path (lib/internal/zip/dos.js, verbatim).
// ---------------------------------------------------------------------------

function decodeDosDateTime(time, date) {
  return new Date(
    ((date >>> 9) & 0x7f) + 1980,
    ((date >>> 5) & 0x0f || 1) - 1,
    (date & 0x1f) || 1,
    (time >>> 11) & 0x1f,
    (time >>> 5) & 0x3f,
    (time & 0x1f) * 2,
  );
}

function encodeDosDateTime(value) {
  const year = value.getFullYear();
  if (Number.isNaN(year)) {
    throw new ERR_INVALID_ARG_VALUE("modified", value, "must be a valid Date");
  }
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  if (year > 2107) {
    return {
      time: (23 << 11) | (59 << 5) | 29,
      date: (127 << 9) | (12 << 5) | 31,
    };
  }
  const date =
    ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate();
  const time =
    (value.getHours() << 11) |
    (value.getMinutes() << 5) |
    (value.getSeconds() >>> 1);
  return { time, date };
}

const CP437_HIGH = [
  0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7,
  0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
  0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9,
  0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192,
  0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba,
  0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
  0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
  0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f,
  0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
  0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b,
  0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
  0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4,
  0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
  0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248,
  0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0,
];

function decodeCp437(buffer) {
  let out = "";
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    out += String.fromCharCode(b < 0x80 ? b : CP437_HIGH[b - 0x80]);
  }
  return out;
}

function unicodePathName(extra, standardNameBuffer) {
  let result = null;
  forEachExtraField(extra, (id, body) => {
    if (result !== null || id !== EXTRA_ID_UNICODE_PATH || body.length < 5)
      return;
    if (body[0] !== 1) return;
    if (body.readUInt32LE(1) !== crc32(standardNameBuffer, 0)) return;
    result = body.toString("utf8", 5);
  });
  return result;
}

function decodeZipName(nameBuffer, flags, extra) {
  if (extra?.length) {
    const unicode = unicodePathName(extra, nameBuffer);
    if (unicode !== null) return unicode;
  }
  return decodeZipText(nameBuffer, flags);
}

function decodeZipText(buffer, flags) {
  if ((flags & FLAG_UTF8) || isUtf8(buffer)) return buffer.toString("utf8");
  return decodeCp437(buffer);
}

// ---------------------------------------------------------------------------
// Extra fields (lib/internal/zip/extra-fields.js, verbatim).
// ---------------------------------------------------------------------------

function parseZip64Extra(extra, want) {
  const wanted =
    want.uncompressedSize ||
    want.compressedSize ||
    want.localFileHeaderOffset ||
    want.diskNumber;
  if (!wanted) return {};
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const size = extra.readUInt16LE(pos + 2);
    if (pos + 4 + size > extra.length) {
      throw new ERR_ZIP_INVALID_ARCHIVE("extra field is malformed");
    }
    if (id === ZIP64_EXTRA_ID) {
      const result = {};
      const body = pos + 4;
      const end = body + size;
      const wantedSize =
        (want.uncompressedSize ? 8 : 0) +
        (want.compressedSize ? 8 : 0) +
        (want.localFileHeaderOffset ? 8 : 0) +
        (want.diskNumber ? 4 : 0);
      const packed = size === wantedSize;
      let cursor = body;
      const take = (fullLayoutOffset, bytes) => {
        const at = packed ? cursor : body + fullLayoutOffset;
        if (at + bytes > end) {
          throw new ERR_ZIP_INVALID_ARCHIVE(
            "the Zip64 extended information extra field is truncated",
          );
        }
        cursor += bytes;
        return bytes === 8 ? readSafeUint64(extra, at) : extra.readUInt32LE(at);
      };
      if (want.uncompressedSize) result.uncompressedSize = take(0, 8);
      if (want.compressedSize) result.compressedSize = take(8, 8);
      if (want.localFileHeaderOffset)
        result.localFileHeaderOffset = take(16, 8);
      if (want.diskNumber) result.diskNumber = take(24, 4);
      return result;
    }
    pos += 4 + size;
  }
  throw new ERR_ZIP_INVALID_ARCHIVE(
    "a field is 0xFFFFFFFF but the Zip64 extended information extra field is missing",
  );
}

function forEachExtraField(extra, cb) {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const size = extra.readUInt16LE(pos + 2);
    if (pos + 4 + size > extra.length) break;
    cb(id, extra.subarray(pos + 4, pos + 4 + size));
    pos += 4 + size;
  }
}

function parseNtfsMtime(body) {
  let result = null;
  let pos = 4;
  while (pos + 4 <= body.length) {
    const tag = body.readUInt16LE(pos);
    const size = body.readUInt16LE(pos + 2);
    if (pos + 4 + size > body.length) break;
    if (tag === 1 && size >= 8) {
      const ticks = body.readBigUInt64LE(pos + 4);
      result = new Date(Number(ticks / 10000n) - 11644473600000);
    }
    pos += 4 + size;
  }
  return result;
}

function parseExtTimestampMtime(body) {
  if (body.length < 5 || (body[0] & 1) === 0) return null;
  return new Date(body.readInt32LE(1) * 1000);
}

function parseUnixOldMtime(body) {
  if (body.length < 8) return null;
  return new Date(body.readInt32LE(4) * 1000);
}

function extraFieldMtime(...extras) {
  let ntfs = null;
  let ext = null;
  let unix = null;
  for (const extra of extras) {
    if (!extra?.length) continue;
    forEachExtraField(extra, (id, body) => {
      if (id === EXTRA_ID_NTFS) ntfs ??= parseNtfsMtime(body);
      else if (id === EXTRA_ID_EXT_TIMESTAMP)
        ext ??= parseExtTimestampMtime(body);
      else if (id === EXTRA_ID_UNIX_OLD) unix ??= parseUnixOldMtime(body);
    });
  }
  return ntfs ?? ext ?? unix;
}

function stripZip64Extra(extra) {
  if (!extra.length) return EMPTY_BUFFER;
  const parts = [];
  let total = 0;
  forEachExtraField(extra, (id, body) => {
    if (id === ZIP64_EXTRA_ID) return;
    const record = Buffer.allocUnsafe(4 + body.length);
    record.writeUInt16LE(id, 0);
    record.writeUInt16LE(body.length, 2);
    body.copy(record, 4);
    parts.push(record);
    total += record.length;
  });
  if (parts.length === 0) return EMPTY_BUFFER;
  return Buffer.concat(parts, total);
}

function buildExtTimestampExtra(seconds) {
  const buffer = Buffer.allocUnsafe(9);
  buffer.writeUInt16LE(EXTRA_ID_EXT_TIMESTAMP, 0);
  buffer.writeUInt16LE(5, 2);
  buffer.writeUInt8(0x01, 4);
  buffer.writeInt32LE(seconds, 5);
  return buffer;
}

// ---------------------------------------------------------------------------
// Headers (lib/internal/zip/headers.js, verbatim logic).
// ---------------------------------------------------------------------------

class CentralEndHeader {
  #buffer;
  #offset;
  constructor(buffer, offset = 0) {
    validateArchiveRange(buffer, offset, 22, "end of central directory record");
    if (buffer.readUInt32LE(offset) !== SIG_EOCD) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        "end of central directory signature is invalid",
      );
    }
    this.#buffer = buffer;
    this.#offset = offset;
    if (offset + this.byteLength > buffer.length) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        "end of central directory record is truncated",
      );
    }
  }
  get byteLength() {
    return 22 + this.commentLength;
  }
  get diskNumber() {
    return this.#buffer.readUInt16LE(this.#offset + 4);
  }
  get centralDirectoryDiskNumber() {
    return this.#buffer.readUInt16LE(this.#offset + 6);
  }
  get centralDirectoryDiskRecords() {
    return this.#buffer.readUInt16LE(this.#offset + 8);
  }
  get centralDirectoryTotalRecords() {
    return this.#buffer.readUInt16LE(this.#offset + 10);
  }
  get centralDirectorySize() {
    return this.#buffer.readUInt32LE(this.#offset + 12);
  }
  get centralDirectoryOffset() {
    return this.#buffer.readUInt32LE(this.#offset + 16);
  }
  get commentLength() {
    return this.#buffer.readUInt16LE(this.#offset + 20);
  }
  get commentBuffer() {
    const start = this.#offset + 22;
    return this.#buffer.subarray(start, start + this.commentLength);
  }
}

class Zip64EndRecord {
  #buffer;
  #offset;
  constructor(buffer, offset = 0) {
    validateArchiveRange(
      buffer,
      offset,
      56,
      "Zip64 end of central directory record",
    );
    if (buffer.readUInt32LE(offset) !== SIG_ZIP64_EOCD_RECORD) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        "Zip64 end of central directory signature is invalid",
      );
    }
    this.#buffer = buffer;
    this.#offset = offset;
  }
  get diskNumber() {
    return this.#buffer.readUInt32LE(this.#offset + 16);
  }
  get centralDirectoryDiskNumber() {
    return this.#buffer.readUInt32LE(this.#offset + 20);
  }
  get centralDirectoryDiskRecords() {
    return readSafeUint64(this.#buffer, this.#offset + 24);
  }
  get centralDirectoryTotalRecords() {
    return readSafeUint64(this.#buffer, this.#offset + 32);
  }
  get centralDirectorySize() {
    return readSafeUint64(this.#buffer, this.#offset + 40);
  }
  get centralDirectoryOffset() {
    return readSafeUint64(this.#buffer, this.#offset + 48);
  }
}

class Zip64EndLocator {
  #buffer;
  #offset;
  constructor(buffer, offset = 0) {
    validateArchiveRange(
      buffer,
      offset,
      20,
      "Zip64 end of central directory locator",
    );
    if (buffer.readUInt32LE(offset) !== SIG_ZIP64_EOCD_LOCATOR) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        "Zip64 end of central directory locator signature is invalid",
      );
    }
    this.#buffer = buffer;
    this.#offset = offset;
  }
  get recordDiskNumber() {
    return this.#buffer.readUInt32LE(this.#offset + 4);
  }
  get totalDisks() {
    return this.#buffer.readUInt32LE(this.#offset + 16);
  }
}

class CentralFileHeader {
  #buffer;
  #offset;
  #zip64 = null;
  constructor(buffer, offset = 0) {
    validateArchiveRange(buffer, offset, 46, "central directory header");
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL_FILE_HEADER) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        "central directory header signature is invalid",
      );
    }
    this.#buffer = buffer;
    this.#offset = offset;
    if (offset + this.byteLength > buffer.length) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        "central directory header is truncated",
      );
    }
  }
  get byteOffset() {
    return this.#offset;
  }
  get byteLength() {
    return (
      46 + this.fileNameLength + this.extraFieldLength + this.fileCommentLength
    );
  }
  get version() {
    return this.#buffer.readUInt16LE(this.#offset + 4);
  }
  get flags() {
    return this.#buffer.readUInt16LE(this.#offset + 8);
  }
  get compressionMethod() {
    return this.#buffer.readUInt16LE(this.#offset + 10);
  }
  get lastModified() {
    return decodeDosDateTime(
      this.#buffer.readUInt16LE(this.#offset + 12),
      this.#buffer.readUInt16LE(this.#offset + 14),
    );
  }
  get crc32() {
    return this.#buffer.readUInt32LE(this.#offset + 16);
  }
  #resolveZip64() {
    if (this.#zip64 === null) {
      this.#zip64 = parseZip64Extra(this.extraField, {
        uncompressedSize:
          this.#buffer.readUInt32LE(this.#offset + 24) === SENTINEL32,
        compressedSize:
          this.#buffer.readUInt32LE(this.#offset + 20) === SENTINEL32,
        localFileHeaderOffset:
          this.#buffer.readUInt32LE(this.#offset + 42) === SENTINEL32,
        diskNumber:
          this.#buffer.readUInt16LE(this.#offset + 34) === SENTINEL16,
      });
    }
    return this.#zip64;
  }
  get compressedSize() {
    const value = this.#buffer.readUInt32LE(this.#offset + 20);
    return value === SENTINEL32 ? this.#resolveZip64().compressedSize : value;
  }
  get uncompressedSize() {
    const value = this.#buffer.readUInt32LE(this.#offset + 24);
    return value === SENTINEL32
      ? this.#resolveZip64().uncompressedSize
      : value;
  }
  get fileNameLength() {
    return this.#buffer.readUInt16LE(this.#offset + 28);
  }
  get extraFieldLength() {
    return this.#buffer.readUInt16LE(this.#offset + 30);
  }
  get fileCommentLength() {
    return this.#buffer.readUInt16LE(this.#offset + 32);
  }
  get diskNumber() {
    const value = this.#buffer.readUInt16LE(this.#offset + 34);
    return value === SENTINEL16 ? this.#resolveZip64().diskNumber : value;
  }
  get internalFileAttributes() {
    return this.#buffer.readUInt16LE(this.#offset + 36);
  }
  get externalFileAttributes() {
    return this.#buffer.readUInt32LE(this.#offset + 38);
  }
  get localFileHeaderOffset() {
    const value = this.#buffer.readUInt32LE(this.#offset + 42);
    return value === SENTINEL32
      ? this.#resolveZip64().localFileHeaderOffset
      : value;
  }
  get fileNameBuffer() {
    const start = this.#offset + 46;
    return this.#buffer.subarray(start, start + this.fileNameLength);
  }
  get fileName() {
    return decodeZipName(this.fileNameBuffer, this.flags, this.extraField);
  }
  get extraField() {
    const start = this.#offset + 46 + this.fileNameLength;
    return this.#buffer.subarray(start, start + this.extraFieldLength);
  }
  get fileCommentBuffer() {
    const start =
      this.#offset + 46 + this.fileNameLength + this.extraFieldLength;
    return this.#buffer.subarray(start, start + this.fileCommentLength);
  }
  get fileComment() {
    return decodeZipText(this.fileCommentBuffer, this.flags);
  }
  get isUnixMode() {
    return (this.version >>> 8) === MADE_BY_UNIX;
  }
  get mode() {
    return this.isUnixMode
      ? (this.externalFileAttributes >>> 16) & 0o7777
      : 0;
  }
  get isSymlink() {
    return (
      this.isUnixMode &&
      ((this.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK
    );
  }
}

class LocalFileHeader {
  #buffer;
  #offset;
  #zip64 = null;
  constructor(buffer, offset = 0) {
    validateArchiveRange(buffer, offset, 30, "local file header");
    if (buffer.readUInt32LE(offset) !== SIG_LOCAL_FILE_HEADER) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        "local file header signature is invalid",
      );
    }
    this.#buffer = buffer;
    this.#offset = offset;
    if (offset + this.byteLength > buffer.length) {
      throw new ERR_ZIP_INVALID_ARCHIVE("local file header is truncated");
    }
  }
  get byteLength() {
    return 30 + this.fileNameLength + this.extraFieldLength;
  }
  get flags() {
    return this.#buffer.readUInt16LE(this.#offset + 6);
  }
  get compressionMethod() {
    return this.#buffer.readUInt16LE(this.#offset + 8);
  }
  get crc32() {
    return this.#buffer.readUInt32LE(this.#offset + 14);
  }
  #resolveZip64() {
    if (this.#zip64 === null) {
      this.#zip64 = parseZip64Extra(this.extraField, {
        uncompressedSize:
          this.#buffer.readUInt32LE(this.#offset + 22) === SENTINEL32,
        compressedSize:
          this.#buffer.readUInt32LE(this.#offset + 18) === SENTINEL32,
        localFileHeaderOffset: false,
        diskNumber: false,
      });
    }
    return this.#zip64;
  }
  get compressedSize() {
    const value = this.#buffer.readUInt32LE(this.#offset + 18);
    return value === SENTINEL32 ? this.#resolveZip64().compressedSize : value;
  }
  get uncompressedSize() {
    const value = this.#buffer.readUInt32LE(this.#offset + 22);
    return value === SENTINEL32
      ? this.#resolveZip64().uncompressedSize
      : value;
  }
  get fileNameLength() {
    return this.#buffer.readUInt16LE(this.#offset + 26);
  }
  get extraFieldLength() {
    return this.#buffer.readUInt16LE(this.#offset + 28);
  }
  get extraField() {
    const start = this.#offset + 30 + this.fileNameLength;
    return this.#buffer.subarray(start, start + this.extraFieldLength);
  }
  static length(buffer, offset) {
    if (offset + 30 > buffer.length) return 0;
    return (
      30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28)
    );
  }
}

function assertConsistentLocalHeader(local, central) {
  if (local.compressionMethod !== central.compressionMethod) {
    throw new ERR_ZIP_INVALID_ARCHIVE(
      "local and central compression methods disagree",
    );
  }
  if ((local.flags & FLAG_ENCRYPTED) !== (central.flags & FLAG_ENCRYPTED)) {
    throw new ERR_ZIP_INVALID_ARCHIVE(
      "local and central encryption flags disagree",
    );
  }
  const deferred =
    (local.flags & FLAG_DATA_DESCRIPTOR) !== 0 &&
    local.crc32 === 0 &&
    local.compressedSize === 0 &&
    local.uncompressedSize === 0;
  if (
    !deferred &&
    (local.crc32 !== central.crc32 ||
      local.compressedSize !== central.compressedSize ||
      local.uncompressedSize !== central.uncompressedSize)
  ) {
    throw new ERR_ZIP_INVALID_ARCHIVE(
      "local and central header crc-32 or sizes disagree",
    );
  }
}

function isPlausibleArchiveEnd(buffer, eocdPos, scanStart) {
  const diskNumber = buffer.readUInt16LE(eocdPos + 4);
  const centralDirectoryDiskNumber = buffer.readUInt16LE(eocdPos + 6);
  const diskRecords = buffer.readUInt16LE(eocdPos + 8);
  const totalRecords = buffer.readUInt16LE(eocdPos + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdPos + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdPos + 16);
  const needsZip64 =
    diskNumber === SENTINEL16 ||
    centralDirectoryDiskNumber === SENTINEL16 ||
    diskRecords === SENTINEL16 ||
    totalRecords === SENTINEL16 ||
    centralDirectorySize === SENTINEL32 ||
    centralDirectoryOffset === SENTINEL32;

  const locatorPos = eocdPos - 20;
  const hasZip64Locator =
    locatorPos >= 0 &&
    buffer.readUInt32LE(locatorPos) === SIG_ZIP64_EOCD_LOCATOR;
  if (needsZip64) return hasZip64Locator;
  if (hasZip64Locator) return true;
  if (
    diskNumber !== 0 ||
    centralDirectoryDiskNumber !== 0 ||
    diskRecords !== totalRecords ||
    totalRecords * 46 > centralDirectorySize
  ) {
    return false;
  }

  const centralDirectoryPos = eocdPos - centralDirectorySize;
  if (centralDirectoryPos < scanStart) {
    return true;
  }
  if (totalRecords === 0) return centralDirectorySize === 0;
  return buffer.readUInt32LE(centralDirectoryPos) === SIG_CENTRAL_FILE_HEADER;
}

function findArchiveEnd(buffer, base = 0) {
  if (buffer.length < 22) {
    throw new ERR_ZIP_INVALID_ARCHIVE(
      "no end of central directory record found",
    );
  }
  const min = Math.max(0, buffer.length - TAIL_LENGTH);
  let eocdPos = -1;
  let fallbackPos = -1;
  let exactFallbackPos = -1;
  for (let pos = buffer.length - 22; pos >= min; pos--) {
    if (buffer.readUInt32LE(pos) !== SIG_EOCD) continue;
    const end = pos + 22 + buffer.readUInt16LE(pos + 20);
    if (end > buffer.length) continue;
    if (fallbackPos < 0) fallbackPos = pos;
    if (end === buffer.length && exactFallbackPos < 0) exactFallbackPos = pos;
    if (!isPlausibleArchiveEnd(buffer, pos, min)) continue;
    if (eocdPos >= 0) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        "ambiguous end of central directory records",
      );
    }
    eocdPos = pos;
  }
  if (eocdPos < 0) {
    eocdPos = exactFallbackPos >= 0 ? exactFallbackPos : fallbackPos;
  }
  if (eocdPos < 0) {
    throw new ERR_ZIP_INVALID_ARCHIVE(
      "no end of central directory record found",
    );
  }
  const eocd = new CentralEndHeader(buffer, eocdPos);
  let totalRecords = eocd.centralDirectoryTotalRecords;
  let centralDirectorySize = eocd.centralDirectorySize;
  let centralDirectoryOffset = eocd.centralDirectoryOffset;
  let prefix;
  const needsZip64 =
    eocd.diskNumber === SENTINEL16 ||
    eocd.centralDirectoryDiskNumber === SENTINEL16 ||
    eocd.centralDirectoryDiskRecords === SENTINEL16 ||
    totalRecords === SENTINEL16 ||
    centralDirectorySize === SENTINEL32 ||
    centralDirectoryOffset === SENTINEL32;
  let zip64 = null;
  let recordPos = -1;
  const locatorPos = eocdPos - 20;
  if (
    locatorPos >= 0 &&
    buffer.readUInt32LE(locatorPos) === SIG_ZIP64_EOCD_LOCATOR
  ) {
    const locator = new Zip64EndLocator(buffer, locatorPos);
    const rawRecordOffset = buffer.readBigUInt64LE(locatorPos + 8);
    const recordOffset =
      rawRecordOffset <= BIGINT_MAX_SAFE_INTEGER
        ? Number(rawRecordOffset)
        : -1;
    recordPos = recordOffset >= 0 ? recordOffset - base : -1;
    if (
      !(
        recordPos >= 0 &&
        recordPos + 56 <= locatorPos &&
        buffer.readUInt32LE(recordPos) === SIG_ZIP64_EOCD_RECORD
      )
    ) {
      recordPos = -1;
      const floor = Math.max(0, locatorPos - 56 - SENTINEL16);
      for (let pos = locatorPos - 56; pos >= floor; pos--) {
        if (buffer.readUInt32LE(pos) !== SIG_ZIP64_EOCD_RECORD) continue;
        const size = buffer.readBigUInt64LE(pos + 4);
        if (size >= 44n && pos + 12 + Number(size) === locatorPos) {
          recordPos = pos;
          break;
        }
      }
    }
    if (recordPos < 0 && needsZip64) {
      if (
        recordOffset >= 0 &&
        recordOffset < base &&
        base + locatorPos - recordOffset <= ZIP64_EOCD_MAX_LENGTH
      ) {
        return { needTailFrom: recordOffset };
      }
      throw new ERR_ZIP_INVALID_ARCHIVE(
        "Zip64 end of central directory record not found",
      );
    }
    if (recordPos >= 0) {
      if (locator.totalDisks > 1 || locator.recordDiskNumber !== 0) {
        throw new ERR_ZIP_UNSUPPORTED_FEATURE(
          "multi-disk archives are not supported",
        );
      }
      zip64 = new Zip64EndRecord(buffer, recordPos);
    }
  }
  if (zip64 !== null) {
    if (zip64.diskNumber !== 0 || zip64.centralDirectoryDiskNumber !== 0) {
      throw new ERR_ZIP_UNSUPPORTED_FEATURE(
        "multi-disk archives are not supported",
      );
    }
    if (
      zip64.centralDirectoryDiskRecords !== zip64.centralDirectoryTotalRecords
    ) {
      throw new ERR_ZIP_UNSUPPORTED_FEATURE(
        "multi-disk archives are not supported",
      );
    }
    if (
      (totalRecords !== SENTINEL16 &&
        totalRecords !== zip64.centralDirectoryTotalRecords) ||
      (centralDirectorySize !== SENTINEL32 &&
        centralDirectorySize !== zip64.centralDirectorySize) ||
      (centralDirectoryOffset !== SENTINEL32 &&
        centralDirectoryOffset !== zip64.centralDirectoryOffset)
    ) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        "Zip64 and classic end-of-central-directory records disagree",
      );
    }
    totalRecords = zip64.centralDirectoryTotalRecords;
    centralDirectorySize = zip64.centralDirectorySize;
    centralDirectoryOffset = zip64.centralDirectoryOffset;
    prefix =
      base + recordPos - (centralDirectoryOffset + centralDirectorySize);
  } else {
    if (eocd.diskNumber !== 0 || eocd.centralDirectoryDiskNumber !== 0) {
      throw new ERR_ZIP_UNSUPPORTED_FEATURE(
        "multi-disk archives are not supported",
      );
    }
    if (eocd.centralDirectoryDiskRecords !== totalRecords) {
      throw new ERR_ZIP_UNSUPPORTED_FEATURE(
        "multi-disk archives are not supported",
      );
    }
    prefix = base + eocdPos - (centralDirectoryOffset + centralDirectorySize);
  }
  if (prefix < 0) {
    throw new ERR_ZIP_INVALID_ARCHIVE(
      "central directory does not fit inside the archive",
    );
  }
  if (
    (totalRecords === 0 && centralDirectorySize !== 0) ||
    totalRecords * 46 > centralDirectorySize
  ) {
    throw new ERR_ZIP_INVALID_ARCHIVE(
      "central directory record count is inconsistent with its size",
    );
  }
  return {
    prefix,
    totalRecords,
    centralDirectoryOffset: centralDirectoryOffset + prefix,
    centralDirectorySize,
    comment: eocd.commentBuffer,
  };
}

function readCentralDirectory(buffer, count) {
  const result = [];
  let pos = 0;
  for (let index = 0; index < count; index++) {
    const header = new CentralFileHeader(buffer, pos);
    if (header.diskNumber !== 0) {
      throw new ERR_ZIP_UNSUPPORTED_FEATURE(
        "multi-disk archives are not supported",
      );
    }
    result.push(header);
    pos += header.byteLength;
  }
  if (pos !== buffer.length) {
    throw new ERR_ZIP_INVALID_ARCHIVE(
      "central directory record count is inconsistent with its size",
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Header builders (lib/internal/zip/header-builders.js, verbatim logic).
// ---------------------------------------------------------------------------

function versionNeeded(meta, zip64) {
  return Math.max(
    zip64 ? VERSION_ZIP64 : VERSION_DEFAULT,
    meta.method === METHOD_ZSTD ? VERSION_ZSTD : 0,
  );
}

function checkExtraLength(extraLength) {
  if (extraLength > SENTINEL16) {
    throw new ERR_ZIP_ENTRY_TOO_LARGE(
      "the entry extra fields must not exceed 65535 bytes",
    );
  }
}

function buildLocalHeader(meta) {
  const streaming = (meta.flags & FLAG_DATA_DESCRIPTOR) !== 0;
  const zip64 =
    streaming ||
    meta.compressedSize >= SENTINEL32 ||
    meta.uncompressedSize >= SENTINEL32;
  const ts =
    meta.extendedMtime !== null
      ? buildExtTimestampExtra(meta.extendedMtime)
      : EMPTY_BUFFER;
  const extraLength = (zip64 ? 20 : 0) + ts.length + meta.extra.length;
  checkExtraLength(extraLength);
  const buffer = Buffer.allocUnsafe(30 + meta.name.length + extraLength);
  buffer.writeUInt32LE(SIG_LOCAL_FILE_HEADER, 0);
  buffer.writeUInt16LE(versionNeeded(meta, zip64), 4);
  buffer.writeUInt16LE(meta.flags, 6);
  buffer.writeUInt16LE(meta.method, 8);
  const { time, date } = encodeDosDateTime(meta.modified);
  buffer.writeUInt16LE(time, 10);
  buffer.writeUInt16LE(date, 12);
  buffer.writeUInt32LE(streaming ? 0 : meta.crc, 14);
  buffer.writeUInt32LE(zip64 ? SENTINEL32 : meta.compressedSize, 18);
  buffer.writeUInt32LE(zip64 ? SENTINEL32 : meta.uncompressedSize, 22);
  buffer.writeUInt16LE(meta.name.length, 26);
  buffer.writeUInt16LE(extraLength, 28);
  meta.name.copy(buffer, 30);
  let pos = 30 + meta.name.length;
  if (zip64) {
    buffer.writeUInt16LE(ZIP64_EXTRA_ID, pos);
    buffer.writeUInt16LE(16, pos + 2);
    writeSafeUint64(buffer, pos + 4, streaming ? 0 : meta.uncompressedSize);
    writeSafeUint64(buffer, pos + 12, streaming ? 0 : meta.compressedSize);
    pos += 20;
  }
  ts.copy(buffer, pos);
  pos += ts.length;
  meta.extra.copy(buffer, pos);
  return buffer;
}

function buildCentralHeader(meta, localOffset) {
  const zip64Streaming = (meta.flags & FLAG_DATA_DESCRIPTOR) !== 0;
  const u64 = meta.uncompressedSize >= SENTINEL32;
  const c64 = meta.compressedSize >= SENTINEL32;
  const o64 = localOffset >= SENTINEL32;
  const zip64Fields = (u64 ? 1 : 0) + (c64 ? 1 : 0) + (o64 ? 1 : 0);
  const ts =
    meta.extendedMtime !== null
      ? buildExtTimestampExtra(meta.extendedMtime)
      : EMPTY_BUFFER;
  const extraLength =
    (zip64Fields ? 4 + 8 * zip64Fields : 0) + ts.length + meta.extra.length;
  checkExtraLength(extraLength);
  const zip64 = zip64Streaming || zip64Fields > 0;
  const version = versionNeeded(meta, zip64);
  const buffer = Buffer.allocUnsafe(
    46 + meta.name.length + extraLength + meta.comment.length,
  );
  buffer.writeUInt32LE(SIG_CENTRAL_FILE_HEADER, 0);
  buffer.writeUInt16LE((meta.madeBy << 8) | version, 4);
  buffer.writeUInt16LE(version, 6);
  buffer.writeUInt16LE(meta.flags, 8);
  buffer.writeUInt16LE(meta.method, 10);
  const { time, date } = encodeDosDateTime(meta.modified);
  buffer.writeUInt16LE(time, 12);
  buffer.writeUInt16LE(date, 14);
  buffer.writeUInt32LE(meta.crc, 16);
  buffer.writeUInt32LE(c64 ? SENTINEL32 : meta.compressedSize, 20);
  buffer.writeUInt32LE(u64 ? SENTINEL32 : meta.uncompressedSize, 24);
  buffer.writeUInt16LE(meta.name.length, 28);
  buffer.writeUInt16LE(extraLength, 30);
  buffer.writeUInt16LE(meta.comment.length, 32);
  buffer.writeUInt16LE(0, 34);
  buffer.writeUInt16LE(meta.internal, 36);
  buffer.writeUInt32LE(meta.external, 38);
  buffer.writeUInt32LE(o64 ? SENTINEL32 : localOffset, 42);
  meta.name.copy(buffer, 46);
  let pos = 46 + meta.name.length;
  if (zip64Fields) {
    buffer.writeUInt16LE(ZIP64_EXTRA_ID, pos);
    buffer.writeUInt16LE(8 * zip64Fields, pos + 2);
    pos += 4;
    if (u64) {
      writeSafeUint64(buffer, pos, meta.uncompressedSize);
      pos += 8;
    }
    if (c64) {
      writeSafeUint64(buffer, pos, meta.compressedSize);
      pos += 8;
    }
    if (o64) {
      writeSafeUint64(buffer, pos, localOffset);
      pos += 8;
    }
  }
  ts.copy(buffer, pos);
  pos += ts.length;
  meta.extra.copy(buffer, pos);
  pos += meta.extra.length;
  meta.comment.copy(buffer, pos);
  return buffer;
}

function buildDataDescriptor64(crc, compressedSize, uncompressedSize) {
  const buffer = Buffer.allocUnsafe(24);
  buffer.writeUInt32LE(SIG_DATA_DESCRIPTOR, 0);
  buffer.writeUInt32LE(crc, 4);
  writeSafeUint64(buffer, 8, compressedSize);
  writeSafeUint64(buffer, 16, uncompressedSize);
  return buffer;
}

function buildEndOfCentralDirectory(count, size, offset, comment) {
  const buffer = Buffer.allocUnsafe(22 + comment.length);
  buffer.writeUInt32LE(SIG_EOCD, 0);
  buffer.writeUInt16LE(0, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt16LE(Math.min(count, SENTINEL16), 8);
  buffer.writeUInt16LE(Math.min(count, SENTINEL16), 10);
  buffer.writeUInt32LE(Math.min(size, SENTINEL32), 12);
  buffer.writeUInt32LE(Math.min(offset, SENTINEL32), 16);
  buffer.writeUInt16LE(comment.length, 20);
  comment.copy(buffer, 22);
  return buffer;
}

function buildZip64EndRecord(count, size, offset) {
  const buffer = Buffer.allocUnsafe(56);
  buffer.writeUInt32LE(SIG_ZIP64_EOCD_RECORD, 0);
  writeSafeUint64(buffer, 4, 44);
  buffer.writeUInt16LE((MADE_BY_UNIX << 8) | VERSION_ZIP64, 12);
  buffer.writeUInt16LE(VERSION_ZIP64, 14);
  buffer.writeUInt32LE(0, 16);
  buffer.writeUInt32LE(0, 20);
  writeSafeUint64(buffer, 24, count);
  writeSafeUint64(buffer, 32, count);
  writeSafeUint64(buffer, 40, size);
  writeSafeUint64(buffer, 48, offset);
  return buffer;
}

function buildZip64EndLocator(recordOffset) {
  const buffer = Buffer.allocUnsafe(20);
  buffer.writeUInt32LE(SIG_ZIP64_EOCD_LOCATOR, 0);
  buffer.writeUInt32LE(0, 4);
  writeSafeUint64(buffer, 8, recordOffset);
  buffer.writeUInt32LE(1, 16);
  return buffer;
}

function buildArchiveTrailer(
  count,
  centralDirectorySize,
  centralDirectoryOffset,
  comment,
) {
  const chunks = [];
  const zip64 =
    count >= SENTINEL16 ||
    centralDirectoryOffset >= SENTINEL32 ||
    centralDirectorySize >= SENTINEL32;
  if (zip64) {
    const recordOffset = centralDirectoryOffset + centralDirectorySize;
    chunks.push(
      buildZip64EndRecord(count, centralDirectorySize, centralDirectoryOffset),
    );
    chunks.push(buildZip64EndLocator(recordOffset));
  }
  chunks.push(
    buildEndOfCentralDirectory(
      count,
      centralDirectorySize,
      centralDirectoryOffset,
      comment,
    ),
  );
  return chunks;
}

// ---------------------------------------------------------------------------
// Compression (lib/internal/zip/compression.js, adapted).
// One-shot paths are thin promisified adapters over the shim's zlib.js
// convenience functions (same signatures Node's lazy `require('zlib')`
// facade exposes). Streaming paths are pako push-mode adapters — the shim
// has no streaming deflate Transform wired for this — except zstd, which
// accumulates and one-shot decompresses/compresses via zstdify (no
// streaming zstd encoder exists in the shim); observable semantics (chunks,
// CRC, declared-size caps, errors) are preserved, only memory/timing differ.
// ---------------------------------------------------------------------------

function deflateRawAsync(buffer) {
  return new Promise((resolve, reject) => {
    deflateRaw(buffer, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function inflateRawAsync(buffer, options) {
  return new Promise((resolve, reject) => {
    inflateRaw(buffer, options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function zstdCompressAsync(buffer) {
  return new Promise((resolve, reject) => {
    zstdCompress(buffer, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function zstdDecompressAsync(buffer, options) {
  return new Promise((resolve, reject) => {
    zstdDecompress(buffer, options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// Drive `source` (async iterable of Buffers) through a pako push-mode
// deflater, yielding output chunks as they are produced. pako reuses its
// output buffer across pushes, so every onData chunk is copied into a fresh
// Buffer (same as the shim's PakoInflateEngine._drain discipline).
async function* deflateRawStream(source) {
  const def = new PakoDeflate({ raw: true });
  const collected = [];
  def.onData = (chunk) => {
    collected.push(Buffer.from(chunk));
  };
  const drain = function* () {
    while (collected.length) yield collected.shift();
  };
  for await (const chunk of source) {
    if (!def.push(chunk, false)) {
      throw new Error(`deflate failed: ${def.msg || "unknown error"}`);
    }
    yield* drain();
  }
  if (!def.push(new Uint8Array(0), true)) {
    throw new Error(`deflate failed: ${def.msg || "unknown error"}`);
  }
  yield* drain();
}

// Streaming raw inflate over pako. A pako error (corrupt/truncated stream)
// surfaces here as a plain Error and propagates raw through
// decodeMemberStream(), exactly like Node's pipeline error.
async function* inflateRawStream(source) {
  const inf = new PakoInflate({ raw: true });
  const collected = [];
  inf.onData = (chunk) => {
    collected.push(Buffer.from(chunk));
  };
  const drain = function* () {
    while (collected.length) yield collected.shift();
  };
  for await (const chunk of source) {
    if (!inf.push(chunk, false)) {
      throw new Error(`inflate failed: ${inf.msg || "unknown error"}`);
    }
    yield* drain();
  }
  if (!inf.push(new Uint8Array(0), true)) {
    throw new Error(`inflate failed: ${inf.msg || "unknown error"}`);
  }
  yield* drain();
}

// Streaming zstd compress: accumulate, then one-shot zstdify compress.
// (See the header comment: zstdify has no streaming encoder.)
async function* zstdCompressStream(source) {
  const parts = [];
  for await (const chunk of source) parts.push(chunk);
  yield zstdCompressSync(Buffer.concat(parts));
}

// Streaming zstd decompress: accumulate, then one-shot zstdify decompress
// capped at `declaredSize + 1` (the streaming path has no caller maxSize;
// assertDecodable already rejected declared > maxSize). An overrun throws
// ERR_ZIP_ENTRY_CORRUPT with the same "inflates beyond its declared size"
// wording Node's streaming decoder uses, and any other failure is left as
// an Error for decodeMemberStream() to wrap with the entry name.
async function* zstdDecompressStream(source, declaredSize) {
  const parts = [];
  for await (const chunk of source) parts.push(chunk);
  let data;
  try {
    data = zstdDecompressSync(Buffer.concat(parts), {
      maxOutputLength: declaredSize + 1,
    });
  } catch (err) {
    if (err?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new ERR_ZIP_ENTRY_CORRUPT(
        `inflates beyond its declared size of ${declaredSize} bytes`,
      );
    }
    throw err;
  }
  const SLICE = 64 * 1024;
  for (let pos = 0; pos < data.length; pos += SLICE) {
    yield data.subarray(pos, Math.min(pos + SLICE, data.length));
  }
}

function assertDecodable(info, options) {
  if (info.flags & FLAG_ENCRYPTED) {
    throw new ERR_ZIP_UNSUPPORTED_FEATURE(
      `entry ${JSON.stringify(info.name)} is encrypted`,
    );
  }
  if (
    info.method !== METHOD_STORE &&
    info.method !== METHOD_DEFLATE &&
    info.method !== METHOD_ZSTD
  ) {
    throw new ERR_ZIP_UNSUPPORTED_FEATURE(
      `entry ${JSON.stringify(info.name)} uses compression method ${info.method}`,
    );
  }
  if (
    options?.maxSize !== undefined &&
    info.uncompressedSize > options.maxSize
  ) {
    throw new ERR_ZIP_ENTRY_TOO_LARGE(
      `entry ${JSON.stringify(info.name)} declares ${info.uncompressedSize} bytes, ` +
        `exceeding the ${options.maxSize} byte limit`,
    );
  }
}

function outputCap(info, options) {
  return Math.min(
    info.uncompressedSize + 1,
    options?.maxSize ?? kMaxLength,
    kMaxLength,
  );
}

function rethrowDecodeFailure(err, info, method) {
  if (err?.code === "ERR_BUFFER_TOO_LARGE") {
    throw new ERR_ZIP_ENTRY_CORRUPT(
      `entry ${JSON.stringify(info.name)} ` +
        `${method === METHOD_DEFLATE ? "inflates" : "decompresses"} beyond its ` +
        `declared size of ${info.uncompressedSize} bytes`,
    );
  }
  throw new ERR_ZIP_ENTRY_CORRUPT(
    `entry ${JSON.stringify(info.name)} failed to ` +
      `${method === METHOD_DEFLATE ? "inflate" : "decompress"}: ${err.message}`,
  );
}

function checkDecoded(data, info, verify) {
  if (data.length !== info.uncompressedSize) {
    throw new ERR_ZIP_ENTRY_CORRUPT(
      `entry ${JSON.stringify(info.name)} produced ${data.length} bytes, expected ` +
        `${info.uncompressedSize}`,
    );
  }
  if (verify && crc32(data, 0) !== info.crc32) {
    throw new ERR_ZIP_ENTRY_CORRUPT(
      `entry ${JSON.stringify(info.name)} failed CRC-32 verification`,
    );
  }
}

async function* decodeMemberStream(source, info, options) {
  assertDecodable(info, options);
  const verify = options?.verify !== false;
  let produced = 0;
  let state = 0;
  const decoded =
    info.method === METHOD_DEFLATE
      ? inflateRawStream(source)
      : info.method === METHOD_ZSTD
        ? zstdDecompressStream(source, info.uncompressedSize)
        : source;
  // ponytail: no try/catch here — Node's decodeMemberStream() has none
  // either: a source error (e.g. #rawChunks' ERR_INVALID_STATE when the
  // backing ZipFile closes mid-iteration) and a decode error both propagate
  // raw. Wrapping them would turn the close()-while-paused ERR_INVALID_STATE
  // into ERR_ZIP_ENTRY_CORRUPT. Only the overrun mapping inside
  // zstdDecompressStream() produces ERR_ZIP_ENTRY_CORRUPT itself.
  for await (const chunk of decoded) {
    produced += chunk.length;
    if (produced > info.uncompressedSize) {
      throw new ERR_ZIP_ENTRY_CORRUPT(
        `entry ${JSON.stringify(info.name)} inflates beyond its declared size of ` +
          `${info.uncompressedSize} bytes`,
      );
    }
    if (verify) state = crc32(chunk, state);
    yield chunk;
  }
  if (produced !== info.uncompressedSize) {
    throw new ERR_ZIP_ENTRY_CORRUPT(
      `entry ${JSON.stringify(info.name)} is truncated: got ${produced} of ` +
        `${info.uncompressedSize} bytes`,
    );
  }
  if (verify && state !== info.crc32) {
    throw new ERR_ZIP_ENTRY_CORRUPT(
      `entry ${JSON.stringify(info.name)} failed CRC-32 verification`,
    );
  }
}

async function decodeMemberAsync(compressed, info, options) {
  assertDecodable(info, options);
  const cap = outputCap(info, options);
  let data;
  if (info.method === METHOD_DEFLATE) {
    try {
      data = await inflateRawAsync(compressed, { maxOutputLength: cap });
    } catch (err) {
      rethrowDecodeFailure(err, info, METHOD_DEFLATE);
    }
  } else if (info.method === METHOD_ZSTD) {
    try {
      data = await zstdDecompressAsync(compressed, { maxOutputLength: cap });
    } catch (err) {
      rethrowDecodeFailure(err, info, METHOD_ZSTD);
    }
  } else {
    data = compressed;
  }
  checkDecoded(data, info, options?.verify !== false);
  return data;
}

function decodeMemberSync(compressed, info, options) {
  assertDecodable(info, options);
  const cap = outputCap(info, options);
  let data;
  if (info.method === METHOD_DEFLATE) {
    try {
      data = inflateRawSync(compressed, { maxOutputLength: cap });
    } catch (err) {
      rethrowDecodeFailure(err, info, METHOD_DEFLATE);
    }
  } else if (info.method === METHOD_ZSTD) {
    try {
      data = zstdDecompressSync(compressed, { maxOutputLength: cap });
    } catch (err) {
      rethrowDecodeFailure(err, info, METHOD_ZSTD);
    }
  } else {
    data = compressed;
  }
  checkDecoded(data, info, options?.verify !== false);
  return data;
}

// ---------------------------------------------------------------------------
// fs utilities (lib/internal/zip/fs-util.js, verbatim logic).
// `fs` is the `node:fs` default import: under the parity harness it is the
// real module (so ZipFile sees the same files the tests write, and a test's
// monkey-patch of `fs.writeSync` is visible because every call looks the
// method up on the shared module object at call time); in the browser build
// it resolves to the memfs-backed shim fs. Never destructure these methods
// at import time.
// ---------------------------------------------------------------------------

function fsOpenAsync(path, flag) {
  return new Promise((resolve, reject) => {
    fs.open(path, flag, (err, fd) => (err ? reject(err) : resolve(fd)));
  });
}

function fsStatAsync(path) {
  return new Promise((resolve, reject) => {
    fs.stat(path, (err, stats) => (err ? reject(err) : resolve(stats)));
  });
}

function fsLstatAsync(path) {
  return new Promise((resolve, reject) => {
    fs.lstat(path, (err, stats) => (err ? reject(err) : resolve(stats)));
  });
}

function fsReadlinkAsync(path) {
  return new Promise((resolve, reject) => {
    fs.readlink(path, "utf8", (err, target) =>
      err ? reject(err) : resolve(target),
    );
  });
}

function fsCloseAsync(fd) {
  return new Promise((resolve, reject) => {
    fs.close(fd, (err) => (err ? reject(err) : resolve()));
  });
}

function fsFstatAsync(fd) {
  return new Promise((resolve, reject) => {
    fs.fstat(fd, (err, stats) => (err ? reject(err) : resolve(stats)));
  });
}

function fsReadAsync(fd, buffer, offset, length, position) {
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, offset, length, position, (err, bytesRead) =>
      err ? reject(err) : resolve(bytesRead),
    );
  });
}

function fsWriteAsync(fd, buffer, offset, length, position) {
  return new Promise((resolve, reject) => {
    fs.write(fd, buffer, offset, length, position, (err, bytesWritten) =>
      err ? reject(err) : resolve(bytesWritten),
    );
  });
}

function fsFtruncateAsync(fd, len) {
  return new Promise((resolve, reject) => {
    fs.ftruncate(fd, len, (err) => (err ? reject(err) : resolve()));
  });
}

async function readFdFully(fd, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const bytesRead = await fsReadAsync(
      fd,
      buffer,
      done,
      buffer.length - done,
      position + done,
    );
    if (bytesRead <= 0) {
      throw new ERR_ZIP_INVALID_ARCHIVE("unexpected end of file");
    }
    done += bytesRead;
  }
}

function readFdFullySync(fd, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const bytesRead = fs.readSync(
      fd,
      buffer,
      done,
      buffer.length - done,
      position + done,
    );
    if (bytesRead <= 0) {
      throw new ERR_ZIP_INVALID_ARCHIVE("unexpected end of file");
    }
    done += bytesRead;
  }
}

async function writeFdFully(fd, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const bytesWritten = await fsWriteAsync(
      fd,
      buffer,
      done,
      buffer.length - done,
      position + done,
    );
    if (bytesWritten <= 0) {
      throw new ERR_INVALID_STATE("a write to the archive made no progress");
    }
    done += bytesWritten;
  }
}

function writeFdFullySync(fd, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const bytesWritten = fs.writeSync(
      fd,
      buffer,
      done,
      buffer.length - done,
      position + done,
    );
    if (bytesWritten <= 0) {
      throw new ERR_INVALID_STATE("a write to the archive made no progress");
    }
    done += bytesWritten;
  }
}

// ---------------------------------------------------------------------------
// ZipEntry (lib/internal/zip/entry.js, verbatim logic).
// ---------------------------------------------------------------------------

function extendedMtimeSeconds(mtimeMs) {
  const seconds = Math.floor(mtimeMs / 1000);
  return mtimeMs % 2000 !== 0 &&
    seconds >= -2147483648 &&
    seconds <= 2147483647
    ? seconds
    : null;
}

function createEntryMeta(filename, options) {
  validateString(filename, "filename");
  const name = Buffer.from(filename, "utf8");
  if (name.length === 0) {
    throw new ERR_INVALID_ARG_VALUE("filename", filename, "must not be empty");
  }
  if (name.length > SENTINEL16) {
    throw new ERR_ZIP_ENTRY_TOO_LARGE(
      "the entry name must not exceed 65535 bytes when encoded as UTF-8",
    );
  }
  let comment = EMPTY_BUFFER;
  if (options?.comment !== undefined) {
    validateString(options.comment, "options.comment");
    comment = Buffer.from(options.comment, "utf8");
    if (comment.length > SENTINEL16) {
      throw new ERR_ZIP_ENTRY_TOO_LARGE(
        "the entry comment must not exceed 65535 bytes when encoded as UTF-8",
      );
    }
  }
  const isSymlink = options?.symlink === true;
  const isDirectory = !isSymlink && filename.endsWith("/");
  const mode =
    options?.mode ?? (isSymlink ? 0o777 : isDirectory ? 0o755 : 0o644);
  validateUint32(mode, "options.mode");
  const modified =
    options?.modified ?? new Date(Math.floor(Date.now() / 2000) * 2000);
  if (!isDate(modified)) {
    throw new ERR_INVALID_ARG_TYPE("options.modified", "Date", modified);
  }
  if (
    options?.method !== undefined &&
    options.method !== "deflate" &&
    options.method !== "store" &&
    options.method !== "zstd"
  ) {
    throw new ERR_INVALID_ARG_VALUE(
      "options.method",
      options.method,
      "must be 'deflate', 'store', or 'zstd'",
    );
  }
  const typeBits = isSymlink ? S_IFLNK : isDirectory ? S_IFDIR : S_IFREG;
  const unixAttrs = (typeBits | (mode & 0o7777)) & SENTINEL16;
  const external = ((unixAttrs << 16) | (isDirectory ? 0x10 : 0)) >>> 0;
  const extendedMtime = extendedMtimeSeconds(modified.getTime());
  return {
    name,
    comment,
    extra: EMPTY_BUFFER,
    flags: FLAG_UTF8,
    method: 0,
    crc: 0,
    compressedSize: 0,
    uncompressedSize: 0,
    modified,
    extendedMtime,
    external,
    internal: 0,
    madeBy: MADE_BY_UNIX,
    pending: true,
  };
}

function endHandleRead(handle) {
  if (--handle.reads === 0 && handle.drain !== null) {
    const drain = handle.drain;
    handle.drain = null;
    drain();
  }
}

class ZipEntry {
  #central;
  #local;
  #content;
  #source = null;
  #meta = null;
  #serialized = false;
  #fd = null;
  #localOffset = -1;
  #contentOffset = -1;

  constructor(central, local, content, fd = null, localOffset = -1) {
    this.#central = central;
    this.#local = local;
    this.#content = content;
    this.#fd = fd;
    this.#localOffset = localOffset;
  }

  get compressed() {
    return this.method !== METHOD_STORE;
  }
  get rawContent() {
    return this.#content;
  }
  get method() {
    return this.#meta ? this.#meta.method : this.#central.compressionMethod;
  }
  get flags() {
    return this.#meta
      ? this.#meta.flags
      : (this.#local ?? this.#central).flags;
  }
  get crc32() {
    if (this.#meta) {
      this.#assertNotPending();
      return this.#meta.crc;
    }
    return this.#central.crc32;
  }
  get name() {
    return this.#meta
      ? decodeZipName(this.#meta.name, this.#meta.flags, this.#meta.extra)
      : this.#central.fileName;
  }
  get nameBuffer() {
    return this.#meta ? this.#meta.name : this.#central.fileNameBuffer;
  }
  get comment() {
    return this.#meta
      ? decodeZipText(this.#meta.comment, this.#meta.flags)
      : this.#central.fileComment;
  }
  get size() {
    if (this.#meta) {
      this.#assertNotPending();
      return this.#meta.uncompressedSize;
    }
    return this.#central.uncompressedSize;
  }
  get compressedSize() {
    if (this.#meta) {
      this.#assertNotPending();
      return this.#meta.compressedSize;
    }
    return this.#central.compressedSize;
  }
  get modified() {
    if (this.#meta) return this.#meta.modified;
    if (this.#fd !== null && this.#local === null) {
      try {
        this.#resolveLocalHeaderSync();
      } catch {
        // A malformed local header fails loudly on the content read paths;
        // for metadata, the central directory alone has to do.
      }
    }
    return (
      extraFieldMtime(this.#central.extraField, this.#local?.extraField) ??
      this.#central.lastModified
    );
  }
  get mode() {
    if (this.#meta) {
      return this.#meta.madeBy === MADE_BY_UNIX
        ? (this.#meta.external >>> 16) & 0o7777
        : 0;
    }
    return this.#central.mode;
  }
  get isSymlink() {
    if (this.#meta) {
      return (
        this.#meta.madeBy === MADE_BY_UNIX &&
        ((this.#meta.external >>> 16) & S_IFMT) === S_IFLNK
      );
    }
    return this.#central.isSymlink;
  }
  get isFile() {
    return !this.isDirectory && !this.isSymlink;
  }
  get isDirectory() {
    return this.name.endsWith("/");
  }

  #assertNotPending() {
    if (this.#meta?.pending) {
      throw new ERR_INVALID_STATE(
        "this streaming entry has not finished serializing yet",
      );
    }
  }

  #finalizeMeta() {
    if (this.#meta) {
      this.#assertNotPending();
      return this.#meta;
    }
    const central = this.#central;
    const extra = stripZip64Extra(central.extraField);
    const modified = this.modified;
    const extendedMtime =
      extraFieldMtime(extra) === null
        ? extendedMtimeSeconds(modified.getTime())
        : null;
    const meta = {
      name: central.fileNameBuffer,
      comment: central.fileCommentBuffer,
      extra,
      flags: central.flags & ~FLAG_DATA_DESCRIPTOR,
      method: central.compressionMethod,
      crc: central.crc32,
      compressedSize: central.compressedSize,
      uncompressedSize: central.uncompressedSize,
      modified,
      extendedMtime,
      external: central.externalFileAttributes,
      internal: central.internalFileAttributes,
      madeBy: central.version >>> 8,
      pending: false,
    };
    this.#meta = meta;
    return meta;
  }

  #liveDescriptor() {
    const handle = this.#fd;
    if (handle === null) return null;
    if (handle.closed) {
      throw new ERR_INVALID_STATE(
        "cannot read a ZipEntry after its backing ZipFile has been closed",
      );
    }
    return handle.fd;
  }

  async #resolveLocalHeader() {
    if (this.#local !== null) return this.#local;
    const fd = this.#liveDescriptor();
    const fixed = Buffer.allocUnsafe(30);
    await readFdFully(fd, fixed, this.#localOffset);
    if (fixed.readUInt32LE(0) !== SIG_LOCAL_FILE_HEADER) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        `entry ${JSON.stringify(this.name)} has an invalid local file header`,
      );
    }
    const length = LocalFileHeader.length(fixed, 0);
    const full = Buffer.allocUnsafe(length);
    fixed.copy(full, 0);
    if (length > 30) {
      await readFdFully(fd, full.subarray(30), this.#localOffset + 30);
    }
    const local = new LocalFileHeader(full, 0);
    if (this.#central !== null) {
      assertConsistentLocalHeader(local, this.#central);
    }
    const contentOffset = this.#localOffset + length;
    this.#local = local;
    this.#contentOffset = contentOffset;
    return local;
  }

  #resolveLocalHeaderSync() {
    if (this.#local !== null) return this.#local;
    const fd = this.#liveDescriptor();
    const fixed = Buffer.allocUnsafe(30);
    readFdFullySync(fd, fixed, this.#localOffset);
    if (fixed.readUInt32LE(0) !== SIG_LOCAL_FILE_HEADER) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        `entry ${JSON.stringify(this.name)} has an invalid local file header`,
      );
    }
    const length = LocalFileHeader.length(fixed, 0);
    const full = Buffer.allocUnsafe(length);
    fixed.copy(full, 0);
    if (length > 30) {
      readFdFullySync(fd, full.subarray(30), this.#localOffset + 30);
    }
    const local = new LocalFileHeader(full, 0);
    if (this.#central !== null) {
      assertConsistentLocalHeader(local, this.#central);
    }
    const contentOffset = this.#localOffset + length;
    this.#local = local;
    this.#contentOffset = contentOffset;
    return local;
  }

  async #resolveContentOffset() {
    if (this.#contentOffset < 0) await this.#resolveLocalHeader();
    return this.#contentOffset;
  }

  #resolveContentOffsetSync() {
    if (this.#contentOffset < 0) this.#resolveLocalHeaderSync();
    return this.#contentOffset;
  }

  #inMemoryCompressed() {
    if (this.#content === null) {
      throw new ERR_INVALID_STATE(
        "the content of a streaming entry is not available for reading",
      );
    }
    return this.#content;
  }

  async #compressedBytes() {
    if (this.#fd === null) return this.#inMemoryCompressed();
    const size = this.compressedSize;
    if (size >= kMaxLength) {
      throw new ERR_ZIP_ENTRY_TOO_LARGE(
        `entry ${JSON.stringify(this.name)} is too large to buffer ` +
          `(${size} compressed bytes); use contentIterator() instead`,
      );
    }
    const start = await this.#resolveContentOffset();
    const compressed = Buffer.allocUnsafe(size);
    await readFdFully(this.#liveDescriptor(), compressed, start);
    return compressed;
  }

  #compressedBytesSync() {
    if (this.#fd === null) return this.#inMemoryCompressed();
    const size = this.compressedSize;
    if (size >= kMaxLength) {
      throw new ERR_ZIP_ENTRY_TOO_LARGE(
        `entry ${JSON.stringify(this.name)} is too large to buffer ` +
          `(${size} compressed bytes); use contentIterator() instead`,
      );
    }
    const start = this.#resolveContentOffsetSync();
    const compressed = Buffer.allocUnsafe(size);
    readFdFullySync(this.#liveDescriptor(), compressed, start);
    return compressed;
  }

  async *#rawChunks() {
    const handle = this.#fd;
    if (handle.closing) {
      throw new ERR_INVALID_STATE(
        "cannot read a ZipEntry after its backing ZipFile has been closed",
      );
    }
    handle.reads++;
    let reading = true;
    try {
      this.#liveDescriptor();
      let pos = await this.#resolveContentOffset();
      let remaining = this.compressedSize;
      while (remaining > 0) {
        const take = Math.min(READ_CHUNK_SIZE, remaining);
        const chunk = Buffer.allocUnsafe(take);
        await readFdFully(this.#liveDescriptor(), chunk, pos);
        pos += take;
        remaining -= take;
        reading = false;
        endHandleRead(handle);
        yield chunk;
        if (handle.closing) {
          throw new ERR_INVALID_STATE(
            "cannot read a ZipEntry after its backing ZipFile has been closed",
          );
        }
        handle.reads++;
        reading = true;
      }
    } finally {
      if (reading) endHandleRead(handle);
    }
  }

  *#rawChunksSync() {
    this.#liveDescriptor();
    let pos = this.#resolveContentOffsetSync();
    let remaining = this.compressedSize;
    while (remaining > 0) {
      const take = Math.min(READ_CHUNK_SIZE, remaining);
      const chunk = Buffer.allocUnsafe(take);
      readFdFullySync(this.#liveDescriptor(), chunk, pos);
      pos += take;
      remaining -= take;
      yield chunk;
    }
  }

  async content(options) {
    const declared = this.size;
    const maxSize = options?.maxSize ?? getMaxZipContentSize();
    if (declared > maxSize) {
      throw new ERR_ZIP_ENTRY_TOO_LARGE(
        `entry ${JSON.stringify(this.name)} declares ${declared} bytes, ` +
          `exceeding the ${maxSize} byte limit`,
      );
    }
    const handle = this.#fd;
    if (handle !== null) {
      if (handle.closing) {
        throw new ERR_INVALID_STATE(
          "cannot read a ZipEntry after its backing ZipFile has been closed",
        );
      }
      handle.reads++;
    }
    try {
      const compressed = await this.#compressedBytes();
      const data = await decodeMemberAsync(
        compressed,
        {
          name: this.name,
          flags: this.flags,
          method: this.method,
          crc32: this.crc32,
          uncompressedSize: declared,
        },
        { verify: options?.verify, maxSize },
      );
      return data === compressed && this.#fd === null
        ? Buffer.from(data)
        : data;
    } finally {
      if (handle !== null) endHandleRead(handle);
    }
  }

  contentSync(options) {
    const declared = this.size;
    const maxSize = options?.maxSize ?? getMaxZipContentSize();
    if (declared > maxSize) {
      throw new ERR_ZIP_ENTRY_TOO_LARGE(
        `entry ${JSON.stringify(this.name)} declares ${declared} bytes, ` +
          `exceeding the ${maxSize} byte limit`,
      );
    }
    const compressed = this.#compressedBytesSync();
    const data = decodeMemberSync(
      compressed,
      {
        name: this.name,
        flags: this.flags,
        method: this.method,
        crc32: this.crc32,
        uncompressedSize: declared,
      },
      { verify: options?.verify, maxSize },
    );
    return data === compressed && this.#fd === null
      ? Buffer.from(data)
      : data;
  }

  #rawSource() {
    if (this.#fd !== null) return this.#rawChunks();
    const content = this.#inMemoryCompressed();
    return (async function* () {
      if (content.length) yield content;
    })();
  }

  contentIterator(options) {
    return decodeMemberStream(
      this.#rawSource(),
      {
        name: this.name,
        flags: this.flags,
        method: this.method,
        crc32: this.crc32,
        uncompressedSize: this.size,
      },
      options,
    );
  }

  *[Symbol.iterator]() {
    if (this.#source) {
      throw new ERR_INVALID_STATE(
        "a streaming entry cannot be serialized synchronously",
      );
    }
    const meta = this.#finalizeMeta();
    yield buildLocalHeader(meta);
    if (this.#fd !== null) {
      yield* this.#rawChunksSync();
    } else if (this.#content?.length) {
      yield this.#content;
    }
  }

  async *[Symbol.asyncIterator]() {
    const source = this.#source;
    if (!source) {
      if (this.#fd !== null) {
        yield buildLocalHeader(this.#finalizeMeta());
        yield* this.#rawChunks();
        return;
      }
      yield* this[Symbol.iterator]();
      return;
    }
    if (this.#serialized) {
      throw new ERR_INVALID_STATE(
        "a streaming entry can only be serialized once",
      );
    }
    this.#serialized = true;
    const meta = this.#meta;
    yield buildLocalHeader(meta);
    let state = 0;
    let uncompressedSize = 0;
    let compressedSize = 0;
    const counted = (async function* () {
      for await (const chunk of source) {
        if (!isUint8Array(chunk)) {
          throw new ERR_INVALID_ARG_TYPE("chunk", "Uint8Array", chunk);
        }
        if (!chunk.length) continue;
        state = crc32(chunk, state);
        uncompressedSize += chunk.length;
        yield chunk;
      }
    })();
    const output =
      meta.method === METHOD_DEFLATE
        ? deflateRawStream(counted)
        : meta.method === METHOD_ZSTD
          ? zstdCompressStream(counted)
          : counted;
    for await (const chunk of output) {
      compressedSize += chunk.length;
      yield chunk;
    }
    meta.crc = state;
    meta.uncompressedSize = uncompressedSize;
    meta.compressedSize = compressedSize;
    meta.pending = false;
    yield buildDataDescriptor64(meta.crc, compressedSize, uncompressedSize);
  }

  #releaseSource() {
    const source = this.#source;
    this.#source = null;
    this.#serialized = true;
    return source;
  }
  [Symbol.dispose]() {
    const source = this.#releaseSource();
    if (source === null) return;
    if (typeof source.destroy === "function") source.destroy();
    else if (typeof source.return === "function") source.return();
  }
  async [Symbol.asyncDispose]() {
    const source = this.#releaseSource();
    if (source === null) return;
    if (typeof source[Symbol.asyncDispose] === "function")
      await source[Symbol.asyncDispose]();
    else if (typeof source.destroy === "function") source.destroy();
    else if (typeof source.return === "function") await source.return();
  }

  [kFinalize](localOffset, preserveDescriptorFlag = false) {
    validateInteger(localOffset, "localOffset", 0, Number.MAX_SAFE_INTEGER);
    const meta = this.#finalizeMeta();
    if (
      preserveDescriptorFlag &&
      this.#central !== null &&
      (this.#central.flags & FLAG_DATA_DESCRIPTOR) !== 0
    ) {
      return buildCentralHeader(
        { ...meta, flags: meta.flags | FLAG_DATA_DESCRIPTOR },
        localOffset,
      );
    }
    return buildCentralHeader(meta, localOffset);
  }

  [kPromote](fd, localOffset) {
    if (this.#content !== null || this.#fd !== null) return;
    this.#fd = fd;
    this.#localOffset = localOffset;
    this.#contentOffset = -1;
    this.#source = null;
    this.#serialized = false;
    this.#meta.flags &= ~FLAG_DATA_DESCRIPTOR;
  }

  static *read(buffer) {
    const buf = toBuffer(buffer, "buffer");
    yield* readArchiveEntries(buf, findArchiveEnd(buf));
  }

  static #prepareCreate(filename, data, options) {
    const meta = createEntryMeta(filename, options);
    const content = toBuffer(data, "data");
    const isDirectory = filename.endsWith("/");
    if (isDirectory && content.length) {
      throw new ERR_INVALID_ARG_VALUE(
        "data",
        data,
        "must be empty for a directory entry",
      );
    }
    meta.crc = crc32(content, 0);
    meta.uncompressedSize = content.length;
    const method =
      isDirectory || content.length === 0 || options?.method === "store"
        ? METHOD_STORE
        : options?.method === "zstd"
          ? METHOD_ZSTD
          : METHOD_DEFLATE;
    return { meta, content, method };
  }

  static #finishCreate(meta, content, method, compressed) {
    let finalContent = content;
    if (compressed !== null && compressed.length < content.length) {
      finalContent = compressed;
    } else if (compressed !== null) {
      method = METHOD_STORE;
    }
    meta.method = method;
    meta.compressedSize = finalContent.length;
    meta.pending = false;
    const entry = new ZipEntry(null, null, finalContent);
    entry.#meta = meta;
    return entry;
  }

  static async create(filename, data, options) {
    const { meta, content, method } = ZipEntry.#prepareCreate(
      filename,
      data,
      options,
    );
    const compressed =
      method === METHOD_DEFLATE
        ? await deflateRawAsync(content)
        : method === METHOD_ZSTD
          ? await zstdCompressAsync(content)
          : null;
    return ZipEntry.#finishCreate(meta, content, method, compressed);
  }

  static createSync(filename, data, options) {
    const { meta, content, method } = ZipEntry.#prepareCreate(
      filename,
      data,
      options,
    );
    const compressed =
      method === METHOD_DEFLATE
        ? deflateRawSync(content)
        : method === METHOD_ZSTD
          ? zstdCompressSync(content)
          : null;
    return ZipEntry.#finishCreate(meta, content, method, compressed);
  }

  static createStream(filename, source, options) {
    const meta = createEntryMeta(filename, options);
    if (filename.endsWith("/")) {
      throw new ERR_INVALID_ARG_VALUE(
        "filename",
        filename,
        "a directory entry cannot be streamed",
      );
    }
    meta.flags |= FLAG_DATA_DESCRIPTOR;
    meta.method =
      options?.method === "store"
        ? METHOD_STORE
        : options?.method === "zstd"
          ? METHOD_ZSTD
          : METHOD_DEFLATE;
    meta.pending = true;
    const entry = new ZipEntry(null, null, null);
    entry.#meta = meta;
    entry.#source = source;
    return entry;
  }

  static createSymlink(filename, target, options) {
    validateString(target, "target");
    const meta = createEntryMeta(filename, {
      __proto__: null,
      comment: options?.comment,
      mode: options?.mode,
      modified: options?.modified,
      symlink: true,
    });
    const content = Buffer.from(target, "utf8");
    meta.crc = crc32(content, 0);
    meta.uncompressedSize = content.length;
    meta.method = METHOD_STORE;
    meta.compressedSize = content.length;
    meta.pending = false;
    const entry = new ZipEntry(null, null, content);
    entry.#meta = meta;
    return entry;
  }
}

function* readArchiveEntries(buf, end) {
  let pos = end.centralDirectoryOffset;
  const cdEnd = end.centralDirectoryOffset + end.centralDirectorySize;
  const parsed = [];
  for (let index = 0; index < end.totalRecords; index++) {
    const central = new CentralFileHeader(buf, pos);
    if (pos + central.byteLength > cdEnd) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        "central directory header is out of bounds",
      );
    }
    if (central.diskNumber !== 0) {
      throw new ERR_ZIP_UNSUPPORTED_FEATURE(
        "multi-disk archives are not supported",
      );
    }
    const localOffset = central.localFileHeaderOffset + end.prefix;
    const local = new LocalFileHeader(buf, localOffset);
    assertConsistentLocalHeader(local, central);
    const dataStart = localOffset + local.byteLength;
    const length = central.compressedSize;
    validateArchiveRange(buf, dataStart, length, "entry data");
    const content = length
      ? buf.subarray(dataStart, dataStart + length)
      : EMPTY_BUFFER;
    parsed.push({
      entry: new ZipEntry(central, local, content),
      start: localOffset,
      dataEnd: dataStart + length,
    });
    pos = central.byteOffset + central.byteLength;
  }
  if (pos !== cdEnd) {
    throw new ERR_ZIP_INVALID_ARCHIVE(
      "central directory record count is inconsistent with its size",
    );
  }
  const ranges = parsed.slice().sort((a, b) => a.start - b.start);
  for (let i = 0; i < ranges.length; i++) {
    const bound =
      i + 1 < ranges.length
        ? ranges[i + 1].start
        : end.centralDirectoryOffset;
    if (ranges[i].dataEnd > bound) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        `entry ${JSON.stringify(ranges[i].entry.name)} overlaps the next ` +
          "entry or the central directory (possible zip bomb)",
      );
    }
  }
  for (let i = 0; i < parsed.length; i++) yield parsed[i].entry;
}

// ---------------------------------------------------------------------------
// ZipBuffer (lib/internal/zip/buffer.js, verbatim logic).
// ---------------------------------------------------------------------------

class ZipBuffer {
  #entries = new Map();
  #comment;

  constructor(buffer) {
    const buf = toBuffer(buffer, "buffer");
    const end = findArchiveEnd(buf);
    this.#comment = end.comment;
    for (const entry of readArchiveEntries(buf, end)) {
      this.#entries.set(entry.name, entry);
    }
  }
  get writable() {
    return true;
  }
  get comment() {
    return decodeZipText(this.#comment, 0);
  }
  has(name) {
    validateString(name, "name");
    return this.#entries.has(name);
  }
  get(name) {
    validateString(name, "name");
    const entry = this.#entries.get(name);
    if (entry === undefined) throw new ERR_ZIP_ENTRY_NOT_FOUND(name);
    return entry;
  }
  addEntry(entry) {
    if (!(entry instanceof ZipEntry)) {
      throw new ERR_INVALID_ARG_TYPE("entry", "ZipEntry", entry);
    }
    this.#entries.set(entry.name, entry);
    return entry;
  }
  async add(filename, data, options) {
    return this.addEntry(await ZipEntry.create(filename, data, options));
  }
  addSync(filename, data, options) {
    return this.addEntry(ZipEntry.createSync(filename, data, options));
  }
  delete(name) {
    validateString(name, "name");
    return this.#entries.delete(name);
  }
  clear() {
    this.#entries.clear();
  }
  keys() {
    return this.#entries.keys();
  }
  *values() {
    for (const name of this.keys()) yield this.get(name);
  }
  *entries() {
    for (const name of this.keys()) yield [name, this.get(name)];
  }
  get size() {
    return this.#entries.size;
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  get [Symbol.toStringTag]() {
    return "ZipBuffer";
  }
  forEach(callback, thisArg) {
    validateFunction(callback, "callback");
    for (const [key, value] of this.#entries) {
      callback.call(thisArg === undefined ? this : thisArg, value, key, this);
    }
  }
  async toBuffer(options) {
    const { comment, baseOffset } = normalizeArchiveOptions(options);
    const chunks = [];
    for await (const chunk of createZipArchive(this.values(), {
      comment: comment ?? this.#comment,
      baseOffset,
    })) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  toBufferSync(options) {
    const { comment, baseOffset } = normalizeArchiveOptions(options);
    const chunks = [];
    for (const chunk of createZipArchiveSync(this.values(), {
      comment: comment ?? this.#comment,
      baseOffset,
    })) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  [Symbol.dispose]() {
    this.#entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Archive serialization (lib/internal/zip/archive.js, adapted for zipFiles).
// ---------------------------------------------------------------------------

function normalizeArchiveOptions(options) {
  if (options === undefined) return { comment: undefined, baseOffset: 0 };
  if (typeof options === "string")
    return { comment: options, baseOffset: 0 };
  validateObject(options, "options");
  const { comment, baseOffset = 0 } = options;
  if (comment !== undefined && !isUint8Array(comment)) {
    validateString(comment, "options.comment");
  }
  validateInteger(baseOffset, "options.baseOffset", 0, Number.MAX_SAFE_INTEGER);
  return { comment, baseOffset };
}

function createZipArchive(entries, options) {
  return Readable.from(generateZipArchive(entries, options), {
    objectMode: false,
  });
}

function zipFiles(files, options) {
  const followSymlinks = options?.followSymlinks ?? true;
  validateBoolean(followSymlinks, "options.followSymlinks");
  return createZipArchive(fileEntries(files, followSymlinks), options);
}

// ponytail: Node opens each file with `fs.promises.open` (fd-pinned, O_NOFOLLOW
// + O_NONBLOCK) and streams from that exact descriptor so a symlink swapped in
// after classification cannot redirect the read (TOCTOU) and a FIFO cannot
// block the open. This port instead classifies with stat/lstat, rejects
// non-regular files BEFORE opening (so a FIFO/device is never opened), and
// streams with path-based `fs.createReadStream(path)`. The observable
// behavior is identical for the single-threaded memfs / parity-test use
// (classification and open cannot interleave with another writer), and it
// avoids the `fs.promises` FileHandle surface, which the shim fs does not
// expose in the same shape. Upgrade path: if the shim fs gains
// `fs.promises.open` + `createReadStream({ fd })`, switch back to Node's
// fd-pinned form.
async function* fileEntries(files, followSymlinks) {
  for await (const pair of files) {
    const sourcePath = pair[0];
    const name = pair[1];
    validateString(sourcePath, "sourcePath");
    validateString(name, "name");
    const stats = followSymlinks
      ? await fsStatAsync(sourcePath)
      : await fsLstatAsync(sourcePath);
    const options = {
      __proto__: null,
      mode: stats.mode & 0o7777,
      modified: stats.mtime,
    };
    if (stats.isSymbolicLink()) {
      yield ZipEntry.createSymlink(
        name,
        await fsReadlinkAsync(sourcePath),
        options,
      );
    } else if (stats.isDirectory()) {
      const dirName = name.endsWith("/") ? name : `${name}/`;
      yield await ZipEntry.create(dirName, EMPTY_BUFFER, options);
    } else {
      if (!stats.isFile()) {
        throw new ERR_ZIP_UNSUPPORTED_FEATURE(
          `cannot archive ${JSON.stringify(sourcePath)}: not a regular file`,
        );
      }
      const fileOptions = {
        __proto__: null,
        mode: stats.mode & 0o7777,
        modified: stats.mtime,
      };
      const stream = fs.createReadStream(sourcePath);
      let handedOff = false;
      try {
        yield ZipEntry.createStream(name, stream, fileOptions);
        handedOff = true;
      } finally {
        if (!handedOff) stream.destroy();
      }
    }
  }
}

function normalizeCommentBuffer(comment) {
  if (comment === undefined) return EMPTY_BUFFER;
  const buffer = isUint8Array(comment)
    ? comment
    : Buffer.from(comment, "utf8");
  if (buffer.length > SENTINEL16) {
    throw new ERR_ZIP_ARCHIVE_TOO_LARGE(
      "the archive comment must not exceed 65535 bytes when encoded as UTF-8",
    );
  }
  return buffer;
}

async function disposeQueuedEntries(iterator, isAsync) {
  if (isAsync) {
    if (typeof iterator.return === "function") await iterator.return();
    return;
  }
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    const entry = next.value;
    if (typeof entry?.[Symbol.asyncDispose] === "function")
      await entry[Symbol.asyncDispose]();
  }
}

async function* generateZipArchive(entries, options) {
  const { comment, baseOffset } = normalizeArchiveOptions(options);
  const commentBuffer = normalizeCommentBuffer(comment);
  const centralHeaders = [];
  let pos = baseOffset;
  const isAsync = entries[Symbol.asyncIterator] !== undefined;
  const iterator = isAsync
    ? entries[Symbol.asyncIterator]()
    : entries[Symbol.iterator]();
  let completed = false;
  try {
    while (true) {
      const next = isAsync ? await iterator.next() : iterator.next();
      if (next.done) break;
      const entry = next.value;
      const start = pos;
      for await (const chunk of entry) {
        yield chunk;
        pos += chunk.length;
      }
      centralHeaders.push(entry[kFinalize](start));
    }
    const centralDirectoryOffset = pos;
    for (let i = 0; i < centralHeaders.length; i++) {
      const chunk = centralHeaders[i];
      yield chunk;
      pos += chunk.length;
    }
    const centralDirectorySize = pos - centralDirectoryOffset;
    const count = centralHeaders.length;
    const trailer = buildArchiveTrailer(
      count,
      centralDirectorySize,
      centralDirectoryOffset,
      commentBuffer,
    );
    for (let i = 0; i < trailer.length; i++) yield trailer[i];
    completed = true;
  } finally {
    if (!completed) await disposeQueuedEntries(iterator, isAsync);
  }
}

function* createZipArchiveSync(entries, options) {
  const { comment, baseOffset } = normalizeArchiveOptions(options);
  const commentBuffer = normalizeCommentBuffer(comment);
  const centralHeaders = [];
  let pos = baseOffset;
  const iterator = entries[Symbol.iterator]();
  let completed = false;
  let current = null;
  try {
    for (let next = iterator.next(); !next.done; next = iterator.next()) {
      current = next.value;
      const start = pos;
      for (const chunk of current) {
        yield chunk;
        pos += chunk.length;
      }
      centralHeaders.push(current[kFinalize](start));
      current = null;
    }
    const centralDirectoryOffset = pos;
    for (let i = 0; i < centralHeaders.length; i++) {
      const chunk = centralHeaders[i];
      yield chunk;
      pos += chunk.length;
    }
    const centralDirectorySize = pos - centralDirectoryOffset;
    const count = centralHeaders.length;
    const trailer = buildArchiveTrailer(
      count,
      centralDirectorySize,
      centralDirectoryOffset,
      commentBuffer,
    );
    for (let i = 0; i < trailer.length; i++) yield trailer[i];
    completed = true;
  } finally {
    if (!completed) {
      if (typeof current?.[Symbol.dispose] === "function")
        current[Symbol.dispose]();
      for (let next = iterator.next(); !next.done; next = iterator.next()) {
        const entry = next.value;
        if (typeof entry?.[Symbol.dispose] === "function")
          entry[Symbol.dispose]();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ZipFile (lib/internal/zip/file.js, verbatim logic).
// ---------------------------------------------------------------------------

function buildCentralDirectoryChunks(
  records,
  centralDirectoryOffset,
  comment,
) {
  const centralHeaders = [];
  let centralDirectorySize = 0;
  for (let i = 0; i < records.length; i++) {
    const header = records[i].entry[kFinalize](records[i].localOffset, true);
    centralHeaders.push(header);
    centralDirectorySize += header.length;
  }
  const count = records.length;
  const chunks = [];
  for (let i = 0; i < centralHeaders.length; i++)
    chunks.push(centralHeaders[i]);
  const trailer = buildArchiveTrailer(
    count,
    centralDirectorySize,
    centralDirectoryOffset,
    comment,
  );
  for (let i = 0; i < trailer.length; i++) chunks.push(trailer[i]);
  return { centralHeaders, chunks };
}

function checkArchiveEnd(end, size) {
  if (end.centralDirectorySize > kMaxLength) {
    throw new ERR_ZIP_ARCHIVE_TOO_LARGE(
      "the central directory is too large to buffer",
    );
  }
  if (end.centralDirectoryOffset + end.centralDirectorySize > size) {
    throw new ERR_ZIP_INVALID_ARCHIVE("central directory is out of bounds");
  }
}

function localHeaderEnd(fixed, offset, compressedSize) {
  if (fixed.readUInt32LE(0) !== SIG_LOCAL_FILE_HEADER) {
    return offset + 30 + compressedSize;
  }
  return offset + LocalFileHeader.length(fixed, 0) + compressedSize;
}

async function validateMemberBounds(
  fd,
  headers,
  prefix,
  size,
  centralDirectoryOffset,
) {
  const members = [];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const offset = header.localFileHeaderOffset + prefix;
    const fixed = Buffer.allocUnsafe(30);
    await readFdFully(fd, fixed, offset);
    const dataEnd = localHeaderEnd(fixed, offset, header.compressedSize);
    checkMemberRange(members, header.fileName, offset, dataEnd, size);
  }
  checkMemberOverlap(members, centralDirectoryOffset);
}

function validateMemberBoundsSync(
  fd,
  headers,
  prefix,
  size,
  centralDirectoryOffset,
) {
  const members = [];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const offset = header.localFileHeaderOffset + prefix;
    const fixed = Buffer.allocUnsafe(30);
    readFdFullySync(fd, fixed, offset);
    const dataEnd = localHeaderEnd(fixed, offset, header.compressedSize);
    checkMemberRange(members, header.fileName, offset, dataEnd, size);
  }
  checkMemberOverlap(members, centralDirectoryOffset);
}

function checkMemberRange(members, fileName, offset, dataEnd, size) {
  if (dataEnd > size) {
    throw new ERR_ZIP_INVALID_ARCHIVE(
      `entry ${JSON.stringify(fileName)} data is out of bounds`,
    );
  }
  members.push({ fileName, offset, dataEnd });
}

function checkMemberOverlap(members, centralDirectoryOffset) {
  members.sort((a, b) => a.offset - b.offset);
  for (let i = 0; i < members.length; i++) {
    const bound =
      i + 1 < members.length
        ? members[i + 1].offset
        : centralDirectoryOffset;
    if (members[i].dataEnd > bound) {
      throw new ERR_ZIP_INVALID_ARCHIVE(
        `entry ${JSON.stringify(members[i].fileName)} overlaps the next ` +
          "entry or the central directory (possible zip bomb)",
      );
    }
  }
}

class ZipFile {
  #handle;
  #closing = false;
  #closePromise = null;
  #writable;
  #comment;
  #centralDirectoryOffset;
  #entries = new Map();
  #queue = Promise.resolve();
  #pendingAsyncOps = 0;

  constructor(
    fd,
    centralHeaders,
    prefix,
    centralDirectoryOffset,
    comment,
    writable,
  ) {
    this.#handle = {
      fd,
      closed: false,
      closing: false,
      reads: 0,
      drain: null,
    };
    this.#writable = writable;
    this.#comment = comment;
    this.#centralDirectoryOffset = centralDirectoryOffset;
    for (let i = 0; i < centralHeaders.length; i++) {
      const central = centralHeaders[i];
      this.#entries.set(central.fileName, {
        central,
        entry: undefined,
        localOffset: central.localFileHeaderOffset + prefix,
      });
    }
  }
  get writable() {
    return this.#writable;
  }
  get comment() {
    return decodeZipText(this.#comment, 0);
  }
  #assertWritable() {
    if (!this.#writable) throw new ERR_ZIP_NOT_WRITABLE();
  }
  #assertOpen() {
    if (this.#closing) {
      throw new ERR_INVALID_STATE("the ZipFile has been closed");
    }
  }
  #assertNotBusy() {
    if (this.#pendingAsyncOps > 0) {
      throw new ERR_INVALID_STATE(
        "cannot call a synchronous ZipFile method while an asynchronous " +
          "add(), addEntry(), delete(), or close() call has not settled yet",
      );
    }
  }
  #enqueue(fn) {
    this.#pendingAsyncOps++;
    const run = async () => {
      try {
        return await fn();
      } finally {
        this.#pendingAsyncOps--;
      }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  has(name) {
    this.#assertOpen();
    validateString(name, "name");
    return this.#entries.has(name);
  }
  #handleFor(info) {
    info.entry ??= new ZipEntry(
      info.central,
      null,
      null,
      this.#handle,
      info.localOffset,
    );
    return info.entry;
  }
  async get(name) {
    this.#assertOpen();
    validateString(name, "name");
    const info = this.#entries.get(name);
    if (info === undefined) throw new ERR_ZIP_ENTRY_NOT_FOUND(name);
    return this.#handleFor(info);
  }
  getSync(name) {
    this.#assertOpen();
    this.#assertNotBusy();
    validateString(name, "name");
    const info = this.#entries.get(name);
    if (info === undefined) throw new ERR_ZIP_ENTRY_NOT_FOUND(name);
    return this.#handleFor(info);
  }
  async stream(name, options) {
    const entry = await this.get(name);
    return Readable.from(entry.contentIterator(options), {
      objectMode: false,
    });
  }
  async addEntry(entry) {
    this.#assertWritable();
    this.#assertOpen();
    if (!(entry instanceof ZipEntry)) {
      throw new ERR_INVALID_ARG_TYPE("entry", "ZipEntry", entry);
    }
    return this.#enqueue(() => this.#doAdd(entry));
  }
  async add(filename, data, options) {
    this.#assertWritable();
    this.#assertOpen();
    return this.#enqueue(async () =>
      this.#doAdd(await ZipEntry.create(filename, data, options)),
    );
  }
  async #doAdd(entry) {
    const localOffset = this.#centralDirectoryOffset;
    let written = 0;
    try {
      for await (const chunk of entry) {
        await writeFdFully(this.#handle.fd, chunk, localOffset + written);
        written += chunk.length;
      }
    } catch (err) {
      try {
        await this.#rewriteCentralDirectory();
      } catch {
        // Restoring failed too (the device is likely full or gone); the
        // original error is the actionable one.
      }
      throw err;
    }
    const previousEntry = this.#entries.get(entry.name);
    this.#centralDirectoryOffset = localOffset + written;
    this.#entries.set(entry.name, {
      central: null,
      entry,
      localOffset,
    });
    try {
      await this.#rewriteCentralDirectory();
    } catch (err) {
      this.#centralDirectoryOffset = localOffset;
      if (previousEntry === undefined) {
        this.#entries.delete(entry.name);
      } else {
        this.#entries.set(entry.name, previousEntry);
      }
      try {
        await this.#rewriteCentralDirectory();
      } catch {
        // Restoring failed too; the original error is the actionable one.
      }
      throw err;
    }
    entry[kPromote](this.#handle, localOffset);
    return entry;
  }
  addEntrySync(entry) {
    this.#assertWritable();
    this.#assertOpen();
    this.#assertNotBusy();
    if (!(entry instanceof ZipEntry)) {
      throw new ERR_INVALID_ARG_TYPE("entry", "ZipEntry", entry);
    }
    const localOffset = this.#centralDirectoryOffset;
    let written = 0;
    try {
      for (const chunk of entry) {
        writeFdFullySync(this.#handle.fd, chunk, localOffset + written);
        written += chunk.length;
      }
    } catch (err) {
      try {
        this.#rewriteCentralDirectorySync();
      } catch {
        // Restoring failed too; the original error is the actionable one.
      }
      throw err;
    }
    const previousEntry = this.#entries.get(entry.name);
    this.#centralDirectoryOffset = localOffset + written;
    this.#entries.set(entry.name, {
      central: null,
      entry,
      localOffset,
    });
    try {
      this.#rewriteCentralDirectorySync();
    } catch (err) {
      this.#centralDirectoryOffset = localOffset;
      if (previousEntry === undefined) {
        this.#entries.delete(entry.name);
      } else {
        this.#entries.set(entry.name, previousEntry);
      }
      try {
        this.#rewriteCentralDirectorySync();
      } catch {
        // Restoring failed too; the original error is the actionable one.
      }
      throw err;
    }
    entry[kPromote](this.#handle, localOffset);
    return entry;
  }
  addSync(filename, data, options) {
    this.#assertWritable();
    return this.addEntrySync(ZipEntry.createSync(filename, data, options));
  }
  async delete(name) {
    this.#assertWritable();
    this.#assertOpen();
    validateString(name, "name");
    return this.#enqueue(() => this.#doDelete(name));
  }
  async #doDelete(name) {
    const existed = this.#entries.delete(name);
    if (existed) await this.#rewriteCentralDirectory();
    return existed;
  }
  deleteSync(name) {
    this.#assertWritable();
    this.#assertOpen();
    this.#assertNotBusy();
    validateString(name, "name");
    const existed = this.#entries.delete(name);
    if (existed) this.#rewriteCentralDirectorySync();
    return existed;
  }
  #liveRecords() {
    const records = [];
    const names = [];
    for (const [name, value] of this.#entries) {
      records.push({
        entry: value.entry ?? new ZipEntry(value.central, null, null),
        localOffset: value.localOffset,
      });
      names.push(name);
    }
    return { records, names };
  }
  async #rewriteCentralDirectory() {
    const { records, names } = this.#liveRecords();
    const { centralHeaders, chunks } = buildCentralDirectoryChunks(
      records,
      this.#centralDirectoryOffset,
      this.#comment,
    );
    let pos = this.#centralDirectoryOffset;
    for (let i = 0; i < chunks.length; i++) {
      await writeFdFully(this.#handle.fd, chunks[i], pos);
      pos += chunks[i].length;
    }
    await fsFtruncateAsync(this.#handle.fd, pos);
    this.#adoptRewrittenCentralDirectory(names, centralHeaders, records);
  }
  #rewriteCentralDirectorySync() {
    const { records, names } = this.#liveRecords();
    const { centralHeaders, chunks } = buildCentralDirectoryChunks(
      records,
      this.#centralDirectoryOffset,
      this.#comment,
    );
    let pos = this.#centralDirectoryOffset;
    for (let i = 0; i < chunks.length; i++) {
      writeFdFullySync(this.#handle.fd, chunks[i], pos);
      pos += chunks[i].length;
    }
    fs.ftruncateSync(this.#handle.fd, pos);
    this.#adoptRewrittenCentralDirectory(names, centralHeaders, records);
  }
  #adoptRewrittenCentralDirectory(names, centralHeaders, records) {
    for (let i = 0; i < names.length; i++) {
      this.#entries.set(names[i], {
        central: new CentralFileHeader(centralHeaders[i], 0),
        entry: undefined,
        localOffset: records[i].localOffset,
      });
    }
  }
  compact(comment) {
    this.#assertOpen();
    const entries = [];
    for (const [, info] of this.#entries) {
      entries.push(this.#handleFor(info));
    }
    return createZipArchive(entries, { comment: comment ?? this.#comment });
  }
  compactSync(comment) {
    this.#assertOpen();
    this.#assertNotBusy();
    const entries = [];
    for (const [, info] of this.#entries) {
      entries.push(this.#handleFor(info));
    }
    const chunks = [];
    for (const chunk of createZipArchiveSync(entries, {
      comment: comment ?? this.#comment,
    })) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  keys() {
    this.#assertOpen();
    return this.#entries.keys();
  }
  *values() {
    for (const name of this.keys()) yield this.get(name);
  }
  *valuesSync() {
    for (const name of this.keys()) yield this.getSync(name);
  }
  *entries() {
    for (const name of this.keys()) yield [name, this.get(name)];
  }
  *entriesSync() {
    for (const name of this.keys()) yield [name, this.getSync(name)];
  }
  async *[Symbol.asyncIterator]() {
    for (const promise of this.values()) yield await promise;
  }
  get size() {
    this.#assertOpen();
    return this.#entries.size;
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  get [Symbol.toStringTag]() {
    return "ZipFile";
  }
  forEach(callback, thisArg) {
    validateFunction(callback, "callback");
    for (const [key, value] of this.entries()) {
      callback.call(thisArg === undefined ? this : thisArg, value, key, this);
    }
  }
  forEachSync(callback, thisArg) {
    validateFunction(callback, "callback");
    for (const [key, value] of this.entriesSync()) {
      callback.call(thisArg === undefined ? this : thisArg, value, key, this);
    }
  }
  close() {
    if (this.#closing) return this.#closePromise ?? Promise.resolve();
    this.#closing = true;
    this.#handle.closing = true;
    this.#closePromise = this.#enqueue(async () => {
      if (this.#handle.reads > 0) {
        await new Promise((resolve) => {
          this.#handle.drain = resolve;
        });
      }
      this.#handle.closed = true;
      this.#entries.clear();
      await fsCloseAsync(this.#handle.fd);
    });
    return this.#closePromise;
  }
  closeSync() {
    if (this.#closing) return;
    this.#assertNotBusy();
    if (this.#handle.reads > 0) {
      throw new ERR_INVALID_STATE(
        "cannot synchronously close a ZipFile while an asynchronous read is " +
          "still in flight",
      );
    }
    this.#closing = true;
    this.#handle.closing = true;
    this.#handle.closed = true;
    this.#entries.clear();
    fs.closeSync(this.#handle.fd);
  }
  async [Symbol.asyncDispose]() {
    await this.close();
  }
  [Symbol.dispose]() {
    this.closeSync();
  }
  static async open(filename, options) {
    validateString(filename, "filename");
    const writable = options?.writable ?? false;
    validateBoolean(writable, "options.writable");
    const fd = await fsOpenAsync(filename, writable ? "r+" : "r");
    try {
      const stat = await fsFstatAsync(fd);
      const size = stat.size;
      const tailLength = Math.min(size, TAIL_LENGTH);
      const tail = Buffer.allocUnsafe(tailLength);
      await readFdFully(fd, tail, size - tailLength);
      let end = findArchiveEnd(tail, size - tailLength);
      if (end.needTailFrom !== undefined) {
        const retry = Buffer.allocUnsafe(size - end.needTailFrom);
        await readFdFully(fd, retry, end.needTailFrom);
        end = findArchiveEnd(retry, end.needTailFrom);
        if (end.needTailFrom !== undefined) {
          throw new ERR_ZIP_INVALID_ARCHIVE(
            "Zip64 end of central directory record not found",
          );
        }
      }
      checkArchiveEnd(end, size);
      const directory = Buffer.allocUnsafe(end.centralDirectorySize);
      await readFdFully(fd, directory, end.centralDirectoryOffset);
      const headers = readCentralDirectory(directory, end.totalRecords);
      await validateMemberBounds(
        fd,
        headers,
        end.prefix,
        size,
        end.centralDirectoryOffset,
      );
      return new ZipFile(
        fd,
        headers,
        end.prefix,
        end.centralDirectoryOffset,
        end.comment,
        writable,
      );
    } catch (err) {
      try {
        await fsCloseAsync(fd);
      } catch {
        // The archive failed to parse; the close error is not actionable.
      }
      throw err;
    }
  }
  static openSync(filename, options) {
    validateString(filename, "filename");
    const writable = options?.writable ?? false;
    validateBoolean(writable, "options.writable");
    const fd = fs.openSync(filename, writable ? "r+" : "r");
    try {
      const size = fs.fstatSync(fd).size;
      const tailLength = Math.min(size, TAIL_LENGTH);
      const tail = Buffer.allocUnsafe(tailLength);
      readFdFullySync(fd, tail, size - tailLength);
      let end = findArchiveEnd(tail, size - tailLength);
      if (end.needTailFrom !== undefined) {
        const retry = Buffer.allocUnsafe(size - end.needTailFrom);
        readFdFullySync(fd, retry, end.needTailFrom);
        end = findArchiveEnd(retry, end.needTailFrom);
        if (end.needTailFrom !== undefined) {
          throw new ERR_ZIP_INVALID_ARCHIVE(
            "Zip64 end of central directory record not found",
          );
        }
      }
      checkArchiveEnd(end, size);
      const directory = Buffer.allocUnsafe(end.centralDirectorySize);
      readFdFullySync(fd, directory, end.centralDirectoryOffset);
      const headers = readCentralDirectory(directory, end.totalRecords);
      validateMemberBoundsSync(
        fd,
        headers,
        end.prefix,
        size,
        end.centralDirectoryOffset,
      );
      return new ZipFile(
        fd,
        headers,
        end.prefix,
        end.centralDirectoryOffset,
        end.comment,
        writable,
      );
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {
        // The archive failed to parse; the close error is not actionable.
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Raw exports for src/zlib.js, which wraps them with Node's experimental
// warning (lib/zlib.js zip section) before exposing them publicly.
// ---------------------------------------------------------------------------

export {
  ZipEntry,
  ZipBuffer,
  ZipFile,
  createZipArchive,
  createZipArchiveSync,
  getMaxZipContentSize,
  setMaxZipContentSize,
  zipFiles,
};
