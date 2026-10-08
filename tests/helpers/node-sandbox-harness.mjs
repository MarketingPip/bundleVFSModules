// Node.js VM harness for testing the sandbox runtime without a browser.
// Runs SandboxRuntime.generate() output in a vm context with mocked window.
// ~100x faster than Firefox+Selenium for interactive tests.
//
// Usage:
//   import { NodeSandboxHarness } from './node-sandbox-harness.mjs';
//   const h = new NodeSandboxHarness();
//   await h.execute('console.log("hello");');
//   console.log(h.stdout); // ["hello"]
//
// Does NOT test: true iframe isolation, postMessage structured cloning.

import vm from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { PerformanceObserver, performance } from 'node:perf_hooks';

export class NodeSandboxHarness {
  constructor(options = {}) {
    // UUID format matches CodeSandbox: "_u_" + uuid without dashes
    // (dashes are invalid in the generated _RUNTIME<uuid>_ identifier)
    const cleanUuid = `_u_${String(options.uuid || `${Date.now()}${Math.random().toString(36).slice(2, 8)}`).replace(/-/g, '')}`;
    this.options = {
      timeout: options.timeout || 30000,
      ...options,
      uuid: cleanUuid,
    };
    this.messages = []; // All postMessage calls from sandbox
    this.stdout = [];
    this.stderr = [];
    this.messageHandlers = [];
    this.context = null;
    this.sandboxGlobal = null;
  }

  /**
   * Create a fresh vm context with mocked window/document.
   * Each test gets fresh wrappers (no shared references with host).
   */
  createContext() {
    const self = this;

    // Mock window.parent.postMessage -> record messages
    const mockParent = {
      postMessage(msg, origin) {
        self.messages.push({ ...msg, _origin: origin });
        self._dispatchToParent(msg);
      },
    };

    // Mock window (fresh object, not host's window)
    const mockWindow = {
      parent: mockParent,
      addEventListener(type, handler) {
        if (type === 'message') {
          self.messageHandlers.push(handler);
        }
      },
      removeEventListener(type, handler) {
        const i = self.messageHandlers.indexOf(handler);
        if (i >= 0) self.messageHandlers.splice(i, 1);
      },
      location: { href: 'about:blank', origin: 'null' },
    };

    // The vm context global
    // IMPORTANT: Use fresh wrapper objects, never host's live objects
    // (assigning console.log inside vm would override host's console)
    const sandboxGlobal = {
      window: mockWindow,
      globalThis: null, // set below
      console: {
        log: (...args) => self.stdout.push(args.map(String).join(' ')),
        error: (...args) => self.stderr.push(args.map(String).join(' ')),
        warn: (...args) => self.stderr.push(args.map(String).join(' ')),
        info: (...args) => self.stdout.push(args.map(String).join(' ')),
        debug: (...args) => self.stdout.push(args.map(String).join(' ')),
      },
      setTimeout: (...args) => setTimeout(...args),
      clearTimeout: (...args) => clearTimeout(...args),
      setInterval: (...args) => setInterval(...args),
      clearInterval: (...args) => clearInterval(...args),
      queueMicrotask: (...args) => queueMicrotask(...args),
      // Minimal document stub (only what the anti-fingerprinting mask needs)
      document: {
        createElement: () => ({ style: {} }),
      },
      // Performance API
      performance,
      PerformanceObserver,
      // URL, Blob, etc. (pass through from host — these are safe)
      URL,
      Blob,
      TextEncoder,
      TextDecoder,
      // MessageChannel for interop
      MessageChannel,
    };
    sandboxGlobal.globalThis = sandboxGlobal;
    // window.window === window (browser semantics)
    mockWindow.window = mockWindow;
    sandboxGlobal.window = mockWindow;

    this.sandboxGlobal = sandboxGlobal;
    this.context = vm.createContext(sandboxGlobal, {
      name: `sandbox-${this.options.uuid}`,
    });
    return this.context;
  }

  /**
   * Dispatch a message from sandbox to parent handlers.
   * Mirrors ExecutionContext.listen in runtime.js.
   */
  _dispatchToParent(data) {
    if (data.type === 'stdout') {
      // data: { type: 'stdout', method, message }
      const text = String(data.message ?? '');
      if (data.method === 'error' || data.method === 'warn') {
        this.stderr.push(text);
      } else {
        this.stdout.push(text);
      }
    } else if (data.type === 'stderr') {
      this.stderr.push(String(data.message ?? ''));
    }
    // Other message types (interop_result, function_error, etc.)
    // are recorded in this.messages for test assertions
  }

  /**
   * Send a message from parent to sandbox (simulates iframe postMessage).
   */
  sendToSandbox(data) {
    const event = { data, origin: '*', source: null };
    for (const handler of this.messageHandlers) {
      try {
        handler(event);
      } catch (e) {
        // Handler errors shouldn't break the test harness
        console.error('Sandbox message handler error:', e);
      }
    }
  }

  /**
   * Execute user code in the sandbox.
   * @param {string} userCode - The JavaScript to run
   * @param {object} generateOptions - Options for SandboxRuntime.generate
   * @returns {Promise<{stdout: string[], stderr: string[], messages: object[]}>}
   */
  async execute(userCode, generateOptions = {}) {
    // Lazy-load runtime.js (needs the esm.sh loader hook)
    const { SandboxRuntime } = await import('../../runtime.js');

    this.createContext();

    const config = {
      uuid: this.options.uuid,
      interopVariable: `_RUNTIME_${this.options.uuid}_`,
      process: { argv: [], env: {}, ...generateOptions.process },
      fs: generateOptions.fs,
      fileName: generateOptions.fileName || 'test.mjs',
      ...generateOptions,
    };

    // Generate the sandbox code
    const sandboxCode = SandboxRuntime.generate(userCode, config);

    // Run it in the vm context using SourceTextModule for import() support
    // (vm.runInContext doesn't support dynamic import)
    // IMPORTANT: Pass context to the module so it sees our mocked globals
    const mod = new vm.SourceTextModule(sandboxCode, {
      identifier: `sandbox-${this.options.uuid}.mjs`,
      context: this.context,
      importModuleDynamically: async (specifier, referrer) => {
        // Emulate the parent _dynamic_import interop
        // For now, handle data: URLs and builtin resolution
        if (specifier.startsWith('data:')) {
          const code = decodeURIComponent(specifier.split(',')[1]);
          const m = new vm.SourceTextModule(code, {
            identifier: 'dynamic-import.mjs',
            importModuleDynamically: async () => { throw new Error('Nested dynamic import not supported in harness'); },
          });
          await m.link(() => {});
          await m.evaluate();
          return m.namespace;
        }
        throw new Error(`Harness cannot resolve dynamic import: ${specifier}`);
      },
    });

    await mod.link(() => {
      throw new Error('Static imports not supported in harness generated code');
    });
    await mod.evaluate();

    // Give async code a tick to run
    await new Promise(r => setTimeout(r, 100));

    return {
      stdout: [...this.stdout],
      stderr: [...this.stderr],
      messages: [...this.messages],
    };
  }

  /**
   * Simulate __stdin__ interop: push data to the sandbox's stdin.
   * This mimics what CodeSandbox.invoke('__stdin__', data) does via postMessage.
   */
  async pushStdin(data) {
    // The sandbox listens for interop messages via window 'message' event
    // The __stdin__ handler is registered via interop
    // We simulate by directly invoking through the message channel
    this.sendToSandbox({
      type: 'interop_invoke',
      method: '__stdin__',
      args: [data],
      // The sandbox's interop handler will process this
    });
    // Give it a tick
    await new Promise(r => setTimeout(r, 100));
  }

  /**
   * Reset captured output between tests.
   */
  reset() {
    this.messages = [];
    this.stdout = [];
    this.stderr = [];
    this.messageHandlers = [];
  }
}
