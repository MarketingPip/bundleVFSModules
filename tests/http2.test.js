// tests/http2.test.js — repo tests for the node:http2 browser emulation.
//
// Conventions: constants/defaults/settings-packing are differential-tested
// against the REAL node:http2; class shapes and the in-process virtual
// client/server loop are tested against the emulation's documented behavior.

import http2, {
  Http2Server,
  Http2SecureServer,
  Http2Session,
  ClientHttp2Session,
  ServerHttp2Session,
  Http2Stream,
  Http2ServerRequest,
  Http2ServerResponse,
  createServer,
  createSecureServer,
  connect,
  performServerHandshake,
  constants,
  getDefaultSettings,
  getPackedSettings,
  getUnpackedSettings,
  sensitiveHeaders,
} from '../src/http2.js';
import realHttp2 from 'node:http2';
import { Buffer } from 'buffer';
import { describe, test, expect, jest } from '@jest/globals';

function catchCode(fn) {
  try {
    fn();
  } catch (e) {
    return e && e.code;
  }
  return undefined;
}

function catchErr(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected function to throw');
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, (...args) => resolve(args));
    emitter.once('error', reject);
  });
}

// ---------------------------------------------------------------- constants
describe('constants', () => {
  test('matches the real node:http2 constants object exactly', () => {
    expect(constants).toEqual(realHttp2.constants);
  });

  test('has 240 entries', () => {
    expect(Object.keys(constants).length).toBe(240);
  });

  test('spot-check key values', () => {
    expect(constants.NGHTTP2_SESSION_SERVER).toBe(0);
    expect(constants.NGHTTP2_SESSION_CLIENT).toBe(1);
    expect(constants.HTTP2_HEADER_STATUS).toBe(':status');
    expect(constants.HTTP2_HEADER_METHOD).toBe(':method');
    expect(constants.HTTP2_HEADER_PATH).toBe(':path');
    expect(constants.HTTP2_HEADER_AUTHORITY).toBe(':authority');
    expect(constants.HTTP2_HEADER_SCHEME).toBe(':scheme');
    expect(constants.DEFAULT_SETTINGS_HEADER_TABLE_SIZE).toBe(4096);
    expect(constants.DEFAULT_SETTINGS_MAX_FRAME_SIZE).toBe(16384);
    expect(constants.NGHTTP2_NO_ERROR).toBe(0);
    expect(constants.NGHTTP2_CANCEL).toBe(8);
  });
});

// ---------------------------------------------------------------- settings
describe('settings utilities', () => {
  test('getDefaultSettings() matches real node:http2', () => {
    expect(getDefaultSettings()).toEqual(realHttp2.getDefaultSettings());
  });

  test('returns a fresh object each call', () => {
    const a = getDefaultSettings();
    a.headerTableSize = 1;
    expect(getDefaultSettings().headerTableSize).toBe(4096);
  });

  const CASES = [
    {},
    { headerTableSize: 0 },
    { enablePush: false },
    { enablePush: true },
    { maxConcurrentStreams: 100 },
    { initialWindowSize: 1024 },
    { maxFrameSize: 32768 },
    { maxHeaderListSize: 100000 },
    { enableConnectProtocol: true },
    {
      headerTableSize: 4096,
      enablePush: true,
      initialWindowSize: 65535,
      maxFrameSize: 16384,
      maxConcurrentStreams: 4294967295,
      maxHeaderListSize: 65535,
      enableConnectProtocol: false,
    },
    { bogus: 123 }, // unknown keys are ignored, like Node
    { maxConcurrentStreams: 1.5 }, // fractional values are truncated, like Node
  ];

  for (const input of CASES) {
    test(`getPackedSettings(${JSON.stringify(input)}) matches Node byte-for-byte`, () => {
      const ours = getPackedSettings(input);
      const theirs = realHttp2.getPackedSettings(input);
      expect(Buffer.isBuffer(ours)).toBe(true);
      expect(ours.toString('hex')).toBe(theirs.toString('hex'));
    });
  }

  test('getUnpackedSettings round-trips packed settings', () => {
    const input = { headerTableSize: 8192, enablePush: false, maxConcurrentStreams: 100 };
    const packed = getPackedSettings(input);
    expect(getUnpackedSettings(packed)).toEqual(
      realHttp2.getUnpackedSettings(realHttp2.getPackedSettings(input))
    );
  });

  test('getUnpackedSettings maps unknown ids to customSettings, like Node', () => {
    const buf = Buffer.from('000700000005', 'hex');
    expect(getUnpackedSettings(buf)).toEqual(realHttp2.getUnpackedSettings(buf));
    expect(getUnpackedSettings(buf).customSettings).toEqual({ 7: 5 });
  });

  test('getPackedSettings rejects out-of-range values with ERR_HTTP2_INVALID_SETTING_VALUE', () => {
    expect(catchCode(() => getPackedSettings({ maxFrameSize: 1 })))
      .toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
    expect(catchCode(() => getPackedSettings({ initialWindowSize: 2147483648 })))
      .toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
    expect(catchCode(() => getPackedSettings({ enablePush: 2 })))
      .toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
  });

  test('getPackedSettings rejects non-objects with ERR_INVALID_ARG_TYPE', () => {
    expect(catchCode(() => getPackedSettings(null))).toBe('ERR_INVALID_ARG_TYPE');
    expect(catchCode(() => getPackedSettings('nope'))).toBe('ERR_INVALID_ARG_TYPE');
  });

  test('boolean settings require real booleans, like Node', () => {
    expect(catchCode(() => getPackedSettings({ enablePush: 1 })))
      .toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
    expect(catchCode(() => getPackedSettings({ enablePush: 'yes' })))
      .toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
    expect(catchCode(() => getPackedSettings({ maxConcurrentStreams: true })))
      .toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
    expect(catchCode(() => getPackedSettings({ maxFrameSize: '16384' })))
      .toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
    expect(catchCode(() => getPackedSettings({ maxFrameSize: null })))
      .toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
  });

  test('undefined values are skipped and NaN returns undefined, like Node', () => {
    const skipped = getPackedSettings({ maxFrameSize: undefined, headerTableSize: 1 });
    expect(skipped.toString('hex')).toBe(
      realHttp2.getPackedSettings({ maxFrameSize: undefined, headerTableSize: 1 }).toString('hex')
    );
    expect(getPackedSettings({ maxFrameSize: NaN })).toBe(
      realHttp2.getPackedSettings({ maxFrameSize: NaN })
    );
    expect(getPackedSettings({ maxFrameSize: NaN })).toBeUndefined();
  });

  test('getUnpackedSettings rejects bad lengths with ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH', () => {
    const err = catchErr(() => getUnpackedSettings(Buffer.from([0, 1])));
    expect(err.code).toBe('ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH');
    expect(err.name).toBe('RangeError');
    expect(err.message).toBe('Packed settings length must be a multiple of six');
  });

  test('getPackedSettings() with no argument returns an empty Buffer, like Node', () => {
    const ours = getPackedSettings();
    const theirs = realHttp2.getPackedSettings();
    expect(Buffer.isBuffer(ours)).toBe(true);
    expect(ours.length).toBe(0);
    expect(ours.toString('hex')).toBe(theirs.toString('hex'));
  });

  test('maxHeaderSize aliases id 6 and wins over maxHeaderListSize, like Node', () => {
    const cases = [
      { maxHeaderSize: 100 },
      { maxHeaderListSize: 100 },
      { maxHeaderSize: 200, maxHeaderListSize: 100 },
      { maxHeaderListSize: 100, maxHeaderSize: 200 },
    ];
    for (const input of cases) {
      expect(getPackedSettings(input).toString('hex')).toBe(
        realHttp2.getPackedSettings(input).toString('hex')
      );
    }
  });

  test('customSettings pack byte-for-byte like Node, including quirks', () => {
    const input = { customSettings: { 1011: 5, 9999: 301, 2606: 6 } };
    expect(getPackedSettings(input).toString('hex')).toBe(
      realHttp2.getPackedSettings(input).toString('hex')
    );
    // Custom id "3" maps to nothing in Node: the whole call returns undefined.
    expect(getPackedSettings({ customSettings: { 3: 1 } })).toBe(
      realHttp2.getPackedSettings({ customSettings: { 3: 1 } })
    );
    expect(getPackedSettings({ customSettings: { 3: 1 } })).toBeUndefined();
  });

  test('customSettings validation mirrors Node', () => {
    expect(catchCode(() => getPackedSettings({ customSettings: { 0: 1 } })))
      .toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
    expect(catchCode(() => getPackedSettings({ customSettings: { 65536: 1 } })))
      .toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
    expect(catchCode(() => getPackedSettings({ customSettings: 'x' })))
      .toBe('ERR_INVALID_ARG_TYPE');
    const many = {};
    for (let i = 11; i <= 21; i++) many[i] = 1;
    expect(catchCode(() => getPackedSettings({ customSettings: many })))
      .toBe('ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS');
  });

  test('settings errors have Node-exact names, codes, and messages', () => {
    let err = catchErr(() => getPackedSettings({ headerTableSize: -1 }));
    expect(err.name).toBe('RangeError');
    expect(err.code).toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
    expect(err.message).toBe('Invalid value for setting "headerTableSize": -1');

    err = catchErr(() => getPackedSettings({ enablePush: NaN }));
    expect(err.name).toBe('TypeError');
    expect(err.code).toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
    expect(err.message).toBe('Invalid value for setting "enablePush": NaN');

    err = catchErr(() => getPackedSettings(null));
    expect(err.name).toBe('TypeError');
    expect(err.code).toBe('ERR_INVALID_ARG_TYPE');
    expect(err.message).toBe(
      'The "settings" argument must be of type object. Received null'
    );

    err = catchErr(() => getUnpackedSettings(1));
    expect(err.name).toBe('TypeError');
    expect(err.code).toBe('ERR_INVALID_ARG_TYPE');
    expect(err.message).toBe(
      'The "buf" argument must be an instance of Buffer or TypedArray. Received type number (1)'
    );
  });

  test('getUnpackedSettings reads TypedArray elements like Node and validates', () => {
    const packed = new Uint16Array([
      0x00, 0x01, 0x00, 0x00, 0x00, 0x64,
      0x00, 0x03, 0x00, 0x00, 0x00, 0xc8,
      0x00, 0x05, 0x00, 0x00, 0x4e, 0x20,
      0x00, 0x04, 0x00, 0x00, 0x00, 0x64,
      0x00, 0x06, 0x00, 0x00, 0x00, 0x64,
      0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
      0x00, 0x08, 0x00, 0x00, 0x00, 0x00]);
    expect(getUnpackedSettings(packed)).toEqual(realHttp2.getUnpackedSettings(packed));
    const s = getUnpackedSettings(packed);
    expect(s.headerTableSize).toBe(100);
    expect(s.maxFrameSize).toBe(20000);
    expect(s.maxHeaderListSize).toBe(100);
    expect(s.maxHeaderSize).toBe(100); // id 6 populates both names, like Node
    expect(s.enablePush).toBe(true);

    // DataView is rejected, like Node.
    expect(catchCode(() => getUnpackedSettings(new DataView(new ArrayBuffer(12)))))
      .toBe('ERR_INVALID_ARG_TYPE');

    // { validate: true } checks only initialWindowSize and maxFrameSize ranges.
    expect(catchCode(() =>
      getUnpackedSettings(Buffer.from('000480000000', 'hex'), { validate: true })))
      .toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
    expect(catchCode(() =>
      getUnpackedSettings(Buffer.from('000500003fff', 'hex'), { validate: true })))
      .toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
    expect(getUnpackedSettings(Buffer.from('000500ffffff', 'hex'), { validate: true })
      .maxFrameSize).toBe(16777215);
  });

  test('session.settings applies validated settings including id-6 aliasing', async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const session = connect(`http://localhost:${port}`);
    await once(session, 'connect');
    await new Promise((resolve, reject) =>
      session.settings({ maxHeaderSize: 100, enablePush: false }, (err) => err ? reject(err) : resolve()));
    expect(session.localSettings.maxHeaderSize).toBe(100);
    expect(session.localSettings.maxHeaderListSize).toBe(100);
    expect(session.localSettings.enablePush).toBe(false);
    session.destroy();
    server.close();
  });
});

describe('sensitiveHeaders', () => {
  test('is a symbol like the real one', () => {
    expect(typeof sensitiveHeaders).toBe('symbol');
    expect(sensitiveHeaders.description).toBe('sensitiveHeaders');
    expect(typeof realHttp2.sensitiveHeaders).toBe('symbol');
  });
});

// ---------------------------------------------------------------- sessions
describe('Http2Session', () => {
  test('class hierarchy and session types', () => {
    expect(new ClientHttp2Session()).toBeInstanceOf(Http2Session);
    expect(new ServerHttp2Session()).toBeInstanceOf(Http2Session);
    expect(new ClientHttp2Session().type).toBe(constants.NGHTTP2_SESSION_CLIENT);
    expect(new ServerHttp2Session().type).toBe(constants.NGHTTP2_SESSION_SERVER);
  });

  test('default property values', () => {
    const s = new Http2Session();
    expect(s.closed).toBe(false);
    expect(s.destroyed).toBe(false);
    expect(s.encrypted).toBe(false);
    expect(s.alpnProtocol).toBeUndefined();
    expect(s.socket).toBeNull();
    expect(s.pendingSettingsAck).toBe(false);
    expect(s.localSettings).toEqual(getDefaultSettings());
  });

  test('ping() returns true and calls back async with (null, duration, payload)', async () => {
    const s = new Http2Session();
    let sync = true;
    const ret = s.ping((err, duration, payload) => {
      expect(sync).toBe(false);
      expect(err).toBeNull();
      expect(typeof duration).toBe('number');
      expect(Buffer.isBuffer(payload)).toBe(true);
      expect(payload.length).toBe(8);
    });
    sync = false;
    expect(ret).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
  });

  test('ping() echoes a provided payload', async () => {
    const s = new Http2Session();
    const [err, , payload] = await new Promise((resolve) => {
      s.ping(Buffer.from('12345678'), (...args) => resolve(args));
    });
    expect(err).toBeNull();
    expect(payload.toString()).toBe('12345678');
  });

  test('ping() on a closed session throws ERR_HTTP2_INVALID_SESSION', () => {
    const s = new Http2Session();
    s.close();
    expect(catchCode(() => s.ping(() => {}))).toBe('ERR_HTTP2_INVALID_SESSION');
  });

  test('close() emits close and runs the callback asynchronously', async () => {
    const s = new Http2Session();
    const onClose = jest.fn();
    s.on('close', onClose);
    let sync = true;
    s.close(() => {
      expect(sync).toBe(false);
      expect(s.closed).toBe(true);
    });
    sync = false;
    await new Promise((r) => setTimeout(r, 10));
    expect(onClose).toHaveBeenCalled();
  });

  test('destroy(error) emits error then close', async () => {
    const s = new Http2Session();
    const events = [];
    s.on('error', (e) => events.push(['error', e.message]));
    s.on('close', () => events.push(['close']));
    const err = new Error('boom');
    s.destroy(err);
    expect(s.destroyed).toBe(true);
    expect(events).toEqual([['error', 'boom'], ['close']]);
  });

  test('settings() merges locally and calls back (null, settings, duration)', async () => {
    const s = new Http2Session();
    const seen = once(s, 'localSettings');
    s.settings({ maxConcurrentStreams: 10 }, (err, settings, duration) => {
      expect(err).toBeNull();
      expect(settings.maxConcurrentStreams).toBe(10);
      expect(typeof duration).toBe('number');
    });
    const [emitted] = await seen;
    expect(emitted.maxConcurrentStreams).toBe(10);
    expect(s.localSettings.maxConcurrentStreams).toBe(10);
  });

  test('settings() with an invalid value throws ERR_HTTP2_INVALID_SETTING_VALUE', () => {
    const s = new Http2Session();
    expect(catchCode(() => s.settings({ maxFrameSize: 1 }, () => {})))
      .toBe('ERR_HTTP2_INVALID_SETTING_VALUE');
  });

  test('setNextStreamID validates', () => {
    const s = new Http2Session();
    s.setNextStreamID(5);
    expect(s.state.nextStreamID).toBe(5);
    expect(catchCode(() => s.setNextStreamID(0))).toBe('ERR_HTTP2_INVALID_STREAM');
    expect(catchCode(() => s.setNextStreamID(-3))).toBe('ERR_HTTP2_INVALID_STREAM');
  });

  test('ref()/unref() return the session', () => {
    const s = new Http2Session();
    expect(s.ref()).toBe(s);
    expect(s.unref()).toBe(s);
  });

  test('noops do not throw: goaway, rstStream, priority, setLocalWindowSize, setTimeout', () => {
    const s = new Http2Session();
    expect(() => {
      s.goaway();
      s.rstStream(new Http2Stream());
      s.priority(new Http2Stream(), { weight: 32 });
      s.setLocalWindowSize(1024);
      s.setTimeout(100, () => {});
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------- streams
describe('Http2Stream', () => {
  test('default property values for a pending stream', () => {
    const stream = new Http2Stream();
    expect(stream.id).toBe(0);
    expect(stream.pending).toBe(true);
    expect(stream.closed).toBe(false);
    expect(stream.destroyed).toBe(false);
    expect(stream.pushAllowed).toBe(false);
    expect(stream.headersSent).toBe(false);
  });

  test('exposes the real method shapes', () => {
    const stream = new Http2Stream();
    for (const m of [
      'abort', 'additionalHeaders', 'close', 'destroy', 'priority',
      'rstStream', 'setTimeout', 'respond', 'respondWithFD',
      'respondWithFile', 'sendTrailers', 'info', 'pushStream',
      'write', 'end',
    ]) {
      expect(typeof stream[m]).toBe('function');
    }
  });

  test('respond() records sentHeaders without I/O', () => {
    const stream = new Http2Stream();
    stream.respond({ ':status': 201, 'x-a': 'b' });
    expect(stream.headersSent).toBe(true);
    expect(stream.sentHeaders).toEqual({ ':status': 201, 'x-a': 'b' });
  });

  test('pushStream() reports ERR_HTTP2_PUSH_DISABLED asynchronously', async () => {
    const stream = new Http2Stream();
    const code = await new Promise((resolve) => {
      stream.pushStream({ ':path': '/' }, (err) => resolve(err && err.code));
    });
    expect(code).toBe('ERR_HTTP2_PUSH_DISABLED');
  });

  test('write()/end() buffer the request body', () => {
    const stream = new Http2Stream();
    stream.write('foo');
    stream.end('bar');
    expect(stream.requestBody.toString()).toBe('foobar');
  });

  test('rstStream sets rstCode and destroys', () => {
    const stream = new Http2Stream();
    const onClose = jest.fn();
    stream.on('close', onClose);
    stream.rstStream(constants.NGHTTP2_CANCEL);
    expect(stream.rstCode).toBe(constants.NGHTTP2_CANCEL);
    expect(stream.destroyed).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- servers
describe('Http2Server', () => {
  test('createServer returns an Http2Server (an EventEmitter)', () => {
    const server = createServer();
    expect(server).toBeInstanceOf(Http2Server);
    expect(typeof server.on).toBe('function');
    expect(typeof server.emit).toBe('function');
    expect(typeof server.listen).toBe('function');
    expect(typeof server.close).toBe('function');
    expect(typeof server.setTimeout).toBe('function');
    expect(typeof server.address).toBe('function');
    expect(typeof server.updateSettings).toBe('function');
  });

  test('createSecureServer returns an Http2SecureServer', () => {
    const server = createSecureServer();
    expect(server).toBeInstanceOf(Http2SecureServer);
    expect(server).toBeInstanceOf(Http2Server);
  });

  test('listen() emits listening async and address() reports the port', async () => {
    const server = createServer();
    const listening = once(server, 'listening');
    server.listen(0);
    await listening;
    const addr = server.address();
    expect(addr.port).toBeGreaterThan(0);
    await new Promise((r) => server.close(r));
    expect(server.address()).toBeNull();
  });
});

// ---------------------------------------------------------------- virtual loop
describe('virtual client/server loop', () => {
  test('connect() returns a ClientHttp2Session and emits connect async', async () => {
    const session = connect('http://localhost:8080');
    expect(session).toBeInstanceOf(ClientHttp2Session);
    expect(session.connecting).toBe(true);
    const [s] = await once(session, 'connect');
    expect(s).toBe(session);
    expect(session.connecting).toBe(false);
  });

  test('request/response round trip through a createServer handler', async () => {
    const server = createServer((req, res) => {
      expect(req).toBeInstanceOf(Http2ServerRequest);
      expect(res).toBeInstanceOf(Http2ServerResponse);
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/submit');
      expect(req.body.toString()).toBe('ping-body');
      res.writeHead(201, { 'content-type': 'text/plain' });
      res.end('pong-body');
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    const session = connect(`http://localhost:${port}`);
    await once(session, 'connect');

    const stream = session.request({ ':path': '/submit', ':method': 'POST' });
    expect(stream.id).toBe(1);

    const done = new Promise((resolve, reject) => {
      const chunks = [];
      let headers;
      stream.on('response', (h) => { headers = h; });
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve({ headers, body: Buffer.concat(chunks).toString() }));
      stream.on('error', reject);
    });
    stream.end('ping-body');
    const { headers, body } = await done;
    expect(headers[':status']).toBe(201);
    expect(headers['content-type']).toBe('text/plain');
    expect(body).toBe('pong-body');

    await new Promise((r) => server.close(r));
    session.close();
  });

  test('client-initiated streams use ascending odd ids', async () => {
    const server = createServer((req, res) => res.end('ok'));
    await new Promise((r) => server.listen(0, r));
    const session = connect(`http://localhost:${server.address().port}`);
    await once(session, 'connect');
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const stream = session.request({ ':path': '/' });
      stream.on('error', () => {});
      ids.push(stream.id);
      stream.end();
    }
    expect(ids).toEqual([1, 3, 5]);
    await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => server.close(r));
    session.close();
  });

  test('raw stream event handlers can respond() and end()', async () => {
    const server = createServer();
    server.on('stream', (stream, headers) => {
      expect(stream).toBeInstanceOf(Http2Stream);
      expect(headers[':path']).toBe('/raw');
      stream.respond({ ':status': 200 });
      stream.end('raw-ok');
    });
    await new Promise((r) => server.listen(0, r));
    const session = connect(`http://localhost:${server.address().port}`);
    await once(session, 'connect');
    const stream = session.request({ ':path': '/raw' });
    const done = new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
      stream.on('error', reject);
    });
    stream.end();
    expect(await done).toBe('raw-ok');
    await new Promise((r) => server.close(r));
    session.close();
  });

  test('compat request event delivers method, url and headers', async () => {
    const seen = {};
    const server = createServer();
    server.on('request', (req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      seen.version = req.httpVersion;
      res.end('ok');
    });
    await new Promise((r) => server.listen(0, r));
    const session = connect(`http://localhost:${server.address().port}`);
    await once(session, 'connect');
    const stream = session.request({ ':path': '/a?b=c', ':method': 'GET' });
    const done = once(stream, 'end');
    stream.end();
    await done;
    expect(seen.method).toBe('GET');
    expect(seen.url).toBe('/a?b=c');
    expect(seen.version).toBe('2.0');
    await new Promise((r) => server.close(r));
    session.close();
  });

  test('request() with no registered server emits ECONNREFUSED', async () => {
    const session = connect('http://127.0.0.1:9');
    await once(session, 'connect');
    const err = await new Promise((resolve) => {
      session.once('error', resolve);
      const stream = session.request({ ':path': '/' });
      stream.on('error', () => {});
      stream.end();
    });
    expect(err.code).toBe('ECONNREFUSED');
    session.destroy();
  });

  test('https connect() marks the session encrypted', async () => {
    const session = connect('https://localhost:8443');
    expect(session.encrypted).toBe(true);
    await once(session, 'connect');
    session.close();
  });

  test('connect() validates its authority like Node', () => {
    expect(catchCode(() => connect('::::'))).toBe('ERR_INVALID_URL');
    expect(catchCode(() => connect('ftp://example.com'))).toBe('ERR_HTTP2_UNSUPPORTED_PROTOCOL');
  });

  test('performServerHandshake returns a ServerHttp2Session', () => {
    const session = performServerHandshake(null, {});
    expect(session).toBeInstanceOf(ServerHttp2Session);
  });
});

// ---------------------------------------------------------------- exports
describe('exports', () => {
  test('default export matches named exports', () => {
    expect(http2.connect).toBe(connect);
    expect(http2.Http2Session).toBe(Http2Session);
    expect(http2.Http2Stream).toBe(Http2Stream);
    expect(http2.Http2Server).toBe(Http2Server);
    expect(http2.Http2SecureServer).toBe(Http2SecureServer);
    expect(http2.createServer).toBe(createServer);
    expect(http2.createSecureServer).toBe(createSecureServer);
    expect(http2.constants).toBe(constants);
    expect(http2.getDefaultSettings).toBe(getDefaultSettings);
    expect(http2.getPackedSettings).toBe(getPackedSettings);
    expect(http2.getUnpackedSettings).toBe(getUnpackedSettings);
    expect(http2.sensitiveHeaders).toBe(sensitiveHeaders);
  });
});

// ---------------------------------------------------------------- browser lane
describe('browser fallback (no native builtins)', () => {
  let fb;
  let realGbm;
  let hadBuffer;

  beforeAll(async () => {
    realGbm = process.getBuiltinModule;
    process.getBuiltinModule = () => {
      throw new Error('getBuiltinModule unavailable (browser lane)');
    };
    hadBuffer = 'Buffer' in globalThis;
    try {
      delete globalThis.Buffer;
    } catch {
      // non-configurable in some environments; the import binding is what matters
    }
    fb = await import('../src/http2.js?fallback=browser');
    process.getBuiltinModule = realGbm;
  });

  afterAll(async () => {
    process.getBuiltinModule = realGbm;
    if (hadBuffer && !('Buffer' in globalThis)) {
      globalThis.Buffer = (await import('buffer')).Buffer;
    }
  });

  test('constants and settings work with native builtins hidden', () => {
    expect(Object.keys(fb.constants).length).toBe(240);
    expect(fb.constants).toEqual(realHttp2.constants);
    expect(fb.getDefaultSettings()).toEqual(realHttp2.getDefaultSettings());
    const packed = fb.getPackedSettings({ maxConcurrentStreams: 100 });
    expect(packed.toString('hex')).toBe(
      realHttp2.getPackedSettings({ maxConcurrentStreams: 100 }).toString('hex')
    );
    expect(fb.getUnpackedSettings(packed)).toEqual({ maxConcurrentStreams: 100 });
  });

  test('virtual loop works with native builtins hidden', async () => {
    const server = fb.createServer((req, res) => res.end('fallback-ok'));
    await new Promise((r) => server.listen(0, r));
    const session = fb.connect(`http://localhost:${server.address().port}`);
    await once(session, 'connect');
    const stream = session.request({ ':path': '/' });
    const done = new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
      stream.on('error', reject);
    });
    stream.end();
    expect(await done).toBe('fallback-ok');
    await new Promise((r) => server.close(r));
    session.close();
  });

  test('session ping works with native builtins hidden', async () => {
    const s = new fb.Http2Session();
    const [err, , payload] = await new Promise((resolve) => {
      s.ping((...args) => resolve(args));
    });
    expect(err).toBeNull();
    expect(payload.length).toBe(8);
    s.close();
  });
});
