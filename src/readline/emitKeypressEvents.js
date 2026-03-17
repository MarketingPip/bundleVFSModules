// readline/emitKeypressEvents.js
// npm install string_decoder

/*!
 * readline/emitKeypressEvents — attaches keypress parsing to a Readable stream
 * Ported from Node.js internal/readline/emitKeypressEvents (MIT / Joyent)
 *
 * Limitations: Only useful when the stream is already in raw/character mode.
 *   In a browser there is no kernel TTY driver, so applications must feed raw
 *   characters manually (e.g. from a WebSocket or a custom input handler).
 */

import { StringDecoder } from 'string_decoder';
import { CSI, charLengthAt, emitKeys } from './utils.js';
import { kSawKeyPress } from './interface.js';

const { kEscape } = CSI;

const KEYPRESS_DECODER = Symbol('keypress-decoder');
const ESCAPE_DECODER   = Symbol('escape-decoder');

// GNU readline default: 500 ms
const ESCAPE_CODE_TIMEOUT = 500;

/**
 * Causes `stream` to emit `'keypress'` events for each character it receives.
 *
 * Mirrors Node's `readline.emitKeypressEvents(stream[, interface])` exactly.
 *
 * @param {import('stream').Readable & { emit: Function }} stream
 * @param {{ escapeCodeTimeout?: number; [kSawKeyPress]?: boolean; isCompletionEnabled?: boolean }} [iface]
 */
function emitKeypressEvents(stream, iface = {}) {
  // Idempotent: only install once per stream.
  if (stream[KEYPRESS_DECODER]) return;

  stream[KEYPRESS_DECODER] = new StringDecoder('utf8');
  stream[ESCAPE_DECODER]   = emitKeys(stream);
  stream[ESCAPE_DECODER].next(); // prime the generator

  const { escapeCodeTimeout = ESCAPE_CODE_TIMEOUT } = iface;
  let timeoutId;

  const triggerEscape = () => stream[ESCAPE_DECODER].next('');

  function onData(input) {
    if (stream.listenerCount('keypress') > 0) {
      const string = stream[KEYPRESS_DECODER].write(input);
      if (string) {
        globalThis.clearTimeout(timeoutId);

        // Track whether the last keypress consumed exactly one character
        // (used by the interface to decide whether to complete).
        iface[kSawKeyPress] = charLengthAt(string, 0) === string.length;
        iface.isCompletionEnabled = false;

        let length = 0;
        for (const character of string) {         // iterates Unicode code points
          length += character.length;
          if (length === string.length) iface.isCompletionEnabled = true;

          try {
            stream[ESCAPE_DECODER].next(character);
            // If the last character is ESC, start the escape-code timeout window
            if (length === string.length && character === kEscape) {
              timeoutId = globalThis.setTimeout(triggerEscape, escapeCodeTimeout);
            }
          } catch (err) {
            // If the generator throws (e.g. re-thrown from a keypress listener),
            // reset it so the stream keeps working.
            stream[ESCAPE_DECODER] = emitKeys(stream);
            stream[ESCAPE_DECODER].next();
            throw err;
          }
        }
      }
    } else {
      // No listeners — stop processing until someone subscribes again.
      stream.removeListener('data', onData);
      stream.on('newListener', onNewListener);
    }
  }

  function onNewListener(event) {
    if (event === 'keypress') {
      stream.on('data', onData);
      stream.removeListener('newListener', onNewListener);
    }
  }

  if (stream.listenerCount('keypress') > 0) {
    stream.on('data', onData);
  } else {
    stream.on('newListener', onNewListener);
  }
}

export default emitKeypressEvents;
export { emitKeypressEvents };
