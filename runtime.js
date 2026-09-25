import * as acorn from "https://esm.sh/acorn";
import {importAssertions} from "https://esm.sh/acorn-import-assertions"
import { escape, split, join } from "https://esm.sh/shellwords?target=node"; 
import { v4 as uuid } from 'https://esm.sh/uuid';   
import { Terminal } from "https://esm.sh/xterm@5.3.0";
/**
 * Inlined IIFE bundle of src/cookieJar.js (RFC 6265 virtual cookie jar).
 * The sandbox cannot fetch dist files at runtime without a network round
 * trip, so the jar ships inside the generated sandbox code instead.
 * Regenerate: node src/build-sandbox.mjs (buildCookieIife) or:
 *   esbuild src/sandbox/cookie-entry.js --bundle --format=iife --minify
 *     --platform=browser, then JSON.stringify the output.
 */
const COOKIE_JAR_IIFE = "globalThis.__cookieJarLib=(()=>{var N=Object.defineProperty;var U=Object.getOwnPropertyDescriptor;var G=Object.getOwnPropertyNames;var R=Object.prototype.hasOwnProperty;var J=(e,t)=>{for(var s in t)N(e,s,{get:t[s],enumerable:!0})},Q=(e,t,s,a)=>{if(t&&typeof t==\"object\"||typeof t==\"function\")for(let i of G(t))!R.call(e,i)&&i!==s&&N(e,i,{get:()=>t[i],enumerable:!(a=U(t,i))||a.enumerable});return e};var X=e=>Q(N({},\"__esModule\",{value:!0}),e);var ie={};J(ie,{VirtualCookieJar:()=>M,canonicalHost:()=>O,cookieJarKey:()=>w,cookiePathMatches:()=>F,defaultPath:()=>z,domainMatches:()=>E,mergeCookieHeaders:()=>ne,parseSetCookie:()=>K});var k={decodeValues:!0,map:!1,silent:!1,split:\"auto\"};function _(e){return typeof e!=\"string\"||e in{}}function C(){return Object.create(null)}function V(e){return typeof e==\"string\"&&!!e.trim()}function $(e,t){var s=e.split(\";\").filter(V),a=s.shift();if(!a)return null;var i=Y(a),r=i.name,n=i.value;if(t=t?Object.assign({},k,t):k,_(r))return null;try{n=t.decodeValues?decodeURIComponent(n):n}catch(c){console.error(\"set-cookie-parser: failed to decode cookie value. Set options.decodeValues=false to disable decoding.\",c)}var o=C();return o.name=r,o.value=n,s.forEach(function(c){var m=c.split(\"=\"),f=m.shift().trim().toLowerCase();if(!_(f)){var d=m.join(\"=\").trim();if(f===\"expires\")o.expires=new Date(d);else if(f===\"max-age\"){var p=parseInt(d,10);Number.isNaN(p)||(o.maxAge=p)}else f===\"secure\"?o.secure=!0:f===\"httponly\"?o.httpOnly=!0:f===\"samesite\"?o.sameSite=d:f===\"partitioned\"?o.partitioned=!0:f&&(o[f]=d)}}),o}function Y(e){var t=\"\",s=\"\",a=e.split(\"=\");return a.length>1?(t=a.shift(),s=a.join(\"=\")):s=e,{name:t,value:s}}function y(e,t){if(t=t?Object.assign({},k,t):k,!e)return t.map?C():[];if(e.headers)if(typeof e.headers.getSetCookie==\"function\")e=e.headers.getSetCookie();else if(e.headers[\"set-cookie\"])e=e.headers[\"set-cookie\"];else{var s=e.headers[Object.keys(e.headers).find(function(n){return n.toLowerCase()===\"set-cookie\"})];!s&&e.headers.cookie&&!t.silent&&console.warn(\"Warning: set-cookie-parser appears to have been called on a request object. It is designed to parse Set-Cookie headers from responses, not Cookie headers from requests. Set the option {silent: true} to suppress this warning.\"),e=s}var a=t.split,i=Array.isArray(e);if(a===\"auto\"&&(a=!i),i||(e=[e]),e=e.filter(V),a&&(e=e.map(A).flat()),t.map){var r=C();return e.reduce(function(n,o){var c=$(o,t);return c&&!_(c.name)&&(n[c.name]=c),n},r)}else return e.map(function(n){return $(n,t)}).filter(Boolean)}function A(e){if(Array.isArray(e))return e;if(typeof e!=\"string\")return[];var t=[],s=0,a,i,r,n,o;function c(){for(;s<e.length&&/\\s/.test(e.charAt(s));)s+=1;return s<e.length}function m(){return i=e.charAt(s),i!==\"=\"&&i!==\";\"&&i!==\",\"}for(;s<e.length;){for(a=s,o=!1;c();)if(i=e.charAt(s),i===\",\"){for(r=s,s+=1,c(),n=s;s<e.length&&m();)s+=1;s<e.length&&e.charAt(s)===\"=\"?(o=!0,s=n,t.push(e.substring(a,r)),a=s):s=r+1}else s+=1;(!o||s>=e.length)&&t.push(e.substring(a,e.length))}return t}y.parseSetCookie=y;y.parse=y;y.parseString=$;y.splitCookiesString=A;var Z={maxNameValueBytes:4096,maxAttrValueBytes:1024,maxPerDomain:180,maxTotal:3e3,maxLifetimeMs:400*24*60*60*1e3,defaultSameSite:\"lax\",treatLocalhostAsSecure:!0,defaultHost:\"localhost\",isPublicSuffix:e=>!e.includes(\".\")},ee=new TextEncoder,j=e=>ee.encode(e).length;function w(e,t){return`\${e}\\0\${t}`}var te=e=>`\${e.domain}\\0\${e.path}\\0\${e.name}`;function O(e){return e.trim().toLowerCase().replace(/^\\[|\\]$/g,\"\").replace(/\\.$/,\"\")}var se=e=>/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(e)||e.includes(\":\"),re=e=>e===\"localhost\"||e.endsWith(\".localhost\")||e===\"::1\"||/^127\\./.test(e);function E(e,t){return e===t?!0:!se(e)&&e.endsWith(\".\"+t)}function z(e){let t=e.split(\"?\")[0]||\"/\";if(!t.startsWith(\"/\"))return\"/\";let s=t.lastIndexOf(\"/\");return s<=0?\"/\":t.slice(0,s)}function F(e,t){return t===e||e.indexOf(t)===0&&(t.charAt(t.length-1)===\"/\"||e.charAt(t.length)===\"/\")}var D=(e,t)=>e.expires!==null&&e.expires<=t;function ae(e,t,s,a){return e===\"none\"||t?!0:e===\"lax\"?s&&a:!1}function K(e,t,s,a,i=Date.now()){let r=g=>({ok:!1,reason:g}),n=O(t.host),o=String(e).split(\";\"),c=o.shift()??\"\",m=c.indexOf(\"=\");if(m<0)return r(\"missing '=' in name-value pair\");let f=c.slice(0,m).trim(),d=c.slice(m+1).trim();if(!f)return r(\"empty cookie name\");if(j(f)+j(d)>a.maxNameValueBytes)return r(`name+value exceeds \${a.maxNameValueBytes} bytes`);let p=null,u=null,l=!1,h=!1,W=null,H=null,I=null;for(let g of o){let b=g.indexOf(\"=\"),P=(b<0?g:g.slice(0,b)).trim().toLowerCase(),v=b<0?\"\":g.slice(b+1).trim();if(!(j(v)>a.maxAttrValueBytes))switch(P){case\"path\":p=v.startsWith(\"/\")?v:null;break;case\"domain\":u=v.replace(/^\\./,\"\").toLowerCase()||null;break;case\"secure\":l=!0;break;case\"httponly\":h=!0;break;case\"samesite\":{let x=v.toLowerCase();W=x===\"strict\"||x===\"lax\"||x===\"none\"?x:null;break}case\"max-age\":if(/^-?\\d+$/.test(v)){let x=parseInt(v,10);H=x<=0?0:i+Math.min(x*1e3,a.maxLifetimeMs)}break;case\"expires\":{let x=Date.parse(v);Number.isNaN(x)||(I=Math.min(x,i+a.maxLifetimeMs));break}}}let T=n,L=!0;if(u)if(a.isPublicSuffix(u)){if(u!==n)return r(`Domain=\${u} is a public suffix`)}else if(E(n,u))T=u,L=!1;else return r(`host \"\${n}\" does not domain-match Domain=\${u}`);let q=p??z(t.path??\"/\");if(l&&!s)return r(\"Secure cookie set from an insecure origin\");let S=W??a.defaultSameSite;if(S===\"none\"&&!l)return r(\"SameSite=None requires Secure\");if(S!==\"none\"&&t.sameSite===!1&&!t.topLevelNavigation)return r(`SameSite=\${S} cookie set from a cross-site response`);let B=f.toLowerCase();return B.startsWith(\"__secure-\")&&!l?r(\"__Secure- prefix requires Secure\"):B.startsWith(\"__host-\")&&(!l||!L||q!==\"/\")?r(\"__Host- prefix requires Secure, no Domain, and Path=/\"):{ok:!0,cookie:{name:f,value:d,domain:T,hostOnly:L,path:q,secure:l,httpOnly:h,sameSite:S,expires:H??I,created:i,lastAccessed:i}}}function ne(e,t){if(!t)return e||\"\";if(!e)return t;let s=new Set,a=[];for(let i of t.split(\";\")){let r=i.trim();if(!r)continue;let n=r.indexOf(\"=\");s.add((n<0?r:r.slice(0,n)).trim()),a.push(r)}for(let i of e.split(\";\")){let r=i.trim();if(!r)continue;let n=r.indexOf(\"=\");s.has((n<0?r:r.slice(0,n)).trim())||a.push(r)}return a.join(\"; \")}var M=class{_jars=new Map;cfg;constructor(t={}){this.cfg={...Z,...t}}isSecureOrigin(t){return!!t.secure||this.cfg.treatLocalhostAsSecure&&re(O(t.host))}store(t,s,a,i={host:this.cfg.defaultHost}){let r=[];if(a==null)return r;let n=Array.isArray(a)?a.flatMap(d=>A(d)):A(a),o=w(t,s),c=this._jars.get(o);c||(c=new Map,this._jars.set(o,c));let m=Date.now(),f=this.isSecureOrigin(i);for(let d of n){let p=K(d,i,f,this.cfg,m);if(!p.ok){r.push({raw:d,reason:p.reason});continue}let u=p.cookie,l=te(u);if(D(u,m)){c.delete(l);continue}let h=c.get(l);h&&(u.created=h.created),c.set(l,u)}return this.enforceLimits(c,m),c.size===0&&this._jars.delete(o),r}enforceLimits(t,s){for(let[r,n]of t)D(n,s)&&t.delete(r);let a=new Map;for(let r of t){let n=a.get(r[1].domain);n?n.push(r):a.set(r[1].domain,[r])}for(let r of a.values()){let n=r.length-this.cfg.maxPerDomain;if(!(n<=0)){r.sort((o,c)=>o[1].lastAccessed-c[1].lastAccessed);for(let[o]of r.slice(0,n))t.delete(o)}}let i=t.size-this.cfg.maxTotal;if(i>0){let r=[...t].sort((n,o)=>n[1].lastAccessed-o[1].lastAccessed);for(let[n]of r.slice(0,i))t.delete(n)}}cookieHeader(t,s,a){let i=this._jars.get(w(t,s));if(!i||i.size===0)return\"\";let r=typeof a==\"string\"?{host:this.cfg.defaultHost,path:a}:a,n=Date.now(),o=O(r.host),c=(r.path??\"/\").split(\"?\")[0]||\"/\",m=this.isSecureOrigin(r),f=r.sameSite??!0,d=!!r.topLevelNavigation,p=[\"GET\",\"HEAD\",\"OPTIONS\",\"TRACE\"].includes((r.method??\"GET\").toUpperCase()),u=[];for(let[l,h]of i){if(D(h,n)){i.delete(l);continue}(h.hostOnly?h.domain!==o:!E(o,h.domain))||F(c,h.path)&&(h.secure&&!m||r.script&&h.httpOnly||ae(h.sameSite,f,d,p)&&u.push(h))}u.sort((l,h)=>h.path.length-l.path.length||l.created-h.created);for(let l of u)l.lastAccessed=n;return u.map(l=>`\${l.name}=\${l.value}`).join(\"; \")}list(t,s){let a=this._jars.get(w(t,s));return a?[...a.values()].map(i=>({...i})):[]}clearInstance(t){for(let s of[...this._jars.keys()])s.startsWith(t+\"\\0\")&&this._jars.delete(s)}clearAll(){this._jars.clear()}};return X(ie);})();";
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
const _builtinBaseUrl = "https://cdn.jsdelivr.net/gh/MarketingPip/bundleVFSModules@main/dist/";
// Maps Node.js specifiers to dist filenames (mirrors dist/manifest.json)
const _builtinManifest = {
  "assert": "assert.js", "assert/strict": "assert_strict.js",
  "async_hooks": "async_hooks.js", "buffer": "buffer.js",
  "child_process": "child_process.js", "cluster": "cluster.js",
  "console": "console.js", "constants": "constants.js", "crypto": "crypto.js",
  "dgram": "dgram.js", "diagnostics_channel": "diagnostics_channel.js",
  "dns": "dns.js", "dns/promises": "dns_promises.js", "domain": "domain.js",
  "events": "events.js", "fs": "fs.js", "fs/promises": "fs_promises.js",
  "http": "http.js", "http2": "http2.js", "https": "https.js",
  "inspector": "inspector.js", "module": "module.js", "net": "net.js",
  "os": "os.js", "path": "path.js", "path/posix": "path.js", "path/win32": "path.js",
  "perf_hooks": "perf_hooks.js", "process": "process.js", "punycode": "punycode.js",
  "querystring": "querystring.js", "readline": "readline.js",
  "readline/promises": "readline_promises.js", "repl": "repl.js",
  "stream": "stream.js", "stream/consumers": "stream.js",
  "stream/promises": "stream.js", "stream/web": "stream.js",
  "string_decoder": "string_decoder.js", "test": "test.js", "timers": "timers.js",
  "timers/promises": "timers_promises.js", "tls": "tls.js",
  "trace_events": "trace_events.js", "tty": "tty.js", "url": "url.js",
  "util": "util.js", "util/types": "util.js", "v8": "v8.js", "vm": "vm.js",
  "wasi": "wasi.js", "worker_threads": "worker_threads.js", "zlib": "zlib.js",
}
const _builtinSourceCache = new Map();
async function fetchBuiltinSource(specifier) {
  let key = String(specifier).trim();
  if (key.startsWith('node:')) key = key.slice(5);
  let file = _builtinManifest[key];
  if (!file && key.includes('_')) file = _builtinManifest[key.split('_').join('/')];
  if (!file && key.startsWith('RUNTIME_')) file = `${key}.js`;
  if (!file) return `export default {}`;
  if (_builtinSourceCache.has(file)) return _builtinSourceCache.get(file);
  const url = _builtinBaseUrl + file;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`[ERR_BUILTIN_LOAD]: failed to fetch ${url}: HTTP ${res.status}`);
  const text = await res.text();
  _builtinSourceCache.set(file, text);
  return text;
}
;

async function loadBuiltin(specifier) {
  // Normalize: strip "node:" prefix
  let key = String(specifier).trim();
  if (key.startsWith('node:')) key = key.slice(5);
  
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
 * events. Useful when building custom input UIs outside of xterm.js.
 * 
 * @param {HTMLElement} element - The DOM element to attach listeners to
 * @param {Function} callback - Called as callback(sequence, key) where key
 *   is { name, ctrl, meta, shift, sequence }
 * @returns {{ stop: Function }} - Call .stop() to remove listeners
 * 
 * @example
 *   toNodeKeypress(document.getElementById('myInput'), (sequence, key) => {
 *     console.log('Key:', key.name, 'Ctrl:', key.ctrl);
 *   });
 */
export function toNodeKeypress(element, callback) {
  if (!element || typeof callback !== "function") {
    throw new Error("Element and callback function are required");
  }
  const autoComplete = element?.autocomplete
  const keyMap = {
    'ArrowUp':    '\x1b[A',
    'ArrowDown':  '\x1b[B',
    'ArrowRight': '\x1b[C',
    'ArrowLeft':  '\x1b[D',
    'Enter':      '\n',
    'Backspace':  '\x7f',
    'Tab':        '\t',
    'Escape':     '\x1b',
    'Delete':     '\x1b[3~',
    'Home':       '\x1b[H',
    'End':        '\x1b[F',
    'PageUp':     '\x1b[5~',
    'PageDown':   '\x1b[6~',
    'Insert':     '\x1b[2~',
  };
  element.autocomplete="off"
  element.addEventListener("keydown", (e) => {
    // Determine sequence: mapped special key or literal
    let sequence = keyMap[e.key] || (e.key.length === 1 ? e.key : '');

    // If Ctrl + key, adjust for Node-style control characters
    if (e.ctrlKey && sequence.length === 1) {
      const charCode = sequence.toUpperCase().charCodeAt(0) - 64;
      if (charCode > 0 && charCode < 32) sequence = String.fromCharCode(charCode);
    }

    const key = {
      name: e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase(),
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      shift: e.shiftKey,
      sequence
    };
 
    if (sequence) callback(sequence, key);

 //    e.preventDefault();
       
    if(key.name === "enter" && key.sequence === "\n"){
      element.value = ""
    }
  });

  element.addEventListener("paste", (e) => {
    const pastedText = e.clipboardData.getData("text");
    if (pastedText) {
      for (const ch of pastedText) {
        callback(ch, { name: ch, ctrl: false, meta: false, shift: false, sequence: ch });
      }
    }
    //e.preventDefault();
  });
 
  return {
    stop: () => {
      element.autocomplete = autoComplete;
      element.replaceWith(element.cloneNode(true)); // removes listeners
    }
  }; 
}

 /** 
 * Consolidated ANSI stripper and console interceptor
 */
const stripAnsi = (string) => {
  if (typeof string !== 'string') return string;

  // Fast path: ANSI codes require ESC (7-bit) or CSI (8-bit) introducer
  if (!string.includes('\u001B') && !string.includes('\u009B')) {
    return string;
  }

  // Regex pattern for OSC (hyperlinks) and CSI (colors/styles)
  const pattern = [
    '(?:\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\|\\u009C))', // OSC
    '[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]' // CSI
  ].join('|');

  return string.replace(new RegExp(pattern, 'g'), '');
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
    } else if (typeof userVal === "object" && userVal !== null && typeof defaultVal === "object") {
      // deep merge objects
      acc[key] = mergeProcess(userVal, defaultVal);
    } else {
      // primitives: use user value
      acc[key] = userVal;
    }

    return acc;
  }, {});
}
 
import _builtinModules from 'https://esm.sh/builtin-modules';
  
const builtinModules = [
 ..._builtinModules, 
  ...["_http_agent","_http_client","_http_common","_http_incoming","_http_outgoing","_http_server","_stream_duplex","_stream_passthrough","_stream_readable","_stream_transform","_stream_wrap","_stream_writable","_tls_common","_tls_wrap","assert","assert/strict","async_hooks","buffer","child_process","cluster","console","constants","crypto","dgram","diagnostics_channel","dns","dns/promises","domain","events","fs","fs/promises","http","http2","https","inspector","inspector/promises","module","net","os","path","path/posix","path/win32","perf_hooks","process","punycode","querystring","readline","readline/promises","repl","stream","stream/consumers","stream/promises","stream/web","string_decoder","sys","timers","timers/promises","tls","trace_events","tty","url","util","util/types","v8","vm","wasi","worker_threads","zlib","node:sea","node:sqlite","node:test","node:test/reporters"]
  
  ]

builtinModules.push("RUNTIME:NODE_GLOBALS")
 
 

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

const customAcorn = acorn.Parser.extend(importAssertions);

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
import { TraceMap, originalPositionFor } from "https://esm.sh/@jridgewell/trace-mapping";
import remapping from "https://esm.sh/@ampproject/remapping";

 //import {Buffer} from "https://esm.sh/buffer"

import  fs from 'https://esm.sh/memfs';

 
// Initialize virtual filesystem structure
fs.vol.fromJSON({
  '/hello.txt': 'Hello world',
  '/dir/nested.txt': 'Nested file'
});




const TEXT_EXTS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'json', 'jsonc', 'json5',
  'md', 'mdx', 'txt', 'csv', 'yaml', 'yml',
  'xml', 'svg', 'graphql', 'gql',
  'sh', 'bash', 'env', 'toml', 'ini', 'conf',
]);

const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp',
  'wasm',
  'ttf', 'otf', 'woff', 'woff2',
  'mp3', 'mp4', 'wav', 'ogg', 'webm',
  'pdf', 'zip', 'gz', 'tar',
]);

function getExt(path) {
  return path.split('.').pop()?.toLowerCase() ?? '';
}

// ─── Serialize ────────────────────────────────────────────────────────────────
// Converts a memfs volume into a plain JSON-safe object.
// All files are stored as base64 strings — safe for JSON / eval embedding.

export function serializeVfs(fs) {
  const out = {};
  const files = fs.vol?.toJSON?.() ?? {};
 
  for (const path in files) {
    try {
      const data = fs.fs.readFileSync(path);         // raw Buffer / Uint8Array
      out[path] = Buffer.from(data).toString('base64');
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
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const ext   = getExt(path);

      if (ext === 'json' || ext === 'jsonc' || ext === 'json5') {
        out[path] = JSON.parse(new TextDecoder().decode(bytes));
      } else if (TEXT_EXTS.has(ext)) {
        out[path] = new TextDecoder().decode(bytes);
      } else if (BINARY_EXTS.has(ext)) {
        out[path] = bytes;
      } else {
        // Unknown extension — try UTF-8, fall back to bytes if it fails
        try {
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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
      const dir = path.substring(0, path.lastIndexOf('/'));
      if (dir) fs.mkdirSync(dir, { recursive: true });
  
      if (typeof content === 'string') {
        fs.writeFileSync(path, content, 'utf8');
      } else if (content instanceof Uint8Array) {
        fs.writeFileSync(path, content);
      } else {
        // JSON object — write as formatted string
        fs.writeFileSync(path, JSON.stringify(content, null, 2), 'utf8');
      }
    } catch (e) {
      console.warn(`[vfs] failed to rehydrate ${path}:`, e);
    }
  }
}


 
 
export function convertEsmToCjs(code, options = {}) {
  const { filename = 'input.js' } = options;
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'module' });
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
        const parts = specifiers.map(spec => {
          if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
            return spec.local.name; // import x from 'y' || import * as x from 'y'
          } else {
            // Named import { a as b } -> { a: b }
            return spec.imported.name === spec.local.name 
              ? spec.local.name 
              : `${spec.imported.name}: ${spec.local.name}`;
          }
        });

        const isDestructured = specifiers.some(s => s.type === 'ImportSpecifier');
        const importStr = isDestructured ? `{ ${parts.join(', ')} }` : parts[0];
        s.overwrite(node.start, node.end, `const ${importStr} = require(${source});`);
      }
    },

    // 2. Convert default export
    ExportDefaultDeclaration(node) {
      if (node.declaration.id) {
        // Named function/class: export default function foo() {} -> module.exports = foo
        s.remove(node.start, node.declaration.start);
        s.appendLeft(node.end, `\nmodule.exports = ${node.declaration.id.name};`);
      } else {
        // Anonymous default: export default 42 -> module.exports = 42
        s.overwrite(node.start, node.declaration.start, 'module.exports = ');
      }
    },

    // 3. Convert named exports
    ExportNamedDeclaration(node) {
      if (node.declaration) {
        // Handle variables, functions, classes
        s.remove(node.start, node.declaration.start);

        if (node.declaration.type === 'VariableDeclaration') {
          node.declaration.declarations.forEach(decl => {
            s.appendRight(node.end, `\nexports.${decl.id.name} = ${decl.id.name};`);
          });
        } else if (node.declaration.id) {
          s.appendRight(node.end, `\nexports.${node.declaration.id.name} = ${node.declaration.id.name};`);
        }
      } else if (node.specifiers.length) {
        // export { x, y as z };
        const parts = node.specifiers.map(spec => {
          const exported = spec.exported.name;
          const local = spec.local.name;
          return `exports.${exported} = ${local};`;
        }).join('\n');
        s.overwrite(node.start, node.end, parts);
      } else if (node.source) {
        // export * from './file.js';
        s.overwrite(node.start, node.end, `Object.assign(exports, require(${node.source.raw}));`);
      }
    },

    // 4. Export all (catch re-exports)
    ExportAllDeclaration(node) {
      s.overwrite(node.start, node.end, `Object.assign(exports, require(${node.source.raw}));`);
    }
  });

  const outCode = s.toString();
  const map = s.generateMap({ source: filename, hires: true, includeContent: true });
  return { code: outCode, map };
}

export function convertCjsToEsm(code, options = {}) {
  const { filename = 'input.js' } = options;
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });
  const s = new MagicString(code, { filename });

  let lastModuleExport = null;
  const exportsProps = [];
  const deadZones = [];

  // Pass 1: detect module.exports and exports.*
  walk.ancestor(ast, {
    AssignmentExpression(node, ancestors) {
      const isTopLevel = !ancestors.some(a =>
        ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(a.type)
      );
      if (!isTopLevel) return;

      const { left } = node;

      // module.exports = ...
      if (left.object?.name === 'module' && left.property?.name === 'exports') {
        if (lastModuleExport) {
          // previous module.exports is dead
          deadZones.push({ start: lastModuleExport.start, end: lastModuleExport.end });
        }
        lastModuleExport = node;
      }
      // exports.prop = ...
      else if (left.object?.name === 'exports') {
        exportsProps.push({ node, name: left.property.name });
      }
    }
  });

  // Pass 2: remove dead module.exports
  deadZones.forEach(zone => {
    s.remove(zone.start, zone.end + (code[zone.end] === ';' ? 1 : 0));
  });

  // Remove exports.* only if there’s a module.exports assignment (module.exports wins)
  if (lastModuleExport) {
    exportsProps.forEach(exp => {
      s.remove(exp.node.start, exp.node.end + (code[exp.node.end] === ';' ? 1 : 0));
    });
  }

  // Pass 3: transform the last module.exports to default
  if (lastModuleExport) {
    s.overwrite(lastModuleExport.start, lastModuleExport.right.start, 'export default ');
  } 
  // Otherwise, transform exports.* to named exports
  else {
    exportsProps.forEach(exp => {
      s.overwrite(exp.node.start, exp.node.right.start, `export const ${exp.name} = `);
    });
  }

  const outCode = s.toString();
  const map = s.generateMap({ source: filename, hires: true, includeContent: true });
  return { code: outCode, map };
}

export function convertCjsToEsm_backup(code) {
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });
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
      const isTopLevel = !ancestors.some(a => 
        ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(a.type)
      );
      if (!isTopLevel) return;

      const { left } = node;

      // module.exports = ...
      if (left.object?.name === 'module' && left.property?.name === 'exports') {
        if (lastModuleExport) {
          // The previous module.export is now dead code (orphaned)
          deadZones.push({ start: lastModuleExport.start, end: lastModuleExport.end });
        }
        lastModuleExport = node;
      } 
      // exports.prop = ...
      else if (left.object?.name === 'exports') {
        // These are orphaned if they happen before OR after a full module.exports replacement
        deadZones.push({ start: node.start, end: node.end });
      }
    }
  });

  // Pass 2: Transformation
  
  // 1. Convert Requires
  requires.forEach(req => {
    // Check if it's a standalone expression statement
    s.overwrite(req.start, req.end, `import ${req.arguments[0].raw}`);
  });

  // 2. Remove all "Dead" assignments
  deadZones.forEach(zone => {
    // We remove the whole statement (including trailing semicolon if possible)
    s.remove(zone.start, zone.end + (code[zone.end] === ';' ? 1 : 0));
  });

  // 3. Transform the "Winner"
  if (lastModuleExport) {
    s.overwrite(lastModuleExport.start, lastModuleExport.right.start, 'export default ');
  }

  return s.toString().trim().replace(/\n\s*\n/g, '\n'); // Clean up empty lines
}

function _convertCjsToEsm(code) {
  const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script' });
  let offset = 0;
  let newCode = code;

  // Helper to replace code fragments accurately
  function replace(start, end, replacement) {
    const adjustedStart = start + offset;
    const adjustedEnd = end + offset;
    newCode = newCode.slice(0, adjustedStart) + replacement + newCode.slice(adjustedEnd);
    offset += replacement.length - (end - start);
  }

  // Walk the AST
  function walk(node) {
    if (!node) return;

    if (node.type === 'AssignmentExpression') {
      const { left, right } = node;

      // Pattern 1: module.exports = ...
      if (
        left.type === 'MemberExpression' &&
        left.object.name === 'module' &&
        left.property.name === 'exports'
      ) {
        // Replace 'module.exports =' with 'export default'
        replace(node.start, right.start, 'export default ');
      }

      // Pattern 2: exports.name = ...
      else if (
        left.type === 'MemberExpression' &&
        left.object.name === 'exports'
      ) {
        const propName = left.property.name;
        // Replace 'exports.name =' with 'export const name ='
        replace(node.start, right.start, `export const ${propName} = `);
      }
    }

    // Standard recursive walk
    for (const key in node) {
      if (node[key] && typeof node[key] === 'object') {
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
      const ast = acorn.parse(code, { ecmaVersion: 2022,  sourceType: "module"  });
      let hasCJS = false;

      // Recursive function to walk the AST
      function walk(node) {
        if (!node || hasCJS) return;

        // Check for 'require(...)'
        if (
          node.type === 'CallExpression' &&
          node.callee.name === 'require'
        ) {
          hasCJS = true;
        }

        // Check for 'module.exports' or 'exports.foo'
        if (node.type === 'AssignmentExpression') {
          const { left } = node;
          if (
            (left.object && left.object.name === 'module' && left.property.name === 'exports') ||
            (left.name === 'exports') ||
            (left.object && left.object.name === 'exports')
          ) {
            hasCJS = true;
          }
        }

        // Traverse children
        for (const key in node) {
          if (node[key] && typeof node[key] === 'object') {
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
        sourceType: "module" 
      });

      function walk(node) {
        if (!node) return;

        // --- ESM DETECTION ---
        // Look for 'import ...' or 'export ...'
        if (
          node.type === 'ImportDeclaration' || 
          node.type === 'ExportNamedDeclaration' || 
          node.type === 'ExportDefaultDeclaration' ||
          node.type === 'ExportAllDeclaration'
        ) {
          result.isESM = true;
        }

        // --- CJS DETECTION ---
        // Check for 'require(...)'
        if (
          node.type === 'CallExpression' &&
          node.callee.name === 'require'
        ) {
          result.isCJS = true;
        }

        // Check for 'module.exports' or 'exports'
        if (node.type === 'AssignmentExpression') {
          const { left } = node;
          const isModuleExports = left.object?.name === 'module' && left.property?.name === 'exports';
          const isExports = left.name === 'exports' || left.object?.name === 'exports';
          
          if (isModuleExports || isExports) {
            result.isCJS = true;
          }
        }

        // Standard AST traversal
        for (const key in node) {
          const child = node[key];
          if (child && typeof child === 'object') {
            if (Array.isArray(child)) {
              child.forEach(walk);
            } else {
              walk(child);
            }
          }
        }
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
import { walk as walker } from 'https://esm.sh/estree-walker';

function transformRelativeModule(code) {
  const s = new MagicString(code);
  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module'
  });

  walker(ast, {
    enter(node) {
      let sourceNode = null;
      let startIdx = null;
      let endIdx = null;
      let type = '';

      // 1. Match dynamic import('./path')
      if (node.type === 'ImportExpression') {
        sourceNode = node.source;
        startIdx = node.start;
        endIdx = node.start + 6; // length of 'import'
        type = 'import';
      } 
      
      // 2. Match require('./path')
      else if (
        node.type === 'CallExpression' && 
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' && // Corrected from !=
        node.arguments.length === 1
      ) {
        sourceNode = node.arguments[0];
        startIdx = node.callee.start;
        endIdx = node.callee.end; // length of 'require'
        type = 'require';
      }

      // 3. Transformation Logic
      if (sourceNode && sourceNode.type === 'Literal' && typeof sourceNode.value === 'string' && type !="require") {
        const path = sourceNode.value;
        
        // Only transform relative paths
        if (path.startsWith('./') || path.startsWith('../')) {
          // Change the function name to loadModule
          s.overwrite(startIdx, endIdx, 'loadModule');
          
          // Inject the type as the second argument
          // sourceNode.end is the end of the path string
          s.appendRight(sourceNode.end, `, '${type}'`);
        }
      }
    }
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
  const {
    replacement,
    generateUnique = false,
    filename = 'input.js',
  } = opts;

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
  const map = s.generateMap({ source: filename, hires: true, includeContent: true });
  return { code: outCode, map };
}


/**
 * Transform JS code to replace imports/requires with loadModule calls.
 * Handles static imports, dynamic imports, require(), and CJS → ESM interop.
 */
export function transformImportsToLoadModule(sandboxUUID, code, entryPoint = null, parentEntryPoint = null) {
   
  const s = new MagicString(code, { filename: entryPoint || 'input.js' });
  const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", ranges: true });

  // --- Helper: attach parents for context ---
  function attachParents(node, parent = null) {
    if (!node || typeof node !== "object") return;
    node.parent = parent;
    for (const k in node) {
      if (["parent", "start", "end", "type"].includes(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(c => attachParents(c, node));
      else attachParents(v, node);
    }
  }
  attachParents(ast);

  // --- Utilities ---
  const liftedModules = new Map();
  const importBindings = [];
  const functionsToMakeAsync = new Set();
  const moduleImportType = new Map();

  function getLiftedVar(modulePath) {
    if (!liftedModules.has(modulePath)) {
      const safeName = "__lm_" + Math.random().toString(36).slice(2, 7);
      liftedModules.set(modulePath, safeName);
    }
    return liftedModules.get(modulePath);
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
      if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(n.type))
        return n;
      n = n.parent;
    }
    return null;
  }

  // --- AST walk ---
  walk.simple(ast, {
    // Static ESM imports
    ImportDeclaration(node) {
      const modulePath = node.source.value;
      const v = getLiftedVar(modulePath);
      importBindings.push({ node, liftedVar: v });
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
        resolve: "__RUNTIME_RESOLVE__HANDLE"
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
        if(prop != "resolve"){
        s.overwrite(parent.start, parent.end, `'${metaValues[prop]}'`);
        }else{
          s.overwrite(parent.start, parent.end, `${metaValues[prop]}`);
        }
          
      } else {
        // unknown property — fallback to full object
        s.overwrite(parent.start, parent.end, `{ ${prop}: undefined }`);
      }
    } else {
      // Bare import.meta — replace with object
      s.overwrite(node.start, node.end,  serializeMeta(metaValues));
    }
  }
}, 

   
ImportExpression(node) {
  if (node.source.type === "Literal" && typeof node.source.value === "string") {
    const modulePath = node.source.value;
    const v = getLiftedVar(modulePath);  // always create/reuse lifted variable
    setImportType(modulePath, "import");

    const enclosingFunc = findEnclosingFunction(node);

    // If inside non-async function → replace import with lifted variable
    /* if (enclosingFunc && !enclosingFunc.async) {
      s.overwrite(node.start, node.end, v);
      return; // stop further processing
    }*/ 

    // Otherwise (async function or top-level) → transform normally
    //if (enclosingFunc && enclosingFunc.async) functionsToMakeAsync.add(enclosingFunc);

    // Replace 'import' with 'loadModule'
    s.overwrite(node.start, node.start + 6, `globalThis._RUNTIME${sandboxUUID}_.loadModule`);

    // Append loader arguments inside parentheses
    s.appendLeft(
      node.source.end,
      `, 'import', ${JSON.stringify(entryPoint)}, ${JSON.stringify(parentEntryPoint)}`
    );
  }
}
,

    _ImportExpression(node) {
  if (node.source.type === "Literal" && typeof node.source.value === "string") {
    const modulePath = node.source.value;
    const v = getLiftedVar(modulePath);
    setImportType(modulePath, "import");

    const enclosingFunc = findEnclosingFunction(node);
    if (enclosingFunc && !enclosingFunc.async) functionsToMakeAsync.add(enclosingFunc);

    // Replace the 'import' keyword with 'loadModule'
    s.overwrite(node.start, node.start + 6, `globalThis._RUNTIME${sandboxUUID}_.loadModule`);

    // Append the loader type as a second argument **inside the parentheses**
    // node.source.end points just after the string literal
    s.appendLeft(node.source.end, `, 'import', ${JSON.stringify(entryPoint)}, ${JSON.stringify(parentEntryPoint)}`);
  }
},

    // require() calls
    CallExpression(node) {
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments.length === 1 &&
        node.arguments[0].type === "Literal" &&
        typeof node.arguments[0].value === "string"
      ) {
        const modulePath = node.arguments[0].value;
        const v = getLiftedVar(modulePath);
        setImportType(modulePath, "require");

        const enclosingFunc = findEnclosingFunction(node);
        if (enclosingFunc && !enclosingFunc.async) functionsToMakeAsync.add(enclosingFunc);

        s.overwrite(node.start, node.end, interop(v));
      }
    }
  });

  // Make functions async if needed
  for (const funcNode of functionsToMakeAsync) {
    //s.prependLeft(funcNode.start, "async ");
  }

  // --- Build the preamble for lifted modules ---
  let preambleParts = [];
  for (const [modulePath, v] of liftedModules.entries()) {
    const type = moduleImportType.get(modulePath) || "import";
    preambleParts.push(
      `const ${v} = await globalThis._RUNTIME${sandboxUUID}_.loadModule(${JSON.stringify(
        modulePath
      )}, ${JSON.stringify(type)}, ${JSON.stringify(entryPoint)}, ${JSON.stringify(parentEntryPoint)});`
    );
  }

  for (const { node, liftedVar } of importBindings) {
    preambleParts.push(generateImportBinding(node, liftedVar));
  }
 
  if (preambleParts.length > 0) {
    s.prepend(preambleParts.join("\n") + "\n\n");
  }
//console.log(preambleParts.join("\n") + "\n\n")
  const outCode = s.toString();
  const map = s.generateMap({ source: entryPoint || 'input.js', hires: true, includeContent: true });
  return { code: outCode, map };
}
 

function generateImportBinding(node, liftedVar) {
  const specifiers = node.specifiers;

  if (!specifiers.length) return '';

  let d = null, ns = null, named = [];
  for (const s of specifiers) {
    if (s.type === "ImportDefaultSpecifier") d = s.local.name;
    else if (s.type === "ImportNamespaceSpecifier") ns = s.local.name;
    else named.push(s.imported.name === s.local.name ? s.local.name : `${s.imported.name}: ${s.local.name}`);
  }

  if (ns) return `const ${ns} = ${liftedVar};`;
  if (d && named.length) return `const { default: ${d}, ${named.join(", ")} } = ${liftedVar};`;
  if (d) return `const ${d} = ${liftedVar}.default;`;
  
  return `const { ${named.join(", ")} } = ${liftedVar};`;
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
    this.ecmaVersion = options.ecmaVersion ?? 'latest';
  }

  /**
   * Check JavaScript syntax using Acorn parser
   * @param {string} code - The code to validate
   * @returns {{ valid: boolean, error?: string }}
   */
  check(code) {
    try {
      acorn.parse(code, {
        sourceType: 'module',
        locations: true,
        ecmaVersion: this.ecmaVersion,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: false
      });

      return { valid: true };
    } catch (err) {
      

      throw err;
    }
  }

}


  
        

        function generateGlobalBuiltInsSet(denyList = []) {
            const globalObject = globalThis;
            const globalSet = new Set();
            const denySet = new Set(denyList);

          
          
          const browserOnlyAPIs = [
  //"window",
 // "document",
  "navigator",
  "location",
  "history",
  "screen",
  "localStorage",
  "sessionStorage",
  "alert",
  "prompt",
  "confirm",
  "addEventListener",
  "removeEventListener",
  //"XMLHttpRequest",
  //"fetch",
  "WebSocket",
  "Navigator.geolocation",
  "navigator",
  //"ServiceWorker",
  "IntersectionObserver",
  "Notification",
  "Cache",
  "SpeechRecognition",
  "SpeechSynthesis",
  "CanvasRenderingContext2D",
  "File",
  "FileList",
  "FileReader",
  "HTMLCanvasElement",
  "WebGLRenderingContext",
  "AudioContext",
  "MediaDevices",
  "MediaRecorder",
  "FormData",
  "IndexedDB",
  "Navigator",
  "getComputedStyle",
  "CSSStyleSheet",
  //"window",
  "this",
 // "__dirname"
  
  //"document"
];

 

            let current = globalObject;
            while (current && current !== Object.prototype) {
                Object.getOwnPropertyNames(current).forEach(name => {
                    if (!denySet.has(name) && !name.startsWith('_') && name !== 'globalThis' && !browserOnlyAPIs.includes(name)) {
                        globalSet.add(name);
                    }
                });
                current = Object.getPrototypeOf(current);
            }
            
            ['await', 'yield', 'arguments', 'undefined', 'NaN', 'Infinity', "meta", "import", "target", "new"].forEach(k => globalSet.add(k));
            return globalSet;
        }

        const standardESGlobals = generateGlobalBuiltInsSet();


function checkForReferenceErrors(code, options = {}) {
  const {
    additionalGlobals = [],
    ignoreGlobals     = false,
    ecmaVersion       = "latest",
    strictMode        = false,   // force strict mode (also auto-detected from "use strict")
    removeThis        = false,   // treat bare `this` as an error everywhere
    tdz               = true,    // detect Temporal Dead Zone violations
  } = options;

  // ─── Parse ────────────────────────────────────────────────────────────────
  let ast;
  try {
    ast = customAcorn.parse(code, { ecmaVersion, sourceType: "module", locations: true });
  } catch (error) {
    throw formatErrors(code, error);
  }

  // ─── Globals ──────────────────────────────────────────────────────────────
  const globals = ignoreGlobals
    ? new Set()
    : new Set([...standardESGlobals, ...additionalGlobals, "process"]);

  // ─── Scope Stack ──────────────────────────────────────────────────────────
  // Each scope: { type: "global"|"function"|"block", strict: bool, bindings: Map<name, {kind, declLine, declCol}> }
  const scopeStack = [];

  function currentScope() { return scopeStack[scopeStack.length - 1]; }

  function pushScope(type = "block", inheritStrict = true) {
    const parentStrict = scopeStack.length ? currentScope().strict : false;
    scopeStack.push({
      type,
      strict: inheritStrict ? parentStrict : strictMode,
      bindings: new Map(),
    });
  }

  function popScope() { scopeStack.pop(); }

  function isStrictMode() {
    return scopeStack.length ? currentScope().strict : strictMode;
  }

  function setStrictMode() {
    if (scopeStack.length) currentScope().strict = true;
  }

  /**
   * Add a binding to the appropriate scope.
   * kind: "var" | "let" | "const" | "function" | "param" | "import" | "catch"
   */
  function addBinding(name, kind, loc) {
    const declLine = loc?.start?.line ?? null;
    const declCol  = loc?.start?.column ?? null;

    if (kind === "var" || kind === "function") {
      // Hoist to nearest function or global scope
      for (let i = scopeStack.length - 1; i >= 0; i--) {
        if (scopeStack[i].type === "function" || scopeStack[i].type === "global") {
          if (!scopeStack[i].bindings.has(name)) {
            scopeStack[i].bindings.set(name, { kind, declLine, declCol });
          }
          return;
        }
      }
    } else {
      // let / const / param / import / catch → current block scope
      const scope = currentScope();
      scope.bindings.set(name, { kind, declLine, declCol });
    }
  }

  /**
   * Returns binding info or null.
   */
  function lookup(name) {
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      if (scopeStack[i].bindings.has(name)) {
        return { scope: scopeStack[i], binding: scopeStack[i].bindings.get(name) };
      }
    }
    return null;
  }

  function isDefined(name) { return lookup(name) !== null; }

  // ─── Pattern Helpers ──────────────────────────────────────────────────────
  function extractIdentifiers(pattern, names = []) {
    if (!pattern) return names;
    switch (pattern.type) {
      case "Identifier":
        names.push({ name: pattern.name, loc: pattern.loc });
        break;
      case "ObjectPattern":
        pattern.properties.forEach(p =>
          extractIdentifiers(p.type === "RestElement" ? p.argument : p.value, names));
        break;
      case "ArrayPattern":
        pattern.elements.forEach(el => el && extractIdentifiers(el, names));
        break;
      case "RestElement":
        extractIdentifiers(pattern.argument, names);
        break;
      case "AssignmentPattern":
        extractIdentifiers(pattern.left, names);
        break;
    }
    return names;
  }

  // ─── Declaration-context guard ────────────────────────────────────────────
  function isDeclarationContext(node, parent) {
    if (!parent) return false;
    return (
      (parent.type === "VariableDeclarator"    && parent.id       === node) ||
      (parent.type === "FunctionDeclaration"   && parent.id       === node) ||
      (parent.type === "FunctionExpression"    && parent.id       === node) ||
      (parent.type === "ClassDeclaration"      && parent.id       === node) ||
      (parent.type === "ClassExpression"       && parent.id       === node) ||
      (parent.type === "Property"              && parent.key      === node && !parent.computed) ||
      (parent.type === "MethodDefinition"      && parent.key      === node && !parent.computed) ||
      (parent.type === "MemberExpression"      && parent.property === node && !parent.computed) ||
      parent.type === "ImportSpecifier"                                      ||
      parent.type === "ImportDefaultSpecifier"                               ||
      (parent.type === "LabeledStatement"      && parent.label    === node)
    );
  }

  // ─── Error collection ─────────────────────────────────────────────────────
  const referenceErrors = [];
  const seenErrors      = new Set(); // deduplicate by name (mirrors original `seen` set)

  function addError(name, line, col, message) {
    // Allow duplicate lines for TDZ (different message), but deduplicate plain "not defined"
    const key = `${name}:${line}:${col}`;
    if (seenErrors.has(key)) return;
    seenErrors.add(key);
    referenceErrors.push({ name, line, col, message });
  }

  // ─── Strict-mode directive detector ──────────────────────────────────────
  function hasUseStrictDirective(body) {
    if (!Array.isArray(body)) return false;
    for (const stmt of body) {
      if (
        stmt.type === "ExpressionStatement" &&
        stmt.expression.type === "Literal" &&
        stmt.expression.value === "use strict"
      ) return true;
      // Only leading directives count
      if (stmt.type !== "ExpressionStatement") break;
    }
    return false;
  }

  // ─── Pre-pass: hoist var + function declarations ──────────────────────────
  // We do this before the main walk so forward references work correctly.
  // This pre-pass must mirror the scope structure.

  function hoistScope(nodes, scopeType) {
    // hoist only within this function/global boundary
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      hoistNode(node, scopeType);
    }
  }

  function hoistNode(node, boundaryType) {
    if (!node || typeof node !== "object" || !node.type) return;

    switch (node.type) {
      case "FunctionDeclaration":
        // function name hoisted to current scope
        if (node.id) addBinding(node.id.name, "function", node.id.loc);
        // Do NOT descend into function body for var hoisting — new boundary
        return;

      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return; // new boundary — stop

      case "VariableDeclaration":
        if (node.kind === "var") {
          node.declarations.forEach(decl => {
            extractIdentifiers(decl.id).forEach(({ name, loc }) =>
              addBinding(name, "var", loc));
          });
        }
        // Still descend into initialisers for nested var (handled by child walk)
        node.declarations.forEach(decl => {
          if (decl.init) hoistNode(decl.init, boundaryType);
        });
        break;

      default:
        // Recurse into child nodes
        for (const key of Object.keys(node)) {
          if (key === "type" || key === "loc" || key === "range" || key === "start" || key === "end") continue;
          const child = node[key];
          if (Array.isArray(child)) child.forEach(c => hoistNode(c, boundaryType));
          else if (child && typeof child === "object" && child.type) hoistNode(child, boundaryType);
        }
    }
  }

  // ─── Main scope-aware walker ───────────────────────────────────────────────
  function walk(node, ancestors = []) {
    if (!node || typeof node !== "object" || !node.type) return;

    const parent      = ancestors[ancestors.length - 1];
    const grandparent = ancestors[ancestors.length - 2];
    ancestors         = [...ancestors, node];

    switch (node.type) {
 
      // ── Strict-mode directives ──────────────────────────────────────────
      case "ExpressionStatement":
        if (
          node.expression.type === "Literal" &&
          node.expression.value === "use strict"
        ) setStrictMode();
        walkChildren(node, ancestors);
        break;

      // ── Imports (module-level bindings) ────────────────────────────────
      case "ImportDeclaration":
        node.specifiers.forEach(spec => {
          if (spec.local) addBinding(spec.local.name, "import", spec.local.loc);
        });
        break;

      // ── Variable declarations ───────────────────────────────────────────
      case "VariableDeclaration": {
        // var already hoisted; let/const need to be added now
        if (node.kind !== "var") {
          node.declarations.forEach(decl => {
            extractIdentifiers(decl.id).forEach(({ name, loc }) =>
              addBinding(name, node.kind, loc));
          });
        }
        // Walk initialisers (identifiers inside can still be checked)
        node.declarations.forEach(decl => {
          if (decl.init) walk(decl.init, ancestors);
        });
        break;
      }

      // ── Function Declaration ────────────────────────────────────────────
      case "FunctionDeclaration": {
        // name already hoisted; push function scope
        pushScope("function");
        if (hasUseStrictDirective(node.body.body)) setStrictMode();
        // 'arguments' is available in non-arrow functions
        addBinding("arguments", "var", null);
        node.params.forEach(p =>
          extractIdentifiers(p).forEach(({ name, loc }) =>
            addBinding(name, "param", loc)));
        // Hoist vars inside this function
        hoistScope(node.body.body, "function");
        walkChildren(node.body, ancestors); // walk body block directly
        popScope();
        break;
      }

      // ── Function Expression ─────────────────────────────────────────────
      case "FunctionExpression": {
        pushScope("function");
        if (hasUseStrictDirective(node.body.body)) setStrictMode();
        if (node.id) addBinding(node.id.name, "let", node.id.loc); // name visible inside
        addBinding("arguments", "var", null);
        node.params.forEach(p =>
          extractIdentifiers(p).forEach(({ name, loc }) =>
            addBinding(name, "param", loc)));
        hoistScope(node.body.body, "function");
        walkChildren(node.body, ancestors);
        popScope();
        break;
      }

      // ── Arrow Function ──────────────────────────────────────────────────
      case "ArrowFunctionExpression": {
        pushScope("function");
        // Arrow functions do NOT have their own `arguments`
        node.params.forEach(p =>
          extractIdentifiers(p).forEach(({ name, loc }) =>
            addBinding(name, "param", loc)));
        if (node.body.type === "BlockStatement") {
          if (hasUseStrictDirective(node.body.body)) setStrictMode();
          hoistScope(node.body.body, "function");
          walkChildren(node.body, ancestors);
        } else {
          walk(node.body, ancestors);
        }
        popScope();
        break;
      }

      // ── Class ───────────────────────────────────────────────────────────
      case "ClassDeclaration":
        if (node.id) addBinding(node.id.name, "let", node.id.loc);
        walkChildren(node, ancestors);
        break;

      case "ClassExpression":
        pushScope("block");
        if (node.id) addBinding(node.id.name, "let", node.id.loc);
        walkChildren(node, ancestors);
        popScope();
        break;

      // ── Block Statement ─────────────────────────────────────────────────
      case "BlockStatement": {
        const parentNode = ancestors[ancestors.length - 2];
        const isBodyOfFunction = parentNode && (
          parentNode.type === "FunctionDeclaration" ||
          parentNode.type === "FunctionExpression"  ||
          parentNode.type === "ArrowFunctionExpression"
        );
        if (!isBodyOfFunction) pushScope("block");
        walkChildren(node, ancestors);
        if (!isBodyOfFunction) popScope();
        break;
      }

      // ── Catch Clause ────────────────────────────────────────────────────
      case "CatchClause":
        pushScope("block");
        if (node.param) {
          extractIdentifiers(node.param).forEach(({ name, loc }) =>
            addBinding(name, "catch", loc));
        }
        walkChildren(node, ancestors);
        popScope();
        break;

      // ── for / for-in / for-of (block scope for let/const iterator) ──────
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        pushScope("block");
        // init / left is walked by walkChildren which will hit VariableDeclaration
        walkChildren(node, ancestors);
        popScope();
        break;
      }

      // ── Assignment (implicit globals in sloppy mode) ─────────────────────
      case "AssignmentExpression": {
        if (node.left.type === "Identifier") {
          const name = node.left.name;
          if (!isDefined(name) && !globals.has(name)) {
            if (isStrictMode()) {
              // strict mode: assigning to undeclared var is a ReferenceError
              addError(
                name,
                node.left.loc?.start?.line,
                node.left.loc?.start?.column,
                `ReferenceError (strict): '${name}' is not defined`
              );
            } else {
              // sloppy mode: implicit global creation
              scopeStack[0].bindings.set(name, { kind: "var", declLine: null, declCol: null });
            }
          }
        }
        walkChildren(node, ancestors);
        break;
      }

      // ── Identifier ───────────────────────────────────────────────────────
      case "Identifier": {
        if (isDeclarationContext(node, parent)) break;

        const name = node.name;
        const line = node.loc?.start?.line;
        const col  = node.loc?.start?.column;

        // `self` bare (not self.x) is always an error
        if (name === "self") {
          if (!(parent?.type === "MemberExpression" && parent.object === node)) {
            addError(name, line, col, `ReferenceError: 'self' used without property access`);
          }
          break;
        }

        if (globals.has(name)) break;

        const found = lookup(name);
        if (!found) {
          const key = `notdef:${name}`;
          if (!seenErrors.has(key)) {
            seenErrors.add(key);
            addError(name, line, col, `ReferenceError: '${name}' is not defined`);
          }
          break;
        }

        // TDZ check for let/const
        if (tdz && (found.binding.kind === "let" || found.binding.kind === "const")) {
          const declLine = found.binding.declLine;
          const declCol  = found.binding.declCol;
          if (
            declLine !== null &&
            (line < declLine || (line === declLine && col < declCol))
          ) {
            addError(
              name, line, col,
              `ReferenceError (TDZ): '${name}' accessed before its declaration (declared at line ${declLine})`
            );
          }
        }
        break;
      }

      // ── this ─────────────────────────────────────────────────────────────
      case "ThisExpression": {
        const line = node.loc?.start?.line;
        const col  = node.loc?.start?.column;

        if (removeThis) {
          addError("this", line, col, `ReferenceError: 'this' is not allowed here`);
          break;
        }

        // In strict mode, `this` at the top-level (global scope) is undefined — flag bare this
        if (isStrictMode()) {
          const inFunction = scopeStack.some(s => s.type === "function");
          if (!inFunction) {
            // bare this at module/global level in strict mode → undefined (not an error per se,
            // but many analyzers warn; we match browser: no ReferenceError, but warn)
            addError("this", line, col, "Warning (strict): 'this' is undefined at top level");
          }
        } 
 
        // Bare `this` (not this.x) outside any function in sloppy mode is valid (window),
        // so no error there.
        break;
      }

      // ── Default: recurse ─────────────────────────────────────────────────
      default:
        walkChildren(node, ancestors);
    }
  }

  function walkChildren(node, ancestors) {
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "loc" || key === "range" || key === "start" || key === "end") continue;
      const child = node[key];
      if (Array.isArray(child)) {
        child.forEach(c => { if (c && typeof c === "object" && c.type) walk(c, ancestors); });
      } else if (child && typeof child === "object" && child.type) {
        walk(child, ancestors);
      }
    }
  }

  // ─── Kick off ─────────────────────────────────────────────────────────────
  pushScope("global", false);
  if (strictMode) setStrictMode();

  // Detect top-level "use strict"
  if (hasUseStrictDirective(ast.body)) setStrictMode();

  // Hoist top-level var + function declarations
  hoistScope(ast.body, "global");

  // Main walk
  walkChildren(ast, [ast]);

  // ─── Result ───────────────────────────────────────────────────────────────
  return {
    errors: referenceErrors,
    strict: isStrictMode(),
    formatErrors: (errors = referenceErrors) =>
      !errors.length
        ? "✓ No reference errors"
        : errors.map(e => `[Line ${e.line}:${e.col}] ${e.message}`).join("\n"),
  };
}
        function checkForReferenceErrors2(code, options = {}) {
          
           /* known issues - doesnt throw error for example 
            
            
            console.log(await) should throw Uncaught ReferenceError: await is not defined  
            
            Current error throws only if in version 2020 - does not allow top level: 
            
            Uncaught SyntaxError: await is only valid in async functions and the top level bodies of modules 
           
           */ 
            const { additionalGlobals = [], ignoreGlobals = false, ecmaVersion = "latest" } = options;

            let ast;
            try {
               
                ast = customAcorn.parse(code, { ecmaVersion, sourceType: "module", locations: true });
            } catch (error) {
           
             error = formatErrors(code, error)
              
              throw error
            }

            const referenceErrors = [];
            const seen = new Set();
            const globals = ignoreGlobals ? new Set() : new Set([...standardESGlobals, ...additionalGlobals, 'process']);

      
            // Stack-based scope tracker
            const scopeStack = [];
            
            function pushScope() {
                scopeStack.push(new Set());
            }
            
            function popScope() {
                scopeStack.pop();
            }
            
            function addBinding(name) {
                if (scopeStack.length > 0) {
                    scopeStack[scopeStack.length - 1].add(name);
                }
            }
            
            function isDefined(name) {
                // Check all scopes from innermost to outermost
                for (let i = scopeStack.length - 1; i >= 0; i--) {
                    if (scopeStack[i].has(name)) {
                        return true;
                    }
                }
                return false;
            }

            // Helper to extract identifiers from patterns
            function extractIdentifiers(pattern, names = []) {
                if (!pattern) return names;

                switch (pattern.type) {
                    case 'Identifier':
                        names.push(pattern.name);
                        break;
                    case 'ObjectPattern':
                        pattern.properties.forEach(prop => {
                            if (prop.type === 'Property') {
                                extractIdentifiers(prop.value, names);
                            } else if (prop.type === 'RestElement') {
                                extractIdentifiers(prop.argument, names);
                            }
                        });
                        break;
                    case 'ArrayPattern':
                        pattern.elements.forEach(el => {
                            if (el) extractIdentifiers(el, names);
                        });
                        break;
                    case 'RestElement':
                        extractIdentifiers(pattern.argument, names);
                        break;
                    case 'AssignmentPattern':
                        extractIdentifiers(pattern.left, names);
                        break;
                }
                return names;
            }

            function isDeclarationContext(node, parent, grandparent) {
                if (!parent) return false;
                return (
                    (parent.type === 'VariableDeclarator' && parent.id === node) ||
                    (parent.type === 'FunctionDeclaration' && parent.id === node) ||
                    (parent.type === 'FunctionExpression' && parent.id === node) ||
                    (parent.type === 'ClassDeclaration' && parent.id === node) ||
                    (parent.type === 'ClassExpression' && parent.id === node) ||
                    (parent.type === 'Property' && parent.key === node && !parent.computed) ||
                    (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) ||
                    (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
                    (parent.type === 'ImportSpecifier') ||
                    (parent.type === 'ImportDefaultSpecifier') ||
                    (parent.type === 'LabeledStatement' && parent.label === node)
                );
            }

            // Initialize global scope
            pushScope();

            // Pre-pass: hoist function declarations
            walk.simple(ast, {
                FunctionDeclaration(node) {
                    if (node.id) {
                        addBinding(node.id.name);
                    }
                },
              
            });

            // Main traversal with enter/leave
            const visitors = {
                FunctionDeclaration(node, state, ancestors) {
                    // Create new scope for function body
                    pushScope();
                    // Add parameters to this scope
                    node.params.forEach(param => {
                        extractIdentifiers(param).forEach(name => addBinding(name));
                    });
                },
                
              AssignmentExpression(node, state, ancestors) {
                 /* Handles this like         
                  c = "to"
                  console.log(c)
                  */
                  if (node.left.type === 'Identifier') {
                    const name = node.left.name;

                    // If not already defined, treat as implicit global
                    if (!isDefined(name) && !globals.has(name)) {
                      // Add it to global scope (bottom of stack)
                      scopeStack[0].add(name);
                    }
                  }
                },
                FunctionExpression(node, state, ancestors) {
                    pushScope();
                    // Add function name to its own scope (for recursion)
                    if (node.id) {
                        addBinding(node.id.name);
                    }
                    node.params.forEach(param => {
                        extractIdentifiers(param).forEach(name => addBinding(name));
                    });
                },
                ArrowFunctionExpression(node, state, ancestors) {
                    pushScope();
                    node.params.forEach(param => {
                        extractIdentifiers(param).forEach(name => addBinding(name));
                    });
                },
                BlockStatement(node, state, ancestors) {
                    const parent = ancestors[ancestors.length - 2];
                    // Don't create scope for function bodies (function handles it)
                    if (parent && (
                        parent.type === 'FunctionDeclaration' ||
                        parent.type === 'FunctionExpression' ||
                        parent.type === 'ArrowFunctionExpression'
                    )) {
                        return;
                    }
                    // Create block scope for if/for/while blocks
                    pushScope();
                },
                CatchClause(node, state, ancestors) {
                    pushScope();
                    if (node.param) {
                        extractIdentifiers(node.param).forEach(name => addBinding(name));
                    }
                },
                VariableDeclaration(node, state, ancestors) {
                    node.declarations.forEach(decl => {
                        extractIdentifiers(decl.id).forEach(name => addBinding(name));
                    });
                },
                ClassDeclaration(node, state, ancestors) {
                    if (node.id) {
                        addBinding(node.id.name);
                    }
                },
                ImportDeclaration(node, state, ancestors) {
                    node.specifiers.forEach(spec => {
                        if (spec.local) {
                            addBinding(spec.local.name);
                        }
                    });
                },
              Identifier(node, state, ancestors) {
    const parent = ancestors[ancestors.length - 2];
    const grandparent = ancestors[ancestors.length - 3];

    if (isDeclarationContext(node, parent, grandparent)) {
        return;
    }

    // Block: self (by itself)
    if (node.name === 'self') {
        // Allow: self.property OR self['property']
        if (parent?.type === 'MemberExpression' && parent.object === node) {
            return;
        }

        referenceErrors.push({
            name: 'self',
            line: node.loc?.start?.line,
            col: node.loc?.start?.column,
            context: 'Identifier'
        });
        return;
    }

    const name = node.name;
    if (!isDefined(name) && !globals.has(name) && !seen.has(name)) {
        referenceErrors.push({
            name,
            line: node.loc?.start?.line,
            col: node.loc?.start?.column,
            context: parent?.type || 'unknown'
        });
        seen.add(name);
    }
},
                ThisExpression(node, state, ancestors) {
                      const parent = ancestors[ancestors.length - 2];

                      // Allow: this.property  OR  this['property']
                      if (parent?.type === 'MemberExpression' && parent.object === node) {
                          return;
                      }

                  
              
                    if (!globals.has('this')) {
                        referenceErrors.push({
                            name: "this",
                            line: node.loc?.start?.line,
                            col: node.loc?.start?.column,
                            context: parent?.type || 'unknown'
                        });
                        seen.add('this');
                    }
                  
                      // Block: this (by itself)
                  
                    /*  referenceErrors.push({
                          name: 'this',
                          line: node.loc?.start?.line,
                          col: node.loc?.start?.column,
                          context: 'ThisExpression'
                      });*/ 
                  },
                Identifier(node, state, ancestors) {
                    const parent = ancestors[ancestors.length - 2];
                    const grandparent = ancestors[ancestors.length - 3];
                    
                    if (isDeclarationContext(node, parent, grandparent)) {
                        return;
                    }
                  
                  
                    // Block: self (by itself)
                    if (node.name === 'self') {
                        // Allow: self.property OR self['property']
                        if (parent?.type === 'MemberExpression' && parent.object === node) {
                            return;
                        }

                        referenceErrors.push({
                            name: 'self',
                            line: node.loc?.start?.line,
                            col: node.loc?.start?.column,
                            context: 'Identifier'
                        });
                        return;
                    }
                  

                    const name = node.name;
                    if (!isDefined(name) && !globals.has(name) && !seen.has(name)) {
                        referenceErrors.push({
                            name,
                            line: node.loc?.start?.line,
                            col: node.loc?.start?.column,
                            context: parent?.type || 'unknown'
                        });
                        seen.add(name);
                    }
                }
            };

            // Custom walk that handles scope exit
            function walkWithScopes(node, visitors, ancestors = []) {
                ancestors = ancestors.concat(node);
                
                const visitor = visitors[node.type];
                if (visitor) {
                    visitor(node, null, ancestors);
                }

                // Walk children
                for (const key in node) {
                    if (key === 'type' || key === 'loc' || key === 'range') continue;
                    
                    const child = node[key];
                    if (!child) continue;

                    if (Array.isArray(child)) {
                        child.forEach(c => {
                            if (c && typeof c === 'object' && c.type) {
                                walkWithScopes(c, visitors, ancestors);
                            }
                        });
                    } else if (typeof child === 'object' && child.type) {
                        walkWithScopes(child, visitors, ancestors);
                    }
                }

                // Pop scope on exit
                if (node.type === 'FunctionDeclaration' ||
                    node.type === 'FunctionExpression' ||
                    node.type === 'ArrowFunctionExpression' ||
                    node.type === 'CatchClause') {
                    popScope();
                } else if (node.type === 'BlockStatement') {
                    const parent = ancestors[ancestors.length - 2];
                    if (!parent || (
                        parent.type !== 'FunctionDeclaration' &&
                        parent.type !== 'FunctionExpression' &&
                        parent.type !== 'ArrowFunctionExpression'
                    )) {
                        popScope();
                    }
                }
            }

            walkWithScopes(ast, visitors);

            return { 
                errors: referenceErrors, 
                formatErrors: (errors) => !errors.length ? "✓ No reference errors" : 
                    errors.map(e => `[Line ${e.line}:${e.col}] '${e.name}' not defined`).join("\n")
            };
        }


function refCheck(code, additionalGlobals=[]){
  
  const refErrors = checkForReferenceErrors(code, {additionalGlobals});
 
if(refErrors.errors.length != 0){
  throw new Error(refErrors.formatErrors(refErrors.errors))
}
  
}

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
      handlers.forEach(handler => {
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
    this.cdnBase = options.cdnBase || 'https://esm.sh';
    this.transformRules = options.transformRules || [];
    this.cache = new Map();
    this.fallbackCDN = options.fallbackCDN
  }

  
  resolve(code) {
  const imports = [];
  const requires = [];
  const cleaned = {imports:[], dynamicImports:[], requires:[]}
  const dynamicImports = []; // New tracker
  const replacements = [];

  const ast = customAcorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module'
  });

  // 1. Process Static Imports (ImportDeclaration)
  const importNodes = ast.body.filter(node => node.type === 'ImportDeclaration');
  for (const node of importNodes) {
    const source = node.source.value;
    const transformedSource = this._transformSource(source, 'import');
    cleaned.imports.push(transformedSource)
    imports.push(code.slice(node.start, node.source.start) + `'${transformedSource}'` + code.slice(node.source.end, node.end));
    replacements.push({ start: node.start, end: node.end, content: '' });
  }

  // 2. Process Requires and Dynamic Imports (Walking the AST)
  this._walkAST(ast, node => {
    // --- HANDLE REQUIRE ---
    if (node.type === 'CallExpression' && node.callee.name === 'require' && node.arguments[0]?.type === 'Literal') {
      const source = node.arguments[0].value;
      const transformedSource = this._transformSource(source, 'require');
      requires.push(`require('${transformedSource}')`);
      cleaned.requires.push(transformedSource);
      replacements.push({ start: node.arguments[0].start, end: node.arguments[0].end, content: `'${transformedSource}'` });
    }

    
    
    // --- HANDLE DYNAMIC IMPORT() ---
    if (node.type === 'ImportExpression' && node.source.type === 'Literal') {
      const source = node.source.value;
      const transformedSource = this._transformSource(source, 'dynamic-import');
      
      dynamicImports.push(`import('${transformedSource}')`);
      cleaned.dynamicImports.push(transformedSource);
      // Replace the string inside the import(...)
      replacements.push({ 
        start: node.source.start, 
        end: node.source.end, 
        content: `'${transformedSource}'` 
      });
    }
  });

  // 3. APPLY REPLACEMENTS
  replacements.sort((a, b) => b.start - a.start);

  let cleanedCode = code;
  for (const r of replacements) {
    cleanedCode = cleanedCode.slice(0, r.start) + r.content + cleanedCode.slice(r.end);
  }

  return {
    imports,
    requires,
    dynamicImports, // Added to return object
    cleanedCode: cleanedCode.trim(),
    cleanedImports:cleaned,
    hasImportsOrRequires: imports.length + requires.length + dynamicImports.length > 0
  };
}
  
  
  

  _walkAST(node, callback) {
    callback(node);

    for (const key in node) {
      if (!node.hasOwnProperty(key)) continue;
      const child = node[key];

      if (Array.isArray(child)) {
        child.forEach(n => n && typeof n.type === 'string' && this._walkAST(n, callback));
      } else if (child && typeof child.type === 'string') {
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
      typeof rule.test === 'function'
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

  if (transformed.startsWith('./') || transformed.startsWith('../')) {
    return transformed
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


class ExecutionContext {
  constructor(iframe, sandbox) {
    this.iframe = iframe;
    this.sandbox = sandbox
    this.config = sandbox.config;
    this.messageHandler = null;
    this.cleanupCallbacks = [];
    this.resolved = false;
    this.running = false;
    this.interopCallbacks = new Map();
    this.stdout = []
    this.stderr = []
    this.startTime = null;   
    this._resolve = null;   
    this._reject = null;
    this._serverRunning = false;
    this._serverPort = null;
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
forceKill(reason = 'Process killed by user') {
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
  const executionTime = this.startTime != null
    ? +(performance.now() - this.startTime).toFixed(2)
    : 0;

  // Best-effort courtesy ping — helps in the *non-blocking* async case
  // (the iframe is idle/awaiting) where it can still process a message
  // and report back before we yank it. Harmless no-op if it's stuck.
  try {
    this.iframe.contentWindow?.postMessage({ type: 'kill_request', reason }, '*');
  } catch (e) {}

  // The actual kill: tear down the realm from outside.
  try {
    if (!this.sandbox.destroyIframe && this.iframe) {
      // Persistent, user-supplied iframe — we can't remove it, so navigate
      // it away instead. This still destroys the current document/global
      // scope and halts execution immediately.
      this.iframe.src = 'about:blank';
    }
    // If destroyIframe is true, cleanup() below removes the node from the
    // DOM, which has the same terminating effect.
  } catch (err) {
    console.warn('[kill] failed to tear down iframe:', err);
  }

  this.cleanup();
 
  const results = {
    success: false,
    killed: true,
    error: reason,
    stack: reason,
    logs: [...this.stdout, 'Process Killed'],
    executionTime
  };

  this.sandbox.emit('execution:kill', { id: this.sandbox.executionCount, reason, executionTime });

  if (typeof this._resolve === 'function') {
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
  "style-src 'unsafe-inline'"
].join('; ');
const csp2 = [
  "default-src 'none'",
  "script-src 'unsafe-eval' 'unsafe-inline' data: blob: https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
  "script-src-elem 'self' 'unsafe-inline' blob: data: https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com  https://ga.jspm.io 'unsafe-inline'; img-src 'self' data:;", 
  "worker-src blob: data:",
  "connect-src *",
  "style-src 'unsafe-inline'"
].join('; ');

     this.startTime = performance.now(); // needed for forceKill's executionTime

    // Escape the code to prevent breaking out of script tags
    const escapedCode = code
      .replace(/</g, '\\x3C')
      .replace(/>/g, '\\x3E');

    this.exposedMethods = this._parseExposedMethods(code, "interop")
    
    code = this.hoistingTransform(code, "interop")
    
 
    
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
  const base = doc.createElement('base');
  base.href = window.location.origin; 
  doc.head.appendChild(base);
 
  // 2. Add the CSP meta tag
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', csp);
  doc.head.appendChild(meta);

  // 3. Define window.esmsInitOptions with the hook FIRST (using plain JS so the function works)
  const optionsScript = doc.createElement('script');
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
  
  
  let modulePath = specifier;
  
  const strippable_nodebuiltins = node_builtin.filter(m => m.includes('node:'))
  
  const isStrippable = strippable_nodebuiltins.includes(modulePath) || node_builtin.includes(modulePath);
  
   const isNodeBuiltIn = node_builtin.includes(modulePath) || isStrippable;  
    
   if(isStrippable){
   modulePath = modulePath.replace("node:", ""); // strip node:
   modulePath = modulePath.replace("/", "_");
   modulePath = modulePath.replace("RUNTIME:", "RUNTIME_")
   }  

       if(isNodeBuiltIn){ 
        
       let data =  await globalThis[Symbol.for("bvm.interop")].callParent(
          '_dynamic_import',
          modulePath,
          'import',
          '/',
          '/',
          true,
          globalThis._RUNTIME${iframe.sandbox.uuid}_.cwd,
          globalThis._RUNTIME${iframe.sandbox.uuid}_.__USER_FILES__   
        );
        
        
        data = await globalThis[Symbol.for("bvm.interop")].callParent(
          '_build_file',
          data,
          specifier,
          'import',
          '/',
          '/',
          true
        );
        
         return \`data:text/javascript;charset=utf-8,\${encodeURIComponent(data)}\`; 
       } 
          
       
        return defaultResolve(specifier, parentURL);
      }
    };
  `;
  doc.head.appendChild(optionsScript);
// 5. Add your dynamic code script tag
  const script = doc.createElement('script');
  script.type = 'module-shim'
  script.textContent = code;
  doc.body.appendChild(script);
  // 4. Load es-module-shims SECOND with async = false to guarantee it reads the options immediately
  const shimScript = doc.createElement('script');
  shimScript.async = false;
  shimScript.src = 'https://ga.jspm.io/npm:es-module-shims@1.10.0/dist/es-module-shims.js';
  doc.head.appendChild(shimScript);

  

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}
    
    function buildHtmlString2(csp, code, hasImports) {
  // Create a new HTML document
  const doc = document.implementation.createHTMLDocument();
 
  // Add the CSP meta tag
  const meta = document.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', csp);
  doc.head.appendChild(meta);


      
  const script = document.createElement('script');
  if (hasImports) script.type = 'module';
  script.textContent = code;
  doc.body.appendChild(script);

  // Serialize to string, including DOCTYPE
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}
    
    
    
    const htmlString = buildHtmlString(csp, code, hasImports, this);
    
    const blob = new Blob([htmlString], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    this.iframe.src = url; 
    this.code = code
    if(this.oldURL){
      
      URL.revokeObjectURL(this.oldURL);
    }
    this.oldURL = url;
    // URL.revokeObjectURL(oldUrl);
  }
 
  
   hoistingTransform(code, objectName) {
  return code // currently disabled as of right now.
  const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" });
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
          (left.property.type === "Identifier" && left.property.name === interopVariable) ||
          (left.property.type === "Literal" && left.property.value === interopVariable)
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
        if (data.type === 'serverListening') {  
           this.sandbox.emit('execution:server', {type:"open", port:data.port});
           this._serverRunning = true; 
           this._serverPort = data.port;
        }
      
       if (data.type === 'serverClosed') {  
           this.sandbox.emit('execution:server', {type:"closed", port:this._serverPort});
           this._serverRunning = false; 
           this._serverPort = null;
        }
      
      
      
         // ── spawn ──────────────────────────────────────────────────────────────
    if (data.type === 'PARENT_SPAWN_REQUEST') {
      
              const { command, args = [], options, vfs } = data.payload;
        const assembled = [command, ...args].join(' ');

        const pushChunk = (stream, chunk) =>
            event.source.postMessage(
                { type: 'PARENT_SPAWN_DATA', requestId, payload: { stream, chunk } },
                '*'
            );

      
      
      
    }
      
      
       if (data.type === 'PARENT_EXEC_REQUEST') {
   
         
      
              const bashInstance = async (_command, options = {}, sandboxHost, _args = null) => {
              
    const command = _command.split(" ")[0]
    const args = _args?.join("\n") || _command.split(" ").slice(1).join("\n");
                
    if(command === "echo"){
         return {stdout: _command.split(" ").slice(1).join(" "), stderr: null,  exitCode:0}
    }
    if(command === "execute"){
  
        // TODO: pass current VFS to new instance.
       let _stdout = await executeCode(args)
        
       const stdout = _stdout.logs.map(l => l.args).join('\n')
       return {stdout: stdout, stderr: _stdout.error || null,  exitCode:0}
    }
    if(command === "ls"){
      return {stdout: "cool", stderr: null,  exitCode:0}
    }
    // Simulate async work
  //   await new Promise(r => setTimeout(r, 800));

                 
                throw new Error("cool")
    return {  
        stdout: `${command}: command not found`,  
        stderr: '',  
        exitCode: 127,
        signal: null
    }; 
};  
         
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
               
                 
                  if (typeof bashInstance !== 'function') {
          throw new Error('shell is not implemented in this sandbox.');  // todo - this gets hung for some reason but above throw new Error("cool") doesn't?
           }
                  
 
                   const result = await bashInstance(data.payload.command, data.payload.options, this, data.payload.args);
                   
                  
                   
                    // Send result back to the specific iframe that requested it
                    event.source.postMessage({
                        type: 'PARENT_CHILD_EXEC_RESPONSE',
                        requestId: data.requestId,
                        payload: result
                    }, '*');

                } catch (err) {
         
                    event.source.postMessage({
                        type: 'PARENT_CHILD_EXEC_RESPONSE',
                        requestId: data.requestId,
                        payload: { stdout: '', stderr: err?.message || 'Command not found or syntax error', exitCode: 1 }  
                    }, '*');
                }
               
            }
      
       if (data.type === 'fs') {
          this.sandbox.emit('execution:fs', data);
          return;
       }
      
      if (data.type === 'interop_call') {
        this.handleInteropCall(data);
        return;
      }
      
      
      if (data.type === 'newline') {
        this.sandbox.emit('execution:readline_newline', true);
        return;
      }
      
      
      if (data.type === 'interop_registered') {
        this.sandbox.emit('execution:interop_registered', { name:data.name });
        return;
      }
      
      // NEW: Handle interop responses
      if (data.type === 'interop_result') {
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
      
     
      
       if (data.type === 'sandbox_ready') {
         
         /*
         this.executionCount++;
         const executionId = this.executionCount;
         this.emit('execution:start', { id: executionId, code });
         */ 
         // this.executionCount++;
         const executionId = this.sandbox.executionCount;
         this.running = true;
         this.sandbox.emit('execution:start', { id:  executionId, code:false });
       }
   
      
      if (data.type === 'function_results') {
        this.resolved = true;
        this.cleanup();
        const results = {
          success: true,
          logs: data.logs || [],
          errors: data.errors || [],
          //output: data.logs,
          fs:data.fs,
          executionTime: data.executionTime
        }
        resolve(results);
      }else if (data.type === 'stdout') {
       // this.logs.push({type:data.method, args:data.message})
        this.sandbox.emit('execution:stdout', {type:data.method, args:data.message});
    
      }else if (data.type === 'resource_timing') {
        const r = JSON.parse(data.message);
        this.sandbox.emit('execution:resource_timing', r);
      }else if (data.type === 'key_event') {
  
        const r = JSON.parse(data.message);
 
        this.sandbox.emit('execution:key_event', r);
      }
      else if (data.type === 'network_request') {
        const r = JSON.parse(data.message);
        
        this.sandbox.emit('execution:network_request', r);
      }else if (data.type === 'kill') {
 
        this.resolved = true;
        this.cleanup(); 
        this.killed = true
        const results = {
          success: true,
          error: data?.error || false,
           logs: [...data.logs, 'Process Exited'],
         // output: [...data.logs, 'Process Exited'],
          executionTime: data.executionTime
        };
        resolve(results);
        
      } else if (data.type === 'function_error') {
 
        
         // Map frames to original positions via the source-map registry.
         // Falls back to legacy line-offset math if no frames/registry.
         let mappedReason;
         if (data.frames && data.frames.length) {
           const mapped = this.sandbox._mapStackFrames(data.frames, this.code);
           mappedReason = this.sandbox._formatMappedError(data.errorName, data.error, mapped);
         } else {
           // Legacy fallback (no structured frames)
           let line = this.code.slice(0, this.code.indexOf("//__$PROVIDED_RUNTIME_CODE__/")).split("\n").length;
           line = data.line - line;
           const isNegative = n => n < 0;
           if (isNegative(line)) {
             mappedReason = `${data.stack || data.reason || data.error || data.message}`;
           } else {
             const codeThatThrewError = this.code.split('\n')[Number(data.line) - 1] || '';
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
          executionTime: data.executionTime
        });
      } else if (data.type === 'window_error') {
        if (this.config.captureWindowErrors && !this.resolved) {
          this.resolved = true;
          this.cleanup();
          // Map frames to original positions via the source-map registry.
          const mapped = data.frames && data.frames.length
            ? this.sandbox._mapStackFrames(data.frames, this.code)
            : [];
          const mappedMsg = mapped.length
            ? this.sandbox._formatMappedError(data.errorName, data.message, mapped)
            : (data.message || 'Window error');
          const err = new Error(mappedMsg);
          if (data.stack) err.stack = String(data.stack);
          reject(err);
        }
      } else if (data.type === 'unhandled_promise_rejection') {
        if (this.config.capturePromiseRejections && !this.resolved) {
          this.resolved = true;
          this.cleanup();
          
          // Map frames to original positions via the source-map registry.
          const mapped = data.frames && data.frames.length
            ? this.sandbox._mapStackFrames(data.frames, this.code)
            : [];
          const mappedReason = mapped.length
            ? this.sandbox._formatMappedError(data.errorName, data.reason, mapped)
            : (data.reason || 'Unhandled promise rejection');
          
          const rejectionError = new Error(mappedReason);
          if (data.stack) rejectionError.stack = String(data.stack);
          reject(rejectionError);
        }
      }
    };

    window.addEventListener('message', this.messageHandler);
    this.cleanupCallbacks.push(() => {
      window.removeEventListener('message', this.messageHandler);
    });
  }

  
    async handleInteropCall(data) {
    const { callId, method, args } = data;
    
    // Check if sandbox has registered this method
    const handler = this.sandbox.interopHandlers?.[method];
   
    if (!handler) {
      this.iframe.contentWindow.postMessage({
        type: 'interop_response',
        callId,
        error: `Method '${method}' not registered in parent`
      }, '*');
      return;
    }
    
    try {
      const result = await handler(...args);
   
      
      this.iframe.contentWindow.postMessage({
        type: 'interop_response',
        callId,
        result
      }, '*');
    } catch (err) {
      this.iframe.contentWindow.postMessage({
        type: 'interop_response',
        callId,
        error: err.message
      }, '*');
    }
  }

  // NEW: Call functions inside sandbox from parent
 /**
 * Call functions inside sandbox from parent
 * Use arrow function syntax to ensure 'this' always refers to the ExecutionContext instance.
 */
invoke = async (method, ...args) => {
  // Ensure the iframe is actually loaded before sending messages 
  if (!this.iframe || !this.iframe.contentWindow || this.running === false) {
    throw new Error("Sandbox is not running.")
  }
  const callId = Math.random().toString(36).substr(2, 9);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Check if it still exists before rejecting to avoid race conditions
     
      if (this.interopCallbacks.has(callId)) {
        this.interopCallbacks.delete(callId);
        if(this.running === false){
         reject(new Error(`Interop method failed (sandbox is closed): ${method}`));
        };
        reject(new Error(`Interop invoke timeout: ${method}`));
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
      }
    });

    this.iframe.contentWindow.postMessage({
      type: 'interop_invoke',
      callId,
      method,
      args
    }, '*');
  });
}
  
 
  /**
 * Parses method names exposed via [variable].expose('name', ...)
 * @param {string} code - The source code to parse
 * @param {string} interopVar - The variable name to look for (e.g., 'interop')
 */
_parseExposedMethods(code, interopVar) {
  const exposedMethods = [];
  
  const ast = acorn.parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  });

  walk.simple(ast, {
    CallExpression(node) {
      const { callee, arguments: args } = node;

      if (
        callee.type === 'MemberExpression' &&
        callee.object.name === interopVar &&
        callee.property.name === 'expose'
      ) {
        if (args[0] && args[0].type === 'Literal') {
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
    
  } 
  
  hasMethod = async (method) => {
  try {
     
    if(this.exposedMethods.includes(method)){
       return true
       }
    return false
    // We invoke a special internal check
    //return await this.invoke('__check_exists__', method);
  } catch {
    return false;
  }
}
  
  /**
   * Cleanup resources
   */
  cleanup() {
    this.running = false;
     
    if(this._serverRunning === true){
      this.sandbox.emit('execution:server', {type:"closed", port:this._serverPort});
      this._serverRunning = false; 
      this._serverPort = null;
    }
    
    this.cleanupCallbacks.forEach(cb => {
      try {
        cb();
      } catch (err) {
        console.warn('Cleanup error:', err);
      }
    });
    this.cleanupCallbacks = [];
    
    if (this.iframe && this.iframe.parentNode && this.sandbox.destroyIframe === true) {
      
      this.iframe.remove();
    }
  }
}







 

// ============================================================================
// SANDBOX RUNTIME TEMPLATE
// ============================================================================
 
// To hide your internal runtime logic and prevent user code from tampering with your patches, you need to use **lexical scoping (closures)** and **Shadow Realms** (or the pattern of "Localizing Globals").
//
// If you just define `originalFetch` in the global scope, a clever user can find it, delete it, or bypass your tracking.
//
// Here are the three best ways to "cloak" your runtime:
//
// ---
//
// ### 1. The IIFE Wrapper (Closure Isolation)
//
// By wrapping your entire runtime in an **Immediately Invoked Function Expression (IIFE)**, all your `original` variables and `pendingMaps` exist only in a private scope that the user code cannot physically reach.
//
// ```javascript
// static generate(code, config = {}) {
//   return `
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
//   `;
// }
// ```
//
// ### 2. The "Hidden Property" Pattern (Using Symbols)
//
// If you must attach something to a global object but don't want the user to see it when they run `Object.keys(window)`, use **Symbols**. Symbols are non-enumerable and "invisible" to standard loops.
//
// ```javascript
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
// ```
//
// ### 3. Object Shielding (Freezing the Prototype)
//
// Users can often bypass patches by going to the prototype (e.g., `HTMLAnchorElement.prototype.click`). To prevent them from un-patching your work, you can **freeze** the descriptors of the functions you’ve patched.
//
// ```javascript
// Object.defineProperty(window, 'fetch', {
//   value: myPatchedFetch,
//   writable: false,     // User can't do: window.fetch = ...
//   configurable: false,  // User can't delete it or change this config
//   enumerable: true
// });
//
// ```
//
// ---
//
// ### 4. Advanced: The "Clean Room" Helper
//
// When patching, users can sometimes detect your "traps" by checking `fetch.toString()`. A truly hidden runtime will "mask" the function string to look native.
//
// ```javascript
// function maskFunction(patchedFn, originalFn) {
//   Object.defineProperty(patchedFn, 'name', { value: originalFn.name });
//   patchedFn.toString = () => originalFn.toString();
// }
//
// // Now console.log(fetch.toString()) prints "function fetch() { [native code] }" 
// // instead of your internal source code.
//
// ```
//
// ### Recommendation for your Sandbox
//
// I suggest combining **Method 1 (IIFE)** and **Method 4 (Masking)**.
//
// 1. Put all your `originalFetch`, `pendingModules`, and `asyncRegistry` variables at the very top of the IIFE.
// 2. Only expose the final "public" API (the patched `fetch`, `setTimeout`, etc.).
// 3. Mask the `toString` so the user can't inspect your tracking logic.
//
// **Would you like me to update the `SandboxRuntime` class to wrap everything in this secure "Private Closure" structure?**


// Parse one V8 stack-frame line into {file, line, column}.
// Handles "at fn (https://host/app.js:10:15)", "at async fn (...)", and
// "at https://host/app.js:10:15". Anchored at the end so URL schemes
// (https://...) are never mistaken for the line/column separators.
// Defined once at module scope and exported for unit tests; the sandbox
// template below inlines it via ${__parseStackLocation.toString()} so the
// iframe gets the identical implementation (single source of truth).
export function __parseStackLocation(frame) {
  let s = String(frame || '').trim().replace(/^at\s+(async\s+)?/, '');
  // data: URLs embed the whole (encoded) module source, which may contain
  // unencoded parens/quotes — match the URL as one unit before the generic
  // paren-stripping below (whose lastIndexOf('(') would land inside the
  // module source). Greedy: the only literal colons are the trailing
  // :line:column (inner colons are %-encoded).
  let m = s.match(/\(?(data:[^\s]*):(\d+):(\d+)\)?$/);
  if (m) return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
  const open = s.lastIndexOf('(');
  if (open !== -1 && s.endsWith(')')) s = s.slice(open + 1, -1);
  m = s.match(/^(.*):(\d+):(\d+)$/);
  if (!m) return null;
  return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
}


class SandboxRuntime {
  static generate(code, config = {}) {
     
 
    
    return `


globalThis._RUNTIME${config.uuid}_ = {globals: new Set(), process:${JSON.stringify(config.process)}, taskTracker:null, __USER_FILES__:${JSON.stringify(config.fs)}, __SEA_ASSETS__:${JSON.stringify(config.seaAssets && Object.keys(config.seaAssets).length ? config.seaAssets : undefined)}};

window._RUNTIME${config.uuid}_ = globalThis._RUNTIME${config.uuid}_;



// ─── Vitest/fork support patches ───
// 1. Force configurable:true on global defineProperty. All forks share one
//    globalThis, and vitest sets globals (like __vitest_index__) non-configurably
//    which crashes every re-run (watch mode). Neuter at the lowest level.
(function() {
  const origDefineProperty = Object.defineProperty;
  Object.defineProperty = function(obj, prop, descriptor) {
    if (obj === globalThis && descriptor && typeof descriptor === 'object') {
      descriptor = { ...descriptor, configurable: true };
    }
    return origDefineProperty.call(this, obj, prop, descriptor);
  };
})();

// 2. process.exit semantics: in sync context throw to halt execution (like
//    real Node), in async context resolve silently. This lets forked workers
//    terminate cleanly without killing the parent realm.
(function() {
  const rt = globalThis._RUNTIME${config.uuid}_;
  if (rt && rt.process) {
    const origExit = rt.process.exit;
    rt.process.exit = function(code) {
      code = code || 0;
      // Emit 'exit' event if listeners exist
      if (typeof rt.process.emit === 'function') {
        try { rt.process.emit('exit', code); } catch {}
      }
      // In async context (we're in a promise), resolve silently.
      // In sync context, throw to halt like real Node.
      // Heuristic: if we're inside a microtask, we're async.
      // For now, throw a special error that the runtime catches.
      const err = new Error('process.exit(' + code + ')');
      err.code = 'PROCESS_EXIT';
      err.exitCode = code;
      throw err;
    };
  }
})();


if (!Array.prototype.toSorted) {
  Array.prototype.toSorted = function(compareFn) {
    // Create a shallow copy of the array and sort it in place
    const copy = [...this];
    copy.sort(compareFn);
    return copy;
  };
}

// A recursive Proxy that intercepts *any* missing property access and returns safe stubs
    function createSafeProxy(target = {}) {
      return new Proxy(target, {
        get(obj, prop) {
          if (prop === Symbol.iterator) return obj[Symbol.iterator];
          if (prop in obj) {
            const val = obj[prop];
            if (val && typeof val === 'object') return createSafeProxy(val);
            return val;
          }
          // Fallback recursive proxy for any unmapped configuration property
          return createSafeProxy();
        }
      });
    }

    // Mock globalThis.__vitest_worker__ using the Proxy so .config or anything else never throws
    globalThis.__vitest_worker__ = createSafeProxy({
      config: {
        root: '/',
        globals: true,
        environment: 'node',
        test: {
          globals: true,
          environment: 'node',
          reporters: [],
          pool: 'threads'
        }
      },
      durations: { environment: 0, prepare: 0 },
      rpc: {}
    });
  
class TaskTracker {
  constructor() {
    this.pendingCount = 0;
    this.resolvers = [];
  }

  // Wraps any function (sync or async)
  track(fn) {
    const self = this;
    return async function(...args) {
      self.pendingCount++;
      try {
        return await fn.apply(this, args);
      } finally {
        self.pendingCount--;
        if (self.pendingCount === 0) {
          self._notify();
        }
      }
    };
  }

  // The equivalent to your waitForAllTimers()
  waitForIdle() {
    if (this.pendingCount === 0) return Promise.resolve();
    return new Promise(resolve => this.resolvers.push(resolve));
  }
 
  _notify() {
    while (this.resolvers.length) {
      this.resolvers.shift()();
    }
  }
}




const channel = new MessageChannel();

/*
TODO: Build stream protocol over message passing (fetch for streams etc.)

const requestPort = channel.port1;
const responsePort = new MessageChannel().port1;
const responsePortRemote = new MessageChannel().port2;
*/

Object.getOwnPropertyNames(globalThis).forEach(name => {
  // Skip internal properties, the runtime itself, and 'globalThis' to avoid recursion
  if (
    !name.startsWith('_') && 
    name !== 'globalThis' && 
    name !== \`_RUNTIME${config.uuid}_\`
  ) {
    Object.defineProperty(globalThis._RUNTIME${config.uuid}_.globals, name, {
      get: () => globalThis[name],
      enumerable: true,
      configurable: true
    });
  }
});

(async () => {


const GlobalTracker = {
  activeTasks: 0,
  resolvers: [],
  // Increments the counter
  start() {
    this.activeTasks++;
  },

  // Decrements and checks if we are done
  stop() {
    this.activeTasks--;
    if (this.activeTasks === 0) {
      while (this.resolvers.length) this.resolvers.shift()();
    }
  },

  // The waiter function
  waitForAll: function() {
    if (this.activeTasks === 0) return Promise.resolve();
    return new Promise(res => this.resolvers.push(res));
  },

  // The Magic: This patches any function you point it at
  patch: function(obj, methodName) {
    const original = obj[methodName];
    const self = this;

    obj[methodName] = function(...args) {
      self.start();
      try {
        const result = original.apply(this, args);
        
        // Handle Async/Promises
        if (result instanceof Promise || result && typeof result.then === "function") {
          return result.finally(() => self.stop());
        }

        // Handle Sync
        self.stop();
        return result;
      } catch (e) {
        self.stop();
        throw e;
      }
    };
  },
  patchChildProcess(fn) {
    return (...args) => {
      this.start();
      try {
        const child = fn(...args);
        let stopped = false;
        const stopOnce = () => {
          if (stopped) return;
          stopped = true;
          this.stop();
        };
        child.once('close', stopOnce);
        child.once('error', stopOnce);
        return child;
      } catch (err) {
        this.stop();
        throw err;
      }
    }
  },
  patchChildProcess2(fn) {
    return (...args) => {
      this.start(); // Start tracking when exec/spawn is called
      
      try {
        const child = fn(...args);
        
        // Listen for the final event to stop tracking
        // We use 'once' to ensure we only decrement once
        child.once('close', () => this.stop());
        
        // Also handle cases where the process might error out immediately
        child.once('error', (err) => {
          // Only stop if 'close' hasn't fired yet
          if (child.exitCode === null) this.stop();
        });

        return child;
      } catch (err) {
        this.stop(); // Stop if the synchronous part fails (like execSync)
        throw err;
      }
    }
  },
  
}; 
 
globalThis._RUNTIME${config.uuid}_.taskTracker = GlobalTracker;

// _RUNTIME${config.uuid}_.taskTracker.patch(myUtils, 'calculate');


// Registry of in-flight modules to catch circular references.
// Maps resolvedKey -> { status: 'loading' | 'done', exports, promise }
const moduleRegistry = new Map();

/**
 * @param {string} modulePath     - The import path as written (e.g. './foo', '../bar', or a URL)
 * @param {string} moduleType     - 'import' | 'require'
 * @param {string} [entryPoint]   - The original top-level entry file; passed through to interop
 * @param {string} [parentEntryPoint]   - The original file entry file point; passed through to interop
 
 *                                  so _build_file can resolve context-sensitive paths correctly.
 *                                  Defaults to modulePath when called at the root level.
 */
async function loadModule(modulePath, moduleType, entryPoint, parentEntryPoint) {

  const isDynamicModule = p => typeof p === 'string' && /^(data:text\\/javascript|blob:)/.test(p);
  
  if(isDynamicModule(modulePath)){
   return await import(modulePath);
  }
 
  let relativeName = null;
 
  const node_builtin = ${JSON.stringify(builtinModules)}
  
  
  const strippable_nodebuiltins = node_builtin.filter(m => m.includes('node:'))
  
  const isStrippable = strippable_nodebuiltins.includes(modulePath) || node_builtin.includes(modulePath);
  
   const isNodeBuiltIn = node_builtin.includes(modulePath) || isStrippable;  
    
   if(isStrippable){
   modulePath = modulePath.replace("node:", ""); // strip node:
   modulePath = modulePath.replace("/", "_");
   modulePath = modulePath.replace("RUNTIME:", "RUNTIME_")
   }  
    
  // The very first caller doesn't know the entry point yet — it IS the entry point.
  if (entryPoint === undefined) entryPoint = modulePath;

  if (parentEntryPoint === undefined) parentEntryPoint = null;

  try {
    const extension = modulePath.split('.').pop().toLowerCase();
    const isRelative = modulePath.startsWith('./') || modulePath.startsWith('../');
  const isAbsolute = modulePath.startsWith('./')

  let sourceResolvedError = false;
  
   const isJSModule = !['json', 'css'].includes(extension);
    // ─── Relative / interop-channel path ────────────────────────────────────
    if (isRelative || isNodeBuiltIn || isAbsolute || !isRelative && !isNodeBuiltIn && !isAbsolute && !modulePath.includes("https://")) {
      relativeName = modulePath;

      // Use a stable key for the registry (entry + requested path disambiguates
      // the same filename required from different entry points).
      const registryKey = \`\${entryPoint}::\${modulePath}\`;
      // ── Circular reference guard ─────────────────────────────────────────
      if (moduleRegistry.has(registryKey) && isJSModule) {
        const record = moduleRegistry.get(registryKey);

        if (record.status === 'loading') {
          // Circular dep detected — return the partially-populated exports object
          // so the caller gets a live reference that will be filled in once the
          // module finishes executing (same pattern Node.js uses).
          console.warn(
            \`[loadModule] Circular dependency detected for "\${modulePath}" \` +
            \`(entry: "\${entryPoint}"). Returning partial exports.\`
          );
          return record.exports;
        }

        // Already fully resolved — return cached result.
        return record.exports;
      }

      // Create a placeholder record immediately so any re-entrant call above
      // sees 'loading' and gets the partial exports object.
      const partialExports = {};
      const record = { status: 'loading', exports: partialExports, promise: null };
      moduleRegistry.set(registryKey, record);

      try {
        const cwd =
          typeof process !== 'undefined' &&
          process &&
          typeof process.cwd === 'function'
            ? process.cwd()
            : undefined;
        // Pass the entry point to the parent so _build_file can use it for
        // things like resolving sibling imports or source-map hints.
        
        const vfs = globalThis._RUNTIME${config.uuid}_.__USER_FILES__
        let source = await interopChannel.callParent(
          '_dynamic_import',
          modulePath,
          moduleType,
          entryPoint,
          parentEntryPoint,
          isNodeBuiltIn, 
          cwd,
          vfs   
        );
        
          
        if(!source){
        throw new Error(\`[ERR_MODULE_NOT_FOUND]: Cannot find module \${modulePath}\`)
        return;
        }  
          
          if (extension != 'json' && extension != 'css') {
        source = await interopChannel.callParent(
          '_build_file',
          source,
          modulePath,
          moduleType,
          entryPoint,
          parentEntryPoint,
          isNodeBuiltIn
        );
        
       }

        let resolved; 

        if (extension === 'json') {
          // if typescript (need to add types)
          resolved = JSON.parse(source);
          return resolved;
        } else if (extension === 'css') {
          const sheet = new CSSStyleSheet();
          await sheet.replace(source);
          resolved = sheet;
          return resolved;
        } else {
          if (moduleType === 'require') {
            // Provide sync require bound to this module's path
            const vfsForRequire = globalThis._RUNTIME_?.__USER_FILES__ || {};
            globalThis.__syncRequire__ = createSyncRequire(parentEntryPoint || entryPoint || modulePath, vfsForRequire);
            source = wrapCommonJS(source, parentEntryPoint || entryPoint || modulePath, vfsForRequire);
          }
 
         function makeIdentitySourceMap(source, filename) {
  // One mapping per line, all pointing to column 0 of the original
  const lineCount = source.split('\\n').length;
  // Each ';' = next line, 'AAAA' = col 0 -> col 0, same source, same line
  const mappings = Array(lineCount).fill('AAAA').join(';');

  const map = {
    version: 3,
    sources: [filename],
    sourcesContent: [source],
    names: [],
    mappings,
  };

  return \`\\n//# sourceMappingURL=data:application/json;charset=utf-8,\${
    encodeURIComponent(JSON.stringify(map))
  }\`;
}
 
         source  = source + \`\\n //# sourceURL=\${modulePath}\`
             const sourceMapComment = makeIdentitySourceMap(source, modulePath);

           const url = \`data:text/javascript;charset=utf-8,\${encodeURIComponent(source)}\`;
          
          
          
          resolved = await importAndProxy(url, modulePath, relativeName, moduleType);
        }

        // Populate the partial exports object in-place so any circular
        // reference holders also see the final values.
        if (resolved && typeof resolved === 'object') {
          Object.assign(partialExports, resolved);
        }

        record.status = 'done';
        record.exports = resolved; // replace reference for future callers
        return resolved;

      } catch (err) {
        // Remove failed entry so a retry can attempt a fresh load.
        moduleRegistry.delete(registryKey);
        throw err;
      }
    }

    // ─── Asset handling (JSON / TXT / MD) ───────────────────────────────────
    if (['json', 'txt', 'md'].includes(extension)) {
      const response = await fetch(modulePath);
      if (!response.ok) throw new Error(\`HTTP error! status: \${response.status}\`);

      const contentType = response.headers.get('content-type');
      if (extension === 'json' || (contentType && contentType.includes('application/json'))) {
        try { return await response.json(); }
        catch { return await response.text(); }
      }
      return await response.text();
    }

    // ─── CSS (absolute URL) ──────────────────────────────────────────────────
    if (extension === 'css') {
      const response = await fetch(modulePath);
      if (!response.ok) throw new Error(\`HTTP error! status: \${response.status}\`);
      const cssText = await response.text();
      const sheet = new CSSStyleSheet();
      await sheet.replace(cssText);
      return sheet;
    }

    // ─── Standard JS import (absolute URL / bare specifier) ─────────────────
    const requiredSupportedYet = false; // sync require transform not yet implemented

    let data;
     if (moduleType === 'require' && !isRelative && !isAbsolute){
     throw new Error(\`[ERR_MODULE_NOT_FOUND]: Cannot find module \${modulePath}\`)
     }
    
    if (moduleType === 'require' && requiredSupportedYet) {
      let src = await fetch(modulePath).then(r => r.text());
      const vfsForRequire2 = globalThis._RUNTIME_?.__USER_FILES__ || {};
      globalThis.__syncRequire__ = createSyncRequire(parentEntryPoint || entryPoint || modulePath, vfsForRequire2);
      src = wrapCommonJS(src, parentEntryPoint || entryPoint || modulePath, vfsForRequire2);
      const url = \`data:text/javascript;charset=utf-8,\${encodeURIComponent(src)}\`;
      data = await import(url);
    } else {
     /*  
 
     this actually works as is planned to use possibly.. (so we can patch node.js) - crazy slow. 
      
      data = await interopChannel.callParent(
          '_bundler_',
          modulePath
        );
      data = await import(data)  
      */ 
      
      data = await import(modulePath);
    } 

    return buildModuleProxy(data, modulePath, relativeName, moduleType);

  } catch (error) {
     
     // TODO Implement true stacks... 
     // Fix errors for not found files... 
     if (relativeName){
     
  const displayPath = relativeName || modulePath;
  
 
 const err = new Error(\`\${error.message} in \${displayPath}\`);

err.stack = \`Error: Something broke
    at myFunction (index.js:123:45)
    at main (index.js:200:10)\`;
    
  
  
  
  // Check if this error has already been wrapped by checking for our pattern
  const alreadyWrapped = error.message.match(" in \\./");
  
  //error.stack = \`\${error.message}\`
 
  
  if (alreadyWrapped) {
    // Already has path context, just re-throw as-is
    throw error;
  }
  
  // First time catching - add context
   if(entryPoint){
   error.message = \`\${error.message} in \${displayPath} at \${entryPoint}\`
  throw error;
  }

  
  
 
 
   
   }
 
     
    if (relativeName) modulePath = relativeName;
    
    
    
    // todo make stacks for relatives 
    throw error;
  }
}

globalThis._RUNTIME${config.uuid}_.loadModule = loadModule;
 


  
// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Wraps a CommonJS source string in an ESM-compatible IIFE. */
/**
 * Synchronous require() for CJS modules (vitest support).
 * Resolves against VFS, loads source synchronously, executes with
 * cycle tolerance (returns partial exports on circular require).
 */
function createSyncRequire(parentPath, vfs) {
  const cache = new Map(); // resolvedPath -> module.exports (for cycles)
  
  function syncRequire(request) {
    // 1. Built-in modules: return from cache if loaded, else throw
    // (async loadBuiltin must have been called first)
    let builtinKey = request.startsWith('node:') ? request.slice(5) : request;
    if (_builtinManifest[builtinKey] || _builtinManifest[request]) {
      const key = _builtinManifest[builtinKey] ? builtinKey : request;
      if (_builtinCache.has(key)) {
        const mod = _builtinCache.get(key);
        // Return default export or namespace
        return mod.default !== undefined && Object.keys(mod).length === 1 ? mod.default : mod;
      }
      throw new Error('[ERR_REQUIRE_ASYNC]: Built-in "' + request + '" not yet loaded. ' +
        'Call await loadBuiltin("' + request + '") first, or use dynamic import().');
    }
    
    // 2. Resolve path (relative/absolute)
    let resolved;
    if (request.startsWith('./') || request.startsWith('../') || request.startsWith('/')) {
      const fromDir = parentPath ? parentPath.split('/').slice(0, -1).join('/') : '';
      const joined = fromDir ? fromDir + '/' + request : request;
      const parts = joined.split('/');
      const normalized = [];
      for (const p of parts) {
        if (p === '..') normalized.pop();
        else if (p !== '.' && p !== '') normalized.push(p);
      }
      resolved = normalized.join('/');
      // Try .js extension
      if (!resolved.endsWith('.js')) {
        const withJs = resolved + '.js';
        // Check VFS for existence (simplified)
        resolved = withJs; // assume .js for now
      }
    } else {
      // Bare specifier (node_modules): simplified resolution
      // TODO: full node_modules walk with package.json exports
      throw new Error("[ERR_MODULE_NOT_FOUND]: Cannot find module '" + request + "'");
    }
    
    // 3. Check cache (cycle tolerance: return partial exports)
    if (cache.has(resolved)) {
      return cache.get(resolved).exports;
    }
    
    // 4. Load source from VFS (sync)
    // vfs is the unflattened filesystem object
    const source = vfsLookup(resolved, vfs);
    if (source == null) {
      throw new Error("[ERR_MODULE_NOT_FOUND]: Cannot find module '" + request + "' (resolved: " + resolved + ")");
    }
    
    // 5. Create module object, cache BEFORE executing (for cycles)
    const module = { exports: {}, id: resolved, filename: resolved, loaded: false };
    cache.set(resolved, module);
    
    // 6. Wrap and execute
    const wrapper = new Function('require', 'module', 'exports', '__filename', '__dirname',
      source + String.fromCharCode(10) + '//# sourceURL=' + resolved);
    const dirname = resolved.split('/').slice(0, -1).join('/') || '.';
    try {
      wrapper(
        createSyncRequire(resolved, vfs), // recursive require with new parent
        module,
        module.exports,
        resolved,
        dirname
      );
    } catch (err) {
      cache.delete(resolved); // remove failed module from cache
      throw err;
    }
    module.loaded = true;
    return module.exports;
  }
  
  syncRequire.cache = cache;
  syncRequire.resolve = (request) => request; // simplified
  return syncRequire;
}

function wrapCommonJS(source, parentPath, vfs) {
  // The require function is provided at module instantiation time via
  // the runtime's sync require. For ESM-converted CJS, we embed a
  // placeholder that gets replaced with the real require.
  return \`
const exports = {};
const module = { exports };
// Sync require is provided by the runtime via __syncRequire__
const require = typeof __syncRequire__ !== 'undefined' 
  ? __syncRequire__ 
  : (() => { throw new Error('[ERR_REQUIRE_NOT_SUPPORTED]: sync require not available in this context'); });

(function (require, module, exports) {
  \${source}
})(require, module, exports);

export default module.exports;
\`;
}
 
/** Dynamically imports a data-URL and returns a proxied module object. */
async function importAndProxy(url, modulePath, relativeName, moduleType) {
  const data = await import(url);
  return buildModuleProxy(data, modulePath, relativeName, moduleType);
}

/**
 * Builds the module proxy / plain object returned to the caller.
 * - For require(): unwraps \`.default\` (CommonJS compat).
 * - For ESM:       throws on missing named exports, hides \`.default\` when absent.
 */
function buildModuleProxy(data, modulePath, relativeName, moduleType) {
  const moduleObject = Object.assign({}, data);

  Object.defineProperty(moduleObject, Symbol.toStringTag, {
    value: 'Module',
    enumerable: false,
  });

  if (moduleType === 'require') {
    return moduleObject.default ?? moduleObject;
  }

  const hasDefault = Object.prototype.hasOwnProperty.call(data, 'default');
  
  
   // Keep .default enumerable and accessible when the module exported one.
  // If there's no default export, define it as undefined (non-enumerable)
  // so \`import { default as x }\` still resolves without a throw, but
  // Object.keys() / for..in won't surface a spurious \`default\` key.
  /* if (!hasDefault) {
    Object.defineProperty(moduleObject, 'default', {
      value: undefined,
      enumerable: false,
      configurable: true,
    });
  }*/ 
  
  //if (!hasDefault) delete moduleObject.default;

  return new Proxy(moduleObject, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return target[prop];

      if (prop === 'default') return  target?.default || target; // TODO: if sourceType is CJS - force default.
      if (prop === '__esModule') return true;

      if (!(prop in target)) {
        const displayPath = relativeName ?? modulePath;
        throw new SyntaxError(
          \`The requested module '\${displayPath}' does not provide an export named '\${String(prop)}'\`
        );
      }

      return target[prop];
    },
  });
}  
 
 
 
 
 // ─── Interop Channel ──────────────────────────────────────────────────────────

const interopChannel = {
  // Call parent functions from sandbox
  callParent: async (method, ...args) => {
    const callId = Math.random().toString(36).substr(2, 9);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Interop call timeout'));
      }, 10000);
      
      const handler = (event) => {
     
        if (event.data.type === 'interop_response' && event.data.callId === callId) {
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          if (event.data.error) {
          // thinking we need to throw back to sandbox then reject?
            reject(new Error(event.data.error));
          } else {
            resolve(event.data.result);
          }
        }
      };
      
      window.addEventListener('message', handler);
      window.parent.postMessage({
        type: 'interop_call',
        callId,
        method,
        args
      }, '*');
    });
  },
  
  // Register functions that parent can call
  exports: {},
  
  
  expose: (name, fn) => {
    interopChannel.exports[name] = fn;
    const RUNTIME_METHODS = ['__check_exists__', '__stdin__', '__serverRequest__']
    if(!RUNTIME_METHODS.includes(name)){
    window.parent.postMessage({ type: 'interop_registered', name }, '*');
    };
  }
};

//  window.parent.postMessage({ type: 'sandbox_ready' }, '*'); 
 
// Listen for parent calling sandbox functions
window.addEventListener('message', (event) => {
  if (event.data.type === 'interop_invoke') {
    const { callId, method, args } = event.data;
     
    if (globalThis.${config.interopVariable}.exports[method]) {
      try {
        const result = globalThis.${config.interopVariable}.exports[method](...args);
         
        // Handle async functions
        Promise.resolve(result).then(res => {
          window.parent.postMessage({
            type: 'interop_result',
            callId,
            result: res
          }, '*');
        }).catch(err => {
          window.parent.postMessage({
            type: 'interop_result',
            callId,
            error: err.message
          }, '*');
        });
      } catch (err) {
      
      // Using STDIN error was thrown - pipe back into runtime
       if(method === "__stdin__"){
         throw err
       }
      
      if(method != "__stdin__"){
        window.parent.postMessage({
          type: 'interop_result',
          callId,
          error: err.message
        }, '*');
      }
     }
    } else {
      window.parent.postMessage({
        type: 'interop_result',
        callId,
        error: \`Method '\${method}' not found\`
      }, '*');
    }
  }
}); 

interopChannel.expose('__check_exists__', (methodName) => {
  return typeof interopChannel.exports[methodName] === 'function';
});



 

// Make available globally
globalThis[Symbol.for("bvm.interop")] = interopChannel;


// Node.js Globals

const global = globalThis;

const setImmediate = globalThis.setImmediate || ((fn, ...args) => {
  return setTimeout(fn, 0, ...args);
});



 
 
})();
 
 
// Execute user code with comprehensive error handling
(async () => {
   



// globalThis?.__RUNTIME_FS__ = await globalThis._RUNTIME_.loadModule("RUNTIME:NODE_GLOBALS"); if emulating node (for import.meta.resolve && other fs ops.) 
 
// all interop.expose() will be hoisted here when code is running. 
 
window.${config.interopVariable} =  globalThis[Symbol.for("bvm.interop")];  // this sets marker & exposes.



//await _RUNTIME${config.uuid}_.loadModule("fs");
//await _RUNTIME${config.uuid}_.__FS__.promises.writeFile("/data.json", JSON.stringify({ hello: "worlds" }), "utf8", );
 /**
 * Runtime-compliant shim for import.meta.resolve
 * @param {string} specifier - The path to resolve (e.g., './utils.js')
 * @param {string} [parent=import.meta.url] - The base URL (defaults to current module)
 * @returns {string} - The absolute resolved URL string
 */
 function __RUNTIME_RESOLVE__HANDLE(specifier, parent = 'file:') {
  try {
  
  if(globalThis?._RUNTIME${config.uuid}_?.__FS__){
  const fs = globalThis._RUNTIME${config.uuid}_.__FS__;
  const parentDir = "./"
   if(process){
  parent = process.cwd();
  }
  if (!fs.existsSync(parentDir)) {
    throw new TypeError(
      \`Failed to resolve module specifier "\${specifier}" relative to "\${parent}"\`
    );
  } 
  if (fs.statSync(parentDir).isFile()) {
    // If parent is a file, strip the file name
    const lastSlash = parentDir.lastIndexOf('/');
    parentDir = lastSlash >= 0 ? parentDir.slice(0, lastSlash) : '.';
  }

  // Handle relative paths: ./ or ../
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    let parts = (parentDir + '/' + specifier).split('/');
    const resolvedParts = [];
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') resolvedParts.pop();
      else resolvedParts.push(part);
    }
    const resolvedPath = '/' + resolvedParts.join('/');
    if (fs.existsSync(resolvedPath) || fs.existsSync(resolvedPath + '.js')) {
      return resolvedPath;
    }
    throw new TypeError(
      \`Failed to resolve module specifier "\${specifier}" relative to "\${parent}"\`
    );
  }
  
  
  throw new Error("Failed to find.")
  
  }

   return new URL(specifier, parent).href; // for browser emulation
   
  } catch (err) {
 
    // 2. The spec requires throwing a TypeError on resolution failure
   throw new TypeError(\`Failed to resolve module specifier "\${specifier}" relative to "\${parent}"\`);
  }
}

Object.defineProperty(__RUNTIME_RESOLVE__HANDLE, 'toString', {
  value: function() {
    return 'function resolve() { [native code] }';
  },
  writable: false,
  configurable: true
});

 


    
 const observer = new PerformanceObserver((list) => {
  list.getEntries().forEach((r) => {
   
   emitMe("resource_timing", null, {
      url: r.name,
      type: r.initiatorType,
      start: r.startTime,
      duration: r.duration,
      size: r.transferSize,
      encoded: r.encodedBodySize,
      decoded: r.decodedBodySize
    });
   return;
    console.log({
      url: r.name,
      type: r.initiatorType,
      start: r.startTime,
      duration: r.duration,
      size: r.transferSize,
      encoded: r.encodedBodySize,
      decoded: r.decodedBodySize
    });
  });
});

observer.observe({ type: "resource", buffered: true });


// Add to SandboxRuntime.generate() before user code execution:


 
// Full path to the current file (commonJS)
/*
globalThis.__filename = "";

// Directory of the current file
globalThis.__dirname = "";
*/



   // Track pending module imports
const pendingModules = new Map();

 
function waitForAllModules() {
  return new Promise(resolve => {
    const check = () => {
      if (pendingModules.size === 0) {
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}



    


const startTime = performance.now();



// Save the original console methods
const originalConsole = { ...console };


const stripAnsi = ${String(stripAnsi)}

 

// Patch each console method
for (const method in originalConsole) {
  if (typeof originalConsole[method] === 'function') {
    console[method] = function (...args) {
     // const cleanArgs = args.map(arg => typeof arg === 'string' ? stripAnsi(arg) : arg);

     // TODO STRIP ANSI 
     if(process && process.env?.FORCE_COLOR === 0){
     
     }
      emitMe("console", method, ...args);

      if (originalConsole[method]) {
        // originalConsole[method].apply(originalConsole, cleanArgs);
      }
    };
  }
}

 
// Example custom function that gets called before console methods
function serialize(...args) {
  const sanitized = args.map(arg => {
    if (arg === null) return "null";
    if (arg === undefined) return "undefined";
    
    // 1. If the argument is a function
    if (typeof arg === 'function') {
      return arg.toString();
    }
    
    
    // Handle all TypedArrays
if (ArrayBuffer.isView(arg) && !(arg instanceof DataView)) {
  

  
  return JSON.stringify({
    type: "binary",
    data: arg
  }); 
  
   
}

    
    function containsFunction(obj) {
  return Object.values(obj).some(v => typeof v === 'function');
}

     // 2. Check for our custom [object Process] or other native tags
     const tag = Object.prototype.toString.call(arg); 
    // 3. Check for arrays specifically
    if (Array.isArray(arg) || tag === '[object Object]' && typeof arg === 'object' && typeof tag != 'function' && !containsFunction(arg) || tag === '[object Module]' && typeof arg === 'object' && typeof tag != 'function' && !containsFunction(arg)) {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      } 
    }
     
 
    
    
    
     //if (tag !== '[object Objects]' && typeof arg === 'object') {
    
     if (tag && typeof arg === 'object') {
  const properties = Object.getOwnPropertyNames(arg)
    .map(p => {
      const val = arg[p];
      let valueStr;

      if (typeof val === 'function') {
        valueStr = val.toString();
      } else if (typeof val === 'object' && val !== null) {
        try {
          valueStr = JSON.stringify(val);
        } catch {
          valueStr = String(val);
        }
      } else {
        valueStr = JSON.stringify(val); // handles numbers, strings, booleans
      }

      return \`\n  "\${p}": \${valueStr}\`;
    })
    .join(',');

  return \`\${tag} {\${properties}\n}\`;
}

    
    // 4. Normal object handling
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        // Fallback for circular structures
        return String(arg);
      }
    }
    
    // 5. Primitive values (Strings, Numbers, Booleans)
    return String(arg);
  });
  return sanitized;
}
 

function emitMe(fn, method, ...args) {
const sanitized = serialize(...args)



if(fn != "console" && fn != "fs"){
window.parent.postMessage({
    type: fn,
    message: sanitized.join(' ')
  }, '*');

}

 if(fn === "fs"){
  window.parent.postMessage({
    type: 'fs',
    method: method.replace("promises.", ''),
    filename: args[0],
    data: args[1]
  }, '*');
 }

function sanitizeArg(arg) {
  const type = typeof arg;

  if (
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    arg === null ||
    arg === undefined
  ) {
    return arg; // primitives are safe
  }

  if (type === "object"){
  return serialize(arg)
  }

  return arg.toString();
}
globalThis.emitMe = emitMe;

globalThis._RUNTIME${config.uuid}_.emit = emitMe;

function sendConsoleMessage(method, args) {

const sanitizedArray = typeof serialize === 'function' ? serialize(...args) : args;
const message = sanitizedArray.join(' ');

  window.parent.postMessage({
    type: "stdout",
    method,
    message: message,
  }, "*");
}

 if(fn === "console"){
 sendConsoleMessage(method, args);
 }
}



// Console capture with multiple levels
const logs = [];
const errors = [];

class EventEmitter {
  constructor() { this._events = {}; }
  on(type, listener) {
    (this._events[type] || (this._events[type] = [])).push(listener);
    return this;
  }
  emit(type, ...args) {
    if (!this._events[type]) return false;
    this._events[type].forEach(fn => fn.apply(this, args));
    return true;
  }
  once(type, listener) {
    const selfClosing = (...args) => {
      this.off(type, selfClosing);
      listener.apply(this, args);
    };
    return this.on(type, selfClosing);
  }
  off(type, listener) {
    if (!this._events[type]) return this;
    this._events[type] = this._events[type].filter(fn => fn !== listener);
    return this;
  }
}
// Alias for Node compliance
EventEmitter.prototype.addListener = EventEmitter.prototype.on;
EventEmitter.prototype.removeListener = EventEmitter.prototype.off;

 
 const process2 = (function () {
  let _intervalId = null;
    const listeners = Object.create(null);
  let traceWarningHelperShown = false;
  // --- Minimal EventEmitter ---
  async function emit(event, ...args) {
    const handlers = listeners[event];
    if (!handlers) return false;

    // Make a copy to avoid mutation during iteration
    const results = handlers.slice().map(fn => {
      if (fn._once) off(event, fn);
      return fn.apply(processFinal, args);
    });

    // Await any promises returned by async functions
    await Promise.all(results);

    return true;
  }

function binding(name) {
    if (name === "natives") return {
      assert: true, buffer: true, child_process: true, constants: true,
      crypto: true, events: true, fs: true, http: true, https: true,
      module: true, os: true, path: true, process: true, stream: true,
      string_decoder: true, timers: true, tty: true, url: true, util: true, zlib: true
    };
    if (name === "config") return { exposeInternals: false };
    if (name === "constants")
      return {
        os: {
          UV_UDP_REUSEADDR: 4,
          signals: {
            SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5,
            SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10,
            SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
            SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21,
            SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26,
            SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPWR: 30, SIGSYS: 31,
          },
          errno: {},
        },
        fs: {
          O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128,
          O_NOCTTY: 256, O_TRUNC: 512, O_APPEND: 1024, O_NONBLOCK: 2048,
          O_DSYNC: 4096, O_SYNC: 1052672, O_DIRECT: 16384, O_DIRECTORY: 65536,
          O_NOATIME: 262144, O_NOFOLLOW: 131072, O_CLOEXEC: 524288,
          UV_FS_O_FILEMAP: 0,
          S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFCHR: 8192,
          S_IFBLK: 24576, S_IFIFO: 4096, S_IFLNK: 40960, S_IFSOCK: 49152,
          F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
        },
        crypto: {},
        zlib: {},
      };
    if (name === "util") return {};
    if (name === "fs") return {};
    if (name === "buffer") return {};
    if (name === "stream_wrap") return {};
    if (name === "tcp_wrap") return {};
    if (name === "pipe_wrap") return {};
    
    // Throw for unknown bindings so callers fall back gracefully
    throw new Error(\`No such module: \${name}\`);
  }



  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
    return processFinal;
  }
  const addListener = on;

  function prependListener(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].unshift(fn);
    return processFinal;
  }

  function once(event, fn) {
    fn._once = true;
    return on(event, fn);
  }

  function prependOnceListener(event, fn) {
    fn._once = true;
    return prependListener(event, fn);
  }

  function off(event, fn) {
    const arr = listeners[event];
    if (!arr) return processFinal;
    const i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
    return processFinal;
  }
  const removeListener = off;

  function listenerCount(event) {
    return listeners[event] ? listeners[event].length : 0;
  }

  function nextTick(fn, ...args) {
    Promise.resolve().then(() => fn(...args));
  }

  // --- Warning internals ---
  function createWarningObject(message, type, code, ctor, detail) {
    const warning = new Error(message);
    warning.name = type || 'Warning';
    if (code !== undefined) warning.code = code;
    if (detail !== undefined) warning.detail = detail;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(warning, ctor || processFinal.emitWarning);
    }

    return warning;
  }

  function formatWarning(warning) {
    const isDeprecation = warning.name === 'DeprecationWarning';

    const trace =
      processFinal.traceProcessWarnings ||
      (isDeprecation && processFinal.traceDeprecation);

    let msg = \`(node:\${processFinal.pid || 1}) \`;

    if (warning.code) {
      msg += \`[\${warning.code}] \`;
    }

    if (trace && warning.stack) {
      msg += warning.stack;
    } else {
      msg += warning.toString();
    }

    if (typeof warning.detail === 'string') {
      msg += \`\n\${warning.detail}\`;
    }

    if (!trace && !traceWarningHelperShown) {
      const flag = isDeprecation
        ? '--trace-deprecation'
        : '--trace-warnings';

      const msg = \`\\n(Use \\\`node \\\${flag} ...\\\` to show where the warning was created)\`;
      traceWarningHelperShown = true;
    }

    return msg;
  }

  function defaultWarningHandler(warning) {
    if (!(warning instanceof Error)) return;

    const isDeprecation = warning.name === 'DeprecationWarning';
    if (isDeprecation && processFinal.noDeprecation) return;

    console.error(formatWarning(warning));
  }

  function emitWarning(warning, type, code, ctor) {
    if (processFinal.noDeprecation && type === 'DeprecationWarning') {
      return;
    }

    let detail;

    if (type && typeof type === 'object' && !Array.isArray(type)) {
      ctor = type.ctor;
      code = type.code;
      detail = type.detail;
      type = type.type || 'Warning';
    } else if (typeof type === 'function') {
      ctor = type;
      type = 'Warning';
      code = undefined;
    }

    if (typeof code === 'function') {
      ctor = code;
      code = undefined;
    }

    if (typeof warning === 'string') {
      warning = createWarningObject(warning, type, code, ctor, detail);
    } else if (!(warning instanceof Error)) {
      throw new TypeError('warning must be a string or Error');
    }

    if (warning.name === 'DeprecationWarning') {
      if (processFinal.noDeprecation) return;

      if (processFinal.throwDeprecation) {
        return nextTick(() => { throw warning; });
      }
    }

    nextTick(() => {
      if (listenerCount('warning') === 0) {
        defaultWarningHandler(warning);
      }
      emit('warning', warning);
    });
  }

  function emitWarningSync(warning, type, code, ctor) {
    if (typeof warning === 'string') {
      warning = createWarningObject(warning, type, code, ctor);
    }

    if (listenerCount('warning') === 0) {
      defaultWarningHandler(warning);
    }

    emit('warning', warning);
  }


 // Report 
 
 const report = (function () {
  let _directory = '';
  let _filename = '';
  let _compact = false;
  let _excludeNetwork = false;
  let _signal = null;
  let _reportOnFatalError = false;
  let _reportOnSignal = false;
  let _reportOnUncaughtException = false;
  let _excludeEnv = false;

  // Internal store for reports
  const reports = [];

  function writeReport(file, err) {
    if (typeof file === 'object' && file !== null) {
      err = file;
      file = undefined;
    } else if (file !== undefined && typeof file !== 'string') {
      throw new TypeError('file must be a string');
    }

    if (err === undefined) {
      err = new Error('Synthetic error');
    } else if (typeof err !== 'object' || err === null) {
      throw new TypeError('err must be an object');
    }

    const r = {
      source: 'JavaScript API',
      type: 'API',
      file: file || _filename || null,
      error: err,
      timestamp: Date.now(),
      compact: _compact,
      directory: _directory,
      excludeNetwork: _excludeNetwork,
      excludeEnv: _excludeEnv,
    };

    reports.push(r);

    // For demo, log to console
    console.warn('Report written:', r);

    return r;
  }

  function getReport(err) {
    if (err === undefined) {
      err = new Error('Synthetic error');
    } else if (typeof err !== 'object' || err === null) {
      throw new TypeError('err must be an object');
    }

    // Return the latest report matching this error, if any
    const r = reports.find(r => r.error === err);
    return r ? JSON.parse(JSON.stringify(r)) : null;
  }
 
  function addSignalHandler(sig) {
    if (!_reportOnSignal) return;

    if (typeof sig !== 'string') sig = _signal;

    if (sig) {
      process.on(sig, signalHandler);
    }
  }

  function removeSignalHandler() {
    if (_signal) {
      process.removeListener(_signal, signalHandler);
    }
  }

  function signalHandler(sig) {
    writeReport(sig, { type: 'Signal', message: 'Signal received' });
  }

   function hrtime(previous) {
  const now = performance.now() / 1000; // seconds
  const sec = Math.floor(now);
  const nano = Math.floor((now - sec) * 1e9);

  if (!previous) return [sec, nano];

  let diffSec = sec - previous[0];
  let diffNano = nano - previous[1];

  if (diffNano < 0) {
    diffSec -= 1;
    diffNano += 1e9;
  }

hrtime.bigint = () => {
  return BigInt(Math.floor(performance.now() * 1e6));
};

  return [diffSec, diffNano];
};




  return {
   
    writeReport,
    getReport,

    get directory() { return _directory; },
    set directory(dir) { _directory = String(dir); },

    get filename() { return _filename; },
    set filename(name) { _filename = String(name); },

    get compact() { return _compact; },
    set compact(b) { _compact = Boolean(b); },

    get excludeNetwork() { return _excludeNetwork; },
    set excludeNetwork(b) { _excludeNetwork = Boolean(b); },

    get signal() { return _signal; },
    set signal(sig) { 
      removeSignalHandler();
      _signal = String(sig); 
      addSignalHandler(sig);
    },

    get reportOnFatalError() { return _reportOnFatalError; },
    set reportOnFatalError(trigger) { _reportOnFatalError = Boolean(trigger); },

    get reportOnSignal() { return _reportOnSignal; },
    set reportOnSignal(trigger) { 
      _reportOnSignal = Boolean(trigger);
      removeSignalHandler();
      addSignalHandler();
    },

    get reportOnUncaughtException() { return _reportOnUncaughtException; },
    set reportOnUncaughtException(trigger) { _reportOnUncaughtException = Boolean(trigger); },

    get excludeEnv() { return _excludeEnv; },
    set excludeEnv(b) { _excludeEnv = Boolean(b); },
  };
})

  let cwd = "/"
  // 1. Real logic
  const rawMethods = {
 
    async exit(code = 0) {
      emit('beforeExit', code);  // async breaks kill
      emit('exit', code);
       if (_intervalId) {
        clearInterval(_intervalId);
        _intervalId = null;
      }
    const endTime = performance.now();
    const executionTime = (endTime - startTime).toFixed(2); 
     
      window.parent.postMessage({ type: 'kill', logs: logs || [], executionTime: parseFloat(executionTime) }, '*');
    },
    
    abort() {
    throw new Error('Process aborted');
    },
      // --- Timing ---
  uptime() {
    return (Date.now() - startTime) / 1000;
  },

  // --- Working directory ---
  cwd() {
    return cwd;
  }, 

  chdir(_cwd){
     if(!globalThis._RUNTIME${config.uuid}_.__FS__.existsSync(_cwd)){
        throw new Error(\`ENOENT: no such file or directory, chdir '\${_cwd}'\`)
     }
     cwd = _cwd
     // fs.chdir(cwd)
  },


  hrtime:function hrtime(previous) {
      const now = performance.now() / 1000;
      const sec = Math.floor(now);
      const nano = Math.floor((now - sec) * 1e9);

      if (!previous) return [sec, nano];

      let diffSec = sec - previous[0];
      let diffNano = nano - previous[1];

      if (diffNano < 0) {
        diffSec -= 1;
        diffNano += 1e9;
      }

  

      return [diffSec, diffNano];
    },
  
  // --- Memory ---
    memoryUsage() {
    return {
      rss: 0,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0
    };
   },

  // --- CPU ---
  cpuUsage() {
    return {
      user: 0,
      system: 0
    };
  },



  kill(pid, signal = 'SIGTERM') {
  if (typeof pid !== 'number') {
    throw new TypeError('The "pid" argument must be of type number');
  }

  if (typeof signal !== 'string') {
    throw new TypeError('The "signal" argument must be of type string');
  }
  
  
        const endTime = performance.now();
    const executionTime = (endTime - startTime).toFixed(2); 
     
      window.parent.postMessage({ type: 'process_kill', logs: logs || [], executionTime: parseFloat(executionTime) }, '*');
     //this.emit('kill', { pid, signal });
   },
   
   
       emitWarning,
    emitWarningSync,
    on,
    off,
    emit,
    listenerCount, 
    binding,
    nextTick,
    title:globalThis._RUNTIME${config.uuid}_.process.title,
    arch:globalThis._RUNTIME${config.uuid}_.process.arch,
    env:globalThis._RUNTIME${config.uuid}_.process.env,
    platform:globalThis._RUNTIME${config.uuid}_.process.platform,
    pid: globalThis._RUNTIME${config.uuid}_.process.pid,
    ppid: globalThis._RUNTIME${config.uuid}_.process.ppid,
    argv0: globalThis._RUNTIME${config.uuid}_.process.argv,
    execPath: globalThis._RUNTIME${config.uuid}_.process.execPath,
    execArgv: globalThis._RUNTIME${config.uuid}_.process.execArgv,
    version: globalThis._RUNTIME${config.uuid}_.process.version,
    versions: globalThis._RUNTIME${config.uuid}_.process.versions,
    argv: globalThis._RUNTIME${config.uuid}_.process.argv,
    once,
    prependListener,
    prependOnceListener,
    report: report(),
    cwd: function(){
     return cwd
    }
  };
   
   
  
  
       

  // 2. Cloak all methods
  const processBase = {};

  Object.getOwnPropertyNames(rawMethods).forEach(key => {
  
  const value = rawMethods[key];

    // If it's NOT a function, just copy it as-is
    if (typeof value !== "function") {
      processBase[key] = value;
      return;
    }
    const fn = function () {
      return rawMethods[key].apply(this, arguments);
    };

    Object.defineProperties(fn, {
      name: { value: key },
      toString: {
        value: function () {
          return \`function \${key}() { [native code] }\`;
        }
      }
    });

    processBase[key] = fn;
  });

  // 3. Create object with fake type
  const processFinal = Object.create({}, {
    [Symbol.toStringTag]: { value: 'Process', enumerable: false }
  });

  Object.assign(processFinal, processBase);
 // Object.freeze(processFinal);


   // Deprecation flags
  processFinal.noDeprecation = false;
  processFinal.throwDeprecation = false;
  processFinal.traceDeprecation = false;
  processFinal.traceProcessWarnings = false;
try{
  // 4. Optionally expose globally
  
Object.defineProperty(window, 'process', {
    value: processFinal,
    writable: false,
    configurable: false,
   enumerable: true
  });
   
   globalThis.process = processFinal;
  }catch(err){
  
  }
  return processFinal;
})(); 
  

  


 

const cloakedConsole = (function () {
  const logLevels = Object.getOwnPropertyNames(console).filter(k => typeof console[k] === 'function');

 

  // 1. Logic Storage (The "Raw" Methods)
  const rawMethods = {};
  logLevels.forEach(level => {
    const original = console[level];
    rawMethods[level] = function (...args) {
      const sanitizedArray = typeof serialize === 'function' ? serialize(...args) : args;
      const message = sanitizedArray.join(' ');
 
      if (level === 'error') errors.push(message);
      
      if (level != 'clear'){
      logs.push({type:level, args:message});
      }
      return original.apply(console, args);
    };
  });

  // 2. Cloak all methods (Mirroring your processBase logic)
  const consoleBase = {};
  Object.getOwnPropertyNames(rawMethods).forEach(key => {
    const fn = function () {
      return rawMethods[key].apply(this, arguments);
    };

    Object.defineProperties(fn, {
      name: { value: key },
      toString: {
        value: function () {
          return \`function \${key}() { [native code] }\`;
        }
      }
    });

    consoleBase[key] = fn;
  });

  // 3. Create the final object with the fake "Console" type
  const consoleFinal = Object.create({}, {
    [Symbol.toStringTag]: { value: 'Object', enumerable: false }
  });

  Object.assign(consoleFinal, consoleBase);
  
  // Note: We don't freeze it here because some 3rd party libs 
  // might try to add properties to console, which would crash the script.

  // 4. Swap the global console
  // We use defineProperty to overwrite the existing window.console
  Object.defineProperty(window, 'console', {
    value: consoleFinal,
    writable: true,
    configurable: true,
    enumerable: true
  });

  return consoleFinal;
})();

await globalThis._RUNTIME${config.uuid}_.loadModule("RUNTIME:NODE_GLOBALS"); 
      
   
// Enhanced timer tracking with WeakMap for cleanup
const timerRegistry = new Map();
let timerIdCounter = 0;
const originalSetInterval = setInterval;
const originalClearInterval = clearInterval;
const originalSetTimeout = setTimeout;
const originalClearTimeout = clearTimeout;

function revertTrueOriginals(){
globalThis.setTimeout = originalSetTimeout;
globalThis.clearTimeout = originalClearTimeout;
globalThis.setInterval = originalSetInterval;
globalThis.clearInterval = originalClearInterval;
globalThis.console = originalConsole;
}

globalThis.setTimeout = (fn, delay, ...args) => {
  const timerId = originalSetTimeout(() => {
    timerRegistry.delete(timerId);
    try {
      fn(...args);
    } catch (err) {
      console.log(err.stack)
      console.error('Timer error:', err.message);
    }
  }, Math.max(0, delay || 0));
  
  timerRegistry.set(timerId, { type: 'timeout', created: Date.now() });
  return timerId;
};

globalThis.clearTimeout = (id) => {
  timerRegistry.delete(id);
  originalClearTimeout(id);
};
  
function waitForAllTimers() {
  return new Promise(resolve => {
    const check = () => {
      const pending = Array.from(timerRegistry.values())
        .filter(t => t.type === 'timeout');
      
      if (pending.length === 0) {
        resolve();
      } else {
        originalSetTimeout(check, 50);
      }
    };
    check();
  });
}



setInterval = (fn, delay, ...args) => {
  const id = originalSetInterval(() => {
    try {
      fn(...args);
    } catch (err) {
      console.error('Interval error:', err.message);
      clearInterval(id);
    }
  }, Math.max(0, delay || 0));
  
  timerRegistry.set(id, { type: 'interval', created: Date.now() });
  return id;
};

clearInterval = (id) => {
  timerRegistry.delete(id);
  originalClearInterval(id);
};

function clearAllIntervals() {
  timerRegistry.forEach((info, id) => {
    if (info.type === 'interval') {
      clearInterval(id);
    }
  });
}


const _realCreateElement = document.createElement;

document.createElement = function(tagName, options) {
  const tag = tagName.toLowerCase();
  if (tag === 'iframe' || tag === 'frame' || tag === 'object' || tag === 'embed') {
     // throw new SecurityError("Creation of frames/objects is disabled in this sandbox.");
  }
  return _realCreateElement.apply(document, [tagName, options]);
};

// Mask it
// Object.defineProperty(document.createElement, 'name', { value: 'createElement' });
// document.createElement.toString = () => "function createElement() { [native code] }";

const _originalInnerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML').set;

Object.defineProperty(Element.prototype, 'innerHTML', {
  set: function(value) {
    if (typeof value === 'string' && /<iframe|<frame|<object|<embed/i.test(value)) {
     // throw new SecurityError("Illegal HTML injection detected.");
    }
    _originalInnerHTML.call(this, value);
  },
  configurable: false
});


const OrigEventSource = window.EventSource;

globalThis.EventSource = function (url, options) {
  if (url.includes('blocked.com')) throw new Error(\`Blocked EventSource to \${url}\`);
  return new OrigEventSource(url, options);
};



const OrigWS = window.WebSocket;

globalThis.WebSocket = function (url, protocols) {
  if (url.includes('blocked.com')) throw new Error(\`Blocked WebSocket to \${url}\`);
  return new OrigWS(url, protocols);
};


const origBeacon = navigator.sendBeacon.bind(navigator);

globalThis.navigator.sendBeacon = (url, data) => {
  if (url.includes('blocked.com')) return false;
  return origBeacon(url, data);
};


// Enhanced fetch tracking with timeout and abort support




function wrapNetwork(fnName, origFn, blocker) {
  return function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (blocker(url)) throw new Error(\`Blocked \${fnName} to \${url}\`);
    return origFn(...args);
  };
}

const _realFetch = window.fetch;
const pendingFetches = new Map();

  // Create the patched fetch
  
const patchedFetch = async function (input, init = {}) {
  const requestInfo = typeof input === 'string' ? input : input?.url;
  const requestId = Math.random().toString(36).substr(2, 9);

 

  const blockedUrls = [
    'https://example.com/bad',
  ];

  const url = typeof input === 'string' ? input : input.url;

  if (
    blockedUrls.some(pattern =>
      typeof pattern === 'string'
        ? pattern === url
        : pattern.test(url)
    )
  ) {
    return Promise.reject(new Error(\`Blocked fetch to \${url}\`));
  }

  emitMe("network_request", null, {
    url: input,
    id: requestId,
    type: "fetch",
    status: "started",
    body: init
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  const fetchInit = { ...init, signal: controller.signal };

  let hasError = null;
  let response;

  try {
const { signal, ...serializableInit } = fetchInit;

if (serializableInit.headers) {
  const h = serializableInit.headers;

  serializableInit.headers =
    h instanceof Headers
      ? Object.fromEntries(h.entries())
      : Array.isArray(h)
        ? Object.fromEntries(h)
        : { ...h };
}


    let fetchPromise;

    // pendingFetches.set(requestId, { url: requestInfo, promise: fetchPromise });

    try {
      // 🔥 FIRST: Try parent
      if(serializableInit.body){
       // serializableInit.body = JSON.parse(serializableInit.body)
       }
      const parentFetch = globalThis.${config.interopVariable}?.callParent?.(
        '_fetch_',
        input,
        serializableInit
      );

      if (parentFetch == null) {
        throw new Error('Parent declined fetch');
      }

       fetchPromise = parentFetch 

      self.operations?.fetches?.add(fetchPromise);
      fetchPromise.finally(() =>
        self.operations?.fetches?.delete(fetchPromise)
      );

      response = await fetchPromise;
      if(!response){
      throw new Error("Parent Fetch Returned Null")
      }
      
      const res = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers, 
            url: "test"
          })
      
      Object.defineProperty(res, 'url', { value: response.url });
      return res

    } catch (parentError) {
 
      // 🔥 Parent failed — fallback to real fetch
      ${config.logNetworkRequests ? "console.log('[FETCH] Parent failed, falling back:', requestInfo);" : ''}

      fetchPromise = _realFetch.apply(window, [input, fetchInit]);

      self.operations?.fetches?.add(fetchPromise);
      fetchPromise.finally(() =>
        self.operations?.fetches?.delete(fetchPromise)
      );

      response = await fetchPromise;
    }

    // ${config.logNetworkRequests ? "console.log('[FETCH] Completed:', requestInfo, '- Status:', response.status);" : ''}

    return response;

  } catch (error) {
    hasError = error;

    if (error.name === 'AbortError') {
      ${config.logNetworkRequests ? "console.log('[FETCH] Timeout:', requestInfo);" : ''}
    } else {
      ${config.logNetworkRequests ? "console.log('[FETCH] Failed:', requestInfo, '- Error:', error.message);" : ''}
    }

    throw error;

  } finally {
    clearTimeout(timeoutId);

    if (!hasError) {
      emitMe("network_request", null, {
        url: input,
        id: requestId,
        type: "fetch",
        status: "finished"
      });
    } else {
      emitMe("network_request", null, {
        url: input,
        id: requestId,
        type: "fetch",
        status: "failed",
        error: hasError?.message || hasError
      });
    }

    pendingFetches.delete(requestId);
  }
};
  
  const patchedFetch2 = async function(input, init = {}) {
    const requestInfo = typeof input === 'string' ? input : input.url;
    const requestId = Math.random().toString(36).substr(2, 9);
    
    
    const blockedUrls = [
  'https://example.com/bad',
  //https:\//\//malware\.site\///
];
       const url = input;

  // Check blocked URLs
  if (blockedUrls.some(pattern => 
    typeof pattern === 'string' ? pattern === url : pattern.test(url)
  )) {
    return Promise.reject(new Error(\`Blocked fetch to \${url}\`));
  }
    
    

    emitMe("network_request", null, {
      url:input,
      id:requestId,
      type:"fetch",
      status: "started",
      body:init
    });
    ${config.logNetworkRequests ? "console.log('[FETCH] Request started:', requestInfo);" : ''}
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    
    const fetchInit = { ...init, signal: controller.signal };
    
    // We use .apply(window) to ensure 'this' context is correct
    const fetchPromise = _realFetch.apply(window, [input, fetchInit]);
    
    pendingFetches.set(requestId, { url: requestInfo, promise: fetchPromise });
    let hasError = false;
    try {
      const response = await fetchPromise;
      ${config.logNetworkRequests ? "console.log('[FETCH] Completed:', requestInfo, '- Status:', response.status);" : ''}
      return response;
    } catch (error) {
      if (error.name === 'AbortError') {
        ${config.logNetworkRequests ? "console.log('[FETCH] Timeout:', requestInfo);" : ''}
      } else {
        ${config.logNetworkRequests ? "console.log('[FETCH] Failed:', requestInfo, '- Error:', error.message);" : ''}
      }
      hasError = error;
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if(!hasError){
      emitMe("network_request", null, {
      url:input,
      id:requestId,
      type:"fetch",
      status: "finished",
       
      });
     }
    if(hasError){
      emitMe("network_request", null, {
      url:input,
      id:requestId,
      type:"fetch",
      status: "failed",
      error: hasError?.message || hasError
      });
     }  

      pendingFetches.delete(requestId);
    }
  };
 
  // MASKING: Make the patched function look exactly like the native one
  Object.defineProperty(patchedFetch, 'name', { value: 'fetch' });
  patchedFetch.toString = () => "function fetch() { [native code] }";

  // LOCKING: Replace global fetch and prevent modification
  Object.defineProperty(window, 'fetch', {
    value: patchedFetch,
    writable: true,
    configurable: true,
    enumerable: true
  });
  


function waitForAllFetches() {
  const promises = Array.from(pendingFetches.values()).map(f => f.promise);
  return Promise.allSettled(promises);
}

// Enhanced XHR tracking
const originalXHR = window.XMLHttpRequest;
const pendingXhrs = new Map();

function PatchedXHR() {
  const xhr = new originalXHR();
  const xhrId = Math.random().toString(36).substr(2, 9);
  
  const originalOpen = xhr.open;
  const originalSend = xhr.send;

  let url = '';
  let method = '';

  xhr.open = function(m, u, ...args) {
    method = m;
    url = u;
    return originalOpen.apply(this, [m, u, ...args]);
  };

  xhr.send = function(body) {
    ${config.logNetworkRequests ? "console.log('[XHR] Request started:', method, url);" : ''}
    
    emitMe("network_request", null, {
      method,
      url,
      type:"xhr",
      status: xhr.status
    });
    

    const cleanup = () => {
      pendingXhrs.delete(xhrId);
      ${config.logNetworkRequests ? "console.log('[XHR] Completed:', method, url, '- Status:', xhr.status);" : ''}
    };

    xhr.addEventListener('loadend', cleanup);
    xhr.addEventListener('error', () => {
      pendingXhrs.delete(xhrId);
      ${config.logNetworkRequests ? "console.log('[XHR] Failed:', method, url);" : ''}
    });
    xhr.addEventListener('abort', () => {
      pendingXhrs.delete(xhrId);
      ${config.logNetworkRequests ? "console.log('[XHR] Aborted:', method, url);" : ''}
    });

    pendingXhrs.set(xhrId, xhr);
    return originalSend.apply(this, [body]);
  };

  return xhr;
  
}

function maskFunction(patchedFn, originalFn) {
  Object.defineProperty(patchedFn, 'name', { value: originalFn.name });
  patchedFn.toString = () => originalFn.toString();
}
maskFunction(PatchedXHR, originalXHR)
maskFunction(setTimeout, originalSetTimeout)
maskFunction(clearTimeout, originalClearTimeout)
maskFunction(setInterval, originalSetInterval)
maskFunction(clearInterval, originalClearInterval)
 
 Object.defineProperty(document.createElement, 'name', { value: 'createElement' });
document.createElement.toString = () => "function createElement() { [native code] }";

window.XMLHttpRequest = PatchedXHR;

function waitForAllXhrs() {
  return new Promise(resolve => {
    const check = () => {
      if (pendingXhrs.size === 0) {
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

// __parseStackLocation is defined once at module scope (exported for
// unit tests) and inlined here so the iframe runs the identical code.
${__parseStackLocation.toString()}

// Enhanced error handling with stack traces
window.onerror = function(message, source, lineno, colno, error) {
  const errorMsg = error ? (error.stack || error.message || message) : message;
  console.error('Uncaught error:', errorMsg);

  // Parse all frames for parent-side source-map mapping.
  const frames = [];
  if (error?.stack) {
    for (const line of String(error.stack).split('\\n')) {
      const loc = __parseStackLocation(line);
      if (loc) frames.push(loc);
    }
  }

  window.parent.postMessage({
    type: 'window_error',
    message: error ? (error.message || String(message)) : String(message),
    source,
    lineno,
    colno,
    stack: error?.stack || null,
    frames,
    errorName: error?.name || 'Error'
  }, '*');

  return true;
};

window.onunhandledrejection = function (event) {
  let reason = event.reason;

  // Normalize non-Error rejections
  if (!(reason instanceof Error)) {
    reason = new Error(typeof reason === 'string'
      ? reason
      : JSON.stringify(reason));
  }

  const stack = reason.stack || '';
  const message = reason.message || String(reason);

  // Extract the first stack frame (where it happened) with a parser that
  // understands URLs — no naive split(':').
  let loc = null;
  const frames = [];
  const stackLines = stack.split('\\n');
  for (let i = 1; i < stackLines.length; i++) {
    const parsed = __parseStackLocation(stackLines[i]);
    if (parsed) {
      frames.push(parsed);
      if (!loc) loc = parsed;
    }
  }

window.parent.postMessage({
    type: 'unhandled_promise_rejection',
    reason: \`Uncaught (in promise) \${reason.name || 'Error'}: \${message}\`,
    stack: stack || null,
    file: loc?.file || null,
    line: loc?.line ?? null,
    column: loc?.column ?? null,
    location: loc ? \`\${loc.file}:\${loc.line}:\${loc.column}\` : null,
    frames,
    errorName: reason?.name || 'Error'
  }, '*');

  event.preventDefault();
};


 

async function initSandboxState(){
let __initSandboxState = await globalThis.${config.interopVariable}.callParent('_getState');

__initSandboxState = \`data:text/javascript;charset=utf-8,\${encodeURIComponent(__initSandboxState)}\`;

 
await import(__initSandboxState);

}


globalThis.${config.interopVariable}.expose('__stdin__', (args) => {
    const s = process?.stdin;
  const hasListeners = s && (s.listenerCount('data') > 0 || s.listenerCount('keypress') > 0); 
 
  if (s && hasListeners && !s.isPaused()) {
    return s.pushData(args);
  }
  
  
  // process.stdin.pushData(args)
   if(process && process.stdin && process.stdin.listenerCount('data') != 0 && process.stdin.isPaused() == false){
    return process.stdin.pushData(args);
   }
  
  // --- Key Decoder Function ---
  function decodeKeyPress(str) {
    if (!str) return null;

    // ANSI Escape sequences for arrow keys
    if (str === '\\x1b[A' || str === '\\x1bOA') return { name: 'up', sequence: str };
    if (str === '\\x1b[B' || str === '\\x1bOB') return { name: 'down', sequence: str };
    if (str === '\\x1b[C' || str === '\\x1bOC') return { name: 'right', sequence: str };
    if (str === '\\x1b[D' || str === '\\x1bOD') return { name: 'left', sequence: str };

    // Enter / Return keys
    if (str === '\\r' || str === '\\n') return { name: 'return', sequence: str };

    // Backspace
    if (str === '\\x7f' || str === '\\b') return { name: 'backspace', sequence: str };

    // Handle single characters & Ctrl combinations
    if (str.length === 1) {
      const code = str.charCodeAt(0);
      // Check for Ctrl+A through Ctrl+Z (ASCII codes 1 to 26)
      if (code >= 1 && code <= 26) {
        return {
          name: String.fromCharCode(code + 96),
          ctrl: true,
          sequence: str
        };
      }
      return { name: str, sequence: str };
    }

    // Fallback for complex/unrecognized sequences
    return { name: 'unknown', sequence: str };
  }
  
  function stripKeySequencesPreserveWhitespace(str) {
  if (!str) return "";

  return str
    // Remove ANSI escape sequences (arrow keys, function keys, CSI sequences)
    .replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\\x1b[\\(\\)][0-9A-Za-z]/g, '')
    // Remove control characters except \\n (\\x0A) and \\t (\\x09)
    .replace(/[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]/g, '');
}
  // TODO: handle if buffered pass or possible remove if emulating node?
    try {   
              const cleanedCode = stripKeySequencesPreserveWhitespace(args);
              
               const keyEvent = decodeKeyPress(args);
              if (keyEvent) {
                // emitMe("key_event", null, keyEvent)
                return;  
              }
              
               if(!cleanedCode){
                return; 
               }
                const E = window.eval(cleanedCode);
                console.log(E)
            } catch (E) {
                return void console.error(E.message)
            }
});

 

globalThis.${config.interopVariable}.expose('__serverRequest__', async (port=8080, URL = "/", type = "GET", body= {}, headers = {}) => {
    const __RT = globalThis._RUNTIME${config.uuid}_;
    const __h = { ...(headers || {}) };
    let __jarCtx = null;
    // Inject cookies from the virtual jar (RFC 6265). The jar must never
    // break a request, so every jar interaction is guarded.
    if (__RT.__cookieJar) {
      try {
        const __host = __h.host || __h.Host || "localhost";
        __jarCtx = { host: __host, path: URL, method: type };
        const __jarCookie = __RT.__cookieJar.cookieHeader("${config.uuid}", port, __jarCtx);
        const __merged = __RT.__mergeCookieHeaders(__h.cookie ?? __h.Cookie, __jarCookie);
        delete __h.Cookie;
        if (__merged) __h.cookie = __merged; else delete __h.cookie;
      } catch (__jarErr) { /* jar must not break requests */ }
    }
    const __res = await __RT.__httpServerRunTime.handleRequest(port, URL, type, body, __h);
    // Store any Set-Cookie response headers back into the jar.
    if (__RT.__cookieJar && __res && __res.headers) {
      try {
        __RT.__cookieJar.store("${config.uuid}", port, __res.headers["set-cookie"],
          __jarCtx || { host: (__h.host || __h.Host || "localhost"), path: URL });
      } catch (__jarErr) { /* jar must not break requests */ }
    }
    return __res;
});
 


 


  try {
  await initSandboxState();


  await globalThis._RUNTIME${config.uuid}_.loadModule("fs");

  // Virtual cookie jar (RFC 6265) for emulated HTTP servers. The IIFE bundle
  // is inlined (see COOKIE_JAR_IIFE) so no network fetch is needed. The jar
  // is keyed per sandbox instance + server port.
  try {
    ${COOKIE_JAR_IIFE}
    globalThis._RUNTIME${config.uuid}_.__cookieJar =
      new globalThis.__cookieJarLib.VirtualCookieJar();
    globalThis._RUNTIME${config.uuid}_.__mergeCookieHeaders =
      globalThis.__cookieJarLib.mergeCookieHeaders;
  } catch (__jarInitErr) {
    console.warn("[cookieJar] init failed:", __jarInitErr && __jarInitErr.message);
  }
  
 window.parent.postMessage({ type: 'sandbox_ready' }, '*'); 

  
// Remove these when emulating Node.js true behaviour
// let document = undefined;
// let location = undefined; 
 
    
  ${
  config?.process?.argv.includes('--test') 
    ? '' // if --test is present, include nothing
    : config.imports?.join('\n') || '' // otherwise include imports
}
  
  
 // globalThis.window =  _window;
  // globalThis.document =  _document;




 
  for (const [name, fn] of [
  ['setTimeout',    setTimeout],
  ['clearTimeout',  clearTimeout],
  ['setInterval',   setInterval],
  ['clearInterval', clearInterval],
]) {
  Object.defineProperty(globalThis, name, {
    get: () => fn,
    set: () => {},       // silently swallow user writes
    configurable: false,
    enumerable: true,
  });
}
      
     
 
   
      // const tracker = new AsyncOperationTracker();
    /* TODO: add flags for --test-reporter=spec mytest.js (json, dot, spec - exists) or if in env.NODE_TEST_REPORTER
     node --test file.js 
    node --test (run all test files in VFS)
    */ 
 ${config?.process?.argv.includes('--test') 
    ? `
    
     let _testRunner;
     
      try{ 
      
      if(!globalThis._RUNTIME${config.uuid}_._TEST_RUNNER_){
       await globalThis._RUNTIME${config.uuid}_.loadModule("node:test")
       }
      // globalThis._RUNTIME_TEST_RUNNER_.REPORTER_TYPE = 'tap';
       // console.log(globalThis._RUNTIME_TEST_RUNNER_._activeReporter)
     
       // const reporter = process.argv.find(arg => arg.startsWith('--test-reporter='))?.split('=')[1];
       
       function getTestReporters(argv) {
  const reporters = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--test-reporter') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        reporters.push(...next.split(','));
        i++;
      }
    } else if (arg.startsWith('--test-reporter=')) {
      const value = arg.split('=').slice(1).join('=');
      reporters.push(...value.split(','));
    }
  }

  if(reporters.filter(Boolean).length === 0){
    return ['spec'];
  }

  return reporters.filter(Boolean);
}

 

   
 
       const _REPORTERS = getTestReporters(process.argv)
       for (const REPORTER in _REPORTERS){

       if(_REPORTERS[REPORTER] === "lcov"){
         // TODO: inject a coverage event into events somehow.
         throw new Error("lcov is not implemented")
       };
       const testRunner = await globalThis._RUNTIME${config.uuid}_._TEST_RUNNER_.execute(\`
       
       
       ${config.imports?.join('\n') || ''}
       //__$PROVIDED_RUNTIME_CODE__/
       
       ${code.replace(/`/g, '\\\`').replace(/\$\{/g, '\\\\\${')}
       
       
       
       \`, {reporter:_REPORTERS[REPORTER]});
       
       console.log(testRunner.output)
       
       }
       
       
       
       
         
      // console.log(globalThis._RUNTIME_TEST_RUNNER_.tap(testRunner));
       }catch(err){
         err.stack = err.message;
         throw err
       }
       `
    : `
await (async () => {
//__$PROVIDED_RUNTIME_CODE__/
${code}\n})();
`}
  
     
   
    // await tracker.waitForCompletion();
   
       
    // Multiple drain cycles to catch cascading async operations
     for (let i = 0; i < 1; i++) {
       await Promise.resolve(); // Drain microtasks
       await new Promise(r => setTimeout(r, 100)); // Let macrotasks run
    } 
    
    
     
   
     
 
    await Promise.race([
  
      Promise.all([
       _RUNTIME${config.uuid}_.taskTracker.waitForAll(),
        waitForAllFetches(),
        waitForAllXhrs(),
        waitForAllTimers(),
        typeof process?.stdin?.waitUntilNoListeners === "function"
          ? process.stdin.waitUntilNoListeners() ?? Promise.resolve()
          : Promise.resolve(),
           typeof _RUNTIME${config.uuid}_.__httpServerRunTime !== "undefined"
  ? _RUNTIME${config.uuid}_.__httpServerRunTime.waitForAllServers?.() ?? Promise.resolve()
  : Promise.resolve()
      ]),
       
   
    ])
    
    revertTrueOriginals();
    
    //clearAllIntervals();
   

  } catch (err) {
    const sanitized_logs = serialize(logs)
    revertTrueOriginals();
    console.error('Execution error:', err.stack);
    const endTime = performance.now();
    const executionTime = (endTime - startTime).toFixed(2); 
    
   // const stack = reason.stack || '';
 // const message = reason.message || String(reason);

  // Extract the first stack frame (where it happened) with a parser that
  // understands URLs — no naive split(':').
  let location = null;
  let loc = null;
  const frames = [];
  const stackLines = err.stack.split('\\n');

  for (let i = 1; i < stackLines.length; i++) {
    const parsed = __parseStackLocation(stackLines[i]);
    if (parsed) {
      frames.push(parsed);
      if (!loc) {
        loc = parsed;
        location = \`\${loc.file}:\${loc.line}:\${loc.column}\`;
      }
    }
  }

    window.parent.postMessage({
      type: 'function_error',
      error: err.message || String(err),
      stack: err.stack,
      location,
      line: loc?.line ?? null,
      column: loc?.column ?? null,
      frames,
      errorName: err?.name || 'Error',
      logs: logs,
      executionTime: parseFloat(executionTime)
    }, '*');
    return;
  } 
  
  
  
  console = originalConsole;
  const endTime = performance.now();
  const executionTime = (endTime - startTime).toFixed(2);
  
  const sanitized_logs = serialize(logs)

  // need a better way to do this - since dev use export {promises}

 const fs = globalThis._RUNTIME${config.uuid}_.__FS__; // This is the fs-like object
const vol = fs?._vol;      // This is the underlying volume

const serializedFs = {};

// 1. Get all file paths in the volume
const files = vol?.toJSON?.() ?? {}; // We use this JUST to get the list of keys/paths

for (const path in files) {
  try {
    // 2. Read each file as a raw Buffer (no encoding = binary)
    // In the browser, memfs Buffers are actually Uint8Arrays
    const data = fs.readFileSync(path);
    
    // 3. Store it. postMessage handles Uint8Array perfectly.
    serializedFs[path] = data instanceof Uint8Array ? data : new Uint8Array(data);
  } catch (e) {
    
  }
}
 
 
 
 
  
  window.parent.postMessage({ 
    type: 'function_results', 
    logs,
    errors,
    fs: serializedFs,
    executionTime: parseFloat(executionTime)
  }, '*');
 })();

//# sourceURL=sandbox://${config.uuid}/${config.fileName}
`;
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
        console.warn('Transformer error:', err);
        return result;
      }
    }, code);
  }

  /**
   * Built-in transformers
   */
  static transformers = {
    // Remove console statements
    removeConsole: (code) => code.replace(/console\.(log|info|warn|error|debug)\([^)]*\);?/g, ''),
    
    // Wrap in async IIFE if not already wrapped
    wrapAsync: (code) => {
      if (!code.trim().startsWith('(async')) {
        return `(async () => {\n${code}\n})();`;
      }
      return code;
    },
    
    // Add strict mode
    addStrictMode: (code) => `'use strict';\n${code}`
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
      NODE_ENV: "development"
    },
    platform: "darwin",
    pid: 1,
    ppid: 0,
    argv: [],
    argv0: "node",
    execPath: "/usr/local/bin/node",
    execArgv: [],
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
      unicode: "15.0"
    }
  };
    
    super();
    this.uuid = "_u_" + uuid().replace(/-/g, "");
    this.invoke = function(){
      throw new Error("Sandbox is not running.")
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
    
    if(options.process){
      options.process= mergeProcess(options.process, PROCESS_OBJECT);
    }
    
    
    
    this.config = {
      timeout: options.timeout || 30000, // Number or infity
      logNetworkRequests: options.logNetworkRequests ?? false,
      captureWindowErrors: options.captureWindowErrors ?? true,
      capturePromiseRejections: options.capturePromiseRejections ?? true,
      cdnBase: options.cdnBase || 'https://esm.sh',
      ecmaVersion: options.ecmaVersion || 2022,
      transformRules: options.transformRules || [],
      codeTransformers: options.codeTransformers || [], // array
      fallbackCDN: options.fallbackCDN ?? true, // boolean
      interopVariable: options.interopVariable || "interop", // string
      process: options?.process || PROCESS_OBJECT, // array
      fileName: options?.fileName || "index.js", // string, 
      fs: options?.fs || {},
      // Virtual node:sea asset store (mirrors `fs` -> __USER_FILES__).
      // { [key]: string | Uint8Array | ArrayBuffer | { encoding: 'utf8'|'base64', data: string } }
      // Normalized by normalizeSeaAssets() and published as __SEA_ASSETS__.
      seaAssets: options?.seaAssets || {}
    };

 
  

if (this.iframeElement) {

    const value = this.iframeElement;

    if (typeof value === 'string') {
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
            'iframeElement must be a query selector string or an <iframe> element'
        );
    }

    this.destroyIframe = false;
}
    
    

    this.importResolver = new ImportResolver({
      cdnBase: this.config.cdnBase,
      transformRules: this.config.transformRules,
      fallbackCDN: this.config.fallbackCDN
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
    if (typeof runtimeCode === 'string') {
      const markerIdx = runtimeCode.indexOf('//__$PROVIDED_RUNTIME_CODE__/');
      if (markerIdx !== -1) boilerplateOffset = runtimeCode.slice(0, markerIdx).split('\n').length;
    }
    return frames.map((frame) => {
      let entry = frame && frame.file ? this._sourceMapRegistry.get(frame.file) : null;
      let entryKey = frame?.file || null;
      if (!entry && typeof frame?.file === 'string' && frame.file.startsWith('data:')) {
        // Imported modules execute from data: URLs whose sourceURL trailer
        // names the module path (e.g. //# sourceURL=./helper.js). The
        // registry is keyed sandbox://<uuid>/<modulePath>: match by suffix.
        try {
          const comma = frame.file.indexOf(',');
          const decoded = decodeURIComponent(frame.file.slice(comma + 1));
          const m = decoded.match(/\/\/# sourceURL=(\S+)\s*$/);
          if (m) {
            const want = m[1];
            for (const k of this._sourceMapRegistry.keys()) {
              if (k === want || k.endsWith('/' + want)) {
                entryKey = k;
                entry = this._sourceMapRegistry.get(k);
                break;
              }
            }
          }
        } catch (e) { /* leave entry null -> internal frame */ }
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
    const lines = [`${errorName || 'Error'}: ${message || 'Unknown error'}`];

    // Find the registry entry for the first non-internal frame to get source.
    let contextRendered = false;
    for (const frame of mappedFrames) {
      if (frame.internal) continue;
      const entry = this._sourceMapRegistry.get(frame.source);
      const src = entry?.originalSource;
      if (src && frame.line) {
        const srcLines = src.split('\n');
        const start = Math.max(0, frame.line - 3);
        const end = Math.min(srcLines.length, frame.line + 2);
        const context = srcLines.slice(start, end).map((l, idx) => {
          const actualLine = start + idx + 1;
          const marker = actualLine === frame.line ? '→' : ' ';
          return `${marker} ${String(actualLine).padStart(4)} | ${l}`;
        }).join('\n');
        lines.push(`at (${frame.file}:${frame.line}:${frame.column})`);
        lines.push('', context);
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

    return lines.join('\n');
  }
  
kill(reason = 'Process killed by user') {
  if (!this._context || !this._context.running) {
    console.warn('[Sandbox] kill() called but sandbox is not running.');
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
      this.emit('initialized', { timestamp: Date.now() });
    } catch (err) {
      this.emit('error', { type: 'initialization', error: err.message });
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
    
 
    if (typeof this.beforeExecute === 'function') {
     await this.beforeExecute(); // dev might want to update something in config - such as process argv.
    } 

    if (!this.initialized) {
      await this.init();
    }

    this.executionCount++;
    const executionId = this.executionCount;
    
    

    return new Promise(async (resolve, reject) => {
      // Create isolated iframe
      
      const iframe = this.iframeElement || document.createElement('iframe');
        
      iframe.sandbox = 'allow-scripts allow-same-origin';
      if(!this.iframeElement){
      iframe.style.cssText = 'position: absolute; width: 0; height: 0; border: 0;';
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

    const contentType = (headers['content-type'] || '').toLowerCase();

    // Text types we explicitly want as strings
    const isText = 
      contentType.startsWith('text/') ||
      contentType.includes('json') ||
      contentType.includes('javascript') ||
      contentType.includes('xml') ||
      contentType.includes('html') ||
      contentType.includes('urlencoded');

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
      url: input
    };
  };
}
     
      
      /// Functions passed as options / AbortController Missing etc.. 
       this.registerInterop('_fetch_', async (url, options) => {
   
    
         
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
       })
       
       this.registerInterop('_bundler_', async (url) => {
         
          function isEsmSh(url) {
            return /^https?:\/\/esm\.sh\//.test(url);
          }

          function toBundleUrl(url) {
            if (!isEsmSh(url) || url.includes("?bundle")) return url;
            return url + (url.includes("?") ? "&bundle" : "?bundle");
          }
          
         return await bundle(url).url
       })
      
      
          this.registerInterop('_build_file', async (source, fileName, moduleType, entryPoint, parentEntryPoint, isNodeBuiltIn) => {
             
            const sourceModuleType = detectModuleSystem(source);
            const originalSource = source;
            
            // Collect maps from each transform for composition.
            // Each map goes from that transform's output back to its input.
            const maps = [];
            
            if(moduleType === "import" && sourceModuleType.isCJS && !sourceModuleType.isESM){
             const result = convertCjsToEsm(source, { filename: fileName });
             source = result.code;
             if (result.map) maps.push(result.map);
            } 
     
            if(moduleType === "require" && !sourceModuleType.isCJS && isNodeBuiltIn){
             const result = convertEsmToCjs(source, { filename: fileName });
             source = result.code;
             if (result.map) maps.push(result.map);
            } 
            
            
            
             if(moduleType === "require" && !sourceModuleType.isCJS && !isNodeBuiltIn){
             source =  `throw new Error ("[ERR_REQUIRE_ESM]: Must use import to load ES Module: ... ${fileName}")`
              // No map for synthetic error throw; position mapping not applicable.
            } 
            
            
            
            
            
            // replace our special variable for runtime.
            if(isNodeBuiltIn){
              const result = replaceGlobalThisVar(source, "_RUNTIME_", {
                replacement: `globalThis._RUNTIME${this.uuid}_`,
                filename: fileName,
              });
              source = result.code;
              if (result.map) maps.push(result.map);
            }
            
           
            
            
            // Todo track parent entry module (in loadModule() & transformModules)
            if(fileName != entryPoint){
             // console.log(`Building ${fileName} for ${entryPoint} - for imported module: ${parentEntryPoint}`)
            }
             
           const importResult = transformImportsToLoadModule(this.uuid, source, fileName, entryPoint);
           source = importResult.code;
           if (importResult.map) maps.push(importResult.map);
         
           // Compose all collected maps into a single map: final output -> original source.
           if (maps.length > 0) {
             try {
               const composed = remapping(maps, () => null);
               const sourceURL = `sandbox://${this.uuid}/${fileName}`;
               this._sourceMapRegistry.set(sourceURL, {
                 map: composed,
                 originalSource,
                 filename: fileName,
               });
             } catch (mapErr) {
               console.warn('[source-map] Failed to compose maps for', fileName, mapErr);
             }
           }
         
            return source;
          })
 
       this.registerInterop('_getState', async () => {
         function seralize(fn){
           return JSON.stringify(fn)
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
    return this;
  };

  EventEmitter.prototype.emit = function (ev, ...args) {
    const list = this._events[ev];
    if (!list || list.length === 0) return false;
    const snapshot = [...list];
    this._events[ev] = list.filter(e => !e.once);
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
      const totalListeners = Object.values(this._events)
        .reduce((n, arr) => n + (arr ? arr.length : 0), 0);
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

    // Correct regex to match actual newline or carriage return characters
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
    const s = Object.assign(new EventEmitter(), {
      isTTY    : true,
      writable : true,
      fd       : stream === 'stderr' ? 2 : 1,
      columns  : 80,
      rows     : 24,
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
         `
       })
       
      
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
  const fromDir = fromFile ? fromFile.split('/').slice(0, -1).join('/') : '';
  const joined  = fromDir ? `${fromDir}/${modulePath}` : modulePath;

  // 2. Normalize away . and .. segments
  const parts    = joined.split('/');
  const resolved = [];
  for (const part of parts) {
    if (part === '..')      resolved.pop();
    else if (part !== '.') resolved.push(part);
  }
  const resolvedPath = resolved.join('/');

  // 3. Walk the VFS tree
  const source = vfsLookup(resolvedPath, vfs);
  return source != null ? { resolvedPath, source } : null;
}

/**
 * Walk a nested VFS object using a normalised path string.
 * Tries the path as-is, then with .js appended.
 */
function vfsLookup(path, vfs) {
  const tryPath = (p) => {
    const segments = p.split('/').filter(Boolean);
    let node = vfs;
    for (const seg of segments) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[seg];
    }
    return typeof node === 'string' ? node : undefined;
  };

  return tryPath(path) ?? tryPath(path.endsWith('.js') ? path : `${path}.js`) ?? undefined;
}
      function toVFSPath(modulePath, fromFile) {
  const fromDir = fromFile ? fromFile.split('/').slice(0, -1).join('/') : '';
  const joined  = fromDir ? `${fromDir}/${modulePath}` : modulePath;

  const parts    = joined.replace(/^\.\//, '').split('/');
  const resolved = [];
  for (const part of parts) {
    if (part === '..')      resolved.pop(); 
    else if (part !== '.') resolved.push(part);
  }
  return resolved.join('/');
}
      
      
      
      
      this.registerInterop('_dynamic_import', async (path, type, entryPoint, parentEntryPoint, isNodeBuiltIn, cwd) => {

        const vfs = {
  "src": {
    "utils": {
      "math.js": "export const add = (a, b) => a + b;",
      "math2.js": "import {add} from '../main2.js'; console.log(add)",
    },
    "main.js": "import { add } from './utils/math.js'; import helper from 'my-lib'; console.log(add(1, 2), helper); export {add}",
    "main2.js": `console.log('hello')`,
    "node_modules": {
      "my-lib": {
        "package.json": '{"main": "dist/index.js"}',
        "dist": {
          "index.js": "export default 'Hello from local node_modules package!';"
        }
      }
    }
  },
  "node_modules": {
    "lodash-es": {
      "index.js": "export function cloneDeep(val) { return JSON.parse(JSON.stringify(val)); }"
    }
  },
  "require.js": `exports.add = (a, b) => a + b;
  exports.msg = 'Hello from CommonJS!';`, 
  "test.js": "console.log('root file');",
  "package.json": '{"name": "sandbox"}'
};
        
  // 1. For Node built-ins, hand off to your shim resolver as before
  if (isNodeBuiltIn) {
    return await fetchBuiltinSource(path);
  }

  // 2. Determine the importer's VFS path
  const importerVFSPath = entryPoint
    ? toVFSPath(entryPoint, parentEntryPoint)   
    : (parentEntryPoint ?? '');

  const isRelative = path.startsWith('./') || path.startsWith('../');

  // 3. Handle Bare Specifiers (node_modules lookup)
  if (!isRelative) {
    const resolvedPackage = resolveNodeModule(path, importerVFSPath, vfs);
    if (resolvedPackage) {
      console.log(`Resolved from node_modules: ${path}`);
      return resolvedPackage.source;
    }
    return null; // Fall through if package is completely missing
  }

  // 4. Handle Relative Paths
  const result = resolveVFS(path, importerVFSPath, vfs);
  if (!result) {
    throw new Error(`[ERR_MODULE_NOT_FOUND]: Cannot find module '${path}' (imported from '${importerVFSPath}')`);
  }
  
  console.log(result, path);
  return result.source; 
});
      
      this.registerInterop('_dynamic_import', async (path, type, entryPoint, parentEntryPoint, isNodeBuiltIn, cwd, vfs={}) => {

         
        
        
        function unflattenFileSystem(flatObj) {
  const result = {};

  for (const [path, value] of Object.entries(flatObj)) {
    const parts = path.split('/');
    let current = result;

    // Traverse (or create) folders until the last segment (the file name)
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part] || typeof current[part] !== 'object') {
        current[part] = {};
      }
      current = current[part];
    }

    // Assign the file content to the final key
    current[parts[parts.length - 1]] = value;
  }

  return result;
}
        
        vfs =  unflattenFileSystem(vfs)
        
  // 1. For Node built-ins, hand off to your shim resolver as before
  if (isNodeBuiltIn) {
    return await fetchBuiltinSource(path);
  }

  // 2. Determine the importer's VFS path
  const importerVFSPath = entryPoint
    ? toVFSPath(entryPoint, parentEntryPoint)   
    : (parentEntryPoint ?? '');

  const isRelative = path.startsWith('./') || path.startsWith('../');

  // 3. Handle Bare Specifiers (node_modules lookup)
  if (!isRelative) {
    const resolvedPackage = resolveNodeModule(path, importerVFSPath, vfs);
    if (resolvedPackage) {
      console.log(`Resolved from node_modules: ${path}`);
      return resolvedPackage.source;
    }
    return null; // Fall through if package is completely missing
  }

  // 4. Handle Relative Paths
  const result = resolveVFS(path, importerVFSPath, vfs);
  if (!result) {
    throw new Error(`[ERR_MODULE_NOT_FOUND]: Cannot find module '${path}' (imported from '${importerVFSPath}')`);
  }
 
  return result.source; 
});
      
      function resolveNodeModule(importPath, importerPath, vfs) {
  // Extract directory path from the importer
  const segments = importerPath ? importerPath.split('/') : [];
  segments.pop(); // Remove the file name to get the parent directory

  // Walk up the directory tree looking for node_modules
  while (true) {
    // Build candidate path: [dir1, dir2, ..., "node_modules", importPath]
    const candidatePath = [...segments, "node_modules", ...importPath.split('/')].join('/');
    
    // Attempt resolution at this level using your existing VFS resolver
    const resolved = tryResolveFileOrPackage(candidatePath, vfs);
    if (resolved) return resolved;

    // Stop if we've reached the root
    if (segments.length === 0) break;
    segments.pop();
  }

  // Final fallback: Check root-level node_modules if not found via traversal
  return tryResolveFileOrPackage(`node_modules/${importPath}`, vfs);
}

// Helper to check file existence, index files, or package.json mains
function tryResolveFileOrPackage(basePath, vfs) {
  // 1. Check exact file or file with .js extension
  const fileCheck = resolveVFS(basePath, "", vfs) || resolveVFS(`${basePath}.js`, "", vfs);
  if (fileCheck) return fileCheck;

  // 2. Check if it's a directory containing an index.js
  const indexCheck = resolveVFS(`${basePath}/index.js`, "", vfs);
  if (indexCheck) return indexCheck;

  // 3. Check package.json inside the package directory if it exists
  const pkgJsonCheck = resolveVFS(`${basePath}/package.json`, "", vfs);
  if (pkgJsonCheck && pkgJsonCheck.source) {
    try {
      const pkg = JSON.parse(pkgJsonCheck.source);
      const mainFile = pkg.main || 'index.js';
      return resolveVFS(`${basePath}/${mainFile}`, "", vfs);
    } catch (e) {
      // Invalid package.json
    }
  }

  return null;
} 
      
   
 
      
       this.registerInterop('_dynamic_import2', async (path, type, entryPoint, parentEntryPoint, isNodeBuiltIn, cwd) => {
         // console.log(parentEntryPoint)
      //  console.log(path, type, entryPoint, parentEntryPoint, isNodeBuiltIn, cwd) // "./test2" "import" "./test" "./mathjs.js" false "./"
         
          
         
          if(path === "./serialize"){
            // serialize helper loaded lazily
            return await loadBuiltin("serialize").catch(() => ({ default: {} }));
          }
         
        
 
         
         if(isNodeBuiltIn){
           // Lazy-load built-in on demand. Only the requested module's
           // dist file is fetched, not the full 6.8MB bundle.
           return await loadBuiltin(path);
         }
         
       
         
         
         
       
         if(isNodeBuiltIn){
           return `throw new Error("Not implemented.")`
         }
         
        
         if(path.includes("./test")){
           return `
           import coolBeanMsg from "./test2"
           export function coolBeans(){
              return coolBeanMsg()
             } 
            console.log(import.meta.url)
             Promise.reject(new Error('Something broke!'));
           `
         }
         
     
          
        });
      
      
      if(!this.iframeElement){
       document.body.appendChild(iframe);
      }
     
   
       let runtimeCode;

      try {
 
        // Resolve imports
        let { imports, cleanedCode, cleanedImports, hasImports } = this.importResolver.resolve(code);
         
         
         
        // Apply code transformers (todo: add assert type support?)
        /*let transformedCode = CodeTransformer.transform(
          cleanedCode,
          this.config.codeTransformers
        );*/
    //  let transformedCode = code;
        // Generate runtime code
      
        const custom = imports.map(i => transformImportsToLoadModule(this.uuid, i).code);

         
        
        
      //  transformedCode =  transformedCode.replaceAll("await import", "await loadModule")
        
        // Transform Relative Imports (this can be removed when merged into one function)
      // transformedCode =  transformRelativeModule(transformedCode)
        
        
             function containsNodeTest(obj) {
        const target = "node:test";
          const lists = ["imports", "dynamicImports", "requires"];

          return lists.some(listName => {
            return Array.isArray(obj[listName]) && obj[listName].includes(target);
          });
      }
 
        
         function isTestFile(src) {
          return  /['"]node:test['"]/.test(src)
        }
        
        
        // Transform the main entry code and capture its source map for error mapping.
        const mainTransform = transformImportsToLoadModule(this.uuid, cleanedCode, this.config.fileName);
        if (mainTransform.map) {
          const sourceURL = `sandbox://${this.uuid}/${this.config.fileName}`;
          this._sourceMapRegistry.set(sourceURL, {
            map: mainTransform.map,
            originalSource: cleanedCode,
            filename: this.config.fileName,
          });
        }
        
        runtimeCode = SandboxRuntime.generate(mainTransform.code, {
          imports:custom,
          logNetworkRequests: this.config.logNetworkRequests,
          interopVariable:this.config.interopVariable,
          process:this.config.process,
          isTest:containsNodeTest(cleanedImports),
          fileName:this.config.fileName,
          uuid:this.uuid,
          fs: flattenFileTree(this.config.fs),
          seaAssets: normalizeSeaAssets(this.config.seaAssets)
        });
     
   
       
        // Setup timeout
        const timeoutId = setTimeout(() => {
          context.forceKill(`Execution timeout after ${this.config.timeout}ms`);
          context.cleanup();
          this.emit('execution:timeout', { id: executionId });
          reject(new Error(`Execution timeout after ${this.config.timeout}ms`));
 
        }, this.config.timeout);

        context.cleanupCallbacks.push(() => clearTimeout(timeoutId));

        // Listen for results
        context.listen(
          (result) => {
            this.emit('execution:complete', { id: executionId, result });
            resolve(result);
          },
          (error) => {
            this.emit('execution:error', { id: executionId, error: error.message });
            reject(error);
          }
        );

        // Inject and execute
        context.inject(runtimeCode, hasImports);

      } catch (err) {
                        const loc = err?.loc;
        const message = err?.message;
                          console.log(err)
        // If code generation itself failed (e.g. a syntax error in the user's
        // code), runtimeCode was never assigned — skip the source-mapping and
        // reject with the original error instead of crashing here.
        if (runtimeCode) {
        const line = runtimeCode.slice(0, runtimeCode.indexOf("//__$PROVIDED_RUNTIME_CODE__/")).split("\n").length;

         
        
        
                if(loc){
               let runtimeError = false;
        
        try{
           
          new SyntaxChecker().check(runtimeCode) // error in the runtime code..
          }catch(err){
             
            if(line < err.loc.line != true){
            runtimeError = true;
            
            }else{
               
            //   err.loc.line = err.loc.line - line; TODO: Assign proper line and user code not runtime code
             
            }
            code = runtimeCode
          }
         
          if(runtimeError){
            err.message = `RUNTIME ERROR: ${err.message}`
          }                 
                  
                  
                err = formatErrors(code, err)
                }
        } // end if (runtimeCode)
        context.cleanup();
        this.emit('execution:error', { id: executionId, error: err.message });
        reject(err);
      }finally{
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
        return `✗ Execution failed\nError: ${result.error}\n${result.stack || ''}`;
      }
    } catch (err) {
      return `✗ Fatal error\n${err.message}\n${err.stack || ''}`;
    }
  }

  /**
   * Get sandbox statistics
   */
  getStats() {
    return {
      executionCount: this.executionCount,
      initialized: this.initialized,
      config: { ...this.config }
    };
  }

  /**
   * Reset sandbox state
   */
  reset() {
    this.importResolver.clearCache();
    this.executionCount = 0;
    this.emit('reset', { timestamp: Date.now() });
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

// ============================================================================
// EXAMPLE USAGE
// ============================================================================

// Initialize sandbox with custom configuration
const sandbox = new CodeSandbox({ 
  timeout: 50000,
  logNetworkRequests: true,
  validateSyntax: true,
  transformRules: [
  // 1️⃣ Alias resolution
  {
    test: function (source, kind) {
      return source === 'mathlibrary' && kind === 'require';
    },
    transform: function () {
      return 'https://esm.sh/mathjs';
    },
  },

  // 2️⃣ Enforce esm.sh CDN
  {
    test: function (source) {
      return !source.startsWith('https://esm.sh/') && !builtinModules.includes(source);
    },
    transform: function (source) {
      return source;
    },
  },

  // 3️⃣ Allow only mathjs
  {
    test: function (source) {
      return !source.startsWith('https://esm.sh/') && !builtinModules.includes(source) 
    },
    transform: function (source) {
      
 
      
      if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../') || source.startsWith("https://")){
        
        return source; // ignore transforming or absolute relative imports
       /*
       Throw a error if you do not want to support relative imports.
       
       throw new Error(`Relative imports are not supported: ${source}`);
       */
     }
      
      
      
      const prefix = 'https://esm.sh/';
      const path = source.slice(prefix.length);
      const packageName = path.split('/')[0].split('@')[0];

 
      if (packageName !== 'mathjs') {
      /* You could throw an error if your package is not supported / allowed.
      throw new Error('Only mathjs is supported');
      */ 
      }
// return source
      
      // need to skip node_modules first... (todo)
     return prefix + source // upgrade to ESM.sh cdn. 
    },
  },
],
   fallbackCDN:false, //# default is True
   process:{
    title: "node",
    arch: "x64",
    env: {
      HOME: "/Users/username",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      USER: "username",
      PWD: "/project/directory",
      NODE_ENV: "development"
    },
    platform: "darwin",
    pid: 12345,
    ppid: 12344,
    argv: [],
    argv0: "node",
    execPath: "/usr/local/bin/node",
    execArgv: [],
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
      unicode: "15.0"
    }
  }, 
  fs: {
  "src": {
    "utils": {
      "math.js": "export const add = (a, b) => a + b;",
      "math2.js": "import {add} from '../main2.js'; console.log(add)",
    },
    "main.js": "import { add } from './utils/math.js'; import helper from 'my-lib'; console.log(add(1, 2), helper); export {add}",
    "main2.js": `console.log('hello')`,
    "node_modules": {
      "my-lib": {
        "package.json": '{"main": "dist/index.js"}',
        "dist": {
          "index.js": "export default 'Hello from local node_modules package!';"
        }
      }
    }
  },
  "node_modules": {
    "lodash-es": {
      "index.js": "export function cloneDeep(val) { return JSON.parse(JSON.stringify(val)); }"
    }
  },
  "require.js": `exports.add = (a, b) => a + b;
  exports.msg = 'Hello from CommonJS!';`, 
  "test.js": "console.log('root file');",
  "package.json": '{"name": "sandbox"}',
    "math.test.js": "import { describe, it, expect } from 'vitest'; import { add } from './math.js'; describe('Math utility tests', () => { it('adds two numbers correctly', () => { expect(add(2, 3)).toBe(5); }); });"
},
  
  // set initial state of process args
   beforeExecute:upgateProgressArgv,
   iframeElement: document.querySelector("#preview"),
  /* iframeElement:function(){
     const iframe = document.createElement('iframe');
iframe.style.contain = 'strict';
     iframe.className = 'w-full h-96 bg-white';
     
     iframe.setAttribute('frameborder', '0');
     iframe.style.display = 'block';
      
Execution time gets very slow when appllying clases.
 
// Apply Tailwind-like classes
//iframe.className = 'w-full h-96 bg-white';

// Optional: remove default border
//iframe.setAttribute('frameborder', '0');

// Optional: make sure it displays as block
//iframe.style.display = 'block';
     
     
     return iframe;
   }*/  
});



async function upgateProgressArgv(){
   sandbox.config.process.argv = split(getArgv())
 
 // sandbox.config.iframeElement = document.querySelector(`#preview`);
}

//
sandbox.registerInterop('alert', async (data) => {
   alert(data)
}); 

sandbox.registerInterop('readFile', async (fileName) => {
    // Artificial delay to mimic real disk I/O
    await new Promise(resolve => setTimeout(resolve, 500));

    // Mock file system logic
    const mockFiles = {
        'config.json': '{ "theme": "dark", "version": 1.0 }',
        'hello.txt': 'Hello from the sandbox file system!',
        'secret.md': 'The password is: 12345'
    };

    if (mockFiles[fileName]) {
        return mockFiles[fileName];
    } else {
        throw new Error(`File not found: ${fileName}`);
    }
});
// Listen to events
 
 
sandbox.on('execution:fs',async  ({method, filename, data}) => {
 
  if(method === "writeFile"){
     // You can write the file live to your host VFS instead of getting changes after execution. 
  }
})

sandbox.on('execution:readline_newline', async  (newLine) => {
 
  
})


sandbox.on('execution:server', async  ({type, port}) => {
 
   if(type === "open"){
    console.log("A server has been opened and listening,  expose function to call it etc..")
     await delay(2000)
    console.log(await sandbox.invoke("__serverRequest__", 3000, "GET", "/api/users/1", {}))
  }
  
  
  if(type === "closed"){
    console.log("Server has been closed.")
  }
  
})

sandbox.on('execution:interop_registered', async  ({name}) => {
  if(name === "getData"){
    try{
      const data = await sandbox.invoke(name);
      alert(data.result)
    }catch(err){
      console.log(err)
    }
  }
  
  console.log(name)
  
})
// Define the delay helper
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
/*
// server.js
import http from 'node:http';

const hostname = '127.0.0.1';
const port = 3000;

// Create the HTTP server
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello from the Node.js ES6 HTTP Server!\n');
});

// Start listening
server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
*/ 
sandbox.on('execution:start',async  ({ id }) => {
    console.log(`[Sandbox] Execution ${id} started`);
  
  ///await delay(4000)
   // console.log(await sandbox.invoke("__serverRequest__", "GET", "/", {}, {}))
 //console.log(await sandbox.invoke("__serverRequest__", "GET", "/", {}, {}))
  // console.log(sandbox.serverRunning())
  //console.log(await sandbox.kill())

   //  console.log(sandbox.serverRunning())
 /* toNodeKeypress(document.querySelector('#stdinInput'), async (sequence, key) => {
//  console.log("Sequence:", JSON.stringify(sequence), "Key object:", key);
  //  console.log(sequence)
   
    await sandbox.invoke('__stdin__', sequence)

});    */ 
 
   
//  console.log(sandbox.config.process.argv = ["dsds", "ds", "sd", "ds"])
 // console.log(await bsandbox.kill())
 // const methodExposed = await sandbox.hasMethod("getData") // check if method exists in iframe or

});

sandbox.on('execution:key_event',async  (key_data) => {
   // console.log(key_data);
  
   
}); 
sandbox.on('execution:stdout', ({type, args}) => {
  const term = globalThis._xterm;
  if (!term) return;

  if(type === "clear"){
    term.clear();
    return;
  }

  if(type === "table"){
  // args = table(...args) // todo: shove in run time
  }
  
  // xterm.js interprets ANSI escape codes natively (colors, cursor
  // movement, clear screen). Write directly; no stripping needed.
  const text = Array.isArray(args) ? args.join(' ') : String(args ?? '');
  // Ensure text ends with newline for proper line handling, unless it's
  // already a control sequence or ends with newline.
  term.write(text + (text.endsWith('\n') ? '' : '\r\n'));
});
 

sandbox.on('execution:complete', ({ id, result }) => {
  console.log(`[Sandbox] Execution ${id} completed in ${result.executionTime}ms`);
  //console.log(result)
});




 
// Example code snippets
        const examples = {
            basic: `// Simple console logging
console.log('Hello, IsolateX!');
console.log('Current time:', new Date().toLocaleTimeString());

const numbers = [1, 2, 3, 4, 5];
const sum = numbers.reduce((a, b) => a + b, 0);
console.log('Sum of numbers:', sum);`,
          
          cli_menu:`import readline from 'readline';

// Enable raw mode so we can capture keypress events (like arrow keys) directly
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

const menuOptions = [
  '🚀 Run Diagnostics',
  '⚙️  View Settings',
  '📥 Download Updates',
  '❌ Exit'
];

let currentIndex = 0;

// Function to render the menu to the console
function drawMenu() {
  // Clear the screen / move cursor up based on how many lines we draw
  // For simplicity across cross-platforms, we can clear and reprint:
  console.clear();
  console.log('=== NATIVE NODE.JS CLI MENU ===');
  console.log('Use UP/DOWN arrows to move, ENTER to select.\\n');
 
  menuOptions.forEach((option, index) => {
    if (index === currentIndex) {
      console.log(\`> \\x1b[36m\${option}\\x1b[0m\`); // Highlight current selection in cyan
    } else {
      console.log(\`  \${option}\`);
    }
  });
}

// Handle keypress events
process.stdin.on('keypress', (str, key) => {
  // Allow exiting with Ctrl+C
   console.log(key)
  if (key && key.ctrl && key.name === 'c') {
    process.exit();
  }

  if (key.name === 'up') {
    currentIndex = (currentIndex - 1 + menuOptions.length) % menuOptions.length;
    drawMenu();
  } else if (key.name === 'down') {
    currentIndex = (currentIndex + 1) % menuOptions.length;
    drawMenu();
  } else if (key.name === 'return') {
    // Enter key pressed
    cleanupAndExecute(currentIndex);
  }
});

// Restore terminal settings and run the selected action
function cleanupAndExecute(index) {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  console.clear();

  const selected = menuOptions[index];
  console.log(\`You selected: \${selected}\n\`);

  if (index === 3) {
    console.log('Goodbye! 👋');
    process.exit(0);
  } else {
    // Perform action here, or loop back to menu by re-initializing input
  }
}

// Initial draw
drawMenu();`,
          
          
          express:`// Import Express using ES6 module syntax
import express from 'express?target=node&bundle=true';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse incoming JSON payloads
app.use(express.json());

// Base GET route
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'Welcome to the Node.js Express ES6 Server Demo!'
    });
});

// A sample GET route with route parameters
app.get('/api/users/:id', (req, res) => {
    const userId = req.params.id;
    res.json({
        success: true,
        data: { id: userId, name: \`User \${userId}\`, role: 'Developer' }
    });
});

// A sample POST route
app.post('/api/data', (req, res) => {
    const receivedData = req.body;
    res.status(201).json({
        success: true,
        received: receivedData
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(\`🚀 Server is happily running at http://localhost:\${PORT}\`);
});
`,
          
          http:`// server.js
import http from 'node:http';

const hostname = '127.0.0.1';
const port = 3000;

// Create the HTTP server
const server = http.createServer((req, res) => {
  // Log when a network request connects/arrives
  console.log(\`[Connected] Incoming \${req.method} request for: \${req.url} from \${req.socket.remoteAddress || 'unknown client'}\`);

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello from the Node.js ES6 HTTP Server!\\n');
});

// Start listening
server.listen(port, hostname, () => {
  console.log(\`Server running at http://\${hostname}:\${port}/\`);
});`,
          
          inquirer:` 
 
import inquirer from 'https://esm.sh/inquirer@12?target=node&dedupe=@inquirer/core?target=node';
  
import {AsyncLocalStorage} from "async_hooks"
import {setImmediate} from "timers"
const origOn = process.stdin.on.bind(process.stdin);
process.stdin.on = (ev, fn) => origOn(ev, AsyncLocalStorage.bind ? AsyncLocalStorage.bind(fn) : fn);
 
  if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
} 


async function runMenu() { 
  console.clear();
  console.log('=== Main Menu ===\\n');

  const answers = await inquirer.prompt([
    {
      type: 'select',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        'View Profile',
        'Check System Status',
        'Manage Settings',
        new inquirer.Separator(), // Adds a visual line separator
        'Exit'
      ]
    }
  ]);

  // Handle the user's choice
  switch (answers.action) {
    case 'View Profile':
      console.log('\\n👤 Loading user profile...');
      break;
    case 'Check System Status':
      console.log('\\n🟢 All systems operational.');
      break;
    case 'Manage Settings':
      console.log('\\n⚙️ Opening settings...');
      break;
    case 'Exit':
      console.log('\\nGoodbye!');
      process.exit(0);
  }
}

runMenu();
`,
          
          child_process:`import { exec } from 'child_process';

// Example: List files in the current directory
exec('ls -la', (error, stdout, stderr) => {
  if (error) {
    console.error(\`Execution error: \${error.message}\`);
    return;
  }
  if (stderr) {
    console.error(\`Standard Error: \${stderr}\`);
    return;
  }
  console.log(\`Output:\n\${stdout}\`);
});
`,
          
          fs: `
          
          import fs from "fs";
          
          await fs.promises.writeFile("/data.json", JSON.stringify({ hello: "world" }), "utf8");

const data = JSON.parse(await fs.promises.readFile("/data.json", "utf8"));
console.log(data);



async function downloadImageToMemfs(url, path) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(\`Failed to fetch image: \${response.status}\`);
  }

  // Get binary data
  const arrayBuffer = await response.arrayBuffer();

  // Convert to Uint8Array (works everywhere)
  const uint8 = new Uint8Array(arrayBuffer);

  // Write directly to memfs
  await fs.promises.writeFile(path, uint8);

  console.log(\`Saved image to \${path}\`);
}

async function main() {
  const imageUrl = "https://picsum.photos/id/237/300/200";

  await downloadImageToMemfs(imageUrl, "/image.png");

  const file = await fs.promises.readFile("/image.png");

  console.log("Bytes:", file.length);
}

main();
`,
          repl2:`// my-repl.js
import repl from 'node:repl';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Match native Node.js startup message exactly
console.log(\`Welcome to Node.js \${process.version}.\`);
console.log('Type ".help" for more information.');

// Start the REPL server matching default node settings
const replServer = repl.start({
  prompt: '> ',
  useGlobal: true, // Matches node CLI REPL behavior (shares global scope)
});

// Expose variables or modules directly into the REPL context scope
replServer.context.os = os;
replServer.context.sayHello = () => "Hello from the custom REPL context!";

// Handle clean exit on .exit or Ctrl+D
replServer.on('exit', () => {
  process.exit(0);
});

// Enable default persistent history (.node_repl_history in user home directory)
const historyPath = process.env.NODE_REPL_HISTORY || path.join(os.homedir(), '.node_repl_history');
replServer.setupHistory(historyPath, (err) => {
  if (err) {
    console.error('Error setting up REPL history:', err);
  }
});`,
          repl:`// repl.js
 import readline from "readline"
 
 let editorMode = false;
let editorBuffer = [];

// Self-rebinding eval that preserves context between runs
let __EVAL = s => eval(\`void (__EVAL = \${__EVAL.toString()}); \${s}\`);

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> ',
});

// History of commands
let history = [];

/* ------------------ Evaluation ------------------ */

function evaluate(input) {
  try {
    const result = __EVAL(input.trim());
    if (result !== undefined) {
      console.log(result);
    }
  } catch (error) {
    logErrorWithStackTrace(error);
  }
}

function logErrorWithStackTrace(error) {
  console.log('\x1b[41m' + error.name + ':' + error.message.trim() + '\x1b[0m');
}

/* ------------------ Commands ------------------ */

function handleCommands(input) {
  switch (input) {
    case '.help': 
      console.log(\`
.break    Sometimes you get stuck, this gets you out
.clear    Alias for .break
.exit     Exit the REPL
.help     Print this help message
.load     Load JS from a file into the REPL session
.save     Save all evaluated commands in this REPL session to a file
.editor   Enter editor mode (Ctrl+D to finish, Ctrl+C to cancel)
 
Press Ctrl+C to abort current expression, Ctrl+D to exit the REPL
      \`);
      return true;

    case '.exit':
      rl.close();
      
   case '.editor':
    throw new Error("Not fully implemented")
    editorMode = true;
    editorBuffer = [];
    console.log('Entering editor mode (Ctrl+D to finish, Ctrl+C to cancel)');
    return true;


    case '.break':
    case '.clear':
      console.log('Context preserved (no special break logic implemented)');
      return true;

    default:
      return false;
  }
}

/* ------------------ File Ops ------------------ */

function saveToFile(filename, history) {
  fs.writeFileSync(filename, history.join('\\n'), 'utf8');
  console.log(\`REPL session saved to \${filename}\`);
}

function loadFromFile(filename) {
  try {
    const content = fs.readFileSync(filename, 'utf8');
    console.log('File content loaded:\\n');
    console.log(content);
    evaluate(content);
  } catch (error) {
    console.error('Error loading file:', error.message);
  }
}

/* ------------------ REPL Loop ------------------ */

function displayWelcomeMessage() {
  console.log(\`Welcome to the Custom Node.js REPL!
Type ".help" for a list of commands.
Press Ctrl+C to abort current expression, Ctrl+D to exit the REPL.\`);
}

displayWelcomeMessage();
rl.prompt();

rl.on('line', (line) => {
  const input = line.trim();

  if (editorMode) {
    if(input === "quit"){
    editorMode = false;
    rl.close();
    }
    editorBuffer.push(line);
    rl.setPrompt(\`... \${line}\`);
    rl.prompt();
    return;
  }

  history.push(input);

  if (input === '.save') {
    saveToFile('repl_session.txt', history);
  } else if (input.startsWith('.load')) {
    const [, filename] = input.split(' ');
    loadFromFile(filename || 'repl_session.txt');
  } else if (!handleCommands(input)) {
    evaluate(input);
  }

  rl.prompt();
});


rl.on('close', () => {
    if (editorMode) {
    const code = editorBuffer.join('\\n');
    editorMode = false;
    rl.setPrompt('> ');
    console.log('\\nEvaluating editor input...\\n');
    evaluate(code);
    rl.prompt();
    return;
  }

  console.log('\\nExiting REPL...');
  process.exit(0);
});
`, 
          
          cli:`// Listen for input
import readline from "readline"

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const answer = await rl.question("Name? ");

console.log(answer)

rl.close();
 
  

console.log("Arguments:", process.argv.slice(2));

console.log("Type something and press Enter (type 'exit' to quit):");

// Start reading
process.stdin.resume();

process.stdin.on("data", (chunk) => {
  const input = chunk.trim();

  if (input === "exit") {
    console.log("Goodbye!");
    process.exit();
  }

  console.log("You typed:", input);
  
});
`,
          
          tests:`import test, { describe, it } from "node:test";
import assert from "node:assert";

describe('my suite', () => {
  it('works', () => {
    assert.equal(1 + 1, 2); 
  });

  it('hello world example', () => {
    console.log("Hello, world!");
    assert.strictEqual("Hello, world!", "Hello, world!");
  });
});`,
          
          relative:`
(async () => {
  try {
    // Dynamically load the module using your custom function
    const math = await import('./src/utils/math.js');

    console.log(math.default.add(1,2)); 
    
    
     try{
    const {boom} = await import('./src/utils/math.js');
    }catch(err){
console.log(err.message)
     // will fail since not module does not provide an export named 'boom'
    } 
    
    // Now you can use b(1, 2), etc.
  } catch (err) {
    console.error(err.message);
  }
})();`, 
           interop: `
           
            interop.expose('getData', async () => {
    await new Promise(r => setTimeout(r, 1000));
    return { result: 'processed' };
  });
           await interop.callParent('alert', 'Hello from sandbox');
           
          
           
const readFile = await interop.callParent('readFile', 'hello.txt');
          
console.log(readFile + "from fake FS")
           `,
          
          typescript:`
import { format } from "https://esm.sh/date-fns@3.6.0";

const now: Date = new Date();
const formattedDate: string = format(now, 'yyyy-MM-dd');

console.log("Today is:", formattedDate);`,
          
          
            sleep: `const sleep = ms => new Promise(r => setTimeout(r, ms));
 
async function demo() {
  console.log("Waiting...");
  await sleep(1000); // wait 1 second
  console.log("Done!");
  console.log("Waiting...");
  await sleep(1000); // wait 1 second
  console.log("Done!");
}

await demo();`,
          require:`const math = require('./require');

console.log(math.add(2, 3));      // 5
console.log(math.msg);   //  Hello from CommonJS!`,
            async: `// Async operations with fetch
async function getData() {
  console.log('Fetching data...');
  
  const response = await fetch('https://api.github.com/repos/MarketingPipeline/Termino.js');
  const data = await response.json();
  
  console.log('User:', data.login);
  console.log('Followers:', data.followers);
  console.log('Public Repos:', data.public_repos);
}

await getData();
console.log('Done!');`,
            
            imports: `// Import and use NPM packages
import * as math from "https://esm.sh/mathjs";
import _ from "https://esm.sh/lodash";

console.log('Math library loaded!');

// Complex math operations
const result = math.evaluate('sqrt(16) + log(100, 10)');
console.log('Math result:', result);

// Lodash utilities
const numbers = [1, 2, 3, 4, 5, 6, 7, 8];
const chunked = _.chunk(numbers, 3);
console.log('Chunked array:', chunked);

const users = [
  { name: 'Alice', age: 30 },
  { name: 'Bob', age: 25 },
  { name: 'Charlie', age: 35 }
];

const sorted = _.sortBy(users, 'age');
console.log('Sorted users:', sorted);`,
          top_level: `const isString = (await import('https://esm.sh/is-string')).default;
console.log(isString("cool"));`,
          process_kill:`
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          async function demo() {
  console.log("Starting loop...");

  for (let i = 1; i <= 10; i++) {

    console.log(\`Iteration \${i}\...\`);

    // Simulate work by waiting for 1 second
    await sleep(1000);

    // On the 5th iteration, simulate killing the process
    if (i === 5) {
      console.log("Calling process.kill() on iteration 5");
      process.exit(); // Simulate killing the process
    }
  }

  console.log("Loop finished or stopped.");
}

// Run the demo
await demo();`
        };

        // DOM elements
        const codeInput = document.getElementById('codeInput');
        const output = document.getElementById('output');
        const runBtn = document.getElementById('runBtn');
        const clearBtn = document.getElementById('clearBtn');
        const status = document.getElementById('status');
        const execTime = document.getElementById('execTime');
        const exampleBtns = document.querySelectorAll('.example-btn');

        // Initialize xterm.js terminal emulator. This replaces the old
        // DOM-div-based terminal. xterm handles ANSI escape codes natively
        // (cursor movement, colors, clear screen), which the div-based
        // terminal could not.
        const term = new Terminal({
          cols: 80,
          rows: 24,
          cursorBlink: true,
          theme: {
            background: '#1a1b26',
            foreground: '#c0caf5',
          },
        });
        term.open(output);
        // Make terminal globally accessible for stdout/stderr handlers
        globalThis._xterm = term;
        // Wire user input to sandbox stdin. xterm's onData fires for every
        // keypress including special keys (arrows, backspace, etc.).
        term.onData((data) => {
          sandbox.invoke('__stdin__', data).catch(err => {
            console.error('[stdin] send failed:', err);
          });
        });
        let currentExample = null;
        // Load example code
        exampleBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const example = btn.dataset.example;
                codeInput.value = examples[example];
                sandbox.requireAllowed = false
                if(example === "require"){
                  sandbox.requireAllowed = true
                }  
              
               currentExample  = example
                
              
                codeInput.focus();
            });
        });

        // Clear output
        clearBtn.addEventListener('click', () => {
            output.innerHTML = '<div class="text-gray-500 italic">Output cleared...</div>';
            execTime.textContent = '';
        });



          
          function getArgv() {
  const raw = document.getElementById("argvInput").value;
  return `node script.js ${raw}`
}  

  function toggleArgvInput(enabled) {
  const input = document.getElementById("argvInput");
  // If enabled is true, input should be enabled (disabled = false)
  input.disabled = !enabled;
}

function getStdin() {
  return document.getElementById("stdinInput").value;
}



// NOTE: The old DOM-div-based terminal (shadowBuffer, toNodeKeypress,
// createNewTerminalLine, updateTerminalInput, lineNumber) has been replaced
// by xterm.js. See the Terminal initialization above. User input is wired
// via term.onData(), output via term.write(). xterm handles ANSI natively.

document.getElementById('sendInput').addEventListener('click', () => {
  sandbox.invoke('__stdin__', '\n').catch(err => console.error('[stdin] send failed:', err));
  const stdinInput = document.getElementById("stdinInput");
  if (stdinInput) stdinInput.value = '';
});
/* 

document.getElementById("sendInput").addEventListener("click", async () => {
  const input = getStdin();
 // console.log("Sending stdin:", input);
  
  await sandbox.invoke('__stdin__', input + "\n") // remove \n if emitting keypress.
});
*/



        // Simulate code execution
        runBtn.addEventListener('click', async () => {
            let code = codeInput.value;
          
            if(currentExample === "typescript"){
               code =  transpileTypeScript(code)
              }



          
            
            // Update UI
            runBtn.disabled = true;
            runBtn.innerHTML = '<svg class="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> Running...';
            status.textContent = 'Executing...';
            status.className = 'text-yellow-400';
           if(!output.classList.contains("whitespace-pre-wrap")){
         
             output.classList.add("whitespace-pre-wrap")
           }
            output.innerHTML = '<div class="text-yellow-400 animate-pulse">⚡ Executing code...</div>';
            
         
            
          
          
          
            const startTime = performance.now();
      
            try {
              
                  // Initialize and execute
           await sandbox.init();
              
           const isRequireAllowed = true
           
           const _allowedGlobals = []
           
           if(sandbox.requireAllowed){
             _allowedGlobals.push("require")
           }
              
              _allowedGlobals.push("setImmediate")
              
               _allowedGlobals.push("fs")
              
              _allowedGlobals.push("interop")
              _allowedGlobals.push("type")
               _allowedGlobals.push("readline")
              _allowedGlobals.push("__dirname")
              _allowedGlobals.push("Buffer")
           //_allowedGlobals.push('globalThis')
           
            refCheck(code, _allowedGlobals) 
            toggleArgvInput(false)
              
            const result = await sandbox.execute(code)
           
            //this._serverRunning = false;
             
           // console.log(result)
            
                const logs = result?.logs
              
                console.log(result)
                if(!result.success){
                  throw new Error(result.stack)
                }
                
              // Initial render
              
renderFiles(result.fs);
              
              /* output.innerHTML = "";
              logs.forEach(({ type, args }) => {
                const levelClasses = {
                info: 'text-blue-500',
                error: 'text-red-500',
                warn: 'text-yellow-500',
                debug: 'text-purple-500',
                log: ''
              };

               const cls = levelClasses[type] || '';

              const span = document.createElement('span');
              span.className = `whitespace-pre-wrap font-mono ${cls}`;
              span.textContent = args;

              output.appendChild(span);
              output.appendChild(document.createElement('br'));
               }); */    
                     
                const endTime = performance.now();
                   
                //const executionTime = (endTime - startTime).toFixed(2);
                const executionTime = result?.executionTime;
                execTime.textContent = `Execution time: ${executionTime}ms`;
                status.textContent = 'Success';
                status.className = 'text-green-400';
                
            } catch (err) {
              console.log(err)
                const endTime = performance.now();
                const executionTime = (endTime - startTime).toFixed(2);
                
          
                let message = err.message;

                execTime.textContent = `Execution time: ${executionTime}ms`;
                output.innerHTML = `<div class="text-red-400">✗ Error: ${message}</div>`;
                status.textContent = 'Error';
                status.className = 'text-red-400';
            }finally{
          
           toggleArgvInput(true)
            
            // Reset button
            runBtn.disabled = false;
            runBtn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg> Run Code';
            }
        });

        // Smooth scrolling for anchor links
        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', function (e) {
                e.preventDefault();
                const target = document.querySelector(this.getAttribute('href'));
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        });

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
    Object.keys(originalError).forEach(key => {
      if (!(key in this)) {
        this[key] = originalError[key];
      }
    });
  }

  toString() {
    return this.formattedMessage || this.message;
  }
}
function formatErrors(code, err) {
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
      context
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
      context
    ].join("\n");
  }

  return new FormattedError(err, formattedMessage);
}

const filesDiv = document.getElementById("files");

// Event delegation: only ONE listener for the whole list
filesDiv.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  const pre = button.nextElementSibling;
  if (!pre) return;

  pre.classList.toggle("hidden");
});


function detectMimeType(uint8) {
  if (uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4e && uint8[3] === 0x47) return "image/png";
  if (uint8[0] === 0xff && uint8[1] === 0xd8 && uint8[2] === 0xff) return "image/jpeg";
  if (uint8[0] === 0x47 && uint8[1] === 0x49 && uint8[2] === 0x46) return "image/gif";
  if (uint8[0] === 0x52 && uint8[1] === 0x49 && uint8[2] === 0x46 && uint8[3] === 0x46 &&
      uint8[8] === 0x57 && uint8[9] === 0x45 && uint8[10] === 0x42 && uint8[11] === 0x50) return "image/webp";
  return "application/octet-stream";
}

// 2. Then declare your helper function and main function

// Normalize the `seaAssets` sandbox option into a JSON-safe map for the
// bootstrap object: { [key]: { encoding: 'utf8'|'base64', data: string } }.
// Accepted value shapes (mirrors the leniency of `fs` -> __USER_FILES__):
//   string                                   -> utf8 text
//   Uint8Array / ArrayBuffer / SharedArrayBuffer -> base64 bytes
//   { encoding: 'utf8'|'base64', data: string }  -> used as-is
// Anything else (including empty keys) is dropped: a misconfigured asset
// must never break sandbox bootstrap.
function normalizeSeaAssets(assets) {
  const out = {};
  if (!assets || typeof assets !== 'object') return out;
  const entries = typeof assets.entries === 'function' && assets instanceof Map
    ? assets.entries()
    : Object.entries(assets);
  for (const [key, value] of entries) {
    if (typeof key !== 'string' || key === '') continue;
    if (typeof value === 'string') {
      out[key] = { encoding: 'utf8', data: value };
    } else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
      out[key] = { encoding: 'base64', data: base64EncodeBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    } else if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
      out[key] = { encoding: 'base64', data: base64EncodeBytes(new Uint8Array(value)) };
    } else if (value && typeof value === 'object' && typeof value.data === 'string' &&
               (value.encoding === 'utf8' || value.encoding === 'base64')) {
      out[key] = { encoding: value.encoding, data: value.data };
    }
  }
  return out;
}

function base64EncodeBytes(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function flattenFileTree(obj, parentPath = '') {
  let flat = {};
  if (!obj || typeof obj !== 'object') return flat;

  for (const [key, value] of Object.entries(obj)) {
    const fullPath = parentPath ? `${parentPath}/${key}` : key;

    if (value === null) {
      continue;
    } else if (typeof value === 'object' && !(value instanceof Uint8Array) && !(value instanceof Blob)) {
      Object.assign(flat, flattenFileTree(value, fullPath));
    } else {
      flat[fullPath] = value;
    }
  }
  return flat;
}

// Keep track of active blob URLs globally or in closure scope so we can clean them up
let activeBlobUrls = [];

function renderFiles(filesObj) {
  if (!filesObj) filesObj = {};
  
  filesObj = flattenFileTree(filesObj)
 
  activeBlobUrls.forEach(url => URL.revokeObjectURL(url));
  activeBlobUrls = []; // Reset the tracking array
 
  filesDiv.innerHTML = "";

  const entries = Object.entries(filesObj);

  if (entries.length === 0) {
    filesDiv.innerHTML = `
      <div class="p-3 text-gray-400">
        No files available.
      </div>
    `;
    return;
  }

  entries.forEach(([name, content]) => {
    
    const fileItem = document.createElement("div");
    fileItem.className = "mb-2 border border-gray-700 rounded-md overflow-hidden";

    const ext = name.split('.').pop().toLowerCase();

    const imageTypes = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp'
    };

    const audioTypes = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4'
    };

    const videoTypes = {
      mp4: 'video/mp4',
      webm: 'video/webm',
      ogg: 'video/ogg',
      mov: 'video/quicktime'
    };

    let bodyContent = "";

    if (content instanceof Uint8Array && (imageTypes[ext] || audioTypes[ext] || videoTypes[ext])) {
      let mime =
        imageTypes[ext] ||
        audioTypes[ext] ||
        videoTypes[ext] ||
        'application/octet-stream';

      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      
      // 2. TRACK THE NEW URL: Push it to our cleanup array
      activeBlobUrls.push(url); 

      if (imageTypes[ext]) {
        bodyContent = `
          <div class="px-3 py-2 bg-gray-800 hidden">
            <img src="${url}" class="max-w-full rounded" />
          </div>
        `;
      } else if (audioTypes[ext]) {
        bodyContent = `
          <div class="px-3 py-2 bg-gray-800 hidden">
            <audio controls class="w-full">
              <source src="${url}" type="${mime}">
              Your browser does not support audio.
            </audio>
          </div>
        `;
      } else if (videoTypes[ext]) {
        bodyContent = `
          <div class="px-3 py-2 bg-gray-800 hidden">
            <video controls class="w-full max-h-96 rounded">
              <source src="${url}" type="${mime}">
              Your browser does not support video.
            </video>
          </div>
        `;
      }    

    } else {
      // Text fallback with safe type checking
      let safeText = "";

      if (typeof content === "string") {
        safeText = content;
      } else if (content instanceof Uint8Array) {
        safeText = new TextDecoder().decode(content);
      } else if (content && typeof content === "object" && !(content instanceof Blob)) {
        // If it's a directory object or unknown object instead of a file
        safeText = JSON.stringify(content, null, 2);
      } else {
        safeText = String(content ?? "");
      }

      bodyContent = `
        <pre class="px-3 py-2 bg-gray-800 text-xs text-gray-200 hidden overflow-auto">${safeText}</pre>
      `;
    }

    fileItem.innerHTML = `
      <button class="w-full text-left px-3 py-2 bg-gray-900 hover:bg-gray-800 flex justify-between items-center toggle-btn">
        <span class="text-gray-200">${name}</span>
        <span class="text-gray-400">▼</span>
      </button>
      ${bodyContent}
    `;

    filesDiv.appendChild(fileItem);
  });
} 
 

renderFiles(sandbox.config.fs)

function renderFiles2(filesObj) {
  if (!filesObj) filesObj = {};
  filesDiv.innerHTML = "";

  const entries = Object.entries(filesObj);

  if (entries.length === 0) {
    filesDiv.innerHTML = `
      <div class="p-3 text-gray-400">
        No files available.
      </div>
    `;
    return;
  }

  entries.forEach(([name, content]) => {
    const fileItem = document.createElement("div");
    fileItem.className = "mb-2 border border-gray-700 rounded-md overflow-hidden";

    const ext = name.split('.').pop().toLowerCase();

    const imageTypes = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp'
    };

    const audioTypes = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4'
    };

    const videoTypes = {
      mp4: 'video/mp4',
      webm: 'video/webm',
      ogg: 'video/ogg',
      mov: 'video/quicktime'
    };

    let bodyContent = "";

    if (content instanceof Uint8Array && imageTypes[ext] || content instanceof Uint8Array && audioTypes[ext] || content instanceof Uint8Array && videoTypes[ext]) {
      let mime =
        imageTypes[ext] ||
        audioTypes[ext] ||
        videoTypes[ext] ||
        'application/octet-stream';

      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);

      if (imageTypes[ext]) {
        bodyContent = `
          <div class="px-3 py-2 bg-gray-800 hidden">
            <img src="${url}" class="max-w-full rounded" />
          </div>
        `;
      } else if (audioTypes[ext]) {
        bodyContent = `
          <div class="px-3 py-2 bg-gray-800 hidden">
            <audio controls class="w-full">
              <source src="${url}" type="${mime}">
              Your browser does not support audio.
            </audio>
          </div>
        `;
      } else if (videoTypes[ext]) {
        bodyContent = `
          <div class="px-3 py-2 bg-gray-800 hidden">
            <video controls class="w-full max-h-96 rounded">
              <source src="${url}" type="${mime}">
              Your browser does not support video.
            </video>
          </div>
        `;
      }    

    } else {
      // Text fallback
      const safeText =
        typeof content === "string"
          ? content
          : new TextDecoder().decode(content);

      bodyContent = `
        <pre class="px-3 py-2 bg-gray-800 text-xs text-gray-200 hidden overflow-auto">${safeText}</pre>
      `;
    }

    fileItem.innerHTML = `
      <button class="w-full text-left px-3 py-2 bg-gray-900 hover:bg-gray-800 flex justify-between items-center toggle-btn">
        <span class="text-gray-200">${name}</span>
        <span class="text-gray-400">▼</span>
      </button>
      ${bodyContent}
    `;

    // Toggle visibility
     

    filesDiv.appendChild(fileItem);
  });
}

 



 
