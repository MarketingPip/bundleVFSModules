import { jest, describe, test, expect, beforeEach, beforeAll, afterAll } from '@jest/globals';
import { tap, spec, dot, junit, lcov } from '../src/test/reporters.js';

// Install the host-side hook BEFORE the module loads. A static import would
// hoist above this code, so use a dynamic import: this mirrors Jared's
// runtime, which installs globalThis._RUNTIME_ before loading our shims.
// (The module only wires _TEST_RUNNER_ when _RUNTIME_ pre-exists — it must
// not create the global itself, or Node's test/common flags it as a leak.)
globalThis._RUNTIME_ ??= {};
globalThis._RUNTIME_._TEST_RUNNER_ ??= {};
globalThis._RUNTIME_._TEST_RUNNER_.REPORTER_TYPE = 'spec';

// Only import what node:test actually exports.
// _reset is internal — reach it via the _RUNTIME_ hook that the module
// installs on globalThis. `execute` is a host-only helper, not a named ESM
// export in real node:test — reach it via the default export.
const testModule = await import('../src/test.js');
const {
  default: nodeTest,
  mock,
  run,
  test: nodeTestFn,
  it,
  suite,
  describe: nodeDescribe,
  before,
  after,
  beforeEach: nodeBeforeEach,
  afterEach: nodeAfterEach,
  only,
  skip,
  todo,
  expectFailure,
  getTestContext,
  snapshot,
  assert,
} = testModule;
const execute = nodeTest.execute;

const hook = () => globalThis._RUNTIME_._TEST_RUNNER_;
const reset = () => hook()._reset();

describe('node:test Browser Shim', () => {
  // ── mock (singleton MockTracker instance, named export) ───────────────────
  describe('mock (named export)', () => {
    test('mock.fn() tracks calls and arguments', () => {
      const sum = (a, b) => a + b;
      const mockSum = mock.fn(sum);

      const result = mockSum(5, 10);

      expect(result).toBe(15);
      expect(mockSum.mock.callCount()).toBe(1);
      expect(mockSum.mock.calls[0].arguments).toEqual([5, 10]);

      mock.restoreAll();
    });

    test('mock.method() patches and restores objects', () => {
      const obj = { greet: (name) => `Hello ${name}` };

      mock.method(obj, 'greet', () => 'Mocked!');
      expect(obj.greet('World')).toBe('Mocked!');

      mock.restoreAll();
      expect(obj.greet('World')).toBe('Hello World');
    });
  });

  // ── mock.timers (MockTimers reached via mock named export) ────────────────
  describe('mock.timers', () => {
    test('tick() advances time and triggers setTimeout', () => {
      mock.timers.enable({ apis: ['setTimeout', 'Date'] });

      const callback = jest.fn();
      setTimeout(callback, 1000);

      mock.timers.tick(500);
      expect(callback).not.toHaveBeenCalled();

      mock.timers.tick(500);
      expect(callback).toHaveBeenCalled();
      expect(Date.now()).toBe(1000);

      mock.timers.reset();
    });
  });

  // ── run() ─────────────────────────────────────────────────────────────────
  test('run() emits pass/fail events as { type, data }', async () => {
    reset();
    await nodeTest('passing test', (t) => {
      t.assert.strictEqual(2 + 2, 4);
    });

    await nodeTest('failing test', (t) => {
      t.assert.strictEqual(2 + 2, 5);
    });

    const events = [];
    const runner = run();

    runner.on('test:pass', (e) => events.push({ type: 'pass', name: e.name }));
    runner.on('test:fail', (e) => events.push({ type: 'fail', name: e.name }));

    await runner.collect();

    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'pass', name: 'passing test' },
        { type: 'fail', name: 'failing test' },
      ])
    );
  });

  test('run() is a live async iterable of events', async () => {
    reset();
    await nodeTest('live one', (t) => { t.assert.ok(true); });
    await nodeTest('live two', (t) => { t.assert.ok(true); });

    const seen = [];
    for await (const e of run()) {
      if (e.type === 'test:pass') seen.push(e.data.name);
    }
    expect(seen).toEqual(['live one', 'live two']);
  });

  test('run() respects testNamePatterns', async () => {
    reset();
    await nodeTest('fast test', (t) => { t.assert.ok(true); });
    await nodeTest('slow test', (t) => { t.assert.ok(true); });

    const events = [];
    const runner = run({ testNamePatterns: /fast/ });

    runner.on('test:pass', (e) => events.push(e.name));
    await runner.collect();

    expect(events).toEqual(['fast test']);
  });

  // ── Named exports smoke-tests ─────────────────────────────────────────────
  describe('named exports', () => {
    test('default export and named test export are the same function', () => {
      expect(nodeTest).toBe(nodeTestFn);
    });

    test('it is the same function object as test (Node: test.it === test)', () => {
      expect(it).toBe(nodeTestFn);
      expect(nodeTestFn.it).toBe(nodeTestFn);
    });

    test('describe is the same function object as suite', () => {
      expect(nodeDescribe).toBe(suite);
      expect(nodeTestFn.describe).toBe(nodeTestFn.suite);
      expect(nodeTestFn.test).toBe(nodeTestFn);
    });

    test('all named exports are bolted onto the test function (CJS parity)', () => {
      for (const k of ['before', 'after', 'beforeEach', 'afterEach', 'run', 'mock',
                       'snapshot', 'assert', 'only', 'skip', 'todo',
                       'expectFailure', 'getTestContext']) {
        expect(typeof nodeTestFn[k]).not.toBe('undefined');
      }
      // CJS destructuring works off the function object:
      const { beforeEach: be, afterEach: ae, test: tfn } = nodeTestFn;
      expect(typeof be).toBe('function');
      expect(typeof ae).toBe('function');
      expect(tfn).toBe(nodeTestFn);
    });

    test('top-level only/skip/todo are functions', () => {
      expect(typeof only).toBe('function');
      expect(typeof skip).toBe('function');
      expect(typeof todo).toBe('function');
    });

    test('snapshot exposes setDefaultSnapshotSerializers and setResolveSnapshotPath', () => {
      expect(typeof snapshot.setDefaultSnapshotSerializers).toBe('function');
      expect(typeof snapshot.setResolveSnapshotPath).toBe('function');
    });

    test('assert exposes register()', () => {
      expect(typeof assert.register).toBe('function');
    });

    test('reporters are NOT exported from node:test (only from node:test/reporters)', () => {
      const mod = { mock, run, execute, test: nodeTestFn, it, suite, describe: nodeDescribe,
                    before, after, beforeEach: nodeBeforeEach, afterEach: nodeAfterEach,
                    snapshot, assert, only, skip, todo, expectFailure, getTestContext };
      for (const key of ['dot', 'spec', 'tap', 'junit', 'lcov', 'reporters']) {
        expect(mod).not.toHaveProperty(key);
      }
    });

    test('internal classes are NOT exported (MockTracker, MockTimers, SkipError, etc.)', () => {
      const mod = { mock, run, execute, test: nodeTestFn, it, suite, describe: nodeDescribe,
                    before, after, beforeEach: nodeBeforeEach, afterEach: nodeAfterEach,
                    snapshot, assert };
      for (const key of ['MockTracker', 'MockTimers', 'SuiteContext', 'TestContext',
                         'SkipError', 'TodoError', 'AssertionError']) {
        expect(mod).not.toHaveProperty(key);
      }
    });
  });

  // ── execute(): real nested run producing TAP ──────────────────────────────
  describe('Test Execution Flow', () => {
    test('runs a basic suite and reports passes', async () => {
      const userCode = `
        await test('math works', (t) => {
          t.assert.strictEqual(1 + 1, 2);
        });

        await describe('nested suite', () => {
          it('is todo', { todo: true });
        });
      `;

      const result = await execute(userCode, { reporter: 'tap' });

      expect(result.events.some(e => e.type === 'test:pass' && e.data.name === 'math works')).toBe(true);
      // Node reports todo tests as passes carrying a todo flag (no test:todo event).
      expect(result.events.some(e => e.type === 'test:pass' && e.data.todo === true)).toBe(true);
      expect(result.output).toContain('TAP version 13');
    });

    test('nested run produces valid TAP with plans and directives', async () => {
      const userCode = `
        await test('adds', (t) => { t.assert.strictEqual(1 + 1, 2); });
        await test('skipped one', { skip: 'not yet' }, () => {});
        await test('todo one', { todo: 'later' }, () => {});
        await describe('group', () => {
          test('inner pass', (t) => { t.assert.ok(true); });
          test('inner fail', (t) => { t.assert.ok(false, 'boom'); });
        });
      `;
      const result = await execute(userCode, { reporter: 'tap' });
      const out = result.output;

      expect(out).toContain('TAP version 13');
      expect(out).toMatch(/^ok 1 - adds$/m);
      expect(out).toMatch(/^ok 2 - skipped one # SKIP not yet$/m);
      expect(out).toMatch(/^ok 3 - todo one # TODO later$/m);
      expect(out).toContain('# Subtest: group');
      expect(out).toMatch(/^\s+not ok 2 - inner fail$/m);
      expect(out).toMatch(/^1\.\.4$/m);          // top-level plan
      expect(out).toContain('# pass 2');
      expect(out).toContain('# fail 1');
      expect(out).toContain('# skipped 1');
      expect(out).toContain('# todo 1');
    });

    test('enforces timeout on slow tests', async () => {
      const userCode = `
        await test('slow test', { timeout: 50 }, async () => {
          await new Promise(r => {});
        });
      `;

      const result = await execute(userCode);
      const failEvent = result.events.find(e => e.type === 'test:fail');

      expect(failEvent.data.details.error.message).toContain('timed out after 50ms');
    });

    test('timeout aborts t.signal', async () => {
      const userCode = `
        let aborted = false;
        await test('signal test', { timeout: 50 }, async (t) => {
          t.signal.addEventListener('abort', () => { aborted = true; });
          await new Promise(r => setTimeout(r, 5000));
        });
        await test('signal check', (t) => { t.assert.strictEqual(aborted, true); });
      `;
      const result = await execute(userCode, { reporter: 'tap' });
      // The slow test fails with a timeout error, but its abort listener fired.
      const failEvent = result.events.find(e => e.type === 'test:fail' && e.data.name === 'signal test');
      expect(failEvent.data.details.error.message).toContain('timed out after 50ms');
      expect(result.events.some(e => e.type === 'test:pass' && e.data.name === 'signal check')).toBe(true);
    });
  });

  // ── Lifecycle hooks ───────────────────────────────────────────────────────
  describe('hooks', () => {
    test('before/after/beforeEach/afterEach run in order', async () => {
      const userCode = `
        const order = [];
        await describe('hooked', () => {
          before(() => order.push('before'));
          after(() => order.push('after'));
          beforeEach(() => order.push('beforeEach'));
          afterEach(() => order.push('afterEach'));
          test('one', () => order.push('test:one'));
          test('two', () => order.push('test:two'));
        });
        await test('report', (t) => {
          t.assert.deepEqual(order, [
            'before',
            'beforeEach', 'test:one', 'afterEach',
            'beforeEach', 'test:two', 'afterEach',
            'after',
          ]);
        });
      `;
      const result = await execute(userCode, { reporter: 'tap' });
      expect(result.events.some(e => e.type === 'test:fail')).toBe(false);
      expect(result.events.some(e => e.type === 'test:pass' && e.data.name === 'report')).toBe(true);
    });
  });

  // ── only / skip / todo semantics ──────────────────────────────────────────
  describe('only/skip/todo', () => {
    test('only marks are ignored by default (matches Node)', async () => {
      const userCode = `
        await test('plain a', () => {});
        await test.only('marked b', () => {});
        await test('plain c', () => {});
      `;
      const result = await execute(userCode, { reporter: 'tap' });
      const passed = result.events.filter(e => e.type === 'test:pass').map(e => e.data.name);
      expect(passed).toEqual(expect.arrayContaining(['plain a', 'marked b', 'plain c']));
    });

    test('run({ testOnly: true }) runs only marked tests', async () => {
      const userCode = `
        await describe('grp', () => {
          test.only('marked inner', () => {});
          test('plain inner', () => {});
        });
        await describe('other', () => {
          test('plain other', () => {});
        });
        await test('plain top', () => {});
      `;
      const result = await execute(userCode, { reporter: 'tap', testOnly: true });
      const out = result.output;
      expect(out).toMatch(/ok 1 - marked inner/);
      expect(out).not.toContain('plain inner');
      expect(out).not.toContain('plain other');
      expect(out).not.toContain('plain top');
      expect(out).toContain('# pass 1');
      expect(out).toContain('# tests 1');
    });

    test('describe.only runs the whole subtree in only-mode', async () => {
      const userCode = `
        await describe.only('chosen', () => {
          test('child one', () => {});
          test('child two', () => {});
        });
        await test('outsider', () => {});
      `;
      const result = await execute(userCode, { reporter: 'tap', testOnly: true });
      const out = result.output;
      expect(out).toContain('child one');
      expect(out).toContain('child two');
      expect(out).not.toContain('outsider');
    });

    test('top-level only()/skip()/todo() schedule marked tests', async () => {
      const userCode = `
        await only('o1', () => {});
        await skip('s1', () => {});
        await todo('t1', () => {});
      `;
      const result = await execute(userCode, { reporter: 'tap', testOnly: true });
      expect(result.output).toContain('o1');
      const plain = await execute(`await test('p1', () => {});`, { reporter: 'tap' });
      expect(plain.output).toContain('p1');
    });
  });

  // ── expectFailure ─────────────────────────────────────────────────────────
  describe('expectFailure', () => {
    test('a failing test is reported as pass with # EXPECTED FAILURE', async () => {
      const userCode = `
        await expectFailure('fails as expected', (t) => { t.assert.strictEqual(1, 2); });
      `;
      const result = await execute(userCode, { reporter: 'tap' });
      expect(result.output).toMatch(/^ok 1 - fails as expected # EXPECTED FAILURE$/m);
      expect(result.output).toContain('# pass 1');
      expect(result.output).toContain('# fail 0');
    });

    test('an unexpected pass is reported as failure', async () => {
      const userCode = `
        await expectFailure('unexpectedly passes', (t) => { t.assert.strictEqual(1, 1); });
      `;
      const result = await execute(userCode, { reporter: 'tap' });
      expect(result.output).toMatch(/^not ok 1 - unexpectedly passes # EXPECTED FAILURE$/m);
      expect(result.output).toContain("error: 'test was expected to fail but passed'");
      expect(result.output).toContain('# fail 1');
    });
  });

  // ── skip/todo context semantics (matches real node:test) ──────────────────
  describe('skip/todo context calls', () => {
    test('t.skip() does not abort the body; reports pass with skip', async () => {
      const userCode = `
        let ran = false;
        await test('ctx skip', (t) => { t.skip('later'); ran = true; });
        if (!ran) throw new Error('body did not run');
      `;
      const result = await execute(userCode, { reporter: 'tap' });
      const pass = result.events.find(e => e.type === 'test:pass' && e.data.name === 'ctx skip');
      expect(pass).toBeDefined();
      expect(pass.data.skip).toBe('later');
      expect(pass.data.todo).toBe(undefined);
      expect(result.output).toMatch(/^ok 1 - ctx skip # SKIP later$/m);
    });

    test('t.todo() does not abort the body; reports pass with todo', async () => {
      const userCode = `
        let ran = false;
        await test('ctx todo', (t) => { t.todo('fixme'); ran = true; });
        if (!ran) throw new Error('body did not run');
      `;
      const result = await execute(userCode, { reporter: 'tap' });
      const pass = result.events.find(e => e.type === 'test:pass' && e.data.name === 'ctx todo');
      expect(pass).toBeDefined();
      expect(pass.data.todo).toBe('fixme');
      expect(result.output).toMatch(/^ok 1 - ctx todo # TODO fixme$/m);
    });

    test('todo option runs the body (unlike skip)', async () => {
      const userCode = `
        let ran = false;
        await test('todo runs', { todo: 'soon' }, () => { ran = true; });
        if (!ran) throw new Error('todo body did not run');
      `;
      const result = await execute(userCode, { reporter: 'tap' });
      expect(result.output).toMatch(/^ok 1 - todo runs # TODO soon$/m);
    });

    test('a failing todo test still fails, keeping the todo flag', async () => {
      const userCode = `
        await test('todo fails', { todo: true }, () => { throw new Error('boom'); });
      `;
      const result = await execute(userCode, { reporter: 'tap' });
      const fail = result.events.find(e => e.type === 'test:fail' && e.data.name === 'todo fails');
      expect(fail).toBeDefined();
      expect(fail.data.todo).toBe(true);
      expect(result.output).toMatch(/^not ok 1 - todo fails # TODO$/m);
    });

    test('skip wins over todo: todo flag is cleared', async () => {
      const userCode = `
        await test('both', { skip: true, todo: true }, () => {});
      `;
      const result = await execute(userCode, { reporter: 'tap' });
      const pass = result.events.find(e => e.type === 'test:pass' && e.data.name === 'both');
      expect(pass).toBeDefined();
      expect(pass.data.skip).toBe(true);
      expect(pass.data.todo).toBe(undefined);
      expect(result.output).toMatch(/^ok 1 - both # SKIP$/m);
    });

    test('a skipped suite emits test:pass with skip and type suite', async () => {
      const userCode = `
        await suite('skipped suite', { skip: 'nope' }, () => {});
      `;
      const result = await execute(userCode, { reporter: 'tap' });
      const pass = result.events.find(e => e.type === 'test:pass' && e.data.name === 'skipped suite');
      expect(pass).toBeDefined();
      expect(pass.data.skip).toBe('nope');
      expect(pass.data.details.type).toBe('suite');
      expect(result.output).toMatch(/^ok 1 - skipped suite # SKIP nope$/m);
    });

    test('testIds are numeric and stable across start/complete/pass', async () => {
      const userCode = `
        await test('ids', () => {});
      `;
      const result = await execute(userCode, { reporter: 'tap' });
      const byType = {};
      for (const e of result.events) {
        if (['test:start', 'test:complete', 'test:pass'].includes(e.type) && e.data.name === 'ids') {
          byType[e.type] = e.data;
        }
      }
      expect(typeof byType['test:start'].testId).toBe('number');
      expect(byType['test:complete'].testId).toBe(byType['test:start'].testId);
      expect(byType['test:pass'].testId).toBe(byType['test:start'].testId);
      expect(byType['test:pass'].testNumber).toBe(byType['test:start'].testNumber);
    });
  });

  // ── getTestContext ────────────────────────────────────────────────────────
  describe('getTestContext', () => {
    test('returns the current test context inside a test, undefined outside', async () => {
      expect(getTestContext()).toBe(undefined);
      reset();
      let seen;
      let seenAfter;
      await nodeTest('ctx probe', (t) => {
        seen = getTestContext();
        t.assert.strictEqual(seen, t);
      });
      await run().collect();
      seenAfter = getTestContext();
      expect(seen).not.toBe(undefined);
      expect(seen.name).toBe('ctx probe');
      expect(seenAfter).toBe(undefined);
    });
  });

  // ── Assertions ────────────────────────────────────────────────────────────
  describe('Assertions (t.assert)', () => {
    test('deepEqual identifies nested mismatches', async () => {
      const userCode = `
        await test('deep', (t) => {
          t.assert.deepEqual({ a: 1, b: [2] }, { a: 1, b: [2] });
          t.assert.deepEqual({ a: 1 }, { a: 2 }); // should fail
        });
      `;

      const result = await execute(userCode);
      expect(result.root.children[0].result).toBe('fail');
    });
  });

  // ── Reporters transform the event stream ──────────────────────────────────
  describe('reporters (node:test/reporters)', () => {
    async function collect(reporterFn) {
      reset();
      await nodeTest('alpha', (t) => { t.assert.ok(true); });
      await nodeTest('beta', (t) => { t.assert.ok(false, 'nope'); });
      let out = '';
      for await (const chunk of reporterFn(run())) out += chunk;
      return out;
    }

    test('tap() yields TAP from the run() stream', async () => {
      const out = await collect(tap);
      expect(out).toContain('TAP version 13');
      expect(out).toMatch(/^ok 1 - alpha$/m);
      expect(out).toMatch(/^not ok 2 - beta$/m);
      expect(out).toContain('# pass 1');
      expect(out).toContain('# fail 1');
    });

    test('spec() yields human-readable output', async () => {
      const out = await collect(spec);
      const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
      expect(plain).toContain('alpha');
      expect(plain).toContain('beta');
      expect(plain).toContain('ℹ tests 2');
      expect(plain).toContain('ℹ pass 1');
      expect(plain).toContain('ℹ fail 1');
    });

    test('dot() yields one char per test plus a failure block', async () => {
      const out = await collect(dot);
      expect(out).toContain('Failed tests:');
      expect(out).toContain('beta');
    });

    test('junit() yields JUnit XML', async () => {
      const out = await collect(junit);
      expect(out).toContain('<?xml version="1.0" encoding="utf-8"?>');
      expect(out).toContain('<testsuites>');
      expect(out).toContain('name="alpha"');
      expect(out).toContain('<failure');
    });

    test('lcov() yields empty string without coverage data', async () => {
      const out = await collect(lcov);
      expect(out).toBe('');
    });
  });

  // ── _RUNTIME_ hook: merge, don't clobber ──────────────────────────────────
  describe('_RUNTIME_._TEST_RUNNER_ hook', () => {
    test('host configuration survives the module wiring', () => {
      const tr = hook();
      expect(tr.REPORTER_TYPE).toBe('spec'); // set before import, still there
      expect(typeof tr.execute).toBe('function');
      expect(typeof tr._reset).toBe('function');
      expect(typeof tr.reporters.tap).toBe('function');
    });

    test('REPORTER_TYPE is honoured lazily by execute()', async () => {
      const userCode = `await test('lazy reporter', (t) => { t.assert.ok(true); });`;
      const result = await execute(userCode); // no explicit reporter → host 'spec'
      expect(result.output).toContain('lazy reporter');
      expect(result.output).toContain('✔');
    });
  });

  // ── Browser fallback: zero native delegation ──────────────────────────────
  describe('browser fallback (no native delegation)', () => {
    let fb;
    const realGbm = process.getBuiltinModule;
    const realBuffer = globalThis.Buffer;
    const hadBuffer = 'Buffer' in globalThis;

    beforeAll(async () => {
      // Any native-delegation attempt throws: the import and every operation
      // below must work with zero native delegation. Host Buffer is removed
      // to prove the shim never needs it.
      process.getBuiltinModule = () => {
        throw new Error('native delegation attempted');
      };
      try {
        if (hadBuffer) {
          try { delete globalThis.Buffer; } catch { /* non-configurable */ }
        }
        fb = await import('../src/test.js?fallback=test');
      } finally {
        process.getBuiltinModule = realGbm;
        if (hadBuffer) globalThis.Buffer = realBuffer;
      }
    });

    afterAll(() => {
      process.getBuiltinModule = realGbm;
      if (hadBuffer && globalThis.Buffer !== realBuffer) {
        globalThis.Buffer = realBuffer;
      }
    });

    test('runner works with native builtins disabled', async () => {
      const result = await fb.default.execute(`
        await test('fallback math', (t) => { t.assert.strictEqual(2 * 3, 6); });
        await describe('fallback group', () => {
          test('nested', (t) => { t.assert.ok(true); });
        });
        await test.only('only one', () => {});
      `, { reporter: 'tap', testOnly: true });
      expect(result.output).toContain('TAP version 13');
      expect(result.output).toMatch(/ok 1 - only one/);
      expect(result.output).not.toContain('fallback math');
    });

    test('mock.fn works with native builtins disabled', () => {
      const m = fb.mock.fn((a, b) => a * b);
      expect(m(3, 4)).toBe(12);
      expect(m.mock.callCount()).toBe(1);
      expect(m.mock.calls[0].arguments).toEqual([3, 4]);
      fb.mock.restoreAll();
    });

    test('reporters transform the stream with native builtins disabled', async () => {
      const { tap: fbTap } = await import('../src/test/reporters.js?fallback=test-reporters');
      const result = await fb.default.execute(`
        await test('r1', (t) => { t.assert.ok(true); });
      `, { reporter: 'dot' });
      expect(result.output).not.toContain('Failed tests:'); // no failures → no block
      let out = '';
      async function* src() { for (const e of result.events) yield e; }
      for await (const c of fbTap(src())) out += c;
      expect(out).toContain('TAP version 13');
      expect(out).toMatch(/^ok 1 - r1$/m);
    });
  });
});
