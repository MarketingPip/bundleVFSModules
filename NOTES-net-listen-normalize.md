# NOTES — net listen normalize (lane N1-8)

Branch: `fix/net-listen-normalize`. Base: main `3199bb5d`. Targets:
`test-net-listen-invalid-port`, `test-net-server-listen-options`
(`PARITY_TARGET=net`). Flips claimed: **2** (both 1 → 0).

## Mechanism

### (a) `Server._connectionKey` — `src/net.js`, `_doListenTCP`

Node sets it in `setupListenHandle` (node-src `lib/net.js:2345`):
`addressType + ':' + address + ':' + port`, built from the REQUESTED port.
The shim never set it anywhere (0 hits). Fix: set it in `_doListenTCP`
next to `_bindAddress`, from the requested `port` param — so `listen(0)`
keys `'6::::0'`, not the allocated ephemeral port. This also covers the
`_adoptBoundSocket` path, which routes through `_doListenTCP` (key then
uses the bound port/address; Node would key `-1:null:-1` there — no test
asserts that, left as-is).

Once the key existed, the four `ERR_SOCKET_BAD_PORT` throws in
`test-net-listen-invalid-port` were reached and all fire correctly —
`validatePort` (`src/net.js:378`) was already correct for all four forms
incl. `-1>>>0`, as the triage predicted. No change needed there.

### (b) `_normalizeArgs` rewrite — `src/net.js`

Node `normalizeArgs` (node-src `lib/net.js:297`): a non-object `arg0` is a
port (or a pipe path), never an options object. The shim called
`validateObject(arg0)`, which threw `ERR_INVALID_ARG_TYPE` for
`undefined`/`null`/`false`, so `listen(undefined)` / `listen(null)` and
`shouldFailToListen(false)` never reached `listen()`'s own
defaulting/validation. Fix: mirror Node's three branches verbatim
(object → spread; pipe name → `{ path }`; else `{ port: arg0 }` + string
`args[1]` as host). No other `listen()` change was needed: the existing
`options.port === undefined && 'port' in options` / `=== null` → `port = 0`
defaulting and the two `ERR_INVALID_ARG_VALUE` throws (`must have the
property "port" or "path"` / `options is invalid`) already match Node, and
all `shouldFailToListen` cases in `test-net-server-listen-options` now pass
through them.

Deliberately NOT changed (other lanes' regions):

- `normalizedArgsSymbol` is still set only by `normalizeArgs()`, not by
  `_normalizeArgs()` — `test-net-normalize-args` (lane 6) still fails at
  its first assertion exactly as on base; lane 6 owns that fix.
- `connect(fn)` (callback-only connect) now normalizes to `{ port: fn }`
  instead of throwing `ERR_MISSING_ARGS` via the spread of an empty
  object. Real Node throws `ERR_INVALID_ARG_TYPE` for it via
  `lookupAndConnect`'s port type check — that guard is lane 6's
  (`connect-options-port`). No vendored net test calls `connect(cb)`.
- `connect(undefined)` / `connect(null)` now reach `errMissingArgs()`,
  matching real Node (`options.port === undefined && options.path == null`
  → `ERR_MISSING_ARGS`, node-src `:1544`); previously they threw
  `ERR_INVALID_ARG_TYPE` from `validateObject`. No vendored test asserts
  the old throw.

## Verification

- Both targets isolated on branch: 0 (each run 3× total: once + 2× re-run).
- Guards (all 0, base-passing): `connect-no-arg`,
  `listen-after-destroying-stdin`, `listen-close-server`, `listening`,
  `server-call-listen-multiple-times`, `server-close`,
  `server-listen-remove-callback`,
  `server-close-before-calling-lookup-callback`.
- Differential (fast-sweep `--target net --force`):
  - Base:
    `hidden_files/fast-sweep/net-n1-base-2026-11-14.csv`
    (156 rows: 87 pass / 61 fail / 8 timeout — load noise vs triage's
    87/65/4; both targets 1).
  - Branch:
    `hidden_files/fast-sweep/net-n1-branch-2026-11-14.csv`
    (see diff below; claimed changed lines only the 2 targets).
- `node --check src/net.js` clean.

## Differential (matched changed-value lines)

- Base: `hidden_files/fast-sweep/net-n1-base-2026-11-14.csv`
  (156 rows: 86 pass / 62 fail / 8 timeout).
- Branch: `hidden_files/fast-sweep/net-n1-branch-2026-11-14.csv`
  (156 rows: 88 pass / 60 fail / 8 timeout).
- Changed lines (sorted, deduped — the ONLY two):
  - `test-net-listen-invalid-port.js: 1 -> 0`
  - `test-net-server-listen-options.js: 1 -> 0`
- Zero regressions. Base-vs-triage differences are all load noise
  (`listen-exclusive-random-ports` 1 → 124,
  `listen-handle-in-cluster-2` 0 → 124, throttle 134 → 124,
  `write-fully-async-buffer` 137 → 124 — all spinner/timeout forms under
  heavy parallel load). Adjudicated isolated on the branch:
  `listen-handle-in-cluster-2` exit 0 (sweep 124 was a flake);
  `listen-exclusive-random-ports` exit 1 (still failing as in triage —
  lane 19's target, not this lane).

## PR

- PR #403 (`fix/net-listen-normalize` → `main`), opened on first-push
  head `b794b607` (local `fd3a0d9d`).
- CI no-show on that head: 0 check runs after 19 waiter polls (~13 min)
  + direct API read (first waiter SIGTERMed by a runtime restart;
  direct check-runs read is the reliable signal).
- Unstick applied: rebased onto main `35bf2d43` (#399 + #402 merged
  meanwhile) as local `a7b8842f`. Only conflict was the footprint
  allowlist (resolved to this branch's own pair). Re-verified on the
  rebased tree: both targets 0, guards 0 (incl. the newly merged lanes'
  targets `buffersize`, `socket-connecting`, `connect-options-fd`,
  `socket-constructor`), footprint jest 29/29.
- **BLOCKED — force-push of the rebased head has failed 5× over ~30 min
  on transient GitHub API errors** (attempt 1: tree-create
  RemoteDisconnected ×3; attempt 2: ref-update RemoteDisconnected ×3;
  attempt 3: parent-GET RemoteDisconnected ×3 → false "Parent 35bf2d43
  not on GitHub"; attempt 4: tree-create 404; attempt 5: parent-GET
  RemoteDisconnected ×3). Direct `gh.py` GETs work in the same window
  (`/user` = MarketingPip; parent commit `35bf2d43` resolves), so auth
  and the parent are fine — the git-data API path is flapping.
  Remote branch still at `b794b607` (pre-rebase head, ls-remote
  verified). Retry when the flap clears:
  `PYTHONPATH=/opt/muse/skills/custom-connector-setup/bin python3
  ~/workspace/custom-connectors/custom.legacy-github/bin/git-push-api.py
  ~/workspace/worktrees/net-n1-listen-normalize fix/net-listen-normalize --force`
  then re-run the CI waiter on the new remote head SHA and merge on
  green (Parity success + build success on the code SHA).
