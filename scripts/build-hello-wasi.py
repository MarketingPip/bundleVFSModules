#!/usr/bin/env python3
"""Build a minimal WASI preview1 hello-world WASM binary.

Calls fd_write(1, iovs, 1, nwritten) to print "hello world\n" to stdout,
then proc_exit(0).

WAT equivalent:
  (module
    (import "wasi_snapshot_preview1" "fd_write"
      (func $fd_write (param i32 i32 i32 i32) (result i32)))
    (import "wasi_snapshot_preview1" "proc_exit"
      (func $proc_exit (param i32)))
    (memory 1)
    (export "memory" (memory 0))
    (data (i32.const 0) "hello world\\n")
    (func $_start
      ;; iovec[0] = { buf=0, len=12 } at offset 16
      i32.const 16  i32.const 0  i32.store
      i32.const 20  i32.const 12 i32.store
      ;; fd_write(1, 16, 1, 24)
      i32.const 1  i32.const 16  i32.const 1  i32.const 24
      call $fd_write
      drop
      ;; proc_exit(0)
      i32.const 0
      call $proc_exit
      unreachable)
    (export "_start" (func $_start)))
"""

def uleb128(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            break
    return bytes(out)

def section(id, payload):
    return bytes([id]) + uleb128(len(payload)) + payload

def vec(items):
    return uleb128(len(items)) + b"".join(items)

# Types: 0 = (i32,i32,i32,i32)->i32, 1 = (i32)->(), 2 = ()->()
type_sec = section(1, vec([
    bytes([0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f]),
    bytes([0x60, 0x01, 0x7f, 0x00]),
    bytes([0x60, 0x00, 0x00]),
]))

def import_entry(mod, name, kind, typeidx):
    m = mod.encode()
    n = name.encode()
    return uleb128(len(m)) + m + uleb128(len(n)) + n + bytes([kind]) + uleb128(typeidx)

import_sec = section(2, vec([
    import_entry("wasi_snapshot_preview1", "fd_write", 0x00, 0),
    import_entry("wasi_snapshot_preview1", "proc_exit", 0x00, 1),
]))

# Function section: 1 function (_start) with type 2
func_sec = section(3, vec([uleb128(2)]))

# Memory section: 1 memory, min 1 page
mem_sec = section(5, vec([bytes([0x00, 0x01])]))

# Export section: memory as "memory", func 2 as "_start"
# (func idx 0=fd_write import, 1=proc_exit import, 2=_start defined)
def export_entry(name, kind, idx):
    n = name.encode()
    return uleb128(len(n)) + n + bytes([kind]) + uleb128(idx)

export_sec = section(7, vec([
    export_entry("memory", 0x02, 0),
    export_entry("_start", 0x00, 2),
]))

# Code section: _start body
# Locals: none. Body:
#   i32.const 16; i32.const 0; i32.store
#   i32.const 20; i32.const 12; i32.store
#   i32.const 1; i32.const 16; i32.const 1; i32.const 24
#   call 0; drop
#   i32.const 0; call 1; unreachable
#   end
body = bytearray()
body += bytes([0x00])  # local count = 0
# i32.const 16
body += bytes([0x41]) + uleb128(16)
# i32.const 0
body += bytes([0x41]) + uleb128(0)
# i32.store (align=2, offset=0)
body += bytes([0x36, 0x02, 0x00])
# i32.const 20
body += bytes([0x41]) + uleb128(20)
# i32.const 12
body += bytes([0x41]) + uleb128(12)
# i32.store
body += bytes([0x36, 0x02, 0x00])
# i32.const 1, 16, 1, 24
for v in (1, 16, 1, 24):
    body += bytes([0x41]) + uleb128(v)
# call 0 (fd_write)
body += bytes([0x10, 0x00])
# drop
body += bytes([0x1a])
# i32.const 0
body += bytes([0x41]) + uleb128(0)
# call 1 (proc_exit)
body += bytes([0x10, 0x01])
# unreachable
body += bytes([0x00])
# end
body += bytes([0x0b])

code_sec = section(10, vec([uleb128(len(body)) + bytes(body)]))

# Data section: "hello world\n" at offset 0
msg = b"hello world\n"
# data segment: flags=0, init=i32.const 0, end, bytes
data_init = bytes([0x41]) + uleb128(0) + bytes([0x0b])
data_seg = bytes([0x00]) + data_init + uleb128(len(msg)) + msg
data_sec = section(11, vec([data_seg]))

wasm = b"\x00asm" + b"\x01\x00\x00\x00" + type_sec + import_sec + func_sec + mem_sec + export_sec + code_sec + data_sec

with open("/tmp/hello-wasi.wasm", "wb") as f:
    f.write(wasm)

print(f"Wrote {len(wasm)} bytes to /tmp/hello-wasi.wasm")

# Verify it parses
import subprocess
r = subprocess.run(
    ["node", "-e", f"""
const fs = require('fs');
const bytes = fs.readFileSync('/tmp/hello-wasi.wasm');
try {{
  const m = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(m);
  const exports = WebAssembly.Module.exports(m);
  console.log('Imports:', JSON.stringify(imports));
  console.log('Exports:', JSON.stringify(exports));
  console.log('VALID WASM');
}} catch (e) {{
  console.log('INVALID:', e.message);
  process.exit(1);
}}
"""],
    capture_output=True, text=True,
)
print(r.stdout)
if r.stderr:
    print("STDERR:", r.stderr[:500])
