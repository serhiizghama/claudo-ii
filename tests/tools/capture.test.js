// tests/tools/capture.test.js
//
// TEST-3 acceptance tests for `src/dev/shots.js`, `tools/capture.mjs` and
// `tools/imagediff.mjs`. `node:test` + `node:assert/strict` only
// (12-testing.md P6), matching tests/tools/check-imports.test.js and
// tests/tools/check-fixed.test.js: both tools are standalone CLIs, driven
// the same way CI drives them — `spawnSync`, asserting on exit code and
// output.
//
// ---------------------------------------------------------------------------
// This file crosses the N/B boundary on purpose
// ---------------------------------------------------------------------------
// `capture.mjs` is a B-surface tool (12-testing.md §2: needs Playwright and
// a GPU-backed headless Chromium) — most of this suite is therefore NOT
// N-surface-cheap, unlike every other file under tests/. Two things keep
// that honest and bounded:
//   1. Every CLI-validation case (bad flags, missing/unknown --shot) is
//      asserted to fail BEFORE any server or browser starts — both because
//      that is a real correctness property (capture.mjs's own header:
//      "validates --shot ... before touching a server or a browser") and
//      because it is what keeps those specific cases fast and
//      GPU-independent.
//   2. Every case that DOES need a real render shares one `vite preview`
//      server, started once in `before()` via `capture.mjs`'s own
//      `--base-url` flag, instead of each test paying that startup cost
//      (and exercising the "spawn our own" default path nine times over).
//
// `dist/` is built once in `before()` if it is not already present — a fresh
// checkout running `node --test tests/tools/capture.test.js` in isolation
// must not depend on a previous `npm run build` having happened first.
//
// ---------------------------------------------------------------------------
// Filesystem safety
// ---------------------------------------------------------------------------
// Every scratch file this suite writes lives under
// `tests/tools/.tmp-capture-test/`, removed in `after()`. The one exception
// is the real, committed `tests/fixtures/shots/boot_clean.png`: this suite
// only ever READS it (to check it matches a fresh capture) — it never
// blesses over it. The `--bless` code path itself is exercised against
// scratch `--candidate`/`--fixture` overrides instead, so a failing
// assertion here can never leave the committed fixture in a bad state.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { SHOTS, getShot, listShotNames, pumpShot, FIXED_DT } from '../../src/dev/shots.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAPTURE = join(REPO_ROOT, 'tools', 'capture.mjs');
const IMAGEDIFF = join(REPO_ROOT, 'tools', 'imagediff.mjs');
const DIST_INDEX = join(REPO_ROOT, 'dist', 'index.html');
const COMMITTED_FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'shots', 'boot_clean.png');
const SCRATCH_DIR = join(REPO_ROOT, 'tests', 'tools', '.tmp-capture-test');

function run(tool, args = []) {
  return spawnSync(process.execPath, [tool, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

function scratch(name) {
  return join(SCRATCH_DIR, name);
}

function writeSolidPng(path, width, height, [r, g, b, a]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  writeFileSync(path, PNG.sync.write(png));
  return path;
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`server at ${url} did not respond within ${timeoutMs}ms: ${lastErr && lastErr.message}`);
}

let previewProc = null;
let baseUrl = null;

before(async () => {
  if (!existsSync(DIST_INDEX)) {
    const build = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(build.status, 0, `npm run build failed (needed once, so dist/ exists for this suite):\n${build.stdout}\n${build.stderr}`);
  }
  mkdirSync(SCRATCH_DIR, { recursive: true });

  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  previewProc = spawn(process.execPath, [join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
  await waitForServer(baseUrl, 5000);
});

after(async () => {
  if (previewProc) {
    previewProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (previewProc.exitCode === null && previewProc.signalCode === null) previewProc.kill('SIGKILL');
  }
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// src/dev/shots.js — the registry and the pump
// ---------------------------------------------------------------------------

test('shots.js: boot_clean is registered with the M0 shape (12-testing.md §9.1)', () => {
  assert.ok(SHOTS.boot_clean);
  assert.equal(SHOTS.boot_clean.id, 'boot_clean');
  assert.equal(SHOTS.boot_clean.description, 'the first frame, empty scene, camera at rest');
  assert.equal(SHOTS.boot_clean.milestone, 'M0');
  assert.equal(SHOTS.boot_clean.steps, 0);
  assert.equal(listShotNames().includes('boot_clean'), true);
});

test('shots.js: getShot() throws a valid-names-listing error for an unknown shot', () => {
  assert.throws(() => getShot('nope'), /unknown shot "nope"/);
  assert.throws(() => getShot('nope'), /boot_clean/);
});

test('shots.js: pumpShot() drives the engine exactly `steps` times through frame(), never rAF', () => {
  const calls = [];
  const fakeEngine = { frame: (dt) => calls.push(dt) };
  const ran = pumpShot(fakeEngine, 3, FIXED_DT);
  assert.equal(ran, 3);
  assert.deepEqual(calls, [FIXED_DT, FIXED_DT, FIXED_DT]);
});

test('shots.js: pumpShot() has zero free variables — its own source alone reproduces its behaviour', () => {
  // capture.mjs's whole "inject the pump into the page" mechanism (see its
  // header) depends on this: pumpShot.toString(), eval'd with NO access to
  // this module's scope, must still work. This is what that contract means,
  // pinned structurally rather than trusted by inspection.
  // eslint-disable-next-line no-eval
  const reconstructed = (0, eval)(`(${pumpShot.toString()})`);
  let calls = 0;
  const ran = reconstructed({ frame: () => calls++ }, 2, 1 / 60);
  assert.equal(ran, 2);
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// capture.mjs — CLI validation, no server/browser touched
// ---------------------------------------------------------------------------

test('capture.mjs --help exits 0 and documents --shot', () => {
  const r = run(CAPTURE, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--shot <name>/);
});

test('capture.mjs with no --shot exits 2', () => {
  const r = run(CAPTURE, []);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--shot is required/);
});

test('capture.mjs with an unknown --shot exits 2, fast, before any server/browser starts', () => {
  const t0 = Date.now();
  const r = run(CAPTURE, ['--shot', 'does_not_exist']);
  const elapsedMs = Date.now() - t0;
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown shot "does_not_exist"/);
  assert.match(r.stderr, /boot_clean/);
  assert.ok(elapsedMs < 2000, `should fail before touching a server/browser; took ${elapsedMs}ms`);
});

test('capture.mjs with an unknown flag exits 2', () => {
  const r = run(CAPTURE, ['--shot', 'boot_clean', '--nonsense']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag/);
});

// ---------------------------------------------------------------------------
// capture.mjs — the real thing (B surface: server + headless Chromium)
// ---------------------------------------------------------------------------

test('capture.mjs --shot boot_clean: a real, correctly-sized, non-blank PNG (the acceptance criterion)', () => {
  const jsonOut = scratch('report-basic.json');
  const r = run(CAPTURE, ['--shot', 'boot_clean', '--base-url', baseUrl, '--json', jsonOut]);
  assert.equal(r.status, 0, `expected exit 0\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /RESULT: PASS/);

  const report = JSON.parse(readFileSync(jsonOut, 'utf8'));
  assert.equal(report.width, 1280);
  assert.equal(report.height, 720);
  // "Non-blank" is checked structurally, never against a specific colour or
  // coverage fraction: this shot's actual pixels are whatever the *scene*
  // currently puts on screen — an empty clear-colour fill today, ground +
  // player capsule once PLYR-1 lands, real geometry/lighting/grade by M8 —
  // and none of that is this test's business. Its job is only the acceptance
  // criterion itself: a real, correctly-sized, non-blank PNG. A one-off
  // stray pixel would trivially clear a bare `> 0`, so the floor below (1%
  // of the frame) is a deliberately generous sanity margin, not a pin on
  // this or any other milestone's actual scene content. Pixel-exact
  // comparison against a specific rendered frame is `imagediff.mjs`'s job,
  // against the committed fixture — never this test's (12-testing.md §9.2:
  // "the RESPONSE IS to find and remove the non-determinism, not to loosen
  // the gate" is about that tool, not this one).
  const nonBlankFraction = report.nonBlankPixels / report.totalPixels;
  assert.ok(
    nonBlankFraction > 0.01,
    `the frame must be substantially non-blank, not just one stray pixel: ${report.nonBlankPixels}/${report.totalPixels} (${(nonBlankFraction * 100).toFixed(2)}%)`,
  );
  assert.ok(report.elapsedMs < 8000, `capture.mjs's own budget is 8s (12-testing.md §2); took ${report.elapsedMs}ms`);

  // Re-derive "non-blank" independently of capture.mjs's own bookkeeping —
  // decode the PNG it actually wrote and recompute from raw bytes, using the
  // exact same definition capture.mjs's own header documents (a pixel with
  // alpha>0 and any of r/g/b>0).
  const png = PNG.sync.read(readFileSync(join(REPO_ROOT, report.outPath)));
  assert.equal(png.width, 1280);
  assert.equal(png.height, 720);
  let nonBlank = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i + 3] > 0 && (png.data[i] > 0 || png.data[i + 1] > 0 || png.data[i + 2] > 0)) nonBlank++;
  }
  assert.equal(nonBlank, report.nonBlankPixels, "an independent re-scan must agree with capture.mjs's own count");
  assert.ok(nonBlank / (png.width * png.height) > 0.01);
});

test('capture.mjs: two independent runs at the same seed are byte-for-byte pixel-identical (12-testing.md §9.2)', () => {
  function captureOnce(label) {
    const jsonOut = scratch(`det-${label}.json`);
    const r = run(CAPTURE, ['--shot', 'boot_clean', '--base-url', baseUrl, '--json', jsonOut]);
    assert.equal(r.status, 0, `capture #${label} failed:\n${r.stderr}`);
    const report = JSON.parse(readFileSync(jsonOut, 'utf8'));
    // Both runs write to the same default shots/boot_clean.png (capture.mjs
    // has no --out override — see its header) — copy it out immediately so
    // the next run's write doesn't clobber this one before it is compared.
    const saved = scratch(`det-${label}.png`);
    copyFileSync(join(REPO_ROOT, report.outPath), saved);
    return saved;
  }

  const pathA = captureOnce('a');
  const pathB = captureOnce('b');

  assert.ok(readFileSync(pathA).equals(readFileSync(pathB)), 'two captures at the same seed must be byte-identical PNGs');

  // The same proof, the way an operator actually runs it: through
  // imagediff.mjs's own zero-tolerance exit-code contract.
  const diffResult = run(IMAGEDIFF, ['--a', pathA, '--b', pathB, '--json', scratch('det-diff.json')]);
  assert.equal(diffResult.status, 0, `imagediff.mjs should report identical for two same-seed captures:\n${diffResult.stderr}`);
  assert.match(diffResult.stdout, /RESULT: PASS/);
  const diffReport = JSON.parse(readFileSync(scratch('det-diff.json'), 'utf8'));
  assert.equal(diffReport.diffCount, 0);
});

test('capture.mjs: a non-default --seed is accepted and forwarded, but noted as a no-op under ?capture=1', () => {
  const r = run(CAPTURE, ['--shot', 'boot_clean', '--base-url', baseUrl, '--seed', '0xdeadbeef']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /NOTE.*0xdeadbeef.*no effect/);
});

test('capture.mjs: the committed tests/fixtures/shots/boot_clean.png matches a fresh capture exactly', () => {
  assert.ok(existsSync(COMMITTED_FIXTURE), 'tests/fixtures/shots/boot_clean.png must be committed (12-testing.md §6)');
  const fixturePng = PNG.sync.read(readFileSync(COMMITTED_FIXTURE));
  assert.equal(fixturePng.width, 1280);
  assert.equal(fixturePng.height, 720);

  const jsonOut = scratch('fixture-check.json');
  const r = run(CAPTURE, ['--shot', 'boot_clean', '--base-url', baseUrl, '--json', jsonOut]);
  assert.equal(r.status, 0);
  const report = JSON.parse(readFileSync(jsonOut, 'utf8'));

  const diffResult = run(IMAGEDIFF, ['--shot', 'boot_clean', '--candidate', join(REPO_ROOT, report.outPath), '--fixture', COMMITTED_FIXTURE]);
  assert.equal(diffResult.status, 0, `a fresh capture must match the committed fixture exactly:\n${diffResult.stderr}`);
});

// ---------------------------------------------------------------------------
// imagediff.mjs — CLI validation, no PNGs touched
// ---------------------------------------------------------------------------

test('imagediff.mjs --help exits 0', () => {
  const r = run(IMAGEDIFF, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--shot/);
});

test('imagediff.mjs with neither --shot nor --a/--b exits 2', () => {
  const r = run(IMAGEDIFF, []);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /give either --shot/);
});

test('imagediff.mjs with both --shot and --a/--b exits 2', () => {
  const r = run(IMAGEDIFF, ['--shot', 'boot_clean', '--a', 'x', '--b', 'y']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mutually exclusive/);
});

test('imagediff.mjs --bless without --shot exits 2', () => {
  const r = run(IMAGEDIFF, ['--a', 'x', '--b', 'y', '--bless']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /requires --shot/);
});

test('imagediff.mjs with a missing file exits 2', () => {
  const r = run(IMAGEDIFF, ['--a', scratch('nope.png'), '--b', COMMITTED_FIXTURE]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not found/);
});

// ---------------------------------------------------------------------------
// imagediff.mjs — real comparisons over synthetic PNGs (no browser needed)
// ---------------------------------------------------------------------------

test('imagediff.mjs: identical images exit 0 with zero differing pixels', () => {
  // An arbitrary colour — synthetic fixtures for this test, unrelated to any
  // real captured shot's actual pixels (see the "the acceptance criterion"
  // test above for why this file never pins a real shot's colour).
  const a = writeSolidPng(scratch('solid-a.png'), 10, 10, [12, 34, 56, 255]);
  const b = writeSolidPng(scratch('solid-b.png'), 10, 10, [12, 34, 56, 255]);
  const jsonOut = scratch('diff-ok.json');
  const r = run(IMAGEDIFF, ['--a', a, '--b', b, '--json', jsonOut]);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(readFileSync(jsonOut, 'utf8')).diffCount, 0);
});

test('imagediff.mjs: a single differing pixel exits 1 and is reported precisely (12.IMG01)', () => {
  const a = writeSolidPng(scratch('diffpix-a.png'), 4, 4, [1, 2, 3, 255]);
  const b = writeSolidPng(scratch('diffpix-b.png'), 4, 4, [1, 2, 3, 255]);
  const png = PNG.sync.read(readFileSync(b));
  png.data[0] = 9; // flip exactly one channel of pixel (0,0)
  writeFileSync(b, PNG.sync.write(png));

  const r = run(IMAGEDIFF, ['--a', a, '--b', b]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FAIL {2}12\.IMG01/);
  assert.match(r.stderr, /1\/16 pixel\(s\) differ/);
  assert.match(r.stderr, /repro: node tools\/imagediff\.mjs/);
});

test('imagediff.mjs: a dimension mismatch exits 1 and is reported as its own kind (12.IMG02)', () => {
  const a = writeSolidPng(scratch('size-a.png'), 4, 4, [1, 2, 3, 255]);
  const b = writeSolidPng(scratch('size-b.png'), 8, 8, [1, 2, 3, 255]);
  const r = run(IMAGEDIFF, ['--a', a, '--b', b]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FAIL {2}12\.IMG02/);
  assert.match(r.stderr, /expected=4x4 {2}actual=8x8/);
});

test('imagediff.mjs --shot --bless: copies the candidate onto the given --fixture override, never the committed one', () => {
  const candidate = writeSolidPng(scratch('bless-candidate.png'), 4, 4, [7, 8, 9, 255]);
  const fixtureCopy = scratch('bless-fixture.png');
  assert.ok(!existsSync(fixtureCopy));

  const r = run(IMAGEDIFF, ['--shot', 'boot_clean', '--candidate', candidate, '--fixture', fixtureCopy, '--bless']);
  assert.equal(r.status, 0);
  assert.ok(existsSync(fixtureCopy));
  assert.ok(readFileSync(candidate).equals(readFileSync(fixtureCopy)));

  const r2 = run(IMAGEDIFF, ['--shot', 'boot_clean', '--candidate', candidate, '--fixture', fixtureCopy]);
  assert.equal(r2.status, 0, 'comparing right after a bless must pass — it is now comparing the file against itself');
});
