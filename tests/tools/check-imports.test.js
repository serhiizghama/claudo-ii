// tests/tools/check-imports.test.js
//
// TEST-2 acceptance tests for tools/check-imports.mjs. `node:test` +
// `node:assert/strict` only (12-testing.md P6).
//
// The tool itself is a standalone CLI (no exports) — as documented in
// 12-testing.md §5.1, every harness is a CLI, not a library — so these tests
// drive it the same way CI does: `node tools/check-imports.mjs [...]` via
// `child_process.spawnSync`, asserting on exit code and output.
//
// --- Isolation (O-24) ---------------------------------------------------
// The previous version of this file created and removed the REAL
// `src/combat/` and `src/__ci_test_shared__/` to exercise the tool. That
// worked in isolation but raced for real against any other suite touching
// `src/` concurrently — `node --test` runs different test files as separate
// workers by default, and `tools/check-fixed.mjs` walks the WHOLE `src/`
// tree, so a run of this file deleting `src/combat/` mid-scan could crash a
// concurrent `check-fixed.mjs` invocation with ENOENT (reported as O-24,
// reproduced ~1 run in 17). `check-imports.mjs` now takes `--root <dir>`
// specifically so this file never has to touch the real `src/` at all: every
// test builds its own disposable directory via `fs.mkdtempSync` under the OS
// temp dir, points `--root` at it, and removes it in a `finally` — no two
// tests, in this file or any other, can ever collide on a path, because
// `mkdtempSync` hands out a fresh unique directory every call.
//
// The one exception is the final "doesn't crash on the real tree" test,
// which is READ-ONLY (it runs check-imports.mjs with no --root override) and
// therefore never races anything — two readers of `src/` never conflict,
// only a concurrent writer does. It deliberately asserts nothing about the
// real tree's CONTENT (status 0 vs 1 stays unpinned), so it can never go
// stale the way a hardcoded body/violation count would (the same class of
// staleness O-23 hit in check-fixed.test.js's old "bodies=0" assumption).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = join(REPO_ROOT, 'tools', 'check-imports.mjs');

function run(args = []) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

/** Builds a fresh, unique scratch directory (`fs.mkdtempSync`, OS temp dir —
 * never under this repo, let alone under `src/`), hands it to `fn`, and
 * removes it in a `finally` regardless of pass/fail/throw. */
function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ci-check-imports-'));
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

test('clean synthetic root: exits 0, no FAIL lines, missing roots reported as NOTE not FAIL', () => {
  withTempRoot((root) => {
    const result = run(['--root', root]);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr:\n${result.stderr}`);
    assert.equal(result.stderr.trim(), '', 'a clean tree must print zero FAIL lines');
    assert.match(result.stdout, /RESULT: PASS/);
    assert.match(result.stdout + result.stderr, /NOTE {2}12\.N01 {2}combat {2}root does not exist yet/);
  });
});

test('acceptance criterion: importing three in combat/ fails the lint (exit 1)', () => {
  withTempRoot((root) => {
    const probe = writeFile(root, 'combat/probe.js', `import * as THREE from 'three';\nexport function makeVec() { return new THREE.Vector3(); }\n`);
    const result = run(['--root', root, '--verbose']);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstdout:\n${result.stdout}`);
    assert.match(result.stderr, /FAIL {2}12\.N01 {2}combat\/probe\.js:1 {2}imports 'three'/);
    assert.match(result.stdout, /RESULT: FAIL \(1\)/);
    // Never mutates what it scans.
    assert.doesNotThrow(() => readFileSync(probe, 'utf8'));
  });
});

test('transitive closure: three reached through an intermediate helper still fails, with the full chain reported', () => {
  withTempRoot((root) => {
    writeFile(root, 'shared/vecs.js', `import * as THREE from 'three';\nexport function makeVec() { return new THREE.Vector3(); }\n`);
    writeFile(root, 'combat/uses-helper.js', `import { makeVec } from '../shared/vecs.js';\nexport function foo() { return makeVec(); }\n`);

    const jsonPath = join(root, '.report.json');
    const result = run(['--root', root, '--json', jsonPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL {2}12\.N01 {2}shared\/vecs\.js:1 {2}imports 'three'/);
    assert.match(result.stderr, /via combat\/uses-helper\.js -> shared\/vecs\.js/);

    const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const failure = report.failures.find((f) => f.kind === 'three-import');
    assert.ok(failure, 'expected a three-import failure in the JSON report');
    assert.deepEqual(failure.chain, ['combat/uses-helper.js', 'shared/vecs.js']);
  });
});

test('forbidden globals: document / window / performance.now() are each reported, one FAIL per reference', () => {
  withTempRoot((root) => {
    writeFile(
      root,
      'combat/dom-probe.js',
      `export function readClock() {\n  return performance.now() + window.innerWidth + document.title.length;\n}\n`,
    );
    const result = run(['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL {2}12\.N01 {2}combat\/dom-probe\.js:2 {2}references 'window'/);
    assert.match(result.stderr, /FAIL {2}12\.N01 {2}combat\/dom-probe\.js:2 {2}references 'document'/);
    assert.match(result.stderr, /FAIL {2}12\.N01 {2}combat\/dom-probe\.js:2 {2}references 'performance\.now\(\)'/);
  });
});

test('comments/strings are masked: prose mentioning three/window/document does not trip the lint', () => {
  withTempRoot((root) => {
    writeFile(
      root,
      'combat/clean-with-prose.js',
      [
        "// this file must never import 'three', touch window or document.",
        '/* combat imports nothing from three and reads no DOM — see performance.now() in the spec. */',
        "const msg = 'never call window.alert or document.write from combat';",
        'export function ok() { return 1; }',
        '',
      ].join('\n'),
    );
    const result = run(['--root', root]);
    assert.equal(result.status, 0, `prose-only mentions must not fail the lint\nstderr:\n${result.stderr}`);
  });
});

test('core/: three fails it, but a guarded window/document reference does not (checkGlobals: false, matching src/core/ today)', () => {
  withTempRoot((root) => {
    writeFile(root, 'core/imports-three.js', `import * as THREE from 'three';\nexport const v = new THREE.Vector3();\n`);
    writeFile(
      root,
      'core/guarded-globals.js',
      `export function safeSize() {\n  return typeof window !== 'undefined' ? window.innerWidth : 0;\n}\n`,
    );
    const result = run(['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL {2}12\.N01 {2}core\/imports-three\.js:1 {2}imports 'three'/);
    assert.doesNotMatch(result.stderr, /core\/guarded-globals\.js/);
  });
});

test('physics/ and actors/ (O-22): three fails them; window/document does not (three-only, matching core)', () => {
  withTempRoot((root) => {
    writeFile(root, 'physics/imports-three.js', `import * as THREE from 'three';\nexport const v = new THREE.Vector3();\n`);
    writeFile(root, 'physics/touches-window.js', `export function w() { return window.devicePixelRatio; }\n`);
    writeFile(root, 'actors/imports-three.js', `import * as THREE from 'three';\nexport const q = new THREE.Quaternion();\n`);
    writeFile(root, 'actors/touches-document.js', `export function d() { return document.title; }\n`);

    const result = run(['--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL {2}12\.N01 {2}physics\/imports-three\.js:1 {2}imports 'three'/);
    assert.match(result.stderr, /FAIL {2}12\.N01 {2}actors\/imports-three\.js:1 {2}imports 'three'/);
    assert.doesNotMatch(result.stderr, /physics\/touches-window\.js/);
    assert.doesNotMatch(result.stderr, /actors\/touches-document\.js/);
    // Exactly the two three-imports, nothing else.
    const failLines = result.stderr.trim().split('\n').filter((l) => l.startsWith('FAIL'));
    assert.equal(failLines.length, 2);
  });
});

test('--root with a directory that does not exist at all degrades to all-NOTE, exit 0 (never crashes)', () => {
  withTempRoot((root) => {
    const missing = join(root, 'does-not-exist');
    const result = run(['--root', missing]);
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    assert.match(result.stdout, /RESULT: PASS/);
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
  // Deliberately asserts nothing about WHICH of 0/1 — that depends on the
  // real src/ tree's content on a given day and would go stale the moment a
  // gameplay ticket lands a real violation (or fixes one). What this pins is
  // narrower and permanent: the tool itself never throws/crashes (exit 2)
  // against the real, evolving tree. Read-only (no --root override, and this
  // tool never writes anything it scans), so it cannot race any other suite.
  const result = run();
  assert.notEqual(result.status, 2, `tool crashed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /RESULT: (PASS|FAIL)/);
});
