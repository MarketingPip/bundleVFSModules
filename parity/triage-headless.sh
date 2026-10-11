#!/bin/bash
# Triage driver for the headless real-runtime lane (roadmap §4).
# Runs the strict-gate modules through parity/run-headless.mjs, one module
# at a time, saving each module's report.json. Appends a one-line summary
# per module to triage-summary.txt.
cd "$(dirname "$0")/.." || exit 1
OUTDIR="parity/triage-headless"
mkdir -p "$OUTDIR"
SUMMARY="$OUTDIR/triage-summary.txt"
: > "$SUMMARY"
for mod in "$@"; do
  echo "=== $mod ==="
  if timeout 1800 node parity/run-headless.mjs "$mod" > "$OUTDIR/$mod.log" 2>&1; then
    status="done"
  else
    status="runner-exit-$?"
  fi
  cp parity/report.json "$OUTDIR/report-$mod.json" 2>/dev/null
  line=$(grep -E "^Module:" "$OUTDIR/$mod.log" | tail -1)
  echo "$mod [$status] $line" >> "$SUMMARY"
  echo "$mod [$status] $line"
done
echo "triage complete"
