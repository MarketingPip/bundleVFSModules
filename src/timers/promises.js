import {
  setTimeout,
  setImmediate,
  setInterval,
  scheduler,
} from 'node-internal:internal_timers_promises';

export * from 'node-internal:internal_timers_promises';

export default {
  setTimeout,
  setImmediate,
  setInterval,
  scheduler,
};
