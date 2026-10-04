// Tests for src/integrations/ — copy-based framework setup.
//
// Uses real tmp dirs (not the VFS): the integrations run on the host at
// build time, not in the browser sandbox.
import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  copyRuntimeAssets,
  assetPublicBase,
  RUNTIME_JS,
} from "../src/integrations/assets.js";
import { bundleVFSModules } from "../src/integrations/vite.js";
import { withBundleVFSModules } from "../src/integrations/next.js";

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bvm-integrations-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("assetPublicBase", () => {
  test("normalizes trailing slash", () => {
    expect(assetPublicBase("/bvm/")).toBe("/bvm");
    expect(assetPublicBase("/bvm")).toBe("/bvm");
    expect(assetPublicBase("/")).toBe("/");
  });
  test("rejects non-absolute path", () => {
    expect(() => assetPublicBase("bvm")).toThrow();
  });
});

describe("copyRuntimeAssets", () => {
  test("copies runtime.js and dist/", () => {
    const dest = path.join(tmp, "bvm");
    const out = copyRuntimeAssets(dest);
    expect(fs.existsSync(out.runtimeJs)).toBe(true);
    expect(fs.existsSync(out.distDir)).toBe(true);
    // Byte-identical runtime.js
    const src = fs.readFileSync(RUNTIME_JS);
    const dst = fs.readFileSync(out.runtimeJs);
    expect(dst.equals(src)).toBe(true);
    // dist/ has the expected marker files
    expect(fs.existsSync(path.join(out.distDir, "vfs.js"))).toBe(true);
    expect(fs.existsSync(path.join(out.distDir, "fs.js"))).toBe(true);
  });

  test("includePlayground copies ui.html", () => {
    const dest = path.join(tmp, "bvm");
    const out = copyRuntimeAssets(dest, { includePlayground: true });
    expect(out.uiHtml).toBeTruthy();
    expect(fs.existsSync(out.uiHtml)).toBe(true);
  });

  test("without includePlayground, no ui.html", () => {
    const dest = path.join(tmp, "bvm");
    const out = copyRuntimeAssets(dest);
    expect(out.uiHtml).toBeUndefined();
    expect(fs.existsSync(path.join(dest, "ui.html"))).toBe(false);
  });

  test("rejects relative destDir", () => {
    expect(() => copyRuntimeAssets("relative/path")).toThrow();
  });

  test("idempotent: second copy overwrites cleanly", () => {
    const dest = path.join(tmp, "bvm");
    copyRuntimeAssets(dest);
    const out2 = copyRuntimeAssets(dest);
    expect(fs.existsSync(out2.runtimeJs)).toBe(true);
  });
});

describe("vite plugin", () => {
  test("returns a Vite plugin object", () => {
    const plugin = bundleVFSModules();
    expect(plugin.name).toBe("vite-plugin-bundle-vfs-modules");
    expect(typeof plugin.configResolved).toBe("function");
    expect(typeof plugin.configureServer).toBe("function");
  });

  test("configResolved copies assets to publicDir", () => {
    const publicDir = path.join(tmp, "public");
    fs.mkdirSync(publicDir, { recursive: true });
    const plugin = bundleVFSModules({ assetDir: "bvm" });
    plugin.configResolved({ publicDir });
    expect(fs.existsSync(path.join(publicDir, "bvm", "runtime.js"))).toBe(true);
    expect(fs.existsSync(path.join(publicDir, "bvm", "dist", "vfs.js"))).toBe(
      true,
    );
  });

  test("custom assetDir is honored", () => {
    const publicDir = path.join(tmp, "public");
    fs.mkdirSync(publicDir, { recursive: true });
    const plugin = bundleVFSModules({ assetDir: "custom-assets" });
    plugin.configResolved({ publicDir });
    expect(
      fs.existsSync(path.join(publicDir, "custom-assets", "runtime.js")),
    ).toBe(true);
  });

  test("interception: true throws (reserved for future plugin)", () => {
    expect(() => bundleVFSModules({ interception: true })).toThrow(
      /opt-in browser-interception plugin/,
    );
  });
});

describe("next.js wrapper", () => {
  test("wraps config and preserves user webpack", () => {
    const userWebpack = (c) => ({ ...c, userCalled: true });
    const wrapped = withBundleVFSModules(
      { reactStrictMode: true, webpack: userWebpack },
      { assetDir: "bvm-test" },
    );
    expect(wrapped.reactStrictMode).toBe(true);
    expect(typeof wrapped.webpack).toBe("function");
    // webpack hook triggers the copy (cwd/public)
    const origCwd = process.cwd();
    process.chdir(tmp);
    fs.mkdirSync(path.join(tmp, "public"), { recursive: true });
    try {
      const out = wrapped.webpack({});
      expect(out.userCalled).toBe(true);
      expect(
        fs.existsSync(path.join(tmp, "public", "bvm-test", "runtime.js")),
      ).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("works without a user webpack function", () => {
    const wrapped = withBundleVFSModules({}, { assetDir: "bvm2" });
    const origCwd = process.cwd();
    process.chdir(tmp);
    fs.mkdirSync(path.join(tmp, "public"), { recursive: true });
    try {
      const out = wrapped.webpack({ entry: "x" });
      expect(out.entry).toBe("x");
      expect(
        fs.existsSync(path.join(tmp, "public", "bvm2", "runtime.js")),
      ).toBe(true);
    } finally {
      process.chdir(origCwd);
    }
  });

  test("second webpack call does not re-copy (idempotent flag)", () => {
    const wrapped = withBundleVFSModules({}, { assetDir: "bvm3" });
    const origCwd = process.cwd();
    process.chdir(tmp);
    fs.mkdirSync(path.join(tmp, "public"), { recursive: true });
    try {
      wrapped.webpack({});
      const mtime1 = fs.statSync(
        path.join(tmp, "public", "bvm3", "runtime.js"),
      ).mtimeMs;
      // Small delay to detect a re-copy via mtime change
      const start = Date.now();
      while (Date.now() - start < 10) {}
      wrapped.webpack({});
      const mtime2 = fs.statSync(
        path.join(tmp, "public", "bvm3", "runtime.js"),
      ).mtimeMs;
      expect(mtime2).toBe(mtime1);
    } finally {
      process.chdir(origCwd);
    }
  });
});
