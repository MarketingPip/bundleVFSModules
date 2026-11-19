# dns — Node 26 re-target triage (DOCS ONLY)

Worktree: `~/workspace/worktrees/node26-triage-dns` (detached at `3c091022`,
base for the drift detector). No `src/` changes, no shim code, no
`package.json` edits. Node 26 binary verified first:
`~/workspace/local/node-26/bin/node --version` → `v26.13.1`.
Host `node` (baseline runner) is `v24.22.1`.

## Score

| | count |
|---|---:|
| Node 26 dns tests (baseline) | 32 total: 10 pass / 19 fail / 3 timeout |
| Non-pass | 22 = 15 shim-gap + 7 fails-natively + 0 native-timeout |
| v24.20.0 (2026-11-18 triage) | 10 / 31 |
| **Ceiling after the one lane below** | **12 / 32** |

Net vs v24: same 10 passes, but the composition changed by exactly one swap:
`test-dns-get-server` now passes (v24 D1 fix landed as #481, see below) and
`test-dns-setlocaladdress` now fails (new NUL-byte section in the Node 26
test). The other 9 passes are identical in both trees.

Gap list: `hidden_files/node26-triage/gaps-dns.json` (22 rows, taken as given).
Baseline: `parity/drift/node26-baseline.jsonc` (`dns`: 32 total, 10/19/3 —
matches the gap file exactly). Oracle: `run-oracle.mjs` — native runs use the
Node 26 binary with cwd `node26Src`, flags parsed from each test's
`// Flags:` header, 30 s timeout.

Isolated re-run invocation (from `parity/drift/run-baseline.mjs`, `runOne`):
`PARITY_TARGET=dns timeout 30 node --import <worktree>/parity/preload.mjs
parity/node-test/parallel/<test>` — node_modules symlinked from vite7
(preflight requirement: `memfs` resolvable).

## Families (15 gaps)

| Family | Tests | Class | New in 26? |
|---|---:|---|---|
| A. STUB — test patches a native cares binding the shim never calls | 8 | NO-FIX | No (1 test has a new-in-26 sub-section, 0 flips) |
| B. UDP — test binds a local UDP DNS server; no UDP sockets in a browser | 4 | NO-FIX | No |
| C. PERF — internal-only `dns` performance entries | 1 | NO-FIX | No |
| D. NUL-VALIDATION — Node 26 rejects NUL-containing names/addresses | 2 | **validation gap — LANE, est. +2** | **Yes, both** |

### A. STUB (8) — NO-FIX, pre-existing

The test monkey-patches a native cares binding via `internal/test/binding`
and asserts the stub's canned outputs. The shim resolves via DoH and never
calls those bindings. V24 reason unchanged; test files unchanged in meaning
(normalized diff v24-vendored vs Node 26: identical or trailing-comma-only).

- `test-dns-lookup.js` (harness 1 / native 0) — stubs `cares.getaddrinfo =
  () => UV_ENOMEM`; expects ENOMEM. First failure in the Node 26 run is now
  the falsy-hostname assert at test:177 (see finding F1 below), but the
  remainder is all stub-dependent, so still 0 flips.
- `test-dns-lookup-promises.js` (1 / 0) — dynamic `getaddrinfo` stub with
  canned addresses.
- `test-dns-lookupService.js` (1 / 0) — stubs `cares.getnameinfo =
  () => UV_ENOENT`.
- `test-dns-resolve-promises.js` (1 / 0) — stubs
  `cares.ChannelWrap.prototype.queryA = () => UV_EPERM`.
- `test-dns-default-order-ipv4.js` (1 / 0) — wraps `getaddrinfo`, asserts
  order arg `DNS_ORDER_IPV4_FIRST` and call count exactly 1.
- `test-dns-default-order-ipv6.js` (1 / 0) — same, `DNS_ORDER_IPV6_FIRST`.
- `test-dns-default-order-verbatim.js` (1 / 0) — same, `DNS_ORDER_VERBATIM`.
- `test-dns-set-default-order.js` (1 / 0) — same across
  `setDefaultResultOrder` × callback/promises × `{}`; also the transport
  artifact from v24 (stub observes the shim's own DoH fetches resolving
  `cloudflare-dns.com` through the stubbed binding) is unchanged.

### B. UDP (4) — NO-FIX, pre-existing

The test binds a local UDP DNS server (`dgram`) and points the resolver at
`127.0.0.1:<port>` with canned answers. The shim records IP servers verbatim
but has no UDP transport; DoH fallback queries the public upstreams instead
and the local server never receives a packet. V24 reason unchanged; test
files trailing-comma-only diffs.

- `test-dns-cancel-reverse-lookup.js` (harness 124 / native 0) — hang:
  `resolver.cancel()` is only called from `server.on("message")`, never fires.
- `test-dns-channel-cancel.js` (124 / 0) — hang, same shape (11 queries).
- `test-dns-channel-cancel-promise.js` (1 / 0) — first query returns DoH
  NXDOMAIN instead of ECANCELLED.
- `test-dns-resolveany-bad-ancount.js` (1 / 0) — local server replies with a
  malformed packet (ancount overwritten to 2); DoH upstream returns a
  well-formed response, so no error is produced.

### C. PERF (1) — NO-FIX, pre-existing

- `test-dns-perf_hooks.js` (1 / 0) — observes `PerformanceObserver({type:
  "dns"})`; expects 4 entries. Node's `lib/dns.js` emits them via
  `internal/perf/observe`; no public API can create entryType `'dns'`
  entries. Test file trailing-comma-only diff. Unrepresentable from a shim.

### D. NUL-VALIDATION (2) — NEW in 26, lane candidate, est. +2

Both come from the October 2026 security fix (changelog cross-check:
"dns.resolve truncating names at a NUL byte fixed (22/24/26)"): c-ares
receives the name as a C string, so everything after the first NUL byte was
silently dropped. Node 26 validates with
`validateStringWithoutNullBytes(name, 'name')` —
`lib/internal/dns/callback_resolver.js:62` (callback API) and
`lib/internal/dns/promises.js` `resolver()` (promises API) — sync throw
`ERR_INVALID_ARG_VALUE`, message `The argument 'name' must be a string
without null bytes. Received …`. The shim only does `validateString`
(type-only) on these paths, so NUL names flow through to DoH.

- `test-dns-resolve-null-bytes.js` (1 / 0) — **NEW test file in Node 26**
  (absent from the v24 vendored tree; 32nd test). Every `resolve*` method
  plus `resolve(name, rrtype)` plus `reverse`, across callback API (`dns` +
  `new Resolver()`) and promises API (`dnsPromises` + `new
  PromisesResolver()`), must synchronously throw the NUL error for
  `'example.com\u0000.trusted.corp'` / `'127.0.0.1\u0000.trusted.corp'`.
  Isolated re-run shim [1,1]; first failure at test:58 (first assert,
  `resolve` on the default resolver) with `actual: undefined` — no sync
  throw. Probe (below): callback `resolve` → no sync throw, async
  `ENOTFOUND` (`queryA ENOTFOUND example.com\0.trusted.corp`); promises
  `resolve4` / `PromisesResolver.resolve4` → no sync throw, rejected
  `ENOTFOUND`; callback `resolveAny` → no sync throw, callback `ENOTIMP`;
  callback `reverse` → sync throw but code `EINVAL`
  (`getHostByAddr EINVAL …`), wrong code and message; promises `reverse` →
  no sync throw, rejected `EINVAL`.
- `test-dns-setlocaladdress.js` (1 / 0) — pre-existing test, **new NUL
  section in Node 26** (test:40-60): `setLocalAddress('127.0.0.1\0junk')`
  must throw `ERR_INVALID_ARG_VALUE` TypeError with message
  `/^The argument 'ipv4' must be a string without null bytes\. Received /`
  (same for `'ipv6'`). Everything before it is quote-style-only. Isolated
  re-run shim [1,1]; fails at test:46, the first NUL assert — all
  pre-existing asserts pass. The shim throws the right code but the wrong
  message: `TypeError: Invalid IP address.` from `src/dns.js:1498`
  (`setLocalAddress` does `validateString(ipv4, "ipv4")` then an `isIP`
  check, `src/dns.js:1492-1520`; NUL is never checked first). Probe:
  ipv6 NUL → same wrong-message throw. Node 26:
  `lib/internal/dns/utils.js:182,185`
  (`validateStringWithoutNullBytes(ipv4, 'ipv4')` /
  `(ipv6, 'ipv6')`).

## Lane candidates

### L1 — NUL validation (est. +2, high confidence)

Flip: `test-dns-resolve-null-bytes.js`, `test-dns-setlocaladdress.js`.
Scope: `src/dns.js` (+ `src/dns/promises.js` reverse, see traps) — pure
validation, no transport work.

Design (from the Node 26 sources above; the shim already has the exact
message pattern for `lookup` at `src/dns.js:986-998` — reuse it):

1. Shared helper, e.g. `validateNameWithoutNullBytes(value)` throwing
   `TypeError` code `ERR_INVALID_ARG_VALUE`, message
   `The argument 'name' must be a string without null bytes. Received '…'`
   (with the `\x`-escaping the lookup path already does).
2. Call it wherever the shim currently does `validateString(hostname,
   "name")` on a resolve path, before any async work:
   - module-level `normalizeResolveArgs` (`src/dns.js:1239`) and
     `makeResolveFn` (`src/dns.js:1261`, covers resolve4/6/Cname/Mx/Ns/Txt/
     Srv/Soa/Ptr/Naptr/Caa/Tlsa) and `resolveAny` (`src/dns.js:1342`);
   - `Resolver._resolveWith` (`src/dns.js:1541`), `Resolver.resolve`
     (`src/dns.js:1610`), `Resolver.resolveAny` (`src/dns.js:1649`), and
     `Resolver.reverse` (`src/dns.js:1657` — currently `validateString(ip,
     "ip")` + EINVAL; the NUL check must run first and use argument name
     `'name'`, matching Node's `resolver('getHostByAddr')` helper).
   - `Resolver.setLocalAddress` (`src/dns.js:1492`) — NUL check before the
     `isIP` check, with argument names `'ipv4'` / `'ipv6'` and messages
     `The argument 'ipv4' must be a string without null bytes…` /
     `… 'ipv6' …` (the test regexes pin the argument name per position).
3. Traps (probe-proven, must be handled or the promises half stays red):
   - `PromisesResolver._asPromise` (`src/dns.js`) invokes the method
     **inside** the Promise executor, so a sync throw becomes a rejection —
     but the test does `assert.throws(() => resolver[method](name), …)` on
     `new dnsPromises.Resolver()`. Validate before entering the executor
     (like `src/dns/promises.js` `asPromise`, which calls the callback fn
     outside the executor precisely so validation throws synchronously).
   - `src/dns/promises.js` `reverse` catches sync throws for string IPs
     and converts them to rejections — correct for the EINVAL (non-IP)
     case, wrong for NUL validation, which real Node throws synchronously
     (`internal/dns/promises.js` `resolver('getHostByAddr')` validates
     before `createResolverPromise`). Only the EINVAL throw may be
     converted; validation throws must propagate.
   - `resolveAny` must validate before returning its `ENOTIMP` answer
     (probe: NUL name currently yields callback `ENOTIMP`, no throw).
4. Guards: the 10 passing tests, especially `test-dns-setservers-type-check`
   (module-level validation, must not regress) and
   `test-dns-lookupService-promises` (live DoH reverse lookup). Verify each
   flip 2× isolated.

### No other lane

- Falsy-hostname lookup (finding F1) is 0 flips — not lanned (see below).
- The 13 STUB/UDP/PERF gaps have no lane: see NO-FIX list.

## NO-FIX list (13) — one-line reasons

1. `test-dns-lookup.js` — stub: needs the patched `cares.getaddrinfo`
   to return UV_ENOMEM; shim never calls it (DoH instead).
2. `test-dns-lookup-promises.js` — stub: needs canned `getaddrinfo`
   addresses back; shim returns real DoH answers.
3. `test-dns-lookupService.js` — stub: needs patched `cares.getnameinfo`
   to throw ENOENT; shim resolves via reverse-DoH.
4. `test-dns-resolve-promises.js` — stub: needs patched
   `ChannelWrap.prototype.queryA` to return UV_EPERM; shim returns a real
   DoH answer.
5. `test-dns-default-order-ipv4.js` — stub: asserts the `getaddrinfo`
   order arg and call count; shim never calls it.
6. `test-dns-default-order-ipv6.js` — stub: same, ipv6-first.
7. `test-dns-default-order-verbatim.js` — stub: same, verbatim.
8. `test-dns-set-default-order.js` — stub: same across orders/APIs; the
   count anomaly is the transport's own resolutions, not lookup's.
9. `test-dns-cancel-reverse-lookup.js` — UDP: local server never receives
   a packet, so `cancel()` is never triggered; hangs.
10. `test-dns-channel-cancel.js` — UDP: same hang, 11 queries.
11. `test-dns-channel-cancel-promise.js` — UDP: DoH NXDOMAIN instead of
    ECANCELLED; no UDP packet ever arrives.
12. `test-dns-resolveany-bad-ancount.js` — UDP: needs a malformed local
    UDP reply; DoH upstream returns well-formed responses.
13. `test-dns-perf_hooks.js` — internal perf: needs
    `internal/perf/observe` `dns` entries; no public API can create them.

## Fails-natively (7) — NOT shim gaps, listed separately

All UDP-family, all fail on real Node 26.13.1 too (oracle `nativeExit: 1`),
all pre-existing v24 native failures (same set, same cause: the sandbox
blocks UDP sends — `dgram` send to loopback → `EPERM` — so c-ares never
gets a reply; the v24 triage probe-proved this, and the NO-FIX stands
independent of it because a browser has no UDP socket API at all):

- `test-dns-multi-channel.js` (harness 124 / native 1) — two local UDP
  servers, canned A records; neither receives a packet.
- `test-dns-resolveany.js` (1 / 1) — canned mixed record set, deep-equal
  against local data.
- `test-dns-resolveany-ttl-overflow.js` (1 / 1) — 257 canned A records.
- `test-dns-resolver-max-timeout.js` (1 / 1) — canned record + retry-timing
  measurement (only diff vs v24: a trailing comma after `Infinity` in the
  maxTimeout list — trivial).
- `test-dns-resolvesrv.js` (1 / 1) — canned SRV records.
- `test-dns-resolvesrv-econnrefused.js` (1 / 1) — canned SRV + dead-server
  ECONNREFUSED half.
- `test-dns.js` (1 / 1) — canned resolveAny/resolve4/resolve6/resolveSoa.

## New-in-26 vs pre-existing split

- **New in 26 (2 gaps):** `test-dns-resolve-null-bytes.js` (new file),
  `test-dns-setlocaladdress.js` (new NUL section). Both are L1.
- **Pre-existing (13 gaps):** the 8 STUB + 4 UDP + 1 PERF above. All
  unchanged in meaning since v24 (normalized diffs: identical or
  trailing-comma-only), same v24 reasons.
- **Already banked since v24 (not a gap):** `test-dns-get-server.js`
  passes in the Node 26 baseline (isolated re-run shim [0,0], 2×). The v24
  D1 fix landed as `f3077d4d fix(dns): Resolver _handle + falsy-hostname
  all:true shape (D1/D2) (#481)` — `src/dns.js:1465-1483` now gives
  `Resolver` a JS `_handle` (`getServers`/`setServers` delegating to the
  resolver's own state) and `getServers()` returns
  `this._handle.getServers() || []`.
- **New-in-26 changes inside fails-natively `test-dns.js` (no lane — the
  test fails natively on UDP regardless):** out-of-range ports in
  `setServers` must throw RangeError `ERR_SOCKET_BAD_PORT` (test:94-108,
  ports `2**16, 2**32, 2**64`); the falsy-lookup block now expects
  `ERR_INVALID_ARG_VALUE` rejections/throws instead of
  `{address: null, family: 4}` (test:213-224); a promises-side
  `lookupService(Buffer)` assert was added (test:398-413).

## Named non-lane findings (probe-proven, 0 flips each)

- **F1 — falsy-hostname lookup rejection: the #481 D2 shape is now stale.**
  Node 25.0.0 removed falsy hostnames in `dns.lookup()` (changelog
  cross-check row 28). Node 26 `lib/dns.js:203-205`:
  `if (!hostname) throw new ERR_INVALID_ARG_VALUE('hostname', hostname,
  'must be a non-empty string')` (callback API, sync throw), and
  `lib/internal/dns/promises.js` `createLookupPromise` rejects with the
  same error. The Node 26 `test-dns-lookup.js` now asserts exactly that
  (`assert.rejects(dnsPromises.lookup(false, {hints:0, family:0, all:true}),
  {code:'ERR_INVALID_ARG_VALUE'})` at test:154-159 and the callback
  `assert.throws` at test:177-182); v24 expected `[]` / mustSucceed.
  The shim still does the v24 shape: `lookupImpl` step 0
  (`src/dns.js:861-864`) returns `[]` / `{address:null, family:4}` and
  `normalizeLookupArgs` (`src/dns.js:967`, falsy branch :978-985) emits
  DEP0118 and coerces to `null`. Probe (under preload, `PARITY_TARGET=dns`): callback
  `lookup(false, {all:true})` → no sync throw, callback `res=[]`;
  promises `lookup(false, {all:true})` → resolved `[]` (expected
  rejection). Isolated re-run of the Node 26 test: shim [1,1] both with
  and without `--expose-internals`; first failure at test:177, "Missing
  expected exception". Fixing this flips 0 tests — the remainder of
  `test-dns-lookup.js` is stub-dependent (ENOMEM) and `test-dns.js` fails
  natively — but the fix belongs with L1 (same validation area) or as a
  standalone micro-change; do not promise a flip for it. Note the shim's
  NUL check for lookup (`src/dns.js:986-998`,
  `validateStringWithoutNullBytes`-equivalent message) is already correct
  and matches Node 26 `lib/dns.js:151`.
- **F2 — `resolveAny` header comment is still wrong (v24 note, unchanged).**
  `src/dns.js` claims `resolveAny()` is ENOTIMP in real Node too; false —
  Node 26 defines it via `resolver('queryAny')`. The shim's ENOTIMP
  outcome is still the honest DoH answer (public DoH resolvers refuse ANY
  per RFC 8482). Correct the comment whenever resolveAny is next touched;
  do not lane it.
- **F3 — the `test-dns.js` setServers port validation is unprobed.**
  The shim's `validateServerList` (`src/dns.js:413`) does not obviously
  throw `ERR_SOCKET_BAD_PORT` for out-of-range ports. Unprobed because the
  test fails natively anyway; if `test-dns.js` ever becomes flippable for
  other reasons, re-check this block first.

## Baseline corrections

**None for dns.** Verified, not assumed:

- Baseline counts reconcile: 32 total = 10 pass + 19 fail + 3 timeout;
  22 non-pass = 15 gap + 7 fails-natively, matching `gaps-dns.json`.
- The 7 fails-natively are exactly the v24 native-failure set (same
  files, same UDP cause).
- Flags check: `run-baseline.mjs` does not pass per-test `// Flags:`
  (e.g. `--expose-internals` on the 8 stub-family tests). Re-ran Node 26
  `test-dns-lookup.js` under the shim with and without
  `--expose-internals`: exit 1 both ways, same first failure (test:177).
  No misclassification — the stub verdict does not depend on the flag.
- `test-dns-multi-channel.js` is baseline `timeout` (124) but oracle
  `fails-natively` (native 1): correctly classified in the gap file, not
  a baseline error.

## Evidence

- Isolated re-runs (2× each, `PARITY_TARGET=dns`, 30 s, host node
  v24.22.1, Node 26 test files staged into the worktree then restored;
  worktree left clean): `test-dns-resolve-null-bytes.js` [1,1] (first
  failure test:58, `actual: undefined` vs expected NUL error);
  `test-dns-setlocaladdress.js` [1,1] (first failure test:46,
  `actual: TypeError: Invalid IP address.` vs expected NUL message);
  `test-dns-get-server.js` [0,0]; `test-dns-lookup.js` [1,1] with and
  without `--expose-internals` (first failure test:177).
- Native (real Node 26.13.1, cwd `~/workspace/local/node-26-src`):
  `test-dns-resolve-null-bytes.js` exit 0;
  `test-dns-setlocaladdress.js` exit 0.
- Direct shim probe (temp file under `parity/node-test/parallel/`,
  run under the preload, deleted after; full output in `/tmp` — the
  probe hit its own 20 s exit timer after printing all 16 result lines):
  callback resolve NUL → no sync throw, async ENOTFOUND; promises
  resolve4 / PromisesResolver resolve4 NUL → no sync throw, rejected
  ENOTFOUND; callback resolveAny NUL → no sync throw, callback ENOTIMP;
  callback reverse NUL → sync throw `EINVAL` (wrong code/message);
  promises reverse NUL → no sync throw, rejected `EINVAL`; callback
  lookup(false, {all:true}) → no sync throw, `res=[]` (+ DEP0118);
  promises lookup(false, {all:true}) → resolved `[]`;
  setLocalAddress ipv6 NUL → sync throw `ERR_INVALID_ARG_VALUE` but
  message `Invalid IP address.`
- V24 context: `hidden_files/triage-dns-2026-11-18.md` (10/31, 8 stub /
  11 UDP / 1 perf / 1 get-server; ceiling 11/31) and
  `hidden_files/triage-dns-2026-11-18-probes.txt`.
- Changelog cross-check:
  `~/workspace/research_notes/node-24-to-26-drift-20261119-1722/cross-check-changelog-2026-11-19.md`
  rows 28–29 (falsy lookup removed in 25.0.0; NUL truncation fixed in the
  Oct 2026 security releases). Export diff:
  `parity/drift/node26-export-diff.md` — dns has no export-surface change
  (row 29: `dns | 0 | 0 | 0 | 0 | 0`).
- Normalized file diffs (whitespace/quotes/semicolons stripped, v24
  vendored vs Node 26 source pack): the 13 pre-existing gap tests are
  identical or trailing-comma-only, except `test-dns-lookup.js` (falsy
  section + DEP0118 removal, finding F1). Fails-natively files likewise,
  except `test-dns.js` (port/falsy/Buffer sections above) and
  `test-dns-resolver-max-timeout.js` (one trailing comma).
