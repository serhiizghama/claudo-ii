// tests/tools/balance.test.js
//
// TEST-8 (`--skills`) and TEST-9 (`--monsters`, ruling D-70) acceptance smoke
// test for `tools/balance.mjs`. `node:test` + `node:assert/strict`, driven the
// same way `tests/tools/lootsim.test.js` drives `lootsim.mjs`: `spawnSync`,
// asserting on exit code and output — this file is a CLI, not a module to
// `import`.
//
// This is deliberately a THIN smoke test, not a re-run of either full gate
// (see each ticket's report for the acceptance runs, executed and reported by
// hand) — a `node --test` run must stay fast. What this file checks: the CLI
// parses its flags correctly, `--skills` emits a well-formed `--json` report
// covering all 30 skills, `--monsters` emits one covering all twenty `06`
// §12.2 assertion ids, both exit codes are MEANINGFUL,
// `--builds`/`--sweep`/`--progression` each exit 2 naming their owning
// milestone (never a fake pass), and both determinism promises — two runs at
// one seed, byte-identical JSON — hold, verified in-suite with an explicit
// SHA-256 hash of each run's stdout.

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

test('balance.mjs --help exits 0 and documents both modes', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--skills/);
  assert.match(r.stdout, /--monsters/);
  assert.match(r.stdout, /--json/);
});

test('balance.mjs with no flags exits non-zero and names both modes', () => {
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--skills/);
  assert.match(r.stderr, /--monsters/);
});

test('balance.mjs with an unrecognised flag exits 2 before doing any work', () => {
  const r = run(['--not-a-real-flag=1']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag/);
});

// `--monsters` is NOT in this list any more: TEST-9 (ruling D-70) implements
// it. The three below are still M7/M7/M6's own gates and must still exit 2.
for (const flag of ['--builds', '--sweep', '--progression']) {
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

  // B10 was a permanent note under D-54 (unsatisfiable as written). D-85
  // widened the assertion window to 12.0 s and gave it a real verdict — it
  // must now be a normal pass/fail row, never a note, or the ruling has been
  // silently rolled back.
  const b10 = report.perBuild.filter((c) => c.id === 'B10');
  assert.ok(b10.length > 0);
  assert.ok(b10.every((c) => c.status === 'pass' || c.status === 'fail' || c.status === 'skip'), 'B10 must be a real verdict since D-85, never a note');
  assert.ok(b10.some((c) => c.status === 'pass'), 'B10 must actually be evaluated, not skipped away');

  const expectExit = report.failed > 0 ? 1 : 0;
  assert.equal(r.status, expectExit);
});

test('balance.mjs --skills exits 0 — the M4 gate: S1-S12 green, 05.B08 green, B10 green under D-85, B6/B7 present as notes only', () => {
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

test('balance.mjs 12.D01 — two runs at one seed produce byte-identical JSON (no field excluded first)', () => {
  // This test used to `delete reportA.seconds` before hashing. That made it
  // pass while `12` §7's actual requirement — "two runs at one seed produce
  // byte-identical JSON" — was false on every run: the emitter carried a
  // wall-clock `seconds` field, and two consecutive runs differed by exactly
  // it (0.358040584 vs 0.349795375, measured). A test that deletes the field
  // that breaks the criterion is not checking the criterion. The field is
  // gone from `--skills --json` now (`--monsters` never had it), so this
  // hashes the raw bytes, the same way the `--monsters` determinism test
  // below already does.
  const args = ['--skills', '--seed=0x1234', '--json'];
  const a = run(args);
  const b = run(args);
  assert.equal(a.status, b.status);
  assert.equal(sha256(a.stdout), sha256(b.stdout),
    '12.D01: two --skills runs at one seed must hash identically, byte for byte');

  const report = JSON.parse(a.stdout);
  assert.equal(report.seconds, undefined, 'no wall-clock field may re-enter the machine-readable report');
  assert.deepEqual(JSON.parse(a.stdout), JSON.parse(b.stdout));
});

// ---------------------------------------------------------------------------
// D-85 — B10's arithmetic, locked independently of the harness
// ---------------------------------------------------------------------------
// Drives `rollDrChain` (the SHIPPED mechanism, `src/combat/status.js`) rather
// than balance.mjs's copy of the simulation, so a future edit to either one
// cannot quietly diverge from the owner ruling. Three things are pinned:
// the §12.7 chain itself, that the OLD 6.0 s window really was unsatisfiable
// (D-54 was right about the fact, wrong about which number to blame), and
// that the new 12.0 s window still fails a stun long enough to deserve it.
test('D-85 — B10 at a 12.0 s window: the DR chain passes, the old 6.0 s window does not, and the assert still bites', async () => {
  const { rollDrChain } = await import('../../src/combat/status.js');
  const HZ = 60;

  function worstWindow(stun, cooldown, windowSeconds, timelineSeconds = 60) {
    const totalSteps = Math.round(timelineSeconds * HZ);
    const windowSteps = Math.round(windowSeconds * HZ);
    const actor = { stunChain: 0, stunChainAt: 0, ccImmuneUntil: 0 };
    const denied = new Uint8Array(totalSteps);
    const applied = [];
    let nextCast = 0;
    let until = 0;
    for (let step = 0; step < totalSteps; step++) {
      if (step >= nextCast) {
        nextCast = step + Math.round(cooldown * HZ);
        const roll = rollDrChain(actor, step);
        if (roll.allowed) {
          const d = stun * roll.multiplier;
          applied.push(Number(d.toFixed(2)));
          const u = step + Math.round(d * HZ);
          if (u > until) until = u;
        }
      }
      if (step < until) denied[step] = 1;
    }
    let run = 0;
    for (let i = 0; i < windowSteps; i++) run += denied[i];
    let worst = run;
    for (let step = windowSteps; step < totalSteps; step++) {
      run += denied[step] - denied[step - windowSteps];
      if (run > worst) worst = run;
    }
    return { fraction: worst / windowSteps, applied };
  }

  // `ram_charge` at slvl 20 — `05` §12.7's own skill: stun
  // min(2.5, 1.5 + 0.05x19) = 2.45 s, cooldown max(4.0, 8.0 - 0.20x19) = 4.2 s.
  const twelve = worstWindow(2.45, 4.2, 12.0);
  const six = worstWindow(2.45, 4.2, 6.0);

  // §12.7's printed chain, to the same two decimals it prints.
  assert.deepEqual(twelve.applied.slice(0, 4), [2.45, 1.47, 0.88, 0.53]);

  assert.ok(six.fraction > 0.60, `D-54's finding must still reproduce: the 6.0 s window gives ${(six.fraction * 100).toFixed(1)}%, over the 60% ceiling`);
  assert.ok(twelve.fraction <= 0.60, `D-85: the 12.0 s window must pass, got ${(twelve.fraction * 100).toFixed(1)}%`);

  // Not vacuous: a 4.0 s-base stun on the same cooldown must still fail.
  const big = worstWindow(4.0, 4.2, 12.0);
  assert.ok(big.fraction > 0.60, `B10 must still bite: a 4.0 s stun scored only ${(big.fraction * 100).toFixed(1)}%`);
});

// ---------------------------------------------------------------------------
// TEST-9 (D-70) — `--monsters`, the 06-monsters-ai.md §12.2 gate
// ---------------------------------------------------------------------------
// Thin on purpose, exactly like the `--skills` half above: the acceptance run
// itself is executed and reported by hand (see that ticket's report), and a
// `node --test` run must stay fast — `--monsters` takes ~2.4 s per
// invocation, so this section spends three of them and no more. What is
// pinned here: the mode runs at all, its exit code is MEANINGFUL, `--json`
// renders off the same flat `checks[]` the human report does, the loud
// skips that D-70 demanded are present and are really skips, and the
// determinism promise holds BYTE-for-byte (no field deleted first — the
// monsters report carries no wall-clock field at all, deliberately).

let monstersJsonCache = null;
function monstersJson(args = []) {
  if (args.length === 0 && monstersJsonCache) return monstersJsonCache;
  const r = run(['--monsters', '--json', ...args]);
  const parsed = { status: r.status, report: JSON.parse(r.stdout), stdout: r.stdout };
  if (args.length === 0) monstersJsonCache = parsed;
  return parsed;
}

test('balance.mjs --monsters --json emits a well-formed report off the same flat checks[] the human report uses', () => {
  const { status, report } = monstersJson();
  assert.equal(typeof status, 'number');
  assert.equal(report.mode, 'monsters');
  assert.equal(report.document, '06-monsters-ai.md §12.2');
  assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
  for (const c of report.checks) {
    assert.equal(typeof c.id, 'string');
    assert.equal(typeof c.scope, 'string');
    assert.equal(typeof c.detail, 'string');
    assert.ok(['pass', 'fail', 'warn', 'ok', 'note', 'skip'].includes(c.status), `unexpected status '${c.status}' on ${c.id}`);
  }
  const counted = report.passed + report.failed + report.warned + report.notes + report.skipped;
  assert.equal(counted, report.checks.length, 'every check must be counted in exactly one summary bucket');
  // No wall-clock field: the determinism test below hashes the raw bytes.
  assert.equal(report.seconds, undefined, '--monsters --json must carry no elapsed-time field');
});

test('balance.mjs --monsters covers every 06 §12.2 assertion id — MB1..MB20, none quietly dropped (O-58)', () => {
  const { report } = monstersJson();
  const seen = new Set(report.checks.map((c) => c.id.split('.')[0]));
  const all = ['MB1', 'MB2', 'MB3', 'MB4', 'MB5', 'MB5b', 'MB6', 'MB7', 'MB8', 'MB9', 'MB10',
    'MB11', 'MB12', 'MB13', 'MB14', 'MB15', 'MB16', 'MB17', 'MB18', 'MB19', 'MB20'];
  for (const id of all) assert.ok(seen.has(id), `assertion '${id}' must appear in the report, even if only as a loud skip`);
});

test('balance.mjs --monsters: MB5/MB5b (Molgrim, M6) and MB6 (class spread, M7) are LOUD skips naming their milestone — never a fake pass', () => {
  const { report } = monstersJson();
  for (const [id, milestone] of [['MB5', /M6/], ['MB5b', /M6/], ['MB6', /M7/]]) {
    const rows = report.checks.filter((c) => c.id === id);
    assert.equal(rows.length, 1, `${id} must appear exactly once`);
    assert.equal(rows[0].status, 'skip', `${id} must report skip, never pass`);
    assert.match(rows[0].detail, milestone, `${id}'s skip must name the milestone that owns it`);
  }
  // MB13 is D-79's permanent NOTE and must stay a note, carrying its arithmetic.
  const mb13 = report.checks.filter((c) => c.id === 'MB13');
  assert.equal(mb13.length, 1);
  assert.equal(mb13[0].status, 'note', 'MB13 must be a counted NOTE (D-79), never silently passed or dropped');
  assert.match(mb13[0].detail, /D-79/);
  assert.match(mb13[0].detail, /8\.33/, 'MB13\'s note must carry the measured arithmetic, not just a verdict');
});

test('balance.mjs --monsters: MB16/MB17 are real measurements over generated zones (D-75), not deferred any more', () => {
  const { report } = monstersJson();
  const mb16 = report.checks.find((c) => c.id === 'MB16');
  const mb17 = report.checks.find((c) => c.id === 'MB17');
  assert.ok(mb16 && mb17);
  for (const c of [mb16, mb17]) {
    assert.ok(c.status === 'pass' || c.status === 'fail', `${c.id} must be a real verdict now that src/world/gen/ exists (D-75), got '${c.status}'`);
    assert.match(c.scope, /layouts/, `${c.id}'s scope must state how many generated layouts it measured`);
  }
  assert.match(mb16.detail, /nav-fail\/physics-pass/);
  assert.match(mb17.detail, /SPAWN_PUSHED = /);
});

test('balance.mjs --monsters exit code is meaningful: 1 iff a fail-severity check failed, notes and skips never flip it', () => {
  const { status, report } = monstersJson();
  assert.equal(status, report.failed > 0 ? 1 : 0, `exit code must be ${report.failed > 0 ? 1 : 0} when failed=${report.failed}`);
  assert.ok(report.notes > 0 && report.skipped > 0, 'this run is expected to carry both notes and skips');
});

test('balance.mjs --monsters --json is byte-identical across two runs at one seed (no field excluded first)', () => {
  const a = run(['--monsters', '--json', '--seed=0x1234']);
  const b = run(['--monsters', '--json', '--seed=0x1234']);
  assert.equal(a.status, b.status);
  assert.equal(sha256(a.stdout), sha256(b.stdout), 'two --monsters runs at one seed must hash identically, byte for byte');
});

test('balance.mjs --monsters prints a per-assertion human report and --skills/--monsters cannot be combined', () => {
  const human = run(['--monsters']);
  assert.match(human.stdout, /balance\.mjs --monsters/);
  assert.match(human.stdout, /MB1\b/);
  assert.match(human.stdout, /RESULT: (PASS|FAIL)/);
  assert.match(human.stdout, /pass · .* fail · .* warn · .* notes · .* skip/);

  const both = run(['--skills', '--monsters']);
  assert.equal(both.status, 2, 'the two modes are separate and must not be combined');
  assert.match(both.stderr, /may not be combined/);
});
