// TDD: duplicate stack frame collapsing (Node v24 getStackFrames behavior).
// Node collapses recursive repetitive frames in stacks > 10 lines:
// " ... collapsed N duplicate lines matching above lines ..."
import util from "../src/util.js";

describe("util.inspect duplicate stack frame collapsing", () => {
  test("collapses duplicate stack frames in long stacks", () => {
    const err = new Error("x");
    // 12 lines with a repeating 3-line pattern
    err.stack =
      "Error: Hide duplicate frames in long stack\n" +
      "    at A.<anonymous> (/foo/node_modules/bar/baz.js:2:7)\n" +
      "    at A.<anonymous> (/foo/node_modules/bar/baz.js:2:7)\n" +
      "    at Module._compile (node:internal/modules/cjs/loader:827:30)\n" +
      "    at Fancy (node:vm:697:32)\n" +
      "    at tryModuleLoad (node:internal/modules/cjs/foo:629:12)\n" +
      "    at Function.Module._load (node:internal/modules/cjs/loader:621:3)\n" +
      "    at Fancy (node:vm:697:32)\n" +
      "    at tryModuleLoad (node:internal/modules/cjs/foo:629:12)\n" +
      "    at Function.Module._load (node:internal/modules/cjs/loader:621:3)\n" +
      "    at Fancy (node:vm:697:32)\n" +
      "    at tryModuleLoad (node:internal/modules/cjs/foo:629:12)\n" +
      "    at Function.Module._load (node:internal/modules/cjs/loader:621:3)";
    const out = util.inspect(err, { colors: true });
    expect(out).toMatch(
      /collapsed 6 duplicate lines matching above 3 lines 2 times/,
    );
  });

  test("does not collapse short stacks (<=10 frames)", () => {
    const err = new Error("x");
    err.stack = "Error: short\n" + "    at A (/a.js:1:1)\n".repeat(5).trimEnd();
    const out = util.inspect(err, { colors: true });
    expect(out).not.toMatch(/collapsed/);
  });
});
