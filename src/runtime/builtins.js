/**
 * Inlined IIFE bundle of src/cookieJar.js (RFC 6265 virtual cookie jar).
 * The sandbox cannot fetch dist files at runtime without a network round
 * trip, so the jar ships inside the generated sandbox code instead.
 * Regenerate: node src/build-sandbox.mjs (buildCookieIife) or:
 *   esbuild src/sandbox/cookie-entry.js --bundle --format=iife --minify
 *     --platform=browser, then JSON.stringify the output.
 */
export const COOKIE_JAR_IIFE =
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
export const _builtinCache = new Map();
export const _builtinBaseUrl =
  "https://cdn.jsdelivr.net/gh/MarketingPip/bundleVFSModules@main/dist/";
// Maps Node.js specifiers to dist filenames (mirrors dist/manifest.json)
export const _builtinManifest = {
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
export const _builtinSourceCache = new Map();
export async function fetchBuiltinSource(specifier) {
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
export function normalizeBuiltinSpecifier(specifier, nodeBuiltins) {
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

export async function loadBuiltin(specifier) {
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
