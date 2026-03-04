// Import the browser-compatible implementation
import * as browserZlib from "browserify-zlib";

// Re-export **everything as named exports**
export * from "browserify-zlib";

// Default export (matches Node.js default import semantics)
export default browserZlib;
