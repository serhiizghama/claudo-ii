// tests/items/state.perf.test.js
//
// ITEM-13 — `Alloc: no` proof for `durabilityTick`/`identify`
// (`02-api-contracts.md` §11). Measured, not asserted by reading the
// source. Named `.perf.test.js` so it lands in the isolated
// `--test-concurrency=1` perf stage, matching every sibling
// `*.perf.test.js` in this directory.
//
// O-43's methodology (see tests/items/containers.perf.test.js's own header
// for the full citation): allocation probes are meaningless below ~1e6
// iterations on this project's measured noise floor — every probe below
// runs at N >= 1,000,000 with a real warm-up, never a loosened threshold.
//
// Retention (this ticket's own brief, "found in this milestone" — a naive
// probe of an inherently-allocating function can read near-zero if nothing
// retains its result before `heapUsed` is sampled): `durabilityTick`
// returns `void` and, in every steady-state (non-crossing) path exercised
// here, only MUTATES fields already present on the item/actor — it never
// constructs and discards a fresh object for a minor GC to reclaim before
// sampling. There is deliberately nothing to "retain": the claim under
// test is that the steady-state path allocates nothing at all, not that an
// allocated-and-discarded object merely survives long enough to be seen.
// `identify`'s no-op (already-identified) path is the same shape.
//
// What is deliberately NOT probed here: the durability-crossing-to-0 path
// (`applyLoss`'s `ensureCache`/`actors.markDirty` branch) and `identify`'s
// flag-flipping path both run at most ONCE per item's lifetime — not a
// hot-path call `04-items.md` §7.4 or this ticket's brief asks to be
// allocation-free in a loop, unlike `durabilityTick` itself ("runs on
// every landed attack — that is a hot path", this ticket's brief).

import test from 'node:test';

import { allocatedBytes, assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { ItemsSystem } from '../../src/items/index.js';
import { ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';

async function makeCtx(seed) {
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
function makeItem(baseId, overrides = {}) {
  const base = ITEM_BASES_BY_ID[baseId];
  return {
    uid: overrides.uid ?? _uid++,
    baseId,
    rarity: 'normal',
    ilvl: base ? base.reqLevel : 1,
    identified: overrides.identified ?? true,
    quantity: 1,
    rolls: { defense: 0, superior: 0, damageMin: base && base.weapon ? base.weapon.minDamage : 0, damageMax: base && base.weapon ? base.weapon.maxDamage : 0 },
    affixes: [],
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

function emptyEquipment() {
  return {
    head: null, chest: null, hands: null, legs: null,
    mainHand: null, offHand: null, belt: null,
    amulet: null, ring1: null, ring2: null,
  };
}

function slotItem(actor, slotName, item) {
  if (!actor.equipment) actor.equipment = emptyEquipment();
  actor.equipment[slotName] = item;
  item.slot = slotName;
}

test('13.ITMS-S durabilityTick is genuinely allocation-free in its steady (non-crossing) state (O-43 methodology, N >= 1e6, strict < 1 byte/call)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const probes = [];

  // ── 'attack' — the documented hot path (04 §7.4: "on every landed
  //    attack"). Durability is huge so the run never crosses to 0, which
  //    would exercise the (deliberately unprobed, see header) once-per-item
  //    ensureCache/markDirty branch instead of the steady tick path. ──────
  {
    const ctx = await makeCtx(401);
    const items = ctx.get('items');
    const actors = ctx.get('actors');
    const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 20 });
    const weapon = makeItem('axe_battle_normal', { durability: 100_000_000, maxDurability: 100_000_000 });
    slotItem(actor, 'mainHand', weapon);
    probes.push({ name: 'durabilityTick(actor, "attack")', fn: () => { items.durabilityTick(actor, 'attack'); } });
  }

  // ── 'hit' — round-robin over several equipped armour pieces. ──────────
  {
    const ctx = await makeCtx(402);
    const items = ctx.get('items');
    const actors = ctx.get('actors');
    const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 20 });
    slotItem(actor, 'head', makeItem('helm_cap_normal', { durability: 100_000_000, maxDurability: 100_000_000 }));
    slotItem(actor, 'chest', makeItem('armour_rags', { durability: 100_000_000, maxDurability: 100_000_000 }));
    slotItem(actor, 'hands', makeItem('gloves_bracers_normal', { durability: 100_000_000, maxDurability: 100_000_000 }));
    slotItem(actor, 'offHand', makeItem('shield_buckler_normal', { durability: 100_000_000, maxDurability: 100_000_000 }));
    probes.push({ name: 'durabilityTick(actor, "hit")', fn: () => { items.durabilityTick(actor, 'hit'); } });
  }

  // ── 'block' — shield accumulator + the shared armour round-robin. ─────
  {
    const ctx = await makeCtx(403);
    const items = ctx.get('items');
    const actors = ctx.get('actors');
    const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 20 });
    slotItem(actor, 'offHand', makeItem('shield_buckler_normal', { durability: 100_000_000, maxDurability: 100_000_000 }));
    slotItem(actor, 'head', makeItem('helm_cap_normal', { durability: 100_000_000, maxDurability: 100_000_000 }));
    probes.push({ name: 'durabilityTick(actor, "block")', fn: () => { items.durabilityTick(actor, 'block'); } });
  }

  // ── identify — steady no-op path (already identified; the flag-flip
  //    itself runs at most once per item, see file header). ─────────────
  {
    const ctx = await makeCtx(404);
    const items = ctx.get('items');
    const already = makeItem('sword_short_normal', { identified: true });
    probes.push({ name: 'identify(alreadyIdentified) — no-op path', fn: () => { items.identify(already); } });
  }

  const results = [];
  for (const probe of probes) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: 1_000_000, maxRounds: 60 });
    results.push({ name: probe.name, bytesPerCall, rounds });
  }

  // eslint-disable-next-line no-console
  console.log('13.ITMS-S strict probe results (bytes/call, rounds to converge):');
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`  ${r.name}: ${r.bytesPerCall.toFixed(4)} B/call (${r.rounds} round(s))`);
  }
});

// ---------------------------------------------------------------------------
// Convergence curve (this ticket's brief: 80.45 -> 17.88 -> 0.391 -> 0.325
// B/call as N goes 10k -> 100k -> 1M -> 4M on genuinely allocation-free
// code) — a second, explicit proof independent of assertAllocationFree's
// pass/fail gate, same shape tests/items/containers.perf.test.js already
// uses for this exact purpose.
// ---------------------------------------------------------------------------

test('13.ITMS-S durabilityTick("attack") allocation converges toward 0 as N grows (explicit curve, not just a pass/fail gate)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ctx = await makeCtx(405);
  const items = ctx.get('items');
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 20 });
  const weapon = makeItem('axe_battle_normal', { durability: 100_000_000, maxDurability: 100_000_000 });
  slotItem(actor, 'mainHand', weapon);
  const runOneCall = () => { items.durabilityTick(actor, 'attack'); };

  // Warm-up beyond what a single-call warm-up inside allocatedBytes gives —
  // same lengthened warm-up this ticket's brief asks for.
  for (let i = 0; i < 200_000; i++) runOneCall();

  const at10k = allocatedBytes(runOneCall, 10_000);
  const at100k = allocatedBytes(runOneCall, 100_000);
  const at1m = allocatedBytes(runOneCall, 1_000_000);
  const at4m = allocatedBytes(runOneCall, 4_000_000);

  // eslint-disable-next-line no-console
  console.log(
    `13.ITMS-S convergence: N=10k -> ${at10k.toFixed(4)} B/call, N=100k -> ${at100k.toFixed(4)} B/call, ` +
      `N=1M -> ${at1m.toFixed(4)} B/call, N=4M -> ${at4m.toFixed(4)} B/call`,
  );

  if (at4m >= 1) {
    throw new Error(`durabilityTick("attack") reads ${at4m.toFixed(4)} B/call at N=4,000,000 — expected well under 1 byte/call.`);
  }
});
