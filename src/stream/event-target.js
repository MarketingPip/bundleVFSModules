// Local stand-ins for the pieces of Node's internal/event_target used by
// node:stream. In Node these are well-known symbols recognized by the
// internal EventTarget implementation; here they are plain symbols used
// only as option keys (native addEventListener ignores unknown options,
// and the stream code only passes them through).
const kWeakHandler = Symbol('kWeakHandler');
const kResistStopPropagation = Symbol('kResistStopPropagation');

export {
  kWeakHandler,
  kResistStopPropagation,
};
