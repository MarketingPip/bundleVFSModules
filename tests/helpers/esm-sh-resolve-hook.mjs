// tests/helpers/esm-sh-resolve-hook.mjs — Node ESM resolve hook for
// differential tests of the browser-targeted runtime.js build.
//
// The built runtime.js (src/build-runtime.mjs) targets the browser host:
// its static imports use the exact esm.sh specifiers the original runtime.js
// used (https://esm.sh/acorn, …). Node cannot resolve https: specifiers, so
// this hook maps each one to the IDENTICAL npm package in this repo's
// node_modules, letting the bundle be imported under Node for behavioral
// differential tests. The browser lane is unaffected (this hook only exists
// in the test process).
//
// Usage (before importing the built file):
//   import { register } from "node:module";
//   register("./helpers/esm-sh-resolve-hook.mjs", import.meta.url);

const MAP = {
  "https://esm.sh/acorn": "acorn",
  "https://esm.sh/acorn-walk": "acorn-walk",
  "https://esm.sh/magic-string": "magic-string",
  "https://esm.sh/estree-walker": "estree-walker",
  "https://esm.sh/uuid": "uuid",
  "https://esm.sh/@jridgewell/trace-mapping": "@jridgewell/trace-mapping",
  // @ampproject/remapping is the published name of @jridgewell/remapping.
  "https://esm.sh/@ampproject/remapping": "@jridgewell/remapping",
};

export async function resolve(specifier, context, nextResolve) {
  const mapped = MAP[specifier];
  if (mapped) return nextResolve(mapped, context);
  return nextResolve(specifier, context);
}
