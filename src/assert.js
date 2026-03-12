import assert from "assert";

export default assert;

// Re-export all properties of assert as named exports
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
