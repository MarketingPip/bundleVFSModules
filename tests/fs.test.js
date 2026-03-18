// adjust path if needed
import {jest, describe, test, expect } from '@jest/globals';

 
import fs from '../src/fs.js';

import { promises as fsp, constants } from '../src/fs.js';

describe('memfs wrapper', () => {
  beforeEach(async () => {
    // Clear volume between tests
    await fsp.rmdir('/', { recursive: true }).catch(() => {});
    await fsp.mkdir('/');
  });

  describe('callback validation', () => {
    it('throws ERR_INVALID_ARG_TYPE if callback is missing on async method', () => {
      expect(() => fs.readFile('/file.txt')).toThrowErrorMatchingObject({
        code: 'ERR_INVALID_ARG_TYPE',
      });
    });

    it('does not throw for sync methods', () => {
      expect(() => fs.readFileSync('/file.txt')).not.toThrow();
    });

    it('does not throw for streams/watchers', () => {
      expect(() => fs.createReadStream('/file.txt')).not.toThrow();
      expect(() => fs.watch('/')).not.toThrow();
      expect(() => fs.unwatchFile('/file.txt')).not.toThrow();
    });
  });

  describe('callback async methods', () => {
    it('calls the callback with result on success', (done) => {
      fs.writeFile('/file.txt', 'hello', (err) => {
        expect(err).toBeNull();
        fs.readFile('/file.txt', 'utf8', (err2, data) => {
          expect(err2).toBeNull();
          expect(data).toBe('hello');
          done();
        });
      });
    });

    it('calls the callback with error if file does not exist', (done) => {
      fs.readFile('/missing.txt', (err) => {
        expect(err).toBeTruthy();
        done();
      });
    });
  });

  describe('promises API', () => {
    it('writeFile and readFile work with promises', async () => {
      await fsp.writeFile('/a.txt', 'abc');
      const data = await fsp.readFile('/a.txt', 'utf8');
      expect(data).toBe('abc');
    });

    it('rejects promises for non-existent files', async () => {
      await expect(fsp.readFile('/nope.txt')).rejects.toHaveProperty('code', 'ENOENT');
    });
  });

  describe('write methods', () => {
    it('appendFile appends to file', async () => {
      await fsp.writeFile('/b.txt', '1');
      await fsp.appendFile('/b.txt', '2');
      const content = await fsp.readFile('/b.txt', 'utf8');
      expect(content).toBe('12');
    });

    it('unlink removes files', async () => {
      await fsp.writeFile('/c.txt', 'x');
      await fsp.unlink('/c.txt');
      await expect(fsp.stat('/c.txt')).rejects.toHaveProperty('code', 'ENOENT');
    });
  });

  describe('monkey-patch emits', () => {
    it('calls global emitMe for callbacks', (done) => {
      global.emitMe = jest.fn();
      fs.writeFile('/d.txt', 'hi', (err) => {
        expect(err).toBeNull();
        expect(global.emitMe).toHaveBeenCalledWith('fs', 'writeFile', '/d.txt', 'hi', undefined);
        global.emitMe = undefined;
        done();
      });
    });

    it('calls global emitMe for promises', async () => {
      global.emitMe = jest.fn();
      await fsp.writeFile('/e.txt', 'hello');
      expect(global.emitMe).toHaveBeenCalledWith('fs', 'promises.writeFile', '/e.txt', 'hello', undefined);
      global.emitMe = undefined;
    });
  });

  describe('streams & watchers', () => {
    it('createReadStream returns a stream', () => {
      fs.writeFileSync('/f.txt', 'stream');
      const stream = fs.createReadStream('/f.txt');
      expect(stream.readable).toBe(true);
    });

    it('watch returns a watcher', () => {
      const watcher = fs.watch('/');
      expect(typeof watcher.close).toBe('function');
      watcher.close();
    });
  });
});
