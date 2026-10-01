/**
 * TypeScript plugin for bundleVFSModules.
 *
 * First plugin for the plugin API — transpiles TypeScript to JavaScript
 * by stripping type annotations. This is a minimal spike implementation;
 * a production version would bundle the full TypeScript compiler.
 *
 * Handles:
 * - Function parameter and return type annotations
 * - Variable type annotations
 * - Interface declarations (removed)
 * - Type alias declarations (removed)
 */

export const typescriptPlugin = {
  name: "typescript",

  transform(code, id) {
    if (!id.endsWith(".ts") && !id.endsWith(".tsx")) {
      return undefined; // passthrough for non-TS files
    }

    let result = code;

    // Remove interface declarations (multiline)
    result = result.replace(/interface\s+\w+\s*\{[^}]*\}/g, "");

    // Remove type alias declarations
    result = result.replace(/type\s+\w+\s*=\s*[^;]+;/g, "");

    // Remove function return type annotations: ): string {
    result = result.replace(/\)\s*:\s*[\w<>\[\]|,\s]+\s*\{/g, ") {");

    // Remove parameter type annotations: (name: string,
    // This is simplified — handles basic cases
    result = result.replace(/(\w+)\s*:\s*[\w<>\[\]|,\s?]+(?=[,)])/g, "$1");

    // Remove variable type annotations: const x: number =
    result = result.replace(
      /(const|let|var)\s+(\w+)\s*:\s*[\w<>\[\]|,\s?]+\s*=/g,
      "$1 $2 =",
    );

    return result;
  },
};
