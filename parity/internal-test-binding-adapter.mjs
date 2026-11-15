// Parity adapter for `require('internal/test/binding')` used by the net
// tests (test-net-end-close, test-net-connect-options-fd,
// test-net-listen-handle-in-cluster-2, test-net-persistent-nodelay,
// test-net-persistent-ref-unref, test-net-server-listen-handle).
//
// The problem: test-net-end-close's fake handle writes UV_EOF into the
// `stream_wrap` binding's `streamBaseState`, and the shim's onStreamRead
// must read that same cell — but the shim cannot import Node internals
// (browser build). This adapter merges the two: everything from real
// Node's internal/test/binding, except `internalBinding('stream_wrap')`,
// which is real Node's stream_wrap with the `streamBaseState` /
// `kReadBytesOrError` cells replaced by the shim's shared state
// (src/internals/stream-wrap-state.js — the same object src/net.js reads).
// No behavior change for any other consumer: the other bindings
// (tcp_wrap, pipe_wrap, uv) are real Node's, exactly as before this
// adapter existed.
//
// Harness-only; src/ behavior is untouched (the state object itself lives
// in src/internals/, with no change to what it keys). The adapter's own
// require() below reaches real Node because the adapter lives under
// parity/, not under parity/node-test/parallel/, so the preload's
// testsDir-guarded redirect does not apply to it. All six requiring net
// tests run with --expose-internals, so the top-level require cannot
// throw for them.
import { createRequire } from "node:module";
import {
  kReadBytesOrError,
  streamBaseState,
} from "../src/internals/stream-wrap-state.js";

const require = createRequire(import.meta.url);
const real = require("internal/test/binding");
const realInternalBinding = real.internalBinding;

const realStreamWrap = realInternalBinding("stream_wrap");
const shimStreamWrap = {
  ...realStreamWrap,
  streamBaseState,
  kReadBytesOrError,
};

export function internalBinding(name) {
  if (name === "stream_wrap") return shimStreamWrap;
  return realInternalBinding(name);
}
export const primordials = real.primordials;
export default { internalBinding, primordials };
