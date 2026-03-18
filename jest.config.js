export default {
  testEnvironment: "node",

  // where tests live
  testMatch: ["<rootDir>/tests/*.test.js"],

  // important for modern ESM setups
  transform: {},

   moduleNameMapper: {
  '^stream-browserify$': 'stream',
  '^crypto-browserify$': 'crypto'   
}
  // optional but useful
  verbose: true,
};
