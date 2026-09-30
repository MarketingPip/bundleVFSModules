// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
/* global _builtinRequireValue, _builtinCache, _builtinManifest, resolveSyncRequest, readModuleSourceLiveFirst */
// (cross-fragment globals, defined in other src/sandbox/*.js sections)
/** Wraps a CommonJS source string in an ESM-compatible IIFE. */
/**
 * Synchronous require() for CJS modules (vitest support).
 * Resolves against VFS, loads source synchronously, executes with
 * cycle tolerance (returns partial exports on circular require).
 */
// eslint-disable-next-line no-unused-vars -- used cross-fragment by 20-module-loader.js
function createSyncRequire(parentPath, vfs, cache) {
  // One cache shared across the whole require tree (passed down to recursive
  // requires). A fresh Map per recursion would break cache identity and turn
  // circular requires into infinite recursion instead of Node-style partial
  // exports.
  cache = cache || new Map(); // resolvedPath -> module record (for cycles)

  function syncRequire(request) {
    // 1. Built-in modules: return from cache if loaded, else throw
    // (async loadBuiltin must have been called first)
    let builtinKey = request.startsWith("node:") ? request.slice(5) : request;
    if (_builtinManifest[builtinKey] || _builtinManifest[request]) {
      const key = _builtinManifest[builtinKey] ? builtinKey : request;
      if (_builtinCache.has(key)) {
        return _builtinRequireValue(_builtinCache.get(key));
      }
      throw new Error(
        '[ERR_REQUIRE_ASYNC]: Built-in "' +
          request +
          '" not yet loaded. ' +
          'Call await loadBuiltin("' +
          request +
          '") first, or use dynamic import().',
      );
    }

    // 2. Resolve path (relative/absolute)
    // Uses resolveSyncRequest for Node.js-compatible path resolution.
    // Bare specifiers (node_modules) throw ERR_MODULE_NOT_FOUND (TODO: full
    // node_modules walk with package.json exports).
    let resolved;
    try {
      resolved = resolveSyncRequest(request, parentPath, vfs);
    } catch (err) {
      throw new Error(
        "[ERR_MODULE_NOT_FOUND]: Cannot find module '" + request + "'",
      );
    }

    // 3. Check cache (cycle tolerance: return partial exports)
    if (cache.has(resolved)) {
      return cache.get(resolved).exports;
    }

    // 4. Load source synchronously: live memfs first, snapshot VFS fallback
    const source = readModuleSourceLiveFirst(resolved, vfs);
    if (source == null) {
      throw new Error(
        "[ERR_MODULE_NOT_FOUND]: Cannot find module '" +
          request +
          "' (resolved: " +
          resolved +
          ")",
      );
    }

    // 5. Create module object, cache BEFORE executing (for cycles)
    const module = {
      exports: {},
      id: resolved,
      filename: resolved,
      loaded: false,
    };
    cache.set(resolved, module);

    // 5b. JSON modules: parse the source as JSON (Node semantics)
    // instead of executing it as JavaScript.
    if (resolved.endsWith(".json")) {
      try {
        module.exports = JSON.parse(source);
      } catch (err) {
        cache.delete(resolved);
        throw err;
      }
      module.loaded = true;
      return module.exports;
    }

    // 6. Wrap and execute
    // Node.js CJS semantics: 'this' at module top-level === 'module.exports'.
    // Invoke via .call(module.exports, ...) so 'this' is correct. A plain
    // wrapper(...) call would make 'this' undefined (strict) or globalThis
    // (sloppy), breaking 'this.foo = bar' (should set module.exports.foo,
    // not a global).
    const wrapper = new Function(
      "require",
      "module",
      "exports",
      "__filename",
      "__dirname",
      source + String.fromCharCode(10) + "//# sourceURL=" + resolved,
    );
    const dirname = resolved.split("/").slice(0, -1).join("/") || ".";
    try {
      wrapper.call(
        module.exports, // 'this' === module.exports (Node CJS parity)
        createSyncRequire(resolved, vfs, cache), // recursive require shares the cache
        module,
        module.exports,
        resolved,
        dirname,
      );
    } catch (err) {
      cache.delete(resolved); // remove failed module from cache
      throw err;
    }
    module.loaded = true;
    return module.exports;
  }

  syncRequire.cache = cache;
  // Node.js parity: require.resolve() locates the module entry point on
  // the VFS without loading it. Uses the same resolution logic as require().
  syncRequire.resolve = (request) => {
    // Builtins resolve to their specifier (Node returns the builtin name).
    let builtinKey = request.startsWith("node:") ? request.slice(5) : request;
    if (_builtinManifest[builtinKey] || _builtinManifest[request]) {
      return request;
    }
    return resolveSyncRequest(request, parentPath, vfs);
  };
  return syncRequire;
}

function wrapCommonJS(source, parentPath, vfs) {
  // The require function is provided at module instantiation time via
  // the runtime's sync require. For ESM-converted CJS, we embed a
  // placeholder that gets replaced with the real require.
  //
  // Node.js CJS semantics:
  // - 'this' at module top-level === 'module.exports' (via .call)
  // - '__filename' and '__dirname' are available
  const filename = parentPath;
  const dirname = parentPath.split("/").slice(0, -1).join("/") || ".";
  return `
const exports = {};
const module = { exports };
const __filename = ${JSON.stringify(filename)};
const __dirname = ${JSON.stringify(dirname)};
// Sync require is provided by the runtime via __syncRequire__
const require = typeof __syncRequire__ !== 'undefined'
  ? __syncRequire__
  : (() => { throw new Error('[ERR_REQUIRE_NOT_SUPPORTED]: sync require not available in this context'); });

(function (require, module, exports, __filename, __dirname) {
  ${source}
}).call(module.exports, require, module, exports, __filename, __dirname);

export default module.exports;
`;
}

/** Dynamically imports a data-URL and returns a proxied module object. */
async function importAndProxy(url, modulePath, relativeName, moduleType) {
  const data = await import(url);
  return buildModuleProxy(data, modulePath, relativeName, moduleType);
}

/**
 * Builds the module proxy / plain object returned to the caller.
 * - For require(): unwraps `.default` (CommonJS compat).
 * - For ESM:       throws on missing named exports, hides `.default` when absent.
 */
function buildModuleProxy(data, modulePath, relativeName, moduleType) {
  const moduleObject = Object.assign({}, data);

  Object.defineProperty(moduleObject, Symbol.toStringTag, {
    value: "Module",
    enumerable: false,
  });

  // CJS marker (see convertCjsToEsm): named ESM imports from a CJS module
  // resolve against module.exports (Node cjs-module-lexer parity). Keep the
  // marker out of the visible namespace.
  const isCjs = !!moduleObject.__bvm_cjs__;
  delete moduleObject.__bvm_cjs__;

  // Star re-exports (see convertCjsToEsm __exportStar → export * from).
  // __bvm_star_* hold lifted module namespaces to re-export (all keys
  // except `default`, per ESM semantics). Collected for proxy fallback and
  // hidden from the visible namespace like __bvm_cjs__.
  const starSources = [];
  for (const key of Object.keys(moduleObject)) {
    if (key.startsWith("__bvm_star_")) {
      const starMod = moduleObject[key];
      if (
        starMod &&
        (typeof starMod === "object" || typeof starMod === "function")
      ) {
        starSources.push(starMod);
      }
      delete moduleObject[key];
    }
  }

  if (moduleType === "require") {
    return moduleObject.default ?? moduleObject;
  }

  const hasDefault = Object.prototype.hasOwnProperty.call(data, "default");

  // Keep .default enumerable and accessible when the module exported one.
  // If there's no default export, define it as undefined (non-enumerable)
  // so `import { default as x }` still resolves without a throw, but
  // Object.keys() / for..in won't surface a spurious `default` key.
  /* if (!hasDefault) {
    Object.defineProperty(moduleObject, 'default', {
      value: undefined,
      enumerable: false,
      configurable: true,
    });
  }*/

  //if (!hasDefault) delete moduleObject.default;

  return new Proxy(moduleObject, {
    get(target, prop) {
      if (typeof prop === "symbol" || prop === "then") return target[prop];

      if (prop === "default") return target?.default || target; // TODO: if sourceType is CJS - force default.
      if (prop === "__esModule") return true;

      if (!(prop in target)) {
        // Star re-export fallback (ESM `export *` semantics): check each
        // star source, skipping `default`. Star modules are proxied and
        // throw SyntaxError for missing exports; try the next source.
        for (const starMod of starSources) {
          if (prop === "default") break;
          try {
            return starMod[prop];
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
        // CJS interop (Node parity): a named import from a CJS module
        // resolves against module.exports, including keys it inherited
        // via spread (which static analysis cannot see).
        if (isCjs) {
          const cjsExports = target.default;
          if (
            cjsExports !== null &&
            (typeof cjsExports === "object" ||
              typeof cjsExports === "function") &&
            prop in cjsExports
          ) {
            return cjsExports[prop];
          }
        }
        const displayPath = relativeName ?? modulePath;
        throw new SyntaxError(
          `The requested module '${displayPath}' does not provide an export named '${String(prop)}'`,
        );
      }

      return target[prop];
    },
  });
}
