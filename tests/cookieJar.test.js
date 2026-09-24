// tests/cookieJar.test.js — repo tests for src/cookieJar.js
//
// Lane A (top-level import): the jar is a pure module (no _RUNTIME_
// dependency), so it loads directly under Node. The set-cookie-parser
// dependency is exercised for real via splitCookiesString.
// Lane B: export surface of the module.
import { describe, test, expect } from '@jest/globals';
import {
  VirtualCookieJar,
  mergeCookieHeaders,
  cookieJarKey,
  canonicalHost,
  domainMatches,
  defaultPath,
  cookiePathMatches,
  parseSetCookie,
} from '../src/cookieJar.js';

const jar = () => new VirtualCookieJar();
const H = (host, extra = {}) => ({ host, path: '/', ...extra });

describe('export surface', () => {
  test('exposes the documented API', () => {
    expect(typeof VirtualCookieJar).toBe('function');
    expect(typeof mergeCookieHeaders).toBe('function');
    expect(typeof cookieJarKey).toBe('function');
    expect(typeof canonicalHost).toBe('function');
    expect(typeof domainMatches).toBe('function');
    expect(typeof defaultPath).toBe('function');
    expect(typeof cookiePathMatches).toBe('function');
    expect(typeof parseSetCookie).toBe('function');
    const j = jar();
    for (const m of ['store', 'cookieHeader', 'list', 'clearInstance', 'clearAll', 'isSecureOrigin', 'enforceLimits']) {
      expect(typeof j[m]).toBe('function');
    }
  });
});

describe('Domain', () => {
  test('domain cookie is sent to subdomains, host-only is not', () => {
    const j = jar();
    j.store('i', 3000, ['a=1; Domain=example.com', 'b=2'], H('api.example.com', { secure: true }));
    expect(j.cookieHeader('i', 3000, H('www.example.com', { secure: true }))).toBe('a=1');
    expect(j.cookieHeader('i', 3000, H('api.example.com', { secure: true }))).toBe('a=1; b=2');
    expect(j.cookieHeader('i', 3000, H('evil.com', { secure: true }))).toBe('');
  });
  test('rejects non-matching and public-suffix domains', () => {
    const rej = jar().store('i', 3000, ['a=1; Domain=other.com', 'b=1; Domain=com'], H('api.example.com'));
    expect(rej).toHaveLength(2);
  });
});

describe('Secure / prefixes', () => {
  test('Secure cookies need a secure context (localhost counts)', () => {
    const j = jar();
    j.store('i', 1, 'a=1; Secure', H('example.com', { secure: true }));
    expect(j.cookieHeader('i', 1, H('example.com', { secure: false }))).toBe('');
    j.store('i', 2, 'a=1; Secure', H('localhost'));
    expect(j.cookieHeader('i', 2, H('localhost'))).toBe('a=1');
  });
  test('__Host- rejects Domain', () => {
    const rej = jar().store('i', 1, '__Host-x=1; Secure; Path=/; Domain=example.com', H('example.com', { secure: true }));
    expect(rej[0].reason).toMatch(/__Host-/);
  });
  test('__Secure- requires Secure', () => {
    const rej = jar().store('i', 1, '__Secure-x=1', H('localhost'));
    expect(rej[0].reason).toMatch(/__Secure-/);
  });
});

describe('HttpOnly', () => {
  test('hidden from script reads', () => {
    const j = jar();
    j.store('i', 1, ['a=1; HttpOnly', 'b=2'], H('localhost'));
    expect(j.cookieHeader('i', 1, H('localhost', { script: true }))).toBe('b=2');
  });
  test('sent on network requests (no script flag)', () => {
    const j = jar();
    j.store('i', 1, ['a=1; HttpOnly', 'b=2'], H('localhost'));
    expect(j.cookieHeader('i', 1, H('localhost'))).toBe('a=1; b=2');
  });
});

describe('SameSite', () => {
  const setup = (attr) => {
    const j = jar();
    j.store('i', 1, `a=1; SameSite=${attr}; Secure`, H('localhost'));
    return j;
  };
  test('Strict is same-site only', () => {
    const j = setup('Strict');
    expect(j.cookieHeader('i', 1, H('localhost', { sameSite: false, topLevelNavigation: true }))).toBe('');
    expect(j.cookieHeader('i', 1, H('localhost'))).toBe('a=1');
  });
  test('Lax is sent on cross-site top-level GET only', () => {
    const j = setup('Lax');
    const x = { sameSite: false };
    expect(j.cookieHeader('i', 1, H('localhost', { ...x, topLevelNavigation: true, method: 'GET' }))).toBe('a=1');
    expect(j.cookieHeader('i', 1, H('localhost', { ...x, topLevelNavigation: true, method: 'POST' }))).toBe('');
    expect(j.cookieHeader('i', 1, H('localhost', { ...x, method: 'GET' }))).toBe('');
  });
  test('None requires Secure', () => {
    expect(jar().store('i', 1, 'a=1; SameSite=None', H('localhost'))[0].reason).toMatch(/Secure/);
  });
});

describe('Limits', () => {
  test('rejects oversize name+value', () => {
    expect(jar().store('i', 1, `a=${'x'.repeat(4097)}`, H('localhost'))).toHaveLength(1);
  });
  test('evicts least recently used past the per-domain cap', () => {
    const j = new VirtualCookieJar({ maxPerDomain: 3 });
    for (const n of ['a', 'b', 'c']) j.store('i', 1, `${n}=1`, H('localhost'));
    j.cookieHeader('i', 1, H('localhost')); // touch all, then add one more
    j.store('i', 1, 'd=1', H('localhost'));
    expect(j.list('i', 1)).toHaveLength(3);
    expect(j.list('i', 1).some((c) => c.name === 'd')).toBe(true);
  });
  test('same name, different path coexist', () => {
    const j = jar();
    j.store('i', 1, ['a=1; Path=/x', 'a=2; Path=/'], H('localhost'));
    expect(j.list('i', 1)).toHaveLength(2);
  });
});

describe('Domain boundary (supplementary)', () => {
  test('host that merely ends with the domain string does not match', () => {
    const j = jar();
    j.store('i', 3000, 'a=1; Domain=example.com', H('api.example.com', { secure: true }));
    expect(j.cookieHeader('i', 3000, H('notexample.com', { secure: true }))).toBe('');
    expect(j.cookieHeader('i', 3000, H('example.com.evil.com', { secure: true }))).toBe('');
  });
});

describe('expiry / deletion', () => {
  test('Max-Age=0 deletes the cookie', () => {
    const j = jar();
    j.store('i', 1, 'a=1', H('localhost'));
    expect(j.cookieHeader('i', 1, H('localhost'))).toBe('a=1');
    j.store('i', 1, 'a=gone; Max-Age=0', H('localhost'));
    expect(j.cookieHeader('i', 1, H('localhost'))).toBe('');
  });
  test('overwrite keeps creation time', () => {
    const j = jar();
    j.store('i', 1, 'a=1', H('localhost'));
    const [first] = j.list('i', 1);
    j.store('i', 1, 'a=2', H('localhost'));
    const [second] = j.list('i', 1);
    expect(second.created).toBe(first.created);
    expect(j.cookieHeader('i', 1, H('localhost'))).toBe('a=2');
  });
});

describe('mergeCookieHeaders', () => {
  test('jar cookies win on name conflicts, order is jar-first', () => {
    expect(mergeCookieHeaders('a=old; b=2', 'a=1')).toBe('a=1; b=2');
  });
  test('empty sides pass through', () => {
    expect(mergeCookieHeaders(undefined, '')).toBe('');
    expect(mergeCookieHeaders('a=1', '')).toBe('a=1');
    expect(mergeCookieHeaders('', 'b=2')).toBe('b=2');
  });
});

describe('helpers', () => {
  test('cookieJarKey joins with NUL', () => {
    expect(cookieJarKey('i', 3000)).toBe('i\u00003000');
  });
  test('canonicalHost normalizes', () => {
    expect(canonicalHost('  Example.COM. ')).toBe('example.com');
    expect(canonicalHost('[::1]')).toBe('::1');
  });
  test('defaultPath follows RFC 6265', () => {
    expect(defaultPath('/a/b/c')).toBe('/a/b');
    expect(defaultPath('/a')).toBe('/');
    expect(defaultPath('/')).toBe('/');
  });
  test('cookiePathMatches', () => {
    expect(cookiePathMatches('/a/b', '/a')).toBe(true);
    expect(cookiePathMatches('/ab', '/a')).toBe(false);
    expect(cookiePathMatches('/a', '/a/')).toBe(false);
  });
  test('clearInstance only clears that instance', () => {
    const j = jar();
    j.store('i1', 1, 'a=1', H('localhost'));
    j.store('i2', 1, 'b=2', H('localhost'));
    j.clearInstance('i1');
    expect(j.cookieHeader('i1', 1, H('localhost'))).toBe('');
    expect(j.cookieHeader('i2', 1, H('localhost'))).toBe('b=2');
    j.clearAll();
    expect(j.cookieHeader('i2', 1, H('localhost'))).toBe('');
  });
});
