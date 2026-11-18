# NOTES — http2 statusMessage getter/setter + warn-once (H2-V3)

## Ship

- PR #495
- Merge SHA: 40db00f5

## Problem

`Http2ServerResponse.statusMessage` was a plain `undefined` property
(`src/http2.js:1321`, set at `:1403` by `writeHead`), so both
`test-http2-compat-serverresponse-statusmessage-property` and
`test-http2-compat-serverresponse-statusmessage-property-set` failed
under the shim while passing natively: reads returned `undefined`
instead of `''`, sets stuck, and no `UnsupportedWarning` was ever
emitted.

## Oracle

Node `lib/internal/http2/compat.js:698-706`:

```js
get statusMessage() {
  statusMessageWarn();

  return '';
}

set statusMessage(msg) {
  statusMessageWarn();
}
```

Warn-once is module-level (`statusMessageWarned`, `:75,112-120`):

```js
function statusMessageWarn() {
  if (statusMessageWarned === false) {
    process.emitWarning(
      'Status message is not supported by HTTP/2 (RFC7540 8.1.2.4)',
      'UnsupportedWarning',
    );
    statusMessageWarned = true;
  }
}
```

`writeHead` also warns when passed a string statusMessage
(`compat.js:722-723`: `if (typeof statusMessage === 'string')
statusMessageWarn();`).

## Fix

`src/http2.js` only (+38/−1):

- Module-level `statusMessageWarned` flag + `statusMessageWarn()`
  (same guard shape as `src/dns.js` `emitDeprecationWarning`:
  `globalThis.process` + `typeof proc.emitWarning === "function"`,
  silent elsewhere; positional 2-arg call, exactly like the oracle).
- Constructor: removed `this.statusMessage = undefined` — Node defines
  the property as a prototype getter/setter pair and never assigns it
  in the constructor; assigning here would burn the warn-once guard
  before any test read.
- Class getter/setter pair mirroring the oracle (warn once, always
  return `''`, discard sets). `writeHead`'s existing
  `this.statusMessage = statusMessage` assignment routes through the
  setter, matching Node's writeHead warning on a string statusMessage.

## Probes (worktree `h2-v3`, deleted after use)

Native (`/tmp/zz-sm-native.js`, two responses, 3 reads + 1 set):
`""`, `""`, `""`, exactly 1 warning — module-level warn-once
confirmed across responses.

Shim `zz-h2v3-probe.js` (same shape, under the harness): `""`, `""`,
`""`, warning emitted. One timing note, probe-proven: native
`process.emitWarning` delivers the `'warning'` event asynchronously —
a counter read synchronously in the same `finish` handler shows 0, a
`setTimeout(..., 100)` read shows 1 (`zz-h2v3-probe2.js`). The tests'
`common.mustCall(1)` pattern (verified at process exit) is the
correct way to assert it; a synchronous counter is not.

## Differential (branch vs pristine main `b60a5401`, isolated 2×)

- Targets: `test-http2-compat-serverresponse-statusmessage-property`:
  branch [0,0] / base [1,1] — FLIPPED.
  `test-http2-compat-serverresponse-statusmessage-property-set`:
  branch [0,0] / base [1,1] — FLIPPED.
- Guards (0 on branch + base): `test-http2-large-write-multiple-requests`,
  `test-http2-client-upload-reject`,
  `test-http2-compat-client-upload-reject` (H2-F1 flips),
  `test-http2-compat-serverresponse-writehead` (H2-V2 flip),
  `test-http2-async-local-storage`, `test-http2-binding`.
- Exactly 2 flips, 0 regressions. Footprint 29/29. Jest http2 suites
  67/67.

## Count

http2 39 → **41/277**.
