// assert-strict.js
import assert from "assert";

// Use the strict version
const strict = assert.strict;

// Export default
export default strict;

// Export all strict methods as named exports
const {
  fail,
  ok,
  equal,
  notEqual,
  deepEqual,
  notDeepEqual,
  strictEqual,
  notStrictEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  ifError,
  match,
  doesNotMatch
} = strict;

export {
  fail,
  ok,
  equal,
  notEqual,
  deepEqual,
  notDeepEqual,
  strictEqual,
  notStrictEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  ifError,
  match,
  doesNotMatch,
  strict
};
