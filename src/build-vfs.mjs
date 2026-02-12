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
  const entry = path.resolve(__dirname, "memfs-entry.js");
  const outputPath = "dist/vfs.js"; // or "src/vfs.js" based on your error
  const outputDir = path.dirname(outputPath);

  const memfsCode = await bundleToString(entry);

  const vfsContent = `export const myVFS = {
  "/node_modules/memfs/index.js": ${JSON.stringify(memfsCode)}
};`;

  // --- The Fix ---
  // Ensure the directory exists before writing
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  // ----------------

  fs.writeFileSync(outputPath, vfsContent.trim());
  console.log(`✅ Success! Written to ${outputPath}`);
}

main();
