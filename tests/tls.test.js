import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import tls from '../src/tls.js';

describe('tls Browser Shim', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('TLSSocket', () => {
    test('initializes with expected status flags', () => {
      const socket = new tls.TLSSocket();
      expect(socket.authorized).toBe(false);
      expect(socket.encrypted).toBe(true);
      expect(socket).toBeInstanceOf(tls.TLSSocket);
    });

    test('stubs certificate and cipher methods', () => {
      const socket = new tls.TLSSocket();
      expect(socket.getPeerCertificate()).toEqual({});
      expect(socket.getCipher()).toBeNull();
      expect(socket.getProtocol()).toBeNull();
    });
  });

  

  describe('Server', () => {
    test('createServer returns a Server instance', () => {
      const server = tls.createServer({}, () => {});
      expect(server).toBeInstanceOf(tls.Server);
    });

    test('server methods are chainable and safe', () => {
      const server = new tls.Server();
      expect(server.listen(443)).toBe(server);
      expect(server.close()).toBe(server);
      expect(server.address()).toBeNull();
    });
  });

  describe('Connection & Configuration', () => {
    test('connect() executes callback asynchronously', () => {
      const callback = jest.fn();
      const socket = tls.connect({ port: 443 }, callback);

      expect(socket).toBeInstanceOf(tls.TLSSocket);
      expect(callback).not.toHaveBeenCalled();

      jest.advanceTimersByTime(0);
      expect(callback).toHaveBeenCalled();
    });

    test('createSecureContext returns an empty object', () => {
      const context = tls.createSecureContext({ key: '...', cert: '...' });
      expect(context).toEqual({});
    });

    test('provides standard TLS constants and cipher lists', () => {
      expect(tls.getCiphers()).toContain('TLS_AES_256_GCM_SHA384');
      expect(tls.DEFAULT_MAX_VERSION).toBe('TLSv1.3');
      expect(Array.isArray(tls.rootCertificates)).toBe(true);
    });
  });
});
