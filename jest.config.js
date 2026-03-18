export default {
  testEnvironment: "node",

  // where tests live
  testMatch: ["<rootDir>/test/*.test.js"],

  // important for modern ESM setups
  transform: {},

  // optional but useful
  verbose: true,
};
