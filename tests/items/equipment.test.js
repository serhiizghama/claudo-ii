// tests/items/equipment.test.js
//
// ITEM-11 acceptance tests for src/items/equipment.js (`EquipmentSet`,
// `canEquip`, `equip`/`unequip`, `slotsFor`, `equipped`/`weaponOf`/
// `hasShield`) as wired onto `ItemsSystem` (src/items/index.js). `node:test`
// + `node:assert/strict` only, matching every sibling test file in this
// repo.
//
// Every test reaches the surface under test through a REAL, registry-
// resolved `ctx.get('items')`/`ctx.get('actors')` (`src/core/registry.js`,
// the same wiring `src/main.js` does) — not a hand-rolled stub `actors` —
// because `canEquip`/`equip`/`unequip` all call `actors.stats`/
// `setSourceLayer`, and the whole point of this ticket is that those calls
// are real, not simulated.
//
// Acceptance clauses covered (this ticket's brief):
//   1. A ring fits both `ring1` and `ring2`.
//   2. An item never satisfies its own requirement.
//   3. Equipping writes the `equipment` stat layer and the `StatBlock`
//      changes — measured (real before/after numbers).
//   4. A two-hander refuses to equip without room for the displaced
//      off-hand.
//   5. `slotsFor(item)` returns the real list.
//
// NOT tested here (owned by `combat`, a different ticket's file):
// `src/combat/packet.js#resolveWeapon`'s own behaviour — this file only
// asserts that `equip()` populates `item._cache.weapon` correctly, which is
// the contract `resolveWeapon` depends on.
//
// ---------------------------------------------------------------------------
// Round 2 — stats:dirty (found by ITEM-13, reported rather than fixed in a
// file it did not own; see this ticket's report)
// ---------------------------------------------------------------------------
// `equip`/`unequip` called `actors.setSourceLayer(...)`, which is a
// deliberately pure forward that sets `actor.statsDirty` but never emits
// (`src/actors/index.js`'s own comment on why `markDirty`, not
// `setSourceLayer`, is the one that emits) — so the `stats:dirty` event
// `01-data-model.md` §4.5 / `02-api-contracts.md`'s `items` Emits row both
// require on equip/unequip never fired. `ITMS.E19` below counts real
// `stats:dirty` (and `item:equip`/`item:unequip`) emissions through a live
// `ctx.events.on` listener — exactly once per successful call, zero on a
// failed one, matching ITEM-13's own "emit-once-on-transition" discipline
// for durability reaching zero.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { ItemsSystem } from '../../src/items/index.js';
import { ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';
import { DETERMINISTIC_SEED } from '../helpers/seed.js';

// ---------------------------------------------------------------------------
// A real registry-resolved ctx, same shape tests/actors/actr15.test.js uses,
// plus `items` registered alongside.
// ---------------------------------------------------------------------------

async function makeCtx() {
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
  registry.add(PhysicsSystem);
  registry.add(ActorsSystem);
  registry.add(ItemsSystem);
  await registry.init(ctx);
  return ctx;
}

let _uid = 1;
function nextUid() {
  return _uid++;
}

/** A minimal, complete `ItemInstance` (`01-data-model.md` §5.3 shape). */
function makeItem(baseId, overrides = {}) {
  const base = ITEM_BASES_BY_ID[baseId];
  return {
    uid: overrides.uid ?? nextUid(),
    baseId,
    rarity: overrides.rarity ?? 'normal',
    ilvl: overrides.ilvl ?? (base ? base.reqLevel : 1),
    identified: true,
    quantity: 1,
    rolls: overrides.rolls ?? { defense: 0, superior: 0, damageMin: base && base.weapon ? base.weapon.minDamage : 0, damageMax: base && base.weapon ? base.weapon.maxDamage : 0 },
    affixes: overrides.affixes ?? [],
    uniqueId: null,
    uniqueValues: [],
    nameOverride: null,
    durability: base ? base.maxDurability : 1,
    maxDurability: base ? base.maxDurability : 1,
    sockets: [],
    socketCount: 0,
    grid: null,
    slot: null,
    ground: null,
  };
}

function spawnPlayer(ctx, opts = {}) {
  const actors = ctx.get('items') && ctx.get('actors');
  return actors.spawn({ kind: 'player', archetypeId: 'ravager', level: opts.level ?? 10, ...opts.spawn });
}

// ---------------------------------------------------------------------------
// 5. slotsFor — the real legal list
// ---------------------------------------------------------------------------

test('ITMS.E10: slotsFor returns the real legal slot list per item shape', async () => {
  const ctx = await makeCtx();
  const items = ctx.get('items');

  assert.deepEqual(items.slotsFor(makeItem('ring_iron')), ['ring1', 'ring2'], 'a ring fits both ring slots');
  assert.deepEqual(items.slotsFor(makeItem('amulet_cord')), ['amulet']);
  assert.deepEqual(items.slotsFor(makeItem('helm_cap_normal')), ['head']);
  assert.deepEqual(items.slotsFor(makeItem('belt_sash_normal')), ['belt']);
  assert.deepEqual(
    items.slotsFor(makeItem('axe_battle_normal')), // one-handed
    ['mainHand', 'offHand'],
    'a one-hander is legal in mainHand AND offHand',
  );
  assert.deepEqual(
    items.slotsFor(makeItem('maul_great_normal')), // two-handed
    ['mainHand'],
    'a two-hander is mainHand-only',
  );
  assert.deepEqual(
    items.slotsFor(makeItem('shield_buckler_normal')),
    ['offHand'],
    'a shield (base.slot === offHand directly) is offHand-only',
  );
  assert.deepEqual(items.slotsFor(makeItem('potion_life_minor')), [], 'a consumable has no equipment slot');
  assert.deepEqual(items.slotsFor(null), []);

  // Alloc: no — same frozen array reference every call.
  const a = items.slotsFor(makeItem('ring_iron'));
  const b = items.slotsFor(makeItem('ring_iron'));
  assert.equal(a, b, 'slotsFor must return the same reference, never a fresh array per call');
});

// ---------------------------------------------------------------------------
// 1. A ring fits both ring1 and ring2
// ---------------------------------------------------------------------------

test('ITMS.E11: a ring equips into ring1, and a second ring equips into ring2', async () => {
  const ctx = await makeCtx();
  const items = ctx.get('items');
  const actor = spawnPlayer(ctx);

  const ring1Item = makeItem('ring_iron');
  const ring2Item = makeItem('ring_iron');

  const c1 = items.canEquip(actor, ring1Item, 'ring1');
  assert.equal(c1.ok, true, `ring1 should be legal: ${c1.reason}`);
  const r1 = items.equip(actor, ring1Item, 'ring1');
  assert.equal(r1.ok, true, `equip into ring1 failed: ${r1.reason}`);
  assert.equal(items.equipped(actor, 'ring1'), ring1Item);

  const c2 = items.canEquip(actor, ring2Item, 'ring2');
  assert.equal(c2.ok, true, `ring2 should be legal: ${c2.reason}`);
  const r2 = items.equip(actor, ring2Item, 'ring2');
  assert.equal(r2.ok, true, `equip into ring2 failed: ${r2.reason}`);
  assert.equal(items.equipped(actor, 'ring2'), ring2Item);

  // Both rings live simultaneously — ring1 unaffected by ring2's equip.
  assert.equal(items.equipped(actor, 'ring1'), ring1Item);
});

// ---------------------------------------------------------------------------
// 2. An item never satisfies its own requirement
// ---------------------------------------------------------------------------

test('ITMS.E12: an item cannot satisfy its own strength requirement (the self-satisfying +STR bug)', async () => {
  const ctx = await makeCtx();
  const items = ctx.get('items');
  const actors = ctx.get('actors');
  const actor = spawnPlayer(ctx);

  // axe_battle_normal reqStr 40. pfx_str_2 grants +6..12 strength — use a
  // fixed roll of +6. Ravager base strength is 30.
  const axe = makeItem('axe_battle_normal', {
    affixes: [{ id: 'pfx_str_2', kind: 'prefix', values: [6] }],
  });

  // Actor's OWN strength (no gear) = 34 — naive "equip first, check after"
  // logic would see 34 + 6 = 40 and wrongly allow it.
  actor.attributes.strength = 4; // 30 (base) + 4 = 34
  actors.markDirty(actor);
  const before = actors.stats(actor).strength;
  assert.equal(before, 34, 'sanity: actor strength without the axe is 34');

  const failCheck = items.canEquip(actor, axe, 'mainHand');
  assert.equal(failCheck.ok, false, 'a 34-str actor must not be able to equip a 40-str axe, even one that itself grants +6 str');
  assert.equal(failCheck.reason, 'strength');

  const failEquip = items.equip(actor, axe, 'mainHand');
  assert.equal(failEquip.ok, false);
  assert.equal(items.equipped(actor, 'mainHand'), null, 'a failed equip must not mutate the equipment set');

  // Now give the actor enough strength WITHOUT the item's help.
  actor.attributes.strength = 10; // 30 + 10 = 40
  actors.markDirty(actor);
  assert.equal(actors.stats(actor).strength, 40, 'sanity: actor strength without the axe is now exactly 40');

  const okCheck = items.canEquip(actor, axe, 'mainHand');
  assert.equal(okCheck.ok, true, `expected the equip to be legal now: ${okCheck.reason}`);
  const okEquip = items.equip(actor, axe, 'mainHand');
  assert.equal(okEquip.ok, true, `equip failed: ${okEquip.reason}`);
  assert.equal(items.equipped(actor, 'mainHand'), axe);

  // Once worn, the item's own +6 str DOES show up in the composed block.
  assert.equal(actors.stats(actor).strength, 46, 'worn, the item\'s own +6 str now shows in the composed StatBlock');
});

// ---------------------------------------------------------------------------
// 3. Equipping writes the equipment stat layer — measured
// ---------------------------------------------------------------------------

test('ITMS.E13: equip() writes the equipment StatSources layer and a real StatBlock field changes (measured)', async () => {
  const ctx = await makeCtx();
  const items = ctx.get('items');
  const actors = ctx.get('actors');
  const actor = spawnPlayer(ctx);

  const before = actors.stats(actor).maxLife;

  // pfx_life_4: flat +43..70 maxLife. Use a fixed roll of 55.
  const chest = makeItem('armour_rags', {
    affixes: [{ id: 'pfx_life_4', kind: 'prefix', values: [55] }],
  });

  const check = items.canEquip(actor, chest, 'chest');
  assert.equal(check.ok, true, `expected legal equip: ${check.reason}`);
  const res = items.equip(actor, chest, 'chest');
  assert.equal(res.ok, true, `equip failed: ${res.reason}`);

  const after = actors.stats(actor).maxLife;

  // eslint-disable-next-line no-console
  console.log(`ITMS.E13: maxLife before=${before} after=${after} (delta should reflect +55 flat maxLife)`);

  assert.notEqual(after, before, 'maxLife must actually change after equip — not just "a layer object exists"');
  assert.equal(after, before + 55, 'maxLife must move by exactly the item\'s flat +55 maxLife contribution');

  // Unequip removes the contribution again.
  const unequipped = items.unequip(actor, 'chest');
  assert.equal(unequipped, true);
  const afterUnequip = actors.stats(actor).maxLife;
  assert.equal(afterUnequip, before, 'unequip must remove the layer contribution again');
});

// ---------------------------------------------------------------------------
// 4. A two-hander refuses to equip without room for the displaced off-hand
// ---------------------------------------------------------------------------

test('ITMS.E14: a two-hander displaces an unoccupied inventory offHand successfully', async () => {
  const ctx = await makeCtx();
  const items = ctx.get('items');
  const actor = spawnPlayer(ctx, { level: 20 });
  actor.attributes.strength = 60; // clears every reqStr used below

  const oneHander = makeItem('axe_hand_normal');
  const shield = makeItem('shield_buckler_normal');
  assert.equal(items.equip(actor, oneHander, 'mainHand').ok, true);
  assert.equal(items.equip(actor, shield, 'offHand').ok, true);
  assert.equal(items.equipped(actor, 'offHand'), shield);

  const twoHander = makeItem('maul_great_normal');
  const res = items.equip(actor, twoHander, 'mainHand');
  assert.equal(res.ok, true, `expected the two-hander to displace the shield successfully: ${res.reason}`);
  assert.equal(items.equipped(actor, 'mainHand'), twoHander);
  assert.equal(items.equipped(actor, 'offHand'), null, 'offHand must be vacated');
  assert.equal(items.itemAt('inventory', shield.grid.x, shield.grid.y), shield, 'the displaced shield must land in the inventory');
});

test('ITMS.E15: a two-hander refuses to equip when there is no room for the displaced offHand', async () => {
  const ctx = await makeCtx();
  const items = ctx.get('items');
  const actor = spawnPlayer(ctx, { level: 20 });
  actor.attributes.strength = 90;

  const oneHander = makeItem('axe_hand_normal');
  const shield = makeItem('shield_buckler_normal');
  assert.equal(items.equip(actor, oneHander, 'mainHand').ok, true);
  assert.equal(items.equip(actor, shield, 'offHand').ok, true);

  // Fill every one of the 40 inventory cells with 1x1 potions.
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 10; x++) {
      const filler = makeItem('potion_life_minor');
      assert.equal(items.place('inventory', filler, x, y), true, `failed to fill cell (${x},${y})`);
    }
  }
  assert.equal(items.freeCells('inventory'), 0, 'sanity: inventory is completely full');

  const twoHander = makeItem('maul_great_normal');
  const check = items.canEquip(actor, twoHander, 'mainHand');
  assert.equal(check.ok, false, 'canEquip must refuse: there is no room for the displaced offHand shield');
  assert.equal(check.reason, 'no_room_offhand');

  const res = items.equip(actor, twoHander, 'mainHand');
  assert.equal(res.ok, false, 'equip must refuse for the same reason');

  // Nothing must have moved.
  assert.equal(items.equipped(actor, 'mainHand'), oneHander, 'mainHand must be unchanged');
  assert.equal(items.equipped(actor, 'offHand'), shield, 'offHand must be unchanged');
  assert.equal(items.freeCells('inventory'), 0, 'inventory must be untouched');
});

// ---------------------------------------------------------------------------
// equipped / weaponOf / hasShield
// ---------------------------------------------------------------------------

test('ITMS.E16: equipped/weaponOf/hasShield', async () => {
  const ctx = await makeCtx();
  const items = ctx.get('items');
  const actor = spawnPlayer(ctx, { level: 20 });
  actor.attributes.strength = 60;

  assert.equal(items.equipped(actor, 'mainHand'), null);
  assert.equal(items.weaponOf(actor).baseId, 'unarmed', 'no weapon equipped -> the unarmed pseudo-item');
  assert.equal(items.hasShield(actor), false);

  const weapon = makeItem('axe_hand_normal');
  assert.equal(items.equip(actor, weapon, 'mainHand').ok, true);
  assert.equal(items.weaponOf(actor), weapon);

  const shield = makeItem('shield_buckler_normal');
  assert.equal(items.equip(actor, shield, 'offHand').ok, true);
  assert.equal(items.hasShield(actor), true);

  // A monster actor (no equipment record) — weaponOf returns null, not the
  // pseudo-item.
  const actors = ctx.get('actors');
  const monster = actors.spawn({ kind: 'monster' });
  assert.equal(items.weaponOf(monster), null);
  assert.equal(items.hasShield(monster), false);
});

// ---------------------------------------------------------------------------
// D-21 — equip() maintains _cache.weapon for a real ItemInstance in mainHand
// ---------------------------------------------------------------------------

test('ITMS.E17: equip() populates item._cache.weapon (D-21 — resolveWeapon\'s contract)', async () => {
  const ctx = await makeCtx();
  const items = ctx.get('items');
  const actor = spawnPlayer(ctx, { level: 20 });
  actor.attributes.strength = 60;

  const axe = makeItem('axe_battle_normal'); // rolls.damageMin/Max = 10/22 (makeItem default)
  assert.equal(items.equip(actor, axe, 'mainHand').ok, true);

  assert.ok(axe._cache && axe._cache.weapon, 'equip() must build _cache.weapon');
  assert.equal(axe._cache.weapon.minDamage, 10);
  assert.equal(axe._cache.weapon.maxDamage, 22);
  assert.equal(axe._cache.weapon.attackTime, 0.75);
  assert.equal(axe._cache.weapon.handling, 'oneHandMelee');
  // O-94 cause 1 — `11-flows.md` §3.6 step 3 reads this field. It was missing
  // from the view for four milestones, so every actor swung at the unarmed
  // 1.4 m and the M4 gate's "each class clears the room" measured reach, not
  // damage. `axe_battle_normal`'s base range is 1.9 m.
  assert.equal(axe._cache.weapon.range, 1.9, 'the weapon view must carry base range (O-94 cause 1)');
});

test('ITMS.E17b: weaponRangeOf reads the equipped weapon\'s reach, not the unarmed literal (O-94 cause 1)', async () => {
  const { weaponRangeOf, UNARMED_RANGE_M } = await import('../../src/player/cast.js');
  const ctx = await makeCtx();
  const items = ctx.get('items');
  const actor = spawnPlayer(ctx, { level: 20 });
  actor.attributes.strength = 60;

  assert.equal(weaponRangeOf(items, actor), UNARMED_RANGE_M, 'bare-handed actor keeps the unarmed reach');

  const axe = makeItem('axe_battle_normal');
  assert.equal(items.equip(actor, axe, 'mainHand').ok, true);
  const armed = weaponRangeOf(items, actor);
  assert.equal(armed, 1.9);
  assert.ok(armed > UNARMED_RANGE_M, 'equipping a real weapon must extend reach past the unarmed fallback');
});

// ---------------------------------------------------------------------------
// unequip — no room leaves the item equipped, never destroyed
// ---------------------------------------------------------------------------

test('ITMS.E18: unequip with no inventory room leaves the item equipped and returns false', async () => {
  const ctx = await makeCtx();
  const items = ctx.get('items');
  const actor = spawnPlayer(ctx, { level: 20 });
  actor.attributes.strength = 60;

  const ring = makeItem('ring_iron');
  assert.equal(items.equip(actor, ring, 'ring1').ok, true);

  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 10; x++) {
      items.place('inventory', makeItem('potion_life_minor'), x, y);
    }
  }
  assert.equal(items.freeCells('inventory'), 0);

  const result = items.unequip(actor, 'ring1');
  assert.equal(result, false, 'no room -> unequip fails and the ring stays equipped');
  assert.equal(items.equipped(actor, 'ring1'), ring);
});

// ---------------------------------------------------------------------------
// stats:dirty — exactly once per successful equip/unequip, never on failure
// ---------------------------------------------------------------------------

test('ITMS.E19: equip()/unequip() emit stats:dirty exactly once each (and item:equip/item:unequip exactly once each), never on a failed call', async () => {
  const ctx = await makeCtx();
  const items = ctx.get('items');
  const actor = spawnPlayer(ctx, { level: 20 });
  actor.attributes.strength = 60;

  let dirtyCount = 0;
  const dirtyActors = [];
  ctx.events.on('stats:dirty', (payload) => {
    dirtyCount++;
    dirtyActors.push(payload.actor); // primitive/ref snapshot, not the (possibly reused) payload object itself
  });

  let equipCount = 0;
  const equipSnapshots = [];
  ctx.events.on('item:equip', (payload) => {
    equipCount++;
    // Snapshot fields out of the payload NOW — `equip()` reuses one payload
    // object across calls (this ticket's own zero-alloc design), so holding
    // a reference past the next equip()/unequip() call would silently
    // observe a LATER call's values instead of this one's.
    equipSnapshots.push({ actor: payload.actor, itemUid: payload.item && payload.item.uid, slot: payload.slot });
  });

  let unequipCount = 0;
  const unequipSnapshots = [];
  ctx.events.on('item:unequip', (payload) => {
    unequipCount++;
    unequipSnapshots.push({ actor: payload.actor, itemUid: payload.item && payload.item.uid, slot: payload.slot });
  });

  const ring = makeItem('ring_iron');

  // A FAILED equip (illegal slot) must emit nothing at all.
  const failed = items.equip(actor, ring, 'head');
  assert.equal(failed.ok, false);
  assert.equal(dirtyCount, 0, 'a failed equip must not emit stats:dirty');
  assert.equal(equipCount, 0, 'a failed equip must not emit item:equip');

  // A successful equip emits exactly one stats:dirty and one item:equip.
  const res = items.equip(actor, ring, 'ring1');
  assert.equal(res.ok, true, `equip failed: ${res.reason}`);
  assert.equal(dirtyCount, 1, 'equip() must emit stats:dirty exactly once, not zero, not two');
  assert.equal(dirtyActors[0], actor);
  assert.equal(equipCount, 1, 'equip() must emit item:equip exactly once');
  assert.equal(equipSnapshots[0].actor, actor);
  assert.equal(equipSnapshots[0].itemUid, ring.uid);
  assert.equal(equipSnapshots[0].slot, 'ring1');
  assert.equal(unequipCount, 0, 'equip() must never emit item:unequip');

  // A successful unequip emits exactly one MORE stats:dirty and one item:unequip.
  const un = items.unequip(actor, 'ring1');
  assert.equal(un, true);
  assert.equal(dirtyCount, 2, 'unequip() must emit stats:dirty exactly once more');
  assert.equal(dirtyActors[1], actor);
  assert.equal(unequipCount, 1, 'unequip() must emit item:unequip exactly once');
  assert.equal(unequipSnapshots[0].actor, actor);
  assert.equal(unequipSnapshots[0].itemUid, ring.uid);
  assert.equal(unequipSnapshots[0].slot, 'ring1');
  assert.equal(equipCount, 1, 'unequip() must never emit a second item:equip');

  // A FAILED unequip (no room) must emit nothing at all.
  items.equip(actor, ring, 'ring1'); // back on, resets the count baseline below
  const dirtyBeforeFailedUnequip = dirtyCount;
  const unequipCountBefore = unequipCount;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 10; x++) {
      items.place('inventory', makeItem('potion_life_minor'), x, y);
    }
  }
  assert.equal(items.freeCells('inventory'), 0);
  const failedUnequip = items.unequip(actor, 'ring1');
  assert.equal(failedUnequip, false);
  assert.equal(dirtyCount, dirtyBeforeFailedUnequip, 'a failed unequip (no room) must not emit stats:dirty');
  assert.equal(unequipCount, unequipCountBefore, 'a failed unequip (no room) must not emit item:unequip');
});
