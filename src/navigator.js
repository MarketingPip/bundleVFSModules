// npm install os-browserify process

/*!
 * node-navigator — Browser navigator API implementation for Node.js
 * MIT License.
 * Node.js parity: standard web Navigator interface in Node.js
 * Dependencies: os-browserify, process
 * Limitations: Stubs hardware/interactive APIs like mediaDevices and geolocation where appropriate.
 */

/**
 * @packageDocumentation
 * Provides a spec-compliant `navigator` global object for Node.js environments.
 * Useful for isomorphic code, server-side rendering (SSR), and testing browser libraries in Node.
 */

import os from './os';
const process = globalThis.process;

// ---------------------------------------------------------------------------
// Helper Mappings
// ---------------------------------------------------------------------------

/**
 * Maps Node.js process.platform to browser-like platform strings.
 * @param {string} platform 
 * @returns {string}
 */
function getPlatformString(platform) {
  switch (platform) {
    case 'darwin': return 'MacIntel';
    case 'win32': return 'Win32';
    case 'linux': return 'Linux x86_64';
    default: return 'Unknown';
  }
}

// ---------------------------------------------------------------------------
// Navigator Implementation
// ---------------------------------------------------------------------------

export const navigator = {
  /** User agent string reflecting Node.js runtime details. */
  userAgent: `Mozilla/5.0 (${os.type()} ${os.arch()}) Node.js/${process.version}`,
  
  /** Platform identifier. */
  platform: getPlatformString(process.platform),
  
  /** Vendor name. */
  vendor: 'Node.js Foundation',
  
  /** System language preference from environment. */
  language: (process.env.LANG || 'en-US').split('.')[0].replace('_', '-'),
  
  /** Languages array. */
  languages: [ (process.env.LANG || 'en-US').split('.')[0].replace('_', '-') ],
  
  /** Online status indicator. */
  onLine: true,
  
  /** Logical processor count. */
  hardwareConcurrency: os.cpus().length || 1,
  
  /** Approximate device memory in gigabytes. */
  deviceMemory: Math.round(os.totalmem() / (1024 * 1024 * 1024 * 1024)) || 8,
  
  /** Cookie enabled status. */
  cookieEnabled: false,

  // -------------------------------------------------------------------------
  // API Stubs & Sub-interfaces
  // -------------------------------------------------------------------------
  
  geolocation: {
    /** @param {Function} success @param {Function} [error] */
    getCurrentPosition(success, error) {
      if (error) error({ code: 1, message: 'Geolocation not supported in Node.js environment' });
    },
    /** @param {Function} success @param {Function} [error] */
    watchPosition(success, error) {
      if (error) error({ code: 1, message: 'Geolocation not supported in Node.js environment' });
      return 0;
    },
    clearWatch() {}
  },

  connection: {
    effectiveType: '4g',
    rtt: 50,
    downlink: 10,
    saveData: false,
    addEventListener() {},
    removeEventListener() {}
  },

  mediaDevices: {
    async enumerateDevices() {
      return [];
    },
    async getUserMedia() {
      throw new DOMException('MediaDevices.getUserMedia is not supported in Node.js', 'NotSupportedError');
    }
  },

  /**
   * Installs the navigator object onto the global scope if not already present.
   */
  install() {
    if (typeof globalThis.navigator === 'undefined') {
      globalThis.navigator = this;
    }
  }
};

export default navigator;

// --- Usage ---
// import { navigator } from './node-navigator.js';
// 
// console.log(navigator.userAgent);
// // → 'Mozilla/5.0 (Linux x86_64) Node.js/v20.11.0'
//
// console.log(navigator.hardwareConcurrency);
// // → 8 (Logical CPU count)
//
// // Attach to global scope for isomorphic libraries
// navigator.install();
// console.log(globalThis.navigator.platform);
