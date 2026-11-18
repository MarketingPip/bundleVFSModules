// npm install (none — depends only on your readline/vm/util shims)

/*!
 * repl-web — node:repl for browsers & bundlers
 * MIT License.
 * Node.js parity: node:repl @ Node 0.1.91+
 * Dependencies: readline shim, vm shim, util shim, fs shim (optional)
 * Limitations:
 *   - History is in-memory only (no .node_repl_history persistence)
 *   - .save/.load map to VFS via fs shim; silently fail if unavailable
 *   - breakEvalOnSigint accepted but inert (no SIGINT watchdog)
 *   - domain option throws (removed in Node 24)
 */

import { Interface } from "./readline";
import vm from "./vm";
import { inspect } from "./util";
import {
  Module as CJSModule,
  builtinModules as nodeBuiltinModules,
  isBuiltin,
  _resolveFilename,
  _resolveLookupPaths,
  _cache,
  _extensions,
} from "./module";
import * as acorn from "acorn";
import * as walk from "acorn-walk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REPL_MODE_SLOPPY = Symbol("repl.sloppy");
export const REPL_MODE_STRICT = Symbol("repl.strict");

const kBufferedCommand = Symbol("bufferedCommand");
const kLoading = Symbol("loading");
const kContextId = Symbol("contextId"); // inspector stub — no-op
const kRegExpStatics = Symbol("regexpStatics"); // snapshot of RegExp.$1..$9

// ---------------------------------------------------------------------------
// NullStream
// Satisfies readline Interface's input/output contract when no streams given.
// ---------------------------------------------------------------------------

class NullStream {
  constructor() {
    this._ev = Object.create(null);
    this.isTTY = false;
    this.readable = true;
    this.writable = true;
  }
  write() {
    return true;
  }
  read() {
    return null;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  setEncoding() {
    return this;
  }
  setRawMode() {
    return this;
  }
  pipe(d) {
    return d;
  }
  unpipe() {
    return this;
  }
  on(ev, fn) {
    (this._ev[ev] ||= []).push(fn);
    return this;
  }
  once(ev, fn) {
    const w = (...a) => {
      this.off(ev, w);
      fn(...a);
    };
    return this.on(ev, w);
  }
  off(ev, fn) {
    if (this._ev[ev]) this._ev[ev] = this._ev[ev].filter((f) => f !== fn);
    return this;
  }
  removeListener(ev, fn) {
    return this.off(ev, fn);
  }
  removeAllListeners(ev) {
    if (ev) delete this._ev[ev];
    else this._ev = Object.create(null);
    return this;
  }
  emit(ev, ...a) {
    for (const fn of this._ev[ev] || []) fn(...a);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Recoverable
// ---------------------------------------------------------------------------

/**
 * Wraps a SyntaxError to signal the REPL should buffer and prompt for more.
 * @example
 *   if (isRecoverable(e)) return cb(new repl.Recoverable(e));
 */
export class Recoverable extends SyntaxError {
  /** @param {SyntaxError} err */
  constructor(err) {
    super();
    this.err = err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Node lib/internal/repl/utils.js isRecoverableError, ported to the
// acorn npm package (a direct dep). Whether a SyntaxError is recoverable
// is decided by RE-PARSING the input with an Acorn parser that records
// whether the EOF token was reached and whether an unterminated
// template/comment/string was raised — not by testing the error message.
// A bare message test is wrong both ways: the same "Unexpected token ')'"
// is recoverable for the first line `"{}),({}"` (its parenthesized retry
// ends mid-construct) but not for the completed `"{}),({}\n}"`, and a
// runtime "Unexpected end of input" from an inner eval
// (`eval("function test_func() {")`) is never recoverable because the
// outer code parses cleanly.
function isRecoverableError(e, code) {
  if (!(e instanceof SyntaxError)) return false;

  // `{`-wrap retry (Node): an input starting with `{` may be an object
  // literal typed across lines — retry the check on the parenthesized
  // form (only the open paren is added: the point is to test for
  // potentially valid but incomplete expressions).
  if (/^\s*\{/.test(code) && isRecoverableError(e, `(${code}`)) return true;

  let recoverable = false;
  const RecoverableParser = acorn.Parser.extend((Parser) => {
    return class extends Parser {
      nextToken() {
        super.nextToken();
        if (this.type === acorn.tokTypes.eof) recoverable = true;
      }
      raise(pos, message) {
        switch (message) {
          case "Unterminated template":
          case "Unterminated comment":
            recoverable = true;
            break;
          case "Unterminated string constant": {
            const token = this.input.slice(this.lastTokStart, this.pos);
            if (/\\(?:\r\n?|\n|\u2028|\u2029)$/.test(token)) recoverable = true;
            break;
          }
        }
        super.raise(pos, message);
      }
    };
  });

  try {
    RecoverableParser.parse(code, { ecmaVersion: "latest" });
    // Acorn parsed it but V8 rejected it — additional text won't help.
    return false;
  } catch {
    return recoverable;
  }
}

// Node lib/internal/repl/utils.js isObjectLiteral — the `{`-wrap in
// defaultEval applies only when the input is an object literal.
function isObjectLiteral(code) {
  return /^\s*\{/.test(code) && !/;\s*$/.test(code);
}

// RegExp legacy statics ($1..$9) are global and are reset by ANY regex
// match anywhere in the process — the repl's own pipeline, the test
// harness, or Node internals. Node's C++ readline never runs a JS regex,
// so the statics survive between user evals there; a JS repl cannot rely
// on that (test-repl.js RegExp.$1..$9: the statics a user's `.test()` set
// are "" by the time the next line evals, even though no shim code in the
// eval path runs a matching regex — the clobbering source was never
// isolated). Snapshot them after each user eval (_finish) and restore
// them before the next (_defaultEval), so a `RegExp.$1` read sees the
// value the user's own previous match set. The restore builds a regex
// whose 9 groups literally capture the snapshot values (escaped, so the
// pattern is all literals and always matches their concatenation).
// Limitation: $&, $', $`, lastMatch are NOT restored (only $1..$9) —
// no test reads them.
function restoreRegExpStatics(values) {
  if (!values) return;
  const pattern = values
    .map((v) => `(${String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`)
    .join("");
  new RegExp(pattern).exec(values.join(""));
}

// Top-level `let`/`const` in an indirect eval do not persist: they bind
// in the eval's own declarative environment, which is discarded when the
// eval returns. Node's repl persists them because it evaluates via
// vm.Script in the global context (V8 keeps `let` bindings in the
// context's global lexical environment). The shim's useGlobal path is
// indirect eval, so rewrite top-level `let`/`const` to `var` (same span
// for `let`; `const` is padded with spaces so error positions are
// unchanged) before evaluating. Only direct children of the Program are
// rewritten; nested `let`/`const` keep their semantics. `class`
// declarations have the same non-persistence, but no test exercises
// cross-eval class persistence — left as a documented gap. Best-effort:
// if Acorn cannot parse the code, it is returned unchanged and the eval
// reports the SyntaxError as before.
function persistTopLevelLexical(code) {
  // Fast path: no `let`/`const` substring means no top-level lexical
  // declaration — skip the Acorn parse entirely. This matters: Acorn's
  // internal regexes clobber the global RegExp statics ($1..$9), so
  // parsing on every eval would break `RegExp.$1` reads after a regex
  // match (test-repl.js RegExp.$1..$9 case). `includes` is a substring
  // check (no regex), so it cannot clobber the statics. (Residual edge:
  // a `let`/`const` declaration whose initializer itself reads RegExp
  // statics would see Acorn-clobbered values — no test covers it.)
  if (!code.includes("let") && !code.includes("const"))
    return { code, names: [] };
  let ast;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: "latest",
      allowAwaitOutsideFunction: true,
    });
  } catch {
    return { code, names: [] };
  }
  const spans = [];
  const names = [];
  const collectNames = (pattern) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") names.push(pattern.name);
    else if (pattern.type === "ObjectPattern") {
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") collectNames(prop.argument);
        else collectNames(prop.value);
      }
    } else if (pattern.type === "ArrayPattern") {
      for (const el of pattern.elements) collectNames(el);
    } else if (pattern.type === "RestElement") collectNames(pattern.argument);
    else if (pattern.type === "AssignmentPattern") collectNames(pattern.left);
  };
  for (const node of ast.body) {
    if (
      node.type === "VariableDeclaration" &&
      (node.kind === "let" || node.kind === "const")
    ) {
      spans.push([node.start, node.kind]);
      for (const decl of node.declarations) collectNames(decl.id);
    }
  }
  if (spans.length === 0) return { code, names: [] };
  spans.sort((a, b) => b[0] - a[0]);
  for (const [start, kind] of spans) {
    const replacement = kind === "let" ? "var" : "var  ";
    code = code.slice(0, start) + replacement + code.slice(start + kind.length);
  }
  return { code, names };
}

// Port of Node lib/repl.js:228 toDynamicImport (acorn-based): converts
// a static import statement into the dynamic-import suggestion printed in
// the "Cannot use import statement inside the Node.js REPL" error. The
// old regex version was wrong for default imports — it printed
// `const comeOn = await import('fhqwhgads');` where Node prints
// `const { default: comeOn } = await import("fhqwhgads");` (default
// specifiers destructure the default export; the source is JSON-quoted,
// so double quotes). Namespace imports keep the plain `const name = ...`
// form; bare side-effect imports print just `await import(...);`.
function toDynamicImport(line) {
  if (!line) return "";
  try {
    const ast = acorn.parse(line, {
      sourceType: "module",
      ecmaVersion: "latest",
    });
    const node = ast.body && ast.body[0];
    if (!node || node.type !== "ImportDeclaration") return "";
    const awaitDynamicImport = `await import(${JSON.stringify(node.source.value)});`;
    if (node.specifiers.length === 0) {
      return awaitDynamicImport;
    }
    if (
      node.specifiers.length === 1 &&
      node.specifiers[0].type === "ImportNamespaceSpecifier"
    ) {
      return `const ${node.specifiers[0].local.name} = ${awaitDynamicImport}`;
    }
    const importNames = node.specifiers
      .map(({ local, imported }) =>
        local.name === imported?.name
          ? local.name
          : `${imported?.name ?? "default"}: ${local.name}`,
      )
      .join(", ");
    return `const { ${importNames} } = ${awaitDynamicImport}`;
  } catch {
    // Not a parseable import line (Node would throw here; the shim's
    // call site is inside _defaultEval, so fall back to the old shape
    // instead of masking the original error).
    const m2 = line.match(/^\s*import\s*(['"`][^'"`]+['"`])/);
    if (m2) return `await import(${m2[1]});`;
    return `await import(/* ${line.trim()} */);`;
  }
}

// Node lib/internal/repl/await.js, ported to the acorn + acorn-walk npm
// packages (both direct deps, already imported by src/runtime/*).
// Rewrites top-level await so it can run inside an async IIFE: top-level
// declarations are hoisted (let/var) and rewritten to assignments, the
// last expression statement becomes `return { value: (...) }` so the
// caller can retrieve the awaited value without awaiting it twice
// (a bare `await p` whose value IS a Promise must print as a Promise).
// Returns null when there is no top-level await (or a top-level return),
// throws a caret-formatted SyntaxError for unparseable input.
// The old shim version wrapped code as `(async()=>{...})()` with NO
// return — it always resolved to undefined (the value-drop the triage
// correction names); the `new Function` validity check also swallowed
// the caret error by returning null on SyntaxError.

function isTopLevelDeclaration(state) {
  return state.ancestors[state.ancestors.length - 2] === state.body;
}

const visitorsWithoutAncestors = {
  ClassDeclaration(node, state, c) {
    if (isTopLevelDeclaration(state)) {
      state.prepend(node, `${node.id.name}=`);
      state.hoistedDeclarationStatements.push(`let ${node.id.name}; `);
    }

    walk.base.ClassDeclaration(node, state, c);
  },
  ForOfStatement(node, state, c) {
    if (node.await === true) {
      state.containsAwait = true;
    }
    walk.base.ForOfStatement(node, state, c);
  },
  FunctionDeclaration(node, state) {
    // No walk.base call (unlike the other visitors): the body of a
    // nested function is not top-level, so its awaits must not set
    // containsAwait. (Node's version keeps a vestigial `c` param.)
    state.prepend(node, `this.${node.id.name} = ${node.id.name}; `);
    state.hoistedDeclarationStatements.push(`var ${node.id.name}; `);
  },
  FunctionExpression: () => {},
  ArrowFunctionExpression: () => {},
  MethodDefinition: () => {},
  AwaitExpression(node, state, c) {
    state.containsAwait = true;
    walk.base.AwaitExpression(node, state, c);
  },
  ReturnStatement(node, state, c) {
    state.containsReturn = true;
    walk.base.ReturnStatement(node, state, c);
  },
  VariableDeclaration(node, state, c) {
    const variableKind = node.kind;
    const isIterableForDeclaration = [
      "ForOfStatement",
      "ForInStatement",
    ].includes(state.ancestors[state.ancestors.length - 2].type);

    if (variableKind === "var" || isTopLevelDeclaration(state)) {
      state.replace(
        node.start,
        node.start + variableKind.length + (isIterableForDeclaration ? 1 : 0),
        variableKind === "var" && isIterableForDeclaration
          ? ""
          : "void" + (node.declarations.length === 1 ? "" : " ("),
      );

      if (!isIterableForDeclaration) {
        for (const decl of node.declarations) {
          state.prepend(decl, "(");
          state.append(decl, decl.init ? ")" : "=undefined)");
        }

        if (node.declarations.length !== 1) {
          state.append(node.declarations[node.declarations.length - 1], ")");
        }
      }

      const variableIdentifiersToHoist = [
        ["var", []],
        ["let", []],
      ];
      function registerVariableDeclarationIdentifiers(node) {
        switch (node.type) {
          case "Identifier":
            variableIdentifiersToHoist[variableKind === "var" ? 0 : 1][1].push(
              node.name,
            );
            break;
          case "ObjectPattern":
            for (const property of node.properties) {
              registerVariableDeclarationIdentifiers(
                property.value || property.argument,
              );
            }
            break;
          case "ArrayPattern":
            for (const element of node.elements) {
              registerVariableDeclarationIdentifiers(element);
            }
            break;
        }
      }

      for (const decl of node.declarations) {
        registerVariableDeclarationIdentifiers(decl.id);
      }

      for (const [kind, identifiers] of variableIdentifiersToHoist) {
        if (identifiers.length > 0) {
          state.hoistedDeclarationStatements.push(
            `${kind} ${identifiers.join(", ")}; `,
          );
        }
      }
    }

    walk.base.VariableDeclaration(node, state, c);
  },
};

const visitors = {};
for (const nodeType of Object.keys(walk.base)) {
  const callback = visitorsWithoutAncestors[nodeType] || walk.base[nodeType];
  visitors[nodeType] = (node, state, c) => {
    const isNew = node !== state.ancestors[state.ancestors.length - 1];
    if (isNew) {
      state.ancestors.push(node);
    }
    callback(node, state, c);
    if (isNew) {
      state.ancestors.pop();
    }
  };
}

// Whether `code` contains a `return` outside any function (a top-level
// return is "Illegal return statement" as a script). Parses with
// allowReturnOutsideFunction so the return is visible in the AST;
// function boundaries are not descended into, so a `return` inside a
// nested function does not count. A bare block / `if` at the top level
// DOES count (V8 rejects `return` there too). Returns false when the
// code does not parse — the caller then falls through to the normal
// path, which reports its own error.
function hasTopLevelReturn(code) {
  let ast;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: "latest",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch {
    return false;
  }
  const stack = [...ast.body];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node.type !== "string") continue;
    if (node.type === "ReturnStatement") return true;
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    )
      continue;
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child)
          if (c && typeof c.type === "string") stack.push(c);
      } else if (child && typeof child.type === "string") {
        stack.push(child);
      }
    }
  }
  return false;
}

function processTopLevelAwait(src) {
  const wrapPrefix = "(async () => { ";
  const wrapped = `${wrapPrefix}${src} })()`;
  const wrappedArray = wrapped.split("");
  let root;
  try {
    root = acorn.parse(wrapped, { ecmaVersion: "latest" });
  } catch (e) {
    if (e.message.startsWith("Unterminated ")) throw new Recoverable(e);
    // If the parse error is before the first "await", then use the execution
    // error. Otherwise we must emit this parse error, making it look like a
    // proper syntax error.
    const awaitPos = src.indexOf("await");
    const errPos = e.pos - wrapPrefix.length;
    if (awaitPos > errPos) return null;
    // Convert keyword parse errors on await into their original errors when
    // possible.
    if (
      errPos === awaitPos + 6 &&
      e.message.includes("Expecting Unicode escape sequence")
    )
      return null;
    if (errPos === awaitPos + 7 && e.message.includes("Unexpected token"))
      return null;
    const line = e.loc.line;
    const column = line === 1 ? e.loc.column - wrapPrefix.length : e.loc.column;
    let message =
      "\n" +
      src.split("\n", line)[line - 1] +
      "\n" +
      " ".repeat(column) +
      "^\n\n" +
      e.message.replace(/ \([^)]+\)/, "");
    // V8 unexpected token errors include the token string.
    if (message.endsWith("Unexpected token"))
      message +=
        " '" + (src[e.pos - wrapPrefix.length] ?? src[src.length - 1]) + "'";
    throw new SyntaxError(message);
  }
  const body = root.body[0].expression.callee.body;
  const state = {
    body,
    ancestors: [],
    hoistedDeclarationStatements: [],
    replace(from, to, str) {
      for (let i = from; i < to; i++) {
        wrappedArray[i] = "";
      }
      if (from === to) str += wrappedArray[from];
      wrappedArray[from] = str;
    },
    prepend(node, str) {
      wrappedArray[node.start] = str + wrappedArray[node.start];
    },
    append(node, str) {
      wrappedArray[node.end - 1] += str;
    },
    containsAwait: false,
    containsReturn: false,
  };

  walk.recursive(body, state, visitors);

  // Do not transform if
  // 1. False alarm: there isn't actually an await expression.
  // 2. There is a top-level return, which is not allowed.
  if (!state.containsAwait || state.containsReturn) {
    return null;
  }

  for (let i = body.body.length - 1; i >= 0; i--) {
    const node = body.body[i];
    if (node.type === "EmptyStatement") continue;
    if (node.type === "ExpressionStatement") {
      // For an expression statement of the form
      // ( expr ) ;
      // ^^^^^^^^^^   // node
      //   ^^^^       // node.expression
      //
      // We do not want the left parenthesis before the `return` keyword;
      // therefore we prepend the `return (` to `node`.
      //
      // On the other hand, we do not want the right parenthesis after the
      // semicolon. Since there can only be more right parentheses between
      // node.expression.end and the semicolon, appending one more to
      // node.expression should be fine.
      //
      // We also create a wrapper object around the result of the expression.
      // Consider an expression of the form `(await x).y`. If we just return
      // this expression from an async function, the caller will await `y`, too,
      // if it evaluates to a Promise. Instead, we return
      // `{ value: ((await x).y) }`, which allows the caller to retrieve the
      // awaited value correctly.
      state.prepend(node.expression, "{ value: (");
      state.prepend(node, "return ");
      state.append(node.expression, ") }");
    }
    break;
  }

  return state.hoistedDeclarationStatements.join("") + wrappedArray.join("");
}

// ---------------------------------------------------------------------------
// Deprecation warnings — Node's deprecate() emits once per process.
// ---------------------------------------------------------------------------

const _depWarned = new Set();
function emitDeprecationOnce(code, message) {
  if (_depWarned.has(code)) return;
  _depWarned.add(code);
  if (
    typeof process !== "undefined" &&
    process !== null &&
    typeof process.emitWarning === "function"
  ) {
    process.emitWarning(message, "DeprecationWarning", code);
  }
}

// ---------------------------------------------------------------------------
// shouldColorize — port of Node lib/internal/util/colors.js shouldColorize()
// ---------------------------------------------------------------------------
// A stream colorizes only when it IS a TTY (with color depth > 2 when it
// reports one), unless FORCE_COLOR is set. NOTE: this is NOT the util.js
// stand-in (which defaults ON for non-TTY streams, for console use) — the
// repl default follows Node's rule, so a non-TTY output gets no colors.
function shouldColorizeRepl(stream) {
  const env = (typeof process !== "undefined" && process.env) || {};
  if (env.FORCE_COLOR !== undefined) {
    return typeof stream?.getColorDepth === "function"
      ? stream.getColorDepth() > 2
      : true;
  }
  return (
    !!stream?.isTTY &&
    (typeof stream.getColorDepth === "function"
      ? stream.getColorDepth() > 2
      : true)
  );
}

// ---------------------------------------------------------------------------
// Context builtins — port of Node lib/internal/modules/helpers.js
// addBuiltinLibsToObject() + lib/repl.js createContext() require/module.
// ---------------------------------------------------------------------------
// Lazy, non-enumerable getters for every builtin module, skipping
// underscored names, slashed names, and names already defined on the
// object. The getter loads via the shim's CJS loader so `util` etc.
// resolve to the SHIM modules, never native. ponytail: a builtin the
// shim cannot load throws honestly on first access (same as the module
// shim's own behaviour) — no silent undefined, no fake success.
function addBuiltinLibsToObject(object, replModule) {
  for (const name of nodeBuiltinModules) {
    if (
      name[0] === "_" ||
      name.includes("/") ||
      Object.prototype.hasOwnProperty.call(object, name)
    ) {
      continue;
    }
    const setReal = (val) => {
      delete object[name];
      object[name] = val;
    };
    Object.defineProperty(object, name, {
      __proto__: null,
      get: () => {
        // 'repl' itself must be THIS module's exports, not the loader's
        // (see makeReplRequire: the loader returns the native repl
        // under the harness, a second instance whose writer the server
        // never consults — the bare `repl` identifier in user code goes
        // through this getter, not through context.require).
        const lib = name === "repl" ? replExports : replModule.require(name);
        try {
          // Override the getter with the loaded lib (still
          // non-enumerable, still re-assignable), exactly as Node does.
          Object.defineProperty(object, name, {
            __proto__: null,
            get: () => lib,
            set: setReal,
            configurable: true,
            enumerable: false,
          });
        } catch {
          // If the property is no longer configurable, ignore the error.
        }
        return lib;
      },
      set: setReal,
      configurable: true,
      enumerable: false,
    });
  }
}

// Port of Node lib/internal/modules/cjs/loader.js makeRequireFunction(),
// bound to the REPL's `<repl>` module so `require('fs')` typed in the
// REPL resolves through the shim's CJS loader.
function makeReplRequire(mod) {
  function require(id) {
    // Node identity: require('repl') inside the repl returns the repl
    // module itself — the SAME instance that owns this server, so a
    // mutation the user makes (repl.writer.options.showProxy) is
    // observed by the server's writer (test-repl.js). The shim's CJS
    // loader cannot provide that identity: loadBuiltinModule prefers
    // process.getBuiltinModule under the harness, which returns the
    // NATIVE repl — a second instance whose writer the server never
    // consults (probe-proven: context repl.start !== server start).
    // Return this module's own exports instead. (The loader-wide
    // native-vs-shim identity gap for OTHER builtins is out of scope
    // here; only 'repl' itself is identity-asserted by a repl test.)
    if (id === "repl" || id === "node:repl") return replExports;
    return mod.require(id);
  }
  require.resolve = (request, options) => {
    if (typeof request !== "string") {
      const e = new TypeError(
        `The "request" argument must be of type string. Received ${typeof request}`,
      );
      e.code = "ERR_INVALID_ARG_TYPE";
      throw e;
    }
    if (isBuiltin(request)) return request;
    const resolveOptions =
      options !== undefined && options !== null && options.paths !== undefined
        ? { paths: options.paths }
        : undefined;
    return _resolveFilename(request, mod, false, resolveOptions);
  };
  require.resolve.paths = (request) => _resolveLookupPaths(request, mod);
  require.main = undefined;
  require.extensions = _extensions;
  require.cache = _cache;
  return require;
}

// ---------------------------------------------------------------------------
// Default writer
// ---------------------------------------------------------------------------

const writer = (obj) => inspect(obj, writer.options);
writer.options = { ...inspect.defaultOptions, showProxy: true, colors: false };

// Rebuild the source/caret "arrow" Node's repl prepends for a parse-time
// SyntaxError (lib/internal/util.js decorateErrorStack: V8 attaches the
// arrow to the error when compiling via vm.Script; the host eval used by
// the shim does not, so the shim rebuilds it from the input line + the
// token named in the message). Returns "source\ncaret\n\n".
// The caret position is best-effort: the token named in the message
// (single-quoted, or a colon-separated segment) if it occurs in the
// source, else column 0. The vendored tests only assert the shape
// (kSource exact, kArrow = /^ *\^+ *$/), so a misplaced caret is a
// fidelity wart, not a test failure.
function syntaxArrow(src, message) {
  // The arrow source is the source LINE containing the error position —
  // not the first line of the buffered input. Node's arrow comes from V8
  // (via vm.Script), which points at the error's line: the multiline
  // object case `x = {\nfield\n{` errors on the `{` at line 3, so its
  // source is `{`; the `{}),({}` case errors on line 1, so its source is
  // the first line. The shim has no V8 frame objects, so the position is
  // re-derived with acorn (already a direct dep, already imported):
  // its SyntaxError carries loc. If acorn cannot locate the error
  // (parses fine — the failure came from a wrapped form — or no loc),
  // fall back to the first line.
  const lines = src.split("\n");
  let line = lines[0];
  try {
    acorn.parse(src, {
      ecmaVersion: "latest",
      allowAwaitOutsideFunction: true,
    });
  } catch (e) {
    if (e && e.loc && typeof e.loc.line === "number") {
      line = lines[Math.min(Math.max(e.loc.line, 1), lines.length) - 1];
    }
  }
  let index = 0,
    length = 1;
  const candidates = [];
  for (const m of message.matchAll(/'([^']+)'/g)) candidates.push(m[1]);
  for (const seg of message.split(": ")) candidates.push(seg.trim());
  for (const tok of candidates) {
    if (tok && tok.length > 1 && line.includes(tok)) {
      index = line.indexOf(tok);
      length = tok.length;
      break;
    }
  }
  return `${line}\n${" ".repeat(index)}${"^".repeat(length)}\n\n`;
}

// ---------------------------------------------------------------------------
// REPLServer
// ---------------------------------------------------------------------------

export class REPLServerImpl extends Interface {
  constructor(prompt, stream, eval_, useGlobal, ignoreUndefined, replMode) {
    // ── Normalise options ────────────────────────────────────────────────
    let options;
    if (prompt !== null && typeof prompt === "object") {
      options = { ...prompt };
      stream = options.stream || options.socket;
      eval_ = options.eval;
      useGlobal = options.useGlobal;
      ignoreUndefined = options.ignoreUndefined;
      prompt = options.prompt;
      replMode = options.replMode;
    } else {
      options = {};
    }

    if (options.domain !== undefined)
      throw new TypeError(
        "options.domain is no longer supported (removed in Node 24)",
      );

    // ── Resolve streams ──────────────────────────────────────────────────
    // Never pass null/undefined to Interface — fall back to NullStream.
    let input = options.input;
    let output = options.output;

    if (!input || !output) {
      const s =
        stream ||
        (typeof process !== "undefined" && process?.stdin ? process : null);
      // Node lib/repl.js:274-282 (legacy-stream rule): a Duplex stream IS
      // both input and output (stream.stdin || stream / stream.stdout ||
      // stream). The old chain fell through to NullStream for a plain
      // Duplex (net.Socket, ArrayStream), so emitted data never reached
      // the eval (recoverable/require/test-repl.js hung; the R4
      // listenerCount throw was the NullStream input, not a missing guard).
      // ponytail: the s?.input/s?.output steps are the shim's pre-existing
      // extension for {input, output} pair objects; they stay ahead of the
      // bare-stream fallback.
      input = input || s?.stdin || s?.input || s || new NullStream();
      output = output || s?.stdout || s?.output || s || new NullStream();
    }

    const promptStr = typeof prompt === "string" ? prompt : "> ";
    const terminal =
      options.terminal !== undefined ? !!options.terminal : !!output.isTTY;

    // ── Super: only pass what our readline Interface actually accepts ─────
    // historySize flows through: the Interface reads input.historySize
    // into its history manager (default 30 when absent).
    super({
      input,
      output,
      terminal,
      prompt: promptStr,
      historySize: options.historySize,
    });

    // ── Store refs directly — don't rely on super's private #output ──────
    this._input = input;
    this._output = output;
    this._terminal = terminal;

    // ── Public properties ────────────────────────────────────────────────
    this._initialPrompt = promptStr;
    // Node lib/repl.js:289-291 — when terminal && useColors === undefined,
    // default via shouldColorize(output); a non-TTY output gets no colors.
    let useColors = options.useColors;
    if (terminal && useColors === undefined)
      useColors = shouldColorizeRepl(output);
    this.useColors = !!useColors;
    this.useGlobal = !!useGlobal;
    this.ignoreUndefined = !!ignoreUndefined;
    this.replMode = replMode || REPL_MODE_SLOPPY;
    this.writer = options.writer || writer;
    this.editorMode = false;
    this.commands = Object.create(null);
    this.breakEvalOnSigint = !!options.breakEvalOnSigint; // accepted, inert
    this[kContextId] = undefined;

    this.underscoreAssigned = false;
    this.underscoreErrAssigned = false;
    this.last = undefined;
    this.lastError = undefined;
    this.lines = [];
    this.lines.level = [];

    // ── Domain for error handling (Node compatibility) ──────────────────
    // Node's REPLServer has a _domain property (from the deprecated domain
    // module). Tests access testMe._domain.on("error", ...). Provide a
    // minimal EventEmitter-compatible domain (plain object, no imports to
    // avoid side effects).
    this._domain = {
      _events: Object.create(null),
      on(event, listener) {
        (this._events[event] ??= []).push(listener);
        return this;
      },
      emit(event, ...args) {
        for (const l of this._events[event] ?? []) l(...args);
        return this;
      },
    };

    if (this.writer === writer) writer.options.colors = this.useColors;

    this[kBufferedCommand] = "";
    this[kLoading] = false;

    // Node lib/repl.js:348-352 — breakEvalOnSigint with a custom eval is
    // a configuration error (breakEvalOnSigint only affects the default
    // eval). The check is on the raw eval option (truthy), not on whether
    // it is a function.
    if (this.breakEvalOnSigint && eval_) {
      const e = new TypeError(
        'Cannot specify both "breakEvalOnSigint" and "eval" for REPL',
      );
      e.code = "ERR_INVALID_REPL_EVAL_CONFIG";
      throw e;
    }

    this.eval =
      typeof eval_ === "function" ? eval_ : this._defaultEval.bind(this);

    // ── Context ──────────────────────────────────────────────────────────
    this.resetContext();

    // ── Commands ─────────────────────────────────────────────────────────
    this._defineDefaultCommands();

    // ── Wire readline 'line' event ────────────────────────────────────────
    // Use Interface's public .on() so we go through its internal #ev table,
    // NOT through NullStream / input directly.
    this.on("line", (cmd) => this._onLine(cmd));
    this.on("close", () => this.emit("exit"));

    // ── Initial prompt, synchronously (Node lib/repl.js:1040) ───────────
    // The prompt precedes any input the caller writes right after start()
    // (the mode test asserts it synchronously). The old code deferred it
    // via Promise.resolve() for fear Interface.write() would re-emit 'line'
    // with the prompt string; the Interface's prompt path only writes to
    // output ([kWriteToOutput] → output.write, no echo back to input), so
    // no re-entrancy occurs — verified by the mode/recoverable/require
    // flips + the full repl differential.
    this.displayPrompt();
  }

  // ── Context ─────────────────────────────────────────────────────────────

  createContext() {
    let context;

    if (this.useGlobal) {
      context = globalThis;
    } else {
      // Use a plain object sandbox — NOT vm.createContext() / vm.runInContext().
      // vm.runInContext() spins up a new iframe per eval call which is too heavy
      // for a REPL and may fail in constrained environments.
      // Instead we use runInThisContext with a persistent sandbox object:
      // user variables live on `context`, and eval runs in the host realm.
      context = Object.create(null);
      const GLOBALS = [
        "Object",
        "Function",
        "Array",
        "Number",
        "Boolean",
        "String",
        "Symbol",
        "BigInt",
        "Math",
        "Date",
        "RegExp",
        "Error",
        "EvalError",
        "RangeError",
        "ReferenceError",
        "SyntaxError",
        "TypeError",
        "URIError",
        "JSON",
        "Promise",
        "Proxy",
        "Reflect",
        "Map",
        "Set",
        "WeakMap",
        "WeakRef",
        "WeakSet",
        "ArrayBuffer",
        "DataView",
        "Int8Array",
        "Uint8Array",
        "Uint8ClampedArray",
        "Int16Array",
        "Uint16Array",
        "Int32Array",
        "Uint32Array",
        "Float32Array",
        "Float64Array",
        "BigInt64Array",
        "BigUint64Array",
        "Atomics",
        "SharedArrayBuffer",
        "Intl",
        "WebAssembly",
        "console",
        "crypto",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "queueMicrotask",
        "fetch",
        "URL",
        "URLSearchParams",
        "Headers",
        "Request",
        "Response",
        "Blob",
        "TextEncoder",
        "TextDecoder",
        "ReadableStream",
        "WritableStream",
        "TransformStream",
        "AbortController",
        "AbortSignal",
        "isFinite",
        "isNaN",
        "parseFloat",
        "parseInt",
        "decodeURI",
        "decodeURIComponent",
        "encodeURI",
        "encodeURIComponent",
        "undefined",
        "Infinity",
        "NaN",
      ];
      for (const name of GLOBALS) {
        if (name in globalThis) {
          try {
            context[name] = globalThis[name];
          } catch (_) {}
        }
      }
      context.global = context;
    }

    // Node lib/repl.js:1114-1137 — the REPL context gets a `<repl>` CJS
    // module, a require function bound to it, and lazy getters for every
    // builtin module (addBuiltinLibsToObject). Runs for both branches:
    // with useGlobal the context IS globalThis (Node does the same).
    const replModule = new CJSModule("<repl>");
    // Node lib/repl.js:1119 — replModule.paths =
    // CJSModule._resolveLookupPaths('<repl>', parentModule), where
    // parentModule is the repl builtin module itself, so the paths walk
    // up from `<cwd>/repl` (probe-proven: `<cwd>/repl/node_modules`,
    // `<cwd>/node_modules`, … + the global paths, which
    // _resolveLookupPaths appends at lookup time). The shim equivalent
    // is _nodeModulePaths("repl") — "repl" resolves against CWD.
    // ponytail: in the browser sandbox CWD is "/", so this degrades to
    // ["/repl/node_modules", "/node_modules"] — relative requires still
    // fail honestly (the REPL ["."] rule in _resolveLookupPaths).
    replModule.paths = CJSModule._nodeModulePaths("repl");
    Object.defineProperty(context, "module", {
      __proto__: null,
      configurable: true,
      writable: true,
      value: replModule,
    });
    Object.defineProperty(context, "require", {
      __proto__: null,
      configurable: true,
      writable: true,
      value: makeReplRequire(replModule),
    });
    addBuiltinLibsToObject(context, replModule);

    Object.defineProperty(context, "_", {
      configurable: true,
      get: () => this.last,
      set: (v) => {
        this.last = v;
        if (!this.underscoreAssigned) {
          this.underscoreAssigned = true;
          this._write("Expression assignment to _ now disabled.\n");
        }
      },
    });
    Object.defineProperty(context, "_error", {
      configurable: true,
      get: () => this.lastError,
      set: (v) => {
        this.lastError = v;
        if (!this.underscoreErrAssigned) {
          this.underscoreErrAssigned = true;
          this._write("Expression assignment to _error now disabled.\n");
        }
      },
    });

    this.emit("reset", context);
    return context;
  }

  resetContext() {
    this.context = this.createContext();
    this.underscoreAssigned = false;
    this.underscoreErrAssigned = false;
    this.lines = [];
    this.lines.level = [];
  }

  // The `with` scope for sandboxed eval: `has` claims every name in
  // sloppy mode so undeclared assignments land on the context
  // (vm-global semantics); in strict mode it answers honestly, or
  // `x = 3` would set a proxy property instead of throwing
  // ReferenceError (R1). Shared by the sync expression wrapper and
  // the top-level-await evaluator below.
  _scopeProxy() {
    const strict = this.replMode === REPL_MODE_STRICT;
    return new Proxy(this.context, {
      has: strict ? (t, k) => k in t || k in globalThis : () => true,
      get: (t, k) => (k in t ? t[k] : globalThis[k]),
      set: (t, k, v) => {
        t[k] = v;
        return true;
      },
    });
  }

  // Evaluate ported top-level-await code (a statement list: hoisted
  // declarations + the async IIFE as an expression statement). The
  // sandboxed expression wrapper cannot take statements, so this is a
  // separate evaluator, used only by the await branch of _defaultEval.
  // useGlobal: indirect eval handles statement lists natively (Node
  // parity: a hoisted `let` persists in the global lexical environment
  // and a redeclaration throws by itself).
  // Sandboxed: split the hoisted declarations from the IIFE, DROP the
  // hoists, and return the IIFE's promise. Dropping is what makes the
  // assignments land on the context: a hoisted `let k;` kept in the
  // Function body would be function-local, so the IIFE's `k = ...`
  // would update the local and be discarded. With the hoist dropped,
  // the assignment resolves through the `with` proxy's set trap onto
  // the context. The one thing dropping loses is redeclaration: a
  // hoisted `let` name already on the context throws
  // `Identifier 'x' has already been declared` first (Node's error for
  // the `const k` redeclare case). Hoisted `var` names are freely
  // redeclared, as in Node — no check. The Function is invoked with
  // `.call(proxy, proxy)` so the transform's `this.foo = foo`
  // (FunctionDeclaration visitor) lands on the context, not globalThis.
  // ponytail: the check answers `n in this.context`, which also matches
  // builtin libs and getters installed on the context (a `let Buffer`
  // would falsely throw — Node allows a lexical to shadow a global
  // property). No test covers it; a precise check needs a lexical
  // store the shim does not have.
  _evalAwait(code) {
    if (this.useGlobal) return (0, eval)(code); // eslint-disable-line no-eval
    const iifeStart = code.indexOf("(async () => { ");
    const hoisted = iifeStart === -1 ? "" : code.slice(0, iifeStart);
    const iife = iifeStart === -1 ? code : code.slice(iifeStart);
    for (const m of hoisted.matchAll(/\blet ([^;]+);/g)) {
      for (const name of m[1].split(",")) {
        const n = name.trim();
        if (n && n in this.context) {
          throw new SyntaxError(`Identifier '${n}' has already been declared`);
        }
      }
    }
    const proxy = this._scopeProxy();
    // eslint-disable-next-line no-new-func
    return new Function(
      "__ctx__",
      `with(__ctx__){return (${iife.trim()});}`,
    ).call(proxy, proxy);
  }

  // ── Default eval ─────────────────────────────────────────────────────────

  async _defaultEval(code, context, file, cb) {
    const input = code;
    let err = null,
      result;

    // Node lib/repl.js defaultEval — wrap a bare object literal in parens
    // so `{ a:1 }` parses as an expression, not a block. The wrap applies
    // ONLY when the input is an object literal with valid syntax (as a
    // script, or as an expression via `_=code`): the old shim condition
    // (starts with `{`, ends with `}`, wrapped form parses) also wrapped
    // `"{}),({}"` — whose wrapped form `({}),({})` is a valid comma
    // expression — so it evaluated to `{}` instead of buffering as the
    // incomplete multiline object the test expects.
    let wrappedCmd = false;
    if (isObjectLiteral(code) && isValidSyntax(code)) {
      code = `(${code.trim()})\n`;
      wrappedCmd = true;
    }

    // The 'use strict' prefix is valid only for the useGlobal path, where
    // the code is eval'd as a script (indirect eval). For the sandboxed
    // path the code runs inside return(...) as an expression, where the
    // prefix is a SyntaxError that masquerades as Recoverable and buffers
    // forever — strictness there is applied by the wrapper in runFn below.
    if (
      this.useGlobal &&
      this.replMode === REPL_MODE_STRICT &&
      code.trim() !== ""
    )
      code = `'use strict'; void 0;\n${code}`;

    // Top-level `let`/`const` persistence, useGlobal only (see
    // persistTopLevelLexical): indirect eval discards lexical bindings.
    let lexicalNames = [];
    if (this.useGlobal) {
      const persisted = persistTopLevelLexical(code);
      code = persisted.code;
      lexicalNames = persisted.names;
    }

    // Node lib/repl.js defaultEval: a BARE newline (code === "\n") calls
    // back with one argument, so finish prints nothing; a WHITESPACE-ONLY
    // line (" \t  \n") goes through normal eval and prints `undefined`
    // (test-repl.js "Whitespace is not evaluated" case — probe-proven
    // natively: bare "\n" -> prompt only, " \t  \n" -> "undefined\n").
    // The old `code.trim() === ""` check suppressed both.
    if (code === "\n") return cb(null);

    // Node lib/repl.js defaultEval — processTopLevelAwait (port of
    // lib/internal/repl/await.js) rewrites top-level await into an
    // async IIFE whose last expression statement becomes
    // `return { value: (...) }`; the await branch below unwraps `.value`
    // (Node lib/repl.js:612). A throw from the transform is the error:
    // strip the awaits and re-parse — if the stripped code is itself
    // unparseable AND recoverable, the repl buffers (Recoverable);
    // otherwise the caret-formatted SyntaxError is returned as-is.
    let awaitPromise = false;
    if (code.includes("await")) {
      try {
        const potentialWrappedCode = processTopLevelAwait(code);
        if (potentialWrappedCode !== null) {
          code = potentialWrappedCode;
          wrappedCmd = true;
          awaitPromise = true;
        } else if (hasTopLevelReturn(code)) {
          // Node parses the untransformed code as a script next, where
          // a top-level `return` is "Illegal return statement" — but
          // the shim's expression wrapper would report "Unexpected
          // token 'return'" instead. Surface the authentic V8 error:
          // indirect-eval the code — the parse fails before anything
          // executes, and the error's `at eval` first frame is what
          // _handleError needs for the source/caret arrow.
          try {
            (0, eval)(code); // eslint-disable-line no-eval
          } catch (e) {
            return cb(e);
          }
        }
      } catch (e) {
        let recoverableError = false;
        if (e.name === "SyntaxError") {
          const fallbackCode = code.replace(/\bawait\b/g, "");
          try {
            acorn.parse(fallbackCode, { ecmaVersion: "latest" });
          } catch (fallbackError) {
            if (isRecoverableError(fallbackError, fallbackCode)) {
              recoverableError = true;
              return cb(new Recoverable(e));
            }
          }
        }
        if (!recoverableError) return cb(e);
      }
    }

    // Execute code with context variables in scope via a with-block.
    // For useGlobal we use indirect eval directly on globalThis.
    // For sandboxed context we wrap in `with(context){...}` so that
    // r.context.hello = 'world' is visible as `hello` inside the REPL,
    // and new declarations written by the user land on `context`.
    const runFn = this.useGlobal
      ? (c) => (0, eval)(c) // eslint-disable-line no-eval
      : (c) => {
          // Wrap in with-block; new vars declared with var land on context
          // via the Proxy below which traps set.
          // ponytail: the expression wrapper only accepts a single
          // expression — declarations (const/let) are statements and
          // buffer as Recoverable instead of evaluating. Pre-existing
          // architecture ceiling (a real script eval would be needed to
          // fix it); not this lane.
          const strict = this.replMode === REPL_MODE_STRICT;
          const proxy = this._scopeProxy();
          if (strict) {
            // The 'use strict' directive cannot be prefixed onto the
            // code string here: inside return(...) it is a SyntaxError.
            // Instead the code runs inside a strict inner function
            // (the outer with is sloppy, which is legal); with the
            // honest `has` above, undeclared assignment throws
            // ReferenceError. Known gap: strict + top-level-await runs
            // the await body sloppy (the async IIFE has no directive).
            // eslint-disable-next-line no-new-func
            return new Function(
              "__ctx__",
              `with(__ctx__){return (function(){'use strict'; return (${c.trim()});})()}`,
            )(proxy);
          }
          // eslint-disable-next-line no-new-func
          return new Function("__ctx__", `with(__ctx__){return(${c.trim()})}`)(
            proxy,
          );
        };

    // Restore the RegExp statics snapshot from the previous user eval
    // (see restoreRegExpStatics) — this is the last thing before the
    // user's code runs, so no shim regex can clobber them in between.
    restoreRegExpStatics(this[kRegExpStatics]);

    try {
      const raw = awaitPromise ? this._evalAwait(code) : runFn(code);

      if (awaitPromise) {
        // Node lib/repl.js:612 — unwrap `.value` exactly once. No
        // second await: a value that IS a Promise (the last expression
        // of `await p1, p2`) must print as a Promise, not as its
        // resolution. The old code awaited twice, so every await
        // expression printed its resolution (or undefined).
        try {
          result = (await raw)?.value;
        } catch (e) {
          err = e;
        }
      } else {
        // No .value unwrap here: runFn returns the user's value
        // directly, and no {value, syncError} wrapper producer exists
        // anywhere in the codebase — the old unwrap misfired on genuine
        // user results (a generator's {value: undefined, done: true}
        // printed as "undefined", test-repl.js). The .value unwrap
        // belongs ONLY to the await branch (R4b: Node's await.js rewrites
        // the last expression to `return {value: (...)}`).
        result = raw;
      }
    } catch (e) {
      err = e;
      // Retry without wrapper on SyntaxError — but not for the
      // top-level-await redeclaration error: that error is already the
      // real error (the retry would re-run the original input through
      // the expression wrapper and clobber it with a wrapper
      // SyntaxError about `const`/`let`).
      if (
        wrappedCmd &&
        e instanceof SyntaxError &&
        !(
          awaitPromise &&
          /^Identifier '.*' has already been declared$/.test(e.message)
        )
      ) {
        try {
          const r2 = runFn(input);
          err = null;
          result = r2;
        } catch (e2) {
          err = e2;
        }
      }
    }

    if (err) {
      if (
        err instanceof SyntaxError &&
        err.message.includes("Cannot use import statement")
      ) {
        const lastLine = this.lines[this.lines.length - 1] || "";
        err.message =
          "Cannot use import statement inside the Node.js REPL, " +
          "alternatively use dynamic import: " +
          toDynamicImport(lastLine);
      }
      return cb(isRecoverableError(err, input) ? new Recoverable(err) : err);
    }

    // Top-level let/const are LEXICAL in Node's repl: they never appear
    // on globalThis, and the vendored tests' exit-time leakedGlobals
    // check (for...in over globalThis) fails if they do (test-repl.js
    // `let npm = () => {};` leaked `npm`). The var rewrite above that
    // persists them creates enumerable globals, so hide them again after
    // a successful eval. Bare-identifier resolution is unaffected
    // (enumerability does not gate property lookup); only for...in /
    // Object.keys visibility changes, which is exactly Node's shape.
    // (Fidelity wart: globalThis.<name> still resolves, where Node's is
    // undefined — no test asserts that; the alternative is a persistent
    // lexical scope, a redesign of the eval path.)
    for (const name of lexicalNames) {
      try {
        const desc = Object.getOwnPropertyDescriptor(globalThis, name);
        if (desc && desc.enumerable) {
          Object.defineProperty(globalThis, name, {
            ...desc,
            enumerable: false,
          });
        }
      } catch {
        // Non-configurable (a real global of the same name) — leave it.
      }
    }

    cb(null, result);
  }

  // ── Line handler ─────────────────────────────────────────────────────────

  _onLine(cmd) {
    cmd = cmd || "";

    if (this.editorMode) {
      this[kBufferedCommand] += cmd + "\n";
      this._memoryUpdate(cmd);
      return;
    }

    const trimmed = cmd.trim();

    // Dot-commands
    if (
      trimmed &&
      trimmed[0] === "." &&
      trimmed[1] !== "." &&
      isNaN(parseFloat(trimmed))
    ) {
      const m = trimmed.match(/^\.([^\s]+)\s*(.*)?$/);
      if (m) {
        const [, keyword, rest = ""] = m;
        if (this._parseREPLKeyword(keyword, rest)) return;
        if (!this[kBufferedCommand]) {
          this._write("Invalid REPL keyword\n");
          // Node lib/repl.js:891 — finish(null): one argument, so no
          // result is printed (only the keyword message above).
          this._finish(null, undefined, cmd, 1);
          return;
        }
      }
    }

    const evalCmd = this[kBufferedCommand] + cmd + "\n";
    this._memoryUpdate(cmd);

    // Node lib/repl.js:853 — finish IS the eval callback, so its
    // arguments.length is the callback arity: 1 for cb(null) on a bare
    // newline (nothing printed), 2 for a real result. The old arrow
    // wrapper always passed 3 args to _finish, so _finish's
    // arguments.length check was dead and a bare newline printed
    // "undefined" — which then polluted the next line a socket test read
    // (test-repl.js "message" case got the previous case's "undefined").
    // A bound function expression (not an arrow) so arguments.length is
    // the callback's own arity.
    this.eval(
      evalCmd,
      this.context,
      "repl",
      function (e, ret) {
        this._finish(e, ret, cmd, arguments.length);
      }.bind(this),
    );
  }

  _finish(e, ret, cmd = "", argc = 2) {
    // Snapshot the RegExp statics now — the user's eval just ran, so they
    // reflect the user's last regex match. Restored in _defaultEval
    // before the next user eval (see restoreRegExpStatics).
    this[kRegExpStatics] = [
      RegExp.$1,
      RegExp.$2,
      RegExp.$3,
      RegExp.$4,
      RegExp.$5,
      RegExp.$6,
      RegExp.$7,
      RegExp.$8,
      RegExp.$9,
    ];
    if (
      e &&
      !this[kBufferedCommand] &&
      typeof cmd === "string" &&
      cmd.trimStart().startsWith("npm ") &&
      !(e instanceof Recoverable)
    ) {
      this._write(
        "npm should be run outside of the Node.js REPL, in your normal shell.\n(Press Ctrl+D to exit.)\n",
      );
      this.displayPrompt();
      return;
    }

    if (e instanceof Recoverable) {
      this[kBufferedCommand] += (cmd || "") + "\n";
      this.displayPrompt();
      return;
    }

    if (e) {
      // The arrow source for a parse error is the FIRST line of the
      // buffered input (test-repl.js multiline-object case expects
      // `"{}),({}"`, not the last line `"}"`). The buffer is still
      // intact here — clearBufferedCommand runs after _handleError
      // returns (inside _handleError itself).
      this._handleError(e.err || e, this[kBufferedCommand] + cmd);
      return;
    }

    this.clearBufferedCommand();

    if (argc >= 2 && (!this.ignoreUndefined || ret !== undefined)) {
      if (!this.underscoreAssigned) this.last = ret;
      this._write(this.writer(ret) + "\n");
    }

    if (!this.closed) this.displayPrompt();
  }

  // ── Error display ────────────────────────────────────────────────────────

  _handleError(e, cmd = "") {
    if (!this.underscoreErrAssigned) this.lastError = e;

    // Node lib/repl.js domain-error handler — the error's stack is
    // rewritten BEFORE the writer runs:
    // - SyntaxError: every `at ...` frame line is stripped (the arrow
    //   source/caret is prepended instead, below), so the writer output
    //   is just the message line(s).
    // - Other Errors: Node's overrideStackTrace slices away the
    //   eval-dispatch frame and everything below it (repl machinery,
    //   process ticks), keeping only frames from user code evaluated in
    //   the repl. The shim has no V8 frame objects, so the same cut is
    //   done on the writer text after (the frame cut below).
    const isSyntax = e && typeof e === "object" && e.name === "SyntaxError";
    // Parse-time vs runtime SyntaxError: a parse-time error's first
    // stack frame is the eval dispatch itself (`at eval (<anonymous>)` /
    // `at new Function (<anonymous>)`); a runtime SyntaxError (e.g.
    // JSON.parse) is thrown from user code and gets no arrow.
    let arrow = "";
    if (isSyntax && typeof e.stack === "string") {
      const firstFrame = e.stack
        .split("\n")
        .find((l) => l.startsWith("    at "));
      if (
        firstFrame &&
        /^\s+at (eval|new Function) \(<anonymous>\)/.test(firstFrame) &&
        cmd.trim() !== ""
      ) {
        arrow = syntaxArrow(cmd, e.message);
      }
      e.stack = e.stack
        .replace(/^\s+at\s.*\n?/gm, "")
        .replace(/^REPL\d+:\d+\r?\n/gm, "");
    }

    let errStack = this.writer(e);
    if (errStack[0] === "[" && errStack[errStack.length - 1] === "]")
      errStack = errStack.slice(1, -1);

    // Frame cut (non-SyntaxError only — SyntaxError stacks were already
    // stripped above): drop the eval-dispatch frame and everything below
    // it. The dispatch wrapper is the `at eval (<anonymous>)` line
    // (indirect-eval path); the frame just before it is the dispatch
    // frame itself. Frames before it are user code and are kept (their
    // locations stay `<anonymous>:line:col` — Node rewrites them to
    // `REPLn:*:*`, which the shim does not track; no shim-exercising
    // test asserts the rewritten form).
    // (Sandboxed `new Function` frames keep their full stack — no
    //  shim-exercising test asserts them. A trailing props block
    //  (` {` ... `}`) that inspect appends for errors with extra
    //  enumerable properties is dropped with the machinery frames for
    //  the same reason — pretty-custom-stack runs against the native
    //  repl via common/repl.js, not the shim.)
    if (!isSyntax) {
      const wlines = errStack.split(/(?<=\n)/);
      let cut = -1;
      for (let i = 0; i < wlines.length; i++) {
        if (/^    at eval \(<anonymous>\)/.test(wlines[i])) {
          cut = i;
          break;
        }
      }
      if (cut > 0) {
        errStack = wlines.slice(0, cut - 1).join("");
      } else if (cut === -1) {
        // Node lib/repl.js:643 overrideStackTrace — the repl slices the
        // captured frames to before the last null-named frame (the eval
        // dispatch); with NO null-named frame the slice index is -1, so
        // the LAST captured frame is dropped. That is exactly the
        // `Error.stackTraceLimit = 5; require("internal/repl")` case
        // (test-repl.js): the limit truncates the stack before the eval
        // dispatch frame, so no eval line exists and the deepest captured
        // frame (the repl's own require dispatch) must go — 5 frames
        // captured, 4 printed — while the trailing props block
        // (code/requireStack) is kept. The new last frame line takes over
        // the ` {` suffix inspect puts on the frame before the props.
        let lastFrame = -1;
        for (let i = 0; i < wlines.length; i++) {
          if (/^    at /.test(wlines[i])) lastFrame = i;
        }
        if (lastFrame > 0) {
          wlines.splice(lastFrame, 1);
          const next = wlines[lastFrame];
          if (
            next !== undefined &&
            (/^  [^ ]/.test(next) || next.replace(/\n$/, "") === "}")
          ) {
            wlines[lastFrame - 1] = wlines[lastFrame - 1].replace(
              /\n$/,
              " {\n",
            );
          }
          errStack = wlines.join("");
        }
      }
    }

    if (arrow) errStack = arrow + errStack;

    const lines = errStack.split(/(?<=\n)/);
    const breakLength = writer.options.breakLength ?? 80;
    let matched = false,
      prefixed = "";
    for (const line of lines) {
      if (!matched && /^\[?([A-Z][a-z0-9_]*)*Error/.test(line)) {
        prefixed +=
          breakLength >= line.length
            ? `Uncaught ${line}`
            : `Uncaught:\n${line}`;
        matched = true;
      } else {
        prefixed += line;
      }
    }
    if (!matched) {
      // Node lib/repl.js: a single-line output gets `Uncaught `, a
      // multi-line one gets `Uncaught:\n`. The old code always used
      // `:\n`, so a bare `throw { foo: 'bar' }` printed
      // `Uncaught:\n{ foo: 'bar' }` instead of `Uncaught { foo: 'bar' }`.
      prefixed = `Uncaught${lines.length === 1 ? " " : ":\n"}${errStack}`;
    }
    if (!prefixed.endsWith("\n")) prefixed += "\n";

    this._write(prefixed);
    this.clearBufferedCommand();
    this.lines.level = [];
    if (!this.closed) this.displayPrompt();
  }

  // ── Command dispatch ─────────────────────────────────────────────────────

  _parseREPLKeyword(keyword, rest) {
    const cmd = this.commands[keyword];
    if (cmd) {
      cmd.action.call(this, rest);
      return true;
    }
    return false;
  }

  _defineDefaultCommands() {
    this.defineCommand("break", {
      help: "Sometimes you get stuck, this gets you out",
      action() {
        this.clearBufferedCommand();
        this.displayPrompt();
      },
    });

    this.defineCommand("clear", {
      help: this.useGlobal
        ? "Alias for .break"
        : "Break, and also clear the local context",
      action() {
        this.clearBufferedCommand();
        if (!this.useGlobal) {
          this._write("Clearing context...\n");
          this.resetContext();
        }
        this.displayPrompt();
      },
    });

    this.defineCommand("exit", {
      help: "Exit the REPL",
      action() {
        this.close();
      },
    });

    this.defineCommand("help", {
      help: "Print this help message",
      action() {
        const names = Object.keys(this.commands).sort();
        const max = Math.max(...names.map((n) => n.length));
        for (const name of names) {
          const c = this.commands[name];
          const pad = " ".repeat(max - name.length + 3);
          this._write(`.${name}${c.help ? pad + c.help : ""}\n`);
        }
        this._write(
          "\nPress Ctrl+C to abort current expression, Ctrl+D to exit the REPL\n",
        );
        this.displayPrompt();
      },
    });

    this.defineCommand("save", {
      help: "Save all evaluated commands in this REPL session to a file",
      action(file) {
        if (!file) {
          this._write("Missing filename\n");
          this.displayPrompt();
          return;
        }
        try {
          _tryRequireFs().writeFileSync(file, this.lines.join("\n"));
          this._write(`Session saved to: ${file}\n`);
        } catch (_) {
          this._write(`Failed to save: ${file}\n`);
        }
        this.displayPrompt();
      },
    });

    this.defineCommand("load", {
      help: "Load JS from a file into the REPL session",
      action(file) {
        if (!file) {
          this._write("Missing filename\n");
          this.displayPrompt();
          return;
        }
        try {
          const data = _tryRequireFs().readFileSync(file, "utf8");
          this._turnOnEditorMode();
          this[kLoading] = true;
          for (const line of data.split("\n")) this.write(line + "\n");
          this[kLoading] = false;
          this._turnOffEditorMode();
          this.write("\n");
        } catch (_) {
          this._write(`Failed to load: ${file}\n`);
        }
        this.displayPrompt();
      },
    });

    // Node lib/repl.js:1408 — .editor is defined only for a terminal
    // repl. A socket repl (terminal: false) has no .editor, so .help
    // lists break, clear, exit, help, load, save — and the test's
    // `.help`-in-a-string case expects .exit as the third line.
    if (this.terminal) {
      this.defineCommand("editor", {
        help: "Enter editor mode",
        action() {
          this._turnOnEditorMode();
          this._write(
            "// Entering editor mode (Ctrl+D to finish, Ctrl+C to cancel)\n",
          );
        },
      });
    }
  }

  // ── Editor mode ──────────────────────────────────────────────────────────

  _turnOnEditorMode() {
    this.editorMode = true;
    // Call Interface's setPrompt directly — don't overwrite _initialPrompt
    Interface.prototype.setPrompt.call(this, "");
  }

  _turnOffEditorMode() {
    this.editorMode = false;
    this.setPrompt(this._initialPrompt);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  displayPrompt(preserveCursor) {
    // Node lib/internal/readline/interface.js:101 — kMultilinePrompt is
    // Symbol('| '): the continuation prompt is pipe + SPACE. The old "|"
    // (no space) never matched the recoverable test's `msg === "| "` check.
    const p = this[kBufferedCommand].length ? "| " : this._initialPrompt;
    // Use Interface.prototype.setPrompt directly so we don't stomp _initialPrompt
    Interface.prototype.setPrompt.call(this, p);
    this.prompt(preserveCursor);
  }

  setPrompt(prompt) {
    this._initialPrompt = prompt;
    Interface.prototype.setPrompt.call(this, prompt);
  }

  clearBufferedCommand() {
    this[kBufferedCommand] = "";
  }

  defineCommand(keyword, cmd) {
    if (typeof cmd === "function") cmd = { action: cmd };
    if (typeof cmd.action !== "function")
      throw new TypeError("cmd.action must be a function");
    this.commands[keyword] = cmd;
  }

  // Node: lib/repl.js:1052 — historyConfig may be a string (file path) for
  // backwards compatibility; an explicit callback overrides
  // options.onHistoryFileLoaded. The history manager (src/readline.js
  // ReplHistory, via setupHistoryManager) owns the file load, the
  // disabled-history message and the flush-on-line behavior.
  setupHistory(historyConfig = {}, cb) {
    const options =
      typeof historyConfig === "string"
        ? { filePath: historyConfig }
        : historyConfig;
    if (typeof cb === "function") {
      options.onHistoryFileLoaded = cb;
    }
    this.setupHistoryManager(options);
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Write directly to the output stream, bypassing Interface.write()
   * which would re-emit a 'line' event and cause re-entrant eval loops.
   */
  _write(str) {
    this._output?.write?.(str);
  }

  _memoryUpdate(cmd) {
    if (cmd) {
      const indent = "  ".repeat(Math.max(0, this.lines.level.length - 1));
      this.lines.push(indent + cmd);
    } else {
      this.lines.push("");
    }
    if (!cmd) {
      this.lines.level = [];
      return;
    }
    let depth = 0;
    for (const ch of cmd) {
      if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") depth--;
    }
    if (depth > 0)
      this.lines.level.push({ line: this.lines.length - 1, depth });
    else if (depth < 0 && this.lines.level.length) this.lines.level.pop();
  }

  // ── Deprecated stream aliases (Node compatibility) ───────────────────
  // Node: repl.inputStream and repl.outputStream are deprecated (DEP0141).
  // Use repl.input and repl.output instead. The warning fires once per
  // process, like Node's deprecate().
  get inputStream() {
    emitDeprecationOnce(
      "DEP0141",
      "repl.inputStream and repl.outputStream are deprecated. " +
        "Use repl.input and repl.output instead",
    );
    return this.input;
  }
  set inputStream(v) {
    emitDeprecationOnce(
      "DEP0141",
      "repl.inputStream and repl.outputStream are deprecated. " +
        "Use repl.input and repl.output instead",
    );
    this.input = v;
  }
  get outputStream() {
    emitDeprecationOnce(
      "DEP0141",
      "repl.inputStream and repl.outputStream are deprecated. " +
        "Use repl.input and repl.output instead",
    );
    return this.output;
  }
  set outputStream(v) {
    emitDeprecationOnce(
      "DEP0141",
      "repl.inputStream and repl.outputStream are deprecated. " +
        "Use repl.input and repl.output instead",
    );
    this.output = v;
  }

  // ── Tab completion (Node compatibility) ──────────────────────────────
  // Node: replServer.complete(line, callback) provides tab-completion.
  // Basic implementation: completes identifiers from the context object.
  complete(line, callback) {
    try {
      // Extract the last identifier fragment to complete
      const match = line.match(/[a-zA-Z_$][a-zA-Z0-9_$]*$/);
      const filter = match ? match[0] : "";
      const prefix = line.slice(0, line.length - filter.length);

      // Gather completion candidates from the context
      const candidates = new Set();
      if (this.context && typeof this.context === "object") {
        for (const key of Object.getOwnPropertyNames(this.context)) {
          if (key.startsWith(filter)) candidates.add(prefix + key);
        }
        // Also check prototype chain
        let proto = Object.getPrototypeOf(this.context);
        while (proto && proto !== Object.prototype) {
          for (const key of Object.getOwnPropertyNames(proto)) {
            if (key.startsWith(filter)) candidates.add(prefix + key);
          }
          proto = Object.getPrototypeOf(proto);
        }
      }
      // Add global names
      for (const key of Object.getOwnPropertyNames(globalThis)) {
        if (key.startsWith(filter)) candidates.add(prefix + key);
      }

      const completions = [...candidates].sort();
      callback(null, [completions, filter]);
    } catch (err) {
      callback(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Lazy fs helper — maps to VFS fs shim if available
// ---------------------------------------------------------------------------

function _tryRequireFs() {
  if (typeof require === "function") return require("fs");
  throw new Error("fs not available");
}

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

/**
 * Creates and starts a REPLServer.
 * @param {string|object} [prompt='> '] prompt string or options object
 * @param {object} [source] stream to use for I/O (positional form)
 * @param {Function} [eval_] custom eval function (positional form)
 * @param {boolean} [useGlobal]
 * @param {boolean} [ignoreUndefined]
 * @param {symbol} [replMode]
 * @returns {REPLServer}
 *
 * Node lib/repl.js:1047 — start() forwards positionally:
 * start(prompt, source, eval_, useGlobal, ignoreUndefined, replMode).
 * The old one-argument form dropped the stream + eval, so
 * repl.start("", putIn, customEval) and repl.start(prompt, socket) never
 * wired any input (recoverable/require/test-repl.js).
 *
 * @example
 * import { start } from 'repl';
 * const r = start({ prompt: '> ', useColors: true });
 * r.context.hello = 'world';
 */
export function start(
  prompt = "> ",
  source,
  eval_,
  useGlobal,
  ignoreUndefined,
  replMode,
) {
  return new REPLServer(
    prompt,
    source,
    eval_,
    useGlobal,
    ignoreUndefined,
    replMode,
  );
}

// ---------------------------------------------------------------------------
// Misc exports
// ---------------------------------------------------------------------------

/** @deprecated Use module.builtinModules */
export let builtinModules = [
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
];

export function isValidSyntax(src) {
  // Node lib/internal/repl/utils.js isValidSyntax, ported to the acorn
  // npm package (a direct dep): valid as a script, or as an expression
  // via `_=code`. Acorn parses as a script — the previous `new Function`
  // check parsed as a function body, which accepts top-level `return`
  // and reports different errors for the same input.
  try {
    acorn.parse(src, {
      ecmaVersion: "latest",
      allowAwaitOutsideFunction: true,
    });
    return true;
  } catch {
    try {
      acorn.parse(`_=${src}`, {
        ecmaVersion: "latest",
        allowAwaitOutsideFunction: true,
      });
      return true;
    } catch {
      return false;
    }
  }
}

// ── REPLServer callable without new (Node compatibility) ───────────────
// Node: repl.REPLServer() works with or without 'new'. Wrap the class.
// Node lib/repl.js:256 — deprecateInstantiation(REPLServer, 'DEP0185'):
// calling it without `new` emits a once-per-process DeprecationWarning
// (DEP0185). `new.target` distinguishes the two call shapes; the wrapper
// itself is the no-`new` path, and `start()` calls it with `new`.
export function REPLServer(...args) {
  if (!new.target) {
    emitDeprecationOnce(
      "DEP0185",
      "Instantiating REPLServer without the 'new' keyword has been deprecated.",
    );
  }
  return new REPLServerImpl(...args);
}
Object.setPrototypeOf(REPLServer, REPLServerImpl);
REPLServer.prototype = REPLServerImpl.prototype;

const replExports = {
  start,
  writer,
  REPLServer,
  Recoverable,
  REPL_MODE_SLOPPY,
  REPL_MODE_STRICT,
  isValidSyntax,
};

// Node lib/repl.js:1437-1465 — builtinModules and _builtinLibs are
// deprecated getters on module.exports (DEP0191 / DEP0142, emitted once).
// The CJS require() of this ESM shim returns this default-export object,
// so the getters live here; the ESM named export above stays the plain
// array for ESM importers.
Object.defineProperty(replExports, "builtinModules", {
  __proto__: null,
  get() {
    emitDeprecationOnce(
      "DEP0191",
      "repl.builtinModules is deprecated. Check module.builtinModules instead",
    );
    return builtinModules;
  },
  set(v) {
    emitDeprecationOnce(
      "DEP0191",
      "repl.builtinModules is deprecated. Check module.builtinModules instead",
    );
    builtinModules = v;
  },
  enumerable: false,
  configurable: true,
});
Object.defineProperty(replExports, "_builtinLibs", {
  __proto__: null,
  get() {
    emitDeprecationOnce(
      "DEP0142",
      "repl._builtinLibs is deprecated. Check module.builtinModules instead",
    );
    return builtinModules;
  },
  set(v) {
    emitDeprecationOnce(
      "DEP0142",
      "repl._builtinLibs is deprecated. Check module.builtinModules instead",
    );
    builtinModules = v;
  },
  enumerable: false,
  configurable: true,
});

export default replExports;

// ---------------------------------------------------------------------------
// --- Usage ---
// ---------------------------------------------------------------------------
//
// // 1. Basic — no streams needed, NullStream used automatically
// import { start } from 'repl';
// const r = start({ prompt: '> ' });
// r.context.hello = 'world';
//
// // 2. With xterm.js or any duplex stream
// const r = start({ prompt: '> ', input: xtermInput, output: xtermOutput });
//
// // 3. Custom dot-command
// r.defineCommand('sayhi', {
//   help: 'Say hello',
//   action() {
//     this._write('Hi there 👋\n');  // use _write, not console.log, for REPL output
//     this.displayPrompt();
//   },
// });
//
// // 4. Top-level await — works transparently
// // User types: const data = await fetch('/api').then(r => r.json())
//
// // 5. Multi-line accumulation — automatic via Recoverable
// // User types:
// //   > function add(a, b) {
// //   |   return a + b
// //   | }
// //
// // 6. reset event — re-seed context after .clear
// r.on('reset', ctx => { ctx.myLib = myLib; });
