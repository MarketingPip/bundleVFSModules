// Public entry API of the host runtime (Worker F extraction, branch
// modular/host): `executeCode` / `createSandbox`.
//
// Sources: runtime.js lines 6059-6073, copied verbatim.
//
// Error-formatting and seed/fs helpers (FormattedError, formatErrors,
// formatErrors2, normalizeSeaAssets, base64EncodeBytes, isSeedEnvelope,
// seedBytesToBase64, flattenFileTree) live in `./host-utils.js` and are
// re-exported here, so `entry.js` remains the single public surface for
// this section. They are split out because they are pure and independently
// testable, while this module's top-level `CodeSandbox` import cannot
// resolve until the class is extracted.
//
// CROSS-MODULE DEPENDENCY — `CodeSandbox`:
//   `export class CodeSandbox extends EventEmitter` (runtime.js:4036) was
//   extracted by Worker E to `src/runtime/code-sandbox.js` — the import
//   below points at that real module (present on the integration branch;
//   absent on a bare checkout of this branch until merged).

import { CodeSandbox } from "./code-sandbox.js";

export * from "./host-utils.js";

/**
 * Quick execution without configuration
 */
export async function executeCode(code, options = {}) {
  const sandbox = new CodeSandbox(options);
  await sandbox.init();
  return sandbox.execute(code);
}

/**
 * Create a configured sandbox instance
 */
export function createSandbox(options = {}) {
  return new CodeSandbox(options);
}
