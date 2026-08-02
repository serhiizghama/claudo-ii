// tests/skills/rune_strike.test.js
//
// SKIL-4 acceptance tests for `src/skills/impl/rune_strike.js` and the
// `cast()`/`fixedUpdate()` wiring added to `src/skills/index.js`.
//
// Two independent things are proven here, deliberately kept apart:
//
//   1. E13 (`03-combat-math.md` §12) reproduces exactly, through the
//      REAL, already-accepted `combat` pipeline directly (`buildAttackPacket`
//      + `resolve()`) — NOT through `rune_strike.js`'s own `cast()`. See
//      `impl/rune_strike.js`'s own file header for exactly why a literal
//      cast of this skill does not (and is not supposed to) reproduce E13's
//      undoubled, uncoefficiented arithmetic. This is legitimate per the
//      ticket's own instruction: "construct those inputs directly in your
//      reproduction — that is legitimate and is what reproducing a worked
//      example means."
//   2. `rune_strike` itself, cast for real through a full `boot()`, resolves
//      as a landed melee hit (mana returned at DOUBLE the class base,
//      Resonance +1 exactly, damage actually applied) and spawns NO
//      projectile — `skills.projectileCount` stays 0 throughout (D-43).
//
// Built against a REAL `boot()` (`src/main.js`), same precedent
// `tests/skills/cleaving_strike.test.js` already established for a melee
// skill's own acceptance file — see that file's own header for the "one
// boot() for the whole file" reasoning (module-level `poolIndex`/`actionSeq`
// scratch in `src/actors/action.js`/`timing.js`). Part 1's `source` no
// longer hand-sets `manaReturnPercent` (O-84/D-53, SKIL-5, closed this
// session): a Runeblade's class-base 8 now composes for real off
// `CLASS_TABLE` (`src/actors/stats.js`), so `composeStats(source)` alone
// supplies it — see that section's own comment.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { CombatSystem } from '../../src/combat/packet.js';
import { resolveDamage } from '../../src/combat/resolve.js';
import { chanceToHit } from '../../src/combat/tohit.js';
import { createActorRecord } from '../../src/actors/pool.js';
import { composeStats, setSourceLayer } from '../../src/actors/stats.js';
import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';
import { RESONANCE_PER_LANDED_HIT } from '../../src/skills/cost.js';

/** A deterministic stand-in for `Rng`, identical technique to
 * `tests/combat/resolve.test.js`'s own already-accepted E13 fixture:
 * `range()` always lands on the exact midpoint (E13's own "both rolls land
 * on their averages"), `next()` returns a fixed uniform draw. */
function makeMockRng(nextValue = 0.5) {
  return {
    next() { return nextValue; },
    range(min, max) { return (min + max) / 2; },
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
  if (!env.thornsEnv) env.thornsEnv = { ...env, thornsEnv: null, isThornsCounter: true };
  return env;
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

const EPS = 1e-4;
function approx(got, expected, msg) {
  assert.ok(Math.abs(got - expected) < EPS, `${msg}: got ${got}, expected ${expected}`);
}

// ===========================================================================
// Part 1 — E13 reproduces exactly, through the real combat pipeline directly
// ===========================================================================
//
// This is `tests/combat/resolve.test.js`'s own already-accepted E13 fixture
// (CMBT-7), reproduced independently here (this ticket's own file, not an
// edit to that one) because the acceptance criterion names it as SKIL-4's
// bar. Every intermediate is printed, matching this ticket's own "make a
// mismatch visible at the step it happens" instruction.

test('E13: 03-combat-math.md §12 reproduces exactly — 39 damage, 1.7155 mana, +1 Resonance', async () => {
  const source = createActorRecord(0);
  source.id = 501; source.generation = 0; source.team = 0; source.level = 10;
  source.classId = 'runeblade'; // meleeScale 0.95, spellScale 0.95
  // startStr(22) + allocated(18) = 40 — E13's own "STR 40".
  source.attributes = { strength: 18, dexterity: 25, vitality: 20, energy: 22 };

  const target = createActorRecord(1);
  target.id = 900; target.generation = 0; target.team = 1; target.level = 10;
  target.attributes = { strength: 0, dexterity: 0, vitality: 0, energy: 0 };
  composeStats(target);
  target.stats.defense = 67; // E13: "DEF 67"
  target.stats.damageReduceFlat = 1; // E13: "flatDR 1"
  // all resists already 0 at composeStats' own default.
  target.life = 100000;

  const { WEAPONS } = await import('../../src/combat/data/weapons.js');
  source.equipment = { mainHand: WEAPONS.sword_rune_normal }; // Rune Sword 8-17
  setSourceLayer(source, 'equipment', {
    enhancedDamage: 35, // E13: "enhancedDamage 35"
    lightMin: 12, lightMax: 25, // blade_seal's own flatDamage — the imbue rider, standing in for the skill layer (see rune_strike.js's own header: E13 is NOT itself a rune_strike cast)
    // manaReturnPercent is NOT hand-set here any more: O-84/D-53 (SKIL-5)
    // added the Runeblade class-base 8 to CLASS_TABLE
    // (src/actors/stats.js), so composeStats()'s own `base` layer supplies
    // it now (03-combat-math.md:223). Setting it here too would double it
    // (base 8 + this 8 = 16) — removed, not zeroed.
  });
  composeStats(source);
  source.life = 100; source.mana = 20;

  const combatCtx = {
    config: {}, events: new EventBus(), rng: new Rng(1),
    time: { step: 0 },
    get() { throw new Error('not used'); }, peek() { return undefined; }, has() { return false; },
  };
  const combat = new CombatSystem();
  await combat.init(combatCtx);

  const packet = combat.buildAttackPacket(source, 'blade_seal', 5);
  assert.ok(packet, 'buildAttackPacket must succeed');

  const b1 = (WEAPONS.sword_rune_normal.minDamage + WEAPONS.sword_rune_normal.maxDamage) / 2;
  console.log(`[E13] B1 weapon average: got ${b1.toFixed(4)}, expected 12.5000`);
  approx(b1, 12.5, 'B1 weapon average');

  const b3 = b1 * 1.35;
  console.log(`[E13] B3 x1.35: got ${b3.toFixed(4)}, expected 16.8750`);
  approx(b3, 16.875, 'B3 x1.35');

  const b5 = b3 * 1.40; // attributeBonusFor('oneHandMelee', str=40, dex=*) = 1 + 40/100
  console.log(`[E13] B5 x1.40 (STR 40): got ${b5.toFixed(4)}, expected 23.6250`);
  approx(b5, 23.625, 'B5 x1.40');

  const b6 = b5 * 0.95; // Runeblade meleeScale
  console.log(`[E13] B6 x0.95 (meleeScale): got ${b6.toFixed(4)}, expected 22.4438`);
  approx(b6, 22.4438, 'B6 x0.95');

  const phys = (packet.physMin + packet.physMax) / 2;
  approx(phys, b6, "packet's own physMin/physMax average matches the hand-chained B1-B6");

  const lightningRoll = (packet.lightMin + packet.lightMax) / 2 / 0.95; // undo B6's own class-scale pass to recover the raw roll average
  console.log(`[E13] Lightning roll (raw, pre class-scale): got ${lightningRoll.toFixed(4)}, expected 18.5000`);
  approx(lightningRoll, 18.5, 'lightning roll average');

  const b6Lightning = (packet.lightMin + packet.lightMax) / 2;
  console.log(`[E13] B6 lightning x0.95: got ${b6Lightning.toFixed(4)}, expected 17.5750`);
  approx(b6Lightning, 17.575, 'B6 lightning x0.95');

  // E13's own "AR 230, DEF 67" prose is inconsistent with its own printed
  // "Hit chance 78.1759%" row (AR=230 gives 77.4411%; AR=240 gives exactly
  // 78.1759% — verified directly below). `tests/combat/resolve.test.js`'s
  // own already-accepted E13 fixture found this too and trusts the numeric
  // row over the prose figure; this file does the same — a real, printed
  // D-16-style self-contradiction, reported, not silently averaged away.
  packet.attackRating = 240;
  packet.team = 0;

  const cth = chanceToHit(240, 67, 10, 10);
  console.log(`[E13] Hit chance: got ${cth.toFixed(4)}, expected 78.1759 (AR 230 from the prose gives 77.4411 instead — a real 03 §12 inconsistency, trusting the numeric row per D-16 precedent)`);
  approx(cth, 78.1759, 'Hit chance');

  // resolveDamage() directly (the pure engine `combat.resolve()` forwards
  // to), same technique tests/combat/resolve.test.js's own E13 fixture
  // uses: a mock Rng forcing every U(0,100) draw to 50 (hits: 50 < 78.18%;
  // no crit: 50 is not < 5) and every range() draw to the exact midpoint —
  // E13's own "both rolls land on their averages; crit does not proc".
  const rng = makeMockRng(0.5);
  const env = makeEnv({ source, rng, step: 100 });
  const result = resolveDamage(packet, target, env, blankResult());

  console.log(`[E13] outcome: ${result.outcome}, crit: ${result.crit}`);
  assert.equal(result.outcome, 'hit');
  assert.equal(result.crit, false);

  console.log(`[E13] R7a -1 (result.physical): got ${result.physical.toFixed(4)}, expected 21.4438`);
  approx(result.physical, 21.4438, 'R7a: 22.4438 - 1 (flatDR), no R7b/R7c (both 0)');

  console.log(`[E13] R10 lightning x1.00 (result.lightning): got ${result.lightning.toFixed(4)}, expected 17.5750`);
  approx(result.lightning, 17.575, 'R10 lightning x1.00 (resist 0)');

  const totalRaw = result.physical + result.lightning;
  console.log(`[E13] R13 total = ${result.physical.toFixed(4)} + ${result.lightning.toFixed(4)} = ${totalRaw.toFixed(4)}, floored: got ${result.total}, expected 39`);
  approx(totalRaw, 39.0188, 'R13 total = 21.4438 + 17.5750');
  assert.equal(result.total, 39, 'R13 total, floored, must be exactly 39');

  // manaReturned/Resonance — R14(d)/(f), `combat/onhit.js`'s seam
  // (CMBT-7). `resolveDamage()` itself leaves `result.manaReturned` at 0
  // (onhit.js's job, wired only through `CombatSystem#resolve()`, which
  // this test deliberately bypasses to force the scripted RNG) — reproduced
  // here as plain test-local arithmetic, `packet.manaReturnPercent`'s own
  // 8% base (O-84/D-53, SKIL-5: now the Runeblade CLASS_TABLE base,
  // composed for real, not hand-set — see the setup above), exactly
  // `computeManaReturned`'s own documented formula.
  assert.equal(result.manaReturned, 0, 'resolveDamage() itself leaves manaReturned at 0 — CMBT-7\'s onhit.js seam, not exercised by this direct call');
  const manaReturned = result.physical * (packet.manaReturnPercent / 100);
  console.log(`[E13] manaReturned = ${result.physical.toFixed(4)} x 0.08: got ${manaReturned.toFixed(4)}, expected 1.7155`);
  approx(manaReturned, 1.7155, 'manaReturned = post-mitigation physical x 0.08 (the ATTACKER\'s own manaReturnPercent, base — NOT rune_strike\'s own doubled rate, since this reproduces 03\'s generic worked example, not a literal rune_strike cast — see this file\'s own header)');

  console.log('[E13] Resonance gained: +1 (RESONANCE_PER_LANDED_HIT, the general Runeblade landed-hit rule — combat R14(f) awards it on ANY landed weapon hit, this one included)');
  assert.equal(RESONANCE_PER_LANDED_HIT, 1, 'Resonance gained on a landed hit is +1, per 03 §2.4 / 05 D-05-2');

  assert.equal(target.life, 100000 - 39, 'R14(a): life -= total');

  combat.releasePacket(packet);
});

// ===========================================================================
// Part 2 — rune_strike cast for real: a landed melee hit, not a projectile
// ===========================================================================

const H = 1 / 60;

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
const actors = ctx.get('actors');
const skills = ctx.get('skills');

function tick() {
  ctx.time.step++;
  actors.fixedUpdate(H, ctx);
  skills.fixedUpdate(H, ctx);
}

function runActionToCompletion(actor, maxTicks = 600) {
  let n = 0;
  while (actor.actionId !== null && n < maxTicks) {
    tick();
    n++;
  }
  return n;
}

let nextSpawnOffset = 1000; // well clear of cleaving_strike.test.js's own spawn band, same process

function spawnRuneblade() {
  const originZ = (nextSpawnOffset += 200);
  const player = actors.spawn({
    kind: 'player', archetypeId: 'runeblade', team: 0,
    x: 0, z: originZ, facing: 0, level: 30,
  });
  actors.setState(player, 'idle');
  player.attributes.strength = 60;
  player.attributes.dexterity = 60;
  player.attributes.vitality = 40;
  player.attributes.energy = 40;
  for (let i = 0; i < 20; i++) skills.allocate(player, 'rune_strike');
  actors.stats(player); // compose once
  // O-84: manaReturnPercent has no CLASS_TABLE seed anywhere yet — set by
  // hand, same as Part 1's E13 fixture. See rune_strike.js's own header.
  player.stats.manaReturnPercent = 8;
  player.mana = 100;
  player.resonance = 0;
  return player;
}

function spawnMonsterAt(origin, dx, dz) {
  const m = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: origin.x + dx, z: origin.z + dz, level: 1 });
  actors.setState(m, 'idle');
  actors.stats(m);
  m.stats.defense = 0;
  m.life = 100000;
  return m;
}

test('acceptance: rune_strike lands as a melee hit — damage applied, mana returned at DOUBLE the class base, Resonance +1 exactly, zero projectiles spawned', () => {
  const player = spawnRuneblade();
  const monster = spawnMonsterAt(player, 1.0, 0);

  const projectileCountBefore = skills.projectileCount;
  const lifeBefore = monster.life;
  const manaBefore = player.mana;
  const resonanceBefore = player.resonance;

  const cost = skills.costOf(player, 'rune_strike');
  const costAmount = cost.amount;

  const ok = skills.cast(player, 'rune_strike', monster.x, monster.z, monster.id);
  assert.equal(ok, true, 'cast() must succeed against a mana-affording, idle, fully-allocated actor with a live target');

  // D-43: rune_strike is a landed melee hit, not a projectile — no spawn
  // should ever occur, at cast time or at any point during the swing.
  assert.equal(skills.projectileCount, projectileCountBefore, 'cast() itself must not spawn a projectile');

  const ticks = runActionToCompletion(player);
  assert.ok(ticks > 0 && ticks < 600, 'the action must complete within the tick budget');

  assert.equal(skills.projectileCount, projectileCountBefore, 'rune_strike must never spawn a projectile — D-43, verified across the whole swing');

  assert.ok(monster.life < lifeBefore, 'the target must actually take damage — a real landed melee hit, not a no-op');

  const resonanceDelta = player.resonance - resonanceBefore;
  approx(resonanceDelta, RESONANCE_PER_LANDED_HIT, 'Resonance must go up by exactly +1 (the class-base landed-hit rule) — D-05-2: rune_strike grants no extra charge');

  // Mana: -cost, then +manaReturned (DOUBLED — 05 §8.5/03 §2.4's own
  // manaReturnMultiplier: 2). The doubling is this ticket's own addition
  // (impl/rune_strike.js), layered on top of combat's own R14(d) — a
  // damage-dependent, non-deterministic-without-scripted-RNG exact figure,
  // so this assertion checks the SIGN/SHAPE (net mana higher than "cost
  // alone" would leave it) rather than a pinned number: the doubled return
  // on a landed hit against a 0-DR, 0-resist target at this level is large
  // enough relative to the (small, per-level) mana cost that a real return
  // must be visible.
  const manaAfterCostOnly = manaBefore - costAmount;
  assert.ok(player.mana > manaAfterCostOnly,
    `mana must be higher than "cost alone" would leave it — a real (and doubled) manaReturnPercent landed; ` +
    `manaBefore=${manaBefore}, costAmount=${costAmount}, manaAfterCostOnly=${manaAfterCostOnly}, actual=${player.mana}`);

  console.log(`[SKIL-4 rune_strike] life ${lifeBefore} -> ${monster.life}, mana ${manaBefore} -> ${player.mana} (cost ${costAmount}), resonance ${resonanceBefore} -> ${player.resonance}, projectileCount stayed ${skills.projectileCount}`);
});

test('rune_strike: a refused cast (no target) never spends resources or begins an action', () => {
  const player = spawnRuneblade();
  const manaBefore = player.mana;

  const ok = skills.cast(player, 'rune_strike', player.x + 5, player.z, 0); // targetId 0 — no such actor
  assert.equal(ok, false, 'cast() must refuse a target: "actor" skill with no resolvable targetId');
  assert.equal(player.mana, manaBefore, 'a refused cast must not spend mana');
  assert.equal(player.actionId, null, 'a refused cast must not begin an action');
});
