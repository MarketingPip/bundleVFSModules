import net, { Socket, Server, createServer, createConnection } from '../src/net.js';
import { Buffer } from 'buffer';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

describe('net shim', () => {
  
  describe('IP Validation', () => {
    test('isIP should detect IPv4 and IPv6', () => {
      expect(net.isIP('127.0.0.1')).toBe(4);
      expect(net.isIP('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(6);
      expect(net.isIP('not-an-ip')).toBe(0);
    });

    test('isIPv4 and isIPv6 helpers', () => {
      expect(net.isIPv4('1.1.1.1')).toBe(true);
      expect(net.isIPv6('::1')).toBe(true);
    });
  });

  describe('Socket', () => {
    let socket;

    beforeEach(() => {
      socket = new Socket();
    });

    test('should connect asynchronously and trigger callback', (done) => {
      const cb = jest.fn();
      socket.connect(8080, 'localhost', () => {
        expect(socket.readyState).toBe('open');
        expect(socket.remotePort).toBe(8080);
        done();
      });
      
      expect(socket.readyState).toBe('opening');
      expect(socket.connecting).toBe(true);
    });

    test('should emit "connect" event', (done) => {
      socket.on('connect', () => {
        expect(socket.connecting).toBe(false);
        done();
      });
      socket.connect({ port: 3000 });
    });

    test('destroy() should cleanup and emit close', (done) => {
      socket.connect(3000);
      socket.on('close', (hadError) => {
        expect(socket.destroyed).toBe(true);
        expect(hadError).toBe(false);
        done();
      });
      socket.destroy();
    });

    test('_receiveData should push data into the stream', (done) => {
      socket.on('data', (chunk) => {
        expect(Buffer.isBuffer(chunk)).toBe(true);
        expect(chunk.toString()).toBe('hello world');
        done();
      });
      socket._receiveData('hello world');
    });
  });

  describe('Server', () => {
    test('createServer should accept a connection listener', (done) => {
      const server = createServer((s) => {
        expect(s).toBeInstanceOf(Socket);
        server.close();
        done();
      });

      server.listen(0, () => {
        const port = server.address().port;
        expect(port).toBeGreaterThan(0);
        
        // Simulate an internal connection
        const clientSocket = new Socket();
        server._handleConnection(clientSocket);
      });
    });

    test('server.close() should destroy active connections', () => {
      const server = createServer();
      const s1 = new Socket();
      const s2 = new Socket();
      
      server.listen(3000);
      server._handleConnection(s1);
      server._handleConnection(s2);

      server.close();
      expect(s1.destroyed).toBe(true);
      expect(s2.destroyed).toBe(true);
    });
  });

  describe('createConnection (connect) factory', () => {
    test('should return a socket and start connection', () => {
      const s = createConnection(443, 'google.com');
      expect(s).toBeInstanceOf(Socket);
      expect(s.connecting).toBe(true);
    });
  });
});
