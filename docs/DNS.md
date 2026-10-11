# DNS-over-HTTPS (`node:dns` in the browser)

`src/dns.js` + `src/dns/promises.js` port `node:dns` for the browser runtime.
The sandbox has no UDP sockets and no OS resolver, so every query goes out
over **DNS-over-HTTPS** (RFC 8484) via `fetch()` — real DNS answers from real
resolvers. Nothing is invented: NXDOMAIN is NXDOMAIN, timeouts are timeouts.

## Transport

- **Wire format**, not JSON: queries are DNS packets (`application/dns-message`,
  `?dns=<base64url>`) encoded/decoded by `dns-packet` (maintained, MIT).
  The JSON endpoint was deliberately not used — the wire codec replaces
  ~150 lines of hand-rolled parsing and matches c-ares record shapes exactly.
- **Default endpoints** (failover order): `https://cloudflare-dns.com/dns-query`,
  then `https://dns.google/dns-query`. A SERVFAIL/transport failure on the
  first is retried on the next; NOERROR/NXDOMAIN are terminal.
- The DNS message ID is `0` per RFC 8484's cache-friendliness guidance.
- `setServers()` accepts DoH endpoint URLs (`https://…`) and records plain
  `IP[:port]` entries verbatim (see Honest gaps).

## API surface

Mirrors `node:dns` (v24.20.0) plus `dns/promises`:

- `lookup(hostname[, options], cb)` — literal IPv4/IPv6 and `localhost`
  answered locally; everything else resolved via DoH. Supports
  `{ family, hints (ADDRCONFIG/V4MAPPED/ALL), all, order, verbatim }`.
- `resolve(hostname, rrtype, cb)` and the typed shorthands `resolve4`,
  `resolve6`, `resolveCname`, `resolveMx`, `resolveNs`, `resolveTxt`,
  `resolveSrv`, `resolveSoa`, `resolvePtr`, `resolveNaptr`, `resolveCaa`,
  `resolveTlsa`. `resolveAny` throws `ENOTIMP` — same as real Node.
- `reverse(ip, cb)` — PTR query, honest NXDOMAIN→`ENOTFOUND`.
- `lookupService(address, port, cb)` — reverse + port-name mapping.
- `Resolver` class with per-instance `setServers()`/`cancel()`/`getServers()`
  and `timeout`; `dns.promises.Resolver` is the promise-flavoured subclass.
- `getServers`/`setServers`, `getDefaultResultOrder`/`setDefaultResultOrder`
  (default: `verbatim`), and all c-ares error-name constants (`ENOTFOUND`,
  `ESERVFAIL`, `ETIMEOUT`, `ECONNREFUSED`, …).

Record shapes were verified field-by-field against
`nodejs/node` v24.20.0 `src/cares_wrap.cc` (e.g. MX → `{ priority, exchange }`,
SRV → `{ priority, weight, port, name }`, SOA →
`{ nsname, hostmaster, serial, refresh, retry, expire, minttl }`).

## Error mapping (honest)

| Upstream / condition | Shim error |
|---|---|
| rcode NXDOMAIN | `ENOTFOUND` |
| rcode SERVFAIL | `ESERVFAIL` |
| rcode REFUSED | `EREFUSED` |
| fetch throws / no network | `ECONNREFUSED` |
| `timeout` option exceeded | `ETIMEOUT` |
| `fetch` unavailable | `EAI_AGAIN` |
| reverse of non-IP | `EINVAL` (synchronous, like Node) |

The resolver's SERVFAIL is *not* papered over: e.g. a bogus-DNSSEC name that
the upstream validator rejects surfaces as `ESERVFAIL`, fail-closed.

## Caching

Positive answers are cached per `(name, type)` for their TTL; NXDOMAIN and
errors are **never** cached (no negative caching). Cache is per module
instance (`docs/SINGLETONS.md`); aborted queries bypass it.

## DNSSEC

Validated **by delegation** — a deliberate divergence from `node:dns`, which
never validates. Queries go to validating DoH resolvers *without* the CD
(checking-disabled) bit, so Cloudflare/Google cryptographically validate the
chain: signed+valid answers arrive with the AD bit set; bogus signatures come
back SERVFAIL → `ESERVFAIL`. A browser cannot hold the root trust anchor or
walk the chain itself, so this is the standard stub-resolver architecture.
Verified live: signed+valid → AD set; the deliberately-bogus
`dnssec-failed.org` → SERVFAIL.

## Honest gaps (documented, not faked)

- `lookup()` in Node is getaddrinfo-based: it honors `/etc/hosts`, mDNS,
  search domains and the OS resolver config. The shim answers literal IPs and
  `localhost` locally and resolves everything else via DoH; ordering and
  `/etc/hosts` entries may differ.
- `setServers()` with plain `IP[:port]` records the entries (and `getServers()`
  echoes them), but raw UDP/TCP DNS is impossible in the browser, so those
  entries cannot be used as transports.
- No EDNS0 client-subnet signalling; no TSIG.

## Tests

- `tests/dns.test.js` — **83 tests**, two lanes: a deterministic stub DoH
  server (RFC 8484 wire format, no network — exact parser/shape assertions)
  plus **real queries against cloudflare-dns.com**
  (`resolve4/6`, `resolve` A/AAAA, `lookup`, `reverse` PTR of `8.8.8.8` →
  `dns.google`, NXDOMAIN → `ENOTFOUND`, DNSSEC delegation probes).
- `tests/dns_promises.test.js`, `tests/export_surface_dns*.test.js` — surface
  parity with `node:dns`.
- `tests/dns-doh-e2e.py` + `tests/dns-doh-e2e.html` — headed-Firefox proof:
  real answers inside the sandbox through `CodeSandbox.execute()`.

## Usage

```js
import dns from "node:dns"; // or the sandbox's loadModule("dns")

dns.resolve4("example.com", (err, addrs) => {
  if (err) return console.error(err.code); // ENOTFOUND, ETIMEOUT, …
  console.log(addrs);
});

const { lookup } = await import("node:dns/promises");
const { address } = await lookup("example.com");
```
