# NOTES — fix/https-globalagent-rebind (wave 3, L3)

## Target
`test-https-client-override-global-agent.js` (1 -> 0).

## Root cause
`src/https.js` exported `globalAgent` as a `const` binding and snapshotted it
on the default-export object, so `https.globalAgent = agent` never reached
the request path: `request()` passes the module-scope binding as
`_createClientRequest`'s `defaultAgent`, and the assignment landed on the
default-export snapshot instead. Node exposes `globalAgent` as an accessor
(`lib/http.js:220` get/set over the `_http_agent` backing store), read live
by the https request path (`lib/https.js:649`, `:681`).

## Fix (mirror of PR #363 for http)
- `export const globalAgent` -> `export let globalAgent` (src/https.js:133).
- Default-export object carries get/set accessors over the module-scope
  binding, matching Node's shape; no validation in the setter, matching
  Node. Unassigned, the default keep-alive agent stands.

## Differential
Fresh full https sweep (fast-sweep.py --target https, base main 2079bca0):
base 27 pass / 6 timeout / 34 fail; branch 28 pass / 6 timeout / 33 fail.
Exactly 1 changed line: test-https-client-override-global-agent 1 -> 0.
Zero regressions. Base CSV: hidden_files/fast-sweep/https-sweep-2026-11-07.csv;
branch CSV: hidden_files/fast-sweep/https-l3-branch-2026-11-07.csv.

## CI no-show (2026-11-07, round 2)
Both pushed heads (ec8ad1c8, then rebased 4b4916b4 onto main 44d1ed84)
got ZERO check runs / zero workflow runs across ~2.5h of polling, while
CI ran green for other wave-3 lanes in the same window (repo-wide CI
healthy). Rebase + force-push did not unstick it; this notes-only commit
is the synchronize-push retrigger. If CI still shows nothing, the lane
is blocked on a GitHub-side trigger failure, not on the code.
