// src/_http_agent.js — node:_http_agent for the browser runtime.
//
// Single source of truth: src/http.js. This module re-exports the Agent
// surface so `node:_http_agent` stays consistent with `node:http`.
// Browser note: socket pooling is metadata-only; fetch() owns connections.

export { Agent, globalAgent } from "./http.js";
import httpDefault, { Agent, globalAgent } from "./http.js";

// ponytail: the default export's globalAgent is an accessor, not a snapshot
// — Node keeps ONE backing store (lib/http.js:225 reads
// _http_agent.globalAgent; its setter writes it), so `http.globalAgent = x`
// must be visible here too. The setter writes through http's own accessor,
// which rebinds the module-scope binding in src/http.js.
export default {
  Agent,
  get globalAgent() {
    return globalAgent;
  },
  set globalAgent(value) {
    httpDefault.globalAgent = value;
  },
};
