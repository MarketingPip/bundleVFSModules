// Parity adapter for `require('internal/repl/highlight')` used by the
// official Node 26 test test-repl-highlight.js (the only repl test
// importing it).
//
// The problem: `lib/internal/repl/highlight.js` is new in Node 26, so the
// host v24.22.1 has no such module and the require fails before any
// assertion runs. Same treatment as `internal/http` (see
// parity/internal-http-adapter.mjs): the adapter re-exports the shim's
// port (src/internals/repl-highlight.js), so the test exercises the
// shim's highlight() rather than native Node's.
//
// Harness-only; the port itself lives in src/ and is importable by the
// shim. The adapter's own imports below reach the shim because the
// adapter lives under parity/, not under parity/node-test/parallel/, so
// the preload's testsDir-guarded redirect does not apply to it.
import { highlight } from "../src/internals/repl-highlight.js";

export { highlight };
export default { highlight };
