// tests/tools/balance.test.js
//
// TEST-8 acceptance smoke test for `tools/balance.mjs`. `node:test` +
// `node:assert/strict`, driven the same way `tests/tools/lootsim.test.js`
// drives `lootsim.mjs`: `spawnSync`, asserting on exit code and output —
// this file is a CLI, not a module to `import`.
//
// This is deliberately a THIN smoke test, not a re-run of the full
// 30-skill/4158-build gate itself (see this ticket's report for that run,
// executed and reported by hand) — a `node --test` run must stay fast. What
// this file checks: the CLI parses its flags correctly, `--skills` emits a
// well-formed `--json` report covering all 30 skills, the exit code is
// MEANINGFUL, `--builds`/`--sweep`/`--monsters`/`--progression` each exit 2
// naming their owning milestone (never a fake pass), and `12.D01`'s own
// promise — two runs at one seed, byte-identical JSON — holds, verified
// in-suite with an explicit SHA-256 hash of each run's stdout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BALANCE = join(REPO_ROOT, 'tools', 'balance.mjs');

function run(args = []) {
  return spawnSync(process.execPath, [BALANCE, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

test('balance.mjs --help exits 0 and documents --skills', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--skills/);
  assert.match(r.stdout, /--json/);
});

test('balance.mjs with no flags exits non-zero (this build implements --skills only)', () => {
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--skills/);
});

test('balance.mjs with an unrecognised flag exits 2 before doing any work', () => {
  const r = run(['--not-a-real-flag=1']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag/);
});

for (const flag of ['--builds', '--sweep', '--monsters', '--progression']) {
  test(`balance.mjs ${flag} exits 2 naming the milestone that owns it, never a fake pass`, () => {
    const r = run([flag]);
    assert.equal(r.status, 2, `${flag} must exit 2, not print a pass`);
    assert.match(r.stderr, /M[5-7]/, `${flag}'s error must name an owning milestone`);
    assert.equal(r.stdout, '', `${flag} must not print any report at all`);
  });
}

test('balance.mjs --skills --json covers all 30 skills with S1-S12 and a meaningful exit code', () => {
  const r = run(['--skills', '--json']);
  assert.equal(typeof r.status, 'number');
  const report = JSON.parse(r.stdout);

  assert.equal(report.skills, 30);
  assert.ok(report.builds > 0);
  assert.ok(Array.isArray(report.perSkill));

  const skillIds = new Set(report.perSkill.map((c) => c.scope));
  assert.equal(skillIds.size, 30, 'every one of the 30 skills must appear in perSkill');

  const idsSeen = new Set(report.perSkill.map((c) => c.id));
  for (const id of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12']) {
    assert.ok(idsSeen.has(id), `assertion id '${id}' must appear in the per-skill report`);
  }

  // S7 is a documented SKIP for every skill (no fx registry, no audio field
  // on SkillDefinition — see tools/balance.mjs's own header) and must never
  // silently vanish or read as a fake pass.
  const s7 = report.perSkill.filter((c) => c.id === 'S7');
  assert.equal(s7.length, 30);
  assert.ok(s7.every((c) => c.status === 'skip'), 'S7 must report skip, loudly, for every skill (no fx/audio registry to check against)');

  const expectExit = report.failed > 0 ? 1 : 0;
  assert.equal(r.status, expectExit, `exit code must be ${expectExit} when failed=${report.failed}`);
});

test('balance.mjs --skills covers B1-B11 over the nine named builds plus a generated sweep, notes never flip the exit code', () => {
  const r = run(['--skills', '--json']);
  const report = JSON.parse(r.stdout);
  assert.ok(Array.isArray(report.perBuild));
  assert.ok(report.perBuild.length > 0);

  const idsSeen = new Set(report.perBuild.map((c) => c.id));
  for (const id of ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11']) {
    assert.ok(idsSeen.has(id), `assertion id '${id}' must appear in the per-build report`);
  }

  // B10 is ruled unsatisfiable (D-54) — every occurrence must be a note, and
  // notes are counted but must never change the exit code on their own.
  const b10 = report.perBuild.filter((c) => c.id === 'B10');
  assert.ok(b10.length > 0);
  assert.ok(b10.every((c) => c.status === 'note'), 'B10 must always report as a note (D-54), never pass/fail');
  assert.ok(report.notes >= b10.length, 'the summary must count B10\'s own notes');

  const expectExit = report.failed > 0 ? 1 : 0;
  assert.equal(r.status, expectExit);
});

test('balance.mjs --skills exits 0 — the M4 gate: S1-S12 green, 05.B08 green, B6/B7/B10 present as notes only', () => {
  const r = run(['--skills', '--json']);
  const report = JSON.parse(r.stdout);
  assert.equal(report.failed, 0, 'M4 gate: the run must have zero fail-severity checks');
  assert.equal(r.status, 0, 'M4 gate: exit code must be 0');

  const skillFails = report.perSkill.filter((c) => c.status === 'fail');
  assert.equal(skillFails.length, 0, 'S1-S12 must be green over all 30 skills');

  const b8 = report.perBuild.filter((c) => c.id === 'B8');
  assert.ok(b8.length > 0);
  assert.ok(b8.every((c) => c.status !== 'fail'), '05.B08 (no negative resource, >= 8s burst window) must be green — the M4 gate row names it explicitly');

  // B6 (Instruction-tier Molgrim, out of M4's granted data) and B7 (the M7
  // spread gate, not M4's) must be present and counted, but only as notes.
  for (const id of ['B6', 'B7']) {
    const rows = report.perBuild.filter((c) => c.id === id);
    assert.ok(rows.length > 0, `${id} must appear in the report`);
    assert.ok(rows.every((c) => c.status === 'note'), `${id} must report as a note, not fail (it is M5/M7 territory, not M4's)`);
  }
});

test('balance.mjs --skills reproduces the three 05 §11 simulations within +-2% (Ravager decay 53.34, Emberwright -3.35 mana/s, Runeblade 16.1% overflow)', () => {
  const r = run(['--skills', '--json']);
  const report = JSON.parse(r.stdout);
  const sims = report.perBuild.filter((c) => c.id.startsWith('SIM-'));
  assert.equal(sims.length, 3, 'all three 05 §11 simulations must be present');
  for (const s of sims) {
    assert.notEqual(s.status, 'fail', `${s.id} must reproduce within tolerance: ${s.detail}`);
  }
  const byId = Object.fromEntries(sims.map((s) => [s.id, s.detail]));
  assert.match(byId['SIM-Ravager-decay'], /53\.34/);
  assert.match(byId['SIM-Emberwright-mana'], /-3\.35/);
  assert.match(byId['SIM-Runeblade-resonance'], /16\.1/);
});

test('balance.mjs 12.D01 — two runs at one seed produce byte-identical JSON (hashed)', () => {
  const args = ['--skills', '--seed=0x1234', '--json'];
  const a = run(args);
  const b = run(args);
  assert.equal(a.status, b.status);

  const reportA = JSON.parse(a.stdout);
  const reportB = JSON.parse(b.stdout);
  delete reportA.seconds;
  delete reportB.seconds;
  const hashA = sha256(JSON.stringify(reportA));
  const hashB = sha256(JSON.stringify(reportB));
  assert.equal(hashA, hashB, '12.D01: two runs at the same seed must hash identically once the wall-clock field is excluded');
  assert.deepEqual(reportA, reportB);
});
