// Tiny entry: bundles src/cookieJar.js (+ set-cookie-parser) into a
// self-contained IIFE that installs itself on globalThis.__cookieJarLib.
// Used by src/build-sandbox.mjs to inline the cookie jar into the template.
import * as lib from '../cookieJar.js';

globalThis.__cookieJarLib = lib;
