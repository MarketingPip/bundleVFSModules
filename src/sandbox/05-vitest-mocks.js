// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// A recursive Proxy that intercepts *any* missing property access and returns safe stubs
    function createSafeProxy(target = {}) {
      return new Proxy(target, {
        get(obj, prop) {
          if (prop === Symbol.iterator) return obj[Symbol.iterator];
          if (prop in obj) {
            const val = obj[prop];
            if (val && typeof val === 'object') return createSafeProxy(val);
            return val;
          }
          // Fallback recursive proxy for any unmapped configuration property
          return createSafeProxy();
        }
      });
    }

    // Mock globalThis.__vitest_worker__ using the Proxy so .config or anything else never throws
    globalThis.__vitest_worker__ = createSafeProxy({
      config: {
        root: '/',
        globals: true,
        environment: 'node',
        test: {
          globals: true,
          environment: 'node',
          reporters: [],
          pool: 'threads'
        }
      },
      durations: { environment: 0, prepare: 0 },
      rpc: {}
    });
