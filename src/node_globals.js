import process from './process.js';
import Buffer from './buffer.js';
import {clearImmediate, setImmediate} from './timers.js';
globalThis.process = process;
globalThis.Buffer = Buffer;
globalThis.clearImmediate = clearImmediate;
globalThis.setImmediate = setImmediate;
 
if (typeof globalThis.queueMicrotask !== 'function') {
  globalThis.queueMicrotask = function (callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('queueMicrotask must be called with a function');
    }

    Promise.resolve()
      .then(callback)
      .catch(error => {
        // Re-throw errors globally so they aren't silently swallowed
        setTimeout(() => {
          throw error;
        }, 0);
      });
  };
}
