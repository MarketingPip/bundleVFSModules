// Parity adapter for `require('internal/fs/utils')` used by the official
// Node fs tests (test-fs-utils-get-dirents, test-fs-watchfile-bigint, plus
// the four guard tests that already pass against it: test-fs-filehandle,
// test-fs-open-flags, test-fs-rmdir-recursive,
// test-fs-util-validateoffsetlength).
//
// The problem: without a redirect the require falls through to real Node's
// `internal/fs/utils`, whose getDirent lstats the REAL-disk path (the test
// fixtures live only in memfs → ENOENT) and whose toStats returns Stats,
// not BigIntStats. This adapter is a faithful port of the Node functions
// the fs tests use (lib/internal/fs/utils.js, Node v24.20.0), over the
// shim's memfs-backed fs: getDirents/getDirent lstat through the harness
// wrapper, BigIntStats is the shim's class (the same one toStats returns),
// and the validators are the shim's own ports.
//
// Harness-only; src/ behavior is untouched except the shared pieces the
// adapter re-exports (BigIntStats, DirentFromStats, stringToFlags,
// validateOffsetLengthRead/Write — all faithful Node ports living in
// src/fs.js next to the existing validators). The adapter's own require()
// below reaches the shim because the adapter lives under parity/, not
// under parity/node-test/parallel/, so the preload's testsDir-guarded
// redirect does not apply to it — same pattern as internal-net-adapter.
//
// NOT ported (no fs test in this wave uses them): validateRmOptions
// (async), getValidatedPath/getValidatedFd, getOptions, stringToFlags
// siblings (getValidMode, toUnixTimestamp, etc.), Stats. If a future test
// needs one, port it here rather than falling back to native.
import pathModule from "node:path";
import shimFs from "./fs-harness.mjs";
import {
  BigIntStats,
  Dirent,
  DirentFromStats,
  errArgType,
  stringToFlags,
  validateInteger,
  validateOffsetLengthRead,
  validateOffsetLengthWrite,
} from "../src/internals/fs-utils.js";

const UV_DIRENT_UNKNOWN = 0;

function isUint8Array(value) {
  return value instanceof Uint8Array;
}

// Node's join() (lib/internal/fs/utils.js:238-258). The error message is
// asserted verbatim by test-fs-utils-get-dirents ("wrong combination").
function join(path, name) {
  if ((typeof path === "string" || isUint8Array(path)) && name === undefined) {
    return path;
  }

  if (typeof path === "string" && isUint8Array(name)) {
    const pathBuffer = Buffer.from(pathModule.join(path, pathModule.sep));
    return Buffer.concat([pathBuffer, name]);
  }

  if (typeof path === "string" && typeof name === "string") {
    return pathModule.join(path, name);
  }

  if (isUint8Array(path) && isUint8Array(name)) {
    return Buffer.concat([path, Buffer.from(pathModule.sep), name]);
  }

  throw errArgType("path", ["string", "Buffer"], path);
}

function once(callback) {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    return callback(...args);
  };
}

// Node's getDirents (lib/internal/fs/utils.js:260-289), with lstat routed
// through the harness-wrapped shim fs so memfs-only paths resolve.
function getDirents(path, { 0: names, 1: types }, callback) {
  let i;
  if (typeof callback === "function") {
    const len = names.length;
    let toFinish = 0;
    callback = once(callback);
    for (i = 0; i < len; i++) {
      const type = types[i];
      if (type === UV_DIRENT_UNKNOWN) {
        const name = names[i];
        const idx = i;
        toFinish++;
        let filepath;
        try {
          filepath = join(path, name);
        } catch (err) {
          callback(err);
          return;
        }
        shimFs.lstat(filepath, (err, stats) => {
          if (err) {
            callback(err);
            return;
          }
          names[idx] = new DirentFromStats(name, stats, path);
          if (--toFinish === 0) {
            callback(null, names);
          }
        });
      } else {
        names[i] = new Dirent(names[i], types[i], path);
      }
    }
    if (toFinish === 0) {
      callback(null, names);
    }
  } else {
    const len = names.length;
    for (i = 0; i < len; i++) {
      names[i] = getDirent(path, names[i], types[i]);
    }
    return names;
  }
}

// Node's getDirent (lib/internal/fs/utils.js:291-315).
function getDirent(path, name, type, callback) {
  if (typeof callback === "function") {
    if (type === UV_DIRENT_UNKNOWN) {
      let filepath;
      try {
        filepath = join(path, name);
      } catch (err) {
        callback(err);
        return;
      }
      shimFs.lstat(filepath, (err, stats) => {
        if (err) {
          callback(err);
          return;
        }
        callback(null, new DirentFromStats(name, stats, path));
      });
    } else {
      callback(null, new Dirent(name, type, path));
    }
  } else if (type === UV_DIRENT_UNKNOWN) {
    const filepath = join(path, name);
    const stats = shimFs.lstatSync(filepath);
    return new DirentFromStats(name, stats, path);
  } else {
    return new Dirent(name, type, path);
  }
}

// Node's validateObject (lib/internal/validators.js), strict form (no
// allowNullable/allowArray/allowFunction): null, arrays, and non-objects
// throw. The shim's validateOptionsObject is nullable-tolerant, which is
// the wrong shape here (validateRmdirOptions(null) must throw).
function validateObjectStrict(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw errArgType(name, "object", value);
  }
}

// Node's validateBoolean as used by the rm validators: the property form
// (`The "options.recursive" property must be of type boolean.`).
function validateBooleanProp(value, name) {
  if (typeof value !== "boolean") throw errArgType(name, "boolean", value);
}

const defaultRmOptions = {
  recursive: false,
  force: false,
  retryDelay: 100,
  maxRetries: 0,
};

const defaultRmdirOptions = {
  retryDelay: 100,
  maxRetries: 0,
  recursive: false,
};

// Node's validateRmdirOptions (lib/internal/fs/utils.js:884-902).
function validateRmdirOptions(options, defaults = defaultRmdirOptions) {
  if (options === undefined) return defaults;
  validateObjectStrict(options, "options");
  options = { ...defaults, ...options };
  validateBooleanProp(options.recursive, "options.recursive");
  validateInteger(options.retryDelay, "options.retryDelay", 0, 2147483647);
  validateInteger(options.maxRetries, "options.maxRetries", 0, 4294967295);
  return options;
}

// Node's validateRmOptionsSync (lib/internal/fs/utils.js:841-868). The
// EISDIR shape mirrors the shim's checkRm (probed against real Node
// v24.20.0: `Path is a directory: rm returned EISDIR (is a directory)
// <path>`, code ERR_FS_EISDIR, errno 21, syscall 'rm').
function validateRmOptionsSync(path, options, expectDir) {
  options = validateRmdirOptions(options, defaultRmOptions);
  validateBooleanProp(options.force, "options.force");

  if (!options.force || expectDir || !options.recursive) {
    const isDirectory = shimFs
      .lstatSync(path, { throwIfNoEntry: !options.force })
      ?.isDirectory();

    if (expectDir && !isDirectory) {
      return false;
    }

    if (isDirectory && !options.recursive) {
      const err = new Error(
        `Path is a directory: rm returned EISDIR (is a directory) ${path}`,
      );
      err.code = "ERR_FS_EISDIR";
      err.errno = 21;
      err.syscall = "rm";
      err.path = path;
      throw err;
    }
  }

  return options;
}

export {
  BigIntStats,
  Dirent,
  DirentFromStats,
  getDirent,
  getDirents,
  stringToFlags,
  validateOffsetLengthRead,
  validateOffsetLengthWrite,
  validateRmdirOptions,
  validateRmOptionsSync,
};
export default {
  BigIntStats,
  Dirent,
  DirentFromStats,
  getDirent,
  getDirents,
  stringToFlags,
  validateOffsetLengthRead,
  validateOffsetLengthWrite,
  validateRmdirOptions,
  validateRmOptionsSync,
};
