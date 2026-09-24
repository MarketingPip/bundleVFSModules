#!/usr/bin/env python3
"""Extract the SandboxRuntime.generate() template literal from runtime.js
into real JS source files under src/sandbox/.

The template body (lines 3426..6229 of runtime.js, 1-based) is parsed into
literal segments and ${...} interpolations. Interpolations are replaced with
source-level placeholder tokens (valid JS); literal segments are JS-unescaped
so the source files contain the exact generated code.

Placeholders (source-level -> build-time template token):
  _RUNTIME_SANDBOX_UUID_   -> _RUNTIME%%UUID%%_
  __INTEROP_VAR__          -> %%INTEROP_VAR%%
  "__PROCESS_JSON__"       -> %%PROCESS_JSON%%
  "__USER_FILES_JSON__"    -> %%USER_FILES_JSON%%
  "__SEA_ASSETS_JSON__"    -> %%SEA_ASSETS_JSON%%
  "__BUILTIN_MODULES_JSON__" -> %%BUILTIN_MODULES_JSON%%
  "__COOKIE_JAR_IIFE__"    -> <cookie jar bundle, inlined at build>
  "__IMPORTS__"; / bare __IMPORTS__ -> %%IMPORTS%%
  "__USER_CODE__"; / bare __USER_CODE__ -> %%USER_CODE%%
  "__IS_TEST__"            -> %%IS_TEST%%
  "__LOG_XHR_FAIL__";      -> %%LOG_XHR_FAIL%%
  "__LOG_XHR_ABORT__";     -> %%LOG_XHR_ABORT%%
  (in sourceURL comment) __UUID__/__FILENAME__ -> %%UUID%%/%%FILENAME%%
"""
import re
import sys

RUNTIME_JS = '/home/hatch/workspace/bvm-export-all/runtime.js'
OUT_DIR = '/home/hatch/workspace/bvm-export-all/src/sandbox'

# 1-based line range of the template BODY (between `return \`` and `` \`; ``)
BODY_START = 3426
BODY_END = 6229  # inclusive


def js_unescape(s):
    """Unescape a JS template-literal literal segment."""
    out = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c != '\\':
            out.append(c)
            i += 1
            continue
        if i + 1 >= n:
            out.append('\\')
            i += 1
            continue
        e = s[i + 1]
        if e == 'n':
            out.append('\n'); i += 2
        elif e == 't':
            out.append('\t'); i += 2
        elif e == 'r':
            out.append('\r'); i += 2
        elif e == 'b':
            out.append('\b'); i += 2
        elif e == 'f':
            out.append('\f'); i += 2
        elif e == 'v':
            out.append('\v'); i += 2
        elif e == '0' and (i + 2 >= n or not s[i + 2].isdigit()):
            out.append('\0'); i += 2
        elif e == 'x':
            out.append(chr(int(s[i + 2:i + 4], 16))); i += 4
        elif e == 'u':
            if s[i + 2] == '{':
                j = s.index('}', i + 3)
                out.append(chr(int(s[i + 3:j], 16))); i = j + 1
            else:
                out.append(chr(int(s[i + 2:i + 6], 16))); i += 6
        elif e == '\n':
            i += 2  # line continuation
        else:
            out.append(e); i += 2  # \\, \`, \$, \', \"
    return ''.join(out)


def split_segments(body):
    """Split template body into ('lit', text) / ('expr', code) segments."""
    segs = []
    i = 0
    n = len(body)
    lit_start = 0
    while i < n:
        if body[i] == '\\' :
            i += 2
            continue
        if body[i] == '$' and i + 1 < n and body[i + 1] == '{':
            segs.append(('lit', body[lit_start:i]))
            j = i + 2
            depth = 1
            quote = None
            while j < n and depth:
                c = body[j]
                if quote:
                    if c == '\\':
                        j += 2
                        continue
                    if c == quote:
                        quote = None
                elif c in '"\'`':
                    quote = c
                elif c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
                j += 1
            segs.append(('expr', body[i + 2:j - 1]))
            i = j
            lit_start = i
        else:
            i += 1
    segs.append(('lit', body[lit_start:]))
    return segs


# config.logNetworkRequests ? "<js>;" : ''  ->  "__LOG_<SUFFIX>__";
# The table is written to src/sandbox/log-tokens.js (real JS) for the build.
LOG_EXPRS = {
    '''config.logNetworkRequests ? "console.log('[FETCH] Parent failed, falling back:', requestInfo);" : \'\'''': 'FETCH_PARENT_FALLBACK',
    '''config.logNetworkRequests ? "console.log('[FETCH] Completed:', requestInfo, '- Status:', response.status);" : \'\'''': 'FETCH_COMPLETED',
    '''config.logNetworkRequests ? "console.log('[FETCH] Timeout:', requestInfo);" : \'\'''': 'FETCH_TIMEOUT',
    '''config.logNetworkRequests ? "console.log('[FETCH] Failed:', requestInfo, '- Error:', error.message);" : \'\'''': 'FETCH_FAILED',
    '''config.logNetworkRequests ? "console.log('[FETCH] Request started:', requestInfo);" : \'\'''': 'FETCH_STARTED',
    '''config.logNetworkRequests ? "console.log('[XHR] Request started:', method, url);" : \'\'''': 'XHR_STARTED',
    '''config.logNetworkRequests ? "console.log('[XHR] Completed:', method, url, '- Status:', xhr.status);" : \'\'''': 'XHR_COMPLETED',
    '''config.logNetworkRequests ? "console.log('[XHR] Failed:', method, url);" : \'\'''': 'XHR_FAILED',
    '''config.logNetworkRequests ? "console.log('[XHR] Aborted:', method, url);" : \'\'''': 'XHR_ABORTED',
}
# token suffix -> the JS statement (without trailing ;) for runtime.js
LOG_TOKEN_JS = {
    'FETCH_PARENT_FALLBACK': "console.log('[FETCH] Parent failed, falling back:', requestInfo);",
    'FETCH_COMPLETED': "console.log('[FETCH] Completed:', requestInfo, '- Status:', response.status);",
    'FETCH_TIMEOUT': "console.log('[FETCH] Timeout:', requestInfo);",
    'FETCH_FAILED': "console.log('[FETCH] Failed:', requestInfo, '- Error:', error.message);",
    'FETCH_STARTED': "console.log('[FETCH] Request started:', requestInfo);",
    'XHR_STARTED': "console.log('[XHR] Request started:', method, url);",
    'XHR_COMPLETED': "console.log('[XHR] Completed:', method, url, '- Status:', xhr.status);",
    'XHR_FAILED': "console.log('[XHR] Failed:', method, url);",
    'XHR_ABORTED': "console.log('[XHR] Aborted:', method, url);",
}
# expr (stripped) -> token to emit in source (main template body only)
EXPR_TOKENS = {
    "JSON.stringify(config.process)": '"__PROCESS_JSON__"',
    "JSON.stringify(config.fs)": '"__USER_FILES_JSON__"',
    "JSON.stringify(config.seaAssets && Object.keys(config.seaAssets).length ? config.seaAssets : undefined)": '"__SEA_ASSETS_JSON__"',
    "config.interopVariable": "__INTEROP_VAR__",
    "JSON.stringify(builtinModules)": '"__BUILTIN_MODULES_JSON__"',
    "COOKIE_JAR_IIFE": '"__COOKIE_JAR_IIFE__"',

    "String(stripAnsi)": "__STRIP_ANSI_FN__",
    "__parseStackLocation.toString()": '"__PARSE_STACK_LOCATION_FN__"', 
    "config.fileName": "__FILENAME__",
}

# tokens valid inside the isTest branches (bare text / nested template literal)
BARE_TOKENS = {
    "config.uuid": "__UUID__",
    "config.imports?.join('\\n') || ''": "__IMPORTS__",
    "code": "__USER_CODE__",
}

IS_TEST_PREFIX = "config.isTest ?"
# generate-time --test ternary (single-line shape, may contain comments/newlines)
TEST_IMPORTS_NORM = ("config?.process?.argv.includes('--test') ? '' "
                     "// if --test is present, include nothing "
                     ": config.imports?.join('\\n') || '' // otherwise include imports")
TEST_ARGV_PREFIX = "config?.process?.argv.includes('--test') ?"


def process_is_test(expr):
    """Handle the big --test ternary (branches are nested template literals).

    The branch delimiters are RAW backticks (nested template literals inside
    ${...} need no escaping). Returns source text:
    if ("__ARGV_HAS_TEST__") { A' } else { B' }
    where A'/B' are the unescaped branches with inner interpolations replaced
    by bare tokens.
    """
    m = re.match(r"config\?\.process\?\.argv\.includes\('--test'\)\s*\?", expr)
    assert m, expr[:80]
    rest = expr[m.end():].strip()
    # rest = `A` : `B`  (raw backticks; \` inside branches is an escaped backtick)
    assert rest.startswith('`'), rest[:20]
    # find closing backtick of A (respecting \` escapes)
    j = 1
    while True:
        if rest[j] == '\\':
            j += 2
            continue
        if rest[j] == '`':
            break
        j += 1
    branch_a = rest[1:j]
    rest2 = rest[j + 1:].strip()
    assert rest2.startswith(':'), rest2[:20]
    rest2 = rest2[1:].strip()
    assert rest2.startswith('`') and rest2.endswith('`'), rest2[:20] + '...' + rest2[-20:]
    branch_b = rest2[1:-1]

    def proc_branch(b):
        parts = []
        for kind, text in split_segments(b):
            if kind == 'lit':
                parts.append(js_unescape(text))
            else:
                e = text.strip()
                if e in BARE_TOKENS:
                    parts.append(BARE_TOKENS[e])
                else:
                    raise ValueError(f'unrecognized inner expr in isTest branch: {e!r}')
        return ''.join(parts)

    a = proc_branch(branch_a)
    b = proc_branch(branch_b)
    return 'if ("__ARGV_HAS_TEST__") {\n' + a + '\n} else {' + b + '\n}'


def main():
    lines = open(RUNTIME_JS).read().split('\n')
    body = '\n'.join(lines[BODY_START - 1:BODY_END])
    assert lines[BODY_START - 2].strip() == 'return `', lines[BODY_START - 2][:40]
    assert lines[BODY_END].strip() == '`;', lines[BODY_END][:40]

    out_parts = []
    for kind, text in split_segments(body):
        if kind == 'lit':
            out_parts.append(js_unescape(text))
            continue
        e = text.strip()
        # ${config.uuid} occurrences: almost all are `_RUNTIME${config.uuid}_`;
        # handle by context: the literal segments around them already contain
        # `_RUNTIME` / `_`. We emit a marker and fix up in a second pass.
        if e == 'config.uuid':
            out_parts.append('__UUID__')
        elif re.sub(r'\s+', ' ', e) == TEST_IMPORTS_NORM:
            out_parts.append('"__TEST_IMPORTS__";')
        elif re.match(r"config\?\.process\?\.argv\.includes\('--test'\)\s*\?", e):
            out_parts.append(process_is_test(e))
        elif e in EXPR_TOKENS:
            out_parts.append(EXPR_TOKENS[e])
        elif e in LOG_EXPRS:
            out_parts.append(f'"__LOG_{LOG_EXPRS[e]}__";')
        else:
            raise ValueError(f'unrecognized interpolation: {e!r}')

    text = ''.join(out_parts)
    # Second pass: `_RUNTIME__UUID___` -> `_RUNTIME_SANDBOX_UUID_`
    # (literal `_RUNTIME` + `__UUID__` + literal `_`)
    text = text.replace('_RUNTIME__UUID___', '_RUNTIME_SANDBOX_UUID_')
    # sourceURL comment: `sandbox://__UUID__/__FILENAME__` stays as-is.
    n_uuid = text.count('__UUID__')
    print(f'total chars: {len(text)}, remaining __UUID__: {n_uuid}')
    # Every remaining __UUID__ must be inside the sourceURL comment or a quoted
    # jar-instance key ("__UUID__").
    for m in re.finditer(r'__UUID__', text):
        ctx = text[max(0, m.start() - 40):m.end() + 20]
        ok = 'sourceURL' in ctx or '"__UUID__"' in ctx
        assert ok, f'__UUID__ in unexpected context: {ctx!r}'
    print('all __UUID__ occurrences are in sourceURL/jar keys: OK')

    # --- split into section files ---
    sections = [
        ('00-runtime-object.js', None, '// A recursive Proxy'),
        ('05-vitest-mocks.js', '// A recursive Proxy', '// Wraps any function (sync or async)'),
        ('10-task-tracker.js', '// Wraps any function (sync or async)', '// Registry of in-flight modules'),
        ('20-module-loader.js', '// Registry of in-flight modules', '/** Wraps a CommonJS source string in an ESM-compatible IIFE. */'),
        ('21-sync-require.js', '/** Wraps a CommonJS source string in an ESM-compatible IIFE. */', '// ─── Interop Channel'),
        ('30-interop.js', '// ─── Interop Channel', '// Node.js Globals'),
        ('31-node-globals.js', '// Node.js Globals', '// Full path to the current file (commonJS)'),
        ('32-path-resolve.js', '// Full path to the current file (commonJS)', '// Save the original console methods'),
        ('40-console.js', '// Save the original console methods', '// --- Minimal EventEmitter ---'),
        ('41-events-warnings.js', '// --- Minimal EventEmitter ---', '// 1. Real logic'),
        ('50-process.js', '// 1. Real logic', '// Enhanced timer tracking with WeakMap for cleanup'),
        ('60-timers.js', '// Enhanced timer tracking with WeakMap for cleanup', '// Enhanced fetch tracking with timeout and abort support'),
        ('70-fetch.js', '// Enhanced fetch tracking with timeout and abort support', '// Enhanced XHR tracking'),
        ('71-xhr.js', '// Enhanced XHR tracking', '// Enhanced error handling with stack traces'),
        ('80-errors.js', '// Enhanced error handling with stack traces', '// --- Key Decoder Function ---'),
        ('85-keydecoder.js', '// --- Key Decoder Function ---', '// Inject cookies from the virtual jar'),
        ('90-server-request.js', '// Inject cookies from the virtual jar', '// Remove these when emulating Node.js true behaviour'),
        ('95-init.js', '// Remove these when emulating Node.js true behaviour', 'function getTestReporters(argv)'),
        ('96-user-code.js', 'function getTestReporters(argv)', '// Multiple drain cycles to catch cascading async operations'),
        ('97-finalize.js', '// Multiple drain cycles to catch cascading async operations', None),
    ]
    import os
    os.makedirs(OUT_DIR, exist_ok=True)
    # Shared log-token table as a real JS module (used by the build script).
    import json
    with open(os.path.join(OUT_DIR, 'log-tokens.js'), 'w') as f:
        f.write('// AUTO-GENERATED by src/extract-sandbox.mjs — do not hand-edit.\n'
                '// Maps log placeholder suffixes to the JS debug statement they expand to\n'
                '// when config.logNetworkRequests is true.\n'
                'export const LOG_TOKENS = {\n')
        for suffix, js in LOG_TOKEN_JS.items():
            f.write(f'  {suffix}: {json.dumps(js)},\n')
        f.write('};\n')
    print('wrote log-tokens.js')
    pos = 0
    for fname, start_anchor, end_anchor in sections:
        if start_anchor is None:
            s = 0
        else:
            s = text.index(start_anchor, pos)
        if end_anchor is None:
            e = len(text)
        else:
            e = text.index(end_anchor, s)
        chunk = text[s:e]
        header = (f'// AUTO-GENERATED by src/extract-sandbox.mjs — do not hand-edit.\n'
                  f'// Source of truth: the SandboxRuntime.generate() template in runtime.js\n'
                  f'// (regenerate after template changes). Placeholders are substituted\n'
                  f'// by src/build-sandbox.mjs at build time.\n')
        with open(os.path.join(OUT_DIR, fname), 'w') as f:
            f.write(header + chunk)
        print(f'wrote {fname}: {len(chunk)} chars')
        pos = e
    assert pos == len(text), f'{len(text) - pos} trailing chars unaccounted'


if __name__ == '__main__':
    sys.exit(main())
