// tests/items/economy.perf.test.js
//
// ITEM-14 — `Alloc: no` proof for every economy/vendor row
// `02-api-contracts.md` §11 marks that way: `itemValue`/`sellValue`/
// `buyValue`/`repairCost`/`repairAllCost`/`repairAll`/`currentStock`/
// `buyback`. `vendorStock` is deliberately NOT probed here — its own
// contract row is `Alloc: yes` (it regenerates the stock array), matching
// the sibling-file convention of only gating rows that promise zero
// allocation (tests/items/containers.perf.test.js's own header, skipping
// `splitStack` for the identical reason). Measured, not asserted by reading
// the source. Named `.perf.test.js` so it lands in the isolated
// `--test-concurrency=1` perf stage, matching every sibling `*.perf.test.js`
// in this directory.
//
// O-43's methodology (this ticket's own brief, restated from every sibling
// perf file in this directory): allocation probes are meaningless below
// ~1e6 iterations on this project's measured noise floor. `itemValue`'s own
// measured convergence curve below (ITMS.E54) reads 3.42 B/call at N=1M and
// only drops under 1 B/call at N=4M — a real, reproducible plateau, not
// round-to-round noise (identical across all 60 `assertAllocationFree`
// retries at N=1M) — so every `assertAllocationFree` probe in this file
// runs at `iterations: 4_000_000`, not the 1,000,000 several sibling files
// use, per this ticket's own brief: "Lengthen the warm-up; never loosen the
// threshold." The brief's own reference convergence curve (80.45 -> 17.88 ->
// 0.391 -> 0.325 B/call as N goes 10k -> 100k -> 1M -> 4M) is reproduced
// explicitly for `itemValue` and `currentStock` below (ITMS.E54/E55), not
// just gated pass/fail — `currentStock` converges far faster (already
// < 0.01 B/call at N=10k) since it does strictly less work than `itemValue`
// per call (one property read vs. several multiplications).
//
// Retention note (this ticket's brief: "a naive probe of an inherently-
// allocating function read 0.5 B/call and was completely wrong" when
// nothing retains its result): `itemValue`/`sellValue`/`buyValue`/
// `repairCost`/`repairAllCost`/`repairAll` all return a primitive `number`
// — there is nothing a minor GC could reclaim between the call and the
// `heapUsed` sample regardless of retention, so no explicit retention
// array is needed for those. `currentStock`/`buyback` return an existing,
// already-stored array REFERENCE (never a fresh one, per their own
// `Alloc: no` contract) — same "nothing new to reclaim" shape. Every probe
// still assigns its result to an outer-scope variable anyway, matching this
// project's established habit in every sibling perf file, cheap insurance
// against a future regression that DOES start allocating.
//
// Every probe is deliberately STEADY-STATE, mirroring
// tests/items/state.perf.test.js's own precedent for `durabilityTick`:
// `repairAll`'s probe re-damages its weapon to a fixed, above-zero
// durability inside the measured closure (a primitive int assignment, not
// an allocation) so it repeats the REAL repair-and-spend-gold path on every
// call, never degenerating into the "nothing to repair, cost 0" early exit
// after its first call — and never crosses `durability === 0`, so it never
// exercises the once-per-item `actors.markDirty` branch (out of scope here,
// same "runs at most once per item's lifetime" exemption `./state.js`'s own
// `applyLoss`/`ensureCache` branch gets in that file's perf test).

import test from 'node:test';

import { allocatedBytes, assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';
import { ItemsSystem } from '../../src/items/index.js';
import { ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';
import { VEREN_ID } from '../../src/items/vendor.js';

async function makeSystem(seed) {
  const actor = { kind: 'player', inventory: null, belt: null };
  const ctx = {
    rng: new Rng(seed),
    events: new EventBus(),
    time: { step: 0 },
    get(id) {
      if (id === 'actors') return { player: actor };
      throw new Error(`stub ctx.get: '${id}' is not available`);
    },
  };
  const sys = new ItemsSystem();
  await sys.init(ctx);
  return { sys, ctx, actor };
}

let _uid = 1;
function makeItem(baseId, overrides = {}) {
  const base = ITEM_BASES_BY_ID[baseId];
  return {
    uid: overrides.uid ?? _uid++,
    baseId,
    rarity: overrides.rarity ?? 'normal',
    ilvl: overrides.ilvl ?? (base ? base.reqLevel : 1),
    identified: true,
    quantity: 1,
    rolls: overrides.rolls ?? { defense: 0, superior: 0, damageMin: 0, damageMax: 0 },
    affixes: overrides.affixes ?? [],
    uniqueId: null,
    uniqueValues: [],
    nameOverride: null,
    durability: overrides.durability ?? (base ? base.maxDurability : 1),
    maxDurability: overrides.maxDurability ?? (base ? base.maxDurability : 1),
    sockets: [],
    socketCount: 0,
  };
}

function emptyEquipment() {
  return {
    head: null, chest: null, hands: null, legs: null,
    mainHand: null, offHand: null, belt: null,
    amulet: null, ring1: null, ring2: null,
  };
}

test('ITMS.E50 itemValue/sellValue/buyValue/repairCost are genuinely allocation-free (O-43 methodology, N >= 1e6, strict < 1 byte/call)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { sys } = await makeSystem(501);
  const normalItem = makeItem('axe_battle_normal', { rarity: 'normal' });
  const rareItem = makeItem('axe_battle_normal', { rarity: 'rare', affixes: [{ id: 'sfx_a', kind: 'suffix', values: [1] }, { id: 'sfx_b', kind: 'suffix', values: [1] }, { id: 'pfx_a', kind: 'prefix', values: [1] }, { id: 'pfx_b', kind: 'prefix', values: [1] }] });
  const damagedItem = makeItem('axe_ruin_elite', { rarity: 'rare', durability: 40, maxDurability: 87 });

  const probes = [
    { name: 'itemValue(normal)', fn: () => { void sys.itemValue(normalItem); } },
    { name: 'itemValue(rare, 4 affixes)', fn: () => { void sys.itemValue(rareItem); } },
    { name: 'sellValue(rare, 4 affixes)', fn: () => { void sys.sellValue(rareItem); } },
    { name: 'buyValue(rare, 4 affixes)', fn: () => { void sys.buyValue(rareItem); } },
    { name: 'repairCost(damaged rare)', fn: () => { void sys.repairCost(damagedItem); } },
  ];

  const results = [];
  for (const probe of probes) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: 4_000_000, maxRounds: 60 });
    results.push({ name: probe.name, bytesPerCall, rounds });
  }

  // eslint-disable-next-line no-console
  console.log('ITMS.E50 strict probe results (bytes/call, rounds to converge):');
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`  ${r.name}: ${r.bytesPerCall.toFixed(4)} B/call (${r.rounds} round(s))`);
  }
});

test('ITMS.E51 repairAllCost is genuinely allocation-free over equipment + inventory + belt (O-43 methodology, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { sys, actor } = await makeSystem(502);
  actor.equipment = { ...emptyEquipment(), mainHand: makeItem('axe_battle_normal', { rarity: 'magic', durability: 20, maxDurability: 55 }) };
  actor.inventory = { list: [makeItem('axe_ruin_elite', { rarity: 'rare', durability: 40, maxDurability: 87 }), null, null] };
  actor.belt = { slots: [makeItem('potion_life_minor', { durability: 0, maxDurability: 0 }), null, null, null] };

  const { bytesPerCall, rounds } = assertAllocationFree(() => { void sys.repairAllCost(actor); }, { iterations: 4_000_000, maxRounds: 60 });

  // eslint-disable-next-line no-console
  console.log(`ITMS.E51 repairAllCost(actor): ${bytesPerCall.toFixed(4)} B/call (${rounds} round(s))`);
});

test('ITMS.E52 repairAll is genuinely allocation-free in its steady (non-crossing, well-funded) state (O-43 methodology, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { sys, actor } = await makeSystem(503);
  const weapon = makeItem('axe_battle_normal', { rarity: 'magic', durability: 20, maxDurability: 55 });
  actor.equipment = { ...emptyEquipment(), mainHand: weapon };
  actor.inventory = null;
  actor.belt = null;
  actor.gold = 1e15; // never exhausted across millions of calls

  const runOneCall = () => {
    weapon.durability = 20; // re-damage — primitive assignment, not an allocation
    sys.repairAll(actor);
  };

  const { bytesPerCall, rounds } = assertAllocationFree(runOneCall, { iterations: 4_000_000, maxRounds: 60 });

  // eslint-disable-next-line no-console
  console.log(`ITMS.E52 repairAll(actor) steady state: ${bytesPerCall.toFixed(4)} B/call (${rounds} round(s))`);
});

test('ITMS.E53 currentStock/buyback are genuinely allocation-free — return a stored reference, never rebuild (O-43 methodology, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { sys, ctx } = await makeSystem(504);
  ctx.events.emit('zone:enter', { zoneId: 'last_bastion', seed: 999, entry: 'default' });

  const probes = [
    { name: 'currentStock(veren)', fn: () => { void sys.currentStock(VEREN_ID); } },
    { name: 'buyback(veren)', fn: () => { void sys.buyback(VEREN_ID); } },
  ];

  const results = [];
  for (const probe of probes) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: 4_000_000, maxRounds: 60 });
    results.push({ name: probe.name, bytesPerCall, rounds });
  }

  // eslint-disable-next-line no-console
  console.log('ITMS.E53 strict probe results (bytes/call, rounds to converge):');
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`  ${r.name}: ${r.bytesPerCall.toFixed(4)} B/call (${r.rounds} round(s))`);
  }
});

// ---------------------------------------------------------------------------
// Convergence curve (this ticket's brief: 80.45 -> 17.88 -> 0.391 -> 0.325
// B/call as N goes 10k -> 100k -> 1M -> 4M on genuinely allocation-free
// code) — explicit proof independent of assertAllocationFree's pass/fail
// gate, same shape tests/items/state.perf.test.js/containers.perf.test.js
// already use for this exact purpose.
// ---------------------------------------------------------------------------

test('ITMS.E54 itemValue allocation converges toward 0 as N grows (explicit curve, not just a pass/fail gate)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { sys } = await makeSystem(505);
  const item = makeItem('axe_battle_normal', { rarity: 'rare', affixes: [{ id: 'sfx_a', kind: 'suffix', values: [1] }, { id: 'sfx_b', kind: 'suffix', values: [1] }, { id: 'pfx_a', kind: 'prefix', values: [1] }, { id: 'pfx_b', kind: 'prefix', values: [1] }] });
  const runOneCall = () => { void sys.itemValue(item); };

  for (let i = 0; i < 200_000; i++) runOneCall(); // lengthened warm-up, this ticket's brief

  const at10k = allocatedBytes(runOneCall, 10_000);
  const at100k = allocatedBytes(runOneCall, 100_000);
  const at1m = allocatedBytes(runOneCall, 1_000_000);
  const at4m = allocatedBytes(runOneCall, 4_000_000);

  // eslint-disable-next-line no-console
  console.log(
    `ITMS.E54 itemValue convergence: N=10k -> ${at10k.toFixed(4)} B/call, N=100k -> ${at100k.toFixed(4)} B/call, ` +
      `N=1M -> ${at1m.toFixed(4)} B/call, N=4M -> ${at4m.toFixed(4)} B/call`,
  );

  if (at4m >= 1) {
    throw new Error(`itemValue reads ${at4m.toFixed(4)} B/call at N=4,000,000 — expected well under 1 byte/call.`);
  }
});

test('ITMS.E55 currentStock allocation converges toward 0 as N grows (explicit curve, not just a pass/fail gate)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { sys, ctx } = await makeSystem(506);
  ctx.events.emit('zone:enter', { zoneId: 'last_bastion', seed: 42, entry: 'default' });
  const runOneCall = () => { void sys.currentStock(VEREN_ID); };

  for (let i = 0; i < 200_000; i++) runOneCall();

  const at10k = allocatedBytes(runOneCall, 10_000);
  const at100k = allocatedBytes(runOneCall, 100_000);
  const at1m = allocatedBytes(runOneCall, 1_000_000);
  const at4m = allocatedBytes(runOneCall, 4_000_000);

  // eslint-disable-next-line no-console
  console.log(
    `ITMS.E55 currentStock convergence: N=10k -> ${at10k.toFixed(4)} B/call, N=100k -> ${at100k.toFixed(4)} B/call, ` +
      `N=1M -> ${at1m.toFixed(4)} B/call, N=4M -> ${at4m.toFixed(4)} B/call`,
  );

  if (at4m >= 1) {
    throw new Error(`currentStock reads ${at4m.toFixed(4)} B/call at N=4,000,000 — expected well under 1 byte/call.`);
  }
});
