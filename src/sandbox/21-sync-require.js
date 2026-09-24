// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
/** Wraps a CommonJS source string in an ESM-compatible IIFE. */
/**
 * Synchronous require() for CJS modules (vitest support).
 * Resolves against VFS, loads source synchronously, executes with
 * cycle tolerance (returns partial exports on circular require).
 */
function createSyncRequire(parentPath, vfs) {
  const cache = new Map(); // resolvedPath -> module.exports (for cycles)
  
  function syncRequire(request) {
    // 1. Built-in modules: return from cache if loaded, else throw
    // (async loadBuiltin must have been called first)
    let builtinKey = request.startsWith('node:') ? request.slice(5) : request;
    if (_builtinManifest[builtinKey] || _builtinManifest[request]) {
      const key = _builtinManifest[builtinKey] ? builtinKey : request;
      if (_builtinCache.has(key)) {
        const mod = _builtinCache.get(key);
        // Return default export or namespace
        return mod.default !== undefined && Object.keys(mod).length === 1 ? mod.default : mod;
      }
      throw new Error("[ERR_REQUIRE_ASYNC]: Built-in \"" + request + "\" not yet loaded. " +
        "Call await loadBuiltin(\"" + request + "\") first, or use dynamic import().");
    }
    
    // 2. Resolve path (relative/absolute)
    let resolved;
    if (request.startsWith('./') || request.startsWith('../') || request.startsWith('/')) {
      const fromDir = parentPath ? parentPath.split('/').slice(0, -1).join('/') : '';
      const joined = fromDir ? fromDir + '/' + request : request;
      const parts = joined.split('/');
      const normalized = [];
      for (const p of parts) {
        if (p === '..') normalized.pop();
        else if (p !== '.' && p !== '') normalized.push(p);
      }
      resolved = normalized.join('/');
      // Try .js extension
      if (!resolved.endsWith('.js')) {
        const withJs = resolved + '.js';
        // Check VFS for existence (simplified)
        resolved = withJs; // assume .js for now
      }
    } else {
      // Bare specifier (node_modules): simplified resolution
      // TODO: full node_modules walk with package.json exports
      throw new Error('[ERR_MODULE_NOT_FOUND]: Cannot find module \'' + request + '\'');
    }
    
    // 3. Check cache (cycle tolerance: return partial exports)
    if (cache.has(resolved)) {
      return cache.get(resolved).exports;
    }
    
    // 4. Load source from VFS (sync)
    // vfs is the unflattened filesystem object
    const source = vfsLookup(resolved, vfs);
    if (source == null) {
      throw new Error('[ERR_MODULE_NOT_FOUND]: Cannot find module \'' + request + '\' (resolved: ' + resolved + ')');
    }
    
    // 5. Create module object, cache BEFORE executing (for cycles)
    const module = { exports: {}, id: resolved, filename: resolved, loaded: false };
    cache.set(resolved, module);
    
    // 6. Wrap and execute
    const wrapper = new Function('require', 'module', 'exports', '__filename', '__dirname',
      source + '\n//# sourceURL=' + resolved);
    const dirname = resolved.split('/').slice(0, -1).join('/') || '.';
    try {
      wrapper(
        createSyncRequire(resolved, vfs), // recursive require with new parent
        module,
        module.exports,
        resolved,
        dirname
      );
    } catch (err) {
      cache.delete(resolved); // remove failed module from cache
      throw err;
    }
    module.loaded = true;
    return module.exports;
  }
  
  syncRequire.cache = cache;
  syncRequire.resolve = (request) => request; // simplified
  return syncRequire;
}

function wrapCommonJS(source, parentPath, vfs) {
  // The require function is provided at module instantiation time via
  // the runtime's sync require. For ESM-converted CJS, we embed a
  // placeholder that gets replaced with the real require.
  return `
const exports = {};
const module = { exports };
// Sync require is provided by the runtime via __syncRequire__
const require = typeof __syncRequire__ !== 'undefined' 
  ? __syncRequire__ 
  : (() => { throw new Error('[ERR_REQUIRE_NOT_SUPPORTED]: sync require not available in this context'); });

(function (require, module, exports) {
  ${source}
})(require, module, exports);

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
    value: 'Module',
    enumerable: false,
  });

  if (moduleType === 'require') {
    return moduleObject.default ?? moduleObject;
  }

  const hasDefault = Object.prototype.hasOwnProperty.call(data, 'default');
  
  
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
      if (typeof prop === 'symbol' || prop === 'then') return target[prop];

      if (prop === 'default') return  target?.default || target; // TODO: if sourceType is CJS - force default.
      if (prop === '__esModule') return true;

      if (!(prop in target)) {
        const displayPath = relativeName ?? modulePath;
        throw new SyntaxError(
          `The requested module '${displayPath}' does not provide an export named '${String(prop)}'`
        );
      }

      return target[prop];
    },
  });
}  
 
 
 
 
 