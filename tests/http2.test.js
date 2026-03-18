import http2, { 
  Http2Session, 
  ClientHttp2Session, 
  Http2Stream, 
  connect, 
  constants, 
  createServer 
} from '../src/http2.js';

describe('http2 shim (stub)', () => {
  
  describe('Classes and Inheritance', () => {
    test('Http2Session should be an EventEmitter', () => {
      const session = new Http2Session();
      const spy = jest.fn();
      session.on('test', spy);
      session.emit('test');
      expect(spy).toHaveBeenCalled();
    });

    test('ClientHttp2Session should inherit from Http2Session', () => {
      const clientSession = new ClientHttp2Session();
      expect(clientSession).toBeInstanceOf(Http2Session);
    });

    test('Http2Stream should provide default property values', () => {
      const stream = new Http2Stream();
      expect(stream.id).toBe(0);
      expect(stream.closed).toBe(false);
      expect(stream.destroyed).toBe(false);
    });
  });

  describe('Factory Functions', () => {
    test('connect() returns a ClientHttp2Session', () => {
      const session = connect('http://localhost:8080');
      expect(session).toBeInstanceOf(ClientHttp2Session);
    });

    test('createServer() returns an EventEmitter', () => {
      const server = createServer();
      expect(server.on).toBeDefined();
      expect(server.emit).toBeDefined();
    });
  });

  describe('Async Stubbing', () => {
    test('session.close() executes callback asynchronously', (done) => {
      const session = new Http2Session();
      let syncFlag = false;
      
      session.close(() => {
        expect(syncFlag).toBe(true); // Should be true if called via setTimeout
        done();
      });
      
      syncFlag = true;
    });
  });

  describe('Constants and Settings', () => {
    test('should export standard HTTP/2 pseudo-header constants', () => {
      expect(constants.HTTP2_HEADER_STATUS).toBe(':status');
      expect(constants.HTTP2_HEADER_PATH).toBe(':path');
      expect(constants.HTTP_STATUS_OK).toBe(200);
    });

    test('getPackedSettings returns a Buffer', () => {
      const packed = http2.getPackedSettings({});
      expect(Buffer.isBuffer(packed)).toBe(true);
    });

    test('getDefaultSettings returns an object', () => {
      expect(typeof http2.getDefaultSettings()).toBe('object');
    });
  });

  describe('Exports', () => {
    test('default export should match named exports', () => {
      expect(http2.connect).toBe(connect);
      expect(http2.Http2Session).toBe(Http2Session);
    });
  });
});
