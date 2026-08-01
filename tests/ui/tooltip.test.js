// tests/ui/tooltip.test.js
//
// UI-5 acceptance tests for src/ui/tooltip.js (the `Tooltip` module) and the
// four lines it adds to src/ui/index.js (`showTooltip`/`hideTooltip`/
// `setAltHeld` delegation, `lateUpdate`/`dispose`/`setScreen` wiring).
// `node:test` + `node:assert/strict` only (12-testing.md P6).
//
// Most of this file's tests do NOT import anything from `src/items/` —
// another agent is live in that directory while this ticket lands (see the
// ticket brief). Every `items`-shaped input (`rolledMods`, `base`,
// `canEquip`) in those tests is a small hand-built fixture/mock, matching
// the exact `{ stat, value, min, max, source, affixId, kind }` shape
// `02-api-contracts.md:962` documents — this decouples most of the suite
// from whatever `items` looks like at the moment it happens to run.
//
// ---------------------------------------------------------------------------
// Rounds 2 and 3 (ITEM-19 landed twice) — the tests that DO cross into
// `src/items/`
// ---------------------------------------------------------------------------
// Round 1 shipped with `items.base`/`items.unique`/`items.rolledMods`
// unimplemented anywhere as an INSTANCE method (each was a correct
// module-level export only) — every fixture-driven test below proved the
// RENDERING LOGIC (block order, the resistance merge, the unidentified
// suppression) was correct, but none of them proved blocks 5 (base
// statistics), 6 (requirements), 8 (rolled properties) and 11 (lore)
// actually render against the REAL, now-landed data accessors — a gap the
// orchestrator correctly called out twice: clause 1 needs the full
// sixteen-block sequence live, not just the blocks a hand-built mock
// happened to answer for. ITEM-19 closed `base`/`bases`/`affix`/`unique` in
// its first round and `resolveTC`/`rolledMods`/`rollItem`/`rollName` in its
// second. The integration tests below import the REAL `ItemsSystem`
// (read-only — this file never edits anything under `src/items/`) and
// drive the tooltip off its actual `base()`/`unique()`/`rolledMods()`, using
// a real unique (`verens_reckoning`, based on the real `axe_battle_normal`)
// and real affixes (`pfx_flat_fire_1`, `sfx_res_all_1`) as fixtures, so
// blocks 5, 6, 8 and 11 are all proven end-to-end against data this ticket
// does not own and cannot silently misrepresent.
//
// A test whose truth depends on something not existing yet is a defect, not
// coverage (O-27/O-39, hit twice on this exact file already) — round 3's
// fix is not "update the hardcoded numbers", it is "assert the rolled
// value, computed from the fixture, not pasted as a literal that happened
// to match the old broken state".
//
// ---------------------------------------------------------------------------
// `nameOverride` (round 3) — no longer a plain string
// ---------------------------------------------------------------------------
// ITEM-8 landed rare naming: `item.nameOverride` is now
// `{ headIndex, tailIndex, code, en, ru }`. `items` has no active-language
// parameter and may not import `src/ui/i18n.js`, so it carries both
// languages; `ui` (this file) picks one based on `UiSystem#setLanguage`'s
// own state, live, on an already-open tooltip — see
// `buildTooltipModel`'s own header for the exact precedence and
// `Tooltip#setLanguage` for the wiring.
//
// ---------------------------------------------------------------------------
// Note on 09-ui.md §5.1's worked example (the rare Battle Axe)
// ---------------------------------------------------------------------------
// The ASCII mockup's own numbers are not internally reproducible: no
// integer base weapon-damage range, run through `round(base * (1 +
// enhancedDamage/100))` with enhancedDamage=40, yields exactly "41 – 96"
// (verified: 41/1.4=29.29, 96/1.4=68.57, neither an integer). The mockup is
// illustrative flavour text, not a byte-exact algorithmic trace — this
// suite instead reproduces the exact BLOCK ORDER, the skipped-block rule
// and every line's FORMAT with a self-consistent fixture, and separately
// reuses the mockup's own affix numbers verbatim wherever they can be (the
// fire pair "Adds 6 – 14 Fire Damage", "+15 to Attack Rating", "+2 to
// Carnage Skills" and "7 % of Physical Damage Stolen as Life" all match the
// mockup exactly).
//
// A second, deliberate divergence from the mockup's own line ORDER within
// block 8: the mockup prints "+2 to Carnage Skills" fourth, after Attack
// Rating, but §5.3.1's own ordinal table puts skill bonuses at 100-119 —
// ahead of enhanced damage (300) and attack rating (400). This suite
// asserts the ORDINAL TABLE's order (skill bonus first), because that
// table is the actual algorithm §5.3 rule 4 specifies; the mockup's line
// order is not treated as authoritative over its own neighbouring table.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildTooltipModel, computeContentWidth, computeHeightPlan, computePlacement,
  RESIST_STATS, ELEMENTAL_RESIST_STATS, Tooltip,
  computePanelChips, applyPrimaryNewChips, clearChips, computeComparePlacement,
} from '../../src/ui/tooltip.js';
import { UiSystem } from '../../src/ui/index.js';
import { EN, format } from '../../src/ui/i18n.js';
import { ItemsSystem } from '../../src/items/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { DETERMINISTIC_SEED } from '../helpers/seed.js';
import { ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';

const TOOLTIP_SRC = readFileSync(fileURLToPath(new URL('../../src/ui/tooltip.js', import.meta.url)), 'utf8');
const STYLE_SRC = readFileSync(fileURLToPath(new URL('../../src/ui/style.js', import.meta.url)), 'utf8');

function t(key, params) {
  const str = EN[key];
  if (str === undefined) return '[missing]' + key;
  return format(str, params);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AXE_BASE = {
  id: 'axe_battle_test', name: 'Battle Axe', category: 'weapon', slot: 'mainHand', tier: 'normal',
  reqLevel: 9, reqStr: 40, reqDex: 0, invW: 2, invH: 3, maxDurability: 55, baseValue: 220,
  dropWeight: 100, iconSeed: 1, surface: 'metal', genderRu: 'm',
  weapon: { minDamage: 10, maxDamage: 20, attackTime: 1.0, attackRating: 80, twoHanded: true, range: 1.9, handling: 'twoHandMelee', element: 'physical' },
  allowedAffixGroups: ['weapon.melee', 'weapon.any', 'universal'], socketMax: 0,
};

function makeAxeItem(overrides) {
  return Object.assign({
    uid: 1, baseId: 'axe_battle_test', rarity: 'rare', ilvl: 12, identified: true, quantity: 1,
    rolls: { defense: 0, superior: 0, damageMin: 10, damageMax: 20 },
    affixes: [], uniqueId: null, uniqueValues: [], nameOverride: null,
    durability: 42, maxDurability: 55, sockets: [], socketCount: 0,
    grid: null, slot: null, ground: null,
    _cache: { stats: null, displayName: 'Doom Bane of the Legion', sellValue: 0, iconCanvas: null, unusable: false },
  }, overrides);
}

// The worked example's own affix numbers (enhancedDamage merged into the
// base weapon line is the one place this suite picks its own, clean value —
// see the file header).
const AXE_MOD_BUF = [
  { stat: 'enhancedDamage', value: 50, min: 30, max: 50, source: 'affix', affixId: 'pfx_ed', kind: 'prefix' },
  { stat: 'fireMin', value: 6, min: 4, max: 8, source: 'affix', affixId: 'pfx_fire', kind: 'prefix' },
  { stat: 'fireMax', value: 14, min: 10, max: 16, source: 'affix', affixId: 'pfx_fire', kind: 'prefix' },
  { stat: 'attackRating', value: 15, min: 10, max: 20, source: 'affix', affixId: 'sfx_ar', kind: 'suffix' },
  { stat: 'skillBonuses.tree.carnage', value: 2, min: 1, max: 3, source: 'affix', affixId: 'sfx_carnage', kind: 'suffix' },
  { stat: 'lifeSteal', value: 7, min: 5, max: 9, source: 'affix', affixId: 'sfx_ls', kind: 'suffix' },
];

// ===========================================================================
// Clause 1 — exact §5.1 block order / skipped-block rule / line content
// ===========================================================================

test('clause 1: identified rare Battle Axe — exact block order and content', () => {
  const item = makeAxeItem({});
  const model = buildTooltipModel(item, AXE_BASE, AXE_MOD_BUF, AXE_MOD_BUF.length, {
    altHeld: false, requirementUnmet: true, actorSnap: { level: 12, strength: 30, dexterity: 20 },
  }, t);

  assert.equal(model.name, 'Doom Bane of the Legion');
  assert.equal(model.showBaseType, true, 'display name differs from base name -> block 2 shown');
  assert.equal(model.baseTypeText, 'Battle Axe');
  assert.equal(model.rarityText, 'Rare');
  assert.equal(model.isUnidentified, false);

  // Block 5+6 — base statistics then requirements, one continuous list.
  const labels = model.statLines.map((l) => l.label);
  assert.deepEqual(labels, ['Two-Hand Damage', 'Attack Speed', 'Durability', 'Required Level', 'Required Strength']);
  assert.equal(model.statLines[0].value, '15 – 30'); // round(10*1.5), round(20*1.5)
  assert.equal(model.statLines[0].modified, true);
  assert.equal(model.statLines[1].value, '1.00 /s (Normal)'); // 1.0s interval, no IAS affix in this fixture
  assert.equal(model.statLines[2].value, '42 of 55');
  assert.equal(model.statLines[3].value, '9'); // level met, no ✕
  assert.equal(model.statLines[3].danger, false);
  assert.equal(model.statLines[4].value, '40  ✕'); // strength 30 < 40, canEquip-driven unmet
  assert.equal(model.statLines[4].danger, true);
  assert.equal(model.requirementUnmetAny, true, 'drives the Ember Seam --danger colour');

  // Block 8 — rolled properties, sorted by (ordinal, decl-order): skill
  // bonus (100) before enhanced damage (300) before the fire pair (310)
  // before attack rating (400) before life steal (500).
  const propTexts = model.propLines.map((l) => l.text);
  assert.deepEqual(propTexts, [
    '+2 to Carnage Skills',
    '+50 % Enhanced Damage',
    'Adds 6 – 14 Fire Damage',
    '+15 to Attack Rating',
    '7 % of Physical Damage Stolen as Life',
  ]);

  assert.equal(model.socketLines.length, 0, 'socketCount 0 -> block 9 skipped');
  assert.equal(model.showLore, false, 'not a unique -> block 11 skipped');
  assert.equal(model.showDurabilityWarning, false, '42/55 > 20% -> no warning');
  assert.equal(model.showUnidentifiedNotice, false);
  assert.equal(model.itemLevelText, 'Item Level 12');
});

test('clause 1: a skipped block (2) when the display name equals the base name', () => {
  const item = makeAxeItem({ rarity: 'normal', _cache: { displayName: 'Battle Axe' } });
  const model = buildTooltipModel(item, AXE_BASE, [], 0, { altHeld: false, requirementUnmet: false }, t);
  assert.equal(model.showBaseType, false);
  assert.equal(model.rarityText, 'Normal');
});

test('clause 1: block 8 (rolled properties) and its preceding rule are skipped together when there are no affixes and no unique', () => {
  const item = makeAxeItem({ rarity: 'normal' });
  const model = buildTooltipModel(item, AXE_BASE, [], 0, { altHeld: false, requirementUnmet: false }, t);
  assert.equal(model.propLines.length, 0);
});

test('clause 1: DOM — rule2 (before block 8) and rule3 (before block 11) each disappear exactly when their own block is empty, and reappear on real live data', async () => {
  const items = new ItemsSystem();
  await items.init({ rng: new Rng(1) });
  assert.equal(typeof items.rolledMods, 'function', 'ITEM-19 round 2: rolledMods is now instance-callable');
  const ctx = {
    canvas: { width: 1920, height: 1080 },
    get(id) { return id === 'items' ? items : null; },
    peek(id) { return id === 'items' ? items : null; },
  };

  // A plain, non-unique item with NO affixes at all (a real base, genuinely
  // no mods): block 8 (properties) AND block 11 (lore) are both empty ->
  // both rule2 and rule3 must hide.
  const bareItem = {
    uid: 10, baseId: 'axe_battle_normal', rarity: 'normal', ilvl: 5, identified: true, quantity: 1,
    rolls: { defense: 0, superior: 0, damageMin: 10, damageMax: 22 },
    affixes: [], uniqueId: null, uniqueValues: [], nameOverride: null,
    durability: 55, maxDurability: 55, sockets: [], socketCount: 0,
    grid: null, slot: null, ground: null, _cache: {},
  };
  const bare = new Tooltip({}, { appendChild() {} }, t, null);
  bare.showTooltip(bareItem, 400, 400, false);
  bare.update(0.016, ctx);
  assert.equal(bare.__model().propLines.length, 0, 'a real base with affixes:[] genuinely rolls 0 property lines');
  assert.equal(bare._rule2.style.display, 'none', 'block 8 empty -> its preceding rule is skipped with it');
  assert.equal(bare._rule3.style.display, 'none', 'block 11 (not a unique) empty -> its preceding rule is skipped with it');

  // The dressed case — the real unique `verens_reckoning` (seven real mods)
  // on the real `axe_battle_normal`: block 8 is now genuinely non-empty via
  // the real `items.rolledMods`, and block 11 has real lore -> BOTH rules
  // must show.
  const dressedItem = {
    uid: 11, baseId: 'axe_battle_normal', rarity: 'unique', ilvl: 30, identified: true, quantity: 1,
    rolls: { defense: 0, superior: 0, damageMin: 10, damageMax: 22 },
    affixes: [], uniqueId: 'verens_reckoning', uniqueValues: [100, 8, 17, 20, 7, 4, 11], nameOverride: null,
    durability: 55, maxDurability: 55, sockets: [], socketCount: 0,
    grid: null, slot: null, ground: null, _cache: {},
  };
  const dressed = new Tooltip({}, { appendChild() {} }, t, null);
  dressed.showTooltip(dressedItem, 400, 400, false);
  dressed.update(0.016, ctx);
  assert.ok(dressed.__model().propLines.length > 0, 'block 8 renders the rolled properties from real items.rolledMods()');
  assert.equal(dressed._rule2.style.display, 'block', 'a real unique with rolled mods -> block 8 is non-empty, rule2 shows');
  assert.equal(dressed._rule3.style.display, 'block', 'a real unique with lore -> block 11 is non-empty, rule3 shows');
});

test('clause 1: FULL real-data integration — all sixteen §5.1 blocks accounted for, driven by the real ItemsSystem end to end', async () => {
  // ITEM-19 (both rounds): `items.base`/`items.unique`/`items.rolledMods`
  // are now real instance methods. This test drives the tooltip off the
  // ACTUAL `ItemsSystem` — `axe_battle_normal` (real, one-handed per
  // `03-combat-math.md` §4.6, contra the §5.1 mockup's own "Two-Hand
  // Damage" label) carrying the real unique `verens_reckoning` (seven real
  // mods, real lore).
  const items = new ItemsSystem();
  await items.init({ rng: new Rng(7) });
  const realBase = items.base('axe_battle_normal');
  assert.ok(realBase, 'items.base must resolve the real ItemBase');
  assert.equal(realBase.weapon.twoHanded, false, 'axe_battle_normal is oneHandMelee, not two-handed');
  const realUnique = items.unique('verens_reckoning');
  assert.ok(realUnique && realUnique.lore, 'items.unique must resolve the real UniqueDefinition, with lore');

  const ctx = {
    canvas: { width: 1920, height: 1080 },
    get(id) { return id === 'items' ? items : null; },
    peek(id) { return id === 'items' ? items : null; },
  };
  const uniqueValues = [100, 8, 17, 20, 7, 4, 11]; // positionally aligned with verens_reckoning.mods
  const item = {
    uid: 3, baseId: 'axe_battle_normal', rarity: 'unique', ilvl: 30, identified: true, quantity: 1,
    rolls: { defense: 0, superior: 0, damageMin: 10, damageMax: 22 },
    affixes: [], uniqueId: 'verens_reckoning', uniqueValues, nameOverride: null,
    durability: 55, maxDurability: 55, sockets: [], socketCount: 0,
    grid: null, slot: null, ground: null, _cache: {},
  };

  const tooltip = new Tooltip({}, { appendChild() {} }, t, null);
  tooltip.showTooltip(item, 400, 400, false);
  tooltip.update(0.016, ctx);
  const model = tooltip.__model();

  // Block 1/2 — name (the unique's own name, via items.unique().name) /
  // base type.
  assert.equal(model.name, "Veren's Reckoning");
  assert.equal(model.showBaseType, true);
  assert.equal(model.baseTypeText, 'Battle Axe');
  // Block 3 — rarity word.
  assert.equal(model.rarityText, 'Unique');
  // Block 4 — the rule before block 5 always shows (block 5 is "always" —
  // `_buildDom` gives rule1 no hide toggle at all, so it can never read
  // 'none').
  assert.notEqual(tooltip._rule1.style.display, 'none');

  // Block 5 — base statistics, driven by the REAL ItemBase AND the REAL
  // items.rolledMods() output. The enhanced-damage/attack-speed values are
  // COMPUTED from the fixture's own rolled numbers here, not pasted as a
  // literal (round 3's own lesson) — this stays true if `uniqueValues`
  // above ever changes.
  const enhancedDamage = uniqueValues[0];
  const increasedAttackSpeed = uniqueValues[3];
  const mult = 1 + enhancedDamage / 100;
  const expectedMin = Math.round(realBase.weapon.minDamage * mult);
  const expectedMax = Math.round(realBase.weapon.maxDamage * mult);
  const interval = realBase.weapon.attackTime / (1 + increasedAttackSpeed / 100);
  const rate = 1 / interval;
  const band = interval <= 0.60 ? 'Very Fast' : interval <= 0.80 ? 'Fast' : interval <= 1.05 ? 'Normal' : interval <= 1.35 ? 'Slow' : 'Very Slow';

  const labels = model.statLines.map((l) => l.label);
  assert.deepEqual(labels, ['One-Hand Damage', 'Attack Speed', 'Durability', 'Required Level', 'Required Strength']);
  assert.equal(model.statLines[0].value, expectedMin + ' – ' + expectedMax, 'the weapon range reflects the item\'s actual rolled enhancedDamage');
  assert.equal(model.statLines[0].modified, true, 'enhancedDamage != 0 -> tinted --property');
  assert.equal(model.statLines[1].value, rate.toFixed(2) + ' /s (' + band + ')');
  assert.equal(model.statLines[2].value, '55 of 55');

  // Block 6 — requirements, from the real base's reqLevel/reqStr.
  assert.equal(model.statLines[3].value, String(realBase.reqLevel));
  assert.equal(model.statLines[4].value, String(realBase.reqStr));

  // Block 7 (rule) / Block 8 — rolled properties, from the REAL
  // items.rolledMods() reading the real UniqueDefinition's mods + this
  // item's own uniqueValues. Sorted by (ordinal, decl-order): IAS (200) <
  // enhancedDamage (300) < the minDamage/maxDamage pair (305, merged
  // because every unique mod shares the same affixId = the uniqueId
  // itself) < critChance (410) < lifeSteal (500) < rageOnHit (522).
  assert.equal(tooltip._rule2.style.display, 'block');
  assert.deepEqual(model.propLines.map((l) => l.text), [
    '+20 % Increased Attack Speed',
    '+100 % Enhanced Damage',
    'Adds 8 – 17 Damage',
    '+11 % Chance of Deadly Strike',
    '7 % of Physical Damage Stolen as Life',
    '+4 Rage per Hit',
  ]);

  // Block 9 — sockets, empty (socketCount 0).
  assert.equal(model.socketLines.length, 0);

  // Block 10 (rule) / Block 11 — lore, the real unique's own text, verbatim.
  assert.equal(tooltip._rule3.style.display, 'block');
  assert.equal(model.showLore, true);
  assert.equal(model.loreText, 'Veren struck the same blow eleven thousand times and called it a prayer.');

  // Block 12 — durability warning: 55/55, no warning.
  assert.equal(model.showDurabilityWarning, false);
  // Block 13 — unidentified notice: identified, not shown.
  assert.equal(model.showUnidentifiedNotice, false);
  // Block 14 (vendor value) — never rendered, no vendor context exists (documented, unchanged from round 1/2).
  // Block 15 — item level, always.
  assert.equal(model.itemLevelText, 'Item Level 30');
  // Block 16 (hint row) — never rendered, no compare/equip context exists yet (documented, unchanged).
});

test('clause 2 (on live data): a real affix pair (pfx_flat_fire_1) merges, and a real sharedRoll all-resistances affix (sfx_res_all_1) merges — through the real items.rolledMods()', async () => {
  // §5.3's algorithm is proven exhaustively against hand-built fixtures
  // below (Clause 2's own suite) — this test proves the SAME merge rules
  // fire correctly when the affix definitions and the `rolledMods` call
  // are both real, not constructed. `pfx_flat_fire_1` (`fireMin`/`fireMax`,
  // `sharedRoll: false`) and `sfx_res_all_1` (all six resistances,
  // `sharedRoll: true`) both exist in `src/items/data/affixes.js` today.
  const items = new ItemsSystem();
  await items.init({ rng: new Rng(3) });
  const ctx = {
    canvas: { width: 1920, height: 1080 },
    get(id) { return id === 'items' ? items : null; },
    peek(id) { return id === 'items' ? items : null; },
  };
  const item = {
    uid: 20, baseId: 'axe_battle_normal', rarity: 'magic', ilvl: 20, identified: true, quantity: 1,
    rolls: { defense: 0, superior: 0, damageMin: 10, damageMax: 22 },
    affixes: [
      { id: 'pfx_flat_fire_1', kind: 'prefix', values: [2, 6] }, // fireMin=2 (range 1-3), fireMax=6 (range 4-8)
      { id: 'sfx_res_all_1', kind: 'suffix', values: [7, 7, 7, 7, 7, 7] }, // sharedRoll: true -> one value repeated across all 6 mods
    ],
    uniqueId: null, uniqueValues: [], nameOverride: null,
    durability: 55, maxDurability: 55, sockets: [], socketCount: 0,
    grid: null, slot: null, ground: null, _cache: {},
  };

  const tooltip = new Tooltip({}, { appendChild() {} }, t, null);
  tooltip.showTooltip(item, 400, 400, false);
  tooltip.update(0.016, ctx);
  const model = tooltip.__model();

  assert.deepEqual(model.propLines.map((l) => l.text), [
    'Adds 2 – 6 Fire Damage', // the real fireMin/fireMax pair, merged (ord 310)
    'All Resistances +7 %', // all 6 real resist mods, same affixId, same value -> merged (ord 620)
  ]);
});

// ===========================================================================
// nameOverride (round 3, ITEM-8) — {headIndex, tailIndex, code, en, ru},
// `ui` picks the active language; `setLanguage` switches it live
// ===========================================================================

const RARE_NAME_OVERRIDE = { headIndex: 3, tailIndex: 5, code: 149, en: 'Doom Bane of the Legion', ru: 'Кара Судьбы Легиона' };

test('nameOverride: an identified rare with a real {headIndex,tailIndex,code,en,ru} shows the EN text when the active language is en', () => {
  const item = makeAxeItem({ nameOverride: RARE_NAME_OVERRIDE });
  const model = buildTooltipModel(item, AXE_BASE, [], 0, { altHeld: false, requirementUnmet: false, lang: 'en' }, t);
  assert.equal(model.name, 'Doom Bane of the Legion');
});

test('nameOverride: the same item shows the RU text when the active language is ru', () => {
  const item = makeAxeItem({ nameOverride: RARE_NAME_OVERRIDE });
  const model = buildTooltipModel(item, AXE_BASE, [], 0, { altHeld: false, requirementUnmet: false, lang: 'ru' }, t);
  assert.equal(model.name, 'Кара Судьбы Легиона');
});

test('nameOverride: an old-shape plain-string nameOverride still works (backward compatible), independent of lang', () => {
  const item = makeAxeItem({ nameOverride: 'Plain String Name' });
  const model = buildTooltipModel(item, AXE_BASE, [], 0, { altHeld: false, requirementUnmet: false, lang: 'ru' }, t);
  assert.equal(model.name, 'Plain String Name');
});

test('nameOverride: Tooltip#setLanguage(\'ru\') switches the displayed name LIVE on an already-open tooltip (same item, same anchor)', () => {
  const tooltip = new Tooltip({}, { appendChild() {} }, t, null);
  const ctx = makeFakeCtx({});
  const item = makeAxeItem({ nameOverride: RARE_NAME_OVERRIDE });

  tooltip.showTooltip(item, 100, 100, false);
  tooltip.update(0.016, ctx);
  assert.equal(tooltip.__model().name, 'Doom Bane of the Legion');

  tooltip.setLanguage('ru');
  tooltip.update(0.016, ctx); // same item, same call site — only the language changed
  assert.equal(tooltip.__model().name, 'Кара Судьбы Легиона');

  tooltip.setLanguage('en');
  tooltip.update(0.016, ctx);
  assert.equal(tooltip.__model().name, 'Doom Bane of the Legion');
});

test('UiSystem#setLanguage(\'ru\') forwards to the tooltip module and does not throw with no tooltip open', async () => {
  const sys = new UiSystem();
  await sys.init({});
  assert.doesNotThrow(() => sys.setLanguage('ru'));
  assert.doesNotThrow(() => sys.setLanguage('en'));
  sys.dispose();
});

// ===========================================================================
// Clause 2 — the all-resistances merge (§5.3 rule 2), per-affix not per-total
// ===========================================================================

test('clause 2: 3 of 6 resistances from one affix, not the elemental 4, merge to "All Resistances"', () => {
  const modBuf = [
    { stat: 'fireResist', value: 10, min: 8, max: 12, source: 'affix', affixId: 'pfx_allres', kind: 'prefix' },
    { stat: 'coldResist', value: 10, min: 8, max: 12, source: 'affix', affixId: 'pfx_allres', kind: 'prefix' },
    { stat: 'lightResist', value: 10, min: 8, max: 12, source: 'affix', affixId: 'pfx_allres', kind: 'prefix' },
  ];
  const model = buildTooltipModel(makeAxeItem({ rarity: 'magic' }), AXE_BASE, modBuf, modBuf.length, { altHeld: false, requirementUnmet: false }, t);
  assert.deepEqual(model.propLines.map((l) => l.text), ['All Resistances +10 %']);
});

test('clause 2: exactly the four elemental resistances from one affix merge to "Elemental Resistances"', () => {
  const modBuf = [
    { stat: 'fireResist', value: 12, min: 8, max: 16, source: 'affix', affixId: 'pfx_elem', kind: 'prefix' },
    { stat: 'coldResist', value: 12, min: 8, max: 16, source: 'affix', affixId: 'pfx_elem', kind: 'prefix' },
    { stat: 'lightResist', value: 12, min: 8, max: 16, source: 'affix', affixId: 'pfx_elem', kind: 'prefix' },
    { stat: 'poisonResist', value: 12, min: 8, max: 16, source: 'affix', affixId: 'pfx_elem', kind: 'prefix' },
  ];
  const model = buildTooltipModel(makeAxeItem({ rarity: 'magic' }), AXE_BASE, modBuf, modBuf.length, { altHeld: false, requirementUnmet: false }, t);
  assert.deepEqual(model.propLines.map((l) => l.text), ['Elemental Resistances +12 %']);
});

test('clause 2: two SEPARATE affixes each giving +10 Fire Resist stay two lines — merging is per-affix, never per-total', () => {
  const modBuf = [
    { stat: 'fireResist', value: 10, min: 8, max: 12, source: 'affix', affixId: 'pfx_fireres_a', kind: 'prefix' },
    { stat: 'fireResist', value: 10, min: 8, max: 12, source: 'affix', affixId: 'sfx_fireres_b', kind: 'suffix' },
  ];
  const model = buildTooltipModel(makeAxeItem({ rarity: 'magic' }), AXE_BASE, modBuf, modBuf.length, { altHeld: false, requirementUnmet: false }, t);
  assert.deepEqual(model.propLines.map((l) => l.text), ['Fire Resistance +10 %', 'Fire Resistance +10 %']);
});

test('clause 2: only 2 of 6 resistances from one affix does not merge (needs >= 3)', () => {
  const modBuf = [
    { stat: 'fireResist', value: 10, min: 8, max: 12, source: 'affix', affixId: 'pfx_two', kind: 'prefix' },
    { stat: 'coldResist', value: 10, min: 8, max: 12, source: 'affix', affixId: 'pfx_two', kind: 'prefix' },
  ];
  const model = buildTooltipModel(makeAxeItem({ rarity: 'magic' }), AXE_BASE, modBuf, modBuf.length, { altHeld: false, requirementUnmet: false }, t);
  assert.deepEqual(model.propLines.map((l) => l.text), ['Fire Resistance +10 %', 'Cold Resistance +10 %']);
});

test('RESIST_STATS / ELEMENTAL_RESIST_STATS export the exact stat sets the merge rule names', () => {
  assert.deepEqual(RESIST_STATS, ['fireResist', 'coldResist', 'lightResist', 'poisonResist', 'magicResist', 'physicalResist']);
  assert.deepEqual(ELEMENTAL_RESIST_STATS, ['fireResist', 'coldResist', 'lightResist', 'poisonResist']);
});

// ===========================================================================
// Clause 5 — the unidentified state (§5.5)
// ===========================================================================

test('clause 5: unidentified rare — base name (not the generated name), blocks 2/8/9/11 suppressed', () => {
  const item = makeAxeItem({ identified: false, socketCount: 2 });
  const model = buildTooltipModel(item, AXE_BASE, AXE_MOD_BUF, AXE_MOD_BUF.length, {
    altHeld: false, requirementUnmet: false, loreText: 'Some lore that must not appear',
  }, t);

  assert.equal(model.isUnidentified, true);
  assert.equal(model.name, 'Battle Axe', 'base name, never the generated display name');
  assert.equal(model.showBaseType, false, 'block 2 suppressed');
  assert.equal(model.propLines.length, 0, 'block 8 suppressed');
  assert.equal(model.socketLines.length, 0, 'block 9 suppressed even though socketCount > 0');
  assert.equal(model.showLore, false, 'block 11 suppressed');
  assert.equal(model.rarityText, 'Unidentified');
  assert.equal(model.showUnidentifiedNotice, true);
  assert.equal(model.unidentifiedNoticeText, 'Use a Scroll of Identify');

  // Blocks 5/6 (base statistics + requirements) ARE still shown (§5.5:
  // "the player can see the item's weight and reach in the world").
  assert.ok(model.statLines.length > 0);
});

test('clause 5: a normal/magic item is never treated as unidentified regardless of the identified flag', () => {
  const item = makeAxeItem({ rarity: 'magic', identified: false, _cache: { displayName: 'Keen Battle Axe' } });
  const model = buildTooltipModel(item, AXE_BASE, [], 0, { altHeld: false, requirementUnmet: false }, t);
  assert.equal(model.isUnidentified, false);
  assert.equal(model.name, 'Keen Battle Axe');
});

// ===========================================================================
// Clause 6 — ui.setAltHeld toggles the roll-range reveal live, on an
// already-open tooltip (same item, same call site — only Alt changes)
// ===========================================================================

function makeFakeCtx(itemsOverrides) {
  const items = Object.assign({
    base: (id) => (id === 'axe_battle_test' ? AXE_BASE : null),
    rolledMods: (item, out) => {
      for (let i = 0; i < AXE_MOD_BUF.length; i++) {
        if (!out[i]) out[i] = {};
        Object.assign(out[i], AXE_MOD_BUF[i]);
      }
      return AXE_MOD_BUF.length;
    },
  }, itemsOverrides);
  return {
    canvas: { width: 1920, height: 1080 },
    get(id) { return id === 'items' ? items : null; },
    peek(id) { return id === 'items' ? items : null; },
  };
}

test('clause 6: setAltHeld(true) reveals roll ranges; setAltHeld(false) hides them again, live', () => {
  const tooltip = new Tooltip({}, { appendChild() {} }, t, null);
  const ctx = makeFakeCtx({});
  const item = makeAxeItem({});

  tooltip.showTooltip(item, 100, 100, false);
  tooltip.update(0.016, ctx);
  let model = tooltip.__model();
  assert.ok(model.propLines.length > 0);
  assert.ok(model.propLines.every((l) => l.rangeText === ''), 'Alt off: no range suffix on any line');

  tooltip.setAltHeld(true);
  tooltip.update(0.016, ctx); // same item, same call site — only Alt changed
  model = tooltip.__model();
  const withRange = model.propLines.filter((l) => l.rangeText !== '');
  assert.ok(withRange.length > 0, 'Alt on: at least one line now carries [min - max]');
  // the enhanced-damage line: rolled 50, range [30-50]
  const ed = model.propLines.find((l) => l.text.indexOf('Enhanced Damage') !== -1);
  assert.equal(ed.rangeText, '[30 – 50]');

  tooltip.setAltHeld(false);
  tooltip.update(0.016, ctx);
  model = tooltip.__model();
  assert.ok(model.propLines.every((l) => l.rangeText === ''), 'Alt off again: ranges hidden');
});

// ===========================================================================
// Clause 3 — placement stays inside the viewport at all four corners, and
// never covers the cursor
// ===========================================================================

const VW = 1920; const VH = 1080; const EDGE = 12; // k=1

function assertInsideViewport(rect, w, h) {
  assert.ok(rect.x >= EDGE - 1e-6, `x=${rect.x} >= EDGE`);
  assert.ok(rect.y >= EDGE - 1e-6, `y=${rect.y} >= EDGE`);
  assert.ok(rect.x + w <= VW - EDGE + 1e-6, `x+w=${rect.x + w} <= vw-EDGE`);
  assert.ok(rect.y + h <= VH - EDGE + 1e-6, `y+h=${rect.y + h} <= vh-EDGE`);
}

test('clause 3: top-left corner anchor stays fully inside the viewport', () => {
  const w = 320; const h = 260;
  const rect = computePlacement(5, 5, w, h, VW, VH, null, null);
  assertInsideViewport(rect, w, h);
});

test('clause 3: top-right corner anchor stays fully inside the viewport', () => {
  const w = 320; const h = 260;
  const rect = computePlacement(VW - 5, 5, w, h, VW, VH, null, null);
  assertInsideViewport(rect, w, h);
});

test('clause 3: bottom-left corner anchor stays fully inside the viewport', () => {
  const w = 320; const h = 260;
  const rect = computePlacement(5, VH - 5, w, h, VW, VH, null, null);
  assertInsideViewport(rect, w, h);
});

test('clause 3: bottom-right corner anchor stays fully inside the viewport', () => {
  const w = 320; const h = 260;
  const rect = computePlacement(VW - 5, VH - 5, w, h, VW, VH, null, null);
  assertInsideViewport(rect, w, h);
});

test('clause 3: a tooltip wider/taller than half the viewport still stays inside at every corner', () => {
  const w = 428; const h = 700;
  for (const [ax, ay] of [[2, 2], [VW - 2, 2], [2, VH - 2], [VW - 2, VH - 2]]) {
    const rect = computePlacement(ax, ay, w, h, VW, VH, null, null);
    assertInsideViewport(rect, w, h);
  }
});

test('clause 3: the tooltip never covers the cursor point', () => {
  const w = 320; const h = 260;
  // Anchor placed so the naive right-then-top placement would land the
  // cursor (assumed at the anchor, as it is for a ground/world tooltip)
  // squarely inside the resulting rect.
  const anchorX = 900; const anchorY = 500;
  const rect = computePlacement(anchorX, anchorY, w, h, VW, VH, anchorX, anchorY);
  const insideX = anchorX >= rect.x && anchorX <= rect.x + w;
  const insideY = anchorY >= rect.y && anchorY <= rect.y + h;
  assert.ok(!(insideX && insideY), 'cursor point must not be inside the final tooltip rect');
  assertInsideViewport(rect, w, h);
});

// ===========================================================================
// Clause 4 — the height degradation ladder, in exact order (a) -> (e); never
// scrolls
// ===========================================================================

function makeTallModel(propCount, loreLen) {
  const propLines = [];
  for (let i = 0; i < propCount; i++) propLines.push({ text: 'Line ' + i, danger: false, rangeText: '' });
  return {
    name: 'X', showBaseType: false, baseTypeText: '', rarityText: 'Rare',
    statLines: [{ label: 'A', value: '1' }, { label: 'B', value: '2' }],
    propLines, socketLines: [],
    showLore: true, loreText: 'x'.repeat(loreLen),
    showDurabilityWarning: false, durabilityWarningText: '',
    showUnidentifiedNotice: false, unidentifiedNoticeText: '',
    itemLevelText: 'Item Level 1', requirementUnmetAny: false, isUnidentified: false, rarity: 'rare',
  };
}

test('clause 4: the ladder degrades in exact order (a) line-height -> (b) drop lore -> (d) drop item level, and never reports scrolling', () => {
  const model = makeTallModel(24, 240);
  const w = computeContentWidth(model);

  // Scan from a generously tall viewport down to a tiny one; record the
  // first vh at which each stage engages.
  let sawFull = false; let sawStepA = false; let sawStepB = false; let sawStepD = false; let sawOverflow = false;
  let lastPropLH = 18; let loreDropped = false; let itemLevelDropped = false;

  for (let vh = 3000; vh >= 40; vh -= 2) {
    const plan = computeHeightPlan(model, w, vh);

    if (plan.propLineHeight === 18 && plan.showLore && plan.showItemLevel && !plan.overflow) sawFull = true;

    // Step (a) must be observed before step (b): line-height only drops
    // to 16 while lore is still shown, at some vh above where lore drops.
    if (plan.propLineHeight === 16 && plan.showLore && plan.showItemLevel) sawStepA = true;
    if (!plan.showLore && !loreDropped) { loreDropped = true; assert.equal(plan.propLineHeight, 16, '(a) must already have engaged before (b) drops lore'); }
    if (plan.propLineHeight === 16 && !plan.showLore && plan.showItemLevel) sawStepB = true;
    if (!plan.showItemLevel && !itemLevelDropped) { itemLevelDropped = true; assert.equal(plan.showLore, false, '(b)/(c) must already have engaged before (d) drops the item level'); }
    if (plan.propLineHeight === 16 && !plan.showLore && !plan.showItemLevel) sawStepD = true;
    if (plan.overflow) { sawOverflow = true; assert.equal(plan.propLineHeight, 16); assert.equal(plan.showLore, false); assert.equal(plan.showItemLevel, false); }

    // Never claims to fit when it doesn't, and never "scrolls" — there is
    // no scroll affordance in this model at all; overflow is the only
    // escape hatch, and it is flagged honestly.
    const maxH = vh - 2 * EDGE;
    if (!plan.overflow) assert.ok(plan.height <= maxH + 1e-6, `height=${plan.height} must fit maxH=${maxH} when overflow is false (vh=${vh})`);

    lastPropLH = plan.propLineHeight;
  }

  assert.ok(sawFull, 'a generous viewport needs no degradation at all');
  assert.ok(sawStepA, 'step (a) — propLineHeight 16 while lore/item level still shown — must occur');
  assert.ok(sawStepB, 'step (b) — lore dropped, item level still shown — must occur');
  assert.ok(sawStepD, 'step (d) — item level also dropped — must occur');
  assert.ok(sawOverflow, 'an impossibly small viewport must eventually accept overflow rather than scroll');
  assert.equal(lastPropLH, 16);
});

test('clause 4: the .cl2-tooltip CSS never allows overflow scroll/auto (no scrollbar mechanism at all)', () => {
  const rule = STYLE_SRC.slice(STYLE_SRC.indexOf('.cl2-tooltip {'), STYLE_SRC.indexOf('.cl2-tt-seam {'));
  assert.match(rule, /overflow:\s*hidden/);
  assert.doesNotMatch(rule, /overflow:\s*(auto|scroll)/);
});

// ===========================================================================
// Contract / wiring / performance-adjacent source checks
// ===========================================================================

test('UiSystem exposes showTooltip/hideTooltip/setAltHeld and delegates without throwing', async () => {
  const sys = new UiSystem();
  await sys.init({});
  assert.equal(typeof sys.showTooltip, 'function');
  assert.equal(typeof sys.hideTooltip, 'function');
  assert.equal(typeof sys.setAltHeld, 'function');
  assert.doesNotThrow(() => sys.showTooltip(makeAxeItem({}), 10, 10, false));
  assert.doesNotThrow(() => sys.setAltHeld(true));
  assert.doesNotThrow(() => sys.hideTooltip());
  sys.dispose();
});

test('UiSystem exposes setCompareHeld and delegates without throwing — comparison mode is UI-7, this ticket', async () => {
  const sys = new UiSystem();
  await sys.init({});
  assert.equal(typeof sys.setCompareHeld, 'function');
  assert.doesNotThrow(() => sys.setCompareHeld(true));
  assert.doesNotThrow(() => sys.setCompareHeld(false));
  sys.dispose();
});

test("showTooltip's compare parameter is accepted, stored, AND acted on — O-27 form: a compare-active tooltip against a ctx with no player/actor routes to a well-formed empty result (zero panels), never a throw and never a silent ignore of the flag itself", () => {
  const tooltip = new Tooltip({}, { appendChild() {} }, t, null);
  const ctx = makeFakeCtx({}); // no 'player' registered — safeGet(ctx,'player') is null
  tooltip.showTooltip(makeAxeItem({}), 10, 10, true);
  assert.doesNotThrow(() => tooltip.update(0.016, ctx));
  assert.equal(tooltip._compare, true);
  // The compare-mode DOM surface exists now (UI-7): setCompareHeld is real,
  // and the per-frame comparison pass genuinely ran (no actor to compare
  // against -> zero panels, a well-formed empty result, not a crash).
  assert.equal(typeof tooltip.setCompareHeld, 'function');
  assert.equal(tooltip.__comparePanelCount(), 0);
});

test('a closed tooltip (never shown) builds its DOM once but is not attached to the layer', () => {
  let appended = 0;
  const layer = { appendChild() { appended++; } };
  const tooltip = new Tooltip({}, layer, t, null);
  assert.ok(tooltip.__nodeCount() > 0, 'the skeleton is built in the constructor');
  assert.equal(appended, 0, 'never attached before the first showTooltip()');
  assert.equal(tooltip.__isVisible(), false);
});

test('hideTooltip() then update() fades out and eventually detaches from the layer', () => {
  let appended = 0; let removed = 0;
  const layer = { appendChild() { appended++; } };
  const tooltip = new Tooltip({}, layer, t, null);
  const ctx = makeFakeCtx({});
  tooltip.showTooltip(makeAxeItem({}), 10, 10, false);
  for (let i = 0; i < 20; i++) tooltip.update(0.05, ctx);
  assert.equal(appended, 1);
  assert.ok(tooltip.__isVisible());

  tooltip.hideTooltip();
  for (let i = 0; i < 40; i++) tooltip.update(0.05, ctx);
  assert.equal(tooltip.__isVisible(), false);
});

test('tooltip.js source contains no Math.random() call (ARCHITECTURE.md rule 4)', () => {
  assert.doesNotMatch(TOOLTIP_SRC, /Math\.random\(/);
});

test('tooltip.js source contains no Math.hypot() call (this project\'s banned-allocation rule)', () => {
  assert.doesNotMatch(TOOLTIP_SRC, /Math\.hypot\(/);
});

test('tooltip.js source builds no Map/Set for the resistance merge or the line pool', () => {
  // A loose but effective guard: the module must not construct a Map/Set at
  // all (the line pool and the merge scans are the only stateful
  // collections this file owns).
  assert.doesNotMatch(TOOLTIP_SRC, /new Map\(/);
  assert.doesNotMatch(TOOLTIP_SRC, /new Set\(/);
});

test('DOM node count for an open tooltip with a rich item stays well inside the 09 §13.1 700-node cap', () => {
  const nodes = [];
  const layer = { appendChild(n) { nodes.push(n); } };
  const tooltip = new Tooltip({}, layer, t, null);
  const ctx = makeFakeCtx({});
  tooltip.showTooltip(makeAxeItem({}), 500, 500, false);
  tooltip.update(0.016, ctx);
  assert.ok(tooltip.__nodeCount() <= 60, `tooltip.__nodeCount()=${tooltip.__nodeCount()} should be well under the ~96-combined / 700-total budget`);
});

// ===========================================================================
// UI-7 (09 §5.6) — comparison mode. This ticket's own five acceptance
// clauses, plus pure fixture tests for the delta-chip machinery itself.
//
// Clauses 1/2/3/5.6.5 drive the REAL `ItemsSystem`/`ActorsSystem` (a real
// `canEquip`/`equip`/`slotsFor`/`equipped`/`hasShield`/`rolledMods`), the
// same "no items-shaped mock where the real subsystem exists" discipline
// this file's own header already establishes for round 2/3 of UI-5's suite
// — a mock `slotsFor` could not catch a real regression in ITEM-11's own
// ring/two-hand rules the way the live subsystem does.
// ===========================================================================

async function makeCompareCtx() {
  const events = new EventBus();
  const registry = new Registry();
  const ctx = {
    scene: null, camera: null, uiScene: null, uiCamera: null,
    canvas: { width: 1920, height: 1080 },
    config: {}, events, input: null,
    time: { elapsed: 0, raw: 0, dt: 0, fixed: 1 / 60, alpha: 0, scale: 1, frame: 0, step: 0 },
    rng: new Rng(DETERMINISTIC_SEED),
    get: registry.get.bind(registry),
    peek: registry.peek.bind(registry),
    has: registry.has.bind(registry),
  };
  registry.add(PhysicsSystem);
  registry.add(ActorsSystem);
  registry.add(ItemsSystem);
  await registry.init(ctx);

  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'player', team: 0, archetypeId: 'ravager', level: 20, x: 0, z: 0, facing: 0 });
  actor.level = 20; // clears every reqLevel this file's fixtures use, deterministically
  // ravager's startStr is 30 (src/actors/stats.js CLASS_TABLE) — below
  // maul_great_normal's reqStr 62 this suite's own §5.6.5 fixture needs.
  // Spending allocated points is the real path (`actor.attributes`,
  // ACTR-15's own composed-stat surface) — not a `canEquip` bypass.
  actor.attributes.strength = 40;

  // `player` is not registered (it pulls in render/nav — out of scope for a
  // `tooltip.js` unit test) — `Tooltip#_rebuildCompare`/`_actorSnapshot`
  // read the actor through `safeGet(ctx,'player').actor`, so `ctx.peek`
  // gets one extra case. `tooltip.js` checks `ctx.peek` before `ctx.get`
  // (see `safeGet`'s own precedence), so this alone is enough.
  const realPeek = ctx.peek;
  ctx.peek = (id) => (id === 'player' ? { actor } : realPeek(id));

  return { ctx, actor, items: ctx.get('items') };
}

let _cmpUid = 90000;
function nextCmpUid() { return _cmpUid++; }

/** A minimal, complete `ItemInstance` (`01-data-model.md` §5.3 shape) —
 * same shape `tests/items/equipment.test.js#makeItem` already establishes
 * for the real `ItemsSystem`. */
function makeRealItem(baseId, overrides = {}) {
  const base = ITEM_BASES_BY_ID[baseId];
  return {
    uid: overrides.uid ?? nextCmpUid(),
    baseId,
    rarity: overrides.rarity ?? 'normal',
    ilvl: overrides.ilvl ?? (base ? base.reqLevel : 1),
    identified: overrides.identified ?? true,
    quantity: 1,
    rolls: overrides.rolls ?? { defense: 0, superior: 0, damageMin: base && base.weapon ? base.weapon.minDamage : 0, damageMax: base && base.weapon ? base.weapon.maxDamage : 0 },
    affixes: overrides.affixes ?? [],
    uniqueId: null, uniqueValues: [], nameOverride: overrides.nameOverride ?? null,
    durability: base ? base.maxDurability : 1, maxDurability: base ? base.maxDurability : 1,
    sockets: [], socketCount: 0,
    grid: null, slot: null, ground: null,
  };
}

// ---------------------------------------------------------------------------
// Clause 1 — hovering a weapon with one equipped shows ONE comparison panel
// ---------------------------------------------------------------------------

test('UI-7 clause 1: hovering a weapon with one equipped shows exactly one comparison panel', async () => {
  const { ctx, actor, items } = await makeCompareCtx();
  const equippedAxe = makeRealItem('axe_battle_normal', {});
  const eq = items.equip(actor, equippedAxe, 'mainHand');
  assert.equal(eq.ok, true, `equip failed: ${eq.reason}`);

  const hoveredAxe = makeRealItem('axe_battle_normal', { rarity: 'rare', identified: true });
  const tooltip = new Tooltip({}, { appendChild() {} }, t, null);
  tooltip.showTooltip(hoveredAxe, 400, 400, true);
  tooltip.update(0.016, ctx);

  assert.equal(tooltip.__comparePanelCount(), 1);
  assert.equal(tooltip.__comparePanelSlot(0), 'mainHand');
  assert.equal(tooltip.__comparePanelModel(0).name, 'Battle Axe');
  assert.equal(tooltip.__comparePanelSlot(1), null, 'offHand is empty — no second panel');
});

// ---------------------------------------------------------------------------
// Clause 2 — hovering a ring shows TWO, correctly labelled
// ---------------------------------------------------------------------------

test('UI-7 clause 2: hovering a ring with both ring slots occupied shows exactly two comparison panels, each showing its own distinct equipped item (the labelling)', async () => {
  const { ctx, actor, items } = await makeCompareCtx();
  const ring1Item = makeRealItem('ring_iron', { rarity: 'normal' });
  const ring2Item = makeRealItem('ring_iron', { rarity: 'magic', affixes: [{ id: 'pfx_life_1', kind: 'prefix', values: [11] }] });
  assert.equal(items.equip(actor, ring1Item, 'ring1').ok, true);
  assert.equal(items.equip(actor, ring2Item, 'ring2').ok, true);

  const hoveredRing = makeRealItem('ring_iron', { rarity: 'rare', identified: true });
  const tooltip = new Tooltip({}, { appendChild() {} }, t, null);
  tooltip.showTooltip(hoveredRing, 400, 400, true);
  tooltip.update(0.016, ctx);

  assert.equal(tooltip.__comparePanelCount(), 2, 'a ring is legal in ring1 AND ring2 — both occupied, both panels');
  assert.equal(tooltip.__comparePanelSlot(0), 'ring1');
  assert.equal(tooltip.__comparePanelSlot(1), 'ring2');
  // "Correctly labelled" — each panel is a full, faithful tooltip of the
  // ACTUAL distinct equipped item (not an interchangeable "Ring" stub), so
  // ring1 and ring2 are never confusable even though both carry the same
  // generic `tooltip.equipped` micro label.
  assert.equal(tooltip.__comparePanelModel(0).rarityText, 'Normal');
  assert.equal(tooltip.__comparePanelModel(1).rarityText, 'Magic');
  assert.ok(tooltip.__comparePanelModel(1).propLines.some((l) => l.compareKey === 'maxLife'), 'ring2\'s own affix is on ITS panel, not conflated with ring1\'s');
});

// ---------------------------------------------------------------------------
// Clause 3 — every delta chip's sign matches a hand-computed rolledMods
// difference (items.statsOf does not exist — see this ticket's report)
// ---------------------------------------------------------------------------

test('UI-7 clause 3: a matched delta chip\'s sign and magnitude equal a hand-computed items.rolledMods() difference', async () => {
  const { ctx, actor, items } = await makeCompareCtx();
  const equippedRing = makeRealItem('ring_iron', { rarity: 'magic', affixes: [{ id: 'pfx_life_1', kind: 'prefix', values: [8] }] });
  assert.equal(items.equip(actor, equippedRing, 'ring1').ok, true);

  const hoveredRing = makeRealItem('ring_iron', { rarity: 'magic', identified: true, affixes: [{ id: 'pfx_life_1', kind: 'prefix', values: [20] }] });
  const tooltip = new Tooltip({}, { appendChild() {} }, t, null);
  tooltip.showTooltip(hoveredRing, 400, 400, true);
  tooltip.update(0.016, ctx);

  // Hand-computed straight from items.rolledMods() — never from the
  // rendered chip's own arithmetic, never from parsed text (§5.6's own
  // rule: "never by parsing the rendered text").
  const bufA = []; const bufB = [];
  const nA = items.rolledMods(hoveredRing, bufA);
  const nB = items.rolledMods(equippedRing, bufB);
  const lifeA = bufA.slice(0, nA).find((e) => e.stat === 'maxLife').value;
  const lifeB = bufB.slice(0, nB).find((e) => e.stat === 'maxLife').value;
  const expectedDelta = lifeA - lifeB; // primary − this panel, §5.6's own convention
  assert.equal(expectedDelta, 12);

  const line = tooltip.__comparePanelModel(0).propLines.find((l) => l.compareKey === 'maxLife');
  assert.ok(line, 'the equipped ring\'s own maxLife line must exist');
  assert.ok(line.chip, 'a genuine non-zero delta must produce a chip');
  assert.equal(line.chip.cls, expectedDelta > 0 ? 'good' : 'danger', 'sign must match the hand-computed delta');
  assert.equal(line.chip.text, '▲ +' + Math.abs(expectedDelta));
});

test('UI-7 clause 3 (new): a stat present only on the hovered item chips "new" on the primary, and does not double-report on any panel', async () => {
  const { ctx, actor, items } = await makeCompareCtx();
  const equippedRing = makeRealItem('ring_iron', { rarity: 'normal', affixes: [] }); // no maxLife
  assert.equal(items.equip(actor, equippedRing, 'ring1').ok, true);

  const hoveredRing = makeRealItem('ring_iron', { rarity: 'magic', identified: true, affixes: [{ id: 'pfx_life_1', kind: 'prefix', values: [11] }] });
  const tooltip = new Tooltip({}, { appendChild() {} }, t, null);
  tooltip.showTooltip(hoveredRing, 400, 400, true);
  tooltip.update(0.016, ctx);

  const primaryLine = tooltip.__model().propLines.find((l) => l.compareKey === 'maxLife');
  assert.ok(primaryLine.chip, 'absent from the only open panel -> "new" on the primary');
  assert.equal(primaryLine.chip.cls, 'good');
  assert.equal(primaryLine.chip.text, '▲ new');
});

test('UI-7 clause 3 (lost): a stat present only on the equipped item chips "lost" on its own panel', async () => {
  const { ctx, actor, items } = await makeCompareCtx();
  const equippedRing = makeRealItem('ring_iron', { rarity: 'magic', affixes: [{ id: 'pfx_life_1', kind: 'prefix', values: [11] }] });
  assert.equal(items.equip(actor, equippedRing, 'ring1').ok, true);

  const hoveredRing = makeRealItem('ring_iron', { rarity: 'normal', identified: true, affixes: [] }); // no maxLife at all
  const tooltip = new Tooltip({}, { appendChild() {} }, t, null);
  tooltip.showTooltip(hoveredRing, 400, 400, true);
  tooltip.update(0.016, ctx);

  const panelLine = tooltip.__comparePanelModel(0).propLines.find((l) => l.compareKey === 'maxLife');
  assert.ok(panelLine, 'the equipped ring still renders its own real line');
  assert.equal(panelLine.chip.cls, 'danger');
  assert.equal(panelLine.chip.text, '▼ ' + t('tooltip.compareLost'));
});

// ---------------------------------------------------------------------------
// Clause 4 — setCompareHeld and setAltHeld both work live on an already-open
// tooltip
// ---------------------------------------------------------------------------

test('UI-7 clause 4: setCompareHeld switches comparison mode live, with no new showTooltip call', async () => {
  const { ctx, actor, items } = await makeCompareCtx();
  const equippedAxe = makeRealItem('axe_battle_normal', {});
  assert.equal(items.equip(actor, equippedAxe, 'mainHand').ok, true);

  const hoveredAxe = makeRealItem('axe_battle_normal', { rarity: 'rare', identified: true });
  const tooltip = new Tooltip({}, { appendChild() {} }, t, null);
  tooltip.showTooltip(hoveredAxe, 400, 400, false); // compare OFF at open time
  tooltip.update(0.016, ctx);
  assert.equal(tooltip.__comparePanelCount(), 0, 'compare off at open -> no panels');

  tooltip.setCompareHeld(true);
  tooltip.update(0.016, ctx); // same item, same call site — only Ctrl changed
  assert.equal(tooltip.__comparePanelCount(), 1, 'setCompareHeld(true) must switch comparison on live');

  tooltip.setCompareHeld(false);
  tooltip.update(0.016, ctx);
  assert.equal(tooltip.__comparePanelCount(), 0, 'setCompareHeld(false) must switch it back off live');
});

test('UI-7 clause 4: setAltHeld reveals roll ranges on an open comparison panel\'s own property lines, live', async () => {
  const { ctx, actor, items } = await makeCompareCtx();
  const equippedRing = makeRealItem('ring_iron', { rarity: 'magic', affixes: [{ id: 'pfx_life_1', kind: 'prefix', values: [11] }] });
  assert.equal(items.equip(actor, equippedRing, 'ring1').ok, true);

  const hoveredRing = makeRealItem('ring_iron', { rarity: 'rare', identified: true });
  const tooltip = new Tooltip({}, { appendChild() {} }, t, null);
  tooltip.showTooltip(hoveredRing, 400, 400, true);
  tooltip.update(0.016, ctx);

  let line = tooltip.__comparePanelModel(0).propLines.find((l) => l.compareKey === 'maxLife');
  assert.equal(line.rangeText, '', 'Alt off: no range suffix on the panel\'s own line either');

  tooltip.setAltHeld(true);
  tooltip.update(0.016, ctx); // same items, same call sites — only Alt changed
  line = tooltip.__comparePanelModel(0).propLines.find((l) => l.compareKey === 'maxLife');
  assert.equal(line.rangeText, '[5 – 11]', 'Alt on: the comparison panel reveals the roll range too — pfx_life_1 is min 5, max 11');

  tooltip.setAltHeld(false);
  tooltip.update(0.016, ctx);
  line = tooltip.__comparePanelModel(0).propLines.find((l) => l.compareKey === 'maxLife');
  assert.equal(line.rangeText, '', 'Alt off again: ranges hidden on the panel too');
});

// ---------------------------------------------------------------------------
// §5.6.5 — the two-hand/shield extension
// ---------------------------------------------------------------------------

test('UI-7 §5.6.5: a two-handed weapon hovered while a shield is equipped shows the shield as a second comparison and sets showTwoHandWarning', async () => {
  const { ctx, actor, items } = await makeCompareCtx();
  const equippedShield = makeRealItem('shield_buckler_normal', {});
  assert.equal(items.equip(actor, equippedShield, 'offHand').ok, true);

  const hoveredMaul = makeRealItem('maul_great_normal', { rarity: 'rare', identified: true }); // two-handed
  const tooltip = new Tooltip({}, { appendChild() {} }, t, null);
  tooltip.showTooltip(hoveredMaul, 400, 400, true);
  tooltip.update(0.016, ctx);

  assert.equal(tooltip.__comparePanelCount(), 1, 'slotsFor(a two-hander) is mainHand-only, yet the shield still shows');
  assert.equal(tooltip.__comparePanelSlot(0), 'offHand');
  assert.equal(tooltip.__model().showTwoHandWarning, true);
  assert.equal(tooltip._twoHandWarnEl.style.display, 'block');
});

test('UI-7 §5.6.5: a two-handed weapon with NO shield equipped shows no second panel and no warning', async () => {
  const { ctx, items } = await makeCompareCtx();
  const hoveredMaul = makeRealItem('maul_great_normal', { rarity: 'rare', identified: true });
  const tooltip = new Tooltip({}, { appendChild() {} }, t, null);
  tooltip.showTooltip(hoveredMaul, 400, 400, true);
  tooltip.update(0.016, ctx);

  assert.equal(tooltip.__comparePanelCount(), 0);
  assert.equal(tooltip.__model().showTwoHandWarning, false);
  assert.equal(tooltip._twoHandWarnEl.style.display, 'none');
  void items;
});

// ---------------------------------------------------------------------------
// The DOM node budget with two comparison panels open (09 §13.1)
// ---------------------------------------------------------------------------

test('UI-7: DOM node total (primary + two comparison panels) stays well inside the 09 §13.1 700-node ceiling', async () => {
  const { ctx, actor, items } = await makeCompareCtx();
  const ring1Item = makeRealItem('ring_iron', { affixes: [{ id: 'pfx_life_1', kind: 'prefix', values: [11] }] });
  const ring2Item = makeRealItem('ring_iron', { affixes: [{ id: 'pfx_flat_fire_1', kind: 'prefix', values: [2, 6] }] });
  assert.equal(items.equip(actor, ring1Item, 'ring1').ok, true);
  assert.equal(items.equip(actor, ring2Item, 'ring2').ok, true);

  const nodes = [];
  const layer = { appendChild(n) { nodes.push(n); } };
  const hoveredRing = makeRealItem('ring_iron', { rarity: 'rare', identified: true, affixes: [{ id: 'sfx_res_all_1', kind: 'suffix', values: [7, 7, 7, 7, 7, 7] }] });
  const tooltip = new Tooltip({}, layer, t, null);
  tooltip.showTooltip(hoveredRing, 500, 300, true);
  tooltip.update(0.016, ctx);

  assert.equal(tooltip.__comparePanelCount(), 2);
  assert.ok(tooltip.__totalNodeCount() <= 200, `__totalNodeCount()=${tooltip.__totalNodeCount()} should be well under the 700-node ceiling`);
});

// ---------------------------------------------------------------------------
// Placement — §5.6.3's opposite-side stacking, and UI-5's own containment/
// cursor-avoidance guarantee, swept across many anchors (not just four
// corners) WITH two comparison panels also on screen — the orchestrator's
// own stated requirement.
// ---------------------------------------------------------------------------

test('UI-7 placement sweep: primary containment and cursor-avoidance still hold, and both comparison panels stay contained, across a dense anchor sweep', () => {
  const VW = 1920; const VH = 1080; const EDGE = 12;
  const w = 320; const h = 260; // primary
  const panelSizes = [{ w: 300, h: 220 }, { w: 300, h: 220 }];
  let checked = 0;

  for (let ax = 20; ax < VW; ax += 47) {
    for (let ay = 20; ay < VH; ay += 53) {
      const p0 = computePlacement(ax, ay, w, h, VW, VH, null, null);
      const primaryRect = { x: p0.x, y: p0.y, w, h };
      assert.ok(primaryRect.x >= EDGE - 1e-6 && primaryRect.x + w <= VW - EDGE + 1e-6, `primary x contained at (${ax},${ay})`);
      assert.ok(primaryRect.y >= EDGE - 1e-6 && primaryRect.y + h <= VH - EDGE + 1e-6, `primary y contained at (${ax},${ay})`);

      // UI-5's own guarantee — the cursor (here, at the anchor, matching
      // this suite's own clause-3 convention) must never end up inside the
      // PRIMARY rect, even with two comparison panels also being placed.
      const withCursor = computePlacement(ax, ay, w, h, VW, VH, ax, ay);
      const insideX = ax >= withCursor.x && ax <= withCursor.x + w;
      const insideY = ay >= withCursor.y && ay <= withCursor.y + h;
      assert.ok(!(insideX && insideY), `cursor escaped the primary at (${ax},${ay})`);

      const positions = computeComparePlacement(primaryRect, panelSizes, ax, VW, VH);
      for (let i = 0; i < positions.length; i++) {
        const pw = panelSizes[i].w; const ph = panelSizes[i].h;
        assert.ok(positions[i].x >= EDGE - 1e-6 && positions[i].x + pw <= VW - EDGE + 1e-6, `panel ${i} x contained at (${ax},${ay})`);
        assert.ok(positions[i].y >= EDGE - 1e-6 && positions[i].y + ph <= VH - EDGE + 1e-6, `panel ${i} y contained at (${ax},${ay})`);
      }
      checked++;
    }
  }
  assert.ok(checked > 500, `a real sweep, not four corners (checked ${checked} anchors)`);
});

// ===========================================================================
// Pure fixture tests for the delta-chip machinery itself — fast, fully
// controlled, independent of ItemsSystem (same "prove the algorithm against
// a plain fixture" reason this file's header gives for every other pure
// function in tooltip.js).
// ===========================================================================

test('computePanelChips: matched (good/danger/equal) and "lost" are computed correctly from compareKey/compareValue alone', () => {
  const primaryModel = {
    statLines: [{ compareKey: 'defense', compareValue: 50 }, { compareKey: 'attackSpeedRate', compareValue: 1.20 }],
    propLines: [
      { compareKey: 'maxLife', compareValue: 20 },
      { compareKey: 'attackRating', compareValue: 15 },
    ],
  };
  const panelModel = {
    statLines: [{ compareKey: 'defense', compareValue: 42 }, { compareKey: 'attackSpeedRate', compareValue: 1.35 }],
    propLines: [
      { compareKey: 'maxLife', compareValue: 20 }, // equal -> no chip
      { compareKey: 'blockChance', compareValue: 10 }, // present only on the panel -> "lost"
    ],
  };
  const keys = computePanelChips(primaryModel, panelModel, t);
  assert.deepEqual(keys.slice().sort(), ['attackSpeedRate', 'blockChance', 'defense', 'maxLife']);

  assert.equal(panelModel.statLines[0].chip.cls, 'good', 'primary defense (50) > panel (42) -> primary better');
  assert.equal(panelModel.statLines[0].chip.text, '▲ +8');

  assert.equal(panelModel.statLines[1].chip.cls, 'danger', 'primary rate (1.20) < panel (1.35) -> primary worse');
  assert.equal(panelModel.statLines[1].chip.text, '▼ −0.15', 'attackSpeedRate keeps 2 decimals');

  assert.equal(panelModel.propLines[0].chip, null, 'equal values -> no chip');

  assert.equal(panelModel.propLines[1].chip.cls, 'danger');
  assert.equal(panelModel.propLines[1].chip.text, '▼ ' + t('tooltip.compareLost'));
});

test('applyPrimaryNewChips: a primary compareKey absent from every open panel gets a "new" chip; one present in the union stays null', () => {
  const primaryModel = {
    statLines: [],
    propLines: [
      { compareKey: 'maxLife', chip: undefined },
      { compareKey: 'attackRating', chip: undefined },
      { compareKey: null, chip: undefined }, // non-comparable line — must never chip
    ],
  };
  applyPrimaryNewChips(primaryModel, ['maxLife'], t);
  assert.equal(primaryModel.propLines[0].chip, null, 'present in the union -> no primary chip (already shown on a panel)');
  assert.equal(primaryModel.propLines[1].chip.cls, 'good');
  assert.equal(primaryModel.propLines[1].chip.text, '▲ ' + t('tooltip.compareNew'));
  assert.equal(primaryModel.propLines[2].chip, null);
});

test('clearChips: wipes every chip on a model back to null', () => {
  const model = {
    statLines: [{ chip: { text: 'x', cls: 'good' } }],
    propLines: [{ chip: { text: 'y', cls: 'danger' } }],
  };
  clearChips(model);
  assert.equal(model.statLines[0].chip, null);
  assert.equal(model.propLines[0].chip, null);
});

test('tooltip.js source: the resistance-merge compare key is a canonical (sorted) stat-id join, no Map involved', () => {
  // A cheap regression guard for the "exact-shape merge match" design
  // decision documented in buildPropertyLines — asserted at the source
  // level since the sort itself has no separate exported entry point.
  assert.match(TOOLTIP_SRC, /resistgrp:.*RESIST_STATS\.indexOf/);
});
