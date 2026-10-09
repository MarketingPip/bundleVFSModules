// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// Remove these when emulating Node.js true behaviour
// let document = undefined;
// let location = undefined;

__IMPORTS__;

// globalThis.window =  _window;
// globalThis.document =  _document;

for (const [name, fn] of [
  ["setTimeout", setTimeout],
  ["clearTimeout", clearTimeout],
  ["setInterval", setInterval],
  ["clearInterval", clearInterval],
]) {
  Object.defineProperty(globalThis, name, {
    get: () => fn,
    set: () => {}, // silently swallow user writes
    configurable: false,
    enumerable: true,
  });
}

// const tracker = new AsyncOperationTracker();
// --test auto-run lives in the node:test shim (src/test.js _maybeAutoRun):
// with --test in config.process.argv the shim runs registered tests and
// console.logs reporter output itself. No template interception here.
