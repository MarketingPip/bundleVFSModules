const path = require("path");

module.exports = {
  mode: "production",
  entry: "./memfs-entry.js",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "memfs.bundle.js",
    library: {
      type: "module",
    },
  },
  experiments: {
    outputModule: true,
  },
};
