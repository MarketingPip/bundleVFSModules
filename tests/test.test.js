import { jest, describe, test, expect, beforeEach } from '@jest/globals';
globalThis._RUNTIME_ = {
  _TEST_RUNNER_: {
    REPORTER_TYPE: 'spec'
  }
};

import nodeTest, { MockTracker, MockTimers, _reset, execute, run} from '../src/test.js';



describe('node:test Browser Shim', () => {
  beforeEach(() => {
    _reset(); // Clear singleton state between tests
  });

  describe('MockTracker', () => {
    test('fn() tracks calls and arguments', () => {
      const tracker = new MockTracker();
      const sum = (a, b) => a + b;
      const mockSum = tracker.fn(sum);

      const result = mockSum(5, 10);
      
      expect(result).toBe(15);
      expect(mockSum.mock.callCount()).toBe(1);
      expect(mockSum.mock.calls[0].arguments).toEqual([5, 10]);
    });

    test('method() patches and restores objects', () => {
      const tracker = new MockTracker();
      const obj = { greet: (name) => `Hello ${name}` };
      
      tracker.method(obj, 'greet', () => 'Mocked!');
      expect(obj.greet('World')).toBe('Mocked!');
      
      tracker.restoreAll();
      expect(obj.greet('World')).toBe('Hello World');
    });
  });


  test('run() emits pass/fail events', async () => {
    // Define tests
    await nodeTest.test('passing test', (t) => {
      t.assert.strictEqual(2 + 2, 4);
    });
  
    await nodeTest.test('failing test', (t) => {
      t.assert.strictEqual(2 + 2, 5);
    });
  
    const events = [];
  
    // Start runner
    const runner = run({ concurrency: false });
  
    runner.on('test:pass', (e) => {
      events.push({ type: 'pass', name: e.name });
    });
  
    runner.on('test:fail', (e) => {
      events.push({ type: 'fail', name: e.name });
    });
  
    // ✅ Wait for ALL tests to finish
    await runner.collect();
  
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'pass', name: 'passing test' },
        { type: 'fail', name: 'failing test' }
      ])
    );
  });
  
  

  describe('MockTimers', () => {
    test('tick() advances time and triggers setTimeout', () => {
      const timers = new MockTimers();
      timers.enable({ apis: ['setTimeout', 'Date'] });
      
      const callback = jest.fn();
      setTimeout(callback, 1000);
      
      timers.tick(500);
      expect(callback).not.toHaveBeenCalled();
      
      timers.tick(500);
      expect(callback).toHaveBeenCalled();
      expect(Date.now()).toBe(1000);
      
      timers.reset();
    });
  });

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
      
      // Test code that never resolves
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

  describe('Assertions (CtxAssert)', () => {
    test('deepEqual identifies nested mismatches', async () => {
      const userCode = `
        await test('deep', (t) => {
          t.assert.deepEqual({a: 1, b: [2]}, {a: 1, b: [2]});
          t.assert.deepEqual({a: 1}, {a: 2}); // This should fail
        });
      `;
      
      const result = await execute(userCode);
      expect(result.root.children[0].result).toBe('fail');
    });
  });
});
