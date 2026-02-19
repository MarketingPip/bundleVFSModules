/**
 * ws (WebSocket) shim for browser environment
 * Used by Vite for HMR (Hot Module Replacement)
 */

import { EventEmitter } from "events"

// Polyfill for CloseEvent (not available in Node.js)
const CloseEventPolyfill =
  typeof CloseEvent !== "undefined"
    ? CloseEvent
    : class CloseEvent extends Event {
        constructor(type, init) {
          super(type)
          this.code = init?.code ?? 1000
          this.reason = init?.reason ?? ""
          this.wasClean = init?.wasClean ?? true
        }
      }

// Polyfill for MessageEvent (not available in Node.js)
const MessageEventPolyfill =
  typeof MessageEvent !== "undefined"
    ? MessageEvent
    : class MessageEvent extends Event {
        constructor(type, init) {
          super(type)
          this.data = init?.data
        }
      }

// Message channel for communication between WebSocket server and clients
let messageChannel = null
try {
  messageChannel = new BroadcastChannel("vite-ws-channel")
} catch {
  // BroadcastChannel not available in some environments
}

// Track all server instances
const servers = new Map()
let clientIdCounter = 0

export class WebSocket extends EventEmitter {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  CONNECTING = WebSocket.CONNECTING
  OPEN = WebSocket.OPEN
  CLOSING = WebSocket.CLOSING
  CLOSED = WebSocket.CLOSED

  readyState = WebSocket.CONNECTING
  protocol = ""
  extensions = ""
  bufferedAmount = 0
  binaryType = "blob"

  _server = null
  _nativeWs = null

  // Event handler properties
  onopen = null
  onclose = null
  onerror = null
  onmessage = null

  constructor(url, protocols) {
    super()
    this.url = url
    this._id = `client-${++clientIdCounter}`

    if (protocols) {
      this.protocol = Array.isArray(protocols) ? protocols[0] : protocols
    }

    // Connect asynchronously
    setTimeout(() => this._connect(), 0)
  }

  _connect() {
    // For internal WebSocket connections (from server to client), connect immediately
    if (this.url.startsWith("internal://")) {
      this.readyState = WebSocket.OPEN
      this.emit("open")
      if (this.onopen) this.onopen(new Event("open"))
      return
    }

    // For external WebSocket connections, use the browser's native WebSocket.
    // This allows libraries like the Convex CLI (which require('ws')) to
    // communicate with real remote servers.
    if (this.url.startsWith("ws://") || this.url.startsWith("wss://")) {
      this._connectNative()
      return
    }

    // For all other URLs, use BroadcastChannel (internal Vite HMR)
    if (!messageChannel) {
      setTimeout(() => {
        this.readyState = WebSocket.OPEN
        this.emit("open")
        if (this.onopen) this.onopen(new Event("open"))
      }, 0)
      return
    }

    // Try to connect to a server via BroadcastChannel
    messageChannel.postMessage({
      type: "connect",
      clientId: this._id,
      url: this.url
    })

    // Listen for responses
    const channel = messageChannel
    const handler = event => {
      const data = event.data

      if (data.targetClient !== this._id) return

      switch (data.type) {
        case "connected":
          this.readyState = WebSocket.OPEN
          this.emit("open")
          if (this.onopen) this.onopen(new Event("open"))
          break

        case "message":
          const msgEvent = new MessageEventPolyfill("message", {
            data: data.payload
          })
          this.emit("message", msgEvent)
          if (this.onmessage) this.onmessage(msgEvent)
          break

        case "close":
          this.readyState = WebSocket.CLOSED
          const closeEvent = new CloseEventPolyfill("close", {
            code: data.code || 1000,
            reason: data.reason || "",
            wasClean: true
          })
          this.emit("close", closeEvent)
          if (this.onclose) this.onclose(closeEvent)
          channel.removeEventListener("message", handler)
          break

        case "error":
          const errorEvent = new Event("error")
          this.emit("error", errorEvent)
          if (this.onerror) this.onerror(errorEvent)
          break
      }
    }

    channel.addEventListener("message", handler)

    // Connection timeout
    setTimeout(() => {
      if (this.readyState === WebSocket.CONNECTING) {
        // No server responded, act as if connected (for standalone client use)
        this.readyState = WebSocket.OPEN
        this.emit("open")
        if (this.onopen) this.onopen(new Event("open"))
      }
    }, 100)
  }

  _connectNative() {
    // Check that the browser's native WebSocket is available and is not our own shim.
    // Only use native WebSocket in a real browser — Node.js 21+ has native WebSocket
    // but it connects to real servers, which breaks tests and isn't what the shim needs.
    const isBrowser =
      typeof window !== "undefined" && typeof window.document !== "undefined"
    const NativeWS =
      isBrowser &&
      typeof globalThis.WebSocket === "function" &&
      globalThis.WebSocket !== WebSocket
        ? globalThis.WebSocket
        : null

    if (!NativeWS) {
      // No native WebSocket (test env, Node.js, etc.) — act as if connected
      setTimeout(() => {
        this.readyState = WebSocket.OPEN
        this.emit("open")
        if (this.onopen) this.onopen(new Event("open"))
      }, 0)
      return
    }

    try {
      this._nativeWs = new NativeWS(this.url)
      this._nativeWs.binaryType =
        this.binaryType === "arraybuffer" ? "arraybuffer" : "blob"
    } catch {
      this.readyState = WebSocket.CLOSED
      const errorEvent = new Event("error")
      this.emit("error", errorEvent)
      if (this.onerror) this.onerror(errorEvent)
      return
    }

    this._nativeWs.onopen = () => {
      this.readyState = WebSocket.OPEN
      this.emit("open")
      if (this.onopen) this.onopen(new Event("open"))
    }

    this._nativeWs.onmessage = event => {
      const msgEvent = new MessageEventPolyfill("message", { data: event.data })
      this.emit("message", msgEvent)
      if (this.onmessage) this.onmessage(msgEvent)
    }

    this._nativeWs.onclose = event => {
      this.readyState = WebSocket.CLOSED
      this._nativeWs = null
      const closeEvent = new CloseEventPolyfill("close", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean
      })
      this.emit("close", closeEvent)
      if (this.onclose) this.onclose(closeEvent)
    }

    this._nativeWs.onerror = () => {
      const errorEvent = new Event("error")
      this.emit("error", errorEvent)
      if (this.onerror) this.onerror(errorEvent)
    }
  }

  send(data) {
    if (this.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open")
    }

    // If connected to native WebSocket (external server)
    if (this._nativeWs) {
      this._nativeWs.send(data)
      return
    }

    // If connected to internal server
    if (this._server) {
      this._server._handleClientMessage(this, data)
      return
    }

    // Send via BroadcastChannel
    if (messageChannel) {
      messageChannel.postMessage({
        type: "message",
        clientId: this._id,
        url: this.url,
        payload: data
      })
    }
  }

  close(code, reason) {
    if (
      this.readyState === WebSocket.CLOSED ||
      this.readyState === WebSocket.CLOSING
    ) {
      return
    }

    this.readyState = WebSocket.CLOSING

    // If connected to native WebSocket, close it (onclose handler emits events)
    if (this._nativeWs) {
      this._nativeWs.close(code, reason)
      return
    }

    if (messageChannel) {
      messageChannel.postMessage({
        type: "disconnect",
        clientId: this._id,
        url: this.url,
        code,
        reason
      })
    }

    setTimeout(() => {
      this.readyState = WebSocket.CLOSED
      const closeEvent = new CloseEventPolyfill("close", {
        code: code || 1000,
        reason: reason || "",
        wasClean: true
      })
      this.emit("close", closeEvent)
      if (this.onclose) this.onclose(closeEvent)
    }, 0)
  }

  ping() {
    // No-op in browser
  }

  pong() {
    // No-op in browser
  }

  terminate() {
    if (this._nativeWs) {
      this._nativeWs.close()
      this._nativeWs = null
    }
    this.readyState = WebSocket.CLOSED
    const closeEvent = new CloseEventPolyfill("close", {
      code: 1006,
      reason: "Connection terminated",
      wasClean: false
    })
    this.emit("close", closeEvent)
    if (this.onclose) this.onclose(closeEvent)
  }

  // For internal server use
  _setServer(server) {
    this._server = server
  }

  _receiveMessage(data) {
    const msgEvent = new MessageEventPolyfill("message", { data })
    this.emit("message", msgEvent)
    if (this.onmessage) this.onmessage(msgEvent)
  }
}

export class WebSocketServer extends EventEmitter {
  clients = new Set()
  _channelHandler = null

  constructor(options = {}) {
    super()
    this.options = options
    this._path = options.path || "/"

    // If not noServer, set up listening
    if (!options.noServer) {
      this._setupListener()
    }

    // Register server
    servers.set(this._path, this)
  }

  _setupListener() {
    if (!messageChannel) return

    const channel = messageChannel
    this._channelHandler = event => {
      const data = event.data

      if (data.type === "connect") {
        // Create a new WebSocket for this client
        const ws = new WebSocket("internal://" + this._path)
        ws._setServer(this)
        ws._clientId = data.clientId
        this.clients.add(ws)

        // Notify client of connection
        channel.postMessage({
          type: "connected",
          targetClient: data.clientId
        })

        // Emit connection event
        this.emit("connection", ws, { url: data.url })
      }

      if (data.type === "message") {
        // Find the client and deliver the message
        for (const client of this.clients) {
          if (client._clientId === data.clientId) {
            client._receiveMessage(data.payload)
            break
          }
        }
      }

      if (data.type === "disconnect") {
        for (const client of this.clients) {
          if (client._clientId === data.clientId) {
            client.close(data.code, data.reason)
            this.clients.delete(client)
            break
          }
        }
      }
    }

    channel.addEventListener("message", this._channelHandler)
  }

  _handleClientMessage(client, data) {
    // Broadcast to server-side handlers
    const msgEvent = new MessageEventPolyfill("message", { data })
    client.emit("message", msgEvent)
  }

  handleUpgrade(request, socket, head, callback) {
    // Create WebSocket for this upgrade
    const ws = new WebSocket("internal://" + this._path)
    ws._setServer(this)

    if (this.options.clientTracking !== false) {
      this.clients.add(ws)
    }

    // Async callback
    setTimeout(() => {
      callback(ws, request)
      this.emit("connection", ws, request)
    }, 0)
  }

  close(callback) {
    // Close all clients
    for (const client of this.clients) {
      client.close(1001, "Server shutting down")
    }
    this.clients.clear()

    // Remove from registry
    servers.delete(this._path)

    // Remove channel listener
    if (this._channelHandler && messageChannel) {
      messageChannel.removeEventListener("message", this._channelHandler)
      this._channelHandler = null
    }

    this.emit("close")

    if (callback) {
      setTimeout(callback, 0)
    }
  }

  address() {
    return {
      port: this.options.port || 0,
      family: "IPv4",
      address: this.options.host || "0.0.0.0"
    }
  }
}

// Export WebSocket and Server
export default WebSocket
export const Server = WebSocketServer

// Additional exports for compatibility
export const createWebSocketStream = () => {
  throw new Error("createWebSocketStream is not supported in browser")
}
