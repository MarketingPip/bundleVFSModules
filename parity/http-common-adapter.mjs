// Parity adapter for `require('_http_common')` used by the official Node
// http tests when PARITY_TARGET=http (see the special case in
// parity/preload.mjs, mirroring the internal/event_target adapter).
//
// The problem: the http shim's `setMaxIdleHTTPParsers()` must mutate the
// same `parsers.max` cell the tests read, but the tests' `_http_common`
// otherwise resolves to real Node's internal module (whose pool the shim
// cannot see), while the shim's own `_http_common.js` cannot supply the
// real `HTTPParser` binding that test-http-parser.js and
// test-http-parser-bad-ref.js depend on. So this adapter merges the two:
// everything from real Node's internal module, except `parsers`, which is
// the shim's shared cap cell from src/_http_common.js (the object the
// shim's setter mutates). No behavior change for any other consumer: the
// check helpers, methods, and HTTPParser are real Node's, exactly as
// before this adapter existed.
//
// Harness-only; src/ is untouched. The adapter's own require() below
// reaches real Node because the adapter lives under parity/, not under
// parity/node-test/parallel/, so the preload's testsDir-guarded redirect
// does not apply to it.
import { createRequire } from "node:module";
import { parsers } from "../src/_http_common.js";

const require = createRequire(import.meta.url);
const real = require("_http_common");

// Preserve the real pool's alloc/free on the shared cell: the only test
// that calls parsers.alloc() (test-http-parser-lazy-loaded) fails before
// any assertion on base with a native abort (its DummyParser symbol
// reaches the real parser's Initialize), and delegating keeps that
// failure mode byte-identical instead of turning it into a TypeError.
// Nothing in the shim reads alloc/free; only `max` is the shared cell.
parsers.alloc = real.parsers.alloc.bind(real.parsers);
parsers.free = real.parsers.free.bind(real.parsers);

export const _checkInvalidHeaderChar = real._checkInvalidHeaderChar;
export const _checkIsHttpToken = real._checkIsHttpToken;
export const chunkExpression = real.chunkExpression;
export const continueExpression = real.continueExpression;
export const CRLF = real.CRLF;
export const freeParser = real.freeParser;
export const methods = real.methods;
export const kIncomingMessage = real.kIncomingMessage;
export const kSkipPendingData = real.kSkipPendingData;
export const HTTPParser = real.HTTPParser;
export const isLenient = real.isLenient;
export const calculateLenientFlags = real.calculateLenientFlags;
export const prepareError = real.prepareError;
export { parsers };
export default { ...real, parsers };
