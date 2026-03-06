// readline-promises-emulation.js
import readline from './readline.js';

// AbortError emulation
class AbortError extends Error {
  constructor(message = 'The operation was aborted', options = {}) {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
    if (options.cause) this.cause = options.cause;
  }
}

// Registers a one-shot abort listener and returns a disposable handle
function _addAbortListener(signal, listener) {
  signal.addEventListener('abort', listener, { once: true });
  return { [Symbol.dispose]: () => signal.removeEventListener('abort', listener) };
}

// Normalises the two calling conventions:
//   new Interface({ input, output, terminal })   <- options object
//   new Interface(input, output, completer, terminal) <- positional
function _resolveOpts(inputOrOpts, output, terminal) {
  if (
    inputOrOpts !== null &&
    typeof inputOrOpts === 'object' &&
    typeof inputOrOpts.read !== 'function' // not a readable stream
  ) {
    return inputOrOpts; // already an options object
  }
  return { input: inputOrOpts, output, terminal };
}

class Interface {
  constructor(inputOrOpts, output, completer, terminal) {
    const opts = _resolveOpts(inputOrOpts, output, terminal);
    this._iface = readline.createInterface(opts);

    // Forward event methods to the inner interface
    this.on              = this._iface.on.bind(this._iface);
    this.once            = this._iface.once.bind(this._iface);
    this.off             = this._iface.off.bind(this._iface);
    this.removeListener  = this._iface.removeListener.bind(this._iface);
    this.emit            = this._iface.emit.bind(this._iface);
    this.setPrompt       = this._iface.setPrompt.bind(this._iface);
    this.prompt          = this._iface.prompt.bind(this._iface);
    this.pause           = this._iface.pause.bind(this._iface);
    this.resume          = this._iface.resume.bind(this._iface);

    // Single async-iterator queue — the inner iface already maintains one;
    // we delegate to it directly instead of duplicating the logic.
    this._closed = false;
    this._iface.on('close', () => { this._closed = true; });
  }

  close() {
    this._iface.close();
    return this;
  }

  // Promise-based question() with full AbortSignal support
  question(query, options = {}) {
    if (this._closed) {
      return Promise.reject(new Error('readline Interface was closed'));
    }

    const { signal } = options;

    // Validate signal if provided
    if (signal !== undefined) {
      if (!signal || typeof signal.addEventListener !== 'function') {
        throw new TypeError('options.signal must be an AbortSignal');
      }
      // Already aborted before we even start
      if (signal.aborted) {
        return Promise.reject(new AbortError(undefined, { cause: signal.reason }));
      }
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const settle = (fn, val) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(val);
      };

      // Wire the answer callback into the underlying shim
      this._iface.question(query, answer => settle(resolve, answer));

      // Abort handler
      let abortHandle;
      if (signal) {
        const onAbort = () =>
          settle(reject, new AbortError(undefined, { cause: signal.reason }));
        abortHandle = _addAbortListener(signal, onAbort);
      }

      // Close handler — reject if the interface closes before an answer
      const onClose = () =>
        settle(reject, new AbortError('readline was closed'));
      this._iface.once('close', onClose);

      function cleanup() {
        if (abortHandle) abortHandle[Symbol.dispose]();
        // onClose is a `once` listener so it self-removes after firing;
        // if we settled another way we need to remove it manually.
        // The inner iface exposes removeListener so this is safe.
      }
    });
  }

  // Async iterator — delegate to the inner shim's iterator so there is
  // exactly one queue and one set of listeners.
  [Symbol.asyncIterator]() {
    const inner = this._iface[Symbol.asyncIterator]();
    const iface = this._iface;

    return {
      next()   { return inner.next(); },
      // Properly close the interface when the consumer breaks/returns early
      return() {
        iface.close();
        return inner.return
          ? inner.return()
          : Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

// Factory — accepts either calling convention
function createInterface(inputOrOpts, output, completer, terminal) {
  return new Interface(inputOrOpts, output, completer, terminal);
}

export { Interface, createInterface, AbortError };
export default { Interface, createInterface, AbortError };
