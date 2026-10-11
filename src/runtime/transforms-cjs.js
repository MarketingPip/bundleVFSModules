// Extracted from runtime.js (lines 802-1431) — Worker B, modular/transforms.
// DO NOT EDIT by hand: re-extract from runtime.js. Code is byte-identical
// to the original except: top-level `export` keywords added, imports use
// bare specifiers (browser resolves via the same esm.sh packages; Node
// tests resolve via node_modules).
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import MagicString from "magic-string";
// Moved to module top from its mid-file position (runtime.js line 1371).
import { walk as walker } from "estree-walker";

export function convertCjsToEsm(code, options = {}) {
  const { filename = "input.js" } = options;
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  const s = new MagicString(code, { filename });

  let lastModuleExport = null;
  const exportsProps = [];
  const deadZones = [];
  const exportStars = [];
  const exportsReads = [];
  const esModuleMarkers = [];

  // Pass 1: detect module.exports, exports.*, and __exportStar
  walk.ancestor(ast, {
    AssignmentExpression(node, ancestors) {
      const isTopLevel = !ancestors.some((a) =>
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ].includes(a.type),
      );
      if (!isTopLevel) return;

      const { left } = node;

      // module.exports = ...
      if (left.object?.name === "module" && left.property?.name === "exports") {
        if (lastModuleExport) {
          // previous module.exports is dead
          deadZones.push({
            start: lastModuleExport.start,
            end: lastModuleExport.end,
          });
        }
        lastModuleExport = node;
      }
      // exports.prop = ...
      else if (left.object?.name === "exports") {
        const propName = left.property?.name;
        // TypeScript placeholder: 'exports.X = void 0;' emitted before the
        // real definition. Removed below when a later assignment exists.
        const isVoid0 =
          node.right.type === "UnaryExpression" &&
          node.right.operator === "void" &&
          node.right.argument.type === "Literal" &&
          node.right.argument.value === 0;
        // Self-reference: 'exports.X = X;' re-exports a local binding.
        const isSelfRef =
          node.right.type === "Identifier" && node.right.name === propName;
        exportsProps.push({ node, name: propName, isVoid0, isSelfRef });
      }
    },
    // TypeScript 'export *' in CJS: __exportStar(require("x"), exports).
    // Rewritten to ESM 'export * from "x"' below; the downstream
    // transformImportsToLoadModule lifts it through loadModule().
    CallExpression(node, ancestors) {
      const isTopLevel = !ancestors.some((a) =>
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ].includes(a.type),
      );
      if (!isTopLevel) return;
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "__exportStar" &&
        node.arguments.length === 2 &&
        node.arguments[0].type === "CallExpression" &&
        node.arguments[0].callee.type === "Identifier" &&
        node.arguments[0].callee.name === "require" &&
        node.arguments[0].arguments.length === 1 &&
        node.arguments[0].arguments[0].type === "Literal" &&
        typeof node.arguments[0].arguments[0].value === "string" &&
        node.arguments[1].type === "Identifier" &&
        node.arguments[1].name === "exports"
      ) {
        exportStars.push({
          node,
          path: node.arguments[0].arguments[0].value,
        });
      }
      // TypeScript's __esModule marker: Object.defineProperty(exports,
      // "__esModule", { value: true }). Meaningless in ESM; drop it.
      if (
        node.callee.type === "MemberExpression" &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Object" &&
        node.callee.property.type === "Identifier" &&
        node.callee.property.name === "defineProperty" &&
        node.arguments.length >= 2 &&
        node.arguments[0].type === "Identifier" &&
        node.arguments[0].name === "exports" &&
        node.arguments[1].type === "Literal" &&
        node.arguments[1].value === "__esModule"
      ) {
        // ancestors includes the node itself as the last element.
        const stmt = ancestors[ancestors.length - 2];
        if (stmt && stmt.type === "ExpressionStatement") {
          esModuleMarkers.push(stmt);
        }
      }
    },
    // Reads of the CJS exports object: 'exports.X' (not an assignment
    // target). In the ESM output there is no 'exports' binding, so rewrite
    // to the local/exported binding 'X' (or 'undefined' when X is not a
    // known export, matching CJS read-before-assign semantics). Skipped when
    // 'exports' is shadowed (e.g. the __exportStar helper's parameter).
    MemberExpression(node, ancestors) {
      if (
        node.object.type !== "Identifier" ||
        node.object.name !== "exports" ||
        node.computed ||
        node.property.type !== "Identifier"
      ) {
        return;
      }
      // ancestors includes the node itself as the last element; the parent
      // is second-to-last.
      const parent = ancestors[ancestors.length - 2];
      if (parent.type === "AssignmentExpression" && parent.left === node) {
        return;
      }
      const shadowed = ancestors.some(
        (a) =>
          (a.type === "FunctionDeclaration" ||
            a.type === "FunctionExpression" ||
            a.type === "ArrowFunctionExpression") &&
          a.params.some((p) => p.type === "Identifier" && p.name === "exports"),
      );
      if (shadowed) return;
      exportsReads.push({ node, name: node.property.name });
    },
  });

  // Pass 2: remove dead module.exports
  deadZones.forEach((zone) => {
    s.remove(zone.start, zone.end + (code[zone.end] === ";" ? 1 : 0));
  });

  // Remove exports.* only if there’s a module.exports assignment (module.exports wins)
  if (lastModuleExport) {
    exportsProps.forEach((exp) => {
      s.remove(
        exp.node.start,
        exp.node.end + (code[exp.node.end] === ";" ? 1 : 0),
      );
    });
  }

  // Pass 3: transform the last module.exports to default
  const declared = new Set();
  if (lastModuleExport) {
    s.overwrite(
      lastModuleExport.start,
      lastModuleExport.right.start,
      "export default ",
    );
  }
  // Otherwise, transform exports.* to named exports
  else {
    // Group by export name to handle TypeScript's multi-assignment patterns:
    // 'exports.X = void 0' (placeholder) and 'exports.X = X' (local re-export).
    const byName = new Map();
    for (const exp of exportsProps) {
      if (!byName.has(exp.name)) byName.set(exp.name, []);
      byName.get(exp.name).push(exp);
    }
    const removeNode = (node) => {
      s.remove(node.start, node.end + (code[node.end] === ";" ? 1 : 0));
    };
    for (const [, props] of byName) {
      const realProps = props.filter((p) => !p.isVoid0);
      // Drop void-0 placeholders when a real assignment follows.
      if (realProps.length > 0) {
        for (const p of props) {
          if (p.isVoid0) removeNode(p.node);
        }
      }
      const effective = realProps.length > 0 ? realProps : props;
      for (const exp of effective) {
        if (exp.isSelfRef) {
          if (declared.has(exp.name)) {
            // Already exported; 'exports.X = X' is a no-op.
            removeNode(exp.node);
          } else {
            // Re-export the local binding X.
            s.overwrite(
              exp.node.start,
              exp.node.end,
              `export { ${exp.name} };`,
            );
            declared.add(exp.name);
          }
        } else if (!declared.has(exp.name)) {
          s.overwrite(
            exp.node.start,
            exp.node.right.start,
            `export const ${exp.name} = `,
          );
          declared.add(exp.name);
        } else {
          // Reassignment of an already-exported binding (live binding update).
          s.overwrite(exp.node.start, exp.node.right.start, `${exp.name} = `);
        }
      }
    }
  }

  // Pass 3b: rewrite 'exports.X' reads (no 'exports' binding in ESM).
  // X → the exported/local binding when known, else 'undefined' (CJS
  // read-before-assign / discarded-exports semantics).
  for (const read of exportsReads) {
    s.overwrite(
      read.node.start,
      read.node.end,
      declared.has(read.name) ? read.name : "undefined",
    );
  }

  // Pass 3c: drop TypeScript's __esModule marker (meaningless in ESM).
  for (const stmt of esModuleMarkers) {
    s.remove(stmt.start, stmt.end + (code[stmt.end] === ";" ? 1 : 0));
  }

  // Pass 4: __exportStar(require("x"), exports) → export * from "x".
  // The ESM star-export is resolved downstream by transformImportsToLoadModule
  // (ExportAllDeclaration) through loadModule(); buildModuleProxy re-exports
  // the lifted namespace, skipping 'default' per ESM semantics.
  for (const star of exportStars) {
    s.overwrite(
      star.node.start,
      star.node.end,
      `export * from ${JSON.stringify(star.path)};`,
    );
  }

  const outCode = s.toString();
  const map = s.generateMap({
    source: filename,
    hires: false, // line-level maps: hires VLQ explodes on MB-size inputs (74MB mappings for 16MB source), blocking the main thread; line-level suffices for stack traces,
    includeContent: true,
  });
  // Mark CJS-converted modules so the sandbox's ESM interop (buildModuleProxy)
  // can resolve named imports against module.exports — Node's cjs-module-lexer
  // parity. Without this, 'import { build } from "esbuild"' (a CJS shim)
  // throws "does not provide an export named 'build'".
  const converted = lastModuleExport !== null || exportsProps.length > 0;
  const finalCode = converted
    ? outCode + "\nexport const __bvm_cjs__ = true;\n"
    : outCode;
  return { code: finalCode, map };
}


export function convertCjsToEsm_backup(code) {
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  const s = new MagicString(code);

  let lastModuleExport = null;
  const requires = [];
  const deadZones = []; // Ranges of code that are orphaned exports

  // Pass 1: Find the "Winner" and identify orphaned exports
  walk.ancestor(ast, {
    /* CallExpression(node) {
      if (node.callee.name === 'require' && node.arguments[0]?.type === 'Literal') {
        requires.push(node);
      }
    },*/
    AssignmentExpression(node, ancestors) {
      const isTopLevel = !ancestors.some((a) =>
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ].includes(a.type),
      );
      if (!isTopLevel) return;

      const { left } = node;

      // module.exports = ...
      if (left.object?.name === "module" && left.property?.name === "exports") {
        if (lastModuleExport) {
          // The previous module.export is now dead code (orphaned)
          deadZones.push({
            start: lastModuleExport.start,
            end: lastModuleExport.end,
          });
        }
        lastModuleExport = node;
      }
      // exports.prop = ...
      else if (left.object?.name === "exports") {
        // These are orphaned if they happen before OR after a full module.exports replacement
        deadZones.push({ start: node.start, end: node.end });
      }
    },
  });

  // Pass 2: Transformation

  // 1. Convert Requires
  requires.forEach((req) => {
    // Check if it's a standalone expression statement
    s.overwrite(req.start, req.end, `import ${req.arguments[0].raw}`);
  });

  // 2. Remove all "Dead" assignments
  deadZones.forEach((zone) => {
    // We remove the whole statement (including trailing semicolon if possible)
    s.remove(zone.start, zone.end + (code[zone.end] === ";" ? 1 : 0));
  });

  // 3. Transform the "Winner"
  if (lastModuleExport) {
    s.overwrite(
      lastModuleExport.start,
      lastModuleExport.right.start,
      "export default ",
    );
  }

  return s
    .toString()
    .trim()
    .replace(/\n\s*\n/g, "\n"); // Clean up empty lines
}


export function _convertCjsToEsm(code) {
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  let offset = 0;
  let newCode = code;

  // Helper to replace code fragments accurately
  function replace(start, end, replacement) {
    const adjustedStart = start + offset;
    const adjustedEnd = end + offset;
    newCode =
      newCode.slice(0, adjustedStart) +
      replacement +
      newCode.slice(adjustedEnd);
    offset += replacement.length - (end - start);
  }

  // Walk the AST
  function walk(node) {
    if (!node) return;

    if (node.type === "AssignmentExpression") {
      const { left, right } = node;

      // Pattern 1: module.exports = ...
      if (
        left.type === "MemberExpression" &&
        left.object.name === "module" &&
        left.property.name === "exports"
      ) {
        // Replace 'module.exports =' with 'export default'
        replace(node.start, right.start, "export default ");
      }

      // Pattern 2: exports.name = ...
      else if (
        left.type === "MemberExpression" &&
        left.object.name === "exports"
      ) {
        const propName = left.property.name;
        // Replace 'exports.name =' with 'export const name ='
        replace(node.start, right.start, `export const ${propName} = `);
      }
    }

    // Standard recursive walk
    for (const key in node) {
      if (node[key] && typeof node[key] === "object") {
        if (Array.isArray(node[key])) {
          node[key].forEach(walk);
        } else {
          walk(node[key]);
        }
      }
    }
  }

  walk(ast);
  return newCode;
}


export function isCommonJS(code) {
  try {
    const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
    let hasCJS = false;

    // Recursive function to walk the AST
    function walk(node) {
      if (!node || hasCJS) return;

      // Check for 'require(...)'
      if (node.type === "CallExpression" && node.callee.name === "require") {
        hasCJS = true;
      }

      // Check for 'module.exports' or 'exports.foo'
      if (node.type === "AssignmentExpression") {
        const { left } = node;
        if (
          (left.object &&
            left.object.name === "module" &&
            left.property.name === "exports") ||
          left.name === "exports" ||
          (left.object && left.object.name === "exports")
        ) {
          hasCJS = true;
        }
      }

      // Traverse children
      for (const key in node) {
        if (node[key] && typeof node[key] === "object") {
          if (Array.isArray(node[key])) {
            node[key].forEach(walk);
          } else {
            walk(node[key]);
          }
        }
      }
    }

    walk(ast);
    return hasCJS;
  } catch (err) {
    console.error("Parsing failed:", err.message);
    return false;
  }
}


export function detectModuleSystem(code) {
  let result = { isCJS: false, isESM: false };

  try {
    // We parse as 'module' to allow import/export statements
    const ast = acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: "module",
    });

    function walk(node, parent) {
      if (!node) return;

      // --- ESM DETECTION ---
      // Look for 'import ...' or 'export ...'
      if (
        node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportDefaultDeclaration" ||
        node.type === "ExportAllDeclaration"
      ) {
        result.isESM = true;
      }

      // --- CJS DETECTION ---
      // Check for 'require(...)'
      if (node.type === "CallExpression" && node.callee.name === "require") {
        result.isCJS = true;
      }

      // Check for 'module.exports' or 'exports'
      if (node.type === "AssignmentExpression") {
        const { left } = node;
        const isModuleExports =
          left.object?.name === "module" && left.property?.name === "exports";
        const isExports =
          left.name === "exports" || left.object?.name === "exports";

        if (isModuleExports || isExports) {
          result.isCJS = true;
        }
      }

      // Check for bare `exports` references (not just assignments), e.g.
      // TypeScript's Object.defineProperty(exports, "__esModule", ...) marker,
      // which tsc emits in every compiled file — including files with no
      // exports at all. A free `exports` identifier only occurs in CJS output.
      // Excludes property keys ({ exports: 1 }), member properties (a.exports),
      // and declared bindings (var/function/import named exports).
      if (
        node.type === "Identifier" &&
        node.name === "exports" &&
        !isExportsPropertyOrBinding(node, parent)
      ) {
        result.isCJS = true;
      }

      // Standard AST traversal
      for (const key in node) {
        const child = node[key];
        if (child && typeof child === "object") {
          if (Array.isArray(child)) {
            child.forEach((c) => walk(c, node));
          } else {
            walk(child, node);
          }
        }
      }
    }

    // True when an `exports` Identifier is a property key/member name or a
    // locally declared binding rather than the CJS free variable.
    function isExportsPropertyOrBinding(node, parent) {
      if (!parent) return false;
      if (parent.type === "Property" && parent.key === node && !parent.computed)
        return true;
      if (
        parent.type === "MemberExpression" &&
        parent.property === node &&
        !parent.computed
      )
        return true;
      if (parent.type === "VariableDeclarator" && parent.id === node)
        return true;
      if (
        (parent.type === "FunctionDeclaration" ||
          parent.type === "FunctionExpression" ||
          parent.type === "ArrowFunctionExpression") &&
        parent.params.includes(node)
      )
        return true;
      if (
        (parent.type === "FunctionDeclaration" ||
          parent.type === "FunctionExpression" ||
          parent.type === "ClassDeclaration" ||
          parent.type === "ClassExpression") &&
        parent.id === node
      )
        return true;
      if (
        (parent.type === "ImportSpecifier" ||
          parent.type === "ImportDefaultSpecifier" ||
          parent.type === "ImportNamespaceSpecifier") &&
        parent.local === node
      )
        return true;
      if (parent.type === "CatchClause" && parent.param === node) return true;
      return false;
    }

    walk(ast);
  } catch (err) {
    console.error("Syntax Error or Parsing failed:", err.message);
  }

  return result;
}

/**
 * Transforms static and dynamic module loading calls into `loadModule(...)`.
 *
 * Specifically:
 * - Rewrites `import('./path')` → `loadModule('./path')`
 * - Rewrites `require('./path')` → `loadModule('./path')`
 * - Only affects relative paths (`./` or `../`)
 *
 * @param {string} code
 *   JavaScript source code to transform.
 *
 * @returns {string}
 *   The transformed source code with matching imports replaced.
 */
export function transformRelativeModule(code) {
  const s = new MagicString(code);
  const ast = acorn.parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
  });

  walker(ast, {
    enter(node) {
      let sourceNode = null;
      let startIdx = null;
      let endIdx = null;
      let type = "";

      // 1. Match dynamic import('./path')
      if (node.type === "ImportExpression") {
        sourceNode = node.source;
        startIdx = node.start;
        endIdx = node.start + 6; // length of 'import'
        type = "import";
      }

      // 2. Match require('./path')
      else if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "require" && // Corrected from !=
        node.arguments.length === 1
      ) {
        sourceNode = node.arguments[0];
        startIdx = node.callee.start;
        endIdx = node.callee.end; // length of 'require'
        type = "require";
      }

      // 3. Transformation Logic
      if (
        sourceNode &&
        sourceNode.type === "Literal" &&
        typeof sourceNode.value === "string" &&
        type != "require"
      ) {
        const path = sourceNode.value;

        // Only transform relative paths
        if (path.startsWith("./") || path.startsWith("../")) {
          // Change the function name to loadModule
          s.overwrite(startIdx, endIdx, "loadModule");

          // Inject the type as the second argument
          // sourceNode.end is the end of the path string
          s.appendRight(sourceNode.end, `, '${type}'`);
        }
      }
    },
  });

  return s.toString();
}
