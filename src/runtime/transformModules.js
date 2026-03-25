import MagicString from "magic-string";

import {ancestor} from "acorn-walk";
import {parse} from "acorn";  


export function convertEsmToCjs(code) {
  const ast = parse(code, { ecmaVersion: 2022, sourceType: "module" });
  const s = new MagicString(code);

  // Pre-scan: detect if there are BOTH a default export and named exports
  const hasDefault = ast.body.some(n => n.type === "ExportDefaultDeclaration");
  const hasNamed = ast.body.some(
    n => n.type === "ExportNamedDeclaration" && (n.declaration || n.specifiers.length)
  );
  const mixed = hasDefault && hasNamed;

  ancestor(ast, {
    // 1. Convert import statements
    ImportDeclaration(node) {
      const source = node.source.raw;
      const specifiers = node.specifiers;

      if (specifiers.length === 0) {
        s.overwrite(node.start, node.end, `require(${source});`);
      } else {
        const parts = specifiers.map((spec) => {
          if (
            spec.type === "ImportDefaultSpecifier" ||
            spec.type === "ImportNamespaceSpecifier"
          ) {
            return spec.local.name;
          } else {
            return spec.imported.name === spec.local.name
              ? spec.local.name
              : `${spec.imported.name}: ${spec.local.name}`;
          }
        });

        const isDestructured = specifiers.some(
          (s) => s.type === "ImportSpecifier"
        );
        const importStr = isDestructured ? `{ ${parts.join(", ")} }` : parts[0];
        s.overwrite(node.start, node.end, `const ${importStr} = require(${source});`);
      }
    },

    // 2. Convert default export
    ExportDefaultDeclaration(node) {
      if (mixed) {
        // In mixed mode, emit exports.default = ... instead of module.exports =
        if (node.declaration.id) {
          s.remove(node.start, node.declaration.start);
          s.appendLeft(node.end, `\nexports.default = ${node.declaration.id.name};`);
        } else {
          s.overwrite(node.start, node.declaration.start, "exports.default = ");
        }
      } else {
        if (node.declaration.id) {
          s.remove(node.start, node.declaration.start);
          s.appendLeft(node.end, `\nmodule.exports = ${node.declaration.id.name};`);
        } else {
          s.overwrite(node.start, node.declaration.start, "module.exports = ");
        }
      }
    },

    // 3. Convert named exports
    ExportNamedDeclaration(node) {
      if (node.declaration) {
        s.remove(node.start, node.declaration.start);

        if (node.declaration.type === "VariableDeclaration") {
          node.declaration.declarations.forEach((decl) => {
            s.appendRight(node.end, `\nexports.${decl.id.name} = ${decl.id.name};`);
          });
        } else if (node.declaration.id) {
          s.appendRight(node.end, `\nexports.${node.declaration.id.name} = ${node.declaration.id.name};`);
        }
      } else if (node.specifiers.length && node.source) {
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

    // 4. Export all
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
  const ast = parse(code, { ecmaVersion: 2022, sourceType: "script" });
  const s = new MagicString(code);

  let lastModuleExport = null;
  const exportsProps = [];
  const deadZones = [];

  // Pass 1: detect module.exports and exports.*
  ancestor(ast, {
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
