// Shared stream_wrap read state (Node lib/internal/stream_base_commons.js:
// onStreamRead reads `streamBaseState[kReadBytesOrError]` to learn how many
// bytes a read delivered, or a negative errno — UV_EOF for end-of-stream).
//
// The parity adapter for `internal/test/binding`
// (parity/internal-test-binding-adapter.mjs) returns this same object for
// 'stream_wrap', so a test writing UV_EOF into it (test-net-end-close's fake
// readStart) is visible to the shim's onStreamRead. In the browser this is
// just the shim's own cell — no native state exists there.
// UV_EOF is libuv's constant (-4095, probed on real Node v24.22.1).
export const kReadBytesOrError = Symbol("kReadBytesOrError");
export const streamBaseState = { [kReadBytesOrError]: 0 };
export const UV_EOF = -4095;
