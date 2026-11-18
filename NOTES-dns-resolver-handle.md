# NOTES-dns-resolver-handle.md — D1: Resolver `_handle` (+1) + D2 + resolveAny comment

## What

`src/dns.js` only (+34/−6). Three changes:

1. **D1 (the flip): `Resolver` gets a JS `_handle` object.** Node's
   `lib/internal/dns/utils.js` `[kInitializeHandle]` sets
   `this._handle = new ChannelWrap(...)`, and `getServers()` reads
   `this._handle.getServers() || []`. The shim had no `_handle` at all
   (`src/dns.js:1364` "minus the C++ channel handle"), so
   `test-dns-get-server.js:10` threw
   `TypeError: Cannot set properties of undefined` when the test did
   `resolver._handle.getServers = common.mustCall()`. The constructor now
   creates `this._handle = { getServers: () => this._servers.slice(),
   setServers: (servers) => this.setServers(servers) }`, and `getServers()`
   returns `this._handle.getServers() || []`. The default path returns
   exactly what it did before (`this._servers.slice()`, non-empty); after
   the test replaces `_handle.getServers` with a mustCall returning
   `undefined`, `getServers()` returns `[]` (length 0), as the test
   expects. `PromisesResolver extends Resolver`, so both APIs are covered.
   `_handle.setServers` delegates to `Resolver.setServers` (validation +
   pending-query throw preserved).
2. **D2 (ride-along, 0 flips, real bug): falsy hostname + `all: true`.**
   `lookupImpl` step 0 returned `[rec]` for `all: true`; native returns
   `[]` for every falsy hostname (`false`, `''`, `null`, `undefined` —
   probe-verified against real Node). Now `options.all ? [] : rec`. The
   non-`all` path is unchanged (`{ address: null, family: 4 }`).
3. **resolveAny comment correction (0 flips, comment only).** The header
   (:29-30) and the module-level `resolve()` (:1323) both claimed
   "resolveAny is ENOTIMP in real Node too (c-ares deprecated ANY
   queries)". False for v24.20.0: Node's
   `lib/internal/dns/utils.js:311` defines
   `Resolver.prototype.resolveAny = resolver('queryAny')` — a real query
   (native runs here attempt it, `queryAny ETIMEOUT`). The shim keeps
   returning ENOTIMP because that is the honest DoH answer: public DoH
   resolvers refuse ANY per RFC 8482 (Cloudflare answers NOTIMP, Google
   answers NOERROR with a single HINFO record instead of real records —
   triage probe-proven). Behavior unchanged.

## Verification (branch head, worktree `dns-d1-resolver-handle`)

- Flip 2× isolated, exit 0: `test-dns-get-server.js` [0,0].
- D2 probe under the shim matches native exactly: `lookup(false,
  {all:true})` → `[]`; `lookup('', {all:true})` → `[]`;
  `lookup(false)` → `null`, family 4; `lookup('')` → `null`, family 4.
- Guards, all exit 0 (the 10 sweep passes + triage-named guards):
  test-dns-channel-timeout, test-dns-lookup-promises-options-deprecated,
  test-dns-lookupService-promises, test-dns-memory-error,
  test-dns-negative-zero, test-dns-promises-exists,
  test-dns-resolvens-typeerror, test-dns-setlocaladdress,
  test-dns-setserver-when-querying, test-dns-setservers-type-check.
- `test-dns-lookup.js` still exit 1 (NO-FIX, stub part only) — but the
  failure moved forward as expected: on base it fails at test:193 (the
  D2 case: actual `[{address:null,family:4}]`, expected `[]`); on the
  branch it passes :193 and fails later at the stub assertion
  (`ECONNREFUSED` vs expected `ENOMEM` — the test stubs getaddrinfo to
  throw ENOMEM; the shim never calls the stub). Same exit, later failure,
  still stub-dependent.
- Full dns differential vs base `e0942bb7`: exactly 1 flip (get-server),
  0 regressions (`hidden_files/fast-sweep/dns-d1-branch-2026-11-18.csv`).
- Footprint test green (29/29). `node --check src/dns.js` clean.

## Ship

- PR #481 / merge SHA f3077d4d (squash-merged 2026-11-18)
