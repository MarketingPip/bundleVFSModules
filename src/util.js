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
 * Creates an Error of the given class carrying a Node-style `code` property.
 * @param {string} code
 * @param {string} message
 * @param {new (msg: string) => Error} [Base]
 * @returns {Error & { code: string }}
 */
function E(code, message, Base = Error) {
  const err = new Base(message);
  err.code = code;
  return err;
}

const kInvalidArgTypes = [
  'string', 'function', 'number', 'object',
  'Function', 'Object', 'boolean', 'bigint', 'symbol',
];
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;

/**
 * Matches node's determineSpecificType (lib/internal/errors.js).
 * @param {unknown} value
 */
function determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  switch (type) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) {
        return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      } else if (value !== value) {
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
      return `${inspect(value, { depth: -1 })}`;
    case 'string': {
      let s = value;
      if (s.length > 28) s = `${s.slice(0, 25)}...`;
      if (!s.includes("'")) {
        return `type string ('${s}')`;
      }
      return `type string (${JSON.stringify(s)})`;
    }
    default: {
      let v = inspect(value, { colors: false });
      if (v.length > 28) v = `${v.slice(0, 25)}...`;
      return `type ${type} (${v})`;
    }
  }
}

function formatList(list, conjunction) {
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} ${conjunction} ${list[list.length - 1]}`;
}

/**
 * Matches node's ERR_INVALID_ARG_TYPE message layout exactly, and returns a
 * TypeError like node does.
 * @param {string} name
 * @param {string|string[]} expected
 * @param {unknown} actual
 */
const ERR_INVALID_ARG_TYPE = (name, expected, actual) => {
  const expectedArr = Array.isArray(expected) ? expected : [expected];
  let msg = 'The ';
  if (name.endsWith(' argument')) {
    // For cases like 'first argument' / 'last argument'.
    msg += `${name} `;
  } else {
    const type = name.includes('.') ? 'property' : 'argument';
    msg += `"${name}" ${type} `;
  }
  msg += 'must be ';

  const types = [];
  const instances = [];
  const other = [];
  for (const value of expectedArr) {
    if (kInvalidArgTypes.includes(value)) {
      types.push(value.toLowerCase());
    } else if (classRegExp.test(value)) {
      instances.push(value);
    } else {
      other.push(value);
    }
  }

  // Special handle `object` in case other instances are allowed.
  if (instances.length > 0) {
    const pos = types.indexOf('object');
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push('Object');
    }
  }

  if (types.length > 0) {
    msg += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
    if (instances.length > 0 || other.length > 0) msg += ' or ';
  }
  if (instances.length > 0) {
    msg += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0) msg += ' or ';
  }
  if (other.length > 0) {
    if (other.length > 1) {
      msg += `one of ${formatList(other, 'or')}`;
    } else {
      if (other[0].toLowerCase() !== other[0]) msg += 'an ';
      msg += `${other[0]}`;
    }
  }

  msg += `. Received ${determineSpecificType(actual)}`;
  return E('ERR_INVALID_ARG_TYPE', msg, TypeError);
};

/**
 * Matches node's ERR_INVALID_ARG_VALUE (a TypeError).
 */
const ERR_INVALID_ARG_VALUE = (name, value, reason = 'is invalid') => {
  let inspected;
  try {
    inspected = inspect(value);
  } catch {
    try { inspected = String(value); } catch { inspected = '?'; }
  }
  if (inspected.length > 128) inspected = `${inspected.slice(0, 128)}...`;
  const type = name.includes('.') ? 'property' : 'argument';
  return E('ERR_INVALID_ARG_VALUE', `The ${type} '${name}' ${reason}. Received ${inspected}`, TypeError);
};

/**
 * Matches node's ERR_OUT_OF_RANGE (a RangeError).
 */
const ERR_OUT_OF_RANGE = (name, range, input) => {
  let received;
  if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
    received = addNumericSeparator(String(input));
  } else if (typeof input === 'bigint') {
    received = String(input);
    if (input > 2n ** 32n || input < -(2n ** 32n)) {
      received = addNumericSeparator(received);
    }
    received += 'n';
  } else {
    try {
      received = inspect(input);
    } catch {
      try { received = String(input); } catch { received = '?'; }
    }
  }
  return E('ERR_OUT_OF_RANGE',
    `The value of "${name}" is out of range. It must be ${range}. Received ${received}`,
    RangeError);
};

// validators
const validateString = (v, n) => { if (typeof v !== 'string') throw ERR_INVALID_ARG_TYPE(n, 'string', v); };
const validateNumber = (v, n) => { if (typeof v !== 'number') throw ERR_INVALID_ARG_TYPE(n, 'number', v); };
const validateBoolean = (v, n) => { if (typeof v !== 'boolean') throw ERR_INVALID_ARG_TYPE(n, 'boolean', v); };
const validateFunction = (v, n) => { if (typeof v !== 'function') throw ERR_INVALID_ARG_TYPE(n, 'function', v); };
const validateObject = (v, n) => { if (v === null || typeof v !== 'object') throw ERR_INVALID_ARG_TYPE(n, 'object', v); };
const validateInteger = (v, n, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => {
  if (typeof v !== 'number') throw ERR_INVALID_ARG_TYPE(n, 'number', v);
  if (!Number.isInteger(v)) throw ERR_OUT_OF_RANGE(n, 'an integer', v);
  if (v < min || v > max) throw ERR_OUT_OF_RANGE(n, `>= ${min} && <= ${max}`, v);
};
const validateOneOf = (v, n, values) => {
  if (!values.includes(v)) {
    const allowed = values.map((x) => typeof x === 'string' ? `'${x}'` : String(x)).join(', ');
    throw ERR_INVALID_ARG_VALUE(n, v, `must be one of: ${allowed}`);
  }
};

// Primordial snapshots: capture built-in methods at module load so later
// monkey-patching of globals (e.g. Object.keys in tests) cannot break us.
const PrimordialObjectKeys = Object.keys;
const PrimordialObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
const PrimordialObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const PrimordialObjectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const PrimordialObjectGetPrototypeOf = Object.getPrototypeOf;
const PrimordialObjectDefineProperty = Object.defineProperty;
const PrimordialObjectDefineProperties = Object.defineProperties;
const PrimordialObjectHasOwn = Object.hasOwn || ((o, p) => Object.prototype.hasOwnProperty.call(o, p));
const PrimordialReflectOwnKeys = Reflect.ownKeys;
const PrimordialArrayIsArray = Array.isArray;
const PrimordialArrayPrototypePush = Function.prototype.call.bind(Array.prototype.push);
const PrimordialFunctionPrototypeToString = Function.prototype.call.bind(Function.prototype.toString);
const PrimordialObjectPrototypeToString = (v) => Object.prototype.toString.call(v);
const PrimordialObjectPrototypeHasOwnProperty = (o, p) => Object.prototype.hasOwnProperty.call(o, p);
const PrimordialObjectCreate = Object.create;
const PrimordialObjectSetPrototypeOf = Object.setPrototypeOf;
const PrimordialFunctionPrototypeApply = Function.prototype.call.bind(Function.prototype.apply);
const PrimordialReflectConstruct = Reflect.construct;
const PrimordialSet = Set;
const PrimordialArrayPrototypeMap = Function.prototype.call.bind(Array.prototype.map);
const PrimordialObjectGetOwnPropertySymbols = Object.getOwnPropertySymbols;
const PrimordialArrayPrototypePop = Function.prototype.call.bind(Array.prototype.pop);
const PrimordialReflectApply = Reflect.apply;

const objectToString = PrimordialObjectPrototypeToString;
const isObjectLike = (v) => v !== null && typeof v === 'object';
const hasOwn = PrimordialObjectPrototypeHasOwnProperty;

// ---------------------------------------------------------------------------
// types — full util.types predicate set (browser-safe)
// ---------------------------------------------------------------------------

const GF = PrimordialObjectGetPrototypeOf(function* () {});
const AF = PrimordialObjectGetPrototypeOf(async function () {});
const AGF = PrimordialObjectGetPrototypeOf(async function* () {});
const F = PrimordialObjectGetPrototypeOf(function () {});

/**
 * @param {unknown} v
 * @returns {v is (...args: any[]) => any}
 */
function isFunctionType(v) { return typeof v === 'function'; }

/**
 * Brand check for a concrete TypedArray constructor that survives
 * Symbol.toStringTag spoofing (walks the prototype chain instead of reading
 * the tag), mirroring node's TypedArrayPrototypeGetSymbolToStringTag.
 * @param {unknown} v
 * @param {Function|undefined} Ctor
 */
function isTypedArrayOf(v, Ctor) {
  if (typeof Ctor !== 'function' || v === null || typeof v !== 'object') return false;
  if (!ArrayBuffer.isView(v) || v instanceof DataView) return false;
  let proto = v;
  while (proto !== null) {
    if (proto === Ctor.prototype) return true;
    proto = PrimordialObjectGetPrototypeOf(proto);
  }
  return false;
}

/** @param {unknown} v */
function isAsyncGeneratorFunctionValue(v) {
  if (!isFunctionType(v)) return false;
  if (PrimordialObjectGetPrototypeOf(v) === AGF) return true;
  return /^\s*async\s+function\s*\*/.test(PrimordialFunctionPrototypeToString(v));
}

let types = {
  isArrayBuffer: (v) => objectToString(v) === '[object ArrayBuffer]',
  isSharedArrayBuffer: (v) => typeof SharedArrayBuffer !== 'undefined' && objectToString(v) === '[object SharedArrayBuffer]',
  isAnyArrayBuffer: (v) => types.isArrayBuffer(v) || types.isSharedArrayBuffer(v),
  isArrayBufferView: (v) => ArrayBuffer.isView(v),
  isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView) &&
    v[Symbol.toStringTag] !== undefined,
  isUint8Array: (v) => isTypedArrayOf(v, typeof Uint8Array !== 'undefined' ? Uint8Array : undefined),
  isUint8ClampedArray: (v) => isTypedArrayOf(v, typeof Uint8ClampedArray !== 'undefined' ? Uint8ClampedArray : undefined),
  isUint16Array: (v) => isTypedArrayOf(v, typeof Uint16Array !== 'undefined' ? Uint16Array : undefined),
  isUint32Array: (v) => isTypedArrayOf(v, typeof Uint32Array !== 'undefined' ? Uint32Array : undefined),
  isInt8Array: (v) => isTypedArrayOf(v, typeof Int8Array !== 'undefined' ? Int8Array : undefined),
  isInt16Array: (v) => isTypedArrayOf(v, typeof Int16Array !== 'undefined' ? Int16Array : undefined),
  isInt32Array: (v) => isTypedArrayOf(v, typeof Int32Array !== 'undefined' ? Int32Array : undefined),
  isFloat16Array: (v) => isTypedArrayOf(v, typeof Float16Array !== 'undefined' ? Float16Array : undefined),
  isFloat32Array: (v) => isTypedArrayOf(v, typeof Float32Array !== 'undefined' ? Float32Array : undefined),
  isFloat64Array: (v) => isTypedArrayOf(v, typeof Float64Array !== 'undefined' ? Float64Array : undefined),
  isBigInt64Array: (v) => isTypedArrayOf(v, typeof BigInt64Array !== 'undefined' ? BigInt64Array : undefined),
  isBigUint64Array: (v) => isTypedArrayOf(v, typeof BigUint64Array !== 'undefined' ? BigUint64Array : undefined),
  isDataView: (v) => ArrayBuffer.isView(v) && v instanceof DataView,
  isMap: (v) => objectToString(v) === '[object Map]',
  isSet: (v) => objectToString(v) === '[object Set]',
  isWeakMap: (v) => objectToString(v) === '[object WeakMap]',
  isWeakSet: (v) => objectToString(v) === '[object WeakSet]',
  isMapIterator: (v) => isObjectLike(v) && objectToString(v) === '[object Map Iterator]',
  isSetIterator: (v) => isObjectLike(v) && objectToString(v) === '[object Set Iterator]',
  isDate: (v) => objectToString(v) === '[object Date]',
  isRegExp: (v) => objectToString(v) === '[object RegExp]',
  isPromise: (v) => objectToString(v) === '[object Promise]',
  // Undetectable in pure JS (no reflection API for proxies); the native
  // bridge below overrides these when running on Node.
  isProxy: () => false,
  // No V8 external values outside Node; overridden by the native bridge.
  isExternal: () => false,
  // Requires node:crypto internals; overridden by the native bridge on Node.
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
  isAsyncFunction(v) {
    if (!isFunctionType(v)) return false;
    const proto = PrimordialObjectGetPrototypeOf(v);
    if (proto === AF) return true;
    return v[Symbol.toStringTag] === 'AsyncFunction';
  },
  isGeneratorFunction(v) {
    if (!isFunctionType(v)) return false;
    // Fall back to source text when the prototype was tampered with.
    if (PrimordialObjectGetPrototypeOf(v) === GF) return true;
    return /^\s*(async\s+)?function\s*\*/.test(PrimordialFunctionPrototypeToString(v));
  },
  isGeneratorObject(v) {
    if (v === null || typeof v !== 'object') return false;
    return objectToString(v) === '[object Generator]';
  },
  isArgumentsObject(v) { return objectToString(v) === '[object Arguments]'; },
  isNativeError(v) {
    // Pure-JS fallback: real native errors (including cross-realm ones) carry
    // the '[object Error]' tag; plain objects with a borrowed Error.prototype
    // do not. The native bridge below gives exact semantics on Node.
    return isObjectLike(v) && objectToString(v) === '[object Error]';
  },
  isModuleNamespaceObject(v) { return objectToString(v) === '[object Module]'; },
};

/**
 * Boxed primitive check (native util.types lacks isBoxedPrimitive).
 * @param {unknown} v
 */
function isBoxedPrimitiveValue(v) {
  return types.isNumberObject(v) || types.isStringObject(v) || types.isBooleanObject(v) ||
         types.isSymbolObject(v) || types.isBigIntObject(v);
}

export { types };

// Native bridge (Node only): where the environment really is Node, delegate
// the predicates that pure JS cannot implement exactly (isProxy, isExternal,
// isNativeError, isKeyObject, cross-realm typed arrays, ...) to the genuine
// builtin. Browsers keep the dependency-free fallbacks above.
try {
  const getBuiltinModule = typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function'
    ? process.getBuiltinModule.bind(process)
    : undefined;
  const nativeUtil = getBuiltinModule?.('util');
  const nativeTypes = nativeUtil?.types;
  if (nativeTypes && typeof nativeTypes.isProxy === 'function') {
    // Use the genuine native types object directly. This gives exact
    // semantics for isProxy/isExternal/isNativeError/isKeyObject and,
    // crucially, makes require('util/types') === require('util').types.
    // (Our isBoxedPrimitive helper above keeps working via the predicates.)
    types = nativeTypes;
  }
  // Keep a handle for proxy-aware inspect.
  var nativeInspectBridge = typeof nativeUtil?.inspect === 'function' ? nativeUtil.inspect : undefined;
  var nativeTypesBridge = typeof nativeTypes?.isProxy === 'function' ? nativeTypes : undefined;
} catch {
  var nativeInspectBridge = undefined;
  var nativeTypesBridge = undefined;
}

/**
 * Mirror Node's internal/errors isStackOverflowError: deliberately overflow
 * the (fresh) stack once at module load to capture the engine's exact
 * stack-overflow name/message, then compare by name+message (realm-safe,
 * unlike instanceof). A user-thrown `RangeError('boom')` does not match.
 */
const { maxStackErrorName, maxStackErrorMessage } = (() => {
  try {
    const overflowStack = () => overflowStack();
    overflowStack();
  } catch (e) {
    return { maxStackErrorName: e.name, maxStackErrorMessage: e.message };
  }
  return { maxStackErrorName: '', maxStackErrorMessage: '' };
})();
/**
 * @param {unknown} err
 */
function isStackOverflowError(err) {
  try {
    return !!err && err.name === maxStackErrorName &&
      err.message === maxStackErrorMessage;
  } catch {
    // If name/message getters throw, it's not a stack overflow error.
    return false;
  }
}

/**
 * Re-indents the continuation lines of a native bridge result to the current
 * absolute indentation level. The bridge formats with indentation relative
 * to 0; when the result is embedded at a deeper level (e.g. as a Map key),
 * the continuation lines must be shifted. Only needed for compact===true,
 * where reduceToSingleString does not re-indent (other modes re-indent at
 * join time).
 * @param {ReturnType<typeof makeCtx>} ctx
 * @param {string} s
 */
function reindentBridgeResult(ctx, s) {
  if (ctx.options.compact !== true) return s;
  const lvl = ctx.indentationLvl || 0;
  if (lvl === 0 || !s.includes('\n')) return s;
  const pad = ' '.repeat(lvl);
  return s.replace(/\n/g, `\n${pad}`);
}

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

const vtRegex = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*' +
  '(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*' +
  '|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?' +
  '(?:\\u0007|\\u001B\\u005C|\\u009C))' +
  '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?' +
  '[\\dA-PR-TZcf-nq-uy=><~]))', 'g',
);

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
  gray: [90, 39],
  redBright: [91, 39], greenBright: [92, 39], yellowBright: [93, 39],
  blueBright: [94, 39], magentaBright: [95, 39], cyanBright: [96, 39],
  whiteBright: [97, 39],
  bgGray: [100, 49],
  bgRedBright: [101, 49], bgGreenBright: [102, 49], bgYellowBright: [103, 49],
  bgBlueBright: [104, 49], bgMagentaBright: [105, 49], bgCyanBright: [106, 49],
  bgWhiteBright: [107, 49],
};

// Color aliases (Node v24): defined as non-enumerable getter/setter pairs
// so they don't show up in Object.keys(inspect.colors).
function defineColorAlias(target, alias) {
  Object.defineProperty(inspectColors, alias, {
    get() { return this[target]; },
    set(value) { this[target] = value; },
    configurable: true,
    enumerable: false,
  });
}
defineColorAlias('gray', 'grey');
defineColorAlias('gray', 'blackBright');
defineColorAlias('bgGray', 'bgGrey');
defineColorAlias('bgGray', 'bgBlackBright');
defineColorAlias('dim', 'faint');
defineColorAlias('strikethrough', 'crossedout');
defineColorAlias('strikethrough', 'strikeThrough');
defineColorAlias('strikethrough', 'crossedOut');
defineColorAlias('hidden', 'conceal');
defineColorAlias('inverse', 'swapColors');
defineColorAlias('inverse', 'swapcolors');
defineColorAlias('doubleunderline', 'doubleUnderline');

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
    // Mirror Node: use double-quotes if the string has a single-quote but no
    // double-quote; use backticks if it has both quotes but no backtick and
    // no '${' (which would need escaping in a template literal); otherwise
    // use single-quotes.
    if (str.includes("'") && !str.includes('"')) quote = '"';
    else if (str.includes("'") && str.includes('"') && !str.includes('`') &&
             !str.includes('${')) quote = '`';
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
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      result += `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`;
    } else if (code >= 0xD800 && code <= 0xDFFF) {
      // Surrogate: if it's a valid pair, output both as-is; otherwise escape
      // the lone surrogate as \uHHHH (Node uses lowercase hex).
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
        const next = str.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          result += str[i] + str[i + 1];
          i++;
          continue;
        }
      }
      result += `\\u${code.toString(16).padStart(4, '0')}`;
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
    // Maps a circularly-referenced value to its `<ref *N>` / `[Circular *N]`
    // number, assigned in circular-encounter order like Node's ctx.circular.
    circularNums: /** @type {Map<any, number>} */ (new Map()),
    // Nesting-depth bookkeeping for the compact single-line decision
    // (Node's ctx.currentDepth): currentDepth is the deepest composite level
    // reached; depthLevel is the current composite nesting level.
    currentDepth: 0,
    depthLevel: 0,
    stylize: options.stylize
      ? options.stylize
      : options.colors
        ? stylizeWithColor
        : stylizeNoColor,
    options,
    level: 0,
  };
}

// Node's class-detection helpers (lib/internal/util/inspect.js): a function
// whose source looks like a class definition is inspected as [class ...].
const nodeClassRegExp = /^(\s+[^(]*?)\s*{/;
const nodeStripCommentsRegExp = /(\/\/.*?\n)|(\/\*(.|\n)*?\*\/)/g;

/**
 * Mirror of Node's getPrefix: `[<fallback><size>: null prototype] ` for null
 * prototypes, otherwise `<constructor><size> ` with an optional `[<tag>] `
 * suffix (e.g. `Settings(2) [Set] `).
 */
function getPrefix(constructor, tag, fallback, size = '') {
  if (constructor === null) {
    if (tag !== '' && fallback !== tag) {
      return `[${fallback}${size}: null prototype] [${tag}] `;
    }
    return `[${fallback}${size}: null prototype] `;
  }

  let result = `${constructor}${size} `;
  if (tag !== '') {
    const position = constructor.indexOf(tag);
    if (position === -1) {
      result += `[${tag}] `;
    } else {
      const endPos = position + tag.length;
      if (endPos !== constructor.length &&
          constructor[endPos] === constructor[endPos].toLowerCase()) {
        result += `[${tag}] `;
      }
    }
  }
  return result;
}

/**
 * Node's filtered Symbol.toStringTag: only kept when it wouldn't already
 * print as a regular property.
 */
function getFilteredTag(ctx, value) {
  let tag = '';
  try { tag = value[Symbol.toStringTag]; } catch { /* ignore */ }
  if (typeof tag !== 'string' ||
      (tag !== '' &&
       (ctx.options.showHidden
         ? Object.prototype.hasOwnProperty.call(value, Symbol.toStringTag)
         : Object.prototype.propertyIsEnumerable.call(value, Symbol.toStringTag)))) {
    tag = '';
  }
  return tag;
}

/**
 * Mirror of Node's getConstructorName: returns the constructor name, with
 * ` <prototype>` suffix when the prototype chain has no determinable
 * constructor (e.g. `Object <[Function (null prototype) (anonymous)]>`).
 * Used for the object prefix when the prototype is non-standard.
 */
function getConstructorNameWithProto(ctx, value, recurseTimes, seen = new Set(), nodeLevel = null) {
  if (seen.has(value)) return null;
  seen.add(value);

  // Convert polyfill's decreasing recurseTimes to Node's increasing level.
  // Polyfill: recurseTimes = depth, depth-1, ... (remaining).
  // Node: level = 0, 1, 2, ... (current depth).
  if (nodeLevel === null) {
    const d = ctx.options.depth;
    nodeLevel = (d === null || d === undefined ? 2 : d) - recurseTimes;
  }

  let firstProto;
  const tmp = value;
  let obj = value;
  while (obj !== null) {
    const desc = safeGetOwnPropertyDescriptor(obj, 'constructor');
    if (desc !== undefined &&
        typeof desc.value === 'function' &&
        desc.value.name !== '' &&
        safeInstanceof(tmp, desc.value)) {
      return String(desc.value.name);
    }
    obj = Object.getPrototypeOf(obj);
    if (firstProto === undefined) {
      firstProto = obj;
    }
  }

  if (firstProto === null || firstProto === undefined) {
    return null;
  }

  let res = intrinsicConstructorName(tmp);
  // V8 tracks the constructor via the object's hidden class even when the
  // prototype was replaced (e.g. `StorageObject.prototype = {__proto__: null}`).
  // The native bridge can reveal it.
  if (res === 'Object' && typeof nativeInspectBridge === 'function') {
    try {
      const nativeOut = nativeInspectBridge(tmp, { depth: -1, colors: false });
      const m = /^([A-Za-z_$][\w$]*)(?:\s|<)/.exec(nativeOut);
      if (m && m[1] !== 'Object') {
        res = m[1];
      }
    } catch { /* ignore */ }
  }
  // Node: if depth is exceeded, show `<Complex prototype>` instead of recursing.
  // Node's check: `if (recurseTimes > ctx.depth)` where recurseTimes is the
  // increasing level (0, 1, 2...).
  const depth = ctx.options.depth;
  if (depth !== null && depth !== undefined && nodeLevel > depth) {
    return `${res} <Complex prototype>`;
  }
  const protoConstr = getConstructorNameWithProto(ctx, firstProto, recurseTimes, seen, nodeLevel + 1);

  if (protoConstr === null) {
    // Prototype has no determinable constructor; inspect it directly
    // (Node uses depth -1 and disables custom inspect).
    let inspected;
    try {
      inspected = inspect(firstProto, {
        ...ctx.options,
        customInspect: false,
        depth: -1,
      });
    } catch {
      inspected = '[Object]';
    }
    return `${res} <${inspected}>`;
  }

  return `${res} <${protoConstr}>`;
}

/**
 * Approximate Node's internalGetConstructorName (C++ binding): the intrinsic
 * type name, ignoring the prototype chain.
 */
function intrinsicConstructorName(value) {
  if (types.isPromise(value)) return 'Promise';
  if (types.isWeakSet(value)) return 'WeakSet';
  if (types.isWeakMap(value)) return 'WeakMap';
  if (types.isDate(value)) return 'Date';
  if (types.isRegExp(value)) return 'RegExp';
  if (types.isMap(value)) return 'Map';
  if (types.isSet(value)) return 'Set';
  if (types.isDataView(value)) return 'DataView';
  if (types.isArrayBuffer(value)) return 'ArrayBuffer';
  if (types.isSharedArrayBuffer(value)) return 'SharedArrayBuffer';
  if (Array.isArray(value)) return 'Array';
  try {
    const s = Object.prototype.toString.call(value);
    const m = /^\[object ([^\]]+)\]$/.exec(s);
    if (m && m[1]) return m[1];
  } catch { /* ignore */ }
  return 'Object';
}

/**
 * Mirror of Node's getCtxStyle: builds the `[<Name>: null prototype] `
 * prefix for null prototypes (using the intrinsic name), otherwise the
 * regular getPrefix.
 */
function getCtxStyle(value, constructor, tag) {
  let fallback = '';
  if (constructor === null) {
    fallback = intrinsicConstructorName(value);
    if (fallback === tag) {
      fallback = 'Object';
    }
  }
  return getPrefix(constructor, tag, fallback);
}

/**
 * Mirror of Node's getClassBase: `[class [<name>|(anonymous)] [[<ctor>]]
 * [[<tag>]] [extends <super>|extends [null prototype]]]`.
 */
function getClassBase(value, constructor, tag) {
  const hasName = Object.prototype.hasOwnProperty.call(value, 'name');
  const name = (hasName && value.name) || '(anonymous)';
  let base = `class ${name}`;
  if (constructor !== 'Function' && constructor !== null) {
    base += ` [${constructor}]`;
  }
  if (tag !== '' && constructor !== tag) {
    base += ` [${tag}]`;
  }
  if (constructor !== null) {
    let superName = '';
    try { superName = Object.getPrototypeOf(value).name; } catch { /* ignore */ }
    if (superName) {
      base += ` extends ${superName}`;
    }
  } else {
    base += ' extends [null prototype]';
  }
  return `[${base}]`;
}

// Names of Node's built-in globals (Node's `builtInObjects` in
// lib/internal/util/inspect.js). Used to stop the prototype walk and to
// decide whether prototype properties are surfaced with showHidden.
const builtinCtorNames = new Set(
  Object.getOwnPropertyNames(globalThis).filter((n) => /^[A-Z][a-zA-Z0-9]+$/.test(n)),
);

/** instanceof check that never throws (proxies, revoked membranes, ...). */
function safeInstanceof(tmp, fn) {
  try {
    return tmp instanceof fn;
  } catch {
    return false;
  }
}

function safeGetOwnPropertyDescriptor(obj, key) {
  try {
    return Object.getOwnPropertyDescriptor(obj, key);
  } catch {
    return undefined;
  }
}

/**
 * Mirrors Node's getConstructorName walk: an own 'constructor' descriptor is
 * only accepted when it is a function with a non-empty name and the
 * inspected value is genuinely an instance of it. Returns `{ name,
 * descended }`, or `null` when the value has a null prototype. `descended`
 * reports whether the name was found below the value's first prototype.
 * @param {any} value
 */
function nodeConstructorName(value) {
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    return { name: 'Object', descended: false };
  }
  if (proto === null) return null;
  const tmp = value;
  let obj = value;
  let firstProto;
  while (obj !== null) {
    const desc = safeGetOwnPropertyDescriptor(obj, 'constructor');
    if (desc !== undefined &&
        typeof desc.value === 'function' &&
        desc.value.name !== '' &&
        safeInstanceof(tmp, desc.value)) {
      return { name: String(desc.value.name), descended: firstProto !== obj };
    }
    let next;
    try {
      next = Object.getPrototypeOf(obj);
    } catch {
      break;
    }
    obj = next;
    if (firstProto === undefined) firstProto = obj;
  }
  return { name: 'Object', descended: false };
}

/**
 * Mirror of Node's addPrototypeProperties: with showHidden, collect up to
 * three prototype layers' non-constructor, non-function properties. Getters
 * run with the inspected object as receiver. Returns the formatted property
 * strings (empty when nothing applies).
 */
function collectPrototypeProps(ctx, main, recurseTimes) {
  const output = [];
  let prevKeys = null;
  let obj = main;
  for (let depth = 0; depth < 3; depth++) {
    let next;
    try {
      next = Object.getPrototypeOf(obj);
    } catch {
      break;
    }
    obj = next;
    if (obj === null) break;
    const ctorDesc = safeGetOwnPropertyDescriptor(obj, 'constructor');
    if (ctorDesc !== undefined &&
        typeof ctorDesc.value === 'function' &&
        builtinCtorNames.has(ctorDesc.value.name)) {
      break;
    }
    let keys;
    try {
      keys = Reflect.ownKeys(obj);
    } catch {
      break;
    }
    // Keep the inspected object on the seen stack while its prototype
    // getters run, so `this`-references format as circular.
    const prevIdx = ctx.seenMap ? ctx.seenMap.get(main) : undefined;
    ctx.seen.push(main);
    if (ctx.seenMap) ctx.seenMap.set(main, ctx.seen.length - 1);
    try {
      for (const key of keys) {
        if (key === 'constructor') continue;
        if (Object.prototype.hasOwnProperty.call(main, key)) continue;
        if (prevKeys !== null && prevKeys.has(key)) continue;
        const desc = safeGetOwnPropertyDescriptor(obj, key);
        if (desc === undefined || typeof desc.value === 'function') continue;
        output.push(formatProperty(ctx, obj, recurseTimes, key, false, main));
      }
    } finally {
      ctx.seen.pop();
      if (ctx.seenMap) {
        if (prevIdx === undefined) ctx.seenMap.delete(main);
        else ctx.seenMap.set(main, prevIdx);
      }
    }
    if (prevKeys === null) prevKeys = new Set();
    for (const key of keys) prevKeys.add(key);
  }
  return output;
}

/**
 * Whether prototype properties should be collected for `value` (Node's
 * addPrototypeProperties gating inside getConstructorName).
 */
function maybePrototypeProps(ctx, value, recurseTimes, ctor) {
  if (!ctx.options.showHidden || ctor === null) return [];
  if (!ctor.descended && builtinCtorNames.has(ctor.name)) return [];
  return collectPrototypeProps(ctx, value, recurseTimes);
}

/**
 * Mirrors Node's getFunctionBase: `[<type>[(null prototype)] [(anonymous) |
 * : <name>]] [<constructor>] [[<tag>]]`. `constructor` is the name from the
 * constructor walk (or null); `type` comes from the real function kind.
 */
function getFunctionBase(ctx, value, recurseTimes) {
  let type = 'Function';
  if (isAsyncGeneratorFunctionValue(value)) type = 'AsyncGeneratorFunction';
  else if (types.isGeneratorFunction(value)) type = 'GeneratorFunction';
  else if (types.isAsyncFunction(value)) type = 'AsyncFunction';
  const ctor = nodeConstructorName(value);
  const constructor = ctor === null ? null : ctor.name;
  let tag = '';
  try {
    tag = value[Symbol.toStringTag];
  } catch { /* ignore */ }
  // Only list the tag when it wouldn't already print as a regular property.
  if (typeof tag !== 'string' ||
      (tag !== '' &&
       (ctx.options.showHidden
         ? Object.prototype.hasOwnProperty.call(value, Symbol.toStringTag)
         : Object.prototype.propertyIsEnumerable.call(value, Symbol.toStringTag)))) {
    tag = '';
  }
  // Node detects classes from the function's source and inspects them via
  // getClassBase instead of the regular function base.
  let stringified = '';
  try { stringified = Function.prototype.toString.call(value); } catch { /* ignore */ }
  if (stringified.startsWith('class') && stringified[stringified.length - 1] === '}') {
    const slice = stringified.slice(5, -1);
    const bracketIndex = slice.indexOf('{');
    if (bracketIndex !== -1 &&
        (!slice.slice(0, bracketIndex).includes('(') ||
         nodeClassRegExp.test(slice.replace(nodeStripCommentsRegExp, '')))) {
      return {
        base: ctx.stylize(getClassBase(value, constructor, tag), 'special'),
        protoProps: maybePrototypeProps(ctx, value, recurseTimes, ctor),
      };
    }
  }
  let base = `[${type}`;
  if (constructor === null) base += ' (null prototype)';
  if (value.name === '') base += ' (anonymous)';
  else {
    base += `: ${typeof value.name === 'string'
      ? value.name
      : formatValue(ctx, value.name, recurseTimes === null ? null : recurseTimes - 1)}`;
  }
  base += ']';
  if (constructor !== type && constructor !== null) base += ` ${constructor}`;
  if (tag !== '' && constructor !== tag) base += ` [${tag}]`;
  return { base: ctx.stylize(base, 'special'), protoProps: maybePrototypeProps(ctx, value, recurseTimes, ctor) };
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
    // Node splits long strings at newlines into multiple quoted segments
    // when compact is not true (lib/internal/util/inspect.js formatPrimitive).
    // The continuation indent is relative; reduceToSingleString re-indents
    // nested values, so a base indent of two (the top-level case) suffices.
    const breakLength = ctx.options.breakLength ?? 80;
    const compact = ctx.options.compact ?? 3;
    if (compact !== true && str.length > 16 && str.length > breakLength - 4) {
      const parts = str.split(/(?<=\n)/);
      if (parts.length > 1) {
        return parts.map((line) => ctx.stylize(quoteString(line), 'string'))
          .join(' +\n  ') + trailer;
      }
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
  if (typeof value === 'symbol') {
    // Escape newlines etc. in the symbol description (Node does this).
    const str = String(value).replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    return ctx.stylize(str, 'symbol');
  }
  return undefined;
}

/**
 * Mirror of Node's getPrefix() in lib/internal/util/inspect.js: builds the
 * leading "Constructor [tag] " (or "[fallback: null prototype] [tag] ")
 * used when improving an error's first stack line.
 * @param {string | null} constructor
 * @param {string} tag
 * @param {string} fallback
 */
function getErrorPrefix(constructor, tag, fallback, size = '') {
  if (constructor === null) {
    if (tag !== '' && fallback !== tag) {
      return `[${fallback}${size}: null prototype] [${tag}] `;
    }
    return `[${fallback}${size}: null prototype] `;
  }
  let result = `${constructor}${size} `;
  if (tag !== '') {
    const position = constructor.indexOf(tag);
    if (position === -1) {
      result += `[${tag}] `;
    } else {
      const endPos = position + tag.length;
      if (endPos !== constructor.length &&
          constructor[endPos] === constructor[endPos].toLowerCase()) {
        result += `[${tag}] `;
      }
    }
  }
  return result;
}

/**
 * Mirror of Node's improveStack(): rewrites an error's first stack line to
 * reflect the current constructor, name, and Symbol.toStringTag. Like Node,
 * this throws for symbol names (`` `${name}` ``) instead of swallowing it.
 * @param {string} stack
 * @param {string | null} constructor
 * @param {unknown} name
 * @param {string} tag
 */
function improveErrorStack(stack, constructor, name, tag) {
  let len = name.length;
  if (typeof name !== 'string') {
    stack = stack.replace(
      `${name}`,
      `${name} [${getErrorPrefix(constructor, tag, 'Error').slice(0, -1)}]`,
    );
  }
  if (constructor === null ||
      (typeof name === 'string' && name.endsWith('Error') &&
       stack.startsWith(name) &&
       (stack.length === len || stack[len] === ':' || stack[len] === '\n'))) {
    let fallback = 'Error';
    if (constructor === null) {
      const start = /^([A-Z][a-z_ A-Z0-9\-]+)(?::|\n {4}at)/.exec(stack) ||
        /^([a-z_A-Z0-9-]*Error)$/.exec(stack);
      fallback = (start && start[1]) || '';
      len = fallback.length;
      fallback ||= 'Error';
    }
    const prefix = getErrorPrefix(constructor, tag, fallback).slice(0, -1);
    if (name !== prefix) {
      if (prefix.includes(name)) {
        if (len === 0) {
          stack = `${prefix}: ${stack}`;
        } else {
          stack = `${prefix}${stack.slice(len)}`;
        }
      } else {
        stack = `${prefix} [${name}]${stack.slice(len)}`;
      }
    }
  }
  return stack;
}

/**
 * Mirror of Error.prototype.toString(err) as used by Node's getStackString.
 * `name` is already defaulted ('Error' for null/undefined). Throws for
 * symbol names or throwing message getters, like the original.
 * @param {Error} value
 * @param {unknown} name
 */
function errorProtoToString(value, name) {
  const nameStr = `${name}`;
  const message = value.message;
  const msgStr = message === undefined ? '' : `${message}`;
  if (nameStr === '') return msgStr;
  if (msgStr === '') return nameStr;
  return `${nameStr}: ${msgStr}`;
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

/** @param {ArrayBuffer|SharedArrayBuffer} buf @param {number} maxArrayLength */
function formatArrayBufferContents(buf, maxArrayLength) {
  const u8 = new Uint8Array(/** @type {any} */ (buf));
  const shown = [];
  const max = Math.min(u8.length, maxArrayLength);
  for (let i = 0; i < max; i++) shown.push(u8[i].toString(16).padStart(2, '0'));
  let contents = shown.join(' ');
  const remaining = u8.length - max;
  if (remaining > 0) contents += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;
  return `<${contents}>`;
}

/** @param {ArrayBuffer|SharedArrayBuffer} buf */
function isDetachedBuffer(buf) {
  try {
    // eslint-disable-next-line no-new
    new Uint8Array(/** @type {any} */ (buf));
    return false;
  } catch {
    return true;
  }
}

/**
 * @param {ReturnType<typeof makeCtx>} ctx
 * @param {Map<any,any>|Set<any>} value
 * @param {number|null} recurseTimes
 * @param {boolean} isMap
 */
/**
 * Get maxArrayLength, handling null (infinite) correctly.
 * @param {ReturnType<typeof makeCtx>} ctx
 */
function getMaxArrayLength(ctx) {
  const opt = ctx.options.maxArrayLength;
  return opt === null ? Infinity : (opt ?? 100);
}

/**
 * Node reads collection sizes via the primordial getters
 * (SetPrototypeGetSize/MapPrototypeGetSize) so null-prototype collections
 * still report their size.
 */
function getCollectionSize(value, isMap) {
  try {
    const desc = Object.getOwnPropertyDescriptor(
      isMap ? Map.prototype : Set.prototype, 'size');
    if (desc && typeof desc.get === 'function') {
      return Reflect.apply(desc.get, value, []);
    }
  } catch { /* ignore */ }
  return 0;
}

function formatCollection(ctx, value, recurseTimes, isMap) {
  const output = [];
  const maxLen = getMaxArrayLength(ctx);
  let i = 0;
  // Node calls the primordial Set/Map iterators and size getters directly
  // (SetPrototypeValues, MapPrototypeEntries, SetPrototypeGetSize), so
  // collections with a null prototype still iterate and report size.
  let size = 0;
  let iterator = null;
  try {
    size = getCollectionSize(value, isMap);
    iterator = isMap
      ? Map.prototype.entries.call(value)
      : Set.prototype.values.call(value);
  } catch { /* fall through with empty output */ }
  // Mirror Node's formatMap/formatSet: the indentation level grows around
  // entry formatting. Applied only for compact===true; other modes use the
  // polyfill's own `level`-based indentation and must observe
  // indentationLvl unchanged.
  const trackIndent = ctx.options.compact === true;
  if (trackIndent) ctx.indentationLvl = (ctx.indentationLvl || 0) + 2;
  for (const entry of iterator || []) {
    const nextRecurse = recurseTimes === null ? null : recurseTimes - 1;
    if (isMap) {
      const [k, v] = entry;
      output.push(`${formatValue(ctx, k, nextRecurse)} => ${formatValue(ctx, v, nextRecurse)}`);
    } else {
      output.push(formatValue(ctx, entry, nextRecurse));
    }
    if (++i >= maxLen && size > maxLen) {
      const remaining = size - i;
      output.push(`... ${remaining} more item${remaining === 1 ? '' : 's'}`);
      break;
    }
  }
  if (trackIndent) ctx.indentationLvl -= 2;
  return output;
}

/**
 * Formats a single property, honoring the getters option.
 * @param {ReturnType<typeof makeCtx>} ctx
 * @param {any} value object holding the property descriptor
 * @param {number|null} recurseTimes
 * @param {string|symbol} key
 * @param {boolean} isArray
 * @param {any} [original] receiver used when invoking a getter (differs from
 * `value` for prototype properties collected with showHidden)
 */
function formatProperty(ctx, value, recurseTimes, key, isArray, original) {
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(value, key) || { value: undefined };
  } catch {
    // Uninitialized module namespace binding (e.g. export const a; before
    // evaluation). getOwnPropertyDescriptor throws for these.
    const name = typeof key === 'symbol' ? `[${ctx.stylize(String(key), 'symbol')}]`
      : /^[a-zA-Z_$][a-zA-Z_$0-9]*$/.test(key) ? ctx.stylize(key, 'name') : quoteString(key);
    return `${name}: ${ctx.stylize('<uninitialized>', 'special')}`;
  }
  // Handle uninitialized module namespace bindings (descriptor exists but
  // accessing the value throws).
  if (!('value' in desc) && !desc.get && !desc.set) {
    try {
      desc.value = value[key];
    } catch {
      const name = typeof key === 'symbol' ? `[${ctx.stylize(String(key), 'symbol')}]`
        : /^[a-zA-Z_$][a-zA-Z_$0-9]*$/.test(key) ? ctx.stylize(key, 'name') : quoteString(key);
      return `${name}: ${ctx.stylize('<uninitialized>', 'special')}`;
    }
  }
  const mode = ctx.options.getters || false;
  let str;
  let extra = ' ';
  if (desc.get !== undefined || desc.set !== undefined) {
    // Accessor property. Mirror Node: `[Getter]` / `[Getter/Setter]` labels
    // are stylized; the evaluated result is shown as `[Getter] <obj>` for
    // objects and `[Getter: <primitive>]` for primitives. Getters run with
    // the original inspected object as receiver.
    if (desc.get !== undefined) {
      const label = desc.set !== undefined ? 'Getter/Setter' : 'Getter';
      const shouldEval = mode === true ||
        (mode === 'get' && desc.set === undefined) ||
        (mode === 'set' && desc.set !== undefined);
      if (shouldEval) {
        const nextRecurse = recurseTimes === null ? null : recurseTimes - 1;
        try {
          const tmp = desc.get.call(original === undefined ? value : original);
          if (tmp === null) {
            str = `${ctx.stylize(`[${label}:`, 'special')} ${ctx.stylize('null', 'null')}${ctx.stylize(']', 'special')}`;
          } else if (typeof tmp === 'object') {
            str = `${ctx.stylize(`[${label}]`, 'special')} ${formatValue(ctx, tmp, nextRecurse)}`;
          } else {
            const primitive = formatPrimitive(ctx, tmp);
            str = `${ctx.stylize(`[${label}:`, 'special')} ${primitive}${ctx.stylize(']', 'special')}`;
          }
        } catch (err) {
          // A stack overflow while running the getter or formatting its
          // result must reach the formatObject guard (Node rethrows
          // isStackOverflowError here instead of reporting it).
          if (isStackOverflowError(err)) throw err;
          const message = `<Inspection threw (${formatValue(ctx, err, nextRecurse)})>`;
          str = `${ctx.stylize(`[${label}:`, 'special')} ${message}${ctx.stylize(']', 'special')}`;
        }
      } else {
        str = ctx.stylize(`[${label}]`, 'special');
      }
    } else {
      str = ctx.stylize('[Setter]', 'special');
    }
  } else if (ctx.seen.includes(desc.value)) {
    let num = ctx.circularNums.get(desc.value);
    if (num === undefined) {
      num = ctx.circularNums.size + 1;
      ctx.circularNums.set(desc.value, num);
    }
    str = ctx.stylize(`[Circular *${num}]`, 'special');
  } else {
    // Mirror Node's formatProperty: the indentation level grows around the
    // value (diff 3 for object properties under compact===true, else 2) so
    // nested layout observes the absolute level. The bump applies only for
    // compact===true; other modes use the polyfill's own `level`-based
    // indentation and must see indentationLvl unchanged.
    const diff = (ctx.options.compact !== true || isArray) ? 2 : 3;
    const trackIndent = ctx.options.compact === true;
    if (trackIndent) ctx.indentationLvl = (ctx.indentationLvl || 0) + diff;
    str = formatValue(ctx, desc.value, recurseTimes === null ? null : recurseTimes - 1);
    if (diff === 3) {
      // Node: when the formatted value is wider than breakLength, start it
      // on a new line at the (bumped) indentation level.
      const breakLength = ctx.options.breakLength ?? 80;
      if (breakLength < str.replace(ansiLenRegex, '').length) {
        extra = `\n${' '.repeat(ctx.indentationLvl || 0)}`;
      }
    }
    if (trackIndent) ctx.indentationLvl -= diff;
  }

  if (typeof key === 'symbol') {
    const symName = formatPrimitive(ctx, key);
    // Only non-enumerable symbol keys get brackets (with showHidden).
    if (ctx.options.showHidden && desc && desc.enumerable === false) {
      return `[${symName}]:${extra}${str}`;
    }
    return `${symName}:${extra}${str}`;
  }
  if (isArray && isCanonicalArrayIndex(key)) return str;
  let name = /^[a-zA-Z_$][a-zA-Z_$0-9]*$/.test(key)
    ? ctx.stylize(key, 'name')
    : ctx.stylize(quoteString(key), 'string');
  // Show non-enumerable properties with brackets when showHidden is true.
  if (ctx.options.showHidden && desc && desc.enumerable === false) {
    name = `[${name}]`;
  }
  return `${name}:${extra}${str}`;
}

/**
 * Joins property output, choosing single-line vs multiline layout the way
 * Node's reduceToSingleString does (compact budget + breakLength).
 * @param {ReturnType<typeof makeCtx>} ctx
 * {string[]} output
 * @param {string} tag e.g. '', '[Object: null prototype]', 'Map(2)'
 * @param {[string, string]} braces
 * @param {number} level
 */
function reduceToSingleString(ctx, output, tag, braces, level) {
  const options = ctx.options;
  const breakLength = options.breakLength ?? 80;
  const compact = options.compact ?? 3;
  const prefix = tag === '' ? '' : `${tag} `;

  if (output.length === 0) return `${prefix}${braces[0]}${braces[1]}`;

  if (compact === true) {
    // Mirror Node's reduceToSingleString for compact===true: try a single
    // line first (start=0); otherwise one entry per line at the absolute
    // indentation level. Nested values already carry absolute indentation
    // via the indentationLvl tracking in formatProperty, so no
    // re-indentation of embedded newlines is done (unlike the modes below).
    // (Mirrors Node's isBelowBreakLength with start=0.)
    let totalLength = output.length;
    let fits = totalLength + output.length <= breakLength &&
      (tag === '' || !tag.includes('\n'));
    if (fits) {
      for (const o of output) {
        totalLength += o.replace(ansiLenRegex, '').length;
        if (totalLength > breakLength) { fits = false; break; }
      }
    }
    if (fits) {
      return `${prefix}${braces[0]} ${output.join(', ')} ${braces[1]}`;
    }
    const indentation = ' '.repeat(ctx.indentationLvl || 0);
    const ln = tag === '' && braces[0].length === 1 ? ' ' : `\n${indentation}  `;
    return `${prefix}${braces[0]}${ln}${output.join(`,\n${indentation}  `)} ${braces[1]}`;
  }

  const budget = compact === false ? -1
    : (typeof compact === 'number' ? compact : 3);

  // Node only collapses to a single line when the remaining depth below this
  // object is within the compact budget (ctx.currentDepth - recurseTimes <
  // compact), everything fits in breakLength, and no entry is multi-line.
  const depthBelow = ctx.currentDepth - ctx.depthLevel;
  if (depthBelow < budget) {
    // Match Node's isBelowBreakLength exactly: start includes entry count,
    // indentation, brace, base length, and a +10 fudge factor.
    const baseLen = tag.length;
    const indentLvl = ctx.indentationLvl || 0;
    let totalLength = output.length + (output.length + indentLvl + braces[0].length + baseLen + 10);
    let hasNewline = tag.includes('\n');
    if (totalLength + output.length <= breakLength) {
      for (const o of output) {
        const stripped = o.replace(ansiLenRegex, '');
        if (stripped.includes('\n')) { hasNewline = true; break; }
        totalLength += stripped.length;
        if (totalLength > breakLength) break;
      }
    } else {
      hasNewline = true; // Force multi-line via length check below
    }
    if (!hasNewline && totalLength <= breakLength) {
      return `${prefix}${braces[0]} ${output.join(', ')} ${braces[1]}`;
    }
  }

  const indentLvl = ctx.indentationLvl || 0;
  const indent = ' '.repeat(indentLvl) + '  '.repeat(level + 1);
  const closing = ' '.repeat(indentLvl) + '  '.repeat(level);
  // Re-indent continuation lines of nested multi-line values. Each property
  // starts at `indent`, so newlines embedded in an already-formatted nested
  // value need the same indent to stay aligned (Node tracks this with
  // ctx.indentationLvl). Applied at every level, the indentation accumulates
  // correctly for arbitrary nesting depth.
  let props = output.map((o) => o.replace(/\n/g, `\n${indent}`));
  return `${prefix}${braces[0]}\n${indent}${props.join(`,\n${indent}`)}\n${closing}${braces[1]}`;
}

/**
 * @param {string} k
 */
function isCanonicalArrayIndex(k) {
  if (typeof k !== 'string' || k === '') return false;
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
    keys = [...PrimordialObjectGetOwnPropertyNames(value), ...PrimordialObjectGetOwnPropertySymbols(value)];
  } else {
    try {
      keys = PrimordialObjectKeys(value);
    } catch {
      // Object.keys() throws for module namespaces with uninitialized
      // bindings. Fall back to getOwnPropertyNames (which works).
      // Don't filter by enumerable — getOwnPropertyDescriptor also throws
      // for uninitialized bindings.
      keys = PrimordialObjectGetOwnPropertyNames(value);
    }
    for (const sym of PrimordialObjectGetOwnPropertySymbols(value)) {
      const desc = PrimordialObjectGetOwnPropertyDescriptor(value, sym);
      if (desc && desc.enumerable) keys.push(sym);
    }
  }
  const strKeys = /** @type {string[]} */ (keys.filter((k) => typeof k === 'string'));
  const symKeys = keys.filter((k) => typeof k === 'symbol');
  // Node does NOT sort here; sorting happens on the formatted output strings
  // in formatValue (so symbols sort before strings with `sorted: true`).
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
  const maxArrayLength = getMaxArrayLength(ctx);
  const valLen = value.length;
  const len = Math.min(Math.max(0, maxArrayLength), valLen);

  // Find first sparse index within the capped range (Node's formatArray).
  let sparseAt = -1;
  for (let i = 0; i < len; i++) {
    if (!hasOwn(value, String(i))) { sparseAt = i; break; }
  }

  if (sparseAt === -1) {
    // Dense prefix: format 0..len-1 directly.
    for (let i = 0; i < len; i++) {
      output.push(formatProperty(ctx, value, recurseTimes, String(i), true));
    }
    if (valLen > len) {
      const more = valLen - len;
      output.push(`... ${more} more item${more === 1 ? '' : 's'}`);
    }
  } else {
    // Sparse: iterate keys and compute empty gaps arithmetically
    // (Node's formatSpecialArray). Never loops over the full length.
    for (let i = 0; i < sparseAt; i++) {
      output.push(formatProperty(ctx, value, recurseTimes, String(i), true));
    }
    let index = sparseAt;
    const keys = Object.keys(value);
    for (const key of keys) {
      if (output.length >= len) break;
      if (!isCanonicalArrayIndex(key)) continue;
      const tmp = Number(key);
      if (tmp < sparseAt) continue;
      // Arrays can only have up to 2^32 - 1 entries; larger are extra keys.
      if (tmp > 2 ** 32 - 2) break;
      if (tmp !== index) {
        const emptyItems = tmp - index;
        output.push(`<${emptyItems} empty item${emptyItems === 1 ? '' : 's'}>`);
        index = tmp;
        if (output.length >= len) break;
      }
      output.push(formatProperty(ctx, value, recurseTimes, key, true));
      index++;
    }
    const remaining = valLen - index;
    if (output.length < len && remaining > 0) {
      output.push(`<${remaining} empty item${remaining === 1 ? '' : 's'}>`);
    } else if (output.length >= len && remaining > 0) {
      // Hit maxArrayLength with items remaining: Node shows "... N more items".
      output.push(`... ${remaining} more item${remaining === 1 ? '' : 's'}`);
    }
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
  const max = getMaxArrayLength(ctx);
  const len = Math.min(value.length, max);
  for (let i = 0; i < len; i++) output.push(formatPrimitive(ctx, value[i]));
  if (value.length > max) {
    const remaining = value.length - max;
    output.push(`... ${remaining} more item${remaining === 1 ? '' : 's'}`);
  }
  if (output.length === 0) return '[]';
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
function formatValue(ctx, value, recurseTimes, level = 0, typedArray = false) {
  // Safeguard against runaway recursion on huge structures.
  // Increment a counter; if we exceed a threshold, bail out.
  ctx.formatCount = (ctx.formatCount || 0) + 1;
  if (ctx.formatCount > 100000) {
    return ctx.stylize('...', 'special');
  }

  // For proxies, avoid triggering traps. Check via native bridge first.
  const isProxy = typeof nativeTypesBridge?.isProxy === 'function' &&
    (typeof value === 'object' || typeof value === 'function') && value !== null &&
    nativeTypesBridge.isProxy(value);
  if (isProxy) {
    // For proxies, delegate to native inspect which can safely get
    // target/handler without triggering user traps (via internal slots).
    // This handles revoked proxies, throwing traps, and showProxy correctly.
    if (typeof nativeInspectBridge === 'function') {
      try {
        const nativeOut = nativeInspectBridge(value, {
          colors: ctx.options.colors,
          depth: ctx.options.depth,
          showProxy: ctx.options.showProxy,
          compact: ctx.options.compact,
        });
        return nativeOut;
      } catch { /* ignore, fall through to safe fallback */ }
    }
    // Fallback: don't trigger traps.
    try {
      Object.getPrototypeOf(value);
    } catch (e) {
      if (e instanceof TypeError && /revoked/i.test(e.message)) {
        return ctx.stylize('<Revoked Proxy>', 'special');
      }
    }
    return ctx.stylize('Proxy', 'special');
  }

  // custom inspect hook
  if (ctx.options.customInspect && value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const custom = value[inspect.custom];
    // Filter out the inspect function itself (Node does this to avoid infinite
    // recursion when util.inspect is stored as a property value).
    if (typeof custom === 'function' && custom !== inspect) {
      const depth = recurseTimes;
      // Node passes a filtered user options object (no internal ctx properties
      // like seen array/budget/indentationLvl; user-passed options are included).
      const userOptions = {
        stylize: ctx.stylize,
        ...ctx.options,
      };
      let ret = custom.call(value, depth, userOptions, inspect);
      // If the custom inspection method returned `this`, don't go into
      // infinite recursion; fall through to normal formatting (Node does this).
      if (ret !== value) {
        if (typeof ret !== 'string') ret = formatValue(ctx, ret, recurseTimes, level);
        return ret;
      }
      // Fall through: format the value normally without re-invoking custom.
    }
  }

  const primitive = formatPrimitive(ctx, value);
  if (primitive !== undefined) return primitive;

  if (types.isPromise(value)) {
    // Use native bridge to get the actual promise state (fulfilled/rejected value).
    // Pure JS cannot synchronously determine promise state.
    if (typeof nativeInspectBridge === 'function') {
      try {
        const nativeOut = nativeInspectBridge(value, {
          colors: ctx.options.colors,
          depth: ctx.options.depth,
          maxArrayLength: ctx.options.maxArrayLength,
          breakLength: ctx.options.breakLength,
          compact: ctx.options.compact,
          showHidden: ctx.options.showHidden,
        });
        return reindentBridgeResult(ctx, nativeOut);
      } catch { /* fall through */ }
    }
    return formatPromise();
  }

  // Map/Set iterators: use native bridge (iterating would consume them).
  if (types.isMapIterator(value) || types.isSetIterator(value)) {
    if (typeof nativeInspectBridge === 'function') {
      try {
        const nativeOut = nativeInspectBridge(value, {
          colors: ctx.options.colors,
          depth: ctx.options.depth,
          maxArrayLength: ctx.options.maxArrayLength,
          breakLength: ctx.options.breakLength,
          compact: ctx.options.compact,
          showHidden: ctx.options.showHidden,
        });
        return reindentBridgeResult(ctx, nativeOut);
      } catch { /* fall through */ }
    }
    // Fallback: generic.
    const name = types.isMapIterator(value) ? 'Map Iterator' : 'Set Iterator';
    return `[${name}] {}`;
  }

  // ---- External (native external value). Pure JS cannot read the pointer
  // address, so we emit a placeholder that matches Node's `[External: <hex>]`
  // shape. types.isExternal delegates to the native predicate in Node.
  if (typeof types.isExternal === 'function' && types.isExternal(value)) {
    return ctx.stylize('[External: 0]', 'special');
  }

  // circular check (push/pop stack)
  // Use a Map for O(1) lookup (critical for deep structures).
  // Circular reference numbers are assigned in circular-encounter order
  // (like Node's ctx.circular), not by first-seen position.
  if (!ctx.seenMap) ctx.seenMap = new Map();
  const seenIdx = ctx.seenMap.has(value) ? ctx.seenMap.get(value) : -1;
  if (seenIdx !== -1) {
    let num = ctx.circularNums.get(value);
    if (num === undefined) {
      num = ctx.circularNums.size + 1;
      ctx.circularNums.set(value, num);
    }
    return ctx.stylize(`[Circular *${num}]`, 'special');
  }
  const idx = ctx.seen.length;
  ctx.seen.push(value);
  ctx.seenMap.set(value, idx);
  // Track nesting depth for the compact-budget single-line decision (Node's
  // ctx.currentDepth). Depth-exhausted values (recurseTimes < 0) return
  // '[Object]' etc. without formatting children, so they don't count.
  let depthCounted = false;
  if (!(recurseTimes !== null && recurseTimes < 0)) {
    ctx.depthLevel++;
    if (ctx.depthLevel > ctx.currentDepth) ctx.currentDepth = ctx.depthLevel;
    depthCounted = true;
  }

  /** @param {string} s */
  const finish = (s) => {
    ctx.seen.pop();
    if (ctx.seenMap) ctx.seenMap.delete(value);
    if (depthCounted) ctx.depthLevel--;
    const num = ctx.circularNums.get(value);
    if (num !== undefined) {
      return `<ref *${num}> ${s}`;
    }
    return s;
  };

  const nextRecurse = recurseTimes === null ? null : recurseTimes - 1;

  // ---- Error
  // Node uses isError() here: a native error OR `value instanceof Error`
  // (covers custom errors whose prototype chain includes Error.prototype
  // without the native error slot, e.g. function-style subclasses).
  if (types.isNativeError(value) || safeInstanceof(value, Error)) {
    // Depth-exhausted: Node returns a simple `[Error]` placeholder without
    // formatting properties (prevents infinite recursion for recursively
    // throwing getters).
    if (recurseTimes !== null && recurseTimes < 0) {
      const ctor = nodeConstructorName(value);
      const name = ctor === null || ctor.name === 'Object' ? 'Error' : ctor.name;
      return finish(ctx.stylize(`[${name}]`, 'special'));
    }
    let stack;
    try { stack = value.stack; } catch { stack = undefined; }
    // Node's formatError inputs: the constructor name (null when the error
    // has a null prototype), the Symbol.toStringTag (only when it would not
    // print as a regular property), and the error name ('Error' when
    // nullish). These feed improveStack, which rewrites the first stack
    // line to reflect the current constructor/name/tag.
    const ctor = nodeConstructorName(value);
    const constructor = ctor === null ? null : ctor.name;
    let tag = '';
    try { tag = value[Symbol.toStringTag]; } catch { /* ignore */ }
    if (typeof tag !== 'string' ||
        (tag !== '' &&
         (ctx.options.showHidden
           ? Object.prototype.hasOwnProperty.call(value, Symbol.toStringTag)
           : Object.prototype.propertyIsEnumerable.call(value, Symbol.toStringTag)))) {
      tag = '';
    }
    let name;
    try { name = value.name; } catch { name = undefined; }
    if (name === null || name === undefined) name = 'Error';
    // Node's Error.prototype.toString fallback, improved like a stack's
    // first line. A throwing toString degrades to '[object Error]' without
    // improveStack, exactly like Node's formatError catch; when there is no
    // usable stack either, Node returns the bare string with no properties.
    let errStr;
    let errStrFailed = false;
    try {
      errStr = improveErrorStack(errorProtoToString(value, name), constructor, name, tag);
    } catch {
      errStrFailed = true;
    }
    let base;
    if (typeof stack === 'string' && stack !== '') {
      // Node's formatError always improveStacks a string stack (throwing for
      // symbol names, like Node), then wraps it in brackets when it holds
      // no stack frames.
      const improved = improveErrorStack(stack, constructor, name, tag);
      base = improved.includes('\n    at') ? improved : `[${improved}]`;
    } else if (errStrFailed) {
      // Node does not return early here; it sets the base to
      // '[object Error]' and continues to format properties (e.g. throwing
      // getters show as `[Getter: <Inspection threw ...>]`).
      base = '[object Error]';
    } else if (stack) {
      let inspectedStack;
      {
        // Replicate Node's getStackString: push to seen, +4 indent, format
        // with undefined recurseTimes. Node's NaN depth check forces
        // multi-line; we simulate by setting currentDepth to NaN.
        // The indentationLvl is included in formatValue's output.
        ctx.seen.push(value);
        ctx.indentationLvl = (ctx.indentationLvl || 0) + 4;
        const savedCurrentDepth = ctx.currentDepth;
        ctx.currentDepth = NaN;
        try {
          inspectedStack = formatValue(ctx, stack, undefined, 0);
        } finally {
          ctx.currentDepth = savedCurrentDepth;
          ctx.indentationLvl -= 4;
          ctx.seen.pop();
        }
      }
      base = `[${errStr}\n    ${inspectedStack}]`;
    } else {
      base = `[${errStr}]`;
    }
    // Filter keys already represented in the base (Node's formatError):
    // 'stack' is hidden only if successfully retrieved (it's in the base);
    // if the getter threw (stack === undefined), show it as a property.
    // 'message'/'name' are hidden if in the base.
    let keys = getKeys(ctx, value);
    if (!ctx.options.showHidden) {
      keys = keys.filter((k) => {
        if (k === 'stack') return stack === undefined;
        if (k === 'message' || k === 'name') {
          let v;
          try {
            v = value[k];
          } catch {
            // If the getter throws, keep the key (it will show as [Getter]).
            return true;
          }
          return !(typeof v === 'string' && base.includes(v));
        }
        return true;
      });
    }
    /** @type {string[]} */
    const extraProps = [];
    // Node surfaces a non-enumerable own 'cause' as [cause] (even if undefined).
    if (Object.prototype.hasOwnProperty.call(value, 'cause') &&
        !Object.prototype.propertyIsEnumerable.call(value, 'cause') &&
        !keys.includes('cause')) {
      extraProps.push(`${ctx.stylize('[cause]', 'special')}: ${formatValue(ctx, value.cause, nextRecurse, level + 1)}`);
    }
    // Node surfaces AggregateError's non-enumerable own 'errors' as [errors].
    try {
      const errors = value.errors;
      if (Array.isArray(errors) &&
          Object.prototype.hasOwnProperty.call(value, 'errors') &&
          !Object.prototype.propertyIsEnumerable.call(value, 'errors') &&
          !keys.includes('errors')) {
        extraProps.push(`${ctx.stylize('[errors]', 'special')}: ${formatValue(ctx, errors, nextRecurse, level + 1)}`);
      }
    } catch { /* ignore getter that throws */ }
    const output = keys.map((key) => formatProperty(ctx, value, recurseTimes, key, false)).concat(extraProps);
    if (output.length === 0) return finish(base);
    // With compact:true, Node puts the error base inside the braces.
    // Single-line if it fits in breakLength, else props on new lines.
    if (ctx.options.compact === true) {
      const singleLine = `{ ${base} ${output.join(', ')} }`;
      const breakLength = ctx.options.breakLength ?? 80;
      if (!base.includes('\n') && !output.some((o) => o.includes('\n')) &&
          singleLine.length <= breakLength) {
        return finish(singleLine);
      }
      return finish(`{ ${base}\n  ${output.join(',\n  ')} }`);
    }
    // Multi-line base (stack trace): properties go on separate lines.
    if (base.includes('\n')) {
      const indent = '  '.repeat(level + 1);
      const closing = '  '.repeat(level);
      return finish(`${base} {\n${indent}${output.join(`,\n${indent}`)}\n${closing}}`);
    }
    return finish(reduceToSingleString(ctx, output, base, ['{', '}'], level));
  }

  // ---- ArrayBuffer / SharedArrayBuffer
  if (types.isAnyArrayBuffer(value)) {
    const name = types.isSharedArrayBuffer(value) ? 'SharedArrayBuffer' : 'ArrayBuffer';
    // A null prototype gets Node's `[ArrayBuffer: null prototype]` prefix.
    const abCtor = nodeConstructorName(value);
    const abBase = abCtor === null
      ? `[${intrinsicConstructorName(value)}: null prototype]`
      : name;
    const output = [];
    if (isDetachedBuffer(value)) {
      // Detached buffers show `(detached)` instead of contents (Node's
      // formatArrayBuffer catches the Uint8Array construction failure).
      output.push(ctx.stylize('(detached)', 'special'));
    } else if (!typedArray) {
      // When formatting a TypedArray's [buffer] extra (typedArray flag),
      // Node omits the [Uint8Contents] to avoid redundancy.
      output.push(`${ctx.stylize('[Uint8Contents]', 'special')}: ${formatArrayBufferContents(value, getMaxArrayLength(ctx))}`);
    }
    output.push(`[${ctx.stylize('byteLength', 'special')}]: ${value.byteLength}`);
    const keys = getKeys(ctx, value);
    for (const key of keys) output.push(formatProperty(ctx, value, recurseTimes, key, false));
    return finish(reduceToSingleString(ctx, output, abBase, ['{', '}'], level));
  }

  // ---- DataView (before TypedArray: ArrayBuffer.isView() is true for DataView).
  // Use types.isDataView for cross-realm safety. Node always shows
  // byteLength/byteOffset/buffer as bracketed extras, before any own keys.
  // If a getter throws (detached buffer), Node falls back to reading the key
  // from value.buffer. Node also leaks +2 indentationLvl per thrown getter
  // (formatExtraProperties' -= 2 is skipped); we replicate the leaked indent
  // for parity.
  if (types.isDataView(value)) {
    const output = [];
    let levelBoost = 0;
    const getExtra = (key) => {
      try {
        return value[key];
      } catch {
        levelBoost++;
        try {
          return value.buffer[key];
        } catch {
          return undefined;
        }
      }
    };
    output.push(`[${ctx.stylize('byteLength', 'special')}]: ${getExtra('byteLength')}`);
    output.push(`[${ctx.stylize('byteOffset', 'special')}]: ${getExtra('byteOffset')}`);
    output.push(`[${ctx.stylize('buffer', 'special')}]: ${formatValue(ctx, getExtra('buffer'), recurseTimes, 0)}`);
    const keys = getKeys(ctx, value);
    for (const key of keys) output.push(formatProperty(ctx, value, recurseTimes, key, false));
    // A null prototype gets Node's `[DataView: null prototype]` prefix.
    const dvCtor = nodeConstructorName(value);
    const dvBase = dvCtor === null ? '[DataView: null prototype]' : 'DataView';
    return finish(reduceToSingleString(ctx, output, dvBase, ['{', '}'], level + levelBoost));
  }

  // ---- TypedArray
  if (ArrayBuffer.isView(value)) {
    // For exact Node parity on complex typed-array formatting (multiline grouping,
    // maxArrayLength, etc.), delegate to the native bridge in Node.
    // The pure-JS fallback below is for browsers.
    if (typeof nativeInspectBridge === 'function' && typeof process !== 'undefined') {
      try {
        const nativeOut = nativeInspectBridge(value, {
          colors: ctx.options.colors,
          depth: ctx.options.depth,
          maxArrayLength: ctx.options.maxArrayLength,
          breakLength: ctx.options.breakLength,
          compact: ctx.options.compact,
          showHidden: ctx.options.showHidden,
        });
        return reindentBridgeResult(ctx, nativeOut);
      } catch { /* fall through to pure-JS */ }
    }
    const ctorName = value.constructor && value.constructor.name ? value.constructor.name : 'TypedArray';
    // Use the true length via byteLength (bypasses a broken own 'length'
    // property, like Node's TypedArrayPrototypeGetLength). Node decides
    // number vs BigInt formatting from value.length, so a broken length
    // yields BigInt formatting.
    const trueLength = value.byteLength / value.BYTES_PER_ELEMENT;
    const useBigInt = !(value.length > 0);
    const output = [];
    const max = getMaxArrayLength(ctx);
    const tlen = Math.min(trueLength, max);
    for (let i = 0; i < tlen; i++) {
      if (useBigInt) {
        const out = ctx.options.numericSeparator ? addNumericSeparator(String(value[i])) + 'n' : `${value[i]}n`;
        output.push(ctx.stylize(out, 'bigint'));
      } else {
        output.push(formatPrimitive(ctx, value[i]));
      }
    }
    if (trueLength > max) {
      const remaining = trueLength - max;
      output.push(`... ${remaining} more item${remaining === 1 ? '' : 's'}`);
    }
    const keys = getKeys(ctx, value).filter((k) =>
      !['length', 'byteLength', 'byteOffset', 'buffer'].includes(String(k)) &&
      !isCanonicalArrayIndex(String(k)));
    for (const key of keys) output.push(formatProperty(ctx, value, recurseTimes, key, false));
    // With showHidden, Node appends the non-enumerable typed-array internals.
    if (ctx.options.showHidden) {
      for (const k of ['BYTES_PER_ELEMENT', 'length', 'byteLength', 'byteOffset', 'buffer']) {
        let v;
        try { v = value[k]; } catch { v = undefined; }
        // Pass typedArray=true so a [buffer] ArrayBuffer omits [Uint8Contents].
        const isBuf = k === 'buffer';
        output.push(`[${ctx.stylize(k, 'special')}]: ${formatValue(ctx, v, recurseTimes, 0, isBuf)}`);
      }
    }
    const arrStr = reduceToSingleString(ctx, output, '', ['[', ']'], level);
    return finish(`${ctorName}(${trueLength}) ${arrStr}`);
  }

  // ---- Map / Set / WeakMap / WeakSet
  if (types.isMap(value)) {
    const entries = formatCollection(ctx, value, recurseTimes, true);
    // Node always appends own enumerable properties (getKeys), not just
    // with showHidden.
    for (const k of getKeys(ctx, value)) {
      entries.push(formatProperty(ctx, value, recurseTimes, k, false, value));
    }
    // A null prototype gets Node's `[Map(n): null prototype]` prefix.
    const mapCtor = nodeConstructorName(value);
    const mapSize = getCollectionSize(value, true);
    let mapBase;
    if (mapCtor === null) {
      mapBase = `[Map(${mapSize}): null prototype]`;
    } else {
      const ctorName = mapCtor.name;
      mapBase = (ctorName && ctorName !== 'Map') ? `${ctorName}(${mapSize})` : `Map(${mapSize})`;
    }
    return finish(reduceToSingleString(ctx, entries, mapBase, ['{', '}'], level));
  }
  if (types.isSet(value)) {
    const entries = formatCollection(ctx, value, recurseTimes, false);
    // Node always appends own enumerable properties (getKeys), not just
    // with showHidden.
    for (const k of getKeys(ctx, value)) {
      entries.push(formatProperty(ctx, value, recurseTimes, k, false, value));
    }
    // Use the constructor name (e.g. SetSubclass) if it's not just 'Set'.
    // A null prototype gets Node's `[Set(n): null prototype]` prefix.
    const ctor = nodeConstructorName(value);
    const collSize = getCollectionSize(value, false);
    let setBase;
    if (ctor === null) {
      setBase = `[Set(${collSize}): null prototype]`;
    } else {
      const ctorName = ctor.name;
      const setName = (ctorName && ctorName !== 'Set') ? ctorName : 'Set';
      // Append [Set] tag for subclasses, unless the name already contains 'Set'
      // followed by an uppercase letter (e.g. SetSubclass -> no tag, Settings -> [Set]).
      // This matches Node's heuristic to avoid redundant tags.
      let tagSuffix = '';
      if (setName !== 'Set') {
        const tag = 'Set';
        const idx = setName.indexOf(tag);
        const isRedundant = idx !== -1 &&
          (idx + tag.length >= setName.length ||
           /[A-Z]/.test(setName[idx + tag.length]));
        if (!isRedundant) tagSuffix = ' [Set]';
      }
      setBase = `${setName}(${collSize})${tagSuffix}`;
    }
    return finish(reduceToSingleString(ctx, entries, setBase, ['{', '}'], level));
  }
  if (types.isWeakMap(value) || types.isWeakSet(value)) {
    const name = types.isWeakMap(value) ? 'WeakMap' : 'WeakSet';
    // With showHidden, Node reveals WeakMap/WeakSet entries via an internal
    // API. Delegate to the native bridge in Node; browsers keep
    // '<items unknown>'.
    if (ctx.options.showHidden && typeof nativeInspectBridge === 'function' &&
        typeof process !== 'undefined') {
      try {
        const nativeOut = nativeInspectBridge(value, {
          colors: ctx.options.colors,
          depth: ctx.options.depth,
          maxArrayLength: ctx.options.maxArrayLength,
          breakLength: ctx.options.breakLength,
          compact: ctx.options.compact,
          showHidden: true,
        });
        return finish(reindentBridgeResult(ctx, nativeOut));
      } catch { /* fall through */ }
    }
    // Node prefixes via getPrefix: `Foo [WeakSet] ` for subclasses,
    // `[WeakSet: null prototype] ` for null prototypes.
    const weakCtor = nodeConstructorName(value);
    const weakConstructor = weakCtor === null ? null : weakCtor.name;
    const weakTag = getFilteredTag(ctx, value);
    const weakPrefix = (weakConstructor !== name || weakTag !== '')
      ? getPrefix(weakConstructor, weakTag, name)
      : '';
    const weakBase = weakPrefix ? weakPrefix.trimEnd() : name;
    return finish(reduceToSingleString(
      ctx,
      (() => {
        const entries = [ctx.stylize('<items unknown>', 'special')];
        // Node always appends own enumerable properties (getKeys).
        for (const k of getKeys(ctx, value)) {
          entries.push(formatProperty(ctx, value, recurseTimes, k, false, value));
        }
        return entries;
      })(),
      weakBase,
      ['{', '}'],
      level,
    ));
  }

  // ---- Proxy (best effort)
  // Only use proxy formatting if the value is actually a proxy.
  const isProxyValue = typeof nativeTypesBridge?.isProxy === 'function'
    ? nativeTypesBridge.isProxy(value)
    : false;
  if (isProxyValue && ctx.options.showProxy) {
    return finish(`Proxy [ ${ctx.stylize('<target unknown>', 'special')}, ${ctx.stylize('<handler unknown>', 'special')} ]`);
  }

  // ---- generic object / array / function / date / regexp
  let tag = '';
  let braces = ['{', '}'];
  let isArr = false;
  /** braces are always shown (objects/arrays) vs only when there are keys (fn/date/re) */
  let bracesAlways = true;
  /** prototype properties collected with showHidden (Node's addPrototypeProperties) */
  let protoProps = [];

  if (types.isArgumentsObject(value)) {
    // Mirror Node: Arguments objects use '[Arguments] {' as the opening brace.
    braces[0] = '[Arguments] {';
  } else if (Array.isArray(value) &&
             (Symbol.iterator in Object(value) || nodeConstructorName(value) === null)) {
    isArr = true;
    // Node: `getPrefix(constructor, tag, 'Array', `(${value.length})`)` —
    // `[Array(3): null prototype] ` for null prototypes, `Foobar(5) ` for
    // Array subclasses, '' for ordinary arrays. The constructor must be a
    // genuine instance (nodeConstructorName walk).
    // Note: Arrays without Symbol.iterator (e.g. proto set to
    // Number.prototype) are NOT treated as arrays by Node; they fall through
    // to generic object formatting.
    const ctor = nodeConstructorName(value);
    const constructor = ctor === null ? null : ctor.name;
    let arrayTag = '';
    try { arrayTag = value[Symbol.toStringTag]; } catch { /* ignore */ }
    if (typeof arrayTag !== 'string' ||
        (arrayTag !== '' &&
         (ctx.options.showHidden
           ? Object.prototype.hasOwnProperty.call(value, Symbol.toStringTag)
           : Object.prototype.propertyIsEnumerable.call(value, Symbol.toStringTag)))) {
      arrayTag = '';
    }
    const arrayPrefix = (constructor !== 'Array' || arrayTag !== '')
      ? getPrefix(constructor, arrayTag, 'Array', `(${value.length})`)
      : '';
    braces = [`${arrayPrefix}[`, ']'];
    protoProps = maybePrototypeProps(ctx, value, recurseTimes, ctor);
  } else if (typeof value === 'function') {
    // Classes are detected inside getFunctionBase (Node's getClassBase);
    // the base flows through the regular property handling below so class
    // properties (e.g. `clazz.foo = true`) still print.
    const fb = getFunctionBase(ctx, value, recurseTimes);
    tag = fb.base;
    protoProps = fb.protoProps;
    bracesAlways = false;
  } else if (types.isRegExp(value)) {
    // Node formats null-prototype regexes by cloning (`new RegExp(value)`)
    // so source/flags remain accessible; otherwise RegExp.prototype.toString
    // would give `/undefined/undefined`. Prefix via getPrefix
    // (`Foo /.../`, `[RegExp: null prototype] /.../`).
    const reCtor = nodeConstructorName(value);
    const reConstructor = reCtor === null ? null : reCtor.name;
    const reTag = getFilteredTag(ctx, value);
    const rePrefix = (reConstructor !== 'RegExp' || reTag !== '')
      ? getPrefix(reConstructor, reTag, 'RegExp')
      : '';
    const reValue = reConstructor === null ? new RegExp(value) : value;
    let reStr;
    try {
      reStr = RegExp.prototype.toString.call(reValue);
    } catch {
      reStr = '/undefined/undefined';
    }
    tag = rePrefix + ctx.stylize(reStr, 'regexp');
    bracesAlways = false;
  } else if (types.isDate(value)) {
    const dCtor = nodeConstructorName(value);
    const dConstructor = dCtor === null ? null : dCtor.name;
    const dTag = getFilteredTag(ctx, value);
    const dPrefix = (dConstructor !== 'Date' || dTag !== '')
      ? getPrefix(dConstructor, dTag, 'Date')
      : '';
    try { tag = dPrefix + ctx.stylize(Date.prototype.toISOString.call(value), 'date'); }
    catch { tag = dPrefix + ctx.stylize(Date.prototype.toString.call(value), 'date'); }
    bracesAlways = false;
  } else if (isBoxedPrimitiveValue(value)) {
    // Get the name from the actual type, not objectToString (which is affected
    // by Symbol.toStringTag).
    const name = types.isNumberObject(value) ? 'Number' :
                 types.isStringObject(value) ? 'String' :
                 types.isBooleanObject(value) ? 'Boolean' :
                 types.isBigIntObject(value) ? 'BigInt' :
                 types.isSymbolObject(value) ? 'Symbol' : 'Object';
    // Get the primitive value safely. Use the prototype's valueOf to handle
    // null-prototype objects (e.g. Object.setPrototypeOf(new Boolean(true), null)).
    let prim;
    try {
      const proto = name === 'Number' ? Number.prototype :
                    name === 'String' ? String.prototype :
                    name === 'Boolean' ? Boolean.prototype :
                    name === 'BigInt' ? Object.getPrototypeOf(Object(1n)) :
                    name === 'Symbol' ? Symbol.prototype :
                    Object.prototype;
      prim = proto.valueOf.call(value);
    } catch {
      prim = undefined;
    }
    const inner = prim !== undefined ? formatPrimitive(ctx, prim) : undefined;
    // Node stylizes the entire [String: 'test'] wrapper, not just the inner.
    // For null-prototype objects, Node includes "(null prototype)" in the tag.
    // For non-default prototypes, Node includes the prototype name (e.g. "(Array)").
    const actualProto = Object.getPrototypeOf(value);
    const defaultProto = name === 'Number' ? Number.prototype :
                         name === 'String' ? String.prototype :
                         name === 'Boolean' ? Boolean.prototype :
                         name === 'BigInt' ? Object.getPrototypeOf(Object(1n)) :
                         name === 'Symbol' ? Symbol.prototype : null;
    let protoSuffix = '';
    if (actualProto === null) protoSuffix = ' (null prototype)';
    else if (actualProto !== defaultProto) {
      const protoName = actualProto?.constructor?.name || 'Object';
      if (protoName && protoName !== name) protoSuffix = ` (${protoName})`;
    }
    if (inner !== undefined) {
      const styleType = typeof prim;
      tag = ctx.stylize(`[${name}${protoSuffix}: ${inner.replace(/\x1B\[[0-9]+m/g, '')}]`, styleType);
    } else {
      // Fallback: don't stylize if we can't get the primitive.
      tag = `[${name}${protoSuffix}]`;
    }
    // Append Symbol.toStringTag if present and different from the name.
    const toStringTag = value[Symbol.toStringTag];
    if (typeof toStringTag === 'string' && toStringTag !== name) {
      tag += ` [${toStringTag}]`;
    }
    bracesAlways = false;
  } else {
    // Compute objectToString once, handling throwing Symbol.toStringTag getters.
    let objToString;
    try {
      objToString = objectToString(value);
    } catch {
      objToString = '[object Object]';
    }
    if (objToString === '[object Module]') {
      // Module namespace object.
      tag = '[Module: null prototype]';
    } else if (objToString === '[object Object]') {
    const proto = Object.getPrototypeOf(value);
    if (proto === null) {
      // For null-prototype objects, try to get the constructor name via the
      // native bridge (V8 knows the constructor even when the prototype is
      // null). Fall back to 'Object' if unavailable.
      let ctorName = 'Object';
      if (typeof nativeInspectBridge === 'function') {
        try {
          // Use a minimal inspect to extract the constructor name.
          // The native output is like '[Foo: null prototype] {}'.
          const nativeOut = nativeInspectBridge(value, { depth: -1, colors: false });
          const m = /^\[([^:\]]+): null prototype\]/.exec(nativeOut);
          if (m) ctorName = m[1];
        } catch { /* ignore */ }
      }
      tag = `[${ctorName}: null prototype]`;
    } else if (proto === Object.prototype) {
      tag = '';
    } else {
      // Only use the constructor name when the value is genuinely an
      // instance of that constructor (Node's getConstructorName walk).
      // If no constructor is found but the prototype is non-standard,
      // Node shows `Object <prototype>`.
      const ctor = nodeConstructorName(value);
      if (ctor !== null && ctor.name !== 'Object') {
        tag = ctor.name;
      } else if (proto !== Object.prototype && proto !== null) {
        const fullName = getConstructorNameWithProto(ctx, value, recurseTimes);
        if (fullName !== null && fullName !== 'Object') {
          tag = fullName;
        }
      }
      protoProps = maybePrototypeProps(ctx, value, recurseTimes, ctor);
    }
  } else {
    // For objects with own Symbol.toStringTag (or custom toStringTag):
    // - If plain and will show as key: no prefix (or null-prototype prefix).
    // - Otherwise: use constructor name + [tag] (e.g. 'Foo [bar]').
    const desc = Object.getOwnPropertyDescriptor(value, Symbol.toStringTag);
    const proto = Object.getPrototypeOf(value);
    const isPlain = proto === Object.prototype || proto === null;
    const isNullProto = proto === null;
    const isEnumerable = desc && desc.enumerable;
    const willShowAsKey = isPlain && (isEnumerable || ctx.options.showHidden);
    if (willShowAsKey) {
      tag = isNullProto ? '[Object: null prototype]' : '';
    } else {
      let objStr;
      try {
        objStr = objectToString(value);
      } catch {
        // If Symbol.toStringTag getter throws, Node falls back to '[object Object]'.
        objStr = '[object Object]';
      }
      // Node only shows the [Tag] suffix for an actual Symbol.toStringTag,
      // never derived from objectToString (e.g. `[object Array]` does not
      // produce `[Array]`).
      let actualTag;
      try {
        actualTag = value[Symbol.toStringTag];
      } catch {
        actualTag = undefined;
      }
      // Get constructor name (e.g. 'Foo' for Foo [bar]).
      let ctorName = '';
      if (isNullProto) {
        ctorName = '[Object: null prototype]';
      } else if (!isPlain) {
        const ctor = nodeConstructorName(value);
        if (ctor !== null && ctor.name !== 'Object') {
          ctorName = ctor.name;
        } else {
          // Node's getConstructorName shows `Object <prototype>` when the
          // prototype chain has no determinable constructor.
          const fullName = getConstructorNameWithProto(ctx, value, recurseTimes);
          if (fullName !== null && fullName !== 'Object') {
            ctorName = fullName;
          }
        }
      }
      // Set the tag suffix (only if different from constructor name to avoid
      // duplication, e.g. `Foo [Foo]` -> `Foo`).
      let tagSuffix = '';
      if (typeof actualTag === 'string' && actualTag !== '' && actualTag !== ctorName) {
        tagSuffix = ` [${actualTag}]`;
      }
      // For plain non-null-proto with tag, Node uses 'Object [tag]'.
      if (!ctorName && tagSuffix) {
        ctorName = 'Object';
      }
      tag = ctorName + tagSuffix;
      // If no ctor and no tag, fall back to objectToString.
      if (!tag) tag = objStr;
    }
  }
  }

  const allKeys = getKeys(ctx, value);
  const keys = (isArr || (typeof value === 'object' && value !== null && isBoxedPrimitiveValue(value)))
    ? allKeys.filter((k) => typeof k === 'symbol' || !isCanonicalArrayIndex(String(k)))
    : allKeys;

  // Depth-exhausted: Node still shows constructor name and Symbol.toStringTag.
  // - No keys: 'Foo [ABC] {}'
  // - With keys: '[Foo [ABC]]' (brackets indicate hidden properties)
  if (recurseTimes !== null && recurseTimes < 0) {
    if (isArr) {
      const isNullProtoArr = Object.getPrototypeOf(value) === null;
      // Empty plain arrays stay as [] even when depth is exhausted.
      if (value.length === 0 && !isNullProtoArr) return finish('[]');
      // Empty null-proto arrays: `[Array(0): null prototype] []`.
      if (value.length === 0) {
        return finish(ctx.stylize('[Array(0): null prototype]', 'special') + ' []');
      }
      const ctorName = nodeConstructorName(value)?.name;
      const arrName = (ctorName && ctorName !== 'Array') ? ctorName : 'Array';
      const nullSuffix = isNullProtoArr ? ': null prototype' : '';
      return finish(ctx.stylize(`[${arrName}${nullSuffix}]`, 'special'));
    }
    if (typeof value === 'function') {
      // Node still formats the function base when depth is exhausted
      // (e.g. `[Function (null prototype) (anonymous)]`).
      const fb = getFunctionBase(ctx, value, recurseTimes);
      return finish(fb.base);
    }
    if (value instanceof RegExp) return finish(ctx.stylize(String(value), 'regexp'));
    let ctorName = nodeConstructorName(value)?.name || '';
    // For null-prototype objects, V8 knows the constructor via the native bridge.
    if (!ctorName && Object.getPrototypeOf(value) === null && typeof nativeInspectBridge === 'function') {
      try {
        const nativeOut = nativeInspectBridge(value, { depth: -1, colors: false });
        const m = /^\[([^:\]]+)(?:: null prototype)?\]/.exec(nativeOut);
        if (m) ctorName = m[1];
      } catch { /* ignore */ }
    }
    const tagVal = value[Symbol.toStringTag];
    let prefix = '';
    if (ctorName && ctorName !== 'Object') prefix = ctorName;
    if (typeof tagVal === 'string' && tagVal !== '' && tagVal !== ctorName) {
      prefix = prefix ? `${prefix} [${tagVal}]` : `[${tagVal}]`;
    }
    // For null-prototype, Node shows '[Foo: null prototype]' (with brackets if has
    // props, otherwise '[Foo: null prototype] {}'). The toStringTag comes after.
    const isNullProto = Object.getPrototypeOf(value) === null;
    const hasProps = keys.length > 0 || protoProps.length > 0;
    // Empty objects stay as {} even when depth is exhausted.
    if (!hasProps && !isNullProto && !prefix) return finish('{}');
    if (!prefix && !isNullProto) return finish(ctx.stylize('[Object]', 'special'));
    if (isNullProto) {
      // Base is '[Object: null prototype]' or '[Foo: null prototype]'.
      // The tag [Foo] comes after, not inside.
      const baseName = (ctorName && ctorName !== 'Object') ? ctorName : 'Object';
      const tagPart = (typeof tagVal === 'string' && tagVal !== '' && tagVal !== baseName) ? ` [${tagVal}]` : '';
      if (hasProps) return finish(`[${baseName}: null prototype]${tagPart}`);
      return finish(`[${baseName}: null prototype]${tagPart} {}`);
    }
    if (hasProps) return finish(`[${prefix}]`);
    return finish(`${prefix} {}`);
  }

  // Fold the circular `<ref *N>` marker into the base/braces, mirroring Node's
  // formatObject (which prepends it to the base before reduceToSingleString
  // so it counts toward breakLength). Must be called AFTER properties are
  // formatted: the marker number is assigned when a circular reference is
  // encountered during formatting.
  const withRefMarker = () => {
    const num = ctx.circularNums.get(value);
    if (num === undefined) return [tag, braces];
    const ref = ctx.stylize(`<ref *${num}>`, 'special');
    if (ctx.options.compact === true) {
      return [tag, [`${ref} ${braces[0]}`, braces[1]]];
    }
    return [tag === '' ? ref : `${ref} ${tag}`, braces];
  };
  // Cleanup for this path (the ref marker is folded in via withRefMarker(),
  // unlike finish() which appends it afterwards).
  const finalize = (s) => {
    ctx.seen.pop();
    if (ctx.seenMap) ctx.seenMap.delete(value);
    if (depthCounted) ctx.depthLevel--;
    return s;
  };

  if (keys.length === 0 && protoProps.length === 0 && (!isArr || value.length === 0)) {
    if (!bracesAlways) return finalize(withRefMarker()[0]);
    const [et, eb] = withRefMarker();
    return finalize(reduceToSingleString(ctx, [], et, eb, level));
  }

  // Name for the stack-overflow interruption message. Computed here (healthy
  // stack): compiling a RegExp inside the catch handler would itself throw
  // when the stack is exhausted. Mirror's Node's getCtxStyle constructor name.
  let interruptName;
  if (isArr) {
    // braces[0] is '[' or 'Foobar(5) [' for Array subclasses.
    const paren = braces[0].indexOf('(');
    interruptName = paren === -1 ? 'Array' : braces[0].slice(0, paren);
  } else {
    interruptName = tag.startsWith('[') ? tag : (tag || 'Object');
  }

  // Mirror Node's formatObject: guard the recursive property gathering so a
  // stack overflow becomes `[Ctor: Inspection interrupted prematurely.
  // Maximum call stack size exceeded.]` instead of a thrown RangeError.
  const savedIndentationLvl = ctx.indentationLvl || 0;
  let output;
  try {
    let sortStart = 0;
    if (isArr) {
      output = formatArrayEntries(ctx, value, recurseTimes, keys);
      // Extras start after the indices; keys.length extras were appended.
      sortStart = output.length - keys.length;
    } else {
      output = new Array(keys.length);
      // Fast path for simple data properties: format the value directly
      // without a formatProperty stack frame. This halves the stack usage
      // per nesting level, letting deep structures format deeper before
      // Node's stack-overflow interruption kicks in (mirrors Node's
      // deeper native recursion). Only applies when the full
      // formatProperty logic would be a no-op: string identifier key,
      // data descriptor, default compact (no indentation tracking),
      // no showHidden brackets, no getter evaluation.
      const useFastPath = ctx.options.compact !== true &&
        !ctx.options.showHidden && !ctx.options.getters;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (useFastPath && typeof key === 'string' &&
            /^[a-zA-Z_$][a-zA-Z_$0-9]*$/.test(key)) {
          let desc;
          try {
            desc = Object.getOwnPropertyDescriptor(value, key);
          } catch { desc = undefined; }
          if (desc && 'value' in desc) {
            output[i] = `${ctx.stylize(key, 'name')}: ` +
              formatValue(ctx, desc.value,
                recurseTimes === null ? null : recurseTimes - 1);
            continue;
          }
        }
        output[i] = formatProperty(ctx, value, recurseTimes, key, false);
      }
    }
    for (const p of protoProps) output.push(p);
    // Node sorts the formatted output strings when `sorted` is set
    // (not the keys). For arrays only the non-index extras are sorted;
    // indices stay in order.
    const sortedOpt = ctx.options.sorted;
    if (sortedOpt) {
      const comparator = sortedOpt === true || sortedOpt === 'asc'
        ? undefined
        : sortedOpt === 'desc'
          ? (a, b) => (a < b ? 1 : a > b ? -1 : 0)
          : sortedOpt;
      if (isArr) {
        if (output.length - sortStart > 1) {
          const extras = output.slice(sortStart).sort(comparator);
          output.splice(sortStart, output.length - sortStart, ...extras);
        }
      } else {
        output.sort(comparator);
      }
    }
  } catch (err) {
    if (!isStackOverflowError(err)) throw err;
    // Mirror Node's handleMaxCallStackSize: drop this frame's seen entry,
    // restore the indentation level (bumps from formatProperty never
    // unwound), and substitute the interruption message. (Deeper frames
    // never unwound; like Node, their seen entries stay — nothing further
    // is formatted beneath this point.)
    ctx.indentationLvl = savedIndentationLvl;
    ctx.seen.pop();
    if (ctx.seenMap) ctx.seenMap.delete(value);
    if (depthCounted) ctx.depthLevel--;
    return ctx.stylize(
      `[${interruptName}: Inspection interrupted prematurely. Maximum call stack size exceeded.]`,
      'special');
  }
  const [effTag, effBraces] = withRefMarker();
  return finalize(reduceToSingleString(ctx, output, effTag, effBraces, level));
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
  if (arguments.length >= 3 && arguments[2] !== undefined) options.depth = arguments[2];
  if (arguments.length >= 4) options.colors = !!arguments[3];
  const ctx = makeCtx(options);
  const depth = options.depth === undefined ? 2 : options.depth;
  return formatValue(ctx, object, depth === null ? null : depth, 0);
}

/** @param {InspectOptions|boolean|undefined} opts */
function normalizeInspectOptions(opts) {
  /** @type {InspectOptions} */
  const options = { ...inspect.defaultOptions };
  if (typeof opts === 'boolean') options.showHidden = opts;
  else if (opts) Object.assign(options, opts);
  if (options.depth === null) options.depth = null;
  // Node quirk: explicitly passing { depth: undefined } means infinite depth,
  // while omitting it uses the default (2).
  if (opts && typeof opts === 'object' && 'depth' in opts && opts.depth === undefined) {
    options.depth = null;
  }
  return options;
}

inspect.custom = Symbol.for('nodejs.util.inspect.custom');
inspect.colors = inspectColors;
inspect.styles = inspectStyles;
let _defaultOptions = {
  showHidden: false,
  depth: 2,
  colors: false,
  customInspect: true,
  showProxy: false,
  maxArrayLength: 100,
  maxStringLength: 10000,
  breakLength: 80,
  compact: 3,
  sorted: false,
  getters: false,
  numericSeparator: false,
};

Object.defineProperty(inspect, 'defaultOptions', {
  get() { return _defaultOptions; },
  set(value) {
    if (value === null || typeof value !== 'object') {
      throw ERR_INVALID_ARG_TYPE('options', 'object', value);
    }
    _defaultOptions = value;
  },
  enumerable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// format / formatWithOptions
// ---------------------------------------------------------------------------

/**
 * Matches node's formatNumberNoColor (lib/internal/util/inspect.js): -0
 * renders as '-0', and numericSeparator inserts '_' groups when enabled.
 */
function formatNumberPlain(number, inspectOptions) {
  if (Object.is(number, -0)) return '-0';
  const numericSeparator = inspectOptions?.numericSeparator ?? inspect.defaultOptions.numericSeparator;
  if (!numericSeparator) return `${number}`;
  const numberString = String(number);
  const integer = Math.trunc(number);
  if (integer === number) {
    if (!Number.isFinite(number) || numberString.includes('e')) return numberString;
    return addNumericSeparator(numberString);
  }
  if (Number.isNaN(number) || numberString.includes('e')) return numberString;
  const decimalIndex = numberString.indexOf('.');
  const integerPart = numberString.slice(0, decimalIndex);
  const fractionalPart = numberString.slice(decimalIndex + 1);
  return `${addNumericSeparator(integerPart)}.${addNumericSeparatorEnd(fractionalPart)}`;
}

function formatBigIntPlain(bigint, inspectOptions) {
  const string = String(bigint);
  const numericSeparator = inspectOptions?.numericSeparator ?? inspect.defaultOptions.numericSeparator;
  if (!numericSeparator) return `${string}n`;
  return `${addNumericSeparator(string)}n`;
}

function tryStringify(arg) {
  try {
    return JSON.stringify(arg);
  } catch (err) {
    if (err && err.name === 'TypeError' && /circular/i.test(err.message)) {
      return '[Circular]';
    }
    throw err;
  }
}

/**
 * Prevents triggering proxy traps; mirrors node's hasBuiltInToString
 * (lib/internal/util/inspect.js). Proxies are treated as having the builtin
 * toString so format('%s', proxy) inspects them trap-free via the proxy
 * delegation in inspect().
 */
// Set of built-in constructor names (for hasBuiltInToString).
const builtInObjects = new Set(
  Object.getOwnPropertyNames(globalThis).filter((e) => /^[A-Z][a-zA-Z0-9]+$/.test(e))
);

function hasBuiltInToString(value) {
  if (nativeTypesBridge && nativeTypesBridge.isProxy(value)) return true;
  let hasOwnToString = hasOwn;
  let hasOwnToPrimitive = hasOwn;
  const returnFalse = () => false;

  if (typeof value.toString !== 'function') {
    if (typeof value[Symbol.toPrimitive] !== 'function') {
      return true;
    } else if (hasOwn(value, Symbol.toPrimitive)) {
      return false;
    }
    hasOwnToString = returnFalse;
  } else if (hasOwn(value, 'toString')) {
    return false;
  } else if (typeof value[Symbol.toPrimitive] !== 'function') {
    hasOwnToPrimitive = returnFalse;
  } else if (hasOwn(value, Symbol.toPrimitive)) {
    return false;
  }

  // Find the object that has the `toString` property or `Symbol.toPrimitive`
  // property as own property in the prototype chain.
  let pointer = value;
  do {
    pointer = PrimordialObjectGetPrototypeOf(pointer);
  } while (pointer !== null &&
           !hasOwnToString(pointer, 'toString') &&
           !hasOwnToPrimitive(pointer, Symbol.toPrimitive));

  if (pointer === null) return true;

  // Check if the object is a built-in.
  const descriptor = PrimordialObjectGetOwnPropertyDescriptor(pointer, 'constructor');
  return descriptor !== undefined &&
    typeof descriptor.value === 'function' &&
    builtInObjects.has(descriptor.value.name);
}

/**
 * Faithful port of node's formatWithOptionsInternal (lib/internal/util/inspect.js).
 */
/**
 * Faithful port of node's formatWithOptionsInternal (lib/internal/util/inspect.js, v24.20.0).
 */
function formatWithOptionsInternal(inspectOptions, args) {
  const first = args[0];
  let a = 0;
  let str = '';
  let join = '';

  if (typeof first === 'string') {
    if (args.length === 1) {
      return first;
    }
    let tempStr;
    let lastPos = 0;

    for (let i = 0; i < first.length - 1; i++) {
      if (first.charCodeAt(i) === 37) { // '%'
        const nextChar = first.charCodeAt(++i);
        if (a + 1 !== args.length) {
          switch (nextChar) {
            case 115: { // 's'
              const tempArg = args[++a];
              if (typeof tempArg === 'number') {
                tempStr = formatNumberPlain(tempArg, inspectOptions);
              } else if (typeof tempArg === 'bigint') {
                tempStr = formatBigIntPlain(tempArg, inspectOptions);
              } else if (typeof tempArg !== 'object' ||
                         tempArg === null ||
                         !hasBuiltInToString(tempArg)) {
                tempStr = String(tempArg);
              } else {
                tempStr = inspect(tempArg, {
                  ...inspectOptions,
                  compact: 3,
                  colors: false,
                  depth: 0,
                });
              }
              break;
            }
            case 106: // 'j'
              tempStr = tryStringify(args[++a]);
              break;
            case 100: { // 'd'
              const tempNum = args[++a];
              if (typeof tempNum === 'bigint') {
                tempStr = formatBigIntPlain(tempNum, inspectOptions);
              } else if (typeof tempNum === 'symbol') {
                tempStr = 'NaN';
              } else {
                tempStr = formatNumberPlain(Number(tempNum), inspectOptions);
              }
              break;
            }
            case 79: // 'O'
              tempStr = inspect(args[++a], inspectOptions);
              break;
            case 111: // 'o'
              tempStr = inspect(args[++a], {
                ...inspectOptions,
                showHidden: true,
                showProxy: true,
                depth: 4,
              });
              break;
            case 105: { // 'i'
              const tempInteger = args[++a];
              if (typeof tempInteger === 'bigint') {
                tempStr = formatBigIntPlain(tempInteger, inspectOptions);
              } else if (typeof tempInteger === 'symbol') {
                tempStr = 'NaN';
              } else {
                tempStr = formatNumberPlain(
                  parseInt(tempInteger), inspectOptions);
              }
              break;
            }
            case 102: { // 'f'
              const tempFloat = args[++a];
              if (typeof tempFloat === 'symbol') {
                tempStr = 'NaN';
              } else {
                tempStr = formatNumberPlain(
                  parseFloat(tempFloat), inspectOptions);
              }
              break;
            }
            case 99: // 'c'
              a += 1;
              tempStr = '';
              break;
            case 37: // '%'
              str += first.slice(lastPos, i);
              lastPos = i + 1;
              continue;
            default: // Any other character is not a correct placeholder
              continue;
          }
          if (lastPos !== i - 1) {
            str += first.slice(lastPos, i - 1);
          }
          str += tempStr;
          lastPos = i + 1;
        } else if (nextChar === 37) {
          str += first.slice(lastPos, i);
          lastPos = i + 1;
        }
      }
    }
    if (lastPos !== 0) {
      a++;
      join = ' ';
      if (lastPos < first.length) {
        str += first.slice(lastPos);
      }
    }
  }

  while (a < args.length) {
    const value = args[a];
    str += join;
    str += typeof value !== 'string' ? inspect(value, inspectOptions) : value;
    join = ' ';
    a++;
  }
  return str;
}

/**
 * Formats a string using printf-like placeholders (%s %d %i %f %j %o %O %c %%).
 * Mirrors Node's util.format exactly.
 * @param {any} f
 * @param {...any} args
 * @returns {string}
 */
export function format(f, ...args) {
  if (arguments.length === 0) return '';
  return formatWithOptionsInternal(undefined, [f, ...args]);
}

/**
 * Same as {@link format} but forwards `inspectOptions` to the internal
 * `inspect()` calls. Mirrors Node's util.formatWithOptions exactly.
 * @param {InspectOptions|undefined} inspectOptions
 * @param {any} f
 * @param {...any} args
 * @returns {string}
 */
export function formatWithOptions(inspectOptions, f, ...args) {
  validateObject(inspectOptions, 'inspectOptions');
  if (arguments.length === 1) return '';
  return formatWithOptionsInternal(inspectOptions, [f, ...args]);
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
    const isReadableStream = stream !== null && typeof stream === 'object' &&
      typeof stream.getReader === 'function';
    const isWritableStream = stream !== null && typeof stream === 'object' &&
      typeof stream.getWriter === 'function';
    const isNodeStream = stream !== null &&
      (typeof stream === 'object' || typeof stream === 'function') &&
      typeof stream.pipe === 'function';
    if (!isReadableStream && !isWritableStream && !isNodeStream) {
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
const codesWarned = new PrimordialSet();

/**
 * Mirrors node's getDeprecationWarningEmitter (lib/internal/util.js).
 */
function getDeprecationWarningEmitter(code, msg, deprecated) {
  let warned = false;
  return function() {
    if (!warned) {
      warned = true;
      if (code === 'ExperimentalWarning') {
        process.emitWarning(msg, code, deprecated);
      } else if (code !== undefined) {
        if (!codesWarned.has(code)) {
          process.emitWarning(msg, 'DeprecationWarning', code, deprecated);
          codesWarned.add(code);
        }
      } else {
        process.emitWarning(msg, 'DeprecationWarning', deprecated);
      }
    }
  };
}

/**
 * Internal deprecate implementation, mirroring node's lib/internal/util.js.
 * @param {Function} fn
 * @param {string|undefined} msg
 * @param {string|undefined} code
 * @param {boolean} [modifyPrototype]
 */
function internalDeprecate(fn, msg, code, modifyPrototype = true) {
  if (code !== undefined) {
    validateString(code, 'code');
  }

  const emitDeprecationWarning = getDeprecationWarningEmitter(code, msg, deprecated);

  // use `function` instead of arrow to properly support `new` calls
  function deprecated(...args) {
    if (!process.noDeprecation) {
      emitDeprecationWarning();
    }
    if (new.target) {
      return PrimordialReflectConstruct(fn, args, new.target);
    }
    return PrimordialFunctionPrototypeApply(fn, this, args);
  }

  if (modifyPrototype) {
    // The wrapper will keep the same prototype as fn to maintain prototype chain.
    PrimordialObjectSetPrototypeOf(deprecated, fn);
    if (fn.prototype) {
      // Setting this ensures that calling the unwrapped constructor gives an
      // instanceof the wrapped constructor.
      deprecated.prototype = fn.prototype;
    }

    PrimordialObjectDefineProperty(deprecated, 'length', {
      __proto__: null,
      ...PrimordialObjectGetOwnPropertyDescriptor(fn, 'length'),
    });
  }

  return deprecated;
}

/**
 * Marks a function as deprecated. Mirrors Node's util.deprecate exactly.
 * @param {Function} fn
 * @param {string} [msg]
 * @param {string} [code]
 * @param {{ modifyPrototype?: boolean }} [options]
 * @returns {Function}
 */
export function deprecate(fn, msg, code, { modifyPrototype } = {}) {
  validateFunction(fn, 'fn');
  if (msg !== undefined) {
    validateString(msg, 'msg');
  }
  return internalDeprecate(fn, msg, code, modifyPrototype);
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

const kCustomPromisifiedSymbol = Symbol.for('nodejs.util.promisify.custom');
const kCustomPromisifyArgsSymbol = Symbol.for('nodejs.util.promisify.customArgs');

/**
 * Takes a function following the common error-first callback style
 * (fn(...args, cb)) and returns a promise-returning version.
 * Mirrors node's lib/internal/util.js promisify exactly.
 * @template T
 * @param {(...args: any[]) => any} original
 * @returns {(...args: any[]) => Promise<T>}
 */
export function promisify(original) {
  if (typeof original !== 'function') {
    throw ERR_INVALID_ARG_TYPE('original', 'Function', original);
  }

  if (original[kCustomPromisifiedSymbol]) {
    const fn = original[kCustomPromisifiedSymbol];

    if (typeof fn !== 'function') {
      throw ERR_INVALID_ARG_TYPE('util.promisify.custom', 'Function', fn);
    }

    PrimordialObjectDefineProperty(fn, kCustomPromisifiedSymbol, {
      __proto__: null,
      value: fn,
      enumerable: false,
      writable: false,
      configurable: true,
    });
    return fn;
  }

  // Names to create an object from in case the callback receives multiple
  // arguments, e.g. ['bytesRead', 'buffer'] for fs.read.
  // Also supports the legacy internal customPromisifyArgs symbol.
  const legacySymbol = typeof Symbol === 'function'
    ? PrimordialObjectGetOwnPropertySymbols(original).find(
        (s) => typeof s === 'symbol' && s.description === 'customPromisifyArgs')
    : undefined;
  const argumentNames = original[kCustomPromisifyArgsSymbol] ??
    (legacySymbol ? original[legacySymbol] : undefined);

  // Create a new function that will just call `original`.
  /** @this {any} */
  function fn(...args) {
    return new Promise((resolve, reject) => {
      PrimordialArrayPrototypePush(args, (err, ...values) => {
        if (err) {
          return reject(err);
        }
        if (argumentNames !== undefined && values.length > 1) {
          const obj = {};
          for (let i = 0; i < argumentNames.length; i++)
            obj[argumentNames[i]] = values[i];
          resolve(obj);
        } else {
          resolve(values[0]);
        }
      });
      const promise = PrimordialFunctionPrototypeApply(original, this, args);
      // Warn if the original function returns a Promise (likely a mistake).
      // Node calls process.emitWarning here, which delivers the 'warning'
      // event via process.nextTick (ahead of promise continuations). Under
      // --import (used by this repo's parity harness), Node drains the
      // nextTick queue after promise microtasks, so a process.emitWarning
      // call would deliver the event after the promisified promise settles
      // (breaking the expected warning ordering). Emit the 'warning' event
      // synchronously instead: Node's default warning printer is itself a
      // 'warning' listener, so stderr output and --no-deprecation handling
      // are preserved, and listeners observe the warning before promise
      // continuations, matching Node's delivery order.
      if (promise !== null && typeof promise === 'object' && typeof promise.then === 'function' &&
          typeof process !== 'undefined') {
        const warning = new Error(
          'Calling promisify on a function that returns a Promise is likely a mistake.');
        warning.name = 'DeprecationWarning';
        warning.code = 'DEP0174';
        if (typeof process.emit === 'function') {
          process.emit('warning', warning);
        } else if (typeof process.emitWarning === 'function') {
          process.emitWarning(warning.message, warning.name, warning.code);
        }
      }
    });
  }

  PrimordialObjectSetPrototypeOf(fn, PrimordialObjectGetPrototypeOf(original));

  PrimordialObjectDefineProperty(fn, kCustomPromisifiedSymbol, {
    __proto__: null,
    value: fn,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return PrimordialObjectDefineProperties(fn, PrimordialObjectGetOwnPropertyDescriptors(original));
}

promisify.custom = kCustomPromisifiedSymbol;

/**
 * Handles `util.promisify.customArgs` (and the legacy internal
 * `customPromisifyArgs` symbol) for multi-value callbacks.
 */
function getCustomPromisifyArgs(original, values) {
  // The legacy internal symbol is keyed by description; find it without a
  // hard dependency on internal modules.
  const legacySymbol = typeof Symbol === 'function'
    ? PrimordialObjectGetOwnPropertySymbols(original).find(
        (s) => typeof s === 'symbol' && s.description === 'customPromisifyArgs')
    : undefined;
  const customArgs = original[kCustomPromisifyArgsSymbol] ??
    (legacySymbol ? original[legacySymbol] : undefined);
  if (customArgs !== undefined) {
    values = PrimordialArrayPrototypeMap(customArgs, (arg, i) => values[i]);
  }
  return values;
}

/**
 * Error used when a callbackified promise rejects with a falsy value.
 * Mirrors node's ERR_FALSY_VALUE_REJECTION.
 */
class FalsyValueRejectionError extends Error {
  constructor(reason) {
    super('Promise was rejected with falsy value');
    this.code = 'ERR_FALSY_VALUE_REJECTION';
    this.reason = reason;
  }
}

/** @param {any} reason @param {(err:any)=>void} cb */
function callbackifyOnRejected(reason, cb) {
  if (!reason) {
    reason = new FalsyValueRejectionError(reason);
    // Hide the internal frame, matching node's captureStackTrace behavior.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(reason, callbackifyOnRejected);
    }
  }
  return cb(reason);
}

/**
 * Converts a promise-returning function into an error-first callback style one.
 * Mirrors node's lib/internal/util.js callbackify exactly.
 * @param {(...args: any[]) => Promise<any>} original
 * @returns {(...args: [...any[], (err:any, val?:any)=>void]) => void}
 */
export function callbackify(original) {
  if (typeof original !== 'function') {
    throw ERR_INVALID_ARG_TYPE('original', 'Function', original);
  }

  // We DO NOT return the promise as it gives the user a false sense that
  // the promise is actually somehow related to the callback's execution
  // and that the callback did not execute correctly.
  function callbackified(...args) {
    const maybeCb = PrimordialArrayPrototypePop(args);
    if (typeof maybeCb !== 'function') {
      throw ERR_INVALID_ARG_TYPE('last argument', 'Function', maybeCb);
    }
    const self = this;
    // In true node.js fashion, the callback will always be invoked
    // asynchronously, even for immediate values.
    const cb = (...args) => {
      PrimordialReflectApply(maybeCb, self, args);
    };
    // In order to make sure that no unhandled rejection is created, we
    // attach the callbacks using the promise's `then` method.
    PrimordialFunctionPrototypeApply(original, this, args).then(
      (ret) => process.nextTick(cb, null, ret),
      (rej) => process.nextTick(callbackifyOnRejected, rej, cb),
    );
  }

  const descriptors = PrimordialObjectGetOwnPropertyDescriptors(original);
  if (typeof descriptors.length.value === 'number') {
    descriptors.length.value++;
  }
  if (typeof descriptors.name.value === 'string') {
    descriptors.name.value += 'Callbackified';
  }
  PrimordialObjectDefineProperties(callbackified, descriptors);
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

  // boxed primitives: same brand and same unboxed value (Object.is for
  // numbers to preserve -0/NaN, identity for symbols), then fall through to
  // key comparison so extra own properties are still checked.
  if (isBoxedPrimitiveValue(a) || isBoxedPrimitiveValue(b)) {
    if (!isBoxedPrimitiveValue(a) || !isBoxedPrimitiveValue(b)) return false;
    const brandA = types.isNumberObject(a) ? 'number' :
      types.isStringObject(a) ? 'string' :
      types.isBooleanObject(a) ? 'boolean' :
      types.isBigIntObject(a) ? 'bigint' : 'symbol';
    const brandB = types.isNumberObject(b) ? 'number' :
      types.isStringObject(b) ? 'string' :
      types.isBooleanObject(b) ? 'boolean' :
      types.isBigIntObject(b) ? 'bigint' : 'symbol';
    if (brandA !== brandB) return false;
    const va = a.valueOf();
    const vb = b.valueOf();
    if (brandA === 'number') {
      if (!Object.is(va, vb)) return false;
    } else if (va !== vb) {
      return false;
    }
    // Fall through to key comparison below.
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
    // Compare by Symbol.toStringTag (Buffer's tag is 'Uint8Array'), not by
    // constructor, so skipPrototype can still match Buffer vs Uint8Array.
    if (a[Symbol.toStringTag] !== b[Symbol.toStringTag]) return false;
    const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (ua.length !== ub.length) return false;
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    // Fall through to key comparison for extra own properties.
  } else if (types.isAnyArrayBuffer(a) || types.isAnyArrayBuffer(b)) {
    if (!(types.isAnyArrayBuffer(a) && types.isAnyArrayBuffer(b))) return false;
    if (a.byteLength !== b.byteLength) return false;
    const ua = new Uint8Array(a), ub = new Uint8Array(b);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    // Fall through to key comparison for extra own properties.
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

  const aKeys = PrimordialObjectKeys(a);
  const bKeys = PrimordialObjectKeys(b);
  // In strict mode, enumerable symbol keys are also compared.
  const aSymbols = PrimordialObjectGetOwnPropertySymbols(a).filter((s) =>
    PrimordialObjectPrototypeHasOwnProperty(a, s) &&
    PrimordialObjectGetOwnPropertyDescriptor(a, s).enumerable);
  const bSymbols = PrimordialObjectGetOwnPropertySymbols(b).filter((s) =>
    PrimordialObjectPrototypeHasOwnProperty(b, s) &&
    PrimordialObjectGetOwnPropertyDescriptor(b, s).enumerable);
  if (aKeys.length !== bKeys.length || aSymbols.length !== bSymbols.length) return false;
  for (const k of aKeys) {
    if (!hasOwn(b, k)) return false;
    if (!deepEqualInner(a[k], b[k], seen, skipPrototype)) return false;
  }
  for (const s of aSymbols) {
    if (!bSymbols.includes(s)) return false;
    if (!deepEqualInner(a[s], b[s], seen, skipPrototype)) return false;
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

  // Handle windows newlines "\r\n": remove "\r" and keep only "\n"
  let lines = content.replace(/\r/g, '');

  const trimSpaces = (s) => {
    const start = s.search(/[^ \t\n]/);
    if (start === -1) return '';
    const end = s.search(/[^ \t\n](?=[ \t\n]*$)/);
    return s.slice(start, end + 1);
  };

  let text = trimSpaces(lines);

  while (text.length > 0) {
    // Skip empty lines and comments
    if (text[0] === '\n' || text[0] === '#') {
      const newline = text.indexOf('\n');
      if (newline !== -1) {
        text = text.slice(newline + 1);
      } else {
        text = '';
      }
      continue;
    }

    // Find the next equals sign or newline in a single pass.
    let equalOrNewline = -1;
    let foundChar = '';
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '=' || text[i] === '\n') {
        equalOrNewline = i;
        foundChar = text[i];
        break;
      }
    }

    // If we found nothing or found a newline before equals, the line is invalid
    if (equalOrNewline === -1 || foundChar === '\n') {
      if (equalOrNewline !== -1) {
        text = trimSpaces(text.slice(equalOrNewline + 1));
        continue;
      }
      break;
    }

    // We found an equals sign, extract the key
    let key = text.slice(0, equalOrNewline);
    text = text.slice(equalOrNewline + 1);
    key = trimSpaces(key);

    // If the value is not present (e.g. KEY=) set it to an empty string
    if (text.length === 0 || text[0] === '\n') {
      result[key] = '';
      continue;
    }

    text = trimSpaces(text);

    // Skip lines with empty keys after trimming spaces.
    if (key.length === 0) continue;

    // Remove export prefix from key and ensure proper spacing.
    if (key.startsWith('export ')) {
      key = trimSpaces(key.slice(7));
    }

    if (text.length === 0) {
      // In case the last line is a single key without value
      result[key] = '';
      break;
    }

    // Expand new line if \n it's inside double quotes
    if (text[0] === '"') {
      const closingQuote = text.indexOf('"', 1);
      if (closingQuote !== -1) {
        const value = text.slice(1, closingQuote);
        // Replace \n with actual newlines in double-quoted strings
        const multiLineValue = value.replace(/\\n/g, '\n');
        result[key] = multiLineValue;
        const newline = text.indexOf('\n', closingQuote + 1);
        if (newline !== -1) {
          text = text.slice(newline + 1);
        } else {
          text = '';
        }
        continue;
      }
    }

    // Handle quoted values (single quotes, double quotes, backticks)
    if (text[0] === "'" || text[0] === '"' || text[0] === '`') {
      const quote = text[0];
      const closingQuote = text.indexOf(quote, 1);

      if (closingQuote === -1) {
        // Check if newline exists. If it does, take the entire line as the value
        const newline = text.indexOf('\n');
        if (newline !== -1) {
          result[key] = text.slice(0, newline);
          text = text.slice(newline + 1);
        } else {
          // No newline - take rest of content
          result[key] = text;
          break;
        }
      } else {
        // Found closing quote - take content between quotes
        result[key] = text.slice(1, closingQuote);
        const newline = text.indexOf('\n', closingQuote + 1);
        if (newline !== -1) {
          text = text.slice(newline + 1);
        } else {
          text = '';
        }
        continue;
      }
    } else {
      // Regular key value pair.
      const newline = text.indexOf('\n');
      let value;
      if (newline !== -1) {
        value = text.slice(0, newline);
        const hashChar = value.indexOf('#');
        // Check if there is a comment in the line
        if (hashChar !== -1) {
          value = value.slice(0, hashChar);
        }
        value = trimSpaces(value);
        result[key] = value;
        text = text.slice(newline + 1);
      } else {
        // Last line without newline
        value = text;
        const hashChar = value.indexOf('#');
        if (hashChar !== -1) {
          value = value.slice(0, hashChar);
        }
        result[key] = trimSpaces(value);
        text = '';
      }
    }
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
// diff — ported from Node v24.20.0 `lib/internal/util/diff.js` and
// `lib/internal/assert/myers_diff.js` (myersDiff/backtrack only; the
// print*MyersDiff formatters are assert-internal and not part of this
// surface). `checkCommaDisparity` is omitted: `util.diff` never enables it.
// ---------------------------------------------------------------------------

const kDiffDelete = -1; // entry present only in `expected`
const kDiffNop = 0;     // entry present in both inputs
const kDiffInsert = 1;  // entry present only in `actual`

function myersDiffBacktrack(trace, actual, expected) {
  const actualLength = actual.length;
  const expectedLength = expected.length;
  const max = actualLength + expectedLength;

  let x = actualLength;
  let y = expectedLength;
  const result = [];

  for (let diffLevel = trace.length - 1; diffLevel >= 0; diffLevel--) {
    const v = trace[diffLevel];
    const diagonalIndex = x - y;
    const offset = diagonalIndex + max;

    let prevDiagonalIndex;
    if (
      diagonalIndex === -diffLevel ||
      (diagonalIndex !== diffLevel && v[offset - 1] < v[offset + 1])
    ) {
      prevDiagonalIndex = diagonalIndex + 1;
    } else {
      prevDiagonalIndex = diagonalIndex - 1;
    }

    const prevX = v[prevDiagonalIndex + max];
    const prevY = prevX - prevDiagonalIndex;

    while (x > prevX && y > prevY) {
      result.push([kDiffNop, actual[x - 1]]);
      x--;
      y--;
    }

    if (diffLevel > 0) {
      if (x > prevX) {
        result.push([kDiffInsert, actual[--x]]);
      } else {
        result.push([kDiffDelete, expected[--y]]);
      }
    }
  }

  return result;
}

function myersDiff(actual, expected) {
  const actualLength = actual.length;
  const expectedLength = expected.length;
  const max = actualLength + expectedLength;

  if (max > 2 ** 31 - 1) {
    throw ERR_OUT_OF_RANGE('myersDiff input size', '< 2^31', max);
  }

  const v = new Int32Array(2 * max + 1);
  const trace = [];

  for (let diffLevel = 0; diffLevel <= max; diffLevel++) {
    trace.push(new Int32Array(v)); // Clone the current state of `v`

    for (let diagonalIndex = -diffLevel; diagonalIndex <= diffLevel; diagonalIndex += 2) {
      const offset = diagonalIndex + max;
      const previousOffset = v[offset - 1];
      const nextOffset = v[offset + 1];
      let x = diagonalIndex === -diffLevel ||
        (diagonalIndex !== diffLevel && previousOffset < nextOffset) ?
        nextOffset :
        previousOffset + 1;
      let y = x - diagonalIndex;

      while (
        x < actualLength &&
        y < expectedLength &&
        actual[x] === expected[y]
      ) {
        x++;
        y++;
      }

      v[offset] = x;

      if (x >= actualLength && y >= expectedLength) {
        return myersDiffBacktrack(trace, actual, expected);
      }
    }
  }
}

function validateDiffInput(value, name) {
  if (!Array.isArray(value)) {
    validateString(value, name);
    return;
  }
  for (let i = 0; i < value.length; i++) {
    // Don't use validateString here for performance reasons, as we would
    // generate intermediate strings for the name (mirrors Node).
    if (typeof value[i] !== 'string') {
      throw ERR_INVALID_ARG_TYPE(`${name}[${i}]`, 'string', value[i]);
    }
  }
}

/**
 * Generate a difference report between two values.
 * @param {Array | string} actual - The first value to compare
 * @param {Array | string} expected - The second value to compare
 * @returns {Array} An array of `[operation, value]` pairs where operation is
 * `-1` (present only in `expected`), `0` (present in both), or `1`
 * (present only in `actual`).
 */
export function diff(actual, expected) {
  if (actual === expected) {
    return [];
  }

  validateDiffInput(actual, 'actual');
  validateDiffInput(expected, 'expected');

  // NB: Node calls the generic Array.prototype.reverse on the myers result
  // rather than a method call, so the `diff([], [])` edge case throws the
  // exact same `TypeError: Cannot convert undefined or null to object`
  // (myersDiff returns undefined there) instead of a different TypeError.
  return Array.prototype.reverse.call(myersDiff(actual, expected));
}

/**
 * Port of Node's `internal/util/trace_sigint.js`. In Node this starts/stops
 * the SIGINT watchdog that prints a stack trace on Ctrl+C (main thread only;
 * throws `ERR_WORKER_UNSUPPORTED_OPERATION` in workers). Browsers have no
 * SIGINT, so this is an honest noop — like Node it validates nothing and
 * returns `undefined`.
 * @param {unknown} enabled
 */
export function setTraceSigInt(enabled) {
  void enabled;
  // No SIGINT in browsers: noop (Jared's rule: noop over throw).
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
// getCallSites
// ---------------------------------------------------------------------------

/**
 * VLQ decoder for source maps (base64 values).
 */
const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const base64Map = {};
for (let i = 0; i < base64Chars.length; i++) base64Map[base64Chars[i]] = i;

/**
 * Decodes a VLQ value from a mappings string.
 * @returns {[number, number]} [value, nextIndex]
 */
function decodeVLQ(str, index) {
  let result = 0;
  let shift = 0;
  let digit;
  do {
    digit = base64Map[str[index++]];
    result |= (digit & 31) << shift;
    shift += 5;
  } while (digit & 32);
  const negative = result & 1;
  result >>= 1;
  return [negative ? -result : result, index];
}

/**
 * Minimal source-map consumer for getCallSites remapping.
 * @param {string} mapText
 */
function parseSourceMap(mapText) {
  const map = JSON.parse(mapText);
  if (map.version !== 3 || typeof map.mappings !== 'string') return null;
  return map;
}

/**
 * Finds the original position for a generated (line, column).
 * Uses greatest-lower-bound on the mappings.
 */
function remapPosition(map, genLine, genColumn) {
  const lines = map.mappings.split(';');
  if (genLine - 1 >= lines.length) return null;
  const segments = lines[genLine - 1].split(',');
  let genCol = 0;
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  let best = null;
  for (const seg of segments) {
    if (!seg) continue;
    let idx = 0;
    let v;
    [v, idx] = decodeVLQ(seg, idx);
    genCol += v;
    if (idx >= seg.length) continue;
    [v, idx] = decodeVLQ(seg, idx);
    srcIdx += v;
    [v, idx] = decodeVLQ(seg, idx);
    srcLine += v;
    [v, idx] = decodeVLQ(seg, idx);
    srcCol += v;
    if (genCol <= genColumn) {
      best = { source: map.sources[srcIdx], line: srcLine, column: srcCol };
    } else {
      break;
    }
  }
  return best;
}

/**
 * Attempts to remap a call site using an inline or external source map.
 * Only works in Node (needs fs). Returns null if no map applies.
 */
function tryRemapCallSite(scriptName, lineNumber, columnNumber) {
  try {
    if (typeof process === 'undefined' || !scriptName || scriptName.startsWith('node:')) {
      return null;
    }
    // Load fs lazily to keep the module browser-safe.
    let fs;
    try {
      fs = require('node:fs');
    } catch {
      return null;
    }
    let fileContent;
    try {
      fileContent = fs.readFileSync(scriptName, 'utf8');
    } catch {
      return null;
    }
    const match = fileContent.match(/\/\/# sourceMappingURL=(\S+)\s*$/m);
    if (!match) return null;
    const url = match[1];
    let mapText;
    if (url.startsWith('data:')) {
      const base64 = url.split(',')[1];
      mapText = Buffer.from(base64, 'base64').toString('utf8');
    } else {
      const path = require('node:path');
      const mapPath = path.resolve(path.dirname(scriptName), url);
      try {
        mapText = fs.readFileSync(mapPath, 'utf8');
      } catch {
        return null;
      }
    }
    const map = parseSourceMap(mapText);
    if (!map) return null;
    const remapped = remapPosition(map, lineNumber, columnNumber - 1);
    if (!remapped) return null;
    const path = require('node:path');
    return {
      scriptName: path.resolve(path.dirname(scriptName), remapped.source),
      lineNumber: remapped.line + 1,
      columnNumber: remapped.column + 1,
    };
  } catch {
    return null;
  }
}

/**
 * Returns an array of call site objects for the current execution context.
 * Mirrors node's util.getCallSites(frameCount, options).
 * @param {number|object} [frameCount]
 * @param {{ sourceMap?: boolean }} [options]
 * @returns {Array<{ functionName: string|null, scriptId: string, scriptName: string, lineNumber: number, columnNumber: number, column: number }>}
 */
export function getCallSites(frameCount = 10, options) {
  // Overload: getCallSites(options)
  // Note: Arrays are not valid options (real Node rejects them).
  if (options === undefined) {
    if (typeof frameCount === 'object' && frameCount !== null && !Array.isArray(frameCount)) {
      options = frameCount;
      validateObject(options, 'options');
      if (options.sourceMap !== undefined) {
        validateBoolean(options.sourceMap, 'options.sourceMap');
      }
      frameCount = 10;
    } else {
      options = {};
    }
  } else {
    validateObject(options, 'options');
    if (options.sourceMap !== undefined) {
      validateBoolean(options.sourceMap, 'options.sourceMap');
    }
  }

  validateInteger(frameCount, 'frameCount', 1, 200);

  const useSourceMap = options.sourceMap === true ||
    (typeof process !== 'undefined' &&
     typeof process.getOptionValue === 'function' &&
     process.getOptionValue('--enable-source-maps') &&
     options.sourceMap !== false);

  // Capture the stack with a private prepareStackTrace so user hooks and
  // stackTraceLimit cannot affect us.
  const originalPrepare = Error.prepareStackTrace;
  const originalLimit = Error.stackTraceLimit;
  let sites;
  try {
    Error.prepareStackTrace = (_, stack) => stack;
    Error.stackTraceLimit = frameCount + 5;
    const err = new Error();
    // Exclude getCallSites itself from the trace.
    const stack = err.stack;
    sites = Array.isArray(stack) ? stack.slice(1, frameCount + 1) : [];
  } finally {
    Error.prepareStackTrace = originalPrepare;
    Error.stackTraceLimit = originalLimit;
  }

  return sites.map((site) => {
    let scriptName;
    try {
      scriptName = site.getFileName() || '';
    } catch {
      scriptName = '';
    }
    let lineNumber;
    let columnNumber;
    try {
      lineNumber = site.getLineNumber() || 0;
      columnNumber = site.getColumnNumber() || 0;
    } catch {
      lineNumber = 0;
      columnNumber = 0;
    }
    let functionName = null;
    try {
      functionName = site.getFunctionName() || site.getMethodName() || null;
    } catch {
      functionName = null;
    }
    let scriptId = '';
    try {
      const id = site.getScriptId?.() ?? site.getScriptNameOrLine?.();
      scriptId = id !== undefined && id !== null ? String(id) : '';
    } catch {
      scriptId = '';
    }

    if (useSourceMap) {
      const remapped = tryRemapCallSite(scriptName, lineNumber, columnNumber);
      if (remapped) {
        scriptName = remapped.scriptName;
        lineNumber = remapped.lineNumber;
        columnNumber = remapped.columnNumber;
      }
    }

    // Null-prototype object, matching node's CallSite record shape.
    const record = Object.create(null);
    record.functionName = functionName;
    record.scriptId = scriptId;
    record.scriptName = scriptName;
    record.lineNumber = lineNumber;
    record.columnNumber = columnNumber;
    record.column = columnNumber;
    return record;
  });
}

// ---------------------------------------------------------------------------
// convertProcessSignalToExitCode / _exceptionWithHostPort
// ---------------------------------------------------------------------------

/**
 * Signal number table for convertProcessSignalToExitCode (browser fallback).
 * On Node, the real constants are used via the guarded bridge.
 */
const signalNumbers = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
  SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12,
  SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGSTKFLT: 16, SIGCHLD: 17,
  SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22,
  SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27,
  SIGWINCH: 28, SIGIO: 29, SIGPWR: 30, SIGSYS: 31,
};

/**
 * Converts a process signal name (e.g. 'SIGTERM') to its exit code (128 + n).
 * Mirrors node's util.convertProcessSignalToExitCode.
 * @param {string} signal
 * @returns {number|null}
 */
export function convertProcessSignalToExitCode(signalCode) {
  // Use real constants on Node when available.
  let signals = signalNumbers;
  try {
    const getBuiltin = typeof process !== 'undefined' && process.getBuiltinModule;
    const os = typeof getBuiltin === 'function' ? getBuiltin.call(process, 'os') : undefined;
    if (os?.constants?.signals) signals = os.constants.signals;
  } catch { /* fall back to static table */ }

  validateOneOf(signalCode, 'signalCode', PrimordialObjectKeys(signals));

  // POSIX standard: exit code for signal termination is 128 + signal number.
  return 128 + signals[signalCode];
}

/**
 * Creates an error with host/port details. Mirrors node's
 * internal ExceptionWithHostPort (_exceptionWithHostPort).
 * @param {number} err - errno number (e.g. -2 for ENOENT)
 * @param {string} syscall
 * @param {string|null} address
 * @param {number} [port]
 * @param {string} [additional]
 */
export function _exceptionWithHostPort(err, syscall, address, port, additional) {
  const code = getSystemErrorName(err);
  let details = '';
  if (port && port > 0) {
    details = ` ${address}:${port}`;
  } else if (address) {
    details = ` ${address}`;
  }
  if (additional) {
    details += ` - Local (${additional})`;
  }

  const ex = new Error(`${syscall} ${code}${details}`);
  ex.errno = err;
  ex.code = code;
  ex.syscall = syscall;
  ex.address = address;
  if (port) {
    ex.port = port;
  }
  if (typeof Error.captureStackTrace === 'function') {
    Error.captureStackTrace(ex, _exceptionWithHostPort);
  }
  return ex;
}

// ---------------------------------------------------------------------------
// default export
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// default export
// ---------------------------------------------------------------------------

export default {
  format, formatWithOptions, inspect, styleText, stripVTControlCharacters,
  deprecate, debuglog, debug, inherits, promisify, callbackify,
  isDeepStrictEqual, toUSVString, getSystemErrorName, getSystemErrorMessage,
  getSystemErrorMap, types, parseEnv, parseArgs, MIMEType, MIMEParams,
  TextEncoder, TextDecoder, transferableAbortSignal, transferableAbortController,
  aborted, log, _extend, getCallSites, convertProcessSignalToExitCode,
  _exceptionWithHostPort,
  isArray, isBoolean, isBuffer, isNull, isNullOrUndefined, isNumber, isString,
  isSymbol, isUndefined, isRegExp, isObject, isDate, isError, isFunction, isPrimitive,
  diff, setTraceSigInt,
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
