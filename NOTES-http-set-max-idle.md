# NOTES — http setMaxIdleHTTPParsers (`parsers.max` cell)

## The failing test

`test-http-set-max-idle-http-parser` failed with `1000 !== 1` (line 24):
after `http.setMaxIdleHTTPParsers(1)`, `httpCommon.parsers.max` still read
1000. The validation half of the test already passed (invalid types throw
`ERR_INVALID_ARG_TYPE`, out-of-range values throw `ERR_OUT_OF_RANGE`) —
only the observable write was missing.

## Diagnosis: two copies of `_http_common`

- The test's `http` is the shim (`src/http.js`, via the preload redirect),
  whose setter stored the cap in a shim-local variable
  (`maxIdleHTTPParsers`, written nowhere else and read nowhere else).
- The test's `_http_common` is **real Node's internal module**: the preload
  only redirects the `PARITY_TARGET` module plus the `net`/`_http_outgoing`
  extras, so `require('_http_common')` fell through to real Node, whose
  `parsers` is a real FreeList pool with `max: 1000`.
- The setter and the observation therefore touched different objects. The
  shim's own `src/_http_common.js` even exported `parsers = null`, so
  there was no shared cell at all.

Probed on plain Node (no preload): `require('_http_common')` loads real
Node's internal module, `parsers` is `{ name, ctor, max, list }` with
`max: 1000`. Real Node's `http.setMaxIdleHTTPParsers` is just
`parsers.max = max` on that shared object.

## Why not the obvious fixes

- **Wholesale redirect of `_http_common` to the shim** (the `_http_outgoing`
  precedent, PR #232/#268) regresses two passing tests:
  `test-http-parser` and `test-http-parser-bad-ref` both use the real
  `HTTPParser` binding (constructor, `REQUEST`/`RESPONSE`, `kOn*`
  constants, `initialize`), which the shim honestly stubs as `undefined`
  (no llhttp in a browser). Net score would be −1, not +1.
- **Setter delegation to real Node's pool from the shim** would be
  native-Node delegation inside shipped code — forbidden by the repo's
  browser-first rule (AGENTS.md rule 1). The bridge belongs in the parity
  harness, not in `src/`.

## The fix (3 shipped/harness files)

1. **`src/_http_common.js`** — `parsers` is now a cap cell,
   `{ max: 1000 }`, instead of `null`. There is still no pool in the
   browser and no parser is ever pooled; only the `max` contract is
   observable, and this object is what the setter writes.
2. **`src/http.js`** — `setMaxIdleHTTPParsers` now writes `parsers.max`
   (imported from `./_http_common.js`) instead of the dead local variable.
   Validation is byte-identical.
3. **`parity/http-common-adapter.mjs` (new) + one special case in
   `parity/preload.mjs`** — mirroring the `internal/event_target` adapter
   precedent: when `PARITY_TARGET=http`, test files under
   `parity/node-test/parallel/` that require `_http_common` get the
   adapter, which re-exports real Node's module for everything **except**
   `parsers` (the shim's shared cell). So `test-http-parser` /
   `test-http-parser-bad-ref` keep the real `HTTPParser` and still pass,
   while `setMaxIdleHTTPParsers` mutates the cell the set-max-idle test
   reads. The adapter's own `require('_http_common')` reaches real Node
   because the adapter lives under `parity/`, not under the testsDir the
   redirect guards on — no carve-out needed.
   - `alloc`/`free` are delegated to the real pool on the shared cell:
     the only test calling `parsers.alloc()` (`test-http-parser-lazy-loaded`)
     fails on base with a native abort (its DummyParser symbol reaches
     the real parser's `Initialize`, `args[0]->IsInt32()`); delegation
     keeps that failure mode byte-identical (134) instead of turning it
     into a TypeError. Nothing in the shim reads `alloc`/`free`.

## Results

- Target: `test-http-set-max-idle-http-parser` 1 → 0.
- All other `_http_common` consumers unchanged vs the #287 base sweep:
  `test-http-parser` 0, `test-http-parser-bad-ref` 0,
  `test-http-parser-memory-retention` 124, `test-http-header-value-relaxed`
  1, `test-http-parser-lazy-loaded` 134, `test-http-common` 0,
  `test-http-invalidheaderfield2` 0,
  `test-http-server-connection-list-when-close` 0.
- Full 397-test differential (branch vs pristine base `9476d7fe`):
  exactly one line differs, toward pass; zero regressions; crash codes
  identical. CSVs: `http-sweep-setmaxidle-branch.csv` /
  `http-sweep-setmaxidle-base.csv` in the parity-sweep goal hidden_files.

## Deliberately left alone

- The `HPE_INVALID_CONTENT_LENGTH` vs `HPE_UNEXPECTED_CONTENT_LENGTH`
  code-name gap (left open by the #287 lane): unrelated to this test,
  still open.
- Fresh zero-byte connections still destroyed by `close()` (#287 note):
  pre-existing, untested divergence, untouched.
- No real parser pool in the browser: `parsers` has no `list`/`name`/
  `ctor`, and `freeParser` remains a no-op. No test reads them.
