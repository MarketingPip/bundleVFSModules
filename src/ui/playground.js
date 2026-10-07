// src/ui/playground.js — demo playground UI framework for bundleVFSModules.
//
// Extracted from runtime.js (which is now a pure library). This module owns
// ALL demo-page DOM wiring: the example snippets, the run/clear/stdin/argv
// controls, the files panel, the xterm.js terminal option, and the
// CodeSandbox instance lifecycle.
//
// This is the ONE framework. ui.html's inline wiring (streaming stdout via
// `execution:stdout`, argv parsing, stdin handling) was the newer, working
// reference — initPlayground() below is built from it, absorbing the older
// xterm-based wiring as an opt-in `useXterm` mode.
//
// Usage (ui.html):
//   import { CodeSandbox } from './runtime.js';
//   import { initPlayground, EXAMPLES } from './src/ui/playground.js';
//   initPlayground({ CodeSandbox }); // wires the page's demo DOM
//
// The demo-only CDN import (shellwords) lives here, not in the library;
// xterm.js is dynamically imported inside initPlayground() so a CDN outage
// falls back to DOM mode instead of breaking the playground module.
// Public library helpers used here (transpileTypeScript,
// flattenFileTree, builtinModules) are imported from runtime.js.

import { split } from "https://esm.sh/shellwords?target=node";
import {
  transpileTypeScript,
  flattenFileTree,
  builtinModules,
  formatErrors,
  customAcorn,
} from "../../runtime.js";

// ---------------------------------------------------------------------------
// Reference-error checking (moved from runtime.js — playground-only).
// ---------------------------------------------------------------------------

function generateGlobalBuiltInsSet(denyList = []) {
  const globalObject = globalThis;
  const globalSet = new Set();
  const denySet = new Set(denyList);

  const browserOnlyAPIs = [
    //"window",
    // "document",
    "navigator",
    "location",
    "history",
    "screen",
    "localStorage",
    "sessionStorage",
    "alert",
    "prompt",
    "confirm",
    "addEventListener",
    "removeEventListener",
    //"XMLHttpRequest",
    //"fetch",
    "WebSocket",
    "Navigator.geolocation",
    "navigator",
    //"ServiceWorker",
    "IntersectionObserver",
    "Notification",
    "Cache",
    "SpeechRecognition",
    "SpeechSynthesis",
    "CanvasRenderingContext2D",
    "File",
    "FileList",
    "FileReader",
    "HTMLCanvasElement",
    "WebGLRenderingContext",
    "AudioContext",
    "MediaDevices",
    "MediaRecorder",
    "FormData",
    "IndexedDB",
    "Navigator",
    "getComputedStyle",
    "CSSStyleSheet",
    //"window",
    "this",
    // "__dirname"

    //"document"
  ];

  let current = globalObject;
  while (current && current !== Object.prototype) {
    Object.getOwnPropertyNames(current).forEach((name) => {
      if (
        !denySet.has(name) &&
        !name.startsWith("_") &&
        name !== "globalThis" &&
        !browserOnlyAPIs.includes(name)
      ) {
        globalSet.add(name);
      }
    });
    current = Object.getPrototypeOf(current);
  }

  [
    "await",
    "yield",
    "arguments",
    "undefined",
    "NaN",
    "Infinity",
    "meta",
    "import",
    "target",
    "new",
  ].forEach((k) => globalSet.add(k));
  return globalSet;
}

const standardESGlobals = generateGlobalBuiltInsSet();

function checkForReferenceErrors(code, options = {}) {
  const {
    additionalGlobals = [],
    ignoreGlobals = false,
    ecmaVersion = "latest",
    strictMode = false, // force strict mode (also auto-detected from "use strict")
    removeThis = false, // treat bare `this` as an error everywhere
    tdz = true, // detect Temporal Dead Zone violations
  } = options;

  // ─── Parse ────────────────────────────────────────────────────────────────
  let ast;
  try {
    ast = customAcorn.parse(code, {
      ecmaVersion,
      sourceType: "module",
      locations: true,
    });
  } catch (error) {
    throw formatErrors(code, error);
  }

  // ─── Globals ──────────────────────────────────────────────────────────────
  const globals = ignoreGlobals
    ? new Set()
    : new Set([...standardESGlobals, ...additionalGlobals, "process"]);

  // ─── Scope Stack ──────────────────────────────────────────────────────────
  // Each scope: { type: "global"|"function"|"block", strict: bool, bindings: Map<name, {kind, declLine, declCol}> }
  const scopeStack = [];

  function currentScope() {
    return scopeStack[scopeStack.length - 1];
  }

  function pushScope(type = "block", inheritStrict = true) {
    const parentStrict = scopeStack.length ? currentScope().strict : false;
    scopeStack.push({
      type,
      strict: inheritStrict ? parentStrict : strictMode,
      bindings: new Map(),
    });
  }

  function popScope() {
    scopeStack.pop();
  }

  function isStrictMode() {
    return scopeStack.length ? currentScope().strict : strictMode;
  }

  function setStrictMode() {
    if (scopeStack.length) currentScope().strict = true;
  }

  /**
   * Add a binding to the appropriate scope.
   * kind: "var" | "let" | "const" | "function" | "param" | "import" | "catch"
   */
  function addBinding(name, kind, loc) {
    const declLine = loc?.start?.line ?? null;
    const declCol = loc?.start?.column ?? null;

    if (kind === "var" || kind === "function") {
      // Hoist to nearest function or global scope
      for (let i = scopeStack.length - 1; i >= 0; i--) {
        if (
          scopeStack[i].type === "function" ||
          scopeStack[i].type === "global"
        ) {
          if (!scopeStack[i].bindings.has(name)) {
            scopeStack[i].bindings.set(name, { kind, declLine, declCol });
          }
          return;
        }
      }
    } else {
      // let / const / param / import / catch → current block scope
      const scope = currentScope();
      scope.bindings.set(name, { kind, declLine, declCol });
    }
  }

  /**
   * Returns binding info or null.
   */
  function lookup(name) {
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      if (scopeStack[i].bindings.has(name)) {
        return {
          scope: scopeStack[i],
          binding: scopeStack[i].bindings.get(name),
        };
      }
    }
    return null;
  }

  function isDefined(name) {
    return lookup(name) !== null;
  }

  // ─── Pattern Helpers ──────────────────────────────────────────────────────
  function extractIdentifiers(pattern, names = []) {
    if (!pattern) return names;
    switch (pattern.type) {
      case "Identifier":
        names.push({ name: pattern.name, loc: pattern.loc });
        break;
      case "ObjectPattern":
        pattern.properties.forEach((p) =>
          extractIdentifiers(
            p.type === "RestElement" ? p.argument : p.value,
            names,
          ),
        );
        break;
      case "ArrayPattern":
        pattern.elements.forEach((el) => el && extractIdentifiers(el, names));
        break;
      case "RestElement":
        extractIdentifiers(pattern.argument, names);
        break;
      case "AssignmentPattern":
        extractIdentifiers(pattern.left, names);
        break;
    }
    return names;
  }

  // ─── Declaration-context guard ────────────────────────────────────────────
  function isDeclarationContext(node, parent) {
    if (!parent) return false;
    return (
      (parent.type === "VariableDeclarator" && parent.id === node) ||
      (parent.type === "FunctionDeclaration" && parent.id === node) ||
      (parent.type === "FunctionExpression" && parent.id === node) ||
      (parent.type === "ClassDeclaration" && parent.id === node) ||
      (parent.type === "ClassExpression" && parent.id === node) ||
      (parent.type === "Property" && parent.key === node && !parent.computed) ||
      (parent.type === "MethodDefinition" &&
        parent.key === node &&
        !parent.computed) ||
      (parent.type === "MemberExpression" &&
        parent.property === node &&
        !parent.computed) ||
      parent.type === "ImportSpecifier" ||
      parent.type === "ImportDefaultSpecifier" ||
      (parent.type === "LabeledStatement" && parent.label === node)
    );
  }

  // ─── Error collection ─────────────────────────────────────────────────────
  const referenceErrors = [];
  const seenErrors = new Set(); // deduplicate by name (mirrors original `seen` set)

  function addError(name, line, col, message) {
    // Allow duplicate lines for TDZ (different message), but deduplicate plain "not defined"
    const key = `${name}:${line}:${col}`;
    if (seenErrors.has(key)) return;
    seenErrors.add(key);
    referenceErrors.push({ name, line, col, message });
  }

  // ─── Strict-mode directive detector ──────────────────────────────────────
  function hasUseStrictDirective(body) {
    if (!Array.isArray(body)) return false;
    for (const stmt of body) {
      if (
        stmt.type === "ExpressionStatement" &&
        stmt.expression.type === "Literal" &&
        stmt.expression.value === "use strict"
      )
        return true;
      // Only leading directives count
      if (stmt.type !== "ExpressionStatement") break;
    }
    return false;
  }

  // ─── Pre-pass: hoist var + function declarations ──────────────────────────
  // We do this before the main walk so forward references work correctly.
  // This pre-pass must mirror the scope structure.

  function hoistScope(nodes, scopeType) {
    // hoist only within this function/global boundary
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      hoistNode(node, scopeType);
    }
  }

  function hoistNode(node, boundaryType) {
    if (!node || typeof node !== "object" || !node.type) return;

    switch (node.type) {
      case "FunctionDeclaration":
        // function name hoisted to current scope
        if (node.id) addBinding(node.id.name, "function", node.id.loc);
        // Do NOT descend into function body for var hoisting — new boundary
        return;

      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return; // new boundary — stop

      case "VariableDeclaration":
        if (node.kind === "var") {
          node.declarations.forEach((decl) => {
            extractIdentifiers(decl.id).forEach(({ name, loc }) =>
              addBinding(name, "var", loc),
            );
          });
        }
        // Still descend into initialisers for nested var (handled by child walk)
        node.declarations.forEach((decl) => {
          if (decl.init) hoistNode(decl.init, boundaryType);
        });
        break;

      default:
        // Recurse into child nodes
        for (const key of Object.keys(node)) {
          if (
            key === "type" ||
            key === "loc" ||
            key === "range" ||
            key === "start" ||
            key === "end"
          )
            continue;
          const child = node[key];
          if (Array.isArray(child))
            child.forEach((c) => hoistNode(c, boundaryType));
          else if (child && typeof child === "object" && child.type)
            hoistNode(child, boundaryType);
        }
    }
  }

  // ─── Main scope-aware walker ───────────────────────────────────────────────
  function walk(node, ancestors = []) {
    if (!node || typeof node !== "object" || !node.type) return;

    const parent = ancestors[ancestors.length - 1];
    const grandparent = ancestors[ancestors.length - 2];
    ancestors = [...ancestors, node];

    switch (node.type) {
      // ── Strict-mode directives ──────────────────────────────────────────
      case "ExpressionStatement":
        if (
          node.expression.type === "Literal" &&
          node.expression.value === "use strict"
        )
          setStrictMode();
        walkChildren(node, ancestors);
        break;

      // ── Imports (module-level bindings) ────────────────────────────────
      case "ImportDeclaration":
        node.specifiers.forEach((spec) => {
          if (spec.local) addBinding(spec.local.name, "import", spec.local.loc);
        });
        break;

      // ── Variable declarations ───────────────────────────────────────────
      case "VariableDeclaration": {
        // var already hoisted; let/const need to be added now
        if (node.kind !== "var") {
          node.declarations.forEach((decl) => {
            extractIdentifiers(decl.id).forEach(({ name, loc }) =>
              addBinding(name, node.kind, loc),
            );
          });
        }
        // Walk initialisers (identifiers inside can still be checked)
        node.declarations.forEach((decl) => {
          if (decl.init) walk(decl.init, ancestors);
        });
        break;
      }

      // ── Function Declaration ────────────────────────────────────────────
      case "FunctionDeclaration": {
        // name already hoisted; push function scope
        pushScope("function");
        if (hasUseStrictDirective(node.body.body)) setStrictMode();
        // 'arguments' is available in non-arrow functions
        addBinding("arguments", "var", null);
        node.params.forEach((p) =>
          extractIdentifiers(p).forEach(({ name, loc }) =>
            addBinding(name, "param", loc),
          ),
        );
        // Hoist vars inside this function
        hoistScope(node.body.body, "function");
        walkChildren(node.body, ancestors); // walk body block directly
        popScope();
        break;
      }

      // ── Function Expression ─────────────────────────────────────────────
      case "FunctionExpression": {
        pushScope("function");
        if (hasUseStrictDirective(node.body.body)) setStrictMode();
        if (node.id) addBinding(node.id.name, "let", node.id.loc); // name visible inside
        addBinding("arguments", "var", null);
        node.params.forEach((p) =>
          extractIdentifiers(p).forEach(({ name, loc }) =>
            addBinding(name, "param", loc),
          ),
        );
        hoistScope(node.body.body, "function");
        walkChildren(node.body, ancestors);
        popScope();
        break;
      }

      // ── Arrow Function ──────────────────────────────────────────────────
      case "ArrowFunctionExpression": {
        pushScope("function");
        // Arrow functions do NOT have their own 'arguments'
        node.params.forEach((p) =>
          extractIdentifiers(p).forEach(({ name, loc }) =>
            addBinding(name, "param", loc),
          ),
        );
        if (node.body.type === "BlockStatement") {
          if (hasUseStrictDirective(node.body.body)) setStrictMode();
          hoistScope(node.body.body, "function");
          walkChildren(node.body, ancestors);
        } else {
          walk(node.body, ancestors);
        }
        popScope();
        break;
      }

      // ── Class ───────────────────────────────────────────────────────────
      case "ClassDeclaration":
        if (node.id) addBinding(node.id.name, "let", node.id.loc);
        walkChildren(node, ancestors);
        break;

      case "ClassExpression":
        pushScope("block");
        if (node.id) addBinding(node.id.name, "let", node.id.loc);
        walkChildren(node, ancestors);
        popScope();
        break;

      // ── Block Statement ─────────────────────────────────────────────────
      case "BlockStatement": {
        const parentNode = ancestors[ancestors.length - 2];
        const isBodyOfFunction =
          parentNode &&
          (parentNode.type === "FunctionDeclaration" ||
            parentNode.type === "FunctionExpression" ||
            parentNode.type === "ArrowFunctionExpression");
        if (!isBodyOfFunction) pushScope("block");
        walkChildren(node, ancestors);
        if (!isBodyOfFunction) popScope();
        break;
      }

      // ── Catch Clause ────────────────────────────────────────────────────
      case "CatchClause":
        pushScope("block");
        if (node.param) {
          extractIdentifiers(node.param).forEach(({ name, loc }) =>
            addBinding(name, "catch", loc),
          );
        }
        walkChildren(node, ancestors);
        popScope();
        break;

      // ── for / for-in / for-of (block scope for let/const iterator) ──────
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        pushScope("block");
        // init / left is walked by walkChildren which will hit VariableDeclaration
        walkChildren(node, ancestors);
        popScope();
        break;
      }

      // ── Assignment (implicit globals in sloppy mode) ─────────────────────
      case "AssignmentExpression": {
        if (node.left.type === "Identifier") {
          const name = node.left.name;
          if (!isDefined(name) && !globals.has(name)) {
            if (isStrictMode()) {
              // strict mode: assigning to undeclared var is a ReferenceError
              addError(
                name,
                node.left.loc?.start?.line,
                node.left.loc?.start?.column,
                `ReferenceError (strict): '${name}' is not defined`,
              );
            } else {
              // sloppy mode: implicit global creation
              scopeStack[0].bindings.set(name, {
                kind: "var",
                declLine: null,
                declCol: null,
              });
            }
          }
        }
        walkChildren(node, ancestors);
        break;
      }

      // ── Identifier ───────────────────────────────────────────────────────
      case "Identifier": {
        if (isDeclarationContext(node, parent)) break;

        const name = node.name;
        const line = node.loc?.start?.line;
        const col = node.loc?.start?.column;

        // 'self' bare (not self.x) is always an error
        if (name === "self") {
          if (!(
            parent?.type === "MemberExpression" && parent.object === node
          )) {
            addError(
              name,
              line,
              col,
              `ReferenceError: 'self' used without property access`,
            );
          }
          break;
        }

        if (globals.has(name)) break;

        const found = lookup(name);
        if (!found) {
          const key = `notdef:${name}`;
          if (!seenErrors.has(key)) {
            seenErrors.add(key);
            addError(
              name,
              line,
              col,
              `ReferenceError: '${name}' is not defined`,
            );
          }
          break;
        }

        // TDZ check for let/const
        if (
          tdz &&
          (found.binding.kind === "let" || found.binding.kind === "const")
        ) {
          const declLine = found.binding.declLine;
          const declCol = found.binding.declCol;
          if (
            declLine !== null &&
            (line < declLine || (line === declLine && col < declCol))
          ) {
            addError(
              name,
              line,
              col,
              `ReferenceError (TDZ): '${name}' accessed before its declaration (declared at line ${declLine})`,
            );
          }
        }
        break;
      }

      // ── this ─────────────────────────────────────────────────────────────
      case "ThisExpression": {
        const line = node.loc?.start?.line;
        const col = node.loc?.start?.column;

        if (removeThis) {
          addError(
            "this",
            line,
            col,
            `ReferenceError: 'this' is not allowed here`,
          );
          break;
        }

        // In strict mode, 'this' at the top-level (global scope) is undefined — flag bare this
        if (isStrictMode()) {
          const inFunction = scopeStack.some((s) => s.type === "function");
          if (!inFunction) {
            // bare this at module/global level in strict mode → undefined (not an error per se,
            // but many analyzers warn; we match browser: no ReferenceError, but warn)
            addError(
              "this",
              line,
              col,
              "Warning (strict): 'this' is undefined at top level",
            );
          }
        }

        // Bare 'this' (not this.x) outside any function in sloppy mode is valid (window),
        // so no error there.
        break;
      }

      // ── Default: recurse ─────────────────────────────────────────────────
      default:
        walkChildren(node, ancestors);
    }
  }

  function walkChildren(node, ancestors) {
    for (const key of Object.keys(node)) {
      if (
        key === "type" ||
        key === "loc" ||
        key === "range" ||
        key === "start" ||
        key === "end"
      )
        continue;
      const child = node[key];
      if (Array.isArray(child)) {
        child.forEach((c) => {
          if (c && typeof c === "object" && c.type) walk(c, ancestors);
        });
      } else if (child && typeof child === "object" && child.type) {
        walk(child, ancestors);
      }
    }
  }

  // ─── Kick off ─────────────────────────────────────────────────────────────
  pushScope("global", false);
  if (strictMode) setStrictMode();

  // Detect top-level "use strict"
  if (hasUseStrictDirective(ast.body)) setStrictMode();

  // Hoist top-level var + function declarations
  hoistScope(ast.body, "global");

  // Main walk
  walkChildren(ast, [ast]);

  // ─── Result ───────────────────────────────────────────────────────────────
  return {
    errors: referenceErrors,
    strict: isStrictMode(),
    formatErrors: (errors = referenceErrors) =>
      !errors.length
        ? "✓ No reference errors"
        : errors
            .map((e) => `[Line ${e.line}:${e.col}] ${e.message}`)
            .join("\n"),
  };
}
function checkForReferenceErrors2(code, options = {}) {
  /* known issues - doesnt throw error for example 
            
            
            console.log(await) should throw Uncaught ReferenceError: await is not defined  
            
            Current error throws only if in version 2020 - does not allow top level: 
            
            Uncaught SyntaxError: await is only valid in async functions and the top level bodies of modules 
           
           */
  const {
    additionalGlobals = [],
    ignoreGlobals = false,
    ecmaVersion = "latest",
  } = options;

  let ast;
  try {
    ast = customAcorn.parse(code, {
      ecmaVersion,
      sourceType: "module",
      locations: true,
    });
  } catch (error) {
    error = formatErrors(code, error);

    throw error;
  }

  const referenceErrors = [];
  const seen = new Set();
  const globals = ignoreGlobals
    ? new Set()
    : new Set([...standardESGlobals, ...additionalGlobals, "process"]);

  // Stack-based scope tracker
  const scopeStack = [];

  function pushScope() {
    scopeStack.push(new Set());
  }

  function popScope() {
    scopeStack.pop();
  }

  function addBinding(name) {
    if (scopeStack.length > 0) {
      scopeStack[scopeStack.length - 1].add(name);
    }
  }

  function isDefined(name) {
    // Check all scopes from innermost to outermost
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      if (scopeStack[i].has(name)) {
        return true;
      }
    }
    return false;
  }

  // Helper to extract identifiers from patterns
  function extractIdentifiers(pattern, names = []) {
    if (!pattern) return names;

    switch (pattern.type) {
      case "Identifier":
        names.push(pattern.name);
        break;
      case "ObjectPattern":
        pattern.properties.forEach((prop) => {
          if (prop.type === "Property") {
            extractIdentifiers(prop.value, names);
          } else if (prop.type === "RestElement") {
            extractIdentifiers(prop.argument, names);
          }
        });
        break;
      case "ArrayPattern":
        pattern.elements.forEach((el) => {
          if (el) extractIdentifiers(el, names);
        });
        break;
      case "RestElement":
        extractIdentifiers(pattern.argument, names);
        break;
      case "AssignmentPattern":
        extractIdentifiers(pattern.left, names);
        break;
    }
    return names;
  }

  function isDeclarationContext(node, parent, grandparent) {
    if (!parent) return false;
    return (
      (parent.type === "VariableDeclarator" && parent.id === node) ||
      (parent.type === "FunctionDeclaration" && parent.id === node) ||
      (parent.type === "FunctionExpression" && parent.id === node) ||
      (parent.type === "ClassDeclaration" && parent.id === node) ||
      (parent.type === "ClassExpression" && parent.id === node) ||
      (parent.type === "Property" && parent.key === node && !parent.computed) ||
      (parent.type === "MethodDefinition" &&
        parent.key === node &&
        !parent.computed) ||
      (parent.type === "MemberExpression" &&
        parent.property === node &&
        !parent.computed) ||
      parent.type === "ImportSpecifier" ||
      parent.type === "ImportDefaultSpecifier" ||
      (parent.type === "LabeledStatement" && parent.label === node)
    );
  }

  // Initialize global scope
  pushScope();

  // Pre-pass: hoist function declarations
  walk.simple(ast, {
    FunctionDeclaration(node) {
      if (node.id) {
        addBinding(node.id.name);
      }
    },
  });

  // Main traversal with enter/leave
  const visitors = {
    FunctionDeclaration(node, state, ancestors) {
      // Create new scope for function body
      pushScope();
      // Add parameters to this scope
      node.params.forEach((param) => {
        extractIdentifiers(param).forEach((name) => addBinding(name));
      });
    },

    AssignmentExpression(node, state, ancestors) {
      /* Handles this like         
                  c = "to"
                  console.log(c)
                  */
      if (node.left.type === "Identifier") {
        const name = node.left.name;

        // If not already defined, treat as implicit global
        if (!isDefined(name) && !globals.has(name)) {
          // Add it to global scope (bottom of stack)
          scopeStack[0].add(name);
        }
      }
    },
    FunctionExpression(node, state, ancestors) {
      pushScope();
      // Add function name to its own scope (for recursion)
      if (node.id) {
        addBinding(node.id.name);
      }
      node.params.forEach((param) => {
        extractIdentifiers(param).forEach((name) => addBinding(name));
      });
    },
    ArrowFunctionExpression(node, state, ancestors) {
      pushScope();
      node.params.forEach((param) => {
        extractIdentifiers(param).forEach((name) => addBinding(name));
      });
    },
    BlockStatement(node, state, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      // Don't create scope for function bodies (function handles it)
      if (
        parent &&
        (parent.type === "FunctionDeclaration" ||
          parent.type === "FunctionExpression" ||
          parent.type === "ArrowFunctionExpression")
      ) {
        return;
      }
      // Create block scope for if/for/while blocks
      pushScope();
    },
    CatchClause(node, state, ancestors) {
      pushScope();
      if (node.param) {
        extractIdentifiers(node.param).forEach((name) => addBinding(name));
      }
    },
    VariableDeclaration(node, state, ancestors) {
      node.declarations.forEach((decl) => {
        extractIdentifiers(decl.id).forEach((name) => addBinding(name));
      });
    },
    ClassDeclaration(node, state, ancestors) {
      if (node.id) {
        addBinding(node.id.name);
      }
    },
    ImportDeclaration(node, state, ancestors) {
      node.specifiers.forEach((spec) => {
        if (spec.local) {
          addBinding(spec.local.name);
        }
      });
    },
    Identifier(node, state, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      const grandparent = ancestors[ancestors.length - 3];

      if (isDeclarationContext(node, parent, grandparent)) {
        return;
      }

      // Block: self (by itself)
      if (node.name === "self") {
        // Allow: self.property OR self['property']
        if (parent?.type === "MemberExpression" && parent.object === node) {
          return;
        }

        referenceErrors.push({
          name: "self",
          line: node.loc?.start?.line,
          col: node.loc?.start?.column,
          context: "Identifier",
        });
        return;
      }

      const name = node.name;
      if (!isDefined(name) && !globals.has(name) && !seen.has(name)) {
        referenceErrors.push({
          name,
          line: node.loc?.start?.line,
          col: node.loc?.start?.column,
          context: parent?.type || "unknown",
        });
        seen.add(name);
      }
    },
    ThisExpression(node, state, ancestors) {
      const parent = ancestors[ancestors.length - 2];

      // Allow: this.property  OR  this['property']
      if (parent?.type === "MemberExpression" && parent.object === node) {
        return;
      }

      if (!globals.has("this")) {
        referenceErrors.push({
          name: "this",
          line: node.loc?.start?.line,
          col: node.loc?.start?.column,
          context: parent?.type || "unknown",
        });
        seen.add("this");
      }

      // Block: this (by itself)

      /*  referenceErrors.push({
                          name: 'this',
                          line: node.loc?.start?.line,
                          col: node.loc?.start?.column,
                          context: 'ThisExpression'
                      });*/
    },
    Identifier(node, state, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      const grandparent = ancestors[ancestors.length - 3];

      if (isDeclarationContext(node, parent, grandparent)) {
        return;
      }

      // Block: self (by itself)
      if (node.name === "self") {
        // Allow: self.property OR self['property']
        if (parent?.type === "MemberExpression" && parent.object === node) {
          return;
        }

        referenceErrors.push({
          name: "self",
          line: node.loc?.start?.line,
          col: node.loc?.start?.column,
          context: "Identifier",
        });
        return;
      }

      const name = node.name;
      if (!isDefined(name) && !globals.has(name) && !seen.has(name)) {
        referenceErrors.push({
          name,
          line: node.loc?.start?.line,
          col: node.loc?.start?.column,
          context: parent?.type || "unknown",
        });
        seen.add(name);
      }
    },
  };

  // Custom walk that handles scope exit
  function walkWithScopes(node, visitors, ancestors = []) {
    ancestors = ancestors.concat(node);

    const visitor = visitors[node.type];
    if (visitor) {
      visitor(node, null, ancestors);
    }

    // Walk children
    for (const key in node) {
      if (key === "type" || key === "loc" || key === "range") continue;

      const child = node[key];
      if (!child) continue;

      if (Array.isArray(child)) {
        child.forEach((c) => {
          if (c && typeof c === "object" && c.type) {
            walkWithScopes(c, visitors, ancestors);
          }
        });
      } else if (typeof child === "object" && child.type) {
        walkWithScopes(child, visitors, ancestors);
      }
    }

    // Pop scope on exit
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "CatchClause"
    ) {
      popScope();
    } else if (node.type === "BlockStatement") {
      const parent = ancestors[ancestors.length - 2];
      if (
        !parent ||
        (parent.type !== "FunctionDeclaration" &&
          parent.type !== "FunctionExpression" &&
          parent.type !== "ArrowFunctionExpression")
      ) {
        popScope();
      }
    }
  }

  walkWithScopes(ast, visitors);

  return {
    errors: referenceErrors,
    formatErrors: (errors) =>
      !errors.length
        ? "✓ No reference errors"
        : errors
            .map((e) => `[Line ${e.line}:${e.col}] '${e.name}' not defined`)
            .join("\n"),
  };
}

function refCheck(code, additionalGlobals = []) {
  const refErrors = checkForReferenceErrors(code, { additionalGlobals });

  if (refErrors.errors.length != 0) {
    throw new Error(refErrors.formatErrors(refErrors.errors));
  }
}

// ---------------------------------------------------------------------------
// Canonical example snippets (from ui.html — newer, verified against the v1
// runtime; replaces the older set that lived in runtime.js).
// ---------------------------------------------------------------------------

// Example snippets for the .example-btn buttons (data-example keys).
// Each is self-contained and verified against the v1 runtime.
export const EXAMPLES = {
  basic: `// Basic Example: simple console logging
console.log('Hello from the browser sandbox!');
console.log('2 + 2 =', 2 + 2);
console.log('Node version:', process.version);`,

  async: `// Async/Await: fetch API with promises
async function main() {
  const res = await fetch('https://api.github.com/repos/MarketingPip/bundleVFSModules');
  const data = await res.json();
  console.log('Stars:', data.stargazers_count);
  console.log('Language:', data.language);
}
await main();`,

  sleep: `// Sleep / Delay: handling async timeouts gracefully
console.log('Waiting 1 second...');
await new Promise((r) => setTimeout(r, 1000));
console.log('Done waiting!');
console.log('Waiting 500ms more...');
await new Promise((r) => setTimeout(r, 500));
console.log('Finished.');`,

  imports: `// NPM Imports: use external libraries
import * as math from 'mathjs';

console.log('Square root of 16:', math.sqrt(16));
console.log('2^10 =', math.pow(2, 10));
console.log('factorial(5) =', math.factorial(5));`,

  require: `// CommonJS Require: legacy module loading
const path = require('path');
const os = require('os');

console.log('Joined path:', path.join('/home', 'user', 'docs'));
console.log('Platform:', os.platform());
console.log('Basename:', path.basename('/a/b/c.txt'));`,

  process_kill: `// Kill Process: simulate terminating execution mid-loop
let i = 0;
const timer = setInterval(() => {
  console.log('tick', ++i);
  if (i >= 3) {
    console.log('Terminating...');
    clearInterval(timer);
    process.exit(0);
  }
}, 300);`,

  interop: `// Sandbox Interop: expose methods & call parent functions
// The host page exposes interop methods; list what is available:
const exposed = globalThis[Object.keys(globalThis).find((k) => k.startsWith('_RUNTIME'))];
console.log('Interop channel available:', typeof exposed?.emit === 'function');
// Emit a custom event the host can listen for:
if (exposed && typeof exposed.emit === 'function') {
  exposed.emit('playground-ping', { hello: 'from sandbox' });
  console.log('Emitted playground-ping event');
}`,

  top_level: `// Top Level Await: use await outside an async function
const result = await Promise.resolve(42);
console.log('Top-level await result:', result);

const delayed = await new Promise((r) => setTimeout(() => r('later'), 200));
console.log('Delayed value:', delayed);`,

  typescript: `// TypeScript: typed variables (transpiled by the TS plugin)
const greeting: string = 'hello typed world';
const answer: number = 40 + 2;
function add(a: number, b: number): number {
  return a + b;
}
console.log(greeting);
console.log('answer =', answer);
console.log('add(2, 3) =', add(2, 3));`,

  relative: `// Relative Imports: use relative imports from a fake filesystem
// (Seed files via the Files panel in a full app; here we demo path logic)
import path from 'path';
console.log('Resolve ./lib/util.js from /app:', path.resolve('/app', './lib/util.js'));
console.log('Relative from /app/src to /app/lib:', path.relative('/app/src', '/app/lib'));`,

  tests: `// Node.js Tests: emulate node:test
import test from 'node:test';

test('addition works', () => {
  if (1 + 1 !== 2) throw new Error('math broke');
});
test('strings concatenate', () => {
  if ('a' + 'b' !== 'ab') throw new Error('strings broke');
});
console.log('Tests registered — runner executes them automatically.');`,

  cli: `// CLI: use STDIN — type in the stdin box below and click Send
console.log('Waiting for your input... (type below, click Send)');
process.stdin.once('data', (chunk) => {
  const text = chunk.toString().trim();
  console.log('You typed:', text);
  console.log('Uppercase:', text.toUpperCase());
  process.exit(0);
});`,

  cli_menu: `// Menu: pick a color via stdin
console.log('Pick a color: 1) red  2) green  3) blue');
console.log('Choice (1-3): (type below, click Send)');
process.stdin.once('data', (chunk) => {
  const answer = chunk.toString().trim();
  const colors = { 1: 'red', 2: 'green', 3: 'blue' };
  console.log('You picked:', colors[answer] || 'invalid');
  process.exit(0);
});`,

  inquirer: `// Inquirer-style prompts via stdin
const answers = [];
const questions = ['What is your name? (type below, click Send)', 'Favorite language? (type below, click Send)'];
console.log(questions[0]);
process.stdin.on('data', (chunk) => {
  answers.push(chunk.toString().trim());
  if (answers.length === 1) {
    console.log('Hello, ' + answers[0] + '!');
    console.log(questions[1]);
  } else if (answers.length === 2) {
    console.log(answers[1] + ' is a great choice.');
    process.exit(0);
  }
});`,

  repl: `// REPL: interactive evaluation loop
console.log('Mini REPL — type JS expressions, Send to evaluate, "exit" to quit.');
process.stdin.on('data', (chunk) => {
  console.log('[DEBUG] data handler called with:', JSON.stringify(chunk.toString()));
  const line = chunk.toString().trim();
  if (line === 'exit' || line === '.exit') {
    console.log('Bye!');
    process.exit(0);
  }
  try {
    console.log('=>', eval(line));
  } catch (err) {
    console.log('Error:', err.message);
  }
});`,

  repl2: `// REPL v2: persistent scope across lines
console.log('REPL v2 — variables persist. Try: x = 5, then x * 2, then exit');
const scope = {};
process.stdin.on('data', (chunk) => {
  const line = chunk.toString().trim();
  if (line === 'exit') {
    console.log('Bye!');
    process.exit(0);
  }
  try {
    const fn = new Function('scope', 'with (scope) { return (' + line + '); }');
    console.log('=>', fn(scope));
  } catch (err) {
    try {
      new Function('scope', 'with (scope) { ' + line + ' }')(scope);
      console.log('ok');
    } catch (e2) {
      console.log('Error:', e2.message);
    }
  }
});`,

  fs: `// FS: virtual filesystem read/write
import fs from 'fs';

fs.mkdirSync('/tmp', { recursive: true });
fs.writeFileSync('/tmp/hello.txt', 'Hello, virtual FS!');
console.log('Wrote /tmp/hello.txt');
const content = fs.readFileSync('/tmp/hello.txt', 'utf8');
console.log('Read back:', content);
console.log('Exists:', fs.existsSync('/tmp/hello.txt'));
console.log('Files in /tmp:', fs.readdirSync('/tmp'));`,

  child_process: `// Child Process: spawn commands
import { execSync } from 'child_process';

// Note: no real shell in the browser — execSync is an honest noop/stub.
// This demo shows the API surface without a subprocess:
console.log('execSync type:', typeof execSync);
try {
  const out = execSync('echo hi');
  console.log('Output:', String(out).trim());
} catch (err) {
  console.log('exec unavailable in browser (expected):', err.message);
}`,

  http: `// HTTP: create a server and hit it
import http from 'http';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from virtual server! Path: ' + req.url);
});
await new Promise((resolve) => server.listen(3000, resolve));
console.log('Server listening on port 3000');

const res = await fetch('http://localhost:3000/hello');
console.log('Response:', await res.text());
server.close();
console.log('Server closed.');`,

  express: `// Express-style: minimal router over the http shim
import http from 'http';

const routes = new Map();
const app = {
  get(path, handler) { routes.set('GET ' + path, handler); },
};

app.get('/hello', (req, res) => res.end('Hello!'));
app.get('/json', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

const server = http.createServer((req, res) => {
  const handler = routes.get(req.method + ' ' + req.url);
  if (handler) return handler(req, res);
  res.writeHead(404);
  res.end('not found');
});
await new Promise((resolve) => server.listen(3001, resolve));
console.log('App on :3001');

for (const p of ['/hello', '/json', '/missing']) {
  const r = await fetch('http://localhost:3001' + p);
  console.log(p, '->', r.status, await r.text());
}
server.close();`,
};

if (typeof globalThis !== "undefined" && !globalThis.__BVM_EXAMPLES__) {
  globalThis.__BVM_EXAMPLES__ = EXAMPLES;
}

// ---------------------------------------------------------------------------
// Argv helpers (moved from runtime.js).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Playground DOM helpers. Kept at module top level (and null-safe) because
// the sandbox beforeExecute hook (upgateProgressArgv -> getArgv) can call
// getArgv() even when the demo DOM is absent.
function getArgv() {
  const el = document.getElementById("argvInput");
  const raw = el ? el.value : "";
  return `node script.js ${raw}`;
}

function toggleArgvInput(enabled) {
  const input = document.getElementById("argvInput");
  // If enabled is true, input should be enabled (disabled = false)
  if (input) input.disabled = !enabled;
}

// Files panel lookup. Lazy and null-safe: null when the demo DOM is absent;
// renderFiles()/renderFiles2() no-op in that case (see below).
function getFilesDiv() {
  return typeof document === "undefined"
    ? null
    : document.getElementById("files");
}

// Shell-like argv split for the argv input box. `split` (shellwords) respects
// single/double quotes, unlike a naive whitespace split.
export function splitArgv(text) {
  const args = split(text || "");
  return ["node", "playground.mjs", ...args];
}

// ---------------------------------------------------------------------------
// Files panel (moved from runtime.js).
// ---------------------------------------------------------------------------

function detectMimeType(uint8) {
  if (
    uint8[0] === 0x89 &&
    uint8[1] === 0x50 &&
    uint8[2] === 0x4e &&
    uint8[3] === 0x47
  )
    return "image/png";
  if (uint8[0] === 0xff && uint8[1] === 0xd8 && uint8[2] === 0xff)
    return "image/jpeg";
  if (uint8[0] === 0x47 && uint8[1] === 0x49 && uint8[2] === 0x46)
    return "image/gif";
  if (
    uint8[0] === 0x52 &&
    uint8[1] === 0x49 &&
    uint8[2] === 0x46 &&
    uint8[3] === 0x46 &&
    uint8[8] === 0x57 &&
    uint8[9] === 0x45 &&
    uint8[10] === 0x42 &&
    uint8[11] === 0x50
  )
    return "image/webp";
  return "application/octet-stream";
}

// Keep track of active blob URLs globally or in closure scope so we can clean them up
let activeBlobUrls = [];

export function renderFiles(filesObj) {
  const filesDiv = getFilesDiv();
  if (!filesDiv) return; // no files panel (minimal host page) — nothing to render
  if (!filesObj) filesObj = {};

  filesObj = flattenFileTree(filesObj);

  activeBlobUrls.forEach((url) => URL.revokeObjectURL(url));
  activeBlobUrls = []; // Reset the tracking array

  filesDiv.innerHTML = "";

  const entries = Object.entries(filesObj);

  if (entries.length === 0) {
    filesDiv.innerHTML = `
      <div class="p-3 text-gray-400">
        No files available.
      </div>
    `;
    return;
  }

  entries.forEach(([name, content]) => {
    const fileItem = document.createElement("div");
    fileItem.className =
      "mb-2 border border-gray-700 rounded-md overflow-hidden";

    const ext = name.split(".").pop().toLowerCase();

    const imageTypes = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };

    const audioTypes = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      m4a: "audio/mp4",
    };

    const videoTypes = {
      mp4: "video/mp4",
      webm: "video/webm",
      ogg: "video/ogg",
      mov: "video/quicktime",
    };

    let bodyContent = "";

    if (
      content instanceof Uint8Array &&
      (imageTypes[ext] || audioTypes[ext] || videoTypes[ext])
    ) {
      let mime =
        imageTypes[ext] ||
        audioTypes[ext] ||
        videoTypes[ext] ||
        "application/octet-stream";

      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);

      // 2. TRACK THE NEW URL: Push it to our cleanup array
      activeBlobUrls.push(url);

      if (imageTypes[ext]) {
        bodyContent = `
          <div class="px-3 py-2 bg-gray-800 hidden">
            <img src="${url}" class="max-w-full rounded" />
          </div>
        `;
      } else if (audioTypes[ext]) {
        bodyContent = `
          <div class="px-3 py-2 bg-gray-800 hidden">
            <audio controls class="w-full">
              <source src="${url}" type="${mime}">
              Your browser does not support audio.
            </audio>
          </div>
        `;
      } else if (videoTypes[ext]) {
        bodyContent = `
          <div class="px-3 py-2 bg-gray-800 hidden">
            <video controls class="w-full max-h-96 rounded">
              <source src="${url}" type="${mime}">
              Your browser does not support video.
            </video>
          </div>
        `;
      }
    } else {
      // Text fallback with safe type checking
      let safeText = "";

      if (typeof content === "string") {
        safeText = content;
      } else if (content instanceof Uint8Array) {
        safeText = new TextDecoder().decode(content);
      } else if (
        content &&
        typeof content === "object" &&
        !(content instanceof Blob)
      ) {
        // If it's a directory object or unknown object instead of a file
        safeText = JSON.stringify(content, null, 2);
      } else {
        safeText = String(content ?? "");
      }

      bodyContent = `
        <pre class="px-3 py-2 bg-gray-800 text-xs text-gray-200 hidden overflow-auto">${safeText}</pre>
      `;
    }

    fileItem.innerHTML = `
      <button class="w-full text-left px-3 py-2 bg-gray-900 hover:bg-gray-800 flex justify-between items-center toggle-btn">
        <span class="text-gray-200">${name}</span>
        <span class="text-gray-400">▼</span>
      </button>
      ${bodyContent}
    `;

    filesDiv.appendChild(fileItem);
  });
}

export function renderFiles2(filesObj) {
  if (!filesObj) filesObj = {};
  const filesDiv = getFilesDiv();
  if (!filesDiv) return;
  filesDiv.innerHTML = "";

  const entries = Object.entries(filesObj);

  if (entries.length === 0) {
    filesDiv.innerHTML = `
      <div class="p-3 text-gray-400">
        No files available.
      </div>
    `;
    return;
  }

  entries.forEach(([name, content]) => {
    const fileItem = document.createElement("div");
    fileItem.className =
      "mb-2 border border-gray-700 rounded-md overflow-hidden";

    const ext = name.split(".").pop().toLowerCase();

    const imageTypes = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };

    const audioTypes = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      m4a: "audio/mp4",
    };

    const videoTypes = {
      mp4: "video/mp4",
      webm: "video/webm",
      ogg: "video/ogg",
      mov: "video/quicktime",
    };

    let bodyContent = "";

    if (
      (content instanceof Uint8Array && imageTypes[ext]) ||
      (content instanceof Uint8Array && audioTypes[ext]) ||
      (content instanceof Uint8Array && videoTypes[ext])
    ) {
      let mime =
        imageTypes[ext] ||
        audioTypes[ext] ||
        videoTypes[ext] ||
        "application/octet-stream";

      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);

      if (imageTypes[ext]) {
        bodyContent = `
          <div class="px-3 py-2 bg-gray-800 hidden">
            <img src="${url}" class="max-w-full rounded" />
          </div>
        `;
      } else if (audioTypes[ext]) {
        bodyContent = `
          <div class="px-3 py-2 bg-gray-800 hidden">
            <audio controls class="w-full">
              <source src="${url}" type="${mime}">
              Your browser does not support audio.
            </audio>
          </div>
        `;
      } else if (videoTypes[ext]) {
        bodyContent = `
          <div class="px-3 py-2 bg-gray-800 hidden">
            <video controls class="w-full max-h-96 rounded">
              <source src="${url}" type="${mime}">
              Your browser does not support video.
            </video>
          </div>
        `;
      }
    } else {
      // Text fallback
      const safeText =
        typeof content === "string"
          ? content
          : new TextDecoder().decode(content);

      bodyContent = `
        <pre class="px-3 py-2 bg-gray-800 text-xs text-gray-200 hidden overflow-auto">${safeText}</pre>
      `;
    }

    fileItem.innerHTML = `
      <button class="w-full text-left px-3 py-2 bg-gray-900 hover:bg-gray-800 flex justify-between items-center toggle-btn">
        <span class="text-gray-200">${name}</span>
        <span class="text-gray-400">▼</span>
      </button>
      ${bodyContent}
    `;

    // Toggle visibility

    filesDiv.appendChild(fileItem);
  });
}

// ---------------------------------------------------------------------------
// Demo sandbox factory (distilled from the EXAMPLE USAGE section that lived
// in runtime.js). Creates a CodeSandbox with the demo's illustrative config:
// esm.sh transform rules, seeded virtual FS, and the argv beforeExecute hook.
// ---------------------------------------------------------------------------

// Set process.argv from the argv input box before each execution.
async function upgateProgressArgv(sandbox) {
  sandbox.config.process.argv = split(getArgv());
}

export function createDemoSandbox(CodeSandbox, options = {}) {
  if (!CodeSandbox)
    throw new Error("createDemoSandbox requires { CodeSandbox }");
  const sandbox = new CodeSandbox({
    timeout: 50000,
    logNetworkRequests: true,
    validateSyntax: true,
    transformRules: [
      // 1️⃣ Alias resolution
      {
        test: function (source, kind) {
          return source === "mathlibrary" && kind === "require";
        },
        transform: function () {
          return "https://esm.sh/mathjs";
        },
      },

      // 2️⃣ Enforce esm.sh CDN
      {
        test: function (source) {
          return (
            !source.startsWith("https://esm.sh/") &&
            !builtinModules.includes(source)
          );
        },
        transform: function (source) {
          return source;
        },
      },

      // 3️⃣ Upgrade bare specifiers to the esm.sh CDN
      {
        test: function (source) {
          return (
            !source.startsWith("https://esm.sh/") &&
            !builtinModules.includes(source)
          );
        },
        transform: function (source) {
          if (
            source.startsWith("/") ||
            source.startsWith("./") ||
            source.startsWith("../") ||
            source.startsWith("https://")
          ) {
            return source;
          }
          return "https://esm.sh/" + source;
        },
      },
    ],
    fallbackCDN: false, // default is true
    process: {
      title: "node",
      arch: "x64",
      env: {
        HOME: "/Users/username",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        USER: "username",
        PWD: "/project/directory",
        NODE_ENV: "development",
      },
      platform: "darwin",
      pid: 12345,
      ppid: 12344,
      argv: [],
      argv0: "node",
      execPath: "/usr/local/bin/node",
      execArgv: [],
      version: "v20.10.0",
      versions: {
        node: "20.10.0",
        v8: "11.3.244.8-node.17",
        uv: "1.46.0",
        zlib: "1.2.13.1-motley",
        brotli: "1.0.9",
        ares: "1.20.1",
        modules: "115",
        nghttp2: "1.57.0",
        napi: "9",
        llhttp: "8.1.1",
        openssl: "3.0.12+quic",
        cldr: "43.1",
        icu: "73.2",
        tz: "2023c",
        unicode: "15.0",
      },
    },
    fs: {
      src: {
        utils: {
          "math.js": "export const add = (a, b) => a + b;",
          "math2.js": "import {add} from '../main2.js'; console.log(add)",
        },
        "main.js":
          "import { add } from './utils/math.js'; import helper from 'my-lib'; console.log(add(1, 2), helper); export {add}",
        "main2.js": `console.log('hello')`,
        node_modules: {
          "my-lib": {
            "package.json": '{"main": "dist/index.js"}',
            dist: {
              "index.js":
                "export default 'Hello from local node_modules package!';",
            },
          },
        },
      },
      node_modules: {
        "lodash-es": {
          "index.js":
            "export function cloneDeep(val) { return JSON.parse(JSON.stringify(val)); }",
        },
      },
      "require.js": `exports.add = (a, b) => a + b;
  exports.msg = 'Hello from CommonJS!';`,
      "test.js": "console.log('root file');",
      "package.json": '{"name": "sandbox"}',
      "math.test.js":
        "import { describe, it, expect } from 'vitest'; import { add } from './math.js'; describe('Math utility tests', () => { it('adds two numbers correctly', () => { expect(add(2, 3)).toBe(5); }); });",
    },

    // Set initial state of process args from the argv input box.
    beforeExecute: () => upgateProgressArgv(sandbox),
    ...(typeof document !== "undefined" && document.querySelector("#preview")
      ? { iframeElement: document.querySelector("#preview") }
      : {}),
    ...options,
  });
  return sandbox;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Illustrative demo handlers (from the EXAMPLE USAGE section that lived in
// runtime.js): interop registrations and event logging. Optional —
// initPlayground() does not install these; call wireDemoHandlers(sandbox)
// explicitly for the full legacy demo experience.
export function wireDemoHandlers(sandbox, { terminal } = {}) {
  sandbox.registerInterop("alert", async (data) => {
    alert(data);
  });

  sandbox.registerInterop("readFile", async (fileName) => {
    // Artificial delay to mimic real disk I/O
    await new Promise((resolve) => setTimeout(resolve, 500));

    const mockFiles = {
      "config.json": '{ "theme": "dark", "version": 1.0 }',
      "hello.txt": "Hello from the sandbox file system!",
      "secret.md": "The password is: 12345",
    };

    if (mockFiles[fileName]) {
      return mockFiles[fileName];
    } else {
      throw new Error(`File not found: ${fileName}`);
    }
  });

  sandbox.on("execution:fs", async ({ method, filename, data }) => {
    if (method === "writeFile") {
      // You can write the file live to your host VFS instead of getting
      // changes after execution.
    }
  });

  sandbox.on("execution:readline_newline", async (newLine) => {});

  sandbox.on("execution:server", async ({ type, port }) => {
    if (type === "open") {
      console.log(
        "A server has been opened and listening, expose function to call it etc..",
      );
      await delay(2000);
      console.log(
        await sandbox.invoke(
          "__serverRequest__",
          3000,
          "GET",
          "/api/users/1",
          {},
        ),
      );
    }

    if (type === "closed") {
      console.log("Server has been closed.");
    }
  });

  sandbox.on("execution:interop_registered", async ({ name }) => {
    if (name === "getData") {
      try {
        const data = await sandbox.invoke(name);
        alert(data.result);
      } catch (err) {
        console.log(err);
      }
    }

    console.log(name);
  });

  sandbox.on("execution:start", async ({ id }) => {
    console.log(`[Sandbox] Execution ${id} started`);
  });

  sandbox.on("execution:key_event", async (key_data) => {
    // console.log(key_data);
  });

  if (terminal) {
    // Stream sandbox stdout/stderr into the xterm terminal. xterm.js
    // interprets ANSI escape codes natively — write directly.
    sandbox.on("execution:stdout", ({ type, args }) => {
      if (type === "clear") {
        terminal.clear();
        return;
      }
      const text = Array.isArray(args) ? args.join(" ") : String(args ?? "");
      terminal.write(text + (text.endsWith("\n") ? "" : "\r\n"));
    });
  }

  sandbox.on("execution:complete", ({ id, result }) => {
    console.log(
      `[Sandbox] Execution ${id} completed in ${result.executionTime}ms`,
    );
  });
}

// ---------------------------------------------------------------------------
// initPlayground — the ONE playground framework.
//
// Wires a page's demo DOM (code editor, run button, output pane, stdin box,
// argv input, example buttons, files panel) to a CodeSandbox instance.
//
// Built from ui.html's inline wiring, which was the newer working reference:
// streaming stdout via `execution:stdout` events (with dedupe against the
// buffered result.logs), shell-like argv parsing, and stdin via
// invoke('__stdin__'). Absorbs the older runtime.js wiring: optional
// xterm.js terminal output, refCheck pre-flight, TypeScript transpiling,
// the files panel, and argv-input toggling.
//
//   import { CodeSandbox } from './runtime.js';
//   import { initPlayground } from './src/ui/playground.js';
//   const sandbox = initPlayground({ CodeSandbox });
//
// Options:
//   CodeSandbox    (required) the CodeSandbox class from runtime.js
//   examples       snippet map for .example-btn[data-example] (default: EXAMPLES)
//   useXterm       true → xterm.js terminal output; false → DOM divs (default)
//   sandboxOptions extra options passed to `new CodeSandbox()`
//   ids            DOM id overrides, e.g. { output: "myOutput" }
//
// Returns the CodeSandbox instance.
// ---------------------------------------------------------------------------

const PLACEHOLDER_HTML =
  '<div class="text-gray-500 italic">Click "Run Code" to see output here...</div>';

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

// Log entries arrive as {type, args} objects (or JSON strings of them, after
// the postMessage hop). Normalize to {text, type}.
function logEntry(entry) {
  let obj = entry;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return { text: obj, type: "log" };
    }
  }
  if (obj && typeof obj === "object") {
    if (typeof obj.args === "string")
      return { text: obj.args, type: obj.type || "log" };
    return { text: JSON.stringify(obj), type: "log" };
  }
  return { text: String(obj), type: "log" };
}

export function initPlayground({
  CodeSandbox,
  examples = EXAMPLES,
  useXterm = false,
  sandboxOptions = {},
  ids = {},
} = {}) {
  if (!CodeSandbox) {
    throw new Error("initPlayground requires { CodeSandbox }");
  }
  const $ = (id) => document.getElementById(ids[id] || id);
  const codeInput = $("codeInput");
  const runBtn = $("runBtn");
  const argvInput = $("argvInput");
  const stdinInput = $("stdinInput");
  const sendBtn = $("sendInput");
  const clearBtn = $("clearBtn");
  const outputEl = $("output");
  const statusEl = $("status");
  const execTimeEl = $("execTime");

  if (!codeInput || !runBtn || !outputEl) {
    throw new Error(
      "initPlayground: missing required demo DOM (codeInput, runBtn, output)",
    );
  }

  // One sandbox for the page; execute() tears down its iframe per run, so
  // repeated runs don't leak realms.
  const sandbox = new CodeSandbox({
    fileName: "playground.mjs",
    timeout: 30000,
    ...sandboxOptions,
  });

  // Optional xterm.js terminal output (the older runtime.js wiring).
  // xterm handles ANSI escape codes natively (colors, cursor movement).
  //
  // Terminal is dynamically imported so the esm.sh CDN stays demo-only:
  // if the CDN is down (or init throws), we log a warning and fall back
  // to DOM mode instead of breaking the whole playground.
  let term = null;
  if (useXterm) {
    initXtermTerminal();
  }

  // Async helper (initPlayground itself stays sync): resolves `term` once
  // the xterm.js CDN module loads, or leaves DOM mode in place on failure.
  async function initXtermTerminal() {
    try {
      const { Terminal } = await import("https://esm.sh/xterm@5.3.0");
      term = new Terminal({
        cols: 80,
        rows: 24,
        cursorBlink: true,
        theme: { background: "#1a1b26", foreground: "#c0caf5" },
      });
      term.open(outputEl);
      // Wire user input to sandbox stdin. onData fires for every keypress
      // including special keys (arrows, backspace, etc.).
      term.onData((data) => {
        sandbox.invoke("__stdin__", data).catch((err) => {
          console.error("[stdin] send failed:", err);
        });
      });
    } catch (e) {
      term = null;
      console.warn(
        "[playground] xterm init failed, falling back to DOM mode:",
        e,
      );
    }
  }

  function print(text, cls) {
    if (term) {
      term.write(text + (text.endsWith("\n") ? "" : "\r\n"));
      return;
    }
    const div = document.createElement("div");
    if (cls) div.className = cls;
    // Preserve newlines from multi-line log messages.
    div.innerHTML = esc(text).replace(/\n/g, "<br>");
    outputEl.appendChild(div);
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  function setStatus(text, cls) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = cls || "text-purple-400";
  }

  let running = false;
  let currentExample = null;

  // Wire the example buttons: click loads the snippet into the editor.
  document.querySelectorAll(".example-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-example") || btn.dataset.example;
      if (key && examples[key]) {
        codeInput.value = examples[key];
        sandbox.requireAllowed = false;
        if (key === "require") {
          sandbox.requireAllowed = true;
        }
        currentExample = key;
        codeInput.scrollIntoView({ behavior: "smooth", block: "center" });
        codeInput.focus();
      }
    });
  });

  runBtn.addEventListener("click", async () => {
    if (running) return;
    running = true;
    runBtn.disabled = true;
    runBtn.classList.add("opacity-50", "cursor-not-allowed");
    if (term) term.clear();
    else outputEl.innerHTML = "";
    setStatus("Running…", "text-yellow-400");
    if (execTimeEl) execTimeEl.textContent = "";
    if (sendBtn) sendBtn.disabled = false;

    // Applied per-run: the runtime serializes config.process fresh on
    // every execute().
    if (argvInput) {
      sandbox.config.process.argv = splitArgv(argvInput.value);
    }

    // Stream stdout in real-time so interactive (stdin) programs show their
    // prompts before execute() resolves. The buffered result.logs path below
    // stays as the fallback for non-streamed output.
    let streamHandler = null;
    const seen = new Set();
    streamHandler = (evt) => {
      // evt = {type, args}; dedupe against the buffered logs via a key.
      const key = evt.type + ":" + String(evt.args).slice(0, 200);
      if (seen.has(key)) return;
      seen.add(key);
      const { text, type } = logEntry(evt);
      print(
        text,
        type === "error" ? "text-red-400" : term ? "" : "text-gray-100",
      );
    };
    sandbox.on("execution:stdout", streamHandler);

    let code = codeInput.value;
    if (currentExample === "typescript") {
      code = transpileTypeScript(code);
    }

    // Pre-flight reference check (from the older runtime.js wiring).
    const allowedGlobals = [
      "setImmediate",
      "fs",
      "interop",
      "type",
      "readline",
      "__dirname",
      "Buffer",
      "globalThis",
    ];
    if (sandbox.requireAllowed) allowedGlobals.push("require");

    const t0 = performance.now();
    try {
      toggleArgvInput(false);
      refCheck(code, allowedGlobals);

      const result = await sandbox.execute(code);
      const logs = result.logs || [];
      // Print any buffered logs not already streamed (dedupe via seen).
      for (const entry of logs) {
        const { text, type } = logEntry(entry);
        const key = type + ":" + text.slice(0, 200);
        if (seen.has(key)) continue;
        print(
          text,
          type === "error" ? "text-red-400" : term ? "" : "text-gray-100",
        );
      }
      if (!logs.length && !seen.size && result.success && !term) {
        print("(no output)", "text-gray-500 italic");
      }
      if (!result.success) {
        const errs = result.errors || result.error;
        if (errs) {
          const msg = Array.isArray(errs) ? errs.join("\n") : String(errs);
          if (term) term.write(msg + "\r\n");
          else print(msg, "text-red-400");
        }
        setStatus("Error", "text-red-400");
      } else {
        setStatus("Done", "text-green-400");
      }

      // Files panel: render the sandbox FS after each run.
      try {
        renderFiles(result.fs);
      } catch {
        // files panel is optional
      }
    } catch (err) {
      const msg = "Error: " + (err && err.message ? err.message : String(err));
      if (term) term.write(msg + "\r\n");
      else print(msg, "text-red-400");
      setStatus("Error", "text-red-400");
    } finally {
      if (streamHandler) {
        if (typeof sandbox.off === "function")
          sandbox.off("execution:stdout", streamHandler);
        else if (typeof sandbox.removeListener === "function")
          sandbox.removeListener("execution:stdout", streamHandler);
        streamHandler = null;
      }
      toggleArgvInput(true);
      if (execTimeEl) {
        execTimeEl.textContent =
          ((performance.now() - t0) / 1000).toFixed(2) + "s";
      }
      running = false;
      runBtn.disabled = false;
      runBtn.classList.remove("opacity-50", "cursor-not-allowed");
      if (sendBtn) sendBtn.disabled = true;
    }
  });

  if (sendBtn && stdinInput) {
    sendBtn.addEventListener("click", async () => {
      const text = stdinInput.value;
      if (!text) return;
      try {
        // Wait for the iframe to exist before invoking. Don't require the
        // running flag — sandbox_ready can lag behind actual execution.
        const deadline = performance.now() + 10000;
        while (performance.now() < deadline) {
          const ctx = sandbox._context;
          if (ctx && ctx.iframe && ctx.iframe.contentWindow) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        await sandbox.invoke("__stdin__", text + "\n");
        print("> " + text, term ? "" : "text-purple-300");
      } catch (err) {
        print(
          "stdin: " + (err && err.message ? err.message : String(err)),
          "text-red-400",
        );
      }
      stdinInput.value = "";
    });
    stdinInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendBtn.click();
    });
    sendBtn.disabled = true;
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (term) term.clear();
      else outputEl.innerHTML = PLACEHOLDER_HTML;
      if (execTimeEl) execTimeEl.textContent = "";
    });
  }

  // Smooth scrolling for anchor links.
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener("click", function (e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute("href"));
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  // Files list event delegation: only ONE listener for the whole list.
  const filesDiv = getFilesDiv();
  if (filesDiv) {
    filesDiv.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const pre = button.nextElementSibling;
      if (!pre) return;
      pre.classList.toggle("hidden");
    });
  }

  setStatus("Ready", "text-purple-400");
  return sandbox;
}
