// tests/skills/projectile.test.js
//
// SKIL-4 acceptance tests for `src/skills/projectile.js` — the `Projectile`
// pool itself (criterion #3: "the pool is `01-data-model.md:1691`'s LOD
// tier and refuses rather than allocates when full") and the LOD-tier
// lookup table (D-47). `bolt.test.js` covers the pool driven through a real
// cast/flight; this file is the pool's own unit-level contract.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProjectilePool,
  PROJECTILE_POOL_SIZE_BY_QUALITY,
  projectilePoolCapacityFor,
  advanceProjectiles,
} from '../../src/skills/projectile.js';

// ---------------------------------------------------------------------------
// D-47 — the LOD tier itself, verbatim from 01-data-model.md:1691
// ---------------------------------------------------------------------------

test('D-47: the pool size table is exactly 01-data-model.md:1691\'s four values', () => {
  assert.deepEqual(PROJECTILE_POOL_SIZE_BY_QUALITY, { low: 128, medium: 256, high: 384, ultra: 512 });
});

test('projectilePoolCapacityFor: resolves off ctx.config.quality, falls back to the largest tier for a config-less ctx', () => {
  assert.equal(projectilePoolCapacityFor({ config: { quality: 'low' } }), 128);
  assert.equal(projectilePoolCapacityFor({ config: { quality: 'medium' } }), 256);
  assert.equal(projectilePoolCapacityFor({ config: { quality: 'high' } }), 384);
  assert.equal(projectilePoolCapacityFor({ config: { quality: 'ultra' } }), 512);
  assert.equal(projectilePoolCapacityFor({}), 512, 'a bare/config-less ctx must fall back to the LARGEST tier, never a silent truncation');
  assert.equal(projectilePoolCapacityFor(undefined), 512);
});

// ---------------------------------------------------------------------------
// Criterion #3 — the pool refuses rather than allocates when full
// ---------------------------------------------------------------------------

function makeSpec(overrides = {}) {
  return {
    x: 0, z: 0, dirX: 1, dirZ: 0,
    speed: 26, lifetime: 2.2, radius: 0.30,
    pierce: false, mask: 0,
    sourceId: 1, sourceGen: 0, team: 0,
    skillId: 'ember_bolt', level: 1,
    alwaysHits: true,
    ...overrides,
  };
}

test('acceptance: a saturated pool refuses (spawnProjectile returns 0) rather than growing or evicting; projectileCount never exceeds the cap', () => {
  const CAPACITY = 8;
  const pool = new ProjectilePool(CAPACITY);

  const ids = [];
  for (let i = 0; i < CAPACITY; i++) {
    const id = pool.spawnProjectile(makeSpec({ sourceId: 100 + i }));
    assert.ok(id > 0, `spawn ${i} must succeed while the pool has room`);
    ids.push(id);
  }
  assert.equal(pool.count, CAPACITY, 'projectileCount must equal the capacity once full');

  // The pool is now full — every further spawn must REFUSE (return 0), not
  // evict the oldest live projectile (D-47's own resolution — see
  // projectile.js's file header for the full reasoning).
  for (let i = 0; i < 5; i++) {
    const refused = pool.spawnProjectile(makeSpec({ sourceId: 999 }));
    assert.equal(refused, 0, `spawn attempt ${i} past capacity must return 0, not evict`);
  }
  assert.equal(pool.count, CAPACITY, 'projectileCount must never exceed the cap, even after repeated refused spawns');

  // Every ORIGINAL projectile must still be exactly as spawned — untouched
  // by the refused attempts (proves refuse, not silent eviction).
  for (let i = 0; i < CAPACITY; i++) {
    assert.equal(pool._sourceId[ids[i] - 1], 100 + i, `original projectile ${i} must be untouched by a refused spawn`);
  }

  // Freeing one slot makes exactly one more spawn possible again.
  pool.killProjectile(ids[0]);
  assert.equal(pool.count, CAPACITY - 1);
  const newId = pool.spawnProjectile(makeSpec({ sourceId: 777 }));
  assert.ok(newId > 0, 'a spawn must succeed again once a slot has been freed');
  assert.equal(pool.count, CAPACITY, 'projectileCount must be back at the cap, never past it');

  const refusedAgain = pool.spawnProjectile(makeSpec());
  assert.equal(refusedAgain, 0, 'the pool must refuse again immediately once it is back at capacity');
});

test('killProjectile is a safe no-op on id 0, a negative id, an out-of-range id, and a double-release', () => {
  const pool = new ProjectilePool(4);
  const id = pool.spawnProjectile(makeSpec());
  assert.ok(id > 0);

  pool.killProjectile(0);
  pool.killProjectile(-1);
  pool.killProjectile(9999);
  assert.equal(pool.count, 1, 'none of those must have touched the live projectile');

  pool.killProjectile(id);
  assert.equal(pool.count, 0);
  pool.killProjectile(id); // double-release
  assert.equal(pool.count, 0, 'a double-release must be a safe no-op, never negative count or a throw');
});

// ---------------------------------------------------------------------------
// advanceProjectiles: lifetime expiry with no physics available degrades to
// a clean no-op rather than throwing (matches the "degrade, don't throw,
// when an optional dep is missing" convention this codebase already uses
// elsewhere for an absent sibling subsystem).
// ---------------------------------------------------------------------------

test('advanceProjectiles: absent physics is a guarded no-op, not a throw', () => {
  const pool = new ProjectilePool(4);
  pool.spawnProjectile(makeSpec());
  assert.doesNotThrow(() => advanceProjectiles(pool, 1 / 60, { physics: null, actors: null, combat: null, events: null }));
  assert.equal(pool.count, 1, 'with no physics, nothing should have changed');
});

test('advanceProjectiles: a projectile expires (and is released) once its lifetime runs out, even with no physics to sweep against', () => {
  // A degenerate stand-in physics whose sweepProjectile always reports a
  // miss — isolates lifetime expiry from the sweep/hit machinery, which
  // bolt.test.js's own real-boot() tests already exercise end to end.
  const missPhysics = {
    MASK: { HOSTILE_TO_PLAYER: 4, HOSTILE_TO_MONSTER: 2, WORLD: 1 },
    sweepProjectile(x, z, dx, dz, radius, mask, excludeId, out) {
      out.hit = false;
      return out;
    },
  };
  const deps = { physics: missPhysics, actors: null, combat: null, events: null };

  const pool = new ProjectilePool(4);
  const id = pool.spawnProjectile(makeSpec({ lifetime: 0.05 })); // 3 ticks at 60 Hz
  assert.ok(id > 0);

  advanceProjectiles(pool, 1 / 60, deps);
  advanceProjectiles(pool, 1 / 60, deps);
  assert.equal(pool.count, 1, 'must still be alive before its lifetime is exhausted');

  advanceProjectiles(pool, 1 / 60, deps);
  advanceProjectiles(pool, 1 / 60, deps);
  assert.equal(pool.count, 0, 'must have expired (and been released) once its lifetime ran out');
});
