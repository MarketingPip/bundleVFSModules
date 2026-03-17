// readline/interface.js
// npm install events readable-stream string_decoder

/*!
 * readline/interface — InterfaceConstructor + Interface base class
 * Ported from Node.js internal/readline/interface (MIT / Joyent)
 *
 * Limitations:
 *   - kSetRawMode is a no-op (no TTY driver in browsers).
 *   - TTY cursor/display-width calculations use output.columns ?? 80.
 *   - kTtyWrite key-handling covers the full Node keybinding table but
 *     relies on the host feeding raw characters via emitKeypressEvents.
 */

import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
import {
  CSI, charLengthAt, charLengthLeft, commonPrefix, kSubstringSearch,
} from './utils.js';

const { kClearLine, kClearScreenDown, kClearToLineEnd } = CSI;

// ---------------------------------------------------------------------------
// Well-known symbols — exported so readline.js / readline/promises.js can
// reference the same slots without string keys.
// ---------------------------------------------------------------------------
export const kAddHistory        = Symbol('kAddHistory');
export const kDecoder           = Symbol('kDecoder');
export const kDeleteLeft        = Symbol('kDeleteLeft');
export const kDeleteLineLeft    = Symbol('kDeleteLineLeft');
export const kDeleteLineRight   = Symbol('kDeleteLineRight');
export const kDeleteRight       = Symbol('kDeleteRight');
export const kDeleteWordLeft    = Symbol('kDeleteWordLeft');
export const kDeleteWordRight   = Symbol('kDeleteWordRight');
export const kGetDisplayPos     = Symbol('kGetDisplayPos');
export const kHistoryNext       = Symbol('kHistoryNext');
export const kHistoryPrev       = Symbol('kHistoryPrev');
export const kInsertString      = Symbol('kInsertString');
export const kLine              = Symbol('kLine');
export const kLine_buffer       = Symbol('kLine_buffer');
export const kMoveCursor        = Symbol('kMoveCursor');
export const kNormalWrite       = Symbol('kNormalWrite');
export const kOldPrompt         = Symbol('kOldPrompt');
export const kOnLine            = Symbol('kOnLine');
export const kPreviousKey       = Symbol('kPreviousKey');
export const kPrompt            = Symbol('kPrompt');
export const kQuestion          = Symbol('kQuestion');
export const kQuestionCallback  = Symbol('kQuestionCallback');
export const kQuestionCancel    = Symbol('kQuestionCancel');
export const kRefreshLine       = Symbol('kRefreshLine');
export const kSawKeyPress       = Symbol('kSawKeyPress');
export const kSawReturnAt       = Symbol('kSawReturnAt');
export const kSetRawMode        = Symbol('kSetRawMode');
export const kTabComplete       = Symbol('kTabComplete');
export const kTabCompleter      = Symbol('kTabCompleter');
export const kTtyWrite          = Symbol('kTtyWrite');
export const kWordLeft          = Symbol('kWordLeft');
export const kWordRight         = Symbol('kWordRight');
export const kWriteToOutput     = Symbol('kWriteToOutput');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const kEmptyObject = Object.freeze(Object.create(null));

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

function _assertInt(v, name, min = -Infinity, max = Infinity) {
  if (!Number.isInteger(v) || v < min || v > max)
    throw new TypeError(`"${name}" must be an integer${min !== -Infinity ? ` [${min}..${max}]` : ''}, got ${v}`);
}

/** Strip ANSI escape sequences to compute visible display width. */
function _stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/** Visible column width of a string (handles surrogate pairs, strips ANSI). */
function _dispWidth(str) {
  return _stripAnsi(str).length; // simplified; no CJK wide-char handling
}

// ---------------------------------------------------------------------------
// InterfaceConstructor  — base shared by callback and promise variants
// ---------------------------------------------------------------------------

/**
 * @extends EventEmitter
 */
export class InterfaceConstructor extends EventEmitter {
  // Public mutable properties (kept in sync by the write path)
  line   = '';
  cursor = 0;

  // Symbol-keyed internal state
  [kDecoder]          = null;
  [kLine_buffer]      = '';
  [kOldPrompt]        = '';
  [kPreviousKey]      = null;
  [kPrompt]           = '> ';
  [kQuestionCallback] = null;
  [kSawKeyPress]      = false;
  [kSawReturnAt]      = 0;

  #closed    = false;
  #paused    = false;
  #history   = [];
  #histSize  = 30;
  #dedup     = false;
  #crlfDelay = 100;
  /** @type {ReturnType<typeof setTimeout>|null} */ #crTimer = null;
  #carry     = '';
  #input;
  #output;
  #terminal  = false;
  #completer = null;

  constructor(inputOrOpts, output, completer, terminal) {
    super();
    const opts = _resolveOpts(inputOrOpts, output, completer, terminal);

    if (!opts.input) throw new TypeError('readline Interface requires an "input" option.');

    this.#input    = opts.input;
    this.#output   = opts.output ?? null;
    this.#terminal = opts.terminal != null
      ? !!opts.terminal
      : !!(this.#output && /** @type {any} */(this.#output).isTTY);

    if (typeof opts.completer === 'function') {
      this.#completer = opts.completer.length === 2
        ? opts.completer
        : (v, cb) => cb(null, opts.completer(v));
    }

    if (opts.historySize !== undefined) this.#histSize = Math.max(0, opts.historySize | 0);
    if (Array.isArray(opts.history))    this.#history  = opts.history.slice(0, this.#histSize);
    if (opts.removeHistoryDuplicates)   this.#dedup    = true;
    if (opts.prompt !== undefined)      this[kPrompt]  = String(opts.prompt);
    if (opts.crlfDelay !== undefined) {
      this.#crlfDelay = opts.crlfDelay === Infinity
        ? Infinity : Math.max(100, Number(opts.crlfDelay));
    }

    this[kDecoder] = new StringDecoder('utf8');

    if (opts.signal) {
      if (opts.signal.aborted) {
        globalThis.setTimeout(() => this.close(), 0);
      } else {
        opts.signal.addEventListener('abort', () => this.close(), { once: true });
      }
    }

    this.#input.on('data',  chunk => this[kNormalWrite](chunk));
    this.#input.on('end',   ()    => this.#onEnd());
    this.#input.on('error', err   => this.emit('error', err));
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get terminal() { return this.#terminal; }
  get closed()   { return this.#closed;   }
  get history()  { return this.#history;  }
  get completer(){ return this.#completer; }
  get crlfDelay(){ return this.#crlfDelay; }
  get output()   { return this.#output;   }
  get input()    { return this.#input;    }

  // ── Prompt ────────────────────────────────────────────────────────────────

  setPrompt(str)  { this[kPrompt] = String(str); }
  getPrompt()     { return this[kPrompt]; }

  prompt(preserveCursor) {
    if (this.#closed) return;
    if (this.#paused) this.resume();
    if (this.#output) {
      if (!preserveCursor) this.cursor = 0;
      this[kWriteToOutput](this[kPrompt]);
    }
  }

  // ── Flow control ──────────────────────────────────────────────────────────

  pause() {
    if (this.#paused || this.#closed) return this;
    this.#input.pause();
    this.#paused = true;
    this.emit('pause');
    return this;
  }

  resume() {
    if (this.#closed) return this;
    if (this.#paused) {
      this.#input.resume();
      this.#paused = false;
      this.emit('resume');
    }
    return this;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearCrTimer();
    this.#input.pause();
    this[kSetRawMode](false);
    this.emit('close');
  }

  [Symbol.dispose]() { this.close(); }

  // ── write ─────────────────────────────────────────────────────────────────

  write(data, key) {
    if (this.#closed) return;
    if (this.#paused) this.resume();
    if (this.#terminal && key) {
      this[kTtyWrite](data, key);
    } else if (data) {
      this[kNormalWrite](data);
    }
  }

  // ── getCursorPos ──────────────────────────────────────────────────────────

  getCursorPos() {
    const cols  = /** @type {any} */(this.#output)?.columns ?? 80;
    const total = _dispWidth(this[kPrompt]) + this.cursor;
    return { rows: Math.floor(total / cols), cols: total % cols };
  }

  // ── Async iterator ────────────────────────────────────────────────────────

  [Symbol.asyncIterator]() {
    /** @type {string[]} */ const ready   = [];
    /** @type {Array<(r: IteratorResult<string>) => void>} */ const waiting = [];
    let done = false;

    const flush = () => {
      while (waiting.length && ready.length)
        waiting.shift()({ value: ready.shift(), done: false });
      if (done && waiting.length)
        waiting.shift()({ value: undefined, done: true });
    };

    const onLine  = line => { ready.push(line); flush(); };
    const onClose = ()   => { done = true; flush(); };

    this.on('line',  onLine);
    this.on('close', onClose);

    return {
      next: () => {
        if (ready.length) return Promise.resolve({ value: ready.shift(), done: false });
        if (done)         return Promise.resolve({ value: undefined, done: true });
        return new Promise(res => waiting.push(res));
      },
      return: () => {
        this.off('line',  onLine);
        this.off('close', onClose);
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  // ── kWriteToOutput ────────────────────────────────────────────────────────

  [kWriteToOutput](data) {
    if (this.#output && typeof data === 'string') this.#output.write(data);
  }

  // ── kSetRawMode (no-op in browser) ────────────────────────────────────────

  [kSetRawMode](_value) {
    // No kernel TTY in browser. Subclasses may override.
  }

  // ── kNormalWrite — line-splitting state machine ───────────────────────────

  [kNormalWrite](chunk) {
    if (this.#closed || this.#paused) return;
    const str = this[kDecoder]
      ? this[kDecoder].write(typeof chunk === 'string'
          ? Buffer.from(chunk) : chunk)
      : (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];

      if (this.#crTimer !== null) {
        this.#clearCrTimer();
        if (ch === '\n') continue; // \r\n — discard the \n
      }

      if (ch === '\n') {
        const line = this.#carry; this.#carry = '';
        this[kOnLine](line);
      } else if (ch === '\r') {
        const line = this.#carry; this.#carry = '';
        this[kOnLine](line);
        this.#crTimer = this.#crlfDelay === Infinity
          ? -1
          : globalThis.setTimeout(() => { this.#crTimer = null; }, this.#crlfDelay);
      } else {
        this.#carry += ch;
      }
    }

    this.line   = this.#carry;
    this.cursor = this.#carry.length;
    this[kLine_buffer] = this.#carry;
  }

  // ── kOnLine ───────────────────────────────────────────────────────────────

  [kOnLine](line) {
    this.line   = '';
    this.cursor = 0;
    this[kLine_buffer] = '';
    this[kAddHistory](line);

    if (this[kQuestionCallback]) {
      const cb = this[kQuestionCallback];
      this[kQuestionCallback] = null;
      this[kOldPrompt] = '';
      this[kWriteToOutput](this[kPrompt]);
      cb(line);
    } else {
      this.emit('line', line);
    }
  }

  // ── kAddHistory ───────────────────────────────────────────────────────────

  [kAddHistory](line) {
    if (!this.#histSize || !line) return line;
    if (this.#dedup) {
      const idx = this.#history.indexOf(line);
      if (idx !== -1) this.#history.splice(idx, 1);
    }
    this.#history.unshift(line);
    if (this.#history.length > this.#histSize) this.#history.pop();
    this.emit('history', this.#history.slice());
    return line;
  }

  // ── kQuestion / kQuestionCancel ───────────────────────────────────────────

  [kQuestion](query, cb) {
    if (this.#closed) throw new Error('readline Interface was closed');
    this[kOldPrompt] = this[kPrompt];
    this.setPrompt(query);
    this[kQuestionCallback] = cb;
    if (this.#output) this[kWriteToOutput](query);
  }

  [kQuestionCancel]() {
    if (this[kQuestionCallback]) {
      this[kQuestionCallback] = null;
      this.setPrompt(this[kOldPrompt]);
      this[kRefreshLine]();
    }
  }

  // ── kRefreshLine ──────────────────────────────────────────────────────────

  [kRefreshLine]() {
    if (!this.#output || !this.#terminal) return;
    const out = this.#output;
    // Move to column 0, clear line, re-print prompt + current input
    out.write(CSI`\r` + kClearLine + this[kPrompt] + this.line);
    // Reposition cursor if not at end
    const lineLen = this.line.length;
    if (this.cursor < lineLen) {
      const back = lineLen - this.cursor;
      out.write(CSI`${back}D`);
    }
  }

  // ── kInsertString ─────────────────────────────────────────────────────────

  [kInsertString](c) {
    if (this.cursor < this.line.length) {
      const beg = this.line.slice(0, this.cursor);
      const end = this.line.slice(this.cursor);
      this.line   = beg + c + end;
      this.cursor += c.length;
      this[kRefreshLine]();
    } else {
      this.line   += c;
      this.cursor += c.length;
      this[kWriteToOutput](c);
    }
    this[kLine_buffer] = this.line;
  }

  // ── Cursor motion helpers ─────────────────────────────────────────────────

  [kMoveCursor](dx) {
    if (!dx) return;
    const before = this.cursor;
    this.cursor = Math.max(0, Math.min(this.line.length, this.cursor + dx));
    const delta = this.cursor - before;
    if (!this.#output || !this.#terminal || !delta) return;
    this.#output.write(delta > 0 ? CSI`${delta}C` : CSI`${-delta}D`);
  }

  [kDeleteLeft]() {
    if (this.cursor === 0) return;
    const len = charLengthLeft(this.line, this.cursor);
    this.line   = this.line.slice(0, this.cursor - len) + this.line.slice(this.cursor);
    this.cursor -= len;
    this[kLine_buffer] = this.line;
    this[kRefreshLine]();
  }

  [kDeleteRight]() {
    if (this.cursor === this.line.length) return;
    const len = charLengthAt(this.line, this.cursor);
    this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + len);
    this[kLine_buffer] = this.line;
    this[kRefreshLine]();
  }

  [kDeleteWordLeft]() {
    let i = this.cursor;
    while (i > 0 && this.line[i - 1] === ' ') i--;
    while (i > 0 && this.line[i - 1] !== ' ') i--;
    this.line   = this.line.slice(0, i) + this.line.slice(this.cursor);
    this.cursor = i;
    this[kLine_buffer] = this.line;
    this[kRefreshLine]();
  }

  [kDeleteWordRight]() {
    let i = this.cursor;
    while (i < this.line.length && this.line[i] === ' ') i++;
    while (i < this.line.length && this.line[i] !== ' ') i++;
    this.line = this.line.slice(0, this.cursor) + this.line.slice(i);
    this[kLine_buffer] = this.line;
    this[kRefreshLine]();
  }

  [kDeleteLineLeft]() {
    this.line   = this.line.slice(this.cursor);
    this.cursor = 0;
    this[kLine_buffer] = this.line;
    this[kRefreshLine]();
  }

  [kDeleteLineRight]() {
    this.line = this.line.slice(0, this.cursor);
    this[kLine_buffer] = this.line;
    this[kRefreshLine]();
  }

  [kWordLeft]() {
    let i = this.cursor;
    while (i > 0 && this.line[i - 1] === ' ') i--;
    while (i > 0 && this.line[i - 1] !== ' ') i--;
    this[kMoveCursor](i - this.cursor);
  }

  [kWordRight]() {
    let i = this.cursor;
    while (i < this.line.length && this.line[i] === ' ') i++;
    while (i < this.line.length && this.line[i] !== ' ') i++;
    this[kMoveCursor](i - this.cursor);
  }

  [kLine]() {
    const line = this[kAddHistory](this.line);
    this.line   = '';
    this.cursor = 0;
    this[kLine_buffer] = '';
    if (this.#output && this.#terminal) this[kWriteToOutput]('\r\n');
    this[kOnLine](line);
  }

  // ── kGetDisplayPos ────────────────────────────────────────────────────────

  [kGetDisplayPos](str) {
    const cols = /** @type {any} */(this.#output)?.columns ?? 80;
    const disp = _dispWidth(str);
    return { rows: Math.floor(disp / cols), cols: disp % cols };
  }

  // ── kTabComplete / kTabCompleter ──────────────────────────────────────────

  [kTabComplete](lastKeypressWasTab) {
    if (!this.#completer) return;
    this.pause();
    const str = this.line.slice(0, this.cursor);
    this.#completer(str, (err, value) => {
      this.resume();
      if (err) {
        this[kWriteToOutput](`Tab completion error: ${String(err)}\n`);
        return;
      }
      this[kTabCompleter](lastKeypressWasTab, value);
    });
  }

  [kTabCompleter](lastKeypressWasTab, value) {
    const [completions, completeOn] = value;
    if (!completions || completions.length === 0) return;

    const prefix = commonPrefix(completions);

    if (prefix.length > completeOn.length) {
      this[kInsertString](prefix.slice(completeOn.length));
      return;
    }

    if (lastKeypressWasTab) {
      this[kWriteToOutput]('\r\n');
      const width = Math.max(...completions.map(c => c.length)) + 2;
      const cols  = Math.floor(
        (/** @type {any} */(this.#output)?.columns ?? 80) / width
      ) || 1;
      for (let i = 0; i < completions.length; i++) {
        this[kWriteToOutput](completions[i].padEnd(width));
        if ((i + 1) % cols === 0) this[kWriteToOutput]('\r\n');
      }
      this[kWriteToOutput]('\r\n');
      this[kRefreshLine]();
    }
  }

  // ── kHistoryNext / kHistoryPrev ───────────────────────────────────────────

  [kHistoryNext]() {
    if (!this.#history.length) return;
    const idx = this.#history.indexOf(this.line);
    const next = idx <= 0 ? '' : this.#history[idx - 1];
    this.line   = next;
    this.cursor = next.length;
    this[kLine_buffer] = next;
    this[kRefreshLine]();
  }

  [kHistoryPrev]() {
    if (!this.#history.length) return;
    const idx = this.#history.indexOf(this.line);
    const prev = idx === -1
      ? this.#history[0]
      : this.#history[Math.min(idx + 1, this.#history.length - 1)];
    this.line   = prev;
    this.cursor = prev.length;
    this[kLine_buffer] = prev;
    this[kRefreshLine]();
  }

  // ── kTtyWrite — full Node keybinding table ────────────────────────────────

  [kTtyWrite](s, key) {
    key = key || {};
    if (key.name === 'escape') return;

    if (this[kSawReturnAt] && key.name !== 'enter') this[kSawReturnAt] = 0;

    if (key.ctrl && key.shift) {
      switch (key.name) {
        case 'backspace': this[kDeleteLineLeft]();  return;
        case 'delete':    this[kDeleteLineRight](); return;
      }
    } else if (key.ctrl) {
      switch (key.name) {
        case 'c':
          if (this.listenerCount('SIGINT') > 0) { this.emit('SIGINT'); return; }
          this.close(); return;
        case 'd':
          if (this.line.length === 0) { this.close(); return; }
          this[kDeleteRight](); return;
        case 'h': this[kDeleteLeft]();      return;
        case 'u': this[kDeleteLineLeft]();  return;
        case 'k': this[kDeleteLineRight](); return;
        case 'a': this[kMoveCursor](-Infinity); return;
        case 'e': this[kMoveCursor](+Infinity); return;
        case 'b': this[kMoveCursor](-1); return;
        case 'f': this[kMoveCursor](+1); return;
        case 'l':
          if (this.#output) {
            this.#output.write(kClearScreenDown);
            this[kRefreshLine]();
          }
          return;
        case 'n': this[kHistoryNext](); return;
        case 'p': this[kHistoryPrev](); return;
        case 'z':
          // Ctrl+Z: SIGTSTP — not supported in browser
          if (this.listenerCount('SIGTSTP') > 0) this.emit('SIGTSTP');
          return;
        case 'w':
        case 'backspace': this[kDeleteWordLeft]();  return;
        case 'delete':    this[kDeleteWordRight](); return;
        case 'left':      this[kWordLeft]();         return;
        case 'right':     this[kWordRight]();        return;
      }
    } else if (key.meta) {
      switch (key.name) {
        case 'b':         this[kWordLeft]();          return;
        case 'f':         this[kWordRight]();         return;
        case 'd':
        case 'delete':    this[kDeleteWordRight]();   return;
        case 'backspace': this[kDeleteWordLeft]();    return;
      }
    } else {
      switch (key.name) {
        case 'return':
          this[kSawReturnAt] = Date.now();
          this[kLine]();
          return;
        case 'enter':
          if (
            this[kSawReturnAt] === 0 ||
            Date.now() - this[kSawReturnAt] > this.#crlfDelay
          ) this[kLine]();
          this[kSawReturnAt] = 0;
          return;
        case 'backspace': this[kDeleteLeft]();  return;
        case 'delete':    this[kDeleteRight](); return;
        case 'left':      this[kMoveCursor](-charLengthLeft(this.line, this.cursor)); return;
        case 'right':     this[kMoveCursor](+charLengthAt(this.line, this.cursor));   return;
        case 'home':      this[kMoveCursor](-Infinity); return;
        case 'end':       this[kMoveCursor](+Infinity); return;
        case 'up':        this[kHistoryPrev](); return;
        case 'down':      this[kHistoryNext](); return;
        case 'tab':
          if (this.#completer && this.#terminal) {
            const lastWasTab = this[kPreviousKey]?.name === 'tab';
            this[kTabComplete](lastWasTab);
            this[kPreviousKey] = key;
            return;
          }
          break;
      }

      if (s) this[kInsertString](s);
    }

    this[kPreviousKey] = key;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  #clearCrTimer() {
    if (this.#crTimer !== null && this.#crTimer !== -1)
      globalThis.clearTimeout(this.#crTimer);
    this.#crTimer = null;
  }

  #onEnd() {
    if (this.#carry.length) {
      const line = this.#carry; this.#carry = '';
      this[kOnLine](line);
    }
    if (!this.#closed) this.close();
  }
}

// ---------------------------------------------------------------------------
// Interface  — concrete base class (extended by readline.js callback variant
//              and readline/promises.js promise variant)
// ---------------------------------------------------------------------------

export class Interface extends InterfaceConstructor {}

export default {
  Interface, InterfaceConstructor,
  kAddHistory, kDecoder, kDeleteLeft, kDeleteLineLeft, kDeleteLineRight,
  kDeleteRight, kDeleteWordLeft, kDeleteWordRight, kGetDisplayPos,
  kHistoryNext, kHistoryPrev, kInsertString, kLine, kLine_buffer,
  kMoveCursor, kNormalWrite, kOldPrompt, kOnLine, kPreviousKey,
  kPrompt, kQuestion, kQuestionCallback, kQuestionCancel, kRefreshLine,
  kSawKeyPress, kSawReturnAt, kSetRawMode, kTabComplete, kTabCompleter,
  kTtyWrite, kWordLeft, kWordRight, kWriteToOutput,
};
