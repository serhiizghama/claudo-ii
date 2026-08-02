// tests/skills/mobility.test.js
//
// SKIL-8 acceptance tests for `src/skills/mobility.js` and the four cast
// handlers wired onto `src/skills/index.js` (`ram_charge`, `ashen_step`,
// `phase_leap`, `thunder_step`).
//
// Built against a REAL `boot()` (`src/main.js`) — same precedent
// `tests/skills/channel.test.js`/`cleaving_strike.test.js` already
// established: simulation is advanced by calling `actors.fixedUpdate()` +
// `skills.fixedUpdate()` directly, tick by tick, never a synchronous
// shortcut. `nav` is rebuilt once per test group against a wide, empty-
// footprint zone (`ctx.get('world').staticFootprints` is `[]` before any
// zone is entered, so `nav.rebuild({boundsMin/MaxX/Z})` produces a real,
// fully walkable grid over that box — verified directly against
// `src/nav/index.js#rebuild`/`resolveGridGeometry` before writing this file,
// not assumed) — this is what gives every "successful cast" test a real
// nav grid to clip against without needing a full `world.enterZone()`. The
// O-25 wall test adds a REAL `physics.addStatic` wall on top of that same
// open grid: `nav` never needs to know about the wall for that proof —
// `physics.sweepProjectile` alone is what must stop the dash (see that
// test's own comment for why testing it this way is still faithful to the
// M1 bug this ticket routes around).
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { cooldownOf } from '../../src/skills/cost.js';
import {
  unitTowards, clipDashTravel,
  RAM_CHARGE_DEF, ASHEN_STEP_DEF, PHASE_LEAP_DEF, THUNDER_STEP_DEF,
} from '../../src/skills/mobility.js';
import { NavSystem } from '../../src/nav/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { EventBus } from '../../src/core/events.js';

const H = 1 / 60;

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
const actors = ctx.get('actors');
const physics = ctx.get('physics');
const nav = ctx.get('nav');
const skills = ctx.get('skills');

// A wide, empty-footprint nav grid (no zone entered — `world.staticFootprints`
// is `[]`) so every test below has real walkable ground to work with, without
// needing `world.enterZone()`. Individual tests add their own `physics`
// statics on top for wall geometry; `nav` deliberately does NOT know about
// those statics (see the O-25 test's own comment).
nav.rebuild({ zoneId: 'mobility_test', boundsMinX: -150, boundsMaxX: 150, boundsMinZ: -150, boundsMaxZ: 150 });

function tick() {
  ctx.time.step++;
  actors.fixedUpdate(H, ctx);
  skills.fixedUpdate(H, ctx);
}

let nextZ = 0;
function lane() {
  nextZ += 12;
  return nextZ;
}

function spawnCaster(archetypeId, skillId, resourceField, resourceAmount, x, z) {
  const actor = actors.spawn({ kind: 'player', archetypeId, team: 0, x, z, facing: 0, level: 30 });
  actors.setState(actor, 'idle');
  actor.attributes.strength = 50;
  actor.attributes.dexterity = 60;
  actor.attributes.vitality = 50;
  skills.allocate(actor, skillId);
  actor[resourceField] = resourceAmount;
  return actor;
}

function spawnMonster(x, z, facing = Math.PI) {
  return actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x, z, facing, level: 1 });
}

// ---------------------------------------------------------------------------
// unitTowards — pure geometry helper
// ---------------------------------------------------------------------------

test('unitTowards: normal case is a real unit vector; degenerate (same point) is {0,0,0}, never NaN', () => {
  const out = { ux: 0, uz: 0, dist: 0 };
  unitTowards(0, 0, 3, 4, out);
  assert.ok(Math.abs(out.ux - 0.6) < 1e-9);
  assert.ok(Math.abs(out.uz - 0.8) < 1e-9);
  assert.ok(Math.abs(out.dist - 5) < 1e-9);

  unitTowards(2, 2, 2, 2, out);
  assert.equal(out.ux, 0);
  assert.equal(out.uz, 0);
  assert.equal(out.dist, 0);
  assert.ok(!Number.isNaN(out.ux) && !Number.isNaN(out.uz));
});

// ---------------------------------------------------------------------------
// O-25 — the proof, in the same shape as the bug that found it (M1: a raw
// 10 m moveTo tunnelling through a 2 m wall). `ram_charge` aims at a point
// well beyond a real physics wall; the charge must stop AT the wall, not
// appear behind it, and the arrival packet must still fire (a monster
// standing just short of the wall must take damage).
// ---------------------------------------------------------------------------

test('O-25 proof: ram_charge into a wall stops at the wall (never tunnels) and still detonates', () => {
  const z = lane();
  const caster = spawnCaster('ravager', 'ram_charge', 'rage', 100, 0, z);

  // A real static wall, 0.2 m thick, spanning the caster's whole approach —
  // the same order of magnitude as M1's own "10 m moveTo through a 2 m wall"
  // demonstration, just placed so a full-range ram_charge (9 m) would sail
  // straight through it under the old moveBody-based bug.
  const wallX = 5;
  physics.addStatic({ kind: 'box', x: wallX, z, halfW: 0.1, halfL: 5 }, 'stone');
  physics.rebuild();

  // A monster standing just in front of the wall, inside ram_charge's own
  // 1.8 m arrival radius of wherever the charge is forced to stop.
  const monster = spawnMonster(wallX - 0.3, z);
  const monsterStats = actors.stats(monster);
  monster.life = monsterStats.maxLife;

  const start = { x: caster.x, z: caster.z };
  const clickTarget = { x: 50, z }; // "beyond the wall" — far past it, capped to 9 m range regardless
  console.log(`[O-25] start=(${start.x},${start.z}) wall_near_face=(${wallX - 0.1},${z}) intended_click=(${clickTarget.x},${clickTarget.z})`);

  const ok = skills.cast(caster, 'ram_charge', clickTarget.x, clickTarget.z, undefined);
  console.log(`[O-25] actual_arrival=(${caster.x},${caster.z}) hit=${ok}`);

  assert.equal(ok, true, 'a charge with a real, reachable arrival point must succeed');
  // Never tunnels: the arrival must sit strictly on the near side of the
  // wall's own near face, never at/behind it.
  assert.ok(caster.x < wallX - 0.1, `charge must stop before the wall (x < ${wallX - 0.1}), got x=${caster.x}`);
  // And it travelled a REAL distance — not a degenerate zero-move refusal.
  assert.ok(caster.x > start.x + 1, `charge should have travelled several metres before the wall, got x=${caster.x}`);
  // Still detonates: the monster standing at the wall took damage.
  assert.ok(monster.life < monsterStats.maxLife, 'the arrival packet must still fire at the clipped stop point');
});

// ---------------------------------------------------------------------------
// Rule 12 — the sub-stepping is real, not decorative: when `nav` ALSO knows
// about the same wall (fed the identical Footprint, the same dual-consumer
// contract `world` gives `physics`/`nav` in production — `02-api-contracts.md`
// §4's own `Footprint` comment), the single-shot physics stop point is
// itself inside the wall's own (agent-radius-dilated) nav-blocked cell, and
// `clipDashTravel`'s backward walk must take a SECOND sample to find a
// genuinely walkable point — proven by counting, not assumed.
// ---------------------------------------------------------------------------

test('rule 12: the nav backward walk actually samples multiple points when the physics stop alone is not yet walkable', async () => {
  const wallFootprint = { kind: 'box', x: 5, z: 0, y: 0, height: 3, halfW: 0.1, halfL: 5, radius: 0, points: null, facing: 0, blocksNav: true, blocksSight: true };

  // A standalone real NavSystem, fed a stub `world` exposing the SAME
  // Footprint physics gets below — the exact `makeStubWorld`/`nav.rebuild()`
  // pattern `tests/nav/nav1.test.js` already established, reused here rather
  // than reinvented.
  const standaloneNav = new NavSystem();
  await standaloneNav.init({ events: new EventBus(), get: (id) => { if (id === 'world') return { staticFootprints: [wallFootprint], current: null }; throw new Error(`no ${id}`); } });
  standaloneNav.rebuild({ zoneId: 'substep_proof', boundsMinX: -50, boundsMaxX: 50, boundsMinZ: -50, boundsMaxZ: 50 });

  const standalonePhysics = new PhysicsSystem();
  await standalonePhysics.init({ events: new EventBus() });
  standalonePhysics.addStatic(wallFootprint, 'stone');
  standalonePhysics.rebuild();

  const actor = { x: 0, z: 0, radius: 0.36, id: 999 };
  const hitScratch = { hit: false, x: 0, z: 0, nx: 0, nz: 0, distance: 0, fraction: 0, surface: 'stone', actorId: 0, staticHandle: 0 };
  const navScratch = { x: 0, y: 0, z: 0 };
  const out = { x: 0, z: 0 };

  // The physics-only stop point (sweepProjectile against the actor's own
  // 0.36 m radius) sits inside the wall's dilated nav cell — sanity-check
  // this premise directly, so the test proves what it claims to.
  const physicsOnlyHit = standalonePhysics.sweepProjectile(actor.x, actor.z, 9, 0, actor.radius, standalonePhysics.MASK.WORLD, actor.id, { hit: false, x: 0, z: 0, nx: 0, nz: 0, distance: 0, fraction: 0, surface: 'stone', actorId: 0, staticHandle: 0 });
  assert.equal(physicsOnlyHit.hit, true);
  assert.equal(standaloneNav.walkable(physicsOnlyHit.x, physicsOnlyHit.z), false, 'sanity: the physics-only stop point must NOT yet be nav-walkable for this proof to mean anything');

  const result = clipDashTravel(standalonePhysics, standaloneNav, actor, 9, 0, hitScratch, navScratch, out);
  assert.ok(result, 'a walkable point must still be found further back along the ray');
  assert.equal(standaloneNav.walkable(result.x, result.z), true);
  assert.ok(result.x < physicsOnlyHit.x, 'the nav-clipped result must sit strictly further back than the physics-only stop');

  const samplesTaken = Math.round((physicsOnlyHit.x - result.x) / 0.25) + 1; // NAV_BACKSTEP_M, mirrored here for the count
  console.log(`[rule 12] physics-only stop=${physicsOnlyHit.x.toFixed(4)} nav-clipped result=${result.x.toFixed(4)} — backward samples taken=${samplesTaken}`);
  assert.ok(samplesTaken >= 2, `expected the backward walk to take at least 2 samples, counted ${samplesTaken}`);
});

test('O-25 proof: thunder_step into a wall stops at the wall and its nova still fires (shocked applied)', () => {
  const z = lane();
  const caster = spawnCaster('runeblade', 'thunder_step', 'mana', 100, 0, z);

  const wallX = 4;
  physics.addStatic({ kind: 'box', x: wallX, z, halfW: 0.1, halfL: 5 }, 'stone');
  physics.rebuild();

  const monster = spawnMonster(wallX - 0.5, z);
  // CMBT-10/D-59: `thunder_step`'s own `flatDamage` now actually reaches the
  // arrival packet (`src/combat/packet.js`'s B7, wired by that ticket — this
  // skill dealt exactly 0 lightning before it), so this monster no longer
  // survives the nova at its `composeStats()`-default `maxLife` (`1` — the
  // documented AI-3/AI-6 gap, "monster archetype stats never reach
  // composeStats", `combat/packet.js`'s ticket brief §"Project state you
  // must respect"). `applyStatusFromPacket` refuses a `target.dead` actor
  // (`src/combat/status.js:541`), so a one-HP monster would die on the SAME
  // hit that should carry `shocked`, and the assertion below would never see
  // it land. This test is about the nova firing at the clipped arrival
  // point, not about monster lethality, so give it real life first — same
  // "life doesn't matter here, don't let it die mid-proof" precedent this
  // file's own `ram_charge` O-25 test already sets (`monster.life =
  // monsterStats.maxLife`, a few lines above), just large enough to survive
  // a real hit rather than merely matching a `1`-HP default.
  monster.life = 100000;
  actors.stats(monster).maxLife = 100000;

  const ok = skills.cast(caster, 'thunder_step', 50, z, undefined);
  assert.equal(ok, true);
  assert.ok(caster.x < wallX - 0.1, `thunder_step must stop before the wall, got x=${caster.x}`);
  assert.ok(monster.life < 100000, 'sanity: the nova must have actually dealt damage at the clipped arrival point');
  assert.ok(actors.hasStatus(monster, 'shocked'), 'the nova at the clipped arrival point must still apply shocked');
});

// ---------------------------------------------------------------------------
// "Actors passed through during the dash are not hit" — a monster standing
// mid-path (not at the final arrival point) takes no damage from the charge.
// ---------------------------------------------------------------------------

test('ram_charge: a monster mid-path (outside the arrival radius) is not hit; only the arrival point resolves', () => {
  const z = lane();
  const caster = spawnCaster('ravager', 'ram_charge', 'rage', 100, 0, z);
  // Standing well short of the 9 m dash and well outside the 1.8 m arrival
  // radius of wherever the charge actually ends up.
  const bystander = spawnMonster(2, z);
  const bystanderStats = actors.stats(bystander);
  bystander.life = bystanderStats.maxLife;

  const ok = skills.cast(caster, 'ram_charge', 9, z, undefined);
  assert.equal(ok, true);
  assert.ok(Math.abs(caster.x - 2) > 1.8, 'sanity: the bystander must actually be outside the arrival radius');
  assert.equal(bystander.life, bystanderStats.maxLife, 'a body passed through mid-dash must take no damage');
});

// ---------------------------------------------------------------------------
// nav.snap's null contract — a refused cast never moves the character, and
// nothing is spent.
// ---------------------------------------------------------------------------

test('nav.snap null contract: an entirely blocked ray refuses ram_charge cleanly — no move, no spend, no throw', () => {
  // A tiny, DISTANT nav island the caster's own spawn point is not part of —
  // nav.walkable() at the caster's own position is therefore false, so the
  // backward ray walk (clipDashTravel) finds nothing anywhere along the ray,
  // all the way back to t=0. This is the real nav.snap(...)===null path.
  const isolatedNav = ctx.get('nav');
  const z = lane();
  isolatedNav.rebuild({ zoneId: 'isolated', boundsMinX: 9000, boundsMaxX: 9010, boundsMinZ: 9000, boundsMaxZ: 9010 });

  const caster = spawnCaster('ravager', 'ram_charge', 'rage', 100, 0, z);
  const rageBefore = caster.rage;
  const posBefore = { x: caster.x, z: caster.z };

  assert.equal(nav.walkable(caster.x, caster.z), false, 'sanity: the caster must be standing on unwalkable ground for this test');

  let threw = null;
  let ok;
  try {
    ok = skills.cast(caster, 'ram_charge', 9, z, undefined);
  } catch (e) {
    threw = e;
  }

  assert.equal(threw, null, 'nav.snap returning null must never throw');
  assert.equal(ok, false, 'the cast must be refused');
  assert.equal(caster.x, posBefore.x, 'a refused cast must never move the character (05 §1.4 rule 1)');
  assert.equal(caster.z, posBefore.z);
  assert.equal(caster.rage, rageBefore, 'nothing may be spent on a refused cast (05 §5.1: "refunds nothing because nothing was spent")');

  // Restore the wide, walkable grid for every test after this one.
  nav.rebuild({ zoneId: 'mobility_test_restored', boundsMinX: -150, boundsMaxX: 150, boundsMinZ: -150, boundsMaxZ: 150 });
});

test('clipDashTravel returns null directly when nothing is walkable anywhere along the ray', () => {
  const stubNav = {
    snap(x, z, maxRadius, out) {
      void x; void z; void maxRadius; void out;
      return null; // nothing is ever walkable
    },
  };
  const actor = { x: 0, z: 0, radius: 0.36, id: 1 };
  const hitScratch = { hit: false, x: 0, z: 0 };
  const navScratch = { x: 0, y: 0, z: 0 };
  const out = { x: 0, z: 0 };
  const result = clipDashTravel(null, stubNav, actor, 5, 0, hitScratch, navScratch, out);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// S4 — the four cooldown floors, printed at the level where each binds
// (`cooldownOf` is pure, already proven correct at the data level by
// `tests/skills/cost.test.js`'s own S4 sweep — this proves THIS ticket's
// four handlers are wired to read the SAME data, end to end, via a real
// skills.cast() + skills.cooldownRemaining()).
// ---------------------------------------------------------------------------

test('S4 — the four named cooldown floors bind at deep +skills levels', () => {
  const EPS = 1e-6;
  const cases = [
    [RAM_CHARGE_DEF, 4.0, 21],
    [ASHEN_STEP_DEF, 1.8, 21],
    [PHASE_LEAP_DEF, 2.5, 23],
    [THUNDER_STEP_DEF, 3.0, 21],
  ];
  for (const [def, floor, bindLevel] of cases) {
    const atBind = cooldownOf(def, bindLevel);
    const at40 = cooldownOf(def, 40);
    console.log(`[S4] ${def.id}: L${bindLevel}=${atBind}s L40=${at40}s floor=${floor}s`);
    assert.ok(Math.abs(atBind - floor) < EPS, `${def.id} L${bindLevel} should sit at its floor ${floor}, got ${atBind}`);
    assert.ok(Math.abs(at40 - floor) < EPS, `${def.id} L40 should still sit at its floor ${floor}, got ${at40}`);
  }
});

test('S4 end-to-end: a real ram_charge cast starts a cooldown that never reads below its 4.0 s floor', () => {
  const z = lane();
  const caster = spawnCaster('ravager', 'ram_charge', 'rage', 1000, 0, z);
  // spawnCaster already spent 1 point; spend the remaining 19 to max the
  // allocated level at 20, then push past the floor's own binding point
  // (21) via skillBonuses — the same +skills mechanism
  // `skills.effectiveLevel`'s own contract allows — to reach 40.
  for (let i = 0; i < 19; i++) skills.allocate(caster, 'ram_charge');
  caster.stats.skillBonuses = { all: 20, tree: {}, skill: {} };
  assert.equal(skills.effectiveLevel(caster, 'ram_charge'), 40);

  const ok = skills.cast(caster, 'ram_charge', 3, z, undefined);
  assert.equal(ok, true);
  const remaining = skills.cooldownRemaining(caster, 'ram_charge');
  console.log(`[S4 end-to-end] ram_charge L40 cooldownRemaining right after cast = ${remaining}s (floor 4.0s)`);
  assert.ok(remaining <= 4.0 + 1 / 60 && remaining > 3.9, `expected ~4.0s (the floor), got ${remaining}`);
});

// ---------------------------------------------------------------------------
// ashen_step — zero damage at every level, blinks, respects the same nav
// contract.
// ---------------------------------------------------------------------------

test('ashen_step: blinks toward the cursor, deals no damage, and does not throw with nothing nearby', () => {
  const z = lane();
  const caster = spawnCaster('emberwright', 'ashen_step', 'mana', 100, 0, z);
  const start = { x: caster.x, z: caster.z };

  const ok = skills.cast(caster, 'ashen_step', 8, z, undefined);
  assert.equal(ok, true);
  assert.ok(caster.x > start.x, 'the actor must have actually moved toward the cursor');
  assert.ok(caster.x <= 8 + 1e-6, 'never past the requested point');
});

// ---------------------------------------------------------------------------
// phase_leap — far-side landing, and the strike resolves one fixed step
// after the teleport, not synchronously inside cast().
// ---------------------------------------------------------------------------

test('phase_leap: always lands on the target\'s far side, and the strike resolves on the NEXT fixed step', () => {
  const z = lane();
  const caster = spawnCaster('runeblade', 'phase_leap', 'mana', 100, 0, z);
  const target = spawnMonster(5, z);
  const targetStats = actors.stats(target);
  target.life = targetStats.maxLife;

  console.log(`[phase_leap] caster=(${caster.x},${caster.z}) target=(${target.x},${target.z})`);
  const ok = skills.cast(caster, 'phase_leap', 5, z, target.id);
  assert.equal(ok, true);
  console.log(`[phase_leap] arrival=(${caster.x},${caster.z})`);

  // Far side: the caster approached from -x, so "far side" is past the
  // target along +x.
  assert.ok(caster.x > target.x, `arrival must be on the target's far side (x > ${target.x}), got x=${caster.x}`);

  // Not resolved yet — the strike is scheduled for the NEXT fixed step.
  assert.equal(target.life, targetStats.maxLife, 'the strike must not resolve synchronously inside cast()');

  tick();
  assert.ok(target.life < targetStats.maxLife, 'the strike must resolve on the next fixed step');
});

test('phase_leap: refuses beyond its 10 m range without moving or spending', () => {
  const z = lane();
  const caster = spawnCaster('runeblade', 'phase_leap', 'mana', 100, 0, z);
  const target = spawnMonster(20, z); // > 10 m teleportRangeM
  const manaBefore = caster.mana;
  const posBefore = { x: caster.x, z: caster.z };

  const ok = skills.cast(caster, 'phase_leap', 20, z, target.id);
  assert.equal(ok, false);
  assert.equal(caster.x, posBefore.x);
  assert.equal(caster.z, posBefore.z);
  assert.equal(caster.mana, manaBefore);
});
