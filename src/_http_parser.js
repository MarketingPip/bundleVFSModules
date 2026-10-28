// src/_http_parser.js — incremental HTTP/1.x message parser for the virtual
// server's real socket connections.
//
// Dependency note (docs/SHIM_AUTHORING.md rule 1, evaluated 2026-09-26):
// llhttp's npm package (1.0.1) ships the TypeScript parser *generator* API,
// not a runnable parser — there is no maintained, bundle-clean HTTP parser on
// npm, and http-parser-js is unmaintained. So this strict-subset parser is
// hand-rolled and differential-tested against node:http.
//
// Supported: HTTP/1.0 and HTTP/1.1 request and response messages, header
// blocks, Content-Length bodies, chunked transfer encoding, pipelining and
// keep-alive. Deliberately out of scope: chunk extensions (accepted, ignored),
// trailers (consumed, dropped), Upgrade/WebSocket, and obsolete line folding
// (rejected with an error, like llhttp).

// Buffer comes from the local port (like src/crypto.js / src/dns.js), never
// the Node global — this module must also run in the browser sandbox where
// no global Buffer exists (node_globals.js installs one for the full
// runtime, but unit consumers shouldn't depend on it).
import { Buffer } from "./buffer.js";

const CR = 0x0d;
const LF = 0x0a;

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEX_RE = /^[0-9A-Fa-f]+$/;

// llhttp validates the request method against its known-method table
// (case-sensitive); anything else is HPE_INVALID_METHOD. Mirrors METHODS in
// src/http.js (importing it here would be circular).
const KNOWN_METHODS = new Set([
  "ACL",
  "BIND",
  "CHECKOUT",
  "CONNECT",
  "COPY",
  "DELETE",
  "GET",
  "HEAD",
  "LINK",
  "LOCK",
  "M-SEARCH",
  "MERGE",
  "MKACTIVITY",
  "MKCALENDAR",
  "MKCOL",
  "MOVE",
  "NOTIFY",
  "OPTIONS",
  "PATCH",
  "POST",
  "PROPFIND",
  "PROPPATCH",
  "PURGE",
  "PUT",
  "QUERY",
  "REBIND",
  "REPORT",
  "SEARCH",
  "SOURCE",
  "SUBSCRIBE",
  "TRACE",
  "UNBIND",
  "UNLINK",
  "UNLOCK",
  "UNSUBSCRIBE",
]);

// For an invalid method, llhttp's bytesParsed is how many leading bytes of
// the token matched a known method's prefix before failing (probed on real
// Node v24.22.1: "GETX" -> 3, "GE" -> 2, "FOO" -> 1, "XFOO"/"1ABC" -> 0).
// Quirk of the real parser's minimized method DFA, also probed: 'F' counts
// ("FA" -> 1) and "FL" counts twice ("FL" -> 2), though no known method
// starts with F — reproduced so bytesParsed matches byte for byte.
function methodBytesParsed(token) {
  let n = 0;
  for (const m of KNOWN_METHODS) {
    let k = 0;
    while (k < token.length && k < m.length && token[k] === m[k]) k++;
    if (k > n) n = k;
  }
  if (n === 0 && token[0] === "F") {
    n = token.length > 1 && token[1] === "L" ? 2 : 1;
  }
  return n;
}

function parseError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export class HTTPParser {
  /**
   * @param {'request'|'response'} type
   */
  constructor(type) {
    if (type !== "request" && type !== "response") {
      throw new TypeError('HTTPParser type must be "request" or "response"');
    }
    this.type = type;
    // Mirrors Node's default maxHeaderSize (16 KiB); the server may override.
    this.maxHeaderSize = 16 * 1024;
    // For responses to HEAD requests: no body regardless of framing.
    // The client sets this before parsing (Node's parser._isHeadResponse).
    this.isHeadResponse = false;
    this._buf = Buffer.alloc(0);
    this._off = 0;
    // When true, the parser stops after each complete message ('paused'
    // state) instead of immediately starting the next one. The HTTP server
    // uses this for strict one-request-at-a-time pipelining: it resumes the
    // parser only after the in-flight response finishes.
    this.pauseBetweenMessages = false;
    this._resetMessage();
    // Callbacks, assigned by the owner:
    this.onHeadersComplete = null; // (info)
    this.onBody = null; // (chunk: Buffer)
    this.onMessageComplete = null; // ()
    this.onError = null; // (err)
    // Fires once when the parser starts consuming a new message's first
    // bytes (first message at stream start, later messages when resumed
    // after a pause). The HTTP server uses it to start that request's
    // headersTimeout/requestTimeout clock.
    this.onMessageStart = null; // ()
  }

  _resetMessage() {
    this._state = "start-line";
    this._info = null;
    this._rawHeaders = [];
    this._chunkState = null;
    this._remaining = 0;
    this._headStart = this._off;
    this._headerBytes = 0;
    this._messageStarted = false;
  }

  /**
   * Feed bytes into the parser. Returns when more data is needed, the stream
   * ended cleanly between messages, or a fatal parse error occurred
   * (reported via onError; further chunks re-report the same failure —
   * llhttp stays in its error state, so a second chunk after the first
   * error surfaces a second clientError with the new chunk as rawPacket,
   * test-http-server-multiple-client-error. A re-parse with no new input
   * (pipelined-remainder validation) reports nothing).
   */
  execute(chunk) {
    const bytes =
      chunk && chunk.length
        ? chunk instanceof Uint8Array
          ? chunk
          : Buffer.from(chunk)
        : null;
    if (this._state === "error") {
      if (bytes && this._fatalCode && this.onError) {
        const err = parseError(this._fatalCode, this._fatalMessage);
        err.bytesParsed = -1;
        err.rawPacket = bytes;
        this.onError(err);
      }
      return;
    }
    if (bytes) {
      // Compact: drop consumed prefix so the buffer cannot grow unboundedly.
      this._buf =
        this._off === 0
          ? Buffer.concat([this._buf, bytes])
          : Buffer.concat([this._buf.subarray(this._off), bytes]);
      this._headStart = this._headStart - this._off;
      this._off = 0;
    }
    try {
      for (;;) {
        // A new message starts the moment its first bytes are consumed:
        // a partial start line with no CRLF yet still counts (its clock
        // must run while the client stalls mid-line). Between messages
        // (paused/complete/error) nothing starts.
        if (
          !this._messageStarted &&
          this._state !== "paused" &&
          this._state !== "complete" &&
          this._state !== "error" &&
          this._off < this._buf.length
        ) {
          this._messageStarted = true;
          if (this.onMessageStart) this.onMessageStart();
        }
        switch (this._state) {
          case "start-line":
            if (!this._parseStartLine()) return;
            break;
          case "headers":
            if (!this._parseHeaders()) return;
            break;
          case "body-fixed":
            if (!this._parseFixedBody()) return;
            break;
          case "body-chunked":
            if (!this._parseChunkedBody()) return;
            break;
          case "body-eof": {
            // Unframed response body: stream what arrived, wait for end().
            const avail = this._buf.length - this._off;
            if (avail > 0) {
              if (this.onBody) this.onBody(this._buf.subarray(this._off));
              this._off = this._buf.length;
            }
            return;
          }
          case "paused":
            return; // between messages; owner resumes via unpause()
          case "complete":
            this._resetMessage();
            break;
          default:
            return;
        }
      }
    } catch (err) {
      this._state = "error";
      // Only llhttp-coded failures re-report on later chunks; a throw from
      // an owner callback is not a parse failure and must not synthesize
      // one (its code is not an HPE_ code).
      if (typeof err.code === "string" && err.code.startsWith("HPE_")) {
        this._fatalCode = err.code;
        this._fatalMessage = err.message;
      }
      // Node's clientError/socket-error shape: rawPacket is the chunk that
      // triggered this execute (llhttp's per-execute input); a re-parse
      // with no new chunk reports the buffered remainder instead.
      // bytesParsed falls back to the bytes consumed for this message.
      if (err.rawPacket === undefined) {
        err.rawPacket = bytes
          ? bytes
          : Buffer.from(this._buf.subarray(this._headStart));
      }
      if (err.bytesParsed === undefined) {
        err.bytesParsed = Math.max(0, this._off - this._headStart);
      }
      if (this.onError) this.onError(err);
    }
  }

  /**
   * Signal end-of-stream. Completes a response body that runs to EOF;
   * anything else mid-message is a truncation error.
   */
  end() {
    if (this._state === "error") return;
    if (this._state === "body-eof") {
      this._finishMessage();
      return;
    }
    if (this._state === "complete" || this._state === "paused") return;
    // Clean EOF between messages: nothing buffered, nothing expected.
    if (this._off >= this._buf.length) return;
    this._state = "error";
    if (this.onError) {
      this.onError(
        parseError("HPE_TRUNCATED", "unexpected end of stream mid-message"),
      );
    }
  }

  // -- internals ----------------------------------------------------------

  /** Find the next CRLF-terminated line; null when incomplete. */
  _findLine(skipSizeCheck = false) {
    const buf = this._buf;
    for (let i = this._off; i + 1 < buf.length; i++) {
      if (buf[i] === CR && buf[i + 1] === LF) {
        const text = buf.toString("latin1", this._off, i);
        const next = i + 2;
        return { text, next };
      }
    }
    if (!skipSizeCheck && buf.length - this._headStart > this.maxHeaderSize) {
      throw parseError(
        "HPE_HEADER_OVERFLOW",
        `header block exceeds maxHeaderSize of ${this.maxHeaderSize} bytes`,
      );
    }
    return null;
  }

  /**
   * Judge a partial (CRLF-less) start-line remainder eagerly: llhttp is
   * a byte-level machine and rejects an invalid start line without
   * waiting for its CRLF — e.g. the garbage after a blank header block
   * in test-http-blank-header ("hello world") must produce a 400, not
   * a wait for bytes that never come, and a lone "1" byte in
   * test-http-server-multiple-client-error must surface its clientError
   * at once (rawPacket "1"), not after the rest of the line arrives.
   * Viability is monotone: a token that is not a prefix of any known
   * method can never become one by gaining bytes, so an early throw
   * matches llhttp exactly. A viable prefix (or an empty remainder)
   * returns silently to wait for more bytes.
   */
  _judgePartialStartLine() {
    if (this._off >= this._buf.length) return;
    const partial = this._buf.toString("latin1", this._off);
    if (this.type === "request") {
      const sp = partial.indexOf(" ");
      const token = sp < 0 ? partial : partial.slice(0, sp);
      const viable =
        token.length > 0 &&
        TOKEN_RE.test(token) &&
        (sp >= 0
          ? KNOWN_METHODS.has(token)
          : [...KNOWN_METHODS].some((m) => m.startsWith(token)));
      if (!viable) {
        const err = parseError(
          "HPE_INVALID_METHOD",
          `invalid method: ${token}`,
        );
        err.bytesParsed = methodBytesParsed(token);
        throw err;
      }
    } else if (
      partial.length > 0 &&
      !"HTTP/".startsWith(partial.slice(0, 5)) &&
      !partial.startsWith("HTTP/")
    ) {
      throw parseError(
        "HPE_INVALID_CONSTANT",
        `invalid response prefix: ${partial.slice(0, 10)}`,
      );
    }
  }

  _parseStartLine() {
    let found = this._findLine();
    if (!found) {
      // No complete line yet: judge the partial remainder eagerly
      // (llhttp is byte-level — a non-viable method token errors at
      // once, it does not wait for the line's CRLF).
      this._judgePartialStartLine();
      return false;
    }
    // llhttp ignores empty lines preceding the start line (RFC 9112
    // section 4: a recipient MUST ignore at least one empty line
    // before the request line). A pipelined request preceded by a
    // stray CRLF is not a parse error
    // (test-http-incoming-pipelined-socket-destroy writes one).
    while (found.text === "") {
      this._off = found.next;
      found = this._findLine();
      if (!found) break;
    }
    if (!found) {
      // Remainder after skipped empty lines: same eager judgment.
      this._judgePartialStartLine();
      return false;
    }
    const line = found.text;
    this._off = found.next;
    this._headerBytes = (this._headerBytes || 0) + line.length + 2; // +CRLF
    if (this._headerBytes > this.maxHeaderSize) {
      throw parseError(
        "HPE_HEADER_OVERFLOW",
        `header block exceeds maxHeaderSize of ${this.maxHeaderSize} bytes`,
      );
    }
    if (this.type === "request") {
      const sp1 = line.indexOf(" ");
      // llhttp validates the method token before anything else on the
      // line: "FOO /\r\n" (no version) and "Oopsie-doopsie\r\n" (no
      // space at all) are HPE_INVALID_METHOD, not
      // HPE_INVALID_START_LINE.
      const method = sp1 < 0 ? line : line.slice(0, sp1);
      if (!TOKEN_RE.test(method) || !KNOWN_METHODS.has(method)) {
        const err = parseError(
          "HPE_INVALID_METHOD",
          `invalid method: ${method}`,
        );
        err.bytesParsed = methodBytesParsed(method);
        throw err;
      }
      const sp2 = sp1 < 0 ? -1 : line.indexOf(" ", sp1 + 1);
      if (sp1 < 0 || sp2 < 0) {
        throw parseError(
          "HPE_INVALID_START_LINE",
          `malformed request line: ${line}`,
        );
      }
      const target = line.slice(sp1 + 1, sp2);
      const version = line.slice(sp2 + 1);
      if (target.length === 0) {
        throw parseError("HPE_INVALID_URL", "empty request target");
      }
      const vm = /^HTTP\/(\d+)\.(\d+)$/.exec(version);
      if (!vm || vm[1] !== "1" || (vm[2] !== "0" && vm[2] !== "1")) {
        throw parseError(
          "HPE_INVALID_VERSION",
          `unsupported version: ${version}`,
        );
      }
      this._info = {
        method,
        url: target,
        httpVersionMajor: 1,
        httpVersionMinor: Number(vm[2]),
        httpVersion: `1.${vm[2]}`,
      };
    } else {
      const m = /^HTTP\/(\d+)\.(\d+) (\d{3})(?: (.*))?$/.exec(line);
      if (!m || m[1] !== "1" || (m[2] !== "0" && m[2] !== "1")) {
        throw parseError(
          "HPE_INVALID_VERSION",
          `malformed status line: ${line}`,
        );
      }
      this._info = {
        statusCode: Number(m[3]),
        statusMessage: m[4] || "",
        httpVersionMajor: 1,
        httpVersionMinor: Number(m[2]),
        httpVersion: `1.${m[2]}`,
      };
    }
    this._state = "headers";
    return true;
  }

  _parseHeaders() {
    for (;;) {
      const found = this._findLine();
      if (!found) return false;
      const line = found.text;
      this._off = found.next;
      this._headerBytes += line.length + 2; // +CRLF
      if (this._headerBytes > this.maxHeaderSize) {
        throw parseError(
          "HPE_HEADER_OVERFLOW",
          `header block exceeds maxHeaderSize of ${this.maxHeaderSize} bytes`,
        );
      }
      if (line === "") {
        this._finishHeaders();
        return true;
      }
      if (line[0] === " " || line[0] === "\t") {
        throw parseError(
          "HPE_INVALID_HEADER",
          "obsolete line folding is not supported",
        );
      }
      const colon = line.indexOf(":");
      if (colon <= 0) {
        throw parseError(
          "HPE_INVALID_HEADER",
          `malformed header line: ${line}`,
        );
      }
      const name = line.slice(0, colon);
      if (!TOKEN_RE.test(name)) {
        throw parseError(
          "HPE_INVALID_HEADER_NAME",
          `invalid header name: ${name}`,
        );
      }
      const value = line
        .slice(colon + 1)
        .replace(/^[ \t]+/, "")
        .replace(/[ \t]+$/, "");
      this._rawHeaders.push(name, value);
    }
  }

  _finishHeaders() {
    const info = this._info;
    info.rawHeaders = this._rawHeaders;
    info.headers = {};
    // Null-prototype: a "constructor" header must not read
    // Object.prototype when its values are accumulated (below), or the
    // parser throws and the server answers 400
    // (test-http-server-multiheaders).
    info.headersDistinct = Object.create(null);
    let contentLength = null;
    let chunked = false;
    let connection = "";
    for (let i = 0; i < this._rawHeaders.length; i += 2) {
      const name = this._rawHeaders[i];
      const value = this._rawHeaders[i + 1];
      const lower = name.toLowerCase();
      if (lower === "set-cookie") {
        const arr = Array.isArray(value) ? value : [value];
        if (info.headers[lower] === undefined) {
          info.headers[lower] = arr.length === 1 ? arr[0] : arr.slice();
        } else {
          const cur = Array.isArray(info.headers[lower])
            ? info.headers[lower]
            : [info.headers[lower]];
          info.headers[lower] = cur.concat(arr);
        }
      } else {
        // hasOwnProperty, not `in`: a "constructor" header must not read
        // Object.prototype (test-http-server-multiheaders).
        info.headers[lower] = Object.prototype.hasOwnProperty.call(
          info.headers,
          lower,
        )
          ? `${info.headers[lower]}, ${value}`
          : value;
      }
      info.headersDistinct[lower] = (info.headersDistinct[lower] || []).concat(
        value,
      );
      if (lower === "content-length") {
        if (contentLength !== null && contentLength !== value) {
          throw parseError(
            "HPE_INVALID_CONTENT_LENGTH",
            "conflicting Content-Length values",
          );
        }
        if (!/^\d+$/.test(value)) {
          throw parseError(
            "HPE_INVALID_CONTENT_LENGTH",
            `invalid Content-Length: ${value}`,
          );
        }
        contentLength = value;
      } else if (lower === "transfer-encoding") {
        if (/(^|[, \t])chunked([, \t]|$)/i.test(value)) chunked = true;
      } else if (lower === "connection") {
        connection += `,${value.toLowerCase()}`;
      }
    }
    const connClose = /(^|,)close(,|$)/.test(connection);
    const connKeepAlive = /(^|,)keep-alive(,|$)/.test(connection);
    info.shouldKeepAlive =
      info.httpVersionMinor === 1 ? !connClose : connKeepAlive;
    // Framing (and thus hasBody) is decided BEFORE onHeadersComplete fires,
    // so consumers see the final value during the callback. onMessageComplete
    // still fires after onHeadersComplete, like llhttp.
    info.hasBody = false;
    let completeNow = false;

    if (this.type === "request") {
      if (chunked) {
        info.hasBody = true;
        this._chunkState = "size";
        this._state = "body-chunked";
        // Reset header size tracking; chunk data has its own limits.
        this._headStart = this._off;
      } else if (contentLength !== null && Number(contentLength) > 0) {
        info.hasBody = true;
        this._remaining = Number(contentLength);
        this._state = "body-fixed";
      } else {
        completeNow = true;
      }
    } else {
      const noBody =
        info.statusCode === 204 ||
        info.statusCode === 304 ||
        (info.statusCode >= 100 && info.statusCode <= 199) ||
        this.isHeadResponse;
      if (noBody) {
        completeNow = true;
      } else if (chunked) {
        info.hasBody = true;
        this._chunkState = "size";
        this._state = "body-chunked";
      } else if (contentLength !== null) {
        const n = Number(contentLength);
        if (n > 0) {
          info.hasBody = true;
          this._remaining = n;
          this._state = "body-fixed";
        } else {
          completeNow = true;
        }
      } else {
        info.hasBody = true;
        this._state = "body-eof";
      }
    }

    if (this.onHeadersComplete) this.onHeadersComplete(info);
    if (completeNow) this._finishMessage();
  }

  _parseFixedBody() {
    const avail = this._buf.length - this._off;
    if (avail === 0) return false;
    const take = Math.min(avail, this._remaining);
    if (this.onBody)
      this.onBody(this._buf.subarray(this._off, this._off + take));
    this._off += take;
    this._remaining -= take;
    if (this._remaining === 0) this._finishMessage();
    return true;
  }

  _parseChunkedBody() {
    if (this._chunkState === "size") {
      // Skip the header size check for chunk lines; the 16k chunk extension
      // limit is enforced separately below.
      const found = this._findLine(true);
      if (!found) return false;
      const line = found.text;
      this._off = found.next;
      // Reject bare LF/CR in the chunk size line (smuggling attack). The
      // line must be terminated by CRLF; an embedded LF indicates a malformed
      // request (e.g., "2;\n" instead of "2;\r\n").
      if (line.includes("\n") || line.includes("\r")) {
        throw parseError(
          "HPE_INVALID_CHUNK_SIZE",
          `invalid character in chunk size line: ${JSON.stringify(line.slice(0, 50))}`,
        );
      }
      const semi = line.indexOf(";");
      const hex = (semi < 0 ? line : line.slice(0, semi)).trim();
      if (!HEX_RE.test(hex)) {
        throw parseError(
          "HPE_INVALID_CHUNK_SIZE",
          `invalid chunk size: ${line}`,
        );
      }
      // Node limits chunk extensions to 16KB; larger → 413 Payload Too Large.
      if (semi >= 0 && line.length - semi - 1 > 16384) {
        const err = parseError(
          "HPE_CHUNK_EXT_TOO_LARGE",
          `chunk extension too large: ${line.length - semi - 1} bytes`,
        );
        err.statusCode = 413;
        throw err;
      }
      const size = parseInt(hex, 16);
      if (size === 0) {
        this._chunkState = "trailers";
      } else {
        this._remaining = size;
        this._chunkState = "data";
      }
      return true;
    }
    if (this._chunkState === "data") {
      const avail = this._buf.length - this._off;
      if (avail === 0) return false;
      const take = Math.min(avail, this._remaining);
      if (this.onBody)
        this.onBody(this._buf.subarray(this._off, this._off + take));
      this._off += take;
      this._remaining -= take;
      if (this._remaining === 0) this._chunkState = "data-crlf";
      return true;
    }
    if (this._chunkState === "data-crlf") {
      if (this._buf.length - this._off < 2) return false;
      if (this._buf[this._off] !== CR || this._buf[this._off + 1] !== LF) {
        throw parseError("HPE_INVALID_CHUNK", "expected CRLF after chunk data");
      }
      this._off += 2;
      this._chunkState = "size";
      return true;
    }
    // trailers: consumed and dropped (out of scope for phase 1)
    const found = this._findLine();
    if (!found) return false;
    this._off = found.next;
    if (found.text === "") this._finishMessage();
    return true;
  }

  _finishMessage() {
    this._state = this.pauseBetweenMessages ? "paused" : "complete";
    if (this.onMessageComplete) this.onMessageComplete();
  }

  /**
   * Resume a parser paused between messages. Parses any buffered bytes;
   * safe to call when not paused.
   */
  /** True when a completed message left unconsumed bytes in the buffer. */
  hasBufferedRemainder() {
    return this._state === "paused" && this._off < this._buf.length;
  }

  unpause() {
    if (this._state === "paused") {
      this._state = "complete";
      this.execute();
    }
  }

  /**
   * Take any bytes buffered past the current message (an upgrade
   * request's `head`) and clear them, so the abandoned parser can never
   * re-parse them as a new message.
   */
  takeRemainder() {
    const rest = this._buf.subarray(this._off);
    const out = Buffer.from(rest);
    this._buf = Buffer.alloc(0);
    this._off = 0;
    return out;
  }
}

export default HTTPParser;
