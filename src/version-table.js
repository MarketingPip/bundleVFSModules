// version-table — one entry per Node 24.20.0 ↔ 26.13.1 behaviour
// change and export-surface change. Data only: no code reads this
// table to decide behaviour (each gated branch in src/ is explicit);
// it is the record the gate lanes work from and the drift detector's
// export diff feeds.
//
// Sources: the mutually-exclusive set (hidden_files/version-support/
// mutually-exclusive-set.md — 55 files, 4-cell native matrix) and the
// drift export diff (parity/drift/node26-export-diff.md — 25 added,
// 7 removed, 14 changed, regenerated from
// parity/drift/exports-node{24.20.0,26.13.1}.json).
//
// status: 'gated' (a TARGET_NODE branch in src/ selects the behaviour),
// 'pending' (no branch yet — a later lane), 'expected-failure' (no
// shim-side flag can emit both values; recorded, never hidden).
// "v24" means 24.20.0, not 24.22.1 (the host already backports ~40
// drift rows — see the set file).
//
// ponytail: data file, not logic. Ceiling: a third column when Node 27
// lands at LTS (Oct 2027); entries gain a `node27` field only where 27
// differs. Upgrade path: when the 24 build is dropped, delete the
// '24' arms and the pending 24-side entries with them.

export const VERSION_TABLE = {
  // ---- behaviour changes (40 entries, set rows in `source`) ----
  "assert-fail-single-message": {
    module: "assert",
    kind: "behaviour",
    status: "pending",
    v24: "assert.fail() with >1 arg works, emits DEP0094; fail(Symbol) -> AssertionError ERR_ASSERTION generatedMessage:false",
    node26: "fail() is single-message; multi-arg -> TypeError ERR_INVALID_ARG_TYPE; fail(Symbol) -> TypeError",
    tests: {
      v24: "test-assert-fail-deprecation.js",
      node26: "test-assert.js",
    },
    source: "set rows 1-2",
  },
  "assert-deep-diff-rendering": {
    module: "assert",
    kind: "behaviour",
    status: "pending",
    v24: "deep-equal failure diffs render values without a Proxy wrapper; Map/Set null keys, Promise identity per v24",
    node26: "diffs render the Proxy wrapper; Map/Set null/primitive keys report inequality; distinct Promise.resolve(1)s fail deepEqual",
    tests: { v24: "test-assert-deep.js", node26: "test-assert-deep.js" },
    source: "set row 3",
  },
  "buffer-detached-isascii-isutf8": {
    module: "buffer",
    kind: "behaviour",
    status: "pending",
    v24: "detached ArrayBuffer -> isAscii()/isUtf8() throw ERR_INVALID_STATE",
    node26: "detached -> true (treated as empty); non-empty 0xff pre-detach -> false",
    tests: {
      v24: "test-buffer-isascii.js, test-buffer-isutf8.js",
      node26: "test-buffer-isascii.js, test-buffer-isutf8.js",
    },
    source: "set rows 4-5",
  },
  "util-inspect-proxy-rewrap": {
    module: "util",
    kind: "behaviour",
    status: "pending",
    v24: "Proxy inspected as its target (throwing traps propagate)",
    node26: "Proxy re-wrapped per proxy in the target chain; showProxy semantics changed",
    tests: {
      v24: "test-util-inspect-proxy.js",
      node26: "test-util-inspect-proxy.js",
    },
    source: "set row 6",
  },
  "util-parseenv-null-prototype": {
    module: "util",
    kind: "behaviour",
    status: "gated",
    v24: "parseEnv() returns a plain {} (deepStrictEqual vs literal)",
    node26: "parseEnv() returns a null-prototype object ({ __proto__: null })",
    tests: {
      v24: "test-util-parse-env.js",
      node26: "test-util-parse-env.js",
    },
    source: "set row 7; gated in step 1 (PR #558)",
  },
  "util-inspect-dataview-indent": {
    module: "util",
    kind: "behaviour",
    status: "gated",
    v24: "detached DataView extras render at 6-space indent, closing brace at 4 (formatExtraProperties indentation leak: a throwing getter never runs the -= 2)",
    node26: "detached DataView extras render at 2-space indent, closing brace at 0 (value read before indenting)",
    tests: {
      v24: "test-util-inspect.js",
      node26: "test-util-inspect.js",
    },
    source: "set row 8; gated in step 1 (PR #558)",
  },
  "crypto-shake-dep0198": {
    module: "crypto",
    kind: "behaviour",
    status: "gated",
    v24: "DEP0198 is a PENDING deprecation: SHAKE128/256 without outputLength warns only with --pending-deprecation",
    node26: "DEP0198 is a real deprecation: same call warns once per process, no flag needed",
    tests: {
      v24: "test-crypto-default-shake-lengths.js, test-crypto-default-shake-lengths-oneshot.js, test-crypto-hash.js",
      node26: "test-crypto-default-shake-lengths.js, test-crypto-default-shake-lengths-oneshot.js, test-crypto-hash.js",
    },
    source: "set rows 9-11; gated in step 1 (PR #558)",
  },
  "crypto-encap-decap-message": {
    module: "crypto",
    kind: "behaviour",
    status: "gated",
    v24: "wrong-key decapsulate error matches /Failed to (initialize|perform) decapsulation/",
    node26: "same error matches /Decapsulation failed/, code ERR_CRYPTO_OPERATION_FAILED",
    tests: {
      v24: "test-crypto-encap-decap.js",
      node26: "test-crypto-encap-decap.js",
    },
    source: "set row 12; gated in step 1 (PR #558)",
  },
  "crypto-gcm-short-tag": {
    module: "crypto",
    kind: "behaviour",
    status: "pending",
    v24: "12-byte GCM auth tag accepted, emits DEP0182",
    node26: "any tag length 0-15 throws 'Invalid authentication tag length: N'",
    tests: {
      v24: "test-crypto-gcm-implicit-short-tag.js",
      node26: "test-crypto-gcm-implicit-short-tag.js",
    },
    source: "set row 13",
  },
  "crypto-kmac-zero-key": {
    module: "crypto",
    kind: "behaviour",
    status: "pending",
    v24: "0-length KMAC key accepted via toCryptoKey",
    node26: "0-length KMAC key -> NotSupportedError 'Invalid key length'; other 0-length keys -> DataError",
    tests: {
      v24: "test-crypto-key-objects-to-crypto-key.js",
      node26: "test-crypto-key-objects-to-crypto-key.js",
    },
    source: "set row 14",
  },
  "crypto-openssl-aead-error": {
    module: "crypto",
    kind: "behaviour",
    status: "expected-failure",
    v24: "AEAD tag-mismatch error matches /Unsupported state or unable to authenticate data/; no SM4-CCM / AES-SIV cases",
    node26: "OpenSSL 3 provider error ERR_OSSL_BAD_DECRYPT for tag mismatch; SM4-CCM and AES-SIV cases added",
    tests: {
      v24: "test-crypto-authenticated.js",
      node26: "test-crypto-authenticated.js",
    },
    source: "set row 15 (class c: host OpenSSL-owned, no shim flag can emit both)",
  },
  "crypto-openssl-fips-strings": {
    module: "crypto",
    kind: "behaviour",
    status: "expected-failure",
    v24: "FIPS enablement error string: 'OpenSSL error when trying to enable FIPS:'",
    node26: "'--enable-fips requires an active OpenSSL provider named 'fips'' (OpenSSL 3 branch)",
    tests: { v24: "test-crypto-fips.js", node26: "test-crypto-fips.js" },
    source: "set row 16 (class c)",
  },
  "crypto-openssl-cipher-inventory": {
    module: "crypto",
    kind: "behaviour",
    status: "expected-failure",
    v24: "cipher inventory as of 24.20.0's OpenSSL (28 nid-less ciphers present)",
    node26: "different inventory (cbc-hmac filtered to [] on OpenSSL 3; getCipherInfo on new entries)",
    tests: {
      v24: "test-crypto-getcipherinfo.js",
      node26: "test-crypto-getcipherinfo.js",
    },
    source: "set row 17 (class c)",
  },
  "crypto-openssl-pqc-ml-dsa": {
    module: "crypto",
    kind: "behaviour",
    status: "expected-failure",
    v24: "ML-DSA key re-export / serialisation form as of 24.20.0's OpenSSL",
    node26: "different key-object form (BoringSSL/FIPS-gated entries; isBoringSSL import added)",
    tests: {
      v24: "test-crypto-pqc-key-objects-ml-dsa.js",
      node26: "test-crypto-pqc-key-objects-ml-dsa.js",
    },
    source: "set row 18 (class c)",
  },
  "crypto-openssl-pqc-ml-kem": {
    module: "crypto",
    kind: "behaviour",
    status: "expected-failure",
    v24: "ML-KEM key re-export form as of 24.20.0's OpenSSL",
    node26: "different key-object form (incl. MLKEM768-P256 handling)",
    tests: {
      v24: "test-crypto-pqc-key-objects-ml-kem.js",
      node26: "test-crypto-pqc-key-objects-ml-kem.js",
    },
    source: "set row 19 (class c)",
  },
  "fs-rmdir-recursive": {
    module: "fs",
    kind: "behaviour",
    status: "gated",
    v24: "rmdir(path, {recursive:true}) works, emits DEP0147",
    node26: "recursive rmdir throws ERR_INVALID_ARG_VALUE (option removed)",
    tests: {
      v24: "test-fs-rmdir-recursive*.js (7 files)",
      node26: "test-fs-rmdir-recursive-error.js (replacement)",
    },
    source: "set rows 20-26; gated in step 3 (PR #TODO)",
  },
  "fs-filehandle-gc-close": {
    module: "fs",
    kind: "behaviour",
    status: "pending",
    v24: "unclosed FileHandle at GC -> DEP0137 deprecation warning",
    node26: "unclosed FileHandle at GC -> throw ERR_INVALID_STATE",
    tests: {
      v24: "test-fs-filehandle.js, test-fs-promises-file-handle-close.js",
      node26: "test-fs-filehandle.js",
    },
    source: "set rows 27-28",
  },
  "fs-filehandle-pull-lock": {
    module: "fs",
    kind: "behaviour",
    status: "pending",
    v24: "second fh.pull() while a pull exists throws ERR_INVALID_STATE immediately (lock at creation)",
    node26: "lock engages at consumption: second pull() succeeds; consuming it rejects ERR_INVALID_STATE",
    tests: {
      v24: "test-fs-promises-file-handle-pull.js",
      node26: "test-fs-promises-file-handle-pull.js",
    },
    source: "set row 29 (shim satisfies neither side today — lock semantics must be implemented first, then gated)",
  },
  "stream-classic-coalescing": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "howMuchToRead() coalesces buffered chunks up to n (old read-size behaviour)",
    node26: "one-buffer fast path: different read sizes / needReadable transitions",
    tests: {
      v24: "test-stream-compose.js, test-stream-push-strings.js, test-stream-readable-emittedReadable.js, test-stream-readable-infinite-read.js, test-stream2-transform.js",
      node26: "same 5 files",
    },
    source: "set rows 30-34",
  },
  "stream-iter-broadcast-backpressure": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "v24 iter broadcast backpressure timing/counts",
    node26: "Node 26 iter timing/counts",
    tests: {
      v24: "test-stream-iter-broadcast-backpressure.js",
      node26: "test-stream-iter-broadcast-backpressure.js",
    },
    source: "set row 35",
  },
  "stream-iter-broadcast-basic": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "v24 iter broadcast delivery (mustCall counts)",
    node26: "Node 26 iter delivery",
    tests: {
      v24: "test-stream-iter-broadcast-basic.js",
      node26: "test-stream-iter-broadcast-basic.js",
    },
    source: "set row 36",
  },
  "stream-iter-consumers-merge": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "v24 error shape on merge failure",
    node26: "Node 26 expects SuppressedError",
    tests: {
      v24: "test-stream-iter-consumers-merge.js",
      node26: "test-stream-iter-consumers-merge.js",
    },
    source: "set row 37",
  },
  "stream-iter-duplex": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "v24 iter duplex counts",
    node26: "Node 26 iter duplex counts",
    tests: {
      v24: "test-stream-iter-duplex.js",
      node26: "test-stream-iter-duplex.js",
    },
    source: "set row 38",
  },
  "stream-iter-pipeto": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "v24 pipeTo behaviour",
    node26: "Node 26 pipeTo behaviour",
    tests: {
      v24: "test-stream-iter-pipeto.js",
      node26: "test-stream-iter-pipeto.js",
    },
    source: "set row 39",
  },
  "stream-iter-share-from": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "v24 share/from behaviour",
    node26: "Node 26 share/from behaviour",
    tests: {
      v24: "test-stream-iter-share-from.js",
      node26: "test-stream-iter-share-from.js",
    },
    source: "set row 40",
  },
  "stream-iter-share-sync": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "v24 share sync behaviour",
    node26: "Node 26 share sync behaviour",
    tests: {
      v24: "test-stream-iter-share-sync.js",
      node26: "test-stream-iter-share-sync.js",
    },
    source: "set row 41",
  },
  "stream-iter-consumers-text": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "v24 text() limit/encoding errors (ERR_OUT_OF_RANGE, ERR_INVALID_ARG_TYPE via old call shape)",
    node26: "Node 26 text() error call shapes / codes",
    tests: {
      v24: "test-stream-iter-consumers-text.js",
      node26: "test-stream-iter-consumers-text.js",
    },
    source: "set row 42",
  },
  "stream-iter-pipeto-edge": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "pipeToSync endSync returning -1 or missing -> falls back to end(); endCalled === true",
    node26: "endSync() returning -1 -> throws ERR_INVALID_STATE; endCalled === false",
    tests: {
      v24: "test-stream-iter-pipeto-edge.js",
      node26: "test-stream-iter-pipeto-edge.js",
    },
    source: "set row 43",
  },
  "stream-iter-push-writer": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "v24 push-writer writeSync/canWrite/drain semantics",
    node26: "Node 26 writeSync/canWrite/drain semantics (new assertions on writer.canWrite, drained)",
    tests: {
      v24: "test-stream-iter-push-writer.js",
      node26: "test-stream-iter-push-writer.js",
    },
    source: "set row 44",
  },
  "stream-iter-share-coverage": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "non-Error thrown values -> ERR_OPERATION_FAILED wrap",
    node26: "non-Error values pass through unwrapped (error === reason identity checks)",
    tests: {
      v24: "test-stream-iter-share-coverage.js",
      node26: "test-stream-iter-share-coverage.js",
    },
    source: "set row 45",
  },
  "stream-iter-validation": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "push({budget:'bad'}) -> ERR_INVALID_ARG_TYPE; budget 1.5/16383/MAX_SAFE_INTEGER+1 -> ERR_OUT_OF_RANGE",
    node26: "budget:'bad' -> ERR_OUT_OF_RANGE; budget 0.5 -> ERR_OUT_OF_RANGE; 1.5/1/16383/MAX_SAFE_INTEGER accepted (canWrite === true)",
    tests: {
      v24: "test-stream-iter-validation.js",
      node26: "test-stream-iter-validation.js",
    },
    source: "set row 46",
  },
  "stream-iter-writable-from": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "v24 writable.from error/reject shapes",
    node26: "Node 26 shapes (ERR_FALSY_VALUE_REJECTION, ERR_OPERATION_FAILED, per-write error callbacks)",
    tests: {
      v24: "test-stream-iter-writable-from.js",
      node26: "test-stream-iter-writable-from.js",
    },
    source: "set row 47",
  },
  "stream-iter-writable-interop": {
    module: "stream",
    kind: "behaviour",
    status: "pending",
    v24: "v24 writable-interop reject/write-count behaviour",
    node26: "Node 26 reject/write-count behaviour (AbortError rejects, writes === 0 cases)",
    tests: {
      v24: "test-stream-iter-writable-interop.js",
      node26: "test-stream-iter-writable-interop.js",
    },
    source: "set row 48",
  },
  "net-autoselectfamily-default": {
    module: "net",
    kind: "behaviour",
    status: "gated",
    v24: "getDefaultAutoSelectFamilyAttemptTimeout() === 250 (v24 common scales x10 -> 2500 in the test)",
    node26: "getDefaultAutoSelectFamilyAttemptTimeout() === 500 (n26 common scales x5 -> 2500 in the test)",
    tests: {
      v24: "test-net-autoselectfamily-attempt-timeout-default-value.js",
      node26: "test-net-autoselectfamily-attempt-timeout-default-value.js",
    },
    source: "set row 49; gated in step 1 (PR #558)",
  },
  "perf-hooks-resourcetiming-attrs": {
    module: "perf_hooks",
    kind: "behaviour",
    status: "gated",
    v24: "PerformanceResourceTiming has no finalResponseHeadersStart, firstInterimResponseStart, renderBlockingStatus, contentType, contentEncoding (toJSON/inspect omit them)",
    node26: "all five attributes present (toJSON/inspect include them)",
    tests: {
      v24: "test-perf-hooks-resourcetiming.js",
      node26: "test-perf-hooks-resourcetiming.js",
    },
    source: "set row 50; gated in step 1 (PR #558)",
  },
  "https-getname-encoding": {
    module: "https",
    kind: "behaviour",
    status: "pending",
    v24: "agent.getName() -> plain String(value) join",
    node26: "length-prefixed encoding (getTlsOptionKey): per-option s2:/s4:/a3: length prefixes",
    tests: {
      v24: "test-https-agent-getname.js",
      node26: "test-https-agent-getname.js",
    },
    source: "set row 51",
  },
  "http-standalone-trailing-write": {
    module: "http",
    kind: "behaviour",
    status: "gated",
    v24: "standalone response: mustCall(write, 2); 2nd chunk length === 0 (trailing empty write)",
    node26: "mustCall(write, 1); single chunk ends 'hello world' (final chunk folded into ONE write)",
    tests: {
      v24: "test-http-server-response-standalone.js",
      node26: "test-http-server-response-standalone.js",
    },
    source: "set row 52; gated in step 1 (PR #558). PR #554 restored the write unconditionally and regressed node26; reverted by #555 — the gate is the fix, not a re-restore.",
  },
  "http-1-0-chunk-coalescing": {
    module: "http",
    kind: "behaviour",
    status: "pending",
    v24: "HTTP/1.1 half: _send('')-separated writes + sync end() -> two chunks '7\\r\\nHello, \\r\\n6\\r\\nworld!\\r\\n'",
    node26: "same writes with nextTick(() => res.end('X')) -> one coalesced chunk 'd\\r\\nHello, world!\\r\\n1\\r\\nX\\r\\n'",
    tests: { v24: "test-http-1.0.js", node26: "test-http-1.0.js" },
    source: "set row 53 (1.0 half identical in both trees; the 1.1 chunk-framing half disagrees)",
  },
  "repl-top-level-await-single-line": {
    module: "repl",
    kind: "behaviour",
    status: "pending",
    v24: "await Promise.resolve(123), Promise.resolve(456) -> multi-line 'Promise {'",
    node26: "same input -> single-line 'Promise { 456 }'",
    tests: {
      v24: "test-repl-top-level-await.js",
      node26: "test-repl-top-level-await.js",
    },
    source: "set row 54",
  },
  "repl-proxy-display": {
    module: "repl",
    kind: "behaviour",
    status: "pending",
    v24: "showProxy = false + new Proxy({x:42}, {}) -> '{ x: 42 }' (unwrapped)",
    node26: "same -> 'Proxy({ x: 42 })'",
    tests: { v24: "test-repl.js", node26: "test-repl.js" },
    source: "set row 55",
  },

  // ---- export-surface changes (46 entries, from parity/drift/node26-export-diff.md) ----
  "export-removed:assert.CallTracker": {
    module: "assert", kind: "export-removed", status: "pending",
    v24: "function:deprecated:0", node26: "absent", tests: null,
    source: "export diff (removed in 26.13.1; a transform cannot invent an implementation — restoring needs real code)",
  },
  "export-changed:assert.deepEqual": {
    module: "assert", kind: "export-changed", status: "pending",
    v24: "function:deepEqual:3", node26: "function:deepEqual:2", tests: null,
    source: "export diff (descriptor changed)",
  },
  "export-changed:assert.deepStrictEqual": {
    module: "assert", kind: "export-changed", status: "pending",
    v24: "function:deepStrictEqual:3", node26: "function:deepStrictEqual:2", tests: null,
    source: "export diff (descriptor changed)",
  },
  "export-changed:assert.doesNotMatch": {
    module: "assert", kind: "export-changed", status: "pending",
    v24: "function:doesNotMatch:3", node26: "function:doesNotMatch:2", tests: null,
    source: "export diff (descriptor changed)",
  },
  "export-changed:assert.equal": {
    module: "assert", kind: "export-changed", status: "pending",
    v24: "function:equal:3", node26: "function:equal:2", tests: null,
    source: "export diff (descriptor changed)",
  },
  "export-changed:assert.fail": {
    module: "assert", kind: "export-changed", status: "pending",
    v24: "function:fail:5", node26: "function:fail:1", tests: null,
    source: "export diff (descriptor changed)",
  },
  "export-changed:assert.match": {
    module: "assert", kind: "export-changed", status: "pending",
    v24: "function:match:3", node26: "function:match:2", tests: null,
    source: "export diff (descriptor changed)",
  },
  "export-changed:assert.notDeepEqual": {
    module: "assert", kind: "export-changed", status: "pending",
    v24: "function:notDeepEqual:3", node26: "function:notDeepEqual:2", tests: null,
    source: "export diff (descriptor changed)",
  },
  "export-changed:assert.notDeepStrictEqual": {
    module: "assert", kind: "export-changed", status: "pending",
    v24: "function:notDeepStrictEqual:3", node26: "function:notDeepStrictEqual:2", tests: null,
    source: "export diff (descriptor changed)",
  },
  "export-changed:assert.notEqual": {
    module: "assert", kind: "export-changed", status: "pending",
    v24: "function:notEqual:3", node26: "function:notEqual:2", tests: null,
    source: "export diff (descriptor changed)",
  },
  "export-changed:assert.notStrictEqual": {
    module: "assert", kind: "export-changed", status: "pending",
    v24: "function:notStrictEqual:3", node26: "function:notStrictEqual:2", tests: null,
    source: "export diff (descriptor changed)",
  },
  "export-changed:assert.partialDeepStrictEqual": {
    module: "assert", kind: "export-changed", status: "pending",
    v24: "function:partialDeepStrictEqual:3", node26: "function:partialDeepStrictEqual:2", tests: null,
    source: "export diff (descriptor changed)",
  },
  "export-changed:assert.strictEqual": {
    module: "assert", kind: "export-changed", status: "pending",
    v24: "function:strictEqual:3", node26: "function:strictEqual:2", tests: null,
    source: "export diff (descriptor changed)",
  },
  "export-added:buffer.isLatin1": {
    module: "buffer", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:isLatin1:1", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-removed:buffer.SlowBuffer": {
    module: "buffer", kind: "export-removed", status: "pending",
    v24: "function:deprecated:1", node26: "absent", tests: null,
    source: "export diff (removed in 26.13.1; a transform cannot invent an implementation — restoring needs real code)",
  },
  "export-added:crypto.createMac": {
    module: "crypto", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:createMac:3", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:crypto.getMacs": {
    module: "crypto", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:(anon):0", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:crypto.parsePKCS12": {
    module: "crypto", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:parsePKCS12:1", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-changed:crypto.getCipherInfo": {
    module: "crypto", kind: "export-changed", status: "pending",
    v24: "function:getCipherInfo:2", node26: "function:getCipherInfo:1", tests: null,
    source: "export diff (descriptor changed)",
  },
  "export-added:fs.openAsBlobSync": {
    module: "fs", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:openAsBlobSync:1", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-removed:fs.F_OK": {
    module: "fs", kind: "export-removed", status: "pending",
    v24: "number", node26: "absent", tests: null,
    source: "export diff (removed in 26.13.1; a transform cannot invent an implementation — restoring needs real code)",
  },
  "export-removed:fs.R_OK": {
    module: "fs", kind: "export-removed", status: "pending",
    v24: "number", node26: "absent", tests: null,
    source: "export diff (removed in 26.13.1; a transform cannot invent an implementation — restoring needs real code)",
  },
  "export-removed:fs.W_OK": {
    module: "fs", kind: "export-removed", status: "pending",
    v24: "number", node26: "absent", tests: null,
    source: "export diff (removed in 26.13.1; a transform cannot invent an implementation — restoring needs real code)",
  },
  "export-removed:fs.X_OK": {
    module: "fs", kind: "export-removed", status: "pending",
    v24: "number", node26: "absent", tests: null,
    source: "export diff (removed in 26.13.1; a transform cannot invent an implementation — restoring needs real code)",
  },
  "export-changed:fs.Stats": {
    module: "fs", kind: "export-changed", status: "pending",
    v24: "function:deprecated:14", node26: "function:deprecated:18", tests: null,
    source: "export diff (descriptor changed)",
  },
  "export-added:http.isValidHeaderName": {
    module: "http", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:isValidHeaderName:1", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:http.isValidHeaderValue": {
    module: "http", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:isValidHeaderValue:2", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:http.websocketMask": {
    module: "http", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:websocketMask:5", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:http.websocketUnmask": {
    module: "http", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:websocketUnmask:2", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-removed:module._debug": {
    module: "module", kind: "export-removed", status: "pending",
    v24: "function:deprecated:0", node26: "absent", tests: null,
    source: "export diff (removed in 26.13.1; a transform cannot invent an implementation — restoring needs real code)",
  },
  "export-added:net._TransferredBoundSocket": {
    module: "net", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:_TransferredBoundSocket:0", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:perf_hooks.createSlidingWindowHistogram": {
    module: "perf_hooks", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:createSlidingWindowHistogram:1", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:perf_hooks.importHistogram": {
    module: "perf_hooks", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:importHistogram:1", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:process.addUncaughtExceptionCaptureCallback": {
    module: "process", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:addUncaughtExceptionCaptureCallback:1", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:util.debounce": {
    module: "util", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:debounce:2", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:util.isPartialDeepStrictEqual": {
    module: "util", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:isPartialDeepStrictEqual:2", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:util.markPromiseAsHandled": {
    module: "util", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:markPromiseAsHandled:1", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:util.throttle": {
    module: "util", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:throttle:3", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:zlib.ZipBuffer": {
    module: "zlib", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:ZipBuffer:1", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:zlib.ZipEntry": {
    module: "zlib", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:ZipEntry:0", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:zlib.ZipFile": {
    module: "zlib", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:ZipFile:0", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:zlib.createZipArchive": {
    module: "zlib", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:(anon):0", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:zlib.createZipArchiveSync": {
    module: "zlib", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:(anon):0", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:zlib.getMaxZipContentSize": {
    module: "zlib", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:(anon):0", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:zlib.setMaxZipContentSize": {
    module: "zlib", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:(anon):0", tests: null,
    source: "export diff (added in 26.13.1)",
  },
  "export-added:zlib.zipFiles": {
    module: "zlib", kind: "export-added", status: "pending",
    v24: "absent", node26: "function:(anon):0", tests: null,
    source: "export diff (added in 26.13.1)",
  },
};
