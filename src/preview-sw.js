/* src/preview-sw.js — Service Worker transport for preview routing.
 *
 * Intercepts `/__virtual__/{port}/*` and routes each request to the guest
 * HTTP server on that port, via a postMessage round-trip to a host-page
 * client. The host page (src/plugins/preview-routing.js) is the authority:
 * it parses the URL, owns the port→handler registry, and answers.
 *
 * This file is intentionally a THIN TRANSPORT with no imports (classic SW
 * script = maximum browser compat). It does not validate ports, own
 * routing state, or know about sandboxes. All policy lives host-side.
 *
 * Message protocol:
 *   SW → host:  { type: "bvm:preview-request", id, port, method,
 *                 pathname, search, headers, body }
 *   host → SW:  { type: "bvm:preview-response", id, ok, result | error }
 *
 * Serve this file at (or under) the SW scope, e.g.
 * `/__virtual__/preview-sw.js` with scope `/__virtual__/`, so no
 * `Service-Worker-Allowed` header is needed.
 */

"use strict";

var PREVIEW_REQUEST_TIMEOUT_MS = 20000;

// Coarse pre-filter: is this even shaped like a preview URL? The host
// re-parses authoritatively (parsePreviewUrl); anything invalid there
// comes back as a 400. Keep this regex in sync with the host's.
var PREVIEW_RE = /^\/__virtual__\/(\d+)(?=[\/?]|$)/;
var SELF_NAME = "preview-sw.js";

function isPreviewPath(pathname) {
  if (pathname.indexOf("/__virtual__/") !== 0) return false;
  // Never intercept our own script (update checks must reach the server).
  if (pathname.slice(-SELF_NAME.length) === SELF_NAME) return false;
  return PREVIEW_RE.test(pathname);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Transport-level error page. The canonical builder is
// buildPreviewErrorHtml in src/plugins/preview-routing.js (unit-tested);
// this local copy only covers failures where the host never answered, so
// the two can never meaningfully drift.
function errorPage(status, message, port) {
  var hint = port
    ? "<p>No guest server answered on port " +
      port +
      ". Start one in the sandbox, e.g. <code>http.createServer((req, res) =&gt; res.end(\"hi\")).listen(" +
      port +
      ")</code>.</p>"
    : "";
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<title>Preview error " +
    status +
    "</title></head>" +
    '<body style="font-family:system-ui,sans-serif;max-width:60ch;margin:4rem auto;padding:0 1rem">' +
    "<h1>Preview error " +
    status +
    "</h1><p>" +
    escapeHtml(message) +
    "</p>" +
    hint +
    "</body></html>"
  );
}

function errorResponse(status, message, port) {
  return new Response(errorPage(status, message, port), {
    status: status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function makeId() {
  return (
    "pr_" + Math.random().toString(36).slice(2) + Date.now().toString(36)
  );
}

// Ask every window client; the one with the preview bridge answers.
// First matching reply wins. Resolves { ok, result|error } — never rejects,
// so the fetch handler can never hang: worst case is a 504 page.
function askHost(message, transfer) {
  return self.clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then(function (clients) {
      if (!clients.length) {
        return {
          ok: false,
          error: {
            code: "NO_CLIENT",
            message: "Preview router has no client page to answer",
          },
        };
      }
      return new Promise(function (resolve) {
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          self.removeEventListener("message", onMessage);
          resolve({
            ok: false,
            error: {
              code: "TIMEOUT",
              message: "Preview request timed out waiting for the host page",
            },
          });
        }, PREVIEW_REQUEST_TIMEOUT_MS);
        function onMessage(event) {
          var d = event.data;
          if (
            !d ||
            d.type !== "bvm:preview-response" ||
            d.id !== message.id ||
            done
          ) {
            return;
          }
          done = true;
          clearTimeout(timer);
          self.removeEventListener("message", onMessage);
          resolve(d);
        }
        self.addEventListener("message", onMessage);
        clients.forEach(function (c) {
          try {
            c.postMessage(message, transfer);
          } catch (e) {
            /* client went away; others may answer */
          }
        });
      });
    });
}

function handlePreview(event) {
  var url = new URL(event.request.url);
  var m = PREVIEW_RE.exec(url.pathname);
  var port = m ? Number(m[1]) : null;
  var req = event.request;

  var bodyPromise =
    req.method === "GET" || req.method === "HEAD"
      ? Promise.resolve(null)
      : req.arrayBuffer().catch(function () {
          return null;
        });

  return bodyPromise.then(function (body) {
    var headers = {};
    req.headers.forEach(function (v, k) {
      headers[k] = v;
    });
    var id = makeId();
    var msg = {
      type: "bvm:preview-request",
      id: id,
      port: port,
      method: req.method,
      pathname: url.pathname,
      search: url.search,
      headers: headers,
      body: body,
    };
    var transfer = body && body.byteLength ? [body] : [];
    return askHost(msg, transfer).then(function (reply) {
      if (!reply.ok) {
        var err = reply.error || {};
        var status =
          err.code === "NO_ROUTE" || err.code === "NO_CLIENT" ? 502 : 500;
        if (err.code === "TIMEOUT") status = 504;
        if (err.code === "BAD_URL") status = 400;
        return errorResponse(status, err.message || "Preview failed", port);
      }
      var r = reply.result || {};
      return new Response(r.body || null, {
        status: r.statusCode || 200,
        statusText: r.statusMessage || "",
        headers: r.headers || {},
      });
    });
  });
}

self.addEventListener("install", function (event) {
  // Activate immediately: the test/host page registers us and then opens
  // preview iframes without reloading.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function (event) {
  var url;
  try {
    url = new URL(event.request.url);
  } catch (e) {
    return;
  }
  if (!isPreviewPath(url.pathname)) return;
  event.respondWith(handlePreview(event));
});
