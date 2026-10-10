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
 * (`require("events") === require("events").EventEmitter`).
 *
 * Refinement (2026-09-30): the naive "always unwrap default" rule regressed
 * the browser preload — `loadModule` returns an interop Proxy whose lazy
 * getters (CJS named-export fallback, star re-exports) live on the proxy,
 * and unwrapping object defaults broke 16 builtins with "too much
 * recursion". The rule now unwraps ONLY when the default is callable (a
 * class like EventEmitter); object defaults keep the namespace.
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
    throw new Error("_builtinRequireValue not found in template");
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
  // The template is JSON-encoded (not a template literal), so backticks and
  // ${...} are safe. Only %%TOKENS%% would be a problem (none here).
  return new Function(`${fnSrc}; return _builtinRequireValue;`)();
}

// The template now lives in src/sandbox-template.js.
const TEMPLATE_SRC = JSON.parse(
  fs
    .readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sandbox-template.js"),
      "utf8",
    )
    .match(/export const SANDBOX_TEMPLATE = (".*");/s)[1],
);
const _builtinRequireValue = extractHelper(TEMPLATE_SRC);

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

  test("no regression: require('path') returns the namespace (object default)", () => {
    // path's default is a plain object; unwrapping it would bypass the
    // interop Proxy's lazy getters. The namespace must be preserved.
    const v = _builtinRequireValue(pathNs);
    expect(v).toBe(pathNs);
    expect(typeof v.join).toBe("function");
    expect(v.default).toBe(pathNs.default);
  });

  test("single-key namespace (CJS-style) still unwraps its default", () => {
    const def = { foo: 1 };
    const ns = { default: def };
    expect(_builtinRequireValue(ns)).toBe(def);
  });

  test("callable default unwraps even when the namespace has many keys", () => {
    class Foo {}
    const ns = { default: Foo, a: 1, b: 2, c: 3 };
    expect(_builtinRequireValue(ns)).toBe(Foo);
  });

  test("fallback: namespace without a default export is returned as-is", () => {
    const ns = { a: 1, b: 2 };
    expect(_builtinRequireValue(ns)).toBe(ns);
    expect(_builtinRequireValue(null)).toBe(null);
    expect(_builtinRequireValue(undefined)).toBe(undefined);
  });
});
