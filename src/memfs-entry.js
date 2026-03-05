import { vol, promises, constants, fs as memfsFs } from "memfs";
import { createFsFromVolume } from "memfs";

const fs = createFsFromVolume(vol);
fs.promises = promises;
fs.constants = constants;
fs._vol = vol;

// ── Node-compatible error factory ─────────────────────────────────────────────
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
  // Match Node's formatted name visible in stack traces
  Object.defineProperty(err, "name", {
    value: "TypeError [ERR_INVALID_ARG_TYPE]",
    writable: true,
    configurable: true,
  });
  return err;
}

// ── Classify methods ───────────────────────────────────────────────────────────
// These fs methods either return a stream/watcher (not callback-based)
// or accept an optional listener rather than a required error-first callback.
const STREAM_OR_WATCHER = new Set([
  "createReadStream",
  "createWriteStream",
  "watch",        // listener is optional; returns FSWatcher
  "unwatchFile",  // no callback at all
]);

// Determines whether `key` is a callback-async method that *requires* its
// last argument to be a function, matching Node's maybeCallback guard.
function requiresCallback(key) {
  if (key.endsWith("Sync")) return false;          // sync variants never take a cb
  if (STREAM_OR_WATCHER.has(key)) return false;    // stream/watcher factories
  return true;
}

// ── Monkey-patch ──────────────────────────────────────────────────────────────
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
        // Node throws synchronously before touching the FS at all
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

// ── Patch fs.promises (Promise-based, no callbacks) ───────────────────────────
for (const key of Object.keys(promises)) {
  const original = promises[key];
  if (typeof original !== "function") continue;

  fs.promises[key] = async function (...args) {
    const result = await original.apply(this, args);
    if (typeof globalThis.emitMe === "function") {
      globalThis.emitMe("fs", `promises.${key}`, ...args, result);
    }
    return result;
  };

  Object.defineProperty(fs.promises[key], "name", { value: key });
}

// ─────────────────────────────────────────────────────────────────────────────
export default fs;
export { fs, promises, constants, vol };
