#!/usr/bin/env node
// parity/headless/host.mjs — HeadlessHost: the host side of the sandbox
// protocol without an iframe.
//
// This is the faithful adapter roadmap §4 allows: the sandbox core is the
// REAL generated template (SandboxRuntime.generate(), byte-identical to the
// iframe path), the message types are the REAL host protocol
// (interop_call/interop_response/interop_registered/function_results/
// function_error), the module pipeline is the REAL _dynamic_import +
// _build_file logic (plugin hooks, CJS<->ESM conversion, the
// globalThis._RUNTIME_ -> globalThis._RUNTIME<uuid>_ AST rewrite,
// transformImportsToLoadModule). Only the transport differs: node:vm +
// structured-clone hops instead of iframe postMessage.
//
// What the headless lane proves over the shim lane (parity/run.mjs):
//   - loadModule interop actually resolving through the host,
//   - taskTracker draining before function_results,
//   - the _RUNTIME<uuid>_ rewrite applying to real builtin sources,
//   - node_globals.js startup wiring installing Buffer/setImmediate/...,
//   - all with native delegation structurally impossible (the vm realm has
//     no host Node builtins; _RUNTIME_ is the real runtime object, not the
//     { parityForceShim: true } stub).
//
// Deliberate omissions vs the browser host (documented, not silent):
//   - No source-map registry composition (diagnostics-only).
//   - _bundler_ / preview / terminal / stdin interop: honest errors.
//   - Bare-specifier node_modules resolution: honest miss (parity tests
//     don't import npm packages; the browser host would try CDN).
import { randomUUID } from "node:crypto";
import {
  SandboxRuntime,
  ImportResolver,
  applyResolvePlugins,
  applyLoadPlugins,
  applyTransformPlugins,
  dispatchLoader,
  convertCjsToEsm,
  convertEsmToCjs,
  detectModuleSystem,
  replaceGlobalThisVar,
  transformImportsToLoadModule,
  builtinModules,
  repoRoot,
} from "./runtime-scope.mjs";
import { builtinSource, isBuiltinSpecifier } from "./builtin-source.mjs";
import { runInVmSandbox } from "./vm-sandbox.mjs";

const importResolver = new ImportResolver({ fallbackCDN: false });

function makeUuid() {
  return "_u_" + randomUUID().replace(/-/g, "");
}

/** Flatten {path: contents} like the browser host's unflattenFileSystem. */
function unflattenFileSystem(flatObj) {
  const result = {};
  for (const [rawPath, value] of Object.entries(flatObj || {})) {
    const parts = String(rawPath).replace(/^\/+/, "").split("/");
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part] || typeof current[part] !== "object") {
        current[part] = {};
      }
      current = current[part];
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

function lookupVfs(vfs, vfsPath) {
  const parts = String(vfsPath).replace(/^\/+/, "").split("/");
  let node = vfs;
  for (const part of parts) {
    if (!node || typeof node !== "object") return null;
    node = node[part];
  }
  return typeof node === "string" ? node : null;
}

/** The browser host's fetch adapter (createFetchAdapter in execute()). */
async function adaptedFetch(input, init) {
  const response = await globalThis.fetch(input, init);
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const contentType = (headers["content-type"] || "").toLowerCase();
  const isText =
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("javascript") ||
    contentType.includes("xml") ||
    contentType.includes("html") ||
    contentType.includes("urlencoded");
  let body;
  if (!isText) {
    const buffer = await response.arrayBuffer();
    body = new Uint8Array(buffer);
  } else {
    body = await response.text();
  }
  return {
    body,
    status: response.status,
    statusText: response.statusText,
    headers,
    ok: response.status >= 200 && response.status < 300,
    url: response.url,
    redirected: response.redirected,
    type: response.type,
  };
}

const DEFAULT_PROCESS = {
  title: "node",
  arch: "x64",
  platform: "linux",
  pid: 1,
  ppid: 0,
  argv: [],
  argv0: "node",
  execPath: "/usr/local/bin/node",
  execArgv: [],
  env: {},
  version: "v20.10.0",
  versions: { node: "20.10.0" },
};

export class HeadlessHost {
  /**
   * @param {object} [opts]
   * @param {number} [opts.timeout] per-execution ms (default 30000)
   * @param {object} [opts.process] sandbox process config
   * @param {object} [opts.fs] flat {path: contents} VFS seed
   * @param {Map} [opts.registeredInterop] exposed-method registry (for
   *   hasMethod-style assertions in tests)
   */
  constructor(opts = {}) {
    this.timeout = opts.timeout ?? 30000;
    this.processConfig = { ...DEFAULT_PROCESS, ...(opts.process || {}) };
    this.vfs = unflattenFileSystem(opts.fs || {});
    this.registeredInterop = opts.registeredInterop ?? new Map();
    this.interopHandlers = {
      _dynamic_import: this._dynamicImport.bind(this),
      _build_file: this._buildFile.bind(this),
      _fetch_: (url, options) => adaptedFetch(url, options),
      _bundler_: () => {
        throw new Error("[headless] _bundler_ is not supported in the headless lane");
      },
      // Adapter of the browser host's _getState: the sandbox imports the
      // returned source as a data: URL module for side effects. The browser
      // version installs EventEmitter-based stdin/stdout/stderr shims; the
      // headless lane installs the same observable surface (write/stdin
      // event API, hrtime.bigint) without terminal emulation.
      _getState: () => `
        (function () {
          function makeStdio(fd) {
            const listeners = {};
            const stream = {
              fd,
              isTTY: false,
              readable: fd === 0,
              writable: fd !== 0,
              columns: 80,
              rows: 24,
              on(ev, fn) {
                (listeners[ev] = listeners[ev] || []).push(fn);
                return stream;
              },
              once(ev, fn) {
                const wrap = (...a) => {
                  stream.removeListener(ev, wrap);
                  fn(...a);
                };
                return stream.on(ev, wrap);
              },
              removeListener(ev, fn) {
                if (listeners[ev]) {
                  listeners[ev] = listeners[ev].filter((f) => f !== fn);
                }
                return stream;
              },
              removeAllListeners(ev) {
                if (ev) delete listeners[ev];
                else for (const k of Object.keys(listeners)) delete listeners[k];
                return stream;
              },
              emit(ev, ...args) {
                for (const fn of [...(listeners[ev] || [])]) fn(...args);
                return true;
              },
              write(chunk, enc, cb) {
                if (typeof cb === "function") cb();
                return true;
              },
              end(cb) { if (typeof cb === "function") cb(); },
              pause() { return stream; },
              resume() { return stream; },
              // 97-finalize awaits this; no listeners means resolve now.
              waitUntilNoListeners() { return Promise.resolve(); },
            };
            return stream;
          }
          if (globalThis.process) {
            globalThis.process.stdin = globalThis.process.stdin || makeStdio(0);
            globalThis.process.stdout = globalThis.process.stdout || makeStdio(1);
            globalThis.process.stderr = globalThis.process.stderr || makeStdio(2);
            globalThis.process.hrtime = globalThis.process.hrtime || function hrtime(t) {
              const ms = performance.now();
              const s = Math.floor(ms / 1000);
              const ns = Math.floor((ms % 1000) * 1e6);
              if (t) return [s - t[0], ns - t[1]];
              return [s, ns];
            };
            globalThis.process.hrtime.bigint =
              globalThis.process.hrtime.bigint ||
              (() => BigInt(Math.floor(performance.now() * 1e6)));
          }
        })();
      `,
    };
  }

  registerInterop(name, handler) {
    this.interopHandlers[name] = handler;
    return this;
  }

  // ── _dynamic_import (adapter of the host handler in execute()) ──────────
  async _dynamicImport(path, type, entryPoint, parentEntryPoint, isNodeBuiltIn, cwd, vfsArg) {
    if (typeof path === "string" && path.startsWith("file://")) {
      path = path.slice("file://".length);
      if (!path.startsWith("/")) path = "/" + path;
    }
    if (isNodeBuiltIn || isBuiltinSpecifier(path, builtinModules)) {
      const source = builtinSource(path);
      if (source !== null) return { source, resolvedPath: null };
      // Same honest fallback as the browser host: generic stub, never throw.
      return { source: "export default {};", resolvedPath: null };
    }
    const isRelative = path.startsWith("./") || path.startsWith("../");
    const isAbsolute = path.startsWith("/");
    if (!isRelative && !isAbsolute) {
      // Headless lane: no node_modules/CDN resolution — honest miss, the
      // sandbox raises ERR_MODULE_NOT_FOUND.
      return null;
    }
    const base = entryPoint ? String(entryPoint).split("/").slice(0, -1).join("/") : "";
    const normalized = isAbsolute
      ? path
      : "/" + [...base.split("/").filter(Boolean), ...path.split("/")]
          .filter((p) => p && p !== ".")
          .join("/");
    // Collapse ".." segments.
    const parts = [];
    for (const seg of normalized.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg && seg !== ".") parts.push(seg);
    }
    const hit = lookupVfs(this.vfs, "/" + parts.join("/"));
    if (hit === null) {
      throw new Error(`[ERR_MODULE_NOT_FOUND]: Cannot find module '${path}'`);
    }
    return { source: hit, resolvedPath: "/" + parts.join("/") };
  }

  // ── _build_file (adapter of the host handler in execute()) ──────────────
  // Same pipeline, same order: plugin hooks -> loader dispatch -> module-kind
  // short-circuit -> CJS<->ESM conversion -> _RUNTIME_ AST rewrite (builtins
  // only) -> transformImportsToLoadModule. The source-map registry is
  // diagnostics-only and intentionally omitted (noted, not silent).
  async _buildFile(source, fileName, moduleType, entryPoint, parentEntryPoint, isNodeBuiltIn) {
    const pr = await applyResolvePlugins(fileName, entryPoint, null);
    const ns = (pr && pr.namespace) || "file";
    const lr = await applyLoadPlugins((pr && pr.path) || fileName, ns, source, null);
    const dispatched = dispatchLoader(lr.contents, lr.loader, fileName);
    if (dispatched.kind === "module") {
      if (moduleType === "require" && lr.loader !== "wasm") {
        const m = dispatched.source.match(/^export default ([\s\S]*?);?\s*$/);
        if (m) return `module.exports = ${m[1]};`;
      } else {
        return dispatched.source;
      }
    }
    source = dispatched.source;
    source = await applyTransformPlugins(source, fileName, null);

    const sourceModuleType = detectModuleSystem(source);
    if (moduleType === "import" && sourceModuleType.isCJS && !sourceModuleType.isESM) {
      source = convertCjsToEsm(source, { filename: fileName }).code;
    }
    if (moduleType === "require" && !sourceModuleType.isCJS && isNodeBuiltIn) {
      source = convertEsmToCjs(source, { filename: fileName }).code;
    }
    if (moduleType === "require" && !sourceModuleType.isCJS && !isNodeBuiltIn) {
      source = `throw new Error ("[ERR_REQUIRE_ESM]: Must use import to load ES Module: ... ${fileName}")`;
    }
    // The _RUNTIME_ -> _RUNTIME<uuid>_ AST rewrite: exactly what the
    // browser host applies to builtin sources.
    if (isNodeBuiltIn) {
      source = replaceGlobalThisVar(source, "_RUNTIME_", {
        replacement: `globalThis._RUNTIME${this._uuid}_`,
        filename: fileName,
      }).code;
    }
    const preserveRequireCalls =
      moduleType === "require" && sourceModuleType.isCJS && !sourceModuleType.isESM;
    source = transformImportsToLoadModule(this._uuid, source, fileName, entryPoint, {
      preserveRequireCalls,
    }).code;
    return source;
  }

  /**
   * Execute user code through the real sandbox runtime.
   * @param {string} userCode
   * @param {object} [opts]
   * @param {string} [opts.fileName]
   * @returns {Promise<{ok: boolean, logs?: any[], errors?: any[],
   *   executionTime?: number, error?: string, stack?: string,
   *   harnessError?: string, uuid: string}>}
   */
  async execute(userCode, opts = {}) {
    const fileName = opts.fileName || "index.js";
    this._uuid = makeUuid();
    const uuid = this._uuid;

    // Entry pipeline, mirroring CodeSandbox.execute(): ImportResolver
    // extracts static imports, then transformImportsToLoadModule lifts them
    // into the %%IMPORTS%% preamble with live bindings.
    const { imports, cleanedCode } = importResolver.resolve(userCode);
    const combinedCode =
      imports.length > 0 ? imports.join("\n") + "\n" + cleanedCode : cleanedCode;
    const mainTransform = transformImportsToLoadModule(uuid, combinedCode, fileName);

    const code = SandboxRuntime.generate(mainTransform.body, {
      imports: mainTransform.preamble ? [mainTransform.preamble] : [],
      logNetworkRequests: false,
      interopVariable: "interop",
      process: this.processConfig,
      fileName,
      uuid,
      fs: {},
      seaAssets: {},
      shell: null,
    });

    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ...v, uuid });
      };
      const timer = setTimeout(() => {
        done({ ok: false, harnessError: `execution timeout after ${this.timeout}ms` });
      }, this.timeout);
      // Don't let the watchdog hold the event loop open.
      if (typeof timer.unref === "function") timer.unref();

      let sandbox;
      const onHostMessage = async (msg) => {
        try {
          switch (msg.type) {
            case "interop_call": {
              const handler = this.interopHandlers[msg.method];
              if (!handler) {
                sandbox.postToSandbox({
                  type: "interop_response",
                  callId: msg.callId,
                  error: {
                    message: `[headless] no interop handler for ${msg.method}`,
                    name: "Error",
                  },
                });
                break;
              }
              try {
                const result = await handler(...(msg.args || []));
                sandbox.postToSandbox({
                  type: "interop_response",
                  callId: msg.callId,
                  result,
                });
              } catch (e) {
                sandbox.postToSandbox({
                  type: "interop_response",
                  callId: msg.callId,
                  error: {
                    message: String((e && e.message) || e),
                    code: e && e.code,
                    name: (e && e.name) || "Error",
                  },
                });
              }
              break;
            }
            case "interop_registered":
              this.registeredInterop.set(msg.name, true);
              break;
            case "sandbox_ready":
              break;
            case "function_results":
              done({ ok: true, logs: msg.logs, errors: msg.errors, executionTime: msg.executionTime });
              break;
            case "function_error":
              done({ ok: false, error: msg.error, stack: msg.stack, logs: msg.logs });
              break;
            case "window_error":
            case "unhandled_promise_rejection":
              done({ ok: false, error: msg.message || msg.reason, stack: msg.stack });
              break;
            default:
              break;
          }
        } catch (e) {
          done({ ok: false, harnessError: `host message dispatch failed: ${e.message}` });
        }
      };

      // Route the vm realm's unhandled rejections to the sandbox's
      // window.onunhandledrejection, like a browser would.
      const onUnhandled = (reason) => {
        try {
          const fn = sandbox?.context?.window?.onunhandledrejection;
          if (typeof fn === "function") fn({ reason });
        } catch {}
      };
      process.on("unhandledRejection", onUnhandled);

      // NOTE: evaluate() resolving does NOT mean the run finished. The
      // template's outer async IIFE is fire-and-forget at module top level
      // (the iframe stays alive the same way), so evaluation settles before
      // function_results/function_error is posted. The verdict message or
      // the watchdog timeout is the completion signal — never evaluate().
      runInVmSandbox({ code, uuid, fileName, onHostMessage })
        .then((sb) => {
          sandbox = sb;
          return sb.evaluate();
        })
        .then(() => {
          process.off("unhandledRejection", onUnhandled);
        })
        .catch((e) => {
          process.off("unhandledRejection", onUnhandled);
          done({ ok: false, harnessError: `template evaluation failed: ${e.message}` });
        });
    });
  }
}
