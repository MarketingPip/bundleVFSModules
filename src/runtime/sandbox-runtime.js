// src/runtime/sandbox-runtime.js — extracted verbatim from runtime.js
// (lines 3911-3990), branch modular/sandbox. `export` added to
// __parseStackLocationFn and SandboxRuntime (the only changes).
//
// __parseStackLocationFn is the single source of truth for V8 stack-frame
// parsing: the sandbox template inlines it via
// `const __parseStackLocationFn = (${__parseStackLocationFn.toString()});`
// so the iframe gets the identical implementation.
//
// Static ESM imports (paths adjusted for src/runtime/):
import { SANDBOX_TEMPLATE } from "../sandbox-template.js";
import { LOG_TOKENS } from "../sandbox/log-tokens.js";
//
// Host-provided bare references (still module scope in runtime.js; kept as-is
// like the original — the integration step will turn them into imports):
//   - normalizeBuiltinSpecifier (runtime.js:180)
//   - stripAnsi                (runtime.js:354)
//   - _builtinManifest         (runtime.js:73)
//   - builtinModules           (runtime.js:400, exported)

// Parse one V8 stack-frame line into {file, line, column}.
// Handles "at fn (https://host/app.js:10:15)", "at async fn (...)", and
// "at https://host/app.js:10:15". Anchored at the end so URL schemes
// (https://...) are never mistaken for the line/column separators.
// Defined once at module scope and exported for unit tests; the sandbox
// template below inlines it via const __parseStackLocationFn = (${__parseStackLocationFn.toString()}); so the
// iframe gets the identical implementation (single source of truth).
export function __parseStackLocationFn(frame) {
  let s = String(frame || "")
    .trim()
    .replace(/^at\s+(async\s+)?/, "");
  // data: URLs embed the whole (encoded) module source, which may contain
  // unencoded parens/quotes — match the URL as one unit before the generic
  // paren-stripping below (whose lastIndexOf('(') would land inside the
  // module source). Greedy: the only literal colons are the trailing
  // :line:column (inner colons are %-encoded).
  let m = s.match(/\(?(data:[^\s]*):(\d+):(\d+)\)?$/);
  if (m) return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
  const open = s.lastIndexOf("(");
  if (open !== -1 && s.endsWith(")")) s = s.slice(open + 1, -1);
  m = s.match(/^(.*):(\d+):(\d+)$/);
  if (!m) return null;
  return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
}

export class SandboxRuntime {
  static generate(code, config = {}) {
    // Serialize the BYO shell function (if provided) into the sandbox.
    // .toString() captures source, not closures — the function must be
    // self-contained.
    const shellField =
      typeof config.shell === "function"
        ? `__SHELL__: (${config.shell.toString()}),`
        : "";
    // The sandbox template lives in src/sandbox-template.js (built from
    // src/sandbox/*.js by src/build-sandbox.mjs). Substitute %%TOKEN%%s.
    // IMPORTANT: use replacement FUNCTIONS (not strings) — String.replace()
    // interprets $ patterns ($&, $', $1...) in string replacements, and user
    // code / imports can contain $.
    let result = SANDBOX_TEMPLATE;
    const sub = (token, value) => {
      result = result.replace(new RegExp(token, "g"), () => value);
    };
    sub("%%UUID%%", config.uuid);
    sub("%%INTEROP_VAR%%", config.interopVariable);
    sub("%%PROCESS_JSON%%", JSON.stringify(config.process));
    sub("%%USER_FILES_JSON%%", JSON.stringify(config.fs));
    sub(
      "%%SEA_ASSETS_JSON%%",
      JSON.stringify(
        config.seaAssets && Object.keys(config.seaAssets).length
          ? config.seaAssets
          : undefined,
      ),
    );
    sub("%%BUILTIN_MODULES_JSON%%", JSON.stringify(_builtinManifest));
    sub("%%BUILTIN_MODULES_ARRAY_JSON%%", JSON.stringify(builtinModules));
    sub("%%FILENAME%%", config.fileName);
    sub("%%STRIP_ANSI_FN%%", String(stripAnsi));
    sub("%%PARSE_STACK_LOCATION_FN%%", __parseStackLocationFn.toString());
    sub("%%SHELL_FIELD%%", shellField);
    sub(
      "%%NORMALIZE_BUILTIN_SPECIFIER_FN%%",
      normalizeBuiltinSpecifier.toString(),
    );
    for (const [suffix, stmt] of Object.entries(LOG_TOKENS)) {
      sub(
        `%%LOG_${suffix}%%`,
        config.logNetworkRequests ? stmt : "",
      );
    }
    sub("%%IMPORTS%%", config.imports?.join("\n") || "");
    // USER_CODE last: its value could theoretically contain %%TOKEN%%-like text.
    sub("%%USER_CODE%%", code);
    if (/%%[A-Z_]+%%/.test(result)) {
      throw new Error("SandboxRuntime.generate: unreplaced token in template");
    }
    return result;
  }
}
