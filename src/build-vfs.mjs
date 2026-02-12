import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeModulesPolyfillPlugin } from "esbuild-plugins-node-modules-polyfill";
// Get __dirname equivalent in ESM
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function bundleToString(entry) {
     function getEntryPath(entry){
    return path.resolve(__dirname, entry);
   }
  entry = getEntryPath(entry);
  try {
    const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser", // Use "browser" to force esbuild to include everything
    target: "es2020",
    minify: true,        // Optional: keeps the VFS file size smaller
    write: false,
    // This ensures node built-ins don't break the bundle
    external: [], 
    plugins: [nodeModulesPolyfillPlugin()],  
  });

    return result.outputFiles[0].text;
  } catch (err) {
    console.error(`Build failed for ${entryPath}:`, err);
    process.exit(1);
  }
}

const DIST_DIR = "dist";

// Modules that should be bundled
const BUNDLED_MODULES = {
  fs: "memfs-entry.js",
  path: "path.js",
};

// Node core modules to stub
const STUB_MODULES = [
  "os",
  "http",
  "https",
  "url",
  "stream",
  "crypto",
  "events",
  "util",
  "child_process",
  "readline",
  "zlib",
  "dns",
  "net",
  "tls",
  "dgram",
  "assert",
  "vm",
  "tty",
  "perf_hooks",
  "worker_threads",
  "cluster",
];

async function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function buildBundledModules() {
  const output = {};

  for (const [name, entry] of Object.entries(BUNDLED_MODULES)) {
    const code = await bundleToString(entry);

    // Write individual bundle file
    const bundlePath = path.join(DIST_DIR, `${name}.bundle.js`);
    fs.writeFileSync(bundlePath, code);

    console.log(`✅ Built ${name} → ${bundlePath}`);

    output[name] = code;
  }

  return output;
}

function generateStubModules() {
  const stubs = {};

  for (const name of STUB_MODULES) {
    stubs[name] = {
      get: () => {
        throw new Error(`Not implemented: ${name}`);
      },
    };
  }

  return stubs;
}

function generateVFS(bundledModules, stubModules) {
  const vfsObject = {
    ...bundledModules,
    ...stubModules,
  };

  return `export const myVFS = ${JSON.stringify(vfsObject, null, 2)};`;
}

async function main() {
  await ensureDir(DIST_DIR);

  const bundledModules = await buildBundledModules();
  const stubModules = generateStubModules();

  const vfsContent = generateVFS(bundledModules, stubModules);

  const vfsPath = path.join(DIST_DIR, "vfs.js");
  fs.writeFileSync(vfsPath, vfsContent);

  console.log(`✅ VFS written → ${vfsPath}`);
}

main();
