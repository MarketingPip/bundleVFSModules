import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeModulesPolyfillPlugin } from "esbuild-plugins-node-modules-polyfill";

import { minify } from "terser";
import { builtinModules } from 'module';

export function nodeGitHubPlugin() {
  return {
    name: 'node-github-resolver',
    setup(build) {
      const GH_BASE = 'https://github.com/nodejs/node/blob/main/';
      const RAW_BASE = 'https://raw.githubusercontent.com/nodejs/node/main/';
      const nodeBuiltins = new Set(builtinModules);
      const cache = new Map();

      build.onResolve({ filter: /.*/, namespace: 'node-gh' }, args => {
        // 1. If it's a standard Node.js builtin (fs, path, etc.), let it be external
        if (nodeBuiltins.has(args.path) || args.path.startsWith('node:')) {
          return { path: args.path, external: true };
        }

        let finalPath = args.path;

        // 2. Map internal/ and v8/ to the lib directory in GitHub
        if (args.path.startsWith('internal/') || args.path.startsWith('v8/')) {
          finalPath = `${GH_BASE}lib/${args.path}.js`;
        } 
        // 3. Resolve relative paths within the GitHub repo
        else if (args.path.startsWith('.')) {
          finalPath = new URL(args.path, args.importer).href;
          if (!finalPath.endsWith('.js')) finalPath += '.js';
        }

        return {
          path: finalPath,
          namespace: 'node-gh',
        };
      });

      // Entry point resolution
      build.onResolve({ filter: /github\.com\/nodejs\/node/ }, args => {
        return { path: args.path, namespace: 'node-gh' };
      });

      build.onLoad({ filter: /.*/, namespace: 'node-gh' }, async (args) => {
        // If it managed to get here but isn't a URL, it's an error
        if (!args.path.startsWith('http')) {
          return { errors: [{ text: `Invalid path in node-gh namespace: ${args.path}` }] };
        }

        const rawUrl = args.path.replace(GH_BASE, RAW_BASE);
        
        if (cache.has(rawUrl)) {
          return { contents: cache.get(rawUrl), loader: 'js' };
        }

        try {
          const contents = await fetchWithRetry(rawUrl);
          cache.set(rawUrl, contents);
          return { contents, loader: 'js' };
        } catch (err) {
          // Handle 404s for deps like undici/amaro which are complex sub-repos
          return { 
            contents: `/* Failed to fetch ${rawUrl} */\nmodule.exports = {};`, 
            loader: 'js' 
          };
        }
      });
    },
  };
}

async function fetchWithRetry(url, retries = 3, delay = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

export function esmShPlugin() {
  const cache = new Map();

  // Helper for retrying fetches with exponential backoff
  async function fetchWithRetry(url, retries = 3, delay = 500) {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        return await res.text();
      } catch (err) {
        const isLastAttempt = i === retries - 1;
        if (isLastAttempt) throw err;
        
        console.warn(`[esm-sh-plugin] Fetch failed for ${url}. Retrying in ${delay}ms... (${i + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // Exponential backoff
      }
    }
  }

  return {
    name: 'esm-sh-plugin',
    setup(build) {
      // Resolve remote URLs
      build.onResolve({ filter: /^https?:\/\// }, args => {
        return { path: args.path, namespace: 'esm-sh-ns' };
      });

      // Resolve relative or absolute paths inside esm.sh bundles
      build.onResolve({ filter: /^\.\/|^\.\.\/|^\//, namespace: 'esm-sh-ns' }, args => {
        if (!args.importer.startsWith('http')) {
          return null; 
        }
        let resolved;
        try {
          if (args.path.startsWith('/')) {
            const origin = new URL(args.importer).origin;
            resolved = new URL(args.path, origin).toString();
          } else {
            resolved = new URL(args.path, args.importer).toString();
          }
          return { path: resolved, namespace: 'esm-sh-ns' };
        } catch {
          return { path: args.path, namespace: 'esm-sh-ns' };
        }
      });

      // Load remote content with retry logic
      build.onLoad({ filter: /.*/, namespace: 'esm-sh-ns' }, async args => {
        let url = args.path;

        if (url.includes('esm.sh') && !url.includes('?bundle')) {
          url += url.includes('?') ? '&bundle' : '?bundle';
        }

        if (cache.has(url)) return { contents: cache.get(url), loader: 'js' };

        try {
          const contents = await fetchWithRetry(url);
          cache.set(url, contents);
          return { contents, loader: 'js' };
        } catch (err) {
          return {
            errors: [{
              text: `esm-sh-plugin failed to fetch "${url}" after multiple attempts.`,
              detail: err.message,
            }]
          };
        }
      });
    },
  };
}

async function minifyCode(code) {
  const result = await minify(code, {
    compress: true,
    mangle: true,
    module: true
  });
  return result.code;
}



const DIST_DIR = "dist";

// Get __dirname equivalent in ESM
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function bundleToString(entry) {
  entry = path.resolve(__dirname, entry);
  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2020",
      minify: true, // esbuild's minifier is extremely fast and reliable
      write: false,
      external: [], 
      treeshake:true,
      plugins: [nodeGitHubPlugin(), nodeModulesPolyfillPlugin({
      // Whether to polyfill specific globals.
      //modules: { fs: false, path: true, /* only what's needed */ },  
      globals: {
        Buffer: true, // can also be 'global', 'process'
      },
    }), esmShPlugin()],
      legalComments: "linked", // This creates a separate file in the output array
      outdir: DIST_DIR
    });

    // Find the JS file specifically, don't just grab index 0
    const jsFile = result.outputFiles.find(f => f.path.endsWith('.js'));
    const legalFile = result.outputFiles.find(f => f.path.endsWith('.txt'));

    if (!jsFile) throw new Error("No JS output found");

    // If you already set minify: true in build(), 
    // you might not even need the minifyCode() wrapper.
    return await minifyCode(jsFile.text); 
  } catch (err) {
    console.error(`Build failed for ${entry}:`, err);
    process.exit(1);
  }
}


// Modules that should be bundled
const BUNDLED_MODULES = {
  buffer: "buffer.js",
  fs: "fs.js",
  fs_promises: "fs/promises.js",
  path: "path.js",
  path_posix: "path/posix.js",
  path_win32: "path/win32.js",
  assert: "assert.js",
  assert_strict: "assert/strict.js",
  os: "os.js",
  util: "util.js",
  util_types: "util/types.js",
  sys: "sys.js",
  async_hooks: "async_hooks.js",
  url: "url.js",
  readline: "readline.js",
  readline_promises: "readline/promises.js",
  http: "http.js",
  https: "https.js",
  http2: "http2.js",
  stream: "stream.js",
  stream_promises: "stream/promises.js",
  stream_web: "stream/web.js",
  stream_consumers: "stream/consumers.js",
  crypto: "crypto.js",
  net: "net.js",
  events: "events.js",
  inspector: "inspector.js",
  v8: "v8.js",
  tty: "tty.js",
  tls: "tls.js",
  dgram: "dgram.js",
  diagnostics_channel: "diagnostics_channel.js",
  inspector: "inspector.js",
  module: "module.js",
  ws: "ws.js",
  dns: "dns.js",
  dns_promises: "dns/promises.js",
  constants: "constants.js",
  querystring: "querystring.js",
  vm: "vm.js",
  string_decoder: "string_decoder.js",
  serialize_js: "serialize_js.js",
  test: "test.js",
  test_reporters: "test/reporters.js",
  perf_hooks: "perf_hooks.js",
  zlib: "zlib.js",
  sea: "sea.js",
  trace: "trace_events.js",
  wasi: "wasi.js",
  
  child_process: "child_process.js",
  punycode: "punycode.js",
  timers: "timers.js",
  timers_promises: "timers/promises.js",

 // RUNTIME_CLI_TABLE: "specials/cli_table.js",
  RUNTIME_BUNDLER: "specials/bundler.js",
  worker_threads: "worker_threads.js",
  RUNTIME_NODE_GLOBALS: "globals.js",
  
  
 // buffer: "buffer.js",
};

// Node core modules to stub
const STUB_MODULES = [
  //"os",
 // "http",
//  "http2",
  //"https",
//  "events",
  //"async_hooks",
 // "module",
  //"url",
//  "crypto",
//  "constants",
//  "events",
 // "util",
 // "child_process",
 // "readline",
//  "readline/promises",
//  "zlib",
//  "dns",
 // "net",
 // "tls",
  
//  "dgram",
//  "assert",
//  "inspector",
  
//  "vm",
 // "module",
  //"v8",
//  "punycode",
 // "querystring",
//  "repl",
 // "string_decoder",
  //"worker_threads",
  //"wasi",
 // "trace_events",
 // "sys",
//  "stream",
//  "stream/promises",
//  "stream/web",
  //"tty",
//  "perf_hooks",
//  "cluster",
];

async function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function buildBundledModules() {
  const output = {};

  // Create a promise for each bundle
  const bundlePromises = Object.entries(BUNDLED_MODULES).map(
    async ([name, entry]) => {
      const code = await bundleToString(entry);

      // Write individual bundle file
      const bundlePath = path.join(DIST_DIR, `${name}.js`);
      fs.writeFileSync(bundlePath, code);

      console.log(`✅ Built ${name} → ${bundlePath}`);

      return { name, code };
    }
  );

  // Wait for all bundles to complete
  const results = await Promise.all(bundlePromises);

  // Store results in output object
  for (const { name, code } of results) {
    output[name] = code;
  }

  return output;
}


function generateStubModules() {
  const stubs = {};

 
 

  
  for (const name of STUB_MODULES) {
    stubs[name] = `
function ${name}() {
  throw new Error("Not implemented: ${name}");
}
` 
  }

  return stubs;
}



function generateVFS(bundledModules, stubModules) {
  const allModules = {
    ...bundledModules,
    ...stubModules,
  };

  let output = "";

  // 1️⃣ Export each module individually
    for (const [name, value] of Object.entries(allModules)) {
    output += `export const ${name} = ${JSON.stringify(value)};\n\n`;
  }


  // 2️⃣ Export combined VFS object (using references, not JSON)
  const moduleNames = Object.keys(allModules).join(", ");

 // output += `export const myVFS = ${JSON.stringify(allModules)};`;

  return output;
}


async function main() {
  await ensureDir(DIST_DIR);

  const bundledModules = await buildBundledModules();
  const stubModules = generateStubModules();

  const vfsContent = await minifyCode(generateVFS(bundledModules, stubModules));

  const vfsPath = path.join(DIST_DIR, "vfs.js");
  fs.writeFileSync(vfsPath, vfsContent);

  console.log(`✅ VFS written → ${vfsPath}`);
}

main();
