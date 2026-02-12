import { build } from "esbuild";
import fs from "node:fs";

async function bundleToString(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser", // or "node"
    write: false
  });

  return result.outputFiles[0].text;
}

async function main() {
  const memfsCode = await bundleToString("memfs");

  const vfsContent = `
export const myVFS = {
  "/node_modules/memfs/index.js": ${JSON.stringify(memfsCode)}
};
`;

  fs.writeFileSync("src/vfs.js", vfsContent.trim());
}

main();
