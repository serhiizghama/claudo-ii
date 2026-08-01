// tests/items/ground.test.js
//
// ITEM-12 acceptance tests for src/items/ground.js (ground items:
// placement, the budget-capped registry, decay, pickup), as wired onto
// `ItemsSystem` (src/items/index.js). `node:test` + `node:assert/strict`
// only, matching every sibling test file in this repo.
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief):
//   1. `q.groundItemBudget` is respected — the configured ceiling on
//      simultaneously-present ground items actually caps them, oldest-first
//      eviction, rare/unique exempt from BUDGET eviction (not from decay).
//   2. `actor:damage` resets the fresh-drop grace period — driven through a
//      real `ctx.events.emit`, not by calling an internal method directly.
//      Round 2 correction: a fresh drop is a THIRD exemption class
//      alongside rare/unique (`ITMS.G21`), eviction still runs oldest-first
//      and only refuses when nothing at all is evictable (`ITMS.G22`) — see
//      `src/items/ground.js`'s own header for the full ruling.
//   3. Ground scatter's two draws (D15) are taken and discarded inside
//      `rollDrop` already (ITEM-9) and this ticket must not break or
//      duplicate that — proven by measuring that neither a container
//      placement nor `dropToGround` consumes any further items-stream draw
//      on top of what `rollDrop` already spent, and structurally, that this
//      ticket's own code never touches the RNG at all.
//   4. An item is in exactly one location after any successful location
//      change — cursor, a container, an equipment slot, or the ground —
//      never two at once, and never a lost move kind either. Round 3 fixed
//      a real duplication bug the orchestrator found at the `dropToGround`
//      wiring seam (dropping the CURSOR item straight to the ground used
//      to leave it referenced by both `./containers.js`'s cursor slot and
//      `./ground.js`'s registry at once, because `ItemsSystem#remove` only
//      vacates a grid container, never the cursor) by refusing the drop —
//      which the orchestrator then correctly rejected, because `09-ui.md`
//      §6.6 declares `inventory -> ground` as `dropToGround` and every
//      drag goes through the cursor (§6.4), so refusing removed the only
//      way to drop an item on the ground by dragging at all. Round 4's
//      real fix, `./containers.js#releaseCursor` (additive, module-level
//      only, not attached to `ItemsSystem`), releases the cursor and lets
//      the drop succeed. See `ITMS.G60`-`ITMS.G62` and
//      `src/items/index.js#dropToGround`'s own updated comment.
//
// NOT tested here (owned by other, not-yet-built tickets, per this ticket's
// own brief — O-27/O-39, never asserted as "does not exist yet", simply not
// exercised): the actual scatter-angle/radius/nav-snap math that turns a
// kill point into the `(x,z)` this file's `dropToGround` receives (the
// monster-death wiring, not built in this tree), `byUid` (uid -> item
// resolution for a label click), and the UI-11 ground-item label system
// (M6) that reads `item.ground`/the fresh-drop window for its own,
// separate, UI-owned purpose.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';
import { ItemsSystem } from '../../src/items/index.js';
import { CountingRng } from '../../src/items/rng.js';
import { rollDrop, resetUidCounter } from '../../src/items/drop.js';
import { resetRareRing } from '../../src/items/names.js';
import { GROUND_FRESH_GRACE_SECONDS, GROUND_HARD_TIMEOUT_SECONDS } from '../../src/items/ground.js';

const GRACE_STEPS = Math.round(GROUND_FRESH_GRACE_SECONDS * 60);
const HARD_TIMEOUT_STEPS = Math.round(GROUND_HARD_TIMEOUT_SECONDS * 60);

// ---------------------------------------------------------------------------
// Test fixtures — a real EventBus (acceptance clause 2 needs a genuine
// `ctx.events.emit`, not a stub), a mutable `ctx.time.step`, and a minimal
// `actors`/`physics` stub reached through `get`/`peek`, matching the
// precedent tests/items/containers.test.js and tests/items/accessors.test.js
// already set for this directory.
// ---------------------------------------------------------------------------

let _seed = 1;

function makeCtx({ groundItemBudget, playerActor, physics, step = 0 } = {}) {
  const config = groundItemBudget === undefined ? {} : { q: { groundItemBudget } };
  return {
    rng: new Rng(_seed++),
    events: new EventBus(),
    time: { step },
    config,
    get(id) {
      if (id === 'actors') return { player: playerActor };
      throw new Error(`stub ctx.get: '${id}' is not available in this test`);
    },
    peek(id) {
      if (id === 'actors') return { player: playerActor };
      if (id === 'physics') return physics || null;
      return null;
    },
  };
}

function makeActor() {
  return { kind: 'player', inventory: null, belt: null };
}

async function makeSystem(opts = {}) {
  const sys = new ItemsSystem();
  const actor = opts.playerActor || makeActor();
  const ctx = makeCtx({ ...opts, playerActor: actor });
  await sys.init(ctx);
  return { sys, ctx, actor };
}

let _uid = 1;
function makeItem(baseId, rarity, overrides = {}) {
  return {
    uid: overrides.uid ?? _uid++,
    baseId,
    rarity,
    ilvl: 1,
    identified: true,
    quantity: 1,
    rolls: { defense: 0, superior: 0, damageMin: 0, damageMax: 0 },
    affixes: [],
    uniqueId: null,
    uniqueValues: [],
    nameOverride: null,
    durability: 0,
    maxDurability: 0,
    sockets: [],
    socketCount: 0,
    grid: null,
    slot: null,
    ground: null,
    ...overrides,
  };
}

/**
 * ITEM-12 round 3 — the general "exactly one location" invariant
 * (`01-data-model.md` §5.3: "exactly one of grid/slot/ground is non-null",
 * plus the cursor, `02-api-contracts.md` §16.2's own separate canonical
 * slot). Cross-checks each subsystem's own live state rather than trusting
 * a single field on `item` — the round-3 bug (an item on the cursor AND in
 * the ground registry at once) would NOT have been caught by reading
 * `item.ground`/`item.grid` alone, since `dropToGroundPure` sets
 * `item.ground` correctly; the duplication only showed up in
 * `containers.js`'s cursor state, which this helper checks independently
 * via the real `groundItemsNear`/`cursorItem` surface, the same way
 * SAVE-1 will have to reconcile membership across subsystems. `out` is
 * sized well past every budget used in this file.
 * @param {import('../../src/items/index.js').ItemsSystem} sys
 * @param {object} item
 * @returns {number}
 */
function locationCount(sys, item) {
  let n = 0;
  if (sys.cursorItem === item) n++;
  if (item.grid && item.grid.container) n++;
  if (item.slot) n++;
  const out = new Array(300).fill(null);
  const found = sys.groundItemsNear(0, 0, 1e9, out);
  for (let i = 0; i < found; i++) {
    if (out[i] === item) { n++; break; }
  }
  return n;
}

test('ITMS.G00 loads headless in plain Node with no browser globals', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
});

// ---------------------------------------------------------------------------
// Basic dropToGround / groundItemsNear behaviour
// ---------------------------------------------------------------------------

test('ITMS.G01 dropToGround stamps item.ground and groundItemsNear finds it inside its radius, not outside', async () => {
  const { sys } = await makeSystem({ groundItemBudget: 96, step: 100 });
  const item = makeItem('ring_iron', 'normal');

  sys.dropToGround(item, 10, 20);
  assert.ok(item.ground, 'dropToGround must set item.ground');
  assert.equal(item.ground.x, 10);
  assert.equal(item.ground.z, 20);
  assert.equal(item.ground.droppedAtStep, 100);
  assert.equal(item.ground.expiresAtStep, 100 + HARD_TIMEOUT_STEPS);
  assert.equal(item.grid, null, 'a ground item is not in a container');
  assert.equal(item.slot, null);

  const out = new Array(8).fill(null);
  const insideCount = sys.groundItemsNear(10, 20, 1, out);
  assert.equal(insideCount, 1);
  assert.equal(out[0], item);

  const exactPointCount = sys.groundItemsNear(10, 20, 0.001, out);
  assert.equal(exactPointCount, 1, 'the exact drop point is always inside any positive radius');

  const farCount = sys.groundItemsNear(1000, 1000, 5, out);
  assert.equal(farCount, 0, 'an item outside the query radius must not be returned');
});

test('ITMS.G02 groundItemsNear uses squared ground-plane distance (x/z only) and never exceeds out.length (D7 truncation)', async () => {
  const { sys } = await makeSystem({ groundItemBudget: 96 });
  for (let i = 0; i < 5; i++) {
    sys.dropToGround(makeItem('ring_iron', 'normal'), i, 0);
  }
  const out = new Array(2).fill(null);
  const count = sys.groundItemsNear(0, 0, 100, out);
  assert.equal(count, 2, 'count must never exceed out.length, even with more matches available');
  assert.ok(out[0] && out[1]);
});

// ---------------------------------------------------------------------------
// Acceptance clause 1 — q.groundItemBudget is respected
// ---------------------------------------------------------------------------

test('ITMS.G10 (acceptance 1) q.groundItemBudget caps the registry — oldest normal-rarity item is evicted first', async () => {
  const { sys, ctx } = await makeSystem({ groundItemBudget: 3 });
  const items = [];
  for (let i = 0; i < 5; i++) {
    ctx.time.step = i * 1000; // distinct droppedAtStep, strictly increasing
    const item = makeItem('ring_iron', 'normal');
    items.push(item);
    sys.dropToGround(item, i, 0);
  }

  const out = new Array(10).fill(null);
  const count = sys.groundItemsNear(0, 0, 1000, out);
  assert.equal(count, 3, 'the registry must never hold more than q.groundItemBudget entries');

  assert.equal(items[0].ground, null, 'the oldest item must have been evicted');
  assert.equal(items[1].ground, null, 'the second-oldest item must have been evicted');
  assert.ok(items[2].ground, 'the third-oldest (now oldest surviving) item must remain');
  assert.ok(items[3].ground);
  assert.ok(items[4].ground, 'the newest item must remain');
});

test('ITMS.G11 (acceptance 1) rare/unique items are exempt from BUDGET eviction', async () => {
  const { sys, ctx } = await makeSystem({ groundItemBudget: 2 });
  ctx.time.step = 0;
  const unique = makeItem('ring_iron', 'unique');
  sys.dropToGround(unique, 0, 0);
  ctx.time.step = 1;
  const rare = makeItem('ring_iron', 'rare');
  sys.dropToGround(rare, 1, 0);

  // Budget is now full (2/2), both entries exempt from budget eviction. A
  // third, ordinary drop has nothing evictable to make room for it and must
  // be refused (the pool "does not grow — it refuses", 01-data-model.md §11)
  // rather than culling an exempt item.
  ctx.time.step = 2;
  const normal = makeItem('ring_iron', 'normal');
  sys.dropToGround(normal, 2, 0);

  assert.ok(unique.ground, 'the unique must survive — exempt from budget eviction');
  assert.ok(rare.ground, 'the rare must survive — exempt from budget eviction');
  assert.equal(normal.ground, null, 'the pool has nothing evictable and must refuse rather than grow past capacity');

  const out = new Array(10).fill(null);
  assert.equal(sys.groundItemsNear(0, 0, 1000, out), 2, 'capacity must never be exceeded');
});

// ---------------------------------------------------------------------------
// Acceptance clause 2 — actor:damage resets the fresh-drop grace period,
// driven through a real event emit, and it has a real functional effect on
// budget eviction (the Listens row's own stated reason for existing).
// ---------------------------------------------------------------------------

test('ITMS.G20 (acceptance 2) emitting actor:damage through ctx.events moves the grace stamp forward by GRACE_STEPS', async () => {
  const { sys, ctx } = await makeSystem({ groundItemBudget: 96 });
  ctx.time.step = 500;
  assert.equal(sys._ground.graceUntilStep, 0, 'no grace is active before any damage event');

  ctx.events.emit('actor:damage', { target: null, source: null, amount: 10, element: 'physical', crit: false, blocked: false, killed: false, point: null });

  assert.equal(sys._ground.graceUntilStep, 500 + GRACE_STEPS, 'actor:damage must overwrite the grace stamp to ctx.time.step + GRACE_STEPS');

  // "Overwrite, not accumulate": a second damage event at a LATER step moves
  // the stamp to that later step's own window, it does not add on top of
  // the first.
  ctx.time.step = 600;
  ctx.events.emit('actor:damage', {});
  assert.equal(sys._ground.graceUntilStep, 600 + GRACE_STEPS);
});

test('ITMS.G21 (acceptance 2, corrected) fresh drops are a THIRD exemption class — eviction still runs oldest-first and skips them, it does not refuse the whole drop; a stale item is evicted even mid-fight, matching 04 §5.8', async () => {
  // Reproduces the orchestrator's own worked example: "the oldest piece of
  // normal junk is evicted and the new drop lands", even while combat (and
  // therefore grace) is still active — NOT "loot stops landing for the
  // whole fight", which was round 1's bug.
  const { sys, ctx } = await makeSystem({ groundItemBudget: 2 });

  ctx.time.step = 0;
  const a = makeItem('ring_iron', 'normal'); // dropped early — will age out of ITS OWN grace
  sys.dropToGround(a, 0, 0);

  // No damage for a while: a's own fresh window (droppedAtStep + GRACE_STEPS)
  // lapses on its own, independent of whether the fight is still going.
  ctx.time.step = GRACE_STEPS + 1;
  const b = makeItem('ring_iron', 'normal'); // dropped just now — freshly protected
  sys.dropToGround(b, 1, 0);

  // Combat is "still running" — a hit lands right after b drops. This must
  // extend b (still inside its own window) without resurrecting a (already
  // stale before this event fired).
  ctx.time.step = GRACE_STEPS + 2;
  ctx.events.emit('actor:damage', {});

  const c = makeItem('ring_iron', 'normal'); // the new drop that needs room
  sys.dropToGround(c, 3, 0);

  assert.equal(a.ground, null, 'a is stale (its own grace lapsed before the damage event) and must be evicted, oldest-first, exactly as 04 §5.8 says — mid-fight or not');
  assert.ok(b.ground, 'b is genuinely fresh (and just extended by actor:damage) and must survive');
  assert.ok(c.ground, 'the new drop must land — eviction happened, it was not refused');
});

test('ITMS.G22 (acceptance 2, rule 4) when every live entry is exempt (rare/unique/fresh) and the registry is full, the new drop is refused — the least-bad, self-healing option', async () => {
  const { sys, ctx } = await makeSystem({ groundItemBudget: 2 });

  // Two items dropped in the same instant — both inside their own fresh
  // window, nothing rare/unique needed to reproduce the jam.
  ctx.time.step = 100;
  const a = makeItem('ring_iron', 'normal');
  const b = makeItem('ring_iron', 'normal');
  sys.dropToGround(a, 0, 0);
  sys.dropToGround(b, 1, 0);

  const c = makeItem('ring_iron', 'normal');
  sys.dropToGround(c, 2, 0);
  assert.equal(c.ground, null, 'nothing is evictable (both live entries are still fresh) — the drop must be refused, not force an eviction');
  assert.ok(a.ground && b.ground, 'both existing entries must be untouched by the refused drop');

  // Self-healing: once a and b's own grace windows lapse (no further
  // actor:damage to extend them), the exact same drop attempt succeeds.
  ctx.time.step = 100 + GRACE_STEPS + 1;
  const d = makeItem('ring_iron', 'normal');
  sys.dropToGround(d, 3, 0);
  assert.ok(d.ground, 'once grace has lapsed for every live entry, the jam clears on its own and the drop succeeds');
  assert.equal(a.ground, null, 'the oldest entry (a) is the one evicted to make room');
  assert.ok(b.ground, 'b survives — a alone was enough to make room');
});

// ---------------------------------------------------------------------------
// Acceptance clause 3 — ground scatter (D15) is taken and discarded inside
// rollDrop already; this ticket's code must not duplicate it or otherwise
// touch the items RNG stream at all.
// ---------------------------------------------------------------------------

test('ITMS.G30 (acceptance 3) neither a straight-to-container placement nor dropToGround consumes any further items-stream draw beyond what rollDrop already spent', async () => {
  resetUidCounter();
  resetRareRing();
  const { sys } = await makeSystem({ groundItemBudget: 96 });
  const counting = new CountingRng(new Rng(0xd15d15));

  function rollOneItem() {
    for (let tries = 0; tries < 200; tries++) {
      const result = sys.rollDrop('tc_humanoid', 15, 'normal', 15, 'instruction', 0, counting);
      if (result.items.length > 0) return result.items[0];
    }
    throw new Error('did not roll a produced item within 200 attempts — treasure-class weights changed?');
  }

  // Path A — the item "goes straight to a container" (D-19's own phrase):
  // never touches dropToGround at all.
  const itemA = rollOneItem();
  const drawsAfterRollA = counting.draws;
  assert.ok(sys.autoPlace('inventory', itemA), 'container placement must succeed on a fresh, empty inventory');
  assert.equal(
    counting.draws,
    drawsAfterRollA,
    'placing a rolled item straight into a container must not consume any items-stream draw',
  );

  // Path B — the item DOES reach the floor, via dropToGround.
  const itemB = rollOneItem();
  const drawsAfterRollB = counting.draws;
  sys.dropToGround(itemB, 3, 4);
  assert.equal(
    counting.draws,
    drawsAfterRollB,
    'dropToGround must not consume any items-stream draw either — the D15 discard already happened inside rollDrop, ground.js must not duplicate it',
  );
  assert.ok(itemB.ground);
});

test('ITMS.G31 (acceptance 3) ground.js never touches the RNG — structural proof, not just an absence of draws', async () => {
  const { sys, ctx } = await makeSystem({ groundItemBudget: 4 });
  // Poison every RNG surface reachable from this system: if any code path
  // under test calls it, the test throws instead of silently reading 0
  // draws for the wrong reason (e.g. a code path that was never reached).
  sys.rng = {
    next() { throw new Error('ground.js must not draw from the items RNG'); },
    int() { throw new Error('ground.js must not draw from the items RNG'); },
    fork() { throw new Error('ground.js must not take a second items fork'); },
  };
  ctx.rng = sys.rng;

  const a = makeItem('ring_iron', 'normal');
  const b = makeItem('ring_iron', 'unique');
  assert.doesNotThrow(() => sys.dropToGround(a, 0, 0));
  assert.doesNotThrow(() => sys.dropToGround(b, 1, 1));
  assert.doesNotThrow(() => {
    const out = new Array(4).fill(null);
    sys.groundItemsNear(0, 0, 10, out);
  });
  assert.doesNotThrow(() => ctx.events.emit('actor:damage', {}));
  assert.doesNotThrow(() => sys.fixedUpdate());
  assert.doesNotThrow(() => sys.pickUp(ctx.get('actors').player, a));
});

// ---------------------------------------------------------------------------
// pickUp
// ---------------------------------------------------------------------------

test('ITMS.G40 pickUp moves a ground item into the inventory and removes it from the registry', async () => {
  const { sys, actor } = await makeSystem({ groundItemBudget: 96 });
  const item = makeItem('ring_iron', 'normal');
  sys.dropToGround(item, 5, 5);
  assert.ok(item.ground);

  const ok = sys.pickUp(actor, item);
  assert.equal(ok, true);
  assert.equal(item.ground, null, 'a picked-up item must no longer be on the ground');
  assert.ok(item.grid && item.grid.container === 'inventory', 'a picked-up item must land in the inventory');

  const out = new Array(4).fill(null);
  assert.equal(sys.groundItemsNear(5, 5, 1, out), 0, 'the registry must no longer report the picked-up item');
});

test('ITMS.G41 pickUp on an item not currently on the ground returns false and does nothing', async () => {
  const { sys, actor } = await makeSystem({ groundItemBudget: 96 });
  const item = makeItem('ring_iron', 'normal');
  assert.equal(sys.pickUp(actor, item), false);
  assert.equal(item.grid, null);
});

test('ITMS.G42 pickUp leaves the item on the ground when the inventory has no room', async () => {
  const { sys, actor } = await makeSystem({ groundItemBudget: 96 });
  // Fill the whole 10x4 inventory with 1x1 items first.
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 10; x++) {
      assert.ok(sys.place('inventory', makeItem('ring_iron', 'normal'), x, y));
    }
  }
  const ground = makeItem('ring_iron', 'normal');
  sys.dropToGround(ground, 0, 0);

  const ok = sys.pickUp(actor, ground);
  assert.equal(ok, false, 'a full inventory must refuse the pickup');
  assert.ok(ground.ground, 'the item must remain on the ground when pickUp fails');
});

// ---------------------------------------------------------------------------
// The 600 s hard timeout (decay), driven from fixedUpdate — rare/unique are
// NOT exempt from this, only from budget eviction.
// ---------------------------------------------------------------------------

test('ITMS.G50 fixedUpdate removes an item once ctx.time.step passes its 600 s expiry, including rare/unique items', async () => {
  const { sys, ctx } = await makeSystem({ groundItemBudget: 96, step: 0 });
  const normal = makeItem('ring_iron', 'normal');
  const unique = makeItem('ring_iron', 'unique');
  sys.dropToGround(normal, 0, 0);
  sys.dropToGround(unique, 1, 1);
  assert.equal(normal.ground.expiresAtStep, HARD_TIMEOUT_STEPS);

  ctx.time.step = HARD_TIMEOUT_STEPS - 1;
  sys.fixedUpdate();
  assert.ok(normal.ground, 'must not expire one step early');
  assert.ok(unique.ground);

  ctx.time.step = HARD_TIMEOUT_STEPS;
  sys.fixedUpdate();
  assert.equal(normal.ground, null, 'normal item must expire exactly at its expiresAtStep');
  assert.equal(unique.ground, null, 'unique items are NOT exempt from the 600s hard timeout, only from budget eviction');

  const out = new Array(4).fill(null);
  assert.equal(sys.groundItemsNear(0, 0, 1000, out), 0);
});

test('ITMS.G51 fixedUpdate leaves un-expired items untouched (no false eviction)', async () => {
  const { sys, ctx } = await makeSystem({ groundItemBudget: 96, step: 0 });
  const item = makeItem('ring_iron', 'normal');
  sys.dropToGround(item, 0, 0);
  for (let s = 1; s <= 100; s++) {
    ctx.time.step = s;
    sys.fixedUpdate();
  }
  assert.ok(item.ground, 'an item well inside its 600s lifetime must survive repeated fixedUpdate calls');
});

// ---------------------------------------------------------------------------
// Acceptance clause 4 (rounds 3-4) — the cursor/ground duplication bug the
// orchestrator found at the dropToGround wiring seam, and the general
// "exactly one location" invariant.
//
// Round 3 fixed the duplication by refusing a cursor-held item outright.
// The orchestrator correctly rejected that: `09-ui.md` §6.6 declares
// `inventory -> ground` as `dropToGround`, every drag goes through the
// cursor by construction (§6.4), so refusing removed the only way to drop
// an item on the ground by dragging at all — a lost, spec'd move kind, not
// a fix. Round 4's real fix is `./containers.js#releaseCursor` (additive,
// module-level only, never attached to `ItemsSystem` — see that file's own
// comment): the cursor is vacated and the drop SUCCEEDS.
// ---------------------------------------------------------------------------

test('ITMS.G60 (regression) dropping the CURSOR item onto the ground succeeds — the cursor is released, not refused, and the item never duplicates', async () => {
  const { sys } = await makeSystem({ groundItemBudget: 96 });
  const item = makeItem('ring_iron', 'normal');
  assert.ok(sys.place('inventory', item, 0, 0));
  assert.ok(sys.takeToCursor(item));
  assert.equal(sys.cursorItem, item);

  sys.dropToGround(item, 5, 5);

  // The round-3 regression this guards against: cursorItem still === item
  // AND item.ground truthy, both at once. The round-1/2 regression this
  // also guards against: refusing instead of dropping (09 §6.6/§6.4 — a
  // drag-to-ground is a real, spec'd move kind, not a permanently blocked
  // one).
  assert.equal(sys.cursorItem, null, 'the cursor must be released once the item has a real new location');
  assert.ok(item.ground, 'the drop must actually succeed — dropping from the cursor is a real move kind (09 §6.4/§6.6)');
  const out = new Array(8).fill(null);
  assert.equal(sys.groundItemsNear(5, 5, 1, out), 1, 'the ground registry must hold it exactly once');
  assert.equal(out[0], item);
  assert.equal(locationCount(sys, item), 1, 'exactly one location — the ground — never both');
});

test('ITMS.G61 (probe, not reading) pickUp never leaves the item registered on the ground AND in the inventory at once', async () => {
  const { sys, actor } = await makeSystem({ groundItemBudget: 96 });
  const item = makeItem('ring_iron', 'normal');
  sys.dropToGround(item, 7, 7);
  assert.equal(locationCount(sys, item), 1, 'exactly one location before pickUp — the ground');

  const ok = sys.pickUp(actor, item);
  assert.equal(ok, true);

  // Probe both sides directly, not by trusting item.ground alone.
  const out = new Array(8).fill(null);
  assert.equal(sys.groundItemsNear(7, 7, 1, out), 0, 'the ground registry must no longer contain it');
  assert.equal(sys.itemAt('inventory', item.grid.x, item.grid.y), item, 'the inventory grid must contain it at its recorded cell');
  assert.equal(locationCount(sys, item), 1, 'exactly one location after pickUp — the inventory, never both');
});

test('ITMS.G62 (general) an item is in exactly one location after every successful location change, across cursor/container/ground transitions, including a direct cursor -> ground drop', async () => {
  const { sys, actor } = await makeSystem({ groundItemBudget: 96 });
  const item = makeItem('ring_iron', 'normal');

  assert.ok(sys.place('inventory', item, 0, 0));
  assert.equal(locationCount(sys, item), 1, 'placed in a container');

  assert.ok(sys.takeToCursor(item));
  assert.equal(locationCount(sys, item), 1, 'taken to the cursor');

  const dropResult = sys.dropCursor('inventory', 1, 0);
  assert.equal(dropResult.ok, true);
  assert.equal(locationCount(sys, item), 1, 'dropped from the cursor back into a container');

  assert.ok(sys.takeToCursor(item));
  assert.equal(locationCount(sys, item), 1, 'taken to the cursor again');

  // The round-4 fix: a drag straight from the cursor to the ground is a
  // real, spec'd move kind (09 §6.4/§6.6) — it must SUCCEED, releasing the
  // cursor and landing on the ground, never leaving two locations at once.
  sys.dropToGround(item, 9, 9);
  assert.equal(locationCount(sys, item), 1, 'cursor -> ground must succeed as exactly one location, not two');
  assert.equal(sys.cursorItem, null, 'the cursor must be released');
  assert.ok(item.ground, 'and the item must actually be on the ground');

  assert.equal(sys.pickUp(actor, item), true);
  assert.equal(locationCount(sys, item), 1, 'picked back up into the inventory');

  // The legitimate container -> ground path (no cursor involved at all)
  // must still work identically.
  assert.ok(sys.takeToCursor(item));
  assert.ok(sys.returnCursor());
  assert.equal(locationCount(sys, item), 1, 'returned from the cursor to its origin container');
  sys.dropToGround(item, 11, 11);
  assert.equal(locationCount(sys, item), 1, 'dropped to the ground from a container — the other legitimate path');
  assert.ok(item.ground);
});
