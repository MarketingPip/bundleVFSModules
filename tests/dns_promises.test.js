import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';

import * as dnsPromisesNS from '../src/dns/promises.js';
import {
  Resolver,
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
  setServers,
  getServers,
  getDefaultResultOrder,
  setDefaultResultOrder,
} from '../src/dns/promises.js';

// Deterministic stub DoH server shared with the callback-API suite.
const STUB_ANSWERS = {
  'A|stub.test': { Status: 0, Answer: [
    { name: 'stub.test', type: 1, TTL: 100, data: '93.184.216.34' },
  ] },
  'MX|stub.test': { Status: 0, Answer: [
    { name: 'stub.test', type: 15, TTL: 300, data: '5 mail.stub.test.' },
  ] },
  'A|gone.stub.test': { Status: 3 },
  'A|empty.stub.test': { Status: 0 },
};

let stubServer;
let stubBase;

describe('dns/promises', () => {
  beforeAll(async () => {
    await new Promise((resolveStart) => {
      stubServer = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const key = `${u.searchParams.get('type')}|${u.searchParams.get('name')}`;
        if (u.searchParams.get('name') === 'hang.stub.test') return; // hang → cancel
        res.setHeader('content-type', 'application/dns-json');
        res.end(JSON.stringify(STUB_ANSWERS[key] || { Status: 3 }));
      });
      stubServer.listen(0, '127.0.0.1', () => {
        stubBase = `http://127.0.0.1:${stubServer.address().port}/dns-query`;
        resolveStart();
      });
    });
    setServers([stubBase]);
  });

  afterAll(async () => {
    setServers(['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']);
    await new Promise((r) => stubServer.close(r));
  });

  test('module namespace holds the promises API (no default export, like CJS require)', () => {
    expect(typeof dnsPromisesNS.lookup).toBe('function');
    expect(dnsPromisesNS.resolve4).toBe(resolve4);
    expect(dnsPromisesNS.Resolver).toBe(Resolver);
    expect('default' in dnsPromisesNS).toBe(false);
  });

  test('argument validation throws synchronously (like node:dns/promises)', () => {
    // These must throw — not return rejected promises.
    expect(() => resolveNs([])).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => resolve4(123)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => resolve('stub.test', 'BOGUS')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    expect(() => lookupService()).toThrow(
      expect.objectContaining({
        code: 'ERR_MISSING_ARGS',
        message: 'The "address" and "port" arguments must be specified',
      }));
    expect(() => lookupService('0.0.0.0')).toThrow(
      expect.objectContaining({ code: 'ERR_MISSING_ARGS' }));
    // A function in the options/rrtype slot is a sync type error (no callback
    // shift in the promises API) — matches node:dns/promises.
    expect(() => lookup('127.0.0.1', () => {})).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE', message: expect.stringContaining('"options"') }));
    expect(() => resolve('127.0.0.1', () => {})).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE', message: expect.stringContaining('"rrtype"') }));
  });

  test('resolve4 ignores a function options arg like node:dns/promises', async () => {
    const p = resolve4('stub.test', () => {});
    expect(typeof p.then).toBe('function');
    await expect(p).resolves.toEqual(['93.184.216.34']);
  });

  test('lookup: falsy hostnames resolve { address: null, family: 4 }', async () => {
    for (const v of ['', 0, NaN, null, undefined, false]) {
      await expect(lookup(v)).resolves.toEqual({ address: null, family: 4 });
    }
  });

  test('lookup returns { address, family }', async () => {
    const res = await lookup('stub.test');
    expect(res).toEqual({ address: '93.184.216.34', family: 4 });
  });

  test('lookup with all:true returns the array', async () => {
    const res = await lookup('stub.test', { all: true });
    expect(res).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  test('lookup rejects ENOTFOUND for NXDOMAIN', async () => {
    await expect(lookup('gone.stub.test')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  test('lookup validation throws like Node', () => {
    expect(() => lookup('stub.test', { family: 7 })).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
  });

  test('resolve4 / resolveMx shapes', async () => {
    expect(await resolve4('stub.test')).toEqual(['93.184.216.34']);
    expect(await resolveMx('stub.test')).toEqual([{ priority: 5, exchange: 'mail.stub.test' }]);
  });

  test('resolve dispatches rrtype, defaults to A', async () => {
    expect(await resolve('stub.test')).toEqual(['93.184.216.34']);
    expect(await resolve('stub.test', 'MX')).toEqual([{ priority: 5, exchange: 'mail.stub.test' }]);
    expect(() => resolve('stub.test', 'BOGUS')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
  });

  test('resolveAny rejects ENOTIMP like real Node (c-ares deprecated ANY)', async () => {
    await expect(resolveAny('stub.test')).rejects.toMatchObject({
      code: 'ENOTIMP', syscall: 'queryAny', hostname: 'stub.test',
    });
  });

  test('ENODATA for NOERROR-without-answers', async () => {
    await expect(resolve4('empty.stub.test')).rejects.toMatchObject({ code: 'ENODATA' });
  });

  test('Resolver instance is scoped and cancellable', async () => {
    const r = new Resolver();
    // Fresh instances use the default DoH servers, independent of the
    // module-level setServers (mirrors Node: instances use system DNS).
    expect(r.getServers()).toEqual([
      'https://cloudflare-dns.com/dns-query',
      'https://dns.google/resolve',
    ]);
    r.setServers(['https://dns.google/resolve']);
    expect(r.getServers()).toEqual(['https://dns.google/resolve']);

    const r2 = new Resolver();
    r2.setServers([stubBase]);
    const p = r2.resolve4('hang.stub.test');
    r2.cancel();
    await expect(p).rejects.toMatchObject({ code: 'ECANCELLED' });
  });

  test('setServers keeps callback and promises APIs in sync', () => {
    const prev = getServers();
    try {
      setServers(['https://dns.google/resolve']);
      expect(getServers()).toEqual(['https://dns.google/resolve']);
    } finally {
      setServers(prev);
    }
  });

  test('getDefaultResultOrder/setDefaultResultOrder', () => {
    expect(getDefaultResultOrder()).toBe('verbatim');
    setDefaultResultOrder('ipv6first');
    expect(getDefaultResultOrder()).toBe('ipv6first');
    setDefaultResultOrder('verbatim');
    expect(() => setDefaultResultOrder('nope')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
  });

  test('reverse validation', async () => {
    // non-IP literal → rejected promise (like node:dns/promises); non-string → sync throw
    await expect(reverse('not-an-ip')).rejects.toMatchObject({ code: 'EINVAL' });
    expect(() => reverse(123)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });

  test('lookupService validation', () => {
    expect(() => lookupService('notip', 80)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
  });

  test('live: resolve4 + resolveTxt + reverse', async () => {
    const prev = getServers();
    setServers(['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']);
    try {
      const ips = await resolve4('example.com');
      expect(ips.length).toBeGreaterThan(0);
      const txt = await resolveTxt('example.com');
      expect(Array.isArray(txt[0])).toBe(true);
      const hostnames = await reverse('8.8.8.8');
      expect(hostnames).toContain('dns.google');
    } finally {
      setServers(prev);
    }
  }, 60000);
});
