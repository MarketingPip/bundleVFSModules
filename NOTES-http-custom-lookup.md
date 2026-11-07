# Custom lookup (Lane 8) — working note

Targets:
- `test-http-request-lookup-error-catchable` (was exit 1)
- `test-http-client-req-error-dont-double-fire` (was exit 124)

## Root causes (all confirmed by probes, Node source first)

1. **`_invokeFactory` dropped `lookup`.** `src/http.js` passed only
   `{port, host}` to the request-level `createConnection` factory. Node's
   `Agent.createSocket` passes the FULL options object
   (`lib/_http_agent.js:463`), including `lookup`/`family`. The test's
   factory spreads opts into `net.createConnection`, so the custom lookup
   never ran and the shim's own DNS path failed the host with ENOTFOUND
   instead of ERR_IP_BLOCKED.
2. **`Socket.connect` discarded the resolved IP.** The lookup callback
   ignored `(ip, family)`, and `_doConnect` derived the address from
   `options.host` only, so a non-IP host hit `errNotFound` (ENOTFOUND)
   before the blockList check. Real Node's `lookupAndConnect` hands
   `internalConnect` the RESOLVED ip (`lib/net.js:1778` emitLookup), and
   the blockList check runs against it (`lib/net.js:1463`).
3. **Fetch started after a lookup failure.** The agent socket DID fail
   the lookup synchronously at construction (socket destroyed,
   `_lookupError` set), but by the time its `error` fired (nextTick via
   `emitErrorNT`), `_performRequest` had already set `_usingFetch = true`,
   so `socketErrorListener`'s fetch guard swallowed it — and the fetch
   to `something.invalid` never settles in this environment (hang → 124).
4. **Aborting the fetch does NOT fix the drain.** An aborted fetch leaves
   an idle undici connection to the egress proxy that holds the loop open
   forever — proven natively too (`/tmp/probe-fetch2.js`: native fetch +
   abort also hangs, exit 124). The only correct fix is to never start
   the fetch when the lookup already failed.

## Fixes

- `src/http.js` — `ClientRequest` threads `options.family` into
  `_agentOptions` (same pattern as localAddress/localPort).
- `src/http.js` — `_invokeFactory` now carries `lookup`, `family`,
  `localAddress`, `localPort` (only when defined — "forwarded only when
  present" rule; `test-http-createConnection` does not assert factory-arg
  shape).
- `src/net.js` — `Socket.connect` lookup callback captures
  `(err, ip, addressType)`; on error sets `this._lookupError` (flag for
  the http fetch-path guard) and fails the connect; on success builds
  `resolved = {address: ip, family}`. Stale `_lookupError` is cleared
  when a destroyed socket is revived for a new connect.
- `src/net.js` — `_doConnect(options, pipe, resolved)` uses
  `resolved.address`/`resolved.family` when provided, so the blockList
  check runs against the resolved IP.
- `src/http.js` — `socketErrorListener`: the `_usingFetch` guard is
  narrowed — it still forwards when `socket._lookupError` is set
  (custom-lookup failure is authoritative), and aborts the in-flight
  fetch controller first (best-effort; cannot reclaim an already-opened
  proxy connection — see cause 4).
- `src/http.js` — `_performRequest`: early return before the fetch
  commit when `this.socket && this.socket._lookupError` — never starts
  fetch after a lookup failure; the socket's own deferred 'error'
  reaches the request through `socketErrorListener` exactly once.

## Lookup-surface completion (net guards found failing on base)

The guard batch exposed 4 pre-existing net failures on the same lookup
surface; all are fixed here, in the same callback / connect path, all
grounded in Node source (`lib/net.js`, `lib/internal/errors.js`):

- `src/net.js` — the lookup callback now emits `'lookup'` on the
  socket for every outcome (`lib/net.js:1778` emitLookup; once per
  address in the `all` form, `lib/net.js:1815`). This flips
  `test-net-dns-custom-lookup` (its `check()` asserts the event) and
  is required for the `all` form, which the harness reaches
  (`dnsopts.all` arrives true — the test's lookups branch on it).
- `src/net.js` — the lookup result is validated (`lib/net.js:1788`):
  a non-string or non-IP result fails with `ERR_INVALID_IP_ADDRESS`
  (the previously-unused `errInvalidIpAddress` factory); a family
  other than 4/6 fails with `ERR_INVALID_ADDRESS_FAMILY` (new
  `errInvalidAddressFamily` factory — RangeError with host/port
  fields, `lib/internal/errors.js:1385`). The `all` form takes the
  first entry with a valid IP and family, else the first entry
  decides the error — invalid IP first, bad family second
  (`lookupAndConnectMultiple`, `lib/net.js:1811+`). Flips
  `test-net-dns-custom-lookup` (bad-IP block) and
  `test-net-options-lookup` (bad-family block).
- `src/net.js` — `connect()` throws synchronously when
  `options.lookup` is present but not a function
  (`errInvalidArgType("options.lookup", "function", ...)`; Node's
  `validateFunction` in `lookupAndConnect`; `null` counts as absent).
  Flips the first half of `test-net-options-lookup`.
- `src/net.js` — `_doConnect` emits `'lookup'` on the built-in path
  too: `(null, '127.0.0.1', 4, host)` for loopback names (Node looks
  `'localhost'` up like any hostname; IP literals skip lookup, so no
  emit there), and `(err, undefined, undefined, host)` on the
  no-DNS-resolver failure branch. Flips `test-net-dns-lookup` and
  `test-net-dns-error`.
- `src/net.js` — `_doConnect` looks the server up by the address it
  actually connects to (`serverKey(address, port)` as the first key),
  not by the hostname: a lookup-resolved `::1` server was unreachable
  before (the keys only ever named `127.0.0.1` for a `'localhost'`
  host), which the `ERR_INVALID_IP_ADDRESS` fix unmasked — the
  process previously crashed on the bad-IP assertion before
  `check(6)` ran. Unchanged for IP literals and loopback names
  (there `address` == host / `127.0.0.1`).

Net effect: 4 pre-existing net failures flip
(`test-net-dns-custom-lookup`, `test-net-options-lookup`,
`test-net-dns-error`, `test-net-dns-lookup`); net 81/156 → 85/156.

## Notes / scope limits

- `onSocket` already attaches `socketErrorListener` synchronously
  (Node's #48771 fix, `lib/_http_client.js:1142` — confirmed in source;
  the shim already matches, no change needed there).
- Native probe: test 1 passes under native Node (exit 0); test 2 fails
  natively in this env ("Mismatched lookupWithError function calls.
  Expected exactly 1, actual 0" — lookup never called, proxy intercept;
  matches the triage caveat, so the lane verifies with a controlled
  probe, not the test's real-Node run). Controlled probe
  (`/tmp/probe-l8-native.js`): error fires exactly once,
  uncaughtException exactly once, same error object — expected semantics
  confirmed.
- `test-http-client-req-error-dont-double-fire` showed one 124 in a
  single isolated re-run during verification (3/3 subsequent runs exit
  0); treated as load flake, not a regression — the differential and
  guard batch are the authority.

## Verification

- Both http targets 0x2 on the branch.
- Guards: agent/lookup/timeout families + #359/#360/#362–#367 flips,
  plus net guards (`test-net-dns-custom-lookup`,
  `test-net-options-lookup`, `test-net-blocklist`, `test-net-dns-error`,
  `test-net-dns-lookup`) — all 0 (see guard-batch.log; the first run
  showed the 4 net guards failing 1 on BOTH base and branch —
  pre-existing, not regressions — and they flip with the
  lookup-surface completion above).
- Differential: fast-sweep `http-sweep-cl-{base,branch}.csv` (see below).
- Repo tests: jest full run (local baseline 3059 passed / 7 known
  host-skew failures).
- Builds: `node src/build-vfs.mjs`, `node src/build-sandbox.mjs --check`,
  `node src/build-runtime.mjs --check`.

## Differential

- Base: origin/main `88dde84b` (PR #368 docs sync; no src changes since
  `4f663d64`, the lane's original base).
- Method note: the full 397-file fast sweep was started, but 4 sibling
  wave-2 lanes were sweeping concurrently (load avg 23–36 on 4 CPUs)
  and its phase 1 recorded 339/397 short-cap hits — noise, not signal.
  It was killed and replaced with the same runner's `--only-nonpass`
  mode against the trusted clean post-`#357` base CSV
  (`http-sweep-2026-11-06-post357.csv`, 362 pass): every test that can
  change is in the 35-file nonpass set, and the 33/33 guard batch +
  jest cover the passing-test surface. The `_doConnect` server-key
  change only alters server lookup for lookup-resolved addresses
  (IP literals and loopback names derive the identical key), so the
  regression blast radius is the lookup path itself.
- `http-sweep-cl-base.csv` vs `http-sweep-cl-branch.csv` (35 rows each,
  `--only-nonpass` post357): base 12 pass / 3 timeout / 20 fail /
  1×134 / 1×139; branch 14 pass / 2 timeout / 17 fail / 1×134 / 1×139.
  Exactly 2 changed lines, both toward pass, 0 regressions, 0 mode
  changes:
  - `test-http-request-lookup-error-catchable.js`: 1 → 0
  - `test-http-client-req-error-dont-double-fire.js`: 124 → 0
- Net differential (`net-sweep-cl-{base,branch}.csv`, targeted:
  75 nonpass in the `#356` branch CSV + 4 passing lookup-mentioning
  extras; base `88dde84b`, branch `fb78ea1d`): base 4 pass / 75
  nonpass; branch 10 pass. Exactly 7 changed lines, 6 toward pass,
  0 regressions:
  - `test-net-dns-custom-lookup.js`: 1 → 0
  - `test-net-options-lookup.js`: 1 → 0
  - `test-net-dns-error.js`: 1 → 0
  - `test-net-dns-lookup.js`: 1 → 0
  - `test-net-autoselectfamily-ipv4first.js`: 1 → 0 (bonus — the
    mocked lookup returns the `all`-form array; the shim previously
    ignored it and failed the non-IP host, now the first valid entry
    `127.0.0.1` wins; 0×3 isolated on branch, 1 on base)
  - `test-net-connect-options-ipv6.js`: 1 → 0 (bonus — same
    address-based server-lookup fix as `check(6)`: the `::1` server
    is now found; 0×3 isolated on branch, 1 on base)
  - `test-net-connect-memleak.js`: 1 → 124 in the sweep only — 1×3
    isolated on branch AND 1×2 isolated on base: a sweep load flake,
    live value unchanged, NOT a regression.
  Net effect: 6 flips; net 81/156 → 87/156.
