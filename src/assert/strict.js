// npm install assert

/*!
 * assert-strict-web — node:assert/strict for browsers & bundlers
 * MIT License.
 * Node.js parity: node:assert/strict @ Node 9.9.0+
 * Dependencies: assert (npm)
 * Limitations:
 *   - assert.strict is itself the strict-mode assert — all methods already
 *     use strict equality / deep-strict semantics by default.
 *   - callTrack / snapshot APIs (Node 18+) are not present in the npm shim.
 */

/**
 * @packageDocumentation
 * Re-exports `assert.strict` as both the default export and fully-destructured
 * named exports, mirroring the shape of `node:assert/strict`.
 *
 * In Node, `import assert from 'node:assert/strict'` gives you the strict
 * module directly — every method behaves as if called on `assert.strict`.
 * This file replicates that identity exactly:
 *
 *   import strict, { deepEqual } from './assert/strict';
 *   strict === strict.strict  // true (self-referential, matches Node)
 *   deepEqual === strict.deepEqual  // true — same function reference
 */

import assert from 'assert';

// `assert.strict` is the strict-mode view: deepEqual → deepStrictEqual,
// equal → strictEqual, etc.  It is also self-referential: strict.strict === strict.
const strict = assert.strict;

// ---------------------------------------------------------------------------
// Named exports — all public methods on assert.strict
// Destructured here so each export is the *same function reference* as on the
// strict object itself, not a wrapper.  This matters for instanceof checks and
// for consumers that compare `assert.deepEqual === deepEqual`.
// ---------------------------------------------------------------------------
export const {
  // Core assertion
  ok,
  fail,
  ifError,

  // Equality — in strict mode these are the deep-strict variants
  equal,            // → assert.strictEqual
  notEqual,         // → assert.notStrictEqual
  strictEqual,
  notStrictEqual,

  // Deep equality — in strict mode these use the SameValueZero / structural algorithm
  deepEqual,        // → assert.deepStrictEqual
  notDeepEqual,     // → assert.notDeepStrictEqual
  deepStrictEqual,
  notDeepStrictEqual,

  // Throws / rejects (sync + async)
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,

  // Regex match
  match,
  doesNotMatch,
} = strict;

// Default export is the strict module directly — identical to Node's behaviour
// where `import assert from 'node:assert/strict'` gives you assert.strict.
export default {
  ok,
  fail,
  ifError,
  equal,
  notEqual,
  strictEqual,
  notStrictEqual,
  deepEqual,
  notDeepEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  match,
  doesNotMatch,
  AssertionError: strict.AssertionError,
  strict, // self-referential like Node: strict.strict === strict
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import strict, {
//   ok, equal, deepEqual, strictEqual, deepStrictEqual,
//   notEqual, notDeepEqual, notStrictEqual, notDeepStrictEqual,
//   throws, doesNotThrow, rejects, doesNotReject,
//   ifError, match, doesNotMatch, fail,
// } from './assert/strict';
//
// // All named exports are the same reference as on the default export:
// console.log(deepEqual === strict.deepEqual); // true
// console.log(strict.strict === strict);       // true (self-referential)
//
// // In strict mode deepEqual behaves like deepStrictEqual — no coercion:
// deepEqual(1, 1);                // ✓
// deepEqual({ a: 1 }, { a: 1 }); // ✓
// deepEqual(1, '1');              // ✗ AssertionError (would pass in legacy mode)
//
// // equal is strictEqual in strict mode:
// equal(1, 1);   // ✓
// equal(1, '1'); // ✗ AssertionError (no type coercion)
//
// // ok — truthy check
// ok(true);
// ok(1);
// ok('non-empty');
// ok(0); // ✗ AssertionError
//
// // throws / doesNotThrow
// throws(() => { throw new TypeError('boom'); }, TypeError);
// doesNotThrow(() => 42);
//
// // async rejects
// await rejects(Promise.reject(new Error('oops')), Error);
// await doesNotReject(Promise.resolve('fine'));
//
// // regex match
// match('hello world', /world/);
// doesNotMatch('hello', /world/);
//
// // ifError — throws if value is truthy (intended for error-first callbacks)
// ifError(null);    // ✓
// ifError(undefined); // ✓
// ifError(new Error('oh no')); // ✗ throws the error
//
// // fail — always throws
// try { fail('should not reach here'); } catch (e) { console.log(e.message); }
//
// // Edge: default export is the strict object itself
// import defaultAssert from './assert/strict';
// console.log(defaultAssert === assert.strict); // true
