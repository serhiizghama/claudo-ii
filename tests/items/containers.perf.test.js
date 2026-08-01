// tests/items/containers.perf.test.js
//
// ITEM-10 — `Alloc: no` proof for every container/belt/cursor method this
// ticket adds (`02-api-contracts.md` §11 "Containers and equipment"),
// except `splitStack` (the one `Alloc: yes` row — not probed here, same
// convention `tests/items/mods.perf.test.js` etc. already follow of only
// gating the rows that promise zero allocation). Measured, not asserted by
// reading the source. Named `.perf.test.js` so it lands in the isolated
// `--test-concurrency=1` perf stage, not the unit stage.
//
// O-43's methodology (tests/items/mods.perf.test.js, tests/items/
// accessors.perf.test.js, tests/core/alloc.test.js's `12.A01`): allocation
// probes are meaningless below ~1e6 iterations on this project's measured
// noise floor (a genuinely allocation-free function reads ~80 B/call at
// N=10k, decaying to a fraction of a byte only around N=1e6-4e6 — GC/JIT
// settling, not a leak). `tests/helpers/alloc.js`'s `assertAllocationFree`
// samples at `iterations: 1_000_000` and resamples (never re-running the
// whole *test*) until a round reads below the 1 byte/call threshold.
//
// Every probe below is deliberately STEADY-STATE: each item used already
// carries the `.grid` object `place()` reuses (containers.js's own header:
// "only allocating a fresh `{container,x,y}` the FIRST time an item is ever
// placed"), and `beltUse`'s probe manually advances `ctx.time.step` past the
// cooldown and keeps `quantity` topped up every call, so it repeatedly hits
// the real "successful use" branch rather than degenerating into a cheap
// early-exit refusal after its first call — a probe that measures the wrong
// branch (this ticket's brief: "a naive probe of an inherently-allocating
// function read 0.5 B/call and was completely wrong" is the same failure
// mode in miniature).
//
// These rows also belong on `tests/core/alloc.test.js`'s `12.A01` probe
// list per that file's own header ("a later ticket that adds a NEW Alloc:
// no row should add a new probe ... its own subsystem's .perf.test.js if
// one exists") — this file IS that subsystem's `.perf.test.js`, so per that
// same header's own instruction the probes stay here, not duplicated there.
// See this ticket's report for the exact cross-reference text.

import test from 'node:test';

import { allocatedBytes, assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { Rng } from '../../src/core/rng.js';
import { ItemsSystem } from '../../src/items/index.js';
import { BELT_COOLDOWN_SECONDS } from '../../src/items/containers.js';

function makeActor() {
  return { kind: 'player', inventory: null, belt: null };
}

async function makeSystem(seed, step = 0) {
  const actor = makeActor();
  const ctx = {
    rng: new Rng(seed),
    time: { step },
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
  return {
    uid: overrides.uid ?? _uid++,
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

test('12.ITMS-C canPlace/itemAt/freeCells/findPlacement/place+remove/sortContainer/belt/cursor allocate < 1 byte/call (O-43 methodology, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const probes = [];

  // ── canPlace ─────────────────────────────────────────────────────────
  {
    const { sys } = await makeSystem(1);
    const resident = makeItem('shield_buckler_normal'); // 2x2
    sys.place('stash', resident, 0, 0);
    const probeItem = makeItem('potion_life_minor');
    let x = 2;
    probes.push({
      name: 'canPlace(\'stash\', item, x, 0) — cycling x',
      fn: () => {
        sys.canPlace('stash', probeItem, x, 0);
        x = x === 2 ? 3 : 2;
      },
    });
  }

  // ── itemAt ───────────────────────────────────────────────────────────
  {
    const { sys } = await makeSystem(2);
    const resident = makeItem('shield_buckler_normal');
    sys.place('stash', resident, 4, 4);
    probes.push({
      name: 'itemAt(\'stash\', 4, 4)',
      fn: () => {
        sys.itemAt('stash', 4, 4);
      },
    });
  }

  // ── freeCells ────────────────────────────────────────────────────────
  {
    const { sys } = await makeSystem(3);
    sys.place('stash', makeItem('potion_life_minor'), 0, 0);
    probes.push({
      name: 'freeCells(\'stash\')',
      fn: () => {
        sys.freeCells('stash');
      },
    });
  }

  // ── findPlacement, caller-supplied `out` (steady state: `out` is a
  //    single object reused by the caller across calls, the real hot-path
  //    shape — e.g. a tooltip/preview re-querying every pointermove) ────
  {
    const { sys } = await makeSystem(4);
    sys.place('stash', makeItem('shield_buckler_normal'), 0, 0);
    const probeItem = makeItem('potion_life_minor');
    const out = { x: 0, y: 0 };
    probes.push({
      name: 'findPlacement(\'stash\', item, out) — caller-supplied out',
      fn: () => {
        sys.findPlacement('stash', probeItem, out);
      },
    });
  }

  // ── findPlacement, no `out` given (falls back to the shared internal
  //    scratch — must be equally zero-allocation) ─────────────────────
  {
    const { sys } = await makeSystem(5);
    sys.place('stash', makeItem('shield_buckler_normal'), 0, 0);
    const probeItem = makeItem('potion_life_minor');
    probes.push({
      name: 'findPlacement(\'stash\', item) — no out, internal scratch',
      fn: () => {
        sys.findPlacement('stash', probeItem);
      },
    });
  }

  // ── place()/remove() paired, steady state: the SAME item, already
  //    carrying `.grid`, ping-ponged between two cells so `place()` never
  //    has to allocate a fresh `{container,x,y}` after the first call ───
  {
    const { sys } = await makeSystem(6);
    const item = makeItem('potion_life_minor');
    sys.place('stash', item, 0, 0); // one-time allocation of item.grid
    let atOrigin = false;
    probes.push({
      name: 'place()+remove() ping-pong on an item that already has .grid',
      fn: () => {
        sys.remove(item);
        sys.place('stash', item, atOrigin ? 0 : 1, 0);
        atOrigin = !atOrigin;
      },
    });
  }

  // ── sortContainer, small already-populated container (idempotent re-sort
  //    every call — still exercises the full trial-buffer pass) ────────
  {
    const { sys } = await makeSystem(7);
    sys.place('stash', makeItem('potion_life_minor'), 0, 0);
    sys.place('stash', makeItem('potion_mana_minor'), 1, 0);
    sys.place('stash', makeItem('ring_iron'), 2, 0);
    sys.place('stash', makeItem('dagger_shard_normal'), 3, 0);
    probes.push({
      name: 'sortContainer(\'stash\') — 4 items, already sorted',
      fn: () => {
        sys.sortContainer('stash');
      },
    });
  }

  // ── belt ─────────────────────────────────────────────────────────────
  {
    const { sys, actor, ctx } = await makeSystem(8);
    const potion = makeItem('potion_life_minor', { quantity: 1 });
    sys.place('belt', potion, 0, 0);
    probes.push({
      name: 'beltCooldown(actor)',
      fn: () => {
        sys.beltCooldown(actor);
        ctx.time.step++;
      },
    });
    probes.push({
      name: 'beltCount(actor, 0)',
      fn: () => {
        sys.beltCount(actor, 0);
      },
    });
  }

  {
    // beltUse: steady state means every call must hit the real
    // "successful use" branch, not degenerate into an empty-slot refusal
    // after the first call (see file header).
    const { sys, actor, ctx } = await makeSystem(9);
    const potion = makeItem('potion_life_minor', { quantity: 10_000_000 });
    sys.place('belt', potion, 0, 0);
    const cooldownSteps = Math.round(BELT_COOLDOWN_SECONDS * 60) + 1;
    probes.push({
      name: 'beltUse(actor, 0) — steady-state successful use every call',
      fn: () => {
        ctx.time.step += cooldownSteps;
        sys.beltUse(actor, 0);
      },
    });
  }

  // ── cursor slot ──────────────────────────────────────────────────────
  {
    const { sys } = await makeSystem(10);
    probes.push({
      name: 'cursorItem (property read)',
      fn: () => {
        // eslint-disable-next-line no-unused-expressions
        sys.cursorItem;
      },
    });
  }

  {
    const { sys } = await makeSystem(11);
    const item = makeItem('potion_life_minor');
    sys.place('stash', item, 0, 0); // one-time item.grid allocation
    probes.push({
      name: 'takeToCursor()+returnCursor() ping-pong on the same item',
      fn: () => {
        sys.takeToCursor(item);
        sys.returnCursor();
      },
    });
  }

  {
    const { sys } = await makeSystem(12);
    const item = makeItem('potion_life_minor');
    sys.place('stash', item, 0, 0);
    let atZero = true;
    probes.push({
      name: 'takeToCursor()+dropCursor() ping-pong between two empty cells',
      fn: () => {
        sys.takeToCursor(item);
        sys.dropCursor('stash', atZero ? 2 : 0, 0);
        atZero = !atZero;
      },
    });
  }

  const results = [];
  for (const probe of probes) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: 1_000_000, maxRounds: 60 });
    console.log(`[ITEM-10] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=1e6`);
    results.push({ name: probe.name, bytesPerCall });
    if (bytesPerCall >= 1) {
      throw new Error(`${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
    }
  }
  console.log(`[ITEM-10] probed ${results.length} Alloc: no methods, all < 1 byte/call.`);
});

// ---------------------------------------------------------------------------
// A second, independent reading at N=4e6 for the container/belt hot path
// (canPlace + place/remove), reproducing this project's own decaying-mean
// curve (80.45 -> 17.88 -> 0.391 -> 0.325 B/call, N=10k -> 4e6) as an
// explicit, separate proof rather than relying on assertAllocationFree's
// single converged reading alone.
// ---------------------------------------------------------------------------

test('12.ITMS-C2 place()/remove() marginal bytes/call between N=1e6 and N=4e6 (O-43 methodology)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { sys } = await makeSystem(13);
  const item = makeItem('potion_life_minor');
  sys.place('stash', item, 0, 0);
  let atOrigin = false;
  const runOneCall = () => {
    sys.remove(item);
    sys.place('stash', item, atOrigin ? 0 : 1, 0);
    atOrigin = !atOrigin;
  };

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  console.log(`  place()+remove() alloc: N=1e6 ${atOneMillion.toFixed(4)} B/call, N=4e6 ${atFourMillion.toFixed(4)} B/call, marginal ${marginalBytesPerCall.toFixed(4)} B/call`);

  if (marginalBytesPerCall >= 1) {
    throw new Error(
      `place()/remove() must allocate < 1 byte/call marginally between N=1e6 and N=4e6; ` +
        `got ${marginalBytesPerCall.toFixed(4)} B/call (N=1e6: ${atOneMillion.toFixed(4)}, N=4e6: ${atFourMillion.toFixed(4)})`,
    );
  }
});
