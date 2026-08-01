// tests/save/save1.test.js
//
// SAVE-1 acceptance tests for src/save/schema.js's `validate()` and
// src/save/index.js's `SaveSystem` (`02-api-contracts.md` §16's
// `validate(obj, version) => { ok, failures }` row). `node:test` +
// `node:assert/strict` only, matching every sibling test file.
//
// This ticket's own acceptance criterion: `01-data-model.md` §10.3's
// fifteen invariants (1-15; 16/17 are M6, ruling D-27) all hold, each with
// its own test that (a) quotes the invariant verbatim and (b) proves
// `validate()` catches a REAL violation, not just that a valid fixture
// passes — "a validator only tested against valid data is untested" (this
// ticket's own brief). Every violation test builds a fixture that starts
// from `VALID_SAVE()` (a save that already satisfies all fifteen, proven
// once below) and mutates exactly the field(s) needed to trip one
// invariant, then asserts `failures` contains an `'invariant N: '`-prefixed
// entry for that number specifically.
//
// Fixtures are built by hand (not via `items.rollItem`, which is
// RNG-driven and would make rarity/affix-count fixtures unreproducible)
// from real `ItemBase`/`AffixDefinition`/`UniqueDefinition` records —
// imported directly from `src/items/data/*.js`, the same "a test may import
// another subsystem's internals to build a fixture; only production code
// may not" precedent `tests/ui/inventory.test.js` and
// `tests/items/roll.test.js` already set (ARCHITECTURE.md rule 2 binds
// `src/*/index.js` production code, not test fixtures).
//
// The real engine is booted (`../../src/main.js#boot`) so `ctx.get('save')`
// is the genuine `SaveSystem` instance reached through `ctx.get('items')`
// exactly as production code would — the test-form rule: a test proves a
// path ROUTES into production code, not a hand-rolled substitute for it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { SaveSystem } from '../../src/save/index.js';
import {
  SCHEMA_VERSION,
  INVARIANT_COUNT,
  validate,
  SKILL_REGISTRY,
  SKILL_REGISTRY_BY_ID,
  CLASS_START_ATTRIBUTES,
  CLASS_START_SKILL_POINTS,
  RARITY_AFFIX_RULE,
  INVENTORY_W,
  INVENTORY_H,
  STASH_W,
  STASH_H,
  KNOWN_ZONE_IDS,
} from '../../src/save/schema.js';
import { ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';
import { AFFIXES_BY_ID } from '../../src/items/data/affixes.js';
import { UNIQUES_BY_ID } from '../../src/items/data/uniques.js';
// Test-only: pins CLASS_START_ATTRIBUTES (schema.js) against the live
// table it mirrors — see "CLASS_START_ATTRIBUTES stays pinned..." below,
// and schema.js's own header, for why the copy exists and why this pin is
// the safeguard against it drifting silently (orchestrator round 2).
import { CLASS_TABLE as ACTORS_CLASS_TABLE } from '../../src/actors/stats.js';

// ---------------------------------------------------------------------------
// Boot helper — matches tests/player/hudstate.test.js's own precedent.
// ---------------------------------------------------------------------------

function makeCanvas(width = 1280, height = 720) {
  return {
    width, height, clientWidth: width, clientHeight: height,
    addEventListener() {}, removeEventListener() {},
  };
}

async function bootGame(opts = {}) {
  return boot({ canvas: makeCanvas(), deterministic: true, global: {}, ...opts });
}

// ---------------------------------------------------------------------------
// Fixture factory — real ItemBase/AffixDefinition/UniqueDefinition records,
// hand-assembled into the exact `serialiseItem` (ITEM-16) shape so these
// fixtures are indistinguishable from a real save write.
// ---------------------------------------------------------------------------

let _uid = 1;
function nextUid() { return _uid++; }
function resetUids() { _uid = 1; }

/** @param {string} baseId @param {object} [overrides] */
function makeItem(baseId, overrides = {}) {
  const base = ITEM_BASES_BY_ID[baseId];
  assert.ok(base, `test setup: '${baseId}' must be a real base id`);
  const item = {
    uid: overrides.uid ?? nextUid(),
    baseId,
    rarity: overrides.rarity ?? 'normal',
    ilvl: overrides.ilvl ?? base.reqLevel,
    identified: overrides.identified ?? true,
    quantity: overrides.quantity ?? 1,
    rolls: overrides.rolls ?? { defense: 0, superior: 0, damageMin: 0, damageMax: 0 },
    affixes: overrides.affixes ?? [],
    uniqueId: overrides.uniqueId ?? null,
    uniqueValues: overrides.uniqueValues ?? [],
    nameOverride: overrides.nameOverride ?? null,
    durability: overrides.durability ?? base.maxDurability,
    maxDurability: overrides.maxDurability ?? base.maxDurability,
    sockets: overrides.sockets ?? [],
    socketCount: overrides.socketCount ?? 0,
    grid: 'grid' in overrides ? overrides.grid : null,
    slot: 'slot' in overrides ? overrides.slot : null,
  };
  return item;
}

/** An affix instance for `baseAffixId`, with `values` sized to match the
 * real `AffixDefinition.mods.length` — so a fixture that is not itself
 * testing invariant 12's values-length clause never trips it by accident. */
function makeAffix(affixId, values) {
  const def = AFFIXES_BY_ID[affixId];
  assert.ok(def, `test setup: '${affixId}' must be a real affix id`);
  const vals = values ?? def.mods.map((m) => m.min);
  assert.equal(vals.length, def.mods.length, 'test setup: values must match mods length by default');
  return { id: affixId, kind: def.kind, values: vals };
}

// Real ids used throughout — resolved once, so a typo fails loudly at
// import time instead of silently inside a fixture.
const AXE_1H = 'axe_hand_normal'; // weapon, one-handed, invW1 invH3
const SWORD_2H = 'sword_great_exceptional'; // weapon, two-handed, invW2 invH4
const BELT_BASE = 'belt_sash_normal'; // armour, equip slot 'belt'
const RING_BASE = 'ring_iron'; // jewelry, invW1 invH1, maxDurability 0
const POTION_BASE = 'potion_life_minor'; // consumable, invW1 invH1
const PFX_2MOD = 'pfx_flat_phys_1'; // prefix, mods.length === 2
const UNIQUE_ID = 'verens_reckoning'; // baseId axe_battle_normal, mods.length 7

assert.ok(ITEM_BASES_BY_ID[AXE_1H] && !ITEM_BASES_BY_ID[AXE_1H].weapon.twoHanded, 'test setup: AXE_1H must be one-handed');
assert.ok(ITEM_BASES_BY_ID[SWORD_2H] && ITEM_BASES_BY_ID[SWORD_2H].weapon.twoHanded, 'test setup: SWORD_2H must be two-handed');
assert.ok(UNIQUES_BY_ID[UNIQUE_ID], 'test setup: UNIQUE_ID must be a real unique id');

/**
 * A CharacterSave that satisfies all fifteen invariants, by construction:
 *   - level 5, ravager. `experience` is an arbitrary placeholder integer —
 *     invariant 2's `experience` half is deferred (no XP_TABLE exists yet;
 *     see the invariant 2 section below), so no value is "the valid one".
 *   - attributes sum to CLASS_START_ATTRIBUTES.ravager's sum + (5-1)*5,
 *     unspentStatPoints 0 (invariant 3).
 *   - skills = { cleaving_strike: 5 }, sum − CLASS_START_SKILL_POINTS(1) +
 *     unspentSkillPoints(0) === level−1(4) (invariant 4); cleaving_strike is
 *     a real ravager skill, tier 1 <= 5, no prereqs (invariants 5/6).
 *   - one equipped one-handed weapon + belt armour, one equipped-empty
 *     offHand (invariant 11 trivially holds), two inventory items
 *     (non-overlapping, in-bounds — invariant 9), one belt-row consumable
 *     (invariant 10), all uids unique and < nextItemUid (invariant 8), all
 *     baseId/affix ids real (invariant 7), rarity/affix counts legal
 *     (invariant 12), durability at max (invariant 13).
 *   - difficulty 'trial' ∈ difficultyUnlocked (invariant 14); currentZone
 *     'last_bastion', a real zone (invariant 15).
 */
function makeValidSave() {
  resetUids();
  const mainHand = makeItem(AXE_1H, { slot: 'mainHand', grid: null });
  const belt = makeItem(BELT_BASE, { slot: 'belt', grid: null });
  const ring = makeItem(RING_BASE, { grid: { container: 'inventory', x: 0, y: 0 } });
  const magicAxe = makeItem(AXE_1H, {
    rarity: 'magic',
    affixes: [makeAffix(PFX_2MOD)],
    grid: { container: 'inventory', x: 2, y: 0 },
  });
  const potion = makeItem(POTION_BASE, { grid: { container: 'belt', x: 0, y: 0 } });

  return {
    schemaVersion: 1,
    slot: 0,
    name: 'Verrin',
    classId: 'ravager',
    level: 5,
    experience: 33150, // 01-data-model.md §10.2's own example value; not gated (invariant 2's experience half is deferred)
    playSeconds: 100,

    attributes: { strength: 50, dexterity: 20, vitality: 25, energy: 10 }, // sum 105
    unspentStatPoints: 0,
    unspentSkillPoints: 0,
    skills: { cleaving_strike: 5 },
    hotbar: { slots: ['cleaving_strike', null, null, null], rightMouse: 0, leftMouse: -1 },

    equipment: {
      head: null, chest: null, hands: null, legs: null,
      mainHand, offHand: null, belt,
      amulet: null, ring1: null, ring2: null,
    },
    inventory: [ring, magicAxe],
    belt: [potion, null, null, null],
    gold: 100,
    nextItemUid: 100,

    difficulty: 'trial',
    difficultyUnlocked: ['instruction', 'trial'],
    worldSeed: 0x1f3ac09b,
    runIndex: {},
    currentZone: 'last_bastion',

    quests: {},
    questSkillPointsGranted: 0,

    stats: {
      monstersKilled: 0, championsKilled: 0, uniquesKilled: 0, bossKills: 0,
      deaths: 0, itemsFound: 0, uniquesFound: 0, goldCollected: 0, highestDamage: 0,
    },
  };
}

const DEPS = {
  itemBase: (id) => ITEM_BASES_BY_ID[id],
  itemAffix: (id) => AFFIXES_BY_ID[id],
  itemUnique: (id) => UNIQUES_BY_ID[id],
  zoneResolves: (zoneId) => KNOWN_ZONE_IDS.includes(zoneId),
};

/** Deep-clones a fixture via JSON round-trip — safe here because every
 * fixture field is JSON-safe by construction (the whole point of a save). */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Baseline — the fixture itself must be clean, or every violation test below
// would be meaningless (they'd all be one mutation away from an ALREADY
// failing save).
// ---------------------------------------------------------------------------

test('VALID_SAVE(): the baseline fixture itself passes all fifteen invariants', () => {
  const result = validate(makeValidSave(), SCHEMA_VERSION, DEPS);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
});

test('schema.js exposes exactly INVARIANT_COUNT = 15, matching 01-data-model.md §10.3 (16/17 are M6, D-27)', () => {
  assert.equal(INVARIANT_COUNT, 15);
  assert.equal(SCHEMA_VERSION, 1);
});

// ---------------------------------------------------------------------------
// Routing: ctx.get('save').validate(...) reaches the real production path,
// not a hand-rolled substitute (the test-form rule).
// ---------------------------------------------------------------------------

test('ctx.get(\'save\').validate() routes to the real SaveSystem and matches the pure validate() result', async () => {
  const { ctx } = await bootGame();
  const save = ctx.get('save');
  assert.ok(save instanceof SaveSystem);
  assert.equal(SaveSystem.SCHEMA_VERSION, SCHEMA_VERSION);

  const obj = makeValidSave();
  const result = save.validate(obj, SaveSystem.SCHEMA_VERSION);
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.deepEqual(result.failures, []);
});

test('ctx.get(\'save\').validate() on a broken save returns an explicit refusal — never throws, never silently passes', async () => {
  const { ctx } = await bootGame();
  const save = ctx.get('save');
  const obj = makeValidSave();
  obj.difficulty = 'renunciation'; // not in difficultyUnlocked
  const result = save.validate(obj, SaveSystem.SCHEMA_VERSION);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.startsWith('invariant 14:')));
});

// ---------------------------------------------------------------------------
// Invariant 1 | `schemaVersion` present and ≤ the running `SCHEMA_VERSION`
// ---------------------------------------------------------------------------

test('invariant 1: schemaVersion present and ≤ the running SCHEMA_VERSION', () => {
  const okObj = makeValidSave();
  assert.equal(validate(okObj, SCHEMA_VERSION, DEPS).ok, true);

  const tooNew = clone(makeValidSave());
  tooNew.schemaVersion = SCHEMA_VERSION + 1;
  const r1 = validate(tooNew, SCHEMA_VERSION, DEPS);
  assert.ok(r1.failures.some((f) => f.startsWith('invariant 1:')), r1.failures.join('\n'));

  const missing = clone(makeValidSave());
  delete missing.schemaVersion;
  const r2 = validate(missing, SCHEMA_VERSION, DEPS);
  assert.ok(r2.failures.some((f) => f.startsWith('invariant 1:')), r2.failures.join('\n'));
});

// ---------------------------------------------------------------------------
// Invariant 2 | `level` ∈ 1..30, `experience` ≥ `XP_TABLE[level]` and
// < `XP_TABLE[level+1]` (level 30: ≥ only)
//
// PARTIAL (orchestrator round 2): only the `level ∈ 1..30` half is
// checked. The `experience` half needs `XP_TABLE` — no level→XP threshold
// curve exists anywhere in this codebase or in this ticket's authorised
// reading; its real owner is `13-progression-lore.md` §12 ticket L1
// (`src/player/data/progression.js`), not in M3. A synthetic curve was
// built, caught in review as an invented number a validator must never
// carry, and removed — see schema.js's own header and `checkInvariant2`'s
// comment. Per the test-form rule / O-27, this file does NOT assert the
// deferred half is absent — it only proves what invariant 2 checks today.
// ---------------------------------------------------------------------------

test('invariant 2: level out of 1..30 is rejected', () => {
  const obj = clone(makeValidSave());
  obj.level = 31;
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 2:')), r.failures.join('\n'));
});

test('invariant 2: level below 1 is rejected', () => {
  const obj = clone(makeValidSave());
  obj.level = 0;
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 2:')), r.failures.join('\n'));
});

test('invariant 2: a non-integer level is rejected', () => {
  const obj = clone(makeValidSave());
  obj.level = 5.5;
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 2:')), r.failures.join('\n'));
});

test('invariant 2: a valid level (1..30) never fails on its own — spot-checked at both ends', () => {
  for (const level of [1, 30]) {
    const obj = clone(makeValidSave());
    obj.level = level;
    // Re-balance invariants 3/4's own budgets for this level so only
    // invariant 2 is under test — same "clear the OTHER invariants so this
    // one is isolated" approach the level-30 fixture used before the
    // XP_TABLE removal.
    const startSum = CLASS_START_ATTRIBUTES.ravager.strength + CLASS_START_ATTRIBUTES.ravager.dexterity
      + CLASS_START_ATTRIBUTES.ravager.vitality + CLASS_START_ATTRIBUTES.ravager.energy;
    // attributes stay makeValidSave()'s own {50,20,25,10} (sum 105); solve
    // unspentStatPoints/unspentSkillPoints for THIS level instead.
    obj.unspentStatPoints = (level - 1) * 5 - (105 - startSum);
    obj.unspentSkillPoints = (level - 1) - (5 - CLASS_START_SKILL_POINTS);
    const r = validate(obj, SCHEMA_VERSION, DEPS);
    assert.ok(!r.failures.some((f) => f.startsWith('invariant 2:')), `level ${level}: ${r.failures.join('\n')}`);
  }
});

// ---------------------------------------------------------------------------
// Invariant 3 | `Σ attributes − Σ classStart + unspentStatPoints
// === (level − 1) × 5`
// ---------------------------------------------------------------------------

test('invariant 3: attribute sum out of budget is rejected', () => {
  const obj = clone(makeValidSave());
  obj.attributes.strength += 1; // budget over by 1, unspentStatPoints unchanged
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 3:')), r.failures.join('\n'));
});

test('invariant 3: real classStart numbers matter — a save spending the SAME total but claiming an unknown class is rejected', () => {
  const obj = clone(makeValidSave());
  obj.classId = 'not_a_real_class';
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 3:')), r.failures.join('\n'));
});

// CLASS_START_ATTRIBUTES is a BY-VALUE copy of src/actors/stats.js's
// already-shipped CLASS_TABLE.start{Str,Dex,Vit,Ene} rows (no
// `ctx.get('actors')` accessor exists yet to read them directly —
// `02-api-contracts.md` §7 lists only `stats`/`markDirty`/
// `setSourceLayer`). Orchestrator round 2: rather than leave that copy to
// drift silently out of sync with the live table (the exact ITEM-16/
// `refreshWeaponCache` mistake this milestone already paid for once), this
// test pins the two against each other directly — an edit to either side
// that diverges turns THIS test red, not `validate()` quietly wrong.
test('invariant 3 data: CLASS_START_ATTRIBUTES stays pinned to the live src/actors/stats.js CLASS_TABLE', () => {
  assert.deepEqual(Object.keys(CLASS_START_ATTRIBUTES).sort(), Object.keys(ACTORS_CLASS_TABLE).sort());
  for (const classId of Object.keys(CLASS_START_ATTRIBUTES)) {
    const mine = CLASS_START_ATTRIBUTES[classId];
    const live = ACTORS_CLASS_TABLE[classId];
    assert.equal(mine.strength, live.startStr, `${classId}.strength`);
    assert.equal(mine.dexterity, live.startDex, `${classId}.dexterity`);
    assert.equal(mine.vitality, live.startVit, `${classId}.vitality`);
    assert.equal(mine.energy, live.startEne, `${classId}.energy`);
  }
});

// ---------------------------------------------------------------------------
// Invariant 4 (AMENDED) | `Σ skills.values − Σ classStartSkills +
// unspentSkillPoints === level − 1`
// ---------------------------------------------------------------------------

test('invariant 4 (amended): unspentSkillPoints drifted from the true budget is rejected', () => {
  const obj = clone(makeValidSave());
  obj.unspentSkillPoints = 1; // was 0; sum(skills) unchanged — budget now off by one
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 4:')), r.failures.join('\n'));
});

test('invariant 4 (amended): the − Σ classStartSkills term is load-bearing — without it, a character whose class kit pre-spent a point looks broken even when correct', () => {
  // The VALID_SAVE fixture is only valid BECAUSE the amended formula
  // subtracts CLASS_START_SKILL_POINTS (1). Proven directly: the
  // UNAMENDED formula (no subtraction) on the exact same, otherwise-valid
  // save does NOT balance — i.e. this ticket's own reasoning for the
  // amendment is not just asserted, it is demonstrated arithmetically.
  const obj = makeValidSave();
  const sumSkills = Object.values(obj.skills).reduce((a, b) => a + b, 0);
  const unamended = sumSkills + obj.unspentSkillPoints; // no "− Σ classStartSkills"
  const amended = sumSkills - CLASS_START_SKILL_POINTS + obj.unspentSkillPoints;
  assert.notEqual(unamended, obj.level - 1, 'the unamended formula must NOT balance for this fixture');
  assert.equal(amended, obj.level - 1, 'the amended formula must balance for this fixture');
});

// ---------------------------------------------------------------------------
// Invariant 5 | Every `skills` key exists in the registry and belongs to
// `classId`; every value ∈ 1..20
// ---------------------------------------------------------------------------

test('invariant 5: an unknown skill id is rejected', () => {
  const obj = clone(makeValidSave());
  obj.skills.not_a_real_skill = 1;
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 5:')), r.failures.join('\n'));
});

test('invariant 5: a real skill from a DIFFERENT class is rejected', () => {
  const obj = clone(makeValidSave());
  obj.skills.ember_bolt = 1; // emberwright skill on a ravager save
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 5:')), r.failures.join('\n'));
});

test('invariant 5: a skill value out of 1..20 is rejected', () => {
  const obj = clone(makeValidSave());
  obj.skills.cleaving_strike = 21;
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 5:')), r.failures.join('\n'));
});

// ---------------------------------------------------------------------------
// Invariant 6 | Every skill's `tier` ≤ `level`, and every prerequisite in
// `requires` is satisfied
// ---------------------------------------------------------------------------

test('invariant 6: a skill whose tier exceeds the character\'s level is rejected', () => {
  const warCry = SKILL_REGISTRY_BY_ID.war_cry;
  assert.equal(warCry.classId, 'ravager');
  assert.ok(warCry.tier > 5, 'test setup: war_cry must be above the fixture\'s level 5');
  const obj = clone(makeValidSave());
  obj.skills.war_cry = 1;
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 6:')), r.failures.join('\n'));
});

test('invariant 6: an unmet prerequisite (sunder requires bloodletting >= 3) is rejected even when the tier gate passes', () => {
  const sunder = SKILL_REGISTRY_BY_ID.sunder;
  assert.deepEqual(sunder.requires, [{ skillId: 'bloodletting', level: 3 }]);
  const obj = clone(makeValidSave());
  obj.level = 20; // clears sunder's own tier (18) so ONLY the prereq is under test
  obj.skills = { cleaving_strike: 5, sunder: 1 }; // no bloodletting at all
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 6:')), r.failures.join('\n'));
  assert.ok(r.failures.some((f) => f.includes('sunder') && f.includes('bloodletting')), r.failures.join('\n'));
});

test('invariant 6: SKILL_REGISTRY has exactly 30 entries, ten per class (01-data-model.md §6.3)', () => {
  assert.equal(SKILL_REGISTRY.length, 30);
  for (const classId of ['ravager', 'emberwright', 'runeblade']) {
    assert.equal(SKILL_REGISTRY.filter((s) => s.classId === classId).length, 10);
  }
});

// ---------------------------------------------------------------------------
// Invariant 7 | Every `baseId`, `uniqueId` and affix `id` resolves in the
// current data tables
// ---------------------------------------------------------------------------

test('invariant 7: an unresolvable baseId is rejected', () => {
  const obj = clone(makeValidSave());
  obj.equipment.mainHand.baseId = 'totally_fake_base_id';
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 7:') && f.includes('baseId')), r.failures.join('\n'));
});

test('invariant 7: an unresolvable uniqueId is rejected', () => {
  const obj = clone(makeValidSave());
  obj.equipment.mainHand.uniqueId = 'not_a_real_unique';
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 7:') && f.includes('uniqueId')), r.failures.join('\n'));
});

test('invariant 7: an unresolvable affix id is rejected', () => {
  const obj = clone(makeValidSave());
  obj.inventory[1].affixes.push({ id: 'not_a_real_affix', kind: 'suffix', values: [1] });
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 7:') && f.includes('affix')), r.failures.join('\n'));
});

test('invariant 7: a real uniqueId (verens_reckoning) resolves cleanly', () => {
  const obj = clone(makeValidSave());
  obj.equipment.mainHand.uniqueId = UNIQUE_ID;
  obj.equipment.mainHand.rarity = 'unique';
  obj.equipment.mainHand.uniqueValues = UNIQUES_BY_ID[UNIQUE_ID].mods.map((m) => m.min);
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(!r.failures.some((f) => f.startsWith('invariant 7:')), r.failures.join('\n'));
});

// ---------------------------------------------------------------------------
// Invariant 8 | Every `ItemInstance.uid` is unique across equipment +
// inventory + belt + stash, and `< nextItemUid`
// ---------------------------------------------------------------------------

test('invariant 8: a duplicate uid across two containers is rejected', () => {
  const obj = clone(makeValidSave());
  obj.inventory[0].uid = obj.equipment.mainHand.uid; // collide
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 8:') && f.includes('is used by both')), r.failures.join('\n'));
});

test('invariant 8: a uid >= nextItemUid is rejected', () => {
  const obj = clone(makeValidSave());
  obj.equipment.mainHand.uid = obj.nextItemUid; // exactly equal — must be strictly less
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 8:') && f.includes('nextItemUid')), r.failures.join('\n'));
});

// ---------------------------------------------------------------------------
// Invariant 9 | Inventory rectangles are inside 10×4, do not overlap; stash
// inside 10×8. (Extended per this ticket's Ruling 1 — grid/slot exclusivity;
// see schema.js's own comment on checkGridSlotExclusivity.)
// ---------------------------------------------------------------------------

test('invariant 9: an inventory rectangle outside the 10x4 grid is rejected', () => {
  const obj = clone(makeValidSave());
  obj.inventory[1].grid.x = INVENTORY_W - 1; // axe is invW1 invH3; x=9 -> x+invW=10, still fits — force overflow via y instead
  obj.inventory[1].grid.y = INVENTORY_H - 1; // y=3 -> y+invH(3)=6 > 4
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 9:') && f.includes('outside')), r.failures.join('\n'));
});

test('invariant 9: two overlapping inventory rectangles are rejected', () => {
  const obj = clone(makeValidSave());
  obj.inventory[1].grid = { container: 'inventory', x: 0, y: 0 }; // now sits on top of inventory[0] (the ring, also 0,0)
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 9:') && f.includes('overlaps')), r.failures.join('\n'));
});

test('invariant 9: a stash rectangle outside the 10x8 grid is rejected', () => {
  const obj = clone(makeValidSave());
  obj.items = [makeItem(RING_BASE, { grid: { container: 'stash', x: STASH_W, y: 0 } })];
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 9:') && f.includes('outside')), r.failures.join('\n'));
});

test('invariant 9 (Ruling 1): an equipped item with a stale non-null grid is rejected, distinctly from a missing key', () => {
  const staleGrid = clone(makeValidSave());
  staleGrid.equipment.mainHand.grid = { container: 'inventory', x: 0, y: 0 }; // stale — item is equipped (slot set)
  const r1 = validate(staleGrid, SCHEMA_VERSION, DEPS);
  assert.ok(r1.failures.some((f) => f.startsWith('invariant 9:') && f.includes('stale non-null grid')), r1.failures.join('\n'));

  const missingKey = clone(makeValidSave());
  delete missingKey.equipment.mainHand.slot;
  const r2 = validate(missingKey, SCHEMA_VERSION, DEPS);
  assert.ok(r2.failures.some((f) => f.startsWith('invariant 9:') && f.includes("missing the 'slot' key")), r2.failures.join('\n'));

  // Distinctly reported — not the same message text.
  const staleMsg = r1.failures.find((f) => f.startsWith('invariant 9:') && f.includes('grid'));
  const missingMsg = r2.failures.find((f) => f.startsWith('invariant 9:') && f.includes('slot'));
  assert.notEqual(staleMsg, missingMsg);
});

test('invariant 9 (Ruling 1): a bagged item with a stale non-null slot is rejected', () => {
  const obj = clone(makeValidSave());
  obj.inventory[0].slot = 'ring1'; // stale — item is bagged (grid set), never equipped
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 9:') && f.includes('stale non-null slot')), r.failures.join('\n'));
});

// ---------------------------------------------------------------------------
// Invariant 10 | Belt entries are `category === 'consumable'` or `null`
// ---------------------------------------------------------------------------

test('invariant 10: a non-consumable item in the belt row is rejected', () => {
  const obj = clone(makeValidSave());
  obj.belt[1] = makeItem(RING_BASE, { grid: { container: 'belt', x: 1, y: 0 } }); // jewelry, not consumable
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 10:')), r.failures.join('\n'));
});

// ---------------------------------------------------------------------------
// Invariant 11 | Two-handed `mainHand` implies `offHand === null`
// ---------------------------------------------------------------------------

test('invariant 11: a two-handed mainHand with a non-null offHand is rejected', () => {
  const obj = clone(makeValidSave());
  obj.equipment.mainHand = makeItem(SWORD_2H, { slot: 'mainHand', grid: null });
  obj.equipment.offHand = makeItem(RING_BASE, { slot: 'offHand', grid: null }); // any non-null offHand
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 11:')), r.failures.join('\n'));
});

test('invariant 11: a two-handed mainHand with a null offHand is accepted', () => {
  const obj = clone(makeValidSave());
  obj.equipment.mainHand = makeItem(SWORD_2H, { slot: 'mainHand', grid: null });
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(!r.failures.some((f) => f.startsWith('invariant 11:')), r.failures.join('\n'));
});

// ---------------------------------------------------------------------------
// Invariant 12 | `affixes` length matches the rarity rule (§1.6);
// `values.length === definition.mods.length`
// ---------------------------------------------------------------------------

test('invariant 12: a normal-rarity item carrying an affix is rejected', () => {
  const obj = clone(makeValidSave());
  obj.equipment.mainHand.affixes = [{ id: PFX_2MOD, kind: 'prefix', values: [1, 3] }]; // mainHand is 'normal'
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 12:') && f.includes('§1.6')), r.failures.join('\n'));
});

test('invariant 12: a rare item with only 1 total affix (below the 2-6 rule) is rejected', () => {
  const obj = clone(makeValidSave());
  obj.inventory[1].rarity = 'rare';
  obj.inventory[1].affixes = [makeAffix(PFX_2MOD)]; // 1 prefix, 0 suffix — rare needs >=1 of EACH
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 12:') && f.includes('§1.6')), r.failures.join('\n'));
});

test('invariant 12: an affix whose values.length does not match its definition\'s mods.length is rejected', () => {
  const obj = clone(makeValidSave());
  obj.inventory[1].affixes[0].values = [1]; // pfx_flat_phys_1 has 2 mods, not 1
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 12:') && f.includes('values')), r.failures.join('\n'));
});

test('RARITY_AFFIX_RULE matches 01-data-model.md §1.6\'s table exactly', () => {
  assert.deepEqual(Object.keys(RARITY_AFFIX_RULE).sort(), ['magic', 'normal', 'rare', 'superior', 'unique'].sort());
  assert.equal(RARITY_AFFIX_RULE.magic.totalMin, 1);
  assert.equal(RARITY_AFFIX_RULE.magic.totalMax, 2);
  assert.equal(RARITY_AFFIX_RULE.rare.totalMin, 2);
  assert.equal(RARITY_AFFIX_RULE.rare.totalMax, 6);
});

// ---------------------------------------------------------------------------
// Invariant 13 | `durability` ∈ 0..`maxDurability`
// ---------------------------------------------------------------------------

test('invariant 13: durability above maxDurability is rejected', () => {
  const obj = clone(makeValidSave());
  obj.equipment.mainHand.durability = obj.equipment.mainHand.maxDurability + 1;
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 13:')), r.failures.join('\n'));
});

test('invariant 13: negative durability is rejected', () => {
  const obj = clone(makeValidSave());
  obj.equipment.mainHand.durability = -1;
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 13:')), r.failures.join('\n'));
});

// ---------------------------------------------------------------------------
// Invariant 14 | `difficulty` ∈ `difficultyUnlocked`
// ---------------------------------------------------------------------------

test('invariant 14: a difficulty not present in difficultyUnlocked is rejected', () => {
  const obj = clone(makeValidSave());
  obj.difficulty = 'renunciation';
  // difficultyUnlocked left at ['instruction','trial']
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 14:')), r.failures.join('\n'));
});

// ---------------------------------------------------------------------------
// Invariant 15 | `currentZone` resolves; on any failure it falls back to
// `last_bastion`
// ---------------------------------------------------------------------------

test('invariant 15: an unresolvable currentZone is rejected', () => {
  const obj = clone(makeValidSave());
  obj.currentZone = 'nowhere_at_all';
  const r = validate(obj, SCHEMA_VERSION, DEPS);
  assert.ok(r.failures.some((f) => f.startsWith('invariant 15:')), r.failures.join('\n'));
});

test('invariant 15: every real zone id (src/world/data/zones.js) resolves cleanly', () => {
  for (const zoneId of KNOWN_ZONE_IDS) {
    const obj = clone(makeValidSave());
    obj.currentZone = zoneId;
    const r = validate(obj, SCHEMA_VERSION, DEPS);
    assert.ok(!r.failures.some((f) => f.startsWith('invariant 15:')), `${zoneId}: ${r.failures.join('\n')}`);
  }
});

test('SaveSystem#validate reaches the REAL world.descriptor(), not just the KNOWN_ZONE_IDS fallback', async () => {
  const { ctx } = await bootGame();
  const save = ctx.get('save');
  const world = ctx.get('world');
  assert.ok(world.descriptors.length > 0, 'test setup: world must have real zones');

  const obj = makeValidSave();
  obj.currentZone = world.descriptors[0].id;
  const okResult = save.validate(obj, SaveSystem.SCHEMA_VERSION);
  assert.ok(!okResult.failures.some((f) => f.startsWith('invariant 15:')), okResult.failures.join('\n'));

  obj.currentZone = 'definitely_not_a_zone_world_would_know';
  const badResult = save.validate(obj, SaveSystem.SCHEMA_VERSION);
  assert.ok(badResult.failures.some((f) => f.startsWith('invariant 15:')), badResult.failures.join('\n'));
});
