// AsyncResource for stream internals (end-of-stream bind).
//
// Node's lib/internal/streams/end-of-stream.js binds the finished()
// callback with an AsyncResource so the callback runs in the async
// context where finished() was called (ALS propagation, async-hook
// init/before/after). This module used to be a dependency-free stub
// whose runInAsyncScope() was the identity function, so the context was
// lost: test-stream-finished-async-local-storage.js and
// test-stream-finished-bindAsyncResource-path.js (both new in Node 26)
// failed with als.getStore() === undefined / contextMap misses.
//
// The real AsyncResource lives in src/async_hooks.js: under real Node it
// delegates to the native builtin (true ALS/hook semantics, same module
// instance the tests' require('async_hooks') gets); in the browser it is
// the honest stub with the same shape. Re-export it here instead of
// duplicating it, so end-of-stream.js binds through the real resource.
//
// ponytail: Node 26 binds only when AsyncContextFrame.current() ||
// enabledHooksExist() (a perf guard). That condition is not observable
// from shim code — process.getBuiltinModule('internal/async_context_frame')
// returns undefined on both the v24 host and the Node 26 binary, and
// enabledHooksExist() is internal-only — so the bind stays unconditional
// (the Node 24 shape), now through the real resource. The conditional is
// perf-only; correctness is what the two Node 26 tests assert.
export { AsyncResource } from "../async_hooks.js";
