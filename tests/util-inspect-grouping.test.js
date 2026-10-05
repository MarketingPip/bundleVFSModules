// tests/util-inspect-grouping.test.js — pins Node's groupArrayElements
// behavior for util.inspect with numeric compact (from Node v24.20.0
// lib/internal/util/inspect.js). These cases come from the official
// test-util-inspect.js (compact:3, breakLength:60 grouping).
import { inspect } from "../src/util.js";

function lines(s) {
  return s.split("\n");
}

describe("util.inspect compact:number array grouping", () => {
  test("long strings are not grouped (one per line)", () => {
    const out = inspect(
      { long: Array(9).fill("This text is too long for grouping!") },
      { compact: 3, depth: 10, breakLength: 60 },
    );
    const expected = [
      "{",
      "  long: [",
      "    'This text is too long for grouping!',",
      "    'This text is too long for grouping!',",
      "    'This text is too long for grouping!',",
      "    'This text is too long for grouping!',",
      "    'This text is too long for grouping!',",
      "    'This text is too long for grouping!',",
      "    'This text is too long for grouping!',",
      "    'This text is too long for grouping!',",
      "    'This text is too long for grouping!'",
      "  ]",
      "}",
    ].join("\n");
    expect(out).toBe(expected);
  });

  test("short strings group two per line", () => {
    const out = inspect(
      { f: Array(9).fill("foobar") },
      { compact: 3, breakLength: 60 },
    );
    const expected = [
      "{",
      "  f: [",
      "    'foobar', 'foobar',",
      "    'foobar', 'foobar',",
      "    'foobar', 'foobar',",
      "    'foobar', 'foobar',",
      "    'foobar'",
      "  ]",
      "}",
    ].join("\n");
    expect(out).toBe(expected);
  });

  test("numbers align in columns (padStart)", () => {
    const out = inspect(
      {
        d: Array.from({ length: 10 }).map((_, i) => (i % 2 === 0 ? i * i : i)),
      },
      { compact: 3, breakLength: 60 },
    );
    const ls = lines(out);
    // Numbers are right-aligned in columns (matches Node exactly).
    expect(ls[2]).toBe("    0,  1, 4,  3, 16,");
    expect(ls[3]).toBe("    5, 36, 7, 64,  9");
  });

  test("six or fewer entries are not grouped", () => {
    // 6 x 'ab' fits on a single line.
    const out = inspect(Array(6).fill("ab"), { compact: 3, breakLength: 60 });
    expect(out).toBe("[ 'ab', 'ab', 'ab', 'ab', 'ab', 'ab' ]");
  });

  test("seven entries trigger grouping", () => {
    const out = inspect(Array(7).fill("ab"), { compact: 3, breakLength: 60 });
    const expected = [
      "[",
      "  'ab', 'ab',",
      "  'ab', 'ab',",
      "  'ab', 'ab',",
      "  'ab'",
      "]",
    ].join("\n");
    expect(out).toBe(expected);
  });
});
