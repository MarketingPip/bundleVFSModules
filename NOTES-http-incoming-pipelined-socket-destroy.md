# NOTES — test-http-incoming-pipelined-socket-destroy

Target: `test-http-incoming-pipelined-socket-destroy` hung on main
(timeout). Thirteen requests are pipelined onto one raw socket; the
server must dispatch all thirteen handlers (each destroys the socket
or the response, or answers in two chunks) and count thirteen
`requestDone` events before closing.

On main only the first handler ever ran. The client then received
`HTTP/1.1 400 Bad Request` and the connection closed, leaving the
remaining twelve requests undispatched and the test's countdown
unfinished.

Root cause: the test's request generator appends an extra `"\r\n"`
after each request, so every pipelined request after the first is
preceded by an empty line. Our `HTTPParser._parseStartLine`
(`src/_http_parser.js`) treated that empty line as the next start
line and threw `HPE_INVALID_*`, which the server's parser-error path
turned into a 400 + close.

Node's llhttp ignores empty lines before the start line — RFC 9112
section 4 requires a recipient to ignore at least one empty line
received before the request line. The fix does the same:
`_parseStartLine` consumes leading empty lines before parsing,
applied to both request and response start lines (llhttp tolerates
them on both sides). It is a loop, not recursion, so a buffer of
nothing but CRLFs cannot overflow the stack, and skipped bytes are
consumed so the parse buffer cannot grow on padding.

Interaction with `test-http-blank-header`: its trailing bytes are
`\r\nhello world` after a complete header block — an empty line
followed by garbage with no terminating CRLF. Skipping the empty
line naively left the parser waiting forever for a line end that
never comes (the test hung). llhttp is a byte-level machine and
rejects an invalid start line eagerly, without waiting for its
CRLF. So the skip path now judges the partial remainder when no
complete line follows: the method token (or its prefix, while the
token is still arriving) must be viable against the known-method
set, otherwise the parser throws `HPE_INVALID_METHOD` — the 400 the
test expects. The same prefix check applies to response start lines
(`HTTP/`). Both tests pass together; the rest of the pipeline family
and the guard battery were differential-checked against main and the
2026-10-20 sweep (every other result identical).
