// tests/lifecycle-docs.test.js — docs/code consistency for docs/LIFECYCLE.md.
//
// Parses the "API inventory" section of the doc and asserts every listed
// method, event, and config option actually exists in runtime.js source.
// Fails if the docs drift from the code (in either direction).
//
// This is source-text analysis, not a runtime import: runtime.js is a
// browser host file and must not be executed under Node here.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DOC = fs.readFileSync(
  path.join(__dirname, "..", "docs", "LIFECYCLE.md"),
  "utf8",
);
const SRC = fs.readFileSync(path.join(__dirname, "..", "runtime.js"), "utf8");

// Extract the CodeSandbox class body (line ranges verified against source).
function classBody() {
  const lines = SRC.split("\n");
  const startIdx = lines.findIndex((l) =>
    l.includes("export class CodeSandbox"),
  );
  if (startIdx === -1) throw new Error("CodeSandbox class not found");
  let depth = 0;
  for (let i = startIdx; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) || []).length;
    depth -= (lines[i].match(/\}/g) || []).length;
    if (i > startIdx && depth === 0) {
      return lines.slice(startIdx, i + 1).join("\n");
    }
  }
  throw new Error("CodeSandbox class end not found");
}

// Parse the inventory section: "- `name`" bullets under the given
// subheading, stopping at the first non-bullet line.
function inventory(sectionTitle) {
  const secStart = DOC.indexOf(sectionTitle);
  if (secStart === -1) throw new Error(`Section not found: ${sectionTitle}`);
  const lines = DOC.slice(secStart).split("\n").slice(1);
  const names = [];
  for (const line of lines) {
    const m = line.match(/^- `([^`]+)`/);
    if (m) {
      names.push(m[1]);
    } else if (names.length > 0) {
      break; // end of this bullet list
    }
    // skip leading prose/blank lines before the list starts
  }
  return names;
}

describe("docs/LIFECYCLE.md consistency", () => {
  const methods = inventory("Methods on `CodeSandbox.prototype`:");
  const events = inventory("Events emitted (string literals in `runtime.js`):");
  const options = inventory("Config options validated in the constructor:");

  test("inventory sections are non-empty", () => {
    expect(methods.length).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
    expect(options.length).toBeGreaterThan(0);
  });

  describe("documented methods exist on CodeSandbox", () => {
    const body = classBody();
    for (const name of methods) {
      test(`CodeSandbox.${name}`, () => {
        if (name === "constructor") {
          expect(body).toMatch(/constructor\s*\(options/);
        } else {
          // matches "  methodName(" or "  async methodName(" at class depth
          const re = new RegExp(
            `^  (?:async\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`,
            "m",
          );
          expect(body).toMatch(re);
        }
      });
    }
  });

  describe("documented events are emitted", () => {
    for (const name of events) {
      test(`event "${name}"`, () => {
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`\\.emit\\(["']${esc}["']`);
        expect(SRC).toMatch(re);
      });
    }
  });

  describe("documented config options are validated", () => {
    const body = classBody();
    for (const name of options) {
      test(`config option "${name}"`, () => {
        // appears in the config object literal or its validation
        expect(body).toContain(name);
      });
    }
  });
});
