import { types as nodeTypes } from "https://esm.sh/util";

// Helper to get internal [[Class]] tag
const getTag = (val) => Object.prototype.toString.call(val);

const types = {
  ...nodeTypes,

  // --- Missing Core JS Types ---
  isArray: Array.isArray,
  isObject: (val) => val !== null && typeof val === 'object' && !Array.isArray(val),
  isFunction: (val) => typeof val === 'function',
  isString: (val) => typeof val === 'string',
  isNumber: (val) => typeof val === 'number' && Number.isFinite(val),
  isBoolean: (val) => typeof val === 'boolean',
  isSymbol: (val) => typeof val === 'symbol',
  isBigInt: (val) => typeof val === 'bigint',
  isNull: (val) => val === null,
  isUndefined: (val) => typeof val === 'undefined',
  isPrimitive: (val) => val === null || (typeof val !== 'object' && typeof val !== 'function'),
  
  // --- Missing Built-in Objects ---
  isError: (val) => val instanceof Error || getTag(val) === '[object Error]',
  isEvalError: (val) => val instanceof EvalError,
  isRangeError: (val) => val instanceof RangeError,
  isReferenceError: (val) => val instanceof ReferenceError,
  isSyntaxError: (val) => val instanceof SyntaxError,
  isTypeError: (val) => val instanceof TypeError,
  isURIError: (val) => val instanceof URIError,
  
  // --- Missing Buffer/Binary Types ---
  isBuffer: (val) => typeof Buffer !== 'undefined' && Buffer.isBuffer(val),
  isBlob: (val) => typeof Blob !== 'undefined' && val instanceof Blob,
  isFile: (val) => typeof File !== 'undefined' && val instanceof File,

  // --- Advanced Engine/Environment Types ---
  isProxy: nodeTypes.isProxy || (() => false), // Internal V8 check
  isModuleNamespaceObject: nodeTypes.isModuleNamespaceObject || 
    ((val) => val?.[Symbol.toStringTag] === 'Module'),
  isGlobal: (val) => val === globalThis,
  isWindow: (val) => typeof window !== 'undefined' && val === window
};

// Destructure for clean exports
const {
  // Primitives & Core
  isArray, isObject, isFunction, isString, isNumber, isBoolean, isSymbol, isBigInt, isNull, isUndefined,
  
  // Original util/types
  isArgumentsObject, isGeneratorFunction, isTypedArray, isPromise, isArrayBufferView,
  isUint8Array, isUint8ClampedArray, isUint16Array, isUint32Array,
  isInt8Array, isInt16Array, isInt32Array, isFloat32Array, isFloat64Array,
  isBigInt64Array, isBigUint64Array, isMap, isSet, isWeakMap, isWeakSet,
  isArrayBuffer, isDataView, isSharedArrayBuffer, isAsyncFunction,
  isMapIterator, isSetIterator, isGeneratorObject, isWebAssemblyCompiledModule,
  isNumberObject, isStringObject, isBooleanObject, isBigIntObject, isSymbolObject,
  isBoxedPrimitive, isAnyArrayBuffer, isRegExp, isDate, isNativeError,

  // Errors & Others
  isError, isTypeError, isSyntaxError, isBuffer, isProxy, isModuleNamespaceObject
} = types;
