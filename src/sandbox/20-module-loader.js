// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// Registry of in-flight modules to catch circular references.
// Maps resolvedKey -> { status: 'loading' | 'done', exports, promise }
const moduleRegistry = new Map();

// Gap #6: single shared `node:`-prefix normalizer. Node treats `node:X`
// and `X` identically for EVERY builtin; the old `isStrippable` check only
// covered the four builtins whose listed names literally contain `node:`.
// Keep in sync with normalizeBuiltinSpecifier in runtime.js (host scope).
// Self-contained and backtick-free: this source is inlined into generated
// scripts via toString() elsewhere.
function normalizeBuiltinSpecifier(specifier, nodeBuiltins) {
  var modulePath = specifier;
  var bare = (typeof specifier === 'string' && specifier.indexOf('node:') === 0)
    ? specifier.slice(5)
    : specifier;
  var listed = false;
  for (var i = 0; i < nodeBuiltins.length; i++) {
    if (nodeBuiltins[i] === specifier || nodeBuiltins[i] === bare) listed = true;
  }
  var isNodeBuiltIn = listed;
  if (isNodeBuiltIn) {
    modulePath = String(bare).replace('/', '_').replace('RUNTIME:', 'RUNTIME_');
  }
  return { isNodeBuiltIn: isNodeBuiltIn, modulePath: modulePath };
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
 
  const node_builtin = "__BUILTIN_MODULES_JSON__"

  // Gap #6: normalize `node:` prefix generally (see normalizeBuiltinSpecifier
  // above); the old isStrippable check missed every `node:X` not literally
  // listed with the prefix.
  const __builtinNorm = normalizeBuiltinSpecifier(modulePath, node_builtin);
  const isNodeBuiltIn = __builtinNorm.isNodeBuiltIn;
  modulePath = __builtinNorm.modulePath;
    
  // The very first caller doesn't know the entry point yet — it IS the entry point.
  if (entryPoint === undefined) entryPoint = modulePath;

  if (parentEntryPoint === undefined) parentEntryPoint = null;

  try {
    const extension = modulePath.split('.').pop().toLowerCase();
    const isRelative = modulePath.startsWith('./') || modulePath.startsWith('../');
  const isAbsolute = modulePath.startsWith('./')

  let sourceResolvedError = false;
  
   const isJSModule = !['json', 'css'].includes(extension);
    // ─── Relative / interop-channel path ────────────────────────────────────
    if (isRelative || isNodeBuiltIn || isAbsolute || !isRelative && !isNodeBuiltIn && !isAbsolute && !modulePath.includes("https://")) {
      relativeName = modulePath;

      // Use a stable key for the registry (entry + requested path disambiguates
      // the same filename required from different entry points).
      const registryKey = `${entryPoint}::${modulePath}`;
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
        
        const vfs = globalThis[_BVM_RT_KEY_].__USER_FILES__
        let importResult = await interopChannel.callParent(
          '_dynamic_import',
          modulePath,
          moduleType,
          entryPoint,
          parentEntryPoint,
          isNodeBuiltIn, 
          cwd,
          vfs   
        );
        
          
        if(!importResult || !importResult.source){
        throw new Error(`[ERR_MODULE_NOT_FOUND]: Cannot find module ${modulePath}`)
        return;
        }

        let source = importResult.source;
        // Vitest E2E gap #1: the host resolves the request to a VFS path.
        // _build_file must receive the RESOLVED path as its fileName — it
        // becomes the entryPoint that transformImportsToLoadModule stamps
        // into nested imports. Passing the raw request string lost the VFS
        // prefix at import depth ≥2 (nested relative imports 404'd).
        const buildFileName = importResult.resolvedPath || modulePath;
          
          if (extension != 'json' && extension != 'css') {
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

        if (extension === 'json') {
          // if typescript (need to add types)
          resolved = JSON.parse(source);
          return resolved;
        } else if (extension === 'css') {
          const sheet = new CSSStyleSheet();
          await sheet.replace(source);
          resolved = sheet;
          return resolved;
        } else {
          if (moduleType === 'require') {
            // Provide sync require bound to this module's path
            const vfsForRequire = globalThis[_BVM_RT_KEY_]?.__USER_FILES__ || {};
            globalThis.__syncRequire__ = createSyncRequire(parentEntryPoint || entryPoint || modulePath, vfsForRequire);
            source = wrapCommonJS(source, parentEntryPoint || entryPoint || modulePath, vfsForRequire);
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
 
         source  = source + `\n //# sourceURL=${modulePath}`
             const sourceMapComment = makeIdentitySourceMap(source, modulePath);

           const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
          
          
          
          resolved = await importAndProxy(url, modulePath, relativeName, moduleType);
        }

        // Populate the partial exports object in-place so any circular
        // reference holders also see the final values.
        if (resolved && typeof resolved === 'object') {
          Object.assign(partialExports, resolved);
        }

        record.status = 'done';
        record.exports = resolved; // replace reference for future callers
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
      const vfsForRequire2 = globalThis[_BVM_RT_KEY_]?.__USER_FILES__ || {};
      globalThis.__syncRequire__ = createSyncRequire(parentEntryPoint || entryPoint || modulePath, vfsForRequire2);
      src = wrapCommonJS(src, parentEntryPoint || entryPoint || modulePath, vfsForRequire2);
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
  
  //error.stack = `${error.message}`
 
  
  if (alreadyWrapped) {
    // Already has path context, just re-throw as-is
    throw error;
  }
  
  // First time catching - add context
   if(entryPoint){
   error.message = `${error.message} in ${displayPath} at ${entryPoint}`
  throw error;
  }

  
  
 
 
   
   }
 
     
    if (relativeName) modulePath = relativeName;
    
    
    
    // todo make stacks for relatives 
    throw error;
  }
}

globalThis[_BVM_RT_KEY_].loadModule = loadModule;
 


  
// ─── Helpers ─────────────────────────────────────────────────────────────────

