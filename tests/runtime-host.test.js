/**
 * Tests for the Worker F ("host") extracted modules (branch modular/host):
 *   src/runtime/output-shim.js     (makeOutputShim2)
 *   src/runtime/message-handler.js (_parseKey)
 *   src/runtime/host-utils.js      (FormattedError, formatErrors, formatErrors2,
 *                                   normalizeSeaAssets, base64EncodeBytes,
 *                                   isSeedEnvelope, seedBytesToBase64,
 *                                   flattenFileTree)
 *   src/runtime/entry.js           (executeCode, createSandbox — STATIC source
 *                                   checks only; its `./code-sandbox.js`
 *                                   import cannot resolve until the CodeSandbox
 *                                   class (runtime.js:4036) is extracted by
 *                                   the owning worker)
 *
 * Convention (Worker C): extracted modules keep host-scope globals as bare
 * references; tests install faithful equivalents on globalThis.
 */
import { describe, test, expect, afterEach } from "@jest/globals";
import { Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { _parseKey } from "../src/runtime/message-handler.js";
import { makeOutputShim2 } from "../src/runtime/output-shim.js";
import {
  FormattedError,
  formatErrors,
  formatErrors2,
  normalizeSeaAssets,
  base64EncodeBytes,
  isSeedEnvelope,
  seedBytesToBase64,
  flattenFileTree,
} from "../src/runtime/host-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── _parseKey ─────────────────────────────────────────────────────────────
// NOTE on escapes: runtime.js holds this function inside the `_getState`
// template literal with DOUBLE backslashes (`'\\x1b[A'`), which the template
// engine collapses to real ESC for the iframe. The module uses SINGLE
// backslashes — the only spelling that preserves the runtime contract
// (real keypress in -> key name out) both standalone and via verbatim
// `${_parseKey.toString()}` interpolation into the bootstrap template.
// (Verified empirically: a byte-verbatim copy returns `unknown` for real
// ESC input in both uses.)
describe("_parseKey", () => {
  test("escape sequences map to key names", () => {
    expect(_parseKey("\x1b[A")).toMatchObject({ name: "up" });
    expect(_parseKey("\x1b[B")).toMatchObject({ name: "down" });
    expect(_parseKey("\x1b[C")).toMatchObject({ name: "right" });
    expect(_parseKey("\x1b[D")).toMatchObject({ name: "left" });
    expect(_parseKey("\x1b[H")).toMatchObject({ name: "home" });
    expect(_parseKey("\x1b[F")).toMatchObject({ name: "end" });
    expect(_parseKey("\x1b[3~")).toMatchObject({ name: "delete" });
    expect(_parseKey("\x1b[2~")).toMatchObject({ name: "insert" });
    expect(_parseKey("\x1b[5~")).toMatchObject({ name: "pageup" });
    expect(_parseKey("\x1b[6~")).toMatchObject({ name: "pagedown" });
    expect(_parseKey("\x1b")).toMatchObject({ name: "escape" });
    expect(_parseKey("\r")).toMatchObject({ name: "return" });
    expect(_parseKey("\n")).toMatchObject({ name: "return" });
    expect(_parseKey("\t")).toMatchObject({ name: "tab" });
    expect(_parseKey("\x7f")).toMatchObject({ name: "backspace" });
    expect(_parseKey("\b")).toMatchObject({ name: "backspace" });
  });

  test("specials carry ctrl/meta/shift false and echo the sequence", () => {
    expect(_parseKey("\x1b[A")).toEqual({
      name: "up",
      ctrl: false,
      meta: false,
      shift: false,
      sequence: "\x1b[A",
    });
  });

  test("single chars map to lowercase names; uppercase sets shift", () => {
    expect(_parseKey("a")).toEqual({
      name: "a",
      ctrl: false,
      meta: false,
      shift: false,
      sequence: "a",
    });
    expect(_parseKey("A")).toMatchObject({ name: "a", shift: true });
    expect(_parseKey("1")).toMatchObject({ name: "1", shift: false });
  });

  test("control codes (1-26) map to ctrl+letter", () => {
    expect(_parseKey("\x01")).toMatchObject({ name: "a", ctrl: true });
    expect(_parseKey("\x1a")).toMatchObject({ name: "z", ctrl: true });
  });

  test("anything else is unknown", () => {
    expect(_parseKey("xyz")).toMatchObject({ name: "unknown" });
    expect(_parseKey("")).toMatchObject({ name: "unknown" });
  });

  test("verbatim toString() interpolation into a bootstrap template preserves iframe behavior", () => {
    // The documented integration path: interpolated values are inserted
    // verbatim (no escape processing), so the iframe parses `'\x1b[A'`
    // exactly as it does from today's template — real ESC semantics.
    const fn = new Function(`return (${_parseKey.toString()});`)();
    expect(fn("\x1b[A")).toMatchObject({ name: "up", sequence: "\x1b[A" });
    expect(fn("\x1b")).toMatchObject({ name: "escape" });
    expect(fn("\r")).toMatchObject({ name: "return" });
    expect(fn("\t")).toMatchObject({ name: "tab" });
    expect(fn("A")).toMatchObject({ name: "a", shift: true });
    expect(fn("\x03")).toMatchObject({ name: "c", ctrl: true });
  });
});

// ── makeOutputShim2 ───────────────────────────────────────────────────────
describe("makeOutputShim2", () => {
  afterEach(() => {
    delete globalThis.Writable;
  });

  test("builds a TTY-ish Writable for stdout", () => {
    globalThis.Writable = Writable;
    const s = makeOutputShim2("stdout");
    expect(s).toBeInstanceOf(Writable);
    expect(s.isTTY).toBe(true);
    expect(s.fd).toBe(1);
    expect(s.columns).toBe(process.stdout.columns || 80);
    expect(s.rows).toBe(process.stdout.rows || 24);
    expect(s.getColorDepth()).toBe(8);
  });

  test("stderr variant uses fd 2", () => {
    globalThis.Writable = Writable;
    const s = makeOutputShim2("stderr");
    expect(s.fd).toBe(2);
    expect(s.isTTY).toBe(true);
  });

  test("cursor methods invoke the callback and return true", () => {
    globalThis.Writable = Writable;
    const s = makeOutputShim2("stdout");
    expect.assertions(6);
    s.clearLine(0, () => expect(true).toBe(true));
    expect(s.clearLine(0)).toBe(true);
    s.cursorTo(1, 2, () => expect(true).toBe(true));
    expect(s.cursorTo(1, 2)).toBe(true);
    s.moveCursor(1, -1, () => expect(true).toBe(true));
    expect(s.moveCursor(1, -1)).toBe(true);
  });

  test("write() forwards to process.stdout.write and fires the callback", async () => {
    globalThis.Writable = Writable;
    const s = makeOutputShim2("stdout");
    const orig = process.stdout.write;
    let captured;
    process.stdout.write = (d) => {
      captured = d;
      return true;
    };
    try {
      await new Promise((resolve) => s.write("hello", resolve));
      expect(captured).toBe("hello");
      await new Promise((resolve) => s.write(Buffer.from("buf"), resolve));
      expect(captured).toBe("buf");
    } finally {
      process.stdout.write = orig;
    }
  });

  test("write() forwards to process.stderr.write for the stderr shim", async () => {
    globalThis.Writable = Writable;
    const s = makeOutputShim2("stderr");
    const orig = process.stderr.write;
    let captured;
    process.stderr.write = (d) => {
      captured = d;
      return true;
    };
    try {
      await new Promise((resolve) => s.write("oops", resolve));
      expect(captured).toBe("oops");
    } finally {
      process.stderr.write = orig;
    }
  });
});

// ── FormattedError ────────────────────────────────────────────────────────
describe("FormattedError", () => {
  test("preserves original error properties and exposes the formatted message", () => {
    const orig = new Error("boom");
    orig.code = "E_X";
    orig.extra = 42;
    const fe = new FormattedError(orig, "formatted!");
    expect(fe).toBeInstanceOf(Error);
    expect(fe.message).toBe("formatted!");
    expect(fe.toString()).toBe("formatted!");
    expect(fe.name).toBe("Error");
    expect(fe.originalMessage).toBe("boom");
    expect(fe.code).toBe("E_X");
    expect(fe.formattedMessage).toBe("formatted!");
    expect(fe.extra).toBe(42);
    expect(typeof fe.stack).toBe("string");
  });

  test("falls back to Error name when the original has none", () => {
    const fe = new FormattedError({ message: "m" }, "f");
    expect(fe.name).toBe("Error");
  });
});

// ── formatErrors / formatErrors2 ──────────────────────────────────────────
describe.each([
  ["formatErrors", formatErrors],
  ["formatErrors2", formatErrors2],
])("%s", (_label, fmt) => {
  test("formats a located syntax error with source context", () => {
    const code = "line1\nline2 bad\nline3";
    const err = new SyntaxError("Unexpected token");
    err.loc = { line: 2, column: 6 };
    const out = fmt(code, err);
    expect(out).toBeInstanceOf(FormattedError);
    expect(out.message).toContain("SyntaxError: Unexpected token");
    expect(out.message).toContain("at line 2, column 6");
    expect(out.message).toContain("Unexpected token: 'b'");
    expect(out.message).toContain("→");
    expect(out.message).toContain("line2 bad");
  });

  test("supports err.location as the loc source", () => {
    const err = new SyntaxError("bad");
    err.location = { line: 1, column: 0 };
    const out = fmt("abc", err);
    expect(out.message).toContain("at line 1, column 0");
  });

  test("without a loc, returns the plain message", () => {
    const out = fmt("code", new Error("plain"));
    expect(out).toBeInstanceOf(FormattedError);
    expect(out.message).toBe("plain");
    expect(out.message).not.toContain("at line");
  });

  test("error without a message yields Unknown error", () => {
    // Faithful to the original: `err?.message || "Unknown error"` covers a
    // defined-but-messageless error object…
    const out = fmt("code", {});
    expect(out.message).toBe("Unknown error");
  });

  test("undefined/null error throws in the FormattedError constructor (original behavior)", () => {
    // …but the original unconditionally dereferences `originalError.name`,
    // so a missing error throws TypeError. Preserved, not fixed.
    expect(() => fmt("code", undefined)).toThrow(TypeError);
    expect(() => fmt("code", null)).toThrow(TypeError);
  });

  test("EOF marker when the column is past end of line", () => {
    const err = new SyntaxError("eof");
    err.loc = { line: 1, column: 99 };
    const out = fmt("ab", err);
    expect(out.message).toContain("EOF");
  });
});

// ── normalizeSeaAssets ────────────────────────────────────────────────────
describe("normalizeSeaAssets", () => {
  test("string values become utf8 entries", () => {
    expect(normalizeSeaAssets({ "a.txt": "hello" })).toEqual({
      "a.txt": { encoding: "utf8", data: "hello" },
    });
  });

  test("Uint8Array and ArrayBuffer values become base64 entries", () => {
    expect(normalizeSeaAssets({ "b.bin": new Uint8Array([104, 105]) })).toEqual(
      {
        "b.bin": { encoding: "base64", data: "aGk=" },
      },
    );
    expect(
      normalizeSeaAssets({ "c.bin": new Uint8Array([1, 2, 3]).buffer }),
    ).toEqual({
      "c.bin": {
        encoding: "base64",
        data: Buffer.from([1, 2, 3]).toString("base64"),
      },
    });
  });

  test("a typed-array view over a larger buffer encodes only the view", () => {
    const buf = new Uint8Array([0, 104, 105, 0]);
    const view = new Uint8Array(buf.buffer, 1, 2);
    expect(normalizeSeaAssets({ v: view })).toEqual({
      v: { encoding: "base64", data: "aGk=" },
    });
  });

  test("well-formed envelopes pass through as-is", () => {
    const env = { encoding: "base64", data: "aGk=" };
    expect(normalizeSeaAssets({ d: env })).toEqual({ d: env });
  });

  test("misconfigured assets are dropped, never throw", () => {
    expect(
      normalizeSeaAssets({ "": "empty-key", n: 42, z: null, u: undefined }),
    ).toEqual({});
    expect(normalizeSeaAssets(null)).toEqual({});
    expect(normalizeSeaAssets("str")).toEqual({});
    expect(normalizeSeaAssets(42)).toEqual({});
  });

  test("accepts a Map", () => {
    expect(normalizeSeaAssets(new Map([["m.txt", "hi"]]))).toEqual({
      "m.txt": { encoding: "utf8", data: "hi" },
    });
  });
});

// ── base64EncodeBytes ─────────────────────────────────────────────────────
describe("base64EncodeBytes", () => {
  test("encodes known vectors", () => {
    expect(base64EncodeBytes(new Uint8Array([104, 101, 108, 108, 111]))).toBe(
      "aGVsbG8=",
    );
    expect(base64EncodeBytes(new Uint8Array(0))).toBe("");
  });

  test("handles input larger than the 0x8000 chunk size", () => {
    const bytes = new Uint8Array(100000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    expect(base64EncodeBytes(bytes)).toBe(
      Buffer.from(bytes).toString("base64"),
    );
  });
});

// ── isSeedEnvelope ────────────────────────────────────────────────────────
describe("isSeedEnvelope", () => {
  test("recognizes strict two-key utf8/base64 envelopes", () => {
    expect(isSeedEnvelope({ encoding: "utf8", data: "x" })).toBe(true);
    expect(isSeedEnvelope({ encoding: "base64", data: "aGk=" })).toBe(true);
  });

  test("rejects near-misses", () => {
    expect(isSeedEnvelope({ encoding: "utf8", data: "x", extra: 1 })).toBe(
      false,
    );
    expect(isSeedEnvelope({ encoding: "latin1", data: "x" })).toBe(false);
    expect(isSeedEnvelope({ encoding: "utf8", data: 123 })).toBe(false);
    expect(isSeedEnvelope({ encoding: "utf8" })).toBe(false);
    expect(isSeedEnvelope(new Uint8Array([1]))).toBe(false);
    expect(isSeedEnvelope(null)).toBe(false);
    expect(isSeedEnvelope("str")).toBe(false);
    expect(isSeedEnvelope({})).toBe(false);
  });
});

// ── seedBytesToBase64 ─────────────────────────────────────────────────────
describe("seedBytesToBase64", () => {
  test("normalizes Uint8Array, ArrayBuffer, and Buffer to base64", () => {
    expect(seedBytesToBase64(new Uint8Array([104, 105]))).toBe("aGk=");
    expect(seedBytesToBase64(new Uint8Array([1, 2, 3]).buffer)).toBe(
      Buffer.from([1, 2, 3]).toString("base64"),
    );
    expect(seedBytesToBase64(Buffer.from("hi"))).toBe("aGk=");
  });
});

// ── flattenFileTree ───────────────────────────────────────────────────────
describe("flattenFileTree", () => {
  test("flattens nested objects to slash paths", () => {
    expect(flattenFileTree({ a: { b: "x", c: { d: "y" } }, top: "z" })).toEqual(
      { "a/b": "x", "a/c/d": "y", top: "z" },
    );
  });

  test("binary leaves become base64 envelopes", () => {
    expect(flattenFileTree({ "f.bin": new Uint8Array([1, 2, 3]) })).toEqual({
      "f.bin": {
        encoding: "base64",
        data: Buffer.from([1, 2, 3]).toString("base64"),
      },
    });
    expect(flattenFileTree({ "g.bin": new Uint8Array([9]).buffer })).toEqual({
      "g.bin": {
        encoding: "base64",
        data: Buffer.from([9]).toString("base64"),
      },
    });
  });

  test("seed envelopes stay leaves (not recursed into encoding/data files)", () => {
    const env = { encoding: "utf8", data: "hi" };
    expect(flattenFileTree({ e: env })).toEqual({ e: env });
  });

  test("null values are skipped; non-objects yield {}", () => {
    expect(flattenFileTree({ n: null, k: "v" })).toEqual({ k: "v" });
    expect(flattenFileTree(null)).toEqual({});
    expect(flattenFileTree("x")).toEqual({});
    expect(flattenFileTree(42)).toEqual({});
  });

  test("respects an explicit parentPath", () => {
    expect(flattenFileTree({ b: "x" }, "a")).toEqual({ "a/b": "x" });
  });
});

// ── entry.js: static wiring checks ────────────────────────────────────────
// entry.js cannot be imported yet: `import { CodeSandbox } from
// "./code-sandbox.js"` has no target until the CodeSandbox class
// (runtime.js:4036) is extracted. These source-text checks pin the intended
// wiring so the integrator can verify it.
describe("entry.js static wiring", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../src/runtime/entry.js"),
    "utf8",
  );

  test("imports CodeSandbox from the placeholder module path", () => {
    expect(src).toContain('import { CodeSandbox } from "./code-sandbox.js";');
  });

  test("re-exports the host-utils surface", () => {
    expect(src).toContain('export * from "./host-utils.js";');
  });

  test("defines the convenience API", () => {
    expect(src).toContain(
      "export async function executeCode(code, options = {})",
    );
    expect(src).toContain("export function createSandbox(options = {})");
  });

  test("host-utils.js exports the full expected surface", () => {
    const utilSrc = fs.readFileSync(
      path.join(__dirname, "../src/runtime/host-utils.js"),
      "utf8",
    );
    for (const name of [
      "FormattedError",
      "formatErrors",
      "formatErrors2",
      "normalizeSeaAssets",
      "base64EncodeBytes",
      "isSeedEnvelope",
      "seedBytesToBase64",
      "flattenFileTree",
    ]) {
      expect(utilSrc).toMatch(
        new RegExp(
          `export\\s+(async\\s+function|function|class)\\s+${name}\\b`,
        ),
      );
    }
  });
});
