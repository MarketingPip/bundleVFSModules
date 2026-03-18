import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
 
import {
  setTimeout as tpSetTimeout,
  setImmediate,
  setInterval,
  scheduler
} from '../src/timers/promises.js';

describe('timers/promises', () => {

  // ---------------------------
  // setTimeout tests
  // ---------------------------
  describe('setTimeout', () => {
    jest.useRealTimers();

    it('resolves after a delay with the given value', async () => {
      const result = await tpSetTimeout(50, 'ok');
      expect(result).toBe('ok');
    });

    it('uses default delay when none is provided', async () => {
      const start = Date.now();
      await tpSetTimeout();
      expect(Date.now() - start).toBeGreaterThanOrEqual(1);
    });

    it('rejects immediately if signal is already aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      await expect(tpSetTimeout(10, null, { signal: ac.signal })).rejects.toMatchObject({
        name: 'AbortError',
        code: 'ABORT_ERR'
      });
    });

    it('rejects if aborted during the timeout', async () => {
      const ac = new AbortController();
      const promise = tpSetTimeout(100, 'late', { signal: ac.signal });
      // use native timer to trigger abort
      globalThis.setTimeout(() => ac.abort(), 20);
      await expect(promise).rejects.toMatchObject({
        name: 'AbortError',
        code: 'ABORT_ERR'
      });
    });

    it('rejects with ERR_INVALID_ARG_TYPE for invalid delay', async () => {
      await expect(tpSetTimeout('oops')).rejects.toMatchObject({
        code: 'ERR_INVALID_ARG_TYPE'
      });
    });

    it('rejects with ERR_INVALID_ARG_TYPE for invalid options', async () => {
      await expect(tpSetTimeout(10, null, 'not-an-object')).rejects.toMatchObject({
        code: 'ERR_INVALID_ARG_TYPE'
      });
    });
  });

  // ---------------------------
  // setImmediate tests
  // ---------------------------
  describe('setImmediate', () => {
    it('resolves with the given value', async () => {
      const result = await setImmediate('done');
      expect(result).toBe('done');
    });

    it('rejects immediately if signal is already aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      await expect(setImmediate('x', { signal: ac.signal })).rejects.toMatchObject({
        name: 'AbortError',
        code: 'ABORT_ERR'
      });
    });

    it('rejects with ERR_INVALID_ARG_TYPE for invalid options', async () => {
      await expect(setImmediate('v', null)).rejects.toMatchObject({
        code: 'ERR_INVALID_ARG_TYPE'
      });
    });
  });

  // ---------------------------
  // setInterval tests
  // ---------------------------
  describe('setInterval', () => {
    it('yields multiple values asynchronously', async () => {
      const results = [];
      let count = 0;
      for await (const val of setInterval(20, 'tick')) {
        results.push(val);
        if (++count === 3) break;
      }
      expect(results).toEqual(['tick', 'tick', 'tick']);
    });

    it('throws AbortError if signal is aborted during iteration', async () => {
      jest.setTimeout(1000); // prevent Jest default timeout
      const ac = new AbortController();
      const interval = setInterval(50, 'x', { signal: ac.signal });
      globalThis.setTimeout(() => ac.abort(), 60);

      await expect((async () => {
        for await (const _ of interval) {}
      })()).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    });

    it('throws immediately if signal is already aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      await expect((async () => {
        for await (const _ of setInterval(10, 'x', { signal: ac.signal })) {}
      })()).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
    });

    it('throws ERR_INVALID_ARG_TYPE for invalid delay', async () => {
      await expect((async () => {
        for await (const _ of setInterval('oops')) {}
      })()).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' });
    });
  });

  // ---------------------------
  // scheduler tests
  // ---------------------------
  describe('scheduler', () => {
    it('scheduler.wait resolves after given delay', async () => {
      await expect(scheduler.wait(30)).resolves.toBeUndefined();
    });

    it('scheduler.yield resolves immediately (next tick)', async () => {
      let executed = false;
      globalThis.setImmediate(() => { executed = true; });
      await scheduler.yield();
      expect(executed).toBe(true);
    });
  });
});
