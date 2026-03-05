const EventEmitter = require("events");

const stack = [];

function active() {
  return stack.length ? stack[stack.length - 1] : null;
}

function updateProcessDomain() {
  process.domain = active();
}

class Domain extends EventEmitter {
  constructor() {
    super();
    this.members = [];
    this._disposed = false;
  }

  add(emitter) {
    if (!emitter || this._disposed) return this;

    if (emitter.domain && emitter.domain !== this) {
      emitter.domain.remove(emitter);
    }

    emitter.domain = this;
    this.members.push(emitter);

    const d = this;

    function onError(err) {
      annotate(err, {
        domain: d,
        domainEmitter: emitter,
        domainThrown: false
      });

      d.emit("error", err);
    }

    emitter.on("error", onError);
    emitter.__domainHandler = onError;

    return this;
  }

  remove(emitter) {
    const i = this.members.indexOf(emitter);
    if (i !== -1) this.members.splice(i, 1);

    if (emitter.__domainHandler) {
      emitter.removeListener("error", emitter.__domainHandler);
      delete emitter.__domainHandler;
    }

    emitter.domain = null;

    return this;
  }

  enter() {
    if (this._disposed) return;

    stack.push(this);
    Domain.active = this;
    updateProcessDomain();
  }

  exit() {
    if (this._disposed) return;

    while (stack.length) {
      const d = stack.pop();
      if (d === this) break;
    }

    Domain.active = active();
    updateProcessDomain();
  }

  run(fn, ...args) {
    if (this._disposed) return;

    this.enter();

    try {
      return fn.apply(this, args);
    } catch (err) {
      annotate(err, {
        domain: this,
        domainThrown: true
      });

      this.emit("error", err);
    } finally {
      this.exit();
    }
  }

  bind(fn) {
    const d = this;

    function bound(...args) {
      if (d._disposed) return;

      d.enter();

      try {
        return fn.apply(this, args);
      } catch (err) {
        annotate(err, {
          domain: d,
          domainBound: bound,
          domainThrown: true
        });

        d.emit("error", err);
      } finally {
        d.exit();
      }
    }

    bound.domain = d;

    return bound;
  }

  intercept(fn) {
    const d = this;

    function intercepted(err, ...args) {
      if (d._disposed) return;

      if (err) {
        annotate(err, {
          domain: d,
          domainBound: intercepted,
          domainThrown: false
        });

        d.emit("error", err);
        return;
      }

      d.enter();

      try {
        return fn.apply(this, args);
      } catch (e) {
        annotate(e, {
          domain: d,
          domainBound: intercepted,
          domainThrown: true
        });

        d.emit("error", e);
      } finally {
        d.exit();
      }
    }

    intercepted.domain = d;

    return intercepted;
  }

  dispose() {
    if (this._disposed) return;

    this._disposed = true;

    for (const m of this.members.slice()) {
      this.remove(m);
    }

    this.members.length = 0;
  }
}

function annotate(err, fields) {
  if (!err || typeof err !== "object") return;

  if (fields.domain) err.domain = fields.domain;
  if (fields.domainEmitter) err.domainEmitter = fields.domainEmitter;
  if (fields.domainBound) err.domainBound = fields.domainBound;
  if (fields.domainThrown !== undefined) err.domainThrown = fields.domainThrown;
}

Domain.active = null;

function create() {
  return new Domain();
}

module.exports = {
  create,
  createDomain: create,
  Domain,
  active
};
