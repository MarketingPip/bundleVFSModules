import { jest, describe, test, expect } from '@jest/globals';
import tls, * as tlsNs from '../src/tls.js';
import realTls from 'node:tls';
import { EventEmitter } from '../src/events.js';
import * as tlsWrap from '../src/_tls_wrap.js';
import * as tlsCommon from '../src/_tls_common.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await tick(); };

describe('tls browser port — export surface', () => {
  test('named exports match real node:tls exactly', () => {
    const shim = Object.keys(tlsNs).filter((k) => k !== 'default').sort();
    const real = Object.keys(realTls).sort();
    expect(shim).toEqual(real);
  });

  test('default export carries the same surface', () => {
    expect(Object.keys(tls).sort()).toEqual(Object.keys(tlsNs).filter((k) => k !== 'default').sort());
    expect(tls.TLSSocket).toBe(tlsNs.TLSSocket);
    expect(tls.connect).toBe(tlsNs.connect);
  });

  test('TLSSocket is an EventEmitter', () => {
    expect(new tls.TLSSocket()).toBeInstanceOf(EventEmitter);
    expect(new tls.Server()).toBeInstanceOf(EventEmitter);
  });
});

describe('tls browser port — static data (differential vs real Node)', () => {
  test('getCiphers() returns the real static cipher list', () => {
    expect(tls.getCiphers()).toEqual(realTls.getCiphers());
    expect(tls.getCiphers()).toContain('tls_aes_256_gcm_sha384');
    // returns a copy, not the internal array
    const a = tls.getCiphers();
    a.push('bogus');
    expect(tls.getCiphers()).not.toContain('bogus');
  });

  test('constants match real Node', () => {
    expect(tls.DEFAULT_CIPHERS).toBe(realTls.DEFAULT_CIPHERS);
    expect(tls.DEFAULT_ECDH_CURVE).toBe(realTls.DEFAULT_ECDH_CURVE);
    expect(tls.DEFAULT_MAX_VERSION).toBe(realTls.DEFAULT_MAX_VERSION);
    expect(tls.DEFAULT_MIN_VERSION).toBe(realTls.DEFAULT_MIN_VERSION);
    expect(tls.CLIENT_RENEG_LIMIT).toBe(realTls.CLIENT_RENEG_LIMIT);
    expect(tls.CLIENT_RENEG_WINDOW).toBe(realTls.CLIENT_RENEG_WINDOW);
  });

  test('rootCertificates is honestly empty (documented gap)', () => {
    expect(Array.isArray(tls.rootCertificates)).toBe(true);
    expect(tls.rootCertificates).toEqual([]);
  });

  test('getCACertificates()/getCertificateCompressionAlgorithms() are honestly empty', () => {
    expect(tls.getCACertificates()).toEqual([]);
    expect(tls.getCertificateCompressionAlgorithms()).toEqual([]);
    expect(() => tls.setDefaultCACertificates([])).not.toThrow();
  });
});

describe('tls browser port — convertALPNProtocols', () => {
  test('encodes protocols exactly like real Node', () => {
    for (const protocols of [['h2', 'http/1.1'], ['a'], []]) {
      const outShim = {};
      const outReal = {};
      tls.convertALPNProtocols(protocols, outShim);
      realTls.convertALPNProtocols(protocols, outReal);
      expect([...outShim.ALPNProtocols]).toEqual([...outReal.ALPNProtocols]);
    }
  });

  test('accepts Uint8Array entries', () => {
    const out = {};
    tls.convertALPNProtocols([new Uint8Array([104, 50])], out);
    expect([...out.ALPNProtocols]).toEqual([2, 104, 50]);
  });

  test('rejects over-long protocols like real Node', () => {
    expect(() => tls.convertALPNProtocols(['x'.repeat(256)], {}))
      .toThrow(expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }));
  });
});

describe('tls browser port — checkServerIdentity (hostname matching)', () => {
  const valid = (host, cert) =>
    expect(tls.checkServerIdentity(host, cert)).toBeUndefined();

  test('mirrors real Node verdicts', () => {
    const cases = [
      ['example.com', { subject: { CN: 'example.com' }, subjectaltname: 'DNS:example.com' }],
      ['foo.example.com', { subject: {}, subjectaltname: 'DNS:*.example.com' }],
      ['EXAMPLE.com', { subject: {}, subjectaltname: 'DNS:example.com' }],
      ['1.2.3.4', { subject: {}, subjectaltname: 'IP Address:1.2.3.4' }],
      ['example.com', { subject: { CN: 'example.com' } }], // CN fallback
    ];
    for (const [host, cert] of cases) {
      expect(tls.checkServerIdentity(host, cert)).toBeUndefined();
      expect(realTls.checkServerIdentity(host, cert)).toBeUndefined();
      valid(host, cert);
    }
    const bad = [
      ['a.b.example.com', { subject: {}, subjectaltname: 'DNS:*.example.com' }],
      ['example.com', { subject: {}, subjectaltname: 'DNS:*.example.com' }],
      ['other.com', { subject: {}, subjectaltname: 'DNS:example.com' }],
      ['example.com', {}],
      ['1.2.3.4', { subject: {}, subjectaltname: 'DNS:1.2.3.4' }],
    ];
    for (const [host, cert] of bad) {
      // cross-realm: compare names/messages, not instanceof
      const shimErr = tls.checkServerIdentity(host, cert);
      const realErr = realTls.checkServerIdentity(host, cert);
      expect(shimErr && shimErr.name).toBe('Error');
      expect(realErr && realErr.name).toBe('Error');
      expect(shimErr.message).toMatch(/does not match/);
    }
  });

  test('null cert throws a plain TypeError like real Node', () => {
    let shimErr; let realErr;
    try { tls.checkServerIdentity('example.com', null); } catch (e) { shimErr = e; }
    try { realTls.checkServerIdentity('example.com', null); } catch (e) { realErr = e; }
    expect(shimErr && shimErr.name).toBe('TypeError');
    expect(realErr && realErr.name).toBe('TypeError');
    expect(shimErr.code).toBeUndefined();
    expect(realErr.code).toBeUndefined();
  });
});

describe('tls browser port — TLSSocket', () => {
  test('fresh socket has honest initial state', () => {
    const s = new tls.TLSSocket();
    expect(s.authorized).toBe(false);
    expect(s.authorizationError).toBeNull();
    expect(s.encrypted).toBe(true);
    expect(s.alpnProtocol).toBeNull();
    expect(s.servername).toBeNull();
    expect(s.destroyed).toBe(false);
  });

  test('handshake-derived getters never fabricate', () => {
    const s = new tls.TLSSocket();
    expect(s.getCipher()).toBeNull();
    expect(s.getPeerCertificate()).toEqual({});
    expect(s.getPeerCertificate(true)).toEqual({});
    expect(s.getProtocol()).toBeNull();
    expect(s.getSession()).toBeUndefined();
    expect(s.isSessionReused()).toBe(false);
    expect(s.getSharedSigalgs()).toEqual([]);
    expect(s.getEphemeralKeyInfo()).toBeNull();
    expect(s.getFinished()).toBeUndefined();
    expect(s.getPeerFinished()).toBeUndefined();
    expect(s.getTLSTicket()).toBeUndefined();
    expect(s.getPeerX509Certificate()).toBeUndefined();
    expect(s.getX509Certificate()).toBeUndefined();
    expect(s.getCertificate()).toEqual({});
    expect(s.setMaxSendFragment(512)).toBe(false);
    expect(s.exportKeyingMaterial(32, 'label')).toBeNull();
    expect(s.address()).toBeNull();
    expect(s.remoteAddress).toBeUndefined();
  });

  test('setServername / renegotiate shapes', async () => {
    const s = new tls.TLSSocket();
    s.setServername('example.com');
    expect(s.servername).toBe('example.com');
    const cb = jest.fn();
    expect(s.renegotiate({}, cb)).toBe(true);
    await flush();
    expect(cb).toHaveBeenCalled();
    expect(() => s.disableRenegotiation()).not.toThrow();
    expect(() => s.enableTrace()).not.toThrow();
    expect(() => s.setSession(undefined)).not.toThrow();
  });

  test('socket option methods are chainable noops', () => {
    const s = new tls.TLSSocket();
    expect(s.setNoDelay()).toBe(s);
    expect(s.setKeepAlive(true, 1000)).toBe(s);
    expect(s.setTimeout(500)).toBe(s);
    expect(s.ref()).toBe(s);
    expect(s.unref()).toBe(s);
  });

  test('write/end/destroy behave like a stream', async () => {
    const s = new tls.TLSSocket();
    const cb = jest.fn();
    expect(s.write('hello', cb)).toBe(true);
    await flush();
    expect(cb).toHaveBeenCalledWith(null);

    const endCb = jest.fn();
    const endSeen = jest.fn();
    s.on('end', endSeen);
    expect(s.end(endCb)).toBe(s);
    await flush();
    expect(endSeen).toHaveBeenCalled();
    expect(endCb).toHaveBeenCalled();

    const closeSeen = jest.fn();
    s.on('close', closeSeen);
    expect(s.destroy()).toBe(s);
    await flush();
    expect(closeSeen).toHaveBeenCalledWith(false);
    expect(s.destroyed).toBe(true);

    // write after destroy reports ERR_STREAM_DESTROYED via callback
    const wcb = jest.fn();
    expect(s.write('x', wcb)).toBe(false);
    await flush();
    expect(wcb).toHaveBeenCalledWith(expect.objectContaining({ code: 'ERR_STREAM_DESTROYED' }));
  });

  test('destroy(err) emits error then close(true)', async () => {
    const s = new tls.TLSSocket();
    const events = [];
    s.on('error', (e) => events.push(['error', e.code]));
    s.on('close', (hadError) => events.push(['close', hadError]));
    s.destroy(Object.assign(new Error('boom'), { code: 'EBOOM' }));
    await flush();
    expect(events).toEqual([['error', 'EBOOM'], ['close', true]]);
  });
});

describe('tls browser port — connect()', () => {
  test('returns TLSSocket with encrypted=false, emits connect then secureConnect', async () => {
    const s = tls.connect({ port: 443, host: 'example.com' });
    expect(s).toBeInstanceOf(tls.TLSSocket);
    expect(s.encrypted).toBe(false);
    const order = [];
    s.on('connect', () => order.push('connect'));
    s.on('secureConnect', () => order.push('secureConnect'));
    await flush(10);
    expect(order).toEqual(['connect', 'secureConnect']);
    s.destroy();
  });

  test('callback fires on secureConnect (async)', async () => {
    const cb = jest.fn();
    const s = tls.connect(443, 'example.com', cb);
    expect(cb).not.toHaveBeenCalled();
    await flush(10);
    expect(cb).toHaveBeenCalledTimes(1);
    s.destroy();
  });

  test('supports port/host/callback and options forms', async () => {
    const forms = [
      () => tls.connect(443),
      () => tls.connect(443, 'localhost'),
      () => tls.connect({ port: 443 }),
    ];
    for (const make of forms) {
      const s = make(); // create inside the iteration: listeners attach before any await
      expect(s).toBeInstanceOf(tls.TLSSocket);
      const done = jest.fn();
      s.on('secureConnect', done);
      await flush(10);
      expect(done).toHaveBeenCalled();
      s.destroy();
    }
  });

  test('never emits error for unreachable hosts (no real TCP)', async () => {
    const s = tls.connect({ port: 9, host: '192.0.2.1' });
    const onError = jest.fn();
    s.on('error', onError);
    await flush(10);
    expect(onError).not.toHaveBeenCalled();
    s.destroy();
  });

  test('validates port like Node', () => {
    expect(() => tls.connect({})).toThrow(expect.objectContaining({ code: 'ERR_SOCKET_BAD_PORT' }));
    expect(() => tls.connect({ port: 99999 })).toThrow(expect.objectContaining({ code: 'ERR_SOCKET_BAD_PORT' }));
    expect(() => tls.connect()).toThrow(expect.objectContaining({ code: 'ERR_SOCKET_BAD_PORT' }));
  });

  test('TLSSocket#connect keeps encrypted=true on direct construction', async () => {
    const s = new tls.TLSSocket();
    s.connect({ port: 443 });
    expect(s.encrypted).toBe(true);
    await flush(10);
    s.destroy();
  });

  test('servername option is picked up', async () => {
    const s = tls.connect({ port: 443, servername: 'example.com' });
    expect(s.servername).toBe('example.com');
    await flush(10);
    s.destroy();
  });
});

describe('tls browser port — Server', () => {
  test('createServer returns a Server; listener wires to secureConnection', () => {
    const onConn = jest.fn();
    const server = tls.createServer({}, onConn);
    expect(server).toBeInstanceOf(tls.Server);
    server.emit('secureConnection', new tls.TLSSocket());
    expect(onConn).toHaveBeenCalledTimes(1);
  });

  test('listen/close chain and emit asynchronously', async () => {
    const server = new tls.Server();
    const listening = jest.fn();
    expect(server.listen(443, listening)).toBe(server);
    expect(listening).not.toHaveBeenCalled();
    await flush();
    expect(listening).toHaveBeenCalledTimes(1);

    const closed = jest.fn();
    const closeCb = jest.fn();
    server.on('close', closed);
    expect(server.close(closeCb)).toBe(server);
    await flush();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closeCb).toHaveBeenCalledTimes(1);
  });

  test('address() is null; ticket keys are honestly null', () => {
    const server = tls.createServer({});
    expect(server.address()).toBeNull();
    expect(server.getTicketKeys()).toBeNull();
    expect(() => server.setTicketKeys(new Uint8Array(48))).not.toThrow();
    expect(() => server.setSecureContext({})).not.toThrow();
    expect(() => server.addContext('example.com', {})).not.toThrow();
  });

  test('getConnections reports zero', async () => {
    const server = tls.createServer({});
    const cb = jest.fn();
    server.getConnections(cb);
    await flush();
    expect(cb).toHaveBeenCalledWith(null, 0);
  });
});

describe('tls browser port — createSecureContext', () => {
  test('returns a SecureContext handle with the right shape', () => {
    const ctx = tls.createSecureContext({ key: 'k', cert: 'c' });
    expect(ctx).toBeInstanceOf(tls.SecureContext);
    expect(ctx.options).toEqual({ key: 'k', cert: 'c' });
    expect(() => ctx.setCert('c')).not.toThrow();
    expect(() => ctx.setKey('k')).not.toThrow();
    expect(() => ctx.addCACert('ca')).not.toThrow();
  });

  test('_tls_common exports match real node:_tls_common', () => {
    const realCommon = process.getBuiltinModule('_tls_common');
    const shim = Object.keys(tlsCommon).filter((k) => k !== 'default').sort();
    expect(shim).toEqual(Object.keys(realCommon).sort());
    expect(tlsCommon.translatePeerCertificate(null)).toBeUndefined();
    const cert = { subject: { CN: 'x' } };
    expect(tlsCommon.translatePeerCertificate(cert)).toBe(cert);
  });

  test('_tls_wrap re-exports the real surface', () => {
    const realWrap = process.getBuiltinModule('_tls_wrap');
    const shim = Object.keys(tlsWrap).filter((k) => k !== 'default').sort();
    expect(shim).toEqual(Object.keys(realWrap).sort());
    expect(tlsWrap.TLSSocket).toBe(tls.TLSSocket);
    expect(tlsWrap.Server).toBe(tls.Server);
    expect(tlsWrap.createServer).toBe(tls.createServer);
    expect(tlsWrap.connect).toBe(tls.connect);
  });
});

describe('tls browser port — browser-fallback lane', () => {
  test('works with native builtins disabled and no host Buffer', async () => {
    const origGetBuiltin = process.getBuiltinModule;
    const origBuffer = globalThis.Buffer;
    process.getBuiltinModule = () => { throw new Error('native disabled'); };
    globalThis.Buffer = undefined;
    try {
      expect(tls.getCiphers()).toContain('tls_aes_256_gcm_sha384');
      // convertALPNProtocols falls back to Uint8Array without Buffer
      const out = {};
      tls.convertALPNProtocols(['h2'], out);
      expect(out.ALPNProtocols).toBeInstanceOf(Uint8Array);
      expect([...out.ALPNProtocols]).toEqual([2, 104, 50]);
      expect(tls.checkServerIdentity('example.com',
        { subject: {}, subjectaltname: 'DNS:example.com' })).toBeUndefined();

      const server = tls.createServer({});
      const listening = jest.fn();
      server.listen(443, listening);
      await flush();
      expect(listening).toHaveBeenCalled();

      const s = tls.connect({ port: 443 });
      const secure = jest.fn();
      s.on('secureConnect', secure);
      await flush(10);
      expect(secure).toHaveBeenCalled();
      expect(s.encrypted).toBe(false);
      expect(s.getCipher()).toBeNull();
      s.destroy();

      const ctx = tls.createSecureContext({ cert: 'c' });
      expect(ctx).toBeInstanceOf(tls.SecureContext);
    } finally {
      process.getBuiltinModule = origGetBuiltin;
      globalThis.Buffer = origBuffer;
    }
  });
});
