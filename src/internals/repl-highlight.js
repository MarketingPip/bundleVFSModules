// Port of Node 26 lib/internal/repl/highlight.js — syntax highlighting
// for REPL input (Node lib/repl.js:112 requires it, :330 passes it as the
// readline `colorize` when useColors is on).
//
// Differences from Node (all deliberate, behaviour-preserving):
// - primordials replaced with plain String.prototype.slice /
//   Function.prototype.bind (the shim has no primordials).
// - `internal/deps/acorn` replaced with the `acorn` npm dep (already a
//   direct dep; src/repl.js imports it the same way). `Parser.tokenizer`
//   uses `new this(...)`, so it stays bound to Parser exactly as Node
//   binds it.
// - `stylizeWithColor` from `internal/util/inspect` replaced with a
//   local wrapper over the shim's PUBLIC `inspect.styles` /
//   `inspect.colors` (src/util.js:4196-4197) — same table, same
//   `\u001b[<open>m...\u001b[<close>m` shape, so highlight() output
//   matches the shim's inspect.colors exactly. NOT imported from
//   src/util.js: exporting it there would pollute the node:util surface
//   (tests/export_surface_util.test.js failed on the extra export).
// - ESM export instead of `module.exports`.
//
// ponytail: ceiling — the shim's REPLServer does not wire this in as its
// readline `colorize` yet (Node 26 lib/repl.js:330); useColors:true input
// is still rendered plain. Wiring it in is a separate behaviour change:
// the interactive redraw path must be proven not to leak ANSI into the
// ArrayStream transcripts the repl tests assert on.
import * as acorn from "acorn";
import { inspect } from "../util.js";

// Local stylize over the shim's public inspect tables (same values and
// wrap shape as src/util.js's module-local stylizeWithColor). Mirrors
// Node 26 lib/internal/util/inspect.js:850-862, including the
// function-style branch: Wave 1 util #513 set
// `inspect.styles.regexp = highlightRegExp` (a FUNCTION,
// src/util.js:1100), so `inspect.colors[style]` is undefined for it and
// the function itself must be called — otherwise highlight('/regexp/u')
// returns unstylized.
// ponytail: ceiling — a style that is neither a known color name nor a
// function still falls through unstylized, matching Node; if a future
// util style becomes an object (e.g. a {open,close} pair), this branch
// needs a matching case here, not a change in src/util.js.
function stylizeWithColor(str, styleType) {
  const style = inspect.styles[styleType];
  if (style !== undefined) {
    const color = inspect.colors[style];
    if (color !== undefined) {
      return `\u001B[${color[0]}m${str}\u001B[${color[1]}m`;
    }
    if (typeof style === "function") {
      return style(str);
    }
  }
  return str;
}

const tokenizer = acorn.Parser.tokenizer.bind(acorn.Parser);

function tokenStyle(token) {
  const { label, keyword } = token.type;

  if (keyword !== undefined) {
    if (label === "true" || label === "false") return "boolean";
    if (label === "null") return "null";
    if (label === "import" || label === "export") return "module";
    return "special";
  }

  switch (label) {
    case "name":
      switch (token.value) {
        case "undefined":
          return "undefined";
        case "NaN":
        case "Infinity":
          return "number";
        case "Symbol":
          return "symbol";
        case "Date":
          return "date";
        default:
          return undefined;
      }
    case "num":
      return "number";
    case "bigint":
      return "bigint";
    case "string":
    case "template":
    case "`":
      return "string";
    case "regexp":
      return "regexp";
    default:
      return undefined;
  }
}

export function highlight(code) {
  if (code.length === 0) return code;

  let result = "";
  let offset = 0;
  function write(start, end, style) {
    result +=
      code.slice(offset, start) + stylizeWithColor(code.slice(start, end), style);
    offset = end;
  }

  try {
    const iterator = tokenizer(code, {
      __proto__: null,
      allowHashBang: true,
      ecmaVersion: "latest",
      onComment(_block, _text, start, end) {
        write(start, end, "undefined");
      },
    });

    for (const token of iterator) {
      const style = tokenStyle(token);
      if (style !== undefined) {
        write(token.start, token.end, style);
      }
    }
  } catch {
    // Acorn throws for unfinished strings, templates, and comments. Tokens and
    // comments reported before that point are still useful while typing.
  }

  return result + code.slice(offset);
}
