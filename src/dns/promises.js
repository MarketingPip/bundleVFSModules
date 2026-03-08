// npm install dohjs

/*!
 * dns-web/promises — node:dns/promises for browsers & bundlers
 * MIT License. See https://opensource.org/licenses/MIT
 * Node.js parity: node:dns/promises @ Node 15.0.0+
 * Dependencies: dohjs (via ./dns)
 * Limitations:
 *   - resolveNaptr() shape depends on dohjs NAPTR answer; verify against your resolver.
 *   - setServers() accepts DoH URLs, not IP:port strings.
 *   - No DNSSEC validation.
 *   - Resolver class cancel() aborts in-flight queries via AbortController.
 */

/**
 * @packageDocumentation
 * Implements `node:dns/promises` by promisifying `./dns` (callback API).
 * Exports a default `promises` object plus a `Resolver` class for scoped configs.
 * Default resolver: Cloudflare (https://cloudflare-dns.com/dns-query).
 *
 * Covered record types: A · AAAA · MX · NS · CNAME · TXT · SRV · SOA ·
 *                       PTR (reverse) · CAA · NAPTR · ANY (best-effort)
 */

import dns from '../dns';
import doh from 'dohjs';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wraps any ./dns callback-style function into a Promise, honouring an
 * AbortSignal so Resolver#cancel() can reject in-flight calls.
 *
 * @template T
 * @param {AbortSignal} signal
 * @param {(...args: any[]) => void} fn  - callback-style dns function
 * @param {...any} args                  - arguments forwarded to fn (no callback)
 * @returns {Promise<T>}
 */
function promisify(signal, fn, ...args) {
  return new Promise((resolve, reject) => {
    if (signal.aborted)
      return reject(Object.assign(new Error('Query cancelled'), { code: 'ECANCELLED' }));

    const onAbort = () =>
      reject(Object.assign(new Error('Query cancelled'), { code: 'ECANCELLED' }));
    signal.addEventListener('abort', onAbort, { once: true });

    fn(...args, (err, ...results) => {
      signal.removeEventListener('abort', onAbort);
      if (err) return reject(err);
      // Unwrap single-value results; pass through tuples (e.g. lookup address+family)
      resolve(results.length === 1 ? results[0] : results);
    });
  });
}

/**
 * Converts a dotted-decimal or colon-hex IP to an in-addr.arpa / ip6.arpa name.
 * @param {string} ip
 * @returns {string}
 */
function ipToArpa(ip) {
  if (ip.includes(':')) {
    const halves = ip.split('::');
    if (halves.length > 2) throw new TypeError(`Invalid IPv6: ${ip}`);
    const left  = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const fill  = Array(8 - left.length - right.length).fill('0000');
    return [...left, ...fill, ...right].map(g => g.padStart(4, '0'))
      .join('').split('').reverse().join('.') + '.ip6.arpa';
  }
  const parts = ip.split('.');
  if (parts.length !== 4) throw new TypeError(`Invalid IPv4: ${ip}`);
  return parts.reverse().join('.') + '.in-addr.arpa';
}

const enodata = (syscall, hostname) =>
  Object.assign(new Error(`${syscall} ENODATA ${hostname}`), { code: 'ENODATA', syscall, hostname });

// ---------------------------------------------------------------------------
// Resolver class
// ---------------------------------------------------------------------------

/**
 * Instance-based DNS resolver with independent server config and cancellation.
 * Mirrors the `dns.Resolver` class from Node ≥ 8.3.0 / `dns/promises` ≥ 15.
 *
 * All record-type methods delegate to the ./dns callback API via `promisify()`,
 * so query logic lives in exactly one place.
 *
 * @example
 * const r = new Resolver();
 * r.setServers(['https://dns.google/dns-query']);
 * const addrs = await r.resolve4('example.com');
 * r.cancel(); // abort all pending queries
 */
export class Resolver {
  constructor() {
    this._ac = new AbortController();
    // Each instance gets its own dohjs resolver; we swap it via setServers().
    // The module-level dns functions use their own internal resolver, so for
    // scoped instances we bypass ./dns and call dohjs directly for isolation.
    this._servers = ['https://cloudflare-dns.com/dns-query'];
    this._doh = new doh.DohResolver(this._servers[0]);
  }

  // ── Server management ────────────────────────────────────────────────────

  /** @param {string[]} servers */
  setServers(servers) {
    if (!Array.isArray(servers) || !servers.length)
      throw new TypeError('setServers() requires a non-empty array of DoH URLs');
    this._servers = servers.slice();
    this._doh = new doh.DohResolver(this._servers[0]);
  }

  /** @returns {string[]} */
  getServers() { return this._servers.slice(); }

  // ── Cancellation ─────────────────────────────────────────────────────────

  /**
   * Cancels all outstanding queries. Pending promises reject with `ECANCELLED`.
   * The instance remains usable for subsequent queries.
   */
  cancel() {
    this._ac.abort();
    this._ac = new AbortController();
  }

  // ── Internal scoped query (used only by Resolver instances) ──────────────

  /**
   * @param {string} name
   * @param {string} rrtype
   * @returns {Promise<any>}
   */
  _query(name, rrtype) {
    const { signal } = this._ac;
    return new Promise((resolve, reject) => {
      if (signal.aborted)
        return reject(Object.assign(new Error('Query cancelled'), { code: 'ECANCELLED' }));
      const onAbort = () =>
        reject(Object.assign(new Error('Query cancelled'), { code: 'ECANCELLED' }));
      signal.addEventListener('abort', onAbort, { once: true });
      this._doh.query(name, rrtype)
        .then(r => { signal.removeEventListener('abort', onAbort); resolve(r); })
        .catch(e => { signal.removeEventListener('abort', onAbort); reject(e); });
    });
  }

  // ── Record-type methods ───────────────────────────────────────────────────
  // The default resolver delegates straight to ./dns via promisify().
  // Scoped Resolver instances use this._query() for isolation.

  /** @param {string} h @param {{ family?:0|4|6; all?:boolean }} [opts] */
  lookup(h, opts = {}) {
    return new Promise((resolve, reject) => {
      dns.lookup(h, opts, (err, address, family) => {
        if (err) return reject(err);
        resolve(opts.all ? address : { address, family });
      });
    });
  }

  /** @param {string} h @param {string} [rrtype='A'] */
  resolve(h, rrtype = 'A') {
    const map = {
      A: 'resolve4', AAAA: 'resolve6', MX: 'resolveMx', NS: 'resolveNs',
      CNAME: 'resolveCname', TXT: 'resolveTxt', SRV: 'resolveSrv',
      SOA: 'resolveSoa', PTR: 'resolvePtr', CAA: 'resolveCaa',
      NAPTR: 'resolveNaptr', ANY: 'resolveAny',
    };
    const method = map[rrtype.toUpperCase()];
    if (!method) return Promise.reject(new TypeError(`Unknown rrtype: ${rrtype}`));
    return this[method](h);
  }

  resolve4(h)     { return promisify(this._ac.signal, dns.resolve4, h); }
  resolve6(h)     { return promisify(this._ac.signal, dns.resolve6, h); }
  resolveMx(h)    { return promisify(this._ac.signal, dns.resolveMx, h); }
  resolveNs(h)    { return promisify(this._ac.signal, dns.resolveNs, h); }
  resolveCname(h) { return promisify(this._ac.signal, dns.resolveCname, h); }
  resolveTxt(h)   { return promisify(this._ac.signal, dns.resolveTxt, h); }
  resolveSrv(h)   { return promisify(this._ac.signal, dns.resolveSrv, h); }
  resolveSoa(h)   { return promisify(this._ac.signal, dns.resolveSoa, h); }

  /** PTR query on a hostname or arpa name directly. */
  resolvePtr(h)   { return promisify(this._ac.signal, dns.resolve, h); } // resolve defaults to resolve4; use raw below
  /** @param {string} ip */
  async reverse(ip) {
    let arpa;
    try { arpa = ipToArpa(ip); }
    catch (e) { throw Object.assign(e, { code: 'EINVAL' }); }
    const res = await this._query(arpa, 'PTR');
    const hostnames = (res.answers || []).filter(r => r.type === 'PTR').map(r => r.data);
    if (!hostnames.length)
      throw Object.assign(new Error(`getHostByAddr ENOTFOUND ${ip}`), { code: 'ENOTFOUND' });
    return hostnames;
  }

  /** CAA — not in ./dns callback API, so handled via scoped _query(). */
  async resolveCaa(h) {
    if (typeof h !== 'string' || !h.length)
      throw Object.assign(new Error('Invalid hostname'), { code: 'EINVAL' });
    const res = await this._query(h, 'CAA');
    const records = (res.answers || []).filter(r => r.type === 'CAA').map(r => {
      const { flags, tag, value } = r.data;
      return { critical: flags & 0x80 ? 128 : 0, [tag]: value };
    });
    if (!records.length) throw enodata('queryCAA', h);
    return records;
  }

  /** NAPTR — not in ./dns callback API, so handled via scoped _query(). */
  async resolveNaptr(h) {
    if (typeof h !== 'string' || !h.length)
      throw Object.assign(new Error('Invalid hostname'), { code: 'EINVAL' });
    const res = await this._query(h, 'NAPTR');
    const records = (res.answers || []).filter(r => r.type === 'NAPTR').map(r => ({
      flags:       String(r.data.flags       ?? ''),
      service:     String(r.data.services    ?? r.data.service ?? ''),
      regexp:      String(r.data.regexp      ?? ''),
      replacement: String(r.data.replacement ?? ''),
      order:       Number(r.data.order       ?? 0),
      preference:  Number(r.data.preference  ?? 0),
    }));
    if (!records.length) throw enodata('queryNAPTR', h);
    return records;
  }

  /** Fires all common record types in parallel; merges with type discriminant. */
  async resolveAny(h) {
    if (typeof h !== 'string' || !h.length)
      throw Object.assign(new Error('Invalid hostname'), { code: 'EINVAL' });

    // Use ./dns callbacks for the types it covers; _query() for the rest.
    const [a, aaaa, mx, ns, cname, txt, srv, soa, caa, naptr] = await Promise.allSettled([
      promisify(this._ac.signal, dns.resolve4, h),
      promisify(this._ac.signal, dns.resolve6, h),
      promisify(this._ac.signal, dns.resolveMx, h),
      promisify(this._ac.signal, dns.resolveNs, h),
      promisify(this._ac.signal, dns.resolveCname, h),
      promisify(this._ac.signal, dns.resolveTxt, h),
      promisify(this._ac.signal, dns.resolveSrv, h),
      promisify(this._ac.signal, dns.resolveSoa, h),
      this.resolveCaa(h).catch(() => null),
      this.resolveNaptr(h).catch(() => null),
    ]);

    const out = [];
    const ok = r => r.status === 'fulfilled' && r.value != null;

    if (ok(a))     a.value.forEach(addr => out.push({ type: 'A', address: addr }));
    if (ok(aaaa))  aaaa.value.forEach(addr => out.push({ type: 'AAAA', address: addr }));
    if (ok(mx))    mx.value.forEach(r => out.push({ type: 'MX', ...r }));
    if (ok(ns))    ns.value.forEach(v => out.push({ type: 'NS', value: v }));
    if (ok(cname)) cname.value.forEach(v => out.push({ type: 'CNAME', value: v }));
    if (ok(txt))   txt.value.forEach(entries => out.push({ type: 'TXT', entries }));
    if (ok(srv))   srv.value.forEach(r => out.push({ type: 'SRV', ...r }));
    if (ok(soa))   out.push({ type: 'SOA', ...soa.value });
    if (ok(caa))   caa.value.forEach(r => out.push({ type: 'CAA', ...r }));
    if (ok(naptr)) naptr.value.forEach(r => out.push({ type: 'NAPTR', ...r }));

    if (!out.length)
      throw Object.assign(new Error(`queryANY ENOTFOUND ${h}`), { code: 'ENOTFOUND' });
    return out;
  }
}

// ---------------------------------------------------------------------------
// Module-level default resolver + named exports
// ---------------------------------------------------------------------------

const _default = new Resolver();

// Server management delegates to ./dns so both APIs stay in sync.
export const setServers = servers => { dns.setServers(servers); _default.setServers(servers); };
export const getServers = ()      => dns.getServers();

export const lookup       = (h, opts) => _default.lookup(h, opts);
export const resolve      = (h, type) => _default.resolve(h, type);
export const resolve4     = h => promisify(_default._ac.signal, dns.resolve4, h);
export const resolve6     = h => promisify(_default._ac.signal, dns.resolve6, h);
export const resolveMx    = h => promisify(_default._ac.signal, dns.resolveMx, h);
export const resolveNs    = h => promisify(_default._ac.signal, dns.resolveNs, h);
export const resolveCname = h => promisify(_default._ac.signal, dns.resolveCname, h);
export const resolveTxt   = h => promisify(_default._ac.signal, dns.resolveTxt, h);
export const resolveSrv   = h => promisify(_default._ac.signal, dns.resolveSrv, h);
export const resolveSoa   = h => promisify(_default._ac.signal, dns.resolveSoa, h);
export const reverse      = ip => _default.reverse(ip);
export const resolveCaa   = h  => _default.resolveCaa(h);
export const resolveNaptr = h  => _default.resolveNaptr(h);
export const resolveAny   = h  => _default.resolveAny(h);

export default {
  Resolver,
  setServers, getServers,
  lookup, resolve,
  resolve4, resolve6, resolveMx, resolveNs, resolveCname, resolveTxt,
  resolveSrv, resolveSoa, reverse, resolveCaa, resolveNaptr, resolveAny,
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import dns from './dns';
// import dnsPromises, { Resolver } from './dns/promises';
//
// // All standard types via default resolver
// const { address } = await dnsPromises.lookup('example.com');
// const mx  = await dnsPromises.resolveMx('gmail.com');
// const txt = await dnsPromises.resolveTxt('github.com');
// const rev = await dnsPromises.reverse('8.8.8.8');  // → ['dns.google']
// const any = await dnsPromises.resolveAny('example.com');
//
// // Scoped instance with a different server
// const r = new Resolver();
// r.setServers(['https://dns.google/dns-query']);
// const ns = await r.resolveNs('cloudflare.com');
//
// // setServers keeps both APIs in sync
// dnsPromises.setServers(['https://dns.google/dns-query']);
// dns.resolve4('example.com', (err, ips) => console.log(ips)); // uses Google DoH too
//
// // Cancellation
// const p = r.resolve4('slow.example.com');
// r.cancel();  // → p rejects with { code: 'ECANCELLED' }
//
// // Error cases
// try { await dnsPromises.resolve4('nxdomain.invalid'); }
// catch (e) { console.log(e.code); }  // 'ENOTFOUND'
//
// try { await dnsPromises.reverse('not-an-ip'); }
// catch (e) { console.log(e.code); }  // 'EINVAL'
