// src/vendor/rollup-parseast.mjs — the `rollup/parseAst` subpath, backed by
// the real acorn parser.
//
// Why this exists: @rollup/browser (the vendor's official browser build of
// rollup 4) does NOT ship the `rollup/parseAst` subpath — its ESM export
// list is exactly { VERSION, defineConfig, rollup }. But vite 7's
// dist/node/index.js does
//   import { parseAst, parseAstAsync } from "rollup/parseAst"
// at its top level, so real Vite cannot boot in the browser runtime
// without this module. The interception table (src/browser-builds.js) maps
// `rollup/parseAst` here.
//
// This is NOT a fake: it really parses. parseAst(source, options) returns a
// genuine ESTree Program produced by acorn (the reference JavaScript
// parser), and invalid code throws a real SyntaxError with position info —
// the exact contract vite relies on (it reads `.body[0]` off the result).
// Parse failures are honest errors, never silent successes (repo rule: no
// silent fakes).
//
// API mirrors rollup 4's documented `rollup/parseAst` contract:
//   parseAst(source: string, options?: { allowReturnOutsideFunction?: boolean }): Program
//   parseAstAsync(source: string, options?: { allowReturnOutsideFunction?: boolean }): Promise<Program>
//
// In the browser runtime this module is seeded into the VFS at
// /node_modules/.bvm/rollup-parseast.mjs with the real acorn package
// seeded alongside it, so `from "acorn"` resolves through the runtime's
// own node_modules resolution.

import { parse } from "acorn";

const DEFAULT_OPTIONS = {
  ecmaVersion: "latest",
  // Rollup parses modules; acorn defaults to "script", so pin it.
  sourceType: "module",
};

function toAcornOptions(options) {
  if (options == null) return DEFAULT_OPTIONS;
  return {
    ...DEFAULT_OPTIONS,
    // rollup's ParseAstOptions passthrough. allowReturnOutsideFunction is
    // the only documented option; anything else is ignored rather than
    // misinterpreted (honest narrowing beats silent misbehavior).
    allowReturnOutsideFunction: options.allowReturnOutsideFunction === true,
  };
}

export function parseAst(source, options) {
  if (typeof source !== "string") {
    throw new TypeError(
      `parseAst: source must be a string, got ${typeof source}`,
    );
  }
  // acorn throws a real SyntaxError (with loc/pos) on invalid code — that
  // IS the honest behavior; rollup's parseAst throws too.
  return parse(source, toAcornOptions(options));
}

export async function parseAstAsync(source, options) {
  return parseAst(source, options);
}
