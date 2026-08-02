// tests/player/cast.test.js
//
// PLYR-3 acceptance tests — hotbar, cast orders, targeting
// (docs/spec/11-flows.md §5, docs/spec/05-skills.md §1.4, the five
// `SkillDefinition.target` modes at docs/spec/01-data-model.md §6.1/983,
// docs/spec/02-api-contracts.md §13's `castOrder`/`hotbar`/`setHotbar`/
// `hoverTarget` rows). `node:test` + `node:assert/strict` only
// (12-testing.md P6).
//
// Two layers, matching src/player/cast.js's own split:
//
//   - Unit tests drive `CastController` directly against a hand-rolled
//     mock `{ actors, skills, items }` — this is the ONLY way to exercise
//     all five targeting modes today: only `cleaving_strike` (point, no
//     declared range), `rune_strike` (actor) and `ember_bolt` (point, no
//     declared range either) have real `skills.cast()` handlers wired
//     (D-37 scope: "do not implement skills"); `none`/`self`/`direction`
//     and a `point`-mode skill that actually DECLARES `def.range` have no
//     real handler or real data anywhere in `src/skills/data/skills.js`
//     today (checked directly — no skill's `SkillDefinition` has a
//     top-level `range` field; `canCast()`'s own `def.range` branch is
//     live code with no real skill that ever exercises it). Both gaps are
//     `skills`' own data/implementation surface, not this ticket's file
//     list — reported in this ticket's own report, not silently patched
//     around here.
//   - Integration tests drive the real `boot()` sequence (actors, skills,
//     physics, ui, nav all real) through `player.castOrder`/`hotbar`/
//     `hoverTarget`/`hudState`, exercising `point` (`cleaving_strike`) and
//     `actor` (`rune_strike`) end-to-end, cost-at-cast-start, the
//     refused-cast-never-moves rule, and the O-78 pointerOverUi guard.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { FIXED_DT } from '../../src/core/engine.js';
import {
  CastController,
  createHotbar,
  computeApproachPoint,
  isHostile,
  isValidCastTarget,
  weaponRangeOf,
} from '../../src/player/cast.js';

/** Matches tests/player/plyr1.test.js's own stub canvas. */
function makeCanvas(width = 1280, height = 720) {
  return {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    addEventListener() {},
    removeEventListener() {},
  };
}

async function bootGame(opts = {}) {
  return boot({ canvas: makeCanvas(), deterministic: true, global: {}, ...opts });
}

// ===========================================================================
// Unit layer — CastController against a mock deps object
// ===========================================================================

/** A minimal `Actor`-shaped record, enough for `isHostile`/`inRange`/the
 * mock `actors` below. */
function makeActor(id, team, x, z) {
  return { id, team, x, z, radius: 0.3, dead: false, flags: 0, actionId: null };
}

/** A minimal fake `player` — `CastController` only ever calls
 * `moveOrder(x,z)` and `releaseMoveOrder()` on it (never `stop()` — see
 * cast.js's own header for why). Records every call for assertions. */
function makeFakePlayer(actor) {
  return {
    actor,
    moveOrderCalls: [],
    releaseCalls: 0,
    moveOrder(x, z) {
      this.moveOrderCalls.push({ x, z });
    },
    releaseMoveOrder() {
      this.releaseCalls++;
    },
  };
}

/** A minimal fake `skills` — `canCast`/`cast`/`definition` only, the exact
 * surface `CastController` calls (`02-api-contracts.md` §10). `script` is a
 * queue of `{ ok, reason }` results `canCast` returns in order (repeating
 * the last entry once exhausted), so a test can script "busy, then ok".
 */
function makeFakeSkills(def, canCastScript, castReturns = true) {
  let canCastCalls = 0;
  const castCalls = [];
  return {
    definition(id) {
      return id === def.id ? def : null;
    },
    canCast(actor, skillId, x, z) {
      canCastCalls++;
      const idx = Math.min(canCastCalls - 1, canCastScript.length - 1);
      return canCastScript[idx];
    },
    cast(actor, skillId, x, z, targetId) {
      castCalls.push({ actor, skillId, x, z, targetId });
      return typeof castReturns === 'function' ? castReturns() : castReturns;
    },
    get canCastCallCount() {
      return canCastCalls;
    },
    castCalls,
  };
}

function makeFakeActors(targets) {
  const byIdMap = new Map(targets.map((a) => [a.id, a]));
  return {
    byId(id) {
      return byIdMap.get(id) || null;
    },
    inRange(a, b, range) {
      const dx = a.x - b.x;
      const dz = a.z - b.z;
      const dist = Math.sqrt(dx * dx + dz * dz) - a.radius - b.radius;
      return dist <= range;
    },
  };
}

test('unit: helper isHostile/isValidCastTarget — 01-data-model.md §1.2 hostility test', () => {
  const player = makeActor(1, 0, 0, 0);
  const monster = makeActor(2, 1, 0, 0);
  const neutral = makeActor(3, 2, 0, 0);
  assert.equal(isHostile(player, monster), true);
  assert.equal(isHostile(player, neutral), false);
  assert.equal(isHostile(monster, neutral), false);

  assert.equal(isValidCastTarget(player, monster), true);
  assert.equal(isValidCastTarget(player, null), false);
  assert.equal(isValidCastTarget(player, { ...monster, dead: true }), false);
  assert.equal(isValidCastTarget(player, { ...monster, flags: 1 << 1 }), false, 'ACTOR_FLAG.untargetable must refuse');
  assert.equal(isValidCastTarget(player, neutral), false, 'neutral is not hostile');
});

test('unit: computeApproachPoint stands off toward the caster along the line to the target', () => {
  const out = { x: 0, z: 0 };
  computeApproachPoint(0, 0, 10, 0, 2, out);
  assert.ok(Math.abs(out.x - 8) < 1e-9);
  assert.ok(Math.abs(out.z - 0) < 1e-9);

  // Already inside the standoff — do not overshoot past the caster.
  computeApproachPoint(0, 0, 1, 0, 2, out);
  assert.equal(out.x, 0);
  assert.equal(out.z, 0);
});

test('unit: weaponRangeOf falls back to the 1.4 m unarmed default (11-flows.md §3.6) when items is absent or the cache has no range', () => {
  assert.equal(weaponRangeOf(null, {}), 1.4);
  const items = { weaponOf: () => ({ _cache: { weapon: {} } }) };
  assert.equal(weaponRangeOf(items, {}), 1.4);
  const itemsWithRange = { weaponOf: () => ({ _cache: { weapon: { range: 1.9 } } }) };
  assert.equal(weaponRangeOf(itemsWithRange, {}), 1.9);
});

// --- Mode: none / self — one attempt, never repeats even when held -------

test('unit: mode "none" — one attempt regardless of held, never walks', () => {
  const def = { id: 'war_cry', target: 'none' };
  const actor = makeActor(1, 0, 0, 0);
  const player = makeFakePlayer(actor);
  const skills = makeFakeSkills(def, [{ ok: true, reason: null }]);
  const actors = makeFakeActors([]);

  const cc = new CastController();
  cc.beginOrder(0, def.id, def, 0, 0, 0);
  cc.step(player, { actors, skills, items: null, audio: null, held: true, shiftHeld: false, step: 0 });

  assert.equal(cc.active, false, 'one press = one use — must not stay active even though held=true');
  assert.equal(cc.lastResult, 'cast');
  assert.equal(skills.castCalls.length, 1);
  assert.equal(player.moveOrderCalls.length, 0);
});

test('unit: mode "self" — same one-shot behaviour as "none"', () => {
  const def = { id: 'iron_skin', target: 'self' };
  const actor = makeActor(1, 0, 0, 0);
  const player = makeFakePlayer(actor);
  const skills = makeFakeSkills(def, [{ ok: true, reason: null }]);
  const actors = makeFakeActors([]);

  const cc = new CastController();
  cc.beginOrder(0, def.id, def, 0, 0, 0);
  cc.step(player, { actors, skills, items: null, audio: null, held: true, shiftHeld: false, step: 0 });

  assert.equal(cc.active, false);
  assert.equal(cc.lastResult, 'cast');
});

test('unit: mode "self" refused (cooldown) never moves the character', () => {
  const def = { id: 'iron_skin', target: 'self' };
  const actor = makeActor(1, 5, 7, 0);
  const player = makeFakePlayer(actor);
  const skills = makeFakeSkills(def, [{ ok: false, reason: 'cooldown' }]);
  const actors = makeFakeActors([]);

  const cc = new CastController();
  cc.beginOrder(0, def.id, def, 0, 0, 0);
  const xBefore = actor.x;
  cc.step(player, { actors, skills, items: null, audio: null, held: false, shiftHeld: false, step: 0 });

  assert.equal(cc.lastResult, 'refused');
  assert.equal(cc.refusalReason, 'cooldown');
  assert.equal(actor.x, xBefore);
  assert.equal(player.moveOrderCalls.length, 0);
});

// --- Mode: point — walks only when def.range is declared and exceeded ----

test('unit: mode "point" with NO declared range — canCast never says no-path, casts immediately, no walk', () => {
  const def = { id: 'cleaving_strike', target: 'point' }; // no `range` field — matches the real skill
  const actor = makeActor(1, 0, 0, 0);
  const player = makeFakePlayer(actor);
  const skills = makeFakeSkills(def, [{ ok: true, reason: null }]);
  const actors = makeFakeActors([]);

  const cc = new CastController();
  cc.beginOrder(0, def.id, def, 50, 50, 0); // a point far away — irrelevant, no range declared
  cc.step(player, { actors, skills, items: null, audio: null, held: false, shiftHeld: false, step: 0 });

  assert.equal(cc.lastResult, 'cast');
  assert.equal(player.moveOrderCalls.length, 0, 'no range declared -> never walks, 05-skills.md §1.4');
});

test('unit: mode "point" WITH a declared range beyond it — walks toward the standoff point, then casts once in range', () => {
  const def = { id: 'stub_point_ranged', target: 'point', range: 6 };
  const actor = makeActor(1, 0, 0, 0);
  const player = makeFakePlayer(actor);
  const actors = makeFakeActors([]);

  // canCast keeps refusing 'no-path' until the actor is close enough —
  // scripted by hand since the mock has no real geometry.
  let dist = 10;
  const skills = {
    definition: () => def,
    canCast(a) {
      return dist > def.range ? { ok: false, reason: 'no-path' } : { ok: true, reason: null };
    },
    cast() {
      return true;
    },
    castCalls: [],
  };
  skills.cast = (a, id, x, z, t) => {
    skills.castCalls.push({ x, z, t });
    return true;
  };

  const cc = new CastController();
  cc.beginOrder(0, def.id, def, 10, 0, 0);

  // Step 1: out of range -> walks (moveOrder called), never casts.
  cc.step(player, { actors, skills, items: null, audio: null, held: true, shiftHeld: false, step: 0 });
  assert.equal(cc.lastResult, 'walking');
  assert.equal(player.moveOrderCalls.length, 1);
  assert.equal(skills.castCalls.length, 0);

  // Simulate arrival — now within range.
  dist = 5;
  cc.step(player, { actors, skills, items: null, audio: null, held: false, shiftHeld: false, step: 20 });
  assert.equal(cc.lastResult, 'cast');
  assert.equal(skills.castCalls.length, 1);
});

test('unit: mode "point" out of range WITH Shift held — refused out_of_range, never walks', () => {
  const def = { id: 'stub_point_ranged', target: 'point', range: 6 };
  const actor = makeActor(1, 0, 0, 0);
  const player = makeFakePlayer(actor);
  const actors = makeFakeActors([]);
  const skills = makeFakeSkills(def, [{ ok: false, reason: 'no-path' }]);

  const cc = new CastController();
  cc.beginOrder(0, def.id, def, 10, 0, 0);
  cc.step(player, { actors, skills, items: null, audio: null, held: false, shiftHeld: true, step: 0 });

  assert.equal(cc.lastResult, 'refused');
  assert.equal(cc.refusalReason, 'out_of_range');
  assert.equal(player.moveOrderCalls.length, 0, 'Shift held: nothing moves — 11-flows.md §5.2');
});

// --- Mode: actor — walks to weapon range, swings on arrival ---------------

test('unit: mode "actor" — invalid target (dead) refuses no-target, never walks', () => {
  const def = { id: 'rune_strike', target: 'actor' };
  const caster = makeActor(1, 0, 0, 0);
  const target = makeActor(2, 1, 3, 0);
  target.dead = true;
  const player = makeFakePlayer(caster);
  const actors = makeFakeActors([target]);
  const skills = makeFakeSkills(def, [{ ok: true, reason: null }]);

  const cc = new CastController();
  cc.beginOrder(0, def.id, def, target.x, target.z, target.id);
  cc.step(player, { actors, skills, items: null, audio: null, held: true, shiftHeld: false, step: 0 });

  assert.equal(cc.lastResult, 'refused');
  assert.equal(cc.refusalReason, 'no-target');
  assert.equal(player.moveOrderCalls.length, 0);
});

test('unit: mode "actor" — out of weapon range walks toward a standoff point, casts on arrival', () => {
  const def = { id: 'rune_strike', target: 'actor' };
  const caster = makeActor(1, 0, 0, 0);
  const target = makeActor(2, 1, 10, 0);
  const player = makeFakePlayer(caster);
  const actors = makeFakeActors([target]);
  const skills = makeFakeSkills(def, [{ ok: true, reason: null }]);
  const items = { weaponOf: () => null }; // -> weaponRangeOf falls back to 1.4 m

  const cc = new CastController();
  cc.beginOrder(0, def.id, def, target.x, target.z, target.id);
  cc.step(caster ? player : player, { actors, skills, items, audio: null, held: true, shiftHeld: false, step: 0 });

  assert.equal(cc.lastResult, 'walking');
  assert.equal(player.moveOrderCalls.length, 1);
  const dest = player.moveOrderCalls[0];
  // Standoff = range(1.4) - 0.10 = 1.3 m back from the target, along the line.
  assert.ok(Math.abs(dest.x - (10 - 1.3)) < 1e-9, `expected x ~8.7, got ${dest.x}`);

  // Move the caster to the destination and step again -> now in range, casts.
  caster.x = dest.x;
  cc.step(player, { actors, skills, items, audio: null, held: false, shiftHeld: false, step: 15 });
  assert.equal(cc.lastResult, 'cast');
  assert.equal(skills.castCalls.length, 1);
  assert.equal(skills.castCalls[0].targetId, target.id);
});

test('unit: mode "actor" chase hysteresis — does not re-issue moveOrder every step for a barely-moved target', () => {
  const def = { id: 'rune_strike', target: 'actor' };
  const caster = makeActor(1, 0, 0, 0);
  const target = makeActor(2, 1, 10, 0);
  const player = makeFakePlayer(caster);
  const actors = makeFakeActors([target]);
  const skills = makeFakeSkills(def, [{ ok: true, reason: null }]);
  const items = { weaponOf: () => null };

  const cc = new CastController();
  cc.beginOrder(0, def.id, def, target.x, target.z, target.id);
  cc.step(player, { actors, skills, items, audio: null, held: true, shiftHeld: false, step: 0 });
  assert.equal(player.moveOrderCalls.length, 1);

  // Target barely moves, few steps elapsed — hysteresis must suppress a re-order.
  target.x += 0.1;
  cc.step(player, { actors, skills, items, audio: null, held: true, shiftHeld: false, step: 1 });
  assert.equal(player.moveOrderCalls.length, 1, '11-flows.md §3.6: < 1.5 m and < 15 steps -> no repath');

  // Target moves far enough -> re-issues.
  target.x += 5;
  cc.step(player, { actors, skills, items, audio: null, held: true, shiftHeld: false, step: 2 });
  assert.equal(player.moveOrderCalls.length, 2);
});

test('unit: mode "actor" out of range WITH Shift held — refused out_of_range, never walks', () => {
  const def = { id: 'rune_strike', target: 'actor' };
  const caster = makeActor(1, 0, 0, 0);
  const target = makeActor(2, 1, 10, 0);
  const player = makeFakePlayer(caster);
  const actors = makeFakeActors([target]);
  const skills = makeFakeSkills(def, [{ ok: true, reason: null }]);

  const cc = new CastController();
  cc.beginOrder(0, def.id, def, target.x, target.z, target.id);
  cc.step(player, { actors, skills, items: null, audio: null, held: false, shiftHeld: true, step: 0 });

  assert.equal(cc.lastResult, 'refused');
  assert.equal(cc.refusalReason, 'out_of_range');
  assert.equal(player.moveOrderCalls.length, 0);
});

// --- Mode: direction — never walks, repeats in place ----------------------

test('unit: mode "direction" — never walks regardless of distance to the cursor', () => {
  const def = { id: 'flame_wave', target: 'direction' };
  const actor = makeActor(1, 0, 0, 0);
  const player = makeFakePlayer(actor);
  const skills = makeFakeSkills(def, [{ ok: true, reason: null }]);
  const actors = makeFakeActors([]);

  const cc = new CastController();
  cc.beginOrder(0, def.id, def, 999, 999, 0);
  cc.step(player, { actors, skills, items: null, audio: null, held: false, shiftHeld: false, step: 0 });

  assert.equal(cc.lastResult, 'cast');
  assert.equal(player.moveOrderCalls.length, 0);
});

test('unit: mode "direction" — repeats every step while held, stops the moment held goes false', () => {
  const def = { id: 'flame_wave', target: 'direction' };
  const actor = makeActor(1, 0, 0, 0);
  const player = makeFakePlayer(actor);
  const skills = makeFakeSkills(def, [{ ok: true, reason: null }]);
  const actors = makeFakeActors([]);

  const cc = new CastController();
  cc.beginOrder(0, def.id, def, 1, 0, 0);
  cc.step(player, { actors, skills, items: null, audio: null, held: true, shiftHeld: false, step: 0 });
  assert.equal(cc.active, true, 'held=true -> keeps repeating after a successful cast');
  cc.step(player, { actors, skills, items: null, audio: null, held: true, shiftHeld: false, step: 1 });
  assert.equal(skills.castCalls.length, 2);

  cc.step(player, { actors, skills, items: null, audio: null, held: false, shiftHeld: false, step: 2 });
  assert.equal(skills.castCalls.length, 3);
  assert.equal(cc.active, false, 'held went false -> stops after this attempt');
});

test('unit: cost is spent at cast start — CastController calls skills.cast() exactly once per successful attempt, never re-derives cost itself', () => {
  // This file never touches actors.spend/canAfford directly — cost timing
  // is entirely skills.cast()'s own job (05-skills.md §5.3 step 3; see
  // src/skills/impl/cleaving_strike.js's own precedent, and the
  // integration test below for a real, end-to-end resource-drop proof).
  const def = { id: 'ember_bolt', target: 'point' };
  const actor = makeActor(1, 0, 0, 0);
  const player = makeFakePlayer(actor);
  const skills = makeFakeSkills(def, [{ ok: true, reason: null }]);
  const actors = makeFakeActors([]);

  const cc = new CastController();
  cc.beginOrder(0, def.id, def, 5, 0, 0);
  cc.step(player, { actors, skills, items: null, audio: null, held: false, shiftHeld: false, step: 0 });

  assert.equal(skills.castCalls.length, 1);
  assert.deepEqual(skills.castCalls[0], { actor, skillId: 'ember_bolt', x: 5, z: 0, targetId: 0 });
});

// ===========================================================================
// Integration layer — real boot()
// ===========================================================================

test('integration: hotbar/setHotbar are real — createHotbar\'s own default shape, mutated in place', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');

  const initial = player.hotbar;
  assert.deepEqual(initial, createHotbar());

  player.setHotbar(0, 'cleaving_strike');
  assert.equal(player.hotbar.slots[0], 'cleaving_strike');
  assert.equal(player.hotbar, initial, 'setHotbar mutates the live Hotbar in place, never reallocates it');

  player.setHotbar(0, null);
  assert.equal(player.hotbar.slots[0], null);

  // Out-of-range / bad-type input is a silent no-op, not a throw.
  player.setHotbar(-1, 'x');
  player.setHotbar(4, 'x');
  player.setHotbar(1, 42);
  assert.deepEqual(player.hotbar.slots, [null, null, null, null]);
});

test('integration: hudState() reflects a real hotbar assignment and a real cooldownRemaining() — no longer force-zeroed', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const skills = ctx.get('skills');
  const actor = player.actor;

  skills.allocate(actor, 'cleaving_strike');
  player.setHotbar(2, 'cleaving_strike');

  const hud = player.hudState();
  assert.deepEqual(hud.hotbar, [null, null, 'cleaving_strike', null]);
  assert.deepEqual(hud.cooldowns, [0, 0, 0, 0], 'cleaving_strike has 0 cooldown — matches skills.cooldownRemaining()');
});

test('integration: castOrder — cost is spent at cast START, never at impact (cleaving_strike, rage)', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const actor = player.actor;
  actors.setState(actor, 'idle');

  skills.allocate(actor, 'cleaving_strike');
  player.setHotbar(0, 'cleaving_strike');
  actor.rage = 100;

  const rageBeforeCast = actor.rage;
  player.castOrder(0, actor.x + 3, actor.z, 0);
  // The controller is already `active` synchronously — nothing has run yet.
  assert.equal(actor.rage, rageBeforeCast, 'castOrder() itself must not spend — only the fixedUpdate step does');

  engine.frame(FIXED_DT); // one fixedUpdate tick: _followCast -> canCast -> cast() -> actors.spend, all before any hitframe/impact
  assert.ok(actor.rage < rageBeforeCast, 'rage must already be spent after ONE fixed step — before any hit resolves');
  assert.equal(player._castController.lastResult, 'cast');
});

test('integration: a refused cast (busy, mid-action) never moves the character', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const actor = player.actor;
  actors.setState(actor, 'idle');

  skills.allocate(actor, 'cleaving_strike');
  player.setHotbar(0, 'cleaving_strike');
  actor.rage = 100;

  player.castOrder(0, actor.x + 3, actor.z, 0);
  engine.frame(FIXED_DT); // succeeds, actor now mid-action (windup/active/recover)

  const xBefore = actor.x;
  const zBefore = actor.z;
  player.castOrder(0, actor.x + 5, actor.z + 5, 0); // a second attempt while busy
  engine.frame(FIXED_DT);

  assert.equal(player._castController.lastResult, 'refused');
  assert.equal(player._castController.refusalReason, 'busy');
  assert.equal(actor.x, xBefore);
  assert.equal(actor.z, zBefore);
});

test('integration: mode "actor" (rune_strike) walks to weapon range and casts on arrival, real physics/actors', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');

  const runeblade = actors.spawn({ kind: 'player', team: 0, archetypeId: 'runeblade', x: 0, z: 0, facing: 0 });
  player._actor = runeblade;
  actors.setState(runeblade, 'idle');
  skills.allocate(runeblade, 'rune_strike');
  player.setHotbar(0, 'rune_strike');

  const monster = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: 5, z: 0, facing: 0, level: 1 });
  runeblade.mana = 100;
  const manaBefore = runeblade.mana;

  player.castOrder(0, monster.x, monster.z, monster.id);
  engine.frame(FIXED_DT);
  assert.equal(player._castController.lastResult, 'walking', 'starts out of weapon range and must walk, not refuse');
  // The chase's own moveOrder() begins on THIS tick's ladder dispatch, after
  // `_followOrder` already ran for the tick — actual displacement shows up
  // starting the NEXT fixed step (same one-tick lag `tests/player/plyr1.
  // test.js`'s own click-to-move tests already account for).
  engine.frame(FIXED_DT);
  assert.ok(runeblade.x > 0, 'must actually be moving toward the target');

  let steps = 0;
  while (player._castController.active && steps < 600) {
    engine.frame(FIXED_DT);
    steps++;
  }
  assert.equal(player._castController.lastResult, 'cast');
  assert.ok(runeblade.mana < manaBefore, 'rune_strike costs mana — must have been spent on the successful cast');
});

test('integration: hoverTarget picks the nearest hostile actor under the cursor, ignores neutral/untargetable, 0 when none', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');

  assert.equal(player.hoverTarget, 0, 'nothing under the cursor at spawn (origin, nothing else there)');

  const monster = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: 10, z: 10, facing: 0, level: 1 });
  player._cursor.x = monster.x;
  player._cursor.z = monster.z;
  player._updateHoverTarget(ctx);
  assert.equal(player.hoverTarget, monster.id);

  // Move the cursor away — back to 0.
  player._cursor.x = 500;
  player._cursor.z = 500;
  player._updateHoverTarget(ctx);
  assert.equal(player.hoverTarget, 0);
});

test('integration: hoverTarget prefers a hostile actor over a closer neutral one under the cursor', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');

  const neutral = actors.spawn({ kind: 'npc', team: 2, archetypeId: 'bone_ranker', x: 10, z: 10, facing: 0, level: 1 });
  const hostile = actors.spawn({ kind: 'monster', team: 1, archetypeId: 'bone_ranker', x: 10.3, z: 10, facing: 0, level: 1 });

  player._cursor.x = 10;
  player._cursor.z = 10;
  player._updateHoverTarget(ctx);
  assert.equal(player.hoverTarget, hostile.id, 'hostile must win even though the neutral is centred exactly on the cursor');
  assert.notEqual(neutral.id, hostile.id);
});

test('O-78: a click while ui.pointerOverUi is true issues NO move order; the same click with it false does', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');
  const ui = ctx.get('ui');

  const sequenceBefore = player.intent.sequence;
  ui.__setPointerOverUiForTest ? ui.__setPointerOverUiForTest(true) : (ui._pointerOverUiLive = true);
  ctx.input._onPointerDown({ clientX: 900, clientY: 200, button: 0 });
  ctx.input._onPointerUp({ clientX: 900, clientY: 200, button: 0 });
  engine.frame(FIXED_DT);
  assert.equal(player.intent.sequence, sequenceBefore, 'pointerOverUi=true must drop the click entirely — no new order latched');
  assert.equal(player.intent.hasMoveOrder, false);

  ui.__setPointerOverUiForTest ? ui.__setPointerOverUiForTest(false) : (ui._pointerOverUiLive = false);
  ctx.input._onPointerDown({ clientX: 900, clientY: 200, button: 0 });
  ctx.input._onPointerUp({ clientX: 900, clientY: 200, button: 0 });
  engine.frame(FIXED_DT);
  assert.equal(player.intent.sequence, sequenceBefore + 1, 'pointerOverUi=false must latch the click normally');
  assert.equal(player.intent.hasMoveOrder, true);
});

test('O-78: also gates a cast trigger (RMB/1-4), not only plain move — same drop while pointerOverUi is true', async () => {
  const { engine, ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const ui = ctx.get('ui');
  const actor = player.actor;
  actors.setState(actor, 'idle');

  skills.allocate(actor, 'cleaving_strike');
  player.setHotbar(0, 'cleaving_strike');

  ui._pointerOverUiLive = true;
  const sequenceBefore = player.intent.sequence;
  ctx.input._onKeyDown({ code: 'Digit1', repeat: false });
  ctx.input._onKeyUp({ code: 'Digit1' });
  engine.frame(FIXED_DT);
  assert.equal(player.intent.sequence, sequenceBefore, 'digit-key cast trigger must also be dropped while over UI');
  assert.equal(player._castController.active, false);
});
