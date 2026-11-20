// Parity adapter for `require('internal/streams/end-of-stream')` used by
// the official Node stream test test-stream-finished.js (the only stream
// test importing it; it reads only `kEosNodeSynchronousCallback`).
//
// The problem: the test passes `[kEosNodeSynchronousCallback]: true` to
// the shim's finished() so the callback fires synchronously inside
// finished(), but the symbol it reads from real Node's internal module is
// a different instance from the shim's own symbol
// (src/stream/end-of-stream.js), so the shim never sees the option, defers
// to nextTick, and the test's immediate cleanup2() cancels it. This
// adapter merges the two: everything from real Node's internal module,
// except `kEosNodeSynchronousCallback`, which is the shim's shared symbol
// (the same symbol the shim's eos() keys on). No behavior change for any
// other consumer: the other exports are real Node's, exactly as before
// this adapter existed. Stream target only.
//
// Harness-only; src/ behavior is untouched. The adapter's own require()
// below reaches real Node because the adapter lives under parity/, not
// under parity/node-test/parallel/, so the preload's testsDir-guarded
// redirect does not apply to it.
import { createRequire } from "node:module";
import { kEosNodeSynchronousCallback } from "../src/stream/end-of-stream.js";

const require = createRequire(import.meta.url);
const real = require("internal/streams/end-of-stream");

export const eos = real.eos;
export const finished = real.finished;
export { kEosNodeSynchronousCallback };
export default { ...real, kEosNodeSynchronousCallback };
