// src/readline.js
//
// Faithful port of Node.js v24.20.0:
//   - lib/readline.js                  (callback API surface)
//   - lib/internal/readline/interface.js (Interface implementation)
//   - lib/internal/readline/utils.js     (errors, validators, CSI/ANSI, keys)
//   - lib/internal/readline/emitKeypressEvents.js
//
// Self-contained: the implementation is inlined here (plus
// src/readline/promises.js for the `promises` namespace) so this entry has no
// internal helper imports. Browser-safe, dependency-free ESM:
//   - `globalThis._RUNTIME_` is only referenced behind a typeof guard.
//   - No `window`/`document` at module scope.
//   - No global pollution.

import { EventEmitter } from './events.js';
import { StringDecoder } from './string_decoder.js';
import * as promises from './readline/promises.js';

// ======================================================================
// Inlined from src/readline/utils.js
// ======================================================================
// readline/utils.js
//
// Ported from Node.js v24.20.0:
//   - lib/internal/readline/utils.js  (CSI, emitKeys, char helpers)
//   - lib/internal/readline/callbacks.js (cursorTo/moveCursor/clearLine/clearScreenDown)
//   plus the small error/validator surface those modules need.
//
// Dependency-free ESM, browser-safe. No bare imports.

const RT = (typeof globalThis._RUNTIME_ !== "undefined")
  ? globalThis._RUNTIME_
  : undefined;

// ---------------------------------------------------------------------------
// Errors (shapes match Node's internal/errors codes used by readline)
// ---------------------------------------------------------------------------

class AbortError extends Error {
  constructor(message = 'The operation was aborted', options = {}) {
    super(message, options);
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
  }
}

function makeCodeError(code, Base, message) {
  return class extends Base {
    constructor(...args) {
      super(typeof message === 'function' ? message(...args) : message);
      this.code = code;
    }
    toString() {
      return `${this.name} [${this.code}]: ${this.message}`;
    }
  };
}

const ERR_INVALID_ARG_VALUE = makeCodeError(
  'ERR_INVALID_ARG_VALUE', TypeError,
  (name, value, reason = 'is invalid') =>
    `The argument '${name}' ${reason}. Received ${inspectValue(value)}`,
);
const ERR_INVALID_ARG_TYPE = makeCodeError(
  'ERR_INVALID_ARG_TYPE', TypeError,
  (name, expected, actual) =>
    `The "${name}" argument must be of type ${expected}. ` +
    `Received ${inspectValue(actual)}`,
);
const ERR_INVALID_CURSOR_POS = makeCodeError(
  'ERR_INVALID_CURSOR_POS', TypeError,
  'Cannot set cursor row without setting its column',
);
const ERR_USE_AFTER_CLOSE = makeCodeError(
  'ERR_USE_AFTER_CLOSE', Error,
  (name) => `${name} was closed`,
);
const ERR_OUT_OF_RANGE = makeCodeError(
  'ERR_OUT_OF_RANGE', RangeError,
  (name, range = 'a valid range', value) => {
    let msg = `The value of "${name}" is out of range.`;
    if (range !== 'a valid range') msg += ` It must be ${range}.`;
    return `${msg} Received ${inspectValue(value)}`;
  },
);

function inspectValue(v) {
  if (typeof v === 'string') return `'${v}'`;
  try { return String(v); } catch { return '?'; }
}

// ---------------------------------------------------------------------------
// Validators (minimal ports of internal/validators used by readline)
// ---------------------------------------------------------------------------

function validateFunction(value, name) {
  if (typeof value !== 'function') {
    throw new ERR_INVALID_ARG_TYPE(name, 'Function', value);
  }
}

function validateInteger(value, name, min = -2147483648, max = 2147483647) {
  if (typeof value !== 'number') {
    throw new ERR_INVALID_ARG_TYPE(name, 'integer', value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
  }
  if (value < min || value > max) {
    throw new ERR_OUT_OF_RANGE(name, `>= ${min} and <= ${max}`, value);
  }
}

function validateString(value, name) {
  if (typeof value !== 'string') {
    throw new ERR_INVALID_ARG_TYPE(name, 'string', value);
  }
}

function validateBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new ERR_INVALID_ARG_TYPE(name, 'boolean', value);
  }
}

function validateUint32(value, name, positive = false) {
  if (typeof value !== 'number') {
    throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
  }
  const min = positive ? 1 : 0;
  const max = 4294967295;
  if (value < min || value > max) {
    throw new ERR_OUT_OF_RANGE(name, `>= ${min} and <= ${max}`, value);
  }
}

function validateAbortSignal(signal, name) {
  if (signal === undefined || signal === null ||
      typeof signal !== 'object' ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function') {
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal', signal);
  }
}

function validateArray(value, name) {
  if (!Array.isArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, 'Array', value);
  }
}

function validateNumber(value, name, min = undefined, max = undefined) {
  if (typeof value !== 'number') {
    throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  }
  if ((min !== undefined && value < min) ||
      (max !== undefined && value > max) ||
      ((min !== undefined || max !== undefined) && Number.isNaN(value))) {
    let range = 'a valid range';
    if (min !== undefined && max !== undefined) range = `>= ${min} and <= ${max}`;
    else if (min !== undefined) range = `>= ${min}`;
    else if (max !== undefined) range = `<= ${max}`;
    throw new ERR_OUT_OF_RANGE(name, range, value);
  }
}

// process.nextTick where available, else queueMicrotask (browser-safe).
function nextTick(cb, ...args) {
  const proc = (RT && RT.process) || globalThis.process;
  if (proc && typeof proc.nextTick === 'function') {
    proc.nextTick(cb, ...args);
  } else if (typeof globalThis.queueMicrotask === 'function') {
    globalThis.queueMicrotask(() => cb(...args));
  } else {
    globalThis.setTimeout(() => cb(...args), 0);
  }
}

// Attaches a one-shot abort listener; returns a disposable.
function addAbortListener(signal, listener) {
  if (signal === undefined) {
    throw new ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
  }
  validateAbortSignal(signal, 'signal');
  validateFunction(listener, 'listener');

  if (signal.aborted) {
    nextTick(listener);
  } else {
    signal.addEventListener('abort', listener, { once: true });
  }
  return {
    [Symbol.dispose]() {
      signal.removeEventListener('abort', listener);
    },
  };
}

// ---------------------------------------------------------------------------
// CSI tagged-template builder (from internal/readline/utils)
// ---------------------------------------------------------------------------

const kUTF16SurrogateThreshold = 0x10000; // 2 ** 16
const kSubstringSearch = Symbol('kSubstringSearch');

/**
 * Builds an ANSI CSI escape sequence.
 * @param {TemplateStringsArray} strings
 * @param {...any} args
 * @returns {string}
 */
function CSI(strings, ...args) {
  let ret = '\x1b[';
  for (let n = 0; n < strings.length; n++) {
    ret += strings[n];
    if (n < args.length) ret += args[n];
  }
  return ret;
}

CSI.kEscape = '\x1b';
CSI.kClearToLineBeginning = CSI`1K`;
CSI.kClearToLineEnd = CSI`0K`;
CSI.kClearLine = CSI`2K`;
CSI.kClearScreenDown = CSI`0J`;

// ---------------------------------------------------------------------------
// Unicode character-width helpers
// ---------------------------------------------------------------------------

/**
 * Returns the number of code units consumed by the character ending at `i`.
 * Used when moving the cursor left.
 * @param {string} str
 * @param {number} i  Index of the last code unit of the character.
 * @returns {1|2}
 */
function charLengthLeft(str, i) {
  if (i <= 0) return 0;
  if (
    (i > 1 && str.codePointAt(i - 2) >= kUTF16SurrogateThreshold) ||
    str.codePointAt(i - 1) >= kUTF16SurrogateThreshold
  ) return 2;
  return 1;
}

/**
 * Returns the number of code units the character at position `i` occupies.
 * @param {string} str
 * @param {number} i
 * @returns {1|2}
 */
function charLengthAt(str, i) {
  if (str.length <= i) return 1; // pretend to move right (for autocomplete)
  return str.codePointAt(i) >= kUTF16SurrogateThreshold ? 2 : 1;
}

// ---------------------------------------------------------------------------
// emitKeys — async generator that parses raw input into keypress events
// (faithful port of internal/readline/utils emitKeys)
// ---------------------------------------------------------------------------

/**
 * Generator that receives individual characters via `.next(ch)` and emits
 * `'keypress'` events on `stream` for each recognised key or sequence.
 *
 * @param {{ emit: Function }} stream
 * @returns {Generator<undefined, never, string>}
 */
export function* emitKeys(stream) {
  const kEscape = CSI.kEscape;

  while (true) {
    let ch = yield;
    let s = ch;
    let escaped = false;
    const key = {
      sequence: null,
      name: undefined,
      ctrl: false,
      meta: false,
      shift: false,
    };

    if (ch === kEscape) {
      escaped = true;
      s += (ch = yield);
      if (ch === kEscape) s += (ch = yield);
    }

    if (escaped && (ch === 'O' || ch === '[')) {
      let code = ch;
      let modifier = 0;

      if (ch === 'O') {
        // ESC O letter / ESC O modifier letter
        s += (ch = yield);
        if (ch >= '0' && ch <= '9') { modifier = (ch >> 0) - 1; s += (ch = yield); }
        code += ch;
      } else if (ch === '[') {
        s += (ch = yield);

        if (ch === '[') { code += ch; s += (ch = yield); }

        const cmdStart = s.length - 1;

        if (ch >= '0' && ch <= '9') {
          s += (ch = yield);
          if (ch >= '0' && ch <= '9') {
            s += (ch = yield);
            if (ch >= '0' && ch <= '9') s += (ch = yield);
          }
        }

        if (ch === ';') {
          s += (ch = yield);
          if (ch >= '0' && ch <= '9') s += yield;
        }

        const cmd = s.slice(cmdStart);
        let match;

        if ((match = /^(?:(\d\d?)(?:;(\d))?([~^$])|(\d{3}~))$/.exec(cmd))) {
          if (match[4]) {
            code += match[4];
          } else {
            code += match[1] + match[3];
            modifier = (match[2] || 1) - 1;
          }
        } else if ((match = /^((\d;)?(\d))?([A-Za-z])$/.exec(cmd))) {
          code += match[4];
          modifier = (match[3] || 1) - 1;
        } else {
          code += cmd;
        }
      }

      key.ctrl  = !!(modifier & 4);
      key.meta  = !!(modifier & 10);
      key.shift = !!(modifier & 1);
      key.code  = code;

      switch (code) {
        case '[P': case 'OP': case '[11~': case '[[A': key.name = 'f1';  break;
        case '[Q': case 'OQ': case '[12~': case '[[B': key.name = 'f2';  break;
        case '[R': case 'OR': case '[13~': case '[[C': key.name = 'f3';  break;
        case '[S': case 'OS': case '[14~': case '[[D': key.name = 'f4';  break;
        case '[[E':   key.name = 'f5';  break;
        case '[15~':  key.name = 'f5';  break;
        case '[17~':  key.name = 'f6';  break;
        case '[18~':  key.name = 'f7';  break;
        case '[19~':  key.name = 'f8';  break;
        case '[20~':  key.name = 'f9';  break;
        case '[21~':  key.name = 'f10'; break;
        case '[23~':  key.name = 'f11'; break;
        case '[24~':  key.name = 'f12'; break;
        case '[200~': key.name = 'paste-start'; break;
        case '[201~': key.name = 'paste-end';   break;
        case '[A': case 'OA': key.name = 'up';    break;
        case '[B': case 'OB': key.name = 'down';  break;
        case '[C': case 'OC': key.name = 'right'; break;
        case '[D': case 'OD': key.name = 'left';  break;
        case '[E': case 'OE': key.name = 'clear'; break;
        case '[F': case 'OF': key.name = 'end';   break;
        case '[H': case 'OH': key.name = 'home';  break;
        case '[1~': key.name = 'home';     break;
        case '[2~': key.name = 'insert';   break;
        case '[3~': key.name = 'delete';   break;
        case '[4~': key.name = 'end';      break;
        case '[5~': case '[[5~': key.name = 'pageup';   break;
        case '[6~': case '[[6~': key.name = 'pagedown'; break;
        case '[7~': key.name = 'home'; break;
        case '[8~': key.name = 'end';  break;
        case '[a': key.name = 'up';    key.shift = true; break;
        case '[b': key.name = 'down';  key.shift = true; break;
        case '[c': key.name = 'right'; key.shift = true; break;
        case '[d': key.name = 'left';  key.shift = true; break;
        case '[e': key.name = 'clear'; key.shift = true; break;
        case '[2$': key.name = 'insert';   key.shift = true; break;
        case '[3$': key.name = 'delete';   key.shift = true; break;
        case '[5$': key.name = 'pageup';   key.shift = true; break;
        case '[6$': key.name = 'pagedown'; key.shift = true; break;
        case '[7$': key.name = 'home';     key.shift = true; break;
        case '[8$': key.name = 'end';      key.shift = true; break;
        case 'Oa': key.name = 'up';    key.ctrl = true; break;
        case 'Ob': key.name = 'down';  key.ctrl = true; break;
        case 'Oc': key.name = 'right'; key.ctrl = true; break;
        case 'Od': key.name = 'left';  key.ctrl = true; break;
        case 'Oe': key.name = 'clear'; key.ctrl = true; break;
        case '[2^': key.name = 'insert';   key.ctrl = true; break;
        case '[3^': key.name = 'delete';   key.ctrl = true; break;
        case '[5^': key.name = 'pageup';   key.ctrl = true; break;
        case '[6^': key.name = 'pagedown'; key.ctrl = true; break;
        case '[7^': key.name = 'home';     key.ctrl = true; break;
        case '[8^': key.name = 'end';      key.ctrl = true; break;
        case '[Z': key.name = 'tab'; key.shift = true; break;
        default:   key.name = 'undefined'; break;
      }

    } else if (ch === '\r') {
      key.name = 'return'; key.meta = escaped;
    } else if (ch === '\n') {
      key.name = 'enter'; key.meta = escaped;
    } else if (ch === '\t') {
      key.name = 'tab'; key.meta = escaped;
    } else if (ch === '\b' || ch === '\x7f') {
      key.name = 'backspace'; key.meta = escaped;
    } else if (ch === kEscape) {
      key.name = 'escape'; key.meta = escaped;
    } else if (ch === ' ') {
      key.name = 'space'; key.meta = escaped;
    } else if (!escaped && ch <= '\x1a') {
      // ctrl+letter
      key.name = String.fromCharCode(ch.charCodeAt(0) + 'a'.charCodeAt(0) - 1);
      key.ctrl = true;
    } else if (/^[0-9A-Za-z]$/.test(ch)) {
      key.name  = ch.toLowerCase();
      key.shift = /^[A-Z]$/.test(ch);
      key.meta  = escaped;
    } else if (escaped) {
      key.name = ch.length ? undefined : 'escape';
      key.meta = true;
    }

    key.sequence = s;

    if (s.length !== 0 && (key.name !== undefined || escaped)) {
      stream.emit('keypress', escaped ? undefined : s, key);
    } else if (charLengthAt(s, 0) === s.length) {
      stream.emit('keypress', s, key);
    }
    // Unrecognised / broken sequence: emit nothing
  }
}

// ---------------------------------------------------------------------------
// Misc helpers (from internal/readline/utils)
// ---------------------------------------------------------------------------

/**
 * Returns the longest common prefix of a string array in O(n log n).
 * @param {string[]} strings
 * @returns {string}
 */
function commonPrefix(strings) {
  if (strings.length === 0) return '';
  if (strings.length === 1) return strings[0];
  const sorted = [...strings].sort();
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  for (let i = 0; i < min.length; i++) {
    if (min[i] !== max[i]) return min.slice(0, i);
  }
  return min;
}

/**
 * Reverses a delimited string (e.g. for CRLF normalisation).
 * @param {string} line
 * @param {string} [from='\r']
 * @param {string} [to='\r']
 * @returns {string}
 */
function reverseString(line, from = '\r', to = '\r') {
  const parts = line.split(from);
  let result = '';
  for (let i = parts.length - 1; i > 0; i--) result += parts[i] + to;
  result += parts[0];
  return result;
}

// ---------------------------------------------------------------------------
// String display width (adapted from Node's internal getStringWidth —
// non-ICU branch — plus stripVTControlCharacters)
// ---------------------------------------------------------------------------

const ansiPattern = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function stripVTControlCharacters(str) {
  validateString(str, 'str');
  if (str.indexOf('\u001B') === -1 && str.indexOf('\u009B') === -1) return str;
  ansiPattern.lastIndex = 0;
  return str.replace(ansiPattern, '');
}

function isFullWidthCodePoint(code) {
  return code >= 0x1100 && (
    code <= 0x115f ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) ||
    (code >= 0x3250 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0xa4c6) ||
    (code >= 0xa960 && code <= 0xa97c) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6b) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1b000 && code <= 0x1b001) ||
    (code >= 0x1f200 && code <= 0x1f251) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function isZeroWidthCodePoint(code) {
  return code <= 0x1F || // C0 control codes
    (code >= 0x7F && code <= 0x9F) || // C1 control codes
    (code >= 0x300 && code <= 0x36F) || // Combining Diacritical Marks
    (code >= 0x200B && code <= 0x200F) || // Modifying Invisible Characters
    // Combining Diacritical Marks for Symbols
    (code >= 0x20D0 && code <= 0x20FF) ||
    (code >= 0xFE00 && code <= 0xFE0F) || // Variation Selectors
    (code >= 0xFE20 && code <= 0xFE2F) || // Combining Half Marks
    (code >= 0xE0100 && code <= 0xE01EF); // Variation Selectors
}

/**
 * Number of columns required to display the given string.
 * @param {string} str
 * @param {boolean} [removeControlChars=true]
 * @returns {number}
 */
function getStringWidth(str, removeControlChars = true) {
  let width = 0;
  if (removeControlChars) str = stripVTControlCharacters(str);
  str = str.normalize('NFC');
  for (const char of str) {
    const code = char.codePointAt(0);
    if (isFullWidthCodePoint(code)) {
      width += 2;
    } else if (!isZeroWidthCodePoint(code)) {
      width++;
    }
  }
  return width;
}

// ---------------------------------------------------------------------------
// Cursor/screen callbacks (port of internal/readline/callbacks.js)
// ---------------------------------------------------------------------------

const { kClearLine, kClearScreenDown, kClearToLineBeginning, kClearToLineEnd } = CSI;

/**
 * Moves the cursor to the x and y coordinate on the given stream.
 */
function cursorTo(stream, x, y, callback) {
  if (callback !== undefined) {
    validateFunction(callback, 'callback');
  }

  if (typeof y === 'function') {
    callback = y;
    y = undefined;
  }

  if (Number.isNaN(x)) throw new ERR_INVALID_ARG_VALUE('x', x);
  if (Number.isNaN(y)) throw new ERR_INVALID_ARG_VALUE('y', y);

  if (stream == null || (typeof x !== 'number' && typeof y !== 'number')) {
    if (typeof callback === 'function') nextTick(callback, null);
    return true;
  }

  if (typeof x !== 'number') throw new ERR_INVALID_CURSOR_POS();

  const data = typeof y !== 'number' ? CSI`${x + 1}G` : CSI`${y + 1};${x + 1}H`;
  return stream.write(data, callback);
}

/**
 * Moves the cursor relative to its current location.
 */
function moveCursor(stream, dx, dy, callback) {
  if (callback !== undefined) {
    validateFunction(callback, 'callback');
  }

  if (stream == null || !(dx || dy)) {
    if (typeof callback === 'function') nextTick(callback, null);
    return true;
  }

  let data = '';

  if (dx < 0) {
    data += CSI`${-dx}D`;
  } else if (dx > 0) {
    data += CSI`${dx}C`;
  }

  if (dy < 0) {
    data += CSI`${-dy}A`;
  } else if (dy > 0) {
    data += CSI`${dy}B`;
  }

  return stream.write(data, callback);
}

/**
 * Clears the current line the cursor is on:
 *   -1 for left of the cursor, +1 for right of the cursor, 0 for the entire line.
 */
function clearLine(stream, dir, callback) {
  if (callback !== undefined) {
    validateFunction(callback, 'callback');
  }

  if (stream === null || stream === undefined) {
    if (typeof callback === 'function') nextTick(callback, null);
    return true;
  }

  const type =
    dir < 0 ? kClearToLineBeginning : dir > 0 ? kClearToLineEnd : kClearLine;
  return stream.write(type, callback);
}

/**
 * Clears the screen from the current position of the cursor down.
 */
function clearScreenDown(stream, callback) {
  if (callback !== undefined) {
    validateFunction(callback, 'callback');
  }

  if (stream === null || stream === undefined) {
    if (typeof callback === 'function') nextTick(callback, null);
    return true;
  }

  return stream.write(kClearScreenDown, callback);
}

// ======================================================================
// Inlined from src/readline/interface.js
// ======================================================================
// readline/interface.js
//
// Faithful port of Node.js v24.20.0 lib/internal/readline/interface.js
// (plus the in-memory subset of lib/internal/repl/history.js it needs).
//
// Dependency-free ESM, browser-safe:
//   - `events` / `string_decoder` come from this repo's own ports.
//   - No `window`/`document` at module scope; `globalThis` + feature checks.
//   - `process` is touched only through a guarded lookup (the sandbox and
//     real Node both provide it; a bare browser does not).
//   - TTY-only host operations (raw mode, SIGTSTP suspend) degrade to
//     guarded no-ops outside Node; everything else is real.



// Guarded host process (real Node, the sandbox's process shim, or undefined).
function getProcess() {
  if (RT && RT.process) return RT.process;
  if (typeof globalThis.process !== 'undefined') return globalThis.process;
  return undefined;
}
function getTerm() {
  const proc = getProcess();
  return proc && proc.env ? proc.env.TERM : undefined;
}

// ---------------------------------------------------------------------------
// Well-known symbols (same identities as Node's internal interface)
// ---------------------------------------------------------------------------

const kAddHistory        = Symbol('kAddHistory');
const kDecoder           = Symbol('kDecoder');
const kDeleteLeft        = Symbol('kDeleteLeft');
const kDeleteLineLeft    = Symbol('kDeleteLineLeft');
const kDeleteLineRight   = Symbol('kDeleteLineRight');
const kDeleteRight       = Symbol('kDeleteRight');
const kDeleteWordLeft    = Symbol('kDeleteWordLeft');
const kDeleteWordRight   = Symbol('kDeleteWordRight');
const kGetDisplayPos     = Symbol('kGetDisplayPos');
const kHistoryNext       = Symbol('kHistoryNext');
const kMoveDownOrHistoryNext = Symbol('kMoveDownOrHistoryNext');
const kHistoryPrev       = Symbol('kHistoryPrev');
const kMoveUpOrHistoryPrev = Symbol('kMoveUpOrHistoryPrev');
const kInsertString      = Symbol('kInsertString');
const kLine              = Symbol('kLine');
const kLine_buffer       = Symbol('kLine_buffer');
const kMoveCursor        = Symbol('kMoveCursor');
const kNormalWrite       = Symbol('kNormalWrite');
const kOldPrompt         = Symbol('kOldPrompt');
const kOnLine            = Symbol('kOnLine');
const kSetLine           = Symbol('kSetLine');
const kPreviousKey       = Symbol('kPreviousKey');
const kPrompt            = Symbol('kPrompt');
const kQuestion          = Symbol('kQuestion');
const kQuestionCallback  = Symbol('kQuestionCallback');
const kQuestionCancel    = Symbol('kQuestionCancel');
const kQuestionReject    = Symbol('kQuestionReject');
const kRefreshLine       = Symbol('kRefreshLine');
const kSawKeyPress       = Symbol('kSawKeyPress');
const kSawReturnAt       = Symbol('kSawReturnAt');
const kSetRawMode        = Symbol('kSetRawMode');
const kTabComplete       = Symbol('kTabComplete');
const kTabCompleter      = Symbol('kTabCompleter');
const kTtyWrite          = Symbol('kTtyWrite');
const kWordLeft          = Symbol('kWordLeft');
const kWordRight         = Symbol('kWordRight');
const kWriteToOutput     = Symbol('kWriteToOutput');
const kIsMultiline       = Symbol('kIsMultiline');
const kUndo              = Symbol('kUndo');
const kRedo              = Symbol('kRedo');
const kUndoStack         = Symbol('kUndoStack');
const kRedoStack         = Symbol('kRedoStack');
const kKillRing          = Symbol('kKillRing');
const kKillRingCursor    = Symbol('kKillRingCursor');
const kPushToKillRing    = Symbol('kPushToKillRing');
const kPushToUndoStack   = Symbol('kPushToUndoStack');
const kBeforeEdit        = Symbol('kBeforeEdit');
const kYank              = Symbol('kYank');
const kYankPop           = Symbol('kYankPop');
const kYanking           = Symbol('kYanking');
const kSavePreviousState = Symbol('kSavePreviousState');
const kRestorePreviousState = Symbol('kRestorePreviousState');
const kPreviousLine      = Symbol('kPreviousLine');
const kPreviousCursor    = Symbol('kPreviousCursor');
const kPreviousCursorCols = Symbol('kPreviousCursorCols');
const kPreviousPrevRows  = Symbol('kPreviousPrevRows');
const kMultilineMove     = Symbol('kMultilineMove');
const kAddNewLineOnTTY   = Symbol('kAddNewLineOnTTY');
const kLastCommandErrored = Symbol('kLastCommandErrored');

const kLineObjectStream = Symbol('line object stream');
const kMultilinePrompt = Symbol('| ');
const kEmptyObject = Object.freeze(Object.create(null));

const kMaxUndoRedoStackSize = 2048;
const kMincrlfDelay = 100;
/**
 * The end of a line is signaled by either one of the following:
 *  - \r\n
 *  - \n
 *  - \r followed by something other than \n
 *  - \u2028 (Unicode 'LINE SEPARATOR')
 *  - \u2029 (Unicode 'PARAGRAPH SEPARATOR')
 */
const lineEnding = /\r?\n|\r(?!\n)|\u2028|\u2029/g;
const ESCAPE_CODE_TIMEOUT = 500;
const kMaxLengthOfKillRing = 32;
const kHistorySize = 30;

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

// Minimal inspect for the tab-completion error path
// ("Tab completion error: " + inspect(err)).
function inspectError(err) {
  if (err instanceof Error) return err.stack || String(err);
  return String(err);
}

// ---------------------------------------------------------------------------
// ReplHistory — in-memory port of Node's internal/repl/history.js.
//
// The file-persistence half of Node's ReplHistory (history file load/flush)
// needs fs/path/os; in a browser that surface is an honest no-op while the
// navigation API (addHistory, navigateToNext/Previous, history, index, size,
// isFlushing) behaves identically.
// ---------------------------------------------------------------------------

const kHSize = Symbol('kSize');
const kHHistory = Symbol('kHistory');
const kHIndex = Symbol('kIndex');
const kHRemoveDuplicates = Symbol('kRemoveHistoryDuplicates');
const kHIsFlushing = Symbol('kIsFlushing');

class ReplHistory {
  constructor(context, options) {
    options = options ?? {};
    if (options !== null && typeof options !== 'object') {
      throw new ERR_INVALID_ARG_TYPE('options', 'object', options);
    }
    if (typeof options.history !== 'undefined') {
      validateArray(options.history, 'history');
    }
    if (typeof options.size !== 'undefined') {
      validateNumber(options.size, 'size', 0);
    }
    this[kHRemoveDuplicates] = !!options.removeHistoryDuplicates;
    this[kHIsFlushing] = false;
    this[kHSize] = options.size ?? context.historySize ?? kHistorySize;
    if (typeof this[kHSize] !== 'number' || !(this[kHSize] >= 0)) {
      this[kHSize] = kHistorySize;
    }
    this[kHHistory] = options.history ?? [];
    this[kHIndex] = -1;
    this._context = context;
  }

  // No history file in the browser: immediately ready, in-memory only.
  initialize(onReadyCallback) {
    if (typeof onReadyCallback === 'function') {
      nextTick(onReadyCallback, null, this._context);
    }
  }

  addHistory(isMultiline, lastCommandErrored) {
    const line = this._context.line;

    if (line.length === 0) return '';

    // If the history is disabled then return the line
    if (this[kHSize] === 0) return line;

    // If the trimmed line is empty then return the line
    if (line.trim().length === 0) return line;

    // Necessary because each line would be saved in the history while
    // creating a new multiline, and we don't want that.
    if (isMultiline && this[kHIndex] === -1) {
      this[kHHistory].shift();
    } else if (lastCommandErrored) {
      // If the last command errored and we are trying to edit the history
      // to fix it, remove the broken one from the history.
      this[kHHistory].shift();
    }

    const normalizedLine = ReplHistory.normalizeLineEndings(line, '\n', '\r');

    if (this[kHHistory].length === 0 || this[kHHistory][0] !== normalizedLine) {
      if (this[kHRemoveDuplicates]) {
        const dupIndex = this[kHHistory].indexOf(normalizedLine);
        if (dupIndex !== -1) this[kHHistory].splice(dupIndex, 1);
      }

      // Add the new line to the history
      this[kHHistory].unshift(normalizedLine);

      // Only store so many
      if (this[kHHistory].length > this[kHSize]) this[kHHistory].pop();
    }

    this[kHIndex] = -1;

    const finalLine = isMultiline ? reverseString(this[kHHistory][0]) : this[kHHistory][0];

    // The listener could change the history object, possibly to remove the
    // last added entry if it is sensitive and should not be persisted in the
    // history, like a password.
    this._context.emit('history', this[kHHistory]);

    return finalLine;
  }

  canNavigateToNext() {
    return this[kHIndex] > -1 && this[kHHistory].length > 0;
  }

  navigateToNext(substringSearch) {
    if (!this.canNavigateToNext()) {
      return null;
    }
    const search = substringSearch || '';
    let index = this[kHIndex] - 1;

    while (
      index >= 0 &&
      (!this[kHHistory][index].startsWith(search) ||
        this._context.line === this[kHHistory][index])
    ) {
      index--;
    }

    this[kHIndex] = index;

    if (index === -1) {
      return search;
    }

    return ReplHistory.normalizeLineEndings(this[kHHistory][index], '\r', '\n');
  }

  canNavigateToPrevious() {
    return this[kHHistory].length !== this[kHIndex] && this[kHHistory].length > 0;
  }

  navigateToPrevious(substringSearch = '') {
    if (!this.canNavigateToPrevious()) {
      return null;
    }
    const search = substringSearch || '';
    let index = this[kHIndex] + 1;

    while (
      index < this[kHHistory].length &&
      (!this[kHHistory][index].startsWith(search) ||
        this._context.line === this[kHHistory][index])
    ) {
      index++;
    }

    this[kHIndex] = index;

    if (index === this[kHHistory].length) {
      return search;
    }

    return ReplHistory.normalizeLineEndings(this[kHHistory][index], '\r', '\n');
  }

  static normalizeLineEndings(line, from, to) {
    return line.split(from).join(to);
  }

  get size() { return this[kHSize]; }
  get isFlushing() { return this[kHIsFlushing]; }
  get history() { return this[kHHistory]; }
  set history(value) { this[kHHistory] = value; }
  get index() { return this[kHIndex]; }
  set index(value) { this[kHIndex] = value; }
}

// ---------------------------------------------------------------------------
// InterfaceConstructor — shared base for the callback and promises variants
// ---------------------------------------------------------------------------

function InterfaceConstructor(input, output, completer, terminal) {
  this[kSawReturnAt] = 0;
  // TODO(BridgeAR): Document this property. The name is not ideal, so we
  // might want to expose an alias and document that instead.
  this.isCompletionEnabled = true;
  this[kSawKeyPress] = false;
  this[kPreviousKey] = null;
  this.escapeCodeTimeout = ESCAPE_CODE_TIMEOUT;
  this.tabSize = 8;

  // Our events.js EventEmitter is a real class (not .call-able like Node's
  // internal one); EventEmitter.init is the plain-function initializer.
  EventEmitter.init.call(this);

  let crlfDelay;
  let prompt = '> ';
  let signal;
  let historyOptions;

  if (input?.input) {
    // An options object was given
    output = input.output;
    completer = input.completer;
    terminal = input.terminal;
    signal = input.signal;

    // It is possible to configure the history through the input object
    const historySize = input.historySize;
    const history = input.history;
    const removeHistoryDuplicates = input.removeHistoryDuplicates;

    if (input.tabSize !== undefined) {
      validateUint32(input.tabSize, 'tabSize', true);
      this.tabSize = input.tabSize;
    }
    if (input.prompt !== undefined) {
      prompt = input.prompt;
    }
    if (input.escapeCodeTimeout !== undefined) {
      if (Number.isFinite(input.escapeCodeTimeout)) {
        this.escapeCodeTimeout = input.escapeCodeTimeout;
      } else {
        throw new ERR_INVALID_ARG_VALUE(
          'input.escapeCodeTimeout',
          this.escapeCodeTimeout,
        );
      }
    }

    if (signal) {
      validateAbortSignal(signal, 'options.signal');
    }

    crlfDelay = input.crlfDelay;
    input = input.input;

    historyOptions = {
      __proto__: null,
      size: historySize,
      history,
      removeHistoryDuplicates,
    };
  }

  this.setupHistoryManager(historyOptions ?? input);

  if (completer !== undefined && typeof completer !== 'function') {
    throw new ERR_INVALID_ARG_VALUE('completer', completer);
  }

  // Backwards compat; check the isTTY prop of the output stream
  // when `terminal` was not specified
  if (terminal === undefined && !(output === null || output === undefined)) {
    terminal = !!output.isTTY;
  }

  const self = this;

  this.line = '';
  this[kIsMultiline] = false;
  this[kSubstringSearch] = null;
  this.output = output;
  this.input = input;
  this[kUndoStack] = [];
  this[kRedoStack] = [];
  this[kPreviousCursorCols] = -1;

  // The kill ring is a global list of blocks of text that were previously
  // killed (deleted). If its size exceeds kMaxLengthOfKillRing, the oldest
  // element will be removed to make room for the latest deletion.
  this[kKillRing] = [];
  this[kKillRingCursor] = 0;

  this.crlfDelay = crlfDelay ?
    Math.max(kMincrlfDelay, crlfDelay) :
    kMincrlfDelay;
  this.completer = completer;

  this.setPrompt(prompt);

  this.terminal = !!terminal;

  function onerror(err) {
    self.emit('error', err);
  }

  function ondata(data) {
    self[kNormalWrite](data);
  }

  function onend() {
    if (
      typeof self[kLine_buffer] === 'string' &&
        self[kLine_buffer].length > 0
    ) {
      self.emit('line', self[kLine_buffer]);
    }
    self.close();
  }

  function ontermend() {
    if (typeof self.line === 'string' && self.line.length > 0) {
      self.emit('line', self.line);
    }
    self.close();
  }

  function onkeypress(s, key) {
    self[kTtyWrite](s, key);
    if (key?.sequence) {
      // If the key.sequence is half of a surrogate pair
      // (>= 0xd800 and <= 0xdfff), refresh the line so
      // the character is displayed appropriately.
      const ch = key.sequence.codePointAt(0);
      if (ch >= 0xd800 && ch <= 0xdfff) self[kRefreshLine]();
    }
  }

  function onresize() {
    self[kRefreshLine]();
  }

  this[kLineObjectStream] = undefined;

  input.on('error', onerror);

  if (!this.terminal) {
    function onSelfCloseWithoutTerminal() {
      input.removeListener('data', ondata);
      input.removeListener('error', onerror);
      input.removeListener('end', onend);
    }

    input.on('data', ondata);
    input.on('end', onend);
    self.once('close', onSelfCloseWithoutTerminal);
    this[kDecoder] = new StringDecoder('utf8');
  } else {
    function onSelfCloseWithTerminal() {
      input.removeListener('keypress', onkeypress);
      input.removeListener('error', onerror);
      input.removeListener('end', ontermend);
      if (output !== null && output !== undefined) {
        output.removeListener('resize', onresize);
      }
    }

    emitKeypressEvents(input, this);

    // `input` usually refers to stdin
    input.on('keypress', onkeypress);
    input.on('end', ontermend);

    this[kSetRawMode](true);
    this.terminal = true;

    // Cursor position on the line.
    this.cursor = 0;

    if (output !== null && output !== undefined)
      output.on('resize', onresize);

    self.once('close', onSelfCloseWithTerminal);
  }

  if (signal) {
    const onAborted = () => self.close();
    if (signal.aborted) {
      nextTick(onAborted);
    } else {
      const disposable = addAbortListener(signal, onAborted);
      self.once('close', () => disposable[Symbol.dispose]());
    }
  }

  // Current line
  this[kSetLine]('');

  input.resume();
}

Object.setPrototypeOf(InterfaceConstructor.prototype, EventEmitter.prototype);
Object.setPrototypeOf(InterfaceConstructor, EventEmitter);

// Shared descriptors for the history accessors defined on each instance.
const kHistoryAccessorDescriptors = {
  __proto__: null,
  history: {
    __proto__: null, configurable: true, enumerable: true,
    get() { return this.historyManager.history; },
    set(newHistory) { return this.historyManager.history = newHistory; },
  },
  historyIndex: {
    __proto__: null, configurable: true, enumerable: true,
    get() { return this.historyManager.index; },
    set(historyIndex) { return this.historyManager.index = historyIndex; },
  },
  historySize: {
    __proto__: null, configurable: true, enumerable: true,
    get() { return this.historyManager.size; },
  },
  isFlushing: {
    __proto__: null, configurable: true, enumerable: true,
    get() { return this.historyManager.isFlushing; },
  },
};

class _Interface extends InterfaceConstructor {
  get columns() {
    if (this.output?.columns) return this.output.columns;
    return Infinity;
  }

  /**
   * Sets the prompt written to the output.
   * @param {string} prompt
   * @returns {void}
   */
  setPrompt(prompt) {
    this[kPrompt] = prompt;
  }

  /**
   * Returns the current prompt used by `rl.prompt()`.
   * @returns {string}
   */
  getPrompt() {
    return this[kPrompt];
  }

  setupHistoryManager(options) {
    this.historyManager = new ReplHistory(this, options);

    if (options.onHistoryFileLoaded) {
      this.historyManager.initialize(options.onHistoryFileLoaded);
    }

    Object.defineProperties(this, kHistoryAccessorDescriptors);
  }

  [kSetRawMode](mode) {
    const wasInRawMode = this.input.isRaw;

    if (typeof this.input.setRawMode === 'function') {
      this.input.setRawMode(mode);
    }

    return wasInRawMode;
  }

  /**
   * Writes the configured `prompt` to a new line in `output`.
   * @param {boolean} [preserveCursor]
   * @returns {void}
   */
  prompt(preserveCursor) {
    if (this.paused) this.resume();
    if (this.terminal && getTerm() !== 'dumb') {
      if (!preserveCursor) this.cursor = 0;
      this[kRefreshLine]();
    } else {
      this[kWriteToOutput](this[kPrompt]);
    }
  }

  [kQuestion](query, cb) {
    if (this.closed) {
      throw new ERR_USE_AFTER_CLOSE('readline');
    }
    if (this[kQuestionCallback]) {
      this.prompt();
    } else {
      this[kOldPrompt] = this[kPrompt];
      this.setPrompt(query);
      this[kQuestionCallback] = cb;
      this.prompt();
    }
  }

  [kSetLine](line = '') {
    this.line = line;
    this[kIsMultiline] = line.includes('\n');
  }

  [kOnLine](line) {
    if (this[kQuestionCallback]) {
      const cb = this[kQuestionCallback];
      this[kQuestionCallback] = null;
      this.setPrompt(this[kOldPrompt]);
      cb(line);
    } else {
      this.emit('line', line);
    }
  }

  [kBeforeEdit](oldText, oldCursor) {
    this[kPushToUndoStack](oldText, oldCursor);
  }

  [kQuestionCancel]() {
    if (this[kQuestionCallback]) {
      this[kQuestionCallback] = null;
      this.setPrompt(this[kOldPrompt]);
      this.clearLine();
    }
  }

  [kWriteToOutput](stringToWrite) {
    validateString(stringToWrite, 'stringToWrite');

    if (this.output !== null && this.output !== undefined) {
      this.output.write(stringToWrite);
    }
  }

  [kAddHistory]() {
    return this.historyManager.addHistory(this[kIsMultiline], this[kLastCommandErrored]);
  }

  [kRefreshLine]() {
    // line length
    const line = this[kPrompt] + this.line;
    const dispPos = this[kGetDisplayPos](line);
    const lineCols = dispPos.cols;
    const lineRows = dispPos.rows;

    // cursor position
    const cursorPos = this.getCursorPos();

    // First move to the bottom of the current line, based on cursor pos
    const prevRows = this.prevRows || 0;
    if (prevRows > 0) {
      moveCursor(this.output, 0, -prevRows);
    }

    // Cursor to left edge.
    cursorTo(this.output, 0);
    // erase data
    clearScreenDown(this.output);

    if (this[kIsMultiline]) {
      const lines = this.line.split('\n');
      // Write first line with normal prompt
      this[kWriteToOutput](this[kPrompt] + lines[0]);

      // For continuation lines, add the "|" prefix
      for (let i = 1; i < lines.length; i++) {
        this[kWriteToOutput](`\n${kMultilinePrompt.description}` + lines[i]);
      }
    } else {
      // Write the prompt and the current buffer content.
      this[kWriteToOutput](line);
    }

    // Force terminal to allocate a new line
    if (lineCols === 0) {
      this[kWriteToOutput](' ');
    }

    // Move cursor to original position.
    cursorTo(this.output, cursorPos.cols);

    const diff = lineRows - cursorPos.rows;
    if (diff > 0) {
      moveCursor(this.output, 0, -diff);
    }

    this.prevRows = cursorPos.rows;
  }

  /**
   * Closes the `readline.Interface` instance.
   * @returns {void}
   */
  close() {
    if (this.closed) return;
    this.pause();
    if (this.terminal) {
      this[kSetRawMode](false);
    }
    this.closed = true;
    this.emit('close');
  }

  /**
   * Pauses the `input` stream.
   * @returns {void | Interface}
   */
  pause() {
    if (this.closed) {
      throw new ERR_USE_AFTER_CLOSE('readline');
    }
    if (this.paused) return;
    this.input.pause();
    this.paused = true;
    this.emit('pause');
    return this;
  }

  /**
   * Resumes the `input` stream if paused.
   * @returns {void | Interface}
   */
  resume() {
    if (this.closed) {
      throw new ERR_USE_AFTER_CLOSE('readline');
    }
    if (!this.paused) return;
    this.input.resume();
    this.paused = false;
    this.emit('resume');
    return this;
  }

  /**
   * Writes either `data` or a `key` sequence identified by
   * `key` to the `output`.
   * @param {string} d
   * @param {{ ctrl?: boolean; meta?: boolean; shift?: boolean; name?: string; }} [key]
   * @returns {void}
   */
  write(d, key) {
    if (this.closed) {
      throw new ERR_USE_AFTER_CLOSE('readline');
    }
    if (this.paused) this.resume();
    if (this.terminal) {
      this[kTtyWrite](d, key);
    } else {
      this[kNormalWrite](d);
    }
  }

  [kNormalWrite](b) {
    if (b === undefined) {
      return;
    }
    let string = this[kDecoder].write(b);
    if (
      this[kSawReturnAt] &&
      Date.now() - this[kSawReturnAt] <= this.crlfDelay
    ) {
      if (string.codePointAt(0) === 10) string = string.slice(1);
      this[kSawReturnAt] = 0;
    }

    if (!string) {
      return;
    }

    // Split the new string chunk, not the entire line buffer.
    const lines =
      string.includes('\r') ||
      string.includes('\u2028') ||
      string.includes('\u2029') ?
        string.split(lineEnding) :
        string.split('\n');
    // Reset the global regex state (split with /g/ advances lastIndex).
    lineEnding.lastIndex = 0;
    const lastIndex = lines.length - 1;
    if (lastIndex === 0) {
      // No line endings this time, save what we have for next time.
      if (this[kLine_buffer]) {
        this[kLine_buffer] += string;
      } else {
        this[kLine_buffer] = string;
      }
      return;
    }

    this[kSawReturnAt] = string.endsWith('\r') ?
      Date.now() :
      0;

    let first = lines[0];
    if (this[kLine_buffer]) {
      first = this[kLine_buffer] + first;
    }
    // Either '' or (conceivably) the unfinished portion of the next line
    this[kLine_buffer] = lines[lastIndex];
    this[kOnLine](first);
    for (let i = 1; i < lastIndex; i++) {
      this[kOnLine](lines[i]);
    }
  }

  [kInsertString](c) {
    this[kBeforeEdit](this.line, this.cursor);
    if (!this.isCompletionEnabled) {
      if (this.cursor < this.line.length) {
        const beg = this.line.slice(0, this.cursor);
        const end = this.line.slice(
          this.cursor,
          this.line.length,
        );
        this.line = beg + c + end;
      } else {
        this.line += c;
      }
      this.cursor += c.length;
      this[kWriteToOutput](c);
      return;
    }
    if (this.cursor < this.line.length) {
      const beg = this.line.slice(0, this.cursor);
      const end = this.line.slice(
        this.cursor,
        this.line.length,
      );
      this[kSetLine](beg + c + end);
      this.cursor += c.length;
      this[kRefreshLine]();
    } else {
      const oldPos = this.getCursorPos();
      this.line += c;
      this.cursor += c.length;
      const newPos = this.getCursorPos();

      if (oldPos.rows < newPos.rows) {
        this[kRefreshLine]();
      } else {
        this[kWriteToOutput](c);
      }
    }
  }

  async [kTabComplete](lastKeypressWasTab) {
    this.pause();
    const string = this.line.slice(0, this.cursor);
    let value;
    try {
      value = await this.completer(string);
    } catch (err) {
      this[kWriteToOutput](`Tab completion error: ${inspectError(err)}`);
      return;
    } finally {
      this.resume();
    }
    this[kTabCompleter](lastKeypressWasTab, value);
  }

  [kTabCompleter](lastKeypressWasTab, { 0: completions, 1: completeOn }) {
    // Result and the text that was completed.

    if (!completions || completions.length === 0) {
      return;
    }

    // If there is a common prefix to all matches, then apply that portion.
    const prefix = commonPrefix(
      completions.filter((e) => e !== ''),
    );
    if (prefix.startsWith(completeOn) &&
        prefix.length > completeOn.length) {
      this[kInsertString](prefix.slice(completeOn.length));
      return;
    } else if (!completeOn.startsWith(prefix)) {
      this[kSetLine](this.line.slice(0, this.cursor - completeOn.length) +
                  prefix +
                  this.line.slice(this.cursor, this.line.length));
      this.cursor = this.cursor - completeOn.length + prefix.length;
      this[kRefreshLine]();
      return;
    }

    if (!lastKeypressWasTab) {
      return;
    }

    this[kBeforeEdit](this.line, this.cursor);

    // Apply/show completions.
    const completionsWidth = completions.map((e) =>
      getStringWidth(e),
    );
    const width = Math.max(...completionsWidth) + 2; // 2 space padding
    let maxColumns = Math.floor(this.columns / width) || 1;
    if (maxColumns === Infinity) {
      maxColumns = 1;
    }
    let output = '\r\n';
    let lineIndex = 0;
    let whitespace = 0;
    for (let i = 0; i < completions.length; i++) {
      const completion = completions[i];
      if (completion === '' || lineIndex === maxColumns) {
        output += '\r\n';
        lineIndex = 0;
        whitespace = 0;
      } else {
        output += ' '.repeat(whitespace);
      }
      if (completion !== '') {
        output += completion;
        whitespace = width - completionsWidth[i];
        lineIndex++;
      } else {
        output += '\r\n';
      }
    }
    if (lineIndex !== 0) {
      output += '\r\n\r\n';
    }
    this[kWriteToOutput](output);
    this[kRefreshLine]();
  }

  [kWordLeft]() {
    if (this.cursor > 0) {
      // Reverse the string and match a word near beginning
      // to avoid quadratic time complexity
      const leading = this.line.slice(0, this.cursor);
      const reversed = [...leading].reverse().join('');
      const match = /^\s*(?:[^\w\s]+|\w+)?/.exec(reversed);
      this[kMoveCursor](-match[0].length);
    }
  }

  [kWordRight]() {
    if (this.cursor < this.line.length) {
      const trailing = this.line.slice(this.cursor);
      const match = /^(?:\s+|[^\w\s]+|\w+)\s*/.exec(trailing);
      this[kMoveCursor](match[0].length);
    }
  }

  [kDeleteLeft]() {
    if (this.cursor > 0 && this.line.length > 0) {
      this[kBeforeEdit](this.line, this.cursor);
      // The number of UTF-16 units comprising the character to the left
      const charSize = charLengthLeft(this.line, this.cursor);
      this.line =
        this.line.slice(0, this.cursor - charSize) +
        this.line.slice(this.cursor, this.line.length);

      this.cursor -= charSize;
      this[kRefreshLine]();
    }
  }

  [kDeleteRight]() {
    if (this.cursor < this.line.length) {
      this[kBeforeEdit](this.line, this.cursor);
      // The number of UTF-16 units comprising the character to the left
      const charSize = charLengthAt(this.line, this.cursor);
      this.line =
        this.line.slice(0, this.cursor) +
        this.line.slice(
          this.cursor + charSize,
          this.line.length,
        );
      this[kRefreshLine]();
    }
  }

  [kDeleteWordLeft]() {
    if (this.cursor > 0) {
      this[kBeforeEdit](this.line, this.cursor);
      // Reverse the string and match a word near beginning
      // to avoid quadratic time complexity
      let leading = this.line.slice(0, this.cursor);
      const reversed = [...leading].reverse().join('');
      const match = /^\s*(?:[^\w\s]+|\w+)?/.exec(reversed);
      leading = leading.slice(
        0,
        leading.length - match[0].length,
      );
      this.line =
        leading +
        this.line.slice(this.cursor, this.line.length);
      this.cursor = leading.length;
      this[kRefreshLine]();
    }
  }

  [kDeleteWordRight]() {
    if (this.cursor < this.line.length) {
      this[kBeforeEdit](this.line, this.cursor);
      const trailing = this.line.slice(this.cursor);
      const match = /^(?:\s+|\W+|\w+)\s*/.exec(trailing);
      this.line =
        this.line.slice(0, this.cursor) +
        trailing.slice(match[0].length);
      this[kRefreshLine]();
    }
  }

  [kDeleteLineLeft]() {
    this[kBeforeEdit](this.line, this.cursor);
    const del = this.line.slice(0, this.cursor);
    this[kSetLine](this.line.slice(this.cursor));
    this.cursor = 0;
    this[kPushToKillRing](del);
    this[kRefreshLine]();
  }

  [kDeleteLineRight]() {
    this[kBeforeEdit](this.line, this.cursor);
    const del = this.line.slice(this.cursor);
    this[kSetLine](this.line.slice(0, this.cursor));
    this[kPushToKillRing](del);
    this[kRefreshLine]();
  }

  [kPushToKillRing](del) {
    if (!del || del === this[kKillRing][0]) return;
    this[kKillRing].unshift(del);
    this[kKillRingCursor] = 0;
    while (this[kKillRing].length > kMaxLengthOfKillRing)
      this[kKillRing].pop();
  }

  [kYank]() {
    if (this[kKillRing].length > 0) {
      this[kYanking] = true;
      this[kInsertString](this[kKillRing][this[kKillRingCursor]]);
    }
  }

  [kYankPop]() {
    if (!this[kYanking]) {
      return;
    }
    if (this[kKillRing].length > 1) {
      const lastYank = this[kKillRing][this[kKillRingCursor]];
      this[kKillRingCursor]++;
      if (this[kKillRingCursor] >= this[kKillRing].length) {
        this[kKillRingCursor] = 0;
      }
      const currentYank = this[kKillRing][this[kKillRingCursor]];
      const head = this.line.slice(0, this.cursor - lastYank.length);
      const tail = this.line.slice(this.cursor);
      this[kSetLine](head + currentYank + tail);
      this.cursor = head.length + currentYank.length;
      this[kRefreshLine]();
    }
  }

  [kSavePreviousState]() {
    this[kPreviousLine] = this.line;
    this[kPreviousCursor] = this.cursor;
    this[kPreviousPrevRows] = this.prevRows;
  }

  [kRestorePreviousState]() {
    this[kSetLine](this[kPreviousLine]);
    this.cursor = this[kPreviousCursor];
    this.prevRows = this[kPreviousPrevRows];
  }

  clearLine() {
    this[kMoveCursor](+Infinity);
    this[kWriteToOutput]('\r\n');
    this[kSetLine]('');
    this.cursor = 0;
    this.prevRows = 0;
  }

  [kLine]() {
    this[kSavePreviousState]();
    const line = this[kAddHistory]();
    this[kUndoStack] = [];
    this[kRedoStack] = [];
    this.clearLine();
    this[kOnLine](line);
  }

  [kAddNewLineOnTTY]() {
    // Restore terminal state and store current line
    this[kRestorePreviousState]();
    const originalLine = this.line;

    // Split the line at the current cursor position
    const beforeCursor = this.line.slice(0, this.cursor);
    let afterCursor = this.line.slice(this.cursor, this.line.length);

    // Add the new line where the cursor is at
    this[kSetLine](`${beforeCursor}\n${afterCursor}`);

    // To account for the new line
    this.cursor += 1;

    const hasContentAfterCursor = afterCursor.length > 0;
    const cursorIsNotOnFirstLine = this.prevRows > 0;
    let needsRewriteFirstLine = false;

    // Handle cursor positioning based on different scenarios
    if (hasContentAfterCursor) {
      const splitBeg = beforeCursor.split('\n');
      // Determine if we need to rewrite the first line
      needsRewriteFirstLine = splitBeg.length < 2;

      // If the cursor is not on the first line
      if (cursorIsNotOnFirstLine) {
        const splitEnd = afterCursor.split('\n');

        const dy = splitEnd.length + 1;

        // Calculate how many Xs we need to move on the right to get to the end of the line
        const dxEndOfLineAbove = (splitBeg[splitBeg.length - 2] || '').length + kMultilinePrompt.description.length;
        moveCursor(this.output, dxEndOfLineAbove, -dy);

        afterCursor = `${splitBeg[splitBeg.length - 1]}\n${afterCursor}`;
      } else {
        // Otherwise, go to the very beginning of the first line and erase everything
        const dy = originalLine.split('\n').length;
        moveCursor(this.output, 0, -dy);
      }

      // Erase from the cursor to the end of the line
      clearScreenDown(this.output);

      if (cursorIsNotOnFirstLine) {
        this[kWriteToOutput]('\n');
      }
    }

    if (needsRewriteFirstLine) {
      this[kWriteToOutput](`${this[kPrompt]}${beforeCursor}\n${kMultilinePrompt.description}`);
    } else {
      this[kWriteToOutput](kMultilinePrompt.description);
    }

    // Write the rest and restore the cursor to where the user left it
    if (hasContentAfterCursor) {
      // Save the cursor pos, we need to come back here
      const oldCursor = this.getCursorPos();

      // Write everything after the cursor which has been deleted by clearScreenDown
      const formattedEndContent = afterCursor.replaceAll(
        '\n',
        `\n${kMultilinePrompt.description}`,
      );

      this[kWriteToOutput](formattedEndContent);

      const newCursor = this[kGetDisplayPos](this.line);

      // Go back to where the cursor was, with relative movement
      moveCursor(this.output, oldCursor.cols - newCursor.cols, oldCursor.rows - newCursor.rows);

      // Setting how many rows we have on top of the cursor
      // Necessary for kRefreshLine
      this.prevRows = oldCursor.rows;
    } else {
      // Setting how many rows we have on top of the cursor
      // Necessary for kRefreshLine
      this.prevRows = this.line.split('\n').length - 1;
    }
  }

  [kPushToUndoStack](text, cursor) {
    if (this[kUndoStack].push({ text, cursor }) >
        kMaxUndoRedoStackSize) {
      this[kUndoStack].shift();
    }
  }

  [kUndo]() {
    if (this[kUndoStack].length <= 0) return;

    this[kRedoStack].push(
      { text: this.line, cursor: this.cursor },
    );

    const entry = this[kUndoStack].pop();
    this[kSetLine](entry.text);
    this.cursor = entry.cursor;

    this[kRefreshLine]();
  }

  [kRedo]() {
    if (this[kRedoStack].length <= 0) return;

    this[kUndoStack].push(
      { text: this.line, cursor: this.cursor },
    );

    const entry = this[kRedoStack].pop();
    this[kSetLine](entry.text);
    this.cursor = entry.cursor;

    this[kRefreshLine]();
  }

  [kMultilineMove](direction, splitLines, { rows, cols }) {
    const curr = splitLines[rows];
    const down = direction === 1;
    const adj = splitLines[rows + direction];
    const promptLen = kMultilinePrompt.description.length;
    let amountToMove;
    // Clamp distance to end of current + prompt + next/prev line + newline
    const clamp = down ?
      curr.length - cols + promptLen + adj.length + 1 :
      -cols + 1;
    const shouldClamp = cols > adj.length + 1;

    if (shouldClamp) {
      if (this[kPreviousCursorCols] === -1) {
        this[kPreviousCursorCols] = cols;
      }
      amountToMove = clamp;
    } else {
      if (down) {
        amountToMove = curr.length + 1;
      } else {
        amountToMove = -adj.length - 1;
      }
      if (this[kPreviousCursorCols] !== -1) {
        if (this[kPreviousCursorCols] <= adj.length) {
          amountToMove += this[kPreviousCursorCols] - cols;
          this[kPreviousCursorCols] = -1;
        } else {
          amountToMove = clamp;
        }
      }
    }

    this[kMoveCursor](amountToMove);
  }

  [kMoveDownOrHistoryNext]() {
    const cursorPos = this.getCursorPos();
    const splitLines = this.line.split('\n');
    if (this[kIsMultiline] && cursorPos.rows < splitLines.length - 1) {
      this[kMultilineMove](1, splitLines, cursorPos);
      return;
    }
    this[kPreviousCursorCols] = -1;
    this[kHistoryNext]();
  }

  [kHistoryNext]() {
    if (!this.historyManager.canNavigateToNext()) { return; }

    this[kBeforeEdit](this.line, this.cursor);
    this[kSetLine](this.historyManager.navigateToNext(this[kSubstringSearch]));
    this.cursor = this.line.length; // Set cursor to end of line.
    this[kRefreshLine]();
  }

  [kMoveUpOrHistoryPrev]() {
    const cursorPos = this.getCursorPos();
    if (this[kIsMultiline] && cursorPos.rows > 0) {
      const splitLines = this.line.split('\n');
      this[kMultilineMove](-1, splitLines, cursorPos);
      return;
    }
    this[kPreviousCursorCols] = -1;
    this[kHistoryPrev]();
  }

  [kHistoryPrev]() {
    if (!this.historyManager.canNavigateToPrevious()) { return; }

    this[kBeforeEdit](this.line, this.cursor);
    this[kSetLine](this.historyManager.navigateToPrevious(this[kSubstringSearch]));
    this.cursor = this.line.length; // Set cursor to end of line.
    this[kRefreshLine]();
  }

  // Returns the last character's display position of the given string
  [kGetDisplayPos](str) {
    let offset = 0;
    const col = this.columns;
    let rows = 0;
    str = stripVTControlCharacters(str);

    for (const char of str) {
      if (char === '\n') {
        // Rows must be incremented by 1 even if offset = 0 or col = +Infinity.
        rows += Math.ceil(offset / col) || 1;
        // Only add prefix offset for continuation lines in user input (not prompts)
        offset = this[kIsMultiline] ? kMultilinePrompt.description.length : 0;
        continue;
      }
      // Tabs must be aligned by an offset of the tab size.
      if (char === '\t') {
        offset += this.tabSize - (offset % this.tabSize);
        continue;
      }
      const width = getStringWidth(char, false /* stripVTControlCharacters */);
      if (width === 0 || width === 1) {
        offset += width;
      } else {
        // width === 2
        if ((offset + 1) % col === 0) {
          offset++;
        }
        offset += 2;
      }
    }

    const cols = offset % col;
    rows += (offset - cols) / col;

    return { cols, rows };
  }

  /**
   * Returns the real position of the cursor in relation
   * to the input prompt + string.
   * @returns {{ rows: number; cols: number; }}
   */
  getCursorPos() {
    const strBeforeCursor = this[kPrompt] + this.line.slice(0, this.cursor);

    return this[kGetDisplayPos](strBeforeCursor);
  }

  // This function moves cursor dx places to the right
  // (-dx for left) and refreshes the line if it is needed.
  [kMoveCursor](dx) {
    if (dx === 0) {
      return;
    }
    const oldPos = this.getCursorPos();
    this.cursor += dx;

    // Bounds check
    if (this.cursor < 0) {
      this.cursor = 0;
    } else if (this.cursor > this.line.length) {
      this.cursor = this.line.length;
    }

    const newPos = this.getCursorPos();

    // Check if cursor stayed on the line.
    if (oldPos.rows === newPos.rows) {
      const diffWidth = newPos.cols - oldPos.cols;
      moveCursor(this.output, diffWidth, 0);
    } else {
      this[kRefreshLine]();
    }
  }

  // Handle a write from the tty
  [kTtyWrite](s, key) {
    const previousKey = this[kPreviousKey];
    key ||= kEmptyObject;
    this[kPreviousKey] = key;
    let shouldResetPreviousCursorCols = true;

    if (!key.meta || key.name !== 'y') {
      // Reset yanking state unless we are doing yank pop.
      this[kYanking] = false;
    }

    // Activate or deactivate substring search.
    if (
      (key.name === 'up' || key.name === 'down') &&
      !key.ctrl &&
      !key.meta &&
      !key.shift
    ) {
      if (this[kSubstringSearch] === null && !this[kIsMultiline]) {
        this[kSubstringSearch] = this.line.slice(
          0,
          this.cursor,
        );
      }
    } else if (this[kSubstringSearch] !== null) {
      this[kSubstringSearch] = null;
      // Reset the index in case there's no match.
      if (this.history.length === this.historyIndex) {
        this.historyIndex = -1;
      }
    }

    // Undo & Redo
    if (typeof key.sequence === 'string') {
      switch (key.sequence.codePointAt(0)) {
        case 0x1f:
          this[kUndo]();
          return;
        case 0x1e:
          this[kRedo]();
          return;
        default:
          break;
      }
    }

    // Ignore escape key, fixes
    // https://github.com/nodejs/node-v0.x-archive/issues/2876.
    if (key.name === 'escape') return;

    if (key.ctrl && key.shift) {
      /* Control and shift pressed */
      switch (key.name) {
        // TODO(BridgeAR): The transmitted escape sequence is `\b` and that is
        // identical to <ctrl>-h. It should have a unique escape sequence.
        case 'backspace':
          this[kDeleteLineLeft]();
          break;

        case 'delete':
          this[kDeleteLineRight]();
          break;
      }
    } else if (key.ctrl) {
      /* Control key pressed */

      switch (key.name) {
        case 'c':
          if (this.listenerCount('SIGINT') > 0) {
            this.emit('SIGINT');
          } else {
            // This readline instance is finished
            this.close();
            this[kQuestionReject]?.(new AbortError('Aborted with Ctrl+C'));
          }
          break;

        case 'h': // delete left
          this[kDeleteLeft]();
          break;

        case 'd': // delete right or EOF
          if (this.cursor === 0 && this.line.length === 0) {
            // This readline instance is finished
            this.close();
            this[kQuestionReject]?.(new AbortError('Aborted with Ctrl+D'));
          } else if (this.cursor < this.line.length) {
            this[kDeleteRight]();
          }
          break;

        case 'u': // Delete from current to start of line
          this[kDeleteLineLeft]();
          break;

        case 'k': // Delete from current to end of line
          this[kDeleteLineRight]();
          break;

        case 'a': // Go to the start of the line
          this[kMoveCursor](-Infinity);
          break;

        case 'e': // Go to the end of the line
          this[kMoveCursor](+Infinity);
          break;

        case 'b': // back one character
          this[kMoveCursor](-charLengthLeft(this.line, this.cursor));
          break;

        case 'f': // Forward one character
          this[kMoveCursor](+charLengthAt(this.line, this.cursor));
          break;

        case 'l': // Clear the whole screen
          cursorTo(this.output, 0, 0);
          clearScreenDown(this.output);
          this[kRefreshLine]();
          break;

        case 'n': // next history item
          this[kHistoryNext]();
          break;

        case 'p': // Previous history item
          this[kHistoryPrev]();
          break;

        case 'y': // Yank killed string
          this[kYank]();
          break;

        case 'z': {
          const proc = getProcess();
          if (proc && proc.platform === 'win32') break;
          if (this.listenerCount('SIGTSTP') > 0) {
            this.emit('SIGTSTP');
          } else if (proc && typeof proc.kill === 'function' && typeof proc.once === 'function') {
            proc.once('SIGCONT', () => {
              // Don't raise events if stream has already been abandoned.
              if (!this.paused) {
                // Stream must be paused and resumed after SIGCONT to catch
                // SIGINT, SIGTSTP, and EOF.
                this.pause();
                this.emit('SIGCONT');
              }
              // Explicitly re-enable "raw mode" and move the cursor to
              // the correct position.
              this[kSetRawMode](true);
              this[kRefreshLine]();
            });
            this[kSetRawMode](false);
            proc.kill(proc.pid, 'SIGTSTP');
          }
          // Without a host process (browser) this is a no-op unless a
          // SIGTSTP listener was registered above.
          break;
        }

        case 'w': // Delete backwards to a word boundary
        // TODO(BridgeAR): The transmitted escape sequence is `\b` and that is
        // identical to <ctrl>-h. It should have a unique escape sequence.
        // Falls through
        case 'backspace':
          this[kDeleteWordLeft]();
          break;

        case 'delete': // Delete forward to a word boundary
          this[kDeleteWordRight]();
          break;

        case 'left':
          this[kWordLeft]();
          break;

        case 'right':
          this[kWordRight]();
          break;
      }
    } else if (key.meta) {
      /* Meta key pressed */

      switch (key.name) {
        case 'b': // backward word
          this[kWordLeft]();
          break;

        case 'f': // forward word
          this[kWordRight]();
          break;

        case 'd': // delete forward word
        case 'delete':
          this[kDeleteWordRight]();
          break;

        case 'backspace': // Delete backwards to a word boundary
          this[kDeleteWordLeft]();
          break;

        case 'y': // Doing yank pop
          this[kYankPop]();
          break;
      }
    } else {
      /* No modifier keys used */

      // \r bookkeeping is only relevant if a \n comes right after.
      if (this[kSawReturnAt] && key.name !== 'enter') this[kSawReturnAt] = 0;

      switch (key.name) {
        case 'return': // Carriage return, i.e. \r
          this[kSawReturnAt] = Date.now();
          this[kLine]();
          break;

        case 'enter':
          // When key interval > crlfDelay
          if (
            this[kSawReturnAt] === 0 ||
            Date.now() - this[kSawReturnAt] > this.crlfDelay
          ) {
            this[kLine]();
          }
          this[kSawReturnAt] = 0;
          break;

        case 'backspace':
          this[kDeleteLeft]();
          break;

        case 'delete':
          this[kDeleteRight]();
          break;

        case 'left':
          // Obtain the code point to the left
          this[kMoveCursor](-charLengthLeft(this.line, this.cursor));
          break;

        case 'right':
          this[kMoveCursor](+charLengthAt(this.line, this.cursor));
          break;

        case 'home':
          this[kMoveCursor](-Infinity);
          break;

        case 'end':
          this[kMoveCursor](+Infinity);
          break;

        case 'up':
          shouldResetPreviousCursorCols = false;
          this[kMoveUpOrHistoryPrev]();
          break;

        case 'down':
          shouldResetPreviousCursorCols = false;
          this[kMoveDownOrHistoryNext]();
          break;

        case 'tab':
          // If tab completion enabled, do that...
          if (
            typeof this.completer === 'function' &&
            this.isCompletionEnabled
          ) {
            const lastKeypressWasTab =
              previousKey && previousKey.name === 'tab';
            this[kTabComplete](lastKeypressWasTab);
            break;
          }
        // falls through
        default:
          if (typeof s === 'string' && s) {
            // Erase state of previous searches.
            lineEnding.lastIndex = 0;
            let nextMatch;
            // Keep track of the end of the last match.
            let lastIndex = 0;
            while ((nextMatch = lineEnding.exec(s)) !== null) {
              this[kInsertString](s.slice(lastIndex, nextMatch.index));
              ({ lastIndex } = lineEnding);
              this[kLine]();
              // Restore lastIndex as the call to kLine could have mutated it.
              lineEnding.lastIndex = lastIndex;
            }
            // This ensures that the last line is written if it doesn't end in a newline.
            // Note that the last line may be the first line, in which case this still works.
            this[kInsertString](s.slice(lastIndex));
          }
      }
    }
    if (shouldResetPreviousCursorCols) {
      this[kPreviousCursorCols] = -1;
    }
  }

  /**
   * Creates an `AsyncIterator` object that iterates through
   * each line in the input stream as a string.
   * @returns {AsyncIterableIterator<string>}
   */
  [Symbol.asyncIterator]() {
    if (this[kLineObjectStream] === undefined) {
      const kFirstEventParam = Symbol.for('nodejs.kFirstEventParam');
      this[kLineObjectStream] = EventEmitter.on(
        this, 'line', {
          close: ['close'],
          highWaterMark: 1024,
          [kFirstEventParam]: true,
        });
    }
    return this[kLineObjectStream];
  }

  [Symbol.dispose]() {
    this.close();
  }
}

// ======================================================================
// Inlined from src/readline/emitKeypressEvents.js
// ======================================================================
// readline/emitKeypressEvents.js
// npm install string_decoder

/*!
 * readline/emitKeypressEvents — attaches keypress parsing to a Readable stream
 * Ported from Node.js internal/readline/emitKeypressEvents (MIT / Joyent)
 *
 * Limitations: Only useful when the stream is already in raw/character mode.
 *   In a browser there is no kernel TTY driver, so applications must feed raw
 *   characters manually (e.g. from a WebSocket or a custom input handler).
 */


const { kEscape } = CSI;

const KEYPRESS_DECODER = Symbol('keypress-decoder');
const ESCAPE_DECODER   = Symbol('escape-decoder');

// GNU readline default: 500 ms

/**
 * Causes `stream` to emit `'keypress'` events for each character it receives.
 *
 * Mirrors Node's `readline.emitKeypressEvents(stream[, interface])` exactly.
 *
 * @param {import('stream').Readable & { emit: Function }} stream
 * @param {{ escapeCodeTimeout?: number; [kSawKeyPress]?: boolean; isCompletionEnabled?: boolean }} [iface]
 */
function emitKeypressEvents(stream, iface = {}) {
  // Idempotent: only install once per stream.
  if (stream[KEYPRESS_DECODER]) return;

  stream[KEYPRESS_DECODER] = new StringDecoder('utf8');
  stream[ESCAPE_DECODER]   = emitKeys(stream);
  stream[ESCAPE_DECODER].next(); // prime the generator

  const { escapeCodeTimeout = ESCAPE_CODE_TIMEOUT } = iface;
  let timeoutId;

  const triggerEscape = () => stream[ESCAPE_DECODER].next('');

  function onData(input) {
    if (stream.listenerCount('keypress') > 0) {
      const string = stream[KEYPRESS_DECODER].write(input);
      if (string) {
        globalThis.clearTimeout(timeoutId);

        // Track whether the last keypress consumed exactly one character
        // (used by the interface to decide whether to complete).
        iface[kSawKeyPress] = charLengthAt(string, 0) === string.length;
        iface.isCompletionEnabled = false;

        let length = 0;
        for (const character of string) {         // iterates Unicode code points
          length += character.length;
          if (length === string.length) iface.isCompletionEnabled = true;

          try {
            stream[ESCAPE_DECODER].next(character);
            // If the last character is ESC, start the escape-code timeout window
            if (length === string.length && character === kEscape) {
              timeoutId = globalThis.setTimeout(triggerEscape, escapeCodeTimeout);
            }
          } catch (err) {
            // If the generator throws (e.g. re-thrown from a keypress listener),
            // reset it so the stream keeps working.
            stream[ESCAPE_DECODER] = emitKeys(stream);
            stream[ESCAPE_DECODER].next();
            throw err;
          }
        }
      }
    } else {
      // No listeners — stop processing until someone subscribes again.
      stream.removeListener('data', onData);
      stream.on('newListener', onNewListener);
    }
  }

  function onNewListener(event) {
    if (event === 'keypress') {
      stream.on('data', onData);
      stream.removeListener('newListener', onNewListener);
    }
  }

  if (stream.listenerCount('keypress') > 0) {
    stream.on('data', onData);
  } else {
    stream.on('newListener', onNewListener);
  }
}

// ======================================================================
// Callback API surface (previously the facade)
// ======================================================================
// `util.promisify.custom` without importing all of util.js —
// util.js defines it as Symbol.for('nodejs.util.promisify.custom').
const kCustomPromisify = Symbol.for('nodejs.util.promisify.custom');
/**
 * Creates a readline `Interface` instance.
 * @param {object} input
 * @param {object} [output]
 * @param {Function} [completer]
 * @param {boolean} [terminal]
 * @returns {Interface}
 */
export function Interface(input, output, completer, terminal) {
  if (!(this instanceof Interface)) {
    return new Interface(input, output, completer, terminal);
  }

  if (input?.input &&
      typeof input.completer === 'function' && input.completer.length !== 2) {
    const { completer: realCompleter } = input;
    input.completer = (v, cb) => cb(null, realCompleter(v));
  } else if (typeof completer === 'function' && completer.length !== 2) {
    const realCompleter = completer;
    completer = (v, cb) => cb(null, realCompleter(v));
  }

  InterfaceConstructor.call(this, input, output, completer, terminal);

  // Reading process.env is expensive and _ttyWrite is only used in
  // terminal mode, so only check for a dumb terminal when relevant.
  if (this.terminal && getTerm() === 'dumb') {
    this._ttyWrite = _ttyWriteDumb.bind(this);
  }
}

Object.setPrototypeOf(Interface.prototype, _Interface.prototype);
Object.setPrototypeOf(Interface, _Interface);

/**
 * Displays `query` by writing it to the `output`.
 * @param {string} query
 * @param {{ signal?: AbortSignal }} [options]
 * @param {Function} cb
 * @returns {void}
 */
Interface.prototype.question = function question(query, options, cb) {
  cb = typeof options === 'function' ? options : cb;
  if (options === null || typeof options !== 'object') {
    options = kEmptyObject;
  }

  if (options.signal) {
    validateAbortSignal(options.signal, 'options.signal');
    if (options.signal.aborted) {
      return;
    }

    const onAbort = () => {
      this[kQuestionCancel]();
    };
    const disposable = addAbortListener(options.signal, onAbort);
    const originalCb = cb;
    cb = typeof cb === 'function' ? (answer) => {
      disposable[Symbol.dispose]();
      return originalCb(answer);
    } : () => disposable[Symbol.dispose]();
  }

  if (typeof cb === 'function') {
    this[kQuestion](query, cb);
  }
};
Interface.prototype.question[kCustomPromisify] = function question(query, options) {
  if (options === null || typeof options !== 'object') {
    options = kEmptyObject;
  }

  if (options.signal?.aborted) {
    return Promise.reject(
      new AbortError(undefined, { cause: options.signal.reason }));
  }

  return new Promise((resolve, reject) => {
    let cb = resolve;

    if (options.signal) {
      const onAbort = () => {
        reject(new AbortError(undefined, { cause: options.signal.reason }));
      };
      const disposable = addAbortListener(options.signal, onAbort);
      cb = (answer) => {
        disposable[Symbol.dispose]();
        resolve(answer);
      };
    }

    this.question(query, options, cb);
  });
};

/**
 * Creates a new `readline.Interface` instance.
 */
export function createInterface(input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal);
}

Object.defineProperties(Interface.prototype, {
  // Redirect internal prototype methods to the underscore notation for backward
  // compatibility.
  [kSetRawMode]: {
    __proto__: null,
    get() {
      return this._setRawMode;
    },
  },
  [kOnLine]: {
    __proto__: null,
    get() {
      return this._onLine;
    },
  },
  [kWriteToOutput]: {
    __proto__: null,
    get() {
      return this._writeToOutput;
    },
  },
  [kAddHistory]: {
    __proto__: null,
    get() {
      return this._addHistory;
    },
  },
  [kRefreshLine]: {
    __proto__: null,
    get() {
      return this._refreshLine;
    },
  },
  [kNormalWrite]: {
    __proto__: null,
    get() {
      return this._normalWrite;
    },
  },
  [kInsertString]: {
    __proto__: null,
    get() {
      return this._insertString;
    },
  },
  [kTabComplete]: {
    __proto__: null,
    get() {
      return this._tabComplete;
    },
  },
  [kWordLeft]: {
    __proto__: null,
    get() {
      return this._wordLeft;
    },
  },
  [kWordRight]: {
    __proto__: null,
    get() {
      return this._wordRight;
    },
  },
  [kDeleteLeft]: {
    __proto__: null,
    get() {
      return this._deleteLeft;
    },
  },
  [kDeleteRight]: {
    __proto__: null,
    get() {
      return this._deleteRight;
    },
  },
  [kDeleteWordLeft]: {
    __proto__: null,
    get() {
      return this._deleteWordLeft;
    },
  },
  [kDeleteWordRight]: {
    __proto__: null,
    get() {
      return this._deleteWordRight;
    },
  },
  [kDeleteLineLeft]: {
    __proto__: null,
    get() {
      return this._deleteLineLeft;
    },
  },
  [kDeleteLineRight]: {
    __proto__: null,
    get() {
      return this._deleteLineRight;
    },
  },
  [kLine]: {
    __proto__: null,
    get() {
      return this._line;
    },
  },
  [kHistoryNext]: {
    __proto__: null,
    get() {
      return this._historyNext;
    },
  },
  [kHistoryPrev]: {
    __proto__: null,
    get() {
      return this._historyPrev;
    },
  },
  [kGetDisplayPos]: {
    __proto__: null,
    get() {
      return this._getDisplayPos;
    },
  },
  [kMoveCursor]: {
    __proto__: null,
    get() {
      return this._moveCursor;
    },
  },
  [kTtyWrite]: {
    __proto__: null,
    get() {
      return this._ttyWrite;
    },
  },

  // Defining proxies for the internal instance properties for backward
  // compatibility.
  _decoder: {
    __proto__: null,
    get() {
      return this[kDecoder];
    },
    set(value) {
      this[kDecoder] = value;
    },
  },
  _line_buffer: {
    __proto__: null,
    get() {
      return this[kLine_buffer];
    },
    set(value) {
      this[kLine_buffer] = value;
    },
  },
  _oldPrompt: {
    __proto__: null,
    get() {
      return this[kOldPrompt];
    },
    set(value) {
      this[kOldPrompt] = value;
    },
  },
  _previousKey: {
    __proto__: null,
    get() {
      return this[kPreviousKey];
    },
    set(value) {
      this[kPreviousKey] = value;
    },
  },
  _prompt: {
    __proto__: null,
    get() {
      return this[kPrompt];
    },
    set(value) {
      this[kPrompt] = value;
    },
  },
  _questionCallback: {
    __proto__: null,
    get() {
      return this[kQuestionCallback];
    },
    set(value) {
      this[kQuestionCallback] = value;
    },
  },
  _sawKeyPress: {
    __proto__: null,
    get() {
      return this[kSawKeyPress];
    },
    set(value) {
      this[kSawKeyPress] = value;
    },
  },
  _sawReturnAt: {
    __proto__: null,
    get() {
      return this[kSawReturnAt];
    },
    set(value) {
      this[kSawReturnAt] = value;
    },
  },
});

// Make internal methods public for backward compatibility.
Interface.prototype._setRawMode = _Interface.prototype[kSetRawMode];
Interface.prototype._onLine = _Interface.prototype[kOnLine];
Interface.prototype._writeToOutput = _Interface.prototype[kWriteToOutput];
Interface.prototype._addHistory = _Interface.prototype[kAddHistory];
Interface.prototype._refreshLine = _Interface.prototype[kRefreshLine];
Interface.prototype._normalWrite = _Interface.prototype[kNormalWrite];
Interface.prototype._insertString = _Interface.prototype[kInsertString];
Interface.prototype._tabComplete = function(lastKeypressWasTab) {
  // Overriding parent method because `this.completer` in the legacy
  // implementation takes a callback instead of being an async function.
  this.pause();
  const string = this.line.slice(0, this.cursor);
  this.completer(string, (err, value) => {
    this.resume();

    if (err) {
      this._writeToOutput(`Tab completion error: ${inspectError(err)}`);
      return;
    }

    this[kTabCompleter](lastKeypressWasTab, value);
  });
};
Interface.prototype._wordLeft = _Interface.prototype[kWordLeft];
Interface.prototype._wordRight = _Interface.prototype[kWordRight];
Interface.prototype._deleteLeft = _Interface.prototype[kDeleteLeft];
Interface.prototype._deleteRight = _Interface.prototype[kDeleteRight];
Interface.prototype._deleteWordLeft = _Interface.prototype[kDeleteWordLeft];
Interface.prototype._deleteWordRight = _Interface.prototype[kDeleteWordRight];
Interface.prototype._deleteLineLeft = _Interface.prototype[kDeleteLineLeft];
Interface.prototype._deleteLineRight = _Interface.prototype[kDeleteLineRight];
Interface.prototype._line = _Interface.prototype[kLine];
Interface.prototype._historyNext = _Interface.prototype[kHistoryNext];
Interface.prototype._historyPrev = _Interface.prototype[kHistoryPrev];
Interface.prototype._getDisplayPos = _Interface.prototype[kGetDisplayPos];
Interface.prototype._getCursorPos = _Interface.prototype.getCursorPos;
Interface.prototype._moveCursor = _Interface.prototype[kMoveCursor];
Interface.prototype._ttyWrite = _Interface.prototype[kTtyWrite];

function _ttyWriteDumb(s, key) {
  key ||= kEmptyObject;
  if (key.name === 'escape') return;

  if (this[kSawReturnAt] && key.name !== 'enter')
    this[kSawReturnAt] = 0;

  if (key.ctrl) {
    if (key.name === 'c') {
      if (this.listenerCount('SIGINT') > 0) {
        this.emit('SIGINT');
      } else {
        // This readline instance is finished
        this.close();
      }

      return;
    } else if (key.name === 'd') {
      this.close();
      return;
    }
  }

  switch (key.name) {
    case 'return':  // Carriage return, i.e. \r
      this[kSawReturnAt] = Date.now();
      this._line();
      break;

    case 'enter':
      // When key interval > crlfDelay
      if (this[kSawReturnAt] === 0 ||
          Date.now() - this[kSawReturnAt] > this.crlfDelay) {
        this._line();
      }
      this[kSawReturnAt] = 0;
      break;

    default:
      if (typeof s === 'string' && s) {
        this.line += s;
        this.cursor += s.length;
        this._writeToOutput(s);
      }
  }
}

const readline = {
  Interface,
  clearLine,
  clearScreenDown,
  createInterface,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
  promises,
};

export {
  clearLine,
  clearScreenDown,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
  promises,
};

export default readline;
