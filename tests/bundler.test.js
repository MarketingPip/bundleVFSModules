import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { bundle } from '../src/moduleLoader.js';

describe('moduleLoader public API', () => {
  let originalFetch;
  let blobUrls = [];

  beforeEach(() => {
    // Mock fetch globally
    originalFetch = global.fetch;
    global.fetch = jest.fn();

    // Mock blob URL creation & revocation
    blobUrls = [];
    global.URL.createObjectURL = jest.fn((blob) => {
      const url = `blob:fake-${blobUrls.length}`;
      blobUrls.push(url);
      return url;
    });
    global.URL.revokeObjectURL = jest.fn((url) => {
      const idx = blobUrls.indexOf(url);
      if (idx >= 0) blobUrls.splice(idx, 1);
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('bundles a simple module without dependencies', async () => {
    global.fetch.mockResolvedValue({ ok: true, text: () => Promise.resolve(`export const x = 42;`) });

    const { url, revoke } = await bundle('https://example.com/main.js');

    expect(url).toMatch(/^blob:fake-/);
    expect(blobUrls).toContain(url);

    // Dynamic import simulation (optional)
    const code = await (await fetch('https://example.com/main.js')).text();
    expect(code).toContain('export const x = 42;');

    revoke();
    expect(blobUrls).not.toContain(url);
  });

  test('bundles a module with relative dependencies and rewrites imports', async () => {
    global.fetch.mockImplementation((url) => {
      if (url.endsWith('main.js')) return Promise.resolve({ ok: true, text: () => Promise.resolve(`import './a.js'; import './b.js';`) });
      if (url.endsWith('a.js')) return Promise.resolve({ ok: true, text: () => Promise.resolve(`export const a = 1;`) });
      if (url.endsWith('b.js')) return Promise.resolve({ ok: true, text: () => Promise.resolve(`export const b = 2;`) });
      return Promise.reject(new Error('not found'));
    });

    const { url, revoke } = await bundle('https://example.com/main.js');

    // The returned URL should be a blob URL
    expect(url).toMatch(/^blob:fake-/);
    expect(blobUrls).toContain(url);

    // All created blob URLs should be revokable
    expect(blobUrls.length).toBe(3); // main.js + a.js + b.js
    revoke();
    expect(blobUrls.length).toBe(0);
  });

  test('throws if a fetch fails', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 404 });

    await expect(bundle('https://example.com/missing.js')).rejects.toThrow(/Fetch failed: 404/);
  });

  test('supports multiple bundles independently', async () => {
    global.fetch.mockImplementation((url) => Promise.resolve({ ok: true, text: () => Promise.resolve(`export const y = 123;`) }));

    const b1 = await bundle('https://example.com/one.js');
    const b2 = await bundle('https://example.com/two.js');

    expect(b1.url).not.toBe(b2.url);
    expect(blobUrls).toContain(b1.url);
    expect(blobUrls).toContain(b2.url);

    b1.revoke();
    expect(blobUrls).not.toContain(b1.url);
    expect(blobUrls).toContain(b2.url);

    b2.revoke();
    expect(blobUrls).toHaveLength(0);
  });
});
