
import primordials from "./per_context/primordials.js"; // using plugin namespace


if (!globalThis.primordials) {
  globalThis.primordials = primordials;
}

import * as b from "https://github.com/nodejs/node/blob/main/lib/internal/errors.js"; // using plugin namespace

// Re-export all named exports
export * from "https://github.com/nodejs/node/blob/main/lib/internal/errors.js";

// Default export
export { b as default };
