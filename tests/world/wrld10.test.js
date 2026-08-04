// tests/world/wrld10.test.js
//
// WRLD-10 acceptance — `07-world-gen.md` §10 (transitions, retention, the
// town portal) and §12 row 11.
//
// ---------------------------------------------------------------------------
// O-106's rule, applied literally
// ---------------------------------------------------------------------------
// "A harness shaped like the pipeline is not the pipeline." Every retention,
// spawn and timing number below comes from
//
//   world.setWorldSeed(seed)
//     -> world.enterZone(zoneId, entryTag, { runIndex })          [directly]
//   or
//   world.beginTransition(...) -> world.update(dt, ctx)
//     -> world.requestZone(...)          (the WRLD-4 latch, unchanged)
//       -> world.serviceZoneRequest()    (the engine's own phase-4b call)
//         -> the SAME world.enterZone
//
// and never from a reimplementation of either. `ai` is stood up by these
// tests themselves because `AiSystem` is not registered in `src/main.js`
// (O-112) — the spawn numbers below therefore come from `AiSystem`'s own
// `zone:ready` listener running `runSpawnPass`, exactly as it would in a
// build where main.js registered it.
//
// Every millisecond printed by the ten-leg run is a real `performance.now()`
// delta measured in THIS FILE around a real `enterZone`, and the call that
// produced it is named in the printed line. Hardware-dependent: these are
// wall-clock numbers off one developer machine, single-threaded Node, no
// GPU work (there is no WebGL context in Node, so T7's buffer uploads do not
// happen here and the real browser figure will be larger — §10.3 budgets
// T7 at 214 ms of the 600 ms black window on its own).
//
// Node-safe apart from `three`, which `world`'s T7 geometry build needs; the
// same import the WRLD-6..9 and AI-7 real-pipeline tests already carry.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { WorldSystem } from '../../src/world/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { NavSystem } from '../../src/nav/index.js';
import { MaterialsSystem } from '../../src/materials/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { CombatSystem } from '../../src/combat/packet.js';
import { AiSystem } from '../../src/ai/index.js';
import { ItemsSystem } from '../../src/items/index.js';
import { Rng } from '../../src/core/rng.js';
import { makeStubCtx } from '../helpers/actor.js';

import {
  TRANSITION_MS,
  TOWN_PORTAL_PAD,
  PORTAL_RETURN_TAG,
  TOWN_PORTAL_RETURN_OFFSET_Z,
  RETAINED_FIELD_CAP,
  createTransitionState,
  retentionKey,
  normalizeChests,
  interactableAt,
  openChest,
  portalAt,
} from '../../src/world/transition.js';

// ===========================================================================
// The one harness — every real-pipeline test below boots through this
// ===========================================================================

/**
 * Boots the same subsystem set `src/main.js` boots, plus `ai` (O-112:
 * `AiSystem` is not registered there, so nothing under `src/ai/` runs in the
 * real application and a test that wants a spawn pass must register it
 * itself). No `render` — `world` only needs `ctx.scene` and `materials`.
 */
async function boot(rngSeed) {
  const world = new WorldSystem();
  const physics = new PhysicsSystem();
  const nav = new NavSystem();
  const materials = new MaterialsSystem();
  const actors = new ActorsSystem();
  const combat = new CombatSystem();
  const ai = new AiSystem();
  const items = new ItemsSystem();
  const scene = new THREE.Scene();
  const ctx = makeStubCtx({
    rng: new Rng(rngSeed),
    scene,
    systems: { world, physics, nav, materials, actors, combat, ai, items, render: { renderer: null } },
  });
  for (const s of [physics, materials, actors, combat, items, world, nav, ai]) await s.init(ctx);
  return { world, physics, nav, materials, actors, combat, ai, items, ctx };
}

/** Kills every member of `pack` through the real `actor:death` event `combat`
 * emits — which is the listener `02-api-contracts.md` §5 gives `world`. */
function killPack(ctx, actors, pack) {
  for (const ref of pack.members.slice()) {
    const actor = actors.all.find((a) => a.id === ref.id) || { id: ref.id, kind: 'monster', rank: 'normal' };
    ctx.events.emit('actor:death', { actor, killer: null, point: { x: actor.x || 0, y: 0, z: actor.z || 0 } });
  }
}

// ===========================================================================
// 1 — the envelope (§10.1)
// ===========================================================================

test('WRLD-10 §10.1: the envelope is 350 / 600 / 350, and §10.1\'s own "total" does not sum to it', () => {
  assert.equal(TRANSITION_MS.fadeOut, 350);
  assert.equal(TRANSITION_MS.black, 600);
  assert.equal(TRANSITION_MS.fadeIn, 350);
  assert.equal(TRANSITION_MS.hardFail, 2500);
  // The discrepancy is real and is reported, not papered over: §10.1 prints
  // "Target total: <= 1 100 ms" beside stage numbers that sum to 1 300.
  assert.equal(TRANSITION_MS.envelopeTotal, TRANSITION_MS.fadeOut + TRANSITION_MS.black + TRANSITION_MS.fadeIn);
  assert.equal(TRANSITION_MS.statedTotal, 1100);
  assert.notEqual(TRANSITION_MS.envelopeTotal, TRANSITION_MS.statedTotal);
});

test('WRLD-10 §10.1/§10.2: beginTransition -> update() drives fade-out, a constant-600 ms black, fade-in — and the zone change goes through the WRLD-4 latch, not a second enterZone', async () => {
  const { world, ctx } = await boot(101);
  world.setWorldSeed(0x51a7);
  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });

  // The latch is the ONLY way this state machine changes zones (D-66).
  let latched = 0;
  const realRequest = world.requestZone.bind(world);
  world.requestZone = (...args) => { latched++; return realRequest(...args); };

  assert.equal(world.transitionPhase, 'idle');
  assert.equal(world.beginTransition('ashen_wastes', 'portal_from_town', { runIndex: 0 }), true);
  assert.equal(world.beginTransition('bonereach', 'descent'), false, 'one transition at a time');

  const phases = { fade_out: 0, black: 0, fade_in: 0 };
  let fadeAtBlackStart = -1;
  let zoneAtBlackStart = '';
  const DT = 1 / 60;
  let frames = 0;
  while (world.transitionPhase !== 'idle' && frames < 1000) {
    ctx.time.raw = DT;
    world.update(DT, ctx);              // presentation — never fixedUpdate
    world.serviceZoneRequest();          // the engine's phase-4b call, verbatim
    if (world.transitionPhase !== 'idle') phases[world.transitionPhase] += DT * 1000;
    if (world.transitionPhase === 'black' && fadeAtBlackStart < 0) {
      fadeAtBlackStart = world.transitionFade;
      zoneAtBlackStart = world.current.zoneId;
    }
    frames++;
  }

  assert.equal(latched, 1, 'exactly one requestZone — the transition never calls enterZone itself');
  assert.equal(fadeAtBlackStart, 1, 'the screen is fully black before any teardown happens');
  assert.equal(zoneAtBlackStart, 'ashen_wastes', 'the zone change lands inside the black window');
  assert.equal(world.current.zoneId, 'ashen_wastes');
  assert.equal(world.transitionFade, 0, 'fully visible again at the end');

  const leg = world.transitionTiming;
  assert.equal(leg.complete, true);
  assert.equal(leg.hardFail, false);
  for (const [k, budget] of [['fadeOutMs', TRANSITION_MS.fadeOut], ['blackMs', TRANSITION_MS.black], ['fadeInMs', TRANSITION_MS.fadeIn]]) {
    assert.ok(leg[k] >= budget, `${k}=${leg[k]} must reach its ${budget} ms floor`);
    assert.ok(leg[k] < budget + 1000 / 60 + 1e-6, `${k}=${leg[k]} must not overshoot ${budget} ms by more than one frame`);
  }
  assert.ok(Math.abs(leg.totalMs - TRANSITION_MS.envelopeTotal) < 1000 / 60 * 3,
    `total ${leg.totalMs} ms must land on the 350/600/350 envelope`);
  // eslint-disable-next-line no-console
  console.log(`  [WRLD-10 §10.1] envelope through world.beginTransition -> world.update -> world.serviceZoneRequest: `
    + `fadeOut=${leg.fadeOutMs.toFixed(1)} black=${leg.blackMs.toFixed(1)} fadeIn=${leg.fadeInMs.toFixed(1)} total=${leg.totalMs.toFixed(1)} ms (engine time)`);
});

test('WRLD-10 §10.1: control is disabled for the whole window and re-enabled only at the end', async () => {
  const { world, ctx } = await boot(102);
  world.setWorldSeed(0x51a8);
  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });

  const log = [];
  const player = { setControlEnabled: (on) => log.push(on) };
  const realPeek = ctx.peek;
  ctx.peek = (id) => (id === 'player' ? player : realPeek(id));

  world.beginTransition('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  assert.deepEqual(log, [false], 'T1 disables control before the fade starts');

  const DT = 1 / 60;
  for (let i = 0; i < 200 && world.transitionPhase !== 'idle'; i++) {
    ctx.time.raw = DT;
    world.update(DT, ctx);
    world.serviceZoneRequest();
    if (world.transitionPhase !== 'idle') assert.deepEqual(log, [false], 'control stays disabled for the whole window');
  }
  assert.deepEqual(log, [false, true], 'T15 re-enables control exactly once, at the end');
});

// ===========================================================================
// 2 — retention keyed by (zoneId, seed)  (§10.4 / §13 "Not requested")
// ===========================================================================

test('WRLD-10 §10.4: a retained instance is keyed by (zoneId, seed); the town is retained from its first entry and the cap is town + 1 field zone', async () => {
  const { world } = await boot(200);
  world.setWorldSeed(0xbeef01);

  assert.deepEqual(world.retainedZoneKeys, [], 'nothing is retained before the first zone change');
  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });
  const townSeed = world.seedFor('last_bastion', 0);

  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  assert.deepEqual(world.retainedZoneKeys, [retentionKey('last_bastion', townSeed)],
    'the town is retained; the field zone is not retained until a portal is opened');

  const wastesSeed = world.current.seed;
  world.openPortal(0, 0, 'last_bastion', 'town_portal_return');
  await world.enterZone('last_bastion', 'town_portal_return', { runIndex: 0 });
  assert.deepEqual(world.retainedZoneKeys.sort(), [
    retentionKey('ashen_wastes', wastesSeed),
    retentionKey('last_bastion', townSeed),
  ].sort(), 'leaving a field zone through the town portal retains it');
  assert.equal(world.retainedZoneKeys.length, 1 + RETAINED_FIELD_CAP);
});

test('WRLD-10 §10.4: a retained re-entry SKIPS T6 — the generator is not re-run and the layout objects are the very same references', async () => {
  const { world } = await boot(201);
  world.setWorldSeed(0xbeef02);
  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 3 });

  const layoutBefore = world._wastesLayout;
  const dressingBefore = world._wastesDressing;
  const instanceBefore = world.current;
  const seedBefore = instanceBefore.seed;

  world.openPortal(0, 0, 'last_bastion', 'town_portal_return');
  await world.enterZone('last_bastion', 'town_portal_return', { runIndex: 0 });
  await world.enterZone('ashen_wastes', PORTAL_RETURN_TAG, { runIndex: 3 });

  assert.equal(world.current.seed, seedBefore, 'same runIndex -> same seed -> the retained instance');
  assert.equal(world._wastesLayout, layoutBefore, 'T6 skipped: the SAME layout object, not an equal one');
  assert.equal(world._wastesDressing, dressingBefore, 'T6 skipped: the SAME dressing object');
  assert.notEqual(world.current, instanceBefore, 'T7-T9 still re-run, so the live ZoneInstance is rebuilt');
  assert.ok(world._retainReport, 'the retained path was taken');
});

test('WRLD-10 §10.4: a DIFFERENT runIndex misses the retained record and regenerates (the exit/descent case)', async () => {
  const { world } = await boot(202);
  world.setWorldSeed(0xbeef03);
  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  const layoutBefore = world._wastesLayout;
  const seed0 = world.current.seed;

  world.openPortal(0, 0, 'last_bastion', 'town_portal_return');
  await world.enterZone('last_bastion', 'town_portal_return', { runIndex: 0 });
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 1 }); // runIndex + 1

  assert.notEqual(world.current.seed, seed0, 'runIndex + 1 -> a different seed');
  assert.notEqual(world._wastesLayout, layoutBefore, 'the generator really ran again');
  assert.equal(world._retainReport, null, 'no retained record was found for this (zoneId, seed)');
});

test('WRLD-10 §10.4: taking the descent disposes the retained field zone and closes the open town portal', async () => {
  const { world } = await boot(203);
  world.setWorldSeed(0xbeef04);
  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  const townSeed = world.seedFor('last_bastion', 0);

  const pid = world.openPortal(0, 0, 'last_bastion', 'town_portal_return');
  assert.ok(pid > 0);
  assert.equal(world.townPortalId, pid);

  await world.enterZone('bonereach', 'descent', { runIndex: 0 });
  assert.deepEqual(world.retainedZoneKeys, [retentionKey('last_bastion', townSeed)],
    'the cap is two, and the town always occupies one');
  assert.equal(world.townPortalId, 0, '§10.4: the descent closes any open town portal');
});

// ===========================================================================
// 3 — a cleared pack does not respawn  (§10.4, through ai's real spawn pass)
// ===========================================================================

test('WRLD-10 §10.4: a pack cleared before the portal trip is NOT respawned on the return; a partially killed one comes back at its survivor count', async () => {
  const { world, ctx, actors, ai } = await boot(300);
  world.setWorldSeed(0xc1ea12);
  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });

  const packsBefore = world.packs.length;
  assert.ok(packsBefore >= 2, 'the Wastes must plan at least two packs for this test to mean anything');
  const spawnedBefore = ai.spawnStats.monstersSpawned;
  assert.ok(spawnedBefore > 0, 'ai really spawned through its own zone:ready listener');

  const cleared = world.packs[0];
  const partial = world.packs[1];
  const clearedId = cleared.id;
  const partialId = partial.id;
  const partialCountBefore = partial.count;

  killPack(ctx, actors, cleared);
  assert.equal(cleared.aliveCount, 0, 'world.onActorDeath decremented the pack through actor:death');

  // Kill all but two of the second pack.
  const survivors = 2;
  for (const ref of partial.members.slice(0, Math.max(0, partial.members.length - survivors))) {
    const actor = actors.all.find((a) => a.id === ref.id) || { id: ref.id, kind: 'monster', rank: 'normal' };
    ctx.events.emit('actor:death', { actor, killer: null, point: { x: 0, y: 0, z: 0 } });
  }
  const partialAlive = partial.aliveCount;
  assert.ok(partialAlive > 0 && partialAlive < partialCountBefore, `partial pack should have survivors, got ${partialAlive}`);

  world.openPortal(0, 0, 'last_bastion', 'town_portal_return');
  await world.enterZone('last_bastion', 'town_portal_return', { runIndex: 0 });
  await world.enterZone('ashen_wastes', PORTAL_RETURN_TAG, { runIndex: 0 });

  const ids = world.packs.map((p) => p.id);
  assert.equal(ids.includes(clearedId), false, `§10.4: pack ${clearedId} was cleared and must not come back`);
  assert.equal(world.packs.length, packsBefore - 1);

  const back = world.packs.find((p) => p.id === partialId);
  assert.ok(back, 'the partially killed pack does come back');
  assert.equal(back.count, partialAlive, '§10.4: at its survivor count');
  assert.ok(back.count < partialCountBefore);

  // eslint-disable-next-line no-console
  console.log(`  [WRLD-10 §10.4] through world.enterZone + AiSystem's own zone:ready pass: packs ${packsBefore} -> ${world.packs.length}, `
    + `cleared pack #${clearedId} not respawned, pack #${partialId} back at ${back.count}/${partialCountBefore}`);
});

// ===========================================================================
// 4 — chests  (§10.4, §9.3, 02 §5 openChest)
// ===========================================================================

test('WRLD-10: normalizeChests gives every generator chest the { id, x, z, opened } 01 §9.2 requires, without losing a generator field', () => {
  const raw = [{ unsnappedPosition: { x: 3, z: -4 }, facing: 1, treasureClass: 'tc_wastes', subSeed: 9 }];
  const out = normalizeChests(raw);
  assert.equal(out, raw, 'normalised in place');
  assert.deepEqual({ id: out[0].id, x: out[0].x, z: out[0].z, opened: out[0].opened }, { id: 0, x: 3, z: -4, opened: false });
  assert.equal(out[0].subSeed, 9, 'generator fields survive');
  assert.equal(out[0].treasureClass, 'tc_wastes');
});

test('WRLD-10 §10.4 + 02 §5: openChest is idempotent-false, and the opened flag survives the portal round trip while a fresh descent resets it', async () => {
  const { world } = await boot(400);
  world.setWorldSeed(0xc4e51);
  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });

  assert.ok(world.current.chests.length >= 2, 'the Wastes ships 2..4 chests');
  assert.equal(world.openChest(0), true);
  assert.equal(world.openChest(0), false, '02 §5: false when already open');
  assert.equal(world.openChest(9999), false, 'unknown chestId');
  assert.equal(world.current.chests[0].opened, true);
  assert.equal(world.current.chests[1].opened, false);

  world.openPortal(0, 0, 'last_bastion', 'town_portal_return');
  await world.enterZone('last_bastion', 'town_portal_return', { runIndex: 0 });
  await world.enterZone('ashen_wastes', PORTAL_RETURN_TAG, { runIndex: 0 });

  assert.equal(world.current.chests[0].opened, true, '§10.4: chest opened flags are preserved across a portal round trip');
  assert.equal(world.current.chests[1].opened, false);
  const it = world.interactableAt(world.current.chests[0].x, world.current.chests[0].z, 0.1);
  assert.ok(it === null || it.kind !== 'chest' || it.chestId !== 0, 'an already-open chest no longer offers a prompt');

  // A regenerating leg (runIndex + 1) must NOT carry it.
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 1 });
  assert.equal(world.current.chests.every((c) => !c.opened), true, '§10.4: destroyed with the zone on a real exit');
});

// ===========================================================================
// 5 — ground items  (§10.4 / T13)
// ===========================================================================

test('WRLD-10 §10.4 T13: ground items are snapshotted at teardown and re-dropped on the portal return, at their original position and expiry', async () => {
  const { world, actors, items } = await boot(500);
  world.setWorldSeed(0x6204d);
  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });

  const hero = actors.spawn({ kind: 'player', team: 0, x: 0, z: 0, level: 1, archetypeId: 'emberwright' });
  assert.ok(hero, 'a player actor to pick the item back up with');

  const item = { uid: 4242, baseId: 'probe_blade', rarity: 'normal', name: 'probe', w: 1, h: 1 };
  items.dropToGround(item, 12.5, -6.25);
  const expiry = item.ground.expiresAtStep;
  const out = new Array(64);
  assert.equal(items.groundItemsNear(0, 0, 1e9, out), 1);

  world.openPortal(0, 0, 'last_bastion', 'town_portal_return');
  await world.enterZone('last_bastion', 'town_portal_return', { runIndex: 0 });
  assert.equal(world.retainedZoneKeys.length, 2);

  // `items` does not clear the floor on `zone:teardown` today (reported), so
  // the T13 re-drop is exercised by removing the item through the contracted
  // `pickUp` while the player is in town — standing in for the T4 clear.
  assert.equal(items.pickUp(hero, item), true);
  assert.equal(items.groundItemsNear(0, 0, 1e9, out), 0, 'the floor really is empty now');

  await world.enterZone('ashen_wastes', PORTAL_RETURN_TAG, { runIndex: 0 });

  assert.equal(items.groundItemsNear(0, 0, 1e9, out), 1, '§10.4: preserved, re-dropped in T13');
  assert.equal(out[0], item, 'the same ItemInstance, not a copy');
  assert.equal(item.ground.x, 12.5);
  assert.equal(item.ground.z, -6.25);
  assert.equal(item.ground.expiresAtStep, expiry, '§10.4: "with their original expiresAtStep still ticking"');
});

test('WRLD-10 §10.4: ground items are NOT carried across a zone the player did not portal out of', async () => {
  const { world, items } = await boot(501);
  world.setWorldSeed(0x6204e);
  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  items.dropToGround({ uid: 1, baseId: 'x', rarity: 'normal', w: 1, h: 1 }, 5, 5);

  await world.enterZone('bonereach', 'descent', { runIndex: 0 });
  assert.equal(world.current.groundItems.length, 0, 'the descent retains nothing, so there is no snapshot to restore');
});

// ===========================================================================
// 6 — the town portal  (§10.5)
// ===========================================================================

test('WRLD-10 §10.5: openPortal registers both ends under one id, adds the portal_return entry 2.2 m south of the pad, and emits portal:open', async () => {
  const { world, ctx } = await boot(600);
  world.setWorldSeed(0x707a1);
  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });

  const seen = [];
  ctx.events.on('portal:open', (p) => seen.push({ x: p.from.x, z: p.from.z, zone: p.to.zone }));

  const pid = world.openPortal(0, 0, 'last_bastion', 'town_portal_return');
  assert.ok(pid > 0, 'a real portalId');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].zone, 'last_bastion');

  const field = world.current.portals.find((p) => p.id === pid);
  assert.ok(field && field.open);
  assert.equal(field.toZone, 'last_bastion');
  assert.equal(world.portalAt(field.x, field.z, 0.5), pid, '§10.5 step 4: portalAt resolves the field end');
  assert.equal(world.portalAt(field.x + 500, field.z, 0.5), 0, 'and nothing far away');

  const ret = world.current.entries.get(PORTAL_RETURN_TAG);
  assert.ok(ret, '§10.5 step 2 registers a NEW entry on the current zone');
  assert.equal(ret.z, field.z + TOWN_PORTAL_RETURN_OFFSET_Z, 'the return entry is 2.2 m south of the pad');
  assert.equal(ret.facing, -Math.PI / 2);
  // The entry must be reachable through the contracted `world.entry()` even
  // though no shipped descriptor declares the tag.
  const e = world.entry(PORTAL_RETURN_TAG);
  assert.equal(e.x, ret.x);
  assert.equal(e.z, ret.z);

  await world.enterZone('last_bastion', 'town_portal_return', { runIndex: 0 });
  assert.equal(world.portalAt(TOWN_PORTAL_PAD.x, TOWN_PORTAL_PAD.z, 0.5), pid,
    '§10.5 step 4: the SAME id resolves at the town-side pad (0, -17)');
  const pad = world.interactableAt(TOWN_PORTAL_PAD.x, TOWN_PORTAL_PAD.z, 0.5);
  assert.ok(pad && pad.kind === 'portal' && pad.enabled, 'the town pad lights when a portal is open');
  assert.equal(pad.toZone, 'ashen_wastes');
});

test('WRLD-10 §10.5: usePortal emits portal:use and starts a transition back to the retained field zone', async () => {
  const { world, ctx } = await boot(601);
  world.setWorldSeed(0x707a2);
  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 2 });
  const fieldSeed = world.current.seed;
  const pid = world.openPortal(0, 0, 'last_bastion', 'town_portal_return');

  const uses = [];
  ctx.events.on('portal:use', (p) => uses.push(p.to.zone));

  assert.equal(world.usePortal(pid), true, 'using the field end starts the trip to town');
  assert.deepEqual(uses, ['last_bastion']);

  const DT = 1 / 60;
  for (let i = 0; i < 200 && world.transitionPhase !== 'idle'; i++) {
    ctx.time.raw = DT; world.update(DT, ctx); world.serviceZoneRequest();
  }
  assert.equal(world.current.zoneId, 'last_bastion');

  const townEnd = world.portalAt(TOWN_PORTAL_PAD.x, TOWN_PORTAL_PAD.z, 0.5);
  assert.equal(townEnd, pid);
  assert.equal(world.usePortal(townEnd), true, 'and the town end starts the trip back');
  for (let i = 0; i < 200 && world.transitionPhase !== 'idle'; i++) {
    ctx.time.raw = DT; world.update(DT, ctx); world.serviceZoneRequest();
  }
  assert.equal(world.current.zoneId, 'ashen_wastes');
  assert.equal(world.current.seed, fieldSeed, 'the return carries runIndex unchanged, so it is the retained instance');
  assert.deepEqual(uses, ['last_bastion', 'ashen_wastes']);
});

test('WRLD-10 §10.5: refused in town, refused in the Altar before the boss is down, and opening a second portal closes the first', async () => {
  const { world } = await boot(602);
  world.setWorldSeed(0x707a3);

  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });
  assert.equal(world.openPortal(0, 0, 'last_bastion', 'town_portal_return'), 0, '§10.5 "Not in town"');

  await world.enterZone('altar_of_instruction', 'altar_entry', { runIndex: 0 });
  assert.equal(world.current.bossDefeated, false);
  assert.equal(world.openPortal(0, 0, 'last_bastion', 'town_portal_return'), 0, '§10.5 "Not in the Altar"');

  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  const first = world.openPortal(0, 0, 'last_bastion', 'town_portal_return');
  const second = world.openPortal(8, 8, 'last_bastion', 'town_portal_return');
  assert.ok(first > 0 && second > first);
  assert.equal(world.townPortalId, second, '§10.5 "One at a time"');
  assert.equal(world.current.portals.find((p) => p.id === first).open, false, 'the first is closed');
  assert.equal(world.portalAt(0, 1.5, 0.5), 0, 'and no longer resolves');

  world.closePortal(second);
  assert.equal(world.townPortalId, 0);
  assert.equal(world.current.portals.every((p) => !p.open), true);
});

// ===========================================================================
// 7 — interactables and sealed exits  (§9.3, 02 §5)
// ===========================================================================

test('WRLD-10 §9.3: interactableAt returns the nearest ENABLED interactable, ties by lower id, from a shared scratch', () => {
  const state = createTransitionState();
  const instance = {
    interactables: [
      { id: 0, kind: 'chest', x: 0, z: 0, radius: 1, npcId: null, chestId: 0, portalId: 0, toZone: null, toEntryTag: null, enabled: false, promptKey: 'a' },
      { id: 1, kind: 'chest', x: 0, z: 0, radius: 1, npcId: null, chestId: 1, portalId: 0, toZone: null, toEntryTag: null, enabled: true, promptKey: 'b' },
      { id: 2, kind: 'chest', x: 0, z: 0, radius: 1, npcId: null, chestId: 2, portalId: 0, toZone: null, toEntryTag: null, enabled: true, promptKey: 'c' },
      { id: 3, kind: 'npc', x: 20, z: 0, radius: 1, npcId: 'smith', chestId: 0, portalId: 0, toZone: null, toEntryTag: null, enabled: true, promptKey: 'd' },
    ],
    chests: [],
  };
  const a = interactableAt(state, instance, 0, 0, 0.1);
  assert.equal(a.id, 1, 'a disabled one is skipped; the tie goes to the lower id');
  const b = interactableAt(state, instance, 20, 0, 0.1);
  assert.equal(b.id, 3);
  assert.equal(b, a, 'the same shared scratch object every call (Alloc: no)');
  assert.equal(interactableAt(state, instance, 200, 200, 0.1), null);
  assert.equal(interactableAt(state, null, 0, 0, 1), null);
});

test('WRLD-10 02 §5: setExitSealed flips the exit interactable\'s prompt, survives a regeneration of that zone, and is undone by sealed=false', async () => {
  const { world } = await boot(700);
  world.setWorldSeed(0x5ea1);
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });

  const exit = world.current.interactables.find((i) => i.kind === 'exit');
  assert.ok(exit, 'the Wastes exit to bonereach is an Interactable');
  assert.equal(exit.enabled, true);
  assert.equal(world.interactableAt(exit.x, exit.z, 0.1).kind, 'exit');

  world.setExitSealed('ashen_wastes', 'descent', true);
  assert.equal(world.current.interactables.find((i) => i.kind === 'exit').enabled, false);
  assert.equal(world.interactableAt(exit.x, exit.z, 0.1), null, 'a sealed exit offers no prompt');

  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 4 });
  assert.equal(world.current.interactables.find((i) => i.kind === 'exit').enabled, false,
    'the seal is remembered per (zoneId, exitTag), so a regenerated zone comes back sealed');

  world.setExitSealed('ashen_wastes', 'descent', false);
  assert.equal(world.current.interactables.find((i) => i.kind === 'exit').enabled, true);
});

test('WRLD-10: portalAt/openChest degrade cleanly with no zone loaded', () => {
  const state = createTransitionState();
  assert.equal(portalAt(null, 0, 0, 5), 0);
  assert.equal(openChest(state, null, 0), false);
});

// ===========================================================================
// 8 — THE ACCEPTANCE RUN (07 §12 row 11 / the M5 gate's item 9)
// ===========================================================================

test('WRLD-10 ACCEPTANCE (07 §12 row 11): town -> wastes -> portal to town -> return -> descent -> altar, ten times, through real world.enterZone calls', async (t) => {
  const { world, ctx, actors, ai, items } = await boot(900);
  world.setWorldSeed(0x1005107);

  const legs = [];
  /** Every number below is `performance.now()` around exactly one real
   * `world.enterZone(...)` call; the leg name says which one. */
  async function leg(name, zoneId, entryTag, opts) {
    const t0 = performance.now();
    await world.enterZone(zoneId, entryTag, opts);
    const ms = performance.now() - t0;
    legs.push({ name, zoneId, ms });
    return ms;
  }

  const hero = actors.spawn({ kind: 'player', team: 0, x: 0, z: 0, level: 1, archetypeId: 'emberwright' });
  const out = new Array(64);
  let clearedNotRespawned = 0;
  let chestsSurvived = 0;
  let itemsSurvived = 0;
  let monstersSpawned = 0;

  await leg('boot:town', 'last_bastion', 'town_start', { runIndex: 0 });

  for (let i = 0; i < 10; i++) {
    // 1. town -> wastes
    await leg('town->wastes', 'ashen_wastes', 'portal_from_town', { runIndex: i });

    monstersSpawned += ai.spawnStats.monstersSpawned; // ai's stats reset per pass — accumulate here

    const packsBefore = world.packs.length;
    const clearedId = world.packs.length > 0 ? world.packs[0].id : -1;
    if (clearedId >= 0) killPack(ctx, actors, world.packs[0]);
    const chestOpened = world.current.chests.length > 0 && world.openChest(world.current.chests[0].id);

    const item = { uid: 90000 + i, baseId: 'probe_blade', rarity: 'normal', name: 'probe', w: 1, h: 1 };
    items.dropToGround(item, 9 + i, -9 - i);
    const expiry = item.ground.expiresAtStep;

    // 2. portal to town
    const pid = world.openPortal(0, 0, 'last_bastion', 'town_portal_return');
    assert.ok(pid > 0, `run ${i}: the town portal must open in a field zone`);
    await leg('wastes->town (portal)', 'last_bastion', 'town_portal_return', { runIndex: 0 });
    assert.equal(world.portalAt(TOWN_PORTAL_PAD.x, TOWN_PORTAL_PAD.z, 0.5), pid, `run ${i}: the town pad is usable`);
    items.pickUp(hero, item); // stands in for the T4 clear `items` does not do

    // 3. return
    await leg('town->wastes (portal return)', 'ashen_wastes', PORTAL_RETURN_TAG, { runIndex: i });
    if (clearedId >= 0 && !world.packs.some((p) => p.id === clearedId) && world.packs.length === packsBefore - 1) clearedNotRespawned++;
    if (chestOpened && world.current.chests[0].opened) chestsSurvived++;
    if (items.groundItemsNear(0, 0, 1e9, out) === 1 && out[0] === item && item.ground.expiresAtStep === expiry) itemsSurvived++;
    items.pickUp(hero, item); // clear the floor for the next run

    // 4. descent
    await leg('wastes->bonereach (descent)', 'bonereach', 'descent', { runIndex: i });
    assert.equal(world.townPortalId, 0, `run ${i}: the descent closes the town portal`);

    // 5. altar
    await leg('bonereach->altar', 'altar_of_instruction', 'altar_entry', { runIndex: i });

    // back to town to start the next lap
    await leg('altar->town', 'last_bastion', 'from_wastes', { runIndex: 0 });
  }

  assert.equal(clearedNotRespawned, 10, 'a cleared pack must not respawn on any of the ten laps');
  assert.equal(chestsSurvived, 10, 'chest flags must survive the portal round trip on every lap');
  assert.equal(itemsSurvived, 10, 'ground items must survive the portal round trip on every lap');

  const byName = new Map();
  for (const l of legs) {
    if (!byName.has(l.name)) byName.set(l.name, []);
    byName.get(l.name).push(l.ms);
  }
  const all = legs.map((l) => l.ms).sort((a, b) => a - b);
  const p = (q) => all[Math.min(all.length - 1, Math.floor(all.length * q))];

  // eslint-disable-next-line no-console
  console.log(`\n  [WRLD-10 ACCEPTANCE] ${legs.length} legs, every ms a performance.now() delta around one real world.enterZone() call:`);
  for (const [name, xs] of byName) {
    const s = xs.slice().sort((a, b) => a - b);
    // eslint-disable-next-line no-console
    console.log(`    ${name.padEnd(30)} n=${String(xs.length).padStart(2)}  min=${s[0].toFixed(1)}  med=${s[Math.floor(s.length / 2)].toFixed(1)}  max=${s[s.length - 1].toFixed(1)} ms`);
  }
  // eslint-disable-next-line no-console
  console.log(`    ALL LEGS  min=${all[0].toFixed(1)}  p50=${p(0.5).toFixed(1)}  p95=${p(0.95).toFixed(1)}  max=${all[all.length - 1].toFixed(1)} ms`
    + `   (budget: black window <= ${TRANSITION_MS.black} ms, leg <= ${TRANSITION_MS.statedTotal} ms)`);
  // eslint-disable-next-line no-console
  console.log('    hardware-dependent: one machine, Node, no GPU — T7\'s buffer uploads do not happen headlessly (07 §10.3 budgets T7 at 214 ms alone)\n');

  const worst = all[all.length - 1];
  assert.ok(worst <= TRANSITION_MS.black, `every leg's enterZone must fit the ${TRANSITION_MS.black} ms black window; worst was ${worst.toFixed(1)} ms`);
  assert.ok(worst <= TRANSITION_MS.statedTotal, `and the <= ${TRANSITION_MS.statedTotal} ms per-leg target; worst was ${worst.toFixed(1)} ms`);
  assert.ok(monstersSpawned > 0, `ai really ran on these transitions (${monstersSpawned} monsters spawned across the ten laps)`);
  void t;
});
