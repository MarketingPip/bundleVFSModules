/**
 * dgram shim - UDP sockets are not available in browser
 */

import { EventEmitter } from "./events"

export class Socket extends EventEmitter {
  constructor() {
    super()
    this._peerConnection = new RTCPeerConnection()
    this._dataChannel = this._peerConnection.createDataChannel("udpShim")
    this._setupDataChannel()
  }

  _setupDataChannel() {
    this._dataChannel.onopen = () => {
      this.emit("listening")
    }
    this._dataChannel.onmessage = (event) => {
      const msg = typeof event.data === "string"
        ? new TextEncoder().encode(event.data)
        : new Uint8Array(event.data)
      this.emit("message", msg, { address: "peer", port: 0, family: "IPv4" })
    }
  }

  async bind(_port, _address, callback) {
    // For WebRTC, binding is mostly a no-op
    if (callback) setTimeout(callback, 0)
    return this
  }

  async send(msg, offset = 0, length = msg.length, _port, _address, callback) {
    if (this._dataChannel.readyState !== "open") {
      if (callback) setTimeout(() => callback(new Error("DataChannel not open")), 0)
      return
    }
    const slice = msg.slice(offset, offset + length)
    this._dataChannel.send(slice)
    if (callback) setTimeout(() => callback(null, slice.length), 0)
  }

  close(callback) {
    if (this._dataChannel) this._dataChannel.close()
    if (this._peerConnection) this._peerConnection.close()
    if (callback) setTimeout(callback, 0)
    this.emit("close")
  }

  address() {
    return { address: "0.0.0.0", family: "IPv4", port: 0 }
  }

  // No-op methods for compatibility
  setBroadcast() {}
  setTTL(ttl) { return ttl }
  setMulticastTTL(ttl) { return ttl }
  setMulticastLoopback(flag) { return flag }
  setMulticastInterface() {}
  addMembership() {}
  dropMembership() {}
  ref() { return this }
  unref() { return this }
  setRecvBufferSize() {}
  setSendBufferSize() {}
  getRecvBufferSize() { return 0 }
  getSendBufferSize() { return 0 }
}

export function createSocket(type, callback) {
  const s = new Socket()
  if (callback) s.on("message", callback)
  return s
}

export default { Socket, createSocket }
