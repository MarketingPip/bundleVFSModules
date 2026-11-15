# NOTES — net lane N2-20: client remoteAddress/remoteFamily/remotePort (remote-peer)

Target: `test-net-remote-address-port` (1 → 0).

## Mechanism

`Server.prototype._acceptConnection` (src/net.js) built the client-side
`_peername` from the server's `_bindAddress` — the `::`/`0.0.0.0` wildcard
when `listen()` had no host. The client socket's `remoteAddress` therefore
read `"::"` instead of the endpoint it dialed. The server-side socket was
already correct (`_peername` from the client's bound source address,
`srcAddress`).

Probed real Node v24.22.1: a client dialing `127.0.0.1` on a `listen(0)`
server reports `remoteAddress 127.0.0.1`, `remoteFamily IPv4`,
`remotePort <server port>` — i.e. `uv_tcp_getpeername` on the client handle
returns the resolved connect target. The test accepts
`[127.0.0.1, ::1, ::ffff:127.0.0.1]` / `[IPv4, IPv6]`.

## Fix (src/net.js only)

In `_acceptConnection`'s non-pipe branch, set `client._peername` from the
accept request's resolved connect target instead of the bind address:

```js
client._peername = {
  address: req.address,
  family: req.family,   // always the "IPv4"/"IPv6" string: _doConnect sets it
  port: req.port,       // from resolved.family or isIPv4(host)
};
```

`serverSocket._sockname` still uses the bind address (the server's local
endpoint), and `serverSocket._peername` still uses `srcAddress` — both
unchanged. The server-side `remoteAddress` reads `127.0.0.1` where real Node
reads `::ffff:127.0.0.1` (IPv4-mapped); the test accepts either form, so that
cosmetic divergence is left alone (ponytail: smallest fix).

## Known leftover (not fixed, untested)

`_dropPairedConnection` (maxConnections drop + server blockList path) sets
`client._peername` from `bindAddr` in the same way — a dropped client that
reads `remoteAddress` after its `connect` would also see the wildcard.
No vendored test covers it, and fixing it would mean threading `req`
through two call sites; left for a lane that owns the drop path.

## Verification

- Target `test-net-remote-address-port`: 1 → 0, isolated 2x on the branch.
- Guards (all 0): server-drop-connections, server-blocklist,
  connect-options-port, normalize-args, socket-connect-invalid-autoselectfamily,
  autoselectfamily-default.
- Differential: fast-sweep `--target net`, base
  `hidden_files/fast-sweep/net-n2-remote-peer-base-2026-11-14.csv`
  (125 pass / 19 fail / 12 timeout — 2 short of the verified 127: load
  flakes, cross-checked vs sibling base CSVs on the same tip) vs branch
  `hidden_files/fast-sweep/net-n2-remote-peer-branch-2026-11-14.csv`
  (122 pass / 19 fail / 15 timeout; 149 files hit the 10s cap vs 96 in base
  — the branch sweep ran under load avg ~53 with ~10 sibling sweeps).
  Matched changed lines: toward-pass remote-address-port 1→0 (claimed flip)
  + socket-constructor 124→0 (base flake: 0 in the sibling pipe base CSV);
  apparent regressions all 124s (autoselectfamily-attempt-timeout-cli-option,
  autoselectfamily-commandline-option, connect-memleak, connect-options-fd,
  normalize-args) — adjudicated by isolated 2x re-runs on the branch (see
  PR body for results); mode changes end-close 124→1, persistent-nodelay
  124→1, persistent-ref-unref 1→124 (known flaky/NO-FIX tests).
