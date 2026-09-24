// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
class TaskTracker {
  constructor() {
    this.pendingCount = 0;
    this.resolvers = [];
  }

  // Wraps any function (sync or async)
  track(fn) {
    const self = this;
    return async function(...args) {
      self.pendingCount++;
      try {
        return await fn.apply(this, args);
      } finally {
        self.pendingCount--;
        if (self.pendingCount === 0) {
          self._notify();
        }
      }
    };
  }

  // The equivalent to your waitForAllTimers()
  waitForIdle() {
    if (this.pendingCount === 0) return Promise.resolve();
    return new Promise(resolve => this.resolvers.push(resolve));
  }
 
  _notify() {
    while (this.resolvers.length) {
      this.resolvers.shift()();
    }
  }
}




const channel = new MessageChannel();

/*
TODO: Build stream protocol over message passing (fetch for streams etc.)

const requestPort = channel.port1;
const responsePort = new MessageChannel().port1;
const responsePortRemote = new MessageChannel().port2;
*/

Object.getOwnPropertyNames(globalThis).forEach(name => {
  // Skip internal properties, the runtime itself, and 'globalThis' to avoid recursion
  if (
    !name.startsWith('_') &&
    name !== 'globalThis'
    // (the Symbol-keyed runtime is not in getOwnPropertyNames, so no check needed)
  ) {
    Object.defineProperty(globalThis[_BVM_RT_KEY_].globals, name, {
      get: () => globalThis[name],
      enumerable: true,
      configurable: true
    });
  }
});

(async () => {


const GlobalTracker = {
  activeTasks: 0,
  resolvers: [],
  // Increments the counter
  start() {
    this.activeTasks++;
  },

  // Decrements and checks if we are done
  stop() {
    this.activeTasks--;
    if (this.activeTasks === 0) {
      while (this.resolvers.length) this.resolvers.shift()();
    }
  },

  // The waiter function
  waitForAll: function() {
    if (this.activeTasks === 0) return Promise.resolve();
    return new Promise(res => this.resolvers.push(res));
  },

  // The Magic: This patches any function you point it at
  patch: function(obj, methodName) {
    const original = obj[methodName];
    const self = this;

    obj[methodName] = function(...args) {
      self.start();
      try {
        const result = original.apply(this, args);
        
        // Handle Async/Promises
        if (result instanceof Promise || result && typeof result.then === "function") {
          return result.finally(() => self.stop());
        }

        // Handle Sync
        self.stop();
        return result;
      } catch (e) {
        self.stop();
        throw e;
      }
    };
  },
  patchChildProcess(fn) {
    return (...args) => {
      this.start();
      try {
        const child = fn(...args);
        let stopped = false;
        const stopOnce = () => {
          if (stopped) return;
          stopped = true;
          this.stop();
        };
        child.once('close', stopOnce);
        child.once('error', stopOnce);
        return child;
      } catch (err) {
        this.stop();
        throw err;
      }
    }
  },
  patchChildProcess2(fn) {
    return (...args) => {
      this.start(); // Start tracking when exec/spawn is called
      
      try {
        const child = fn(...args);
        
        // Listen for the final event to stop tracking
        // We use 'once' to ensure we only decrement once
        child.once('close', () => this.stop());
        
        // Also handle cases where the process might error out immediately
        child.once('error', (err) => {
          // Only stop if 'close' hasn't fired yet
          if (child.exitCode === null) this.stop();
        });

        return child;
      } catch (err) {
        this.stop(); // Stop if the synchronous part fails (like execSync)
        throw err;
      }
    }
  },
  
}; 
 
globalThis[_BVM_RT_KEY_].taskTracker = GlobalTracker;

// _RUNTIME_SANDBOX_UUID_.taskTracker.patch(myUtils, 'calculate');


