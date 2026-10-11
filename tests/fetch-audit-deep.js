// tests/fetch-audit-deep.js — DEEP differential fetch audit, Node reference lane.
//
// Runs ~44 observation checks against Node 24's native undici fetch and a
// local node:http server, printing a JSON report prefixed with __AUDIT__.
// The browser lane (tests/fetch-audit-deep-e2e.html) runs the SAME checks
// against native browser fetch; the CodeSandbox lane
// (tests/fetch-wrapper-e2e.html) runs the wrapper-layer checks against our
// patchedFetch + parent _fetch_ interop. Diffing the three reports is the
// audit (docs/FETCH_PLATFORM.md).
//
// Plain script, not a Jest test (jest testMatch is tests/*.test.js).
// Usage: node tests/fetch-audit-deep.js [--out /tmp/fetch-deep-node.json]

import http from "node:http";
import zlib from "node:zlib";
import { writeFileSync } from "node:fs";

const results = [];

function obs(name, fn) {
  const rec = { name };
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        (v) => {
          rec.observed = v === undefined ? null : v;
          results.push(rec);
        },
        (e) => {
          rec.observed = {
            threw: e && e.constructor ? e.constructor.name : typeof e,
            message: String((e && e.message) || e).slice(0, 200),
          };
          results.push(rec);
        },
      );
    }
    rec.observed = r === undefined ? null : r;
    results.push(rec);
    return Promise.resolve();
  } catch (e) {
    rec.observed = {
      threw: e && e.constructor ? e.constructor.name : typeof e,
      message: String((e && e.message) || e).slice(0, 200),
    };
    results.push(rec);
    return Promise.resolve();
  }
}

const J = (v) => JSON.parse(JSON.stringify(v)); // normalize

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const url = req.url.split("?")[0];
        const send = (code, headers, data) => {
          res.writeHead(code, headers);
          res.end(data);
        };
        if (url === "/echo") {
          send(
            200,
            { "content-type": "application/json" },
            JSON.stringify({
              method: req.method,
              url: req.url,
              headers: req.headers,
              body: body.toString(),
            }),
          );
        } else if (url === "/redirect") {
          send(302, { location: "/done", "x-mark": "yes" }, "");
        } else if (url === "/done") {
          send(200, { "content-type": "text/plain" }, "final");
        } else if (url === "/cookies") {
          res.writeHead(200, {
            "content-type": "text/plain",
            "set-cookie": ["k1=v1; Path=/", "k2=v2; Path=/"],
          });
          res.end("ck");
        } else if (url === "/slow") {
          setTimeout(
            () => send(200, { "content-type": "text/plain" }, "slow-done"),
            5000,
          );
        } else if (url === "/gzip") {
          send(
            200,
            { "content-type": "text/plain", "content-encoding": "gzip" },
            zlib.gzipSync("gzip-ok"),
          );
        } else if (url === "/form") {
          // Echo the raw multipart body; the check validates structure client-side.
          send(
            200,
            { "content-type": "application/json" },
            JSON.stringify({
              raw: body.toString("latin1"),
              contentType: req.headers["content-type"] || null,
            }),
          );
        } else if (url === "/empty204") {
          send(204, {}, "");
        } else {
          send(404, { "content-type": "text/plain" }, "nope");
        }
      });
    });
    srv.listen(0, "127.0.0.1", () =>
      resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }),
    );
  });
}

async function main() {
  const { srv, base } = await startServer();

  // ─── Headers (local) ───
  await obs("H1 headers-has-delete", () => {
    const h = new Headers({ "X-A": "1" });
    const out = { hasXA: h.has("x-a"), hasXB: h.has("x-b") };
    h.delete("X-A");
    out.afterDelete = h.has("x-a");
    return out;
  });
  await obs("H2 headers-foreach-entries-sorted", () => {
    const h = new Headers({ "z-z": "1", "a-a": "2", "m-m": "3" });
    const keys = [];
    h.forEach((v, k) => keys.push(k + "=" + v));
    return { forEach: keys, keys: [...h.keys()], values: [...h.values()] };
  });
  await obs("H3 headers-empty-value", () => new Headers({ x: "" }).get("x"));
  await obs("H4 headers-trim", () => new Headers({ x: "  a b  " }).get("x"));
  await obs("H5 headers-undefined-value", () =>
    new Headers({ x: undefined }).get("x"),
  );
  await obs("H6 headers-manual-setcookie", () => {
    const h = new Headers();
    h.append("set-cookie", "a=1; Path=/");
    h.append("set-cookie", "b=2; Path=/");
    return { get: h.get("set-cookie"), getSetCookie: h.getSetCookie() };
  });
  await obs("H7 headers-forbidden-on-request", () => {
    const r = new Request("https://example.com/", {
      headers: {
        cookie: "sess=abc",
        host: "spoofed.example",
        connection: "close",
        "user-agent": "custom-ua/1.0",
        referer: "https://ref.example/",
        origin: "https://o.example",
        "x-keep": "yes",
      },
    });
    return {
      cookie: r.headers.get("cookie"),
      host: r.headers.get("host"),
      connection: r.headers.get("connection"),
      ua: r.headers.get("user-agent"),
      referer: r.headers.get("referer"),
      origin: r.headers.get("origin"),
      xkeep: r.headers.get("x-keep"),
    };
  });
  await obs("H8 headers-immutable-error", () => {
    Response.error().headers.set("x-test", "1");
    return "no-throw";
  });

  // ─── Response (local) ───
  await obs("R1 response-text-arraybuffer", async () => {
    const t = await new Response("hello").text();
    const ab = await new Response("hello").arrayBuffer();
    return {
      text: t,
      byteLength: ab.byteLength,
      bytes: [...new Uint8Array(ab)].join(","),
    };
  });
  await obs("R2 response-json-charset", async () => {
    const r = new Response('{"a":1}', {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    return J(await r.json());
  });
  await obs("R3 response-bodyused", async () => {
    const r = new Response("data");
    const before = r.bodyUsed;
    await r.text();
    const after = r.bodyUsed;
    let second;
    try {
      await r.text();
      second = "no-throw";
    } catch (e) {
      second = e.constructor.name;
    }
    return { before, after, second };
  });
  await obs("R4 response-clone", async () => {
    const r = new Response("clone-me");
    const c = r.clone();
    return { a: await r.text(), b: await c.text() };
  });
  await obs("R5 response-tee", async () => {
    const r = new Response("tee-body");
    const [a, b] = r.body.tee();
    const ra = await new Response(a).text();
    const rb = await new Response(b).text();
    return { ra, rb };
  });
  await obs("R6 response-204-with-body", () => {
    new Response("x", { status: 204 });
    return "no-throw";
  });
  await obs("R7 response-redirect-bad-status", () => {
    Response.redirect("https://example.com/", 200);
    return "no-throw";
  });
  await obs("R8 response-redirect-default-302", () => {
    const r = Response.redirect("https://example.com/");
    return { status: r.status, location: r.headers.get("location") };
  });
  await obs("R9 response-statustext-default", () => ({
    s404: new Response(null, { status: 404 }).statusText,
    s200: new Response(null).statusText,
  }));
  await obs("R10 response-urlsearchparams-body", async () => {
    const p = new URLSearchParams({ a: "1", b: "2" });
    const r = new Response(p);
    return { ct: r.headers.get("content-type"), text: await r.text() };
  });
  await obs("R11 response-formdata-body", async () => {
    const fd = new FormData();
    fd.append("f1", "v1");
    fd.append("file", new Blob(["blobdata"], { type: "text/plain" }), "f.txt");
    const r = new Response(fd);
    const ct = r.headers.get("content-type");
    const back = await r.formData();
    return {
      ctHasMultipart: (ct || "").startsWith("multipart/form-data"),
      ctHasBoundary: (ct || "").includes("boundary="),
      f1: back.get("f1"),
      fileName: back.get("file").name,
      fileText: await back.get("file").text(),
    };
  });
  await obs("R12 response-blob-body", async () => {
    const r = new Response(
      new Blob(["blobbytes"], { type: "application/octet-stream" }),
    );
    return { ct: r.headers.get("content-type"), text: await r.text() };
  });
  await obs("R13 response-stream-body", async () => {
    const s = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("chunk1"));
        c.enqueue(new TextEncoder().encode("chunk2"));
        c.close();
      },
    });
    const r = new Response(s);
    return {
      text: await r.text(),
      bodyIsStream: r.body instanceof ReadableStream,
    };
  });
  await obs("R14 response-clone-after-used", async () => {
    const r = new Response("x");
    await r.text();
    r.clone();
    return "no-throw";
  });

  // ─── Request (local) ───
  await obs("Q1 request-method-normalize", () => ({
    get: new Request("https://example.com/", { method: "get" }).method,
    del: new Request("https://example.com/", { method: "delete" }).method,
    chicken: new Request("https://example.com/", { method: "CHICKEN" }).method,
    def: new Request("https://example.com/").method,
  }));
  await obs("Q2 request-forbidden-method", () => {
    new Request("https://example.com/", { method: "CONNECT" });
    return "no-throw";
  });
  await obs("Q3 request-stream-no-duplex", () => {
    const s = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("x"));
        c.close();
      },
    });
    new Request("https://example.com/", { method: "POST", body: s });
    return "no-throw";
  });
  await obs("Q4 request-stream-duplex-half", async () => {
    const s = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("chunk1"));
        c.enqueue(new TextEncoder().encode("chunk2"));
        c.close();
      },
    });
    const r = new Request("https://example.com/", {
      method: "POST",
      body: s,
      duplex: "half",
    });
    return { text: await r.text(), hasBody: r.body instanceof ReadableStream };
  });
  await obs("Q5 request-clone-body", async () => {
    const r = new Request("https://example.com/", {
      method: "POST",
      body: "clone-body",
    });
    const c = r.clone();
    return { a: await r.text(), b: await c.text() };
  });
  await obs("Q6 request-clone-after-used", async () => {
    const r = new Request("https://example.com/", {
      method: "POST",
      body: "x",
    });
    await r.text();
    r.clone();
    return "no-throw";
  });
  await obs("Q7 request-from-request", () => {
    const a = new Request("https://example.com/a", {
      method: "POST",
      headers: { "x-h": "1" },
      body: "b",
    });
    const b = new Request(a);
    return { method: b.method, url: b.url, xh: b.headers.get("x-h") };
  });
  await obs("Q8 request-only-if-cached", () => {
    new Request("https://example.com/", { cache: "only-if-cached" });
    return "no-throw";
  });
  await obs("Q9 request-mode-navigate", () => {
    new Request("https://example.com/", { mode: "navigate" });
    return "no-throw";
  });
  await obs("Q10 request-defaults", () => {
    const r = new Request("https://example.com/");
    return {
      referrer: r.referrer,
      credentials: r.credentials,
      redirect: r.redirect,
      cache: r.cache,
      mode: r.mode,
      integrity: r.integrity,
      keepalive: r.keepalive,
      destination: r.destination,
      referrerPolicy: r.referrerPolicy,
    };
  });

  // ─── fetch (network) ───
  await obs("F1 fetch-data-url", async () => {
    const r = await fetch("data:text/plain,hello");
    return { status: r.status, body: await r.text(), type: r.type };
  });
  await obs("F2 fetch-redirect-follow", async () => {
    const r = await fetch(`${base}/redirect`);
    return {
      status: r.status,
      body: await r.text(),
      redirected: r.redirected,
      urlEndsDone: r.url.endsWith("/done"),
      type: r.type,
    };
  });
  await obs("F3 fetch-redirect-manual", async () => {
    const r = await fetch(`${base}/redirect`, { redirect: "manual" });
    return {
      status: r.status,
      type: r.type,
      location: r.headers.get("location"),
      xmark: r.headers.get("x-mark"),
      ok: r.ok,
    };
  });
  await obs("F4 fetch-redirect-error", async () => {
    await fetch(`${base}/redirect`, { redirect: "error" });
    return "no-throw";
  });
  await obs("F5 fetch-echo-headers", async () => {
    const r = await fetch(`${base}/echo`, {
      headers: {
        cookie: "sess=abc",
        "user-agent": "custom-ua/1.0",
        referer: "https://ref.example/",
        origin: "https://o.example",
        connection: "close",
        "x-keep": "yes",
      },
    });
    const j = await r.json();
    const h = j.headers;
    return {
      cookie: h.cookie || null,
      ua: h["user-agent"] || null,
      referer: h.referer || null,
      origin: h.origin || null,
      connection: h.connection || null,
      host: h.host || null,
      xkeep: h["x-keep"] || null,
    };
  });
  await obs("F6 fetch-post-json", async () => {
    const r = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const j = await r.json();
    return { method: j.method, body: j.body, ct: j.headers["content-type"] };
  });
  await obs("F7 fetch-formdata", async () => {
    const fd = new FormData();
    fd.append("name", "patch");
    fd.append("file", new Blob(["filebytes"], { type: "text/plain" }), "f.txt");
    const r = await fetch(`${base}/form`, { method: "POST", body: fd });
    const j = await r.json();
    return {
      ctMultipart: (j.contentType || "").startsWith("multipart/form-data"),
      ctHasBoundary: (j.contentType || "").includes("boundary="),
      hasNameField: j.raw.includes('name="name"') && j.raw.includes("patch"),
      hasFileField:
        j.raw.includes('name="file"') &&
        j.raw.includes('filename="f.txt"') &&
        j.raw.includes("filebytes"),
    };
  });
  await obs("F8 fetch-gzip", async () => {
    const r = await fetch(`${base}/gzip`);
    return {
      status: r.status,
      body: await r.text(),
      contentEncoding: r.headers.get("content-encoding"),
    };
  });
  await obs("F9 fetch-setcookie", async () => {
    const r = await fetch(`${base}/cookies`);
    return {
      get: r.headers.get("set-cookie"),
      getSetCookie: r.headers.getSetCookie(),
      body: await r.text(),
    };
  });
  await obs("F10 fetch-abort", async () => {
    const c = new AbortController();
    const p = fetch(`${base}/slow`, { signal: c.signal });
    const t0 = Date.now();
    setTimeout(() => c.abort(), 200);
    try {
      await p;
      return { result: "no-throw", ms: Date.now() - t0 };
    } catch (e) {
      return { threw: e.constructor.name, name: e.name, ms: Date.now() - t0 };
    }
  });
  await obs("F11 fetch-abort-already-aborted", async () => {
    const c = new AbortController();
    c.abort();
    try {
      await fetch(`${base}/slow`, { signal: c.signal });
      return "no-throw";
    } catch (e) {
      return { threw: e.constructor.name, name: e.name };
    }
  });
  await obs("F12 fetch-404", async () => {
    const r = await fetch(`${base}/missing`);
    return { status: r.status, ok: r.ok, body: await r.text() };
  });
  await obs("F13 fetch-head", async () => {
    const r = await fetch(`${base}/echo`, { method: "HEAD" });
    return { status: r.status, body: await r.text() };
  });
  await obs("F14 fetch-request-object", async () => {
    const req = new Request(`${base}/echo`, {
      method: "POST",
      headers: { "x-via": "request-obj" },
      body: "req-body",
    });
    const r = await fetch(req);
    const j = await r.json();
    return { method: j.method, body: j.body, xvia: j.headers["x-via"] };
  });

  srv.close();
  const report = {
    lane: "node-undici",
    node: process.version,
    total: results.length,
    results,
  };
  const json = "__AUDIT__" + JSON.stringify(report);
  console.log(json);
  const out = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : null;
  if (out) writeFileSync(out, JSON.stringify(report, null, 1));
}

main().catch((e) => {
  console.error("AUDIT HARNESS FAILURE:", e);
  process.exit(2);
});
