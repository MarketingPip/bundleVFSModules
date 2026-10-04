// Tests for `imports` field (`#` specifiers) in src/module.js — the CJS
// sync-require path. Node's PACKAGE_IMPORTS_RESOLVE: `#alias` resolves via
// the nearest parent package.json's `imports` field.
//
// Red-first: these fail until _findPath handles `#` specifiers.
import * as shim from "../src/module.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { Module } = shim;

const tmpDirs = [];
function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-imports-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// Set up a package with an `imports` field, return the dir.
function makeImportsPackage() {
  const dir = makeTmp();
  writeFile(
    dir,
    "package.json",
    JSON.stringify({
      name: "imports-test-pkg",
      imports: {
        "#utils": "./src/utils.js",
        "#config": "./config/index.js",
        "#lib/*": "./lib/*.js",
        "#cond": {
          node: "./node.js",
          default: "./default.js",
        },
      },
    }),
  );
  writeFile(dir, "src/utils.js", "module.exports = { name: 'utils' };");
  writeFile(dir, "config/index.js", "module.exports = { name: 'config' };");
  writeFile(dir, "lib/helper.js", "module.exports = { name: 'helper' };");
  writeFile(dir, "node.js", "module.exports = { name: 'node-cond' };");
  writeFile(dir, "default.js", "module.exports = { name: 'default-cond' };");
  writeFile(dir, "app/main.js", "// importer\n");
  return dir;
}

describe("imports field (# specifiers)", () => {
  test("#utils resolves via imports field", () => {
    const dir = makeImportsPackage();
    const parentFile = path.join(dir, "app", "main.js");
    // Module._findPath with parent paths derived from the importer
    const paths = Module._nodeModulePaths(path.dirname(parentFile));
    const resolved = Module._findPath("#utils", paths, false);
    expect(resolved).toBeTruthy();
    expect(resolved.endsWith("src/utils.js")).toBe(true);
  });

  test("#config resolves nested target", () => {
    const dir = makeImportsPackage();
    const parentFile = path.join(dir, "app", "main.js");
    const paths = Module._nodeModulePaths(path.dirname(parentFile));
    const resolved = Module._findPath("#config", paths, false);
    expect(resolved).toBeTruthy();
    expect(resolved.endsWith("config/index.js")).toBe(true);
  });

  test("#lib/* pattern resolves", () => {
    const dir = makeImportsPackage();
    const parentFile = path.join(dir, "app", "main.js");
    const paths = Module._nodeModulePaths(path.dirname(parentFile));
    const resolved = Module._findPath("#lib/helper", paths, false);
    expect(resolved).toBeTruthy();
    expect(resolved.endsWith("lib/helper.js")).toBe(true);
  });

  test("#cond picks node condition", () => {
    const dir = makeImportsPackage();
    const parentFile = path.join(dir, "app", "main.js");
    const paths = Module._nodeModulePaths(path.dirname(parentFile));
    const resolved = Module._findPath("#cond", paths, false);
    expect(resolved).toBeTruthy();
    // CJS resolver uses ["node", "require", "default"] — node wins
    expect(resolved.endsWith("node.js")).toBe(true);
  });

  test("unmapped # specifier throws ERR_PACKAGE_IMPORT_NOT_DEFINED", () => {
    const dir = makeImportsPackage();
    const parentFile = path.join(dir, "app", "main.js");
    const paths = Module._nodeModulePaths(path.dirname(parentFile));
    let code = null;
    try {
      Module._findPath("#missing", paths, false);
    } catch (e) {
      code = e.code;
    }
    expect(code).toBe("ERR_PACKAGE_IMPORT_NOT_DEFINED");
  });

  test("# specifier with no imports field throws ERR_PACKAGE_IMPORT_NOT_DEFINED", () => {
    const dir = makeTmp();
    writeFile(dir, "package.json", JSON.stringify({ name: "no-imports" }));
    writeFile(dir, "app/main.js", "// importer\n");
    const parentFile = path.join(dir, "app", "main.js");
    const paths = Module._nodeModulePaths(path.dirname(parentFile));
    let code = null;
    try {
      Module._findPath("#utils", paths, false);
    } catch (e) {
      code = e.code;
    }
    expect(code).toBe("ERR_PACKAGE_IMPORT_NOT_DEFINED");
  });
});
