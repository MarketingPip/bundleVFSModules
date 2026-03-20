import { jest, describe, test, expect, beforeEach } from '@jest/globals';

globalThis._RUNTIME_ = {
  _TEST_RUNNER_: {
    REPORTER_TYPE: 'spec'
  }
};

// Only import what node:test actually exports.
// MockTracker, MockTimers, and _reset are internal — reach them via the
// _RUNTIME_ hook that the module installs on globalThis.
import nodeTest, {
  mock,
  run,
  execute,
  test    as nodeTestFn,
  it,
  suite,
  describe as nodeDescribe,
  before,
  after,
  beforeEach as nodeBeforeEach,
  afterEach  as nodeAfterEach,
  snapshot,
  assert,
} from '../src/test.js';

// _reset is read lazily inside beforeEach — not destructured at module
// evaluation time — because ES imports run before any statement in this file,
// meaning the module installs _RUNTIME_ before this line, but the assignment
// `globalThis._RUNTIME_ = { ... }` at the top of *this* file also runs after
// the import. Reading from globalThis inside a function call is always safe.
const _reset = () => globalThis._RUNTIME_._TEST_RUNNER_._reset();

describe('node:test Browser Shim', () => {
  beforeEach(() => {
    _reset(); // Clear singleton state between tests
  });

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
  test('run() emits pass/fail events', async () => {
    await nodeTest('passing test', (t) => {
      t.assert.strictEqual(2 + 2, 4);
    });

    await nodeTest('failing test', (t) => {
      t.assert.strictEqual(2 + 2, 5);
    });

    const events = [];
    const runner = run({ concurrency: false });

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

  test('run() respects testNamePatterns', async () => {
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

    test('it is an alias for test', () => {
      expect(it).toBe(it); // referential check; both schedule the same way
      expect(typeof it).toBe('function');
    });

    test('describe is an alias for suite', () => {
      expect(typeof nodeDescribe).toBe('function');
      expect(typeof suite).toBe('function');
    });

    test('snapshot exposes setDefaultSnapshotSerializers and setResolveSnapshotPath', () => {
      expect(typeof snapshot.setDefaultSnapshotSerializers).toBe('function');
      expect(typeof snapshot.setResolveSnapshotPath).toBe('function');
    });

    test('assert exposes register()', () => {
      expect(typeof assert.register).toBe('function');
    });

    test('reporters are NOT exported from node:test (only from node:test/reporters)', () => {
      // dot/spec/tap/junit/lcov must not appear as named exports of this module
      const mod = { mock, run, execute, test: nodeTestFn, it, suite, describe: nodeDescribe,
                    before, after, beforeEach: nodeBeforeEach, afterEach: nodeAfterEach,
                    snapshot, assert };
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

  // ── execute() ─────────────────────────────────────────────────────────────
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

      expect(result.events.some(e => e.type === 'test:pass' && e.name === 'math works')).toBe(true);
      expect(result.events.some(e => e.type === 'test:todo')).toBe(true);
      expect(result.output).toContain('TAP version 13');
    });

    test('enforces timeout on slow tests', async () => {
      const userCode = `
        await test('slow test', { timeout: 50 }, async () => {
          await new Promise(r => {});
        });
      `;

      const result = await execute(userCode);
      const failEvent = result.events.find(e => e.type === 'test:fail');

      expect(failEvent.error.message).toContain('timed out after 50ms');
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
});
