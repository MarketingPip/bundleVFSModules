// npm install buffer process
// (In bundlers these resolve to the browserify shims; in Node they resolve to core.)

/*!
 * util-web — node:util for browsers & bundlers
 * MIT License. Parity target: node:util @ Node.js 20.x/22.x+
 * Dependencies: buffer, process (core in Node, npm shims in browsers)
 * Limitations:
 *   - types.isProxy() always returns false (proxies are undetectable in pure JS)
 *   - types.isExternal()/isKeyObject() always return false (no native objects)
 *   - inspect(showProxy) prints target/handler placeholders (cannot extract them)
 *   - getSystemErrorMap() ships the common libuv errnos, not the full table
 *   - util.getCallSites / markPromiseAsHandled / setTraceSigInt / util.diff are
 *     not available (require native bindings / V8 source maps)
 *   - parseEnv does not perform variable expansion or multiline values
 */

/**
 * @packageDocumentation
 * Drop-in replacement for `node:util` in browser/bundler environments, updated
 * to match the current Node.js implementation: full `types` predicate set,
 * modern `format`/`inspect` (incl. `styleText`, hex colors, getters, sorted,
 * compact/breakLength, customInspect **off by default**), `promisify`,
 * `callbackify`, `parseEnv`, `parseArgs`, `MIMEType`/`MIMEParams`,
 * `stripVTControlCharacters`, `toUSVString`, system-error helpers, abort
 * helpers, and the legacy deprecated type checks.
 */

import { Buffer } from 'buffer';
import process from 'process';

// ---------------------------------------------------------------------------
// internal/errors-lite
// ---------------------------------------------------------------------------

/**
 * Creates an Error carrying a Node-style `code` property.
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function E(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** @param {string} name @param {unknown} actual */
function typeName(actual) {
  if (actual === null) return 'null';
  const t = typeof actual;
  if (t === 'object') {
    const ctor = /** @type {object} */ (actual).constructor;
    if (ctor && ctor.name) return `an instance of ${ctor.name}`;
    return 'an instance of Object';
  }
  if (t === 'function') return `function ${/** @type {Function} */ (actual).name || '(anonymous)'}`;
  if (t === 'string' && actual.length > 28) return `string (${JSON.stringify(String(actual).slice(0, 25))}...)`;
  return `${t} (${String(actual)})`;
}

const ERR_INVALID_ARG_TYPE = (name, expected, actual) =>
  E('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type ${expected}. Received ${typeName(actual)}`);
const ERR_INVALID_ARG_VALUE = (name, value, reason = 'is invalid') =>
  E('ERR_INVALID_ARG_VALUE', `The argument '${name}' ${reason}. Received ${JSON.stringify(value)}`);
const ERR_OUT_OF_RANGE = (name, range, value) =>
  E('ERR_OUT_OF_RANGE', `The value of "${name}" is out of range. It must be ${range}. Received ${value}`);

// validators
const validateString = (v, n) => { if (typeof v !== 'string') throw ERR_INVALID_ARG_TYPE(n, 'string', v); };
const validateNumber = (v, n) => { if (typeof v !== 'number') throw ERR_INVALID_ARG_TYPE(n, 'number', v); };
const validateBoolean = (v, n) => { if (typeof v !== 'boolean') throw ERR_INVALID_ARG_TYPE(n, 'boolean', v); };
const validateFunction = (v, n) => { if (typeof v !== 'function') throw ERR_INVALID_ARG_TYPE(n, 'function', v); };
const validateObject = (v, n) => { if (v === null || typeof v !== 'object') throw ERR_INVALID_ARG_TYPE(n, 'object', v); };
const validateInteger = (v, n, min, max) => {
  validateNumber(v, n);
  if (!Number.isSafeInteger(v) || (min !== undefined && v < min) || (max !== undefined && v > max))
    throw ERR_OUT_OF_RANGE(n, min !== undefined && max !== undefined ? `an integer between ${min} and ${max}` : 'an integer', v);
};
const validateOneOf = (v, n, values) => {
  if (!values.includes(v)) throw ERR_INVALID_ARG_VALUE(n, v, `must be one of ${JSON.stringify(values)}`);
};

const objectToString = (v) => Object.prototype.toString.call(v);
const isObjectLike = (v) => v !== null && typeof v === 'object';
const hasOwn = (o, p) => Object.prototype.hasOwnProperty.call(o, p);

// ---------------------------------------------------------------------------
// types — full util.types predicate set (browser-safe)
// ---------------------------------------------------------------------------

const GF = Object.getPrototypeOf(function* () {});
const AF = Object.getPrototypeOf(async function () {});
const AGF = Object.getPrototypeOf(async function* () {});
const F = Object.getPrototypeOf(function () {});

/**
 * @param {unknown} v
 * @returns {v is (...args: any[]) => any}
 */
function isFunctionType(v) { return typeof v === 'function'; }

const types = {
  isArrayBuffer: (v) => objectToString(v) === '[object ArrayBuffer]',
  isSharedArrayBuffer: (v) => typeof SharedArrayBuffer !== 'undefined' && objectToString(v) === '[object SharedArrayBuffer]',
  isAnyArrayBuffer: (v) => types.isArrayBuffer(v) || types.isSharedArrayBuffer(v),
  isArrayBufferView: (v) => ArrayBuffer.isView(v),
  isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isDataView: (v) => v instanceof DataView,
  isMap: (v) => objectToString(v) === '[object Map]',
  isSet: (v) => objectToString(v) === '[object Set]',
  isWeakMap: (v) => objectToString(v) === '[object WeakMap]',
  isWeakSet: (v) => objectToString(v) === '[object WeakSet]',
  isWeakRef: (v) => typeof WeakRef !== 'undefined' && v instanceof WeakRef,
  isDate: (v) => objectToString(v) === '[object Date]',
  isRegExp: (v) => objectToString(v) === '[object RegExp]',
  isPromise: (v) => objectToString(v) === '[object Promise]',
  isProxy: () => false, // undetectable in pure JS — documented limitation
  isExternal: () => false, // no native external objects in browsers
  isKeyObject: () => false,
  isCryptoKey: (v) => typeof globalThis.CryptoKey === 'function' && v instanceof globalThis.CryptoKey,
  isNumberObject: (v) => isObjectLike(v) && objectToString(v) === '[object Number]',
  isStringObject: (v) => isObjectLike(v) && objectToString(v) === '[object String]',
  isBooleanObject: (v) => isObjectLike(v) && objectToString(v) === '[object Boolean]',
  isSymbolObject: (v) => isObjectLike(v) && objectToString(v) === '[object Symbol]',
  isBigIntObject: (v) => isObjectLike(v) && objectToString(v) === '[object BigInt]',
  isBoxedPrimitive(v) {
    return types.isNumberObject(v) || types.isStringObject(v) || types.isBooleanObject(v) ||
           types.isSymbolObject(v) || types.isBigIntObject(v);
  },
  isFunction: isFunctionType,
  isGeneratorFunction(v) {
    if (!isFunctionType(v)) return false;
    const proto = Object.getPrototypeOf(v);
    if (proto === GF || proto === null) return true;
    const tag = v[Symbol.toStringTag];
    return tag === 'GeneratorFunction';
  },
  isAsyncFunction(v) {
    if (!isFunctionType(v)) return false;
    const proto = Object.getPrototypeOf(v);
    if (proto === AF || proto === null) return true;
    return v[Symbol.toStringTag] === 'AsyncFunction';
  },
  isAsyncGeneratorFunction(v) {
    if (!isFunctionType(v)) return false;
    const proto = Object.getPrototypeOf(v);
    if (proto === AGF || proto === null) return true;
    return v[Symbol.toStringTag] === 'AsyncGeneratorFunction';
  },
  isGeneratorObject(v) {
    if (v === null || typeof v !== 'object') return false;
    return objectToString(v) === '[object Generator]' ||
           (typeof v.next === 'function' && typeof v.throw === 'function' && isFunction(v[Symbol.iterator]));
  },
  isArgumentsObject(v) { return objectToString(v) === '[object Arguments]'; },
  isNativeError(v) {
    return v !== null && typeof v === 'object' &&
           (objectToString(v) === '[object Error]' || v instanceof Error);
  },
  isModuleNamespaceObject(v) { return objectToString(v) === '[object Module]'; },
  // Convenience non-Node alias kept internal; Node exposes isAbortSignal via types? No — not in Node.
};

export { types };

// ---------------------------------------------------------------------------
// toUSVString
// ---------------------------------------------------------------------------

/**
 * Coerces to string and replaces lone surrogates with U+FFFD.
 * @param {unknown} input
 * @returns {string}
 */
export function toUSVString(input) {
  return `${input}`.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

// ---------------------------------------------------------------------------
// stripVTControlCharacters
// ---------------------------------------------------------------------------

const vtRegex = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-ORZcf-nqry=><~]))/g;

/**
 * Removes ANSI escape codes from a string.
 * @param {string} str
 * @returns {string}
 * @throws {TypeError} ERR_INVALID_ARG_TYPE
 */
export function stripVTControlCharacters(str) {
  validateString(str, 'str');
  return str.replace(vtRegex, '');
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

const kEscape = '\u001B[';
const kEscapeEnd = 'm';
const kDimCode = 2;
const kBoldCode = 1;
const kHexCloseSeq = `${kEscape}39${kEscapeEnd}`;

/**
 * @param {number[]} codes [open, close]
 */
function codesToStyle(codes) {
  const openNum = codes[0];
  return {
    openSeq: `${kEscape}${openNum}${kEscapeEnd}`,
    closeSeq: `${kEscape}${codes[1]}${kEscapeEnd}`,
    keepClose: openNum === kDimCode || openNum === kBoldCode,
  };
}

const hexColorRegExp = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const kHexStyleCacheMax = 256;
/** @type {Map<string, {openSeq: string, closeSeq: string}>} */
const hexStyleCache = new Map();

/**
 * @param {string} hex '#RGB' or '#RRGGBB'
 * @returns {[number, number, number]}
 */
function hexToRgb(hex) {
  let hexStr;
  if (hex.length === 4) hexStr = hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  else if (hex.length === 7) hexStr = hex.slice(1);
  else throw ERR_OUT_OF_RANGE('hex', '#RGB or #RRGGBB', hex);
  return [
    parseInt(hexStr.slice(0, 2), 16),
    parseInt(hexStr.slice(2, 4), 16),
    parseInt(hexStr.slice(4, 6), 16),
  ];
}

/** @param {number} r @param {number} g @param {number} b */
const rgbToAnsi24Bit = (r, g, b) => `38;2;${r};${g};${b}`;

function getHexStyle(hex) {
  const cached = hexStyleCache.get(hex);
  if (cached !== undefined) return cached;
  const [r, g, b] = hexToRgb(hex);
  const style = {
    openSeq: `${kEscape}${rgbToAnsi24Bit(r, g, b)}${kEscapeEnd}`,
    closeSeq: kHexCloseSeq,
  };
  if (hexStyleCache.size >= kHexStyleCacheMax)
    hexStyleCache.delete(hexStyleCache.keys().next().value);
  hexStyleCache.set(hex, style);
  return style;
}

function replaceCloseCode(str, closeSeq, openSeq, keepClose) {
  const closeLen = closeSeq.length;
  let index = str.indexOf(closeSeq);
  if (index === -1) return str;
  let result = '';
  let lastIndex = 0;
  const replacement = keepClose ? closeSeq + openSeq : openSeq;
  do {
    const afterClose = index + closeLen;
    if (afterClose < str.length) {
      result += str.slice(lastIndex, index) + replacement;
      lastIndex = afterClose;
    } else break;
    index = str.indexOf(closeSeq, lastIndex);
  } while (index !== -1);
  return result + str.slice(lastIndex);
}

/** @type {Record<string, [number, number]>} */
const inspectColors = {
  reset: [0, 0],
  bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24],
  blink: [5, 25], inverse: [7, 27], hidden: [8, 28], strikethrough: [9, 29],
  doubleunderline: [21, 24],
  black: [30, 39], red: [31, 39], green: [32, 39], yellow: [33, 39],
  blue: [34, 39], magenta: [35, 39], cyan: [36, 39], white: [37, 39],
  bgBlack: [40, 49], bgRed: [41, 49], bgGreen: [42, 49], bgYellow: [43, 49],
  bgBlue: [44, 49], bgMagenta: [45, 49], bgCyan: [46, 49], bgWhite: [47, 49],
  framed: [51, 54], overlined: [53, 55],
  gray: [90, 39], grey: [90, 39],
  redBright: [91, 39], greenBright: [92, 39], yellowBright: [93, 39],
  blueBright: [94, 39], magentaBright: [95, 39], cyanBright: [96, 39],
  whiteBright: [97, 39],
  bgGray: [100, 49], bgGrey: [100, 49],
  bgRedBright: [101, 49], bgGreenBright: [102, 49], bgYellowBright: [103, 49],
  bgBlueBright: [104, 49], bgMagentaBright: [105, 49], bgCyanBright: [106, 49],
  bgWhiteBright: [107, 49],
};

/** @type {Record<string, string>} */
const inspectStyles = {
  bigint: 'yellow', boolean: 'yellow', date: 'magenta', module: 'underline',
  null: 'bold', number: 'yellow', regexp: 'red', special: 'cyan',
  string: 'green', symbol: 'green', undefined: 'grey',
};

/** @type {Record<string, {openSeq: string, closeSeq: string, keepClose: boolean}>} */
let styleCache;

function getStyleCache() {
  if (styleCache === undefined) {
    styleCache = Object.create(null);
    for (const key of Object.getOwnPropertyNames(inspectColors)) {
      const codes = inspectColors[key];
      if (codes) styleCache[key] = codesToStyle(codes);
    }
  }
  return styleCache;
}

const ansiLenRegex = /\u001B\[\d\d?m/g;

/**
 * @param {string} str
 * @param {string} styleType
 */
function stylizeWithColor(str, styleType) {
  const style = inspectStyles[styleType];
  if (style && inspectColors[style]) {
    const codes = inspectColors[style];
    return `${kEscape}${codes[0]}${kEscapeEnd}${str}${kEscape}${codes[1]}${kEscapeEnd}`;
  }
  return str;
}

const stylizeNoColor = (str) => str;

const quoteCache = new Map();

/**
 * Quotes a string the way Node's inspect does: prefers single quotes,
 * switches to double quotes if the string contains single quotes but no
 * double quotes. Control characters use \xHH escapes (uppercase hex).
 * @param {string} str
 * @param {string} [quote]
 * @returns {string}
 */
function quoteString(str, quote) {
  if (quote === undefined) {
    if (str.includes("'") && !str.includes('"')) quote = '"';
    else if (str.includes("'") && str.includes('"') && !str.includes('`')) quote = '`';
    else quote = "'";
  }
  let result = quoteCache.get(str + quote);
  if (result !== undefined) return result;
  result = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === quote.charCodeAt(0) || code === 92 /* \\ */) {
      result += '\\' + str[i];
    } else if (quote === '`' && code === 0x24 && str[i + 1] === '{') {
      result += '\\$'; // escape ${ in template-quoted strings
    } else if (code === 0x08) result += '\\b';
    else if (code === 0x09) result += '\\t';
    else if (code === 0x0a) result += '\\n';
    else if (code === 0x0c) result += '\\f';
    else if (code === 0x0d) result += '\\r';
    else if (code < 0x20 || code === 0x7f) {
      result += `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`;
    } else result += str[i];
  }
  result = quote + result + quote;
  if (quoteCache.size > 512) quoteCache.clear();
  quoteCache.set(str + quote, result);
  return result;
}

/**
 * Groups digits of the integer part in threes.
 * @param {string} str
 */
function addNumericSeparator(str) {
  if (!str.includes('.') && str.length <= 3) return str;
  const neg = str.startsWith('-') ? 1 : 0;
  const dot = str.indexOf('.');
  const intEnd = dot === -1 ? str.length : dot;
  let out = str.slice(0, neg);
  const intPart = str.slice(neg, intEnd);
  out += intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
  out += str.slice(intEnd);
  return out;
}

/**
 * @typedef {object} InspectOptions
 * @property {boolean} [showHidden]
 * @property {number|null} [depth]
 * @property {boolean} [colors]
 * @property {boolean} [customInspect]
 * @property {boolean} [showProxy]
 * @property {number} [maxArrayLength]
 * @property {number} [maxStringLength]
 * @property {number} [breakLength]
 * @property {boolean|number} [compact]
 * @property {boolean|'asc'|'desc'|((a:string,b:string)=>number)} [sorted]
 * @property {boolean|'get'|'set'} [getters]
 * @property {boolean} [numericSeparator]
 * @property {(s:string,t:string)=>string} [stylize]
 */

/** @param {InspectOptions} options */
function makeCtx(options) {
  return {
    seen: /** @type {any[]} */ ([]),
    circularCounts: new Map(),
    marked: new Set(),
    stylize: options.stylize
      ? options.stylize
      : options.colors
        ? stylizeWithColor
        : stylizeNoColor,
    options,
    level: 0,
  };
}

/** @param {string} value */
function isClass(value) {
  return /^class\s/.test(Function.prototype.toString.call(value));
}

/**
 * Formats a primitive value. Returns undefined for non-primitives.
 * @param {ReturnType<typeof makeCtx>} ctx
 * @param {unknown} value
 */
function formatPrimitive(ctx, value) {
  if (value === undefined) return ctx.stylize('undefined', 'undefined');
  if (value === null) return ctx.stylize('null', 'null');
  if (typeof value === 'string') {
    let trailer = '';
    let str = value;
    const maxLen = ctx.options.maxStringLength ?? 10000;
    if (str.length > maxLen) {
      const remaining = str.length - maxLen;
      str = str.slice(0, maxLen);
      trailer = `... ${remaining} more character${remaining === 1 ? '' : 's'}`;
    }
    return ctx.stylize(quoteString(str) + trailer, 'string');
  }
  if (typeof value === 'number') {
    let out;
    if (Number.isNaN(value)) out = 'NaN';
    else if (value === Infinity) out = 'Infinity';
    else if (value === -Infinity) out = '-Infinity';
    else if (Object.is(value, -0)) out = '-0';
    else out = ctx.options.numericSeparator ? addNumericSeparator(String(value)) : String(value);
    return ctx.stylize(out, 'number');
  }
  if (typeof value === 'boolean') return ctx.stylize(String(value), 'boolean');
  if (typeof value === 'bigint') {
    const out = ctx.options.numericSeparator ? addNumericSeparator(String(value)) + 'n' : `${value}n`;
    return ctx.stylize(out, 'bigint');
  }
  if (typeof value === 'symbol') return ctx.stylize(String(value), 'symbol');
  return undefined;
}

/** @param {Error} value */
function formatError(value) {
  let name = value.name || 'Error';
  let msg = value.message ? `: ${value.message}` : '';
  return `${name}${msg}`;
}

/**
 * @param {any} value
 * @param {ReturnType<typeof makeCtx>} ctx
 */
/**
 * Promise state display. Pure JS cannot read a promise's settlement state
 * synchronously (V8 keeps it in an internal slot), so pending is always shown.
 * Documented limitation.
 */
function formatPromise() {
  return 'Promise { <pending> }';
}

/** @param {ArrayBuffer|SharedArrayBuffer} buf */
function formatArrayBufferContents(buf) {
  const u8 = new Uint8Array(/** @type {any} */ (buf));
  const shown = [];
  const max = Math.min(u8.length, 50);
  for (let i = 0; i < max; i++) shown.push(u8[i].toString(16).padStart(2, '0'));
  let contents = shown.join(' ');
  if (u8.length > max) contents += ` ... ${u8.length - max} more bytes`;
  return `<${contents}>`;
}

/**
 * @param {ReturnType<typeof makeCtx>} ctx
 * @param {Map<any,any>|Set<any>} value
 * @param {number|null} recurseTimes
 * @param {boolean} isMap
 */
function formatCollection(ctx, value, recurseTimes, isMap) {
  const output = [];
  let i = 0;
  for (const entry of value) {
    const nextRecurse = recurseTimes === null ? null : recurseTimes - 1;
    if (isMap) {
      const [k, v] = entry;
      output.push(`${formatValue(ctx, k, nextRecurse)} => ${formatValue(ctx, v, nextRecurse)}`);
    } else {
      output.push(formatValue(ctx, entry, nextRecurse));
    }
    if (++i >= 100 && value.size > 100) {
      output.push(`... ${value.size - i} more items`);
      break;
    }
  }
  return output;
}

/**
 * Formats a single property, honoring the getters option.
 * @param {ReturnType<typeof makeCtx>} ctx
 * @param {any} value
 * @param {number|null} recurseTimes
 * @param {string|symbol} key
 * @param {boolean} isArray
 */
function formatProperty(ctx, value, recurseTimes, key, isArray) {
  const desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  const mode = ctx.options.getters || false;
  let str;
  if (desc.get || desc.set) {
    const hasGet = !!desc.get;
    const hasSet = !!desc.set;
    const evalGet = () => {
      try {
        const v = formatValue(ctx, value[key], recurseTimes === null ? null : recurseTimes - 1);
        return hasSet ? `[Getter/Setter: ${v}]` : `[Getter: ${v}]`;
      } catch (err) {
        return `[Getter: <Inspection threw (${err.message})>]`;
      }
    };
    if (mode === false) {
      str = ctx.stylize(hasGet && hasSet ? '[Getter/Setter]' : hasGet ? '[Getter]' : '[Setter]', 'special');
    } else if (mode === 'get') {
      str = hasSet
        ? ctx.stylize(hasGet ? '[Getter/Setter]' : '[Setter]', 'special')
        : evalGet();
    } else if (mode === 'set') {
      str = (hasGet && hasSet) ? evalGet()
        : ctx.stylize(hasGet ? '[Getter]' : '[Setter]', 'special');
    } else { // true
      str = hasGet ? evalGet() : ctx.stylize('[Setter]', 'special');
    }
    } else if (ctx.seen.includes(desc.value)) {
    const idx = ctx.seen.indexOf(desc.value);
    ctx.circularCounts.set(idx, (ctx.circularCounts.get(idx) || 1) + 1);
    if (ctx.circularCounts.get(idx) === 2) ctx.marked.add(idx);
    str = ctx.stylize(`[Circular *${idx + 1}]`, 'special');
  } else {
    str = formatValue(ctx, desc.value, recurseTimes === null ? null : recurseTimes - 1);
  }

  if (typeof key === 'symbol') {
    return `[${ctx.stylize(String(key), 'symbol')}]: ${str}`;
  }
  if (isArray && /^\d+$/.test(key)) return str;
  const name = /^[a-zA-Z_$][a-zA-Z_$0-9]*$/.test(key)
    ? ctx.stylize(key, 'name')
    : quoteString(key);
  return `${name}: ${str}`;
}

/**
 * Joins property output, choosing single-line vs multiline layout the way
 * Node's reduceToSingleString does (compact budget + breakLength).
 * @param {ReturnType<typeof makeCtx>} ctx
 * {string[]} output
 * @param {string} tag e.g. '', '[Object: null prototype]', 'Map(2)'
 * @param {[string, string]} braces
 * @param {number} level
 * @param {boolean} rightAlign right-align entries (arrays)
 */
function reduceToSingleString(ctx, output, tag, braces, level, rightAlign = false) {
  const options = ctx.options;
  const breakLength = options.breakLength ?? 60;
  const compact = options.compact ?? 3;
  const budget = compact === true ? Infinity : compact === false ? -1
    : (typeof compact === 'number' ? compact : 3);
  const prefix = tag === '' ? '' : `${tag} `;

  if (output.length === 0) return `${prefix}${braces[0]}${braces[1]}`;

  let length = prefix.length + braces[0].length + braces[1].length;
  for (const o of output) length += o.replace(ansiLenRegex, '').length + 2;

  if (level < budget && length <= breakLength) {
    return `${prefix}${braces[0]} ${output.join(', ')} ${braces[1]}`;
  }

  const indent = '  '.repeat(level + 1);
  const closing = '  '.repeat(level);
  let props = output;
  if (rightAlign) {
    const widths = output.map((o) => o.replace(ansiLenRegex, '').length);
    const max = Math.max(...widths);
    props = output.map((o, i) => (widths[i] === max ? o : ' '.repeat(max - widths[i]) + o));
  }
  return `${prefix}${braces[0]}\n${indent}${props.join(`,\n${indent}`)}\n${closing}${braces[1]}`;
}

/**
 * @param {string} k
 */
function isCanonicalArrayIndex(k) {
  if (k === '') return false;
  const n = Number(k);
  return Number.isSafeInteger(n) && n >= 0 && n < 2 ** 32 - 1 && String(n) === k;
}

/**
 * @param {ReturnType<typeof makeCtx>} ctx
 * @param {any} value
 * @returns {(string|symbol)[]}
 */
function getKeys(ctx, value) {
  /** @type {(string|symbol)[]} */
  let keys;
  if (ctx.options.showHidden) {
    keys = [...Object.getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)];
  } else {
    keys = Object.keys(value);
    for (const sym of Object.getOwnPropertySymbols(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, sym);
      if (desc && desc.enumerable) keys.push(sym);
    }
  }
  const sorted = ctx.options.sorted;
  const strKeys = /** @type {string[]} */ (keys.filter((k) => typeof k === 'string'));
  const symKeys = keys.filter((k) => typeof k === 'symbol');
  if (sorted === true || sorted === 'asc') strKeys.sort();
  else if (sorted === 'desc') strKeys.sort().reverse();
  else if (typeof sorted === 'function') strKeys.sort(sorted);
  return [...strKeys, ...symKeys];
}

/**
 * @param {ReturnType<typeof makeCtx>} ctx
 * @param {any[]} value
 * @param {number|null} recurseTimes
 * @param {(string|symbol)[]} extraKeys
 */
function formatArrayEntries(ctx, value, recurseTimes, extraKeys) {
  const output = [];
  const maxArrayLength = ctx.options.maxArrayLength ?? 100;
  const len = Math.min(value.length, maxArrayLength);
  for (let i = 0; i < len; i++) {
    if (hasOwn(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, String(i), true));
    } else {
      let empty = 1;
      while (i + empty < value.length && !hasOwn(value, String(i + empty))) empty++;
      output.push(`<${empty} empty item${empty === 1 ? '' : 's'}>`);
      i += empty - 1;
    }
  }
  if (value.length > maxArrayLength) {
    output.push(`... ${value.length - maxArrayLength} more item${value.length - maxArrayLength === 1 ? '' : 's'}`);
  }
  for (const key of extraKeys) output.push(formatProperty(ctx, value, recurseTimes, key, true));
  return output;
}

/**
 * @param {ReturnType<typeof makeCtx>} ctx
 * @param {ArrayLike<number>} value
 */
function formatTypedArray(ctx, value) {
  const output = [];
  const max = ctx.options.maxArrayLength ?? 100;
  const len = Math.min(value.length, max);
  for (let i = 0; i < len; i++) output.push(formatPrimitive(ctx, value[i]));
  if (value.length > max) output.push(`... ${value.length - max} more items`);
  return `[ ${output.join(', ')} ]`;
}

/**
 * The core recursive value formatter.
 * @param {ReturnType<typeof makeCtx>} ctx
 * @param {any} value
 * @param {number|null} recurseTimes
 * @param {number} level
 * @returns {string}
 */
function formatValue(ctx, value, recurseTimes, level = 0) {
  // custom inspect hook
  if (ctx.options.customInspect && value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const custom = value[inspect.custom];
    if (typeof custom === 'function') {
      const depth = recurseTimes;
      let ret = custom.call(value, depth, ctx, ctx.options);
      if (typeof ret !== 'string') ret = formatValue(ctx, ret, recurseTimes, level);
      return ret;
    }
  }

  const primitive = formatPrimitive(ctx, value);
  if (primitive !== undefined) return primitive;

  if (types.isPromise(value)) return formatPromise();

  // circular check (push/pop stack)
  const seenIdx = ctx.seen.indexOf(value);
  if (seenIdx !== -1) {
    ctx.circularCounts.set(seenIdx, (ctx.circularCounts.get(seenIdx) || 1) + 1);
    if (ctx.circularCounts.get(seenIdx) === 2) ctx.marked.add(seenIdx);
    return ctx.stylize(`[Circular *${seenIdx + 1}]`, 'special');
  }
  const idx = ctx.seen.length;
  ctx.seen.push(value);
  ctx.circularCounts.set(idx, 1);

  /** @param {string} s */
  const finish = (s) => {
    ctx.seen.pop();
    ctx.circularCounts.delete(idx);
    if (ctx.marked.has(idx)) {
      ctx.marked.delete(idx);
      return `<ref *${idx + 1}> ${s}`;
    }
    return s;
  };

  const nextRecurse = recurseTimes === null ? null : recurseTimes - 1;

  // ---- Error
  if (types.isNativeError(value)) {
    let base = typeof value.stack === 'string' && value.stack !== ''
      ? value.stack
      : formatError(value);
    if (!base.startsWith(value.name || 'Error')) base = formatError(value);
    const keys = getKeys(ctx, value);
    /** @type {string[]} */
    const extraProps = [];
    if (value.cause !== undefined && !Object.prototype.propertyIsEnumerable.call(value, 'cause')) {
      extraProps.push(`${ctx.stylize('[cause]', 'special')}: ${formatValue(ctx, value.cause, nextRecurse, level + 1)}`);
    }
    const output = keys.map((key) => formatProperty(ctx, value, recurseTimes, key, false)).concat(extraProps);
    if (output.length === 0) return finish(base);
    if (base.includes('\n') || output.length > 0) {
      const indent = '  '.repeat(level + 1);
      const closing = '  '.repeat(level);
      return finish(`${base} {\n${indent}${output.join(`,\n${indent}`)}\n${closing}}`);
    }
    return finish(`${base} { ${output.join(', ')} }`);
  }

  // ---- ArrayBuffer / SharedArrayBuffer
  if (types.isAnyArrayBuffer(value)) {
    const name = types.isSharedArrayBuffer(value) ? 'SharedArrayBuffer' : 'ArrayBuffer';
    return finish(`${name} { ${ctx.stylize('[Uint8Contents]', 'special')}: ${formatArrayBufferContents(value)}, byteLength: ${value.byteLength} }`);
  }

  // ---- TypedArray
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const ctorName = value.constructor && value.constructor.name ? value.constructor.name : 'TypedArray';
    const arr = formatTypedArray(ctx, value);
    const keys = getKeys(ctx, value).filter((k) =>
      !['length', 'byteLength', 'byteOffset', 'buffer'].includes(String(k)) &&
      !isCanonicalArrayIndex(String(k)));
    if (keys.length === 0) return finish(`${ctorName}(${value.length}) ${arr}`);
    const extra = keys.map((key) => formatProperty(ctx, value, recurseTimes, key, false));
    return finish(`${ctorName}(${value.length}) ${arr} ${extra.join(', ')}`);
  }

  // ---- DataView
  if (value instanceof DataView) {
    const base = `DataView { byteLength: ${value.byteLength}, byteOffset: ${value.byteOffset}, buffer: ` +
      formatValue(ctx, value.buffer, nextRecurse, level + 1) + ' }';
    return finish(base);
  }

  // ---- Map / Set / WeakMap / WeakSet
  if (types.isMap(value)) {
    const entries = formatCollection(ctx, value, recurseTimes, true);
    return finish(reduceToSingleString(ctx, entries, `Map(${value.size})`, ['{', '}'], level));
  }
  if (types.isSet(value)) {
    const entries = formatCollection(ctx, value, recurseTimes, false);
    return finish(reduceToSingleString(ctx, entries, `Set(${value.size})`, ['{', '}'], level));
  }
  if (types.isWeakMap(value) || types.isWeakSet(value)) {
    const name = types.isWeakMap(value) ? 'WeakMap' : 'WeakSet';
    return finish(`${name} { ${ctx.stylize('<items unknown>', 'special')} }`);
  }

  // ---- Proxy (best effort)
  if (ctx.options.showProxy) {
    return finish(`Proxy [ ${ctx.stylize('<target unknown>', 'special')}, ${ctx.stylize('<handler unknown>', 'special')} ]`);
  }

  // ---- generic object / array / function / date / regexp
  let tag = '';
  let braces = ['{', '}'];
  let isArr = false;
  /** braces are always shown (objects/arrays) vs only when there are keys (fn/date/re) */
  let bracesAlways = true;

  if (Array.isArray(value)) {
    isArr = true;
    braces = ['[', ']'];
  } else if (typeof value === 'function') {
    if (isClass(value)) return finish(`[class${value.name ? ' ' + value.name : ''}]`);
    const prefix = types.isAsyncGeneratorFunction(value) ? 'AsyncGeneratorFunction'
      : types.isGeneratorFunction(value) ? 'GeneratorFunction'
      : types.isAsyncFunction(value) ? 'AsyncFunction'
      : 'Function';
    const name = value.name ? `: ${value.name}` : ' (anonymous)';
    tag = `[${prefix}${name}]`;
    bracesAlways = false;
  } else if (types.isRegExp(value)) {
    tag = RegExp.prototype.toString.call(value);
    bracesAlways = false;
  } else if (types.isDate(value)) {
    try { tag = Date.prototype.toISOString.call(value); }
    catch { tag = Date.prototype.toString.call(value); }
    bracesAlways = false;
  } else if (types.isBoxedPrimitive(value)) {
    const name = objectToString(value).slice(8, -1);
    const inner = formatPrimitive(ctx, value.valueOf());
    tag = `[${name}: ${inner}]`;
    bracesAlways = false;
  } else if (objectToString(value) === '[object Object]') {
    const proto = Object.getPrototypeOf(value);
    if (proto === null) tag = '[Object: null prototype]';
    else if (value.constructor && value.constructor.name && value.constructor.name !== 'Object')
      tag = value.constructor.name;
  } else {
    tag = objectToString(value);
  }

  const allKeys = getKeys(ctx, value);
  const keys = (isArr || (typeof value === 'object' && value !== null && types.isBoxedPrimitive(value)))
    ? allKeys.filter((k) => typeof k === 'symbol' || !isCanonicalArrayIndex(String(k)))
    : allKeys;

  if (keys.length === 0 && (!isArr || value.length === 0)) {
    if (!bracesAlways) return finish(tag);
    return finish(reduceToSingleString(ctx, [], tag, braces, level));
  }

  if (recurseTimes !== null && recurseTimes < 0) {
    if (isArr) return finish(ctx.stylize('[Array]', 'special'));
    if (typeof value === 'function') return finish(ctx.stylize('[Function]', 'special'));
    return finish(ctx.stylize('[Object]', 'special'));
  }

  if (isArr) {
    const output = formatArrayEntries(ctx, value, recurseTimes, keys);
    return finish(reduceToSingleString(ctx, output, tag, braces, level, true));
  }
  const output = keys.map((key) => formatProperty(ctx, value, recurseTimes, key, false));
  return finish(reduceToSingleString(ctx, output, tag, braces, level));
}

/**
 * Returns a string representation of `object` formatted like node:util.inspect.
 * @param {any} object
 * @param {InspectOptions|boolean} [opts] Boolean means legacy `showHidden`.
 * @returns {string}
 */
export function inspect(object, opts) {
  const options = normalizeInspectOptions(opts);
  // legacy signature: inspect(obj, showHidden, depth, colors)
  if (arguments.length >= 3) options.depth = arguments[2];
  if (arguments.length >= 4) options.colors = !!arguments[3];
  const ctx = makeCtx(options);
  return formatValue(ctx, object, options.depth === null ? null : options.depth, 0);
}

/** @param {InspectOptions|boolean|undefined} opts */
function normalizeInspectOptions(opts) {
  /** @type {InspectOptions} */
  const options = { ...inspect.defaultOptions };
  if (typeof opts === 'boolean') options.showHidden = opts;
  else if (opts) Object.assign(options, opts);
  if (options.depth === null) options.depth = null;
  return options;
}

inspect.custom = Symbol('nodejs.util.inspect.custom');
inspect.colors = inspectColors;
inspect.styles = inspectStyles;
inspect.defaultOptions = {
  showHidden: false,
  depth: 2,
  colors: false,
  customInspect: false,
  showProxy: false,
  maxArrayLength: 100,
  maxStringLength: 10000,
  breakLength: 60,
  compact: 3,
  sorted: false,
  getters: false,
  numericSeparator: false,
};

// ---------------------------------------------------------------------------
// format / formatWithOptions
// ---------------------------------------------------------------------------

const formatRegExp = /%[sdifjoOc%]/g;

/**
 * Formats a string using printf-like placeholders (%s %d %i %f %j %o %O %c %%).
 * If the first argument is not a string, all arguments are inspected.
 * @param {any} f
 * @param {...any} args
 * @returns {string}
 */
export function format(f, ...args) {
  if (arguments.length === 0) return '';
  return formatWithOptions(undefined, f, ...args);
}

/**
 * Same as {@link format} but forwards `inspectOptions` to the internal
 * `inspect()` calls for %o/%O and non-string arguments.
 * @param {InspectOptions|undefined} inspectOptions
 * @param {any} f
 * @param {...any} args
 * @returns {string}
 */
export function formatWithOptions(inspectOptions, f, ...args) {
  if (inspectOptions !== undefined &&
      (inspectOptions === null || typeof inspectOptions !== 'object')) {
    throw ERR_INVALID_ARG_TYPE('inspectOptions', 'object', inspectOptions);
  }
  const first = f;
  const rest = typeof first === 'string' ? args : [first, ...args];
  let a = 0;
  let str = '';
  const join = ' ';

  if (typeof first === 'string') {
    if (rest.length === 0) return first;
    str = first.replace(formatRegExp, (x) => {
      if (x === '%%') return '%';
      if (a >= rest.length) return x;
      switch (x) {
        case '%s': return String(rest[a++]);
        case '%d': return String(Number(rest[a++]));
        case '%i': return String(parseInt(rest[a++], 10));
        case '%f': return String(parseFloat(rest[a++]));
        case '%j':
          try { return JSON.stringify(rest[a++]); }
          catch { return '[Circular]'; }
        case '%o': case '%O': return inspect(rest[a++], inspectOptions);
        case '%c': a++; return '';
        default: return x;
      }
    });
  }

  while (a < rest.length) {
    const value = rest[a++];
    str += str === '' ? '' : join;
    str += typeof value === 'string' ? value : inspect(value, inspectOptions);
  }
  return str;
}

// ---------------------------------------------------------------------------
// styleText
// ---------------------------------------------------------------------------

/**
 * Browser stand-in for internal/util/colors shouldColorize().
 * Honors NO_COLOR / FORCE_COLOR / TERM and a non-TTY stream.
 * @param {any} stream
 */
function shouldColorize(stream) {
  const env = (typeof process !== 'undefined' && process.env) || {};
  if ('NO_COLOR' in env) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
  if (env.TERM === 'dumb') return false;
  return !(stream && stream.isTTY === false);
}

/**
 * Applies ANSI style(s) to text. Accepts named styles, hex colors (#RGB /
 * #RRGGBB), arrays for nesting, or 'none'. Matches node:util styleText.
 * @param {string|string[]} format - Style name(s) or hex color(s).
 * @param {string} text - Text to style.
 * @param {{ validateStream?: boolean, stream?: any }} [options]
 * @returns {string}
 * @throws {TypeError} ERR_INVALID_ARG_TYPE / ERR_INVALID_ARG_VALUE
 */
export function styleText(format, text, options) {
  const validateStream = options?.validateStream ?? true;

  // Fast path: single format string with validateStream=false
  if (!validateStream && typeof format === 'string' && typeof text === 'string') {
    const cache = getStyleCache();
    if (format === 'none') return text;
    const style = cache[format];
    if (style !== undefined) {
      const processed = replaceCloseCode(text, style.closeSeq, style.openSeq, style.keepClose);
      return style.openSeq + processed + style.closeSeq;
    }
    if (format[0] === '#') {
      let hexStyle = hexStyleCache.get(format);
      if (hexStyle === undefined && hexColorRegExp.test(format)) hexStyle = getHexStyle(format);
      if (hexStyle !== undefined) {
        const processed = replaceCloseCode(text, hexStyle.closeSeq, hexStyle.openSeq, false);
        return hexStyle.openSeq + processed + hexStyle.closeSeq;
      }
    }
  }

  validateString(text, 'text');
  if (options !== undefined) validateObject(options, 'options');
  validateBoolean(validateStream, 'options.validateStream');

  let skipColorize;
  if (validateStream) {
    const stream = options?.stream ?? process.stdout;
    if (stream === null || (typeof stream !== 'object' && typeof stream !== 'function')) {
      throw ERR_INVALID_ARG_TYPE('stream', ['ReadableStream', 'WritableStream', 'Stream'], stream);
    }
    skipColorize = !shouldColorize(stream);
  }

  const formatArray = Array.isArray(format) ? format : [format];

  let openCodes = '';
  let closeCodes = '';
  let processedText = text;

  for (const key of formatArray) {
    if (key === 'none') continue;

    if (typeof key === 'string' && key[0] === '#') {
      if (!hexColorRegExp.test(key)) {
        throw ERR_INVALID_ARG_VALUE('format', key, 'must be a valid hex color (#RGB or #RRGGBB)');
      }
      if (skipColorize) continue;
      const [r, g, b] = hexToRgb(key);
      const hexOpenSeq = `${kEscape}${rgbToAnsi24Bit(r, g, b)}${kEscapeEnd}`;
      openCodes += hexOpenSeq;
      closeCodes = kHexCloseSeq + closeCodes;
      processedText = replaceCloseCode(processedText, kHexCloseSeq, hexOpenSeq, false);
      continue;
    }

    const codes = inspectColors[key];
    if (!codes) {
      validateOneOf(key, 'format', Object.getOwnPropertyNames(inspectColors));
    }
    const { openSeq, closeSeq, keepClose } = codesToStyle(codes);
    openCodes += openSeq;
    closeCodes = closeSeq + closeCodes;
    processedText = replaceCloseCode(processedText, closeSeq, openSeq, keepClose);
  }

  if (skipColorize) return text;

  return `${openCodes}${processedText}${closeCodes}`;
}

// ---------------------------------------------------------------------------
// deprecate
// ---------------------------------------------------------------------------

/**
 * Marks a function as deprecated. The wrapper warns once (or throws with
 * `process.throwDeprecation`, traces with `process.traceDeprecation`).
 * @param {Function} fn
 * @param {string} msg
 * @param {string} [code] - Deprecation code, e.g. 'DEP0001'.
 * @param {{ modifyPrototype?: boolean }} [options]
 * @returns {Function}
 */
export function deprecate(fn, msg, code, { modifyPrototype } = {}) {
  validateFunction(fn, 'fn');
  validateString(msg, 'msg');
  if (code !== undefined) validateString(code, 'code');

  if (typeof process !== 'undefined' && process.noDeprecation === true) return fn;

  let warned = false;
  function deprecated(...args) {
    if (!warned) {
      const prefix = code ? `[${code}] ` : '';
      if (process.throwDeprecation) {
        throw E(code || 'DEPRECATION', `${prefix}DeprecationWarning: ${msg}`);
      } else if (process.traceDeprecation) {
        console.trace(`${prefix}DeprecationWarning: ${msg}`);
      } else {
        console.error(`${prefix}DeprecationWarning: ${msg}`);
      }
      warned = true;
    }
    return fn.apply(this, args);
  }

  if (modifyPrototype && typeof fn.prototype === 'object' && fn.prototype !== null) {
    for (const key of Object.getOwnPropertyNames(fn.prototype)) {
      const desc = Object.getOwnPropertyDescriptor(fn.prototype, key);
      if (desc && typeof desc.value === 'function') {
        Object.defineProperty(fn.prototype, key, {
          ...desc,
          value: deprecate(desc.value, msg, code),
        });
      }
    }
  }

  return deprecated;
}

// ---------------------------------------------------------------------------
// debuglog
// ---------------------------------------------------------------------------

let debugEnvRegex = /^$/;
let debugEnvInitialized = false;
/** @type {Record<string, ((...args: any[]) => void) & { enabled?: boolean }>} */
const debugs = {};

function initializeDebugLog() {
  debugEnvInitialized = true;
  const debugEnv = (typeof process !== 'undefined' && process.env && process.env.NODE_DEBUG) || '';
  const parts = debugEnv.split(',').map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => v.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*'));
  debugEnvRegex = parts.length ? new RegExp(`^(?:${parts.join('|')})$`, 'i') : /^$/;
}

/**
 * @param {boolean} enabled
 * @param {string} section
 */
function debuglogImpl(enabled, section) {
  const d = /** @type {any} */ ((...args) => {
    const msg = format(...args);
    const pid = (typeof process !== 'undefined' && process.pid) || 0;
    console.error(`${section} ${pid}: ${msg}`);
  });
  d.enabled = enabled;
  return d;
}

/**
 * Creates a logging function gated by the NODE_DEBUG environment variable.
 * The returned function has an `enabled` boolean; an optional callback fires
 * once with `{ enabled }`.
 * @param {string} set
 * @param {({ enabled: boolean }) => void} [callback]
 * @returns {((...args: any[]) => void) & { enabled: boolean }}
 */
export function debuglog(set, callback) {
  validateString(set, 'section');
  if (callback !== undefined) validateFunction(callback, 'callback');
  if (!debugEnvInitialized) initializeDebugLog();
  const section = StringPrototypeToUpperCase(set);
  let d = debugs[section];
  if (d === undefined) {
    const enabled = debugEnvRegex.test(section);
    d = debuglogImpl(enabled, section);
    debugs[section] = d;
    if (callback) callback({ enabled });
  }
  return /** @type {any} */ (d);
}

const StringPrototypeToUpperCase = (s) => s.toUpperCase();

/** Alias of {@link debuglog}. */
export const debug = debuglog;

// ---------------------------------------------------------------------------
// inherits
// ---------------------------------------------------------------------------

/**
 * Inherits the prototype methods from one constructor into another.
 * @param {Function} ctor
 * @param {Function} superCtor
 * @throws {TypeError} ERR_INVALID_ARG_TYPE
 */
export function inherits(ctor, superCtor) {
  if (ctor === undefined || ctor === null)
    throw ERR_INVALID_ARG_TYPE('ctor', 'Function', ctor);
  if (superCtor === undefined || superCtor === null)
    throw ERR_INVALID_ARG_TYPE('superCtor', 'Function', superCtor);
  if (superCtor.prototype === undefined)
    throw ERR_INVALID_ARG_TYPE('superCtor.prototype', 'Object', superCtor.prototype);

  Object.defineProperty(ctor, 'super_', {
    value: superCtor,
    writable: true,
    configurable: true,
  });
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

// ---------------------------------------------------------------------------
// promisify / callbackify
// ---------------------------------------------------------------------------

const kCustomPromisifiedSymbol = typeof Symbol !== 'undefined'
  ? Symbol('util.promisify.custom')
  : undefined;

/**
 * Takes a function following the common error-first callback style
 * (fn(...args, cb)) and returns a promise-returning version.
 * @template T
 * @param {(...args: any[]) => any} original
 * @returns {(...args: any[]) => Promise<T>}
 */
export function promisify(original) {
  if (typeof original !== 'function')
    throw ERR_INVALID_ARG_TYPE('original', 'Function', original);

  if (kCustomPromisifiedSymbol && original[kCustomPromisifiedSymbol]) {
    const fn = original[kCustomPromisifiedSymbol];
    if (typeof fn !== 'function')
      throw ERR_INVALID_ARG_TYPE('original[util.promisify.custom]', 'Function', fn);
    Object.defineProperty(fn, kCustomPromisifiedSymbol, {
      value: fn, enumerable: false, writable: false, configurable: true,
    });
    return fn;
  }

  /** @this {any} */
  function fn(...args) {
    return new Promise((resolve, reject) => {
      args.push(function (err, value) {
        if (err) reject(err);
        else resolve(value);
      });
      try {
        original.apply(this, args);
      } catch (err) {
        reject(err);
      }
    });
  }

  Object.setPrototypeOf(fn, Object.getPrototypeOf(original));

  if (kCustomPromisifiedSymbol) {
    Object.defineProperty(fn, kCustomPromisifiedSymbol, {
      value: fn, enumerable: false, writable: false, configurable: true,
    });
  }
  return Object.defineProperties(fn, getOwnPropertyDescriptors(original));
}

promisify.custom = kCustomPromisifiedSymbol;

const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors ||
  function getOwnPropertyDescriptors(obj) {
    const keys = Object.keys(obj);
    const descriptors = {};
    for (let i = 0; i < keys.length; i++) {
      descriptors[keys[i]] = Object.getOwnPropertyDescriptor(obj, keys[i]);
    }
    return descriptors;
  };

/** @param {any} reason @param {(err:any)=>void} cb */
const callbackifyOnRejected = (reason, cb) => {
  if (!reason) {
    const newReason = new Error('Promise was rejected with a falsy value');
    newReason.reason = reason;
    reason = newReason;
  }
  return cb(reason);
};

/**
 * Converts a promise-returning function into an error-first callback style one.
 * @param {(...args: any[]) => Promise<any>} original
 * @returns {(...args: [...any[], (err:any, val?:any)=>void]) => void}
 */
export function callbackify(original) {
  if (typeof original !== 'function')
    throw ERR_INVALID_ARG_TYPE('original', 'Function', original);

  function callbackified(...args) {
    const maybeCb = args.pop();
    if (typeof maybeCb !== 'function')
      throw ERR_INVALID_ARG_TYPE('last argument', 'Function', maybeCb);
    const self = this;
    const cb = (...cbArgs) => maybeCb.apply(self, cbArgs);
    original.apply(this, args).then(
      (ret) => process.nextTick(cb, null, ret),
      (rej) => process.nextTick(callbackifyOnRejected, rej, cb)
    );
  }

  Object.setPrototypeOf(callbackified, Object.getPrototypeOf(original));
  Object.defineProperties(callbackified, getOwnPropertyDescriptors(original));
  return callbackified;
}

// ---------------------------------------------------------------------------
// isDeepStrictEqual
// ---------------------------------------------------------------------------

/**
 * @param {any} a @param {any} b
 * @param {Set<any>} seen
 */
function deepEqualInner(a, b, seen, skipPrototype) {
  if (a === b) return a !== 0 || 1 / a === 1 / b; // 0 !== -0
  if (Number.isNaN(a) && Number.isNaN(b)) return true; // NaN equals NaN
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;

  // boxed primitives compare unboxed values
  if (types.isBoxedPrimitive(a) || types.isBoxedPrimitive(b)) {
    if (!types.isBoxedPrimitive(a) || !types.isBoxedPrimitive(b)) return false;
    return deepEqualInner(a.valueOf(), b.valueOf(), seen, skipPrototype);
  }

  // cycle guard for distinct references
  let pairs = seen.get(a);
  if (pairs !== undefined && pairs.has(b)) return true;
  if (pairs === undefined) { pairs = new Set(); seen.set(a, pairs); }
  pairs.add(b);

  if (types.isDate(a) || types.isDate(b)) {
    return types.isDate(a) && types.isDate(b) && a.getTime() === b.getTime();
  }
  if (types.isRegExp(a) || types.isRegExp(b)) {
    return types.isRegExp(a) && types.isRegExp(b) &&
           a.source === b.source && a.flags === b.flags;
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!(ArrayBuffer.isView(a) && ArrayBuffer.isView(b))) return false;
    if (a.constructor !== b.constructor) return false;
    const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (ua.length !== ub.length) return false;
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  }
  if (types.isAnyArrayBuffer(a) || types.isAnyArrayBuffer(b)) {
    if (!(types.isAnyArrayBuffer(a) && types.isAnyArrayBuffer(b))) return false;
    if (a.byteLength !== b.byteLength) return false;
    const ua = new Uint8Array(a), ub = new Uint8Array(b);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  }
  if (types.isNativeError(a) || types.isNativeError(b)) {
    if (!(types.isNativeError(a) && types.isNativeError(b))) return false;
    if (a.name !== b.name || a.message !== b.message) return false;
  }
  if (types.isWeakMap(a) || types.isWeakSet(a) || types.isWeakMap(b) || types.isWeakSet(b)) {
    return false; // cannot compare contents
  }
  if (types.isMap(a) || types.isMap(b)) {
    if (!(types.isMap(a) && types.isMap(b))) return false;
    if (a.size !== b.size) return false;
    const aEntries = [...a.entries()];
    const bEntries = [...b.entries()];
    const used = new Array(bEntries.length).fill(false);
    outer: for (const [ka, va] of aEntries) {
      for (let i = 0; i < bEntries.length; i++) {
        if (used[i]) continue;
        const [kb, vb] = bEntries[i];
        if (deepEqualInner(ka, kb, seen, skipPrototype) && deepEqualInner(va, vb, seen, skipPrototype)) {
          used[i] = true; continue outer;
        }
      }
      return false;
    }
    return true;
  }
  if (types.isSet(a) || types.isSet(b)) {
    if (!(types.isSet(a) && types.isSet(b))) return false;
    if (a.size !== b.size) return false;
    const aVals = [...a.values()];
    const bVals = [...b.values()];
    const used = new Array(bVals.length).fill(false);
    outer: for (const va of aVals) {
      for (let i = 0; i < bVals.length; i++) {
        if (used[i]) continue;
        if (deepEqualInner(va, bVals[i], seen, skipPrototype)) { used[i] = true; continue outer; }
      }
      return false;
    }
    return true;
  }

  const aIsArr = Array.isArray(a), bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return false;
  if (aIsArr && bIsArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const aHas = hasOwn(a, i), bHas = hasOwn(b, i);
      if (aHas !== bHas) return false;
      if (aHas && !deepEqualInner(a[i], b[i], seen, skipPrototype)) return false;
    }
  } else if (!skipPrototype) {
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!hasOwn(b, k)) return false;
    if (!deepEqualInner(a[k], b[k], seen, skipPrototype)) return false;
  }
  return true;
}

/**
 * Returns true if `a` and `b` are deeply strictly equal (same type, same
 * structure, same values). NaN equals NaN; 0 does not equal -0.
 * @param {any} a
 * @param {any} b
 * @param {boolean} [skipPrototype] - skip prototype comparison for plain objects.
 * @returns {boolean}
 */
export function isDeepStrictEqual(a, b, skipPrototype = false) {
  return deepEqualInner(a, b, new Map(), skipPrototype);
}

// ---------------------------------------------------------------------------
// system errors
// ---------------------------------------------------------------------------

/** @type {Map<number, [string, string]>} */
const systemErrorMap = new Map(Object.entries({
  1: ['EPERM', 'operation not permitted'],
  2: ['ENOENT', 'no such file or directory'],
  3: ['ESRCH', 'no such process'],
  4: ['EINTR', 'interrupted system call'],
  5: ['EIO', 'i/o error'],
  6: ['ENXIO', 'no such device or address'],
  7: ['E2BIG', 'argument list too long'],
  8: ['ENOEXEC', 'exec format error'],
  9: ['EBADF', 'bad file descriptor'],
  10: ['ECHILD', 'no child processes'],
  11: ['EAGAIN', 'resource temporarily unavailable'],
  12: ['ENOMEM', 'not enough memory'],
  13: ['EACCES', 'permission denied'],
  14: ['EFAULT', 'bad address'],
  16: ['EBUSY', 'resource busy or locked'],
  17: ['EEXIST', 'file already exists'],
  18: ['EXDEV', 'cross-device link not permitted'],
  19: ['ENODEV', 'no such device'],
  20: ['ENOTDIR', 'not a directory'],
  21: ['EISDIR', 'is a directory'],
  22: ['EINVAL', 'invalid argument'],
  23: ['ENFILE', 'too many open files in system'],
  24: ['EMFILE', 'too many open files'],
  25: ['ENOTTY', 'inappropriate ioctl for device'],
  26: ['ETXTBSY', 'text file is busy'],
  27: ['EFBIG', 'file too large'],
  28: ['ENOSPC', 'no space left on device'],
  29: ['ESPIPE', 'illegal seek'],
  30: ['EROFS', 'read-only file system'],
  31: ['EMLINK', 'too many links'],
  32: ['EPIPE', 'broken pipe'],
  33: ['EDOM', 'domain error'],
  34: ['ERANGE', 'result too large'],
  36: ['EDEADLK', 'resource deadlock avoided'],
  37: ['ENAMETOOLONG', 'name too long'],
  38: ['ENOLCK', 'no locks available'],
  39: ['ENOSYS', 'function not implemented'],
  40: ['ENOTEMPTY', 'directory not empty'],
  41: ['ELOOP', 'too many symbolic links encountered'],
  42: ['EPROTOTYPE', 'protocol wrong type for socket'],
  43: ['ENOPROTOOPT', 'protocol not available'],
  44: ['EPROTONOSUPPORT', 'protocol not supported'],
  45: ['EOPNOTSUPP', 'operation not supported'],
  47: ['EAFNOSUPPORT', 'address family not supported'],
  48: ['EADDRINUSE', 'address already in use'],
  49: ['EADDRNOTAVAIL', 'address not available'],
  50: ['ENETDOWN', 'network is down'],
  51: ['ENETUNREACH', 'network is unreachable'],
  52: ['ENETRESET', 'network connection reset'],
  53: ['ECONNABORTED', 'software caused connection abort'],
  54: ['ECONNRESET', 'connection reset by peer'],
  55: ['ENOBUFS', 'no buffer space available'],
  56: ['EISCONN', 'socket is already connected'],
  57: ['ENOTCONN', 'socket is not connected'],
  58: ['ESHUTDOWN', 'cannot send after transport endpoint shutdown'],
  60: ['ETIMEDOUT', 'connection timed out'],
  61: ['ECONNREFUSED', 'connection refused'],
  63: ['ENAMETOOLONG', 'name too long'],
  64: ['EHOSTDOWN', 'host is down'],
  65: ['EHOSTUNREACH', 'host is unreachable'],
  66: ['ENOTEMPTY', 'directory not empty'],
  67: ['EUSERS', 'too many users'],
  69: ['EDQUOT', 'disk quota exceeded'],
  70: ['ESTALE', 'stale file handle'],
  71: ['EREMOTE', 'remote I/O error'],
  73: ['EOVERFLOW', 'value too large for defined data type'],
  74: ['EBADMSG', 'bad message'],
  75: ['EPROTOTYPE', 'protocol wrong type for socket'],
  76: ['ENOPROTOOPT', 'protocol not available'],
  77: ['EPROTONOSUPPORT', 'protocol not supported'],
  78: ['EOPNOTSUPP', 'operation not supported'],
  80: ['EINPROGRESS', 'operation now in progress'],
  81: ['EALREADY', 'operation already in progress'],
  82: ['ENOTSOCK', 'socket operation on non-socket'],
  83: ['EDESTADDRREQ', 'destination address required'],
  84: ['EMSGSIZE', 'message too long'],
  85: ['EPROTOTYPE', 'protocol wrong type for socket'],
  86: ['ENOPROTOOPT', 'protocol not available'],
  87: ['EPROTONOSUPPORT', 'protocol not supported'],
  88: ['ESOCKTNOSUPPORT', 'socket type not supported'],
  89: ['EOPNOTSUPP', 'operation not supported'],
  90: ['EPFNOSUPPORT', 'protocol family not supported'],
  91: ['EADDRINUSE', 'address already in use'],
  92: ['EADDRNOTAVAIL', 'address not available'],
  93: ['ENETDOWN', 'network is down'],
  94: ['ENETUNREACH', 'network is unreachable'],
  95: ['ENETRESET', 'network connection reset'],
  96: ['ECONNABORTED', 'software caused connection abort'],
  97: ['ECONNRESET', 'connection reset by peer'],
  98: ['ENOBUFS', 'no buffer space available'],
  99: ['EISCONN', 'socket is already connected'],
  100: ['ENOTCONN', 'socket is not connected'],
  101: ['ESHUTDOWN', 'cannot send after transport endpoint shutdown'],
  102: ['ETOOMANYREFS', 'too many references'],
  103: ['ETIMEDOUT', 'connection timed out'],
  104: ['ECONNREFUSED', 'connection refused'],
  105: ['EHOSTDOWN', 'host is down'],
  106: ['EHOSTUNREACH', 'host is unreachable'],
  107: ['EALREADY', 'operation already in progress'],
  108: ['EINPROGRESS', 'operation now in progress'],
  110: ['ETIMEDOUT', 'connection timed out'],
  111: ['ECONNREFUSED', 'connection refused'],
  112: ['EHOSTDOWN', 'host is down'],
  113: ['EHOSTUNREACH', 'host is unreachable'],
  114: ['EALREADY', 'operation already in progress'],
  115: ['EINPROGRESS', 'operation now in progress'],
  122: ['EDQUOT', 'disk quota exceeded'],
  123: ['ENOMEDIUM', 'no medium found'],
  124: ['EMEDIUMTYPE', 'wrong medium type'],
  125: ['ECANCELED', 'operation canceled'],
  126: ['ENOKEY', 'required key not available'],
  127: ['EKEYEXPIRED', 'key has expired'],
  128: ['EKEYREVOKED', 'key has been revoked'],
  129: ['EKEYREJECTED', 'key was rejected by service'],
  130: ['EOWNERDEAD', 'owner died'],
  131: ['ENOTRECOVERABLE', 'state not recoverable'],
  4094: ['UNKNOWN', 'unknown error'],
  4095: ['EOF', 'end of file'],
}).map(([k, v]) => [-Number(k), /** @type {[string,string]} */ (v)]));

/** @param {number} err */
function validateErrno(err) {
  validateNumber(err, 'err');
  if (err >= 0 || !Number.isSafeInteger(err)) {
    throw ERR_OUT_OF_RANGE('err', 'a negative integer', err);
  }
}

/**
 * Returns the name for a libuv errno (negative integer).
 * @param {number} err
 * @returns {string}
 */
export function getSystemErrorName(err) {
  validateErrno(err);
  return systemErrorMap.get(err)?.[0] ?? `Unknown system error ${err}`;
}

/**
 * Returns the message for a libuv errno (negative integer).
 * @param {number} err
 * @returns {string}
 */
export function getSystemErrorMessage(err) {
  validateErrno(err);
  return systemErrorMap.get(err)?.[1] ?? `Unknown system error ${err}`;
}

/**
 * Returns a Map of libuv errno numbers to [name, message] pairs.
 * @returns {Map<number, [string, string]>}
 */
export function getSystemErrorMap() {
  return new Map(systemErrorMap);
}

// ---------------------------------------------------------------------------
// parseEnv
// ---------------------------------------------------------------------------

const envKeyRegex = /^[a-zA-Z_][a-zA-Z_0-9]*$/;

/**
 * Parses the content of a .env file into a plain object. Supports comments,
 * blank lines, `export KEY=VALUE`, and single/double quoted values (with
 * escapes in double quotes). No variable expansion.
 * @param {string} content
 * @returns {Record<string, string>}
 * @throws {TypeError} ERR_INVALID_ARG_TYPE
 * @throws {Error} On malformed lines/keys.
 */
export function parseEnv(content) {
  validateString(content, 'content');
  /** @type {Record<string, string>} */
  const result = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    let body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf('=');
    if (eq === -1) throw new Error(`Invalid line: ${line}`);
    const key = body.slice(0, eq).trim();
    if (!envKeyRegex.test(key)) throw new Error(`Invalid key: ${key}`);
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2) {
      const q = value[0];
      if ((q === '"' || q === "'") && value[value.length - 1] === q) {
        const inner = value.slice(1, -1);
        if (q === '"') {
          value = inner.replace(/\\(n|t|r|"|'|\\|\$)/g, (m, c) => {
            switch (c) {
              case 'n': return '\n';
              case 't': return '\t';
              case 'r': return '\r';
              case '$': return '$';
              default: return c;
            }
          });
        } else {
          value = inner;
        }
      }
    }
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

const PARSE_ARGS_OPTIONS = Symbol('parseArgsOptions');

/**
 * @param {any} config
 * @param {string} long
 */
function validateArgConfig(config, long) {
  const ERR = (msg) => E('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', msg);
  if (config == null || typeof config !== 'object' ||
      (config.type !== 'string' && config.type !== 'boolean')) {
    throw ERR(`Unexpected value for option "${long}"`);
  }
  if (config.multiple !== undefined && typeof config.multiple !== 'boolean')
    throw ERR(`Unexpected value for "multiple" of option "${long}"`);
  if (config.short !== undefined && (typeof config.short !== 'string' || config.short.length !== 1))
    throw ERR(`Short option for "${long}" must be a single character`);
  if (config.multiple === true && config.default !== undefined && !Array.isArray(config.default))
    throw ERR(`"default" for multiply-occurring option "${long}" must be an Array`);
}

/**
 * Minimal, spec-compliant subset of node:util parseArgs.
 * @param {{ args?: string[], allowPositionals?: boolean, strict?: boolean,
 *   options?: Record<string, { type: 'string'|'boolean', multiple?: boolean,
 *   short?: string, default?: any }>, tokens?: boolean }} [config]
 * @returns {{ values: Record<string, any>, positionals: string[], tokens?: any[] }}
 */
export function parseArgs(config = {}) {
  if (config == null || typeof config !== 'object')
    throw ERR_INVALID_ARG_TYPE('config', 'object', config);
  const {
    args = (Array.isArray(process.argv) ? process.argv.slice(2) : []),
    allowPositionals = false,
    strict = true,
    options = {},
    tokens: returnTokens = false,
  } = config;

  validateBoolean(strict, 'strict');
  validateBoolean(allowPositionals, 'allowPositionals');
  validateBoolean(returnTokens, 'tokens');

  const optionConfigs = options;
  const shorts = {};
  /** @type {Record<string, any>} */
  const values = {};
  const hasDefault = new Set();
  for (const [long, cfg] of Object.entries(optionConfigs)) {
    validateArgConfig(cfg, long);
    if (cfg.short !== undefined) {
      if (shorts[cfg.short] !== undefined)
        throw E('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Short option "-${cfg.short}" is used by both "--${shorts[cfg.short]}" and "--${long}"`);
      shorts[cfg.short] = long;
    }
    if (cfg.default !== undefined) {
      values[long] = cfg.multiple ? [...cfg.default] : cfg.default;
      hasDefault.add(long);
    }
  }

  /** @type {string[]} */
  const positionals = [];
  /** @type {any[]} */
  const tokens = [];

  /** @param {string} long @param {any} value */
  function setValue(long, value) {
    const cfg = optionConfigs[long];
    if (cfg.multiple) {
      if (!Array.isArray(values[long]) || !hasDefault.has(long)) {
        if (!Array.isArray(values[long])) values[long] = [];
      }
      hasDefault.delete(long);
      values[long].push(value);
    } else {
      values[long] = value;
    }
  }

  const argsArr = [...args];
  let i = 0;
  let terminated = false;
  while (i < argsArr.length) {
    const arg = argsArr[i];
    const index = i;
    if (terminated) {
      positionals.push(arg);
      if (returnTokens) tokens.push({ kind: 'positional', value: arg, index });
      i++; continue;
    }
    if (arg === '--') {
      terminated = true;
      if (returnTokens) tokens.push({ kind: 'terminator', rawName: '--', index });
      i++; continue;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg);
      if (returnTokens) tokens.push({ kind: 'positional', value: arg, index });
      i++; continue;
    }

    if (arg.startsWith('--')) {
      let name = arg.slice(2);
      let inlineValue;
      const eq = name.indexOf('=');
      if (eq !== -1) {
        inlineValue = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      const cfg = optionConfigs[name];
      if (cfg === undefined) {
        if (strict)
          throw E('ERR_PARSE_ARGS_UNKNOWN_OPTION', `Unknown option '--${name}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- ${name}'`);
        if (returnTokens) tokens.push({ kind: 'option', name, rawName: `--${name}`, index, value: inlineValue, inlineValue: inlineValue !== undefined });
        i++; continue;
      }
      if (cfg.type === 'boolean') {
        if (inlineValue !== undefined)
          throw E('ERR_PARSE_ARGS_INVALID_OPTION_VALUE', `Option '--${name}=${inlineValue}' does not take an argument`);
        setValue(name, true);
        if (returnTokens) tokens.push({ kind: 'option', name, rawName: `--${name}`, index, value: true, inlineValue: inlineValue !== undefined });
      } else {
        let value = inlineValue;
        if (value === undefined) {
          if (i + 1 >= argsArr.length || argsArr[i + 1] === '--')
            throw E('ERR_PARSE_ARGS_MISSING_VALUE', `Option '--${name}' argument missing`);
          value = argsArr[++i];
        }
        setValue(name, value);
        if (returnTokens) tokens.push({ kind: 'option', name, rawName: `--${name}`, index, value, inlineValue: inlineValue !== undefined });
      }
      i++; continue;
    }

    // short option
    const letters = arg.slice(1);
    if (letters.length === 1 && shorts[letters] !== undefined) {
      const long = shorts[letters];
      const cfg = optionConfigs[long];
      if (cfg.type === 'boolean') {
        setValue(long, true);
        if (returnTokens) tokens.push({ kind: 'option', name: long, rawName: `-${letters}`, index, value: true, inlineValue: false });
        i++; continue;
      }
      if (i + 1 >= argsArr.length || argsArr[i + 1] === '--')
        throw E('ERR_PARSE_ARGS_MISSING_VALUE', `Option '-${letters}' argument missing`);
      const value = argsArr[++i];
      setValue(long, value);
      if (returnTokens) tokens.push({ kind: 'option', name: long, rawName: `-${letters}`, index, value, inlineValue: false });
      i++; continue;
    }
    if (strict)
      throw E('ERR_PARSE_ARGS_UNKNOWN_OPTION', `Unknown option '${arg}'`);
    i++;
  }

  if (positionals.length > 0 && !allowPositionals && strict) {
    throw E('ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL', `Too many positional arguments provided (got ${positionals.length}, expected 0). To configure positional argument parsing, set "allowPositionals: true"`);
  }

  return { values, positionals, ...(returnTokens ? { tokens } : {}) };
}

// ---------------------------------------------------------------------------
// MIMEType / MIMEParams (WHATWG MIME sniffing, essential subset)
// ---------------------------------------------------------------------------

const mimeTokenRegex = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/;

/**
 * @param {string} value
 */
function unquoteMimeValue(value) {
  value = value.trim();
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    const inner = value.slice(1, -1);
    return inner.replace(/\\(["\\])/g, '$1');
  }
  return value;
}

/**
 * @param {string} value
 */
function quoteMimeValue(value) {
  if (mimeTokenRegex.test(value)) return value;
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

/** WHATWG MIMEParams — a multimap of MIME parameters. */
export class MIMEParams {
  /** @type {Map<string, string>} */
  #params = new Map();

  /** @param {string} [init] */
  constructor(init = undefined) {
    if (init !== undefined) {
      validateString(init, 'init');
      for (const part of init.split(';')) {
        if (part.trim() === '') continue;
        const eq = part.indexOf('=');
        if (eq === -1) throw new TypeError(`Invalid MIME parameter: ${part.trim()}`);
        const name = part.slice(0, eq).trim().toLowerCase();
        if (!mimeTokenRegex.test(name)) throw new TypeError(`Invalid MIME parameter name: ${name}`);
        this.#params.set(name, unquoteMimeValue(part.slice(eq + 1)));
      }
    }
  }

  /** @param {string} name */
  get(name) {
    validateString(name, 'name');
    return this.#params.get(name.toLowerCase());
  }

  /** @param {string} name @param {string} value */
  set(name, value) {
    validateString(name, 'name');
    validateString(value, 'value');
    const lowered = name.toLowerCase();
    if (!mimeTokenRegex.test(lowered)) throw new TypeError(`Invalid MIME parameter name: ${name}`);
    this.#params.set(lowered, value);
  }

  /** @param {string} name */
  has(name) {
    validateString(name, 'name');
    return this.#params.has(name.toLowerCase());
  }

  /** @param {string} name */
  delete(name) {
    validateString(name, 'name');
    return this.#params.delete(name.toLowerCase());
  }

  /** @returns {number} */
  get size() { return this.#params.size; }

  *entries() { yield* this.#params.entries(); }
  *keys() { yield* this.#params.keys(); }
  *values() { yield* this.#params.values(); }
  /** @param {(value: string, name: string, params: MIMEParams) => void} callbackFn */
  forEach(callbackFn, thisArg = undefined) {
    validateFunction(callbackFn, 'callbackFn');
    for (const [k, v] of this.#params) callbackFn.call(thisArg, v, k, this);
  }

  [Symbol.iterator]() { return this.entries(); }

  toString() {
    return [...this.#params.entries()]
      .map(([k, v]) => `${k}=${quoteMimeValue(v)}`).join(';');
  }
}

/** WHATWG MIMEType — e.g. `new MIMEType('text/html; charset=utf-8')`. */
export class MIMEType {
  /** @type {string} */ #type = '';
  /** @type {string} */ #subtype = '';
  /** @type {MIMEParams} */ #parameters;

  /** @param {string} input */
  constructor(input) {
    validateString(input, 'input');
    const parts = input.split(';');
    const typeSubtype = parts[0].trim().toLowerCase().split('/');
    if (typeSubtype.length !== 2 ||
        !mimeTokenRegex.test(typeSubtype[0]) || !mimeTokenRegex.test(typeSubtype[1]) ||
        typeSubtype[0] === '' || typeSubtype[1] === '') {
      throw new TypeError(`Invalid MIME type: ${input}`);
    }
    this.#type = typeSubtype[0];
    this.#subtype = typeSubtype[1];
    this.#parameters = new MIMEParams(parts.slice(1).join(';'));
  }

  get type() { return this.#type; }
  /** @param {string} v */
  set type(v) {
    validateString(v, 'type');
    const lowered = v.toLowerCase();
    if (!mimeTokenRegex.test(lowered)) throw new TypeError(`Invalid MIME type: ${v}`);
    this.#type = lowered;
  }

  get subtype() { return this.#subtype; }
  /** @param {string} v */
  set subtype(v) {
    validateString(v, 'subtype');
    const lowered = v.toLowerCase();
    if (!mimeTokenRegex.test(lowered)) throw new TypeError(`Invalid MIME subtype: ${v}`);
    this.#subtype = lowered;
  }

  /** @returns {MIMEParams} */
  get parameters() { return this.#parameters; }

  get essence() { return `${this.#type}/${this.#subtype}`; }

  toString() {
    const params = this.#parameters.toString();
    return `${this.#type}/${this.#subtype}${params === '' ? '' : `;${params}`}`;
  }
}

// ---------------------------------------------------------------------------
// TextEncoder / TextDecoder (native web APIs)
// ---------------------------------------------------------------------------

/** @type {typeof globalThis.TextEncoder} */
export const TextEncoder = globalThis.TextEncoder;
/** @type {typeof globalThis.TextDecoder} */
export const TextDecoder = globalThis.TextDecoder;

// ---------------------------------------------------------------------------
// Abort helpers
// ---------------------------------------------------------------------------

/**
 * Returns an AbortSignal that stays linked to `signal` when transferred
 * (e.g. via structuredClone with transfer). Native AbortSignals are already
 * structured-clone transferable in browsers, so this validates and returns
 * the signal itself.
 * @param {AbortSignal} signal
 * @returns {AbortSignal}
 */
export function transferableAbortSignal(signal) {
  if (!(signal instanceof AbortSignal)) {
    throw ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
  }
  return signal;
}

/**
 * Creates an AbortController plus a signal linked to it — the pair can be
 * passed across structuredClone/transfer boundaries.
 * @returns {{ controller: AbortController, signal: AbortSignal }}
 */
export function transferableAbortController() {
  const controller = new AbortController();
  const linked = new AbortController();
  controller.signal.addEventListener('abort', () => {
    linked.abort(controller.signal.reason);
  }, { once: true });
  return { controller, signal: linked.signal };
}

/**
 * Listens to `signal` and emits 'aborted' on `resource` (an EventEmitter-like
 * with .emit) when the signal aborts — or immediately if already aborted.
 * @param {AbortSignal} signal
 * @param {{ emit?: (name: string, ...args: any[]) => void }} resource
 */
export function aborted(signal, resource) {
  if (!(signal instanceof AbortSignal)) {
    throw ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
  }
  const emit = () => {
    if (resource && typeof resource.emit === 'function') resource.emit('aborted', signal);
  };
  if (signal.aborted) queueMicrotask(emit);
  else signal.addEventListener('abort', emit, { once: true });
}

// ---------------------------------------------------------------------------
// legacy (deprecated) type checks
// ---------------------------------------------------------------------------

const _deprecated = (name, msg, code, fn) => deprecate(fn, `\`util.${name}\` is deprecated. ${msg}`, code);

export const isBoolean = _deprecated('isBoolean', 'Please use `typeof x === "boolean"` instead.', 'DEP0059', (arg) => typeof arg === 'boolean');
export const isNull = _deprecated('isNull', 'Please use `x === null` instead.', 'DEP0055', (arg) => arg === null);
export const isNullOrUndefined = _deprecated('isNullOrUndefined', 'Please use `x == null` instead.', 'DEP0056', (arg) => arg == null);
export const isNumber = _deprecated('isNumber', 'Please use `typeof x === "number"` instead.', 'DEP0057', (arg) => typeof arg === 'number');
export const isString = _deprecated('isString', 'Please use `typeof x === "string"` instead.', 'DEP0058', (arg) => typeof arg === 'string');
export const isSymbol = _deprecated('isSymbol', 'Please use `typeof x === "symbol"` instead.', 'DEP0059', (arg) => typeof arg === 'symbol');
export const isUndefined = _deprecated('isUndefined', 'Please use `x === undefined` instead.', 'DEP0060', (arg) => arg === void 0);
export const isRegExp = _deprecated('isRegExp', 'Please use `util.types.isRegExp()` instead.', 'DEP0045', (re) => types.isRegExp(re));
export const isObject = _deprecated('isObject', 'Please use `x !== null && typeof x === "object"` instead.', 'DEP0058', (arg) => typeof arg === 'object' && arg !== null);
export const isDate = _deprecated('isDate', 'Please use `util.types.isDate()` instead.', 'DEP0042', (d) => types.isDate(d));
export const isError = _deprecated('isError', 'Please use `util.types.isNativeError()` or `instanceof Error` instead.', 'DEP0043', (e) => types.isNativeError(e));
export const isFunction = _deprecated('isFunction', 'Please use `typeof x === "function"` instead.', 'DEP0059', (arg) => typeof arg === 'function');
export const isPrimitive = _deprecated('isPrimitive', 'Please use `typeof x !== "object" && typeof x !== "function" || x === null` instead.', 'DEP0046', (arg) => arg === null || (typeof arg !== 'object' && typeof arg !== 'function'));
export const isArray = _deprecated('isArray', 'Please use `Array.isArray()` instead.', 'DEP0044', (ar) => Array.isArray(ar));
export const isBuffer = _deprecated('isBuffer', 'Please use `Buffer.isBuffer()` instead.', 'DEP0041', (b) => Buffer.isBuffer(b));

/**
 * @deprecated since v6.0.0 — use `Object.assign()`.
 * @template T, S
 * @param {T} origin
 * @param {S} add
 * @returns {T & S}
 */
export const _extend = _deprecated('_extend', 'Please use `Object.assign()` instead.', 'DEP0060',
  function _extend(origin, add) {
    if (add === null || typeof add !== 'object') return origin;
    const keys = Object.keys(add);
    let i = keys.length;
    while (i--) origin[keys[i]] = add[keys[i]];
    return origin;
  });

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

/** @param {number} n */
function pad2(n) { return n < 10 ? '0' + n.toString(10) : n.toString(10); }

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '26 Feb 16:19:34' */
function timestamp() {
  const d = new Date();
  const time = [pad2(d.getHours()), pad2(d.getMinutes()), pad2(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}

/**
 * Thin console.log wrapper prepending a timestamp. (Legacy node:util.log.)
 * @param {...any} args
 */
export function log(...args) {
  console.log(`%s - %s`, timestamp(), format(...args));
}

// ---------------------------------------------------------------------------
// default export
// ---------------------------------------------------------------------------

export default {
  format, formatWithOptions, inspect, styleText, stripVTControlCharacters,
  deprecate, debuglog, debug, inherits, promisify, callbackify,
  isDeepStrictEqual, toUSVString, getSystemErrorName, getSystemErrorMessage,
  getSystemErrorMap, types, parseEnv, parseArgs, MIMEType, MIMEParams,
  TextEncoder, TextDecoder, transferableAbortSignal, transferableAbortController,
  aborted, log, _extend,
  isArray, isBoolean, isBuffer, isNull, isNullOrUndefined, isNumber, isString,
  isSymbol, isUndefined, isRegExp, isObject, isDate, isError, isFunction, isPrimitive,
};

// --- Usage ---
// import { promisify, inspect, styleText } from 'util-web';
//
// const stat = promisify(fs.stat);            // callback → promise
// await stat('./file.txt');
//
// inspect({ a: [1, 2], b: new Map([['k', 'v']]) }, { colors: true, depth: 5 });
// // → '{ a: [ 1, 2 ], b: Map(1) { 'k' => 'v' } }' (with ANSI colors)
//
// Edge case — error-first callback that throws synchronously:
// promisify(() => { throw new Error('boom'); })().catch((e) => console.log(e.code)); // undefined, message 'boom'
// // callbackify wraps falsy rejections:
// const cb = callbackify(async () => null);
// cb((err) => console.log(err.message)); // 'Promise was rejected with a falsy value'
