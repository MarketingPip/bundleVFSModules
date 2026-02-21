// readline-promises-emulation.js
import readline from './readline.js';

// Internal symbols
const kQuestion = Symbol('kQuestion');
const kQuestionCancel = Symbol('kQuestionCancel');
const kQuestionReject = Symbol('kQuestionReject');

// AbortError emulation
class AbortError extends Error {
  constructor(message = 'The operation was aborted', options = {}) {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
    if (options.cause) this.cause = options.cause;
  }
}

// Abort signal validation
function _validateAbortSignal(signal, name = 'signal') {
  if (!signal || typeof signal.addEventListener !== 'function') {
    throw new TypeError(`${name} must be an AbortSignal`);
  }
}

// Internal addAbortListener
let addAbortListener;
function _addAbortListener(signal, listener) {
  signal.addEventListener('abort', listener, { once: true });
  return { [Symbol.dispose]: () => signal.removeEventListener('abort', listener) };
}

// Interface class
class Interface extends readline.createInterface().constructor {
  constructor(input, output, completer, terminal) {
    super({ input, output, terminal });

    this[kQuestion] = (query, cb) => super.question(query, cb);
    this[kQuestionCancel] = () => {}; // no-op for browser
    this[kQuestionReject] = null;

    // Async iterator support
    this._lineQueue = [];
    this._lineResolve = null;
    this._lineDone = false;

    this.on('line', (line) => {
      if (this._lineResolve) {
        const r = this._lineResolve;
        this._lineResolve = null;
        r({ value: line, done: false });
      } else {
        this._lineQueue.push(line);
      }
    });

    this.on('close', () => {
      this._lineDone = true;
      if (this._lineResolve) {
        this._lineResolve({ value: undefined, done: true });
        this._lineResolve = null;
      }
    });
  }

  // Promise-based question
  question(query, options = {}) {
    return new Promise((resolve, reject) => {
      let cb = resolve;

      if (options.signal) {
        _validateAbortSignal(options.signal, 'options.signal');
        if (options.signal.aborted) {
          return reject(new AbortError(undefined, { cause: options.signal.reason }));
        }

        const onAbort = () => {
          this[kQuestionCancel]();
          reject(new AbortError(undefined, { cause: options.signal.reason }));
        };

        addAbortListener ??= _addAbortListener;
        const disposable = addAbortListener(options.signal, onAbort);

        cb = (answer) => {
          disposable[Symbol.dispose]();
          resolve(answer);
        };
      }

      this[kQuestionReject] = reject;
      this[kQuestion](query, cb);
    });
  }

  // Async iterator
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this._lineQueue.length) {
          return Promise.resolve({ value: this._lineQueue.shift(), done: false });
        }
        if (this._lineDone) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((res) => {
          this._lineResolve = res;
        });
      },
      return: () => Promise.resolve({ value: undefined, done: true }),
    };
  }
}

// Factory
function createInterface(input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal);
}

export { Interface, createInterface, AbortError };
export default { Interface, createInterface, AbortError };
