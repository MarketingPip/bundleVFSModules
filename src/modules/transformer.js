// ============================================================================
// CODE TRANSFORMER MODULE
// ============================================================================

export class CodeTransformer {
  /**
   * Apply multiple transformations to code
   */
  static transform(code, transformers = []) {
    return transformers.reduce((result, transformer) => {
      try {
        return transformer(result);
      } catch (err) {
        console.warn("Transformer error:", err);
        return result;
      }
    }, code);
  }

  /**
   * Built-in transformers
   */
  static transformers = {
    // Remove console statements
    removeConsole: (code) =>
      code.replace(/console\.(log|info|warn|error|debug)\([^)]*\);?/g, ""),

    // Wrap in async IIFE if not already wrapped
    wrapAsync: (code) => {
      if (!code.trim().startsWith("(async")) {
        return `(async () => {\n${code}\n})();`;
      }
      return code;
    },

    // Add strict mode
    addStrictMode: (code) => `'use strict';\n${code}`,
  };
}

