# NOTES-26-triage-assert.md

Node 26.13.1 re-target triage — `assert`. DOCS ONLY, no `src/` change.
Worktree: `~/workspace/worktrees/node26-triage-misc-small`, base `3c091022`.
Node 26 binary verified before probing: `~/workspace/local/node-26/bin/node --version` = `v26.13.1`.
Host Node (harness runtime): `v24.22.1`. Node 26 source: `~/workspace/local/node-26-src/`.

## Counts

- Baseline (28-module): assert 14 total, 12 pass, 2 fail, 0 timeout.
- Oracle: 2 shim-gap, 0 fails-natively, 0 native-timeout.
- **Gap stays 2 files** (10 failing sub-tests inside them — see below).
- v24 ceiling: 18/18 (100%). Both failing files are vendored v24 files
  whose Node 26 versions carry new/changed expectations.
- Export diff: assert REMOVED `CallTracker` and CHANGED 12 exports —
  arity 3 → 2 on `deepEqual`/`deepStrictEqual`/`doesNotMatch`/`equal`/
  `match`/`notDeepEqual`/`notDeepStrictEqual`/`notEqual`/`notStrictEqual`/
  `partialDeepStrictEqual`/`strictEqual`, `fail` 5 → 1. Changelog:
  25.0.0 `fail()` multi-arg removed, `CallTracker` removed, deep-equal
  now FAILS promise comparisons and treats invalid Dates as equal;
  26.0.0 printf-style messages allowed.

## Gap list (both files, harnessExit / nativeExit from gaps-assert.json)

| test | harness | native | vendored in v24? |
| --- | --- | --- | --- |
| test-assert-deep.js | 1 | 0 | yes |
| test-assert.js | 1 | 0 | yes |

Isolated re-runs (staged Node 26 `test/parallel + common + fixtures`,
`timeout 30 node --import <abs preload> parity/node-test/parallel/<test>`,
`PARITY_TARGET=assert`, per `parity/drift/run-baseline.mjs`): both exits
reproduced exactly (1, 1). Failures print to stdout (`node:test` runner
output), stderr empty. Probe logs: `~/workspace/node26-misc-probes/`.

## New-in-26 vs pre-existing

- **NEW in 26:** all of `test-assert.js`'s failures are new 26
  message-argument semantics (6 sub-tests, none in the v24 file):
  printf-style messages, function messages, ambiguous-argument errors,
  faulty message functions, Symbol-message `TypeError`.
- `test-assert-deep.js`: 2 NEW sub-tests (null/undefined Set-member
  cases at `:283-284`, `Promises should fail deepEqual` at `:1738`) and
  2 CHANGED expectations on pre-existing cases (Proxy diff rendering
  with `showProxy: true` at `:1169`, KeyObject tag in the Crypto
  diff at `:1438`). The invalid-Dates change from the changelog is
  **not** a gap — the `date` sub-test passes (invalid Dates already
  compare equal in the shim).

## Families

### F1 — Message-argument semantics, Node 26 (test-assert.js, 6 sub-tests) — LANE, flip 1

All six failing sub-tests are one family: how the 3rd+ argument
(`message`) is resolved. Node 26 signatures are rest-args
(`lib/assert.js:207` `equal(actual, expected, ...message)`,
`fail(message)` at `:150`); the shim still takes a single `message`
(`src/assert.js:7082` `equal(actual, expected, message)`) and passes it
straight through — the ctor does `super(String(message))`
(`src/assert.js:5123-5127`), which stringifies functions.

| sub-test (test-assert.js) | shim behaviour (harness) | Node 26 behaviour (probe) |
| --- | --- | --- |
| Additional asserts (`:905`) | Symbol message → `AssertionError`, message `'Symbol(foo)'` | `TypeError`, `ERR_INVALID_ARG_TYPE`: `"message" argument must be one of type string or function` |
| Printf-like format strings (`:1600`) | message left as `'... %i'` | formatted: `'The answer to all questions is 42'` |
| Functions as error message (`:1660`, + 2nd at `~:1800`) | message = function source text | function CALLED with `(actual, expected)`: `'Nice message including 1 and 2'` |
| Ambiguous error messages fail (`:1725`) | plain `AssertionError` | `ERR_AMBIGUOUS_ARGUMENT` — function/Error message PLUS an extra arg (`errorMessage, 'foobar'`; `new Error('baz'), 'foobar'`); `lib/assert.js:631,637` |
| Faulty message functions (`:1743`) | message = `'(a, b) => 123'` | falls back to default message: `"'foo' doesNotMatch /foo/"` (function returned non-string `123`) |

- **Lane A-26-1 — assert message semantics (26). Estimated flip: 1**
  (test-assert.js). Work: implement Node 26's message resolution in
  `src/assert.js` — rest-args `...message` on the 12 arity-changed
  functions (arity 3 → 2, matching the export diff), resolved centrally
  (AssertionError ctor / `innerFail` path): function → call with
  `(actual, expected)`; string + extra args → printf-format
  (`util.format` semantics); function/Error + extra args → throw
  `ERR_AMBIGUOUS_ARGUMENT` (error class already exists,
  `src/assert.js:379`); non-string function result → default message;
  non-string/non-function/non-Error message → `ERR_INVALID_ARG_TYPE`.
  Also collapse `fail()` to the single-message form (multi-arg removed
  in 25.0.0; shim still warns DEP0094 at `:7001-7035`). All six
  sub-tests are in this one mechanism, so the whole file flips together.

### F2 — deepEqual / inspect rendering (test-assert-deep.js, 4 sub-tests) — MIXED

Two sub-tests are fixable in pure JS, two are provably impossible in
pure JS. The file flips only if all four flip — so the lane below
fixes 2/4 sub-tests and the **file stays red (flip 0)**.

#### F2a — Fixable (2 sub-tests)

- **es6 Maps and Sets (`:283-284`): NEW 26 cases.** "A null/primitive
  member lined up against object-only members in the other set must
  report inequality, not throw on `member.constructor`":
  `assertNotDeepOrStrict(new Set([null, {}, {}]), new Set([{}, {}, {}]))`
  (and `undefined`). The shim throws `TypeError: Cannot read properties
  of null (reading 'constructor')` at `src/assert.js:5906`
  (`wellKnownConstructors.has(val1.constructor)` in
  `objectComparisonStart`, reached via `setEquiv`/`setObjectEquiv`).
  Fixable: null-guard the constructor comparison. Real shim bug, pure JS.
- **Crypto (`:1438`): KeyObject tag.** Expected diff message (built by
  the test helper from native `util.inspect`) is
  `'SecretKeyObject [KeyObject] {}'`; the shim's inspect prints
  `'SecretKeyObject {}'`. Probe: BOTH real Nodes (26.13.1 and host
  24.22.1) print the `[KeyObject]` tag — the shim's inspect is behind
  both. Fixable: tag `KeyObject` instances in the shim's inspect
  (detectable via `util.types.isKeyObject`-style check; the shim
  already carries a types table). Caveat: the v24 pass is consistent
  with the tag postdating the v24 sweep host (host is v24.22.1 vs the
  pinned v24.20.0) — the mechanism (shim lacks the tag) is what matters.

#### F2b — NO-FIX (2 sub-tests)

- **Check proxies (`:1169`): showProxy rendering.** Node 26 expects
  the diff to render `'+ Proxy([\n- [\n    1,\n    2,\n+ ])\n-   3\n- ]\n'`
  when `util.inspect.defaultOptions = { showProxy: true }`; the shim
  renders the plain array. The shim cannot know a value IS a Proxy:
  Proxy identity/target is unobservable from pure JS — Node uses the
  C++ `getProxyDetails` internal, and the shim's stub returns
  `undefined` (`src/assert.js:~245`, "Without internals, proxies are
  traversed as ordinary objects"). NO-FIX.
- **Promises should fail deepEqual (`:1738`, NEW 26): message only.**
  The BEHAVIOUR already matches — the shim's deepEqual fails promise
  comparisons (returns `false` for `isPromise`, `src/assert.js:6125`).
  Only the thrown MESSAGE differs: expected shows the resolved value
  (`Promise {\n  1,\n…`), the shim shows `'<pending>'`, because the
  shim's `getPromiseDetails()` always returns pending
  (`src/assert.js:~241`, "No synchronous cross-realm promise
  introspection API exists; report pending"). Synchronous promise
  settlement is unobservable in pure JS (Node reads it via V8
  internals). NO-FIX for the message; no behaviour gap.

- **Lane A-26-2 — assert-deep null-guard + KeyObject tag. Estimated
  flip: 0 files.** Fixes F2a's 2 sub-tests; the file still fails on
  F2b (proxies + promises). Worth doing only as part of a wider
  assert-deep pass, not as a standalone flip lane — report the
  sub-test progress, not a file flip.

## Lane candidates (conservative)

| lane | tests flipped | estimate |
| --- | --- | --- |
| A-26-1 assert message semantics (26) | test-assert.js | **1** |
| A-26-2 assert-deep null-guard + KeyObject tag | (2/4 sub-tests of test-assert-deep.js) | **0 files** (file stays red on F2b) |

## NO-FIX list

At file level, only test-assert-deep.js is NO-FIX — and only because
of its two F2b sub-tests (proxies: Proxy target unobservable in pure
JS; promises: sync settlement unobservable in pure JS). Its F2a
sub-tests are fixable (see A-26-2). No assert gap is NO-FIX for lack
of a browser mechanism beyond those two message renderings.

Notes (no lane — no gap test covers them): `CallTracker` is still
exported by the shim (`src/assert.js:5284-5430`, `:6903`) but was
REMOVED in Node 26; `fail()` multi-arg still works with a DEP0094
warning but was removed in 25.0.0. Both are removal candidates for a
cleanup pass, not flips.

## Baseline corrections

- None for assert: both isolated re-runs reproduce the baseline exits
  exactly (1, 1).
- Measurement note: the `node:test` failures print to STDOUT (stderr
  empty) — a future re-run that only captures stderr will see nothing.
- Sub-test accounting: test-assert.js has 6 failing sub-tests (not 1
  undifferentiated failure) and test-assert-deep.js has 4 — all in the
  two files' `node:test` output, listed in F1/F2 above.
