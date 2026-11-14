# NOTES-net-connect-args.md — net connect-arg validation / normalization (lane N1-6)

Branch: `fix/net-connect-args`. Base: main `ec874d19` (PR #411, lane 1)
after a second rebase (first rebase was onto `4b956bc6`, PR #399).
Targets (PARITY_TARGET=net): `test-net-connect-options-invalid`,
`test-net-connect-options-port`, `test-net-normalize-args`.
Result: all three flip 1 → 0 (isolated re-runs 2× each, all 0).

## (a) Per-key objectMode throws — `src/net.js` Socket ctor

Node `lib/net.js:554-568` throws one `ERR_INVALID_ARG_VALUE` per key,
naming the key and its value (`The property 'options.objectMode' is not
supported. Received true`). The shim threw a single error naming the whole
options object (`The argument 'options' objectMode is not supported.
Received [object Object]`). Ported Node's exact if/else-if shape:
`objectMode` first, then `readableObjectMode`/`writableObjectMode`
(readable wins when both are set, as in Node).

## (b) Host / port / hints validation — `src/net.js` Socket.prototype.connect, TCP branch

Node `lib/net.js:1657+` `lookupAndConnect` (TCP path only — a pipe connect
never reaches it): host first, then port type, then port range. Ported
into the shim's `else` (non-pipe) branch, next to the existing
`validatePort` call:

- Host: `options.host || "localhost"`, then
  `validateStringWithoutNullBytes` (`lib/internal/validators.js:171`):
  non-string host → `ERR_INVALID_ARG_TYPE`; host with a null byte →
  `ERR_INVALID_ARG_VALUE` (`The property 'options.host' must be a string
  without null bytes.`). Covers the test's host-array and host-null-byte
  blocks, which were unproven in triage.
- Port type guard before `validatePort`: `port !== undefined` and not
  number/string → `ERR_INVALID_ARG_TYPE` (`options.port`, number/string).
  `validatePort` alone reported all five type cases (true/false/[]/{}/
  null) as `ERR_SOCKET_BAD_PORT`. Range cases (`''`, `' '`, `'0x'`,
  `'-0x1'`, NaN, Infinity, -1, 65536) still throw `ERR_SOCKET_BAD_PORT`
  from the existing `validatePort`, unchanged.
- Hints: `dns.lookup` (`lib/dns.js:169-172`) validates `options.hints`
  with `validateNumber` then `validateHints`
  (`lib/internal/dns/utils.js:277-282`, mask
  `AI_ADDRCONFIG | AI_ALL | AI_V4MAPPED` = 32 | 16 | 8); anything outside
  the mask → `ERR_INVALID_ARG_VALUE` (`The argument 'hints' is invalid.
  Received N`). Validated only when a lookup would actually run (host is
  not an IP literal and no custom `lookup` is supplied) — an IP host or a
  custom lookup never reaches `dns.lookup` in Node, so neither validates
  hints there.

## (b2) Refused-connect error shape — `src/net.js` `_doConnect` no-server branch + `errConnRefused`

`errConnRefused` ports Node's `ExceptionWithHostPort`
(`lib/internal/errors.js:761+`) port rule: appended (and set on the
error) only when `port && port > 0`. Probed real Node v24.22.1: with
`family: 4` the refused error is the detailed
`connect ECONNREFUSED 127.0.0.1:59999` (and
`connect ECONNREFUSED 127.0.0.1` for port 0 — no `:port`, no `port`
field).

The no-server branch is detailed exactly when the dial went through
Node's single path, bare when it went through the DNS /
autoSelectFamily (multiple) path — probed matrix on real Node v24.22.1
(all refused, port 9 unless noted):
`connect(9)` / `{port:9}` / `{port:9,host:'localhost'}` /
`connect(9,'localhost')` → bare (message `""`, no syscall/address/port);
`{port:9,family:4}` / `{port:9,host:'localhost',family:4}` →
`connect ECONNREFUSED 127.0.0.1:9`; `{port:9,family:6}` →
`connect ECONNREFUSED ::1:9`; `{port:9,host:'127.0.0.1'}` → detailed.
That is Node `lib/net.js:1755` — the multiple path runs only when
`dnsopts.family !== 4 && !== 6`. So the branch condition is
`ipLiteral || resolved || multiIndex !== -1 || options.family === 4 ||
options.family === 6 ? detailed : bare` (the multi-path gate in the
shim's connect() already uses the same `options.family !== 4/6` check).
The two tests pinning the split: `test-net-connect-options-port`'s
`asyncFailToConnect(0)` (`{port: 0, family: 4}` → detailed) and
`tests/net.test.js` `connect(9)` (no family → bare).
`multiIndex` is still passed through to `_connectFailed` so a
happy-eyeballs attempt failure advances to the next address.
Ceiling: the multi-address `AggregateError` path itself is
unimplemented (happy-eyeballs lane). `errConnRefusedBare` is kept —
`_refusedError` (max-connections refusal) still uses it, pinned by
test-net-server-max-connections.

History: the first version of this lane made the branch always
detailed. That flipped the official target but broke CI's build job:
`tests/net.test.js` "refused TCP (no host) -> bare ECONNREFUSED"
expects the bare form (which matches real Node — the probe above).
The second rebase (onto `ec874d19`) initially took main's conditional
(`ipLiteral || resolved || multiIndex !== -1`) instead — which
regressed `connect-options-port` 1/1, because the `{port:0,family:4}`
dial has no `resolved` and `multiIndex === -1`. The family pin is the
missing arm. That rebase also auto-merged away the `ipLiteral` const
while keeping main's ternary that references it (a runtime
ReferenceError, caught by re-running the targets post-rebase).

## (c) `_normalizeArgs` symbol — `src/net.js` + `src/internals/net-symbols.js` + `parity/internal-net-adapter.mjs` + `parity/preload.mjs`

Node `lib/net.js:297-335` sets `arr[normalizedArgsSymbol] = true` on
every return path of `normalizeArgs`. The shim's `_normalizeArgs` never
set it (only the `normalizeArgs` wrapper did) — but the test calls
exported `net._normalizeArgs` directly. `_normalizeArgs` now marks both
return paths (empty-args and normal), via assignment like Node.

That alone is not enough: the test reads the symbol from
`require('internal/net')`, which falls through to native Node's
`internal/net` — a different symbol identity, so `deepStrictEqual`
against the test's expected array still fails. Same treatment as the
`internal/http` / `kOutHeaders` adapter (PR #366): the symbol moved from
a module-local const in `src/net.js` to shared
`src/internals/net-symbols.js`, new `parity/internal-net-adapter.mjs`
re-exports real Node's `internal/net` with the shim's symbol, and
`parity/preload.mjs` redirects `internal/net` → the adapter under
`PARITY_TARGET=net` only (one extra redirect, #232 precedent shape; no
other test requires `internal/net` under target net). No `hooks.mjs`
change: the test requires via CJS, and hooks cover ESM imports only.

## Differential (current: vs main `ec874d19`)

- Base CSV: `hidden_files/fast-sweep/net-base-n1b-2026-11-15.csv`
  (fresh sweep on main `ec874d19`: 122 pass / 30 fail / 4 timeout /
  1×134).
- Branch CSV:
  `hidden_files/fast-sweep/net-branch-n1c-2026-11-15.csv` (branch
  `865547dd`): 125 pass / 27 fail / 4 timeout / 0 crashes.
- Matched changed-value lines (sorted, deduped), base → branch:
  - `test-net-connect-options-invalid.js: 1 -> 0` (target)
  - `test-net-connect-options-port.js: 1 -> 0` (target)
  - `test-net-normalize-args.js: 1 -> 0` (target)
  - `test-net-throttle.js: 134 -> 124` (mode change only: the known
    pre-existing spinner, same spin under different load)
  - `test-net-write-fully-async-hex-string.js: 124 -> 137` (mode change
    only: the known pre-existing spinner — isolated on base it exits
    137 itself)
- Claimed flips from this lane: exactly 3 toward pass, 0 regressions.

## Differential (historical: pre-second-rebase branch vs triage base)

- Base CSV: `hidden_files/fast-sweep/net-sweep-2026-11-14.csv`
  (triage sweep on main `3199bb5d`: 87 pass / 65 fail / 4 timeout /
  1×134 / 1×137).
- Branch CSV:
  `hidden_files/fast-sweep/net-branch-n1-connect-args-2026-11-14.csv`
  (branch `d1701d39`, rebased onto main `4b956bc6`): 93 pass / 58 fail /
  5 timeout / 0 crashes.
- Matched changed-value lines (sorted, deduped), base → branch:
  - `test-net-connect-options-invalid.js: 1 -> 0` (target)
  - `test-net-connect-options-port.js: 1 -> 0` (target)
  - `test-net-normalize-args.js: 1 -> 0` (target)
  - `test-net-autoselectfamily-commandline-option.js: 1 -> 0`
    (side-effect of the then-present always-detailed refused-error fix
    — verified 0/0 on branch vs 1/1 on base, isolated; now flipped on
    main by the happy-eyeballs lane instead, so no longer claimed here)
  - `test-net-buffersize.js: 1 -> 0` (from the rebase onto `4b956bc6`,
    PR #399 lane 10 — not this lane)
  - `test-net-socket-connecting.js: 1 -> 0` (same, PR #399 — not this
    lane)
  - `test-net-throttle.js: 134 -> 124` (mode change only: the known
    pre-existing spinner, same spin under different load)
- Claimed flips from this lane at that point: 4 toward pass (3 targets
  + 1 side-effect), 0 regressions. The other 2 toward-pass rows were PR
  #399's, carried in by the rebase.

## Guards re-run (isolated, branch, post-second-rebase onto `ec874d19`)

- Targets 2× each: all 0 (after the (b2) restore; `connect-options-port`
  was 1/1 under main's conditional before the restore).
- Net guards, all 0: dns-lookup, dns-custom-lookup, options-lookup,
  dns-error, server-max-connections, localerror, buffersize,
  socket-connecting, autoselectfamily-commandline-option,
  autoselectfamily-default, access-byteswritten, bytes-stats,
  socket-byteswritten, bytes-written-large, connect-buffer,
  connect-buffer2.
- connect-reset, connect-abort-controller, connect-options-fd: 0 on
  this branch AND 0 on pure main `ec874d19` — sibling lanes' fixes
  already on main, not this lane's.
- `test-net-create-connection.js` does not exist (guard-name error in
  the first guard run, not a regression).
- Repo tests: `tests/ondemand-require.test.js` 29/29 (non-vacuous
  post-rebase footprint check). Build: `node src/build-vfs.mjs` 0,
  `node src/build-sandbox.mjs --check` 0, `node src/build-runtime.mjs
  --check` 0.
