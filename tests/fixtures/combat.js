// tests/fixtures/combat.js
//
// TEST-5 — shared builders for tests/combat/examples.test.js, the fourteen
// worked examples of docs/spec/03-combat-math.md §12. Explicitly granted to
// this ticket by its own brief: `12-testing.md` §4.2's own snippet calls
// `fixtures.e13()`.
//
// Per this ticket's own rule: "tests/fixtures/combat.js is a fixture module,
// not a test. Keep it data and builders; assertions live in the test file."
// Nothing here calls `assert`.
//
// CombatSystem is reached ONLY through `src/combat/packet.js` — no sibling
// combat file (`tohit.js`, `resolve.js`, `status.js`, `reaction.js`,
// `onhit.js`, `xp.js`) is imported here or by `examples.test.js`. That is
// exactly how `src/main.js` loads the `combat` subsystem (O-51: a test that
// imports a sibling directly exercises a module graph the game never
// builds — the defect that already cost CMBT-2 a round).
//
// Every actor is built through the REAL `src/actors/pool.js#createActorRecord`
// + `src/actors/stats.js#composeStats` pipeline, never a hand-rolled stat
// object — the documented NaN trap (`composeStats` yields NaN in eleven
// fields if any of strength/dexterity/vitality/energy is missing from
// `actor.attributes`) means every builder below always supplies all four
// (via `createActorRecord`'s own `{0,0,0,0}` default, only ever extended
// with `Object.assign`, never replaced wholesale).
//
// No `Math.random()` anywhere — `makeDeterministicRng` below is the one
// source of "randomness" this file ever hands to a `CombatSystem`, and it
// is a fixed, seeded stand-in, never the real `src/core/rng.js#Rng`.

import { CombatSystem } from '../../src/combat/packet.js';
import { WEAPONS, CLASS_SCALE_TABLE } from '../../src/combat/data/weapons.js';
import { createActorRecord } from '../../src/actors/pool.js';
import { composeStats, setSourceLayer } from '../../src/actors/stats.js';
import { setState, cancelAction } from '../../src/actors/action.js';
import { EventBus } from '../../src/core/events.js';

export { WEAPONS, CLASS_SCALE_TABLE };

// ---------------------------------------------------------------------------
// Actor builder
// ---------------------------------------------------------------------------

let nextPoolIndex = 0;
let nextActorId = 1;

/**
 * A minimal, fully-composed Actor (`createActorRecord` + `composeStats`).
 * `overrides.attributes` sets individual keys on top of `createActorRecord`'s
 * `{0,0,0,0}` default attributes object (never replaces it wholesale) — the
 * NaN-trap precedent every sibling CMBT-* ticket's own test file already
 * follows (see e.g. `tests/combat/packet.test.js`'s own header).
 * @param {object} [overrides]
 * @returns {object} a composed Actor record.
 */
export function makeActor(overrides = {}) {
  const actor = createActorRecord(nextPoolIndex++);
  actor.id = overrides.id ?? nextActorId++;
  actor.generation = overrides.generation ?? 0;
  actor.kind = overrides.kind ?? 'player';
  actor.classId = overrides.classId ?? null;
  actor.level = overrides.level ?? 10;
  actor.team = overrides.team ?? 0;
  actor.rank = overrides.rank ?? 'normal';
  actor.mass = overrides.mass ?? 78;
  // createActorRecord's own default is `state: null` (a bare pooled
  // record, before `ActorsSystem.spawn()` ever runs) — not a member of
  // `ACTION_STATE_TRANSITIONS`, so `setState`/`cancelAction` would refuse
  // every transition unconditionally. `'idle'` is the live, spawned default
  // every sibling ticket's own test file already uses (e.g.
  // `tests/combat/reaction.test.js`'s own `makeActor`).
  actor.state = overrides.state ?? 'idle';
  actor.x = overrides.x ?? 0;
  actor.y = overrides.y ?? 0;
  actor.z = overrides.z ?? 0;
  if (overrides.attributes) Object.assign(actor.attributes, overrides.attributes);
  if (overrides.equipment !== undefined) actor.equipment = overrides.equipment;
  if (overrides.equipmentStats) setSourceLayer(actor, 'equipment', overrides.equipmentStats);
  if (overrides.difficultyStats) setSourceLayer(actor, 'difficulty', overrides.difficultyStats);
  composeStats(actor);
  if (overrides.life != null) actor.life = overrides.life;
  if (overrides.maxLife != null) actor.stats.maxLife = overrides.maxLife;
  return actor;
}

// ---------------------------------------------------------------------------
// Deterministic RNG stand-in — rule 3 ("no Math.random() ... a seeded Rng")
// ---------------------------------------------------------------------------

/**
 * A deterministic stand-in for `src/core/rng.js#Rng`: `next()` always
 * returns the same fixed `[0,1)` draw, `range()` always the exact midpoint
 * (matching worked-example inputs that "land on their averages" — E5's
 * poison roll, E13's "both rolls land on their averages"), `fork()` returns
 * itself so `CombatSystem#init()`'s one `ctx.rng.fork()` call still gets a
 * fully-deterministic, usable stream. This is the "seeded Rng" this
 * ticket's own rule 3 names as the sanctioned alternative to `Math.random()`.
 * @param {number} [nextValue] the fixed `next()` draw, in `[0,1)`.
 * @returns {{next: function, range: function, fork: function}}
 */
export function makeDeterministicRng(nextValue = 0.5) {
  const rng = {
    next() { return nextValue; },
    range(min, max) { return (min + max) / 2; },
    fork() { return rng; },
  };
  return rng;
}

/**
 * A stub `actorsSystem` — `.resolve(ref)` / `.byId(id)` search a live
 * roster, the same shape every sibling CMBT-* ticket's own test file
 * already uses (`tests/combat/resolve.test.js`, `onhit.test.js`,
 * `reaction.test.js`, `xp.test.js`). `setState`/`cancelAction` are wired to
 * the REAL, accepted `src/actors/action.js` state machine (the exact
 * precedent `tests/combat/reaction.test.js`'s own stub already
 * establishes — `actors` is not a `combat` sibling, so importing its own
 * files here is unaffected by this ticket's "packet.js only" rule);
 * `hitStop`/`applyImpulse` are plain recorder stand-ins (neither exists
 * anywhere in `src/actors/` yet — same gap that ticket's own header
 * documents). Every one of these is itself called through a guarded
 * `typeof actorsSystem.X === 'function'` check in the accepted
 * implementation, so a caller that never needs the knockback/hitstun path
 * (e.g. E4/E5/E13's own total/manaReturned assertions) is unaffected by
 * their presence.
 * @param {object[]} [actors]
 */
export function makeActorsSystemStub(actors = []) {
  const calls = { hitStop: [], applyImpulse: [] };
  return {
    all: actors,
    calls,
    resolve(ref) {
      return actors.find((a) => a.id === ref.id && a.generation === ref.generation) || null;
    },
    byId(id) {
      return actors.find((a) => a.id === id) || null;
    },
    setState(actor, state) {
      return setState(actor, state);
    },
    cancelAction(actor, reason) {
      return cancelAction(actor, reason);
    },
    hitStop(actor, seconds) {
      calls.hitStop.push({ actor, seconds });
    },
    applyImpulse(actor, dx, dz, seconds) {
      calls.applyImpulse.push({ actor, dx, dz, seconds });
    },
  };
}

/**
 * A real, `init()`-driven `CombatSystem`, reached only through
 * `src/combat/packet.js`. `actors` seeds the roster the stub
 * `actorsSystem.resolve()`/`.byId()` search.
 * @param {object[]} [actors]
 * @param {number} [nextValue] the deterministic `rng.next()` draw — see
 *   `makeDeterministicRng`.
 * @returns {Promise<{combat: CombatSystem, ctx: object, actorsSystem: object}>}
 */
export async function makeCombat(actors = [], nextValue = 0.5) {
  const actorsSystem = makeActorsSystemStub(actors);
  const ctx = {
    config: {},
    events: new EventBus(),
    rng: makeDeterministicRng(nextValue),
    time: { step: 0 },
    get(id) {
      if (id === 'actors') return actorsSystem;
      throw new Error(`fixtures/combat.js stub ctx.get: '${id}' not registered`);
    },
    peek() { return undefined; },
    has() { return false; },
  };
  const combat = new CombatSystem();
  await combat.init(ctx);
  return { combat, ctx, actorsSystem };
}

// ---------------------------------------------------------------------------
// E3 — Ravager basic attack, full build pipeline (03-combat-math.md §12/E3)
// ---------------------------------------------------------------------------

/**
 * Level-10 Ravager, Battle Axe 10-22, enhancedDamage 40, STR 48,
 * meleeScale 1.00, critChance 5/critMult 200 (no gear bonus — the base
 * values), verbatim `03-combat-math.md` §12/E3 inputs.
 * @returns {{actor: object}}
 */
export function e3() {
  const actor = makeActor({
    classId: 'ravager',
    attributes: { strength: 18 }, // startStr 30 + 18 allocated = 48, matching "STR 48"
    equipment: { mainHand: WEAPONS.axe_battle_normal },
    equipmentStats: { enhancedDamage: 40 },
  });
  return { actor };
}

// ---------------------------------------------------------------------------
// E5 — poison as a total (03-combat-math.md §12/E5)
// ---------------------------------------------------------------------------

/**
 * A class with a neutral (×1.00) `spellScale` (Emberwright), carrying
 * poisonMin/poisonMax/poisonDuration exactly as `03-combat-math.md` §12/E5
 * states them. `buildSpellPacket`'s own B6-elemental step always multiplies
 * by `class.spellScale` (`03` §6.1) — E5's own table shows `poisonMin`/
 * `poisonMax` passing through UNCHANGED (30/54), so the fixture needs a
 * `spellScale = 1.00` class for that multiply to be a genuine no-op, same
 * precedent `tests/combat/packet.test.js`'s own E5 fixture already uses. No
 * weapon needed — `buildSpellPacket` zeroes `physMin`/`physMax`.
 * @returns {{actor: object}}
 */
export function e5() {
  const actor = makeActor({
    classId: 'emberwright', // spellScale 1.00 — the neutral multiplier this example needs
    equipmentStats: { poisonMin: 30, poisonMax: 54, poisonDuration: 2.0 },
  });
  return { actor };
}

// ---------------------------------------------------------------------------
// E13 — full resolve, level-10 Runeblade imbued hit (03-combat-math.md §12/E13)
// ---------------------------------------------------------------------------
//
// `12-testing.md` §4.2's own snippet: `const { source, target } =
// fixtures.e13();` — the exact call this ticket's brief names explicitly.

/**
 * Level-10 Runeblade vs. a level-10 Bone Ranker, `03-combat-math.md` §12/E13,
 * verbatim: Rune Sword 8-17, enhancedDamage 35, STR 40, meleeScale 0.95;
 * `blade_seal` slvl 5 lightning 12-25 (no dedicated skill table yet — see
 * `src/combat/packet.js`'s own header, gap 1; the skill's own flatDamage is
 * stood in as an equipment-layer `lightMin`/`lightMax` bonus, same
 * precedent `tests/combat/resolve.test.js`'s own E13 fixture already uses);
 * target Bone Ranker mlvl 10 (`flatDR 1`, all resists 0); AR — see D-16
 * (the ticket's own brief): the printed "Hit chance 78.1759%" row is
 * E1.2's own value (AR 240), not the prose's "AR 230" — `examples.test.js`
 * patches `packet.attackRating = 240` after `buildAttackPacket`, matching
 * `resolve.test.js`'s own precedent exactly.
 * @returns {{source: object, target: object}}
 */
export function e13() {
  const source = makeActor({
    classId: 'runeblade',
    attributes: { strength: 18 }, // startStr 22 + 18 allocated = 40, matching "STR 40"
    equipment: { mainHand: WEAPONS.sword_rune_normal }, // Rune Sword 8-17
    equipmentStats: {
      enhancedDamage: 35,
      lightMin: 12, lightMax: 25, // blade_seal's own flatDamage
      // manaReturnPercent no longer hand-set here: O-84/D-53 (SKIL-5) added
      // the Runeblade class-base 8 to CLASS_TABLE, so composeStats()'s own
      // `base` layer now supplies it (03-combat-math.md:223). The old
      // equipment-layer workaround would now double it (base 8 + this 8 =
      // 16) — removed, not zeroed, so nothing here shadows the real source.
    },
    life: 100, mass: 78,
  });
  const target = makeActor({
    classId: null, kind: 'monster', team: 1, level: 10, rank: 'normal',
    equipmentStats: { defense: 67, damageReduceFlat: 1 }, // Bone Ranker: flatDR 1, all resists 0
    life: 500, maxLife: 500,
  });
  return { source, target };
}

// ---------------------------------------------------------------------------
// E14 — composed stat block, level-13 Ravager (03-combat-math.md §12/E14)
// ---------------------------------------------------------------------------

/**
 * Level-13 Ravager, reference allocation (2 STR / 1 DEX / 2 VIT / 0 ENE per
 * level, levels 2..30 -> 12 allocations at clvl 13), rare Battle Axe
 * (+55% ED, +25 AR), armour totalling defence 210, +35 life, +18 fire
 * resist, difficulty Trial (-40 to each resistance).
 *
 * Item 4 of this ticket's own "documented corrections" list: E14's
 * mysterious `+ 80` in `attackRating = 30 + 5 × (32 − 7) + 80 + 25` is the
 * Battle Axe's own base attack rating (`03` §4.6, `axe_battle_normal`, AR
 * 80) — NOT folded into armour. `weaponAR` below is read straight off
 * `WEAPONS.axe_battle_normal.attackRating`, not a pasted `80` literal, so a
 * future edit to that data row cannot silently desync this fixture from
 * the weapon it claims to model. Total flat AR from equipment
 * (`weaponAR + rareAffixAR` = `80 + 25` = `105`) is what actually reaches
 * `setSourceLayer` — `03-combat-math.md`'s own `composeStats` has no
 * separate "weapon's own AR" channel (no item system exists yet, M3), so
 * the two contributions are summed into one flat `attackRating` bonus on
 * the equipment layer, same precedent `tests/actors/stats.test.js`'s own
 * E14 fixture already establishes.
 * @returns {{actor: object, weaponAR: number, rareAffixAR: number}}
 */
export function e14() {
  const weaponAR = WEAPONS.axe_battle_normal.attackRating; // 80 — the axe's OWN base AR, read from data, not hard-coded
  const rareAffixAR = 25;
  const actor = makeActor({
    classId: 'ravager', level: 13,
    attributes: { strength: 24, dexterity: 12, vitality: 24, energy: 0 },
    equipment: { mainHand: WEAPONS.axe_battle_normal },
    equipmentStats: {
      attackRating: weaponAR + rareAffixAR, // 80 (weapon) + 25 (rare affix) = 105
      defense: 210, maxLife: 35, fireResist: 18,
      enhancedDamage: 55, // carried, must not leak into any derived row
    },
    difficultyStats: {
      fireResist: -40, coldResist: -40, lightResist: -40,
      poisonResist: -40, magicResist: -40, physicalResist: -40,
    },
  });
  return { actor, weaponAR, rareAffixAR };
}

// ---------------------------------------------------------------------------
// Row tables — plain data, verbatim from 03-combat-math.md §12
// ---------------------------------------------------------------------------

/** E1 — chance to hit. [AR, DEF, alvl, dlvl, expected] */
export const E1_ROWS = [
  [235, 67, 10, 10, 77.8146], // E1.1
  [240, 67, 10, 10, 78.1759], // E1.2
  [260, 130, 13, 15, 61.9048], // E1.3
  [275, 130, 13, 15, 63.0511], // E1.4
  [199, 137, 10, 10, 59.2262], // E1.5
  [243, 137, 10, 10, 63.9474], // E1.6
  [50, 900, 5, 30, 5], // E1.7 — low clamp
  [5000, 10, 30, 1, 95], // E1.8 — high clamp
];

/** E2 — block chance. [blockBase|null, flat, DEX, clvl, expected] */
export const E2_ROWS = [
  [55, 0, 32, 13, 35.9615],
  [55, 12, 32, 13, 47.9615],
  [55, 0, 20, 13, 10.5769],
  [null, 40, 32, 13, 0], // no shield
  [65, 30, 90, 12, 75], // high clamp
];

/** E6 — attack interval. [base, classScale, skillScale, ias, expected] */
export const E6_ATTACK_ROWS = [
  [0.75, 0.90, 1.00, 0, 0.6750],
  [0.75, 0.90, 1.00, 20, 0.5625],
  [0.75, 0.90, 1.00, 100, 0.3375],
  [0.65, 1.00, 1.00, 15, 0.5652],
  [2.20, 1.00, 1.00, 0, 2.2000],
  [0.75, 0.90, 1.00, 300, 0.2500], // floor
  [0.75, 0.90, 1.00, -75, 2.7000],
];

/** E6 — cast interval. [base, classScale, fcr, expected] */
export const E6_CAST_ROWS = [
  [0.55, 0.85, 0, 0.4675],
  [0.55, 0.85, 25, 0.3740],
  [0.25, 1.00, 15, 0.2174],
  [0.70, 0.85, 200, 0.1983],
];

/** E7 — hit recovery. [FHR, expected] */
export const E7_ROWS = [
  [0, 0.4000],
  [30, 0.3077],
  [60, 0.2500],
  [120, 0.1818],
  [400, 0.1200], // floor
];

/** E8 — chill accumulation to freeze. Magnitude 30, decay 25/s, threshold
 * 100 (`03` §7.3, verbatim). Full-precision `chillPoints` after each hit
 * (not the 2-decimal display the spec table shows) — see
 * `examples.test.js` for how this reconciles with the printed 2dp rows. */
export const E8_ROWS = [
  { name: 'E8.1', intervalSeconds: 0.675, expected: [30, 43.125, 56.25, 69.375, 82.5, 95.625, 108.75], freezeOnHit: 7 },
  { name: 'E8.2', intervalSeconds: 0.4675, expected: [30, 48.3125, 66.625, 84.9375, 103.25], freezeOnHit: 5 },
  { name: 'E8.3', intervalSeconds: 0.350, expected: [30, 51.25, 72.5, 93.75, 115], freezeOnHit: 5 },
  { name: 'E8.4', intervalSeconds: 2.000, expected: [30, 30, 30, 30, 30], freezeOnHit: null },
];

/** E10 — experience awards. [mlvl, rank, baseXp, clvl, difficulty, expected] */
export const E10_ROWS = [
  [10, 'normal', 7, 10, 'instruction', 36], // E10.1
  [10, 'champion', 7, 10, 'instruction', 109], // E10.2
  [10, 'unique', 7, 10, 'instruction', 217], // E10.3
  [6, 'normal', 7, 16, 'instruction', 10], // E10.4
  [15, 'boss', 900, 13, 'instruction', 7754], // E10.5
  [27, 'boss', 900, 24, 'trial', 21747], // E10.6
  [37, 'boss', 900, 30, 'renunciation', 43399], // E10.7
  [1, 'normal', 7, 30, 'instruction', 1], // E10.8
];

/** E11 — knockback distance. [knockback, mass, expected] */
export const E11_ROWS = [
  [0, 78, 0.5280],
  [0, 22, 0.6820],
  [100, 78, 1.0560],
  [0, 140, 0.3575],
  [0, 400, 0.1375],
];
