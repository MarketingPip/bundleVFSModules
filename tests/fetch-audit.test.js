// tests/fetch-audit.test.js — differential audit of fetch/Headers/Response/Request.
//
// Runnable directly: `node tests/fetch-audit.test.js` (Node 24 undici = reference)
// Via harness: `node parity/real-runtime.mjs fetch tests/fetch-audit.test.js`
//
// Each check asserts Node-undici behavior. In the browser lane, failures are
// DIVERGENCES to be documented in docs/FETCH_PLATFORM.md — not necessarily bugs.
// The audit logs __AUDIT__ with per-check results for diffing.
//
// NOTE: Uses inline assertions, NOT node:assert (the sandbox's assert shim
// has a separate issue; this audit tests fetch APIs, not assert).
//
// This file is an AUDIT SCRIPT, not a Jest test. It runs via:
//   node tests/fetch-audit.test.js          (Node reference)
//   node parity/real-runtime.mjs fetch tests/fetch-audit.test.js  (differential)
// Under Jest, the VM realm breaks `instanceof` checks, so we skip.
// Detect Jest via JEST_WORKER_ID (reliable) or jest global (CJS).
const isJest =
  typeof process !== "undefined" &&
  process.env &&
  (process.env.JEST_WORKER_ID !== undefined ||
    typeof jest !== "undefined");
if (isJest) {
  test.skip("fetch audit (script only, not a Jest test)", () => {});
} else {
  runAudit();
}

function runAudit() {

const checks = [];

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function ok(v, msg) {
  if (!v) throw new Error(msg || `expected truthy, got ${JSON.stringify(v)}`);
}
function throws(fn, Ctor, msg) {
  try {
    fn();
  } catch (e) {
    if (e instanceof Ctor) return;
    throw new Error(`${msg}: threw ${e.constructor.name}, expected ${Ctor.name}`);
  }
  throw new Error(`${msg}: did not throw, expected ${Ctor.name}`);
}
function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      // Async check — record pending, resolve later
      return r.then(
        () => checks.push({ name, pass: true }),
        (e) => checks.push({ name, pass: false, error: String((e && e.message) || e) }),
      );
    }
    checks.push({ name, pass: true });
  } catch (e) {
    checks.push({ name, pass: false, error: String((e && e.message) || e) });
  }
}

// ─── Headers ─────────────────────────────────────────────────────────────

check("Headers: case-insensitive get", () => {
  const h = new Headers({ "X-Custom-Header": "value1" });
  eq(h.get("x-custom-header"), "value1", "lowercase");
  eq(h.get("X-CUSTOM-HEADER"), "value1", "uppercase");
});

check("Headers: getSetCookie exists (Node 20.10+)", () => {
  eq(typeof Headers.prototype.getSetCookie, "function", "getSetCookie type");
});

check("Headers: getSetCookie returns array", () => {
  const h = new Headers();
  h.append("set-cookie", "a=1; Path=/");
  h.append("set-cookie", "b=2; Path=/");
  const cookies = h.getSetCookie();
  ok(Array.isArray(cookies), "must be array");
  eq(cookies.length, 2, "length");
  eq(cookies[0], "a=1; Path=/", "first");
  eq(cookies[1], "b=2; Path=/", "second");
});

check("Headers: multi-value append joins with ', '", () => {
  const h = new Headers();
  h.append("x-multi", "1");
  h.append("x-multi", "2");
  eq(h.get("x-multi"), "1, 2", "joined");
});

check("Headers: set() replaces", () => {
  const h = new Headers({ "x-replace": "old" });
  h.set("x-replace", "new");
  eq(h.get("x-replace"), "new", "replaced");
});

check("Headers: invalid name throws TypeError", () => {
  throws(() => new Headers({ " bad name": "1" }), TypeError, "bad name");
});

check("Headers: invalid value throws TypeError", () => {
  throws(() => new Headers({ x: "bad\nvalue" }), TypeError, "bad value");
});

check("Headers: iteration is sorted by name", () => {
  const h = new Headers({ "z-last": "1", "a-first": "2" });
  const keys = [...h.keys()];
  deepEq(keys, ["a-first", "z-last"], "sorted keys");
});

// ─── Response ────────────────────────────────────────────────────────────

check("Response: json() sets content-type", () => {
  const r = Response.json({ a: 1 });
  eq(r.headers.get("content-type"), "application/json", "content-type");
});

check("Response: json() body parses", async () => {
  const r = Response.json({ a: 1 });
  const body = await r.json();
  deepEq(body, { a: 1 }, "body");
});

check("Response: invalid status throws RangeError", () => {
  throws(() => new Response("x", { status: 999 }), RangeError, "bad status");
});

check("Response: invalid statusText throws TypeError", () => {
  throws(() => new Response("x", { statusText: "Bad\nText" }), TypeError, "bad statusText");
});

check("Response: redirect() sets status and location", () => {
  const r = Response.redirect("https://example.com", 302);
  eq(r.status, 302, "status");
  eq(r.headers.get("location"), "https://example.com/", "location");
});

check("Response: error() has type error", () => {
  const r = Response.error();
  eq(r.type, "error", "type");
  eq(r.status, 0, "status");
});

// ─── Request ─────────────────────────────────────────────────────────────

check("Request: GET with body throws TypeError", () => {
  throws(
    () => new Request("https://example.com", { method: "GET", body: "hi" }),
    TypeError,
    "GET body",
  );
});

check("Request: POST with string body works", () => {
  const r = new Request("https://example.com", { method: "POST", body: "hi" });
  eq(r.method, "POST", "method");
});

check("Request: headers are accessible", () => {
  const r = new Request("https://example.com", { headers: { "x-test": "1" } });
  eq(r.headers.get("x-test"), "1", "header");
});

check("Request: url is normalized", () => {
  const r = new Request("https://example.com/path");
  eq(r.url, "https://example.com/path", "url");
});

// ─── Report ──────────────────────────────────────────────────────────────

async function main() {
  // Wait for async checks
  await new Promise((r) => setTimeout(r, 200));
  const failed = checks.filter((c) => !c.pass);
  const report = {
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
  };
  console.log("__AUDIT__" + JSON.stringify(report));
  if (failed.length > 0) {
    const err = new Error(
      `fetch audit: ${failed.length}/${checks.length} checks failed: ` +
        failed.map((f) => f.name).join("; "),
    );
    err.failedChecks = failed.map((f) => f.name);
    throw err;
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

} // end runAudit()
