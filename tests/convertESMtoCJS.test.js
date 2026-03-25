 
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';


import MagicString from "https://esm.sh/magic-string";

import * as walk from "https://esm.sh/acorn-walk";
import * as acorn from "https://esm.sh/acorn";


export function convertEsmToCjs(code) {
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
  const s = new MagicString(code);

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
          (s) => s.type === "ImportSpecifier"
        );
        const importStr = isDestructured ? `{ ${parts.join(", ")} }` : parts[0];
        s.overwrite(
          node.start,
          node.end,
          `const ${importStr} = require(${source});`
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
          `\nmodule.exports = ${node.declaration.id.name};`
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
              `\nexports.${decl.id.name} = ${decl.id.name};`
            );
          });
        } else if (node.declaration.id) {
          s.appendRight(
            node.end,
            `\nexports.${node.declaration.id.name} = ${node.declaration.id.name};`
          );
        }
      } else if (node.specifiers.length && node.source) {
        // import the module first
        const temp = `_tmp_${Math.random().toString(36).slice(2, 8)}`;
        const imports = `const ${temp} = require(${node.source.raw});\n`;
        const exportsStr = node.specifiers
          .map((spec) => {
            const exported = spec.exported.name;
            const local = spec.local.name;
            return `exports.${exported} = ${temp}.${local};`;
          })
          .join("\n");
        s.overwrite(node.start, node.end, imports + exportsStr);
      }
    },

    // 4. Export all (catch re-exports)
    ExportAllDeclaration(node) {
      s.overwrite(
        node.start,
        node.end,
        `Object.assign(exports, require(${node.source.raw}));`
      );
    }
  });

  return s.toString().trim();
}

export function convertCjsToEsm(code) {
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  const s = new MagicString(code);

  let lastModuleExport = null;
  const exportsProps = [];
  const deadZones = [];

  // Pass 1: detect module.exports and exports.*
  walk.ancestor(ast, {
    AssignmentExpression(node, ancestors) {
      const isTopLevel = !ancestors.some((a) =>
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression"
        ].includes(a.type)
      );
      if (!isTopLevel) return;

      const { left } = node;

      // module.exports = ...
      if (left.object?.name === "module" && left.property?.name === "exports") {
        if (lastModuleExport) {
          // previous module.exports is dead
          deadZones.push({
            start: lastModuleExport.start,
            end: lastModuleExport.end
          });
        }
        lastModuleExport = node;
      }
      // exports.prop = ...
      else if (left.object?.name === "exports") {
        exportsProps.push({ node, name: left.property.name });
      }
    }
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
        exp.node.end + (code[exp.node.end] === ";" ? 1 : 0)
      );
    });
  }

  // Pass 3: transform the last module.exports to default
  if (lastModuleExport) {
    s.overwrite(
      lastModuleExport.start,
      lastModuleExport.right.start,
      "export default "
    );
  }
  // Otherwise, transform exports.* to named exports
  else {
    exportsProps.forEach((exp) => {
      s.overwrite(
        exp.node.start,
        exp.node.right.start,
        `export const ${exp.name} = `
      );
    });
  }

  return s
    .toString()
    .trim()
    .replace(/\n\s*\n/g, "\n"); // clean empty lines
}

describe("convertEsmToCjs", () => {
  test("converts default export of a literal", () => {
    const code = `export default 42;`;
    const cjs = convertEsmToCjs(code);
    expect(cjs).toBe("module.exports = 42;");
  });

  test("converts default export of a named function", () => {
    const code = `export default function foo() {}`;
    const cjs = convertEsmToCjs(code);
    expect(cjs).toContain("module.exports = foo;");
  });

  test("converts named export of variable", () => {
    const code = `export const a = 1, b = 2;`;
    const cjs = convertEsmToCjs(code);
    expect(cjs).toContain("exports.a = a;");
    expect(cjs).toContain("exports.b = b;");
  });

  test("converts named export of function", () => {
    const code = `export function bar() {}`;
    const cjs = convertEsmToCjs(code);
    expect(cjs).toContain("exports.bar = bar;");
  });

  test("converts import statements (default, named, namespace, bare)", () => {
    const code = `
      import x from 'mod1';
      import { a, b as c } from 'mod2';
      import * as ns from 'mod3';
      import 'setup';
    `;
    const cjs = convertEsmToCjs(code);

    expect(cjs).toContain(`const x = require('mod1');`);
    expect(cjs).toContain(`const { a, b: c } = require('mod2');`);
    expect(cjs).toContain(`const ns = require('mod3');`);
    expect(cjs).toContain(`require('setup');`);
  });

  test("converts export all and re-export", () => {
    const code = `
      export * from './lib.js';
      export { x, y as z } from './lib2.js';
    `;
    const cjs = convertEsmToCjs(code);
    expect(cjs).toContain(`Object.assign(exports, require('./lib.js'));`);
    expect(cjs).toContain(`exports.x = x;`);
    expect(cjs).toContain(`exports.z = y;`);
  });
});

describe("convertCjsToEsm", () => {
  test("converts module.exports = literal to default export", () => {
    const code = `module.exports = 42;`;
    const esm = convertCjsToEsm(code);
    expect(esm).toBe("export default 42;");
  });

  test("converts module.exports = named function to default export", () => {
    const code = `function foo() {}\nmodule.exports = foo;`;
    const esm = convertCjsToEsm(code);
    expect(esm).toContain("export default foo;");
  });

  test("converts exports properties to named exports if no module.exports", () => {
    const code = `exports.a = 1;\nexports.b = 2;`;
    const esm = convertCjsToEsm(code);

    expect(esm).toContain("export const a = 1;");
    expect(esm).toContain("export const b = 2;");
  });

  test("removes previous module.exports if overwritten", () => {
    const code = `
      module.exports = { a: 1 };
      module.exports = { b: 2 };
    `;
    const esm = convertCjsToEsm(code);

    expect(esm).not.toContain("{ a: 1 }");
    expect(esm).toContain("export default { b: 2 };");
  });

  test("removes exports.* if module.exports is used", () => {
    const code = `
      exports.a = 1;
      module.exports = 42;
    `;
    const esm = convertCjsToEsm(code);

    expect(esm).not.toContain("exports.a");
    expect(esm).toContain("export default 42;");
  });
});
 

