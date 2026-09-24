// Export-surface parity: src/util/types.js  <->  node:util_types
// custom runtime module (no node:util_types counterpart); surface below is the defined contract
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/util/types.js';

const EXPECTED = ["default","isAnyArrayBuffer","isArgumentsObject","isArrayBuffer","isArrayBufferView","isAsyncFunction","isBigInt64Array","isBigIntObject","isBigUint64Array","isBooleanObject","isBoxedPrimitive","isCryptoKey","isDataView","isDate","isExternal","isFloat16Array","isFloat32Array","isFloat64Array","isGeneratorFunction","isGeneratorObject","isInt16Array","isInt32Array","isInt8Array","isKeyObject","isMap","isMapIterator","isModuleNamespaceObject","isNativeError","isNumberObject","isPromise","isProxy","isRegExp","isSet","isSetIterator","isSharedArrayBuffer","isStringObject","isSymbolObject","isTypedArray","isUint16Array","isUint32Array","isUint8Array","isUint8ClampedArray","isWeakMap","isWeakSet"];

test('node:util_types export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
