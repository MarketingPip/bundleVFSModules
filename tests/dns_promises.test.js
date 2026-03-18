import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import dnsPromises, { Resolver } from '../src/dns/promises.js';

describe('dns/promises', () => {

  // ---------------------------
  // Resolver instance
  // ---------------------------
  let resolver;
  beforeAll(() => {
    resolver = new Resolver();
  });

  test('default servers are Cloudflare DoH', () => {
    expect(resolver.getServers()).toContain('https://cloudflare-dns.com/dns-query');
  });

  test('setServers updates resolver servers', () => {
    const servers = ['https://dns.google/dns-query'];
    resolver.setServers(servers);
    expect(resolver.getServers()).toEqual(servers);
  });

  // ---------------------------
  // lookup
  // ---------------------------
  test('lookup returns address and family', async () => {
    const res = await resolver.lookup('example.com');
    expect(res).toHaveProperty('address');
    expect(res).toHaveProperty('family');
  });

  test('lookup all option returns array', async () => {
    const res = await resolver.lookup('example.com', { all: true });
    expect(Array.isArray(res)).toBe(true);
    expect(res[0]).toHaveProperty('address');
  });

  // ---------------------------
  // resolve record types
  // ---------------------------
  test('resolve4 returns IPv4 addresses', async () => {
    const ips = await resolver.resolve4('example.com');
    expect(Array.isArray(ips)).toBe(true);
    expect(ips[0]).toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  test('resolve6 returns IPv6 addresses', async () => {
    const ips = await resolver.resolve6('google.com');
    if (ips.length) expect(ips[0]).toMatch(/:/); // IPv6 contains ':'
  });

  test('resolveMx returns MX records', async () => {
    const mx = await resolver.resolveMx('gmail.com');
    expect(mx.length).toBeGreaterThan(0);
    expect(mx[0]).toHaveProperty('exchange');
    expect(mx[0]).toHaveProperty('priority');
  });

  test('resolveNs returns NS records', async () => {
    const ns = await resolver.resolveNs('cloudflare.com');
    expect(ns.length).toBeGreaterThan(0);
  });

  test('resolveCname returns CNAME or empty', async () => {
    const cname = await resolver.resolveCname('www.google.com');
    expect(Array.isArray(cname)).toBe(true);
  });

  test('resolveTxt returns TXT records', async () => {
    const txt = await resolver.resolveTxt('google.com');
    expect(Array.isArray(txt)).toBe(true);
  });

  test('resolveSoa returns SOA record', async () => {
    const soa = await resolver.resolveSoa('example.com');
    expect(soa).toHaveProperty('nsname');
    expect(soa).toHaveProperty('hostmaster');
  });

  test('resolveCaa returns CAA records or throws ENODATA', async () => {
    try {
      const caa = await resolver.resolveCaa('example.com');
      expect(Array.isArray(caa)).toBe(true);
    } catch (err) {
      expect(err.code).toBe('ENODATA');
    }
  });

  test('resolveNaptr returns NAPTR records or throws ENODATA', async () => {
    try {
      const naptr = await resolver.resolveNaptr('sip2.example.com');
      expect(Array.isArray(naptr)).toBe(true);
    } catch (err) {
      expect(err.code).toBe('ENODATA');
    }
  });

  test('resolveAny returns multiple record types', async () => {
    const any = await resolver.resolveAny('example.com');
    expect(Array.isArray(any)).toBe(true);
    expect(any[0]).toHaveProperty('type');
  });

  // ---------------------------
  // reverse lookup
  // ---------------------------
  test('reverse returns PTR hostnames', async () => {
    const hostnames = await resolver.reverse('8.8.8.8');
    expect(Array.isArray(hostnames)).toBe(true);
    expect(hostnames[0]).toMatch(/\./);
  });

  test('reverse invalid IP throws EINVAL', async () => {
    await expect(resolver.reverse('not-an-ip')).rejects.toMatchObject({ code: 'EINVAL' });
  });

  // ---------------------------
  // cancellation
  // ---------------------------
  test('cancel rejects in-flight queries', async () => {
    const p = resolver.resolve4('example.com');
    resolver.cancel();
    await expect(p).rejects.toMatchObject({ code: 'ECANCELLED' });
  });

  // ---------------------------
  // default resolver exports
  // ---------------------------
  test('default resolve4 works', async () => {
    const ips = await dnsPromises.resolve4('example.com');
    expect(Array.isArray(ips)).toBe(true);
  });

  test('default setServers updates server list', () => {
    dnsPromises.setServers(['https://dns.google/dns-query']);
    expect(dnsPromises.getServers()).toContain('https://dns.google/dns-query');
  });

  // ---------------------------
  // error handling
  // ---------------------------
  test('resolve unknown rrtype rejects', async () => {
    await expect(resolver.resolve('example.com', 'UNKNOWN')).rejects.toThrow(TypeError);
  });
});
