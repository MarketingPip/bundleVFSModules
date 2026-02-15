import { resolve as resolvePath, sep } from 'node:path';
import punycode from 'node:punycode';

const isWindows =
  typeof process !== 'undefined' && process.platform === 'win32';

/* ================================
   Modern WHATWG URL Exports
================================ */

export { URL, URLSearchParams };

/* ================================
   fileURLToPath
================================ */

export function fileURLToPath(path) {
  const url = typeof path === 'string' ? new URL(path) : path;
  if (!(url instanceof URL)) {
    throw new TypeError('Expected URL object or string');
  }
  if (url.protocol !== 'file:') {
    throw new TypeError('Protocol must be file:');
  }

  let pathname = decodeURIComponent(url.pathname);

  if (isWindows) {
    // UNC paths
    if (url.hostname !== '') {
      return `\\\\${url.hostname}${pathname.replace(/\//g, '\\')}`;
    }

    // Drive letters
    pathname = pathname.replace(/^\/([A-Za-z]:)/, '$1');
    return pathname.replace(/\//g, '\\');
  }

  return pathname;
}

/* ================================
   pathToFileURL
================================ */

export function pathToFileURL(filepath) {
  let resolved = resolvePath(filepath);

  // Preserve trailing slash
  if (
    filepath.endsWith('/') ||
    (isWindows && filepath.endsWith('\\'))
  ) {
    if (!resolved.endsWith(sep)) resolved += sep;
  }

  const outURL = new URL('file://');

  if (isWindows) {
    resolved = resolved.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(resolved)) {
      resolved = '/' + resolved;
    }
  }

  outURL.pathname = resolved;
  return outURL;
}

/* ================================
   Domain Conversion
================================ */

export function domainToASCII(domain) {
  return punycode.toASCII(domain);
}

export function domainToUnicode(domain) {
  return punycode.toUnicode(domain);
}

/* ================================
   Legacy API (Compatibility)
================================ */

export function parse(urlString, parseQueryString = false) {
  const url = new URL(urlString);

  const result = {
    href: url.href,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    query: parseQueryString
      ? Object.fromEntries(url.searchParams)
      : url.search.replace(/^\?/, ''),
  };

  return result;
}

export function format(urlObject) {
  if (typeof urlObject === 'string') return urlObject;

  const url = new URL(
    urlObject.href ||
      `${urlObject.protocol || 'http:'}//${urlObject.host || ''}`
  );

  if (urlObject.pathname) url.pathname = urlObject.pathname;
  if (urlObject.search) url.search = urlObject.search;
  if (urlObject.hash) url.hash = urlObject.hash;

  return url.toString();
}

export function resolve(from, to) {
  return new URL(to, from).toString();
}
