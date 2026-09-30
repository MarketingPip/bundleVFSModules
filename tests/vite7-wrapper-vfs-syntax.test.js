import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

// Regression: `SyntaxError: RUNTIME ERROR: Unexpected token (883:26)` broke
// EVERY sandbox execute() on main after 18f71c4b.
//
// Root cause: vfsPackagePathNotExported / vfsPackageImportNotDefined live
// INSIDE SandboxRuntime.generate()'s template literal in runtime.js, so their
// source text is template-cooked before it becomes the sandbox wrapper. A
// single `\"` in the template cooks to a bare `"` in the generated wrapper,
// terminating the double-quoted error-message string early -> the wrapper
// itself fails to parse (883:26), and execute() rejects with the
// "RUNTIME ERROR"-prefixed SyntaxError.
//
// This test cooks the exact shipped template text the same way generate()
// does and acorn-parses the result, pinning the defect class (template-escape
// loss in the wrapper) without needing a browser.

const RUNTIME_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "runtime.js",
);
const START_MARKER =
  "function vfsPackagePathNotExported(packageName, subpath, packageJsonPath) {";
const END_MARKER = "function vfsIsRelativeRequest(request) {";
// Second region: the package-exports/imports resolvers, which had the same
// defect class as regex literals (`/\*/g` cooked to `/*/g`, opening a
// comment that swallowed the loop and produced "Unsyntactic break").
const START_MARKER_2 =
  "function vfsResolvePackageTargetSync(target, conditions) {";
const END_MARKER_2 = "function resolveSyncRequest(request, parentPath, vfs) {";

function extractTemplateRegion(src) {
  const start = src.indexOf(START_MARKER);
  const end = src.indexOf(END_MARKER);
  if (start === -1) throw new Error("start marker not found in runtime.js");
  if (end === -1) throw new Error("end marker not found in runtime.js");
  if (!(start < end)) throw new Error("markers out of order in runtime.js");
  return src.slice(start, end);
}

function cookLikeGenerateTemplate(region) {
  // The region must contain no backticks or ${...}: then cooking is pure
  // escape processing, byte-identical to what generate()'s template does.
  expect(region).not.toMatch(/[`$]/);
  return new Function("return `" + region + "`;")();
}

describe("vite7 wrapper template: vfs resolver escape integrity", () => {
  test("template-cooked vfs resolvers parse as valid JS", () => {
    const src = fs.readFileSync(RUNTIME_PATH, "utf8");
    for (const [startMarker, endMarker] of [
      [START_MARKER, END_MARKER],
      [START_MARKER_2, END_MARKER_2],
    ]) {
      const start = src.indexOf(startMarker);
      const end = src.indexOf(endMarker);
      if (start === -1)
        throw new Error("start marker not found: " + startMarker);
      if (end === -1) throw new Error("end marker not found: " + endMarker);
      const cooked = cookLikeGenerateTemplate(src.slice(start, end));
      let err = null;
      try {
        acorn.parse(cooked, { ecmaVersion: "latest", sourceType: "script" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeNull();
    }
  });

  test("intended escaped quotes survive template cooking", () => {
    const src = fs.readFileSync(RUNTIME_PATH, "utf8");
    const cooked = cookLikeGenerateTemplate(extractTemplateRegion(src));
    // The generated wrapper must contain \" (backslash-quote) inside the
    // double-quoted message strings — a bare " would terminate the string.
    expect(cooked).toContain('\\"exports\\"');
    // Generated line: "\" is not defined in package " + packageJsonPath
    // (escaped quote at the open, plain quote closing the string).
    expect(cooked).toContain('"\\" is not defined in package "');
  });

  test("no backslash-dependent regex literals in template text", () => {
    const src = fs.readFileSync(RUNTIME_PATH, "utf8");
    const start = src.indexOf(START_MARKER_2);
    const end = src.indexOf(END_MARKER_2);
    const cooked = cookLikeGenerateTemplate(src.slice(start, end));
    // Star-replacement must survive cooking: the file uses /[*]/g (the
    // repo's own convention — see the NOTE at the vfs section) because
    // /\*/g would cook to /*/g and open a comment in the wrapper.
    expect(cooked).toContain("/[*]/g");
    expect(cooked).not.toMatch(/[^\\]\/\*\/g/);
  });
});
