// src/items/data/affixes.js
//
// ITEM-2 — the 117 `AffixDefinition` records (`04-items.md` §2). Plain frozen
// data, no logic (`ARCHITECTURE.md` rule 9 / this ticket's brief rule 6):
// `tools/lootsim.mjs` (a later ticket) imports this module directly in Node,
// headless, with no `three` — nothing here may compute a value the table
// should state.
//
// Field shape is `01-data-model.md` §5.2's `AffixDefinition` example,
// verbatim — that document is the authority on field NAMES and TYPES; `04`
// §2 is the authority on VALUES. `04` §14.1 D-5 is binding and already
// reflected by the table itself (`pfx_enhanced_damage_3.requiresGroups` is
// `['weapon.any']`, not `01` §5.2's own stray example value of
// `['weapon.melee']`; `sfx_attack_rating_2`'s range is authored `12–30`).
//
// ---------------------------------------------------------------------------
// Count — 117, matching `04` §12 step 2 / this ticket's criterion
// ---------------------------------------------------------------------------
//   61 prefixes  (`04` §2.3)
// + 56 suffixes  (`04` §2.4)
// = 117
//
// ---------------------------------------------------------------------------
// `requiresGroups` / `appliesTo` — how the table's Applies column was read
// ---------------------------------------------------------------------------
// `04` §2.1: "Applies: `requiresGroups`, using the §1.4.1 codes. `appliesTo`
// is derived: any `W*` code contributes `'weapon'`, any `A*` code `'armour'`,
// any `J*` code `'jewelry'`, `U` all three." Each single-letter/two-letter
// shorthand in a row's Applies column (`W*`, `Wm`, `Wc`, `W2`, `A*`, `Ab`,
// `Ah`, `Ag`, `At`, `Al`, `As`, `J*`, `Jr`, `Ja`, `U`) expands to exactly one
// `04` §1.2 vocabulary string (`weapon.any`, `weapon.melee`, ...,
// `jewelry.amulet`, `universal`), and `appliesTo` was derived uniformly from
// the *namespace prefix* of each resulting vocabulary string (`weapon.*` ->
// `'weapon'`, `armour.*` -> `'armour'`, `jewelry.*` -> `'jewelry'`,
// `universal` -> all three) — mechanically equivalent to §2.1's rule stated
// per-shorthand-letter, but robust to the one shorthand below that isn't in
// §2.1's own list.
//
// AMBIGUITY — the `ST` marker (`pfx_allskills_1`, `sfx_mana_cost_1`).
// Two rows carry the literal code `ST` in their Applies column, which is NOT
// among §2.1's fifteen listed shorthand letters (`U W* Wm Wc W2 A* Ab Ah Ag
// At Al As J* Jr Ja`). §2.1 itself says the Applies column "us[es] the
// §1.4.1 codes", and §1.4.1 *does* define `ST` — but as a BASE's own
// `allowedAffixGroups` code: `['universal', 'weapon.any', 'weapon.caster',
// 'weapon.twohand']` (staves; see `src/items/data/bases.js`'s `AG.ST`).
// Expanding `ST` to that full four-string set would add `universal` to
// `requiresGroups`, which — because the filter (`04` §9.4 rule 5) is a plain
// intersection test — would make the affix legal on literally every base in
// the game (every `AG.*` entry in `bases.js` starts with `'universal'`).
// That directly contradicts both rows deliberately NOT using the `U`
// shorthand and pairing `ST` with a short, specific list of jewelry codes.
// No single §1.2 vocabulary string means "staff, excluding wand and 2H
// melee" (the vocabulary has `weapon.caster` — wand+staff — and
// `weapon.twohand` — 2H melee+staff — but no `weapon.staff`), so an exact
// "staff-only" reading isn't expressible through this filter at all.
// DECISION (revised after an independent reach check — see below): `ST`
// contributes ONLY `weapon.caster`, not `weapon.twohand`. The filter (`04`
// §9.4 rule 5) is a plain intersection, so `weapon.twohand` alone reaches
// every 2H MELEE base too (`sword_great_exceptional`, `polearm_reave_...`,
// all three `maul_*` bases) — measured: with `weapon.twohand` included,
// `pfx_allskills_1` was legal on 14 bases, five of them Great Mauls/
// Greatswords/a Glaive, nothing like the "amulet or staff" the `Ja ST` row
// plainly intends. `weapon.twohand` is a HANDLING property (shared by
// melee and staff alike); `weapon.caster` is the one §1.2 string that is a
// CASTER property, so it is `ST`'s correct distinguishing group for an
// affix, even though on its own it also reaches wands, not staves
// exclusively — the closest the vocabulary can get. Dropping `universal`
// AND `weapon.twohand` and keeping only `weapon.caster` gives
// `pfx_allskills_1` reach of 9 bases (3 amulets, 3 wands, 3 staves) and
// `sfx_mana_cost_1` reach of 17 (its `armour.helm`/`jewelry.amulet`/
// `jewelry.ring` groups add every helm and every ring/amulet on top of the
// same 6 wands+staves). Flagged in this ticket's report for whoever owns
// `04-items.md`: §2.1's shorthand table has no entry for `ST` at all, and
// the vocabulary has no "caster two-hander" string, so this reading is the
// nearest available, not an exact match to the table's intent.
//
// ---------------------------------------------------------------------------
// Reusable literal group sets
// ---------------------------------------------------------------------------
// Mirrors `bases.js`'s own `AG` pattern: named, frozen, literal arrays,
// referenced by pointer from many rows below. This is not computation — it
// is the same static table written once instead of retyped ~40 times, which
// is exactly what `AG` already does for `allowedAffixGroups` one file over.
const RG = Object.freeze({
  W_ANY: Object.freeze(['weapon.any']),
  W_AG_JR_JA: Object.freeze(['weapon.any', 'armour.gloves', 'jewelry.ring', 'jewelry.amulet']),
  W_JA: Object.freeze(['weapon.any', 'jewelry.amulet']),
  A_ANY: Object.freeze(['armour.any']),
  AB_AH_AL_AS_J: Object.freeze(['armour.body', 'armour.helm', 'armour.belt', 'armour.shield', 'jewelry.any']),
  AB_AH_AL_WC_J: Object.freeze(['armour.body', 'armour.helm', 'armour.belt', 'weapon.caster', 'jewelry.any']),
  WC_J: Object.freeze(['weapon.caster', 'jewelry.any']),
  AB_AH_AG_AL_AS_J: Object.freeze(['armour.body', 'armour.helm', 'armour.gloves', 'armour.belt', 'armour.shield', 'jewelry.any']),
  AH_AG_AT_AS_J: Object.freeze(['armour.helm', 'armour.gloves', 'armour.boots', 'armour.shield', 'jewelry.any']),
  AB_AL_AT_J: Object.freeze(['armour.body', 'armour.belt', 'armour.boots', 'jewelry.any']),
  AB_AH_WC_J: Object.freeze(['armour.body', 'armour.helm', 'weapon.caster', 'jewelry.any']),
  AH_JA_W: Object.freeze(['armour.helm', 'jewelry.amulet', 'weapon.any']),
  JA_ST: Object.freeze(['jewelry.amulet', 'weapon.caster']), // 'ST' resolved — see header
  AS_AB: Object.freeze(['armour.shield', 'armour.body']),
  AS_AL_AB: Object.freeze(['armour.shield', 'armour.belt', 'armour.body']),
  AS: Object.freeze(['armour.shield']),
  W_AG_J: Object.freeze(['weapon.any', 'armour.gloves', 'jewelry.any']),
  W_AG: Object.freeze(['weapon.any', 'armour.gloves']),
  WC_AG_AH_J: Object.freeze(['weapon.caster', 'armour.gloves', 'armour.helm', 'jewelry.any']),
  AB_AL_AT_AS_AH: Object.freeze(['armour.body', 'armour.belt', 'armour.boots', 'armour.shield', 'armour.helm']),
  A_J: Object.freeze(['armour.any', 'jewelry.any']),
  AB_AS_JA: Object.freeze(['armour.body', 'armour.shield', 'jewelry.amulet']),
  WM_JR_JA: Object.freeze(['weapon.melee', 'jewelry.ring', 'jewelry.amulet']),
  WM_JR: Object.freeze(['weapon.melee', 'jewelry.ring']),
  WM_AG_JA: Object.freeze(['weapon.melee', 'armour.gloves', 'jewelry.amulet']),
  AB_AL_J: Object.freeze(['armour.body', 'armour.belt', 'jewelry.any']),
  AH_WC_J: Object.freeze(['armour.helm', 'weapon.caster', 'jewelry.any']),
  W_AG_JA: Object.freeze(['weapon.any', 'armour.gloves', 'jewelry.amulet']),
  AT: Object.freeze(['armour.boots']),
  AH_AG_AT_J: Object.freeze(['armour.helm', 'armour.gloves', 'armour.boots', 'jewelry.any']),
  AH_AG_AT_AL_JR: Object.freeze(['armour.helm', 'armour.gloves', 'armour.boots', 'armour.belt', 'jewelry.ring']),
  AH_JA_JR_ST: Object.freeze(['armour.helm', 'jewelry.amulet', 'jewelry.ring', 'weapon.caster']),
  AT_AL_AH: Object.freeze(['armour.boots', 'armour.belt', 'armour.helm']),
  AS_AB_AL: Object.freeze(['armour.shield', 'armour.body', 'armour.belt']),
  AT_AG_AS: Object.freeze(['armour.boots', 'armour.gloves', 'armour.shield']),
  WM_AL_JA: Object.freeze(['weapon.melee', 'armour.belt', 'jewelry.amulet']),
  AT_AB_JA: Object.freeze(['armour.boots', 'armour.body', 'jewelry.amulet']),
  AH_AB_JA: Object.freeze(['armour.helm', 'armour.body', 'jewelry.amulet']),
  WM_JA: Object.freeze(['weapon.melee', 'jewelry.amulet']),
  AH_J: Object.freeze(['armour.helm', 'jewelry.any']),
  AG_AL_JR: Object.freeze(['armour.gloves', 'armour.belt', 'jewelry.ring']),
  AH_JA: Object.freeze(['armour.helm', 'jewelry.amulet']),
  JA_AS: Object.freeze(['jewelry.amulet', 'armour.shield']),
  WC_JA: Object.freeze(['weapon.caster', 'jewelry.amulet']),
  AH_AS_JA: Object.freeze(['armour.helm', 'armour.shield', 'jewelry.amulet']),
  AB_AS: Object.freeze(['armour.body', 'armour.shield']),
});

// `appliesTo` sets — every `ItemBase.category` combination actually needed
// above, each named for the categories it contains.
const AP = Object.freeze({
  W: Object.freeze(['weapon']),
  A: Object.freeze(['armour']),
  WA: Object.freeze(['weapon', 'armour']),
  WJ: Object.freeze(['weapon', 'jewelry']),
  AJ: Object.freeze(['armour', 'jewelry']),
  WAJ: Object.freeze(['weapon', 'armour', 'jewelry']),
});

export const AFFIXES = Object.freeze([
  // =========================================================================
  // Prefixes — `04` §2.3, 61 records.
  // =========================================================================
  Object.freeze({
    id: 'pfx_enhanced_damage_1', kind: 'prefix', group: 'enhanced_damage', name: 'Bitter',
    alvl: 1, maxLevel: 18, weight: 100, appliesTo: AP.W, requiresGroups: RG.W_ANY, sharedRoll: false,
    mods: [{ stat: 'enhancedDamage', min: 8, max: 18, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_enhanced_damage_2', kind: 'prefix', group: 'enhanced_damage', name: 'Jagged',
    alvl: 4, maxLevel: 26, weight: 78, appliesTo: AP.W, requiresGroups: RG.W_ANY, sharedRoll: false,
    mods: [{ stat: 'enhancedDamage', min: 19, max: 29, step: 1 }],
  }),
  Object.freeze({
    // 04 §14.1 D-5: requiresGroups is 'weapon.any', not 01 §5.2's stray
    // ['weapon.melee'] example. Everything else kept exactly.
    id: 'pfx_enhanced_damage_3', kind: 'prefix', group: 'enhanced_damage', name: 'Keen',
    alvl: 8, maxLevel: 40, weight: 60, appliesTo: AP.W, requiresGroups: RG.W_ANY, sharedRoll: false,
    mods: [{ stat: 'enhancedDamage', min: 30, max: 50, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_enhanced_damage_4', kind: 'prefix', group: 'enhanced_damage', name: 'Cruel',
    alvl: 20, maxLevel: 40, weight: 42, appliesTo: AP.W, requiresGroups: RG.W_ANY, sharedRoll: false,
    mods: [{ stat: 'enhancedDamage', min: 51, max: 75, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_enhanced_damage_5', kind: 'prefix', group: 'enhanced_damage', name: 'Merciless',
    alvl: 28, maxLevel: 99, weight: 24, appliesTo: AP.W, requiresGroups: RG.W_ANY, sharedRoll: false,
    mods: [{ stat: 'enhancedDamage', min: 76, max: 105, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_flat_phys_1', kind: 'prefix', group: 'flat_physical', name: 'Rough',
    alvl: 1, maxLevel: 20, weight: 92, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JR_JA, sharedRoll: false,
    mods: [
      { stat: 'minDamage', min: 1, max: 2, step: 1 },
      { stat: 'maxDamage', min: 3, max: 5, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_flat_phys_2', kind: 'prefix', group: 'flat_physical', name: 'Sharp',
    alvl: 12, maxLevel: 32, weight: 66, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JR_JA, sharedRoll: false,
    mods: [
      { stat: 'minDamage', min: 3, max: 6, step: 1 },
      { stat: 'maxDamage', min: 8, max: 14, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_flat_phys_3', kind: 'prefix', group: 'flat_physical', name: 'Sundering',
    alvl: 24, maxLevel: 99, weight: 38, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JR_JA, sharedRoll: false,
    mods: [
      { stat: 'minDamage', min: 7, max: 12, step: 1 },
      { stat: 'maxDamage', min: 16, max: 26, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_flat_fire_1', kind: 'prefix', group: 'flat_fire', name: 'Smoking',
    alvl: 4, maxLevel: 22, weight: 84, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JR_JA, sharedRoll: false,
    mods: [
      { stat: 'fireMin', min: 1, max: 3, step: 1 },
      { stat: 'fireMax', min: 4, max: 8, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_flat_fire_2', kind: 'prefix', group: 'flat_fire', name: 'Smouldering',
    alvl: 13, maxLevel: 33, weight: 60, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JR_JA, sharedRoll: false,
    mods: [
      { stat: 'fireMin', min: 4, max: 8, step: 1 },
      { stat: 'fireMax', min: 11, max: 20, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_flat_fire_3', kind: 'prefix', group: 'flat_fire', name: 'Pyre-Born',
    alvl: 23, maxLevel: 99, weight: 34, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JR_JA, sharedRoll: false,
    mods: [
      { stat: 'fireMin', min: 9, max: 16, step: 1 },
      { stat: 'fireMax', min: 24, max: 40, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_flat_cold_1', kind: 'prefix', group: 'flat_cold', name: 'Chilling',
    alvl: 4, maxLevel: 22, weight: 84, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JR_JA, sharedRoll: false,
    mods: [
      { stat: 'coldMin', min: 1, max: 2, step: 1 },
      { stat: 'coldMax', min: 3, max: 6, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_flat_cold_2', kind: 'prefix', group: 'flat_cold', name: 'Frigid',
    alvl: 13, maxLevel: 33, weight: 60, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JR_JA, sharedRoll: false,
    mods: [
      { stat: 'coldMin', min: 3, max: 6, step: 1 },
      { stat: 'coldMax', min: 8, max: 15, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_flat_cold_3', kind: 'prefix', group: 'flat_cold', name: 'Glacial',
    alvl: 23, maxLevel: 99, weight: 34, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JR_JA, sharedRoll: false,
    mods: [
      { stat: 'coldMin', min: 7, max: 13, step: 1 },
      { stat: 'coldMax', min: 18, max: 30, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_flat_light_1', kind: 'prefix', group: 'flat_lightning', name: 'Static',
    alvl: 4, maxLevel: 22, weight: 84, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JR_JA, sharedRoll: false,
    mods: [
      { stat: 'lightMin', min: 1, max: 1, step: 1 },
      { stat: 'lightMax', min: 6, max: 12, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_flat_light_2', kind: 'prefix', group: 'flat_lightning', name: 'Arcing',
    alvl: 13, maxLevel: 33, weight: 60, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JR_JA, sharedRoll: false,
    mods: [
      { stat: 'lightMin', min: 1, max: 2, step: 1 },
      { stat: 'lightMax', min: 16, max: 30, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_flat_light_3', kind: 'prefix', group: 'flat_lightning', name: 'Storm-Sworn',
    alvl: 23, maxLevel: 99, weight: 34, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JR_JA, sharedRoll: false,
    mods: [
      { stat: 'lightMin', min: 1, max: 3, step: 1 },
      { stat: 'lightMax', min: 34, max: 62, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_flat_poison_1', kind: 'prefix', group: 'flat_poison', name: 'Tainted',
    alvl: 8, maxLevel: 26, weight: 56, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JR_JA, sharedRoll: false,
    mods: [
      { stat: 'poisonMin', min: 6, max: 12, step: 1 },
      { stat: 'poisonMax', min: 14, max: 24, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_flat_poison_2', kind: 'prefix', group: 'flat_poison', name: 'Virulent',
    alvl: 20, maxLevel: 99, weight: 32, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JR_JA, sharedRoll: false,
    mods: [
      { stat: 'poisonMin', min: 20, max: 34, step: 1 },
      { stat: 'poisonMax', min: 44, max: 72, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_flat_magic_1', kind: 'prefix', group: 'flat_magic', name: 'Unspoken',
    alvl: 18, maxLevel: 99, weight: 26, appliesTo: AP.WJ, requiresGroups: RG.W_JA, sharedRoll: false,
    mods: [
      { stat: 'magicMin', min: 3, max: 6, step: 1 },
      { stat: 'magicMax', min: 9, max: 16, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'pfx_defense_1', kind: 'prefix', group: 'defense_flat', name: 'Sturdy',
    alvl: 1, maxLevel: 18, weight: 100, appliesTo: AP.A, requiresGroups: RG.A_ANY, sharedRoll: false,
    mods: [{ stat: 'defense', min: 4, max: 9, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_defense_2', kind: 'prefix', group: 'defense_flat', name: 'Strong',
    alvl: 8, maxLevel: 27, weight: 78, appliesTo: AP.A, requiresGroups: RG.A_ANY, sharedRoll: false,
    mods: [{ stat: 'defense', min: 10, max: 22, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_defense_3', kind: 'prefix', group: 'defense_flat', name: 'Bastion',
    alvl: 16, maxLevel: 34, weight: 56, appliesTo: AP.A, requiresGroups: RG.A_ANY, sharedRoll: false,
    mods: [{ stat: 'defense', min: 23, max: 46, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_defense_4', kind: 'prefix', group: 'defense_flat', name: 'Adamant',
    alvl: 25, maxLevel: 99, weight: 34, appliesTo: AP.A, requiresGroups: RG.A_ANY, sharedRoll: false,
    mods: [{ stat: 'defense', min: 47, max: 90, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_defpct_1', kind: 'prefix', group: 'defense_percent', name: 'Plated',
    alvl: 6, maxLevel: 24, weight: 80, appliesTo: AP.A, requiresGroups: RG.A_ANY, sharedRoll: false,
    mods: [{ stat: 'defensePercent', min: 12, max: 25, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_defpct_2', kind: 'prefix', group: 'defense_percent', name: 'Fortified',
    alvl: 15, maxLevel: 33, weight: 56, appliesTo: AP.A, requiresGroups: RG.A_ANY, sharedRoll: false,
    mods: [{ stat: 'defensePercent', min: 26, max: 45, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_defpct_3', kind: 'prefix', group: 'defense_percent', name: 'Impenetrable',
    alvl: 25, maxLevel: 99, weight: 32, appliesTo: AP.A, requiresGroups: RG.A_ANY, sharedRoll: false,
    mods: [{ stat: 'defensePercent', min: 46, max: 75, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_life_1', kind: 'prefix', group: 'max_life', name: 'Hale',
    alvl: 1, maxLevel: 18, weight: 96, appliesTo: AP.AJ, requiresGroups: RG.AB_AH_AL_AS_J, sharedRoll: false,
    mods: [{ stat: 'maxLife', min: 5, max: 11, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_life_2', kind: 'prefix', group: 'max_life', name: 'Vigorous',
    alvl: 8, maxLevel: 27, weight: 76, appliesTo: AP.AJ, requiresGroups: RG.AB_AH_AL_AS_J, sharedRoll: false,
    mods: [{ stat: 'maxLife', min: 12, max: 24, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_life_3', kind: 'prefix', group: 'max_life', name: 'Enduring',
    alvl: 16, maxLevel: 34, weight: 54, appliesTo: AP.AJ, requiresGroups: RG.AB_AH_AL_AS_J, sharedRoll: false,
    mods: [{ stat: 'maxLife', min: 25, max: 42, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_life_4', kind: 'prefix', group: 'max_life', name: 'Undying',
    alvl: 25, maxLevel: 99, weight: 32, appliesTo: AP.AJ, requiresGroups: RG.AB_AH_AL_AS_J, sharedRoll: false,
    mods: [{ stat: 'maxLife', min: 43, max: 70, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_mana_1', kind: 'prefix', group: 'max_mana', name: 'Lucid',
    alvl: 1, maxLevel: 20, weight: 92, appliesTo: AP.WAJ, requiresGroups: RG.AB_AH_AL_WC_J, sharedRoll: false,
    mods: [{ stat: 'maxMana', min: 6, max: 13, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_mana_2', kind: 'prefix', group: 'max_mana', name: 'Arcane',
    alvl: 11, maxLevel: 30, weight: 66, appliesTo: AP.WAJ, requiresGroups: RG.AB_AH_AL_WC_J, sharedRoll: false,
    mods: [{ stat: 'maxMana', min: 14, max: 30, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_mana_3', kind: 'prefix', group: 'max_mana', name: 'Boundless',
    alvl: 22, maxLevel: 99, weight: 38, appliesTo: AP.WAJ, requiresGroups: RG.AB_AH_AL_WC_J, sharedRoll: false,
    mods: [{ stat: 'maxMana', min: 31, max: 55, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_firepct_1', kind: 'prefix', group: 'fire_damage_percent', name: 'Kindling',
    alvl: 9, maxLevel: 28, weight: 54, appliesTo: AP.WJ, requiresGroups: RG.WC_J, sharedRoll: false,
    mods: [{ stat: 'fireDamagePercent', min: 10, max: 20, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_firepct_2', kind: 'prefix', group: 'fire_damage_percent', name: 'Conflagrant',
    alvl: 21, maxLevel: 99, weight: 30, appliesTo: AP.WJ, requiresGroups: RG.WC_J, sharedRoll: false,
    mods: [{ stat: 'fireDamagePercent', min: 21, max: 38, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_coldpct_1', kind: 'prefix', group: 'cold_damage_percent', name: 'Rimed',
    alvl: 9, maxLevel: 28, weight: 54, appliesTo: AP.WJ, requiresGroups: RG.WC_J, sharedRoll: false,
    mods: [{ stat: 'coldDamagePercent', min: 10, max: 20, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_coldpct_2', kind: 'prefix', group: 'cold_damage_percent', name: 'Deepfrost',
    alvl: 21, maxLevel: 99, weight: 30, appliesTo: AP.WJ, requiresGroups: RG.WC_J, sharedRoll: false,
    mods: [{ stat: 'coldDamagePercent', min: 21, max: 38, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_lightpct_1', kind: 'prefix', group: 'light_damage_percent', name: 'Crackling',
    alvl: 9, maxLevel: 28, weight: 54, appliesTo: AP.WJ, requiresGroups: RG.WC_J, sharedRoll: false,
    mods: [{ stat: 'lightDamagePercent', min: 10, max: 20, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_lightpct_2', kind: 'prefix', group: 'light_damage_percent', name: 'Tempestuous',
    alvl: 21, maxLevel: 99, weight: 30, appliesTo: AP.WJ, requiresGroups: RG.WC_J, sharedRoll: false,
    mods: [{ stat: 'lightDamagePercent', min: 21, max: 38, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_str_1', kind: 'prefix', group: 'attr_strength', name: 'Iron',
    alvl: 2, maxLevel: 20, weight: 80, appliesTo: AP.AJ, requiresGroups: RG.AB_AH_AG_AL_AS_J, sharedRoll: false,
    mods: [{ stat: 'strength', min: 2, max: 5, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_str_2', kind: 'prefix', group: 'attr_strength', name: "Bull's",
    alvl: 12, maxLevel: 30, weight: 56, appliesTo: AP.AJ, requiresGroups: RG.AB_AH_AG_AL_AS_J, sharedRoll: false,
    mods: [{ stat: 'strength', min: 6, max: 12, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_str_3', kind: 'prefix', group: 'attr_strength', name: "Titan's",
    alvl: 23, maxLevel: 99, weight: 32, appliesTo: AP.AJ, requiresGroups: RG.AB_AH_AG_AL_AS_J, sharedRoll: false,
    mods: [{ stat: 'strength', min: 13, max: 22, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_dex_1', kind: 'prefix', group: 'attr_dexterity', name: 'Nimble',
    alvl: 2, maxLevel: 20, weight: 80, appliesTo: AP.AJ, requiresGroups: RG.AH_AG_AT_AS_J, sharedRoll: false,
    mods: [{ stat: 'dexterity', min: 2, max: 5, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_dex_2', kind: 'prefix', group: 'attr_dexterity', name: "Fox's",
    alvl: 12, maxLevel: 30, weight: 56, appliesTo: AP.AJ, requiresGroups: RG.AH_AG_AT_AS_J, sharedRoll: false,
    mods: [{ stat: 'dexterity', min: 6, max: 12, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_dex_3', kind: 'prefix', group: 'attr_dexterity', name: "Serpent's",
    alvl: 23, maxLevel: 99, weight: 32, appliesTo: AP.AJ, requiresGroups: RG.AH_AG_AT_AS_J, sharedRoll: false,
    mods: [{ stat: 'dexterity', min: 13, max: 22, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_vit_1', kind: 'prefix', group: 'attr_vitality', name: 'Ruddy',
    alvl: 2, maxLevel: 20, weight: 80, appliesTo: AP.AJ, requiresGroups: RG.AB_AL_AT_J, sharedRoll: false,
    mods: [{ stat: 'vitality', min: 2, max: 5, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_vit_2', kind: 'prefix', group: 'attr_vitality', name: 'Sanguine',
    alvl: 12, maxLevel: 30, weight: 56, appliesTo: AP.AJ, requiresGroups: RG.AB_AL_AT_J, sharedRoll: false,
    mods: [{ stat: 'vitality', min: 6, max: 12, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_vit_3', kind: 'prefix', group: 'attr_vitality', name: 'Deathless',
    alvl: 23, maxLevel: 99, weight: 32, appliesTo: AP.AJ, requiresGroups: RG.AB_AL_AT_J, sharedRoll: false,
    mods: [{ stat: 'vitality', min: 13, max: 22, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_ene_1', kind: 'prefix', group: 'attr_energy', name: 'Clever',
    alvl: 2, maxLevel: 20, weight: 80, appliesTo: AP.WAJ, requiresGroups: RG.AB_AH_WC_J, sharedRoll: false,
    mods: [{ stat: 'energy', min: 2, max: 5, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_ene_2', kind: 'prefix', group: 'attr_energy', name: "Scholar's",
    alvl: 12, maxLevel: 30, weight: 56, appliesTo: AP.WAJ, requiresGroups: RG.AB_AH_WC_J, sharedRoll: false,
    mods: [{ stat: 'energy', min: 6, max: 12, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_ene_3', kind: 'prefix', group: 'attr_energy', name: "Oracle's",
    alvl: 23, maxLevel: 99, weight: 32, appliesTo: AP.WAJ, requiresGroups: RG.AB_AH_WC_J, sharedRoll: false,
    mods: [{ stat: 'energy', min: 13, max: 22, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_tree_1', kind: 'prefix', group: 'skills_tree', name: "Adept's",
    alvl: 16, maxLevel: 99, weight: 14, appliesTo: AP.WAJ, requiresGroups: RG.AH_JA_W, sharedRoll: false,
    mods: [{ stat: 'skillBonuses.tree', min: 1, max: 1, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_tree_2', kind: 'prefix', group: 'skills_tree', name: "Master's",
    alvl: 27, maxLevel: 99, weight: 6, appliesTo: AP.WAJ, requiresGroups: RG.AH_JA_W, sharedRoll: false,
    mods: [{ stat: 'skillBonuses.tree', min: 2, max: 2, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_allskills_1', kind: 'prefix', group: 'skills_all', name: "Instructor's",
    alvl: 29, maxLevel: 99, weight: 3, appliesTo: AP.WJ, requiresGroups: RG.JA_ST, sharedRoll: false,
    mods: [{ stat: 'skillBonuses.all', min: 1, max: 1, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_thorns_1', kind: 'prefix', group: 'thorns', name: 'Spiked',
    alvl: 5, maxLevel: 24, weight: 46, appliesTo: AP.A, requiresGroups: RG.AS_AB, sharedRoll: false,
    mods: [{ stat: 'thorns', min: 3, max: 8, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_thorns_2', kind: 'prefix', group: 'thorns', name: 'Barbed',
    alvl: 19, maxLevel: 99, weight: 26, appliesTo: AP.A, requiresGroups: RG.AS_AB, sharedRoll: false,
    mods: [{ stat: 'thorns', min: 12, max: 30, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_dr_flat_1', kind: 'prefix', group: 'damage_reduce_flat', name: 'Warded',
    alvl: 10, maxLevel: 28, weight: 40, appliesTo: AP.A, requiresGroups: RG.AS_AL_AB, sharedRoll: false,
    mods: [{ stat: 'damageReduceFlat', min: 1, max: 2, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_dr_flat_2', kind: 'prefix', group: 'damage_reduce_flat', name: 'Bulwark',
    alvl: 24, maxLevel: 99, weight: 22, appliesTo: AP.A, requiresGroups: RG.AS_AL_AB, sharedRoll: false,
    mods: [{ stat: 'damageReduceFlat', min: 3, max: 6, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_block_1', kind: 'prefix', group: 'block_chance', name: 'Deflecting',
    alvl: 7, maxLevel: 26, weight: 50, appliesTo: AP.A, requiresGroups: RG.AS, sharedRoll: false,
    mods: [{ stat: 'blockChance', min: 4, max: 8, step: 1 }],
  }),
  Object.freeze({
    id: 'pfx_block_2', kind: 'prefix', group: 'block_chance', name: 'Interposing',
    alvl: 20, maxLevel: 99, weight: 28, appliesTo: AP.A, requiresGroups: RG.AS, sharedRoll: false,
    mods: [{ stat: 'blockChance', min: 9, max: 16, step: 1 }],
  }),

  // =========================================================================
  // Suffixes — `04` §2.4, 56 records.
  // =========================================================================
  Object.freeze({
    id: 'sfx_attack_rating_1', kind: 'suffix', group: 'attack_rating', name: 'of Skill',
    alvl: 1, maxLevel: 20, weight: 100, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_J, sharedRoll: false,
    mods: [{ stat: 'attackRating', min: 5, max: 11, step: 1 }],
  }),
  Object.freeze({
    // 04 §14.1 D-5: range authored 12–30 so 01 §5.2's example values:[15] is legal.
    id: 'sfx_attack_rating_2', kind: 'suffix', group: 'attack_rating', name: 'of Accuracy',
    alvl: 9, maxLevel: 30, weight: 74, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_J, sharedRoll: false,
    mods: [{ stat: 'attackRating', min: 12, max: 30, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_attack_rating_3', kind: 'suffix', group: 'attack_rating', name: 'of Precision',
    alvl: 22, maxLevel: 99, weight: 40, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_J, sharedRoll: false,
    mods: [{ stat: 'attackRating', min: 31, max: 90, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_ias_1', kind: 'suffix', group: 'ias', name: 'of Readiness',
    alvl: 5, maxLevel: 26, weight: 66, appliesTo: AP.WA, requiresGroups: RG.W_AG, sharedRoll: false,
    mods: [{ stat: 'increasedAttackSpeed', min: 6, max: 13, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_ias_2', kind: 'suffix', group: 'ias', name: 'of Alacrity',
    alvl: 20, maxLevel: 99, weight: 34, appliesTo: AP.WA, requiresGroups: RG.W_AG, sharedRoll: false,
    mods: [{ stat: 'increasedAttackSpeed', min: 14, max: 30, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_fcr_1', kind: 'suffix', group: 'fcr', name: 'of Recitation',
    alvl: 5, maxLevel: 26, weight: 66, appliesTo: AP.WAJ, requiresGroups: RG.WC_AG_AH_J, sharedRoll: false,
    mods: [{ stat: 'fasterCastRate', min: 6, max: 13, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_fcr_2', kind: 'suffix', group: 'fcr', name: 'of the Litany',
    alvl: 20, maxLevel: 99, weight: 34, appliesTo: AP.WAJ, requiresGroups: RG.WC_AG_AH_J, sharedRoll: false,
    mods: [{ stat: 'fasterCastRate', min: 14, max: 30, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_fhr_1', kind: 'suffix', group: 'fhr', name: 'of Balance',
    alvl: 4, maxLevel: 26, weight: 62, appliesTo: AP.A, requiresGroups: RG.AB_AL_AT_AS_AH, sharedRoll: false,
    mods: [{ stat: 'fasterHitRecovery', min: 8, max: 18, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_fhr_2', kind: 'suffix', group: 'fhr', name: 'of Stability',
    alvl: 18, maxLevel: 99, weight: 34, appliesTo: AP.A, requiresGroups: RG.AB_AL_AT_AS_AH, sharedRoll: false,
    mods: [{ stat: 'fasterHitRecovery', min: 19, max: 36, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_res_fire_1', kind: 'suffix', group: 'resist_fire', name: 'of Warmth',
    alvl: 3, maxLevel: 22, weight: 86, appliesTo: AP.AJ, requiresGroups: RG.A_J, sharedRoll: false,
    mods: [{ stat: 'fireResist', min: 5, max: 12, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_res_fire_2', kind: 'suffix', group: 'resist_fire', name: 'of Cinders',
    alvl: 13, maxLevel: 32, weight: 60, appliesTo: AP.AJ, requiresGroups: RG.A_J, sharedRoll: false,
    mods: [{ stat: 'fireResist', min: 13, max: 24, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_res_fire_3', kind: 'suffix', group: 'resist_fire', name: 'of the Pyre',
    alvl: 24, maxLevel: 99, weight: 34, appliesTo: AP.AJ, requiresGroups: RG.A_J, sharedRoll: false,
    mods: [{ stat: 'fireResist', min: 25, max: 40, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_res_cold_1', kind: 'suffix', group: 'resist_cold', name: 'of Comfort',
    alvl: 3, maxLevel: 22, weight: 86, appliesTo: AP.AJ, requiresGroups: RG.A_J, sharedRoll: false,
    mods: [{ stat: 'coldResist', min: 5, max: 12, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_res_cold_2', kind: 'suffix', group: 'resist_cold', name: 'of Frost',
    alvl: 13, maxLevel: 32, weight: 60, appliesTo: AP.AJ, requiresGroups: RG.A_J, sharedRoll: false,
    mods: [{ stat: 'coldResist', min: 13, max: 24, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_res_cold_3', kind: 'suffix', group: 'resist_cold', name: 'of the Rime',
    alvl: 24, maxLevel: 99, weight: 34, appliesTo: AP.AJ, requiresGroups: RG.A_J, sharedRoll: false,
    mods: [{ stat: 'coldResist', min: 25, max: 40, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_res_light_1', kind: 'suffix', group: 'resist_lightning', name: 'of Grounding',
    alvl: 3, maxLevel: 22, weight: 86, appliesTo: AP.AJ, requiresGroups: RG.A_J, sharedRoll: false,
    mods: [{ stat: 'lightResist', min: 5, max: 12, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_res_light_2', kind: 'suffix', group: 'resist_lightning', name: 'of Insulation',
    alvl: 13, maxLevel: 32, weight: 60, appliesTo: AP.AJ, requiresGroups: RG.A_J, sharedRoll: false,
    mods: [{ stat: 'lightResist', min: 13, max: 24, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_res_light_3', kind: 'suffix', group: 'resist_lightning', name: 'of the Storm',
    alvl: 24, maxLevel: 99, weight: 34, appliesTo: AP.AJ, requiresGroups: RG.A_J, sharedRoll: false,
    mods: [{ stat: 'lightResist', min: 25, max: 40, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_res_poison_1', kind: 'suffix', group: 'resist_poison', name: 'of the Antidote',
    alvl: 10, maxLevel: 99, weight: 40, appliesTo: AP.AJ, requiresGroups: RG.A_J, sharedRoll: false,
    mods: [{ stat: 'poisonResist', min: 8, max: 25, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_res_all_1', kind: 'suffix', group: 'resist_all', name: 'of Warding',
    alvl: 12, maxLevel: 30, weight: 26, appliesTo: AP.AJ, requiresGroups: RG.AB_AS_JA, sharedRoll: true,
    mods: [
      { stat: 'fireResist', min: 4, max: 9, step: 1 },
      { stat: 'coldResist', min: 4, max: 9, step: 1 },
      { stat: 'lightResist', min: 4, max: 9, step: 1 },
      { stat: 'poisonResist', min: 4, max: 9, step: 1 },
      { stat: 'magicResist', min: 4, max: 9, step: 1 },
      { stat: 'physicalResist', min: 4, max: 9, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'sfx_res_all_2', kind: 'suffix', group: 'resist_all', name: 'of Renunciation',
    alvl: 26, maxLevel: 99, weight: 10, appliesTo: AP.AJ, requiresGroups: RG.AB_AS_JA, sharedRoll: true,
    mods: [
      { stat: 'fireResist', min: 10, max: 20, step: 1 },
      { stat: 'coldResist', min: 10, max: 20, step: 1 },
      { stat: 'lightResist', min: 10, max: 20, step: 1 },
      { stat: 'poisonResist', min: 10, max: 20, step: 1 },
      { stat: 'magicResist', min: 10, max: 20, step: 1 },
      { stat: 'physicalResist', min: 10, max: 20, step: 1 },
    ],
  }),
  Object.freeze({
    id: 'sfx_life_steal_1', kind: 'suffix', group: 'life_steal', name: 'of the Leech',
    alvl: 10, maxLevel: 30, weight: 44, appliesTo: AP.WJ, requiresGroups: RG.WM_JR_JA, sharedRoll: false,
    mods: [{ stat: 'lifeSteal', min: 2, max: 5, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_life_steal_2', kind: 'suffix', group: 'life_steal', name: 'of the Feast',
    alvl: 24, maxLevel: 99, weight: 20, appliesTo: AP.WJ, requiresGroups: RG.WM_JR_JA, sharedRoll: false,
    mods: [{ stat: 'lifeSteal', min: 6, max: 10, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_mana_steal_1', kind: 'suffix', group: 'mana_steal', name: 'of the Draught',
    alvl: 12, maxLevel: 99, weight: 30, appliesTo: AP.WJ, requiresGroups: RG.WM_JR, sharedRoll: false,
    mods: [{ stat: 'manaSteal', min: 2, max: 6, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_life_on_hit_1', kind: 'suffix', group: 'life_on_hit', name: 'of Mending',
    alvl: 8, maxLevel: 99, weight: 40, appliesTo: AP.WAJ, requiresGroups: RG.WM_AG_JA, sharedRoll: false,
    mods: [{ stat: 'lifeOnHit', min: 1, max: 6, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_mana_on_hit_1', kind: 'suffix', group: 'mana_on_hit', name: 'of Trickle',
    alvl: 8, maxLevel: 99, weight: 36, appliesTo: AP.WAJ, requiresGroups: RG.WM_AG_JA, sharedRoll: false,
    mods: [{ stat: 'manaOnHit', min: 1, max: 4, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_life_regen_1', kind: 'suffix', group: 'life_regen', name: 'of Renewal',
    alvl: 6, maxLevel: 99, weight: 44, appliesTo: AP.AJ, requiresGroups: RG.AB_AL_J, sharedRoll: false,
    // 04 §2.4 flags only sfx_resonance_1's step as non-integer, so this
    // fractional range (0.4–2.6) still rolls on an integer step.
    mods: [{ stat: 'lifeRegen', min: 0.4, max: 2.6, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_mana_regen_1', kind: 'suffix', group: 'mana_regen', name: 'of Meditation',
    alvl: 6, maxLevel: 99, weight: 44, appliesTo: AP.WAJ, requiresGroups: RG.AH_WC_J, sharedRoll: false,
    mods: [{ stat: 'manaRegenPercent', min: 3, max: 12, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_crit_1', kind: 'suffix', group: 'crit_chance', name: 'of Malice',
    alvl: 8, maxLevel: 28, weight: 40, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JA, sharedRoll: false,
    mods: [{ stat: 'critChance', min: 2, max: 5, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_crit_2', kind: 'suffix', group: 'crit_chance', name: 'of Execution',
    alvl: 25, maxLevel: 99, weight: 16, appliesTo: AP.WAJ, requiresGroups: RG.W_AG_JA, sharedRoll: false,
    mods: [{ stat: 'critChance', min: 6, max: 12, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_crit_mult_1', kind: 'suffix', group: 'crit_mult', name: 'of the Deathblow',
    alvl: 22, maxLevel: 99, weight: 14, appliesTo: AP.WJ, requiresGroups: RG.W_JA, sharedRoll: false,
    mods: [{ stat: 'critMult', min: 25, max: 60, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_move_1', kind: 'suffix', group: 'movement_speed', name: 'of Pacing',
    alvl: 7, maxLevel: 28, weight: 70, appliesTo: AP.A, requiresGroups: RG.AT, sharedRoll: false,
    mods: [{ stat: 'movementSpeed', min: 8, max: 16, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_move_2', kind: 'suffix', group: 'movement_speed', name: 'of the Long Road',
    alvl: 24, maxLevel: 99, weight: 32, appliesTo: AP.A, requiresGroups: RG.AT, sharedRoll: false,
    mods: [{ stat: 'movementSpeed', min: 17, max: 30, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_mf_1', kind: 'suffix', group: 'magic_find', name: 'of Luck',
    alvl: 6, maxLevel: 28, weight: 40, appliesTo: AP.AJ, requiresGroups: RG.AH_AG_AT_J, sharedRoll: false,
    mods: [{ stat: 'magicFind', min: 5, max: 14, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_mf_2', kind: 'suffix', group: 'magic_find', name: 'of the Hoard',
    alvl: 24, maxLevel: 99, weight: 14, appliesTo: AP.AJ, requiresGroups: RG.AH_AG_AT_J, sharedRoll: false,
    mods: [{ stat: 'magicFind', min: 15, max: 38, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_gf_1', kind: 'suffix', group: 'gold_find', name: 'of Greed',
    alvl: 2, maxLevel: 99, weight: 56, appliesTo: AP.AJ, requiresGroups: RG.AH_AG_AT_AL_JR, sharedRoll: false,
    mods: [{ stat: 'goldFind', min: 12, max: 60, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_mana_cost_1', kind: 'suffix', group: 'mana_cost', name: 'of Economy',
    alvl: 14, maxLevel: 99, weight: 26, appliesTo: AP.WAJ, requiresGroups: RG.AH_JA_JR_ST, sharedRoll: false,
    mods: [{ stat: 'manaCostReduction', min: 4, max: 14, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_cc_1', kind: 'suffix', group: 'cc_reduction', name: 'of Footing',
    alvl: 14, maxLevel: 99, weight: 30, appliesTo: AP.A, requiresGroups: RG.AT_AL_AH, sharedRoll: false,
    mods: [{ stat: 'ccReduction', min: 8, max: 26, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_dr_pct_1', kind: 'suffix', group: 'dr_percent', name: 'of Absorption',
    alvl: 22, maxLevel: 99, weight: 18, appliesTo: AP.A, requiresGroups: RG.AS_AB_AL, sharedRoll: false,
    mods: [{ stat: 'damageReducePercent', min: 3, max: 7, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_dodge_1', kind: 'suffix', group: 'dodge_chance', name: 'of Evasion',
    alvl: 11, maxLevel: 99, weight: 28, appliesTo: AP.A, requiresGroups: RG.AT_AG_AS, sharedRoll: false,
    mods: [{ stat: 'dodgeChance', min: 3, max: 10, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_mana_return_1', kind: 'suffix', group: 'mana_return', name: 'of Circuit',
    alvl: 9, maxLevel: 99, weight: 26, appliesTo: AP.WJ, requiresGroups: RG.WM_JR_JA, sharedRoll: false,
    mods: [{ stat: 'manaReturnPercent', min: 2, max: 9, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_rage_1', kind: 'suffix', group: 'rage_gain', name: 'of Temper',
    alvl: 9, maxLevel: 99, weight: 26, appliesTo: AP.WAJ, requiresGroups: RG.WM_AL_JA, sharedRoll: false,
    mods: [{ stat: 'rageOnHit', min: 1, max: 4, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_resonance_1', kind: 'suffix', group: 'resonance_gain', name: 'of the Chord',
    alvl: 13, maxLevel: 99, weight: 22, appliesTo: AP.WJ, requiresGroups: RG.WM_JR_JA, sharedRoll: false,
    // 04 §2.4: "the only affix with a non-integer step".
    mods: [{ stat: 'resonanceOnHit', min: 0.2, max: 0.8, step: 0.1 }],
  }),
  Object.freeze({
    id: 'sfx_unfreezing_1', kind: 'suffix', group: 'freeze_immune', name: 'of the Thaw',
    alvl: 22, maxLevel: 99, weight: 12, appliesTo: AP.AJ, requiresGroups: RG.AT_AB_JA, sharedRoll: false,
    mods: [{ stat: 'cannotBeFrozen', min: 1, max: 1, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_dttm_1', kind: 'suffix', group: 'dttm', name: 'of the Conduit',
    alvl: 18, maxLevel: 99, weight: 18, appliesTo: AP.AJ, requiresGroups: RG.AH_AB_JA, sharedRoll: false,
    mods: [{ stat: 'damageTakenToMana', min: 5, max: 12, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_poison_dur_1', kind: 'suffix', group: 'poison_duration', name: 'of Lingering',
    alvl: 16, maxLevel: 99, weight: 14, appliesTo: AP.WJ, requiresGroups: RG.WM_JA, sharedRoll: false,
    mods: [{ stat: 'poisonDuration', min: 1, max: 3, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_cold_dur_1', kind: 'suffix', group: 'cold_duration', name: 'of the Long Winter',
    alvl: 16, maxLevel: 99, weight: 14, appliesTo: AP.WJ, requiresGroups: RG.WM_JA, sharedRoll: false,
    mods: [{ stat: 'coldDuration', min: 1, max: 3, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_knockback_1', kind: 'suffix', group: 'knockback', name: 'of Repulsion',
    alvl: 7, maxLevel: 99, weight: 20, appliesTo: AP.WA, requiresGroups: RG.W_AG, sharedRoll: false,
    mods: [{ stat: 'knockbackChance', min: 25, max: 50, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_light_rad_1', kind: 'suffix', group: 'light_radius', name: 'of Lantern-Light',
    alvl: 3, maxLevel: 99, weight: 30, appliesTo: AP.AJ, requiresGroups: RG.AH_J, sharedRoll: false,
    mods: [{ stat: 'lightRadius', min: 1, max: 3, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_req_1', kind: 'suffix', group: 'req_reduction', name: 'of Ease',
    alvl: 10, maxLevel: 99, weight: 22, appliesTo: AP.AJ, requiresGroups: RG.AG_AL_JR, sharedRoll: false,
    mods: [{ stat: 'requirementReduction', min: 8, max: 18, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_xp_1', kind: 'suffix', group: 'experience', name: 'of Tutelage',
    alvl: 24, maxLevel: 99, weight: 8, appliesTo: AP.AJ, requiresGroups: RG.AH_JA, sharedRoll: false,
    mods: [{ stat: 'experienceGain', min: 3, max: 7, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_max_res_fire_1', kind: 'suffix', group: 'max_resist', name: 'of the Ember Seal',
    alvl: 29, maxLevel: 99, weight: 4, appliesTo: AP.AJ, requiresGroups: RG.JA_AS, sharedRoll: false,
    mods: [{ stat: 'maxFireResist', min: 2, max: 5, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_pierce_1', kind: 'suffix', group: 'pierce', name: 'of Piercing',
    alvl: 15, maxLevel: 99, weight: 18, appliesTo: AP.WJ, requiresGroups: RG.WC_JA, sharedRoll: false,
    mods: [{ stat: 'pierceChance', min: 10, max: 22, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_fire_pierce_1', kind: 'suffix', group: 'elem_pierce', name: 'of the Breach',
    alvl: 23, maxLevel: 99, weight: 10, appliesTo: AP.WJ, requiresGroups: RG.WC_JA, sharedRoll: false,
    mods: [{ stat: 'fireResistPierce', min: 8, max: 16, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_magic_dr_1', kind: 'suffix', group: 'magic_dr', name: 'of Nullity',
    alvl: 20, maxLevel: 99, weight: 14, appliesTo: AP.AJ, requiresGroups: RG.AH_AS_JA, sharedRoll: false,
    mods: [{ stat: 'magicDamageReduceFlat', min: 1, max: 3, step: 1 }],
  }),
  Object.freeze({
    id: 'sfx_fhr_stone_1', kind: 'suffix', group: 'fhr_stone', name: 'of the Stone',
    alvl: 26, maxLevel: 99, weight: 12, appliesTo: AP.A, requiresGroups: RG.AB_AS, sharedRoll: false,
    mods: [
      { stat: 'fasterHitRecovery', min: 12, max: 24, step: 1 },
      { stat: 'defensePercent', min: 10, max: 20, step: 1 },
    ],
  }),
]);

/** Built once, at module load, as a plain `Object.create(null)` map — never
 * a `Map` (ARCHITECTURE.md's measured-cost rule: `Map` leaks ~456 B/call on
 * never-repeating keys and `.clear()` allocates unconditionally) and never
 * rebuilt per read. This is a one-time load-time index, not a per-frame or
 * per-roll cache. */
export const AFFIXES_BY_ID = (() => {
  const map = Object.create(null);
  for (const affix of AFFIXES) {
    map[affix.id] = affix;
  }
  return Object.freeze(map);
})();
