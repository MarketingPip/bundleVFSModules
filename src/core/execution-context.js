// ============================================================================
// EXECUTION CONTEXT MODULE
// ============================================================================

// VFS_FETCH_BRIDGE_START
// ── Host virtual-server fetch bridge ───────────────────────────────────────
// Patches the real parent/host 'fetch' (once) so requests to loopback URLs
// ('localhost', '127.0.0.1', '[::1]') on a port owned by a sandbox route to
// that sandbox's virtual HTTP server via 'invoke('__serverRequest__', …)'.
// One host-global registry: first claim wins, a colliding second claim is
// rejected so the host can revoke the loser. The patch is removed only after
// the final route disappears. Tested by tests/host-fetch-bridge.test.js,
// which evaluates this exact section in a vm sandbox with mocked globals.

/** port (number) -> ExecutionContext owning the active virtual server */
const _vfsServerRoutes = new Map();
/** The native fetch, captured while the patch is installed. */
let _vfsOriginalFetch = null;

function _vfsIsLoopbackHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

function _vfsExtractServerPort(data) {
  if (data && typeof data.port === "number") return data.port;
  // Sandbox posts server events via emitMe: { type, message: 'null {"port":N}' }.
  const msg = data && typeof data.message === "string" ? data.message : "";
  const m = /\{\s*"port"\s*:\s*(\d+)\s*\}/.exec(msg);
  return m ? Number(m[1]) : null;
}

function _vfsEnsureFetchPatched() {
  if (typeof window === "undefined" || typeof window.fetch !== "function")
    return false;
  if (window.fetch && window.fetch.__vfsBridged) return true;
  _vfsOriginalFetch = window.fetch;
  _vfsPatchedFetch.__vfsBridged = true;
  window.fetch = _vfsPatchedFetch;
  return true;
}

function _vfsMaybeRestoreFetch() {
  if (
    _vfsServerRoutes.size === 0 &&
    _vfsOriginalFetch &&
    typeof window !== "undefined"
  ) {
    window.fetch = _vfsOriginalFetch;
    _vfsOriginalFetch = null;
  }
}

/** Returns true when this owner holds the route (first claim wins). */
function _vfsRegisterServerRoute(port, owner) {
  if (port == null) return false;
  const existing = _vfsServerRoutes.get(port);
  if (existing === owner) return true; // idempotent re-register
  if (existing !== undefined) return false; // collision
  _vfsServerRoutes.set(port, owner);
  _vfsEnsureFetchPatched();
  return true;
}

function _vfsUnregisterServerRoute(port, owner) {
  if (port == null) return;
  if (_vfsServerRoutes.get(port) === owner) {
    _vfsServerRoutes.delete(port);
    _vfsMaybeRestoreFetch();
  }
}

async function _vfsPatchedFetch(input, init) {
  let url = null;
  try {
    const raw = typeof input === "string" ? input : input && input.url;
    url = new URL(String(raw), window.location.href);
  } catch {
    return _vfsOriginalFetch.apply(this, arguments);
  }
  if (url && _vfsIsLoopbackHostname(url.hostname)) {
    const port = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80;
    const owner = _vfsServerRoutes.get(port);
    if (owner !== undefined) {
      return _vfsDispatchToSandbox(owner, port, url, input, init);
    }
  }
  return _vfsOriginalFetch.apply(this, arguments);
}

async function _vfsDispatchToSandbox(owner, port, url, input, init) {
  const method = String(
    (init && init.method) ||
      (input && typeof input === "object" && input.method) ||
      "GET",
  ).toUpperCase();
  const headers = {};
  const absorb = (h) => {
    if (!h) return;
    if (typeof h.forEach === "function") {
      h.forEach((v, k) => {
        headers[String(k)] = String(v);
      });
    } else if (Array.isArray(h)) {
      for (const [k, v] of h) headers[String(k)] = String(v);
    } else if (typeof h === "object") {
      for (const k of Object.keys(h)) headers[k] = String(h[k]);
    }
  };
  absorb(input && typeof input === "object" ? input.headers : null);
  absorb(init && init.headers);
  let body = null;
  const rawBody =
    init && init.body !== undefined
      ? init.body
      : input && typeof input === "object"
        ? input.body
        : undefined;
  if (rawBody !== undefined && rawBody !== null) {
    if (
      typeof rawBody === "string" ||
      rawBody instanceof Uint8Array ||
      rawBody instanceof ArrayBuffer
    ) {
      body = rawBody;
    } else {
      body = String(rawBody);
    }
  }
  const path = url.pathname + url.search;
  let result;
  try {
    // __serverRequest__ treats {} as "no body" (see src/http.js handleRequest).
    result = await owner.invoke(
      "__serverRequest__",
      port,
      path,
      method,
      body === null ? {} : body,
      headers,
    );
  } catch (err) {
    // Owner died mid-flight: drop the stale route so later fetches go native.
    _vfsUnregisterServerRoute(port, owner);
    throw err;
  }
  let resBody = result && result.body;
  if (
    resBody !== undefined &&
    resBody !== null &&
    typeof resBody !== "string" &&
    !(resBody instanceof Uint8Array) &&
    !(resBody instanceof ArrayBuffer)
  ) {
    resBody = String(resBody);
  }
  return new Response(resBody == null ? "" : resBody, {
    status: (result && result.statusCode) || 200,
    statusText: (result && result.statusMessage) || "",
    headers: (result && result.headers) || {},
  });
}
// VFS_FETCH_BRIDGE_END

class ExecutionContext {
  constructor(iframe, sandbox) {
    this.iframe = iframe;
    this.sandbox = sandbox;
    this.config = sandbox.config;
    this.messageHandler = null;
    this.cleanupCallbacks = [];
    this.resolved = false;
    this.running = false;
    this.interopCallbacks = new Map();
    this.stdout = [];
    this.stderr = [];
    this.startTime = null;
    this._resolve = null;
    this._reject = null;
    this._serverRunning = false;
    this._serverPort = null;
    this._vfsPorts = new Set(); // ports this sandbox owns in the host fetch bridge
  }

  /**
   * Hard-kill the sandbox from the parent side.
   *
   * This does NOT rely on the iframe processing a message — a synchronous
   * busy-loop inside the iframe will never yield back to its event loop, so
   * postMessage alone can't interrupt it. Instead we tear down the iframe's
   * own browsing context from here (the parent, which is never blocked):
   * either detaching it from the DOM or navigating its src away. Both
   * immediately abort whatever script is running inside, no matter what
   * it's doing.
   */
  forceKill(reason = "Process killed by user") {
    if (this.resolved) return;
    this.resolved = true;
    this.running = false;
    /**
     * Custom error for process or iframe termination with explicit stack support
     */
    class ProcessKilledError extends Error {
      constructor(message = "Process was killed or terminated") {
        super(message);
        this.name = "ProcessKilledError";
        this.code = "ERR_PROCESS_KILLED";
        this.signal = "SIGKILL";

        // Explicitly capture and generate the stack trace
        if (Error.captureStackTrace) {
          Error.captureStackTrace(this, this.constructor);
        } else {
          this.stack = new Error(message).stack;
        }
      }
    }
    const executionTime =
      this.startTime != null
        ? +(performance.now() - this.startTime).toFixed(2)
        : 0;

    // Best-effort courtesy ping — helps in the *non-blocking* async case
    // (the iframe is idle/awaiting) where it can still process a message
    // and report back before we yank it. Harmless no-op if it's stuck.
    try {
      this.iframe.contentWindow?.postMessage(
        { type: "kill_request", reason },
        "*",
      );
    } catch (e) {}

    // The actual kill: tear down the realm from outside.
    try {
      if (!this.sandbox.destroyIframe && this.iframe) {
        // Persistent, user-supplied iframe — we can't remove it, so navigate
        // it away instead. This still destroys the current document/global
        // scope and halts execution immediately.
        this.iframe.src = "about:blank";
      }
      // If destroyIframe is true, cleanup() below removes the node from the
      // DOM, which has the same terminating effect.
    } catch (err) {
      console.warn("[kill] failed to tear down iframe:", err);
    }

    this.cleanup();

    const results = {
      success: false,
      killed: true,
      error: reason,
      stack: reason,
      logs: [...this.stdout, "Process Killed"],
      executionTime,
    };

    this.sandbox.emit("execution:kill", {
      id: this.sandbox.executionCount,
      reason,
      executionTime,
    });

    if (typeof this._resolve === "function") {
      this._resolve(results);
    }
  }

  /**
   * Inject code into iframe with CSP
   */
  inject(code, hasImports) {
    // Enhanced security with CSP
    const csp = [
      "default-src 'none'",
      "script-src 'unsafe-eval' 'unsafe-inline' data: blob: https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
      "script-src-elem 'self' 'unsafe-inline' blob: data: https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://ga.jspm.io",
      "img-src 'self' data:",
      "worker-src blob: data:",
      "connect-src * data: blob:", // <--- Add data: and blob: here explicitly
      "style-src 'unsafe-inline'",
    ].join("; ");
    const csp2 = [
      "default-src 'none'",
      "script-src 'unsafe-eval' 'unsafe-inline' data: blob: https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
      "script-src-elem 'self' 'unsafe-inline' blob: data: https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com  https://ga.jspm.io 'unsafe-inline'; img-src 'self' data:;",
      "worker-src blob: data:",
      "connect-src *",
      "style-src 'unsafe-inline'",
    ].join("; ");

    this.startTime = performance.now(); // needed for forceKill's executionTime

    // Escape the code to prevent breaking out of script tags
    const escapedCode = code.replace(/</g, "\\x3C").replace(/>/g, "\\x3E");

    this.exposedMethods = this._parseExposedMethods(code, "interop");

    code = this.hoistingTransform(code, "interop");

    /*this.iframe.srcdoc = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta http-equiv="Content-Security-Policy" content="${csp}">
        <\/head>
        <body>
          <script${hasImports ? ' type="module"' : ''}>
${code}
          <\/script>
        <\/body>
      <\/html>
    `;*/

    /* 
    const htmlString = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta http-equiv="Content-Security-Policy" content="${csp}">
        <\/head>
        <body>
          <script${hasImports ? ' type="module"' : ''}>
${code}
          <\/script>
        <\/body>
      <\/html>
    `
    */

    // TODO: use this - works for network imports but - need to handle normal files or steal code just for network imports and redirect to our loadModule >
    function buildHtmlString(csp, code, hasImports, iframe) {
      const doc = document.implementation.createHTMLDocument();

      // 1. Add a valid base URL so relative paths work properly
      const base = doc.createElement("base");
      base.href = window.location.origin;
      doc.head.appendChild(base);

      // 2. Add the CSP meta tag
      const meta = doc.createElement("meta");
      meta.setAttribute("http-equiv", "Content-Security-Policy");
      meta.setAttribute("content", csp);
      doc.head.appendChild(meta);

      // 3. Define window.esmsInitOptions with the hook FIRST (using plain JS so the function works)
      const optionsScript = doc.createElement("script");
      optionsScript.textContent = `
    window.esmsInitOptions = {
      shimMode: true,
      resolve: async (specifier, parentURL, defaultResolve) => {
         

        // Define your VFS modules
        const vfs = {
          "/foo.js": "export function hello() { console.log('Hello from VFS module!'); }",
          "/bar.js": "import { hello } from '/foo.js'; export function greet() { hello(); console.log('Greetings from bar.js'); }"
        };

        if (specifier in vfs) {
          return \`data:text/javascript;charset=utf-8,\${encodeURIComponent(vfs[specifier])}\`;
        }


  const node_builtin = ${JSON.stringify(builtinModules)}
  // Gap #6: "node:"-prefix normalization lives in the host-scope
  // normalizeBuiltinSpecifier; its source is inlined so the generated
  // script stays self-contained.
  const __normalizeBuiltinSpecifier = (${normalizeBuiltinSpecifier.toString()});


  let modulePath = specifier;

  const __builtinNorm = __normalizeBuiltinSpecifier(specifier, node_builtin);
  const isNodeBuiltIn = __builtinNorm.isNodeBuiltIn;
  modulePath = __builtinNorm.modulePath;

       if(isNodeBuiltIn){
        // Resolve Node builtins through the parent interop. Errors are wired
        // properly: _dynamic_import / _build_file rejections keep err.code
        // across the boundary (see interop_response wiring), and empty
        // results throw a real ERR_MODULE_NOT_FOUND instead of producing a
        // garbage data: URL that fails later with a cryptic SyntaxError.
        var bvmInterop = globalThis[Symbol.for("bvm.interop")];
        var bvmCwd = globalThis._RUNTIME${iframe.sandbox.uuid}_.cwd;
        // The seed is served host-side (pickDynamicImportVfs): never post
        // __USER_FILES__ across the boundary — structured-cloning ~22MB per
        // call stalled bootstrap for minutes.
        var data;
        try {
          data = await bvmInterop.callParent(
            '_dynamic_import',
            modulePath,
            'import',
            '/',
            '/',
            true,
            bvmCwd,
            undefined
          );
        } catch (err) {
          console.error('[bvm:resolve] _dynamic_import failed for "' + specifier + '": ' + ((err && err.message) || err));
          throw err;
        }
        if (!data || data.source === null || data.source === undefined || data.source === '') {
          var bvmNotFound = new Error("[ERR_MODULE_NOT_FOUND]: Cannot find module '" + specifier + "'");
          bvmNotFound.code = 'ERR_MODULE_NOT_FOUND';
          console.error('[bvm:resolve] ' + bvmNotFound.message);
          throw bvmNotFound;
        }
        try {
          data = await bvmInterop.callParent(
            '_build_file',
            data.source,
            specifier,
            'import',
            '/',
            '/',
            true
          );
        } catch (err) {
          console.error('[bvm:resolve] _build_file failed for "' + specifier + '": ' + ((err && err.message) || err));
          throw err;
        }
        if (data === null || data === undefined || data === '') {
          var bvmBuildEmpty = new Error("[bvm:resolve] _build_file returned empty source for '" + specifier + "'");
          console.error('[bvm:resolve] ' + bvmBuildEmpty.message);
          throw bvmBuildEmpty;
        }
        return "data:text/javascript;charset=utf-8," + encodeURIComponent(data);
       }

       // Platform fix (AGENTS.md rule 6): intercept file:// URLs and absolute
       // VFS paths. Vite's terser plugin does await import(pathToFileURL(p).href)
       // which produces file:///node_modules/...; es-module-shims would try to
       // fetch these as network URLs and die with a NetworkError. Route them
       // through the parent _dynamic_import + _build_file interop instead — the
       // parent already normalizes file:// → absolute VFS path. Any file://
       // import was broken, not just Vite's terser path.
       // Exception: a "/..." specifier whose parentURL is https:// is a
       // CDN-relative URL (esm.sh emits "/pkg@ver?target=..." imports), not
       // a VFS path — let defaultResolve handle it against the parent origin.
       var bvmParentIsHttps = typeof parentURL === "string" && parentURL.indexOf("https://") === 0;
       if (specifier.startsWith("file://") || (specifier.startsWith("/") && !bvmParentIsHttps)) {
         var bvmFilePath = specifier;
         if (bvmFilePath.startsWith("file://")) {
           bvmFilePath = bvmFilePath.slice("file://".length);
           // file:///x -> /x (keep the leading slash); file://host/x -> /x (VFS has no hosts)
           if (!bvmFilePath.startsWith("/")) bvmFilePath = "/" + bvmFilePath;
         }
         var bvmFileInterop = globalThis[Symbol.for("bvm.interop")];
         var bvmFileCwd = globalThis._RUNTIME${iframe.sandbox.uuid}_.cwd;
         var bvmFileData;
         try {
           bvmFileData = await bvmFileInterop.callParent(
             '_dynamic_import',
             bvmFilePath,
             'import',
             '/',
             '/',
             false,
             bvmFileCwd,
             undefined
           );
         } catch (err) {
           console.error('[bvm:resolve] _dynamic_import failed for file URL "' + specifier + '": ' + ((err && err.message) || err));
           throw err;
         }
         if (!bvmFileData || bvmFileData.source === null || bvmFileData.source === undefined || bvmFileData.source === '') {
           var bvmFileNotFound = new Error("[ERR_MODULE_NOT_FOUND]: Cannot find module '" + specifier + "'");
           bvmFileNotFound.code = 'ERR_MODULE_NOT_FOUND';
           console.error('[bvm:resolve] ' + bvmFileNotFound.message);
           throw bvmFileNotFound;
         }
         var bvmFileName = (bvmFileData && bvmFileData.resolvedPath) || bvmFilePath;
         try {
           bvmFileData = await bvmFileInterop.callParent(
             '_build_file',
             bvmFileData.source,
             bvmFileName,
             'import',
             '/',
             '/',
             false
           );
         } catch (err) {
           console.error('[bvm:resolve] _build_file failed for file URL "' + specifier + '": ' + ((err && err.message) || err));
           throw err;
         }
         if (bvmFileData === null || bvmFileData === undefined || bvmFileData === '') {
           var bvmFileBuildEmpty = new Error("[bvm:resolve] _build_file returned empty source for file URL '" + specifier + "'");
           console.error('[bvm:resolve] ' + bvmFileBuildEmpty.message);
           throw bvmFileBuildEmpty;
         }
         return "data:text/javascript;charset=utf-8," + encodeURIComponent(bvmFileData);
       }


        return defaultResolve(specifier, parentURL);
      }
    };
  `;
      doc.head.appendChild(optionsScript);
      // 5. Add your dynamic code script tag
      const script = doc.createElement("script");
      script.type = "module-shim";
      script.textContent = code;
      doc.body.appendChild(script);
      // 4. Load es-module-shims SECOND with async = false to guarantee it reads the options immediately
      const shimScript = doc.createElement("script");
      shimScript.async = false;
      shimScript.src =
        "https://ga.jspm.io/npm:es-module-shims@1.10.0/dist/es-module-shims.js";
      doc.head.appendChild(shimScript);

      return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
    }

    function buildHtmlString2(csp, code, hasImports) {
      // Create a new HTML document
      const doc = document.implementation.createHTMLDocument();

      // Add the CSP meta tag
      const meta = document.createElement("meta");
      meta.setAttribute("http-equiv", "Content-Security-Policy");
      meta.setAttribute("content", csp);
      doc.head.appendChild(meta);

      const script = document.createElement("script");
      if (hasImports) script.type = "module";
      script.textContent = code;
      doc.body.appendChild(script);

      // Serialize to string, including DOCTYPE
      return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
    }

    const htmlString = buildHtmlString(csp, code, hasImports, this);

    const blob = new Blob([htmlString], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    this.iframe.src = url;
    this.code = code;
    if (this.oldURL) {
      URL.revokeObjectURL(this.oldURL);
    }
    this.oldURL = url;
    // URL.revokeObjectURL(oldUrl);
  }

  hoistingTransform(code, objectName) {
    return code; // currently disabled as of right now.
    const ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
    const interopVariable = objectName;
    const ms = new MagicString(code);

    const hoistNodes = [];
    let insertAfter = null;

    // Walk AST
    walk.simple(ast, {
      CallExpression(node) {
        // collect .expose calls
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === objectName &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "expose"
        ) {
          hoistNodes.push(node);
        }
      },
      AssignmentExpression(node) {
        // detect window[interopVariable] = ...
        const left = node.left;
        if (
          left.type === "MemberExpression" &&
          left.object.type === "Identifier" &&
          left.object.name === "window"
        ) {
          if (
            (left.property.type === "Identifier" &&
              left.property.name === interopVariable) ||
            (left.property.type === "Literal" &&
              left.property.value === interopVariable)
          ) {
            insertAfter = node.end;
          }
        }
      },
    });

    if (hoistNodes.length) {
      // Generate hoisted code
      let hoistedCode = "";
      for (const node of hoistNodes) {
        hoistedCode += ms.slice(node.start, node.end) + ";\n";
        ms.remove(node.start, node.end);
      }

      if (insertAfter !== null) {
        ms.appendLeft(insertAfter, "\n" + hoistedCode);
      } else {
        // fallback: prepend at top
        ms.prepend(hoistedCode);
      }
    }
    return ms.toString();
  }

  /**
   * Setup message listener
   */
  listen(resolve, reject) {
    this._resolve = resolve;
    this._reject = reject;

    this.messageHandler = async (event) => {
      // Security check - only accept messages from our iframe
      if (event.source !== this.iframe.contentWindow) {
        return;
      }

      if (this.resolved) return;

      const data = event.data;

      // ── Server Shims ──────────────────────────────────────────────────────────────
      if (data.type === "serverListening") {
        const _vfsPort = _vfsExtractServerPort(data);
        this.sandbox.emit("execution:server", { type: "open", port: _vfsPort });
        this._serverRunning = true;
        this._serverPort = _vfsPort;
        if (_vfsPort != null) {
          this._vfsPorts.add(_vfsPort);
          if (!_vfsRegisterServerRoute(_vfsPort, this)) {
            // Another sandbox claimed this port first: revoke the loser so
            // its listen() fails loudly with EADDRINUSE (Node behavior).
            this._vfsPorts.delete(_vfsPort);
            this.invoke("__closeServer__", _vfsPort).catch(() => {});
          }
        }
      }

      if (data.type === "serverClosed") {
        const _vfsClosedPort = _vfsExtractServerPort(data) ?? this._serverPort;
        this.sandbox.emit("execution:server", {
          type: "closed",
          port: _vfsClosedPort,
        });
        _vfsUnregisterServerRoute(_vfsClosedPort, this);
        this._vfsPorts.delete(_vfsClosedPort);
        this._serverRunning = false;
        this._serverPort = null;
      }

      // ── spawn ──────────────────────────────────────────────────────────────
      if (data.type === "PARENT_SPAWN_REQUEST") {
        const { command, args = [], options, vfs } = data.payload;
        const assembled = [command, ...args].join(" ");

        const pushChunk = (stream, chunk) =>
          event.source.postMessage(
            {
              type: "PARENT_SPAWN_DATA",
              requestId,
              payload: { stream, chunk },
            },
            "*",
          );
      }

      if (data.type === "PARENT_EXEC_REQUEST") {
        // BYO shell (Jared 2026-10-03): developers provide their own shell
        // function via `new CodeSandbox({ shell })`. If provided, route the
        // request to it. If not, throw a loud configuration error.
        const shellFn = this.config.shell;
        if (typeof shellFn !== "function") {
          throw new Error(
            "CodeSandbox: no shell configured. " +
              "Pass a `shell` function in CodeSandbox options to enable child_process.",
          );
        }

        try {
          /*
                   // Send live streams if needed (or just send the final chunk)
      if (result.stdout) {
        source.postMessage({ type: 'STDOUT', id: requestId, payload: result.stdout }, '*');
      }
      if (result.stderr) {
        source.postMessage({ type: 'STDERR', id: requestId, payload: result.stderr }, '*');
      }
      */

          /*
                  import { spawn } from 'child_process';

// Spawn a process (using a cross-platform node inline script as an example)
const child = spawn('node', [`
    console.log('Starting task...');
    setTimeout(() => console.log('Processing step 1...'), 1000);
    setTimeout(() => console.log('Processing step 2...'), 2000);
    setTimeout(() => console.log('Done!'), 3000);
`]);

// Listen for live chunks of stdout as they arrive
child.stdout.on('data', (chunk) => {
    // Convert chunk to string and split by lines
    const lines = chunk.toString().split(/\r?\n/);
     
    lines.forEach((line) => {
        if (line.trim() !== '') {
            process.stdout.write(`[LIVE STDOUT]: ${line}\n`);
        }
    });
});
// Listen for live chunks of stderr (errors)
child.stderr.on('data', (chunk) => {
    process.stderr.write(`[LIVE STDERR]: ${chunk}`);
});
 
// Handle process completion
child.on('close', (code, signal) => {
    console.log(`\nProcess exited with code ${code} and signal ${signal}`);
});

// Handle errors (e.g., if the command itself fails to start)
child.on('error', (err) => {
    console.error('Failed to start process:', err);
}); 
*/

          const result = await shellFn(
            data.payload.command,
            data.payload.args || [],
            data.payload.options || {},
          );

          // Send result back to the specific iframe that requested it
          event.source.postMessage(
            {
              type: "PARENT_CHILD_EXEC_RESPONSE",
              requestId: data.requestId,
              payload: result,
            },
            "*",
          );
        } catch (err) {
          event.source.postMessage(
            {
              type: "PARENT_CHILD_EXEC_RESPONSE",
              requestId: data.requestId,
              payload: {
                stdout: "",
                stderr: err?.message || "Command not found or syntax error",
                exitCode: 1,
              },
            },
            "*",
          );
        }
      }

      if (data.type === "fs") {
        this.sandbox.emit("execution:fs", data);
        return;
      }

      if (data.type === "interop_call") {
        this.handleInteropCall(data);
        return;
      }

      if (data.type === "newline") {
        this.sandbox.emit("execution:readline_newline", true);
        return;
      }

      if (data.type === "interop_registered") {
        this.sandbox.emit("execution:interop_registered", { name: data.name });
        return;
      }

      // NEW: Handle interop responses
      if (data.type === "interop_result") {
        const callback = this.interopCallbacks.get(data.callId);
        if (callback) {
          this.interopCallbacks.delete(data.callId);
          if (data.error) {
            callback.reject(new Error(data.error));
          } else {
            callback.resolve(data.result);
          }
        }
        return;
      }

      if (data.type === "sandbox_ready") {
        /*
         this.executionCount++;
         const executionId = this.executionCount;
         this.emit('execution:start', { id: executionId, code });
         */
        // this.executionCount++;
        const executionId = this.sandbox.executionCount;
        this.running = true;
        this.sandbox.emit("execution:start", { id: executionId, code: false });
      }

      if (data.type === "function_results") {
        this.resolved = true;
        this.cleanup();
        const results = {
          success: true,
          logs: data.logs || [],
          errors: data.errors || [],
          //output: data.logs,
          fs: data.fs,
          executionTime: data.executionTime,
        };
        resolve(results);
      } else if (data.type === "stdout") {
        // this.logs.push({type:data.method, args:data.message})
        this.sandbox.emit("execution:stdout", {
          type: data.method,
          args: data.message,
        });
        // Derived alias (docs/PLUGINS.md decision "execution:stderr"):
        // Node routes console.error AND console.warn to fd 2, so hosts
        // that render stderr separately get a dedicated event. Backwards
        // compatible — execution:stdout keeps firing for every console.* call.
        if (data.method === "error" || data.method === "warn") {
          this.sandbox.emit("execution:stderr", {
            type: data.method,
            args: data.message,
          });
        }
      } else if (data.type === "resource_timing") {
        const r = JSON.parse(data.message);
        this.sandbox.emit("execution:resource_timing", r);
      } else if (data.type === "key_event") {
        const r = JSON.parse(data.message);

        this.sandbox.emit("execution:key_event", r);
      } else if (data.type === "network_request") {
        const r = JSON.parse(data.message);

        this.sandbox.emit("execution:network_request", r);
      } else if (data.type === "kill") {
        this.resolved = true;
        this.cleanup();
        this.killed = true;
        const results = {
          success: true,
          error: data?.error || false,
          logs: [...data.logs, "Process Exited"],
          // output: [...data.logs, 'Process Exited'],
          executionTime: data.executionTime,
          exitCode: data?.exitCode ?? null,
        };
        resolve(results);
      } else if (data.type === "function_error") {
        // Map frames to original positions via the source-map registry.
        // Falls back to legacy line-offset math if no frames/registry.
        let mappedReason;
        if (data.frames && data.frames.length) {
          const mapped = this.sandbox._mapStackFrames(data.frames, this.code);
          mappedReason = this.sandbox._formatMappedError(
            data.errorName,
            data.error,
            mapped,
          );
        } else {
          // Legacy fallback (no structured frames)
          let line = this.code
            .slice(0, this.code.indexOf("//__$PROVIDED_RUNTIME_CODE__/"))
            .split("\n").length;
          line = data.line - line;
          const isNegative = (n) => n < 0;
          if (isNegative(line)) {
            mappedReason = `${data.stack || data.reason || data.error || data.message}`;
          } else {
            const codeThatThrewError =
              this.code.split("\n")[Number(data.line) - 1] || "";
            mappedReason = `${data.stack || data.reason || data.error || data.message}\nat line ${line}, column ${data.column} \n \n →    ${line}| ${codeThatThrewError}`;
          }
        }

        this.resolved = true;
        this.cleanup();
        resolve({
          success: false,
          error: data.error,
          stack: mappedReason,
          logs: data.logs,
          executionTime: data.executionTime,
        });
      } else if (data.type === "window_error") {
        if (this.config.captureWindowErrors && !this.resolved) {
          this.resolved = true;
          this.cleanup();
          // Map frames to original positions via the source-map registry.
          const mapped =
            data.frames && data.frames.length
              ? this.sandbox._mapStackFrames(data.frames, this.code)
              : [];
          const mappedMsg = mapped.length
            ? this.sandbox._formatMappedError(
                data.errorName,
                data.message,
                mapped,
              )
            : data.message || "Window error";
          const err = new Error(mappedMsg);
          if (data.stack) err.stack = String(data.stack);
          reject(err);
        }
      } else if (data.type === "unhandled_promise_rejection") {
        if (this.config.capturePromiseRejections && !this.resolved) {
          this.resolved = true;
          this.cleanup();

          // Map frames to original positions via the source-map registry.
          const mapped =
            data.frames && data.frames.length
              ? this.sandbox._mapStackFrames(data.frames, this.code)
              : [];
          const mappedReason = mapped.length
            ? this.sandbox._formatMappedError(
                data.errorName,
                data.reason,
                mapped,
              )
            : data.reason || "Unhandled promise rejection";

          const rejectionError = new Error(mappedReason);
          if (data.stack) rejectionError.stack = String(data.stack);
          reject(rejectionError);
        }
      }
    };

    window.addEventListener("message", this.messageHandler);
    this.cleanupCallbacks.push(() => {
      window.removeEventListener("message", this.messageHandler);
    });
  }

  async handleInteropCall(data) {
    const { callId, method, args } = data;

    // Check if sandbox has registered this method
    const handler = this.sandbox.interopHandlers?.[method];

    if (!handler) {
      this.iframe.contentWindow.postMessage(
        {
          type: "interop_response",
          callId,
          error: {
            message: `Method '${method}' not registered in parent`,
            code: "ERR_INTEROP_NO_HANDLER",
            name: "Error",
          },
        },
        "*",
      );
      return;
    }

    try {
      const result = await handler(...args);

      this.iframe.contentWindow.postMessage(
        {
          type: "interop_response",
          callId,
          result,
        },
        "*",
      );
    } catch (err) {
      // Send structured error info so the sandbox can reconstruct
      // err.code / err.name (e.g. ERR_MODULE_NOT_FOUND), not just the message.
      this.iframe.contentWindow.postMessage(
        {
          type: "interop_response",
          callId,
          error: {
            message: err && err.message ? err.message : String(err),
            code: err && err.code,
            name: (err && err.name) || "Error",
          },
        },
        "*",
      );
    }
  }

  // NEW: Call functions inside sandbox from parent
  /**
   * Call functions inside sandbox from parent
   * Use arrow function syntax to ensure 'this' always refers to the ExecutionContext instance.
   */
  invoke = async (method, ...args) => {
    // Ensure the iframe is actually loaded before sending messages.
    // __stdin__ is allowed through when the iframe exists even if the
    // running flag hasn't been set yet (sandbox_ready can lag); the
    // iframe-side __stdin__ handler validates listeners itself.
    const isStdin = method === "__stdin__";
    if (
      !this.iframe ||
      !this.iframe.contentWindow ||
      (!isStdin && this.running === false)
    ) {
      throw new Error("Sandbox is not running.");
    }
    const callId = Math.random().toString(36).substr(2, 9);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Check if it still exists before rejecting to avoid race conditions

        if (this.interopCallbacks.has(callId)) {
          this.interopCallbacks.delete(callId);
          if (this.running === false) {
            reject(
              new Error(`Interop method failed (sandbox is closed): ${method}`),
            );
          } else {
            reject(new Error(`Interop invoke timeout: ${method}`));
          }
        }
      }, 10000);

      // This will no longer throw "undefined" because of the arrow function
      this.interopCallbacks.set(callId, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.iframe.contentWindow.postMessage(
        {
          type: "interop_invoke",
          callId,
          method,
          args,
        },
        "*",
      );
    });
  };

  /**
   * Parses method names exposed via [variable].expose('name', ...)
   * @param {string} code - The source code to parse
   * @param {string} interopVar - The variable name to look for (e.g., 'interop')
   */
  _parseExposedMethods(code, interopVar) {
    const exposedMethods = [];

    const ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
    });

    walk.simple(ast, {
      CallExpression(node) {
        const { callee, arguments: args } = node;

        if (
          callee.type === "MemberExpression" &&
          callee.object.name === interopVar &&
          callee.property.name === "expose"
        ) {
          if (args[0] && args[0].type === "Literal") {
            exposedMethods.push(args[0].value);
          }
        }
      },
    });

    return exposedMethods;
  }

  /**
   * Setup message listener
   */
  serverRunning = (method) => {
    return this._serverRunning;
  };

  hasMethod = async (method) => {
    try {
      if (this.exposedMethods.includes(method)) {
        return true;
      }
      return false;
      // We invoke a special internal check
      //return await this.invoke('__check_exists__', method);
    } catch {
      return false;
    }
  };

  /**
   * Cleanup resources
   */
  cleanup() {
    this.running = false;

    if (this._serverRunning === true) {
      this.sandbox.emit("execution:server", {
        type: "closed",
        port: this._serverPort,
      });
      this._serverRunning = false;
      this._serverPort = null;
    }
    // Release every virtual-server route this sandbox owned so the host
    // fetch bridge stops routing to a dead sandbox and the native fetch
    // is restored once the final route disappears.
    if (this._vfsPorts) {
      for (const _vfsPort of this._vfsPorts)
        _vfsUnregisterServerRoute(_vfsPort, this);
      this._vfsPorts.clear();
    }

    this.cleanupCallbacks.forEach((cb) => {
      try {
        cb();
      } catch (err) {
        console.warn("Cleanup error:", err);
      }
    });
    this.cleanupCallbacks = [];

    if (
      this.iframe &&
      this.iframe.parentNode &&
      this.sandbox.destroyIframe === true
    ) {
      this.iframe.remove();
    }
  }
}

