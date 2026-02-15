import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeModulesPolyfillPlugin } from "esbuild-plugins-node-modules-polyfill";

import { minify } from "terser";

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
      plugins: [nodeModulesPolyfillPlugin()],
      legalComments: "linked", // This creates a separate file in the output array
      outdir: DIST_DIR
    });

    // Find the JS file specifically, don't just grab index 0
    const jsFile = result.outputFiles.find(f => f.path.endsWith('.js'));
    const legalFile = result.outputFiles.find(f => f.path.endsWith('.txt'));

    if (!jsFile) throw new Error("No JS output found");

    // If you already set minify: true in build(), 
    // you might not even need the minifyCode() wrapper.
    return jsFile.text; 
    
  } catch (err) {
    console.error(`Build failed for ${entry}:`, err);
    process.exit(1);
  }
}


// Modules that should be bundled
const BUNDLED_MODULES = {
  fs: "memfs-entry.js",
  path: "path.js",
  assert: "assert.js",
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
//  "assert",
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
