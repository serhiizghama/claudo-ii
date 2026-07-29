// tests/actors/actr2.test.js
//
// ACTR-2 acceptance tests for src/actors/motion.js (teleport/face/distance/
// inRange/moveSpeed, the write guard) and the thin wiring src/actors/index.js
// adds for them. `node:test` + `node:assert/strict` only — no framework
// (12-testing.md P6).
//
// Scope: everything ACTR-2 owns per this ticket. `moveTo` itself (ACTR-1's
// own slice) is already covered by tests/actors/actr1.test.js and is not
// re-tested here except where a scenario needs it as a fixture (the write
// guard must not have broken it). `applyImpulse` is not implemented — see
// motion.js's own header — and is not tested.
//
// THE MAIN TEST is "a direct actor.x write from outside is caught" below —
// the acceptance criterion's second half, the one with teeth.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ActorsSystem } from '../../src/actors/index.js';
import {
  teleportActor,
  faceActor,
  actorDistance,
  actorsInRange,
  computeMoveSpeed,
  installActorWriteGuard,
  beginActorWrite,
  endActorWrite,
  TELEPORT_SNAP_RADIUS,
} from '../../src/actors/motion.js';
import { createActorRecord } from '../../src/actors/pool.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { EventBus } from '../../src/core/events.js';
import { QUALITY_PRESETS } from '../../src/core/config.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';

// ---------------------------------------------------------------------------
// ctx builders — same shape as tests/actors/actr1.test.js's own helpers.
// ---------------------------------------------------------------------------

async function makeCtxWithPhysics(quality, extraSystems = {}) {
  const events = new EventBus();
  const config = { quality, q: QUALITY_PRESETS[quality] };
  const physics = new PhysicsSystem();
  const systems = { physics, ...extraSystems };
  const ctx = {
    events,
    config,
    get(id) {
      if (systems[id]) return systems[id];
      throw new Error(`stub ctx.get: '${id}' is not available`);
    },
    peek(id) {
      return systems[id];
    },
    has(id) {
      return !!systems[id];
    },
  };
  await physics.init(ctx);
  return { ctx, physics };
}

async function makeActors(quality, extraSystems = {}) {
  const { ctx, physics } = await makeCtxWithPhysics(quality, extraSystems);
  const actors = new ActorsSystem();
  await actors.init(ctx);
  return { actors, physics, ctx };
}

async function makeActorsNoPhysics() {
  const events = new EventBus();
  const ctx = {
    events,
    config: {},
    get(id) {
      throw new Error(`stub ctx.get: '${id}' is not available`);
    },
    peek() {
      return undefined;
    },
    has() {
      return false;
    },
  };
  const actors = new ActorsSystem();
  await actors.init(ctx);
  return { actors, ctx };
}

// ---------------------------------------------------------------------------
// Node-safety — src/actors/ is not yet an auto-scanned check-imports.mjs
// root; motion.js's own new code must stay three-free too.
// ---------------------------------------------------------------------------

test('src/actors/motion.js and index.js still never reference three', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [join(here, '../../src/actors/motion.js'), join(here, '../../src/actors/index.js')];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.equal(/from\s+['"]three['"]/.test(src), false, `${f} must not import 'three'`);
    assert.equal(/import\s*\(\s*['"]three['"]/.test(src), false, `${f} must not dynamically import 'three'`);
  }
});

// ---------------------------------------------------------------------------
// THE MAIN TEST — the acceptance criterion's second half: a direct write
// from outside the subsystem is caught, in a dev build, the moment it
// happens.
// ---------------------------------------------------------------------------

test('MAIN: a direct actor.x = ... / actor.z = ... write from outside throws in a dev build, and leaves the value unchanged', async () => {
  const { actors } = await makeActors('high');
  const actor = actors.spawn({ x: 3, z: 4 });

  assert.throws(() => {
    actor.x = 999;
  }, /illegal direct write to actor\.x/);
  assert.equal(actor.x, 3, 'the rejected write must not have taken effect');

  assert.throws(() => {
    actor.z = 999;
  }, /illegal direct write to actor\.z/);
  assert.equal(actor.z, 4, 'the rejected write must not have taken effect');
});

test('MAIN: motion writes go through — moveTo and teleport both succeed under the very same guard that rejects a direct write', async () => {
  const { actors } = await makeActors('high');
  const actor = actors.spawn({ x: 0, z: 0 });

  actors.moveTo(actor, 1, 1);
  assert.equal(actor.x, 1);
  assert.equal(actor.z, 1);

  assert.equal(actors.teleport(actor, 10, 10), true);
  assert.equal(actor.x, 10);
  assert.equal(actor.z, 10);

  // The guard is still live for this same actor after both legal writes.
  assert.throws(() => {
    actor.x = 12345;
  }, /illegal direct write/);
});

test('the guard survives a despawn/respawn cycle on the same recycled slot — spawn()/despawn() are not themselves caught by their own guard', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({ x: 1, z: 1 });
  const slot = a.poolIndex;
  actors.despawn(a);
  assert.equal(a.x, 0, 'despawn (resetActorRecord) must have zeroed the recycled record');

  const b = actors.spawn({ x: 5, z: 6 });
  assert.equal(b.poolIndex, slot, 'same slot recycled — the SAME underlying object, already guarded');
  assert.equal(b.x, 5);
  assert.equal(b.z, 6);

  assert.throws(() => {
    b.x = 1;
  }, /illegal direct write/);
});

test('installActorWriteGuard is idempotent — installing it twice on the same actor does not lose the guard or double-wrap it', async () => {
  const { actors } = await makeActors('high');
  const actor = actors.spawn({ x: 2, z: 2 });
  assert.doesNotThrow(() => installActorWriteGuard(actor));
  assert.equal(actor.x, 2);
  assert.throws(() => {
    actor.x = 999;
  }, /illegal direct write/);
});

test('beginActorWrite/endActorWrite bracket a legal external write the same way spawn()/moveTo() do internally', async () => {
  const { actors } = await makeActors('high');
  const actor = actors.spawn({ x: 0, z: 0 });

  beginActorWrite();
  try {
    actor.x = 42;
    actor.z = 43;
  } finally {
    endActorWrite();
  }
  assert.equal(actor.x, 42);
  assert.equal(actor.z, 43);

  assert.throws(() => {
    actor.x = 0;
  }, /illegal direct write/);
});

// ---------------------------------------------------------------------------
// Regression (found by the orchestrator's own probe, not this file's first
// pass): the write window is a REENTRANT DEPTH COUNTER, not a boolean. A
// boolean lock has no memory of "how many opens are pending" — an inner
// beginActorWrite()/endActorWrite() pair nested inside an outer one closes
// the OUTER window the instant the inner endActorWrite() runs, so the outer
// sanctioned writer's own write then throws as if it were illegal. Nothing
// in this ticket's own call graph nests today, but a future
// actor:spawn/actor:death listener that moves or despawns a DIFFERENT actor
// while spawn()/despawn()'s own window is still open — or applyImpulse
// calling moveTo once ACTR-9/10 land — would nest exactly like this.
// ---------------------------------------------------------------------------

test('REGRESSION: a nested beginActorWrite()/endActorWrite() pair does not close the OUTER write window early', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({ x: 0, z: 0 });

  beginActorWrite(); // outer — e.g. despawn() bracketing pool.release()
  try {
    beginActorWrite(); // inner — any sanctioned writer called in between
    endActorWrite(); // inner end — must NOT close the outer window

    // The outer writer's own write must still succeed — this is the write
    // a boolean lock would incorrectly reject at this point.
    assert.doesNotThrow(() => {
      a.x = 7;
    }, 'the OUTER write window must still be open after the inner pair closed');
    assert.equal(a.x, 7);
  } finally {
    endActorWrite(); // outer end
  }

  // Guard is re-armed only once the OUTERMOST end has run.
  assert.throws(() => {
    a.x = 8;
  }, /illegal direct write/);
});

test('REGRESSION: endActorWrite() at depth 0 (no matching beginActorWrite() open) throws loudly rather than going negative', () => {
  assert.throws(() => {
    endActorWrite();
  }, /no matching beginActorWrite/);
});

test('REGRESSION: nesting to three levels deep still only re-arms the guard once the outermost end runs', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({ x: 0, z: 0 });

  beginActorWrite();
  beginActorWrite();
  beginActorWrite();
  endActorWrite();
  endActorWrite();
  assert.doesNotThrow(() => {
    a.x = 1;
  }, 'still one level of nesting open — the write must still succeed');
  endActorWrite();
  assert.throws(() => {
    a.x = 2;
  }, /illegal direct write/);
});

test('a plain (unguarded) record built directly by createActorRecord — never handed through ActorsSystem.spawn() — is never touched by the guard', () => {
  const record = createActorRecord(0);
  assert.doesNotThrow(() => {
    record.x = 100;
    record.z = 200;
  });
  assert.equal(record.x, 100);
  assert.equal(record.z, 200);
});

// ---------------------------------------------------------------------------
// Guard hygiene: enumerable/configurable preserved, no visible marker field
// ---------------------------------------------------------------------------

test('the guarded x/z stay enumerable — Object.keys/JSON.stringify/spread all see them exactly as before', async () => {
  const { actors } = await makeActors('high');
  const actor = actors.spawn({ x: 7, z: 8 });
  assert.ok(Object.keys(actor).includes('x'));
  assert.ok(Object.keys(actor).includes('z'));
  const spread = { ...actor };
  assert.equal(spread.x, 7);
  assert.equal(spread.z, 8);
  const parsed = JSON.parse(JSON.stringify({ x: actor.x, z: actor.z }));
  assert.deepEqual(parsed, { x: 7, z: 8 });
});

// ---------------------------------------------------------------------------
// teleport
// ---------------------------------------------------------------------------

test('teleport (nav absent): places the actor instantly, snaps prevX/prevZ to the same point (no glide), and returns true', async () => {
  const { actors, physics } = await makeActors('high');
  const actor = actors.spawn({ x: 0, z: 0 });

  const ok = actors.teleport(actor, 20, 30);
  assert.equal(ok, true);
  assert.equal(actor.x, 20);
  assert.equal(actor.z, 30);
  assert.equal(actor.prevX, 20, 'a teleport must not leave a stale prevX for update() to interpolate a glide from');
  assert.equal(actor.prevZ, 30);
  assert.equal(physics.stats.bodies, 1, 'the body must still exist');
});

test('teleport keeps the physics body in sync (setBody, not moveBody) and resamples ground height', async () => {
  const { actors, physics } = await makeActors('high');
  const actor = actors.spawn({ x: 0, z: 0 });
  physics._bounds = { minX: -50, minZ: -50, maxX: 50, maxZ: 50 }; // pretend a zone is loaded

  const ok = actors.teleport(actor, 5, 5);
  assert.equal(ok, true);
  assert.equal(actor.x, 5);
  assert.equal(actor.z, 5);
  assert.equal(actor.y, 0, 'flat groundHeight placeholder inside bounds is 0');

  // Confirm the body actually moved too, not just the record: moveBody from
  // the new body position should behave as if it starts at (5,5).
  const result = actors.moveTo(actor, 1, 0);
  assert.equal(result.x, 6);
});

test('teleport on a bodyless actor (physics absent) still moves the record directly', async () => {
  const { actors } = await makeActorsNoPhysics();
  const actor = actors.spawn({ x: 0, z: 0 });
  const ok = actors.teleport(actor, 9, 9);
  assert.equal(ok, true);
  assert.equal(actor.x, 9);
  assert.equal(actor.z, 9);
});

test('teleport is a safe false on a null or inactive (despawned) actor', async () => {
  const { actors } = await makeActors('high');
  assert.equal(actors.teleport(null, 1, 1), false);

  const a = actors.spawn({ x: 1, z: 1 });
  actors.despawn(a);
  assert.equal(actors.teleport(a, 5, 5), false);
  assert.equal(a.x, 0, 'a despawned actor must not be moved by teleport either');
});

test('teleport (nav present): a successful snap moves the actor to the snapped point, not the raw request', async () => {
  const { actors } = await makeActors('high', {
    nav: {
      snap(x, z, maxRadius, out) {
        out.x = x + 1;
        out.y = 0;
        out.z = z + 1;
        return out;
      },
    },
  });
  const actor = actors.spawn({ x: 0, z: 0 });
  const ok = actors.teleport(actor, 10, 10);
  assert.equal(ok, true);
  assert.equal(actor.x, 11);
  assert.equal(actor.z, 11);
});

test('teleport (nav present): nav.snap returning null is a failed teleport — actor stays put, returns false', async () => {
  const { actors } = await makeActors('high', {
    nav: {
      snap() {
        return null;
      },
    },
  });
  const actor = actors.spawn({ x: 3, z: 3 });
  const ok = actors.teleport(actor, 100, 100);
  assert.equal(ok, false);
  assert.equal(actor.x, 3, 'a failed snap must not move the actor');
  assert.equal(actor.z, 3);
});

test('teleport passes TELEPORT_SNAP_RADIUS to nav.snap', async () => {
  let seenRadius = null;
  const { actors } = await makeActors('high', {
    nav: {
      snap(x, z, maxRadius, out) {
        seenRadius = maxRadius;
        out.x = x;
        out.y = 0;
        out.z = z;
        return out;
      },
    },
  });
  const actor = actors.spawn({ x: 0, z: 0 });
  actors.teleport(actor, 1, 1);
  assert.equal(seenRadius, TELEPORT_SNAP_RADIUS);
});

test('teleportActor (low-level): an inactive actor is a no-op that returns false without touching x/z', () => {
  const record = createActorRecord(0);
  record.x = 4;
  record.z = 4;
  record.active = false;
  const out = { x: 0, y: 0, z: 0 };
  const result = teleportActor(record, 99, 99, null, 0, null, out);
  assert.equal(result, false);
  assert.equal(record.x, 4);
  assert.equal(record.z, 4);
});

test('teleport allocates nothing per call (nav absent)', async (t) => {
  if (!hasGc()) {
    t.skip('run with node --expose-gc');
    return;
  }
  const { actors } = await makeActors('high');
  const actor = actors.spawn({ x: 0, z: 0 });
  let sign = 1;
  const fn = () => {
    actors.teleport(actor, sign * 5, 0);
    sign = -sign;
  };
  const { bytesPerCall } = assertAllocationFree(fn, { iterations: 2_000_000, maxRounds: 50 });
  assert.ok(bytesPerCall < 1);
});

// ---------------------------------------------------------------------------
// face
// ---------------------------------------------------------------------------

test('face turns toward the target by at most maxTurnRate (rad/s) × one fixed step (1/60 s), taking the shortest arc', async () => {
  const { actors } = await makeActors('high');
  const actor = actors.spawn({ x: 0, z: 0, facing: 0 });

  // Target is straight along +Z from the actor: atan2(dz,dx) = atan2(1,0) = PI/2.
  // A turn rate of 60 rad/s means exactly 1 rad of budget this single call.
  actors.face(actor, 0, 1, 60);
  assert.ok(Math.abs(actor.facing - 1) < 1e-9, `expected exactly 1 rad turned, got ${actor.facing}`);
  assert.equal(actor.prevFacing, 0);
});

test('face reaches the target exactly and stops overshooting once within maxStep of it', async () => {
  const { actors } = await makeActors('high');
  const actor = actors.spawn({ x: 0, z: 0, facing: 0 });
  // Target straight along +Z: needed turn is PI/2. A huge turn rate reaches
  // it in one call and must land exactly there, not past it.
  actors.face(actor, 0, 1, 10000);
  assert.ok(Math.abs(actor.facing - Math.PI / 2) < 1e-9);
});

test('face takes the shortest arc, never the long way around', async () => {
  const { actors } = await makeActors('high');
  // Facing just past +PI/2 turned toward just past -PI/2 the short way is
  // through PI/-PI (a small delta), not the long way through 0.
  const actor = actors.spawn({ x: 0, z: 0, facing: Math.PI - 0.05 });
  // Target direction picked so its atan2 sits just past -PI (i.e. close to
  // -PI + 0.05), so the shortest arc from (PI - 0.05) is a small step of
  // ~0.1 rad across the wrap, not ~2PI - 0.1 the other way.
  const targetFacing = -Math.PI + 0.05;
  const tx = Math.cos(targetFacing);
  const tz = Math.sin(targetFacing);
  actors.face(actor, tx, tz, 10000); // effectively unlimited — should land exactly on target
  const wrapped = actor.facing > Math.PI ? actor.facing - 2 * Math.PI : actor.facing;
  assert.ok(Math.abs(wrapped - targetFacing) < 1e-6, `expected ${targetFacing}, got ${wrapped}`);
});

test('face is a no-op when the actor is already exactly at the target point', async () => {
  const { actors } = await makeActors('high');
  const actor = actors.spawn({ x: 5, z: 5, facing: 1.23 });
  actors.face(actor, 5, 5, 100);
  assert.equal(actor.facing, 1.23, 'nothing to face toward — facing must not change');
});

test('face is a safe no-op on a null or inactive actor', async () => {
  const { actors } = await makeActors('high');
  assert.doesNotThrow(() => actors.face(null, 1, 1, 10));
  const a = actors.spawn({ x: 0, z: 0 });
  actors.despawn(a);
  assert.doesNotThrow(() => actors.face(a, 1, 1, 10));
});

test('faceActor (low-level, direct): 720 deg/s over one fixed step turns exactly 12 degrees worth of radians', () => {
  const record = createActorRecord(0);
  record.active = true;
  record.x = 0;
  record.z = 0;
  record.facing = 0;
  const rateRadPerSec = (720 * Math.PI) / 180; // 11-flows.md's own example rate
  faceActor(record, 0, 1, rateRadPerSec);
  const expectedStep = rateRadPerSec / 60; // one fixed step at 60 Hz
  assert.ok(Math.abs(record.facing - expectedStep) < 1e-9);
});

test('face allocates nothing per call', async (t) => {
  if (!hasGc()) {
    t.skip('run with node --expose-gc');
    return;
  }
  const { actors } = await makeActors('high');
  const actor = actors.spawn({ x: 0, z: 0, facing: 0 });
  let sign = 1;
  const fn = () => {
    actors.face(actor, sign, 1, 4.0);
    sign = -sign;
  };
  // Same O-23/O-21 "polymorphic hot path needs a longer warm-up" signature
  // documented in tests/actors/actr1.test.js's own `moveTo allocates nothing
  // per call` — isolated measurement (see this ticket's report) showed a
  // strictly decreasing curve as `iterations` grows (42.1 B/call at 10 000,
  // 16.2 at 100 000, 3.6 at 1 000 000, 0.09 at 5 000 000), the signature of a
  // one-time inline-cache/shape-transition cost being diluted, not a leak.
  const { bytesPerCall } = assertAllocationFree(fn, { iterations: 5_000_000, maxRounds: 50 });
  assert.ok(bytesPerCall < 1);
});

// ---------------------------------------------------------------------------
// distance / inRange
// ---------------------------------------------------------------------------

test('distance is surface-to-surface: centre distance minus both radii', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({ x: 0, z: 0 });
  const b = actors.spawn({ x: 10, z: 0 });
  a.radius = 1;
  b.radius = 2;
  assert.ok(Math.abs(actors.distance(a, b) - 7) < 1e-9); // 10 - 1 - 2
});

test('distance can go negative when two actors overlap — not clamped to zero', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({ x: 0, z: 0 });
  const b = actors.spawn({ x: 1, z: 0 });
  a.radius = 2;
  b.radius = 2;
  assert.ok(actors.distance(a, b) < 0);
});

test('inRange uses the same surface-to-surface metric as distance', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({ x: 0, z: 0 });
  const b = actors.spawn({ x: 5, z: 0 });
  a.radius = 0.5;
  b.radius = 0.5;
  const d = actors.distance(a, b); // 4
  assert.equal(actors.inRange(a, b, d), true);
  assert.equal(actors.inRange(a, b, d - 0.01), false);
  assert.equal(actors.inRange(a, b, d + 0.01), true);
});

test('distance/inRange allocate nothing per call', async (t) => {
  if (!hasGc()) {
    t.skip('run with node --expose-gc');
    return;
  }
  const { actors } = await makeActors('high');
  const a = actors.spawn({ x: 0, z: 0 });
  const b = actors.spawn({ x: 5, z: 0 });
  let touched = 0;
  const fn = () => {
    touched += actorsInRange(a, b, 10) ? 1 : 0;
    touched += actorDistance(a, b) > 0 ? 1 : 0;
  };
  const { bytesPerCall } = assertAllocationFree(fn, { iterations: 2_000_000, maxRounds: 50 });
  assert.ok(bytesPerCall < 1);
  assert.ok(touched >= 0);
});

// ---------------------------------------------------------------------------
// moveSpeed
// ---------------------------------------------------------------------------

test('moveSpeed follows 03-combat-math.md:270\'s formula against the documented placeholder inputs (movementSpeed=0) — always the assigned class run speed today', async () => {
  const { actors } = await makeActors('high');
  const player = actors.spawn({ kind: 'player', archetypeId: 'ravager' });
  const monster = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker' });
  assert.equal(actors.moveSpeed(player), 4.2);
  assert.equal(actors.moveSpeed(monster), 4.2, 'no archetype table exists yet — see motion.js\'s report note');
});

test('computeMoveSpeed clamps to [0.8, 12.0] per the formula (exercised directly since movementSpeed has no real input path yet)', () => {
  const actor = createActorRecord(0);
  assert.ok(computeMoveSpeed(actor) >= 0.8);
  assert.ok(computeMoveSpeed(actor) <= 12.0);
});

// ---------------------------------------------------------------------------
// Registry wiring smoke test — the new methods survive a real boot
// ---------------------------------------------------------------------------

test('teleport/face/distance/inRange/moveSpeed all work through a real Registry-wired ActorsSystem', async () => {
  const { actors } = await makeActors('high');
  const a = actors.spawn({ x: 0, z: 0 });
  const b = actors.spawn({ x: 3, z: 0 });

  assert.equal(typeof actors.teleport(a, 1, 1), 'boolean');
  assert.equal(typeof actors.distance(a, b), 'number');
  assert.equal(typeof actors.inRange(a, b, 10), 'boolean');
  assert.equal(typeof actors.moveSpeed(a), 'number');
  assert.doesNotThrow(() => actors.face(a, 5, 5, 10));
});
