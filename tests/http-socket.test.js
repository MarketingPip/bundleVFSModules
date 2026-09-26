// Repo tests for the phase-1 network round trip: real virtual-socket HTTP.
// src/_http_parser.js unit tests + http.Server over src/net.js connections,
// driven with raw HTTP bytes through net.connect().
import { HTTPParser } from '../src/_http_parser.js';
import { createServer } from '../src/http.js';
import { connect as netConnect } from '../src/net.js';
import { describe, test, expect, afterEach } from '@jest/globals';

const servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise((resolve) => s.close(resolve));
  }
});

function listenAsync(server, ...args) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(...args, () => resolve(server.address()));
  });
}

/** Drive one raw HTTP exchange over a fresh virtual connection. */
function rawExchange(port, head, bodyChunks = []) {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port);
    const chunks = [];
    let headText = null;
    let body = Buffer.alloc(0);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ headText, body, socket: sock });
    };
    sock.on('error', reject);
    sock.on('data', (c) => {
      chunks.push(c);
      const all = Buffer.concat(chunks).toString('latin1');
      const idx = all.indexOf('\r\n\r\n');
      if (idx >= 0 && headText === null) {
        headText = all.slice(0, idx);
        const after = Buffer.from(all.slice(idx + 4), 'latin1');
        // Frame the body via Content-Length when present.
        const m = /^content-length:\s*(\d+)$/im.exec(headText);
        if (m) {
          const n = Number(m[1]);
          if (after.length >= n) {
            body = after.subarray(0, n);
            sock.end();
          } else {
            body = after; // wait for the rest
          }
        } else {
          body = after;
        }
      } else if (headText !== null) {
        const m = /^content-length:\s*(\d+)$/im.exec(headText);
        if (m) {
          body = Buffer.concat([body, c]);
          if (body.length >= Number(m[1])) {
            body = body.subarray(0, Number(m[1]));
            sock.end();
          }
        } else {
          // No framing header (e.g. chunked or close-delimited): accumulate
          // until the server ends the connection.
          body = Buffer.concat([body, c]);
        }
      }
    });
    sock.on('end', finish);
    sock.on('close', finish);
    sock.on('connect', () => {
      sock.write(head);
      for (const b of bodyChunks) sock.write(b);
    });
    setTimeout(() => reject(new Error('rawExchange timed out')), 5000).unref?.();
  });
}

function parseRequest(port, rawHead) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const seen = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawHeaders: req.rawHeaders,
        httpVersion: req.httpVersion,
        remoteAddress: req.socket.remoteAddress,
        remotePort: req.socket.remotePort,
        bytesRead: req.socket.bytesRead,
        sameSocket: req.socket === res.socket,
        isNetSocket: typeof req.socket.write === 'function' &&
          req.socket.constructor.name === 'Socket',
      };
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        seen.body = body;
        res.end('ok');
      });
      server._seen = seen;
    });
    servers.push(server);
    listenAsync(server, 0).then(({ port: p }) => {
      const sock = netConnect(p);
      sock.on('error', reject);
      sock.on('connect', () => sock.write(rawHead));
      const chunks = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => {
        sock.destroy();
        resolve({ seen: server._seen, raw: Buffer.concat(chunks).toString('latin1') });
      });
      setTimeout(() => reject(new Error('timed out')), 5000).unref?.();
    }, reject);
  });
}

// ---------------------------------------------------------------------------
// HTTPParser unit tests
// ---------------------------------------------------------------------------

describe('HTTPParser', () => {
  function drive(type, writes, opts = {}) {
    const p = new HTTPParser(type);
    if (opts.isHeadResponse) p.isHeadResponse = true;
    const events = [];
    p.onHeadersComplete = (i) => events.push(['headers', i]);
    p.onBody = (c) => events.push(['body', c.toString()]);
    p.onMessageComplete = () => events.push(['complete']);
    p.onError = (e) => events.push(['error', e.code]);
    for (const w of writes) p.execute(Buffer.from(w));
    if (opts.end) p.end();
    return { events, parser: p };
  }

  test('request line split across writes', () => {
    const { events } = drive('request', ['GET /he', 'llo HTTP/1.1\r\nHost: x\r\n\r\n']);
    expect(events[0][0]).toBe('headers');
    expect(events[0][1].method).toBe('GET');
    expect(events[0][1].url).toBe('/hello');
    expect(events[1][0]).toBe('complete');
  });

  test('content-length body streams incrementally', () => {
    const { events } = drive('request', [
      'POST /p HTTP/1.1\r\nContent-Length: 10\r\n\r\nabc',
      'def',
      'ghij',
    ]);
    expect(events.map((e) => e[0])).toEqual(['headers', 'body', 'body', 'body', 'complete']);
    expect(events.slice(1, 4).map((e) => e[1]).join('')).toBe('abcdefghij');
  });

  test('chunked body with extension ignored', () => {
    const { events } = drive('request', [
      'POST /p HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n',
      '5;ext=1\r\nhello\r\n3\r\nbye\r\n0\r\n\r\n',
    ]);
    expect(events.map((e) => e[0])).toEqual(['headers', 'body', 'body', 'complete']);
    expect(events[1][1] + events[2][1]).toBe('hellobye');
  });

  test('pipelined requests parse back-to-back', () => {
    const { events } = drive('request', ['GET /a HTTP/1.1\r\n\r\nGET /b HTTP/1.1\r\n\r\n']);
    expect(events.map((e) => e[0])).toEqual(
      ['headers', 'complete', 'headers', 'complete']);
    expect(events[0][1].url).toBe('/a');
    expect(events[2][1].url).toBe('/b');
  });

  test('keep-alive detection', () => {
    const h11 = drive('request', ['GET /a HTTP/1.1\r\n\r\n']).events[0][1];
    const h11close = drive('request', ['GET /a HTTP/1.1\r\nConnection: close\r\n\r\n']).events[0][1];
    const h10 = drive('request', ['GET /a HTTP/1.0\r\n\r\n']).events[0][1];
    const h10ka = drive('request', ['GET /a HTTP/1.0\r\nConnection: keep-alive\r\n\r\n']).events[0][1];
    expect(h11.shouldKeepAlive).toBe(true);
    expect(h11close.shouldKeepAlive).toBe(false);
    expect(h10.shouldKeepAlive).toBe(false);
    expect(h10ka.shouldKeepAlive).toBe(true);
  });

  test('duplicate headers join; set-cookie stays array', () => {
    const { events } = drive('request', [
      'GET /a HTTP/1.1\r\nX-A: 1\r\nX-A: 2\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n',
    ]);
    const h = events[0][1];
    expect(h.headers['x-a']).toBe('1, 2');
    expect(h.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(h.rawHeaders).toEqual(
      ['X-A', '1', 'X-A', '2', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2']);
  });

  test('bad method -> HPE_INVALID_METHOD', () => {
    const { events } = drive('request', ['GE T /x HTTP/1.1\r\n\r\n']);
    expect(events[0]).toEqual(['error', 'HPE_INVALID_METHOD']);
  });

  test('bad version -> HPE_INVALID_VERSION', () => {
    const { events } = drive('request', ['GET /x HTTP/2.0\r\n\r\n']);
    expect(events[0]).toEqual(['error', 'HPE_INVALID_VERSION']);
  });

  test('obs-fold -> HPE_INVALID_HEADER', () => {
    const { events } = drive('request', ['GET /x HTTP/1.1\r\nA: 1\r\n folded\r\n\r\n']);
    expect(events[0]).toEqual(['error', 'HPE_INVALID_HEADER']);
  });

  test('conflicting content-lengths -> HPE_INVALID_CONTENT_LENGTH', () => {
    const { events } = drive('request', [
      'GET /x HTTP/1.1\r\nContent-Length: 5\r\nContent-Length: 6\r\n\r\n',
    ]);
    expect(events[0]).toEqual(['error', 'HPE_INVALID_CONTENT_LENGTH']);
  });

  test('header overflow -> HPE_HEADER_OVERFLOW', () => {
    const { events, parser } = drive('request', ['GET /x HTTP/1.1\r\n']);
    parser.maxHeaderSize = 32;
    parser.execute(Buffer.from(`X-Pad: ${'a'.repeat(64)}\r\n\r\n`));
    expect(events[events.length - 1]).toEqual(['error', 'HPE_HEADER_OVERFLOW']);
  });

  test('response: status line + chunked body', () => {
    const { events } = drive('response', [
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n0\r\n\r\n',
    ]);
    expect(events[0][1].statusCode).toBe(200);
    expect(events[0][1].statusMessage).toBe('OK');
    expect(events[1]).toEqual(['body', 'Wiki']);
    expect(events[2][0]).toBe('complete');
  });

  test('response: body runs to EOF when unframed', () => {
    const { events } = drive('response', ['HTTP/1.1 200 OK\r\n\r\nhel', 'lo'], { end: true });
    expect(events.map((e) => e[0])).toEqual(['headers', 'body', 'body', 'complete']);
  });

  test('response: 204 and HEAD have no body', () => {
    const r204 = drive('response', ['HTTP/1.1 204 No Content\r\n\r\n'], { end: true });
    expect(r204.events.map((e) => e[0])).toEqual(['headers', 'complete']);
    // Trailing bytes after a bodiless message are NOT body: they start the
    // next message, so end() mid-line is a truncation error.
    const r204x = drive('response', ['HTTP/1.1 204 No Content\r\n\r\nxx'], { end: true });
    expect(r204x.events.map((e) => e[0])).toEqual(['headers', 'complete', 'error']);
    expect(r204x.events[2][1]).toBe('HPE_TRUNCATED');
    const rHead = drive('response', ['HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n'], { end: true, isHeadResponse: true });
    expect(rHead.events.map((e) => e[0])).toEqual(['headers', 'complete']);
  });
});

// ---------------------------------------------------------------------------
// Server over real virtual sockets
// ---------------------------------------------------------------------------

describe('http.Server socket round trip', () => {
  test('GET: real req.socket with addresses, byte counts, framed response', async () => {
    const { seen, raw } = await parseRequest(0,
      'GET /hello?name=x HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    expect(seen.method).toBe('GET');
    expect(seen.url).toBe('/hello?name=x');
    expect(seen.httpVersion).toBe('1.1');
    expect(seen.remoteAddress).toBe('127.0.0.1');
    expect(seen.remotePort).toBeGreaterThan(0);
    expect(seen.bytesRead).toBeGreaterThan(0);
    expect(seen.sameSocket).toBe(true);
    expect(seen.isNetSocket).toBe(true);
    expect(raw).toMatch(/^HTTP\/1.1 200 OK\r\n/);
    expect(raw).toContain('Content-Length: 2');
    expect(raw.endsWith('ok')).toBe(true);
  });

  test("'connection' event fires with the real socket", async () => {
    const server = createServer((req, res) => res.end('x'));
    servers.push(server);
    const conns = [];
    server.on('connection', (s) => conns.push(s));
    const { port } = await listenAsync(server, 0);
    await rawExchange(port, 'GET / HTTP/1.1\r\nConnection: close\r\n\r\n');
    expect(conns).toHaveLength(1);
    expect(conns[0].remoteAddress).toBe('127.0.0.1');
  });

  test('getConnections tracks live sockets', async () => {
    const server = createServer((req, res) => {
      server.getConnections((err, n) => {
        expect(err).toBeNull();
        expect(n).toBe(1);
        res.end('x');
      });
    });
    servers.push(server);
    const { port } = await listenAsync(server, 0);
    const countBefore = await new Promise((r) => server.getConnections((e, n) => r(n)));
    expect(countBefore).toBe(0);
    await rawExchange(port, 'GET / HTTP/1.1\r\nConnection: close\r\n\r\n');
    // let the close propagate
    await new Promise((r) => setTimeout(r, 50));
    const countAfter = await new Promise((r) => server.getConnections((e, n) => r(n)));
    expect(countAfter).toBe(0);
  });

  test('pipelined requests in one write are served strictly in order', async () => {
    const urls = [];
    const server = createServer((req, res) => {
      urls.push(req.url);
      // Respond asynchronously so both requests are definitely in flight
      // back-to-back; the server must still serialize them 1, 2.
      setTimeout(() => res.end(`u=${req.url}`), 10).unref?.();
    });
    servers.push(server);
    const { port } = await listenAsync(server, 0);
    const text = await new Promise((resolve, reject) => {
      const sock = netConnect(port);
      const chunks = [];
      sock.on('error', reject);
      sock.on('connect', () => {
        // Both requests in a single write: no waiting for response 1.
        sock.write(
          'GET /1 HTTP/1.1\r\nHost: x\r\n\r\n' +
          'GET /2 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'
        );
      });
      sock.on('data', (c) => chunks.push(c));
      sock.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
      setTimeout(() => reject(new Error('timed out')), 5000).unref?.();
    });
    expect(urls).toEqual(['/1', '/2']);
    const bodies = [...text.matchAll(/u=(\/\d)/g)].map((m) => m[1]);
    expect(bodies).toEqual(['/1', '/2']); // responses in request order
  });

  test('keep-alive serves sequential requests on one connection', async () => {
    const seenSockets = [];
    const server = createServer((req, res) => {
      seenSockets.push(req.socket);
      res.end(`n=${seenSockets.length}`);
    });
    servers.push(server);
    const { port } = await listenAsync(server, 0);
    const sock = netConnect(port);
    await new Promise((resolve, reject) => {
      const chunks = [];
      let responses = 0;
      sock.on('error', reject);
      sock.on('connect', () => sock.write('GET /1 HTTP/1.1\r\nHost: x\r\n\r\n'));
      sock.on('data', (c) => {
        chunks.push(c);
        const text = Buffer.concat(chunks).toString('latin1');
        const matches = text.match(/n=\d/g) || [];
        if (matches.length === 1 && responses === 0) {
          responses = 1;
          sock.write('GET /2 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
        } else if (matches.length === 2) {
          sock.end();
        }
      });
      sock.on('close', resolve);
      setTimeout(() => reject(new Error('timed out')), 5000).unref?.();
    });
    expect(seenSockets).toHaveLength(2);
    expect(seenSockets[0]).toBe(seenSockets[1]); // same connection
    const n = await new Promise((r) => server.getConnections((e, x) => r(x)));
    expect(n).toBe(0);
  });

  test('POST content-length body streams to the handler', async () => {
    const { seen } = await parseRequest(0,
      'POST /echo HTTP/1.1\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhello world');
    expect(seen.method).toBe('POST');
    expect(seen.body).toBe('hello world');
  });

  test('POST chunked body streams to the handler', async () => {
    const { seen } = await parseRequest(0,
      'POST /echo HTTP/1.1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n');
    expect(seen.body).toBe('hello world');
  });

  test('100-continue is acknowledged before the body', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => res.end(body));
    });
    servers.push(server);
    const { port } = await listenAsync(server, 0);
    const text = await new Promise((resolve, reject) => {
      const sock = netConnect(port);
      const chunks = [];
      let bodySent = false;
      sock.on('error', reject);
      sock.on('connect', () => {
        sock.write('POST /c HTTP/1.1\r\nContent-Length: 3\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n');
      });
      sock.on('data', (c) => {
        chunks.push(c);
        const t = Buffer.concat(chunks).toString('latin1');
        // Protocol order: the body goes out exactly once, after the interim.
        if (!bodySent && t.includes('100 Continue')) {
          bodySent = true;
          sock.write('abc');
        }
      });
      // Connection: close ends the socket after the full response.
      sock.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
      setTimeout(() => reject(new Error('timed out')), 5000).unref?.();
    });
    expect(text).toMatch(/^HTTP\/1\.1 100 Continue\r\n\r\n/);
    expect(text).toContain('200 OK');
    // The final response echoes the body that followed the interim ack.
    expect(text.slice(text.indexOf('200 OK'))).toContain('abc');
  });

  test('malformed request -> 400 and clientError', async () => {
    const server = createServer((req, res) => res.end('never'));
    servers.push(server);
    const clientErrors = [];
    server.on('clientError', (err) => clientErrors.push(err.code));
    const { port } = await listenAsync(server, 0);
    const { headText } = await rawExchange(port, 'NOT A REQUEST\r\n\r\n');
    expect(headText).toMatch(/^HTTP\/1.1 400/);
    // llhttp validates against known methods: 'NOT' is not one (verified
    // against real node:http).
    expect(clientErrors).toEqual(['HPE_INVALID_METHOD']);
  });

  test('closeAllConnections destroys live sockets', async () => {
    const server = createServer((req, res) => {
      // never respond: connection stays busy
    });
    servers.push(server);
    const { port } = await listenAsync(server, 0);
    const sock = netConnect(port);
    await new Promise((resolve, reject) => {
      sock.on('error', reject);
      sock.on('connect', () => sock.write('GET /hang HTTP/1.1\r\n\r\n'));
      setTimeout(resolve, 100).unref?.();
    });
    const n1 = await new Promise((r) => server.getConnections((e, x) => r(x)));
    expect(n1).toBe(1);
    const closed = new Promise((r) => sock.on('close', r));
    server.closeAllConnections();
    await closed;
    await new Promise((r) => setTimeout(r, 50));
    const n2 = await new Promise((r) => server.getConnections((e, x) => r(x)));
    expect(n2).toBe(0);
  });

  test('closeIdleConnections keeps busy, drops idle', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/hang') return; // stay busy
      res.end('quick');
    });
    servers.push(server);
    const { port } = await listenAsync(server, 0);
    // busy connection
    const busySock = netConnect(port);
    await new Promise((resolve, reject) => {
      busySock.on('error', reject);
      busySock.on('connect', () => busySock.write('GET /hang HTTP/1.1\r\n\r\n'));
      setTimeout(resolve, 100).unref?.();
    });
    // idle keep-alive connection
    const idleSock = netConnect(port);
    await new Promise((resolve, reject) => {
      idleSock.on('error', reject);
      idleSock.on('connect', () => idleSock.write('GET /quick HTTP/1.1\r\n\r\n'));
      const chunks = [];
      idleSock.on('data', (c) => {
        chunks.push(c);
        if (/quick/.test(Buffer.concat(chunks).toString())) resolve();
      });
      setTimeout(() => reject(new Error('timed out')), 5000).unref?.();
    });
    const idleClosed = new Promise((r) => idleSock.on('close', r));
    let busyClosed = false;
    busySock.on('close', () => { busyClosed = true; });
    server.closeIdleConnections();
    await idleClosed;
    await new Promise((r) => setTimeout(r, 100));
    expect(busyClosed).toBe(false);
    const n = await new Promise((r) => server.getConnections((e, x) => r(x)));
    expect(n).toBe(1);
    busySock.destroy();
  });

  test('maxRequestsPerSocket closes after the limit', async () => {
    const sockets = new Set();
    const server = createServer({ maxRequestsPerSocket: 1 }, (req, res) => {
      sockets.add(req.socket);
      res.end('x');
    });
    servers.push(server);
    const { port } = await listenAsync(server, 0);
    const sock = netConnect(port);
    await new Promise((resolve, reject) => {
      let phase = 0;
      const chunks = [];
      sock.on('error', reject);
      sock.on('connect', () => sock.write('GET /1 HTTP/1.1\r\n\r\n'));
      sock.on('data', (c) => {
        chunks.push(c);
        if (phase === 0 && /x/.test(Buffer.concat(chunks).toString())) {
          phase = 1;
          // server should have closed (max 1); second request needs a new socket
          const sock2 = netConnect(port);
          sock2.on('error', reject);
          sock2.on('connect', () => sock2.write('GET /2 HTTP/1.1\r\nConnection: close\r\n\r\n'));
          const c2 = [];
          sock2.on('data', (d) => c2.push(d));
          sock2.on('close', () => resolve());
        }
      });
      sock.on('close', () => { if (phase === 0) resolve(); });
      setTimeout(() => reject(new Error('timed out')), 5000).unref?.();
    });
    expect(sockets.size).toBe(2); // two distinct connections
  });

  test('HEAD: content-length present, no body bytes', async () => {
    const server = createServer((req, res) => res.end('hello'));
    servers.push(server);
    const { port } = await listenAsync(server, 0);
    const { headText, body } = await rawExchange(port,
      'HEAD /h HTTP/1.1\r\nConnection: close\r\n\r\n');
    expect(headText).toContain('Content-Length: 5');
    expect(body.length).toBe(0);
  });

  test('explicit transfer-encoding: chunked response is chunk-framed', async () => {
    const server = createServer((req, res) => {
      res.setHeader('Transfer-Encoding', 'chunked');
      res.end('hi');
    });
    servers.push(server);
    const { port } = await listenAsync(server, 0);
    const { headText, body } = await rawExchange(port,
      'GET /c HTTP/1.1\r\nConnection: close\r\n\r\n');
    expect(headText).toMatch(/transfer-encoding:\s*chunked/i);
    expect(body.toString()).toBe('2\r\nhi\r\n0\r\n\r\n');
  });
});
