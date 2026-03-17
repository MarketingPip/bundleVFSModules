// process/stdin.js
// npm install events

/*!
 * process/stdin — readline-compatible browser stdin shim
 * Emulates Node's process.stdin (a TTY Readable) closely enough that
 * readline.createInterface({ input: stdin }) works correctly in both
 * line-buffered (cooked) and raw-mode configurations.
 *
 * Key contracts honoured:
 *   - In cooked mode  : buffers input until \r or \n, then emits the
 *                       full line (including the terminator) as one
 *                       'data' event — readline's kNormalWrite splits it.
 *   - In raw mode     : emits one Unicode code point per 'data' event so
 *                       readline's emitKeypressEvents generator receives
 *                       characters one at a time.
 *   - listenerCount() : required by emitKeypressEvents lazy-attach logic.
 *   - 'newListener'   : EventEmitter already emits this; documented here
 *                       because emitKeypressEvents relies on it.
 *   - pause/resume    : gate pushData; readline calls these around question().
 *   - setRawMode()    : switches mode; any buffered cooked input is flushed
 *                       as a single 'data' event before the mode changes.
 *   - read()          : returns null (flowing mode only — readline never
 *                       calls read() directly).
 */

import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// _parseKey  — minimal ANSI key parser for the 'keypress' events emitted in
// raw mode.  readline's emitKeypressEvents provides a richer parser when
// attached; this is only used when no emitKeypressEvents is installed.
// ---------------------------------------------------------------------------

/**
 * @param {string} s  A single character or short ANSI sequence.
 * @returns {{ name: string; ctrl: boolean; meta: boolean; shift: boolean; sequence: string }}
 */
function _parseKey(s) {
  // ANSI escape sequences — delegate name parsing to a small table
  if (s.startsWith('\x1b[') || s.startsWith('\x1bO')) {
    return { name: 'ansi', ctrl: false, meta: true, shift: false, sequence: s };
  }
  if (s === '\r' || s === '\n')  return { name: 'return',    ctrl: false, meta: false, shift: false, sequence: s };
  if (s === '\t')                return { name: 'tab',       ctrl: false, meta: false, shift: false, sequence: s };
  if (s === '\x03')              return { name: 'c',         ctrl: true,  meta: false, shift: false, sequence: s };
  if (s === '\x1b')              return { name: 'escape',    ctrl: false, meta: false, shift: false, sequence: s };
  if (s === '\x7f' || s === '\b')return { name: 'backspace', ctrl: false, meta: false, shift: false, sequence: s };
  if (s.length === 1 && s <= '\x1a') {
    // Ctrl+A … Ctrl+Z
    return {
      name: String.fromCharCode(s.charCodeAt(0) + 96), // 'a'..'z'
      ctrl: true, meta: false, shift: false, sequence: s,
    };
  }
  return {
    name: s.toLowerCase(),
    ctrl: false, meta: false,
    shift: s.length === 1 && s !== s.toLowerCase(),
    sequence: s,
  };
}

// ---------------------------------------------------------------------------
// Stdin
// ---------------------------------------------------------------------------

const stdin = new EventEmitter();

// ── Public properties matching Node's process.stdin ──────────────────────────
stdin.isTTY    = true;
stdin.readable = true;
stdin.fd       = 0;

// ── Private state ─────────────────────────────────────────────────────────────
stdin._isRaw   = false;
stdin._paused  = false;
stdin._ended   = false;
/** Cooked-mode line accumulator. @type {string} */
stdin._cookedBuf = '';
/** Promise/resolve pair for waitUntilDrained(). @type {null | () => void} */
stdin._drainResolve  = null;
/** @type {null | Promise<void>} */
stdin._drainPromise  = null;

// ── Encoding (readline's StringDecoder takes over; this is informational) ─────
stdin._encoding = null;

/** @param {string | null} enc */
stdin.setEncoding = function setEncoding(enc) {
  this._encoding = enc;
  return this;
};

// ── TTY raw-mode ──────────────────────────────────────────────────────────────

/**
 * Switches between cooked (line-buffered) and raw (character-by-character) mode.
 * If switching TO raw while there is buffered cooked input, flush it first so
 * the line is not lost.
 * @param {boolean} value
 */
stdin.setRawMode = function setRawMode(value) {
  value = !!value;
  if (value && !this._isRaw && this._cookedBuf.length > 0) {
    // Flush the partial line as a data event before entering raw mode
    const pending = this._cookedBuf;
    this._cookedBuf = '';
    this._emitData(pending);
  }
  this._isRaw = value;
  return this;
};

Object.defineProperty(stdin, 'isRaw', { get() { return this._isRaw; } });

// ── Flow control ──────────────────────────────────────────────────────────────

stdin.resume = function resume() {
  this._paused = false;
  return this;
};

stdin.pause = function pause() {
  this._paused = true;
  return this;
};

Object.defineProperty(stdin, 'isPaused', { get() { return this._paused; } });

// ── Stream termination ────────────────────────────────────────────────────────

stdin.end = function end() {
  if (this._ended) return;
  // Flush any remaining cooked buffer as a final line (no trailing newline)
  if (this._cookedBuf.length > 0) {
    const pending = this._cookedBuf;
    this._cookedBuf = '';
    this._emitData(pending);
  }
  this._ended   = true;
  this.readable = false;
  this.emit('end');
  this.emit('close');
  this._checkDrain();
};

stdin.destroy = function destroy(err) {
  if (err) this.emit('error', err);
  this.end();
};

// ── Minimal Readable API ──────────────────────────────────────────────────────

/** readline never calls read() directly; flowing mode only. */
stdin.read = function read() { return null; };

stdin.pipe = function pipe(dest) {
  this.on('data', chunk => dest.write && dest.write(chunk));
  this.on('end',  ()    => dest.end   && dest.end());
  return dest;
};

stdin.unpipe = function unpipe() { return this; };
stdin.unshift = function unshift() {};

// ── Core data emission ────────────────────────────────────────────────────────

/**
 * Emits `'data'` and, in raw mode, also `'keypress'` for each Unicode code
 * point so emitKeypressEvents' generator receives characters one at a time.
 *
 * In raw mode we iterate code points (not code units) so surrogate pairs are
 * delivered as a single character, matching Node's behaviour.
 *
 * @param {string} str  Already-decoded string to emit.
 */
stdin._emitData = function _emitData(str) {
  if (this._isRaw) {
    // Deliver one code point at a time
    for (const cp of str) {         // String iterator yields code points
      this.emit('data', cp);
      // Only emit keypress if no emitKeypressEvents is installed
      // (emitKeypressEvents installs its own 'data' listener that calls
      // stream.emit('keypress', …) via the generator).
      if (this.listenerCount('keypress') > 0 &&
          !this['__keypressInstalled__']) {
        this.emit('keypress', cp === '\r' || cp === '\n' ? undefined : cp, _parseKey(cp));
      }
    }
  } else {
    // Cooked mode: deliver the whole string as a single 'data' chunk.
    // readline's kNormalWrite state machine handles \r/\n splitting.
    this.emit('data', str);
  }
};

// ── pushData — the primary API for feeding input ──────────────────────────────

/**
 * Push a string or Buffer of input data into the stream.
 *
 * Cooked mode (default):
 *   Accumulates characters until a `\r` or `\n` is found, then emits
 *   the complete buffer (including the terminator) as a single `'data'`
 *   event.  Multiple newlines in one push are handled correctly.
 *
 * Raw mode:
 *   Bypasses line buffering entirely — emits each Unicode code point
 *   as its own `'data'` event immediately.
 *
 * @param {string | Buffer | Uint8Array} chunk
 */
stdin.pushData = function pushData(chunk) {
  if (this._ended || this._paused) return;

  const str = typeof chunk === 'string'
    ? chunk
    : Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)
      ? Buffer.from(chunk).toString('utf8')
      : String(chunk);

  if (this._isRaw) {
    this._emitData(str);
    return;
  }

  // Cooked mode: scan for line terminators and emit complete lines
  this._cookedBuf += str;

  let start = 0;
  for (let i = 0; i < this._cookedBuf.length; i++) {
    const ch = this._cookedBuf[i];
    if (ch === '\n' || ch === '\r') {
      // Include the terminator in the emitted chunk (readline's state machine
      // uses it to detect line boundaries via crlfDelay).
      const line = this._cookedBuf.slice(start, i + 1);
      this._emitData(line);

      // Peek ahead: if this was \r and the next char is \n, skip it now
      // to avoid emitting a spurious empty line from the \n half.
      // (readline's crlfDelay timer handles the inter-chunk case.)
      if (ch === '\r' && i + 1 < this._cookedBuf.length && this._cookedBuf[i + 1] === '\n') {
        i++;
      }
      start = i + 1;
    }
  }

  // Keep any trailing partial line in the buffer
  this._cookedBuf = this._cookedBuf.slice(start);
};

// ── Drain / wait helpers ──────────────────────────────────────────────────────

/**
 * Returns a Promise that resolves once the stream has ended OR there are no
 * more relevant listeners.  Useful in tests / REPL loops to know when to stop.
 * @returns {Promise<void>}
 */
stdin.waitUntilDrained = function waitUntilDrained() {
  if (this._ended) return Promise.resolve();
  const relevant = ['data', 'end', 'close', 'error', 'keypress'];
  const count = relevant.reduce((n, ev) => n + this.listenerCount(ev), 0);
  if (count === 0) return Promise.resolve();
  if (!this._drainPromise) {
    this._drainPromise = new Promise(res => { this._drainResolve = res; });
  }
  return this._drainPromise;
};

/**
 * Checks whether the drain promise should be resolved.
 * Called on 'end', 'close', and listener removal.
 * @internal
 */
stdin._checkDrain = function _checkDrain() {
  if (!this._drainResolve) return;
  const relevant = ['data', 'end', 'close', 'error', 'keypress'];
  const count = relevant.reduce((n, ev) => n + this.listenerCount(ev), 0);
  if (this._ended || count === 0) {
    const res = this._drainResolve;
    this._drainResolve = null;
    this._drainPromise = null;
    res();
  }
};

stdin.on('removeListener', () => stdin._checkDrain());

// ── emitKeypressEvents integration marker ────────────────────────────────────
// emitKeypressEvents (readline/emitKeypressEvents.js) installs a 'data'
// listener via stream.on('newListener', …).  Once installed it takes full
// ownership of keypress emission, so _emitData must not double-emit.
// We detect installation via the KEYPRESS_DECODER symbol it attaches.

const KEYPRESS_DECODER = Symbol.for('keypress-decoder');
Object.defineProperty(stdin, '__keypressInstalled__', {
  get() { return !!this[KEYPRESS_DECODER]; },
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export { stdin };
export default stdin;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// ── Basic line-mode (cooked) ──────────────────────────────────────────────────
// import stdin from './process/stdin.js'
// import readline from './readline.js'
//
// const rl = readline.createInterface({ input: stdin, output: process.stdout })
// rl.on('line', line => console.log('Got:', line))
//
// stdin.pushData('hello\n')       // → Got: hello
// stdin.pushData('wor')           // buffered…
// stdin.pushData('ld\n')          // → Got: world
// stdin.pushData('no newline')    // stays buffered
// stdin.end()                     // → Got: no newline  (flushed on end)
//
// ── question() ────────────────────────────────────────────────────────────────
// const { promises: rlp } = readline
// const rl2 = rlp.createInterface({ input: stdin, output: process.stdout })
// setTimeout(() => stdin.pushData('Alice\n'), 100)
// const name = await rl2.question('Name? ')   // → 'Alice'
// rl2.close()
//
// ── Raw mode (emitKeypressEvents) ─────────────────────────────────────────────
// import { emitKeypressEvents } from './readline.js'
// emitKeypressEvents(stdin)          // installs the full ANSI parser
// stdin.setRawMode(true)
// stdin.on('keypress', (ch, key) => console.log(key))
// stdin.pushData('\x1b[A')           // → { name: 'up', ctrl: false, … }
// stdin.pushData('\x03')             // → { name: 'c',  ctrl: true,  … }
//
// ── CRLF (Windows-style line endings) ────────────────────────────────────────
// stdin.pushData('line1\r\nline2\r\n')
// // → Got: line1  /  Got: line2   (one event per logical line)
//
// ── waitUntilDrained ─────────────────────────────────────────────────────────
// rl.on('close', () => console.log('done'))
// stdin.pushData('bye\n')
// rl.close()
// await stdin.waitUntilDrained()
