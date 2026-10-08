// ============================================================================
// SYNTAX CHECKER MODULE
// ============================================================================

export class SyntaxChecker {
  constructor(options = {}) {
    this.ecmaVersion = options.ecmaVersion ?? "latest";
  }

  /**
   * Check JavaScript syntax using Acorn parser
   * @param {string} code - The code to validate
   * @returns {{ valid: boolean, error?: string }}
   */
  check(code) {
    try {
      acorn.parse(code, {
        sourceType: "module",
        locations: true,
        ecmaVersion: this.ecmaVersion,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: false,
      });

      return { valid: true };
    } catch (err) {
      throw err;
    }
  }
}

// NOTE: The reference-error checker (generateGlobalBuiltInsSet,
// checkForReferenceErrors, checkForReferenceErrors2, refCheck) lived here.
// It was playground-only, so it moved to src/ui/playground.js.

/**
 * A simple EventEmitter implementation for managing custom events.
 */
class EventEmitter {
  constructor() {
    /**
     * Stores event names mapped to arrays of handler functions.
     * @type {Map<string, Function[]>}
     */
    this.events = new Map();
  }

  /**
   * Registers an event handler for a given event.
   *
   * @param {string} event - The name of the event to listen for.
   * @param {(data: any) => void} handler - The callback function to execute when the event is emitted.
   * @returns {() => void} A function to unsubscribe the handler.
   */
  on(event, handler) {
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    this.events.get(event).push(handler);
    return () => this.off(event, handler);
  }

  /**
   * Removes a specific handler for a given event.
   *
   * @param {string} event - The name of the event.
   * @param {(data: any) => void} handler - The handler function to remove.
   * @returns {void}
   */
  off(event, handler) {
    const handlers = this.events.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) handlers.splice(index, 1);
    }
  }

  /**
   * Emits an event, calling all registered handlers with the provided data.
   *
   * @param {string} event - The name of the event to emit.
   * @param {any} [data] - Optional data to pass to each handler.
   * @returns {void}
   */
  emit(event, data) {
    const handlers = this.events.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data);
        } catch (err) {
          console.error(`Error in ${event} handler:`, err);
        }
      });
    }
  }
}

