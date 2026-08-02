// tests/skills/projectile.perf.test.js
//
// SKIL-4 — the projectile flight loop (`advanceProjectiles`,
// `src/skills/projectile.js`) is this ticket's own "hottest loop in the
// milestone" (the orchestrator's own words): every live projectile, every
// fixed step. This file proves it is genuinely `Alloc: no` at scale
// (O-43 methodology — N >= 1e6 for a cheap call; this is a per-STEP probe
// over many live projectiles at once, so it follows `tests/core/
// alloc.test.js`'s own `12.A02` two-tier convergence precedent instead of a
// single fixed huge N) — and, per this ticket's own rule 12 ("also prove
// the work was done — count the projectiles actually simulated, not just
// the elapsed time"), asserts the live projectile count actually being
// advanced on every measured call, not merely that time elapsed.
//
// Isolated from `physics`/`combat`/`actors` deliberately: a stand-in
// `sweepProjectile` that always reports a miss (and allocates nothing
// itself — a closure over primitives, mutating a caller-owned `out`) keeps
// this measurement about `projectile.js`'s OWN flight bookkeeping (typed-
// array writes, the per-slot loop, lifetime countdown), not about
// `physics`'s own already-separately-gated allocation behaviour
// (`tests/physics/phys5.test.js` covers `sweepProjectile` itself). A real
// end-to-end flight-with-hits scenario is covered functionally (not timed)
// by `tests/skills/bolt.test.js`'s pierce test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { ProjectilePool, advanceProjectiles } from '../../src/skills/projectile.js';

const H = 1 / 60;
const LIVE_COUNT = 64;
const POOL_CAPACITY = 128;

/** Always-miss `physics` stand-in — see the file header for why. */
function makeMissPhysics() {
  return {
    MASK: { HOSTILE_TO_PLAYER: 4, HOSTILE_TO_MONSTER: 2, WORLD: 1 },
    sweepProjectile(x, z, dx, dz, radius, mask, excludeId, out) {
      out.hit = false;
      return out;
    },
  };
}

test('12.Skill4 — advanceProjectiles over 64 live projectiles allocates < 1 byte/step (O-43 methodology, two-tier convergence)', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const pool = new ProjectilePool(POOL_CAPACITY);
  const deps = { physics: makeMissPhysics(), actors: null, combat: null, events: null };

  // Long lifetimes and small speeds keep the whole population alive and
  // bouncing around the origin for the entire measurement — the sweep
  // always misses (the stand-in above), so nothing ever resolves a hit or
  // expires mid-measurement; every measured call genuinely advances
  // LIVE_COUNT live projectiles, not a shrinking population.
  for (let i = 0; i < LIVE_COUNT; i++) {
    const angle = (i / LIVE_COUNT) * Math.PI * 2;
    const id = pool.spawnProjectile({
      x: 0, z: 0, dirX: Math.cos(angle), dirZ: Math.sin(angle),
      speed: 1, lifetime: 1e9, radius: 0.30,
      pierce: false, mask: 4 | 1,
      sourceId: 1, sourceGen: 0, team: 0,
      skillId: 'ember_bolt', level: 20,
      alwaysHits: true,
    });
    assert.ok(id > 0, `spawn ${i} must succeed`);
  }
  assert.equal(pool.count, LIVE_COUNT, 'rule 12 — the population actually being simulated, confirmed before any timed measurement');

  const oneStep = () => { advanceProjectiles(pool, H, deps); };

  const FAST_ITERATIONS = 50_000;
  const FAST_MAX_ROUNDS = 10;
  const SLOW_ITERATIONS = 500_000;
  const SLOW_MAX_ROUNDS = 15;

  const t0 = Date.now();
  let bytesPerCall, rounds, samples, tierUsed = 'fast';
  try {
    ({ bytesPerCall, rounds, samples } = assertAllocationFree(oneStep, { iterations: FAST_ITERATIONS, maxRounds: FAST_MAX_ROUNDS, threshold: 1 }));
  } catch (fastTierError) {
    console.log(`[SKIL-4 projectile perf] fast tier (N=${FAST_ITERATIONS}) did not converge — escalating to slow tier (N=${SLOW_ITERATIONS}); fast-tier error: ${fastTierError.message}`);
    tierUsed = 'slow';
    ({ bytesPerCall, rounds, samples } = assertAllocationFree(oneStep, { iterations: SLOW_ITERATIONS, maxRounds: SLOW_MAX_ROUNDS, threshold: 1 }));
  }
  const wallMs = Date.now() - t0;
  const iterationsUsed = tierUsed === 'fast' ? FAST_ITERATIONS : SLOW_ITERATIONS;

  // Rule 12 — the count of projectiles actually simulated, not just the
  // elapsed time: confirmed unchanged (nothing expired/resolved mid-run —
  // the always-miss stand-in guarantees it) right after the timed
  // measurement too, so the "< 1 byte/step" figure above is honestly a
  // per-64-live-projectile figure, not an artifact of the population
  // having quietly shrunk to 0 partway through.
  assert.equal(pool.count, LIVE_COUNT, `rule 12 — ${LIVE_COUNT} projectiles must still be live and were genuinely advanced on every one of the ${rounds * iterationsUsed} measured calls, not just elapsed time`);

  console.log(`[SKIL-4 projectile perf] ${bytesPerCall.toFixed(4)} B/step over ${LIVE_COUNT} live projectiles, converged in ${rounds} round(s) @ N=${iterationsUsed} (${tierUsed} tier), wall time ${wallMs} ms`);
  console.log(`[SKIL-4 projectile perf] samples: ${samples.map((s) => s.toFixed(4)).join(', ')}`);

  assert.ok(bytesPerCall < 1, `advanceProjectiles over ${LIVE_COUNT} live projectiles must allocate < 1 byte/step; got ${bytesPerCall.toFixed(4)} (tier ${tierUsed}, N=${iterationsUsed}, rounds ${rounds})`);
});
