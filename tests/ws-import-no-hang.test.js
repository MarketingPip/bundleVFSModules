// Regression: importing src/ws.js must not pin the host event loop.
//
// src/ws.js creates a BroadcastChannel at module scope for the vite HMR
// bridge. A BroadcastChannel holds a MessagePort open, which kept the
// process alive forever — jest printed "Jest did not exit one second
// after the test run has completed" and the verify-loop wrapper hit its
// 600s timeout with zero output. The module now unref()s the channel
// where the host supports it. This test fails (child killed by timeout)
// if the pin ever comes back.
import { describe, test, expect } from "@jest/globals";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const wsPath = path.join(here, "..", "src", "ws.js");

function importAndExit(timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["--input-type=module", "-e", `import(${JSON.stringify(wsPath)})`],
      { timeout: timeoutMs },
      (err) => {
        resolve(err);
      },
    );
    // belt and braces: execFile's timeout kills, but ensure no stray child
    child.on("error", () => {});
  });
}

describe("ws.js import does not pin the event loop", () => {
  test("node exits after importing src/ws.js", async () => {
    const err = await importAndExit(10000);
    expect(err).toBeNull();
  }, 15000);
});
