// tests/ai/spawn.test.js
//
// AI-7 acceptance tests — `src/ai/spawn.js` (pack templates, §5.2 resolution,
// `bestiaryWeights`, the §10.1 spawn pass, §10.2's re-assert, §10.3 activation
// tiers, §10.5 despawn) plus `src/ai/index.js`'s wiring.
//
// Assertion set is D-64's, not the backlog's: **MB11, MB17, MB20, MB9**
// (`06-monsters-ai.md` §12.2).
//
// ---------------------------------------------------------------------------
// O-106's rule: drive the REAL pipeline, and say which call produced the number
// ---------------------------------------------------------------------------
// WRLD-7 was accepted on a harness "in the exact shape of" the real pipeline
// that reported 600/600 clean while the orchestrator's own probe through the
// real `world.setWorldSeed()` -> `world.enterZone()` got 56/60 — because the
// lookalike skipped a pass the real one runs. Every MB17 / spawn-pass number
// in this file therefore comes from
//   `world.setWorldSeed(seed)` -> `await world.enterZone(zoneId, tag, {runIndex})`
//     -> `world` emits `zone:ready`
//       -> `AiSystem`'s OWN listener runs `runSpawnPass`
//         -> read back through `ai.spawnStats` / `ai.aliveCount` / `actors.all`
// and never from a reimplementation of that chain. `resolveRoster`/MB9/MB11/
// MB20 are pure functions over frozen tables with no pipeline to skip; they
// are called directly, which IS their real call path (`06` §16 A1's whole
// point is that `tools/mapgen.mjs` reaches them with no engine at all).
//
// Node-safe: `node:test` + `node:assert/strict`. `three` is imported only by
// the real-pipeline section, which needs a `THREE.Scene` for `world`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';

import {
  PACK_TEMPLATES,
  PACK_TIER,
  ACTIVATION_RADIUS,
  DEACTIVATION_RADIUS,
  SPAWN_SAFETY,
  packTemplate,
  isPackTemplateId,
  resolveRoster,
  packSizeFloor,
  effectivePackCount,
  templateArchetypeIds,
  bestiaryWeights,
  championCount,
  promotionRanks,
  describeComposition,
  createSpawnStore,
  updatePackTier,
  packTierOf,
} from '../../src/ai/spawn.js';
import { BESTIARY, damageMult, arMult, lifeMult } from '../../src/ai/data/bestiary.js';
import { chanceToHit } from '../../src/combat/tohit.js';
import { stepR7a } from '../../src/combat/resolve.js';
import { ZONE_DESCRIPTORS_BY_ID } from '../../src/world/data/zones.js';

import { WorldSystem } from '../../src/world/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { NavSystem } from '../../src/nav/index.js';
import { MaterialsSystem } from '../../src/materials/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { CombatSystem } from '../../src/combat/packet.js';
import { AiSystem } from '../../src/ai/index.js';
import { Rng } from '../../src/core/rng.js';
import { makeStubCtx } from '../helpers/actor.js';

/** Which zone each template belongs to, per `06` §5.3 / §5.4 / §5.5. */
const TEMPLATE_ZONE = Object.freeze({
  pk_ranker_line: 'ashen_wastes', pk_ranker_archer: 'ashen_wastes', pk_swarm: 'ashen_wastes',
  pk_swarm_ranker: 'ashen_wastes', pk_archer_nest: 'ashen_wastes', pk_shaman_court: 'ashen_wastes',
  pk_crawler_run: 'ashen_wastes', pk_warband: 'ashen_wastes',
  pk_bone_line: 'bonereach', pk_bone_archer: 'bonereach', pk_maul_guard: 'bonereach',
  pk_swarm_flood: 'bonereach', pk_crawler_nest: 'bonereach', pk_shaman_vault: 'bonereach',
  pk_deep_warband: 'bonereach',
  pk_altar_guard: 'altar_of_instruction', pk_altar_line: 'altar_of_instruction',
});

const ALL_TEMPLATE_IDS = Object.keys(PACK_TEMPLATES);

// ===========================================================================
// Acceptance 1 — `packTemplate` returns FROZEN records
// ===========================================================================

test('AI-7 acceptance 1: packTemplate returns deeply frozen records, and the same object every call', () => {
  for (const id of ALL_TEMPLATE_IDS) {
    const t = packTemplate(id);
    assert.ok(t, `packTemplate('${id}') must not be null`);
    assert.equal(Object.isFrozen(t), true, `${id}: record must be frozen`);
    assert.equal(Object.isFrozen(t.fixed), true, `${id}: .fixed must be frozen`);
    assert.equal(Object.isFrozen(t.share), true, `${id}: .share must be frozen`);
    for (const f of t.fixed) assert.equal(Object.isFrozen(f), true, `${id}: every .fixed entry must be frozen`);
    for (const s of t.share) assert.equal(Object.isFrozen(s), true, `${id}: every .share entry must be frozen`);
    assert.equal(packTemplate(id), t, `${id}: Alloc: no — the same frozen object every call`);

    // Frozen is only meaningful if a write actually fails to land.
    const beforeFloor = t.sizeFloor;
    try { t.sizeFloor = 999; } catch { /* strict-mode throw is equally acceptable */ }
    assert.equal(t.sizeFloor, beforeFloor, `${id}: a write to a frozen record must not land`);
    const beforeF = t.share[0].f;
    try { t.share[0].f = 999; } catch { /* ditto */ }
    assert.equal(t.share[0].f, beforeF, `${id}: a write into .share must not land`);
  }

  assert.equal(Object.isFrozen(PACK_TEMPLATES), true);
  assert.equal(packTemplate('bone_ranker'), null, 'a bestiary id must return null (06 §16 A1)');
  assert.equal(packTemplate('nope'), null);
  assert.equal(packTemplate(undefined), null);
  assert.equal(isPackTemplateId('pk_warband'), true);
  assert.equal(isPackTemplateId('bone_ranker'), false);
});

test('the 17 templates of 06 §5.3/§5.4/§5.5 are all present, with their printed size floors', () => {
  assert.equal(ALL_TEMPLATE_IDS.length, 17, '8 Wastes + 7 Bonereach + 2 Altar');
  const floors = {
    pk_ranker_line: 5, pk_ranker_archer: 5, pk_swarm: 6, pk_swarm_ranker: 7,
    pk_archer_nest: 5, pk_shaman_court: 6, pk_crawler_run: 5, pk_warband: 8,
    pk_bone_line: 5, pk_bone_archer: 5, pk_maul_guard: 5, pk_swarm_flood: 6,
    pk_crawler_nest: 6, pk_shaman_vault: 6, pk_deep_warband: 8,
    // §5.5 prints no "Pack size floor" column for the Altar rows at all.
    pk_altar_guard: 0, pk_altar_line: 0,
  };
  for (const [id, f] of Object.entries(floors)) assert.equal(packSizeFloor(id), f, `${id} size floor`);
  for (const id of ALL_TEMPLATE_IDS) {
    const sum = PACK_TEMPLATES[id].share.reduce((a, s) => a + s.f, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${id}: share must sum to 1.00, got ${sum}`);
  }
});

// ===========================================================================
// §5.2 — the spec's own worked examples
// ===========================================================================

test('06 §5.2 worked example: pk_warband at count 8 -> 1 Shaman, 3 Rankers, 2 Archers, 2 Swarmers', () => {
  const roster = resolveRoster('pk_warband', 8);
  assert.equal(roster.length, 8);
  const n = (a) => roster.filter((x) => x === a).length;
  assert.equal(n('dust_shaman'), 1);
  assert.equal(n('bone_ranker'), 3);
  assert.equal(n('ashen_archer'), 2);
  assert.equal(n('carrion_swarm'), 2);
});

test('06 §5.4 worked corridor cases: every wanderer template at count 1', () => {
  assert.deepEqual(resolveRoster('pk_bone_line', 1), ['bone_ranker'], '"pk_bone_line yields one Ranker"');
  assert.deepEqual(resolveRoster('pk_maul_guard', 1), ['maulsmith'], '"pk_maul_guard yields the fixed Maulsmith alone"');
  assert.deepEqual(resolveRoster('pk_swarm_flood', 1), ['carrion_swarm'], '"yield one Swarmer"');
  assert.deepEqual(resolveRoster('pk_crawler_nest', 1), ['blight_crawler'], '"/ one Crawler"');
});

test('06 §5.1: a bestiary id spawns `count` identical monsters', () => {
  assert.deepEqual(resolveRoster('bone_ranker', 4), ['bone_ranker', 'bone_ranker', 'bone_ranker', 'bone_ranker']);
  assert.deepEqual(resolveRoster('bone_ranker', 0), []);
});

// ===========================================================================
// MB11 — "Every pack template resolves to exactly `count` members at every
//         count 5...12 and never violates a member minimum" (exact)
// ===========================================================================

test('MB11: every template resolves to EXACTLY count at every count 5..12', () => {
  let checked = 0;
  for (const id of ALL_TEMPLATE_IDS) {
    for (let c = 5; c <= 12; c++) {
      const roster = resolveRoster(id, c);
      assert.equal(roster.length, c, `${id} at count ${c}: got ${roster.length}`);
      for (const a of roster) assert.ok(BESTIARY[a], `${id} at ${c}: '${a}' is not a bestiary archetype`);
      checked++;
    }
  }
  assert.equal(checked, 17 * 8, 'MB11 coverage: 17 templates x counts 5..12 = 136 resolutions');
  console.log(`  MB11 exact-count: ${checked}/${checked} resolutions returned exactly their count`);
});

test('MB11: member minima hold at every count 5..12 ONCE §5.3\'s own size floor is applied (which is what the real pass always does)', () => {
  let violations = 0;
  for (const id of ALL_TEMPLATE_IDS) {
    for (let c = 5; c <= 12; c++) {
      const eff = effectivePackCount(id, c);
      const roster = resolveRoster(id, eff);
      assert.equal(roster.length, eff, `${id} at effective count ${eff}`);
      for (const s of PACK_TEMPLATES[id].share) {
        const got = roster.filter((a) => a === s.archetypeId).length;
        if (got < s.min) violations++;
        assert.ok(got >= s.min, `${id} at effective count ${eff}: ${s.archetypeId} ${got} < min ${s.min}`);
      }
    }
  }
  assert.equal(violations, 0);
  console.log('  MB11 minima (with §5.3 floors): 0 violations over 17 templates x counts 5..12');
});

test('MB11 CONFLICT, pinned: pk_swarm_ranker\'s minima are INFEASIBLE at a raw count of 5 — §12.2 says "every count 5..12", §5.3 floors this template at 7', () => {
  // swarm >= 4 and ranker >= 2 sum to 6 > 5. §5.2's transfer rule has no
  // surplus to take from, so it terminates leaving the total exact and the
  // minimum unmet. This is the ONLY such case in the whole table, and it is
  // unreachable in the real pass (the floor raises the count to 7 first).
  const t = PACK_TEMPLATES.pk_swarm_ranker;
  assert.equal(t.share[0].min + t.share[1].min, 6);
  assert.equal(packSizeFloor('pk_swarm_ranker'), 7);
  const raw = resolveRoster('pk_swarm_ranker', 5);
  assert.equal(raw.length, 5, 'still exact — resolution is total even when minima are infeasible');
  assert.equal(raw.filter((a) => a === 'carrion_swarm').length, 3, 'swarm lands at 3, one short of its minimum of 4');
  assert.equal(effectivePackCount('pk_swarm_ranker', 5), 7, 'the real pass never resolves this template below 7');
  // At 7 the largest-remainder split is 4.55 / 2.45 -> wholes 4 / 2, the one
  // spare slot going to the larger fraction (the swarm's 0.55): 5 / 2. Both
  // minima are then already met and the transfer rule never fires.
  const eff = resolveRoster('pk_swarm_ranker', 7);
  assert.equal(eff.filter((a) => a === 'carrion_swarm').length, 5);
  assert.equal(eff.filter((a) => a === 'bone_ranker').length, 2);

  // Nothing else in the table is infeasible anywhere in 5..12.
  let others = 0;
  for (const id of ALL_TEMPLATE_IDS) {
    if (id === 'pk_swarm_ranker') continue;
    for (let c = 5; c <= 12; c++) {
      for (const s of PACK_TEMPLATES[id].share) {
        if (resolveRoster(id, c).filter((a) => a === s.archetypeId).length < s.min) others++;
      }
    }
  }
  assert.equal(others, 0, 'pk_swarm_ranker@5 must be the only infeasible cell in the table');
  console.log('  MB11 conflict: 1 infeasible cell (pk_swarm_ranker @ raw count 5, minima sum 6 > 5); 0 others; unreachable in the real pass (floor 7)');
});

// ===========================================================================
// MB20 — "Every `archetypeId` referenced by a pack template appears in that
//         zone's `ZoneDescriptor.bestiary`" (exact)
// ===========================================================================

test('MB20: Ashen Wastes PASSES against the SHIPPED src/world/data/zones.js bestiary', () => {
  const shipped = ZONE_DESCRIPTORS_BY_ID.ashen_wastes.bestiary;
  const used = [...new Set(ALL_TEMPLATE_IDS.filter((t) => TEMPLATE_ZONE[t] === 'ashen_wastes').flatMap(templateArchetypeIds))];
  const missing = used.filter((a) => !shipped.includes(a));
  assert.deepEqual(missing, [], `Wastes templates reference ${used.join(', ')}`);
  assert.equal(used.length, 5);
  console.log(`  MB20 ashen_wastes: PASS — 5/5 referenced archetypes present in the shipped bestiary`);
});

test('MB20: every archetype Bonereach and Altar templates reference is in the SHIPPED descriptor bestiary', () => {
  // This test used to pin the opposite — both bestiaries shipped
  // `Object.freeze([])` ("real bestiary is 06's data, not read for this
  // ticket [WRLD-1]") and MB20 failed on every archetype. Filled from
  // `07` §4.1 / §5.1 (O-139). The one token those arrays do NOT give
  // literally is `maulsmith`, printed there as `hammerfell_brute`; `06`
  // §15 D-2 is the standing resolution and §5.4 names it, so the shipped
  // id is what the templates use.
  const bonereachUsed = [...new Set(ALL_TEMPLATE_IDS.filter((t) => TEMPLATE_ZONE[t] === 'bonereach').flatMap(templateArchetypeIds))];
  const altarUsed = [...new Set(ALL_TEMPLATE_IDS.filter((t) => TEMPLATE_ZONE[t] === 'altar_of_instruction').flatMap(templateArchetypeIds))];

  assert.equal(bonereachUsed.length, 6, 'Bonereach templates reference 6 archetypes');
  assert.equal(altarUsed.length, 2, 'Altar templates reference 2 archetypes');

  const bonereachShipped = [...ZONE_DESCRIPTORS_BY_ID.bonereach.bestiary];
  const altarShipped = [...ZONE_DESCRIPTORS_BY_ID.altar_of_instruction.bestiary];
  assert.deepEqual(bonereachUsed.filter((a) => !bonereachShipped.includes(a)), [], 'MB20 bonereach: no template archetype may be missing from the shipped bestiary');
  assert.deepEqual(altarUsed.filter((a) => !altarShipped.includes(a)), [], 'MB20 altar: no template archetype may be missing from the shipped bestiary');

  // D-2 stays measured rather than assumed: the mismatch is exactly one
  // token, and it is the one the ruling names.
  const specProse = { bonereach: ['bone_ranker', 'carrion_swarm', 'ashen_archer', 'dust_shaman', 'blight_crawler', 'hammerfell_brute'], altar_of_instruction: ['bone_ranker', 'ashen_archer'] };
  assert.deepEqual(bonereachUsed.filter((a) => !specProse.bonereach.includes(a)), ['maulsmith'], 'D-2, exactly: one token');
  assert.deepEqual(altarUsed.filter((a) => !specProse.altar_of_instruction.includes(a)), []);

  console.log(`  MB20 bonereach: PASS — ${bonereachUsed.length}/${bonereachUsed.length} template archetypes present in the shipped bestiary [${bonereachShipped.join(', ')}]`);
  console.log(`  MB20 altar_of_instruction: PASS — ${altarUsed.length}/${altarUsed.length} present in [${altarShipped.join(', ')}]`);
});

// ===========================================================================
// MB9 — "Stand-still survival time of every pack template against the
//        reference build at the zone `mlvl`" (>= 3.0 s)
// ===========================================================================
//
// Method is `06` §5.6's, which is `03-combat-math.md` §11.5's exactly: the
// level-10 reference Ravager (165 life, DEF 137, `damageReduceFlat = 2`).
// The to-hit and the flat-DR step come from the REAL `combat` functions
// (`chanceToHit`, `stepR7a`), not a transcription of the formula — a test may
// import another subsystem directly (rule 2 governs production code), and
// driving the real function is the whole point.
//
// `blight_crawler` has no `attackTime` (one-shot detonate) and §5.6 gives it
// as a flat "7.900 DPS while active" — transcribed, since no mlvl-scaling
// form for it exists anywhere in the binding documents.

const REF_TARGET = Object.freeze({ life: 165, defense: 137, clvl: 10, damageReduceFlat: 2 });
const CRAWLER_DPS = 7.900; // 06 §5.6, verbatim — see above

function monsterDps(archetypeId, mlvl) {
  if (archetypeId === 'blight_crawler') return CRAWLER_DPS;
  const row = BESTIARY[archetypeId];
  const ar = Math.round(row.baseAttackRating * arMult(mlvl));
  const hit = chanceToHit(ar, REF_TARGET.defense, mlvl, REF_TARGET.clvl) / 100;
  const avg = ((row.baseMinDamage + row.baseMaxDamage) / 2) * damageMult(mlvl);
  return hit * stepR7a(avg, REF_TARGET.damageReduceFlat) / row.attackTime;
}

function survivalSeconds(templateId, count, mlvl) {
  const dps = resolveRoster(templateId, count).reduce((a, m) => a + monsterDps(m, mlvl), 0);
  return REF_TARGET.life / dps;
}

test('MB9 method check: the per-monster DPS column of 06 §5.6 reproduces from the real chanceToHit/stepR7a + the shipped bestiary', () => {
  const printed = { bone_ranker: 5.983, ashen_archer: 5.875, carrion_swarm: 5.118, dust_shaman: 3.719, maulsmith: 13.500 };
  for (const [id, exp] of Object.entries(printed)) {
    const got = monsterDps(id, 10);
    assert.ok(Math.abs(got - exp) < 0.005, `${id}: §5.6 prints ${exp}, computed ${got.toFixed(4)}`);
  }
  // and the hit-chance / per-landed-hit columns, to the printed decimal
  assert.equal(chanceToHit(199, 137, 10, 10).toFixed(2), '59.23', 'bone_ranker hit % (§5.6)');
  assert.equal(chanceToHit(230, 137, 10, 10).toFixed(2), '62.67', 'ashen_archer hit % (§5.6)');
  assert.equal(chanceToHit(243, 137, 10, 10).toFixed(2), '63.95', 'maulsmith hit % (§5.6)');
});

test('MB9: 06 §5.6\'s five PUBLISHED survival rows reproduce to the printed decimal, and all clear the 3.0 s floor', () => {
  const published = [
    ['pk_ranker_line', 8, 47.87, 3.45],
    ['pk_ranker_archer', 8, 47.55, 3.47],
    ['pk_swarm', 10, 51.18, 3.22],
    ['pk_shaman_court', 8, 45.61, 3.62],
    ['pk_warband', 8, 43.66, 3.78],
  ];
  for (const [id, n, packDps, surv] of published) {
    const dps = resolveRoster(id, n).reduce((a, m) => a + monsterDps(m, 10), 0);
    const s = REF_TARGET.life / dps;
    assert.ok(Math.abs(dps - packDps) < 0.02, `${id} pack DPS: §5.6 prints ${packDps}, computed ${dps.toFixed(3)}`);
    assert.ok(Math.abs(s - surv) < 0.01, `${id} survival: §5.6 prints ${surv} s, computed ${s.toFixed(3)} s`);
    assert.ok(s >= 3.0, `${id}: MB9 floor`);
    console.log(`  MB9 §5.6 row ${id.padEnd(18)} n=${n}  packDPS ${dps.toFixed(2)} (spec ${packDps})  survival ${s.toFixed(3)}s (spec ${surv})  >= 3.0 PASS`);
  }
});

test('MB9 GAP, measured and pinned: pk_maul_guard misses the 3.0 s floor at count 8 (2.979 s), and 14 of 17 templates miss it at their zone\'s packSize.max', () => {
  // §5.6's published table contains NO Bonereach template and evaluates
  // nothing above count 10 — so neither of these cells was ever scored by the
  // spec. Both are computed here rather than asserted away.
  const maul = survivalSeconds('pk_maul_guard', 8, 10);
  assert.ok(Math.abs(maul - 2.979) < 0.002, `pk_maul_guard @8, mlvl 10: ${maul.toFixed(4)} s`);
  assert.ok(maul < 3.0, 'this is the finding — if it now passes, the Maulsmith row or its template changed');

  const atEight = [];
  for (const id of ALL_TEMPLATE_IDS) {
    const s = survivalSeconds(id, Math.max(8, packSizeFloor(id)), 10);
    atEight.push([id, s]);
  }
  const failEight = atEight.filter(([, s]) => s < 3.0).map(([id]) => id);
  assert.deepEqual(failEight, ['pk_maul_guard'], 'at count 8, pk_maul_guard is the ONLY template under the floor');

  const maxN = { ashen_wastes: 12, bonereach: 10, altar_of_instruction: 7 };
  const failMax = [];
  for (const id of ALL_TEMPLATE_IDS) {
    const n = Math.max(maxN[TEMPLATE_ZONE[id]], packSizeFloor(id));
    const s = survivalSeconds(id, n, 10);
    if (s < 3.0) failMax.push(`${id}@${n}=${s.toFixed(3)}s`);
  }
  assert.equal(failMax.length, 14, `at each zone's own packSize.max: ${failMax.join(' ')}`);
  console.log(`  MB9 at count 8 (§5.6's own count), mlvl 10: 16/17 templates >= 3.0 s; UNDER: pk_maul_guard ${maul.toFixed(3)}s`);
  console.log(`  MB9 at each zone's shipped packSize.max, mlvl 10: 14/17 UNDER the floor -> ${failMax.join(', ')}`);
});

test('MB9 AMBIGUITY, recorded: "at the zone mlvl" is not evaluable — the binding docs pin a reference build only at clvl 10', () => {
  // `03` §11.1 defines the three reference builds at clvl 10 and nowhere
  // else; `06` §12.2 MB5 nonetheless puts the player at clvl 13 for the
  // mlvl-15 Altar. Holding the target at 165 life / DEF 137 while raising
  // mlvl is therefore an apples-to-oranges read, and it is what produces
  // these numbers.
  const zoneMlvl = { ashen_wastes: 6, bonereach: 11, altar_of_instruction: 15 };
  const maxN = { ashen_wastes: 12, bonereach: 10, altar_of_instruction: 7 };
  const rows = [];
  for (const id of ALL_TEMPLATE_IDS) {
    const z = TEMPLATE_ZONE[id];
    const n = Math.max(maxN[z], packSizeFloor(id));
    rows.push([id, z, zoneMlvl[z], n, survivalSeconds(id, n, zoneMlvl[z])]);
  }
  const wastes = rows.filter((r) => r[1] === 'ashen_wastes');
  assert.equal(wastes.every((r) => r[4] >= 3.0), true, 'every Wastes template clears 3.0 s at its own mlvl 6, even at count 12');
  const worstWastes = Math.min(...wastes.map((r) => r[4]));
  assert.ok(Math.abs(worstWastes - 3.016) < 0.005, `worst Wastes template at mlvl 6 / count 12: ${worstWastes.toFixed(4)} s`);
  for (const [id, z, m, n, s] of rows) {
    console.log(`  MB9 zone-mlvl  ${id.padEnd(18)} ${z.padEnd(21)} mlvl ${String(m).padStart(2)}  n=${String(n).padStart(2)}  survival ${s.toFixed(3)}s  ${s >= 3.0 ? 'PASS' : 'FAIL (vs a clvl-10 target — see this test\'s comment)'}`);
  }
});

// ===========================================================================
// §5.1 / §5.3 / §5.4 / §5.5 — bestiaryWeights
// ===========================================================================

test('bestiaryWeights: every row of 06 §5.3/§5.4/§5.5 sums to 100 and names only real templates', () => {
  const rows = [
    ['ashen_wastes', ['ash_flats', 'dead_grove', 'ruin_field', 'bone_yard', 'ravine', 'warcamp']],
    ['bonereach', ['hall', 'vault', 'flooded', 'stair', 'corridor']],
    ['altar_of_instruction', ['approach']],
  ];
  for (const [zone, keys] of rows) {
    for (const k of keys) {
      const w = bestiaryWeights(zone, k);
      assert.ok(Object.isFrozen(w), `${zone}.${k} must be frozen`);
      const sum = w.reduce((a, e) => a + e.weight, 0);
      assert.equal(sum, 100, `${zone}.${k} weights sum`);
      for (const e of w) {
        assert.ok(packTemplate(e.templateId), `${zone}.${k} names unknown template ${e.templateId}`);
        assert.equal(TEMPLATE_ZONE[e.templateId], zone, `${zone}.${k} names ${e.templateId}, a ${TEMPLATE_ZONE[e.templateId]} template`);
      }
    }
  }
  // The design statements §5.3/§5.4 spell out in prose.
  const warcamp = bestiaryWeights('ashen_wastes', 'warcamp');
  assert.equal(warcamp.find((e) => e.templateId === 'pk_warband').weight, 30);
  for (const k of ['ash_flats', 'dead_grove', 'ruin_field', 'bone_yard', 'ravine']) {
    assert.equal(bestiaryWeights('ashen_wastes', k).find((e) => e.templateId === 'pk_warband').weight, 0,
      '"the warcamp is the only cell that ever fields a warband"');
  }
  assert.deepEqual([...bestiaryWeights('bonereach', 'entry')], [], '"entry rooms ... receive no packs at all"');
  assert.deepEqual([...bestiaryWeights('bonereach', 'nope')], []);
  assert.deepEqual([...bestiaryWeights('nope', 'hall')], []);
});

test('bestiaryWeights: the corridor (wanderer) row resolves every non-zero template at count 1', () => {
  for (const e of bestiaryWeights('bonereach', 'corridor')) {
    if (e.weight === 0) continue;
    assert.equal(resolveRoster(e.templateId, 1).length, 1, `${e.templateId} at count 1`);
  }
});

// ===========================================================================
// §5.7 — promotion (counts only; affixes are AI-8's)
// ===========================================================================

test('06 §5.7 promotion table reproduces exactly for counts 5..12', () => {
  const champs = { 5: 2, 6: 2, 7: 2, 8: 3, 9: 3, 10: 4, 11: 4, 12: 4 };
  for (const [c, expected] of Object.entries(champs)) {
    const n = Number(c);
    assert.equal(championCount(n), expected, `count ${n}`);
    const ranks = promotionRanks(n, 'champion');
    assert.equal(ranks.filter((r) => r === 'champion').length, expected);
    assert.equal(ranks.length, n);
    assert.equal(ranks.slice(0, expected).every((r) => r === 'champion'), true, 'the lowest SpawnPoint.ids are the champions');

    const uniq = promotionRanks(n, 'unique');
    assert.equal(uniq.filter((r) => r === 'unique').length, 1);
    assert.equal(uniq.filter((r) => r === 'minion').length, n - 1, `count ${n}: minions if unique`);
    assert.equal(uniq[0], 'unique');
  }
  assert.equal(promotionRanks(8, 'normal').every((r) => r === 'normal'), true);
});

// ===========================================================================
// Acceptance 2 — headless: `mapgen` reports composition without `three`,
// without a DOM and WITHOUT instantiating `ai`
// ===========================================================================

test('AI-7 acceptance 2: src/ai/spawn.js reports composition in a bare node process — no three, no DOM, no AiSystem', () => {
  // A real child process, not an in-process assumption: this one imports
  // ONLY `src/ai/spawn.js`, deletes `globalThis.document`/`window` first so
  // any accidental DOM touch throws, and prints a composition report.
  const script = `
    globalThis.document = undefined; globalThis.window = undefined;
    const m = await import('./src/ai/spawn.js');
    const packs = [
      { id: 0, archetypeId: 'pk_warband', count: 8, rank: 'champion' },
      { id: 1, archetypeId: 'pk_swarm_ranker', count: 5, rank: 'unique' },
      { id: 2, archetypeId: 'bone_ranker', count: 6, rank: 'normal' },
    ];
    const r = m.describeComposition(packs);
    console.log(JSON.stringify({ total: r.total, byArchetype: r.byArchetype, raised: r.packSizeRaised,
      loaded: Object.keys(globalThis).includes('THREE') }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('../../', import.meta.url).pathname, encoding: 'utf8',
  }).trim();
  const r = JSON.parse(out);
  // pack 1's count 5 is raised to pk_swarm_ranker's floor of 7 (§5.3)
  assert.equal(r.total, 8 + 7 + 6);
  assert.equal(r.raised, 1);
  // pk_warband@8 = 1 shaman + 3 ranker + 2 archer + 2 swarm;
  // pk_swarm_ranker@7 (raised from 5) = 5 swarm + 2 ranker; bone_ranker@6 = 6.
  assert.deepEqual(r.byArchetype, {
    dust_shaman: 1, bone_ranker: 3 + 2 + 6, ashen_archer: 2, carrion_swarm: 2 + 5,
  });
  console.log(`  headless composition (child process, no engine): ${out}`);
});

test('describeComposition: in-process, matches the child process and carries per-pack rosters and ranks', () => {
  const r = describeComposition([{ id: 0, archetypeId: 'pk_warband', count: 8, rank: 'champion' }]);
  assert.equal(r.total, 8);
  assert.equal(r.packs[0].roster.length, 8);
  assert.equal(r.packs[0].ranks.filter((x) => x === 'champion').length, 3);
  assert.deepEqual(r.byTemplate, { pk_warband: 1 });
  assert.deepEqual(describeComposition([]).byArchetype, {});
  assert.deepEqual(describeComposition([{ id: 0, archetypeId: null, count: 5, rank: 'normal' }]).packs, [],
    'a null archetypeId (the shipped Bonereach state) contributes nothing rather than throwing');
});

// ===========================================================================
// §10.3 — activation tiers, as a unit
// ===========================================================================

test('06 §10.3: activation at 34 m, deactivation at 42 m AND 10 s without damage', () => {
  assert.equal(ACTIVATION_RADIUS, 34.0);
  assert.equal(DEACTIVATION_RADIUS, 42.0);
  const store = createSpawnStore(4);
  store.count = 1;
  store.centerX[0] = 0; store.centerZ[0] = 0;
  store.tier[0] = PACK_TIER.C;
  store.memberCount[0] = 8;
  store.lastDamageStep[0] = -100000;

  assert.equal(updatePackTier(store, 0, 0, 34.5, 0), PACK_TIER.C, 'outside 34 m stays dormant');
  assert.equal(updatePackTier(store, 0, 0, 33.9, 0), PACK_TIER.B, 'inside 34 m activates, but not full tier');
  assert.equal(updatePackTier(store, 0, 0, 10.0, 0), PACK_TIER.A, 'close in -> tier A');
  assert.equal(updatePackTier(store, 0, 0, 40.0, 0), PACK_TIER.B, 'the 8 m hysteresis: 40 m is past 34 but not past 42');
  assert.equal(updatePackTier(store, 0, 0, 43.0, 0), PACK_TIER.C, 'past 42 m and quiet -> dormant');

  // ... and the damage clock blocks deactivation for a full 10 s.
  store.tier[0] = PACK_TIER.B;
  store.lastDamageStep[0] = 1000;
  assert.equal(updatePackTier(store, 0, 0, 100.0, 1000 + 599), PACK_TIER.B, '9.98 s after a hit: still active');
  assert.equal(updatePackTier(store, 0, 0, 100.0, 1000 + 600), PACK_TIER.C, '10.0 s after a hit: dormant');
});

test('packTierOf reports tier A for any actor no spawn pass owns — this is what makes AI-7\'s fixedUpdate gate additive', () => {
  const store = createSpawnStore(4);
  assert.equal(packTierOf(store, 0), PACK_TIER.A);
  assert.equal(packTierOf(store, 511), PACK_TIER.A);
  assert.equal(packTierOf(store, -1), PACK_TIER.A);
  assert.equal(packTierOf(store, 99999), PACK_TIER.A);
});

// ===========================================================================
// REAL PIPELINE — world.setWorldSeed -> world.enterZone -> zone:ready ->
// AiSystem's own listener -> ai.spawnStats / actors.all
// ===========================================================================

async function bootFullEngine(rngSeed) {
  const world = new WorldSystem();
  const physics = new PhysicsSystem();
  const nav = new NavSystem();
  const materials = new MaterialsSystem();
  const actors = new ActorsSystem();
  const combat = new CombatSystem();
  const ai = new AiSystem();
  const scene = new THREE.Scene();
  const ctx = makeStubCtx({
    rng: new Rng(rngSeed), scene,
    systems: { world, physics, nav, materials, actors, combat, ai, render: { renderer: null } },
  });
  await physics.init(ctx);
  await materials.init(ctx);
  await actors.init(ctx);
  await combat.init(ctx);
  await world.init(ctx);
  await nav.init(ctx);
  await ai.init(ctx);
  return { world, physics, nav, actors, combat, ai, ctx };
}

test('SWEEP (REAL PIPELINE): Ashen Wastes — 60 real enterZone calls spawn real monsters through ai.spawnOne; MB17 SPAWN_PUSHED === 0', async () => {
  let pushed = 0;
  let packs = 0;
  let monsters = 0;
  let refused = 0;
  let raised = 0;
  let descriptorPacks = 0;
  let descriptorPoints = 0;
  const runs = 60;
  for (let i = 0; i < runs; i++) {
    const { world, ai, actors } = await bootFullEngine(4000 + i);
    world.setWorldSeed((0x7ac70000 + i) >>> 0);
    await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: i % 3 });
    const s = ai.spawnStats;
    pushed += s.spawnPushed;
    packs += s.packsSpawned;
    monsters += s.monstersSpawned;
    refused += s.spawnRefused;
    raised += s.packSizeRaised;
    descriptorPacks += world.packs.length;
    descriptorPoints += world.spawnPoints.length;

    assert.equal(s.monstersSpawned, world.spawnPoints.filter((p) => p.kind === 'pack').length,
      `run ${i}: every pack SpawnPoint must become a monster`);
    assert.equal(ai.aliveCount, s.monstersSpawned, `run ${i}: ai.aliveCount must match what the pass spawned`);
    assert.equal(actors.all.filter((a) => a.kind === 'monster').length, s.monstersSpawned, `run ${i}: actors.all agrees`);
  }
  assert.equal(pushed, 0, `MB17: SPAWN_PUSHED must be 0 across ${runs} real enterZone calls, got ${pushed}`);
  assert.equal(refused, 0, 'no spawnOne refusal — every roster archetype must have a brain');
  assert.ok(monsters > 3000, `sanity: ${monsters} monsters over ${runs} zones`);
  assert.equal(descriptorPacks, packs, 'every PackDescriptor world produced was spawned');
  assert.equal(descriptorPoints, monsters, 'every SpawnPoint world produced became an actor');
  console.log(`  MB17 ashen_wastes (REAL world.enterZone x${runs}): SPAWN_PUSHED=${pushed}, packs=${packs}, monsters=${monsters}, refused=${refused}, PACK_SIZE_RAISED=${raised}`);
});

test('SWEEP (REAL PIPELINE): Bonereach spawns — every PackDescriptor resolves an archetype and becomes monsters', async () => {
  // This test used to measure the opposite and call it out loudly:
  // `src/world/data/zones.js` shipped `bonereach.bestiary = []`, so
  // `src/world/spawn.js` guarded step 2, left `p.archetypeId = null` on every
  // pack, and Bonereach was monster-free in the shipped tree — which made its
  // MB17 zero VACUOUS. The bestiary is filled from `07` §4.1 now (O-139), so
  // the same measurement is kept and the expectation inverted.
  let nullArchetypes = 0;
  let packDescriptors = 0;
  let monsters = 0;
  let pushed = 0;
  const runs = 20;
  for (let i = 0; i < runs; i++) {
    const { world, ai } = await bootFullEngine(6000 + i);
    world.setWorldSeed((0xb04e0000 + i) >>> 0);
    await world.enterZone('bonereach', 'descent', { runIndex: i % 3 });
    packDescriptors += world.packs.length;
    nullArchetypes += world.packs.filter((p) => p.archetypeId == null).length;
    monsters += ai.spawnStats.monstersSpawned;
    pushed += ai.spawnStats.spawnPushed;
  }
  assert.equal(nullArchetypes, 0, 'no Bonereach pack may carry archetypeId: null once the bestiary is real');
  assert.ok(monsters > 0, `Bonereach must actually spawn — got ${monsters} monsters over ${runs} zones`);
  assert.equal(pushed, 0, 'MB17: SPAWN_PUSHED must stay 0 now that the zero is no longer vacuous');
  console.log(`  bonereach (REAL world.enterZone x${runs}): ${packDescriptors} PackDescriptors, ${nullArchetypes} with archetypeId=null, ${monsters} monsters spawned, SPAWN_PUSHED=${pushed} -> MB17=0 is REAL here`);
});

test('REAL PIPELINE: the spawn pass fills PackDescriptor.members/spawned/aliveCount with DISTINCT refs (01 §9.5)', async () => {
  const { world, ai, actors } = await bootFullEngine(7001);
  world.setWorldSeed(0x5eed0001);
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 1 });
  assert.ok(world.packs.length > 0);
  for (const p of world.packs) {
    assert.equal(p.spawned, true, `pack ${p.id}.spawned`);
    assert.equal(p.aliveCount, p.count, `pack ${p.id}.aliveCount`);
    assert.equal(p.members.length, p.count, `pack ${p.id}.members length`);
    const ids = new Set(p.members.map((m) => m.id));
    assert.equal(ids.size, p.count, `pack ${p.id}: members must be DISTINCT refs — actors.ref(actor) with no out returns a SHARED scratch`);
    for (const ref of p.members) assert.ok(actors.resolve(ref), `pack ${p.id}: every ref must resolve`);
  }
  assert.equal(ai.aliveCount, world.packs.reduce((a, p) => a + p.count, 0));
});

test('REAL PIPELINE: spawned monsters carry composed life (ACTR-24) and their pack\'s mlvl, in ascending SpawnPoint.id order', async () => {
  const { world, ai, actors } = await bootFullEngine(7002);
  world.setWorldSeed(0x5eed0002);
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  const monsters = actors.all.filter((a) => a.kind === 'monster');
  assert.ok(monsters.length > 0);
  // AI-8 note: the rank term is part of this product. When this test was
  // written every monster spawned at `rank: 'normal'` because §5.7 promotion
  // was inert on life — `spawnOne` re-derived `baseLife x lifeMult(mlvl)`
  // with no rank factor and clobbered the composed value `actors.spawn()`
  // had already got right (a champion arrived at 351 and left at 88). AI-8
  // corrected that line, so `03` §9.3's Life column now reaches the actor and
  // the expectation here has to carry it too. Transcribed from §9.3's own
  // table (03-combat-math.md L886-L892), not imported from the composition
  // under test.
  const RANK_LIFE = { normal: 1.0, minion: 1.6, champion: 4.0, unique: 7.0, boss: 1.0 };
  const byRank = {};
  for (const m of monsters) {
    assert.equal(m.level, 6, 'ashen_wastes mlvl is 6');
    const mult = RANK_LIFE[m.rank];
    assert.ok(mult !== undefined, `unexpected rank '${m.rank}'`);
    byRank[m.rank] = (byRank[m.rank] || 0) + 1;
    const expected = Math.round(BESTIARY[m.archetypeId].baseLife * lifeMult(6) * mult);
    assert.equal(m.life, expected, `${m.archetypeId}/${m.rank} life at mlvl 6 (§9.3 x${mult})`);
    assert.ok(m.life > 1, 'ACTR-24: a monster is never left at life 1');
  }
  assert.ok(byRank.champion > 0 || byRank.unique > 0,
    'this seed must promote somebody, or the rank term above is unmeasured');
  // Roster order: the pack's k-th member sits on its k-th SpawnPoint by id.
  const pack = world.packs[0];
  const pts = world.spawnPoints.filter((p) => p.packIndex === pack.id).sort((a, b) => a.id - b.id);
  const roster = resolveRoster(pack.archetypeId, pack.count);
  for (let k = 0; k < pack.count; k++) {
    const a = actors.resolve(pack.members[k]);
    assert.equal(a.archetypeId, roster[k], `member ${k} archetype`);
    assert.ok(Math.abs(a.x - pts[k].x) < 1e-6 && Math.abs(a.z - pts[k].z) < 1e-6, `member ${k} sits on SpawnPoint ${pts[k].id}`);
  }
  console.log(`  real spawn: ${monsters.length} monsters, mlvl 6, life composed per ACTR-24 x §9.3's rank term (${Object.entries(byRank).map(([k, v]) => `${k} ${v}`).join(', ')}; bare bone_ranker ${Math.round(BESTIARY.bone_ranker.baseLife * lifeMult(6))})`);
});

test('REAL PIPELINE: the pass is deterministic — the same world seed twice gives an identical roster, position and rank order', async () => {
  const snapshot = async () => {
    const { world, actors } = await bootFullEngine(7003);
    world.setWorldSeed(0x5eed0003);
    await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 2 });
    return actors.all.filter((a) => a.kind === 'monster')
      .map((a) => `${a.archetypeId}|${a.x.toFixed(6)}|${a.z.toFixed(6)}|${a.rank}|${a.level}|${a.life}`).join('\n');
  };
  const a = await snapshot();
  const b = await snapshot();
  assert.equal(a, b, 'two independent boots at the same seed must produce byte-identical monsters');
  assert.ok(a.length > 0);
});

test('REAL PIPELINE: §10.3 — packs are instantiated dormant and no brain ticks until the player is inside 34 m', async () => {
  const { world, ai, actors, ctx } = await bootFullEngine(7004);
  world.setWorldSeed(0x5eed0004);
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  const store = ai._spawnStore;
  assert.ok(store.count > 0, 'packs registered');
  assert.equal([...store.tier.slice(0, store.count)].every((t) => t === PACK_TIER.C), true,
    '§10.3: "A pack is instantiated at zone:ready but not running"');

  // A player far from every pack keeps them all dormant across real steps.
  const player = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 10, team: 0, x: 5000, z: 5000 });
  assert.ok(player);
  const before = ai.stats.decisions;
  for (let i = 0; i < 30; i++) { ctx.time.step++; ai.fixedUpdate(1 / 60, ctx); }
  assert.equal(ai.stats.decisions, before, 'no dormant pack may make a decision');
  assert.equal([...store.tier.slice(0, store.count)].every((t) => t === PACK_TIER.C), true);

  // Teleport onto a pack centre: that pack — and only packs within 34 m —
  // activates, and its brains start deciding.
  actors.teleport(player, store.centerX[0], store.centerZ[0]);
  ctx.time.step++;
  ai.fixedUpdate(1 / 60, ctx);
  assert.notEqual(store.tier[0], PACK_TIER.C, 'the pack the player is standing on must activate');
  let activated = 0;
  for (let s = 0; s < store.count; s++) if (store.tier[s] !== PACK_TIER.C) activated++;
  for (let i = 0; i < 20; i++) { ctx.time.step++; ai.fixedUpdate(1 / 60, ctx); }
  assert.ok(ai.stats.decisions > before, 'an activated pack must actually tick');
  console.log(`  §10.3 (REAL fixedUpdate): ${store.count} packs, all tier C at zone:ready; ${activated} activated when the player stood on pack 0's centre; decisions ${before} -> ${ai.stats.decisions}`);
});

test('REAL PIPELINE: setDensityBudget forces the furthest pack back to tier C (§10.3)', async () => {
  const { world, ai, actors, ctx } = await bootFullEngine(7005);
  world.setWorldSeed(0x5eed0005);
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  const store = ai._spawnStore;
  const player = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 10, team: 0, x: store.centerX[0], z: store.centerZ[0] });
  assert.ok(player);
  ctx.time.step++;
  ai.fixedUpdate(1 / 60, ctx);
  let uncapped = 0;
  for (let s = 0; s < store.count; s++) if (store.tier[s] !== PACK_TIER.C) uncapped += store.memberCount[s];
  assert.ok(uncapped > 0);

  ai.setDensityBudget(1); // hard cap far below one pack
  ctx.time.step++;
  ai.fixedUpdate(1 / 60, ctx);
  let capped = 0;
  for (let s = 0; s < store.count; s++) if (store.tier[s] !== PACK_TIER.C) capped += store.memberCount[s];
  assert.ok(capped < uncapped, `budget must shed packs: ${uncapped} -> ${capped}`);
  console.log(`  §10.3 density budget (REAL fixedUpdate): active members ${uncapped} uncapped -> ${capped} at setDensityBudget(1)`);
});

test('REAL PIPELINE: §10.5 — entering a second zone despawns every monster of the first', async () => {
  const { world, ai, actors } = await bootFullEngine(7006);
  world.setWorldSeed(0x5eed0006);
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  const firstIds = new Set(actors.all.filter((a) => a.kind === 'monster').map((a) => a.id));
  const first = firstIds.size;
  assert.ok(first > 0);
  // This used to read "whatever survives is leakage", because Bonereach
  // spawned nothing and a bare count was therefore an honest test. Bonereach
  // spawns for real now (O-139), so leakage is identified by IDENTITY rather
  // than by the second zone happening to be empty — a stricter test, and one
  // that does not quietly stop testing anything if a zone changes.
  await world.enterZone('bonereach', 'descent', { runIndex: 0 });
  const survivors = actors.all.filter((a) => a.kind === 'monster' && firstIds.has(a.id));
  const after = actors.all.filter((a) => a.kind === 'monster').length;
  assert.equal(survivors.length, 0, `zone change must despawn all ${first} Wastes monsters, ${survivors.length} of them are still live`);
  assert.equal(ai.aliveCount, after, 'ai.aliveCount must account for exactly the second zone\'s monsters');
  console.log(`  §10.5 (REAL enterZone -> zone:teardown): ${first} Wastes monsters spawned, 0 survived the change, ${after} Bonereach monsters now live`);
});

test('REAL PIPELINE: the pack registry does not accumulate stale members across five consecutive zone loads', async () => {
  // Regression for a defect AI-7 found and CONTAINED but did not fix:
  // `perception.js#registerPack` resets `packMemberCount` only when it
  // allocates a NEW slot, and pack ids restart at 0 in every zone, so a
  // re-registered pack appends to the previous zone's dead ids. Measured
  // before containment, on this exact loop: 6/6/6/6/6/6/5/5/5 -> 14/14/14/
  // 13/13/13/12/12/12 -> 16 everywhere (MAX_PACK_MEMBERS, saturated), after
  // which `addPackMember` refuses every real member and §4.6 aggro
  // propagation stops seeing the live pack. `despawnAllPacks` now releases
  // the registry the pass filled; the real one-line fix belongs in
  // `registerPack` (AI-3's file, outside this ticket's grant) — reported.
  const { world, ai, actors } = await bootFullEngine(7008);
  world.setWorldSeed(0);
  for (let i = 0; i < 5; i++) {
    await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: i });
    const p = ai._perception;
    const store = ai._spawnStore;
    let registered = 0;
    for (let s = 0; s < 32; s++) if (p.packUsed[s]) registered += p.packMemberCount[s];
    const live = actors.all.filter((a) => a.kind === 'monster').length;
    assert.equal(registered, live,
      `load ${i + 1}: the registry holds ${registered} members for ${live} live monsters`);
    assert.equal(registered, ai.spawnStats.monstersSpawned, `load ${i + 1}: registry vs this load's spawn count`);
    assert.ok(store.count > 0);
  }
  console.log('  pack registry across 5 real enterZone loads: member count == live monster count every time (was 6->14->16 saturated before containment)');
});

test('§10.2: SPAWN_SAFETY carries 06 §10.2\'s own per-zone minima', () => {
  assert.deepEqual(SPAWN_SAFETY.ashen_wastes, { packCentreMin: 16.0, spawnPointMin: 11.0 });
  assert.deepEqual(SPAWN_SAFETY.bonereach, { packCentreMin: 14.0, spawnPointMin: 10.0 });
  assert.deepEqual(SPAWN_SAFETY.altar_of_instruction, { packCentreMin: 12.0, spawnPointMin: 9.0 });
  assert.equal(SPAWN_SAFETY.last_bastion, undefined, '06 §10.2 gives last_bastion no numeric row');
});

test('ai.packTemplate is reachable as a METHOD on the ai subsystem (O-71) and returns the same frozen record as the module function', async () => {
  const { ai } = await bootFullEngine(7007);
  assert.equal(ai.packTemplate('pk_warband'), packTemplate('pk_warband'));
  assert.equal(ai.packTemplate('bone_ranker'), null);
  assert.equal(typeof ai.spawnPack, 'function');
  assert.equal(typeof ai.despawnAll, 'function');
  assert.equal(typeof ai.setDensityBudget, 'function');
});
