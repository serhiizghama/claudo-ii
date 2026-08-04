// tests/world/wrld1.test.js
//
// WRLD-1 acceptance tests for src/world/index.js and src/world/data/zones.js.
// `node:test` + `node:assert/strict` only — no framework (12-testing.md P6).
//
// Scope: the two halves of this ticket's acceptance criterion — "the four
// ZoneDescriptors load" and "staticFootprints is frozen at zone:ready" —
// plus the emission-order contract (02-api-contracts.md §5) that produces
// it, Node-safety of src/world/data/ (tools/check-imports.mjs's own N-root),
// and determinism of seedFor(). Real per-zone geometry generators (Ridgewalk,
// BSP, the arena, the hand-authored town) do not exist yet and are not this
// ticket's files — not tested here, per the ticket's own documented scope.
//
// THE MAIN TEST is "staticFootprints survives push/index-assign/field-
// mutation attempts" below — the acceptance criterion's half with teeth.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { WorldSystem } from '../../src/world/index.js';
import { ZONE_DESCRIPTORS } from '../../src/world/data/zones.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { SEEDS } from '../helpers/seed.js';

const EXPECTED_ZONE_SHAPE = {
  last_bastion: { kind: 'town', sizeX: 60, sizeZ: 60, monsterLevel: 0 },
  ashen_wastes: { kind: 'open', sizeX: 96, sizeZ: 96, monsterLevel: 6 },
  bonereach: { kind: 'dungeon', sizeX: 112, sizeZ: 112, monsterLevel: 11 },
  altar_of_instruction: { kind: 'arena', sizeX: 48, sizeZ: 48, monsterLevel: 15 },
};

/** A minimal ctx, matching the physics/actors tickets' own `makeCtx()` /
 * `makeCtxWithPhysics` shape. `withPhysics: false` exercises the "no physics
 * registered" guarded path (a bare unit-test ctx, same reasoning as actors'
 * own stub tests). */
async function makeWorld({ withPhysics = true, seed = SEEDS.a } = {}) {
  const events = new EventBus();
  const rng = new Rng(seed);
  const systems = {};
  const ctx = {
    events,
    rng,
    time: { step: 3 },
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
  if (withPhysics) {
    const physics = new PhysicsSystem();
    await physics.init(ctx);
    systems.physics = physics;
  }
  const world = new WorldSystem();
  await world.init(ctx);
  systems.world = world;
  return { world, ctx, physics: systems.physics };
}

// ---------------------------------------------------------------------------
// Node-safety — src/world/data/ is one of check-imports.mjs's five required
// N-roots; src/world/index.js is not required to be, but stays clean anyway.
// ---------------------------------------------------------------------------

test('src/world/data/zones.js and src/world/index.js never reference three', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [join(here, '../../src/world/data/zones.js'), join(here, '../../src/world/index.js')];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.equal(/from\s+['"]three['"]/.test(src), false, `${f} must not import 'three'`);
    assert.equal(/import\s*\(\s*['"]three['"]/.test(src), false, `${f} must not dynamically import 'three'`);
  }
});

// ---------------------------------------------------------------------------
// Acceptance half 1 — the four ZoneDescriptors load
// ---------------------------------------------------------------------------

test('exactly four ZoneDescriptors load, one per shipping zone id', () => {
  assert.equal(ZONE_DESCRIPTORS.length, 4);
  const ids = ZONE_DESCRIPTORS.map((d) => d.id).sort();
  assert.deepEqual(ids, ['altar_of_instruction', 'ashen_wastes', 'bonereach', 'last_bastion']);
});

test('every ZoneDescriptor validates against 01-data-model.md §9.1\'s shape', () => {
  const requiredFields = [
    'id', 'displayName', 'kind', 'generator', 'sizeX', 'sizeZ', 'cellSize',
    'monsterLevel', 'packCount', 'packSize', 'densityTarget', 'champChance',
    'uniqueChance', 'bestiary', 'surfaces', 'lightingPreset', 'fogPreset',
    'ambientAudio', 'treasureClass', 'exits', 'entryTags', 'chestCount', 'propBudget',
  ];
  for (const d of ZONE_DESCRIPTORS) {
    for (const field of requiredFields) {
      assert.ok(field in d, `${d.id} is missing field '${field}'`);
    }
    assert.equal(typeof d.id, 'string');
    assert.equal(typeof d.displayName, 'string');
    assert.ok(['town', 'open', 'dungeon', 'arena'].includes(d.kind), `${d.id}: unknown kind '${d.kind}'`);
    assert.ok(
      ['handauthored', 'ridgewalk', 'bsp_rooms', 'arena'].includes(d.generator),
      `${d.id}: unknown generator '${d.generator}'`,
    );
    assert.ok(Number.isFinite(d.sizeX) && d.sizeX > 0);
    assert.ok(Number.isFinite(d.sizeZ) && d.sizeZ > 0);
    assert.ok(Number.isInteger(d.monsterLevel) && d.monsterLevel >= 0);
    assert.ok(typeof d.packCount.min === 'number' && typeof d.packCount.max === 'number');
    assert.ok(typeof d.packSize.min === 'number' && typeof d.packSize.max === 'number');
    assert.ok(Array.isArray(d.bestiary));
    assert.ok(Array.isArray(d.surfaces) && d.surfaces.length > 0);
    assert.ok(Array.isArray(d.exits));
    assert.ok(Array.isArray(d.entryTags));
    assert.ok(typeof d.chestCount.min === 'number' && typeof d.chestCount.max === 'number');
    assert.ok(Number.isInteger(d.propBudget) && d.propBudget >= 0);
  }
});

test('every ZoneDescriptor matches the known per-zone facts (01 §9.1\'s four-zone table)', () => {
  for (const [id, expected] of Object.entries(EXPECTED_ZONE_SHAPE)) {
    const d = ZONE_DESCRIPTORS.find((z) => z.id === id);
    assert.ok(d, `missing descriptor '${id}'`);
    assert.equal(d.kind, expected.kind, `${id}.kind`);
    assert.equal(d.sizeX, expected.sizeX, `${id}.sizeX`);
    assert.equal(d.sizeZ, expected.sizeZ, `${id}.sizeZ`);
    assert.equal(d.monsterLevel, expected.monsterLevel, `${id}.monsterLevel`);
  }
});

test('ZoneDescriptors and their nested tables are deep-frozen', () => {
  assert.ok(Object.isFrozen(ZONE_DESCRIPTORS));
  for (const d of ZONE_DESCRIPTORS) {
    assert.ok(Object.isFrozen(d), `${d.id} descriptor itself`);
    assert.ok(Object.isFrozen(d.packCount), `${d.id}.packCount`);
    assert.ok(Object.isFrozen(d.packSize), `${d.id}.packSize`);
    assert.ok(Object.isFrozen(d.bestiary), `${d.id}.bestiary`);
    assert.ok(Object.isFrozen(d.surfaces), `${d.id}.surfaces`);
    assert.ok(Object.isFrozen(d.exits), `${d.id}.exits`);
    assert.ok(Object.isFrozen(d.entryTags), `${d.id}.entryTags`);
    assert.ok(Object.isFrozen(d.chestCount), `${d.id}.chestCount`);
  }
});

test('world.descriptor(zoneId) returns the matching descriptor for all four ids, and throws on an unknown one', async () => {
  const { world } = await makeWorld();
  for (const id of Object.keys(EXPECTED_ZONE_SHAPE)) {
    assert.equal(world.descriptor(id).id, id);
  }
  assert.throws(() => world.descriptor('nonexistent_zone'), /unknown zoneId/);
});

test('world.descriptors is the same frozen four-element array as the data module', async () => {
  const { world } = await makeWorld();
  assert.equal(world.descriptors, ZONE_DESCRIPTORS);
  assert.ok(Object.isFrozen(world.descriptors));
  assert.equal(world.descriptors.length, 4);
});

// ---------------------------------------------------------------------------
// Acceptance half 2 — staticFootprints frozen at zone:ready
// ---------------------------------------------------------------------------

test('before any enterZone, staticFootprints is already the documented shape: a frozen, empty array', async () => {
  const { world } = await makeWorld();
  assert.ok(Array.isArray(world.staticFootprints));
  assert.ok(Object.isFrozen(world.staticFootprints));
  assert.equal(world.staticFootprints.length, 0);
});

test('enterZone emits zone:teardown -> zone:enter -> zone:ready in that order, and zone:teardown is skipped on the very first zone', async () => {
  const { world, ctx } = await makeWorld();
  const seen = [];
  ctx.events.on('zone:teardown', (p) => seen.push(['zone:teardown', p]));
  ctx.events.on('zone:enter', (p) => seen.push(['zone:enter', p]));
  ctx.events.on('zone:ready', (p) => seen.push(['zone:ready', p]));

  await world.enterZone('last_bastion', 'town_start');

  assert.deepEqual(
    seen.map((s) => s[0]),
    ['zone:enter', 'zone:ready'],
    'no previous zone existed, so zone:teardown must not fire',
  );
  assert.equal(seen[0][1].zoneId, 'last_bastion');
  assert.equal(typeof seen[0][1].seed, 'number');
  assert.equal(seen[0][1].entry, 'town_start');
  assert.equal(seen[1][1].zoneId, 'last_bastion');
  assert.ok(seen[1][1].bounds);
  assert.equal(seen[1][1].bounds.minX, -30);
  assert.equal(seen[1][1].bounds.maxX, 30);
  assert.equal(typeof seen[1][1].navVersion, 'number');
});

test('a second enterZone DOES fire zone:teardown for the previous zone, before zone:enter for the new one', async () => {
  const { world, ctx } = await makeWorld();
  await world.enterZone('last_bastion', 'town_start');

  const seen = [];
  ctx.events.on('zone:teardown', (p) => seen.push(['zone:teardown', p]));
  ctx.events.on('zone:enter', (p) => seen.push(['zone:enter', p]));
  ctx.events.on('zone:ready', (p) => seen.push(['zone:ready', p]));

  await world.enterZone('ashen_wastes', 'portal_from_town');

  assert.deepEqual(
    seen.map((s) => s[0]),
    ['zone:teardown', 'zone:enter', 'zone:ready'],
  );
  assert.equal(seen[0][1].zoneId, 'last_bastion', 'zone:teardown carries the OLD zoneId');
  assert.equal(seen[1][1].zoneId, 'ashen_wastes');
  assert.equal(seen[2][1].zoneId, 'ashen_wastes');
});

test('enterZone populates staticFootprints with a non-empty, correctly-shaped set (O-35: the 02 §4 authoritative Footprint, never 07 §1.7\'s)', async () => {
  const { world } = await makeWorld();
  await world.enterZone('ashen_wastes', 'portal_from_town');
  const fps = world.staticFootprints;

  assert.ok(fps.length > 0, 'this ticket must actually emit footprints, not merely prove an empty freeze');
  for (const fp of fps) {
    assert.ok(['box', 'cylinder', 'poly'].includes(fp.kind), `kind must be O-35's shape, got '${fp.kind}'`);
    assert.notEqual(fp.kind, 'circle', 'circle is 07 §1.7\'s superseded name');
    assert.notEqual(fp.kind, 'convex', 'convex is 07 §1.7\'s superseded name');
    assert.equal(typeof fp.facing, 'number', 'rotation is named facing, not rotation');
    assert.equal('rotation' in fp, false, '07 §1.7\'s superseded field name must not appear');
    assert.equal(typeof fp.y, 'number', 'floor height is named y, not baseY');
    assert.equal(typeof fp.height, 'number', 'vertical extent is named height, not topY');
    assert.equal('baseY' in fp, false);
    assert.equal('topY' in fp, false);
    assert.equal(typeof fp.blocksNav, 'boolean', 'flag is named blocksNav, not navBlock');
    assert.equal('navBlock' in fp, false);
    assert.equal(typeof fp.blocksSight, 'boolean');
  }
});

test('MAIN: staticFootprints is genuinely frozen at zone:ready — push, index-assign and field mutation all fail to take effect', async () => {
  const { world } = await makeWorld();
  await world.enterZone('bonereach', 'descent');
  const fps = world.staticFootprints;
  const before = fps.map((fp) => ({ ...fp }));

  assert.ok(Object.isFrozen(fps), 'the array itself must be frozen');
  assert.throws(() => {
    fps.push({ kind: 'box', x: 0, z: 0 });
  }, TypeError, 'push onto a frozen array must throw (ESM strict mode), not silently no-op');

  assert.throws(() => {
    fps[0] = { kind: 'box', x: 999, z: 999 };
  }, TypeError, 'index-assignment onto a frozen array must throw');

  assert.ok(Object.isFrozen(fps[0]), 'each individual footprint record must be frozen too');
  assert.throws(() => {
    fps[0].blocksNav = false;
  }, TypeError, 'mutating a field on a frozen footprint record must throw, not silently apply');
  assert.throws(() => {
    fps[0].newField = 1;
  }, TypeError, 'adding a new property to a frozen record must throw');

  // Nothing above actually changed anything.
  assert.equal(fps.length, before.length);
  for (let i = 0; i < fps.length; i++) {
    assert.deepEqual({ ...fps[i] }, before[i], `footprint[${i}] must be byte-for-byte unchanged after every failed mutation attempt`);
  }
});

test('staticFootprints is invalidated by the next enterZone: the OLD frozen array stays frozen and unchanged, but the getter now returns a different, new frozen array', async () => {
  const { world } = await makeWorld();
  await world.enterZone('last_bastion', 'town_start');
  const oldFps = world.staticFootprints;
  assert.ok(oldFps.length > 0);

  await world.enterZone('altar_of_instruction', 'altar_entry');
  const newFps = world.staticFootprints;

  assert.notEqual(newFps, oldFps, 'a new zone must produce a NEW array, never mutate the previous one in place');
  assert.ok(Object.isFrozen(oldFps), 'the old array reference stays frozen forever');
  assert.ok(Object.isFrozen(newFps));
  // Zone sizes differ (last_bastion 60x60 vs altar_of_instruction 48x48), so
  // the perimeter walls' extents must differ too — a real behavioural check,
  // not just "the reference changed" (O-27).
  assert.notEqual(newFps[0].halfW, oldFps[0].halfW);
});

test('enterZone registers the new zone\'s footprints with physics and calls rebuild() (when physics is present)', async () => {
  const { world, physics } = await makeWorld({ withPhysics: true });
  await world.enterZone('ashen_wastes', 'portal_from_town');
  assert.equal(physics.stats.statics, world.staticFootprints.length);
});

test('enterZone works without physics registered at all (guarded ctx.peek path)', async () => {
  const { world } = await makeWorld({ withPhysics: false });
  const instance = await world.enterZone('last_bastion', 'town_start');
  assert.equal(instance.zoneId, 'last_bastion');
  assert.ok(world.staticFootprints.length > 0);
});

test('a previous zone\'s physics statics are removed before the next zone\'s are added — no cross-zone stacking', async () => {
  const { world, physics } = await makeWorld({ withPhysics: true });
  await world.enterZone('last_bastion', 'town_start');
  const firstCount = physics.stats.statics;
  await world.enterZone('ashen_wastes', 'portal_from_town');
  // If the previous zone's statics were never removed, this would read
  // firstCount + world.staticFootprints.length instead.
  assert.equal(physics.stats.statics, world.staticFootprints.length);
  assert.ok(firstCount > 0);
});

test('world.current reflects the just-entered ZoneInstance (01-data-model.md §9.2 shape)', async () => {
  const { world, ctx } = await makeWorld();
  assert.equal(world.current, null);
  const instance = await world.enterZone('bonereach', 'descent', { runIndex: 2, difficulty: 'trial' });
  assert.equal(world.current, instance);
  assert.equal(instance.zoneId, 'bonereach');
  assert.equal(instance.runIndex, 2);
  assert.equal(instance.difficulty, 'trial');
  assert.equal(instance.monsterLevel, 11);
  assert.equal(instance.boundsMinX, -56);
  assert.equal(instance.boundsMaxX, 56);
  assert.ok(instance.entries instanceof Map);
  // WRLD-7 note (out of THIS ticket's own file grant, but this exact
  // assertion is the one thing WRLD-7 directly falsifies — see that
  // ticket's own report): `bonereach` now has a real B10 generator that
  // populates `descent`/`altar_return` entries, so the "nothing built yet"
  // count this line originally asserted (0) is no longer the honest
  // reading of `entries` for THIS zoneId — it is exactly 2, matching the
  // shipped `zones.js` descriptor's own `entryTags` for bonereach.
  assert.equal(instance.entries.size, 2, 'WRLD-7 populates descent/altar_return entries for bonereach — see that ticket\'s report');
  assert.deepEqual(instance.spawnPoints, []);
  assert.deepEqual(instance.packs, []);
  assert.equal(instance.createdAtStep, ctx.time.step);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('seedFor(zoneId, runIndex) is deterministic for a fixed worldSeed, and varies with either input', async () => {
  const { world: w1 } = await makeWorld({ seed: SEEDS.a });
  const { world: w2 } = await makeWorld({ seed: SEEDS.a });
  assert.equal(w1.seedFor('ashen_wastes', 0), w1.seedFor('ashen_wastes', 0), 'same instance, same call, same answer');
  assert.notEqual(w1.seedFor('ashen_wastes', 0), w1.seedFor('ashen_wastes', 1), 'runIndex must matter');
  assert.notEqual(w1.seedFor('ashen_wastes', 0), w1.seedFor('bonereach', 0), 'zoneId must matter');

  w1.setWorldSeed(0xabc123);
  w2.setWorldSeed(0xabc123);
  assert.equal(
    w1.seedFor('altar_of_instruction', 5),
    w2.seedFor('altar_of_instruction', 5),
    'two independent WorldSystem instances with the same explicit worldSeed must agree',
  );
});

test('setWorldSeed changes the seed stream deterministically (no Math.random involved)', async () => {
  const { world } = await makeWorld();
  const before = world.seedFor('last_bastion', 0);
  world.setWorldSeed(0x11223344);
  const after = world.seedFor('last_bastion', 0);
  assert.notEqual(before, after);
  world.setWorldSeed(0x11223344);
  assert.equal(world.seedFor('last_bastion', 0), after, 'same explicit seed, same result, every time');
});

// ---------------------------------------------------------------------------
// Allocation — staticFootprints is documented Alloc: no (the getter itself,
// once a zone is loaded, must not allocate on repeated reads).
// ---------------------------------------------------------------------------

test('12.Axx staticFootprints getter is allocation-free after zone:ready', { skip: !hasGc() && 'run with --expose-gc' }, async () => {
  const { world } = await makeWorld();
  await world.enterZone('ashen_wastes', 'portal_from_town');
  let sink = world.staticFootprints;
  const result = assertAllocationFree(() => {
    sink = world.staticFootprints;
  });
  assert.ok(result.bytesPerCall < 1);
  assert.ok(sink.length > 0);
});
