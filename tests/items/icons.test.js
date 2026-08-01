// tests/items/icons.test.js
//
// ITEM-15 acceptance tests for `src/items/icons/*` and the `icon`/
// `__iconGenerate` wiring on `ItemsSystem` (`src/items/index.js`).
// `node:test` + `node:assert/strict` only, matching every sibling test file
// in this repo (`tests/items/quality.test.js`, `tests/items/containers.test.js`).
//
// ---------------------------------------------------------------------------
// The headless ceiling, and the test-form rule
// ---------------------------------------------------------------------------
// `src/items/` runs in bare Node except that real icon RENDERING needs
// `OffscreenCanvas` (ruling D-24), which does not exist in this Node
// (`typeof OffscreenCanvas === 'undefined'` — verified below). So the real
// render/distinctness/timing proof lives in `tools/iconbench.mjs` (headless
// Chromium, where `OffscreenCanvas` is real) — see this ticket's report for
// that tool's output. What THIS file proves, entirely in plain Node:
//   - `selectRecipe` (pure, no canvas) is correct, including ruling D-24's
//     fix (`mace_`/`hammer_`/`maul_` -> `mace`, exactly THREE maul bases)
//     and the `bow` implemented-but-unreachable shape.
//   - Every `RECIPES[id]` drawing function runs to completion against a
//     duck-typed recording fake 2D context without throwing, for the real
//     base(s) that select it — the test-form rule's "routes into production
//     code and yields a well-formed result", applied to the one part of the
//     pipeline that doesn't need a real canvas to exercise.
//   - `./cache.js`'s key packing is injective across the full real keyspace,
//     and its LRU (parallel `Int32Array`s + a plain slot array, no `Map`)
//     evicts/protects correctly.
//   - `ItemsSystem#icon`/`#__iconGenerate` return an EXPLICIT `null` in this
//     Node — never throw — for both "no recipe" and "no OffscreenCanvas"
//     dead ends, and touch `sys.rng` (the `items` RNG stream) ZERO times,
//     which is the empirical half of this ticket's "icon generation draws
//     nothing against the items stream" proof (the other half —
//     `generateIconCanvas` never even takes an `Rng` argument from a
//     caller, only ever constructing its own from `ItemBase.iconSeed` — is
//     structural, see `src/items/icons/generate.js`).

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../src/core/rng.js';
import { ItemsSystem } from '../../src/items/index.js';
import { ITEM_BASES, ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';
import { selectRecipe, RECIPES } from '../../src/items/icons/recipes.js';
import { rampFor, tintHex, tintRamp } from '../../src/items/icons/ramps.js';
import { applyRarityFrame, applyOverlays } from '../../src/items/icons/rarity.js';
import { createIconCache, cacheGet, cachePut, keyFor, KEYSPACE } from '../../src/items/icons/cache.js';
import { generateIconCanvas, canGenerateIcons } from '../../src/items/icons/generate.js';

test('ITMS.I00 loads headless in plain Node with no browser globals, and OffscreenCanvas is absent here', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof OffscreenCanvas, 'undefined');
  assert.equal(canGenerateIcons(), false);
});

// ---------------------------------------------------------------------------
// selectRecipe — ruling D-24's fix, and the full-catalogue sweep
// ---------------------------------------------------------------------------

test('ITMS.I10 mace/hammer/maul selector: exactly three maul_ bases, all -> mace (ruling D-24)', () => {
  const mauls = ITEM_BASES.filter((b) => b.id.startsWith('maul_'));
  assert.equal(mauls.length, 3, '04-items.md §11.3/§14.2 C-4 say four; the live catalogue has three — this is the reported miscount');
  for (const b of mauls) assert.equal(selectRecipe(b), 'mace', `${b.id} must select 'mace'`);

  const maceHammer = ITEM_BASES.filter((b) => b.id.startsWith('mace_') || b.id.startsWith('hammer_'));
  assert.ok(maceHammer.length > 0);
  for (const b of maceHammer) assert.equal(selectRecipe(b), 'mace');
});

test('ITMS.I11 bow stays selectable but is unreachable by any real base', () => {
  const fakeBow = { category: 'weapon', id: 'bow_test_fixture', weapon: { handling: 'bow', twoHanded: true } };
  assert.equal(selectRecipe(fakeBow), 'bow', 'the bow recipe must still be reachable in principle (04 §11.3 item 2: kept for post-M9 content)');

  const realBows = ITEM_BASES.filter((b) => b.weapon && b.weapon.handling === 'bow');
  assert.equal(realBows.length, 0, '03-combat-math.md §4.1: no base in the player set has bow handling — bow is dead code today, as documented');
});

test('ITMS.I12 unarmed selects no recipe (never throws, explicit null)', () => {
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.unarmed), null);
});

test('ITMS.I13 selectRecipe never throws on a falsy/malformed base', () => {
  assert.equal(selectRecipe(null), null);
  assert.equal(selectRecipe(undefined), null);
  assert.equal(selectRecipe({}), null);
  assert.equal(selectRecipe({ category: 'weapon' }), null); // no .weapon field
});

test('ITMS.I14 every one of the 75 bases resolves to null or a real RECIPES key', () => {
  for (const base of ITEM_BASES) {
    const id = selectRecipe(base);
    assert.ok(id === null || Object.prototype.hasOwnProperty.call(RECIPES, id), `${base.id} -> '${id}' is not a registered recipe`);
  }
});

test('ITMS.I15 the 61 equipment bases (weapon excl. unarmed + armour + jewelry) all select a real recipe', () => {
  const equipment = ITEM_BASES.filter((b) => (b.category === 'weapon' && b.id !== 'unarmed') || b.category === 'armour' || b.category === 'jewelry');
  assert.equal(equipment.length, 61, '04-items.md §12 step 11 / this ticket\'s acceptance criterion: 61 equipment bases');
  for (const b of equipment) {
    const id = selectRecipe(b);
    assert.notEqual(id, null, `${b.id} (category=${b.category}, slot=${b.slot}) selected no recipe`);
  }
});

test('ITMS.I16 category selectors: shield/helm/chest/gloves/boots/belt/ring/amulet/potion/scroll/quest', () => {
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.shield_buckler_normal), 'shield');
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.helm_cap_normal), 'helm');
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.armour_rags), 'chest');
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.gloves_wraps_normal), 'gloves');
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.boots_hide_normal), 'boots');
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.belt_sash_normal), 'belt');
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.ring_iron), 'ring');
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.amulet_cord), 'amulet');
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.potion_life_minor), 'potion');
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.scroll_identify), 'scroll');
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.quest_first_tablet), 'quest');
});

test('ITMS.I17 sword1h vs sword2h, axe1h split correctly on weapon.twoHanded', () => {
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.sword_short_normal), 'sword1h');
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.sword_great_exceptional), 'sword2h');
  assert.equal(selectRecipe(ITEM_BASES_BY_ID.axe_battle_normal), 'axe1h');
});

// ---------------------------------------------------------------------------
// A duck-typed recording fake 2D context — see this file's header
// ---------------------------------------------------------------------------

function makeFakeCtx2D() {
  const calls = [];
  const gradient = { addColorStop() {} };
  const target = {};
  const handler = {
    get(t, prop) {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return (...args) => { calls.push([String(prop), args]); return gradient; };
      }
      if (Object.prototype.hasOwnProperty.call(t, prop)) return t[prop];
      return (...args) => { calls.push([String(prop), args]); return undefined; };
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
  };
  return { g: new Proxy(target, handler), calls };
}

/** A representative content-box `ctx` for a recipe draw call — mirrors what
 * `src/items/icons/generate.js` builds (4 px margin already subtracted). */
function makeRecipeCtx(base, w = 128, h = 192) {
  const bx = 4, by = 4, bw = w - 8, bh = h - 8;
  return {
    bx, by, bw, bh, cx: bx + bw / 2, cy: by + bh / 2,
    ramp: rampFor(base.surface),
    tier: base.tier,
    base,
  };
}

test('ITMS.I20 every registered recipe draws without throwing, against the real base(s) that select it', () => {
  const byRecipe = new Map();
  for (const base of ITEM_BASES) {
    const id = selectRecipe(base);
    if (!id) continue;
    if (!byRecipe.has(id)) byRecipe.set(id, base);
  }
  // Unreachable-by-any-real-base recipes still get a synthetic fixture, so
  // this test covers every key in RECIPES, not just the reachable ones.
  if (!byRecipe.has('bow')) byRecipe.set('bow', { id: 'bow_fixture', surface: 'wood', tier: 'normal', category: 'weapon', invW: 2, invH: 4, iconSeed: 0x1234, weapon: { handling: 'bow', twoHanded: true } });
  if (!byRecipe.has('axe2h')) byRecipe.set('axe2h', { id: 'axe2h_fixture', surface: 'metal', tier: 'elite', category: 'weapon', invW: 2, invH: 4, iconSeed: 0x5678, weapon: { handling: 'twoHandMelee', twoHanded: true } });

  const recipeIds = Object.keys(RECIPES);
  assert.ok(recipeIds.length >= 15, 'sanity: the recipe table should have most of 09-ui.md §7.3\'s rows');

  for (const id of recipeIds) {
    const base = byRecipe.get(id);
    assert.ok(base, `no fixture base for recipe '${id}'`);
    const { g, calls } = makeFakeCtx2D();
    const rng = new Rng((base.iconSeed >>> 0) || 1);
    const recipeCtx = makeRecipeCtx(base);
    assert.doesNotThrow(() => RECIPES[id](g, rng, recipeCtx), `recipe '${id}' threw drawing ${base.id}`);
    assert.ok(calls.length > 0, `recipe '${id}' drew nothing (zero canvas calls) for ${base.id}`);
  }
});

test('ITMS.I21 the wear/grime/rim post-passes and rarity framing/overlays draw without throwing', () => {
  const { g: g1 } = makeFakeCtx2D();
  const rng = new Rng(0xabc);
  // Exercised through generateIconCanvas's own call shape is not possible
  // here (no OffscreenCanvas) — these are called directly instead, the
  // same "duck-typed fake, no real canvas needed" approach ITMS.I20 uses.
  assert.doesNotThrow(() => applyRarityFrame(g1, 'normal', 64, 64));
  for (const rarity of ['superior', 'magic', 'rare', 'unique']) {
    const { g } = makeFakeCtx2D();
    assert.doesNotThrow(() => applyRarityFrame(g, rarity, 128, 192), `rarity frame '${rarity}' threw`);
  }
  assert.doesNotThrow(() => applyRarityFrame(g1, 'not-a-real-rarity', 64, 64), 'an unknown rarity must be a no-op, not a throw');

  const { g: g2 } = makeFakeCtx2D();
  assert.doesNotThrow(() => applyOverlays(g2, { socketCount: 3, identified: false, durability: 0, maxDurability: 40 }, 64, 64));
  void rng;
});

// ---------------------------------------------------------------------------
// ramps.js — tint math
// ---------------------------------------------------------------------------

test('ITMS.I30 tintHex/tintRamp are pure and shift colour deterministically', () => {
  const a = tintHex('#7d8790', 10, 0.05);
  const b = tintHex('#7d8790', 10, 0.05);
  assert.equal(a, b, 'same inputs must give the same output (deterministic, no hidden RNG)');
  const c = tintHex('#7d8790', -10, -0.05);
  assert.notEqual(a, c, 'a different shift must (almost always) produce a different colour');

  const ramp = rampFor('metal');
  const tinted = tintRamp(ramp, 12, 0.04);
  assert.notEqual(tinted.dark, ramp.dark);
  assert.equal(ramp.dark, '#3a4048', 'tintRamp must not mutate the frozen SURFACE_RAMPS entry');
});

test('ITMS.I31 rampFor never throws on an unknown/missing surface', () => {
  assert.doesNotThrow(() => rampFor('not-a-real-surface'));
  assert.doesNotThrow(() => rampFor(undefined));
  const r = rampFor('not-a-real-surface');
  assert.ok(r.dark && r.mid && r.light);
});

// ---------------------------------------------------------------------------
// cache.js — key packing (injective) and the array-based LRU
// ---------------------------------------------------------------------------

test('ITMS.I40 keyFor is injective across the full real keyspace (no Map, no collisions)', () => {
  const rarities = ['normal', 'superior', 'magic', 'rare', 'unique'];
  const seen = new Set();
  let count = 0;
  for (const base of ITEM_BASES) {
    for (const rarity of rarities) {
      for (let socketCount = 0; socketCount <= 6; socketCount++) {
        for (const superior of [false, true]) {
          const key = keyFor(base.id, rarity, socketCount, superior);
          assert.ok(key >= 0 && key < KEYSPACE, `key ${key} out of range [0,${KEYSPACE})`);
          seen.add(key);
          count++;
        }
      }
    }
  }
  assert.equal(seen.size, count, 'every (baseId,rarity,socketCount,superior) tuple must pack to a distinct integer');
});

test('ITMS.I41 keyFor returns -1 (never throws) for an unresolvable baseId/rarity', () => {
  assert.equal(keyFor('not_a_real_base', 'normal', 0, false), -1);
  assert.equal(keyFor('axe_battle_normal', 'not_a_real_rarity', 0, false), -1);
});

test('ITMS.I42 keyFor clamps an out-of-range socketCount instead of throwing or corrupting the key', () => {
  const over = keyFor('axe_battle_normal', 'normal', 99, false);
  const atMax = keyFor('axe_battle_normal', 'normal', 6, false);
  assert.equal(over, atMax);
  const under = keyFor('axe_battle_normal', 'normal', -5, false);
  const atMin = keyFor('axe_battle_normal', 'normal', 0, false);
  assert.equal(under, atMin);
});

test('ITMS.I43 createIconCache uses typed/plain arrays, not a Map', () => {
  const state = createIconCache(192);
  assert.equal(state.capacity, 192);
  assert.ok(state.lookup instanceof Int32Array);
  assert.ok(state.slotKey instanceof Int32Array);
  assert.ok(state.prev instanceof Int32Array);
  assert.ok(state.next instanceof Int32Array);
  assert.ok(Array.isArray(state.canvases));
  assert.equal(state.lookup instanceof Map, false);
  assert.equal(state.canvases instanceof Map, false);
});

test('ITMS.I44 cachePut/cacheGet round-trip, and a miss returns null', () => {
  const state = createIconCache(4);
  const key = keyFor('ring_iron', 'normal', 0, false);
  assert.equal(cacheGet(state, key), null);
  const fakeCanvas = { marker: 'ring_iron/normal' };
  cachePut(state, key, fakeCanvas);
  assert.equal(cacheGet(state, key), fakeCanvas);
});

test('ITMS.I45 LRU eviction: the least-recently-used entry is dropped first, and touching protects it', () => {
  const capacity = 4;
  const state = createIconCache(capacity);
  const keys = ['ring_iron', 'ring_bone', 'ring_gilt', 'amulet_cord'].map((id) => keyFor(id, 'normal', 0, false));
  for (let i = 0; i < keys.length; i++) cachePut(state, keys[i], { i });
  // Touch the first-inserted key so it becomes MRU, not LRU.
  assert.notEqual(cacheGet(state, keys[0]), null);
  // Insert one more — the cache is full, so the current LRU tail (keys[1],
  // the oldest UNTOUCHED entry) must be evicted, not keys[0].
  const newKey = keyFor('amulet_reliquary', 'normal', 0, false);
  cachePut(state, newKey, { i: 4 });

  assert.notEqual(cacheGet(state, keys[0]), null, 'the touched entry must survive eviction');
  assert.equal(cacheGet(state, keys[1]), null, 'the untouched, oldest entry must be evicted');
  assert.notEqual(cacheGet(state, keys[2]), null);
  assert.notEqual(cacheGet(state, keys[3]), null);
  assert.notEqual(cacheGet(state, newKey), null);
});

test('ITMS.I46 cachePut/cacheGet on key=-1 (unresolvable) is a well-formed no-op, never a throw', () => {
  const state = createIconCache(4);
  assert.equal(cachePut(state, -1, { x: 1 }), false);
  assert.equal(cacheGet(state, -1), null);
});

// ---------------------------------------------------------------------------
// generate.js — the headless-Node refusal path (test-form rule)
// ---------------------------------------------------------------------------

test('ITMS.I50 generateIconCanvas returns null (never throws) for a real base in headless Node', () => {
  assert.doesNotThrow(() => {
    const result = generateIconCanvas(ITEM_BASES_BY_ID.axe_battle_normal, { rarity: 'rare' });
    assert.equal(result, null);
  });
});

test('ITMS.I51 generateIconCanvas returns null for a base with no recipe, and for a falsy base', () => {
  assert.equal(generateIconCanvas(ITEM_BASES_BY_ID.unarmed, {}), null);
  assert.equal(generateIconCanvas(null, {}), null);
  assert.equal(generateIconCanvas(undefined, {}), null);
});

// ---------------------------------------------------------------------------
// ItemsSystem#icon / #__iconGenerate wiring, and the zero-RNG-draw proof
// ---------------------------------------------------------------------------

let _ctxSeed = 1;
function makeCtx() {
  return {
    rng: new Rng(_ctxSeed++),
    time: { step: 0 },
    get(id) {
      throw new Error(`stub ctx.get: '${id}' is not available in this test`);
    },
  };
}

async function makeSystem() {
  const sys = new ItemsSystem();
  await sys.init(makeCtx());
  return sys;
}

function makeItem(baseId, rarity = 'normal') {
  const base = ITEM_BASES_BY_ID[baseId];
  return {
    uid: 1,
    baseId,
    rarity,
    ilvl: base ? base.reqLevel : 1,
    identified: true,
    quantity: 1,
    rolls: { defense: 0, superior: rarity === 'superior' ? 10 : 0, damageMin: 0, damageMax: 0 },
    affixes: [],
    uniqueId: null, uniqueValues: [], nameOverride: null,
    durability: base ? base.maxDurability : 1,
    maxDurability: base ? base.maxDurability : 1,
    sockets: [], socketCount: 0,
    grid: null, slot: null, ground: null,
  };
}

test('ITMS.I60 ItemsSystem#icon returns null in headless Node for a resolvable item (never throws)', async () => {
  const sys = await makeSystem();
  assert.doesNotThrow(() => {
    const result = sys.icon(makeItem('axe_battle_normal', 'rare'));
    assert.equal(result, null);
  });
});

test('ITMS.I61 ItemsSystem#icon returns null for a missing item / unknown baseId (never throws)', async () => {
  const sys = await makeSystem();
  assert.equal(sys.icon(null), null);
  assert.equal(sys.icon(undefined), null);
  assert.equal(sys.icon({ baseId: 'not_a_real_base', rarity: 'normal' }), null);
});

test('ITMS.I62 ItemsSystem#__iconGenerate (the dev/tooling hook) is reachable and returns null in headless Node', async () => {
  const sys = await makeSystem();
  assert.equal(typeof sys.__iconGenerate, 'function');
  assert.equal(sys.__iconGenerate(ITEM_BASES_BY_ID.armour_sepulchre_elite, { rarity: 'unique' }), null);
});

test('ITMS.I63 icon() touches the items RNG stream (sys.rng) zero times — proves it never draws from ctx.rng/this.rng', async () => {
  const sys = new ItemsSystem();
  const ctx = makeCtx();
  await sys.init(ctx);

  let interactions = 0;
  const tracked = new Proxy(sys.rng, {
    get(target, prop, receiver) {
      interactions++;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  sys.rng = tracked;

  sys.icon(makeItem('axe_battle_normal', 'normal'));
  sys.icon(makeItem('helm_gravemask_elite', 'unique'));
  sys.icon(makeItem('ring_iron', 'magic'));
  sys.__iconGenerate(ITEM_BASES_BY_ID.armour_sepulchre_elite, { rarity: 'rare' });

  assert.equal(interactions, 0, `expected zero interactions with sys.rng; got ${interactions}`);
});
