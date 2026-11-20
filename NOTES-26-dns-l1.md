# dns L1 — NUL validation (Node 26 Wave 1)

Lane: `NOTES-26-triage-dns.md` §D + §L1. Base: origin/main `d587825d`
(PR #506 triage merged). Banked dns on the Node 26 suite: **10/32**.

## Result: dns 10/32 → 12/32 (+2, ceiling reached for this lane)

Flips (both verified 2× via the full dns differential, runs identical):

| test | baseline | run 1 | run 2 |
|---|---|---|---|
| `test-dns-resolve-null-bytes.js` (NEW in 26) | fail (1) | pass (0) | pass (0) |
| `test-dns-setlocaladdress.js` (new NUL section) | fail (1) | pass (0) | pass (0) |

Full differential, `parity/drift/run-baseline.mjs --modules dns --jobs 2
--short 10 --full 30` (Node 26 test files, `PARITY_TARGET=dns`):
run 1 and run 2 both **12/32 pass, 17 fail, 3 timeout** — the only
per-test changes vs `parity/drift/node26-baseline.jsonc` are the two flips
above. All 10 baseline passes held, including
`test-dns-setservers-type-check` and `test-dns-lookupService-promises`
(live DoH reverse lookup). No regressions.

Repo tests: `jest tests/dns.test.js tests/dns_promises.test.js
tests/export_surface_dns.test.js tests/export_surface_dns_promises.test.js`
→ 4 suites, 103/103 pass.

Probe (deleted after use, `zz-dns-nul-probe.js`): 118 sync-throw asserts
covering every `resolve*` + `resolve(name, rrtype)` + `reverse` across the
callback API (`dns` + `new Resolver()`), the promises API (`dnsPromises` +
`new dnsPromises.Resolver()`), and `setLocalAddress` NUL messages on both
resolver classes — plus non-NUL sanity (callback `reverse('not-an-ip')`
still sync EINVAL; promises `reverse('not-an-ip')` still rejects EINVAL;
promises `reverse(123)` still sync ERR_INVALID_ARG_TYPE; `lookup` NUL
still throws; non-NUL `resolveAny` still answers ENOTIMP). All green.

## Change (pure validation, 2 files)

`src/dns.js` (+6 lines in `src/dns/promises.js`):

- Shared helper `validateStringWithoutNullBytes(value, name)` — Node's
  `lib/internal/validators.js` shape: type check, then NUL check, sync
  throw `TypeError` code `ERR_INVALID_ARG_VALUE`, message
  `The argument '<name>' must be a string without null bytes. Received '…'`
  with the lookup path's existing `\x`-escaping, now reused
  (`normalizeLookupArgs` previously inlined the same message).
- Called wherever the shim did `validateString(hostname, "name")` on a
  resolve path, before any async work: `normalizeResolveArgs`,
  `makeResolveFn` (all `resolve*`), module-level `resolveAny` and
  `Resolver.resolveAny` (before the ENOTIMP answer),
  `Resolver._resolveWith` (all `Resolver.resolve*`),
  `Resolver.resolve` (covers the `ANY` branch).
- `reverse` (module-level + `Resolver.reverse`): NUL check runs first
  with argument name `'name'` (Node's `resolver('getHostByAddr')`
  validates before the IP check), so a NUL IP throws
  ERR_INVALID_ARG_VALUE instead of EINVAL.
- `Resolver.setLocalAddress`: NUL check before the `isIP` check, with
  argument names `'ipv4'` / `'ipv6'` (Node `lib/internal/dns/utils.js`
  :182,185) — fixes the wrong-message throw (`Invalid IP address.`).

Traps (probe-proven, handled):

- `PromisesResolver._asPromise` invoked inside the Promise executor, so
  sync throws became rejections. Restructured to the deferred pattern
  (same shape as `src/dns/promises.js` `asPromise`): the callback method
  is invoked outside the executor, so validation throws synchronously
  and only operational failures become rejections.
- `src/dns/promises.js` `reverse` converted every sync throw to a
  rejection for string IPs. Now only the EINVAL (non-IP literal) throw
  converts; validation throws (`ERR_INVALID_ARG_VALUE`, and
  `ERR_INVALID_ARG_TYPE` via the existing non-string branch) propagate
  synchronously.

## Scope / non-goals

- No transport work; no other dns test touched. The remaining 20
  non-passes are the triage NO-FIX / fails-natively sets (STUB 8, UDP 4,
  PERF 1, fails-natively 7) — unchanged.
- Finding F1 (falsy-hostname lookup) is 0 flips and is NOT in this PR.
- No `// Flags:` headers on either flip test or on the two named guards,
  so no flagged-direct-run deviation: the baseline runner's results
  compare apples-to-apples.

## Evidence files (not committed)

- Differential runs: `/tmp/dns-l1/node26-dns-l1-run1.jsonc`,
  `/tmp/dns-l1/node26-dns-l1-run2.jsonc` (+ `csv-run1/`, `csv-run2/`).

## Ship

- PR: #507
- Merge SHA: `1a1b89a26ccdf8e28a17bd38c6e82a932b1dcd1b` (squash-merge of PR #507)
- Final count: **dns 12/32** (10 banked + 2 flips, 0 regressions)
