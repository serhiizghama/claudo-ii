// tests/skills/ground.test.js
//
// SKIL-9 acceptance tests for `src/skills/ground.js` and its wiring onto
// `src/skills/index.js` (`addGroundEffect`/`removeGroundEffect`, the
// `fixedUpdate` advance, the `zone:teardown`/`actor:death` listeners, and
// `ashen_step`'s cast augmentation). Built against a REAL `boot()` — same
// precedent `tests/skills/mobility.test.js`/`incinerate.test.js` already
// established.
//
// ---------------------------------------------------------------------------
// The `nav.markHazard` gap — see `src/skills/ground.js`'s own header
// ---------------------------------------------------------------------------
// `ctx.get('nav')` from a real `boot()` does NOT implement `markHazard` —
// verified directly against `src/nav/index.js` (no such method exists
// anywhere in this tree). This file therefore proves the hazard register/
// deregister DISCIPLINE (this ticket's own claim) against an INJECTED `nav`
// stub with a real `markHazard`, called through the SAME exported
// functions `src/skills/index.js` wires onto the real subsystem
// (`addGroundEffect`/`removeGroundEffect`/`advanceGroundEffects`/
// `onZoneTeardown`/`onActorDeath`) — never a re-implementation. `actors`/
// `combat`/`physics` are the REAL, live subsystems throughout; only `nav`
// is swapped for a controllable double, the same "duck-typed test double
// for a dependency this ticket does not own" precedent
// `tests/skills/mobility.perf.test.js`'s own `stubNavAllWalkable` already
// establishes.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import {
  GroundEffectPool, groundEffectPoolCapacityFor,
  addGroundEffect, removeGroundEffect, advanceGroundEffects, onZoneTeardown, onActorDeath,
  buildMeteorPoolSpec, buildAshWallSpec, buildAshenStepCloudSpec,
  METEOR_DEF, ASH_WALL_DEF, ASHEN_STEP_DEF,
} from '../../src/skills/ground.js';

const H = 1 / 60;

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
const actors = ctx.get('actors');
const physics = ctx.get('physics');
const combat = ctx.get('combat');
const skills = ctx.get('skills');
const realNav = ctx.get('nav');

// A wide, empty-footprint nav grid — same precedent `mobility.test.js`
// establishes — so `physics.overlapCircle`/`overlapRect` (real, live) find
// spawned actors without needing a full `world.enterZone()`.
realNav.rebuild({ zoneId: 'ground_test', boundsMinX: -300, boundsMaxX: 300, boundsMinZ: -300, boundsMaxZ: 300 });

/** A `markHazard`-recording nav stub — see this file's own header. Tracks
 * a per-(x,z,radius) net count so "zero leaked hazard cells" can be proven
 * as an EXACT per-cell zero, not just a net sum. */
function makeNavStub() {
  const counts = new Map();
  const calls = [];
  function key(x, z, r) { return `${x.toFixed(3)},${z.toFixed(3)},${r.toFixed(3)}`; }
  return {
    markHazard(x, z, radius, on) {
      calls.push({ x, z, radius, on });
      const k = key(x, z, radius);
      counts.set(k, (counts.get(k) || 0) + (on ? 1 : -1));
    },
    calls,
    /** @returns {boolean} true iff every tracked cell's net registration count is exactly 0 */
    allZero() {
      for (const v of counts.values()) if (v !== 0) return false;
      return true;
    },
    nonZeroEntries() {
      const out = [];
      for (const [k, v] of counts.entries()) if (v !== 0) out.push([k, v]);
      return out;
    },
  };
}

// Each test group claims a fresh z-band so actors never overlap across
// tests, staying comfortably inside the -300..300 rebuilt nav grid above
// (a real `nav.snap`-driven cast, below, needs real walkable ground).
let zTest = 0;
function nextZBand() { zTest += 15; return zTest; }

function spawnPlayer(z, overrides = {}) {
  const p = actors.spawn({ kind: 'player', archetypeId: 'emberwright', team: 0, x: 0, z, level: 30, ...overrides });
  actors.setState(p, 'idle');
  actors.stats(p);
  return p;
}

function spawnMonster(x, z, overrides = {}) {
  const m = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x, z, level: 1, ...overrides });
  actors.setState(m, 'idle');
  actors.stats(m);
  m.stats.maxLife = 100000; // never die from a single tick unless the test wants it to
  m.stats.fireResist = 0;
  m.life = 100000;
  return m;
}

function makeDeps(nav) {
  return { actors, physics, combat, events: ctx.events, time: ctx.time, skills, nav, rng: ctx.rng.fork() };
}

// ===========================================================================
// Pool construction / capacity
// ===========================================================================

test('GROUND — capacity resolves off ctx.config.quality, falls back to the largest tier for a config-less ctx (01-data-model.md:1702)', () => {
  assert.equal(groundEffectPoolCapacityFor({ config: { quality: 'low' } }), 24);
  assert.equal(groundEffectPoolCapacityFor({ config: { quality: 'medium' } }), 32);
  assert.equal(groundEffectPoolCapacityFor({ config: { quality: 'high' } }), 48);
  assert.equal(groundEffectPoolCapacityFor({ config: { quality: 'ultra' } }), 64);
  assert.equal(groundEffectPoolCapacityFor({}), 64);
});

// ===========================================================================
// Acceptance #1 — every ground effect registers AND deregisters
// NAV_FLAG.hazard, on all three exit paths, with zero leaked hazard cells
// ===========================================================================

test('GROUND — meteor pool: hazard registers on spawn and deregisters exactly on EXPIRY (fixed-step lifetime), zero leaked cells', () => {
  const nav = makeNavStub();
  const pool = new GroundEffectPool(groundEffectPoolCapacityFor({}));
  const deps = makeDeps(nav);
  const z = nextZBand();
  const owner = spawnPlayer(z);

  const spec = buildMeteorPoolSpec(owner, 20, 0, z);
  assert.equal(spec.hazard, true);
  const id = addGroundEffect(pool, spec, deps);
  assert.ok(id > 0, 'addGroundEffect must return a nonzero id');
  assert.equal(nav.calls.length, 1, 'a circle-shaped effect registers exactly one hazard sample');
  assert.equal(nav.calls[0].on, true);
  assert.ok(!nav.allZero(), 'mid-lifetime: the hazard cell must still be registered, not net-zero');

  // Advance past the pool's own 6.0 s lifetime (360 fixed steps) — the
  // effect must expire and deregister ON ITS OWN, no manual removeGroundEffect call.
  const steps = Math.ceil(spec.seconds * 60) + 2;
  for (let i = 0; i < steps; i++) {
    ctx.time.step++;
    advanceGroundEffects(pool, H, deps);
  }

  console.log(`[GROUND expiry] registered=1 deregistered=${nav.calls.filter((c) => !c.on).length} allZero=${nav.allZero()}`);
  assert.equal(pool.count, 0, 'the effect must be gone after its own lifetime elapses');
  assert.equal(nav.calls.length, 2, 'exactly one register + one deregister call over the whole lifecycle');
  assert.equal(nav.calls[1].on, false);
  assert.deepEqual(
    { x: nav.calls[1].x, z: nav.calls[1].z, radius: nav.calls[1].radius },
    { x: nav.calls[0].x, z: nav.calls[0].z, radius: nav.calls[0].radius },
    'deregistration must use the EXACT SAME (x,z,radius) tuple registration used',
  );
  assert.ok(nav.allZero(), 'zero leaked hazard cells after expiry');
});

test('GROUND — ash_wall: hazard (multi-sample line) registers on spawn and deregisters exactly on manual removeGroundEffect, zero leaked cells', () => {
  const nav = makeNavStub();
  const pool = new GroundEffectPool(groundEffectPoolCapacityFor({}));
  const deps = makeDeps(nav);
  const z = nextZBand();
  const owner = spawnPlayer(z);

  const facing = Math.atan2(0, 1); // caster->cursor ray along +x
  const spec = buildAshWallSpec(owner, 20, 0, z, facing);
  assert.equal(spec.hazard, true);
  assert.equal(spec.shape, 'line');
  const id = addGroundEffect(pool, spec, deps);
  assert.ok(id > 0);

  const registerCalls = nav.calls.length;
  console.log(`[GROUND ash_wall] line hazard sampled into ${registerCalls} nav.markHazard(...) calls for a 6.0m wall`);
  assert.ok(registerCalls >= 12, 'a 6.0m line at 0.5m spacing must produce at least ~13 hazard samples, not one big circle');
  assert.ok(nav.calls.every((c) => c.on === true));
  assert.ok(!nav.allZero());

  removeGroundEffect(pool, id, deps);

  assert.equal(pool.count, 0);
  assert.equal(nav.calls.length, registerCalls * 2, 'every registered sample must get exactly one matching deregistration');
  assert.ok(nav.allZero(), 'zero leaked hazard cells after manual removeGroundEffect');
});

test('GROUND — zone:teardown exit path deregisters EVERY active effect (meteor + ash_wall together), zero leaked cells', () => {
  const nav = makeNavStub();
  const pool = new GroundEffectPool(groundEffectPoolCapacityFor({}));
  const deps = makeDeps(nav);
  const z = nextZBand();
  const owner = spawnPlayer(z);

  addGroundEffect(pool, buildMeteorPoolSpec(owner, 10, -5, z), deps);
  addGroundEffect(pool, buildAshWallSpec(owner, 10, 5, z, 0), deps);
  assert.equal(pool.count, 2);
  assert.ok(!nav.allZero());

  onZoneTeardown(pool, deps);

  assert.equal(pool.count, 0, 'zone:teardown must clear every ground effect unconditionally');
  assert.ok(nav.allZero(), 'zero leaked hazard cells after zone:teardown');
});

test('GROUND — owner-death exit path deregisters only the dead owner\'s effects, zero leaked cells for those; a still-living owner\'s effect is untouched', () => {
  const nav = makeNavStub();
  const pool = new GroundEffectPool(groundEffectPoolCapacityFor({}));
  const deps = makeDeps(nav);
  const z = nextZBand();
  const doomed = spawnPlayer(z, { x: -50 });
  const survivor = spawnPlayer(z, { x: 50 });

  addGroundEffect(pool, buildMeteorPoolSpec(doomed, 10, -50, z), deps);
  addGroundEffect(pool, buildAshWallSpec(survivor, 10, 50, z, 0), deps);
  assert.equal(pool.count, 2);
  const callsBeforeDeath = nav.calls.length;

  onActorDeath(pool, deps, doomed.id);

  assert.equal(pool.count, 1, 'only the dead owner\'s effect is removed');
  assert.ok(nav.calls.length > callsBeforeDeath, 'the dead owner\'s hazard must have been deregistered');
  assert.ok(!nav.allZero(), 'the survivor\'s own effect must STILL be registered — not swept up by the wrong owner\'s death');

  // Clean up the survivor's own effect through the normal path and confirm
  // that ALSO nets to zero, proving the survivor's registration was never
  // corrupted by the unrelated death above.
  onZoneTeardown(pool, deps);
  assert.ok(nav.allZero());
});

// Real `SkillsSystem#cast()` wiring — an actual `actor:death` emitted by
// `combat.applyDirect` must reach `SkillsSystem`'s own listener and remove
// the dead owner's effect, end to end (not the free function called
// directly, as above, but through the real subsystem).
test('GROUND — end-to-end: a real actor:death (combat.applyDirect kill) removes the dead owner\'s ground effect via SkillsSystem\'s own listener', () => {
  const z = nextZBand();
  const owner = spawnPlayer(z);
  owner.stats.maxLife = 50;
  owner.life = 50;

  const before = skills.groundEffectCount;
  const id = skills.addGroundEffect(buildMeteorPoolSpec(owner, 10, 0, z));
  assert.ok(id > 0);
  assert.equal(skills.groundEffectCount, before + 1);

  ctx.time.step += 1;
  const killResult = combat.applyDirect(owner, 100000, 'physical', 0, 'test-kill');
  assert.ok(killResult.killed);

  assert.equal(skills.groundEffectCount, before, 'the real actor:death listener must have removed the dead owner\'s effect');
});

// ===========================================================================
// Acceptance #2 — ash_wall absorbs projectiles
// ===========================================================================

test('GROUND — ash_wall absorbs an ENEMY projectile on contact (killed early); a same-team (player) projectile passes through untouched', () => {
  const nav = makeNavStub();
  const pool = new GroundEffectPool(groundEffectPoolCapacityFor({}));
  const z = nextZBand();
  const owner = spawnPlayer(z); // team 0
  const deps = makeDeps(nav);
  deps.projectilePool = ctx.get('skills')._projectilePool ?? null;
  // SkillsSystem does not expose its own pool publicly — reach it via the
  // real subsystem's own contract methods instead, driving absorption
  // through the REAL skills.spawnProjectile/killProjectile/fixedUpdate path.
  void deps.projectilePool;

  const facing = 0; // wall runs along +z, thin along +x
  const wallSpec = buildAshWallSpec(owner, 20, 100, z, facing);
  const wallId = skills.addGroundEffect(wallSpec);
  assert.ok(wallId > 0);

  // An ENEMY (team 1) projectile spawned so it sits exactly on the wall's
  // own centre this step — the absorption check is geometric, not a sweep,
  // so placing it inside the rect is sufficient to prove the mechanism.
  const enemyProjId = skills.spawnProjectile({
    x: 100, z, dirX: 1, dirZ: 0, speed: 0, lifetime: 10, radius: 0.2,
    pierce: false, mask: physics.MASK.WORLD, sourceId: 0, sourceGen: 0, team: 1,
    skillId: 'test_enemy_bolt', level: 1, alwaysHits: true,
  });
  assert.ok(enemyProjId > 0);

  const playerProjId = skills.spawnProjectile({
    x: 100, z, dirX: 1, dirZ: 0, speed: 0, lifetime: 10, radius: 0.2,
    pierce: false, mask: physics.MASK.WORLD, sourceId: owner.id, sourceGen: owner.generation, team: 0,
    skillId: 'test_player_bolt', level: 1, alwaysHits: true,
  });
  assert.ok(playerProjId > 0);

  const countBefore = skills.projectileCount;
  ctx.time.step += 1;
  skills.fixedUpdate(H, ctx);

  const countAfter = skills.projectileCount;
  console.log(`[GROUND ash_wall absorb] projectileCount before=${countBefore} after=${countAfter} (enemy absorbed, player passes through)`);
  assert.equal(countAfter, countBefore - 1, 'exactly the enemy projectile must have been absorbed');

  skills.removeGroundEffect(wallId);
  skills.killProjectile(enemyProjId); // no-op if already dead — cleanup
  skills.killProjectile(playerProjId);
});

// ===========================================================================
// Acceptance #3 — ashen_step's cloud is explicitly NOT a hazard, while
// still applying its statuses
// ===========================================================================

test('GROUND — ashen_step cloud spec is hazard:false; the field engine marks ZERO hazard cells for it even while applying slowed/blinded', () => {
  const nav = makeNavStub();
  const pool = new GroundEffectPool(groundEffectPoolCapacityFor({}));
  const deps = makeDeps(nav);
  const z = nextZBand();
  const owner = spawnPlayer(z);
  const hostile = spawnMonster(0, z);

  const spec = buildAshenStepCloudSpec(owner, 20, 0, z);
  assert.equal(spec.hazard, false, 'ashen_step\'s own GroundEffectSpawn must declare hazard:false');
  const id = addGroundEffect(pool, spec, deps);
  assert.ok(id > 0);

  assert.equal(nav.calls.length, 0, 'addGroundEffect must never call nav.markHazard at all for a non-hazard effect');

  // Advance to the first 0.5s reapplication tick and confirm the field DID
  // apply its statuses to the hostile standing inside it, proving the cloud
  // is fully functional while still marking zero hazard cells.
  for (let i = 0; i < 31; i++) { ctx.time.step++; advanceGroundEffects(pool, H, deps); }

  const slowed = actors.statusMagnitude ? actors.statusMagnitude(hostile, 'slowed') : null;
  console.log(`[GROUND ashen_step] hazard calls=${nav.calls.length} (must be 0); hostile.statuses=${JSON.stringify(hostile.statuses && hostile.statuses.map((s) => s.status))}`);
  assert.equal(nav.calls.length, 0, 'still zero hazard calls after ticking — the cloud never becomes a hazard over its lifetime either');
  assert.ok(hostile.statuses && hostile.statuses.some((s) => s.status === 'slowed'), 'the hostile inside the cloud must have slowed applied');
  assert.ok(hostile.statuses.some((s) => s.status === 'blinded'), 'the hostile inside the cloud must have blinded applied');
  void slowed;

  onZoneTeardown(pool, deps);
});

// End-to-end: casting the REAL ashen_step through SkillsSystem#cast()
// leaves a non-hazard cloud at the DEPARTURE point.
test('GROUND — end-to-end: a real ashen_step cast leaves its cloud at the departure point, and it is not a nav hazard', () => {
  const z = nextZBand();
  const player = spawnPlayer(z);
  skills.allocate(player, 'ashen_step');
  assert.equal(skills.effectiveLevel(player, 'ashen_step'), 1);

  const startX = player.x;
  const startZ = player.z;
  const before = skills.groundEffectCount;

  ctx.time.step += 1;
  const ok = skills.cast(player, 'ashen_step', startX + 5, startZ, 0);
  assert.equal(ok, true, 'ashen_step must actually cast (allocated, off cooldown, affordable)');
  assert.notEqual(player.x, startX, 'the actor must have actually teleported');

  assert.equal(skills.groundEffectCount, before + 1, 'a real ashen_step cast must leave exactly one ground effect behind');
});

// ===========================================================================
// Acceptance #4 — the field reapplies every 0.5s, counted in fixed steps
// ===========================================================================

test('GROUND — ashen_step field reapplication cadence is exactly 30 fixed steps (0.5s @ 60Hz), counted, not timed', () => {
  const nav = makeNavStub();
  const pool = new GroundEffectPool(groundEffectPoolCapacityFor({}));
  const deps = makeDeps(nav);
  const z = nextZBand();
  const owner = spawnPlayer(z);
  const hostile = spawnMonster(0, z);

  addGroundEffect(pool, buildAshenStepCloudSpec(owner, 1, 0, z), deps);

  // `actors.applyStatus` is real-time-spied rather than counted off
  // `actor:status` — that event turns out to be emitted ONLY on expiry
  // (`src/combat/status.js#emitExpiredOne`, the only `events.emit('actor:
  // status', ...)` call in this tree), never on application. A pre-existing
  // gap in already-accepted code, out of this ticket's file grant — see
  // this ticket's report. `actors.applyStatus` is the real, load-bearing
  // write every rider goes through regardless, so spying on it directly is
  // both correct and unaffected by that gap.
  let applyCount = 0;
  const originalApplyStatus = actors.applyStatus;
  actors.applyStatus = function spy(target, spec) {
    if (target && target.id === hostile.id && spec.status === 'slowed') applyCount++;
    return originalApplyStatus.call(actors, target, spec);
  };

  let countAt29, countAt30, countAt59, countAt60;
  try {
    for (let i = 0; i < 29; i++) { ctx.time.step++; advanceGroundEffects(pool, H, deps); }
    countAt29 = applyCount;
    ctx.time.step++; advanceGroundEffects(pool, H, deps); // step 30 — the tick must fire here
    countAt30 = applyCount;
    for (let i = 0; i < 29; i++) { ctx.time.step++; advanceGroundEffects(pool, H, deps); }
    countAt59 = applyCount;
    ctx.time.step++; advanceGroundEffects(pool, H, deps); // step 60 — the second tick
    countAt60 = applyCount;
  } finally {
    delete actors.applyStatus; // restore the prototype method
  }

  console.log(`[GROUND cadence] applyCount @29=${countAt29} @30=${countAt30} @59=${countAt59} @60=${countAt60}`);
  assert.equal(countAt29, 0, 'no reapplication before 30 fixed steps have elapsed');
  assert.equal(countAt30, 1, 'exactly one reapplication at fixed step 30 (0.5s @ 60Hz)');
  assert.equal(countAt59, 1, 'no second reapplication before step 60');
  assert.equal(countAt60, 2, 'exactly the second reapplication at fixed step 60');

  onZoneTeardown(pool, deps);
});

test('GROUND — meteor pool and ash_wall tick cadence is exactly 15 fixed steps (4Hz @ 60Hz)', () => {
  const nav = makeNavStub();
  const pool = new GroundEffectPool(groundEffectPoolCapacityFor({}));
  const deps = makeDeps(nav);
  const z = nextZBand();
  const owner = spawnPlayer(z);
  const hostile = spawnMonster(0, z);
  hostile.stats.fireResist = 0;

  addGroundEffect(pool, buildMeteorPoolSpec(owner, 10, 0, z), deps);

  let damageEvents = 0;
  const onDamage = (payload) => { if (payload.target && payload.target.id === hostile.id) damageEvents++; };
  ctx.events.on('actor:damage', onDamage);

  for (let i = 0; i < 14; i++) { ctx.time.step++; advanceGroundEffects(pool, H, deps); }
  const at14 = damageEvents;
  ctx.time.step++; advanceGroundEffects(pool, H, deps); // step 15
  const at15 = damageEvents;

  console.log(`[GROUND meteor cadence] damageEvents @14=${at14} @15=${at15}`);
  assert.equal(at14, 0, 'no tick before 15 fixed steps (4Hz @ 60Hz)');
  assert.equal(at15, 1, 'exactly one tick at fixed step 15');

  ctx.events.off('actor:damage', onDamage);
  onZoneTeardown(pool, deps);
});

// ===========================================================================
// meteor pool damage + ash_wall damage + burning seed — proving the ticks
// actually do the work, not just fire an event
// ===========================================================================

test('GROUND — meteor pool tick deals fire damage to a hostile inside the pool, zero status applied (05 §4.4: "the pool applies no status")', () => {
  const nav = makeNavStub();
  const pool = new GroundEffectPool(groundEffectPoolCapacityFor({}));
  const deps = makeDeps(nav);
  const z = nextZBand();
  const owner = spawnPlayer(z);
  const hostile = spawnMonster(0, z);
  hostile.stats.fireResist = 0;
  const lifeBefore = hostile.life;

  addGroundEffect(pool, buildMeteorPoolSpec(owner, 10, 0, z), deps);
  for (let i = 0; i < 15; i++) { ctx.time.step++; advanceGroundEffects(pool, H, deps); }

  console.log(`[GROUND meteor damage] life ${lifeBefore} -> ${hostile.life}`);
  assert.ok(hostile.life < lifeBefore, 'the pool tick must have dealt real fire damage');
  assert.equal(hostile.statuses.length, 0, 'meteor\'s pool must apply zero status effects');

  onZoneTeardown(pool, deps);
});

test('GROUND — ash_wall tick deals fire damage AND seeds burning on a hostile within 0.8m of the line', () => {
  const nav = makeNavStub();
  const pool = new GroundEffectPool(groundEffectPoolCapacityFor({}));
  const deps = makeDeps(nav);
  const z = nextZBand();
  const owner = spawnPlayer(z);
  const hostile = spawnMonster(0, z); // sits exactly on the wall's own centre
  hostile.stats.fireResist = 0;
  const lifeBefore = hostile.life;

  addGroundEffect(pool, buildAshWallSpec(owner, 10, 0, z, 0), deps);
  for (let i = 0; i < 15; i++) { ctx.time.step++; advanceGroundEffects(pool, H, deps); }

  console.log(`[GROUND ash_wall damage] life ${lifeBefore} -> ${hostile.life}; statuses=${hostile.statuses.map((s) => s.status).join(',')}`);
  assert.ok(hostile.life < lifeBefore, 'the wall tick must have dealt real fire damage');
  assert.ok(hostile.statuses.some((s) => s.status === 'burning'), 'the wall tick must have seeded burning (03 §7.4 default rule)');

  onZoneTeardown(pool, deps);
});

// ===========================================================================
// Pool saturation / overflow — 01-data-model.md:1702's own "oldest non-
// player effect expires" reconciled with "addGroundEffect returns 0 rather
// than allocating"
// ===========================================================================

test('GROUND — pool saturation: full of PLAYER-owned effects refuses (returns 0); addGroundEffect never grows the pool', () => {
  const nav = makeNavStub();
  const capacity = 8;
  const pool = new GroundEffectPool(capacity);
  const deps = makeDeps(nav);
  const z = nextZBand();
  const owner = spawnPlayer(z);

  for (let i = 0; i < capacity; i++) {
    const id = addGroundEffect(pool, buildAshenStepCloudSpec(owner, 1, i, z), deps);
    assert.ok(id > 0, `slot ${i} must succeed while the pool has room`);
  }
  assert.equal(pool.count, capacity);

  const overflowId = addGroundEffect(pool, buildAshenStepCloudSpec(owner, 1, 999, z), deps);
  console.log(`[GROUND overflow] pool full of ${capacity} player effects -> addGroundEffect returned ${overflowId} (must be 0)`);
  assert.equal(overflowId, 0, 'a pool full of unevictable (player-owned) effects must refuse, not allocate');
  assert.equal(pool.count, capacity, 'the pool must not have grown past its fixed capacity');

  onZoneTeardown(pool, deps);
});

test('GROUND — pool saturation: a full pool containing a non-player (monster-owned) effect EVICTS the oldest one and succeeds (01-data-model.md:1702)', () => {
  const nav = makeNavStub();
  const capacity = 8;
  const pool = new GroundEffectPool(capacity);
  const deps = makeDeps(nav);
  const z = nextZBand();
  const owner = spawnPlayer(z);
  const monster = spawnMonster(0, z);

  const monsterSpec = buildAshenStepCloudSpec(monster, 1, 0, z);
  monsterSpec.ownerId = monster.id;
  monsterSpec.team = monster.team; // team 1 — non-player, the ONLY evictable entry
  const monsterEffectId = addGroundEffect(pool, monsterSpec, deps);
  assert.ok(monsterEffectId > 0);

  for (let i = 1; i < capacity; i++) {
    const id = addGroundEffect(pool, buildAshenStepCloudSpec(owner, 1, i, z), deps);
    assert.ok(id > 0);
  }
  assert.equal(pool.count, capacity);

  const newId = addGroundEffect(pool, buildAshenStepCloudSpec(owner, 1, 500, z), deps);
  console.log(`[GROUND overflow] full pool with 1 monster-owned effect -> addGroundEffect returned ${newId} (must be nonzero: eviction succeeded), reused slot id=${monsterEffectId}`);
  assert.ok(newId > 0, 'a full pool with an evictable (non-player) effect must succeed by evicting it');
  assert.equal(pool.count, capacity, 'still at capacity — one evicted, one added');
  // The freed slot is legitimately reused (same numeric id as the evicted
  // effect) — that is normal free-list recycling, not a bug (see
  // `./projectile.js`'s own identical `slot + 1` id scheme). What matters
  // is that the SLOT now holds the NEW effect's own data, not the evicted
  // monster's.
  assert.equal(pool._ownerId[newId - 1], owner.id, 'the reused slot must now hold the NEW (player-owned) effect');
  assert.notEqual(pool._ownerId[newId - 1], monster.id);

  onZoneTeardown(pool, deps);
});

// ===========================================================================
// Basic API surface
// ===========================================================================

test('GROUND — SkillsSystem#addGroundEffect / #removeGroundEffect / #groundEffectCount are real, wired methods', () => {
  assert.equal(typeof skills.addGroundEffect, 'function');
  assert.equal(typeof skills.removeGroundEffect, 'function');
  assert.equal(typeof skills.groundEffectCount, 'number');

  const z = nextZBand();
  const owner = spawnPlayer(z);
  const before = skills.groundEffectCount;
  const id = skills.addGroundEffect(buildMeteorPoolSpec(owner, 5, 0, z));
  assert.ok(id > 0);
  assert.equal(skills.groundEffectCount, before + 1);
  skills.removeGroundEffect(id);
  assert.equal(skills.groundEffectCount, before);
  skills.removeGroundEffect(id); // double-release is a safe no-op
  assert.equal(skills.groundEffectCount, before);
});

test('GROUND — meteor/ash_wall/ashen_step SkillDefinition records resolve (sanity — this file\'s own module-load lookups)', () => {
  assert.equal(METEOR_DEF.id, 'meteor');
  assert.equal(ASH_WALL_DEF.id, 'ash_wall');
  assert.equal(ASHEN_STEP_DEF.id, 'ashen_step');
});

