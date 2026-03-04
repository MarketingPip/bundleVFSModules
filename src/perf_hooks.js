/**
 * perf_hooks shim - Performance measurement APIs
 * Wraps browser Performance API
 */

export const performance = globalThis.performance || {
  now: () => Date.now(),
  timeOrigin: Date.now(),
  mark: () => {},
  measure: () => {},
  getEntries: () => [],
  getEntriesByName: () => [],
  getEntriesByType: () => [],
  clearMarks: () => {},
  clearMeasures: () => {},
  clearResourceTimings: () => {}
}

export class PerformanceObserver {
  entryTypes = []

  constructor(callback) {
    this.callback = callback
  }

  observe(options) {
    this.entryTypes = options.entryTypes || (options.type ? [options.type] : [])
  }

  disconnect() {
    this.entryTypes = []
  }

  takeRecords() {
    return []
  }

  static supportedEntryTypes = ["mark", "measure", "resource", "navigation"]
}

// Histogram stub
export class Histogram {
  min = 0
  max = 0
  mean = 0
  stddev = 0
  percentiles = new Map()
  exceeds = 0

  reset() {
    this.min = 0
    this.max = 0
    this.mean = 0
    this.stddev = 0
    this.percentiles.clear()
    this.exceeds = 0
  }

  percentile(percentile) {
    return this.percentiles.get(percentile) || 0
  }
}

export function createHistogram() {
  return new Histogram()
}

export function monitorEventLoopDelay(options) {
  const histogram = new Histogram()
  return histogram
}

export default {
  performance,
  PerformanceObserver,
  createHistogram,
  monitorEventLoopDelay
}
