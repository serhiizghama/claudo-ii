// tests/actors/actr1.test.js
//
// ACTR-1 acceptance tests for src/actors/index.js (ActorsSystem) and
// src/actors/pool.js (ActorPool). `node:test` + `node:assert/strict` only —
// no framework (12-testing.md P6).
//
// Scope: the pool/SpawnSpec lifecycle slice only — spawn/despawn/ref/
// resolve/byId/all/player/count/forEachInRadius. Movement, stats, the
// action state machine and skeletons belong to later tickets and are not
// exercised here because they do not exist.
//
// The MAIN test is "a stale ActorRef never resolves through a recycled pool
// slot" below — everything else backs it up or covers a separate line of
// the acceptance list.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ActorsSystem, POOL_CAPACITY, SPAWN_SPEC_DEFAULTS } from '../../src/actors/index.js';
import { ActorPool, createActorRecord, resetActorRecord } from '../../src/actors/pool.js';
import { moveActor, createMoveResultScratch } from '../../src/actors/motion.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { QUALITY_PRESETS } from '../../src/core/config.js';
import { makeStubCtx } from '../helpers/actor.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { hashState } from '../helpers/hash.js';

// ---------------------------------------------------------------------------
// ctx builders
// ---------------------------------------------------------------------------

/** A ctx with a real, initialized `PhysicsSystem` behind `ctx.peek('physics')`,
 * sized to `quality`'s real `q.maxActors` (deliberately smaller than the
 * actor pool — see the capacity test below). */
async function makeCtxWithPhysics(quality) {
  const events = new EventBus();
  const config = { quality, q: QUALITY_PRESETS[quality] };
  const physics = new PhysicsSystem();
  const ctx = {
    events,
    config,
    get(id) {
      if (id === 'physics') return physics;
      throw new Error(`stub ctx.get: '${id}' is not available`);
    },
    peek(id) {
      return id === 'physics' ? physics : undefined;
    },
    has(id) {
      return id === 'physics';
    },
  };
  await physics.init(ctx);
  return { ctx, physics };
}

async function makeActors(quality) {
  const { ctx, physics } = await makeCtxWithPhysics(quality);
  const actors = new ActorsSystem();
  await actors.init(ctx);
  return { actors, physics, ctx };
}

async function makeActorsNoPhysics() {
  const ctx = makeStubCtx({ systems: {} });
  const actors = new ActorsSystem();
  await actors.init(ctx);
  return { actors, ctx };
}

// ---------------------------------------------------------------------------
// Node-safety — src/actors/ is not yet an auto-scanned check-imports.mjs
// root (the same gap PHYS-1 flagged for src/physics/ as O-19/O-22 in
// docs/PROGRESS.md), so this ticket's own test guards it directly.
// ---------------------------------------------------------------------------

test('src/actors/index.js, pool.js and motion.js never reference three (no automated root covers this yet)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    join(here, '../../src/actors/index.js'),
    join(here, '../../src/actors/pool.js'),
    join(here, '../../src/actors/motion.js'),
  ];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.equal(/from\s+['"]three['"]/.test(src), false, `${f} must not import 'three'`);
    assert.equal(/import\s*\(\s*['"]three['"]/.test(src), false, `${f} must not dynamically import 'three'`);
    assert.equal(/import\s+['"]three['"]/.test(src), false, `${f} must not bare-import 'three'`);
  }
});

// ---------------------------------------------------------------------------
// Constants — exact, per 01-data-model.md §11.1 and 02-api-contracts.md §7
// ---------------------------------------------------------------------------

test('POOL_CAPACITY is 60/100/160/220, strictly larger than q.maxActors, and frozen (D-1)', () => {
  assert.deepEqual(POOL_CAPACITY, { low: 60, medium: 100, high: 160, ultra: 220 });
  assert.ok(Object.isFrozen(POOL_CAPACITY));
  for (const quality of ['low', 'medium', 'high', 'ultra']) {
    assert.ok(
      POOL_CAPACITY[quality] > QUALITY_PRESETS[quality].maxActors,
      `${quality}: actor pool capacity (${POOL_CAPACITY[quality]}) must exceed q.maxActors (${QUALITY_PRESETS[quality].maxActors})`,
    );
  }
});

test('SPAWN_SPEC_DEFAULTS matches 02-api-contracts.md §7\'s SpawnSpec sample exactly, and is frozen', () => {
  assert.deepEqual(SPAWN_SPEC_DEFAULTS, {
    kind: 'monster',
    archetypeId: 'bone_ranker',
    rank: 'normal',
    level: 10,
    team: 1,
    x: 0,
    z: 0,
    facing: 0,
    packId: 0,
    ownerId: 0,
    affixes: [],
    nameOverride: null,
  });
  assert.ok(Object.isFrozen(SPAWN_SPEC_DEFAULTS));
});

test('ActorsSystem.id/deps: id is "actors", deps is exactly [\'physics\'] (materials omitted — MATL-1 not built, see the report)', () => {
  assert.equal(ActorsSystem.id, 'actors');
  assert.deepEqual(ActorsSystem.deps, ['physics']);
});

// ---------------------------------------------------------------------------
// spawn -> ref -> resolve
// ---------------------------------------------------------------------------

test('spawn -> ref -> resolve closes the loop and returns the same actor', async () => {
  const { actors } = await makeActors('high');
  const actor = actors.spawn({ archetypeId: 'bone_ranker', x: 3, z: -2 });
  assert.ok(actor);
  // An owned `out` — the only supported way to hold a ref across any gap
  // before resolve(), even the gap of a single statement. See the
  // "ref() pooled-scratch guard" section below for what happens without one.
  const ref = actors.ref(actor, {});
  assert.equal(actors.resolve(ref), actor);
});

test('reading .id/.generation directly off the no-out ref() scratch works (the scratch\'s one legitimate use)', async () => {
  const { actors } = await makeActors('high');
  const actor = actors.spawn({});
  const ref = actors.ref(actor); // no out — fine as long as it's read, not stored/resolved
  assert.equal(ref.id, actor.id);
  assert.equal(ref.generation, actor.generation);
});

test('ref(actor, out) writes into a caller-supplied out object', async () => {
  const { actors } = await makeActors('high');
  const actor = actors.spawn({});
  const out = { id: -1, generation: -1 };
  const returned = actors.ref(actor, out);
  assert.equal(returned, out);
  assert.equal(out.id, actor.id);
  assert.equal(out.generation, actor.generation);
});

// ---------------------------------------------------------------------------
// ref()'s no-out scratch: holding it is a resolve()-time throw, not a
// silent alias. Found in review: since ref()'s no-out return is the SAME
// mutated-in-place object on every call, any code that stores it (exactly
// what 01-data-model.md §2.2 tells every real caller to do with an
// ActorRef) gets silently aliased to whatever the NEXT no-out ref() call
// was for. resolve() now refuses that object by identity in dev.
// ---------------------------------------------------------------------------

test('team-lead repro: a held no-out ref survives a despawn/respawn cycle only by throwing, never by resolving to the new occupant', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({});
  const refA = actors.ref(a); // NO out — exactly the misuse pattern
  actors.despawn(a);
  actors.spawn({}); // slot reused; also overwrites the shared scratch
  assert.throws(() => actors.resolve(refA), /out/i);
});

test('holding a no-out ref across a LATER no-out ref() call for a DIFFERENT still-alive actor throws too (not just on slot reuse)', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({});
  const b = actors.spawn({});
  const refA = actors.ref(a); // no out
  actors.ref(b); // no out — overwrites the same shared scratch refA aliases; neither actor despawned
  assert.throws(() => actors.resolve(refA), /out/i);
});

test('resolve(ref(actor)) chained immediately also throws — it provides nothing over using actor directly and is indistinguishable from the held case', async () => {
  const { actors } = await makeActors('high');
  const actor = actors.spawn({});
  assert.throws(() => actors.resolve(actors.ref(actor)), /out/i);
});

test('resolve() with an owned out never throws, regardless of intervening ref() calls', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({});
  const b = actors.spawn({});
  const refA = actors.ref(a, {});
  actors.ref(b, {}); // a different owned out — must not disturb refA
  actors.ref(a); // even a no-out call for `a` itself must not disturb the owned refA
  assert.doesNotThrow(() => actors.resolve(refA));
  assert.equal(actors.resolve(refA), a);
});

// ---------------------------------------------------------------------------
// THE MAIN TEST — stale ActorRef safety across pool-slot reuse
// ---------------------------------------------------------------------------

test('MAIN: a stale ActorRef never resolves through a recycled pool slot', async () => {
  const { actors } = await makeActors('high');

  const a = actors.spawn({ archetypeId: 'bone_ranker' });
  // Everything about `a` we still need after the despawn/respawn below is
  // captured NOW, into plain owned values — `a` itself is a record the
  // pool mutates in place on recycle (never hold an Actor across that
  // boundary; this is the whole reason ActorRef exists).
  const refA = actors.ref(a, {});
  const slot = a.poolIndex;
  const idA = refA.id;
  const generationA = refA.generation;

  actors.despawn(a);
  assert.equal(actors.resolve(refA), null, 'the ref must not resolve once its actor despawned');
  assert.equal(actors.byId(idA), null);

  const b = actors.spawn({ archetypeId: 'carrion_swarm' });
  assert.equal(b.poolIndex, slot, 'LIFO free-list must hand the just-freed slot back to the very next spawn');
  assert.notEqual(b.id, idA, 'id is never reused (01-data-model.md §2)');
  assert.notEqual(b.generation, generationA, 'generation must differ across a recycle even though it shares the same slot');

  assert.equal(actors.resolve(refA), null, 'the OLD ref must still resolve to null once its slot has a NEW occupant');
  const refB = actors.ref(b, {});
  assert.equal(actors.resolve(refB), b, 'a fresh ref for the NEW occupant must resolve correctly');

  assert.equal(actors.byId(idA), null);
  assert.equal(actors.byId(b.id), b);
});

test('ActorPool (low-level, capacity=1): forces slot reuse on every respawn', () => {
  const pool = new ActorPool(1);
  const specA = { ...SPAWN_SPEC_DEFAULTS, archetypeId: 'a' };
  const specB = { ...SPAWN_SPEC_DEFAULTS, archetypeId: 'b' };

  const a = pool.acquire(specA);
  assert.ok(a);
  assert.equal(pool.acquire(specA), null, 'capacity 1 is already full');

  // Captured before release() — see the MAIN test above for why `a` itself
  // cannot be trusted after this point.
  const refA = pool.ref(a, {});
  const poolIndexA = a.poolIndex;
  pool.release(a);

  const b = pool.acquire(specB);
  assert.ok(b);
  assert.equal(b.poolIndex, poolIndexA);
  assert.notEqual(b.id, refA.id);

  assert.equal(pool.resolve(refA), null);
  assert.equal(pool.resolve(pool.ref(b, {})), b);
});

// ---------------------------------------------------------------------------
// despawn: all / count / pool-slot return
// ---------------------------------------------------------------------------

test('despawn removes the actor from all/count and returns the slot to the pool', async () => {
  const { actors } = await makeActors('low');
  const capacity = POOL_CAPACITY.low;

  const a = actors.spawn({});
  const b = actors.spawn({});
  assert.equal(actors.count, 2);
  assert.equal(actors.all.length, 2);

  actors.despawn(a);
  assert.equal(actors.count, 1);
  assert.equal(actors.all.length, 1);
  assert.equal(actors.all[0], b);
  assert.ok(!Array.prototype.includes.call(actors.all, a));
  assert.equal(a.active, false);

  // Fill the pool back up to its full capacity — proves the freed slot
  // really came back rather than the pool silently running one short.
  const spawned = [b];
  for (let i = spawned.length; i < capacity; i++) {
    const s = actors.spawn({});
    assert.ok(s, `spawn ${i} of ${capacity} should have succeeded`);
    spawned.push(s);
  }
  assert.equal(actors.count, capacity);
});

test('despawn(actor, immediate) releases the slot synchronously regardless of the immediate flag (no deferred corpse-fade yet — see the report)', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({});
  actors.despawn(a, false);
  assert.equal(actors.count, 0);
  assert.equal(a.active, false);
});

test('despawn is a safe no-op on a double despawn, null, or an actor this system does not own', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({});
  actors.despawn(a);
  assert.doesNotThrow(() => actors.despawn(a));
  assert.doesNotThrow(() => actors.despawn(null));
  assert.doesNotThrow(() => actors.despawn(undefined));
  assert.doesNotThrow(() => actors.despawn({ active: true, poolIndex: 999999 }));
  assert.equal(actors.count, 0);
});

// ---------------------------------------------------------------------------
// Pool exhaustion — the contract, not an exception
// ---------------------------------------------------------------------------

test('spawn returns null (never throws) once the pool is exhausted, and the pool does not grow', async () => {
  const { actors } = await makeActors('low');
  const capacity = POOL_CAPACITY.low;
  for (let i = 0; i < capacity; i++) assert.ok(actors.spawn({}), `spawn ${i}`);
  assert.equal(actors.count, capacity);

  let extra = 'not yet set';
  assert.doesNotThrow(() => {
    extra = actors.spawn({});
  });
  assert.equal(extra, null);
  assert.equal(actors.count, capacity, 'capacity must not have grown');
});

test('actor pool capacity matches the preset (60/100/160/220), NOT q.maxActors, for every preset', async () => {
  for (const quality of ['low', 'medium', 'high', 'ultra']) {
    const { actors, physics } = await makeActors(quality);
    const capacity = POOL_CAPACITY[quality];
    assert.ok(
      capacity > physics._bodies.capacity,
      `${quality}: actor pool (${capacity}) must exceed the physics body store (${physics._bodies.capacity})`,
    );
    for (let i = 0; i < capacity; i++) {
      const a = actors.spawn({});
      assert.ok(a, `${quality}: spawn ${i} of ${capacity} should succeed even past q.maxActors=${physics._bodies.capacity}`);
    }
    assert.equal(actors.count, capacity);
    assert.equal(actors.spawn({}), null, `${quality}: the (capacity+1)th spawn must fail`);
  }
});

// ---------------------------------------------------------------------------
// byId / player / count / all consistency
// ---------------------------------------------------------------------------

test('byId, player, count and all stay consistent with each other', async () => {
  const { actors } = await makeActors('high');
  assert.equal(actors.player, null);
  assert.equal(actors.count, 0);
  assert.equal(actors.all.length, 0);

  const hero = actors.spawn({ kind: 'player', archetypeId: 'ravager' });
  assert.equal(actors.player, hero);

  const m1 = actors.spawn({ kind: 'monster' });
  const m2 = actors.spawn({ kind: 'monster' });

  assert.equal(actors.count, 3);
  assert.equal(actors.all.length, 3);
  assert.equal(actors.byId(hero.id), hero);
  assert.equal(actors.byId(m1.id), m1);
  assert.equal(actors.byId(m2.id), m2);
  assert.equal(actors.byId(999999), null);

  actors.despawn(hero);
  assert.equal(actors.player, null, 'player must clear once the player actor despawns');
  assert.equal(actors.byId(hero.id), null);
  assert.equal(actors.count, 2);
});

// ---------------------------------------------------------------------------
// forEachInRadius
// ---------------------------------------------------------------------------

test('forEachInRadius filters by radius and by team (-1 = any)', async () => {
  const { actors } = await makeActors('high');
  actors.spawn({ team: 1, x: 0, z: 0 }); // in range, monster
  actors.spawn({ team: 0, x: 1, z: 0 }); // in range, player-team
  actors.spawn({ team: 1, x: 100, z: 100 }); // out of range

  const anyTeam = [];
  actors.forEachInRadius(0, 0, 5, -1, (a) => anyTeam.push(a));
  assert.equal(anyTeam.length, 2);

  const monsterOnly = [];
  actors.forEachInRadius(0, 0, 5, 1, (a) => monsterOnly.push(a));
  assert.equal(monsterOnly.length, 1);
  assert.equal(monsterOnly[0].team, 1);

  const none = [];
  actors.forEachInRadius(0, 0, 5, 2, (a) => none.push(a));
  assert.equal(none.length, 0);
});

test('forEachInRadius allocates nothing per call', async (t) => {
  if (!hasGc()) {
    t.skip('run with node --expose-gc');
    return;
  }
  const { actors } = await makeActors('high');
  for (let i = 0; i < 20; i++) actors.spawn({ x: i, z: 0 });

  let touched = 0;
  const fn = (a) => {
    touched += a.team;
  };
  const { bytesPerCall } = assertAllocationFree(() => {
    actors.forEachInRadius(0, 0, 1000, -1, fn);
  });
  assert.ok(bytesPerCall < 1);
  assert.ok(touched >= 0);
});

// ---------------------------------------------------------------------------
// all is read-only
// ---------------------------------------------------------------------------

test('all is read-only — external mutation attempts throw and leave internal state untouched', async () => {
  const { actors } = await makeActors('high');
  actors.spawn({});
  const all = actors.all;

  assert.throws(() => {
    all.push({});
  });
  assert.throws(() => {
    all[0] = null;
  });
  assert.throws(() => {
    all.length = 0;
  });
  assert.throws(() => {
    all.pop();
  });
  assert.throws(() => {
    delete all[0];
  });

  assert.equal(actors.count, 1, 'a failed external mutation must not have changed the live actor list');
});

test('all returns the same reference every call (Alloc: no)', async () => {
  const { actors } = await makeActors('high');
  const a1 = actors.all;
  actors.spawn({});
  const a2 = actors.all;
  assert.equal(a1, a2);
});

// ---------------------------------------------------------------------------
// O-33 — `all`'s Proxy view was missing `has`/`getOwnPropertyDescriptor`, so
// `HasProperty(all, idx)` was false for every live index even though `get`
// answered correctly. Every index-based Array.prototype algorithm that
// checks HasProperty before reading (slice/map/filter/forEach/indexOf/...)
// therefore saw the whole view as holes and silently did nothing, while
// for...of/spread/Array.from (which don't consult HasProperty) worked fine
// — a defect invisible to naive smoke tests. The real payoff is the
// hashState case below: TEST-1's own canonicalization calls `.slice()`
// before sorting, so a live world hashed through `actors.all` was blind to
// actor position entirely.
// ---------------------------------------------------------------------------

test('O-33: slice/map/filter/forEach/indexOf all see every live actor through the `all` view', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({ x: 0, z: 0 });
  const b = actors.spawn({ x: 1, z: 0 });
  const c = actors.spawn({ x: 2, z: 0 });
  const all = actors.all;

  assert.deepEqual(all.slice(), [a, b, c]);
  assert.deepEqual(all.map((actor) => actor.id), [a.id, b.id, c.id]);
  assert.equal(all.filter(Boolean).length, 3);

  let seen = 0;
  all.forEach((actor) => {
    assert.ok(actor === a || actor === b || actor === c);
    seen++;
  });
  assert.equal(seen, 3);

  assert.equal(all.indexOf(a), 0);
  assert.equal(all.indexOf(b), 1);
  assert.equal(all.indexOf(c), 2);
  assert.equal(all.indexOf({}), -1);
});

test('O-33: `0 in all` / Object.hasOwn(all, 0) are true in range and false out of range, exactly at _liveCount', async () => {
  const { actors } = await makeActors('high');
  actors.spawn({});
  actors.spawn({});
  const all = actors.all;

  assert.equal(0 in all, true);
  assert.equal(1 in all, true);
  assert.equal(Object.hasOwn(all, 0), true);
  assert.equal(Object.hasOwn(all, 1), true);

  // Exactly at _liveCount (2 live actors -> index 2 is one past the end).
  assert.equal(2 in all, false);
  assert.equal(Object.hasOwn(all, 2), false);
  assert.equal(99 in all, false);
  assert.equal(Object.hasOwn(all, 99), false);
});

test('O-33: the `all` view stays read-only after the has/getOwnPropertyDescriptor fix — set/delete/defineProperty still throw', async () => {
  const { actors } = await makeActors('high');
  actors.spawn({});
  const all = actors.all;

  assert.throws(() => {
    all[0] = null;
  });
  assert.throws(() => {
    delete all[0];
  });
  assert.throws(() => {
    Object.defineProperty(all, 0, { value: null });
  });
  assert.equal(actors.count, 1, 'a failed external mutation must not have changed the live actor list');
});

test('O-33: hashState(actors.all) changes after a real moveTo and matches the hash of the same actors as a plain array', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({ x: 1.5, z: -2.25 });

  const viaAllBefore = hashState({ actors: actors.all, items: [], rngStreams: {}, step: 0 });
  const viaPlainBefore = hashState({ actors: [a], items: [], rngStreams: {}, step: 0 });
  assert.equal(viaAllBefore, viaPlainBefore, 'hashing the live view must match hashing the same actors as a plain array');

  actors.moveTo(a, 0.25, 0);

  const viaAllAfter = hashState({ actors: actors.all, items: [], rngStreams: {}, step: 0 });
  const viaPlainAfter = hashState({ actors: [a], items: [], rngStreams: {}, step: 0 });

  assert.notEqual(viaAllAfter, viaAllBefore, 'hashState(actors.all) must change after a real moveTo — this is the whole point of O-33');
  assert.equal(viaAllAfter, viaPlainAfter, 'hashing the live view must still match hashing the same actors as a plain array after the move');
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('the same spawn/despawn sequence produces the same live-list order across independent pools', async () => {
  const runOnce = async () => {
    const { actors } = await makeActors('high');
    const a = actors.spawn({ archetypeId: 'a' });
    const b = actors.spawn({ archetypeId: 'b' });
    actors.spawn({ archetypeId: 'c' });
    actors.despawn(b);
    actors.spawn({ archetypeId: 'd' });
    actors.despawn(a);
    actors.spawn({ archetypeId: 'e' });
    return Array.from(actors.all, (actor) => ({
      id: actor.id,
      poolIndex: actor.poolIndex,
      archetypeId: actor.archetypeId,
    }));
  };
  const run1 = await runOnce();
  const run2 = await runOnce();
  assert.deepEqual(run1, run2);
});

// ---------------------------------------------------------------------------
// Physics integration — best-effort, never blocks the pool
// ---------------------------------------------------------------------------

test('spawn works without a physics subsystem present at all', async () => {
  const { actors } = await makeActorsNoPhysics();
  const a = actors.spawn({ x: 5, z: 5 });
  assert.ok(a);
  assert.equal(a.x, 5);
  assert.equal(a.z, 5);
  assert.equal(a.y, 0, 'no physics -> y stays at the pool default');
  assert.doesNotThrow(() => actors.despawn(a));
  assert.equal(actors.count, 0);
});

test('when physics is present, spawn registers a body and despawn releases it', async () => {
  const { actors, physics } = await makeActors('high');
  assert.equal(physics.stats.bodies, 0);
  const a = actors.spawn({ x: 2, z: 2 });
  assert.equal(physics.stats.bodies, 1);
  actors.despawn(a);
  assert.equal(physics.stats.bodies, 0);
});

test('a spawn past physics\' own body capacity still succeeds (best-effort — see the report)', async () => {
  const { actors, physics } = await makeActors('low'); // q.maxActors = 24, pool capacity = 60
  const bodyCapacity = physics._bodies.capacity;
  const spawned = [];
  for (let i = 0; i < bodyCapacity + 5; i++) {
    const a = actors.spawn({});
    assert.ok(a, `spawn ${i} must succeed regardless of the physics body budget`);
    spawned.push(a);
  }
  assert.equal(physics.stats.bodies, bodyCapacity, 'physics itself still stops at its own budget');
  assert.equal(actors.count, bodyCapacity + 5, 'the actor pool does not care');
});

test('init() falls back to the largest pool capacity for a config-less ctx', async () => {
  const ctx = {
    events: new EventBus(),
    get() {
      throw new Error('not available');
    },
    peek() {
      return undefined;
    },
    has() {
      return false;
    },
  };
  const actors = new ActorsSystem();
  await assert.doesNotReject(actors.init(ctx));
  assert.equal(actors._pool.capacity, POOL_CAPACITY.ultra);
  for (let i = 0; i < 5; i++) assert.ok(actors.spawn({}));
});

// ---------------------------------------------------------------------------
// SpawnSpec field handling
// ---------------------------------------------------------------------------

test('spawn() fills omitted SpawnSpec fields from SPAWN_SPEC_DEFAULTS and honours provided ones', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({ x: 7 });
  assert.equal(a.kind, 'monster');
  assert.equal(a.archetypeId, 'bone_ranker');
  assert.equal(a.rank, 'normal');
  assert.equal(a.level, 10);
  assert.equal(a.team, 1);
  assert.equal(a.x, 7);
  assert.equal(a.z, 0);
  assert.equal(a.packId, 0);
  assert.equal(a.ownerId, 0);
  assert.equal(a.name, 'bone_ranker');
});

test('nameOverride wins over archetypeId for name; classId is only set for kind===player', async () => {
  const { actors } = await makeActors('high');
  const named = actors.spawn({ nameOverride: 'Ashen Crown' });
  assert.equal(named.name, 'Ashen Crown');

  const hero = actors.spawn({ kind: 'player', archetypeId: 'ravager' });
  assert.equal(hero.classId, 'ravager');

  const mob = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker' });
  assert.equal(mob.classId, null);
});

test('level clamps to 1..40 and facing wraps to (-PI, PI]', async () => {
  const { actors } = await makeActors('high');
  const low = actors.spawn({ level: -5 });
  assert.equal(low.level, 1);
  const high = actors.spawn({ level: 999 });
  assert.equal(high.level, 40);

  const wrapped = actors.spawn({ facing: Math.PI * 3 }); // 3π -> wraps into (-π, π]
  assert.ok(wrapped.facing > -Math.PI - 1e-9 && wrapped.facing <= Math.PI + 1e-9);
  assert.ok(Math.abs(wrapped.facing - Math.PI) < 1e-9);
});

// ---------------------------------------------------------------------------
// The pool-reset contract (01-data-model.md §11.2)
// ---------------------------------------------------------------------------

test('createActorRecord: a fresh slot record starts at the documented baseline', () => {
  const fresh = createActorRecord(5);
  assert.equal(fresh.poolIndex, 5);
  assert.equal(fresh.generation, 0);
  assert.equal(fresh.id, 0);
  assert.equal(fresh.active, false);
  assert.deepEqual(fresh.attributes, { strength: 0, dexterity: 0, vitality: 0, energy: 0 });
  assert.equal(fresh.cooldowns.size, 0);
  assert.equal(fresh.statuses.length, 0);
  assert.equal(fresh.lastDamageStep, -1);
  assert.equal(fresh.lastDealtStep, -1);
});

test('resetActorRecord: increments generation, preserves poolIndex, zeroes/nulls everything else, mutates containers in place', () => {
  const record = createActorRecord(5);
  const cooldownsRef = record.cooldowns;
  const statusesRef = record.statuses;
  const attributesRef = record.attributes;
  const viewRef = record.view;

  record.id = 42;
  record.active = true;
  record.x = 10;
  record.statuses.push({ status: 'burning' });
  record.attributes.strength = 30;
  record.view.visible = false;

  resetActorRecord(record);

  assert.equal(record.id, 0);
  assert.equal(record.generation, 1);
  assert.equal(record.poolIndex, 5, 'poolIndex is preserved');
  assert.equal(record.active, false);
  assert.equal(record.x, 0);
  assert.equal(record.statuses.length, 0);
  assert.equal(record.attributes.strength, 0);
  assert.equal(record.view.visible, true);

  // record.cooldowns is deliberately NOT cleared by resetActorRecord — see
  // that function's own comment: Map#clear() allocates in V8 even on an
  // empty map, and nothing in this ticket's scope ever writes to
  // cooldowns, so skipping the clear is a no-op today. Documented here so
  // a future change to that field's handling has a test to update instead
  // of a silent behaviour change.
  record.cooldowns.set('whirlwind', 100);
  resetActorRecord(record);
  assert.equal(record.cooldowns.size, 1, 'known gap: cooldowns is not cleared on release yet — see pool.js');

  // Containers are mutated in place, never reassigned (01 §11.2 rules 2/3).
  assert.equal(record.cooldowns, cooldownsRef);
  assert.equal(record.statuses, statusesRef);
  assert.equal(record.attributes, attributesRef);
  assert.equal(record.view, viewRef);
});

// ---------------------------------------------------------------------------
// moveTo — pulled forward from ACTR-2/M1 (see src/actors/motion.js's
// header for why). The sole writer of actor.x/z/prevX/prevZ in this slice.
// ---------------------------------------------------------------------------

test('createMoveResultScratch returns the exact MoveResult shape from 02-api-contracts.md §4', () => {
  assert.deepEqual(createMoveResultScratch(), { x: 0, z: 0, blocked: false, slid: false, hitStatic: 0, hitActorId: 0 });
});

test('moveTo moves the actor by the delta and returns a matching MoveResult when nothing blocks it', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({ x: 0, z: 0 });
  const result = actors.moveTo(a, 1, 2);
  assert.equal(a.x, 1);
  assert.equal(a.z, 2);
  assert.equal(a.x, result.x);
  assert.equal(a.z, result.z);
  assert.equal(result.blocked, false);
});

test('moveTo captures prevX/prevZ as the position immediately before each call\'s own movement', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({ x: 5, z: 5 });
  actors.moveTo(a, 1, -1);
  assert.equal(a.prevX, 5);
  assert.equal(a.prevZ, 5);
  assert.equal(a.x, 6);
  assert.equal(a.z, 4);
  actors.moveTo(a, 1, -1);
  assert.equal(a.prevX, 6, 'prevX must track the position before THIS call, not the original spawn position');
  assert.equal(a.prevZ, 4);
  assert.equal(a.x, 7);
  assert.equal(a.z, 3);
});

test('moveTo reflects a static collision in the record: blocked=true and the record never overshoots the wall face, actor and body stay synced', async () => {
  const { actors, physics } = await makeActors('high');
  // A wall spanning z in [-5,5] at x in [1,3] — box centered (2,0), halfW=1, halfL=5.
  physics.addStatic({ kind: 'box', x: 2, z: 0, y: 0, height: 3, halfW: 1, halfL: 5, facing: 0 }, 'stone');
  physics.rebuild();

  const a = actors.spawn({ x: 0, z: 0 });
  const wallFaceX = 2 - 1; // near face of the box
  // A realistic per-step delta that lands the target circle INSIDE the wall
  // (0 -> 1.5, well within the wall's [1,3] span) — not a huge single-step
  // jump. `src/physics/body.js`'s own algorithm is "move to the target,
  // then push out of whatever it now overlaps" (its file header, verbatim);
  // a delta large enough to fly clean through a thin obstacle in one step
  // lands with nothing left to overlap at the target, and reports
  // blocked=false — not a bug, an explicitly out-of-scope tunnelling case
  // for the "actors move centimetres per step" model. Confirmed directly
  // against `physics.moveBody` while writing this test: dx=10 tunnels
  // clean through this wall (target x=10, wall ends at x=3); dx=1.5 does not.
  const result = actors.moveTo(a, 1.5, 0);

  assert.equal(result.blocked, true);
  assert.ok(a.x <= wallFaceX - a.radius + 1e-6, `actor.x=${a.x} must not overshoot the wall face at x=${wallFaceX - a.radius}`);
  assert.ok(a.x > 0, 'the actor must still have made progress toward the wall');
  // actor and body stay synced: the record holds exactly what moveBody resolved.
  assert.equal(a.x, result.x);
  assert.equal(a.z, result.z);
});

test('moveTo on a bodyless actor (physics entirely absent) still moves the record directly, no collision possible', async () => {
  const { actors } = await makeActorsNoPhysics();
  const a = actors.spawn({ x: 0, z: 0 });
  const result = actors.moveTo(a, 3, 4);
  assert.equal(a.x, 3);
  assert.equal(a.z, 4);
  assert.equal(result.blocked, false);
});

test('moveTo on an actor spawned past physics\' own body budget (bodyId=0, best-effort integration) still moves the record directly', async () => {
  const { actors, physics } = await makeActors('low');
  const bodyCapacity = physics._bodies.capacity;
  for (let i = 0; i < bodyCapacity; i++) actors.spawn({});
  const overflow = actors.spawn({ x: 0, z: 0 }); // no body left to give it
  const result = actors.moveTo(overflow, 2, 3);
  assert.equal(overflow.x, 2);
  assert.equal(overflow.z, 3);
  assert.equal(result.blocked, false);
});

test('moveTo is a safe no-op on a null or inactive (despawned) actor', async () => {
  const { actors } = await makeActors('high');
  assert.doesNotThrow(() => actors.moveTo(null, 1, 1));

  const a = actors.spawn({ x: 1, z: 1 });
  actors.despawn(a); // resetActorRecord zeroes x/z
  assert.equal(a.x, 0);
  assert.doesNotThrow(() => actors.moveTo(a, 5, 5));
  assert.equal(a.x, 0, 'a despawned actor must not be moved, even if a caller wrongly holds the Actor reference');
  assert.equal(a.z, 0);
});

test('moveTo returns the same MoveResult reference every call (Alloc: no) — read/copy immediately, never stash it', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({});
  const r1 = actors.moveTo(a, 1, 0);
  const r2 = actors.moveTo(a, 1, 0);
  assert.equal(r1, r2);
});

test('moveTo allocates nothing per call', async (t) => {
  if (!hasGc()) {
    t.skip('run with node --expose-gc');
    return;
  }
  const { actors } = await makeActors('high');
  const a = actors.spawn({ x: 0, z: 0 });
  let sign = 1;
  const fn = () => {
    actors.moveTo(a, sign * 0.01, 0); // oscillate — stays near the origin, no growth
    sign = -sign;
  };
  // `moveBody`'s own candidate-gather/classify code is polymorphic enough
  // that the default `iterations: 10 000` reads a one-time inline-cache
  // stabilization cost, not a real leak — `tests/physics/phys2.test.js`'s
  // own `12.A01` test for `moveBody` documents exactly this curve and
  // states it explicitly ("strictly *decreasing* as n grows... the
  // signature of a fixed one-time cost being diluted, not a genuine
  // per-call allocation"). Reproduced directly for this exact call while
  // writing this test, isolated (`node --test-concurrency=1`, or a bare
  // script, no sibling test files running): 128.75 B/call at n=10 000, 0.55
  // at n=100 000, and a stable 0.17-0.33 across eight repeated rounds at
  // n=2 000 000 — no leak.
  //
  // `docs/PROGRESS.md`'s O-21 entry names a companion problem this
  // `maxRounds`/`iterations` pair both address: under `npm test`'s DEFAULT
  // concurrency (node --test runs test FILES as separate processes, but
  // still competes for the same CPU cores), this exact probe read
  // 1.3-1.95 B/call — and once, a value that repeated identically across
  // every one of `maxRounds: 100` attempts, never dropping below 1 — while
  // the identical probe run alone, or under `--test-concurrency=1`, always
  // passed cleanly. That is CPU-scheduling contention perturbing this
  // process's own GC timing, not memory shared across processes (there is
  // none — each test file is a separate OS process with a separate V8
  // heap). Fixed the O-21-documented way, "increase maxRounds, never loosen
  // the threshold" — but `maxRounds` alone (tried up to 100) did not
  // reliably clear sustained contention; `iterations: 5_000_000` (dilutes
  // the same fixed-size bias further, the same mechanism that dilutes the
  // one-time JIT cost) combined with `maxRounds: 50` did: 8/8 clean full
  // `npm test` runs at this setting, versus repeated failures at
  // `iterations: 2_000_000, maxRounds: 10` (PHYS-2's own choice for its
  // harder two-wall scenario) and at `maxRounds: 100` alone.
  const { bytesPerCall } = assertAllocationFree(fn, { iterations: 5_000_000, maxRounds: 50 });
  assert.ok(bytesPerCall < 1);
});

test('moveActor (low-level): an inactive actor is a no-op that reports its own current position', () => {
  const record = createActorRecord(0);
  record.x = 7;
  record.z = 9;
  record.active = false;
  const out = createMoveResultScratch();
  const result = moveActor(record, 100, 100, null, 0, out);
  assert.equal(result, out);
  assert.equal(result.x, 7);
  assert.equal(result.z, 9);
  assert.equal(result.blocked, false);
  assert.equal(record.x, 7, 'an inactive record must not be mutated');
});

// ---------------------------------------------------------------------------
// Pool mechanics allocation — the operations despawn (Alloc: no) is built
// from. ActorsSystem.spawn()'s own {...SPAWN_SPEC_DEFAULTS, ...spec} merge
// is Alloc: "pool" (not "no") and is deliberately excluded here — see the
// report for why a sustained assertAllocationFree measurement doesn't fit a
// "consumes an actor" operation the way it fits a pure query.
// ---------------------------------------------------------------------------

test('ActorPool#acquire + #release (the mechanics despawn/spawn are built on) allocate nothing in steady state', async (t) => {
  if (!hasGc()) {
    t.skip('run with node --expose-gc');
    return;
  }
  const pool = new ActorPool(4);
  const spec = { ...SPAWN_SPEC_DEFAULTS }; // built once, outside the measured closure
  const fn = () => {
    const a = pool.acquire(spec);
    pool.release(a);
  };
  const { bytesPerCall } = assertAllocationFree(fn);
  assert.ok(bytesPerCall < 1);
});

// ---------------------------------------------------------------------------
// Real Registry wiring (boot-shape smoke test)
// ---------------------------------------------------------------------------

test('wires cleanly through the real Registry alongside PhysicsSystem', async () => {
  const registry = new Registry();
  registry.add(PhysicsSystem);
  registry.add(ActorsSystem);
  const events = new EventBus();
  const ctx = {
    events,
    config: { quality: 'high', q: QUALITY_PRESETS.high },
    get: (id) => registry.get(id),
    peek: (id) => registry.peek(id),
    has: (id) => registry.has(id),
  };
  await assert.doesNotReject(registry.init(ctx));
  const actors = registry.get('actors');
  const a = actors.spawn({});
  assert.ok(a);
});

test('ActorPool.capacity reflects the constructed size', () => {
  const pool = new ActorPool(37);
  assert.equal(pool.capacity, 37);
});
