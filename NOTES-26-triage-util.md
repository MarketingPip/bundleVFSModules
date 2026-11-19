# NOTES-26-triage-util — Node 26.13.1 drift triage (util)

- Base: `3c091022` (worktree `~/workspace/worktrees/node26-triage-core-small`).
- Scope: 10 gap tests, all class `shim-gap` in
  `hidden_files/node26-triage/gaps-util.json`, nativeExit 0 for all 10.
- Node 26 binary verified: `~/workspace/local/node-26/bin/node --version` → `v26.13.1`.
- Method: same as NOTES-26-triage-buffer.md — staged the Node 26 test tree
  over `parity/node-test/`, re-ran each gap with the exact
  `parity/drift/run-baseline.mjs` invocation (`PARITY_TARGET=util`, timeout
  10 s, 30 s for the 124 case). All 10 reproduced. Tree restored after;
  `git status -- parity/node-test` clean.
- Export diff (`parity/drift/node26-export-diff.md`): util ADDED `debounce`,
  `isPartialDeepStrictEqual`, `markPromiseAsHandled`, `throttle`.
- Changelog cross-check: 25.0.0 inspect/console colorize regexp groups;
  24.22.0 `util.throttle()` / `util.debounce()` added natively (after the
  pinned 24.20.0). Both confirmed present in Node 26 `lib/util.js`
  (lazy getters at :679-689 to `internal/util/debounce` /
  `internal/util/throttle`).

## Families

### U1 — debounce / throttle missing (3, real shim work, medium)
- Tests: `test-util-debounce.js` (exit 1), `test-util-throttle.js`
  (exit 1), `test-util-throttle-timing.js` (exit 1).
- All three are NEW test files in 26 (not vendored). The shim has no
  `debounce` / `throttle` anywhere in `src/util.js` (grep: no hits).
- Failure shape: `debounce(value, 1)` should throw `ERR_INVALID_ARG_TYPE`
  / `ERR_OUT_OF_RANGE` for bad args (test-util-debounce.js:12); the shim
  throws a bare `TypeError` (calling `undefined`). Same for throttle
  (:14). throttle-timing fails at first use: `TypeError: throttle is not
  a function` (line 23).
- Surface the lane must reproduce (read from the tests, not guessed):
  `debounce(fn, wait, options?)` and `throttle(fn, delay, capacity?)`
  with `.pending`, `.pendingCount`, `.cancel`, `.flush` (debounce),
  `.activeCount`, `.hasImmediateCapacity` (throttle), `.ref`, `.unref`
  (returning the function itself); validation errors above; and
  async-hooks-visible activity — both tests import `createHook` from
  `node:async_hooks` and assert hook init/before/after counts
  (throttle.js:107,179,303,324).
- throttle-timing caveat: the test mocks the libuv clock
  (`mock.method(internalBinding('timers'), 'getLibuvNow', ...)` after
  `mock.timers.enable({ apis: ['Date', 'setTimeout'] })`) and asserts
  timing values from `Date.now()`. A browser port cannot read
  `internalBinding('timers')`; but it CAN run on the mocked `Date` +
  `setTimeout` globals. Whether the timing assertions then match is
  unproven until the port exists — hence the 0–1 estimate for this file.
- Lanes: **util-debounce — flip 1**; **util-throttle — flip 1**;
  **util-throttle-timing — flip 0–1 (uncertain)**.

### U2 — isPartialDeepStrictEqual missing (1, real shim work)
- Test: `test-util-isPartialDeepStrictEqual.js` (exit 1; node:test runner
  output, both subtests fail with
  `TypeError: util.isPartialDeepStrictEqual is not a function`).
- NEW test file in 26. Node 26 `lib/util.js:629-634` delegates to
  `internal/util/comparisons`.isPartialStrictEqual. The shim already has
  a full `isDeepStrictEqual` port (`src/util.js:5236`, `isDeepStrictEqual`
  at :5048) — the lane extends that comparisons engine with the partial
  (subset) variant.
- Lane: **util-isPartialDeepStrictEqual — flip 1**.

### U3 — inspect colorizes regexp groups (1, real shim work, medium)
- Test: `test-util-inspect-regexp.js` (exit 1). NEW test file in 26;
  the 25.0.0 changelog entry ("inspect/console now colorize regexp
  groups and character classes").
- First failure at line 112 (`expectColored`, test line 18): for `/a/`
  the shim produces `'\x1B[31m/a/\x1B[39m'` (whole regexp red) while
  Node 26 produces
  `'\x1B[32m/\x1B[39m\x1B[33ma\x1B[39m\x1B[32m/\x1B[39m'`
  (delimiters green, pattern yellow).
- Node 26 implements this with `highlightRegExp` in
  `lib/internal/util/inspect.js:533` — a tolerant single-pass highlighter
  (groups named/unnamed/lookaround, assertions, alternation, quantifiers,
  escapes incl. Unicode properties, character classes, backreferences)
  driven by a color palette. The shim's inspect stylizes the whole
  regexp with one style (`regexp: "red"`, `src/util.js:826`;
  `ctx.stylize(base, 'regexp')` at the RegExp branch).
- Lane: **util-inspect-regexp-highlight (port highlightRegExp) — flip 1**
  (first-failure estimate; the file's later cases exercise the same
  mechanism, so one port should cover them).

### U4 — inspect: detached DataView format changed in 26 (1, real shim work, small)
- Test: `test-util-inspect.js` (exit 1), first failure at line 217.
- The test file changed heavily in 26 (4464 → 4109 lines). The failing
  assertion: `util.inspect(dv)` for a detached DataView. The shim
  produces the V24 shape:
  `'DataView {\n      [byteLength]: 0,\n      [byteOffset]: undefined,\n      [buffer]: ArrayBuffer { (detached), [byteLength]: 0 }\n    }'`
  (6-space indent, closing `    }`). Node 26 expects:
  `'DataView {\n  [byteLength]: 0,\n  [byteOffset]: undefined,\n  [buffer]: ArrayBuffer { (detached), [byteLength]: 0 }\n}'`
  (2-space indent, closing `}` at column 0).
- Mechanism: the shim deliberately replicates a Node indent leak
  (`src/util.js:3210-3240` comment: "Node also leaks +2 indentationLvl
  per thrown getter ... we replicate the leaked indent for parity",
  `levelBoost`). Node 26 removed the leak for detached DataViews — the
  getters no longer inflate the indent.
- Fix: match the 26 shape for detached DataViews (drop the level boost
  where 26 dropped it). Small, but this is a FIRST-FAILURE estimate:
  the file has many more 26 changes past line 217, so further failures
  may surface once this one is fixed.
- Lane: **util-inspect-detached-dataview — flip 0–1 (conservative 1 for
  the first failure; residual risk past line 217)**.

### U5 — inspect: bare proxies now print as `Proxy(...)` (1, real shim work)
- Test: `test-util-inspect-proxy.js` (exit 1), first failure at line 154:
  `util.inspect(proxy1)` — actual `'{}'`, expected `'Proxy({})'`
  (and nested `Proxy(Proxy(...))` forms later in the file).
- This is a Node 24 → 26 BEHAVIOR CHANGE in the default rendering,
  probe-verified on both binaries:
  - Host Node v24.22.1: `util.inspect(new Proxy({}, {}))` → `'{}'`;
    with `{ showProxy: true, depth: null }` → `'Proxy [ {}, {} ]'`.
  - Node 26.13.1: default → `'Proxy({})'`; showProxy unchanged
    (`'Proxy [ {}, {} ]'`).
  The shim was ported from Node v24.20.0 and reproduces the v24 default.
- The shim's Proxy branch (`src/util.js:2711-2745`) DOES fire, and the
  native bridge it delegates to IS live under the harness
  (`util.types === process.getBuiltinModule('util').types` → true,
  `types.isProxy(proxy)` → true; revoked proxies already render
  `'<Revoked Proxy>'`). But the bridge is the HOST's v24.22.1 builtin,
  whose default rendering is also `'{}'` — delegating cannot supply
  the 26 output. (An earlier hypothesis that the bridge was dead was
  checked and refuted by these probes.)
- Fix: render the 26 default `Proxy(<target>)` wrapping in the shim's
  own formatter (the bridge can still supply the showProxy rendering,
  which is unchanged). Small-to-medium.
- Lane: **util-inspect-proxy-26-wrap — flip 1**. Browser ceiling:
  pure-JS Proxy detection stays impossible (the branch relies on
  `nativeTypesBridge.isProxy`); under Node the detection works.
- Residual risk: first-failure estimate, as with U4.

### U6 — inspect: no output budget, huge objects never finish (1, real shim work)
- Test: `test-util-inspect-long-running.js` (exit 124 at 10 s AND at
  30 s; re-probed at 60 s → 124, at 120 s → 124). PRE-EXISTING file
  (only quote changes in the diff) — and flaky in the v24 sweeps:
  `hidden_files/fast-sweep/*.csv` shows exits `0, 124, 0, 0, 0` for
  this file. The v24 31/31 was a lucky run, not a 26 regression.
- The test builds a 1000-deep circular structure and calls
  `util.inspect(obj, { depth: Infinity })`. Scaling probe against the
  shim (direct import, no preload): n=1 → 7 ms, n=10 → 71 ms / 20 KB,
  n=20 → 39 ms / 104 KB, n=50 → 262 ms / 1.1 MB. Output grows ~O(n²)
  (each `obj[i]` re-renders its ancestor chain — path-based circular
  detection, not global-visited) → n=1000 implies ~440 MB of output.
  Direct probe: `util.inspect` on the n=1000 structure does not return
  within 20 s.
- Mechanism (Node 26 `lib/internal/util/inspect.js:1479-1490`): Node
  tracks `ctx.budget[indentationLvl]` and when cumulative output at any
  level exceeds `2 ** 27`, sets `ctx.depth = -1`, collapsing all
  further inspection — "This limit also makes sure that huge objects
  don't block the event loop significantly." That is the "artificial
  limitation" the test comment refers to. The shim has NO budget
  (`grep budget src/util.js` → no hits).
- Lane: **util-inspect-budget (port the 2^27 budget trip) — flip 1**.

### U7 — parseEnv: wrong prototype + missing multiline/expansion (1, real shim work, medium)
- Test: `test-util-parse-env.js` (exit 1), failing at line 62
  (`assert.deepStrictEqual(util.parseEnv(validContent), checkObj)`).
- First visible diff: actual is a plain `{}` object, expected is
  `[Object: null prototype]`. Node 26 `lib/util.js:491` delegates to the
  C++ binding, which returns a null-prototype object.
- That is NOT the whole lane: the fixture (`test/fixtures/dotenv/valid.env`,
  resolved via the staged node26 fixtures) requires multiline quoted
  values (`MULTI_DOUBLE_QUOTED: 'THIS\nIS\nA\nMULTILINE\nSTRING'`,
  `MULTI_SINGLE_QUOTED`, `MULTI_BACKTICKED`), `\n` expansion inside
  double quotes (`EXPAND_NEWLINES: 'expand\nnew\nlines'`) but NOT inside
  single quotes/backticks/unquoted (`DONT_EXPAND_*`), inline comments,
  `export ` prefix handling, and last-wins duplicates
  (`FOO=bar` then `FOO=baz` → `'baz'`). The shim's own header
  (`src/util.js:15`) admits "parseEnv does not perform variable
  expansion or multiline values". After a prototype-only fix, the
  value-level diffs would surface.
- Lane: **util-parseEnv (null prototype + multiline + double-quoted
  \n expansion) — flip 1**.

### U8 — stripVTControlCharacters: missing OSC alternative (1, real shim work, small)
- Test: `test-util-stripvtcontrolcharacters.js` (exit 1; node:test
  runner output). First failure at line 48: input
  `'\u001B]8;;https://example.com/(foo\u0007label\u001B]8;;\u0007'`
  (OSC 8 hyperlink) — actual `'ttps://example.com/(foo\x07label'`,
  expected `'label'`.
- The failing cases are NEW in 26 (only on the `>` side of the diff):
  OSC 8 URLs containing `(`, `)`, `!`, `+`, `[`, `]`, `$`, `'`, `*`
  (and the unterminated-OSC case, whose expected output is the
  CSI-fallback remainder `ttps://...`).
- Mechanism: Node 26's regex (`lib/internal/util/inspect.js:288-295`)
  has an OSC alternative FIRST:
  `(?:\u001B\][\s\S]*?(?:\u0007|\u001B\u005C|\u009C))`.
  The shim's `vtRegex` (`src/util.js:643-655`) has NO OSC alternative —
  only CSI-ish branches whose parameter character class excludes those
  URL characters — so the CSI branch consumes just the short prefix
  (`ESC ] 8 ;; h`, per the test comment at lines 40-41) and leaves the
  URL + label behind.
- Fix: prepend the OSC alternative (same shape as Node's). Small.
- Lane: **util-stripVT-OSC — flip 1**.

## Lane candidates (conservative flips)
| Lane | Tests | Est. flips |
|---|---|---|
| util-debounce (U1) | debounce | 1 |
| util-throttle (U1) | throttle | 1 |
| util-throttle-timing (U1) | throttle-timing | 0–1 |
| util-isPartialDeepStrictEqual (U2) | isPartialDeepStrictEqual | 1 |
| util-inspect-regexp-highlight (U3) | inspect-regexp | 1 |
| util-inspect-detached-dataview (U4) | inspect | 0–1 |
| util-inspect-proxy-26-wrap (U5) | inspect-proxy | 1 |
| util-inspect-budget (U6) | inspect-long-running | 1 |
| util-parseEnv (U7) | parse-env | 1 |
| util-stripVT-OSC (U8) | stripvtcontrolcharacters | 1 |
| **Total** | | **8–9 / 10** |

## NO-FIX list
- None. Every util gap has a concrete JS-portable fix (or, for U5, a
  Node-lane bridge with a documented browser ceiling).

## New-in-26 vs pre-existing
- NEW test files in 26 (not in vendored `parity/node-test/parallel/`):
  5 — debounce, inspect-regexp, isPartialDeepStrictEqual,
  throttle-timing, throttle.
- Pre-existing files, failing on NEW 26 assertions/behavior: 4 —
  inspect (detached-DataView format change), inspect-proxy (test
  content unchanged in substance; Node 26 changed the default Proxy
  rendering — see U5), parse-env
  (null-prototype + multiline/expansion cases), stripvtcontrolcharacters
  (new OSC hyperlink cases).
- Pre-existing marginal-slow (flaky in v24 sweeps): 1 —
  inspect-long-running (U6).

## Baseline corrections
- None. All 10 reproduce as classified; no sweep flake or load
  artifact found in this module.

## Unscored export gap (not in the 2,748, for the coordinator)
- `markPromiseAsHandled` is in the export diff (ADDED) and in Node 26
  `lib/util.js:592`, but its test file
  `test-mark-promise-handled.js` matches NO module glob in
  `parity/drift/run-baseline.mjs` (prefix is `test-util-`), so it was
  never run. The shim lacks it (only a comment mentions it,
  `src/util.js:13`). A new-util-APIs lane should include it; it
  contributes no flip to the scored set.
