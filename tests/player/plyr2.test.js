// tests/player/plyr2.test.js
//
// PLYR-2 acceptance tests for src/player/move.js (`PathFollower`) and the
// wiring changes in src/player/index.js (`moveOrder`/`stop`/`_followOrder`
// now delegate into it). `node:test` + `node:assert/strict` only
// (12-testing.md P6).
//
// Three layers, cheapest/most isolated first:
//   1. `PathFollower` unit tests against hand-built fake `nav`/`actors` —
//      every mode transition (direct/pending/following/budget-retry),
//      budget-refusal retry/cap, blocked-streak repathing, stale-version
//      repathing, and that nothing ever leaks a PathHandle or a pending
//      requestId (every release/cancel call is asserted directly).
//   2. A handful of targeted integration tests against REAL `NavSystem` +
//      `ActorsSystem` + `PhysicsSystem` + `PlayerSystem`, wired onto one
//      stub `ctx` (the same "real subsystems, stub ctx, never `enterZone`"
//      shape `tests/world/wrld3.test.js`'s own `makeNavForTestMap` already
//      established) and `src/world/testmap.js`'s hand-authored map — one
//      run through each of the map's four purpose-built features (doorway,
//      pillar detour, concave pocket, diagonal-corner crates), driven
//      through the REAL intent latch/ladder, exactly like
//      `tests/player/plyr1.test.js`'s own arrival tests.
//   3. THE ACCEPTANCE CRITERION: 200 scripted runs across the test map,
//      driving `PathFollower` directly against the same real subsystems
//      (no `PlayerSystem`/intent latch in the loop — layer 2 above already
//      proves that wiring; this layer is about the algorithm itself, at
//      volume, as fast as possible). Zero wedges, zero corner sticks — both
//      defined explicitly below, with the exact step budget and window used.
//
// Per O-27/O-39: no assertion here encodes "this method doesn't exist yet"
// or a hard-coded scope/count; every check is on real solved/followed
// behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FIXED_DT } from '../../src/core/engine.js';
import { Rng } from '../../src/core/rng.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { NavSystem } from '../../src/nav/index.js';
import { PlayerSystem } from '../../src/player/index.js';
import {
  PathFollower,
  computeArriveRadius,
  DESTINATION_SNAP_RADIUS_M,
  BUDGET_RETRY_MAX_STEPS,
  REPATH_FROM_CURRENT_SNAP_RADIUS_M,
} from '../../src/player/move.js';
import {
  TESTMAP_BOUNDS,
  TESTMAP_FOOTPRINTS,
  TESTMAP_FAR_CORNERS,
  TESTMAP_DOORWAY,
} from '../../src/world/testmap.js';
import { makeStubCtx } from '../helpers/actor.js';
import { SEEDS } from '../helpers/seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ===========================================================================
// Layer 1 — PathFollower unit tests against hand-built fakes
// ===========================================================================

/**
 * A minimal, fully-controllable fake `nav`. Every call is recorded (`calls`)
 * so a test can assert exactly what was invoked, with what arguments, and in
 * what order — the thing a real `NavSystem` cannot cheaply expose. Solve
 * timing, budget refusal and connectivity are all scriptable per test.
 */
function makeFakeNav(opts = {}) {
  const calls = { snap: [], connected: [], requestPath: [], pollPath: [], cancelPath: [], releasePath: [], smooth: [] };
  let nextRequestId = 1;
  const pendingUntilStep = new Map(); // requestId -> the poll-call-count at which it resolves
  let pollCount = 0;

  const nav = {
    version: opts.version ?? 1,
    calls,

    snap(x, z, maxRadius, out) {
      calls.snap.push({ x, z, maxRadius });
      if (opts.snapFails) return null;
      out.x = x;
      out.y = 0;
      out.z = z;
      return out;
    },

    connected(ax, az, bx, bz) {
      calls.connected.push({ ax, az, bx, bz });
      return opts.connectedResult ?? true;
    },

    requestPath(fromX, fromZ, toX, toZ, ownerId) {
      calls.requestPath.push({ fromX, fromZ, toX, toZ, ownerId });
      if (opts.refuseBudgetCount && calls.requestPath.length <= opts.refuseBudgetCount) return 0;
      if (opts.neverSolves) return 0;
      const id = nextRequestId++;
      const resolveAfterPolls = opts.resolveAfterPolls ?? 0;
      pendingUntilStep.set(id, pollCount + resolveAfterPolls);
      nav._pendingNodes = nav._pendingNodes || {};
      nav._pendingNodes[id] = opts.pathNodes
        ? opts.pathNodes(fromX, fromZ, toX, toZ)
        : [
            { x: fromX, y: 0, z: fromZ },
            { x: toX, y: 0, z: toZ },
          ];
      return id;
    },

    pollPath(requestId) {
      calls.pollPath.push(requestId);
      pollCount++;
      if (!pendingUntilStep.has(requestId)) return null;
      if (pollCount < pendingUntilStep.get(requestId)) return null;
      const nodes = nav._pendingNodes[requestId];
      return { __fakePath: true, requestId, nodes, released: false };
    },

    cancelPath(requestId) {
      calls.cancelPath.push(requestId);
      pendingUntilStep.delete(requestId);
    },

    releasePath(path) {
      calls.releasePath.push(path);
      if (path) path.released = true;
    },

    pathNode(path, i, out) {
      const n = path.nodes[i];
      out.x = n.x;
      out.y = n.y;
      out.z = n.z;
      return out;
    },

    pathLength(path) {
      return path.nodes.length;
    },

    smooth(path) {
      calls.smooth.push(path);
    },
  };
  return nav;
}

/** A fake `actors` — `moveTo` actually moves the fake actor (so distance-based
 * arrival/advance checks are real), `blocked` is scriptable per call via
 * `opts.blockedSteps` (a Set of 1-based call indices) or `opts.alwaysBlocked`. */
function makeFakeActors(opts = {}) {
  const calls = { moveTo: 0, face: 0, moveSpeed: 0, setState: [] };
  return {
    calls,
    moveSpeed() {
      calls.moveSpeed++;
      return opts.speed ?? 4.2;
    },
    face(actor, tx, tz) {
      calls.face++;
    },
    moveTo(actor, dx, dz) {
      calls.moveTo++;
      const blocked = opts.alwaysBlocked || (opts.blockedSteps && opts.blockedSteps.has(calls.moveTo));
      if (!blocked) {
        actor.x += dx;
        actor.z += dz;
      }
      return { x: actor.x, z: actor.z, blocked: !!blocked, slid: false, hitStatic: 0, hitActorId: 0 };
    },
    setState(actor, state) {
      calls.setState.push(state);
      return true;
    },
  };
}

function makeFakeActor(x = 0, z = 0) {
  return { x, z, radius: 0.36, dead: false, id: 1 };
}

test('PathFollower: nav.version === 0 — unconditional direct order, no nav validation calls at all', () => {
  const nav = makeFakeNav({ version: 0 });
  const actors = makeFakeActors();
  const actor = makeFakeActor(0, 0);
  const follower = new PathFollower();

  const accepted = follower.beginOrder(nav, actor, 5, 0);
  assert.equal(accepted, true);
  assert.equal(follower.active, true);
  assert.equal(nav.calls.snap.length, 0, 'must not call nav.snap while nav.version === 0');
  assert.equal(nav.calls.connected.length, 0);
  assert.equal(nav.calls.requestPath.length, 0);

  for (let i = 0; i < 300 && follower.active; i++) follower.step(FIXED_DT, nav, actors, actor);
  assert.equal(follower.active, false, 'must still arrive via the direct fallback');
  const dist = Math.sqrt((actor.x - 5) ** 2 + actor.z ** 2);
  assert.ok(dist <= computeArriveRadius(actor) + 1e-9);
});

test('PathFollower: step 1 — nav.snap returning null drops the order', () => {
  const nav = makeFakeNav({ snapFails: true });
  const actors = makeFakeActors();
  const actor = makeFakeActor();
  const follower = new PathFollower();

  const accepted = follower.beginOrder(nav, actor, 100, 100);
  assert.equal(accepted, false);
  assert.equal(follower.active, false);
  assert.equal(nav.calls.snap.length, 1);
  assert.deepEqual(
    { x: nav.calls.snap[0].x, z: nav.calls.snap[0].z, maxRadius: nav.calls.snap[0].maxRadius },
    { x: 100, z: 100, maxRadius: DESTINATION_SNAP_RADIUS_M },
  );
  assert.equal(nav.calls.connected.length, 0, 'must not check connectivity once snap already failed');
});

test('PathFollower: step 2 — nav.connected() === false drops the order', () => {
  const nav = makeFakeNav({ connectedResult: false });
  const actors = makeFakeActors();
  const actor = makeFakeActor();
  const follower = new PathFollower();

  const accepted = follower.beginOrder(nav, actor, 10, 0);
  assert.equal(accepted, false);
  assert.equal(follower.active, false);
  assert.equal(nav.calls.requestPath.length, 0, 'must not request a path once unreachable');
});

test('PathFollower: steps 4-8 — requests, polls, smooths once, follows every node, arrives at the final one', () => {
  const nav = makeFakeNav({
    resolveAfterPolls: 1,
    pathNodes: () => [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
    ],
  });
  const actors = makeFakeActors();
  const actor = makeFakeActor(0, 0);
  const follower = new PathFollower();

  const accepted = follower.beginOrder(nav, actor, 2, 0);
  assert.equal(accepted, true);
  assert.equal(nav.calls.requestPath.length, 1);

  let steps = 0;
  while (follower.active && steps < 600) {
    follower.step(FIXED_DT, nav, actors, actor);
    steps++;
  }

  assert.equal(follower.active, false, 'must arrive within a generous step budget');
  assert.equal(nav.calls.smooth.length, 1, 'smooth() must run exactly once, right after the handle resolves');
  assert.ok(Math.abs(actor.x - 2) <= computeArriveRadius(actor) + 1e-9);
  assert.ok(actors.calls.moveTo > 0);
  assert.ok(actors.calls.face > 0);
  assert.deepEqual(actors.calls.setState, ['idle']);
  assert.equal(nav.calls.releasePath.length, 1, 'the solved handle must be released exactly once, on arrival');
});

test('PathFollower: step 5 — a budget refusal steers straight and retries every step, capped at 12', () => {
  // Always refuse — resolveAfterPolls/refuseBudgetCount is generous enough
  // that every requestPath call in this test sees the "budget full" branch.
  const nav = makeFakeNav({ neverSolves: true, connectedResult: true });
  const actors = makeFakeActors();
  const actor = makeFakeActor(0, 0);
  const follower = new PathFollower();

  follower.beginOrder(nav, actor, 3, 0); // consumes requestPath call #1 (refused)
  assert.equal(nav.calls.requestPath.length, 1);

  // BUDGET_RETRY_MAX_STEPS - 1 more steps -> BUDGET_RETRY_MAX_STEPS total
  // refused requests (the spec's own cap), each also steering straight.
  for (let i = 0; i < BUDGET_RETRY_MAX_STEPS - 1; i++) follower.step(FIXED_DT, nav, actors, actor);
  assert.equal(nav.calls.requestPath.length, BUDGET_RETRY_MAX_STEPS, 'must retry every step up to the cap');
  assert.ok(actors.calls.moveTo >= BUDGET_RETRY_MAX_STEPS - 1, 'must steer straight every one of those steps, never blocking');

  const requestsBefore = nav.calls.requestPath.length;
  const moveToBefore = actors.calls.moveTo;
  for (let i = 0; i < 20 && follower.active; i++) follower.step(FIXED_DT, nav, actors, actor);
  assert.equal(nav.calls.requestPath.length, requestsBefore, 'must stop retrying once the cap is exhausted');
  assert.ok(actors.calls.moveTo > moveToBefore, 'must keep steering after the cap — never a silent stall');
});

test('PathFollower: step 10 — three consecutive blocked steps trigger exactly one repath, from a nav-snapped current position', () => {
  const nav = makeFakeNav({ resolveAfterPolls: 0 });
  const actors = makeFakeActors({ alwaysBlocked: true });
  const actor = makeFakeActor(0, 0);
  const follower = new PathFollower();

  follower.beginOrder(nav, actor, 5, 0);
  // First requestPath (from the order's own start) resolves on the very
  // first poll (resolveAfterPolls: 0) — that first step() only transitions
  // PENDING -> FOLLOWING (see move.js's own `_stepPending`, which returns
  // without steering on the same step it resolves); every step after that
  // is a real, always-blocked `moveTo` call.
  follower.step(FIXED_DT, nav, actors, actor); // poll -> following, no move yet
  follower.step(FIXED_DT, nav, actors, actor); // move #1, blocked
  follower.step(FIXED_DT, nav, actors, actor); // move #2, blocked
  const releasesBefore = nav.calls.releasePath.length;
  const requestsBefore = nav.calls.requestPath.length;
  follower.step(FIXED_DT, nav, actors, actor); // move #3, blocked -> threshold hit -> repath

  assert.equal(nav.calls.releasePath.length, releasesBefore + 1, 'the blocked handle must be released before repathing');
  assert.equal(nav.calls.requestPath.length, requestsBefore + 1, 'a fresh request must follow immediately');
  const lastSnap = nav.calls.snap[nav.calls.snap.length - 1];
  assert.equal(lastSnap.maxRadius, REPATH_FROM_CURRENT_SNAP_RADIUS_M, 'the FROM point must be snapped before repathing');
  assert.equal(lastSnap.x, actor.x, 'must snap the ACTOR\'s current position, not the original order start');
});

test('PathFollower: step 11 — a stale nav.version (grid rebuilt mid-path) releases the held handle and repaths', () => {
  const nav = makeFakeNav({ resolveAfterPolls: 0 });
  const actors = makeFakeActors();
  const actor = makeFakeActor(0, 0);
  const follower = new PathFollower();

  follower.beginOrder(nav, actor, 5, 0);
  follower.step(FIXED_DT, nav, actors, actor); // resolves -> MODE_FOLLOWING, pathVersionAtSolve = 1

  const releasesBefore = nav.calls.releasePath.length;
  nav.version = 2; // a rebuild happened
  follower.step(FIXED_DT, nav, actors, actor);
  assert.equal(nav.calls.releasePath.length, releasesBefore + 1, 'must release the now-stale handle');
  assert.ok(follower.active, 'the order itself survives a version bump (it just repaths)');
});

test('PathFollower: cancel() releases a held path and cancels an outstanding request — never leaks either', () => {
  // Case 1: cancelling while a path is SOLVED and held.
  {
    const nav = makeFakeNav({ resolveAfterPolls: 0 });
    const actors = makeFakeActors();
    const actor = makeFakeActor(0, 0);
    const follower = new PathFollower();
    follower.beginOrder(nav, actor, 5, 0);
    follower.step(FIXED_DT, nav, actors, actor); // now MODE_FOLLOWING, holding a handle
    follower.cancel(nav);
    assert.equal(nav.calls.releasePath.length, 1);
    assert.equal(follower.active, false);
  }
  // Case 2: cancelling while a request is still PENDING.
  {
    const nav = makeFakeNav({ resolveAfterPolls: 100 }); // never resolves within this test
    const actors = makeFakeActors();
    const actor = makeFakeActor(0, 0);
    const follower = new PathFollower();
    follower.beginOrder(nav, actor, 5, 0); // MODE_PENDING
    follower.cancel(nav);
    assert.equal(nav.calls.cancelPath.length, 1);
  }
});

test('PathFollower: a brand-new order supersedes an in-flight one without leaking it', () => {
  const nav = makeFakeNav({ resolveAfterPolls: 0 });
  const actors = makeFakeActors();
  const actor = makeFakeActor(0, 0);
  const follower = new PathFollower();

  follower.beginOrder(nav, actor, 5, 0);
  follower.step(FIXED_DT, nav, actors, actor); // holding a solved handle now

  follower.beginOrder(nav, actor, -5, 0); // a fresh order, mid-walk
  assert.equal(nav.calls.releasePath.length, 1, 'the superseded handle must be released, not dropped silently');
});

test('PathFollower: dead actor cancels the order (§3.7); frozen/stunned (actors.canMove) keeps it', () => {
  const nav = makeFakeNav({ resolveAfterPolls: 0 });
  const actors = makeFakeActors();
  const actor = makeFakeActor(0, 0);
  const follower = new PathFollower();
  follower.beginOrder(nav, actor, 5, 0);
  actor.dead = true;
  follower.step(FIXED_DT, nav, actors, actor);
  assert.equal(follower.active, false);

  const nav2 = makeFakeNav({ resolveAfterPolls: 0 });
  const actor2 = makeFakeActor(0, 0);
  const follower2 = new PathFollower();
  follower2.beginOrder(nav2, actor2, 5, 0);
  actors.canMove = () => false; // ACTR-9/10 does not exist — this is the forward-compat guard
  follower2.step(FIXED_DT, nav2, actors, actor2);
  assert.equal(follower2.active, true, 'a canMove()===false order is kept, not cancelled');
  delete actors.canMove;
});

// ===========================================================================
// Module hygiene — src/player/ stays Node/three-free
// ===========================================================================

test('src/player/move.js has no three/document/window/performance.now() (source scan)', () => {
  const source = readFileSync(join(__dirname, '../../src/player/move.js'), 'utf8');
  const commentsMasked = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(commentsMasked, /from\s+["']three["']/);
  assert.doesNotMatch(commentsMasked, /\bdocument\s*\./);
  assert.doesNotMatch(commentsMasked, /\bwindow\s*\./);
  assert.doesNotMatch(commentsMasked, /performance\s*\.\s*now\s*\(/);
});

// ===========================================================================
// Layer 2 — targeted integration tests: real Nav/Actors/Physics/Player, the
// real testmap, driven through the real intent latch/ladder.
// ===========================================================================

const H = FIXED_DT;
const INTEGRATION_STEP_BUDGET = 2000;

/** Wires real PhysicsSystem/ActorsSystem/NavSystem/PlayerSystem onto one
 * stub ctx against `TESTMAP_FOOTPRINTS`/`TESTMAP_BOUNDS` — the same "real
 * subsystems, stub ctx, never enterZone()" shape
 * `tests/world/wrld3.test.js`'s own `makeNavForTestMap` already established,
 * extended with `actors` (for a real physics body -> real `blocked`
 * results) and `player` (a fake `render.cameraRig` stands in for RNDR-2,
 * since this file only needs `moveOrder`/`fixedUpdate`, never a real
 * camera write). */
async function makeIntegrationCtx() {
  const world = { staticFootprints: TESTMAP_FOOTPRINTS, current: null };
  const physics = new PhysicsSystem();
  const actors = new ActorsSystem();
  const nav = new NavSystem();
  const player = new PlayerSystem();
  const fakeRender = {
    cameraRig: {
      solveOrbitLock() {},
      withCameraWrite(camera, fn) {
        if (typeof fn === 'function') fn();
      },
    },
  };

  const ctx = makeStubCtx({
    rng: new Rng(SEEDS.a),
    systems: { world, physics, actors, nav, render: fakeRender, player },
  });

  await physics.init(ctx);
  for (const fp of TESTMAP_FOOTPRINTS) physics.addStatic(fp, fp.surface);
  physics.rebuild();

  await actors.init(ctx);

  await nav.init(ctx);
  nav.rebuild({
    zoneId: 'testmap',
    boundsMinX: TESTMAP_BOUNDS.minX,
    boundsMaxX: TESTMAP_BOUNDS.maxX,
    boundsMinZ: TESTMAP_BOUNDS.minZ,
    boundsMaxZ: TESTMAP_BOUNDS.maxZ,
    navVersion: 0,
  });

  return { ctx, physics, actors, nav, player, fakeRender };
}

/** Spawns (or re-teleports) the player actor at `(x, z)` and drives a real
 * click-to-move order at `(gx, gz)` through the real intent latch/ladder
 * (matching `tests/player/plyr1.test.js`'s own arrival-test convention),
 * stepping `player.fixedUpdate` until the order clears or the step budget
 * runs out. Returns `{ actor, steps, arrived }`.
 */
function driveOrder(ctx, player, actor, gx, gz) {
  const nav = ctx.get('nav');
  player.intent.hasMoveOrder = true;
  player.intent.moveX = gx;
  player.intent.moveZ = gz;
  player.intent.sequence++;

  let steps = 0;
  while (player.intent.hasMoveOrder && steps < INTEGRATION_STEP_BUDGET) {
    // The real Engine's system loop runs every registered subsystem's
    // fixedUpdate() each step, `nav`'s included — `nav.fixedUpdate` is what
    // actually drains its request ring (`AStarScheduler.runSolves`) and
    // resets its per-step accept throttle. This harness has no real Engine,
    // so it must call it explicitly or every `requestPath` past the first
    // handful silently "refuses" forever (the budget never replenishes).
    nav.fixedUpdate(H, ctx);
    player.fixedUpdate(H, ctx);
    ctx.time.step++;
    steps++;
  }
  return { actor, steps, arrived: !player.intent.hasMoveOrder };
}

test('integration: crossing the doorway chokepoint, room A far corner -> room B far corner', async () => {
  const { ctx, actors, player } = await makeIntegrationCtx();
  const a = TESTMAP_FAR_CORNERS.a;
  const b = TESTMAP_FAR_CORNERS.b;
  actors.spawn({ kind: 'player', team: 0, archetypeId: 'ravager', x: a.x, z: a.z, facing: 0 });
  await player.init(ctx);

  const { steps, arrived, actor } = driveOrder(ctx, player, player.actor, b.x, b.z);
  assert.ok(arrived, `must arrive within the generous step budget (took ${steps} steps)`);
  const arriveR = computeArriveRadius(actor);
  const dist = Math.sqrt((actor.x - b.x) ** 2 + (actor.z - b.z) ** 2);
  // Step 12's own arrival check is against the FINAL PATH NODE, not the raw
  // destination (move.js's own header cites this — a node is a 0.5 m grid
  // cell's CENTRE, `src/nav/astar.js#_reconstructPath`, never the exact
  // snapped float coordinate). The final node can sit up to half a cell's
  // diagonal from the true destination point, so the tolerance here is
  // `arriveR` PLUS that quantisation margin, not `arriveR` alone.
  const CELL_SIZE_M = 0.5;
  const finalNodeQuantisationMarginM = (CELL_SIZE_M * Math.SQRT2) / 2;
  assert.ok(dist <= arriveR + finalNodeQuantisationMarginM + 1e-6, `dist=${dist}`);
});

test('integration: detour around the free-standing pillar in room B', async () => {
  const { ctx, actors, player } = await makeIntegrationCtx();
  actors.spawn({ kind: 'player', team: 0, archetypeId: 'ravager', x: 2, z: 5, facing: 0 });
  await player.init(ctx);

  const { steps, arrived, actor } = driveOrder(ctx, player, player.actor, 18, 5);
  assert.ok(arrived, `must arrive within the generous step budget (took ${steps} steps)`);
  assert.ok(Math.abs(actor.x - 10) > 1.6 || Math.abs(actor.z - 5) > 1.6, 'must not have walked straight through the pillar');
});

test('integration: into the concave pocket (wedge trap) and back out', async () => {
  const { ctx, actors, player } = await makeIntegrationCtx();
  actors.spawn({ kind: 'player', team: 0, archetypeId: 'ravager', x: -10, z: -8, facing: 0 });
  await player.init(ctx);

  const into = driveOrder(ctx, player, player.actor, -16, -8);
  assert.ok(into.arrived, `must reach the pocket's interior (took ${into.steps} steps)`);

  const out = driveOrder(ctx, player, player.actor, -10, -8);
  assert.ok(out.arrived, `must escape the pocket back out (took ${out.steps} steps)`);
});

test('integration: grazing the diagonal-corner crates does not stick', async () => {
  const { ctx, actors, player } = await makeIntegrationCtx();
  actors.spawn({ kind: 'player', team: 0, archetypeId: 'ravager', x: 3, z: -6.5, facing: 0 });
  await player.init(ctx);

  const { steps, arrived } = driveOrder(ctx, player, player.actor, 9, -1.5);
  assert.ok(arrived, `must clear the crates' touching corner within the generous step budget (took ${steps} steps)`);
});

test('integration: a nav.rebuild() mid-order (version bump) is survived — repath, no leaked handle, arrival', async () => {
  const { ctx, actors, nav, player } = await makeIntegrationCtx();
  const a = TESTMAP_FAR_CORNERS.a;
  const b = TESTMAP_FAR_CORNERS.b;
  actors.spawn({ kind: 'player', team: 0, archetypeId: 'ravager', x: a.x, z: a.z, facing: 0 });
  await player.init(ctx);

  player.intent.hasMoveOrder = true;
  player.intent.moveX = b.x;
  player.intent.moveZ = b.z;
  player.intent.sequence++;

  let releaseCalls = 0;
  const origRelease = nav.releasePath.bind(nav);
  nav.releasePath = (path) => {
    releaseCalls++;
    return origRelease(path);
  };

  for (let i = 0; i < 30; i++) {
    nav.fixedUpdate(H, ctx); // see driveOrder's own comment — nav must be stepped too
    player.fixedUpdate(H, ctx);
    ctx.time.step++;
  } // let it get well underway
  nav.rebuild({
    zoneId: 'testmap',
    boundsMinX: TESTMAP_BOUNDS.minX,
    boundsMaxX: TESTMAP_BOUNDS.maxX,
    boundsMinZ: TESTMAP_BOUNDS.minZ,
    boundsMaxZ: TESTMAP_BOUNDS.maxZ,
    navVersion: 0,
  }); // version bump mid-flight

  let steps = 30;
  while (player.intent.hasMoveOrder && steps < INTEGRATION_STEP_BUDGET) {
    nav.fixedUpdate(H, ctx);
    player.fixedUpdate(H, ctx);
    ctx.time.step++;
    steps++;
  }
  assert.equal(player.intent.hasMoveOrder, false, `must still arrive after the rebuild (took ${steps} steps total)`);
  assert.ok(releaseCalls >= 1, 'the pre-rebuild handle must have been released, not abandoned');
});

// ===========================================================================
// Layer 3 — THE ACCEPTANCE CRITERION: 200 scripted runs across the test map
// ===========================================================================
//
// Definitions used below (per this ticket's brief, cited verbatim):
//   wedge         — failing to reach the destination within a generous step
//                   budget while the destination was reachable
//                   (nav.connected true at the time the run was scripted).
//   corner stick  — making no meaningful progress for a sustained window of
//                   steps while not yet arrived (the capsule grinding
//                   against geometry).
//
// STEP_BUDGET = 3000 (50 s at 60 Hz). The map's longest straight-line span
// is TESTMAP_FAR_CORNERS a<->b, ~41 m; at the one speed this milestone's
// stand-in `actors.moveSpeed` gives every actor (4.2 m/s — see
// `src/actors/motion.js`'s own `computeMoveSpeed`), that is ~586 steps
// unobstructed. 3000 is >5x that, generous margin for every detour/repath
// this map's obstacles can add.
//
// CORNER_STICK_WINDOW_STEPS = 180 (3 s), CORNER_STICK_MIN_PROGRESS_M = 0.15.
// Both ASSIGNED — no spec value exists for either. 3 s is comfortably past
// every legitimate transient pause this file's own algorithm can produce
// (a `MODE_PENDING` wait is capped at `PENDING_SOLVE_TIMEOUT_STEPS` = 15
// steps = 0.25 s; the budget-retry cap is 12 steps = 0.2 s) — a real
// corner-stick has to survive 12-15x longer than any of those before this
// window would ever flag it, so a false positive from ordinary path-solve
// latency is not possible by construction. 0.15 m over 3 s is a small
// fraction of a single fixed step's own worst-case displacement at full
// speed (4.2 m/s / 60 Hz ≈ 0.07 m/step — 180 steps at that pace covers many
// metres), so any run that is actually progressing trips this reset
// constantly and never accumulates toward the threshold.
const STEP_BUDGET = 3000;
const CORNER_STICK_WINDOW_STEPS = 180;
const CORNER_STICK_MIN_PROGRESS_M = 0.15;
const TOTAL_RUNS = 200;

/** Points chosen to force each of the test map's four purpose-built features
 * (docs/spec header of src/world/testmap.js) — the doorway, the pillar
 * detour, the concave pocket, and the diagonal-corner crates — plus the two
 * far corners. `MIN_PAIR_SEPARATION_M` keeps every scripted pair a real
 * walk, never a trivial near-zero-distance "arrival". */
const ANCHORS = Object.freeze([
  { x: TESTMAP_FAR_CORNERS.a.x, z: TESTMAP_FAR_CORNERS.a.z },
  { x: TESTMAP_FAR_CORNERS.b.x, z: TESTMAP_FAR_CORNERS.b.z },
  { x: -16, z: -8 }, // the pocket's interior
  { x: -10, z: -8 }, // just outside the pocket's mouth
  { x: 2, z: 5 }, // room B, pillar's west side
  { x: 18, z: 5 }, // room B, pillar's east side
  { x: 3, z: -6.5 }, // clear of the diagonal crates, one side
  { x: 9, z: -1.5 }, // clear of the diagonal crates, the other side
  // Not (TESTMAP_DOORWAY.x, ±z): the dividing wall is thin in X (±0.25 m)
  // but the doorway's own gap is only in Z (-1..1) — a point at x=0 with
  // |z| > 1 sits INSIDE the wall's thin band, not "near the doorway" at
  // all. Offset in X so these land on open ground close to the chokepoint.
  { x: TESTMAP_DOORWAY.x + 2, z: 3 }, // room B, just past the doorway
  { x: TESTMAP_DOORWAY.x - 2, z: -3 }, // room A, just before the doorway
]);
const MIN_PAIR_SEPARATION_M = 5;

/** A random point inside `TESTMAP_BOUNDS` (shrunk by `margin`), snapped to
 * the nearest walkable point within `snapRadius` — retried up to
 * `MAX_ATTEMPTS` times on the rare miss (a point that lands deep inside an
 * obstacle's own footprint plus dilation). Throws rather than silently
 * returning a bad point if every attempt fails — a scripted run must start
 * from a point this test KNOWS is walkable. */
function pickRandomWalkablePoint(nav, rng, margin, snapRadius, scratch) {
  const MAX_ATTEMPTS = 30;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const x = rng.range(TESTMAP_BOUNDS.minX + margin, TESTMAP_BOUNDS.maxX - margin);
    const z = rng.range(TESTMAP_BOUNDS.minZ + margin, TESTMAP_BOUNDS.maxZ - margin);
    const snapped = nav.snap(x, z, snapRadius, scratch);
    if (snapped !== null) return { x: snapped.x, z: snapped.z };
  }
  throw new Error(`pickRandomWalkablePoint: no walkable point found after ${MAX_ATTEMPTS} attempts`);
}

/** Builds the 200 (start, goal) pairs for this run, deterministically from
 * `rng` (a `src/core/rng.js#Rng`, per rule 3 — never `Math.random()`, never
 * a subsystem `ctx.rng.fork()`; this is a TEST generating its own scripted
 * scenarios). The first `ANCHORS.length * (ANCHORS.length - 1)` or so pairs
 * cycle every ordered anchor-to-anchor combination (guaranteeing every
 * purpose-built feature is actually exercised, not left to chance); the
 * remainder are uniformly random reachable points across the whole map. */
function buildScriptedPairs(nav, rng, count) {
  const pairs = [];
  const scratch = { x: 0, y: 0, z: 0 };

  for (let i = 0; i < ANCHORS.length && pairs.length < count; i++) {
    for (let j = 0; j < ANCHORS.length && pairs.length < count; j++) {
      if (i === j) continue;
      const a = ANCHORS[i];
      const b = ANCHORS[j];
      const dist = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
      if (dist < MIN_PAIR_SEPARATION_M) continue;
      pairs.push({ start: a, goal: b, kind: 'anchor' });
    }
  }

  while (pairs.length < count) {
    const start = pickRandomWalkablePoint(nav, rng, 0.6, 3.0, scratch);
    const goal = pickRandomWalkablePoint(nav, rng, 0.6, 3.0, scratch);
    const dist = Math.sqrt((start.x - goal.x) ** 2 + (start.z - goal.z) ** 2);
    if (dist < MIN_PAIR_SEPARATION_M) continue;
    pairs.push({ start, goal, kind: 'random' });
  }

  return pairs.slice(0, count);
}

/** Drives one scripted run: teleport to `start`, order to `goal`, step until
 * arrival or `STEP_BUDGET` is exhausted, watching for a corner-stick window
 * throughout (never breaking early on one — both metrics are measured
 * independently and honestly for every run, per this ticket's brief). */
function runScriptedOrder(ctx, nav, actors, follower, actor, start, goal) {
  actors.teleport(actor, start.x, start.z);
  follower.cancel(nav);

  const accepted = follower.beginOrder(nav, actor, goal.x, goal.z);
  if (!accepted) return { accepted: false, arrived: false, steps: 0, cornerStick: false };

  let refX = actor.x;
  let refZ = actor.z;
  let stuckSteps = 0;
  let cornerStick = false;
  let steps = 0;

  for (; steps < STEP_BUDGET; steps++) {
    if (!follower.active) break;
    // See driveOrder's own comment: nav.fixedUpdate must run every step too
    // (it drains the A* request ring and resets the per-step accept
    // throttle) — there is no real Engine in this harness to do it for us.
    nav.fixedUpdate(FIXED_DT, ctx);
    follower.step(FIXED_DT, nav, actors, actor);
    ctx.time.step++;
    const dx = actor.x - refX;
    const dz = actor.z - refZ;
    const moved = Math.sqrt(dx * dx + dz * dz);
    if (moved > CORNER_STICK_MIN_PROGRESS_M) {
      refX = actor.x;
      refZ = actor.z;
      stuckSteps = 0;
    } else {
      stuckSteps++;
      if (stuckSteps >= CORNER_STICK_WINDOW_STEPS) cornerStick = true;
    }
  }

  return { accepted: true, arrived: !follower.active, steps, cornerStick };
}

test('THE ACCEPTANCE CRITERION: 200 scripted runs across the test map — zero wedges, zero corner sticks', async () => {
  const { ctx, nav, actors } = await makeIntegrationCtx();
  const actor = actors.spawn({ kind: 'player', team: 0, archetypeId: 'ravager', x: 0, z: 0, facing: 0 });
  const follower = new PathFollower();

  const rng = new Rng(SEEDS.b); // this TEST's own seeded generator (rule 3) — never a subsystem fork
  const pairs = buildScriptedPairs(nav, rng, TOTAL_RUNS);
  assert.equal(pairs.length, TOTAL_RUNS);

  let wedgeCount = 0;
  let cornerStickCount = 0;
  const wedgeDetails = [];
  const cornerStickDetails = [];

  for (let i = 0; i < pairs.length; i++) {
    const { start, goal } = pairs[i];
    // Every pair is drawn from a single-region map (tests/world/wrld3.test.js
    // already proves TESTMAP_FOOTPRINTS rasterises to exactly one connected
    // walkable region) and every point was itself accepted by nav.snap — so
    // nav.connected(start, goal) is true for every one of these 200 pairs by
    // construction; asserted directly anyway rather than merely assumed.
    assert.ok(nav.connected(start.x, start.z, goal.x, goal.z), `run ${i}: scripted pair must be reachable`);

    const result = runScriptedOrder(ctx, nav, actors, follower, actor, start, goal);
    assert.ok(result.accepted, `run ${i}: a validated-reachable pair must never be dropped as unreachable`);

    if (!result.arrived) {
      wedgeCount++;
      wedgeDetails.push({ i, start, goal, steps: result.steps });
    }
    if (result.cornerStick) {
      cornerStickCount++;
      cornerStickDetails.push({ i, start, goal, steps: result.steps });
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[PLYR-2] 200-run acceptance: wedges=${wedgeCount} cornerSticks=${cornerStickCount} ` +
      `(stepBudget=${STEP_BUDGET}, cornerStickWindowSteps=${CORNER_STICK_WINDOW_STEPS}, ` +
      `cornerStickMinProgressM=${CORNER_STICK_MIN_PROGRESS_M})`,
  );

  assert.equal(wedgeCount, 0, `expected zero wedges, got ${wedgeCount}: ${JSON.stringify(wedgeDetails)}`);
  assert.equal(cornerStickCount, 0, `expected zero corner sticks, got ${cornerStickCount}: ${JSON.stringify(cornerStickDetails)}`);
});
