# NOTES — https kConnectionsCheckingInterval twins

## Outcome
- `test-https-server-async-dispose`: 1 → 0
- `test-https-server-close-destroy-timeout`: 1 → 0
- No src/ change. Fix is harness-only: `parity/preload.mjs` extends the
  PR #330 `_http_server` redirect to the `https` target; the adapter
  comment updated to match.

## Root cause
Both twins read `server[kConnectionsCheckingInterval]` from
`require("_http_server")`. Real Node: https shares the slot —
`lib/https.js:79` Server → `tls.Server`, registers
`this.on('listening', setupConnectionsTracking)` (`lib/_http_server.js:614`
sets `this[kConnectionsCheckingInterval]`, symbol exported at `:1369`).
The shim mirrors this exactly: `src/https.js:21`
`HttpsServerBase extends http.Server`, so it inherits ServerBase's
construction-time `listening` listener (`src/http.js:7278`, creates a new
`{_destroyed: false}` per emit) and `[Symbol.asyncDispose]()` (`:7692`).

The only gap was the harness: PR #330's preload special case was
`target === "http"` only, so under `PARITY_TARGET=https` the require fell
through to native Node's `_http_server`, whose symbol never matches the
shim's `Symbol.for` bridge key — `server[kConnectionsCheckingInterval]`
read `undefined` and both tests threw
`TypeError: Cannot read properties of undefined (reading '_destroyed')`
at the assertion itself.

## Fix
- `parity/preload.mjs`: condition is now
  `(target === "http" || target === "https") && bare === "_http_server"`.
  Only the two https twins (plus the three http tests) require
  `_http_server`, and only for `kConnectionsCheckingInterval`
  (verified by grep over `parity/node-test/parallel/`).
- `parity/http-server-adapter.mjs`: comment updated — the old text said
  the https twins "keep the real module"; they now redirect here too.

## Verification
- Twins 0x2 on branch; 1x2 on base (both TypeError at the assertion).
- `test-https-server-connections-checking-leak` 0x2 on branch and base
  (does not require `_http_server`; unaffected).
- Guards 20/20 on branch: http twins (async-dispose,
  close-destroy-timeout, clear-timer), all 8 PR #345 flips, all 4 PR #347
  flips, all 5 PR #350/#351 flips.
- Full `test-https-*` sweep base vs branch: `https-sweep-twins-{base,branch}.csv`.
- Full http fast-sweep differential: `http-sweep-ht-{branch,base}.csv`
  (0 regressions expected).
- Jest 3059/7/1 baseline; ondemand 29/29; builds 0/0/0; dist restored.

## Follow-ups (not this PR)
- None. The https server-lifecycle family is closed by this bridge; the
  remaining https failures (see the sweep CSV) are TLS/agent surfaces
  outside the kCI slot.
