# Net happy eyeballs / autoSelectFamily — NOTES

Branch: `fix/net-happy-eyeballs`. Base: main `3199bb5d` (recorded net 87/156).
Lane: triage-net-2026-11-14 lane 2 (6 flips).

## Targets (all PARITY_TARGET=net)

- test-net-autoselectfamily-attempt-timeout-cli-option
- test-net-autoselectfamily-attempt-timeout-default-value
- test-net-autoselectfamily-commandline-option
- test-net-autoselectfamily-default
- test-net-socket-connect-invalid-autoselectfamily
- test-net-socket-connect-invalid-autoselectfamilyattempttimeout

All 6 pass isolated 2x on the branch. Bonus side-effect flip (same mechanism,
verified isolated 2x): test-net-autoselectfamily.js — see "autoselectfamily.js
note" below. Guard: test-net-autoselectfamily-ipv4first.js (already passing)
passes isolated 2x on the branch.

## Mechanism (triage lane 2, implemented)

1. **No `lookupAndConnectMultiple`.** `connect()` took only the first lookup
   address and died on its refusal. Ported from node-src lib/net.js:
   `:1755-1770` (gate), `:1811+` (lookupAndConnectMultiple incl. the
   alternating-family interleave `:1868-1880`), `:1410+`
   (internalConnectMultiple), `:2112+` (attempt-timeout handler),
   `:2071+` (afterConnectMultiple).
   - Gate: `autoSelectFamily && !pipe && family not 4/6 && no localAddress`.
   - Lookup runs with `{...options, all: true}` so the resolver returns every
     address (the mocked lookup keys off `options.all`).
   - `_happyEyeballsOrder()`: valid (IP, family 4/6) addresses only,
     deduplicated, first-valid family preferred, then interleaved.
   - One attempt at a time: a fast refusal advances immediately; a hung
     attempt advances when the attempt-timeout fires (emits
     `connectionAttemptTimeout`, records an ETIMEDOUT error — no
     `connectionAttemptFailed` for timeouts, matching Node).
   - `autoSelectFamilyAttemptedAddresses` is set (as `"ip:port"` strings) only
     for a multi run; a single valid address falls back to the single path
     and the property stays `undefined`.
   - All attempts failed → destroy with `new AggregateError(errors)` (Node's
     NodeAggregateError shape as the tests observe it: constructor name
     `AggregateError`, `.errors` per attempt).
   - Attempt outcomes funnel through `_connectFailed(err, multiIndex)`; the
     index guards stale outcomes (an attempt the timeout already abandoned)
     and the queueAccept drain skips stale accepts (Node closes the
     timed-out handle instead of emitting `connect` for it).
   - Per-attempt refusal errors are the detailed `connect ECONNREFUSED
     <ip>:<port>` form (Node's createConnectionError), both in `_doConnect`'s
     no-server branch and in `_acceptConnection`'s closed-server branch.
2. **Defaults never consulted / CLI flags never read.** `src/net.js` now
   seeds `defaultAutoSelectFamily` / `defaultAutoSelectFamilyAttemptTimeout`
   from `process.execArgv` at module load (`--network-family-autoselection` /
   `--no-network-family-autoselection`,
   `--network-family-autoselection-attempt-timeout=<ms>`, node-src `:159-160`),
   same shape as http.js's `--insecure-http-parser` flag. `connect()` falls
   back to the module defaults when the options are unset.
3. **Validation (node-src `:1693-1705`).** `connect()` validates
   `autoSelectFamily` with validateBoolean (`ERR_INVALID_ARG_TYPE`) and
   `autoSelectFamilyAttemptTimeout` with validateInt32 min 1 (`ERR_OUT_OF_RANGE`,
   values < 10 clamped to 10), synchronously, in Node's order (after the port
   check). `setDefaultAutoSelectFamilyAttemptTimeout` already did this.
4. **Harness bug (preload).** `parity/preload.mjs` redirected `require('net')`
   only for parents under testsDir (`parallel/`), but `common/index.js` lives
   in `common/` — its ×10 mutation of the attempt-timeout default landed on
   native net while the test read the shim's untouched 250 (probe-proven in
   triage). Added the fs-target precedent (`isFsHelper`): `isNetHelper` gates
   exactly `common/index.js` for target `net`. common/index.js uses net for
   nothing else at load.
5. **Single-path refusal shape (found while fixing the lane).**
   A lookup-resolved single address also gets the detailed refusal: Node's
   lookupAndConnect hands internalConnect the resolved IP, whose refusal is
   detailed — the disabled-family scenarios expect
   `connect ECONNREFUSED ::1:<port>`, not the bare form. `_doConnect`'s
   no-server branch now uses the detailed form when `resolved` is set.
   (The `localhost` name path still yields the bare form — Node would resolve
   it via DNS and give the detailed form too; unproven, out of lane scope,
   left as a known leftover.)

## Differential

- Base CSV: `hidden_files/fast-sweep/net-n1-eyeballs-base-2026-11-14.csv`
  (fresh `--target net --force` run on the triage worktree @ `3199bb5d`).
  87 pass — matches the triage CSV exactly except the two known spinner
  code variations (throttle 134→124, write-fully-async-buffer 137→124).
- Branch CSV: `hidden_files/fast-sweep/net-n1-eyeballs-branch-2026-11-14.csv`
  (fresh run on this branch, re-run after the blocklist fix below).
- Matched changed-value lines (sorted, deduped), base → branch:
  - test-net-autoselectfamily-attempt-timeout-cli-option.js: 1 → 0
  - test-net-autoselectfamily-attempt-timeout-default-value.js: 1 → 0
  - test-net-autoselectfamily-commandline-option.js: 1 → 0
  - test-net-autoselectfamily-default.js: 1 → 0
  - test-net-autoselectfamily.js: 1 → 0 (bonus side-effect flip, see below)
  - test-net-socket-connect-invalid-autoselectfamily.js: 1 → 0
  - test-net-socket-connect-invalid-autoselectfamilyattempttimeout.js: 1 → 0
  - test-net-blocklist.js: 0 → 1 in the first branch sweep — REAL regression,
    fixed (see below); 0 in the re-run sweep.
- Net count on the branch: 87 + 7 = 94/156 (6 lane targets + the
  autoselectfamily.js bonus). 0 regressions in the final differential.
  The only other changed line is test-net-write-fully-async-buffer.js
  124 → 137 — the known pre-existing spinner (same spin, different kill
  code under load; triage records it as 137 sweep / 124 isolated).

## Regression found in the differential and fixed

- **test-net-blocklist.js 0 → 1 (first branch sweep, reproduced 3/3 isolated
  on branch, 0/3 on base).** Cause: the multi driver's all-fail path used a
  bare `new AggregateError(errors)`; the test's multi-address blocked case
  expects `err.code === 'ERR_IP_BLOCKED'`. Root cause per node-src
  lib/internal/errors.js:199-203: Node's NodeAggregateError sets
  `this.code = errors[0]?.code`. Fix: set `aggregate.code = errors[0]?.code`
  (and the `constructor` getter returning AggregateError keeps the
  all-fail `constructor.name` check true). Verified: blocklist 0 ×3 isolated
  after the fix, autoselectfamily.js / -default / -commandline-option still 0.

## Guards re-run (isolated, branch, 2x each unless noted)

- The 6 targets + test-net-autoselectfamily.js + test-net-autoselectfamily-ipv4first.js: 0, 0.
- Full net sweep differential above (156 tests) — adjudication below.

## autoselectfamily.js note

Triage marks test-net-autoselectfamily.js NO-FIX (environmental): real Node
fails it in this VM because the sandbox network lets the first external-IPv6
attempt "succeed" spuriously (native attempted only 1 of 6 addresses). The
shim's virtual network refuses every external address fast, so all 6 are
attempted in the interleaved order and IPv4 is reached — the test passes
under the shim. This is a side-effect flip of the multi driver, not a lane
target: the triage NO-FIX verdict (about real Node in this VM) still stands
for the native side, and the flip is reported as a bonus, not a triage
correction.

## Leftovers (not queued as lanes)

- `localhost` refusal is still the bare ECONNREFUSED form (see item 5 above);
  real Node resolves localhost via DNS and reports the detailed form.
- A destroyed mid-multi socket keeps a stale `_autoSelectCtx` until the next
  `connect()` (which clears it); the attempt timer is unref'd and its
  callback guards on destroyed/connecting, so nothing leaks into the loop.
- Attempt-timeout staleness guards cover the only observable race (an
  attempt settling after its timeout fired); virtual attempts settle in
  ~1-2 macrotasks, far under the 10 ms minimum timeout, so the race is
  unobservable in practice.
- ponytail: ceiling — the multi driver covers the virtual transport only.
  A real-DNS host (no custom lookup) still fails ENOTFOUND in `_doConnect`
  before any eyeballing can happen; there is no DNS resolver in the shim.
