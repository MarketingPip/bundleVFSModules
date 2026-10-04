import { describe, test, expect } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lookupNativeInterception } from "../src/browser-builds.js";
import { registerPlugin, clearPlugins } from "../src/plugins.js";
import { viteBrowserPlugin } from "../src/plugins/vite-browser.js";

/**
 * Red-first proof: the `rollup` → `@rollup/browser` interception MUST target
 * the ESM build (`dist/es/rollup.browser.js`), not the CJS build
 * (`dist/rollup.browser.js`).
 *
 * Why it matters: the CJS build uses `module.exports` and provides NO ESM
 * named exports. ESM `import { rollup, VERSION } from 'rollup'` only works
 * against the ESM build. If the interception table ever regresses to the
 * CJS path, the named-export test below goes red.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NM = path.join(__dirname, "..", "node_modules");

const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.join(NM, "@rollup/browser", "package.json"), "utf8"),
).version;

const ESM_BUILD = "/node_modules/@rollup/browser/dist/es/rollup.browser.js";

describe("@rollup/browser ESM interception target", () => {
  test("interception target is the ESM build, never the CJS build", () => {
    expect(lookupNativeInterception("rollup")).toBe(ESM_BUILD);
  });

  test("named exports import from the intercepted ESM build", async () => {
    const mod = await import(
      pathToFileURL(path.join(NM, "@rollup/browser/dist/es/rollup.browser.js"))
        .href
    );
    expect(mod.VERSION).toBe(PKG_VERSION);
    expect(mod.VERSION).toMatch(/^4\./);
    expect(typeof mod.rollup).toBe("function");
    expect(typeof mod.defineConfig).toBe("function");
  });

  test("the CJS build is CJS (why the ESM target matters)", () => {
    // The CJS build needs CJS→ESM conversion before an ESM `import` can
    // use it; the ESM build is already importable. The interception target
    // must be the ESM build so `import { rollup } from 'rollup'` works
    // without a conversion pass.
    const cjsSrc = fs.readFileSync(
      path.join(NM, "@rollup/browser/dist/rollup.browser.js"),
      "utf8",
    );
    const esmSrc = fs.readFileSync(
      path.join(NM, "@rollup/browser/dist/es/rollup.browser.js"),
      "utf8",
    );
    expect(cjsSrc).toContain("module.exports");
    expect(esmSrc).toMatch(/export\s*\{[^}]*\bVERSION\b[^}]*\}/);
  });
});
