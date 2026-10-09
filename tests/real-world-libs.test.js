// Real-world library compatibility tests
// Verifies popular npm packages work with our shims.
//
// These are integration tests: they import real libraries and verify
// basic functionality through the shim layer.

import { describe, test, expect } from "@jest/globals";

describe("real-world library compatibility", () => {
  test("lodash: chunk and merge work", async () => {
    const _ = (await import("lodash")).default;
    expect(_.chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(_.merge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test("uuid: v4 generates valid UUIDs", async () => {
    const { v4 } = await import("uuid");
    const id = v4();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("commander: Command class available", async () => {
    const { Command } = await import("commander");
    const program = new Command();
    expect(typeof program.option).toBe("function");
    expect(typeof program.parse).toBe("function");
  });
});
