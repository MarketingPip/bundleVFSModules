// src/runtime/code-sandbox.js — extracted verbatim from runtime.js
// (lines 4032-6053: the CodeSandbox class), branch modular/sandbox. `export`
// added to CodeSandbox (the only change).
//
// NOTE on line numbers: the task brief assigned lines 3936-4900, but the
// CodeSandbox class actually spans runtime.js:4036-6053 (14 methods, not 8:
// run, runWasi, typecheck, getStats, reset and setTerminalSize live past
// line 4900). The full class is extracted here so the module is complete.
// The executeCode / createSandbox convenience functions (runtime.js:6062-6073)
// are NOT duplicated here — Worker F extracts them into src/runtime/entry.js
// (their assigned section); see WORKER-F-HOST-TODO.md.
//
// Static ESM imports (paths adjusted for src/runtime/; esm.sh specifiers kept
// verbatim — this module targets the browser host, like runtime.js):
import { v4 as uuid } from "https://esm.sh/uuid";
import {
  TraceMap,
  originalPositionFor,
} from "https://esm.sh/@jridgewell/trace-mapping";
import remapping from "https://esm.sh/@ampproject/remapping";
import {
  applyTransformPlugins,
  applyResolvePlugins,
  applyLoadPlugins,
  dispatchLoader,
  validatePlugin,
  getPlugins,
} from "../plugins.js";
import { lookupNativeInterception } from "../plugins/vite-browser.js";
//
// Host-provided bare references (still module scope in runtime.js; kept as-is
// like the original — the integration step will turn them into imports).
// Per the task brief, EventEmitter is NOT imported from Worker C's branch;
// it is documented here instead:
//   - EventEmitter              (runtime.js:2374; Worker C — CodeSandbox extends it;
//                                verbatim extraction already on main as src/runtime/events.js)
//   - ExecutionContext          (runtime.js:2810)
//   - ImportResolver            (runtime.js:2438, exported)
//   - SyntaxChecker             (runtime.js:2340, exported)
//   - mergeProcess              (runtime.js:371)
//   - convertEsmToCjs           (runtime.js:688, exported)
//   - convertCjsToEsm           (runtime.js:802, exported)
//   - detectModuleSystem        (runtime.js:1240)
//   - replaceGlobalThisVar      (runtime.js:1443, exported)
//   - transformImportsToLoadModule (runtime.js:1491, exported)
//   - flattenFileTree           (runtime.js:6300, exported)
//   - normalizeSeaAssets        (runtime.js:6215)
//   - formatErrors              (runtime.js:6115, exported)
//   - loadBuiltin               (runtime.js:216)
//   - fetchBuiltinSource        (runtime.js:130)
//   - isViteBrowserInterceptionActive (runtime.js:18)
// Browser globals used (method scope only, never module scope): document,
// HTMLIFrameElement.
// PRE-EXISTING ISSUE (copied exactly, not introduced here): the "_bundler_"
// interop handler calls `bundle(url).url`, but `bundle` is not defined
// anywhere in runtime.js — that path throws ReferenceError if executed.

// ============================================================================
// MAIN SANDBOX CLASS
// ============================================================================

export class CodeSandbox extends EventEmitter {
  constructor(options = {}) {
    const PROCESS_OBJECT = {
      title: "node",
      arch: "x64",
      env: {
        HOME: "/Users/username",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        USER: "username",
        PWD: "/project/directory",
        NODE_ENV: "development",
      },
      platform: "darwin",
      pid: 1,
      ppid: 0,
      argv: [],
      argv0: "node",
      execPath: "/usr/local/bin/node",
      execArgv: [],
      // Terminal dimensions. Overridable via options.process.stdout.columns/rows
      // (and .stderr); also updatable at runtime via setTerminalSize().
      stdout: { columns: 80, rows: 24 },
      stderr: { columns: 80, rows: 24 },
      version: "v20.10.0",
      versions: {
        node: "20.10.0",
        v8: "11.3.244.8-node.17",
        uv: "1.46.0",
        zlib: "1.2.13.1-motley",
        brotli: "1.0.9",
        ares: "1.20.1",
        modules: "115",
        nghttp2: "1.57.0",
        napi: "9",
        llhttp: "8.1.1",
        openssl: "3.0.12+quic",
        cldr: "43.1",
        icu: "73.2",
        tz: "2023c",
        unicode: "15.0",
      },
    };

    super();
    this.uuid = "_u_" + uuid().replace(/-/g, "");
    this.invoke = function () {
      throw new Error("Sandbox is not running.");
    };
    this.interopHandlers = {};
    // Registry for source maps: sourceURL -> { map, originalSource, filename }
    // Populated by _build_file, used for parent-side error mapping.
    this._sourceMapRegistry = new Map();
    this.iframeElement = null;
    this.beforeExecute = options?.beforeExecute || null; // array
    this.destroyIframe = true;
    this.iframeElement = options.iframeElement ?? null; // string or querySelector

    this._serverRunning = false;

    if (options.process) {
      options.process = mergeProcess(options.process, PROCESS_OBJECT);
    }

    this.config = {
      timeout: options.timeout || 30000, // Number or infity
      logNetworkRequests: options.logNetworkRequests ?? false,
      captureWindowErrors: options.captureWindowErrors ?? true,
      capturePromiseRejections: options.capturePromiseRejections ?? true,
      cdnBase: options.cdnBase || "https://esm.sh",
      ecmaVersion: options.ecmaVersion || 2022,
      transformRules: options.transformRules || [],
      codeTransformers: options.codeTransformers || [], // array
      fallbackCDN: options.fallbackCDN ?? true, // boolean
      interopVariable: options.interopVariable || "interop", // string
      process: options?.process || PROCESS_OBJECT, // array
      fileName: options?.fileName || "index.js", // string,
      fs: options?.fs || {},
      // Virtual node:sea asset store (mirrors 'fs' -> __USER_FILES__).
      // { [key]: string | Uint8Array | ArrayBuffer | { encoding: 'utf8'|'base64', data: string } }
      // Normalized by normalizeSeaAssets() and published as __SEA_ASSETS__.
      seaAssets: options?.seaAssets || {},
      // BYO shell (Jared 2026-10-03): developers bring their own shell
      // function (real bash via bridge, hand-rolled fake, etc.). If provided,
      // child_process calls route to it. If not provided, shell calls throw.
      // The function is serialized via .toString() into the sandbox — it must
      // be self-contained (no closure references).
      shell: options?.shell ?? null,
    };

    // Validate the shell option early: must be a function or null/undefined.
    if (this.config.shell != null && typeof this.config.shell !== "function") {
      throw new TypeError("CodeSandbox option 'shell' must be a function");
    }

    // Per-sandbox plugin list (docs/PLUGINS.md Part B §5): when provided,
    // this sandbox uses ONLY these plugins — the global registry is
    // shadowed for it. Null (default) means "use the global registry".
    // Validated and snapshotted here; the _build_file/_dynamic_import
    // interop handlers below read this.plugins at call time.
    if (options?.plugins != null) {
      if (!Array.isArray(options.plugins)) {
        throw new TypeError("CodeSandbox option 'plugins' must be an array");
      }
      const names = new Set();
      for (const p of options.plugins) {
        validatePlugin(p);
        if (names.has(p.name)) {
          throw new Error(
            `Duplicate plugin name '${p.name}' in 'plugins' option`,
          );
        }
        names.add(p.name);
      }
      this.plugins = [...options.plugins];
    } else {
      this.plugins = null;
    }

    if (this.iframeElement) {
      const value = this.iframeElement;

      if (typeof value === "string") {
        // Treat as query selector string
        this.iframeElement = document.querySelector(value);

        if (!this.iframeElement) {
          throw new Error(`No element found for selector: ${value}`);
        }
      } else if (value instanceof HTMLIFrameElement) {
        // Direct iframe element provided
        this.iframeElement = value;
      } else {
        throw new Error(
          "iframeElement must be a query selector string or an <iframe> element",
        );
      }

      this.destroyIframe = false;
    }

    this.importResolver = new ImportResolver({
      cdnBase: this.config.cdnBase,
      transformRules: this.config.transformRules,
      fallbackCDN: this.config.fallbackCDN,
    });

    this.initialized = false;
    this.executionCount = 0;
  }

  registerInterop(name, handler) {
    this.interopHandlers[name] = handler;
    return this;
  }

  // NEW: Remove interop handler
  unregisterInterop(name) {
    delete this.interopHandlers[name];
    return this;
  }

  /**
   * Map structured stack frames (from the sandbox) back to original source
   * positions using the _sourceMapRegistry populated by _build_file.
   *
   * Each frame: { file, line, column } (from __parseStackLocation).
   * Returns: [{ file, line, column, internal, source }, ...]
   *   - internal=true for frames with no registry entry (runtime internals,
   *     esm.sh CDN modules, etc.) — shown collapsed or hidden.
   */
  _mapStackFrames(frames, runtimeCode) {
    if (!Array.isArray(frames)) return [];
    // Registry maps are relative to the transformed user snippet
    // (mainTransform.code), but stack frames report lines in the full
    // generated runtime. Subtract the boilerplate offset for main-entry
    // frames so TraceMap lookups land on the snippet's line numbering.
    // Imported-module frames (own data: URLs) already use snippet-relative
    // lines, so the offset only applies to the main entry key.
    const mainKey = `sandbox://${this.uuid}/${this.config && this.config.fileName}`;
    let boilerplateOffset = 0;
    if (typeof runtimeCode === "string") {
      const markerIdx = runtimeCode.indexOf("//__$PROVIDED_RUNTIME_CODE__/");
      if (markerIdx !== -1)
        boilerplateOffset = runtimeCode.slice(0, markerIdx).split("\n").length;
    }
    return frames.map((frame) => {
      let entry =
        frame && frame.file ? this._sourceMapRegistry.get(frame.file) : null;
      let entryKey = frame?.file || null;
      if (
        !entry &&
        typeof frame?.file === "string" &&
        frame.file.startsWith("data:")
      ) {
        // Imported modules execute from data: URLs whose sourceURL trailer
        // names the module path (e.g. //# sourceURL=./helper.js). The
        // registry is keyed sandbox://<uuid>/<modulePath>: match by suffix.
        try {
          const comma = frame.file.indexOf(",");
          const decoded = decodeURIComponent(frame.file.slice(comma + 1));
          const m = decoded.match(/\/\/# sourceURL=(\S+)\s*$/);
          if (m) {
            const want = m[1];
            for (const k of this._sourceMapRegistry.keys()) {
              if (k === want || k.endsWith("/" + want)) {
                entryKey = k;
                entry = this._sourceMapRegistry.get(k);
                break;
              }
            }
          }
        } catch (e) {
          /* leave entry null -> internal frame */
        }
      }
      if (!entry || !entry.map) {
        return {
          file: frame?.file || null,
          line: frame?.line ?? null,
          column: frame?.column ?? null,
          internal: true,
          source: frame?.file || null,
        };
      }
      try {
        // V8 stack columns are 1-based; trace-mapping expects 0-based
        // generated columns and returns 0-based original columns.
        const tracer = new TraceMap(entry.map);
        const offset = frame.file === mainKey ? boilerplateOffset : 0;
        const pos = originalPositionFor(tracer, {
          line: frame.line - offset,
          column: (frame.column || 1) - 1,
        });
        if (!pos || pos.line == null) {
          return {
            file: entry.filename || frame.file,
            line: null,
            column: null,
            internal: true,
            source: frame.file,
          };
        }
        return {
          file: pos.source || entry.filename || frame.file,
          line: pos.line,
          // Convert back to 1-based for display
          column: (pos.column ?? 0) + 1,
          internal: false,
          source: entryKey,
        };
      } catch (err) {
        return {
          file: entry.filename || frame?.file || null,
          line: frame?.line ?? null,
          column: frame?.column ?? null,
          internal: true,
          source: frame?.file || null,
        };
      }
    });
  }

  /**
   * Format a mapped error with original source context.
   * Uses the originalSource stored in the registry to render the code frame.
   */
  _formatMappedError(errorName, message, mappedFrames) {
    const lines = [`${errorName || "Error"}: ${message || "Unknown error"}`];

    // Find the registry entry for the first non-internal frame to get source.
    let contextRendered = false;
    for (const frame of mappedFrames) {
      if (frame.internal) continue;
      const entry = this._sourceMapRegistry.get(frame.source);
      const src = entry?.originalSource;
      if (src && frame.line) {
        const srcLines = src.split("\n");
        const start = Math.max(0, frame.line - 3);
        const end = Math.min(srcLines.length, frame.line + 2);
        const context = srcLines
          .slice(start, end)
          .map((l, idx) => {
            const actualLine = start + idx + 1;
            const marker = actualLine === frame.line ? "→" : " ";
            return `${marker} ${String(actualLine).padStart(4)} | ${l}`;
          })
          .join("\n");
        lines.push(`at (${frame.file}:${frame.line}:${frame.column})`);
        lines.push("", context);
        contextRendered = true;
        break;
      }
    }

    // Fallback: list mapped frames without source context
    if (!contextRendered) {
      for (const frame of mappedFrames.slice(0, 10)) {
        if (frame.internal) continue;
        lines.push(`at (${frame.file}:${frame.line}:${frame.column})`);
      }
    }

    return lines.join("\n");
  }

  kill(reason = "Process killed by user") {
    if (!this._context || !this._context.running) {
      console.warn("[Sandbox] kill() called but sandbox is not running.");
      return false;
    }
    this._context.forceKill(reason);
    return true;
  }

  /**
   * Initialize the sandbox (load dependencies)
   */
  async init() {
    if (this.initialized) return;

    try {
      this.initialized = true;
      this.emit("initialized", { timestamp: Date.now() });
    } catch (err) {
      this.emit("error", { type: "initialization", error: err.message });
      throw err;
    }
  }

  /**
   * Execute code in sandboxed environment
   * @param {string} code - JavaScript code to execute
   * @returns {Promise<ExecutionResult>}
   */
  async execute(code) {
    this.trueCode = code;

    if (typeof this.beforeExecute === "function") {
      await this.beforeExecute(); // dev might want to update something in config - such as process argv.
    }

    if (!this.initialized) {
      await this.init();
    }

    this.executionCount++;
    const executionId = this.executionCount;

    return new Promise(async (resolve, reject) => {
      // Create isolated iframe

      const iframe = this.iframeElement || document.createElement("iframe");

      iframe.sandbox = "allow-scripts allow-same-origin allow-unsafe-eval";
      if (!this.iframeElement) {
        iframe.style.cssText =
          "position: absolute; width: 0; height: 0; border: 0;";
      }

      const context = new ExecutionContext(iframe, this);
      this.iframe = iframe;
      this._context = context;
      this.invoke = context.invoke.bind(context);
      this.serverRunning = context.serverRunning.bind(context);
      this.hasMethod = context.hasMethod.bind(context);

      function createFetchAdapter(fetchImpl) {
        return async function adaptedFetch(input, init) {
          const response = await fetchImpl(input, init);

          const headers = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });

          const contentType = (headers["content-type"] || "").toLowerCase();

          // Text types we explicitly want as strings
          const isText =
            contentType.startsWith("text/") ||
            contentType.includes("json") ||
            contentType.includes("javascript") ||
            contentType.includes("xml") ||
            contentType.includes("html") ||
            contentType.includes("urlencoded");

          let body;
          if (!isText) {
            // Treat everything else (wasm, images, zips, octet-streams, etc.) as binary
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
            url: input,
          };
        };
      }

      /// Functions passed as options / AbortController Missing etc..
      this.registerInterop("_fetch_", async (url, options) => {
        const adaptedFetch = createFetchAdapter(fetch);

        const res = await adaptedFetch(url, options);

        return res;
        // A JSON response must be returned like this so it can be serialized through post message.
        /*   return {
  body: JSON.stringify({ mocked: true }),
  status: 200,
  statusText: "OK",
  headers: { "Content-Type": "application/json" }
};*/
      });

      this.registerInterop("_bundler_", async (url) => {
        function isEsmSh(url) {
          return /^https?:\/\/esm\.sh\//.test(url);
        }

        function toBundleUrl(url) {
          if (!isEsmSh(url) || url.includes("?bundle")) return url;
          return url + (url.includes("?") ? "&bundle" : "?bundle");
        }

        return await bundle(url).url;
      });

      this.registerInterop(
        "_build_file",
        async (
          source,
          fileName,
          moduleType,
          entryPoint,
          parentEntryPoint,
          isNodeBuiltIn,
        ) => {
          // Part B plugin hooks: onResolve tags the namespace, onLoad decides
          // how the path loads, and the loader dispatch produces the module.
          // The namespace is re-derived here from fileName (no interop
          // signature change): _dynamic_import may rewrite the specifier,
          // but filters match the resolved path in the spec's examples.
          // PluginError propagates via the interop error channel → the
          // iframe converts it to function_error ({success:false,...}).
          const __pr = await applyResolvePlugins(
            fileName,
            entryPoint,
            this.plugins,
          );
          const __ns = (__pr && __pr.namespace) || "file";
          const __lr = await applyLoadPlugins(
            (__pr && __pr.path) || fileName,
            __ns,
            source,
            this.plugins,
          );
          const __dispatched = dispatchLoader(
            __lr.contents,
            __lr.loader,
            fileName,
          );
          if (__dispatched.kind === "module") {
            // json/text/wasm: final ESM, skip transform — BUT respect the
            // require() caller's contract. The sandbox-side loadModule wraps
            // require() targets with wrapCommonJS(); feeding it a top-level
            // `export` is a SyntaxError ("export declarations may only appear
            // at top level"). For the statically-analyzable json/text
            // loaders, emit CJS instead; wasm keeps ESM (top-level await
            // can't become CJS — the ERR_REQUIRE_ESM path below handles it).
            if (moduleType === "require" && __lr.loader !== "wasm") {
              const m = __dispatched.source.match(
                /^export default ([\s\S]*?);?\s*$/,
              );
              if (m) {
                return `module.exports = ${m[1]};`;
              }
              // Fallthrough: unparseable ESM → ERR_REQUIRE_ESM below.
            } else {
              return __dispatched.source;
            }
          }
          source = __dispatched.source; // js: continue through the pipeline

          // Plugin transforms run FIRST, before detectModuleSystem: a .ts
          // source's type annotations are not parseable JS, so the plugin
          // must produce valid JS before the acorn-based pipeline runs.
          // (docs/PLUGINS.md Part B; src/plugins.js documents the hook.)
          // Note: only the "js" loader reaches here — json/text/wasm
          // returned above as final ESM.
          source = await applyTransformPlugins(source, fileName, this.plugins);

          const sourceModuleType = detectModuleSystem(source);
          const originalSource = source;

          // Collect maps from each transform for composition.
          // Each map goes from that transform's output back to its input.
          const maps = [];

          if (
            moduleType === "import" &&
            sourceModuleType.isCJS &&
            !sourceModuleType.isESM
          ) {
            const result = convertCjsToEsm(source, { filename: fileName });
            source = result.code;
            if (result.map) maps.push(result.map);
          }

          if (
            moduleType === "require" &&
            !sourceModuleType.isCJS &&
            isNodeBuiltIn
          ) {
            const result = convertEsmToCjs(source, { filename: fileName });
            source = result.code;
            if (result.map) maps.push(result.map);
          }

          if (
            moduleType === "require" &&
            !sourceModuleType.isCJS &&
            !isNodeBuiltIn
          ) {
            source = `throw new Error ("[ERR_REQUIRE_ESM]: Must use import to load ES Module: ... ${fileName}")`;
            // No map for synthetic error throw; position mapping not applicable.
          }

          // replace our special variable for runtime.
          if (isNodeBuiltIn) {
            const result = replaceGlobalThisVar(source, "_RUNTIME_", {
              replacement: `globalThis._RUNTIME${this.uuid}_`,
              filename: fileName,
            });
            source = result.code;
            if (result.map) maps.push(result.map);
          }

          // Todo track parent entry module (in loadModule() & transformModules)
          if (fileName != entryPoint) {
            // console.log('Building ${fileName} for ${entryPoint} - for imported module: ${parentEntryPoint}')
          }

          // For CommonJS modules loaded via require(), keep require() calls
          // intact so the runtime's sync __syncRequire__ handles nested
          // requires (rewriting them to awaited loadModule() calls would
          // break the sync IIFE wrapper with a SyntaxError).
          const preserveRequireCalls =
            moduleType === "require" &&
            sourceModuleType.isCJS &&
            !sourceModuleType.isESM;
          const importResult = transformImportsToLoadModule(
            this.uuid,
            source,
            fileName,
            entryPoint,
            { preserveRequireCalls },
          );
          source = importResult.code;
          if (importResult.map) maps.push(importResult.map);

          // Compose all collected maps into a single map: final output -> original source.
          // remapping() expects the chain ordered LAST transform first, but
          // maps[] is pushed in first-transform-first order, so reverse it.
          // (Wrong order silently yields an empty composed map.)
          if (maps.length > 0) {
            try {
              const composed = remapping([...maps].reverse(), () => null);
              const sourceURL = `sandbox://${this.uuid}/${fileName}`;
              this._sourceMapRegistry.set(sourceURL, {
                map: composed,
                originalSource,
                filename: fileName,
              });
            } catch (mapErr) {
              console.warn(
                "[source-map] Failed to compose maps for",
                fileName,
                mapErr,
              );
            }
          }

          return source;
        },
      );

      this.registerInterop("_getState", async () => {
        function seralize(fn) {
          return JSON.stringify(fn);
        }

        return `
 
 
(function () {

  function EventEmitter() {
    this._events = Object.create(null);
  }

  EventEmitter.prototype.on = function (ev, fn) {
    if (!this._events[ev]) this._events[ev] = [];
    this._events[ev].push({ fn, once: false });
    this.emit('newListener', ev, fn);
    return this;
  };

  EventEmitter.prototype.once = function (ev, fn) {
    if (!this._events[ev]) this._events[ev] = [];
    this._events[ev].push({ fn, once: true });
    this.emit('newListener', ev, fn);
    return this;
  };

  EventEmitter.prototype.off = function (ev, fn) {
    if (!this._events[ev]) return this;
    this._events[ev] = this._events[ev].filter(e => e.fn !== fn);
    this.emit('removeListener', ev, fn);
    return this;
  };
  EventEmitter.prototype.removeListener = EventEmitter.prototype.off;

  EventEmitter.prototype.removeAllListeners = function (ev) {
    if (ev) { delete this._events[ev]; }
    else     { this._events = Object.create(null); }
    // Removal without an explicit 'removeListener' event must still let the
    // completion gate re-check (stdin hooks _checkResolve on removeListener).
    if (typeof this._checkResolve === 'function') this._checkResolve();
    return this;
  };

  EventEmitter.prototype.emit = function (ev, ...args) {
    const list = this._events[ev];
    if (!list || list.length === 0) return false;
    const snapshot = [...list];
    const dropped = list.filter(e => e.once);
    this._events[ev] = list.filter(e => !e.once);
    // Node semantics: a once-listener removed by firing emits
    // 'removeListener'. This releases the stdin completion gate: a one-shot
    // 'data' listener must not hold completion forever after it fires.
    for (const e of dropped) {
      if (ev !== 'removeListener') this.emit('removeListener', ev, e.fn);
    }
    for (const e of snapshot) e.fn(...args);
    return true;
  };

  EventEmitter.prototype.listeners = function (ev) {
    return (this._events[ev] || []).map(e => e.fn);
  };

  EventEmitter.prototype.listenerCount = function (ev) {
    return (this._events[ev] || []).length;
  };

  EventEmitter.prototype.rawListeners = function (ev) {
    return [...(this._events[ev] || [])];
  };

  const stdin = Object.assign(new EventEmitter(), {

    _encoding : null,
    _isRaw    : false,
    _paused   : false,
    _ended    : false,
    _lineBuffer: "",
    _waitResolve : null,
    _waitPromise : null,
    isTTY     : true,
    readable  : true,
    fd        : 0,

    setEncoding(enc) {
      this._encoding = enc;
      return this;
    },

    setRawMode(value) {
      this._isRaw = !!value;
      if (this._isRaw && this._lineBuffer.length > 0) {
        this._dispatch(this._lineBuffer);
        this._lineBuffer = "";
      }
      return this;
    },

    resume() {
      this._paused = false;
      return this;
    },

    pause() {
      this._paused = true;
      return this;
    },

    isPaused() { return this._paused; },
    get isRaw()    { return this._isRaw;  },

    end() {
      if (this._ended) return;
      this._ended = true;
      this.readable = false;
      this.emit('end');
      this.emit('close');
      this._checkResolve();
    },

    destroy(err) {
      if (err) this.emit('error', err);
      this.end();
    },

    _decode(chunk) {
      if (this._encoding && typeof chunk !== 'string')
        return chunk.toString(this._encoding);
      return chunk;
    },

    _dispatch(chunk) {
      const data = this._decode(chunk);
      this.emit('data', data);

      if (typeof data === 'string') {
        if (this._isRaw) {
          // one pushData() call == one physical keypress in raw mode
          const keyEvent = _parseKey(data);
          this.emit('keypress', data, keyEvent);
          if (typeof emitMe === 'function') {
            emitMe('key_event', null, keyEvent);
          }
        } else {
          for (const ch of data) {
            const keyEvent = _parseKey(ch);
            this.emit('keypress', ch, keyEvent);
            if (typeof emitMe === 'function') {
              emitMe('key_event', null, keyEvent);
            }
          }
        }
      }
    },

    _checkResolve() {
      // Count only the events that hold the completion gate (same list as
      // waitUntilNoListeners). The runtime's own internal 'newListener' /
      // 'removeListener' bookkeeping listeners are attached for the whole
      // sandbox lifetime and must not hold completion — counting them made
      // the total unreachable, so listener removal could never release the
      // gate (only stdin.end()/destroy() did).
      const relevant = ['data', 'end', 'close', 'error', 'keypress'];
      const totalListeners = relevant.reduce(
        (n, ev) => n + ((this._events[ev] || []).length), 0);
      if ((this._ended || totalListeners === 0) && this._waitResolve) {
        this._waitResolve();
        this._waitResolve = null;
        this._waitPromise = null;
      }
    },

pushData2(chunk) {
    if (this._ended || this._paused) return;

    if (this._isRaw) {
      this._dispatch(chunk);
      return;
    }

    if (chunk === '\\x7f' || chunk === '\\b') {
      this._lineBuffer = this._lineBuffer.slice(0, -1);
      return;
    }

    this._lineBuffer += chunk;

    const nl = this._lineBuffer.search(/[\\n\\r]/);
    if (nl !== -1) {
      const line = this._lineBuffer.slice(0, nl);
      // Keep everything after the newline in the buffer
      this._lineBuffer = this._lineBuffer.slice(nl + 1);
      this._dispatch(line + '\\n'); // Ensure the newline is preserved/dispatched
    }
  },

 

pushData(chunk) {
  if (this._ended || this._paused) return;

  if (this._isRaw) {
    this._dispatch(chunk);
    return;
  }

  // Non-raw (line-buffered) mode: interpret control chars instead of
  // blindly concatenating them into the line buffer.
  if (chunk === '\\x7f' || chunk === '\\b') {
    this._lineBuffer = this._lineBuffer.slice(0, -1);
    return;
  }

  this._lineBuffer += chunk;

  const nl = this._lineBuffer.search(/[\\n\\r]/);
  if (nl !== -1) {
    // Dispatch only up to (not including) the newline, and keep
    // anything typed after it (rare, but avoids losing/duplicating
    // characters from a chunk that contains more than one line).
    const line = this._lineBuffer.slice(0, nl);
    this._lineBuffer = this._lineBuffer.slice(nl + 1);
    this._dispatch(line);
    emitMe("newline", true)
  }
},

    waitUntilNoListeners() {
      if (this._ended) return Promise.resolve();
      const relevant = ['data','end','close','error','keypress'];
      const count = relevant.reduce(
        (n, ev) => n + this.listenerCount(ev), 0
      );
      if (count === 0) return Promise.resolve();
      if (!this._waitPromise) {
        this._waitPromise = new Promise(res => { this._waitResolve = res; });
      }
      return this._waitPromise;
    },

    read()    { return null; },
    pipe(dest) {
      this.on('data', chunk => dest.write && dest.write(chunk));
      this.on('end',  ()    => dest.end   && dest.end());
      return dest;
    },
    unpipe(dest) { return this; },
    unshift() { },
  });

  stdin.on('removeListener', () => stdin._checkResolve());

  // Flush buffered early stdin input when the first 'data' listener attaches.
  // Deferred via queueMicrotask to avoid reentrancy: 'newListener' fires
  // synchronously from within on(), so pushData must not run until on()
  // has returned and the handler is fully registered.
  stdin.on('newListener', (ev) => {
    if (ev === 'data' && stdin._pendingStdin && stdin._pendingStdin.length) {
      const pending = stdin._pendingStdin;
      stdin._pendingStdin = [];
      queueMicrotask(() => {
        pending.forEach((chunk) => stdin.pushData(chunk));
      });
    }
  });

 //const { Writable } = require('stream');

function makeOutputShim2(type) {
  const isError = type === 'stderr';
  
  // Inherit from Writable to get all internal Node logic for free
  const stream = new Writable({
    decodeStrings: false, // Prevents automatic conversion of strings to buffers
    write(chunk, encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
      
      // Use process.binding or low-level write if you want to avoid console.log
      // but for a shim, this is the safest way to ensure output visibility.
      if (isError) {
        process.stderr.write(data); 
      } else {
        process.stdout.write(data);
      }
      
      // Node specs require calling the callback to signal the write is finished
      callback();
    }
  });

  // TTY Specific properties required by CLI tools (like chalk or inquirer)
  Object.defineProperties(stream, {
    isTTY: { value: true },
    fd: { value: isError ? 2 : 1 },
    columns: { value: process.stdout.columns || 80, writable: true },
    rows: { value: process.stdout.rows || 24, writable: true },
    isRaw: { value: false, writable: true }
  });

  // Mandatory TTY methods for cursor manipulation
  stream.clearLine = (dir, cb) => { if (cb) cb(); return true; };
  stream.cursorTo = (x, y, cb) => { if (cb) cb(); return true; };
  stream.moveCursor = (dx, dy, cb) => { if (cb) cb(); return true; };
  stream.getColorDepth = () => 8; // Reports 256-color support

  return stream;
}

  function makeOutputShim(stream) {
    // Honor a configured initial size (options.process.stdout.columns/rows,
    // serialized into the runtime singleton); falls back to 80x24.
    const rtProcess = globalThis._RUNTIME${this.uuid}_ && globalThis._RUNTIME${this.uuid}_.process;
    const prev = rtProcess && rtProcess[stream];
    const initCols = prev && Number.isFinite(+prev.columns) && +prev.columns > 0
      ? Math.floor(+prev.columns) : 80;
    const initRows = prev && Number.isFinite(+prev.rows) && +prev.rows > 0
      ? Math.floor(+prev.rows) : 24;
    const s = Object.assign(new EventEmitter(), {
      isTTY    : true,
      writable : true,
      fd       : stream === 'stderr' ? 2 : 1,
      columns  : initCols,
      rows     : initRows,
      write(data, enc, cb) {
        console[stream === 'stderr' ? 'error' : 'log'](
          typeof data === 'string' ? data : data.toString(enc || 'utf8')
        );
        if (typeof enc === 'function') enc();
        else if (typeof cb === 'function') cb();
        return true;
      },
      end() {},
      destroy() {},
      clearLine(dir, cb)      { if (cb) cb(); return true; },
      cursorTo(x, y, cb)     { if (cb) cb(); return true; },
      moveCursor(dx, dy, cb) { if (cb) cb(); return true; },
    });
    return s;
  }
  
  //globalThis.process        = globalThis.process || {};
  globalThis.process.stdin  = stdin; 
  globalThis.process.stdout = makeOutputShim('stdout');
  globalThis.process.stderr = makeOutputShim('stderr');
 
  globalThis.process.hrtime.bigint = () => BigInt(Math.floor(performance.now() * 1e6));
 
function _parseKey(s) {
  const specials = {
    '\\x1b[A': 'up', '\\x1b[B': 'down', '\\x1b[C': 'right', '\\x1b[D': 'left',
    '\\x1b[H': 'home', '\\x1b[F': 'end',
    '\\x1b[3~': 'delete', '\\x1b[2~': 'insert',
    '\\x1b[5~': 'pageup', '\\x1b[6~': 'pagedown',
    '\\x1b': 'escape', '\\r': 'return', '\\n': 'return',
    '\\t': 'tab', '\\x7f': 'backspace', '\\b': 'backspace',
  };

  if (specials[s]) {
    return { name: specials[s], ctrl: false, meta: false, shift: false, sequence: s };
  }

  if (s.length === 1) {
    const code = s.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      return { name: String.fromCharCode(code + 96), ctrl: true, meta: false, shift: false, sequence: s };
    }
    return { name: s.toLowerCase(), ctrl: false, meta: false, shift: s !== s.toLowerCase(), sequence: s };
  }

  return { name: 'unknown', ctrl: false, meta: false, shift: false, sequence: s };
}

})();
         `;
      });

      /**
       * Resolve a relative import path against the importing file's location,
       * then look it up in the VFS. Returns { resolvedPath, source } or null.
       *
       * @param {string} modulePath      - e.g. '../math.js'
       * @param {string} fromFile        - e.g. 'src/utils/math2.js'  (the file containing the import)
       * @param {object} vfs             - your nested VFS object
       */
      function resolveVFS(modulePath, fromFile, vfs) {
        // 1. Build an absolute-style path by joining fromFile's dir + modulePath
        const fromDir = fromFile
          ? fromFile.split("/").slice(0, -1).join("/")
          : "";
        const joined = fromDir ? `${fromDir}/${modulePath}` : modulePath;

        // 2. Normalize away . and .. segments
        const parts = joined.split("/");
        const resolved = [];
        for (const part of parts) {
          if (part === "..") resolved.pop();
          else if (part !== ".") resolved.push(part);
        }
        // 3. Ensure absolute VFS path (leading slash) for consistency.
        // Without this, relative resolvedPaths cascade: a relative importer
        // produces a relative resolvedPath, which becomes the next importer.
        let resolvedPath = resolved.join("/");
        if (!resolvedPath.startsWith("/")) resolvedPath = "/" + resolvedPath;

        // 4. Walk the VFS tree
        const source = vfsLookup(resolvedPath, vfs);
        return source != null ? { resolvedPath, source } : null;
      }

      /**
       * Walk a nested VFS object using a normalised path string.
       * Tries the path as-is, then with .js appended.
       * Platform fix (AGENTS.md rule 6): in the browser, prefer
       * `-browser.js` variants over `.cjs` files. Vendors ship both
       * (e.g. rolldown-binding.wasi.cjs for Node, .wasi-browser.js for
       * browsers); the CJS build requires Node builtins that don't exist
       * here. This is platform-general, not library-specific.
       */
      function vfsLookup(path, vfs) {
        const tryPath = (p) => {
          const segments = p.split("/").filter(Boolean);
          let node = vfs;
          for (const seg of segments) {
            if (node == null || typeof node !== "object") return undefined;
            node = node[seg];
          }
          return typeof node === "string" ? node : undefined;
        };

        // Prefer browser variant for .cjs requests.
        if (path.endsWith(".cjs")) {
          const browserVariant = path.replace(/\.cjs$/, "-browser.js");
          const hit = tryPath(browserVariant);
          if (hit !== undefined) return hit;
        }

        return (
          tryPath(path) ??
          tryPath(path.endsWith(".js") ? path : `${path}.js`) ??
          undefined
        );
      }
      /**
       * General WASM data-URL inlining for the package-loading path.
       * Vendored WASM builds reference their binary via
       * `new URL("<rel>.wasm", import.meta.url)`. Modules served by the
       * parent _dynamic_import handler execute from `data:` URLs, where
       * import.meta.url IS the data: URL — relative resolution throws.
       * This rewrites such references to `data:application/wasm;base64,...`
       * using the bytes resolved from the VFS relative to the module's own
       * path. Platform-general (any package), not rollup-specific. A
       * missing/unresolvable wasm file is left untouched (honest miss).
       *
       * Worker scripts: WASI browser builds (e.g. @rolldown/browser) spawn
       * workers via `new URL('./wasi-worker-browser.mjs', import.meta.url)`,
       * which throws the same TypeError from a data: URL base. `.mjs`/`.js`
       * references are inlined as `data:text/javascript;base64,...` — the
       * 1.5KB worker file inlines cleanly; `new Worker(dataUrl)` works.
       */
      function inlineWasmDataUrls(source, moduleVfsPath, vfs) {
        if (typeof source !== "string" || !source.includes("import.meta.url"))
          return source;
        const dir = String(moduleVfsPath || "")
          .split("/")
          .slice(0, -1);
        const lookupNode = (absPath) => {
          const segs = absPath.split("/").filter(Boolean);
          let node = vfs;
          for (const s of segs) {
            if (node == null || typeof node !== "object") return undefined;
            node = node[s];
          }
          return node;
        };
        const mimeFor = (rel) => {
          if (rel.endsWith(".wasm")) return "application/wasm";
          if (rel.endsWith(".mjs") || rel.endsWith(".js"))
            return "text/javascript";
          return null;
        };
        return source.replace(
          /new URL\(\s*(['"])([^'"]*?\.(?:wasm|mjs|js))\1\s*,\s*import\.meta\.url\s*\)/g,
          (m, _q, rel) => {
            const mime = mimeFor(rel);
            if (!mime) return m;
            const parts = [...dir];
            for (const seg of rel.split("/")) {
              if (seg === "..") parts.pop();
              else if (seg !== "." && seg !== "") parts.push(seg);
            }
            const node = lookupNode("/" + parts.join("/"));
            let b64;
            if (
              node &&
              typeof node === "object" &&
              node.encoding === "base64" &&
              typeof node.data === "string"
            ) {
              b64 = node.data;
            } else if (typeof node === "string") {
              // Plain UTF-8 string content (e.g. .mjs worker files in the
              // seed are not base64-enveloped). Encode at rewrite time.
              // btoa handles the ASCII-safe worker script; for general
              // UTF-8 use the TextEncoder path.
              try {
                b64 = btoa(node);
              } catch {
                const bytes = new TextEncoder().encode(node);
                let bin = "";
                for (let i = 0; i < bytes.length; i++)
                  bin += String.fromCharCode(bytes[i]);
                b64 = btoa(bin);
              }
            } else {
              return m; // honest miss: leave the reference alone
            }
            // Wrap in new URL(...) so that `.href` (or other URL accessors)
            // on the original `new URL(rel, import.meta.url)` expression
            // keep working — a bare string literal has no `.href`.
            return `new URL(${JSON.stringify(`data:${mime};base64,${b64}`)})`;
          },
        );
      }
      function toVFSPath(modulePath, fromFile) {
        // IDEMPOTENT (vitest E2E gap #1): an already-resolved VFS path — anything
        // not starting with ./ or ../ — is returned as-is. Re-joining it against
        // the parent dir doubles the path ('a/b/x.js' resolved from 'a/b/y.js'
        // became 'a/b/a/b/x.js'), which broke nested relative imports at depth ≥2.
        const isRelativeRequest =
          modulePath.startsWith("./") || modulePath.startsWith("../");
        if (!isRelativeRequest)
          return modulePath.replace(/^\.\//, "").replace(/^\/+/, "");
        const fromDir = fromFile
          ? fromFile.split("/").slice(0, -1).join("/")
          : "";
        const joined = fromDir ? `${fromDir}/${modulePath}` : modulePath;

        const parts = joined.replace(/^\.\//, "").split("/");
        const resolved = [];
        for (const part of parts) {
          if (part === "..") resolved.pop();
          else if (part !== ".") resolved.push(part);
        }
        return resolved.join("/");
      }

      // --- Package exports/imports resolution (gap #2) ---
      // Node's PACKAGE_EXPORTS_RESOLVE / PACKAGE_IMPORTS_RESOLVE, browser-VFS
      // edition. Condition order mirrors Node's ESM-import defaults — the
      // runtime emulates Node in the browser, so 'node' wins over 'browser'.
      const PACKAGE_CONDITIONS = ["node", "import", "default"];
      // Node parity: require()/require.resolve() resolve 'exports' with the
      // require condition set; import uses the import set. The _dynamic_import
      // interop receives type ("import" | "require") from the sandbox loader.
      function packageConditionsFor(type) {
        return type === "require"
          ? ["node", "require", "default"]
          : PACKAGE_CONDITIONS;
      }

      function splitPackageSpecifier(importPath) {
        // '@scope/pkg/sub/deep' -> { packageName: '@scope/pkg', subpath: './sub/deep' }
        if (importPath.startsWith("@")) {
          const parts = importPath.split("/");
          const packageName = parts.slice(0, 2).join("/");
          const rest = parts.slice(2).join("/");
          return { packageName, subpath: rest ? "./" + rest : "." };
        }
        const idx = importPath.indexOf("/");
        if (idx === -1) return { packageName: importPath, subpath: "." };
        return {
          packageName: importPath.slice(0, idx),
          subpath: "." + importPath.slice(idx),
        };
      }

      function resolvePackageTarget(target, conditions) {
        // string | null (blocked subpath) | string[] (fallback chain) | { condition: target }
        if (target === null || target === undefined) return null;
        if (typeof target === "string") return target;
        if (Array.isArray(target)) {
          for (const t of target) {
            const r = resolvePackageTarget(t, conditions);
            if (r !== null) return r;
          }
          return null;
        }
        if (typeof target === "object") {
          for (const cond of conditions) {
            if (Object.prototype.hasOwnProperty.call(target, cond)) {
              const r = resolvePackageTarget(target[cond], conditions);
              if (r !== null) return r;
            }
          }
          return null;
        }
        return null;
      }

      function resolvePackageExports(pkgJson, subpath, conditions) {
        conditions = conditions || PACKAGE_CONDITIONS;
        const exportsField = pkgJson.exports;
        if (exportsField === null || exportsField === undefined) return null;
        let target;
        if (typeof exportsField === "string") {
          if (subpath !== ".") return null;
          target = exportsField;
        } else if (
          typeof exportsField === "object" &&
          !Array.isArray(exportsField)
        ) {
          const keys = Object.keys(exportsField);
          const isSugar =
            keys.length > 0 && keys.every((k) => !k.startsWith("."));
          if (isSugar) {
            // Condition-only object: the main entry.
            if (subpath !== ".") return null;
            target = exportsField;
          } else if (
            Object.prototype.hasOwnProperty.call(exportsField, subpath)
          ) {
            target = exportsField[subpath];
          } else {
            // Longest pattern-key ('./x/*') match.
            let best = null;
            for (const key of keys) {
              if (key.endsWith("/*")) {
                const prefix = key.slice(0, -1);
                if (
                  subpath.startsWith(prefix) &&
                  (best === null || key.length > best.length)
                ) {
                  best = key;
                }
              }
            }
            if (best === null) return null;
            const star = subpath.slice(best.length - 1);
            const patternTarget = resolvePackageTarget(
              exportsField[best],
              conditions,
            );
            if (typeof patternTarget !== "string") return null;
            return patternTarget.replace(/\*/g, star);
          }
        } else {
          return null;
        }
        const resolved = resolvePackageTarget(target, conditions);
        return typeof resolved === "string" ? resolved : null;
      }

      function resolvePackageImports(
        importPath,
        importerPath,
        vfs,
        conditions,
      ) {
        conditions = conditions || PACKAGE_CONDITIONS;
        // Nearest parent package.json scope wins; a scope without an
        // 'imports' field means the specifier is unresolvable (Node parity).
        const segments = importerPath ? importerPath.split("/") : [];
        segments.pop();
        while (true) {
          const pkgPath = [...segments, "package.json"].join("/");
          const hit = resolveVFS(pkgPath, "", vfs);
          if (hit && hit.source) {
            let pkg = null;
            try {
              pkg = JSON.parse(hit.source);
            } catch (e) {
              /* invalid package.json */
            }
            if (pkg && pkg.imports && typeof pkg.imports === "object") {
              const keys = Object.keys(pkg.imports);
              let target;
              if (
                Object.prototype.hasOwnProperty.call(pkg.imports, importPath)
              ) {
                target = pkg.imports[importPath];
              } else {
                let best = null;
                for (const key of keys) {
                  if (
                    key.endsWith("/*") &&
                    importPath.startsWith(key.slice(0, -1)) &&
                    (best === null || key.length > best.length)
                  ) {
                    best = key;
                  }
                }
                if (best === null) return null;
                const star = importPath.slice(best.length - 1);
                const patternTarget = resolvePackageTarget(
                  pkg.imports[best],
                  conditions,
                );
                if (typeof patternTarget !== "string") return null;
                target = patternTarget.replace(/\*/g, star);
              }
              const resolved = resolvePackageTarget(target, conditions);
              if (typeof resolved !== "string" || !resolved.startsWith("./"))
                return null;
              const dir = segments.join("/");
              const rel = resolved.slice(2);
              return resolveVFS(dir ? dir + "/" + rel : rel, "", vfs);
            }
            return null;
          }
          if (segments.length === 0) break;
          segments.pop();
        }
        return null;
      }
      // --- end package exports/imports (gap #2) ---

      this.registerInterop(
        "_dynamic_import",
        async (
          path,
          type,
          entryPoint,
          parentEntryPoint,
          isNodeBuiltIn,
          cwd,
        ) => {
          const vfs = {
            src: {
              utils: {
                "math.js": "export const add = (a, b) => a + b;",
                "math2.js": "import {add} from '../main2.js'; console.log(add)",
              },
              "main.js":
                "import { add } from './utils/math.js'; import helper from 'my-lib'; console.log(add(1, 2), helper); export {add}",
              "main2.js": `console.log('hello')`,
              node_modules: {
                "my-lib": {
                  "package.json": '{"main": "dist/index.js"}',
                  dist: {
                    "index.js":
                      "export default 'Hello from local node_modules package!';",
                  },
                },
              },
            },
            node_modules: {
              "lodash-es": {
                "index.js":
                  "export function cloneDeep(val) { return JSON.parse(JSON.stringify(val)); }",
              },
            },
            "require.js": `exports.add = (a, b) => a + b;
  exports.msg = 'Hello from CommonJS!';`,
            "test.js": "console.log('root file');",
            "package.json": '{"name": "sandbox"}',
          };

          // 1. For Node built-ins, hand off to your shim resolver as before
          if (isNodeBuiltIn) {
            // For builtins, try local dist first, then CDN, then generic stub.
            try {
              const src = await fetchBuiltinSource(path);
              return { source: src, resolvedPath: null };
            } catch (e) {
              // Fallback: generic stub for missing builtins
              return { source: `export default {};`, resolvedPath: null };
            }
          }

          // 2. Determine the importer's VFS path
          const importerVFSPath = entryPoint
            ? toVFSPath(entryPoint, parentEntryPoint)
            : (parentEntryPoint ?? "");

          const isRelative = path.startsWith("./") || path.startsWith("../");

          // 3. Handle Bare Specifiers (node_modules lookup)
          if (!isRelative) {
            const resolvedPackage = resolveNodeModule(
              path,
              importerVFSPath,
              vfs,
            );
            if (resolvedPackage) {
              console.log(`Resolved from node_modules: ${path}`);
              return resolvedPackage.source;
            }
            return null; // Fall through if package is completely missing
          }

          // 4. Handle Relative Paths
          const result = resolveVFS(path, importerVFSPath, vfs);
          if (!result) {
            throw new Error(
              `[ERR_MODULE_NOT_FOUND]: Cannot find module '${path}' (imported from '${importerVFSPath}')`,
            );
          }

          console.log(result, path);
          return result.source;
        },
      );

      // Hoisted VFS helpers for the real '_dynamic_import' below. The sandbox
      // used to post its entire __USER_FILES__ seed (~22MB with the WASM
      // shims) on every call; structured-cloning that through postMessage
      // stalled bootstrap for minutes (~30 eager builtin preloads x ~7s).
      // The iframe copy is never mutated at runtime (fs writes land in the
      // memfs Volume, not __USER_FILES__), so it is always identical to the
      // host's config.fs. Serve from the host seed (zero clone); honor an
      // explicitly-passed VFS only when the host has no seed of its own.
      function unflattenFileSystem(flatObj) {
        const result = {};

        for (const [rawPath, value] of Object.entries(flatObj)) {
          // User file keys may be '/lib/util.js' or 'lib/util.js'; resolution
          // walks segments without a leading slash, so normalize here. Without
          // this, '/lib/util.js'.split('/') yields a phantom '' root segment and
          // every lookup misses (MODULE_NOT_FOUND).
          const parts = String(rawPath).replace(/^\/+/, "").split("/");
          let current = result;

          // Traverse (or create) folders until the last segment (the file name)
          for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (!current[part] || typeof current[part] !== "object") {
              current[part] = {};
            }
            current = current[part];
          }

          // Assign the file content to the final key
          current[parts[parts.length - 1]] = value;
        }

        return result;
      }

      function pickDynamicImportVfs(passedVfs, hostSeed, unflatten) {
        const hostEmpty =
          !hostSeed ||
          typeof hostSeed !== "object" ||
          Object.keys(hostSeed).length === 0;
        if (
          hostEmpty &&
          passedVfs &&
          typeof passedVfs === "object" &&
          Object.keys(passedVfs).length > 0
        ) {
          return unflatten(passedVfs);
        }
        return unflatten(hostSeed || {});
      }

      this.registerInterop(
        "_dynamic_import",
        async (
          path,
          type,
          entryPoint,
          parentEntryPoint,
          isNodeBuiltIn,
          cwd,
          vfs = {},
        ) => {
          // Serve from the host's own seed: the sandbox no longer ships its
          // __USER_FILES__ across postMessage (see pickDynamicImportVfs).
          // 'this' is the CodeSandbox instance (arrow closure over execute()).
          vfs = pickDynamicImportVfs(vfs, this.config.fs, unflattenFileSystem);

          // Normalize file:// URLs (e.g. Vite's await import(pathToFileURL(p).href))
          // to absolute VFS paths before classification.
          if (path.startsWith("file://")) {
            path = path.slice("file://".length);
            if (!path.startsWith("/")) path = "/" + path;
          }

          // 1. For Node built-ins, hand off to your shim resolver as before.
          // resolvedPath is null: builtins aren't VFS files, so the sandbox keeps
          // using the request path as the build fileName (unchanged behavior).
          if (isNodeBuiltIn) {
            try {
              const builtinSource = await fetchBuiltinSource(path);
              return { source: builtinSource, resolvedPath: null };
            } catch (e) {
              // Shim missing or unfetchable: honest generic stub, never throw.
              return { source: `export default {};`, resolvedPath: null };
            }
          }

          // 2. Determine the importer's VFS path
          const importerVFSPath = entryPoint
            ? toVFSPath(entryPoint, parentEntryPoint)
            : (parentEntryPoint ?? "");

          // Part B plugin hook: onResolve — first match wins. A plugin may
          // rewrite the specifier (default loading uses the new path) and/or
          // tag a namespace (re-derived in _build_file for onLoad matching).
          // PluginError propagates via the interop error channel.
          const __pr = await applyResolvePlugins(
            path,
            importerVFSPath,
            this.plugins,
          );
          if (__pr && typeof __pr.path === "string" && __pr.path !== path) {
            path = __pr.path;
          }

          const isRelative = path.startsWith("./") || path.startsWith("../");
          const isAbsolute = path.startsWith("/");

          // Canonical package-loading path: every VFS-served module goes
          // through here, so vendored WASM builds get their
          // `new URL(<rel>.wasm, import.meta.url)` references inlined as
          // data: URLs before the child executes the source from a data:
          // URL (where relative resolution would throw).
          const serve = (hit) =>
            hit && typeof hit.source === "string"
              ? {
                  source: inlineWasmDataUrls(hit.source, hit.resolvedPath, vfs),
                  resolvedPath: hit.resolvedPath,
                }
              : hit;

          // 3a. Package-internal # imports (gap #2): resolve via the nearest
          // package.json 'imports' field before the node_modules walk.
          if (path.startsWith("#")) {
            const resolvedImport = resolvePackageImports(
              path,
              importerVFSPath,
              vfs,
              packageConditionsFor(type),
            );
            if (resolvedImport) {
              return serve(resolvedImport);
            }
            return null;
          }

          // 3. Handle Bare Specifiers (node_modules lookup)
          // Absolute VFS paths (isAbsolute) bypass this branch — they are
          // resolved directly against the VFS, not via package lookup.
          if (!isRelative && !isAbsolute) {
            // Vendor browser/WASM builds for native-only packages (real
            // Vite 7: rollup → @rollup/browser, esbuild → esbuild-wasm
            // shim). Opt-in via the vite-browser plugin (Jared 2026-10-04).
            // Specifier-based, so ESM 'import 'rollup'' resolves
            // exactly like CJS require('rollup') (src/module.js). The table
            // is static — no VFS-presence gate needed: this handler only
            // runs when serving the browser runtime's VFS.
            const intercepted = isViteBrowserInterceptionActive()
              ? lookupNativeInterception(path)
              : null;
            if (intercepted) {
              const hit = resolveVFS(intercepted, "", vfs);
              if (hit) {
                return serve(hit);
              }
              // Target not seeded in this VFS: fall through to the normal
              // lookup so the miss stays an honest MODULE_NOT_FOUND.
            }
            const resolvedPackage = resolveNodeModule(
              path,
              importerVFSPath,
              vfs,
              type,
            );
            if (resolvedPackage) {
              console.log(`Resolved from node_modules: ${path}`);
              return serve(resolvedPackage);
            }
            return null; // Fall through if package is completely missing
          }

          // 3b. Handle Absolute VFS Paths (e.g. '/node_modules/terser/...').
          // Resolve directly against the VFS root, ignoring the importer.
          // (Vite's loadTerserPath does await import(pathToFileURL(...))
          // which the sandbox normalizes to an absolute VFS path.)
          if (isAbsolute) {
            const absResult = resolveVFS(path, "", vfs);
            if (!absResult) {
              throw new Error(
                `[ERR_MODULE_NOT_FOUND]: Cannot find module '${path}' (absolute VFS path)`,
              );
            }
            // Gap #1: return the resolved VFS path alongside the source.
            return serve(absResult);
          }

          // 4. Handle Relative Paths
          const result = resolveVFS(path, importerVFSPath, vfs);
          if (!result) {
            throw new Error(
              `[ERR_MODULE_NOT_FOUND]: Cannot find module '${path}' (imported from '${importerVFSPath}')`,
            );
          }

          // Gap #1: return the resolved VFS path alongside the source so the sandbox
          // can thread it into _build_file as the nested entryPoint.
          return serve(result);
        },
      );

      function resolveNodeModule(importPath, importerPath, vfs, type) {
        // The sandbox loader passes type ("import" | "require"); require()
        // resolves 'exports' with the require condition set (Node parity).
        const conditions = packageConditionsFor(type);
        // Split off any subpath so package.json 'exports' can resolve it (gap #2).
        const { packageName, subpath } = splitPackageSpecifier(importPath);

        // Extract directory path from the importer
        const segments = importerPath ? importerPath.split("/") : [];
        segments.pop(); // Remove the file name to get the parent directory

        // Walk up the directory tree looking for node_modules
        while (true) {
          // Build candidate path: [dir1, dir2, ..., "node_modules", packageName]
          const candidatePath = [
            ...segments,
            "node_modules",
            ...packageName.split("/"),
          ].join("/");

          // Attempt resolution at this level using your existing VFS resolver
          const resolved = tryResolveFileOrPackage(
            candidatePath,
            subpath,
            vfs,
            conditions,
          );
          if (resolved) return resolved;

          // Stop if we've reached the root
          if (segments.length === 0) break;
          segments.pop();
        }

        // Final fallback: Check root-level node_modules if not found via traversal
        return tryResolveFileOrPackage(
          `node_modules/${packageName}`,
          subpath,
          vfs,
          conditions,
        );
      }

      // Helper to resolve a package root + subpath. The 'exports' field wins when
      // present (gap #2 — the only legal route per Node); otherwise legacy
      // file/main/index.js probing. (Legacy order also corrected to Node parity:
      // package.json 'main' now beats a sibling index.js.)
      function tryResolveFileOrPackage(packageRoot, subpath, vfs, conditions) {
        const pkgJsonCheck = resolveVFS(`${packageRoot}/package.json`, "", vfs);
        let pkg = null;
        if (pkgJsonCheck && pkgJsonCheck.source) {
          try {
            pkg = JSON.parse(pkgJsonCheck.source);
          } catch (e) {
            // Invalid package.json — fall through to legacy probing
          }
        }

        // 1. Package 'exports' field (gap #2).
        if (pkg && pkg.exports) {
          const target = resolvePackageExports(pkg, subpath, conditions);
          if (typeof target === "string" && target.startsWith("./")) {
            return resolveVFS(`${packageRoot}/${target.slice(2)}`, "", vfs);
          }
          return null; // not exported (or blocked) — honest miss
        }

        // 2. Legacy: subpath as a direct file.
        if (subpath !== ".") {
          const rel = subpath.slice(2);
          const subCheck =
            resolveVFS(`${packageRoot}/${rel}`, "", vfs) ||
            resolveVFS(`${packageRoot}/${rel}.js`, "", vfs) ||
            resolveVFS(`${packageRoot}/${rel}/index.js`, "", vfs);
          if (subCheck) return subCheck;
        }

        // 3. Legacy: package.json main, then index.js.
        const mainFile = (pkg && pkg.main) || "index.js";
        return (
          resolveVFS(`${packageRoot}/${mainFile}`, "", vfs) ||
          resolveVFS(`${packageRoot}/index.js`, "", vfs)
        );
      }

      this.registerInterop(
        "_dynamic_import2",
        async (
          path,
          type,
          entryPoint,
          parentEntryPoint,
          isNodeBuiltIn,
          cwd,
        ) => {
          // console.log(parentEntryPoint)
          //  console.log(path, type, entryPoint, parentEntryPoint, isNodeBuiltIn, cwd) // "./test2" "import" "./test" "./mathjs.js" false "./"

          if (path === "./serialize") {
            // serialize helper loaded lazily
            return await loadBuiltin("serialize").catch(() => ({
              default: {},
            }));
          }

          if (isNodeBuiltIn) {
            // Lazy-load built-in on demand. Only the requested module's
            // dist file is fetched, not the full 6.8MB bundle.
            return await loadBuiltin(path);
          }

          if (isNodeBuiltIn) {
            return `throw new Error("Not implemented.")`;
          }

          if (path.includes("./test")) {
            return `
           import coolBeanMsg from "./test2"
           export function coolBeans(){
              return coolBeanMsg()
             } 
            console.log(import.meta.url)
             Promise.reject(new Error('Something broke!'));
           `;
          }
        },
      );

      if (!this.iframeElement) {
        document.body.appendChild(iframe);
      }

      let runtimeCode;

      try {
        // Resolve imports
        let { imports, cleanedCode, cleanedImports, hasImports } =
          this.importResolver.resolve(code);

        // Apply code transformers (todo: add assert type support?)
        /*let transformedCode = CodeTransformer.transform(
          cleanedCode,
          this.config.codeTransformers
        );*/
        //  let transformedCode = code;

        // Live bindings (2026-10-09): the entry's static imports are
        // transformed TOGETHER WITH the entry body in a single
        // transformImportsToLoadModule call, so references to imported
        // bindings compile to live member access (`__lm_N.x`) on the same
        // lifted vars whose `await loadModule(...)` preamble is hoisted to
        // %%IMPORTS%% (init scope). The old shape — transforming each
        // import statement separately into a preload — emitted
        // `const { x } = __lm` snapshots; with live bindings the preload
        // emits no binding at all, which would leave the body's references
        // dangling (ReferenceError). Both scopes share the sandbox IIFE,
        // so the body's `__lm_N.x` resolves to the preamble's lifted vars.
        const combinedCode =
          imports.length > 0
            ? imports.join("\n") + "\n" + cleanedCode
            : cleanedCode;

        // Generate runtime code

        //  transformedCode =  transformedCode.replaceAll("await import", "await loadModule")

        // Transform Relative Imports (this can be removed when merged into one function)
        // transformedCode =  transformRelativeModule(transformedCode)

        function containsNodeTest(obj) {
          const target = "node:test";
          const lists = ["imports", "dynamicImports", "requires"];

          return lists.some((listName) => {
            return (
              Array.isArray(obj[listName]) && obj[listName].includes(target)
            );
          });
        }

        function isTestFile(src) {
          return /['"]node:test['"]/.test(src);
        }

        // Transform the main entry code and capture its source map for error mapping.
        // (combinedCode: the entry's static imports + body, transformed
        // together for live bindings — see above.)
        const mainTransform = transformImportsToLoadModule(
          this.uuid,
          combinedCode,
          this.config.fileName,
        );
        if (mainTransform.map) {
          const sourceURL = `sandbox://${this.uuid}/${this.config.fileName}`;
          this._sourceMapRegistry.set(sourceURL, {
            map: mainTransform.map,
            originalSource: combinedCode,
            filename: this.config.fileName,
          });
        }

        runtimeCode = SandboxRuntime.generate(mainTransform.body, {
          imports: mainTransform.preamble ? [mainTransform.preamble] : [],
          logNetworkRequests: this.config.logNetworkRequests,
          interopVariable: this.config.interopVariable,
          process: this.config.process,
          isTest: containsNodeTest(cleanedImports),
          fileName: this.config.fileName,
          uuid: this.uuid,
          fs: flattenFileTree(this.config.fs),
          seaAssets: normalizeSeaAssets(this.config.seaAssets),
          shell: this.config.shell,
        });

        // Setup timeout
        const timeoutId = setTimeout(() => {
          context.forceKill(`Execution timeout after ${this.config.timeout}ms`);
          context.cleanup();
          this.emit("execution:timeout", { id: executionId });
          reject(new Error(`Execution timeout after ${this.config.timeout}ms`));
        }, this.config.timeout);

        context.cleanupCallbacks.push(() => clearTimeout(timeoutId));

        // Listen for results
        context.listen(
          (result) => {
            this.emit("execution:complete", { id: executionId, result });
            resolve(result);
          },
          (error) => {
            this.emit("execution:error", {
              id: executionId,
              error: error.message,
            });
            reject(error);
          },
        );

        // Inject and execute
        context.inject(runtimeCode, hasImports);
      } catch (err) {
        const loc = err?.loc;
        const message = err?.message;
        console.log(err);
        // If code generation itself failed (e.g. a syntax error in the user's
        // code), runtimeCode was never assigned — skip the source-mapping and
        // reject with the original error instead of crashing here.
        if (runtimeCode) {
          const line = runtimeCode
            .slice(0, runtimeCode.indexOf("//__$PROVIDED_RUNTIME_CODE__/"))
            .split("\n").length;

          if (loc) {
            let runtimeError = false;

            try {
              new SyntaxChecker().check(runtimeCode); // error in the runtime code..
            } catch (err) {
              if (line < err.loc.line != true) {
                runtimeError = true;
              } else {
                //   err.loc.line = err.loc.line - line; TODO: Assign proper line and user code not runtime code
              }
              code = runtimeCode;
            }

            if (runtimeError) {
              err.message = `RUNTIME ERROR: ${err.message}`;
            }

            err = formatErrors(code, err);
          }
        } // end if (runtimeCode)
        context.cleanup();
        this.emit("execution:error", { id: executionId, error: err.message });
        reject(err);
      } finally {
        runtimeCode = null;
      }
    });
  }

  /**
   * Execute code and return formatted output
   */
  async run(code) {
    try {
      const result = await this.execute(code);

      if (result.success) {
        return `✓ Execution successful (${result.executionTime}ms)\n${result.logs.join("\n")}`;
      } else {
        return `✗ Execution failed\nError: ${result.error}\n${result.stack || ""}`;
      }
    } catch (err) {
      return `✗ Fatal error\n${err.message}\n${err.stack || ""}`;
    }
  }

  /**
   * Run a wasm32-wasi (preview1) module against the sandbox's VFS.
   *
   * First-class host API (roadmap §1): instantiates the binary with the
   * sandbox's `config.fs` seeded at the guest preopen dir (default
   * `/sandbox`), captures stdout/stderr, and writes the post-run file
   * snapshot back into `config.fs`.
   *
   * @param {Uint8Array|ArrayBuffer} bytes — the .wasm binary
   * @param {object} [options]
   * @param {string[]} [options.args] — argv (argv[0] = program name)
   * @param {Record<string,string>} [options.env] — environment variables
   * @param {string} [options.preopenDir] — guest mount point (default "/sandbox")
   * @returns {Promise<{exitCode:number, stdout:string[], stderr:string[],
   *   files:Record<string,Uint8Array>}>}
   *
   * @example
   * const { exitCode, stdout } = await sandbox.runWasi(wasmBytes, {
   *   args: ["prog.wasm", "foo"], env: { HOME: "/sandbox" },
   * });
   */
  async runWasi(bytes, options = {}) {
    // Lazy: the WASI engine (~100KB bundled) loads only when runWasi is
    // used. The module is browser-safe (no bare specifiers — it selects
    // ../wasi.js under Node, ../../dist/wasi.js in a browser host).
    const { runWasi } = await import("./src/runtime/runwasi.js");
    const { preopenDir = "/sandbox", ...rest } = options;
    const result = await runWasi(bytes, {
      ...rest,
      preopenDir,
      files: this.config.fs || {},
    });
    // Write the guest's file changes back into the sandbox VFS seed so
    // subsequent execute()/runWasi() calls observe them.
    for (const [p, data] of Object.entries(result.files)) {
      this.config.fs[p] = data;
    }
    return result;
  }

  /**
   * Opt-in true type-checking over the sandbox's TypeScript VFS files.
   *
   * Runs a full `ts.createProgram` via the registered plugin's
   * `typecheck(files)` hook (docs/PLUGINS.md Part B §4) and returns
   * diagnostics. This is the slow path: it NEVER runs as part of
   * execute() — the transpile-only transform stays the default, so type
   * errors never block execution unless the host asks.
   *
   * @param {{libs?: string[], libBase?: string}} [options] forwarded to
   *   the plugin hook (lib entry points; browser-lane CDN base override).
   * @returns {Promise<Array<{file, line, column, message, code}>>}
   *   line/column are 1-based; null for global diagnostics. [] when no
   *   plugin with a typecheck hook is registered.
   */
  async typecheck(options = {}) {
    const plugin = getPlugins().find((p) => typeof p.typecheck === "function");
    if (!plugin) return [];
    const flat = flattenFileTree(this.config.fs || {});
    const files = [];
    for (const [key, value] of Object.entries(flat)) {
      if (typeof value !== "string") continue; // skip binary/envelope leaves
      files.push({
        path: key.startsWith("/") ? key : "/" + key,
        contents: value,
      });
    }
    return plugin.typecheck(files, options);
  }

  /**
   * Get sandbox statistics
   */
  getStats() {
    return {
      executionCount: this.executionCount,
      initialized: this.initialized,
      config: { ...this.config },
    };
  }

  /**
   * Reset sandbox state
   */
  reset() {
    this.importResolver.clearCache();
    this.executionCount = 0;
    this.emit("reset", { timestamp: Date.now() });
  }

  /**
   * Update the sandbox terminal size at runtime.
   *
   * Requires a live sandbox (same constraint as invoke('__stdin__', …):
   * throws "Sandbox is not running." when called before init() or when no
   * execution is active. Emits 'terminal:resize' with { cols, rows } on
   * success; the sandbox also fires Node's 'resize' event on
   * process.stdout/process.stderr so readline and guest listeners react.
   */
  async setTerminalSize(cols, rows) {
    cols = Math.floor(Number(cols));
    rows = Math.floor(Number(rows));
    if (
      !Number.isFinite(cols) ||
      cols <= 0 ||
      !Number.isFinite(rows) ||
      rows <= 0
    ) {
      throw new Error(
        "setTerminalSize requires positive integer columns and rows",
      );
    }
    const result = await this.invoke("__terminal_resize__", { cols, rows });
    const size = { cols: result.cols, rows: result.rows };
    this._terminalSize = size;
    this.emit("terminal:resize", size);
    return size;
  }
}
