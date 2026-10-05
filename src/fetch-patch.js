// src/fetch-patch.js — minimal fetch platform patches for the sandbox.
//
// Audit: docs/FETCH_PLATFORM.md (2026-10-04).
//
// The iframe realm has full parity with Node 20 undici for Headers/Response/
// Request constructors (18/18 differential checks green). This file contains
// ONLY the defensive polyfill for `Headers.prototype.getSetCookie` on browsers
// that lack it (it exists natively in Firefox 130+, Chrome 130+, Safari 18.4+).
//
// What this does NOT do (platform limits, documented not patched):
// - It cannot expose `set-cookie` response headers from real fetch() calls.
//   Browsers filter `set-cookie` as a forbidden response header before JS
//   ever sees it. The polyfill returns [] in that case — honest, not useful.
//   See docs/FETCH_PLATFORM.md §1.
//
// Usage: import "./fetch-patch.js" at sandbox bootstrap (or via
// RUNTIME_NODE_GLOBALS). Idempotent — safe to import multiple times.

const G = typeof globalThis !== "undefined" ? globalThis : undefined;

function installGetSetCookiePolyfill() {
  if (!G || typeof G.Headers === "undefined") return;
  const proto = G.Headers.prototype;
  if (!proto || typeof proto.getSetCookie === "function") return; // native exists

  // Defensive polyfill for browsers without native getSetCookie.
  // For manually-constructed Headers with set-cookie, parse the combined
  // value. For network responses, get('set-cookie') returns null (filtered),
  // so we honestly return [].
  Object.defineProperty(proto, "getSetCookie", {
    value: function getSetCookie() {
      const combined = this.get("set-cookie");
      if (combined === null || combined === undefined) return [];
      // If the browser gave us a combined string (manual construction only;
      // network responses are filtered), split on commas. Note: this is
      // best-effort — expires dates contain commas (e.g. "Wed, 21 Oct 2015").
      // We split conservatively: only on ", " followed by a token containing "=".
      // If unsure, return the whole string as a single entry rather than
      // corrupting it.
      const parts = [];
      let current = "";
      let i = 0;
      while (i < combined.length) {
        // Look for ", " that starts a new cookie (next token has "=" before ";" or ",")
        const commaIdx = combined.indexOf(",", i);
        if (commaIdx === -1) {
          current += combined.slice(i);
          break;
        }
        const after = combined.slice(commaIdx + 1).trimStart();
        // Heuristic: new cookie if the next segment up to ";" or "," contains "="
        const segEnd = after.search(/[;,]/);
        const seg = segEnd === -1 ? after : after.slice(0, segEnd);
        if (seg.includes("=")) {
          current += combined.slice(i, commaIdx);
          parts.push(current.trim());
          current = "";
          i = commaIdx + 1;
        } else {
          current += combined.slice(i, commaIdx + 1);
          i = commaIdx + 1;
        }
      }
      if (current.trim()) parts.push(current.trim());
      return parts.filter((p) => p.length > 0);
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

installGetSetCookiePolyfill();

export { installGetSetCookiePolyfill };
