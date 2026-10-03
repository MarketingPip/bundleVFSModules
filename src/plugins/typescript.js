/**
 * TypeScript plugin for bundleVFSModules.
 *
 * Transpiles TypeScript to JavaScript with the REAL TypeScript compiler
 * (`ts.transpileModule` — transpile-only, no type checking, the same
 * contract as esbuild/sucrase and Node's own type-stripping).
 *
 * The compiler is lazy-loaded on first `.ts`/`.tsx` transform so the ~8MB
 * payload is never fetched for pure-JS workloads:
 * - Under Node (tests, direct import): the npm `typescript` package
 *   (declared in package.json `dependencies`).
 * - In the browser host page: `https://esm.sh/typescript@<version>`
 *   (same pinned version; follows runtime.js's esm.sh convention).
 *
 * Module syntax is preserved as ESM (`module: ESNext`): the plugin runs at
 * the top of the parent-side `_build_file` pipeline, which handles
 * CJS→ESM detection and import rewriting downstream.
 */

const TS_VERSION = "5.9.2";

let compilerPromise = null;

/** Load the TypeScript compiler for this lane (Node vs browser). */
function loadCompiler() {
  if (!compilerPromise) {
    compilerPromise = (async () => {
      const isNode =
        typeof process !== "undefined" &&
        process.versions &&
        typeof process.versions.node === "string";
      if (isNode) {
        return await import("typescript");
      }
      return await import(`https://esm.sh/typescript@${TS_VERSION}`);
    })();
  }
  return compilerPromise;
}

export const typescriptPlugin = {
  name: "typescript",

  async transform(code, id) {
    if (!id.endsWith(".ts") && !id.endsWith(".tsx")) {
      return undefined; // passthrough for non-TS files
    }

    const ts = await loadCompiler();
    const result = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
        experimentalDecorators: true,
      },
      fileName: id,
    });

    return result.outputText;
  },
};
