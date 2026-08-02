// tests/player/progress.test.js
//
// PLYR-4 acceptance tests for src/player/progress.js (`ProgressTracker`,
// `computeInCombat`, `computeSecondaryDecay`, the O-83 decay constants) and
// src/player/data/progression.js (`XP_TOTAL`/`XP_TABLE`, D-38). `node:test`
// + `node:assert/strict` only (12-testing.md P6).
//
// Four layers, cheapest/most isolated first:
//   1. The XP curve — `XP_TOTAL(n)` and the hand-transcribed `XP_TABLE`
//      checked row by row against `03-combat-math.md` §10.4's printed
//      1..30 table, independently of each other (see data/progression.js's
//      own header for why: a bug in the closed form must not hide behind
//      "the table was generated from it").
//   2. `ProgressTracker` unit tests against hand-built fake `actor`/
//      `actors`/`events` — the level-up while-loop, the deferred refill,
//      the level cap, all without a live engine.
//   3. Integration: a real `boot()`, real `ActorsSystem`/`PlayerSystem` —
//      the acceptance criteria that need the real event bus, the real
//      composed `StatBlock`, and the real, already-landed
//      `integrateVessels` decay (ACTR-21/D-49) driven in STEPS, never
//      timed.
//   4. Module hygiene — src/player/progress.js and
//      src/player/data/progression.js stay Node/three-free.
//
// Per O-27/O-39: no assertion here encodes "this method doesn't exist yet"
// or a hard-coded scope/count; every check is on real, computed behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FIXED_DT } from '../../src/core/engine.js';
import { boot } from '../../src/main.js';
import { PlayerSystem } from '../../src/player/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { makeStubCtx } from '../helpers/actor.js';
import {
  ProgressTracker,
  computeInCombat,
  computeSecondaryDecay,
  RAGE_DECAY_PER_SECOND,
  RESONANCE_DECAY_PER_SECOND,
  LEVEL_CAP,
} from '../../src/player/progress.js';
import { XP_TOTAL, XP_TABLE } from '../../src/player/data/progression.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Matches tests/player/plyr1.test.js's own stub canvas. */
function makeCanvas(width = 1280, height = 720) {
  return {
    width, height, clientWidth: width, clientHeight: height,
    addEventListener() {}, removeEventListener() {},
  };
}

async function bootGame(opts = {}) {
  return boot({ canvas: makeCanvas(), deterministic: true, global: {}, ...opts });
}

// ===========================================================================
// Layer 1 — the XP curve: 03-combat-math.md §10.4, transcribed exactly
// ===========================================================================

// The printed table, `03-combat-math.md` §10.4 L1064-1095, "Cumulative"
// column, copied by hand a SECOND time (independently of data/
// progression.js's own transcription) so this test's own expectation isn't
// just re-reading the file it is supposed to be checking.
const PRINTED_CUMULATIVE = [
  0, 50, 303, 870, 1838, 3283, 5274, 7875, 11143, 15136,
  19905, 25503, 31977, 39375, 47742, 57123, 67559, 79093, 91765, 105616,
  120684, 137006, 154621, 173565, 193874, 215583, 238727, 263339, 289455, 317106,
];

test('XP_TOTAL(n) reproduces the printed 1..30 table to the integer, row by row', () => {
  assert.equal(PRINTED_CUMULATIVE.length, 30, 'sanity: the printed table itself has 30 rows');
  for (let level = 1; level <= 30; level++) {
    const expected = PRINTED_CUMULATIVE[level - 1];
    const actual = XP_TOTAL(level);
    assert.equal(actual, expected, `XP_TOTAL(${level}) must equal ${expected}, got ${actual}`);
  }
});

test('XP_TABLE (hand-transcribed) matches XP_TOTAL (the closed form) AND the printed table, row by row', () => {
  for (let level = 1; level <= 30; level++) {
    const expected = PRINTED_CUMULATIVE[level - 1];
    assert.equal(XP_TABLE[level], expected, `XP_TABLE[${level}] must equal ${expected}, got ${XP_TABLE[level]}`);
    assert.equal(XP_TABLE[level], XP_TOTAL(level), `XP_TABLE[${level}] must equal XP_TOTAL(${level})`);
  }
  assert.equal(XP_TABLE[0], 0, 'index 0 is an unused placeholder — no level 0');
  assert.equal(XP_TABLE.length, 31, 'indices 0..30 — direct level indexing, no off-by-one translation');
});

test('XP_TABLE is frozen (gameplay data, never mutated at runtime)', () => {
  assert.ok(Object.isFrozen(XP_TABLE));
});

// ===========================================================================
// Layer 2 — ProgressTracker unit tests, hand-built fakes, no live engine
// ===========================================================================

function makeFakeActor(level = 1) {
  return { level, lastDamageStep: -1, lastDealtStep: -1 };
}

function makeFakeActors(statBlock) {
  return {
    markDirtyCalls: 0,
    markDirty() { this.markDirtyCalls++; },
    stats() { return statBlock; },
  };
}

function makeFakeEvents() {
  return {
    emitted: [],
    emit(event, payload) { this.emitted.push({ event, payload: { ...payload } }); },
  };
}

test('ProgressTracker.grantXp accumulates experience, no-op on non-positive/non-finite amounts', () => {
  const p = new ProgressTracker();
  p.grantXp(100);
  assert.equal(p.experience, 100);
  p.grantXp(50);
  assert.equal(p.experience, 150);
  p.grantXp(0);
  p.grantXp(-10);
  p.grantXp(NaN);
  p.grantXp(Infinity);
  assert.equal(p.experience, 150, 'zero/negative/non-finite grants must be no-ops');
});

test('ProgressTracker.grantXp clamps at XP_TABLE[LEVEL_CAP] (13-progression-lore.md §1.7)', () => {
  const p = new ProgressTracker();
  p.grantXp(XP_TABLE[LEVEL_CAP] + 1_000_000);
  assert.equal(p.experience, XP_TABLE[LEVEL_CAP]);
});

test('ProgressTracker.checkLevelUp: a single threshold crossed levels up exactly once, +5 stat, +1 skill, writes actor.level, markDirty ONCE, emits player:levelup ONCE', () => {
  const p = new ProgressTracker();
  const actor = makeFakeActor(1);
  const actors = makeFakeActors({ maxLife: 100, maxMana: 50, maxStamina: 30 });
  const events = makeFakeEvents();

  p.grantXp(XP_TABLE[2]); // exactly the level-2 threshold
  p.checkLevelUp(actor, actors, events);

  assert.equal(p.level, 2);
  assert.equal(p.statPoints, 5);
  assert.equal(p.skillPoints, 1);
  assert.equal(actor.level, 2, 'actor.level must be written — stats.js#derive reads it for maxLife/maxMana scaling');
  assert.equal(actors.markDirtyCalls, 1);
  assert.equal(events.emitted.length, 1);
  assert.equal(events.emitted[0].event, 'player:levelup');
  assert.deepEqual(events.emitted[0].payload, { level: 2, statPoints: 5, skillPoints: 1 });
});

test('ProgressTracker.checkLevelUp: crossing multiple thresholds in one grant levels up multiple times, ascending, all in one call, markDirty called ONCE (11-flows.md §8 step 5/6)', () => {
  const p = new ProgressTracker();
  const actor = makeFakeActor(1);
  const actors = makeFakeActors({ maxLife: 100, maxMana: 50, maxStamina: 30 });
  const events = makeFakeEvents();

  p.grantXp(XP_TABLE[5]); // crosses levels 2, 3, 4, 5 all at once
  p.checkLevelUp(actor, actors, events);

  assert.equal(p.level, 5);
  assert.equal(p.statPoints, 20); // 4 levels x 5
  assert.equal(p.skillPoints, 4);
  assert.equal(actors.markDirtyCalls, 1, 'markDirty is its own single step AFTER the per-level loop, not called per level');
  assert.equal(events.emitted.length, 4, 'one player:levelup PER level crossed');
  assert.deepEqual(events.emitted.map((e) => e.payload.level), [2, 3, 4, 5], 'ascending, in order');
});

test('ProgressTracker.checkLevelUp: no threshold crossed is a true no-op (no markDirty, no emit)', () => {
  const p = new ProgressTracker();
  const actor = makeFakeActor(1);
  const actors = makeFakeActors({ maxLife: 100, maxMana: 50, maxStamina: 30 });
  const events = makeFakeEvents();

  p.grantXp(1); // nowhere near XP_TABLE[2] = 50
  p.checkLevelUp(actor, actors, events);

  assert.equal(p.level, 1);
  assert.equal(actors.markDirtyCalls, 0);
  assert.equal(events.emitted.length, 0);
});

test('ProgressTracker.checkLevelUp never exceeds LEVEL_CAP even with a huge grant; xpToNextLevel is 0 at the cap', () => {
  const p = new ProgressTracker();
  const actor = makeFakeActor(1);
  const actors = makeFakeActors({ maxLife: 100, maxMana: 50, maxStamina: 30 });
  const events = makeFakeEvents();

  p.grantXp(XP_TABLE[LEVEL_CAP] + 1_000_000);
  p.checkLevelUp(actor, actors, events);

  assert.equal(p.level, LEVEL_CAP);
  assert.equal(p.statPoints, 5 * (LEVEL_CAP - 1)); // 145 at cap
  assert.equal(p.skillPoints, LEVEL_CAP - 1); // 29 at cap
  assert.equal(events.emitted.length, LEVEL_CAP - 1, 'exactly 29 level-ups from 1 to 30, never a 30th');
  assert.equal(p.xpToNextLevel(), 0);
});

// ---------------------------------------------------------------------------
// THE CORE PROOF — rage/Resonance are NOT refilled on level-up; life/mana/
// stamina ARE, and only one fixed step later.
// ---------------------------------------------------------------------------

test('ProgressTracker.applyPendingRefill: does nothing until a level-up has set the flag', () => {
  const p = new ProgressTracker();
  const actor = { life: 10, mana: 5, stamina: 1, rage: 42, resonance: 0 };
  const actors = makeFakeActors({ maxLife: 999, maxMana: 999, maxStamina: 999 });

  const applied = p.applyPendingRefill(actor, actors);
  assert.equal(applied, false);
  assert.equal(actor.life, 10, 'no level-up occurred — nothing refills');
});

test('THE PROOF: applyPendingRefill sets life/mana/stamina to the new max, but leaves rage AND resonance completely untouched', () => {
  const p = new ProgressTracker();
  const actor = makeFakeActor(1);
  actor.life = 10; actor.mana = 5; actor.stamina = 1;
  actor.rage = 63; actor.resonance = 2.4; // arbitrary, mid-bar values
  const actors = makeFakeActors({ maxLife: 345, maxMana: 25, maxStamina: 40 });
  const events = makeFakeEvents();

  p.grantXp(XP_TABLE[2]);
  p.checkLevelUp(actor, actors, events); // level-up happens, refill flag set

  // Rage/resonance/life/mana/stamina must all still read exactly as before —
  // checkLevelUp itself never touches a single vessel field.
  assert.equal(actor.life, 10);
  assert.equal(actor.mana, 5);
  assert.equal(actor.stamina, 1);
  assert.equal(actor.rage, 63);
  assert.equal(actor.resonance, 2.4);

  const applied = p.applyPendingRefill(actor, actors);
  assert.equal(applied, true);

  // life/mana/stamina refilled to the (new, post-level-up) max.
  assert.equal(actor.life, 345);
  assert.equal(actor.mana, 25);
  assert.equal(actor.stamina, 40);

  // rage and resonance: BIT-FOR-BIT unchanged. This is the acceptance
  // criterion: "Rage and Resonance are NOT refilled on level-up."
  assert.equal(actor.rage, 63, 'rage must not be refilled on level-up');
  assert.equal(actor.resonance, 2.4, 'resonance must not be refilled on level-up');

  // One-shot: a second call does nothing more.
  actor.life = 1;
  const appliedAgain = p.applyPendingRefill(actor, actors);
  assert.equal(appliedAgain, false);
  assert.equal(actor.life, 1, 'the flag was consumed — a second call is a true no-op');
});

// ---------------------------------------------------------------------------
// REGRESSION — seedFromActor: level is single-valued from the moment an
// actor exists, never assumed to be 1. Reproduces the exact scenario the
// orchestrator's live probe caught: a spawned actor already at a real,
// non-1 level (the placeholder's own old bug fell through to
// SPAWN_SPEC_DEFAULTS.level === 10) must not get silently overwritten by
// the tracker's constructor default on the first level-up.
// ---------------------------------------------------------------------------

test('ProgressTracker.seedFromActor: adopts an already-spawned actor\'s real level, not the constructor\'s 1 default', () => {
  const p = new ProgressTracker();
  const actor = makeFakeActor(10); // exactly the regression scenario: spawned at 10, tracker never told

  p.seedFromActor(actor);

  assert.equal(p.level, 10, 'the tracker must adopt the actor\'s real level');
  assert.equal(actor.level, 10, 'seeding must never itself change an already-valid actor.level');
  assert.equal(p.experience, XP_TABLE[10], 'experience seeded to the level\'s own floor — no negative xp band');
  assert.equal(p.xpToNextLevel(), XP_TABLE[11] - XP_TABLE[10]);
});

test('ProgressTracker.seedFromActor: a SUBSEQUENT level-up from a seeded 10 goes to 11, never resets to 2 (THE REGRESSION, fixed)', () => {
  const p = new ProgressTracker();
  const actor = makeFakeActor(10);
  const actors = makeFakeActors({ maxLife: 500, maxMana: 50, maxStamina: 30 });
  const events = makeFakeEvents();

  p.seedFromActor(actor);
  p.grantXp(XP_TABLE[11] - XP_TABLE[10]); // exactly crosses the NEXT threshold from 10
  p.checkLevelUp(actor, actors, events);

  assert.equal(p.level, 11, 'must level up to 11, not reset to some low number derived from an unseeded tracker');
  assert.equal(actor.level, 11);
  assert.deepEqual(events.emitted.map((e) => e.payload.level), [11]);
});

test('ProgressTracker.seedFromActor: clamps an out-of-curve level (> LEVEL_CAP) to LEVEL_CAP and corrects actor.level to match', () => {
  const p = new ProgressTracker();
  const actor = makeFakeActor(40); // actors.pool's own clampLevel allows up to 40 (bosses/uniques)

  p.seedFromActor(actor);

  assert.equal(p.level, LEVEL_CAP);
  assert.equal(actor.level, LEVEL_CAP, 'actor.level corrected to match — single-valued even in the clamp case');
});

test('ProgressTracker.seedFromActor: a null/undefined actor is a no-op (defensive)', () => {
  const p = new ProgressTracker();
  p.seedFromActor(null);
  assert.equal(p.level, 1);
  p.seedFromActor(undefined);
  assert.equal(p.level, 1);
});

// ===========================================================================
// Layer 2b — computeInCombat / computeSecondaryDecay, pure functions
// ===========================================================================

test('computeInCombat: a never-fought actor (-1/-1 sentinels) is NOT in combat, regardless of step', () => {
  assert.equal(computeInCombat({ lastDamageStep: -1, lastDealtStep: -1 }, 0), false);
  assert.equal(computeInCombat({ lastDamageStep: -1, lastDealtStep: -1 }, 5000), false);
});

test('computeInCombat: true within 4.0 s / 240 steps of the more recent of lastDamageStep/lastDealtStep', () => {
  assert.equal(computeInCombat({ lastDamageStep: 100, lastDealtStep: -1 }, 100), true, 'the same step it happened');
  assert.equal(computeInCombat({ lastDamageStep: 100, lastDealtStep: -1 }, 339), true, '239 steps later — still inside the window');
  assert.equal(computeInCombat({ lastDamageStep: 100, lastDealtStep: -1 }, 340), false, '240 steps later — exactly at the boundary, out');
  assert.equal(computeInCombat({ lastDamageStep: -1, lastDealtStep: 200 }, 200), true, 'lastDealtStep alone also counts');
  assert.equal(computeInCombat({ lastDamageStep: 50, lastDealtStep: 100 }, 100), true, 'the MAX of the two is what matters');
});

test('computeInCombat: null actor is not in combat (defensive)', () => {
  assert.equal(computeInCombat(null, 0), false);
});

test('computeSecondaryDecay: 0 while inCombat, regardless of kind/value', () => {
  assert.equal(computeSecondaryDecay('rage', 90, true), 0);
  assert.equal(computeSecondaryDecay('resonance', 3, true), 0);
});

test('computeSecondaryDecay: 0 once the resource is already at (or below) 0 — matches vessels.js#decayOutOfCombat\'s own guard', () => {
  assert.equal(computeSecondaryDecay('rage', 0, false), 0);
  assert.equal(computeSecondaryDecay('rage', -1, false), 0);
});

test('computeSecondaryDecay: the real signed rate out of combat, for each kind', () => {
  assert.equal(computeSecondaryDecay('rage', 90, false), -RAGE_DECAY_PER_SECOND);
  assert.equal(computeSecondaryDecay('resonance', 2, false), -RESONANCE_DECAY_PER_SECOND);
  assert.equal(computeSecondaryDecay('mana', 10, false), 0, 'mana-only classes have no secondary to decay (09-ui.md §4.1.2)');
});

// ===========================================================================
// Layer 3 — integration: real boot(), real ActorsSystem/PlayerSystem
// ===========================================================================

/** Drives exactly `n` fixed steps through the real `actors` and `player`
 * subsystems, in the real engine's own init order (actors before player),
 * manually advancing `ctx.time.step` — the same pattern
 * tests/player/plyr2.test.js's own `driveOrder` helper already established
 * for a stub-ctx integration harness. Counted in STEPS, never wall-clock
 * (no `Date.now()`/`performance.now()`/`setTimeout` anywhere in this file).
 */
function stepN(ctx, n) {
  const actors = ctx.get('actors');
  const player = ctx.get('player');
  for (let i = 0; i < n; i++) {
    actors.fixedUpdate(FIXED_DT, ctx);
    player.fixedUpdate(FIXED_DT, ctx);
    ctx.time.step++;
  }
}

test('integration: player.grantXp() accumulates into the real ProgressTracker, scaled by the live StatBlock\'s experienceGain', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');
  const actor = player.actor;

  actors.setSourceLayer(actor, 'equipment', { experienceGain: 50 }); // +50%
  player.grantXp(100, 0);

  // 100 * (1 + 50/100) = 150 — the (1 + experienceGain/100) factor is
  // player's own job (src/combat/xp.js's own header: xpForMonster's
  // contract signature omits it on purpose).
  assert.equal(player.hudState().xpTotal, 150);
});

test('integration: the xp:gain event (combat\'s real emission shape, src/combat/xp.js) drives grantXp for the matching actor only', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');
  const otherActor = actors.spawn({ kind: 'monster', team: 1, archetypeId: 'ravager', x: 9, z: 9, facing: 0 });

  const monsterCorpse = { id: 999 }; // stands in for `source` — a killed monster Actor
  ctx.events.emit('xp:gain', { actor: otherActor, amount: 1000, source: monsterCorpse });
  assert.equal(player.hudState().xpTotal, 0, 'xp:gain for a DIFFERENT actor must not credit the player');

  ctx.events.emit('xp:gain', { actor: player.actor, amount: 1000, source: monsterCorpse });
  assert.equal(player.hudState().xpTotal, 1000, 'xp:gain for the player\'s own actor accumulates immediately (synchronous listener)');
});

// ---------------------------------------------------------------------------
// REGRESSION, integration: hudState().level and actor.level must NEVER
// disagree — checked at boot, BEFORE any XP is granted. This is the exact
// assertion that would have caught the level-10-collapses-to-2 bug: the old
// code passed every "after a level-up" test because both sides only ever
// compared against EACH OTHER post-level-up, never against the actor's real
// state at boot.
// ---------------------------------------------------------------------------

test('REGRESSION: hudState().level === actor.level immediately after boot(), before any XP is granted', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actor = player.actor;

  // THE assertion that would have caught it.
  assert.equal(player.hudState().level, actor.level, 'hudState().level and actor.level must never disagree, at boot or after');
  // And, with the placeholder spawn fix, both sides are the documented
  // fresh-character value — 13-progression-lore.md §1's whole spine starts
  // at level 1, XP_TABLE[1] === 0.
  assert.equal(actor.level, 1, 'the placeholder must spawn at level 1, not fall through to actors\' monster-oriented SPAWN_SPEC_DEFAULTS.level (10)');
  assert.equal(player.hudState().level, 1);
});

test('REGRESSION, integration: a player actor that ALREADY exists at a real, non-1 level (a future save/character-load stand-in) is adopted correctly, and hudState().level agrees with actor.level from the very first read', async () => {
  // Simulates exactly the scenario the orchestrator's probe caught: an
  // actor at a real level > 1 exists BEFORE player.init() ever runs —
  // `actors.player` is set directly, bypassing this file's own placeholder
  // spawn (and its `level: PLACEHOLDER_LEVEL` fix) entirely, so this proves
  // `seedFromActor` itself is what fixes it, not just the one spawn-call
  // edit. Stub ctx, real ActorsSystem/PlayerSystem — the same shape
  // tests/player/plyr2.test.js's own `makeIntegrationCtx` already
  // established, trimmed to only what this test needs (no nav/physics
  // driving is exercised here).
  const actors = new ActorsSystem();
  const player3 = new PlayerSystem();
  const fakeRender = { cameraRig: { solveOrbitLock() {}, withCameraWrite(camera, fn) { if (typeof fn === 'function') fn(); } } };
  const ctx = makeStubCtx({ systems: { actors, nav: {}, render: fakeRender, player: player3 } });

  await actors.init(ctx);
  // Spawning `kind: 'player'` makes `ActorPool#acquire` set `_playerActor`
  // itself (`pool.js`'s own `get player()`, "the most recently spawned
  // kind === 'player' actor") — no manual assignment needed or possible
  // (`player` has no setter).
  const preExisting = actors.spawn({ kind: 'player', team: 0, archetypeId: 'ravager', level: 10, x: 0, z: 0, facing: 0 });
  assert.equal(actors.player, preExisting, 'sanity: actors.player must already be the just-spawned actor');

  await player3.init(ctx);

  assert.equal(player3.actor, preExisting);
  assert.equal(player3.hudState().level, 10);
  assert.equal(preExisting.level, 10, 'seeding must not itself change an already-valid, higher actor.level');
});

test('THE ACCEPTANCE PROOF, integration: a REAL level-up RAISES maxLife (never lowers it) — before/after, starting from a non-trivial level', async () => {
  const { ctx } = await bootGame();
  const actors = ctx.get('actors');
  const player = ctx.get('player');

  // Re-spawn the player actor at level 10 directly (not through the
  // placeholder path) — the exact level the orchestrator's probe found
  // collapsing to 2. `seedFromActor` (called again here, matching what
  // `PlayerSystem.init()` does) must make the tracker agree with it.
  const actor = player.actor;
  actor.level = 10;
  actors.markDirty(actor);
  player._progress.seedFromActor(actor);

  const before = actors.stats(actor).maxLife;
  assert.equal(player.hudState().level, 10);

  player.grantXp(XP_TABLE[11] - XP_TABLE[10], 0); // exactly crosses level 11's threshold
  stepN(ctx, 2); // level-up step, then the deferred refill step

  const after = actors.stats(actor).maxLife;
  // eslint-disable-next-line no-console
  console.log(`level-up maxLife: level 10 -> 11, before=${before}, after=${after}`);

  assert.equal(actor.level, 11);
  assert.equal(player.hudState().level, 11);
  assert.ok(after > before, `a level-up must RAISE maxLife (before=${before}, after=${after})`);
});

test('THE ACCEPTANCE PROOF, integration: rage/resonance untouched across a real level-up; life/mana/stamina refilled exactly ONE fixed step later', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actor = player.actor;
  assert.equal(actor.classId, 'ravager', 'the ravager placeholder has a rage pool');

  actor.rage = 77;
  actor.life = 1; // deliberately far from maxLife, so a refill is unmistakable
  actor.mana = 1;
  const rageBefore = actor.rage;

  player.grantXp(XP_TABLE[2], 0); // exactly crosses level 2's threshold

  // Step 1: the level-up itself happens inside this fixedUpdate call
  // (checkLevelUp runs every step) — refill is scheduled, not yet applied.
  stepN(ctx, 1);
  assert.equal(actor.level, 2, 'level-up must have happened by now');
  assert.equal(actor.life, 1, 'life must NOT be refilled the SAME step the level-up happened');
  assert.equal(actor.rage, rageBefore, 'rage untouched at the moment of level-up');

  // Step 2: the deferred refill applies now.
  stepN(ctx, 1);
  const s = actors_stats(ctx, actor);
  assert.equal(actor.life, s.maxLife, 'life refilled to the new max, one step later');
  assert.equal(actor.mana, s.maxMana, 'mana refilled to the new max, one step later');
  assert.equal(actor.rage, rageBefore, 'ACCEPTANCE CRITERION: rage is still exactly what it was — never refilled by a level-up');
});

function actors_stats(ctx, actor) {
  return ctx.get('actors').stats(actor);
}

test('integration: player:levelup is emitted with the real level/statPoints/skillPoints, and hudState() reflects the new values', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actor = player.actor;

  const levelUps = [];
  ctx.events.on('player:levelup', (p) => levelUps.push({ ...p }));

  player.grantXp(XP_TABLE[3], 0); // crosses level 2 AND level 3
  stepN(ctx, 1);

  assert.deepEqual(levelUps.map((p) => p.level), [2, 3]);
  assert.equal(levelUps[1].statPoints, 10);
  assert.equal(levelUps[1].skillPoints, 2);

  const hud = player.hudState();
  assert.equal(hud.level, 3);
  assert.equal(hud.statPoints, 10);
  assert.equal(hud.skillPoints, 2);
  assert.equal(hud.xpTotal, XP_TABLE[3]);
  assert.equal(hud.xpFloor, XP_TABLE[3]);
  assert.equal(hud.xpCeiling, XP_TABLE[4]);
  assert.equal(hud.xp, 0, 'exactly at the level-3 floor — 0 progress into the band yet');
});

// ---------------------------------------------------------------------------
// O-83 — decay constants/inCombat readable, PINNED to the real, live
// src/actors/vessels.js decay (never imported — see progress.js's header).
// Driven in STEPS, matching the acceptance criterion: "decay runs from the
// fixed step, never the wall clock", proven by never reading a clock here.
// ---------------------------------------------------------------------------

test('O-83 PIN: rage decays at exactly RAGE_DECAY_PER_SECOND, driven through the REAL ActorsSystem.fixedUpdate (integrateVessels), counted in steps', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actor = player.actor;
  assert.ok(RAGE_DECAY_PER_SECOND > 0);

  actor.rage = 50;
  // Far in the past — both this file's computeInCombat AND vessels.js's own
  // private isInCombat read "out of combat" from step 0 onward, without
  // waiting out the 240-step window.
  actor.lastDamageStep = -10_000;
  actor.lastDealtStep = -10_000;

  const STEPS = 120; // 2.0 s at 60 Hz
  stepN(ctx, STEPS);

  const expected = 50 - RAGE_DECAY_PER_SECOND * (STEPS / 60);
  assert.ok(Math.abs(actor.rage - expected) < 1e-9, `expected rage ~${expected}, got ${actor.rage}`);
  assert.equal(player.hudState().secondaryDecay, -RAGE_DECAY_PER_SECOND, 'still draining — hudState() reports the live rate');
});

test('O-83 PIN: Resonance decays at exactly RESONANCE_DECAY_PER_SECOND (1/3), driven through the REAL ActorsSystem.fixedUpdate, counted in steps', async () => {
  const { ctx } = await bootGame();
  const actors = ctx.get('actors');
  const runeblade = actors.spawn({ kind: 'player', team: 0, archetypeId: 'runeblade', x: 3, z: 3, facing: 0 });
  runeblade.resonance = 3;
  runeblade.lastDamageStep = -10_000;
  runeblade.lastDealtStep = -10_000;

  const STEPS = 180; // 3.0 s at 60 Hz -> exactly 1 Resonance lost at 1/3 per s
  for (let i = 0; i < STEPS; i++) {
    actors.fixedUpdate(FIXED_DT, ctx);
    ctx.time.step++;
  }

  const expected = 3 - RESONANCE_DECAY_PER_SECOND * (STEPS / 60);
  assert.ok(Math.abs(runeblade.resonance - expected) < 1e-9, `expected resonance ~${expected}, got ${runeblade.resonance}`);
});

test('O-83 PIN: no decay at all while inCombat — real ActorsSystem, driven in steps, well within the 240-step window', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actor = player.actor;
  actor.rage = 50;
  actor.lastDealtStep = ctx.time.step; // just fought, right now

  stepN(ctx, 100); // well under 240 steps — still in combat the whole time

  assert.equal(actor.rage, 50, 'no decay while inCombat');
  assert.equal(player.hudState().inCombat, true);
  assert.equal(player.hudState().secondaryDecay, 0);
});

// ===========================================================================
// Layer 4 — Module hygiene: src/player/progress.js and
// src/player/data/progression.js stay Node/three-free
// ===========================================================================

function assertHygiene(relativePath) {
  const source = readFileSync(join(__dirname, relativePath), 'utf8');
  const commentsMasked = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(commentsMasked, /from\s+["']three["']/);
  assert.doesNotMatch(commentsMasked, /\bdocument\s*\./);
  assert.doesNotMatch(commentsMasked, /\bwindow\s*\./);
  assert.doesNotMatch(commentsMasked, /performance\s*\.\s*now\s*\(/);
  assert.doesNotMatch(commentsMasked, /Math\s*\.\s*random\s*\(/);
}

test('src/player/progress.js has no three/document/window/performance.now()/Math.random() (source scan)', () => {
  assertHygiene('../../src/player/progress.js');
});

test('src/player/data/progression.js has no three/document/window/performance.now()/Math.random() (source scan)', () => {
  assertHygiene('../../src/player/data/progression.js');
});
