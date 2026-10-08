// ============================================================================
// IMPORT RESOLVER MODULE
// ============================================================================

export class ImportResolver {
  constructor(options = {}) {
    this.cdnBase = options.cdnBase || "https://esm.sh";
    this.transformRules = options.transformRules || [];
    this.cache = new Map();
    this.fallbackCDN = options.fallbackCDN;
  }

  resolve(code) {
    const imports = [];
    const requires = [];
    const cleaned = { imports: [], dynamicImports: [], requires: [] };
    const dynamicImports = []; // New tracker
    const replacements = [];

    const ast = customAcorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
    });

    // 1. Process Static Imports (ImportDeclaration)
    const importNodes = ast.body.filter(
      (node) => node.type === "ImportDeclaration",
    );
    for (const node of importNodes) {
      const source = node.source.value;
      const transformedSource = this._transformSource(source, "import");
      cleaned.imports.push(transformedSource);
      imports.push(
        code.slice(node.start, node.source.start) +
          `'${transformedSource}'` +
          code.slice(node.source.end, node.end),
      );
      replacements.push({ start: node.start, end: node.end, content: "" });
    }

    // 2. Process Requires and Dynamic Imports (Walking the AST)
    this._walkAST(ast, (node) => {
      // --- HANDLE REQUIRE ---
      if (
        node.type === "CallExpression" &&
        node.callee.name === "require" &&
        node.arguments[0]?.type === "Literal"
      ) {
        const source = node.arguments[0].value;
        const transformedSource = this._transformSource(source, "require");
        requires.push(`require('${transformedSource}')`);
        cleaned.requires.push(transformedSource);
        replacements.push({
          start: node.arguments[0].start,
          end: node.arguments[0].end,
          content: `'${transformedSource}'`,
        });
      }

      // --- HANDLE DYNAMIC IMPORT() ---
      if (node.type === "ImportExpression" && node.source.type === "Literal") {
        const source = node.source.value;
        const transformedSource = this._transformSource(
          source,
          "dynamic-import",
        );

        dynamicImports.push(`import('${transformedSource}')`);
        cleaned.dynamicImports.push(transformedSource);
        // Replace the string inside the import(...)
        replacements.push({
          start: node.source.start,
          end: node.source.end,
          content: `'${transformedSource}'`,
        });
      }
    });

    // 3. APPLY REPLACEMENTS
    replacements.sort((a, b) => b.start - a.start);

    let cleanedCode = code;
    for (const r of replacements) {
      cleanedCode =
        cleanedCode.slice(0, r.start) + r.content + cleanedCode.slice(r.end);
    }

    return {
      imports,
      requires,
      dynamicImports, // Added to return object
      cleanedCode: cleanedCode.trim(),
      cleanedImports: cleaned,
      hasImportsOrRequires:
        imports.length + requires.length + dynamicImports.length > 0,
    };
  }

  _walkAST(node, callback) {
    callback(node);

    for (const key in node) {
      if (!node.hasOwnProperty(key)) continue;
      const child = node[key];

      if (Array.isArray(child)) {
        child.forEach(
          (n) => n && typeof n.type === "string" && this._walkAST(n, callback),
        );
      } else if (child && typeof child.type === "string") {
        this._walkAST(child, callback);
      }
    }
  }

  _transformSource(source, kind) {
    const cacheKey = `${kind}:${source}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    let transformed = source;

    for (const rule of this.transformRules) {
      const testResult =
        typeof rule.test === "function"
          ? rule.test(transformed, kind)
          : rule.test.test(transformed);

      if (testResult) {
        transformed = rule.transform(transformed, kind);
      }
    }

    // absolute URLs pass through
    if (/^https?:\/\//.test(transformed)) {
      this.cache.set(cacheKey, transformed);
      return transformed;
    }

    if (transformed.startsWith("./") || transformed.startsWith("../")) {
      return transformed;
    }

    // Gap #6/#5: builtins are not CDN packages. esm.sh 400s on 'node:'-style
    // specifiers and would serve its own shim for bare names instead of our
    // dist shims. Node treats 'node:X' and 'X' identically for every builtin,
    // so pass recognized ones (prefixed or bare) through untouched — the
    // sandbox loader resolves them via the builtin interop path (the same
    // path VFS-file imports already use). Unrecognized specifiers keep the old
    // behavior (CDN fallback).
    if (typeof transformed === "string") {
      const __builtinNorm = normalizeBuiltinSpecifier(
        transformed,
        builtinModules,
      );
      if (__builtinNorm.isNodeBuiltIn) {
        this.cache.set(cacheKey, transformed);
        return transformed;
      }
    }

    // Platform interception (AGENTS.md rule 6): native-only packages
    // (rollup, esbuild, rolldown, ...) substitute the vendor's browser/WASM
    // build from the VFS — but ONLY when the vite-browser plugin is
    // registered (opt-in, Jared 2026-10-04). This MUST run before the CDN
    // fallback — otherwise entry `import "rolldown"` becomes
    // https://esm.sh/rolldown, the browser fetches esm.sh's build of the
    // NATIVE package, and its esm.sh-style `/node/*.mjs` builtin imports die
    // as absolute VFS paths in the esms resolve hook (2026-10-01:
    // `[bvm:resolve] _dynamic_import failed for file URL "/node/process.mjs"`).
    // Nested imports already go through this table via _dynamic_import; the
    // entry path was the gap.
    const intercepted = isViteBrowserInterceptionActive()
      ? lookupNativeInterception(transformed)
      : null;
    if (intercepted) {
      this.cache.set(cacheKey, intercepted);
      return intercepted;
    }

    if (!this.fallbackCDN) {
      this.cache.set(cacheKey, transformed);
      return transformed;
    }

    transformed = `${this.cdnBase}/${transformed}`;
    this.cache.set(cacheKey, transformed);
    return transformed;
  }

  addTransformRule(test, transform) {
    this.transformRules.push({ test, transform });
  }

  clearCache() {
    this.cache.clear();
  }
}

