# NOTES — util: inspect deep-recursion stack (test-util-inspect.js)

## Summary

`test-util-inspect.js` first failed at test:2290: `assert(match.length > 500
&& match.length < 10000)` on `util.inspect(list, { depth: Infinity })` for a
100,000-node linked list. The shim produced exactly **500** `next`
occurrences (deterministic); native v24.22.1 produces 931. There is no coded
cap (no `500` literal anywhere in `src/util.js`); the interruption machinery
itself (`isStackOverflowError` + the `[Ctor: Inspection interrupted
prematurely…]` substitution) works correctly, as does the shallow
`{ next: { next: { next: [Object] } } }` case.

Root cause (triage-proven, worker-proven with a controlled experiment): the
shim inlined Node's `formatObject` into `formatValue`, so one frame carries
the locals of what Node spreads across three functions (formatValue +
formatObject + formatProperty) — ~1.87 KB/level vs native ~1.06 KB/level.
Synthetic experiment (native probe, 2026-11-18): tiny recursive fn 10,936
levels; giant-body fn with dead locals 2,928; with live locals 3,416 — body
size costs ~3.7× per level. The count scales with `--stack-size` (shim
500 → 1044 at `--stack-size=2000`; native 931 → 1939), confirming a genuine
stack-overflow interruption point, not a cap.

## Fix shape (src/util.js only)

1. **Tail extraction.** The object tail (old lines 3234–3757, from
   `// ---- generic object / array / function / date / regexp` to
   formatValue's close) moved verbatim into `formatObjectValue(ctx, value,
   recurseTimes, level, finish, depthCounted)` (now at `src/util.js:3250`);
   formatValue's head ends with `return formatObjectValue(...)`. The tail
   uses only `finish` (12×) and `depthCounted` (2×, in `finalize`) from the
   head; `nextRecurse` 0×.
2. **Direct tail-to-tail recursion.** `isDirectTailChild(ctx, child)` (just
   above `formatObjectValue`) mirrors formatValue's head early returns
   exactly — null/non-object out; circular (seenMap) out; proxies out
   (checked BEFORE getPrototypeOf — a revoked proxy throws there);
   prototype must be Object.prototype/null or an array (class instances,
   Dates, RegExps, boxed primitives keep the full formatValue route —
   conservative); custom inspect read with the head's exact throw behavior;
   exclusions via `types.*`: isPromise, isMapIterator, isSetIterator,
   isExternal, isNativeError, safeInstanceof Error, isArrayBuffer,
   isSharedArrayBuffer, isDataView, isTypedArray, isMap, isSet, isWeakMap,
   isWeakSet. In the fast path, when the predicate holds, the head
   bookkeeping is replicated inline (formatCount guard → `"..."` past
   100000; seen push + seenMap set; depthLevel++ unless depth-exhausted; a
   `childFinish` closure identical to formatValue's `finish`) and
   `formatObjectValue` is called directly. **Level is passed as 0, NOT the
   parent's level** — the old fast path called `formatValue` without a level
   (defaults to 0); only the Error cause/errors paths use `level+1`.

## Stack measurements

| stage | `next` count | note |
|---|---|---|
| base `cec33d53` | 500 | deterministic, fails test:2290 (`> 500` required) |
| after tail extraction (step 1) | 447 | regressed — two frames/level, head still large; expected, payoff is step 2 |
| after direct tail-to-tail recursion (step 2) | **1004** | past native's 931; bar is 501+ |
| native v24.22.1 | 931 | reference |

Margin over the 500 bar: +504. Shallow case unchanged:
`"{ next: { next: { next: [Object] } } }"`.

## Sub-gaps fixed in-lane (all pre-existing on base `cec33d53`, all exposed
## only because the test now runs past 2290; each oracle-proven, same
## file/region family — per the Z6/R7 precedent for fixes a flip needs)

- **test:3882 — dim wrap on prototype properties.** `inspect(bar,
  { showHidden: true, getters: false, colors: true })` — prototype getters
  `[xyz]`/`[def]` must print dimmed
  (`\x1B[2m[xyz]: \x1B[36m[Getter]\x1B[39m\x1B[22m`); the shim printed them
  undimmed. Verified pre-existing on pristine base. Oracle
  (`lib/internal/util/inspect.js:719-766`, `addPrototypeProperties`): Node
  wraps every prototype property in `\u001b[2m...\u001b[22m` when colors are
  on. Fix: `collectPrototypeProps` wraps the `formatProperty` result in the
  dim codes when `ctx.options.colors` is true.
- **test:3900 — `Symbol.species` getter throw.** `inspect(
  Object.getPrototypeOf(bar), { showHidden: true, getters: true })`.
  Expected: `[Symbol(Symbol.species)]: [Getter: <Inspection threw
  (TypeError: Symbol.prototype.toString requires that 'this' be a
  Symbol...)>]`. Actual before fix: `[Symbol(Symbol.species)]: [Getter:
  undefined]`. Mechanism: the property is Map's species getter, collected
  from Map via `collectPrototypeProps` walking Bar's prototype chain; the
  shim's `formatProperty` getter branch calls `desc.get` with receiver Bar,
  gets back the Bar class (a function), `typeof tmp !== 'object'`, so
  `formatPrimitive(ctx, tmp)` returns undefined → `"[Getter: undefined]"`.
  Node's `formatProperty` (oracle `inspect.js:2282+`) has the same branch
  structure, but Node's `formatPrimitive` falls through to
  `SymbolPrototypeToString(value)` for anything non-primitive — including a
  function — which throws; the catch renders `<Inspection threw...>`. The
  shim's `formatPrimitive` returns `undefined` for functions (formatValue's
  dispatch needs that), so the fix is LOCAL to formatProperty's getter
  branch: after `formatPrimitive`, if the result is `undefined` (reachable
  only when tmp is a function), call `Symbol.prototype.toString.call(tmp)`
  to reproduce the exact V8 TypeError; the enclosing catch renders it.
- **test:3900 (same assertion, second half) — `[abc]`/`[def]` missing from
  prototype props.** The shim's output lacked the trailing `[abc]: [Getter:
  true]` / `[def]: [Getter/Setter: false]` entries. Verified pre-existing
  on pristine base. Root cause (proven by temporary instrumentation of
  `collectPrototypeProps`/`maybePrototypeProps`, restored after):
  `maybePrototypeProps` is never called for Bar.prototype —
  Bar.prototype's `objToString` is `"[object Map]"` (inherited
  `Symbol.toStringTag` from Map.prototype), not `"[object Object]"`, so it
  takes the tail's custom-toStringTag branch, which computes the tag (`Foo
  [Map]`) but NEVER assigns `protoProps` (stays `[]`). The head's Map branch
  appends `maybePrototypeProps` at its own site, which is why `bar` (a Map
  instance) gets proto props but Bar.prototype (a non-Map object with an
  inherited tag) doesn't. Fix: at the end of the custom-toStringTag
  else-branch, gated on `!isPlain`, assign `protoProps =
  maybePrototypeProps(ctx, value, recurseTimes,
  nodeConstructorName(value))` — mirroring Node's `getConstructorName`,
  which collects prototype properties for non-plain objects regardless of
  tag branch (oracle `inspect.js:719-766`).
- **test:3995 — `maxStringLength: null`.**
  `assert.match(util.inspect(x, { maxStringLength: null }), /a'$/)` where
  x = `"a".repeat(1e6)` — the shim truncated at ~10000 (`"... 28 more
  characters`). Pre-existing on base (`git show cec33d53:src/util.js:1438`
  has the same `?? 10000`). Oracle (`inspect.js:408`): `if
  (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;`. Fix at
  the use site in `formatPrimitive`: `maxLen =
  ctx.options.maxStringLength === null ? Infinity :
  (ctx.options.maxStringLength ?? 10000)`.
- **test:4026 — cross-context custom-inspect ctx leak.**
  `assert(!objectGraph.has(Object))` / `assert(!objectGraph.has(Function))`
  where the target comes from `vm.runInNewContext` and its custom inspect
  stores the passed `ctx`. The shim passed a raw host-realm `{ stylize,
  ...ctx.options}` — its prototype chain reaches host `Object.prototype` →
  `constructor` → host `Object`, and `stylize` (a host function) reaches
  host `Function`. Oracle: Node passes `getUserOptions(ctx, isCrossContext)`
  (`inspect.js:299-344`): a filtered options object; when cross-context
  (`proxy !== undefined || !FunctionPrototypeSymbolHasInstance(Object,
  context)`), null prototype, all non-primitives deleted, `stylize`
  replaced by a null-prototype wrapper around the real one (catches throws,
  returns the value when the result isn't a string). Fix: ported
  `getUserOptions` (just before `formatValue`) and wired it into the
  custom hook with `isCrossContext = !(value instanceof Object)` (proxies
  return early before the hook, so `instanceof` is safe there;
  null-prototype objects also sanitize, matching Node). The shim's
  `ctx.options` already equals Node's option set (12 defaults + extras
  flat), so the non-cross-context shape is unchanged. Native on this host
  could NOT adjudicate 4026 (native fails earlier at test:1628, the known
  v24.22.1 Promise-tag skew) — the oracle was the authority.
- **test:4159 — `__proto__` key quoting.** `inspect({ ["__proto__"]:
  { a: 1 } })` must print `"{ ['__proto__']: { a: 1 } }"` (and with
  showHidden + non-enumerable, `"{ [['__proto__']]: { a: 1 } }"`). The shim
  printed `{ __proto__: { a: 1 } }`. Oracle (`inspect.js:2337`): `name = key
  === '__proto__' ? "['__proto__']" : ctx.stylize(key, 'name')`. Fix: new
  `formatKeyName(ctx, key)` helper (before `formatProperty`):
  non-identifier keys print quoted, `__proto__` prints as `['__proto__']`
  (unstylized, like Node), else stylized name. Used at the main
  `formatProperty` name site AND the three fast-path key sites in the tail
  (the 4159 case flows through the fast path — its value `{a:1}` is a plain
  object — so fixing only formatProperty would NOT have fixed the test).
- **test:4181 — numeric separator on the fractional part.**
  `util.inspect(123456789.12345678)` with `numericSeparator: true` must be
  `"123_456_789.123_456_78"`; the shim gave
  `"123_456_789.12345678"`. Oracle `formatNumber`
  (`inspect.js:1925-1957`) splits integer/fraction and uses
  `addNumericSeparatorEnd` (left-aligned groups of 3, `inspect.js:1912-1920`)
  for the fraction. Two defects: (a) `addNumericSeparatorEnd` was CALLED
  (old line 4085, in `formatNumberPlain`) but NEVER DEFINED — a latent
  ReferenceError on the `format()` path; (b) `formatPrimitive`'s number
  branch called the integer-only one-arg `addNumericSeparator`. Fix: ported
  `addNumericSeparatorEnd` next to `addNumericSeparator`, and the number
  branch now delegates to the existing `formatNumberPlain(value,
  ctx.options)` when the separator is on (it already mirrors Node's
  `formatNumber`, including -0/NaN/exponent handling).
- **test:4197 — TypedArray bridge drops `numericSeparator`.**
  `util.inspect(new Float64Array([100_000_000]))` must be
  `"Float64Array(1) [ 100_000_000 ]"`; the shim gave `"Float64Array(1) [
  100000000 ]"`. Root cause: the TypedArray branch delegates to
  `nativeInspectBridge` without passing `numericSeparator` (bridge defaults
  it off); the pure-JS fallback below handles it. Fix: added
  `numericSeparator: ctx.options.numericSeparator` to all five
  value-formatting bridge calls (proxy, Promise, Map/Set iterators,
  TypedArray, hidden-props) — one line each, strictly more faithful; the
  two depth:-1 name probes were left untouched.
- **test:4322 — `wellKnownPrototypes` shortcut.** The test patches
  `Function.prototype.constructor` with a getter returning
  `BuiltinPrototype` (Function.prototype itself), then `inspect({ f() {} })`
  must be `"{ f: [Function: f] }"`; the shim printed `"{ f: [Function: f]
  Object }"`. Root cause: the shim's `nodeConstructorName` walk read the
  patched descriptor (a getter, no `.value`), skipped Function.prototype,
  and fell through to Object.prototype, returning `"Object"` — and
  `getFunctionBase` appends the constructor when it differs from the type
  (same line as Node's `getFunctionBase`, oracle:1300+). Node avoids this
  because its `getConstructorName` (oracle:657+) checks a
  `wellKnownPrototypes` map BEFORE reading the descriptor. Fix: ported the
  map (20 entries: Array, ArrayBuffer, Function, Map, Set, Object,
  TypedArray via `Object.getPrototypeOf(Uint8Array[.prototype])`, RegExp,
  Date, DataView, Error, AggregateError, RangeError, TypeError, Boolean,
  Number, String, Promise, WeakMap, WeakSet — filtered to existing
  constructors) placed after `builtinCtorNames`, and a check at the top of
  the walk loop. (First Map construction was wrong — `new Map` takes only
  the first two elements of each entry, dropping the ctor — fixed to
  `.map(([proto, name, ctor]) => [proto, [name, ctor]])`.)
- **test:4383 — error `name`/`message` key filter inverted for
  non-strings.** `error.name = /a/g` (a RegExp); expected
  `util.inspect(error)` = `` `${re} [EvalError]\n${error.stack.split("\n")
  .slice(1).join("\n")}` `` (no body block); the shim appended ` {\n
  name: /a/g\n}`. Oracle `formatError` (`inspect.js:1693-1700`): remove
  `name`/`message` from keys when the value is NOT a string, or when the
  string already appears in the stack. The shim's filter kept non-string
  values (`return !(typeof v === "string" && base.includes(v))`). Fix: `if
  (typeof v !== "string") return false; return !base.includes(v);`.
- **test:4420 — spurious `<ref *1>` on a circular-stack error.**
  `error.stack = error` must print `"[Error: foo\n [Circular *1]]"`; the
  shim printed `"<ref *1> [Error: foo\n [Circular *1]]"`. Root cause: the
  head's `finish` prepends `<ref *N>` whenever `circularNums` has the
  value, but Node's `formatRaw` (oracle:1090-1091) returns an error's base
  EARLY when it has no extra keys and no proto props — before the `<ref
  *N>` logic at oracle:1185-1197 (which only lives in `formatRaw`'s tail).
  Fix: in the error branch, when `output.length === 0`, do the bookkeeping
  only (pop seen, delete seenMap, decrement depthLevel) and return `base`
  without the ref prepend.
- **test:4429 — nested circular-error indentation.** Two errors with
  cross-linked stacks must print `"[Error: foo\n [Error: bar\n [Circular
  *1]]]"` (inner line at 8 spaces); the shim gave 4. A native probe
  confirmed the pattern is 4/8/16 for a 3-error chain (doubling).
  Mechanism (oracle `formatError` tail, `inspect.js:1771-1776`): "The
  message and the stack have to be indented as well!" — every newline in
  the formatted error is re-indented by the current `ctx.indentationLvl`
  before returning. Fix: after the key filter in the error branch (Node
  filters against the pre-indent stack) and before the properties are
  appended, `if (ctx.indentationLvl !== 0 && ctx.indentationLvl !==
  undefined) base = base.replaceAll("\n", `\n${" ".repeat(
  ctx.indentationLvl)}`)`. Single-line bases are unaffected.
- **test:4436 — `Error[Symbol.hasInstance]` patched with `mustNotCall`.**
  The test (last block in the file; file is 4464 lines) patches
  `Error[Symbol.hasInstance]` with `common.mustNotCall()`, then inspects an
  error whose `name`/`stack`/`cause` getters all throw, expecting
  `"[object Error] {\n  stack: [Getter/Setter],\n  name: [Getter],\n  cause:
  [Getter]\n}"`, plus `inspect(DOMException.prototype)` matching
  `/^\[object DOMException\] \{/`, then deletes the patch. Three fixes,
  all oracle-proven:
  - (a) **Default-hasInstance checks.** Node's `isError` (oracle
    `lib/internal/util.js:99-103`) is `isNativeError(e) ||
    FunctionPrototypeSymbolHasInstance(Error, e)` — the DEFAULT hasInstance
    (chain walk), not the `instanceof` operator. The shim used
    `safeInstanceof` (operator) in the error branch and in
    `isDirectTailChild` (a shim-only call site Node has no equivalent of,
    firing for every child during formatting). Added `defaultHasInstance`
    (after `safeInstanceof`): `Function.prototype[Symbol.hasInstance].call(
    ctor, value)` in try/catch → false. Used in the error branch
    (`isErrorValue`) and in `isDirectTailChild` (replacing
    `safeInstanceof(child, Error)`). `safeInstanceof`'s other uses
    (nodeConstructorName descriptor path — matches Node's operator-using
    `isInstanceof`) stay as-is. The remaining trip was proven by temporary
    instrumentation of `safeInstanceof` (restored after): zero
    `safeInstanceof(Error)` calls in the full run — the trip was the
    assert-failure path (see below), not the shim.
  - (b) **Throwing `name` getter → `[object Error]` base.** Node's
    `getStackString` calls `ErrorPrototypeToString(error)`, which reads
    `name` itself; a throwing name getter makes it throw, `formatError`
    catches and returns `ObjectPrototypeToString(err)` as the base — and
    `formatRaw` still appends the properties. The shim had pre-caught the
    name throw (defaulting to `"Error"`) and its `errorProtoToString`
    never threw, so the base came out `"[Error]"` (single-line, 71 chars
    — under breakLength — vs the expected multi-line 82-char layout; the
    single-line divergence was a CONSEQUENCE of the wrong base, not a
    separate bug). Fix: a `nameThrew` flag on the name read; `errStrFailed`
    starts as `nameThrew`, so the errStrFailed branch runs. Verified by
    native probe: `Error.prototype.toString.call(error)` throws for this
    error, and native inspect is never observed calling `toString` here
    (the catch path) — consistent.
  - (c) **errStrFailed base is the value's OWN tag, not `"[object
    Error]"`.** The shim's errStrFailed branch hardcoded `"[object
    Error]"`, but Node's `formatError` catch returns
    `ObjectPrototypeToString(err)`. For `DOMException.prototype` — which
    IS an Error by prototype chain (`DOMException.prototype instanceof
    Error` is true natively; its prototype IS `Error.prototype`) — the
    `name` getter throws `TypeError: Value of "this" must be of
    DOMException`, so Node's getStackString fails the same way and the base
    is `"[object DOMException]"`. Fix: `base = objectToString(value)` in
    the errStrFailed branch. (Without this, `assert.match(
    inspect(DOMException.prototype), /^\[object DOMException\] \{/)`
    failed; the failure path in the SHIM's `src/assert.js:5138-5140` does
    raw `actual instanceof Error` → tripped the patched mustNotCall → its
    native-inspect formatting of the huge DOMException string overflowed
    the stack — that was the `RangeError: Maximum call stack size
    exceeded` crash, a harness artifact of the failing assertion, not a
    shim-inspect defect.)

## Verification (branch head, worktree util-u3-deep-recursion)

- Flip 2× isolated, exit 0: `test-util-inspect.js` (full test, clean runs
  after all instrumentation was restored).
- Post-fix `next` count: 1004 (bar 501+, native 931); shallow case
  unchanged.
- Full util differential (fast-sweep `--target util --force --jobs 2`,
  `util-u3-branch-2026-11-18.csv`): 27 pass / 1 timeout / 0 fail.
  Exactly 1 flip: `test-util-inspect.js` 1 → 0. Zero regressions.
  The 1 timeout (`test-util-inspect-long-running.js`, 124 in sweep)
  adjudicated isolated 0, 0 — sweep-load artifact (slow-by-design test
  exceeding the 30 s phase-2 cap under `--jobs 2` contention), not a
  regression. Guards exit 0: `test-util.js`, both `.mjs` files
  (`test-util-convert-signal-to-exit-code.mjs`,
  `test-util-promisify-custom-names.mjs`).
- Repo jest util suites (5): 26/26 PASS (util-inspect-duplicates,
  util-inspect-grouping, util_named_exports, export_surface_util,
  export_surface_util_types).
- Footprint test (`tests/ondemand-require.test.js`): 29/29 green.
- `node --check src/util.js` clean.
- Diff: `src/util.js` only, +434/−40. All six `zz-u3-*.js` probes deleted
  before shipping. No docs-number changes in this PR.

## Ship

- PR #485
- Merge SHA: 50bee41f
