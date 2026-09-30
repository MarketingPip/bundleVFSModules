/**
 * vite7-events-require-interop.test.js
 *
 * Regression test for the M3 `EventEmitter$2 is not a constructor` failure
 * (2026-09-30-vite7-events-interop).
 *
 * Root cause: the sync-builtin interop rule in the generate() template
 * (`_builtinRequireValue`, runtime.js) only unwrapped `mod.default` when the
 * module namespace had EXACTLY ONE key. Every builtin port declares its CJS
 * `module.exports` equivalent via `export default` (events.js:
 * `export default EventEmitter`), but ports like events also export named
 * bindings — so `__require("events")` returned the (non-callable) ESM
 * namespace instead of the EventEmitter class, and esbuild-bundled consumers
 * doing `const EventEmitter$2 = __require("events"); new EventEmitter$2()`
 * (ws's websocket.js inside vite's chunks/config.js) died.
 *
 * Node parity: `require("events")` IS the EventEmitter class
 * (`require("events") === require("events").EventEmitter`), and every
 * builtin port's `export default` is its CJS `module.exports` equivalent.
 * The rule must therefore prefer `default` whenever it is defined.
 *
 * This test extracts the REAL `_builtinRequireValue` from the built
 * runtime.js generate() template (balanced-brace extraction, no copies) and
 * runs it against the REAL builtin ESM namespaces — no browser needed.
 */
import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as eventsNs from "../src/events.js";
import * as pathNs from "../src/path.js";

const RUNTIME_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "runtime.js",
);

const FN_MARKER = "function _builtinRequireValue(mod) {";

function extractHelper(src) {
  const start = src.indexOf(FN_MARKER);
  if (start === -1)
    throw new Error("_builtinRequireValue not found in runtime.js");
  // Balanced-brace scan from the opening brace of the marker.
  let depth = 0;
  let i = src.indexOf("{", start);
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0)
    throw new Error("unbalanced braces extracting _builtinRequireValue");
  const fnSrc = src.slice(start, i + 1);
  // The template region is template-cooked: it must not contain backticks or
  // ${...}, otherwise cooking could have altered the extracted source.
  expect(fnSrc).not.toMatch(/[`$]/);
  return new Function(`${fnSrc}; return _builtinRequireValue;`)();
}

const _builtinRequireValue = extractHelper(
  fs.readFileSync(RUNTIME_PATH, "utf8"),
);

describe("sync builtin require interop (_builtinRequireValue)", () => {
  test("require('events') returns the EventEmitter class, not the namespace", () => {
    const v = _builtinRequireValue(eventsNs);
    expect(v).toBe(eventsNs.EventEmitter);
    expect(typeof v).toBe("function");
  });

  test("the returned events value is constructible (ws: new EventEmitter$2())", () => {
    const EventEmitter = _builtinRequireValue(eventsNs);
    let inst = null;
    expect(() => {
      inst = new EventEmitter();
    }).not.toThrow();
    expect(inst).toBeInstanceOf(EventEmitter);
  });

  test("require('events') matches Node: .EventEmitter === itself, statics present", () => {
    const v = _builtinRequireValue(eventsNs);
    expect(v.EventEmitter).toBe(v);
    expect(typeof v.once).toBe("function");
    expect(typeof v.on).toBe("function");
  });

  test("no regression: require('path') still returns its default export object", () => {
    const v = _builtinRequireValue(pathNs);
    expect(v).toBe(pathNs.default);
    expect(typeof v.join).toBe("function");
  });

  test("fallback: namespace without a default export is returned as-is", () => {
    const ns = { a: 1, b: 2 };
    expect(_builtinRequireValue(ns)).toBe(ns);
    expect(_builtinRequireValue(null)).toBe(null);
    expect(_builtinRequireValue(undefined)).toBe(undefined);
  });
});
