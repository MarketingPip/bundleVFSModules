// Export-surface parity: src/util.js  <->  node:util
// captured from real Node v24.20.0 (node:util)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/util.js';

const EXPECTED = ["MIMEParams","MIMEType","TextDecoder","TextEncoder","_errnoException","_exceptionWithHostPort","_extend","aborted","callbackify","convertProcessSignalToExitCode","debug","debuglog","default","deprecate","diff","format","formatWithOptions","getCallSites","getSystemErrorMap","getSystemErrorMessage","getSystemErrorName","inherits","inspect","isArray","isDeepStrictEqual","parseArgs","parseEnv","promisify","setTraceSigInt","stripVTControlCharacters","styleText","toUSVString","transferableAbortController","transferableAbortSignal","types"];

test('node:util export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
