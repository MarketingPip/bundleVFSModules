// src/runtime/syntax.js — extracted verbatim from runtime.js (lines 2336-2365),
// branch modular/resolution. Host-provided global: `acorn` (runtime.js imports
// it from "https://esm.sh/acorn"); kept as a bare reference like the original.
// ============================================================================
// SYNTAX CHECKER MODULE
// ============================================================================

export class SyntaxChecker {
  constructor(options = {}) {
    this.ecmaVersion = options.ecmaVersion ?? "latest";
  }

  /**
   * Check JavaScript syntax using Acorn parser
   * @param {string} code - The code to validate
   * @returns {{ valid: boolean, error?: string }}
   */
  check(code) {
    try {
      acorn.parse(code, {
        sourceType: "module",
        locations: true,
        ecmaVersion: this.ecmaVersion,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: false,
      });

      return { valid: true };
    } catch (err) {
      throw err;
    }
  }
}
