export default {
  testEnvironment: "node",

  // where tests live
  testMatch: ["<rootDir>/tests/*.test.js"],

  // important for modern ESM setups
  transform: {},

  // optional but useful
  verbose: true,

  // Fail-fast: a test that hasn't finished in 30s is hung (e.g. the 8 http
  // agent-pooling tests that never resolve). Without this, one stuck test
  // stalls the entire suite and burns the 6h CI job cap.
  testTimeout: 30000,
};
