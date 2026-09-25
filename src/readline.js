// @ts-self-types="./readline.d.ts"
/**
 * readline shim for browser / edge / bundler environments.
 * Mirrors the Node.js `readline` module API surface.
 *
 * @module readline
 * @since Node.js v0.1.98
 */

// ─── Safe Noop Stream Fallback ───────────────────────────────────────────────
const noopStream = {
  write: () => {},
  on: () => {},
  once: () => {},
  off: () => {},
  removeListener: () => {},
  pause: () => {},
  resume: () => {},
  isTTY: false,
  columns: 80,
  rows: 24,
};

// ─── Interface class ────────────────────────────────────────────────────────

class Interface {
  // Public properties matching Node.js readline API surface
  input;
  output;
  
  #terminal;
  #promptStr;
  #closed = false;
  #lineBuffer = "";
  #crSeen = false;
  #pendingOps = null;
  #boundHandleChunk;
  #boundOnInputClose;
  #ev = Object.create(null);

  // async-iterator state
  #lineQueue = [];
  #lineResolve = null;
  #lineDone = false;

  constructor(options = {}) {
    const input  = options.input  || (typeof globalThis.process !== 'undefined' ? globalThis.process.stdin  : null) || noopStream;
    const output = options.output || (typeof globalThis.process !== 'undefined' ? globalThis.process.stdout : null) || noopStream;
    const terminal = options.terminal != null ? !!options.terminal : !!(output?.isTTY);

    this.input   = input;
    this.output  = output;
    this.#terminal = terminal;
    this.#promptStr = options.prompt ?? (terminal ? '> ' : '');

    // wire line/close to the async-iterator queues
    this.#_on('line', line => {
      if (this.#lineResolve) {
        const r = this.#lineResolve;
        this.#lineResolve = null;
        r({ value: line, done: false });
      } else {
        this.#lineQueue.push(line);
      }
    });
    this.#_on('close', () => {
      this.#lineDone = true;
      if (this.#lineResolve) {
        this.#lineResolve({ value: undefined, done: true });
        this.#lineResolve = null;
      }
    });

    this.#boundHandleChunk    = chunk => this.#handleChunk(chunk);
    this.#boundOnInputClose   = ()    => { if (!this.#closed) this.close(); };

    this.input?.on?.('data',  this.#boundHandleChunk);
    this.input?.on?.('close', this.#boundOnInputClose);
  }

  // ── private event helpers ──────────────────────────────────────────────

  #_on(ev, fn, once = false) {
    if (!this.#ev[ev]) this.#ev[ev] = [];
    this.#ev[ev].push({ fn, once });
  }

  #_off(ev, fn) {
    if (this.#ev[ev]) this.#ev[ev] = this.#ev[ev].filter(e => e.fn !== fn);
  }

  #_emit(ev, ...args) {
    const list = this.#ev[ev];
    if (!list) return false;
    const snap = [...list];
    this.#ev[ev] = list.filter(e => !e.once);
    for (const e of snap) e.fn(...args);
    return true;
  }

  #_listenerCount(ev) { return (this.#ev[ev] || []).length; }

  // ── input handling ────────────────────────────────────────────────────

  #handleChunk(chunk) {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    if (this.input?.isRaw || this.#terminal) {
      const line = str.replace(/[\r\n]+$/, '');
      if (line === '\u0003') { this.#_emit('SIGINT'); return; }
      this.#_emit('line', line);
    } else {
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '\r') { this.#crSeen = true;  this.#flushLine(); continue; }
        if (ch === '\n') { if (!this.#crSeen) this.#flushLine(); this.#crSeen = false; continue; }
        this.#crSeen = false;
        this.#lineBuffer += ch;
      }
    }
  }

  #flushLine() {
    const line = this.#lineBuffer;
    this.#lineBuffer = "";
    if (line === '\u0003') { this.#_emit('SIGINT'); return; }
    this.#_emit('line', line);
  }

  // ── public EventEmitter-like API ──────────────────────────────────────

  get terminal() { return this.#terminal; }

  /** Current line buffer contents (mirrors Node's `rl.line`). @since Node.js v0.1.98 */
  get line()   { return this.#lineBuffer; }
  /** Current cursor position within `rl.line`. @since Node.js v0.1.98 */
  get cursor() { return this.#lineBuffer.length; }

  on(ev, fn)             { this.#_on(ev, fn, false); return this; }
  once(ev, fn)           { this.#_on(ev, fn, true);  return this; }
  off(ev, fn)            { this.#_off(ev, fn);        return this; }
  removeListener(ev, fn) { this.#_off(ev, fn);        return this; }
  removeAllListeners(ev) {
    if (ev) delete this.#ev[ev];
    else Object.keys(this.#ev).forEach(k => delete this.#ev[k]);
    return this;
  }
  listenerCount(ev) { return this.#_listenerCount(ev); }
  emit(ev, ...a)    { return this.#_emit(ev, ...a); }

  // ── prompt / pause / resume / close ──────────────────────────────────

  setPrompt(str)         { this.#promptStr = str; return this; }
  getPrompt()            { return this.#promptStr; }
  prompt(/*preserveCursor*/) {
    if (this.output?.write) this.output.write(this.#promptStr);
    return this;
  }

  pause() {
    this.input?.pause?.();
    this.#_emit('pause');
    return this;
  }
  resume() {
    this.input?.resume?.();
    this.#_emit('resume');
    return this;
  }

  close() {
    if (this.#closed) return this;
    this.#closed = true;
    this.input?.removeListener?.('data', this.#boundHandleChunk);
    this.input?.removeListener?.('close', this.#boundOnInputClose);
    if (this.#lineBuffer.length) this.#flushLine();
    this.#_emit('close');
    return this;
  }

  write(data /*, key */) {
    if (this.#closed) return this;
    if (typeof data === 'string' && data.length)
      this.#_emit('line', data.replace(/[\r\n]+$/, ''));
    return this;
  }

  // ── cursor / screen helpers ──────────────────────────────────────────

  getCursorPos() {
    const columns = this.output?.columns || 80;
    const totalLength = this.#promptStr.length + this.#lineBuffer.length;
    const rows = Math.floor(totalLength / columns);
    const cols = totalLength % columns;
    return { rows, cols };
  }

  cursorTo(x, y, cb) {
    if (this.output) cursorTo(this.output, x, y, cb);
    return this;
  }

  moveCursor(dx, dy, cb) {
    if (this.output) moveCursor(this.output, dx, dy, cb);
    return this;
  }

  clearLine(dir, cb) {
    if (this.output) clearLine(this.output, dir, cb);
    return this;
  }

  clearScreenDown(cb) {
    if (this.output) clearScreenDown(this.output, cb);
    return this;
  }

  rollback() {
    this.#pendingOps = [];
    return this;
  }

  commit() {
    if (this.#pendingOps) {
      for (const op of this.#pendingOps) op();
      this.#pendingOps = null;
    }
    return this;
  }

  question(query, optionsOrCb, cb) {
    if (this.#closed) {
      return typeof cb === 'function' || typeof optionsOrCb === 'function'
        ? void 0
        : Promise.reject(new Error('readline was closed'));
    }

    let opts = {}, callback;
    if (typeof optionsOrCb === 'function') {
      callback = optionsOrCb;
    } else {
      opts = optionsOrCb || {};
      callback = cb;
    }

    if (this.output?.write) this.output.write(query);
    const signal = opts.signal;

    if (typeof callback === 'function') {
      let called = false;
      const onLine = answer => {
        if (called) return; called = true;
        this.#_off('line', onLine);
        callback(answer);
      };
      this.#_on('line', onLine);
      signal?.addEventListener('abort', () => {
        if (called) return; called = true;
        this.#_off('line', onLine);
      }, { once: true });
      return this;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const onLine = answer => {
        if (settled) return; settled = true;
        this.#_off('line', onLine);
        resolve(answer);
      };
      this.#_on('line', onLine);
      signal?.addEventListener('abort', () => {
        if (settled) return; settled = true;
        this.#_off('line', onLine);
        const err = new Error('The question was aborted');
        err.code = 'ABORT_ERR';
        reject(err);
      }, { once: true });
    });
  }

  [Symbol.asyncIterator]() {
    const self = this;
    return {
      next() {
        if (self.#lineQueue.length)
          return Promise.resolve({ value: self.#lineQueue.shift(), done: false });
        if (self.#lineDone)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise(res => { self.#lineResolve = res; });
      },
      return() {
        return Promise.resolve({ value: undefined, done: true });
      }
    };
  }
}

// ─── Module exports & Helpers (same as before) ──────────────────────────────
const Readline = Interface;

function createInterface(options = {}) {
  return new Interface(options);
}

function emitKeypressEvents(stream) {
  if (!stream || stream._keypressAttached) return;
  stream._keypressAttached = true;
}

function cursorTo(stream, x, y, cb) {
  const target = stream || noopStream;
  if (y == null) target.write(`\u001b[${x + 1}G`);
  else           target.write(`\u001b[${y + 1};${x + 1}H`);
  cb?.();
  return true;
}

function moveCursor(stream, dx, dy, cb) {
  const target = stream || noopStream;
  if (dx > 0) target.write(`\u001b[${dx}C`);
  if (dx < 0) target.write(`\u001b[${-dx}D`);
  if (dy > 0) target.write(`\u001b[${dy}B`);
  if (dy < 0) target.write(`\u001b[${-dy}A`);
  cb?.();
  return true;
}

function clearLine(stream, dir, cb) {
  const target = stream || noopStream;
  const code = dir === 0 ? 2 : dir === -1 ? 1 : 0;
  target.write(`\u001b[${code}K`);
  cb?.();
  return true;
}

function clearScreenDown(stream, cb) {
  const target = stream || noopStream;
  target.write('\u001b[0J');
  cb?.();
  return true;
}

const promises = {
  Interface,
  Readline,
  createInterface,
};

globalThis.readline = {
  createInterface,
  emitKeypressEvents,
  cursorTo,
  moveCursor,
  clearLine,
  clearScreenDown,
  Interface,
  Readline,
  promises,
};

export {
  createInterface,
  emitKeypressEvents,
  cursorTo,
  moveCursor,
  clearLine,
  clearScreenDown,
  Interface,
  Readline,
  promises,
};

export default {
  createInterface,
  emitKeypressEvents,
  cursorTo,
  moveCursor,
  clearLine,
  clearScreenDown,
  Interface,
  Readline,
  promises,
};
