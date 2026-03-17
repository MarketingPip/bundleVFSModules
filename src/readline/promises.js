// readline/promises.js

/*!
 * readline/promises — node:readline/promises for browsers & bundlers
 * MIT License.
 * Node.js parity: node:readline/promises @ Node 17.0.0+
 * Dependencies: (readline/interface.js, readline/utils.js)
 * Limitations: Same as readline/interface.js.
 */

import {
  Interface as _Interface,
  InterfaceConstructor,
  kQuestion,
  kQuestionCancel,
} from './interface.js';

import { CSI } from './utils.js';

// ---------------------------------------------------------------------------
// AbortError  (mirrors Node's internal AbortError)
// ---------------------------------------------------------------------------

export class AbortError extends Error {
  /**
   * @param {string} [message]
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message = 'The operation was aborted', options = {}) {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function _addAbortListener(signal, listener) {
  signal.addEventListener('abort', listener, { once: true });
  return { [Symbol.dispose]: () => signal.removeEventListener('abort', listener) };
}

// ---------------------------------------------------------------------------
// readlinePromises.Interface
// ---------------------------------------------------------------------------

/**
 * Promise-based readline Interface.
 *
 * Extends the shared `Interface` base from `readline/interface.js`, overriding
 * only `question()` to return a Promise and reject with `AbortError` on abort
 * or interface close — matching Node's `readlinePromises.Interface` exactly.
 *
 * @extends {_Interface}
 */
export class Interface extends _Interface {
  /**
   * Displays `query` on `output` and returns a Promise that resolves with the
   * user's answer.  Rejects with `AbortError` if the signal fires or the
   * interface is closed before an answer arrives.
   *
   * @param {string} query
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<string>}
   *
   * @example
   * const rl = createInterface({ input, output })
   * const answer = await rl.question('Name? ')
   * rl.close()
   */
  question(query, options = {}) {
    if (this.closed)
      return Promise.reject(new Error('readline Interface was closed'));

    const { signal } = options;

    if (signal !== undefined) {
      if (!signal || typeof signal.addEventListener !== 'function')
        throw new TypeError('options.signal must be an AbortSignal');
      if (signal.aborted)
        return Promise.reject(new AbortError(undefined, { cause: signal.reason }));
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const settle = (fn, val) => {
        if (settled) return;
        settled = true;
        abortHandle?.[Symbol.dispose]();
        fn(val);
      };

      // kQuestion installs the one-time line callback and writes the prompt
      this[kQuestion](query, answer => settle(resolve, answer));

      // Reject if the interface is closed while the question is pending
      const onClose = () =>
        settle(reject, new AbortError('readline was closed'));
      this.once('close', onClose);

      // Remove the close listener once we settle normally
      const origSettle = settle;
      // Wrap resolve path to clean up the close listener too
      this[Symbol.for('rl.questionCleanup')] = () => {
        this.off('close', onClose);
      };

      let abortHandle;
      if (signal) {
        abortHandle = _addAbortListener(signal, () => {
          this[kQuestionCancel]();
          settle(reject, new AbortError(undefined, { cause: signal.reason }));
        });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// readlinePromises.createInterface
// ---------------------------------------------------------------------------

/**
 * Creates a promise-based `readlinePromises.Interface`.
 *
 * @param {object | import('stream').Readable} inputOrOpts
 * @param {import('stream').Writable} [output]
 * @param {Function} [completer]
 * @param {boolean} [terminal]
 * @returns {Interface}
 */
export function createInterface(inputOrOpts, output, completer, terminal) {
  return new Interface(inputOrOpts, output, completer, terminal);
}

// ---------------------------------------------------------------------------
// readlinePromises.Readline — batched ANSI cursor-control builder
// Mirrors Node's internal Readline class exactly.
// ---------------------------------------------------------------------------

/**
 * Queues ANSI cursor-control sequences and flushes them atomically via
 * `commit()`, or immediately when `autoCommit: true`.
 *
 * @example
 * const rl = new Readline(outputStream, { autoCommit: false })
 * rl.cursorTo(0).clearLine(0).moveCursor(0, -1)
 * await rl.commit()
 */
export class Readline {
  #autoCommit = false;
  /** @type {import('stream').Writable} */ #stream;
  /** @type {string[]} */ #todo = [];

  /**
   * @param {import('stream').Writable} stream  A TTY-like Writable stream.
   * @param {{ autoCommit?: boolean }} [options]
   */
  constructor(stream, options = undefined) {
    if (!stream || typeof stream.write !== 'function')
      throw new TypeError('"stream" argument must be a Writable stream');
    this.#stream = stream;
    if (options?.autoCommit != null) {
      if (typeof options.autoCommit !== 'boolean')
        throw new TypeError('"options.autoCommit" must be a boolean');
      this.#autoCommit = options.autoCommit;
    }
  }

  /**
   * Queues a cursor absolute-position move.
   * @param {number} x  0-based column.
   * @param {number} [y]  0-based row.
   * @returns {this}
   */
  cursorTo(x, y = undefined) {
    _assertInt(x, 'x');
    if (y != null) _assertInt(y, 'y');
    this.#push(y == null ? CSI`${x + 1}G` : CSI`${y + 1};${x + 1}H`);
    return this;
  }

  /**
   * Queues a cursor relative move.
   * @param {number} dx @param {number} dy
   * @returns {this}
   */
  moveCursor(dx, dy) {
    if (dx || dy) {
      _assertInt(dx, 'dx');
      _assertInt(dy, 'dy');
      let data = '';
      if (dx < 0) data += CSI`${-dx}D`; else if (dx > 0) data += CSI`${dx}C`;
      if (dy < 0) data += CSI`${-dy}A`; else if (dy > 0) data += CSI`${dy}B`;
      this.#push(data);
    }
    return this;
  }

  /**
   * Queues a clear-line action.
   * @param {-1|0|1} dir  -1 = left, 0 = whole line, 1 = right.
   * @returns {this}
   */
  clearLine(dir) {
    _assertInt(dir, 'dir', -1, 1);
    this.#push(
      dir < 0 ? CSI.kClearToLineBeginning
      : dir > 0 ? CSI.kClearToLineEnd
      : CSI.kClearLine
    );
    return this;
  }

  /** @returns {this} */
  clearScreenDown() {
    this.#push(CSI.kClearScreenDown);
    return this;
  }

  /**
   * Flushes all queued actions to the stream atomically.
   * @returns {Promise<void>}
   */
  commit() {
    return new Promise(resolve => {
      this.#stream.write(this.#todo.join(''), resolve);
      this.#todo = [];
    });
  }

  /**
   * Discards all queued actions without writing.
   * @returns {this}
   */
  rollback() {
    this.#todo = [];
    return this;
  }

  /** @param {string} data */
  #push(data) {
    if (this.#autoCommit) globalThis.setTimeout(() => this.#stream.write(data), 0);
    else this.#todo.push(data);
  }
}

// ---------------------------------------------------------------------------
// Private validation helper (local copy — avoids circular dep with utils.js)
// ---------------------------------------------------------------------------

function _assertInt(v, name, min = -Infinity, max = Infinity) {
  if (!Number.isInteger(v) || v < min || v > max)
    throw new TypeError(
      `"${name}" must be an integer` +
      (min !== -Infinity ? ` [${min}..${max}]` : '') +
      `, got ${v}`
    );
}

export default { Interface, createInterface, Readline, AbortError };
