// src/_http_agent.js — node:_http_agent for the browser runtime.
//
// Single source of truth: src/http.js. This module re-exports the Agent
// surface so `node:_http_agent` stays consistent with `node:http`.
// Browser note: socket pooling is metadata-only; fetch() owns connections.

export { Agent, globalAgent } from './http.js';
import { Agent, globalAgent } from './http.js';

export default { Agent, globalAgent };
