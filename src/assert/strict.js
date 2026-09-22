/**
 * node:assert/strict port for browsers & bundlers — dependency-free ESM.
 *
 * Ported from Node.js v24.20.0: `require('assert').strict` (lib/assert.js).
 * Re-exports the strict-mode assert object as the default export plus
 * fully-destructured named exports, mirroring node's shape:
 *
 *   import strict, { deepEqual } from 'assert/strict';
 *   strict === strict.strict  // true (self-referential, matches Node)
 */

import assert from '../assert.js';

// `assert.strict` is the strict-mode view: deepEqual → deepStrictEqual,
// equal → strictEqual, etc. It is also self-referential: strict.strict === strict.
const strict = assert.strict;

// ---------------------------------------------------------------------------
// Named exports — all public methods on assert.strict.
// Destructured here so each export is the *same function reference* as on the
// strict object itself, not a wrapper (matters for identity checks).
// ---------------------------------------------------------------------------
export const {
  // Core assertion
  ok,
  fail,
  ifError,

  // Equality — in strict mode these are the strict variants
  equal, // → strictEqual
  notEqual, // → notStrictEqual
  strictEqual,
  notStrictEqual,
  deepEqual, // → deepStrictEqual
  notDeepEqual, // → notDeepStrictEqual
  deepStrictEqual,
  notDeepStrictEqual,
  partialDeepStrictEqual,

  // Errors / promises
  throws,
  rejects,
  doesNotThrow,
  doesNotReject,

  // Matching
  match,
  doesNotMatch,

  // Classes / misc
  AssertionError,
  Assert,
  CallTracker,
} = strict;

export default strict;
