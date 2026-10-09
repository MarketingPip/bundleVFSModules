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
// Read a CJS module's source for the sync require path: live memfs first,
// startup snapshot as fallback. The memfs volume is seeded from
// __USER_FILES__ at startup and stays live, so files written at runtime via
// __FS__.writeFileSync() are require-able (and deleted files stop being
// require-able), matching Node semantics. Template-safe: no backticks or
// dollar-brace sequences in this code.
function readModuleSourceLiveFirst(resolved, vfs) {
  const cands = resolved.endsWith(".js")
    ? [resolved]
    : [resolved, resolved + ".js"];
  const rt = globalThis._RUNTIME__UUID___;
  const liveFs = rt && rt.__FS__;
  if (liveFs && typeof liveFs.readFileSync === "function") {
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      const forms = c.charAt(0) === "/" ? [c] : [c, "/" + c];
      for (let j = 0; j < forms.length; j++) {
        try {
          const data = liveFs.readFileSync(forms[j], "utf8");
          if (typeof data === "string") return data;
        } catch (e) {
          /* try next form */
        }
      }
    }
    return undefined;
  }
  for (let i = 0; i < cands.length; i++) {
    const hit = vfsLookup(cands[i], vfs);
    if (hit != null) return hit;
  }
  return undefined;
}

// Local copy of the parent's vfsLookup for the sandbox-side sync require.
// (Written without template literals or backslash escapes: this code lives
// inside the generate() template literal, where dollar-brace sequences
// would interpolate and backslash-slash would collapse.)
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
  // Platform fix (AGENTS.md rule 6): in the browser, prefer -browser.js
  // variants over .cjs files (see nested vfsLookup in _dynamic_import).
  if (path.endsWith(".cjs")) {
    const hit = tryPath(path.replace(/\.cjs$/, "-browser.js"));
    if (hit !== undefined) return hit;
  }
  const withJs = path.endsWith(".js") ? path : path + ".js";
  const hit = tryPath(path);
  return hit !== undefined ? hit : tryPath(withJs);
}

// __USER_FILES__ is a flat { 'lib/util.js': source } map whose keys may
// carry a leading slash. createSyncRequire's vfsLookup walks a nested tree,
// so normalize once here (same normalization as the parent's
// unflattenFileSystem in _dynamic_import).
function unflattenUserFiles(flatObj) {
  const result = {};
  if (!flatObj || typeof flatObj !== "object") return result;
  for (const rawPath of Object.keys(flatObj)) {
    // NOTE: this code lives inside the generate() template literal, so every
    // backslash here is template-cooked: \/ becomes /, \" becomes " (which
    // breaks "..." strings — the wrapper needs \\\" there), and /\*/
    // becomes /*/ (an unterminated comment — use /[*]/ instead). If the
    // generated wrapper must contain a backslash, write two (\). Pinned by
    // tests/vite7-wrapper-vfs-syntax.test.js (2026-09-30: the 883:26 SyntaxError).
    const parts = String(rawPath).replace(/^[/]+/, "").split("/");
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part] || typeof current[part] !== "object") {
        current[part] = {};
      }
      current = current[part];
    }
    current[parts[parts.length - 1]] = flatObj[rawPath];
  }
  return result;
}

/**
 * Resolves a require() request to an absolute VFS path (Node.js semantics).
 * Used by both syncRequire() and syncRequire.resolve().
 * - Relative requests (./, ../) resolve against parentPath's directory
 * - Absolute requests (/) are used as-is
 * - Appends .js extension if not present
 */
// --- VFS existence probing for the sync resolver (template-safe: no
// backticks, no dollar-brace, no backslash-slash in this code) ---

// Walk the nested snapshot vfs tree ({dir: {file: 'source'}}). Returns the
// node at path, or undefined. Directories are objects, files are strings.
function vfsNodeAt(path, vfs) {
  var segments = String(path).split("/").filter(Boolean);
  var node = vfs;
  for (var i = 0; i < segments.length; i++) {
    if (node == null || typeof node !== "object") return undefined;
    node = node[segments[i]];
  }
  return node;
}

// The sandbox's live memfs (__FS__), or null when absent (e.g. unit tests
// extracting this code under Node).
function vfsLiveFs() {
  var rt = globalThis._RUNTIME__UUID___;
  return rt && rt.__FS__ ? rt.__FS__ : null;
}

function vfsIsFile(path, vfs) {
  var live = vfsLiveFs();
  if (live && typeof live.statSync === "function") {
    try {
      if (live.statSync(path).isFile()) return true;
    } catch (e) {
      /* fall through to snapshot */
    }
  }
  return typeof vfsNodeAt(path, vfs) === "string";
}

function vfsIsDir(path, vfs) {
  var live = vfsLiveFs();
  if (live && typeof live.statSync === "function") {
    try {
      if (live.statSync(path).isDirectory()) return true;
    } catch (e) {
      /* fall through to snapshot */
    }
  }
  var node = vfsNodeAt(path, vfs);
  return node != null && typeof node === "object";
}

function vfsReadText(path, vfs) {
  var live = vfsLiveFs();
  if (live && typeof live.readFileSync === "function") {
    try {
      var data = live.readFileSync(path, "utf8");
      if (typeof data === "string") return data;
    } catch (e) {
      /* fall through to snapshot */
    }
  }
  var node = vfsNodeAt(path, vfs);
  return typeof node === "string" ? node : undefined;
}

// POSIX normalize: collapse . and .. segments, preserve leading slash.
// Never escapes root (leading .. segments are dropped).
function vfsNormalizePath(path) {
  var isAbs = path.charAt(0) === "/";
  var parts = String(path).split("/");
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p === "..") {
      if (out.length > 0) out.pop();
    } else if (p !== "." && p !== "") {
      out.push(p);
    }
  }
  return (isAbs ? "/" : "") + out.join("/");
}

function vfsDirname(path) {
  var idx = String(path).lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

// Node's Module._nodeModulePaths (POSIX): from the start dir upward,
// collecting each "<dir>/node_modules". Mirrors src/module.js in this repo.
function vfsNodeModulePaths(from) {
  var cur = vfsNormalizePath(from);
  var paths = [];
  while (true) {
    paths.push(cur === "/" ? "/node_modules" : cur + "/node_modules");
    if (cur === "/") break;
    var parent = vfsDirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return paths;
}

// Node LOAD_AS_FILE: X, then X.js, X.json (extension probing order).
function vfsLoadAsFile(basePath, vfs) {
  if (vfsIsFile(basePath, vfs)) return basePath;
  var exts = [".js", ".json"];
  for (var i = 0; i < exts.length; i++) {
    var p = basePath + exts[i];
    if (vfsIsFile(p, vfs)) return p;
  }
  return null;
}

// Node LOAD_AS_DIRECTORY: package.json "main", then index.js / index.json.
function vfsLoadAsDirectory(dirPath, vfs, _seen) {
  _seen = _seen || {};
  var normPath = vfsNormalizePath(dirPath);
  if (_seen[normPath]) {
    // Directory cycle via package.json main (a/main -> ./dir, a/dir/main -> ..).
    // Node would eventually fail; we throw instead of infinite-looping.
    return null;
  }
  _seen[normPath] = true;
  var pkg = vfsReadPackageJson(dirPath, vfs);
  // The 'exports' field wins over 'main' when present (Node parity, and the
  // async path's tryResolveFileOrPackage). A present-but-unresolvable
  // exports map is an honest miss — never fall through to main/index.
  if (pkg && pkg.exports !== undefined && pkg.exports !== null) {
    var target = vfsResolvePackageExportsSync(pkg, ".");
    if (typeof target === "string") {
      return vfsLoadAsFile(vfsNormalizePath(dirPath + "/" + target), vfs);
    }
    return null;
  }
  if (pkg && typeof pkg.main === "string" && pkg.main) {
    var mainPath = vfsNormalizePath(dirPath + "/" + pkg.main);
    var viaMain = vfsLoadAsFile(mainPath, vfs);
    if (viaMain) return viaMain;
    if (vfsIsDir(mainPath, vfs)) {
      var viaMainDir = vfsLoadAsDirectory(mainPath, vfs, _seen);
      if (viaMainDir) return viaMainDir;
    }
  }
  return vfsLoadAsFile(dirPath + "/index", vfs);
}

function vfsLoadAsFileOrDirectory(basePath, vfs) {
  var asFile = vfsLoadAsFile(basePath, vfs);
  if (asFile) return asFile;
  if (vfsIsDir(basePath, vfs)) return vfsLoadAsDirectory(basePath, vfs);
  return null;
}

function vfsModuleNotFound(request) {
  var err = new Error(
    "[ERR_MODULE_NOT_FOUND]: Cannot find module '" + request + "'",
  );
  err.code = "ERR_MODULE_NOT_FOUND";
  return err;
}

function vfsPackagePathNotExported(packageName, subpath, packageJsonPath) {
  var err = new Error(
    "[ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath '" +
      subpath +
      '\' is not defined by "exports" in ' +
      packageJsonPath,
  );
  err.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
  return err;
}

function vfsPackageImportNotDefined(specifier, packageJsonPath) {
  var err = new Error(
    '[ERR_PACKAGE_IMPORT_NOT_DEFINED]: Package import specifier "' +
      specifier +
      '" is not defined in package ' +
      packageJsonPath,
  );
  err.code = "ERR_PACKAGE_IMPORT_NOT_DEFINED";
  return err;
}

// Node's message when no package.json scope exists above the importer:
// "Package import specifier "#x" is not defined imported from <path>".
function vfsPackageImportNotDefinedNoScope(specifier, importerPath) {
  var err = new Error(
    '[ERR_PACKAGE_IMPORT_NOT_DEFINED]: Package import specifier "' +
      specifier +
      '" is not defined imported from ' +
      importerPath,
  );
  err.code = "ERR_PACKAGE_IMPORT_NOT_DEFINED";
  return err;
}

// Node LOOKUP_PACKAGE_SCOPE: nearest ancestor dir (of a module FILE's dir)
// containing a package.json, or null when none exists.
function vfsLookupPackageScope(dir, vfs) {
  var d = dir || "/";
  while (true) {
    if (vfsReadPackageJson(d, vfs) !== null) return d;
    if (d === "/") return null;
    d = vfsDirname(d);
  }
}

function vfsIsRelativeRequest(request) {
  return (
    request === "." ||
    request === ".." ||
    request.charAt(0) === "/" ||
    (request.charAt(0) === "." &&
      (request.charAt(1) === "/" ||
        (request.charAt(1) === "." &&
          (request.length === 2 || request.charAt(2) === "/"))))
  );
}

/**
 * Sync-path package exports/imports resolution (Node's PACKAGE_EXPORTS_RESOLVE
 * / PACKAGE_IMPORTS_RESOLVE, path-based edition for the sync require path).
 * Mirrors the algorithm PR #122 added to vfsLookup for the async
 * dynamic-import() path, but with the CJS require() condition set —
 * ["node", "require", "default"] instead of ["node", "import", "default"] —
 * and returning resolved VFS paths instead of { source } records.
 */
// Condition order mirrors Node's require() defaults.
var VFS_SYNC_EXPORT_CONDITIONS = ["node", "require", "default"];

function vfsSplitPackageSpecifier(request) {
  // '@scope/pkg/sub/deep' -> { packageName: '@scope/pkg', subpath: './sub/deep' }
  // 'pkg/sub'             -> { packageName: 'pkg',        subpath: './sub' }
  // 'pkg'                 -> { packageName: 'pkg',        subpath: '.' }
  if (request.charAt(0) === "@") {
    var parts = request.split("/");
    var packageName = parts.slice(0, 2).join("/");
    var rest = parts.slice(2).join("/");
    return { packageName: packageName, subpath: rest ? "./" + rest : "." };
  }
  var idx = request.indexOf("/");
  if (idx === -1) return { packageName: request, subpath: "." };
  return {
    packageName: request.slice(0, idx),
    subpath: "." + request.slice(idx),
  };
}

function vfsResolvePackageTargetSync(target, conditions) {
  // string | null (blocked subpath) | string[] (fallback chain) |
  // { condition: target } — same shape as the async path's resolvePackageTarget.
  if (target === null || target === undefined) return null;
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (var i = 0; i < target.length; i++) {
      var r = vfsResolvePackageTargetSync(target[i], conditions);
      if (r !== null) return r;
    }
    return null;
  }
  if (typeof target === "object") {
    for (var c = 0; c < conditions.length; c++) {
      var cond = conditions[c];
      if (Object.prototype.hasOwnProperty.call(target, cond)) {
        var resolved = vfsResolvePackageTargetSync(target[cond], conditions);
        if (resolved !== null) return resolved;
      }
    }
    return null;
  }
  return null;
}

function vfsResolvePackageExportsSync(pkg, subpath) {
  var exportsField = pkg.exports;
  if (exportsField === null || exportsField === undefined) return null;
  var target;
  if (typeof exportsField === "string") {
    if (subpath !== ".") return null;
    target = exportsField;
  } else if (typeof exportsField === "object" && !Array.isArray(exportsField)) {
    var keys = Object.keys(exportsField);
    var isSugar =
      keys.length > 0 &&
      keys.every(function (k) {
        return k.charAt(0) !== ".";
      });
    if (isSugar) {
      // Condition-only object: the main entry.
      if (subpath !== ".") return null;
      target = exportsField;
    } else if (Object.prototype.hasOwnProperty.call(exportsField, subpath)) {
      target = exportsField[subpath];
    } else {
      // Longest './x/*' pattern-key match.
      var best = null;
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key.slice(-2) === "/*") {
          var prefix = key.slice(0, -1);
          if (
            subpath.indexOf(prefix) === 0 &&
            (best === null || key.length > best.length)
          ) {
            best = key;
          }
        }
      }
      if (best === null) return null;
      var star = subpath.slice(best.length - 1);
      var patternTarget = vfsResolvePackageTargetSync(
        exportsField[best],
        VFS_SYNC_EXPORT_CONDITIONS,
      );
      if (typeof patternTarget !== "string") return null;
      return patternTarget.replace(/[*]/g, star);
    }
  } else {
    return null;
  }
  var resolved = vfsResolvePackageTargetSync(
    target,
    VFS_SYNC_EXPORT_CONDITIONS,
  );
  return typeof resolved === "string" ? resolved : null;
}

function vfsReadPackageJson(dirPath, vfs) {
  var text = vfsReadText(dirPath + "/package.json", vfs);
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null; // invalid package.json: callers fall through to legacy probing
  }
}

function vfsPackageHasExports(dirPath, vfs) {
  var pkg = vfsReadPackageJson(dirPath, vfs);
  return !!pkg && pkg.exports !== undefined && pkg.exports !== null;
}

function vfsLoadPackageRoot(packageRoot, subpath, vfs) {
  // 1. The 'exports' field wins when present (Node PACKAGE_EXPORTS_RESOLVE).
  //    When present it is the ONLY legal route — a miss is honest, never
  //    legacy probing (matches the async path's tryResolveFileOrPackage).
  if (vfsPackageHasExports(packageRoot, vfs)) {
    var pkg = vfsReadPackageJson(packageRoot, vfs);
    var target = vfsResolvePackageExportsSync(pkg, subpath);
    if (typeof target === "string") {
      return vfsLoadAsFile(vfsNormalizePath(packageRoot + "/" + target), vfs);
    }
    return null;
  }
  // 2. Legacy probing: main/index for ".", file probing for subpaths.
  if (subpath === ".") return vfsLoadAsDirectory(packageRoot, vfs);
  return vfsLoadAsFileOrDirectory(
    vfsNormalizePath(packageRoot + "/" + subpath.slice(2)),
    vfs,
  );
}

function vfsResolvePackageImportsSync(importPath, importerPath, vfs) {
  // Node PACKAGE_IMPORTS_RESOLVE: nearest parent package.json scope wins;
  // a scope without an 'imports' field means the specifier is unresolvable.
  var dir = vfsDirname(importerPath || "/");
  while (true) {
    var pkg = vfsReadPackageJson(dir, vfs);
    if (pkg && pkg.imports && typeof pkg.imports === "object") {
      var imports = pkg.imports;
      var target;
      if (Object.prototype.hasOwnProperty.call(imports, importPath)) {
        target = imports[importPath];
      } else {
        // Longest '#x/*' pattern-key match.
        var best = null;
        var keys = Object.keys(imports);
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          if (
            key.slice(-2) === "/*" &&
            importPath.indexOf(key.slice(0, -1)) === 0 &&
            (best === null || key.length > best.length)
          ) {
            best = key;
          }
        }
        if (best === null) return null;
        var star = importPath.slice(best.length - 1);
        var patternTarget = vfsResolvePackageTargetSync(
          imports[best],
          VFS_SYNC_EXPORT_CONDITIONS,
        );
        if (typeof patternTarget !== "string") return null;
        target = patternTarget.replace(/[*]/g, star);
      }
      var resolved = vfsResolvePackageTargetSync(
        target,
        VFS_SYNC_EXPORT_CONDITIONS,
      );
      // Node requires imports targets to be relative (./-prefixed).
      if (typeof resolved !== "string" || resolved.slice(0, 2) !== "./")
        return null;
      return vfsLoadAsFile(vfsNormalizePath(dir + "/" + resolved), vfs);
    }
    if (pkg) return null; // nearest scope has no 'imports' — unresolvable
    if (dir === "/") break;
    dir = vfsDirname(dir);
  }
  return null;
}

/**
 * Resolves a require() request to an absolute VFS path (Node.js CJS
 * semantics), WITHOUT loading or executing the module. Used by both
 * syncRequire() and syncRequire.resolve().
 * - Relative requests (./, ../, .) resolve against parentPath's directory.
 * - Absolute requests (/) are used as-is.
 * - Bare specifiers walk node_modules from the parent directory upward
 *   (nearest wins), like Node and like src/module.js.
 * - Each candidate goes through LOAD_AS_FILE (X, X.js, X.json) then
 *   LOAD_AS_DIRECTORY (package.json "exports" first — the only legal route
 *   when present — then "main", index.js, index.json), with existence
 *   probed against the live memfs first, then the snapshot VFS.
 * - "#"-prefixed requests resolve via the nearest parent package.json
 *   "imports" field (Node PACKAGE_IMPORTS_RESOLVE).
 * - Builtins are handled by the caller (syncRequire checks _builtinManifest
 *   before calling this); a bare request that matches no VFS entry throws
 *   ERR_MODULE_NOT_FOUND.
 */
function resolveSyncRequest(request, parentPath, vfs) {
  var parentDir = vfsDirname(parentPath || "/");
  // #-imports resolve against the nearest parent package.json scope
  // (Node PACKAGE_IMPORTS_RESOLVE). Handled before the relative check:
  // '#x' is not a relative request.
  if (request.charAt(0) === "#") {
    var viaImports = vfsResolvePackageImportsSync(request, parentPath, vfs);
    if (viaImports) return viaImports;
    // Node PACKAGE_IMPORTS_RESOLVE names the NEAREST parent package.json
    // scope in the error — never the importer FILE + "/package.json".
    var scopeDir = vfsLookupPackageScope(vfsDirname(parentPath || "/"), vfs);
    throw scopeDir
      ? vfsPackageImportNotDefined(request, scopeDir + "/package.json")
      : vfsPackageImportNotDefinedNoScope(request, parentPath);
  }
  var basePath;
  if (vfsIsRelativeRequest(request)) {
    basePath =
      request.charAt(0) === "/"
        ? vfsNormalizePath(request)
        : vfsNormalizePath(parentDir + "/" + request);
    var resolved = vfsLoadAsFileOrDirectory(basePath, vfs);
    if (resolved) return resolved;
    throw vfsModuleNotFound(request);
  }
  // Bare specifier: node_modules walk, nearest directory wins
  // (Node LOAD_NODE_MODULES: per directory, LOAD_AS_FILE then
  // LOAD_AS_DIRECTORY with package-aware resolution).
  var spec = vfsSplitPackageSpecifier(request);
  var nmPaths = vfsNodeModulePaths(parentDir);
  for (var i = 0; i < nmPaths.length; i++) {
    var dir = nmPaths[i];
    var packageRoot = vfsNormalizePath(dir + "/" + spec.packageName);
    var isPkgDir = vfsIsDir(packageRoot, vfs);
    // When 'exports' is present it is the ONLY legal route (Node
    // PACKAGE_EXPORTS_RESOLVE): a subpath absent from the map is an honest
    // miss even if the file exists on disk (real Node throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED). Stop walking — a parent
    // node_modules must not shadow the denial.
    if (isPkgDir && vfsPackageHasExports(packageRoot, vfs)) {
      var viaExports = vfsLoadPackageRoot(packageRoot, spec.subpath, vfs);
      if (viaExports) return viaExports;
      throw vfsPackagePathNotExported(
        spec.packageName,
        spec.subpath,
        packageRoot + "/package.json",
      );
    }
    // Legacy: LOAD_AS_FILE(DIR/X) first (preserves require('foo') resolving
    // to /node_modules/foo.js, and file-wins-over-dir like Node), then
    // package-aware directory probing ('main'/index when no 'exports').
    var direct = vfsLoadAsFile(vfsNormalizePath(dir + "/" + request), vfs);
    if (direct) return direct;
    if (isPkgDir) {
      var hit = vfsLoadPackageRoot(packageRoot, spec.subpath, vfs);
      if (hit) return hit;
    }
  }
  throw vfsModuleNotFound(request);
}

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
  // Node path.dirname semantics: "/x.js" -> "/", "a/b.js" -> "a", "x.js" -> "."
  const _parts = parentPath.split("/");
  _parts.pop();
  const _dir = _parts.join("/");
  const dirname =
    _dir === "" ? (parentPath.charAt(0) === "/" ? "/" : ".") : _dir;
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

  // Star re-exports (see convertCjsToEsm __exportStar -> export * from).
  // __bvm_star_* hold lifted module namespaces to re-export (all keys
  // except default, per ESM semantics). Collected for proxy fallback and
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
  // so 'import { default as x }' still resolves without a throw, but
  // Object.keys() / for..in won't surface a spurious 'default' key.
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
        // Star re-export fallback (ESM 'export *' semantics): check each
        // star source, skipping 'default'. Star modules are proxied and
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
