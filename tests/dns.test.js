import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
 
import dnsWrapper, {
  lookup,
  resolve,
  resolve4,
  resolve6,
  resolveMx,
  resolveNs,
  resolveCname,
  resolveTxt,
  resolveSrv,
  resolveSoa,
  setServers,
  getServers,
  promises
} from '../src/dns'; // adjust path as needed

describe('dohjs-based DNS wrapper', () => {

  const TEST_DOMAIN = 'example.com'; // known stable domain
  const INVALID_DOMAIN = 'nxdomain.invalid';

  // ---------------------------
  // Server management
  // ---------------------------
  test('setServers / getServers works', () => {
    setServers(['https://cloudflare-dns.com/dns-query']);
    expect(getServers()).toEqual(['https://cloudflare-dns.com/dns-query']);

    // invalid input
    expect(() => setServers([])).toThrow('setServers requires a non-empty array of DoH URLs');
  });

  // ---------------------------
  // Lookup
  // ---------------------------
  test('lookup resolves A and AAAA records', async () => {
    const res = await promises.lookup(TEST_DOMAIN, { all: true });
    expect(res).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ address: expect.any(String), family: expect.any(Number) })
      ])
    );
  });

  test('lookup rejects invalid hostname', async () => {
    await expect(promises.lookup('')).rejects.toMatchObject({ code: 'EINVAL' });
  });

  // ---------------------------
  // resolve4 / resolve6
  // ---------------------------
  test('resolve4 returns IPv4 addresses', async () => {
    const ips = await promises.resolve4(TEST_DOMAIN);
    expect(ips.every(ip => typeof ip === 'string')).toBe(true);
  });

  test('resolve6 returns IPv6 addresses', async () => {
    const ips = await promises.resolve6(TEST_DOMAIN);
    expect(ips.every(ip => typeof ip === 'string')).toBe(true);
  });

  test('resolve rejects unknown domain', async () => {
    await expect(promises.resolve4(INVALID_DOMAIN)).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  // ---------------------------
  // MX / NS / CNAME / TXT
  // ---------------------------
  test('resolveMx returns records or ENOTFOUND', async () => {
    try {
      const mx = await promises.resolveMx(TEST_DOMAIN);
      expect(mx).toEqual(expect.arrayContaining([
        expect.objectContaining({ priority: expect.any(Number), exchange: expect.any(String) })
      ]));
    } catch (err) {
      expect(err.code).toBe('ENOTFOUND');
    }
  });

  test('resolveNs returns records or ENOTFOUND', async () => {
    try {
      const ns = await promises.resolveNs(TEST_DOMAIN);
      expect(ns).toEqual(expect.arrayContaining([expect.any(String)]));
    } catch (err) {
      expect(err.code).toBe('ENOTFOUND');
    }
  });

  test('resolveCname returns CNAME array or ENOTFOUND', async () => {
    try {
      const cname = await promises.resolveCname(TEST_DOMAIN);
      expect(Array.isArray(cname)).toBe(true);
    } catch (err) {
      expect(err.code).toBe('ENOTFOUND');
    }
  });

  test('resolveTxt returns TXT records or ENOTFOUND', async () => {
    try {
      const txt = await promises.resolveTxt(TEST_DOMAIN);
      expect(txt).toEqual(expect.arrayContaining([expect.any(Array)]));
    } catch (err) {
      expect(err.code).toBe('ENOTFOUND');
    }
  });

  // ---------------------------
  // SRV / SOA
  // ---------------------------
  test('resolveSrv returns SRV records or ENOTFOUND', async () => {
    try {
      const srv = await promises.resolveSrv(TEST_DOMAIN);
      expect(srv).toEqual(expect.arrayContaining([
        expect.objectContaining({
          priority: expect.any(Number),
          weight: expect.any(Number),
          port: expect.any(Number),
          name: expect.any(String)
        })
      ]));
    } catch (err) {
      expect(err.code).toBe('ENOTFOUND');
    }
  });

test('resolveSoa returns SOA record for example.com', async () => {
  const soa = await promises.resolveSoa(TEST_DOMAIN);
  expect(soa).toMatchObject({
    serial: expect.any(Number),
    refresh: expect.any(Number),
    retry: expect.any(Number),
    expire: expect.any(Number),
    minimum: expect.any(Number),
  });
});

  // ---------------------------
  // Error handling
  // ---------------------------
  test('normalizeHostname throws for invalid URL', async () => {
    await expect(promises.resolve4('')).rejects.toMatchObject({ code: 'EINVAL' });
  });

  test('callback APIs call back asynchronously', done => {
    resolve4(TEST_DOMAIN, (err, ips) => {
      expect(err).toBeNull();
      expect(ips.length).toBeGreaterThan(0);
      done();
    });
  });

});
