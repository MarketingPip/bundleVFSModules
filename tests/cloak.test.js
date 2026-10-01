// Cloak/masking tests — Jared's rule (2026-09-28, corrected):
// mask a shim function as `[native code]` IFF the corresponding real-Node
// builtin is genuinely native on Node v24 OR we monkey-patch it.
// Pure-JS reimplementations keep visible source — exactly like Node.
//
// Native lists below were verified against Node v24.20.0 with
//   /\[native code\]/.test(Function.prototype.toString.call(fn))

import process2, * as processNs from "../src/process.js";
import os from "../src/os.js";
import pathDefault, * as pathNs from "../src/path.js";
import * as urlNs from "../src/url.js";
import * as streamNs from "../src/stream.js";
import v8 from "../src/v8.js";
import * as wtNs from "../src/worker_threads.js";
import cryptoDefault from "../src/crypto.js";
import { Navigator } from "../src/navigator.js";
import { SANDBOX_TEMPLATE } from "../src/sandbox-template.js";

const maskedSource = (name) => `function ${name}() { [native code] }`;

// Visible behavior: user code calling fn.toString() must see [native code].
// (Host-native re-exports already satisfy this; maskAsNative() skips them.)
function expectMasked(fn, name) {
  expect(typeof fn).toBe("function");
  expect(fn.toString()).toBe(maskedSource(name));
}

function expectUnmasked(fn) {
  expect(typeof fn).toBe("function");
  expect(Object.prototype.hasOwnProperty.call(fn, "toString")).toBe(false);
  expect(fn.toString()).not.toMatch(/\[native code\]/);
}

describe("native process functions are masked", () => {
  // Real Node v24: dlopen, uptime, _getActiveRequests, _getActiveHandles,
  // getActiveResourcesInfo, reallyExit, _kill, constrainedMemory,
  // availableMemory, getuid, geteuid, getgid, getegid, getgroups,
  // _debugProcess, _debugEnd, abort are native.
  const NATIVE = [
    "dlopen",
    "uptime",
    "_getActiveRequests",
    "_getActiveHandles",
    "getActiveResourcesInfo",
    "reallyExit",
    "_kill",
    "constrainedMemory",
    "availableMemory",
    "getuid",
    "geteuid",
    "getgid",
    "getegid",
    "getgroups",
    "_debugProcess",
    "_debugEnd",
    "abort",
  ];
  test.each(NATIVE)("process.%s is masked", (key) => {
    expectMasked(process2[key], key);
  });
  test.each(["abort", "uptime", "reallyExit", "getuid", "dlopen"])(
    "named process export %s is masked",
    (key) => {
      expectMasked(processNs[key], key);
    },
  );
});

describe("native os/path/url/stream/v8/worker_threads/crypto functions are masked", () => {
  test.each(["availableParallelism", "freemem", "totalmem"])(
    "os.%s is masked",
    (key) => {
      expectMasked(os[key], key);
    },
  );
  test("path.format is masked", () => {
    expectMasked(pathDefault.format, "format");
    expectMasked(pathNs.format, "format");
  });
  test("url.URLPattern is masked when implemented", () => {
    if (typeof urlNs.URLPattern === "function")
      expectMasked(urlNs.URLPattern, "URLPattern");
  });
  test("stream._isArrayBufferView is masked", () => {
    expectMasked(streamNs._isArrayBufferView, "_isArrayBufferView");
  });
  test.each(["cachedDataVersionTag", "Serializer", "Deserializer"])(
    "v8.%s is masked",
    (key) => {
      if (typeof v8[key] === "function") expectMasked(v8[key], key);
    },
  );
  test.each(["takeCoverage", "stopCoverage"])(
    "v8.%s is masked when present",
    (key) => {
      if (typeof v8[key] === "function") expectMasked(v8[key], key);
    },
  );
  test.each(["MessageChannel", "MessagePort"])(
    "worker_threads.%s is masked",
    (key) => {
      expectMasked(wtNs[key], key);
    },
  );
  test("worker_threads.moveMessagePortToContext is masked", () => {
    expectMasked(wtNs.moveMessagePortToContext, "moveMessagePortToContext");
  });
  test("crypto.timingSafeEqual is masked", () => {
    expectMasked(cryptoDefault.timingSafeEqual, "timingSafeEqual");
  });
});

describe("pure-JS reimplementations keep visible source", () => {
  const JS_FNS = [
    ["process.cwd", () => process2.cwd],
    ["process.exit", () => process2.exit],
    ["process.nextTick", () => process2.nextTick],
    ["process.hrtime", () => process2.hrtime],
    ["process.chdir", () => process2.chdir],
    ["process.kill", () => process2.kill],
    ["process.emitWarning", () => process2.emitWarning],
    ["named process export cwd", () => processNs.cwd],
    ["named process export exit", () => processNs.exit],
    ["named process export nextTick", () => processNs.nextTick],
    ["named process export setuid (JS on real Node)", () => processNs.setuid],
    ["os.platform", () => os.platform],
    ["os.cpus", () => os.cpus],
    ["os.hostname", () => os.hostname],
    ["path.join", () => pathNs.join],
    ["path.resolve", () => pathNs.resolve],
    ["path.basename", () => pathNs.basename],
  ];
  test.each(JS_FNS)("%s keeps visible source", (_label, get) => {
    expectUnmasked(get());
  });
});

describe("sandbox monkey-patches are masked in the template", () => {
  // These wrap/replace host functions, so per the rule they read as native.
  // (setTimeout/clearTimeout/setInterval/clearInterval/fetch/XHR/console
  // were already masked; these are the remaining sites.)
  test.each([
    [
      "Object.defineProperty",
      "maskFunction(Object.defineProperty, origDefineProperty)",
    ],
    [
      "process.exit",
      'rt.process.exit.toString = () => "function exit() { [native code] }"',
    ],
    [
      "Array.prototype.toSorted",
      'Array.prototype.toSorted.toString = () => "function toSorted() { [native code] }"',
    ],
    ["EventSource", "maskFunction(globalThis.EventSource, OrigEventSource)"],
    ["WebSocket", "maskFunction(globalThis.WebSocket, OrigWS)"],
    [
      "navigator.sendBeacon",
      "maskFunction(globalThis.navigator.sendBeacon, origBeacon)",
    ],
  ])("%s patch is masked", (_label, snippet) => {
    expect(SANDBOX_TEMPLATE).toContain(snippet);
  });

  // Regression (2026-10-01): the re-cloak called maskFunction() in
  // 00-runtime-object.js but defined it in 71-xhr.js, assuming function
  // declarations hoist across the concatenated template. Under es-module-shims
  // (type="module-shim" injection) the early call throws
  // "ReferenceError: maskFunction is not defined", killing bootstrap before
  // the iframe posts back — browser E2E times out at execute-start.
  // The definition must precede ALL calls in source order.
  test("maskFunction is defined before its first call", () => {
    const defIdx = SANDBOX_TEMPLATE.indexOf("function maskFunction(patchedFn");
    expect(defIdx).toBeGreaterThan(-1);
    const callPattern = /maskFunction\(/g;
    let m;
    while ((m = callPattern.exec(SANDBOX_TEMPLATE)) !== null) {
      // skip the definition itself
      if (m.index === defIdx) continue;
      expect(m.index).toBeGreaterThan(defIdx);
    }
  });
});

describe("Symbol.toStringTag", () => {
  test("process keeps the [object process] tag", () => {
    expect(Object.prototype.toString.call(process2)).toBe("[object process]");
  });
  test("navigator prototype carries no tag, like real Node", () => {
    const nav = Object.create(Navigator.prototype);
    expect(Object.prototype.toString.call(nav)).toBe("[object Object]");
  });
  test("os carries no tag, like real Node", () => {
    expect(Object.prototype.toString.call(os)).toBe("[object Object]");
  });
});
