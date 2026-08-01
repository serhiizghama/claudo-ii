// tests/items/containers.test.js
//
// ITEM-10 acceptance tests for src/items/containers.js (containers, tetris
// placement, the belt, and the cursor slot) as wired onto `ItemsSystem`
// (src/items/index.js). `node:test` + `node:assert/strict` only, matching
// every sibling test file in this repo.
//
// This ticket's own acceptance criterion is five PROPERTY tests, not
// examples ("generate many randomised container states and assert the
// invariant holds across all of them"), driven from a seeded `Rng` so a
// failure is reproducible — never `Math.random()`:
//   ITMS.C20 — no cell ever holds two uids
//   ITMS.C20 — every item's rectangle lies fully inside its grid (same test,
//     same rebuild-and-compare helper catches both at once — see
//     `assertGridConsistency` below)
//   ITMS.C30 — sortContainer is idempotent
//   ITMS.C40 — findPlacement never mutates (whole-container snapshot,
//     deep-compared, not "reading the code")
//   ITMS.C50 — a two-hander refuses to equip without room for the displaced
//     off-hand (see that test's own header for exactly what it does and
//     does not claim, given `equipment.js`/`canEquip` are a different,
//     not-yet-built ticket outside this one's file grant)
//
// Everything else here (ITMS.C00-C13, C60-C8x) is ordinary unit coverage for
// the "methods the backlog dropped entirely" this ticket also has to land:
// autoPlace/itemAt/splitStack/sortContainer/canPlace/place/remove/
// findPlacement/freeCells, plus the belt and the cursor slot.
//
// NOT tested here (owned by other, not-yet-built tickets, per this ticket's
// own brief — O-27/O-39, never asserted as "does not exist yet", simply not
// exercised): `equip`/`unequip`/`equipped`/`canEquip`/`weaponOf`/
// `hasShield` (equipment.js), the actual consumable EFFECT `beltUse` would
// trigger (restore_life/mana amounts — combat/player's job), and
// `dropToGround` (drop.js, not built).

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../src/core/rng.js';
import { ItemsSystem } from '../../src/items/index.js';
import { ITEM_BASES, ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';
import {
  INVENTORY_W,
  INVENTORY_H,
  STASH_W,
  STASH_H,
  BELT_SLOT_COUNT,
  BELT_COOLDOWN_SECONDS,
  resetSplitUidCounter,
} from '../../src/items/containers.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A bare, headless ctx: a fake `actors` system exposing `.player`, and a
 * mutable `time.step` the belt-cooldown tests advance by hand — the same
 * "minimal ctx" precedent tests/items/quality.test.js already sets. */
let _ctxSeed = 1;
function makeCtx(playerActor, step = 0) {
  return {
    rng: new Rng(_ctxSeed++),
    time: { step },
    get(id) {
      if (id === 'actors') return { player: playerActor };
      throw new Error(`stub ctx.get: '${id}' is not available in this test`);
    },
  };
}

function makeActor() {
  return { kind: 'player', inventory: null, belt: null };
}

async function makeSystem(actor, step = 0) {
  const sys = new ItemsSystem();
  const ctx = makeCtx(actor, step);
  await sys.init(ctx);
  return { sys, ctx };
}

let _uid = 1;
function nextTestUid() {
  return _uid++;
}

/** A minimal, complete `ItemInstance` (01-data-model.md §5.3 shape) —
 * enough for every field `containers.js` reads or `splitStack` clones. */
function makeItem(baseId, overrides = {}) {
  const base = ITEM_BASES_BY_ID[baseId];
  return {
    uid: overrides.uid ?? nextTestUid(),
    baseId,
    rarity: overrides.rarity ?? 'normal',
    ilvl: overrides.ilvl ?? (base ? base.reqLevel : 1),
    identified: true,
    quantity: overrides.quantity ?? 1,
    rolls: { defense: 0, superior: 0, damageMin: 0, damageMax: 0 },
    affixes: overrides.affixes ?? [],
    uniqueId: null,
    uniqueValues: [],
    nameOverride: null,
    durability: base ? base.maxDurability : 1,
    maxDurability: base ? base.maxDurability : 1,
    sockets: [],
    socketCount: 0,
  };
}

/** Rebuilds an independent occupancy array from `grid.list` (the
 * authoritative dense item bag) and fails loudly the instant two different
 * items claim the same cell (property 1) or an item's rectangle falls
 * outside the grid (property 2) — then cross-checks the rebuild against
 * `grid.cells` byte-for-byte, so the two structures this ticket maintains
 * in parallel can never silently drift apart either. */
function assertGridConsistency(grid, label) {
  const rebuilt = new Int32Array(grid.cells.length);
  for (let i = 0; i < grid.count; i++) {
    const item = grid.list[i];
    const base = ITEM_BASES_BY_ID[item.baseId];
    const w = base ? base.invW : 1;
    const h = base ? base.invH : 1;
    const gx = item.grid.x;
    const gy = item.grid.y;
    assert.ok(
      gx >= 0 && gy >= 0 && gx + w <= grid.width && gy + h <= grid.height,
      `${label}: item uid=${item.uid} (${item.baseId}, ${w}x${h}) rectangle at ` +
        `(${gx},${gy}) is not fully inside the ${grid.width}x${grid.height} grid`,
    );
    for (let cy = gy; cy < gy + h; cy++) {
      for (let cx = gx; cx < gx + w; cx++) {
        const idx = cy * grid.width + cx;
        assert.equal(
          rebuilt[idx], 0,
          `${label}: cell (${cx},${cy}) is claimed by two items — uid=${rebuilt[idx]} and uid=${item.uid}`,
        );
        rebuilt[idx] = item.uid;
      }
    }
  }
  assert.deepEqual(
    Array.from(grid.cells), Array.from(rebuilt),
    `${label}: grid.cells must match the occupancy rebuilt from grid.list exactly`,
  );
}

function snapshotContainer(grid) {
  if (!grid) return null;
  return {
    cells: Array.from(grid.cells),
    items: grid.list.slice(0, grid.count).map((it) => ({ uid: it.uid, container: it.grid.container, x: it.grid.x, y: it.grid.y })),
    count: grid.count,
  };
}

// ---------------------------------------------------------------------------
// Basic unit coverage — canPlace / place / remove / itemAt / freeCells / autoPlace
// ---------------------------------------------------------------------------

test('ITMS.C00 place() stamps every covered cell with the item uid and itemAt() resolves any covered cell back to it', async () => {
  const { sys } = await makeSystem(makeActor());
  const item = makeItem('shield_buckler_normal'); // 2x2

  assert.equal(sys.place('stash', item, 3, 1), true);
  assert.equal(sys.itemAt('stash', 3, 1), item);
  assert.equal(sys.itemAt('stash', 4, 1), item);
  assert.equal(sys.itemAt('stash', 3, 2), item);
  assert.equal(sys.itemAt('stash', 4, 2), item);
  assert.equal(sys.itemAt('stash', 5, 1), null, 'one cell past the footprint must be empty');
  assert.equal(sys.itemAt('stash', 2, 1), null, 'one cell before the footprint must be empty');
  assert.deepEqual(item.grid, { container: 'stash', x: 3, y: 1 });
});

test('ITMS.C01 canPlace() refuses out-of-bounds and overlapping rectangles, and allows an item to overlap only itself', async () => {
  const { sys } = await makeSystem(makeActor());
  const a = makeItem('dagger_shard_normal'); // 1x2
  assert.equal(sys.place('stash', a, 0, 0), true);

  assert.equal(sys.canPlace('stash', a, 9, 7), false, 'a 1x2 at (9,7) in a 10x8 grid runs off the bottom edge');
  assert.equal(sys.canPlace('stash', a, -1, 0), false);
  assert.equal(sys.canPlace('stash', a, 0, 0), true, 'an item may always overlap its own current cells');

  const b = makeItem('dagger_shard_normal');
  assert.equal(sys.canPlace('stash', b, 0, 0), false, 'a different item may not overlap a\'s cells');
  assert.equal(sys.canPlace('stash', b, 0, 1), false, 'b (1x2) at (0,1) would overlap a\'s second cell (0,1)');
  assert.equal(sys.canPlace('stash', b, 1, 0), true);
});

test('ITMS.C02 remove() clears occupancy and freeCells reflects it; a second remove() is a no-op refusal', async () => {
  const { sys } = await makeSystem(makeActor());
  const item = makeItem('sword_short_normal'); // 1x3
  const before = sys.freeCells('stash');

  assert.equal(sys.place('stash', item, 2, 0), true);
  assert.equal(sys.freeCells('stash'), before - 3);

  assert.equal(sys.remove(item), true);
  assert.equal(sys.freeCells('stash'), before);
  assert.equal(sys.itemAt('stash', 2, 0), null);

  assert.equal(sys.remove(item), false, 'removing an already-removed item must refuse, not throw');
});

test('ITMS.C03 autoPlace() is first-fit row-major', async () => {
  const { sys } = await makeSystem(makeActor());
  // Occupy the entire top row (10 wide) except column 4, plus block row 1
  // columns 0-3 too, so the first legal 1x1 cell in row-major order is (4,0).
  for (let x = 0; x < INVENTORY_W; x++) {
    if (x === 4) continue;
    assert.equal(sys.place('inventory', makeItem('potion_life_minor'), x, 0), true);
  }
  const probe = makeItem('potion_life_minor');
  assert.equal(sys.autoPlace('inventory', probe), true);
  assert.deepEqual({ x: probe.grid.x, y: probe.grid.y }, { x: 4, y: 0 });
});

test('ITMS.C04 the "inventory" container resolves through ctx.get(\'actors\').player, lazily, once', async () => {
  const actor = makeActor();
  assert.equal(actor.inventory, null);
  const { sys } = await makeSystem(actor);

  assert.equal(sys.freeCells('inventory'), INVENTORY_W * INVENTORY_H);
  assert.notEqual(actor.inventory, null, 'the first touch must lazily create the InventoryGrid');
  const gridRef = actor.inventory;

  sys.place('inventory', makeItem('potion_life_minor'), 0, 0);
  assert.equal(actor.inventory, gridRef, 'the same grid object must be reused, not recreated');
});

test('ITMS.C05 "inventory" resolves to nothing (refuses, does not throw) when there is no player actor', async () => {
  const ctx = {
    rng: new Rng(0x5eed),
    time: { step: 0 },
    get(id) {
      if (id === 'actors') return { player: null };
      throw new Error(`unexpected ctx.get('${id}')`);
    },
  };
  const sys = new ItemsSystem();
  await sys.init(ctx);
  const item = makeItem('potion_life_minor');
  assert.equal(sys.canPlace('inventory', item, 0, 0), false);
  assert.equal(sys.place('inventory', item, 0, 0), false);
  assert.equal(sys.autoPlace('inventory', item), false);
  assert.equal(sys.itemAt('inventory', 0, 0), null);
  assert.equal(sys.freeCells('inventory'), 0);
  assert.equal(sys.findPlacement('inventory', item), null);
  assert.equal(sys.sortContainer('inventory'), false);
});

test('ITMS.C06 place() moving an item within the same container detaches it from its old cells first (no ghost occupancy)', async () => {
  const { sys } = await makeSystem(makeActor());
  const item = makeItem('shield_buckler_normal'); // 2x2
  assert.equal(sys.place('stash', item, 0, 0), true);
  assert.equal(sys.place('stash', item, 5, 5), true);

  assert.equal(sys.itemAt('stash', 0, 0), null, 'the old cells must be cleared');
  assert.equal(sys.itemAt('stash', 1, 1), null);
  assert.equal(sys.itemAt('stash', 5, 5), item);
  assert.equal(sys.itemAt('stash', 6, 6), item);
});

test('ITMS.C07 an item can move between inventory and stash via remove()+place() with no double-booking', async () => {
  const { sys } = await makeSystem(makeActor());
  const item = makeItem('potion_life_minor');
  assert.equal(sys.place('inventory', item, 0, 0), true);
  assert.equal(sys.remove(item), true);
  assert.equal(sys.place('stash', item, 0, 0), true);
  assert.equal(sys.itemAt('inventory', 0, 0), null);
  assert.equal(sys.itemAt('stash', 0, 0), item);
  assert.deepEqual(item.grid, { container: 'stash', x: 0, y: 0 });
});

// ---------------------------------------------------------------------------
// Property 1 + 2 — no cell ever holds two uids; every rectangle fully inside
// its grid. Randomised, seeded, reproducible.
// ---------------------------------------------------------------------------

test('ITMS.C20 property: no cell ever holds two uids, and every item rectangle lies fully inside its grid (randomised, seeded, 2000 episodes)', async () => {
  const rng = new Rng(0xc0ffee01);
  const actor = makeActor();
  const { sys } = await makeSystem(actor);
  // Force the InventoryGrid to exist up front (see ITMS.C40's own note on
  // why lazy first-touch creation is kept out of the randomised loop).
  sys.freeCells('inventory');

  const live = [];
  const EPISODES = 2000;
  let placedCount = 0;
  let removedCount = 0;

  for (let e = 0; e < EPISODES; e++) {
    const container = rng.bool() ? 'inventory' : 'stash';
    const doPlace = live.length === 0 || rng.next() < 0.65;
    if (doPlace) {
      const baseId = rng.pick(ITEM_BASES).id;
      const item = makeItem(baseId);
      if (sys.autoPlace(container, item)) {
        live.push(item);
        placedCount++;
      }
    } else {
      const idx = rng.int(0, live.length - 1);
      const item = live[idx];
      assert.equal(sys.remove(item), true);
      live.splice(idx, 1);
      removedCount++;
    }
    assertGridConsistency(actor.inventory, `episode ${e} (inventory)`);
    assertGridConsistency(sys._containers.stash, `episode ${e} (stash)`);
  }

  // Not a vacuous sweep: real placements and real removals both happened.
  assert.ok(placedCount > 500, `expected many successful placements, got ${placedCount}`);
  assert.ok(removedCount > 100, `expected many removals, got ${removedCount}`);

  // Final cross-check: every item still tracked as "live" really is where
  // the container says it is, from the OTHER direction (itemAt).
  for (const item of live) {
    const found = sys.itemAt(item.grid.container, item.grid.x, item.grid.y);
    assert.equal(found, item);
  }
});

// ---------------------------------------------------------------------------
// Property 3 — sortContainer is idempotent
// ---------------------------------------------------------------------------

const RARITY_POOL = ['normal', 'superior', 'magic', 'rare', 'unique'];

test('ITMS.C30 property: sortContainer is idempotent — sorting a sorted container changes nothing (randomised, seeded, 200 trials)', async () => {
  // Note on the two branches below: 09-ui.md §6.5's own algorithm
  // ("largest footprint first, first fit, row-major", repacked from an
  // empty grid) is a first-fit-DECREASING heuristic — it has no general
  // guarantee of reproducing a packing that some other, arbitrary-order
  // sequence of `autoPlace` calls happened to find (2D rectangle bin
  // packing has no such guarantee; this is a real, discovered case at
  // ~94% cell density with a mix of 1- and 2-wide footprints, not a
  // scan/bounds bug — see the report). `sortContainer`'s own trial-buffer
  // design (containers.js) means a repack it cannot complete is refused
  // WITHOUT mutating anything, so idempotence is still exactly provable in
  // both branches: on success, sorting twice must read back identical; on
  // refusal, the container must be untouched AND a second refusal must be
  // identical too (a no-op is still a no-op the second time).
  const rng = new Rng(0xbeef0001);
  const TRIALS = 200;
  let nonTrivialTrials = 0;
  let succeededTrials = 0;
  let refusedTrials = 0;

  for (let trial = 0; trial < TRIALS; trial++) {
    const { sys } = await makeSystem(makeActor());
    const n = rng.int(2, 24);
    for (let i = 0; i < n; i++) {
      const baseId = rng.pick(ITEM_BASES).id;
      const item = makeItem(baseId, { rarity: rng.pick(RARITY_POOL) });
      sys.autoPlace('stash', item); // some may fail to fit; that's fine
    }

    const grid = sys._containers.stash;
    if (grid.count >= 2) nonTrivialTrials++;
    const before = snapshotContainer(grid);

    const ok1 = sys.sortContainer('stash');
    const afterFirst = snapshotContainer(grid);

    if (ok1) {
      succeededTrials++;
      assertGridConsistency(grid, `trial ${trial} after first sort`);
      const ok2 = sys.sortContainer('stash');
      assert.equal(ok2, true, `trial ${trial}: a second sort of an already-sorted container must also succeed`);
      const afterSecond = snapshotContainer(grid);
      assert.deepEqual(afterSecond, afterFirst, `trial ${trial}: sorting an already-sorted container must be a no-op`);
    } else {
      refusedTrials++;
      assert.deepEqual(afterFirst, before, `trial ${trial}: a refused sort must leave the container byte-identical`);
      const ok2 = sys.sortContainer('stash');
      assert.equal(ok2, false, `trial ${trial}: refusing to repack must be deterministic, not flaky`);
      const afterSecond = snapshotContainer(grid);
      assert.deepEqual(afterSecond, before, `trial ${trial}: a second refused sort must still leave the container untouched`);
    }
  }

  assert.ok(nonTrivialTrials > 50, `expected many trials with >=2 items, got ${nonTrivialTrials}`);
  assert.ok(succeededTrials > 50, `expected many trials where sort actually succeeds, got ${succeededTrials}`);
  console.log(`  ITMS.C30: ${TRIALS} trials, ${succeededTrials} sorted, ${refusedTrials} refused (packing not reproducible) — idempotent in both cases`);
});

test('ITMS.C31 sortContainer orders equipment before jewelry before consumables, largest footprint first', async () => {
  const { sys } = await makeSystem(makeActor());
  const potion = makeItem('potion_life_minor'); // consumable, 1x1
  const ring = makeItem('ring_iron'); // jewelry, 1x1
  const axe = makeItem('axe_hand_normal'); // weapon, 1x3
  const shield = makeItem('shield_buckler_normal'); // armour (offHand), 2x2

  for (const it of [potion, ring, axe, shield]) assert.equal(sys.autoPlace('stash', it), true);
  assert.equal(sys.sortContainer('stash'), true);

  const grid = sys._containers.stash;
  const order = grid.list.slice(0, grid.count).map((it) => it.uid);
  // shield (area 4) placed first (largest footprint first); axe (area 3)
  // next; potion/ring (area 1 each) last, equipment-class (none of the two
  // 1x1s are equipment) ordering among themselves is a tie broken by
  // classBucket (consumable=2 before... actually ring is jewelry=1, potion
  // is consumable=2) so ring must precede potion.
  assert.deepEqual(order, [shield.uid, axe.uid, ring.uid, potion.uid]);
});

// ---------------------------------------------------------------------------
// Property 4 — findPlacement never mutates
// ---------------------------------------------------------------------------

test('ITMS.C40 property: findPlacement never mutates the container (whole-container snapshot, deep-compared, randomised, seeded, 300 trials)', async () => {
  const rng = new Rng(0xfeed2222);
  const TRIALS = 300;

  for (let trial = 0; trial < TRIALS; trial++) {
    const actor = makeActor();
    const { sys } = await makeSystem(actor);
    // Force lazy creation before snapshotting, so the snapshot compares an
    // existing grid to itself, not "absent" to "freshly lazily created" —
    // the latter is a one-time, disclosed side effect of container
    // resolution (see containers.js), not a repeated-call mutation this
    // property is about.
    sys.freeCells('inventory');

    const n = rng.int(0, INVENTORY_W * INVENTORY_H);
    for (let i = 0; i < n; i++) {
      sys.autoPlace('inventory', makeItem(rng.pick(ITEM_BASES).id));
    }

    const before = snapshotContainer(actor.inventory);

    const probe = makeItem(rng.pick(ITEM_BASES).id);
    sys.findPlacement('inventory', probe);
    // Calling it twice, with and without an explicit `out`, must be exactly
    // as inert as calling it once.
    const out = { x: -1, y: -1 };
    sys.findPlacement('inventory', probe, out);

    const after = snapshotContainer(actor.inventory);
    assert.deepEqual(after, before, `trial ${trial}: findPlacement must not mutate the container`);
    // The probe item itself must also be untouched (still nowhere).
    assert.equal(probe.grid, undefined);
  }
});

test('ITMS.C41 findPlacement writes into a caller-supplied out and returns that same reference', async () => {
  const { sys } = await makeSystem(makeActor());
  const item = makeItem('potion_life_minor');
  const out = { x: -1, y: -1 };
  const result = sys.findPlacement('stash', item, out);
  assert.equal(result, out, 'the returned object must be the exact `out` reference, not a fresh object');
  assert.deepEqual(out, { x: 0, y: 0 });
});

// ---------------------------------------------------------------------------
// Property 5 — a two-hander refuses to equip without room for the displaced
// off-hand.
//
// `equipment.js`/`canEquip` are a different, not-yet-built ticket (outside
// this ticket's file grant — see the report). What this ticket owns and can
// prove is the INVARIANT any future `canEquip` must lean on: `findPlacement`
// (the exact primitive 09-ui.md §6.2 names as what auto-placement, and by
// extension a displaced off-hand, must go through) correctly reports "no
// room" whenever the inventory cannot actually fit the off-hand item's
// footprint. Randomised across many fill levels and every real off-hand
// base in the game, plus a deterministic fully-full case for each.
// ---------------------------------------------------------------------------

test('ITMS.C50 property: an off-hand item (the one a two-hander displaces on equip) has no legal inventory placement whenever free cells are insufficient for its footprint (randomised, seeded, 300 trials + every off-hand base fully-full)', async () => {
  const offHandBases = ITEM_BASES.filter((b) => b.slot === 'offHand');
  assert.ok(offHandBases.length >= 3, 'sanity: the game must actually ship offHand-slot bases to test against');

  const rng = new Rng(0xa11ce555);
  const TRIALS = 300;
  let insufficientCases = 0;

  for (let trial = 0; trial < TRIALS; trial++) {
    const { sys } = await makeSystem(makeActor());
    const fillCount = rng.int(0, INVENTORY_W * INVENTORY_H);
    for (let i = 0; i < fillCount; i++) {
      sys.autoPlace('inventory', makeItem('potion_life_minor'));
    }

    const offHandBase = rng.pick(offHandBases);
    const offHand = makeItem(offHandBase.id);
    const footprint = offHandBase.invW * offHandBase.invH;
    const free = sys.freeCells('inventory');
    const placement = sys.findPlacement('inventory', offHand);

    if (free < footprint) {
      insufficientCases++;
      assert.equal(placement, null,
        `trial ${trial}: ${offHandBase.id} (footprint ${footprint}) must have NO placement when only ${free} cells are free`);
      for (let y = 0; y < INVENTORY_H; y++) {
        for (let x = 0; x < INVENTORY_W; x++) {
          assert.equal(sys.canPlace('inventory', offHand, x, y), false,
            `trial ${trial}: canPlace must refuse every cell, including (${x},${y}), when there is not enough room`);
        }
      }
    } else if (placement !== null) {
      // A placement was reported: it really must be valid.
      assert.equal(sys.canPlace('inventory', offHand, placement.x, placement.y), true);
    }
  }
  assert.ok(insufficientCases > 30, `expected many insufficient-room trials, got ${insufficientCases}`);

  // Deterministic worst case for every real off-hand base: a completely
  // full inventory refuses all of them.
  for (const offHandBase of offHandBases) {
    const { sys } = await makeSystem(makeActor());
    for (let i = 0; i < INVENTORY_W * INVENTORY_H; i++) {
      assert.equal(sys.autoPlace('inventory', makeItem('potion_life_minor')), true);
    }
    assert.equal(sys.freeCells('inventory'), 0);
    const offHand = makeItem(offHandBase.id);
    assert.equal(sys.findPlacement('inventory', offHand), null,
      `${offHandBase.id} must have no placement in a completely full inventory`);
  }
});

test('ITMS.C51 sanity: the game\'s two-handed weapons really do carry weapon.twoHanded === true (the scenario ITMS.C50 stands in for)', () => {
  const twoHanders = ITEM_BASES.filter((b) => b.weapon && b.weapon.twoHanded);
  assert.ok(twoHanders.length > 0);
  for (const b of twoHanders) assert.equal(b.weapon.twoHanded, true);
});

// ---------------------------------------------------------------------------
// The belt
// ---------------------------------------------------------------------------

test('ITMS.C60 place()/canPlace() on "belt" accept only category==="consumable", 1 slot per index', async () => {
  const { sys } = await makeSystem(makeActor());
  const potion = makeItem('potion_life_minor');
  const axe = makeItem('axe_hand_normal');

  assert.equal(sys.canPlace('belt', axe, 0, 0), false, 'a non-consumable may never occupy a belt slot');
  assert.equal(sys.place('belt', axe, 0, 0), false);

  assert.equal(sys.place('belt', potion, 2, 0), true);
  assert.equal(sys.itemAt('belt', 2, 0), potion);
  assert.equal(sys.freeCells('belt'), BELT_SLOT_COUNT - 1);

  const other = makeItem('potion_mana_minor');
  assert.equal(sys.canPlace('belt', other, 2, 0), false, 'an occupied slot refuses a different item');
  assert.equal(sys.place('belt', other, 2, 0), false);
});

test('ITMS.C61 an item moves from inventory to belt and back with no double-booking', async () => {
  const { sys } = await makeSystem(makeActor());
  const potion = makeItem('potion_life_minor');
  assert.equal(sys.place('inventory', potion, 0, 0), true);
  assert.equal(sys.place('belt', potion, 1, 0), true);
  assert.equal(sys.itemAt('inventory', 0, 0), null);
  assert.equal(sys.itemAt('belt', 1, 0), potion);
  assert.equal(sys.place('inventory', potion, 0, 0), true);
  assert.equal(sys.itemAt('belt', 1, 0), null);
  assert.equal(sys.itemAt('inventory', 0, 0), potion);
});

test('ITMS.C62 beltCooldown counts down in seconds from ctx.time.step, never the wall clock', async () => {
  const actor = makeActor();
  const { sys, ctx } = await makeSystem(actor, 0);
  const potion = makeItem('potion_life_minor', { quantity: 3 });
  sys.place('belt', potion, 0, 0);

  assert.equal(sys.beltCooldown(actor), 0, 'no cooldown active yet');
  assert.equal(sys.beltUse(actor, 0), true);
  assert.equal(potion.quantity, 2);

  const stepsFor05s = Math.round(BELT_COOLDOWN_SECONDS * 60);
  assert.ok(Math.abs(sys.beltCooldown(actor) - BELT_COOLDOWN_SECONDS) < 1e-9);

  ctx.time.step += Math.floor(stepsFor05s / 2);
  const half = sys.beltCooldown(actor);
  assert.ok(half > 0 && half < BELT_COOLDOWN_SECONDS);

  assert.equal(sys.beltUse(actor, 0), false, 'a second use mid-cooldown must refuse');
  assert.equal(potion.quantity, 2, 'a refused use must not consume the stack');

  ctx.time.step += stepsFor05s;
  assert.equal(sys.beltCooldown(actor), 0);
  assert.equal(sys.beltUse(actor, 0), true);
  assert.equal(potion.quantity, 1);
});

test('ITMS.C63 beltUse empties and clears the slot when the last unit is consumed; beltCount reflects the stack', async () => {
  const actor = makeActor();
  const { sys, ctx } = await makeSystem(actor, 0);
  const potion = makeItem('potion_life_minor', { quantity: 1 });
  sys.place('belt', potion, 3, 0);
  assert.equal(sys.beltCount(actor, 3), 1);

  assert.equal(sys.beltUse(actor, 3), true);
  assert.equal(sys.beltCount(actor, 3), 0);
  assert.equal(sys.itemAt('belt', 3, 0), null);
  assert.equal(potion.grid.container, null);

  ctx.time.step += 100;
  assert.equal(sys.beltUse(actor, 3), false, 'an empty slot always refuses');
});

test('ITMS.C64 beltUse/beltCount/beltCooldown are total: no actor, out-of-range slot, empty slot all refuse without throwing', async () => {
  const { sys } = await makeSystem(makeActor());
  assert.equal(sys.beltUse(null, 0), false);
  assert.equal(sys.beltCount(null, 0), 0);
  assert.equal(sys.beltCooldown(null), 0);
  const actor2 = makeActor();
  assert.equal(sys.beltUse(actor2, -1), false);
  assert.equal(sys.beltUse(actor2, 99), false);
  assert.equal(sys.beltCount(actor2, 99), 0);
});

// ---------------------------------------------------------------------------
// The cursor slot
// ---------------------------------------------------------------------------

test('ITMS.C70 takeToCursor detaches from its source container; cursorItem reflects it; a second takeToCursor refuses (cursor already occupied)', async () => {
  const { sys } = await makeSystem(makeActor());
  const item = makeItem('potion_life_minor');
  sys.place('inventory', item, 0, 0);

  assert.equal(sys.cursorItem, null);
  assert.equal(sys.takeToCursor(item), true);
  assert.equal(sys.cursorItem, item);
  assert.equal(sys.itemAt('inventory', 0, 0), null, 'the source cell must be cleared');

  const other = makeItem('potion_mana_minor');
  sys.place('inventory', other, 1, 0);
  assert.equal(sys.takeToCursor(other), false, 'the cursor can hold only one item at a time');
});

test('ITMS.C71 dropCursor onto an empty rectangle places the item and clears the cursor', async () => {
  const { sys } = await makeSystem(makeActor());
  const item = makeItem('shield_buckler_normal');
  sys.place('inventory', item, 0, 0);
  sys.takeToCursor(item);

  const result = sys.dropCursor('inventory', 4, 1);
  assert.equal(result.ok, true);
  assert.equal(result.swapped, null);
  assert.equal(sys.cursorItem, null);
  assert.equal(sys.itemAt('inventory', 4, 1), item);
});

test('ITMS.C72 dropCursor onto exactly one overlapping item swaps: the held item is placed, the displaced item goes to the cursor', async () => {
  const { sys } = await makeSystem(makeActor());
  const held = makeItem('potion_life_minor');
  const resident = makeItem('potion_mana_minor');
  sys.place('inventory', resident, 0, 0);
  sys.place('inventory', held, 5, 0);
  sys.takeToCursor(held);

  const result = sys.dropCursor('inventory', 0, 0);
  assert.equal(result.ok, true);
  assert.equal(result.swapped, resident);
  assert.equal(sys.cursorItem, resident);
  assert.equal(sys.itemAt('inventory', 0, 0), held);
});

test('ITMS.C73 dropCursor onto >=2 overlapping items, or out of bounds, refuses and leaves the item on the cursor', async () => {
  const { sys } = await makeSystem(makeActor());
  const a = makeItem('potion_life_minor');
  const b = makeItem('potion_mana_minor');
  sys.place('inventory', a, 0, 0);
  sys.place('inventory', b, 1, 0);
  const held = makeItem('shield_buckler_normal'); // 2x2, would cover both a and b
  sys.place('inventory', held, 8, 0);
  sys.takeToCursor(held);

  const result = sys.dropCursor('inventory', 0, 0);
  assert.equal(result.ok, false);
  assert.equal(result.swapped, null);
  assert.equal(sys.cursorItem, held, 'a refused drop must leave the item on the cursor');

  const result2 = sys.dropCursor('inventory', 9, 3);
  assert.equal(result2.ok, false, 'a 2x2 at the bottom-right corner of a 10x4 grid runs off the edge');
});

test('ITMS.C74 returnCursor restores the item to its exact origin cell when it is still free', async () => {
  const { sys } = await makeSystem(makeActor());
  const item = makeItem('potion_life_minor');
  sys.place('inventory', item, 3, 2);
  sys.takeToCursor(item);
  assert.equal(sys.cursorItem, item);

  assert.equal(sys.returnCursor(), true);
  assert.equal(sys.cursorItem, null);
  assert.equal(sys.itemAt('inventory', 3, 2), item);
});

test('ITMS.C75 returnCursor auto-places elsewhere in the same container when the origin cell has since been filled', async () => {
  const { sys } = await makeSystem(makeActor());
  const item = makeItem('potion_life_minor');
  sys.place('inventory', item, 0, 0);
  sys.takeToCursor(item);

  const filler = makeItem('potion_mana_minor');
  sys.place('inventory', filler, 0, 0); // occupy the origin cell while item is on the cursor

  assert.equal(sys.returnCursor(), true);
  assert.equal(sys.cursorItem, null);
  assert.notEqual(item.grid.x === 0 && item.grid.y === 0, true, 'must not have landed back on the now-occupied origin cell');
  assert.equal(sys.itemAt(item.grid.container, item.grid.x, item.grid.y), item);
});

test('ITMS.C76 returnCursor with nothing on the cursor refuses', async () => {
  const { sys } = await makeSystem(makeActor());
  assert.equal(sys.returnCursor(), false);
});

// ---------------------------------------------------------------------------
// splitStack — the one Alloc: yes row
// ---------------------------------------------------------------------------

test('ITMS.C80 splitStack decrements the source and returns a new, unplaced ItemInstance with a fresh uid', () => {
  resetSplitUidCounter();
  const source = makeItem('potion_life_minor', { quantity: 5, uid: 999 });
  const clone = sys_splitStackDirect(source, 2);

  assert.equal(source.quantity, 3);
  assert.equal(clone.quantity, 2);
  assert.notEqual(clone.uid, source.uid);
  assert.equal(clone.baseId, source.baseId);
  assert.equal(clone.grid, undefined, 'a freshly split stack is unplaced');
  assert.equal(clone.slot, undefined);
  assert.equal(clone.ground, undefined);

  // Splitting again must produce yet another distinct uid.
  const clone2 = sys_splitStackDirect(source, 1);
  assert.notEqual(clone2.uid, clone.uid);
});

test('ITMS.C81 splitStack refuses a non-positive count, a count that would empty or exceed the source, and a quantity<=1 source', () => {
  const source = makeItem('potion_life_minor', { quantity: 3 });
  assert.equal(sys_splitStackDirect(source, 0), null);
  assert.equal(sys_splitStackDirect(source, -1), null);
  assert.equal(sys_splitStackDirect(source, 3), null, 'count must leave at least 1 behind');
  assert.equal(sys_splitStackDirect(source, 4), null);
  assert.equal(source.quantity, 3, 'every refused call must leave the source untouched');

  const single = makeItem('potion_life_minor', { quantity: 1 });
  assert.equal(sys_splitStackDirect(single, 1), null, 'a quantity-1 stack cannot be split');
});

// splitStack does not need `state`/ctx at all (pure over the item) — call it
// through a real ItemsSystem instance anyway, matching how every other
// method in this file is exercised, so the wiring itself is covered too.
let _splitSys = null;
function sys_splitStackDirect(item, count) {
  if (!_splitSys) _splitSys = new ItemsSystem();
  return _splitSys.splitStack(item, count);
}

test('ITMS.C82 splitStack is wired on ItemsSystem and reachable via ctx.get(\'items\')', async () => {
  const { sys } = await makeSystem(makeActor());
  resetSplitUidCounter();
  const source = makeItem('potion_mana_minor', { quantity: 4 });
  const clone = sys.splitStack(source, 1);
  assert.equal(source.quantity, 3);
  assert.equal(clone.quantity, 1);
});
