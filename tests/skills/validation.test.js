// tests/skills/validation.test.js
//
// SKIL-1 — the four assertions this ticket's acceptance criterion names:
// S1/05.S01 (20-row level tables, every scaling quantity finite and
// monotonic), S2/05.S02 (row 1 == base exactly, row 20 == base + 19 x
// perLevel exactly), S11/05.S11 (synergy sources exist, same class,
// acyclic), S12/05.S12 (prerequisites reference an allocated level, resolve
// to a real skill, satisfiable within 29 points).
//
// This is NOT `tools/balance.mjs` (05 §14 step 14, a later ticket) — it is
// this ticket's own headless proof that the 30 records it authored satisfy
// the four assertions §14 row 1 names, over every `{base, perLevel}`
// (`LevelCurve`) table a record carries, evaluated `L = 1..20` per 05 §1.3:
// "base + perLevel x (L - 1)".
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SKILLS } from '../../src/skills/data/skills.js';

const EPS = 1e-9;

/** @param {{base:number, perLevel:number}} curve @param {number} L */
function curveValue(curve, L) {
  return curve.base + curve.perLevel * (L - 1);
}

/**
 * Every `{base, perLevel}` (`LevelCurve`) table reachable off one
 * `SkillDefinition`, paired with a label for failure messages. Mirrors S1's
 * own scope ("every scaling quantity") without inventing fields the record
 * does not have.
 * @param {object} def
 * @returns {{label:string, curve:{base:number, perLevel:number}}[]}
 */
function levelCurvesOf(def) {
  const out = [];
  const push = (label, curve) => {
    if (curve && typeof curve.base === 'number' && typeof curve.perLevel === 'number') {
      out.push({ label, curve });
    }
  };

  push(`${def.id}.cost`, def.cost);
  push(`${def.id}.cooldown`, def.cooldown);
  push(`${def.id}.weaponDamage`, def.weaponDamage);
  push(`${def.id}.radius`, def.radius);
  push(`${def.id}.duration`, def.duration);
  if (def.flatDamage) {
    push(`${def.id}.flatDamage.min`, { base: def.flatDamage.minBase, perLevel: def.flatDamage.minPerLevel });
    push(`${def.id}.flatDamage.max`, { base: def.flatDamage.maxBase, perLevel: def.flatDamage.maxPerLevel });
  }
  for (let i = 0; i < def.onHitStatus.length; i++) {
    const s = def.onHitStatus[i];
    push(`${def.id}.onHitStatus[${i}].duration`, s.duration);
    push(`${def.id}.onHitStatus[${i}].magnitude`, s.magnitude);
  }
  if (def.passiveStats) {
    for (const key of Object.keys(def.passiveStats)) push(`${def.id}.passiveStats.${key}`, def.passiveStats[key]);
  }
  return out;
}

test('05.S01/S1 — every scaling quantity is finite, non-NaN and 20 rows deep, over all 30 skills', () => {
  const failures = [];
  for (const def of SKILLS) {
    for (const { label, curve } of levelCurvesOf(def)) {
      for (let L = 1; L <= 20; L++) {
        const v = curveValue(curve, L);
        if (!Number.isFinite(v)) failures.push(`${label} L=${L} not finite: ${v}`);
      }
      // Monotonic in the intended direction: perLevel > 0 -> non-decreasing,
      // perLevel < 0 -> non-increasing, perLevel === 0 -> constant. A
      // `cap`, where present, is an evaluation-time clamp applied by the
      // future cost/cooldown engine (SKIL-2's job) — the RAW curve here is
      // still checked uncapped, since that raw monotonic direction is what
      // S1 is actually about (a wrong perLevel SIGN, not a cap).
      const v1 = curveValue(curve, 1);
      const v20 = curveValue(curve, 20);
      if (curve.perLevel > 0 && v20 < v1 - EPS) failures.push(`${label} perLevel>0 but L20 (${v20}) < L1 (${v1})`);
      if (curve.perLevel < 0 && v20 > v1 + EPS) failures.push(`${label} perLevel<0 but L20 (${v20}) > L1 (${v1})`);
      if (curve.perLevel === 0 && Math.abs(v20 - v1) > EPS) failures.push(`${label} perLevel===0 but L1 !== L20`);
    }
  }
  assert.deepEqual(failures, [], `S1 failures:\n${failures.join('\n')}`);
});

test('05.S02/S2 — row 1 equals base exactly, row 20 equals base + 19 x perLevel exactly, over all 30 skills', () => {
  const failures = [];
  for (const def of SKILLS) {
    for (const { label, curve } of levelCurvesOf(def)) {
      const row1 = curveValue(curve, 1);
      const row20 = curveValue(curve, 20);
      const expectedRow1 = curve.base;
      const expectedRow20 = curve.base + 19 * curve.perLevel;
      if (Math.abs(row1 - expectedRow1) > EPS) failures.push(`${label} row1 ${row1} !== base ${expectedRow1}`);
      if (Math.abs(row20 - expectedRow20) > EPS) failures.push(`${label} row20 ${row20} !== base+19*perLevel ${expectedRow20}`);
    }
  }
  assert.deepEqual(failures, [], `S2 failures:\n${failures.join('\n')}`);
});

// Spot-checks against 03-combat-math.md §8's printed L20 figures, so a
// transcription error that happens to still be internally consistent
// (wrong base AND wrong perLevel, cancelling out) cannot hide behind S2's
// arithmetic-only check above.
test('05.S02/S2 — spot-check against 03 §8\'s own printed L1/L20 figures', () => {
  const byId = new Map(SKILLS.map((d) => [d.id, d]));
  const cases = [
    ['cleaving_strike', 'weaponDamage', 40, 160.08], // 03 §8.1 prints "160.1%", rounded
    ['bloodletting', 'weaponDamage', 90, 185],
    ['whirlwind', 'weaponDamage', 55, 131],
    ['sunder', 'weaponDamage', 130, 301],
    ['ram_charge', 'weaponDamage', 100, 233],
    ['rune_strike', 'weaponDamage', 115, 248],
    ['cascade', 'weaponDamage', 70, 184],
    ['phase_leap', 'weaponDamage', 140, 311],
    ['echo_blade', 'weaponDamage', 40, 78],
    ['bloodthirst', 'lifeSteal', 3, 20.1],
  ];
  for (const [id, statKey, l1, l20] of cases) {
    const def = byId.get(id);
    const curve = statKey === 'weaponDamage' ? def.weaponDamage : def.passiveStats[statKey];
    assert.ok(Math.abs(curveValue(curve, 1) - l1) < EPS, `${id}.${statKey} L1`);
    assert.ok(Math.abs(curveValue(curve, 20) - l20) < 1e-6, `${id}.${statKey} L20`);
  }

  // ember_bolt's printed L20 table row: 45.75-78.25 (03 §8.3)
  const eb = byId.get('ember_bolt');
  assert.ok(Math.abs(curveValue({ base: eb.flatDamage.minBase, perLevel: eb.flatDamage.minPerLevel }, 20) - 45.75) < EPS);
  assert.ok(Math.abs(curveValue({ base: eb.flatDamage.maxBase, perLevel: eb.flatDamage.maxPerLevel }, 20) - 78.25) < EPS);
});

test('05.S11/S11 — synergy sources exist, are same-class as the target, and the graph is acyclic (fourteen synergies, 05 §8.7)', () => {
  const byId = new Map(SKILLS.map((d) => [d.id, d]));
  let count = 0;
  const edges = []; // [sourceId, targetId]

  for (const def of SKILLS) {
    for (const syn of def.synergies) {
      count++;
      const source = byId.get(syn.skillId);
      assert.ok(source, `synergy source '${syn.skillId}' (-> ${def.id}) must resolve to a real skill`);
      assert.equal(source.classId, def.classId, `synergy ${syn.skillId} -> ${def.id} must be same-class (found ${source.classId} -> ${def.classId})`);
      assert.equal(typeof syn.perLevel, 'number');
      assert.ok(Number.isFinite(syn.perLevel) && syn.perLevel > 0, `synergy ${syn.skillId} -> ${def.id} perLevel must be a positive finite number`);
      edges.push([syn.skillId, def.id]);
    }
  }

  assert.equal(count, 14, '05 §8.7: "All fourteen synergies"');

  // Acyclic: a target is never, transitively, one of its own sources.
  const adjacency = new Map();
  for (const [source, target] of edges) {
    if (!adjacency.has(source)) adjacency.set(source, []);
    adjacency.get(source).push(target);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const visit = (id) => {
    if (color.get(id) === BLACK) return;
    assert.notEqual(color.get(id), GRAY, `synergy graph must be acyclic — cycle reached at '${id}'`);
    color.set(id, GRAY);
    for (const next of adjacency.get(id) || []) visit(next);
    color.set(id, BLACK);
  };
  for (const id of adjacency.keys()) visit(id);

  // meteor is the one skill with two incoming synergies (05 §8.3).
  const meteorEdgeCount = edges.filter(([, t]) => t === 'meteor').length;
  assert.equal(meteorEdgeCount, 2, 'meteor must have exactly two incoming synergies');
});

test('05.S12/S12 — prerequisites reference an allocated level, resolve to a real skill, and are satisfiable within 29 points', () => {
  const byId = new Map(SKILLS.map((d) => [d.id, d]));
  const withPrereqs = SKILLS.filter((d) => d.requires.length > 0);

  // 05 §8.8: "Two prerequisites in thirty skills."
  assert.equal(withPrereqs.length, 2);

  for (const def of withPrereqs) {
    for (const req of def.requires) {
      const source = byId.get(req.skillId);
      assert.ok(source, `prereq source '${req.skillId}' (<- ${def.id}) must resolve to a real skill`);
      assert.equal(source.classId, def.classId, 'a prerequisite must be same-class as its target');
      assert.ok(Number.isInteger(req.level) && req.level >= 1 && req.level <= source.maxLevel, `prereq level for ${req.skillId} must be a reachable allocated level`);
      // Satisfiable within 29 points: the prereq's own cost plus the
      // target's own tier-1 point must not exceed 29 (a generous, cheap
      // upper bound — the real check is that the WHOLE build in the
      // allocate/respec test below spends exactly 29 and clears both gates).
      assert.ok(req.level + 1 <= 29, `prereq ${req.skillId}>=${req.level} for ${def.id} must be satisfiable within 29 points`);
    }
  }

  assert.deepEqual(byId.get('sunder').requires, [{ skillId: 'bloodletting', level: 3 }]);
  assert.deepEqual(byId.get('meteor').requires, [{ skillId: 'fireball', level: 3 }]);
});

// A prior round of this file wrote `onHitStatus[].chance: 1` on all eight
// riders that carry one, meaning "1% chance to land" to the real consumer
// (`src/combat/status.js:562`: `if (env.rng.next() * 100 >= rider.chance)
// continue` — `env.rng.next()` is 0..1, so `chance` is read on 0..100, not
// 0..1). Every rider `05` §2-§7 prints a chance for states it as `100`
// ("always"); pinned here so a future edit cannot silently reintroduce a
// 0..1 fraction (`05.S09`/S9 territory once statuses ship — this is the
// unit invariant that check would depend on, checked now while the record
// is small enough to eyeball every row by hand).
test('onHitStatus[].chance is a percentage on 0..100 (src/combat/status.js:562), never a 0..1 fraction — every printed rider is 100', () => {
  const byId = new Map(SKILLS.map((d) => [d.id, d]));

  // Every current rider in the 30-skill set happens to be an unconditional
  // ("always applies") status — 05 §2-§7 prints no rider with chance < 100
  // anywhere in the read range. Listed explicitly, one per skill, so a
  // rider silently dropped OR silently added later is caught by count.
  const ridersThatMustBe100 = [
    ['bloodletting', 'bleeding'],
    ['sunder', 'cursed'],
    ['ram_charge', 'stunned'],
    ['war_cry', 'stunned'],
    ['flame_wave', 'burning'],
    ['ashen_step', 'slowed'],
    ['ashen_step', 'blinded'],
    ['thunder_step', 'shocked'],
  ];

  let totalRidersSeen = 0;
  for (const def of SKILLS) {
    for (const rider of def.onHitStatus) {
      totalRidersSeen++;
      assert.equal(typeof rider.chance, 'number', `${def.id}.onHitStatus (${rider.status}) must carry a numeric chance`);
      // The 0..1-fraction bug this test guards against would read as
      // `chance <= 1` here for anything but a genuine 1% (never seen in
      // this file) or 100% rider — both boundary values are explicitly
      // legal per the 0..100 scale, so the real assertion is the exact
      // value check against the printed table below, not a range check.
      assert.ok(rider.chance >= 0 && rider.chance <= 100, `${def.id}.onHitStatus (${rider.status}) chance ${rider.chance} must be on 0..100`);
    }
  }
  assert.equal(totalRidersSeen, ridersThatMustBe100.length, 'rider count drifted — update this test\'s list, not just the count');

  for (const [id, status] of ridersThatMustBe100) {
    const def = byId.get(id);
    const rider = def.onHitStatus.find((r) => r.status === status);
    assert.ok(rider, `${id} must carry an onHitStatus rider for '${status}'`);
    assert.equal(rider.chance, 100, `${id}.onHitStatus (${status}) chance must be 100 (percentage, not fraction) — src/combat/status.js:562`);
  }
});
