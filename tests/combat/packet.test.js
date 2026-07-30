// tests/combat/packet.test.js
//
// CMBT-1 acceptance tests for src/combat/packet.js + src/combat/data/
// weapons.js. `node:test` + `node:assert/strict` only, matching every
// sibling test file in this repo (e.g. tests/actors/stats.test.js).
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief, verbatim): E3 (the full
// B1-B8 build pipeline), E5's poison-as-a-total arithmetic, and all eleven
// rows of E6 (attack/cast interval) reproduce exactly, to 1e-4, including
// every intermediate value 03-combat-math.md prints.
//
// Scope note: the rows of E3 from "R6" down (crit application, flat DR,
// physical resist, the actual damage roll) and E5's Duration/Magnitude/Tick
// count/Damage-per-tick rows are RESOLVE-side (CMBT-3) / DoT-ticking
// (CMBT-4) arithmetic — this ticket does not implement `resolve()` or any
// ticking. Those downstream numbers are still reproduced below, as plain
// local arithmetic driven ONLY by this ticket's own packet output (never by
// a resolve()/tick() call that does not exist), to prove the packet this
// ticket builds is exactly the correct input for the tickets that come next
// — precisely what the brief means by "you produce the packet that feeds
// them."
//
// Not tested here (owned by other tickets, not touched by this one):
// chanceToHit/blockChanceOf (CMBT-2), resolve()/mitigation ordering
// (CMBT-3), chill accumulation/DoT ticking (CMBT-4), hit recovery/knockback
// distance (CMBT-5), rage economy (CMBT-7), XP (CMBT-6).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createActorRecord } from '../../src/actors/pool.js';
import { composeStats, setSourceLayer } from '../../src/actors/stats.js';
import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';

import {
  CombatSystem,
  PacketPool,
  PACKET_POOL_CAPACITY,
  BASE_CRIT_CHANCE,
  BASE_CRIT_MULT,
  BASE_POISON_DURATION,
  BASE_COLD_DURATION,
  BASIC_ATTACK_WEAPON_DAMAGE,
  stepB1,
  stepB2,
  stepB3,
  stepB4,
  stepB5,
  stepB6,
  stepB7,
  attributeBonusFor,
  resolveWeapon,
  classScaleFor,
  computeAttackInterval,
  computeCastInterval,
} from '../../src/combat/packet.js';
import { WEAPONS, CLASS_SCALE_TABLE, NEUTRAL_CLASS_SCALE } from '../../src/combat/data/weapons.js';

const EPS = 1e-4;

function closeTo(actual, expected, label, eps = EPS) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `${label}: expected ${expected}, got ${actual} (delta ${Math.abs(actual - expected)})`,
  );
}

// ---------------------------------------------------------------------------
// Fixture helpers — every actor built here supplies all four `attributes`
// keys (the documented NaN trap: composeStats produces NaN in eleven fields
// if any of strength/dexterity/vitality/energy is missing) via
// createActorRecord's own defaults, which are never overwritten wholesale.
// ---------------------------------------------------------------------------

let nextPoolIndex = 0;
let nextActorId = 1;

/** A minimal, fully-composed player actor. `overrides.attributes` sets
 * individual keys on top of createActorRecord's {0,0,0,0} default (never
 * replaces the object) — see the NaN-trap note above.
 * @param {object} [opts]
 */
function makeActor(opts = {}) {
  const actor = createActorRecord(nextPoolIndex++);
  actor.id = nextActorId++;
  actor.active = true;
  actor.kind = 'player';
  actor.classId = opts.classId ?? 'ravager';
  actor.level = opts.level ?? 20;
  actor.team = opts.team ?? 0;
  if (opts.attributes) Object.assign(actor.attributes, opts.attributes);
  if (opts.equipment !== undefined) actor.equipment = opts.equipment;
  if (opts.equipmentStats) setSourceLayer(actor, 'equipment', opts.equipmentStats);
  composeStats(actor);
  return actor;
}

function makeStubCtx() {
  const systems = new Map();
  return {
    config: {},
    events: new EventBus(),
    time: { elapsed: 0, raw: 0, dt: 1 / 60, fixed: 1 / 60, alpha: 0, scale: 1, frame: 0, step: 0 },
    rng: new Rng(0x5eed1234),
    get(id) {
      if (!systems.has(id)) throw new Error(`stub ctx.get: '${id}' not registered`);
      return systems.get(id);
    },
    peek(id) {
      return systems.get(id);
    },
    has(id) {
      return systems.has(id);
    },
  };
}

async function makeCombat() {
  const combat = new CombatSystem();
  await combat.init(makeStubCtx());
  return combat;
}

// ===========================================================================
// E3 — Ravager basic attack, full build pipeline (03-combat-math.md §12/E3)
// ===========================================================================

test('E3 — B1/B3/B5/B6 intermediates reproduce exactly, step by step', () => {
  const actor = makeActor({
    classId: 'ravager', // meleeScale 1.00 — matches E3's own "meleeScale 1.00" input
    attributes: { strength: 18 }, // 30 (ravager startStr) + 18 allocated = 48, matching E3's "STR 48"
    equipmentStats: { enhancedDamage: 40 },
  });
  closeTo(actor.stats.strength, 48, 'fixture sanity: STR');
  closeTo(actor.stats.enhancedDamage, 40, 'fixture sanity: enhancedDamage');
  assert.equal(classScaleFor(actor.classId).meleeScale, 1.0, 'fixture sanity: Ravager meleeScale');

  const weapon = WEAPONS.axe_battle_normal; // Battle Axe 10-22, attackTime 0.75
  assert.equal(weapon.minDamage, 10);
  assert.equal(weapon.maxDamage, 22);

  const packet = { physMin: 0, physMax: 0 };

  // B1 — weapon base range
  stepB1(packet, weapon);
  assert.equal(packet.physMin, 10);
  assert.equal(packet.physMax, 22);
  closeTo((packet.physMin + packet.physMax) / 2, 16.0, 'B1 weapon average');

  // B2 — skill coefficient (100 for a basic attack — a no-op here)
  stepB2(packet, BASIC_ATTACK_WEAPON_DAMAGE);
  assert.equal(packet.physMin, 10);
  assert.equal(packet.physMax, 22);

  // B3 — enhanced damage
  stepB3(packet, actor.stats.enhancedDamage);
  closeTo(packet.physMin, 14.0, 'B3 physMin');
  closeTo(packet.physMax, 30.8, 'B3 physMax');
  closeTo((packet.physMin + packet.physMax) / 2, 22.4, 'B3 after enhanced damage');

  // B4 — flat added damage (no ring in this example — a no-op)
  stepB4(packet, actor.stats.minDamage, actor.stats.maxDamage);
  closeTo(packet.physMin, 14.0, 'B4 physMin (no-op)');
  closeTo(packet.physMax, 30.8, 'B4 physMax (no-op)');

  // B5 — attribute bonus: 1 + STR/100 for oneHandMelee
  const attrBonus = attributeBonusFor(weapon.handling, actor.stats.strength, actor.stats.dexterity);
  closeTo(attrBonus, 1.48, 'attribute bonus (1 + 48/100)');
  stepB5(packet, attrBonus);
  closeTo(packet.physMin, 20.72, 'B5 physMin');
  closeTo(packet.physMax, 45.584, 'B5 physMax');
  closeTo((packet.physMin + packet.physMax) / 2, 33.152, 'B5 after attribute bonus');

  // B6 — class melee scale (1.00) x physicalDamagePercent (0) — unchanged
  stepB6(packet, classScaleFor(actor.classId).meleeScale, actor.stats.physicalDamagePercent);
  closeTo(packet.physMin, 20.72, 'B6 physMin');
  closeTo(packet.physMax, 45.584, 'B6 physMax');
  closeTo((packet.physMin + packet.physMax) / 2, 33.152, 'B6 after class melee scale');
});

test('E3 — buildAttackPacket end to end matches the same numbers, plus B8 riders', async () => {
  const actor = makeActor({
    classId: 'ravager',
    attributes: { strength: 18 },
    equipmentStats: { enhancedDamage: 40 },
    equipment: { mainHand: WEAPONS.axe_battle_normal },
  });

  const combat = await makeCombat();
  const packet = combat.buildAttackPacket(actor, null, 0);
  assert.ok(packet, 'buildAttackPacket must return a packet (pool is not exhausted)');

  closeTo(packet.physMin, 20.72, 'packet.physMin after B1-B6');
  closeTo(packet.physMax, 45.584, 'packet.physMax after B1-B6');
  assert.equal(packet.critChance, BASE_CRIT_CHANCE, 'packet.critChance == base 5 (no gear crit bonus)');
  assert.equal(packet.critMult, BASE_CRIT_MULT, 'packet.critMult == base 200 (no gear crit bonus)');
  assert.equal(packet.sourceId, actor.id);
  assert.equal(packet.sourceSkillId, 'attack');
  assert.equal(packet.attackerLevel, actor.level);
  assert.equal(packet.blockable, true);
  assert.equal(packet.dodgeable, true);

  // --- Downstream (resolve-side, CMBT-3) arithmetic, reproduced from THIS
  // packet's own fields only — see this file's header for why this is not a
  // call into a resolve() that does not exist.
  const target = { flatDR: 1, physicalResist: 0 };

  // "Expected value" stream (uses the B6 AVERAGE, i.e. (physMin+physMax)/2):
  const avgB6 = (packet.physMin + packet.physMax) / 2;
  closeTo(avgB6, 33.152, 'avg after B6');
  const expectedCritMultiplier = (1 - packet.critChance / 100) + (packet.critChance / 100) * (packet.critMult / 100);
  closeTo(expectedCritMultiplier, 1.05, 'R6 expected crit multiplier (0.95 + 0.05 x 2.0)');
  const afterR6 = avgB6 * expectedCritMultiplier;
  closeTo(afterR6, 34.8096, 'R6 (expected value)');
  const afterR7a = afterR6 - target.flatDR;
  closeTo(afterR7a, 33.8096, 'R7a after flat DR');
  const afterR7c = afterR7a * (1 - target.physicalResist / 100);
  closeTo(afterR7c, 33.8096, 'R7c after physical resist');

  // Roll-range stream — D-10's trap: crit (R6) multiplies BEFORE the "-1"
  // discrete-roll adjustment, never after.
  const nonCritMinRoll = packet.physMin - 1;
  closeTo(nonCritMinRoll, 19.72, 'non-crit minimum roll');
  const nonCritMaxRoll = packet.physMax - 1;
  closeTo(nonCritMaxRoll, 44.584, 'non-crit maximum roll');
  const critMaxRoll = packet.physMax * (packet.critMult / 100) - 1;
  closeTo(critMaxRoll, 90.168, 'critical maximum roll (D-10: 90.1680, not 89.1680)');

  combat.releasePacket(packet);
});

// ===========================================================================
// E5 — poison as a total (03-combat-math.md §12/E5)
// ===========================================================================

test('E5 — B7 assembles poisonMin/poisonMax/poisonDuration, and the applied-total chain reproduces exactly', async () => {
  const actor = makeActor({
    classId: 'emberwright', // spellScale 1.00 — the neutral multiplier this example needs
    equipmentStats: { poisonMin: 30, poisonMax: 54, poisonDuration: 2.0 },
  });
  closeTo(actor.stats.poisonMin, 30, 'fixture sanity: poisonMin stat');
  closeTo(actor.stats.poisonMax, 54, 'fixture sanity: poisonMax stat');
  closeTo(actor.stats.poisonDuration, 2.0, 'fixture sanity: poisonDuration stat');
  assert.equal(classScaleFor(actor.classId).spellScale, 1.0, 'fixture sanity: Emberwright spellScale');

  // Isolated B7 call — the step this ticket owns.
  const packet = {};
  stepB7(packet, actor.stats);
  closeTo(packet.poisonMin, 30.0, 'B7 poisonMin');
  closeTo(packet.poisonMax, 54.0, 'B7 poisonMax');
  closeTo(packet.poisonDuration, BASE_POISON_DURATION + 2.0, 'B7 poisonDuration (4.0 base + 2.0 stat)');
  closeTo(packet.poisonDuration, 6.0, 'Duration: 4.0 + 2.0 = 6.0 s');

  // End-to-end through buildSpellPacket, same numbers.
  const combat = await makeCombat();
  const built = combat.buildSpellPacket(actor, 'test_poison_bolt', 1);
  closeTo(built.poisonMin, 30.0, 'buildSpellPacket poisonMin');
  closeTo(built.poisonMax, 54.0, 'buildSpellPacket poisonMax');
  closeTo(built.poisonDuration, 6.0, 'buildSpellPacket poisonDuration');
  assert.equal(built.physMin, 0, 'buildSpellPacket: physMin stays 0 (no weapon contribution)');
  assert.equal(built.physMax, 0, 'buildSpellPacket: physMax stays 0 (no weapon contribution)');

  // --- Downstream (resolve/tick-side, CMBT-3/CMBT-4) arithmetic, reproduced
  // from THIS packet's own fields plus the example's given roll/resist —
  // see this file's header.
  const roll = (built.poisonMin + built.poisonMax) / 2; // "roll lands on the average"
  closeTo(roll, 42.0, 'roll lands on the average 42');
  const poisonResist = 50;
  const appliedTotal = roll * (1 - poisonResist / 100);
  closeTo(appliedTotal, 21.0, 'Applied total: 42 x (1 - 0.50) = 21.0000');
  const magnitude = appliedTotal / built.poisonDuration;
  closeTo(magnitude, 3.5, 'Magnitude (damage/s): 21.0 / 6.0 = 3.5000');
  const tickCount = built.poisonDuration * 4; // 4 Hz
  closeTo(tickCount, 24, 'Tick count at 4Hz: 24');
  const damagePerTick = appliedTotal / tickCount;
  closeTo(damagePerTick, 0.875, 'Damage per tick: 0.8750');

  combat.releasePacket(built);
});

test('E5 — coldDuration follows the same base+stat assembly (2.0 base, no worked example, sanity only)', () => {
  const actor = makeActor({ equipmentStats: { coldDuration: 1.5 } });
  const packet = {};
  stepB7(packet, actor.stats);
  closeTo(packet.coldDuration, BASE_COLD_DURATION + 1.5, 'coldDuration = 2.0 base + 1.5 stat');
});

// ===========================================================================
// E6 — attack and cast intervals (03-combat-math.md §12/E6), all 11 rows
// ===========================================================================

const ATTACK_ROWS = [
  { id: 'E6.1', base: 0.75, classScale: 0.90, skillScale: 1.00, ias: 0, expected: 0.6750 },
  { id: 'E6.2', base: 0.75, classScale: 0.90, skillScale: 1.00, ias: 20, expected: 0.5625 },
  { id: 'E6.3', base: 0.75, classScale: 0.90, skillScale: 1.00, ias: 100, expected: 0.3375 },
  { id: 'E6.4', base: 0.65, classScale: 1.00, skillScale: 1.00, ias: 15, expected: 0.5652 },
  { id: 'E6.5', base: 2.20, classScale: 1.00, skillScale: 1.00, ias: 0, expected: 2.2000 },
  { id: 'E6.6', base: 0.75, classScale: 0.90, skillScale: 1.00, ias: 300, expected: 0.2500 },
  { id: 'E6.7', base: 0.75, classScale: 0.90, skillScale: 1.00, ias: -75, expected: 2.7000 },
];

const CAST_ROWS = [
  { id: 'E6.8', base: 0.55, classScale: 0.85, fcr: 0, expected: 0.4675 },
  { id: 'E6.9', base: 0.55, classScale: 0.85, fcr: 25, expected: 0.3740 },
  { id: 'E6.10', base: 0.25, classScale: 1.00, fcr: 15, expected: 0.2174 },
  { id: 'E6.11', base: 0.70, classScale: 0.85, fcr: 200, expected: 0.1983 },
];

test('E6 — all seven attackInterval rows reproduce exactly (pure formula)', () => {
  for (const row of ATTACK_ROWS) {
    const got = computeAttackInterval(row.base, row.classScale, row.skillScale, row.ias);
    closeTo(got, row.expected, row.id);
  }
});

test('E6 — all four castInterval rows reproduce exactly (pure formula)', () => {
  for (const row of CAST_ROWS) {
    const got = computeCastInterval(row.base, row.classScale, row.fcr);
    closeTo(got, row.expected, row.id);
  }
});

test('E6.6/E6.11 — sit exactly on the IAS/FCR clamps, as the spec notes', () => {
  // increasedAttackSpeed clamps to [-75, 300]; an even larger input clamps
  // to the same result as exactly 300.
  const atCap = computeAttackInterval(0.75, 0.90, 1.00, 300);
  const beyondCap = computeAttackInterval(0.75, 0.90, 1.00, 5000);
  closeTo(atCap, 0.25, 'E6.6 at the IAS cap');
  closeTo(beyondCap, 0.25, 'IAS beyond the cap clamps the same as exactly the cap');

  // fasterCastRate clamps to [-75, 200].
  const fcrAtCap = computeCastInterval(0.70, 0.85, 200);
  const fcrBeyondCap = computeCastInterval(0.70, 0.85, 9999);
  closeTo(fcrAtCap, 0.1983, 'E6.11 at the FCR cap');
  closeTo(fcrBeyondCap, 0.1983, 'FCR beyond the cap clamps the same as exactly the cap');
});

test('E6 — attackInterval(actor, skillId) wires weapon.attackTime x class.attackScale x IAS end to end', async () => {
  const combat = await makeCombat();

  // E6.1-3/6-7: Ravager (attackScale 0.90) + Battle Axe (attackTime 0.75).
  for (const [ias, expected] of [[0, 0.6750], [20, 0.5625], [100, 0.3375], [300, 0.2500], [-75, 2.7000]]) {
    const actor = makeActor({
      classId: 'ravager',
      equipment: { mainHand: WEAPONS.axe_battle_normal },
      equipmentStats: { increasedAttackSpeed: ias },
    });
    closeTo(combat.attackInterval(actor, null), expected, `attackInterval Ravager+BattleAxe IAS=${ias}`);
  }

  // E6.4: Runeblade (attackScale 1.00) + Rune Sword (attackTime 0.65), IAS 15.
  const runeblade = makeActor({
    classId: 'runeblade',
    equipment: { mainHand: WEAPONS.sword_rune_normal },
    equipmentStats: { increasedAttackSpeed: 15 },
  });
  closeTo(combat.attackInterval(runeblade, null), 0.5652, 'attackInterval Runeblade+RuneSword IAS=15');

  // E6.5: base 2.20 does not match any of the seven reference weapons — a
  // synthetic weapon-shaped object exercises the same formula end to end.
  const synthetic = makeActor({
    classId: 'runeblade',
    equipment: { mainHand: { minDamage: 0, maxDamage: 0, attackTime: 2.20, handling: 'staff' } },
  });
  closeTo(combat.attackInterval(synthetic, null), 2.2000, 'attackInterval synthetic base=2.20');
});

test('E6 — castInterval(actor, skillId) wires class.castScale x FCR end to end (placeholder base, consistency only)', async () => {
  const combat = await makeCombat();
  const actor = makeActor({ classId: 'emberwright', equipmentStats: { fasterCastRate: 25 } });
  const got = combat.castInterval(actor, null);
  const expected = computeCastInterval(0.60, CLASS_SCALE_TABLE.emberwright.castScale, 25);
  closeTo(got, expected, 'castInterval matches computeCastInterval with the same placeholder base');
});

// ===========================================================================
// Supporting behaviour: pool discipline, fallbacks, error paths
// ===========================================================================

test('PacketPool: acquire/release cycle never grows, onHitStatus array never resized', () => {
  const pool = new PacketPool(4);
  const acquired = [];
  for (let i = 0; i < 4; i++) {
    const p = pool.acquire();
    assert.ok(p, `slot ${i} should be available`);
    assert.equal(p.onHitStatus.length, 4, 'onHitStatus is always a fixed 4-slot array');
    acquired.push(p);
  }
  assert.equal(pool.acquire(), null, 'pool of capacity 4 is dry after 4 acquires');

  pool.release(acquired[0]);
  const reacquired = pool.acquire();
  assert.ok(reacquired, 'a released slot becomes acquirable again');
  assert.equal(reacquired.onHitStatus.length, 4, 'still a fixed 4-slot array after reuse');

  // Double release is a safe no-op, not a throw (matches src/actors/pool.js's
  // own "never throw on a stale handle" discipline).
  pool.release(acquired[1]);
  assert.doesNotThrow(() => pool.release(acquired[1]));
});

test('CombatSystem: buildAttackPacket/buildSpellPacket reject a source with no composed stats', async () => {
  const combat = await makeCombat();
  const bareActor = createActorRecord(999); // stats/sources are null until composeStats runs
  assert.throws(() => combat.buildAttackPacket(bareActor, null, 0), /source\.stats is not composed/);
  assert.throws(() => combat.buildSpellPacket(bareActor, null, 0), /source\.stats is not composed/);
});

test('resolveWeapon: falls back to WEAPONS.unarmed when no weapon is equipped', () => {
  const actor = makeActor({});
  assert.equal(resolveWeapon(actor), WEAPONS.unarmed);
  const armed = makeActor({ equipment: { mainHand: WEAPONS.maul_great_normal } });
  assert.equal(resolveWeapon(armed), WEAPONS.maul_great_normal);
});

test('classScaleFor: falls back to the neutral (x1) scale for a monster/no-class actor', () => {
  assert.equal(classScaleFor(null), NEUTRAL_CLASS_SCALE);
  assert.equal(classScaleFor('not_a_real_class'), NEUTRAL_CLASS_SCALE);
  assert.equal(classScaleFor('ravager'), CLASS_SCALE_TABLE.ravager);
});

test('CombatSystem registers with the expected id/deps for O-12 registration', () => {
  assert.equal(CombatSystem.id, 'combat');
  assert.deepEqual(CombatSystem.deps, ['actors']);
});

test('PacketPool capacity matches 01-data-model.md §11.1 (256)', () => {
  assert.equal(PACKET_POOL_CAPACITY, 256);
});
