// tests/skills/ground.perf.test.js
//
// SKIL-9 — allocation probes for `advanceGroundEffects` (the per-step
// bookkeeping every live ground effect runs through, `src/skills/
// ground.js`) and for the `addGroundEffect`/`removeGroundEffect` churn on
// the pool's own small, fixed-capacity free list (O-43/O-23 methodology,
// N >= 1e6 for the churn probe; `tests/skills/projectile.perf.test.js`'s own
// two-tier convergence precedent for the per-step probe, since that is a
// per-STEP measurement over many live effects at once, not a cheap single
// call). Rule 12 — also proves the work was done: the live effect count is
// asserted unchanged across the timed run, not just that time elapsed.
//
// Isolated from `physics`/`combat`/`actors`/`nav` deliberately — every tick
// handler and `absorbProjectiles` in `ground.js` early-returns the instant
// any of `physics`/`combat`/`actors` is falsy (the same "degrade against a
// missing dependency" guard every other engine in this subsystem uses), so
// passing `null` for all three isolates this measurement to `ground.js`'s
// OWN per-slot bookkeeping (lifetime countdown, the tick-cadence
// comparison) — never a real subsystem's own separately-gated allocation
// behaviour.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { GroundEffectPool, addGroundEffect, removeGroundEffect, advanceGroundEffects } from '../../src/skills/ground.js';

const H = 1 / 60;
const LIVE_COUNT = 32;
const POOL_CAPACITY = 64;

/** A `nav` stand-in that counts calls but allocates nothing itself — a
 * closure over a primitive counter, same "cheap stand-in, not the real
 * subsystem" precedent `projectile.perf.test.js`'s own `makeMissPhysics`
 * establishes. */
function makeCountingNav() {
  let calls = 0;
  return { markHazard() { calls++; }, get calls() { return calls; } };
}

// ===========================================================================
// advanceGroundEffects — per-step steady state over LIVE_COUNT live effects
// ===========================================================================

test('12.Skill9 — advanceGroundEffects over 32 live effects allocates < 1 byte/step (O-43 methodology, two-tier convergence)', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const pool = new GroundEffectPool(POOL_CAPACITY);
  const nav = makeCountingNav();
  const time = { step: 0 };
  const deps = { physics: null, combat: null, actors: null, nav, time, skills: null, projectilePool: null };

  // Half circle-shaped (meteor/ashen_step-style), half line-shaped (ash_wall
  // -style) — long lifetimes so nothing expires mid-measurement, rule 12's
  // own "count what was actually done" proof below only holds if the
  // population genuinely stays at LIVE_COUNT for the whole run.
  for (let i = 0; i < LIVE_COUNT; i++) {
    const isLine = i % 2 === 0;
    const id = addGroundEffect(pool, {
      skillId: isLine ? 'ash_wall' : 'meteor',
      level: 20, x: i * 10, z: 0,
      shape: isLine ? 'line' : 'circle',
      radius: 3.2, facing: 0, lengthM: 6.0, thicknessM: 1.6,
      seconds: 1e9, tickSteps: 15,
      hazard: true, blocksProjectiles: isLine,
      ownerId: 1, team: 0,
    }, deps);
    assert.ok(id > 0, `spawn ${i} must succeed`);
  }
  assert.equal(pool.count, LIVE_COUNT, 'rule 12 — the population actually being simulated, confirmed before any timed measurement');

  const oneStep = () => { time.step++; advanceGroundEffects(pool, H, deps); };

  const FAST_ITERATIONS = 50_000;
  const FAST_MAX_ROUNDS = 10;
  const SLOW_ITERATIONS = 500_000;
  const SLOW_MAX_ROUNDS = 15;

  const t0 = Date.now();
  let bytesPerCall, rounds, samples, tierUsed = 'fast';
  try {
    ({ bytesPerCall, rounds, samples } = assertAllocationFree(oneStep, { iterations: FAST_ITERATIONS, maxRounds: FAST_MAX_ROUNDS, threshold: 1 }));
  } catch (fastTierError) {
    console.log(`[SKIL-9 ground perf] fast tier (N=${FAST_ITERATIONS}) did not converge — escalating to slow tier (N=${SLOW_ITERATIONS}); fast-tier error: ${fastTierError.message}`);
    tierUsed = 'slow';
    ({ bytesPerCall, rounds, samples } = assertAllocationFree(oneStep, { iterations: SLOW_ITERATIONS, maxRounds: SLOW_MAX_ROUNDS, threshold: 1 }));
  }
  const wallMs = Date.now() - t0;
  const iterationsUsed = tierUsed === 'fast' ? FAST_ITERATIONS : SLOW_ITERATIONS;

  // Rule 12 — confirmed unchanged right after the timed measurement too, so
  // the "< 1 byte/step" figure is honestly a per-32-live-effect figure, not
  // an artifact of the population having quietly shrunk to 0 partway
  // through (every tick handler early-returns against the null physics/
  // combat/actors above without touching `_life`/`_active`, and nothing
  // here ever calls removeGroundEffect).
  assert.equal(pool.count, LIVE_COUNT, `rule 12 — ${LIVE_COUNT} effects must still be live and were genuinely advanced on every one of the ${rounds * iterationsUsed} measured calls`);
  assert.ok(nav.calls > 0, 'sanity — the nav stand-in must have actually been called at spawn time (hazard registration happened)');

  console.log(`[SKIL-9 ground perf] ${bytesPerCall.toFixed(4)} B/step over ${LIVE_COUNT} live ground effects, converged in ${rounds} round(s) @ N=${iterationsUsed} (${tierUsed} tier), wall time ${wallMs} ms`);
  console.log(`[SKIL-9 ground perf] samples: ${samples.map((s) => s.toFixed(4)).join(', ')}`);

  assert.ok(bytesPerCall < 1, `advanceGroundEffects over ${LIVE_COUNT} live effects must allocate < 1 byte/step; got ${bytesPerCall.toFixed(4)} (tier ${tierUsed}, N=${iterationsUsed}, rounds ${rounds})`);
});

// ===========================================================================
// addGroundEffect / removeGroundEffect churn on the pool's own free list —
// O-43 methodology, N >= 1e6, after a one-time warm-up (mirrors
// tests/skills/cost.perf.test.js's own "the only genuine allocation is the
// first insertion, bounded" precedent for a small, bounded, recycled
// structure).
// ===========================================================================

test('12.Skill9 — addGroundEffect + removeGroundEffect churn allocates < 1 byte/call after warm-up (O-43, N >= 1e6)', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const pool = new GroundEffectPool(8);
  const nav = makeCountingNav();
  const time = { step: 0 };
  const deps = { physics: null, combat: null, actors: null, nav, time, skills: null, projectilePool: null };

  const spec = {
    skillId: 'ashen_step', level: 1, x: 0, z: 0, shape: 'circle',
    radius: 2.5, seconds: 4.0, tickSteps: 30, hazard: false,
    ownerId: 1, team: 0,
  };

  const churn = () => {
    const id = addGroundEffect(pool, spec, deps);
    removeGroundEffect(pool, id, deps);
  };

  const { bytesPerCall, rounds, samples } = assertAllocationFree(churn, { iterations: 1_000_000, maxRounds: 20, threshold: 1 });

  console.log(`[SKIL-9 ground perf] addGroundEffect+removeGroundEffect churn: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=1,000,000`);
  console.log(`[SKIL-9 ground perf] samples: ${samples.map((s) => s.toFixed(4)).join(', ')}`);

  assert.equal(pool.count, 0, 'rule 12 — the pool returns to its exact starting occupancy after every add+remove pair');
  assert.ok(bytesPerCall < 1, `addGroundEffect+removeGroundEffect churn must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
});
