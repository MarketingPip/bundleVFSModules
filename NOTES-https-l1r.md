# Wave 3 L1 (re-run on top of L0) — https harness http-redirect

Base: origin/main `44d1ed84` (L0, PR #386: https client errors EPROTO
against a plain-http virtual server). First L1 attempt was BLOCKED
(net-zero + a regression: test-https-connecting-to-http 0 -> 1, because
the shim https client delivered to a plain-http virtual server); full
analysis in
`~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/https-l1-blocked-2026-11-07.md`.
L0 fixed that blocker. This lane re-applies the preserved patch
(`hidden_files/https-l1.patch`, 31 insertions, unchanged) on top of L0.

## Change (harness only, NO src/ change)

- `parity/preload.mjs` + `parity/hooks.mjs`: `http` is now an extra
  redirect under `PARITY_TARGET=https` (#232 precedent — same shape as
  the `net`/`_http_outgoing`/`_http_agent` redirects under target `http`).
  Both the CJS require path (preload) and the ESM import path (hooks)
  return `parity/http-harness.mjs` for `http`.
- Why: under target `https` only `https` was redirected, so a test's
  `require("http")` returned native Node while the shim's https server
  builds shim `IncomingMessage` objects — two classes, same name,
  `instanceof` false (split-brain harness, triage headline finding).

## Differential (full 67-file fast-sweep, base vs branch, matched rows)

- Base (c6b3cc6d, after rebase onto PR #387; first measured on
  44d1ed84 as 31 pass / 6 timeout / 30 fail, then re-measured on the
  new base): 32 pass / 6 timeout / 29 fail.
- Branch: 33 pass / 5 timeout / 29 fail.
- Final rebase onto 652746d8 (PR #392, L8) + re-measure: base 37 pass
  / 6 timeout / 24 fail, branch 38 pass / 5 timeout / 24 fail —
  same single flip, 0 regressions. (Base movement 32 -> 37 is L8's
  4 flips + `strict` as a side effect.)
- Second rebase onto 4f98f142 (PR #385, L4) + re-measure: base 38
  pass / 6 timeout / 23 fail, branch 39 pass / 5 timeout / 23 fail —
  same single flip, 0 regressions. (Base movement 37 -> 38 is L4's
  `agent-getname` flip.)
- Exactly ONE changed line:
  - `test-https-server-options-incoming-message.js`: 124 -> 0 (FLIP;
    isolated 0x2 on branch, 124 isolated on base).
- Zero regressions:
  - `test-https-connecting-to-http.js`: 0 -> 0 (L0's EPROTO guard held;
    isolated 0 on branch, "Got expected error: write EPROTO:
    wrong version number").
  - `test-https-set-timeout-server.js`: 1 -> 1 (UNCHANGED — moves to
    joint L1+L12: sub-tests 5-7 use native tls.connect to the virtual
    port and need L12 raw TLS transport; do not chase here).
- All other 64 rows unchanged. Net: +1 flip.

## Verification

- Fast sweeps: `hidden_files/fast-sweep/https-l1r-base-2026-11-07.csv`
  (base), `https-l1r-branch-2026-11-07.csv` (branch), both 67 rows.
- `node --check` clean on both edited files.
- Repo tests: `tests/ondemand-require.test.js` footprint allowlist
  updated to this branch's exact file set (this note + the two
  harness files); footprint test passes locally before push.
