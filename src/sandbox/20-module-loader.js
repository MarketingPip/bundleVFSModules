// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.


// Registry of in-flight modules to catch circular references.
// Maps resolvedKey -> { status: 'loading' | 'done', exports, promise }
const moduleRegistry = new Map();

/**
 * Safely augment a caught load error with module context.
 *
 * loadModule's catch block used to assign error.message directly to add
 * " in <path> at <entry>" context. If the caught error has a getter-only
 * message property (DOMException, exotic WASM binding errors, frozen
 * error-likes), that assignment throws 'setting getter-only property
 * "message"', masking the real failure. Seen in headed Firefox as
 * success=false with the getter-only error instead of the root cause.
 *
 * This helper never throws: it tries in-place augmentation, and falls back
 * to wrapping the original (as cause) when message is not writable.
 * Returns the error to throw.
 *
 * No template literals here: runtime.js is itself a template file, and
 * this function is also extracted verbatim by tests via new Function().
 */
function augmentLoadError(error, displayPath, entryPoint) {
  var baseMessage;
  try {
    baseMessage = String(error && error.message);
  } catch (_) {
    baseMessage = String(error);
  }
  var augmented = baseMessage + " in " + displayPath + " at " + entryPoint;
  try {
    error.message = augmented;
    return error;
  } catch (_) {
    var wrapped = new Error(augmented);
    try {
      wrapped.cause = error;
    } catch (_) {}
    return wrapped;
  }
}

/**
 * @param {string} modulePath     - The import path as written (e.g. './foo', '../bar', or a URL)
 * @param {string} moduleType     - 'import' | 'require'
 * @param {string} [entryPoint]   - The original top-level entry file; passed through to interop
 * @param {string} [parentEntryPoint]   - The original file entry file point; passed through to interop
 
 *                                  so _build_file can resolve context-sensitive paths correctly.
 *                                  Defaults to modulePath when called at the root level.
 */
async function loadModule(modulePath, moduleType, entryPoint, parentEntryPoint) {

  const isDynamicModule = p => typeof p === 'string' && /^(data:text\/javascript|blob:)/.test(p);
  
  if(isDynamicModule(modulePath)){
   return await import(modulePath);
  }
 
  let relativeName = null;
 
  const node_builtin = "__BUILTIN_MODULES_ARRAY_JSON__"
  // Gap #6: "node:"-prefix normalization lives in the host-scope
  // normalizeBuiltinSpecifier; its source is inlined so the generated
  // script stays self-contained.
  const __normalizeBuiltinSpecifier = (__NORMALIZE_BUILTIN_SPECIFIER_FN__);

  const __builtinNorm = __normalizeBuiltinSpecifier(modulePath, node_builtin);
  const isNodeBuiltIn = __builtinNorm.isNodeBuiltIn;
  modulePath = __builtinNorm.modulePath;

  // The very first caller doesn't know the entry point yet — it IS the entry point.
  if (entryPoint === undefined) entryPoint = modulePath;

  if (parentEntryPoint === undefined) parentEntryPoint = null;

  try {
    // Normalize file:// URLs (e.g. from pathToFileURL) to absolute VFS paths.
    // Vite's terser plugin does await import(pathToFileURL(p).href).
    if (modulePath.startsWith("file://")) {
      modulePath = modulePath.slice("file://".length);
      // file:///x → /x (keep the leading slash); file://host/x → /x (VFS has no hosts)
      if (!modulePath.startsWith("/")) modulePath = "/" + modulePath;
    }
    const extension = modulePath.split('.').pop().toLowerCase();
    const isRelative = modulePath.startsWith('./') || modulePath.startsWith('../');
  const isAbsolute = modulePath.startsWith('/')

  let sourceResolvedError = false;
  
   const isJSModule = !['css'].includes(extension); // json is ESM via _build_file (Part B)
    // ─── Relative / interop-channel path ────────────────────────────────────
    if (isRelative || isNodeBuiltIn || isAbsolute || !isRelative && !isNodeBuiltIn && !isAbsolute && !modulePath.includes("https://")) {
      relativeName = modulePath;

      // Use a stable key for the registry (entry + requested path disambiguates
      // the same filename required from different entry points).
      // Provisional: keyed by raw specifier until _dynamic_import resolves it.
      // canonicalizeRegistryEntry migrates to the resolved-path key below.
      let registryKey = `${entryPoint}::${modulePath}`;
      // ── Circular reference guard ─────────────────────────────────────────
      if (moduleRegistry.has(registryKey) && isJSModule) {
        const record = moduleRegistry.get(registryKey);

        if (record.status === 'loading') {
          // Circular dep detected — return the partially-populated exports object
          // so the caller gets a live reference that will be filled in once the
          // module finishes executing (same pattern Node.js uses).
          console.warn(
            `[loadModule] Circular dependency detected for "${modulePath}" ` +
            `(entry: "${entryPoint}"). Returning partial exports.`
          );
          return record.exports;
        }

        // Already fully resolved — return cached result.
        return record.exports;
      }

      // Create a placeholder record immediately so any re-entrant call above
      // sees 'loading' and gets the partial exports object.
      const partialExports = {};
      const record = { status: 'loading', exports: partialExports, promise: null };
      moduleRegistry.set(registryKey, record);

      try {
        const cwd =
          typeof process !== 'undefined' &&
          process &&
          typeof process.cwd === 'function'
            ? process.cwd()
            : undefined;
        // Pass the entry point to the parent so _build_file can use it for
        // things like resolving sibling imports or source-map hints.
        // The seed is served host-side (pickDynamicImportVfs): pass undefined
        // instead of __USER_FILES__ — structured-cloning ~22MB per call
        // stalled bootstrap for minutes.
        let importResult = await interopChannel.callParent(
          '_dynamic_import',
          modulePath,
          moduleType,
          entryPoint,
          parentEntryPoint,
          isNodeBuiltIn, 
          cwd,
          undefined   
        );
        
        // Handle both object {source, resolvedPath} and raw string (legacy handlers)
        if (typeof importResult === 'string') {
          importResult = { source: importResult, resolvedPath: null };
        }
          
        if(!importResult || !importResult.source){
        throw new Error(`[ERR_MODULE_NOT_FOUND]: Cannot find module ${modulePath}`)
        return;
        }  

        let source = importResult.source;
        // Vitest E2E gap #1: the host resolves the request to a VFS path.
        // _build_file must receive the RESOLVED path as its fileName — it
        // becomes the entryPoint that transformImportsToLoadModule stamps
        // into nested imports. Passing the raw request string lost the VFS
        // prefix at import depth >=2 (nested relative imports 404'd).
        const buildFileName = importResult.resolvedPath || modulePath;
        // Dedup by resolved path: an aliased specifier resolving to an
        // already-loading/done file reuses that record instead of evaluating
        // the module a second time (see canonicalRegistryKey).
        const canonicalKey = canonicalRegistryKey(
          entryPoint,
          modulePath,
          importResult.resolvedPath,
        );
        const dedup = canonicalizeRegistryEntry(
          moduleRegistry,
          registryKey,
          canonicalKey,
          record,
        );
        if (dedup.reused) {
          return dedup.reused.exports;
        }
        registryKey = canonicalKey;
        
          // Save original source for fallback if transform breaks the module
          const originalSourceForFallback = source;
          
          // Part B: .json flows through _build_file (built-in json plugin
          // handles it via loader dispatch); css still bypasses.
          if (extension != 'css') {
        source = await interopChannel.callParent(
          '_build_file',
          source,
          buildFileName,
          moduleType,
          entryPoint,
          parentEntryPoint,
          isNodeBuiltIn
        );
        
       }

        let resolved; 

        if (extension === 'css') {
          const sheet = new CSSStyleSheet();
          await sheet.replace(source);
          resolved = sheet;
          return resolved;
        } else {
          if (moduleType === 'require') {
            // Provide sync require bound to THIS module's own RESOLVED path
            // (buildFileName: importResult.resolvedPath, always an absolute
            // VFS path), so its relative require() calls resolve against its
            // own directory. Binding to modulePath (the as-written request,
            // which may be relative like './lib/picomatch') broke nested
            // requires — e.g. picomatch's require('./scan') resolving to
            // lib/scan.js instead of /node_modules/picomatch/lib/scan.js.
            // vfsLookup walks a nested tree, so unflatten the flat
            // __USER_FILES__ map first (keys may carry a leading slash).
            const vfsForRequire = unflattenUserFiles(globalThis._RUNTIME__UUID___.__USER_FILES__ || {});
            globalThis.__syncRequire__ = createSyncRequire(buildFileName, vfsForRequire);
            source = wrapCommonJS(source, buildFileName, vfsForRequire);
          }
 
         function makeIdentitySourceMap(source, filename) {
  // One mapping per line, all pointing to column 0 of the original
  const lineCount = source.split('\n').length;
  // Each ';' = next line, 'AAAA' = col 0 -> col 0, same source, same line
  const mappings = Array(lineCount).fill('AAAA').join(';');

  const map = {
    version: 3,
    sources: [filename],
    sourcesContent: [source],
    names: [],
    mappings,
  };

  return `\n//# sourceMappingURL=data:application/json;charset=utf-8,${
    encodeURIComponent(JSON.stringify(map))
  }`;
}
 
         // Stamp sourceURL with the RESOLVED path: identical files yield
         // identical data: URLs, so the browser module map dedupes as
         // a second line of defense against double evaluation.
         source  = source + `\n //# sourceURL=${buildFileName}`

           const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
          
          
          
          resolved = await importAndProxy(url, modulePath, relativeName, moduleType);
          
          // Verify critical builtins: if the transform broke the module
          // (e.g. node:stream's Readable is undefined), retry with the
          // original untransformed source.
          if (isNodeBuiltIn && resolved && typeof resolved === 'object') {
            let needsFallback = false;
            try {
              // Access via the proxy to trigger the get handler
              if (modulePath === 'stream' && typeof resolved.Readable === 'undefined') {
                needsFallback = true;
              }
            } catch (e) {
              // get handler threw — module is broken
              needsFallback = true;
            }
            if (needsFallback) {
              console.warn('[loadModule] ' + modulePath + ' transform produced broken exports; retrying with original source');
              const fallbackUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(originalSourceForFallback)}`;
              resolved = await importAndProxy(fallbackUrl, modulePath, relativeName, moduleType);
            }
          }
        }

        // Populate the partial exports object in-place so any circular
        // reference holders also see the final values.
        if (resolved && typeof resolved === 'object') {
          Object.assign(partialExports, resolved);
        }

        record.status = 'done';
        record.exports = resolved; // replace reference for future callers
        // Unified sync/async builtin cache (fix/ondemand-require, Worker A):
        // an async import() of a builtin now populates the sync _builtinCache,
        // so a later sync require() returns the SAME instance with no preload.
        // modulePath is underscore-normalized here (fs/promises -> fs_promises),
        // so convert back to the slash-form manifest key; skip RUNTIME:*
        // pseudo-builtins; only write keys the manifest actually lists
        // (this also guards underscore-named builtins: child_process ->
        // child/process misses, so fall back to the raw modulePath form).
        // Best-effort: a cache failure must never break the load path.
        try {
          if (isNodeBuiltIn && resolved && typeof resolved === 'object') {
            let manifestKey = String(modulePath).split('_').join('/');
            if (manifestKey.indexOf('RUNTIME') !== 0) {
              if (!Object.prototype.hasOwnProperty.call(_builtinManifest, manifestKey)) {
                manifestKey = String(modulePath);
              }
              if (Object.prototype.hasOwnProperty.call(_builtinManifest, manifestKey) &&
                  !_builtinCache.has(manifestKey)) {
                _builtinCache.set(manifestKey, resolved);
              }
            }
          }
        } catch (cacheErr) { /* sync-cache write is best-effort only */ }
        return resolved;

      } catch (err) {
        // Remove failed entry so a retry can attempt a fresh load.
        moduleRegistry.delete(registryKey);
        throw err;
      }
    }

    // ─── Asset handling (JSON / TXT / MD) ───────────────────────────────────
    if (['json', 'txt', 'md'].includes(extension)) {
      const response = await fetch(modulePath);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const contentType = response.headers.get('content-type');
      if (extension === 'json' || (contentType && contentType.includes('application/json'))) {
        try { return await response.json(); }
        catch { return await response.text(); }
      }
      return await response.text();
    }

    // ─── CSS (absolute URL) ──────────────────────────────────────────────────
    if (extension === 'css') {
      const response = await fetch(modulePath);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const cssText = await response.text();
      const sheet = new CSSStyleSheet();
      await sheet.replace(cssText);
      return sheet;
    }

    // ─── Standard JS import (absolute URL / bare specifier) ─────────────────
    const requiredSupportedYet = false; // sync require transform not yet implemented

    let data;
     if (moduleType === 'require' && !isRelative && !isAbsolute){
     throw new Error(`[ERR_MODULE_NOT_FOUND]: Cannot find module ${modulePath}`)
     }
    
    if (moduleType === 'require' && requiredSupportedYet) {
      let src = await fetch(modulePath).then(r => r.text());
      const vfsForRequire2 = unflattenUserFiles(globalThis._RUNTIME__UUID___.__USER_FILES__ || {});
      globalThis.__syncRequire__ = createSyncRequire(modulePath, vfsForRequire2);
      src = wrapCommonJS(src, modulePath, vfsForRequire2);
      const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`;
      data = await import(url);
    } else {
     /*  
 
     this actually works as is planned to use possibly.. (so we can patch node.js) - crazy slow. 
      
      data = await interopChannel.callParent(
          '_bundler_',
          modulePath
        );
      data = await import(data)  
      */ 
      
      data = await import(modulePath);
    } 

    return buildModuleProxy(data, modulePath, relativeName, moduleType);

  } catch (error) {
     
     // TODO Implement true stacks... 
     // Fix errors for not found files... 
     if (relativeName){
     
  const displayPath = relativeName || modulePath;
  
 
 const err = new Error(`${error.message} in ${displayPath}`);

err.stack = `Error: Something broke
    at myFunction (index.js:123:45)
    at main (index.js:200:10)`;
    
  
  
  
  // Check if this error has already been wrapped by checking for our pattern
  const alreadyWrapped = error.message.match(" in \./");
  
  //error.stack = '${error.message}'
 
  
  if (alreadyWrapped) {
    // Already has path context, just re-throw as-is
    throw error;
  }
  
  // First time catching - add context
   if(entryPoint){
   throw augmentLoadError(error, displayPath, entryPoint);
  }

  
  
 
 
   
   }
 
     
    if (relativeName) modulePath = relativeName;
    
    
    
    // todo make stacks for relatives 
    throw error;
  }
}

globalThis._RUNTIME__UUID___.loadModule = loadModule;
 


  
// ─── Helpers ─────────────────────────────────────────────────────────────────

// Registry dedup by resolved path (platform fix, AGENTS.md rule 6).
// loadModule keyed moduleRegistry by the RAW import specifier, so the same
// file imported via different specifiers ("../binding.wasi.cjs" vs
// "@rolldown/browser") evaluated once PER SPECIFIER - observed 7x, each
// committing 1GB of WebAssembly.Memory, killing the browser process.
// Key by the RESOLVED VFS path instead; an aliased import reuses the
// in-flight/done record.
//
// 2026-10-02: the entryPoint prefix had to go entirely. Each vite chunk
// stamps its own resolved path as entryPoint, so "entry::resolved" still
// split one file into N evaluations (9x observed, browser died at +112s).
// Node evaluates once per resolved path per realm; the registry now does
// too. Resolved paths already disambiguate (/a/utils.js vs /b/utils.js).
function canonicalRegistryKey(entryPoint, modulePath, resolvedPath) {
  return resolvedPath || modulePath;
}

// Migrate-or-reuse decision for a just-resolved module. provisionalKey is the
// raw-specifier key created before _dynamic_import; canonicalKey is the
// resolved-path key. Returns { reused } - non-null when another specifier
// already resolved to this file (return reused.exports; a "loading" record's
// partial exports mirror Node's circular-import semantics).
function canonicalizeRegistryEntry(
  moduleRegistry,
  provisionalKey,
  canonicalKey,
  record,
) {
  if (canonicalKey === provisionalKey) return { reused: null };
  var existing = moduleRegistry.get(canonicalKey);
  moduleRegistry.delete(provisionalKey);
  if (existing) return { reused: existing };
  moduleRegistry.set(canonicalKey, record);
  return { reused: null };
}
