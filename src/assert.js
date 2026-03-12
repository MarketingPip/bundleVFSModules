// npm install assert

/*!
 * assert-web — Node.js `assert` for browsers & bundlers
 * MIT License.
 * Dependencies: assert (npm)
 * Notes:
 *   - This module re-exports the Node.js `assert` API.
 *   - Both named exports and a default export are provided for flexibility.
 *   - The default export is an object containing all the named exports.
 */

/**
 * @packageDocumentation
 * Re-exports `assert` as both named exports and a default export.
 *
 * This mirrors the Node.js behavior where:
 *
 *   import assert from 'assert';
 *   import { ok, deepEqual } from 'assert';
 *
 * Named exports maintain the same function references as the original
 * `assert` object. The default export contains all these references, plus
 * `AssertionError`.
 */

import assert from "assert";

// ---------------------------------------------------------------------------
// Named exports — all public methods on assert
// Destructured here so each export is the *same function reference* as on the
// assert object itself. This ensures compatibility with consumers who rely
// on reference equality (e.g., `deepEqual === assert.deepEqual`).
// ---------------------------------------------------------------------------
export const {
  // Core assertion
  ok,
  fail,
  ifError,

  // Equality
  equal,
  notEqual,
  strictEqual,
  notStrictEqual,

  // Deep equality
  deepEqual,
  notDeepEqual,
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

  // Error constructor
  AssertionError
} = assert;

// ---------------------------------------------------------------------------
// Default export — all methods + AssertionError
// Provides a single object containing all named exports.
// Similar to `import assert from 'assert'` in Node.js.
// ---------------------------------------------------------------------------
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
  AssertionError
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import assert, {
//   ok, equal, deepEqual, strictEqual, deepStrictEqual,
//   notEqual, notDeepEqual, notStrictEqual, notDeepStrictEqual,
//   throws, doesNotThrow, rejects, doesNotReject,
//   ifError, match, doesNotMatch, fail,
//   AssertionError
// } from './assert';
//
// ok(true);                       // ✓
//
// deepEqual({ a: 1 }, { a: 1 });  // ✓
// equal(1, 1);                     // ✓
// throws(() => { throw new Error('boom'); }, Error); // ✓
//
// console.log(assert.deepEqual === deepEqual); // true — same reference
