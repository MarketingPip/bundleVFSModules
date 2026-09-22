// Repo tests for src/https.js — the browser port of node:https (v24.20.0).
// Browser strategy: TLS is owned by fetch(); the client forces https:
// defaults and the server reuses the virtual http registry.
import https, {
  Server,
  createServer,
  request,
  get,
  Agent,
  globalAgent,
} from '../src/https.js';
import http from '../src/http.js';
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

const throwsCode = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
};

describe('https surface', () => {
  test('exports exactly Server/createServer/request/get/Agent/globalAgent', () => {
    expect(Object.keys(https).sort()).toEqual(
      ['Agent', 'Server', 'createServer', 'get', 'globalAgent', 'request']);
    expect(Server).toBe(https.Server);
    expect(createServer).toBe(https.createServer);
    expect(request).toBe(https.request);
    expect(get).toBe(https.get);
    expect(Agent).toBe(https.Agent);
    expect(globalAgent).toBe(https.globalAgent);
  });
});

describe('https.Agent', () => {
  test('defaults match Node (443, https:, maxCachedSessions 100)', () => {
    const agent = new Agent();
    expect(agent).toBeInstanceOf(http.Agent);
    expect(agent.defaultPort).toBe(443);
    expect(agent.protocol).toBe('https:');
    expect(agent.maxCachedSessions).toBe(100);
    expect(agent.keepAlive).toBe(false);
  });

  test('globalAgent is an https Agent', () => {
    expect(globalAgent).toBeInstanceOf(Agent);
    expect(globalAgent.defaultPort).toBe(443);
    expect(globalAgent.protocol).toBe('https:');
    expect(globalAgent.maxCachedSessions).toBe(100);
    expect(globalAgent.keepAlive).toBe(true);
  });

  test('explicit options win over https defaults', () => {
    const agent = new Agent({ defaultPort: 8443, maxCachedSessions: 5 });
    expect(agent.defaultPort).toBe(8443);
    expect(agent.maxCachedSessions).toBe(5);
    expect(agent.protocol).toBe('https:');
  });
});

describe('https.Server', () => {
  test('extends http.Server and shares the virtual registry', async () => {
    expect(new Server()).toBeInstanceOf(http.Server);
    const server = createServer({ key: 'fake', cert: 'fake' }, (req, res) => {
      res.end('secure-ish');
    });
    expect(server).toBeInstanceOf(Server);
    await new Promise((resolve) => server.listen(18101, resolve));
    const result = await server.handleRequest('GET', '/tls', {}, null);
    expect(result.statusCode).toBe(200);
    expect(Buffer.from(result.body).toString()).toBe('secure-ish');
    server.close();
  });

  test('setSecureContext is accepted and ignored', () => {
    const server = createServer();
    expect(() => server.setSecureContext({ cert: 'x' })).not.toThrow();
  });
});

describe('https client (fetch bridge)', () => {
  let realFetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({
      status: 200,
      statusText: 'OK',
      headers: new Map(),
      arrayBuffer: async () => new TextEncoder().encode('tls body').buffer,
    }));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('request forces the https: protocol', async () => {
    const body = await new Promise((resolve, reject) => {
      const req = request('https://example.com/secure', (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    expect(body).toBe('tls body');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/secure',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('options without protocol default to https:', async () => {
    await new Promise((resolve, reject) => {
      const req = request({ hostname: 'example.com', path: '/' }, (res) => {
        res.resume();
        res.on('end', resolve);
        res.on('error', reject);
      });
      req.on('error', reject);
      expect(req.protocol).toBe('https:');
      expect(req.agent).toBe(globalAgent);
      req.end();
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/',
      expect.anything(),
    );
  });

  test('get() ends the request', async () => {
    const req = get('https://example.com/', () => {});
    req.on('error', () => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  test('http: URL through https.request throws ERR_INVALID_PROTOCOL', () => {
    expect(throwsCode(() => request('http://example.com/', () => {})))
      .toBe('ERR_INVALID_PROTOCOL');
  });

  test('TLS options are accepted and ignored', async () => {
    await new Promise((resolve, reject) => {
      const req = request({
        hostname: 'example.com',
        path: '/',
        key: 'fake-key',
        cert: 'fake-cert',
        ca: 'fake-ca',
        rejectUnauthorized: false,
      }, (res) => {
        res.resume();
        res.on('end', resolve);
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});
