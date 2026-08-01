// tests/items/accessors.test.js
//
// ITEM-19 acceptance tests for the `items` data/rolling accessors
// (`02-api-contracts.md` §11), across three rounds:
//   round 1: `base(baseId)`, `bases`, `affix(affixId)`, `unique(uniqueId)`.
//   round 2: the `ITEM_BASES_BY_ID` prototype-pollution fix
//            (`src/items/data/bases.js`) — the prototype-key test below.
//   round 3: `resolveTC(family, mlvl)`, `rolledMods(item, out)`,
//            `rollItem(...)` (live signature, see that method's own
//            comment for why it does not match `02:959` literally), and
//            `rollName(item, rng)`.
// `node:test` + `node:assert/strict` only, matching every sibling test file
// in this directory.
//
// THIS FILE'S ACCEPTANCE GATE (the orchestrator's brief, criteria 1-4 for
// round 1; round 3's criteria 1-4 below):
//   1. `base(id)` resolves all 75 shipped ItemBase ids; an unknown id
//      returns `undefined` (this ticket's documented choice — see below)
//      and never throws.
//   2. `bases` is a property returning the full frozen ItemBase[] — the
//      SAME reference on repeat reads, never a copy.
//   3. `affix(id)` resolves all 117 AffixDefinition records.
//   4. `unique(id)` resolves all 8 UniqueDefinition records.
//   round 3 — 1. `resolveTC` matches the module function for every
//      `n ∈ 1..40`. 2. `rolledMods` matches the module function's count and
//      fill for a magic/rare/unique item. 3. `rollItem` produces a
//      byte-identical item to the module function given the same seed.
//      4. `rollName` behaves per the one faithful adapter documented on the
//      method itself (`src/items/index.js`).
//
// Allocation (criterion 5/6 of round 1, criterion 5 of round 3 — "O(1)
// against a prebuilt index" / "Alloc: no") is this file's sibling,
// tests/items/accessors.perf.test.js — a `.test.js` file runs in the unit
// stage and must not assert timing/allocation (12-testing.md's stage
// split), so that gate lives in the perf file only.
//
// Every accessor is reached via a live, registry-resolved `ctx.get('items')`
// (same discipline as tests/actors/actr15.test.js), never `new
// ItemsSystem()` used directly as the surface under test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { ItemsSystem } from '../../src/items/index.js';
import { DETERMINISTIC_SEED, SEEDS } from '../helpers/seed.js';

// Read-only, same-subsystem data imports for the expected id lists — the
// identical pattern tests/items/mods.perf.test.js already uses for
// UNIQUES_BY_ID. Never crossed from another subsystem (ARCHITECTURE.md
// rule 2 is about production code reaching across subsystems, not a
// subsystem's own tests reading its own data tables).
import { ITEM_BASES } from '../../src/items/data/bases.js';
import { AFFIXES } from '../../src/items/data/affixes.js';
import { UNIQUES, UNIQUES_BY_ID } from '../../src/items/data/uniques.js';

// Round 3 — reference ("module function") imports, used ONLY to compute the
// expected value independently of `ItemsSystem`'s own delegation, exactly
// the same "reference implementation" role tests/items/mods.perf.test.js's
// own `UNIQUES_BY_ID` import already plays.
import { resolveTC } from '../../src/items/data/treasure.js';
import { rollItem } from '../../src/items/roll.js';
import { rolledMods } from '../../src/items/mods.js';
import { rollRareName, resetRareRing } from '../../src/items/names.js';

// ---------------------------------------------------------------------------
// A real registry-resolved ctx — same wiring src/main.js does.
// ---------------------------------------------------------------------------

async function makeRegistryCtx() {
  const events = new EventBus();
  const registry = new Registry();
  const ctx = {
    scene: null,
    camera: null,
    uiScene: null,
    uiCamera: null,
    canvas: null,
    config: {},
    events,
    input: null,
    time: { elapsed: 0, raw: 0, dt: 0, fixed: 1 / 60, alpha: 0, scale: 1, frame: 0, step: 0 },
    rng: new Rng(DETERMINISTIC_SEED),
    get: registry.get.bind(registry),
    peek: registry.peek.bind(registry),
    has: registry.has.bind(registry),
  };
  registry.add(ItemsSystem);
  await registry.init(ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// 1. base(baseId) — all 75 shipped ids, unknown id, never throws
// ---------------------------------------------------------------------------

test('items.base(id) resolves every one of the 75 shipped ItemBase ids', async () => {
  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  assert.equal(ITEM_BASES.length, 75, 'ITEM-1 fixed the catalogue at 75 bases');
  for (const base of ITEM_BASES) {
    assert.equal(items.base(base.id), base, `base(${base.id}) must resolve to the ITEM_BASES record`);
  }
});

test('items.base(id) returns undefined for an unknown id, and never throws', async () => {
  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  // This ticket's documented choice: `undefined`, not `null` — a plain
  // property miss on the prebuilt index, the same convention
  // src/items/mods.js and src/items/roll.js already read these tables
  // under (ITEM_BASES_BY_ID[missingKey] is undefined, never a throw).
  assert.equal(items.base('does_not_exist'), undefined);
  assert.equal(items.base(''), undefined);
  assert.doesNotThrow(() => items.base('does_not_exist'));
  assert.doesNotThrow(() => items.base(undefined));
  assert.doesNotThrow(() => items.base(null));
});

// ---------------------------------------------------------------------------
// Prototype-key ids — `base`/`affix`/`unique` must resolve `'toString'`,
// `'constructor'` and `'__proto__'` to `undefined`, the same as any other
// unknown id, never to an inherited `Object.prototype` value. Asserts the
// observable behaviour only, not the underlying table's implementation
// (`ITEM_BASES_BY_ID` happens to be `Object.create(null)` for this exact
// reason, per src/items/data/bases.js's own header, but this test does not
// name that fact).
// ---------------------------------------------------------------------------

test('items.base/affix/unique resolve prototype-shadowing ids to undefined, never an inherited value', async () => {
  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  for (const id of ['toString', 'constructor', '__proto__']) {
    assert.equal(items.base(id), undefined, `base(${id}) must be undefined, not an inherited Object.prototype value`);
    assert.equal(items.affix(id), undefined, `affix(${id}) must be undefined, not an inherited Object.prototype value`);
    assert.equal(items.unique(id), undefined, `unique(${id}) must be undefined, not an inherited Object.prototype value`);
  }
});

// ---------------------------------------------------------------------------
// 2. bases — property, full frozen array, same reference every read
// ---------------------------------------------------------------------------

test('items.bases is a property returning the full frozen ItemBase[], same reference every read', async () => {
  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  const first = items.bases;
  const second = items.bases;
  assert.equal(first.length, 75);
  assert.equal(first, ITEM_BASES, 'must be the canonical ITEM_BASES reference, not a copy');
  assert.equal(first, second, 'repeated reads must return the SAME reference — a copy is an allocation, Alloc:no forbids it');
  assert.ok(Object.isFrozen(first));
});

// ---------------------------------------------------------------------------
// 3. affix(affixId) — all 117 AffixDefinition records
// ---------------------------------------------------------------------------

test('items.affix(id) resolves all 117 AffixDefinition records', async () => {
  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  assert.equal(AFFIXES.length, 117, 'ITEM-2 fixed the catalogue at 117 affixes');
  for (const affix of AFFIXES) {
    assert.equal(items.affix(affix.id), affix, `affix(${affix.id}) must resolve to the AFFIXES record`);
  }
});

test('items.affix(id) returns undefined for an unknown id, and never throws', async () => {
  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  assert.equal(items.affix('does_not_exist'), undefined);
  assert.doesNotThrow(() => items.affix('does_not_exist'));
});

// ---------------------------------------------------------------------------
// 4. unique(uniqueId) — all 8 UniqueDefinition records
// ---------------------------------------------------------------------------

test('items.unique(id) resolves all 8 UniqueDefinition records', async () => {
  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  assert.equal(UNIQUES.length, 8, 'ITEM-7 fixed the catalogue at 8 uniques');
  for (const unique of UNIQUES) {
    assert.equal(items.unique(unique.id), unique, `unique(${unique.id}) must resolve to the UNIQUES record`);
  }
});

test('items.unique(id) returns undefined for an unknown id, and never throws', async () => {
  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  assert.equal(items.unique('does_not_exist'), undefined);
  assert.doesNotThrow(() => items.unique('does_not_exist'));
});

// ===========================================================================
// Round 3 — resolveTC, rolledMods, rollItem (live signature), rollName
// ===========================================================================

// ---------------------------------------------------------------------------
// resolveTC — matches the module function for every mlvl 1..40, across every
// banded family plus one single-class family (falls through to itself).
// ---------------------------------------------------------------------------

test('items.resolveTC(family, mlvl) matches the module function for every mlvl 1..40', async () => {
  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  const families = ['tc_humanoid', 'tc_swarm', 'tc_caster', 'tc_heavy', 'tc_potion', 'tc_boss'];
  for (const family of families) {
    for (let mlvl = 1; mlvl <= 40; mlvl++) {
      assert.equal(
        items.resolveTC(family, mlvl),
        resolveTC(family, mlvl),
        `resolveTC(${family}, ${mlvl}) must match the module function`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// rolledMods — same count and fill as the module function, for a magic, a
// rare (sharedRoll affix) and a unique item. Same fixture shape
// tests/items/mods.perf.test.js already uses.
// ---------------------------------------------------------------------------

function magicItemFixture() {
  return {
    baseId: 'axe_battle_normal',
    rarity: 'magic',
    rolls: { defense: 0, superior: 0, damageMin: 10, damageMax: 22 },
    affixes: [
      { id: 'pfx_enhanced_damage_3', kind: 'prefix', values: [40] },
      { id: 'sfx_attack_rating_2', kind: 'suffix', values: [15] },
    ],
    uniqueId: null,
    uniqueValues: [],
  };
}

function rareArmourItemFixture() {
  return {
    baseId: 'helm_coif_normal',
    rarity: 'rare',
    rolls: { defense: 15, superior: 0, damageMin: 0, damageMax: 0 },
    affixes: [
      { id: 'pfx_enhanced_damage_3', kind: 'prefix', values: [45] },
      { id: 'sfx_res_all_1', kind: 'suffix', values: [7, 7, 7, 7, 7, 7] },
    ],
    uniqueId: null,
    uniqueValues: [],
  };
}

function uniqueItemFixture() {
  const def = UNIQUES_BY_ID.ashen_crown;
  return {
    baseId: 'helm_coif_normal',
    rarity: 'unique',
    rolls: { defense: 12, superior: 0, damageMin: 0, damageMax: 0 },
    affixes: [],
    uniqueId: 'ashen_crown',
    uniqueValues: def.mods.map((m) => m.min),
  };
}

test('items.rolledMods(item, out) matches the module function\'s count and fill (magic, rare, unique)', async () => {
  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  for (const fixture of [magicItemFixture, rareArmourItemFixture, uniqueItemFixture]) {
    const viaSubsystemOut = [];
    const viaModuleOut = [];
    const viaSubsystemN = items.rolledMods(fixture(), viaSubsystemOut);
    const viaModuleN = rolledMods(fixture(), viaModuleOut);

    assert.equal(viaSubsystemN, viaModuleN, `${fixture.name}: entry count must match`);
    assert.deepEqual(
      viaSubsystemOut.slice(0, viaSubsystemN),
      viaModuleOut.slice(0, viaModuleN),
      `${fixture.name}: filled entries must match`,
    );
  }
});

// ---------------------------------------------------------------------------
// rollItem — the live signature `(uid, ilvl, mlvl, rank, difficulty,
// magicFind, rarityFloor, rng)`, NOT `02:959`'s stale
// `(baseId, ilvl, rarity, rng)` — see src/items/index.js's own comment on
// this method for why. Byte-identical to the module function given the
// same seed: two independently constructed `Rng`s on the same seed produce
// the same draw sequence (CORE-5's determinism contract), so rolling the
// same uid/ilvl/etc. through both must deep-equal.
// ---------------------------------------------------------------------------

test('items.rollItem(...) with the live signature produces a byte-identical item to the module function, same seed', async () => {
  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  const cases = [
    // [uid, ilvl, mlvl, rank, difficulty, magicFind, rarityFloor]
    [1, 20, 20, 'normal', 'instruction', 0, null],
    [2, 30, 30, 'normal', 'instruction', 0, 'rare'], // forced rare -> exercises rollName's D13 too
    [3, 15, 15, 'normal', 'instruction', 0, 'magic'],
  ];

  for (const args of cases) {
    // A forced-rare case draws D13 (rollRareName), which reads AND writes
    // the module-level recent-name ring (src/items/names.js) — reset it
    // immediately before each side of the comparison so a ring collision
    // from the FIRST call cannot make the SECOND call (same seed) redraw
    // and diverge. Same discipline tests/items/roll.test.js's own `resetRareRing()`
    // call already documents ("deterministic regardless of what ran earlier
    // in this file/process").
    resetRareRing();
    const viaSubsystem = items.rollItem(...args, new Rng(SEEDS.a));
    resetRareRing();
    const viaModule = rollItem(...args, new Rng(SEEDS.a));
    assert.deepEqual(viaSubsystem, viaModule, `rollItem(${args.join(', ')}) must match the module function byte-for-byte`);
  }
});

// ---------------------------------------------------------------------------
// rollName — the one faithful adapter this ticket determined:
// `item.nameOverride = rollRareName(rng)`, no invented rarity guard (see
// src/items/index.js's own comment on this method). Proven against the
// module function with two independently-seeded Rngs, and proven to touch
// ONLY `nameOverride` on the item passed in.
// ---------------------------------------------------------------------------

test('items.rollName(item, rng) sets item.nameOverride to the module rollRareName result, same seed', async () => {
  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  const item = { baseId: 'axe_battle_normal', rarity: 'rare', nameOverride: null };

  // Reset the shared module-level ring (src/items/names.js) immediately
  // before each call — see the rollItem test above for why a ring
  // collision from the first call would otherwise make the second
  // (same-seed) call redraw and diverge.
  resetRareRing();
  const expected = rollRareName(new Rng(SEEDS.a));

  resetRareRing();
  const returned = items.rollName(item, new Rng(SEEDS.a));

  assert.equal(returned, undefined, 'rollName is void per its contracted signature');
  assert.deepEqual(item.nameOverride, expected, 'nameOverride must match the module rollRareName result, same seed');
});

test('items.rollName(item, rng) touches only item.nameOverride', async () => {
  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  const item = { baseId: 'axe_battle_normal', rarity: 'rare', uid: 42, ilvl: 20, nameOverride: null };
  resetRareRing();
  items.rollName(item, new Rng(SEEDS.a));

  assert.equal(item.baseId, 'axe_battle_normal');
  assert.equal(item.rarity, 'rare');
  assert.equal(item.uid, 42);
  assert.equal(item.ilvl, 20);
  assert.notEqual(item.nameOverride, null);
});
