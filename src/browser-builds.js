// src/browser-builds.js — backward-compat re-export shim.
//
// The Vite browser interception logic moved to src/plugins/vite-browser.js
// (Jared 2026-10-04: opt-in plugin, not baked into core). This file keeps
// the same exports so existing imports (tests, external consumers) keep
// working. New code should import from "./plugins/vite-browser.js".

export {
  interceptNativeSpecifier,
  lookupNativeInterception,
  BROWSER_BUILD_TARGETS,
  viteBrowserPlugin,
} from "./plugins/vite-browser.js";
