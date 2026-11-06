# NOTES — http request argument validation (Triage Lane 1)

Targets (both exit 1 on main `d9d0c273`, exit 0 on branch):
- `test-http-request-invalid-method-error` (1 → 0)
- `test-http-url.parse-only-support-http-https-protocol` (1 → 0)

## Diagnosis (Node source first, then probes)

Node v24.20.0 (`node-src/lib/internal/errors.js`):
- `ERR_INVALID_HTTP_TOKEN`: `'%s must be a valid HTTP token ["%s"]'`,
  `TypeError` — the value is interpolated RAW via `%s`
  (`lib/_http_client.js:428-429`, `checkIsHttpToken` → throw).
- `ERR_INVALID_PROTOCOL`: `'Protocol "%s" not supported. Expected "%s"'`,
  `TypeError`.

Real-Node probe (v24.22.1, `/tmp/probe-av-native.js`):
- `http.request({ method: "\0" })` → `TypeError`, message
  `Method must be a valid HTTP token ["<NUL>"]` (raw NUL byte, not the
  six characters `\u0000`).
- `http.request(url.parse("file:///whatever"))` → `TypeError`,
  `Protocol "file:" not supported. Expected "http:"`.
- Header-name case: `Header name must be a valid HTTP token ["bad name"]`
  — raw interpolation, same shape.

Shim divergences (`src/http.js`):
- `ERR_INVALID_HTTP_TOKEN` used `JSON.stringify(String(val))`, which
  escapes NUL (and any other control char) as the literal `\u0000`.
- `ERR_INVALID_PROTOCOL` called `makeError` without a constructor, so it
  defaulted to plain `Error` instead of `TypeError`.

## Fix (`src/http.js`, +0/−0 lines net — two one-line changes)

- `ERR_INVALID_HTTP_TOKEN`: interpolate `String(val)` raw, matching
  Node's `%s` formatting.
- `ERR_INVALID_PROTOCOL`: pass `TypeError` as the constructor.

## Verification

- Targets 0×2 on branch; adjacent `ERR_INVALID_HTTP_TOKEN` guards still
  0×2 (`test-http-mutable-headers`, `test-http-outgoing-proto`,
  `test-http-write-head` — their asserted values `["undefined"]`,
  `["404"]`, `["あ"]`, `["3840"]` render identically under raw
  interpolation).
- Guards 21/21 exit 0: 8× #345, 4× #347, 5× #350/#351, dump-req #353,
  keepalive-free #355, remove-header pair #357.
- Differential (fast-sweep): base 361/4/30/1×134/1×139 vs branch
  361/5/29/1×134/1×139 — exactly the 2 targets toward pass
  (`test-http-request-invalid-method-error`, `test-http-url.parse-only-
  support-http-https-protocol`), 0 mode changes. CSVs
  `fast-sweep/http-sweep-av-{base,branch}.csv`.
  - The runner's DIFF flagged 2 "regressions"; both are load flakes,
    proven by 3× isolated re-runs per side:
    - `test-http-outgoing-end-cork` (0→1 in sweep): branch 0,0,1;
      base 1,1,0 — fails identically on both sides with
      `AssertionError: Request timed out` at test line 58.
    - `test-http-pipeline-requests-connection-leak` (0→124 in sweep):
      branch 0,0,0; base 0,0,0 isolated — the sweep 124 is a load
      artifact (branch sweep ran under 8-lane contention: 311/397
      tests hit the 10 s phase-1 cap vs 5 in the post357 resweep).
  - Base-vs-post357 delta is `test-http-byteswritten` 0 → 124: the known
    pre-existing flake (fast-sweep README), timed out under CPU
    contention from the concurrent full jest run; not a lane regression.
- Jest full suite: 3059 passed / 7 failed / 1 skipped (known baseline).
- `tests/ondemand-require.test.js`: 29/29.
- Builds: `build-vfs` 0, `build-sandbox --check` 0, `build-runtime --check` 0.

## Scope note

`ERR_INVALID_CHAR` and `ERR_HTTP_INVALID_HEADER_VALUE` also use
`JSON.stringify` in their messages. They were NOT changed: their tests
currently pass with the JSON form, and Node formats those errors
differently (separate factories). Out of scope for this lane.
