// timers/promise.js

import timers from '../timers.js'; // Import your timers polyfill

/**
 * Returns a promise that resolves after the specified delay.
 * Matches Node.js timers/promises API for setTimeout.
 * @param {number} delay - The delay in milliseconds.
 * @param {...any} args - Arguments passed to the callback when resolved.
 * @returns {Promise<void>} A promise that resolves after the specified delay.
 */
export function setTimeout(delay, ...args) {
  return new Promise((resolve) => {
    const timeout = timers.setTimeout(() => {
      resolve(...args);  // Resolves with any passed arguments
    }, delay);
    timeout.close = timeout.close.bind(timeout);  // Ensure proper cleanup
  });
}

/**
 * Returns a promise that resolves periodically after each interval.
 * Matches Node.js timers/promises API for setInterval.
 * @param {number} delay - The delay in milliseconds.
 * @param {...any} args - Arguments passed to the callback when resolved.
 * @returns {Promise<void>} A promise that resolves after each interval.
 */
export function setInterval(delay, ...args) {
  return new Promise((resolve, reject) => {
    const interval = timers.setInterval(() => {
      resolve(...args);  // Resolves with any passed arguments
    }, delay);

    // Make sure interval can be canceled
    interval.close = interval.close.bind(interval);

    // Optional: reject promise after a timeout to avoid infinite intervals (use case based)
    // For example, we could set an upper limit here if needed
    // setTimeout(() => interval.close(), 10000);  // Auto cancel after 10 seconds
  });
}

/**
 * Returns a promise that resolves in the next event loop cycle.
 * Matches Node.js timers/promises API for setImmediate.
 * @param {...any} args - Arguments passed to the callback when resolved.
 * @returns {Promise<void>} A promise that resolves immediately after the current event loop.
 */
export function setImmediate(...args) {
  return new Promise((resolve) => {
    const immediate = timers.setImmediate(() => {
      resolve(...args);  // Resolves with any passed arguments
    });
    immediate.close = immediate.close.bind(immediate);  // Ensure proper cleanup
  });
}

export default {
  setTimeout,
  setInterval,
  setImmediate,
};
