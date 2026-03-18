import dc, { channel, hasSubscribers, subscribe, unsubscribe } from '../src/diagnostics_channel.js';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
describe('diagnostics_channel shim', () => {
  const CHANNEL_NAME = 'test:event';

  beforeEach(() => {
    // Ensure we start with a clean state if your shim stores channels globally
    const testChannel = channel(CHANNEL_NAME);
    // If your shim doesn't have a reset, we just manage listeners manually
  });

  test('channel() should return a Channel object with a name', () => {
    const ch = channel(CHANNEL_NAME);
    expect(ch.name).toBe(CHANNEL_NAME);
  });

  test('should trigger subscriber when message is published', () => {
    const ch = channel(CHANNEL_NAME);
    const mockSubscriber = jest.fn();
    
    subscribe(CHANNEL_NAME, mockSubscriber);
    
    const data = { foo: 'bar' };
    ch.publish(data);

    expect(mockSubscriber).toHaveBeenCalledWith(data, CHANNEL_NAME);
    
    // Cleanup
    unsubscribe(CHANNEL_NAME, mockSubscriber);
  });

  test('hasSubscribers() should correctly reflect state', () => {
    const ch = channel('empty:channel');
    expect(hasSubscribers('empty:channel')).toBe(false);

    const callback = () => {};
    subscribe('empty:channel', callback);
    expect(hasSubscribers('empty:channel')).toBe(true);

    unsubscribe('empty:channel', callback);
    expect(hasSubscribers('empty:channel')).toBe(false);
  });

  test('Channel.publish() should work via the instance', () => {
    const ch = channel('instance:test');
    const mockSubscriber = jest.fn();
    
    ch.subscribe(mockSubscriber);
    ch.publish({ status: 'ok' });
    
    expect(mockSubscriber).toHaveBeenCalled();
    ch.unsubscribe(mockSubscriber);
  });

  test('should handle multiple subscribers for the same channel', () => {
    const ch = channel('multi:test');
    const sub1 = jest.fn();
    const sub2 = jest.fn();

    subscribe('multi:test', sub1);
    subscribe('multi:test', sub2);

    ch.publish('hello');

    expect(sub1).toHaveBeenCalledTimes(1);
    expect(sub2).toHaveBeenCalledTimes(1);

    unsubscribe('multi:test', sub1);
    unsubscribe('multi:test', sub2);
  });
});
