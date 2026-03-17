// readline/utils.js
// npm install string_decoder

/*!
 * readline/utils — internal CSI helpers, emitKeys generator, char helpers
 * Ported from Node.js internal/readline/utils (MIT / Joyent)
 */

import { StringDecoder } from 'string_decoder';

export const kUTF16SurrogateThreshold = 0x10000; // 2 ** 16
export const kSubstringSearch = Symbol('kSubstringSearch');

// ---------------------------------------------------------------------------
// CSI tagged-template builder
// ---------------------------------------------------------------------------

/**
 * Builds an ANSI CSI escape sequence.
 * @param {TemplateStringsArray} strings
 * @param {...any} args
 * @returns {string}
 */
export function CSI(strings, ...args) {
  let ret = '\x1b[';
  for (let n = 0; n < strings.length; n++) {
    ret += strings[n];
    if (n < args.length) ret += args[n];
  }
  return ret;
}

CSI.kEscape              = '\x1b';
CSI.kClearToLineBeginning = CSI`1K`;
CSI.kClearToLineEnd       = CSI`0K`;
CSI.kClearLine            = CSI`2K`;
CSI.kClearScreenDown      = CSI`0J`;

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
export function charLengthLeft(str, i) {
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
export function charLengthAt(str, i) {
  if (str.length <= i) return 1; // pretend to move right (for autocomplete)
  return str.codePointAt(i) >= kUTF16SurrogateThreshold ? 2 : 1;
}

// ---------------------------------------------------------------------------
// emitKeys — async generator that parses raw input into keypress events
// ---------------------------------------------------------------------------

/**
 * Generator that receives individual characters via `.next(ch)` and emits
 * `'keypress'` events on `stream` for each recognised key or sequence.
 *
 * Mirrors Node's internal/readline/utils emitKeys generator exactly.
 *
 * @param {import('stream').Readable & { emit: Function }} stream
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
// Misc helpers
// ---------------------------------------------------------------------------

/**
 * Returns the longest common prefix of a string array in O(n log n).
 * @param {string[]} strings
 * @returns {string}
 */
export function commonPrefix(strings) {
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
export function reverseString(line, from = '\r', to = '\r') {
  const parts = line.split(from);
  let result = '';
  for (let i = parts.length - 1; i > 0; i--) result += parts[i] + to;
  result += parts[0];
  return result;
}

export default {
  CSI, kSubstringSearch, kUTF16SurrogateThreshold,
  charLengthAt, charLengthLeft,
  emitKeys, commonPrefix, reverseString,
};
