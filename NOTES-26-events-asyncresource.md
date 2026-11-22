# Node 26 events lane — EventEmitterAsyncResource subclass name default

**Base:** main `68c7f204`. **Banked:** events 39/39 (100%), program 2,372/2,813.
**Result:** `test-eventemitter-asyncresource.js` (uncounted, found by the
full-program re-sweep) now passes; full events guard 40/40 on the branch
(39 banked + the target). **No regressions.**

## Diagnosis (oracle-first)

Node 26 `lib/events.js:144-158` — `EventEmitterAsyncResource` constructor:

```js
constructor(options = undefined) {
  let name;
  if (typeof options === 'string') {
    name = options;
    options = undefined;
  } else {
    if (new.target === EventEmitterAsyncResource) {
      validateString(options?.name, 'options.name');
    }
    name = options?.name || new.target.name;
  }
  super(options);
  this.#asyncResource = new EventEmitterReferencingAsyncResource(this, name, options);
}
```

Two rules the shim (`src/events.js:1862-1870`, pre-fix) got wrong:

1. **Validation scope.** Node validates `options.name` ONLY for direct
   construction (`new.target === EventEmitterAsyncResource`). A subclass
   skips validation entirely. The shim validated unconditionally, so
   `class Foo extends EventEmitterAsyncResource {}; new Foo()` threw
   `ERR_INVALID_ARG_TYPE: The "options.name" property must be of type
   string. Received undefined` — the exact failure the parent measured
   (shim exit 1, 2x; oracle exit 0).
2. **Default name.** Node defaults to `new.target.name` (the subclass's
   class name — the async_hooks init-hook type the test's tracer tracks
   as `'Foo'`). The shim defaulted to the literal
   `"EventEmitterAsyncResource"`, which would have produced the wrong
   hook type even if the throw were removed.

Real-Node 26.13.1 probe (parent's brief + this lane's re-probe, identical):

| Shape | Node 26 |
|---|---|
| `new EventEmitterAsyncResource()` | THROW `options.name` |
| `new EventEmitterAsyncResource({})` | THROW `options.name` |
| `new EventEmitterAsyncResource({ name: 5 })` | THROW `options.name` |
| `new EventEmitterAsyncResource({ name: 'N' })` / `('S')` | OK |
| `class Foo extends … {}; new Foo()` | OK, type `'Foo'` |
| `new Foo({ name: 5 })` | THROW `"type"` (AsyncResource's own validation, downstream) |
| `new Foo({ name: 'R' })` / `('S2')` | OK |

The verbatim port reproduces all eight shapes: the subclass `{name: 5}`
case throws on `"type"` from the genuine builtin AsyncResource under
Node (the shim prefers `process.getBuiltinModule('async_hooks')`), exactly
as real Node does.

## Fix

`src/events.js` (+12/−2): port Node 26 `lib/events.js:150-153` verbatim —
gate `validateString` on `new.target === EventEmitterAsyncResource`,
default the name to `options?.name || new.target.name`. A `ponytail:`
comment names the ceiling (the name is only the init-hook type) and the
upgrade path (a real AsyncResource name registry, or the genuine builtin
already preferred under Node). No other file touched.

## Verification

- Target test `test-eventemitter-asyncresource.js`: isolated exit 0, 3x
  on the branch (staged recipe: Node 26 test file + Node 26 `common/`,
  absolute preload path, `PARITY_TARGET=events`).
- Full events guard: **40/40** — the 39 banked events passes (list from
  the re-sweep CSVs, `hidden_files/resweep-flags/small/csv-events/` +
  `csv-events-w4/`) + the target, each isolated exit 0. Evidence:
  `hidden_files/events-asyncresource/guard-list.txt`,
  `guard-results.csv`.
- Repo checks: `node --check src/events.js` OK; jest events suite +
  footprint test — see Ship section.
- Worktree restored clean after staging (tracked v24 test files restored
  with `git restore`; 26-only untracked files removed); final diff is
  exactly `src/events.js` + this file.

## Fold-in (follow-up docs sync, NOT this PR)

Fold-in done by the follow-up docs sync: events 39/39 → **40/40**,
denominator 2,813 → **2,814**, program 2,372/2,813 → **2,373/2,814**.
The test passes under a correct harness invocation and under the oracle,
so it counts now that the fix has landed. (Ship section for the fold-in
PR follows below.)

## Ship

- PR: #542
- Merge SHA: c2981c8dd9be380a3070b351dcc605c9bc4fca84
- CI: both jobs completed/success on code SHA 9e174c15, single run (poll 5; waiter killed by a runtime restart at poll 4 with Parity green and build in progress — state re-checked directly, build completed/success before the merge).

## Ship (fold-in)

- PR: #544
- Merge SHA: 65b42573ddf84716ed2d0dbe972dc2c7867c9457
- CI: both jobs completed/success on code SHA fb8c4ca7, single run (poll 4).
