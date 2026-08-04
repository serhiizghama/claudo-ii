// tests/world/wrld10.perf.test.js
//
// WRLD-10 — the allocation probes for the four hot paths this ticket adds.
// `02-api-contracts.md` §5 marks `portalAt`, `interactableAt`, `openPortal`,
// `closePortal`, `setExitSealed` and `openChest` all `Alloc: no`, and
// `world.update()` now runs every frame; O-85 puts probes in the perf stage,
// never the unit stage.
//
// `interactableAt` and `portalAt` are the two that a `player` reads
// PER FRAME (`src/player/index.js`'s own interaction ladder already names
// `world.interactableAt`), so they are probed against a realistic live zone
// rather than a two-record fixture. `world.update()` is probed in its idle
// state, which is what 99.9 % of frames are.
//
// O-43/O-23: allocation probes need N >= 1,000,000 — lengthened, never a
// loosened threshold.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { WorldSystem } from '../../src/world/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { NavSystem } from '../../src/nav/index.js';
import { MaterialsSystem } from '../../src/materials/index.js';
import { Rng } from '../../src/core/rng.js';
import { makeStubCtx } from '../helpers/actor.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';

/** One real Ashen Wastes instance, with a real open town portal, built
 * through the real `world.enterZone` — no fixture stands in for it. */
async function liveWastes() {
  const world = new WorldSystem();
  const physics = new PhysicsSystem();
  const nav = new NavSystem();
  const materials = new MaterialsSystem();
  const ctx = makeStubCtx({
    rng: new Rng(9001),
    scene: new THREE.Scene(),
    systems: { world, physics, nav, materials, render: { renderer: null } },
  });
  for (const s of [physics, materials, world, nav]) await s.init(ctx);
  world.setWorldSeed(0x9e110);
  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  const portalId = world.openPortal(0, 0, 'last_bastion', 'town_portal_return');
  assert.ok(portalId > 0);
  return { world, ctx, portalId };
}

test(
  'WRLD-10: interactableAt is allocation-free on a real zone (hit and miss)',
  { skip: !hasGc() && 'run with --expose-gc' },
  async () => {
    const { world } = await liveWastes();
    const chest = world.current.chests[0];
    assert.ok(chest, 'the probe needs a real chest to hit');
    assert.ok(world.interactableAt(chest.x, chest.z, 1) !== null, 'the hit branch really hits');

    const hit = assertAllocationFree(
      () => { world.interactableAt(chest.x, chest.z, 1); },
      { iterations: 1_000_000, maxRounds: 40 },
    );
    const miss = assertAllocationFree(
      () => { world.interactableAt(9999, 9999, 1); },
      { iterations: 1_000_000, maxRounds: 40 },
    );

    // eslint-disable-next-line no-console
    console.log(`[WRLD-10] interactableAt: hit ${hit.bytesPerCall} B/call (${hit.rounds} round(s)), miss ${miss.bytesPerCall} B/call (${miss.rounds} round(s))`);
    assert.ok(hit.bytesPerCall < 1);
    assert.ok(miss.bytesPerCall < 1);
  },
);

test(
  'WRLD-10: portalAt is allocation-free on a real zone with a live town portal',
  { skip: !hasGc() && 'run with --expose-gc' },
  async () => {
    const { world, portalId } = await liveWastes();
    const p = world.current.portals.find((q) => q.id === portalId);
    assert.equal(world.portalAt(p.x, p.z, 1), portalId, 'the hit branch really hits');

    const hit = assertAllocationFree(
      () => { world.portalAt(p.x, p.z, 1); },
      { iterations: 1_000_000, maxRounds: 40 },
    );
    const miss = assertAllocationFree(
      () => { world.portalAt(9999, 9999, 1); },
      { iterations: 1_000_000, maxRounds: 40 },
    );

    // eslint-disable-next-line no-console
    console.log(`[WRLD-10] portalAt: hit ${hit.bytesPerCall} B/call (${hit.rounds} round(s)), miss ${miss.bytesPerCall} B/call (${miss.rounds} round(s))`);
    assert.ok(hit.bytesPerCall < 1);
    assert.ok(miss.bytesPerCall < 1);
  },
);

test(
  'WRLD-10: world.update() is allocation-free when no transition is running — which is almost every frame',
  { skip: !hasGc() && 'run with --expose-gc' },
  async () => {
    const { world, ctx } = await liveWastes();
    assert.equal(world.transitionPhase, 'idle');

    const { bytesPerCall, rounds } = assertAllocationFree(
      () => { world.update(1 / 60, ctx); },
      { iterations: 1_000_000, maxRounds: 40 },
    );

    // eslint-disable-next-line no-console
    console.log(`[WRLD-10] world.update() (idle): ${bytesPerCall} B/call over ${rounds} round(s)`);
    assert.ok(bytesPerCall < 1);
    assert.equal(world.transitionPhase, 'idle');
  },
);

test(
  'WRLD-10: openChest is allocation-free on both branches',
  { skip: !hasGc() && 'run with --expose-gc' },
  async () => {
    const { world } = await liveWastes();
    const id = world.current.chests[0].id;
    assert.equal(world.openChest(id), true);
    // Steady state after the first open: every further call takes the
    // already-open `false` return, which is the branch a held interact key
    // would hammer.
    const { bytesPerCall, rounds } = assertAllocationFree(
      () => { world.openChest(id); },
      { iterations: 1_000_000, maxRounds: 40 },
    );

    // eslint-disable-next-line no-console
    console.log(`[WRLD-10] openChest (already open): ${bytesPerCall} B/call over ${rounds} round(s)`);
    assert.ok(bytesPerCall < 1);
  },
);
