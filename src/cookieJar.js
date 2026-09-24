// src/cookieJar.js — RFC 6265 virtual cookie jar for the browser runtime.
//
// Sandboxed code can't touch the real browser cookie store, so virtual
// HTTP servers (src/http.js) get a per-sandbox-instance cookie jar that
// emulates browser cookie semantics: domain/path matching, Secure,
// HttpOnly, SameSite, __Secure-/__Host- prefixes, public-suffix checks,
// size limits and LRU eviction.
//
// Runtime contract (see AGENTS.md "The _RUNTIME_ contract"):
// - This module is dependency-light and loads standalone (tests, direct
//   import); it only touches `globalThis._RUNTIME_` if a caller passes a
//   runtime-derived config.
// - The runtime keeps one VirtualCookieJar per sandbox and wraps the
//   `__serverRequest__` interop handler: Cookie headers are injected from
//   the jar before dispatch, Set-Cookie responses are stored after.

import { splitCookiesString } from "set-cookie-parser";

const DEFAULTS = {
    maxNameValueBytes: 4096,
    maxAttrValueBytes: 1024,
    maxPerDomain: 180,
    maxTotal: 3000,
    maxLifetimeMs: 400 * 24 * 60 * 60 * 1000,
    defaultSameSite: "lax",
    treatLocalhostAsSecure: true,
    defaultHost: "localhost",
    // Naive: treats single-label names ("com", "localhost") as public suffixes.
    // For real accuracy: (d) => psl.get(d) === null
    isPublicSuffix: (d) => !d.includes("."),
};

const enc = new TextEncoder();
const byteLen = (s) => enc.encode(s).length;

export function cookieJarKey(instanceId, serverPort) {
    return `${instanceId}\u0000${serverPort}`;
}

const recordKey = (c) => `${c.domain}\u0000${c.path}\u0000${c.name}`;

export function canonicalHost(h) {
    return h.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");

const isLocalhost = (h) => h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h);

export function domainMatches(host, domain) {
    if (host === domain)
        return true;
    return !isIp(host) && host.endsWith("." + domain);
}

export function defaultPath(requestPath) {
    const p = requestPath.split("?")[0] || "/";
    if (!p.startsWith("/"))
        return "/";
    const i = p.lastIndexOf("/");
    return i <= 0 ? "/" : p.slice(0, i);
}

export function cookiePathMatches(requestPath, cookiePath) {
    if (cookiePath === requestPath)
        return true;
    if (requestPath.indexOf(cookiePath) === 0) {
        if (cookiePath.charAt(cookiePath.length - 1) === "/")
            return true;
        if (requestPath.charAt(cookiePath.length) === "/")
            return true;
    }
    return false;
}

const isExpired = (c, now) => c.expires !== null && c.expires <= now;

function sameSiteAllows(mode, sameSite, topLevelNav, safeMethod) {
    if (mode === "none" || sameSite)
        return true;
    if (mode === "lax")
        return topLevelNav && safeMethod;
    return false; // strict
}

export function parseSetCookie(raw, ctx, secureOrigin, cfg, now = Date.now()) {
    const fail = (reason) => ({ ok: false, reason });
    const host = canonicalHost(ctx.host);
    const parts = String(raw).split(";");
    const nv = parts.shift() ?? "";
    const eq = nv.indexOf("=");
    if (eq < 0)
        return fail("missing '=' in name-value pair");
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1).trim();
    if (!name)
        return fail("empty cookie name");
    if (byteLen(name) + byteLen(value) > cfg.maxNameValueBytes) {
        return fail(`name+value exceeds ${cfg.maxNameValueBytes} bytes`);
    }
    let pathAttr = null;
    let domainAttr = null;
    let secure = false;
    let httpOnly = false;
    let sameSiteAttr = null;
    let maxAge = null;
    let expiresAttr = null;
    for (const attr of parts) {
        const i = attr.indexOf("=");
        const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
        const val = i < 0 ? "" : attr.slice(i + 1).trim();
        if (byteLen(val) > cfg.maxAttrValueBytes)
            continue; // oversize attribute is ignored
        switch (key) {
            case "path":
                pathAttr = val.startsWith("/") ? val : null;
                break;
            case "domain":
                domainAttr = val.replace(/^\./, "").toLowerCase() || null;
                break;
            case "secure":
                secure = true;
                break;
            case "httponly":
                httpOnly = true;
                break;
            case "samesite": {
                const v = val.toLowerCase();
                // Unrecognized values fall back to the default mode
                sameSiteAttr = v === "strict" || v === "lax" || v === "none" ? v : null;
                break;
            }
            case "max-age":
                if (/^-?\d+$/.test(val)) {
                    const s = parseInt(val, 10);
                    maxAge = s <= 0 ? 0 : now + Math.min(s * 1000, cfg.maxLifetimeMs);
                }
                break;
            case "expires": {
                const t = Date.parse(val);
                if (!Number.isNaN(t))
                    expiresAttr = Math.min(t, now + cfg.maxLifetimeMs);
                break;
            }
        }
    }
    // ── Domain ────────────────────────────────────────────────
    let domain = host;
    let hostOnly = true;
    if (domainAttr) {
        if (cfg.isPublicSuffix(domainAttr)) {
            if (domainAttr !== host)
                return fail(`Domain=${domainAttr} is a public suffix`);
            // Domain equals the host itself: treated as host-only
        }
        else if (!domainMatches(host, domainAttr)) {
            return fail(`host "${host}" does not domain-match Domain=${domainAttr}`);
        }
        else {
            domain = domainAttr;
            hostOnly = false;
        }
    }
    const path = pathAttr ?? defaultPath(ctx.path ?? "/");
    // ── Secure ────────────────────────────────────────────────
    if (secure && !secureOrigin)
        return fail("Secure cookie set from an insecure origin");
    // ── SameSite ──────────────────────────────────────────────
    const sameSite = sameSiteAttr ?? cfg.defaultSameSite;
    if (sameSite === "none" && !secure)
        return fail("SameSite=None requires Secure");
    if (sameSite !== "none" && ctx.sameSite === false && !ctx.topLevelNavigation) {
        return fail(`SameSite=${sameSite} cookie set from a cross-site response`);
    }
    // ── Prefixes ──────────────────────────────────────────────
    const lname = name.toLowerCase();
    if (lname.startsWith("__secure-") && !secure)
        return fail("__Secure- prefix requires Secure");
    if (lname.startsWith("__host-") && (!secure || !hostOnly || path !== "/")) {
        return fail("__Host- prefix requires Secure, no Domain, and Path=/");
    }
    return {
        ok: true,
        cookie: {
            name, value, domain, hostOnly, path, secure, httpOnly, sameSite,
            expires: maxAge ?? expiresAttr, // Max-Age wins; null = session
            created: now,
            lastAccessed: now,
        },
    };
}

export function mergeCookieHeaders(browserCookie, jarCookie) {
    if (!jarCookie)
        return browserCookie || "";
    if (!browserCookie)
        return jarCookie;
    const seen = new Set();
    const pairs = [];
    for (const part of jarCookie.split(";")) {
        const p = part.trim();
        if (!p)
            continue;
        const eq = p.indexOf("=");
        seen.add((eq < 0 ? p : p.slice(0, eq)).trim());
        pairs.push(p);
    }
    for (const part of browserCookie.split(";")) {
        const p = part.trim();
        if (!p)
            continue;
        const eq = p.indexOf("=");
        if (seen.has((eq < 0 ? p : p.slice(0, eq)).trim()))
            continue;
        pairs.push(p);
    }
    return pairs.join("; ");
}

export class VirtualCookieJar {
    _jars = new Map();
    cfg;
    constructor(opts = {}) {
        this.cfg = { ...DEFAULTS, ...opts };
    }
    isSecureOrigin(ctx) {
        return !!ctx.secure ||
            (this.cfg.treatLocalhostAsSecure && isLocalhost(canonicalHost(ctx.host)));
    }
    /** Returns the cookies that were rejected, with reasons. */
    store(instanceId, serverPort, setCookieValue, ctx = { host: this.cfg.defaultHost }) {
        const rejected = [];
        if (setCookieValue == null)
            return rejected;
        const list = Array.isArray(setCookieValue)
            ? setCookieValue.flatMap((v) => splitCookiesString(v))
            : splitCookiesString(setCookieValue);
        const key = cookieJarKey(instanceId, serverPort);
        let jar = this._jars.get(key);
        if (!jar) {
            jar = new Map();
            this._jars.set(key, jar);
        }
        const now = Date.now();
        const secureOrigin = this.isSecureOrigin(ctx);
        for (const raw of list) {
            const res = parseSetCookie(raw, ctx, secureOrigin, this.cfg, now);
            if (!res.ok) {
                rejected.push({ raw, reason: res.reason });
                continue;
            }
            const c = res.cookie;
            const k = recordKey(c);
            if (isExpired(c, now)) {
                jar.delete(k); // Max-Age=0 / past Expires = delete
                continue;
            }
            const existing = jar.get(k);
            if (existing)
                c.created = existing.created; // overwrite keeps creation time
            jar.set(k, c);
        }
        this.enforceLimits(jar, now);
        if (jar.size === 0)
            this._jars.delete(key);
        return rejected;
    }
    enforceLimits(jar, now) {
        // 1. Expired cookies go first
        for (const [k, c] of jar)
            if (isExpired(c, now))
                jar.delete(k);
        // 2. Per-domain cap, evict least recently accessed
        const byDomain = new Map();
        for (const entry of jar) {
            const list = byDomain.get(entry[1].domain);
            if (list)
                list.push(entry);
            else
                byDomain.set(entry[1].domain, [entry]);
        }
        for (const list of byDomain.values()) {
            const excess = list.length - this.cfg.maxPerDomain;
            if (excess <= 0)
                continue;
            list.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
            for (const [k] of list.slice(0, excess))
                jar.delete(k);
        }
        // 3. Total cap
        const excess = jar.size - this.cfg.maxTotal;
        if (excess > 0) {
            const all = [...jar].sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
            for (const [k] of all.slice(0, excess))
                jar.delete(k);
        }
    }
    /** Third arg may be a plain path string (legacy) or a full RequestContext. */
    cookieHeader(instanceId, serverPort, ctxOrPath) {
        const jar = this._jars.get(cookieJarKey(instanceId, serverPort));
        if (!jar || jar.size === 0)
            return "";
        const ctx = typeof ctxOrPath === "string"
            ? { host: this.cfg.defaultHost, path: ctxOrPath }
            : ctxOrPath;
        const now = Date.now();
        const host = canonicalHost(ctx.host);
        const reqPath = (ctx.path ?? "/").split("?")[0] || "/";
        const secureCtx = this.isSecureOrigin(ctx);
        const sameSite = ctx.sameSite ?? true;
        const topLevelNav = !!ctx.topLevelNavigation;
        const safeMethod = ["GET", "HEAD", "OPTIONS", "TRACE"].includes((ctx.method ?? "GET").toUpperCase());
        const matched = [];
        for (const [k, c] of jar) {
            if (isExpired(c, now)) {
                jar.delete(k);
                continue;
            }
            if (c.hostOnly ? c.domain !== host : !domainMatches(host, c.domain))
                continue;
            if (!cookiePathMatches(reqPath, c.path))
                continue;
            if (c.secure && !secureCtx)
                continue;
            if (ctx.script && c.httpOnly)
                continue;
            if (!sameSiteAllows(c.sameSite, sameSite, topLevelNav, safeMethod))
                continue;
            matched.push(c);
        }
        // RFC 6265: longer paths first, then earlier creation time first
        matched.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
        for (const c of matched)
            c.lastAccessed = now;
        return matched.map((c) => `${c.name}=${c.value}`).join("; ");
    }
    /** Snapshot for a devtools-style cookie panel. */
    list(instanceId, serverPort) {
        const jar = this._jars.get(cookieJarKey(instanceId, serverPort));
        return jar ? [...jar.values()].map((c) => ({ ...c })) : [];
    }
    clearInstance(instanceId) {
        for (const key of [...this._jars.keys()]) {
            if (key.startsWith(instanceId + "\u0000"))
                this._jars.delete(key);
        }
    }
    clearAll() {
        this._jars.clear();
    }
}
