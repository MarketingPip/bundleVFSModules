# NOTES-util-inspect-promise-bridge-tag.md — U2: inspect Promise bridge tag (0 flips alone)

## What

`src/util.js` only (+29/−1). One change: the Promise branch of `formatValue`
now normalizes the native-bridge output through `normalizeBridgePromiseTag`
(`src/util.js:595-625`, called at :2596) before `reindentBridgeResult`.

## Why

The shim delegates ALL Promise formatting to `nativeInspectBridge` — the
host's native `util.inspect` via `process.getBuiltinModule("util")`
(`src/util.js:537-541`, branch at :2584-2600), returned verbatim modulo
reindent. Pure JS cannot synchronously determine promise state, so the bridge
is load-bearing — but it leaks the host's version behavior.

`test-util-inspect.js:1636` (block "Test display of constructors",
test:1610-1660) expects subclassed builtins to print WITHOUT the builtin tag
— the Node v24.20.0 behavior:

```js
util.inspect(new PromiseSubclass(() => {})) // "PromiseSubclass { <pending> }"
```

Node v24.20.0 `lib/internal/util/inspect.js:775-795` (`getPrefix`) suppresses
the tag when the constructor name already contains the tag followed by an
uppercase letter or end-of-name: constructor `"PromiseSubclass"`, tag
`"Promise"` → `indexOf` 0, `endPos` 7, `constructor[7]` is `'S'` (uppercase,
≠ `'s'`) → no `[Promise]` appended. Between v24.20.0 and v24.22.1 Node
changed subclass inspect to always print the tag (host probe: `SetSubclass(3)
[Set]`, `MapSubclass(1) [Map]`, `PromiseSubclass [Promise]` — all tagged on
v24.22.1). The shim's own Set/Map code already implements the v24.20.0 rule
(`getPrefix` at `src/util.js:963-989`, identical logic) — that is why the shim
PASSES the SetSubclass (test:1628) and MapSubclass (test:1632) assertions that
native v24.22.1 fails, and only trips on Promise (the bridged type).

## How

`normalizeBridgePromiseTag(out)` reuses the shim's own `getPrefix` (the
v24.20.0 rule) to decide: it captures the leading constructor token of the
bridge output, and strips the leading ` [Promise] ` token only when
`getPrefix(ctor, "Promise", "Promise")` does NOT contain `[Promise]`. Cases
(probe-verified under the shim, uncolored + colored):

| Constructor | Bridge (v24.22.1) | After normalize | v24.20.0 rule |
|---|---|---|---|
| `Promise` | `Promise { 1 }` | unchanged | no tag (endPos === length) |
| `PromiseSubclass` | `PromiseSubclass [Promise] { <pending> }` | `PromiseSubclass { <pending> }` | no tag (`'S'` uppercase) |
| `MyPromise` | `MyPromise [Promise] { <pending> }` | `MyPromise { <pending> }` | no tag (endPos === length) |
| `Promisex` | `Promisex [Promise] { <pending> }` | unchanged | tag kept (`'x'` lowercase) |
| `Foo` | `Foo [Promise] { <pending> }` | unchanged | tag kept (no match) |
| `Promiseful` | `Promiseful [Promise] { <pending> }` | unchanged | tag kept (`'f'` lowercase) |

Colors: the bridge never ANSI-styles the constructor/tag (host probe with
`colors: true` — only the state/value is styled, e.g. `PromiseSubclass
[Promise] { \u001b[36m<pending>\u001b[39m }`), so the prefix is matched as
plain text; the regex tolerates ANSI escapes around the constructor name
defensively. Plain-Promise colored assertions (test:2633-2640) are unaffected:
`Promise { \u001b[36m<pending>\u001b[39m }` byte-identical before/after (no
tag present → no match → unchanged). On a v24.20.0 host (CI's pin) the bridge
output has no tag to strip, so the normalization is a no-op there.

Scope: Promise branch only. The Map/Set-iterator bridge (line ~2605) and the
WeakMap/WeakSet showHidden bridge (line ~3176) are untouched — their tags
follow their own `getPrefix` paths. The deep-recursion machinery
(`src/util.js:3645-3714`) is untouched — that is U3's region.

## Verification (branch head, base `2de10fc4`, banked 28/31)

- Sub-gap probe: `test-util-inspect.js` advances PAST test:1636 and fails at
  test:2290 (the 3b deep-recursion assertion, `assert(match.length > 500 ...)`
  on a 100,000-node list) — the EXPECTED outcome for U2 alone. It does NOT
  flip the test.
- Subclass matrix probe (`zz-u2-promise-tag.js`, deleted after use): 6/6 PASS
  (table above) + colored plain/subclass outputs correct.
- Full util differential (`hidden_files/fast-sweep/util-u2-branch-2026-11-18.csv`,
  28 rows, 25 pass / 3 fail): diff vs triage sweep EMPTY — **0 flips /
  0 regressions**. Count holds **28/31** (getcallsites pair still 1 — U1's
  region; test-util.js + both `.mjs` files still 0).
- Footprint test: 29/29 PASS. `node --check src/util.js` clean.
- Util jest suites (5): 26/26 PASS (util-inspect-duplicates,
  util-inspect-grouping, export_surface_util, export_surface_util_types,
  util_named_exports).

## Ship

- PR #484 / merge SHA ___ (squash-merged 2026-11-18)

## CI notes

- Round 1 (code SHA `6f16254c`, base `2de10fc4`): poll 6 BOTH GREEN.
- Rebased onto `82257ac4` (U1 #483 merged first) → code SHA `d8927dec`.
- Round 2 (code SHA `d8927dec`): poll 5 Parity success, build FAILURE, no log
  via API. Adjudicated transient, not caused by this change: local
  `build-vfs` / `build-sandbox --check` / `build-runtime --check` all exit 0;
  full local jest serial shows exactly the 7 known host-skew failures
  (constants ×3, oracle crypto/util ×2, perf_hooks ×1, sys ×1 — failing
  identically on pristine main under host v24.22.1); and the change is
  provably a no-op on CI's pinned v24.20.0 (the bridge never emits the tag
  there). Retriggered with this NOTES-only commit per the R2 #472 precedent.
