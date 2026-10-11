#!/usr/bin/env node
// parity/headless/channel.mjs — transport abstraction for the headless
// host (Nodepod's src/headless.ts + src/host/ pattern, techniques only).
//
// The SAME core runtime (HeadlessHost over node:vm, built from
// runtime-scope.mjs) runs on two transports with an identical run()
// contract:
//
//   run(userCode, { fileName }) -> Promise<{
//     ok: boolean,             // sandbox posted function_results
//     error?: string,          // function_error / window_error detail
//     harnessError?: string,    // the harness itself failed (timeout, crash)
//     executionTime?: number,
//     uuid: string,
//     logs?: any[],
//   }>
//
//   - createInProcessChannel(): the core runs in this process (unit tests,
//     probes — no isolation, fastest).
//   - createWorkerChannel(): the core runs in a Node worker_threads worker
//     via worker-entry.mjs (per-run isolation: a hung or crashed sandbox
//     cannot take down the runner). This is the "Node/Bun worker threads"
//     host the roadmap §4 must-have names; a browser Web Worker transport
//     would implement the same run() over postMessage.
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HeadlessHost } from "./host.mjs";
import { parseResultFromLogs } from "./lane.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createInProcessChannel({ timeout = 30000 } = {}) {
  const host = new HeadlessHost({ timeout });
  return {
    kind: "in-process",
    async run(userCode, { fileName } = {}) {
      return host.execute(userCode, { fileName });
    },
  };
}

export function createWorkerChannel({ timeout = 30000 } = {}) {
  const workerPath = path.join(__dirname, "worker-entry.mjs");
  return {
    kind: "worker",
    /**
     * Run userCode in a fresh worker. The parent enforces the timeout:
     * on expiry the worker is terminated and a harnessError is reported
     * (never a hang, never a misattributed shim failure).
     */
    run(userCode, { fileName } = {}) {
      return new Promise((resolve) => {
        let settled = false;
        const done = (v) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          worker.terminate().catch(() => {});
          resolve(v);
        };
        // Parent-side margin over the worker's own HeadlessHost timeout.
        const timer = setTimeout(() => {
          done({ ok: false, harnessError: `worker timeout after ${timeout}ms` });
        }, timeout + 15000);
        if (typeof timer.unref === "function") timer.unref();

        let worker;
        try {
          worker = new Worker(workerPath, {
            workerData: { userCode, fileName, timeout },
            // vm.SourceTextModule needs the flag in the worker too.
            execArgv: ["--experimental-vm-modules"],
          });
        } catch (e) {
          done({ ok: false, harnessError: `worker spawn failed: ${e.message}` });
          return;
        }
        worker.on("message", (verdict) => {
          done(verdict);
        });
        worker.on("error", (e) => {
          done({ ok: false, harnessError: `worker error: ${e.message}` });
        });
        worker.on("exit", (code) => {
          done({
            ok: false,
            harnessError: `worker exited before verdict (code ${code})`,
          });
        });
      });
    },
  };
}

/**
 * Interpret a channel verdict for a parity test file.
 * A test passes when the sandbox posted function_results AND the
 * __RESULT__ marker says ok (with exitCode 0 and not skipped-as-fail).
 * Skips count as passed (same as the shim lane: skipped != failed).
 */
export function interpretVerdict(verdict, logs) {
  if (verdict.harnessError) {
    return { passed: false, harnessError: verdict.harnessError, detail: "" };
  }
  if (!verdict.ok) {
    return { passed: false, detail: verdict.error || "", harnessError: "" };
  }
  const parsed = parseResultFromLogs(logs || verdict.logs || []);
  if (!parsed) {
    return { passed: false, detail: "no __RESULT__ marker in sandbox logs", harnessError: "" };
  }
  if (parsed.skipped) {
    return { passed: true, skipped: true, detail: parsed.reason || "" };
  }
  if (!parsed.ok || (parsed.exitCode || 0) !== 0) {
    return { passed: false, detail: parsed.error || `exitCode ${parsed.exitCode}`, harnessError: "" };
  }
  return { passed: true, skipped: false, detail: "" };
}
