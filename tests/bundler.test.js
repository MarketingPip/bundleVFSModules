import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import * as moduleLoader from '../dist/RUNTIME_BUNDLER.js';

describe('moduleLoader', () => {
  let originalFetch;
  let blobUrls = [];

  beforeEach(() => {
    // Mock fetch
    originalFetch = global.fetch;
    global.fetch = jest.fn();

    // Mock URL.createObjectURL and revokeObjectURL
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

  // ==========================
  // URL resolution
  // ==========================
  describe('resolveImport', () => {
    const { resolveImport } = moduleLoader;

    test('resolves absolute HTTP(S) URLs as-is', () => {
      expect(resolveImport('https://cdn.com/foo.js', 'https://example.com/main.js'))
        .toBe('https://cdn.com/foo.js');
    });

    test('resolves root-relative URLs', () => {
      expect(resolveImport('/bar.js', 'https://example.com/path/main.js'))
        .toBe('https://example.com/bar.js');
    });

    test('resolves relative URLs', () => {
      expect(resolveImport('./baz.js', 'https://example.com/path/main.js'))
        .toBe('https://example.com/path/baz.js');
      expect(resolveImport('../up.js', 'https://example.com/path/main.js'))
        .toBe('https://example.com/up.js');
    });

    test('throws on bare specifier', () => {
      expect(() => resolveImport('lodash', 'https://example.com/main.js'))
        .toThrow(/Bare specifier/);
    });
  });

  // ==========================
  // extractImports
  // ==========================
  describe('extractImports', () => {
    const { extractImports } = moduleLoader;

    test('extracts static imports', () => {
      const code = `import a from './a.js'; export { b } from './b.js';`;
      const hits = extractImports(code, 'https://site.com/main.js');
      expect(hits.map(h => h.url)).toEqual([
        'https://site.com/a.js',
        'https://site.com/b.js'
      ]);
    });

    test('extracts dynamic import expressions', () => {
      const code = `const mod = import('./dyn.js');`;
      const hits = extractImports(code, 'https://site.com/main.js');
      expect(hits.map(h => h.url)).toEqual(['https://site.com/dyn.js']);
    });

    test('returns empty array on parse error', () => {
      const code = `module.exports = 123;`;
      expect(extractImports(code, 'https://site.com/main.js')).toEqual([]);
    });
  });

  // ==========================
  // collectModules
  // ==========================
  describe('collectModules', () => {
    const { collectModules } = moduleLoader;

    test('collects modules and dependencies', async () => {
      // Setup fetch mocks
      global.fetch.mockImplementation((url) => {
        if (url.endsWith('a.js')) return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
        if (url.endsWith('b.js')) return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
        if (url.endsWith('main.js')) return Promise.resolve({ ok: true, text: () => Promise.resolve(`import './a.js'; import './b.js';`) });
        return Promise.reject(new Error('not found'));
      });

      const { modules, deps } = await collectModules('https://site.com/main.js');
      expect(modules.size).toBe(3);
      expect(deps.get('https://site.com/main.js')).toEqual([
        'https://site.com/a.js',
        'https://site.com/b.js'
      ]);
    });
  });

  // ==========================
  // topoSort
  // ==========================
  describe('topoSort', () => {
    const { topoSort } = moduleLoader;

    test('orders modules leaves-first', () => {
      const deps = new Map();
      deps.set('main', ['a', 'b']);
      deps.set('a', ['c']);
      deps.set('b', []);
      deps.set('c', []);
      const order = topoSort('main', deps);
      expect(order.indexOf('c')).toBeLessThan(order.indexOf('a'));
      expect(order.indexOf('a')).toBeLessThan(order.indexOf('main'));
      expect(order.indexOf('b')).toBeLessThan(order.indexOf('main'));
    });
  });

  // ==========================
  // bundle
  // ==========================
  describe('bundle', () => {
    const { bundle } = moduleLoader;

    test('creates blob URLs and allows revoking', async () => {
      global.fetch.mockImplementation((url) => {
        if (url.endsWith('main.js')) return Promise.resolve({ ok: true, text: () => Promise.resolve(`import './a.js';`) });
        if (url.endsWith('a.js')) return Promise.resolve({ ok: true, text: () => Promise.resolve(`export const a=1;`) });
        return Promise.reject(new Error('not found'));
      });

      const { url, revoke } = await bundle('https://site.com/main.js');
      expect(blobUrls).toContain(url);
      expect(global.URL.createObjectURL).toHaveBeenCalled();
      expect(typeof revoke).toBe('function');

      revoke();
      expect(blobUrls).not.toContain(url);
    });
  });

  // ==========================
  // fetchModule caching
  // ==========================
  describe('fetchModule caching', () => {
    const { fetchModule } = moduleLoader;

    test('returns the same promise for repeated fetches', async () => {
      let calls = 0;
      global.fetch.mockImplementation((url) => { calls++; return Promise.resolve({ ok: true, text: () => Promise.resolve('') }); });

      const p1 = fetchModule('https://site.com/x.js');
      const p2 = fetchModule('https://site.com/x.js');
      expect(p1).toBe(p2);
      await p1;
      expect(calls).toBe(1);
    });
  });
});
