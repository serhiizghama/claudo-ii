// tests/actors/actr24.test.js
//
// ACTR-24 acceptance tests for src/actors/stats.js — closing O-67's second
// half and O-94's third cause: a MonsterArchetype record's six base fields
// (`baseLife`/`baseMinDamage`/`baseMaxDamage`/`baseDefense`/
// `baseAttackRating` reaching StatBlock, plus `damageReduceFlat` via
// `flatDR`) now reach `composeStats` step 2, scaled by `mlvl` (`03
// -combat-math.md` §10.1) and rank (`03` §9.3), rounded once with
// `Math.round` per §10.1's rounding rule.
//
// `node:test` + `node:assert/strict` only, matching every sibling file in
// this directory. Uses `createActorRecord`/`resetActorRecord` (pool.js's
// own pure record builders — the same pattern `tests/actors/stats.test.js`
// already established for testing `composeStats` without a live `ActorsSystem`)
// rather than booting a real engine: `composeStats` needs only `actor`, and
// this ticket's own file grant is `src/actors/stats.js` + this file, not
// `src/ai/index.js` — `ai.spawnOne`'s own acceptance (that it calls
// `actors.spawn()`, which calls this file's `stats()`) is `tests/ai/*.test.js`'s
// business, unaffected by this file either way (see this ticket's report).
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createActorRecord, resetActorRecord } from '../../src/actors/pool.js';
import {
  composeStats,
  setSourceLayer,
  markDirty,
  COMPOSITION_STEP_COUNT,
} from '../../src/actors/stats.js';
import { BESTIARY, lifeMult, damageMult, defenseMult, arMult, flatDR } from '../../src/ai/data/bestiary.js';

/** A monster-shaped actor record — `classId: null` (`pool.js#acquire`'s own
 * rule: "classId is null for kind !== 'player'"), `archetypeId`/`level`/
 * `rank` set the way `ai.spawnOne` sets them on the real `actors.spawn()`
 * spec (`src/ai/index.js`: `archetypeId, rank: rank || 'normal', level: mlvl`). */
function makeMonster(poolIndex, archetypeId, level, rank = 'normal') {
  const actor = createActorRecord(poolIndex);
  actor.kind = 'monster';
  actor.classId = null;
  actor.archetypeId = archetypeId;
  actor.level = level;
  actor.rank = rank;
  return actor;
}

// ---------------------------------------------------------------------------
// Criterion 1 — a bone_ranker composes REAL stats, never maxLife === 1
// ---------------------------------------------------------------------------

test('ACTR-24 criterion 1: bone_ranker at mlvl 10 composes real maxLife/minDamage/maxDamage/defense/attackRating — never maxLife === 1', () => {
  const actor = makeMonster(0, 'bone_ranker', 10);
  const steps = composeStats(actor);
  assert.equal(steps, COMPOSITION_STEP_COUNT, 'all ten composition steps must run');

  const s = actor.stats;
  assert.notEqual(s.maxLife, 1, 'the defect: maxLife must not be the [1,40000] clamp floor');
  assert.equal(s.maxLife, 88, '06 §2.1 mlvl10 row: Life 88');
  assert.equal(s.minDamage, 11, '06 §2.1 mlvl10 row: Damage 11-22 (min)');
  assert.equal(s.maxDamage, 22, '06 §2.1 mlvl10 row: Damage 11-22 (max)');
  assert.equal(s.defense, 67, '06 §2.1 mlvl10 row: DEF 67');
  assert.equal(s.attackRating, 199, '06 §2.1 mlvl10 row: AR 199');
  assert.equal(s.damageReduceFlat, 1, '06 §2.1 mlvl10 row: flat DR 1');
});

// ---------------------------------------------------------------------------
// Criterion 2 — 06 §2.1's printed bone_ranker table, every row, to the
// integer. The ticket asks for at least three; this is a sweep of all seven
// (rule 12: "if your criterion is a sweep, report the counts").
// ---------------------------------------------------------------------------

const TABLE_06_2_1 = [
  { mlvl: 1, life: 20, minDmg: 3, maxDmg: 6, def: 18, ar: 45, flatDR: 0 },
  { mlvl: 5, life: 45, minDmg: 6, maxDmg: 12, def: 40, ar: 113, flatDR: 0 },
  { mlvl: 10, life: 88, minDmg: 11, maxDmg: 22, def: 67, ar: 199, flatDR: 1 },
  { mlvl: 15, life: 144, minDmg: 17, maxDmg: 33, def: 94, ar: 284, flatDR: 1 },
  { mlvl: 20, life: 213, minDmg: 24, maxDmg: 47, def: 121, ar: 370, flatDR: 2 },
  { mlvl: 25, life: 295, minDmg: 32, maxDmg: 64, def: 148, ar: 455, flatDR: 3 },
  { mlvl: 30, life: 389, minDmg: 41, maxDmg: 82, def: 175, ar: 541, flatDR: 3 },
];

test('ACTR-24 criterion 2: 06 §2.1 — all seven printed bone_ranker rows reproduce to the integer', () => {
  let reproduced = 0;
  for (const row of TABLE_06_2_1) {
    const actor = makeMonster(0, 'bone_ranker', row.mlvl);
    composeStats(actor);
    const s = actor.stats;
    assert.equal(s.maxLife, row.life, `mlvl${row.mlvl}: Life`);
    assert.equal(s.minDamage, row.minDmg, `mlvl${row.mlvl}: Damage min`);
    assert.equal(s.maxDamage, row.maxDmg, `mlvl${row.mlvl}: Damage max`);
    assert.equal(s.defense, row.def, `mlvl${row.mlvl}: DEF`);
    assert.equal(s.attackRating, row.ar, `mlvl${row.mlvl}: AR`);
    assert.equal(s.damageReduceFlat, row.flatDR, `mlvl${row.mlvl}: flat DR`);
    reproduced++;
  }
  assert.equal(reproduced, 7, 'all seven 06 §2.1 rows checked');
});

// ---------------------------------------------------------------------------
// Criterion 3 — rank × mlvl multiply into the same product, rounded ONCE.
// The spec's own worked check (03 §10.1 / §11.3): a level-10 champion
// bone_ranker has 351 life, not 352, because 20 × 4.393 × 4.0 = 351.44.
// ---------------------------------------------------------------------------

test('ACTR-24 criterion 3: level-10 champion bone_ranker — 351 life (not 352), 100 DEF — 03 §10.1/§11.3\'s worked check', () => {
  const actor = makeMonster(0, 'bone_ranker', 10, 'champion');
  composeStats(actor);
  const s = actor.stats;
  // 03 §10.1: "20 × 4.393 × 4.0 = 351.44" -> round -> 351, never 352.
  assert.equal(s.maxLife, 351, 'champion life must round 351.44 down to 351, not up to 352');
  assert.notEqual(s.maxLife, 352, 'rounding an intermediate would silently produce 352 instead');
  // 03 §11.3: "DEF round(18 × 3.70 × 1.5) = 100".
  assert.equal(s.defense, 100, '03 §11.3\'s own champion DEF worked check');
});

test('ACTR-24 criterion 3: level-10 unique bone_ranker — 615 life, 03 §11.3\'s worked check', () => {
  const actor = makeMonster(0, 'bone_ranker', 10, 'unique');
  composeStats(actor);
  // 03 §11.3: "life round(20 × 4.393 × 7.0) = 615".
  assert.equal(actor.stats.maxLife, 615, '03 §11.3\'s own unique life worked check');
});

test('ACTR-24: minion/boss rank multipliers also land — 03 §9.3\'s own table, direct arithmetic cross-check', () => {
  const level = 10;
  const base = BESTIARY.bone_ranker;

  const minion = makeMonster(0, 'bone_ranker', level, 'minion');
  composeStats(minion);
  assert.equal(minion.stats.maxLife, Math.round(base.baseLife * lifeMult(level) * 1.6), 'minion life ×1.6');
  assert.equal(minion.stats.defense, Math.round(base.baseDefense * defenseMult(level) * 1.2), 'minion defense ×1.2');

  const boss = makeMonster(0, 'bone_ranker', level, 'boss');
  composeStats(boss);
  // 03 §9.3: "The boss's rank multipliers are all 1.0" — same as normal.
  assert.equal(boss.stats.maxLife, Math.round(base.baseLife * lifeMult(level)), 'boss life ×1.0 (bestiary row already scaled)');
});

// ---------------------------------------------------------------------------
// 03 §9.3 has NO AR column for rank — attackRating scales with mlvl alone,
// identical across every rank at the same mlvl.
// ---------------------------------------------------------------------------

test('ACTR-24: attackRating has no rank multiplier — 03 §9.3\'s table has no AR column, so champion AR === normal AR at the same mlvl', () => {
  const normal = makeMonster(0, 'bone_ranker', 10, 'normal');
  const champion = makeMonster(1, 'bone_ranker', 10, 'champion');
  const unique = makeMonster(2, 'bone_ranker', 10, 'unique');
  composeStats(normal);
  composeStats(champion);
  composeStats(unique);
  assert.equal(normal.stats.attackRating, 199, 'normal AR mlvl10');
  assert.equal(champion.stats.attackRating, 199, 'champion AR must equal normal AR — no rank factor');
  assert.equal(unique.stats.attackRating, 199, 'unique AR must equal normal AR — no rank factor');
});

test('ACTR-24: damageReduceFlat = floor(mlvl/8) is rank-independent — 03 §9.3: "all ranks"', () => {
  for (const rank of ['normal', 'minion', 'champion', 'unique', 'boss']) {
    const actor = makeMonster(0, 'bone_ranker', 20, rank);
    composeStats(actor);
    assert.equal(actor.stats.damageReduceFlat, flatDR(20), `rank=${rank}: flatDR(20) === floor(20/8)`);
  }
});

// ---------------------------------------------------------------------------
// Every archetype at mlvl 1 matches its own bestiary row exactly (mlvlMult(1)
// is the identity — a second, independent cross-check across all seven
// archetypes, not just bone_ranker).
// ---------------------------------------------------------------------------

test('ACTR-24: every one of the seven bestiary archetypes composes its own mlvl-1 base row exactly', () => {
  let checked = 0;
  for (const id of Object.keys(BESTIARY)) {
    const row = BESTIARY[id];
    const actor = makeMonster(0, id, 1);
    composeStats(actor);
    const s = actor.stats;
    assert.equal(s.maxLife, row.baseLife, `${id} mlvl1: maxLife === baseLife`);
    assert.equal(s.minDamage, row.baseMinDamage, `${id} mlvl1: minDamage === baseMinDamage`);
    assert.equal(s.maxDamage, row.baseMaxDamage, `${id} mlvl1: maxDamage === baseMaxDamage`);
    assert.equal(s.defense, row.baseDefense, `${id} mlvl1: defense === baseDefense`);
    assert.equal(s.attackRating, row.baseAttackRating, `${id} mlvl1: attackRating === baseAttackRating`);
    checked++;
  }
  assert.equal(checked, 7, 'all seven bestiary archetypes checked');
});

// ---------------------------------------------------------------------------
// Regression guards — this ticket's fix must not disturb the player path or
// the pre-existing "no matching archetype" fallback.
// ---------------------------------------------------------------------------

test('ACTR-24 regression: a player actor\'s sources.base does NOT gain the six monster-only keys', () => {
  const actor = createActorRecord(0);
  actor.kind = 'player';
  actor.classId = 'ravager';
  actor.level = 10;
  composeStats(actor);
  for (const key of ['maxLife', 'minDamage', 'maxDamage', 'defense', 'attackRating', 'damageReduceFlat']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(actor.sources.base, key),
      false,
      `a player's base layer must not carry '${key}' — only a real archetype match sets it`,
    );
  }
  // The player derive() path (5×(DEX−7) on AR, ⌊DEX/4⌋ on DEF) must still run
  // — ACTR-24's isMonster guard must not fire for a real class actor.
  assert.equal(actor.stats.attackRating, 30 + 5 * (20 - 7), 'ravager AR still uses the dex-based player formula');
});

test('ACTR-24 regression: an actor with classId===null but no matching bestiary archetype keeps the pre-existing fallback (maxLife clamps to 1)', () => {
  const actor = makeMonster(0, 'not_a_real_archetype_id', 10);
  composeStats(actor);
  // No archetype match -> base.maxLife is never set -> flat sum stays 0 ->
  // clamped to the [1,40000] floor, same as before this ticket's fix.
  assert.equal(actor.stats.maxLife, 1, 'unmatched archetypeId must keep the old floor-clamped behaviour');
});

test('ACTR-24 regression: pool-slot reuse — a despawned monster\'s sources never leak into the next occupant', () => {
  const actor = createActorRecord(5);
  actor.kind = 'monster';
  actor.classId = null;
  actor.archetypeId = 'bone_ranker';
  actor.level = 10;
  actor.rank = 'champion';
  composeStats(actor);
  assert.equal(actor.stats.maxLife, 351, 'sanity: the champion composed first');

  // `ActorPool#release` -> `resetActorRecord` nulls stats/sources on every
  // despawn (src/actors/pool.js) — reproduced directly here since this
  // ticket does not own pool.js/index.js.
  resetActorRecord(actor);
  assert.equal(actor.sources, null, 'resetActorRecord must null sources (pool.js\'s own contract)');
  assert.equal(actor.stats, null, 'resetActorRecord must null stats (pool.js\'s own contract)');

  // Next occupant of the same slot: a player.
  actor.kind = 'player';
  actor.classId = 'ravager';
  actor.level = 1;
  composeStats(actor);
  assert.notEqual(actor.stats.maxLife, 351, 'the previous occupant\'s champion life must not survive');
  assert.equal(
    Object.prototype.hasOwnProperty.call(actor.sources.base, 'maxLife'),
    false,
    'the fresh sources.base object must not carry the old occupant\'s maxLife key at all',
  );
});

test('ACTR-24: markDirty + recompose reflects a rank change on the same actor object (no stale flat term)', () => {
  const actor = makeMonster(0, 'bone_ranker', 10, 'normal');
  composeStats(actor);
  assert.equal(actor.stats.maxLife, 88, 'normal rank first');

  actor.rank = 'champion';
  markDirty(actor);
  composeStats(actor);
  assert.equal(actor.stats.maxLife, 351, 'recompose after a rank change must NOT retain the normal-rank flat value');
});

test('ACTR-24: setSourceLayer(difficulty) composes on top of the archetype base without disturbing it', () => {
  const actor = makeMonster(0, 'bone_ranker', 10, 'normal');
  // Trial tier (03 §10.2): life ×1.15, expressed as a +15 lifePercent flat
  // add per the `difficulty` layer's own documented role (01 §4.1:
  // "resistance penalties, monster tier multipliers") — this ticket does not
  // wire this from `ai`, but the layer itself must still compose correctly
  // on top of step 2's rounded archetype base (see this ticket's report for
  // why difficultyMult is not part of step 2's own rounded product).
  setSourceLayer(actor, 'difficulty', { lifePercent: 15 });
  composeStats(actor);
  assert.equal(actor.stats.maxLife, 88 * 1.15, 'difficulty lifePercent applies on top of the rounded archetype base');
});
