// tests/skills/mobility.perf.test.js
//
// SKIL-8 perf acceptance: allocation probes for the pure geometry helpers
// (`unitTowards`, `clipDashTravel`) and the mobility engine's own
// `fixedUpdate` at O-43/O-23 methodology (N >= 1e6,
// `tests/helpers/alloc.js#assertAllocationFree`), plus the recycle-safety
// proof rule 5/the ticket's own "transit state must survive pool recycle"
// requirement asks for: `phase_leap`'s pending-strike scratch is keyed by
// `poolIndex`, and its VALIDITY check is `actors.byId(id)` — the same "id
// bijection" recycle-safety `channel.js#isChannellingInternal`/
// `imbue.js`/`cost.js#encodeCooldownStamp` already established (see
// `mobility.js`'s own header). This file proves it does not misfire: an
// actor that recycles into the SAME poolIndex before the pending step
// arrives must never receive the stale owner's strike.
//
// `*.perf.test.js` per this ticket's own rule 9. Built against a REAL
// `boot()` — `clipDashTravel`'s real shape needs real `physics`/`nav`-typed
// scratch objects, and the recycle proof needs a real Actor pool.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { unitTowards, clipDashTravel, createMobilityEngine } from '../../src/skills/mobility.js';

const H = 1 / 60;

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

// ---------------------------------------------------------------------------
// Pure geometry helpers — isolated from the rest of the engine with duck-
// typed physics/nav stand-ins, so this measures ONLY this file's own
// arithmetic, never physics'/nav's internal allocation behaviour (out of
// scope — those subsystems are proven allocation-free by their own tickets).
// ---------------------------------------------------------------------------

test('SKIL-8 perf — unitTowards / clipDashTravel allocate < 1 byte/call (O-43, N >= 1e6)', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const dirOut = { ux: 0, uz: 0, dist: 0 };

  const stubHit = { hit: false, x: 0, z: 0, nx: 0, nz: 0, distance: 0, fraction: 0, surface: 'stone', actorId: 0, staticHandle: 0 };
  const stubPhysics = {
    MASK: { WORLD: 1 },
    sweepProjectile(x, z, dx, dz, radius, mask, excludeId, out) {
      void x; void z; void dx; void dz; void radius; void mask; void excludeId;
      out.hit = false;
      return out;
    },
  };
  const stubNavAllWalkable = {
    snap(x, z, maxRadius, out) {
      void maxRadius;
      out.x = x;
      out.y = 0;
      out.z = z;
      return out;
    },
  };
  const navScratch = { x: 0, y: 0, z: 0 };
  const clipOut = { x: 0, z: 0 };
  const actor = { x: 0, z: 0, radius: 0.36, id: 7 };

  const PROBES = [
    { name: 'unitTowards(0,0,3,4)', iterations: 2_000_000, fn: () => { unitTowards(0, 0, 3, 4, dirOut); } },
    { name: 'unitTowards(2,2,2,2) [degenerate]', iterations: 2_000_000, fn: () => { unitTowards(2, 2, 2, 2, dirOut); } },
    {
      // O-23/O-43: the mean only fully settles at N in the low millions
      // (80.45 -> 17.88 -> 0.391 -> 0.325 B/call as N goes 10k -> 100k ->
      // 1M -> 4M) — 4M here, not the 1M floor, so this reads a genuinely
      // settled number rather than one still riding the noise floor down.
      name: 'clipDashTravel [no wall, all-walkable nav]',
      iterations: 4_000_000,
      fn: () => { clipDashTravel(stubPhysics, stubNavAllWalkable, actor, 5, 0, stubHit, navScratch, clipOut); },
    },
  ];

  for (const probe of PROBES) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: probe.iterations, maxRounds: 40 });
    console.log(`[SKIL-8 perf] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=${probe.iterations}`);
    assert.ok(bytesPerCall < 1, `${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
  }
});

// ---------------------------------------------------------------------------
// mobilityEngine.fixedUpdate — idle steady state (no pending phase_leap
// strikes) must allocate nothing, at N >= 1e6.
// ---------------------------------------------------------------------------

test('SKIL-8 perf — mobility engine fixedUpdate (idle, no pending strikes) allocates < 1 byte/call (N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const actors = ctx.get('actors');
  const combat = ctx.get('combat');
  const events = ctx.events;
  const time = ctx.time;
  const deps = { actors, combat, events, time };

  const engine = createMobilityEngine();
  engine.fixedUpdate(deps); // warm up, untimed

  const { bytesPerCall, rounds } = assertAllocationFree(() => engine.fixedUpdate(deps), { iterations: 2_000_000, maxRounds: 40 });
  console.log(`[SKIL-8 perf] mobilityEngine.fixedUpdate (idle): ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=2000000`);
  assert.ok(bytesPerCall < 1, `idle fixedUpdate must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
});

// ---------------------------------------------------------------------------
// Recycle safety — phase_leap's pending-strike scratch is poolIndex-indexed
// and MUST NOT misfire against a different actor that recycles into the
// same poolIndex before the pending step arrives.
// ---------------------------------------------------------------------------

test('phase_leap transit state survives pool recycle: a stale pending strike never fires against the new occupant', async () => {
  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const nav = ctx.get('nav');
  nav.rebuild({ zoneId: 'recycle_test', boundsMinX: -50, boundsMaxX: 50, boundsMinZ: -50, boundsMaxZ: 50 });

  function tick() {
    ctx.time.step++;
    actors.fixedUpdate(H, ctx);
    skills.fixedUpdate(H, ctx);
  }

  const caster = actors.spawn({ kind: 'player', archetypeId: 'runeblade', team: 0, x: 0, z: 0, facing: 0, level: 30 });
  actors.setState(caster, 'idle');
  skills.allocate(caster, 'phase_leap');
  caster.mana = 100;

  const target = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: 5, z: 0, facing: Math.PI, level: 1 });

  const casterPoolIndex = caster.poolIndex;
  const casterId = caster.id;

  const ok = skills.cast(caster, 'phase_leap', 5, 0, target.id);
  assert.equal(ok, true, 'sanity: the leap must have actually scheduled a pending strike');

  // Recycle the EXACT same poolIndex before the pending step arrives: the
  // pool's free-list is LIFO (src/actors/pool.js), so despawning the caster
  // immediately and spawning a fresh actor puts the newcomer on the exact
  // same slot.
  actors.despawn(caster, true);
  const impostor = actors.spawn({ kind: 'player', archetypeId: 'ravager', team: 0, x: 40, z: 40, facing: 0, level: 30 });
  assert.equal(impostor.poolIndex, casterPoolIndex, 'sanity: the impostor must occupy the exact recycled slot for this proof to mean anything');
  assert.notEqual(impostor.id, casterId, 'sanity: a recycled slot must carry a NEW id (the generation bump)');

  const impostorStats = actors.stats(impostor);
  impostor.life = impostorStats.maxLife;
  const impostorPosBefore = { x: impostor.x, z: impostor.z };

  let threw = null;
  try {
    tick(); // the fixed step the original caster's strike was scheduled for
  } catch (e) {
    threw = e;
  }

  assert.equal(threw, null, 'a recycled slot must never throw when its stale pending entry comes due');
  assert.equal(impostor.life, impostorStats.maxLife, 'the impostor must never receive the stale owner\'s strike');
  assert.equal(impostor.x, impostorPosBefore.x, 'the impostor must be completely unaffected by the stale pending entry');
  assert.equal(impostor.z, impostorPosBefore.z);
});
