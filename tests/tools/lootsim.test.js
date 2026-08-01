// tests/tools/lootsim.test.js
//
// TEST-7 acceptance smoke test for `tools/lootsim.mjs`. `node:test` +
// `node:assert/strict`, driven the same way `tests/tools/capture.test.js`
// drives `capture.mjs`/`imagediff.mjs`: `spawnSync`, asserting on exit code
// and output — this file is a CLI, not a module to `import`.
//
// This is deliberately a THIN smoke test, not a re-run of the acceptance
// criterion itself: the full six-profile, 200 000-drop, every-§10.2-id
// gate is this ticket's own job, run and reported by hand (see the
// ticket's report) — a `node --test` run must stay fast, and the full gate
// takes several seconds even with nothing wrong. What this file checks is
// narrower and cheaper: the CLI parses its flags correctly, a small
// `--drops` run finishes quickly and emits well-formed `--json`, the exit
// code is MEANINGFUL (0 iff no fail-severity check failed, matching the
// tool's own `failed` count — not just "some code", per `04` §10.3's exit
// contract), and 12.D03's own promise (two runs at one seed, byte-
// identical) holds at a size small enough to assert directly, in-suite,
// not just by hand.
//
// Every dedicated-sampler size inside `lootsim.mjs` (`R2`'s fast/tagged
// counts, `L1`'s per-level count, `G1`'s sample, `N2`'s trial count) scales
// down with `--drops` (see that file's own `scaleN` helper) specifically so
// a small `--drops` smoke run here stays fast — a few hundred milliseconds,
// not the several seconds the full 200 000-drop gate needs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOOTSIM = join(REPO_ROOT, 'tools', 'lootsim.mjs');

function run(args = []) {
  return spawnSync(process.execPath, [LOOTSIM, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

test('lootsim.mjs --help exits 0 and documents every flag `04` §10.1 invokes with', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--drops/);
  assert.match(r.stdout, /--seed/);
  assert.match(r.stdout, /--profile/);
  assert.match(r.stdout, /--json/);
});

test('lootsim.mjs with an unrecognised flag exits non-zero (2) before doing any work', () => {
  const r = run(['--not-a-real-flag=1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag/);
});

test('lootsim.mjs with an unknown --profile exits non-zero (2), naming the six real ones', () => {
  const r = run(['--drops=200', '--profile=nonexistent']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown profile/);
  for (const name of ['early', 'mid', 'late', 'champ', 'boss', 'sweep']) {
    assert.match(r.stderr, new RegExp(name));
  }
});

test('lootsim.mjs --json emits the §10.3-shaped report and a MEANINGFUL exit code', () => {
  const r = run(['--drops=300', '--seed=0x1', '--profile=early', '--json']);
  assert.equal(typeof r.status, 'number');
  const report = JSON.parse(r.stdout);

  assert.equal(report.seed, '0x1');
  assert.equal(report.drops, 300);
  assert.equal(typeof report.totalDrops, 'number');
  assert.equal(Array.isArray(report.profiles), true);
  assert.ok(report.profiles.length >= 1);
  assert.equal(Array.isArray(report.global), true, 'the global/dedicated scopes must be a sibling key, not folded into profiles (04 §10.3 rule 4)');
  assert.equal(typeof report.passed, 'number');
  assert.equal(typeof report.failed, 'number');
  assert.equal(typeof report.warned, 'number');
  assert.equal(typeof report.seconds, 'number');
  assert.ok(report.seconds >= 0);

  // Coordinator round 3 — the workload proof: each profiles[] entry
  // carries its own COUNTED drop total (not the configured --drops echoed
  // back), and it must equal --drops when nothing short-circuited.
  const earlyProfile = report.profiles.find((p) => p.name === 'early');
  assert.ok(earlyProfile, 'the requested profile must appear in profiles[]');
  assert.equal(earlyProfile.drops, 300, "profiles[].drops must be the ACTUAL COUNTED total, matching --drops here since nothing broke");
  assert.equal(report.totalDrops, 300, 'totalDrops must be the sum of counted drops across the profiles actually run');
  const s1 = earlyProfile.checks.find((c) => c.id === 'S1');
  assert.ok(s1, "S1 (the counted-drops-equals-configured hard check) must be present");
  assert.equal(s1.status, 'pass');

  // Every id from `04` §10.2's table must appear at least once, somewhere
  // in profiles[] or global[] (a fully narrowed assertion set — this
  // ticket's own named historical risk — is exactly what this line
  // catches).
  const allIds = new Set();
  for (const p of report.profiles) for (const c of p.checks) allIds.add(c.id);
  for (const g of report.global) for (const c of g.checks) allIds.add(c.id);
  const required = [
    'R1', 'R2', 'R3', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8',
    'B1', 'B2', 'L1', 'L2', 'L3', 'U1', 'U2', 'G1', 'G2', 'D1', 'D2', 'N1', 'N2',
  ];
  for (const id of required) assert.ok(allIds.has(id), `assertion id '${id}' must appear in the report`);

  // The exit contract (`04` §10.3): "Exit code 1 on any fail, 0 with a
  // printed summary on warn only." — checked against the tool's OWN
  // `failed` count, not a guessed threshold.
  const expectExit = report.failed > 0 ? 1 : 0;
  assert.equal(r.status, expectExit, `exit code must be ${expectExit} when failed=${report.failed}`);
});

test('lootsim.mjs --profile=<name> restricts profiles[] to that one profile only', () => {
  const r = run(['--drops=200', '--profile=boss', '--json']);
  const report = JSON.parse(r.stdout);
  const profileNames = new Set(report.profiles.map((p) => p.name));
  assert.deepEqual([...profileNames], ['boss'], 'profiles[] must hold only the profile actually requested');
  const boss = report.profiles.find((p) => p.name === 'boss');
  assert.equal(boss.drops, 200, "boss's own counted drop total must be reported");

  // early/mid/late/champ/sweep's own per-profile checks (R1/D1/D2) must not
  // appear when only `boss` was requested — the coverage checks (A1/B1/U1/
  // U2/G2, which the spec ties to `sweep` specifically) are correctly
  // reported as skipped under `global`, not silently omitted (`04` §10.4/
  // rule 7: never assert "nothing else exists" by simply not mentioning it).
  let sawSkip = false;
  for (const g of report.global) {
    for (const c of g.checks) {
      if (c.status === 'skip') sawSkip = true;
    }
  }
  assert.ok(sawSkip, 'A1/B1/U1/U2/G2 should report skip under global, not silently vanish, when sweep was not selected');
});

test('lootsim.mjs 12.D03 — two runs at the same seed produce byte-identical --json (modulo the wall-clock field)', () => {
  const args = ['--drops=500', '--seed=0x99', '--profile=mid', '--json'];
  const a = run(args);
  const b = run(args);
  const reportA = JSON.parse(a.stdout);
  const reportB = JSON.parse(b.stdout);
  delete reportA.seconds;
  delete reportB.seconds;
  assert.deepEqual(reportA, reportB, 'two runs at the same seed must produce identical reports (12.D03)');
});

test('lootsim.mjs rejects a non-positive --drops without crashing uninformatively', () => {
  const r = run(['--drops=0']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--drops/);
});
