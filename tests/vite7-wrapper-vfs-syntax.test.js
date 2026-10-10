import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

// Regression: `SyntaxError: RUNTIME ERROR: Unexpected token (883:26)` broke
// EVERY sandbox execute() on main after 18f71c4b.
//
// Root cause (historical): vfsPackagePathNotExported / vfsPackageImportNotDefined
// lived INSIDE SandboxRuntime.generate()'s template literal in runtime.js, so
// their source text was template-cooked. A single `\"` cooked to a bare `"`,
// terminating the string early -> the wrapper failed to parse.
//
// The template now lives in src/sandbox-template.js (JSON-encoded, built from
// src/sandbox/*.js). This test acorn-parses the shipped template regions,
// pinning the defect class (escape loss in the wrapper) without needing a browser.

const TEMPLATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "sandbox-template.js",
);
// The decoded template value (actual JS, no cooking needed).
const TEMPLATE_SRC = JSON.parse(
  fs.readFileSync(TEMPLATE_PATH, "utf8").match(/export const SANDBOX_TEMPLATE = (".*");/s)[1],
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
  if (start === -1) throw new Error("start marker not found in template");
  if (end === -1) throw new Error("end marker not found in template");
  if (!(start < end)) throw new Error("markers out of order in template");
  return src.slice(start, end);
}

function cookLikeGenerateTemplate(region) {
  // The template is now JSON-encoded (not a template literal), so no cooking
  // is needed: the template value IS the final JS. Return as-is.
  return region;
}

describe("vite7 wrapper template: vfs resolver escape integrity", () => {
  test("template-cooked vfs resolvers parse as valid JS", () => {
    const src = TEMPLATE_SRC;
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
    const src = TEMPLATE_SRC;
    const cooked = cookLikeGenerateTemplate(extractTemplateRegion(src));
    // The generated wrapper must contain \" (backslash-quote) inside the
    // double-quoted message strings — a bare " would terminate the string.
    expect(cooked).toContain('\\"exports\\"');
    // Generated line: "\" is not defined in package " + packageJsonPath
    // (escaped quote at the open, plain quote closing the string).
    expect(cooked).toContain('"\\" is not defined in package "');
  });

  test("no backslash-dependent regex literals in template text", () => {
    const src = TEMPLATE_SRC;
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
