import process from "./process.js";
import Buffer from "./buffer.js";
import { clearImmediate, setImmediate } from "./timers.js";
//globalThis.process = process;
globalThis.Buffer = Buffer.Buffer;
globalThis.clearImmediate = clearImmediate;
globalThis.setImmediate = setImmediate;

// Node.js `global` alias: bundlers and frameworks (Vite, Vitest) reference
// the bare `global` identifier. In a browser realm it does not exist, so
// install it as an alias of globalThis — exactly like Node, where
// global === globalThis. Guarded so a host-provided value is never clobbered.
if (typeof globalThis.global === "undefined") {
  globalThis.global = globalThis;
}

if (typeof globalThis.queueMicrotask !== "function") {
  globalThis.queueMicrotask = function (callback) {
    if (typeof callback !== "function") {
      throw new TypeError("queueMicrotask must be called with a function");
    }

    Promise.resolve()
      .then(callback)
      .catch((error) => {
        // Re-throw errors globally so they aren't silently swallowed
        setTimeout(() => {
          throw error;
        }, 0);
      });
  };
}
