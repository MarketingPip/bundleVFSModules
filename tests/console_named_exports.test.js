// console's 24 named method exports (Node v24.20.0 parity),
// plus the 5 methods the shim was missing entirely.
import globalConsole, { Console } from '../src/console.js';
import * as ns from '../src/console.js';
import {
  assert, clear, context, count, countReset, createTask, debug, dir, dirxml,
  error, group, groupCollapsed, groupEnd, info, log, profile, profileEnd,
  table, time, timeEnd, timeLog, timeStamp, trace, warn,
} from '../src/console.js';
import { describe, test, expect } from '@jest/globals';

const EXPECTED = [
  'assert', 'clear', 'context', 'count', 'countReset', 'createTask', 'debug',
  'dir', 'dirxml', 'error', 'group', 'groupCollapsed', 'groupEnd', 'info',
  'log', 'profile', 'profileEnd', 'table', 'time', 'timeEnd', 'timeLog',
  'timeStamp', 'trace', 'warn',
];

describe('console named exports', () => {
  test('all 24 Node method names are present', () => {
    expect(EXPECTED).toHaveLength(24);
    for (const k of EXPECTED) {
      expect(k in ns).toBe(true);
      expect(typeof ns[k]).toBe('function');
    }
  });

  test('named exports are identical to the bound global-console methods', () => {
    const named = {
      assert, clear, context, count, countReset, createTask, debug, dir, dirxml,
      error, group, groupCollapsed, groupEnd, info, log, profile, profileEnd,
      table, time, timeEnd, timeLog, timeStamp, trace, warn,
    };
    for (const k of EXPECTED) {
      expect(named[k]).toBe(globalConsole[k]);
    }
  });

  test('destructured log still writes', () => {
    expect(() => log('hello from destructured log')).not.toThrow();
  });

  test('Console class is still exported and constructs', () => {
    const c = new Console({ stdout: process.stdout, stderr: process.stderr });
    expect(typeof c.log).toBe('function');
  });
});

describe('newly added console methods (match real Node w/o inspector)', () => {
  test('profile/profileEnd/timeStamp are noops returning undefined', () => {
    expect(profile()).toBe(undefined);
    expect(profile('x')).toBe(undefined);
    expect(profileEnd()).toBe(undefined);
    expect(timeStamp('x')).toBe(undefined);
  });

  test('context() returns a fresh 22-method object', () => {
    const ctx = context();
    expect(Object.getOwnPropertyNames(ctx)).toHaveLength(22);
    expect('dirXml' in ctx).toBe(true); // Node's capital-X spelling
    expect(typeof ctx.log).toBe('function');
    expect(ctx.log).not.toBe(globalConsole.log); // wrappers, not the same ref
    expect(() => ctx.log('from ctx')).not.toThrow();
    expect(context()).not.toBe(ctx); // fresh object each call
  });

  test('createTask() returns { run } that runs the function', () => {
    const t = createTask('task');
    expect(Object.getOwnPropertyNames(t)).toEqual(['run']);
    expect(t.run(() => 42)).toBe(42);
    expect(() => t.run(() => { throw new Error('boom'); })).toThrow('boom');
  });

  test('the new methods exist on Console.prototype too', () => {
    for (const k of ['profile', 'profileEnd', 'timeStamp', 'context', 'createTask']) {
      expect(typeof Console.prototype[k]).toBe('function');
    }
  });
});
