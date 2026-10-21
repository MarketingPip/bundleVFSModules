# Capability Matrix

> Generated from code by `scripts/generate-capability-matrix.mjs`.
> Do not edit by hand — regenerate instead.

Oracle: Node v24.20.0 (the Node running the generator). Modules:
Node.js builtins with a shim in `src/`. Derivation: real Node
`node:<module>` exports × shim source-body classification.

## Summary

| Module | APIs | Implemented | Honest-noop | Unsupported | Unknown | Parity (official tests) |
|--------|------|-------------|-------------|-------------|---------|-------------------------|\n| `assert` | 46 | 46 | 0 | 0 | 0 | 18/18 (100%) · 2026-10-11 |
| `async_hooks` | 19 | 18 | 0 | 1 | 0 | 29/36 (80.6%) · 2026-10-11 |
| `buffer` | 119 | 113 | 0 | 6 | 0 | 62/62 (100%) · 2026-10-11 |
| `child_process` | 12 | 12 | 0 | 0 | 0 | 6/112 (5.4%) · 2026-10-11 |
| `cluster` | 19 | 12 | 7 | 0 | 0 | 4/83 (4.8%) · 2026-10-11 |
| `console` | 44 | 44 | 0 | 0 | 0 | 22/22 (100%) · 2026-10-11 |
| `constants` | 236 | 236 | 0 | 0 | 0 | — |
| `crypto` | 143 | 123 | 0 | 20 | 0 | 129/129 (100%) · 2026-10-11 |
| `dgram` | 29 | 23 | 6 | 0 | 0 | 1/80 (1.3%) · 2026-10-11 |
| `diagnostics_channel` | 13 | 9 | 4 | 0 | 0 | 26/26 (100%) · 2026-10-11 |
| `dns` | 65 | 65 | 0 | 0 | 0 | 10/31 (32.3%) · 2026-10-11 |
| `domain` | 12 | 10 | 1 | 1 | 0 | 2/50 (4%) · 2026-10-11 |
| `events` | 35 | 32 | 1 | 0 | 2 | 1/9 (11.1%) · 2026-10-11 |
| `fs` | 158 | 125 | 2 | 29 | 2 | 324/349 (92.8%) · 2026-10-17 |
| `http` | 112 | 64 | 6 | 42 | 0 | 134/397 (33.8%) · 2026-10-20 |
| `http2` | 64 | 31 | 4 | 29 | 0 | 35/277 (12.6%) · 2026-10-11 |
| `https` | 13 | 6 | 0 | 7 | 0 | 20/67 (29.9%) · 2026-10-11 |
| `inspector` | 13 | 6 | 7 | 0 | 0 | 29/74 (39.2%) · 2026-10-11 |
| `module` | 27 | 23 | 2 | 2 | 0 | 29/32 (90.6%) · 2026-10-11 |
| `net` | 91 | 50 | 0 | 41 | 0 | 72/156 (46.2%) · 2026-10-17 |
| `os` | 23 | 23 | 0 | 0 | 0 | 7/7 (100%) · 2026-10-11 |
| `path` | 16 | 14 | 1 | 0 | 1 | 16/16 (100%) · 2026-10-11 |
| `perf_hooks` | 68 | 66 | 1 | 1 | 0 | 13/15 (86.7%) · 2026-10-11 |
| `process` | 66 | 66 | 0 | 0 | 0 | 81/97 (83.5%) · 2026-10-11 |
| `punycode` | 6 | 6 | 0 | 0 | 0 | — |
| `querystring` | 7 | 7 | 0 | 0 | 0 | 3/3 (100%) · 2026-10-11 |
| `readline` | 9 | 8 | 0 | 0 | 1 | 22/22 (100%) · 2026-10-12 |
| `repl` | 17 | 6 | 0 | 11 | 0 | 78/102 (76.5%) · 2026-10-11 |
| `sea` | 5 | 5 | 0 | 0 | 0 | 0/2 (0%) · 2026-10-11 |
| `sqlite` | 33 | 33 | 0 | 0 | 0 | 0/17 (0%) · 2026-10-11 |
| `stream` | 100 | 63 | 1 | 36 | 0 | 237/237 (100%) · 2026-10-11 |
| `stream/consumers` | 6 | 0 | 0 | 6 | 0 | — |
| `string_decoder` | 7 | 4 | 0 | 3 | 0 | 2/2 (100%) · 2026-10-11 |
| `sys` | 53 | 48 | 0 | 5 | 0 | — |
| `test` | 17 | 17 | 0 | 0 | 0 | — |
| `timers` | 7 | 6 | 0 | 0 | 1 | 45/45 (100%) · 2026-10-11 |
| `tls` | 44 | 17 | 26 | 1 | 0 | 29/220 (13.2%) · 2026-10-11 |
| `trace_events` | 2 | 2 | 0 | 0 | 0 | 28/29 (96.6%) · 2026-10-11 |
| `tty` | 12 | 11 | 1 | 0 | 0 | 5/5 (100%) · 2026-10-11 |
| `url` | 57 | 32 | 0 | 24 | 1 | 16/16 (100%) · 2026-10-11 |
| `util` | 53 | 46 | 0 | 7 | 0 | 28/31 (90.3%) · 2026-10-11 |
| `v8` | 41 | 26 | 0 | 15 | 0 | 22/22 (100%) · 2026-10-11 |
| `vm` | 13 | 13 | 0 | 0 | 0 | 48/97 (49.5%) · 2026-10-11 |
| `wasi` | 5 | 4 | 1 | 0 | 0 | 2/2 (100%) · 2026-10-11 |
| `worker_threads` | 51 | 36 | 0 | 15 | 0 | 134/141 (95%) · 2026-10-11 |
| `zlib` | 47 | 46 | 1 | 0 | 0 | 43/65 (66.2%) · 2026-10-19 |

**Totals:** 2035 rows — 1653 implemented, 72 honest-noop, 302 unsupported, 8 unknown.

Parity column: measured official-test pass rates from `parity/measured-rates.json` (see NOTES-capability-matrix.md §6); "—" means not yet swept.

## Load failures

These modules could not be loaded under bare Node, so their export
surface comes from source text alone; the error is recorded per module.

- `repl`: Directory import '/home/hatch/workspace/bundleVFSModules-vite7/src/readline' is not supported resolving ES modules imported from /home/hatch/workspace/bundleVFSModules-vite7/src/repl.js
- `stream/consumers`: Cannot find package 'stream-consumers' imported from /home/hatch/workspace/bundleVFSModules-vite7/src/stream-consumers.js

## Excluded src files

These `src/*.js` files are not Node.js builtin modules (browser
helpers, bundler plugins, service workers), so they are not part
of the matrix.

- `async_context.js`
- `browser-builds.js`
- `child_process2.js`
- `cookieJar.js`
- `fetch-patch.js`
- `ffi.js`
- `globals.js`
- `navigator.js`
- `node_globals.js`
- `plugins.js`
- `preview-sw.js`
- `primordials-shim-plugin.js`
- `quick_bundle.js`
- `sandbox-template.js`
- `serialize_js.js`
- `toolchain.js`
- `vitest-shim.js`
- `ws.js`

## Per-module detail

### assert

| API | Status | Reason |
|-----|--------|--------|
| `Assert` | implemented | — |
| `Assert.prototype.deepEqual` | implemented | — |
| `Assert.prototype.deepStrictEqual` | implemented | — |
| `Assert.prototype.doesNotMatch` | implemented | — |
| `Assert.prototype.doesNotReject` | implemented | — |
| `Assert.prototype.doesNotThrow` | implemented | — |
| `Assert.prototype.equal` | implemented | — |
| `Assert.prototype.fail` | implemented | — |
| `Assert.prototype.ifError` | implemented | — |
| `Assert.prototype.match` | implemented | — |
| `Assert.prototype.notDeepEqual` | implemented | — |
| `Assert.prototype.notDeepStrictEqual` | implemented | — |
| `Assert.prototype.notEqual` | implemented | — |
| `Assert.prototype.notStrictEqual` | implemented | — |
| `Assert.prototype.ok` | implemented | — |
| `Assert.prototype.partialDeepStrictEqual` | implemented | — |
| `Assert.prototype.rejects` | implemented | — |
| `Assert.prototype.strictEqual` | implemented | — |
| `Assert.prototype.throws` | implemented | — |
| `AssertionError` | implemented | — |
| `AssertionError.prototype.toString` | implemented | — |
| `CallTracker` | implemented | — |
| `CallTracker.prototype.calls` | implemented | — |
| `CallTracker.prototype.getCalls` | implemented | — |
| `CallTracker.prototype.report` | implemented | — |
| `CallTracker.prototype.reset` | implemented | — |
| `CallTracker.prototype.verify` | implemented | — |
| `deepEqual` | implemented | — |
| `deepStrictEqual` | implemented | — |
| `doesNotMatch` | implemented | — |
| `doesNotReject` | implemented | — |
| `doesNotThrow` | implemented | — |
| `equal` | implemented | — |
| `fail` | implemented | — |
| `ifError` | implemented | — |
| `match` | implemented | — |
| `notDeepEqual` | implemented | — |
| `notDeepStrictEqual` | implemented | — |
| `notEqual` | implemented | — |
| `notStrictEqual` | implemented | — |
| `ok` | implemented | — |
| `partialDeepStrictEqual` | implemented | — |
| `rejects` | implemented | — |
| `strict` | implemented | — |
| `strictEqual` | implemented | — |
| `throws` | implemented | — |

### async_hooks

| API | Status | Reason |
|-----|--------|--------|
| `AsyncLocalStorage` | implemented | — |
| `AsyncLocalStorage.prototype.disable` | implemented | — |
| `AsyncLocalStorage.prototype.enterWith` | implemented | — |
| `AsyncLocalStorage.prototype.exit` | implemented | — |
| `AsyncLocalStorage.prototype.getStore` | implemented | — |
| `AsyncLocalStorage.prototype.name` | unsupported | not present in shim class |
| `AsyncLocalStorage.prototype.run` | implemented | — |
| `AsyncLocalStorage.prototype.withScope` | implemented | — |
| `AsyncResource` | implemented | — |
| `AsyncResource.prototype.asyncId` | implemented | — |
| `AsyncResource.prototype.bind` | implemented | — |
| `AsyncResource.prototype.emitDestroy` | implemented | — |
| `AsyncResource.prototype.runInAsyncScope` | implemented | — |
| `AsyncResource.prototype.triggerAsyncId` | implemented | — |
| `asyncWrapProviders` | implemented | — |
| `createHook` | implemented | — |
| `executionAsyncId` | implemented | — |
| `executionAsyncResource` | implemented | — |
| `triggerAsyncId` | implemented | — |

### buffer

| API | Status | Reason |
|-----|--------|--------|
| `Blob` | implemented | — |
| `Blob.prototype.arrayBuffer` | implemented | — |
| `Blob.prototype.bytes` | implemented | — |
| `Blob.prototype.size` | unsupported | not present in shim class |
| `Blob.prototype.slice` | implemented | — |
| `Blob.prototype.stream` | implemented | — |
| `Blob.prototype.text` | implemented | — |
| `Blob.prototype.textStream` | implemented | — |
| `Blob.prototype.type` | unsupported | not present in shim class |
| `Buffer` | implemented | — |
| `Buffer.prototype.asciiSlice` | implemented | — |
| `Buffer.prototype.asciiWrite` | implemented | — |
| `Buffer.prototype.base64Slice` | implemented | — |
| `Buffer.prototype.base64Write` | implemented | — |
| `Buffer.prototype.base64urlSlice` | implemented | — |
| `Buffer.prototype.base64urlWrite` | implemented | — |
| `Buffer.prototype.compare` | implemented | — |
| `Buffer.prototype.copy` | implemented | — |
| `Buffer.prototype.equals` | implemented | — |
| `Buffer.prototype.fill` | implemented | — |
| `Buffer.prototype.hexSlice` | implemented | — |
| `Buffer.prototype.hexWrite` | implemented | — |
| `Buffer.prototype.includes` | implemented | — |
| `Buffer.prototype.indexOf` | implemented | — |
| `Buffer.prototype.inspect` | implemented | — |
| `Buffer.prototype.lastIndexOf` | implemented | — |
| `Buffer.prototype.latin1Slice` | implemented | — |
| `Buffer.prototype.latin1Write` | implemented | — |
| `Buffer.prototype.offset` | unsupported | not present in shim class |
| `Buffer.prototype.parent` | unsupported | not present in shim class |
| `Buffer.prototype.readBigInt64BE` | implemented | — |
| `Buffer.prototype.readBigInt64LE` | implemented | — |
| `Buffer.prototype.readBigUInt64BE` | implemented | — |
| `Buffer.prototype.readBigUInt64LE` | implemented | — |
| `Buffer.prototype.readBigUint64BE` | implemented | — |
| `Buffer.prototype.readBigUint64LE` | implemented | — |
| `Buffer.prototype.readDoubleBE` | implemented | — |
| `Buffer.prototype.readDoubleLE` | implemented | — |
| `Buffer.prototype.readFloatBE` | implemented | — |
| `Buffer.prototype.readFloatLE` | implemented | — |
| `Buffer.prototype.readInt16BE` | implemented | — |
| `Buffer.prototype.readInt16LE` | implemented | — |
| `Buffer.prototype.readInt32BE` | implemented | — |
| `Buffer.prototype.readInt32LE` | implemented | — |
| `Buffer.prototype.readInt8` | implemented | — |
| `Buffer.prototype.readIntBE` | implemented | — |
| `Buffer.prototype.readIntLE` | implemented | — |
| `Buffer.prototype.readUInt16BE` | implemented | — |
| `Buffer.prototype.readUInt16LE` | implemented | — |
| `Buffer.prototype.readUInt32BE` | implemented | — |
| `Buffer.prototype.readUInt32LE` | implemented | — |
| `Buffer.prototype.readUInt8` | implemented | — |
| `Buffer.prototype.readUIntBE` | implemented | — |
| `Buffer.prototype.readUIntLE` | implemented | — |
| `Buffer.prototype.readUint16BE` | implemented | — |
| `Buffer.prototype.readUint16LE` | implemented | — |
| `Buffer.prototype.readUint32BE` | implemented | — |
| `Buffer.prototype.readUint32LE` | implemented | — |
| `Buffer.prototype.readUint8` | implemented | — |
| `Buffer.prototype.readUintBE` | implemented | — |
| `Buffer.prototype.readUintLE` | implemented | — |
| `Buffer.prototype.slice` | implemented | — |
| `Buffer.prototype.subarray` | implemented | — |
| `Buffer.prototype.swap16` | implemented | — |
| `Buffer.prototype.swap32` | implemented | — |
| `Buffer.prototype.swap64` | implemented | — |
| `Buffer.prototype.toJSON` | implemented | — |
| `Buffer.prototype.toLocaleString` | implemented | — |
| `Buffer.prototype.toString` | implemented | — |
| `Buffer.prototype.ucs2Slice` | implemented | — |
| `Buffer.prototype.ucs2Write` | implemented | — |
| `Buffer.prototype.utf8Slice` | implemented | — |
| `Buffer.prototype.utf8Write` | implemented | — |
| `Buffer.prototype.write` | implemented | — |
| `Buffer.prototype.writeBigInt64BE` | implemented | — |
| `Buffer.prototype.writeBigInt64LE` | implemented | — |
| `Buffer.prototype.writeBigUInt64BE` | implemented | — |
| `Buffer.prototype.writeBigUInt64LE` | implemented | — |
| `Buffer.prototype.writeBigUint64BE` | implemented | — |
| `Buffer.prototype.writeBigUint64LE` | implemented | — |
| `Buffer.prototype.writeDoubleBE` | implemented | — |
| `Buffer.prototype.writeDoubleLE` | implemented | — |
| `Buffer.prototype.writeFloatBE` | implemented | — |
| `Buffer.prototype.writeFloatLE` | implemented | — |
| `Buffer.prototype.writeInt16BE` | implemented | — |
| `Buffer.prototype.writeInt16LE` | implemented | — |
| `Buffer.prototype.writeInt32BE` | implemented | — |
| `Buffer.prototype.writeInt32LE` | implemented | — |
| `Buffer.prototype.writeInt8` | implemented | — |
| `Buffer.prototype.writeIntBE` | implemented | — |
| `Buffer.prototype.writeIntLE` | implemented | — |
| `Buffer.prototype.writeUInt16BE` | implemented | — |
| `Buffer.prototype.writeUInt16LE` | implemented | — |
| `Buffer.prototype.writeUInt32BE` | implemented | — |
| `Buffer.prototype.writeUInt32LE` | implemented | — |
| `Buffer.prototype.writeUInt8` | implemented | — |
| `Buffer.prototype.writeUIntBE` | implemented | — |
| `Buffer.prototype.writeUIntLE` | implemented | — |
| `Buffer.prototype.writeUint16BE` | implemented | — |
| `Buffer.prototype.writeUint16LE` | implemented | — |
| `Buffer.prototype.writeUint32BE` | implemented | — |
| `Buffer.prototype.writeUint32LE` | implemented | — |
| `Buffer.prototype.writeUint8` | implemented | — |
| `Buffer.prototype.writeUintBE` | implemented | — |
| `Buffer.prototype.writeUintLE` | implemented | — |
| `File` | implemented | — |
| `File.prototype.lastModified` | unsupported | not present in shim class |
| `File.prototype.name` | unsupported | not present in shim class |
| `INSPECT_MAX_BYTES` | implemented | — |
| `SlowBuffer` | implemented | — |
| `atob` | implemented | — |
| `btoa` | implemented | — |
| `constants` | implemented | — |
| `isAscii` | implemented | — |
| `isUtf8` | implemented | — |
| `kMaxLength` | implemented | — |
| `kStringMaxLength` | implemented | — |
| `resolveObjectURL` | implemented | — |
| `transcode` | implemented | — |

### child_process

| API | Status | Reason |
|-----|--------|--------|
| `ChildProcess` | implemented | — |
| `ChildProcess.prototype.kill` | implemented | — |
| `ChildProcess.prototype.ref` | implemented | — |
| `ChildProcess.prototype.spawn` | implemented | — |
| `ChildProcess.prototype.unref` | implemented | — |
| `exec` | implemented | — |
| `execFile` | implemented | — |
| `execFileSync` | implemented | — |
| `execSync` | implemented | — |
| `fork` | implemented | — |
| `spawn` | implemented | — |
| `spawnSync` | implemented | — |

### cluster

| API | Status | Reason |
|-----|--------|--------|
| `SCHED_NONE` | implemented | — |
| `SCHED_RR` | implemented | — |
| `Worker` | implemented | — |
| `Worker.prototype.destroy` | honest-noop | — |
| `Worker.prototype.disconnect` | honest-noop | — |
| `Worker.prototype.isConnected` | implemented | — |
| `Worker.prototype.isDead` | implemented | — |
| `Worker.prototype.kill` | implemented | — |
| `Worker.prototype.send` | implemented | — |
| `disconnect` | implemented | — |
| `fork` | implemented | — |
| `isMaster` | honest-noop | — |
| `isPrimary` | honest-noop | — |
| `isWorker` | honest-noop | — |
| `schedulingPolicy` | implemented | — |
| `settings` | honest-noop | — |
| `setupMaster` | implemented | — |
| `setupPrimary` | implemented | — |
| `workers` | honest-noop | — |

### console

| API | Status | Reason |
|-----|--------|--------|
| `Console` | implemented | — |
| `Console.prototype.assert` | implemented | — |
| `Console.prototype.clear` | implemented | — |
| `Console.prototype.count` | implemented | — |
| `Console.prototype.countReset` | implemented | — |
| `Console.prototype.debug` | implemented | — |
| `Console.prototype.dir` | implemented | — |
| `Console.prototype.dirxml` | implemented | — |
| `Console.prototype.error` | implemented | — |
| `Console.prototype.group` | implemented | — |
| `Console.prototype.groupCollapsed` | implemented | — |
| `Console.prototype.groupEnd` | implemented | — |
| `Console.prototype.info` | implemented | — |
| `Console.prototype.log` | implemented | — |
| `Console.prototype.table` | implemented | — |
| `Console.prototype.time` | implemented | — |
| `Console.prototype.timeEnd` | implemented | — |
| `Console.prototype.timeLog` | implemented | — |
| `Console.prototype.trace` | implemented | — |
| `Console.prototype.warn` | implemented | — |
| `assert` | implemented | — |
| `clear` | implemented | — |
| `context` | implemented | — |
| `count` | implemented | — |
| `countReset` | implemented | — |
| `createTask` | implemented | — |
| `debug` | implemented | — |
| `dir` | implemented | — |
| `dirxml` | implemented | — |
| `error` | implemented | — |
| `group` | implemented | — |
| `groupCollapsed` | implemented | — |
| `groupEnd` | implemented | — |
| `info` | implemented | — |
| `log` | implemented | — |
| `profile` | implemented | — |
| `profileEnd` | implemented | — |
| `table` | implemented | — |
| `time` | implemented | — |
| `timeEnd` | implemented | — |
| `timeLog` | implemented | — |
| `timeStamp` | implemented | — |
| `trace` | implemented | — |
| `warn` | implemented | — |

### constants

| API | Status | Reason |
|-----|--------|--------|
| `COPYFILE_EXCL` | implemented | — |
| `COPYFILE_FICLONE` | implemented | — |
| `COPYFILE_FICLONE_FORCE` | implemented | — |
| `DH_CHECK_P_NOT_PRIME` | implemented | — |
| `DH_CHECK_P_NOT_SAFE_PRIME` | implemented | — |
| `DH_NOT_SUITABLE_GENERATOR` | implemented | — |
| `DH_UNABLE_TO_CHECK_GENERATOR` | implemented | — |
| `E2BIG` | implemented | — |
| `EACCES` | implemented | — |
| `EADDRINUSE` | implemented | — |
| `EADDRNOTAVAIL` | implemented | — |
| `EAFNOSUPPORT` | implemented | — |
| `EAGAIN` | implemented | — |
| `EALREADY` | implemented | — |
| `EBADF` | implemented | — |
| `EBADMSG` | implemented | — |
| `EBUSY` | implemented | — |
| `ECANCELED` | implemented | — |
| `ECHILD` | implemented | — |
| `ECONNABORTED` | implemented | — |
| `ECONNREFUSED` | implemented | — |
| `ECONNRESET` | implemented | — |
| `EDEADLK` | implemented | — |
| `EDESTADDRREQ` | implemented | — |
| `EDOM` | implemented | — |
| `EDQUOT` | implemented | — |
| `EEXIST` | implemented | — |
| `EFAULT` | implemented | — |
| `EFBIG` | implemented | — |
| `EHOSTUNREACH` | implemented | — |
| `EIDRM` | implemented | — |
| `EILSEQ` | implemented | — |
| `EINPROGRESS` | implemented | — |
| `EINTR` | implemented | — |
| `EINVAL` | implemented | — |
| `EIO` | implemented | — |
| `EISCONN` | implemented | — |
| `EISDIR` | implemented | — |
| `ELOOP` | implemented | — |
| `EMFILE` | implemented | — |
| `EMLINK` | implemented | — |
| `EMSGSIZE` | implemented | — |
| `EMULTIHOP` | implemented | — |
| `ENAMETOOLONG` | implemented | — |
| `ENETDOWN` | implemented | — |
| `ENETRESET` | implemented | — |
| `ENETUNREACH` | implemented | — |
| `ENFILE` | implemented | — |
| `ENGINE_METHOD_ALL` | implemented | — |
| `ENGINE_METHOD_CIPHERS` | implemented | — |
| `ENGINE_METHOD_DH` | implemented | — |
| `ENGINE_METHOD_DIGESTS` | implemented | — |
| `ENGINE_METHOD_DSA` | implemented | — |
| `ENGINE_METHOD_EC` | implemented | — |
| `ENGINE_METHOD_NONE` | implemented | — |
| `ENGINE_METHOD_PKEY_ASN1_METHS` | implemented | — |
| `ENGINE_METHOD_PKEY_METHS` | implemented | — |
| `ENGINE_METHOD_RAND` | implemented | — |
| `ENGINE_METHOD_RSA` | implemented | — |
| `ENOBUFS` | implemented | — |
| `ENODATA` | implemented | — |
| `ENODEV` | implemented | — |
| `ENOENT` | implemented | — |
| `ENOEXEC` | implemented | — |
| `ENOLCK` | implemented | — |
| `ENOLINK` | implemented | — |
| `ENOMEM` | implemented | — |
| `ENOMSG` | implemented | — |
| `ENOPROTOOPT` | implemented | — |
| `ENOSPC` | implemented | — |
| `ENOSR` | implemented | — |
| `ENOSTR` | implemented | — |
| `ENOSYS` | implemented | — |
| `ENOTCONN` | implemented | — |
| `ENOTDIR` | implemented | — |
| `ENOTEMPTY` | implemented | — |
| `ENOTSOCK` | implemented | — |
| `ENOTSUP` | implemented | — |
| `ENOTTY` | implemented | — |
| `ENXIO` | implemented | — |
| `EOPNOTSUPP` | implemented | — |
| `EOVERFLOW` | implemented | — |
| `EPERM` | implemented | — |
| `EPIPE` | implemented | — |
| `EPROTO` | implemented | — |
| `EPROTONOSUPPORT` | implemented | — |
| `EPROTOTYPE` | implemented | — |
| `ERANGE` | implemented | — |
| `EROFS` | implemented | — |
| `ESPIPE` | implemented | — |
| `ESRCH` | implemented | — |
| `ESTALE` | implemented | — |
| `ETIME` | implemented | — |
| `ETIMEDOUT` | implemented | — |
| `ETXTBSY` | implemented | — |
| `EWOULDBLOCK` | implemented | — |
| `EXDEV` | implemented | — |
| `F_OK` | implemented | — |
| `OPENSSL_VERSION_NUMBER` | implemented | — |
| `O_APPEND` | implemented | — |
| `O_CREAT` | implemented | — |
| `O_DIRECT` | implemented | — |
| `O_DIRECTORY` | implemented | — |
| `O_DSYNC` | implemented | — |
| `O_EXCL` | implemented | — |
| `O_NOATIME` | implemented | — |
| `O_NOCTTY` | implemented | — |
| `O_NOFOLLOW` | implemented | — |
| `O_NONBLOCK` | implemented | — |
| `O_RDONLY` | implemented | — |
| `O_RDWR` | implemented | — |
| `O_SYNC` | implemented | — |
| `O_TRUNC` | implemented | — |
| `O_WRONLY` | implemented | — |
| `POINT_CONVERSION_COMPRESSED` | implemented | — |
| `POINT_CONVERSION_HYBRID` | implemented | — |
| `POINT_CONVERSION_UNCOMPRESSED` | implemented | — |
| `PRIORITY_ABOVE_NORMAL` | implemented | — |
| `PRIORITY_BELOW_NORMAL` | implemented | — |
| `PRIORITY_HIGH` | implemented | — |
| `PRIORITY_HIGHEST` | implemented | — |
| `PRIORITY_LOW` | implemented | — |
| `PRIORITY_NORMAL` | implemented | — |
| `RSA_NO_PADDING` | implemented | — |
| `RSA_PKCS1_OAEP_PADDING` | implemented | — |
| `RSA_PKCS1_PADDING` | implemented | — |
| `RSA_PKCS1_PSS_PADDING` | implemented | — |
| `RSA_PSS_SALTLEN_AUTO` | implemented | — |
| `RSA_PSS_SALTLEN_DIGEST` | implemented | — |
| `RSA_PSS_SALTLEN_MAX_SIGN` | implemented | — |
| `RSA_SSLV23_PADDING` | implemented | — |
| `RSA_X931_PADDING` | implemented | — |
| `RTLD_DEEPBIND` | implemented | — |
| `RTLD_GLOBAL` | implemented | — |
| `RTLD_LAZY` | implemented | — |
| `RTLD_LOCAL` | implemented | — |
| `RTLD_NOW` | implemented | — |
| `R_OK` | implemented | — |
| `SIGABRT` | implemented | — |
| `SIGALRM` | implemented | — |
| `SIGBUS` | implemented | — |
| `SIGCHLD` | implemented | — |
| `SIGCONT` | implemented | — |
| `SIGFPE` | implemented | — |
| `SIGHUP` | implemented | — |
| `SIGILL` | implemented | — |
| `SIGINT` | implemented | — |
| `SIGIO` | implemented | — |
| `SIGIOT` | implemented | — |
| `SIGKILL` | implemented | — |
| `SIGPIPE` | implemented | — |
| `SIGPOLL` | implemented | — |
| `SIGPROF` | implemented | — |
| `SIGPWR` | implemented | — |
| `SIGQUIT` | implemented | — |
| `SIGSEGV` | implemented | — |
| `SIGSTKFLT` | implemented | — |
| `SIGSTOP` | implemented | — |
| `SIGSYS` | implemented | — |
| `SIGTERM` | implemented | — |
| `SIGTRAP` | implemented | — |
| `SIGTSTP` | implemented | — |
| `SIGTTIN` | implemented | — |
| `SIGTTOU` | implemented | — |
| `SIGURG` | implemented | — |
| `SIGUSR1` | implemented | — |
| `SIGUSR2` | implemented | — |
| `SIGVTALRM` | implemented | — |
| `SIGWINCH` | implemented | — |
| `SIGXCPU` | implemented | — |
| `SIGXFSZ` | implemented | — |
| `SSL_OP_ALL` | implemented | — |
| `SSL_OP_ALLOW_NO_DHE_KEX` | implemented | — |
| `SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION` | implemented | — |
| `SSL_OP_CIPHER_SERVER_PREFERENCE` | implemented | — |
| `SSL_OP_CISCO_ANYCONNECT` | implemented | — |
| `SSL_OP_COOKIE_EXCHANGE` | implemented | — |
| `SSL_OP_CRYPTOPRO_TLSEXT_BUG` | implemented | — |
| `SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS` | implemented | — |
| `SSL_OP_LEGACY_SERVER_CONNECT` | implemented | — |
| `SSL_OP_NO_COMPRESSION` | implemented | — |
| `SSL_OP_NO_ENCRYPT_THEN_MAC` | implemented | — |
| `SSL_OP_NO_QUERY_MTU` | implemented | — |
| `SSL_OP_NO_RENEGOTIATION` | implemented | — |
| `SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION` | implemented | — |
| `SSL_OP_NO_SSLv2` | implemented | — |
| `SSL_OP_NO_SSLv3` | implemented | — |
| `SSL_OP_NO_TICKET` | implemented | — |
| `SSL_OP_NO_TLSv1` | implemented | — |
| `SSL_OP_NO_TLSv1_1` | implemented | — |
| `SSL_OP_NO_TLSv1_2` | implemented | — |
| `SSL_OP_NO_TLSv1_3` | implemented | — |
| `SSL_OP_PRIORITIZE_CHACHA` | implemented | — |
| `SSL_OP_TLS_ROLLBACK_BUG` | implemented | — |
| `S_IFBLK` | implemented | — |
| `S_IFCHR` | implemented | — |
| `S_IFDIR` | implemented | — |
| `S_IFIFO` | implemented | — |
| `S_IFLNK` | implemented | — |
| `S_IFMT` | implemented | — |
| `S_IFREG` | implemented | — |
| `S_IFSOCK` | implemented | — |
| `S_IRGRP` | implemented | — |
| `S_IROTH` | implemented | — |
| `S_IRUSR` | implemented | — |
| `S_IRWXG` | implemented | — |
| `S_IRWXO` | implemented | — |
| `S_IRWXU` | implemented | — |
| `S_IWGRP` | implemented | — |
| `S_IWOTH` | implemented | — |
| `S_IWUSR` | implemented | — |
| `S_IXGRP` | implemented | — |
| `S_IXOTH` | implemented | — |
| `S_IXUSR` | implemented | — |
| `TLS1_1_VERSION` | implemented | — |
| `TLS1_2_VERSION` | implemented | — |
| `TLS1_3_VERSION` | implemented | — |
| `TLS1_VERSION` | implemented | — |
| `UV_DIRENT_BLOCK` | implemented | — |
| `UV_DIRENT_CHAR` | implemented | — |
| `UV_DIRENT_DIR` | implemented | — |
| `UV_DIRENT_FIFO` | implemented | — |
| `UV_DIRENT_FILE` | implemented | — |
| `UV_DIRENT_LINK` | implemented | — |
| `UV_DIRENT_SOCKET` | implemented | — |
| `UV_DIRENT_UNKNOWN` | implemented | — |
| `UV_FS_COPYFILE_EXCL` | implemented | — |
| `UV_FS_COPYFILE_FICLONE` | implemented | — |
| `UV_FS_COPYFILE_FICLONE_FORCE` | implemented | — |
| `UV_FS_O_FILEMAP` | implemented | — |
| `UV_FS_SYMLINK_DIR` | implemented | — |
| `UV_FS_SYMLINK_JUNCTION` | implemented | — |
| `W_OK` | implemented | — |
| `X_OK` | implemented | — |
| `defaultCipherList` | implemented | — |
| `defaultCoreCipherList` | implemented | — |

### crypto

| API | Status | Reason |
|-----|--------|--------|
| `Certificate` | implemented | — |
| `Certificate.prototype.exportChallenge` | implemented | — |
| `Certificate.prototype.exportPublicKey` | implemented | — |
| `Certificate.prototype.verifySpkac` | implemented | — |
| `Cipheriv` | implemented | — |
| `Cipheriv.prototype.final` | implemented | — |
| `Cipheriv.prototype.getAuthTag` | implemented | — |
| `Cipheriv.prototype.setAAD` | implemented | — |
| `Cipheriv.prototype.setAutoPadding` | implemented | — |
| `Cipheriv.prototype.update` | implemented | — |
| `Decipheriv` | implemented | — |
| `Decipheriv.prototype.final` | implemented | — |
| `Decipheriv.prototype.setAAD` | implemented | — |
| `Decipheriv.prototype.setAuthTag` | implemented | — |
| `Decipheriv.prototype.setAutoPadding` | implemented | — |
| `Decipheriv.prototype.update` | implemented | — |
| `DiffieHellman` | implemented | — |
| `DiffieHellman.prototype.computeSecret` | implemented | — |
| `DiffieHellman.prototype.generateKeys` | implemented | — |
| `DiffieHellman.prototype.getGenerator` | implemented | — |
| `DiffieHellman.prototype.getPrime` | implemented | — |
| `DiffieHellman.prototype.getPrivateKey` | implemented | — |
| `DiffieHellman.prototype.getPublicKey` | implemented | — |
| `DiffieHellman.prototype.setPrivateKey` | implemented | — |
| `DiffieHellman.prototype.setPublicKey` | implemented | — |
| `DiffieHellmanGroup` | implemented | — |
| `DiffieHellmanGroup.prototype.computeSecret` | implemented | — |
| `DiffieHellmanGroup.prototype.generateKeys` | implemented | — |
| `DiffieHellmanGroup.prototype.getGenerator` | implemented | — |
| `DiffieHellmanGroup.prototype.getPrime` | implemented | — |
| `DiffieHellmanGroup.prototype.getPrivateKey` | implemented | — |
| `DiffieHellmanGroup.prototype.getPublicKey` | implemented | — |
| `ECDH` | implemented | — |
| `ECDH.prototype.computeSecret` | implemented | — |
| `ECDH.prototype.generateKeys` | implemented | — |
| `ECDH.prototype.getPrivateKey` | implemented | — |
| `ECDH.prototype.getPublicKey` | implemented | — |
| `ECDH.prototype.setPrivateKey` | implemented | — |
| `ECDH.prototype.setPublicKey` | implemented | — |
| `Hash` | implemented | — |
| `Hash.prototype.copy` | implemented | — |
| `Hash.prototype.digest` | implemented | — |
| `Hash.prototype.update` | implemented | — |
| `Hmac` | implemented | — |
| `Hmac.prototype.digest` | implemented | — |
| `Hmac.prototype.update` | implemented | — |
| `KeyObject` | implemented | — |
| `KeyObject.prototype.equals` | implemented | — |
| `KeyObject.prototype.toCryptoKey` | implemented | — |
| `KeyObject.prototype.type` | unsupported | not present in shim class |
| `Sign` | implemented | — |
| `Sign.prototype.sign` | implemented | — |
| `Sign.prototype.update` | implemented | — |
| `Verify` | implemented | — |
| `Verify.prototype.update` | implemented | — |
| `Verify.prototype.verify` | implemented | — |
| `X509Certificate` | implemented | — |
| `X509Certificate.prototype.ca` | unsupported | not present in shim class |
| `X509Certificate.prototype.checkEmail` | implemented | — |
| `X509Certificate.prototype.checkHost` | implemented | — |
| `X509Certificate.prototype.checkIP` | implemented | — |
| `X509Certificate.prototype.checkIssued` | implemented | — |
| `X509Certificate.prototype.checkPrivateKey` | implemented | — |
| `X509Certificate.prototype.fingerprint` | unsupported | not present in shim class |
| `X509Certificate.prototype.fingerprint256` | unsupported | not present in shim class |
| `X509Certificate.prototype.fingerprint512` | unsupported | not present in shim class |
| `X509Certificate.prototype.infoAccess` | unsupported | not present in shim class |
| `X509Certificate.prototype.issuer` | unsupported | not present in shim class |
| `X509Certificate.prototype.issuerCertificate` | unsupported | not present in shim class |
| `X509Certificate.prototype.keyUsage` | unsupported | not present in shim class |
| `X509Certificate.prototype.publicKey` | unsupported | not present in shim class |
| `X509Certificate.prototype.raw` | unsupported | not present in shim class |
| `X509Certificate.prototype.serialNumber` | unsupported | not present in shim class |
| `X509Certificate.prototype.signatureAlgorithm` | unsupported | not present in shim class |
| `X509Certificate.prototype.signatureAlgorithmOid` | unsupported | not present in shim class |
| `X509Certificate.prototype.subject` | unsupported | not present in shim class |
| `X509Certificate.prototype.subjectAltName` | unsupported | not present in shim class |
| `X509Certificate.prototype.toJSON` | implemented | — |
| `X509Certificate.prototype.toLegacyObject` | implemented | — |
| `X509Certificate.prototype.toString` | implemented | — |
| `X509Certificate.prototype.validFrom` | unsupported | not present in shim class |
| `X509Certificate.prototype.validFromDate` | unsupported | not present in shim class |
| `X509Certificate.prototype.validTo` | unsupported | not present in shim class |
| `X509Certificate.prototype.validToDate` | unsupported | not present in shim class |
| `X509Certificate.prototype.verify` | implemented | — |
| `argon2` | implemented | — |
| `argon2Sync` | implemented | — |
| `checkPrime` | implemented | — |
| `checkPrimeSync` | implemented | — |
| `constants` | implemented | — |
| `createCipheriv` | implemented | — |
| `createDecipheriv` | implemented | — |
| `createDiffieHellman` | implemented | — |
| `createDiffieHellmanGroup` | implemented | — |
| `createECDH` | implemented | — |
| `createHash` | implemented | — |
| `createHmac` | implemented | — |
| `createPrivateKey` | implemented | — |
| `createPublicKey` | implemented | — |
| `createSecretKey` | implemented | — |
| `createSign` | implemented | — |
| `createVerify` | implemented | — |
| `decapsulate` | implemented | — |
| `diffieHellman` | implemented | — |
| `encapsulate` | implemented | — |
| `generateKey` | implemented | — |
| `generateKeyPair` | implemented | — |
| `generateKeyPairSync` | implemented | — |
| `generateKeySync` | implemented | — |
| `generatePrime` | implemented | — |
| `generatePrimeSync` | implemented | — |
| `getCipherInfo` | implemented | — |
| `getCiphers` | implemented | — |
| `getCurves` | implemented | — |
| `getDiffieHellman` | implemented | — |
| `getFips` | implemented | — |
| `getHashes` | implemented | — |
| `getRandomValues` | implemented | — |
| `hash` | implemented | — |
| `hkdf` | implemented | — |
| `hkdfSync` | implemented | — |
| `pbkdf2` | implemented | — |
| `pbkdf2Sync` | implemented | — |
| `privateDecrypt` | implemented | — |
| `privateEncrypt` | implemented | — |
| `publicDecrypt` | implemented | — |
| `publicEncrypt` | implemented | — |
| `randomBytes` | implemented | — |
| `randomFill` | implemented | — |
| `randomFillSync` | implemented | — |
| `randomInt` | implemented | — |
| `randomUUID` | implemented | — |
| `randomUUIDv7` | implemented | — |
| `scrypt` | implemented | — |
| `scryptSync` | implemented | — |
| `secureHeapUsed` | implemented | — |
| `setEngine` | implemented | — |
| `setFips` | implemented | — |
| `sign` | implemented | — |
| `subtle` | implemented | — |
| `timingSafeEqual` | implemented | — |
| `verify` | implemented | — |
| `webcrypto` | implemented | — |

### dgram

| API | Status | Reason |
|-----|--------|--------|
| `Socket` | implemented | — |
| `Socket.prototype.addMembership` | implemented | — |
| `Socket.prototype.addSourceSpecificMembership` | implemented | — |
| `Socket.prototype.address` | implemented | — |
| `Socket.prototype.bind` | implemented | — |
| `Socket.prototype.bindSync` | implemented | — |
| `Socket.prototype.close` | implemented | — |
| `Socket.prototype.connect` | implemented | — |
| `Socket.prototype.connectSync` | implemented | — |
| `Socket.prototype.disconnect` | implemented | — |
| `Socket.prototype.dropMembership` | implemented | — |
| `Socket.prototype.dropSourceSpecificMembership` | implemented | — |
| `Socket.prototype.getRecvBufferSize` | implemented | — |
| `Socket.prototype.getSendBufferSize` | honest-noop | — |
| `Socket.prototype.getSendQueueCount` | honest-noop | — |
| `Socket.prototype.getSendQueueSize` | honest-noop | — |
| `Socket.prototype.ref` | honest-noop | — |
| `Socket.prototype.remoteAddress` | implemented | — |
| `Socket.prototype.send` | implemented | — |
| `Socket.prototype.sendto` | implemented | — |
| `Socket.prototype.setBroadcast` | honest-noop | — |
| `Socket.prototype.setMulticastInterface` | implemented | — |
| `Socket.prototype.setMulticastLoopback` | implemented | — |
| `Socket.prototype.setMulticastTTL` | implemented | — |
| `Socket.prototype.setRecvBufferSize` | implemented | — |
| `Socket.prototype.setSendBufferSize` | implemented | — |
| `Socket.prototype.setTTL` | implemented | — |
| `Socket.prototype.unref` | honest-noop | — |
| `createSocket` | implemented | — |

### diagnostics_channel

| API | Status | Reason |
|-----|--------|--------|
| `Channel` | implemented | — |
| `Channel.prototype.bindStore` | implemented | — |
| `Channel.prototype.hasSubscribers` | honest-noop | — |
| `Channel.prototype.publish` | honest-noop | — |
| `Channel.prototype.runStores` | implemented | — |
| `Channel.prototype.subscribe` | implemented | — |
| `Channel.prototype.unbindStore` | honest-noop | — |
| `Channel.prototype.unsubscribe` | honest-noop | — |
| `channel` | implemented | — |
| `hasSubscribers` | implemented | — |
| `subscribe` | implemented | — |
| `tracingChannel` | implemented | — |
| `unsubscribe` | implemented | — |

### dns

| API | Status | Reason |
|-----|--------|--------|
| `ADDRCONFIG` | implemented | — |
| `ADDRGETNETWORKPARAMS` | implemented | — |
| `ALL` | implemented | — |
| `BADFAMILY` | implemented | — |
| `BADFLAGS` | implemented | — |
| `BADHINTS` | implemented | — |
| `BADNAME` | implemented | — |
| `BADQUERY` | implemented | — |
| `BADRESP` | implemented | — |
| `BADSTR` | implemented | — |
| `CANCELLED` | implemented | — |
| `CONNREFUSED` | implemented | — |
| `DESTRUCTION` | implemented | — |
| `EOF` | implemented | — |
| `FILE` | implemented | — |
| `FORMERR` | implemented | — |
| `LOADIPHLPAPI` | implemented | — |
| `NODATA` | implemented | — |
| `NOMEM` | implemented | — |
| `NONAME` | implemented | — |
| `NOTFOUND` | implemented | — |
| `NOTIMP` | implemented | — |
| `NOTINITIALIZED` | implemented | — |
| `REFUSED` | implemented | — |
| `Resolver` | implemented | — |
| `Resolver.prototype.resolve` | implemented | — |
| `Resolver.prototype.resolve4` | implemented | — |
| `Resolver.prototype.resolve6` | implemented | — |
| `Resolver.prototype.resolveAny` | implemented | — |
| `Resolver.prototype.resolveCaa` | implemented | — |
| `Resolver.prototype.resolveCname` | implemented | — |
| `Resolver.prototype.resolveMx` | implemented | — |
| `Resolver.prototype.resolveNaptr` | implemented | — |
| `Resolver.prototype.resolveNs` | implemented | — |
| `Resolver.prototype.resolvePtr` | implemented | — |
| `Resolver.prototype.resolveSoa` | implemented | — |
| `Resolver.prototype.resolveSrv` | implemented | — |
| `Resolver.prototype.resolveTlsa` | implemented | — |
| `Resolver.prototype.resolveTxt` | implemented | — |
| `Resolver.prototype.reverse` | implemented | — |
| `SERVFAIL` | implemented | — |
| `TIMEOUT` | implemented | — |
| `V4MAPPED` | implemented | — |
| `getDefaultResultOrder` | implemented | — |
| `getServers` | implemented | — |
| `lookup` | implemented | — |
| `lookupService` | implemented | — |
| `promises` | implemented | — |
| `resolve` | implemented | — |
| `resolve4` | implemented | — |
| `resolve6` | implemented | — |
| `resolveAny` | implemented | — |
| `resolveCaa` | implemented | — |
| `resolveCname` | implemented | — |
| `resolveMx` | implemented | — |
| `resolveNaptr` | implemented | — |
| `resolveNs` | implemented | — |
| `resolvePtr` | implemented | — |
| `resolveSoa` | implemented | — |
| `resolveSrv` | implemented | — |
| `resolveTlsa` | implemented | — |
| `resolveTxt` | implemented | — |
| `reverse` | implemented | — |
| `setDefaultResultOrder` | implemented | — |
| `setServers` | implemented | — |

### domain

| API | Status | Reason |
|-----|--------|--------|
| `Domain` | implemented | — |
| `Domain.prototype.add` | implemented | — |
| `Domain.prototype.bind` | implemented | — |
| `Domain.prototype.enter` | implemented | — |
| `Domain.prototype.exit` | implemented | — |
| `Domain.prototype.intercept` | implemented | — |
| `Domain.prototype.members` | unsupported | not present in shim class |
| `Domain.prototype.remove` | implemented | — |
| `Domain.prototype.run` | implemented | — |
| `active` | honest-noop | — |
| `create` | implemented | — |
| `createDomain` | implemented | — |

### events

| API | Status | Reason |
|-----|--------|--------|
| `EventEmitter` | implemented | — |
| `EventEmitter.prototype.addListener` | implemented | — |
| `EventEmitter.prototype.emit` | implemented | — |
| `EventEmitter.prototype.eventNames` | implemented | — |
| `EventEmitter.prototype.getMaxListeners` | implemented | — |
| `EventEmitter.prototype.listenerCount` | implemented | — |
| `EventEmitter.prototype.listeners` | implemented | — |
| `EventEmitter.prototype.off` | implemented | — |
| `EventEmitter.prototype.on` | implemented | — |
| `EventEmitter.prototype.once` | implemented | — |
| `EventEmitter.prototype.prependListener` | implemented | — |
| `EventEmitter.prototype.prependOnceListener` | implemented | — |
| `EventEmitter.prototype.rawListeners` | implemented | — |
| `EventEmitter.prototype.removeAllListeners` | implemented | — |
| `EventEmitter.prototype.removeListener` | implemented | — |
| `EventEmitter.prototype.setMaxListeners` | implemented | — |
| `EventEmitterAsyncResource` | implemented | — |
| `EventEmitterAsyncResource.prototype.asyncId` | implemented | — |
| `EventEmitterAsyncResource.prototype.asyncResource` | implemented | — |
| `EventEmitterAsyncResource.prototype.emit` | implemented | — |
| `EventEmitterAsyncResource.prototype.emitDestroy` | implemented | — |
| `EventEmitterAsyncResource.prototype.triggerAsyncId` | implemented | — |
| `addAbortListener` | implemented | — |
| `captureRejectionSymbol` | unknown | export shape not extractable from source (re-export or computed) |
| `captureRejections` | honest-noop | — |
| `defaultMaxListeners` | implemented | — |
| `errorMonitor` | unknown | export shape not extractable from source (re-export or computed) |
| `getEventListeners` | implemented | — |
| `getMaxListeners` | implemented | — |
| `init` | implemented | — |
| `listenerCount` | implemented | — |
| `on` | implemented | — |
| `once` | implemented | — |
| `setMaxListeners` | implemented | — |
| `usingDomains` | implemented | — |

### fs

| API | Status | Reason |
|-----|--------|--------|
| `Dir` | implemented | — |
| `Dir.prototype.close` | implemented | — |
| `Dir.prototype.closeSync` | implemented | — |
| `Dir.prototype.entries` | unsupported | not present in shim class |
| `Dir.prototype.path` | unsupported | not present in shim class |
| `Dir.prototype.processReadResult` | unsupported | not present in shim class |
| `Dir.prototype.read` | implemented | — |
| `Dir.prototype.readSync` | implemented | — |
| `Dir.prototype.readSyncRecursive` | unsupported | not present in shim class |
| `Dirent` | implemented | — |
| `Dirent.prototype.isBlockDevice` | implemented | — |
| `Dirent.prototype.isCharacterDevice` | implemented | — |
| `Dirent.prototype.isDirectory` | implemented | — |
| `Dirent.prototype.isFIFO` | implemented | — |
| `Dirent.prototype.isFile` | implemented | — |
| `Dirent.prototype.isSocket` | implemented | — |
| `Dirent.prototype.isSymbolicLink` | implemented | — |
| `FileReadStream` | implemented | — |
| `FileReadStream.prototype.autoClose` | unsupported | not present in shim class |
| `FileReadStream.prototype.close` | implemented | — |
| `FileReadStream.prototype.open` | implemented | — |
| `FileReadStream.prototype.pending` | unsupported | not present in shim class |
| `FileWriteStream` | implemented | — |
| `FileWriteStream.prototype.autoClose` | unsupported | not present in shim class |
| `FileWriteStream.prototype.close` | implemented | — |
| `FileWriteStream.prototype.destroySoon` | unsupported | not present in shim class |
| `FileWriteStream.prototype.open` | implemented | — |
| `FileWriteStream.prototype.pending` | unsupported | not present in shim class |
| `ReadStream` | implemented | — |
| `ReadStream.prototype.autoClose` | unsupported | not present in shim class |
| `ReadStream.prototype.close` | implemented | — |
| `ReadStream.prototype.open` | implemented | — |
| `ReadStream.prototype.pending` | unsupported | not present in shim class |
| `Stats` | implemented | — |
| `Stats.prototype.atime` | implemented | — |
| `Stats.prototype.birthtime` | implemented | — |
| `Stats.prototype.ctime` | implemented | — |
| `Stats.prototype.mtime` | implemented | — |
| `Utf8Stream` | implemented | — |
| `Utf8Stream.prototype.append` | unsupported | not present in shim class |
| `Utf8Stream.prototype.contentMode` | unsupported | not present in shim class |
| `Utf8Stream.prototype.destroy` | implemented | — |
| `Utf8Stream.prototype.end` | implemented | — |
| `Utf8Stream.prototype.fd` | unsupported | not present in shim class |
| `Utf8Stream.prototype.file` | unsupported | not present in shim class |
| `Utf8Stream.prototype.flush` | unsupported | not present in shim class |
| `Utf8Stream.prototype.flushSync` | unsupported | not present in shim class |
| `Utf8Stream.prototype.fsync` | unsupported | not present in shim class |
| `Utf8Stream.prototype.maxLength` | unsupported | not present in shim class |
| `Utf8Stream.prototype.minLength` | unsupported | not present in shim class |
| `Utf8Stream.prototype.mkdir` | unsupported | not present in shim class |
| `Utf8Stream.prototype.mode` | unsupported | not present in shim class |
| `Utf8Stream.prototype.periodicFlush` | unsupported | not present in shim class |
| `Utf8Stream.prototype.reopen` | unsupported | not present in shim class |
| `Utf8Stream.prototype.sync` | unsupported | not present in shim class |
| `Utf8Stream.prototype.write` | implemented | — |
| `Utf8Stream.prototype.writing` | unsupported | not present in shim class |
| `WriteStream` | implemented | — |
| `WriteStream.prototype.autoClose` | unsupported | not present in shim class |
| `WriteStream.prototype.close` | implemented | — |
| `WriteStream.prototype.destroySoon` | unsupported | not present in shim class |
| `WriteStream.prototype.open` | implemented | — |
| `WriteStream.prototype.pending` | unsupported | not present in shim class |
| `access` | implemented | — |
| `accessSync` | implemented | — |
| `appendFile` | implemented | — |
| `appendFileSync` | implemented | — |
| `chmod` | implemented | — |
| `chmodSync` | implemented | — |
| `chown` | implemented | — |
| `chownSync` | implemented | — |
| `close` | implemented | — |
| `closeSync` | implemented | — |
| `constants` | implemented | — |
| `copyFile` | implemented | — |
| `copyFileSync` | implemented | — |
| `cp` | implemented | — |
| `cpSync` | implemented | — |
| `createReadStream` | implemented | — |
| `createWriteStream` | implemented | — |
| `exists` | honest-noop | — |
| `existsSync` | implemented | — |
| `fchmod` | implemented | — |
| `fchmodSync` | implemented | — |
| `fchown` | implemented | — |
| `fchownSync` | implemented | — |
| `fdatasync` | implemented | — |
| `fdatasyncSync` | implemented | — |
| `fstat` | implemented | — |
| `fstatSync` | implemented | — |
| `fsync` | implemented | — |
| `fsyncSync` | implemented | — |
| `ftruncate` | implemented | — |
| `ftruncateSync` | implemented | — |
| `futimes` | implemented | — |
| `futimesSync` | implemented | — |
| `glob` | implemented | — |
| `globSync` | implemented | — |
| `lchmod` | unknown | export shape not extractable from source (re-export or computed) |
| `lchmodSync` | unknown | export shape not extractable from source (re-export or computed) |
| `lchown` | implemented | — |
| `lchownSync` | implemented | — |
| `link` | implemented | — |
| `linkSync` | implemented | — |
| `lstat` | implemented | — |
| `lstatSync` | implemented | — |
| `lutimes` | implemented | — |
| `lutimesSync` | implemented | — |
| `mkdir` | implemented | — |
| `mkdirSync` | implemented | — |
| `mkdtemp` | implemented | — |
| `mkdtempDisposableSync` | implemented | — |
| `mkdtempSync` | implemented | — |
| `open` | implemented | — |
| `openAsBlob` | implemented | — |
| `openSync` | implemented | — |
| `opendir` | implemented | — |
| `opendirSync` | implemented | — |
| `promises` | honest-noop | — |
| `read` | implemented | — |
| `readFile` | implemented | — |
| `readFileSync` | implemented | — |
| `readSync` | implemented | — |
| `readdir` | implemented | — |
| `readdirSync` | implemented | — |
| `readlink` | implemented | — |
| `readlinkSync` | implemented | — |
| `readv` | implemented | — |
| `readvSync` | implemented | — |
| `realpath` | implemented | — |
| `realpathSync` | implemented | — |
| `rename` | implemented | — |
| `renameSync` | implemented | — |
| `rm` | implemented | — |
| `rmSync` | implemented | — |
| `rmdir` | implemented | — |
| `rmdirSync` | implemented | — |
| `stat` | implemented | — |
| `statSync` | implemented | — |
| `statfs` | implemented | — |
| `statfsSync` | implemented | — |
| `symlink` | implemented | — |
| `symlinkSync` | implemented | — |
| `truncate` | implemented | — |
| `truncateSync` | implemented | — |
| `unlink` | implemented | — |
| `unlinkSync` | implemented | — |
| `unwatchFile` | implemented | — |
| `utimes` | implemented | — |
| `utimesSync` | implemented | — |
| `watch` | implemented | — |
| `watchFile` | implemented | — |
| `write` | implemented | — |
| `writeFile` | implemented | — |
| `writeFileSync` | implemented | — |
| `writeSync` | implemented | — |
| `writev` | implemented | — |
| `writevSync` | implemented | — |

### http

| API | Status | Reason |
|-----|--------|--------|
| `Agent` | implemented | — |
| `Agent.prototype.addRequest` | implemented | — |
| `Agent.prototype.createConnection` | implemented | — |
| `Agent.prototype.createSocket` | implemented | — |
| `Agent.prototype.destroy` | implemented | — |
| `Agent.prototype.getName` | implemented | — |
| `Agent.prototype.keepSocketAlive` | honest-noop | — |
| `Agent.prototype.removeSocket` | implemented | — |
| `Agent.prototype.reuseSocket` | implemented | — |
| `ClientRequest` | implemented | — |
| `ClientRequest.prototype.abort` | implemented | — |
| `ClientRequest.prototype.clearTimeout` | implemented | — |
| `ClientRequest.prototype.destroy` | implemented | — |
| `ClientRequest.prototype.onSocket` | implemented | — |
| `ClientRequest.prototype.path` | implemented | — |
| `ClientRequest.prototype.setNoDelay` | honest-noop | — |
| `ClientRequest.prototype.setSocketKeepAlive` | honest-noop | — |
| `ClientRequest.prototype.setTimeout` | implemented | — |
| `CloseEvent` | implemented | — |
| `CloseEvent.prototype.code` | unsupported | not present in shim class |
| `CloseEvent.prototype.reason` | unsupported | not present in shim class |
| `CloseEvent.prototype.wasClean` | unsupported | not present in shim class |
| `IncomingMessage` | implemented | — |
| `IncomingMessage.prototype.connection` | implemented | — |
| `IncomingMessage.prototype.headers` | unsupported | not present in shim class |
| `IncomingMessage.prototype.headersDistinct` | unsupported | not present in shim class |
| `IncomingMessage.prototype.setTimeout` | implemented | — |
| `IncomingMessage.prototype.signal` | unsupported | not present in shim class |
| `IncomingMessage.prototype.trailers` | unsupported | not present in shim class |
| `IncomingMessage.prototype.trailersDistinct` | unsupported | not present in shim class |
| `METHODS` | implemented | — |
| `MessageEvent` | implemented | — |
| `MessageEvent.prototype.data` | unsupported | not present in shim class |
| `MessageEvent.prototype.initMessageEvent` | implemented | — |
| `MessageEvent.prototype.lastEventId` | unsupported | not present in shim class |
| `MessageEvent.prototype.origin` | unsupported | not present in shim class |
| `MessageEvent.prototype.ports` | unsupported | not present in shim class |
| `MessageEvent.prototype.source` | unsupported | not present in shim class |
| `OutgoingMessage` | implemented | — |
| `OutgoingMessage.prototype.addTrailers` | implemented | — |
| `OutgoingMessage.prototype.appendHeader` | implemented | — |
| `OutgoingMessage.prototype.closed` | unsupported | not present in shim class |
| `OutgoingMessage.prototype.connection` | unsupported | not present in shim class |
| `OutgoingMessage.prototype.cork` | unsupported | not present in shim class |
| `OutgoingMessage.prototype.destroy` | unsupported | not present in shim class |
| `OutgoingMessage.prototype.end` | implemented | — |
| `OutgoingMessage.prototype.errored` | unsupported | not present in shim class |
| `OutgoingMessage.prototype.flushHeaders` | implemented | — |
| `OutgoingMessage.prototype.getHeader` | implemented | — |
| `OutgoingMessage.prototype.getHeaderNames` | implemented | — |
| `OutgoingMessage.prototype.getHeaders` | implemented | — |
| `OutgoingMessage.prototype.getRawHeaderNames` | implemented | — |
| `OutgoingMessage.prototype.hasHeader` | implemented | — |
| `OutgoingMessage.prototype.headersSent` | implemented | — |
| `OutgoingMessage.prototype.pipe` | unsupported | not present in shim class |
| `OutgoingMessage.prototype.removeHeader` | implemented | — |
| `OutgoingMessage.prototype.setHeader` | implemented | — |
| `OutgoingMessage.prototype.setHeaders` | implemented | — |
| `OutgoingMessage.prototype.setTimeout` | implemented | — |
| `OutgoingMessage.prototype.socket` | unsupported | not present in shim class |
| `OutgoingMessage.prototype.uncork` | unsupported | not present in shim class |
| `OutgoingMessage.prototype.writableCorked` | unsupported | not present in shim class |
| `OutgoingMessage.prototype.writableEnded` | implemented | — |
| `OutgoingMessage.prototype.writableFinished` | unsupported | not present in shim class |
| `OutgoingMessage.prototype.writableHighWaterMark` | unsupported | not present in shim class |
| `OutgoingMessage.prototype.writableLength` | unsupported | not present in shim class |
| `OutgoingMessage.prototype.writableNeedDrain` | unsupported | not present in shim class |
| `OutgoingMessage.prototype.writableObjectMode` | unsupported | not present in shim class |
| `OutgoingMessage.prototype.write` | implemented | — |
| `STATUS_CODES` | implemented | — |
| `Server` | implemented | — |
| `Server.prototype.close` | implemented | — |
| `Server.prototype.closeAllConnections` | implemented | — |
| `Server.prototype.closeIdleConnections` | implemented | — |
| `Server.prototype.setTimeout` | implemented | — |
| `ServerResponse` | implemented | — |
| `ServerResponse.prototype.assignSocket` | implemented | — |
| `ServerResponse.prototype.detachSocket` | implemented | — |
| `ServerResponse.prototype.statusCode` | implemented | — |
| `ServerResponse.prototype.statusMessage` | unsupported | not present in shim class |
| `ServerResponse.prototype.writeContinue` | honest-noop | — |
| `ServerResponse.prototype.writeEarlyHints` | implemented | — |
| `ServerResponse.prototype.writeHead` | implemented | — |
| `ServerResponse.prototype.writeHeader` | implemented | — |
| `ServerResponse.prototype.writeInformation` | implemented | — |
| `ServerResponse.prototype.writeProcessing` | honest-noop | — |
| `WebSocket` | implemented | — |
| `WebSocket.prototype.CLOSED` | unsupported | not present in shim class |
| `WebSocket.prototype.CLOSING` | unsupported | not present in shim class |
| `WebSocket.prototype.CONNECTING` | unsupported | not present in shim class |
| `WebSocket.prototype.OPEN` | unsupported | not present in shim class |
| `WebSocket.prototype.binaryType` | unsupported | not present in shim class |
| `WebSocket.prototype.bufferedAmount` | unsupported | not present in shim class |
| `WebSocket.prototype.close` | implemented | — |
| `WebSocket.prototype.extensions` | unsupported | not present in shim class |
| `WebSocket.prototype.onclose` | unsupported | not present in shim class |
| `WebSocket.prototype.onerror` | unsupported | not present in shim class |
| `WebSocket.prototype.onmessage` | unsupported | not present in shim class |
| `WebSocket.prototype.onopen` | unsupported | not present in shim class |
| `WebSocket.prototype.protocol` | unsupported | not present in shim class |
| `WebSocket.prototype.readyState` | unsupported | not present in shim class |
| `WebSocket.prototype.send` | implemented | — |
| `WebSocket.prototype.url` | unsupported | not present in shim class |
| `createServer` | implemented | — |
| `get` | implemented | — |
| `globalAgent` | implemented | — |
| `maxHeaderSize` | implemented | — |
| `request` | implemented | — |
| `setGlobalProxyFromEnv` | honest-noop | — |
| `setMaxIdleHTTPParsers` | implemented | — |
| `validateHeaderName` | implemented | — |
| `validateHeaderValue` | implemented | — |

### http2

| API | Status | Reason |
|-----|--------|--------|
| `Http2ServerRequest` | implemented | — |
| `Http2ServerRequest.prototype.aborted` | implemented | — |
| `Http2ServerRequest.prototype.authority` | unsupported | not present in shim class |
| `Http2ServerRequest.prototype.complete` | implemented | — |
| `Http2ServerRequest.prototype.connection` | unsupported | not present in shim class |
| `Http2ServerRequest.prototype.headers` | unsupported | not present in shim class |
| `Http2ServerRequest.prototype.httpVersion` | unsupported | not present in shim class |
| `Http2ServerRequest.prototype.httpVersionMajor` | unsupported | not present in shim class |
| `Http2ServerRequest.prototype.httpVersionMinor` | unsupported | not present in shim class |
| `Http2ServerRequest.prototype.method` | unsupported | not present in shim class |
| `Http2ServerRequest.prototype.rawHeaders` | unsupported | not present in shim class |
| `Http2ServerRequest.prototype.rawTrailers` | unsupported | not present in shim class |
| `Http2ServerRequest.prototype.scheme` | unsupported | not present in shim class |
| `Http2ServerRequest.prototype.setTimeout` | implemented | — |
| `Http2ServerRequest.prototype.socket` | unsupported | not present in shim class |
| `Http2ServerRequest.prototype.stream` | unsupported | not present in shim class |
| `Http2ServerRequest.prototype.trailers` | unsupported | not present in shim class |
| `Http2ServerRequest.prototype.url` | unsupported | not present in shim class |
| `Http2ServerResponse` | implemented | — |
| `Http2ServerResponse.prototype.addTrailers` | implemented | — |
| `Http2ServerResponse.prototype.appendHeader` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.connection` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.cork` | honest-noop | — |
| `Http2ServerResponse.prototype.createPushResponse` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.destroy` | implemented | — |
| `Http2ServerResponse.prototype.end` | implemented | — |
| `Http2ServerResponse.prototype.finished` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.flushHeaders` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.getHeader` | implemented | — |
| `Http2ServerResponse.prototype.getHeaderNames` | implemented | — |
| `Http2ServerResponse.prototype.getHeaders` | honest-noop | — |
| `Http2ServerResponse.prototype.hasHeader` | implemented | — |
| `Http2ServerResponse.prototype.headersSent` | implemented | — |
| `Http2ServerResponse.prototype.removeHeader` | implemented | — |
| `Http2ServerResponse.prototype.sendDate` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.setHeader` | implemented | — |
| `Http2ServerResponse.prototype.setTimeout` | implemented | — |
| `Http2ServerResponse.prototype.setTrailer` | implemented | — |
| `Http2ServerResponse.prototype.socket` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.statusCode` | implemented | — |
| `Http2ServerResponse.prototype.statusMessage` | honest-noop | — |
| `Http2ServerResponse.prototype.stream` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.uncork` | honest-noop | — |
| `Http2ServerResponse.prototype.writableCorked` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.writableEnded` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.writableFinished` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.writableHighWaterMark` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.writableLength` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.writableNeedDrain` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.writableObjectMode` | unsupported | not present in shim class |
| `Http2ServerResponse.prototype.write` | implemented | — |
| `Http2ServerResponse.prototype.writeContinue` | implemented | — |
| `Http2ServerResponse.prototype.writeEarlyHints` | implemented | — |
| `Http2ServerResponse.prototype.writeHead` | implemented | — |
| `Http2ServerResponse.prototype.writeInformation` | implemented | — |
| `connect` | implemented | — |
| `constants` | implemented | — |
| `createSecureServer` | implemented | — |
| `createServer` | implemented | — |
| `getDefaultSettings` | implemented | — |
| `getPackedSettings` | implemented | — |
| `getUnpackedSettings` | implemented | — |
| `performServerHandshake` | implemented | — |
| `sensitiveHeaders` | implemented | — |

### https

| API | Status | Reason |
|-----|--------|--------|
| `Agent` | implemented | — |
| `Agent.prototype.createConnection` | unsupported | not present in shim class |
| `Agent.prototype.getName` | unsupported | not present in shim class |
| `Agent.prototype.keepSocketAlive` | unsupported | not present in shim class |
| `Server` | implemented | — |
| `Server.prototype.close` | unsupported | not present in shim class |
| `Server.prototype.closeAllConnections` | unsupported | not present in shim class |
| `Server.prototype.closeIdleConnections` | unsupported | not present in shim class |
| `Server.prototype.setTimeout` | unsupported | not present in shim class |
| `createServer` | implemented | — |
| `get` | implemented | — |
| `globalAgent` | implemented | — |
| `request` | implemented | — |

### inspector

| API | Status | Reason |
|-----|--------|--------|
| `DOMStorage` | implemented | — |
| `Network` | implemented | — |
| `NetworkResources` | implemented | — |
| `Session` | implemented | — |
| `Session.prototype.connect` | honest-noop | — |
| `Session.prototype.connectToMainThread` | honest-noop | — |
| `Session.prototype.disconnect` | honest-noop | — |
| `Session.prototype.post` | implemented | — |
| `close` | honest-noop | — |
| `console` | implemented | — |
| `open` | honest-noop | — |
| `url` | honest-noop | — |
| `waitForDebugger` | honest-noop | — |

### module

| API | Status | Reason |
|-----|--------|--------|
| `Module` | implemented | — |
| `Module.prototype.isPreloading` | unsupported | not present in shim class |
| `Module.prototype.load` | implemented | — |
| `Module.prototype.parent` | unsupported | not present in shim class |
| `Module.prototype.require` | implemented | — |
| `SourceMap` | implemented | — |
| `SourceMap.prototype.findEntry` | implemented | — |
| `SourceMap.prototype.findOrigin` | implemented | — |
| `SourceMap.prototype.lineLengths` | implemented | — |
| `SourceMap.prototype.payload` | implemented | — |
| `builtinModules` | implemented | — |
| `constants` | implemented | — |
| `createRequire` | implemented | — |
| `enableCompileCache` | implemented | — |
| `findPackageJSON` | implemented | — |
| `findSourceMap` | implemented | — |
| `flushCompileCache` | honest-noop | — |
| `getCompileCacheDir` | honest-noop | — |
| `getSourceMapsSupport` | implemented | — |
| `globalPaths` | implemented | — |
| `isBuiltin` | implemented | — |
| `register` | implemented | — |
| `registerHooks` | implemented | — |
| `runMain` | implemented | — |
| `setSourceMapsSupport` | implemented | — |
| `stripTypeScriptTypes` | implemented | — |
| `syncBuiltinESMExports` | implemented | — |

### net

| API | Status | Reason |
|-----|--------|--------|
| `BlockList` | implemented | — |
| `BlockList.prototype.addAddress` | implemented | — |
| `BlockList.prototype.addRange` | implemented | — |
| `BlockList.prototype.addSubnet` | implemented | — |
| `BlockList.prototype.check` | implemented | — |
| `BlockList.prototype.fromJSON` | implemented | — |
| `BlockList.prototype.rules` | unsupported | not present in shim class |
| `BlockList.prototype.toJSON` | implemented | — |
| `BoundSocket` | implemented | — |
| `BoundSocket.prototype.address` | implemented | — |
| `BoundSocket.prototype.close` | implemented | — |
| `BoundSocket.prototype.fd` | unsupported | not present in shim class |
| `BoundSocket.prototype.isPipe` | unsupported | not present in shim class |
| `Server` | implemented | — |
| `Server.prototype.address` | implemented | — |
| `Server.prototype.close` | implemented | — |
| `Server.prototype.getConnections` | implemented | — |
| `Server.prototype.listen` | implemented | — |
| `Server.prototype.listening` | unsupported | not present in shim class |
| `Server.prototype.ref` | implemented | — |
| `Server.prototype.unref` | implemented | — |
| `Socket` | implemented | — |
| `Socket.prototype.address` | implemented | — |
| `Socket.prototype.bufferSize` | unsupported | not present in shim class |
| `Socket.prototype.bytesRead` | unsupported | not present in shim class |
| `Socket.prototype.bytesWritten` | unsupported | not present in shim class |
| `Socket.prototype.connect` | implemented | — |
| `Socket.prototype.destroySoon` | unsupported | not present in shim class |
| `Socket.prototype.end` | unsupported | not present in shim class |
| `Socket.prototype.getTypeOfService` | unsupported | not present in shim class |
| `Socket.prototype.localAddress` | unsupported | not present in shim class |
| `Socket.prototype.localFamily` | unsupported | not present in shim class |
| `Socket.prototype.localPort` | unsupported | not present in shim class |
| `Socket.prototype.pause` | unsupported | not present in shim class |
| `Socket.prototype.pending` | unsupported | not present in shim class |
| `Socket.prototype.read` | unsupported | not present in shim class |
| `Socket.prototype.readyState` | unsupported | not present in shim class |
| `Socket.prototype.ref` | implemented | — |
| `Socket.prototype.remoteAddress` | unsupported | not present in shim class |
| `Socket.prototype.remoteFamily` | unsupported | not present in shim class |
| `Socket.prototype.remotePort` | unsupported | not present in shim class |
| `Socket.prototype.resetAndDestroy` | implemented | — |
| `Socket.prototype.resume` | unsupported | not present in shim class |
| `Socket.prototype.setKeepAlive` | implemented | — |
| `Socket.prototype.setNoDelay` | implemented | — |
| `Socket.prototype.setTimeout` | implemented | — |
| `Socket.prototype.setTypeOfService` | unsupported | not present in shim class |
| `Socket.prototype.unref` | implemented | — |
| `SocketAddress` | implemented | — |
| `SocketAddress.prototype.address` | implemented | — |
| `SocketAddress.prototype.family` | unsupported | not present in shim class |
| `SocketAddress.prototype.flowlabel` | implemented | — |
| `SocketAddress.prototype.port` | implemented | — |
| `SocketAddress.prototype.toJSON` | implemented | — |
| `Stream` | implemented | — |
| `Stream.prototype.address` | implemented | — |
| `Stream.prototype.bufferSize` | unsupported | not present in shim class |
| `Stream.prototype.bytesRead` | unsupported | not present in shim class |
| `Stream.prototype.bytesWritten` | unsupported | not present in shim class |
| `Stream.prototype.connect` | implemented | — |
| `Stream.prototype.destroySoon` | unsupported | not present in shim class |
| `Stream.prototype.end` | unsupported | not present in shim class |
| `Stream.prototype.getTypeOfService` | unsupported | not present in shim class |
| `Stream.prototype.localAddress` | unsupported | not present in shim class |
| `Stream.prototype.localFamily` | unsupported | not present in shim class |
| `Stream.prototype.localPort` | unsupported | not present in shim class |
| `Stream.prototype.pause` | unsupported | not present in shim class |
| `Stream.prototype.pending` | unsupported | not present in shim class |
| `Stream.prototype.read` | unsupported | not present in shim class |
| `Stream.prototype.readyState` | unsupported | not present in shim class |
| `Stream.prototype.ref` | implemented | — |
| `Stream.prototype.remoteAddress` | unsupported | not present in shim class |
| `Stream.prototype.remoteFamily` | unsupported | not present in shim class |
| `Stream.prototype.remotePort` | unsupported | not present in shim class |
| `Stream.prototype.resetAndDestroy` | implemented | — |
| `Stream.prototype.resume` | unsupported | not present in shim class |
| `Stream.prototype.setKeepAlive` | implemented | — |
| `Stream.prototype.setNoDelay` | implemented | — |
| `Stream.prototype.setTimeout` | implemented | — |
| `Stream.prototype.setTypeOfService` | unsupported | not present in shim class |
| `Stream.prototype.unref` | implemented | — |
| `connect` | implemented | — |
| `createConnection` | implemented | — |
| `createServer` | implemented | — |
| `getDefaultAutoSelectFamily` | implemented | — |
| `getDefaultAutoSelectFamilyAttemptTimeout` | implemented | — |
| `isIP` | implemented | — |
| `isIPv4` | implemented | — |
| `isIPv6` | implemented | — |
| `setDefaultAutoSelectFamily` | implemented | — |
| `setDefaultAutoSelectFamilyAttemptTimeout` | implemented | — |

### os

| API | Status | Reason |
|-----|--------|--------|
| `EOL` | implemented | — |
| `arch` | implemented | — |
| `availableParallelism` | implemented | — |
| `constants` | implemented | — |
| `cpus` | implemented | — |
| `devNull` | implemented | — |
| `endianness` | implemented | — |
| `freemem` | implemented | — |
| `getPriority` | implemented | — |
| `homedir` | implemented | — |
| `hostname` | implemented | — |
| `loadavg` | implemented | — |
| `machine` | implemented | — |
| `networkInterfaces` | implemented | — |
| `platform` | implemented | — |
| `release` | implemented | — |
| `setPriority` | implemented | — |
| `tmpdir` | implemented | — |
| `totalmem` | implemented | — |
| `type` | implemented | — |
| `uptime` | implemented | — |
| `userInfo` | implemented | — |
| `version` | implemented | — |

### path

| API | Status | Reason |
|-----|--------|--------|
| `basename` | implemented | — |
| `delimiter` | unknown | export shape not extractable from source (re-export or computed) |
| `dirname` | implemented | — |
| `extname` | implemented | — |
| `format` | implemented | — |
| `isAbsolute` | honest-noop | — |
| `join` | implemented | — |
| `matchesGlob` | implemented | — |
| `normalize` | implemented | — |
| `parse` | implemented | — |
| `posix` | implemented | — |
| `relative` | implemented | — |
| `resolve` | implemented | — |
| `sep` | implemented | — |
| `toNamespacedPath` | implemented | — |
| `win32` | implemented | — |

### perf_hooks

| API | Status | Reason |
|-----|--------|--------|
| `Performance` | implemented | — |
| `Performance.prototype.clearMarks` | implemented | — |
| `Performance.prototype.clearMeasures` | implemented | — |
| `Performance.prototype.clearResourceTimings` | implemented | — |
| `Performance.prototype.eventLoopUtilization` | implemented | — |
| `Performance.prototype.getEntries` | implemented | — |
| `Performance.prototype.getEntriesByName` | implemented | — |
| `Performance.prototype.getEntriesByType` | implemented | — |
| `Performance.prototype.mark` | implemented | — |
| `Performance.prototype.markResourceTiming` | implemented | — |
| `Performance.prototype.measure` | implemented | — |
| `Performance.prototype.nodeTiming` | unsupported | not present in shim class |
| `Performance.prototype.now` | implemented | — |
| `Performance.prototype.onresourcetimingbufferfull` | implemented | — |
| `Performance.prototype.setResourceTimingBufferSize` | implemented | — |
| `Performance.prototype.timeOrigin` | implemented | — |
| `Performance.prototype.timerify` | implemented | — |
| `Performance.prototype.toJSON` | implemented | — |
| `PerformanceEntry` | implemented | — |
| `PerformanceEntry.prototype.duration` | implemented | — |
| `PerformanceEntry.prototype.entryType` | implemented | — |
| `PerformanceEntry.prototype.name` | implemented | — |
| `PerformanceEntry.prototype.startTime` | implemented | — |
| `PerformanceEntry.prototype.toJSON` | implemented | — |
| `PerformanceMark` | implemented | — |
| `PerformanceMark.prototype.detail` | implemented | — |
| `PerformanceMark.prototype.toJSON` | implemented | — |
| `PerformanceMeasure` | implemented | — |
| `PerformanceMeasure.prototype.detail` | implemented | — |
| `PerformanceMeasure.prototype.toJSON` | implemented | — |
| `PerformanceObserver` | implemented | — |
| `PerformanceObserver.prototype.disconnect` | implemented | — |
| `PerformanceObserver.prototype.observe` | implemented | — |
| `PerformanceObserver.prototype.takeRecords` | implemented | — |
| `PerformanceObserverEntryList` | implemented | — |
| `PerformanceObserverEntryList.prototype.getEntries` | implemented | — |
| `PerformanceObserverEntryList.prototype.getEntriesByName` | implemented | — |
| `PerformanceObserverEntryList.prototype.getEntriesByType` | implemented | — |
| `PerformanceResourceTiming` | implemented | — |
| `PerformanceResourceTiming.prototype.connectEnd` | implemented | — |
| `PerformanceResourceTiming.prototype.connectStart` | implemented | — |
| `PerformanceResourceTiming.prototype.decodedBodySize` | implemented | — |
| `PerformanceResourceTiming.prototype.deliveryType` | implemented | — |
| `PerformanceResourceTiming.prototype.domainLookupEnd` | implemented | — |
| `PerformanceResourceTiming.prototype.domainLookupStart` | implemented | — |
| `PerformanceResourceTiming.prototype.duration` | implemented | — |
| `PerformanceResourceTiming.prototype.encodedBodySize` | implemented | — |
| `PerformanceResourceTiming.prototype.fetchStart` | implemented | — |
| `PerformanceResourceTiming.prototype.initiatorType` | implemented | — |
| `PerformanceResourceTiming.prototype.name` | implemented | — |
| `PerformanceResourceTiming.prototype.nextHopProtocol` | implemented | — |
| `PerformanceResourceTiming.prototype.redirectEnd` | implemented | — |
| `PerformanceResourceTiming.prototype.redirectStart` | implemented | — |
| `PerformanceResourceTiming.prototype.requestStart` | implemented | — |
| `PerformanceResourceTiming.prototype.responseEnd` | implemented | — |
| `PerformanceResourceTiming.prototype.responseStart` | implemented | — |
| `PerformanceResourceTiming.prototype.responseStatus` | implemented | — |
| `PerformanceResourceTiming.prototype.secureConnectionStart` | implemented | — |
| `PerformanceResourceTiming.prototype.startTime` | implemented | — |
| `PerformanceResourceTiming.prototype.toJSON` | implemented | — |
| `PerformanceResourceTiming.prototype.transferSize` | implemented | — |
| `PerformanceResourceTiming.prototype.workerStart` | implemented | — |
| `constants` | implemented | — |
| `createHistogram` | implemented | — |
| `eventLoopUtilization` | honest-noop | — |
| `monitorEventLoopDelay` | implemented | — |
| `performance` | implemented | — |
| `timerify` | implemented | — |

### process

| API | Status | Reason |
|-----|--------|--------|
| `abort` | implemented | — |
| `allowedNodeEnvironmentFlags` | implemented | — |
| `arch` | implemented | — |
| `argv` | implemented | — |
| `argv0` | implemented | — |
| `availableMemory` | implemented | — |
| `binding` | implemented | — |
| `chdir` | implemented | — |
| `config` | implemented | — |
| `constrainedMemory` | implemented | — |
| `cpuUsage` | implemented | — |
| `cwd` | implemented | — |
| `debugPort` | implemented | — |
| `dlopen` | implemented | — |
| `domain` | implemented | — |
| `emitWarning` | implemented | — |
| `env` | implemented | — |
| `execArgv` | implemented | — |
| `execPath` | implemented | — |
| `execve` | implemented | — |
| `exit` | implemented | — |
| `exitCode` | implemented | — |
| `features` | implemented | — |
| `finalization` | implemented | — |
| `getActiveResourcesInfo` | implemented | — |
| `getBuiltinModule` | implemented | — |
| `getegid` | implemented | — |
| `geteuid` | implemented | — |
| `getgid` | implemented | — |
| `getgroups` | implemented | — |
| `getuid` | implemented | — |
| `hasUncaughtExceptionCaptureCallback` | implemented | — |
| `hrtime` | implemented | — |
| `initgroups` | implemented | — |
| `kill` | implemented | — |
| `loadEnvFile` | implemented | — |
| `memoryUsage` | implemented | — |
| `moduleLoadList` | implemented | — |
| `nextTick` | implemented | — |
| `openStdin` | implemented | — |
| `pid` | implemented | — |
| `platform` | implemented | — |
| `ppid` | implemented | — |
| `reallyExit` | implemented | — |
| `ref` | implemented | — |
| `release` | implemented | — |
| `report` | implemented | — |
| `resourceUsage` | implemented | — |
| `setSourceMapsEnabled` | implemented | — |
| `setUncaughtExceptionCaptureCallback` | implemented | — |
| `setegid` | implemented | — |
| `seteuid` | implemented | — |
| `setgid` | implemented | — |
| `setgroups` | implemented | — |
| `setuid` | implemented | — |
| `sourceMapsEnabled` | implemented | — |
| `stderr` | implemented | — |
| `stdin` | implemented | — |
| `stdout` | implemented | — |
| `threadCpuUsage` | implemented | — |
| `title` | implemented | — |
| `umask` | implemented | — |
| `unref` | implemented | — |
| `uptime` | implemented | — |
| `version` | implemented | — |
| `versions` | implemented | — |

### punycode

| API | Status | Reason |
|-----|--------|--------|
| `decode` | implemented | — |
| `encode` | implemented | — |
| `toASCII` | implemented | — |
| `toUnicode` | implemented | — |
| `ucs2` | implemented | — |
| `version` | implemented | — |

### querystring

| API | Status | Reason |
|-----|--------|--------|
| `decode` | implemented | — |
| `encode` | implemented | — |
| `escape` | implemented | — |
| `parse` | implemented | — |
| `stringify` | implemented | — |
| `unescape` | implemented | — |
| `unescapeBuffer` | implemented | — |

### readline

| API | Status | Reason |
|-----|--------|--------|
| `Interface` | implemented | — |
| `Interface.prototype.question` | implemented | — |
| `clearLine` | implemented | — |
| `clearScreenDown` | implemented | — |
| `createInterface` | implemented | — |
| `cursorTo` | implemented | — |
| `emitKeypressEvents` | implemented | — |
| `moveCursor` | implemented | — |
| `promises` | unknown | export shape not extractable from source (re-export or computed) |

### repl

> **Load error:** Directory import '/home/hatch/workspace/bundleVFSModules-vite7/src/readline' is not supported resolving ES modules imported from /home/hatch/workspace/bundleVFSModules-vite7/src/repl.js

| API | Status | Reason |
|-----|--------|--------|
| `REPLServer` | implemented | — |
| `REPLServer.prototype.clearBufferedCommand` | unsupported | not present in shim class |
| `REPLServer.prototype.close` | unsupported | not present in shim class |
| `REPLServer.prototype.complete` | unsupported | not present in shim class |
| `REPLServer.prototype.completeOnEditorMode` | unsupported | not present in shim class |
| `REPLServer.prototype.createContext` | unsupported | not present in shim class |
| `REPLServer.prototype.defineCommand` | unsupported | not present in shim class |
| `REPLServer.prototype.displayPrompt` | unsupported | not present in shim class |
| `REPLServer.prototype.resetContext` | unsupported | not present in shim class |
| `REPLServer.prototype.setPrompt` | unsupported | not present in shim class |
| `REPLServer.prototype.setupHistory` | unsupported | not present in shim class |
| `REPL_MODE_SLOPPY` | implemented | — |
| `REPL_MODE_STRICT` | implemented | — |
| `Recoverable` | implemented | — |
| `isValidSyntax` | implemented | — |
| `start` | implemented | — |
| `writer` | unsupported | not yet implemented |

### sea

| API | Status | Reason |
|-----|--------|--------|
| `getAsset` | implemented | — |
| `getAssetAsBlob` | implemented | — |
| `getAssetKeys` | implemented | — |
| `getRawAsset` | implemented | — |
| `isSea` | implemented | — |

### sqlite

| API | Status | Reason |
|-----|--------|--------|
| `DatabaseSync` | implemented | — |
| `DatabaseSync.prototype.aggregate` | implemented | — |
| `DatabaseSync.prototype.applyChangeset` | implemented | — |
| `DatabaseSync.prototype.close` | implemented | — |
| `DatabaseSync.prototype.createSession` | implemented | — |
| `DatabaseSync.prototype.createTagStore` | implemented | — |
| `DatabaseSync.prototype.deserialize` | implemented | — |
| `DatabaseSync.prototype.enableDefensive` | implemented | — |
| `DatabaseSync.prototype.enableLoadExtension` | implemented | — |
| `DatabaseSync.prototype.exec` | implemented | — |
| `DatabaseSync.prototype.function` | implemented | — |
| `DatabaseSync.prototype.loadExtension` | implemented | — |
| `DatabaseSync.prototype.location` | implemented | — |
| `DatabaseSync.prototype.open` | implemented | — |
| `DatabaseSync.prototype.prepare` | implemented | — |
| `DatabaseSync.prototype.serialize` | implemented | — |
| `DatabaseSync.prototype.setAuthorizer` | implemented | — |
| `Session` | implemented | — |
| `Session.prototype.changeset` | implemented | — |
| `Session.prototype.close` | implemented | — |
| `Session.prototype.patchset` | implemented | — |
| `StatementSync` | implemented | — |
| `StatementSync.prototype.all` | implemented | — |
| `StatementSync.prototype.columns` | implemented | — |
| `StatementSync.prototype.get` | implemented | — |
| `StatementSync.prototype.iterate` | implemented | — |
| `StatementSync.prototype.run` | implemented | — |
| `StatementSync.prototype.setAllowBareNamedParameters` | implemented | — |
| `StatementSync.prototype.setAllowUnknownNamedParameters` | implemented | — |
| `StatementSync.prototype.setReadBigInts` | implemented | — |
| `StatementSync.prototype.setReturnArrays` | implemented | — |
| `backup` | implemented | — |
| `constants` | implemented | — |

### stream

| API | Status | Reason |
|-----|--------|--------|
| `Duplex` | implemented | — |
| `Duplex.prototype.cork` | implemented | — |
| `Duplex.prototype.destroy` | implemented | — |
| `Duplex.prototype.destroyed` | unsupported | not present in shim class |
| `Duplex.prototype.end` | implemented | — |
| `Duplex.prototype.setDefaultEncoding` | implemented | — |
| `Duplex.prototype.uncork` | implemented | — |
| `Duplex.prototype.writable` | unsupported | not present in shim class |
| `Duplex.prototype.writableBuffer` | unsupported | not present in shim class |
| `Duplex.prototype.writableCorked` | unsupported | not present in shim class |
| `Duplex.prototype.writableEnded` | unsupported | not present in shim class |
| `Duplex.prototype.writableFinished` | unsupported | not present in shim class |
| `Duplex.prototype.writableHighWaterMark` | unsupported | not present in shim class |
| `Duplex.prototype.writableLength` | unsupported | not present in shim class |
| `Duplex.prototype.writableNeedDrain` | unsupported | not present in shim class |
| `Duplex.prototype.writableObjectMode` | unsupported | not present in shim class |
| `Duplex.prototype.write` | implemented | — |
| `PassThrough` | implemented | — |
| `Readable` | implemented | — |
| `Readable.prototype.addListener` | implemented | — |
| `Readable.prototype.closed` | unsupported | not present in shim class |
| `Readable.prototype.compose` | implemented | — |
| `Readable.prototype.destroy` | implemented | — |
| `Readable.prototype.destroyed` | unsupported | not present in shim class |
| `Readable.prototype.drop` | implemented | — |
| `Readable.prototype.errored` | unsupported | not present in shim class |
| `Readable.prototype.every` | implemented | — |
| `Readable.prototype.filter` | implemented | — |
| `Readable.prototype.find` | implemented | — |
| `Readable.prototype.flatMap` | implemented | — |
| `Readable.prototype.forEach` | implemented | — |
| `Readable.prototype.isPaused` | implemented | — |
| `Readable.prototype.iterator` | implemented | — |
| `Readable.prototype.map` | implemented | — |
| `Readable.prototype.off` | implemented | — |
| `Readable.prototype.on` | implemented | — |
| `Readable.prototype.pause` | implemented | — |
| `Readable.prototype.pipe` | implemented | — |
| `Readable.prototype.push` | implemented | — |
| `Readable.prototype.read` | implemented | — |
| `Readable.prototype.readable` | unsupported | not present in shim class |
| `Readable.prototype.readableAborted` | unsupported | not present in shim class |
| `Readable.prototype.readableBuffer` | unsupported | not present in shim class |
| `Readable.prototype.readableDidRead` | unsupported | not present in shim class |
| `Readable.prototype.readableEncoding` | unsupported | not present in shim class |
| `Readable.prototype.readableEnded` | unsupported | not present in shim class |
| `Readable.prototype.readableFlowing` | unsupported | not present in shim class |
| `Readable.prototype.readableHighWaterMark` | unsupported | not present in shim class |
| `Readable.prototype.readableLength` | unsupported | not present in shim class |
| `Readable.prototype.readableObjectMode` | unsupported | not present in shim class |
| `Readable.prototype.reduce` | implemented | — |
| `Readable.prototype.removeAllListeners` | implemented | — |
| `Readable.prototype.removeListener` | implemented | — |
| `Readable.prototype.resume` | implemented | — |
| `Readable.prototype.setEncoding` | implemented | — |
| `Readable.prototype.some` | implemented | — |
| `Readable.prototype.take` | implemented | — |
| `Readable.prototype.toArray` | implemented | — |
| `Readable.prototype.unpipe` | implemented | — |
| `Readable.prototype.unshift` | implemented | — |
| `Readable.prototype.wrap` | implemented | — |
| `Stream` | implemented | — |
| `Stream.prototype.eventNames` | implemented | — |
| `Stream.prototype.pipe` | implemented | — |
| `Transform` | implemented | — |
| `Writable` | implemented | — |
| `Writable.prototype.closed` | unsupported | not present in shim class |
| `Writable.prototype.cork` | implemented | — |
| `Writable.prototype.destroy` | implemented | — |
| `Writable.prototype.destroyed` | unsupported | not present in shim class |
| `Writable.prototype.end` | implemented | — |
| `Writable.prototype.errored` | unsupported | not present in shim class |
| `Writable.prototype.pipe` | implemented | — |
| `Writable.prototype.setDefaultEncoding` | implemented | — |
| `Writable.prototype.uncork` | implemented | — |
| `Writable.prototype.writable` | unsupported | not present in shim class |
| `Writable.prototype.writableAborted` | unsupported | not present in shim class |
| `Writable.prototype.writableBuffer` | unsupported | not present in shim class |
| `Writable.prototype.writableCorked` | unsupported | not present in shim class |
| `Writable.prototype.writableEnded` | unsupported | not present in shim class |
| `Writable.prototype.writableFinished` | unsupported | not present in shim class |
| `Writable.prototype.writableHighWaterMark` | unsupported | not present in shim class |
| `Writable.prototype.writableLength` | unsupported | not present in shim class |
| `Writable.prototype.writableNeedDrain` | unsupported | not present in shim class |
| `Writable.prototype.writableObjectMode` | unsupported | not present in shim class |
| `Writable.prototype.write` | implemented | — |
| `addAbortSignal` | implemented | — |
| `compose` | implemented | — |
| `destroy` | implemented | — |
| `duplexPair` | implemented | — |
| `finished` | honest-noop | — |
| `getDefaultHighWaterMark` | implemented | — |
| `isDestroyed` | implemented | — |
| `isDisturbed` | implemented | — |
| `isErrored` | implemented | — |
| `isReadable` | implemented | — |
| `isWritable` | implemented | — |
| `pipeline` | implemented | — |
| `promises` | implemented | — |
| `setDefaultHighWaterMark` | implemented | — |

### stream/consumers

> **Load error:** Cannot find package 'stream-consumers' imported from /home/hatch/workspace/bundleVFSModules-vite7/src/stream-consumers.js

| API | Status | Reason |
|-----|--------|--------|
| `arrayBuffer` | unsupported | not yet implemented |
| `blob` | unsupported | not yet implemented |
| `buffer` | unsupported | not yet implemented |
| `bytes` | unsupported | not yet implemented |
| `json` | unsupported | not yet implemented |
| `text` | unsupported | not yet implemented |

### string_decoder

| API | Status | Reason |
|-----|--------|--------|
| `StringDecoder` | implemented | — |
| `StringDecoder.prototype.end` | implemented | — |
| `StringDecoder.prototype.lastChar` | unsupported | not present in shim class |
| `StringDecoder.prototype.lastNeed` | unsupported | not present in shim class |
| `StringDecoder.prototype.lastTotal` | unsupported | not present in shim class |
| `StringDecoder.prototype.text` | implemented | — |
| `StringDecoder.prototype.write` | implemented | — |

### sys

| API | Status | Reason |
|-----|--------|--------|
| `MIMEParams` | implemented | — |
| `MIMEParams.prototype.delete` | implemented | — |
| `MIMEParams.prototype.entries` | implemented | — |
| `MIMEParams.prototype.get` | implemented | — |
| `MIMEParams.prototype.has` | implemented | — |
| `MIMEParams.prototype.keys` | implemented | — |
| `MIMEParams.prototype.set` | implemented | — |
| `MIMEParams.prototype.toJSON` | implemented | — |
| `MIMEParams.prototype.toString` | implemented | — |
| `MIMEParams.prototype.values` | implemented | — |
| `MIMEType` | implemented | — |
| `MIMEType.prototype.essence` | implemented | — |
| `MIMEType.prototype.params` | unsupported | not present in shim class |
| `MIMEType.prototype.subtype` | implemented | — |
| `MIMEType.prototype.toJSON` | implemented | — |
| `MIMEType.prototype.toString` | implemented | — |
| `MIMEType.prototype.type` | implemented | — |
| `TextDecoder` | implemented | — |
| `TextDecoder.prototype.decode` | implemented | — |
| `TextDecoder.prototype.encoding` | unsupported | not present in shim class |
| `TextDecoder.prototype.fatal` | unsupported | not present in shim class |
| `TextDecoder.prototype.ignoreBOM` | unsupported | not present in shim class |
| `TextEncoder` | implemented | — |
| `TextEncoder.prototype.encode` | implemented | — |
| `TextEncoder.prototype.encodeInto` | implemented | — |
| `TextEncoder.prototype.encoding` | unsupported | not present in shim class |
| `aborted` | implemented | — |
| `callbackify` | implemented | — |
| `convertProcessSignalToExitCode` | implemented | — |
| `debug` | implemented | — |
| `debuglog` | implemented | — |
| `deprecate` | implemented | — |
| `diff` | implemented | — |
| `format` | implemented | — |
| `formatWithOptions` | implemented | — |
| `getCallSites` | implemented | — |
| `getSystemErrorMap` | implemented | — |
| `getSystemErrorMessage` | implemented | — |
| `getSystemErrorName` | implemented | — |
| `inherits` | implemented | — |
| `inspect` | implemented | — |
| `isArray` | implemented | — |
| `isDeepStrictEqual` | implemented | — |
| `parseArgs` | implemented | — |
| `parseEnv` | implemented | — |
| `promisify` | implemented | — |
| `setTraceSigInt` | implemented | — |
| `stripVTControlCharacters` | implemented | — |
| `styleText` | implemented | — |
| `toUSVString` | implemented | — |
| `transferableAbortController` | implemented | — |
| `transferableAbortSignal` | implemented | — |
| `types` | implemented | — |

### test

| API | Status | Reason |
|-----|--------|--------|
| `after` | implemented | — |
| `afterEach` | implemented | — |
| `assert` | implemented | — |
| `before` | implemented | — |
| `beforeEach` | implemented | — |
| `describe` | implemented | — |
| `expectFailure` | implemented | — |
| `getTestContext` | implemented | — |
| `it` | implemented | — |
| `mock` | implemented | — |
| `only` | implemented | — |
| `run` | implemented | — |
| `skip` | implemented | — |
| `snapshot` | implemented | — |
| `suite` | implemented | — |
| `test` | implemented | — |
| `todo` | implemented | — |

### timers

| API | Status | Reason |
|-----|--------|--------|
| `clearImmediate` | implemented | — |
| `clearInterval` | implemented | — |
| `clearTimeout` | implemented | — |
| `promises` | unknown | export shape not extractable from source (re-export or computed) |
| `setImmediate` | implemented | — |
| `setInterval` | implemented | — |
| `setTimeout` | implemented | — |

### tls

| API | Status | Reason |
|-----|--------|--------|
| `CLIENT_RENEG_LIMIT` | implemented | — |
| `CLIENT_RENEG_WINDOW` | implemented | — |
| `DEFAULT_CIPHERS` | implemented | — |
| `DEFAULT_ECDH_CURVE` | implemented | — |
| `DEFAULT_MAX_VERSION` | implemented | — |
| `DEFAULT_MIN_VERSION` | implemented | — |
| `SecureContext` | implemented | — |
| `Server` | implemented | — |
| `Server.prototype.addContext` | honest-noop | — |
| `Server.prototype.getTicketKeys` | honest-noop | — |
| `Server.prototype.setSecureContext` | honest-noop | — |
| `Server.prototype.setTicketKeys` | honest-noop | — |
| `TLSSocket` | implemented | — |
| `TLSSocket.prototype.disableRenegotiation` | honest-noop | — |
| `TLSSocket.prototype.enableTrace` | honest-noop | — |
| `TLSSocket.prototype.exportKeyingMaterial` | honest-noop | — |
| `TLSSocket.prototype.getCertificate` | honest-noop | — |
| `TLSSocket.prototype.getCipher` | honest-noop | — |
| `TLSSocket.prototype.getEphemeralKeyInfo` | honest-noop | — |
| `TLSSocket.prototype.getFinished` | honest-noop | — |
| `TLSSocket.prototype.getPeerCertificate` | honest-noop | — |
| `TLSSocket.prototype.getPeerFinished` | honest-noop | — |
| `TLSSocket.prototype.getPeerX509Certificate` | honest-noop | — |
| `TLSSocket.prototype.getProtocol` | honest-noop | — |
| `TLSSocket.prototype.getSession` | honest-noop | — |
| `TLSSocket.prototype.getSharedSigalgs` | honest-noop | — |
| `TLSSocket.prototype.getTLSTicket` | honest-noop | — |
| `TLSSocket.prototype.getX509Certificate` | honest-noop | — |
| `TLSSocket.prototype.isSessionReused` | honest-noop | — |
| `TLSSocket.prototype.renegotiate` | implemented | — |
| `TLSSocket.prototype.setKeyCert` | unsupported | not present in shim class |
| `TLSSocket.prototype.setMaxSendFragment` | honest-noop | — |
| `TLSSocket.prototype.setServername` | implemented | — |
| `TLSSocket.prototype.setSession` | honest-noop | — |
| `checkServerIdentity` | implemented | — |
| `connect` | implemented | — |
| `convertALPNProtocols` | implemented | — |
| `createSecureContext` | implemented | — |
| `createServer` | implemented | — |
| `getCACertificates` | honest-noop | — |
| `getCertificateCompressionAlgorithms` | honest-noop | — |
| `getCiphers` | honest-noop | — |
| `rootCertificates` | implemented | — |
| `setDefaultCACertificates` | honest-noop | — |

### trace_events

| API | Status | Reason |
|-----|--------|--------|
| `createTracing` | implemented | — |
| `getEnabledCategories` | implemented | — |

### tty

| API | Status | Reason |
|-----|--------|--------|
| `ReadStream` | implemented | — |
| `ReadStream.prototype.setRawMode` | implemented | — |
| `WriteStream` | implemented | — |
| `WriteStream.prototype.clearLine` | implemented | — |
| `WriteStream.prototype.clearScreenDown` | implemented | — |
| `WriteStream.prototype.cursorTo` | implemented | — |
| `WriteStream.prototype.getColorDepth` | implemented | — |
| `WriteStream.prototype.getWindowSize` | honest-noop | — |
| `WriteStream.prototype.hasColors` | implemented | — |
| `WriteStream.prototype.isTTY` | implemented | — |
| `WriteStream.prototype.moveCursor` | implemented | — |
| `isatty` | implemented | — |

### url

| API | Status | Reason |
|-----|--------|--------|
| `URL` | implemented | — |
| `URL.prototype.hash` | unsupported | not present in shim class |
| `URL.prototype.host` | unsupported | not present in shim class |
| `URL.prototype.hostname` | unsupported | not present in shim class |
| `URL.prototype.href` | unsupported | not present in shim class |
| `URL.prototype.origin` | unsupported | not present in shim class |
| `URL.prototype.password` | unsupported | not present in shim class |
| `URL.prototype.pathname` | unsupported | not present in shim class |
| `URL.prototype.port` | unsupported | not present in shim class |
| `URL.prototype.protocol` | unsupported | not present in shim class |
| `URL.prototype.search` | unsupported | not present in shim class |
| `URL.prototype.searchParams` | unsupported | not present in shim class |
| `URL.prototype.toJSON` | implemented | — |
| `URL.prototype.toString` | implemented | — |
| `URL.prototype.username` | unsupported | not present in shim class |
| `URLPattern` | unknown | export shape not extractable from source (re-export or computed) |
| `URLPattern.prototype.exec` | unsupported | not present in shim class |
| `URLPattern.prototype.hasRegExpGroups` | unsupported | not present in shim class |
| `URLPattern.prototype.hash` | unsupported | not present in shim class |
| `URLPattern.prototype.hostname` | unsupported | not present in shim class |
| `URLPattern.prototype.password` | unsupported | not present in shim class |
| `URLPattern.prototype.pathname` | unsupported | not present in shim class |
| `URLPattern.prototype.port` | unsupported | not present in shim class |
| `URLPattern.prototype.protocol` | unsupported | not present in shim class |
| `URLPattern.prototype.search` | unsupported | not present in shim class |
| `URLPattern.prototype.test` | unsupported | not present in shim class |
| `URLPattern.prototype.username` | unsupported | not present in shim class |
| `URLSearchParams` | implemented | — |
| `URLSearchParams.prototype.append` | implemented | — |
| `URLSearchParams.prototype.delete` | implemented | — |
| `URLSearchParams.prototype.entries` | implemented | — |
| `URLSearchParams.prototype.forEach` | implemented | — |
| `URLSearchParams.prototype.get` | implemented | — |
| `URLSearchParams.prototype.getAll` | implemented | — |
| `URLSearchParams.prototype.has` | implemented | — |
| `URLSearchParams.prototype.keys` | implemented | — |
| `URLSearchParams.prototype.set` | implemented | — |
| `URLSearchParams.prototype.size` | unsupported | not present in shim class |
| `URLSearchParams.prototype.sort` | implemented | — |
| `URLSearchParams.prototype.toString` | implemented | — |
| `URLSearchParams.prototype.values` | implemented | — |
| `Url` | implemented | — |
| `Url.prototype.format` | implemented | — |
| `Url.prototype.parse` | implemented | — |
| `Url.prototype.parseHost` | implemented | — |
| `Url.prototype.resolve` | implemented | — |
| `Url.prototype.resolveObject` | implemented | — |
| `domainToASCII` | implemented | — |
| `domainToUnicode` | implemented | — |
| `fileURLToPath` | implemented | — |
| `fileURLToPathBuffer` | implemented | — |
| `format` | implemented | — |
| `parse` | implemented | — |
| `pathToFileURL` | implemented | — |
| `resolve` | implemented | — |
| `resolveObject` | implemented | — |
| `urlToHttpOptions` | implemented | — |

### util

| API | Status | Reason |
|-----|--------|--------|
| `MIMEParams` | implemented | — |
| `MIMEParams.prototype.delete` | implemented | — |
| `MIMEParams.prototype.entries` | implemented | — |
| `MIMEParams.prototype.get` | implemented | — |
| `MIMEParams.prototype.has` | implemented | — |
| `MIMEParams.prototype.keys` | implemented | — |
| `MIMEParams.prototype.set` | implemented | — |
| `MIMEParams.prototype.toJSON` | unsupported | not present in shim class |
| `MIMEParams.prototype.toString` | implemented | — |
| `MIMEParams.prototype.values` | implemented | — |
| `MIMEType` | implemented | — |
| `MIMEType.prototype.essence` | implemented | — |
| `MIMEType.prototype.params` | unsupported | not present in shim class |
| `MIMEType.prototype.subtype` | implemented | — |
| `MIMEType.prototype.toJSON` | unsupported | not present in shim class |
| `MIMEType.prototype.toString` | implemented | — |
| `MIMEType.prototype.type` | implemented | — |
| `TextDecoder` | implemented | — |
| `TextDecoder.prototype.decode` | implemented | — |
| `TextDecoder.prototype.encoding` | unsupported | not present in shim class |
| `TextDecoder.prototype.fatal` | unsupported | not present in shim class |
| `TextDecoder.prototype.ignoreBOM` | unsupported | not present in shim class |
| `TextEncoder` | implemented | — |
| `TextEncoder.prototype.encode` | implemented | — |
| `TextEncoder.prototype.encodeInto` | implemented | — |
| `TextEncoder.prototype.encoding` | unsupported | not present in shim class |
| `aborted` | implemented | — |
| `callbackify` | implemented | — |
| `convertProcessSignalToExitCode` | implemented | — |
| `debug` | implemented | — |
| `debuglog` | implemented | — |
| `deprecate` | implemented | — |
| `diff` | implemented | — |
| `format` | implemented | — |
| `formatWithOptions` | implemented | — |
| `getCallSites` | implemented | — |
| `getSystemErrorMap` | implemented | — |
| `getSystemErrorMessage` | implemented | — |
| `getSystemErrorName` | implemented | — |
| `inherits` | implemented | — |
| `inspect` | implemented | — |
| `isArray` | implemented | — |
| `isDeepStrictEqual` | implemented | — |
| `parseArgs` | implemented | — |
| `parseEnv` | implemented | — |
| `promisify` | implemented | — |
| `setTraceSigInt` | implemented | — |
| `stripVTControlCharacters` | implemented | — |
| `styleText` | implemented | — |
| `toUSVString` | implemented | — |
| `transferableAbortController` | implemented | — |
| `transferableAbortSignal` | implemented | — |
| `types` | implemented | — |

### v8

| API | Status | Reason |
|-----|--------|--------|
| `DefaultDeserializer` | implemented | — |
| `DefaultSerializer` | implemented | — |
| `Deserializer` | implemented | — |
| `Deserializer.prototype.getWireFormatVersion` | unsupported | not present in shim class |
| `Deserializer.prototype.readDouble` | unsupported | not present in shim class |
| `Deserializer.prototype.readHeader` | unsupported | not present in shim class |
| `Deserializer.prototype.readRawBytes` | implemented | — |
| `Deserializer.prototype.readUint32` | unsupported | not present in shim class |
| `Deserializer.prototype.readUint64` | unsupported | not present in shim class |
| `Deserializer.prototype.readValue` | unsupported | not present in shim class |
| `Deserializer.prototype.transferArrayBuffer` | unsupported | not present in shim class |
| `GCProfiler` | implemented | — |
| `GCProfiler.prototype.start` | implemented | — |
| `GCProfiler.prototype.stop` | implemented | — |
| `Serializer` | implemented | — |
| `Serializer.prototype.releaseBuffer` | unsupported | not present in shim class |
| `Serializer.prototype.transferArrayBuffer` | unsupported | not present in shim class |
| `Serializer.prototype.writeDouble` | unsupported | not present in shim class |
| `Serializer.prototype.writeHeader` | unsupported | not present in shim class |
| `Serializer.prototype.writeRawBytes` | unsupported | not present in shim class |
| `Serializer.prototype.writeUint32` | unsupported | not present in shim class |
| `Serializer.prototype.writeUint64` | unsupported | not present in shim class |
| `Serializer.prototype.writeValue` | unsupported | not present in shim class |
| `cachedDataVersionTag` | implemented | — |
| `deserialize` | implemented | — |
| `getCppHeapStatistics` | implemented | — |
| `getHeapCodeStatistics` | implemented | — |
| `getHeapSnapshot` | implemented | — |
| `getHeapSpaceStatistics` | implemented | — |
| `getHeapStatistics` | implemented | — |
| `isStringOneByteRepresentation` | implemented | — |
| `promiseHooks` | implemented | — |
| `queryObjects` | implemented | — |
| `serialize` | implemented | — |
| `setFlagsFromString` | implemented | — |
| `setHeapSnapshotNearHeapLimit` | implemented | — |
| `startCpuProfile` | implemented | — |
| `startupSnapshot` | implemented | — |
| `stopCoverage` | implemented | — |
| `takeCoverage` | implemented | — |
| `writeHeapSnapshot` | implemented | — |

### vm

| API | Status | Reason |
|-----|--------|--------|
| `Script` | implemented | — |
| `Script.prototype.runInContext` | implemented | — |
| `Script.prototype.runInNewContext` | implemented | — |
| `Script.prototype.runInThisContext` | implemented | — |
| `compileFunction` | implemented | — |
| `constants` | implemented | — |
| `createContext` | implemented | — |
| `createScript` | implemented | — |
| `isContext` | implemented | — |
| `measureMemory` | implemented | — |
| `runInContext` | implemented | — |
| `runInNewContext` | implemented | — |
| `runInThisContext` | implemented | — |

### wasi

| API | Status | Reason |
|-----|--------|--------|
| `WASI` | implemented | — |
| `WASI.prototype.finalizeBindings` | implemented | — |
| `WASI.prototype.getImportObject` | honest-noop | — |
| `WASI.prototype.initialize` | implemented | — |
| `WASI.prototype.start` | implemented | — |

### worker_threads

| API | Status | Reason |
|-----|--------|--------|
| `BroadcastChannel` | implemented | — |
| `BroadcastChannel.prototype.close` | implemented | — |
| `BroadcastChannel.prototype.name` | unsupported | not present in shim class |
| `BroadcastChannel.prototype.onmessage` | unsupported | not present in shim class |
| `BroadcastChannel.prototype.onmessageerror` | unsupported | not present in shim class |
| `BroadcastChannel.prototype.postMessage` | implemented | — |
| `BroadcastChannel.prototype.ref` | implemented | — |
| `BroadcastChannel.prototype.unref` | implemented | — |
| `MessageChannel` | implemented | — |
| `MessagePort` | implemented | — |
| `MessagePort.prototype.close` | implemented | — |
| `MessagePort.prototype.hasRef` | implemented | — |
| `MessagePort.prototype.onmessage` | unsupported | not present in shim class |
| `MessagePort.prototype.onmessageerror` | unsupported | not present in shim class |
| `MessagePort.prototype.postMessage` | unsupported | not present in shim class |
| `MessagePort.prototype.ref` | unsupported | not present in shim class |
| `MessagePort.prototype.start` | unsupported | not present in shim class |
| `MessagePort.prototype.unref` | unsupported | not present in shim class |
| `SHARE_ENV` | implemented | — |
| `Worker` | implemented | — |
| `Worker.prototype.cpuUsage` | implemented | — |
| `Worker.prototype.getHeapSnapshot` | implemented | — |
| `Worker.prototype.getHeapStatistics` | implemented | — |
| `Worker.prototype.postMessage` | implemented | — |
| `Worker.prototype.ref` | implemented | — |
| `Worker.prototype.resourceLimits` | unsupported | not present in shim class |
| `Worker.prototype.startCpuProfile` | implemented | — |
| `Worker.prototype.startHeapProfile` | implemented | — |
| `Worker.prototype.stderr` | unsupported | not present in shim class |
| `Worker.prototype.stdin` | unsupported | not present in shim class |
| `Worker.prototype.stdout` | unsupported | not present in shim class |
| `Worker.prototype.terminate` | implemented | — |
| `Worker.prototype.threadId` | unsupported | not present in shim class |
| `Worker.prototype.threadName` | unsupported | not present in shim class |
| `Worker.prototype.unref` | implemented | — |
| `getEnvironmentData` | implemented | — |
| `isInternalThread` | implemented | — |
| `isMainThread` | implemented | — |
| `isMarkedAsUntransferable` | implemented | — |
| `locks` | implemented | — |
| `markAsUncloneable` | implemented | — |
| `markAsUntransferable` | implemented | — |
| `moveMessagePortToContext` | implemented | — |
| `parentPort` | implemented | — |
| `postMessageToThread` | implemented | — |
| `receiveMessageOnPort` | implemented | — |
| `resourceLimits` | implemented | — |
| `setEnvironmentData` | implemented | — |
| `threadId` | implemented | — |
| `threadName` | implemented | — |
| `workerData` | implemented | — |

### zlib

| API | Status | Reason |
|-----|--------|--------|
| `BrotliCompress` | implemented | — |
| `BrotliDecompress` | implemented | — |
| `Deflate` | implemented | — |
| `DeflateRaw` | implemented | — |
| `Gunzip` | implemented | — |
| `Gzip` | implemented | — |
| `Inflate` | implemented | — |
| `InflateRaw` | implemented | — |
| `Unzip` | implemented | — |
| `ZstdCompress` | implemented | — |
| `ZstdDecompress` | implemented | — |
| `brotliCompress` | implemented | — |
| `brotliCompressSync` | implemented | — |
| `brotliDecompress` | implemented | — |
| `brotliDecompressSync` | implemented | — |
| `codes` | honest-noop | — |
| `constants` | implemented | — |
| `crc32` | implemented | — |
| `createBrotliCompress` | implemented | — |
| `createBrotliDecompress` | implemented | — |
| `createDeflate` | implemented | — |
| `createDeflateRaw` | implemented | — |
| `createGunzip` | implemented | — |
| `createGzip` | implemented | — |
| `createInflate` | implemented | — |
| `createInflateRaw` | implemented | — |
| `createUnzip` | implemented | — |
| `createZstdCompress` | implemented | — |
| `createZstdDecompress` | implemented | — |
| `deflate` | implemented | — |
| `deflateRaw` | implemented | — |
| `deflateRawSync` | implemented | — |
| `deflateSync` | implemented | — |
| `gunzip` | implemented | — |
| `gunzipSync` | implemented | — |
| `gzip` | implemented | — |
| `gzipSync` | implemented | — |
| `inflate` | implemented | — |
| `inflateRaw` | implemented | — |
| `inflateRawSync` | implemented | — |
| `inflateSync` | implemented | — |
| `unzip` | implemented | — |
| `unzipSync` | implemented | — |
| `zstdCompress` | implemented | — |
| `zstdCompressSync` | implemented | — |
| `zstdDecompress` | implemented | — |
| `zstdDecompressSync` | implemented | — |


## Status legend

- **implemented**: present in the shim and contains real logic.
- **honest-noop**: present but body is empty or returns a constant / undefined / this.
- **unsupported**: absent from shim exports, or present but throws a not-implemented error.
- **unknown**: could not be classified (export shape not extractable, or module failed to load).
