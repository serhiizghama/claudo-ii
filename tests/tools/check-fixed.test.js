// tests/tools/check-fixed.test.js
//
// TEST-2 acceptance tests for tools/check-fixed.mjs. `node:test` +
// `node:assert/strict` only (12-testing.md P6).
//
// Same driving style as tests/tools/check-imports.test.js: this tool is a
// standalone CLI, so these tests shell out to it via `child_process.spawnSync`
// and assert on exit code and output.
//
// --- Isolation (O-24) and the stale "bodies=0" assumption (O-23) --------
// The previous version of this file (a) wrote its probes into a real
// directory under `src/` and (b) had one test asserting the REAL tree has
// zero `fixedUpdate` bodies. Both were wrong for the same underlying reason:
// this tool walks the WHOLE `src/` tree (12-testing.md §4.5), so anything
// happening to `src/` anywhere — a concurrent test's scratch directory
// appearing/disappearing, or a real ticket landing a real `fixedUpdate` (as
// PLYR-1 did) — changes what this tool sees. (a) raced for real against
// check-imports.test.js (reproduced ~1 run in 17, O-24); (b) went stale the
// day PLYR-1 shipped (O-23).
//
// `check-fixed.mjs` now takes `--root <dir>` (mirroring check-imports.mjs).
// Every test below builds its own disposable, fully synthetic tree via
// `fs.mkdtempSync` and points `--root` at it — never the real `src/`, and
// never assumes anything about what real tickets have or haven't landed
// there. `docs/spec/02-api-contracts.md` itself is NOT overridable (see the
// tool's own header) and does not need to be: it is a stable, read-only
// input no test ever mutates, so two concurrent runs reading it never race.
//
// The one exception is the final "doesn't crash on the real tree" test,
// which is READ-ONLY and asserts nothing about content (bodies count, exit
// 0 vs 1) — only that the tool itself never throws — so it can never go
// stale the way the old "bodies=0" assumption did.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = join(REPO_ROOT, 'tools', 'check-fixed.mjs');

function run(args = []) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

/** Builds a fresh, unique scratch directory (`fs.mkdtempSync`, OS temp dir —
 * never under this repo, let alone under `src/`), hands it to `fn`, and
 * removes it in a `finally` regardless of pass/fail/throw. */
function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'cf-check-fixed-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFile(root, relPath, content) {
  const file = join(root, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

test('empty synthetic root: exits 0, zero fixedUpdate bodies (a fact about the empty tree, not about src/)', () => {
  withTempRoot((root) => {
    const result = run(['--root', root]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr:\n${result.stderr}`);
    assert.equal(result.stderr.trim(), '');
    assert.match(result.stdout, /RESULT: PASS/);
    assert.match(result.stdout, /bodies=0/);
    // Sanity: the Fixed column actually parsed something real out of the
    // real 02-api-contracts.md (never overridden by --root), so a "0
    // bodies, 0 fails" PASS isn't hiding a silently-empty parse.
    assert.match(result.stdout, /contracts=\d+ Fixed=N methods \(\d+ tables, \d+ rows\)/);
  });
});

test('a Fixed=N method call inside fixedUpdate() is reported, with the owning class id in the message', () => {
  withTempRoot((root) => {
    writeFile(
      root,
      'probe.js',
      [
        'export class ProbeSystem {',
        "  static id = 'probe';",
        '  static deps = [];',
        '  fixedUpdate(h, ctx) {',
        "    const r = ctx.get('render');",
        '    r.render(ctx);', // render.render is Fixed=N
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const result = run(['--root', root, '--verbose']);
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /FAIL {2}12\.F01 {2}probe\.js:6 {2}'probe'\.fixedUpdate\(\) calls 'render\(\)'/);
    assert.match(result.stdout, /RESULT: FAIL \(1\)/);
  });
});

test("ctx.get / ctx.peek / ctx.has are never flagged, even though materials' Fixed=N method is literally named 'get'", () => {
  withTempRoot((root) => {
    writeFile(
      root,
      'probe.js',
      [
        'export class ProbeSystem {',
        "  static id = 'probe';",
        '  fixedUpdate(h, ctx) {',
        "    const a = ctx.get('render');",
        "    const b = ctx.peek('materials');",
        "    const c = ctx.has('items');",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const result = run(['--root', root]);
    assert.equal(result.status, 0, `ctx.get/peek/has must never be flagged\nstderr:\n${result.stderr}`);
  });
});

test('a non-ctx receiver calling the real materials.get() IS still flagged', () => {
  withTempRoot((root) => {
    writeFile(
      root,
      'probe.js',
      [
        'export class ProbeSystem {',
        "  static id = 'probe';",
        '  fixedUpdate(h, ctx) {',
        "    const materials = ctx.get('materials');",
        "    const mat = materials.get('stone_wall');", // real Fixed=N call, resolves to 'materials'
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const result = run(['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /calls 'get\(\)'/);
  });
});

test('O-22 report: subsystem-aware narrowing tells audio.stop() (Fixed=N) apart from player.stop() (Fixed=Y) by receiver', () => {
  // The exact false positive PLYR-1 hit: a flat name-only Fixed=N set
  // cannot distinguish audio's stop() from player's, because both exist and
  // only one is Fixed=N. check-fixed.mjs now traces the receiver back to
  // the `ctx.get('<id>')` binding that produced it and checks THAT
  // subsystem's own Fixed column.
  withTempRoot((root) => {
    writeFile(
      root,
      'probe.js',
      [
        'export class ProbeSystem {',
        "  static id = 'probe';",
        '  fixedUpdate(h, ctx) {',
        "    const player = ctx.get('player');",
        '    player.stop();', // player.stop is Fixed=Y — must NOT be flagged
        "    const audio = ctx.get('audio');",
        '    audio.stop(1);', // audio.stop is Fixed=N — MUST be flagged
        '    const unknown = getSomethingElse();',
        '    unknown.stop();', // unresolved receiver — conservative default: flagged
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const result = run(['--root', root]);
    assert.equal(result.status, 1);
    const failLines = result.stderr.trim().split('\n').filter((l) => l.startsWith('FAIL'));
    assert.equal(failLines.length, 2, `expected exactly 2 failures (audio.stop + unknown.stop), got:\n${result.stderr}`);
    assert.match(result.stderr, /probe\.js:7/); // audio.stop(1) line
    assert.match(result.stderr, /probe\.js:9/); // unknown.stop() line
    assert.doesNotMatch(result.stderr, /probe\.js:5/); // player.stop() line — never flagged
  });
});

test('performance.now(), Date.now(), Math.random(), ctx.time.dt, window.*, document.* are each reported once', () => {
  withTempRoot((root) => {
    writeFile(
      root,
      'probe.js',
      [
        'export class ProbeSystem {',
        "  static id = 'probe';",
        '  fixedUpdate(h, ctx) {',
        '    const a = performance.now();',
        '    const b = Date.now();',
        '    const c = Math.random();',
        '    const d = ctx.time.dt;',
        '    const e = window.innerWidth;',
        '    const f = document.title;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const result = run(['--root', root]);
    assert.equal(result.status, 1);
    for (const needle of [
      "reads 'performance.now\\(\\)'",
      "reads 'Date\\.now\\(\\)'",
      "calls 'Math\\.random\\(\\)'",
      "reads 'ctx\\.time\\.dt'",
      "references 'window'",
      "references 'document'",
    ]) {
      assert.match(result.stderr, new RegExp(needle), `expected a FAIL line matching ${needle}`);
    }
    const failLines = result.stderr.trim().split('\n').filter((l) => l.startsWith('FAIL'));
    assert.equal(failLines.length, 6);
  });
});

test('the same dangerous calls in update() (not fixedUpdate) are never scanned', () => {
  withTempRoot((root) => {
    writeFile(
      root,
      'probe.js',
      [
        'export class ProbeSystem {',
        "  static id = 'probe';",
        '  update(dt, ctx) {',
        '    const r = ctx.get("render");',
        '    r.render(ctx);',
        '    const t = performance.now();',
        '  }',
        '  fixedUpdate(h, ctx) {}',
        '}',
        '',
      ].join('\n'),
    );
    const result = run(['--root', root]);
    assert.equal(result.status, 0, `update() must never be scanned\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /bodies=1/); // the empty fixedUpdate() is still found and scanned (0 hits)
  });
});

test('a call site like sys.fixedUpdate(FIXED_DT, ctx) (engine.js\'s own pattern) is never mistaken for a definition', () => {
  withTempRoot((root) => {
    writeFile(
      root,
      'probe.js',
      [
        'export function driveOneStep(systems, ctx) {',
        '  for (const sys of systems) {',
        '    if (typeof sys.fixedUpdate === "function") sys.fixedUpdate(0.016, ctx);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const result = run(['--root', root, '--verbose']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /bodies=0/);
  });
});

test('comments/strings are masked: prose and string content mentioning a Fixed=N name does not trip the lint', () => {
  withTempRoot((root) => {
    writeFile(
      root,
      'probe.js',
      [
        'export class ProbeSystem {',
        "  static id = 'probe';",
        '  fixedUpdate(h, ctx) {',
        '    // never call render() or performance.now() or Math.random() here',
        "    const msg = 'do not call window.alert or document.write';",
        '    return 1;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const result = run(['--root', root]);
    assert.equal(result.status, 0, `prose/strings must not trip the lint\nstderr:\n${result.stderr}`);
  });
});

test('--json writes a machine-readable report with the same failures', () => {
  withTempRoot((root) => {
    writeFile(
      root,
      'probe.js',
      ['export class ProbeSystem {', "  static id = 'probe';", '  fixedUpdate(h, ctx) {', '    const t = Date.now();', '  }', '}', ''].join('\n'),
    );
    const jsonPath = join(root, '.report.json');
    const result = run(['--root', root, '--json', jsonPath]);
    assert.equal(result.status, 1);
    const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(report.tool, 'check-fixed.mjs');
    assert.equal(report.exitCode, 1);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].kind, 'clock-read');
    assert.equal(report.failures[0].classId, 'probe');
  });
});

test('--root with a directory that does not exist at all is an empty scan, exit 0 (never crashes)', () => {
  withTempRoot((root) => {
    const missing = join(root, 'does-not-exist');
    const result = run(['--root', missing]);
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    assert.match(result.stdout, /bodies=0/);
  });
});

test('--help exits 0 and prints usage without scanning anything', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /--root/);
});

test('--seed and --bless are explicitly rejected (exit 2), not silently accepted', () => {
  for (const flag of ['--seed', '--bless']) {
    const result = run([flag, '0x1']);
    assert.equal(result.status, 2, `${flag} should exit 2`);
    assert.match(result.stderr, /not implemented/);
  }
});

test('an unknown flag exits 2', () => {
  const result = run(['--nonsense']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown flag/);
});

test('read-only smoke test: running against the real repo tree never crashes (exit 0 or 1, never 2)', () => {
  // Deliberately asserts nothing about bodies/failures count — that depends
  // on which real tickets have landed a fixedUpdate on a given day (this is
  // exactly the O-23 staleness this rewrite exists to stop repeating). What
  // this pins is narrower and permanent: the tool itself never
  // throws/crashes against the real, evolving tree, and it still parses
  // 02-api-contracts.md successfully. Read-only (no --root override, and
  // this tool never writes anything it scans), so it cannot race any other
  // suite.
  const result = run();
  assert.notEqual(result.status, 2, `tool crashed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /RESULT: (PASS|FAIL)/);
  assert.match(result.stdout, /contracts=\d+ Fixed=N methods/);
});
