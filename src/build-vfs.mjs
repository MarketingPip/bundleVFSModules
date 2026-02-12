import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Get __dirname equivalent in ESM
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function bundleToString(entryPath) {
  try {
    const result = await build({
      entryPoints: [entryPath],
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
      logLevel: "info", // This will show errors in the console
    });

    return result.outputFiles[0].text;
  } catch (err) {
    console.error(`Build failed for ${entryPath}:`, err);
    process.exit(1);
  }
}

async function main() {
  // Use absolute paths to be safe
  const entry = path.resolve(__dirname, "memfs-entry.js");
  const output = path.resolve(__dirname, "src/vfs.js");

  console.log("Bundling...");
  const memfsCode = await bundleToString(entry);

  const vfsContent = `export const myVFS = {
  "/node_modules/memfs/index.js": ${JSON.stringify(memfsCode)}
};`;

  fs.writeFileSync(output, vfsContent.trim());
  console.log(`Successfully wrote VFS to ${output}`);
}

main();
