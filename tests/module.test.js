// Repo tests for src/module.js — the node:module browser port.
//
// Every expectation below was verified against real Node v24.20.0 before
// being asserted. `real` is the genuine builtin; `shim` is our port.
import * as shim from '../src/module.js';
import * as real from 'node:module';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Module } = shim;

const tmpDirs = [];
function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-module-test-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function throwsCode(fn, code) {
  try {
    fn();
  } catch (e) {
    expect(e.code).toBe(code);
    return e;
  }
  throw new Error(`expected throw with code ${code}`);
}

// ---------------------------------------------------------------------------
// Export surface
// ---------------------------------------------------------------------------
describe('export surface', () => {
  test('ESM named exports match node:module exactly', () => {
    const realKeys = Object.keys(real).filter((k) => k !== 'default').sort();
    const shimKeys = Object.keys(shim).filter((k) => k !== 'default').sort();
    expect(shimKeys).toEqual(realKeys);
  });

  test('default export is the Module class', () => {
    expect(shim.default).toBe(shim.Module);
    expect(real.default).toBe(real.Module);
  });

  test('Module.Module === Module', () => {
    expect(shim.Module.Module).toBe(shim.Module);
  });

  test('Module.prototype own properties match real', () => {
    // Verified directly against Node v24.20.0 (both CJS and ESM namespaces):
    // jest's --experimental-vm-modules exposes a reduced Module.prototype
    // for node:module, so the real list is asserted literally here.
    expect(Object.getOwnPropertyNames(shim.Module.prototype).sort()).toEqual([
      '_compile', 'constructor', 'isPreloading', 'load', 'parent', 'require',
    ]);
  });

  test('SourceMap.prototype own properties match real', () => {
    expect(Object.getOwnPropertyNames(shim.SourceMap.prototype).sort())
      .toEqual(Object.getOwnPropertyNames(real.SourceMap.prototype).sort());
  });
});

// ---------------------------------------------------------------------------
// builtinModules / isBuiltin
// ---------------------------------------------------------------------------
describe('builtinModules / isBuiltin', () => {
  test('builtinModules is frozen and identical to real', () => {
    expect(Object.isFrozen(shim.builtinModules)).toBe(true);
    expect([...shim.builtinModules]).toEqual([...real.builtinModules]);
    expect(shim.builtinModules.length).toBe(72);
    expect(shim.builtinModules).toContain('node:test/reporters');
    expect(shim.builtinModules).toContain('node:sea');
    expect(shim.builtinModules).toContain('node:sqlite');
  });

  test.each([
    ['fs', true],
    ['node:fs', true],
    ['fs/promises', true],
    ['node:test/reporters', true],
    ['test', false], // scheme-only: only the node:-prefixed form is a builtin
    ['sea', false],
    ['node:sea', true],
    ['sqlite', false],
    ['node:sqlite', true],
    ['sys', true],
    ['node:sys', true],
    ['assert/strict', true],
    ['_http_agent', true],
    ['node:_http_agent', true],
    ['nope', false],
    ['node:nope', false],
    ['', false],
    ['node:', false],
    ['fs/extra/deep', false],
    ['internal/fs', false],
    ['node:internal/fs', false],
  ])('isBuiltin(%p) === %p', (name, expected) => {
    expect(shim.isBuiltin(name)).toBe(expected);
    expect(shim.isBuiltin(name)).toBe(real.isBuiltin(name));
  });

  test('isBuiltin() with no args is false (does not throw)', () => {
    expect(shim.isBuiltin()).toBe(false);
    expect(real.isBuiltin()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// wrap / wrapper
// ---------------------------------------------------------------------------
describe('wrap', () => {
  test('Module.wrap matches real', () => {
    expect(shim.Module.wrap('x')).toBe(real.Module.wrap('x'));
    expect(shim.Module.wrap('const a = 1;'))
      .toBe(real.Module.wrap('const a = 1;'));
  });

  test('Module.wrapper matches real', () => {
    expect(shim.Module.wrapper).toEqual(real.Module.wrapper);
  });
});

// ---------------------------------------------------------------------------
// Module class
// ---------------------------------------------------------------------------
describe('Module class', () => {
  test('constructor defaults match real', () => {
    const m = new Module('myid');
    expect(m.id).toBe('myid');
    expect(m.path).toBe('.');
    expect(m.filename).toBe(null);
    expect(m.loaded).toBe(false);
    expect(m.children).toEqual([]);
    expect(m.exports).toEqual({});
    const r = new real.Module('myid');
    expect(m.id).toBe(r.id);
    expect(m.path).toBe(r.path);
    expect(m.filename).toBe(r.filename);
    expect(m.loaded).toBe(r.loaded);
  });

  test('parent linkage via constructor', () => {
    const p = new Module('p');
    const c = new Module('c', p);
    expect(p.children).toContain(c);
    expect(p.children.length).toBe(1);
  });

  test('require validates its argument', () => {
    const m = new Module('x');
    const e1 = throwsCode(() => m.require(42), 'ERR_INVALID_ARG_TYPE');
    expect(String(e1)).toBe(String((() => {
      try { new real.Module('x').require(42); } catch (e) { return e; }
    })()));
    const e2 = throwsCode(() => m.require(''), 'ERR_INVALID_ARG_VALUE');
    expect(e2.message).toBe("The argument 'id' must be a non-empty string. Received ''");
  });

  test('_cache / _extensions / _pathCache have null prototype', () => {
    for (const [name, o] of [['_cache', shim._cache], ['_extensions', shim._extensions], ['_pathCache', shim._pathCache]]) {
      expect([name, Object.getPrototypeOf(o)]).toEqual([name, null]);
    }
  });
});

// ---------------------------------------------------------------------------
// _nodeModulePaths
// ---------------------------------------------------------------------------
describe('_nodeModulePaths', () => {
  test.each([
    '/a/b/c',
    '/',
    '/a/node_modules/b',
    '/x/y/z/',
    '/a//b/../c',
  ])('_nodeModulePaths(%p) matches real', (p) => {
    expect(shim._nodeModulePaths(p)).toEqual(real._nodeModulePaths(p));
  });

  test('node_modules dirs are treated like any other dir', () => {
    // Real Node includes /a/node_modules/b/node_modules — verified v24.20.0.
    expect(shim._nodeModulePaths('/a/node_modules/b'))
      .toEqual(['/a/node_modules/b/node_modules', '/a/node_modules', '/node_modules']);
  });
});

// ---------------------------------------------------------------------------
// Loading from the real filesystem (parity lane: no runtime attached)
// ---------------------------------------------------------------------------
describe('loading', () => {
  let dir;
  beforeAll(() => {
    dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'a.js'), 'module.exports = 40 + 2;');
    fs.writeFileSync(
      path.join(dir, 'b.js'),
      'const a = require("./a.js"); module.exports = a * 2;',
    );
    fs.writeFileSync(
      path.join(dir, 'data.json'),
      JSON.stringify({ hello: 'world' }),
    );
    fs.mkdirSync(path.join(dir, 'pkg'));
    fs.writeFileSync(
      path.join(dir, 'pkg', 'package.json'),
      JSON.stringify({ main: 'entry.js' }),
    );
    fs.writeFileSync(
      path.join(dir, 'pkg', 'entry.js'),
      'module.exports = "pkg-entry";',
    );
    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'node_modules', 'dep', 'package.json'),
      JSON.stringify({ main: 'index.js' }),
    );
    fs.writeFileSync(
      path.join(dir, 'node_modules', 'dep', 'index.js'),
      'module.exports = "dep-index";',
    );
  });

  test('require executes module code and caches', () => {
    const req = shim.createRequire(path.join(dir, 'b.js'));
    expect(req('./b.js')).toBe(84);
    expect(req('./a.js')).toBe(42);
    // Cached: same exports object identity via Module._cache.
    const filename = path.join(dir, 'a.js');
    expect(Module._cache[filename].exports).toBe(42);
  });

  test('json extension', () => {
    const req = shim.createRequire(path.join(dir, 'b.js'));
    expect(req('./data.json')).toEqual({ hello: 'world' });
  });

  test('package main resolution', () => {
    const req = shim.createRequire(path.join(dir, 'b.js'));
    expect(req('./pkg')).toBe('pkg-entry');
  });

  test('node_modules lookup', () => {
    const req = shim.createRequire(path.join(dir, 'b.js'));
    expect(req('dep')).toBe('dep-index');
  });

  test('missing module throws MODULE_NOT_FOUND with require stack', () => {
    const req = shim.createRequire(path.join(dir, 'b.js'));
    const e = throwsCode(() => req('./nope.js'), 'MODULE_NOT_FOUND');
    expect(e.message).toContain("Cannot find module './nope.js'");
    expect(e.message).toContain('Require stack:');
    // Plain error: no [CODE] in the string form, like real Node.
    expect(String(e).startsWith('Error: Cannot find module')).toBe(true);
    expect(e.requireStack).toContain(path.join(dir, 'b.js'));
  });

  test('failed load removes the cache entry (let success = false)', () => {
    const req = shim.createRequire(path.join(dir, 'b.js'));
    const target = path.join(dir, 'missing2.js');
    expect(Module._cache[target]).toBe(undefined);
    expect(() => req('./missing2.js')).toThrow();
    expect(Module._cache[target]).toBe(undefined);
  });

  test('circular requires terminate', () => {
    const cdir = makeTmp();
    fs.writeFileSync(cdir + '/c1.js', 'require("./c2.js"); module.exports = "c1";');
    fs.writeFileSync(cdir + '/c2.js', 'require("./c1.js"); module.exports = "c2";');
    const req = shim.createRequire(cdir + '/c1.js');
    expect(req('./c1.js')).toBe('c1');
  });

  test('builtin require delegates to the real builtin under Node', () => {
    const req = shim.createRequire(path.join(dir, 'b.js'));
    expect(req('node:fs')).toBe(fs);
    expect(req('fs')).toBe(fs);
  });

  test('require.resolve matches real for files', () => {
    const req = shim.createRequire(path.join(dir, 'b.js'));
    expect(req.resolve('./a.js')).toBe(path.join(dir, 'a.js'));
    expect(req.resolve('dep')).toBe(path.join(dir, 'node_modules', 'dep', 'index.js'));
  });

  test('require.resolve.paths matches real', () => {
    // jest's createRequire is not Node's, so the expected value is built
    // from the same inputs real Node uses (verified directly on v24.20.0).
    const req = shim.createRequire(path.join(dir, 'b.js'));
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const prefix = path.dirname(path.dirname(process.execPath));
    const expected = [
      path.join(dir, 'node_modules'),
      path.join(path.dirname(dir), 'node_modules'),
      '/node_modules',
      path.join(home, '.node_modules'),
      path.join(home, '.node_libraries'),
      path.join(prefix, 'lib', 'node'),
    ];
    expect(req.resolve.paths('dep')).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// createRequire validation (messages verified against real Node)
// ---------------------------------------------------------------------------
describe('createRequire', () => {
  test('accepts absolute paths and file URLs', () => {
    expect(typeof shim.createRequire('/tmp/x.js')).toBe('function');
    expect(typeof shim.createRequire(new URL('file:///tmp/x.js'))).toBe('function');
    expect(typeof shim.createRequire('file:///tmp/x.js')).toBe('function');
  });

  test('rejects invalid filenames like real Node', () => {
    // Messages verified directly against Node v24.20.0. (Under jest,
    // `real.createRequire` is jest's own require, so literals are used.)
    const expected = (received) =>
      `TypeError [ERR_INVALID_ARG_VALUE]: The argument 'filename' must be ` +
      `a file URL object, file URL string, or absolute path string. Received ${received}`;
    for (const [v, r] of [[undefined, 'undefined'], [42, '42'], ['not a url ???', "'not a url ???'"]]) {
      let mine;
      try { shim.createRequire(v); } catch (e) { mine = String(e); }
      expect(mine).toBe(expected(r));
    }
  });

  test('created require has the documented shape', () => {
    const req = shim.createRequire('/tmp/x.js');
    const keys = Object.keys(req).sort();
    expect(keys).toEqual(Object.keys(real.createRequire('/tmp/x.js')).sort());
    expect(req.main).toBe(undefined);
    expect(req.extensions).toBe(shim._extensions);
    expect(req.cache).toBe(shim._cache);
    expect(typeof req.resolve.paths).toBe('function');
  });

  test('resolve validates like real Node', () => {
    // Literals verified directly against Node v24.20.0 (jest's
    // createRequire is not Node's).
    const req = shim.createRequire('/tmp/x.js');
    const cases = [
      [[], 'TypeError [ERR_INVALID_ARG_TYPE]: The "request" argument must be of type string. Received undefined'],
      [[42], 'TypeError [ERR_INVALID_ARG_TYPE]: The "request" argument must be of type string. Received type number (42)'],
      [['y', { paths: 'nope' }], "TypeError [ERR_INVALID_ARG_VALUE]: The property 'options.paths' is invalid. Received 'nope'"],
      [['y', { paths: [1] }], 'TypeError [ERR_INVALID_ARG_TYPE]: The "paths[0]" argument must be of type string. Received type number (1)'],
    ];
    for (const [args, expected] of cases) {
      let mine;
      try { req.resolve(...args); } catch (e) { mine = String(e); }
      expect(mine).toBe(expected);
    }
  });

  test('resolve.paths validates like real Node', () => {
    const req = shim.createRequire('/tmp/x.js');
    let mine;
    try { req.resolve.paths(42); } catch (e) { mine = String(e); }
    expect(mine).toBe(
      'TypeError [ERR_INVALID_ARG_TYPE]: The "request" argument must be of type string. Received type number (42)',
    );
    try { req.resolve.paths(); } catch (e) { mine = String(e); }
    expect(mine).toBe(
      'TypeError [ERR_INVALID_ARG_TYPE]: The "request" argument must be of type string. Received undefined',
    );
  });
});

// ---------------------------------------------------------------------------
// Error string forms ([CODE] in toString for internal errors only)
// ---------------------------------------------------------------------------
describe('error forms', () => {
  test('ERR_INVALID_ARG_TYPE includes [CODE] in String(err)', () => {
    const e = throwsCode(() => shim.createRequire('/tmp/x.js').resolve.paths(42), 'ERR_INVALID_ARG_TYPE');
    expect(String(e)).toMatch(/^TypeError \[ERR_INVALID_ARG_TYPE\]: /);
  });

  test('MODULE_NOT_FOUND has no [CODE] in String(err)', () => {
    const e = throwsCode(
      () => shim.createRequire('/tmp/x.js').resolve('definitely-missing-xyz'),
      'MODULE_NOT_FOUND',
    );
    // Plain Error: String(err) is "Error: <message>", with no [CODE] marker.
    expect(String(e)).toBe(`Error: ${e.message}`);
    expect(String(e)).not.toMatch(/\[MODULE_NOT_FOUND\]/);
    expect(String(e).startsWith('Error: Cannot find module')).toBe(true);
  });

  test('received-value rendering matches real Node', () => {
    const vals = [{}, [], 1, null, 'x', () => {}, new Date()];
    for (const v of vals) {
      let mine; let theirs;
      try { shim.setSourceMapsSupport(true, { nodeModules: v }); } catch (e) { mine = String(e); }
      try { real.setSourceMapsSupport(true, { nodeModules: v }); } catch (e) { theirs = String(e); }
      expect(mine).toBe(theirs);
    }
  });
});

// ---------------------------------------------------------------------------
// Compile cache (honest noop: the browser cannot emit V8 code cache)
// ---------------------------------------------------------------------------
describe('compile cache', () => {
  test('constants match real', () => {
    expect(shim.constants).toEqual(real.constants);
    expect(shim.constants.compileCacheStatus).toEqual({
      FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3,
    });
  });

  test('enableCompileCache reports FAILED (cannot work in browser)', () => {
    expect(shim.enableCompileCache()).toEqual({ status: 0, directory: undefined });
    expect(shim.enableCompileCache('/tmp/x').status)
      .toBe(real.constants.compileCacheStatus.FAILED);
  });

  test('getCompileCacheDir / flushCompileCache', () => {
    expect(shim.getCompileCacheDir()).toBe(undefined);
    expect(shim.flushCompileCache()).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// Source-map support flags + SourceMap decoder
// ---------------------------------------------------------------------------
describe('source maps', () => {
  test('getSourceMapsSupport default matches real', () => {
    expect(shim.getSourceMapsSupport()).toEqual(
      JSON.parse(JSON.stringify(real.getSourceMapsSupport())),
    );
  });

  test('setSourceMapsSupport validates like real', () => {
    for (const args of [[null], ['x'], [true, null], [true, 5], [true, { nodeModules: 1 }]]) {
      let mine; let theirs;
      try { shim.setSourceMapsSupport(...args); } catch (e) { mine = String(e); }
      try { real.setSourceMapsSupport(...args); } catch (e) { theirs = String(e); }
      expect(mine).toBe(theirs);
    }
    shim.setSourceMapsSupport(true, { nodeModules: true, generatedCode: false });
    expect(shim.getSourceMapsSupport().enabled).toBe(true);
    expect(Object.isFrozen(shim.getSourceMapsSupport())).toBe(true);
    shim.setSourceMapsSupport(false);
    expect(shim.getSourceMapsSupport().enabled).toBe(false);
  });

  test('SourceMap decodes like real', () => {
    const payload = {
      version: 3,
      sources: ['a.js'],
      names: ['n'],
      mappings: 'AAAA,SAASA',
      sourcesContent: ['var a;'],
    };
    const s1 = new shim.SourceMap(payload);
    const s2 = new real.SourceMap(payload);
    expect(s1.findEntry(0, 0)).toEqual(s2.findEntry(0, 0));
    expect(s1.findOrigin(1, 1)).toEqual(s2.findOrigin(1, 1));
    expect(s1.payload).toEqual(s2.payload);
    // payload is a defensive copy
    s1.payload.sources.push('evil');
    expect(s1.payload.sources).toEqual(['a.js']);
    expect(s1.lineLengths).toBe(undefined);
    expect(new shim.SourceMap(payload, { lineLengths: [5, 3] }).lineLengths)
      .toEqual([5, 3]);
  });

  test('findSourceMap returns undefined for unknown sources', () => {
    expect(shim.findSourceMap('/no/such/file.js')).toBe(undefined);
    expect(shim.findSourceMap(42)).toBe(undefined);
    expect(shim.findSourceMap('node:fs')).toBe(undefined);
  });

  test('findSourceMap finds maps registered by _compile', () => {
    const dir = makeTmp();
    const map = {
      version: 3,
      sources: ['orig.js'],
      names: [],
      mappings: 'AAAA',
    };
    const b64 = Buffer.from(JSON.stringify(map)).toString('base64');
    const file = path.join(dir, 'mapped.js');
    fs.writeFileSync(
      file,
      'module.exports = 1;\n//# sourceMappingURL=data:application/json;base64,' + b64,
    );
    const m = new Module(file);
    m.load(file);
    const sm = shim.findSourceMap(file);
    expect(sm).toBeInstanceOf(shim.SourceMap);
    expect(sm.payload.sources).toEqual(['orig.js']);
  });
});

// ---------------------------------------------------------------------------
// registerHooks / register
// ---------------------------------------------------------------------------
describe('customization hooks', () => {
  test('registerHooks validates like real', () => {
    // Literals verified directly against Node v24.20.0 — jest blocks
    // module.registerHooks() in test code, so jest's `real` cannot be used.
    expect(() => shim.registerHooks({})).not.toThrow();
    const hooks = shim.registerHooks({ resolve: () => {}, load: () => {} });
    expect(typeof hooks.resolve).toBe('function');
    expect(typeof hooks.load).toBe('function');
    let mine;
    try { shim.registerHooks({ resolve: 42 }); } catch (e) { mine = String(e); }
    expect(mine).toBe(
      'TypeError [ERR_INVALID_ARG_TYPE]: The "hooks.resolve" property must be of type function. Received type number (42)',
    );
    try { shim.registerHooks(null); } catch (e) { mine = String(e); }
    expect(mine).toBe("TypeError: Cannot destructure property 'resolve' of 'hooks' as it is null.");
    try { shim.registerHooks(); } catch (e) { mine = String(e); }
    expect(mine).toBe("TypeError: Cannot destructure property 'resolve' of 'hooks' as it is undefined.");
  });

  test('register validates the specifier like real', () => {
    // Literals verified directly against Node v24.20.0.
    let mine;
    try { shim.register(undefined); } catch (e) { mine = String(e); }
    expect(mine).toBe(
      'TypeError: Failed to resolve module specifier "undefined" from "data:": Invalid relative URL or base scheme is not hierarchical.',
    );
    try { shim.register(null); } catch (e) { mine = String(e); }
    expect(mine).toBe(
      'TypeError: Failed to resolve module specifier "null" from "data:": Invalid relative URL or base scheme is not hierarchical.',
    );
    // Anything else is a noop in the browser (no ESM loader pipeline).
    expect(shim.register('node:fs')).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// findPackageJSON
// ---------------------------------------------------------------------------
describe('findPackageJSON', () => {
  test('validates like real Node', () => {
    // Literals verified directly against Node v24.20.0.
    const cases = [
      [[], 'TypeError [ERR_MISSING_ARGS]: The "specifier" argument must be specified'],
      [['x', 'not a url'], 'TypeError: Invalid URL'],
      [['node:fs', '/tmp/x.js'], 'TypeError [ERR_INVALID_URL_SCHEME]: The URL must be of scheme file'],
    ];
    for (const [args, expected] of cases) {
      let mine;
      try { shim.findPackageJSON(...args); } catch (e) { mine = String(e); }
      expect(mine).toBe(expected);
    }
  });

  test('finds the nearest package.json', () => {
    const dir = makeTmp();
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'sub', 'f.js'), '1');
    expect(shim.findPackageJSON('./sub/f.js', dir + '/'))
      .toBe(path.join(dir, 'package.json'));
  });

  test('missing package.json returns undefined', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'f.js'), '1');
    // Walk stops at the tmp root's parent chain; use a bare specifier that
    // cannot exist.
    expect(shim.findPackageJSON('./f.js', dir + '/')).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// stripTypeScriptTypes (validated passthrough — no TS parser in browser)
// ---------------------------------------------------------------------------
describe('stripTypeScriptTypes', () => {
  test('validates like real Node', () => {
    const cases = [
      [42], ['x', { mode: 'bad' }], ['x', { sourceMap: true }],
      ['x', { sourceUrl: 42 }], ['x', null],
    ];
    for (const args of cases) {
      let mine; let theirs;
      try { shim.stripTypeScriptTypes(...args); } catch (e) { mine = String(e); }
      try { real.stripTypeScriptTypes(...args); } catch (e) { theirs = String(e); }
      expect(mine).toBe(theirs);
    }
  });

  test('passes code through unchanged', () => {
    expect(shim.stripTypeScriptTypes('const x: number = 1;'))
      .toBe('const x: number = 1;');
  });

  test('honors sourceUrl suffix like real', () => {
    expect(shim.stripTypeScriptTypes('x', { mode: 'strip', sourceUrl: 'foo.ts' }))
      .toBe(real.stripTypeScriptTypes('x', { mode: 'strip', sourceUrl: 'foo.ts' }));
    expect(shim.stripTypeScriptTypes('x', { sourceUrl: '' })).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// globalPaths / _initPaths
// ---------------------------------------------------------------------------
describe('globalPaths', () => {
  test('_initPaths honors NODE_PATH like real', () => {
    const prev = process.env.NODE_PATH;
    process.env.NODE_PATH = '/usr/test/lib/node_modules:/usr/test/lib/node:';
    try {
      shim._initPaths();
      real._initPaths();
      expect(shim.globalPaths).toContain('/usr/test/lib/node_modules');
      expect(shim.globalPaths).toContain('/usr/test/lib/node');
      expect(shim.globalPaths).not.toContain('');
      expect(shim.Module.globalPaths).toBe(shim.globalPaths);
    } finally {
      if (prev === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = prev;
      shim._initPaths();
    }
  });
});

// ---------------------------------------------------------------------------
// Noop statics
// ---------------------------------------------------------------------------
describe('noop statics', () => {
  test('unimplementable APIs are noops, not throws', () => {
    expect(shim.runMain()).toBe(undefined);
    expect(shim._debug()).toBe(undefined);
    expect(shim._preloadModules(['fs'])).toBe(undefined);
    expect(shim.syncBuiltinESMExports()).toBe(undefined);
  });

  test('_stat matches real (0 file, 1 dir, negative missing)', () => {
    const dir = makeTmp();
    const file = path.join(dir, 'f.js');
    fs.writeFileSync(file, '1');
    expect(Module._stat(dir)).toBe(1);
    expect(Module._stat(file)).toBe(0);
    expect(Module._stat(path.join(dir, 'nope'))).toBeLessThan(0);
    expect(real.Module._stat(dir)).toBe(1);
    expect(real.Module._stat(file)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Browser fallback lane: native delegation disabled, fake sandbox runtime.
// ---------------------------------------------------------------------------
describe('browser fallback lane (no native delegation)', () => {
  const laneFiles = {
    '/vapp/main.js': 'module.exports = require("./lib/util.js").double(21);',
    '/vapp/lib/util.js': 'exports.double = (n) => n * 2;',
    '/vapp/package.json': JSON.stringify({ main: 'main.js' }),
    '/vapp/node_modules/dep/package.json': JSON.stringify({ main: 'index.js' }),
    '/vapp/node_modules/dep/index.js': 'module.exports = "lane-dep";',
  };

  function makeLaneFS(files) {
    const enoent = (p) => Object.assign(
      new Error(`ENOENT: no such file or directory, open '${p}'`),
      { code: 'ENOENT' },
    );
    return {
      readFileSync(p, enc) {
        const c = files[p];
        if (c === undefined) throw enoent(p);
        return enc ? c : Buffer.from(c);
      },
      statSync(p) {
        const isF = Object.prototype.hasOwnProperty.call(files, p);
        const prefix = p.endsWith('/') ? p : `${p}/`;
        const isD = Object.keys(files).some((k) => k.startsWith(prefix));
        if (!isF && !isD) throw enoent(p);
        return { isFile: () => isF, isDirectory: () => !isF && isD };
      },
      realpathSync: (p) => p,
    };
  }

  let savedGetBuiltin;
  let savedRT;
  beforeAll(() => {
    savedGetBuiltin = process.getBuiltinModule;
    process.getBuiltinModule = () => {
      throw new Error('native delegation disabled for browser lane');
    };
    savedRT = globalThis._RUNTIME_;
    globalThis._RUNTIME_ = {
      __FS__: makeLaneFS(laneFiles),
      process: { env: {} },
      loadModule: () => undefined,
    };
    shim._initPaths(); // re-run as the sandbox would at boot
  });

  afterAll(() => {
    process.getBuiltinModule = savedGetBuiltin;
    if (savedRT === undefined) delete globalThis._RUNTIME_;
    else globalThis._RUNTIME_ = savedRT;
    shim._initPaths();
  });

  test('pure APIs work without native delegation', () => {
    expect(shim.isBuiltin('node:fs')).toBe(true);
    expect(shim.isBuiltin('nope')).toBe(false);
    expect(shim._nodeModulePaths('/a/b'))
      .toEqual(['/a/b/node_modules', '/a/node_modules', '/node_modules']);
    expect(shim.Module.wrap('x')).toBe('(function (exports, require, module, __filename, __dirname) { x\n});');
  });

  test('loads modules through the runtime __FS__', () => {
    const req = shim.createRequire('/vapp/main.js');
    expect(req('./main.js')).toBe(42);
    expect(req('./lib/util.js').double(2)).toBe(4);
  });

  test('resolves package main and node_modules through __FS__', () => {
    const req = shim.createRequire('/vapp/main.js');
    expect(req('/vapp')).toBe(42);
    expect(req('dep')).toBe('lane-dep');
    expect(req.resolve('dep')).toBe('/vapp/node_modules/dep/index.js');
  });

  test('builtin require fails honestly with no native module available', () => {
    const req = shim.createRequire('/vapp/main.js');
    const e = throwsCode(() => req('node:fs'), 'MODULE_NOT_FOUND');
    expect(e.message).toContain("Cannot find module 'node:fs'");
  });

  test('missing files throw MODULE_NOT_FOUND with a require stack', () => {
    const req = shim.createRequire('/vapp/main.js');
    const e = throwsCode(() => req('./missing.js'), 'MODULE_NOT_FOUND');
    expect(e.message).toContain('Require stack:');
    expect(e.requireStack).toContain('/vapp/main.js');
  });

  test('Module._pathCache falls back to the shim store in the lane', () => {
    expect(Object.getPrototypeOf(shim.Module._pathCache)).toBe(null);
    shim.Module._pathCache = { __proto__: null };
    expect(Object.getPrototypeOf(shim.Module._pathCache)).toBe(null);
  });
});
