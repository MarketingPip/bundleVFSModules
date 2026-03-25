 
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import { convertEsmToCjs, convertCjsToEsm } from '../src/runtime/transformModules.js';


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
    expect(cjs).toContain('exports.x = _tmp_');
    expect(cjs).toContain('exports.z = _tmp_');
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
 

