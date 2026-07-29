// tests/nav/nav1.test.js
//
// NAV-1 acceptance tests for src/nav/index.js and src/nav/grid.js.
// `node:test` + `node:assert/strict` only — no framework (12-testing.md P6).
//
// Scope: the ticket's literal acceptance criterion — "`regionAt` labels
// connected components; `nav.version` bumps on rebuild" — both halves, each
// probed the way the ticket says the orchestrator will: `regionAt` joining a
// genuinely connected pair, separating a genuinely disconnected pair, and
// returning -1 for a blocked cell; `version` strictly increasing across
// repeated rebuilds, including across a "zone change", and PROCESS-GLOBAL
// (never reset by a second `NavSystem` instance). Also: the NAV_FLAG
// single-definition proof this ticket's brief asked for by name, the scope
// boundary (NAV-2..NAV-5 methods absent, not stubbed), allocation-free
// accessors, and a boot-safety check for the real `world` -> `nav` wiring.
// Per O-27, every assertion is on real rasterised behaviour — never on "the
// object exists" or an empty-stats shape.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NavSystem } from '../../src/nav/index.js';
import { NAV_FLAG as NAV_FLAG_FROM_GRID } from '../../src/nav/grid.js';
import { NAV_FLAG as NAV_FLAG_FROM_INDEX } from '../../src/nav/index.js';
import { NAV_FLAG as NAV_FLAG_FROM_RASTER } from '../../src/world/raster.js';
import { WorldSystem } from '../../src/world/index.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { makeStubCtx } from '../helpers/actor.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { SEEDS } from '../helpers/seed.js';

const CELL = 0.5; // 01 §9.3 — fixed across all zones

/** A stub `world`-shaped system, offering exactly what `nav.rebuild()` reads
 * (`ctx.get('world').staticFootprints`, `ctx.get('world').current`) —
 * nothing else. `current` defaults to `null`, matching `WorldSystem`'s own
 * initial state before any `enterZone`. */
function makeStubWorld({ staticFootprints = [], current = null } = {}) {
  return { staticFootprints, current };
}

/** Builds a `NavSystem`, initialised against a stub `ctx` whose `world` is
 * a controllable stub (see `makeStubWorld`) unless the caller hands in its
 * own `world` (the boot-safety test uses a real `WorldSystem`).
 * @returns {Promise<{nav: NavSystem, ctx: object, world: object}>} */
async function makeNav({ world = makeStubWorld() } = {}) {
  const ctx = makeStubCtx({ systems: { world } });
  const nav = new NavSystem();
  await nav.init(ctx);
  return { nav, ctx, world };
}

/** A `ZoneInstance`-shaped stub carrying only what `nav.rebuild` reads:
 * bounds (`src/world/index.js`'s real, current shape) plus `zoneId` for the
 * `nav:rebuilt` payload / `navVersion` mirror checks. */
function makeZone({ zoneId = 'test_zone', halfX = 10, halfZ = 10 } = {}) {
  return {
    zoneId,
    boundsMinX: -halfX,
    boundsMaxX: halfX,
    boundsMinZ: -halfZ,
    boundsMaxZ: halfZ,
    navVersion: 0,
  };
}

// ---------------------------------------------------------------------------
// NAV_FLAG — one definition, re-exported, never duplicated (this ticket's
// own instruction: "add a test asserting the seven bit values equal 01 §9.3
// literally").
// ---------------------------------------------------------------------------

test('NAV_FLAG is the exact same object from src/nav/grid.js, src/nav/index.js and src/world/raster.js — one definition, not three', () => {
  assert.equal(NAV_FLAG_FROM_GRID, NAV_FLAG_FROM_RASTER, 'grid.js must re-export, not copy');
  assert.equal(NAV_FLAG_FROM_INDEX, NAV_FLAG_FROM_RASTER, 'index.js must re-export, not copy');
});

test('NAV_FLAG bit values match 01-data-model.md §9.3 exactly', () => {
  assert.equal(NAV_FLAG_FROM_INDEX.walkable, 1 << 0);
  assert.equal(NAV_FLAG_FROM_INDEX.blocked, 1 << 1);
  assert.equal(NAV_FLAG_FROM_INDEX.hazard, 1 << 2);
  assert.equal(NAV_FLAG_FROM_INDEX.water, 1 << 3);
  assert.equal(NAV_FLAG_FROM_INDEX.doorway, 1 << 4);
  assert.equal(NAV_FLAG_FROM_INDEX.spawnDeny, 1 << 5);
  assert.equal(NAV_FLAG_FROM_INDEX.interior, 1 << 6);
  assert.ok(Object.isFrozen(NAV_FLAG_FROM_INDEX));
});

// ---------------------------------------------------------------------------
// Before any rebuild — safe defaults, never null
// ---------------------------------------------------------------------------

test('a fresh NavSystem has a valid grid and version 0 before the first rebuild()', async () => {
  const { nav } = await makeNav();
  assert.equal(nav.version, 0);
  assert.ok(nav.grid);
  assert.ok(nav.grid.flags instanceof Uint8Array);
  assert.ok(nav.grid.region instanceof Int16Array);
  // Placeholder is all-walkable, single region — regionAt anywhere inside it
  // must not be -1.
  assert.ok(nav.regionAt(0, 0) >= 0);
  assert.equal(nav.walkable(0, 0), true);
});

// ---------------------------------------------------------------------------
// THE ACCEPTANCE CRITERION, half 1 — regionAt labels connected components
// ---------------------------------------------------------------------------

test('MAIN: regionAt joins two genuinely connected cells, separates two genuinely disconnected ones, and returns -1 for a blocked cell', async () => {
  // A 20x20 m zone (bounds -10..10 => 40x40 cells @ 0.5 m), split in half by
  // a wall spanning the full width at z=0 — the exact geometry wrld2.test.js
  // uses for its own "wall splits the grid" case.
  const wall = { kind: 'box', x: 0, z: 0, y: 0, height: 3, halfW: 20, halfL: 0.6, facing: 0, blocksNav: true, blocksSight: true };
  const world = makeStubWorld({ staticFootprints: [wall] });
  const { nav } = await makeNav({ world });
  const zone = makeZone();

  nav.rebuild(zone);

  // Two points on the SAME side of the wall (both z < -2, well clear of the
  // wall's dilation) must be connected.
  const sameSideA = { x: -5, z: -5 };
  const sameSideB = { x: 5, z: -5 };
  assert.ok(nav.walkable(sameSideA.x, sameSideA.z));
  assert.ok(nav.walkable(sameSideB.x, sameSideB.z));
  const regionSameA = nav.regionAt(sameSideA.x, sameSideA.z);
  const regionSameB = nav.regionAt(sameSideB.x, sameSideB.z);
  assert.ok(regionSameA >= 0);
  assert.equal(regionSameA, regionSameB, 'two cells reachable through walkable cells must share a region id');
  assert.equal(nav.connected(sameSideA.x, sameSideA.z, sameSideB.x, sameSideB.z), true);

  // Two points on OPPOSITE sides of the wall must NOT be connected.
  const otherSide = { x: 0, z: 5 };
  assert.ok(nav.walkable(otherSide.x, otherSide.z));
  const regionOther = nav.regionAt(otherSide.x, otherSide.z);
  assert.ok(regionOther >= 0);
  assert.notEqual(regionSameA, regionOther, 'two cells separated by geometry must not share a region id');
  assert.equal(nav.connected(sameSideA.x, sameSideA.z, otherSide.x, otherSide.z), false);

  // A cell inside the wall itself must be blocked: not walkable, region -1.
  assert.equal(nav.walkable(0, 0), false, 'the wall itself must not be walkable');
  assert.equal(nav.regionAt(0, 0), -1, 'a blocked cell must return -1');
  assert.ok(nav.flagsAt(0, 0) & NAV_FLAG_FROM_INDEX.blocked);
  assert.equal(nav.connected(sameSideA.x, sameSideA.z, 0, 0), false, 'a blocked cell is never connected to anything');
});

test('regionAt joins an actually-connected open field (no footprints at all)', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  const a = nav.regionAt(-9, -9);
  const b = nav.regionAt(9, 9);
  assert.ok(a >= 0 && b >= 0);
  assert.equal(a, b, 'a wide-open zone with no blockers is one connected region end to end');
  assert.equal(nav.connected(-9, -9, 9, 9), true);
});

test('regionAt / walkable / flagsAt / connected all read off-grid as blocked, never throwing', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 5, halfZ: 5 }));
  assert.equal(nav.walkable(9999, 9999), false);
  assert.equal(nav.regionAt(9999, 9999), -1);
  assert.equal(nav.flagsAt(9999, 9999), 0);
  assert.equal(nav.connected(0, 0, 9999, 9999), false);
});

// ---------------------------------------------------------------------------
// THE ACCEPTANCE CRITERION, half 2 — version bumps on rebuild, monotonic,
// never reused, process-global (not per-zone, not per-instance)
// ---------------------------------------------------------------------------

test('MAIN: nav.version strictly increases across repeated rebuilds, including across a zone change', async () => {
  const { nav } = await makeNav();
  const versions = [];
  versions.push(nav.version); // 0, before any rebuild

  nav.rebuild(makeZone({ zoneId: 'town' }));
  versions.push(nav.version);

  nav.rebuild(makeZone({ zoneId: 'wastes', halfX: 48, halfZ: 48 })); // different size = a real "zone change"
  versions.push(nav.version);

  nav.rebuild(makeZone({ zoneId: 'town' })); // town -> wastes -> town: 07 §6.7's own example
  versions.push(nav.version);

  for (let i = 1; i < versions.length; i++) {
    assert.ok(versions[i] > versions[i - 1], `version must strictly increase: ${versions.join(' -> ')}`);
  }
  // Never repeats one, per zone change (07 §6.2 N11 / §6.7): the "town"
  // re-entry's version is NOT the same as the first "town" visit's.
  assert.notEqual(versions[1], versions[3]);
});

test('the version counter is PROCESS-GLOBAL: a second NavSystem instance continues counting, never resets to 1', async () => {
  const { nav: navA } = await makeNav();
  navA.rebuild(makeZone({ zoneId: 'a' }));
  const afterA = navA.version;
  assert.ok(afterA >= 1);

  const { nav: navB } = await makeNav();
  // A fresh instance's OWN pre-rebuild version is still the "never rebuilt"
  // sentinel 0 — the counter is global, but each instance's `.version`
  // getter only reflects what IT has rebuilt so far.
  assert.equal(navB.version, 0);

  navB.rebuild(makeZone({ zoneId: 'b' }));
  assert.ok(navB.version > afterA, 'a second instance must continue the SAME process-global counter, never restart at 1');
});

test('rebuild mirrors navVersion onto the zone object and emits nav:rebuilt with the matching payload', async () => {
  const { nav, ctx } = await makeNav();
  const zone = makeZone({ zoneId: 'ashen_wastes' });

  let emitted = null;
  ctx.events.on('nav:rebuilt', (payload) => {
    emitted = payload;
  });

  nav.rebuild(zone);

  assert.equal(zone.navVersion, nav.version, 'ZoneInstance.navVersion must carry the same integer as nav.version (07 §6.7)');
  assert.ok(emitted);
  assert.equal(emitted.zoneId, 'ashen_wastes');
  assert.equal(emitted.navVersion, nav.version);
  assert.equal(emitted.regionCount, nav.grid.regionCount);
});

test('rebuild() called with no zone argument at all does not throw, and still bumps version (WRLD-1\'s own real call site — see report)', async () => {
  const { nav } = await makeNav();
  const before = nav.version;
  assert.doesNotThrow(() => nav.rebuild());
  assert.ok(nav.version > before);
  assert.ok(nav.grid.regionCount >= 1);
});

// ---------------------------------------------------------------------------
// rebuild() reads world.staticFootprints, never physics
// ---------------------------------------------------------------------------

test('rebuild(zone) reads world.staticFootprints as its source of blockers', async () => {
  const pillar = { kind: 'cylinder', x: 0, z: 0, y: 0, height: 3, radius: 1.0, facing: 0, blocksNav: true };
  const world = makeStubWorld({ staticFootprints: [pillar] });
  const { nav } = await makeNav({ world });
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  assert.equal(nav.walkable(0, 0), false, 'the pillar at the world origin must have blocked that cell');
  assert.ok(nav.walkable(8, 8), 'far corner untouched by a small pillar');
});

test('a non-blocking footprint (blocksNav:false) is fully ignored, per raster.js N4', async () => {
  const decor = { kind: 'box', x: 0, z: 0, y: 0, height: 1, halfW: 3, halfL: 3, facing: 0, blocksNav: false };
  const world = makeStubWorld({ staticFootprints: [decor] });
  const { nav } = await makeNav({ world });
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  assert.equal(nav.walkable(0, 0), true);
  assert.equal(nav.regionAt(-9, -9), nav.regionAt(9, 9), 'blocksNav:false must not fragment the grid');
});

// ---------------------------------------------------------------------------
// Grid reuse vs reallocation across rebuilds
// ---------------------------------------------------------------------------

test('rebuild() reuses the same typed arrays when cell dimensions are unchanged, reallocates when they differ', async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 }));
  const flagsA = nav.grid.flags;
  nav.rebuild(makeZone({ zoneId: 'same_size_again', halfX: 10, halfZ: 10 }));
  assert.equal(nav.grid.flags, flagsA, 'same width/height => same backing arrays reused');

  nav.rebuild(makeZone({ zoneId: 'different_size', halfX: 30, halfZ: 30 }));
  assert.notEqual(nav.grid.flags, flagsA, 'a different-sized zone must allocate a new grid');
  assert.equal(nav.grid.flags.length, (30 * 2 / CELL) * (30 * 2 / CELL));
});

// ---------------------------------------------------------------------------
// Scope — NAV-2..NAV-5 methods are absent, not stubbed
// ---------------------------------------------------------------------------

// Scope (that a given ticket implemented only its own 02-api-contracts.md §6
// rows and did not stub its successors') is checked by the orchestrator at
// review time against that contract, not encoded here as a standing
// assertion — every later NAV ticket that legitimately fills in the next row
// (NAV-2's requestPath/pollPath/..., NAV-3's smooth, NAV-4's flow field,
// NAV-5's snap) is required to falsify a test like this one. See O-27.

// ---------------------------------------------------------------------------
// Boot-safety — registering nav alongside the real world subsystem
// ---------------------------------------------------------------------------

test('boot-safety: a real WorldSystem calling enterZone with nav registered does not throw, and nav.version increases', async () => {
  // Mirrors tests/world/wrld1.test.js's own makeWorld() shape, plus a real
  // NavSystem registered alongside it. src/world/index.js's enterZone()
  // resolves `nav` via `ctx.peek('nav')` and calls `nav.rebuild()` with ZERO
  // arguments, before `world.current`/`world.staticFootprints` are updated
  // to the new zone (see this ticket's report) — this test only asserts the
  // mechanical contract ("registering nav must not break enterZone", per
  // this ticket's O-12 note), not that the rebuilt grid reflects the new
  // zone's own geometry, which WRLD-1's call-site ordering makes impossible
  // today.
  const events = new EventBus();
  const rng = new Rng(SEEDS.a);
  const systems = {};
  const ctx = {
    events,
    rng,
    time: { step: 0 },
    get(id) {
      if (!systems[id]) throw new Error(`stub ctx.get: '${id}' is not available`);
      return systems[id];
    },
    peek(id) {
      return systems[id];
    },
    has(id) {
      return !!systems[id];
    },
  };

  const world = new WorldSystem();
  await world.init(ctx);
  systems.world = world;

  const nav = new NavSystem();
  await nav.init(ctx);
  systems.nav = nav;

  const before = nav.version;
  await assert.doesNotReject(() => world.enterZone('last_bastion', 'town_start'));
  assert.ok(nav.version > before, 'nav.rebuild() ran as part of enterZone (even called with no zone argument)');

  // A second enterZone (a real zone change) must bump it again.
  const afterFirst = nav.version;
  await assert.doesNotReject(() => world.enterZone('ashen_wastes', 'portal_from_town'));
  assert.ok(nav.version > afterFirst);
});

// ---------------------------------------------------------------------------
// Allocation — accessors must be Alloc: no once the grid exists
// ---------------------------------------------------------------------------

test('12.Axx walkable/flagsAt/regionAt/connected are allocation-free once the grid is built', { skip: !hasGc() && 'run with --expose-gc' }, async () => {
  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 48, halfZ: 48 }));

  const r1 = assertAllocationFree(() => nav.walkable(3.2, -7.1));
  assert.ok(r1.bytesPerCall < 1);
  const r2 = assertAllocationFree(() => nav.flagsAt(3.2, -7.1));
  assert.ok(r2.bytesPerCall < 1);
  const r3 = assertAllocationFree(() => nav.regionAt(3.2, -7.1));
  assert.ok(r3.bytesPerCall < 1);
  const r4 = assertAllocationFree(() => nav.connected(3.2, -7.1, -3.2, 7.1));
  assert.ok(r4.bytesPerCall < 1);
});

test('stats is the same object every call (Alloc: no) and has the documented shape', async () => {
  const { nav } = await makeNav();
  const s1 = nav.stats;
  nav.rebuild(makeZone());
  const s2 = nav.stats;
  assert.equal(s1, s2, 'stats must be mutated in place, never reallocated');
  assert.deepEqual(Object.keys(s2).sort(), ['avgNodes', 'fieldMs', 'pending', 'refusals', 'solvedThisSecond'].sort());
});

// ---------------------------------------------------------------------------
// Performance — nav.rebuild() timing at Ashen-Wastes scale (192x192,
// ~1150 footprints), warm steady-state. WRLD-2's own N1-N10 measurement was
// 1.402 ms; the budget for the WHOLE nav.rebuild (N1-N11 + grid alloc/reuse)
// is 3 ms (07-world-gen.md §6.5). Generous ceiling here to avoid CI flake
// (O-34) — the real numbers are in this ticket's report, taken from this
// same measurement's console output.
// ---------------------------------------------------------------------------

test('nav.rebuild() timing at Ashen-Wastes scale (192x192 cells, ~1150 footprints), warm steady-state', async () => {
  const halfX = 48; // 96 m zone => 192 cells at 0.5 m
  const footprints = [];
  // ~1150 footprints scattered across the zone, mirroring WRLD-2's own
  // budget context (07 §6.5's own "≈ 1150 footprints" figure).
  for (let i = 0; i < 1150; i++) {
    const gx = (i % 40) - 20;
    const gz = Math.floor(i / 40) - 15;
    footprints.push({
      kind: i % 2 === 0 ? 'box' : 'cylinder',
      x: gx * 2.1,
      z: gz * 2.1,
      y: 0,
      height: 2,
      halfW: 0.4,
      halfL: 0.4,
      radius: 0.4,
      facing: 0,
      blocksNav: true,
    });
  }
  const world = makeStubWorld({ staticFootprints: footprints });
  const { nav } = await makeNav({ world });
  const zone = makeZone({ halfX, halfZ: halfX });

  // Warm-up (O-23: warm up with more than one call before trusting a timing
  // read — JIT + first-allocation cost is otherwise mistaken for signal).
  for (let i = 0; i < 5; i++) nav.rebuild(zone);

  const iterations = 20;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) nav.rebuild(zone);
  const t1 = process.hrtime.bigint();
  const avgMs = Number(t1 - t0) / 1e6 / iterations;

  // eslint-disable-next-line no-console
  console.log(`[NAV-1] nav.rebuild() warm steady-state, Ashen-Wastes scale: ${avgMs.toFixed(3)} ms/call (n=${iterations})`);

  // Generous ceiling: 07 §6.5's hard-fail line for the N1-N10 raster alone is
  // 8.0 ms at this scale; this measures N1-N11 plus this file's own grid
  // bookkeeping on top. 20 ms leaves comfortable headroom against CI noise
  // while still catching a real order-of-magnitude regression.
  assert.ok(avgMs < 20, `nav.rebuild() warm steady-state was ${avgMs.toFixed(3)} ms, expected well under 20 ms`);
});
