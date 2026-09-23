import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import dgram from '../src/dgram.js';

// Tests for the browser dgram shim (src/dgram.js).
//
// Raw UDP cannot exist in a browser, so these tests assert the shim's honest
// contract, with every error code/message verified against real Node v24.20.0:
//   * argument validation throws the exact Node ERR_* codes and messages,
//   * the lifecycle state machine and event names match Node,
//   * anything needing a real network is a documented noop: datagrams are
//     discarded (send callbacks get (null, 0)), and address()/remoteAddress()
//     return null instead of fabricated addresses.

describe('dgram browser shim', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function expectCode(fn, code) {
    try {
      fn();
    } catch (e) {
      expect(e.code).toBe(code);
      return e;
    }
    throw new Error(`expected throw with code ${code}`);
  }

  // -- createSocket ---------------------------------------------------------

  test('createSocket returns a Socket instance with the right type', () => {
    const s4 = dgram.createSocket('udp4');
    const s6 = dgram.createSocket('udp6');
    expect(s4).toBeInstanceOf(dgram.Socket);
    expect(s6).toBeInstanceOf(dgram.Socket);
    expect(s4.type).toBe('udp4');
    expect(s6.type).toBe('udp6');
    expect(typeof s4.on).toBe('function'); // EventEmitter-shaped
  });

  test('createSocket rejects bad socket types like Node', () => {
    const e = expectCode(() => dgram.createSocket('bogus'), 'ERR_SOCKET_BAD_TYPE');
    expect(e.message).toBe('Bad socket type specified. Valid types are: udp4, udp6');
    expectCode(() => dgram.createSocket(), 'ERR_SOCKET_BAD_TYPE');
    expectCode(() => dgram.createSocket({}), 'ERR_SOCKET_BAD_TYPE');
    expectCode(() => dgram.createSocket({ type: 'tcp' }), 'ERR_SOCKET_BAD_TYPE');
  });

  test('createSocket accepts an options object', () => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    expect(s).toBeInstanceOf(dgram.Socket);
    expect(s.type).toBe('udp4');
  });

  test('createSocket validates buffer-size options like Node', () => {
    const e = expectCode(
      () => dgram.createSocket({ type: 'udp4', recvBufferSize: -1 }),
      'ERR_OUT_OF_RANGE');
    expect(e.message).toBe(
      'The value of "options.recvBufferSize" is out of range. ' +
      'It must be >= 0 && <= 4294967295. Received -1');
    const e2 = expectCode(
      () => dgram.createSocket({ type: 'udp4', sendBufferSize: 'x' }),
      'ERR_INVALID_ARG_TYPE');
    expect(e2.message).toBe(
      `The "options.sendBufferSize" property must be of type number. ` +
      `Received type string ('x')`);
  });

  test('createSocket(type, listener) attaches a message listener', () => {
    const listener = jest.fn();
    const s = dgram.createSocket('udp4', listener);
    expect(s.listeners('message')).toContain(listener);
  });

  // -- bind -----------------------------------------------------------------

  test('bind() emits listening asynchronously and calls back', () => {
    const s = dgram.createSocket('udp4');
    const onListening = jest.fn();
    const cb = jest.fn();
    s.on('listening', onListening);
    const ret = s.bind(1234, '127.0.0.1', cb);
    expect(ret).toBe(s);
    expect(onListening).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
    jest.advanceTimersByTime(0);
    expect(onListening).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('bind() accepts (port, callback) shorthand', () => {
    const s = dgram.createSocket('udp4');
    const cb = jest.fn();
    s.bind(1234, cb);
    jest.advanceTimersByTime(0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('bind() twice throws ERR_SOCKET_ALREADY_BOUND', () => {
    const s = dgram.createSocket('udp4');
    s.bind(1234);
    const e = expectCode(() => s.bind(1234), 'ERR_SOCKET_ALREADY_BOUND');
    expect(e.message).toBe('Socket is already bound');
  });

  test('bind() on a closed socket throws ERR_SOCKET_DGRAM_NOT_RUNNING', () => {
    const s = dgram.createSocket('udp4');
    s.close();
    jest.advanceTimersByTime(0);
    const e = expectCode(() => s.bind(1234), 'ERR_SOCKET_DGRAM_NOT_RUNNING');
    expect(e.message).toBe('Not running');
  });

  // -- address ---------------------------------------------------------------

  test('address() before bind throws EBADF like Node', () => {
    const s = dgram.createSocket('udp4');
    const e = expectCode(() => s.address(), 'EBADF');
    expect(e.message).toBe('getsockname EBADF');
    expect(e.syscall).toBe('getsockname');
  });

  test('address() after bind returns null (no fabricated address)', () => {
    const s = dgram.createSocket('udp4');
    s.bind(1234);
    jest.advanceTimersByTime(0);
    expect(s.address()).toBeNull();
  });

  test('address() after close throws ERR_SOCKET_DGRAM_NOT_RUNNING', () => {
    const s = dgram.createSocket('udp4');
    s.bind(1234);
    jest.advanceTimersByTime(0);
    s.close();
    jest.advanceTimersByTime(0);
    expectCode(() => s.address(), 'ERR_SOCKET_DGRAM_NOT_RUNNING');
  });

  // -- send ------------------------------------------------------------------

  test('send() validates the message like Node', () => {
    const s = dgram.createSocket('udp4');
    const e = expectCode(
      () => s.send(123, 1234, '127.0.0.1'), 'ERR_INVALID_ARG_TYPE');
    expect(e.message).toBe(
      'The "buffer" argument must be of type string or an instance of ' +
      `Buffer, TypedArray, or DataView. Received type number (123)`);
    const e2 = expectCode(
      () => s.send(Buffer.from('x'), 5, 1, 1234, '127.0.0.1'),
      'ERR_BUFFER_OUT_OF_BOUNDS');
    expect(e2.message).toBe('"offset" is outside of buffer bounds');
    const e3 = expectCode(
      () => s.send(Buffer.from('x'), 0, 5, 1234, '127.0.0.1'),
      'ERR_BUFFER_OUT_OF_BOUNDS');
    expect(e3.message).toBe('"length" is outside of buffer bounds');
  });

  test('send() validates port and address like Node', () => {
    const s = dgram.createSocket('udp4');
    const e = expectCode(() => s.send(Buffer.from('x')), 'ERR_SOCKET_BAD_PORT');
    expect(e.message).toBe('Port should be > 0 and < 65536. Received undefined.');
    const e2 = expectCode(
      () => s.send(Buffer.from('x'), 99999, '127.0.0.1'), 'ERR_SOCKET_BAD_PORT');
    expect(e2.message).toBe('Port should be > 0 and < 65536. Received type number (99999).');
    const e3 = expectCode(
      () => s.send(Buffer.from('x'), 1234, 123), 'ERR_INVALID_ARG_TYPE');
    expect(e3.message).toBe(
      'The "address" argument must be of type string. Received type number (123)');
  });

  test('send() on a closed socket throws synchronously like Node', () => {
    const s = dgram.createSocket('udp4');
    s.close();
    jest.advanceTimersByTime(0);
    const e = expectCode(
      () => s.send(Buffer.from('x'), 1234, '127.0.0.1'),
      'ERR_SOCKET_DGRAM_NOT_RUNNING');
    expect(e.message).toBe('Not running');
  });

  test('send() discards the datagram: callback gets (null, 0)', () => {
    const s = dgram.createSocket('udp4');
    const cb = jest.fn();
    s.send(Buffer.from('hello'), 41234, '12.34.56.78', cb);
    expect(cb).not.toHaveBeenCalled();
    jest.advanceTimersByTime(0);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(null, 0);
  });

  test('send() accepts a list of buffers and the offset/length form', () => {
    const s = dgram.createSocket('udp4');
    const cb = jest.fn();
    s.send(['a', Buffer.from('b'), new Uint8Array([99])], 1234, '127.0.0.1', cb);
    const cb2 = jest.fn();
    s.send('hello', 0, 5, 1234, '127.0.0.1', cb2);
    jest.advanceTimersByTime(0);
    expect(cb).toHaveBeenCalledWith(null, 0);
    expect(cb2).toHaveBeenCalledWith(null, 0);
  });

  test('send() implicitly binds first: listening fires before the callback', () => {
    const s = dgram.createSocket('udp4');
    const order = [];
    s.on('listening', () => order.push('listening'));
    s.send(Buffer.from('x'), 1234, '127.0.0.1', () => order.push('sent'));
    jest.advanceTimersByTime(0);
    expect(order).toEqual(['listening', 'sent']);
  });

  test('sendto() validates its numeric arguments', () => {
    const s = dgram.createSocket('udp4');
    const e = expectCode(
      () => s.sendto(Buffer.from('x'), 'a', 1, 1234, '127.0.0.1'),
      'ERR_INVALID_ARG_TYPE');
    expect(e.message).toBe(
      `The "offset" argument must be of type number. Received type string ('a')`);
  });

  // -- connect / disconnect / remoteAddress -----------------------------------

  test('connect() validates and emits connect asynchronously', () => {
    const s = dgram.createSocket('udp4');
    const e = expectCode(
      () => s.connect(0, '127.0.0.1'), 'ERR_SOCKET_BAD_PORT');
    expect(e.message).toBe('Port should be > 0 and < 65536. Received type number (0).');
    const onConnect = jest.fn();
    const cb = jest.fn();
    s.on('connect', onConnect);
    const ret = s.connect(1234, '127.0.0.1', cb);
    expect(ret).toBe(s);
    expect(onConnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(0);
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('connect() twice throws ERR_SOCKET_DGRAM_IS_CONNECTED', () => {
    const s = dgram.createSocket('udp4');
    s.connect(1234, '127.0.0.1');
    jest.advanceTimersByTime(0);
    const e = expectCode(() => s.connect(1234, '127.0.0.1'), 'ERR_SOCKET_DGRAM_IS_CONNECTED');
    expect(e.message).toBe('Already connected');
  });

  test('remoteAddress() throws when not connected, null when connected', () => {
    const s = dgram.createSocket('udp4');
    const e = expectCode(() => s.remoteAddress(), 'ERR_SOCKET_DGRAM_NOT_CONNECTED');
    expect(e.message).toBe('Not connected');
    s.connect(1234, '127.0.0.1');
    jest.advanceTimersByTime(0);
    expect(s.remoteAddress()).toBeNull();
  });

  test('disconnect() works once, then throws', () => {
    const s = dgram.createSocket('udp4');
    expectCode(() => s.disconnect(), 'ERR_SOCKET_DGRAM_NOT_CONNECTED');
    s.connect(1234, '127.0.0.1');
    jest.advanceTimersByTime(0);
    expect(() => s.disconnect()).not.toThrow();
    expectCode(() => s.disconnect(), 'ERR_SOCKET_DGRAM_NOT_CONNECTED');
    expectCode(() => s.remoteAddress(), 'ERR_SOCKET_DGRAM_NOT_CONNECTED');
  });

  test('send() with port/address while connected throws ERR_SOCKET_DGRAM_IS_CONNECTED', () => {
    const s = dgram.createSocket('udp4');
    s.connect(1234, '127.0.0.1');
    jest.advanceTimersByTime(0);
    expectCode(
      () => s.send(Buffer.from('x'), 0, 1, 1234, '127.0.0.1'),
      'ERR_SOCKET_DGRAM_IS_CONNECTED');
    // connected form still works (discarded, (null, 0))
    const cb = jest.fn();
    s.send(Buffer.from('x'), cb);
    jest.advanceTimersByTime(0);
    expect(cb).toHaveBeenCalledWith(null, 0);
  });

  // -- close -------------------------------------------------------------------

  test('close() emits close asynchronously and calls back', () => {
    const s = dgram.createSocket('udp4');
    const onClose = jest.fn();
    const cb = jest.fn();
    s.on('close', onClose);
    const ret = s.close(cb);
    expect(ret).toBe(s);
    expect(onClose).not.toHaveBeenCalled();
    jest.advanceTimersByTime(0);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('close() twice throws ERR_SOCKET_DGRAM_NOT_RUNNING like Node', () => {
    const s = dgram.createSocket('udp4');
    s.close();
    jest.advanceTimersByTime(0);
    const e = expectCode(() => s.close(), 'ERR_SOCKET_DGRAM_NOT_RUNNING');
    expect(e.message).toBe('Not running');
  });

  test('close() while binding is queued instead of throwing', () => {
    const s = dgram.createSocket('udp4');
    const events = [];
    s.on('listening', () => events.push('listening'));
    s.on('close', () => events.push('close'));
    s.bind(1234);
    expect(() => s.close()).not.toThrow();
    jest.runAllTimers();
    expect(events).toEqual(['close']);
  });

  test('Symbol.asyncDispose closes the socket', async () => {
    jest.useRealTimers();
    const s = dgram.createSocket('udp4');
    const closed = new Promise((resolve) => s.on('close', resolve));
    await s[Symbol.asyncDispose]();
    await closed;
    expectCode(() => s.bind(1), 'ERR_SOCKET_DGRAM_NOT_RUNNING');
  });

  // -- socket options ------------------------------------------------------------

  test('TTL setters validate and return the value', () => {
    const s = dgram.createSocket('udp4');
    const e = expectCode(() => s.setTTL('x'), 'ERR_INVALID_ARG_TYPE');
    expect(e.message).toBe(`The "ttl" argument must be of type number. Received type string ('x')`);
    expect(s.setTTL(64)).toBe(64);
    expect(s.setMulticastTTL(128)).toBe(128);
    expect(s.setMulticastLoopback(true)).toBe(true);
    expect(s.setBroadcast(true)).toBeUndefined();
  });

  test('setMulticastInterface validates the address', () => {
    const s = dgram.createSocket('udp4');
    const e = expectCode(() => s.setMulticastInterface(123), 'ERR_INVALID_ARG_TYPE');
    expect(e.message).toBe(
      'The "interfaceAddress" argument must be of type string. Received type number (123)');
    expect(() => s.setMulticastInterface('eth0')).not.toThrow();
  });

  test('membership methods require an address, otherwise noop', () => {
    const s = dgram.createSocket('udp4');
    const e = expectCode(() => s.addMembership(), 'ERR_MISSING_ARGS');
    expect(e.message).toBe('The "multicastAddress" argument must be specified');
    expectCode(() => s.dropMembership(), 'ERR_MISSING_ARGS');
    expect(() => {
      s.addMembership('224.0.0.1');
      s.dropMembership('224.0.0.1', 'eth0');
    }).not.toThrow();
    const e2 = expectCode(
      () => s.addSourceSpecificMembership(1, '224.0.0.1'), 'ERR_INVALID_ARG_TYPE');
    expect(e2.message).toBe(
      'The "sourceAddress" argument must be of type string. Received type number (1)');
    expect(() => s.addSourceSpecificMembership('1.2.3.4', '224.0.0.1')).not.toThrow();
    expect(() => s.dropSourceSpecificMembership('1.2.3.4', '224.0.0.1')).not.toThrow();
  });

  test('buffer-size setters validate; getters return 0 (no real buffers)', () => {
    const s = dgram.createSocket('udp4');
    const e = expectCode(() => s.setRecvBufferSize(-1), 'ERR_SOCKET_BAD_BUFFER_SIZE');
    expect(e.message).toBe('Buffer size must be a positive integer');
    expectCode(() => s.setSendBufferSize(1.5), 'ERR_SOCKET_BAD_BUFFER_SIZE');
    expect(() => s.setRecvBufferSize(65536)).not.toThrow();
    expect(s.getRecvBufferSize()).toBe(0);
    expect(s.getSendBufferSize()).toBe(0);
    expect(s.getSendQueueSize()).toBe(0);
    expect(s.getSendQueueCount()).toBe(0);
  });

  test('ref()/unref() return the socket', () => {
    const s = dgram.createSocket('udp4');
    expect(s.ref()).toBe(s);
    expect(s.unref()).toBe(s);
  });

  // -- bindSync / connectSync ------------------------------------------------------

  test('bindSync() validates like Node, emits listening, returns null address', () => {
    const s = dgram.createSocket('udp4');
    const e = expectCode(
      () => s.bindSync({ address: 'not-an-ip' }), 'ERR_INVALID_ARG_VALUE');
    expect(e.message).toBe(
      `The property 'options.address' must be a numeric IP address; ` +
      `bindSync does not perform DNS resolution. Received 'not-an-ip'`);
    const e2 = expectCode(() => s.bindSync({ port: -1 }), 'ERR_SOCKET_BAD_PORT');
    expect(e2.message).toBe('options.port should be >= 0 and < 65536. Received type number (-1).');
    const onListening = jest.fn();
    s.on('listening', onListening);
    const addr = s.bindSync({ port: 1234, address: '127.0.0.1' });
    expect(addr).toBeNull();
    expect(onListening).not.toHaveBeenCalled();
    jest.advanceTimersByTime(0);
    expect(onListening).toHaveBeenCalledTimes(1);
    expectCode(() => s.bindSync(), 'ERR_SOCKET_ALREADY_BOUND');
  });

  test('connectSync() validates like Node and emits connect', () => {
    const s = dgram.createSocket('udp4');
    const e = expectCode(() => s.connectSync(1234, 'nope'), 'ERR_INVALID_ARG_VALUE');
    expect(e.message).toBe(
      `The argument 'address' must be a numeric IP address; ` +
      `connectSync does not perform DNS resolution. Received 'nope'`);
    expectCode(() => s.connectSync(0), 'ERR_SOCKET_BAD_PORT');
    const onConnect = jest.fn();
    s.on('connect', onConnect);
    expect(s.connectSync(1234, '127.0.0.1')).toBeUndefined();
    jest.advanceTimersByTime(0);
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(s.remoteAddress()).toBeNull();
    expectCode(() => s.connectSync(1234), 'ERR_SOCKET_DGRAM_IS_CONNECTED');
  });

  // -- AbortSignal -----------------------------------------------------------------

  test('options.signal aborts the socket', () => {
    const controller = new AbortController();
    const s = dgram.createSocket({ type: 'udp4', signal: controller.signal });
    const onClose = jest.fn();
    s.on('close', onClose);
    controller.abort();
    jest.advanceTimersByTime(0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('options.signal rejects non-signals like Node', () => {
    expectCode(
      () => dgram.createSocket({ type: 'udp4', signal: 42 }),
      'ERR_INVALID_ARG_TYPE');
  });

  // -- module shape ------------------------------------------------------------------

  test('default export exposes Socket and createSocket', () => {
    expect(dgram.Socket).toBe(dgram.Socket);
    expect(typeof dgram.createSocket).toBe('function');
  });
});
