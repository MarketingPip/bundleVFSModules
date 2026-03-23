/**
 * reporters.js
 * Browser-compatible implementations of all five Node.js built-in test reporters.
 * Matches: node --test --test-reporter={dot,spec,tap,junit,lcov}
 *
 * Usage:
 *   const result = await execute(code);   // { root, events }
 *   console.log(dot(result));
 *   console.log(spec(result));
 *   console.log(tap(result));
 *   console.log(junit(result));
 *   console.log(lcov(result));           // empty string if no coverage data
 */

// ─── ANSI colour helpers (mirrors internal/util/colors) ──────────────────────
const CLR = {
  red:    s => `\x1b[31m${s}\x1b[39m`,
  green:  s => `\x1b[32m${s}\x1b[39m`,
  blue:   s => `\x1b[34m${s}\x1b[39m`,
  yellow: s => `\x1b[33m${s}\x1b[39m`,
  gray:   s => `\x1b[90m${s}\x1b[39m`,
  white:  s => `\x1b[37m${s}\x1b[39m`,
  reset:  '\x1b[0m',
};

// Unicode symbols — mirrors reporterUnicodeSymbolMap in Node internals
const SYM = {
  pass:      '✔ ',
  fail:      '✖ ',
  arrow:     '→ ',
  info:      'ℹ ',
  warn:      '⚠ ',
  suite:     '▶ ',
  suiteEnd:  '▶ ',
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Walk the result tree and tally test outcomes.
 * Suites (isSuite / _isSuite) are not counted — only leaf tests are.
 */
function countAll(root) {
  let tests = 0, pass = 0, fail = 0, skip = 0, todo = 0, cancelled = 0;
  function walk(node) {
    for (const c of node.children) {
      if (!c.isSuite && !c._isSuite) {
        tests++;
        if      (c.result === 'pass') pass++;
        else if (c.result === 'fail') fail++;
        else if (c.result === 'skip') skip++;
        else if (c.result === 'todo') todo++;
      }
      walk(c);
    }
  }
  walk(root);
  return { tests, pass, fail, skip, todo, cancelled };
}

/** Round to 3 decimal places, matching Node's NumberPrototypeToFixed(..., 3). */
function ms(n) { return typeof n === 'number' ? +n.toFixed(3) : 0; }

/** Recursively sum duration of a node and all descendants. */
function nodeDuration(node) {
  if (node.isSuite || node._isSuite) {
    return (node.children ?? []).reduce((a, c) => a + nodeDuration(c), 0);
  }
  return typeof node.duration === 'number' ? node.duration : 0;
}

/** Total wall-time across all top-level children of root. */
function totalMs(root) {
  return (root.children ?? []).reduce((a, c) => a + nodeDuration(c), 0);
}

/** Flatten events array; accepts undefined gracefully. */
function evtList(events) { return Array.isArray(events) ? events : []; }

// ─── DOT reporter ─────────────────────────────────────────────────────────────
// Matches: node --test --test-reporter=dot
//
// Outputs one coloured character per leaf test result, wrapping at COLS.
// After the loop a newline is emitted, then a "Failed tests:" block if needed.

export function dot({ root, events }) {
  // Node uses process.stdout.columns ?? 20, clamped to minimum 20.
  const COLS = 20;
  const rows  = [];
  let   line  = '';
  let   col   = 0;
  const failed = [];

  function addChar(ch, failData) {
    line += ch;
    if (failData) failed.push(failData);
    if (++col >= COLS) { rows.push(line); line = ''; col = 0; }
  }

  // Prefer event stream (matches Node's own ordering precisely); fall back to
  // tree traversal when events aren't wired through.
  const evts = evtList(events);
  if (evts.length) {
    for (const { type, data } of evts) {
      if (type === 'test:pass') addChar(CLR.green('.'), null);
      if (type === 'test:fail') addChar(CLR.red('X'), data);
    }
  } else {
    (function walk(node) {
      for (const c of node.children) {
        if (!c.isSuite && !c._isSuite) {
          if      (c.result === 'pass') addChar(CLR.green('.'), null);
          else if (c.result === 'fail') addChar(CLR.red('X'),   c);
        }
        walk(c);
      }
    })(root);
  }

  if (line) rows.push(line);
  rows.push(''); // trailing newline after the dot grid

  if (failed.length) {
    rows.push('');
    rows.push(`${CLR.red('Failed tests:')}${CLR.white('')}`);
    rows.push('');
    for (const data of failed) {
      // data may be a raw event payload or a tree node — normalise both.
      const name = data.name ?? data.data?.name ?? '(unknown)';
      const err  = data.details?.error ?? data.error;
      rows.push(`${SYM.fail}${name}`);
      if (err) {
        rows.push(`  ${err.name ?? 'Error'}: ${err.message ?? err}`);
        if (err.stack) {
          for (const f of err.stack.split('\n').filter(l => /^\s+at /.test(l)).slice(0, 3))
            rows.push(`    ${f.trim()}`);
        }
      }
    }
  }

  return rows.join('\n');
}

export function dot2({ root, events }) {
  const COLS = 20; // Node uses terminal width, fallback 20
  const rows = [];
  let line = '';
  let col = 0;

  const failures = [];

  function pushChar(ch) {
    line += ch;
    col++;

    if (col >= COLS) {
      rows.push(line);
      line = '';
      col = 0;
    }
  }

  for (const evt of evtList(events)) {
    const { type, data } = evt;
    const result = data?.result;

    // Handle pass
    if (type === 'test:pass' && result !== 'skip' && result !== 'todo') {
      pushChar(CLR.green('.'));
      continue;
    }

    // Handle fail
    if (type === 'test:fail') {
      pushChar(CLR.red('X'));
      failures.push(data);
      continue;
    }

    // Explicitly ignore skip/todo
    if (
      type === 'test:skip' ||
      type === 'test:todo' ||
      result === 'skip' ||
      result === 'todo'
    ) {
      continue;
    }
  }

  if (line) rows.push(line);
  rows.push(''); // newline after grid

  // ─── Failure details (matches Node structure) ───
  if (failures.length) {
    rows.push('');
    rows.push(CLR.red('Failed tests:'));
    rows.push('');

    for (const f of failures) {
      const name = f.name ?? f.data?.name ?? '(unknown)';
      const err = f.details?.error ?? f.error;

      rows.push(`${SYM.fail}${name}`);

      if (err) {
        const msg = err.message ?? String(err);
        rows.push(`  ${err.name ?? 'Error'}: ${msg}`);

        if (err.stack) {
          const frames = err.stack
            .split('\n')
            .filter(l => /^\s+at /.test(l))
            .slice(0, 3);

          for (const frame of frames) {
            rows.push(`    ${frame.trim()}`);
          }
        }
      }

      rows.push('');
    }
  }

  return rows.join('\n');
}

// ─── SPEC reporter ────────────────────────────────────────────────────────────
// Matches: node --test --test-reporter=spec
//
// Hierarchical human-readable output with Unicode symbols and ANSI colours.
// Mirrors SpecReporter (internal/test_runner/reporter/spec.js).

export function spec({ root, events }) {
  const rows        = [];
  const failedNodes = [];

  function indent(depth) { return '  '.repeat(depth); }


  function formatError(node, depth) {
  const err = node.error;
  if (!err) return;

  const pad = indent(depth + 1);
  let msg = err.message ?? String(err);

  // Transform "4 == 56" → "Expected 4 to equal 56"
  const m = msg.match(/^(.+)\s*==\s*(.+)$/);
  if (m) {
    msg = `Expected ${m[1]} to equal ${m[2]}`;
  }

  rows.push(`${pad}${CLR.red(msg)}`);

  if (err.stack) {
    for (const f of err.stack
      .split('\n')
      .filter(l => /^\s+at /.test(l))
      .slice(0, 5)
    ) {
      rows.push(`${pad}  ${f.trim()}`);
    }
  }
}
  
  function formatError2(node, depth) {
    const err = node.error;
    if (!err) return;
    const pad = indent(depth + 1);
    rows.push(`${pad}${CLR.red(err.message ?? String(err))}`);
    if (err.stack) {
      for (const f of err.stack.split('\n').filter(l => /^\s+at /.test(l)).slice(0, 5))
        rows.push(`${pad}  ${f.trim()}`);
    }
  }

  function renderNode(node, depth) {
    const pad = indent(depth);
    const isSuite = node.isSuite || node._isSuite;

    if (isSuite) {
      // Suite open — Node prints "→ name" before the first child in event mode;
      // tree mode uses "▶ name" which is the canonical suite symbol.
      rows.push(`${pad}${CLR.blue(SYM.suite)}${node.name}`);
      for (const child of node.children) renderNode(child, depth + 1);
      // Suite close — always includes duration
      const dur = nodeDuration(node);
      const outcome = (node.children ?? []).some(
        c => !c.isSuite && !c._isSuite && c.result === 'fail'
      );
      const sym = outcome ? CLR.red(SYM.suiteEnd) : CLR.blue(SYM.suiteEnd);
      rows.push(`${pad}${sym}${node.name} ${CLR.gray(`(${ms(dur)}ms)`)}`);
      rows.push('');
    } else {
      switch (node.result) {
        case 'pass':
          rows.push(`${pad}${CLR.green(SYM.pass)}${node.name} ${CLR.gray(`(${ms(node.duration)}ms)`)}`);
          break;

        case 'fail':
          rows.push(`${pad}${CLR.red(SYM.fail)}${node.name} ${CLR.gray(`(${ms(node.duration)}ms)`)}`);
          formatError(node, depth);
          failedNodes.push({ node, depth });
          break;

        case 'skip': {
          const reason = typeof node.opts?.skip === 'string' && node.opts.skip
            ? ` # SKIP ${node.opts.skip}` : ' # SKIP';
          rows.push(`${pad}${CLR.gray(`- ${node.name}${reason} (${ms(node.duration)}ms)`)}`);
          break;
        }

        case 'todo': {
          const reason = typeof node.opts?.todo === 'string' && node.opts.todo
            ? ` ${node.opts.todo}` : '';
          rows.push(`${pad}${CLR.gray(`# TODO ${node.name}${reason} (${ms(node.duration)}ms)`)}`);
          break;
        }

        default:
          rows.push(`${pad}? ${node.name} (${ms(node.duration)}ms)`);
      }
    }
  }

  for (const child of root.children) renderNode(child, 0);

  // Summary block — mirrors the ℹ diagnostic lines Node emits at the end.
  const counts = countAll(root);
  const total  = totalMs(root);
  rows.push(`${CLR.blue(SYM.info)}tests ${counts.tests}`);
  rows.push(`${CLR.blue(SYM.info)}pass ${counts.pass}`);
  rows.push(`${CLR.blue(SYM.info)}fail ${counts.fail}`);
  rows.push(`${CLR.blue(SYM.info)}cancelled ${counts.cancelled}`);
  rows.push(`${CLR.blue(SYM.info)}skipped ${counts.skip}`);
  rows.push(`${CLR.blue(SYM.info)}todo ${counts.todo}`);
  rows.push(`${CLR.blue(SYM.info)}duration_ms ${ms(total)}`);

  // "▶ failing tests:" reprise — mirrors #formatFailedTestResults().
  if (failedNodes.length) {
    rows.push('');
    rows.push(`${CLR.red(SYM.fail)}failing tests:`);
    rows.push('');
    for (const { node } of failedNodes) {
      rows.push(`${CLR.red(SYM.fail)}${node.name}`);
      if (node.error) {
        rows.push(`  ${node.error.message ?? node.error}`);
        if (node.error.stack) {
          for (const f of node.error.stack.split('\n').filter(l => /^\s+at /.test(l)).slice(0, 5))
            rows.push(`    ${f.trim()}`);
        }
      }
    }
  }

  return rows.join('\n');
}

// ─── TAP reporter ─────────────────────────────────────────────────────────────
// Matches: node --test (default) / --test-reporter=tap
//
// TAP version 13. Counters are LOCAL per nesting level (not global).
// Each suite produces a nested "# Subtest:" block with its own 1..N plan.
// The top-level plan appears after all tests.

export function tap({ root, events }) {
  const rows = ['TAP version 13'];

  // Escape special TAP characters — mirrors tapEscape() in Node's reporter.
  function tapEsc(s) {
    return String(s ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/#/g, '\\#')
      .replace(/\t/g, '\\t')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }

  // YAML block — mirrors reportDetails() + jsToYaml() in tap.js.
  function yamlBlock(obj, indentSpaces) {
    const pad = ' '.repeat(indentSpaces);
    const entries = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null);
    if (!entries.length) return `${pad}---\n${pad}...`;
    return `${pad}---\n${entries.map(([k, v]) => `${pad}  ${k}: ${v}`).join('\n')}\n${pad}...`;
  }

  function renderNode(node, depth, localNum) {
    const pad      = ' '.repeat(depth * 4);
    const innerPad = ' '.repeat((depth + 1) * 4);
    const isSuite  = node.isSuite || node._isSuite;

    if (isSuite) {
      rows.push(`${pad}# Subtest: ${tapEsc(node.name)}`);
      let local = 0;
      for (const child of node.children) renderNode(child, depth + 1, ++local);
      rows.push(`${innerPad}1..${local}`);

      const dur = nodeDuration(node);
      rows.push(`${pad}ok ${localNum} - ${tapEsc(node.name)}`);
      rows.push(yamlBlock({ duration_ms: ms(dur) }, depth * 4 + 2));
    } else {
      const ok = node.result === 'fail' ? 'not ok' : 'ok';

      const directive =
        node.result === 'skip'
          ? ` # SKIP${typeof node.opts?.skip === 'string' && node.opts.skip ? ' ' + tapEsc(node.opts.skip) : ''}`
        : node.result === 'todo'
          ? ` # TODO${typeof node.opts?.todo === 'string' && node.opts.todo ? ' ' + tapEsc(node.opts.todo) : ''}`
        : '';

      rows.push(`${pad}${ok} ${localNum} - ${tapEsc(node.name)}${directive}`);

      // YAML detail block — matches reportDetails() structure.
      const meta = { duration_ms: ms(node.duration ?? 0) };
      if (node.result === 'fail' && node.error) {
        const err = node.error;
        meta.failureType = 'testCodeFailure';
        // Node wraps the message in single quotes in the YAML output.
        meta.error    = `'${String(err.message ?? '').replace(/'/g, "\\'")}'`;
        meta.code     = err.code  ?? 'ERR_TEST_FAILURE';
        meta.name     = err.name  ?? 'Error';
        if (err.stack) {
          const frames = err.stack.split('\n')
            .filter(l => /^\s+at /.test(l))
            .map(l => l.trim());
          if (frames.length)
            meta.stack = `|-\n${' '.repeat(depth * 4 + 4)}${frames.join(`\n${' '.repeat(depth * 4 + 4)}`)}`;
        }
      }
      rows.push(yamlBlock(meta, depth * 4 + 2));
    }
  }

  let topCounter = 0;
  for (const child of root.children) renderNode(child, 0, ++topCounter);
  rows.push(`1..${topCounter}`);

  // Trailing diagnostic comment block — matches Node's final summary lines.
  const counts = countAll(root);
  const total  = totalMs(root);
  rows.push(`# tests ${counts.tests}`);
  rows.push(`# pass ${counts.pass}`);
  rows.push(`# fail ${counts.fail}`);
  rows.push(`# cancelled ${counts.cancelled}`);
  rows.push(`# skipped ${counts.skip}`);
  rows.push(`# todo ${counts.todo}`);
  rows.push(`# duration_ms ${ms(total)}`);

  return rows.join('\n');
}

// ─── JUnit reporter ───────────────────────────────────────────────────────────
// Matches: node --test --test-reporter=junit
//
// Produces a standards-compliant JUnit XML document.
// Mirrors junitReporter (internal/test_runner/reporter/junit.js).
// Suites → <testsuite>, leaf tests → <testcase>, errors → <failure>,
// skip/todo → <skipped>.

export function junit({ root, events }) {
  function escAttr(s) {
    return String(s ?? '')
      .replace(/&(?!#\d{1,7};)/g, '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/"/g,  '&quot;')
      .replace(/\n/g, '&#10;');
  }
  function escContent(s) {
    return String(s ?? '')
      .replace(/&(?!#\d{1,7};)/g, '&amp;')
      .replace(/</g, '&lt;');
  }
  function escComment(s) {
    return String(s ?? '').replace(/--/g, '&#45;&#45;');
  }

  const HOSTNAME = 'localhost';
  const out = ['<?xml version="1.0" encoding="utf-8"?>', '<testsuites>'];

  function tabs(depth) { return '\t'.repeat(depth + 1); }

  function renderSuite(node, depth) {
    const t        = tabs(depth);
    const children = node.children ?? [];
    const cases    = children.filter(c => !c.isSuite && !c._isSuite);
    const nested   = children.filter(c =>  c.isSuite ||  c._isSuite);
    const failures = cases.filter(c => c.result === 'fail').length;
    const skipped  = cases.filter(c => c.result === 'skip' || c.result === 'todo').length;
    const dur      = (nodeDuration(node) / 1000).toFixed(6);

    out.push(
      `${t}<testsuite` +
      ` name="${escAttr(node.name)}"` +
      ` tests="${cases.length}"` +
      ` failures="${failures}"` +
      ` skipped="${skipped}"` +
      ` errors="0"` +
      ` time="${dur}"` +
      ` hostname="${HOSTNAME}">`
    );

    for (const child of children) {
      if (child.isSuite || child._isSuite) renderSuite(child, depth + 1);
      else                                  renderTestcase(child, depth + 1);
    }
    out.push(`${t}</testsuite>`);
  }

  function renderTestcase(node, depth) {
    const t   = tabs(depth);
    const dur = ((node.duration ?? 0) / 1000).toFixed(6);
    const attrs =
      `name="${escAttr(node.name)}"` +
      ` classname="${escAttr(node.classname ?? 'test')}"` +
      ` time="${dur}"`;

    const isLeaf = !node.children?.length;

    if (isLeaf && node.result === 'pass') {
      out.push(`${t}<testcase ${attrs}/>`);
      return;
    }

    out.push(`${t}<testcase ${attrs}>`);

    if (node.result === 'skip') {
      const msg = typeof node.opts?.skip === 'string' ? node.opts.skip : 'skipped';
      out.push(`${t}\t<skipped type="skipped" message="${escAttr(msg)}"/>`);
    } else if (node.result === 'todo') {
      const msg = typeof node.opts?.todo === 'string' ? node.opts.todo : 'todo';
      out.push(`${t}\t<skipped type="todo" message="${escAttr(msg)}"/>`);
    } else if (node.result === 'fail' && node.error) {
      const err  = node.error;
      const type = escAttr(err.failureType ?? err.code ?? 'Error');
      const msg  = escAttr(err.message ?? '');
      out.push(`${t}\t<failure type="${type}" message="${msg}">`);
      out.push(escContent(err.stack ?? String(err)));
      out.push(`${t}\t</failure>`);
    }

    out.push(`${t}</testcase>`);
  }

  // Separate top-level suites from top-level leaf tests.
  const topSuites = root.children.filter(c => c.isSuite || c._isSuite);
  const topTests  = root.children.filter(c => !c.isSuite && !c._isSuite);

  for (const s of topSuites) renderSuite(s, 0);

  // Lone top-level tests are wrapped in an anonymous "root" testsuite —
  // this matches Node's behaviour where all events share a common ancestor.
  if (topTests.length) {
    const failures = topTests.filter(c => c.result === 'fail').length;
    const skipped  = topTests.filter(c => c.result === 'skip' || c.result === 'todo').length;
    const dur      = (topTests.reduce((a, c) => a + nodeDuration(c), 0) / 1000).toFixed(6);
    out.push(
      `\t<testsuite name="root"` +
      ` tests="${topTests.length}"` +
      ` failures="${failures}"` +
      ` skipped="${skipped}"` +
      ` errors="0"` +
      ` time="${dur}"` +
      ` hostname="${HOSTNAME}">`
    );
    for (const t of topTests) renderTestcase(t, 1);
    out.push('\t</testsuite>');
  }

  out.push('</testsuites>');
  return out.join('\n');
}

// ─── LCOV reporter ────────────────────────────────────────────────────────────
// Matches: node --test --test-reporter=lcov
//
// Mirrors LcovReporter (internal/test_runner/reporter/lcov.js).
// Requires a `test:coverage` event in the events array (produced by
// `node --experimental-test-coverage`). Returns an empty string when no
// coverage data is present — the browser runner may not generate it.

export function lcov({ root, events }) {
  const coverageEvt = evtList(events).find(e => e.type === 'test:coverage');
  if (!coverageEvt) return ''; // no coverage data — mirrors Node's silent no-op

  const { summary } = coverageEvt.data;
  const { workingDirectory, files } = summary;

  // Portable relative-path calculation (no node:path available here).
  function relativePath(filePath) {
    const base = workingDirectory.endsWith('/') || workingDirectory.endsWith('\\')
      ? workingDirectory
      : workingDirectory + '/';
    if (filePath.startsWith(base)) return filePath.slice(base.length);
    return filePath;
  }

  let out = 'TN:\n'; // TN: (test name) — empty since we have no named test

  for (const file of files) {
    // SF: — source file path, relative to workingDirectory
    out += `SF:${relativePath(file.path)}\n`;

    // FN: / FNDA: — function definitions and execution counts
    let fnda = '';
    for (let j = 0; j < file.functions.length; j++) {
      const func = file.functions[j];
      const name = func.name || `anonymous_${j}`;
      out  += `FN:${func.line},${name}\n`;
      fnda += `FNDA:${func.count},${name}\n`;
    }
    out += fnda;

    // FNF: / FNH: — functions found / hit
    out += `FNF:${file.totalFunctionCount}\n`;
    out += `FNH:${file.coveredFunctionCount}\n`;

    // BRDA: — branch data
    for (let j = 0; j < file.branches.length; j++)
      out += `BRDA:${file.branches[j].line},${j},0,${file.branches[j].count}\n`;

    // BRF: / BRH: — branches found / hit
    out += `BRF:${file.totalBranchCount}\n`;
    out += `BRH:${file.coveredBranchCount}\n`;

    // DA: — line execution counts, sorted ascending (mirrors toSorted in lcov.js)
    const sortedLines = [...file.lines].sort((a, b) => a.line - b.line);
    for (const l of sortedLines)
      out += `DA:${l.line},${l.count}\n`;

    // LH: / LF: — lines hit / found
    out += `LH:${file.coveredLineCount}\n`;
    out += `LF:${file.totalLineCount}\n`;
    out += 'end_of_record\n';
  }

  return out;
}
