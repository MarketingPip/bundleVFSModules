// Shared internal symbols for the http module family.
//
// `kUniqueHeaders` / `kHighWaterMark` / `kOutHeaders` mirror Node's internal
// slots on OutgoingMessage. They live here (not on the public `node:http`
// surface) so both `src/http.js` and `src/_http_outgoing.js` share one source
// of truth without leaking them as named ESM exports of `node:http`.
//
// This is NOT a bundled module and NOT public API.
export const kUniqueHeaders = Symbol("kUniqueHeaders");
export const kHighWaterMark = Symbol("kHighWaterMark");
// kOutHeaders is also re-exported by parity/internal-http-adapter.mjs, so
// `require("internal/http")` under the parity harness returns the same
// symbol instance the shim's OutgoingMessage stores headers under
// (test-http-correct-hostname reads req[kOutHeaders]).
export const kOutHeaders = Symbol("kOutHeaders");
