/**
 * Tests for the host-side virtual-server fetch bridge in runtime.js.
 *
 * The bridge lives between the VFS_FETCH_BRIDGE_START / VFS_FETCH_BRIDGE_END
 * markers in runtime.js (module-level, host side). This test extracts that
 * exact source and evaluates it in a vm context with mocked browser globals,
 * so the tests exercise the real code — not a copy.
 *
 * TDD: this file was written before the bridge implementation.
 */
import { describe, test, expect, jest } from "@jest/globals";
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RUNTIME_PATH = path.join(__dirname, '..', 'runtime.js');
const START_MARKER = '// VFS_FETCH_BRIDGE_START';
const END_MARKER = '// VFS_FETCH_BRIDGE_END';

/** Evaluate the bridge source fresh (clean registry) with a mock window. */
function loadBridge() {
  const src = fs.readFileSync(RUNTIME_PATH, 'utf8');
  const start = src.indexOf(START_MARKER);
  const end = src.indexOf(END_MARKER);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('VFS fetch bridge markers not found in runtime.js');
  }
  const code = src.slice(start, end);

  const nativeFetch = jest.fn(async () => new Response('native-body', { status: 200 }));
  const mockWindow = {
    fetch: nativeFetch,
    location: { href: 'http://host.test/' },
  };
  const ctx = vm.createContext({
    window: mockWindow,
    Response,
    URL,
    console,
  });
  const exported = vm.runInContext(
    `${code}\n;({` +
      ' _vfsServerRoutes,' +
      ' _vfsIsLoopbackHostname,' +
      ' _vfsExtractServerPort,' +
      ' _vfsRegisterServerRoute,' +
      ' _vfsUnregisterServerRoute,' +
      ' _vfsPatchedFetch,' +
      ' _vfsDispatchToSandbox,' +
      '})',
    ctx,
    { filename: 'vfs-fetch-bridge.js' }
  );
  return { bridge: exported, mockWindow, nativeFetch };
}

function makeOwner(result = { statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'text/plain' }, body: 'virtual-body' }) {
  return {
    running: true,
    invoke: jest.fn(async () => ({ ...result })),
  };
}

describe('host fetch bridge (runtime.js)', () => {
  describe('_vfsExtractServerPort', () => {
    test('parses the sandbox wire format: message "null {\\"port\\":8080}"', () => {
      const { bridge } = loadBridge();
      expect(bridge._vfsExtractServerPort({ type: 'serverListening', message: 'null {"port":8080}' })).toBe(8080);
    });

    test('prefers a numeric data.port when present', () => {
      const { bridge } = loadBridge();
      expect(bridge._vfsExtractServerPort({ type: 'serverListening', port: 3000, message: 'null {"port":9999}' })).toBe(3000);
    });

    test('returns null when no port can be found', () => {
      const { bridge } = loadBridge();
      expect(bridge._vfsExtractServerPort({ type: 'serverListening', message: 'null garbage' })).toBeNull();
      expect(bridge._vfsExtractServerPort(null)).toBeNull();
      expect(bridge._vfsExtractServerPort({})).toBeNull();
    });
  });

  describe('_vfsIsLoopbackHostname', () => {
    test.each(['localhost', 'LOCALHOST', '127.0.0.1', '[::1]', '::1'])('matches loopback %s', (h) => {
      const { bridge } = loadBridge();
      expect(bridge._vfsIsLoopbackHostname(h)).toBe(true);
    });

    test.each(['example.com', 'localhost.evil.com', 'evil-localhost', '127.0.0.2', '192.168.1.1', ''])(
      'rejects non-loopback %s',
      (h) => {
        const { bridge } = loadBridge();
        expect(bridge._vfsIsLoopbackHostname(h)).toBe(false);
      }
    );
  });

  describe('registry', () => {
    test('first claim wins; second sandbox on the same port is rejected', () => {
      const { bridge } = loadBridge();
      const a = makeOwner();
      const b = makeOwner();
      expect(bridge._vfsRegisterServerRoute(8080, a)).toBe(true);
      expect(bridge._vfsRegisterServerRoute(8080, b)).toBe(false);
      expect(bridge._vfsServerRoutes.get(8080)).toBe(a);
    });

    test('re-register by the same owner is idempotent', () => {
      const { bridge } = loadBridge();
      const a = makeOwner();
      expect(bridge._vfsRegisterServerRoute(8080, a)).toBe(true);
      expect(bridge._vfsRegisterServerRoute(8080, a)).toBe(true);
      expect(bridge._vfsServerRoutes.size).toBe(1);
    });

    test('unregister only removes the owning context', () => {
      const { bridge } = loadBridge();
      const a = makeOwner();
      const b = makeOwner();
      bridge._vfsRegisterServerRoute(8080, a);
      bridge._vfsUnregisterServerRoute(8080, b); // not the owner: no-op
      expect(bridge._vfsServerRoutes.has(8080)).toBe(true);
      bridge._vfsUnregisterServerRoute(8080, a);
      expect(bridge._vfsServerRoutes.has(8080)).toBe(false);
    });
  });

  describe('fetch patch lifecycle', () => {
    test('registering a route patches window.fetch exactly once', () => {
      const { bridge, mockWindow, nativeFetch } = loadBridge();
      const a = makeOwner();
      const original = mockWindow.fetch;
      bridge._vfsRegisterServerRoute(8080, a);
      bridge._vfsRegisterServerRoute(9090, a);
      expect(mockWindow.fetch).not.toBe(original);
      expect(mockWindow.fetch.__vfsBridged).toBe(true);
      expect(nativeFetch).not.toHaveBeenCalled();
    });

    test('unregistering the final route restores the original fetch', () => {
      const { bridge, mockWindow, nativeFetch } = loadBridge();
      const a = makeOwner();
      const original = mockWindow.fetch;
      bridge._vfsRegisterServerRoute(8080, a);
      const patched = mockWindow.fetch;
      bridge._vfsUnregisterServerRoute(8080, a);
      expect(mockWindow.fetch).toBe(original);
      expect(mockWindow.fetch).not.toBe(patched);
      // one route remaining keeps the patch installed
      bridge._vfsRegisterServerRoute(8080, a);
      bridge._vfsRegisterServerRoute(9090, a);
      bridge._vfsUnregisterServerRoute(8080, a);
      expect(mockWindow.fetch.__vfsBridged).toBe(true);
      expect(nativeFetch).not.toHaveBeenCalled();
    });
  });

  describe('request routing', () => {
    test('localhost URL on a registered port reaches the owning sandbox', async () => {
      const { bridge, mockWindow, nativeFetch } = loadBridge();
      const owner = makeOwner();
      bridge._vfsRegisterServerRoute(8080, owner);
      const res = await mockWindow.fetch('http://localhost:8080/api/data');
      expect(nativeFetch).not.toHaveBeenCalled();
      expect(owner.invoke).toHaveBeenCalledWith(
        '__serverRequest__', 8080, '/api/data', 'GET', {}, {}
      );
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('virtual-body');
    });

    test('127.0.0.1 and [::1] route to the same owner', async () => {
      const { bridge, mockWindow } = loadBridge();
      const owner = makeOwner();
      bridge._vfsRegisterServerRoute(8080, owner);
      await mockWindow.fetch('http://127.0.0.1:8080/a');
      await mockWindow.fetch('http://[::1]:8080/b');
      expect(owner.invoke).toHaveBeenCalledTimes(2);
      expect(owner.invoke.mock.calls[0][1]).toBe(8080);
      expect(owner.invoke.mock.calls[1][1]).toBe(8080);
    });

    test('two sandboxes route independently by port', async () => {
      const { bridge, mockWindow } = loadBridge();
      const a = makeOwner({ statusCode: 200, statusMessage: 'OK', headers: {}, body: 'from-a' });
      const b = makeOwner({ statusCode: 200, statusMessage: 'OK', headers: {}, body: 'from-b' });
      bridge._vfsRegisterServerRoute(8080, a);
      bridge._vfsRegisterServerRoute(9090, b);
      const ra = await mockWindow.fetch('http://localhost:8080/');
      const rb = await mockWindow.fetch('http://localhost:9090/');
      expect(await ra.text()).toBe('from-a');
      expect(await rb.text()).toBe('from-b');
      expect(a.invoke).toHaveBeenCalledTimes(1);
      expect(b.invoke).toHaveBeenCalledTimes(1);
    });

    test('unregistered port falls through to the native fetch', async () => {
      const { bridge, mockWindow, nativeFetch } = loadBridge();
      bridge._vfsRegisterServerRoute(8080, makeOwner());
      const res = await mockWindow.fetch('http://localhost:9999/other');
      expect(nativeFetch).toHaveBeenCalledTimes(1);
      expect(await res.text()).toBe('native-body');
    });

    test('non-loopback hosts always use the native fetch', async () => {
      const { bridge, mockWindow, nativeFetch } = loadBridge();
      bridge._vfsRegisterServerRoute(8080, makeOwner());
      await mockWindow.fetch('https://example.com:8080/');
      await mockWindow.fetch('http://evil-localhost:8080/');
      expect(nativeFetch).toHaveBeenCalledTimes(2);
    });

    test('POST with a JSON body is forwarded', async () => {
      const { bridge, mockWindow } = loadBridge();
      const owner = makeOwner();
      bridge._vfsRegisterServerRoute(3000, owner);
      await mockWindow.fetch('http://localhost:3000/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
      expect(owner.invoke).toHaveBeenCalledWith(
        '__serverRequest__', 3000, '/submit', 'POST',
        JSON.stringify({ hello: 'world' }),
        { 'content-type': 'application/json' }
      );
    });

    test('query strings are preserved in the forwarded path', async () => {
      const { bridge, mockWindow } = loadBridge();
      const owner = makeOwner();
      bridge._vfsRegisterServerRoute(8080, owner);
      await mockWindow.fetch('http://localhost:8080/search?q=hello&page=2');
      expect(owner.invoke.mock.calls[0][2]).toBe('/search?q=hello&page=2');
    });

    test('response headers and status propagate to the native Response', async () => {
      const { bridge, mockWindow } = loadBridge();
      const owner = makeOwner({
        statusCode: 201, statusMessage: 'Created',
        headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
        body: '{"ok":true}',
      });
      bridge._vfsRegisterServerRoute(8080, owner);
      const res = await mockWindow.fetch('http://localhost:8080/');
      expect(res.status).toBe(201);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('x-custom')).toBe('yes');
      expect(await res.text()).toBe('{"ok":true}');
    });

    test('after unregister the same URL goes native again', async () => {
      const { bridge, mockWindow, nativeFetch } = loadBridge();
      const owner = makeOwner();
      bridge._vfsRegisterServerRoute(8080, owner);
      bridge._vfsUnregisterServerRoute(8080, owner);
      await mockWindow.fetch('http://localhost:8080/api');
      expect(owner.invoke).not.toHaveBeenCalled();
      expect(nativeFetch).toHaveBeenCalledTimes(1);
    });
  });
});
