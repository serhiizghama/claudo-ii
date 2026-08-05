// tests/player/zonewalk.test.js
//
// M5 gate ⑦ — "a zone is walkable end to end, as a real scripted session
// through `boot()`: enter the Ashen Wastes, walk entry to exit, and again for
// Bonereach" (`docs/ORCHESTRATOR_PROMPT_M5.md` §10). Kept as a test, not a
// one-off probe, because the failure it locks down was invisible to every
// unit test in the tree: `src/nav/astar.js` and `src/player/move.js` each
// passed their own suites while the two together left the player motionless
// in Bonereach.
//
// What this drives is the real chain, never a lookalike (O-106):
//   `boot()` -> `world.setWorldSeed()` -> `await world.enterZone(zone, tag)`
//     -> `actors.teleport(player, entry)` -> `player.moveOrder(exit)`
//       -> `engine.frame()` x N (real fixed steps, real nav, real AI)
// and every number below is read back off the live actor and `nav.stats`.
//
// Two deliberate choices, both stated rather than hidden:
//
//   1. The walker is kept alive. Gate ⑦ measures WALKABILITY; a scripted
//      walker that never fights is killed by the zone's own packs roughly
//      halfway across Bonereach (measured: `actor.dead` at ~14 s), and
//      §3.7's "Dead -> order cleared" then ends the run for a reason that
//      has nothing to do with navigation. Life is topped up each frame and
//      the order re-issued if a burst still lands inside one frame; the
//      re-issues are counted and reported, never swallowed.
//   2. Arrival is measured against the exit Interactable's own trigger
//      radius, not a hand-picked epsilon — `player.moveOrder` snaps the
//      destination (`DESTINATION_SNAP_RADIUS_M`, 2.0 m) and the exit trigger
//      is metres wide, so "standing on the exit" is the honest bar.
//
// `three` is used here only for what `boot()` itself needs; nothing in
// `src/player/` or `src/nav/` is reached except through the booted engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { FIXED_DT, MAX_SUBSTEPS } from '../../src/core/engine.js';
import { DESTINATION_SNAP_RADIUS_M } from '../../src/player/move.js';

/** The same stub `tests/player/plyr1.test.js` uses for `boot()` under Node. */
function makeCanvas(width = 1280, height = 720) {
  return { width, height, clientWidth: width, clientHeight: height, addEventListener() {}, removeEventListener() {} };
}

/** One frame's worth of raw dt: `MAX_SUBSTEPS` fixed steps, the engine's own
 * clamp, so a frame is never dropped mid-walk. */
const FRAME_DT = MAX_SUBSTEPS * FIXED_DT;
/** Simulated seconds a single traversal is allowed. Bonereach's longest
 * measured crossing is ~50 s of simulated time at 4.2 m/s over ~175 m of
 * maze; 150 s is 3x that, and generous enough that this test can only fail
 * on a real stall, never on a slow-but-progressing walk. */
const WALK_BUDGET_SEC = 150;

/**
 * Boots the real engine, enters `zoneId` at `entryTag`, and walks the player
 * from the entry point to the zone's exit Interactable.
 * @returns {Promise<object>} the measurements, all read off the live engine.
 */
async function walkZone(zoneId, entryTag, worldSeed, runIndex) {
  const { ctx, engine } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const world = ctx.get('world');
  const nav = ctx.get('nav');
  const actors = ctx.get('actors');
  const player = ctx.get('player');

  world.setWorldSeed(worldSeed);
  await world.enterZone(zoneId, entryTag, { runIndex });

  // `world.entry` is `Alloc: no` and hands back a REUSED SCRATCH — copy the
  // components out immediately and never hold two of its returns at once.
  const entryPoint = world.entry(entryTag);
  const entryX = entryPoint.x;
  const entryZ = entryPoint.z;

  const exit = world.current.interactables.find((it) => it.kind === 'exit');
  assert.ok(exit, `${zoneId}: the zone must publish an exit Interactable to walk to`);
  const exitX = exit.x;
  const exitZ = exit.z;

  const actor = player.actor;
  const placed = actors.teleport(actor, entryX, entryZ);
  const startX = actor.x;
  const startZ = actor.z;
  const straight = Math.sqrt((exitX - startX) ** 2 + (exitZ - startZ) ** 2);

  // "Standing on the exit": its own trigger radius, plus the snap radius the
  // move order itself is allowed to shift the destination by.
  const arriveRadius = (exit.radius || 0) + DESTINATION_SNAP_RADIUS_M;
  const refusalsBefore = nav.stats.refusals;
  const maxFrames = Math.ceil(WALK_BUDGET_SEC / FRAME_DT);
  const maxLife = actors.stats(actor).maxLife;

  player.moveOrder(exitX, exitZ);

  let travelled = 0;
  let px = actor.x;
  let pz = actor.z;
  let deaths = 0;
  let frames = 0;
  let arrived = false;
  let remaining = straight;

  for (; frames < maxFrames; frames++) {
    actor.life = maxLife; // see this file's header, choice 1
    engine.frame(FRAME_DT);
    if (actor.dead) {
      // §3.7, "Dead -> order cleared" — the one documented reason this walk
      // loses its order for a non-navigation reason. Re-issued, and counted.
      deaths++;
      actor.dead = false;
      actor.life = maxLife;
      player.moveOrder(exitX, exitZ);
    }

    const dx = actor.x - px;
    const dz = actor.z - pz;
    travelled += Math.sqrt(dx * dx + dz * dz);
    px = actor.x;
    pz = actor.z;

    remaining = Math.sqrt((exitX - actor.x) ** 2 + (exitZ - actor.z) ** 2);
    if (remaining <= arriveRadius) {
      arrived = true;
      break;
    }
  }

  return {
    zoneId, straight, travelled, remaining, arrived, deaths,
    seconds: (frames + 1) * FRAME_DT,
    refusals: nav.stats.refusals - refusalsBefore,
    placed,
  };
}

/** Runs `layouts` traversals of one zone and asserts every one of them. */
async function assertZoneWalkable(zoneId, entryTag, seedBase, layouts) {
  for (let i = 0; i < layouts; i++) {
    const r = await walkZone(zoneId, entryTag, (seedBase + i) >>> 0, i % 3);
    // eslint-disable-next-line no-console
    console.log(
      `  [gate ⑦] ${zoneId} layout ${i}: straight=${r.straight.toFixed(1)} m travelled=${r.travelled.toFixed(1)} m ` +
        `remaining=${r.remaining.toFixed(2)} m t=${r.seconds.toFixed(1)} s refusals=${r.refusals} deaths=${r.deaths}`,
    );
    assert.ok(r.placed, `${zoneId} layout ${i}: the player must be placeable at the zone entry`);
    assert.ok(r.straight > 20, `${zoneId} layout ${i}: test setup — entry and exit must be a real distance apart, got ${r.straight.toFixed(1)} m`);
    assert.ok(
      r.arrived,
      `${zoneId} layout ${i}: must reach the exit — stopped ${r.remaining.toFixed(2)} m short after ${r.seconds.toFixed(1)} s, having travelled ${r.travelled.toFixed(1)} m`,
    );
    assert.ok(
      r.travelled >= r.straight,
      `${zoneId} layout ${i}: travelled ${r.travelled.toFixed(1)} m cannot be less than the ${r.straight.toFixed(1)} m straight line it walked`,
    );
    assert.equal(
      r.refusals, 0,
      `${zoneId} layout ${i}: the solver must not refuse a single path on a traversal it can serve — ${r.refusals} refusals`,
    );
  }
}

test('M5 gate ⑦: Bonereach is walkable entry to exit, through the real boot() pipeline, on 5 layouts', async () => {
  // Bonereach is the zone that failed the gate: its BSP maze needs
  // 2,118-12,624 A* expansions for an entry -> exit path (measured on this
  // same pipeline), every one of them over `NODE_CAP`, so the solver refused
  // every long path and the player travelled 0.00 m on every layout tried.
  await assertZoneWalkable('bonereach', 'descent', 0xb04e0000, 5);
});

test('M5 gate ⑦: the Ashen Wastes are walkable entry to exit, through the real boot() pipeline, on 5 layouts', async () => {
  // The open zone is not automatically safe either: one of these five
  // layouts measures 2,337 expansions for its crossing — also over the cap.
  await assertZoneWalkable('ashen_wastes', 'portal_from_town', 0xb04e0000, 5);
});
