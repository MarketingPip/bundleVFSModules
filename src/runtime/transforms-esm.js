// Extracted from runtime.js (lines 688-801) — Worker B, modular/transforms.
// DO NOT EDIT by hand: re-extract from runtime.js. Code is byte-identical
// to the original except: top-level `export` keywords added, imports use
// bare specifiers (browser resolves via the same esm.sh packages; Node
// tests resolve via node_modules).
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import MagicString from "magic-string";

export function convertEsmToCjs(code, options = {}) {
  const { filename = "input.js" } = options;
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
  const s = new MagicString(code, { filename });

  walk.ancestor(ast, {
    // 1. Convert import statements
    ImportDeclaration(node) {
      const source = node.source.raw;
      const specifiers = node.specifiers;

      if (specifiers.length === 0) {
        // Bare import: import 'setup.js' -> require('setup.js');
        s.overwrite(node.start, node.end, `require(${source});`);
      } else {
        const parts = specifiers.map((spec) => {
          if (
            spec.type === "ImportDefaultSpecifier" ||
            spec.type === "ImportNamespaceSpecifier"
          ) {
            return spec.local.name; // import x from 'y' || import * as x from 'y'
          } else {
            // Named import { a as b } -> { a: b }
            return spec.imported.name === spec.local.name
              ? spec.local.name
              : `${spec.imported.name}: ${spec.local.name}`;
          }
        });

        const isDestructured = specifiers.some(
          (s) => s.type === "ImportSpecifier",
        );
        const importStr = isDestructured ? `{ ${parts.join(", ")} }` : parts[0];
        s.overwrite(
          node.start,
          node.end,
          `const ${importStr} = require(${source});`,
        );
      }
    },

    // 2. Convert default export
    ExportDefaultDeclaration(node) {
      if (node.declaration.id) {
        // Named function/class: export default function foo() {} -> module.exports = foo
        s.remove(node.start, node.declaration.start);
        s.appendLeft(
          node.end,
          `\nmodule.exports = ${node.declaration.id.name};`,
        );
      } else {
        // Anonymous default: export default 42 -> module.exports = 42
        s.overwrite(node.start, node.declaration.start, "module.exports = ");
      }
    },

    // 3. Convert named exports
    ExportNamedDeclaration(node) {
      if (node.declaration) {
        // Handle variables, functions, classes
        s.remove(node.start, node.declaration.start);

        if (node.declaration.type === "VariableDeclaration") {
          node.declaration.declarations.forEach((decl) => {
            s.appendRight(
              node.end,
              `\nexports.${decl.id.name} = ${decl.id.name};`,
            );
          });
        } else if (node.declaration.id) {
          s.appendRight(
            node.end,
            `\nexports.${node.declaration.id.name} = ${node.declaration.id.name};`,
          );
        }
      } else if (node.specifiers.length) {
        // export { x, y as z };
        const parts = node.specifiers
          .map((spec) => {
            const exported = spec.exported.name;
            const local = spec.local.name;
            return `exports.${exported} = ${local};`;
          })
          .join("\n");
        s.overwrite(node.start, node.end, parts);
      } else if (node.source) {
        // export * from './file.js';
        s.overwrite(
          node.start,
          node.end,
          `Object.assign(exports, require(${node.source.raw}));`,
        );
      }
    },

    // 4. Export all (catch re-exports)
    ExportAllDeclaration(node) {
      s.overwrite(
        node.start,
        node.end,
        `Object.assign(exports, require(${node.source.raw}));`,
      );
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

