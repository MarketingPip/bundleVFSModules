// tests/net.test.js — repo tests for src/net.js (Node v24.20.0 port).
//
// Every assertion below was verified against real `node:net` on 2026-09-22
// before being encoded here. Transport behavior runs over the module's
// virtual in-process network (browsers cannot open raw TCP); failure modes
// mirror Node's shapes (ECONNREFUSED/ENOENT/ENOTFOUND, close(hadError)).

import * as net from '../src/net.js';
import { Socket, Server, BlockList, SocketAddress } from '../src/net.js';
import { describe, test, expect, afterEach } from '@jest/globals';

const { createServer, createConnection, connect } = net;

// Track servers/sockets so no ref'd loop-keeper timer leaks between tests.
const liveServers = new Set();
const liveSockets = new Set();
function trackServer(sv) { liveServers.add(sv); return sv; }
function trackSocket(s) { liveSockets.add(s); return s; }
afterEach(async () => {
  for (const s of liveSockets) { try { s.destroy(); } catch { /* ignore */ } }
  liveSockets.clear();
  await Promise.all([...liveServers].map((sv) => new Promise((res) => {
    try { sv.close(() => res()); } catch { res(); }
    setTimeout(res, 500).unref?.();
  })));
  liveServers.clear();
});

function listenAsync(sv, ...args) {
  return new Promise((resolve, reject) => {
    sv.on('error', reject);
    sv.listen(...args, () => resolve(sv.address()));
  });
}

describe('export surface', () => {
  test('exposes the full node:net export set', () => {
    const expected = [
      'BlockList', 'BoundSocket', 'Server', 'Socket', 'SocketAddress', 'Stream',
      '_createServerHandle', '_normalizeArgs',
      'connect', 'createConnection', 'createServer',
      'getDefaultAutoSelectFamily', 'getDefaultAutoSelectFamilyAttemptTimeout',
      'isIP', 'isIPv4', 'isIPv6',
      'setDefaultAutoSelectFamily', 'setDefaultAutoSelectFamilyAttemptTimeout',
    ];
    const missing = expected.filter((key) => typeof net[key] === 'undefined');
    expect(missing).toEqual([]);
  });

  test('Stream === Socket', () => {
    expect(net.Stream).toBe(net.Socket);
  });

  test('constructors work without new', () => {
    expect(Socket() instanceof Socket).toBe(true);
    expect(Server() instanceof Server).toBe(true);
    expect(createServer() instanceof Server).toBe(true);
    expect(new Socket() instanceof net.Stream).toBe(true);
  });
});

describe('isIP / isIPv4 / isIPv6', () => {
  const v4 = ['127.0.0.1', '0.0.0.0', '255.255.255.255', '192.168.1.1', '10.0.0.255'];
  const v6 = ['::1', '::', 'fe80::1', '2001:db8::1', '::ffff:127.0.0.1', 'fe80::1%eth0',
    '2001:0db8:85a3:0000:0000:8a2e:0370:7334'];
  const bad = ['256.1.1.1', '01.02.03.04', '12.34.56.078', '1.2.3', '1.2.3.4.5',
    '1::2::3', 'gggg::1', 'not-an-ip', '', '12345', '1.2.3.4:80'];

  test.each(v4)('isIP(%p) === 4', (ip) => {
    expect(net.isIP(ip)).toBe(4);
    expect(net.isIPv4(ip)).toBe(true);
    expect(net.isIPv6(ip)).toBe(false);
  });
  test.each(v6)('isIP(%p) === 6', (ip) => {
    expect(net.isIP(ip)).toBe(6);
    expect(net.isIPv6(ip)).toBe(true);
    expect(net.isIPv4(ip)).toBe(false);
  });
  test.each(bad)('isIP(%p) === 0', (ip) => {
    expect(net.isIP(ip)).toBe(0);
    expect(net.isIPv4(ip)).toBe(false);
    expect(net.isIPv6(ip)).toBe(false);
  });
});

describe('SocketAddress', () => {
  test('defaults', () => {
    const sa = new SocketAddress();
    expect(sa.toJSON()).toEqual({ address: '127.0.0.1', port: 0, family: 'ipv4', flowlabel: 0 });
    expect(sa.address).toBe('127.0.0.1');
    expect(sa.family).toBe('ipv4');
  });

  test('ipv6 requires explicit family', () => {
    expect(() => new SocketAddress({ address: '::1' })).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ADDRESS' }));
    const sa = new SocketAddress({ address: '::1', family: 'ipv6', port: 8080 });
    expect(sa.family).toBe('ipv6');
    expect(sa.address).toBe('::1');
    expect(sa.port).toBe(8080);
    expect(sa.flowlabel).toBe(0);
  });

  test('family mismatch throws', () => {
    expect(() => new SocketAddress({ address: '127.0.0.1', family: 'ipv6' })).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ADDRESS' }));
  });

  test('non-object options throw', () => {
    expect(() => new SocketAddress('x')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });

  test('canonicalizes ipv6', () => {
    const sa = new SocketAddress({ address: '2001:0db8:0000:0000:0000:0000:0000:0001', family: 'ipv6' });
    expect(sa.address).toBe('2001:db8::1');
  });
});

describe('BlockList', () => {
  test('add/check/rules ordering (newest first)', () => {
    const bl = new BlockList();
    bl.addAddress('10.0.0.5');
    bl.addSubnet('192.168.1.0', 24);
    bl.addRange('192.168.2.1', '192.168.2.10');
    expect(bl.rules).toEqual([
      'Range: IPv4 192.168.2.1-192.168.2.10',
      'Subnet: IPv4 192.168.1.0/24',
      'Address: IPv4 10.0.0.5',
    ]);
    expect(bl.check('10.0.0.5')).toBe(true);
    expect(bl.check('10.0.0.6')).toBe(false);
    expect(bl.check('192.168.1.200')).toBe(true);
    expect(bl.check('192.168.2.5')).toBe(true);
    expect(bl.check('192.168.2.11')).toBe(false);
  });

  test('check returns false for malformed input', () => {
    const bl = new BlockList();
    expect(bl.check('not-an-ip')).toBe(false);
    expect(bl.check('::1')).toBe(false); // default family is ipv4
    expect(bl.check('::1', 'ipv6')).toBe(false);
  });

  test('ipv6 rules', () => {
    const bl = new BlockList();
    bl.addAddress('::1', 'ipv6');
    bl.addSubnet('2001:db8::', 32, 'ipv6');
    expect(bl.check('::1', 'ipv6')).toBe(true);
    expect(bl.check('2001:db8::5', 'ipv6')).toBe(true);
    expect(bl.check('2001:db9::5', 'ipv6')).toBe(false);
    expect(bl.rules[0]).toBe('Subnet: IPv6 2001:db8::/32');
    expect(bl.rules[1]).toBe('Address: IPv6 ::1');
  });

  test('addRange start > end throws', () => {
    const bl = new BlockList();
    expect(() => bl.addRange('10.0.0.9', '10.0.0.1')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
  });

  test('toJSON / fromJSON round-trip (Node format: rule strings)', () => {
    const bl = new BlockList();
    bl.addAddress('10.0.0.5');
    bl.addSubnet('192.168.1.0', 24);
    bl.addRange('192.168.2.1', '192.168.2.10');
    // toJSON returns the rule strings, newest first.
    expect(bl.toJSON()).toEqual([
      'Range: IPv4 192.168.2.1-192.168.2.10',
      'Subnet: IPv4 192.168.1.0/24',
      'Address: IPv4 10.0.0.5',
    ]);
    // fromJSON re-adds each rule, so the restored list is reversed —
    // this matches Node exactly.
    const bl2 = new BlockList();
    bl2.fromJSON(JSON.stringify(bl.toJSON()));
    expect(bl2.rules).toEqual([
      'Address: IPv4 10.0.0.5',
      'Subnet: IPv4 192.168.1.0/24',
      'Range: IPv4 192.168.2.1-192.168.2.10',
    ]);
    expect(bl2.check('10.0.0.5')).toBe(true);
    expect(bl2.check('192.168.1.9')).toBe(true);
    expect(bl2.check('192.168.2.9')).toBe(true);
    expect(bl2.check('8.8.8.8')).toBe(false);
  });

  test('fromJSON validates input like Node', () => {
    const bl = new BlockList();
    expect(() => bl.fromJSON([{ address: '1.2.3.4' }])).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => bl.fromJSON(42)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => bl.fromJSON('{}')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => bl.fromJSON('not json')).toThrow(SyntaxError);
  });

  test('ipv6 fromJSON round-trip', () => {
    const bl = new BlockList();
    bl.addAddress('::1', 'ipv6');
    bl.addSubnet('2001:db8::', 32, 'ipv6');
    const bl2 = new BlockList();
    bl2.fromJSON(JSON.stringify(bl.toJSON()));
    expect(bl2.check('::1', 'ipv6')).toBe(true);
    expect(bl2.check('2001:db8::5', 'ipv6')).toBe(true);
    expect(bl2.check('2001:db9::5', 'ipv6')).toBe(false);
  });
});

describe('autoSelectFamily defaults', () => {
  test('defaults match Node', () => {
    expect(net.getDefaultAutoSelectFamily()).toBe(true);
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(250);
  });

  test('setters validate', () => {
    expect(() => net.setDefaultAutoSelectFamily(1)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => net.setDefaultAutoSelectFamilyAttemptTimeout(0)).toThrow(
      expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
    expect(() => net.setDefaultAutoSelectFamilyAttemptTimeout('x')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    net.setDefaultAutoSelectFamilyAttemptTimeout(5);
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(10); // clamped
    net.setDefaultAutoSelectFamilyAttemptTimeout(250);
    net.setDefaultAutoSelectFamily(true);
  });
});

describe('Socket states', () => {
  test('fresh socket shape matches Node', () => {
    const s = trackSocket(new Socket());
    expect(s.connecting).toBe(false);
    expect(s.pending).toBe(true);
    expect(s.destroyed).toBe(false);
    expect(s.readyState).toBe('open');
    expect(s.address()).toEqual({});
    expect(s.bytesRead).toBe(0);
    expect(s.bytesWritten).toBe(0);
    expect(s.bufferSize).toBeUndefined();
    expect(s.localAddress).toBeUndefined();
    expect(s.remoteAddress).toBeUndefined();
    expect(s.timeout).toBeUndefined(); // Node: no timeout property until setTimeout
  });

  test('connect() with no args throws ERR_MISSING_ARGS', () => {
    expect(() => trackSocket(new Socket()).connect()).toThrow(
      expect.objectContaining({ code: 'ERR_MISSING_ARGS' }));
  });

  test('invalid ports throw ERR_SOCKET_BAD_PORT synchronously', () => {
    expect(() => trackSocket(new Socket()).connect(99999)).toThrow(
      expect.objectContaining({ code: 'ERR_SOCKET_BAD_PORT' }));
    try {
      trackSocket(new Socket()).connect(99999);
      throw new Error('did not throw');
    } catch (e) {
      expect(e.message).toBe('Port should be >= 0 and < 65536. Received type number (99999).');
    }
    try {
      trackSocket(new Socket()).connect('99999');
      throw new Error('did not throw');
    } catch (e) {
      expect(e.message).toBe("Port should be >= 0 and < 65536. Received type string ('99999').");
    }
  });

  test('setTimeout validation mirrors Node', () => {
    const s = trackSocket(new Socket());
    expect(() => s.setTimeout(Infinity)).toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
    try { s.setTimeout(Infinity); } catch (e) {
      expect(e.message).toBe('The value of "msecs" is out of range. It must be a non-negative finite number. Received Infinity');
    }
    expect(() => s.setTimeout(-1)).toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
    expect(() => s.setTimeout('x')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(s.setTimeout(100)).toBe(s);
    expect(s.timeout).toBe(100);
    s.setTimeout(0);
    expect(s.timeout).toBe(0);
  });

  test('setTimeout assigns before validating (Node quirk)', () => {
    const s = trackSocket(new Socket());
    expect(() => s.setTimeout(Infinity)).toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
    expect(s.timeout).toBe(Infinity); // assigned before the throw, like Node
  });

  test('setTimeout is a noop on destroyed sockets', () => {
    const s = trackSocket(new Socket());
    s.destroy();
    expect(s.setTimeout(100)).toBe(s);
    expect(s.timeout).toBeUndefined();
  });

  test('setNoDelay / setKeepAlive / ref / unref return this', () => {
    const s = trackSocket(new Socket());
    expect(s.setNoDelay()).toBe(s);
    expect(s.setNoDelay(false)).toBe(s);
    expect(s.setKeepAlive(true, 1000)).toBe(s);
    expect(s.ref()).toBe(s);
    expect(s.unref()).toBe(s);
  });

  test('timeout event fires', async () => {
    const s = trackSocket(new Socket());
    const keep = setInterval(() => {}, 1000);
    try {
      let cbFired = false;
      s.setTimeout(30, () => { cbFired = true; });
      await new Promise((resolve) => s.once('timeout', resolve));
      expect(cbFired).toBe(true);
    } finally {
      clearInterval(keep);
    }
  });
});

describe('virtual loopback', () => {
  test('echo server round-trip with addresses and byte counts', async () => {
    const sv = trackServer(createServer((sock) => {
      sock.on('data', (d) => sock.write(d));
    }));
    const addr = await listenAsync(sv, 0);
    expect(addr.port).toBeGreaterThan(0);
    expect(addr.family).toBe('IPv6');

    const client = trackSocket(connect(addr.port));
    client.write('early'); // buffered before connect completes
    const chunks = [];
    await new Promise((resolve, reject) => {
      client.on('error', reject);
      client.on('data', (d) => {
        chunks.push(d);
        if (Buffer.concat(chunks).length >= 5) client.end();
      });
      client.on('close', (hadError) => {
        try {
          expect(hadError).toBe(false);
          resolve();
        } catch (e) { reject(e); }
      });
    });
    expect(Buffer.concat(chunks).toString()).toBe('early');
    expect(client.bytesWritten).toBe(5);
    expect(client.bytesRead).toBe(5);
    expect(client.remotePort).toBe(addr.port);
    expect(client.localAddress).toBe('127.0.0.1');
    expect(client.readyState).toBe('closed');
  });

  test('server sees client addresses; half-close delivers end both ways', async () => {
    const seen = {};
    let serverGot = '';
    const sv = trackServer(createServer((sock) => {
      seen.remoteAddress = sock.remoteAddress;
      seen.remotePort = sock.remotePort;
      seen.localAddress = sock.localAddress;
      seen.localPort = sock.localPort;
      sock.on('data', (d) => { serverGot += d; });
      sock.on('end', () => sock.end('bye'));
    }));
    const addr = await listenAsync(sv, 0);
    const client = trackSocket(connect(addr.port, '127.0.0.1'));
    let data = '';
    await new Promise((resolve, reject) => {
      client.on('error', reject);
      client.on('connect', () => {
        expect(client.connecting).toBe(false);
        expect(client.pending).toBe(false);
        expect(client.readyState).toBe('open');
        client.write('hi');
        client.end(); // half-close: FIN after data
      });
      client.on('data', (d) => { data += d; });
      client.on('end', () => client.destroy());
      client.on('close', (h) => (h ? reject(new Error('hadError')) : resolve()));
    });
    expect(data).toBe('bye');
    expect(serverGot).toBe('hi');
    expect(seen.remoteAddress).toBe('127.0.0.1');
    expect(seen.localPort).toBe(addr.port);
    expect(typeof seen.remotePort).toBe('number');
  });

  test('client destroy() delivers end to a paused server socket', async () => {
    const events = [];
    const sv = trackServer(createServer((sock) => {
      // paused: no data listener
      sock.on('end', () => events.push('end'));
      sock.on('close', (h) => events.push(`close:${h}`));
    }));
    const addr = await listenAsync(sv, 0);
    const client = trackSocket(connect(addr.port));
    await new Promise((resolve) => client.on('connect', resolve));
    await new Promise((resolve) => {
      client.on('close', resolve);
      client.destroy();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual(['end', 'close:false']);
  });

  test('destroy(err) emits error then close(true), in order', async () => {
    const sv = trackServer(createServer(() => {}));
    const addr = await listenAsync(sv, 0);
    const client = trackSocket(connect(addr.port));
    await new Promise((resolve) => client.on('connect', resolve));
    const order = [];
    const err = new Error('boom');
    await new Promise((resolve) => {
      client.on('error', (e) => { order.push('error'); expect(e).toBe(err); });
      client.on('close', (h) => { order.push(`close:${h}`); resolve(); });
      client.destroy(err);
    });
    expect(order).toEqual(['error', 'close:true']);
  });

  test('resetAndDestroy gives the peer ECONNRESET', async () => {
    const sv = trackServer(createServer((sock) => { sock.resetAndDestroy(); }));
    const addr = await listenAsync(sv, 0);
    const client = trackSocket(connect(addr.port));
    await new Promise((resolve, reject) => {
      client.on('error', (e) => {
        try { expect(e.code).toBe('ECONNRESET'); } catch (err) { reject(err); }
      });
      client.on('close', (h) => {
        try { expect(h).toBe(true); resolve(); } catch (err) { reject(err); }
      });
    });
  });

  test('getConnections counts live connections', async () => {
    const sv = trackServer(createServer(() => {}));
    const addr = await listenAsync(sv, 0);
    const c1 = trackSocket(connect(addr.port));
    const c2 = trackSocket(connect(addr.port));
    await new Promise((r) => c1.on('connect', r));
    await new Promise((r) => c2.on('connect', r));
    const n = await new Promise((resolve, reject) =>
      sv.getConnections((err, count) => (err ? reject(err) : resolve(count))));
    expect(n).toBe(2);
    expect(sv.getConnections(() => {})).toBe(sv);
  });

  test('maxConnections triggers drop', async () => {
    const sv = trackServer(createServer(() => {}));
    sv.maxConnections = 1;
    const addr = await listenAsync(sv, 0);
    const c1 = trackSocket(connect(addr.port));
    await new Promise((r) => c1.on('connect', r));
    let dropData = null;
    sv.on('drop', (d) => { dropData = d; });
    const c2 = trackSocket(connect(addr.port));
    c2.on('error', () => {});
    await new Promise((resolve) => c2.on('close', resolve));
    expect(dropData).not.toBeNull();
    expect(dropData.localPort).toBe(addr.port);
    expect(dropData.remoteAddress).toBe('127.0.0.1');
  });

  test('server blockList refuses connections', async () => {
    const bl = new BlockList();
    bl.addAddress('127.0.0.1');
    let connected = false;
    const sv = trackServer(createServer({ blockList: bl }, () => { connected = true; }));
    const addr = await listenAsync(sv, 0);
    const client = trackSocket(connect(addr.port));
    const code = await new Promise((resolve) => {
      client.on('error', (e) => resolve(e.code));
      client.on('close', () => resolve('closed'));
    });
    expect(connected).toBe(false);
    expect(code).toBe('ECONNREFUSED');
  });
});

describe('connection failures', () => {
  test('refused TCP (no host) -> bare ECONNREFUSED then close(true)', async () => {
    const s = trackSocket(new Socket());
    const events = [];
    await new Promise((resolve) => {
      s.on('error', (e) => events.push(['error', e.code, e.message, e.syscall]));
      s.on('close', (h) => { events.push(['close', h]); resolve(); });
      s.connect(9);
    });
    expect(events).toEqual([['error', 'ECONNREFUSED', '', undefined], ['close', true]]);
  });

  test('refused TCP (IP host) -> detailed ECONNREFUSED', async () => {
    const s = trackSocket(new Socket());
    const seen = await new Promise((resolve) => {
      s.on('error', (e) => resolve(e));
      s.on('close', () => {});
      s.connect(9, '127.0.0.1');
    });
    expect(seen.code).toBe('ECONNREFUSED');
    expect(seen.syscall).toBe('connect');
    expect(seen.message).toBe('connect ECONNREFUSED 127.0.0.1:9');
    expect(seen.address).toBe('127.0.0.1');
    expect(seen.port).toBe(9);
  });

  test('missing pipe -> ENOENT', async () => {
    const s = trackSocket(new Socket());
    const seen = await new Promise((resolve) => {
      s.on('error', (e) => resolve(e));
      s.on('close', () => {});
      s.connect('definitely-not-a-real-path-xyz');
    });
    expect(seen.code).toBe('ENOENT');
    expect(seen.syscall).toBe('connect');
  });

  test('unresolvable host -> ENOTFOUND', async () => {
    const s = trackSocket(new Socket());
    const seen = await new Promise((resolve) => {
      s.on('error', (e) => resolve(e));
      s.on('close', () => {});
      s.connect(80, 'nonexistent.invalid');
    });
    expect(seen.code).toBe('ENOTFOUND');
    expect(seen.syscall).toBe('getaddrinfo');
  });

  test('connect callback fires on success', async () => {
    const sv = trackServer(createServer(() => {}));
    const addr = await listenAsync(sv, 0);
    await new Promise((resolve, reject) => {
      const c = trackSocket(connect(addr.port, () => resolve()));
      c.on('error', reject);
    });
  });
});

describe('Server', () => {
  test('listen() with no args binds an ephemeral port; address() shape', async () => {
    const sv = trackServer(createServer());
    expect(sv.listening).toBe(false);
    expect(sv.address()).toBeNull();
    const addr = await listenAsync(sv);
    expect(sv.listening).toBe(true);
    expect(addr).toEqual({ address: '::', family: 'IPv6', port: expect.any(Number) });
    expect(sv.address()).toEqual(addr);
  });

  test('listen(port, host)', async () => {
    const sv = trackServer(createServer());
    const addr = await listenAsync(sv, 0, '127.0.0.1');
    expect(addr).toEqual({ address: '127.0.0.1', family: 'IPv4', port: expect.any(Number) });
  });

  test('double listen throws ERR_SERVER_ALREADY_LISTEN', async () => {
    const sv = trackServer(createServer());
    await listenAsync(sv, 0);
    expect(() => sv.listen(0)).toThrow(expect.objectContaining({
      code: 'ERR_SERVER_ALREADY_LISTEN',
      message: 'Listen method has been called more than once without closing.',
    }));
  });

  test('listen({}) throws ERR_INVALID_ARG_VALUE', () => {
    expect(() => trackServer(createServer()).listen({})).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
  });

  test('listen on a taken port emits EADDRINUSE', async () => {
    const a = trackServer(createServer());
    const addr = await listenAsync(a, 0, '127.0.0.1');
    const b = trackServer(createServer());
    const err = await new Promise((resolve) => {
      b.on('error', resolve);
      b.listen(addr.port, '127.0.0.1');
    });
    expect(err.code).toBe('EADDRINUSE');
  });

  test('close() on a non-listening server still emits close; callback gets ERR_SERVER_NOT_RUNNING', async () => {
    const sv = trackServer(createServer());
    let closed = false;
    sv.on('close', () => { closed = true; });
    const err = await new Promise((resolve) => sv.close(resolve));
    expect(err.code).toBe('ERR_SERVER_NOT_RUNNING');
    expect(closed).toBe(true);
  });

  test('close(callback) fires after connections drain', async () => {
    const sv = trackServer(createServer((sock) => { sock.on('data', () => {}); }));
    const addr = await listenAsync(sv, 0);
    const client = trackSocket(connect(addr.port));
    await new Promise((r) => client.on('connect', r));
    let closed = false;
    sv.on('close', () => { closed = true; });
    sv.close();
    expect(closed).toBe(false);
    client.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(true);
  });

  test('getConnections without callback throws', () => {
    expect(() => trackServer(createServer()).getConnections()).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
  });

  test('constructor validates options', () => {
    expect(() => createServer(5)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(trackServer(createServer(() => {})) instanceof Server).toBe(true);
  });

  test('pipe listen + connect', async () => {
    const sv = trackServer(createServer((sock) => sock.end('pipe-ok')));
    await listenAsync(sv, '/tmp/net-test-virtual.sock');
    expect(sv.address()).toBe('/tmp/net-test-virtual.sock');
    const client = trackSocket(connect('/tmp/net-test-virtual.sock'));
    let data = '';
    await new Promise((resolve, reject) => {
      client.on('error', reject);
      client.on('data', (d) => { data += d; });
      client.on('end', () => client.end());
      client.on('close', (h) => (h ? reject(new Error('hadError')) : resolve()));
    });
    expect(data).toBe('pipe-ok');
  });
});

describe('allowHalfOpen and transport lifecycle', () => {
  test('allowHalfOpen defaults to false on client and server sockets', async () => {
    const seen = {};
    const sv = trackServer(createServer((sock) => {
      trackSocket(sock);
      seen.server = sock.allowHalfOpen;
      sock.end('x');
    }));
    const addr = await listenAsync(sv, 0);
    const client = trackSocket(connect(addr.port));
    expect(client.allowHalfOpen).toBe(false);
    await new Promise((resolve, reject) => {
      client.on('error', reject);
      client.resume();
      client.on('end', () => client.end());
      client.on('close', (h) => (h ? reject(new Error('hadError')) : resolve()));
    });
    expect(seen.server).toBe(false);
  });

  test('createServer({ allowHalfOpen: true }) propagates to accepted sockets', async () => {
    const seen = {};
    const sv = trackServer(createServer({ allowHalfOpen: true }, (sock) => {
      trackSocket(sock);
      seen.server = sock.allowHalfOpen;
      sock.end('x');
    }));
    expect(sv.allowHalfOpen).toBe(true);
    const addr = await listenAsync(sv, 0);
    const client = trackSocket(connect(addr.port));
    expect(client.allowHalfOpen).toBe(false);
    await new Promise((resolve, reject) => {
      client.on('error', reject);
      client.resume();
      client.on('end', () => client.end());
      client.on('close', (h) => (h ? reject(new Error('hadError')) : resolve()));
    });
    expect(seen.server).toBe(true);
  });

  test('write after local end and remote FIN fails with EPIPE', async () => {
    const sv = trackServer(createServer((sock) => {
      trackSocket(sock);
      sock.end('data');
    }));
    const addr = await listenAsync(sv, 0);
    const client = trackSocket(connect(addr.port));
    const err = await new Promise((resolve, reject) => {
      client.resume();
      client.on('data', () => {});
      client.on('error', (e) => {
        // destroy(er) surfaces the EPIPE via 'error' as well.
        if (e && e.code === 'EPIPE') resolve(e);
        else reject(e);
      });
      client.end(); // local writable ends first...
      client.on('end', () => {
        // ...then the remote FIN arrives; write must now fail with EPIPE.
        expect(client.writableEnded).toBe(true);
        const ret = client.write('after-fin', (cbErr) => {
          try {
            expect(cbErr && cbErr.code).toBe('EPIPE');
          } catch (e) { reject(e); }
        });
        expect(ret).toBe(false);
      });
    });
    expect(err && err.code).toBe('EPIPE');
    expect(err.message).toBe('This socket has been ended by the other party');
  });

  test('concurrent half-open scenarios both settle (test-net-allow-half-open)', async () => {
    // Block 1: client never ends; server closes on client 'end'.
    const s1 = trackServer(createServer((sock) => {
      trackSocket(sock);
      sock.end(Buffer.alloc(1024));
    }));
    const a1 = await listenAsync(s1, 0);
    // Block 2: paused server socket, client half-closes immediately.
    const s2 = trackServer(createServer((sock) => {
      trackSocket(sock);
      sock.end(Buffer.alloc(1024));
    }));
    const a2 = await listenAsync(s2, 0);

    const c1 = trackSocket(connect(a1.port));
    expect(c1.allowHalfOpen).toBe(false);
    c1.resume();
    const p1 = new Promise((resolve, reject) => {
      c1.on('error', reject);
      c1.on('end', () => {
        expect(c1.destroyed).toBe(false);
        process.nextTick(() => s1.close());
      });
      c1.on('close', () => resolve());
    });

    const c2 = trackSocket(connect(a2.port));
    expect(c2.allowHalfOpen).toBe(false);
    c2.resume();
    const p2 = new Promise((resolve, reject) => {
      c2.on('error', reject);
      c2.on('end', () => { expect(c2.destroyed).toBe(false); });
      c2.end('asd');
      c2.on('finish', () => { expect(c2.destroyed).toBe(false); });
      c2.on('close', () => { s2.close(); resolve(); });
    });

    await p1;
    await p2;
  }, 15000);

  test('dead server-side socket releases its loop-keeper; server.close settles', async () => {
    let serverSock = null;
    const sv = trackServer(createServer((sock) => {
      serverSock = trackSocket(sock);
      // Paused: no 'data' listener, so buffered bytes + EOF never surface.
      sock.end(Buffer.alloc(1024));
    }));
    const addr = await listenAsync(sv, 0);
    const client = trackSocket(connect(addr.port));
    client.resume();
    await new Promise((resolve, reject) => {
      client.on('error', reject);
      client.on('end', () => {});
      client.end('asd');
      client.on('close', () => { sv.close(); resolve(); });
    });
    // The server-side transport is dead (our FIN sent, peer FIN received):
    // like a real inactive TCP handle it must not pin the event loop.
    expect(serverSock._isTransportInactive()).toBe(true);
    expect(serverSock._loopTimer).toBe(null);
  });
});

describe('browser-fallback lane', () => {
  test('works with native builtins disabled (no process.getBuiltinModule use)', async () => {
    const orig = process.getBuiltinModule;
    process.getBuiltinModule = () => { throw new Error('native disabled'); };
    try {
      // Pure APIs.
      expect(net.isIP('127.0.0.1')).toBe(4);
      expect(new BlockList().check('1.2.3.4')).toBe(false);
      // Virtual loopback.
      const sv = trackServer(createServer((sock) => sock.end('fallback-ok')));
      const addr = await listenAsync(sv, 0);
      const client = trackSocket(connect(addr.port));
      let data = '';
      await new Promise((resolve, reject) => {
        client.on('error', reject);
        client.on('data', (d) => { data += d; });
        client.on('end', () => client.end());
        client.on('close', (h) => (h ? reject(new Error('hadError')) : resolve()));
      });
      expect(data).toBe('fallback-ok');
    } finally {
      process.getBuiltinModule = orig;
    }
  });
});
