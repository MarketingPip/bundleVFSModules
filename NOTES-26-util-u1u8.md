# NOTES-26-util-u1u8 — Node 26 Wave 1 lane UTIL U1–U8

Lane: `fix/26w1-util-u1u8`, base origin/main `d587825d` (PR #506 triage merged).
All changes in `src/util.js` only. Banked util count before lane: **26/36** (Node 26 suite).

## Result

**11 flips, all verified 2x isolated** (10 util + 1 repl):

| # | Test | Flip |
|---|------|------|
| U1 | `test-util-debounce.js` | `debounce()` ported |
| U1 | `test-util-throttle.js` | `throttle()` ported |
| U1 | `test-util-throttle-timing.js` | passes on mocked Date + setTimeout |
| U2 | `test-util-isPartialDeepStrictEqual.js` | `isPartialDeepStrictEqual()` ported |
| U3 | `test-util-inspect-regexp.js` | `highlightRegExp` ported |
| U4 | `test-util-inspect.js` | DataView indent + 5 further Node 26 changes (below) |
| U5 | `test-util-inspect-proxy.js` | proxy re-wrap ported |
| U5 | `test-repl.js` | same proxy re-wrap, cross-module |
| U6 | `test-util-inspect-long-running.js` | output budget ported |
| U7 | `test-util-parse-env.js` | null-prototype result |
| U8 | `test-util-stripvtcontrolcharacters.js` | OSC alternative in `vtRegex` |

New counts: util **36/36**, repl 96/108 (95 + 1). No regressions found in guard runs
(see Guards).

## Flags headers ARE honored (self-respawn)

`// Flags: --expose-internals` on `test-util-debounce.js`,
`test-util-throttle.js`, `test-util-throttle-timing.js`, `test-util-inspect.js`,
`test-util-inspect-proxy.js` is honored by the test itself: `require('../common')`
respawns the test as a child process with those flags
("NOTE: The test started as a child_process using these flags:
[ '--expose-internals']"). The baseline invocation (no flag) is therefore
correct as-is; the shim IS loaded in the respawned child. Flagged tests were
also run directly WITH `--expose-internals` during iteration with identical
outcomes.

## U1 — debounce / throttle (`debounce`, `throttle`, `markPromiseAsHandled`)

Faithful port of Node 26 `lib/internal/util/debounce.js` and
`lib/internal/util/throttle.js` (signature is `(fn, limit, interval, options)`,
not `(fn, delay, capacity)`).

Port decisions (browser ceiling — no libuv clock, no native Timeout internals):

- **Clock:** Node reads `internalBinding('timers').getLibuvNow()`. This port
  reads `Date.now()` at each use (dynamic global lookup, never captured), so
  `node:test` `mock.timers` — which swaps the `Date` global AFTER this module
  loads — drives `test-util-throttle-timing.js` deterministically. Real-timer
  behavior uses the wall clock instead of the monotonic libuv clock; same
  values at ms resolution for interval math.
- **Timers:** `globalThis.setTimeout` / `globalThis.clearTimeout` are resolved
  at each call site for the same reason (the timing test enables
  `mock.timers` before requiring `node:util`, and the shim may already be
  loaded by `preload`/`common`). Never captured at module load.
- **`markPromiseAsHandled`:** exported (Node: `internalBinding('util')`). Here
  it attaches a no-op rejection handler (`promise.then(undefined, () => {})`),
  which marks the promise handled the same way. Unscored export gap, 0 flips.
- **`AbortError`:** module-local class, code `ABORT_ERR`, name `AbortError`,
  default message `The operation was aborted`, `cause` carried through the
  `Error` constructor options (Node: `lib/internal/errors.js`).
- **`validateAbortSignal`:** ported from `lib/internal/validators.js:454`
  (non-null object with an `aborted` property).
- **`validateObject` tightened (shared):** Node 26 default `kValidateObjectNone`
  rejects `null` AND arrays (`lib/internal/validators.js:252`). The shim
  accepted arrays. Fixed the shared validator (`src/util.js`, validators
  section). Callers are `formatWithOptions`, `styleText`, `getCallSites` (x2)
  — all options objects, arrays invalid in Node for all of them. Guard runs
  (full util + repl pass sets) confirm no regression.
- `TIMEOUT_MAX = 2147483647` (2^31 − 1) as the `wait`/`interval` upper bound.
- `PromiseWithResolvers` is a local helper (no host dependency);
  `addAbortListener` is `signal.addEventListener('abort', fn, { once: true })`.
- `ERR_THROTTLED` message verified against Node 26
  (`lib/internal/errors.js:1866`): `The call was dropped by the throttled function`.
- `cancel()` with an unobserved pending promise deliberately does NOT mark it
  handled, so `unhandledRejection` fires (test asserts this); only the
  supersede path (`rejectOnCancel`) and the throttle `drop()` path mark handled.
- Header comment in `src/util.js:1-24` updated: `markPromiseAsHandled`,
  `getCallSites`, `diff`, `setTraceSigInt` and multiline `parseEnv` are no
  longer "not available"; the debounce/throttle wall-clock ceiling is recorded.

## U2 — `isPartialDeepStrictEqual`

Extended the existing `isDeepStrictEqual` engine (`deepEqualInner` + `partial`
param) with the Node 26 partial rules (`lib/internal/util/comparisons.js`):

- Arrays: `a.length < b.length → false`, then subsequence scan
  (`partialArrayEquiv` / `partialSparseArrayEquiv`, incl. hole handling and
  the `aPos > a.length - b.length + i` bound).
- TypedArrays / ArrayBuffers of differing length: subsequence byte match
  (`isPartialUint8Array`).
- Map / Set: subset matching — iterate `b` against unused `a` entries;
  `a.size < b.size → false`.
- Objects: prototype check skipped; `b` keys must be a subset of `a` keys
  (indices skipped for arrays/views in partial mode — covered by the
  subsequence scan). Boxed primitives fall through to the subset key loop.
- Oracle cross-check: 15 extra shapes (Map/Set/TypedArray/nested/proto-skipped)
  agree with the Node 26 binary 15/15.
- Ceiling (`ponytail:` comment in code): Node's partial error leniency
  (`isEnumerableOrIdentical`) is not ported — no test exercises it.

## U3 — `highlightRegExp`

Near-verbatim port of Node 26 `highlightRegExp`
(`lib/internal/util/inspect.js:533-780`): delimiters green, pattern yellow
(NOT whole-regexp red). `inspectStyles.regexp` is now the function with
`.colors = ['green','red','yellow','cyan','magenta']`; `stylizeWithColor`
gained the function branch AFTER the color-name check (Node order,
inspect.js:850-862). Palette lookup uses the shim's `inspectColors`
(`[open, close]` code pairs). All ~40 regexes, the broken/unclosed-`\p{`
case, and palette mutations (`[]`, `undefined`, custom
`['red','yellow','cyan']`, `regexp = 'red'` → whole-regexp red) pass.

## U4 — `test-util-inspect.js` (grew beyond the DataView estimate)

Running the full file surfaced 5 further Node 26 changes past line 217:

1. **DataView levelBoost dropped:** `level + levelBoost` → `level`; removed
   the `levelBoost` variable/increment. Node 26 reads the value BEFORE
   indenting (`formatExtraProperties`, inspect.js:2547-2560), so no indent leaks.
2. **SuppressedError extras:** the error branch appends `[error]` /
   `[suppressed]` extras for non-enumerable own props (Node 26 `formatError`,
   inspect.js:1993-2001), after `[cause]` / `[errors]`, same order as Node.
   No extras when the error merely inherits from a SuppressedError
   (hasOwnProperty check).
3. **Error-extras level fix:** `cause` / `errors` / `error` / `suppressed`
   extras are formatted at the error's own `level`, NOT `level + 1` — the
   parent `reduceToSingleString` re-indents every newline of the nested value
   by 2*(level+1), so level+1 double-counted. Verified against a Node 26
   oracle probe: `[cause]` holding a SuppressedError indents its entries
   at 4, not 6.
4. **`getPrefix` v24 → v26 rule:** v24 suppressed the `[tag]` when the
   constructor name CONTAINS the tag followed by an uppercase letter or
   end-of-name; v26 (inspect.js:1024-1041) shows the tag unless the
   constructor name EQUALS the tag (or the part after its last dot). Fixed
   the shared `getPrefix`, made `getErrorPrefix` delegate to it, and replaced
   the inline substring heuristics in the Map and Set branches with exact
   equality. Removed `normalizeBridgePromiseTag` (v24 workaround, now a
   provable no-op) and its call in the Promise branch. Fixed
   `SetSubclass(3) [Set]`, `MapSubclass(1) [Map]`, `PromiseSubclass [Promise]`
   (test-util-inspect.js:1524-1528).
5. **Getter returning a function:** Node 26 `formatProperty` (inspect.js:2578)
   formats function results via `formatValue` (`[Getter] [Function: bar]`);
   the shim deliberately reproduced a v24 `Symbol.prototype.toString` throw.
   Removed the throw; functions now join the object branch
   (test-util-inspect.js:2627, nodejs/node#64838).
6. **Dotted-tag rule in the generic object path:** a class named `Class` with
   tag `Namespaced.Class` prints just the tag — Node's `getPrefix` dot rule
   REPLACES the constructor with the tag, it does not merely drop the suffix.
   Fixed the custom-tag branch and the depth-exhausted branch in
   `formatObjectValue` (replace, not drop; only when prefix non-empty in the
   depth-exhausted case). The null-prototype fallback comparison stays plain
   `!==` (Node's null branch has no dot rule, inspect.js:1025-1030).
   (test-util-inspect.js:4107.)

## U5 — proxy re-wrap (`test-util-inspect-proxy.js` + `test-repl.js`)

Port of Node 26 `formatValue` proxy handling (inspect.js:1117-1200): with
`showProxy: false`, unwrap for formatting then re-wrap the result in
`Proxy(...)` once per proxy in the TARGET chain. Custom inspect on the
unwrapped target returns directly with NO wrap. Revoked → `<Revoked Proxy>`
(0 wraps); proxy over revoked → 1 wrap.

- **Counting:** the proxy head passes the FULL option set to the bridge
  (breakLength, maxArrayLength, maxStringLength, showHidden, sorted, getters
  added — proxy12 needs explicit `breakLength: 1`). Host v24.22.1 default
  breakLength is 80 (probed), same as the shim's, so passing defaults is a
  no-op. Wrap count comes from the `showProxy: true` spine
  (`getProxySpine` / `countProxyWraps`): handlers never count, only the
  target chain (proxy4's handler is proxy2 → 2 wraps, not 3).
- **Custom-inspect detection:** compare the showProxy:false bridge output
  against a customInspect:false bridge output; they differ → custom inspect
  involved → no wrap (`proxyTargetUsesCustomInspect`).
- **Fallback (nested throwing-handler case, line 208):** the host bridge (v24)
  unwraps only ONE level before reading the custom-inspect symbol, so a
  handler trap throws on chains of length >= 2 in ALL customInspect modes;
  Node 26 unwraps fully first (do/while loop) so it does not throw. When the
  main showProxy:false bridge call throws, the head recovers via the spine:
  `extractProxyTargetRendering(spine)` peels `Proxy [` layers (de-indenting
  continuation lines by 2 per peeled layer) and wraps N times; custom inspect
  on the spine returns the target unwrapped. `showProxy: true` main-call
  throws still fall through to the safe `'Proxy'` fallback.
- **Ceiling (`ponytail:` comment in code):** the fallback's de-indent assumes
  each spine level adds exactly 2 spaces (bridge `formatProxy` bumps
  `indentationLvl` by 2) — verified on the single-line-target case in the
  test; a multiline-target fallback case would need empirical confirmation.

## U6 — output budget (`test-util-inspect-long-running.js`)

Port of the Node 26 output budget (inspect.js:355, 1479-1490): `budget: {}` +
`budgetTripped: false` on the ctx; `reduceToSingleString` split into a wrapper
(accounting: `ctx.budget[ctx.indentationLvl || 0] += res.length`, trip at
> 2^27) + `reduceToSingleStringInner` (original body). The trip forces
`recurseTimes = -1` in the `formatValue` head (after the proxy head, before
custom inspect — so custom inspect sees depth −1 like Node's
`ctx.depth - recurseTimes`) and at the top of `formatObjectValue` (covers the
tail-to-tail fast path, which bypasses `formatValue`). The depth-exhausted
branch then returns `[Object]` / `[Array]` placeholders without recursing.

Measured: n=1000 structure inspects in ~9.5 s with 5.1 MB output (vs Node 26's
3.1 s / 135 MB — the shim trips earlier because the fast path never touches
`ctx.indentationLvl`, so everything accumulates into `budget[0]`; the test
only requires inspect to return). Pre-fix shim scaling: n=50 → ~2 s / 1.1 MB,
n=100 → 8.7 s / 7.4 MB, n=200 → 43 s / 20.5 MB. Node 26 probe: n=1000 → 3.1 s /
135,020,941 bytes; n=200 → 4.7 s / 52,921,114 bytes.

Ceiling (`ponytail:` comment in code): proxy / Promise / iterator-bridge
renderings are not collapsed by the trip.

## U7 — `parseEnv`

One-line fix: `parseEnv` result `{}` → `Object.create(null)`. Verified first
against the Node 26 binary on `test/fixtures/dotenv/valid.env`: 0 value diffs
across all 45 keys; only the prototype differed. Multiline quoted values,
`\n` expansion inside double quotes only, inline comments, `export ` prefix
and last-wins duplicates were already correct in the shim.

## U8 — `stripVTControlCharacters`

Prepended the OSC alternative to `vtRegex` (`src/util.js:643-655`), same shape
as Node 26 (`lib/internal/util/inspect.js:288-295`). Additionally changed the
CSI parameter separator `;` → `[;:]`: colon SGR sub-parameters
(`38:2:255:0:0`, `4:3`) also failed before the fix (probe). The
unterminated-OSC case still yields the CSI-fallback remainder (verified by
the test passing).

## Guards

- Util 26-suite pass set (26 files from `parity/drift/node26-baseline.jsonc`)
  + repl 95-file pass set must all stay passing.
- Official guard run: `parity/drift/run-baseline.mjs --modules util,repl
  --jobs 2`, output
  `hidden_files/drift/26w1-util-guard-2026-11-19/` (fresh CSV dir).
  **Result: util 36/36 pass, 0 fail, 0 timeout; repl 96/108 pass, 10 fail,
  2 timeout** (132/144 overall). Repl non-pass set is exactly the baseline
  non-pass set minus `test-repl.js` (12 files: envvars, highlight,
  history-init-fail-leak, mode, multiple-instances-async-error, preview,
  tab-complete-import, tab-complete-nested-repls, tab-complete-require,
  top-level-await, uncaught-exception-after-input-ended, user-error-handler)
  — all pre-existing failures outside this lane's scope, zero regressions.
  All 11 flips verified 2x isolated before the guard run, and the full
  26-file util guard set + 95-file repl guard set held in the official run.

## NO-FIX items

None. All 9–10 estimated flips landed; the throttle-timing 0–1 uncertainty
resolved to 1 (passes), and U4's first-failure estimate grew into 5 further
Node 26 changes that all landed in the same file.

## Post-guard history (ship log)

- **CI red, run 44641461502 (SHA `0da718b6`):** exactly 1 failing test of
  3072 — `tests/oracle-export-surface.test.js` flagged the 4 new Node 26
  util exports as extra against CI's pinned Node v24.20.0. Fixed by
  allowlisting them (first in `DEPRECATED_ALLOWLIST`, then — after the
  rebase — moved to `NEWER_NODE_ALLOWLIST` per the crypto/buffer lanes'
  convention on current main). Locally verified: `node:util` oracle
  subtest passes. (A local-only `node:crypto` oracle failure —
  `createMac`/`getMacs`/`parsePKCS12` present on host v24.22.1, absent in
  v24.20.0 — is NOT this lane: 0 occurrences in the v24.20.0 source pack;
  the crypto lane #514 added those exports to the shim on main.)
- **CI green, run 44642133653 (SHA `1bbf4e04`):** build + parity both
  success. CI's "Commit generated file" step then pushed
  `chore: regenerate vfs.js` (`27efb434`, dist/console.js, dist/repl.js,
  dist/util.js, dist/vfs.js). A push by the default `GITHUB_TOKEN` does
  NOT trigger a new workflow run, so no run ever existed for `27efb434`.
- **Rebase (dirty PR):** by then main had moved 7 merges (assert #516,
  crypto #514, https #515, buffer #512, module #508, vm #509, dns), and
  the PR went `mergeable: false / dirty` (dist conflicts). Rebased clean
  onto `0f30d17c`; `src/util.js` replay is byte-identical to the
  guard-verified commit, so the guard results above still hold.
- **dist:** local `node src/build-vfs.mjs` only completes with all
  `*_proxy` vars + `NODE_USE_ENV_PROXY` unset (otherwise Node's fetch
  routes esm.sh through the unreachable `hatch-egress-proxy`). Committed
  dist/util.js + dist/console.js (byte-identical to CI's regen) and
  dist/repl.js (minified names match CI's regen); dist/vfs.js, dist/fs.js,
  dist/fs_promises.js, dist/zlib.js are left for CI's regen — the local
  build embeds drifted floating-dep bytes (pako/picomatch, no lockfile)
  that CI's fresh install resolves differently. After CI's regen push, an
  empty commit re-triggers CI on the regen-inclusive tree (a
  `GITHUB_TOKEN` push cannot trigger a run itself).
