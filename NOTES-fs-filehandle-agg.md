# NOTES-fs-filehandle-agg — triage lane L1 (wave F1)

Targets (all exit 1 → 0, isolated 2× on branch):
- test-fs-promises-file-handle-aggregate-errors
- test-fs-promises-file-handle-close-errors
- test-fs-promises-file-handle-op-errors

## Mechanism (three stacked gaps, all in the path-based promises ops)

All three tests `require("internal/fs/promises")` and patch
`FileHandle.prototype.fd` with a throwing getter (installing a wrapped
instance `close` on first access), then call path-based
`truncate`/`readFile`/`writeFile` and expect Node's close semantics:
op error only (op-errors), close error only (close-errors), or an
AggregateError `[op, close]` with `code` = op code (aggregate-errors).

1. No `internal/fs/promises` redirect — the tests patched the NATIVE
   FileHandle; the shim never saw it.
2. Shim `FileHandle` set `this.fd = fd` as an OWN data property
   (src/fs.js:7783), shadowing any prototype `fd` accessor. Node's is a
   prototype getter over `this[kFd]` (lib/internal/fs/promises.js:208).
3. Shim path-based promises `readFile`/`writeFile`/`truncate` called
   callback `fs.*` directly, never opening a FileHandle — no close step,
   no aggregation.

## Fix (src/fs.js only + parity adapter + one preload redirect)

- `fd` is now a prototype getter/setter over a module-scope slot symbol
  `kFd` (src/fs.js, next to the FileHandle class). The setter exists only
  because memfs's constructor and our `_closeSync` assign `this.fd` —
  Node's fd is getter-only, and no passing test assigns it (verified by
  grep over the fs tests). `ponytail:` comment on the class names the
  ceiling (dropping the setter needs memfs's constructor to stop
  assigning `this.fd` — an upstream change).
- `handleFdClose` + `aggregateTwoErrors` ported verbatim from
  lib/internal/fs/promises.js:1079-1091 and lib/internal/errors.js:168-194
  (minus Node's stackTraceLimit dance, cosmetic). `handleFdSync` ported
  from lib/internal/fs/promises.js:1093-1104 for writeFile `flush`.
  Call sites pass `() => handle.close()`: Node passes `fd.close` unbound
  because its close is an own arrow property; the shim's close is a
  prototype method, so a closure is required — and it is read at
  invocation time, so a test-installed instance close is picked up.
- Path-based `readFile`/`writeFile`/`truncate` now open a handle and
  route through it (`openHandle` helper, factored out of
  definePromise("open")): readFile opens with `options.flag || 'r'`,
  writeFile with `options.flag || 'w'` + `options.mode ?? 0o666` +
  `options.flush` validated via validateBoolean (test-fs-write-file-flush
  asserts the ERR_INVALID_ARG_TYPE rejection), truncate opens `'r+'`.
  Abort-signal pre-checks preserved (writeFile already had them; readFile
  gains the same pre-open check Node does). `appendFile` untouched — not
  asserted by these tests, Node delegates it to writeFile with flag 'a'
  and the shim's callback path already works.
- `_closeSync` and `_checkIterUsable` read the fd from the internal slot
  (`this[kFd]`), NOT the accessor: Node's close reads `this[kFd]`
  directly, so a patched prototype getter must not re-fire during close.
  This was the second bug found during the differential (first run:
  close-errors flipped, aggregate/op-errors failed with the op error
  thrown AGAIN from inside close, producing a spurious AggregateError of
  [op, op]). Op methods (read/write/stat/truncate/...) still read
  `this.fd` via the accessor, exactly like Node's binding calls do.
- `_FileHandle`: non-enumerable data property on the fs singleton
  (src/fs.js, next to `fs.promises = promises`), so the adapter can
  export the class identity. Invisible to `Object.keys` and to the oracle
  export-surface test (which collects enumerable keys + getters/setters
  only); underscore-prefixed like `fs._vol`.
- `parity/internal-fs-promises-adapter.mjs` (new): exports the shim's
  FileHandle (named + default). Preload redirects
  `require("internal/fs/promises")` to it under `PARITY_TARGET=fs`
  (#232 shape, stated in the PR body). Only these three tests require it.

## Differential

- Flips (isolated 2× each on branch, 2× on live main at ship time):
  aggregate-errors [0,0], close-errors [0,0], op-errors [0,0].
  Base (5d6b0f71): all three exit 1 ("Missing expected rejection").
- Guards (all exit 0 on branch; see results file): all 16 other passing
  test-fs-promises-file-handle-*.js tests, test-fs-promises-file-handle-
  read-worker (NO-FIX, still 1 — untouched), test-fs-write-file-flush,
  test-fs-promises, test-fs-readfile, test-fs-truncate,
  test-fs-read-file-sync, test-fs-write-file.
- Repo suites: tests/fs.test.js, tests/oracle-export-surface.test.js,
  tests/ondemand-require.test.js (29/29) — run before push.

## Ship

- PR #___ / Merge SHA: ___ (filled at ship time)
- Branch: fix/fs-filehandle-agg
- Differential results: `~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/fs-f1-filehandle-agg-results.txt`
