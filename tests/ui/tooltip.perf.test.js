// tests/ui/tooltip.perf.test.js
//
// UI-5's own `Alloc: no` gate for the steady per-frame path (`showTooltip`
///`hideTooltip`/`setAltHeld` are content-change events, not per-frame — see
// `tooltip.js`'s own header — so the gate this file proves is `update()`
// called every frame with NOTHING changed: the same item reference, the
// same anchor, the same Alt state, the same viewport). Named
// `.perf.test.js` per D-11 — picked up by `npm run test:perf` and excluded
// from `test:unit` by name.
//
// O-43/O-23 methodology: a probe below ~1M iterations is noise, not
// signal — sampled at N=1e6 and N=4e6, judged by the marginal bytes
// between the two totals (`tests/helpers/alloc.js`'s own doc block).

import test from 'node:test';
import assert from 'node:assert/strict';

import { Tooltip } from '../../src/ui/tooltip.js';
import { el } from '../../src/ui/util.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';

const AXE_BASE = {
  id: 'axe_battle_test', name: 'Battle Axe', category: 'weapon', slot: 'mainHand', tier: 'normal',
  reqLevel: 9, reqStr: 40, reqDex: 0, invW: 2, invH: 3, maxDurability: 55, baseValue: 220,
  dropWeight: 100, iconSeed: 1, surface: 'metal', genderRu: 'm',
  weapon: { minDamage: 10, maxDamage: 20, attackTime: 1.0, attackRating: 80, twoHanded: true, range: 1.9, handling: 'twoHandMelee', element: 'physical' },
  allowedAffixGroups: ['weapon.melee', 'weapon.any', 'universal'], socketMax: 0,
};

const MOD_BUF = [
  { stat: 'enhancedDamage', value: 50, min: 30, max: 50, source: 'affix', affixId: 'pfx_ed', kind: 'prefix' },
  { stat: 'fireMin', value: 6, min: 4, max: 8, source: 'affix', affixId: 'pfx_fire', kind: 'prefix' },
  { stat: 'fireMax', value: 14, min: 10, max: 16, source: 'affix', affixId: 'pfx_fire', kind: 'prefix' },
  { stat: 'attackRating', value: 15, min: 10, max: 20, source: 'affix', affixId: 'sfx_ar', kind: 'suffix' },
];

function makeItem() {
  return {
    uid: 1, baseId: 'axe_battle_test', rarity: 'rare', ilvl: 12, identified: true, quantity: 1,
    rolls: { defense: 0, superior: 0, damageMin: 10, damageMax: 20 },
    affixes: [], uniqueId: null, uniqueValues: [], nameOverride: null,
    durability: 42, maxDurability: 55, sockets: [], socketCount: 0,
    grid: null, slot: null, ground: null,
    _cache: { stats: null, displayName: 'Doom Bane of the Legion', sellValue: 0, iconCanvas: null, unusable: false },
  };
}

function makeCtx() {
  const items = {
    base: (id) => (id === 'axe_battle_test' ? AXE_BASE : null),
    rolledMods: (item, out) => {
      for (let i = 0; i < MOD_BUF.length; i++) {
        if (!out[i]) out[i] = {};
        Object.assign(out[i], MOD_BUF[i]);
      }
      return MOD_BUF.length;
    },
  };
  return {
    canvas: { width: 1920, height: 1080 },
    input: { pointer: { x: 300, y: 300 } },
    get(id) { return id === 'items' ? items : null; },
    peek(id) { return id === 'items' ? items : null; },
  };
}

test('12.A0x: Tooltip#update(dt, ctx) steady-state (already open, nothing changed) allocates < 1 byte/call at N=1e6..4e6', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const layer = el('div', 'cl2-layer');
  const tooltip = new Tooltip({}, layer, (k) => k, null);
  const ctx = makeCtx();
  const item = makeItem();

  tooltip.showTooltip(item, 500, 500, false);
  // Warm-up: let the fade settle to opacity===1 and the content/placement
  // build happen (both are legitimately allocating, content-change work —
  // excluded from the timed section, same as `hudstate.perf.test.js`'s own
  // warm-up-then-measure shape).
  for (let i = 0; i < 200; i++) tooltip.update(0.016, ctx);
  assert.ok(tooltip.__isVisible(), 'must be fully open before the steady-state probe starts');

  const call = () => tooltip.update(0.016, ctx);

  const r1 = assertAllocationFree(call, { iterations: 1_000_000 });
  const r2 = assertAllocationFree(call, { iterations: 4_000_000 });
  assert.ok(r1.bytesPerCall < 1);
  assert.ok(r2.bytesPerCall < 1);
});

test('12.A0x: Tooltip#update(dt, ctx) while hidden (never shown) is also allocation-free', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }
  const layer = el('div', 'cl2-layer');
  const tooltip = new Tooltip({}, layer, (k) => k, null);
  const ctx = makeCtx();
  const call = () => tooltip.update(0.016, ctx);
  for (let i = 0; i < 10; i++) call();

  const r1 = assertAllocationFree(call, { iterations: 1_000_000 });
  assert.ok(r1.bytesPerCall < 1);
});
