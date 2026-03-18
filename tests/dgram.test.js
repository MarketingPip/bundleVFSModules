import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import dgram from '../src/dgram.js';

describe('dgram Browser Shim', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('createSocket returns a Socket instance', () => {
    const socket = dgram.createSocket('udp4');
    expect(socket).toBeInstanceOf(dgram.Socket);
  });

  test('bind() executes callback asynchronously', () => {
    const socket = dgram.createSocket('udp4');
    const callback = jest.fn();

    socket.bind(1234, 'localhost', callback);

    // Should not have been called immediately
    expect(callback).not.toHaveBeenCalled();

    // Advance timers
    jest.advanceTimersByTime(0);
    expect(callback).toHaveBeenCalled();
  });

  test('send() simulates success via callback', () => {
    const socket = dgram.createSocket('udp4');
    const callback = jest.fn();
    const message = Buffer.from('hello');

    socket.send(message, 0, message.length, 41234, '12.34.56.78', callback);

    jest.advanceTimersByTime(0);

    // Node.js dgram callback signature: callback(error, bytesSent)
    expect(callback).toHaveBeenCalledWith(null, 0);
  });

  test('address() returns a mock IPv4 object', () => {
    const socket = dgram.createSocket('udp4');
    const addr = socket.address();

    expect(addr).toEqual({
      address: "0.0.0.0",
      family: "IPv4",
      port: 0
    });
  });

  test('close() executes callback asynchronously', () => {
    const socket = dgram.createSocket('udp4');
    const callback = jest.fn();

    socket.close(callback);
    
    jest.advanceTimersByTime(0);
    expect(callback).toHaveBeenCalled();
  });

  

  test('lifecycle and configuration methods are compatible', () => {
    const socket = dgram.createSocket('udp4');
    
    // These should not throw and return 'this' or expected dummy values
    expect(socket.ref()).toBe(socket);
    expect(socket.unref()).toBe(socket);
    expect(socket.setTTL(64)).toBe(64);
    expect(socket.getRecvBufferSize()).toBe(0);
    
    // Membership methods should be callable without error
    expect(() => {
      socket.addMembership('224.0.0.1');
      socket.setBroadcast(true);
    }).not.toThrow();
  });
});
