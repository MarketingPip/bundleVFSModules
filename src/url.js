import { resolve, sep } from 'path';

const isWindows = typeof process !== 'undefined' && process.platform === 'win32';

export function fileURLToPath(path) {
    const url = (typeof path === 'string') ? new URL(path) : path;
    if (url.protocol !== 'file:') throw new TypeError('Protocol must be file:');
    
    let pathname = decodeURIComponent(url.pathname);

    if (isWindows) {
        // 1. Handle UNC paths (file://server/share -> \\server\share)
        if (url.hostname !== '') {
            return `\\\\${url.hostname}${pathname.replace(/\//g, '\\')}`;
        }
        // 2. Handle Drive Letters (/C:/path -> C:/path)
        pathname = pathname.replace(/^\/([A-Za-z]:)/, '$1');
        return pathname.replace(/\//g, '\\');
    }

    return pathname;
}

export function pathToFileURL(filepath) {
    let resolved = resolve(filepath);
    
    // Maintain trailing slash if the input had one
    if (filepath.endsWith('/') || (isWindows && filepath.endsWith('\\'))) {
        if (!resolved.endsWith(sep)) resolved += sep;
    }

    const outURL = new URL('file://');
    if (isWindows) {
        resolved = resolved.replace(/\\/g, '/');
        // Windows absolute paths need a leading slash: C:/ -> /C:/
        if (/^[A-Za-z]:/.test(resolved)) resolved = '/' + resolved;
    }
    
    // Let the URL class handle the encoding safely
    outURL.pathname = resolved; 
    return outURL;
}
