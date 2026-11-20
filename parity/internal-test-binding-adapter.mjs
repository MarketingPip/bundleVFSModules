// Parity adapter for `require('internal/test/binding')` used by the net
// tests (test-net-end-close, test-net-connect-options-fd,
// test-net-listen-handle-in-cluster-2, test-net-persistent-nodelay,
// test-net-persistent-ref-unref, test-net-server-listen-handle) and by
// the fs tests (test-fs-promises-readfile, test-fs-readdir-types,
// test-fs-sync-fd-leak, test-fs-existssync-memleak-longpath,
// test-fs-filehandle, test-fs-promises-readfile-buffer-option,
// test-fs-readfile-buffer-option).
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
// The fs side is the same shape: the shim routes its readFile-fstat,
// readdir, and writeFileSync-utf8-fast-path calls through the shared
// `fs` binding cell (src/internals/fs-binding-state.js — the same object
// src/fs.js calls). `internalBinding('fs')` returns a prototype-merged
// window onto real Node's fs binding whose fstat / readdir /
// writeFileUtf8 / kUsePromises are accessors into that cell, so a test
// patch lands in the shim — while FSReqCallback, read, and everything
// else fall through the prototype to the real binding, so the
// currently-passing consumer tests behave exactly as today.
// `openFileHandle` is the one exception: it is overridden below (Node 26
// FileHandle close-on-GC now throws, test-fs-filehandle).
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
import { fsBindingState } from "../src/internals/fs-binding-state.js";

const require = createRequire(import.meta.url);
const real = require("internal/test/binding");
const realInternalBinding = real.internalBinding;

const realStreamWrap = realInternalBinding("stream_wrap");
const shimStreamWrap = {
  ...realStreamWrap,
  streamBaseState,
  kReadBytesOrError,
};

// Prototype-merged `fs` window: the three functions the shim calls are
// accessors into the shared cell (get reads the cell default, set writes
// the test's patch into it); everything else is real Node's binding.
// Created once so every internalBinding('fs') call returns the same
// object — patches are per-process, and each test file runs in its own
// process, so no patch leaks across tests.
// Registry backing the openFileHandle override below: on GC of an
// unclosed host FileHandle, throw the Node 26 ERR_INVALID_STATE from a
// setImmediate (message matches src/fs.js's shim-side registry word for
// word). The registry holds only {fd, path}, never the handle.
const fileHandleGcRegistry =
  typeof FinalizationRegistry !== "undefined"
    ? new FinalizationRegistry(({ fd, path }) => {
        setImmediate(() => {
          const err = new Error(
            "A FileHandle object was closed during garbage collection. " +
              "This used to be allowed with a deprecation warning but is " +
              "now considered an error. Please close FileHandle objects " +
              "explicitly. " +
              `File descriptor: ${fd} (${path})`,
          );
          err.code = "ERR_INVALID_STATE";
          throw err;
        });
      })
    : null;

const realFsBinding = realInternalBinding("fs");
const shimFsBinding = Object.create(realFsBinding);
Object.defineProperties(shimFsBinding, {
  fstat: {
    enumerable: true,
    configurable: true,
    get: () => fsBindingState.fstat,
    set: (v) => {
      fsBindingState.fstat = v;
    },
  },
  readdir: {
    enumerable: true,
    configurable: true,
    get: () => fsBindingState.readdir,
    set: (v) => {
      fsBindingState.readdir = v;
    },
  },
  writeFileUtf8: {
    enumerable: true,
    configurable: true,
    get: () => fsBindingState.writeFileUtf8,
    set: (v) => {
      fsBindingState.writeFileUtf8 = v;
    },
  },
  kUsePromises: {
    enumerable: true,
    configurable: true,
    get: () => fsBindingState.kUsePromises,
  },
  // Node 26 (25.0.0 "FileHandle close-on-GC removed",
  // test-fs-filehandle): an unclosed FileHandle GC'd now THROWS
  // ERR_INVALID_STATE instead of warning. The test calls
  // internalBinding('fs').openFileHandle(...), which falls through to
  // the REAL host binding (v24) — the shim's own FileHandle registry is
  // never involved. This override forwards all args verbatim (so
  // ctx.errno stays undefined) and registers the returned handle in a
  // FinalizationRegistry that throws the Node 26 error from a
  // setImmediate, surfacing as uncaughtException. The host binding owns
  // the fd close; this registry only supplies the throw, and no
  // unregister token is passed (nothing ever unregisters — the handle
  // is dropped by the test). Only test-fs-filehandle.js calls
  // openFileHandle among fs tests.
  openFileHandle: {
    enumerable: true,
    configurable: true,
    value: function (...args) {
      const handle = realFsBinding.openFileHandle(...args);
      if (fileHandleGcRegistry !== null && handle !== null && handle !== undefined) {
        fileHandleGcRegistry.register(handle, {
          fd: handle.fd,
          path:
            typeof args[0] === "string" ? args[0] : String(args[0]),
        });
      }
      return handle;
    },
  },
});

export function internalBinding(name) {
  if (name === "stream_wrap") return shimStreamWrap;
  if (name === "fs") return shimFsBinding;
  return realInternalBinding(name);
}
export const primordials = real.primordials;
export default { internalBinding, primordials };
