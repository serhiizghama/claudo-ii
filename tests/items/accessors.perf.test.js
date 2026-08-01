// tests/items/accessors.perf.test.js
//
// ITEM-19 — `Alloc: no` proof for the `items` data/rolling accessors
// (`02-api-contracts.md` §11), across two rounds:
//   round 1: `base`, `bases`, `affix`, `unique`.
//   round 3: `resolveTC`, `rolledMods` — see the file's bottom section for
//     why `rollName` is deliberately NOT probed here despite its contract
//     row also saying `Alloc: no`.
// Measured, not asserted by reading the source. Named `.perf.test.js` (not
// `.test.js`) per this project's convention so it lands in the isolated
// `--test-concurrency=1` perf stage, not the unit stage.
//
// O-43's methodology (tests/items/mods.perf.test.js, tests/core/alloc.test.js's
// `12.A01`): allocation probes are meaningless below ~1e6 iterations on this
// project's measured noise floor — a genuinely allocation-free function
// reads ~80 B/call at N=10k, decaying to a fraction of a byte only around
// N=1e6-4e6 (GC/JIT settling, not a leak). `tests/helpers/alloc.js`'s
// `assertAllocationFree` samples at iterations >= 1e6 and resamples (never
// re-running the whole *test*, see that helper's own header) until a round
// reads below the 1 byte/call threshold, bounded by `maxRounds`.
//
// Each probe cycles through every shipped id (75 bases / 117 affixes / 8
// uniques) rather than hammering a single id, so a hidden per-distinct-key
// cost (e.g. a `Map` that grows on unseen keys) cannot hide behind a
// monomorphic call site — the prebuilt `*_BY_ID` index this ticket reads is
// built once at module load and every id below is already in it.
//
// These accessors also belong on `tests/core/alloc.test.js`'s `12.A01`
// probe list per this ticket's brief — that file is not this ticket's to
// edit; see the report for the exact entries to add.

import test from 'node:test';

import { allocatedBytes, assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { ItemsSystem } from '../../src/items/index.js';
import { DETERMINISTIC_SEED } from '../helpers/seed.js';
import { ITEM_BASES } from '../../src/items/data/bases.js';
import { AFFIXES } from '../../src/items/data/affixes.js';
import { UNIQUES, UNIQUES_BY_ID } from '../../src/items/data/uniques.js';
import { resetRareRing } from '../../src/items/names.js';

async function makeRegistryCtx() {
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
  registry.add(ItemsSystem);
  await registry.init(ctx);
  return ctx;
}

test('12.ITMS-N items.base/bases/affix/unique allocate < 1 byte/call (O-43 methodology, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  const baseIds = ITEM_BASES.map((b) => b.id);
  const affixIds = AFFIXES.map((a) => a.id);
  const uniqueIds = UNIQUES.map((u) => u.id);

  let bi = 0;
  let ai = 0;
  let ui = 0;

  const probes = [
    {
      name: 'items.base(id) — cycling all 75 ids',
      fn: () => {
        items.base(baseIds[bi]);
        bi = (bi + 1) % baseIds.length;
      },
    },
    {
      name: 'items.bases (property read)',
      fn: () => {
        // eslint-disable-next-line no-unused-expressions
        items.bases;
      },
    },
    {
      name: 'items.affix(id) — cycling all 117 ids',
      fn: () => {
        items.affix(affixIds[ai]);
        ai = (ai + 1) % affixIds.length;
      },
    },
    {
      name: 'items.unique(id) — cycling all 8 ids',
      fn: () => {
        items.unique(uniqueIds[ui]);
        ui = (ui + 1) % uniqueIds.length;
      },
    },
  ];

  for (const probe of probes) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: 1_000_000, maxRounds: 40 });
    console.log(`[ITEM-19] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=1e6`);
    if (bytesPerCall >= 1) {
      throw new Error(`${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
    }
  }
});

// ===========================================================================
// Round 3 — resolveTC, rolledMods
// ===========================================================================

function magicItemFixture() {
  return {
    baseId: 'axe_battle_normal',
    rarity: 'magic',
    rolls: { defense: 0, superior: 0, damageMin: 10, damageMax: 22 },
    affixes: [
      { id: 'pfx_enhanced_damage_3', kind: 'prefix', values: [40] },
      { id: 'sfx_attack_rating_2', kind: 'suffix', values: [15] },
    ],
    uniqueId: null,
    uniqueValues: [],
  };
}

function rareArmourItemFixture() {
  return {
    baseId: 'helm_coif_normal',
    rarity: 'rare',
    rolls: { defense: 15, superior: 0, damageMin: 0, damageMax: 0 },
    affixes: [
      { id: 'pfx_enhanced_damage_3', kind: 'prefix', values: [45] },
      { id: 'sfx_res_all_1', kind: 'suffix', values: [7, 7, 7, 7, 7, 7] },
    ],
    uniqueId: null,
    uniqueValues: [],
  };
}

function uniqueItemFixture() {
  const def = UNIQUES_BY_ID.ashen_crown;
  return {
    baseId: 'helm_coif_normal',
    rarity: 'unique',
    rolls: { defense: 12, superior: 0, damageMin: 0, damageMax: 0 },
    affixes: [],
    uniqueId: 'ashen_crown',
    uniqueValues: def.mods.map((m) => m.min),
  };
}

test('12.ITMS-N2 items.resolveTC/rolledMods allocate < 1 byte/call (O-43 methodology, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ctx = await makeRegistryCtx();
  const items = ctx.get('items');

  const families = ['tc_humanoid', 'tc_swarm', 'tc_caster', 'tc_heavy', 'tc_potion', 'tc_boss'];
  let fi = 0;
  let mlvl = 1;

  // `rolledMods` needs a warm `out` (see tests/items/mods.perf.test.js's own
  // header) so the entry-object reuse path is what gets measured, not the
  // first-touch `.push()` growth.
  const modsItems = [magicItemFixture(), rareArmourItemFixture(), uniqueItemFixture()];
  const modsOut = [];
  let mi = 0;

  const probes = [
    {
      name: 'items.resolveTC(family, mlvl) — cycling 6 families x mlvl 1..40',
      fn: () => {
        items.resolveTC(families[fi], mlvl);
        fi = (fi + 1) % families.length;
        mlvl = (mlvl % 40) + 1;
      },
    },
    {
      name: 'items.rolledMods(item, out) — cycling magic/rare/unique, warm out',
      fn: () => {
        items.rolledMods(modsItems[mi], modsOut);
        mi = (mi + 1) % modsItems.length;
      },
    },
  ];

  for (const probe of probes) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: 1_000_000, maxRounds: 40 });
    console.log(`[ITEM-19] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=1e6`);
    if (bytesPerCall >= 1) {
      throw new Error(`${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// rollName — deliberately NOT a passing `Alloc: no` gate. Diagnostic only.
//
// `02-api-contracts.md:966` / `13-progression-lore.md` §13.4 both say
// `rollName` is `Alloc: no`, but `rollName` is a one-line forward to
// `./names.js#rollRareName`, and THAT function's own already-accepted
// (ITEM-8) header says plainly: "[composeRareName] allocates the two result
// strings (inherent, not a per-frame path...) and nothing else." A fresh
// `{headIndex, tailIndex, code, en, ru}` object plus two freshly
// concatenated strings is built on every call — there is no reuse path, so
// this cannot read as truly allocation-free.
//
// A naive probe in this project's usual shape (discard the return value,
// measure at N=1e6) WOULD read near zero here — but that is a measurement
// ARTIFACT, not evidence of zero allocation: when nothing retains
// `rollName`'s result, an automatic minor GC silently reclaims each call's
// garbage before `allocatedBytes` ever samples `heapUsed`, regardless of N.
// Forcing retention (writing each result into a ring buffer big enough to
// survive a minor GC, so growth is measured honestly) unmasks the real
// number: it does NOT decay toward zero as N grows the way a genuinely
// allocation-free probe does (see the passing probes above, and O-43's own
// reference curve in this file's header) — it stays in the tens of bytes
// per call. Printed below for the record; this test intentionally does NOT
// throw on it, because the actual defect is the contract row, not this
// method's implementation (a one-line delegation to an already-accepted
// function cannot itself be "fixed" to stop allocating without changing
// `rollRareName`'s own accepted behaviour, which is out of this ticket's
// file allowlist). Reported to the orchestrator as a `02:966` correction
// candidate, the same way `rollItem`'s stale signature row was.
// ---------------------------------------------------------------------------

test('12.ITMS-N3 items.rollName is NOT allocation-free (diagnostic — see comment above, not a gate)', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const items = new ItemsSystem();
  const item = { baseId: 'axe_battle_normal', rarity: 'rare', nameOverride: null };

  // Retention ring big enough to outlive a minor GC — without this, the
  // reading falsely decays toward 0 (see comment above).
  const retained = new Array(5000).fill(null);
  let ri = 0;
  const runOneCall = () => {
    items.rollName(item, new Rng(ri)); // varying seed so every call draws a fresh code
    retained[ri % retained.length] = item.nameOverride;
    ri++;
  };

  resetRareRing();
  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  resetRareRing();
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);

  console.log(
    `[ITEM-19] items.rollName(item, rng) [retained, honest]: N=1e6 ${atOneMillion.toFixed(4)} B/call, ` +
      `N=4e6 ${atFourMillion.toFixed(4)} B/call — does not decay toward 0 like a genuinely alloc-free probe ` +
      `(compare the passing probes above); this is real, inherent allocation, not noise. ` +
      `02-api-contracts.md:966's "Alloc: no" for rollName is a stale/incorrect row, same category as ` +
      `rollItem's already-flagged stale signature.`,
  );
});
