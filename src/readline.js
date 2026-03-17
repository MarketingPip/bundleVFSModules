// readline.js
// npm install events readable-stream string_decoder

/*!
 * readline — node:readline public facade for browsers & bundlers
 * MIT License.
 * Node.js parity: node:readline @ Node 0.1.98+ (callback API)
 *                 node:readline/promises @ Node 17.0.0+ (via `promises` export)
 * Dependencies: events, readable-stream, string_decoder
 * Limitations:
 *   - emitKeypressEvents() requires the caller to supply raw-character input
 *     (no kernel TTY in browsers).
 *   - SIGINT / SIGTSTP / SIGCONT events depend on the host feeding Ctrl+C /
 *     Ctrl+Z sequences through the input stream.
 *   - kSetRawMode is a no-op.
 */

import {
  Interface as _Interface,
  InterfaceConstructor,
  kAddHistory,
  kDecoder,
  kDeleteLeft,
  kDeleteLineLeft,
  kDeleteLineRight,
  kDeleteRight,
  kDeleteWordLeft,
  kDeleteWordRight,
  kGetDisplayPos,
  kHistoryNext,
  kHistoryPrev,
  kInsertString,
  kLine,
  kLine_buffer,
  kMoveCursor,
  kNormalWrite,
  kOldPrompt,
  kOnLine,
  kPreviousKey,
  kPrompt,
  kQuestion,
  kQuestionCallback,
  kQuestionCancel,
  kRefreshLine,
  kSawKeyPress,
  kSawReturnAt,
  kSetRawMode,
  kTabComplete,
  kTabCompleter,
  kTtyWrite,
  kWordLeft,
  kWordRight,
  kWriteToOutput,
} from './readline/interface.js';

import { CSI } from './readline/utils.js';
import emitKeypressEvents from './readline/emitKeypressEvents.js';
import promises, { AbortError } from './readline/promises.js';

const { kClearLine, kClearScreenDown, kClearToLineBeginning, kClearToLineEnd } = CSI;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _addAbortListener(signal, listener) {
  signal.addEventListener('abort', listener, { once: true });
  return { [Symbol.dispose]: () => signal.removeEventListener('abort', listener) };
}

function _resolveOpts(inputOrOpts, output, completer, terminal) {
  if (
    inputOrOpts !== null &&
    typeof inputOrOpts === 'object' &&
    typeof inputOrOpts.read !== 'function'
  ) return inputOrOpts;
  return { input: inputOrOpts, output, completer, terminal };
}

// ---------------------------------------------------------------------------
// readline.Interface  — callback API
//
// Extends the shared InterfaceConstructor with a callback-flavoured question()
// that matches Node's readline.Interface exactly, including the promisify.custom
// symbol so util.promisify(rl.question) works.
// ---------------------------------------------------------------------------

/**
 * Callback-based readline Interface (`node:readline`).
 *
 * @extends {_Interface}
 */
export class Interface extends _Interface {
  constructor(input, output, completer, terminal) {
    // Node wraps single-arg completers to two-arg form
    const opts = _resolveOpts(input, output, completer, terminal);
    if (opts.completer && typeof opts.completer === 'function' && opts.completer.length !== 2) {
      const orig = opts.completer;
      opts.completer = (v, cb) => cb(null, orig(v));
    } else if (typeof completer === 'function' && completer.length !== 2) {
      const orig = completer;
      completer = (v, cb) => cb(null, orig(v));
    }
    super(opts);
  }

  /**
   * Displays `query` by writing it to `output`.
   * Invokes `cb(answer)` when a line of input is received.
   *
   * NOTE: the callback is NOT err-first — it receives the answer string only.
   *
   * @param {string} query
   * @param {{ signal?: AbortSignal } | ((answer: string) => void)} [options]
   * @param {(answer: string) => void} [cb]
   */
  question(query, options, cb) {
    // Normalise overloads
    if (typeof options === 'function') { cb = options; options = {}; }
    if (options === null || typeof options !== 'object') options = {};

    const { signal } = options;

    if (signal) {
      if (signal.aborted) return;               // Node silently returns

      const onAbort = () => this[kQuestionCancel]();
      const disposable = _addAbortListener(signal, onAbort);

      const originalCb = cb;
      cb = typeof cb === 'function'
        ? answer => { disposable[Symbol.dispose](); originalCb(answer); }
        : () => disposable[Symbol.dispose]();
    }

    if (typeof cb === 'function') {
      this[kQuestion](query, cb);
    }
  }
}

// Attach promisify.custom so util.promisify(rl.question) → Promise<string>
Interface.prototype.question[Symbol.for('nodejs.util.promisify.custom')] =
  function question(query, options) {
    if (options === null || typeof options !== 'object') options = {};

    if (options.signal?.aborted)
      return Promise.reject(new AbortError(undefined, { cause: options.signal.reason }));

    return new Promise((resolve, reject) => {
      let cb = resolve;

      if (options.signal) {
        const onAbort = () =>
          reject(new AbortError(undefined, { cause: options.signal.reason }));
        const disposable = _addAbortListener(options.signal, onAbort);
        cb = answer => { disposable[Symbol.dispose](); resolve(answer); };
      }

      this.question(query, options, cb);
    });
  };

// Re-expose symbol-keyed internals as underscore methods for backward compat
// (matches Node's ObjectDefineProperties block in readline.js).
Object.defineProperties(Interface.prototype, {
  _setRawMode:      { get() { return this[kSetRawMode]; } },
  _onLine:          { get() { return this[kOnLine]; } },
  _writeToOutput:   { get() { return this[kWriteToOutput]; } },
  _addHistory:      { get() { return this[kAddHistory]; } },
  _refreshLine:     { get() { return this[kRefreshLine]; } },
  _normalWrite:     { get() { return this[kNormalWrite]; } },
  _insertString:    { get() { return this[kInsertString]; } },
  _wordLeft:        { get() { return this[kWordLeft]; } },
  _wordRight:       { get() { return this[kWordRight]; } },
  _deleteLeft:      { get() { return this[kDeleteLeft]; } },
  _deleteRight:     { get() { return this[kDeleteRight]; } },
  _deleteWordLeft:  { get() { return this[kDeleteWordLeft]; } },
  _deleteWordRight: { get() { return this[kDeleteWordRight]; } },
  _deleteLineLeft:  { get() { return this[kDeleteLineLeft]; } },
  _deleteLineRight: { get() { return this[kDeleteLineRight]; } },
  _line:            { get() { return this[kLine]; } },
  _historyNext:     { get() { return this[kHistoryNext]; } },
  _historyPrev:     { get() { return this[kHistoryPrev]; } },
  _getDisplayPos:   { get() { return this[kGetDisplayPos]; } },
  _getCursorPos:    { get() { return this.getCursorPos; } },
  _moveCursor:      { get() { return this[kMoveCursor]; } },
  _ttyWrite:        { get() { return this[kTtyWrite]; } },

  // Internal state proxy accessors
  _decoder: {
    get()      { return this[kDecoder]; },
    set(value) { this[kDecoder] = value; },
  },
  _line_buffer: {
    get()      { return this[kLine_buffer]; },
    set(value) { this[kLine_buffer] = value; },
  },
  _oldPrompt: {
    get()      { return this[kOldPrompt]; },
    set(value) { this[kOldPrompt] = value; },
  },
  _previousKey: {
    get()      { return this[kPreviousKey]; },
    set(value) { this[kPreviousKey] = value; },
  },
  _prompt: {
    get()      { return this[kPrompt]; },
    set(value) { this[kPrompt] = value; },
  },
  _questionCallback: {
    get()      { return this[kQuestionCallback]; },
    set(value) { this[kQuestionCallback] = value; },
  },
  _sawKeyPress: {
    get()      { return this[kSawKeyPress]; },
    set(value) { this[kSawKeyPress] = value; },
  },
  _sawReturnAt: {
    get()      { return this[kSawReturnAt]; },
    set(value) { this[kSawReturnAt] = value; },
  },
});

// Also promote as direct prototype methods for older code that calls them
// as rl._ttyWrite(s, key) etc.
Interface.prototype._tabComplete = function(lastKeypressWasTab) {
  // Override parent because legacy completer is callback-based, not async.
  this.pause();
  const str = this.line.slice(0, this.cursor);
  this.completer(str, (err, value) => {
    this.resume();
    if (err) { this[kWriteToOutput](`Tab completion error: ${err}\n`); return; }
    this[kTabCompleter](lastKeypressWasTab, value);
  });
};

// ---------------------------------------------------------------------------
// Standalone cursor-control helpers  (node:readline top-level exports)
// These exactly mirror Node's internal/readline/callbacks.js functions.
// ---------------------------------------------------------------------------

/**
 * Moves cursor to absolute (x, y) in `stream`.
 * @param {import('stream').Writable} stream
 * @param {number} x  0-based column.
 * @param {number|(() => void)} [y]  0-based row.
 * @param {() => void} [callback]
 * @returns {boolean}
 */
export function cursorTo(stream, x, y, callback) {
  if (typeof y === 'function') { callback = y; y = undefined; }
  if (stream == null || (typeof x !== 'number' && typeof y !== 'number')) {
    if (typeof callback === 'function') globalThis.setTimeout(() => callback(null), 0);
    return true;
  }
  if (isNaN(x)) throw new TypeError(`The "x" argument is invalid. Received ${x}`);
  if (y !== undefined && isNaN(y)) throw new TypeError(`The "y" argument is invalid. Received ${y}`);
  const data = typeof y !== 'number' ? CSI`${x + 1}G` : CSI`${y + 1};${x + 1}H`;
  return stream.write(data, callback);
}

/**
 * Moves cursor by (dx, dy) relative to current position in `stream`.
 * @param {import('stream').Writable} stream
 * @param {number} dx @param {number} dy
 * @param {() => void} [callback]
 * @returns {boolean}
 */
export function moveCursor(stream, dx, dy, callback) {
  if (stream == null || !(dx || dy)) {
    if (typeof callback === 'function') globalThis.setTimeout(() => callback(null), 0);
    return true;
  }
  let data = '';
  if (dx < 0) data += CSI`${-dx}D`; else if (dx > 0) data += CSI`${dx}C`;
  if (dy < 0) data += CSI`${-dy}A`; else if (dy > 0) data += CSI`${dy}B`;
  return stream.write(data, callback);
}

/**
 * Clears the current line of `stream` in direction `dir`.
 * @param {import('stream').Writable} stream
 * @param {-1|0|1} dir
 * @param {() => void} [callback]
 * @returns {boolean}
 */
export function clearLine(stream, dir, callback) {
  if (stream == null) {
    if (typeof callback === 'function') globalThis.setTimeout(() => callback(null), 0);
    return true;
  }
  const type = dir < 0 ? kClearToLineBeginning : dir > 0 ? kClearToLineEnd : kClearLine;
  return stream.write(type, callback);
}

/**
 * Clears `stream` from cursor position downward.
 * @param {import('stream').Writable} stream
 * @param {() => void} [callback]
 * @returns {boolean}
 */
export function clearScreenDown(stream, callback) {
  if (stream == null) {
    if (typeof callback === 'function') globalThis.setTimeout(() => callback(null), 0);
    return true;
  }
  return stream.write(kClearScreenDown, callback);
}

// ---------------------------------------------------------------------------
// createInterface
// ---------------------------------------------------------------------------

/**
 * Creates a callback-based `readline.Interface`.
 *
 * @param {object | import('stream').Readable} input
 * @param {import('stream').Writable} [output]
 * @param {Function} [completer]
 * @param {boolean} [terminal]
 * @returns {Interface}
 */
export function createInterface(input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal);
}

// ---------------------------------------------------------------------------
// Default + named exports — matches node:readline module shape
// ---------------------------------------------------------------------------

export { emitKeypressEvents, promises, AbortError, InterfaceConstructor };
export { _Interface as BaseInterface };

export default {
  Interface,
  InterfaceConstructor,
  createInterface,
  cursorTo,
  moveCursor,
  clearLine,
  clearScreenDown,
  emitKeypressEvents,
  promises,
  AbortError,
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// ── Callback API ──────────────────────────────────────────────────────────────
// import readline from './readline.js'
// import { PassThrough } from 'readable-stream'
//
// const input = new PassThrough()
// const rl = readline.createInterface({ input, prompt: '> ' })
// rl.on('line',  line => console.log('Got:', line))
// rl.on('close', ()   => console.log('Done'))
// input.write('hello\r\nworld\n')
// input.end()
// // → Got: hello  /  Got: world  /  Done
//
// ── question() callback style ─────────────────────────────────────────────────
// rl.question('Name? ', answer => { console.log('Hi,', answer); rl.close() })
// input.write('Alice\n')
//
// ── AbortSignal on question ───────────────────────────────────────────────────
// const ac = new AbortController()
// setTimeout(() => ac.abort(), 3000)
// rl.question('Quick! ', { signal: ac.signal }, answer => console.log(answer))
//
// ── Promises API ──────────────────────────────────────────────────────────────
// import { promises as rlp } from './readline.js'
// const rl2 = rlp.createInterface({ input: new PassThrough(), output: new PassThrough() })
// const name = await rl2.question('Name? ')
// rl2.close()
//
// ── for await…of ──────────────────────────────────────────────────────────────
// for await (const line of rl) {
//   if (line === 'quit') break   // rl.close() called automatically
// }
//
// ── Readline cursor builder ───────────────────────────────────────────────────
// const { Readline } = readline.promises
// const rc = new Readline(outputStream, { autoCommit: false })
// rc.cursorTo(0).clearLine(0).moveCursor(0, -1)
// await rc.commit()
//
// ── emitKeypressEvents (with raw character feed) ──────────────────────────────
// import { emitKeypressEvents } from './readline.js'
// const rawInput = new PassThrough()
// emitKeypressEvents(rawInput)
// rawInput.on('keypress', (ch, key) => console.log(key))
// rawInput.write('\x1b[A')   // → { name: 'up', ctrl: false, … }
