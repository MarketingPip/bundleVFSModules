// assert/strict self-reference (Node v24.20.0 parity:
// require('assert/strict').strict === require('assert/strict')).
import strict, * as ns from '../src/assert/strict.js';
import { describe, test, expect } from '@jest/globals';

describe('assert/strict self-reference', () => {
  test('strict is present in the module namespace', () => {
    expect('strict' in ns).toBe(true);
  });

  test('named strict === default export', () => {
    expect(ns.strict).toBe(strict);
  });

  test('self-reference matches Node: strict.strict === strict', () => {
    expect(strict.strict).toBe(strict);
    expect(ns.strict.strict).toBe(strict);
  });

  test('assertions still work through the self-reference', () => {
    expect(() => ns.strict.strictEqual(1, 1)).not.toThrow();
    expect(() => ns.strict.strictEqual(1, 2)).toThrow();
    expect(() => strict.ok(false)).toThrow();
  });

  test('named methods are identical references on all three views', () => {
    expect(ns.strictEqual).toBe(strict.strictEqual);
    expect(ns.strict.deepStrictEqual).toBe(strict.deepStrictEqual);
    expect(ns.ok).toBe(strict.ok);
  });
});
