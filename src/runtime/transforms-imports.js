// Extracted from runtime.js (lines 1433-2253) — Worker B, modular/transforms.
// DO NOT EDIT by hand: re-extract from runtime.js. Code is byte-identical
// to the original except: top-level `export` keywords added, imports use
// bare specifiers (browser resolves via the same esm.sh packages; Node
// tests resolve via node_modules).
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import MagicString from "magic-string";

// Cross-module dependency: in runtime.js this is the top-level const at
// line 73 (builtin key -> dist file). Kept as a mutable module binding so
// the host can inject the real manifest; defaults to {} (no builtins).
let _builtinManifest = {};
export function setBuiltinManifest(manifest) {
  _builtinManifest = manifest || {};
}

/**
 * Replaces occurrences of globalThis.<variableName> in JS code
 *
 * @param {string} code - Source code
 * @param {string} variableName - Property name to match
 * @param {object} [opts]
 * @param {string} [opts.replacement] - Replacement string
 * @param {boolean} [opts.generateUnique] - Auto-generate unique replacement
 * @returns {{ code: string, replacements: number, replacement: string }}
 */
export function replaceGlobalThisVar(code, variableName, opts = {}) {
  const { replacement, generateUnique = false, filename = "input.js" } = opts;

  // Generate unique replacement if requested
  const finalReplacement =
    replacement ||
    (generateUnique
      ? `globalThis._RUNTIME_${variableName}_${Math.random()
          .toString(36)
          .slice(2)}`
      : `globalThis.${variableName}`);

  // Parse AST
  const ast = acorn.parse(code, {
    ecmaVersion: 2020,
    sourceType: "module",
    locations: true, // useful for debugging
  });

  const s = new MagicString(code, { filename });

  // Find matches and replace via MagicString (tracks source map)
  walk.simple(ast, {
    MemberExpression(node) {
      if (
        node.object.type === "Identifier" &&
        node.object.name === "globalThis" &&
        node.property.type === "Identifier" &&
        node.property.name === variableName
      ) {
        s.overwrite(node.start, node.end, finalReplacement);
      }
    },
  });

  const outCode = s.toString();
  const map = s.generateMap({
    source: filename,
    hires: false, // line-level maps: hires VLQ explodes on MB-size inputs (74MB mappings for 16MB source), blocking the main thread; line-level suffices for stack traces,
    includeContent: true,
  });
  return { code: outCode, map };
}

/**
 * Transform JS code to replace imports/requires with loadModule calls.
 * Handles static imports, dynamic imports, require(), and CJS → ESM interop.
 */
export function transformImportsToLoadModule(
  sandboxUUID,
  code,
  entryPoint = null,
  parentEntryPoint = null,
  opts = {},
) {
  const preserveRequireCalls = opts.preserveRequireCalls === true;

  const s = new MagicString(code, { filename: entryPoint || "input.js" });
  const ast = acorn.parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    ranges: true,
  });

  // --- Helper: attach parents for context ---
  function attachParents(node, parent = null) {
    if (!node || typeof node !== "object") return;
    node.parent = parent;
    for (const k in node) {
      if (["parent", "start", "end", "type"].includes(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => attachParents(c, node));
      else attachParents(v, node);
    }
  }
  attachParents(ast);

  // --- Utilities ---
  const liftedModules = new Map();
  let starSeq = 0;
  let reexpSeq = 0;
  const importBindings = [];
  const functionsToMakeAsync = new Set();
  const moduleImportType = new Map();
  // Live-binding table: imported local name -> { liftedVar, importedName }.
  // Named/default imports no longer emit `const { x } = __lm` (a snapshot);
  // instead every live reference to the local is rewritten to
  // `liftedVar.importedName` (the esbuild/rollup pattern). Namespace imports
  // keep `const ns = __lm` and are NOT in this map.
  const importBindingMap = new Map();

  // Track every range the transform overwrites/removes so the later
  // reference-rewrite pass never touches already-rewritten code (overlapping
  // MagicString edits throw).
  const editedRanges = [];
  const _overwrite = s.overwrite.bind(s);
  s.overwrite = (start, end, content, ...rest) => {
    editedRanges.push([start, end]);
    return _overwrite(start, end, content, ...rest);
  };
  const _remove = s.remove.bind(s);
  s.remove = (start, end) => {
    editedRanges.push([start, end]);
    return _remove(start, end);
  };
  const rangeIsEdited = (start, end) => {
    for (const [rs, re] of editedRanges) {
      if (start < re && end > rs) return true;
    }
    return false;
  };

  function getLiftedVar(modulePath) {
    if (!liftedModules.has(modulePath)) {
      const safeName = "__lm_" + Math.random().toString(36).slice(2, 7);
      liftedModules.set(modulePath, safeName);
    }
    return liftedModules.get(modulePath);
  }

  function registerImportBindings(node) {
    // Record local -> { liftedVar, importedName } for the live-reference
    // rewrite. First import wins (a duplicate local name is invalid ESM).
    const v = getLiftedVar(node.source.value);
    for (const sp of node.specifiers) {
      if (sp.type === "ImportSpecifier") {
        if (!importBindingMap.has(sp.local.name)) {
          importBindingMap.set(sp.local.name, {
            liftedVar: v,
            importedName: sp.imported.name,
          });
        }
      } else if (sp.type === "ImportDefaultSpecifier") {
        if (!importBindingMap.has(sp.local.name)) {
          importBindingMap.set(sp.local.name, {
            liftedVar: v,
            importedName: "default",
          });
        }
      }
      // ImportNamespaceSpecifier keeps `const ns = __lm` (live via the
      // fixed proxy) — never rewritten, never registered here.
    }
  }

  function setImportType(modulePath, type) {
    const prev = moduleImportType.get(modulePath);
    if (!prev || (prev === "require" && type === "import")) {
      moduleImportType.set(modulePath, type);
    }
  }

  function interop(varName) {
    return `(${varName} && ${varName}.default !== undefined ? ${varName}.default : ${varName})`;
  }

  function findEnclosingFunction(node) {
    let n = node.parent;
    while (n) {
      if (
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ].includes(n.type)
      )
        return n;
      n = n.parent;
    }
    return null;
  }

  // --- Phase 0: pre-register import bindings ---
  // An `export { x }` (no source) may textually precede the import it
  // re-exports — `export { x }; import { x } from './m'` is legal ESM
  // because imports hoist — so the live-binding table must be complete
  // before the main walk reaches the export declarations.
  for (const node of ast.body) {
    if (node.type === "ImportDeclaration") registerImportBindings(node);
  }

  // --- AST walk ---
  walk.simple(ast, {
    // Static ESM imports
    ImportDeclaration(node) {
      const modulePath = node.source.value;
      const v = getLiftedVar(modulePath);
      importBindings.push({ node, liftedVar: v });
      registerImportBindings(node);
      setImportType(modulePath, "import");
      s.remove(node.start, node.end);
    },

    // 3️⃣ import.meta
    MetaProperty(node) {
      if (node.meta.name === "import" && node.property.name === "meta") {
        // Check if import.meta is accessed via MemberExpression
        const parent = node.parent;
        // Map common import.meta properties to custom values
        const metaValues = {
          url: `file:///${entryPoint}`,
          dirname: "https://example.com/",
          resolve: "__RUNTIME_RESOLVE__HANDLE",
          // add more properties here if needed
        };

        function serializeMeta(obj) {
          const entries = [];
          for (const key in obj) {
            if (key === "resolve") {
              // Keep resolve as a function literal in the string
              entries.push(`${key}: __RUNTIME_RESOLVE__HANDLE`);
            } else {
              // Escape strings safely
              entries.push(`${key}: ${JSON.stringify(obj[key])}`);
            }
          }

          return `{ ${entries.join(", ")} }`; // returns a string
        }

        if (
          parent.type === "MemberExpression" &&
          parent.object === node &&
          parent.property.type === "Identifier"
        ) {
          const prop = parent.property.name;

          if (metaValues[prop]) {
            if (prop != "resolve") {
              s.overwrite(parent.start, parent.end, `'${metaValues[prop]}'`);
            } else {
              s.overwrite(parent.start, parent.end, `${metaValues[prop]}`);
            }
          } else {
            // unknown property — fallback to full object
            s.overwrite(parent.start, parent.end, `{ ${prop}: undefined }`);
          }
        } else {
          // Bare import.meta — replace with object
          s.overwrite(node.start, node.end, serializeMeta(metaValues));
        }
      }
    },

    ImportExpression(node) {
      if (
        node.source.type === "Literal" &&
        typeof node.source.value === "string"
      ) {
        const modulePath = node.source.value;
        // Dynamic import() is transformed in-situ only: it must NOT be
        // registered as a lifted module. The preamble
        // 'const __lm_xxx = await loadModule(...)' was dead code for dynamic
        // imports (the in-situ call below never references a lifted var) but
        // its await still ran before any user code — stalling the whole
        // module on slow loads (real vite@7: ~30 chunks through interop
        // _dynamic_import/_build_file) before the user's own drain-hold timer
        // was even registered, so execute() resolved early with no output.
        // Static ImportDeclarations keep their preamble hoist; dynamic
        // import() keeps real import() semantics (lazy, returns a promise).
        void modulePath;

        const enclosingFunc = findEnclosingFunction(node);

        // If inside non-async function → replace import with lifted variable
        /* if (enclosingFunc && !enclosingFunc.async) {
      s.overwrite(node.start, node.end, v);
      return; // stop further processing
    }*/

        // Otherwise (async function or top-level) → transform normally
        //if (enclosingFunc && enclosingFunc.async) functionsToMakeAsync.add(enclosingFunc);

        // Replace 'import' with 'loadModule'
        s.overwrite(
          node.start,
          node.start + 6,
          `globalThis._RUNTIME${sandboxUUID}_.loadModule`,
        );

        // Append loader arguments inside parentheses
        s.appendLeft(
          node.source.end,
          `, 'import', ${JSON.stringify(entryPoint)}, ${JSON.stringify(parentEntryPoint)}`,
        );
      }
    },
    _ImportExpression(node) {
      if (
        node.source.type === "Literal" &&
        typeof node.source.value === "string"
      ) {
        const modulePath = node.source.value;
        const v = getLiftedVar(modulePath);
        setImportType(modulePath, "import");

        const enclosingFunc = findEnclosingFunction(node);
        if (enclosingFunc && !enclosingFunc.async)
          functionsToMakeAsync.add(enclosingFunc);

        // Replace the 'import' keyword with 'loadModule'
        s.overwrite(
          node.start,
          node.start + 6,
          `globalThis._RUNTIME${sandboxUUID}_.loadModule`,
        );

        // Append the loader type as a second argument **inside the parentheses**
        // node.source.end points just after the string literal
        s.appendLeft(
          node.source.end,
          `, 'import', ${JSON.stringify(entryPoint)}, ${JSON.stringify(parentEntryPoint)}`,
        );
      }
    },

    // require() calls
    CallExpression(node) {
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments.length === 1
      ) {
        // When building a CommonJS module for require(), leave require()
        // calls intact: the runtime executes them synchronously via
        // __syncRequire__ inside wrapCommonJS. Rewriting them to awaited
        // loadModule() calls here would place 'await' inside the sync IIFE
        // wrapper -> SyntaxError: Unexpected reserved word.
        if (preserveRequireCalls) return;
        const arg = node.arguments[0];
        if (arg.type !== "Literal" || typeof arg.value !== "string") {
          // Dynamic require(moduleName): the specifier is not statically
          // known, so neither the top-level hoist nor the nested-builtin
          // fast path applies. Rewrite the callee to __bvmRequireSync and
          // let the runtime resolve it: a manifest builtin returns the
          // cached instance synchronously when warm, otherwise triggers the
          // async load and returns its promise; anything else throws
          // ERR_REQUIRE_ASYNC_MODULE (dynamic require of a non-builtin has
          // no sync path - use import()).
          s.overwrite(node.callee.start, node.callee.end, "__bvmRequireSync");
          return;
        }
        const modulePath = arg.value;
        // On-demand require (Worker B): top-level builtin requires keep the
        // existing hoist; builtin requires nested in a function rewrite to
        // __bvmRequireSync() so nothing loads until the function is called.
        // Nested non-builtin (relative/bare) requires keep the existing lift —
        // they have no sync path in ESM scope.
        const bareModulePath =
          typeof modulePath === "string" && modulePath.indexOf("node:") === 0
            ? modulePath.slice(5)
            : modulePath;
        const isBuiltin =
          typeof bareModulePath === "string" &&
          Object.prototype.hasOwnProperty.call(
            _builtinManifest,
            bareModulePath,
          );
        const enclosingFunc = findEnclosingFunction(node);
        if (isBuiltin && enclosingFunc !== null) {
          s.overwrite(
            node.start,
            node.end,
            "__bvmRequireSync(" + JSON.stringify(modulePath) + ")",
          );
          return;
        }
        const v = getLiftedVar(modulePath);
        setImportType(modulePath, "require");

        if (enclosingFunc && !enclosingFunc.async)
          functionsToMakeAsync.add(enclosingFunc);

        s.overwrite(node.start, node.end, interop(v));
      }
    },

    // export * from "./x" (emitted by convertCjsToEsm for __exportStar).
    // ESM 'export *' cannot target a runtime-loaded module from a data: URL,
    // so export the lifted namespace under a marker key; buildModuleProxy
    // treats __bvm_star_* as star re-export sources (skipping 'default').
    ExportAllDeclaration(node) {
      const modulePath = node.source.value;
      const v = getLiftedVar(modulePath);
      setImportType(modulePath, "import");
      const starKey = `__bvm_star_${starSeq++}`;
      s.overwrite(node.start, node.end, `export const ${starKey} = ${v};`);
    },

    // export { a, b as c } from "./x" — re-export with source.
    // Like ExportAllDeclaration, the source must be lifted via loadModule
    // because relative resolution fails from data: URLs. The re-export is
    // LIVE: instead of destructuring (a snapshot), emit a marker export
    // `__bvm_reexp_N`; buildModuleProxy collects these markers and resolves
    // each name through the (live) source namespace on every read.
    ExportNamedDeclaration(node) {
      if (!node.source) {
        // export { x } / export { x as y } without source: any specifier
        // whose local is an imported binding becomes a live re-export
        // marker; the remaining (truly local) specifiers keep a real
        // export declaration. Untouched when nothing is imported.
        const liveParts = [];
        const kept = [];
        for (const sp of node.specifiers) {
          const b = importBindingMap.get(sp.local.name);
          if (b) liveParts.push([sp.exported.name, b]);
          else kept.push(code.slice(sp.start, sp.end));
        }
        if (liveParts.length === 0) return; // leave as-is
        const marker =
          `export const __bvm_reexp_${reexpSeq++} = { ` +
          liveParts
            .map(
              ([exported, b]) =>
                `${JSON.stringify(exported)}: [${b.liftedVar}, ${JSON.stringify(b.importedName)}]`,
            )
            .join(", ") +
          ` };`;
        s.overwrite(
          node.start,
          node.end,
          kept.length === 0 ? marker : `export { ${kept.join(", ")} };\n${marker}`,
        );
        return;
      }
      const modulePath = node.source.value;
      const v = getLiftedVar(modulePath);
      setImportType(modulePath, "import");
      const entries = node.specifiers.map((sp) => {
        // sp.exported is the exported name, sp.local is the imported name
        // For `export { foo } from`, exported=foo, local=foo
        // For `export { bar as baz } from`, exported=baz, local=bar
        return `${JSON.stringify(sp.exported.name)}: [${v}, ${JSON.stringify(sp.local.name)}]`;
      });
      s.overwrite(
        node.start,
        node.end,
        `export const __bvm_reexp_${reexpSeq++} = { ${entries.join(", ")} };`,
      );
    },
  });

  // --- Phase 2: rewrite references to imported bindings as live member
  // access (the esbuild/rollup pattern). Named/default imports no longer
  // destructure in the preamble, so every live reference `x` becomes
  // `__lm_N.importedName`.
  const scopeDecls = new Map(); // scope-introducing AST node -> Set(names)
  const scopeSet = (n) => {
    let st = scopeDecls.get(n);
    if (!st) {
      st = new Set();
      scopeDecls.set(n, st);
    }
    return st;
  };
  const namesOfPattern = (pat, out) => {
    if (!pat) return out;
    if (pat.type === "Identifier") {
      out.push(pat.name);
      return out;
    }
    if (pat.type === "ObjectPattern") {
      for (const pr of pat.properties) {
        if (pr.type === "Property") namesOfPattern(pr.value, out);
        else namesOfPattern(pr.argument, out); // RestElement
      }
      return out;
    }
    if (pat.type === "ArrayPattern") {
      for (const el of pat.elements) if (el) namesOfPattern(el, out);
      return out;
    }
    if (pat.type === "RestElement") {
      namesOfPattern(pat.argument, out);
      return out;
    }
    if (pat.type === "AssignmentPattern") {
      namesOfPattern(pat.left, out);
      return out;
    }
    return out;
  };
  // Single recursive pass: for every scope node record the names it binds.
  // `var` declarations hoist to the nearest function/program scope; every
  // other binding form lives in its own lexical scope.
  const buildScopes = (node, lexScope, varScope) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) buildScopes(c, lexScope, varScope);
      return;
    }
    if (!node.type) return;
    const t = node.type;
    let newLex = lexScope;
    let newVar = varScope;
    if (
      t === "Program" ||
      t === "BlockStatement" ||
      t === "StaticBlock" ||
      t === "SwitchStatement"
    ) {
      newLex = node;
      scopeSet(node);
    } else if (
      t === "FunctionDeclaration" ||
      t === "FunctionExpression" ||
      t === "ArrowFunctionExpression"
    ) {
      newLex = node;
      newVar = node;
      scopeSet(node);
      if (t === "FunctionExpression" && node.id)
        scopeSet(node).add(node.id.name);
      for (const p of node.params)
        for (const nm of namesOfPattern(p, [])) scopeSet(node).add(nm);
      // A function declaration binds its name in the ENCLOSING scope.
      if (t === "FunctionDeclaration" && node.id)
        scopeSet(lexScope).add(node.id.name);
    } else if (t === "ClassDeclaration" || t === "ClassExpression") {
      newLex = node;
      scopeSet(node);
      if (node.id) {
        scopeSet(node).add(node.id.name);
        if (t === "ClassDeclaration") scopeSet(lexScope).add(node.id.name);
      }
    } else if (t === "CatchClause") {
      newLex = node;
      scopeSet(node);
      if (node.param)
        for (const nm of namesOfPattern(node.param, []))
          scopeSet(node).add(nm);
    } else if (
      t === "ForStatement" ||
      t === "ForInStatement" ||
      t === "ForOfStatement"
    ) {
      const decl = t === "ForStatement" ? node.init : node.left;
      if (
        decl &&
        decl.type === "VariableDeclaration" &&
        (decl.kind === "let" || decl.kind === "const")
      ) {
        newLex = node;
        scopeSet(node);
        for (const d of decl.declarations)
          for (const nm of namesOfPattern(d.id, [])) scopeSet(node).add(nm);
      }
    }
    if (t === "VariableDeclaration") {
      const target = node.kind === "var" ? newVar : newLex;
      for (const d of node.declarations)
        for (const nm of namesOfPattern(d.id, [])) scopeSet(target).add(nm);
    }
    for (const k of Object.keys(node)) {
      if (k === "parent") continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (const c of v) buildScopes(c, newLex, newVar);
      } else if (v && typeof v === "object" && v.type) {
        buildScopes(v, newLex, newVar);
      }
    }
  };
  buildScopes(ast, null, null);

  // Is `name` shadowed by a nearer lexical binding at this reference?
  // Import bindings live at Program (module) scope; any declaration of the
  // name in a scope between the reference and Program shadows the import.
  const isShadowed = (name, node) => {
    let n = node.parent;
    while (n && n !== ast) {
      const st = scopeDecls.get(n);
      if (st && st.has(name)) return true;
      n = n.parent;
    }
    return false;
  };

  // True when this Identifier is a binding position rather than a value
  // reference (declaration id, function param, catch param, import/export
  // specifier, ...). Climbs through binding patterns to the declaration.
  const isBindingIdentifier = (node) => {
    let n = node;
    let p = node.parent;
    while (p) {
      if (
        (p.type === "VariableDeclarator" && p.id === n) ||
        ((p.type === "FunctionDeclaration" ||
          p.type === "FunctionExpression" ||
          p.type === "ArrowFunctionExpression") &&
          (p.id === n || p.params.indexOf(n) !== -1)) ||
        ((p.type === "ClassDeclaration" || p.type === "ClassExpression") &&
          p.id === n) ||
        (p.type === "CatchClause" && p.param === n) ||
        p.type === "ImportSpecifier" ||
        p.type === "ImportDefaultSpecifier" ||
        p.type === "ImportNamespaceSpecifier" ||
        p.type === "ExportSpecifier"
      )
        return true;
      if (p.type === "Property" && p.value === n) {
        n = p;
        p = p.parent;
        continue;
      }
      if (p.type === "ObjectPattern" || p.type === "ArrayPattern") {
        n = p;
        p = p.parent;
        continue;
      }
      if (
        (p.type === "RestElement" && p.argument === n) ||
        (p.type === "AssignmentPattern" && p.left === n)
      ) {
        n = p;
        p = p.parent;
        continue;
      }
      return false;
    }
    return false;
  };

  // True when the identifier is a non-computed property key, a label, or
  // part of `import.meta` — positions that never read the binding.
  const isNonReferencePosition = (node) => {
    const p = node.parent;
    if (!p) return true;
    if (
      p.type === "MetaProperty" ||
      p.type === "LabeledStatement" ||
      ((p.type === "BreakStatement" || p.type === "ContinueStatement") &&
        p.label === node)
    )
      return true;
    if (
      (p.type === "Property" || p.type === "MethodDefinition") &&
      p.key === node &&
      !p.computed &&
      !p.shorthand
    )
      return true;
    if (
      p.type === "PropertyDefinition" &&
      p.key === node &&
      !p.computed
    )
      return true;
    if (
      (p.type === "MemberExpression" ||
        p.type === "OptionalMemberExpression") &&
      p.property === node &&
      !p.computed
    )
      return true;
    return false;
  };

  // True when the reference WRITES the binding (`x = 1`, `x++`,
  // `for (x of ...)`). Assignment to an import binding is invalid ESM;
  // leaving the bare identifier (a ReferenceError — no binding exists)
  // preserves the "it throws" behavior instead of silently writing the
  // proxy's snapshot copy.
  const isWriteTarget = (node) => {
    let n = node;
    let p = node.parent;
    while (p) {
      if (p.type === "AssignmentExpression" && p.left === n) return true;
      if (
        p.type === "UpdateExpression" ||
        ((p.type === "ForInStatement" || p.type === "ForOfStatement") &&
          p.left === n)
      )
        return true;
      if (p.type === "Property" && p.value === n) {
        n = p;
        p = p.parent;
        continue;
      }
      if (p.type === "ObjectPattern" || p.type === "ArrayPattern") {
        n = p;
        p = p.parent;
        continue;
      }
      if (
        (p.type === "RestElement" && p.argument === n) ||
        (p.type === "AssignmentPattern" && p.left === n)
      ) {
        n = p;
        p = p.parent;
        continue;
      }
      return false;
    }
    return false;
  };

  walk.simple(ast, {
    Identifier(node) {
      const b = importBindingMap.get(node.name);
      if (!b) return;
      if (rangeIsEdited(node.start, node.end)) return;
      if (isBindingIdentifier(node)) return;
      if (isNonReferencePosition(node)) return;
      if (isShadowed(node.name, node)) return;
      if (isWriteTarget(node)) return;
      const p = node.parent;
      let replacement = `${b.liftedVar}.${b.importedName}`;
      if (p && p.type === "Property" && p.shorthand) {
        // `{ x }` -> `{ x: __lm_N.x }` (overwriting the shared key/value
        // identifier with a member expression alone would be a syntax
        // error). Acorn models the shorthand key and value as two distinct
        // nodes over the same range: rewrite on the key (visited first by
        // the naive walker; acorn-walk visits only the value) and let the
        // range guard skip the twin.
        replacement = `${node.name}: ${replacement}`;
      } else if (
        p &&
        ((p.type === "CallExpression" && p.callee === node) ||
          (p.type === "OptionalCallExpression" && p.callee === node) ||
          (p.type === "TaggedTemplateExpression" && p.tag === node))
      ) {
        // `x()` -> `(0, __lm_N.x)()`: the indirect call keeps `this`
        // undefined, matching ESM call semantics (a plain `__lm_N.x()`
        // would bind `this` to the interop proxy).
        replacement = `(0, ${replacement})`;
      }
      s.overwrite(node.start, node.end, replacement);
      editedRanges.push([node.start, node.end]);
    },
  });

  // Make functions async if needed
  for (const funcNode of functionsToMakeAsync) {
    //s.prependLeft(funcNode.start, "async ");
  }

  // --- Build the preamble for lifted modules ---
  // Split by lift kind: `import`-type lifts (entry static imports) are
  // hoisted by execute() to %%IMPORTS%% (init scope, as the old `custom`
  // preloads were); `require`-type lifts stay atop the user code, exactly
  // where the old preamble put them (they must load after init's timer
  // patching, not before). Namespace-import consts
  // (`const ns = __lm`) ride with the import lifts. In `code` the import
  // lifts come first — matching ESM evaluation order (imports before the
  // module body, requires included).
  const importPreambleParts = [];
  const bodyPreambleParts = [];
  for (const [modulePath, v] of liftedModules.entries()) {
    const type = moduleImportType.get(modulePath) || "import";
    const line =
      `const ${v} = await globalThis._RUNTIME${sandboxUUID}_.loadModule(${JSON.stringify(
        modulePath,
      )}, ${JSON.stringify(type)}, ${JSON.stringify(entryPoint)}, ${JSON.stringify(parentEntryPoint)});`;
    if (type === "import") importPreambleParts.push(line);
    else bodyPreambleParts.push(line);
  }

  for (const { node, liftedVar } of importBindings) {
    const binding = generateImportBinding(node, liftedVar);
    if (binding) importPreambleParts.push(binding);
  }

  const importPreamble = importPreambleParts.join("\n");
  const bodyPreamble =
    bodyPreambleParts.length > 0 ? bodyPreambleParts.join("\n") + "\n\n" : "";
  // `body`: require lifts + user code (what execute() runs as user code).
  const bodySrc = bodyPreamble + s.toString();
  if (importPreamble || bodyPreamble) {
    s.prepend((importPreamble ? importPreamble + "\n\n" : "") + bodyPreamble);
  }
  //console.log(preambleParts.join("\n") + "\n\n")
  const outCode = s.toString();
  const map = s.generateMap({
    source: entryPoint || "input.js",
    hires: false, // line-level maps: hires VLQ explodes on MB-size inputs (74MB mappings for 16MB source), blocking the main thread; line-level suffices for stack traces,
    includeContent: true,
  });
  // preamble/body split: execute() hoists the *import* preamble (the
  // `await loadModule(...)` lifts for static imports, plus namespace consts)
  // to the sandbox init scope (%%IMPORTS%%) and runs `body` (require lifts +
  // user code) as the user code. Both share the sandbox IIFE scope, so the
  // live member access (`__lm_N.x`) in the body resolves to the preamble's
  // lifted vars. `code` (full preamble + body) is unchanged for all
  // existing consumers.
  return {
    code: outCode,
    map,
    preamble: importPreamble,
    body: bodySrc,
  };
}

export function generateImportBinding(node, liftedVar) {
  const specifiers = node.specifiers;

  if (!specifiers.length) return "";

  // Namespace imports keep a live alias: `const ns = __lm` (the proxy read
  // is live once buildModuleProxy reads from the real namespace).
  // Named/default imports emit NO binding: every reference was rewritten to
  // `liftedVar.importedName` (live member access, the esbuild/rollup
  // pattern). The old `const { x } = __lm` destructured once at import time
  // — a snapshot that killed live bindings.
  for (const s of specifiers) {
    if (s.type === "ImportNamespaceSpecifier")
      return `const ${s.local.name} = ${liftedVar};`;
  }
  return "";
}
