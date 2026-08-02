// tests/skills/synergy.test.js
//
// SKIL-12 — Synergies end to end. This file's own acceptance checks
// (`05-skills.md` §14 row 12, quoted in this ticket's brief):
//   1. All FOURTEEN synergies, enumerated (source -> target, stat, per-level
//      coefficient) so a missing or invented one is visible.
//   2. S11, proved through `./src/skills/synergy.js#validateSynergyGraph` —
//      the ENGINE this ticket ships, not the standalone data check
//      `tests/skills/validation.test.js` (SKIL-1, not this ticket's file)
//      already runs independently over the same data.
//   3. `meteor` at 20/20 sources measures exactly x3.20, with intermediates.
//   4. The `allocated`-not-`effective` rule (`05` §1.3): a `+3 to all
//      skills` amulet never compounds through a synergy.
//   5. `describe()` at level N and N+1, for both a `weaponDamage` skill and
//      a `flatDamage` skill (the ×3.20 check reproduced end to end through
//      the public API, not just the pure `synergy.js` functions).
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SKILLS } from '../../src/skills/data/skills.js';
import { SkillsSystem } from '../../src/skills/index.js';
import { makeStubCtx, makeStubActor } from '../helpers/actor.js';
import {
  SYNERGY_EDGE_COUNT, collectSynergyEdges, validateSynergyGraph,
  weaponDamagePercentAt, flatDamageRangeAt, buildSkillDescription, resetSkillDescription,
} from '../../src/skills/synergy.js';

const EPS = 1e-9;

async function buildSkills() {
  const skills = new SkillsSystem();
  const ctx = makeStubCtx({ systems: { skills } });
  await skills.init(ctx);
  return skills;
}

/** A minimal actor good enough for `allocate`/`synergyBonus`/`describe`. */
function makeActor(overrides = {}) {
  const actor = makeStubActor(overrides);
  actor.stats = {
    skillBonuses: { all: 0, tree: {}, skill: {} },
    manaCostReduction: 0,
    ...(overrides.stats || {}),
  };
  actor.generation = overrides.generation ?? 0;
  actor.cooldowns = overrides.cooldowns ?? new Map();
  return actor;
}

/** `allocate()` deliberately skips tier/prereq checks (`02-api-contracts.md:918`),
 * so raw repeated calls are enough to reach any level without also faking
 * `actor.classId`/`actor.level`. */
function allocateN(skills, actor, skillId, n) {
  for (let i = 0; i < n; i++) {
    const ok = skills.allocate(actor, skillId);
    assert.ok(ok, `allocate(${skillId}) #${i + 1} must succeed (maxLevel is 20 for every skill)`);
  }
}

function makeSkillDescriptionOut() {
  const lines = [];
  for (let i = 0; i < 8; i++) lines.push({ labelKey: null, value: 0, unit: null, format: null });
  return {
    lineCount: 0, lines,
    costResource: null, costAmount: 0,
    cooldown: 0, castTime: 0, radius: 0, range: 0, duration: 0,
    damageMin: 0, damageMax: 0,
  };
}

// ===========================================================================
// 1 — all fourteen synergies, enumerated
// ===========================================================================

// `05-skills.md` §8.7's own table, transcribed here so a missing or invented
// edge is visible against a hand-typed reference, not just a count.
const EXPECTED_SYNERGIES = [
  { source: 'cleaving_strike', target: 'whirlwind', stat: 'weaponDamage', perLevel: 8 },
  { source: 'bloodletting', target: 'sunder', stat: 'weaponDamage', perLevel: 6 },
  { source: 'ram_charge', target: 'war_cry', stat: 'stunDuration', perLevel: 5 },
  { source: 'shield_stance', target: 'iron_skin', stat: 'defensePercent', perLevel: 4 },
  { source: 'ember_bolt', target: 'meteor', stat: 'flatDamage', perLevel: 6 },
  { source: 'fireball', target: 'meteor', stat: 'flatDamage', perLevel: 5 },
  { source: 'flame_wave', target: 'incinerate', stat: 'detonationDamage', perLevel: 4 },
  { source: 'ashen_step', target: 'ash_wall', stat: 'flatDamage', perLevel: 5 },
  { source: 'mana_weave', target: 'essence_burn', stat: 'manaConversion', perLevel: 4 },
  { source: 'rune_strike', target: 'cascade', stat: 'weaponDamage', perLevel: 7 },
  { source: 'blade_seal', target: 'phase_leap', stat: 'weaponDamage', perLevel: 5 },
  { source: 'discharge', target: 'unity', stat: 'flatDamage', perLevel: 6 },
  { source: 'discharge', target: 'thunder_step', stat: 'flatDamage', perLevel: 5 },
  { source: 'resonance_circuit', target: 'echo_blade', stat: 'echoDamage', perLevel: 4 },
];

test('05 §8.7 / AC1 — all fourteen synergies, exactly, matching the printed table', () => {
  assert.equal(SYNERGY_EDGE_COUNT, 14);
  const edges = collectSynergyEdges(SKILLS);
  assert.equal(edges.length, 14, `expected exactly 14 synergy edges, found ${edges.length}`);

  console.log('[SKIL-12] the fourteen synergies:');
  for (const expected of EXPECTED_SYNERGIES) {
    const found = edges.find((e) => e.sourceId === expected.source && e.targetId === expected.target);
    assert.ok(found, `missing synergy ${expected.source} -> ${expected.target}`);
    assert.equal(found.stat, expected.stat, `${expected.source} -> ${expected.target}: stat`);
    assert.equal(found.perLevel, expected.perLevel, `${expected.source} -> ${expected.target}: perLevel`);
    console.log(`  ${expected.source} -> ${expected.target}: +${expected.perLevel}% ${expected.stat}/point`);
  }
  // No extra edge beyond the fourteen named above (O-27: a real count, not
  // "nothing else exists yet" — this is the ticket's own required
  // invariant, checked positively against a literal reference list).
  for (const edge of edges) {
    const known = EXPECTED_SYNERGIES.some((e) => e.source === edge.sourceId && e.target === edge.targetId);
    assert.ok(known, `unexpected synergy edge ${edge.sourceId} -> ${edge.targetId} not in the printed table`);
  }
});

// ===========================================================================
// 2 — S11: source exists, same-class, acyclic
// ===========================================================================

test('S11 — validateSynergyGraph: every source exists, is same-class, and the graph is acyclic', () => {
  const result = validateSynergyGraph(SKILLS);
  console.log('[S11] per-edge check:');
  const byId = new Map(SKILLS.map((d) => [d.id, d]));
  for (const edge of result.edges) {
    const source = byId.get(edge.sourceId);
    const target = byId.get(edge.targetId);
    console.log(
      `  ${edge.sourceId} (${source ? source.classId : 'MISSING'}) -> ${edge.targetId} `
      + `(${target ? target.classId : 'MISSING'}): source exists=${!!source}, `
      + `same-class=${source && target ? source.classId === target.classId : false}`,
    );
  }
  if (result.errors.length) console.log('[S11] errors:', result.errors);
  assert.deepEqual(result.errors, []);
  assert.ok(result.ok);

  // Acyclicity, proved a SECOND, independent way for the report: every
  // synergy SOURCE id has an empty `synergies` array of its own (never
  // targeted by another synergy), so the source-set and target-set are
  // disjoint and the graph is trivially bipartite -> cannot contain a
  // cycle. `validateSynergyGraph` does not rely on this shortcut (it runs a
  // real DFS, see its own header) — this is a second, cheaper proof for
  // the report only.
  const sourceIds = new Set(result.edges.map((e) => e.sourceId));
  const targetIds = new Set(result.edges.map((e) => e.targetId));
  const overlap = [...sourceIds].filter((id) => targetIds.has(id));
  console.log(`[S11] bipartite cross-check: source-set size=${sourceIds.size}, target-set size=${targetIds.size}, overlap=${overlap.length}`);
  assert.equal(overlap.length, 0, `a synergy source must never also be a synergy target (found: ${overlap.join(', ')})`);
});

test('S11 — validateSynergyGraph catches a reciprocal edge (synthetic negative case)', () => {
  // A synthetic two-skill graph with a reciprocal edge — proves the DFS
  // cycle check actually fires, not just that the real data happens to
  // pass (O-27: never assert "nothing else exists" as the only evidence).
  const a = { id: 'a', classId: 'x', synergies: [{ skillId: 'b', stat: 'weaponDamage', perLevel: 1 }] };
  const b = { id: 'b', classId: 'x', synergies: [{ skillId: 'a', stat: 'weaponDamage', perLevel: 1 }] };
  const result = validateSynergyGraph([a, b]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('cycle detected')), `expected a cycle error, got: ${result.errors.join('; ')}`);
});

test('S11 — validateSynergyGraph catches a cross-class edge (synthetic negative case)', () => {
  const a = { id: 'a', classId: 'x', synergies: [] };
  const b = { id: 'b', classId: 'y', synergies: [{ skillId: 'a', stat: 'weaponDamage', perLevel: 1 }] };
  const result = validateSynergyGraph([a, b]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('crosses a class boundary')), `expected a class-boundary error, got: ${result.errors.join('; ')}`);
});

test('SkillsSystem#init() runs S11 live and boots clean against the real SKILLS table', async () => {
  // If the graph were ever broken, init() itself throws (see index.js) —
  // this just proves the real boot path does not.
  await assert.doesNotReject(buildSkills());
});

// ===========================================================================
// 3 — meteor at 20/20 sources measures exactly x3.20
// ===========================================================================

test('AC4 — meteor at 20/20 sources (ember_bolt, fireball) measures exactly x3.20, with intermediates', async () => {
  const skills = await buildSkills();
  const actor = makeActor();

  allocateN(skills, actor, 'ember_bolt', 20);
  allocateN(skills, actor, 'fireball', 20);

  const emberBoltContribution = 6 * 20; // +6%/point x 20 points
  const fireballContribution = 5 * 20; // +5%/point x 20 points
  assert.equal(emberBoltContribution, 120);
  assert.equal(fireballContribution, 100);

  const synergyPercent = skills.synergyBonus(actor, 'meteor', 'flatDamage');
  console.log(`[AC4] synergyBonus(actor, 'meteor', 'flatDamage') = ${synergyPercent} (= ${emberBoltContribution} + ${fireballContribution})`);
  assert.equal(synergyPercent, 220, 'ember_bolt +120% + fireball +100% = +220%');

  const multiplier = (100 + synergyPercent) / 100;
  console.log(`[AC4] multiplier = (100 + ${synergyPercent}) / 100 = ${multiplier}`);
  assert.ok(Math.abs(multiplier - 3.20) < EPS, `expected exactly x3.20, got x${multiplier}`);

  // Reproduced a second way, through the exact function `describe()` calls
  // internally (`weaponDamagePercentAt`'s B7 sibling), at an arbitrary
  // meteor level (the multiplier does not depend on meteor's own level —
  // only on the two SOURCES' allocated levels).
  const def = SKILLS.find((d) => d.id === 'meteor');
  const baseAtL1 = { min: def.flatDamage.minBase, max: def.flatDamage.maxBase };
  const range = flatDamageRangeAt(def, 1, synergyPercent);
  console.log(`[AC4] flatDamageRangeAt(meteor, L1, +220%) = {min:${range.min}, max:${range.max}} `
    + `(base {min:${baseAtL1.min}, max:${baseAtL1.max}} x 3.20)`);
  assert.ok(Math.abs(range.min - baseAtL1.min * 3.20) < EPS);
  assert.ok(Math.abs(range.max - baseAtL1.max * 3.20) < EPS);
});

// ===========================================================================
// 4 — the allocated-not-effective rule (05 §1.3)
// ===========================================================================

test('05 §1.3 — synergies read ALLOCATED level, never effective: +3 to all skills does not compound', async () => {
  const skills = await buildSkills();
  const actor = makeActor();

  allocateN(skills, actor, 'cleaving_strike', 10);
  const baselineSynergy = skills.synergyBonus(actor, 'whirlwind', 'weaponDamage');
  assert.equal(baselineSynergy, 80, 'cleaving_strike allocated=10, +8%/point = +80%');
  // Sanity: effectiveLevel with no bonus equals allocated.
  assert.equal(skills.effectiveLevel(actor, 'cleaving_strike'), 10);

  // Now grant a +3-to-all-skills amulet.
  actor.stats.skillBonuses.all = 3;
  const effectiveAfterAmulet = skills.effectiveLevel(actor, 'cleaving_strike');
  console.log(`[allocated-not-effective] cleaving_strike: allocated=10, effectiveLevel after +3 amulet=${effectiveAfterAmulet}`);
  assert.equal(effectiveAfterAmulet, 13, 'effectiveLevel DOES reflect the +3 amulet — this is the correct, non-synergy path');

  const synergyAfterAmulet = skills.synergyBonus(actor, 'whirlwind', 'weaponDamage');
  console.log(`[allocated-not-effective] synergyBonus(whirlwind, weaponDamage) after +3 amulet = ${synergyAfterAmulet} (unchanged from ${baselineSynergy})`);
  assert.equal(synergyAfterAmulet, baselineSynergy, 'a +3-to-all-skills amulet must NOT compound through a synergy');
  assert.equal(synergyAfterAmulet, 80);
});

// ===========================================================================
// 5 — describe() at level N and N+1
// ===========================================================================

test('describe() — flatDamage skill (meteor), level N and N+1, reflecting the x3.20 synergy', async () => {
  const skills = await buildSkills();
  const actor = makeActor();
  allocateN(skills, actor, 'ember_bolt', 20);
  allocateN(skills, actor, 'fireball', 20);

  const outN = makeSkillDescriptionOut();
  const outN1 = makeSkillDescriptionOut();
  skills.describe(actor, 'meteor', 5, outN);
  skills.describe(actor, 'meteor', 6, outN1);

  console.log(`[describe] meteor L5: damage=${outN.damageMin.toFixed(3)}-${outN.damageMax.toFixed(3)}, cost=${outN.costAmount.toFixed(3)} ${outN.costResource}, cooldown=${outN.cooldown}, duration=${outN.duration}, lineCount=${outN.lineCount}`);
  console.log(`[describe] meteor L6: damage=${outN1.damageMin.toFixed(3)}-${outN1.damageMax.toFixed(3)}, cost=${outN1.costAmount.toFixed(3)} ${outN1.costResource}, cooldown=${outN1.cooldown}, duration=${outN1.duration}, lineCount=${outN1.lineCount}`);

  const def = SKILLS.find((d) => d.id === 'meteor');
  const expectedMinL5 = (def.flatDamage.minBase + def.flatDamage.minPerLevel * 4) * 3.20;
  const expectedMaxL5 = (def.flatDamage.maxBase + def.flatDamage.maxPerLevel * 4) * 3.20;
  assert.ok(Math.abs(outN.damageMin - expectedMinL5) < EPS);
  assert.ok(Math.abs(outN.damageMax - expectedMaxL5) < EPS);
  assert.ok(outN1.damageMin > outN.damageMin, 'L6 must roll higher than L5 (positive perLevel)');
  assert.ok(outN1.damageMax > outN.damageMax);
  assert.equal(outN.costResource, 'mana');
  assert.ok(outN.cooldown >= 4.0, 'meteor cooldown floors at 4.0s (S4)');
  assert.equal(outN.duration, 6, 'meteor pool duration is flat 6s (perLevel 0)');
});

test('describe() — weaponDamage skill (whirlwind), level N and N+1, coefficient includes the cleaving_strike synergy', async () => {
  const skills = await buildSkills();
  const actor = makeActor();
  allocateN(skills, actor, 'cleaving_strike', 10); // +80% synergy into whirlwind

  const outN = makeSkillDescriptionOut();
  const outN1 = makeSkillDescriptionOut();
  skills.describe(actor, 'whirlwind', 3, outN);
  skills.describe(actor, 'whirlwind', 4, outN1);

  const def = SKILLS.find((d) => d.id === 'whirlwind');
  const pctN = weaponDamagePercentAt(def, 3, 80);
  const pctN1 = weaponDamagePercentAt(def, 4, 80);
  console.log(`[describe] whirlwind L3: weaponDamage%=${pctN} (base ${def.weaponDamage.base + def.weaponDamage.perLevel * 2}% + 80% synergy)`);
  console.log(`[describe] whirlwind L4: weaponDamage%=${pctN1}`);

  const weaponLine = outN.lines.find((l) => l.format === 'percent');
  assert.ok(weaponLine, 'expected a weaponDamage% line');
  assert.ok(Math.abs(weaponLine.value - pctN) < EPS);
  assert.ok(pctN1 > pctN, 'L4 must roll a higher coefficient than L3');
  // No absolute weapon damage without a resolved weapon — documented gap
  // (see synergy.js#buildSkillDescription's own doc comment).
  assert.equal(outN.damageMin, 0);
  assert.equal(outN.damageMax, 0);
});

test('describe() — unknown skillId fails closed via resetSkillDescription', async () => {
  const skills = await buildSkills();
  const actor = makeActor();
  const out = makeSkillDescriptionOut();
  out.lineCount = 3; out.costAmount = 99; out.damageMin = 5; // dirty it first
  skills.describe(actor, 'not_a_real_skill', 1, out);
  assert.equal(out.lineCount, 0);
  assert.equal(out.costResource, null);
  assert.equal(out.costAmount, 0);
  assert.equal(out.damageMin, 0);
  assert.equal(out.damageMax, 0);
});

test('buildSkillDescription / resetSkillDescription — direct pure-function coverage, no SkillsSystem instance needed', () => {
  const def = SKILLS.find((d) => d.id === 'cleaving_strike');
  const actor = makeActor();
  const scratch = { cost: { resource: null, amount: 0 }, damageRange: { min: 0, max: 0 } };
  const out = makeSkillDescriptionOut();
  const synergyBonusFn = () => 0; // no live SkillsSystem — a bare stub is enough for a pure-function test
  buildSkillDescription(def, actor, 1, synergyBonusFn, scratch, out);
  assert.equal(out.costResource, 'rage');
  assert.ok(out.costAmount > 0);
  assert.equal(out.range, 0);

  resetSkillDescription(out);
  assert.equal(out.lineCount, 0);
  assert.equal(out.costResource, null);
});
