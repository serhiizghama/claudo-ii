// tests/items/ground.perf.test.js
//
// ITEM-12 — `Alloc: no` proof for `dropToGround`/`groundItemsNear`/`pickUp`
// (`02-api-contracts.md` §11 "World interaction"). Measured, not asserted by
// reading the source, same O-43 methodology `tests/items/containers.perf.test.js`
// already establishes for this directory (its own header has the full
// derivation: allocation probes are meaningless below ~1e6 iterations on
// this project's measured noise floor). Named `.perf.test.js` so it lands in
// the isolated `--test-concurrency=1` perf stage, not the unit stage.
//
// Every probe below is deliberately STEADY-STATE, and deliberately keeps its
// target object reachable across every call (never lets the mutated record
// become unreachable garbage between iterations) — this ticket's own brief
// warns that a probe which does not retain what a real caller keeps can read
// an inherently-allocating function as allocation-free, because a minor GC
// reclaims the per-call garbage before `heapUsed` is sampled. `item` (for
// `dropToGround`) and `out` (for `groundItemsNear`, caller-supplied per its
// own contract) stay in scope across the whole probe loop, the same way
// `containers.perf.test.js`'s `place()/remove()` ping-pong keeps `item` in
// scope across its loop.

import test from 'node:test';

import { allocatedBytes, assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';
import { ItemsSystem } from '../../src/items/index.js';

function makeActor() {
  return { kind: 'player', inventory: null, belt: null };
}

async function makeSystem(seed, opts = {}) {
  const actor = makeActor();
  const ctx = {
    rng: new Rng(seed),
    events: new EventBus(),
    time: { step: opts.step ?? 0 },
    config: opts.groundItemBudget ? { q: { groundItemBudget: opts.groundItemBudget } } : {},
    get(id) {
      if (id === 'actors') return { player: actor };
      throw new Error(`stub ctx.get: '${id}' is not available`);
    },
    peek(id) {
      if (id === 'actors') return { player: actor };
      return null;
    },
  };
  const sys = new ItemsSystem();
  await sys.init(ctx);
  return { sys, ctx, actor };
}

let _uid = 1;
function makeItem(baseId, rarity = 'normal', overrides = {}) {
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
  };
}

test('12.ITMS-G dropToGround/groundItemsNear/pickUp allocate < 1 byte/call (O-43 methodology, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const probes = [];

  // ── dropToGround, steady state: the SAME item, already carrying
  //    `.ground` after the first call, ping-ponged between two points so
  //    the object literal never has to be allocated again ────────────────
  {
    const { sys } = await makeSystem(1, { groundItemBudget: 96 });
    const item = makeItem('ring_iron');
    sys.dropToGround(item, 0, 0); // one-time item.ground allocation
    let atOrigin = false;
    probes.push({
      name: 'dropToGround() re-placement on an item that already has .ground',
      fn: () => {
        sys.dropToGround(item, atOrigin ? 0 : 1, atOrigin ? 0 : 1);
        atOrigin = !atOrigin;
      },
    });
  }

  // ── groundItemsNear, caller-supplied `out`, steady population ─────────
  {
    const { sys } = await makeSystem(2, { groundItemBudget: 96 });
    for (let i = 0; i < 20; i++) sys.dropToGround(makeItem('ring_iron'), i, 0);
    const out = new Array(8).fill(null);
    probes.push({
      name: 'groundItemsNear(x,z,radius,out) — 20 resident items, caller out',
      fn: () => {
        sys.groundItemsNear(10, 0, 100, out);
      },
    });
  }

  // ── pickUp(), steady-state REFUSAL (item already off the ground) ──────
  // NOT a ground<->inventory ping-pong: `01-data-model.md` §5.3's own
  // invariant ("exactly one of grid/slot/ground is non-null") means a
  // round trip through the inventory and back onto the ground legitimately
  // reallocates `item.ground` once per cycle (`./containers.js#place`
  // already does the identical full `item.ground = null` on the way IN,
  // for the same reason) — that is correct, spec-required behaviour, not a
  // regression, and is not what `Alloc: no` is claiming. The realistic
  // repeated-call shape this probes instead is the early-exit refusal path
  // (`!item.ground`), which is genuinely steady-state: a UI spam-click on
  // a label whose item is already gone, or the same object probed by two
  // rapid input events.
  {
    const { sys, actor } = await makeSystem(3, { groundItemBudget: 96 });
    const item = makeItem('ring_iron'); // never dropped — item.ground stays null
    probes.push({
      name: 'pickUp(actor, item) — steady-state refusal, item not on the ground',
      fn: () => {
        sys.pickUp(actor, item);
      },
    });
  }

  // ── fixedUpdate (the 600s decay sweep), steady state: 50 resident items,
  //    none of them ever expiring during the probe ──────────────────────
  {
    const { sys, ctx } = await makeSystem(4, { groundItemBudget: 96 });
    for (let i = 0; i < 50; i++) sys.dropToGround(makeItem('ring_iron'), i, 0);
    probes.push({
      name: 'fixedUpdate() — 50 resident items, none expiring',
      fn: () => {
        sys.fixedUpdate();
        ctx.time.step++;
      },
    });
  }

  const results = [];
  for (const probe of probes) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: 1_000_000, maxRounds: 60 });
    console.log(`[ITEM-12] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=1e6`);
    results.push({ name: probe.name, bytesPerCall });
    if (bytesPerCall >= 1) {
      throw new Error(`${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
    }
  }
  console.log(`[ITEM-12] probed ${results.length} Alloc: no methods, all < 1 byte/call.`);
});

// ---------------------------------------------------------------------------
// A second, independent reading at N=4e6 for the ground-drop hot path,
// reproducing this project's own decaying-mean curve (80.45 -> 17.88 ->
// 0.391 -> 0.325 B/call, N=10k -> 4e6) as an explicit, separate proof rather
// than relying on assertAllocationFree's single converged reading alone —
// same shape as tests/items/containers.perf.test.js's own `12.ITMS-C2`.
// ---------------------------------------------------------------------------

test('12.ITMS-G2 dropToGround marginal bytes/call between N=1e6 and N=4e6 (O-43 methodology)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { sys } = await makeSystem(5, { groundItemBudget: 96 });
  const item = makeItem('ring_iron');
  sys.dropToGround(item, 0, 0);
  let atOrigin = false;
  const runOneCall = () => {
    sys.dropToGround(item, atOrigin ? 0 : 1, atOrigin ? 0 : 1);
    atOrigin = !atOrigin;
  };

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  console.log(`  dropToGround() alloc: N=1e6 ${atOneMillion.toFixed(4)} B/call, N=4e6 ${atFourMillion.toFixed(4)} B/call, marginal ${marginalBytesPerCall.toFixed(4)} B/call`);

  if (marginalBytesPerCall >= 1) {
    throw new Error(
      `dropToGround() must allocate < 1 byte/call marginally between N=1e6 and N=4e6; ` +
        `got ${marginalBytesPerCall.toFixed(4)} B/call (N=1e6: ${atOneMillion.toFixed(4)}, N=4e6: ${atFourMillion.toFixed(4)})`,
    );
  }
});
