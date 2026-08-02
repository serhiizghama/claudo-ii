// tests/combat/absorb.test.js
//
// SKIL-10/O-90 acceptance tests for the R13 absorb hook added to
// `src/combat/resolve.js` (`consumeAbsorbPools`, and its single call site
// inside `resolveDamage`). Two layers:
//
//   1. `consumeAbsorbPools` in isolation — the oldest-first ordering, the
//      "not a death save" semantics, expiry, and the stale-generation
//      (recycled actor) guard, all directly against the documented
//      `target.absorbPools` shape (`src/skills/buff.js`'s own header),
//      built here as plain fixture data — this file does NOT import
//      anything from `src/skills/` (ARCHITECTURE.md rule 2; `combat` never
//      imports `skills`), matching exactly how `resolve.js` itself reaches
//      this data.
//   2. `resolveDamage()` end to end — proves the hook actually runs at the
//      right point in the R1-R14 pipeline (after R13's floor, before
//      R14(a)'s `life -= total`), is unaffected by `physicalResist`, and
//      that a hit larger than `life + absorb` still kills.
//
// Fixture helpers (`makeActor`/`makeStats`/`makeEnv`/`makeMockRng`/
// `makePacket`/`blankResult`) are deliberately re-declared here rather than
// imported from `tests/combat/resolve.test.js` (that file exports nothing;
// re-declaring a small, well-understood fixture is the established
// precedent every sibling test file in this directory already follows).
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDamage, consumeAbsorbPools } from '../../src/combat/resolve.js';
import { PacketPool } from '../../src/combat/packet.js';

// ---------------------------------------------------------------------------
// Fixtures — same shapes as tests/combat/resolve.test.js
// ---------------------------------------------------------------------------

function makeStats(overrides = {}) {
  return {
    defense: 0, dexterity: 0, blockChance: 0, dodgeChance: 0,
    damageReduceFlat: 0, damageReducePercent: 0, physicalResist: 0,
    fireResist: 0, maxFireResist: 75,
    coldResist: 0, maxColdResist: 75,
    lightResist: 0, maxLightResist: 75,
    poisonResist: 0, maxPoisonResist: 75,
    magicResist: 0, maxMagicResist: 75,
    magicDamageReduceFlat: 0,
    maxLife: 100000, maxMana: 100000,
    thorns: 0, ccReduction: 0,
    ...overrides,
  };
}

let nextId = 1;
function makeActor(overrides = {}) {
  return {
    id: nextId++, generation: 0, poolIndex: nextId, team: 1, level: 10, flags: 0,
    x: 0, y: 0, z: 0, facing: 0,
    life: 10000, mana: 0, dead: false, invulnUntil: 0,
    equipment: null, statuses: [],
    stats: makeStats(overrides.stats),
    ...overrides,
  };
}

function makeEnv(overrides = {}) {
  const env = {
    source: null, rng: null, step: 0, actorsSystem: null, events: null,
    packetPool: null, resultPool: null,
    statusSpec: { status: null, step: 0, sourceId: 0, sourceGen: 0, sourceSkill: null, element: null, magnitude: 0, duration: 0, stacks: 1 },
    damagePayload: { target: null, source: null, result: null },
    thornsEnv: null,
    isThornsCounter: false,
    ...overrides,
  };
  if (!env.thornsEnv) {
    env.thornsEnv = { ...env, thornsEnv: null, isThornsCounter: true };
  }
  return env;
}

function makeMockRng(nextValue = 0.9) {
  // 0.9 -> draw100 = 90: misses nothing gateable at low %, no crit, no dodge
  // — a clean "always hits, never crits/dodges" stand-in for these tests,
  // which are about R13's absorb hook, not the earlier to-hit/crit rolls.
  return {
    next() { return nextValue; },
    range(min, max) { return (min + max) / 2; },
  };
}

let packetPool = new PacketPool(64);
function makePacket(overrides = {}) {
  const p = packetPool.acquire();
  Object.assign(p, {
    team: 0, attackRating: 0, attackerLevel: 10, blockable: false, dodgeable: false,
    critChance: 0, critMult: 200,
  }, overrides);
  return p;
}

function blankResult() {
  return {
    targetId: 0, targetGen: 0, sourceId: 0, sourceGen: 0, sourceSkillId: null,
    outcome: 'invalid', crit: false, blocked: false, killed: false, overkill: 0,
    physical: 0, fire: 0, cold: 0, lightning: 0, poison: 0, magic: 0, total: 0,
    lifeStolen: 0, manaStolen: 0, manaReturned: 0, thornsDealt: 0,
    statusApplied: 0, hitRecovery: false, knockedBack: false,
    pointX: 0, pointY: 0, pointZ: 0, poolIndex: -1,
  };
}

/** Builds the exact `target.absorbPools` shape `src/skills/buff.js` writes
 * (see that file's header) directly, as plain fixture data — this file
 * never imports `src/skills/buff.js` itself.
 * @param {object} actor @param {Array<{buffIdx:number, level:number, amount:number, expiresStep:number}>} pools oldest first */
function withAbsorbPools(actor, pools) {
  const amount = new Float64Array(4);
  const buffIdx = new Int32Array(4);
  const level = new Int32Array(4);
  const expiresStep = new Float64Array(4);
  pools.forEach((p, i) => {
    amount[i] = p.amount; buffIdx[i] = p.buffIdx; level[i] = p.level; expiresStep[i] = p.expiresStep;
  });
  actor.absorbPools = { generation: actor.generation, count: pools.length, amount, buffIdx, level, expiresStep };
  return actor;
}

// ---------------------------------------------------------------------------
// consumeAbsorbPools — isolated
// ---------------------------------------------------------------------------

test('consumeAbsorbPools: no absorbPools field at all -> total unchanged, no throw', () => {
  const target = makeActor();
  const out = consumeAbsorbPools(target, 50, 10);
  assert.equal(out, 50);
});

test('consumeAbsorbPools: total <= 0 -> unchanged (nothing to consume, e.g. a miss/dodge/block path)', () => {
  const target = withAbsorbPools(makeActor(), [{ buffIdx: 1, level: 10, amount: 100, expiresStep: 1000 }]);
  assert.equal(consumeAbsorbPools(target, 0, 10), 0);
  assert.equal(target.absorbPools.amount[0], 100, 'an unconsumed pool must be left exactly as it was');
});

test('consumeAbsorbPools: stale generation (a previous occupant of this actor-record slot) reads as no absorb at all', () => {
  const target = makeActor({ generation: 5 });
  withAbsorbPools(target, [{ buffIdx: 1, level: 10, amount: 999, expiresStep: 1000 }]);
  target.absorbPools.generation = 4; // stale — actor recycled since this pool was written
  const out = consumeAbsorbPools(target, 50, 10);
  assert.equal(out, 50, 'a stale-generation pool must never be consumed from');
});

test('consumeAbsorbPools: oldest-first — a hit spanning two pools drains the OLDER one first, prints exact amounts', () => {
  // Pool 0 (oldest, e.g. last_stand, 10 remaining) then pool 1 (newer, e.g.
  // smouldering_ward, 50 remaining). A 30-point hit must drain pool 0
  // completely (10) before touching pool 1 (which then loses the remaining 20).
  const target = withAbsorbPools(makeActor(), [
    { buffIdx: 1, level: 10, amount: 10, expiresStep: 1000 }, // oldest
    { buffIdx: 2, level: 5, amount: 50, expiresStep: 1000 }, // newer
  ]);

  const remaining = consumeAbsorbPools(target, 30, 10);

  // eslint-disable-next-line no-console
  console.log(
    `[absorb oldest-first] hit=30, pool0(oldest)=10->${target.absorbPools.count >= 1 ? 'exhausted, removed' : 'n/a'}, ` +
      `pool1(newer)=50->${target.absorbPools.amount[0]} — drained oldest first by 10, then newer by 20`,
  );

  assert.equal(remaining, 0, 'the whole 30 was absorbed');
  assert.equal(target.absorbPools.count, 1, 'the exhausted oldest pool was compacted away');
  assert.equal(target.absorbPools.buffIdx[0], 2, 'the SURVIVING pool at slot 0 is the one that used to be newer (idx 2)');
  assert.equal(target.absorbPools.amount[0], 30, '50 - 20 = 30 remaining in the newer pool');
});

test('consumeAbsorbPools: total exceeds combined absorb -> every pool exhausted, the UNABSORBED remainder is returned (not a death save)', () => {
  const target = withAbsorbPools(makeActor(), [
    { buffIdx: 1, level: 10, amount: 10, expiresStep: 1000 },
    { buffIdx: 2, level: 5, amount: 50, expiresStep: 1000 },
  ]);

  const remaining = consumeAbsorbPools(target, 1000, 10);

  assert.equal(remaining, 1000 - 60, '1000 - (10+50) = 940 must still reach life');
  assert.equal(target.absorbPools.count, 0, 'both pools are gone');
});

test('consumeAbsorbPools: an expired pool (expiresStep <= step) is skipped and removed WITHOUT being consumed, later live pools still absorb', () => {
  const target = withAbsorbPools(makeActor(), [
    { buffIdx: 1, level: 10, amount: 999, expiresStep: 5 }, // expired at step 10
    { buffIdx: 2, level: 5, amount: 40, expiresStep: 1000 }, // still live
  ]);

  const remaining = consumeAbsorbPools(target, 30, 10);

  assert.equal(remaining, 0, 'the live pool absorbed the whole hit');
  assert.equal(target.absorbPools.count, 1, 'the expired pool was compacted away, not consumed from');
  assert.equal(target.absorbPools.buffIdx[0], 2);
  assert.equal(target.absorbPools.amount[0], 10, '40 - 30 = 10 remaining');
});

// ---------------------------------------------------------------------------
// resolveDamage() end to end
// ---------------------------------------------------------------------------

test('resolveDamage: absorb is consumed at R13, before R14(a) life -= total, and reduces life by exactly the unabsorbed remainder', () => {
  const target = withAbsorbPools(makeActor({ life: 500 }), [
    { buffIdx: 1, level: 10, amount: 25, expiresStep: 1000 },
  ]);
  const packet = makePacket({ physMin: 40, physMax: 40 });
  const rng = makeMockRng(0.9);
  const env = makeEnv({ rng, step: 10 });

  const result = resolveDamage(packet, target, env, blankResult());

  assert.equal(result.outcome, 'hit');
  assert.equal(result.total, 40 - 25, 'result.total itself is reduced by absorb, not just target.life');
  assert.equal(target.life, 500 - (40 - 25), 'life -= (total - absorbed)');
  assert.equal(target.absorbPools.count, 0, 'the pool was fully exhausted');
  packetPool.release(packet);
});

test('resolveDamage: absorb is NOT affected by physicalResist — it eats the ALREADY-mitigated total, not the raw roll', () => {
  const target = withAbsorbPools(
    makeActor({ life: 500, stats: makeStats({ physicalResist: 50 }) }),
    [{ buffIdx: 1, level: 10, amount: 1000, expiresStep: 1000 }],
  );
  const packet = makePacket({ physMin: 40, physMax: 40 });
  const rng = makeMockRng(0.9);
  const env = makeEnv({ rng, step: 10 });

  const result = resolveDamage(packet, target, env, blankResult());

  // R7c halves 40 -> 20 BEFORE R13; the absorb pool then eats exactly that
  // post-resist 20, not the raw 40 — proving physicalResist was applied
  // upstream of the absorb hook, and the hook itself applies no resist logic
  // of its own ("not a resistance", 05 §3.5/§5.3).
  assert.equal(result.physical, 20, 'sanity: physicalResist already halved the roll before R13');
  assert.equal(result.total, 0, 'the post-resist 20 was fully absorbed');
  assert.equal(target.life, 500, 'life untouched');
  assert.equal(target.absorbPools.amount[0], 1000 - 20, 'the pool lost exactly the post-resist amount, not the raw 40');
  packetPool.release(packet);
});

test('resolveDamage: a hit larger than life + absorb still kills — absorb is not a death save', () => {
  const target = withAbsorbPools(makeActor({ life: 50 }), [
    { buffIdx: 1, level: 10, amount: 30, expiresStep: 1000 },
  ]);
  const packet = makePacket({ physMin: 200, physMax: 200 });
  const rng = makeMockRng(0.9);
  const env = makeEnv({ rng, step: 10 });

  const result = resolveDamage(packet, target, env, blankResult());

  // eslint-disable-next-line no-console
  console.log(
    `[absorb death case] life=50, absorb=30, damage=200 -> post-absorb total=${result.total}, ` +
      `target.life=${target.life}, killed=${result.killed}`,
  );

  assert.equal(result.total, 200 - 30, 'the pool absorbed everything it had; the rest reaches life');
  assert.equal(target.life, 0, 'life is clamped at 0, never negative');
  assert.equal(result.killed, true, 'the actor still dies — absorb only delayed 30 points of the 200, not all of it');
  packetPool.release(packet);
});

test('resolveDamage: a block (outcome "block") deals 0 damage and never touches the absorb pool', () => {
  const target = withAbsorbPools(makeActor({ life: 500, equipment: { offHand: { blockBase: 0 } } }), [
    { buffIdx: 1, level: 10, amount: 30, expiresStep: 1000 },
  ]);
  const packet = makePacket({ physMin: 40, physMax: 40, blockable: true });
  // draw100 = 0 -> guaranteed block (blockChanceOf reads stats.blockChance, 0 here,
  // but the FIRST R2/R3/R4 draws all use env.rng.next() too; force a low
  // draw so R4's block check succeeds regardless of blockChanceOf's own value
  // by setting stats.blockChance high instead of relying on next()=0).
  target.stats.blockChance = 100;
  const rng = makeMockRng(0);
  const env = makeEnv({ rng, step: 10 });

  const result = resolveDamage(packet, target, env, blankResult());

  assert.equal(result.outcome, 'block');
  assert.equal(result.total, 0);
  assert.equal(target.life, 500, 'life untouched on a block');
  assert.equal(target.absorbPools.amount[0], 30, 'the absorb pool is untouched — nothing to absorb on a 0-damage block');
  packetPool.release(packet);
});
