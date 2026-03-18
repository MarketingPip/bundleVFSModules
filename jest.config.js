export default {
  testEnvironment: "node",

  // where tests live
  testMatch: ["<rootDir>/tests/*.test.js"],

  // important for modern ESM setups
  transform: {},
  extensionsToTreatAsEsm: [".js"],
  // optional but useful
  verbose: true,
};
