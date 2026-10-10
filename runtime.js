import * as acorn from "https://esm.sh/acorn";
import { importAssertions } from "https://esm.sh/acorn-import-assertions";
import { v4 as uuid } from "https://esm.sh/uuid";
import { SANDBOX_TEMPLATE } from "./src/sandbox-template.js";
import { LOG_TOKENS } from "./src/sandbox/log-tokens.js";
// Vendor browser/WASM builds for native-only packages (real Vite 7:
// rollup → @rollup/browser, esbuild → esbuild-wasm shim). Used by the
// parent '_dynamic_import' handler so ESM 'import 'rollup'' resolves
// exactly like CJS require('rollup') (src/module.js). Ungated lookup: the
// handler only runs when serving the browser runtime's VFS.
import { lookupNativeInterception } from "./src/plugins/vite-browser.js";

/**
 * Sync gate for Vite browser interception (Jared 2026-10-04): the
 * native→browser/WASM substitution table only applies when the host has
 * opted in via registerPlugin(viteBrowserPlugin).
 */
function isViteBrowserInterceptionActive() {
  const plugins = getPlugins();
  for (const p of plugins) {
    if (p && p.name === "vite-browser") return true;
  }
  return false;
}
// Plugin API (src/plugins.js): transform hooks wired into the parent-side
// _build_file interop handler below. The TypeScript plugin ships registered
// by default so .ts/.tsx modules work out of the box; hosts can
// unregisterPlugin("typescript") or register their own. Plugin transforms
// run at the TOP of _build_file, before detectModuleSystem, so TS->JS
// output flows through the existing CJS/ESM detection unchanged.
import {
  applyTransformPlugins,
  applyResolvePlugins,
  applyLoadPlugins,
  dispatchLoader,
  registerPlugin,
  validatePlugin,
  getPlugins,
} from "./src/plugins.js";
import { typescriptPlugin } from "./src/plugins/typescript.js";
import { jsonPlugin } from "./src/plugins/json.js";

registerPlugin(typescriptPlugin);
// The JSON plugin is built-in (builtIn:true → lowest priority): it proves
// the Part B hooks cover what used to be hardcoded, and any user plugin
// registered later for /\.json$/ wins over it.
registerPlugin(jsonPlugin);
/**
 * Inlined IIFE bundle of src/cookieJar.js (RFC 6265 virtual cookie jar).
 * The sandbox cannot fetch dist files at runtime without a network round
 * trip, so the jar ships inside the generated sandbox code instead.
 * Regenerate: node src/build-sandbox.mjs (buildCookieIife) or:
 *   esbuild src/sandbox/cookie-entry.js --bundle --format=iife --minify
 *     --platform=browser, then JSON.stringify the output.
 */
const COOKIE_JAR_IIFE =
  'globalThis.__cookieJarLib=(()=>{var N=Object.defineProperty;var U=Object.getOwnPropertyDescriptor;var G=Object.getOwnPropertyNames;var R=Object.prototype.hasOwnProperty;var J=(e,t)=>{for(var s in t)N(e,s,{get:t[s],enumerable:!0})},Q=(e,t,s,a)=>{if(t&&typeof t=="object"||typeof t=="function")for(let i of G(t))!R.call(e,i)&&i!==s&&N(e,i,{get:()=>t[i],enumerable:!(a=U(t,i))||a.enumerable});return e};var X=e=>Q(N({},"__esModule",{value:!0}),e);var ie={};J(ie,{VirtualCookieJar:()=>M,canonicalHost:()=>O,cookieJarKey:()=>w,cookiePathMatches:()=>F,defaultPath:()=>z,domainMatches:()=>E,mergeCookieHeaders:()=>ne,parseSetCookie:()=>K});var k={decodeValues:!0,map:!1,silent:!1,split:"auto"};function _(e){return typeof e!="string"||e in{}}function C(){return Object.create(null)}function V(e){return typeof e=="string"&&!!e.trim()}function $(e,t){var s=e.split(";").filter(V),a=s.shift();if(!a)return null;var i=Y(a),r=i.name,n=i.value;if(t=t?Object.assign({},k,t):k,_(r))return null;try{n=t.decodeValues?decodeURIComponent(n):n}catch(c){console.error("set-cookie-parser: failed to decode cookie value. Set options.decodeValues=false to disable decoding.",c)}var o=C();return o.name=r,o.value=n,s.forEach(function(c){var m=c.split("="),f=m.shift().trim().toLowerCase();if(!_(f)){var d=m.join("=").trim();if(f==="expires")o.expires=new Date(d);else if(f==="max-age"){var p=parseInt(d,10);Number.isNaN(p)||(o.maxAge=p)}else f==="secure"?o.secure=!0:f==="httponly"?o.httpOnly=!0:f==="samesite"?o.sameSite=d:f==="partitioned"?o.partitioned=!0:f&&(o[f]=d)}}),o}function Y(e){var t="",s="",a=e.split("=");return a.length>1?(t=a.shift(),s=a.join("=")):s=e,{name:t,value:s}}function y(e,t){if(t=t?Object.assign({},k,t):k,!e)return t.map?C():[];if(e.headers)if(typeof e.headers.getSetCookie=="function")e=e.headers.getSetCookie();else if(e.headers["set-cookie"])e=e.headers["set-cookie"];else{var s=e.headers[Object.keys(e.headers).find(function(n){return n.toLowerCase()==="set-cookie"})];!s&&e.headers.cookie&&!t.silent&&console.warn("Warning: set-cookie-parser appears to have been called on a request object. It is designed to parse Set-Cookie headers from responses, not Cookie headers from requests. Set the option {silent: true} to suppress this warning."),e=s}var a=t.split,i=Array.isArray(e);if(a==="auto"&&(a=!i),i||(e=[e]),e=e.filter(V),a&&(e=e.map(A).flat()),t.map){var r=C();return e.reduce(function(n,o){var c=$(o,t);return c&&!_(c.name)&&(n[c.name]=c),n},r)}else return e.map(function(n){return $(n,t)}).filter(Boolean)}function A(e){if(Array.isArray(e))return e;if(typeof e!="string")return[];var t=[],s=0,a,i,r,n,o;function c(){for(;s<e.length&&/\\s/.test(e.charAt(s));)s+=1;return s<e.length}function m(){return i=e.charAt(s),i!=="="&&i!==";"&&i!==","}for(;s<e.length;){for(a=s,o=!1;c();)if(i=e.charAt(s),i===","){for(r=s,s+=1,c(),n=s;s<e.length&&m();)s+=1;s<e.length&&e.charAt(s)==="="?(o=!0,s=n,t.push(e.substring(a,r)),a=s):s=r+1}else s+=1;(!o||s>=e.length)&&t.push(e.substring(a,e.length))}return t}y.parseSetCookie=y;y.parse=y;y.parseString=$;y.splitCookiesString=A;var Z={maxNameValueBytes:4096,maxAttrValueBytes:1024,maxPerDomain:180,maxTotal:3e3,maxLifetimeMs:400*24*60*60*1e3,defaultSameSite:"lax",treatLocalhostAsSecure:!0,defaultHost:"localhost",isPublicSuffix:e=>!e.includes(".")},ee=new TextEncoder,j=e=>ee.encode(e).length;function w(e,t){return`\${e}\\0\${t}`}var te=e=>`\${e.domain}\\0\${e.path}\\0\${e.name}`;function O(e){return e.trim().toLowerCase().replace(/^\\[|\\]$/g,"").replace(/\\.$/,"")}var se=e=>/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(e)||e.includes(":"),re=e=>e==="localhost"||e.endsWith(".localhost")||e==="::1"||/^127\\./.test(e);function E(e,t){return e===t?!0:!se(e)&&e.endsWith("."+t)}function z(e){let t=e.split("?")[0]||"/";if(!t.startsWith("/"))return"/";let s=t.lastIndexOf("/");return s<=0?"/":t.slice(0,s)}function F(e,t){return t===e||e.indexOf(t)===0&&(t.charAt(t.length-1)==="/"||e.charAt(t.length)==="/")}var D=(e,t)=>e.expires!==null&&e.expires<=t;function ae(e,t,s,a){return e==="none"||t?!0:e==="lax"?s&&a:!1}function K(e,t,s,a,i=Date.now()){let r=g=>({ok:!1,reason:g}),n=O(t.host),o=String(e).split(";"),c=o.shift()??"",m=c.indexOf("=");if(m<0)return r("missing \'=\' in name-value pair");let f=c.slice(0,m).trim(),d=c.slice(m+1).trim();if(!f)return r("empty cookie name");if(j(f)+j(d)>a.maxNameValueBytes)return r(`name+value exceeds \${a.maxNameValueBytes} bytes`);let p=null,u=null,l=!1,h=!1,W=null,H=null,I=null;for(let g of o){let b=g.indexOf("="),P=(b<0?g:g.slice(0,b)).trim().toLowerCase(),v=b<0?"":g.slice(b+1).trim();if(!(j(v)>a.maxAttrValueBytes))switch(P){case"path":p=v.startsWith("/")?v:null;break;case"domain":u=v.replace(/^\\./,"").toLowerCase()||null;break;case"secure":l=!0;break;case"httponly":h=!0;break;case"samesite":{let x=v.toLowerCase();W=x==="strict"||x==="lax"||x==="none"?x:null;break}case"max-age":if(/^-?\\d+$/.test(v)){let x=parseInt(v,10);H=x<=0?0:i+Math.min(x*1e3,a.maxLifetimeMs)}break;case"expires":{let x=Date.parse(v);Number.isNaN(x)||(I=Math.min(x,i+a.maxLifetimeMs));break}}}let T=n,L=!0;if(u)if(a.isPublicSuffix(u)){if(u!==n)return r(`Domain=\${u} is a public suffix`)}else if(E(n,u))T=u,L=!1;else return r(`host "\${n}" does not domain-match Domain=\${u}`);let q=p??z(t.path??"/");if(l&&!s)return r("Secure cookie set from an insecure origin");let S=W??a.defaultSameSite;if(S==="none"&&!l)return r("SameSite=None requires Secure");if(S!=="none"&&t.sameSite===!1&&!t.topLevelNavigation)return r(`SameSite=\${S} cookie set from a cross-site response`);let B=f.toLowerCase();return B.startsWith("__secure-")&&!l?r("__Secure- prefix requires Secure"):B.startsWith("__host-")&&(!l||!L||q!=="/")?r("__Host- prefix requires Secure, no Domain, and Path=/"):{ok:!0,cookie:{name:f,value:d,domain:T,hostOnly:L,path:q,secure:l,httpOnly:h,sameSite:S,expires:H??I,created:i,lastAccessed:i}}}function ne(e,t){if(!t)return e||"";if(!e)return t;let s=new Set,a=[];for(let i of t.split(";")){let r=i.trim();if(!r)continue;let n=r.indexOf("=");s.add((n<0?r:r.slice(0,n)).trim()),a.push(r)}for(let i of e.split(";")){let r=i.trim();if(!r)continue;let n=r.indexOf("=");s.has((n<0?r:r.slice(0,n)).trim())||a.push(r)}return a.join("; ")}var M=class{_jars=new Map;cfg;constructor(t={}){this.cfg={...Z,...t}}isSecureOrigin(t){return!!t.secure||this.cfg.treatLocalhostAsSecure&&re(O(t.host))}store(t,s,a,i={host:this.cfg.defaultHost}){let r=[];if(a==null)return r;let n=Array.isArray(a)?a.flatMap(d=>A(d)):A(a),o=w(t,s),c=this._jars.get(o);c||(c=new Map,this._jars.set(o,c));let m=Date.now(),f=this.isSecureOrigin(i);for(let d of n){let p=K(d,i,f,this.cfg,m);if(!p.ok){r.push({raw:d,reason:p.reason});continue}let u=p.cookie,l=te(u);if(D(u,m)){c.delete(l);continue}let h=c.get(l);h&&(u.created=h.created),c.set(l,u)}return this.enforceLimits(c,m),c.size===0&&this._jars.delete(o),r}enforceLimits(t,s){for(let[r,n]of t)D(n,s)&&t.delete(r);let a=new Map;for(let r of t){let n=a.get(r[1].domain);n?n.push(r):a.set(r[1].domain,[r])}for(let r of a.values()){let n=r.length-this.cfg.maxPerDomain;if(!(n<=0)){r.sort((o,c)=>o[1].lastAccessed-c[1].lastAccessed);for(let[o]of r.slice(0,n))t.delete(o)}}let i=t.size-this.cfg.maxTotal;if(i>0){let r=[...t].sort((n,o)=>n[1].lastAccessed-o[1].lastAccessed);for(let[n]of r.slice(0,i))t.delete(n)}}cookieHeader(t,s,a){let i=this._jars.get(w(t,s));if(!i||i.size===0)return"";let r=typeof a=="string"?{host:this.cfg.defaultHost,path:a}:a,n=Date.now(),o=O(r.host),c=(r.path??"/").split("?")[0]||"/",m=this.isSecureOrigin(r),f=r.sameSite??!0,d=!!r.topLevelNavigation,p=["GET","HEAD","OPTIONS","TRACE"].includes((r.method??"GET").toUpperCase()),u=[];for(let[l,h]of i){if(D(h,n)){i.delete(l);continue}(h.hostOnly?h.domain!==o:!E(o,h.domain))||F(c,h.path)&&(h.secure&&!m||r.script&&h.httpOnly||ae(h.sameSite,f,d,p)&&u.push(h))}u.sort((l,h)=>h.path.length-l.path.length||l.created-h.created);for(let l of u)l.lastAccessed=n;return u.map(l=>`\${l.name}=\${l.value}`).join("; ")}list(t,s){let a=this._jars.get(w(t,s));return a?[...a.values()].map(i=>({...i})):[]}clearInstance(t){for(let s of[...this._jars.keys()])s.startsWith(t+"\\0")&&this._jars.delete(s)}clearAll(){this._jars.clear()}};return X(ie);})();';
// NOTE: The full vfs.js bundle (6.8MB) is NOT imported statically.
// Built-in modules are loaded lazily on-demand via loadBuiltin() below,
// fetching only the individual dist files needed (see dist/manifest.json).
// This keeps initial load fast; modules are fetched when user code
// actually require()s or import()s them.

/**
 * Lazy loader for Node.js built-in modules.
 * Fetches individual dist files on-demand instead of the full 6.8MB bundle.
 * Results are cached; subsequent loads for the same module return instantly.
 */
const _builtinCache = new Map();
const _builtinBaseUrl =
  "https://cdn.jsdelivr.net/gh/MarketingPip/bundleVFSModules@main/dist/";
// Maps Node.js specifiers to dist filenames (mirrors dist/manifest.json)
const _builtinManifest = {
  assert: "assert.js",
  "assert/strict": "assert_strict.js",
  async_hooks: "async_hooks.js",
  buffer: "buffer.js",
  child_process: "child_process.js",
  cluster: "cluster.js",
  console: "console.js",
  constants: "constants.js",
  crypto: "crypto.js",
  dgram: "dgram.js",
  diagnostics_channel: "diagnostics_channel.js",
  dns: "dns.js",
  "dns/promises": "dns_promises.js",
  domain: "domain.js",
  events: "events.js",
  fs: "fs.js",
  "fs/promises": "fs_promises.js",
  http: "http.js",
  http2: "http2.js",
  https: "https.js",
  inspector: "inspector.js",
  module: "module.js",
  net: "net.js",
  os: "os.js",
  path: "path.js",
  "path/posix": "path.js",
  "path/win32": "path.js",
  perf_hooks: "perf_hooks.js",
  process: "process.js",
  punycode: "punycode.js",
  querystring: "querystring.js",
  readline: "readline.js",
  "readline/promises": "readline_promises.js",
  repl: "repl.js",
  stream: "stream.js",
  "stream/consumers": "stream.js",
  "stream/promises": "stream.js",
  "stream/web": "stream.js",
  string_decoder: "string_decoder.js",
  test: "test.js",
  "test/reporters": "test_reporters.js",
  timers: "timers.js",
  "timers/promises": "timers_promises.js",
  tls: "tls.js",
  trace_events: "trace.js",
  tty: "tty.js",
  url: "url.js",
  util: "util.js",
  "util/types": "util.js",
  v8: "v8.js",
  vm: "vm.js",
  wasi: "wasi.js",
  worker_threads: "worker_threads.js",
  zlib: "zlib.js",
};
const _builtinSourceCache = new Map();
async function fetchBuiltinSource(specifier) {
  let key = String(specifier).trim();
  if (key.startsWith("node:")) key = key.slice(5);
  let file = _builtinManifest[key];
  if (!file && key.includes("_"))
    file = _builtinManifest[key.split("_").join("/")];
  if (!file && key.startsWith("RUNTIME_")) file = `${key}.js`;
  if (!file) return `export default {}`;
  if (_builtinSourceCache.has(file)) return _builtinSourceCache.get(file);
  // Try local /local-repo/dist first (proof serves worktree locally),
  // fall back to CDN. This avoids CDN dependency when the worktree is served.
  const localUrl = `/local-repo/dist/${file}`;
  try {
    const localRes = await fetch(localUrl);
    if (localRes.ok) {
      const text = await localRes.text();
      _builtinSourceCache.set(file, text);
      return text;
    }
  } catch (e) {
    // Local fetch failed, fall through to CDN
  }
  const url = _builtinBaseUrl + file;
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(
      `[ERR_BUILTIN_LOAD]: failed to fetch ${url}: HTTP ${res.status}`,
    );
  const text = await res.text();
  _builtinSourceCache.set(file, text);
  return text;
}
// --- begin node: builtin normalization (gap #6) ---
// Single source of truth for "is this specifier a Node builtin, and what
// bundle-key form does the interop layer expect?". Node treats 'node:X' and
// 'X' identically for EVERY builtin; the sandbox-side loader used to
// recognize 'node:' only for the four builtins whose listed names literally
// contain 'node:' (node:sea, node:sqlite, node:test, node:test/reporters),
// so 'import('node:child_process')' fell through to the esm.sh CDN path and
// died with a 400. This normalizes the prefix generally.
//
// Returns { isNodeBuiltIn, modulePath } where modulePath is the form the
// interop '_dynamic_import' expects: 'node:' stripped, '/' -> '_',
// 'RUNTIME:' -> 'RUNTIME_' (e.g. 'node:test/reporters' -> 'test_reporters',
// 'RUNTIME:NODE_GLOBALS' -> 'RUNTIME_NODE_GLOBALS').
//
// NOTE: this function's source is inlined into generated sandbox scripts
// via 'normalizeBuiltinSpecifier.toString()', so it must stay
// self-contained (no closure references) and must not contain backticks or
// '${' (it is embedded inside outer template literals).
function normalizeBuiltinSpecifier(specifier, nodeBuiltins) {
  var modulePath = specifier;
  var bare =
    typeof specifier === "string" && specifier.indexOf("node:") === 0
      ? specifier.slice(5)
      : specifier;
  // esm.sh-style builtin paths: "/node/buffer.mjs" or "/node/buffer.js"
  // (emitted by esm.sh builds of npm packages). Strip to the bare name.
  if (typeof bare === "string") {
    var esmNodeMatch = bare.match(/^\/node\/([^\/]+?)(?:\.mjs|\.js)?$/);
    if (esmNodeMatch) bare = esmNodeMatch[1];
  }
  var listed = false;
  // Also match the underscore-normalized bundle-key form: some
  // bundlers/transforms emit 'fs_promises' for builtin 'fs/promises'.
  // Both spellings must resolve as builtins (platform fix).
  var slashForm = typeof bare === "string" ? bare.split("_").join("/") : bare;
  for (var i = 0; i < nodeBuiltins.length; i++) {
    if (
      nodeBuiltins[i] === specifier ||
      nodeBuiltins[i] === bare ||
      nodeBuiltins[i] === slashForm
    )
      listed = true;
  }
  // 'listed' covers the old 'isStrippable' cases too: the legacy
  // 'node:'-prefixed list entries (node:sea, node:sqlite, node:test,
  // node:test/reporters) match 'specifier' directly.
  var isNodeBuiltIn = listed;
  if (isNodeBuiltIn) {
    modulePath = String(bare).replace("/", "_").replace("RUNTIME:", "RUNTIME_");
  }
  return { isNodeBuiltIn: isNodeBuiltIn, modulePath: modulePath };
}
// --- end node: builtin normalization (gap #6) ---

async function loadBuiltin(specifier) {
  // Normalize: strip "node:" prefix
  let key = String(specifier).trim();
  if (key.startsWith("node:")) key = key.slice(5);

  if (_builtinCache.has(key)) return _builtinCache.get(key);

  const file = _builtinManifest[key];
  if (!file) {
    // Unknown built-in: return empty module stub
    return { default: {} };
  }

  try {
    const mod = await import(_builtinBaseUrl + file);
    _builtinCache.set(key, mod);
    return mod;
  } catch (err) {
    console.warn(`[loadBuiltin] Failed to load "${key}":`, err.message);
    const stub = { default: {} };
    _builtinCache.set(key, stub);
    return stub;
  }
}
// Expose for developers who want manual control
globalThis.loadBuiltin = loadBuiltin;
/* TODO :         
        
Fix issues like:  
const pkg = "./mathjs.js"; 
const mod = await import(${pkg});

---   

const mod = await import(``); // backticks not working

---  
 
How to handle dynamic / variables (simulate evaluation) for ImportResolver

*/

// import {table} from "https://esm.sh/gh/MarketingPip/bundleVFSModules@main/src/cli_table.js"

/**
 * toNodeKeypress - Helper for developers wiring up custom DOM input elements.
 *
 * Converts DOM keydown/paste events on an HTML element into Node.js-style
 * (sequence, key) callbacks, matching the shape of process.stdin 'keypress'
 * events. Useful when building custom input UIs (e.g. terminal emulators).
 *
 * @param {HTMLElement} element - The DOM element to attach listeners to
 * @param {Function} callback - Called as callback(sequence, key) where key
 *   is { name, ctrl, meta, shift, sequence }
 * @returns {{ stop: Function }} - Call .stop() to remove listeners
 *
 * @example
 *   toNodeKeypress(inputElement, (sequence, key) => {
 *     console.log('Key:', key.name, 'Ctrl:', key.ctrl);
 *   });
 */
export function toNodeKeypress(element, callback) {
  if (!element || typeof callback !== "function") {
    throw new Error("Element and callback function are required");
  }
  const autoComplete = element?.autocomplete;
  const keyMap = {
    ArrowUp: "\x1b[A",
    ArrowDown: "\x1b[B",
    ArrowRight: "\x1b[C",
    ArrowLeft: "\x1b[D",
    Enter: "\n",
    Backspace: "\x7f",
    Tab: "\t",
    Escape: "\x1b",
    Delete: "\x1b[3~",
    Home: "\x1b[H",
    End: "\x1b[F",
    PageUp: "\x1b[5~",
    PageDown: "\x1b[6~",
    Insert: "\x1b[2~",
  };
  element.autocomplete = "off";
  element.addEventListener("keydown", (e) => {
    // Determine sequence: mapped special key or literal
    let sequence = keyMap[e.key] || (e.key.length === 1 ? e.key : "");

    // If Ctrl + key, adjust for Node-style control characters
    if (e.ctrlKey && sequence.length === 1) {
      const charCode = sequence.toUpperCase().charCodeAt(0) - 64;
      if (charCode > 0 && charCode < 32)
        sequence = String.fromCharCode(charCode);
    }

    const key = {
      name: e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase(),
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      shift: e.shiftKey,
      sequence,
    };

    if (sequence) callback(sequence, key);

    //    e.preventDefault();

    if (key.name === "enter" && key.sequence === "\n") {
      element.value = "";
    }
  });

  element.addEventListener("paste", (e) => {
    const pastedText = e.clipboardData.getData("text");
    if (pastedText) {
      for (const ch of pastedText) {
        callback(ch, {
          name: ch,
          ctrl: false,
          meta: false,
          shift: false,
          sequence: ch,
        });
      }
    }
    //e.preventDefault();
  });

  return {
    stop: () => {
      element.autocomplete = autoComplete;
      element.replaceWith(element.cloneNode(true)); // removes listeners
    },
  };
}

/**
 * Consolidated ANSI stripper and console interceptor
 */
const stripAnsi = (string) => {
  if (typeof string !== "string") return string;

  // Fast path: ANSI codes require ESC (7-bit) or CSI (8-bit) introducer
  if (!string.includes("\u001B") && !string.includes("\u009B")) {
    return string;
  }

  // Regex pattern for OSC (hyperlinks) and CSI (colors/styles)
  const pattern = [
    "(?:\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\|\\u009C))", // OSC
    "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]", // CSI
  ].join("|");

  return string.replace(new RegExp(pattern, "g"), "");
};

function mergeProcess(user = {}, defaults = {}) {
  return Object.keys(defaults).reduce((acc, key) => {
    const userVal = user[key];
    const defaultVal = defaults[key];

    if (userVal === undefined) {
      // take default if user didn't provide
      acc[key] = defaultVal;
    } else if (Array.isArray(userVal)) {
      // arrays are overridden, not merged
      acc[key] = userVal;
    } else if (
      typeof userVal === "object" &&
      userVal !== null &&
      typeof defaultVal === "object"
    ) {
      // deep merge objects
      acc[key] = mergeProcess(userVal, defaultVal);
    } else {
      // primitives: use user value
      acc[key] = userVal;
    }

    return acc;
  }, {});
}

import _builtinModules from "https://esm.sh/builtin-modules";

export const builtinModules = [
  ..._builtinModules,
  ...[
    "_http_agent",
    "_http_client",
    "_http_common",
    "_http_incoming",
    "_http_outgoing",
    "_http_server",
    "_stream_duplex",
    "_stream_passthrough",
    "_stream_readable",
    "_stream_transform",
    "_stream_wrap",
    "_stream_writable",
    "_tls_common",
    "_tls_wrap",
    "assert",
    "assert/strict",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "dns/promises",
    "domain",
    "events",
    "fs",
    "fs/promises",
    "http",
    "http2",
    "https",
    "inspector",
    "inspector/promises",
    "module",
    "net",
    "os",
    "path",
    "path/posix",
    "path/win32",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "readline/promises",
    "repl",
    "stream",
    "stream/consumers",
    "stream/promises",
    "stream/web",
    "string_decoder",
    "sys",
    "timers",
    "timers/promises",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "util/types",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib",
    "node:sea",
    "node:sqlite",
    "node:test",
    "node:test/reporters",
  ],
];

builtinModules.push("RUNTIME:NODE_GLOBALS");

/* TODO 
- Add support for Workers etc to use 'file:///worker.js' etc. (intercept all methods that needs fs.)
- Fix util/types to match current spec
- Fix timers/promises
- Fix fs/promises (to write fs out)
- Fix Requires Under Imports
  
- Use Format Error On All Error (Persisent Errors)  

- Possible handler for dynamic imports (relative path)
*/

import * as walk from "https://esm.sh/acorn-walk";

import ts from "https://esm.sh/typescript@5.4.5";

/**
 * Transpiles a string of TypeScript code into JavaScript.
 * @param {string} tsCode - The TypeScript source code.
 * @returns {string} - The resulting JavaScript.
 */
export function transpileTypeScript(tsCode) {
  const result = ts.transpileModule(tsCode, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      jsx: ts.JsxEmit.React, // Added just in case you use JSX
      removeComments: true,
    },
  });

  return result.outputText;
}

export const customAcorn = acorn.Parser.extend(importAssertions);

//
/**
 * JavaScript Code Sandbox Library (Enhanced)
 * A robust ES6 library for safe code execution in isolated environments
 * @version 2.0.0
 */

// ============================================================================
// UTILITIES
// ============================================================================
import MagicString from "https://esm.sh/magic-string";
import {
  TraceMap,
  originalPositionFor,
} from "https://esm.sh/@jridgewell/trace-mapping";
import remapping from "https://esm.sh/@ampproject/remapping";

//import {Buffer} from "https://esm.sh/buffer"

import fs from "https://esm.sh/memfs";

// Initialize virtual filesystem structure
fs.vol.fromJSON({
  "/hello.txt": "Hello world",
  "/dir/nested.txt": "Nested file",
});

const TEXT_EXTS = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "json",
  "jsonc",
  "json5",
  "md",
  "mdx",
  "txt",
  "csv",
  "yaml",
  "yml",
  "xml",
  "svg",
  "graphql",
  "gql",
  "sh",
  "bash",
  "env",
  "toml",
  "ini",
  "conf",
]);

const BINARY_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "ico",
  "bmp",
  "wasm",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "mp3",
  "mp4",
  "wav",
  "ogg",
  "webm",
  "pdf",
  "zip",
  "gz",
  "tar",
]);

function getExt(path) {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

// ─── Serialize ────────────────────────────────────────────────────────────────
// Converts a memfs volume into a plain JSON-safe object.
// All files are stored as base64 strings — safe for JSON / eval embedding.

export function serializeVfs(fs) {
  const out = {};
  const files = fs.vol?.toJSON?.() ?? {};

  for (const path in files) {
    try {
      const data = fs.fs.readFileSync(path); // raw Buffer / Uint8Array
      out[path] = Buffer.from(data).toString("base64");
    } catch (e) {
      console.warn(`[vfs] failed to read ${path}:`, e);
    }
  }

  return out; // { '/index.js': 'abc123...', '/image.png': 'iVBORw0...' }
}

// ─── Deserialize ──────────────────────────────────────────────────────────────
// Converts the serialized object back into typed values:
//   JSON  → parsed object
//   text  → utf-8 string
//   binary → Uint8Array

export function deserializeVfs(serializedFs) {
  const out = {};

  for (const [path, b64] of Object.entries(serializedFs)) {
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const ext = getExt(path);

      if (ext === "json" || ext === "jsonc" || ext === "json5") {
        out[path] = JSON.parse(new TextDecoder().decode(bytes));
      } else if (TEXT_EXTS.has(ext)) {
        out[path] = new TextDecoder().decode(bytes);
      } else if (BINARY_EXTS.has(ext)) {
        out[path] = bytes;
      } else {
        // Unknown extension — try UTF-8, fall back to bytes if it fails
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes,
          );
          out[path] = decoded;
        } catch {
          out[path] = bytes;
        }
      }
    } catch (e) {
      console.warn(`[vfs] failed to deserialize ${path}:`, e);
    }
  }

  return out;
}

// ─── Reconstruct back into memfs ──────────────────────────────────────────────
// Takes the deserialized VFS and writes everything back into a memfs instance.

export function rehydrateVfs(deserializedFs, fs) {
  for (const [path, content] of Object.entries(deserializedFs)) {
    try {
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir) fs.mkdirSync(dir, { recursive: true });

      if (typeof content === "string") {
        fs.writeFileSync(path, content, "utf8");
      } else if (content instanceof Uint8Array) {
        fs.writeFileSync(path, content);
      } else {
        // JSON object — write as formatted string
        fs.writeFileSync(path, JSON.stringify(content, null, 2), "utf8");
      }
    } catch (e) {
      console.warn(`[vfs] failed to rehydrate ${path}:`, e);
    }
  }
}

export function convertEsmToCjs(code, options = {}) {
  const { filename = "input.js" } = options;
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
  const s = new MagicString(code, { filename });

  walk.ancestor(ast, {
    // 1. Convert import statements
    ImportDeclaration(node) {
      const source = node.source.raw;
      const specifiers = node.specifiers;

      if (specifiers.length === 0) {
        // Bare import: import 'setup.js' -> require('setup.js');
        s.overwrite(node.start, node.end, `require(${source});`);
      } else {
        const parts = specifiers.map((spec) => {
          if (
            spec.type === "ImportDefaultSpecifier" ||
            spec.type === "ImportNamespaceSpecifier"
          ) {
            return spec.local.name; // import x from 'y' || import * as x from 'y'
          } else {
            // Named import { a as b } -> { a: b }
            return spec.imported.name === spec.local.name
              ? spec.local.name
              : `${spec.imported.name}: ${spec.local.name}`;
          }
        });

        const isDestructured = specifiers.some(
          (s) => s.type === "ImportSpecifier",
        );
        const importStr = isDestructured ? `{ ${parts.join(", ")} }` : parts[0];
        s.overwrite(
          node.start,
          node.end,
          `const ${importStr} = require(${source});`,
        );
      }
    },

    // 2. Convert default export
    ExportDefaultDeclaration(node) {
      if (node.declaration.id) {
        // Named function/class: export default function foo() {} -> module.exports = foo
        s.remove(node.start, node.declaration.start);
        s.appendLeft(
          node.end,
          `\nmodule.exports = ${node.declaration.id.name};`,
        );
      } else {
        // Anonymous default: export default 42 -> module.exports = 42
        s.overwrite(node.start, node.declaration.start, "module.exports = ");
      }
    },

    // 3. Convert named exports
    ExportNamedDeclaration(node) {
      if (node.declaration) {
        // Handle variables, functions, classes
        s.remove(node.start, node.declaration.start);

        if (node.declaration.type === "VariableDeclaration") {
          node.declaration.declarations.forEach((decl) => {
            s.appendRight(
              node.end,
              `\nexports.${decl.id.name} = ${decl.id.name};`,
            );
          });
        } else if (node.declaration.id) {
          s.appendRight(
            node.end,
            `\nexports.${node.declaration.id.name} = ${node.declaration.id.name};`,
          );
        }
      } else if (node.specifiers.length) {
        // export { x, y as z };
        const parts = node.specifiers
          .map((spec) => {
            const exported = spec.exported.name;
            const local = spec.local.name;
            return `exports.${exported} = ${local};`;
          })
          .join("\n");
        s.overwrite(node.start, node.end, parts);
      } else if (node.source) {
        // export * from './file.js';
        s.overwrite(
          node.start,
          node.end,
          `Object.assign(exports, require(${node.source.raw}));`,
        );
      }
    },

    // 4. Export all (catch re-exports)
    ExportAllDeclaration(node) {
      s.overwrite(
        node.start,
        node.end,
        `Object.assign(exports, require(${node.source.raw}));`,
      );
    },
  });

  const outCode = s.toString();
  const map = s.generateMap({
    source: filename,
    hires: false, // line-level maps: hires VLQ explodes on MB-size inputs (74MB mappings for 16MB source), blocking the main thread; line-level suffices for stack traces,
    includeContent: true,
  });
  return { code: outCode, map };
}

export function convertCjsToEsm(code, options = {}) {
  const { filename = "input.js" } = options;
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  const s = new MagicString(code, { filename });

  let lastModuleExport = null;
  const exportsProps = [];
  const deadZones = [];
  const exportStars = [];
  const exportsReads = [];
  const esModuleMarkers = [];

  // Pass 1: detect module.exports, exports.*, and __exportStar
  walk.ancestor(ast, {
    AssignmentExpression(node, ancestors) {
      const isTopLevel = !ancestors.some((a) =>
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ].includes(a.type),
      );
      if (!isTopLevel) return;

      const { left } = node;

      // module.exports = ...
      if (left.object?.name === "module" && left.property?.name === "exports") {
        if (lastModuleExport) {
          // previous module.exports is dead
          deadZones.push({
            start: lastModuleExport.start,
            end: lastModuleExport.end,
          });
        }
        lastModuleExport = node;
      }
      // exports.prop = ...
      else if (left.object?.name === "exports") {
        const propName = left.property?.name;
        // TypeScript placeholder: 'exports.X = void 0;' emitted before the
        // real definition. Removed below when a later assignment exists.
        const isVoid0 =
          node.right.type === "UnaryExpression" &&
          node.right.operator === "void" &&
          node.right.argument.type === "Literal" &&
          node.right.argument.value === 0;
        // Self-reference: 'exports.X = X;' re-exports a local binding.
        const isSelfRef =
          node.right.type === "Identifier" && node.right.name === propName;
        exportsProps.push({ node, name: propName, isVoid0, isSelfRef });
      }
    },
    // TypeScript 'export *' in CJS: __exportStar(require("x"), exports).
    // Rewritten to ESM 'export * from "x"' below; the downstream
    // transformImportsToLoadModule lifts it through loadModule().
    CallExpression(node, ancestors) {
      const isTopLevel = !ancestors.some((a) =>
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ].includes(a.type),
      );
      if (!isTopLevel) return;
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "__exportStar" &&
        node.arguments.length === 2 &&
        node.arguments[0].type === "CallExpression" &&
        node.arguments[0].callee.type === "Identifier" &&
        node.arguments[0].callee.name === "require" &&
        node.arguments[0].arguments.length === 1 &&
        node.arguments[0].arguments[0].type === "Literal" &&
        typeof node.arguments[0].arguments[0].value === "string" &&
        node.arguments[1].type === "Identifier" &&
        node.arguments[1].name === "exports"
      ) {
        exportStars.push({
          node,
          path: node.arguments[0].arguments[0].value,
        });
      }
      // TypeScript's __esModule marker: Object.defineProperty(exports,
      // "__esModule", { value: true }). Meaningless in ESM; drop it.
      if (
        node.callee.type === "MemberExpression" &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Object" &&
        node.callee.property.type === "Identifier" &&
        node.callee.property.name === "defineProperty" &&
        node.arguments.length >= 2 &&
        node.arguments[0].type === "Identifier" &&
        node.arguments[0].name === "exports" &&
        node.arguments[1].type === "Literal" &&
        node.arguments[1].value === "__esModule"
      ) {
        // ancestors includes the node itself as the last element.
        const stmt = ancestors[ancestors.length - 2];
        if (stmt && stmt.type === "ExpressionStatement") {
          esModuleMarkers.push(stmt);
        }
      }
    },
    // Reads of the CJS exports object: 'exports.X' (not an assignment
    // target). In the ESM output there is no 'exports' binding, so rewrite
    // to the local/exported binding 'X' (or 'undefined' when X is not a
    // known export, matching CJS read-before-assign semantics). Skipped when
    // 'exports' is shadowed (e.g. the __exportStar helper's parameter).
    MemberExpression(node, ancestors) {
      if (
        node.object.type !== "Identifier" ||
        node.object.name !== "exports" ||
        node.computed ||
        node.property.type !== "Identifier"
      ) {
        return;
      }
      // ancestors includes the node itself as the last element; the parent
      // is second-to-last.
      const parent = ancestors[ancestors.length - 2];
      if (parent.type === "AssignmentExpression" && parent.left === node) {
        return;
      }
      const shadowed = ancestors.some(
        (a) =>
          (a.type === "FunctionDeclaration" ||
            a.type === "FunctionExpression" ||
            a.type === "ArrowFunctionExpression") &&
          a.params.some((p) => p.type === "Identifier" && p.name === "exports"),
      );
      if (shadowed) return;
      exportsReads.push({ node, name: node.property.name });
    },
  });

  // Pass 2: remove dead module.exports
  deadZones.forEach((zone) => {
    s.remove(zone.start, zone.end + (code[zone.end] === ";" ? 1 : 0));
  });

  // Remove exports.* only if there’s a module.exports assignment (module.exports wins)
  if (lastModuleExport) {
    exportsProps.forEach((exp) => {
      s.remove(
        exp.node.start,
        exp.node.end + (code[exp.node.end] === ";" ? 1 : 0),
      );
    });
  }

  // Pass 3: transform the last module.exports to default
  const declared = new Set();
  if (lastModuleExport) {
    s.overwrite(
      lastModuleExport.start,
      lastModuleExport.right.start,
      "export default ",
    );
  }
  // Otherwise, transform exports.* to named exports
  else {
    // Group by export name to handle TypeScript's multi-assignment patterns:
    // 'exports.X = void 0' (placeholder) and 'exports.X = X' (local re-export).
    const byName = new Map();
    for (const exp of exportsProps) {
      if (!byName.has(exp.name)) byName.set(exp.name, []);
      byName.get(exp.name).push(exp);
    }
    const removeNode = (node) => {
      s.remove(node.start, node.end + (code[node.end] === ";" ? 1 : 0));
    };
    for (const [, props] of byName) {
      const realProps = props.filter((p) => !p.isVoid0);
      // Drop void-0 placeholders when a real assignment follows.
      if (realProps.length > 0) {
        for (const p of props) {
          if (p.isVoid0) removeNode(p.node);
        }
      }
      const effective = realProps.length > 0 ? realProps : props;
      for (const exp of effective) {
        if (exp.isSelfRef) {
          if (declared.has(exp.name)) {
            // Already exported; 'exports.X = X' is a no-op.
            removeNode(exp.node);
          } else {
            // Re-export the local binding X.
            s.overwrite(
              exp.node.start,
              exp.node.end,
              `export { ${exp.name} };`,
            );
            declared.add(exp.name);
          }
        } else if (!declared.has(exp.name)) {
          s.overwrite(
            exp.node.start,
            exp.node.right.start,
            `export const ${exp.name} = `,
          );
          declared.add(exp.name);
        } else {
          // Reassignment of an already-exported binding (live binding update).
          s.overwrite(exp.node.start, exp.node.right.start, `${exp.name} = `);
        }
      }
    }
  }

  // Pass 3b: rewrite 'exports.X' reads (no 'exports' binding in ESM).
  // X → the exported/local binding when known, else 'undefined' (CJS
  // read-before-assign / discarded-exports semantics).
  for (const read of exportsReads) {
    s.overwrite(
      read.node.start,
      read.node.end,
      declared.has(read.name) ? read.name : "undefined",
    );
  }

  // Pass 3c: drop TypeScript's __esModule marker (meaningless in ESM).
  for (const stmt of esModuleMarkers) {
    s.remove(stmt.start, stmt.end + (code[stmt.end] === ";" ? 1 : 0));
  }

  // Pass 4: __exportStar(require("x"), exports) → export * from "x".
  // The ESM star-export is resolved downstream by transformImportsToLoadModule
  // (ExportAllDeclaration) through loadModule(); buildModuleProxy re-exports
  // the lifted namespace, skipping 'default' per ESM semantics.
  for (const star of exportStars) {
    s.overwrite(
      star.node.start,
      star.node.end,
      `export * from ${JSON.stringify(star.path)};`,
    );
  }

  const outCode = s.toString();
  const map = s.generateMap({
    source: filename,
    hires: false, // line-level maps: hires VLQ explodes on MB-size inputs (74MB mappings for 16MB source), blocking the main thread; line-level suffices for stack traces,
    includeContent: true,
  });
  // Mark CJS-converted modules so the sandbox's ESM interop (buildModuleProxy)
  // can resolve named imports against module.exports — Node's cjs-module-lexer
  // parity. Without this, 'import { build } from "esbuild"' (a CJS shim)
  // throws "does not provide an export named 'build'".
  const converted = lastModuleExport !== null || exportsProps.length > 0;
  const finalCode = converted
    ? outCode + "\nexport const __bvm_cjs__ = true;\n"
    : outCode;
  return { code: finalCode, map };
}

export function convertCjsToEsm_backup(code) {
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  const s = new MagicString(code);

  let lastModuleExport = null;
  const requires = [];
  const deadZones = []; // Ranges of code that are orphaned exports

  // Pass 1: Find the "Winner" and identify orphaned exports
  walk.ancestor(ast, {
    /* CallExpression(node) {
      if (node.callee.name === 'require' && node.arguments[0]?.type === 'Literal') {
        requires.push(node);
      }
    },*/
    AssignmentExpression(node, ancestors) {
      const isTopLevel = !ancestors.some((a) =>
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ].includes(a.type),
      );
      if (!isTopLevel) return;

      const { left } = node;

      // module.exports = ...
      if (left.object?.name === "module" && left.property?.name === "exports") {
        if (lastModuleExport) {
          // The previous module.export is now dead code (orphaned)
          deadZones.push({
            start: lastModuleExport.start,
            end: lastModuleExport.end,
          });
        }
        lastModuleExport = node;
      }
      // exports.prop = ...
      else if (left.object?.name === "exports") {
        // These are orphaned if they happen before OR after a full module.exports replacement
        deadZones.push({ start: node.start, end: node.end });
      }
    },
  });

  // Pass 2: Transformation

  // 1. Convert Requires
  requires.forEach((req) => {
    // Check if it's a standalone expression statement
    s.overwrite(req.start, req.end, `import ${req.arguments[0].raw}`);
  });

  // 2. Remove all "Dead" assignments
  deadZones.forEach((zone) => {
    // We remove the whole statement (including trailing semicolon if possible)
    s.remove(zone.start, zone.end + (code[zone.end] === ";" ? 1 : 0));
  });

  // 3. Transform the "Winner"
  if (lastModuleExport) {
    s.overwrite(
      lastModuleExport.start,
      lastModuleExport.right.start,
      "export default ",
    );
  }

  return s
    .toString()
    .trim()
    .replace(/\n\s*\n/g, "\n"); // Clean up empty lines
}

function _convertCjsToEsm(code) {
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  let offset = 0;
  let newCode = code;

  // Helper to replace code fragments accurately
  function replace(start, end, replacement) {
    const adjustedStart = start + offset;
    const adjustedEnd = end + offset;
    newCode =
      newCode.slice(0, adjustedStart) +
      replacement +
      newCode.slice(adjustedEnd);
    offset += replacement.length - (end - start);
  }

  // Walk the AST
  function walk(node) {
    if (!node) return;

    if (node.type === "AssignmentExpression") {
      const { left, right } = node;

      // Pattern 1: module.exports = ...
      if (
        left.type === "MemberExpression" &&
        left.object.name === "module" &&
        left.property.name === "exports"
      ) {
        // Replace 'module.exports =' with 'export default'
        replace(node.start, right.start, "export default ");
      }

      // Pattern 2: exports.name = ...
      else if (
        left.type === "MemberExpression" &&
        left.object.name === "exports"
      ) {
        const propName = left.property.name;
        // Replace 'exports.name =' with 'export const name ='
        replace(node.start, right.start, `export const ${propName} = `);
      }
    }

    // Standard recursive walk
    for (const key in node) {
      if (node[key] && typeof node[key] === "object") {
        if (Array.isArray(node[key])) {
          node[key].forEach(walk);
        } else {
          walk(node[key]);
        }
      }
    }
  }

  walk(ast);
  return newCode;
}

function isCommonJS(code) {
  try {
    const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "module" });
    let hasCJS = false;

    // Recursive function to walk the AST
    function walk(node) {
      if (!node || hasCJS) return;

      // Check for 'require(...)'
      if (node.type === "CallExpression" && node.callee.name === "require") {
        hasCJS = true;
      }

      // Check for 'module.exports' or 'exports.foo'
      if (node.type === "AssignmentExpression") {
        const { left } = node;
        if (
          (left.object &&
            left.object.name === "module" &&
            left.property.name === "exports") ||
          left.name === "exports" ||
          (left.object && left.object.name === "exports")
        ) {
          hasCJS = true;
        }
      }

      // Traverse children
      for (const key in node) {
        if (node[key] && typeof node[key] === "object") {
          if (Array.isArray(node[key])) {
            node[key].forEach(walk);
          } else {
            walk(node[key]);
          }
        }
      }
    }

    walk(ast);
    return hasCJS;
  } catch (err) {
    console.error("Parsing failed:", err.message);
    return false;
  }
}

function detectModuleSystem(code) {
  let result = { isCJS: false, isESM: false };

  try {
    // We parse as 'module' to allow import/export statements
    const ast = acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: "module",
    });

    function walk(node, parent) {
      if (!node) return;

      // --- ESM DETECTION ---
      // Look for 'import ...' or 'export ...'
      if (
        node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportDefaultDeclaration" ||
        node.type === "ExportAllDeclaration"
      ) {
        result.isESM = true;
      }

      // --- CJS DETECTION ---
      // Check for 'require(...)'
      if (node.type === "CallExpression" && node.callee.name === "require") {
        result.isCJS = true;
      }

      // Check for 'module.exports' or 'exports'
      if (node.type === "AssignmentExpression") {
        const { left } = node;
        const isModuleExports =
          left.object?.name === "module" && left.property?.name === "exports";
        const isExports =
          left.name === "exports" || left.object?.name === "exports";

        if (isModuleExports || isExports) {
          result.isCJS = true;
        }
      }

      // Check for bare `exports` references (not just assignments), e.g.
      // TypeScript's Object.defineProperty(exports, "__esModule", ...) marker,
      // which tsc emits in every compiled file — including files with no
      // exports at all. A free `exports` identifier only occurs in CJS output.
      // Excludes property keys ({ exports: 1 }), member properties (a.exports),
      // and declared bindings (var/function/import named exports).
      if (
        node.type === "Identifier" &&
        node.name === "exports" &&
        !isExportsPropertyOrBinding(node, parent)
      ) {
        result.isCJS = true;
      }

      // Standard AST traversal
      for (const key in node) {
        const child = node[key];
        if (child && typeof child === "object") {
          if (Array.isArray(child)) {
            child.forEach((c) => walk(c, node));
          } else {
            walk(child, node);
          }
        }
      }
    }

    // True when an `exports` Identifier is a property key/member name or a
    // locally declared binding rather than the CJS free variable.
    function isExportsPropertyOrBinding(node, parent) {
      if (!parent) return false;
      if (parent.type === "Property" && parent.key === node && !parent.computed)
        return true;
      if (
        parent.type === "MemberExpression" &&
        parent.property === node &&
        !parent.computed
      )
        return true;
      if (parent.type === "VariableDeclarator" && parent.id === node)
        return true;
      if (
        (parent.type === "FunctionDeclaration" ||
          parent.type === "FunctionExpression" ||
          parent.type === "ArrowFunctionExpression") &&
        parent.params.includes(node)
      )
        return true;
      if (
        (parent.type === "FunctionDeclaration" ||
          parent.type === "FunctionExpression" ||
          parent.type === "ClassDeclaration" ||
          parent.type === "ClassExpression") &&
        parent.id === node
      )
        return true;
      if (
        (parent.type === "ImportSpecifier" ||
          parent.type === "ImportDefaultSpecifier" ||
          parent.type === "ImportNamespaceSpecifier") &&
        parent.local === node
      )
        return true;
      if (parent.type === "CatchClause" && parent.param === node) return true;
      return false;
    }

    walk(ast);
  } catch (err) {
    console.error("Syntax Error or Parsing failed:", err.message);
  }

  return result;
}
/**
 * Transforms static and dynamic module loading calls into `loadModule(...)`.
 *
 * Specifically:
 * - Rewrites `import('./path')` → `loadModule('./path')`
 * - Rewrites `require('./path')` → `loadModule('./path')`
 * - Only affects relative paths (`./` or `../`)
 *
 * @param {string} code
 *   JavaScript source code to transform.
 *
 * @returns {string}
 *   The transformed source code with matching imports replaced.
 */
import { walk as walker } from "https://esm.sh/estree-walker";

function transformRelativeModule(code) {
  const s = new MagicString(code);
  const ast = acorn.parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
  });

  walker(ast, {
    enter(node) {
      let sourceNode = null;
      let startIdx = null;
      let endIdx = null;
      let type = "";

      // 1. Match dynamic import('./path')
      if (node.type === "ImportExpression") {
        sourceNode = node.source;
        startIdx = node.start;
        endIdx = node.start + 6; // length of 'import'
        type = "import";
      }

      // 2. Match require('./path')
      else if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "require" && // Corrected from !=
        node.arguments.length === 1
      ) {
        sourceNode = node.arguments[0];
        startIdx = node.callee.start;
        endIdx = node.callee.end; // length of 'require'
        type = "require";
      }

      // 3. Transformation Logic
      if (
        sourceNode &&
        sourceNode.type === "Literal" &&
        typeof sourceNode.value === "string" &&
        type != "require"
      ) {
        const path = sourceNode.value;

        // Only transform relative paths
        if (path.startsWith("./") || path.startsWith("../")) {
          // Change the function name to loadModule
          s.overwrite(startIdx, endIdx, "loadModule");

          // Inject the type as the second argument
          // sourceNode.end is the end of the path string
          s.appendRight(sourceNode.end, `, '${type}'`);
        }
      }
    },
  });

  return s.toString();
}

/**
 * Replaces occurrences of globalThis.<variableName> in JS code
 *
 * @param {string} code - Source code
 * @param {string} variableName - Property name to match
 * @param {object} [opts]
 * @param {string} [opts.replacement] - Replacement string
 * @param {boolean} [opts.generateUnique] - Auto-generate unique replacement
 * @returns {{ code: string, replacements: number, replacement: string }}
 */
export function replaceGlobalThisVar(code, variableName, opts = {}) {
  const { replacement, generateUnique = false, filename = "input.js" } = opts;

  // Generate unique replacement if requested
  const finalReplacement =
    replacement ||
    (generateUnique
      ? `globalThis._RUNTIME_${variableName}_${Math.random()
          .toString(36)
          .slice(2)}`
      : `globalThis.${variableName}`);

  // Parse AST
  const ast = acorn.parse(code, {
    ecmaVersion: 2020,
    sourceType: "module",
    locations: true, // useful for debugging
  });

  const s = new MagicString(code, { filename });

  // Find matches and replace via MagicString (tracks source map)
  walk.simple(ast, {
    MemberExpression(node) {
      if (
        node.object.type === "Identifier" &&
        node.object.name === "globalThis" &&
        node.property.type === "Identifier" &&
        node.property.name === variableName
      ) {
        s.overwrite(node.start, node.end, finalReplacement);
      }
    },
  });

  const outCode = s.toString();
  const map = s.generateMap({
    source: filename,
    hires: false, // line-level maps: hires VLQ explodes on MB-size inputs (74MB mappings for 16MB source), blocking the main thread; line-level suffices for stack traces,
    includeContent: true,
  });
  return { code: outCode, map };
}

/**
 * Transform JS code to replace imports/requires with loadModule calls.
 * Handles static imports, dynamic imports, require(), and CJS → ESM interop.
 */
export function transformImportsToLoadModule(
  sandboxUUID,
  code,
  entryPoint = null,
  parentEntryPoint = null,
  opts = {},
) {
  const preserveRequireCalls = opts.preserveRequireCalls === true;

  const s = new MagicString(code, { filename: entryPoint || "input.js" });
  const ast = acorn.parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    ranges: true,
  });

  // --- Helper: attach parents for context ---
  function attachParents(node, parent = null) {
    if (!node || typeof node !== "object") return;
    node.parent = parent;
    for (const k in node) {
      if (["parent", "start", "end", "type"].includes(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => attachParents(c, node));
      else attachParents(v, node);
    }
  }
  attachParents(ast);

  // --- Utilities ---
  const liftedModules = new Map();
  let starSeq = 0;
  let reexpSeq = 0;
  const importBindings = [];
  const functionsToMakeAsync = new Set();
  const moduleImportType = new Map();
  // Live-binding table: imported local name -> { liftedVar, importedName }.
  // Named/default imports no longer emit `const { x } = __lm` (a snapshot);
  // instead every live reference to the local is rewritten to
  // `liftedVar.importedName` (the esbuild/rollup pattern). Namespace imports
  // keep `const ns = __lm` and are NOT in this map.
  const importBindingMap = new Map();

  // Track every range the transform overwrites/removes so the later
  // reference-rewrite pass never touches already-rewritten code (overlapping
  // MagicString edits throw).
  const editedRanges = [];
  const _overwrite = s.overwrite.bind(s);
  s.overwrite = (start, end, content, ...rest) => {
    editedRanges.push([start, end]);
    return _overwrite(start, end, content, ...rest);
  };
  const _remove = s.remove.bind(s);
  s.remove = (start, end) => {
    editedRanges.push([start, end]);
    return _remove(start, end);
  };
  const rangeIsEdited = (start, end) => {
    for (const [rs, re] of editedRanges) {
      if (start < re && end > rs) return true;
    }
    return false;
  };

  function getLiftedVar(modulePath) {
    if (!liftedModules.has(modulePath)) {
      const safeName = "__lm_" + Math.random().toString(36).slice(2, 7);
      liftedModules.set(modulePath, safeName);
    }
    return liftedModules.get(modulePath);
  }

  function registerImportBindings(node) {
    // Record local -> { liftedVar, importedName } for the live-reference
    // rewrite. First import wins (a duplicate local name is invalid ESM).
    const v = getLiftedVar(node.source.value);
    for (const sp of node.specifiers) {
      if (sp.type === "ImportSpecifier") {
        if (!importBindingMap.has(sp.local.name)) {
          importBindingMap.set(sp.local.name, {
            liftedVar: v,
            importedName: sp.imported.name,
          });
        }
      } else if (sp.type === "ImportDefaultSpecifier") {
        if (!importBindingMap.has(sp.local.name)) {
          importBindingMap.set(sp.local.name, {
            liftedVar: v,
            importedName: "default",
          });
        }
      }
      // ImportNamespaceSpecifier keeps `const ns = __lm` (live via the
      // fixed proxy) — never rewritten, never registered here.
    }
  }

  function setImportType(modulePath, type) {
    const prev = moduleImportType.get(modulePath);
    if (!prev || (prev === "require" && type === "import")) {
      moduleImportType.set(modulePath, type);
    }
  }

  function interop(varName) {
    return `(${varName} && ${varName}.default !== undefined ? ${varName}.default : ${varName})`;
  }

  function findEnclosingFunction(node) {
    let n = node.parent;
    while (n) {
      if (
        [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunctionExpression",
        ].includes(n.type)
      )
        return n;
      n = n.parent;
    }
    return null;
  }

  // --- Phase 0: pre-register import bindings ---
  // An `export { x }` (no source) may textually precede the import it
  // re-exports — `export { x }; import { x } from './m'` is legal ESM
  // because imports hoist — so the live-binding table must be complete
  // before the main walk reaches the export declarations.
  for (const node of ast.body) {
    if (node.type === "ImportDeclaration") registerImportBindings(node);
  }

  // --- AST walk ---
  walk.simple(ast, {
    // Static ESM imports
    ImportDeclaration(node) {
      const modulePath = node.source.value;
      const v = getLiftedVar(modulePath);
      importBindings.push({ node, liftedVar: v });
      registerImportBindings(node);
      setImportType(modulePath, "import");
      s.remove(node.start, node.end);
    },

    // 3️⃣ import.meta
    MetaProperty(node) {
      if (node.meta.name === "import" && node.property.name === "meta") {
        // Check if import.meta is accessed via MemberExpression
        const parent = node.parent;
        // Map common import.meta properties to custom values
        const metaValues = {
          url: `file:///${entryPoint}`,
          dirname: "https://example.com/",
          resolve: "__RUNTIME_RESOLVE__HANDLE",
          // add more properties here if needed
        };

        function serializeMeta(obj) {
          const entries = [];
          for (const key in obj) {
            if (key === "resolve") {
              // Keep resolve as a function literal in the string
              entries.push(`${key}: __RUNTIME_RESOLVE__HANDLE`);
            } else {
              // Escape strings safely
              entries.push(`${key}: ${JSON.stringify(obj[key])}`);
            }
          }

          return `{ ${entries.join(", ")} }`; // returns a string
        }

        if (
          parent.type === "MemberExpression" &&
          parent.object === node &&
          parent.property.type === "Identifier"
        ) {
          const prop = parent.property.name;

          if (metaValues[prop]) {
            if (prop != "resolve") {
              s.overwrite(parent.start, parent.end, `'${metaValues[prop]}'`);
            } else {
              s.overwrite(parent.start, parent.end, `${metaValues[prop]}`);
            }
          } else {
            // unknown property — fallback to full object
            s.overwrite(parent.start, parent.end, `{ ${prop}: undefined }`);
          }
        } else {
          // Bare import.meta — replace with object
          s.overwrite(node.start, node.end, serializeMeta(metaValues));
        }
      }
    },

    ImportExpression(node) {
      if (
        node.source.type === "Literal" &&
        typeof node.source.value === "string"
      ) {
        const modulePath = node.source.value;
        // Dynamic import() is transformed in-situ only: it must NOT be
        // registered as a lifted module. The preamble
        // 'const __lm_xxx = await loadModule(...)' was dead code for dynamic
        // imports (the in-situ call below never references a lifted var) but
        // its await still ran before any user code — stalling the whole
        // module on slow loads (real vite@7: ~30 chunks through interop
        // _dynamic_import/_build_file) before the user's own drain-hold timer
        // was even registered, so execute() resolved early with no output.
        // Static ImportDeclarations keep their preamble hoist; dynamic
        // import() keeps real import() semantics (lazy, returns a promise).
        void modulePath;

        const enclosingFunc = findEnclosingFunction(node);

        // If inside non-async function → replace import with lifted variable
        /* if (enclosingFunc && !enclosingFunc.async) {
      s.overwrite(node.start, node.end, v);
      return; // stop further processing
    }*/

        // Otherwise (async function or top-level) → transform normally
        //if (enclosingFunc && enclosingFunc.async) functionsToMakeAsync.add(enclosingFunc);

        // Replace 'import' with 'loadModule'
        s.overwrite(
          node.start,
          node.start + 6,
          `globalThis._RUNTIME${sandboxUUID}_.loadModule`,
        );

        // Append loader arguments inside parentheses
        s.appendLeft(
          node.source.end,
          `, 'import', ${JSON.stringify(entryPoint)}, ${JSON.stringify(parentEntryPoint)}`,
        );
      }
    },
    _ImportExpression(node) {
      if (
        node.source.type === "Literal" &&
        typeof node.source.value === "string"
      ) {
        const modulePath = node.source.value;
        const v = getLiftedVar(modulePath);
        setImportType(modulePath, "import");

        const enclosingFunc = findEnclosingFunction(node);
        if (enclosingFunc && !enclosingFunc.async)
          functionsToMakeAsync.add(enclosingFunc);

        // Replace the 'import' keyword with 'loadModule'
        s.overwrite(
          node.start,
          node.start + 6,
          `globalThis._RUNTIME${sandboxUUID}_.loadModule`,
        );

        // Append the loader type as a second argument **inside the parentheses**
        // node.source.end points just after the string literal
        s.appendLeft(
          node.source.end,
          `, 'import', ${JSON.stringify(entryPoint)}, ${JSON.stringify(parentEntryPoint)}`,
        );
      }
    },

    // require() calls
    CallExpression(node) {
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments.length === 1
      ) {
        // When building a CommonJS module for require(), leave require()
        // calls intact: the runtime executes them synchronously via
        // __syncRequire__ inside wrapCommonJS. Rewriting them to awaited
        // loadModule() calls here would place 'await' inside the sync IIFE
        // wrapper -> SyntaxError: Unexpected reserved word.
        if (preserveRequireCalls) return;
        const arg = node.arguments[0];
        if (arg.type !== "Literal" || typeof arg.value !== "string") {
          // Dynamic require(moduleName): the specifier is not statically
          // known, so neither the top-level hoist nor the nested-builtin
          // fast path applies. Rewrite the callee to __bvmRequireSync and
          // let the runtime resolve it: a manifest builtin returns the
          // cached instance synchronously when warm, otherwise triggers the
          // async load and returns its promise; anything else throws
          // ERR_REQUIRE_ASYNC_MODULE (dynamic require of a non-builtin has
          // no sync path - use import()).
          s.overwrite(node.callee.start, node.callee.end, "__bvmRequireSync");
          return;
        }
        const modulePath = arg.value;
        // On-demand require (Worker B): top-level builtin requires keep the
        // existing hoist; builtin requires nested in a function rewrite to
        // __bvmRequireSync() so nothing loads until the function is called.
        // Nested non-builtin (relative/bare) requires keep the existing lift —
        // they have no sync path in ESM scope.
        const bareModulePath =
          typeof modulePath === "string" && modulePath.indexOf("node:") === 0
            ? modulePath.slice(5)
            : modulePath;
        const isBuiltin =
          typeof bareModulePath === "string" &&
          Object.prototype.hasOwnProperty.call(
            _builtinManifest,
            bareModulePath,
          );
        const enclosingFunc = findEnclosingFunction(node);
        if (isBuiltin && enclosingFunc !== null) {
          s.overwrite(
            node.start,
            node.end,
            "__bvmRequireSync(" + JSON.stringify(modulePath) + ")",
          );
          return;
        }
        const v = getLiftedVar(modulePath);
        setImportType(modulePath, "require");

        if (enclosingFunc && !enclosingFunc.async)
          functionsToMakeAsync.add(enclosingFunc);

        s.overwrite(node.start, node.end, interop(v));
      }
    },

    // export * from "./x" (emitted by convertCjsToEsm for __exportStar).
    // ESM 'export *' cannot target a runtime-loaded module from a data: URL,
    // so export the lifted namespace under a marker key; buildModuleProxy
    // treats __bvm_star_* as star re-export sources (skipping 'default').
    ExportAllDeclaration(node) {
      const modulePath = node.source.value;
      const v = getLiftedVar(modulePath);
      setImportType(modulePath, "import");
      const starKey = `__bvm_star_${starSeq++}`;
      s.overwrite(node.start, node.end, `export const ${starKey} = ${v};`);
    },

    // export { a, b as c } from "./x" — re-export with source.
    // Like ExportAllDeclaration, the source must be lifted via loadModule
    // because relative resolution fails from data: URLs. The re-export is
    // LIVE: instead of destructuring (a snapshot), emit a marker export
    // `__bvm_reexp_N`; buildModuleProxy collects these markers and resolves
    // each name through the (live) source namespace on every read.
    ExportNamedDeclaration(node) {
      if (!node.source) {
        // export { x } / export { x as y } without source: any specifier
        // whose local is an imported binding becomes a live re-export
        // marker; the remaining (truly local) specifiers keep a real
        // export declaration. Untouched when nothing is imported.
        const liveParts = [];
        const kept = [];
        for (const sp of node.specifiers) {
          const b = importBindingMap.get(sp.local.name);
          if (b) liveParts.push([sp.exported.name, b]);
          else kept.push(code.slice(sp.start, sp.end));
        }
        if (liveParts.length === 0) return; // leave as-is
        const marker =
          `export const __bvm_reexp_${reexpSeq++} = { ` +
          liveParts
            .map(
              ([exported, b]) =>
                `${JSON.stringify(exported)}: [${b.liftedVar}, ${JSON.stringify(b.importedName)}]`,
            )
            .join(", ") +
          ` };`;
        s.overwrite(
          node.start,
          node.end,
          kept.length === 0
            ? marker
            : `export { ${kept.join(", ")} };\n${marker}`,
        );
        return;
      }
      const modulePath = node.source.value;
      const v = getLiftedVar(modulePath);
      setImportType(modulePath, "import");
      const entries = node.specifiers.map((sp) => {
        // sp.exported is the exported name, sp.local is the imported name
        // For `export { foo } from`, exported=foo, local=foo
        // For `export { bar as baz } from`, exported=baz, local=bar
        return `${JSON.stringify(sp.exported.name)}: [${v}, ${JSON.stringify(sp.local.name)}]`;
      });
      s.overwrite(
        node.start,
        node.end,
        `export const __bvm_reexp_${reexpSeq++} = { ${entries.join(", ")} };`,
      );
    },
  });

  // --- Phase 2: rewrite references to imported bindings as live member
  // access (the esbuild/rollup pattern). Named/default imports no longer
  // destructure in the preamble, so every live reference `x` becomes
  // `__lm_N.importedName`.
  const scopeDecls = new Map(); // scope-introducing AST node -> Set(names)
  const scopeSet = (n) => {
    let st = scopeDecls.get(n);
    if (!st) {
      st = new Set();
      scopeDecls.set(n, st);
    }
    return st;
  };
  const namesOfPattern = (pat, out) => {
    if (!pat) return out;
    if (pat.type === "Identifier") {
      out.push(pat.name);
      return out;
    }
    if (pat.type === "ObjectPattern") {
      for (const pr of pat.properties) {
        if (pr.type === "Property") namesOfPattern(pr.value, out);
        else namesOfPattern(pr.argument, out); // RestElement
      }
      return out;
    }
    if (pat.type === "ArrayPattern") {
      for (const el of pat.elements) if (el) namesOfPattern(el, out);
      return out;
    }
    if (pat.type === "RestElement") {
      namesOfPattern(pat.argument, out);
      return out;
    }
    if (pat.type === "AssignmentPattern") {
      namesOfPattern(pat.left, out);
      return out;
    }
    return out;
  };
  // Single recursive pass: for every scope node record the names it binds.
  // `var` declarations hoist to the nearest function/program scope; every
  // other binding form lives in its own lexical scope.
  const buildScopes = (node, lexScope, varScope) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) buildScopes(c, lexScope, varScope);
      return;
    }
    if (!node.type) return;
    const t = node.type;
    let newLex = lexScope;
    let newVar = varScope;
    if (
      t === "Program" ||
      t === "BlockStatement" ||
      t === "StaticBlock" ||
      t === "SwitchStatement"
    ) {
      newLex = node;
      scopeSet(node);
    } else if (
      t === "FunctionDeclaration" ||
      t === "FunctionExpression" ||
      t === "ArrowFunctionExpression"
    ) {
      newLex = node;
      newVar = node;
      scopeSet(node);
      if (t === "FunctionExpression" && node.id)
        scopeSet(node).add(node.id.name);
      for (const p of node.params)
        for (const nm of namesOfPattern(p, [])) scopeSet(node).add(nm);
      // A function declaration binds its name in the ENCLOSING scope.
      if (t === "FunctionDeclaration" && node.id)
        scopeSet(lexScope).add(node.id.name);
    } else if (t === "ClassDeclaration" || t === "ClassExpression") {
      newLex = node;
      scopeSet(node);
      if (node.id) {
        scopeSet(node).add(node.id.name);
        if (t === "ClassDeclaration") scopeSet(lexScope).add(node.id.name);
      }
    } else if (t === "CatchClause") {
      newLex = node;
      scopeSet(node);
      if (node.param)
        for (const nm of namesOfPattern(node.param, [])) scopeSet(node).add(nm);
    } else if (
      t === "ForStatement" ||
      t === "ForInStatement" ||
      t === "ForOfStatement"
    ) {
      const decl = t === "ForStatement" ? node.init : node.left;
      if (
        decl &&
        decl.type === "VariableDeclaration" &&
        (decl.kind === "let" || decl.kind === "const")
      ) {
        newLex = node;
        scopeSet(node);
        for (const d of decl.declarations)
          for (const nm of namesOfPattern(d.id, [])) scopeSet(node).add(nm);
      }
    }
    if (t === "VariableDeclaration") {
      const target = node.kind === "var" ? newVar : newLex;
      for (const d of node.declarations)
        for (const nm of namesOfPattern(d.id, [])) scopeSet(target).add(nm);
    }
    for (const k of Object.keys(node)) {
      if (k === "parent") continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (const c of v) buildScopes(c, newLex, newVar);
      } else if (v && typeof v === "object" && v.type) {
        buildScopes(v, newLex, newVar);
      }
    }
  };
  buildScopes(ast, null, null);

  // Is `name` shadowed by a nearer lexical binding at this reference?
  // Import bindings live at Program (module) scope; any declaration of the
  // name in a scope between the reference and Program shadows the import.
  const isShadowed = (name, node) => {
    let n = node.parent;
    while (n && n !== ast) {
      const st = scopeDecls.get(n);
      if (st && st.has(name)) return true;
      n = n.parent;
    }
    return false;
  };

  // True when this Identifier is a binding position rather than a value
  // reference (declaration id, function param, catch param, import/export
  // specifier, ...). Climbs through binding patterns to the declaration.
  const isBindingIdentifier = (node) => {
    let n = node;
    let p = node.parent;
    while (p) {
      if (
        (p.type === "VariableDeclarator" && p.id === n) ||
        ((p.type === "FunctionDeclaration" ||
          p.type === "FunctionExpression" ||
          p.type === "ArrowFunctionExpression") &&
          (p.id === n || p.params.indexOf(n) !== -1)) ||
        ((p.type === "ClassDeclaration" || p.type === "ClassExpression") &&
          p.id === n) ||
        (p.type === "CatchClause" && p.param === n) ||
        p.type === "ImportSpecifier" ||
        p.type === "ImportDefaultSpecifier" ||
        p.type === "ImportNamespaceSpecifier" ||
        p.type === "ExportSpecifier"
      )
        return true;
      if (p.type === "Property" && p.value === n) {
        n = p;
        p = p.parent;
        continue;
      }
      if (p.type === "ObjectPattern" || p.type === "ArrayPattern") {
        n = p;
        p = p.parent;
        continue;
      }
      if (
        (p.type === "RestElement" && p.argument === n) ||
        (p.type === "AssignmentPattern" && p.left === n)
      ) {
        n = p;
        p = p.parent;
        continue;
      }
      return false;
    }
    return false;
  };

  // True when the identifier is a non-computed property key, a label, or
  // part of `import.meta` — positions that never read the binding.
  const isNonReferencePosition = (node) => {
    const p = node.parent;
    if (!p) return true;
    if (
      p.type === "MetaProperty" ||
      p.type === "LabeledStatement" ||
      ((p.type === "BreakStatement" || p.type === "ContinueStatement") &&
        p.label === node)
    )
      return true;
    if (
      (p.type === "Property" || p.type === "MethodDefinition") &&
      p.key === node &&
      !p.computed &&
      !p.shorthand
    )
      return true;
    if (p.type === "PropertyDefinition" && p.key === node && !p.computed)
      return true;
    if (
      (p.type === "MemberExpression" ||
        p.type === "OptionalMemberExpression") &&
      p.property === node &&
      !p.computed
    )
      return true;
    return false;
  };

  // True when the reference WRITES the binding (`x = 1`, `x++`,
  // `for (x of ...)`). Assignment to an import binding is invalid ESM;
  // leaving the bare identifier (a ReferenceError — no binding exists)
  // preserves the "it throws" behavior instead of silently writing the
  // proxy's snapshot copy.
  const isWriteTarget = (node) => {
    let n = node;
    let p = node.parent;
    while (p) {
      if (p.type === "AssignmentExpression" && p.left === n) return true;
      if (
        p.type === "UpdateExpression" ||
        ((p.type === "ForInStatement" || p.type === "ForOfStatement") &&
          p.left === n)
      )
        return true;
      if (p.type === "Property" && p.value === n) {
        n = p;
        p = p.parent;
        continue;
      }
      if (p.type === "ObjectPattern" || p.type === "ArrayPattern") {
        n = p;
        p = p.parent;
        continue;
      }
      if (
        (p.type === "RestElement" && p.argument === n) ||
        (p.type === "AssignmentPattern" && p.left === n)
      ) {
        n = p;
        p = p.parent;
        continue;
      }
      return false;
    }
    return false;
  };

  walk.simple(ast, {
    Identifier(node) {
      const b = importBindingMap.get(node.name);
      if (!b) return;
      if (rangeIsEdited(node.start, node.end)) return;
      if (isBindingIdentifier(node)) return;
      if (isNonReferencePosition(node)) return;
      if (isShadowed(node.name, node)) return;
      if (isWriteTarget(node)) return;
      const p = node.parent;
      let replacement = `${b.liftedVar}.${b.importedName}`;
      if (p && p.type === "Property" && p.shorthand) {
        // `{ x }` -> `{ x: __lm_N.x }` (overwriting the shared key/value
        // identifier with a member expression alone would be a syntax
        // error). Acorn models the shorthand key and value as two distinct
        // nodes over the same range: rewrite on the key (visited first by
        // the naive walker; acorn-walk visits only the value) and let the
        // range guard skip the twin.
        replacement = `${node.name}: ${replacement}`;
      } else if (
        p &&
        ((p.type === "CallExpression" && p.callee === node) ||
          (p.type === "OptionalCallExpression" && p.callee === node) ||
          (p.type === "TaggedTemplateExpression" && p.tag === node))
      ) {
        // `x()` -> `(0, __lm_N.x)()`: the indirect call keeps `this`
        // undefined, matching ESM call semantics (a plain `__lm_N.x()`
        // would bind `this` to the interop proxy).
        replacement = `(0, ${replacement})`;
      }
      s.overwrite(node.start, node.end, replacement);
      editedRanges.push([node.start, node.end]);
    },
  });

  // Make functions async if needed
  for (const funcNode of functionsToMakeAsync) {
    //s.prependLeft(funcNode.start, "async ");
  }

  // --- Build the preamble for lifted modules ---
  // Split by lift kind: `import`-type lifts (entry static imports) are
  // hoisted by execute() to %%IMPORTS%% (init scope, as the old `custom`
  // preloads were); `require`-type lifts stay atop the user code, exactly
  // where the old preamble put them (they must load after init's timer
  // patching, not before). Namespace-import consts
  // (`const ns = __lm`) ride with the import lifts. In `code` the import
  // lifts come first — matching ESM evaluation order (imports before the
  // module body, requires included).
  const importPreambleParts = [];
  const bodyPreambleParts = [];
  for (const [modulePath, v] of liftedModules.entries()) {
    const type = moduleImportType.get(modulePath) || "import";
    const line = `const ${v} = await globalThis._RUNTIME${sandboxUUID}_.loadModule(${JSON.stringify(
      modulePath,
    )}, ${JSON.stringify(type)}, ${JSON.stringify(entryPoint)}, ${JSON.stringify(parentEntryPoint)});`;
    if (type === "import") importPreambleParts.push(line);
    else bodyPreambleParts.push(line);
  }

  for (const { node, liftedVar } of importBindings) {
    const binding = generateImportBinding(node, liftedVar);
    if (binding) importPreambleParts.push(binding);
  }

  const importPreamble = importPreambleParts.join("\n");
  const bodyPreamble =
    bodyPreambleParts.length > 0 ? bodyPreambleParts.join("\n") + "\n\n" : "";
  // `body`: require lifts + user code (what execute() runs as user code).
  const bodySrc = bodyPreamble + s.toString();
  if (importPreamble || bodyPreamble) {
    s.prepend((importPreamble ? importPreamble + "\n\n" : "") + bodyPreamble);
  }
  //console.log(preambleParts.join("\n") + "\n\n")
  const outCode = s.toString();
  const map = s.generateMap({
    source: entryPoint || "input.js",
    hires: false, // line-level maps: hires VLQ explodes on MB-size inputs (74MB mappings for 16MB source), blocking the main thread; line-level suffices for stack traces,
    includeContent: true,
  });
  // preamble/body split: execute() hoists the *import* preamble (the
  // `await loadModule(...)` lifts for static imports, plus namespace consts)
  // to the sandbox init scope (%%IMPORTS%%) and runs `body` (require lifts +
  // user code) as the user code. Both share the sandbox IIFE scope, so the
  // live member access (`__lm_N.x`) in the body resolves to the preamble's
  // lifted vars. `code` (full preamble + body) is unchanged for all
  // existing consumers.
  return {
    code: outCode,
    map,
    preamble: importPreamble,
    body: bodySrc,
  };
}

function generateImportBinding(node, liftedVar) {
  const specifiers = node.specifiers;

  if (!specifiers.length) return "";

  // Namespace imports keep a live alias: `const ns = __lm` (the proxy read
  // is live once buildModuleProxy reads from the real namespace).
  // Named/default imports emit NO binding: every reference was rewritten to
  // `liftedVar.importedName` (live member access, the esbuild/rollup
  // pattern). The old `const { x } = __lm` destructured once at import time
  // — a snapshot that killed live bindings.
  for (const s of specifiers) {
    if (s.type === "ImportNamespaceSpecifier")
      return `const ${s.local.name} = ${liftedVar};`;
  }
  return "";
}

/*
 // Import JSHint as an ES module
    import { JSHINT } from 'https://esm.sh/jshint';

    // Example JavaScript code to lint
    const code = `
      let x = 10;
      y = 20;  // undeclared variable, should raise a warning
      console.log(x + y);;
      
      await test()
    `;

    // Lint the code
    JSHINT(code, { esversion: 6,
      esversion: 6,     // Support ES6 syntax
      undef: true,      // Warn on undeclared variables
      unused: true,     // Warn on unused variables
      asi: true,        // Allow missing semicolons
      browser: true,    // Define browser environment to avoid undefined 'console'
      validthis: true,  // Allow 'this' in functions for browser compatibility
      globals: { console: true } // Explicitly allow 'console'
                 });

    // Check results
    if (JSHINT.errors.length) {
      console.log("Errors found:");
      JSHINT.errors.forEach(err => {
        if (err) {
          console.log(`Line ${err.line}, Col ${err.character}: ${err.reason}`);
        }
      });
    } else {
      console.log("No errors found!");
    }
    */

/*
// Assuming ESLint is loaded via <script src="https://cdn.jsdelivr.net/npm/eslint@8.46.0/lib/api.js"></script>

import eslintModule from 'https://esm.sh/eslint-linter-browserify';

const { Linter } = eslintModule

const code = `import { readFile } from "https://esm.sh/fs"; 
async function demo() {
  console.log("Waiting...");
  await sleep(1000); // wait 1 second
  console.log("Done!");
  console.log("Waiting...");
  await sleep(1000); // wait 1 second
  console.log("Done!");
}

await demo();`;

const linter = new Linter();

const messages = linter.verify(code, [
  {
    languageOptions: {
      ecmaVersion: 2022,    // supports top-level await, modern JS
      sourceType: "module",
      globals: {
        console: "readonly", // allow console as a global
        window: "readonly",
        //document: "readonly"
      }
    },
    rules: {
      "no-undef": "error" // catch only reference errors
    }
  }
]);

console.log(messages);



*/

// ============================================================================
// SYNTAX CHECKER MODULE
// ============================================================================

export class SyntaxChecker {
  constructor(options = {}) {
    this.ecmaVersion = options.ecmaVersion ?? "latest";
  }

  /**
   * Check JavaScript syntax using Acorn parser
   * @param {string} code - The code to validate
   * @returns {{ valid: boolean, error?: string }}
   */
  check(code) {
    try {
      acorn.parse(code, {
        sourceType: "module",
        locations: true,
        ecmaVersion: this.ecmaVersion,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: false,
      });

      return { valid: true };
    } catch (err) {
      throw err;
    }
  }
}

// NOTE: The reference-error checker (generateGlobalBuiltInsSet,
// checkForReferenceErrors, checkForReferenceErrors2, refCheck) lived here.
// It was playground-only, so it moved to src/ui/playground.js.

/**
 * A simple EventEmitter implementation for managing custom events.
 */
class EventEmitter {
  constructor() {
    /**
     * Stores event names mapped to arrays of handler functions.
     * @type {Map<string, Function[]>}
     */
    this.events = new Map();
  }

  /**
   * Registers an event handler for a given event.
   *
   * @param {string} event - The name of the event to listen for.
   * @param {(data: any) => void} handler - The callback function to execute when the event is emitted.
   * @returns {() => void} A function to unsubscribe the handler.
   */
  on(event, handler) {
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    this.events.get(event).push(handler);
    return () => this.off(event, handler);
  }

  /**
   * Removes a specific handler for a given event.
   *
   * @param {string} event - The name of the event.
   * @param {(data: any) => void} handler - The handler function to remove.
   * @returns {void}
   */
  off(event, handler) {
    const handlers = this.events.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) handlers.splice(index, 1);
    }
  }

  /**
   * Emits an event, calling all registered handlers with the provided data.
   *
   * @param {string} event - The name of the event to emit.
   * @param {any} [data] - Optional data to pass to each handler.
   * @returns {void}
   */
  emit(event, data) {
    const handlers = this.events.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data);
        } catch (err) {
          console.error(`Error in ${event} handler:`, err);
        }
      });
    }
  }
}

// ============================================================================
// IMPORT RESOLVER MODULE
// ============================================================================

export class ImportResolver {
  constructor(options = {}) {
    this.cdnBase = options.cdnBase || "https://esm.sh";
    this.transformRules = options.transformRules || [];
    this.cache = new Map();
    this.fallbackCDN = options.fallbackCDN;
  }

  resolve(code) {
    const imports = [];
    const requires = [];
    const cleaned = { imports: [], dynamicImports: [], requires: [] };
    const dynamicImports = []; // New tracker
    const replacements = [];

    const ast = customAcorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
    });

    // 1. Process Static Imports (ImportDeclaration)
    const importNodes = ast.body.filter(
      (node) => node.type === "ImportDeclaration",
    );
    for (const node of importNodes) {
      const source = node.source.value;
      const transformedSource = this._transformSource(source, "import");
      cleaned.imports.push(transformedSource);
      imports.push(
        code.slice(node.start, node.source.start) +
          `'${transformedSource}'` +
          code.slice(node.source.end, node.end),
      );
      replacements.push({ start: node.start, end: node.end, content: "" });
    }

    // 2. Process Requires and Dynamic Imports (Walking the AST)
    this._walkAST(ast, (node) => {
      // --- HANDLE REQUIRE ---
      if (
        node.type === "CallExpression" &&
        node.callee.name === "require" &&
        node.arguments[0]?.type === "Literal"
      ) {
        const source = node.arguments[0].value;
        const transformedSource = this._transformSource(source, "require");
        requires.push(`require('${transformedSource}')`);
        cleaned.requires.push(transformedSource);
        replacements.push({
          start: node.arguments[0].start,
          end: node.arguments[0].end,
          content: `'${transformedSource}'`,
        });
      }

      // --- HANDLE DYNAMIC IMPORT() ---
      if (node.type === "ImportExpression" && node.source.type === "Literal") {
        const source = node.source.value;
        const transformedSource = this._transformSource(
          source,
          "dynamic-import",
        );

        dynamicImports.push(`import('${transformedSource}')`);
        cleaned.dynamicImports.push(transformedSource);
        // Replace the string inside the import(...)
        replacements.push({
          start: node.source.start,
          end: node.source.end,
          content: `'${transformedSource}'`,
        });
      }
    });

    // 3. APPLY REPLACEMENTS
    replacements.sort((a, b) => b.start - a.start);

    let cleanedCode = code;
    for (const r of replacements) {
      cleanedCode =
        cleanedCode.slice(0, r.start) + r.content + cleanedCode.slice(r.end);
    }

    return {
      imports,
      requires,
      dynamicImports, // Added to return object
      cleanedCode: cleanedCode.trim(),
      cleanedImports: cleaned,
      hasImportsOrRequires:
        imports.length + requires.length + dynamicImports.length > 0,
    };
  }

  _walkAST(node, callback) {
    callback(node);

    for (const key in node) {
      if (!node.hasOwnProperty(key)) continue;
      const child = node[key];

      if (Array.isArray(child)) {
        child.forEach(
          (n) => n && typeof n.type === "string" && this._walkAST(n, callback),
        );
      } else if (child && typeof child.type === "string") {
        this._walkAST(child, callback);
      }
    }
  }

  _transformSource(source, kind) {
    const cacheKey = `${kind}:${source}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    let transformed = source;

    for (const rule of this.transformRules) {
      const testResult =
        typeof rule.test === "function"
          ? rule.test(transformed, kind)
          : rule.test.test(transformed);

      if (testResult) {
        transformed = rule.transform(transformed, kind);
      }
    }

    // absolute URLs pass through
    if (/^https?:\/\//.test(transformed)) {
      this.cache.set(cacheKey, transformed);
      return transformed;
    }

    if (transformed.startsWith("./") || transformed.startsWith("../")) {
      return transformed;
    }

    // Absolute VFS paths ("/...") are resolved by the sandbox loader's
    // _dynamic_import (absolute-VFS branch) — same as the parent
    // es-module-shims resolve hook — not by the CDN. (Previously they fell
    // through to `${cdnBase}//...` and 400'd, so no entry could statically
    // or dynamically import a VFS file by absolute path.)
    if (transformed.startsWith("/")) {
      this.cache.set(cacheKey, transformed);
      return transformed;
    }

    // Gap #6/#5: builtins are not CDN packages. esm.sh 400s on 'node:'-style
    // specifiers and would serve its own shim for bare names instead of our
    // dist shims. Node treats 'node:X' and 'X' identically for every builtin,
    // so pass recognized ones (prefixed or bare) through untouched — the
    // sandbox loader resolves them via the builtin interop path (the same
    // path VFS-file imports already use). Unrecognized specifiers keep the old
    // behavior (CDN fallback).
    if (typeof transformed === "string") {
      const __builtinNorm = normalizeBuiltinSpecifier(
        transformed,
        builtinModules,
      );
      if (__builtinNorm.isNodeBuiltIn) {
        this.cache.set(cacheKey, transformed);
        return transformed;
      }
    }

    // Platform interception (AGENTS.md rule 6): native-only packages
    // (rollup, esbuild, rolldown, ...) substitute the vendor's browser/WASM
    // build from the VFS — but ONLY when the vite-browser plugin is
    // registered (opt-in, Jared 2026-10-04). This MUST run before the CDN
    // fallback — otherwise entry `import "rolldown"` becomes
    // https://esm.sh/rolldown, the browser fetches esm.sh's build of the
    // NATIVE package, and its esm.sh-style `/node/*.mjs` builtin imports die
    // as absolute VFS paths in the esms resolve hook (2026-10-01:
    // `[bvm:resolve] _dynamic_import failed for file URL "/node/process.mjs"`).
    // Nested imports already go through this table via _dynamic_import; the
    // entry path was the gap.
    const intercepted = isViteBrowserInterceptionActive()
      ? lookupNativeInterception(transformed)
      : null;
    if (intercepted) {
      this.cache.set(cacheKey, intercepted);
      return intercepted;
    }

    if (!this.fallbackCDN) {
      this.cache.set(cacheKey, transformed);
      return transformed;
    }

    transformed = `${this.cdnBase}/${transformed}`;
    this.cache.set(cacheKey, transformed);
    return transformed;
  }

  addTransformRule(test, transform) {
    this.transformRules.push({ test, transform });
  }

  clearCache() {
    this.cache.clear();
  }
}

// ============================================================================
// EXECUTION CONTEXT MODULE
// ============================================================================

// VFS_FETCH_BRIDGE_START
// ── Host virtual-server fetch bridge ───────────────────────────────────────
// Patches the real parent/host 'fetch' (once) so requests to loopback URLs
// ('localhost', '127.0.0.1', '[::1]') on a port owned by a sandbox route to
// that sandbox's virtual HTTP server via 'invoke('__serverRequest__', …)'.
// One host-global registry: first claim wins, a colliding second claim is
// rejected so the host can revoke the loser. The patch is removed only after
// the final route disappears. Tested by tests/host-fetch-bridge.test.js,
// which evaluates this exact section in a vm sandbox with mocked globals.

/** port (number) -> ExecutionContext owning the active virtual server */
const _vfsServerRoutes = new Map();
/** The native fetch, captured while the patch is installed. */
let _vfsOriginalFetch = null;

function _vfsIsLoopbackHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

function _vfsExtractServerPort(data) {
  if (data && typeof data.port === "number") return data.port;
  // Sandbox posts server events via emitMe: { type, message: 'null {"port":N}' }.
  const msg = data && typeof data.message === "string" ? data.message : "";
  const m = /\{\s*"port"\s*:\s*(\d+)\s*\}/.exec(msg);
  return m ? Number(m[1]) : null;
}

function _vfsEnsureFetchPatched() {
  if (typeof window === "undefined" || typeof window.fetch !== "function")
    return false;
  if (window.fetch && window.fetch.__vfsBridged) return true;
  _vfsOriginalFetch = window.fetch;
  _vfsPatchedFetch.__vfsBridged = true;
  window.fetch = _vfsPatchedFetch;
  return true;
}

function _vfsMaybeRestoreFetch() {
  if (
    _vfsServerRoutes.size === 0 &&
    _vfsOriginalFetch &&
    typeof window !== "undefined"
  ) {
    window.fetch = _vfsOriginalFetch;
    _vfsOriginalFetch = null;
  }
}

/** Returns true when this owner holds the route (first claim wins). */
function _vfsRegisterServerRoute(port, owner) {
  if (port == null) return false;
  const existing = _vfsServerRoutes.get(port);
  if (existing === owner) return true; // idempotent re-register
  if (existing !== undefined) return false; // collision
  _vfsServerRoutes.set(port, owner);
  _vfsEnsureFetchPatched();
  return true;
}

function _vfsUnregisterServerRoute(port, owner) {
  if (port == null) return;
  if (_vfsServerRoutes.get(port) === owner) {
    _vfsServerRoutes.delete(port);
    _vfsMaybeRestoreFetch();
  }
}

async function _vfsPatchedFetch(input, init) {
  let url = null;
  try {
    const raw = typeof input === "string" ? input : input && input.url;
    url = new URL(String(raw), window.location.href);
  } catch {
    return _vfsOriginalFetch.apply(this, arguments);
  }
  if (url && _vfsIsLoopbackHostname(url.hostname)) {
    const port = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80;
    const owner = _vfsServerRoutes.get(port);
    if (owner !== undefined) {
      return _vfsDispatchToSandbox(owner, port, url, input, init);
    }
  }
  return _vfsOriginalFetch.apply(this, arguments);
}

async function _vfsDispatchToSandbox(owner, port, url, input, init) {
  const method = String(
    (init && init.method) ||
      (input && typeof input === "object" && input.method) ||
      "GET",
  ).toUpperCase();
  const headers = {};
  const absorb = (h) => {
    if (!h) return;
    if (typeof h.forEach === "function") {
      h.forEach((v, k) => {
        headers[String(k)] = String(v);
      });
    } else if (Array.isArray(h)) {
      for (const [k, v] of h) headers[String(k)] = String(v);
    } else if (typeof h === "object") {
      for (const k of Object.keys(h)) headers[k] = String(h[k]);
    }
  };
  absorb(input && typeof input === "object" ? input.headers : null);
  absorb(init && init.headers);
  let body = null;
  const rawBody =
    init && init.body !== undefined
      ? init.body
      : input && typeof input === "object"
        ? input.body
        : undefined;
  if (rawBody !== undefined && rawBody !== null) {
    if (
      typeof rawBody === "string" ||
      rawBody instanceof Uint8Array ||
      rawBody instanceof ArrayBuffer
    ) {
      body = rawBody;
    } else {
      body = String(rawBody);
    }
  }
  const path = url.pathname + url.search;
  let result;
  try {
    // __serverRequest__ treats {} as "no body" (see src/http.js handleRequest).
    result = await owner.invoke(
      "__serverRequest__",
      port,
      path,
      method,
      body === null ? {} : body,
      headers,
    );
  } catch (err) {
    // Owner died mid-flight: drop the stale route so later fetches go native.
    _vfsUnregisterServerRoute(port, owner);
    throw err;
  }
  let resBody = result && result.body;
  if (
    resBody !== undefined &&
    resBody !== null &&
    typeof resBody !== "string" &&
    !(resBody instanceof Uint8Array) &&
    !(resBody instanceof ArrayBuffer)
  ) {
    resBody = String(resBody);
  }
  return new Response(resBody == null ? "" : resBody, {
    status: (result && result.statusCode) || 200,
    statusText: (result && result.statusMessage) || "",
    headers: (result && result.headers) || {},
  });
}
// VFS_FETCH_BRIDGE_END

class ExecutionContext {
  constructor(iframe, sandbox) {
    this.iframe = iframe;
    this.sandbox = sandbox;
    this.config = sandbox.config;
    this.messageHandler = null;
    this.cleanupCallbacks = [];
    this.resolved = false;
    this.running = false;
    this.interopCallbacks = new Map();
    this.stdout = [];
    this.stderr = [];
    this.startTime = null;
    this._resolve = null;
    this._reject = null;
    this._serverRunning = false;
    this._serverPort = null;
    this._vfsPorts = new Set(); // ports this sandbox owns in the host fetch bridge
  }

  /**
   * Hard-kill the sandbox from the parent side.
   *
   * This does NOT rely on the iframe processing a message — a synchronous
   * busy-loop inside the iframe will never yield back to its event loop, so
   * postMessage alone can't interrupt it. Instead we tear down the iframe's
   * own browsing context from here (the parent, which is never blocked):
   * either detaching it from the DOM or navigating its src away. Both
   * immediately abort whatever script is running inside, no matter what
   * it's doing.
   */
  forceKill(reason = "Process killed by user") {
    if (this.resolved) return;
    this.resolved = true;
    this.running = false;
    /**
     * Custom error for process or iframe termination with explicit stack support
     */
    class ProcessKilledError extends Error {
      constructor(message = "Process was killed or terminated") {
        super(message);
        this.name = "ProcessKilledError";
        this.code = "ERR_PROCESS_KILLED";
        this.signal = "SIGKILL";

        // Explicitly capture and generate the stack trace
        if (Error.captureStackTrace) {
          Error.captureStackTrace(this, this.constructor);
        } else {
          this.stack = new Error(message).stack;
        }
      }
    }
    const executionTime =
      this.startTime != null
        ? +(performance.now() - this.startTime).toFixed(2)
        : 0;

    // Best-effort courtesy ping — helps in the *non-blocking* async case
    // (the iframe is idle/awaiting) where it can still process a message
    // and report back before we yank it. Harmless no-op if it's stuck.
    try {
      this.iframe.contentWindow?.postMessage(
        { type: "kill_request", reason },
        "*",
      );
    } catch (e) {}

    // The actual kill: tear down the realm from outside.
    try {
      if (!this.sandbox.destroyIframe && this.iframe) {
        // Persistent, user-supplied iframe — we can't remove it, so navigate
        // it away instead. This still destroys the current document/global
        // scope and halts execution immediately.
        this.iframe.src = "about:blank";
      }
      // If destroyIframe is true, cleanup() below removes the node from the
      // DOM, which has the same terminating effect.
    } catch (err) {
      console.warn("[kill] failed to tear down iframe:", err);
    }

    this.cleanup();

    const results = {
      success: false,
      killed: true,
      error: reason,
      stack: reason,
      logs: [...this.stdout, "Process Killed"],
      executionTime,
    };

    this.sandbox.emit("execution:kill", {
      id: this.sandbox.executionCount,
      reason,
      executionTime,
    });

    if (typeof this._resolve === "function") {
      this._resolve(results);
    }
  }

  /**
   * Inject code into iframe with CSP
   */
  inject(code, hasImports) {
    // Enhanced security with CSP
    const csp = [
      "default-src 'none'",
      "script-src 'unsafe-eval' 'unsafe-inline' data: blob: https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
      "script-src-elem 'self' 'unsafe-inline' blob: data: https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://ga.jspm.io",
      "img-src 'self' data:",
      "worker-src blob: data:",
      "connect-src * data: blob:", // <--- Add data: and blob: here explicitly
      "style-src 'unsafe-inline'",
    ].join("; ");
    const csp2 = [
      "default-src 'none'",
      "script-src 'unsafe-eval' 'unsafe-inline' data: blob: https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
      "script-src-elem 'self' 'unsafe-inline' blob: data: https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com  https://ga.jspm.io 'unsafe-inline'; img-src 'self' data:;",
      "worker-src blob: data:",
      "connect-src *",
      "style-src 'unsafe-inline'",
    ].join("; ");

    this.startTime = performance.now(); // needed for forceKill's executionTime

    // Escape the code to prevent breaking out of script tags
    const escapedCode = code.replace(/</g, "\\x3C").replace(/>/g, "\\x3E");

    this.exposedMethods = this._parseExposedMethods(code, "interop");

    code = this.hoistingTransform(code, "interop");

    /*this.iframe.srcdoc = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta http-equiv="Content-Security-Policy" content="${csp}">
        <\/head>
        <body>
          <script${hasImports ? ' type="module"' : ''}>
${code}
          <\/script>
        <\/body>
      <\/html>
    `;*/

    /* 
    const htmlString = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta http-equiv="Content-Security-Policy" content="${csp}">
        <\/head>
        <body>
          <script${hasImports ? ' type="module"' : ''}>
${code}
          <\/script>
        <\/body>
      <\/html>
    `
    */

    // TODO: use this - works for network imports but - need to handle normal files or steal code just for network imports and redirect to our loadModule >
    function buildHtmlString(csp, code, hasImports, iframe) {
      const doc = document.implementation.createHTMLDocument();

      // 1. Add a valid base URL so relative paths work properly
      const base = doc.createElement("base");
      base.href = window.location.origin;
      doc.head.appendChild(base);

      // 2. Add the CSP meta tag
      const meta = doc.createElement("meta");
      meta.setAttribute("http-equiv", "Content-Security-Policy");
      meta.setAttribute("content", csp);
      doc.head.appendChild(meta);

      // 3. Define window.esmsInitOptions with the hook FIRST (using plain JS so the function works)
      const optionsScript = doc.createElement("script");
      optionsScript.textContent = `
    window.esmsInitOptions = {
      shimMode: true,
      resolve: async (specifier, parentURL, defaultResolve) => {
         

        // Define your VFS modules
        const vfs = {
          "/foo.js": "export function hello() { console.log('Hello from VFS module!'); }",
          "/bar.js": "import { hello } from '/foo.js'; export function greet() { hello(); console.log('Greetings from bar.js'); }"
        };

        if (specifier in vfs) {
          return \`data:text/javascript;charset=utf-8,\${encodeURIComponent(vfs[specifier])}\`;
        }


  const node_builtin = ${JSON.stringify(builtinModules)}
  // Gap #6: "node:"-prefix normalization lives in the host-scope
  // normalizeBuiltinSpecifier; its source is inlined so the generated
  // script stays self-contained.
  const __normalizeBuiltinSpecifier = (${normalizeBuiltinSpecifier.toString()});


  let modulePath = specifier;

  const __builtinNorm = __normalizeBuiltinSpecifier(specifier, node_builtin);
  const isNodeBuiltIn = __builtinNorm.isNodeBuiltIn;
  modulePath = __builtinNorm.modulePath;

       if(isNodeBuiltIn){
        // Resolve Node builtins through the parent interop. Errors are wired
        // properly: _dynamic_import / _build_file rejections keep err.code
        // across the boundary (see interop_response wiring), and empty
        // results throw a real ERR_MODULE_NOT_FOUND instead of producing a
        // garbage data: URL that fails later with a cryptic SyntaxError.
        var bvmInterop = globalThis[Symbol.for("bvm.interop")];
        var bvmCwd = globalThis._RUNTIME${iframe.sandbox.uuid}_.cwd;
        // The seed is served host-side (pickDynamicImportVfs): never post
        // __USER_FILES__ across the boundary — structured-cloning ~22MB per
        // call stalled bootstrap for minutes.
        var data;
        try {
          data = await bvmInterop.callParent(
            '_dynamic_import',
            modulePath,
            'import',
            '/',
            '/',
            true,
            bvmCwd,
            undefined
          );
        } catch (err) {
          console.error('[bvm:resolve] _dynamic_import failed for "' + specifier + '": ' + ((err && err.message) || err));
          throw err;
        }
        if (!data || data.source === null || data.source === undefined || data.source === '') {
          var bvmNotFound = new Error("[ERR_MODULE_NOT_FOUND]: Cannot find module '" + specifier + "'");
          bvmNotFound.code = 'ERR_MODULE_NOT_FOUND';
          console.error('[bvm:resolve] ' + bvmNotFound.message);
          throw bvmNotFound;
        }
        try {
          data = await bvmInterop.callParent(
            '_build_file',
            data.source,
            specifier,
            'import',
            '/',
            '/',
            true
          );
        } catch (err) {
          console.error('[bvm:resolve] _build_file failed for "' + specifier + '": ' + ((err && err.message) || err));
          throw err;
        }
        if (data === null || data === undefined || data === '') {
          var bvmBuildEmpty = new Error("[bvm:resolve] _build_file returned empty source for '" + specifier + "'");
          console.error('[bvm:resolve] ' + bvmBuildEmpty.message);
          throw bvmBuildEmpty;
        }
        return "data:text/javascript;charset=utf-8," + encodeURIComponent(data);
       }

       // Platform fix (AGENTS.md rule 6): intercept file:// URLs and absolute
       // VFS paths. Vite's terser plugin does await import(pathToFileURL(p).href)
       // which produces file:///node_modules/...; es-module-shims would try to
       // fetch these as network URLs and die with a NetworkError. Route them
       // through the parent _dynamic_import + _build_file interop instead — the
       // parent already normalizes file:// → absolute VFS path. Any file://
       // import was broken, not just Vite's terser path.
       // Exception: a "/..." specifier whose parentURL is https:// is a
       // CDN-relative URL (esm.sh emits "/pkg@ver?target=..." imports), not
       // a VFS path — let defaultResolve handle it against the parent origin.
       var bvmParentIsHttps = typeof parentURL === "string" && parentURL.indexOf("https://") === 0;
       if (specifier.startsWith("file://") || (specifier.startsWith("/") && !bvmParentIsHttps)) {
         var bvmFilePath = specifier;
         if (bvmFilePath.startsWith("file://")) {
           bvmFilePath = bvmFilePath.slice("file://".length);
           // file:///x -> /x (keep the leading slash); file://host/x -> /x (VFS has no hosts)
           if (!bvmFilePath.startsWith("/")) bvmFilePath = "/" + bvmFilePath;
         }
         var bvmFileInterop = globalThis[Symbol.for("bvm.interop")];
         var bvmFileCwd = globalThis._RUNTIME${iframe.sandbox.uuid}_.cwd;
         var bvmFileData;
         try {
           bvmFileData = await bvmFileInterop.callParent(
             '_dynamic_import',
             bvmFilePath,
             'import',
             '/',
             '/',
             false,
             bvmFileCwd,
             undefined
           );
         } catch (err) {
           console.error('[bvm:resolve] _dynamic_import failed for file URL "' + specifier + '": ' + ((err && err.message) || err));
           throw err;
         }
         if (!bvmFileData || bvmFileData.source === null || bvmFileData.source === undefined || bvmFileData.source === '') {
           var bvmFileNotFound = new Error("[ERR_MODULE_NOT_FOUND]: Cannot find module '" + specifier + "'");
           bvmFileNotFound.code = 'ERR_MODULE_NOT_FOUND';
           console.error('[bvm:resolve] ' + bvmFileNotFound.message);
           throw bvmFileNotFound;
         }
         var bvmFileName = (bvmFileData && bvmFileData.resolvedPath) || bvmFilePath;
         try {
           bvmFileData = await bvmFileInterop.callParent(
             '_build_file',
             bvmFileData.source,
             bvmFileName,
             'import',
             '/',
             '/',
             false
           );
         } catch (err) {
           console.error('[bvm:resolve] _build_file failed for file URL "' + specifier + '": ' + ((err && err.message) || err));
           throw err;
         }
         if (bvmFileData === null || bvmFileData === undefined || bvmFileData === '') {
           var bvmFileBuildEmpty = new Error("[bvm:resolve] _build_file returned empty source for file URL '" + specifier + "'");
           console.error('[bvm:resolve] ' + bvmFileBuildEmpty.message);
           throw bvmFileBuildEmpty;
         }
         return "data:text/javascript;charset=utf-8," + encodeURIComponent(bvmFileData);
       }


        return defaultResolve(specifier, parentURL);
      }
    };
  `;
      doc.head.appendChild(optionsScript);
      // 5. Add your dynamic code script tag
      const script = doc.createElement("script");
      script.type = "module-shim";
      script.textContent = code;
      doc.body.appendChild(script);
      // 4. Load es-module-shims SECOND with async = false to guarantee it reads the options immediately
      const shimScript = doc.createElement("script");
      shimScript.async = false;
      shimScript.src =
        "https://ga.jspm.io/npm:es-module-shims@1.10.0/dist/es-module-shims.js";
      doc.head.appendChild(shimScript);

      return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
    }

    function buildHtmlString2(csp, code, hasImports) {
      // Create a new HTML document
      const doc = document.implementation.createHTMLDocument();

      // Add the CSP meta tag
      const meta = document.createElement("meta");
      meta.setAttribute("http-equiv", "Content-Security-Policy");
      meta.setAttribute("content", csp);
      doc.head.appendChild(meta);

      const script = document.createElement("script");
      if (hasImports) script.type = "module";
      script.textContent = code;
      doc.body.appendChild(script);

      // Serialize to string, including DOCTYPE
      return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
    }

    const htmlString = buildHtmlString(csp, code, hasImports, this);

    const blob = new Blob([htmlString], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    this.iframe.src = url;
    this.code = code;
    if (this.oldURL) {
      URL.revokeObjectURL(this.oldURL);
    }
    this.oldURL = url;
    // URL.revokeObjectURL(oldUrl);
  }

  hoistingTransform(code, objectName) {
    return code; // currently disabled as of right now.
    const ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
    const interopVariable = objectName;
    const ms = new MagicString(code);

    const hoistNodes = [];
    let insertAfter = null;

    // Walk AST
    walk.simple(ast, {
      CallExpression(node) {
        // collect .expose calls
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === objectName &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "expose"
        ) {
          hoistNodes.push(node);
        }
      },
      AssignmentExpression(node) {
        // detect window[interopVariable] = ...
        const left = node.left;
        if (
          left.type === "MemberExpression" &&
          left.object.type === "Identifier" &&
          left.object.name === "window"
        ) {
          if (
            (left.property.type === "Identifier" &&
              left.property.name === interopVariable) ||
            (left.property.type === "Literal" &&
              left.property.value === interopVariable)
          ) {
            insertAfter = node.end;
          }
        }
      },
    });

    if (hoistNodes.length) {
      // Generate hoisted code
      let hoistedCode = "";
      for (const node of hoistNodes) {
        hoistedCode += ms.slice(node.start, node.end) + ";\n";
        ms.remove(node.start, node.end);
      }

      if (insertAfter !== null) {
        ms.appendLeft(insertAfter, "\n" + hoistedCode);
      } else {
        // fallback: prepend at top
        ms.prepend(hoistedCode);
      }
    }
    return ms.toString();
  }

  /**
   * Setup message listener
   */
  listen(resolve, reject) {
    this._resolve = resolve;
    this._reject = reject;

    this.messageHandler = async (event) => {
      // Security check - only accept messages from our iframe
      if (event.source !== this.iframe.contentWindow) {
        return;
      }

      if (this.resolved) return;

      const data = event.data;

      // ── Server Shims ──────────────────────────────────────────────────────────────
      if (data.type === "serverListening") {
        const _vfsPort = _vfsExtractServerPort(data);
        this.sandbox.emit("execution:server", { type: "open", port: _vfsPort });
        this._serverRunning = true;
        this._serverPort = _vfsPort;
        if (_vfsPort != null) {
          this._vfsPorts.add(_vfsPort);
          if (!_vfsRegisterServerRoute(_vfsPort, this)) {
            // Another sandbox claimed this port first: revoke the loser so
            // its listen() fails loudly with EADDRINUSE (Node behavior).
            this._vfsPorts.delete(_vfsPort);
            this.invoke("__closeServer__", _vfsPort).catch(() => {});
          }
        }
      }

      if (data.type === "serverClosed") {
        const _vfsClosedPort = _vfsExtractServerPort(data) ?? this._serverPort;
        this.sandbox.emit("execution:server", {
          type: "closed",
          port: _vfsClosedPort,
        });
        _vfsUnregisterServerRoute(_vfsClosedPort, this);
        this._vfsPorts.delete(_vfsClosedPort);
        this._serverRunning = false;
        this._serverPort = null;
      }

      // ── spawn ──────────────────────────────────────────────────────────────
      if (data.type === "PARENT_SPAWN_REQUEST") {
        const { command, args = [], options, vfs } = data.payload;
        const assembled = [command, ...args].join(" ");

        const pushChunk = (stream, chunk) =>
          event.source.postMessage(
            {
              type: "PARENT_SPAWN_DATA",
              requestId,
              payload: { stream, chunk },
            },
            "*",
          );
      }

      if (data.type === "PARENT_EXEC_REQUEST") {
        // BYO shell (Jared 2026-10-03): developers provide their own shell
        // function via `new CodeSandbox({ shell })`. If provided, route the
        // request to it. If not, throw a loud configuration error.
        const shellFn = this.config.shell;
        if (typeof shellFn !== "function") {
          throw new Error(
            "CodeSandbox: no shell configured. " +
              "Pass a `shell` function in CodeSandbox options to enable child_process.",
          );
        }

        try {
          /*
                   // Send live streams if needed (or just send the final chunk)
      if (result.stdout) {
        source.postMessage({ type: 'STDOUT', id: requestId, payload: result.stdout }, '*');
      }
      if (result.stderr) {
        source.postMessage({ type: 'STDERR', id: requestId, payload: result.stderr }, '*');
      }
      */

          /*
                  import { spawn } from 'child_process';

// Spawn a process (using a cross-platform node inline script as an example)
const child = spawn('node', [`
    console.log('Starting task...');
    setTimeout(() => console.log('Processing step 1...'), 1000);
    setTimeout(() => console.log('Processing step 2...'), 2000);
    setTimeout(() => console.log('Done!'), 3000);
`]);

// Listen for live chunks of stdout as they arrive
child.stdout.on('data', (chunk) => {
    // Convert chunk to string and split by lines
    const lines = chunk.toString().split(/\r?\n/);
     
    lines.forEach((line) => {
        if (line.trim() !== '') {
            process.stdout.write(`[LIVE STDOUT]: ${line}\n`);
        }
    });
});
// Listen for live chunks of stderr (errors)
child.stderr.on('data', (chunk) => {
    process.stderr.write(`[LIVE STDERR]: ${chunk}`);
});
 
// Handle process completion
child.on('close', (code, signal) => {
    console.log(`\nProcess exited with code ${code} and signal ${signal}`);
});

// Handle errors (e.g., if the command itself fails to start)
child.on('error', (err) => {
    console.error('Failed to start process:', err);
}); 
*/

          const result = await shellFn(
            data.payload.command,
            data.payload.args || [],
            data.payload.options || {},
          );

          // Send result back to the specific iframe that requested it
          event.source.postMessage(
            {
              type: "PARENT_CHILD_EXEC_RESPONSE",
              requestId: data.requestId,
              payload: result,
            },
            "*",
          );
        } catch (err) {
          event.source.postMessage(
            {
              type: "PARENT_CHILD_EXEC_RESPONSE",
              requestId: data.requestId,
              payload: {
                stdout: "",
                stderr: err?.message || "Command not found or syntax error",
                exitCode: 1,
              },
            },
            "*",
          );
        }
      }

      if (data.type === "fs") {
        this.sandbox.emit("execution:fs", data);
        return;
      }

      if (data.type === "interop_call") {
        this.handleInteropCall(data);
        return;
      }

      if (data.type === "newline") {
        this.sandbox.emit("execution:readline_newline", true);
        return;
      }

      if (data.type === "interop_registered") {
        this.sandbox.emit("execution:interop_registered", { name: data.name });
        return;
      }

      // NEW: Handle interop responses
      if (data.type === "interop_result") {
        const callback = this.interopCallbacks.get(data.callId);
        if (callback) {
          this.interopCallbacks.delete(data.callId);
          if (data.error) {
            callback.reject(new Error(data.error));
          } else {
            callback.resolve(data.result);
          }
        }
        return;
      }

      if (data.type === "sandbox_ready") {
        /*
         this.executionCount++;
         const executionId = this.executionCount;
         this.emit('execution:start', { id: executionId, code });
         */
        // this.executionCount++;
        const executionId = this.sandbox.executionCount;
        this.running = true;
        this.sandbox.emit("execution:start", { id: executionId, code: false });
      }

      if (data.type === "function_results") {
        this.resolved = true;
        this.cleanup();
        const results = {
          success: true,
          logs: data.logs || [],
          errors: data.errors || [],
          //output: data.logs,
          fs: data.fs,
          executionTime: data.executionTime,
        };
        resolve(results);
      } else if (data.type === "stdout") {
        // this.logs.push({type:data.method, args:data.message})
        this.sandbox.emit("execution:stdout", {
          type: data.method,
          args: data.message,
        });
        // Derived alias (docs/PLUGINS.md decision "execution:stderr"):
        // Node routes console.error AND console.warn to fd 2, so hosts
        // that render stderr separately get a dedicated event. Backwards
        // compatible — execution:stdout keeps firing for every console.* call.
        if (data.method === "error" || data.method === "warn") {
          this.sandbox.emit("execution:stderr", {
            type: data.method,
            args: data.message,
          });
        }
      } else if (data.type === "resource_timing") {
        const r = JSON.parse(data.message);
        this.sandbox.emit("execution:resource_timing", r);
      } else if (data.type === "key_event") {
        const r = JSON.parse(data.message);

        this.sandbox.emit("execution:key_event", r);
      } else if (data.type === "network_request") {
        const r = JSON.parse(data.message);

        this.sandbox.emit("execution:network_request", r);
      } else if (data.type === "kill") {
        this.resolved = true;
        this.cleanup();
        this.killed = true;
        const results = {
          success: true,
          error: data?.error || false,
          logs: [...data.logs, "Process Exited"],
          // output: [...data.logs, 'Process Exited'],
          executionTime: data.executionTime,
          exitCode: data?.exitCode ?? null,
        };
        resolve(results);
      } else if (data.type === "function_error") {
        // Map frames to original positions via the source-map registry.
        // Falls back to legacy line-offset math if no frames/registry.
        let mappedReason;
        if (data.frames && data.frames.length) {
          const mapped = this.sandbox._mapStackFrames(data.frames, this.code);
          mappedReason = this.sandbox._formatMappedError(
            data.errorName,
            data.error,
            mapped,
          );
        } else {
          // Legacy fallback (no structured frames)
          let line = this.code
            .slice(0, this.code.indexOf("//__$PROVIDED_RUNTIME_CODE__/"))
            .split("\n").length;
          line = data.line - line;
          const isNegative = (n) => n < 0;
          if (isNegative(line)) {
            mappedReason = `${data.stack || data.reason || data.error || data.message}`;
          } else {
            const codeThatThrewError =
              this.code.split("\n")[Number(data.line) - 1] || "";
            mappedReason = `${data.stack || data.reason || data.error || data.message}\nat line ${line}, column ${data.column} \n \n →    ${line}| ${codeThatThrewError}`;
          }
        }

        this.resolved = true;
        this.cleanup();
        resolve({
          success: false,
          error: data.error,
          stack: mappedReason,
          logs: data.logs,
          executionTime: data.executionTime,
        });
      } else if (data.type === "window_error") {
        if (this.config.captureWindowErrors && !this.resolved) {
          this.resolved = true;
          this.cleanup();
          // Map frames to original positions via the source-map registry.
          const mapped =
            data.frames && data.frames.length
              ? this.sandbox._mapStackFrames(data.frames, this.code)
              : [];
          const mappedMsg = mapped.length
            ? this.sandbox._formatMappedError(
                data.errorName,
                data.message,
                mapped,
              )
            : data.message || "Window error";
          const err = new Error(mappedMsg);
          if (data.stack) err.stack = String(data.stack);
          reject(err);
        }
      } else if (data.type === "unhandled_promise_rejection") {
        if (this.config.capturePromiseRejections && !this.resolved) {
          this.resolved = true;
          this.cleanup();

          // Map frames to original positions via the source-map registry.
          const mapped =
            data.frames && data.frames.length
              ? this.sandbox._mapStackFrames(data.frames, this.code)
              : [];
          const mappedReason = mapped.length
            ? this.sandbox._formatMappedError(
                data.errorName,
                data.reason,
                mapped,
              )
            : data.reason || "Unhandled promise rejection";

          const rejectionError = new Error(mappedReason);
          if (data.stack) rejectionError.stack = String(data.stack);
          reject(rejectionError);
        }
      }
    };

    window.addEventListener("message", this.messageHandler);
    this.cleanupCallbacks.push(() => {
      window.removeEventListener("message", this.messageHandler);
    });
  }

  async handleInteropCall(data) {
    const { callId, method, args } = data;

    // Check if sandbox has registered this method
    const handler = this.sandbox.interopHandlers?.[method];

    if (!handler) {
      this.iframe.contentWindow.postMessage(
        {
          type: "interop_response",
          callId,
          error: {
            message: `Method '${method}' not registered in parent`,
            code: "ERR_INTEROP_NO_HANDLER",
            name: "Error",
          },
        },
        "*",
      );
      return;
    }

    try {
      const result = await handler(...args);

      this.iframe.contentWindow.postMessage(
        {
          type: "interop_response",
          callId,
          result,
        },
        "*",
      );
    } catch (err) {
      // Send structured error info so the sandbox can reconstruct
      // err.code / err.name (e.g. ERR_MODULE_NOT_FOUND), not just the message.
      this.iframe.contentWindow.postMessage(
        {
          type: "interop_response",
          callId,
          error: {
            message: err && err.message ? err.message : String(err),
            code: err && err.code,
            name: (err && err.name) || "Error",
          },
        },
        "*",
      );
    }
  }

  // NEW: Call functions inside sandbox from parent
  /**
   * Call functions inside sandbox from parent
   * Use arrow function syntax to ensure 'this' always refers to the ExecutionContext instance.
   */
  invoke = async (method, ...args) => {
    // Ensure the iframe is actually loaded before sending messages.
    // __stdin__ is allowed through when the iframe exists even if the
    // running flag hasn't been set yet (sandbox_ready can lag); the
    // iframe-side __stdin__ handler validates listeners itself.
    const isStdin = method === "__stdin__";
    if (
      !this.iframe ||
      !this.iframe.contentWindow ||
      (!isStdin && this.running === false)
    ) {
      throw new Error("Sandbox is not running.");
    }
    const callId = Math.random().toString(36).substr(2, 9);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Check if it still exists before rejecting to avoid race conditions

        if (this.interopCallbacks.has(callId)) {
          this.interopCallbacks.delete(callId);
          if (this.running === false) {
            reject(
              new Error(`Interop method failed (sandbox is closed): ${method}`),
            );
          } else {
            reject(new Error(`Interop invoke timeout: ${method}`));
          }
        }
      }, 10000);

      // This will no longer throw "undefined" because of the arrow function
      this.interopCallbacks.set(callId, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.iframe.contentWindow.postMessage(
        {
          type: "interop_invoke",
          callId,
          method,
          args,
        },
        "*",
      );
    });
  };

  /**
   * Parses method names exposed via [variable].expose('name', ...)
   * @param {string} code - The source code to parse
   * @param {string} interopVar - The variable name to look for (e.g., 'interop')
   */
  _parseExposedMethods(code, interopVar) {
    const exposedMethods = [];

    const ast = acorn.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
    });

    walk.simple(ast, {
      CallExpression(node) {
        const { callee, arguments: args } = node;

        if (
          callee.type === "MemberExpression" &&
          callee.object.name === interopVar &&
          callee.property.name === "expose"
        ) {
          if (args[0] && args[0].type === "Literal") {
            exposedMethods.push(args[0].value);
          }
        }
      },
    });

    return exposedMethods;
  }

  /**
   * Setup message listener
   */
  serverRunning = (method) => {
    return this._serverRunning;
  };

  hasMethod = async (method) => {
    try {
      if (this.exposedMethods.includes(method)) {
        return true;
      }
      return false;
      // We invoke a special internal check
      //return await this.invoke('__check_exists__', method);
    } catch {
      return false;
    }
  };

  /**
   * Cleanup resources
   */
  cleanup() {
    this.running = false;

    if (this._serverRunning === true) {
      this.sandbox.emit("execution:server", {
        type: "closed",
        port: this._serverPort,
      });
      this._serverRunning = false;
      this._serverPort = null;
    }
    // Release every virtual-server route this sandbox owned so the host
    // fetch bridge stops routing to a dead sandbox and the native fetch
    // is restored once the final route disappears.
    if (this._vfsPorts) {
      for (const _vfsPort of this._vfsPorts)
        _vfsUnregisterServerRoute(_vfsPort, this);
      this._vfsPorts.clear();
    }

    this.cleanupCallbacks.forEach((cb) => {
      try {
        cb();
      } catch (err) {
        console.warn("Cleanup error:", err);
      }
    });
    this.cleanupCallbacks = [];

    if (
      this.iframe &&
      this.iframe.parentNode &&
      this.sandbox.destroyIframe === true
    ) {
      this.iframe.remove();
    }
  }
}

// ============================================================================
// SANDBOX RUNTIME TEMPLATE
// ============================================================================

// To hide your internal runtime logic and prevent user code from tampering with your patches, you need to use **lexical scoping (closures)** and **Shadow Realms** (or the pattern of "Localizing Globals").
//
// If you just define 'originalFetch' in the global scope, a clever user can find it, delete it, or bypass your tracking.
//
// Here are the three best ways to "cloak" your runtime:
//
// ---
//
// ### 1. The IIFE Wrapper (Closure Isolation)
//
// By wrapping your entire runtime in an **Immediately Invoked Function Expression (IIFE)**, all your 'original' variables and 'pendingMaps' exist only in a private scope that the user code cannot physically reach.
//
// '''javascript
// static generate(code, config = {}) {
//   return '
//   (() => {
//     // --- PRIVATE SCOPE START ---
//     // User code cannot see these variables
//     const _originalFetch = window.fetch;
//     const _internalRegistry = new Map();
//
//     function _loadModuleInternal(path) {
//        /* logic */
//     }
//
//     // --- PATCHING ---
//     // We overwrite the global, but the pointer to the 'real' one is hidden above
//     window.fetch = async (...args) => {
//        console.log("Tracking...");
//        return _originalFetch(...args);
//     };
//
//     // --- EXECUTION ---
//     (async () => {
//       try {
//         ${code} // User code runs here
//       } catch(e) { /* ... */ }
//     })();
//     // --- PRIVATE SCOPE END ---
//   })();
//   ';
// }
// '''
//
// ### 2. The "Hidden Property" Pattern (Using Symbols)
//
// If you must attach something to a global object but don't want the user to see it when they run 'Object.keys(window)', use **Symbols**. Symbols are non-enumerable and "invisible" to standard loops.
//
// '''javascript
// const INTERNAL_STATE = Symbol("runtimeState");
//
// window[INTERNAL_STATE] = {
//   pendingCount: 0,
//   originalSetTimeout: window.setTimeout
// };
//
// // Even if the user does:
// for (let key in window) { console.log(key); }
// // Your symbol will NOT show up.
//
// '''
//
// ### 3. Object Shielding (Freezing the Prototype)
//
// Users can often bypass patches by going to the prototype (e.g., 'HTMLAnchorElement.prototype.click'). To prevent them from un-patching your work, you can **freeze** the descriptors of the functions you’ve patched.
//
// '''javascript
// Object.defineProperty(window, 'fetch', {
//   value: myPatchedFetch,
//   writable: false,     // User can't do: window.fetch = ...
//   configurable: false,  // User can't delete it or change this config
//   enumerable: true
// });
//
// '''
//
// ---
//
// ### 4. Advanced: The "Clean Room" Helper
//
// When patching, users can sometimes detect your "traps" by checking 'fetch.toString()'. A truly hidden runtime will "mask" the function string to look native.
//
// '''javascript
// function maskFunction(patchedFn, originalFn) {
//   Object.defineProperty(patchedFn, 'name', { value: originalFn.name });
//   patchedFn.toString = () => originalFn.toString();
// }
//
// // Now console.log(fetch.toString()) prints "function fetch() { [native code] }"
// // instead of your internal source code.
//
// '''
//
// ### Recommendation for your Sandbox
//
// I suggest combining **Method 1 (IIFE)** and **Method 4 (Masking)**.
//
// 1. Put all your 'originalFetch', 'pendingModules', and 'asyncRegistry' variables at the very top of the IIFE.
// 2. Only expose the final "public" API (the patched 'fetch', 'setTimeout', etc.).
// 3. Mask the 'toString' so the user can't inspect your tracking logic.
//
// **Would you like me to update the 'SandboxRuntime' class to wrap everything in this secure "Private Closure" structure?**

// Parse one V8 stack-frame line into {file, line, column}.
// Handles "at fn (https://host/app.js:10:15)", "at async fn (...)", and
// "at https://host/app.js:10:15". Anchored at the end so URL schemes
// (https://...) are never mistaken for the line/column separators.
// Defined once at module scope and exported for unit tests; the sandbox
// template below inlines it via const __parseStackLocationFn = (${__parseStackLocationFn.toString()}); so the
// iframe gets the identical implementation (single source of truth).
export function __parseStackLocationFn(frame) {
  let s = String(frame || "")
    .trim()
    .replace(/^at\s+(async\s+)?/, "");
  // data: URLs embed the whole (encoded) module source, which may contain
  // unencoded parens/quotes — match the URL as one unit before the generic
  // paren-stripping below (whose lastIndexOf('(') would land inside the
  // module source). Greedy: the only literal colons are the trailing
  // :line:column (inner colons are %-encoded).
  let m = s.match(/\(?(data:[^\s]*):(\d+):(\d+)\)?$/);
  if (m) return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
  const open = s.lastIndexOf("(");
  if (open !== -1 && s.endsWith(")")) s = s.slice(open + 1, -1);
  m = s.match(/^(.*):(\d+):(\d+)$/);
  if (!m) return null;
  return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
}

export class SandboxRuntime {
  static generate(code, config = {}) {
    // Serialize the BYO shell function (if provided) into the sandbox.
    // .toString() captures source, not closures — the function must be
    // self-contained.
    const shellField =
      typeof config.shell === "function"
        ? `__SHELL__: (${config.shell.toString()}),`
        : "";
    // The sandbox template lives in src/sandbox-template.js (built from
    // src/sandbox/*.js by src/build-sandbox.mjs). Substitute %%TOKEN%%s.
    // IMPORTANT: use replacement FUNCTIONS (not strings) — String.replace()
    // interprets $ patterns ($&, $', $1...) in string replacements, and user
    // code / imports can contain $.
    let result = SANDBOX_TEMPLATE;
    const sub = (token, value) => {
      result = result.replace(new RegExp(token, "g"), () => value);
    };
    sub("%%UUID%%", config.uuid);
    sub("%%INTEROP_VAR%%", config.interopVariable);
    sub("%%PROCESS_JSON%%", JSON.stringify(config.process));
    sub("%%USER_FILES_JSON%%", JSON.stringify(config.fs));
    sub(
      "%%SEA_ASSETS_JSON%%",
      JSON.stringify(
        config.seaAssets && Object.keys(config.seaAssets).length
          ? config.seaAssets
          : undefined,
      ),
    );
    sub("%%BUILTIN_MODULES_JSON%%", JSON.stringify(_builtinManifest));
    sub("%%BUILTIN_MODULES_ARRAY_JSON%%", JSON.stringify(builtinModules));
    sub("%%FILENAME%%", config.fileName);
    sub("%%STRIP_ANSI_FN%%", String(stripAnsi));
    sub("%%PARSE_STACK_LOCATION_FN%%", __parseStackLocationFn.toString());
    sub("%%SHELL_FIELD%%", shellField);
    sub(
      "%%NORMALIZE_BUILTIN_SPECIFIER_FN%%",
      normalizeBuiltinSpecifier.toString(),
    );
    for (const [suffix, stmt] of Object.entries(LOG_TOKENS)) {
      sub(`%%LOG_${suffix}%%`, config.logNetworkRequests ? stmt : "");
    }
    sub("%%IMPORTS%%", config.imports?.join("\n") || "");
    // USER_CODE last: its value could theoretically contain %%TOKEN%%-like text.
    sub("%%USER_CODE%%", code);
    if (/%%[A-Z_]+%%/.test(result)) {
      throw new Error("SandboxRuntime.generate: unreplaced token in template");
    }
    return result;
  }
}

// ============================================================================
// CODE TRANSFORMER MODULE
// ============================================================================

export class CodeTransformer {
  /**
   * Apply multiple transformations to code
   */
  static transform(code, transformers = []) {
    return transformers.reduce((result, transformer) => {
      try {
        return transformer(result);
      } catch (err) {
        console.warn("Transformer error:", err);
        return result;
      }
    }, code);
  }

  /**
   * Built-in transformers
   */
  static transformers = {
    // Remove console statements
    removeConsole: (code) =>
      code.replace(/console\.(log|info|warn|error|debug)\([^)]*\);?/g, ""),

    // Wrap in async IIFE if not already wrapped
    wrapAsync: (code) => {
      if (!code.trim().startsWith("(async")) {
        return `(async () => {\n${code}\n})();`;
      }
      return code;
    },

    // Add strict mode
    addStrictMode: (code) => `'use strict';\n${code}`,
  };
}

// ============================================================================
// MAIN SANDBOX CLASS
// ============================================================================

export class CodeSandbox extends EventEmitter {
  constructor(options = {}) {
    const PROCESS_OBJECT = {
      title: "node",
      arch: "x64",
      env: {
        HOME: "/Users/username",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        USER: "username",
        PWD: "/project/directory",
        NODE_ENV: "development",
      },
      platform: "darwin",
      pid: 1,
      ppid: 0,
      argv: [],
      argv0: "node",
      execPath: "/usr/local/bin/node",
      execArgv: [],
      // Terminal dimensions. Overridable via options.process.stdout.columns/rows
      // (and .stderr); also updatable at runtime via setTerminalSize().
      stdout: { columns: 80, rows: 24 },
      stderr: { columns: 80, rows: 24 },
      version: "v20.10.0",
      versions: {
        node: "20.10.0",
        v8: "11.3.244.8-node.17",
        uv: "1.46.0",
        zlib: "1.2.13.1-motley",
        brotli: "1.0.9",
        ares: "1.20.1",
        modules: "115",
        nghttp2: "1.57.0",
        napi: "9",
        llhttp: "8.1.1",
        openssl: "3.0.12+quic",
        cldr: "43.1",
        icu: "73.2",
        tz: "2023c",
        unicode: "15.0",
      },
    };

    super();
    this.uuid = "_u_" + uuid().replace(/-/g, "");
    this.invoke = function () {
      throw new Error("Sandbox is not running.");
    };
    this.interopHandlers = {};
    // Registry for source maps: sourceURL -> { map, originalSource, filename }
    // Populated by _build_file, used for parent-side error mapping.
    this._sourceMapRegistry = new Map();
    this.iframeElement = null;
    this.beforeExecute = options?.beforeExecute || null; // array
    this.destroyIframe = true;
    this.iframeElement = options.iframeElement ?? null; // string or querySelector

    this._serverRunning = false;

    if (options.process) {
      options.process = mergeProcess(options.process, PROCESS_OBJECT);
    }

    this.config = {
      timeout: options.timeout || 30000, // Number or infity
      logNetworkRequests: options.logNetworkRequests ?? false,
      captureWindowErrors: options.captureWindowErrors ?? true,
      capturePromiseRejections: options.capturePromiseRejections ?? true,
      cdnBase: options.cdnBase || "https://esm.sh",
      ecmaVersion: options.ecmaVersion || 2022,
      transformRules: options.transformRules || [],
      codeTransformers: options.codeTransformers || [], // array
      fallbackCDN: options.fallbackCDN ?? true, // boolean
      interopVariable: options.interopVariable || "interop", // string
      process: options?.process || PROCESS_OBJECT, // array
      fileName: options?.fileName || "index.js", // string,
      fs: options?.fs || {},
      // Virtual node:sea asset store (mirrors 'fs' -> __USER_FILES__).
      // { [key]: string | Uint8Array | ArrayBuffer | { encoding: 'utf8'|'base64', data: string } }
      // Normalized by normalizeSeaAssets() and published as __SEA_ASSETS__.
      seaAssets: options?.seaAssets || {},
      // BYO shell (Jared 2026-10-03): developers bring their own shell
      // function (real bash via bridge, hand-rolled fake, etc.). If provided,
      // child_process calls route to it. If not provided, shell calls throw.
      // The function is serialized via .toString() into the sandbox — it must
      // be self-contained (no closure references).
      shell: options?.shell ?? null,
    };

    // Validate the shell option early: must be a function or null/undefined.
    if (this.config.shell != null && typeof this.config.shell !== "function") {
      throw new TypeError("CodeSandbox option 'shell' must be a function");
    }

    // Per-sandbox plugin list (docs/PLUGINS.md Part B §5): when provided,
    // this sandbox uses ONLY these plugins — the global registry is
    // shadowed for it. Null (default) means "use the global registry".
    // Validated and snapshotted here; the _build_file/_dynamic_import
    // interop handlers below read this.plugins at call time.
    if (options?.plugins != null) {
      if (!Array.isArray(options.plugins)) {
        throw new TypeError("CodeSandbox option 'plugins' must be an array");
      }
      const names = new Set();
      for (const p of options.plugins) {
        validatePlugin(p);
        if (names.has(p.name)) {
          throw new Error(
            `Duplicate plugin name '${p.name}' in 'plugins' option`,
          );
        }
        names.add(p.name);
      }
      this.plugins = [...options.plugins];
    } else {
      this.plugins = null;
    }

    if (this.iframeElement) {
      const value = this.iframeElement;

      if (typeof value === "string") {
        // Treat as query selector string
        this.iframeElement = document.querySelector(value);

        if (!this.iframeElement) {
          throw new Error(`No element found for selector: ${value}`);
        }
      } else if (value instanceof HTMLIFrameElement) {
        // Direct iframe element provided
        this.iframeElement = value;
      } else {
        throw new Error(
          "iframeElement must be a query selector string or an <iframe> element",
        );
      }

      this.destroyIframe = false;
    }

    this.importResolver = new ImportResolver({
      cdnBase: this.config.cdnBase,
      transformRules: this.config.transformRules,
      fallbackCDN: this.config.fallbackCDN,
    });

    this.initialized = false;
    this.executionCount = 0;
  }

  registerInterop(name, handler) {
    this.interopHandlers[name] = handler;
    return this;
  }

  // NEW: Remove interop handler
  unregisterInterop(name) {
    delete this.interopHandlers[name];
    return this;
  }

  /**
   * Map structured stack frames (from the sandbox) back to original source
   * positions using the _sourceMapRegistry populated by _build_file.
   *
   * Each frame: { file, line, column } (from __parseStackLocation).
   * Returns: [{ file, line, column, internal, source }, ...]
   *   - internal=true for frames with no registry entry (runtime internals,
   *     esm.sh CDN modules, etc.) — shown collapsed or hidden.
   */
  _mapStackFrames(frames, runtimeCode) {
    if (!Array.isArray(frames)) return [];
    // Registry maps are relative to the transformed user snippet
    // (mainTransform.code), but stack frames report lines in the full
    // generated runtime. Subtract the boilerplate offset for main-entry
    // frames so TraceMap lookups land on the snippet's line numbering.
    // Imported-module frames (own data: URLs) already use snippet-relative
    // lines, so the offset only applies to the main entry key.
    const mainKey = `sandbox://${this.uuid}/${this.config && this.config.fileName}`;
    let boilerplateOffset = 0;
    if (typeof runtimeCode === "string") {
      const markerIdx = runtimeCode.indexOf("//__$PROVIDED_RUNTIME_CODE__/");
      if (markerIdx !== -1)
        boilerplateOffset = runtimeCode.slice(0, markerIdx).split("\n").length;
    }
    return frames.map((frame) => {
      let entry =
        frame && frame.file ? this._sourceMapRegistry.get(frame.file) : null;
      let entryKey = frame?.file || null;
      if (
        !entry &&
        typeof frame?.file === "string" &&
        frame.file.startsWith("data:")
      ) {
        // Imported modules execute from data: URLs whose sourceURL trailer
        // names the module path (e.g. //# sourceURL=./helper.js). The
        // registry is keyed sandbox://<uuid>/<modulePath>: match by suffix.
        try {
          const comma = frame.file.indexOf(",");
          const decoded = decodeURIComponent(frame.file.slice(comma + 1));
          const m = decoded.match(/\/\/# sourceURL=(\S+)\s*$/);
          if (m) {
            const want = m[1];
            for (const k of this._sourceMapRegistry.keys()) {
              if (k === want || k.endsWith("/" + want)) {
                entryKey = k;
                entry = this._sourceMapRegistry.get(k);
                break;
              }
            }
          }
        } catch (e) {
          /* leave entry null -> internal frame */
        }
      }
      if (!entry || !entry.map) {
        return {
          file: frame?.file || null,
          line: frame?.line ?? null,
          column: frame?.column ?? null,
          internal: true,
          source: frame?.file || null,
        };
      }
      try {
        // V8 stack columns are 1-based; trace-mapping expects 0-based
        // generated columns and returns 0-based original columns.
        const tracer = new TraceMap(entry.map);
        const offset = frame.file === mainKey ? boilerplateOffset : 0;
        const pos = originalPositionFor(tracer, {
          line: frame.line - offset,
          column: (frame.column || 1) - 1,
        });
        if (!pos || pos.line == null) {
          return {
            file: entry.filename || frame.file,
            line: null,
            column: null,
            internal: true,
            source: frame.file,
          };
        }
        return {
          file: pos.source || entry.filename || frame.file,
          line: pos.line,
          // Convert back to 1-based for display
          column: (pos.column ?? 0) + 1,
          internal: false,
          source: entryKey,
        };
      } catch (err) {
        return {
          file: entry.filename || frame?.file || null,
          line: frame?.line ?? null,
          column: frame?.column ?? null,
          internal: true,
          source: frame?.file || null,
        };
      }
    });
  }

  /**
   * Format a mapped error with original source context.
   * Uses the originalSource stored in the registry to render the code frame.
   */
  _formatMappedError(errorName, message, mappedFrames) {
    const lines = [`${errorName || "Error"}: ${message || "Unknown error"}`];

    // Find the registry entry for the first non-internal frame to get source.
    let contextRendered = false;
    for (const frame of mappedFrames) {
      if (frame.internal) continue;
      const entry = this._sourceMapRegistry.get(frame.source);
      const src = entry?.originalSource;
      if (src && frame.line) {
        const srcLines = src.split("\n");
        const start = Math.max(0, frame.line - 3);
        const end = Math.min(srcLines.length, frame.line + 2);
        const context = srcLines
          .slice(start, end)
          .map((l, idx) => {
            const actualLine = start + idx + 1;
            const marker = actualLine === frame.line ? "→" : " ";
            return `${marker} ${String(actualLine).padStart(4)} | ${l}`;
          })
          .join("\n");
        lines.push(`at (${frame.file}:${frame.line}:${frame.column})`);
        lines.push("", context);
        contextRendered = true;
        break;
      }
    }

    // Fallback: list mapped frames without source context
    if (!contextRendered) {
      for (const frame of mappedFrames.slice(0, 10)) {
        if (frame.internal) continue;
        lines.push(`at (${frame.file}:${frame.line}:${frame.column})`);
      }
    }

    return lines.join("\n");
  }

  kill(reason = "Process killed by user") {
    if (!this._context || !this._context.running) {
      console.warn("[Sandbox] kill() called but sandbox is not running.");
      return false;
    }
    this._context.forceKill(reason);
    return true;
  }

  /**
   * Initialize the sandbox (load dependencies)
   */
  async init() {
    if (this.initialized) return;

    try {
      this.initialized = true;
      this.emit("initialized", { timestamp: Date.now() });
    } catch (err) {
      this.emit("error", { type: "initialization", error: err.message });
      throw err;
    }
  }

  /**
   * Execute code in sandboxed environment
   * @param {string} code - JavaScript code to execute
   * @returns {Promise<ExecutionResult>}
   */
  async execute(code) {
    this.trueCode = code;

    if (typeof this.beforeExecute === "function") {
      await this.beforeExecute(); // dev might want to update something in config - such as process argv.
    }

    if (!this.initialized) {
      await this.init();
    }

    this.executionCount++;
    const executionId = this.executionCount;

    return new Promise(async (resolve, reject) => {
      // Create isolated iframe

      const iframe = this.iframeElement || document.createElement("iframe");

      iframe.sandbox = "allow-scripts allow-same-origin allow-unsafe-eval";
      if (!this.iframeElement) {
        iframe.style.cssText =
          "position: absolute; width: 0; height: 0; border: 0;";
      }

      const context = new ExecutionContext(iframe, this);
      this.iframe = iframe;
      this._context = context;
      this.invoke = context.invoke.bind(context);
      this.serverRunning = context.serverRunning.bind(context);
      this.hasMethod = context.hasMethod.bind(context);

      function createFetchAdapter(fetchImpl) {
        return async function adaptedFetch(input, init) {
          const response = await fetchImpl(input, init);

          const headers = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });

          const contentType = (headers["content-type"] || "").toLowerCase();

          // Text types we explicitly want as strings
          const isText =
            contentType.startsWith("text/") ||
            contentType.includes("json") ||
            contentType.includes("javascript") ||
            contentType.includes("xml") ||
            contentType.includes("html") ||
            contentType.includes("urlencoded");

          let body;
          if (!isText) {
            // Treat everything else (wasm, images, zips, octet-streams, etc.) as binary
            const buffer = await response.arrayBuffer();
            body = new Uint8Array(buffer);
          } else {
            body = await response.text();
          }

          return {
            body,
            status: response.status,
            statusText: response.statusText,
            headers,
            ok: response.status >= 200 && response.status < 300,
            url: input,
          };
        };
      }

      /// Functions passed as options / AbortController Missing etc..
      this.registerInterop("_fetch_", async (url, options) => {
        const adaptedFetch = createFetchAdapter(fetch);

        const res = await adaptedFetch(url, options);

        return res;
        // A JSON response must be returned like this so it can be serialized through post message.
        /*   return {
  body: JSON.stringify({ mocked: true }),
  status: 200,
  statusText: "OK",
  headers: { "Content-Type": "application/json" }
};*/
      });

      this.registerInterop("_bundler_", async (url) => {
        function isEsmSh(url) {
          return /^https?:\/\/esm\.sh\//.test(url);
        }

        function toBundleUrl(url) {
          if (!isEsmSh(url) || url.includes("?bundle")) return url;
          return url + (url.includes("?") ? "&bundle" : "?bundle");
        }

        return await bundle(url).url;
      });

      this.registerInterop(
        "_build_file",
        async (
          source,
          fileName,
          moduleType,
          entryPoint,
          parentEntryPoint,
          isNodeBuiltIn,
        ) => {
          // Part B plugin hooks: onResolve tags the namespace, onLoad decides
          // how the path loads, and the loader dispatch produces the module.
          // The namespace is re-derived here from fileName (no interop
          // signature change): _dynamic_import may rewrite the specifier,
          // but filters match the resolved path in the spec's examples.
          // PluginError propagates via the interop error channel → the
          // iframe converts it to function_error ({success:false,...}).
          const __pr = await applyResolvePlugins(
            fileName,
            entryPoint,
            this.plugins,
          );
          const __ns = (__pr && __pr.namespace) || "file";
          const __lr = await applyLoadPlugins(
            (__pr && __pr.path) || fileName,
            __ns,
            source,
            this.plugins,
          );
          const __dispatched = dispatchLoader(
            __lr.contents,
            __lr.loader,
            fileName,
          );
          if (__dispatched.kind === "module") {
            // json/text/wasm: final ESM, skip transform — BUT respect the
            // require() caller's contract. The sandbox-side loadModule wraps
            // require() targets with wrapCommonJS(); feeding it a top-level
            // `export` is a SyntaxError ("export declarations may only appear
            // at top level"). For the statically-analyzable json/text
            // loaders, emit CJS instead; wasm keeps ESM (top-level await
            // can't become CJS — the ERR_REQUIRE_ESM path below handles it).
            if (moduleType === "require" && __lr.loader !== "wasm") {
              const m = __dispatched.source.match(
                /^export default ([\s\S]*?);?\s*$/,
              );
              if (m) {
                return `module.exports = ${m[1]};`;
              }
              // Fallthrough: unparseable ESM → ERR_REQUIRE_ESM below.
            } else {
              return __dispatched.source;
            }
          }
          source = __dispatched.source; // js: continue through the pipeline

          // Plugin transforms run FIRST, before detectModuleSystem: a .ts
          // source's type annotations are not parseable JS, so the plugin
          // must produce valid JS before the acorn-based pipeline runs.
          // (docs/PLUGINS.md Part B; src/plugins.js documents the hook.)
          // Note: only the "js" loader reaches here — json/text/wasm
          // returned above as final ESM.
          source = await applyTransformPlugins(source, fileName, this.plugins);

          const sourceModuleType = detectModuleSystem(source);
          const originalSource = source;

          // Collect maps from each transform for composition.
          // Each map goes from that transform's output back to its input.
          const maps = [];

          if (
            moduleType === "import" &&
            sourceModuleType.isCJS &&
            !sourceModuleType.isESM
          ) {
            const result = convertCjsToEsm(source, { filename: fileName });
            source = result.code;
            if (result.map) maps.push(result.map);
          }

          if (
            moduleType === "require" &&
            !sourceModuleType.isCJS &&
            isNodeBuiltIn
          ) {
            const result = convertEsmToCjs(source, { filename: fileName });
            source = result.code;
            if (result.map) maps.push(result.map);
          }

          if (
            moduleType === "require" &&
            !sourceModuleType.isCJS &&
            !isNodeBuiltIn
          ) {
            source = `throw new Error ("[ERR_REQUIRE_ESM]: Must use import to load ES Module: ... ${fileName}")`;
            // No map for synthetic error throw; position mapping not applicable.
          }

          // replace our special variable for runtime.
          if (isNodeBuiltIn) {
            const result = replaceGlobalThisVar(source, "_RUNTIME_", {
              replacement: `globalThis._RUNTIME${this.uuid}_`,
              filename: fileName,
            });
            source = result.code;
            if (result.map) maps.push(result.map);
          }

          // Todo track parent entry module (in loadModule() & transformModules)
          if (fileName != entryPoint) {
            // console.log('Building ${fileName} for ${entryPoint} - for imported module: ${parentEntryPoint}')
          }

          // For CommonJS modules loaded via require(), keep require() calls
          // intact so the runtime's sync __syncRequire__ handles nested
          // requires (rewriting them to awaited loadModule() calls would
          // break the sync IIFE wrapper with a SyntaxError).
          const preserveRequireCalls =
            moduleType === "require" &&
            sourceModuleType.isCJS &&
            !sourceModuleType.isESM;
          const importResult = transformImportsToLoadModule(
            this.uuid,
            source,
            fileName,
            entryPoint,
            { preserveRequireCalls },
          );
          source = importResult.code;
          if (importResult.map) maps.push(importResult.map);

          // Compose all collected maps into a single map: final output -> original source.
          // remapping() expects the chain ordered LAST transform first, but
          // maps[] is pushed in first-transform-first order, so reverse it.
          // (Wrong order silently yields an empty composed map.)
          if (maps.length > 0) {
            try {
              const composed = remapping([...maps].reverse(), () => null);
              const sourceURL = `sandbox://${this.uuid}/${fileName}`;
              this._sourceMapRegistry.set(sourceURL, {
                map: composed,
                originalSource,
                filename: fileName,
              });
            } catch (mapErr) {
              console.warn(
                "[source-map] Failed to compose maps for",
                fileName,
                mapErr,
              );
            }
          }

          return source;
        },
      );

      this.registerInterop("_getState", async () => {
        function seralize(fn) {
          return JSON.stringify(fn);
        }

        return `
 
 
(function () {

  function EventEmitter() {
    this._events = Object.create(null);
  }

  EventEmitter.prototype.on = function (ev, fn) {
    if (!this._events[ev]) this._events[ev] = [];
    this._events[ev].push({ fn, once: false });
    this.emit('newListener', ev, fn);
    return this;
  };

  EventEmitter.prototype.once = function (ev, fn) {
    if (!this._events[ev]) this._events[ev] = [];
    this._events[ev].push({ fn, once: true });
    this.emit('newListener', ev, fn);
    return this;
  };

  EventEmitter.prototype.off = function (ev, fn) {
    if (!this._events[ev]) return this;
    this._events[ev] = this._events[ev].filter(e => e.fn !== fn);
    this.emit('removeListener', ev, fn);
    return this;
  };
  EventEmitter.prototype.removeListener = EventEmitter.prototype.off;

  EventEmitter.prototype.removeAllListeners = function (ev) {
    if (ev) { delete this._events[ev]; }
    else     { this._events = Object.create(null); }
    // Removal without an explicit 'removeListener' event must still let the
    // completion gate re-check (stdin hooks _checkResolve on removeListener).
    if (typeof this._checkResolve === 'function') this._checkResolve();
    return this;
  };

  EventEmitter.prototype.emit = function (ev, ...args) {
    const list = this._events[ev];
    if (!list || list.length === 0) return false;
    const snapshot = [...list];
    const dropped = list.filter(e => e.once);
    this._events[ev] = list.filter(e => !e.once);
    // Node semantics: a once-listener removed by firing emits
    // 'removeListener'. This releases the stdin completion gate: a one-shot
    // 'data' listener must not hold completion forever after it fires.
    for (const e of dropped) {
      if (ev !== 'removeListener') this.emit('removeListener', ev, e.fn);
    }
    for (const e of snapshot) e.fn(...args);
    return true;
  };

  EventEmitter.prototype.listeners = function (ev) {
    return (this._events[ev] || []).map(e => e.fn);
  };

  EventEmitter.prototype.listenerCount = function (ev) {
    return (this._events[ev] || []).length;
  };

  EventEmitter.prototype.rawListeners = function (ev) {
    return [...(this._events[ev] || [])];
  };

  const stdin = Object.assign(new EventEmitter(), {

    _encoding : null,
    _isRaw    : false,
    _paused   : false,
    _ended    : false,
    _lineBuffer: "",
    _waitResolve : null,
    _waitPromise : null,
    isTTY     : true,
    readable  : true,
    fd        : 0,

    setEncoding(enc) {
      this._encoding = enc;
      return this;
    },

    setRawMode(value) {
      this._isRaw = !!value;
      if (this._isRaw && this._lineBuffer.length > 0) {
        this._dispatch(this._lineBuffer);
        this._lineBuffer = "";
      }
      return this;
    },

    resume() {
      this._paused = false;
      return this;
    },

    pause() {
      this._paused = true;
      return this;
    },

    isPaused() { return this._paused; },
    get isRaw()    { return this._isRaw;  },

    end() {
      if (this._ended) return;
      this._ended = true;
      this.readable = false;
      this.emit('end');
      this.emit('close');
      this._checkResolve();
    },

    destroy(err) {
      if (err) this.emit('error', err);
      this.end();
    },

    _decode(chunk) {
      if (this._encoding && typeof chunk !== 'string')
        return chunk.toString(this._encoding);
      return chunk;
    },

    _dispatch(chunk) {
      const data = this._decode(chunk);
      this.emit('data', data);

      if (typeof data === 'string') {
        if (this._isRaw) {
          // one pushData() call == one physical keypress in raw mode
          const keyEvent = _parseKey(data);
          this.emit('keypress', data, keyEvent);
          if (typeof emitMe === 'function') {
            emitMe('key_event', null, keyEvent);
          }
        } else {
          for (const ch of data) {
            const keyEvent = _parseKey(ch);
            this.emit('keypress', ch, keyEvent);
            if (typeof emitMe === 'function') {
              emitMe('key_event', null, keyEvent);
            }
          }
        }
      }
    },

    _checkResolve() {
      // Count only the events that hold the completion gate (same list as
      // waitUntilNoListeners). The runtime's own internal 'newListener' /
      // 'removeListener' bookkeeping listeners are attached for the whole
      // sandbox lifetime and must not hold completion — counting them made
      // the total unreachable, so listener removal could never release the
      // gate (only stdin.end()/destroy() did).
      const relevant = ['data', 'end', 'close', 'error', 'keypress'];
      const totalListeners = relevant.reduce(
        (n, ev) => n + ((this._events[ev] || []).length), 0);
      if ((this._ended || totalListeners === 0) && this._waitResolve) {
        this._waitResolve();
        this._waitResolve = null;
        this._waitPromise = null;
      }
    },

pushData2(chunk) {
    if (this._ended || this._paused) return;

    if (this._isRaw) {
      this._dispatch(chunk);
      return;
    }

    if (chunk === '\\x7f' || chunk === '\\b') {
      this._lineBuffer = this._lineBuffer.slice(0, -1);
      return;
    }

    this._lineBuffer += chunk;

    const nl = this._lineBuffer.search(/[\\n\\r]/);
    if (nl !== -1) {
      const line = this._lineBuffer.slice(0, nl);
      // Keep everything after the newline in the buffer
      this._lineBuffer = this._lineBuffer.slice(nl + 1);
      this._dispatch(line + '\\n'); // Ensure the newline is preserved/dispatched
    }
  },

 

pushData(chunk) {
  if (this._ended || this._paused) return;

  if (this._isRaw) {
    this._dispatch(chunk);
    return;
  }

  // Non-raw (line-buffered) mode: interpret control chars instead of
  // blindly concatenating them into the line buffer.
  if (chunk === '\\x7f' || chunk === '\\b') {
    this._lineBuffer = this._lineBuffer.slice(0, -1);
    return;
  }

  this._lineBuffer += chunk;

  const nl = this._lineBuffer.search(/[\\n\\r]/);
  if (nl !== -1) {
    // Dispatch only up to (not including) the newline, and keep
    // anything typed after it (rare, but avoids losing/duplicating
    // characters from a chunk that contains more than one line).
    const line = this._lineBuffer.slice(0, nl);
    this._lineBuffer = this._lineBuffer.slice(nl + 1);
    this._dispatch(line);
    emitMe("newline", true)
  }
},

    waitUntilNoListeners() {
      if (this._ended) return Promise.resolve();
      const relevant = ['data','end','close','error','keypress'];
      const count = relevant.reduce(
        (n, ev) => n + this.listenerCount(ev), 0
      );
      if (count === 0) return Promise.resolve();
      if (!this._waitPromise) {
        this._waitPromise = new Promise(res => { this._waitResolve = res; });
      }
      return this._waitPromise;
    },

    read()    { return null; },
    pipe(dest) {
      this.on('data', chunk => dest.write && dest.write(chunk));
      this.on('end',  ()    => dest.end   && dest.end());
      return dest;
    },
    unpipe(dest) { return this; },
    unshift() { },
  });

  stdin.on('removeListener', () => stdin._checkResolve());

  // Flush buffered early stdin input when the first 'data' listener attaches.
  // Deferred via queueMicrotask to avoid reentrancy: 'newListener' fires
  // synchronously from within on(), so pushData must not run until on()
  // has returned and the handler is fully registered.
  stdin.on('newListener', (ev) => {
    if (ev === 'data' && stdin._pendingStdin && stdin._pendingStdin.length) {
      const pending = stdin._pendingStdin;
      stdin._pendingStdin = [];
      queueMicrotask(() => {
        pending.forEach((chunk) => stdin.pushData(chunk));
      });
    }
  });

 //const { Writable } = require('stream');

function makeOutputShim2(type) {
  const isError = type === 'stderr';
  
  // Inherit from Writable to get all internal Node logic for free
  const stream = new Writable({
    decodeStrings: false, // Prevents automatic conversion of strings to buffers
    write(chunk, encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
      
      // Use process.binding or low-level write if you want to avoid console.log
      // but for a shim, this is the safest way to ensure output visibility.
      if (isError) {
        process.stderr.write(data); 
      } else {
        process.stdout.write(data);
      }
      
      // Node specs require calling the callback to signal the write is finished
      callback();
    }
  });

  // TTY Specific properties required by CLI tools (like chalk or inquirer)
  Object.defineProperties(stream, {
    isTTY: { value: true },
    fd: { value: isError ? 2 : 1 },
    columns: { value: process.stdout.columns || 80, writable: true },
    rows: { value: process.stdout.rows || 24, writable: true },
    isRaw: { value: false, writable: true }
  });

  // Mandatory TTY methods for cursor manipulation
  stream.clearLine = (dir, cb) => { if (cb) cb(); return true; };
  stream.cursorTo = (x, y, cb) => { if (cb) cb(); return true; };
  stream.moveCursor = (dx, dy, cb) => { if (cb) cb(); return true; };
  stream.getColorDepth = () => 8; // Reports 256-color support

  return stream;
}

  function makeOutputShim(stream) {
    // Honor a configured initial size (options.process.stdout.columns/rows,
    // serialized into the runtime singleton); falls back to 80x24.
    const rtProcess = globalThis._RUNTIME${this.uuid}_ && globalThis._RUNTIME${this.uuid}_.process;
    const prev = rtProcess && rtProcess[stream];
    const initCols = prev && Number.isFinite(+prev.columns) && +prev.columns > 0
      ? Math.floor(+prev.columns) : 80;
    const initRows = prev && Number.isFinite(+prev.rows) && +prev.rows > 0
      ? Math.floor(+prev.rows) : 24;
    const s = Object.assign(new EventEmitter(), {
      isTTY    : true,
      writable : true,
      fd       : stream === 'stderr' ? 2 : 1,
      columns  : initCols,
      rows     : initRows,
      write(data, enc, cb) {
        console[stream === 'stderr' ? 'error' : 'log'](
          typeof data === 'string' ? data : data.toString(enc || 'utf8')
        );
        if (typeof enc === 'function') enc();
        else if (typeof cb === 'function') cb();
        return true;
      },
      end() {},
      destroy() {},
      clearLine(dir, cb)      { if (cb) cb(); return true; },
      cursorTo(x, y, cb)     { if (cb) cb(); return true; },
      moveCursor(dx, dy, cb) { if (cb) cb(); return true; },
    });
    return s;
  }
  
  //globalThis.process        = globalThis.process || {};
  globalThis.process.stdin  = stdin; 
  globalThis.process.stdout = makeOutputShim('stdout');
  globalThis.process.stderr = makeOutputShim('stderr');
 
  globalThis.process.hrtime.bigint = () => BigInt(Math.floor(performance.now() * 1e6));
 
function _parseKey(s) {
  const specials = {
    '\\x1b[A': 'up', '\\x1b[B': 'down', '\\x1b[C': 'right', '\\x1b[D': 'left',
    '\\x1b[H': 'home', '\\x1b[F': 'end',
    '\\x1b[3~': 'delete', '\\x1b[2~': 'insert',
    '\\x1b[5~': 'pageup', '\\x1b[6~': 'pagedown',
    '\\x1b': 'escape', '\\r': 'return', '\\n': 'return',
    '\\t': 'tab', '\\x7f': 'backspace', '\\b': 'backspace',
  };

  if (specials[s]) {
    return { name: specials[s], ctrl: false, meta: false, shift: false, sequence: s };
  }

  if (s.length === 1) {
    const code = s.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      return { name: String.fromCharCode(code + 96), ctrl: true, meta: false, shift: false, sequence: s };
    }
    return { name: s.toLowerCase(), ctrl: false, meta: false, shift: s !== s.toLowerCase(), sequence: s };
  }

  return { name: 'unknown', ctrl: false, meta: false, shift: false, sequence: s };
}

})();
         `;
      });

      /**
       * Resolve a relative import path against the importing file's location,
       * then look it up in the VFS. Returns { resolvedPath, source } or null.
       *
       * @param {string} modulePath      - e.g. '../math.js'
       * @param {string} fromFile        - e.g. 'src/utils/math2.js'  (the file containing the import)
       * @param {object} vfs             - your nested VFS object
       */
      function resolveVFS(modulePath, fromFile, vfs) {
        // 1. Build an absolute-style path by joining fromFile's dir + modulePath
        const fromDir = fromFile
          ? fromFile.split("/").slice(0, -1).join("/")
          : "";
        const joined = fromDir ? `${fromDir}/${modulePath}` : modulePath;

        // 2. Normalize away . and .. segments
        const parts = joined.split("/");
        const resolved = [];
        for (const part of parts) {
          if (part === "..") resolved.pop();
          else if (part !== ".") resolved.push(part);
        }
        // 3. Ensure absolute VFS path (leading slash) for consistency.
        // Without this, relative resolvedPaths cascade: a relative importer
        // produces a relative resolvedPath, which becomes the next importer.
        let resolvedPath = resolved.join("/");
        if (!resolvedPath.startsWith("/")) resolvedPath = "/" + resolvedPath;

        // 4. Walk the VFS tree
        const source = vfsLookup(resolvedPath, vfs);
        return source != null ? { resolvedPath, source } : null;
      }

      /**
       * Walk a nested VFS object using a normalised path string.
       * Tries the path as-is, then with .js appended.
       * Platform fix (AGENTS.md rule 6): in the browser, prefer
       * `-browser.js` variants over `.cjs` files. Vendors ship both
       * (e.g. rolldown-binding.wasi.cjs for Node, .wasi-browser.js for
       * browsers); the CJS build requires Node builtins that don't exist
       * here. This is platform-general, not library-specific.
       */
      function vfsLookup(path, vfs) {
        const tryPath = (p) => {
          const segments = p.split("/").filter(Boolean);
          let node = vfs;
          for (const seg of segments) {
            if (node == null || typeof node !== "object") return undefined;
            node = node[seg];
          }
          return typeof node === "string" ? node : undefined;
        };

        // Prefer browser variant for .cjs requests.
        if (path.endsWith(".cjs")) {
          const browserVariant = path.replace(/\.cjs$/, "-browser.js");
          const hit = tryPath(browserVariant);
          if (hit !== undefined) return hit;
        }

        return (
          tryPath(path) ??
          tryPath(path.endsWith(".js") ? path : `${path}.js`) ??
          undefined
        );
      }
      /**
       * General WASM data-URL inlining for the package-loading path.
       * Vendored WASM builds reference their binary via
       * `new URL("<rel>.wasm", import.meta.url)`. Modules served by the
       * parent _dynamic_import handler execute from `data:` URLs, where
       * import.meta.url IS the data: URL — relative resolution throws.
       * This rewrites such references to `data:application/wasm;base64,...`
       * using the bytes resolved from the VFS relative to the module's own
       * path. Platform-general (any package), not rollup-specific. A
       * missing/unresolvable wasm file is left untouched (honest miss).
       *
       * Worker scripts: WASI browser builds (e.g. @rolldown/browser) spawn
       * workers via `new URL('./wasi-worker-browser.mjs', import.meta.url)`,
       * which throws the same TypeError from a data: URL base. `.mjs`/`.js`
       * references are inlined as `data:text/javascript;base64,...` — the
       * 1.5KB worker file inlines cleanly; `new Worker(dataUrl)` works.
       */
      function inlineWasmDataUrls(source, moduleVfsPath, vfs) {
        if (typeof source !== "string" || !source.includes("import.meta.url"))
          return source;
        const dir = String(moduleVfsPath || "")
          .split("/")
          .slice(0, -1);
        const lookupNode = (absPath) => {
          const segs = absPath.split("/").filter(Boolean);
          let node = vfs;
          for (const s of segs) {
            if (node == null || typeof node !== "object") return undefined;
            node = node[s];
          }
          return node;
        };
        const mimeFor = (rel) => {
          if (rel.endsWith(".wasm")) return "application/wasm";
          if (rel.endsWith(".mjs") || rel.endsWith(".js"))
            return "text/javascript";
          return null;
        };
        return source.replace(
          /new URL\(\s*(['"])([^'"]*?\.(?:wasm|mjs|js))\1\s*,\s*import\.meta\.url\s*\)/g,
          (m, _q, rel) => {
            const mime = mimeFor(rel);
            if (!mime) return m;
            const parts = [...dir];
            for (const seg of rel.split("/")) {
              if (seg === "..") parts.pop();
              else if (seg !== "." && seg !== "") parts.push(seg);
            }
            const node = lookupNode("/" + parts.join("/"));
            let b64;
            if (
              node &&
              typeof node === "object" &&
              node.encoding === "base64" &&
              typeof node.data === "string"
            ) {
              b64 = node.data;
            } else if (typeof node === "string") {
              // Plain UTF-8 string content (e.g. .mjs worker files in the
              // seed are not base64-enveloped). Encode at rewrite time.
              // btoa handles the ASCII-safe worker script; for general
              // UTF-8 use the TextEncoder path.
              try {
                b64 = btoa(node);
              } catch {
                const bytes = new TextEncoder().encode(node);
                let bin = "";
                for (let i = 0; i < bytes.length; i++)
                  bin += String.fromCharCode(bytes[i]);
                b64 = btoa(bin);
              }
            } else {
              return m; // honest miss: leave the reference alone
            }
            // Wrap in new URL(...) so that `.href` (or other URL accessors)
            // on the original `new URL(rel, import.meta.url)` expression
            // keep working — a bare string literal has no `.href`.
            return `new URL(${JSON.stringify(`data:${mime};base64,${b64}`)})`;
          },
        );
      }
      function toVFSPath(modulePath, fromFile) {
        // IDEMPOTENT (vitest E2E gap #1): an already-resolved VFS path — anything
        // not starting with ./ or ../ — is returned as-is. Re-joining it against
        // the parent dir doubles the path ('a/b/x.js' resolved from 'a/b/y.js'
        // became 'a/b/a/b/x.js'), which broke nested relative imports at depth ≥2.
        const isRelativeRequest =
          modulePath.startsWith("./") || modulePath.startsWith("../");
        if (!isRelativeRequest)
          return modulePath.replace(/^\.\//, "").replace(/^\/+/, "");
        const fromDir = fromFile
          ? fromFile.split("/").slice(0, -1).join("/")
          : "";
        const joined = fromDir ? `${fromDir}/${modulePath}` : modulePath;

        const parts = joined.replace(/^\.\//, "").split("/");
        const resolved = [];
        for (const part of parts) {
          if (part === "..") resolved.pop();
          else if (part !== ".") resolved.push(part);
        }
        return resolved.join("/");
      }

      // --- Package exports/imports resolution (gap #2) ---
      // Node's PACKAGE_EXPORTS_RESOLVE / PACKAGE_IMPORTS_RESOLVE, browser-VFS
      // edition. Condition order mirrors Node's ESM-import defaults — the
      // runtime emulates Node in the browser, so 'node' wins over 'browser'.
      const PACKAGE_CONDITIONS = ["node", "import", "default"];
      // Node parity: require()/require.resolve() resolve 'exports' with the
      // require condition set; import uses the import set. The _dynamic_import
      // interop receives type ("import" | "require") from the sandbox loader.
      function packageConditionsFor(type) {
        return type === "require"
          ? ["node", "require", "default"]
          : PACKAGE_CONDITIONS;
      }

      function splitPackageSpecifier(importPath) {
        // '@scope/pkg/sub/deep' -> { packageName: '@scope/pkg', subpath: './sub/deep' }
        if (importPath.startsWith("@")) {
          const parts = importPath.split("/");
          const packageName = parts.slice(0, 2).join("/");
          const rest = parts.slice(2).join("/");
          return { packageName, subpath: rest ? "./" + rest : "." };
        }
        const idx = importPath.indexOf("/");
        if (idx === -1) return { packageName: importPath, subpath: "." };
        return {
          packageName: importPath.slice(0, idx),
          subpath: "." + importPath.slice(idx),
        };
      }

      function resolvePackageTarget(target, conditions) {
        // string | null (blocked subpath) | string[] (fallback chain) | { condition: target }
        if (target === null || target === undefined) return null;
        if (typeof target === "string") return target;
        if (Array.isArray(target)) {
          for (const t of target) {
            const r = resolvePackageTarget(t, conditions);
            if (r !== null) return r;
          }
          return null;
        }
        if (typeof target === "object") {
          for (const cond of conditions) {
            if (Object.prototype.hasOwnProperty.call(target, cond)) {
              const r = resolvePackageTarget(target[cond], conditions);
              if (r !== null) return r;
            }
          }
          return null;
        }
        return null;
      }

      function resolvePackageExports(pkgJson, subpath, conditions) {
        conditions = conditions || PACKAGE_CONDITIONS;
        const exportsField = pkgJson.exports;
        if (exportsField === null || exportsField === undefined) return null;
        let target;
        if (typeof exportsField === "string") {
          if (subpath !== ".") return null;
          target = exportsField;
        } else if (
          typeof exportsField === "object" &&
          !Array.isArray(exportsField)
        ) {
          const keys = Object.keys(exportsField);
          const isSugar =
            keys.length > 0 && keys.every((k) => !k.startsWith("."));
          if (isSugar) {
            // Condition-only object: the main entry.
            if (subpath !== ".") return null;
            target = exportsField;
          } else if (
            Object.prototype.hasOwnProperty.call(exportsField, subpath)
          ) {
            target = exportsField[subpath];
          } else {
            // Longest pattern-key ('./x/*') match.
            let best = null;
            for (const key of keys) {
              if (key.endsWith("/*")) {
                const prefix = key.slice(0, -1);
                if (
                  subpath.startsWith(prefix) &&
                  (best === null || key.length > best.length)
                ) {
                  best = key;
                }
              }
            }
            if (best === null) return null;
            const star = subpath.slice(best.length - 1);
            const patternTarget = resolvePackageTarget(
              exportsField[best],
              conditions,
            );
            if (typeof patternTarget !== "string") return null;
            return patternTarget.replace(/\*/g, star);
          }
        } else {
          return null;
        }
        const resolved = resolvePackageTarget(target, conditions);
        return typeof resolved === "string" ? resolved : null;
      }

      function resolvePackageImports(
        importPath,
        importerPath,
        vfs,
        conditions,
      ) {
        conditions = conditions || PACKAGE_CONDITIONS;
        // Nearest parent package.json scope wins; a scope without an
        // 'imports' field means the specifier is unresolvable (Node parity).
        const segments = importerPath ? importerPath.split("/") : [];
        segments.pop();
        while (true) {
          const pkgPath = [...segments, "package.json"].join("/");
          const hit = resolveVFS(pkgPath, "", vfs);
          if (hit && hit.source) {
            let pkg = null;
            try {
              pkg = JSON.parse(hit.source);
            } catch (e) {
              /* invalid package.json */
            }
            if (pkg && pkg.imports && typeof pkg.imports === "object") {
              const keys = Object.keys(pkg.imports);
              let target;
              if (
                Object.prototype.hasOwnProperty.call(pkg.imports, importPath)
              ) {
                target = pkg.imports[importPath];
              } else {
                let best = null;
                for (const key of keys) {
                  if (
                    key.endsWith("/*") &&
                    importPath.startsWith(key.slice(0, -1)) &&
                    (best === null || key.length > best.length)
                  ) {
                    best = key;
                  }
                }
                if (best === null) return null;
                const star = importPath.slice(best.length - 1);
                const patternTarget = resolvePackageTarget(
                  pkg.imports[best],
                  conditions,
                );
                if (typeof patternTarget !== "string") return null;
                target = patternTarget.replace(/\*/g, star);
              }
              const resolved = resolvePackageTarget(target, conditions);
              if (typeof resolved !== "string" || !resolved.startsWith("./"))
                return null;
              const dir = segments.join("/");
              const rel = resolved.slice(2);
              return resolveVFS(dir ? dir + "/" + rel : rel, "", vfs);
            }
            return null;
          }
          if (segments.length === 0) break;
          segments.pop();
        }
        return null;
      }
      // --- end package exports/imports (gap #2) ---

      this.registerInterop(
        "_dynamic_import",
        async (
          path,
          type,
          entryPoint,
          parentEntryPoint,
          isNodeBuiltIn,
          cwd,
        ) => {
          const vfs = {
            src: {
              utils: {
                "math.js": "export const add = (a, b) => a + b;",
                "math2.js": "import {add} from '../main2.js'; console.log(add)",
              },
              "main.js":
                "import { add } from './utils/math.js'; import helper from 'my-lib'; console.log(add(1, 2), helper); export {add}",
              "main2.js": `console.log('hello')`,
              node_modules: {
                "my-lib": {
                  "package.json": '{"main": "dist/index.js"}',
                  dist: {
                    "index.js":
                      "export default 'Hello from local node_modules package!';",
                  },
                },
              },
            },
            node_modules: {
              "lodash-es": {
                "index.js":
                  "export function cloneDeep(val) { return JSON.parse(JSON.stringify(val)); }",
              },
            },
            "require.js": `exports.add = (a, b) => a + b;
  exports.msg = 'Hello from CommonJS!';`,
            "test.js": "console.log('root file');",
            "package.json": '{"name": "sandbox"}',
          };

          // 1. For Node built-ins, hand off to your shim resolver as before
          if (isNodeBuiltIn) {
            // For builtins, try local dist first, then CDN, then generic stub.
            try {
              const src = await fetchBuiltinSource(path);
              return { source: src, resolvedPath: null };
            } catch (e) {
              // Fallback: generic stub for missing builtins
              return { source: `export default {};`, resolvedPath: null };
            }
          }

          // 2. Determine the importer's VFS path
          const importerVFSPath = entryPoint
            ? toVFSPath(entryPoint, parentEntryPoint)
            : (parentEntryPoint ?? "");

          const isRelative = path.startsWith("./") || path.startsWith("../");

          // 3. Handle Bare Specifiers (node_modules lookup)
          if (!isRelative) {
            const resolvedPackage = resolveNodeModule(
              path,
              importerVFSPath,
              vfs,
            );
            if (resolvedPackage) {
              console.log(`Resolved from node_modules: ${path}`);
              return resolvedPackage.source;
            }
            return null; // Fall through if package is completely missing
          }

          // 4. Handle Relative Paths
          const result = resolveVFS(path, importerVFSPath, vfs);
          if (!result) {
            throw new Error(
              `[ERR_MODULE_NOT_FOUND]: Cannot find module '${path}' (imported from '${importerVFSPath}')`,
            );
          }

          console.log(result, path);
          return result.source;
        },
      );

      // Hoisted VFS helpers for the real '_dynamic_import' below. The sandbox
      // used to post its entire __USER_FILES__ seed (~22MB with the WASM
      // shims) on every call; structured-cloning that through postMessage
      // stalled bootstrap for minutes (~30 eager builtin preloads x ~7s).
      // The iframe copy is never mutated at runtime (fs writes land in the
      // memfs Volume, not __USER_FILES__), so it is always identical to the
      // host's config.fs. Serve from the host seed (zero clone); honor an
      // explicitly-passed VFS only when the host has no seed of its own.
      function unflattenFileSystem(flatObj) {
        const result = {};

        for (const [rawPath, value] of Object.entries(flatObj)) {
          // User file keys may be '/lib/util.js' or 'lib/util.js'; resolution
          // walks segments without a leading slash, so normalize here. Without
          // this, '/lib/util.js'.split('/') yields a phantom '' root segment and
          // every lookup misses (MODULE_NOT_FOUND).
          const parts = String(rawPath).replace(/^\/+/, "").split("/");
          let current = result;

          // Traverse (or create) folders until the last segment (the file name)
          for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (!current[part] || typeof current[part] !== "object") {
              current[part] = {};
            }
            current = current[part];
          }

          // Assign the file content to the final key
          current[parts[parts.length - 1]] = value;
        }

        return result;
      }

      function pickDynamicImportVfs(passedVfs, hostSeed, unflatten) {
        const hostEmpty =
          !hostSeed ||
          typeof hostSeed !== "object" ||
          Object.keys(hostSeed).length === 0;
        if (
          hostEmpty &&
          passedVfs &&
          typeof passedVfs === "object" &&
          Object.keys(passedVfs).length > 0
        ) {
          return unflatten(passedVfs);
        }
        return unflatten(hostSeed || {});
      }

      this.registerInterop(
        "_dynamic_import",
        async (
          path,
          type,
          entryPoint,
          parentEntryPoint,
          isNodeBuiltIn,
          cwd,
          vfs = {},
        ) => {
          // Serve from the host's own seed: the sandbox no longer ships its
          // __USER_FILES__ across postMessage (see pickDynamicImportVfs).
          // 'this' is the CodeSandbox instance (arrow closure over execute()).
          vfs = pickDynamicImportVfs(vfs, this.config.fs, unflattenFileSystem);

          // Normalize file:// URLs (e.g. Vite's await import(pathToFileURL(p).href))
          // to absolute VFS paths before classification.
          if (path.startsWith("file://")) {
            path = path.slice("file://".length);
            if (!path.startsWith("/")) path = "/" + path;
          }

          // 1. For Node built-ins, hand off to your shim resolver as before.
          // resolvedPath is null: builtins aren't VFS files, so the sandbox keeps
          // using the request path as the build fileName (unchanged behavior).
          if (isNodeBuiltIn) {
            try {
              const builtinSource = await fetchBuiltinSource(path);
              return { source: builtinSource, resolvedPath: null };
            } catch (e) {
              // Shim missing or unfetchable: honest generic stub, never throw.
              return { source: `export default {};`, resolvedPath: null };
            }
          }

          // 2. Determine the importer's VFS path
          const importerVFSPath = entryPoint
            ? toVFSPath(entryPoint, parentEntryPoint)
            : (parentEntryPoint ?? "");

          // Part B plugin hook: onResolve — first match wins. A plugin may
          // rewrite the specifier (default loading uses the new path) and/or
          // tag a namespace (re-derived in _build_file for onLoad matching).
          // PluginError propagates via the interop error channel.
          const __pr = await applyResolvePlugins(
            path,
            importerVFSPath,
            this.plugins,
          );
          if (__pr && typeof __pr.path === "string" && __pr.path !== path) {
            path = __pr.path;
          }

          const isRelative = path.startsWith("./") || path.startsWith("../");
          const isAbsolute = path.startsWith("/");

          // Canonical package-loading path: every VFS-served module goes
          // through here, so vendored WASM builds get their
          // `new URL(<rel>.wasm, import.meta.url)` references inlined as
          // data: URLs before the child executes the source from a data:
          // URL (where relative resolution would throw).
          const serve = (hit) =>
            hit && typeof hit.source === "string"
              ? {
                  source: inlineWasmDataUrls(hit.source, hit.resolvedPath, vfs),
                  resolvedPath: hit.resolvedPath,
                }
              : hit;

          // 3a. Package-internal # imports (gap #2): resolve via the nearest
          // package.json 'imports' field before the node_modules walk.
          if (path.startsWith("#")) {
            const resolvedImport = resolvePackageImports(
              path,
              importerVFSPath,
              vfs,
              packageConditionsFor(type),
            );
            if (resolvedImport) {
              return serve(resolvedImport);
            }
            return null;
          }

          // 3. Handle Bare Specifiers (node_modules lookup)
          // Absolute VFS paths (isAbsolute) bypass this branch — they are
          // resolved directly against the VFS, not via package lookup.
          if (!isRelative && !isAbsolute) {
            // Vendor browser/WASM builds for native-only packages (real
            // Vite 7: rollup → @rollup/browser, esbuild → esbuild-wasm
            // shim). Opt-in via the vite-browser plugin (Jared 2026-10-04).
            // Specifier-based, so ESM 'import 'rollup'' resolves
            // exactly like CJS require('rollup') (src/module.js). The table
            // is static — no VFS-presence gate needed: this handler only
            // runs when serving the browser runtime's VFS.
            const intercepted = isViteBrowserInterceptionActive()
              ? lookupNativeInterception(path)
              : null;
            if (intercepted) {
              const hit = resolveVFS(intercepted, "", vfs);
              if (hit) {
                return serve(hit);
              }
              // Target not seeded in this VFS: fall through to the normal
              // lookup so the miss stays an honest MODULE_NOT_FOUND.
            }
            const resolvedPackage = resolveNodeModule(
              path,
              importerVFSPath,
              vfs,
              type,
            );
            if (resolvedPackage) {
              console.log(`Resolved from node_modules: ${path}`);
              return serve(resolvedPackage);
            }
            return null; // Fall through if package is completely missing
          }

          // 3b. Handle Absolute VFS Paths (e.g. '/node_modules/terser/...').
          // Resolve directly against the VFS root, ignoring the importer.
          // (Vite's loadTerserPath does await import(pathToFileURL(...))
          // which the sandbox normalizes to an absolute VFS path.)
          if (isAbsolute) {
            const absResult = resolveVFS(path, "", vfs);
            if (!absResult) {
              throw new Error(
                `[ERR_MODULE_NOT_FOUND]: Cannot find module '${path}' (absolute VFS path)`,
              );
            }
            // Gap #1: return the resolved VFS path alongside the source.
            return serve(absResult);
          }

          // 4. Handle Relative Paths
          const result = resolveVFS(path, importerVFSPath, vfs);
          if (!result) {
            throw new Error(
              `[ERR_MODULE_NOT_FOUND]: Cannot find module '${path}' (imported from '${importerVFSPath}')`,
            );
          }

          // Gap #1: return the resolved VFS path alongside the source so the sandbox
          // can thread it into _build_file as the nested entryPoint.
          return serve(result);
        },
      );

      function resolveNodeModule(importPath, importerPath, vfs, type) {
        // The sandbox loader passes type ("import" | "require"); require()
        // resolves 'exports' with the require condition set (Node parity).
        const conditions = packageConditionsFor(type);
        // Split off any subpath so package.json 'exports' can resolve it (gap #2).
        const { packageName, subpath } = splitPackageSpecifier(importPath);

        // Extract directory path from the importer
        const segments = importerPath ? importerPath.split("/") : [];
        segments.pop(); // Remove the file name to get the parent directory

        // Walk up the directory tree looking for node_modules
        while (true) {
          // Build candidate path: [dir1, dir2, ..., "node_modules", packageName]
          const candidatePath = [
            ...segments,
            "node_modules",
            ...packageName.split("/"),
          ].join("/");

          // Attempt resolution at this level using your existing VFS resolver
          const resolved = tryResolveFileOrPackage(
            candidatePath,
            subpath,
            vfs,
            conditions,
          );
          if (resolved) return resolved;

          // Stop if we've reached the root
          if (segments.length === 0) break;
          segments.pop();
        }

        // Final fallback: Check root-level node_modules if not found via traversal
        return tryResolveFileOrPackage(
          `node_modules/${packageName}`,
          subpath,
          vfs,
          conditions,
        );
      }

      // Helper to resolve a package root + subpath. The 'exports' field wins when
      // present (gap #2 — the only legal route per Node); otherwise legacy
      // file/main/index.js probing. (Legacy order also corrected to Node parity:
      // package.json 'main' now beats a sibling index.js.)
      function tryResolveFileOrPackage(packageRoot, subpath, vfs, conditions) {
        const pkgJsonCheck = resolveVFS(`${packageRoot}/package.json`, "", vfs);
        let pkg = null;
        if (pkgJsonCheck && pkgJsonCheck.source) {
          try {
            pkg = JSON.parse(pkgJsonCheck.source);
          } catch (e) {
            // Invalid package.json — fall through to legacy probing
          }
        }

        // 1. Package 'exports' field (gap #2).
        if (pkg && pkg.exports) {
          const target = resolvePackageExports(pkg, subpath, conditions);
          if (typeof target === "string" && target.startsWith("./")) {
            return resolveVFS(`${packageRoot}/${target.slice(2)}`, "", vfs);
          }
          return null; // not exported (or blocked) — honest miss
        }

        // 2. Legacy: subpath as a direct file.
        if (subpath !== ".") {
          const rel = subpath.slice(2);
          const subCheck =
            resolveVFS(`${packageRoot}/${rel}`, "", vfs) ||
            resolveVFS(`${packageRoot}/${rel}.js`, "", vfs) ||
            resolveVFS(`${packageRoot}/${rel}/index.js`, "", vfs);
          if (subCheck) return subCheck;
        }

        // 3. Legacy: package.json main, then index.js.
        const mainFile = (pkg && pkg.main) || "index.js";
        return (
          resolveVFS(`${packageRoot}/${mainFile}`, "", vfs) ||
          resolveVFS(`${packageRoot}/index.js`, "", vfs)
        );
      }

      this.registerInterop(
        "_dynamic_import2",
        async (
          path,
          type,
          entryPoint,
          parentEntryPoint,
          isNodeBuiltIn,
          cwd,
        ) => {
          // console.log(parentEntryPoint)
          //  console.log(path, type, entryPoint, parentEntryPoint, isNodeBuiltIn, cwd) // "./test2" "import" "./test" "./mathjs.js" false "./"

          if (path === "./serialize") {
            // serialize helper loaded lazily
            return await loadBuiltin("serialize").catch(() => ({
              default: {},
            }));
          }

          if (isNodeBuiltIn) {
            // Lazy-load built-in on demand. Only the requested module's
            // dist file is fetched, not the full 6.8MB bundle.
            return await loadBuiltin(path);
          }

          if (isNodeBuiltIn) {
            return `throw new Error("Not implemented.")`;
          }

          if (path.includes("./test")) {
            return `
           import coolBeanMsg from "./test2"
           export function coolBeans(){
              return coolBeanMsg()
             } 
            console.log(import.meta.url)
             Promise.reject(new Error('Something broke!'));
           `;
          }
        },
      );

      if (!this.iframeElement) {
        document.body.appendChild(iframe);
      }

      let runtimeCode;

      try {
        // Resolve imports
        let { imports, cleanedCode, cleanedImports, hasImports } =
          this.importResolver.resolve(code);

        // Apply code transformers (todo: add assert type support?)
        /*let transformedCode = CodeTransformer.transform(
          cleanedCode,
          this.config.codeTransformers
        );*/
        //  let transformedCode = code;

        // Live bindings (2026-10-09): the entry's static imports are
        // transformed TOGETHER WITH the entry body in a single
        // transformImportsToLoadModule call, so references to imported
        // bindings compile to live member access (`__lm_N.x`) on the same
        // lifted vars whose `await loadModule(...)` preamble is hoisted to
        // %%IMPORTS%% (init scope). The old shape — transforming each
        // import statement separately into a preload — emitted
        // `const { x } = __lm` snapshots; with live bindings the preload
        // emits no binding at all, which would leave the body's references
        // dangling (ReferenceError). Both scopes share the sandbox IIFE,
        // so the body's `__lm_N.x` resolves to the preamble's lifted vars.
        const combinedCode =
          imports.length > 0
            ? imports.join("\n") + "\n" + cleanedCode
            : cleanedCode;

        // Generate runtime code

        //  transformedCode =  transformedCode.replaceAll("await import", "await loadModule")

        // Transform Relative Imports (this can be removed when merged into one function)
        // transformedCode =  transformRelativeModule(transformedCode)

        function containsNodeTest(obj) {
          const target = "node:test";
          const lists = ["imports", "dynamicImports", "requires"];

          return lists.some((listName) => {
            return (
              Array.isArray(obj[listName]) && obj[listName].includes(target)
            );
          });
        }

        function isTestFile(src) {
          return /['"]node:test['"]/.test(src);
        }

        // Transform the main entry code and capture its source map for error mapping.
        // (combinedCode: the entry's static imports + body, transformed
        // together for live bindings — see above.)
        const mainTransform = transformImportsToLoadModule(
          this.uuid,
          combinedCode,
          this.config.fileName,
        );
        if (mainTransform.map) {
          const sourceURL = `sandbox://${this.uuid}/${this.config.fileName}`;
          this._sourceMapRegistry.set(sourceURL, {
            map: mainTransform.map,
            originalSource: combinedCode,
            filename: this.config.fileName,
          });
        }

        runtimeCode = SandboxRuntime.generate(mainTransform.body, {
          imports: mainTransform.preamble ? [mainTransform.preamble] : [],
          logNetworkRequests: this.config.logNetworkRequests,
          interopVariable: this.config.interopVariable,
          process: this.config.process,
          isTest: containsNodeTest(cleanedImports),
          fileName: this.config.fileName,
          uuid: this.uuid,
          fs: flattenFileTree(this.config.fs),
          seaAssets: normalizeSeaAssets(this.config.seaAssets),
          shell: this.config.shell,
        });

        // Setup timeout
        const timeoutId = setTimeout(() => {
          context.forceKill(`Execution timeout after ${this.config.timeout}ms`);
          context.cleanup();
          this.emit("execution:timeout", { id: executionId });
          reject(new Error(`Execution timeout after ${this.config.timeout}ms`));
        }, this.config.timeout);

        context.cleanupCallbacks.push(() => clearTimeout(timeoutId));

        // Listen for results
        context.listen(
          (result) => {
            this.emit("execution:complete", { id: executionId, result });
            resolve(result);
          },
          (error) => {
            this.emit("execution:error", {
              id: executionId,
              error: error.message,
            });
            reject(error);
          },
        );

        // Inject and execute
        context.inject(runtimeCode, hasImports);
      } catch (err) {
        const loc = err?.loc;
        const message = err?.message;
        console.log(err);
        // If code generation itself failed (e.g. a syntax error in the user's
        // code), runtimeCode was never assigned — skip the source-mapping and
        // reject with the original error instead of crashing here.
        if (runtimeCode) {
          const line = runtimeCode
            .slice(0, runtimeCode.indexOf("//__$PROVIDED_RUNTIME_CODE__/"))
            .split("\n").length;

          if (loc) {
            let runtimeError = false;

            try {
              new SyntaxChecker().check(runtimeCode); // error in the runtime code..
            } catch (err) {
              if (line < err.loc.line != true) {
                runtimeError = true;
              } else {
                //   err.loc.line = err.loc.line - line; TODO: Assign proper line and user code not runtime code
              }
              code = runtimeCode;
            }

            if (runtimeError) {
              err.message = `RUNTIME ERROR: ${err.message}`;
            }

            err = formatErrors(code, err);
          }
        } // end if (runtimeCode)
        context.cleanup();
        this.emit("execution:error", { id: executionId, error: err.message });
        reject(err);
      } finally {
        runtimeCode = null;
      }
    });
  }

  /**
   * Execute code and return formatted output
   */
  async run(code) {
    try {
      const result = await this.execute(code);

      if (result.success) {
        return `✓ Execution successful (${result.executionTime}ms)\n${result.logs.join("\n")}`;
      } else {
        return `✗ Execution failed\nError: ${result.error}\n${result.stack || ""}`;
      }
    } catch (err) {
      return `✗ Fatal error\n${err.message}\n${err.stack || ""}`;
    }
  }

  /**
   * Run a wasm32-wasi (preview1) module against the sandbox's VFS.
   *
   * First-class host API (roadmap §1): instantiates the binary with the
   * sandbox's `config.fs` seeded at the guest preopen dir (default
   * `/sandbox`), captures stdout/stderr, and writes the post-run file
   * snapshot back into `config.fs`.
   *
   * @param {Uint8Array|ArrayBuffer} bytes — the .wasm binary
   * @param {object} [options]
   * @param {string[]} [options.args] — argv (argv[0] = program name)
   * @param {Record<string,string>} [options.env] — environment variables
   * @param {string} [options.preopenDir] — guest mount point (default "/sandbox")
   * @returns {Promise<{exitCode:number, stdout:string[], stderr:string[],
   *   files:Record<string,Uint8Array>}>}
   *
   * @example
   * const { exitCode, stdout } = await sandbox.runWasi(wasmBytes, {
   *   args: ["prog.wasm", "foo"], env: { HOME: "/sandbox" },
   * });
   */
  async runWasi(bytes, options = {}) {
    // Lazy: the WASI engine (~100KB bundled) loads only when runWasi is
    // used. The module is browser-safe (no bare specifiers — it selects
    // ../wasi.js under Node, ../../dist/wasi.js in a browser host).
    const { runWasi } = await import("./src/runtime/runwasi.js");
    const { preopenDir = "/sandbox", ...rest } = options;
    const result = await runWasi(bytes, {
      ...rest,
      preopenDir,
      files: this.config.fs || {},
    });
    // Write the guest's file changes back into the sandbox VFS seed so
    // subsequent execute()/runWasi() calls observe them.
    for (const [p, data] of Object.entries(result.files)) {
      this.config.fs[p] = data;
    }
    return result;
  }

  /**
   * Mount a registered toolchain's sysroot into the sandbox VFS seed.
   *
   * Merges the sysroot file map under `/.sysroot/<name>/...` (idempotent).
   * Read-only by convention — hosts must not write under the prefix; the
   * read-only lazy mount follow-up seam will enforce it. String (VFS path)
   * sysroots throw until that seam lands (see src/toolchain.js).
   *
   * @param {string} name — toolchain name
   * @returns {Promise<string>} the mount prefix
   */
  async mountToolchainSysroot(name) {
    const { requireToolchain, mountSysrootIntoSeed } =
      await import("./src/toolchain.js");
    const tc = requireToolchain(name);
    this.config.fs = this.config.fs || {};
    return mountSysrootIntoSeed(tc, this.config.fs);
  }

  /**
   * Compile sources with a registered toolchain plugin (roadmap §1).
   *
   * Mounts the toolchain's sysroot into the sandbox VFS, then calls the
   * toolchain's `compile(files, opts)` per the docs/TOOLCHAIN.md contract.
   * The host page owns the toolchain — core never ships one.
   *
   * @param {string} name — toolchain name (see registerToolchain)
   * @param {Record<string,string|Uint8Array>} files — `{ "main.c": "..." }`
   * @param {object} [opts] — compile opts (cflags, ldflags, target, entry…)
   * @returns {Promise<{bytes:Uint8Array, warnings:Array, errors:Array,
   *   stdout:string, stderr:string, elapsedMs:number|undefined}>}
   *
   * @example
   * const { bytes } = await sandbox.compileToolchain("wasi-clang",
   *   { "add.c": "int add(int a,int b){return a+b;}" }, { cflags: ["-O2"] });
   * await sandbox.runWasi(bytes, { args: ["add.wasm"] });
   */
  async compileToolchain(name, files, opts = {}) {
    const { requireToolchain, compileWithToolchain, mountSysrootIntoSeed } =
      await import("./src/toolchain.js");
    const tc = requireToolchain(name);
    this.config.fs = this.config.fs || {};
    const sysrootMount = mountSysrootIntoSeed(tc, this.config.fs);
    return compileWithToolchain(tc, files, { ...opts, sysrootMount });
  }

  /**
   * Compile with a registered toolchain and immediately run the result
   * through runWasi (roadmap §1: compile sources → wasm bytes → run).
   *
   * `opts.args` / `opts.env` / `opts.preopenDir` go to runWasi; every other
   * opt goes to the toolchain's compile().
   *
   * @returns {Promise<{exitCode:number, stdout:string[], stderr:string[],
   *   files:Record<string,Uint8Array>}>} — the runWasi result
   */
  async runToolchain(name, files, opts = {}) {
    const { args, env, preopenDir, ...compileOpts } = opts;
    const { bytes } = await this.compileToolchain(name, files, compileOpts);
    return this.runWasi(bytes, { args, env, preopenDir });
  }

  /**
   * Opt-in true type-checking over the sandbox's TypeScript VFS files.
   *
   * Runs a full `ts.createProgram` via the registered plugin's
   * `typecheck(files)` hook (docs/PLUGINS.md Part B §4) and returns
   * diagnostics. This is the slow path: it NEVER runs as part of
   * execute() — the transpile-only transform stays the default, so type
   * errors never block execution unless the host asks.
   *
   * @param {{libs?: string[], libBase?: string}} [options] forwarded to
   *   the plugin hook (lib entry points; browser-lane CDN base override).
   * @returns {Promise<Array<{file, line, column, message, code}>>}
   *   line/column are 1-based; null for global diagnostics. [] when no
   *   plugin with a typecheck hook is registered.
   */
  async typecheck(options = {}) {
    const plugin = getPlugins().find((p) => typeof p.typecheck === "function");
    if (!plugin) return [];
    const flat = flattenFileTree(this.config.fs || {});
    const files = [];
    for (const [key, value] of Object.entries(flat)) {
      if (typeof value !== "string") continue; // skip binary/envelope leaves
      files.push({
        path: key.startsWith("/") ? key : "/" + key,
        contents: value,
      });
    }
    return plugin.typecheck(files, options);
  }

  /**
   * Get sandbox statistics
   */
  getStats() {
    return {
      executionCount: this.executionCount,
      initialized: this.initialized,
      config: { ...this.config },
    };
  }

  /**
   * Reset sandbox state
   */
  reset() {
    this.importResolver.clearCache();
    this.executionCount = 0;
    this.emit("reset", { timestamp: Date.now() });
  }

  /**
   * Update the sandbox terminal size at runtime.
   *
   * Requires a live sandbox (same constraint as invoke('__stdin__', …):
   * throws "Sandbox is not running." when called before init() or when no
   * execution is active. Emits 'terminal:resize' with { cols, rows } on
   * success; the sandbox also fires Node's 'resize' event on
   * process.stdout/process.stderr so readline and guest listeners react.
   */
  async setTerminalSize(cols, rows) {
    cols = Math.floor(Number(cols));
    rows = Math.floor(Number(rows));
    if (
      !Number.isFinite(cols) ||
      cols <= 0 ||
      !Number.isFinite(rows) ||
      rows <= 0
    ) {
      throw new Error(
        "setTerminalSize requires positive integer columns and rows",
      );
    }
    const result = await this.invoke("__terminal_resize__", { cols, rows });
    const size = { cols: result.cols, rows: result.rows };
    this._terminalSize = size;
    this.emit("terminal:resize", size);
    return size;
  }
}

// ============================================================================
// CONVENIENCE API
// ============================================================================

/**
 * Quick execution without configuration
 */
export async function executeCode(code, options = {}) {
  const sandbox = new CodeSandbox(options);
  await sandbox.init();
  return sandbox.execute(code);
}

/**
 * Create a configured sandbox instance
 */
export function createSandbox(options = {}) {
  return new CodeSandbox(options);
}

// NOTE: The demo playground (module-level example CodeSandbox, event
// handlers, and the `examples` snippet map) lived here. It moved to
// src/ui/playground.js — runtime.js is a pure library with no demo UI.

// NOTE: The playground DOM helpers (getArgv, toggleArgvInput, filesDiv,
// initPlayground, and the __BVM_DISABLE_PLAYGROUND auto-init guard) lived
// here. They moved to src/ui/playground.js.

// ---------------------------------------------------------------------------
// Shared error-formatting helpers. Used by core sandbox code (acorn
// parse-error paths at module top level), so they must stay at module scope
// and never move inside the demo-playground init below. (Vitest gap #0
// reorganization: previously interleaved with the playground init.)

class FormattedError extends Error {
  constructor(originalError, formattedMessage) {
    super(formattedMessage);

    // Preserve original error properties
    this.name = originalError.name || "Error";
    this.originalMessage = originalError.message;
    this.code = originalError.code;
    this.stack = originalError.stack;

    // Attach the formatted message as well
    this.formattedMessage = formattedMessage;

    // Copy any extra properties
    Object.keys(originalError).forEach((key) => {
      if (!(key in this)) {
        this[key] = originalError[key];
      }
    });
  }

  toString() {
    return this.formattedMessage || this.message;
  }
}

export function formatErrors(code, err) {
  const message = err?.message || "Unknown error";

  function _getContext(lines, lineNum, contextSize = 2) {
    const start = Math.max(0, lineNum - contextSize - 1);
    const end = Math.min(lines.length, lineNum + contextSize);

    return lines
      .slice(start, end)
      .map((line, idx) => {
        const actualLine = start + idx + 1;
        const marker = actualLine === lineNum ? "→" : " ";
        return `${marker} ${actualLine.toString().padStart(4)} | ${line}`;
      })
      .join("\n");
  }

  // Support multiple error formats
  const loc =
    err?.loc ||
    err?.location ||
    err?.loc?.start ||
    (err?.location?.start && err.location.start) ||
    null;

  let formattedMessage = message;

  if (loc && code) {
    const lines = code.split("\n");
    const lineText = lines[loc.line - 1] || "";
    const unexpectedChar = lineText[loc.column] || "EOF";
    const context = _getContext(lines, loc.line);

    formattedMessage = [
      `${err.name || "SyntaxError"}: ${message}`,
      `at line ${loc.line}, column ${loc.column}`,
      `${message}: '${unexpectedChar}'`,
      "",
      context,
    ].join("\n");
  }

  return new FormattedError(err, formattedMessage);
}

function formatErrors2(code, err) {
  const message = err?.message || "Unknown error";

  function _getContext(lines, lineNum, contextSize = 2) {
    const start = Math.max(0, lineNum - contextSize - 1);
    const end = Math.min(lines.length, lineNum + contextSize);

    return lines
      .slice(start, end)
      .map((line, idx) => {
        const actualLine = start + idx + 1;
        const marker = actualLine === lineNum ? "→" : " ";
        return `${marker} ${actualLine.toString().padStart(4)} | ${line}`;
      })
      .join("\n");
  }

  // Support multiple error formats
  const loc =
    err?.loc ||
    err?.location ||
    err?.loc?.start ||
    (err?.location?.start && err.location.start) ||
    null;

  let formattedMessage = message;

  if (loc && code) {
    const lines = code.split("\n");
    const lineText = lines[loc.line - 1] || "";
    const unexpectedChar = lineText[loc.column] || "EOF";
    const context = _getContext(lines, loc.line);

    formattedMessage = [
      `${err.name || "SyntaxError"}: ${message}`,
      `at line ${loc.line}, column ${loc.column}`,
      `${message}: '${unexpectedChar}'`,
      "",
      context,
    ].join("\n");
  }

  return new FormattedError(err, formattedMessage);
}

// 2. Then declare your helper function and main function

// Normalize the 'seaAssets' sandbox option into a JSON-safe map for the
// bootstrap object: { [key]: { encoding: 'utf8'|'base64', data: string } }.
// Accepted value shapes (mirrors the leniency of 'fs' -> __USER_FILES__):
//   string                                   -> utf8 text
//   Uint8Array / ArrayBuffer / SharedArrayBuffer -> base64 bytes
//   { encoding: 'utf8'|'base64', data: string }  -> used as-is
// Anything else (including empty keys) is dropped: a misconfigured asset
// must never break sandbox bootstrap.
function normalizeSeaAssets(assets) {
  const out = {};
  if (!assets || typeof assets !== "object") return out;
  const entries =
    typeof assets.entries === "function" && assets instanceof Map
      ? assets.entries()
      : Object.entries(assets);
  for (const [key, value] of entries) {
    if (typeof key !== "string" || key === "") continue;
    if (typeof value === "string") {
      out[key] = { encoding: "utf8", data: value };
    } else if (
      typeof ArrayBuffer !== "undefined" &&
      ArrayBuffer.isView(value)
    ) {
      out[key] = {
        encoding: "base64",
        data: base64EncodeBytes(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        ),
      };
    } else if (
      value instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== "undefined" &&
        value instanceof SharedArrayBuffer)
    ) {
      out[key] = {
        encoding: "base64",
        data: base64EncodeBytes(new Uint8Array(value)),
      };
    } else if (
      value &&
      typeof value === "object" &&
      typeof value.data === "string" &&
      (value.encoding === "utf8" || value.encoding === "base64")
    ) {
      out[key] = { encoding: value.encoding, data: value.data };
    }
  }
  return out;
}

function base64EncodeBytes(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// A file-seed value of exactly { encoding: 'utf8'|'base64', data: string }
// is a binary/text envelope, NOT a directory (mirrors the normalizeSeaAssets
// convention, which documents these shapes as the fs -> __USER_FILES__
// leniency). flattenFileTree must keep it as a leaf so seedVolume in the
// sandbox can decode it; recursing would create bogus 'encoding'/'data'
// files. The two-key strictness keeps a user directory that merely happens
// to contain encoding/data files from being reinterpreted.
function isSeedEnvelope(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Blob) &&
    (value.encoding === "utf8" || value.encoding === "base64") &&
    typeof value.data === "string" &&
    Object.keys(value).length === 2
  );
}

// Normalize raw bytes (Uint8Array/Buffer/ArrayBuffer) to a JSON-safe
// { encoding: 'base64', data } envelope. __USER_FILES__ is JSON-serialized
// into the sandbox bootstrap, where raw bytes would corrupt to {"0":..}.
function seedBytesToBase64(value) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    return Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).toString("base64");
  }
  return base64EncodeBytes(bytes);
}

export function flattenFileTree(obj, parentPath = "") {
  let flat = {};
  if (!obj || typeof obj !== "object") return flat;

  for (const [key, value] of Object.entries(obj)) {
    const fullPath = parentPath ? `${parentPath}/${key}` : key;

    if (value === null) {
      continue;
    } else if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      // Binary leaf: JSON-safe envelope (raw bytes cannot survive
      // JSON.stringify into the bootstrap).
      flat[fullPath] = { encoding: "base64", data: seedBytesToBase64(value) };
    } else if (isSeedEnvelope(value)) {
      // Already an envelope: keep as a leaf for seedVolume to decode.
      flat[fullPath] = value;
    } else if (typeof value === "object" && !(value instanceof Blob)) {
      Object.assign(flat, flattenFileTree(value, fullPath));
    } else {
      flat[fullPath] = value;
    }
  }
  return flat;
}

// NOTE: The files-panel UI (activeBlobUrls, detectMimeType, renderFiles,
// renderFiles2) lived here at the end of the module. It moved to
// src/ui/playground.js — runtime.js is a pure library with no demo UI.
