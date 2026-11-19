# NOTES — Node 26 re-target triage: trace_events (1 gap)

Base SHA `3c091022`. Docs only — no src/ changes.
Banked numbers (parent-verified, not recomputed): overall 2,748 tests,
2,144 pass / 575 fail / 29 timeout; trace_events non-pass 1, shim-gap 1,
0 fail-natively, 0 native-timeout (oracle: native Node 26.13.1 passes it).

## The one gap

- `test-trace-events-get-category-enabled-buffer.js` — harnessExit 1,
  flags `["--expose-internals"]`, nativeExit 0, class `shim-gap`.

## What the 26 test actually is (it is NOT the v24 test)

The v24.20.0 test (vendored in `parity/node-test/parallel/`) used the
test-only binding:

```js
const binding = require('internal/test/binding');
const getCategoryEnabledBuffer =
  binding.internalBinding('trace_events').getCategoryEnabledBuffer;
// ...
const buffer = getCategoryEnabledBuffer(category);
assert.ok(buffer[0] === 0, …); tracing.enable();
assert.ok(buffer[0] > 0, …); tracing.disable();
assert.ok(buffer[0] === 0, …);
```

The Node 26 test (`~/workspace/local/node-26-src/test/parallel/
test-trace-events-get-category-enabled-buffer.js`, full diff vs v24 in the
evidence index) was rewritten around a new internal module:

```js
// Flags: --expose-internals
common.skipIfPerfettoEnabled();   // NEW common helper (absent from v24 common)
const { createTracing, getEnabledCategories } = require('trace_events');
const { categoryEnabledChecker } = require('internal/trace_events');
// ...
const isEnabled = categoryEnabledChecker(category);
assert.strictEqual(isEnabled(), false);
tracing.enable();
assert.ok(getEnabledCategories().includes(category));
assert.strictEqual(isEnabled(), true);
tracing.disable();
assert.strictEqual(getEnabledCategories(), undefined);
assert.strictEqual(isEnabled(), false);
```

Node 26's `lib/internal/trace_events.js:25-33` shows what the checker is:

```js
// The returned function reads the category's enabled flag directly when the
// binding can expose it to JS, and asks the tracing controller otherwise.
function categoryEnabledChecker(category) {
  const buffer = getCategoryEnabledBuffer(category);
  if (buffer === undefined) {
    return () => isTraceCategoryEnabled(category);
  }
  return () => buffer[0] > 0;
}
```

Same V8 category-enabled flag byte as the v24 test — new API shape, same
underlying mechanism. (Also new: `common.skipIfPerfettoEnabled()`, because
Perfetto aborts on a category outside its static registry and its enabled
flag does not follow `createTracing().enable()`.)

## New-in-26 vs pre-existing split

**New-in-26 test file (rewritten, not carried over).** The v24 test was
already adjudicated: trace_events closed 28/29 on v24 with this file as the
1 NO-FIX — `getCategoryEnabledBuffer` needs a write to V8's C++ 
...[truncated 4700 chars]