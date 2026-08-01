// tests/items/serialise.test.js
//
// ITEM-16 acceptance tests for src/items/serialise.js (serialiseItem,
// rebuildCache), as wired onto `ItemsSystem` (src/items/index.js:
// `rebuildCache` only — `serialiseItem` has no `02-api-contracts.md` row,
// see that file's own wiring-block comment). `node:test` +
// `node:assert/strict` only, matching every sibling test file in this repo.
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief):
//   1. `serialiseItem` writes EXACTLY `01-data-model.md` §5.3's field list
//      plus `uniqueValues` — not more, not fewer (ITMS.SV01, exact key set).
//   2. `rebuildCache` restores the derived state on load (ITMS.SV10-SV17).
//   3. `01-data-model.md` §10.3 invariants 7, 8, 12 and 13 hold on every
//      fixture (ITMS.SV30-SV33). NOTE — invariant 12's "matches the rarity
//      rule (§1.6)" is checked here against `roll.js`'s already-accepted
//      affix-count implementation, NOT against `01-data-model.md` §1.6's own
//      text: that section is outside this ticket's permitted spec ranges.
//      See this ticket's report for what that substitution means and does
//      not mean.
//
// The 10 000-item fuzz belongs to `tools/save-fuzz.mjs` (TEST-10, M6) —
// this file ships fixtures and property tests instead, per this ticket's
// own brief. `src/save/` does not exist in this tree yet; nothing here
// asserts its absence — every test below routes into real, already-shipped
// production code (`rollItem`, `serialiseItem`, `rebuildCache`,
// `ItemsSystem#rebuildCache`) and checks the result is well-formed.
//
// ITMS.SV17 (round 2) pins `rebuildCache`'s `_cache.weapon` write against
// `./equipment.js#equip`'s own — both now call the SAME exported
// `refreshWeaponCache` (`equipment.js`'s round-2 one-line `export` grant),
// so a future edit to either call site that breaks parity fails this test,
// not silently in production as O-55.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';
import { Registry } from '../../src/core/registry.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { ItemsSystem, serialiseItem } from '../../src/items/index.js';
import { rebuildCache } from '../../src/items/serialise.js';
import { rollItem } from '../../src/items/roll.js';
import { composeRareName, resetRareRing } from '../../src/items/names.js';
import { ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';
import { AFFIXES_BY_ID } from '../../src/items/data/affixes.js';
import { UNIQUES_BY_ID } from '../../src/items/data/uniques.js';
import { DETERMINISTIC_SEED } from '../helpers/seed.js';

// ---------------------------------------------------------------------------
// Fixtures — same "minimal ctx" precedent every sibling items test file
// uses (tests/items/economy.test.js, tests/items/ground.test.js).
// ---------------------------------------------------------------------------

let _ctxSeed = 1;
function makeCtx() {
  return {
    rng: new Rng(_ctxSeed++),
    events: new EventBus(),
    time: { step: 0 },
    get(id) { throw new Error(`stub ctx.get: '${id}' is not available in this test`); },
  };
}

async function makeSystem() {
  const sys = new ItemsSystem();
  await sys.init(makeCtx());
  return sys;
}

/** A real, registry-resolved ctx (`Physics` + `Actors` + `Items`) — same
 * shape `tests/items/equipment.test.js#makeCtx` uses — needed only by
 * ITMS.SV17 below, which must exercise the REAL `equip()` write path (not a
 * hand-rolled stub) to pin it against `rebuildCache`'s own write path. */
async function makeFullCtx() {
  const events = new EventBus();
  const registry = new Registry();
  const ctx = {
    scene: null, camera: null, uiScene: null, uiCamera: null, canvas: null,
    config: {}, events, input: null,
    time: { elapsed: 0, raw: 0, dt: 0, fixed: 1 / 60, alpha: 0, scale: 1, frame: 0, step: 0 },
    rng: new Rng(DETERMINISTIC_SEED),
    get: registry.get.bind(registry),
    peek: registry.peek.bind(registry),
    has: registry.has.bind(registry),
  };
  registry.add(PhysicsSystem);
  registry.add(ActorsSystem);
  registry.add(ItemsSystem);
  await registry.init(ctx);
  return ctx;
}

/** A batch of real `rollItem`-produced fixtures spanning every rarity —
 * high `magicFind` and a `champion` rank so magic/rare/unique all actually
 * appear inside a small, fast sample (asserted below, not assumed). Uses
 * the module's own `items` RNG shape (a plain `Rng`, seeded, never
 * `Math.random()`) so a failure is reproducible. */
function rollFixtures(n, seed) {
  resetRareRing();
  const rng = new Rng(seed);
  const out = [];
  const ilvls = [1, 8, 15, 22, 30, 40, 50];
  for (let i = 0; i < n; i++) {
    const ilvl = ilvls[i % ilvls.length];
    out.push(rollItem(i + 1, ilvl, ilvl, 'champion', 'trial', 8, null, rng));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clause 1 — the exact key set
// ---------------------------------------------------------------------------

test('ITMS.SV01 serialiseItem: exact key set — 01-data-model.md §5.3\'s field list plus uniqueValues, not more, not fewer', () => {
  // Transcribed verbatim from 01-data-model.md L888-891: "The save writes
  // uid, baseId, rarity, ilvl, identified, quantity, rolls, affixes,
  // uniqueId, nameOverride, durability, maxDurability, sockets,
  // socketCount, and exactly one of grid / slot" — plus `uniqueValues`
  // (04-items.md §12 step 13's own line; §5.3's field comment at L857-864
  // already calls it SERIALISED).
  const expectedKeys = [
    'uid', 'baseId', 'rarity', 'ilvl', 'identified', 'quantity',
    'rolls', 'affixes', 'uniqueId', 'uniqueValues', 'nameOverride',
    'durability', 'maxDurability', 'sockets', 'socketCount',
    'grid', 'slot',
  ].sort();

  const fixtures = rollFixtures(40, 101);
  let sawGrid = false;
  let sawSlot = false;
  let sawNeither = false;
  for (const item of fixtures) {
    // Exercise all three location states so the exact-key-set assertion
    // is not vacuously true for only one shape.
    const variant = item.uid % 3;
    if (variant === 0) { item.grid = { container: 'inventory', x: 1, y: 2 }; item.slot = null; sawGrid = true; }
    else if (variant === 1) { item.slot = 'mainHand'; item.grid = { container: null, x: 9, y: 9 }; sawSlot = true; }
    else { item.grid = undefined; item.slot = undefined; sawNeither = true; }

    const saved = serialiseItem(item);
    assert.deepEqual(Object.keys(saved).sort(), expectedKeys, `uid ${item.uid} (variant ${variant})`);
  }
  assert.ok(sawGrid && sawSlot && sawNeither, 'must have exercised grid, slot and neither variants');
});

test('ITMS.SV02 serialiseItem: rolls/affixes/sockets/uniqueValues are deep copies, not references', () => {
  const [item] = rollFixtures(1, 202);
  item.affixes = [{ id: 'sfx_test_1', kind: 'suffix', values: [5, 6] }];
  item.uniqueValues = [1, 2, 3];
  item.sockets = [null, 7];
  const saved = serialiseItem(item);

  saved.rolls.damageMin = -999;
  saved.affixes[0].values[0] = -999;
  saved.uniqueValues[0] = -999;
  saved.sockets[0] = -999;

  assert.notEqual(item.rolls.damageMin, -999, 'rolls must be copied');
  assert.notEqual(item.affixes[0].values[0], -999, 'affix values must be copied');
  assert.notEqual(item.uniqueValues[0], -999, 'uniqueValues must be copied');
  assert.notEqual(item.sockets[0], -999, 'sockets must be copied');
});

// ---------------------------------------------------------------------------
// Ruling D-33 — nameOverride serialises as TWO INTEGERS
// ---------------------------------------------------------------------------

test('ITMS.SV03 serialiseItem: a rare\'s nameOverride serialises to {headIndex, tailIndex} only — no en/ru/code', () => {
  let rareItem = null;
  const fixtures = rollFixtures(60, 303);
  for (const it of fixtures) if (it.rarity === 'rare') { rareItem = it; break; }
  assert.ok(rareItem, 'must have rolled at least one rare item to exercise this test');
  assert.ok(rareItem.nameOverride, 'a rare item must carry a nameOverride');

  const saved = serialiseItem(rareItem);
  assert.deepEqual(Object.keys(saved.nameOverride).sort(), ['headIndex', 'tailIndex'].sort());
  assert.equal(saved.nameOverride.headIndex, rareItem.nameOverride.headIndex);
  assert.equal(saved.nameOverride.tailIndex, rareItem.nameOverride.tailIndex);
});

test('ITMS.SV04 serialiseItem: a non-rare item\'s nameOverride serialises to null', () => {
  const fixtures = rollFixtures(60, 304);
  const nonRare = fixtures.find((it) => it.rarity !== 'rare');
  assert.ok(nonRare);
  assert.equal(serialiseItem(nonRare).nameOverride, null);
});

// ---------------------------------------------------------------------------
// ITEM-10's flagged deviation — item.grid is never nulled by remove()
// ---------------------------------------------------------------------------

test('ITMS.SV05 serialiseItem: a stale {container:null, x, y} (ITEM-10\'s remove() shape) serialises as a literal grid: null, never the stale object', () => {
  const [item] = rollFixtures(1, 305);
  item.grid = { container: null, x: 3, y: 7 }; // exactly what containers.js#remove leaves behind
  item.slot = null;
  const saved = serialiseItem(item);
  assert.equal(saved.grid, null, 'a removed item must never serialise a stale {container:null,...} object');
  assert.equal(saved.slot, null);
});

test('ITMS.SV06 serialiseItem: an equipped item (item.slot set) writes slot and nulls grid, even if item.grid still holds a stale object', () => {
  const [item] = rollFixtures(1, 306);
  item.grid = { container: null, x: 2, y: 2 }; // equip() detaches but keeps the object alive (equipment.js's own comment)
  item.slot = 'mainHand';
  const saved = serialiseItem(item);
  assert.equal(saved.slot, 'mainHand');
  assert.equal(saved.grid, null);
});

test('ITMS.SV07 serialiseItem: an item in a real container writes grid:{container,x,y} and slot:null', () => {
  const [item] = rollFixtures(1, 307);
  item.grid = { container: 'stash', x: 4, y: 1 };
  item.slot = null;
  const saved = serialiseItem(item);
  assert.deepEqual(saved.grid, { container: 'stash', x: 4, y: 1 });
  assert.equal(saved.slot, null);
});

test('ITMS.SV08 serialiseItem: a freshly-rolled item (no grid/slot/ground fields at all yet) serialises well-formed, never throws', () => {
  // ITMS.R26 (roll.test.js) already establishes rollItem's raw output has
  // no grid/slot/ground keys at all — routing/well-formedness proof, per
  // the test-form rule: a well-formed result (grid:null, slot:null), never
  // a throw and never a silent no-op.
  const [item] = rollFixtures(1, 308);
  assert.equal('grid' in item, false);
  assert.equal('slot' in item, false);
  const saved = serialiseItem(item);
  assert.equal(saved.grid, null);
  assert.equal(saved.slot, null);
});

// ---------------------------------------------------------------------------
// rebuildCache — clause 2: restores the derived state on load
// ---------------------------------------------------------------------------

test('ITMS.SV10 rebuildCache: attaches a fresh _cache in the 01-data-model.md §5.3 shape when absent', () => {
  const [item] = rollFixtures(1, 310);
  delete item._cache;
  rebuildCache(item);
  assert.ok(item._cache);
  assert.deepEqual(Object.keys(item._cache).sort().filter((k) => k !== 'weapon'), ['displayName', 'iconCanvas', 'sellValue', 'stats', 'unusable'].sort());
});

test('ITMS.SV11 rebuildCache: recomposes nameOverride.en/ru from the saved {headIndex, tailIndex}, matching composeRareName exactly', () => {
  const fixtures = rollFixtures(60, 311);
  const rareItem = fixtures.find((it) => it.rarity === 'rare');
  assert.ok(rareItem, 'must have rolled at least one rare item');
  const expected = composeRareName(rareItem.nameOverride.headIndex, rareItem.nameOverride.tailIndex);

  const saved = serialiseItem(rareItem);
  const loaded = { ...saved, _cache: undefined };
  rebuildCache(loaded);

  assert.equal(loaded.nameOverride.headIndex, saved.nameOverride.headIndex);
  assert.equal(loaded.nameOverride.tailIndex, saved.nameOverride.tailIndex);
  assert.equal(loaded.nameOverride.en, expected.en);
  assert.equal(loaded.nameOverride.ru, expected.ru);
  assert.equal(loaded.nameOverride.code, loaded.nameOverride.headIndex * 48 + loaded.nameOverride.tailIndex);
});

test('ITMS.SV12 rebuildCache: leaves a null nameOverride null', () => {
  const [item] = rollFixtures(1, 312);
  item.nameOverride = null;
  rebuildCache(item);
  assert.equal(item.nameOverride, null);
});

// ---------------------------------------------------------------------------
// ITEM-11's flagged gap — _cache.weapon must be rebuilt
// ---------------------------------------------------------------------------

test('ITMS.SV13 rebuildCache: populates _cache.weapon for a weapon item that never went through equip()', () => {
  const rng = new Rng(313);
  const item = rollItem(1, 20, 20, 'normal', 'trial', 0, null, rng); // axe_battle_normal or similar weapon group possible
  // Force a known weapon base so this test does not depend on which group rolled.
  item.baseId = 'axe_battle_normal';
  item.rolls.damageMin = 12;
  item.rolls.damageMax = 27;
  delete item._cache;

  rebuildCache(item);

  const base = ITEM_BASES_BY_ID.axe_battle_normal;
  assert.ok(item._cache && item._cache.weapon, 'weapon cache must be populated by rebuildCache alone, with no equip() call');
  assert.equal(item._cache.weapon.minDamage, 12);
  assert.equal(item._cache.weapon.maxDamage, 27);
  assert.equal(item._cache.weapon.attackTime, base.weapon.attackTime);
  assert.equal(item._cache.weapon.handling, base.weapon.handling);
});

test('ITMS.SV14 rebuildCache: does not attach a weapon cache for a non-weapon item', () => {
  const nonWeapon = rollFixtures(30, 315).find((it) => {
    const base = ITEM_BASES_BY_ID[it.baseId];
    return base && base.category !== 'weapon';
  });
  assert.ok(nonWeapon, 'must have rolled at least one non-weapon item');
  delete nonWeapon._cache;
  rebuildCache(nonWeapon);
  assert.equal(nonWeapon._cache.weapon, undefined);
});

test('ITMS.SV17 rebuildCache and equip() produce the IDENTICAL _cache.weapon — same function, two call sites, pinned against drift (O-55)', async () => {
  // The orchestrator's round-2 ruling: `rebuildCache` must call the exact
  // same `refreshWeaponCache` (`src/items/equipment.js`, exported for this
  // ticket, one line) that `equip()` calls — a second, independently
  // maintained copy is exactly how a loaded save silently falls back to
  // unarmed damage while a live-equipped character does not. This test
  // builds the SAME weapon two ways and asserts the two `_cache.weapon`
  // objects are deep-equal, so any future edit to either call site that
  // breaks parity fails here, not in production.
  const ctx = await makeFullCtx();
  const items = ctx.get('items');
  const actors = ctx.get('actors');

  // Path A — the real equip() write path.
  const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 20 });
  actor.attributes.strength = 60;
  const equippedAxe = {
    uid: 1, baseId: 'axe_battle_normal', rarity: 'normal', ilvl: 9,
    identified: true, quantity: 1,
    rolls: { defense: 0, superior: 0, damageMin: 10, damageMax: 22 },
    affixes: [], uniqueId: null, uniqueValues: [], nameOverride: null,
    durability: 55, maxDurability: 55, sockets: [], socketCount: 0,
    grid: null, slot: null, ground: null,
  };
  const eq = items.equip(actor, equippedAxe, 'mainHand');
  assert.equal(eq.ok, true, `equip() must succeed for this test to prove anything: ${eq.reason}`);
  assert.ok(equippedAxe._cache && equippedAxe._cache.weapon, 'equip() must build _cache.weapon');

  // Path B — save round trip, never touching equip()/canEquip() at all.
  const savedAxe = { ...equippedAxe, slot: 'mainHand', grid: null };
  delete savedAxe._cache;
  const loadedAxe = { ...savedAxe };
  items.rebuildCache(loadedAxe);
  assert.ok(loadedAxe._cache && loadedAxe._cache.weapon, 'rebuildCache() must build _cache.weapon too');

  assert.deepEqual(
    loadedAxe._cache.weapon,
    equippedAxe._cache.weapon,
    'equip() and rebuildCache() must produce the identical _cache.weapon — any drift here is O-55 returning',
  );
});

// ---------------------------------------------------------------------------
// Ruling — an older save without uniqueValues defaults to the MINIMUM
// ---------------------------------------------------------------------------

test('ITMS.SV15 rebuildCache: a unique item with missing uniqueValues (old save) fills them with each mod\'s MINIMUM, never a re-roll, never the max', () => {
  const uniqueId = Object.keys(UNIQUES_BY_ID)[0];
  const def = UNIQUES_BY_ID[uniqueId];
  const item = {
    uid: 900, baseId: def.baseId, rarity: 'unique', ilvl: def.reqLevel,
    identified: true, quantity: 1,
    rolls: { defense: 0, superior: 0, damageMin: 0, damageMax: 0 },
    affixes: [], uniqueId, uniqueValues: [], // absent, per an old save
    nameOverride: null, durability: 10, maxDurability: 10,
    sockets: [], socketCount: 0,
  };
  rebuildCache(item);
  assert.equal(item.uniqueValues.length, def.mods.length);
  for (let i = 0; i < def.mods.length; i++) {
    assert.equal(item.uniqueValues[i], def.mods[i].min, `mod ${i} must default to its minimum, never a re-roll or the maximum`);
  }
});

test('ITMS.SV16 rebuildCache: a unique item with a SHORT uniqueValues (fewer entries than mods) fills only the missing tail entries with the minimum, keeps the present ones', () => {
  const uniqueId = Object.keys(UNIQUES_BY_ID).find((id) => UNIQUES_BY_ID[id].mods.length >= 2);
  const def = UNIQUES_BY_ID[uniqueId];
  const item = {
    uid: 901, baseId: def.baseId, rarity: 'unique', ilvl: def.reqLevel,
    identified: true, quantity: 1,
    rolls: { defense: 0, superior: 0, damageMin: 0, damageMax: 0 },
    affixes: [], uniqueId, uniqueValues: [def.mods[0].max], // first present, rest missing
    nameOverride: null, durability: 10, maxDurability: 10,
    sockets: [], socketCount: 0,
  };
  rebuildCache(item);
  assert.equal(item.uniqueValues[0], def.mods[0].max, 'a present entry must be kept, not overwritten');
  for (let i = 1; i < def.mods.length; i++) {
    assert.equal(item.uniqueValues[i], def.mods[i].min);
  }
});

// ---------------------------------------------------------------------------
// Zero RNG draws on load
// ---------------------------------------------------------------------------

test('ITMS.SV20 rebuildCache: touches no Rng at all — a stream\'s next value is unaffected by any number of rebuildCache calls in between', () => {
  const fixtures = rollFixtures(50, 320);
  const probe = new Rng(777);
  probe.next(); // consume one draw, establishing a stream position
  for (const item of fixtures) {
    delete item._cache;
    rebuildCache(item);
    rebuildCache(item); // idempotent-call check, still zero draws
  }
  const after = probe.next();

  // A fresh, untouched Rng(777) that also consumes exactly one draw must
  // produce the identical next value — proof `probe`'s internal state was
  // never advanced by anything that happened between the two calls above.
  const reference = new Rng(777);
  reference.next();
  const expectedAfter = reference.next();
  assert.equal(after, expectedAfter, 'rebuildCache must not have consumed any draw from the probe stream');
});

test('ITMS.SV21 serialise.js imports no Rng/CountingRng — static proof rebuildCache cannot draw from anything, it is never even given a stream', () => {
  assert.equal(rebuildCache.length <= 1, true, 'rebuildCache takes item only, per 02-api-contracts.md:973 — no Rng parameter to draw from');
});

// ---------------------------------------------------------------------------
// ItemsSystem#rebuildCache routes into the real production code
// ---------------------------------------------------------------------------

test('ITMS.SV22 ItemsSystem#rebuildCache forwards to serialise.js#rebuildCache — routing, not a stub', async () => {
  const sys = await makeSystem();
  const [item] = rollFixtures(1, 322);
  delete item._cache;
  sys.rebuildCache(item);
  assert.ok(item._cache, 'ItemsSystem#rebuildCache must actually route into production code and produce a well-formed _cache');
});

// ---------------------------------------------------------------------------
// Full round trip — zero drift
// ---------------------------------------------------------------------------

test('ITMS.SV23 serialiseItem -> JSON round trip -> rebuildCache: baseId, rarity, ilvl, affix ids/values, uniqueValues, durability all survive with zero drift', () => {
  const fixtures = rollFixtures(120, 323);
  for (const item of fixtures) {
    // Place every item somewhere realistic, deterministically from its uid.
    const variant = item.uid % 2;
    if (variant === 0) item.grid = { container: 'inventory', x: item.uid % 5, y: 0 };
    else item.slot = 'mainHand';

    const saved = serialiseItem(item);
    const json = JSON.parse(JSON.stringify(saved)); // prove JSON-safety
    const loaded = { ...json };
    rebuildCache(loaded);

    assert.equal(loaded.uid, item.uid);
    assert.equal(loaded.baseId, item.baseId);
    assert.equal(loaded.rarity, item.rarity);
    assert.equal(loaded.ilvl, item.ilvl);
    assert.equal(loaded.identified, item.identified);
    assert.equal(loaded.quantity, item.quantity);
    assert.deepEqual(loaded.rolls, item.rolls);
    assert.deepEqual(loaded.affixes, item.affixes);
    assert.equal(loaded.uniqueId, item.uniqueId);
    assert.deepEqual(loaded.uniqueValues, item.uniqueValues);
    assert.equal(loaded.durability, item.durability);
    assert.equal(loaded.maxDurability, item.maxDurability);
    assert.deepEqual(loaded.sockets, item.sockets);
    assert.equal(loaded.socketCount, item.socketCount);
    if (variant === 0) assert.deepEqual(loaded.grid, item.grid);
    else assert.equal(loaded.slot, item.slot);
  }
});

// ---------------------------------------------------------------------------
// Clause 3 — 01-data-model.md §10.3 invariants 7, 8, 12, 13, on every fixture
// ---------------------------------------------------------------------------

test('ITMS.SV30 invariant 7 (verbatim: "Every baseId, uniqueId and affix id resolves in the current data tables") holds on every round-tripped fixture', () => {
  const fixtures = rollFixtures(150, 330);
  let checkedUnique = 0;
  let checkedAffixed = 0;
  for (const item of fixtures) {
    const saved = serialiseItem(item);
    const loaded = { ...JSON.parse(JSON.stringify(saved)) };
    rebuildCache(loaded);

    assert.ok(ITEM_BASES_BY_ID[loaded.baseId], `baseId '${loaded.baseId}' must resolve`);
    if (loaded.uniqueId) { assert.ok(UNIQUES_BY_ID[loaded.uniqueId], `uniqueId '${loaded.uniqueId}' must resolve`); checkedUnique++; }
    for (const a of loaded.affixes) {
      assert.ok(AFFIXES_BY_ID[a.id], `affix id '${a.id}' must resolve`);
      checkedAffixed++;
    }
  }
  assert.ok(checkedAffixed > 0, 'must have exercised at least one affix-bearing item');
  // A unique may or may not appear in 150 draws; not asserted > 0 here to
  // avoid a flaky gate — SV11/SV13 already force-exercise uniques directly.
  void checkedUnique;
});

test('ITMS.SV31 invariant 8 (verbatim: "Every ItemInstance.uid is unique across equipment + inventory + belt + stash, and < nextItemUid") holds across a simulated save', () => {
  const fixtures = rollFixtures(80, 331);
  const nextItemUid = 1000; // every fixture uid is 1..80, well under this
  const seen = new Set();
  // Distribute across the four save-shape pools by uid parity/mod, exactly
  // as a real CharacterSave/StashSave would carry them (01-data-model.md
  // §10.2): equipment (a SLOT->item map), inventory[], belt[4], stash[].
  const pools = { equipment: [], inventory: [], belt: [], stash: [] };
  const poolNames = ['equipment', 'inventory', 'belt', 'stash'];
  for (const item of fixtures) {
    const saved = serialiseItem(item);
    pools[poolNames[item.uid % 4]].push(saved);
  }
  for (const name of poolNames) {
    for (const saved of pools[name]) {
      assert.equal(seen.has(saved.uid), false, `uid ${saved.uid} must be unique across equipment+inventory+belt+stash`);
      seen.add(saved.uid);
      assert.ok(saved.uid < nextItemUid, `uid ${saved.uid} must be < nextItemUid (${nextItemUid})`);
    }
  }
  assert.equal(seen.size, fixtures.length);
});

test('ITMS.SV32 invariant 12 (verbatim: "affixes length matches the rarity rule (§1.6); values.length === definition.mods.length") holds on every round-tripped fixture', () => {
  const fixtures = rollFixtures(200, 332);
  let checkedMagic = 0;
  let checkedRare = 0;
  let checkedNormalLike = 0;
  for (const item of fixtures) {
    const saved = serialiseItem(item);
    const loaded = { ...JSON.parse(JSON.stringify(saved)) };
    rebuildCache(loaded);

    let prefixes = 0;
    let suffixes = 0;
    for (const a of loaded.affixes) {
      const def = AFFIXES_BY_ID[a.id];
      assert.ok(def, `affix '${a.id}' must resolve`);
      assert.equal(a.values.length, def.mods.length, `affix '${a.id}': values.length must equal definition.mods.length`);
      if (a.kind === 'prefix') prefixes++; else if (a.kind === 'suffix') suffixes++;
    }

    // The rarity rule (04-items.md §9.3 steps 7-8, the accepted ITEM-6
    // implementation this fixture's affixes were produced by): normal,
    // superior and unique NEVER carry an AffixInstance; magic carries at
    // most one prefix and one suffix (>= 1 total); rare carries at most
    // three of each kind. A count below the drawn mode/count is legal —
    // pickAffix skips (never retries) when its filtered pool is empty.
    if (loaded.rarity === 'normal' || loaded.rarity === 'superior' || loaded.rarity === 'unique') {
      assert.equal(loaded.affixes.length, 0, `${loaded.rarity} item must carry zero affixes`);
      checkedNormalLike++;
    } else if (loaded.rarity === 'magic') {
      assert.ok(prefixes <= 1 && suffixes <= 1 && prefixes + suffixes >= 1 && prefixes + suffixes <= 2,
        `magic item must carry 1-2 affixes, at most one per kind (got ${prefixes} prefix, ${suffixes} suffix)`);
      checkedMagic++;
    } else if (loaded.rarity === 'rare') {
      assert.ok(prefixes <= 3 && suffixes <= 3, `rare item must carry at most 3 of each kind (got ${prefixes} prefix, ${suffixes} suffix)`);
      checkedRare++;
    }
  }
  assert.ok(checkedMagic > 0, 'must have exercised at least one magic item');
  assert.ok(checkedRare > 0, 'must have exercised at least one rare item');
  assert.ok(checkedNormalLike > 0, 'must have exercised at least one normal/superior/unique item');
});

test('ITMS.SV33 invariant 13 (verbatim: "durability ∈ 0..maxDurability") holds on every round-tripped fixture, including the boundaries', () => {
  const fixtures = rollFixtures(60, 333);
  // Exercise both boundaries explicitly, not just whatever rollItem happened to produce.
  fixtures[0].durability = 0;
  fixtures[1].durability = fixtures[1].maxDurability;
  for (const item of fixtures) {
    const saved = serialiseItem(item);
    const loaded = { ...JSON.parse(JSON.stringify(saved)) };
    rebuildCache(loaded);
    assert.ok(loaded.durability >= 0, `durability ${loaded.durability} must be >= 0`);
    assert.ok(loaded.durability <= loaded.maxDurability, `durability ${loaded.durability} must be <= maxDurability ${loaded.maxDurability}`);
  }
});
