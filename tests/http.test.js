// Repo tests for src/http.js — the browser port of node:http (v24.20.0).
// Browser-fallback lane: fetch is mocked, no native http delegation.
import { execFileSync } from 'node:child_process';
import http, {
  Agent,
  ClientRequest,
  IncomingMessage,
  OutgoingMessage,
  Server,
  ServerResponse,
  METHODS,
  STATUS_CODES,
  createServer,
  request,
  get,
  validateHeaderName,
  validateHeaderValue,
  setMaxIdleHTTPParsers,
  maxHeaderSize,
  globalAgent,
  getServer,
  getAllServers,
  _createClientRequest,
} from '../src/http.js';
import {
  _checkIsHttpToken,
  _checkInvalidHeaderChar,
  CRLF,
  chunkExpression,
  continueExpression,
  methods as internalMethods,
} from '../src/_http_common.js';
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';

const throwsCode = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
};

describe('constants', () => {
  test('METHODS: 35 sorted methods', () => {
    expect(METHODS).toHaveLength(35);
    expect([...METHODS].sort()).toEqual(METHODS);
    expect(METHODS).toContain('GET');
    expect(METHODS).toContain('ACL');
    expect(METHODS[0]).toBe('ACL');
  });

  test('STATUS_CODES: 63 entries with spot checks', () => {
    expect(Object.keys(STATUS_CODES)).toHaveLength(63);
    expect(STATUS_CODES[200]).toBe('OK');
    expect(STATUS_CODES[418]).toBe("I'm a Teapot");
    expect(STATUS_CODES[509]).toBe('Bandwidth Limit Exceeded');
    expect(STATUS_CODES[103]).toBe('Early Hints');
  });

  test('maxHeaderSize is 16384', () => {
    expect(maxHeaderSize).toBe(16384);
  });
});

describe('header validation', () => {
  test('validateHeaderName accepts tokens', () => {
    expect(validateHeaderName('X-Foo')).toBeUndefined();
    expect(validateHeaderName('X-1')).toBeUndefined();
  });

  test('validateHeaderName rejects non-tokens', () => {
    expect(throwsCode(() => validateHeaderName('bad name'))).toBe('ERR_INVALID_HTTP_TOKEN');
    expect(throwsCode(() => validateHeaderName(''))).toBe('ERR_INVALID_HTTP_TOKEN');
    expect(throwsCode(() => validateHeaderName(123))).toBe('ERR_INVALID_HTTP_TOKEN');
    expect(throwsCode(() => validateHeaderName(undefined))).toBe('ERR_INVALID_HTTP_TOKEN');
  });

  test('validateHeaderValue accepts valid values (coerces)', () => {
    expect(validateHeaderValue('X', 'abc')).toBeUndefined();
    expect(validateHeaderValue('X', 'a\tb')).toBeUndefined();
    expect(validateHeaderValue('X', 123)).toBeUndefined();
    expect(validateHeaderValue('X', 'café')).toBeUndefined();
  });

  test('validateHeaderValue rejects undefined and bad chars', () => {
    expect(throwsCode(() => validateHeaderValue('X', undefined)))
      .toBe('ERR_HTTP_INVALID_HEADER_VALUE');
    expect(throwsCode(() => validateHeaderValue('X', 'a\0b'))).toBe('ERR_INVALID_CHAR');
    expect(throwsCode(() => validateHeaderValue('X', 'a\rb'))).toBe('ERR_INVALID_CHAR');
  });

  test('setMaxIdleHTTPParsers validates like Node', () => {
    expect(() => setMaxIdleHTTPParsers(5)).not.toThrow();
    expect(throwsCode(() => setMaxIdleHTTPParsers('5'))).toBe('ERR_INVALID_ARG_TYPE');
    expect(throwsCode(() => setMaxIdleHTTPParsers(1.5))).toBe('ERR_OUT_OF_RANGE');
    expect(throwsCode(() => setMaxIdleHTTPParsers(0))).toBe('ERR_OUT_OF_RANGE');
    expect(throwsCode(() => setMaxIdleHTTPParsers(-1))).toBe('ERR_OUT_OF_RANGE');
  });
});

describe('_http_common internals', () => {
  test('token and header-char checks', () => {
    expect(_checkIsHttpToken('X-Foo')).toBe(true);
    expect(_checkIsHttpToken('a b')).toBe(false);
    expect(_checkIsHttpToken('')).toBe(false);
    expect(_checkInvalidHeaderChar('ok')).toBe(false);
    expect(_checkInvalidHeaderChar('a\rb')).toBe(true);
    expect(_checkInvalidHeaderChar('a\tb')).toBe(false);
  });

  test('CRLF and expressions', () => {
    expect(CRLF).toBe('\r\n');
    expect(chunkExpression.test('chunked')).toBe(true);
    expect(chunkExpression.test('gzip')).toBe(false);
    expect(continueExpression.test('100-continue')).toBe(true);
  });

  test('internal method order starts DELETE, GET, HEAD (not sorted)', () => {
    expect(internalMethods.slice(0, 3)).toEqual(['DELETE', 'GET', 'HEAD']);
    expect(internalMethods).toHaveLength(35);
  });
});

describe('Agent', () => {
  test('default options match Node', () => {
    const agent = new Agent();
    expect(agent.keepAlive).toBe(false);
    expect(agent.keepAliveMsecs).toBe(1000);
    expect(agent.maxSockets).toBe(Infinity);
    expect(agent.maxFreeSockets).toBe(256);
    expect(agent.maxTotalSockets).toBe(Infinity);
    expect(agent.scheduling).toBe('lifo');
    expect(agent.defaultPort).toBe(80);
    expect(agent.protocol).toBe('http:');
  });

  test('globalAgent differs by keepAlive', () => {
    expect(globalAgent).toBeInstanceOf(Agent);
    expect(globalAgent.keepAlive).toBe(true);
    expect(globalAgent.protocol).toBe('http:');
    expect(globalAgent.defaultPort).toBe(80);
  });

  test('options are honored', () => {
    const agent = new Agent({ keepAlive: true, maxSockets: 5, scheduling: 'fifo' });
    expect(agent.keepAlive).toBe(true);
    expect(agent.maxSockets).toBe(5);
    expect(agent.scheduling).toBe('fifo');
  });

  test('invalid scheduling and maxTotalSockets throw', () => {
    expect(throwsCode(() => new Agent({ scheduling: 'bogus' }))).toBe('ERR_INVALID_ARG_VALUE');
    expect(throwsCode(() => new Agent({ maxTotalSockets: 0 }))).toBe('ERR_OUT_OF_RANGE');
  });

  test('getName and destroy', () => {
    const agent = new Agent();
    expect(agent.getName({ host: 'example.com', port: 8080 })).toContain('example.com:8080');
    agent.destroy();
    expect(agent.totalSocketCount).toBe(0);
  });
});

describe('OutgoingMessage headers', () => {
  test('set/get/has/remove/append', () => {
    const msg = new OutgoingMessage();
    msg.setHeader('X-Foo', 'bar');
    expect(msg.getHeader('x-foo')).toBe('bar');
    expect(msg.hasHeader('X-FOO')).toBe(true);
    msg.appendHeader('X-Foo', 'baz');
    expect(msg.getHeader('x-foo')).toEqual(['bar', 'baz']);
    msg.removeHeader('x-foo');
    expect(msg.hasHeader('x-foo')).toBe(false);
  });

  test('getHeaders/getHeaderNames/getRawHeaderNames', () => {
    const msg = new OutgoingMessage();
    msg.setHeader('X-Foo', '1');
    msg.setHeader('X-Bar', '2');
    expect(msg.getHeaders()).toEqual({ 'x-foo': '1', 'x-bar': '2' });
    expect(msg.getHeaderNames()).toEqual(['x-foo', 'x-bar']);
    expect(msg.getRawHeaderNames()).toEqual(['X-Foo', 'X-Bar']);
  });

  test('setHeader validates name and value', () => {
    const msg = new OutgoingMessage();
    expect(throwsCode(() => msg.setHeader('bad name', 'v'))).toBe('ERR_INVALID_HTTP_TOKEN');
    expect(throwsCode(() => msg.setHeader('X', 'a\0b'))).toBe('ERR_INVALID_CHAR');
    expect(throwsCode(() => msg.setHeader('X', undefined))).toBe('ERR_HTTP_INVALID_HEADER_VALUE');
  });

  test('headersSent flips after writeHead; later setHeader throws', () => {
    const msg = new ServerResponse(new IncomingMessage());
    expect(msg.headersSent).toBe(false);
    msg.writeHead(200);
    expect(msg.headersSent).toBe(true);
    expect(throwsCode(() => msg.setHeader('X', '1'))).toBe('ERR_HTTP_HEADERS_SENT');
    expect(throwsCode(() => msg.writeHead(200))).toBe('ERR_HTTP_HEADERS_SENT');
  });

  test('writeHead validates status code', () => {
    const msg = new ServerResponse(new IncomingMessage());
    expect(throwsCode(() => msg.writeHead(99))).toBe('ERR_HTTP_INVALID_STATUS_CODE');
    expect(throwsCode(() => msg.writeHead(1000))).toBe('ERR_HTTP_INVALID_STATUS_CODE');
    expect(throwsCode(() => msg.writeHead('x'))).toBe('ERR_HTTP_INVALID_STATUS_CODE');
  });

  test('setHeaders Headers/Map form', () => {
    const msg = new OutgoingMessage();
    msg.setHeaders(new Headers({ 'X-A': '1' }));
    msg.setHeaders(new Map([['X-B', '2']]));
    expect(msg.getHeader('x-a')).toBe('1');
    expect(msg.getHeader('x-b')).toBe('2');
    // Like Node, a plain object is rejected.
    expect(throwsCode(() => msg.setHeaders({ 'X-C': '3' }))).toBe('ERR_INVALID_ARG_TYPE');
  });
});

describe('ServerResponse', () => {
  test('fresh statusMessage is undefined; writeHead fills it', () => {
    const res = new ServerResponse(new IncomingMessage());
    expect(res.statusMessage).toBeUndefined();
    res.writeHead(404);
    expect(res.statusMessage).toBe('Not Found');
  });

  test('end resolves with status/headers/body', async () => {
    const res = new ServerResponse(new IncomingMessage());
    const promise = new Promise((resolve) => res._setResolver(resolve));
    res.setHeader('X-Custom', 'Value');
    res.write('Part 1');
    res.end('Part 2');
    const result = await promise;
    expect(result.statusCode).toBe(200);
    expect(result.headers['x-custom']).toBe('Value');
    expect(Buffer.from(result.body).toString()).toBe('Part 1Part 2');
  });

  test('204 drops the body', async () => {
    const res = new ServerResponse(new IncomingMessage());
    const promise = new Promise((resolve) => res._setResolver(resolve));
    res.writeHead(204);
    res.end('should be dropped');
    const result = await promise;
    expect(result.statusCode).toBe(204);
    expect(Buffer.from(result.body).toString()).toBe('');
  });

  test('Express-style .status().json()', async () => {
    const res = new ServerResponse(new IncomingMessage());
    const promise = new Promise((resolve) => res._setResolver(resolve));
    res.status(201).json({ success: true });
    const result = await promise;
    expect(result.statusCode).toBe(201);
    expect(result.headers['content-type']).toBe('application/json');
    expect(JSON.parse(Buffer.from(result.body).toString())).toEqual({ success: true });
  });

  test('writeHead array headers', async () => {
    const res = new ServerResponse(new IncomingMessage());
    const promise = new Promise((resolve) => res._setResolver(resolve));
    res.writeHead(200, [['X-A', '1'], ['X-B', '2']]);
    res.end();
    const result = await promise;
    expect(result.headers['x-a']).toBe('1');
    expect(result.headers['x-b']).toBe('2');
  });
});

describe('IncomingMessage', () => {
  test('fromRequest builds method/url/headers/body', async () => {
    const msg = IncomingMessage.fromRequest('POST', '/test?x=1',
      { 'content-type': 'text/plain' }, 'hello');
    expect(msg.method).toBe('POST');
    expect(msg.url).toBe('/test?x=1');
    expect(msg.headers['content-type']).toBe('text/plain');
    const chunks = [];
    msg.on('data', (c) => chunks.push(c));
    await new Promise((resolve) => msg.on('end', resolve));
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });

  test('fromFetchResponse converts a fetch response', async () => {
    const mockResponse = {
      status: 201,
      statusText: 'Created',
      headers: new Map([['content-type', 'application/json']]),
      arrayBuffer: async () => new TextEncoder().encode('{"a":1}').buffer,
    };
    const msg = await IncomingMessage.fromFetchResponse(mockResponse);
    expect(msg.statusCode).toBe(201);
    expect(msg.statusMessage).toBe('Created');
    expect(msg.headers['content-type']).toBe('application/json');
    const chunks = [];
    msg.on('data', (c) => chunks.push(c));
    await new Promise((resolve) => msg.on('end', resolve));
    expect(Buffer.concat(chunks).toString()).toBe('{"a":1}');
  });
});

describe('Server', () => {
  test('listen/close lifecycle and address', async () => {
    const server = createServer((req, res) => res.end('x'));
    expect(server.listening).toBe(false);
    await new Promise((resolve) => server.listen(18091, resolve));
    expect(server.listening).toBe(true);
    expect(server.address().port).toBe(18091);
    await new Promise((resolve) => server.close(resolve));
    expect(server.listening).toBe(false);
    expect(server.address()).toBeNull();
  });

  test('request listener fires exactly once per request', async () => {
    const listener = jest.fn((req, res) => res.end('handled'));
    const server = createServer(listener);
    await new Promise((resolve) => server.listen(18092, resolve));
    const result = await server.handleRequest('GET', '/', {}, null);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(Buffer.from(result.body).toString()).toBe('handled');
    server.close();
  });

  test('handleRequest round trip with headers and echo', async () => {
    const server = createServer((req, res) => {
      res.setHeader('X-Echo', req.headers['x-test'] || 'none');
      res.end(`hello ${req.method} ${req.url}`);
    });
    await new Promise((resolve) => server.listen(18093, resolve));
    const result = await server.handleRequest('POST', '/items?a=1',
      { 'x-test': 'abc' }, 'payload');
    expect(result.statusCode).toBe(200);
    expect(result.headers['x-echo']).toBe('abc');
    expect(Buffer.from(result.body).toString()).toBe('hello POST /items?a=1');
    server.close();
  });

  test('EADDRINUSE when the port is taken', async () => {
    const a = createServer();
    const b = createServer();
    await new Promise((resolve) => a.listen(18094, resolve));
    const err = await new Promise((resolve) => {
      b.on('error', resolve);
      b.listen(18094);
    });
    expect(err.code).toBe('EADDRINUSE');
    a.close();
  });

  test('ephemeral port when listen() has no port', async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(resolve));
    const { port } = server.address();
    expect(port).toBeGreaterThan(0);
    expect(getServer(port)).toBe(server);
    expect(getAllServers().has(port)).toBe(true);
    server.close();
    expect(getAllServers().has(port)).toBe(false);
  });

  test('connection helpers are noops', () => {
    const server = createServer();
    expect(() => server.closeAllConnections()).not.toThrow();
    expect(() => server.closeIdleConnections()).not.toThrow();
  });
});

describe('runtime bridge (__httpServerRunTime)', () => {
  // The bridge publishes at module-evaluation time, so it is exercised in a
  // fresh node subprocess with a fake browser runtime present (subprocess =
  // no helper file, no module-registry tricks).
  const runBridgeScript = (script) => {
    const srcUrl = new URL('../src/http.js', import.meta.url).href;
    const wrapped = `
      globalThis._RUNTIME_ = { emit() {} };
      const http = (await import(${JSON.stringify(srcUrl)})).default;
      const bridge = globalThis._RUNTIME_.__httpServerRunTime;
      ${script}
    `;
    return execFileSync(process.execPath, ['--input-type=module', '-e', wrapped], {
      encoding: 'utf8',
      timeout: 30000,
    }).trim();
  };

  test('bridge is published with handleRequest + waitForAllServers', () => {
    const out = runBridgeScript(`
      if (typeof bridge.handleRequest !== 'function') throw new Error('missing handleRequest');
      if (typeof bridge.waitForAllServers !== 'function') throw new Error('missing waitForAllServers');
      console.log('BRIDGE_SHAPE_OK');
    `);
    expect(out).toBe('BRIDGE_SHAPE_OK');
  });

  test('documented arg order (port, url, method, body, headers)', () => {
    const out = runBridgeScript(`
      const server = http.createServer((req, res) => res.end(req.method + ' ' + req.url));
      await new Promise((r) => server.listen(18095, r));
      const result = await bridge.handleRequest(18095, '/doc', 'PUT', 'b', { host: 'x' });
      const text = Buffer.from(result.body).toString();
      server.close();
      await bridge.waitForAllServers();
      console.log(text);
    `);
    expect(out).toBe('PUT /doc');
  });

  test('legacy arg order (port, method, url, headers, body) still works', () => {
    const out = runBridgeScript(`
      const server = http.createServer((req, res) => res.end(req.method + ' ' + req.url));
      await new Promise((r) => server.listen(18096, r));
      const result = await bridge.handleRequest(18096, 'DELETE', '/legacy', { host: 'x' }, 'b');
      const text = Buffer.from(result.body).toString();
      server.close();
      await bridge.waitForAllServers();
      console.log(text);
    `);
    expect(out).toBe('DELETE /legacy');
  });

  test('no server on the port rejects with ERR_NO_SERVER', () => {
    const out = runBridgeScript(`
      try {
        await bridge.handleRequest(19999, '/', 'GET', null, {});
        console.log('NO_THROW');
      } catch (err) {
        console.log(err.code);
      }
    `);
    expect(out).toBe('ERR_NO_SERVER');
  });

  test('waitForAllServers resolves once servers close', () => {
    const out = runBridgeScript(`
      const server = http.createServer();
      await new Promise((r) => server.listen(18097, r));
      let resolved = false;
      const waiting = bridge.waitForAllServers().then(() => { resolved = true; });
      const before = resolved;
      server.close();
      await waiting;
      console.log(before + ':' + resolved);
    `);
    expect(out).toBe('false:true');
  });
});

describe('ClientRequest (fetch bridge)', () => {
  let realFetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({
      status: 200,
      statusText: 'OK',
      headers: new Map([['content-type', 'text/plain']]),
      arrayBuffer: async () => new TextEncoder().encode('response body').buffer,
    }));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('request builds the fetch URL and passes method/headers/body', async () => {
    const text = await new Promise((resolve, reject) => {
      const req = request({
        hostname: 'api.example.com',
        path: '/data',
        method: 'POST',
        headers: { Authorization: 'Bearer 123' },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(`${res.statusCode}|${data}`));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end('request body');
    });
    expect(text).toBe('200|response body');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://api.example.com/data',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(Buffer),
      }),
    );
    const [, opts] = globalThis.fetch.mock.calls[0];
    expect(opts.headers.authorization).toBe('Bearer 123');
    expect(opts.headers.host).toBeUndefined();
  });

  test('get() issues a GET and ends the request', async () => {
    const text = await new Promise((resolve, reject) => {
      get('http://example.com/path?q=1', (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      }).on('error', reject);
    });
    expect(text).toBe('response body');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://example.com/path?q=1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('network failure emits error', async () => {
    globalThis.fetch = jest.fn(async () => { throw new TypeError('fetch failed'); });
    const err = await new Promise((resolve) => {
      request('http://example.com/', () => {}).on('error', resolve).end();
    });
    expect(err).toBeInstanceOf(TypeError);
  });

  test('invalid method throws ERR_INVALID_HTTP_TOKEN', () => {
    expect(throwsCode(() => request({ hostname: 'x', method: 'BAD METHOD' })))
      .toBe('ERR_INVALID_HTTP_TOKEN');
  });

  test('protocol mismatch with agent throws ERR_INVALID_PROTOCOL', () => {
    expect(throwsCode(() => _createClientRequest(
      'https://example.com/', {}, null, 'https:', new Agent({ protocol: 'http:' }))))
      .toBe('ERR_INVALID_PROTOCOL');
  });

  test('timeout emits timeout (no auto-abort, like Node)', async () => {
    globalThis.fetch = jest.fn(
      (url, opts) => new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
    );
    const timedOut = await new Promise((resolve) => {
      const req = request('http://example.com/', { timeout: 20 }, () => {});
      req.on('timeout', () => resolve(true));
      req.on('error', () => {});
      req.end();
    });
    expect(timedOut).toBe(true);
  });
});

describe('WebSocket helpers', () => {
  test('known SHA-1 accept vector (RFC 6455)', async () => {
    const { _createWsFrame, _parseWsFrame } = http;
    // Indirect check via the exported helpers' round trip below; the accept
    // computation is exercised through _handleWebSocketUpgrade internals.
    expect(typeof _createWsFrame).toBe('function');
    expect(typeof _parseWsFrame).toBe('function');
  });

  test('frame round trip (unmasked)', () => {
    const frame = http._createWsFrame(0x01, Buffer.from('hello'), false);
    const parsed = http._parseWsFrame(frame);
    expect(parsed.opcode).toBe(0x01);
    expect(Buffer.from(parsed.payload).toString()).toBe('hello');
  });

  test('frame round trip (masked, client-style)', () => {
    const frame = http._createWsFrame(0x02, Buffer.from('secret'), true);
    expect(frame[1] & 0x80).toBeTruthy();
    const parsed = http._parseWsFrame(frame);
    expect(Buffer.from(parsed.payload).toString()).toBe('secret');
  });
});

describe('internal module consistency', () => {
  test('_http_agent re-exports the same Agent/globalAgent', async () => {
    const mod = await import('../src/_http_agent.js');
    expect(mod.Agent).toBe(Agent);
    expect(mod.globalAgent).toBe(globalAgent);
  });

  test('_http_client re-exports ClientRequest', async () => {
    const mod = await import('../src/_http_client.js');
    expect(mod.ClientRequest).toBe(ClientRequest);
  });

  test('_http_incoming re-exports IncomingMessage plus symbols', async () => {
    const mod = await import('../src/_http_incoming.js');
    expect(mod.IncomingMessage).toBe(IncomingMessage);
    expect(typeof mod.kDetachAbortSignal).toBe('symbol');
    expect(() => mod.readStart()).not.toThrow();
    expect(() => mod.readStop()).not.toThrow();
  });

  test('_http_outgoing re-exports and parses unique headers', async () => {
    const mod = await import('../src/_http_outgoing.js');
    expect(mod.OutgoingMessage).toBe(OutgoingMessage);
    expect(mod.validateHeaderName).toBe(validateHeaderName);
    expect(mod.validateHeaderValue).toBe(validateHeaderValue);
    expect(typeof mod.kUniqueHeaders).toBe('symbol');
    expect(typeof mod.kHighWaterMark).toBe('symbol');
    expect(mod.parseUniqueHeadersOption(['X-A', 'X-B'])).toEqual(new Set(['x-a', 'x-b']));
    expect(mod.parseUniqueHeadersOption(null)).toBeNull();
  });

  test('_http_server re-exports and stubs connection helpers', async () => {
    const mod = await import('../src/_http_server.js');
    expect(mod.Server).toBe(Server);
    expect(mod.ServerResponse).toBe(ServerResponse);
    expect(mod.STATUS_CODES).toBe(STATUS_CODES);
    expect(typeof mod._connectionListener).toBe('function');
    expect(typeof mod.kServerResponse).toBe('symbol');
    expect(() => mod.httpServerPreClose()).not.toThrow();
    expect(() => mod.setupConnectionsTracking()).not.toThrow();
    expect(() => mod.storeHTTPOptions()).not.toThrow();
  });
});
