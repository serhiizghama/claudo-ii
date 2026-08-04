// tests/world/wrld4.test.js
//
// WRLD-4 acceptance tests for `src/world/zone.js` (the `requestZone` latch
// + the between-frame service point) and `src/world/index.js`'s wiring of
// the two onto `WorldSystem` (`requestZone`/`serviceZoneRequest` methods,
// `static deps`). `node:test` + `node:assert/strict` only (`12-testing.md`
// P6). Any assertion on a time, an allocation or a frame lives in
// `wrld4.perf.test.js` instead (this ticket's own rule 9).
//
// Scope, matching the acceptance criteria this ticket was handed:
//  1. `requestZone` latches, `false` while a request is pending; the
//     ENGINE (`src/core/engine.js` phase 4b, already shipped, not this
//     ticket's file) services it after `lateUpdate` and before `render` —
//     proved against the REAL `Engine`, not a re-implementation of it.
//  2. Emission order T5 -> T8 -> T9 -> T12 (`zone:enter` -> `physics.rebuild`
//     -> `nav:rebuilt` -> `zone:ready`), driven through `requestZone` +
//     `serviceZoneRequest` (this ticket's own mechanism), recorded by a
//     subscriber — never read off the source.
//  3. `navVersion` identical across `nav:rebuilt` and `zone:ready`.
//  4. Entering the town twice (a real teardown/rebuild cycle in one
//     process, town -> wastes -> town) yields byte-identical `NavGrid.flags`
//     — FNV-1a hash compare.
//  5. `WorldSystem.deps` is `['materials','physics']` (O-61's world half).
//
// Per O-27/O-39/rule 11: no assertion here encodes "there are only four
// zones" or "no generator exists yet" — every check is on the latch/service
// mechanism's own real behaviour.
//
// Round 2 (the coordinator's widened grant) adds coverage for the five
// `07` §12 row 4 accessors implemented directly on `WorldSystem`
// (`bounds`, `surfaceAt`, `entry`, `isTown`, `groundHeight`) and the
// `07` §1.3 terrace field itself (`src/world/height.js`) — in particular
// the row's own acceptance check: "400 random points agree between
// `groundHeight()` and a brute-force reference to 1e-9."

import test from 'node:test';
import assert from 'node:assert/strict';

import { WorldSystem } from '../../src/world/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { NavSystem } from '../../src/nav/index.js';
import { Engine } from '../../src/core/engine.js';
import { Rng } from '../../src/core/rng.js';
import { buildHeightField, terraceElevationAt } from '../../src/world/height.js';
import { makeStubCtx } from '../helpers/actor.js';
import { SEEDS } from '../helpers/seed.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A real `WorldSystem` + `PhysicsSystem` + `NavSystem`, wired onto one stub
 * `ctx` — the same shape `tests/world/wrld3.test.js`'s own
 * `makeWorldWithNav` uses, so `requestZone`/`serviceZoneRequest`'s real
 * handoff into the already-proven `enterZone` chain is exercised end to
 * end, never stubbed. */
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

/** Deterministic, dependency-free FNV-1a over a typed array's raw bytes —
 * the same algorithm `tests/world/wrld2.test.js`'s own `fnv1aOfTypedArray`
 * uses, duplicated here (this ticket owns no shared helper file to put it
 * in) so criterion 4's hash compare needs no eyeballing of the flags array
 * itself. */
function fnv1aOfTypedArray(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Criterion 5 — static deps
// ---------------------------------------------------------------------------

test('CRITERION 5: WorldSystem.deps is [materials, physics] (O-61 world half)', () => {
  assert.deepEqual(WorldSystem.deps, ['materials', 'physics']);
});

// ---------------------------------------------------------------------------
// Criterion 1 — the latch: latches, false while pending
// ---------------------------------------------------------------------------

test('CRITERION 1: requestZone latches (returns true) and returns false while a request is already pending', () => {
  const world = new WorldSystem();
  assert.equal(world.requestZone('last_bastion', 'town_start'), true);
  assert.equal(
    world.requestZone('ashen_wastes', 'portal_from_town'),
    false,
    'a second requestZone before the first is serviced must be rejected, not queued',
  );
});

test('requestZone is reachable as a real method on the world instance (rule 7 / O-71)', () => {
  const world = new WorldSystem();
  assert.equal(typeof world.requestZone, 'function');
  assert.equal(typeof world.serviceZoneRequest, 'function');
});

test('serviceZoneRequest is a no-op when nothing is pending', async () => {
  const { world, ctx } = await makeWorldWithNav();
  let enterCount = 0;
  ctx.events.on('zone:enter', () => enterCount++);

  world.serviceZoneRequest();

  assert.equal(enterCount, 0);
  assert.equal(world.current, null);
});

test('after a pending request is serviced, the latch clears and a new requestZone is accepted again', async () => {
  const { world } = await makeWorldWithNav();

  assert.equal(world.requestZone('last_bastion', 'town_start'), true);
  world.serviceZoneRequest();
  assert.equal(world.current.zoneId, 'last_bastion');

  assert.equal(
    world.requestZone('ashen_wastes', 'portal_from_town'),
    true,
    'the latch must be free again once the previous request was serviced',
  );
});

// ---------------------------------------------------------------------------
// Criterion 1 (continued) — serviced between lateUpdate and render, via the
// REAL Engine, not inside fixedUpdate
// ---------------------------------------------------------------------------

test('CRITERION 1: a requestZone latched inside fixedUpdate is NOT serviced until after lateUpdate, driven through the real Engine', async () => {
  const { world, physics, nav, ctx } = await makeWorldWithNav();
  await world.enterZone('last_bastion', 'town_start'); // a real "previous zone", so the request below is a genuine change

  let zoneIdSeenDuringFixedUpdate = null;
  let zoneIdSeenDuringLateUpdate = null;

  // Stands in for `player`'s own T1 latch (`07-world-gen.md` §10.2 / `11-flows.md`
  // A-2: `requestZone` is called FROM `fixedUpdate`, unlike `enterZone`).
  const fakePlayer = {
    fixedUpdate() {
      const accepted = world.requestZone('ashen_wastes', 'portal_from_town');
      assert.equal(accepted, true);
      zoneIdSeenDuringFixedUpdate = world.current.zoneId;
    },
    lateUpdate() {
      zoneIdSeenDuringLateUpdate = world.current.zoneId;
    },
  };

  const engine = new Engine({ systems: [fakePlayer], ctx });
  engine.frame(1 / 60); // exactly one fixed step at 60 Hz

  assert.equal(
    zoneIdSeenDuringFixedUpdate,
    'last_bastion',
    'requestZone must only latch during fixedUpdate — the zone must not have changed yet',
  );
  assert.equal(
    zoneIdSeenDuringLateUpdate,
    'last_bastion',
    'the service point runs AFTER lateUpdate — the zone must still be unchanged during it',
  );
  assert.equal(
    world.current.zoneId,
    'ashen_wastes',
    'by the time frame() returns, the engine (phase 4b) must have serviced the pending request',
  );

  // Not this ticket's to assert further, but recorded: physics/nav were
  // reachable via the same ctx the whole time (`ctx.get('world')` is what
  // phase 4b itself uses, not the engine's own `systems` array).
  assert.ok(physics);
  assert.ok(nav);
});

// ---------------------------------------------------------------------------
// Criteria 2 & 3 — emission order T5 -> T8 -> T9 -> T12, navVersion match
// ---------------------------------------------------------------------------

/** Subscribes to the three named events plus wraps `physics.rebuild` (T8
 * has no event of its own — a direct method call — so recording its
 * position needs the same wrap `tests/world/wrld3.test.js`'s own
 * `attachOrderLog` uses, own-property shadowing so `physics`'s internal
 * `zone:ready` listener resolves to the same wrapper). Returns the ordered
 * log, mutated in place as `serviceZoneRequest` runs. */
function attachOrderLog(ctx, physics) {
  const log = [];
  ctx.events.on('zone:enter', (p) => log.push(['zone:enter', p]));
  ctx.events.on('nav:rebuilt', (p) => log.push(['nav:rebuilt', p]));
  ctx.events.on('zone:ready', (p) => log.push(['zone:ready', p]));

  const origPhysicsRebuild = physics.rebuild.bind(physics);
  physics.rebuild = (...args) => {
    log.push(['physics.rebuild']);
    return origPhysicsRebuild(...args);
  };

  return log;
}

/** Checks T5 -> T8 -> T9 -> T12 against an `attachOrderLog` log: `zone:enter`
 * fires, a `physics.rebuild` occurs strictly between it and `zone:ready`,
 * and `nav:rebuilt` occurs after that `physics.rebuild` and still before
 * `zone:ready`. Order relationships only (O-37 — `physics.rebuild`
 * legitimately fires a second time, from `physics`'s own `zone:ready`
 * listener; never assert a call count). */
function assertT5T8T9T12Order(log) {
  const tags = log.map((e) => e[0]);
  const enterIdx = tags.indexOf('zone:enter');
  const readyIdx = tags.indexOf('zone:ready');
  const navRebuiltIdx = tags.indexOf('nav:rebuilt');
  const physicsIdxs = tags.reduce((acc, t, i) => (t === 'physics.rebuild' ? (acc.push(i), acc) : acc), []);

  assert.ok(enterIdx >= 0, 'zone:enter (T5) must fire');
  assert.ok(navRebuiltIdx >= 0, 'nav:rebuilt (T9) must fire');
  assert.ok(readyIdx >= 0, 'zone:ready (T12) must fire');
  assert.ok(physicsIdxs.length >= 1, 'physics.rebuild (T8) must fire at least once');

  const physicsBetween = physicsIdxs.filter((i) => i > enterIdx && i < readyIdx);
  assert.ok(physicsBetween.length >= 1, 'T8: a physics.rebuild must occur strictly between zone:enter (T5) and zone:ready (T12)');
  assert.ok(navRebuiltIdx > physicsBetween[0], 'T9: nav:rebuilt must occur after physics.rebuild (T8)');
  assert.ok(navRebuiltIdx < readyIdx, 'T9: nav:rebuilt must occur before zone:ready (T12)');

  return tags;
}

test('CRITERION 2: requestZone + serviceZoneRequest drives zone:enter -> physics.rebuild -> nav:rebuilt -> zone:ready, in that order', async () => {
  const { world, physics, ctx } = await makeWorldWithNav();
  const log = attachOrderLog(ctx, physics);

  assert.equal(world.requestZone('last_bastion', 'town_start'), true);
  world.serviceZoneRequest();

  const tags = assertT5T8T9T12Order(log);
  // eslint-disable-next-line no-console
  console.log('[WRLD-4] recorded emission order (first entry):', JSON.stringify(tags));
});

test('CRITERION 2 (zone change): the same order holds on a second, real transition, teardown included', async () => {
  const { world, physics, ctx } = await makeWorldWithNav();
  assert.equal(world.requestZone('last_bastion', 'town_start'), true);
  world.serviceZoneRequest();

  const teardownLog = [];
  ctx.events.on('zone:teardown', (p) => teardownLog.push(['zone:teardown', p]));
  const orderLog = attachOrderLog(ctx, physics);

  assert.equal(world.requestZone('ashen_wastes', 'portal_from_town'), true);
  world.serviceZoneRequest();

  assert.equal(teardownLog.length, 1, 'zone:teardown must fire exactly once on a real zone change');
  const tags = assertT5T8T9T12Order(orderLog);
  // eslint-disable-next-line no-console
  console.log('[WRLD-4] recorded emission order (zone change):', JSON.stringify(tags));
});

test('CRITERION 3: navVersion is identical across nav:rebuilt and zone:ready', async () => {
  const { world, ctx } = await makeWorldWithNav();
  let navRebuiltVersion = null;
  let zoneReadyVersion = null;
  ctx.events.on('nav:rebuilt', (p) => {
    navRebuiltVersion = p.navVersion;
  });
  ctx.events.on('zone:ready', (p) => {
    zoneReadyVersion = p.navVersion;
  });

  assert.equal(world.requestZone('bonereach', 'descent'), true);
  world.serviceZoneRequest();

  assert.equal(typeof navRebuiltVersion, 'number');
  assert.equal(navRebuiltVersion, zoneReadyVersion, 'nav:rebuilt and zone:ready must carry the same navVersion');
});

// ---------------------------------------------------------------------------
// Criterion 4 — entering the town twice yields byte-identical NavGrid.flags
// ---------------------------------------------------------------------------

test('CRITERION 4: entering last_bastion twice (town -> wastes -> town) yields byte-identical NavGrid.flags', async () => {
  const { world, nav } = await makeWorldWithNav();

  assert.equal(world.requestZone('last_bastion', 'town_start'), true);
  world.serviceZoneRequest();
  const hash1 = fnv1aOfTypedArray(nav.grid.flags);

  // A real intervening zone, so the second town entry is a genuine
  // teardown -> rebuild cycle, not a same-zone no-op.
  assert.equal(world.requestZone('ashen_wastes', 'portal_from_town'), true);
  world.serviceZoneRequest();

  assert.equal(world.requestZone('last_bastion', 'from_wastes'), true);
  world.serviceZoneRequest();
  const hash2 = fnv1aOfTypedArray(nav.grid.flags);

  // eslint-disable-next-line no-console
  console.log('[WRLD-4] NavGrid.flags FNV-1a hashes — first town entry:', hash1, ' second town entry:', hash2);

  assert.equal(hash1, hash2, 'entering the same town zone twice must rasterise byte-identical flags');
  assert.equal(nav.grid.flags.length > 0, true);
});

// ---------------------------------------------------------------------------
// Round 2 — the five 07 §12 row 4 accessors (O-71: reachable as real methods
// on the world instance)
// ---------------------------------------------------------------------------

test('the five accessors are reachable as real methods/properties on the world instance (O-71)', () => {
  const world = new WorldSystem();
  assert.equal(typeof world.bounds, 'function');
  assert.equal(typeof world.surfaceAt, 'function');
  assert.equal(typeof world.entry, 'function');
  assert.equal(typeof world.groundHeight, 'function');
  assert.equal(typeof Object.getOwnPropertyDescriptor(WorldSystem.prototype, 'isTown').get, 'function');
});

test('isTown is false before any zone is loaded, true for last_bastion, false for a non-town zone', async () => {
  const { world } = await makeWorldWithNav();
  assert.equal(world.isTown, false);

  assert.equal(world.requestZone('last_bastion', 'town_start'), true);
  world.serviceZoneRequest();
  assert.equal(world.isTown, true);

  assert.equal(world.requestZone('ashen_wastes', 'portal_from_town'), true);
  world.serviceZoneRequest();
  assert.equal(world.isTown, false);
});

test('bounds(out?) reports the zone-centred extent (07 §1.1), Alloc: no in both branches, throws before any zone loads', async () => {
  const { world } = await makeWorldWithNav();
  assert.throws(() => world.bounds(), /no zone is currently loaded/);

  assert.equal(world.requestZone('ashen_wastes', 'portal_from_town'), true);
  world.serviceZoneRequest();

  const b1 = world.bounds();
  assert.deepEqual(b1, { minX: -48, minZ: -48, maxX: 48, maxZ: 48 });
  const b2 = world.bounds();
  assert.equal(b1, b2, 'the no-out call must return the same reused scratch object, never a fresh one');

  const out = { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
  const returned = world.bounds(out);
  assert.equal(returned, out, 'the with-out call must write into and return the caller-owned object');
  assert.deepEqual(out, { minX: -48, minZ: -48, maxX: 48, maxZ: 48 });
});

test('surfaceAt returns the zone\'s own primary ground surface (07 §1.6), throws before any zone loads', async () => {
  const { world } = await makeWorldWithNav();
  assert.throws(() => world.surfaceAt(0, 0), /no zone is currently loaded/);

  assert.equal(world.requestZone('ashen_wastes', 'portal_from_town'), true);
  world.serviceZoneRequest();
  assert.equal(world.surfaceAt(0, 0), 'ash'); // ashen_wastes.surfaces[0], data/zones.js
  assert.equal(world.surfaceAt(40, -40), 'ash', 'the placeholder is position-independent today — see this ticket\'s report');
});

test('entry: throws on an unknown entryTag, throws before any zone loads, returns groundHeight for y', async () => {
  const { world } = await makeWorldWithNav();
  assert.throws(() => world.entry('town_start'), /no zone is currently loaded/);

  assert.equal(world.requestZone('last_bastion', 'town_start'), true);
  world.serviceZoneRequest();

  assert.throws(() => world.entry('not_a_real_tag'), /unknown entryTag/);

  const e = world.entry('town_start');
  assert.equal(typeof e.x, 'number');
  assert.equal(typeof e.z, 'number');
  assert.equal(typeof e.facing, 'number');
  assert.equal(e.y, world.groundHeight(e.x, e.z), 'y must be derived from groundHeight, never stored (01 §9.2 stores only x,z,facing)');
});

test('entry(entryTag, out): A4 — an out without a facing key is left untouched on facing (the old Vec3 form); out WITH a facing key gets it set; the no-out call always carries facing', async () => {
  const { world } = await makeWorldWithNav();
  assert.equal(world.requestZone('last_bastion', 'town_start'), true);
  world.serviceZoneRequest();

  const vec3Out = { x: -1, y: -1, z: -1 };
  const returned = world.entry('town_start', vec3Out);
  assert.equal(returned, vec3Out);
  assert.equal('facing' in vec3Out, false, 'A4: out lacking a facing field must not gain one');
  assert.equal(typeof vec3Out.x, 'number');

  const fullOut = { x: 0, y: 0, z: 0, facing: -99 };
  world.entry('town_start', fullOut);
  assert.notEqual(fullOut.facing, -99, 'an out that already declares facing must have it overwritten');

  const noOut = world.entry('town_start');
  assert.equal(typeof noOut.facing, 'number');
});

test('groundHeight throws before any zone loads, and returns a finite number once one is', async () => {
  const { world } = await makeWorldWithNav();
  assert.throws(() => world.groundHeight(0, 0), /no zone is currently loaded/);

  assert.equal(world.requestZone('bonereach', 'descent'), true);
  world.serviceZoneRequest();

  const h = world.groundHeight(0, 0);
  assert.equal(Number.isFinite(h), true);
  // 07 §1.3: terrace (0.00, this ticket's honest DEFAULT_TERRACES) plus a
  // cosmetic displacement of amplitude +-0.12 m — never wildly off-terrace.
  assert.ok(Math.abs(h) <= 0.12 + 1e-9, `groundHeight ${h} must stay within the documented +-0.12 m cosmetic band around the single 0.00 m terrace`);
});

// ---------------------------------------------------------------------------
// 07 §12 row 4's own acceptance check for this half: "400 random points
// agree between groundHeight() and a brute-force reference to 1e-9."
// ---------------------------------------------------------------------------

test('07 §12 row 4: groundHeight agrees with an independently-written brute-force bilinear reference to 1e-9, over 400 random points', async () => {
  const { world } = await makeWorldWithNav();
  const zoneId = 'ashen_wastes';
  assert.equal(world.requestZone(zoneId, 'portal_from_town'), true);
  world.serviceZoneRequest();

  const descriptor = world.descriptor(zoneId);
  // The exact seed `enterZone` used internally (runIndex defaults to 0) —
  // `buildHeightField` is a pure, deterministic function of its inputs, so
  // rebuilding the table this way reproduces `world`'s own table exactly,
  // without reaching into its private state. What is under test below is
  // NOT the noise table's generation (no external reference exists to check
  // that against — see height.js's own header) but the QUERY math: does
  // `groundHeight` read that table back out correctly.
  //
  // WRLD-6/O-99 update: `ashen_wastes` is no longer the flat, single
  // boundless 0.00 m terrace `index.js`'s own `DEFAULT_TERRACES` gives every
  // OTHER zone — WRLD-6 wired `world.enterZone` to build this zone's height
  // field from the REAL Ridgewalk-generated terrace list (R5's own -2.20 m
  // ravines / +1.20 m shelves), because that is exactly what O-99 needs
  // `nav.groundY` to carry for `passN3Slope` to do anything. This oracle's
  // job was never to re-verify the generator's OWN terrace placement (that
  // is WRLD-5/WRLD-6's own suite) — only that `groundHeight`'s bilinear
  // noise read agrees with an independent implementation — so it reads the
  // real terrace list from the SAME place `world` itself built it
  // (`world._wastesLayout.terraces`, populated by this exact `enterZone`
  // call, above) rather than re-deriving it, and reuses `height.js`'s own
  // already-tested `terraceElevationAt` for the (trivial, not what this
  // test is about) terrace lookup. Do not hardcode a flat terrace back in
  // for `ashen_wastes` here and do not skip this case — that would make the
  // oracle silently wrong again the moment a real terrace exists, exactly
  // as it was before this fix.
  const terraces = world._wastesLayout ? world._wastesLayout.terraces : [{ elevation: 0 }];
  const seed = world.seedFor(zoneId, 0);
  const field = buildHeightField({
    sizeX: descriptor.sizeX,
    sizeZ: descriptor.sizeZ,
    terraces,
    noiseSeed: seed,
  });

  /** A deliberately DIFFERENT bilinear implementation from `height.js`'s own
   * `sampleHeightField` — an explicit four-corner weighted sum (the
   * textbook formula) rather than the two-sequential-lerp shortcut
   * `sampleHeightField` uses. Algebraically identical, computed a
   * genuinely different way — exactly what "the slow, obvious way" asks
   * for, not `groundHeight()` compared against itself. */
  function bruteForceGroundHeight(x, z) {
    const cell = field.cellSize;
    const u = (x - field.originX) / cell;
    const v = (z - field.originZ) / cell;
    const ix0 = Math.max(0, Math.min(field.latticeWidth - 2, Math.floor(u)));
    const iz0 = Math.max(0, Math.min(field.latticeHeight - 2, Math.floor(v)));
    const fx = Math.max(0, Math.min(1, u - ix0));
    const fz = Math.max(0, Math.min(1, v - iz0));
    const w = field.latticeWidth;
    const t = field.table;
    const n00 = t[iz0 * w + ix0];
    const n10 = t[iz0 * w + ix0 + 1];
    const n01 = t[(iz0 + 1) * w + ix0];
    const n11 = t[(iz0 + 1) * w + ix0 + 1];
    const noise =
      n00 * (1 - fx) * (1 - fz) +
      n10 * fx * (1 - fz) +
      n01 * (1 - fx) * fz +
      n11 * fx * fz;
    // WRLD-6/O-99 — real terrace lookup (see this test's own comment,
    // above), not a hardcoded flat 0. `terraceElevationAt` is height.js's
    // own already-tested pure function; the noise READ (this function's
    // actual point) stays independently reimplemented above.
    const terraceElevation = terraceElevationAt(terraces, x, z);
    return terraceElevation + (noise - 0.5) * 0.24;
  }

  const rng = new Rng(SEEDS.b); // independent of makeWorldWithNav's own SEEDS.a
  const halfX = descriptor.sizeX / 2;
  const halfZ = descriptor.sizeZ / 2;
  let maxDiff = 0;
  for (let i = 0; i < 400; i++) {
    const x = -halfX + rng.next() * descriptor.sizeX;
    const z = -halfZ + rng.next() * descriptor.sizeZ;
    const expected = bruteForceGroundHeight(x, z);
    const actual = world.groundHeight(x, z);
    const diff = Math.abs(actual - expected);
    if (diff > maxDiff) maxDiff = diff;
  }

  // eslint-disable-next-line no-console
  console.log('[WRLD-4] groundHeight vs. brute-force bilinear reference, 400 points, max |diff|:', maxDiff);
  assert.ok(maxDiff < 1e-9, `max |diff| ${maxDiff} over 400 points must be < 1e-9`);
});
