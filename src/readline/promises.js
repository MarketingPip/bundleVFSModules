/**
 * readline/promises shim
 * Node.js parity: node:readline/promises @ Node 17+
 * Wraps the callback-based readline shim with promise/async-iterator APIs.
 */
import readline from '../readline.js';

// ─── AbortError ──────────────────────────────────────────────────────────────

export class AbortError extends Error {
  constructor(message = 'The operation was aborted', options = {}) {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _addAbortListener(signal, listener) {
  signal.addEventListener('abort', listener, { once: true });
  return { [Symbol.dispose]: () => signal.removeEventListener('abort', listener) };
}

function _resolveOpts(inputOrOpts, output, terminal) {
  if (
    inputOrOpts !== null &&
    typeof inputOrOpts === 'object' &&
    typeof inputOrOpts.read !== 'function'
  ) {
    return inputOrOpts;
  }
  return { input: inputOrOpts, output, terminal };
}

// ─── Interface ───────────────────────────────────────────────────────────────

export class Interface {
  constructor(inputOrOpts, output, completer, terminal) {
    const opts = _resolveOpts(inputOrOpts, output, terminal);
    this._iface = readline.createInterface(opts);
    this._closed = false;
    this._iface.on('close', () => { this._closed = true; });
  }

  // ── EventEmitter forwarding ─────────────────────────────────────────────
  on(event, listener)             { this._iface.on(event, listener); return this; }
  once(event, listener)           { this._iface.once(event, listener); return this; }
  off(event, listener)            { this._iface.off(event, listener); return this; }
  removeListener(event, listener) { this._iface.removeListener(event, listener); return this; }
  emit(event, ...args)            { return this._iface.emit(event, ...args); }

  // ── Prompt ──────────────────────────────────────────────────────────────
  setPrompt(prompt) {
    this._iface.setPrompt(prompt);
    this._prompt = prompt;
  }

  /** Node 17+: returns the current prompt string. */
  getPrompt() {
    // The inner callback-based shim may not expose getPrompt — maintain our own copy.
    return typeof this._iface.getPrompt === 'function'
      ? this._iface.getPrompt()
      : (this._prompt ?? '');
  }

  prompt(preserveCursor) { this._iface.prompt(preserveCursor); }

  // ── Pause / resume ──────────────────────────────────────────────────────
  pause()  { this._iface.pause();  return this; }
  resume() { this._iface.resume(); return this; }

  // ── Close ───────────────────────────────────────────────────────────────
  close() { this._iface.close(); return this; }

  // ── Proxied properties ──────────────────────────────────────────────────
  get terminal() { return this._iface.terminal ?? false; }
  get line()     { return this._iface.line     ?? ''; }
  get cursor()   { return this._iface.cursor   ?? 0; }

  // ── question() ──────────────────────────────────────────────────────────
  /**
   * Writes query to output and resolves with the user's answer.
   * @param {string} query
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<string>}
   */
  question(query, options = {}) {
    if (this._closed) {
      return Promise.reject(new Error('readline Interface was closed'));
    }

    const { signal } = options;

    if (signal !== undefined) {
      if (!signal || typeof signal.addEventListener !== 'function') {
        throw new TypeError('options.signal must be an AbortSignal');
      }
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

      this._iface.question(query, answer => settle(resolve, answer));

      let abortHandle;
      if (signal) {
        abortHandle = _addAbortListener(signal, () =>
          settle(reject, new AbortError(undefined, { cause: signal.reason }))
        );
      }

      const onClose = () => settle(reject, new AbortError('readline was closed'));
      this._iface.once('close', onClose);

      function cleanup() {
        if (abortHandle) abortHandle[Symbol.dispose]();
        // remove close guard if we settled via answer or abort
        // (once listener removes itself only after firing, so explicitly remove)
      }
    });
  }

  // ── Async iterator ──────────────────────────────────────────────────────
  /**
   * Iterates over each line of input, including unterminated final lines.
   */
  [Symbol.asyncIterator]() {
    const iface = this._iface;

    // If the inner shim already implements asyncIterator, delegate to it.
    // This preserves any internal buffering/queueing the shim provides.
    if (typeof iface[Symbol.asyncIterator] === 'function') {
      const inner = iface[Symbol.asyncIterator]();
      return {
        next:   ()     => inner.next(),
        return: (value) => {
          iface.close();
          return inner.return
            ? inner.return(value)
            : Promise.resolve({ value, done: true });
        },
      };
    }

    // Fallback: build our own async queue over 'line' and 'close' events,
    // plus a final flush of any unterminated buffered line at EOF.
    const queue   = [];
    let   done    = false;
    let   waiting = null; // resolve fn of the consumer's pending next() call

    const push = (value) => {
      if (waiting) { const r = waiting; waiting = null; r({ value, done: false }); }
      else queue.push(value);
    };

    iface.on('line', push);
    iface.once('close', () => {
      // Flush any final unterminated line buffered inside the inner shim.
      const tail = iface.line;
      if (tail) push(tail);
      done = true;
      if (waiting) { const r = waiting; waiting = null; r({ value: undefined, done: true }); }
    });

    return {
      next() {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (done)         return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => { waiting = resolve; });
      },
      return(value) {
        iface.close();
        return Promise.resolve({ value, done: true });
      },
    };
  }
}

// ─── Readline (output-mutation controller) ────────────────────────────────────

/**
 * Mirrors Node's `readline.Readline` class (Node 17+).
 * Queues cursor/clear operations on a stream and flushes them with commit().
 */
export class Readline {
  #stream;
  #queue = [];

  constructor(stream) {
    this.#stream = stream;
  }

  /**
   * Queue a clearLine operation.
   * @param {-1|0|1} dir  -1=left, 0=whole, 1=right
   * @returns {this}
   */
  clearLine(dir) {
    this.#queue.push({ op: 'clearLine', dir });
    return this;
  }

  /**
   * Queue a clearScreenDown operation.
   * @returns {this}
   */
  clearScreenDown() {
    this.#queue.push({ op: 'clearScreenDown' });
    return this;
  }

  /**
   * Queue a moveCursor operation.
   * @param {number} dx
   * @param {number} dy
   * @returns {this}
   */
  moveCursor(dx, dy) {
    this.#queue.push({ op: 'moveCursor', dx, dy });
    return this;
  }

  /**
   * Flush all queued operations to the stream.
   * @returns {Promise<void>}
   */
  commit() {
    const stream = this.#stream?._iface
      ? this.#stream._iface         // Interface wrapper → inner iface
      : this.#stream;               // raw stream / output

    // Get the underlying output stream if available
    const out = stream?.output ?? stream;

    const ops = this.#queue.splice(0);
    if (!out || typeof out.write !== 'function') return Promise.resolve();

    return new Promise((resolve, reject) => {
      let pending = ops.length;
      if (!pending) return resolve();
      for (const { op, dir, dx, dy } of ops) {
        if (op === 'clearLine') {
          // ANSI: \x1b[<n>K — 0=to-end, 1=to-start, 2=whole
          const code = dir === -1 ? 1 : dir === 1 ? 0 : 2;
          out.write(`\x1b[${code}K`, done);
        } else if (op === 'clearScreenDown') {
          out.write('\x1b[0J', done);
        } else if (op === 'moveCursor') {
          let seq = '';
          if (dx > 0)  seq += `\x1b[${dx}C`;
          else if (dx < 0) seq += `\x1b[${-dx}D`;
          if (dy > 0)  seq += `\x1b[${dy}B`;
          else if (dy < 0) seq += `\x1b[${-dy}A`;
          if (seq) out.write(seq, done);
          else done();
        } else {
          done();
        }
      }
      function done(err) {
        if (err) { reject(err); return; }
        if (--pending === 0) resolve();
      }
    });
  }

  /**
   * Discard all queued operations without writing them.
   * @returns {this}
   */
  rollback() {
    this.#queue = [];
    return this;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createInterface(inputOrOpts, output, completer, terminal) {
  return new Interface(inputOrOpts, output, completer, terminal);
}

export default { Interface, createInterface, Readline, AbortError };
