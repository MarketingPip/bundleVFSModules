#!/usr/bin/env node
// parity/headless/worker-entry.mjs — Node worker_threads entry for the
// headless host (the "Node/Bun worker threads" transport from roadmap §4).
//
// workerData: { userCode, fileName, timeout }
// Posts one verdict message to the parent:
//   { ok, error?, harnessError?, executionTime?, uuid, logs? }
import { parentPort, workerData } from "node:worker_threads";
import { HeadlessHost } from "./host.mjs";

const { userCode, fileName, timeout } = workerData;

async function main() {
  const host = new HeadlessHost({ timeout: timeout ?? 30000 });
  const verdict = await host.execute(userCode, { fileName });
  parentPort.postMessage(verdict);
}

main().catch((e) => {
  parentPort.postMessage({
    ok: false,
    harnessError: `worker entry failed: ${(e && e.message) || e}`,
  });
});
