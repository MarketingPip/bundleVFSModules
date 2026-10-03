/**
 * TypeScript plugin for bundleVFSModules.
 *
 * Transpiles TypeScript to JavaScript with the REAL TypeScript compiler
 * (`ts.transpileModule` — transpile-only, no type checking, the same
 * contract as esbuild/sucrase and Node's own type-stripping).
 *
 * The compiler is lazy-loaded on first `.ts`/`.tsx` transform so the ~8MB
 * payload is never fetched for pure-JS workloads:
 * - Under Node (tests, direct import): the npm `typescript` package
 *   (declared in package.json `dependencies`).
 * - In the browser host page: `https://esm.sh/typescript@<version>`
 *   (same pinned version; follows runtime.js's esm.sh convention).
 *
 * Module syntax is preserved as ESM (`module: ESNext`): the plugin runs at
 * the top of the parent-side `_build_file` pipeline, which handles
 * CJS→ESM detection and import rewriting downstream.
 */

const TS_VERSION = "5.9.2";

// Default lib closure for type-checking: ES2020 + DOM (console, etc.).
// Resolved per-lane in getLibFiles(); the browser lane fetches the
// `/// <reference lib="…">` closure from a CDN, the Node lane reads the
// real package directory via ts.sys.
const DEFAULT_LIBS = ["lib.es2020.d.ts", "lib.dom.d.ts"];
const DEFAULT_LIB_BASE = `https://cdn.jsdelivr.net/npm/typescript@${TS_VERSION}/lib`;

let compilerPromise = null;

// Incremental program cache: { hash, program }. Reused when the VFS
// snapshot is unchanged; rebuilt (with oldProgram for structural reuse)
// when it changes. Never touched by the transform fast path.
let programCache = null;
let programBuilds = 0;

// Browser-lane lib file cache: Map<cacheKey, Map<bareName, contents>>.
const libCache = new Map();

function isNodeLane() {
  return (
    typeof process !== "undefined" &&
    process.versions &&
    typeof process.versions.node === "string"
  );
}

/** FNV-1a over a string, seeded. */
function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Content hash of a files snapshot: sorted paths + contents. */
function snapshotHash(files) {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  let h = 0x811c9dc5;
  for (const f of sorted) {
    h = fnv1a(f.path, h);
    h = fnv1a("\0", h);
    h = fnv1a(String(f.contents), h);
    h = fnv1a("\0", h);
  }
  return h.toString(16);
}

const normPath = (p) => (p.startsWith("/") ? p : "/" + p);
const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);

/**
 * Collect the lib .d.ts closure for the requested lib names.
 * Node: read from the real typescript package directory (sync).
 * Browser: fetch from the CDN (async), following `/// <reference lib="…">`.
 * Results are cached per lib-set; VFS files always win on collision.
 */
async function getLibFiles(ts, libNames, libBase) {
  const cacheKey = libNames.join(",");
  if (libCache.has(cacheKey)) return libCache.get(cacheKey);

  const out = new Map(); // bareName -> contents
  const readOne = isNodeLane()
    ? (() => {
        const execPath = ts.sys.getExecutingFilePath();
        const dir = execPath.slice(0, execPath.lastIndexOf("/"));
        return (name) => ts.sys.readFile(dir + "/" + name) || undefined;
      })()
    : null;
  const fetchOne =
    isNodeLane() || typeof fetch === "undefined"
      ? null
      : async (name) => {
          const res = await fetch(`${libBase || DEFAULT_LIB_BASE}/${name}`);
          if (!res.ok) return undefined;
          return await res.text();
        };

  const queue = [...libNames];
  while (queue.length) {
    const name = queue.shift();
    if (out.has(name)) continue;
    const text = readOne
      ? readOne(name)
      : fetchOne
        ? await fetchOne(name)
        : undefined;
    if (typeof text !== "string") continue;
    out.set(name, text);
    // Follow `/// <reference lib="es2019" />` → lib.es2019.d.ts.
    const re = /<reference\s+lib="([^"]+)"\s*\/>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const dep = `lib.${m[1]}.d.ts`;
      if (!out.has(dep)) queue.push(dep);
    }
  }
  libCache.set(cacheKey, out);
  return out;
}

/**
 * A CompilerHost serving program files from the in-memory VFS snapshot,
 * lib files from getLibFiles(), and (Node lane only) everything else
 * from the real filesystem.
 *
 * NOTE: the host object is built by hand, NOT via ts.createCompilerHost():
 * the esm.sh browser build of TypeScript has no working ts.sys, so
 * createCompilerHost() itself throws there ("useCaseSensitiveFileNames"
 * of undefined). In the Node lane we still delegate unknown files to a
 * real createCompilerHost for full fidelity.
 */
function makeVfsHost(ts, options, vfs, libs) {
  const nodeHost = isNodeLane() ? ts.createCompilerHost(options) : null;
  const lookup = (fileName) => {
    const n = normPath(fileName);
    if (vfs.has(n)) return vfs.get(n);
    const b = baseName(n);
    if (libs.has(b)) return libs.get(b);
    return undefined;
  };
  return {
    getSourceFile(
      fileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) {
      const contents = lookup(fileName);
      if (contents !== undefined) {
        return ts.createSourceFile(
          fileName,
          contents,
          languageVersion,
          shouldCreateNewSourceFile,
        );
      }
      if (nodeHost) {
        return nodeHost.getSourceFile(
          fileName,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );
      }
      return undefined;
    },
    writeFile: nodeHost ? nodeHost.writeFile.bind(nodeHost) : () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.es2020.d.ts",
    getDefaultLibLocation: () => "/",
    fileExists(fileName) {
      return (
        lookup(fileName) !== undefined ||
        (nodeHost ? nodeHost.fileExists(fileName) : false)
      );
    },
    readFile(fileName) {
      const contents = lookup(fileName);
      if (contents !== undefined) return contents;
      return nodeHost ? nodeHost.readFile(fileName) : undefined;
    },
    directoryExists(dirName) {
      const nd = normPath(dirName);
      const prefix = nd.endsWith("/") ? nd : nd + "/";
      for (const k of vfs.keys()) {
        if (k === nd || k.startsWith(prefix)) return true;
      }
      // Lib files live under synthetic paths; treat their directory as
      // existing so module resolution can probe them.
      if (libs.size > 0) return true;
      return nodeHost ? nodeHost.directoryExists(dirName) : false;
    },
    getDirectories: nodeHost
      ? nodeHost.getDirectories.bind(nodeHost)
      : () => [],
  };
}

function compilerOptions(ts, libNames) {
  return {
    strict: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    allowJs: false,
    lib: libNames,
  };
}

function toDiagnostic(ts, d) {
  let file = null;
  let line = null;
  let column = null;
  if (d.file && typeof d.start === "number") {
    file = d.file.fileName;
    const pos = d.file.getLineAndCharacterOfPosition(d.start);
    line = pos.line + 1;
    column = pos.character + 1;
  }
  return {
    file,
    line,
    column,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    code: d.code,
  };
}

/** Load the TypeScript compiler for this lane (Node vs browser). */
function loadCompiler() {
  if (!compilerPromise) {
    compilerPromise = (async () => {
      const isNode =
        typeof process !== "undefined" &&
        process.versions &&
        typeof process.versions.node === "string";
      if (isNode) {
        return await import("typescript");
      }
      return await import(`https://esm.sh/typescript@${TS_VERSION}`);
    })();
  }
  return compilerPromise;
}

export const typescriptPlugin = {
  name: "typescript",

  async transform(code, id) {
    if (!id.endsWith(".ts") && !id.endsWith(".tsx")) {
      return undefined; // passthrough for non-TS files
    }

    const ts = await loadCompiler();
    const result = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
        experimentalDecorators: true,
      },
      fileName: id,
    });

    return result.outputText;
  },

  /**
   * Opt-in true type-checking (docs/PLUGINS.md Part B §4).
   *
   * Runs a full `ts.createProgram` over the VFS snapshot and returns
   * diagnostics — the slow path. NEVER called by transform/execute();
   * the host opts in explicitly (e.g. `sandbox.typecheck()`).
   *
   * @param {Array<{path: string, contents: string}>} files - VFS snapshot
   * @param {{libs?: string[], libBase?: string}} [opts]
   *   - libs: lib .d.ts entry points (default ES2020 + DOM)
   *   - libBase: browser-lane CDN base for lib files
   *   (default jsDelivr typescript@<version>/lib)
   * @returns {Promise<Array<{file, line, column, message, code}>>}
   *   line/column are 1-based; null for global diagnostics.
   */
  async typecheck(files, opts = {}) {
    const ts = await loadCompiler();
    const libNames = opts.libs || DEFAULT_LIBS;
    const libs = await getLibFiles(ts, libNames, opts.libBase);
    const options = compilerOptions(ts, libNames);
    const hash = snapshotHash(files) + "|" + libNames.join(",");

    let program;
    if (programCache && programCache.hash === hash) {
      program = programCache.program; // cache hit: no rebuild
    } else {
      const vfs = new Map();
      for (const f of files || []) {
        if (typeof f.contents === "string")
          vfs.set(normPath(f.path), f.contents);
      }
      const host = makeVfsHost(ts, options, vfs, libs);
      const rootNames = [...vfs.keys()].filter(
        (p) => p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".d.ts"),
      );
      program = ts.createProgram(
        rootNames,
        options,
        host,
        programCache ? programCache.program : undefined,
      );
      programCache = { hash, program };
      programBuilds++;
    }

    return ts.getPreEmitDiagnostics(program).map((d) => toDiagnostic(ts, d));
  },

  /** @internal test hook: number of program builds performed. */
  _buildCount() {
    return programBuilds;
  },

  /** @internal: clear the program + lib caches (tests, host reset). */
  _resetTypecheckCache() {
    programCache = null;
    programBuilds = 0;
    libCache.clear();
  },
};
