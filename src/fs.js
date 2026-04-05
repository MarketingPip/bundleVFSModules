import { vol, promises as memPromises, constants as memConstants } from "memfs";
import { createFsFromVolume } from "memfs";

// ── Singleton guard — construction only runs once ─────────────────────────────
if (!globalThis._RUNTIME_.__FS__) {

  const fs = createFsFromVolume(vol);
  fs.promises = memPromises;
  fs.constants = memConstants;
  fs._vol = vol;

  // ── Node-compatible error factory ───────────────────────────────────────────
  // Mirrors Node's internal makeCallback / maybeCallback validation.
  // Older Node used ERR_INVALID_CALLBACK; modern Node uses ERR_INVALID_ARG_TYPE.
  // We match modern Node (v14+).
  function makeArgTypeError(argName, expected, received) {
    const receivedStr =
      received === undefined
        ? "undefined"
        : received === null
        ? "null"
        : `type ${typeof received}`;
    const msg = `The "${argName}" argument must be of type ${expected}. Received ${receivedStr}`;
    const err = new TypeError(msg);
    err.code = "ERR_INVALID_ARG_TYPE";
    Object.defineProperty(err, "name", {
      value: "TypeError [ERR_INVALID_ARG_TYPE]",
      writable: true,
      configurable: true,
    });
    return err;
  }

  // ── Classify methods ─────────────────────────────────────────────────────────
  // These fs methods either return a stream/watcher (not callback-based)
  // or accept an optional listener rather than a required error-first callback.
  const STREAM_OR_WATCHER = new Set([
    "createReadStream",
    "createWriteStream",
    "watch",       // listener is optional; returns FSWatcher
    "unwatchFile", // no callback at all
  ]);

  // Determines whether `key` is a callback-async method that *requires* its
  // last argument to be a function, matching Node's maybeCallback guard.
  function requiresCallback(key) {
    if (key.endsWith("Sync")) return false;       // sync variants never take a cb
    if (STREAM_OR_WATCHER.has(key)) return false; // stream/watcher factories
    return true;
  }

  // ── Monkey-patch callback methods ────────────────────────────────────────────
  const SKIP = new Set(["promises", "constants", "_vol"]);

  for (const key of Object.keys(fs)) {
    if (SKIP.has(key)) continue;
    const original = fs[key];
    if (typeof original !== "function") continue;

    const needsCb = requiresCallback(key);

    fs[key] = function (...args) {
      // ── Callback validation (mirrors Node's makeCallback / maybeCallback) ──
      if (needsCb) {
        const lastArg = args[args.length - 1];
        if (typeof lastArg !== "function") {
          throw makeArgTypeError("cb", "function", lastArg);
        }
      }

      const emit = (result) => {
        if (typeof globalThis.emitMe === "function") {
          globalThis.emitMe("fs", key, ...args, result);
        }
      };

      // Callback-style async: wrap the callback to capture the result
      const lastArg = args[args.length - 1];
      if (typeof lastArg === "function") {
        const originalCb = lastArg;
        args[args.length - 1] = function (...cbArgs) {
          // cbArgs[0] = err, cbArgs[1] = result (error-first convention)
          emit(cbArgs[1]);
          return originalCb.apply(this, cbArgs);
        };
        return original.apply(this, args);
      }

      // Synchronous call (or stream factory etc.)
      const result = original.apply(this, args);

      if (result && typeof result.then === "function") {
        return result.then(
          (val) => { emit(val); return val; },
          (err) => { emit(undefined); return Promise.reject(err); }
        );
      }

      emit(result);
      return result;
    };

    Object.defineProperty(fs[key], "name", { value: key });
  }

  // ── Patch fs.promises (Promise-based, no callbacks) ──────────────────────────
  const WRITE_METHODS = new Set([
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "mkdir",
    "mkdirSync",
    "rmdir",
    "rmdirSync",
    "unlink",
    "unlinkSync",
    "rename",
    "renameSync",
    "truncate",
    "truncateSync",
    "symlink",
    "symlinkSync",
    "link",
    "linkSync",
  ]);

  for (const key of Object.keys(memPromises)) {
    const original = memPromises[key];
    if (typeof original !== "function") continue;

    const isWrite = WRITE_METHODS.has(key.replace("Sync", ""));

    fs.promises[key] = async function (...args) {
      const target = isWrite ? fs._vol.promises : memPromises;
      const result = await original.apply(target, args);
      if (typeof globalThis.emitMe === "function") {
        globalThis.emitMe("fs", `promises.${key}`, ...args, result);
      }
      return result;
    };

    Object.defineProperty(fs.promises[key], "name", { value: key });
  }

  globalThis._RUNTIME_.__FS__ = fs;
}

// ── All exports derive from the singleton ─────────────────────────────────────
const _fs = globalThis._RUNTIME_.__FS__;

export const {
  access,
  accessSync,
  appendFile,
  appendFileSync,
  chmod,
  chmodSync,
  chown,
  chownSync,
  copyFile,
  copyFileSync,
  cp,
  cpSync,
  cwd,
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
  lchmod,
  lchmodSync,
  lchown,
  lchownSync,
  link,
  linkSync,
  lstat,
  lstatSync,
  mkdir,
  mkdirSync,
  mkdtemp,
  mkdtempSync,
  open,
  openSync,
  opendir,
  opendirSync,
  readdir,
  readdirSync,
  readFile,
  readFileSync,
  readlink,
  readlinkSync,
  realpath,
  realpathSync,
  rename,
  renameSync,
  rm,
  rmdir,
  rmdirSync,
  stat,
  statSync,
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
  writeFile,
  writeFileSync,
  write,
  writeSync,
  createReadStream,
  createWriteStream,
  constants,
  promises,
} = _fs;

// default export is the singleton itself — identity-safe across all imports
export default _fs;

/*  Uncommented for now - leaving incase in future any issues.
for (const key of Object.keys(_fs)) {
  if (typeof _fs[key] === 'function') {
    _fs[key] = globalThis._RUNTIME_.taskTracker.patch(_fs, _fs[key]);
  }
} // handle sync for event loop.
*/
