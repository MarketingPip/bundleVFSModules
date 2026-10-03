#!/usr/bin/env bash
# Rebuild tests/fixtures/hello-wasi.wasm from tests/fixtures/hello.c with the
# pinned wasi-sdk toolchain (v1 gate #4 — Clang WASI spike).
#
# Toolchain: wasi-sdk 25.0 (Clang 19.1.5, target wasm32-wasi).
# Usage:
#   WASI_SDK_PATH=/path/to/wasi-sdk-25.0-x86_64-linux ./scripts/build-clang-wasi.sh
# If WASI_SDK_PATH is unset, looks for the SDK next to the workspace:
#   $HOME/workspace/wasi-sdk/wasi-sdk-25.0-x86_64-linux
#
# Output: tests/fixtures/hello-wasi.wasm (genuine Clang output — imports
# wasi_snapshot_preview1, exports memory + _start).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASI_SDK_PATH="${WASI_SDK_PATH:-$HOME/workspace/wasi-sdk/wasi-sdk-25.0-x86_64-linux}"
CLANG="$WASI_SDK_PATH/bin/clang"
SYSROOT="$WASI_SDK_PATH/share/wasi-sysroot"

if [[ ! -x "$CLANG" ]]; then
  echo "error: clang not found at $CLANG" >&2
  echo "Set WASI_SDK_PATH to the wasi-sdk 25.0 install directory." >&2
  exit 1
fi

echo "toolchain: $($CLANG --version | head -1)"
"$CLANG" \
  --target=wasm32-wasi \
  --sysroot="$SYSROOT" \
  -O2 \
  -o "$REPO_ROOT/tests/fixtures/hello-wasi.wasm" \
  "$REPO_ROOT/tests/fixtures/hello.c"

ls -la "$REPO_ROOT/tests/fixtures/hello-wasi.wasm"
