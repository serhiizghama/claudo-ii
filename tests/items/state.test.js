// tests/items/state.test.js
//
// ITEM-13 acceptance tests for src/items/state.js (`durabilityTick`,
// `identify`) as wired onto `ItemsSystem` (src/items/index.js). `node:test`
// + `node:assert/strict` only, matching every sibling test file in this
// repo.
//
// Every test reaches the surface under test through a REAL, registry-
// resolved `ctx.get('items')`/`ctx.get('actors')` (same wiring
// tests/items/equipment.test.js already established) — `durabilityTick`'s
// `stats:dirty` emit goes through the real `actors.markDirty`, and the
// point of this ticket is that that call is real, not simulated.
//
// Fixtures set `actor.equipment[slot] = item; item.slot = slot;` directly
// rather than going through `items.equip()` — `equip()`'s own requirement
// gating (strength/dexterity/level) is a different ticket's (ITEM-11)
// concern and irrelevant to durability accrual; this file wants tight
// control over exactly which item sits in which slot with exactly which
// starting durability, not a second exercise of `canEquip`.
//
// Acceptance clauses covered (this ticket's brief):
//   1. durabilityTick accrues at exactly: 1/12 landed attacks, 1/25 hits
//      taken (round-robin over armour), 1/20 blocks (shield, PLUS the
//      armour round-robin), 8% of max on death. Long-run boundary: 1200
//      landed attacks costs exactly 100 durability. The four causes accrue
//      independently.
//   2. stats:dirty emitted at the crossing to 0 — once, not on every
//      subsequent tick.
//   3. 0 durability is `unusable`, not destroyed — item stays equipped,
//      same uid, reachable, `_cache.unusable === true`.
//   4. identify reveals affixes (flips `identified`) and emits
//      `item:identify`.

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

async function makeCtx(seed = DETERMINISTIC_SEED) {
  const events = new EventBus();
  const registry = new Registry();
  const ctx = {
    scene: null, camera: null, uiScene: null, uiCamera: null, canvas: null,
    config: {}, events, input: null,
    time: { elapsed: 0, raw: 0, dt: 0, fixed: 1 / 60, alpha: 0, scale: 1, frame: 0, step: 0 },
    rng: new Rng(seed),
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

/** A minimal, complete `ItemInstance` (`01-data-model.md` §5.3 shape),
 * same helper shape `tests/items/equipment.test.js#makeItem` already uses,
 * with explicit `durability`/`maxDurability` overrides (this file's whole
 * point) rather than always mirroring the base. */
function makeItem(baseId, overrides = {}) {
  const base = ITEM_BASES_BY_ID[baseId];
  return {
    uid: overrides.uid ?? nextUid(),
    baseId,
    rarity: overrides.rarity ?? 'normal',
    ilvl: overrides.ilvl ?? (base ? base.reqLevel : 1),
    identified: overrides.identified ?? true,
    quantity: 1,
    rolls: overrides.rolls ?? { defense: 0, superior: 0, damageMin: base && base.weapon ? base.weapon.minDamage : 0, damageMax: base && base.weapon ? base.weapon.maxDamage : 0 },
    affixes: overrides.affixes ?? [],
    uniqueId: null,
    uniqueValues: [],
    nameOverride: null,
    durability: overrides.durability ?? (base ? base.maxDurability : 1),
    maxDurability: overrides.maxDurability ?? (base ? base.maxDurability : 1),
    sockets: [],
    socketCount: 0,
    grid: null,
    slot: null,
    ground: null,
  };
}

function spawnActor(ctx, opts = {}) {
  const actors = ctx.get('actors');
  return actors.spawn({ kind: 'player', archetypeId: 'ravager', level: opts.level ?? 10 });
}

function emptyEquipment() {
  return {
    head: null, chest: null, hands: null, legs: null,
    mainHand: null, offHand: null, belt: null,
    amulet: null, ring1: null, ring2: null,
  };
}

/** Directly slots `item` into `actor.equipment[slot]` — see file header on
 * why this bypasses `items.equip()`. */
function slot(actor, slotName, item) {
  if (!actor.equipment) actor.equipment = emptyEquipment();
  actor.equipment[slotName] = item;
  item.slot = slotName;
}

function countEmits(ctx, eventName) {
  let n = 0;
  ctx.events.on(eventName, () => { n += 1; });
  return () => n;
}

// ---------------------------------------------------------------------------
// 1. durabilityTick — 'attack': 1 per 12 landed attacks, on the mainHand
// ---------------------------------------------------------------------------

test('ITMS.13-01: durabilityTick(actor, "attack") costs exactly 1 durability per 12 calls, no drift over 1200 calls', async () => {
  const ctx = await makeCtx(301);
  const items = ctx.get('items');
  const actor = spawnActor(ctx);
  const weapon = makeItem('axe_battle_normal', { durability: 1000, maxDurability: 1000 });
  slot(actor, 'mainHand', weapon);

  // Boundary proof: durability drops by exactly 1 on calls 12, 24, 36, ...
  // and by 0 on every other call, for the full 1200-call run — this is the
  // "1200 landed attacks must cost exactly 100 durability, not 99 or 101"
  // clause from this ticket's brief, checked at every single call, not
  // just the final total.
  let expectedLoss = 0;
  for (let i = 1; i <= 1200; i++) {
    items.durabilityTick(actor, 'attack');
    if (i % 12 === 0) expectedLoss += 1;
    assert.equal(1000 - weapon.durability, expectedLoss, `after call ${i}, expected total loss ${expectedLoss}`);
  }

  assert.equal(weapon.durability, 900, '1200 landed attacks (1/12) costs exactly 100 durability');
  assert.equal(1000 - weapon.durability, 100);
});

// ---------------------------------------------------------------------------
// 2. durabilityTick — 'hit': 1 per 25 hits taken, round-robin over armour
// ---------------------------------------------------------------------------

test('ITMS.13-02: durabilityTick(actor, "hit") costs 1 per 25 hits, round-robin over equipped armour, skipping indestructible pieces', async () => {
  const ctx = await makeCtx(302);
  const items = ctx.get('items');
  const actor = spawnActor(ctx);

  const head = makeItem('helm_cap_normal', { durability: 1000, maxDurability: 1000 });
  const chest = makeItem('armour_rags', { durability: 1000, maxDurability: 1000 });
  const hands = makeItem('gloves_bracers_normal', { durability: 0, maxDurability: 0 }); // indestructible: must be skipped
  slot(actor, 'head', head);
  slot(actor, 'chest', chest);
  slot(actor, 'hands', hands);

  // SLOT_ORDER is head, chest, hands, legs, mainHand, offHand, belt,
  // amulet, ring1, ring2 — with only head/chest equipped (hands is
  // indestructible and must be skipped), the round-robin must alternate
  // head, chest, head, chest, ...
  for (let i = 1; i <= 25; i++) items.durabilityTick(actor, 'hit');
  assert.equal(head.durability, 999, 'first 25th-hit point goes to the first eligible slot (head)');
  assert.equal(chest.durability, 1000, 'chest untouched by the first point');
  assert.equal(hands.durability, 0, 'indestructible piece never touched');

  for (let i = 1; i <= 25; i++) items.durabilityTick(actor, 'hit');
  assert.equal(head.durability, 999, 'head untouched by the second point');
  assert.equal(chest.durability, 999, 'second 25th-hit point round-robins to chest');

  for (let i = 1; i <= 25; i++) items.durabilityTick(actor, 'hit');
  assert.equal(head.durability, 998, 'third point wraps back to head');
  assert.equal(chest.durability, 999);

  // No loss on any of the 74 non-25th hits along the way, checked via the
  // running total rather than trusting only the checkpoints above.
  assert.equal((1000 - head.durability) + (1000 - chest.durability), 3, 'exactly 3 durability points spent over 75 hits (75/25)');
});

test('ITMS.13-02b: a naked actor ("hit" with no equipped armour) never throws and loses nothing', async () => {
  const ctx = await makeCtx(303);
  const items = ctx.get('items');
  const actor = spawnActor(ctx);
  assert.doesNotThrow(() => {
    for (let i = 0; i < 100; i++) items.durabilityTick(actor, 'hit');
  });
});

// ---------------------------------------------------------------------------
// 3. durabilityTick — 'block': 1 per 20 blocks on the shield, PLUS feeds
//    the same armour round-robin 'hit' uses (04 §7.4: "in addition to")
// ---------------------------------------------------------------------------

test('ITMS.13-03: durabilityTick(actor, "block") costs 1 per 20 blocks on the shield AND also feeds the hit-taken round-robin', async () => {
  const ctx = await makeCtx(304);
  const items = ctx.get('items');
  const actor = spawnActor(ctx);

  const shield = makeItem('shield_buckler_normal', { durability: 1000, maxDurability: 1000 });
  const head = makeItem('helm_cap_normal', { durability: 1000, maxDurability: 1000 });
  slot(actor, 'offHand', shield);
  slot(actor, 'head', head);

  for (let i = 1; i <= 19; i++) items.durabilityTick(actor, 'block');
  assert.equal(shield.durability, 1000, 'not yet at the 20-block threshold');

  items.durabilityTick(actor, 'block'); // 20th block
  assert.equal(shield.durability, 999, 'the shield loses 1 durability on the 20th block');

  // The armour round-robin has also seen 20 'hit'-equivalent events by now
  // (one per block) — not yet at its own 25 threshold, so head/shield's
  // OWN hit-round-robin share is still untouched beyond the block-specific
  // loss just asserted.
  assert.equal(head.durability, 1000, 'round-robin has not reached 25 yet (only 20 block events so far)');

  for (let i = 1; i <= 5; i++) items.durabilityTick(actor, 'block'); // 20 + 5 = 25th hit-equivalent
  // SLOT_ORDER is head, chest, hands, legs, mainHand, offHand, ... — with
  // only head and offHand(shield) equipped, the round-robin's first
  // eligible slot is head.
  assert.equal(head.durability, 999, 'the 25th accumulated hit-equivalent (all from blocks) reaches the armour round-robin, landing on head');
});

test('ITMS.13-03b: "block" with no shield equipped still feeds the armour round-robin and never throws', async () => {
  const ctx = await makeCtx(305);
  const items = ctx.get('items');
  const actor = spawnActor(ctx);
  const head = makeItem('helm_cap_normal', { durability: 1000, maxDurability: 1000 });
  slot(actor, 'head', head);

  assert.doesNotThrow(() => {
    for (let i = 0; i < 25; i++) items.durabilityTick(actor, 'block');
  });
  assert.equal(head.durability, 999, 'blocks without a shield still count as hits taken for the round-robin');
});

// ---------------------------------------------------------------------------
// The four causes accrue independently — no shared counter
// ---------------------------------------------------------------------------

test('ITMS.13-04: attack/hit/block/death accumulators are independent — one cause never advances another', async () => {
  const ctx = await makeCtx(306);
  const items = ctx.get('items');
  const actor = spawnActor(ctx);

  const weapon = makeItem('axe_battle_normal', { durability: 1000, maxDurability: 1000 });
  const shield = makeItem('shield_buckler_normal', { durability: 1000, maxDurability: 1000 });
  const head = makeItem('helm_cap_normal', { durability: 1000, maxDurability: 1000 });
  slot(actor, 'mainHand', weapon);
  slot(actor, 'offHand', shield);
  slot(actor, 'head', head);

  // 11 attacks (one short of the 12-threshold) must not touch anything.
  for (let i = 0; i < 11; i++) items.durabilityTick(actor, 'attack');
  assert.equal(weapon.durability, 1000);
  assert.equal(shield.durability, 1000);
  assert.equal(head.durability, 1000);

  // 19 blocks (one short of the shield's 20-threshold; also only 19 hit-
  // equivalents, short of the armour round-robin's 25) must likewise leave
  // everything untouched, including the still-pending 11th attack above.
  for (let i = 0; i < 19; i++) items.durabilityTick(actor, 'block');
  assert.equal(weapon.durability, 1000, 'attack accumulator is untouched by block calls');
  assert.equal(shield.durability, 1000, 'one call short of the block threshold');
  assert.equal(head.durability, 1000, 'one call short of the round-robin threshold (11 attacks fed nothing to it)');

  // The 12th attack now fires — proving the earlier 11 were preserved
  // across 19 unrelated 'block' calls, i.e. genuinely independent state.
  items.durabilityTick(actor, 'attack');
  assert.equal(weapon.durability, 999, 'the 12th attack (counter preserved across 19 intervening block calls) fires');
  assert.equal(shield.durability, 1000);
  assert.equal(head.durability, 1000);
});

// ---------------------------------------------------------------------------
// death: ceil(0.08 * maxDurability) on every equipped item, indestructible
// items exempt
// ---------------------------------------------------------------------------

test('ITMS.13-05: durabilityTick(actor, "death") applies ceil(0.08 * maxDurability) to every equipped item, skipping indestructible ones', async () => {
  const ctx = await makeCtx(307);
  const items = ctx.get('items');
  const actor = spawnActor(ctx);

  const weapon = makeItem('axe_battle_normal', { durability: 55, maxDurability: 55 }); // ceil(0.08*55) = 5
  const chest = makeItem('armour_rags', { durability: 40, maxDurability: 40 }); // ceil(0.08*40) = 4
  const unarmedLike = makeItem('unarmed', { durability: 0, maxDurability: 0 }); // indestructible
  slot(actor, 'mainHand', weapon);
  slot(actor, 'chest', chest);
  slot(actor, 'offHand', unarmedLike);

  items.durabilityTick(actor, 'death');
  assert.equal(weapon.durability, 50, 'ceil(0.08*55)=5 lost');
  assert.equal(chest.durability, 36, 'ceil(0.08*40)=4 lost');
  assert.equal(unarmedLike.durability, 0, 'indestructible (maxDurability===0) item is exempt');
});

// ---------------------------------------------------------------------------
// 2/3. stats:dirty at the crossing to 0, exactly once; item survives as
// `unusable`, not destroyed
// ---------------------------------------------------------------------------

test('ITMS.13-06: durabilityTick marks the item unusable (not destroyed) and emits stats:dirty exactly once, on the crossing', async () => {
  const ctx = await makeCtx(308);
  const items = ctx.get('items');
  const actor = spawnActor(ctx);
  const originalUid = 90210;
  const weapon = makeItem('axe_battle_normal', { uid: originalUid, durability: 1, maxDurability: 12 });
  slot(actor, 'mainHand', weapon);

  const getCount = countEmits(ctx, 'stats:dirty');

  // 11 attacks: 1 short of the 12-threshold, durability still 1, no emit.
  for (let i = 0; i < 11; i++) items.durabilityTick(actor, 'attack');
  assert.equal(weapon.durability, 1);
  assert.equal(getCount(), 0, 'no stats:dirty before the crossing');

  // The 12th attack crosses 1 -> 0.
  items.durabilityTick(actor, 'attack');
  assert.equal(weapon.durability, 0, 'durability clamps at 0, never negative');
  assert.equal(getCount(), 1, 'stats:dirty fires exactly once on the crossing');

  // Clause 3 — the item survives: same uid, still reachable in its slot,
  // marked unusable (never deleted/nulled/replaced).
  assert.equal(actor.equipment.mainHand, weapon, 'the SAME item object is still equipped');
  assert.equal(actor.equipment.mainHand.uid, originalUid, 'uid is unchanged — not a fresh/replacement item');
  assert.equal(weapon._cache && weapon._cache.unusable, true, '_cache.unusable is set at 0 durability');

  // Further hits at 0 durability: no further loss (already clamped), and
  // — the "will bite you" case — NO further stats:dirty emits.
  for (let i = 0; i < 50; i++) items.durabilityTick(actor, 'attack');
  assert.equal(weapon.durability, 0, 'still 0, never negative');
  assert.equal(getCount(), 1, 'stats:dirty does not fire again while already at 0');
  assert.equal(actor.equipment.mainHand, weapon, 'the item is still there after further hits, not destroyed');
});

test('ITMS.13-06b: durabilityTick("death") can also cross an item to 0 and marks it unusable, not destroyed', async () => {
  const ctx = await makeCtx(309);
  const items = ctx.get('items');
  const actor = spawnActor(ctx);
  const chest = makeItem('armour_rags', { uid: 555, durability: 3, maxDurability: 40 }); // ceil(0.08*40)=4 > 3
  slot(actor, 'chest', chest);

  const getCount = countEmits(ctx, 'stats:dirty');
  items.durabilityTick(actor, 'death');
  assert.equal(chest.durability, 0);
  assert.equal(getCount(), 1);
  assert.equal(actor.equipment.chest, chest, 'the item survives death-durability loss too');
  assert.equal(chest._cache.unusable, true);
});

// ---------------------------------------------------------------------------
// 4. identify — reveals affixes (flips `identified`) and emits
// ---------------------------------------------------------------------------

test('ITMS.13-07: identify flips identified to true and emits item:identify {item}, exactly once', async () => {
  const ctx = await makeCtx(310);
  const items = ctx.get('items');
  const rare = makeItem('sword_short_normal', {
    identified: false,
    rarity: 'rare',
    affixes: [{ id: 'pfx_enhanced_damage_3', kind: 'prefix', values: [40] }],
  });

  let emitted = null;
  ctx.events.on('item:identify', (payload) => { emitted = payload; });

  const result = items.identify(rare);
  assert.equal(result, true, 'identify() returns true when it actually flips the flag');
  assert.equal(rare.identified, true, 'identified is now true — the flag ui\'s §5.5 rendering reads');
  assert.ok(emitted, 'item:identify was emitted');
  assert.equal(emitted.item, rare, 'the payload carries the identified item');

  // Idempotent: identifying an already-identified item is a no-op, no
  // second emit.
  let secondEmitCount = 0;
  ctx.events.on('item:identify', () => { secondEmitCount += 1; });
  const second = items.identify(rare);
  assert.equal(second, false, 'already identified: no-op');
  assert.equal(secondEmitCount, 0, 'no second emit for an already-identified item');
});

test('ITMS.13-07b: identify(null) / identify(undefined) never throws and returns false — routes into production code with a well-formed refusal', async () => {
  const ctx = await makeCtx(311);
  const items = ctx.get('items');
  assert.equal(items.identify(null), false);
  assert.equal(items.identify(undefined), false);
});
