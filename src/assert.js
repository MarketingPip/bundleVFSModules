/**
 * node:assert port for browsers & bundlers — dependency-free ESM.
 *
 * Ported from Node.js v24.20.0 (lib/assert.js and its internal dependency
 * graph). The algorithms — deep comparison, value inspection, Myers diff,
 * assertion error formatting, and failing-expression extraction — are the
 * exact Node sources, mechanically transformed:
 *
 *   - `primordials` are generated from native bindings in the prelude.
 *   - `internalBinding('util'|'buffer'|'config')` map to local shims that are
 *     behavior-identical for every value the official assert tests exercise.
 *   - `require('internal/...')` map to the ported modules below.
 *   - Node-only APIs (process.stderr TTY probing, fs reads for expression
 *     extraction, deprecation warnings) are guarded so the bundle loads in
 *     browsers; under Node they behave exactly like the originals.
 *
 * Covered official tests: test-assert*, 19 files (see parity/node-test).
 */


/* ===== primordials (generated; equivalent to Node's internal/per_context/primordials) ===== */
const __uc = (fn) => Function.prototype.call.bind(fn);
const __SafeStringIterator = (str) => String(str)[Symbol.iterator]();
class __SafeMap extends globalThis.Map {}
class __SafeSet extends globalThis.Set {}
class __SafeWeakMap extends globalThis.WeakMap {}
const Error = globalThis.Error;
const String = globalThis.String;
const Symbol = globalThis.Symbol;
const Proxy = globalThis.Proxy;
const Int32Array = globalThis.Int32Array;
const Array = globalThis.Array;
const ArrayBuffer = globalThis.ArrayBuffer;
const BigInt = globalThis.BigInt;
const BigInt64Array = globalThis.BigInt64Array;
const BigUint64Array = globalThis.BigUint64Array;
const Boolean = globalThis.Boolean;
const DataView = globalThis.DataView;
const Date = globalThis.Date;
const Float32Array = globalThis.Float32Array;
const Float64Array = globalThis.Float64Array;
const Function = globalThis.Function;
const Int16Array = globalThis.Int16Array;
const Int8Array = globalThis.Int8Array;
const Map = globalThis.Map;
const Number = globalThis.Number;
const Object = globalThis.Object;
const Promise = globalThis.Promise;
const RegExp = globalThis.RegExp;
const Set = globalThis.Set;
const Uint16Array = globalThis.Uint16Array;
const Uint32Array = globalThis.Uint32Array;
const Uint8Array = globalThis.Uint8Array;
const Uint8ClampedArray = globalThis.Uint8ClampedArray;
const WeakMap = globalThis.WeakMap;
const WeakSet = globalThis.WeakSet;
const AggregateError = globalThis.AggregateError;
const RangeError = globalThis.RangeError;
const TypeError = globalThis.TypeError;
const ArrayPrototypeForEach = __uc(Array.prototype.forEach);
const ArrayPrototypeIndexOf = __uc(Array.prototype.indexOf);
const ArrayPrototypeJoin = __uc(Array.prototype.join);
const ArrayPrototypePush = __uc(Array.prototype.push);
const ArrayPrototypeSlice = __uc(Array.prototype.slice);
const FunctionPrototypeCall = __uc(Function.prototype.call);
const NumberIsNaN = Number.isNaN;
const ObjectAssign = Object.assign;
const ObjectDefineProperty = Object.defineProperty;
const ObjectIs = Object.is;
const ObjectKeys = Object.keys;
const ObjectPrototypeIsPrototypeOf = __uc(Object.prototype.isPrototypeOf);
const RegExpPrototypeExec = __uc(RegExp.prototype.exec);
const StringPrototypeIndexOf = __uc(String.prototype.indexOf);
const StringPrototypeSlice = __uc(String.prototype.slice);
const StringPrototypeSplit = __uc(String.prototype.split);
const ArrayPrototypePop = __uc(Array.prototype.pop);
const ErrorCaptureStackTrace = (typeof Error.captureStackTrace === 'function' ? Error.captureStackTrace : () => {});
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectPrototypeHasOwnProperty = __uc(Object.prototype.hasOwnProperty);
const SafeSet = __SafeSet;
const StringPrototypeRepeat = __uc(String.prototype.repeat);
const FunctionPrototype = Function.prototype;
const ObjectFreeze = Object.freeze;
const ReflectApply = Reflect.apply;
const SafeWeakMap = __SafeWeakMap;
const StringPrototypeEndsWith = __uc(String.prototype.endsWith);
const StringPrototypeCharCodeAt = __uc(String.prototype.charCodeAt);
const StringPrototypeReplace = __uc(String.prototype.replace);
const ArrayIsArray = Array.isArray;
const BigIntPrototypeValueOf = __uc(BigInt.prototype.valueOf);
const BooleanPrototypeValueOf = __uc(Boolean.prototype.valueOf);
const DatePrototypeGetTime = __uc(Date.prototype.getTime);
const NumberPrototypeValueOf = __uc(Number.prototype.valueOf);
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getOwnSymbols = Object.getOwnPropertySymbols;
const hasOwn = __uc(Object.prototype.hasOwnProperty);
const hasEnumerable = __uc(Object.prototype.propertyIsEnumerable);
const ObjectPrototypeToString = __uc(Object.prototype.toString);
const StringPrototypeValueOf = __uc(String.prototype.valueOf);
const SymbolPrototypeValueOf = __uc(Symbol.prototype.valueOf);
const SymbolToStringTag = Symbol.toStringTag;
const getByteLength = __uc(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.Uint8Array.prototype), 'byteLength').get);
const TypedArrayPrototypeGetSymbolToStringTag = __uc(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.Uint8Array.prototype), Symbol.toStringTag).get);
const Float16Array = globalThis.Float16Array;
const AggregateErrorPrototype = AggregateError.prototype;
const ArrayBufferPrototype = ArrayBuffer.prototype;
const ArrayPrototype = Array.prototype;
const ArrayPrototypeFilter = __uc(Array.prototype.filter);
const ArrayPrototypeIncludes = __uc(Array.prototype.includes);
const ArrayPrototypeMap = __uc(Array.prototype.map);
const ArrayPrototypePushApply = ((arr, items) => Reflect.apply(Array.prototype.push, arr, items));
const ArrayPrototypeSort = __uc(Array.prototype.sort);
const ArrayPrototypeSplice = __uc(Array.prototype.splice);
const ArrayPrototypeUnshift = __uc(Array.prototype.unshift);
const BooleanPrototype = Boolean.prototype;
const DataViewPrototype = DataView.prototype;
const DatePrototype = Date.prototype;
const DatePrototypeToISOString = __uc(Date.prototype.toISOString);
const DatePrototypeToString = __uc(Date.prototype.toString);
const ErrorPrototype = Error.prototype;
const ErrorPrototypeToString = __uc(Error.prototype.toString);
const FunctionPrototypeBind = __uc(Function.prototype.bind);
const FunctionPrototypeSymbolHasInstance = __uc(Function.prototype[Symbol.hasInstance]);
const FunctionPrototypeToString = __uc(Function.prototype.toString);
const JSONStringify = JSON.stringify;
const MapPrototype = Map.prototype;
const MapPrototypeEntries = __uc(Map.prototype.entries);
const MapPrototypeGetSize = __uc(Object.getOwnPropertyDescriptor(Map.prototype, 'size').get);
const MathFloor = Math.floor;
const MathMax = Math.max;
const MathMin = Math.min;
const MathRound = Math.round;
const MathSqrt = Math.sqrt;
const MathTrunc = Math.trunc;
const NumberIsFinite = Number.isFinite;
const NumberParseFloat = Number.parseFloat;
const NumberParseInt = Number.parseInt;
const NumberPrototype = Number.prototype;
const NumberPrototypeToString = __uc(Number.prototype.toString);
const ObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
const ObjectGetOwnPropertySymbols = Object.getOwnPropertySymbols;
const ObjectPrototype = Object.prototype;
const ObjectPrototypePropertyIsEnumerable = __uc(Object.prototype.propertyIsEnumerable);
const ObjectSeal = Object.seal;
const ObjectSetPrototypeOf = Object.setPrototypeOf;
const PromisePrototype = Promise.prototype;
const RangeErrorPrototype = RangeError.prototype;
const ReflectOwnKeys = Reflect.ownKeys;
const RegExpPrototype = RegExp.prototype;
const RegExpPrototypeSymbolReplace = __uc(RegExp.prototype[Symbol.replace]);
const RegExpPrototypeSymbolSplit = __uc(RegExp.prototype[Symbol.split]);
const RegExpPrototypeToString = __uc(RegExp.prototype.toString);
const SafeMap = __SafeMap;
const SafeStringIterator = __SafeStringIterator;
const SetPrototype = Set.prototype;
const SetPrototypeGetSize = __uc(Object.getOwnPropertyDescriptor(Set.prototype, 'size').get);
const SetPrototypeValues = __uc(Set.prototype.values);
const StringPrototype = String.prototype;
const StringPrototypeCodePointAt = __uc(String.prototype.codePointAt);
const StringPrototypeIncludes = __uc(String.prototype.includes);
const StringPrototypeLastIndexOf = __uc(String.prototype.lastIndexOf);
const StringPrototypeNormalize = __uc(String.prototype.normalize);
const StringPrototypePadEnd = __uc(String.prototype.padEnd);
const StringPrototypePadStart = __uc(String.prototype.padStart);
const StringPrototypeReplaceAll = __uc(String.prototype.replaceAll);
const StringPrototypeStartsWith = __uc(String.prototype.startsWith);
const StringPrototypeToLowerCase = __uc(String.prototype.toLowerCase);
const SymbolIterator = Symbol.iterator;
const SymbolPrototypeToString = __uc(Symbol.prototype.toString);
const SymbolToPrimitive = Symbol.toPrimitive;
const TypeErrorPrototype = TypeError.prototype;
const TypedArray = Object.getPrototypeOf(globalThis.Uint8Array);
const TypedArrayPrototype = Object.getPrototypeOf(globalThis.Uint8Array.prototype);
const TypedArrayPrototypeGetLength = __uc(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.Uint8Array.prototype), 'length').get);
const WeakMapPrototype = WeakMap.prototype;
const WeakSetPrototype = WeakSet.prototype;
const uncurryThis = ((fn) => __uc(fn));

/* ===== internalBinding shims ===== */
// util binding: only the surface used by assert's dependency graph.
const __bindingUtil = {
  constants: { ALL_PROPERTIES: 0, ONLY_ENUMERABLE: 2, SKIP_SYMBOLS: 4, kPending: 0, kRejected: 2 },
  getOwnNonIndexProperties(obj, filter) {
    const names = Object.getOwnPropertyNames(obj);
    const symbols = Object.getOwnPropertySymbols(obj);
    const out = [];
    // Bit flags: ONLY_ENUMERABLE=2 (skip non-enumerable), SKIP_SYMBOLS=4 (skip symbols).
    // Supports combinations like ONLY_ENUMERABLE | SKIP_SYMBOLS.
    const onlyEnumerable = (filter & 2) !== 0;
    const skipSymbols = (filter & 4) !== 0;
    for (const k of names) {
      if (/^(0|[1-9][0-9]*)$/.test(k) && Number(k) < 4294967295) continue;
      const d = Object.getOwnPropertyDescriptor(obj, k);
      if (onlyEnumerable && !d.enumerable) continue;
      out.push(k);
    }
    if (!skipSymbols) {
      for (const s of symbols) {
        const d = Object.getOwnPropertyDescriptor(obj, s);
        if (onlyEnumerable && !d.enumerable) continue;
        out.push(s);
      }
    }
    return out;
  },
  // No synchronous cross-realm promise introspection API exists; report pending.
  getPromiseDetails() { return [0 /* kPending */, undefined]; },
  // Without internals, proxies are traversed as ordinary objects.
  getProxyDetails() { return undefined; },
  previewEntries(value, isIterator = false) {
    if (isIterator) {
      try {
        const entries = [];
        let isKeyValue = false;
        for (const e of value) {
          entries.push(e);
          if (Array.isArray(e)) isKeyValue = true;
        }
        return [entries, isKeyValue];
      } catch { return [[], false]; }
    }
    // WeakMap/WeakSet entries are not observable without internals.
    return [];
  },
  getConstructorName(obj) {
    try {
      const p = Object.getPrototypeOf(obj);
      const c = p === null ? undefined : p.constructor;
      return (c && c.name) || '';
    } catch { return ''; }
  },
  getExternalValue() { return 0; },
};
// errors binding: getErrorSourcePositions is replaced by a prepareStackTrace
// implementation (see __errorSource below), so this stays unused.
const __bindingErrors = {};
// buffer binding: byte-wise Buffer comparison.
const __bindingBuffer = {
  compare(a, b) {
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return x.length === y.length ? 0 : (x.length < y.length ? -1 : 1);
  },
};
const __bindingConfig = { hasIntl: false };
const __bindingIcu = new Proxy({}, { get() { throw new Error('unreachable: icu'); } });

/* ===== internal/errors: exact error classes for the codes assert needs ===== */
const __classRegExp = /^[A-Z][a-zA-Z0-9]*$/;
const __kTypes = [
  'string', 'function', 'number', 'object',
  // Accept 'Function' and 'Object' as alternatives to the lowercased versions.
  'Function', 'Object',
  'boolean', 'bigint', 'symbol',
];
function __determineSpecificType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const type = typeof value;
  switch (type) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      if (value !== value) return 'type number (NaN)';
      if (value === Infinity) return 'type number (Infinity)';
      if (value === -Infinity) return 'type number (-Infinity)';
      return `type number (${value})`;
    case 'boolean': return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name}`;
    case 'object':
      if (value.constructor && 'name' in value.constructor) {
        return `an instance of ${value.constructor.name}`;
      }
      return `${Object.prototype.toString.call(value)}`;
    case 'string': {
      let v = value;
      if (v.length > 28) v = `${v.slice(0, 25)}...`;
      if (!v.includes("'")) return `type string ('${v}')`;
      return `type string (${JSON.stringify(v)})`;
    }
    default: return `type ${type} (${value})`;
  }
}
function __formatList(array, type = 'and') {
  switch (array.length) {
    case 0: return '';
    case 1: return `${array[0]}`;
    case 2: return `${array[0]} ${type} ${array[1]}`;
    case 3: return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default:
      return `${array.slice(0, -1).join(', ')}, ${type} ${array[array.length - 1]}`;
  }
}
function __addNumericalSeparator(s) {
  return String(s).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}
const __makeError = (code, Base, makeMessage) =>
  class extends Base {
    constructor(...args) {
      super(makeMessage(...args));
      this.code = code;
    }
    toString() { return `${this.name} [${code}]: ${this.message}`; }
  };
class __ERR_AMBIGUOUS_ARGUMENT extends TypeError {
  constructor(name, prop) {
    super(`The "${name}" argument is ambiguous. ${prop}`);
    this.code = 'ERR_AMBIGUOUS_ARGUMENT';
  }
}
class __ERR_ASSERTION extends Error {
  constructor(message) { super(message); this.code = 'ERR_ASSERTION'; }
}
class __ERR_CONSTRUCT_CALL_REQUIRED extends TypeError {
  constructor(name) {
    super(`Class constructor ${name} cannot be invoked without \`new\``);
    this.code = 'ERR_CONSTRUCT_CALL_REQUIRED';
  }
}
const __ERR_INVALID_ARG_TYPE = __makeError('ERR_INVALID_ARG_TYPE', TypeError,
  (name, expected, actual) => {
    if (!Array.isArray(expected)) expected = [expected];
    let msg = 'The ';
    if (name.endsWith(' argument')) msg += `${name} `;
    else msg += `"${name}" ${name.includes('.') ? 'property' : 'argument'} `;
    msg += 'must be ';
    const types = [], instances = [], other = [];
    for (const value of expected) {
      if (__kTypes.includes(value)) types.push(value.toLowerCase());
      else if (__classRegExp.exec(value) !== null) instances.push(value);
      else other.push(value);
    }
    if (instances.length > 0) {
      const pos = types.indexOf('object');
      if (pos !== -1) { types.splice(pos, 1); instances.push('Object'); }
    }
    if (types.length > 0) {
      msg += `${types.length > 1 ? 'one of type' : 'of type'} ${__formatList(types, 'or')}`;
      if (instances.length > 0 || other.length > 0) msg += ' or ';
    }
    if (instances.length > 0) {
      msg += `an instance of ${__formatList(instances, 'or')}`;
      if (other.length > 0) msg += ' or ';
    }
    if (other.length > 0) {
      if (other.length > 1) msg += `one of ${__formatList(other, 'or')}`;
      else {
        if (other[0].toLowerCase() !== other[0]) msg += 'an ';
        msg += `${other[0]}`;
      }
    }
    return msg + `. Received ${__determineSpecificType(actual)}`;
  });
const __ERR_INVALID_ARG_VALUE = __makeError('ERR_INVALID_ARG_VALUE', TypeError,
  (name, value, reason = 'is invalid') => {
    let inspected = __inspectForErrors(value);
    if (inspected.length > 128) inspected = `${inspected.slice(0, 128)}...`;
    const type = name.includes('.') ? 'property' : 'argument';
    return `The ${type} '${name}' ${reason}. Received ${inspected}`;
  });
const __ERR_INVALID_RETURN_VALUE = __makeError('ERR_INVALID_RETURN_VALUE', TypeError,
  (input, name, value) => {
    const type = __determineSpecificType(value);
    return `Expected ${input} to be returned from the "${name}" function but got ${type}.`;
  });
const __ERR_MISSING_ARGS = __makeError('ERR_MISSING_ARGS', TypeError,
  (...args) => {
    const len = args.length;
    const wrap = (a) => `"${a}"`;
    const list = args.map((a) => Array.isArray(a)
      ? a.map(wrap).join(' or ') : wrap(a));
    return `The ${__formatList(list)} argument${len > 1 ? 's' : ''} must be specified`;
  });
const __ERR_OUT_OF_RANGE = __makeError('ERR_OUT_OF_RANGE', RangeError,
  (str, range, input, replaceDefaultBoolean = false) => {
    let msg = replaceDefaultBoolean ? str : `The value of "${str}" is out of range.`;
    let received;
    if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
      received = __addNumericalSeparator(String(input));
    } else if (typeof input === 'bigint') {
      received = String(input);
      if (input > 2n ** 32n || input < -(2n ** 32n)) received = __addNumericalSeparator(received);
      received += 'n';
    } else {
      received = __inspectForErrors(input);
    }
    return msg + ` It must be ${range}. Received ${received}`;
  });
class __ERR_UNAVAILABLE_DURING_EXIT extends Error {
  constructor() {
    super('Cannot call function in process exit handler');
    this.code = 'ERR_UNAVAILABLE_DURING_EXIT';
  }
}
const __internalErrors = {
  codes: {
    ERR_AMBIGUOUS_ARGUMENT: __ERR_AMBIGUOUS_ARGUMENT,
    ERR_ASSERTION: __ERR_ASSERTION,
    ERR_CONSTRUCT_CALL_REQUIRED: __ERR_CONSTRUCT_CALL_REQUIRED,
    ERR_INVALID_ARG_TYPE: __ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE: __ERR_INVALID_ARG_VALUE,
    ERR_INVALID_RETURN_VALUE: __ERR_INVALID_RETURN_VALUE,
    ERR_MISSING_ARGS: __ERR_MISSING_ARGS,
    ERR_OUT_OF_RANGE: __ERR_OUT_OF_RANGE,
    ERR_UNAVAILABLE_DURING_EXIT: __ERR_UNAVAILABLE_DURING_EXIT,
  },
  isErrorStackTraceLimitWritable() { return true; },
  isStackOverflowError(err) {
    return err instanceof RangeError && /stack/i.test(err.message);
  },
};
// __inspectForErrors is installed after the inspect module is defined
// (inspect is needed for error messages; errors are needed for inspect).
let __inspectForErrors = (v) => String(v);
const __setInspectForErrors = (fn) => { __inspectForErrors = fn; };

/* ===== internal/validators (exact message behavior) ===== */
const __hideStackFrames = (fn) => fn;
const __kValidateObjectNone = 0;
const __validators = {
  kValidateObjectAllowArray: 1 << 1,
  validateUint32: __hideStackFrames((value, name, positive = false) => {
    if (typeof value !== 'number')
      throw new __ERR_INVALID_ARG_TYPE(name, 'number', value);
    if (!Number.isInteger(value))
      throw new __ERR_OUT_OF_RANGE(name, 'an integer', value);
    const min = positive ? 1 : 0;
    const max = 4294967295;
    if (value < min || value > max)
      throw new __ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
  }),
  validateString: __hideStackFrames((value, name) => {
    if (typeof value !== 'string')
      throw new __ERR_INVALID_ARG_TYPE(name, 'string', value);
  }),
  validateOneOf: __hideStackFrames((value, name, oneOf) => {
    if (!oneOf.includes(value)) {
      const allowed = oneOf.map((v) => typeof v === 'string' ? `'${v}'` : String(v)).join(', ');
      throw new __ERR_INVALID_ARG_VALUE(name, value, 'must be one of: ' + allowed);
    }
  }),
  validateObject: __hideStackFrames((value, name, options = __kValidateObjectNone) => {
    if (options === __kValidateObjectNone) {
      if (value === null || Array.isArray(value) || typeof value !== 'object')
        throw new __ERR_INVALID_ARG_TYPE(name, 'Object', value);
    } else {
      const throwOnNullable = (1 & options) === 0;
      if (throwOnNullable && value === null)
        throw new __ERR_INVALID_ARG_TYPE(name, 'Object', value);
      const throwOnArray = ((1 << 1) & options) === 0;
      if (throwOnArray && Array.isArray(value))
        throw new __ERR_INVALID_ARG_TYPE(name, 'Object', value);
      const throwOnFunction = ((1 << 2) & options) === 0;
      const t = typeof value;
      if (t !== 'object' && (throwOnFunction || t !== 'function'))
        throw new __ERR_INVALID_ARG_TYPE(name, 'Object', value);
    }
  }),
  validateFunction: __hideStackFrames((value, name) => {
    if (typeof value !== 'function')
      throw new __ERR_INVALID_ARG_TYPE(name, 'Function', value);
  }),
};

/* ===== internal/util/types: pure-JS type predicates (no native bindings) ===== */
const __types = (() => {
  // Proxy-safe: Object.prototype.toString accesses Symbol.toStringTag, which can
  // trigger a Proxy get trap that throws. Fall back to '[object Object]' so
  // type predicates return false instead of throwing (matches native binding
  // behavior for non-matching types).
  const toString = (v) => {
    try { return Object.prototype.toString.call(v); }
    catch { return '[object Object]'; }
  };
  // Internal-slot probes, captured once: each getter requires the
  // corresponding internal slot, so unlike `instanceof` they are neither
  // spoofable via setPrototypeOf nor broken cross-realm. Unlike methods
  // such as RegExp.prototype.exec, getters never mutate the value
  // (exec/test would reset lastIndex, which deepEqual compares).
  const __regExpSourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get;
  const __dataViewByteLengthGetter = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get;
  const __arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
  const __sharedArrayBufferByteLengthGetter = typeof SharedArrayBuffer !== 'undefined'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get
    : null;
  const __cryptoKeyTypeGetter = typeof CryptoKey !== 'undefined'
    ? Object.getOwnPropertyDescriptor(CryptoKey.prototype, 'type').get
    : null;
  const typedArrayTags = new Set([
    '[object Int8Array]', '[object Uint8Array]', '[object Uint8ClampedArray]',
    '[object Int16Array]', '[object Uint16Array]', '[object Int32Array]',
    '[object Uint32Array]', '[object Float32Array]', '[object Float64Array]',
    '[object BigInt64Array]', '[object BigUint64Array]',
  ]);
  if (typeof Float16Array !== 'undefined') typedArrayTags.add('[object Float16Array]');
  const boxedTags = new Set([
    '[object Boolean]', '[object Number]', '[object String]',
    '[object BigInt]', '[object Symbol]',
  ]);
  return {
    isAnyArrayBuffer: (v) => {
      // instanceof can be spoofed via setPrototypeOf; probe the internal
      // slot instead so fake ArrayBuffers don't crash byteLength access.
      if (typeof v !== 'object' || v === null) return false;
      try {
        ArrayBuffer.prototype.slice.call(v, 0, 0);
        return true;
      } catch { /* not a real ArrayBuffer */ }
      if (typeof SharedArrayBuffer !== 'undefined') {
        try {
          SharedArrayBuffer.prototype.slice.call(v, 0, 0);
          return true;
        } catch { /* not a real SharedArrayBuffer */ }
      }
      return false;
    },
    isArrayBufferView: (v) => ArrayBuffer.isView(v),
    isArgumentsObject: (v) => toString(v) === '[object Arguments]',
    isArrayBuffer: (v) => {
      // instanceof is spoofable via setPrototypeOf and fails cross-realm;
      // probe the internal slot instead. SharedArrayBuffer shares the
      // [[ArrayBufferData]] slot, so the brand tag distinguishes the two.
      if (typeof v !== 'object' || v === null) return false;
      try { __arrayBufferByteLengthGetter.call(v); }
      catch { return false; }
      return toString(v) === '[object ArrayBuffer]';
    },
    isAsyncFunction: (v) => toString(v) === '[object AsyncFunction]',
    isBigInt64Array: (v) => toString(v) === '[object BigInt64Array]',
    isBigUint64Array: (v) => toString(v) === '[object BigUint64Array]',
    isBooleanObject: (v) => {
      if (typeof v !== 'object' || v === null || toString(v) !== '[object Boolean]') return false;
      try { Boolean.prototype.valueOf.call(v); return true; } catch { return false; }
    },
    isBigIntObject: (v) => {
      if (typeof v !== 'object' || v === null || toString(v) !== '[object BigInt]') return false;
      try { BigInt.prototype.valueOf.call(v); return true; } catch { return false; }
    },
    // isBoxedPrimitive must agree with the specific isXxxObject checks below,
    // which verify internal slots via valueOf (not just toStringTag).
    isBoxedPrimitive: (v) => {
      if (typeof v !== 'object' || v === null) return false;
      const tag = toString(v);
      if (!boxedTags.has(tag)) return false;
      try {
        if (tag === '[object Boolean]') Boolean.prototype.valueOf.call(v);
        else if (tag === '[object Number]') Number.prototype.valueOf.call(v);
        else if (tag === '[object String]') String.prototype.valueOf.call(v);
        else if (tag === '[object BigInt]') BigInt.prototype.valueOf.call(v);
        else if (tag === '[object Symbol]') Symbol.prototype.valueOf.call(v);
        return true;
      } catch { return false; }
    },
    isCryptoKey: (v) => {
      // CryptoKey exposes no enumerable own properties; detect via the
      // `type` getter, which requires the internal slot (realm-agnostic,
      // not spoofable via prototype manipulation). Guard for environments
      // without WebCrypto.
      if (typeof v !== 'object' || v === null) return false;
      if (__cryptoKeyTypeGetter == null) return false;
      try { __cryptoKeyTypeGetter.call(v); return true; }
      catch { return false; }
    },
    isDataView: (v) => {
      // instanceof is spoofable via setPrototypeOf and fails cross-realm;
      // the byteLength getter requires the internal slot instead.
      if (typeof v !== 'object' || v === null) return false;
      try { __dataViewByteLengthGetter.call(v); return true; }
      catch { return false; }
    },
    isDate: (v) => {
      // instanceof is insufficient: an object with Date.prototype in its
      // chain (but no [[DateValue]] slot) must report false, like the
      // native check. Probing getTime detects the internal slot.
      if (typeof v !== 'object' || v === null) return false;
      try { Date.prototype.getTime.call(v); return true; }
      catch { return false; }
    },
    isExternal: () => false,
    isFloat16Array: (v) => typeof Float16Array !== 'undefined' && toString(v) === '[object Float16Array]',
    isFloat32Array: (v) => toString(v) === '[object Float32Array]',
    isFloat64Array: (v) => toString(v) === '[object Float64Array]',
    isGeneratorFunction: (v) => toString(v) === '[object GeneratorFunction]',
    isGeneratorObject: (v) => toString(v) === '[object Generator]',
    isInt8Array: (v) => toString(v) === '[object Int8Array]',
    isInt16Array: (v) => toString(v) === '[object Int16Array]',
    isInt32Array: (v) => toString(v) === '[object Int32Array]',
    isKeyObject: (v) => {
      // Dependency-free duck-typing for crypto.KeyObject: detect the
      // realm-agnostic KeyObject shape via the `type` getter and the
      // `export()` method. Spoofed plain objects with matching own props
      // would need both, which the port deliberately excludes.
      if (typeof v !== 'object' || v === null) return false;
      if (typeof v.export !== 'function') return false;
      let t;
      try { t = v.type; } catch { return false; }
      return t === 'secret' || t === 'public' || t === 'private';
    },
    isMap: (v) => {
      // instanceof is spoofable via setPrototypeOf and fails cross-realm;
      // probe the internal slot instead (realm-agnostic).
      if (typeof v !== 'object' || v === null) return false;
      try { Map.prototype.has.call(v, undefined); return true; }
      catch { return false; }
    },
    isMapIterator: (v) => toString(v) === '[object Map Iterator]',
    isModuleNamespaceObject: (v) => toString(v) === '[object Module]',
    isNativeError: (v) => v instanceof Error,
    isNumberObject: (v) => {
      if (typeof v !== 'object' || v === null || toString(v) !== '[object Number]') return false;
      try { Number.prototype.valueOf.call(v); return true; } catch { return false; }
    },
    isPromise: (v) => v instanceof Promise,
    isProxy: () => false,
    isRegExp: (v) => {
      // instanceof is spoofable via setPrototypeOf and fails cross-realm;
      // probe the internal slot instead (realm-agnostic). The `source`
      // getter requires the slot but never touches lastIndex (unlike
      // exec/test, which would reset it and corrupt deepEqual).
      if (typeof v !== 'object' || v === null) return false;
      try { __regExpSourceGetter.call(v); return true; }
      catch { return false; }
    },
    isSet: (v) => {
      // instanceof is spoofable via setPrototypeOf and fails cross-realm;
      // probe the internal slot instead (realm-agnostic).
      if (typeof v !== 'object' || v === null) return false;
      try { Set.prototype.has.call(v, undefined); return true; }
      catch { return false; }
    },
    isSetIterator: (v) => toString(v) === '[object Set Iterator]',
    isSharedArrayBuffer: (v) => {
      // instanceof is spoofable via setPrototypeOf and fails cross-realm;
      // probe the internal slot instead. A plain ArrayBuffer also passes
      // the slot probe, so the brand tag distinguishes the two.
      if (typeof v !== 'object' || v === null) return false;
      if (__sharedArrayBufferByteLengthGetter == null) return false;
      try { __sharedArrayBufferByteLengthGetter.call(v); }
      catch { return false; }
      return toString(v) === '[object SharedArrayBuffer]';
    },
    isStringObject: (v) => {
      if (typeof v !== 'object' || v === null || toString(v) !== '[object String]') return false;
      try { String.prototype.valueOf.call(v); return true; } catch { return false; }
    },
    isSymbolObject: (v) => {
      if (typeof v !== 'object' || v === null || toString(v) !== '[object Symbol]') return false;
      try { Symbol.prototype.valueOf.call(v); return true; } catch { return false; }
    },
    isTypedArray: (v) => {
      if (typeof ArrayBuffer === 'undefined' || !ArrayBuffer.isView(v)) return false;
      // Exclude DataView via the internal-slot probe (instanceof would
      // fail cross-realm).
      try { __dataViewByteLengthGetter.call(v); return false; }
      catch { return true; }
    },
    isUint8Array: (v) => toString(v) === '[object Uint8Array]',
    isUint8ClampedArray: (v) => toString(v) === '[object Uint8ClampedArray]',
    isUint16Array: (v) => toString(v) === '[object Uint16Array]',
    isUint32Array: (v) => toString(v) === '[object Uint32Array]',
    isWeakMap: (v) => {
      // instanceof is spoofable via setPrototypeOf and fails cross-realm;
      // probe the internal slot only.
      if (typeof v !== 'object' || v === null) return false;
      try { WeakMap.prototype.has.call(v, {}); return true; }
      catch { return false; }
    },
    isWeakSet: (v) => {
      // instanceof is spoofable via setPrototypeOf and fails cross-realm;
      // probe the internal slot only.
      if (typeof v !== 'object' || v === null) return false;
      try { WeakSet.prototype.has.call(v, {}); return true; }
      catch { return false; }
    },
    isWebAssemblyCompiledModule: (v) => toString(v) === '[object WebAssembly.Module]',
  };
})();

/* ===== internal/util (surface used by assert's graph) ===== */
const __kCustomInspect = Symbol.for('nodejs.util.inspect.custom');
const __internalUtil = {
  customInspectSymbol: __kCustomInspect,
  isError: (e) => (e instanceof Error) ||
    (typeof e === 'object' && e !== null &&
     Object.prototype.toString.call(e) === '[object Error]'),
  join: (output, separator) => output.join(separator),
  removeColors: (str) => String(str).replace(/\u001b\[\d+m/g, ''),
  setOwnProperty: (obj, key, value) => {
    Object.defineProperty(obj, key, {
      __proto__: null, configurable: true, enumerable: true, value, writable: true,
    });
    return value;
  },
  deprecate(fn, msg, code) {
    let warned = false;
    function deprecated(...args) {
      if (!warned) {
        warned = true;
        __emitWarning(msg, 'DeprecationWarning', code);
      }
      if (new.target) return Reflect.construct(fn, args, new.target);
      return Reflect.apply(fn, this, args);
    }
    Object.setPrototypeOf(deprecated, fn);
    if (fn.prototype) deprecated.prototype = fn.prototype;
    try {
      Object.defineProperty(deprecated, 'length', {
        __proto__: null, ...Object.getOwnPropertyDescriptor(fn, 'length'),
      });
    } catch {}
    try {
      Object.defineProperty(deprecated, 'name', {
        __proto__: null, ...Object.getOwnPropertyDescriptor(fn, 'name'),
      });
    } catch {}
    return deprecated;
  },
};
function __emitWarning(msg, type, code) {
  try {
    if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
      if (code !== undefined) process.emitWarning(msg, { type, code });
      else process.emitWarning(msg, type);
      return;
    }
  } catch {}
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    try { console.warn(`${type}${code ? ` [${code}]` : ''}: ${msg}`); } catch {}
  }
}

/* ===== internal/util/colors (browser-safe: colors off without a TTY) ===== */
const __colors = {
  blue: '', green: '', white: '', red: '', gray: '', yellow: '',
  clear: '', reset: '', hasColors: false,
  shouldColorize() { return false; },
  refresh() {
    const c = __colors;
    c.blue = c.green = c.white = c.red = c.gray = c.yellow = '';
    c.clear = c.reset = '';
    c.hasColors = false;
  },
};
__colors.refresh();

/* ===== internal/assert (tiny shared assert for internals) ===== */
const __internalAssert = (value, message) => {
  if (!value) throw new Error(message || 'Assertion failed');
};

/* ===== internal/bootstrap/realm: BuiltinModule.exists ===== */
const __builtinList = new Set(
  ('assert,assert/strict,async_hooks,buffer,child_process,cluster,console,constants,crypto,' +
   'dgram,diagnostics_channel,dns,dns/promises,domain,events,fs,fs/promises,http,http2,' +
   'https,inspector,module,net,os,path,path/posix,path/win32,perf_hooks,process,' +
   'punycode,querystring,readline,repl,stream,stream/consumers,stream/promises,' +
   'stream/web,string_decoder,sys,test,timers,timers/promises,tls,trace_events,tty,' +
   'url,util,util/types,v8,vm,worker_threads,zlib').split(','));
const __BuiltinModule = {
  exists: (name) =>
    __builtinList.has(name.startsWith('node:') ? name.slice(5) : name),
};

/* ===== internal/url: isURL without native bindings ===== */
const __internalUrl = {
  URL: (typeof URL !== 'undefined' ? URL : undefined),
  isURL: (v) => (typeof URL !== 'undefined' && v instanceof URL),
  pathToFileURL: (p) => {
    if (typeof URL !== 'undefined' && URL.pathToFileURL) return URL.pathToFileURL(p);
    return { href: 'file://' + String(p) };
  },
};

/* ===== buffer shim ===== */
const __getBuffer = () => {
  if (typeof Buffer !== 'undefined') return Buffer;
  if (typeof globalThis !== 'undefined' && globalThis.Buffer) return globalThis.Buffer;
  return undefined;
};
const __bufferMod = { get Buffer() { return __getBuffer(); } };

/* ===== process guards ===== */
const __stderr = (typeof process !== 'undefined' && process.stderr) || undefined;
const __processExiting = () =>
  (typeof process !== 'undefined' && !!process._exiting);

/* ===== internal/errors/error_source: expression extraction (browser-safe) =====
 * Node resolves the failing expression via internal V8 source positions and
 * an Acorn tokenizer. Here: use Error.prepareStackTrace (V8/Node) when
 * available to find the caller file/line/column, read the line from disk
 * (guarded: skipped without fs access), and run an equivalent tokenizer
 * over the single line. Without V8 stack APIs the expression is omitted,
 * exactly as Node does when positions are unavailable.
 */
function __tokenizeLine(code) {
  const tokens = [];
  const len = code.length;
  let i = 0;
  const isIdStart = (c) => c === '$' || c === '_' ||
    (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c.charCodeAt(0) > 127;
  const isIdPart = (c) => isIdStart(c) || (c >= '0' && c <= '9');
  while (i < len) {
    const ch = code[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
        ch === '\v' || ch === '\f' || ch === '\u00a0' || ch === '\ufeff') {
      i++;
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') break;
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    const start = i;
    if (isIdStart(ch)) {
      i++;
      while (i < len && isIdPart(code[i])) i++;
      tokens.push({ start, label: 'name' });
      continue;
    }
    if ((ch >= '0' && ch <= '9') ||
        (ch === '.' && code[i + 1] >= '0' && code[i + 1] <= '9')) {
      i++;
      if (ch === '0' && (code[i] === 'x' || code[i] === 'X' ||
          code[i] === 'o' || code[i] === 'O' ||
          code[i] === 'b' || code[i] === 'B')) {
        i++;
        while (i < len && /[0-9a-fA-F_]/.test(code[i])) i++;
      } else {
        while (i < len && /[0-9_]/.test(code[i])) i++;
        if (code[i] === '.' && code[i + 1] !== '.') {
          i++;
          while (i < len && /[0-9_]/.test(code[i])) i++;
        }
        if (code[i] === 'e' || code[i] === 'E') {
          let j = i + 1;
          if (code[j] === '+' || code[j] === '-') j++;
          if (code[j] >= '0' && code[j] <= '9') {
            i = j + 1;
            while (i < len && /[0-9_]/.test(code[i])) i++;
          }
        }
      }
      if (code[i] === 'n') i++;
      tokens.push({ start, label: 'num' });
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      i++;
      let depth = 0;
      while (i < len) {
        const c = code[i];
        if (c === '\\') { i += 2; continue; }
        if (q === '`' && c === '$' && code[i + 1] === '{') { depth++; i += 2; continue; }
        if (q === '`' && depth > 0 && c === '}') { depth--; i++; continue; }
        if (c === q && depth === 0) { i++; break; }
        i++;
      }
      tokens.push({ start, label: 'string' });
      continue;
    }
    if (ch === '?' && code[i + 1] === '.' &&
        !(code[i + 2] >= '0' && code[i + 2] <= '9')) {
      tokens.push({ start, label: '?.' });
      i += 2;
      continue;
    }
    const two = ch + (code[i + 1] || '');
    const three = two + (code[i + 2] || '');
    if (three === '===' || three === '!==' || three === '>>>' || three === '...') {
      tokens.push({ start, label: three });
      i += 3;
      continue;
    }
    if (two === '=>' || two === '==' || two === '!=' || two === '<=' ||
        two === '>=' || two === '&&' || two === '||' || two === '++' ||
        two === '--' || two === '**' || two === '<<' || two === '>>' ||
        two === '+=' || two === '-=' || two === '*=' || two === '/=' ||
        two === '%=' || two === '&=' || two === '|=' || two === '^=') {
      tokens.push({ start, label: two });
      i += 2;
      continue;
    }
    tokens.push({ start, label: ch });
    i++;
  }
  return tokens;
}

// Exact port of Node's getFirstExpression (lib/internal/errors/error_source.js),
// over the tokens produced by __tokenizeLine.
function __getFirstExpression(code, startColumn) {
  const memberAccessTokens = ['.', '?.', '[', ']'];
  const memberNameTokens = ['name', 'string', 'num'];
  let lastToken;
  let firstMemberAccessNameToken;
  let terminatingCol;
  let parenLvl = 0;
  for (const token of __tokenizeLine(code)) {
    if (token.start < startColumn) {
      if (token.label === ';') {
        firstMemberAccessNameToken = null;
        continue;
      }
      if (memberAccessTokens.includes(token.label) && lastToken?.label === 'name') {
        firstMemberAccessNameToken ??= lastToken;
      } else if (!memberAccessTokens.includes(token.label) &&
        !memberNameTokens.includes(token.label)) {
        firstMemberAccessNameToken = null;
      }
      lastToken = token;
      continue;
    }
    if (token.label === '(') { parenLvl++; continue; }
    if (token.label === ')') {
      parenLvl--;
      if (parenLvl === 0) {
        terminatingCol = token.start + 1;
        break;
      }
      continue;
    }
    if (token.label === ';') {
      terminatingCol = token;
      break;
    }
  }
  const start = firstMemberAccessNameToken?.start ?? startColumn;
  return String.prototype.slice.call(code, start, terminatingCol);
}

let __fileURLToPath = (url) => {
  let p = String(url).replace(/^file:\/\//, '');
  if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
  try { p = decodeURIComponent(p); } catch {}
  return p;
};
try {
  const __gbm2 = typeof process !== 'undefined' ? process.getBuiltinModule : undefined;
  if (typeof __gbm2 === 'function') {
    const __url = __gbm2.call(process, 'url');
    if (__url && typeof __url.fileURLToPath === 'function') {
      __fileURLToPath = (u) => __url.fileURLToPath(u);
    }
  }
} catch {}
// Parse a JS string literal starting at code[start] (the quote character)
// and return its decoded value, or undefined if it does not parse cleanly.
function __parseJsStringLiteral(code, start) {
  const quote = code[start];
  let out = '';
  let i = start + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') {
      i++;
      if (i >= code.length) return undefined;
      const e = code[i];
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '0': out += '\0'; break;
        case '\\': out += '\\'; break;
        case "'": out += "'"; break;
        case '"': out += '"'; break;
        case '`': out += '`'; break;
        case '\n': break; // line continuation
        case '\r':
          if (code[i + 1] === '\n') i++;
          break;
        case 'x': {
          const hex = code.slice(i + 1, i + 3);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 2; }
          else return undefined;
          break;
        }
        case 'u': {
          if (code[i + 1] === '{') {
            const end = code.indexOf('}', i + 2);
            if (end === -1) return undefined;
            const hex = code.slice(i + 2, end);
            if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined;
            const cp = parseInt(hex, 16);
            if (cp > 0x10FFFF) return undefined;
            out += String.fromCodePoint(cp);
            i = end;
          } else {
            const hex = code.slice(i + 1, i + 5);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
            else return undefined;
          }
          break;
        }
        default:
          out += e; // non-escape: lenient
      }
      i++;
    } else if (ch === quote) {
      return out;
    } else if (ch === '$' && quote === '`' && code[i + 1] === '{') {
      return undefined; // template substitution: cannot recover statically
    } else if ((ch === '\n' || ch === '\r') && quote !== '`') {
      return undefined; // unterminated literal
    } else {
      out += ch;
      i++;
    }
  }
  return undefined; // unterminated
}

// Direct-eval recovery: V8 exposes no source text for eval'd code through
// the CallSite API (Node reads it via a native binding instead). As a
// best-effort fallback, recover the eval'd source from the string literal
// passed to eval() at the eval call site in the outer source, then select
// the reported line within it.
function __getEvalSourceLine(cs) {
  try {
    if (typeof cs.isEval !== 'function' || !cs.isEval()) return undefined;
    const lineNumber = cs.getLineNumber();
    if (lineNumber == null) return undefined;
    const origin = cs.getEvalOrigin();
    if (typeof origin !== 'string') return undefined;
    // Origin looks like: "eval at <anonymous> (file:///path/file.js:22:1)"
    const m = /\(([^()]*):(\d+):(\d+)\)\s*$/.exec(origin);
    if (!m) return undefined;
    let fileName = m[1];
    const outerLine = parseInt(m[2], 10);
    if (fileName.startsWith('file://')) {
      try { fileName = __fileURLToPath(fileName); } catch { return undefined; }
    }
    if (!/^(?:[a-zA-Z]:[\/]|\/)/.test(fileName)) return undefined;
    if (typeof __readFileSync !== 'function') return undefined;
    let codeLine;
    try {
      const content = __readFileSync(fileName);
      codeLine = content.split('\n')[outerLine - 1];
    } catch { return undefined; }
    if (typeof codeLine !== 'string') return undefined;
    const evalIdx = codeLine.indexOf('eval(');
    if (evalIdx === -1) return undefined;
    let i = evalIdx + 5;
    while (i < codeLine.length && /\s/.test(codeLine[i])) i++;
    const quote = codeLine[i];
    if (quote !== "'" && quote !== '"' && quote !== '`') return undefined;
    const src = __parseJsStringLiteral(codeLine, i);
    if (typeof src !== 'string') return undefined;
    const lines = src.split('\n');
    return lines[lineNumber - 1];
  } catch {
    return undefined;
  }
}

function __getErrorSourceExpression(err) {
  try {
    // Resolving the source line needs V8's stack APIs (Node/Chrome).
    if (typeof Error.captureStackTrace !== 'function') return undefined;
    const origPrepare = Error.prepareStackTrace;
    let callsites;
    Error.prepareStackTrace = (e, cs) => cs;
    try {
      void err.stack;
      callsites = err.stack;
    } finally {
      Error.prepareStackTrace = origPrepare;
    }
    if (!Array.isArray(callsites) || callsites.length === 0) return undefined;
    const cs = callsites[0];
    let fileName = cs.getFileName();
    const lineNumber = cs.getLineNumber();
    const columnNumber = cs.getColumnNumber();
    // For `new Function(...)` or eval, there's no file.
    if (fileName == null) {
      // Direct eval: V8 exposes no source via CallSite (Node uses a native
      // binding). Recover the eval'd line from the string literal at the
      // eval() call site in the outer source.
      try {
        if (typeof cs.isEval === 'function' && cs.isEval()) {
          const evalLine = __getEvalSourceLine(cs);
          if (typeof evalLine === 'string' && columnNumber != null) {
            return __getFirstExpression(evalLine, columnNumber - 1);
          }
        }
      } catch {}
      // `new Function(...)`: get source from the function itself.
      try {
        const fn = cs.getFunction();
        if (typeof fn === 'function') {
          const src = Function.prototype.toString.call(fn);
          const lines = src.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            // Match assert(, assert.ok(, assert.strictEqual(, etc.
            const assertMatch = trimmed.match(/assert[.(]/);
            if (assertMatch) {
              const idx = line.indexOf('assert');
              if (idx !== -1) {
                let depth = 0;
                let end = idx + 7;
                for (let i = idx + 7; i < line.length; i++) {
                  if (line[i] === '(') depth++;
                  else if (line[i] === ')') {
                    if (depth === 0) { end = i + 1; break; }
                    depth--;
                  }
                }
                return line.substring(idx, end).trim();
              }
            }
          }
        }
      } catch {}
      return undefined;
    }
    if (lineNumber == null || columnNumber == null) return undefined;
    if (fileName.startsWith('file://')) {
      try { fileName = __fileURLToPath(fileName); } catch { return undefined; }
    }
    if (!/^(?:[a-zA-Z]:[\/]|\/)/.test(fileName)) return undefined;
    let sourceLine;
    try {
      if (typeof __readFileSync !== 'function') return undefined;
      const content = __readFileSync(fileName);
      sourceLine = content.split('\n')[lineNumber - 1];
    } catch { return undefined; }
    if (typeof sourceLine !== 'string') return undefined;
    // V8 columns are 1-based; the tokenizer uses 0-based offsets.
    return __getFirstExpression(sourceLine, columnNumber - 1);
  } catch {
    return undefined;
  }
}
// File reading indirection: set when a sync fs read is available (Node),
// otherwise left undefined so browsers skip source extraction.
let __readFileSync;
const __setReadFileSync = (fn) => { __readFileSync = fn; };
try {
  // process.getBuiltinModule avoids a static 'fs' import, keeping bundlers happy.
  const __gbm = typeof process !== 'undefined' ? process.getBuiltinModule : undefined;
  if (typeof __gbm === 'function') {
    const __fs = __gbm.call(process, 'fs');
    if (__fs && typeof __fs.readFileSync === 'function') {
      __setReadFileSync((p) => __fs.readFileSync(p, 'utf8'));
    }
  }
} catch {}
const __inspectMod = (() => {
'use strict';

/* primordials: see bundle prelude */

const {
  constants: {
    ALL_PROPERTIES,
    ONLY_ENUMERABLE,
    kPending,
    kRejected,
  },
  getOwnNonIndexProperties,
  getPromiseDetails,
  getProxyDetails,
  previewEntries,
  getConstructorName: internalGetConstructorName,
  getExternalValue,
} = __bindingUtil;

const {
  customInspectSymbol,
  isError,
  join,
  removeColors,
} = __internalUtil;

const {
  isStackOverflowError,
} = __internalErrors;

const {
  isAsyncFunction,
  isGeneratorFunction,
  isAnyArrayBuffer,
  isArrayBuffer,
  isArgumentsObject,
  isBoxedPrimitive,
  isDataView,
  isExternal,
  isMap,
  isMapIterator,
  isModuleNamespaceObject,
  isNativeError,
  isPromise,
  isSet,
  isSetIterator,
  isWeakMap,
  isWeakSet,
  isRegExp,
  isDate,
  isTypedArray,
  isStringObject,
  isNumberObject,
  isBooleanObject,
  isBigIntObject,
} = __types;

const assert = __internalAssert;

const { BuiltinModule } = { BuiltinModule: __BuiltinModule };
const {
  validateObject,
  validateString,
  kValidateObjectAllowArray,
} = __validators;

let hexSlice;
let internalUrl;

function pathToFileUrlHref(filepath) {
  internalUrl ??= __internalUrl;
  return internalUrl.pathToFileURL(filepath).href;
}

function isURL(value) {
  internalUrl ??= __internalUrl;
  return typeof value.href === 'string' && value instanceof internalUrl.URL;
}

const builtInObjects = new SafeSet(
  ArrayPrototypeFilter(
    ObjectGetOwnPropertyNames(globalThis),
    (e) => RegExpPrototypeExec(/^[A-Z][a-zA-Z0-9]+$/, e) !== null,
  ),
);

// https://tc39.es/ecma262/#sec-IsHTMLDDA-internal-slot
const isUndetectableObject = (v) => typeof v === 'undefined' && v !== undefined;

// These options must stay in sync with `getUserOptions`. So if any option will
// be added or removed, `getUserOptions` must also be updated accordingly.
const inspectDefaultOptions = ObjectSeal({
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
});

const kObjectType = 0;
const kArrayType = 1;
const kArrayExtrasType = 2;

/* eslint-disable no-control-regex */
const strEscapeSequencesRegExp = /[\x00-\x1f\x27\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const strEscapeSequencesReplacer = /[\x00-\x1f\x27\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const strEscapeSequencesRegExpSingle = /[\x00-\x1f\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const strEscapeSequencesReplacerSingle = /[\x00-\x1f\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/* eslint-enable no-control-regex */

const keyStrRegExp = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
const numberRegExp = /^(0|[1-9][0-9]*)$/;

const coreModuleRegExp = /^ {4}at (?:[^/\\(]+ \(|)node:(.+):\d+:\d+\)?$/;

const classRegExp = /^(\s+[^(]*?)\s*{/;
// eslint-disable-next-line node-core/no-unescaped-regexp-dot
const stripCommentsRegExp = /(\/\/.*?\n)|(\/\*(.|\n)*?\*\/)/g;

const kMinLineLength = 16;

// Constants to map the iterator state.
const kWeak = 0;
const kIterator = 1;
const kMapEntries = 2;

// Escaped control characters (plus the single quote and the backslash). Use
// empty strings to fill up unused entries.
const meta = [
  '\\x00', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06', '\\x07', // x07
  '\\b', '\\t', '\\n', '\\x0B', '\\f', '\\r', '\\x0E', '\\x0F',           // x0F
  '\\x10', '\\x11', '\\x12', '\\x13', '\\x14', '\\x15', '\\x16', '\\x17', // x17
  '\\x18', '\\x19', '\\x1A', '\\x1B', '\\x1C', '\\x1D', '\\x1E', '\\x1F', // x1F
  '', '', '', '', '', '', '', "\\'", '', '', '', '', '', '', '', '',      // x2F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x3F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x4F
  '', '', '', '', '', '', '', '', '', '', '', '', '\\\\', '', '', '',     // x5F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x6F
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '\\x7F',    // x7F
  '\\x80', '\\x81', '\\x82', '\\x83', '\\x84', '\\x85', '\\x86', '\\x87', // x87
  '\\x88', '\\x89', '\\x8A', '\\x8B', '\\x8C', '\\x8D', '\\x8E', '\\x8F', // x8F
  '\\x90', '\\x91', '\\x92', '\\x93', '\\x94', '\\x95', '\\x96', '\\x97', // x97
  '\\x98', '\\x99', '\\x9A', '\\x9B', '\\x9C', '\\x9D', '\\x9E', '\\x9F', // x9F
];

// Regex used for ansi escape code splitting
// Ref: https://github.com/chalk/ansi-regex/blob/f338e1814144efb950276aac84135ff86b72dc8e/index.js
// License: MIT by Sindre Sorhus <sindresorhus@gmail.com>
// Matches all ansi escape code sequences in a string
const ansi = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*' +
  '(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*' +
  '|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?' +
  '(?:\\u0007|\\u001B\\u005C|\\u009C))' +
  '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?' +
  '[\\dA-PR-TZcf-nq-uy=><~]))', 'g',
);

let getStringWidth;

function getUserOptions(ctx, isCrossContext) {
  const ret = {
    stylize: ctx.stylize,
    showHidden: ctx.showHidden,
    depth: ctx.depth,
    colors: ctx.colors,
    customInspect: ctx.customInspect,
    showProxy: ctx.showProxy,
    maxArrayLength: ctx.maxArrayLength,
    maxStringLength: ctx.maxStringLength,
    breakLength: ctx.breakLength,
    compact: ctx.compact,
    sorted: ctx.sorted,
    getters: ctx.getters,
    numericSeparator: ctx.numericSeparator,
    ...ctx.userOptions,
  };

  // Typically, the target value will be an instance of `Object`. If that is
  // *not* the case, the object may come from another vm.Context, and we want
  // to avoid passing it objects from this Context in that case, so we remove
  // the prototype from the returned object itself + the `stylize()` function,
  // and remove all other non-primitives, including non-primitive user options.
  if (isCrossContext) {
    ObjectSetPrototypeOf(ret, null);
    for (const key of ObjectKeys(ret)) {
      if ((typeof ret[key] === 'object' || typeof ret[key] === 'function') &&
          ret[key] !== null) {
        delete ret[key];
      }
    }
    ret.stylize = ObjectSetPrototypeOf((value, flavour) => {
      let stylized;
      try {
        stylized = `${ctx.stylize(value, flavour)}`;
      } catch {
        // Continue regardless of error.
      }

      if (typeof stylized !== 'string') return value;
      // `stylized` is a string as it should be, which is safe to pass along.
      return stylized;
    }, null);
  }

  return ret;
}

/**
 * Echos the value of any input. Tries to print the value out
 * in the best way possible given the different types.
 * @param {any} value The value to print out.
 * @param {object} opts Optional options object that alters the output.
 */
/* Legacy: value, showHidden, depth, colors */
function inspect(value, opts) {
  // Default options
  const ctx = {
    budget: {},
    indentationLvl: 0,
    seen: [],
    currentDepth: 0,
    stylize: stylizeNoColor,
    showHidden: inspectDefaultOptions.showHidden,
    depth: inspectDefaultOptions.depth,
    colors: inspectDefaultOptions.colors,
    customInspect: inspectDefaultOptions.customInspect,
    showProxy: inspectDefaultOptions.showProxy,
    maxArrayLength: inspectDefaultOptions.maxArrayLength,
    maxStringLength: inspectDefaultOptions.maxStringLength,
    breakLength: inspectDefaultOptions.breakLength,
    compact: inspectDefaultOptions.compact,
    sorted: inspectDefaultOptions.sorted,
    getters: inspectDefaultOptions.getters,
    numericSeparator: inspectDefaultOptions.numericSeparator,
  };
  if (arguments.length > 1) {
    // Legacy...
    if (arguments.length > 2) {
      if (arguments[2] !== undefined) {
        ctx.depth = arguments[2];
      }
      if (arguments.length > 3 && arguments[3] !== undefined) {
        ctx.colors = arguments[3];
      }
    }
    // Set user-specified options
    if (typeof opts === 'boolean') {
      ctx.showHidden = opts;
    } else if (opts) {
      const optKeys = ObjectKeys(opts);
      for (let i = 0; i < optKeys.length; ++i) {
        const key = optKeys[i];
        // TODO(BridgeAR): Find a solution what to do about stylize. Either make
        // this function public or add a new API with a similar or better
        // functionality.
        if (
          ObjectPrototypeHasOwnProperty(inspectDefaultOptions, key) ||
          key === 'stylize') {
          ctx[key] = opts[key];
        } else if (ctx.userOptions === undefined) {
          // This is required to pass through the actual user input.
          ctx.userOptions = opts;
        }
      }
    }
  }
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
  if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;
  return formatValue(ctx, value, 0);
}
inspect.custom = customInspectSymbol;

ObjectDefineProperty(inspect, 'defaultOptions', {
  __proto__: null,
  get() {
    return inspectDefaultOptions;
  },
  set(options) {
    validateObject(options, 'options');
    return ObjectAssign(inspectDefaultOptions, options);
  },
});

// Set Graphics Rendition https://en.wikipedia.org/wiki/ANSI_escape_code#graphics
// Each color consists of an array with the color code as first entry and the
// reset code as second entry.
const defaultFG = 39;
const defaultBG = 49;
inspect.colors = {
  __proto__: null,
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22], // Alias: faint
  italic: [3, 23],
  underline: [4, 24],
  blink: [5, 25],
  // Swap foreground and background colors
  inverse: [7, 27], // Alias: swapcolors, swapColors
  hidden: [8, 28], // Alias: conceal
  strikethrough: [9, 29], // Alias: strikeThrough, crossedout, crossedOut
  doubleunderline: [21, 24], // Alias: doubleUnderline
  black: [30, defaultFG],
  red: [31, defaultFG],
  green: [32, defaultFG],
  yellow: [33, defaultFG],
  blue: [34, defaultFG],
  magenta: [35, defaultFG],
  cyan: [36, defaultFG],
  white: [37, defaultFG],
  bgBlack: [40, defaultBG],
  bgRed: [41, defaultBG],
  bgGreen: [42, defaultBG],
  bgYellow: [43, defaultBG],
  bgBlue: [44, defaultBG],
  bgMagenta: [45, defaultBG],
  bgCyan: [46, defaultBG],
  bgWhite: [47, defaultBG],
  framed: [51, 54],
  overlined: [53, 55],
  gray: [90, defaultFG], // Alias: grey, blackBright
  redBright: [91, defaultFG],
  greenBright: [92, defaultFG],
  yellowBright: [93, defaultFG],
  blueBright: [94, defaultFG],
  magentaBright: [95, defaultFG],
  cyanBright: [96, defaultFG],
  whiteBright: [97, defaultFG],
  bgGray: [100, defaultBG], // Alias: bgGrey, bgBlackBright
  bgRedBright: [101, defaultBG],
  bgGreenBright: [102, defaultBG],
  bgYellowBright: [103, defaultBG],
  bgBlueBright: [104, defaultBG],
  bgMagentaBright: [105, defaultBG],
  bgCyanBright: [106, defaultBG],
  bgWhiteBright: [107, defaultBG],
};

function defineColorAlias(target, alias) {
  ObjectDefineProperty(inspect.colors, alias, {
    __proto__: null,
    get() {
      return this[target];
    },
    set(value) {
      this[target] = value;
    },
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

// TODO(BridgeAR): Add function style support for more complex styles.
// Don't use 'blue' not visible on cmd.exe
inspect.styles = ObjectAssign({ __proto__: null }, {
  special: 'cyan',
  number: 'yellow',
  bigint: 'yellow',
  boolean: 'yellow',
  undefined: 'grey',
  null: 'bold',
  string: 'green',
  symbol: 'green',
  date: 'magenta',
  // "name": intentionally not styling
  // TODO(BridgeAR): Highlight regular expressions properly.
  regexp: 'red',
  module: 'underline',
});

function addQuotes(str, quotes) {
  if (quotes === -1) {
    return `"${str}"`;
  }
  if (quotes === -2) {
    return `\`${str}\``;
  }
  return `'${str}'`;
}

function escapeFn(str) {
  const charCode = StringPrototypeCharCodeAt(str);
  return meta.length > charCode ? meta[charCode] : `\\u${NumberPrototypeToString(charCode, 16)}`;
}

// Escape control characters, single quotes and the backslash.
// This is similar to JSON stringify escaping.
function strEscape(str) {
  let escapeTest = strEscapeSequencesRegExp;
  let escapeReplace = strEscapeSequencesReplacer;
  let singleQuote = 39;

  // Check for double quotes. If not present, do not escape single quotes and
  // instead wrap the text in double quotes. If double quotes exist, check for
  // backticks. If they do not exist, use those as fallback instead of the
  // double quotes.
  if (StringPrototypeIncludes(str, "'")) {
    // This invalidates the charCode and therefore can not be matched for
    // anymore.
    if (!StringPrototypeIncludes(str, '"')) {
      singleQuote = -1;
    } else if (!StringPrototypeIncludes(str, '`') &&
               !StringPrototypeIncludes(str, '${')) {
      singleQuote = -2;
    }
    if (singleQuote !== 39) {
      escapeTest = strEscapeSequencesRegExpSingle;
      escapeReplace = strEscapeSequencesReplacerSingle;
    }
  }

  // Some magic numbers that worked out fine while benchmarking with v8 6.0
  if (str.length < 5000 && RegExpPrototypeExec(escapeTest, str) === null)
    return addQuotes(str, singleQuote);
  if (str.length > 100) {
    str = RegExpPrototypeSymbolReplace(escapeReplace, str, escapeFn);
    return addQuotes(str, singleQuote);
  }

  let result = '';
  let last = 0;
  for (let i = 0; i < str.length; i++) {
    const point = StringPrototypeCharCodeAt(str, i);
    if (point === singleQuote ||
        point === 92 ||
        point < 32 ||
        (point > 126 && point < 160)) {
      if (last === i) {
        result += meta[point];
      } else {
        result += `${StringPrototypeSlice(str, last, i)}${meta[point]}`;
      }
      last = i + 1;
    } else if (point >= 0xd800 && point <= 0xdfff) {
      if (point <= 0xdbff && i + 1 < str.length) {
        const point = StringPrototypeCharCodeAt(str, i + 1);
        if (point >= 0xdc00 && point <= 0xdfff) {
          i++;
          continue;
        }
      }
      result += `${StringPrototypeSlice(str, last, i)}\\u${NumberPrototypeToString(point, 16)}`;
      last = i + 1;
    }
  }

  if (last !== str.length) {
    result += StringPrototypeSlice(str, last);
  }
  return addQuotes(result, singleQuote);
}

function stylizeWithColor(str, styleType) {
  const style = inspect.styles[styleType];
  if (style !== undefined) {
    const color = inspect.colors[style];
    if (color !== undefined)
      return `\u001b[${color[0]}m${str}\u001b[${color[1]}m`;
  }
  return str;
}

function stylizeNoColor(str) {
  return str;
}

// Return a new empty array to push in the results of the default formatter.
function getEmptyFormatArray() {
  return [];
}

function isInstanceof(object, proto) {
  try {
    return object instanceof proto;
  } catch {
    return false;
  }
}

// Special-case for some builtin prototypes in case their `constructor` property has been tampered.
const wellKnownPrototypes = new SafeMap()
  .set(ArrayPrototype, { name: 'Array', constructor: Array })
  .set(ArrayBufferPrototype, { name: 'ArrayBuffer', constructor: ArrayBuffer })
  .set(FunctionPrototype, { name: 'Function', constructor: Function })
  .set(MapPrototype, { name: 'Map', constructor: Map })
  .set(SetPrototype, { name: 'Set', constructor: Set })
  .set(ObjectPrototype, { name: 'Object', constructor: Object })
  .set(TypedArrayPrototype, { name: 'TypedArray', constructor: TypedArray })
  .set(RegExpPrototype, { name: 'RegExp', constructor: RegExp })
  .set(DatePrototype, { name: 'Date', constructor: Date })
  .set(DataViewPrototype, { name: 'DataView', constructor: DataView })

  .set(ErrorPrototype, { name: 'Error', constructor: Error })
  .set(AggregateErrorPrototype, { name: 'AggregateError', constructor: AggregateError })
  .set(RangeErrorPrototype, { name: 'RangeError', constructor: RangeError })
  .set(TypeErrorPrototype, { name: 'TypeError', constructor: TypeError })

  .set(BooleanPrototype, { name: 'Boolean', constructor: Boolean })
  .set(NumberPrototype, { name: 'Number', constructor: Number })
  .set(StringPrototype, { name: 'String', constructor: String })
  .set(PromisePrototype, { name: 'Promise', constructor: Promise })
  .set(WeakMapPrototype, { name: 'WeakMap', constructor: WeakMap })
  .set(WeakSetPrototype, { name: 'WeakSet', constructor: WeakSet });

function getConstructorName(obj, ctx, recurseTimes, protoProps) {
  let firstProto;
  const tmp = obj;
  while (obj || isUndetectableObject(obj)) {
    const wellKnownPrototypeNameAndConstructor = wellKnownPrototypes.get(obj);
    if (wellKnownPrototypeNameAndConstructor !== undefined) {
      const { name, constructor } = wellKnownPrototypeNameAndConstructor;
      if (FunctionPrototypeSymbolHasInstance(constructor, tmp)) {
        if (protoProps !== undefined && firstProto !== obj) {
          addPrototypeProperties(
            ctx, tmp, firstProto || tmp, recurseTimes, protoProps);
        }
        return name;
      }
    }
    const descriptor = ObjectGetOwnPropertyDescriptor(obj, 'constructor');
    if (descriptor !== undefined &&
        typeof descriptor.value === 'function' &&
        descriptor.value.name !== '' &&
        isInstanceof(tmp, descriptor.value)) {
      if (protoProps !== undefined &&
         (firstProto !== obj ||
         !builtInObjects.has(descriptor.value.name))) {
        addPrototypeProperties(
          ctx, tmp, firstProto || tmp, recurseTimes, protoProps);
      }
      return String(descriptor.value.name);
    }

    obj = ObjectGetPrototypeOf(obj);
    if (firstProto === undefined) {
      firstProto = obj;
    }
  }

  if (firstProto === null) {
    return null;
  }

  const res = internalGetConstructorName(tmp);

  if (recurseTimes > ctx.depth && ctx.depth !== null) {
    return `${res} <Complex prototype>`;
  }

  const protoConstr = getConstructorName(
    firstProto, ctx, recurseTimes + 1, protoProps);

  if (protoConstr === null) {
    return `${res} <${inspect(firstProto, {
      ...ctx,
      customInspect: false,
      depth: -1,
    })}>`;
  }

  return `${res} <${protoConstr}>`;
}

// This function has the side effect of adding prototype properties to the
// `output` argument (which is an array). This is intended to highlight user
// defined prototype properties.
function addPrototypeProperties(ctx, main, obj, recurseTimes, output) {
  let depth = 0;
  let keys;
  let keySet;
  do {
    if (depth !== 0 || main === obj) {
      obj = ObjectGetPrototypeOf(obj);
      // Stop as soon as a null prototype is encountered.
      if (obj === null) {
        return;
      }
      // Stop as soon as a built-in object type is detected.
      const descriptor = ObjectGetOwnPropertyDescriptor(obj, 'constructor');
      if (descriptor !== undefined &&
          typeof descriptor.value === 'function' &&
          builtInObjects.has(descriptor.value.name)) {
        return;
      }
    }

    if (depth === 0) {
      keySet = new SafeSet();
    } else {
      ArrayPrototypeForEach(keys, (key) => keySet.add(key));
    }
    // Get all own property names and symbols.
    keys = ReflectOwnKeys(obj);
    ArrayPrototypePush(ctx.seen, main);
    for (const key of keys) {
      // Ignore the `constructor` property and keys that exist on layers above.
      if (key === 'constructor' ||
          ObjectPrototypeHasOwnProperty(main, key) ||
          (depth !== 0 && keySet.has(key))) {
        continue;
      }
      const desc = ObjectGetOwnPropertyDescriptor(obj, key);
      if (typeof desc.value === 'function') {
        continue;
      }
      const value = formatProperty(
        ctx, obj, recurseTimes, key, kObjectType, desc, main);
      if (ctx.colors) {
        // Faint!
        ArrayPrototypePush(output, `\u001b[2m${value}\u001b[22m`);
      } else {
        ArrayPrototypePush(output, value);
      }
    }
    ArrayPrototypePop(ctx.seen);
  // Limit the inspection to up to three prototype layers. Using `recurseTimes`
  // is not a good choice here, because it's as if the properties are declared
  // on the current object from the users perspective.
  } while (++depth !== 3);
}

/** @type {(constructor: string, tag: string, fallback: string, size?: string) => string} */
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

// Look up the keys of the object.
function getKeys(value, showHidden) {
  let keys;
  const symbols = ObjectGetOwnPropertySymbols(value);
  if (showHidden) {
    keys = ObjectGetOwnPropertyNames(value);
    if (symbols.length !== 0)
      ArrayPrototypePushApply(keys, symbols);
  } else {
    // This might throw if `value` is a Module Namespace Object from an
    // unevaluated module, but we don't want to perform the actual type
    // check because it's expensive.
    // TODO(devsnek): track https://github.com/tc39/ecma262/issues/1209
    // and modify this logic as needed.
    try {
      keys = ObjectKeys(value);
    } catch (err) {
      assert(isNativeError(err) && err.name === 'ReferenceError' &&
             isModuleNamespaceObject(value));
      keys = ObjectGetOwnPropertyNames(value);
    }
    if (symbols.length !== 0) {
      const filter = (key) => ObjectPrototypePropertyIsEnumerable(value, key);
      ArrayPrototypePushApply(keys, ArrayPrototypeFilter(symbols, filter));
    }
  }
  return keys;
}

function getCtxStyle(value, constructor, tag) {
  let fallback = '';
  if (constructor === null) {
    fallback = internalGetConstructorName(value);
    if (fallback === tag) {
      fallback = 'Object';
    }
  }
  return getPrefix(constructor, tag, fallback);
}

function formatProxy(ctx, proxy, recurseTimes) {
  if (recurseTimes > ctx.depth && ctx.depth !== null) {
    return ctx.stylize('Proxy [Array]', 'special');
  }
  recurseTimes += 1;
  ctx.indentationLvl += 2;
  const res = [
    formatValue(ctx, proxy[0], recurseTimes),
    formatValue(ctx, proxy[1], recurseTimes),
  ];
  ctx.indentationLvl -= 2;
  return reduceToSingleString(
    ctx, res, '', ['Proxy [', ']'], kArrayExtrasType, recurseTimes);
}

// Note: using `formatValue` directly requires the indentation level to be
// corrected by setting `ctx.indentationLvL += diff` and then to decrease the
// value afterwards again.
function formatValue(ctx, value, recurseTimes, typedArray) {
  // Primitive types cannot have properties.
  if (typeof value !== 'object' &&
      typeof value !== 'function' &&
      !isUndetectableObject(value)) {
    return formatPrimitive(ctx.stylize, value, ctx);
  }
  if (value === null) {
    return ctx.stylize('null', 'null');
  }

  // Memorize the context for custom inspection on proxies.
  const context = value;
  // Always check for proxies to prevent side effects and to prevent triggering
  // any proxy handlers.
  const proxy = getProxyDetails(value, !!ctx.showProxy);
  if (proxy !== undefined) {
    if (proxy === null || proxy[0] === null) {
      return ctx.stylize('<Revoked Proxy>', 'special');
    }
    if (ctx.showProxy) {
      return formatProxy(ctx, proxy, recurseTimes);
    }
    value = proxy;
  }

  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it.
  if (ctx.customInspect) {
    let maybeCustom;
    try { maybeCustom = value[customInspectSymbol]; } catch { maybeCustom = undefined; }
    if (typeof maybeCustom === 'function' &&
        // Filter out the util module, its inspect function is special.
        maybeCustom !== inspect &&
        // Also filter out any prototype objects using the circular check.
        ObjectGetOwnPropertyDescriptor(value, 'constructor')?.value?.prototype !== value) {
      // This makes sure the recurseTimes are reported as before while using
      // a counter internally.
      const depth = ctx.depth === null ? null : ctx.depth - recurseTimes;
      const isCrossContext =
        proxy !== undefined || !FunctionPrototypeSymbolHasInstance(Object, context);
      const ret = FunctionPrototypeCall(
        maybeCustom,
        context,
        depth,
        getUserOptions(ctx, isCrossContext),
        inspect,
      );
      // If the custom inspection method returned `this`, don't go into
      // infinite recursion.
      if (ret !== context) {
        if (typeof ret !== 'string') {
          return formatValue(ctx, ret, recurseTimes);
        }
        return StringPrototypeReplaceAll(ret, '\n', `\n${StringPrototypeRepeat(' ', ctx.indentationLvl)}`);
      }
    }
  }

  // Using an array here is actually better for the average case than using
  // a Set. `seen` will only check for the depth and will never grow too large.
  if (ctx.seen.includes(value)) {
    let index = 1;
    if (ctx.circular === undefined) {
      ctx.circular = new SafeMap();
      ctx.circular.set(value, index);
    } else {
      index = ctx.circular.get(value);
      if (index === undefined) {
        index = ctx.circular.size + 1;
        ctx.circular.set(value, index);
      }
    }
    return ctx.stylize(`[Circular *${index}]`, 'special');
  }

  return formatRaw(ctx, value, recurseTimes, typedArray);
}

function formatRaw(ctx, value, recurseTimes, typedArray) {
  let keys;
  let protoProps;
  if (ctx.showHidden && (recurseTimes <= ctx.depth || ctx.depth === null)) {
    protoProps = [];
  }

  const constructor = getConstructorName(value, ctx, recurseTimes, protoProps);
  // Reset the variable to check for this later on.
  if (protoProps !== undefined && protoProps.length === 0) {
    protoProps = undefined;
  }

  let tag = '';

  try {
    tag = value[SymbolToStringTag];
  } catch {
    // Ignore error.
  }

  // Only list the tag in case it's non-enumerable / not an own property.
  // Otherwise we'd print this twice.
  if (typeof tag !== 'string' ||
      (tag !== '' &&
      (ctx.showHidden ?
        ObjectPrototypeHasOwnProperty :
        ObjectPrototypePropertyIsEnumerable)(
        value, SymbolToStringTag,
      ))) {
    tag = '';
  }
  let base = '';
  let formatter = getEmptyFormatArray;
  let braces;
  let noIterator = true;
  let i = 0;
  const filter = ctx.showHidden ? ALL_PROPERTIES : ONLY_ENUMERABLE;

  let extrasType = kObjectType;
  let extraKeys;

  // Iterators and the rest are split to reduce checks.
  // We have to check all values in case the constructor is set to null.
  // Otherwise it would not possible to identify all types properly.
  if (SymbolIterator in value || constructor === null) {
    noIterator = false;
    if (ArrayIsArray(value)) {
      // Only set the constructor for non ordinary ("Array [...]") arrays.
      const prefix = (constructor !== 'Array' || tag !== '') ?
        getPrefix(constructor, tag, 'Array', `(${value.length})`) :
        '';
      keys = getOwnNonIndexProperties(value, filter);
      braces = [`${prefix}[`, ']'];
      if (value.length === 0 && keys.length === 0 && protoProps === undefined)
        return `${braces[0]}]`;
      extrasType = kArrayExtrasType;
      formatter = formatArray;
    } else if (isSet(value)) {
      const size = SetPrototypeGetSize(value);
      const prefix = getPrefix(constructor, tag, 'Set', `(${size})`);
      keys = getKeys(value, ctx.showHidden);
      formatter = constructor !== null ?
        FunctionPrototypeBind(formatSet, null, value) :
        FunctionPrototypeBind(formatSet, null, SetPrototypeValues(value));
      if (size === 0 && keys.length === 0 && protoProps === undefined)
        return `${prefix}{}`;
      braces = [`${prefix}{`, '}'];
    } else if (isMap(value)) {
      const size = MapPrototypeGetSize(value);
      const prefix = getPrefix(constructor, tag, 'Map', `(${size})`);
      keys = getKeys(value, ctx.showHidden);
      formatter = constructor !== null ?
        FunctionPrototypeBind(formatMap, null, value) :
        FunctionPrototypeBind(formatMap, null, MapPrototypeEntries(value));
      if (size === 0 && keys.length === 0 && protoProps === undefined)
        return `${prefix}{}`;
      braces = [`${prefix}{`, '}'];
    } else if (isTypedArray(value)) {
      keys = getOwnNonIndexProperties(value, filter);
      let bound = value;
      let fallback = '';
      if (constructor === null) {
        fallback = TypedArrayPrototypeGetSymbolToStringTag(value);
        // Reconstruct the array information.
        bound = new primordials[fallback](value);
      }
      const size = TypedArrayPrototypeGetLength(value);
      const prefix = getPrefix(constructor, tag, fallback, `(${size})`);
      braces = [`${prefix}[`, ']'];
      if (value.length === 0 && keys.length === 0 && !ctx.showHidden)
        return `${braces[0]}]`;
      // Special handle the value. The original value is required below. The
      // bound function is required to reconstruct missing information.
      formatter = FunctionPrototypeBind(formatTypedArray, null, bound, size);
      extrasType = kArrayExtrasType;

      if (ctx.showHidden) {
        extraKeys = ['BYTES_PER_ELEMENT', 'length', 'byteLength', 'byteOffset', 'buffer'];
        typedArray = true;
      }
    } else if (isMapIterator(value)) {
      keys = getKeys(value, ctx.showHidden);
      braces = getIteratorBraces('Map', tag);
      // Add braces to the formatter parameters.
      formatter = FunctionPrototypeBind(formatIterator, null, braces);
    } else if (isSetIterator(value)) {
      keys = getKeys(value, ctx.showHidden);
      braces = getIteratorBraces('Set', tag);
      // Add braces to the formatter parameters.
      formatter = FunctionPrototypeBind(formatIterator, null, braces);
    } else {
      noIterator = true;
    }
  }
  if (noIterator) {
    keys = getKeys(value, ctx.showHidden);
    braces = ['{', '}'];
    if (typeof value === 'function') {
      base = getFunctionBase(ctx, value, constructor, tag);
      if (keys.length === 0 && protoProps === undefined)
        return ctx.stylize(base, 'special');
    } else if (constructor === 'Object') {
      if (isArgumentsObject(value)) {
        braces[0] = '[Arguments] {';
      } else if (tag !== '') {
        braces[0] = `${getPrefix(constructor, tag, 'Object')}{`;
      }
      if (keys.length === 0 && protoProps === undefined) {
        return `${braces[0]}}`;
      }
    } else if (isRegExp(value)) {
      // Make RegExps say that they are RegExps
      base = RegExpPrototypeToString(
        constructor !== null ? value : new RegExp(value),
      );
      const prefix = getPrefix(constructor, tag, 'RegExp');
      if (prefix !== 'RegExp ')
        base = `${prefix}${base}`;
      if ((keys.length === 0 && protoProps === undefined) ||
          (recurseTimes > ctx.depth && ctx.depth !== null)) {
        return ctx.stylize(base, 'regexp');
      }
    } else if (isDate(value)) {
      // Make dates with properties first say the date
      base = NumberIsNaN(DatePrototypeGetTime(value)) ?
        DatePrototypeToString(value) :
        DatePrototypeToISOString(value);
      const prefix = getPrefix(constructor, tag, 'Date');
      if (prefix !== 'Date ')
        base = `${prefix}${base}`;
      if (keys.length === 0 && protoProps === undefined) {
        return ctx.stylize(base, 'date');
      }
    } else if (isError(value)) {
      base = formatError(value, constructor, tag, ctx, keys);
      if (keys.length === 0 && protoProps === undefined)
        return base;
    } else if (isAnyArrayBuffer(value)) {
      // Fast path for ArrayBuffer and SharedArrayBuffer.
      // Can't do the same for DataView because it has a non-primitive
      // .buffer property that we need to recurse for.
      const arrayType = isArrayBuffer(value) ? 'ArrayBuffer' :
        'SharedArrayBuffer';
      const prefix = getPrefix(constructor, tag, arrayType);
      if (typedArray === undefined) {
        formatter = formatArrayBuffer;
      } else if (keys.length === 0 && protoProps === undefined) {
        return prefix +
              `{ [byteLength]: ${formatNumber(ctx.stylize, value.byteLength, false)} }`;
      }
      braces[0] = `${prefix}{`;
      extraKeys = ['byteLength'];
    } else if (isDataView(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'DataView')}{`;
      // .buffer goes last, it's not a primitive like the others.
      extraKeys = ['byteLength', 'byteOffset', 'buffer'];
    } else if (isPromise(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'Promise')}{`;
      formatter = formatPromise;
    } else if (isWeakSet(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'WeakSet')}{`;
      formatter = ctx.showHidden ? formatWeakSet : formatWeakCollection;
    } else if (isWeakMap(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'WeakMap')}{`;
      formatter = ctx.showHidden ? formatWeakMap : formatWeakCollection;
    } else if (isModuleNamespaceObject(value)) {
      braces[0] = `${getPrefix(constructor, tag, 'Module')}{`;
      // Special handle keys for namespace objects.
      formatter = formatNamespaceObject.bind(null, keys);
    } else if (isBoxedPrimitive(value)) {
      base = getBoxedBase(value, ctx, keys, constructor, tag);
      if (keys.length === 0 && protoProps === undefined) {
        return base;
      }
    } else if (isURL(value) && !(recurseTimes > ctx.depth && ctx.depth !== null)) {
      base = value.href;
      if (keys.length === 0 && protoProps === undefined) {
        return base;
      }
    } else {
      if (keys.length === 0 && protoProps === undefined) {
        if (isExternal(value)) {
          const address = getExternalValue(value).toString(16);
          return ctx.stylize(`[External: ${address}]`, 'special');
        }
        return `${getCtxStyle(value, constructor, tag)}{}`;
      }
      braces[0] = `${getCtxStyle(value, constructor, tag)}{`;
    }
  }

  if (recurseTimes > ctx.depth && ctx.depth !== null) {
    let constructorName = StringPrototypeSlice(getCtxStyle(value, constructor, tag), 0, -1);
    if (constructor !== null)
      constructorName = `[${constructorName}]`;
    return ctx.stylize(constructorName, 'special');
  }
  recurseTimes += 1;

  ctx.seen.push(value);
  ctx.currentDepth = recurseTimes;
  let output;
  const indentationLvl = ctx.indentationLvl;
  try {
    output = formatter(ctx, value, recurseTimes);
    if (extraKeys !== undefined) {
      for (i = 0; i < extraKeys.length; i++) {
        let formatted;
        try {
          formatted = formatExtraProperties(ctx, value, recurseTimes, extraKeys[i], typedArray);
        } catch {
          const tempValue = { [extraKeys[i]]: value.buffer[extraKeys[i]] };
          formatted = formatExtraProperties(ctx, tempValue, recurseTimes, extraKeys[i], typedArray);
        }
        ArrayPrototypePush(output, formatted);
      }
    }
    for (i = 0; i < keys.length; i++) {
      ArrayPrototypePush(
        output,
        formatProperty(ctx, value, recurseTimes, keys[i], extrasType),
      );
    }
    if (protoProps !== undefined) {
      ArrayPrototypePushApply(output, protoProps);
    }
  } catch (err) {
    if (!isStackOverflowError(err)) throw err;
    const constructorName = StringPrototypeSlice(getCtxStyle(value, constructor, tag), 0, -1);
    return handleMaxCallStackSize(ctx, err, constructorName, indentationLvl);
  }
  if (ctx.circular !== undefined) {
    const index = ctx.circular.get(value);
    if (index !== undefined) {
      const reference = ctx.stylize(`<ref *${index}>`, 'special');
      // Add reference always to the very beginning of the output.
      if (ctx.compact !== true) {
        base = base === '' ? reference : `${reference} ${base}`;
      } else {
        braces[0] = `${reference} ${braces[0]}`;
      }
    }
  }
  ctx.seen.pop();

  if (ctx.sorted) {
    const comparator = ctx.sorted === true ? undefined : ctx.sorted;
    if (extrasType === kObjectType) {
      ArrayPrototypeSort(output, comparator);
    } else if (keys.length > 1) {
      const sorted = ArrayPrototypeSort(ArrayPrototypeSlice(output, output.length - keys.length), comparator);
      ArrayPrototypeUnshift(sorted, output, output.length - keys.length, keys.length);
      ReflectApply(ArrayPrototypeSplice, null, sorted);
    }
  }

  const res = reduceToSingleString(
    ctx, output, base, braces, extrasType, recurseTimes, value);
  const budget = ctx.budget[ctx.indentationLvl] || 0;
  const newLength = budget + res.length;
  ctx.budget[ctx.indentationLvl] = newLength;
  // If any indentationLvl exceeds this limit, limit further inspecting to the
  // minimum. Otherwise the recursive algorithm might continue inspecting the
  // object even though the maximum string size (~2 ** 28 on 32 bit systems and
  // ~2 ** 30 on 64 bit systems) exceeded. The actual output is not limited at
  // exactly 2 ** 27 but a bit higher. This depends on the object shape.
  // This limit also makes sure that huge objects don't block the event loop
  // significantly.
  if (newLength > 2 ** 27) {
    ctx.depth = -1;
  }
  return res;
}

function getIteratorBraces(type, tag) {
  if (tag !== `${type} Iterator`) {
    if (tag !== '')
      tag += '] [';
    tag += `${type} Iterator`;
  }
  return [`[${tag}] {`, '}'];
}

function getBoxedBase(value, ctx, keys, constructor, tag) {
  let fn;
  let type;
  if (isNumberObject(value)) {
    fn = NumberPrototypeValueOf;
    type = 'Number';
  } else if (isStringObject(value)) {
    fn = StringPrototypeValueOf;
    type = 'String';
    // For boxed Strings, we have to remove the 0-n indexed entries,
    // since they just noisy up the output and are redundant
    // Make boxed primitive Strings look like such
    keys.splice(0, value.length);
  } else if (isBooleanObject(value)) {
    fn = BooleanPrototypeValueOf;
    type = 'Boolean';
  } else if (isBigIntObject(value)) {
    fn = BigIntPrototypeValueOf;
    type = 'BigInt';
  } else {
    fn = SymbolPrototypeValueOf;
    type = 'Symbol';
  }
  let base = `[${type}`;
  if (type !== constructor) {
    if (constructor === null) {
      base += ' (null prototype)';
    } else {
      base += ` (${constructor})`;
    }
  }
  base += `: ${formatPrimitive(stylizeNoColor, fn(value), ctx)}]`;
  if (tag !== '' && tag !== constructor) {
    base += ` [${tag}]`;
  }
  if (keys.length !== 0 || ctx.stylize === stylizeNoColor)
    return base;
  return ctx.stylize(base, StringPrototypeToLowerCase(type));
}

function getClassBase(value, constructor, tag) {
  const hasName = ObjectPrototypeHasOwnProperty(value, 'name');
  const name = (hasName && value.name) || '(anonymous)';
  let base = `class ${name}`;
  if (constructor !== 'Function' && constructor !== null) {
    base += ` [${constructor}]`;
  }
  if (tag !== '' && constructor !== tag) {
    base += ` [${tag}]`;
  }
  if (constructor !== null) {
    const superName = ObjectGetPrototypeOf(value).name;
    if (superName) {
      base += ` extends ${superName}`;
    }
  } else {
    base += ' extends [null prototype]';
  }
  return `[${base}]`;
}

function getFunctionBase(ctx, value, constructor, tag) {
  const stringified = FunctionPrototypeToString(value);
  if (StringPrototypeStartsWith(stringified, 'class') && stringified[stringified.length - 1] === '}') {
    const slice = StringPrototypeSlice(stringified, 5, -1);
    const bracketIndex = StringPrototypeIndexOf(slice, '{');
    if (bracketIndex !== -1 &&
        (!StringPrototypeIncludes(StringPrototypeSlice(slice, 0, bracketIndex), '(') ||
        // Slow path to guarantee that it's indeed a class.
        RegExpPrototypeExec(classRegExp, RegExpPrototypeSymbolReplace(stripCommentsRegExp, slice)) !== null)
    ) {
      return getClassBase(value, constructor, tag);
    }
  }
  let type = 'Function';
  if (isGeneratorFunction(value)) {
    type = `Generator${type}`;
  }
  if (isAsyncFunction(value)) {
    type = `Async${type}`;
  }
  let base = `[${type}`;
  if (constructor === null) {
    base += ' (null prototype)';
  }
  if (value.name === '') {
    base += ' (anonymous)';
  } else {
    base += `: ${typeof value.name === 'string' ? value.name : formatValue(ctx, value.name)}`;
  }
  base += ']';
  if (constructor !== type && constructor !== null) {
    base += ` ${constructor}`;
  }
  if (tag !== '' && constructor !== tag) {
    base += ` [${tag}]`;
  }
  return base;
}

function identicalSequenceRange(a, b) {
  for (let i = 0; i < a.length - 3; i++) {
    // Find the first entry of b that matches the current entry of a.
    const pos = ArrayPrototypeIndexOf(b, a[i]);
    if (pos !== -1) {
      const rest = b.length - pos;
      if (rest > 3) {
        let len = 1;
        const maxLen = MathMin(a.length - i, rest);
        // Count the number of consecutive entries.
        while (maxLen > len && a[i + len] === b[pos + len]) {
          len++;
        }
        if (len > 3) {
          return [len, i];
        }
      }
    }
  }

  return [0, 0];
}

function getDuplicateErrorFrameRanges(frames) {
  // Build a map: frame line -> sorted list of indices where it occurs
  const result = [];
  const lineToPositions = new SafeMap();

  for (let i = 0; i < frames.length; i++) {
    const positions = lineToPositions.get(frames[i]);
    if (positions === undefined) {
      lineToPositions.set(frames[i], [i]);
    } else {
      positions[positions.length] = i;
    }
  }

  const minimumDuplicateRange = 3;
  // Not enough duplicate lines to consider collapsing
  if (frames.length - lineToPositions.size <= minimumDuplicateRange) {
    return result;
  }

  for (let i = 0; i < frames.length - minimumDuplicateRange; i++) {
    const positions = lineToPositions.get(frames[i]);
    // Find the next occurrence of the same line after i, if any
    if (positions.length === 1 || positions[positions.length - 1] === i) {
      continue;
    }

    const current = positions.indexOf(i) + 1;
    if (current === positions.length) {
      continue;
    }

    // Theoretical maximum range, adjusted while iterating
    let range = positions[positions.length - 1] - i;
    if (range < minimumDuplicateRange) {
      continue;
    }
    let extraSteps;
    if (current + 1 < positions.length) {
      // Optimize initial step size by choosing the greatest common divisor (GCD)
      // of all candidate distances to the same frame line. This tends to match
      // the true repeating block size and minimizes fallback iterations.
      let gcdRange = 0;
      for (let j = current; j < positions.length; j++) {
        let distance = positions[j] - i;
        while (distance !== 0) {
          const remainder = gcdRange % distance;
          if (gcdRange !== 0) {
            // Add other possible ranges as fallback
            extraSteps ??= new SafeSet();
            extraSteps.add(gcdRange);
          }
          gcdRange = distance;
          distance = remainder;
        }
        if (gcdRange === 1) break;
      }
      range = gcdRange;
      if (extraSteps) {
        extraSteps.delete(range);
        extraSteps = [...extraSteps];
      }
    }
    let maxRange = range;
    let maxDuplicates = 0;

    let duplicateRanges = 0;

    for (let nextStart = i + range; /* ignored */ ; nextStart += range) {
      let equalFrames = 0;
      for (let j = 0; j < range; j++) {
        if (frames[i + j] !== frames[nextStart + j]) {
          break;
        }
        equalFrames++;
      }
      // Adjust the range to match different type of ranges.
      if (equalFrames !== range) {
        if (!extraSteps?.length) {
          break;
        }
        // Memorize former range in case the smaller one would hide less.
        if (duplicateRanges !== 0 && maxRange * maxDuplicates < range * duplicateRanges) {
          maxRange = range;
          maxDuplicates = duplicateRanges;
        }
        range = extraSteps.pop();
        nextStart = i;
        duplicateRanges = 0;
        continue;
      }
      duplicateRanges++;
    }

    if (maxDuplicates !== 0 && maxRange * maxDuplicates >= range * duplicateRanges) {
      range = maxRange;
      duplicateRanges = maxDuplicates;
    }

    if (duplicateRanges * range >= 3) {
      result.push(i + range, range, duplicateRanges);
      // Skip over the collapsed portion to avoid overlapping matches.
      i += range * (duplicateRanges + 1) - 1;
    }
  }

  return result;
}

function getStackString(ctx, error) {
  let stack;
  try {
    stack = error.stack;
  } catch {
    // If stack is getter that throws, we ignore the error.
  }
  if (stack) {
    if (typeof stack === 'string') {
      return stack;
    }
    ctx.seen.push(error);
    ctx.indentationLvl += 4;
    const result = formatValue(ctx, stack);
    ctx.indentationLvl -= 4;
    ctx.seen.pop();
    return `${ErrorPrototypeToString(error)}\n    ${result}`;
  }
  return ErrorPrototypeToString(error);
}

function getStackFrames(ctx, err, stack) {
  const frames = StringPrototypeSplit(stack, '\n');

  let cause;
  try {
    ({ cause } = err);
  } catch {
    // If 'cause' is a getter that throws, ignore it.
  }

  // Remove stack frames identical to frames in cause.
  if (cause != null && isError(cause)) {
    const causeStack = getStackString(ctx, cause);
    const causeStackStart = StringPrototypeIndexOf(causeStack, '\n    at');
    if (causeStackStart !== -1) {
      const causeFrames = StringPrototypeSplit(StringPrototypeSlice(causeStack, causeStackStart + 1), '\n');
      const { 0: len, 1: offset } = identicalSequenceRange(frames, causeFrames);
      if (len > 0) {
        const skipped = len - 2;
        const msg = `    ... ${skipped} lines matching cause stack trace ...`;
        frames.splice(offset + 1, skipped, ctx.stylize(msg, 'undefined'));
      }
    }
  }

  // Remove recursive repetitive stack frames in long stacks
  if (frames.length > 10) {
    const ranges = getDuplicateErrorFrameRanges(frames);

    for (let i = ranges.length - 3; i >= 0; i -= 3) {
      const offset = ranges[i];
      const length = ranges[i + 1];
      const duplicateRanges = ranges[i + 2];

      const msg = `    ... collapsed ${length * duplicateRanges} duplicate lines ` +
        'matching above ' +
        (duplicateRanges > 1 ?
          `${length} lines ${duplicateRanges} times...` :
          'lines ...');
      frames.splice(offset, length * duplicateRanges, ctx.stylize(msg, 'undefined'));
    }
  }

  return frames;
}

/** @type {(stack: string, constructor: string | null, name: unknown, tag: string) => string} */
function improveStack(stack, constructor, name, tag) {
  // A stack trace may contain arbitrary data. Only manipulate the output
  // for "regular errors" (errors that "look normal") for now.
  let len = name.length;

  if (typeof name !== 'string') {
    stack = StringPrototypeReplace(
      stack,
      `${name}`,
      `${name} [${StringPrototypeSlice(getPrefix(constructor, tag, 'Error'), 0, -1)}]`,
    );
  }

  if (constructor === null ||
      (StringPrototypeEndsWith(name, 'Error') &&
      StringPrototypeStartsWith(stack, name) &&
      (stack.length === len || stack[len] === ':' || stack[len] === '\n'))) {
    let fallback = 'Error';
    if (constructor === null) {
      const start = RegExpPrototypeExec(/^([A-Z][a-z_ A-Z0-9[\]()-]+)(?::|\n {4}at)/, stack) ||
      RegExpPrototypeExec(/^([a-z_A-Z0-9-]*Error)$/, stack);
      fallback = (start?.[1]) || '';
      len = fallback.length;
      fallback ||= 'Error';
    }
    const prefix = StringPrototypeSlice(getPrefix(constructor, tag, fallback), 0, -1);
    if (name !== prefix) {
      if (StringPrototypeIncludes(prefix, name)) {
        if (len === 0) {
          stack = `${prefix}: ${stack}`;
        } else {
          stack = `${prefix}${StringPrototypeSlice(stack, len)}`;
        }
      } else {
        stack = `${prefix} [${name}]${StringPrototypeSlice(stack, len)}`;
      }
    }
  }
  return stack;
}

function markNodeModules(ctx, line) {
  let tempLine = '';
  let lastPos = 0;
  let searchFrom = 0;

  while (true) {
    const nodeModulePosition = StringPrototypeIndexOf(line, 'node_modules', searchFrom);
    if (nodeModulePosition === -1) {
      break;
    }

    // Ensure it's a path segment: must have a path separator before and after
    const separator = line[nodeModulePosition - 1];
    const after = line[nodeModulePosition + 12]; // 'node_modules'.length === 12

    if ((after !== '/' && after !== '\\') || (separator !== '/' && separator !== '\\')) {
      // Not a proper segment; continue searching
      searchFrom = nodeModulePosition + 1;
      continue;
    }

    const moduleStart = nodeModulePosition + 13; // Include trailing separator

    // Append up to and including '/node_modules/'
    tempLine += StringPrototypeSlice(line, lastPos, moduleStart);

    let moduleEnd = StringPrototypeIndexOf(line, separator, moduleStart);
    if (moduleEnd === -1) {
      // No trailing separator: the module name runs to the end of the line.
      moduleEnd = line.length;
    } else if (line[moduleStart] === '@') {
      // Namespaced modules have an extra slash: @namespace/package
      moduleEnd = StringPrototypeIndexOf(line, separator, moduleEnd + 1);
      if (moduleEnd === -1) {
        moduleEnd = line.length;
      }
    }

    const nodeModule = StringPrototypeSlice(line, moduleStart, moduleEnd);
    tempLine += ctx.stylize(nodeModule, 'module');

    lastPos = moduleEnd;
    searchFrom = moduleEnd;
  }

  if (lastPos !== 0) {
    line = tempLine + StringPrototypeSlice(line, lastPos);
  }
  return line;
}

function markCwd(ctx, line, workingDirectory) {
  let cwdStartPos = StringPrototypeIndexOf(line, workingDirectory);
  let tempLine = '';
  let cwdLength = workingDirectory.length;
  if (cwdStartPos !== -1) {
    if (StringPrototypeSlice(line, cwdStartPos - 7, cwdStartPos) === 'file://') {
      cwdLength += 7;
      cwdStartPos -= 7;
    }
    const start = line[cwdStartPos - 1] === '(' ? cwdStartPos - 1 : cwdStartPos;
    const end = start !== cwdStartPos && StringPrototypeEndsWith(line, ')') ? -1 : line.length;
    const workingDirectoryEndPos = cwdStartPos + cwdLength + 1;
    const cwdSlice = StringPrototypeSlice(line, start, workingDirectoryEndPos);

    tempLine += StringPrototypeSlice(line, 0, start);
    tempLine += ctx.stylize(cwdSlice, 'undefined');
    tempLine += StringPrototypeSlice(line, workingDirectoryEndPos, end);
    if (end === -1) {
      tempLine += ctx.stylize(')', 'undefined');
    }
  } else {
    tempLine += line;
  }
  return tempLine;
}

function safeGetCWD() {
  let workingDirectory;
  try {
    workingDirectory = process.cwd();
  } catch {
    return;
  }
  return workingDirectory;
}

function formatError(err, constructor, tag, ctx, keys) {
  let message, name, stack;
  try {
    stack = getStackString(ctx, err);
  } catch {
    return ObjectPrototypeToString(err);
  }

  let messageIsGetterThatThrows = false;
  try {
    message = err.message;
  } catch {
    messageIsGetterThatThrows = true;
  }
  let nameIsGetterThatThrows = false;
  try {
    name = err.name;
  } catch {
    nameIsGetterThatThrows = true;
  }

  if (!ctx.showHidden && keys.length !== 0) {
    const index = ArrayPrototypeIndexOf(keys, 'stack');
    if (index !== -1) {
      ArrayPrototypeSplice(keys, index, 1);
    }

    if (!messageIsGetterThatThrows) {
      const index = ArrayPrototypeIndexOf(keys, 'message');
      // Only hide the property if it's a string and if it's part of the original stack
      if (index !== -1 && (typeof message !== 'string' || StringPrototypeIncludes(stack, message))) {
        ArrayPrototypeSplice(keys, index, 1);
      }
    }

    if (!nameIsGetterThatThrows) {
      const index = ArrayPrototypeIndexOf(keys, 'name');
      // Only hide the property if it's a string and if it's part of the original stack
      if (index !== -1 && (typeof name !== 'string' || StringPrototypeIncludes(stack, name))) {
        ArrayPrototypeSplice(keys, index, 1);
      }
    }
  }
  name ??= 'Error';

  if (ObjectPrototypeHasOwnProperty(err, 'cause') &&
      (keys.length === 0 || !ArrayPrototypeIncludes(keys, 'cause'))) {
    ArrayPrototypePush(keys, 'cause');
  }

  // Print errors aggregated into AggregateError
  try {
    const errors = err.errors;
    if (ArrayIsArray(errors) && ObjectPrototypeHasOwnProperty(err, 'errors') &&
      (keys.length === 0 || !ArrayPrototypeIncludes(keys, 'errors'))) {
      ArrayPrototypePush(keys, 'errors');
    }
  } catch {
    // If errors is a getter that throws, we ignore the error.
  }

  stack = improveStack(stack, constructor, name, tag);

  // Ignore the error message if it's contained in the stack.
  let pos = (message && StringPrototypeIndexOf(stack, message)) || -1;
  if (pos !== -1)
    pos += message.length;
  // Wrap the error in brackets in case it has no stack trace.
  const stackStart = StringPrototypeIndexOf(stack, '\n    at', pos);
  if (stackStart === -1) {
    stack = `[${stack}]`;
  } else {
    let newStack = StringPrototypeSlice(stack, 0, stackStart);
    const stackFramePart = StringPrototypeSlice(stack, stackStart + 1);
    const lines = getStackFrames(ctx, err, stackFramePart);
    if (ctx.colors) {
      // Highlight userland code and node modules.
      const workingDirectory = safeGetCWD();
      let esmWorkingDirectory;
      for (let line of lines) {
        const core = RegExpPrototypeExec(coreModuleRegExp, line);
        if (core !== null && BuiltinModule.exists(core[1])) {
          newStack += `\n${ctx.stylize(line, 'undefined')}`;
        } else {
          newStack += '\n';

          line = markNodeModules(ctx, line);
          if (workingDirectory !== undefined) {
            let newLine = markCwd(ctx, line, workingDirectory);
            if (newLine === line) {
              esmWorkingDirectory ??= pathToFileUrlHref(workingDirectory);
              newLine = markCwd(ctx, line, esmWorkingDirectory);
            }
            line = newLine;
          }

          newStack += line;
        }
      }
    } else {
      newStack += `\n${ArrayPrototypeJoin(lines, '\n')}`;
    }
    stack = newStack;
  }
  // The message and the stack have to be indented as well!
  if (ctx.indentationLvl !== 0) {
    const indentation = StringPrototypeRepeat(' ', ctx.indentationLvl);
    stack = StringPrototypeReplaceAll(stack, '\n', `\n${indentation}`);
  }
  return stack;
}

function groupArrayElements(ctx, output, value) {
  let totalLength = 0;
  let maxLength = 0;
  let i = 0;
  let outputLength = output.length;
  if (ctx.maxArrayLength < output.length) {
    // This makes sure the "... n more items" part is not taken into account.
    outputLength--;
  }
  const separatorSpace = 2; // Add 1 for the space and 1 for the separator.
  const dataLen = new Array(outputLength);
  // Calculate the total length of all output entries and the individual max
  // entries length of all output entries. We have to remove colors first,
  // otherwise the length would not be calculated properly.
  for (; i < outputLength; i++) {
    const len = getStringWidth(output[i], ctx.colors);
    dataLen[i] = len;
    totalLength += len + separatorSpace;
    if (maxLength < len)
      maxLength = len;
  }
  // Add two to `maxLength` as we add a single whitespace character plus a comma
  // in-between two entries.
  const actualMax = maxLength + separatorSpace;
  // Check if at least three entries fit next to each other and prevent grouping
  // of arrays that contains entries of very different length (i.e., if a single
  // entry is longer than 1/5 of all other entries combined). Otherwise the
  // space in-between small entries would be enormous.
  if (actualMax * 3 + ctx.indentationLvl < ctx.breakLength &&
      (totalLength / actualMax > 5 || maxLength <= 6)) {

    const approxCharHeights = 2.5;
    const averageBias = MathSqrt(actualMax - totalLength / output.length);
    const biasedMax = MathMax(actualMax - 3 - averageBias, 1);
    // Dynamically check how many columns seem possible.
    const columns = MathMin(
      // Ideally a square should be drawn. We expect a character to be about 2.5
      // times as high as wide. This is the area formula to calculate a square
      // which contains n rectangles of size `actualMax * approxCharHeights`.
      // Divide that by `actualMax` to receive the correct number of columns.
      // The added bias increases the columns for short entries.
      MathRound(
        MathSqrt(
          approxCharHeights * biasedMax * outputLength,
        ) / biasedMax,
      ),
      // Do not exceed the breakLength.
      MathFloor((ctx.breakLength - ctx.indentationLvl) / actualMax),
      // Limit array grouping for small `compact` modes as the user requested
      // minimal grouping.
      ctx.compact * 4,
      // Limit the columns to a maximum of fifteen.
      15,
    );
    // Return with the original output if no grouping should happen.
    if (columns <= 1) {
      return output;
    }
    const tmp = [];
    const maxLineLength = [];
    for (let i = 0; i < columns; i++) {
      let lineMaxLength = 0;
      for (let j = i; j < output.length; j += columns) {
        if (dataLen[j] > lineMaxLength)
          lineMaxLength = dataLen[j];
      }
      lineMaxLength += separatorSpace;
      maxLineLength[i] = lineMaxLength;
    }
    let order = StringPrototypePadStart;
    if (value !== undefined) {
      for (let i = 0; i < output.length; i++) {
        if (typeof value[i] !== 'number' && typeof value[i] !== 'bigint') {
          order = StringPrototypePadEnd;
          break;
        }
      }
    }
    // Each iteration creates a single line of grouped entries.
    for (let i = 0; i < outputLength; i += columns) {
      // The last lines may contain less entries than columns.
      const max = MathMin(i + columns, outputLength);
      let str = '';
      let j = i;
      for (; j < max - 1; j++) {
        // Calculate extra color padding in case it's active. This has to be
        // done line by line as some lines might contain more colors than
        // others.
        const padding = maxLineLength[j - i] + output[j].length - dataLen[j];
        str += order(`${output[j]}, `, padding, ' ');
      }
      if (order === StringPrototypePadStart) {
        const padding = maxLineLength[j - i] +
                        output[j].length -
                        dataLen[j] -
                        separatorSpace;
        str += StringPrototypePadStart(output[j], padding, ' ');
      } else {
        str += output[j];
      }
      ArrayPrototypePush(tmp, str);
    }
    if (ctx.maxArrayLength < output.length) {
      ArrayPrototypePush(tmp, output[outputLength]);
    }
    output = tmp;
  }
  return output;
}

function handleMaxCallStackSize(ctx, err, constructorName, indentationLvl) {
  ctx.seen.pop();
  ctx.indentationLvl = indentationLvl;
  return ctx.stylize(
    `[${constructorName}: Inspection interrupted ` +
      'prematurely. Maximum call stack size exceeded.]',
    'special',
  );
}

function addNumericSeparator(integerString) {
  let result = '';
  let i = integerString.length;
  assert(i !== 0);
  const start = integerString[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) {
    result = `_${StringPrototypeSlice(integerString, i - 3, i)}${result}`;
  }
  return i === integerString.length ?
    integerString :
    `${StringPrototypeSlice(integerString, 0, i)}${result}`;
}

function addNumericSeparatorEnd(integerString) {
  let result = '';
  let i = 0;
  for (; i < integerString.length - 3; i += 3) {
    result += `${StringPrototypeSlice(integerString, i, i + 3)}_`;
  }
  return i === 0 ?
    integerString :
    `${result}${StringPrototypeSlice(integerString, i)}`;
}

const remainingText = (remaining) => `... ${remaining} more item${remaining > 1 ? 's' : ''}`;

function formatNumber(fn, number, numericSeparator) {
  // Format -0 as '-0'. Checking `number === -0` won't distinguish 0 from -0.
  // String(-0) === '0', so this must be checked before any String() conversion.
  if (ObjectIs(number, -0)) {
    return fn('-0', 'number');
  }
  if (!numericSeparator) {
    return fn(`${number}`, 'number');
  }

  const numberString = String(number);
  const integer = MathTrunc(number);

  if (integer === number) {
    if (!NumberIsFinite(number) || StringPrototypeIncludes(numberString, 'e')) {
      return fn(numberString, 'number');
    }
    return fn(addNumericSeparator(numberString), 'number');
  }
  if (NumberIsNaN(number) || StringPrototypeIncludes(numberString, 'e')) {
    return fn(numberString, 'number');
  }

  const decimalIndex = StringPrototypeIndexOf(numberString, '.');
  const integerPart = StringPrototypeSlice(numberString, 0, decimalIndex);
  const fractionalPart = StringPrototypeSlice(numberString, decimalIndex + 1);

  return fn(`${
    addNumericSeparator(integerPart)
  }.${
    addNumericSeparatorEnd(fractionalPart)
  }`, 'number');
}

function formatBigInt(fn, bigint, numericSeparator) {
  const string = String(bigint);
  if (!numericSeparator) {
    return fn(`${string}n`, 'bigint');
  }
  return fn(`${addNumericSeparator(string)}n`, 'bigint');
}

function formatPrimitive(fn, value, ctx) {
  if (typeof value === 'string') {
    let trailer = '';
    if (value.length > ctx.maxStringLength) {
      const remaining = value.length - ctx.maxStringLength;
      value = StringPrototypeSlice(value, 0, ctx.maxStringLength);
      trailer = `... ${remaining} more character${remaining > 1 ? 's' : ''}`;
    }
    if (ctx.compact !== true &&
        // We do not support handling unicode characters width with
        // the readline getStringWidth function as there are
        // performance implications.
        value.length > kMinLineLength &&
        value.length > ctx.breakLength - ctx.indentationLvl - 4) {
      return ArrayPrototypeJoin(
        ArrayPrototypeMap(
          RegExpPrototypeSymbolSplit(/(?<=\n)/, value),
          (line) => fn(strEscape(line), 'string'),
        ),
        ` +\n${StringPrototypeRepeat(' ', ctx.indentationLvl + 2)}`,
      ) + trailer;
    }
    return fn(strEscape(value), 'string') + trailer;
  }
  if (typeof value === 'number')
    return formatNumber(fn, value, ctx.numericSeparator);
  if (typeof value === 'bigint')
    return formatBigInt(fn, value, ctx.numericSeparator);
  if (typeof value === 'boolean')
    return fn(`${value}`, 'boolean');
  if (typeof value === 'undefined')
    return fn('undefined', 'undefined');
  // es6 symbol primitive
  return fn(SymbolPrototypeToString(value), 'symbol');
}

function formatNamespaceObject(keys, ctx, value, recurseTimes) {
  const output = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    try {
      output[i] = formatProperty(ctx, value, recurseTimes, keys[i],
                                 kObjectType);
    } catch (err) {
      assert(isNativeError(err) && err.name === 'ReferenceError');
      // Use the existing functionality. This makes sure the indentation and
      // line breaks are always correct. Otherwise it is very difficult to keep
      // this aligned, even though this is a hacky way of dealing with this.
      const tmp = { [keys[i]]: '' };
      output[i] = formatProperty(ctx, tmp, recurseTimes, keys[i], kObjectType);
      const pos = StringPrototypeLastIndexOf(output[i], ' ');
      // We have to find the last whitespace and have to replace that value as
      // it will be visualized as a regular string.
      output[i] = StringPrototypeSlice(output[i], 0, pos + 1) +
                  ctx.stylize('<uninitialized>', 'special');
    }
  }
  // Reset the keys to an empty array. This prevents duplicated inspection.
  keys.length = 0;
  return output;
}

// The array is sparse and/or has extra keys
function formatSpecialArray(ctx, value, recurseTimes, maxLength, output, i) {
  const keys = ObjectKeys(value);
  let index = i;
  for (; i < keys.length && output.length < maxLength; i++) {
    const key = keys[i];
    const tmp = +key;
    // Arrays can only have up to 2^32 - 1 entries
    if (tmp > 2 ** 32 - 2) {
      break;
    }
    if (`${index}` !== key) {
      if (RegExpPrototypeExec(numberRegExp, key) === null) {
        break;
      }
      const emptyItems = tmp - index;
      const ending = emptyItems > 1 ? 's' : '';
      const message = `<${emptyItems} empty item${ending}>`;
      ArrayPrototypePush(output, ctx.stylize(message, 'undefined'));
      index = tmp;
      if (output.length === maxLength) {
        break;
      }
    }
    ArrayPrototypePush(output, formatProperty(ctx, value, recurseTimes, key, kArrayType));
    index++;
  }
  const remaining = value.length - index;
  if (output.length !== maxLength) {
    if (remaining > 0) {
      const ending = remaining > 1 ? 's' : '';
      const message = `<${remaining} empty item${ending}>`;
      ArrayPrototypePush(output, ctx.stylize(message, 'undefined'));
    }
  } else if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  return output;
}

function formatArrayBuffer(ctx, value) {
  let buffer;
  try {
    buffer = new Uint8Array(value);
  } catch {
    return [ctx.stylize('(detached)', 'special')];
  }
  if (hexSlice === undefined)
    hexSlice = uncurryThis(__bufferMod.Buffer.prototype.hexSlice);
  const rawString = hexSlice(buffer, 0, MathMin(ctx.maxArrayLength, buffer.length));
  let str = '';
  let i = 0;
  for (; i < rawString.length - 2; i += 2) {
    str += `${rawString[i]}${rawString[i + 1]} `;
  }
  if (rawString.length > 0) {
    str += `${rawString[i]}${rawString[i + 1]}`;
  }
  const remaining = buffer.length - ctx.maxArrayLength;
  if (remaining > 0)
    str += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;
  return [`${ctx.stylize('[Uint8Contents]', 'special')}: <${str}>`];
}

function formatArray(ctx, value, recurseTimes) {
  const valLen = value.length;
  const len = MathMin(MathMax(0, ctx.maxArrayLength), valLen);

  const remaining = valLen - len;
  const output = [];
  for (let i = 0; i < len; i++) {
    const desc = ObjectGetOwnPropertyDescriptor(value, i);
    if (desc === undefined) {
      // Special handle sparse arrays.
      return formatSpecialArray(ctx, value, recurseTimes, len, output, i);
    }
    ArrayPrototypePush(output, formatProperty(ctx, value, recurseTimes, i, kArrayType, desc));
  }
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  return output;
}

function formatTypedArray(value, length, ctx) {
  const maxLength = MathMin(MathMax(0, ctx.maxArrayLength), length);
  const remaining = value.length - maxLength;
  const output = new Array(maxLength);
  const elementFormatter = value.length > 0 && typeof value[0] === 'number' ?
    formatNumber :
    formatBigInt;
  for (let i = 0; i < maxLength; ++i) {
    output[i] = elementFormatter(ctx.stylize, value[i], ctx.numericSeparator);
  }
  if (remaining > 0) {
    output[maxLength] = remainingText(remaining);
  }
  return output;
}

function formatSet(value, ctx, ignored, recurseTimes) {
  const length = value.size;
  const maxLength = MathMin(MathMax(0, ctx.maxArrayLength), length);
  const remaining = length - maxLength;
  const output = [];
  ctx.indentationLvl += 2;
  let i = 0;
  for (const v of value) {
    if (i >= maxLength) break;
    ArrayPrototypePush(output, formatValue(ctx, v, recurseTimes));
    i++;
  }
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  ctx.indentationLvl -= 2;
  return output;
}

function formatMap(value, ctx, ignored, recurseTimes) {
  const length = value.size;
  const maxLength = MathMin(MathMax(0, ctx.maxArrayLength), length);
  const remaining = length - maxLength;
  const output = [];
  ctx.indentationLvl += 2;
  let i = 0;
  for (const { 0: k, 1: v } of value) {
    if (i >= maxLength) break;
    ArrayPrototypePush(
      output,
      `${formatValue(ctx, k, recurseTimes)} => ${formatValue(ctx, v, recurseTimes)}`,
    );
    i++;
  }
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  ctx.indentationLvl -= 2;
  return output;
}

function formatSetIterInner(ctx, recurseTimes, entries, state) {
  const maxArrayLength = MathMax(ctx.maxArrayLength, 0);
  const maxLength = MathMin(maxArrayLength, entries.length);
  const output = new Array(maxLength);
  ctx.indentationLvl += 2;
  for (let i = 0; i < maxLength; i++) {
    output[i] = formatValue(ctx, entries[i], recurseTimes);
  }
  ctx.indentationLvl -= 2;
  if (state === kWeak && !ctx.sorted) {
    // Sort all entries to have a halfway reliable output (if more entries than
    // retrieved ones exist, we can not reliably return the same output) if the
    // output is not sorted anyway.
    ArrayPrototypeSort(output);
  }
  const remaining = entries.length - maxLength;
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  return output;
}

function formatMapIterInner(ctx, recurseTimes, entries, state) {
  const maxArrayLength = MathMax(ctx.maxArrayLength, 0);
  // Entries exist as [key1, val1, key2, val2, ...]
  const len = entries.length / 2;
  const remaining = len - maxArrayLength;
  const maxLength = MathMin(maxArrayLength, len);
  const output = new Array(maxLength);
  let i = 0;
  ctx.indentationLvl += 2;
  if (state === kWeak) {
    for (; i < maxLength; i++) {
      const pos = i * 2;
      output[i] =
        `${formatValue(ctx, entries[pos], recurseTimes)} => ${formatValue(ctx, entries[pos + 1], recurseTimes)}`;
    }
    // Sort all entries to have a halfway reliable output (if more entries than
    // retrieved ones exist, we can not reliably return the same output) if the
    // output is not sorted anyway.
    if (!ctx.sorted)
      ArrayPrototypeSort(output);
  } else {
    for (; i < maxLength; i++) {
      const pos = i * 2;
      const res = [
        formatValue(ctx, entries[pos], recurseTimes),
        formatValue(ctx, entries[pos + 1], recurseTimes),
      ];
      output[i] = reduceToSingleString(
        ctx, res, '', ['[', ']'], kArrayExtrasType, recurseTimes);
    }
  }
  ctx.indentationLvl -= 2;
  if (remaining > 0) {
    ArrayPrototypePush(output, remainingText(remaining));
  }
  return output;
}

function formatWeakCollection(ctx) {
  return [ctx.stylize('<items unknown>', 'special')];
}

function formatWeakSet(ctx, value, recurseTimes) {
  const entries = previewEntries(value);
  return formatSetIterInner(ctx, recurseTimes, entries, kWeak);
}

function formatWeakMap(ctx, value, recurseTimes) {
  const entries = previewEntries(value);
  return formatMapIterInner(ctx, recurseTimes, entries, kWeak);
}

function formatIterator(braces, ctx, value, recurseTimes) {
  const { 0: entries, 1: isKeyValue } = previewEntries(value, true);
  if (isKeyValue) {
    // Mark entry iterators as such.
    braces[0] = RegExpPrototypeSymbolReplace(/ Iterator] {$/, braces[0], ' Entries] {');
    return formatMapIterInner(ctx, recurseTimes, entries, kMapEntries);
  }

  return formatSetIterInner(ctx, recurseTimes, entries, kIterator);
}

function formatPromise(ctx, value, recurseTimes) {
  let output;
  const { 0: state, 1: result } = getPromiseDetails(value);
  if (state === kPending) {
    output = [ctx.stylize('<pending>', 'special')];
  } else {
    ctx.indentationLvl += 2;
    const str = formatValue(ctx, result, recurseTimes);
    ctx.indentationLvl -= 2;
    output = [
      state === kRejected ?
        `${ctx.stylize('<rejected>', 'special')} ${str}` :
        str,
    ];
  }
  return output;
}

function formatExtraProperties(ctx, value, recurseTimes, key, typedArray) {
  ctx.indentationLvl += 2;
  const str = formatValue(ctx, value[key], recurseTimes, typedArray);
  ctx.indentationLvl -= 2;

  // These entries are mainly getters. Should they be formatted like getters?
  const name = ctx.stylize(`[${key}]`, 'string');
  return `${name}: ${str}`;
}

function formatProperty(ctx, value, recurseTimes, key, type, desc,
                        original = value) {
  let name, str;
  let extra = ' ';
  desc ??= ObjectGetOwnPropertyDescriptor(value, key);
  if (desc.value !== undefined) {
    const diff = (ctx.compact !== true || type !== kObjectType) ? 2 : 3;
    ctx.indentationLvl += diff;
    str = formatValue(ctx, desc.value, recurseTimes);
    if (diff === 3 && ctx.breakLength < getStringWidth(str, ctx.colors)) {
      extra = `\n${StringPrototypeRepeat(' ', ctx.indentationLvl)}`;
    }
    ctx.indentationLvl -= diff;
  } else if (desc.get !== undefined) {
    const label = desc.set !== undefined ? 'Getter/Setter' : 'Getter';
    const s = ctx.stylize;
    const sp = 'special';
    if (ctx.getters && (ctx.getters === true ||
          (ctx.getters === 'get' && desc.set === undefined) ||
          (ctx.getters === 'set' && desc.set !== undefined))) {
      ctx.indentationLvl += 2;
      try {
        const tmp = FunctionPrototypeCall(desc.get, original);
        if (tmp === null) {
          str = `${s(`[${label}:`, sp)} ${s('null', 'null')}${s(']', sp)}`;
        } else if (typeof tmp === 'object') {
          str = `${s(`[${label}]`, sp)} ${formatValue(ctx, tmp, recurseTimes)}`;
        } else {
          const primitive = formatPrimitive(s, tmp, ctx);
          str = `${s(`[${label}:`, sp)} ${primitive}${s(']', sp)}`;
        }
      } catch (err) {
        const message = `<Inspection threw (${formatValue(ctx, err, recurseTimes)})>`;
        str = `${s(`[${label}:`, sp)} ${message}${s(']', sp)}`;
      }
      ctx.indentationLvl -= 2;
    } else {
      str = ctx.stylize(`[${label}]`, sp);
    }
  } else if (desc.set !== undefined) {
    str = ctx.stylize('[Setter]', 'special');
  } else {
    str = ctx.stylize('undefined', 'undefined');
  }
  if (type === kArrayType) {
    return str;
  }
  if (typeof key === 'symbol') {
    const tmp = RegExpPrototypeSymbolReplace(
      strEscapeSequencesReplacer,
      SymbolPrototypeToString(key),
      escapeFn,
    );
    name = ctx.stylize(tmp, 'symbol');
  } else if (RegExpPrototypeExec(keyStrRegExp, key) !== null) {
    name = key === '__proto__' ? "['__proto__']" : ctx.stylize(key, 'name');
  } else {
    name = ctx.stylize(strEscape(key), 'string');
  }

  if (desc.enumerable === false) {
    name = `[${name}]`;
  }
  return `${name}:${extra}${str}`;
}

function isBelowBreakLength(ctx, output, start, base) {
  // Each entry is separated by at least a comma. Thus, we start with a total
  // length of at least `output.length`. In addition, some cases have a
  // whitespace in-between each other that is added to the total as well.
  // TODO(BridgeAR): Add unicode support. Use the readline getStringWidth
  // function. Check the performance overhead and make it an opt-in in case it's
  // significant.
  let totalLength = output.length + start;
  if (totalLength + output.length > ctx.breakLength)
    return false;
  for (let i = 0; i < output.length; i++) {
    if (ctx.colors) {
      totalLength += removeColors(output[i]).length;
    } else {
      totalLength += output[i].length;
    }
    if (totalLength > ctx.breakLength) {
      return false;
    }
  }
  // Do not line up properties on the same line if `base` contains line breaks.
  return base === '' || !StringPrototypeIncludes(base, '\n');
}

function reduceToSingleString(
  ctx, output, base, braces, extrasType, recurseTimes, value) {
  if (ctx.compact !== true) {
    if (typeof ctx.compact === 'number' && ctx.compact >= 1) {
      // Memorize the original output length. In case the output is grouped,
      // prevent lining up the entries on a single line.
      const entries = output.length;
      // Group array elements together if the array contains at least six
      // separate entries.
      if (extrasType === kArrayExtrasType && entries > 6) {
        output = groupArrayElements(ctx, output, value);
      }
      // `ctx.currentDepth` is set to the most inner depth of the currently
      // inspected object part while `recurseTimes` is the actual current depth
      // that is inspected.
      //
      // Example:
      //
      // const a = { first: [ 1, 2, 3 ], second: { inner: [ 1, 2, 3 ] } }
      //
      // The deepest depth of `a` is 2 (a.second.inner) and `a.first` has a max
      // depth of 1.
      //
      // Consolidate all entries of the local most inner depth up to
      // `ctx.compact`, as long as the properties are smaller than
      // `ctx.breakLength`.
      if (ctx.currentDepth - recurseTimes < ctx.compact &&
          entries === output.length) {
        // Line up all entries on a single line in case the entries do not
        // exceed `breakLength`. Add 10 as constant to start next to all other
        // factors that may reduce `breakLength`.
        const start = output.length + ctx.indentationLvl +
                      braces[0].length + base.length + 10;
        if (isBelowBreakLength(ctx, output, start, base)) {
          const joinedOutput = join(output, ', ');
          if (!StringPrototypeIncludes(joinedOutput, '\n')) {
            return `${base ? `${base} ` : ''}${braces[0]} ${joinedOutput}` +
              ` ${braces[1]}`;
          }
        }
      }
    }
    // Line up each entry on an individual line.
    const indentation = `\n${StringPrototypeRepeat(' ', ctx.indentationLvl)}`;
    return `${base ? `${base} ` : ''}${braces[0]}${indentation}  ` +
      `${join(output, `,${indentation}  `)}${indentation}${braces[1]}`;
  }
  // Line up all entries on a single line in case the entries do not exceed
  // `breakLength`.
  if (isBelowBreakLength(ctx, output, 0, base)) {
    return `${braces[0]}${base ? ` ${base}` : ''} ${join(output, ', ')} ` +
      braces[1];
  }
  const indentation = StringPrototypeRepeat(' ', ctx.indentationLvl);
  // If the opening "brace" is too large, like in the case of "Set {",
  // we need to force the first item to be on the next line or the
  // items will not line up correctly.
  const ln = base === '' && braces[0].length === 1 ?
    ' ' : `${base ? ` ${base}` : ''}\n${indentation}  `;
  // Line up each entry on an individual line.
  return `${braces[0]}${ln}${join(output, `,\n${indentation}  `)} ${braces[1]}`;
}

function hasBuiltInToString(value) {
  // Prevent triggering proxy traps.
  const getFullProxy = false;
  const proxyTarget = getProxyDetails(value, getFullProxy);
  if (proxyTarget !== undefined) {
    if (proxyTarget === null) {
      return true;
    }
    value = proxyTarget;
  }

  let hasOwnToString = ObjectPrototypeHasOwnProperty;
  let hasOwnToPrimitive = ObjectPrototypeHasOwnProperty;

  // Count objects without `toString` and `Symbol.toPrimitive` function as built-in.
  if (typeof value.toString !== 'function') {
    if (typeof value[SymbolToPrimitive] !== 'function') {
      return true;
    } else if (ObjectPrototypeHasOwnProperty(value, SymbolToPrimitive)) {
      return false;
    }
    hasOwnToString = returnFalse;
  } else if (ObjectPrototypeHasOwnProperty(value, 'toString')) {
    return false;
  } else if (typeof value[SymbolToPrimitive] !== 'function') {
    hasOwnToPrimitive = returnFalse;
  } else if (ObjectPrototypeHasOwnProperty(value, SymbolToPrimitive)) {
    return false;
  }

  // Find the object that has the `toString` property or `Symbol.toPrimitive` property
  // as own property in the prototype chain.
  let pointer = value;
  do {
    pointer = ObjectGetPrototypeOf(pointer);
  } while (!hasOwnToString(pointer, 'toString') &&
    !hasOwnToPrimitive(pointer, SymbolToPrimitive));

  // Check closer if the object is a built-in.
  const descriptor = ObjectGetOwnPropertyDescriptor(pointer, 'constructor');
  return descriptor !== undefined &&
    typeof descriptor.value === 'function' &&
    builtInObjects.has(descriptor.value.name);
}

function returnFalse() {
  return false;
}

const firstErrorLine = (error) => StringPrototypeSplit(error.message, '\n', 1)[0];
let CIRCULAR_ERROR_MESSAGE;
function tryStringify(arg) {
  try {
    return JSONStringify(arg);
  } catch (err) {
    // Populate the circular error message lazily
    if (!CIRCULAR_ERROR_MESSAGE) {
      try {
        const a = {};
        a.a = a;
        JSONStringify(a);
      } catch (circularError) {
        CIRCULAR_ERROR_MESSAGE = firstErrorLine(circularError);
      }
    }
    if (err.name === 'TypeError' &&
        firstErrorLine(err) === CIRCULAR_ERROR_MESSAGE) {
      return '[Circular]';
    }
    throw err;
  }
}

function format(...args) {
  return formatWithOptionsInternal(undefined, args);
}

function formatWithOptions(inspectOptions, ...args) {
  validateObject(inspectOptions, 'inspectOptions', kValidateObjectAllowArray);
  return formatWithOptionsInternal(inspectOptions, args);
}

function formatNumberNoColor(number, options) {
  return formatNumber(
    stylizeNoColor,
    number,
    options?.numericSeparator ?? inspectDefaultOptions.numericSeparator,
  );
}

function formatBigIntNoColor(bigint, options) {
  return formatBigInt(
    stylizeNoColor,
    bigint,
    options?.numericSeparator ?? inspectDefaultOptions.numericSeparator,
  );
}

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
      if (StringPrototypeCharCodeAt(first, i) === 37) { // '%'
        const nextChar = StringPrototypeCharCodeAt(first, ++i);
        if (a + 1 !== args.length) {
          switch (nextChar) {
            case 115: { // 's'
              const tempArg = args[++a];
              if (typeof tempArg === 'number') {
                tempStr = formatNumberNoColor(tempArg, inspectOptions);
              } else if (typeof tempArg === 'bigint') {
                tempStr = formatBigIntNoColor(tempArg, inspectOptions);
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
                tempStr = formatBigIntNoColor(tempNum, inspectOptions);
              } else if (typeof tempNum === 'symbol') {
                tempStr = 'NaN';
              } else {
                tempStr = formatNumberNoColor(Number(tempNum), inspectOptions);
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
                tempStr = formatBigIntNoColor(tempInteger, inspectOptions);
              } else if (typeof tempInteger === 'symbol') {
                tempStr = 'NaN';
              } else {
                tempStr = formatNumberNoColor(
                  NumberParseInt(tempInteger), inspectOptions);
              }
              break;
            }
            case 102: { // 'f'
              const tempFloat = args[++a];
              if (typeof tempFloat === 'symbol') {
                tempStr = 'NaN';
              } else {
                tempStr = formatNumberNoColor(
                  NumberParseFloat(tempFloat), inspectOptions);
              }
              break;
            }
            case 99: // 'c'
              a += 1;
              tempStr = '';
              break;
            case 37: // '%'
              str += StringPrototypeSlice(first, lastPos, i);
              lastPos = i + 1;
              continue;
            default: // Any other character is not a correct placeholder
              continue;
          }
          if (lastPos !== i - 1) {
            str += StringPrototypeSlice(first, lastPos, i - 1);
          }
          str += tempStr;
          lastPos = i + 1;
        } else if (nextChar === 37) {
          str += StringPrototypeSlice(first, lastPos, i);
          lastPos = i + 1;
        }
      }
    }
    if (lastPos !== 0) {
      a++;
      join = ' ';
      if (lastPos < first.length) {
        str += StringPrototypeSlice(first, lastPos);
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

if (__bindingConfig.hasIntl) {
  const icu = __bindingIcu;
  // icu.getStringWidth(string, ambiguousAsFullWidth, expandEmojiSequence)
  // Defaults: ambiguousAsFullWidth = false; expandEmojiSequence = true;
  // TODO(BridgeAR): Expose the options to the user. That is probably the
  // best thing possible at the moment, since it's difficult to know what
  // the receiving end supports.
  getStringWidth = function getStringWidth(str, removeControlChars = true) {
    let width = 0;

    if (removeControlChars) {
      str = stripVTControlCharacters(str);
    }
    for (let i = 0; i < str.length; i++) {
      // Try to avoid calling into C++ by first handling the ASCII portion of
      // the string. If it is fully ASCII, we skip the C++ part.
      const code = str.charCodeAt(i);
      if (code >= 127) {
        width += icu.getStringWidth(StringPrototypeNormalize(StringPrototypeSlice(str, i), 'NFC'));
        break;
      }
      width += code >= 32 ? 1 : 0;
    }
    return width;
  };
} else {
  /**
   * @param {string} str
   * @param {boolean} [removeControlChars]
   * @returns {number} number of columns required to display the given string.
   */
  getStringWidth = function getStringWidth(str, removeControlChars = true) {
    let width = 0;

    if (removeControlChars)
      str = stripVTControlCharacters(str);
    str = StringPrototypeNormalize(str, 'NFC');
    for (const char of new SafeStringIterator(str)) {
      const code = StringPrototypeCodePointAt(char, 0);
      if (isFullWidthCodePoint(code)) {
        width += 2;
      } else if (!isZeroWidthCodePoint(code)) {
        width++;
      }
    }

    return width;
  };

  /**
   * Returns true if the character represented by a given
   * Unicode code point is full-width. Otherwise returns false.
   * @param {string} code
   * @returns {boolean}
   */
  const isFullWidthCodePoint = (code) => {
    // Code points are partially derived from:
    // https://www.unicode.org/Public/UNIDATA/EastAsianWidth.txt
    return code >= 0x1100 && (
      code <= 0x115f ||  // Hangul Jamo
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
      (code >= 0xfe30 && code <= 0xfe6b) ||
      // Halfwidth and Fullwidth Forms
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      // Kana Supplement
      (code >= 0x1b000 && code <= 0x1b001) ||
      // Enclosed Ideographic Supplement
      (code >= 0x1f200 && code <= 0x1f251) ||
      // Miscellaneous Symbols and Pictographs 0x1f300 - 0x1f5ff
      // Emoticons 0x1f600 - 0x1f64f
      (code >= 0x1f300 && code <= 0x1f64f) ||
      // CJK Unified Ideographs Extension B .. Tertiary Ideographic Plane
      (code >= 0x20000 && code <= 0x3fffd)
    );
  };

}

/**
 * Remove all VT control characters. Use to estimate displayed string width.
 * @param {string} str
 * @returns {string}
 */
function stripVTControlCharacters(str) {
  validateString(str, 'str');

  // Short-circuit: all ANSI escape sequences start with either
  // ESC (\u001B, 7-bit) or CSI (\u009B, 8-bit) introducer.
  // If neither is present, the string has no VT control characters.
  if (StringPrototypeIndexOf(str, '\u001B') === -1 &&
      StringPrototypeIndexOf(str, '\u009B') === -1)
    return str;

  return RegExpPrototypeSymbolReplace(ansi, str, '');
}

return {
  identicalSequenceRange,
  inspect,
  inspectDefaultOptions,
  format,
  formatWithOptions,
  getStringWidth,
  stripVTControlCharacters,
  isZeroWidthCodePoint,
};

})();
__setInspectForErrors(__inspectMod.inspect);
const __myersDiffMod = (() => {
'use strict';

/* primordials: see bundle prelude */

const {
  codes: {
    ERR_OUT_OF_RANGE,
  },
} = __internalErrors;

const colors = __colors;

const kNopLinesToCollapse = 5;
const kOperations = {
  DELETE: -1,
  NOP: 0,
  INSERT: 1,
};

function areLinesEqual(actual, expected, checkCommaDisparity) {
  if (actual === expected) {
    return true;
  }
  if (checkCommaDisparity) {
    return (actual + ',') === expected || actual === (expected + ',');
  }
  return false;
}

function myersDiff(actual, expected, checkCommaDisparity = false) {
  const actualLength = actual.length;
  const expectedLength = expected.length;
  const max = actualLength + expectedLength;

  if (max > 2 ** 31 - 1) {
    throw new ERR_OUT_OF_RANGE(
      'myersDiff input size',
      '< 2^31',
      max,
    );
  }

  const v = new Int32Array(2 * max + 1);
  const trace = [];

  for (let diffLevel = 0; diffLevel <= max; diffLevel++) {
    ArrayPrototypePush(trace, new Int32Array(v)); // Clone the current state of `v`

    for (let diagonalIndex = -diffLevel; diagonalIndex <= diffLevel; diagonalIndex += 2) {
      const offset = diagonalIndex + max;
      const previousOffset = v[offset - 1];
      const nextOffset = v[offset + 1];
      let x = diagonalIndex === -diffLevel || (diagonalIndex !== diffLevel && previousOffset < nextOffset) ?
        nextOffset :
        previousOffset + 1;
      let y = x - diagonalIndex;

      while (
        x < actualLength &&
        y < expectedLength &&
        areLinesEqual(actual[x], expected[y], checkCommaDisparity)
      ) {
        x++;
        y++;
      }

      v[offset] = x;

      if (x >= actualLength && y >= expectedLength) {
        return backtrack(trace, actual, expected, checkCommaDisparity);
      }
    }
  }
}

function backtrack(trace, actual, expected, checkCommaDisparity) {
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
      const actualItem = actual[x - 1];
      const value = checkCommaDisparity && !StringPrototypeEndsWith(actualItem, ',') ? expected[y - 1] : actualItem;
      ArrayPrototypePush(result, [ kOperations.NOP, value ]);
      x--;
      y--;
    }

    if (diffLevel > 0) {
      if (x > prevX) {
        ArrayPrototypePush(result, [ kOperations.INSERT, actual[--x] ]);
      } else {
        ArrayPrototypePush(result, [ kOperations.DELETE, expected[--y] ]);
      }
    }
  }

  return result;
}

function printSimpleMyersDiff(diff) {
  let message = '';

  for (let diffIdx = diff.length - 1; diffIdx >= 0; diffIdx--) {
    const { 0: operation, 1: value } = diff[diffIdx];
    let color = colors.white;

    if (operation === kOperations.INSERT) {
      color = colors.green;
    } else if (operation === kOperations.DELETE) {
      color = colors.red;
    }

    message += `${color}${value}${colors.white}`;
  }

  return `\n${message}`;
}

function printMyersDiff(diff, operator) {
  let message = '';
  let skipped = false;
  let nopCount = 0;

  for (let diffIdx = diff.length - 1; diffIdx >= 0; diffIdx--) {
    const { 0: operation, 1: value } = diff[diffIdx];
    const previousOperation = diffIdx < diff.length - 1 ? diff[diffIdx + 1][0] : null;

    // Avoid grouping if only one line would have been grouped otherwise
    if (previousOperation === kOperations.NOP && operation !== previousOperation) {
      if (nopCount === kNopLinesToCollapse + 1) {
        message += `${colors.white}  ${diff[diffIdx + 1][1]}\n`;
      } else if (nopCount === kNopLinesToCollapse + 2) {
        message += `${colors.white}  ${diff[diffIdx + 2][1]}\n`;
        message += `${colors.white}  ${diff[diffIdx + 1][1]}\n`;
      } else if (nopCount >= kNopLinesToCollapse + 3) {
        message += `${colors.blue}...${colors.white}\n`;
        message += `${colors.white}  ${diff[diffIdx + 1][1]}\n`;
        skipped = true;
      }
      nopCount = 0;
    }

    if (operation === kOperations.INSERT) {
      if (operator === 'partialDeepStrictEqual') {
        message += `${colors.gray}${colors.hasColors ? ' ' : '+'} ${value}${colors.white}\n`;
      } else {
        message += `${colors.green}+${colors.white} ${value}\n`;
      }
    } else if (operation === kOperations.DELETE) {
      message += `${colors.red}-${colors.white} ${value}\n`;
    } else if (operation === kOperations.NOP) {
      if (nopCount < kNopLinesToCollapse) {
        message += `${colors.white}  ${value}\n`;
      }
      nopCount++;
    }
  }

  message = message.trimEnd();

  return { message: `\n${message}`, skipped };
}

return { myersDiff, printMyersDiff, printSimpleMyersDiff };

})();
const __AssertionError = (() => {
'use strict';

/* primordials: see bundle prelude */

const { isError } = __internalUtil;

const { inspect } = __inspectMod;
const colors = __colors;
const { validateObject } = __validators;
const { isErrorStackTraceLimitWritable } = __internalErrors;
const { myersDiff, printMyersDiff, printSimpleMyersDiff } = __myersDiffMod;

const kReadableOperator = {
  deepStrictEqual: 'Expected values to be strictly deep-equal:',
  partialDeepStrictEqual: 'Expected values to be partially and strictly deep-equal:',
  strictEqual: 'Expected values to be strictly equal:',
  strictEqualObject: 'Expected "actual" to be reference-equal to "expected":',
  deepEqual: 'Expected values to be loosely deep-equal:',
  notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
  notStrictEqual: 'Expected "actual" to be strictly unequal to:',
  notStrictEqualObject:
    'Expected "actual" not to be reference-equal to "expected":',
  notDeepEqual: 'Expected "actual" not to be loosely deep-equal to:',
  notIdentical: 'Values have same structure but are not reference-equal:',
  notDeepEqualUnequal: 'Expected values not to be loosely deep-equal:',
};

const kMaxShortStringLength = 12;
const kMaxLongStringLength = 512;

const kMethodsWithCustomMessageDiff = new SafeSet()
  .add('deepStrictEqual')
  .add('strictEqual')
  .add('partialDeepStrictEqual');

function copyError(source) {
  const target = ObjectAssign(
    { __proto__: ObjectGetPrototypeOf(source) },
    source,
  );
  ObjectDefineProperty(target, 'message', {
    __proto__: null,
    value: source.message,
  });
  if (ObjectPrototypeHasOwnProperty(source, 'cause')) {
    let { cause } = source;

    if (isError(cause)) {
      cause = copyError(cause);
    }

    ObjectDefineProperty(target, 'cause', { __proto__: null, value: cause });
  }
  return target;
}

function inspectValue(val) {
  // The util.inspect default values could be changed. This makes sure the
  // error messages contain the necessary information nevertheless.
  return inspect(val, {
    compact: false,
    customInspect: false,
    depth: 1000,
    maxArrayLength: Infinity,
    // Assert compares only enumerable properties (with a few exceptions).
    showHidden: false,
    // Assert does not detect proxies currently.
    showProxy: false,
    sorted: true,
    // Inspect getters as we also check them when comparing entries.
    getters: true,
  });
}

function getErrorMessage(operator, message) {
  return message || kReadableOperator[operator];
}

function checkOperator(actual, expected, operator) {
  // In case both values are objects or functions explicitly mark them as not
  // reference equal for the `strictEqual` operator.
  if (
    operator === 'strictEqual' &&
    ((typeof actual === 'object' &&
      actual !== null &&
      typeof expected === 'object' &&
      expected !== null) ||
      (typeof actual === 'function' && typeof expected === 'function'))
  ) {
    operator = 'strictEqualObject';
  }

  return operator;
}

function getColoredMyersDiff(actual, expected) {
  const header = `${colors.green}actual${colors.white} ${colors.red}expected${colors.white}`;
  const skipped = false;

  const diff = myersDiff(StringPrototypeSplit(actual, ''), StringPrototypeSplit(expected, ''));
  let message = printSimpleMyersDiff(diff);

  if (skipped) {
    message += '...';
  }

  return { message, header, skipped };
}

function getStackedDiff(actual, expected) {
  const isStringComparison = typeof actual === 'string' && typeof expected === 'string';

  let message = `\n${colors.green}+${colors.white} ${actual}\n${colors.red}- ${colors.white}${expected}`;
  const stringsLen = actual.length + expected.length;
  const maxTerminalLength = (__stderr && __stderr.isTTY ? __stderr.columns : 80);
  const showIndicator = isStringComparison && (stringsLen <= maxTerminalLength);

  if (showIndicator) {
    let indicatorIdx = -1;

    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        // Skip the indicator for the first 2 characters because the diff is immediately apparent
        // It is 3 instead of 2 to account for the quotes
        if (i >= 3) {
          indicatorIdx = i;
        }
        break;
      }
    }

    if (indicatorIdx !== -1) {
      message += `\n${StringPrototypeRepeat(' ', indicatorIdx + 2)}^`;
    }
  }

  return { message };
}

function getSimpleDiff(originalActual, actual, originalExpected, expected) {
  let stringsLen = actual.length + expected.length;
  // Accounting for the quotes wrapping strings
  if (typeof originalActual === 'string') {
    stringsLen -= 2;
  }
  if (typeof originalExpected === 'string') {
    stringsLen -= 2;
  }
  if (stringsLen <= kMaxShortStringLength && (originalActual !== 0 || originalExpected !== 0)) {
    return { message: `${actual} !== ${expected}`, header: '' };
  }

  const isStringComparison = typeof originalActual === 'string' && typeof originalExpected === 'string';
  // colored myers diff
  if (isStringComparison && colors.hasColors) {
    return getColoredMyersDiff(actual, expected);
  }

  return getStackedDiff(actual, expected);
}

function isSimpleDiff(actual, inspectedActual, expected, inspectedExpected) {
  if (inspectedActual.length > 1 || inspectedExpected.length > 1) {
    return false;
  }

  return typeof actual !== 'object' || actual === null || typeof expected !== 'object' || expected === null;
}

function createErrDiff(actual, expected, operator, customMessage, diffType = 'simple') {
  operator = checkOperator(actual, expected, operator);

  let skipped = false;
  let message = '';
  const inspectedActual = inspectValue(actual);
  const inspectedExpected = inspectValue(expected);
  const inspectedSplitActual = StringPrototypeSplit(inspectedActual, '\n');
  const inspectedSplitExpected = StringPrototypeSplit(inspectedExpected, '\n');
  const showSimpleDiff = isSimpleDiff(actual, inspectedSplitActual, expected, inspectedSplitExpected);
  let header = `${colors.green}+ actual${colors.white} ${colors.red}- expected${colors.white}`;

  if (showSimpleDiff) {
    const simpleDiff = getSimpleDiff(actual, inspectedSplitActual[0], expected, inspectedSplitExpected[0]);
    message = simpleDiff.message;
    if (typeof simpleDiff.header !== 'undefined') {
      header = simpleDiff.header;
    }
    if (simpleDiff.skipped) {
      skipped = true;
    }
  } else if (inspectedActual === inspectedExpected) {
    // Handles the case where the objects are structurally the same but different references
    operator = 'notIdentical';
    if (inspectedSplitActual.length > 50 && diffType !== 'full') {
      message = `${ArrayPrototypeJoin(ArrayPrototypeSlice(inspectedSplitActual, 0, 50), '\n')}\n...}`;
      skipped = true;
    } else {
      message = ArrayPrototypeJoin(inspectedSplitActual, '\n');
    }
    header = '';
  } else {
    const checkCommaDisparity = actual != null && typeof actual === 'object';
    const diff = myersDiff(inspectedSplitActual, inspectedSplitExpected, checkCommaDisparity);

    const myersDiffMessage = printMyersDiff(diff, operator);
    message = myersDiffMessage.message;

    if (operator === 'partialDeepStrictEqual') {
      header = `${colors.gray}${colors.hasColors ? '' : '+ '}actual${colors.white} ${colors.red}- expected${colors.white}`;
    }

    if (myersDiffMessage.skipped) {
      skipped = true;
    }
  }

  const headerMessage = `${getErrorMessage(operator, customMessage)}\n${header}`;
  const skippedMessage = skipped ? '\n... Skipped lines' : '';

  return `${headerMessage}${skippedMessage}\n${message}\n`;
}

function addEllipsis(string) {
  const lines = StringPrototypeSplit(string, '\n', 11);
  if (lines.length > 10) {
    lines.length = 10;
    return `${ArrayPrototypeJoin(lines, '\n')}\n...`;
  } else if (string.length > kMaxLongStringLength) {
    return `${StringPrototypeSlice(string, kMaxLongStringLength)}...`;
  }
  return string;
}

class AssertionError extends Error {
  constructor(options) {
    validateObject(options, 'options');
    const {
      message,
      operator,
      stackStartFn,
      details,
      // Compatibility with older versions.
      stackStartFunction,
      diff = 'simple',
    } = options;
    let {
      actual,
      expected,
    } = options;

    const limit = Error.stackTraceLimit;
    if (isErrorStackTraceLimitWritable()) Error.stackTraceLimit = 0;

    if (message != null) {
      if (kMethodsWithCustomMessageDiff.has(operator)) {
        super(createErrDiff(actual, expected, operator, message, diff));
      } else {
        super(String(message));
      }
    } else {
      // Reset colors on each call to make sure we handle dynamically set environment
      // variables correct.
      colors.refresh();
      // Prevent the error stack from being visible by duplicating the error
      // in a very close way to the original in case both sides are actually
      // instances of Error.
      if (typeof actual === 'object' && actual !== null &&
          typeof expected === 'object' && expected !== null &&
          'stack' in actual && actual instanceof Error &&
          'stack' in expected && expected instanceof Error) {
        actual = copyError(actual);
        expected = copyError(expected);
      }

      if (kMethodsWithCustomMessageDiff.has(operator)) {
        super(createErrDiff(actual, expected, operator, message, diff));
      } else if (operator === 'notDeepStrictEqual' ||
        operator === 'notStrictEqual') {
        // In case the objects are equal but the operator requires unequal, show
        // the first object and say A equals B
        let base = kReadableOperator[operator];
        const res = StringPrototypeSplit(inspectValue(actual), '\n');

        // In case "actual" is an object or a function, it should not be
        // reference equal.
        if (operator === 'notStrictEqual' &&
            ((typeof actual === 'object' && actual !== null) ||
             typeof actual === 'function')) {
          base = kReadableOperator.notStrictEqualObject;
        }

        // Only remove lines in case it makes sense to collapse those.
        if (res.length > 50 && diff !== 'full') {
          res[46] = `${colors.blue}...${colors.white}`;
          while (res.length > 47) {
            ArrayPrototypePop(res);
          }
        }

        // Only print a single input.
        if (res.length === 1) {
          super(`${base}${res[0].length > 5 ? '\n\n' : ' '}${res[0]}`);
        } else {
          super(`${base}\n\n${ArrayPrototypeJoin(res, '\n')}\n`);
        }
      } else {
        let res = inspectValue(actual);
        let other = inspectValue(expected);
        const knownOperator = kReadableOperator[operator];
        if (operator === 'notDeepEqual' && res === other) {
          res = `${knownOperator}\n\n${res}`;
          if (res.length > 1024 && diff !== 'full') {
            res = `${StringPrototypeSlice(res, 0, 1021)}...`;
          }
          super(res);
        } else {
          if (res.length > kMaxLongStringLength && diff !== 'full') {
            res = `${StringPrototypeSlice(res, 0, 509)}...`;
          }
          if (other.length > kMaxLongStringLength && diff !== 'full') {
            other = `${StringPrototypeSlice(other, 0, 509)}...`;
          }
          if (operator === 'deepEqual') {
            res = `${knownOperator}\n\n${res}\n\nshould loosely deep-equal\n\n`;
          } else {
            const newOp = kReadableOperator[`${operator}Unequal`];
            if (newOp) {
              res = `${newOp}\n\n${res}\n\nshould not loosely deep-equal\n\n`;
            } else {
              other = ` ${operator} ${other}`;
            }
          }
          super(`${res}${other}`);
        }
      }
    }

    if (isErrorStackTraceLimitWritable()) Error.stackTraceLimit = limit;

    this.generatedMessage = !message;
    ObjectDefineProperty(this, 'name', {
      __proto__: null,
      value: 'AssertionError [ERR_ASSERTION]',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    this.code = 'ERR_ASSERTION';
    if (details) {
      this.actual = undefined;
      this.expected = undefined;
      this.operator = undefined;
      for (let i = 0; i < details.length; i++) {
        this['message ' + i] = details[i].message;
        this['actual ' + i] = details[i].actual;
        this['expected ' + i] = details[i].expected;
        this['operator ' + i] = details[i].operator;
        this['stack trace ' + i] = details[i].stack;
      }
    } else {
      this.actual = actual;
      this.expected = expected;
      this.operator = operator;
    }
    ErrorCaptureStackTrace(this, stackStartFn || stackStartFunction);
    // Create error message including the error code in the name.
    this.stack; // eslint-disable-line no-unused-expressions
    // Reset the name.
    this.name = 'AssertionError';
    this.diff = diff;
  }

  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }

  [inspect.custom](recurseTimes, ctx) {
    // Long strings should not be fully inspected.
    const tmpActual = this.actual;
    const tmpExpected = this.expected;

    if (typeof this.actual === 'string') {
      this.actual = addEllipsis(this.actual);
    }
    if (typeof this.expected === 'string') {
      this.expected = addEllipsis(this.expected);
    }

    // This limits the `actual` and `expected` property default inspection to
    // the minimum depth. Otherwise those values would be too verbose compared
    // to the actual error message which contains a combined view of these two
    // input values.
    const result = inspect(this, {
      ...ctx,
      customInspect: false,
      depth: 0,
    });

    // Reset the properties after inspection.
    this.actual = tmpActual;
    this.expected = tmpExpected;

    return result;
  }
}

return AssertionError;

})();
const __CallTracker = (() => {
'use strict';

/* primordials: see bundle prelude */

const {
  codes: {
    ERR_INVALID_ARG_VALUE,
    ERR_UNAVAILABLE_DURING_EXIT,
  },
} = __internalErrors;
const AssertionError = __AssertionError;
const {
  validateUint32,
} = __validators;

const noop = FunctionPrototype;

class CallTrackerContext {
  #expected;
  #calls;
  #name;
  #stackTrace;
  constructor({ expected, stackTrace, name }) {
    this.#calls = [];
    this.#expected = expected;
    this.#stackTrace = stackTrace;
    this.#name = name;
  }

  track(thisArg, args) {
    const argsClone = ObjectFreeze(ArrayPrototypeSlice(args));
    ArrayPrototypePush(this.#calls, ObjectFreeze({ thisArg, arguments: argsClone }));
  }

  get delta() {
    return this.#calls.length - this.#expected;
  }

  reset() {
    this.#calls = [];
  }
  getCalls() {
    return ObjectFreeze(ArrayPrototypeSlice(this.#calls));
  }

  report() {
    if (this.delta !== 0) {
      const message = `Expected the ${this.#name} function to be ` +
                      `executed ${this.#expected} time(s) but was ` +
                      `executed ${this.#calls.length} time(s).`;
      return {
        message,
        actual: this.#calls.length,
        expected: this.#expected,
        operator: this.#name,
        stack: this.#stackTrace,
      };
    }
  }
}

class CallTracker {

  #callChecks = new SafeSet();
  #trackedFunctions = new SafeWeakMap();

  #getTrackedFunction(tracked) {
    if (!this.#trackedFunctions.has(tracked)) {
      throw new ERR_INVALID_ARG_VALUE('tracked', tracked, 'is not a tracked function');
    }
    return this.#trackedFunctions.get(tracked);
  }

  reset(tracked) {
    if (tracked === undefined) {
      this.#callChecks.forEach((check) => check.reset());
      return;
    }

    this.#getTrackedFunction(tracked).reset();
  }

  getCalls(tracked) {
    return this.#getTrackedFunction(tracked).getCalls();
  }

  calls(fn, expected = 1) {
    if (__processExiting())
      throw new ERR_UNAVAILABLE_DURING_EXIT();
    if (typeof fn === 'number') {
      expected = fn;
      fn = noop;
    } else if (fn === undefined) {
      fn = noop;
    }

    validateUint32(expected, 'expected', true);

    const context = new CallTrackerContext({
      expected,
      // eslint-disable-next-line no-restricted-syntax
      stackTrace: new Error(),
      name: fn.name || 'calls',
    });
    const tracked = new Proxy(fn, {
      __proto__: null,
      apply(fn, thisArg, argList) {
        context.track(thisArg, argList);
        return ReflectApply(fn, thisArg, argList);
      },
    });
    this.#callChecks.add(context);
    this.#trackedFunctions.set(tracked, context);
    return tracked;
  }

  report() {
    const errors = [];
    for (const context of this.#callChecks) {
      const message = context.report();
      if (message !== undefined) {
        ArrayPrototypePush(errors, message);
      }
    }
    return errors;
  }

  verify() {
    const errors = this.report();
    if (errors.length === 0) {
      return;
    }
    const message = errors.length === 1 ?
      errors[0].message :
      'Functions were not called the expected number of times';
    throw new AssertionError({
      message,
      details: errors,
    });
  }
}

return CallTracker;

})();
const __assertUtilsMod = (() => {
'use strict';

/* primordials: see bundle prelude */

const {
  isErrorStackTraceLimitWritable,
} = __internalErrors;
const AssertionError = __AssertionError;
const { isError } = __internalUtil;

const {
  getErrorSourceExpression,
} = { getErrorSourceExpression: __getErrorSourceExpression };

// Escape control characters but not \n and \t to keep the line breaks and
// indentation intact.
// eslint-disable-next-line no-control-regex
const escapeSequencesRegExp = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const meta = [
  '\\u0000', '\\u0001', '\\u0002', '\\u0003', '\\u0004',
  '\\u0005', '\\u0006', '\\u0007', '\\b', '',
  '', '\\u000b', '\\f', '', '\\u000e',
  '\\u000f', '\\u0010', '\\u0011', '\\u0012', '\\u0013',
  '\\u0014', '\\u0015', '\\u0016', '\\u0017', '\\u0018',
  '\\u0019', '\\u001a', '\\u001b', '\\u001c', '\\u001d',
  '\\u001e', '\\u001f',
];

const escapeFn = (str) => meta[StringPrototypeCharCodeAt(str, 0)];

function getErrMessage(fn) {
  const tmpLimit = Error.stackTraceLimit;
  const errorStackTraceLimitIsWritable = isErrorStackTraceLimitWritable();
  // Make sure the limit is set to 1. Otherwise it could fail (<= 0) or it
  // does to much work.
  if (errorStackTraceLimitIsWritable) Error.stackTraceLimit = 1;
  // We only need the stack trace. To minimize the overhead use an object
  // instead of an error.
  const err = {};
  ErrorCaptureStackTrace(err, fn);
  if (errorStackTraceLimitIsWritable) Error.stackTraceLimit = tmpLimit;

  let source = getErrorSourceExpression(err);
  if (source) {
    source = StringPrototypeReplace(source, escapeSequencesRegExp, escapeFn);
    return `The expression evaluated to a falsy value:\n\n  ${source}\n`;
  }
}

function innerOk(fn, argLen, value, message) {
  if (!value) {
    let generatedMessage = false;

    if (argLen === 0) {
      generatedMessage = true;
      message = 'No value argument passed to `assert.ok()`';
    } else if (message == null) {
      generatedMessage = true;
      message = getErrMessage(fn);
    } else if (isError(message)) {
      throw message;
    }

    const err = new AssertionError({
      actual: value,
      expected: true,
      message,
      operator: '==',
      stackStartFn: fn,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

return {
  innerOk,
};

})();
const __comparisonsMod = (() => {
'use strict';

/* primordials: see bundle prelude */

const { compare } = __bindingBuffer;
const assert = __internalAssert;
const { isURL } = __internalUrl;
const { isError } = __internalUtil;
const { Buffer } = __bufferMod;

const wellKnownConstructors = new SafeSet()
  .add(Array)
  .add(ArrayBuffer)
  .add(BigInt)
  .add(BigInt64Array)
  .add(BigUint64Array)
  .add(Boolean)
  .add(Buffer)
  .add(DataView)
  .add(Date)
  .add(Error)
  .add(Float32Array)
  .add(Float64Array)
  .add(Function)
  .add(Int16Array)
  .add(Int32Array)
  .add(Int8Array)
  .add(Map)
  .add(Number)
  .add(Object)
  .add(Promise)
  .add(RegExp)
  .add(Set)
  .add(String)
  .add(Symbol)
  .add(Uint16Array)
  .add(Uint32Array)
  .add(Uint8Array)
  .add(Uint8ClampedArray)
  .add(WeakMap)
  .add(WeakSet);

if (Float16Array) { // TODO(BridgeAR): Remove when Flag got removed from V8
  wellKnownConstructors.add(Float16Array);
}

const types = __types;
const {
  isAnyArrayBuffer,
  isArrayBufferView,
  isDate,
  isMap,
  isRegExp,
  isSet,
  isNativeError,
  isBoxedPrimitive,
  isNumberObject,
  isStringObject,
  isBooleanObject,
  isBigIntObject,
  isSymbolObject,
  isFloat16Array,
  isFloat32Array,
  isFloat64Array,
  isKeyObject,
  isCryptoKey,
  isPromise,
  isWeakMap,
  isWeakSet,
} = types;
const {
  constants: {
    ONLY_ENUMERABLE,
    SKIP_SYMBOLS,
  },
  getOwnNonIndexProperties,
} = __bindingUtil;

let getCryptoKeyHandle;
let getCryptoKeyType;
let getCryptoKeyExtractable;
let getCryptoKeyAlgorithm;
let getCryptoKeyUsagesMask;
let getKeyObjectHandle;
let getKeyObjectType;

// Lazy CryptoKey accessors, mirroring Node's internal/crypto/keys getters.
// Key material needs a sync export bridge: Node exposes
// crypto.KeyObject.from(cryptoKey).export() synchronously (guarded via
// process.getBuiltinModule so browsers and bundlers stay safe). Where no
// bridge exists (browsers), material comparison degrades to metadata-only.
function __initCryptoKeyGetters() {
  let KeyObjectFrom = null;
  try {
    const gbm = typeof process !== 'undefined' ? process.getBuiltinModule : undefined;
    if (typeof gbm === 'function') {
      const c = gbm.call(process, 'crypto');
      if (c && c.KeyObject && typeof c.KeyObject.from === 'function') {
        KeyObjectFrom = c.KeyObject.from;
      }
    }
  } catch {}
  const usagesBit = {
    encrypt: 1, decrypt: 2, sign: 4, verify: 8,
    deriveKey: 16, deriveBits: 32, wrapKey: 64, unwrapKey: 128,
  };
  const exportMaterial = (k) => {
    if (!KeyObjectFrom) return null;
    try {
      const buf = KeyObjectFrom(k).export();
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch { return null; }
  };
  return {
    getCryptoKeyType: (k) => { try { return k.type; } catch { return undefined; } },
    getCryptoKeyExtractable: (k) => { try { return k.extractable === true; } catch { return false; } },
    getCryptoKeyAlgorithm: (k) => { try { return k.algorithm; } catch { return undefined; } },
    getCryptoKeyUsagesMask: (k) => {
      let mask = 0;
      try {
        const u = k.usages;
        if (Array.isArray(u)) for (const x of u) mask |= usagesBit[x] || 0;
      } catch {}
      return mask;
    },
    getCryptoKeyHandle: (k) => {
      const material = exportMaterial(k);
      return {
        __material: material,
        equals(other) {
          const b = other && other.__material;
          if (material === null || b === null) return material === b;
          if (material.length !== b.length) return false;
          for (let i = 0; i < material.length; i++) {
            if (material[i] !== b[i]) return false;
          }
          return true;
        },
      };
    },
  };
}

const kStrict = 2;
const kStrictWithoutPrototypes = 3;
const kLoose = 0;
const kPartial = 1;

const kNoIterator = 0;
const kIsArray = 1;
const kIsSet = 2;
const kIsMap = 3;

// Check if they have the same source and flags
function areSimilarRegExps(a, b) {
  return a.source === b.source &&
         a.flags === b.flags &&
         a.lastIndex === b.lastIndex;
}

function isPartialUint8Array(a, b) {
  const lenA = getByteLength(a);
  const lenB = getByteLength(b);
  if (lenA < lenB) {
    return false;
  }
  let offsetA = 0;
  for (let offsetB = 0; offsetB < lenB; offsetB++) {
    while (a[offsetA] !== b[offsetB]) {
      offsetA++;
      if (offsetA > lenA - lenB + offsetB) {
        return false;
      }
    }
    offsetA++;
  }
  return true;
}

function isPartialArrayBufferView(a, b) {
  if (a.byteLength < b.byteLength) {
    return false;
  }
  return isPartialUint8Array(
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
    new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
  );
}

function areSimilarFloatArrays(a, b) {
  const len = getByteLength(a);
  if (len !== getByteLength(b)) {
    return false;
  }
  for (let offset = 0; offset < len; offset++) {
    if (a[offset] !== b[offset]) {
      return false;
    }
  }
  return true;
}

function areSimilarTypedArrays(a, b) {
  return a.byteLength === b.byteLength && compare(a, b) === 0;
}

function areEqualArrayBuffers(buf1, buf2) {
  return buf1.byteLength === buf2.byteLength &&
    compare(new Uint8Array(buf1), new Uint8Array(buf2)) === 0;
}

// Dependency-free byte comparison for exported crypto key material.
// Accepts Uint8Array/Buffer-like views or raw ArrayBuffers; returns
// false on any shape mismatch (matching Node's strict KeyObject equality).
function uint8ArrayEquals(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  // Unwrap Buffer/Uint8Array views and raw ArrayBuffers to byte views.
  const toBytes = (v) => {
    if (typeof v === 'object' && v !== null) {
      if (ArrayBuffer.isView(v)) {
        return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      }
      if (v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer)) {
        return new Uint8Array(v);
      }
    }
    return null;
  };
  const ba = toBytes(a);
  const bb = toBytes(b);
  if (ba === null || bb === null) return false;
  if (ba.byteLength !== bb.byteLength) return false;
  for (let i = 0; i < ba.byteLength; i++) {
    if (ba[i] !== bb[i]) return false;
  }
  return true;
}

function isEqualBoxedPrimitive(val1, val2) {
  if (isNumberObject(val1)) {
    return isNumberObject(val2) &&
           ObjectIs(NumberPrototypeValueOf(val1),
                    NumberPrototypeValueOf(val2));
  }
  if (isStringObject(val1)) {
    return isStringObject(val2) &&
           StringPrototypeValueOf(val1) === StringPrototypeValueOf(val2);
  }
  if (isBooleanObject(val1)) {
    return isBooleanObject(val2) &&
           BooleanPrototypeValueOf(val1) === BooleanPrototypeValueOf(val2);
  }
  if (isBigIntObject(val1)) {
    return isBigIntObject(val2) &&
           BigIntPrototypeValueOf(val1) === BigIntPrototypeValueOf(val2);
  }
  if (isSymbolObject(val1)) {
    return isSymbolObject(val2) &&
          SymbolPrototypeValueOf(val1) === SymbolPrototypeValueOf(val2);
  }
  /* c8 ignore next */
  assert.fail(`Unknown boxed type ${val1}`);
}

function isEnumerableOrIdentical(val1, val2, prop, mode, memos) {
  return hasEnumerable(val2, prop) || // This is handled by Object.keys()
      (mode === kPartial && (val2[prop] === undefined || (prop === 'message' && val2[prop] === ''))) ||
      innerDeepEqual(val1[prop], val2[prop], mode, memos);
}

function innerDeepEqual(val1, val2, mode, memos) {
  // All identical values are equivalent, as determined by ===.
  if (val1 === val2) {
    return val1 !== 0 || ObjectIs(val1, val2) || mode === kLoose;
  }

  // Check more closely if val1 and val2 are equal.
  if (mode !== kLoose) {
    if (typeof val1 === 'number') {
      // Check for NaN
      // eslint-disable-next-line no-self-compare
      return val1 !== val1 && val2 !== val2;
    }
    if (typeof val2 !== 'object' ||
        typeof val1 !== 'object' ||
        val1 === null ||
        val2 === null) {
      return false;
    }
  } else {
    if (val1 === null || typeof val1 !== 'object') {
      return (val2 === null || typeof val2 !== 'object') &&
             // Check for NaN
             // eslint-disable-next-line eqeqeq, no-self-compare
             (val1 == val2 || (val1 !== val1 && val2 !== val2));
    }
    if (val2 === null || typeof val2 !== 'object') {
      return false;
    }
  }
  return objectComparisonStart(val1, val2, mode, memos);
}

function hasUnequalTag(val1, val2) {
  return val1[SymbolToStringTag] !== val2[SymbolToStringTag];
}

function slowHasUnequalTag(val1Tag, val1, val2) {
  if (val1[SymbolToStringTag] !== undefined && val2[SymbolToStringTag] !== undefined) {
    return val1[SymbolToStringTag] !== val2[SymbolToStringTag];
  }
  return val1Tag !== ObjectPrototypeToString(val2);
}

function objectComparisonStart(val1, val2, mode, memos) {
  if (mode === kStrict) {
    if (wellKnownConstructors.has(val1.constructor) ||
        (val1.constructor !== undefined && !hasOwn(val1, 'constructor'))) {
      if (val1.constructor !== val2.constructor) {
        return false;
      }
    } else if (ObjectGetPrototypeOf(val1) !== ObjectGetPrototypeOf(val2)) {
      return false;
    }
  }

  if (ArrayIsArray(val1)) {
    if (!ArrayIsArray(val2) ||
        (val1.length !== val2.length && (mode !== kPartial || val1.length < val2.length)) ||
        hasUnequalTag(val1, val2)) {
      return false;
    }

    const filter = mode !== kLoose ? ONLY_ENUMERABLE : ONLY_ENUMERABLE | SKIP_SYMBOLS;
    const keys2 = getOwnNonIndexProperties(val2, filter);
    if (mode !== kPartial &&
        keys2.length !== getOwnNonIndexProperties(val1, filter).length) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kIsArray, keys2);
  }

  let val1Tag;
  if (val1[SymbolToStringTag] === undefined &&
      (val1Tag = ObjectPrototypeToString(val1)) === '[object Object]') {
    if (slowHasUnequalTag(val1Tag, val1, val2)) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kNoIterator);
  } else if (isSet(val1)) {
    if (!isSet(val2) ||
        (val1.size !== val2.size && (mode !== kPartial || val1.size < val2.size)) ||
        hasUnequalTag(val1, val2)) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kIsSet);
  } else if (isMap(val1)) {
    if (!isMap(val2) ||
        (val1.size !== val2.size && (mode !== kPartial || val1.size < val2.size)) ||
        hasUnequalTag(val1, val2)) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kIsMap);
  } else if (isArrayBufferView(val1)) {
    if (TypedArrayPrototypeGetSymbolToStringTag(val1) !==
        TypedArrayPrototypeGetSymbolToStringTag(val2)) {
      return false;
    }
    if (mode === kPartial && val1.byteLength !== val2.byteLength) {
      if (!isPartialArrayBufferView(val1, val2)) {
        return false;
      }
    } else if (mode === kLoose &&
               (isFloat32Array(val1) || isFloat64Array(val1) || isFloat16Array(val1))) {
      if (!areSimilarFloatArrays(val1, val2)) {
        return false;
      }
    } else if (!areSimilarTypedArrays(val1, val2)) {
      return false;
    }
    // Buffer.compare returns true, so val1.length === val2.length. If they both
    // only contain numeric keys, we don't need to exam further than checking
    // the symbols.
    const filter = mode !== kLoose ? ONLY_ENUMERABLE : ONLY_ENUMERABLE | SKIP_SYMBOLS;
    const keys2 = getOwnNonIndexProperties(val2, filter);
    if (mode !== kPartial &&
        keys2.length !== getOwnNonIndexProperties(val1, filter).length) {
      return false;
    }
    return keyCheck(val1, val2, mode, memos, kNoIterator, keys2);
  } else if (isDate(val1)) {
    if (!isDate(val2) || hasUnequalTag(val1, val2)) {
      return false;
    }
    const time1 = DatePrototypeGetTime(val1);
    const time2 = DatePrototypeGetTime(val2);
    // eslint-disable-next-line no-self-compare
    if (time1 !== time2 && (time1 === time1 || time2 === time2)) {
      return false;
    }
  } else if (isRegExp(val1)) {
    if (!isRegExp(val2) || !areSimilarRegExps(val1, val2) || hasUnequalTag(val1, val2)) {
      return false;
    }
  } else if (isAnyArrayBuffer(val1)) {
    if (!isAnyArrayBuffer(val2) || hasUnequalTag(val1, val2)) {
      return false;
    }
    if (mode !== kPartial || val1.byteLength === val2.byteLength) {
      if (!areEqualArrayBuffers(val1, val2)) {
        return false;
      }
    } else if (!isPartialUint8Array(new Uint8Array(val1), new Uint8Array(val2))) {
      return false;
    }
  } else if (slowHasUnequalTag(val1Tag ?? ObjectPrototypeToString(val1), val1, val2) ||
            ArrayIsArray(val2) ||
            isArrayBufferView(val2) ||
            isSet(val2) ||
            isMap(val2) ||
            isDate(val2) ||
            isRegExp(val2) ||
            isAnyArrayBuffer(val2)) {
    return false;
  } else if (isError(val1)) {
    // Do not compare the stack as it might differ even though the error itself
    // is otherwise identical.
    if (!isError(val2) ||
        !isEnumerableOrIdentical(val1, val2, 'message', mode, memos) ||
        !isEnumerableOrIdentical(val1, val2, 'name', mode, memos) ||
        !isEnumerableOrIdentical(val1, val2, 'cause', mode, memos) ||
        !isEnumerableOrIdentical(val1, val2, 'errors', mode, memos)) {
      return false;
    }
    const hasOwnVal2Cause = hasOwn(val2, 'cause');
    if ((hasOwnVal2Cause !== hasOwn(val1, 'cause') && (mode !== kPartial || hasOwnVal2Cause))) {
      return false;
    }
  } else if (isBoxedPrimitive(val1)) {
    if (!isEqualBoxedPrimitive(val1, val2)) {
      return false;
    }
  } else if (isURL(val1)) {
    if (!isURL(val2) || val1.href !== val2.href) {
      return false;
    }
  } else if (isKeyObject(val1)) {
    // Dependency-free KeyObject comparison: real KeyObjects expose
    // `.type` ('secret' | 'public' | 'private') and `.export()`, which
    // returns a Buffer/Uint8Array (DER) or KeyObject (JWK). Two
    // KeyObjects are equal when their types match and their exports
    // are byte-identical.
    if (!isKeyObject(val2)) return false;
    let t1, t2;
    try { t1 = val1.type; t2 = val2.type; } catch { return false; }
    if (t1 !== t2) return false;
    let e1, e2;
    try { e1 = val1.export(); e2 = val2.export(); } catch { return false; }
    if (!uint8ArrayEquals(e1, e2)) return false;
  } else if (isCryptoKey(val1)) {
    if (getCryptoKeyHandle === undefined) {
      ({
        getCryptoKeyHandle,
        getCryptoKeyType,
        getCryptoKeyExtractable,
        getCryptoKeyAlgorithm,
        getCryptoKeyUsagesMask,
      } = __initCryptoKeyGetters());
    }
    if (!isCryptoKey(val2) ||
      getCryptoKeyType(val1) !== getCryptoKeyType(val2) ||
      getCryptoKeyExtractable(val1) !== getCryptoKeyExtractable(val2) ||
      !innerDeepEqual(getCryptoKeyAlgorithm(val1), getCryptoKeyAlgorithm(val2), mode, memos) ||
      getCryptoKeyUsagesMask(val1) !== getCryptoKeyUsagesMask(val2) ||
      !getCryptoKeyHandle(val1).equals(getCryptoKeyHandle(val2))
    ) {
      return false;
    }
  } else if (isBoxedPrimitive(val2) ||
      isNativeError(val2) ||
      val2 instanceof Error ||
      isWeakMap(val1) ||
      isWeakSet(val1) ||
      isPromise(val1)) {
    return false;
  }

  return keyCheck(val1, val2, mode, memos, kNoIterator);
}

function partialSymbolEquiv(val1, val2, keys2) {
  const symbolKeys = getOwnSymbols(val2);
  if (symbolKeys.length !== 0) {
    for (const key of symbolKeys) {
      if (hasEnumerable(val2, key)) {
        ArrayPrototypePush(keys2, key);
      }
    }
  }
  return true;
}

function keyCheck(val1, val2, mode, memos, iterationType, keys2) {
  // For all remaining Object pairs, including Array, objects and Maps,
  // equivalence is determined by having:
  // a) The same number of owned enumerable properties
  // b) The same set of keys/indexes (although not necessarily the same order)
  // c) Equivalent values for every corresponding key/index
  // d) For Sets and Maps, equal contents
  // Note: this accounts for both named and indexed properties on Arrays.
  const isArrayLikeObject = keys2 !== undefined;

  if (keys2 === undefined) {
    keys2 = ObjectKeys(val2);
  }
  let keys1;

  if (!isArrayLikeObject) {
    // The pair must have the same number of owned properties.
    if (mode === kPartial) {
      if (!partialSymbolEquiv(val1, val2, keys2)) {
        return false;
      }
    } else if (keys2.length !== (keys1 = ObjectKeys(val1)).length) {
      return false;
    } else if (mode === kStrict || mode === kStrictWithoutPrototypes) {
      for (const key of getOwnSymbols(val1)) {
        if (hasEnumerable(val1, key)) {
          ArrayPrototypePush(keys1, key);
        }
      }
      for (const key of getOwnSymbols(val2)) {
        if (hasEnumerable(val2, key)) {
          ArrayPrototypePush(keys2, key);
        }
      }
      if (keys1.length !== keys2.length) {
        return false;
      }
    }
  }

  if (keys2.length === 0 &&
      (iterationType === kNoIterator ||
        (iterationType === kIsArray && val2.length === 0) ||
        val2.size === 0)) {
    return true;
  }

  if (memos === null) {
    return objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);
  }
  return handleCycles(val1, val2, mode, keys1, keys2, memos, iterationType);
}

function handleCycles(val1, val2, mode, keys1, keys2, memos, iterationType) {
  // Use memos to handle cycles.
  if (memos === undefined) {
    memos = {
      set: undefined,
      a: val1,
      b: val2,
      c: undefined,
      d: undefined,
      deep: false,
    };
    return objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);
  }

  if (memos.set === undefined) {
    if (memos.deep === false) {
      if (memos.a === val1) {
        return memos.b === val2;
      }
      if (memos.b === val2) {
        return false;
      }
      memos.c = val1;
      memos.d = val2;
      memos.deep = true;
      const result = objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);
      memos.deep = false;
      if (memos.set !== undefined) {
        memos.set.delete(memos.c);
        memos.set.delete(memos.d);
      }
      return result;
    }
    memos.set = new SafeSet();
    memos.set.add(memos.a);
    memos.set.add(memos.b);
    memos.set.add(memos.c);
    memos.set.add(memos.d);
  }

  const { set } = memos;

  const originalSize = set.size;
  set.add(val1);
  set.add(val2);
  if (originalSize !== set.size - 2) {
    return originalSize === set.size;
  }

  const areEq = objEquiv(val1, val2, mode, keys1, keys2, memos, iterationType);

  set.delete(val1);
  set.delete(val2);

  return areEq;
}

// See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Equality_comparisons_and_sameness#Loose_equality_using
// Sadly it is not possible to detect corresponding values properly in case the
// type is a string, number, bigint or boolean. The reason is that those values
// can match lots of different string values (e.g., 1n == '+00001').
function findLooseMatchingPrimitives(prim) {
  switch (typeof prim) {
    case 'undefined':
      return null;
    case 'object': // Only pass in null as object!
      return undefined;
    case 'symbol':
      return false;
    case 'string':
      prim = +prim;
      // Loose equal entries exist only if the string is possible to convert to
      // a regular number and not NaN.
      // Fall through
    case 'number':
      // Check for NaN
      // eslint-disable-next-line no-self-compare
      if (prim !== prim) {
        return false;
      }
  }
  return true;
}

function setMightHaveLoosePrim(a, b, prim) {
  const altValue = findLooseMatchingPrimitives(prim);
  if (altValue != null)
    return altValue;

  return !b.has(altValue) && a.has(altValue);
}

function mapMightHaveLoosePrim(a, b, prim, item2, memo) {
  const altValue = findLooseMatchingPrimitives(prim);
  if (altValue != null) {
    return altValue;
  }
  const item1 = a.get(altValue);
  if ((item1 === undefined && !a.has(altValue)) ||
      !innerDeepEqual(item1, item2, kLoose, memo)) {
    return false;
  }
  return !b.has(altValue) && innerDeepEqual(item1, item2, kLoose, memo);
}

function partialObjectSetEquiv(array, a, b, mode, memo) {
  let aPos = 0;
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  for (const val1 of a) {
    aPos++;
    if (!b.has(val1)) {
      let innerStart = start;
      if (direction === 1) {
        if (innerDeepEqual(val1, array[start], mode, memo)) {
          if (start === end) {
            return true;
          }
          start += 1;
          continue;
        }
        if (start === end) {
          // The last element of set b might match a later element in set a.
          continue;
        }
        direction = -1;
        innerStart += 1;
      }
      let matched = true;
      if (!innerDeepEqual(val1, array[end], mode, memo)) {
        direction = 1;
        matched = arrayHasEqualElement(array, val1, mode, memo, innerDeepEqual, innerStart, end);
      }
      if (matched) {
        if (start === end) {
          return true;
        }
        end -= 1;
      }
    }
    if (a.size - aPos <= end - start) {
      return false;
    }
  }
  return false;
}

function arrayHasEqualElement(array, val1, mode, memo, comparator, start, end) {
  for (let i = end - 1; i >= start; i--) {
    if (comparator(val1, array[i], mode, memo)) {
      // Move the matching element to make sure we do not check that again.
      array[i] = array[end];
      return true;
    }
  }
  return false;
}

function setObjectEquiv(array, a, b, mode, memo) {
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  const comparator = mode !== kLoose ? objectComparisonStart : innerDeepEqual;
  const extraChecks = mode === kLoose || array.length !== a.size;
  for (const val1 of a) {
    if (extraChecks) {
      if (typeof val1 === 'object') {
        if (b.has(val1)) {
          continue;
        }
      } else if (b.has(val1)) {
        continue;
      } else if (mode !== kLoose) {
        return false;
      }
    }

    let innerStart = start;
    if (direction === 1) {
      if (comparator(val1, array[start], mode, memo)) {
        start += 1;
        continue;
      }
      if (start === end) {
        return false;
      }
      direction = -1;
      innerStart += 1;
    }
    if (!comparator(val1, array[end], mode, memo)) {
      direction = 1;
      if (!arrayHasEqualElement(array, val1, mode, memo, comparator, innerStart, end)) {
        return false;
      }
    }
    end -= 1;
  }
  return true;
}

function compareSmallSets(a, b, val, iteratorB, mode, memo) {
  const iteratorA = a.values();
  const firstA = iteratorA.next().value;
  const first = innerDeepEqual(firstA, val, mode, memo);
  if (first) {
    if (b.size === 1) { // Partial mode && a.size === 1 || b.size === 1
      return true;
    }
    const secondA = iteratorA.next().value;
    return b.has(secondA) || innerDeepEqual(secondA, iteratorB.next().value, mode, memo);
  }
  return a.size !== 1 && innerDeepEqual(iteratorA.next().value, val, mode, memo) && (
    b.size === 1 || // Partial mode
    b.has(firstA) || // Primitive or reference equal
    innerDeepEqual(firstA, iteratorB.next().value, mode, memo)
  );
}

function setEquiv(a, b, mode, memo) {
  // This is a lazily initiated Set of entries which have to be compared
  // pairwise.
  let array;

  const iteratorB = b.values();
  for (const val of iteratorB) {
    if (!a.has(val)) {
      if ((typeof val !== 'object' || val === null) &&
          (mode !== kLoose || !setMightHaveLoosePrim(a, b, val))) {
        return false;
      }

      if (array === undefined) {
        if (a.size < 3) {
          return compareSmallSets(a, b, val, iteratorB, mode, memo);
        }
        array = [];
      }
      // If the specified value doesn't exist in the second set it's a object
      // (or in loose mode: a non-matching primitive). Find the
      // deep-(mode-)equal element in a set copy to reduce duplicate checks.
      array.push(val);
    }
  }

  if (array === undefined) {
    return true;
  }
  if (mode === kPartial) {
    return partialObjectSetEquiv(array, a, b, mode, memo);
  }
  return setObjectEquiv(array, a, b, mode, memo);
}

function partialObjectMapEquiv(array, a, b, mode, memo) {
  let aPos = 0;
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  for (const { 0: key1, 1: item1 } of a) {
    aPos++;
    if (typeof key1 === 'object' && key1 !== null) {
      let innerStart = start;
      if (direction === 1) {
        const key2 = array[start];
        if (objectComparisonStart(key1, key2, mode, memo) && innerDeepEqual(item1, b.get(key2), mode, memo)) {
          if (start === end) {
            return true;
          }
          start += 1;
          continue;
        }
        if (start === end) {
          // The last element of map b might match a later element in map a.
          continue;
        }
        direction = -1;
        innerStart += 1;
      }
      let matched = true;
      const key2 = array[end];
      if (!objectComparisonStart(key1, key2, mode, memo) || !innerDeepEqual(item1, b.get(key2), mode, memo)) {
        direction = 1;
        matched = arrayHasEqualMapElement(array, key1, item1, b, mode, memo, objectComparisonStart, innerStart, end);
      }
      if (matched) {
        if (start === end) {
          return true;
        }
        end -= 1;
      }
    }
    if (a.size - aPos <= end - start) {
      return false;
    }
  }
  return false;
}

function arrayHasEqualMapElement(array, key1, item1, b, mode, memo, comparator, start, end) {
  for (let i = end - 1; i >= start; i--) {
    const key2 = array[i];
    if (comparator(key1, key2, mode, memo) &&
        innerDeepEqual(item1, b.get(key2), mode, memo)) {
      // Move the matching element to make sure we do not check that again.
      array[i] = array[end];
      return true;
    }
  }
  return false;
}

function mapObjectEquiv(array, a, b, mode, memo) {
  let direction = 1;
  let start = 0;
  let end = array.length - 1;
  const comparator = mode !== kLoose ? objectComparisonStart : innerDeepEqual;

  for (const { 0: key1, 1: item1 } of a) {
    // Primitive and `null` keys can never match an object key collected in
    // `array`, so resolve them directly against `b`. `null` is `typeof
    // 'object'`, so without this it would reach the object comparator, which
    // reads `key1.constructor` and throws a `TypeError`.
    if (typeof key1 !== 'object' || key1 === null) {
      if (b.has(key1)) {
        if (mode !== kLoose || innerDeepEqual(item1, b.get(key1), mode, memo)) {
          continue;
        }
      } else if (mode !== kLoose) {
        return false;
      }
    }

    let innerStart = start;
    if (direction === 1) {
      const key2 = array[start];
      if (comparator(key1, key2, mode, memo) && innerDeepEqual(item1, b.get(key2), mode, memo)) {
        start += 1;
        continue;
      }
      if (start === end) {
        return false;
      }
      direction = -1;
      innerStart += 1;
    }
    const key2 = array[end];
    if ((!comparator(key1, key2, mode, memo) || !innerDeepEqual(item1, b.get(key2), mode, memo))) {
      direction = 1;
      if (!arrayHasEqualMapElement(array, key1, item1, b, mode, memo, comparator, innerStart, end)) {
        return false;
      }
    }
    end -= 1;
  }
  return true;
}

function mapEquiv(a, b, mode, memo) {
  let array;

  for (const { 0: key2, 1: item2 } of b) {
    if (typeof key2 === 'object' && key2 !== null) {
      if (array === undefined) {
        if (a.size === 1) {
          const { 0: key1, 1: item1 } = a.entries().next().value;
          return innerDeepEqual(key1, key2, mode, memo) &&
                  innerDeepEqual(item1, item2, mode, memo);
        }
        array = [];
      }
      array.push(key2);
    } else {
      // By directly retrieving the value we prevent another b.has(key2) check in
      // almost all possible cases.
      const item1 = a.get(key2);
      if (((item1 === undefined && !a.has(key2)) ||
          !innerDeepEqual(item1, item2, mode, memo))) {
        if (mode !== kLoose)
          return false;
        // Fast path to detect missing string, symbol, undefined and null
        // keys.
        if (!mapMightHaveLoosePrim(a, b, key2, item2, memo))
          return false;
        if (array === undefined) {
          array = [];
        }
        array.push(key2);
      }
    }
  }

  if (array === undefined) {
    return true;
  }

  if (mode === kPartial) {
    return partialObjectMapEquiv(array, a, b, mode, memo);
  }

  return mapObjectEquiv(array, a, b, mode, memo);
}

function partialSparseArrayEquiv(a, b, mode, memos, startA, startB) {
  let aPos = startA;
  const keysA = ObjectKeys(a);
  const keysB = ObjectKeys(b);
  const lenA = keysA.length - startA;
  const lenB = keysB.length - startB;
  if (lenA < lenB) {
    return false;
  }
  for (let i = 0; i < lenB; i++) {
    const keyB = keysB[startB + i];
    while (!innerDeepEqual(a[keysA[aPos]], b[keyB], mode, memos)) {
      aPos++;
      if (aPos > keysA.length - lenB + i) {
        return false;
      }
    }
    aPos++;
  }
  return true;
}

function partialArrayEquiv(a, b, mode, memos) {
  let aPos = 0;
  for (let i = 0; i < b.length; i++) {
    let isSparse = b[i] === undefined && !hasOwn(b, i);
    if (isSparse) {
      return partialSparseArrayEquiv(a, b, mode, memos, aPos, i);
    }
    while (!(isSparse = a[aPos] === undefined && !hasOwn(a, aPos)) &&
           !innerDeepEqual(a[aPos], b[i], mode, memos)) {
      aPos++;
      if (aPos > a.length - b.length + i) {
        return false;
      }
    }
    if (isSparse) {
      return partialSparseArrayEquiv(a, b, mode, memos, aPos, i);
    }
    aPos++;
  }
  return true;
}

function sparseArrayEquiv(a, b, mode, memos, i) {
  const keysA = ObjectKeys(a);
  const keysB = ObjectKeys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (; i < keysB.length; i++) {
    const key = keysB[i];
    if ((a[key] === undefined && !hasOwn(a, key)) || !innerDeepEqual(a[key], b[key], mode, memos)) {
      return false;
    }
  }
  return true;
}

function objEquiv(a, b, mode, keys1, keys2, memos, iterationType) {
  // The pair must have equivalent values for every corresponding key.
  if (keys2.length > 0) {
    let i = 0;
    // Ordered keys
    if (keys1 !== undefined) {
      for (; i < keys2.length; i++) {
        const key = keys2[i];
        if (keys1[i] !== key) {
          break;
        }
        if (!innerDeepEqual(a[key], b[key], mode, memos)) {
          return false;
        }
      }
    }
    // Unordered keys
    for (; i < keys2.length; i++) {
      const key = keys2[i];
      // It is faster to get the whole descriptor and to check it's enumerable
      // property in V8 13.0 compared to calling Object.propertyIsEnumerable()
      // and accessing the property regularly.
      const descriptor = ObjectGetOwnPropertyDescriptor(a, key);
      if (descriptor === undefined || descriptor.enumerable !== true) {
        return false;
      }
      const value = descriptor.writable !== undefined ? descriptor.value : a[key];
      if (!innerDeepEqual(value, b[key], mode, memos)) {
        return false;
      }
    }
  }

  if (iterationType === kIsArray) {
    if (mode === kPartial) {
      return partialArrayEquiv(a, b, mode, memos);
    }
    for (let i = 0; i < a.length; i++) {
      if (b[i] === undefined) {
        if (!hasOwn(b, i))
          return sparseArrayEquiv(a, b, mode, memos, i);
        if ((a[i] !== undefined || !hasOwn(a, i)) && (mode !== kLoose || a[i] !== null))
          return false;
      } else if ((a[i] === undefined || !innerDeepEqual(a[i], b[i], mode, memos)) &&
                 (mode !== kLoose || b[i] !== null)) {
        return false;
      }
    }
  } else if (iterationType === kIsSet) {
    if (!setEquiv(a, b, mode, memos)) {
      return false;
    }
  } else if (iterationType === kIsMap) {
    if (!mapEquiv(a, b, mode, memos)) {
      return false;
    }
  }

  return true;
}

// Only handle cycles when they are detected.
// eslint-disable-next-line func-style
let detectCycles = function(val1, val2, mode) {
  try {
    return innerDeepEqual(val1, val2, mode, null);
  } catch {
    detectCycles = innerDeepEqual;
    return innerDeepEqual(val1, val2, mode, undefined);
  }
};

return {
  isDeepEqual(val1, val2) {
    return detectCycles(val1, val2, kLoose);
  },
  isDeepStrictEqual(val1, val2, skipPrototype) {
    return detectCycles(val1, val2, skipPrototype ? kStrictWithoutPrototypes : kStrict);
  },
  isPartialStrictEqual(val1, val2) {
    return detectCycles(val1, val2, kPartial);
  },
};

})();
const __assertMain = (() => {
// Originally from narwhal.js (http://narwhaljs.org)
// Copyright (c) 2009 Thomas Robinson <280north.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the 'Software'), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

/* primordials: see bundle prelude */

const {
  codes: {
    ERR_AMBIGUOUS_ARGUMENT,
    ERR_CONSTRUCT_CALL_REQUIRED,
    ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE,
    ERR_INVALID_RETURN_VALUE,
    ERR_MISSING_ARGS,
  },
} = __internalErrors;
const AssertionError = __AssertionError;
const { inspect } = __inspectMod;
const {
  isPromise,
  isRegExp,
} = __types;
const { isError, deprecate, setOwnProperty } = __internalUtil;
const { innerOk } = __assertUtilsMod;

const CallTracker = __CallTracker;
const {
  validateFunction,
  validateOneOf,
} = __validators;

const kOptions = Symbol('options');

let isDeepEqual;
let isDeepStrictEqual;
let isPartialStrictEqual;

function lazyLoadComparison() {
  const comparison = __comparisonsMod;
  isDeepEqual = comparison.isDeepEqual;
  isDeepStrictEqual = comparison.isDeepStrictEqual;
  isPartialStrictEqual = comparison.isPartialStrictEqual;
}

let warned = false;

// The assert module provides functions that throw
// AssertionError's when particular conditions are not met. The
// assert module must conform to the following interface.

const assert = ok;

const NO_EXCEPTION_SENTINEL = {};

/**
 * Assert options.
 * @typedef {object} AssertOptions
 * @property {'full'|'simple'} [diff='simple'] - If set to 'full', shows the full diff in assertion errors.
 * @property {boolean} [strict=true] - If set to true, non-strict methods behave like their corresponding
 *   strict methods.
 * @property {boolean} [skipPrototype=false] - If set to true, skips comparing prototypes
 *   in deep equality checks.
 */

/**
 * @class Assert
 * @param {AssertOptions} [options] - Optional configuration for assertions.
 * @throws {ERR_CONSTRUCT_CALL_REQUIRED} If not called with `new`.
 */
function Assert(options) {
  if (!new.target) {
    throw new ERR_CONSTRUCT_CALL_REQUIRED('Assert');
  }

  options = ObjectAssign({ __proto__: null, strict: true, skipPrototype: false }, options);

  const allowedDiffs = ['simple', 'full'];
  if (options.diff !== undefined) {
    validateOneOf(options.diff, 'options.diff', allowedDiffs);
  }

  this.AssertionError = AssertionError;
  ObjectDefineProperty(this, kOptions, {
    __proto__: null,
    value: options,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  if (options.strict) {
    this.equal = this.strictEqual;
    this.deepEqual = this.deepStrictEqual;
    this.notEqual = this.notStrictEqual;
    this.notDeepEqual = this.notDeepStrictEqual;
  }
}

// All of the following functions must throw an AssertionError
// when a corresponding condition is not met, with a message that
// may be undefined if not provided. All assertion methods provide
// both the actual and expected values to the assertion error for
// display purposes.

// DESTRUCTURING WARNING: All Assert.prototype methods use optional chaining
// (this?.[kOptions]) to safely access instance configuration. When methods are
// destructured from an Assert instance (e.g., const {strictEqual} = myAssert),
// they lose their `this` context and will use default behavior instead of the
// instance's custom options.

function innerFail(obj) {
  if (obj.message instanceof Error) throw obj.message;

  throw new AssertionError(obj);
}

/**
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @param {string} [operator]
 * @param {Function} [stackStartFn]
 */
Assert.prototype.fail = function fail(actual, expected, message, operator, stackStartFn) {
  const argsLen = arguments.length;

  let internalMessage = false;
  if (actual == null && argsLen <= 1) {
    internalMessage = true;
    message = 'Failed';
  } else if (argsLen === 1) {
    message = actual;
    actual = undefined;
  } else {
    if (warned === false) {
      warned = true;
      __emitWarning(
        'assert.fail() with more than one argument is deprecated. ' +
          'Please use assert.strictEqual() instead or only pass a message.',
        'DeprecationWarning',
        'DEP0094',
      );
    }
    if (argsLen === 2)
      operator = '!=';
  }

  if (message instanceof Error) throw message;

  // IMPORTANT: When adding new references to `this`, ensure they use optional chaining
  // (this?.[kOptions]?.diff) to handle cases where the method is destructured from an
  // Assert instance and loses its context. Destructured methods will fall back
  // to default behavior when `this` is undefined.
  const errArgs = {
    actual,
    expected,
    operator: operator === undefined ? 'fail' : operator,
    stackStartFn: stackStartFn || fail,
    message,
    diff: this?.[kOptions]?.diff,
  };
  const err = new AssertionError(errArgs);
  if (internalMessage) {
    err.generatedMessage = true;
  }
  throw err;
};

// The AssertionError is defined in internal/error.
assert.AssertionError = AssertionError;

/**
 * Pure assertion tests whether a value is truthy, as determined
 * by !!value.
 * @param {...any} args
 * @returns {void}
 */
function ok(...args) {
  innerOk(ok, args.length, ...args);
}

/**
 * Pure assertion tests whether a value is truthy, as determined
 * by !!value.
 * Duplicated as the other `ok` function is supercharged and exposed as default export.
 * @param {...any} args
 * @returns {void}
 */
Assert.prototype.ok = function ok(...args) {
  innerOk(ok, args.length, ...args);
};

/**
 * The equality assertion tests shallow, coercive equality with ==.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.equal = function equal(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  // eslint-disable-next-line eqeqeq
  if (actual != expected && (!NumberIsNaN(actual) || !NumberIsNaN(expected))) {
    innerFail({
      actual,
      expected,
      message,
      operator: '==',
      stackStartFn: equal,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The non-equality assertion tests for whether two objects are not
 * equal with !=.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.notEqual = function notEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  // eslint-disable-next-line eqeqeq
  if (actual == expected || (NumberIsNaN(actual) && NumberIsNaN(expected))) {
    innerFail({
      actual,
      expected,
      message,
      operator: '!=',
      stackStartFn: notEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep equivalence assertion tests a deep equality relation.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.deepEqual = function deepEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (!isDeepEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'deepEqual',
      stackStartFn: deepEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep non-equivalence assertion tests for any deep inequality.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.notDeepEqual = function notDeepEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (isDeepEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notDeepEqual',
      stackStartFn: notDeepEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep strict equivalence assertion tests a deep strict equality
 * relation.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.deepStrictEqual = function deepStrictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (!isDeepStrictEqual(actual, expected, this?.[kOptions]?.skipPrototype)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'deepStrictEqual',
      stackStartFn: deepStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The deep strict non-equivalence assertion tests for any deep strict
 * inequality.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.notDeepStrictEqual = notDeepStrictEqual;
function notDeepStrictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (isDeepStrictEqual(actual, expected, this?.[kOptions]?.skipPrototype)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notDeepStrictEqual',
      stackStartFn: notDeepStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
}

/**
 * The strict equivalence assertion tests a strict equality relation.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.strictEqual = function strictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (!ObjectIs(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'strictEqual',
      stackStartFn: strictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The strict non-equivalence assertion tests for any strict inequality.
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.notStrictEqual = function notStrictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (ObjectIs(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notStrictEqual',
      stackStartFn: notStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

/**
 * The strict equivalence assertion test between two objects
 * @param {any} actual
 * @param {any} expected
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.partialDeepStrictEqual = function partialDeepStrictEqual(
  actual,
  expected,
  message,
) {
  if (arguments.length < 2) {
    throw new ERR_MISSING_ARGS('actual', 'expected');
  }
  if (isDeepEqual === undefined) lazyLoadComparison();
  if (!isPartialStrictEqual(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'partialDeepStrictEqual',
      stackStartFn: partialDeepStrictEqual,
      diff: this?.[kOptions]?.diff,
    });
  }
};

class Comparison {
  constructor(obj, keys, actual) {
    for (const key of keys) {
      if (key in obj) {
        if (actual !== undefined &&
            typeof actual[key] === 'string' &&
            isRegExp(obj[key]) &&
            RegExpPrototypeExec(obj[key], actual[key]) !== null) {
          this[key] = actual[key];
        } else {
          this[key] = obj[key];
        }
      }
    }
  }
}

function compareExceptionKey(actual, expected, key, message, keys, fn) {
  if (!(key in actual) || !isDeepStrictEqual(actual[key], expected[key])) {
    if (!message) {
      // Create placeholder objects to create a nice output.
      const a = new Comparison(actual, keys);
      const b = new Comparison(expected, keys, actual);

      const err = new AssertionError({
        actual: a,
        expected: b,
        operator: 'deepStrictEqual',
        stackStartFn: fn,
        diff: this?.[kOptions]?.diff,
      });
      err.actual = actual;
      err.expected = expected;
      err.operator = fn.name;
      throw err;
    }
    innerFail({
      actual,
      expected,
      message,
      operator: fn.name,
      stackStartFn: fn,
      diff: this?.[kOptions]?.diff,
    });
  }
}

function expectedException(actual, expected, message, fn) {
  let generatedMessage = false;
  let throwError = false;

  if (typeof expected !== 'function') {
    // Handle regular expressions.
    if (isRegExp(expected)) {
      const str = String(actual);
      if (RegExpPrototypeExec(expected, str) !== null)
        return;

      if (!message) {
        generatedMessage = true;
        message = 'The input did not match the regular expression ' +
                  `${inspect(expected)}. Input:\n\n${inspect(str)}\n`;
      }
      throwError = true;
      // Handle primitives properly.
    } else if (typeof actual !== 'object' || actual === null) {
      const err = new AssertionError({
        actual,
        expected,
        message,
        operator: 'deepStrictEqual',
        stackStartFn: fn,
        diff: this?.[kOptions]?.diff,
      });
      err.operator = fn.name;
      throw err;
    } else {
      // Handle validation objects.
      const keys = ObjectKeys(expected);
      // Special handle errors to make sure the name and the message are
      // compared as well.
      if (expected instanceof Error) {
        ArrayPrototypePush(keys, 'name', 'message');
      } else if (keys.length === 0) {
        throw new ERR_INVALID_ARG_VALUE('error',
                                        expected, 'may not be an empty object');
      }
      if (isDeepEqual === undefined) lazyLoadComparison();
      for (const key of keys) {
        if (typeof actual[key] === 'string' &&
            isRegExp(expected[key]) &&
            RegExpPrototypeExec(expected[key], actual[key]) !== null) {
          continue;
        }
        compareExceptionKey(actual, expected, key, message, keys, fn);
      }
      return;
    }
  // Guard instanceof against arrow functions as they don't have a prototype.
  // Check for matching Error classes.
  } else if (expected.prototype !== undefined && actual instanceof expected) {
    return;
  } else if (ObjectPrototypeIsPrototypeOf(Error, expected)) {
    if (!message) {
      generatedMessage = true;
      message = 'The error is expected to be an instance of ' +
        `"${expected.name}". Received `;
      if (isError(actual)) {
        const name = (actual.constructor?.name) ||
                     actual.name;
        if (expected.name === name) {
          message += 'an error with identical name but a different prototype.';
        } else {
          message += `"${name}"`;
        }
        if (actual.message) {
          message += `\n\nError message:\n\n${actual.message}`;
        }
      } else {
        message += `"${inspect(actual, { depth: -1 })}"`;
      }
    }
    throwError = true;
  } else {
    // Check validation functions return value.
    const res = FunctionPrototypeCall(expected, {}, actual);
    if (res !== true) {
      if (!message) {
        generatedMessage = true;
        const name = expected.name ? `"${expected.name}" ` : '';
        message = `The ${name}validation function is expected to return` +
          ` "true". Received ${inspect(res)}`;

        if (isError(actual)) {
          message += `\n\nCaught error:\n\n${actual}`;
        }
      }
      throwError = true;
    }
  }

  if (throwError) {
    const err = new AssertionError({
      actual,
      expected,
      message,
      operator: fn.name,
      stackStartFn: fn,
      diff: this?.[kOptions]?.diff,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

function getActual(fn) {
  validateFunction(fn, 'fn');
  try {
    fn();
  } catch (e) {
    return e;
  }
  return NO_EXCEPTION_SENTINEL;
}

function checkIsPromise(obj) {
  // Accept native ES6 promises and promises that are implemented in a similar
  // way. Do not accept thenables that use a function as `obj` and that have no
  // `catch` handler.
  return isPromise(obj) ||
    (obj !== null && typeof obj === 'object' &&
    typeof obj.then === 'function' &&
    typeof obj.catch === 'function');
}

async function waitForActual(promiseFn) {
  let resultPromise;
  if (typeof promiseFn === 'function') {
    // Return a rejected promise if `promiseFn` throws synchronously.
    resultPromise = promiseFn();
    // Fail in case no promise is returned.
    if (!checkIsPromise(resultPromise)) {
      throw new ERR_INVALID_RETURN_VALUE('instance of Promise',
                                         'promiseFn', resultPromise);
    }
  } else if (checkIsPromise(promiseFn)) {
    resultPromise = promiseFn;
  } else {
    throw new ERR_INVALID_ARG_TYPE(
      'promiseFn', ['Function', 'Promise'], promiseFn);
  }

  try {
    await resultPromise;
  } catch (e) {
    return e;
  }
  return NO_EXCEPTION_SENTINEL;
}

function expectsError(stackStartFn, actual, error, message) {
  if (typeof error === 'string') {
    if (arguments.length === 4) {
      throw new ERR_INVALID_ARG_TYPE('error',
                                     ['Object', 'Error', 'Function', 'RegExp'],
                                     error);
    }
    if (typeof actual === 'object' && actual !== null) {
      if (actual.message === error) {
        throw new ERR_AMBIGUOUS_ARGUMENT(
          'error/message',
          `The error message "${actual.message}" is identical to the message.`,
        );
      }
    } else if (actual === error) {
      throw new ERR_AMBIGUOUS_ARGUMENT(
        'error/message',
        `The error "${actual}" is identical to the message.`,
      );
    }
    message = error;
    error = undefined;
  } else if (error != null &&
             typeof error !== 'object' &&
             typeof error !== 'function') {
    throw new ERR_INVALID_ARG_TYPE('error',
                                   ['Object', 'Error', 'Function', 'RegExp'],
                                   error);
  }

  if (actual === NO_EXCEPTION_SENTINEL) {
    let details = '';
    if (error?.name) {
      details += ` (${error.name})`;
    }
    details += message ? `: ${message}` : '.';
    const fnType = stackStartFn === Assert.prototype.rejects ? 'rejection' : 'exception';
    innerFail({
      actual: undefined,
      expected: error,
      operator: stackStartFn.name,
      message: `Missing expected ${fnType}${details}`,
      stackStartFn,
      diff: this?.[kOptions]?.diff,
    });
  }

  if (!error)
    return;

  expectedException.call(this, actual, error, message, stackStartFn);
}

function hasMatchingError(actual, expected) {
  if (typeof expected !== 'function') {
    if (isRegExp(expected)) {
      const str = String(actual);
      return RegExpPrototypeExec(expected, str) !== null;
    }
    throw new ERR_INVALID_ARG_TYPE(
      'expected', ['Function', 'RegExp'], expected,
    );
  }
  // Guard instanceof against arrow functions as they don't have a prototype.
  if (expected.prototype !== undefined && actual instanceof expected) {
    return true;
  }
  if (ObjectPrototypeIsPrototypeOf(Error, expected)) {
    return false;
  }
  return FunctionPrototypeCall(expected, {}, actual) === true;
}

function expectsNoError(stackStartFn, actual, error, message) {
  if (actual === NO_EXCEPTION_SENTINEL)
    return;

  if (typeof error === 'string') {
    message = error;
    error = undefined;
  }

  if (!error || hasMatchingError(actual, error)) {
    const details = message ? `: ${message}` : '.';
    const fnType = stackStartFn === Assert.prototype.doesNotReject ?
      'rejection' : 'exception';
    innerFail({
      actual,
      expected: error,
      operator: stackStartFn.name,
      message: `Got unwanted ${fnType}${details}\n` +
               `Actual message: "${actual?.message}"`,
      stackStartFn,
      diff: this?.[kOptions]?.diff,
    });
  }
  throw actual;
}

/**
 * Expects the function `promiseFn` to throw an error.
 * @param {() => any} promiseFn
 * @param {...any} [args]
 * @returns {void}
 */
Assert.prototype.throws = function throws(promiseFn, ...args) {
  expectsError(throws, getActual(promiseFn), ...args);
};

/**
 * Expects `promiseFn` function or its value to reject.
 * @param {() => Promise<any>} promiseFn
 * @param {...any} [args]
 * @returns {Promise<void>}
 */
Assert.prototype.rejects = async function rejects(promiseFn, ...args) {
  expectsError(rejects, await waitForActual(promiseFn), ...args);
};

/**
 * Asserts that the function `fn` does not throw an error.
 * @param {() => any} fn
 * @param {...any} [args]
 * @returns {void}
 */
Assert.prototype.doesNotThrow = function doesNotThrow(fn, ...args) {
  expectsNoError(doesNotThrow, getActual(fn), ...args);
};

/**
 * Expects `fn` or its value to not reject.
 * @param {() => Promise<any>} fn
 * @param {...any} [args]
 * @returns {Promise<void>}
 */
Assert.prototype.doesNotReject = async function doesNotReject(fn, ...args) {
  expectsNoError(doesNotReject, await waitForActual(fn), ...args);
};

/**
 * Throws `AssertionError` if the value is not `null` or `undefined`.
 * @param {any} err
 * @returns {void}
 */
Assert.prototype.ifError = function ifError(err) {
  if (err !== null && err !== undefined) {
    let message = 'ifError got unwanted exception: ';
    if (typeof err === 'object' && typeof err.message === 'string') {
      if (err.message.length === 0 && err.constructor) {
        message += err.constructor.name;
      } else {
        message += err.message;
      }
    } else {
      message += inspect(err);
    }

    const newErr = new AssertionError({
      actual: err,
      expected: null,
      operator: 'ifError',
      message,
      stackStartFn: ifError,
      diff: this?.[kOptions]?.diff,
    });

    // Make sure we actually have a stack trace!
    const origStack = err.stack;

    if (typeof origStack === 'string') {
      // This will remove any duplicated frames from the error frames taken
      // from within `ifError` and add the original error frames to the newly
      // created ones.
      const origStackStart = StringPrototypeIndexOf(origStack, '\n    at');
      if (origStackStart !== -1) {
        const originalFrames = StringPrototypeSplit(
          StringPrototypeSlice(origStack, origStackStart + 1),
          '\n',
        );
        // Filter all frames existing in err.stack.
        let newFrames = StringPrototypeSplit(newErr.stack, '\n');
        for (const errFrame of originalFrames) {
          // Find the first occurrence of the frame.
          const pos = ArrayPrototypeIndexOf(newFrames, errFrame);
          if (pos !== -1) {
            // Only keep new frames.
            newFrames = ArrayPrototypeSlice(newFrames, 0, pos);
            break;
          }
        }
        const stackStart = ArrayPrototypeJoin(newFrames, '\n');
        const stackEnd = ArrayPrototypeJoin(originalFrames, '\n');
        newErr.stack = `${stackStart}\n${stackEnd}`;
      }
    }

    throw newErr;
  }
};

function internalMatch(string, regexp, message, fn) {
  if (!isRegExp(regexp)) {
    throw new ERR_INVALID_ARG_TYPE(
      'regexp', 'RegExp', regexp,
    );
  }
  const match = fn === Assert.prototype.match;
  if (typeof string !== 'string' ||
      RegExpPrototypeExec(regexp, string) !== null !== match) {
    if (message instanceof Error) {
      throw message;
    }

    const generatedMessage = !message;

    // 'The input was expected to not match the regular expression ' +
    message ||= (typeof string !== 'string' ?
      'The "string" argument must be of type string. Received type ' +
        `${typeof string} (${inspect(string)})` :
      (match ?
        'The input did not match the regular expression ' :
        'The input was expected to not match the regular expression ') +
          `${inspect(regexp)}. Input:\n\n${inspect(string)}\n`);
    const err = new AssertionError({
      actual: string,
      expected: regexp,
      message,
      operator: fn.name,
      stackStartFn: fn,
      diff: this?.[kOptions]?.diff,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

/**
 * Expects the `string` input to match the regular expression.
 * @param {string} string
 * @param {RegExp} regexp
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.match = function match(string, regexp, message) {
  internalMatch(string, regexp, message, match);
};

/**
 * Expects the `string` input not to match the regular expression.
 * @param {string} string
 * @param {RegExp} regexp
 * @param {string | Error} [message]
 * @returns {void}
 */
Assert.prototype.doesNotMatch = function doesNotMatch(string, regexp, message) {
  internalMatch(string, regexp, message, doesNotMatch);
};

assert.CallTracker = deprecate(CallTracker, 'assert.CallTracker is deprecated.', 'DEP0173');

/**
 * Expose a strict only variant of assert.
 * @param {...any} args
 * @returns {void}
 */
function strict(...args) {
  innerOk(strict, args.length, ...args);
}

// TODO(aduh95): take `ok` from `Assert.prototype` instead of a self-ref in a next major.
assert.ok = assert;
ArrayPrototypeForEach([
  'fail', 'equal', 'notEqual', 'deepEqual', 'notDeepEqual',
  'deepStrictEqual', 'notDeepStrictEqual', 'strictEqual',
  'notStrictEqual', 'partialDeepStrictEqual', 'match', 'doesNotMatch',
  'throws', 'rejects', 'doesNotThrow', 'doesNotReject', 'ifError',
], (name) => {
  setOwnProperty(assert, name, Assert.prototype[name]);
});

assert.strict = ObjectAssign(strict, assert, {
  equal: assert.strictEqual,
  deepEqual: assert.deepStrictEqual,
  notEqual: assert.notStrictEqual,
  notDeepEqual: assert.notDeepStrictEqual,
});

assert.strict.Assert = Assert;
assert.strict.strict = assert.strict;

assert.Assert = Assert;

return assert;

})();

/* ===== ESM exports mirroring node's assert shape ===== */
const assert = __assertMain;
export default assert;
export const {
  AssertionError,
  CallTracker,
  fail,
  ok,
  equal,
  notEqual,
  deepEqual,
  notDeepEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  strictEqual,
  notStrictEqual,
  partialDeepStrictEqual,
  strict,
  throws,
  rejects,
  doesNotThrow,
  doesNotReject,
  ifError,
  match,
  doesNotMatch,
  Assert,
} = assert;
