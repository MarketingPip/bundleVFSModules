import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import dnsPacket from 'dns-packet';
import { toRcode } from 'dns-packet/rcodes.js';

import dnsDefault, {
  lookup,
  lookupService,
  resolve,
  resolve4,
  resolve6,
  resolveAny,
  resolveCaa,
  resolveCname,
  resolveMx,
  resolveNaptr,
  resolveNs,
  resolvePtr,
  resolveSoa,
  resolveSrv,
  resolveTlsa,
  resolveTxt,
  reverse,
  Resolver,
  setServers,
  getServers,
  getDefaultResultOrder,
  setDefaultResultOrder,
  promises,
  NODATA, NOTFOUND, CONNREFUSED, TIMEOUT, CANCELLED,
  ADDRCONFIG, V4MAPPED, ALL,
} from '../src/dns.js';
import * as dnsPromisesNs from '../src/dns/promises.js';

// ---------------------------------------------------------------------------
// Deterministic stub DoH server (no network needed; exact parser assertions).
// Speaks RFC 8484 wire format: ?dns=<base64url> in, application/dns-message
// out, decoded/encoded with dns-packet — the same codec as the shim.
// ---------------------------------------------------------------------------

const STUB_ANSWERS = {
  'A|stub.test': [
    { name: 'stub.test', type: 'A', ttl: 100, data: '93.184.216.34' },
    { name: 'stub.test', type: 'A', ttl: 200, data: '93.184.216.35' },
  ],
  'AAAA|stub.test': [
    { name: 'stub.test', type: 'AAAA', ttl: 100, data: '2606:2800:220:1:248:1893:25c8:1946' },
  ],
  'MX|stub.test': [
    { name: 'stub.test', type: 'MX', ttl: 300, data: { preference: 10, exchange: 'mail.stub.test.' } },
  ],
  'TXT|stub.test': [
    { name: 'stub.test', type: 'TXT', ttl: 300, data: [Buffer.from('hello'), Buffer.from('world')] },
    { name: 'stub.test', type: 'TXT', ttl: 300, data: [Buffer.from('bare-text')] },
  ],
  'SRV|_srv.stub.test': [
    { name: '_srv.stub.test', type: 'SRV', ttl: 300, data: { priority: 10, weight: 20, port: 5060, target: 'sip.stub.test.' } },
  ],
  'SOA|stub.test': [
    { name: 'stub.test', type: 'SOA', ttl: 300, data: { mname: 'ns1.stub.test.', rname: 'hostmaster.stub.test.', serial: 2024010101, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300 } },
  ],
  'CAA|stub.test': [
    { name: 'stub.test', type: 'CAA', ttl: 300, data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' } },
  ],
  'NAPTR|stub.test': [
    { name: 'stub.test', type: 'NAPTR', ttl: 300, data: { order: 10, preference: 100, flags: 's', services: 'SIP+D2U', regexp: '', replacement: '_sip._udp.stub.test.' } },
  ],
  'TLSA|_443._tcp.stub.test': [
    { name: '_443._tcp.stub.test', type: 'TLSA', ttl: 300, data: { usage: 3, selector: 1, matchingType: 1, certificate: Buffer.from('d2abde240d7cd3ee6b4b28c54df034b396c997a2d3f', 'hex') } },
  ],
  'PTR|34.216.184.93.in-addr.arpa': [
    { name: '34.216.184.93.in-addr.arpa', type: 'PTR', ttl: 300, data: 'host.stub.test.' },
  ],
  'CNAME|alias.stub.test': [
    { name: 'alias.stub.test', type: 'CNAME', ttl: 300, data: 'stub.test.' },
  ],
  // CNAME chain: A query returns only a CNAME; resolver must follow it.
  'A|cname-chain.stub.test': [
    { name: 'cname-chain.stub.test', type: 'CNAME', ttl: 300, data: 'stub.test.' },
  ],
  'A|gone.stub.test': { rcode: 'NXDOMAIN' },   // NXDOMAIN → ENOTFOUND
  'A|empty.stub.test': { rcode: 'NOERROR', answers: [] }, // NOERROR, no answers → ENODATA
  'A|fail.stub.test': { rcode: 'SERVFAIL' },   // SERVFAIL → ESERVFAIL
  'A|slow.stub.test': [
    { name: 'slow.stub.test', type: 'A', ttl: 100, data: '93.184.216.34' },
    { name: 'slow.stub.test', type: 'A', ttl: 100, data: '93.184.216.35' },
  ],
};

function base64UrlDecode(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

let stubServer;
let stubBase;

function stubResponse(query, spec) {
  const rcode = spec.rcode || 'NOERROR';
  const answers = Array.isArray(spec) ? spec : (spec.answers || []);
  return dnsPacket.encode({
    type: 'response',
    id: query.id,
    flags: toRcode(rcode),
    questions: query.questions,
    answers,
  });
}

function startStub() {
  return new Promise((resolveStart) => {
    stubServer = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      let query;
      try {
        query = dnsPacket.decode(base64UrlDecode(u.searchParams.get('dns') || ''));
      } catch {
        res.statusCode = 400;
        res.end();
        return;
      }
      const q = (query.questions && query.questions[0]) || {};
      const name = q.name || '';
      const type = q.type || '';
      const respond = () => {
        const spec = STUB_ANSWERS[`${type}|${name}`];
        const wire = stubResponse(query, spec === undefined ? { rcode: 'NXDOMAIN' } : spec);
        res.setHeader('content-type', 'application/dns-message');
        res.end(wire);
      };
      if (name === 'hang.stub.test') return; // never respond → timeout/cancel
      if (name === 'slow.stub.test') { // respond after a beat → lets tests observe in-flight state
        setTimeout(respond, 150);
        return;
      }
      respond();
    });
    stubServer.listen(0, '127.0.0.1', () => {
      stubBase = `http://127.0.0.1:${stubServer.address().port}/dns-query`;
      resolveStart();
    });
  });
}

const cbPromise = (fn, ...args) =>
  new Promise((res, rej) => fn(...args, (err, ...rest) => (err ? rej(err) : res(rest))));

describe('dns (DoH shim)', () => {
  beforeAll(async () => { await startStub(); });
  afterAll(() => new Promise((r) => stubServer.close(r)));

  // ------------------------------------------------------------------
  // Module shape — verified against real node:dns key lists
  // ------------------------------------------------------------------
  test('named exports match node:dns surface', () => {
    for (const fn of [lookup, lookupService, resolve, resolve4, resolve6, resolveAny,
      resolveCaa, resolveCname, resolveMx, resolveNaptr, resolveNs, resolvePtr,
      resolveSoa, resolveSrv, resolveTlsa, resolveTxt, reverse,
      getServers, setServers, getDefaultResultOrder, setDefaultResultOrder]) {
      expect(typeof fn).toBe('function');
    }
    expect(typeof Resolver).toBe('function');
    expect(dnsDefault.lookup).toBe(lookup);
    expect(dnsDefault.Resolver).toBe(Resolver);
  });

  test("require('dns/promises') === dns.promises (namespace identity)", () => {
    expect(promises).toBe(dnsPromisesNs);
    expect(dnsDefault.promises).toBe(dnsPromisesNs);
    expect(dnsPromisesNs.NODATA).toBe(dnsDefault.NODATA);
  });

  test('error-code constants match c-ares names', () => {
    expect([NODATA, NOTFOUND, CONNREFUSED, TIMEOUT, CANCELLED]).toEqual(
      ['ENODATA', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEOUT', 'ECANCELLED']);
    expect([ADDRCONFIG, V4MAPPED, ALL]).toEqual([32, 8, 16]);
    expect(dnsDefault.NODATA).toBe('ENODATA');
    expect(dnsDefault.NOTFOUND).toBe('ENOTFOUND');
  });

  // ------------------------------------------------------------------
  // Server management
  // ------------------------------------------------------------------
  test('default servers are DoH endpoints', () => {
    const servers = getServers();
    expect(servers.length).toBeGreaterThan(0);
    expect(servers[0]).toMatch(/^https:\/\//);
  });

  test('setServers/getServers round-trip', () => {
    const prev = getServers();
    try {
      setServers(['https://dns.google/dns-query']);
      expect(getServers()).toEqual(['https://dns.google/dns-query']);
      setServers(['8.8.8.8', '1.1.1.1:53']); // default port 53 is normalized away
      expect(getServers()).toEqual(['8.8.8.8', '1.1.1.1']);
      setServers(['4.4.4.4:5353', '[2001:db8::1]:5353']); // non-default ports kept
      expect(getServers()).toEqual(['4.4.4.4:5353', '[2001:db8::1]:5353']);
      setServers([]); // allowed, like real Node
      expect(getServers()).toEqual([]);
    } finally {
      setServers(prev);
    }
  });

  test('setServers validation mirrors Node', () => {
    expect(() => setServers('8.8.8.8')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => setServers(['not a url'])).toThrow(expect.objectContaining({ code: 'ERR_INVALID_IP_ADDRESS' }));
    expect(() => setServers([123])).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => setServers([null])).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE', message: 'The "servers[0]" argument must be of type string. Received null' }));
    expect(() => setServers(['127.0.0.1:va'])).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_IP_ADDRESS', message: 'Invalid IP address: 127.0.0.1:va' }));
  });

  test('setServers normalizes addresses like Node', () => {
    const prev = getServers();
    try {
      setServers(['4.4.4.4:53', '[2001:4860:4860::8888]:53', '103.238.225.181:666',
        '[fe80::483a:5aff:fee6:1f04]:666', '[fe80::483a:5aff:fee6:1f04]']);
      expect(getServers()).toEqual(['4.4.4.4', '2001:4860:4860::8888', '103.238.225.181:666',
        '[fe80::483a:5aff:fee6:1f04]:666', 'fe80::483a:5aff:fee6:1f04']);
    } finally {
      setServers(prev);
    }
  });

  test('setServers skips holes', () => {
    const prev = getServers();
    try {
      const arr = ['8.8.8.8', '1.1.1.1'];
      delete arr[0];
      setServers(arr);
      expect(getServers()).toEqual(['1.1.1.1']);
    } finally {
      setServers(prev);
    }
  });

  test('setServers: module-level never throws for pending queries, Resolver does', async () => {
    const prev = getServers();
    setServers([stubBase]);
    try {
      // Module-level setServers never throws for pending queries (real node:dns).
      const p = cbPromise(resolve4, 'slow.stub.test');
      expect(() => setServers([stubBase])).not.toThrow();
      const [recs] = await p;
      expect(recs).toEqual(['93.184.216.34', '93.184.216.35']);
      // But a Resolver instance refuses while its own queries are pending.
      const r = new Resolver();
      r.setServers([stubBase]);
      const p2 = new Promise((resolve, reject) => {
        r.resolve4('slow.stub.test', (err, recs2) => (err ? reject(err) : resolve(recs2)));
      });
      expect(() => r.setServers(['127.0.0.1'])).toThrow(
        expect.objectContaining({ code: 'ERR_DNS_SET_SERVERS_FAILED' }));
      await p2;
      r.setServers(['127.0.0.1']); // works again once the query settles
      expect(r.getServers()).toEqual(['127.0.0.1']);
    } finally {
      setServers(prev);
    }
  });

  test('getDefaultResultOrder/setDefaultResultOrder', () => {
    expect(getDefaultResultOrder()).toBe('verbatim');
    setDefaultResultOrder('ipv4first');
    expect(getDefaultResultOrder()).toBe('ipv4first');
    setDefaultResultOrder('verbatim');
    expect(() => setDefaultResultOrder('bogus')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    expect(() => setDefaultResultOrder(4)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
  });

  // ------------------------------------------------------------------
  // lookup() argument validation (sync throws, verified vs real Node)
  // ------------------------------------------------------------------
  test('lookup validation', () => {
    const cb = () => {};
    expect(() => lookup('x.com')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => lookup(123, cb)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => lookup('x.com', { family: 'x' }, cb)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    expect(() => lookup('x.com', { family: 7 }, cb)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    expect(() => lookup('x.com', { hints: 'x' }, cb)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => lookup('x.com', { verbatim: 'x' }, cb)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => lookup('x.com', { all: 'x' }, cb)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => lookup('x.com', 'str', cb)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });

  test('callbacks are always async', async () => {
    const prev = getServers();
    setServers([stubBase]);
    try {
      const order = [];
      resolve4('stub.test', () => { order.push('cb'); });
      order.push('after-call');
      expect(order).toEqual(['after-call']);
      // Poll for the callback instead of a fixed sleep: the first fetch in a
      // fresh process can take ~400ms (proxy/env setup).
      const deadline = Date.now() + 10000;
      while (!order.includes('cb') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(order).toEqual(['after-call', 'cb']);
    } finally {
      setServers(prev);
    }
  }, 15000);

  // ------------------------------------------------------------------
  // lookup() semantics (stub server)
  // ------------------------------------------------------------------
  describe('lookup()', () => {
    const prev = () => getServers();
    beforeAll(() => setServers([stubBase]));
    afterAll(() => setServers(['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query']));

    test('resolves A and AAAA with all:true', async () => {
      const recs = await cbPromise(lookup, 'stub.test', { all: true }).then(([r]) => r);
      expect(recs).toEqual([
        { address: '93.184.216.34', family: 4 },
        { address: '93.184.216.35', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ]);
    });

    test('family filters record types', async () => {
      const [addr4, fam4] = await cbPromise(lookup, 'stub.test', 4);
      expect(fam4).toBe(4);
      expect(addr4).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      const [addr6, fam6] = await cbPromise(lookup, 'stub.test', { family: 6 });
      expect(fam6).toBe(6);
      expect(addr6).toContain(':');
    });

    test('literal IPs resolve locally, family ignored (matches Node)', async () => {
      expect(await cbPromise(lookup, '127.0.0.1')).toEqual(['127.0.0.1', 4]);
      expect(await cbPromise(lookup, '::1')).toEqual(['::1', 6]);
      expect(await cbPromise(lookup, '::1', 4)).toEqual(['::1', 6]);
    });

    test('localhost resolves like getaddrinfo', async () => {
      expect(await cbPromise(lookup, 'localhost')).toEqual(['::1', 6]);
      expect(await cbPromise(lookup, 'localhost', 4)).toEqual(['127.0.0.1', 4]);
      const all = await cbPromise(lookup, 'localhost', { all: true }).then(([r]) => r);
      expect(all).toEqual([{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]);
    });

    test('NXDOMAIN → ENOTFOUND with syscall getaddrinfo', async () => {
      await expect(cbPromise(lookup, 'gone.stub.test')).rejects.toMatchObject({
        code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'gone.stub.test',
      });
    });

    test('verbatim:false puts IPv4 first', async () => {
      const recs = await cbPromise(lookup, 'stub.test', { all: true, verbatim: false }).then(([r]) => r);
      expect(recs[0].family).toBe(4);
    });
  });

  // ------------------------------------------------------------------
  // lookup()/lookupService()/resolve() argument validation (Node v24)
  // ------------------------------------------------------------------
  describe('argument validation (matches Node v24)', () => {
    test('lookup: falsy hostnames resolve { address: null, family: 4 } (DEP0118)', async () => {
      for (const v of ['', 0, NaN, null, undefined, false]) {
        const [address, family] = await cbPromise(lookup, v);
        expect(address).toBeNull();
        expect(family).toBe(4);
      }
    });

    test('lookup: truthy non-string hostnames throw ERR_INVALID_ARG_TYPE', () => {
      for (const v of [123, true, {}, []]) {
        expect(() => lookup(v, () => {})).toThrow(
          expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      }
    });

    test('lookup: embedded NUL throws ERR_INVALID_ARG_VALUE', () => {
      expect(() => lookup('a\0b', () => {})).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    });

    test('lookup: hints bitmask validation', () => {
      const cb = () => {};
      expect(() => lookup('127.0.0.1', { hints: 512 }, cb)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
      expect(() => lookup('127.0.0.1', { hints: -1 }, cb)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
      expect(() => lookup('127.0.0.1', { hints: 'x' }, cb)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => lookup('127.0.0.1', { hints: 56 }, cb)).not.toThrow();
    });

    test('lookup: order validation', () => {
      const cb = () => {};
      expect(() => lookup('127.0.0.1', { order: 'nope' }, cb)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
      for (const o of ['verbatim', 'ipv4first', 'ipv6first']) {
        expect(() => lookup('127.0.0.1', { order: o }, cb)).not.toThrow();
      }
    });

    test('lookup: family accepts IPv4/IPv6 strings, rejects the rest', () => {
      const cb = () => {};
      expect(() => lookup('127.0.0.1', { family: 'IPv4' }, cb)).not.toThrow();
      expect(() => lookup('127.0.0.1', { family: 'IPv6' }, cb)).not.toThrow();
      expect(() => lookup('127.0.0.1', { family: '4' }, cb)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
      expect(() => lookup('127.0.0.1', { family: true }, cb)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    });

    test('resolve: non-string rrtype → ERR_INVALID_ARG_TYPE, unknown string → ERR_INVALID_ARG_VALUE', () => {
      const cb = () => {};
      expect(() => resolve('stub.test', [], cb)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => resolve('stub.test', 'BOGUS', cb)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    });

    test('lookupService: missing-args messages match Node', () => {
      const msg = 'The "address", "port", and "callback" arguments must be specified';
      expect(() => lookupService()).toThrow(msg);
      expect(() => lookupService('0.0.0.0')).toThrow(msg);
      expect(() => lookupService('0.0.0.0', 80)).toThrow(msg);
      expect(() => lookupService('fasdfdsaf', 0, () => {})).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    });
  });

  // ------------------------------------------------------------------
  // resolve* record shapes (stub server — exact assertions)
  // ------------------------------------------------------------------
  describe('resolve* record shapes', () => {
    beforeAll(() => setServers([stubBase]));
    afterAll(() => setServers(['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query']));

    test('resolve4', async () => {
      expect(await cbPromise(resolve4, 'stub.test').then(([r]) => r))
        .toEqual(['93.184.216.34', '93.184.216.35']);
    });

    test('resolve4 with { ttl: true }', async () => {
      expect(await cbPromise(resolve4, 'stub.test', { ttl: true }).then(([r]) => r)).toEqual([
        { address: '93.184.216.34', ttl: 100 },
        { address: '93.184.216.35', ttl: 200 },
      ]);
    });

    test('resolve6', async () => {
      expect(await cbPromise(resolve6, 'stub.test').then(([r]) => r))
        .toEqual(['2606:2800:220:1:248:1893:25c8:1946']);
    });

    test('resolveMx', async () => {
      expect(await cbPromise(resolveMx, 'stub.test').then(([r]) => r))
        .toEqual([{ priority: 10, exchange: 'mail.stub.test' }]);
    });

    test('resolveTxt splits quoted strings', async () => {
      expect(await cbPromise(resolveTxt, 'stub.test').then(([r]) => r))
        .toEqual([['hello', 'world'], ['bare-text']]);
    });

    test('resolveSrv', async () => {
      expect(await cbPromise(resolveSrv, '_srv.stub.test').then(([r]) => r)).toEqual([
        { priority: 10, weight: 20, port: 5060, name: 'sip.stub.test' },
      ]);
    });

    test('resolveSoa', async () => {
      expect(await cbPromise(resolveSoa, 'stub.test').then(([r]) => r)).toEqual({
        nsname: 'ns1.stub.test',
        hostmaster: 'hostmaster.stub.test',
        serial: 2024010101,
        refresh: 7200,
        retry: 3600,
        expire: 1209600,
        minttl: 300, // real Node calls this minttl (cares_wrap.cc), not minimum
      });
    });

    test('resolveCaa', async () => {
      expect(await cbPromise(resolveCaa, 'stub.test').then(([r]) => r))
        .toEqual([{ critical: 0, issue: 'letsencrypt.org' }]);
    });

    test('resolveNaptr', async () => {
      expect(await cbPromise(resolveNaptr, 'stub.test').then(([r]) => r)).toEqual([
        {
          flags: 's', service: 'SIP+D2U', regexp: '',
          replacement: '_sip._udp.stub.test', order: 10, preference: 100,
        },
      ]);
    });

    test('resolveTlsa', async () => {
      const [rec] = await cbPromise(resolveTlsa, '_443._tcp.stub.test').then(([r]) => r);
      // Field names match real Node v24 (cares_wrap.cc ParseTlsaReply).
      expect(rec.certUsage).toBe(3);
      expect(rec.selector).toBe(1);
      expect(rec.match).toBe(1);
      expect(rec.data).toBeInstanceOf(Uint8Array);
      expect(rec.data.length).toBe(21);
    });

    test('resolveCname', async () => {
      expect(await cbPromise(resolveCname, 'alias.stub.test').then(([r]) => r))
        .toEqual(['stub.test']);
    });

    test('A query follows CNAME chains', async () => {
      expect(await cbPromise(resolve4, 'cname-chain.stub.test').then(([r]) => r))
        .toEqual(['93.184.216.34', '93.184.216.35']);
    });

    test('resolvePtr', async () => {
      expect(await cbPromise(resolvePtr, '34.216.184.93.in-addr.arpa').then(([r]) => r))
        .toEqual(['host.stub.test']);
    });

    test('resolve defaults rrtype to A', async () => {
      expect(await cbPromise(resolve, 'stub.test').then(([r]) => r))
        .toEqual(['93.184.216.34', '93.184.216.35']);
    });

    test('resolve dispatches rrtype', async () => {
      expect(await cbPromise(resolve, 'stub.test', 'MX').then(([r]) => r))
        .toEqual([{ priority: 10, exchange: 'mail.stub.test' }]);
    });

    test('resolve rejects invalid rrtype (lowercase included)', () => {
      const cb = () => {};
      expect(() => resolve('stub.test', 'BOGUS', cb)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
      expect(() => resolve('stub.test', 'mx', cb)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    });

    test('resolveAny is ENOTIMP like real Node (c-ares deprecated ANY)', async () => {
      await expect(cbPromise(resolve, 'stub.test', 'ANY')).rejects.toMatchObject({
        code: 'ENOTIMP', syscall: 'queryAny', hostname: 'stub.test',
      });
      await expect(cbPromise(resolveAny, 'stub.test')).rejects.toMatchObject({
        code: 'ENOTIMP', syscall: 'queryAny',
      });
      const r = new Resolver();
      r.setServers([stubBase]);
      await expect(cbPromise(r.resolveAny.bind(r), 'stub.test')).rejects.toMatchObject({
        code: 'ENOTIMP', syscall: 'queryAny',
      });
    });

    test('NXDOMAIN → ENOTFOUND with query syscall', async () => {
      await expect(cbPromise(resolve4, 'gone.stub.test')).rejects.toMatchObject({
        code: 'ENOTFOUND', syscall: 'queryA', hostname: 'gone.stub.test',
      });
    });

    test('NOERROR with no answers → ENODATA', async () => {
      await expect(cbPromise(resolve4, 'empty.stub.test')).rejects.toMatchObject({
        code: 'ENODATA', syscall: 'queryA',
      });
    });

    test('SERVFAIL → ESERVFAIL', async () => {
      const prev = getServers();
      // Single failing server so no fallback masks the status mapping.
      setServers([stubBase]);
      await expect(cbPromise(resolve4, 'fail.stub.test')).rejects.toMatchObject({ code: 'ESERVFAIL' });
      setServers(prev);
    });

    test('resolveNs([]) throws ERR_INVALID_ARG_TYPE naming "name"', () => {
      expect(() => resolveNs([], () => {})).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' }));
      try { resolveNs([], () => {}); } catch (e) { expect(e.message).toMatch(/"name" argument/); }
    });

    test('missing callback throws ERR_INVALID_ARG_TYPE', () => {
      expect(() => resolve4('stub.test')).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => reverse('8.8.8.8')).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    });
  });

  // ------------------------------------------------------------------
  // reverse() / lookupService()
  // ------------------------------------------------------------------
  describe('reverse / lookupService', () => {
    beforeAll(() => setServers([stubBase]));
    afterAll(() => setServers(['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query']));

    test('reverse resolves PTR via stub', async () => {
      expect(await cbPromise(reverse, '93.184.216.34').then(([r]) => r))
        .toEqual(['host.stub.test']);
    });

    test('reverse throws EINVAL synchronously for non-IP', () => {
      const cb = () => {};
      expect(() => reverse('not-an-ip', cb)).toThrow(
        expect.objectContaining({ code: 'EINVAL', syscall: 'getHostByAddr' }));
      expect(() => reverse('999.1.1.1', cb)).toThrow(
        expect.objectContaining({ code: 'EINVAL' }));
    });

    test('lookupService validation mirrors Node', () => {
      const cb = () => {};
      expect(() => lookupService('notip', 80, cb)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
      expect(() => lookupService('127.0.0.1', 99999, cb)).toThrow(
        expect.objectContaining({ code: 'ERR_SOCKET_BAD_PORT' }));
      expect(() => lookupService('127.0.0.1', 'x', cb)).toThrow(
        expect.objectContaining({ code: 'ERR_SOCKET_BAD_PORT' }));
      expect(() => lookupService('127.0.0.1', () => {}, cb)).toThrow(
        expect.objectContaining({
          code: 'ERR_SOCKET_BAD_PORT',
          message: 'Port should be >= 0 and < 65536. Received function .',
        }));
      // Node's coded errors stringify as `TypeError [ERR_X]: message`.
      try {
        lookupService('127.0.0.1', 'x', cb);
        expect.unreachable();
      } catch (e) {
        expect(String(e)).toMatch(/^RangeError \[ERR_SOCKET_BAD_PORT\]: Port should be/);
      }
    });

    test('lookupService accepts numeric string ports like Node', async () => {
      const [host, service] = await cbPromise(lookupService, '127.0.0.1', '80');
      expect(host).toBe('localhost');
      expect(service).toBe('http');
    });
  });

  // ------------------------------------------------------------------
  // Resolver class
  // ------------------------------------------------------------------
  describe('Resolver', () => {
    test('constructor option validation mirrors Node', () => {
      expect(() => new Resolver({ timeout: 'x' })).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => new Resolver({ tries: 0 })).toThrow(
        expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
      expect(() => new Resolver({ tries: 'x' })).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => new Resolver({ maxTimeout: -1 })).toThrow(
        expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
      expect(() => new Resolver({ timeout: -0 })).not.toThrow();
      expect(() => new Resolver()).not.toThrow();
      expect(() => new Resolver(null)).not.toThrow();
      // integer vs range wording (Node v24)
      expect(() => new Resolver({ timeout: 4.2 })).toThrow(
        expect.objectContaining({ code: 'ERR_OUT_OF_RANGE', message: expect.stringContaining('must be an integer') }));
      expect(() => new Resolver({ timeout: 2147483648 })).toThrow(
        expect.objectContaining({ code: 'ERR_OUT_OF_RANGE', message: expect.stringContaining('>= -1 && <= 2147483647') }));
      expect(() => new Resolver({ timeout: -1 })).not.toThrow();
      expect(() => new Resolver({ timeout: 2147483647 })).not.toThrow();
      expect(() => new Resolver({ tries: 1.5 })).toThrow(
        expect.objectContaining({ code: 'ERR_OUT_OF_RANGE', message: expect.stringContaining('must be an integer') }));
      expect(() => new Resolver({ maxTimeout: 1.1 })).toThrow(
        expect.objectContaining({ code: 'ERR_OUT_OF_RANGE', message: expect.stringContaining('must be an integer') }));
      expect(() => new Resolver({ maxTimeout: 4294967295 })).not.toThrow();
      // regex-based official test needs the code inside String(err)
      try {
        new Resolver({ maxTimeout: -1 });
        expect.unreachable();
      } catch (e) {
        expect(String(e)).toMatch(/ERR_OUT_OF_RANGE/);
        expect(String(e)).toBe(
          'RangeError [ERR_OUT_OF_RANGE]: The value of "options.maxTimeout" is out of range. ' +
          'It must be >= 0 && <= 4294967295. Received -1');
      }
    });

    test('setLocalAddress family rules mirror Node', () => {
      const r = new Resolver();
      expect(() => r.setLocalAddress('127.0.0.1', '127.0.0.1')).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE', message: 'Cannot specify two IPv4 addresses.' }));
      expect(() => r.setLocalAddress('::1', '::1')).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE', message: 'Cannot specify two IPv6 addresses.' }));
      expect(() => r.setLocalAddress('127.0.0.1', '::1')).not.toThrow();
      expect(() => r.setLocalAddress('::1', '127.0.0.1')).not.toThrow();
      // ...but these are plain errors: no code in String(err) (matches Node)
      try {
        r.setLocalAddress('127.0.0.1', '127.0.0.1');
        expect.unreachable();
      } catch (e) {
        expect(String(e)).toBe('TypeError: Cannot specify two IPv4 addresses.');
      }
    });

    test('no lookup / setTimeout on Resolver (matches Node v24)', () => {
      const r = new Resolver();
      expect(typeof r.lookup).toBe('undefined');
      expect(typeof r.setTimeout).toBe('undefined');
      expect(typeof r.cancel).toBe('function');
      expect(typeof r.setLocalAddress).toBe('function');
    });

    test('getServers/setServers scoped per instance', () => {
      const r = new Resolver();
      expect(r.getServers().length).toBeGreaterThan(0);
      r.setServers(['https://dns.google/dns-query']);
      expect(r.getServers()).toEqual(['https://dns.google/dns-query']);
      expect(() => r.setServers(['bogus'])).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_IP_ADDRESS' }));
      // module-level servers untouched
      expect(getServers()[0]).toMatch(/^https:\/\/cloudflare/);
    });

    test('setLocalAddress', () => {
      const r = new Resolver();
      expect(r.setLocalAddress('127.0.0.1')).toBeUndefined();
      expect(() => r.setLocalAddress('::1')).not.toThrow(); // IPv6 accepted, like Node
      expect(() => r.setLocalAddress('1.2.3.4', '::1')).not.toThrow();
      expect(() => r.setLocalAddress('nope')).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
      expect(() => r.setLocalAddress()).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => r.setLocalAddress('1.2.3.4', 'bad')).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    });

    test('setServers refuses while queries are pending (ERR_DNS_SET_SERVERS_FAILED)', async () => {
      const r = new Resolver();
      r.setServers([stubBase]);
      const p = cbPromise(r.resolve4.bind(r), 'hang.stub.test');
      expect(() => r.setServers([stubBase])).toThrow(
        expect.objectContaining({ code: 'ERR_DNS_SET_SERVERS_FAILED' }));
      r.cancel();
      await expect(p).rejects.toMatchObject({ code: 'ECANCELLED' });
      r.setServers([stubBase]); // works again once the query settles
      expect(r.getServers()).toEqual([stubBase]);
    });

    test('instance resolves via its own servers', async () => {
      const r = new Resolver();
      r.setServers([stubBase]);
      const [recs] = await cbPromise(r.resolve4.bind(r), 'stub.test');
      expect(recs).toEqual(['93.184.216.34', '93.184.216.35']);
    });

    test('cancel() rejects in-flight queries with ECANCELLED', async () => {
      const r = new Resolver();
      r.setServers([stubBase]);
      const p = cbPromise(r.resolve4.bind(r), 'hang.stub.test');
      r.cancel();
      await expect(p).rejects.toMatchObject({ code: 'ECANCELLED' });
      // instance stays usable
      const [recs] = await cbPromise(r.resolve4.bind(r), 'stub.test');
      expect(recs.length).toBe(2);
    });

    test('timeout option → ETIMEOUT', async () => {
      const r = new Resolver({ timeout: 250 });
      r.setServers([stubBase]);
      await expect(cbPromise(r.resolve4.bind(r), 'hang.stub.test')).rejects.toMatchObject({
        code: 'ETIMEOUT', syscall: 'queryA',
      });
    }, 10000);
  });

  // ------------------------------------------------------------------
  // Live network (stable public domains; shapes only)
  // ------------------------------------------------------------------
  describe('live DoH (network)', () => {
    test('resolve4 returns IPv4 addresses', async () => {
      const [ips] = await cbPromise(resolve4, 'example.com');
      expect(ips.length).toBeGreaterThan(0);
      expect(ips.every((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip))).toBe(true);
    });

    test('resolve6 returns IPv6 addresses', async () => {
      const [ips] = await cbPromise(resolve6, 'example.com');
      expect(ips.length).toBeGreaterThan(0);
      expect(ips.every((ip) => ip.includes(':'))).toBe(true);
    });

    test('lookup returns address + family', async () => {
      const [address, family] = await cbPromise(lookup, 'example.com');
      expect(typeof address).toBe('string');
      expect([4, 6]).toContain(family);
    });

    test('resolveMx shape', async () => {
      const [mx] = await cbPromise(resolveMx, 'gmail.com');
      expect(mx.length).toBeGreaterThan(0);
      expect(mx[0]).toEqual(expect.objectContaining({
        priority: expect.any(Number), exchange: expect.any(String),
      }));
    });

    test('resolveTxt shape', async () => {
      const [txt] = await cbPromise(resolveTxt, 'google.com');
      expect(txt.length).toBeGreaterThan(0);
      expect(Array.isArray(txt[0])).toBe(true);
    });

    test('resolveSoa shape', async () => {
      const [soa] = await cbPromise(resolveSoa, 'example.com');
      expect(soa).toMatchObject({
        nsname: expect.any(String),
        hostmaster: expect.any(String),
        serial: expect.any(Number),
        refresh: expect.any(Number),
        retry: expect.any(Number),
        expire: expect.any(Number),
        minttl: expect.any(Number),
      });
    });

    test('resolveNs shape', async () => {
      const [ns] = await cbPromise(resolveNs, 'cloudflare.com');
      expect(ns.length).toBeGreaterThan(0);
      expect(typeof ns[0]).toBe('string');
    });

    test('resolveCaa shape', async () => {
      const [caa] = await cbPromise(resolveCaa, 'google.com');
      expect(caa.length).toBeGreaterThan(0);
      expect(caa[0]).toEqual(expect.objectContaining({ critical: expect.any(Number) }));
    });

    test('resolveSrv shape', async () => {
      const [srv] = await cbPromise(resolveSrv, '_sip._tcp.sip2sip.info');
      expect(srv.length).toBeGreaterThan(0);
      expect(srv[0]).toEqual(expect.objectContaining({
        priority: expect.any(Number), weight: expect.any(Number),
        port: expect.any(Number), name: expect.any(String),
      }));
    });

    test('resolveNaptr shape', async () => {
      const [naptr] = await cbPromise(resolveNaptr, 'sip2sip.info');
      expect(naptr.length).toBeGreaterThan(0);
      expect(naptr[0]).toEqual(expect.objectContaining({
        flags: expect.any(String), service: expect.any(String),
        order: expect.any(Number), preference: expect.any(Number),
      }));
    });

    test('reverse resolves PTR', async () => {
      const [hostnames] = await cbPromise(reverse, '8.8.8.8');
      expect(hostnames).toContain('dns.google');
    });

    test('lookupService maps address + well-known port', async () => {
      const [hostname, service] = await cbPromise(lookupService, '127.0.0.1', 80);
      expect(hostname).toBe('localhost');
      expect(service).toBe('http');
    });

    test('NXDOMAIN → ENOTFOUND', async () => {
      await expect(cbPromise(resolve4, 'nxdomain.invalid')).rejects.toMatchObject({ code: 'ENOTFOUND' });
    });

    test('promises.lookup resolves', async () => {
      const { address, family } = await promises.lookup('example.com');
      expect(typeof address).toBe('string');
      expect([4, 6]).toContain(family);
    });
  });
});
