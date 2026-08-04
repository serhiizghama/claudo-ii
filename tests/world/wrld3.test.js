// tests/world/wrld3.test.js
//
// WRLD-3 acceptance tests for src/world/index.js (the emission-order
// criterion + the O-38 fix) and src/world/testmap.js (the hand-authored test
// map). `node:test` + `node:assert/strict` only (12-testing.md P6).
//
// Scope:
//  - THE ACCEPTANCE CRITERION: `teardown -> enter -> physics.rebuild ->
//    nav.rebuild -> ready`, asserted by a listener log, for a first entry and
//    for a zone change.
//  - O-37's trap: `physics` ALSO listens to `zone:ready` and rebuilds its
//    static grid a second time (`02-api-contracts.md` §4's own event table)
//    — a real, documented double rehash that is not this ticket's to fix.
//    Every assertion below is therefore on ORDER (does a `physics.rebuild`
//    occur between `zone:enter` and `zone:ready`; does `nav.rebuild` occur
//    after that and still before `zone:ready`), never on a call COUNT.
//  - O-38: `nav.rebuild()`, driven through a REAL `enterZone()`, rasterises
//    the ZONE JUST ENTERED — not the previous zone's geometry, and not
//    nothing (the placeholder grid), on a first entry. Proved behaviourally
//    (grid dimensions, `walkable()` at points that only make sense under the
//    correct zone's own bounds) — never by reading a private field.
//  - The test map (`src/world/testmap.js`): O-35 field-name compliance, a
//    single connected region, and a real `requestPath` solving across the
//    two far corners. Fed to `nav` the same "stub world" way
//    `tests/nav/nav1.test.js`'s own `makeStubWorld`/`makeZone` already do —
//    never through `enterZone` (`testmap.js` is not a fifth `ZoneDescriptor`;
//    see that file's own header for why).
//
// Per O-27/O-39: no assertion here encodes "this method doesn't exist yet"
// or a hard-coded subsystem/body/static count; every check is on real
// rasterised/solved behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { WorldSystem } from '../../src/world/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { NavSystem } from '../../src/nav/index.js';
import { TESTMAP_BOUNDS, TESTMAP_FOOTPRINTS, TESTMAP_FAR_CORNERS, TESTMAP_DOORWAY } from '../../src/world/testmap.js';
import { Rng } from '../../src/core/rng.js';
import { makeStubCtx } from '../helpers/actor.js';
import { SEEDS } from '../helpers/seed.js';

const CELL = 0.5; // 01-data-model.md §9.3 — fixed across all zones

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A real `WorldSystem` + `PhysicsSystem` + `NavSystem`, wired onto one
 * stub `ctx` — the actual boot-order shape (`02-api-contracts.md` § Init
 * order: `... -> physics -> world -> ...`, and `nav`'s own `static
 * deps=['world']`), so `enterZone`'s real emission order and its real
 * handoff into `nav` are both exercised end to end. Never stubbed — this is
 * exactly the gap `tests/nav/nav1.test.js`'s own "boot-safety" test left
 * open (it could only assert `nav.version` increased, not that the rebuilt
 * grid reflected the right zone, because at the time that test was written
 * this ticket's fix did not exist yet). */
async function makeWorldWithNav({ seed = SEEDS.a } = {}) {
  const world = new WorldSystem();
  const physics = new PhysicsSystem();
  const nav = new NavSystem();
  const ctx = makeStubCtx({ rng: new Rng(seed), systems: { world, physics, nav } });
  await physics.init(ctx);
  await world.init(ctx);
  await nav.init(ctx);
  return { world, physics, nav, ctx };
}

/** Wraps `physics.rebuild`/`nav.rebuild` in place (own-property shadowing —
 * `this.rebuild()` inside `physics`'s own `zone:ready` listener resolves to
 * the wrapper too, since it reads off the same instance) and listens for the
 * three zone events, all into one ordered log. Returns the log array,
 * mutated in place as `enterZone` runs. */
function attachOrderLog(ctx, physics, nav) {
  const log = [];
  ctx.events.on('zone:teardown', (p) => log.push(['zone:teardown', p]));
  ctx.events.on('zone:enter', (p) => log.push(['zone:enter', p]));
  ctx.events.on('zone:ready', (p) => log.push(['zone:ready', p]));

  const origPhysicsRebuild = physics.rebuild.bind(physics);
  physics.rebuild = (...args) => {
    log.push(['physics.rebuild']);
    return origPhysicsRebuild(...args);
  };

  const origNavRebuild = nav.rebuild.bind(nav);
  nav.rebuild = (...args) => {
    log.push(['nav.rebuild']);
    return origNavRebuild(...args);
  };

  return log;
}

/**
 * Checks the contractual chain `teardown -> enter -> physics.rebuild ->
 * nav.rebuild -> ready` against an `attachOrderLog` log, as ORDER
 * relationships only (O-37 — `physics.rebuild` legitimately fires more than
 * once; never assert a count).
 * @param {Array<[string, object?]>} log
 * @param {{firstEntry: boolean}} opts
 */
function assertContractualOrder(log, { firstEntry }) {
  const idxOf = (tag) => log.findIndex((e) => e[0] === tag);
  const idxsOf = (tag) => log.reduce((acc, e, i) => (e[0] === tag ? (acc.push(i), acc) : acc), []);

  const teardownIdx = idxOf('zone:teardown');
  const enterIdx = idxOf('zone:enter');
  const readyIdx = idxOf('zone:ready');
  const physicsIdxs = idxsOf('physics.rebuild');
  const navIdxs = idxsOf('nav.rebuild');

  assert.ok(enterIdx >= 0, 'zone:enter must fire');
  assert.ok(readyIdx > enterIdx, 'zone:ready must fire after zone:enter');

  if (firstEntry) {
    assert.equal(teardownIdx, -1, 'zone:teardown must not fire on the very first zone');
  } else {
    assert.ok(teardownIdx >= 0, 'zone:teardown must fire on a zone change');
    assert.ok(teardownIdx < enterIdx, 'zone:teardown must fire before zone:enter');
  }

  assert.ok(physicsIdxs.length >= 1, 'at least one physics.rebuild must occur');
  const physicsBetween = physicsIdxs.filter((i) => i > enterIdx && i < readyIdx);
  assert.ok(physicsBetween.length >= 1, 'a physics.rebuild must occur strictly between zone:enter and zone:ready');

  assert.ok(navIdxs.length >= 1, 'nav.rebuild must occur');
  const firstPhysicsBetween = physicsBetween[0];
  assert.ok(
    navIdxs.every((i) => i > firstPhysicsBetween && i < readyIdx),
    'nav.rebuild must occur after a physics.rebuild and still before zone:ready',
  );
}

// ---------------------------------------------------------------------------
// THE ACCEPTANCE CRITERION — emission order, listener log
// ---------------------------------------------------------------------------

test('MAIN: first entry — order is enter -> physics.rebuild -> nav.rebuild -> ready, zone:teardown absent', async () => {
  const { world, physics, nav, ctx } = await makeWorldWithNav();
  const log = attachOrderLog(ctx, physics, nav);

  await world.enterZone('last_bastion', 'town_start');

  assertContractualOrder(log, { firstEntry: true });
  // eslint-disable-next-line no-console
  console.log('[WRLD-3] first-entry listener log:', JSON.stringify(log.map((e) => e[0])));
});

test('MAIN: zone change — teardown -> enter -> physics.rebuild -> nav.rebuild -> ready, in that order', async () => {
  const { world, physics, nav, ctx } = await makeWorldWithNav();
  await world.enterZone('last_bastion', 'town_start');

  const log = attachOrderLog(ctx, physics, nav);
  await world.enterZone('ashen_wastes', 'portal_from_town');

  assertContractualOrder(log, { firstEntry: false });
  // eslint-disable-next-line no-console
  console.log('[WRLD-3] zone-change listener log:', JSON.stringify(log.map((e) => e[0])));
});

// ---------------------------------------------------------------------------
// O-38 — nav.rebuild receives THIS zone, proved behaviourally
// ---------------------------------------------------------------------------

test('O-38: on the very FIRST enterZone, nav.rebuild reflects the just-entered zone, not the placeholder grid', async () => {
  const { world, nav } = await makeWorldWithNav();
  await world.enterZone('ashen_wastes', 'portal_from_town'); // 96x96 m => 192x192 cells @ 0.5 m

  assert.equal(nav.grid.width, 192, 'grid width must match ashen_wastes bounds, not the 4-cell placeholder');
  assert.equal(nav.grid.height, 192, 'grid height must match ashen_wastes bounds, not the 4-cell placeholder');
  // Well inside the zone, far from any wall's dilation. Under the pre-fix
  // bug (`world.current` still null the moment `nav.rebuild()` ran, and
  // called with zero arguments) this point would not even exist on the
  // 2x2 m placeholder grid and would read as off-grid, hence unwalkable.
  assert.equal(nav.walkable(40, 40), true);
  assert.ok(nav.grid.regionCount >= 1);
});

test('O-38: on a zone CHANGE, nav.rebuild reflects the NEW zone, not the previous one', async () => {
  const { world, nav } = await makeWorldWithNav();
  await world.enterZone('last_bastion', 'town_start'); // 60x60 m => 120x120 cells
  assert.equal(nav.grid.width, 120);
  assert.equal(nav.grid.height, 120);

  await world.enterZone('bonereach', 'descent'); // 112x112 m => 224x224 cells

  assert.equal(nav.grid.width, 224, 'grid must resize to bonereach, not stay at last_bastion\'s 120');
  assert.equal(nav.grid.height, 224);
  // WRLD-7 note: this used to probe a hardcoded (50, 0) — a safe pick back
  // when `bonereach` was boundary-walls-and-open-floor (any interior point
  // was walkable). With a real BSP hall generator, (50, 0) is ordinary solid
  // rock outside every room/corridor (`gen/bonereach.js`'s own "rock"
  // footprint model blocks everything that is not a generated room or
  // corridor) — a hardcoded coordinate a future generator can invalidate
  // again, exactly as this one did. `world.entry('descent')` is walkable by
  // CONSTRUCTION instead: B10 places it 2.5 m inside the entry room's own
  // south wall, so it is real, seed-derived, always-inside-bonereach's-own-
  // walkable-area — the actual point a player would stand on, not a
  // coordinate that happens to work today. Still proves the same thing this
  // test is about: this position only makes sense under bonereach's OWN
  // geometry (well outside last_bastion's own +-30 m bounds), so it can only
  // read walkable if nav is rasterising the zone just entered, not the stale
  // previous one.
  const descent = world.entry('descent');
  assert.ok(Math.abs(descent.x) > 30 || Math.abs(descent.z) > 30, 'sanity: the descent point must fall outside last_bastion\'s own bounds');
  assert.equal(nav.walkable(descent.x, descent.z), true);
});

test('O-38: instance.navVersion is mirrored by nav.rebuild, and zone:ready carries that same real value', async () => {
  const { world, nav, ctx } = await makeWorldWithNav();
  const seen = [];
  ctx.events.on('zone:ready', (p) => seen.push(p));

  const instance = await world.enterZone('bonereach', 'descent');

  assert.equal(instance.navVersion, nav.version, 'nav.rebuild(instance) must mirror its own real version counter onto the instance it was handed');
  assert.equal(seen[0].navVersion, instance.navVersion, 'zone:ready must carry the SAME real navVersion, read after nav.rebuild ran');
});

// ---------------------------------------------------------------------------
// The test map (src/world/testmap.js)
// ---------------------------------------------------------------------------

function makeStubWorld({ staticFootprints = [], current = null } = {}) {
  return { staticFootprints, current };
}

function makeZone({ zoneId = 'testmap', bounds }) {
  return {
    zoneId,
    boundsMinX: bounds.minX,
    boundsMaxX: bounds.maxX,
    boundsMinZ: bounds.minZ,
    boundsMaxZ: bounds.maxZ,
    navVersion: 0,
  };
}

/** Rasterises `TESTMAP_FOOTPRINTS`/`TESTMAP_BOUNDS` through a real
 * `NavSystem`, via the same stub-`world` shape `tests/nav/nav1.test.js`'s
 * own `makeStubWorld`/`makeZone` use — never through `enterZone` (see
 * `testmap.js`'s own header for why this map is not a fifth
 * `ZoneDescriptor`). */
async function makeNavForTestMap() {
  const world = makeStubWorld({ staticFootprints: TESTMAP_FOOTPRINTS });
  const ctx = makeStubCtx({ systems: { world } });
  const nav = new NavSystem();
  await nav.init(ctx);
  nav.rebuild(makeZone({ bounds: TESTMAP_BOUNDS }));
  return { nav, ctx, world };
}

test('testmap.js: every footprint uses O-35\'s live Footprint field names, never 07 §1.7\'s superseded ones', () => {
  assert.ok(Object.isFrozen(TESTMAP_FOOTPRINTS));
  assert.ok(TESTMAP_FOOTPRINTS.length > 0);
  for (const fp of TESTMAP_FOOTPRINTS) {
    assert.ok(Object.isFrozen(fp));
    assert.ok(['box', 'cylinder', 'poly'].includes(fp.kind), `kind must be box|cylinder|poly, got '${fp.kind}'`);
    assert.notEqual(fp.kind, 'circle', 'circle is 07 §1.7\'s superseded name');
    assert.notEqual(fp.kind, 'convex', 'convex is 07 §1.7\'s superseded name');
    assert.equal(typeof fp.facing, 'number', 'rotation is named facing, not rotation');
    assert.equal('rotation' in fp, false);
    assert.equal(typeof fp.y, 'number', 'floor height is named y, not baseY');
    assert.equal(typeof fp.height, 'number', 'vertical extent is named height, not topY');
    assert.equal('baseY' in fp, false);
    assert.equal('topY' in fp, false);
    assert.equal(typeof fp.blocksNav, 'boolean', 'flag is named blocksNav, not navBlock');
    assert.equal('navBlock' in fp, false);
    assert.equal(typeof fp.blocksSight, 'boolean');
  }
});

test('testmap.js has zero imports and never references three/document/window/performance.now() (O-29)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '../../src/world/testmap.js'), 'utf8');
  assert.equal(/^\s*import\b/m.test(src), false, 'testmap.js must not import anything (matches src/world/data/zones.js\'s own zero-import style)');
  assert.equal(/from\s+['"]three['"]/.test(src), false);
  assert.equal(/\bdocument\s*\./.test(src), false);
  assert.equal(/\bwindow\s*\./.test(src), false);
  assert.equal(/\bperformance\s*\.\s*now\s*\(/.test(src), false);
});

test('MAIN: the test map rasterises to exactly ONE connected walkable region', async () => {
  const { nav } = await makeNavForTestMap();
  assert.equal(nav.grid.width, Math.round((TESTMAP_BOUNDS.maxX - TESTMAP_BOUNDS.minX) / CELL));
  assert.equal(nav.grid.height, Math.round((TESTMAP_BOUNDS.maxZ - TESTMAP_BOUNDS.minZ) / CELL));
  assert.equal(
    nav.grid.regionCount,
    1,
    'the whole map (both rooms and the pocket) must be a single walkable region — PLYR-2 cannot script a run between two points nav considers unreachable from each other',
  );
});

test('MAIN: the two far corners are connected, and a real requestPath solves across the whole map', async () => {
  const { nav, ctx } = await makeNavForTestMap();
  const { a, b } = TESTMAP_FAR_CORNERS;

  assert.ok(nav.walkable(a.x, a.z));
  assert.ok(nav.walkable(b.x, b.z));
  assert.ok(nav.connected(a.x, a.z, b.x, b.z), 'far corners must share a region — the map must be fully traversable');

  const id = nav.requestPath(a.x, a.z, b.x, b.z, 1);
  assert.notEqual(id, 0, 'requestPath must accept the request');
  ctx.time.step++;
  nav.fixedUpdate(1 / 60, ctx);
  const path = nav.pollPath(id);
  assert.ok(path, 'the path must actually solve, not merely report connected() === true');
  const len = nav.pathLength(path);
  assert.ok(len > 1);

  const node = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < len; i++) {
    nav.pathNode(path, i, node);
    assert.ok(nav.walkable(node.x, node.z), `path node ${i} at (${node.x},${node.z}) must be walkable`);
  }
});

test('the doorway is walkable and both flanking dividing-wall segments are blocked', async () => {
  const { nav } = await makeNavForTestMap();
  assert.ok(nav.walkable(TESTMAP_DOORWAY.x, TESTMAP_DOORWAY.z), 'the doorway itself must be walkable');
  assert.equal(nav.walkable(0, -6.5), false, 'south dividing-wall segment centre must be blocked');
  assert.equal(nav.walkable(0, 6.5), false, 'north dividing-wall segment centre must be blocked');
});

test('the pillar (interior obstacle) blocks its own footprint, but room B stays connected around it', async () => {
  const { nav } = await makeNavForTestMap();
  assert.equal(nav.walkable(10, 5), false, 'the pillar\'s own centre must be blocked');
  assert.ok(nav.connected(2, 5, 18, 5), 'room B must remain one region around the pillar (a detour, not a split)');
});

test('the concave pocket (wedge trap) is walkable inside, connected to the rest of room A, and its back wall is blocked', async () => {
  const { nav } = await makeNavForTestMap();
  assert.ok(nav.walkable(-16, -8), 'the inside of the pocket must be walkable');
  assert.equal(nav.walkable(-18.5, -8), false, 'the pocket\'s back wall must be blocked');
  assert.ok(
    nav.connected(-16, -8, TESTMAP_FAR_CORNERS.a.x, TESTMAP_FAR_CORNERS.a.z),
    'the pocket must not be pruned or disconnected from the rest of room A',
  );
});

test('the diagonal-corner crates each block their own footprint without merging into one blob', async () => {
  const { nav } = await makeNavForTestMap();
  assert.equal(nav.walkable(5, -5), false, 'crate A centre must be blocked');
  assert.equal(nav.walkable(7, -3), false, 'crate B centre must be blocked');
  // A point clear of both crates' dilation, on the open side of the seam,
  // must stay walkable and connected — the pair is a corner-stick probe for
  // PLYR-2, never a connectivity hazard.
  assert.ok(nav.walkable(3, -3));
  assert.ok(nav.connected(3, -3, TESTMAP_FAR_CORNERS.b.x, TESTMAP_FAR_CORNERS.b.z));
});
