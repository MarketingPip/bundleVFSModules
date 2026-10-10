// Dual-lane imports (pattern from src/plugins/typescript.js):
// - Under Node (tests, direct import): the npm `acorn` / `typescript`
//   packages declared in package.json.
// - In the browser host page: the exact esm.sh specifiers runtime.js used.
function isNodeLane() {
  return (
    typeof process !== "undefined" &&
    process.versions &&
    typeof process.versions.node === "string"
  );
}

const acorn = await (isNodeLane()
  ? import("acorn")
  : import("https://esm.sh/acorn"));

const tsModule = await (isNodeLane()
  ? import("typescript")
  : import("https://esm.sh/typescript@5.4.5"));
const ts = tsModule.default ?? tsModule;

// acorn-import-assertions is not in this repo's node_modules, so the Node
// lane degrades to the plain acorn Parser (still parses standard ESM; only
// `import ... assert {}` needs the plugin). The browser lane keeps the exact
// runtime.js behavior via esm.sh.
const importAssertions = await (async () => {
  if (isNodeLane()) {
    try {
      const m = await import("acorn-import-assertions");
      return m.default ?? m;
    } catch {
      return null;
    }
  }
  return (await import("https://esm.sh/acorn-import-assertions"))
    .importAssertions;
})();

/**
 * Transpiles a string of TypeScript code into JavaScript.
 * @param {string} tsCode - The TypeScript source code.
 * @returns {string} - The resulting JavaScript.
 */
export function transpileTypeScript(tsCode) {
  const result = ts.transpileModule(tsCode, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      jsx: ts.JsxEmit.React, // Added just in case you use JSX
      removeComments: true,
    },
  });

  return result.outputText;
}

export const customAcorn = importAssertions
  ? acorn.Parser.extend(importAssertions)
  : acorn.Parser;
