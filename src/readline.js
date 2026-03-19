// readline-shim.js

// ─── AbortError ─────────────────────────────────────────────────────────────
class AbortError extends Error {
  constructor(message = 'The operation was aborted') {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
  }
}

// ─── Interface ──────────────────────────────────────────────────────────────
class Interface {
  constructor(options = {}) {
    const input = options.input || process.stdin;
    const output = options.output || process.stdout;
    this.terminal = options.terminal != null ? !!options.terminal : !!output.isTTY;

    this._ev = Object.create(null);
    this._lineBuffer = '';
    this._closed = false;
    this._lineQueue = [];
    this._lineResolve = null;
    this._lineDone = false;
    this._prompt = options.prompt || (this.terminal ? '> ' : '');

    const self = this;

    const handleChunk = chunk => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString();
      if (input.isRaw || this.terminal) {
        const line = str.replace(/[\r\n]+$/, '');
        if (line === '\u0003') { self.emit('SIGINT'); return; }
        self.emit('line', line);
      } else {
        for (let i = 0; i < str.length; i++) {
          const ch = str[i];
          if (ch === '\r' || ch === '\n') {
            if (self._lineBuffer) self._flushLine();
          } else {
            self._lineBuffer += ch;
          }
        }
      }
    };

    input.on('data', handleChunk);
    input.on('close', () => { if (!this._closed) this.close(); });
  }

  _on(ev, fn, once = false) {
    if (!this._ev[ev]) this._ev[ev] = [];
    this._ev[ev].push({ fn, once });
    return this;
  }

  _off(ev, fn) {
    if (this._ev[ev]) this._ev[ev] = this._ev[ev].filter(e => e.fn !== fn);
    return this;
  }

  _emit(ev, ...args) {
    const list = this._ev[ev]; if (!list) return false;
    const snap = [...list];
    this._ev[ev] = list.filter(e => !e.once);
    for (const e of snap) e.fn(...args);
    return true;
  }

  _listenerCount(ev) { return (this._ev[ev] || []).length; }

  _flushLine() {
    const line = this._lineBuffer;
    this._lineBuffer = '';
    this._emit('line', line);
  }

  on(ev, fn) { return this._on(ev, fn, false); }
  once(ev, fn) { return this._on(ev, fn, true); }
  off(ev, fn) { return this._off(ev, fn); }
  removeListener(ev, fn) { return this._off(ev, fn); }
  removeAllListeners(ev) {
    if (ev) delete this._ev[ev]; else Object.keys(this._ev).forEach(k => delete this._ev[k]);
    return this;
  }
  listenerCount(ev) { return this._listenerCount(ev); }
  emit(ev, ...args) { return this._emit(ev, ...args); }

  close() {
    if (this._closed) return this;
    this._closed = true;
    this._flushLine();
    this._emit('close');
    return this;
  }

  setPrompt(str) { this._prompt = str; return this; }
  getPrompt() { return this._prompt; }
  prompt() { return this; }

  question(query, optionsOrCb, cb) {
    const output = {}; // placeholder for prompt output
    if (output && output.write) output.write(query);

    let opts = {}, callback;
    if (typeof optionsOrCb === 'function') callback = optionsOrCb;
    else { opts = optionsOrCb || {}; callback = cb; }

    const signal = opts.signal;

    if (typeof callback === 'function') {
      const onLine = ans => { callback(ans); this._off('line', onLine); };
      this._on('line', onLine);
      if (signal) signal.addEventListener('abort', () => { this._off('line', onLine); });
      return this;
    }

    return new Promise((resolve, reject) => {
      const onLine = ans => { this._off('line', onLine); resolve(ans); };
      const onAbort = () => { this._off('line', onLine); reject(new AbortError()); };
      this._on('line', onLine);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this._lineQueue.length)
          return Promise.resolve({ value: this._lineQueue.shift(), done: false });
        if (this._lineDone)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise(res => { this._lineResolve = res; });
      },
      return: () => Promise.resolve({ value: undefined, done: true })
    };
  }
}

// ─── Readline helper ────────────────────────────────────────────────────────
class Readline {
  constructor(rl) { this.rl = rl; }

  clearLine(stream, dir, cb) {
    const code = dir === 0 ? 2 : dir === -1 ? 1 : 0;
    stream.write(`\u001b[${code}K`);
    if (cb) cb();
    return this;
  }

  clearScreenDown(stream, cb) {
    stream.write('\u001b[0J');
    if (cb) cb();
    return this;
  }

  moveCursor(stream, dx, dy, cb) {
    if (dx > 0) stream.write(`\u001b[${dx}C`);
    if (dx < 0) stream.write(`\u001b[${-dx}D`);
    if (dy > 0) stream.write(`\u001b[${dy}B`);
    if (dy < 0) stream.write(`\u001b[${-dy}A`);
    if (cb) cb();
    return this;
  }

  cursorTo(stream, x, y, cb) {
    if (y == null) stream.write(`\u001b[${x + 1}G`);
    else stream.write(`\u001b[${y + 1};${x + 1}H`);
    if (cb) cb();
    return this;
  }

  commit() { return Promise.resolve(); }
  rollback() { return this; }
}

// ─── createInterface helper ────────────────────────────────────────────────
function createInterface(options) {
  return new Interface(options);
}

// ─── Default export ─────────────────────────────────────────────────────────
export default {
  Interface,
  createInterface,
  Readline,
  AbortError
};
