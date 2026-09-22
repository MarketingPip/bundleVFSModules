// src/console.js
//
// Port of Node.js v24.20.0's console implementation to dependency-free,
// browser-safe ESM:
//
//   - lib/console.js
//   - lib/internal/console/constructor.js
//   - lib/internal/console/global.js
//   - lib/internal/cli_table.js            (used by console.table)
//   - slices of lib/internal/validators.js, lib/internal/errors.js,
//     lib/internal/util/debuglog.js        (time/timeLog/timeEnd/formatTime)
//     and lib/internal/util/colors.js      (shouldColorize)
//
// Value formatting is delegated to the sibling `src/util.js` port
// (`inspect`, `formatWithOptions`, `stripVTControlCharacters`, `types`),
// and method calls are published on the `console.log` / `console.info` /
// `console.debug` / `console.warn` / `console.error` diagnostics channels
// of the sibling `src/diagnostics_channel.js` port, exactly like Node.
//
// Where Node reaches into C++ (internalBinding) this port substitutes
// dependency-free equivalents:
//   - trace_events instrumentation  -> no-op (unobservable without C++)
//   - inspector console call         -> skipped (no inspector binding)
//   - readline cursorTo/clearScreenDown -> equivalent ANSI escape sequences
//   - process.hrtime                 -> process.hrtime when available,
//                                      performance.now() fallback otherwise
//   - util previewEntries binding    -> dependency-free JS equivalent (see
//                                      below; unlike the C++ version it
//                                      consumes the inspected iterator)
//
// Like Node, importing this module installs its Console-based global
// console on `globalThis`, and both the default export and
// `require('console')` return that global console object, with the `Console`
// constructor available as the `Console` property.

import {
  inspect,
  formatWithOptions,
  stripVTControlCharacters,
  types as utilTypes,
} from './util.js';
import { channel } from './diagnostics_channel.js';

/* ------------------------------------------------------------------------ */
/* Captured intrinsics (primordials-style: keep working even if the         */
/* originals are frozen or patched later).                                  */
/* ------------------------------------------------------------------------ */

const {
  defineProperty: ObjectDefineProperty,
  defineProperties: ObjectDefineProperties,
  keys: ObjectKeys,
  values: ObjectValues,
  hasOwn: ObjectHasOwn,
} = Object;
const { isArray: ArrayIsArray } = Array;
const {
  apply: ReflectApply,
  construct: ReflectConstruct,
  ownKeys: ReflectOwnKeys,
  defineProperty: ReflectDefineProperty,
  getOwnPropertyDescriptor: ReflectGetOwnPropertyDescriptor,
} = Reflect;
const { bind: FunctionPrototypeBind } = Function.prototype;
const NumberIsInteger = Number.isInteger;
const SymbolHasInstance = Symbol.hasInstance;
const SymbolToStringTag = Symbol.toStringTag;
const SymbolIterator = Symbol.iterator;

const consolePropAttributes = {
  writable: true,
  enumerable: false,
  configurable: true,
};

/* ------------------------------------------------------------------------ */
/* Internal symbols (mirror lib/internal/console/constructor.js)            */
/* ------------------------------------------------------------------------ */

const kBindStreamsEager = Symbol('kBindStreamsEager');
const kBindStreamsLazy = Symbol('kBindStreamsLazy');
const kBindProperties = Symbol('kBindProperties');
const kWriteToConsole = Symbol('kWriteToConsole');
const kGetInspectOptions = Symbol('kGetInspectOptions');
const kFormatForStdout = Symbol('kFormatForStdout');
const kFormatForStderr = Symbol('kFormatForStderr');
const kIsConsole = Symbol('kIsConsole');
const kUseStdout = Symbol('kUseStdout');
const kUseStderr = Symbol('kUseStderr');
const kCounts = Symbol('counts');
const kColorMode = Symbol('kColorMode');
const kGroupIndentationWidth = Symbol('kGroupIndentWidth');
const kGroupIndentationString = Symbol('kGroupIndentationString');
const kMaxGroupIndentation = 1000;

const kColorInspectOptions = { colors: true };
const kNoColorInspectOptions = {};

const noop = () => {};

/* ------------------------------------------------------------------------ */
/* Errors (port of the relevant lib/internal/errors.js builders,            */
/* Node v24.20.0).                                                          */
/* ------------------------------------------------------------------------ */

const kTypeNames = [
  'string',
  'function',
  'number',
  'object',
  // Accept 'Function' and 'Object' as alternative to the lower cased version.
  'Function',
  'Object',
  'boolean',
  'bigint',
  'symbol',
];
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;

function formatList(array, type = 'and') {
  switch (array.length) {
    case 0: return '';
    case 1: return `${array[0]}`;
    case 2: return `${array[0]} ${type} ${array[1]}`;
    default:
      return `${array.slice(0, -1).join(', ')}, ${type} ${array[array.length - 1]}`;
  }
}

function determineSpecificType(value) {
  if (value === null) {
    return 'null';
  } else if (value === undefined) {
    return 'undefined';
  }

  const type = typeof value;

  switch (type) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) {
        return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      } else if (value !== value) { // eslint-disable-line no-self-compare
        return 'type number (NaN)';
      } else if (value === Infinity) {
        return 'type number (Infinity)';
      } else if (value === -Infinity) {
        return 'type number (-Infinity)';
      }
      return `type number (${value})`;
    case 'boolean':
      return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol':
      return `type symbol (${String(value)})`;
    case 'function':
      return `function ${value.name}`;
    case 'object':
      if (value.constructor && 'name' in value.constructor) {
        return `an instance of ${value.constructor.name}`;
      }
      try {
        return `${JSON.stringify(value)}`;
      } catch {
        return 'an instance of Object';
      }
    case 'string':
      if (value.length > 28) value = `${value.slice(0, 25)}...`;
      if (!value.includes("'")) {
        return `type string ('${value}')`;
      }
      return `type string (${JSON.stringify(value)})`;
    default: {
      let inspected = String(value);
      if (inspected.length > 28) {
        inspected = `${inspected.slice(0, 25)}...`;
      }
      return `type ${type} (${inspected})`;
    }
  }
}

function buildInvalidArgTypeMessage(name, expected, actual) {
  if (!ArrayIsArray(expected)) {
    expected = [expected];
  }

  let msg = 'The ';
  if (name.endsWith(' argument')) {
    // For cases like 'first argument'
    msg += `${name} `;
  } else {
    const type = name.includes('.') ? 'property' : 'argument';
    msg += `"${name}" ${type} `;
  }
  msg += 'must be ';

  const types = [];
  const instances = [];
  const other = [];

  for (const value of expected) {
    if (kTypeNames.includes(value)) {
      types.push(value.toLowerCase());
    } else if (classRegExp.exec(value) !== null) {
      instances.push(value);
    } else {
      other.push(value);
    }
  }

  // Special handle `object` in case other instances are allowed to outline
  // the differences between each other.
  if (instances.length > 0) {
    const pos = types.indexOf('object');
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push('Object');
    }
  }

  if (types.length > 0) {
    msg += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
    if (instances.length > 0 || other.length > 0)
      msg += ' or ';
  }

  if (instances.length > 0) {
    msg += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0)
      msg += ' or ';
  }

  if (other.length > 0) {
    if (other.length > 1) {
      msg += `one of ${formatList(other, 'or')}`;
    } else {
      if (other[0].toLowerCase() !== other[0])
        msg += 'an ';
      msg += `${other[0]}`;
    }
  }

  msg += `. Received ${determineSpecificType(actual)}`;

  return msg;
}

class ERR_INVALID_ARG_TYPE extends TypeError {
  constructor(name, expected, actual) {
    super(buildInvalidArgTypeMessage(name, expected, actual));
    this.name = 'TypeError';
    this.code = 'ERR_INVALID_ARG_TYPE';
  }

  // Mirrors NodeError.prototype.toString in lib/internal/errors.js.
  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

class ERR_INVALID_ARG_VALUE extends TypeError {
  constructor(name, value, reason = 'is invalid') {
    let inspected = inspect(value);
    if (inspected.length > 128) {
      inspected = `${inspected.slice(0, 128)}...`;
    }
    const type = name.includes('.') ? 'property' : 'argument';
    super(`The ${type} '${name}' ${reason}. Received ${inspected}`);
    this.name = 'TypeError';
    this.code = 'ERR_INVALID_ARG_VALUE';
  }

  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

class ERR_INCOMPATIBLE_OPTION_PAIR extends TypeError {
  constructor(name1, name2) {
    super(`Option "${name1}" cannot be used in combination with option "${name2}"`);
    this.name = 'TypeError';
    this.code = 'ERR_INCOMPATIBLE_OPTION_PAIR';
  }

  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

class ERR_OUT_OF_RANGE extends RangeError {
  constructor(name, range, received) {
    let receivedOut;
    if (NumberIsInteger(received) && Math.abs(received) > 2 ** 32) {
      receivedOut = `${inspect(received)}n`;
    } else if (typeof received === 'bigint') {
      receivedOut = `BigInt(${inspect(received)})`;
    } else {
      receivedOut = inspect(received);
    }

    super(`The value of "${name}" is out of range. It must be ${range}. ` +
          `Received ${receivedOut}`);
    this.name = 'RangeError';
    this.code = 'ERR_OUT_OF_RANGE';
  }

  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

class ERR_CONSOLE_WRITABLE_STREAM extends TypeError {
  constructor(name) {
    super(`Console expects a writable stream instance for ${name}`);
    this.name = 'TypeError';
    this.code = 'ERR_CONSOLE_WRITABLE_STREAM';
  }

  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

/* ------------------------------------------------------------------------ */
/* Validators (port of the used subset of lib/internal/validators.js)       */
/* ------------------------------------------------------------------------ */

function validateArray(value, name, minLength = 0) {
  if (!ArrayIsArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, 'Array', value);
  }
  if (value.length < minLength) {
    const reason = `must have a length of at least ${minLength}`;
    throw new ERR_INVALID_ARG_VALUE(name, value, reason);
  }
}

function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number')
    throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  if (!NumberIsInteger(value))
    throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
  if (value < min || value > max)
    throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}

function validateObject(value, name) {
  if (value === null || ArrayIsArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }

  if (typeof value !== 'object') {
    throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }
}

function validateOneOf(value, name, oneOf) {
  if (!oneOf.includes(value)) {
    const allowed = oneOf.map((v) =>
      (typeof v === 'string' ? `'${v}'` : String(v))).join(', ');
    const reason = `must be one of: ${allowed}`;
    throw new ERR_INVALID_ARG_VALUE(name, value, reason);
  }
}

/* ------------------------------------------------------------------------ */
/* Stack overflow detection (port of lib/internal/console/constructor.js)   */
/* ------------------------------------------------------------------------ */

let maxStack_ErrorMessage;
let maxStack_ErrorName;
function isStackOverflowError(err) {
  if (maxStack_ErrorMessage === undefined) {
    try {
      const overflowStack = () => overflowStack();
      overflowStack();
    } catch (e) {
      maxStack_ErrorMessage = e.message;
      maxStack_ErrorName = e.name;
    }
  }
  return err !== null &&
    err !== undefined &&
    err.name === maxStack_ErrorName &&
    err.message === maxStack_ErrorMessage;
}

/* ------------------------------------------------------------------------ */
/* Color support detection (port of lib/internal/util/colors.js)            */
/* ------------------------------------------------------------------------ */

function shouldColorize(stream) {
  const env = globalThis.process?.env;
  if (env !== undefined && env !== null && env.FORCE_COLOR !== undefined) {
    // Node consults tty.getColorDepth(); without a tty binding, treat any
    // FORCE_COLOR other than '0' as color-capable.
    return env.FORCE_COLOR !== '0';
  }
  return !!stream?.isTTY && (
    typeof stream.getColorDepth === 'function' ?
      stream.getColorDepth() > 2 : true);
}

/* ------------------------------------------------------------------------ */
/* High-resolution time. process.hrtime when available, otherwise a         */
/* performance.now()-based [seconds, nanoseconds] tuple.                    */
/* ------------------------------------------------------------------------ */

function hrtime(previous) {
  const proc = globalThis.process;
  if (proc && typeof proc.hrtime === 'function') {
    return proc.hrtime(previous);
  }
  const ms = (typeof performance !== 'undefined' && typeof performance.now === 'function') ?
    performance.now() : Date.now();
  const seconds = Math.floor(ms / 1000);
  const nanoseconds = Math.floor((ms - seconds * 1000) * 1e6);
  if (previous === undefined) {
    return [seconds, nanoseconds];
  }
  let ds = seconds - previous[0];
  let dns = nanoseconds - previous[1];
  if (dns < 0) {
    ds -= 1;
    dns += 1e9;
  }
  return [ds, dns];
}

function emitWarning(warning) {
  const proc = globalThis.process;
  if (proc && typeof proc.emitWarning === 'function') {
    proc.emitWarning(warning);
  }
  // Without process.emitWarning there is no observable channel for the
  // warning, so it is dropped instead of being written implicitly.
}

/* ------------------------------------------------------------------------ */
/* formatTime / time / timeLog / timeEnd                                    */
/* (port of lib/internal/util/debuglog.js)                                  */
/* ------------------------------------------------------------------------ */

function formatTime(ms) {
  let subMilliseconds = Math.floor(ms * 1000);
  let milliseconds = Math.floor(ms);
  let seconds = Math.floor(milliseconds / 1000);
  let minutes = Math.floor(seconds / 60);
  let hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  hours %= 24;
  minutes %= 60;
  seconds %= 60;
  milliseconds %= 1000;
  subMilliseconds %= 1000;

  const padTime = (num, len) => String(num).padStart(len, '0');

  if (days > 0) return `${days}d ${padTime(hours, 2)}h ${padTime(minutes, 2)}m ${padTime(seconds, 2)}s`;
  if (hours > 0) return `${padTime(hours, 2)}h ${padTime(minutes, 2)}m ${padTime(seconds, 2)}s`;
  if (minutes > 0) return `${padTime(minutes, 2)}m ${padTime(seconds, 2)}s`;
  if (seconds > 0) return `${padTime(seconds, 2)}.${padTime(milliseconds, 3)}s`;
  if (milliseconds > 0) return `${padTime(milliseconds, 3)}.${padTime(subMilliseconds, 3)}ms`;
  return `${padTime(subMilliseconds, 3)}µs`;
}

// Shared by console.timeLog() and console.timeEnd().
function timeLogOrEnd(timesStore, label, logImpl, ...logArgs) {
  label = `${label}`;
  const startTime = timesStore.get(label);
  if (startTime === undefined) {
    emitWarning(`No such label '${label}' for console.timeEnd()`);
    return undefined;
  }
  const diff = hrtime(startTime);
  const formatted = formatTime((diff[0] * 1e9 + diff[1]) / 1e6);
  logImpl(label, formatted, logArgs);
  return formatted;
}

function timeImpl(timesStore, label = 'default') {
  // Coerce to string; this throws a TypeError for Symbols, like Node.
  label = `${label}`;
  if (timesStore.has(label)) {
    emitWarning(`Label '${label}' already exists for console.time()`);
    return;
  }
  timesStore.set(label, hrtime());
}

/* ------------------------------------------------------------------------ */
/* getStringWidth (terminal column width; port of the                      */
/* lib/internal/util/inspect.js implementation used by cli_table).          */
/* Full-width East Asian code points count 2; combining / zero-width        */
/* code points count 0; ANSI escape sequences are stripped first.           */
/* ------------------------------------------------------------------------ */

function isFullWidthCodePoint(code) {
  // Code points are partially derived from
  // https://www.unicode.org/Public/UNIDATA/EastAsianWidth.txt
  return code >= 0x1100 && (
    code <= 0x115f || // Hangul Jamo
    code === 0x2329 || // LEFT-POINTING ANGLE BRACKET
    code === 0x232a || // RIGHT-POINTING ANGLE BRACKET
    // CJK Radicals Supplement .. Enclosed CJK Letters and Months
    (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) ||
    // Enclosed CJK Letters and Months .. CJK Unified Ideographs Extension A
    (code >= 0x3250 && code <= 0x4dbf) ||
    // CJK Unified Ideographs .. Yi Radicals
    (code >= 0x4e00 && code <= 0xa4c6) ||
    // Hangul Jamo Extended-A
    (code >= 0xa960 && code <= 0xa97c) ||
    // Hangul Syllables
    (code >= 0xac00 && code <= 0xd7a3) ||
    // CJK Compatibility Ideographs
    (code >= 0xf900 && code <= 0xfaff) ||
    // Vertical Forms
    (code >= 0xfe10 && code <= 0xfe19) ||
    // CJK Compatibility Forms .. Small Form Variants
    (code >= 0xfe30 && code <= 0xfe52) ||
    // Halfwidth and Fullwidth Forms
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    // Kana Supplement
    (code >= 0x1b000 && code <= 0x1b001) ||
    // Enclosed Ideographic Supplement
    (code >= 0x1f200 && code <= 0x1f251) ||
    // CJK Unified Ideographs Extension B .. Tertiary Ideographic Plane
    (code >= 0x20000 && code <= 0x3fffd));
}

function isZeroWidthCodePoint(code) {
  return code <= 0x1f || // C0 control codes
    (code >= 0x7f && code <= 0x9f) || // C1 control codes + DEL
    (code >= 0x300 && code <= 0x36f) || // Combining Diacritical Marks
    (code >= 0x200b && code <= 0x200f) || // zero width space etc.
    (code >= 0x2028 && code <= 0x202e) || // line/paragraph separators etc.
    (code >= 0x2060 && code <= 0x2063); // word joiner etc.
}

function getStringWidth(str) {
  str = stripVTControlCharacters(str);
  let width = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.codePointAt(i);
    if (code > 0xffff) {
      i++; // Skip the trailing surrogate of an astral character.
    }
    if (isFullWidthCodePoint(code)) {
      width += 2;
    } else if (!isZeroWidthCodePoint(code)) {
      width++;
    }
  }
  return width;
}

/* ------------------------------------------------------------------------ */
/* cli_table (port of lib/internal/cli_table.js, used by console.table)    */
/* ------------------------------------------------------------------------ */

const tableChars = {
  middleMiddle: '─',
  rowMiddle: '┼',
  topRight: '┐',
  topLeft: '┌',
  leftMiddle: '├',
  topMiddle: '┬',
  bottomMiddle: '┴',
  bottomLeft: '└',
  bottomRight: '┘',
  rightMiddle: '┤',
  left: '│ ',
  right: ' │',
  middle: ' │ ',
};

function renderRow(row, columnWidths) {
  let out = tableChars.left;
  for (let i = 0; i < row.length; i++) {
    const cell = row[i];
    const len = getStringWidth(cell);
    const needed = (columnWidths[i] - len);
    // Pad with spaces, left justifying the output.
    out += cell + ' '.repeat(Math.ceil(needed));
    if (i !== row.length - 1)
      out += tableChars.middle;
  }
  out += tableChars.right;
  return out;
}

const isArray = (v) => ArrayIsArray(v) || utilTypes.isTypedArray(v) || isBuffer(v);
const isTypedArray = utilTypes.isTypedArray;
const isMap = utilTypes.isMap;
const isSet = utilTypes.isSet;
const isMapIterator = utilTypes.isMapIterator;
const isSetIterator = utilTypes.isSetIterator;
function isBuffer(value) {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(value);
}

function cliTable(head, columns) {
  const rows = [];
  const columnWidths = head.map((h) => getStringWidth(h));
  const longestColumn = columns.reduce((n, a) => Math.max(n, a.length), 0);
  for (let i = 0; i < head.length; i++) {
    const column = columns[i];
    for (let j = 0; j < longestColumn; j++) {
      if (rows[j] === undefined)
        rows[j] = [];
      const value = rows[j][i] = ObjectHasOwn(column, j) ? column[j] : '';
      const width = columnWidths[i] || 0;
      const counted = getStringWidth(value);
      columnWidths[i] = Math.max(width, counted);
    }
  }
  const divider = columnWidths.map((i) =>
    tableChars.middleMiddle.repeat(i + 2));

  let result = `${tableChars.topLeft}${divider.join(tableChars.topMiddle)}` +
               `${tableChars.topRight}\n` +
               `${renderRow(head, columnWidths)}\n` +
               `${tableChars.leftMiddle}${divider.join(tableChars.rowMiddle)}` +
               `${tableChars.rightMiddle}\n`;
  for (const row of rows)
    result += `${renderRow(row, columnWidths)}\n`;
  result += `${tableChars.bottomLeft}${divider.join(tableChars.bottomMiddle)}` +
            tableChars.bottomRight;
  return result;
}

/* ------------------------------------------------------------------------ */
/* previewEntries — dependency-free equivalent of the                       */
/* internalBinding('util').previewEntries C++ binding used by               */
/* console.table for Map/Set iterators.                                     */
/*                                                                          */
/* The C++ version snapshots the iterator's *remaining* entries without      */
/* consuming it and reports whether the iterator yields key/value pairs     */
/* based on the iterator's internal kind. Neither is observable from pure   */
/* JS, so this port consumes the iterator into an array and infers the      */
/* key/value-ness from the entry shapes (every entry a 2-element array).    */
/*                                                                          */
/* Returns the flat entries array directly when called with one argument,   */
/* or [entries, isKeyValue] when called with two — mirroring the C++        */
/* binding's two call shapes used by console.table.                         */
/* ------------------------------------------------------------------------ */

function previewEntries(value, isKeyValue) {
  if (value === null ||
      (typeof value !== 'object' && typeof value !== 'function') ||
      typeof value[SymbolIterator] !== 'function') {
    // Mirrors the C++ early return (undefined).
    return undefined;
  }
  const collected = [];
  for (const entry of value) {
    collected.push(entry);
  }
  let keyValue = false;
  const entries = [];
  if (isKeyValue &&
      (collected.length === 0 ||
       collected.every((entry) => ArrayIsArray(entry) && entry.length === 2))) {
    keyValue = true;
    for (const entry of collected) {
      entries.push(entry[0], entry[1]);
    }
  } else {
    for (const entry of collected) {
      entries.push(entry);
    }
  }
  // Fast path for WeakMap and WeakSet: single-argument call returns the
  // entries array itself (used for Set iterators by console.table).
  if (arguments.length === 1) {
    return entries;
  }
  return [entries, keyValue];
}

/* ------------------------------------------------------------------------ */
/* Per-instance inspect-options registry                                    */
/* ------------------------------------------------------------------------ */

const optionsMap = new WeakMap();

function getInspectOptions(instance, stream) {
  let color = instance[kColorMode];
  if (color === 'auto')
    color = shouldColorize(stream);

  const inspectOptionsMap = optionsMap.get(instance);
  const options = inspectOptionsMap !== undefined ?
    inspectOptionsMap.get(stream) : undefined;
  if (options) {
    if (options.colors === undefined) {
      options.colors = color;
    }
    return options;
  }
  return color ? kColorInspectOptions : kNoColorInspectOptions;
}

function createWriteErrorHandler(instance, streamSymbol) {
  return (err) => {
    const stream = streamSymbol === kUseStdout ? instance._stdout : instance._stderr;
    // We got a write error. Try to prevent EPIPE at the next write.
    if (err !== null && !(stream._writableState?.errorEmitted)) {
      // Always use `error` to avoid catching the caller's error handler.
      if (stream.listenerCount('error') === 0)
        stream.once('error', noop);
    }
  };
}

function writeToConsole(instance, streamSymbol, string) {
  const ignoreErrors = instance._ignoreErrors;
  const groupIndent = instance[kGroupIndentationString];

  const useStdout = streamSymbol === kUseStdout;
  const stream = useStdout ? instance._stdout : instance._stderr;
  const errorHandler = useStdout ?
    instance._stdoutErrorHandler : instance._stderrErrorHandler;

  if (groupIndent.length !== 0) {
    if (string.includes('\n'))
      string = string.replaceAll('\n', `\n${groupIndent}`);
    string = groupIndent + string;
  }
  string += '\n';

  if (ignoreErrors === false) {
    stream.write(string);
    return;
  }

  // There may be an error occurring synchronously (e.g. for files or TTYs
  // on POSIX systems) or asynchronously (e.g. pipes on POSIX systems), so
  // handle both situations.
  try {
    // Add and later remove a noop error handler to catch synchronous errors.
    if (stream.listenerCount('error') === 0)
      stream.once('error', noop);

    stream.write(string, errorHandler);
  } catch (e) {
    // Console is a debugging utility, so it swallowing errors is not
    // desirable even in edge cases such as low stack space.
    if (isStackOverflowError(e))
      throw e;
    // Sorry, there's no proper way to pass along the error here.
  } finally {
    stream.removeListener('error', noop);
  }
}

function formatForStdout(instance, args) {
  if (args.length === 1) {
    const a0 = args[0];
    if (typeof a0 === 'string') {
      return a0;
    }
  }
  const opts = getInspectOptions(instance, instance._stdout);
  return formatWithOptions(opts, ...args);
}

function formatForStderr(instance, args) {
  if (args.length === 1) {
    const a0 = args[0];
    if (typeof a0 === 'string') {
      return a0;
    }
  }
  const opts = getInspectOptions(instance, instance._stderr);
  return formatWithOptions(opts, ...args);
}

/* ------------------------------------------------------------------------ */
/* Console constructor                                                      */
/* ------------------------------------------------------------------------ */

function Console(options /* , stderr, ignoreErrors */) {
  // We have to test new.target here to see if this function is called
  // with new, because we need to define a custom instanceof to accommodate
  // the global console.
  if (new.target === undefined) {
    return ReflectConstruct(Console, arguments);
  }

  // Backwards compatibility for `new Console(stdout, stderr, ignoreErrors)`.
  if (!options || typeof options.write === 'function') {
    options = {
      stdout: options,
      stderr: arguments[1],
      ignoreErrors: arguments[2],
    };
  }

  const {
    stdout,
    stderr = stdout,
    ignoreErrors = true,
    colorMode = 'auto',
    inspectOptions,
    groupIndentation,
  } = options;

  if (stdout === null || stdout === undefined ||
      typeof stdout.write !== 'function') {
    throw new ERR_CONSOLE_WRITABLE_STREAM('stdout');
  }

  if (stderr === null || stderr === undefined ||
      typeof stderr.write !== 'function') {
    throw new ERR_CONSOLE_WRITABLE_STREAM('stderr');
  }

  validateOneOf(colorMode, 'colorMode', ['auto', true, false]);

  if (groupIndentation !== undefined) {
    validateInteger(
      groupIndentation, 'groupIndentation', 0, kMaxGroupIndentation);
  }

  if (inspectOptions !== undefined) {
    validateObject(inspectOptions, 'options.inspectOptions');
    const inspectOptionsMap = isMap(inspectOptions) ?
      inspectOptions :
      new Map([[stdout, inspectOptions], [stderr, inspectOptions]]);
    for (const value of inspectOptionsMap.values()) {
      if (value.colors !== undefined && options.colorMode !== undefined) {
        throw new ERR_INCOMPATIBLE_OPTION_PAIR(
          'options.inspectOptions.color', 'colorMode');
      }
    }
    optionsMap.set(this, inspectOptionsMap);
  }

  this[kBindStreamsEager](stdout, stderr);
  this[kBindProperties](ignoreErrors, colorMode, groupIndentation);

  // Bind the prototype methods, keeping subclass overrides bound as well.
  for (const key of ObjectKeys(Console.prototype)) {
    // eslint-disable-next-line no-self-assign
    this[key] = FunctionPrototypeBind.call(this[key], this);
  }
}

ObjectDefineProperties(Console.prototype, {
  [kBindStreamsEager]: {
    __proto__: null,
    ...consolePropAttributes,
    value: function kBindStreamsEager(stdout, stderr) {
      ObjectDefineProperty(this, '_stdout', {
        __proto__: null,
        ...consolePropAttributes,
        value: stdout,
      });
      ObjectDefineProperty(this, '_stderr', {
        __proto__: null,
        ...consolePropAttributes,
        value: stderr,
      });
    },
  },
  [kBindStreamsLazy]: {
    __proto__: null,
    ...consolePropAttributes,
    // Lazily load the stdout and stderr from an object so we don't
    // create the stdio streams when they are not even accessed.
    value: function kBindStreamsLazy(object) {
      let stdout;
      let stderr;
      ObjectDefineProperties(this, {
        '_stdout': {
          __proto__: null,
          enumerable: false,
          configurable: true,
          get() {
            return stdout ||= object.stdout;
          },
          set(value) { stdout = value; },
        },
        '_stderr': {
          __proto__: null,
          enumerable: false,
          configurable: true,
          get() {
            return stderr ||= object.stderr;
          },
          set(value) { stderr = value; },
        },
      });
    },
  },
  [kBindProperties]: {
    __proto__: null,
    ...consolePropAttributes,
    value: function kBindProperties(ignoreErrors, colorMode, groupIndentation = 2) {
      ObjectDefineProperties(this, {
        '_stdoutErrorHandler': {
          __proto__: null,
          ...consolePropAttributes,
          value: createWriteErrorHandler(this, kUseStdout),
        },
        '_stderrErrorHandler': {
          __proto__: null,
          ...consolePropAttributes,
          value: createWriteErrorHandler(this, kUseStderr),
        },
        '_ignoreErrors': {
          __proto__: null,
          ...consolePropAttributes,
          value: Boolean(ignoreErrors),
        },
        '_times': {
          __proto__: null,
          ...consolePropAttributes,
          value: new Map(),
        },
        // Corresponds to https://console.spec.whatwg.org/#count-map
        [kCounts]: {
          __proto__: null,
          ...consolePropAttributes,
          value: new Map(),
        },
        [kColorMode]: {
          __proto__: null,
          ...consolePropAttributes,
          value: colorMode,
        },
        [kIsConsole]: {
          __proto__: null,
          ...consolePropAttributes,
          value: true,
        },
        [kGroupIndentationWidth]: {
          __proto__: null,
          ...consolePropAttributes,
          value: groupIndentation,
        },
        [kGroupIndentationString]: {
          __proto__: null,
          ...consolePropAttributes,
          value: '',
        },
        [SymbolToStringTag]: {
          __proto__: null,
          writable: false,
          enumerable: false,
          configurable: true,
          value: 'console',
        },
      });
    },
  },
  [kWriteToConsole]: {
    __proto__: null,
    ...consolePropAttributes,
    value: function kWriteToConsole(streamSymbol, string) {
      writeToConsole(this, streamSymbol, string);
    },
  },
  [kGetInspectOptions]: {
    __proto__: null,
    ...consolePropAttributes,
    value: function kGetInspectOptions(stream) {
      return getInspectOptions(this, stream);
    },
  },
  [kFormatForStdout]: {
    __proto__: null,
    ...consolePropAttributes,
    value: function kFormatForStdout(args) {
      return formatForStdout(this, args);
    },
  },
  [kFormatForStderr]: {
    __proto__: null,
    ...consolePropAttributes,
    value: function kFormatForStderr(args) {
      return formatForStderr(this, args);
    },
  },
});

// Fixup global.console instanceof global.console.Console
ObjectDefineProperty(Console, SymbolHasInstance, {
  __proto__: null,
  value: function SymbolHasInstance(instance) {
    return instance[kIsConsole] === true;
  },
});

/* ------------------------------------------------------------------------ */
/* Diagnostics channels (created eagerly, like Node)                        */
/* ------------------------------------------------------------------------ */

const onLog = channel('console.log');
const onWarn = channel('console.warn');
const onError = channel('console.error');
const onInfo = channel('console.info');
const onDebug = channel('console.debug');

/* ------------------------------------------------------------------------ */
/* Console methods                                                          */
/* ------------------------------------------------------------------------ */

const captureStackTrace = typeof Error.captureStackTrace === 'function' ?
  Error.captureStackTrace.bind(Error) :
  (target) => {
    // Minimal fallback for engines without Error.captureStackTrace.
    target.stack = `${target.name}: ${target.message}`;
  };

const consoleMethods = {
  log(...args) {
    if (onLog.hasSubscribers) {
      onLog.publish(args);
    }
    this[kWriteToConsole](kUseStdout, this[kFormatForStdout](args));
  },

  info(...args) {
    if (onInfo.hasSubscribers) {
      onInfo.publish(args);
    }
    this[kWriteToConsole](kUseStdout, this[kFormatForStdout](args));
  },

  debug(...args) {
    if (onDebug.hasSubscribers) {
      onDebug.publish(args);
    }
    this[kWriteToConsole](kUseStdout, this[kFormatForStdout](args));
  },

  warn(...args) {
    if (onWarn.hasSubscribers) {
      onWarn.publish(args);
    }
    this[kWriteToConsole](kUseStderr, this[kFormatForStderr](args));
  },

  error(...args) {
    if (onError.hasSubscribers) {
      onError.publish(args);
    }
    this[kWriteToConsole](kUseStderr, this[kFormatForStderr](args));
  },

  dir(object, options) {
    this[kWriteToConsole](kUseStdout, inspect(object, {
      customInspect: false,
      ...this[kGetInspectOptions](this._stdout),
      ...options,
    }));
  },

  time(label = 'default') {
    timeImpl(this._times, label);
  },

  timeEnd(label = 'default') {
    const formatted = timeLogOrEnd(
      this._times,
      label,
      (lbl, fmt, args) => timeLogImpl(this, lbl, fmt, args));
    if (formatted !== undefined) {
      this._times.delete(`${label}`);
    }
  },

  timeLog(label = 'default', ...data) {
    timeLogOrEnd(
      this._times,
      label,
      (lbl, fmt, args) => timeLogImpl(this, lbl, fmt, args),
      ...data);
  },

  trace: function trace(...args) {
    const err = {
      name: 'Trace',
      message: this[kFormatForStderr](args),
    };
    captureStackTrace(err, trace);
    this.error(err.stack);
  },

  assert(expression, ...args) {
    if (!expression) {
      if (args.length && typeof args[0] === 'string') {
        args[0] = `Assertion failed: ${args[0]}`;
      } else {
        args.unshift('Assertion failed');
      }
      // The arguments will be formatted in warn() again
      ReflectApply(this.warn, this, args);
    }
  },

  clear() {
    // It only makes sense to clear if _stdout is a TTY.
    // Otherwise, do nothing.
    if (this._stdout.isTTY && globalThis.process?.env?.TERM !== 'dumb') {
      // Port of readline's cursorTo(stream, 0, 0) + clearScreenDown(stream):
      // move the cursor to the top-left corner and clear the screen below.
      this._stdout.write('\x1b[1;1H\x1b[0J');
    }
  },

  count(label = 'default') {
    // Ensures that label is a string, and only things that can be
    // coerced to strings. e.g. Symbol is not allowed
    label = `${label}`;
    const counts = this[kCounts];
    let count = counts.get(label);
    if (count === undefined)
      count = 1;
    else
      count++;
    counts.set(label, count);
    this.log(`${label}: ${count}`);
  },

  countReset(label = 'default') {
    const counts = this[kCounts];
    if (!counts.has(label)) {
      // The template literal throws a TypeError for Symbols, like Node.
      emitWarning(`Count for '${label}' does not exist`);
      return;
    }
    counts.delete(`${label}`);
  },

  group(...data) {
    if (data.length > 0) {
      ReflectApply(this.log, this, data);
    }

    let currentIndentation = this[kGroupIndentationString];
    currentIndentation += ' '.repeat(this[kGroupIndentationWidth]);
    this[kGroupIndentationString] = currentIndentation;
  },

  groupEnd() {
    const currentIndentation = this[kGroupIndentationString];
    const newIndentation = currentIndentation.slice(
      0,
      currentIndentation.length - this[kGroupIndentationWidth],
    );

    this[kGroupIndentationString] = newIndentation;
  },

  // https://console.spec.whatwg.org/#table
  table(tabularData, properties) {
    if (properties !== undefined)
      validateArray(properties, 'properties');

    if (tabularData === null || typeof tabularData !== 'object')
      return this.log(tabularData);

    const final = (k, v) => this.log(cliTable(k, v));

    const _inspect = (v) => {
      const depth = v !== null &&
                    typeof v === 'object' &&
                    !isArray(v) &&
                    ObjectKeys(v).length > 2 ? -1 : 0;
      const opt = {
        depth,
        maxArrayLength: 3,
        breakLength: Infinity,
        ...this[kGetInspectOptions](this._stdout),
      };
      return inspect(v, opt);
    };
    const getIndexArray = (length) => Array.from(
      { length }, (_, i) => _inspect(i));

    const mapIter = isMapIterator(tabularData);
    let isKeyValue = false;
    let i = 0;
    if (mapIter) {
      const res = previewEntries(tabularData, true);
      tabularData = res[0];
      isKeyValue = res[1];
    }

    if (isKeyValue || isMap(tabularData)) {
      const keys = [];
      const values = [];
      let length = 0;
      if (mapIter) {
        for (; i < tabularData.length / 2; ++i) {
          keys.push(_inspect(tabularData[i * 2]));
          values.push(_inspect(tabularData[i * 2 + 1]));
          length++;
        }
      } else {
        for (const { 0: k, 1: v } of tabularData) {
          keys.push(_inspect(k));
          values.push(_inspect(v));
          length++;
        }
      }
      return final([
        iterKey, keyKey, valuesKey,
      ], [
        getIndexArray(length),
        keys,
        values,
      ]);
    }

    const setIter = isSetIterator(tabularData);
    if (setIter)
      tabularData = previewEntries(tabularData);

    const setlike = setIter || mapIter || isSet(tabularData);
    if (setlike) {
      const values = [];
      let length = 0;
      for (const v of tabularData) {
        values.push(_inspect(v));
        length++;
      }
      return final([iterKey, valuesKey], [getIndexArray(length), values]);
    }

    const map = { __proto__: null };
    let hasPrimitives = false;
    const valuesKeyArray = [];
    const indexKeyArray = ObjectKeys(tabularData);

    for (; i < indexKeyArray.length; i++) {
      const item = tabularData[indexKeyArray[i]];
      const primitive = item === null ||
          (typeof item !== 'function' && typeof item !== 'object');
      if (properties === undefined && primitive) {
        hasPrimitives = true;
        valuesKeyArray[i] = _inspect(item);
      } else {
        const keys = properties || ObjectKeys(item);
        for (const key of keys) {
          map[key] ??= [];
          if ((primitive && properties) ||
               !ObjectHasOwn(item, key))
            map[key][i] = '';
          else
            map[key][i] = _inspect(item[key]);
        }
      }
    }

    const keys = ObjectKeys(map);
    const values = ObjectValues(map);
    if (hasPrimitives) {
      keys.push(valuesKey);
      values.push(valuesKeyArray);
    }
    keys.unshift(indexKey);
    values.unshift(indexKeyArray);

    return final(keys, values);
  },
};

const keyKey = 'Key';
const valuesKey = 'Values';
const indexKey = '(index)';
const iterKey = '(iteration index)';

for (const method of ReflectOwnKeys(consoleMethods))
  Console.prototype[method] = consoleMethods[method];

Console.prototype.dirxml = Console.prototype.log;
Console.prototype.groupCollapsed = Console.prototype.group;

function timeLogImpl(consoleRef, label, formatted, args) {
  if (args.length === 0) {
    consoleRef.log(`${label}: ${formatted}`);
  } else {
    consoleRef.log(`${label}:`, formatted, ...args);
  }
}

/* ------------------------------------------------------------------------ */
/* Global console (port of lib/internal/console/global.js)                  */
/*                                                                          */
/* See https://console.spec.whatwg.org/#console-namespace                   */
/* > For historical web-compatibility reasons, the namespace object         */
/* > for console must have as its [[Prototype]] an empty object,            */
/* > created as if by ObjectCreate(%ObjectPrototype%),                      */
/* > instead of %ObjectPrototype%.                                          */
/*                                                                          */
/* Since in Node.js the Console constructor has been exposed through        */
/* require('console'), we keep the Console constructor but we cannot        */
/* actually use `new Console` to construct the global console. Therefore    */
/* the console.Console.prototype is not in the global console prototype    */
/* chain; instead the symbol properties on Console.prototype are looked     */
/* up from the global console itself, and the console methods are bound     */
/* directly onto the global console with the receiver fixed.                */
/* ------------------------------------------------------------------------ */

// Capture the pre-existing console first so the lazy stream source can
// delegate to it when process.stdout / process.stderr are unavailable
// (e.g. in browsers).
const _originalConsole = globalThis.console;
const _originalProcess = globalThis.process;

const globalConsole = { __proto__: {} };

for (const prop of ReflectOwnKeys(Console.prototype)) {
  if (prop === 'constructor') { continue; }
  const desc = ReflectGetOwnPropertyDescriptor(Console.prototype, prop);
  if (typeof desc.value === 'function') { // fix the receiver
    const name = desc.value.name;
    desc.value = FunctionPrototypeBind.call(desc.value, globalConsole);
    ReflectDefineProperty(desc.value, 'name', { __proto__: null, value: name });
  }
  ReflectDefineProperty(globalConsole, prop, desc);
}

globalConsole[kBindProperties](true, 'auto');

// This is a legacy feature - the Console constructor is exposed on
// the global console instance.
globalConsole.Console = Console;

// Lazily resolve the stdio streams: prefer the process streams when they
// exist (Node), otherwise delegate to the previously installed console so
// the global console keeps working in browsers and other hosts.
function getDefaultStdout() {
  const proc = globalThis.process ?? _originalProcess;
  if (proc && proc.stdout && typeof proc.stdout.write === 'function') {
    return proc.stdout;
  }
  const fallback = _originalConsole;
  return {
    write: (s) => { fallback?.log(typeof s === 'string' ? s.replace(/\n$/, '') : s); },
    isTTY: false,
    // Minimal EventEmitter surface so the console write path (which guards
    // synchronous stream errors) works without a real stream.
    listenerCount: () => 0,
    once: () => {},
    removeListener: () => {},
  };
}

function getDefaultStderr() {
  const proc = globalThis.process ?? _originalProcess;
  if (proc && proc.stderr && typeof proc.stderr.write === 'function') {
    return proc.stderr;
  }
  const fallback = _originalConsole;
  return {
    write: (s) => { fallback?.error(typeof s === 'string' ? s.replace(/\n$/, '') : s); },
    isTTY: false,
    listenerCount: () => 0,
    once: () => {},
    removeListener: () => {},
  };
}

let _defaultStdout;
let _defaultStderr;
globalConsole[kBindStreamsLazy]({
  get stdout() {
    return _defaultStdout ??= getDefaultStdout();
  },
  get stderr() {
    return _defaultStderr ??= getDefaultStderr();
  },
});

// Install as the global console, like Node does at startup.
globalThis.console = globalConsole;

export default globalConsole;
export { Console };
