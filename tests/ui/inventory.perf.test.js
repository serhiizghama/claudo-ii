// tests/ui/inventory.perf.test.js
//
// UI-6's own `Alloc: no` gate for the steady per-frame `update()` path
// (`ARCHITECTURE.md` rule 6), matching every other `.perf.test.js` in this
// tree (D-11: a test asserting an allocation goes here, never in
// `inventory.test.js`). O-43/O-23 methodology, verbatim: N=1e6 and N=4e6,
// judged by the MARGINAL bytes between the two TOTALS — a probe below ~1M
// iterations is noise, not signal. Do NOT run the full `test:perf` suite
// from an agent session that isn't the orchestrator — this file alone, via
// `node --expose-gc --test tests/ui/inventory.perf.test.js`, is fine.
//
// Three steady states probed, matching this ticket's own worst-case shapes:
//   1. panel open, EMPTY inventory — the floor.
//   2. panel open, FULL inventory (40x 1x1 items) — the §13.1 "biggest node
//      consumer in the project" scenario, every item slot change-guarded to
//      a no-op write every frame.
//   3. panel open, mid-drag, steady pointer position (ghost settled at its
//      target, no highlight change) — the drag ghost's `damp()` call runs
//      every frame regardless.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../src/core/rng.js';
import { ItemsSystem } from '../../src/items/index.js';
import { Inventory } from '../../src/ui/inventory.js';
import { el } from '../../src/ui/util.js';
import { allocatedBytes, hasGc } from '../helpers/alloc.js';

let _uid = 1;
function makeItem(baseId, overrides = {}) {
  return {
    uid: _uid++,
    baseId,
    rarity: 'normal',
    ilvl: 1,
    identified: true,
    quantity: overrides.quantity ?? 1,
    rolls: { defense: 0, superior: 0, damageMin: 0, damageMax: 0 },
    affixes: [],
    uniqueId: null,
    uniqueValues: [],
    nameOverride: null,
    durability: 1,
    maxDurability: 1,
    sockets: [],
    socketCount: 0,
  };
}

function makeActor() { return { kind: 'player', inventory: null, belt: null, x: 0, z: 0, gold: 0 }; }

async function makeItemsSystem(actor) {
  const sys = new ItemsSystem();
  const ctx = {
    rng: new Rng(777),
    time: { step: 0 },
    get(id) { if (id === 'actors') return { player: actor }; throw new Error(`n/a: ${id}`); },
  };
  await sys.init(ctx);
  return sys;
}

function makeCanvas(w = 1920, h = 1080) { return { width: w, height: h, addEventListener() {}, removeEventListener() {} }; }

function makePlayerStub(actor) {
  // Zero-allocation no-`out` fallback, matching the real
  // `PlayerSystem#hudState`'s own preallocated `_hudScratch` precedent —
  // `inventory.js` calls this with no argument every frame, so a fresh `{}`
  // literal here would falsely show up as this test's own allocation, not
  // `Inventory#update`'s.
  const scratch = { gold: 0 };
  return {
    actor,
    hudState(out) {
      const dst = out || scratch;
      dst.gold = actor.gold || 0;
      return dst;
    },
  };
}

function makeUiCtx(items, player) {
  return {
    canvas: makeCanvas(),
    get(id) { if (id === 'items') return items; if (id === 'player') return player; return null; },
    has(id) { return id === 'items' || id === 'player'; },
  };
}

async function buildInventory({ full = false } = {}) {
  const actor = makeActor();
  const items = await makeItemsSystem(actor);
  const player = makePlayerStub(actor);
  const ctx = makeUiCtx(items, player);
  const panelsLayer = el('div');
  const cursorLayer = el('div');
  const inv = new Inventory(ctx, panelsLayer, cursorLayer, (k) => k, null, () => {});
  inv.open();

  if (full) {
    for (let i = 0; i < 40; i++) {
      const it = makeItem('potion_life_minor', { quantity: (i % 20) + 1 });
      assert.ok(items.place('inventory', it, i % 10, Math.floor(i / 10)));
    }
  }
  return { inv, items, ctx };
}

test('12.Axx: Inventory#update(dt,ctx) steady state, panel open and EMPTY, allocates < 1 byte/call at N >= 1e6', async (t) => {
  if (!hasGc()) { t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)'); return; }
  const { inv, ctx } = await buildInventory({ full: false });

  for (let i = 0; i < 5; i++) inv.update(1 / 60, ctx);

  const dt = 1 / 60;
  const runOneCall = () => { inv.update(dt, ctx); };

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(`Inventory#update (empty) allocation: N=1e6 -> ${atOneMillion.toFixed(4)} B/call, N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`);

  assert.ok(marginalBytesPerCall < 1, `Inventory#update (empty) must allocate < 1 byte/call marginally; got ${marginalBytesPerCall.toFixed(4)} B/call`);
});

test('12.Axx: Inventory#update(dt,ctx) steady state, panel open and FULL (40 items), allocates < 1 byte/call at N >= 1e6', async (t) => {
  if (!hasGc()) { t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)'); return; }
  const { inv, ctx } = await buildInventory({ full: true });

  for (let i = 0; i < 5; i++) inv.update(1 / 60, ctx);

  const dt = 1 / 60;
  const runOneCall = () => { inv.update(dt, ctx); };

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(`Inventory#update (full, 40 items) allocation: N=1e6 -> ${atOneMillion.toFixed(4)} B/call, N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`);

  assert.ok(marginalBytesPerCall < 1, `Inventory#update (full) must allocate < 1 byte/call marginally; got ${marginalBytesPerCall.toFixed(4)} B/call`);
});

test('12.Axx: Inventory#update(dt,ctx) mid-drag, ghost settled at a steady target, allocates < 1 byte/call at N >= 1e6', async (t) => {
  if (!hasGc()) { t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)'); return; }
  const { inv, items, ctx } = await buildInventory({ full: false });

  const item = makeItem('potion_life_minor');
  assert.ok(items.place('inventory', item, 0, 0));
  const origin = inv.__gridOrigin();
  inv.__simulatePointerDown(origin.x + 5, origin.y + 5);
  assert.ok(inv.__isDragging());
  // Settle the ghost's damp toward a fixed target, then hold the pointer
  // still (no further pendingMove) so the probe measures the settled
  // per-frame `damp()` + `place()` change-guard cost, not a moving target.
  inv.__simulatePointerMove(origin.x + 5 * 44 + 5, origin.y + 5);
  for (let i = 0; i < 120; i++) inv.update(1 / 60, ctx);

  const dt = 1 / 60;
  const runOneCall = () => { inv.update(dt, ctx); };

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(`Inventory#update (mid-drag, settled) allocation: N=1e6 -> ${atOneMillion.toFixed(4)} B/call, N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`);

  assert.ok(inv.__isDragging(), 'the drag must still be active throughout the probe');
  assert.ok(marginalBytesPerCall < 1, `Inventory#update (mid-drag) must allocate < 1 byte/call marginally; got ${marginalBytesPerCall.toFixed(4)} B/call`);
});
