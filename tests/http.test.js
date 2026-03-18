import { Buffer } from 'buffer';
import http, { 
  IncomingMessage, 
  ServerResponse, 
  Server, 
  ClientRequest,
  createServer 
} from '../src/http.js';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

global.Buffer = Buffer;

// Mock the Fetch API
global.fetch = jest.fn();
global.AbortController = class {
  constructor() { this.signal = {}; }
  abort() {}
};

// Mock the Net/Socket dependency
jest.mock('../src/net.js', () => {
  const EventEmitter = require('events');
  class MockSocket extends EventEmitter {
    destroy() { this.emit('close'); return this; }
    _receiveData(data) { this.emit('data', data); }
    _receiveEnd() { this.emit('end'); }
    address() { return { port: 8080 }; }
    listen(port, host, cb) { if(cb) setTimeout(cb, 0); }
    close(cb) { if(cb) setTimeout(cb, 0); }
  }
  return { Socket: MockSocket, Server: MockSocket };
});

describe('HTTP Shim', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('IncomingMessage', () => {
    test('should initialize from request data', (done) => {
      const msg = IncomingMessage.fromRequest('POST', '/test', { 'Content-Type': 'text/plain' }, 'hello');
      
      expect(msg.method).toBe('POST');
      expect(msg.url).toBe('/test');
      expect(msg.headers['Content-Type']).toBe('text/plain');

      msg.on('data', (chunk) => {
        expect(chunk.toString()).toBe('hello');
        done();
      });
    });
  });

  describe('ServerResponse', () => {
    test('should collect body chunks and resolve', async () => {
      const req = new IncomingMessage();
      const res = new ServerResponse(req);
      
      const promise = new Promise(resolve => res._setResolver(resolve));

      res.setHeader('X-Custom', 'Value');
      res.write('Part 1');
      res.end('Part 2');

      const result = await promise;
      expect(result.statusCode).toBe(200);
      expect(result.headers['x-custom']).toBe('Value');
      expect(result.body.toString()).toBe('Part 1Part 2');
    });

    test('should handle Express-style .json() and .status()', async () => {
      const res = new ServerResponse(new IncomingMessage());
      const promise = new Promise(resolve => res._setResolver(resolve));

      res.status(201).json({ success: true });

      const result = await promise;
      expect(result.statusCode).toBe(201);
      expect(result.headers['content-type']).toBe('application/json');
      expect(JSON.parse(result.body.toString())).toEqual({ success: true });
    });
  });

  describe('Server', () => {
    test('should trigger request listener on handleRequest', async () => {
      const listener = jest.fn((req, res) => {
        res.end('handled');
      });
      const server = createServer(listener);
      
      const response = await server.handleRequest('GET', '/', {}, null);
      
      expect(listener).toHaveBeenCalled();
      expect(response.body.toString()).toBe('handled');
    });
  });

  describe('ClientRequest (Fetch Bridge)', () => {
    test('should translate request to fetch call', (done) => {
      const mockResponse = {
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'text/plain']]),
        arrayBuffer: async () => Buffer.from('response body').buffer
      };
      
      global.fetch.mockResolvedValue(mockResponse);

      const req = http.request({
        hostname: 'api.example.com',
        path: '/data',
        method: 'POST',
        headers: { 'Authorization': 'Bearer 123' }
      }, (res) => {
        expect(res.statusCode).toBe(200);
        res.on('data', (chunk) => {
          expect(chunk.toString()).toBe('response body');
          done();
        });
      });

      req.end('request body');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://api.example.com/data',
        expect.objectContaining({
          method: 'POST',
          body: expect.any(Buffer)
        })
      );
    });
  });

  describe('WebSocket Framing Helpers', () => {
    test('should round-trip WebSocket frames (Unmasked)', () => {
      const opcode = 0x01; // Text
      const payload = Buffer.from('hello');
      
      const frame = http._createWsFrame(opcode, payload, false);
      const parsed = http._parseWsFrame(frame);

      expect(parsed.opcode).toBe(opcode);
      expect(Buffer.from(parsed.payload).toString()).toBe('hello');
    });

    test('should handle masked frames (Client-style)', () => {
      const payload = Buffer.from('secret');
      const frame = http._createWsFrame(0x02, payload, true);
      
      // Byte 1 should have mask bit set
      expect(frame[1] & 0x80).toBeTruthy();
      
      const parsed = http._parseWsFrame(frame);
      expect(Buffer.from(parsed.payload).toString()).toBe('secret');
    });
  });
});
