// diagnostics_channel: Node v24.20.0 exposes only the lowercase
// `tracingChannel` factory — the uppercase `TracingChannel` class must NOT
// be a public export.
import dc, * as ns from '../src/diagnostics_channel.js';
import {
  Channel, channel, hasSubscribers, subscribe, tracingChannel, unsubscribe,
} from '../src/diagnostics_channel.js';
import { describe, test, expect } from '@jest/globals';

describe('diagnostics_channel export surface', () => {
  test('TracingChannel (uppercase) is NOT exported', () => {
    expect('TracingChannel' in ns).toBe(false);
    expect(dc.TracingChannel).toBe(undefined);
  });

  test('the public surface matches Node exactly', () => {
    const keys = Object.keys(ns).filter((k) => k !== 'default').sort();
    expect(keys).toEqual(
      ['Channel', 'channel', 'hasSubscribers', 'subscribe', 'tracingChannel', 'unsubscribe'],
    );
  });

  test('lowercase tracingChannel factory still works', () => {
    const tc = tracingChannel('export-test');
    expect(typeof tc.subscribe).toBe('function');
    expect(typeof tc.unsubscribe).toBe('function');
    expect(typeof tc.traceSync).toBe('function');
    expect(typeof tc.tracePromise).toBe('function');
    expect(tc.hasSubscribers).toBe(false);
    expect(tracingChannel).toBe(dc.tracingChannel);
  });

  test('pre-existing exports are untouched', () => {
    expect(typeof Channel).toBe('function');
    expect(channel('still:works').name).toBe('still:works');
    expect(typeof hasSubscribers).toBe('function');
    expect(typeof subscribe).toBe('function');
    expect(typeof unsubscribe).toBe('function');
  });
});
