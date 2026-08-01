// tests/items/mods.perf.test.js
//
// ITEM-7 — `rolledMods`'s `Alloc = no` contract (02-api-contracts.md:962),
// measured, not asserted by reading the source. Named `.perf.test.js` (not
// `.test.js`) per this project's convention so it lands in the isolated
// `--test-concurrency=1` perf stage, not the unit stage (a test that
// asserts allocation/time/frames belongs there, this ticket's brief).
//
// O-43's methodology (already used by tests/combat/resolve.perf.test.js,
// tests/actors/anim.perf.test.js): allocation probes are meaningless below
// ~1e6 iterations on this project's measured noise floor (a genuinely
// allocation-free function reads ~80 B/call at N=10k, ~0.33 B/call at
// N=4e6 — GC/JIT settling, not a leak). Sample `allocatedBytes` directly at
// N=1e6 and N=4e6 and judge by the MARGINAL bytes/call between the two
// totals, never by either mean alone.
//
// The scenario cycles through a magic item, a rare item (with a sharedRoll
// affix) and a unique item on the SAME reused `out` buffer — exactly the
// "tooltip redrawn as the mouse moves across different items in the
// inventory" call shape rolledMods exists for. `out` reaches its high-water
// mark (8 entries, the rare item's own count) within the first few calls;
// every call after that reuses existing entry objects and allocates
// nothing, which is the steady-state this gate measures.

import test from 'node:test';

import { allocatedBytes, hasGc } from '../helpers/alloc.js';
import { UNIQUES_BY_ID } from '../../src/items/data/uniques.js';
import { rolledMods } from '../../src/items/mods.js';

function magicItem() {
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

function rareArmourItem() {
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

function uniqueItem() {
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

test('12.ITMS-M rolledMods allocates < 1 byte/call marginally between N=1e6 and N=4e6 on a warm out buffer (O-43 methodology)', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const items = [magicItem(), rareArmourItem(), uniqueItem()];
  const out = [];
  let i = 0;
  const runOneCall = () => {
    rolledMods(items[i], out);
    i = (i + 1) % items.length;
  };

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);

  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  console.log(`  rolledMods alloc: N=1e6 ${atOneMillion.toFixed(4)} B/call, N=4e6 ${atFourMillion.toFixed(4)} B/call, marginal ${marginalBytesPerCall.toFixed(4)} B/call`);

  if (marginalBytesPerCall >= 1) {
    throw new Error(
      `rolledMods must allocate < 1 byte/call marginally between N=1e6 and N=4e6; ` +
        `got ${marginalBytesPerCall.toFixed(4)} B/call (N=1e6: ${atOneMillion.toFixed(4)} B/call, N=4e6: ${atFourMillion.toFixed(4)} B/call)`,
    );
  }
});
