import { vol, promises, constants, fs as memfsFs } from "memfs";
import { createFsFromVolume } from "memfs";

// Create a Node-like fs object from the memfs volume
const fs = createFsFromVolume(vol);

// Attach the promises API (exact Node-style)
fs.promises = promises;
// Also attach constants (Node-style)
fs.constants = constants;
fs._vol = vol;

// ── Monkey-patch ──────────────────────────────────────────────────────────────
// Wrap every enumerable function on `fs` so that after the call completes
// globalThis.emitMe("fs", methodName, ...args, result) is fired.
// Async (callback-style) methods are detected by checking whether the last
// argument supplied by the caller is a function; in that case we wrap the
// callback so we can capture the result before forwarding it.

const SKIP = new Set(["promises", "constants", "_vol"]);

for (const key of Object.keys(fs)) {
  if (SKIP.has(key)) continue;

  const original = fs[key];
  if (typeof original !== "function") continue;

  fs[key] = function (...args) {
    const emit = (result) => {
      if (typeof globalThis.emitMe === "function") {
        globalThis.emitMe("fs", key, ...args, result);
      }
    };

    // Detect callback-style async call: last arg is a function
    const lastArg = args[args.length - 1];
    if (typeof lastArg === "function") {
      // Replace the callback with a wrapper that emits then forwards
      const originalCb = lastArg;
      args[args.length - 1] = function (...cbArgs) {
        // cbArgs[0] is the error (if any); cbArgs[1] is the result
        emit(cbArgs[1]);
        return originalCb.apply(this, cbArgs);
      };
      return original.apply(this, args);
    }

    // Synchronous call
    const result = original.apply(this, args);

    // If the return value is a Promise (e.g. someone called a *Sync variant
    // that happens to return a thenable), handle both cases gracefully
    if (result && typeof result.then === "function") {
      return result.then(
        (val) => { emit(val); return val; },
        (err) => { emit(undefined); return Promise.reject(err); }
      );
    }

    emit(result);
    return result;
  };

  // Preserve the original function's name for stack traces
  Object.defineProperty(fs[key], "name", { value: key });
}

// Also patch fs.promises (returns Promises, no callbacks)
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
