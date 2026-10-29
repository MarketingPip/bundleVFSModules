# NOTES: test-http-upgrade-server-callback (ponytail lane)

## Result

**Target passes with a harness-only change. Zero product files touched.**

`test-http-upgrade-server-callback`: exit 124 (timeout) → 0. The fix is one
condition in `parity/preload.mjs` (plus this note and the footprint
allowlist). No `src/` change, no new Buffer code, no `instanceof` tricks.

## Diagnosis (traced, not assumed)

The test asserts `upgradeHead instanceof Buffer` twice: once in the server
`'upgrade'` handler, once in the client `'upgrade'` handler. The server
handler's assertion threw, the throw was swallowed by shim dispatch, no 101
was ever written, and the client hung until the 30 s harness timeout — hence
exit 124 with empty output.

Probed facts (zz debug test, since deleted):

1. The upgrade head IS a genuine shim Buffer. `state.parser.takeRemainder()`
   in `src/_http_parser.js` returns `Buffer.from(rest)` where that file's
   `Buffer` is `./buffer.js` — and in-parser `out instanceof Buffer` is
   `true`, `out.constructor === Buffer` is `true`.
2. The test's `Buffer` is the REAL Node Buffer for `PARITY_TARGET=http`.
   `globalThis.Buffer === process.getBuiltinModule('buffer').Buffer` is
   `true`. `upgradeHead instanceof <real Buffer>` is `false`, as it must
   be — the shim Buffer is a pure-JS class and is not the native class.
3. The two sides come from different loader paths, and that is the whole
   bug:
   - `parity/preload.mjs` installs the shim Buffer as `globalThis.Buffer`
     ONLY when `target === "buffer"` (line ~80). For `http` it never runs,
     so the global stays real.
   - `parity/hooks.mjs` redirects bare `buffer` imports ONLY for importers
     under `parity/node-test/parallel/`. `src/http.js`'s
     `import { Buffer } from "buffer"` (line 31) therefore resolves to the
     native module, while `src/_http_parser.js`'s relative
     `import { Buffer } from "./buffer.js"` resolves to the shim.
   - The `net` side does NOT have this problem: `net` is an extra redirect
     for the http target, so `socket instanceof net.Socket` already passes
     on both ends. Only `Buffer` was left split.
4. In a real deployment there is no split: the browser runtime installs the
   shim Buffer as the global (via `node_globals.js` at sandbox startup) and
   loads each bundle key once, so the test's assertion compares shim
   against shim and passes. The harness combination — shim http/net plus
   real global Buffer — exists nowhere else. The prior "project-level
   decision" framing (that passing needs the native class in the product)
   misread a harness artifact as a product gap.

## Fix (ponytail rung 1: reuse what exists)

`parity/preload.mjs`: extend the existing global-Buffer install condition
from `target === "buffer"` to `target === "buffer" || target === "http"`,
with a `ponytail:` comment naming the ceiling. That is the entire fix.
No product file changes; `src/buffer.js` itself is untouched.

Why this rung and not the others:

- Product-side conversion of the head to a real Buffer is impossible in a
  browser (no native class there) — and forbidden as native delegation.
- Faking `instanceof` (`Symbol.hasInstance`, patching the test's Buffer) is
  explicitly forbidden by the lane brief and would be a fake pass.
- Subclassing the real Buffer in product code is native delegation by
  another name, also forbidden.
- A narrower per-test carve-out (e.g. keying off `process.argv`) would be
  test-specific harness code — worse than a principled target-wide install
  that mirrors what the real deployment already does.

## Blast radius (measured, not asserted)

The install changes the global `Buffer` for every http-target test, so the
guard is the full 397 differential, not just the target. See the sweep
CSVs in the parity-sweep goal hidden files (`http-sweep-usc-branch.csv`,
`http-sweep-usc-base.csv`). Pre-existing failures that must NOT be
attributed to this lane: `test-http-upgrade-server` (exit 1 — the parallel
delivery-timing lane's target) and `test-http-upgrade-client2` (exit 124 —
the queued GET-write-flushing lane's target); both fail identically on the
pristine base.

## Verification (this lane)

- Target: 124 → 0 (re-run twice to rule out flakes — record here).
- Upgrade neighbors on the branch: upgrade-server2 0, upgrade-client 0,
  upgrade-agent 0, upgrade-binary 0, upgrade-advertise 0,
  upgrade-reconsume-stream 0; upgrade-server 1 and upgrade-client2 124 are
  the pre-existing failures above, identical on base.
- Full 397 differential branch vs pristine base `e78c870b`: (record totals
  here) — zero pass-to-fail regressions required to ship.
- Repo jest: (record here; host baseline is 3059 passed / 7 failed /
  1 skipped — version-skew artifacts, identical on pristine main).
- `tests/ondemand-require.test.js`: 29/29 with the allowlist set to this
  branch's exact non-dist file set.
- `node src/build-vfs.mjs`: exit 0. `dist/` restored, never committed.

## Deliberately left alone

- No `src/` change of any kind — the product was already correct.
- The `target === "buffer"` crypto wrap (`require('crypto')` returning
  polyfill Buffers) is NOT extended to http: out of scope, and no http
  test in the differential needed it.
- Other targets (`https`, `net`, ...) keep the real global Buffer. If their
  tests ever assert Buffer identity the same way, the same install extends
  to them — one condition each, measured by their own differentials.
- The duplicated comment block above the install in `preload.mjs`
  (lines ~67-78, the same paragraph twice) is pre-existing; left as is.
