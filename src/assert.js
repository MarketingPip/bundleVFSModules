import assert from "assert";

// Re-export as named exports
export const {
  ok,
  equal,
  strictEqual,
  notEqual,
  notStrictEqual,
  deepEqual,
  notDeepEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  ifError,
  fail,
  match,
  doesNotMatch,
  AssertionError
} = assert;

// Also export everything as default
export default {
  ok,
  equal,
  strictEqual,
  notEqual,
  notStrictEqual,
  deepEqual,
  notDeepEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  ifError,
  fail,
  match,
  doesNotMatch,
  AssertionError
};
