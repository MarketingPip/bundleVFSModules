// Registry of in-flight modules to catch circular references.
// Maps resolvedKey -> { status: 'loading' | 'done', exports, promise }
const moduleRegistry = new Map();

/**
 * @param {string} modulePath     - The import path as written (e.g. './foo', '../bar', or a URL)
 * @param {string} moduleType     - 'import' | 'require'
 * @param {string} [entryPoint]   - The original top-level entry file; passed through to interop
 * @param {string} [parentEntryPoint]   - The original file entry file point; passed through to interop
 *                                  so _build_file can resolve context-sensitive paths correctly.
 *                                  Defaults to modulePath when called at the root level.
 */
export async function loadModule(modulePath, moduleType, entryPoint, parentEntryPoint) {
  const isDynamicModule = p => typeof p === 'string' && /^(data:text\/javascript|blob:)/.test(p);
  
  if (isDynamicModule(modulePath)) {
    return await import(modulePath);
  }

  let relativeName = null;
  const node_builtin = JSON.parse(JSON.stringify(builtinModules));
  const strippable_nodebuiltins = node_builtin.filter(m => m.includes('node:'));
  const isStrippable = strippable_nodebuiltins.includes(modulePath) || node_builtin.includes(modulePath);
  const isNodeBuiltIn = node_builtin.includes(modulePath) || isStrippable;

  if (isStrippable) {
    modulePath = modulePath.replace("node:", ""); // strip node:
    modulePath = modulePath.replace("/", "_");
  }

  if (entryPoint === undefined) entryPoint = modulePath;
  if (parentEntryPoint === undefined) parentEntryPoint = null;

  try {
    const extension = modulePath.split('.').pop().toLowerCase();
    const isRelative = modulePath.startsWith('./') || modulePath.startsWith('../');
    const isAbsolute = modulePath.startsWith('./');
    let sourceResolvedError = false;

    // ─── Relative / interop-channel path ────────────────────────────────────
    if (isRelative || isNodeBuiltIn || isAbsolute) {
      relativeName = modulePath;
      const registryKey = `${entryPoint}::${modulePath}`;

      // ── Circular reference guard ─────────────────────────────────────────
      if (moduleRegistry.has(registryKey)) {
        const record = moduleRegistry.get(registryKey);
        if (record.status === 'loading') {
          console.warn(
            `[loadModule] Circular dependency detected for "${modulePath}" ` +
            `(entry: "${entryPoint}"). Returning partial exports.`
          );
          return record.exports;
        }
        return record.exports;
      }

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

        let source = await interopChannel.callParent(
          '_dynamic_import',
          modulePath,
          moduleType,
          entryPoint,
          parentEntryPoint,
          isNodeBuiltIn,
          cwd
        );

        if (!source) {
          throw new Error(`[ERR_MODULE_NOT_FOUND]: Cannot find module ${modulePath}`);
        }

        if (extension !== 'json' && extension !== 'css') {
          source = await interopChannel.callParent(
            '_build_file',
            source,
            modulePath,
            moduleType,
            entryPoint,
            parentEntryPoint,
            isNodeBuiltIn
          );
        }

        let resolved;
        if (extension === 'json') {
          resolved = JSON.parse(source);
          return { default: resolved };
        } else if (extension === 'css') {
          const sheet = new CSSStyleSheet();
          await sheet.replace(source);
          resolved = sheet;
          return { default: resolved };
        } else {
          if (moduleType === 'require') {
            source = wrapCommonJS(source);
          }
          source = source + `\n //# sourceURL=${modulePath}`;
          const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
          resolved = await importAndProxy(url, modulePath, relativeName, moduleType);
        }

        if (resolved && typeof resolved === 'object') {
          Object.assign(partialExports, resolved);
        }

        record.status = 'done';
        record.exports = resolved;
        return resolved;

      } catch (err) {
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
    const requiredSupportedYet = false;
    let data;

    if (moduleType === 'require' && !isRelative && !isAbsolute) {
      throw new Error(`[ERR_MODULE_NOT_FOUND]: Cannot find module ${modulePath}`);
    }

    if (moduleType === 'require' && requiredSupportedYet) {
      let src = await fetch(modulePath).then(r => r.text());
      src = wrapCommonJS(src);
      const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`;
      data = await import(url);
    } else {
      data = await import(modulePath);
    }

    return buildModuleProxy(data, modulePath, relativeName, moduleType);

  } catch (error) {
    if (relativeName) {
      const displayPath = relativeName || modulePath;
      const alreadyWrapped = error.message.match(" in \\./");
      error.stack = `${error.message}`;
      if (alreadyWrapped) throw error;
      if (entryPoint) throw new Error(`${error.message} in ${displayPath} at ${entryPoint}`);
      throw new Error(`${error.message} in ${displayPath}`);
    }

    if (relativeName) modulePath = relativeName;
    throw error;
  }
}

//globalThis._RUNTIME_ = {};
//globalThis._RUNTIME_.loadModule = loadModule;
