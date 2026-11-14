// Parity adapter for `require('internal/net')` used by the official Node
// net test test-net-normalize-args.js (the only net test importing it).
//
// The problem: the test reads `normalizedArgsSymbol` from Node's internal
// module, but the shim's _normalizeArgs marks its results with its own
// module-local symbol (src/net.js), so the test's lookup reads
// `undefined`. This adapter merges the two: everything from real Node's
// internal module, except `normalizedArgsSymbol`, which is the shim's
// shared symbol from src/internals/net-symbols.js (the same symbol the
// shim's _normalizeArgs marks results with). No behavior change for any
// other consumer: the other exports are real Node's, exactly as before
// this adapter existed.
//
// Harness-only; src/ behavior is untouched (the symbol itself moved from
// a module-local const in src/net.js to the shared net-symbols.js, with
// no change to what it keys). The adapter's own require() below reaches
// real Node because the adapter lives under parity/, not under
// parity/node-test/parallel/, so the preload's testsDir-guarded redirect
// does not apply to it.
import { createRequire } from "node:module";
import { normalizedArgsSymbol } from "../src/internals/net-symbols.js";

const require = createRequire(import.meta.url);
const real = require("internal/net");

export const kReinitializeHandle = real.kReinitializeHandle;
export const kSetNoDelay = real.kSetNoDelay;
export const kSetKeepAlive = real.kSetKeepAlive;
export const kSetKeepAliveInitialDelay = real.kSetKeepAliveInitialDelay;
export const kSetKeepAliveInterval = real.kSetKeepAliveInterval;
export const kSetKeepAliveCount = real.kSetKeepAliveCount;
export const isIP = real.isIP;
export const isIPv4 = real.isIPv4;
export const isIPv6 = real.isIPv6;
export const makeSyncWrite = real.makeSyncWrite;
export const isLoopback = real.isLoopback;
export { normalizedArgsSymbol };
export default { ...real, normalizedArgsSymbol };
