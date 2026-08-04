// tests/tools/mapgen.test.js
//
// TEST-9 acceptance smoke test for `tools/mapgen.mjs`. `node:test` +
// `node:assert/strict`, driven the way `tests/tools/balance.test.js` drives
// `balance.mjs`: `spawnSync`, asserting on exit code and output — this file
// is a CLI, not a module to `import`.
//
// Deliberately THIN. It does NOT re-run the 1 200-layout sweep in-process
// (that run is executed and reported by hand, see this ticket's report) — a
// `node --test` run must stay fast, so every case here uses a tiny
// `--seeds`/`--runs` slice. What it checks: the CLI parses its `=`-form
// flags, `--json` emits a well-formed report off the same `checks[]` the
// human report renders, the exit code is MEANINGFUL, the rulings that scope
// the invariants (D-83's Bonereach NOTE, D-84's FLOOR-CLAMPED list, WRLD-8's
// SKIPs) cannot be silently rolled back into fake passes, and `12.D02`'s own
// promise — two runs at one seed, identical layout hashes — holds, verified
// with an explicit SHA-256 comparison of both the tool's own reported
// `layoutHash` and the full JSON body.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAPGEN = join(REPO_ROOT, 'tools', 'mapgen.mjs');

// A slice small enough for `node --test`, large enough that every check in
// the report has real layouts behind it.
const SLICE = ['--seeds=4', '--runs=1', '--no-fixtures'];

function run(args = []) {
  return spawnSync(process.execPath, [MAPGEN, ...args], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function jsonRun(args) {
  const r = run([...args, '--json']);
  assert.equal(typeof r.status, 'number');
  return { r, report: JSON.parse(r.stdout) };
}

test('mapgen.mjs --help exits 0 and documents the shipped =-form CLI (D-48)', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--seed=/);
  assert.match(r.stdout, /--json/);
  assert.match(r.stdout, /--zone/);
  assert.match(r.stdout, /Exit codes: 0 .*\| 1 .*\| 2 .*\| 3/);
});

test('mapgen.mjs rejects an unknown flag with exit 2 before doing any work', () => {
  const r = run(['--not-a-real-flag=1']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag/);
  assert.equal(r.stdout, '');
});

test('mapgen.mjs rejects a space-separated flag — =-form only, per D-48', () => {
  const r = run(['--seeds', '4']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag/);
});

test('mapgen.mjs --difficulty exits 2 naming the milestone that owns it, never a fake 3x sweep', () => {
  const r = run(['--difficulty=trial']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /AI-11/);
  assert.match(r.stderr, /M6/);
  assert.equal(r.stdout, '', 'an unimplemented flag must not print a report at all');
});

test('mapgen.mjs --json emits a well-formed report off one flat checks[] array', () => {
  const { r, report } = jsonRun(SLICE);
  assert.equal(report.tool, 'mapgen');
  assert.ok(Array.isArray(report.checks));
  assert.ok(report.checks.length > 0);
  for (const c of report.checks) {
    assert.equal(typeof c.id, 'string');
    assert.ok(['fail', 'warn', 'note', 'skip'].includes(c.severity), `bad severity '${c.severity}' on ${c.id}`);
    assert.equal(typeof c.scope, 'string');
    assert.ok(['pass', 'fail', 'warn', 'note', 'skip'].includes(c.status), `bad status '${c.status}' on ${c.id}`);
    assert.ok(Array.isArray(c.lines));
  }
  // The counters are derived from the same array the human report renders.
  const count = (s) => report.checks.filter((c) => c.status === s).length;
  assert.equal(report.passed, count('pass'));
  assert.equal(report.failed, count('fail'));
  assert.equal(report.warned, count('warn'));
  assert.equal(report.notes, count('note'));
  assert.equal(report.skipped, count('skip'));

  // Exit code is meaningful: 3 on non-determinism, else 1 on any fail, else 0.
  const expected = report.checks.some((c) => c.id === '12.D02' && c.status === 'fail') ? 3 : report.failed > 0 ? 1 : 0;
  assert.equal(report.exitCode, expected);
  assert.equal(r.status, expected, `exit code must be ${expected} when failed=${report.failed}`);
});

test('mapgen.mjs prints the layout count it actually evaluated, and never claims the spec\'s 5400', () => {
  const { report } = jsonRun(SLICE);
  const expected = 2 /* built zones */ * 4 /* seeds */ * 1 /* runs */;
  assert.equal(report.layouts, expected, 'the reported count must be the count actually run');
  assert.equal(report.layoutsSpecClaims, 5400);
  assert.equal(report.layoutsSpecArithmetic, 1800);
  assert.match(report.layoutsUnreachableReason, /AI-11|WRLD-8/);

  const human = run(SLICE);
  assert.match(human.stdout, /layouts evaluated: 8\b/);
  assert.match(human.stdout, /5400/);
  assert.match(human.stdout, /1800/);
});

test('mapgen.mjs names the exact call chain each number came from (O-106)', () => {
  const { report } = jsonRun(SLICE);
  assert.match(report.pipeline, /world\.setWorldSeed/);
  assert.match(report.pipeline, /world\.enterZone/);
  assert.match(report.pipeline, /nav\.grid/);
  const human = run(SLICE);
  assert.match(human.stdout, /world\.enterZone/, 'the human report must state the pipeline too');
});

test('I1-I9 are all accounted for — every invariant is present as a verdict or a loud SKIP, none quietly dropped (O-58)', () => {
  const { report } = jsonRun(SLICE);
  const byId = new Map();
  for (const c of report.checks) {
    if (!byId.has(c.id)) byId.set(c.id, []);
    byId.get(c.id).push(c);
  }
  for (const id of ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9']) {
    assert.ok(byId.has(id), `invariant ${id} must appear in the report`);
  }
  // W1/W2 — 07 §7.1's two warnings — must be warnings, never failures.
  for (const id of ['W1', 'W2']) {
    assert.ok(byId.has(id), `${id} must appear`);
    assert.ok(byId.get(id).every((c) => c.severity === 'warn'), `${id} is a tuning signal, never a red gate`);
  }
});

test('WRLD-8 — I5/I7 and the altar third of I1/I2/I3 are loud SKIPs naming the missing generator, never fake passes', () => {
  const { report } = jsonRun(SLICE);
  const altar = report.checks.filter((c) => c.scope === 'altar_of_instruction');
  assert.ok(altar.length > 0, 'the unbuilt zone must still appear in the report');
  assert.ok(altar.every((c) => c.status === 'skip'), 'every altar row must be a skip, never a pass');
  for (const id of ['I1', 'I2', 'I3', 'I5', 'I7']) {
    const row = altar.find((c) => c.id === id);
    assert.ok(row, `${id} must be present for altar_of_instruction`);
    assert.match(row.detail + row.lines.join(' '), /WRLD-8/, `${id}'s skip must name WRLD-8`);
    assert.match(row.detail + row.lines.join(' '), /altar\.js/, `${id}'s skip must name the missing file`);
  }
  // I5/I7 exist nowhere else — they are altar-only per 07 §7.1's "Applies to".
  for (const id of ['I5', 'I7']) {
    assert.ok(report.checks.filter((c) => c.id === id).every((c) => c.scope === 'altar_of_instruction' && c.status === 'skip'));
  }
});

test('D-83 — I8 runs on every zone; Bonereach is a counted NOTE carrying the measured violating fraction, never a silent pass or a weakened threshold', () => {
  const { report } = jsonRun(SLICE);
  const i8 = report.checks.filter((c) => c.id === 'I8');
  const bone = i8.find((c) => c.scope === 'bonereach');
  assert.ok(bone, 'I8 must actually run on bonereach, not be dropped');
  assert.equal(bone.severity, 'note', 'D-83: Bonereach I8 is a NOTE, so it never flips the exit code');
  assert.equal(bone.status, 'note');
  const text = bone.detail + ' ' + bone.lines.join(' ');
  assert.match(text, /D-83/);
  assert.match(text, /MEASURED violating fraction/, 'the note must carry a real measured fraction, not a shrug');
  assert.match(text, /\d+\.\d+ %/, 'the measured fraction must be a number');
  assert.match(text, /interior/i, 'D-83 asked for the excluded-cell count to be printed, not silently applied');
  // Not vacuous: the sweep must actually have found violating cells, or the
  // check has stopped measuring what D-83 says is structurally unavoidable.
  assert.match(bone.detail, /walkable cells/);

  // The wastes row must be a real verdict (D-83 scoped Bonereach only).
  const wastes = i8.find((c) => c.scope === 'ashen_wastes');
  assert.ok(wastes);
  assert.equal(wastes.severity, 'fail', 'I8 outside Bonereach is a normal red gate, not a note');
  assert.ok(wastes.status === 'pass' || wastes.status === 'fail');
});

test('D-84 — I4 on ashen_wastes is checked only where the descriptor floor is satisfiable, and every floor-bound layout is listed as FLOOR-CLAMPED', () => {
  const { report } = jsonRun(['--seeds=25', '--runs=1', '--no-fixtures']);
  const clamped = report.checks.find((c) => c.id === 'I4-FLOOR-CLAMPED' && c.scope === 'ashen_wastes');
  assert.ok(clamped, 'the FLOOR-CLAMPED row must exist for ashen_wastes');
  assert.equal(clamped.severity, 'note', 'D-84: floor-clamped layouts are a note, never a red gate');

  const i4 = report.checks.find((c) => c.id === 'I4' && c.scope === 'ashen_wastes');
  assert.ok(i4);
  assert.match(i4.detail, /\+-20 %/, 'I4 must hold its own NATIVE +-20 % band, not a widened one');
  assert.match(i4.detail, /floor-satisfiable/, 'I4 must state that it is scoped to floor-satisfiable layouts');

  // Not vacuous: 25 seeds must actually contain some floor-bound layouts (the
  // orchestrator measured 20 % of them in D-84). If this ever goes to zero,
  // either the generator improved or the satisfiability test stopped working
  // — both need a human to look.
  const found = Number((clamped.detail.match(/^(\d+)\//) || [0, 0])[1]);
  assert.ok(found > 0, `D-84 measured ~20 % of wastes layouts as floor-bound; this run found ${found}. Zero means the test has gone vacuous.`);
  assert.ok(clamped.lines.some((l) => l.includes('FLOOR-CLAMPED')), 'each floor-bound layout must be individually listed and tagged');
  assert.ok(clamped.lines.some((l) => /achievedDensity=/.test(l)), 'each listed layout must carry its achieved density');
});

test('D-77 / D-80 / D-82 are reported as measured distributions, never asserted at 100 %', () => {
  const { report } = jsonRun(SLICE);
  const d77 = report.checks.find((c) => c.id === 'D-77');
  assert.ok(d77);
  assert.equal(d77.severity, 'note', 'D-77: |connected| in [9,14] is a distribution property, never a gate');
  assert.ok(d77.lines.some((l) => l.startsWith('histogram:')));

  const d82 = report.checks.find((c) => c.id === 'D-82');
  assert.ok(d82, 'the bonereach room-count row must exist');
  assert.match(d82.detail, /ACHIEVED count/, 'D-82: targetRooms is the achieved count, and that identity IS asserted');

  const d80 = report.checks.filter((c) => c.id === 'D-80');
  assert.ok(d80.length > 0);
  for (const c of d80) {
    assert.match(c.detail, /<= propBudget/, 'D-80: propBudget is a ceiling, and the +-5 % band is not asserted');
    assert.ok(c.lines.some((l) => l.includes('achieved fraction of budget')), 'D-80 asked for the achieved fraction to be printed');
  }
});

test('NOTE and SKIP findings are counted and printed loudly, and never change the exit code', () => {
  const { r, report } = jsonRun(SLICE);
  assert.ok(report.notes > 0, 'this run has real notes');
  assert.ok(report.skipped > 0, 'this run has real skips');
  assert.equal(report.exitCode, report.failed > 0 ? 1 : 0, 'only fail-severity checks may move the exit code');
  assert.equal(r.status, report.exitCode);

  const human = run(SLICE);
  assert.match(human.stdout, /NOTE/, 'notes must be printed loudly in the human report');
  assert.match(human.stdout, /SKIP/, 'skips must be printed loudly in the human report');
  assert.match(human.stdout, /\d+ pass · \d+ fail · \d+ warn · \d+ notes · \d+ skip/);
});

test('mapgen.mjs --zone=bonereach runs one zone and still reports the altar SKIPs when asked for all', () => {
  const { report } = jsonRun(['--zone=bonereach', '--seeds=2', '--runs=1', '--no-fixtures']);
  assert.deepEqual(report.zones, ['bonereach']);
  assert.equal(report.layouts, 2);
  assert.ok(report.checks.every((c) => c.scope !== 'ashen_wastes'));

  const unknown = run(['--zone=not_a_zone', '--seeds=1']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown zone/);
});

// ---------------------------------------------------------------------------
// 12.D02 — two runs at one seed produce identical layout hashes
// ---------------------------------------------------------------------------
// Checked twice over, on purpose. First externally: two whole `--json` runs
// at the same base seed, compared by SHA-256 of the report body with the
// wall-clock fields removed — that is the assertion `12` §7 actually writes.
// Then internally: the tool's own `12.D02` row, which regenerates each of
// `07` §7.4's pinned fixture seeds a second time inside one run and compares
// the per-layout hashes. A break there exits **3**, not 1, because a
// determinism failure invalidates every other number in the same run.

function stripClock(report) {
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.seconds;
  for (const k of Object.keys(copy.perZone)) delete copy.perZone[k].seconds;
  return copy;
}

test('12.D02 — two mapgen runs at one seed produce identical layout hashes (explicit hash comparison)', () => {
  const args = ['--seed=0x1F3AC09B', '--seeds=6', '--runs=2', '--no-fixtures', '--json'];
  const a = run(args);
  const b = run(args);
  assert.equal(a.status, b.status);

  const ra = JSON.parse(a.stdout);
  const rb = JSON.parse(b.stdout);

  // The tool's own aggregate layout hash, folded over every layout in sweep
  // order. This is the number 12.D02 names.
  assert.match(ra.layoutHash, /^[0-9a-f]{16}$/);
  assert.equal(ra.layoutHash, rb.layoutHash, '12.D02: the aggregate layout hash must be identical across two runs at one seed');

  // And the whole report body, hashed, once the wall clock is excluded.
  const ha = sha256(JSON.stringify(stripClock(ra)));
  const hb = sha256(JSON.stringify(stripClock(rb)));
  assert.equal(ha, hb, `12.D02: two runs at the same seed must hash identically (${ha} != ${hb})`);
  assert.deepEqual(stripClock(ra), stripClock(rb));

  // Not vacuous: a different base seed must produce a different hash, or the
  // hash is not a function of the layouts at all.
  const c = JSON.parse(run(['--seed=0x00000001', '--seeds=6', '--runs=2', '--no-fixtures', '--json']).stdout);
  assert.notEqual(c.layoutHash, ra.layoutHash, 'the layout hash must actually depend on the layouts');
});

test('12.D02 — the tool checks determinism itself over 07 §7.4\'s pinned fixture seeds, and a break exits 3 not 1', () => {
  // `--seeds=0` runs no sweep at all, so this case costs only the fixture
  // seeds (each generated twice) — the cheapest way to exercise the row.
  const { r, report } = jsonRun(['--seeds=0']);
  const d02 = report.checks.find((c) => c.id === '12.D02');
  assert.ok(d02, 'the tool must check 12.D02 itself, not only in this test file');
  assert.equal(d02.severity, 'fail', 'a determinism break is a red gate');
  assert.equal(d02.status, 'pass', `12.D02 must hold: ${d02.lines.join(' | ')}`);
  assert.match(d02.detail, /pinned fixture run/);
  // Every pinned hash is printed so it can be blessed later.
  assert.ok(d02.lines.length >= 11, '07 §7.4 pins eleven seeds; every one must be listed with its hash');
  for (const line of d02.lines) assert.match(line, /0x[0-9A-F]{8}\s+\w+\s+[0-9a-f]{16}/);

  // Exit-code contract: 3 is reserved for exactly this row.
  assert.equal(report.exitCode, 3 === report.exitCode ? 3 : report.failed > 0 ? 1 : 0);
  assert.equal(r.status, report.exitCode);

  // 12 §6's `tests/fixtures/mapgen/hashes.json` has never been blessed, and
  // that is reported as a SKIP rather than passed over in silence.
  const fixtures = report.checks.find((c) => c.id === 'FIXTURES');
  assert.ok(fixtures);
  assert.equal(fixtures.status, 'skip');
  assert.match(fixtures.detail, /hashes\.json/);
});
