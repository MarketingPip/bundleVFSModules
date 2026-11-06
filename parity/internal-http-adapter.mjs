// Parity adapter for `require('internal/http')` used by the official Node
// http test test-http-correct-hostname.js (the only http test importing it).
//
// The problem: the test reads `req[kOutHeaders]` from Node's internal
// module, but the shim's OutgoingMessage stores its headers under its own
// module-local `kOutHeaders` symbol (src/http.js), so the test's lookup
// reads `undefined`. This adapter merges the two: everything from real
// Node's internal module, except `kOutHeaders`, which is the shim's shared
// symbol from src/internals/http-symbols.js (the same symbol the shim's
// OutgoingMessage stores headers under). No behavior change for any other
// consumer: the proxy helpers, utcDate, and trace functions are real
// Node's, exactly as before this adapter existed.
//
// Harness-only; src/ behavior is untouched (the symbol itself moved from a
// module-local const in src/http.js to the shared http-symbols.js, with
// no change to what it keys). The adapter's own require() below reaches
// real Node because the adapter lives under parity/, not under
// parity/node-test/parallel/, so the preload's testsDir-guarded redirect
// does not apply to it.
import { createRequire } from "node:module";
import { kOutHeaders } from "../src/internals/http-symbols.js";

const require = createRequire(import.meta.url);
const real = require("internal/http");

export const kNeedDrain = real.kNeedDrain;
export const kProxyConfig = real.kProxyConfig;
export const kWaitForProxyTunnel = real.kWaitForProxyTunnel;
export const checkShouldUseProxy = real.checkShouldUseProxy;
export const parseProxyConfigFromEnv = real.parseProxyConfigFromEnv;
export const utcDate = real.utcDate;
export const traceBegin = real.traceBegin;
export const traceEnd = real.traceEnd;
export const getNextTraceEventId = real.getNextTraceEventId;
export const isTraceHTTPEnabled = real.isTraceHTTPEnabled;
export const filterEnvForProxies = real.filterEnvForProxies;
export const getGlobalAgent = real.getGlobalAgent;
export const parseProxyUrl = real.parseProxyUrl;
export { kOutHeaders };
export default { ...real, kOutHeaders };
