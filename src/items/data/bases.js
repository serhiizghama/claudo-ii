// src/items/data/bases.js
//
// ITEM-1 — the 75 `ItemBase` records (`04-items.md` §1, §8.1). Plain frozen
// data, no logic (`ARCHITECTURE.md` rule 9 / rule 6 of this ticket's brief):
// `tools/lootsim.mjs` (a later ticket, not built yet) imports this module
// directly in Node, headless, with no `three` — nothing here may compute a
// value the table should state.
//
// Field shape is `01-data-model.md` §5.1's `ItemBase` example, verbatim —
// that document is the authority on field NAMES and TYPES; `04-items.md` §1
// is the authority on VALUES. Where the two would ever disagree on a value,
// `04` wins (it is more specific); no such disagreement was found while
// transcribing.
//
// ---------------------------------------------------------------------------
// Count — 75, matching `04-items.md` §12 step 1 / this ticket's criterion
// ---------------------------------------------------------------------------
//   26 weapons        (`04` §1.4, excluding the `unarmed` pseudo-base)
// +  1 unarmed         (`04` §1.4's pseudo-base row)
// + 29 armour          (`04` §1.5)
// +  6 jewelry         (`04` §1.6, excluding `quest_first_tablet`)
// +  1 quest           (`quest_first_tablet`, `04` §1.6)
// + 12 consumables     (`04` §8.1)
// = 75
//
// ---------------------------------------------------------------------------
// Authored `baseValue` vs the §1.1 formula — ship the authored integer, always
// ---------------------------------------------------------------------------
// `baseValue = max(12, round(k * max(1, reqLevel) ^ 1.9))` is `04` §1.1's
// generating formula, and `04` §14.2 C-7 names `axe_battle_normal` (220
// authored vs 221 formula) as the ONE row it bothers to spell out — but
// re-deriving every row against the formula (this ticket's own acceptance
// criterion) turns up seventeen more one-to-five-gold disagreements, almost
// certainly float/rounding differences between whatever generated the
// authored table and a literal `Math.round(k * reqLevel ** 1.9)` in Node.
// C-7's own rule ("authored integers always win, the formula documents how
// the numbers were generated, the runtime never evaluates it") applies
// identically to all of them. Every one of the eighteen is transcribed here
// EXACTLY as `04` §1.4/§1.5/§1.6 prints it; none was "corrected" toward the
// formula. Full list (authored -> formula) in this ticket's report:
//   axe_battle_normal 220->221 (C-7, named), axe_ruin_elite 1658->1659,
//   sword_verdict_elite 1539->1540, hammer_edict_elite 1906->1910,
//   maul_anvil_elite 2397->2402, dagger_kris_normal 206->207,
//   dagger_final_elite 1458->1461, wand_ember_normal 64->12 (see below),
//   wand_grammar_elite 1257->1258, staff_silence_elite 1883->1888,
//   shield_tower_elite 1674->1678, armour_litany_elite 1720->1721,
//   armour_sepulchre_elite 1988->1992, helm_barbute_exceptional 523->522,
//   helm_gravemask_elite 1170->1171, gloves_ordinance_elite 926->927,
//   boots_pilgrim_elite 926->927, ring_gilt 1776->1777, amulet_seal 2715->2718.
//
// `wand_ember_normal`'s pair is the odd one out and is NOT a rounding
// artifact: `04` §1.1 explains at length that this row's `reqLevel` was
// moved from its originally-authored 5 down to 1 (so an Emberwright has a
// starting-kit weapon instead of an empty main hand for five levels) while
// its damage/value/durability were deliberately left where they were. Value
// 64 and durability 30 are exactly what `k=3.0`/`durBase=24,durPerLevel=1.20`
// give at the OLD `reqLevel=5` (`round(3.0*5^1.9)=64`, `round(24+1.2*5)=30`);
// recomputing at the current `reqLevel=1` gives 12 and 25. Shipped as
// authored (64, 30) per the same rule.
//
// ---------------------------------------------------------------------------
// Decisions made where the read spec slice left a gap
// ---------------------------------------------------------------------------
// - `unarmed.iconSeed`: `04` §1.4's row prints "—" (it is never rendered —
//   never dropped, never in an inventory cell) but every `ItemBase` needs a
//   uint32 for the schema and this ticket's own uniqueness criterion. `0x0`
//   is used, distinct from every real authored seed (`quest_first_tablet` is
//   the lowest real one, `0x0001`).
// - `unarmed`/`quest_first_tablet` grid: `unarmed` has no Grid ("—") and
//   `quest_first_tablet`'s Slot is "—" (never equipped, never placed by the
//   player — `world` places it on the altar, `04` §1.6). `unarmed.invW/invH`
//   is `1x1` (never actually placed in a container; satisfies the invW/invH
//   range criterion). `quest_first_tablet` keeps its authored `2x2` grid
//   (`04` §1.6) even though it is never placed by the player, matching the
//   table.
// - `genderRu`: required on every record (`04` §13.2) but the read slice
//   (`04` §1.4-§1.6, §8.1) supplies only EN/RU DISPLAY names, not the
//   grammatical gender of the underlying Russian noun; that call was made by
//   parsing each RU name's head noun (e.g. "Ручной топор" -> топор, masc;
//   "Перистая булава" -> булава, fem; "Обмотки" -> plural-only). The twelve
//   `04` §8.1 consumables have NO RU name at all in the read slice (§8.1's
//   table has no RU column), so their `genderRu` is left at the schema
//   default `'m'` — inert in practice, since a consumable never rolls a
//   prefix/suffix affix (no `allowedAffixGroups`) and so never needs
//   agreement at all.
// - Consumable `reqLevel`/`tier`/`dropWeight`: none of these three columns
//   exist in `04` §8.1's table (`id, effect, amountPercent, overSeconds,
//   stackMax, Cooldown, Buy, Drop band`). `reqLevel: 1` (consumables are not
//   level-gated by anything read), `tier: 'normal'` (the schema enum has no
//   "not applicable" value) and `dropWeight: 100` (a neutral placeholder —
//   `04` §12 step 3/9 notes potions and scrolls are drawn from their OWN
//   dedicated sub-tables, not the base-group weighted draw §1.3 describes,
//   so this field is plumbing for a shape later tickets may not even read)
//   are used for all twelve, uniformly. Flagged in this ticket's report.
// - `04` §8.1's `Cooldown` and `Drop band` columns have no home in
//   `01-data-model.md` §5.1's `ItemBase.consumable` shape (`effect`,
//   `amountPercent`, `overSeconds`, `stackMax` only) and are NOT stored here
//   — `01` is the named authority on field names/types (this ticket's brief),
//   and inventing a fifth `consumable` field this ticket was not asked to add
//   is exactly the "public API/shape invented silently" mistake rule 7 of
//   the brief warns against for methods. Flagged in this ticket's report for
//   whichever ticket needs per-item cooldown (belt UI?) or the drop-band
//   weighting (the treasure-class ticket, `04` §12 step 3).
// - Consumable `amountPercent` for the three non-percent effects
//   (`scroll_identify`, `scroll_portal`, `scroll_respec`, table value "—")
//   is stored as `0`, since the field is typed as a number and `identify`/
//   `town_portal`/`respec` never read it.

/** `04-items.md` §1.4.1's affix-set codes, expanded once here (still a flat
 * literal table, not a function) and referenced by id below so the same
 * frozen array is shared by every base carrying that code — matching
 * `ARCHITECTURE.md` rule 6's "build any lookup once, not per read" for
 * static data too. `DG` is kept as its own (identical today) entry rather
 * than reused from `W1`, per `04` §1.4.1's own note that they are meant to
 * diverge later. */
const AG = Object.freeze({
  NONE: Object.freeze([]),
  W1: Object.freeze(['universal', 'weapon.any', 'weapon.melee']),
  W2: Object.freeze(['universal', 'weapon.any', 'weapon.melee', 'weapon.twohand']),
  DG: Object.freeze(['universal', 'weapon.any', 'weapon.melee']),
  WC: Object.freeze(['universal', 'weapon.any', 'weapon.caster']),
  ST: Object.freeze(['universal', 'weapon.any', 'weapon.caster', 'weapon.twohand']),
  SH: Object.freeze(['universal', 'armour.any', 'armour.shield']),
  BD: Object.freeze(['universal', 'armour.any', 'armour.body']),
  HL: Object.freeze(['universal', 'armour.any', 'armour.helm']),
  GL: Object.freeze(['universal', 'armour.any', 'armour.gloves']),
  BT: Object.freeze(['universal', 'armour.any', 'armour.boots']),
  BL: Object.freeze(['universal', 'armour.any', 'armour.belt']),
  RG: Object.freeze(['universal', 'jewelry.any', 'jewelry.ring']),
  AM: Object.freeze(['universal', 'jewelry.any', 'jewelry.amulet']),
});

export const ITEM_BASES = Object.freeze([
  // ---------------------------------------------------------------------
  // Pseudo-weapon — `04` §1.4's `unarmed` row, `03-combat-math.md` §4.6
  // reference row #1. Never dropped (`dropWeight 0`), never carries affixes.
  // ---------------------------------------------------------------------
  Object.freeze({
    id: 'unarmed', name: '—', category: 'weapon', slot: 'mainHand', tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 0, dropWeight: 0, iconSeed: 0x0,
    surface: 'flesh', genderRu: 'm',
    weapon: { minDamage: 1, maxDamage: 3, attackTime: 0.60, attackRating: 0, twoHanded: false, range: 1.4, handling: 'unarmed', element: 'physical' },
    allowedAffixGroups: AG.NONE, socketMax: 0,
  }),

  // ---------------------------------------------------------------------
  // Weapons — `04` §1.4, 26 bases. Bold rows there are the seven
  // `03-combat-math.md` §4.6 reference weapons; reproduced verbatim.
  // ---------------------------------------------------------------------
  Object.freeze({
    id: 'axe_hand_normal', name: 'Hand Axe', category: 'weapon', slot: 'mainHand', tier: 'normal',
    reqLevel: 1, reqStr: 18, reqDex: 0, invW: 1, invH: 3,
    maxDurability: 40, baseValue: 12, dropWeight: 90, iconSeed: 0x1a07,
    surface: 'metal', genderRu: 'm',
    weapon: { minDamage: 4, maxDamage: 9, attackTime: 0.80, attackRating: 40, twoHanded: false, range: 1.9, handling: 'oneHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W1, socketMax: 0,
  }),
  Object.freeze({
    id: 'axe_battle_normal', name: 'Battle Axe', category: 'weapon', slot: 'mainHand', tier: 'normal',
    reqLevel: 9, reqStr: 40, reqDex: 0, invW: 2, invH: 3,
    // baseValue 220: authored, formula gives 221 — C-7, see file header.
    maxDurability: 55, baseValue: 220, dropWeight: 80, iconSeed: 0x51c4,
    surface: 'metal', genderRu: 'm',
    weapon: { minDamage: 10, maxDamage: 22, attackTime: 0.75, attackRating: 80, twoHanded: false, range: 1.9, handling: 'oneHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W1, socketMax: 0,
  }),
  Object.freeze({
    id: 'axe_cleaver_exceptional', name: 'Ash Cleaver', category: 'weapon', slot: 'mainHand', tier: 'exceptional',
    reqLevel: 17, reqStr: 58, reqDex: 0, invW: 2, invH: 3,
    maxDurability: 70, baseValue: 740, dropWeight: 60, iconSeed: 0x2be1,
    surface: 'metal', genderRu: 'm',
    weapon: { minDamage: 18, maxDamage: 38, attackTime: 0.78, attackRating: 130, twoHanded: false, range: 2.0, handling: 'oneHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W1, socketMax: 0,
  }),
  Object.freeze({
    id: 'axe_ruin_elite', name: 'Ruin Axe', category: 'weapon', slot: 'mainHand', tier: 'elite',
    reqLevel: 26, reqStr: 78, reqDex: 0, invW: 2, invH: 3,
    // baseValue 1658: authored, formula gives 1659.
    maxDurability: 87, baseValue: 1658, dropWeight: 40, iconSeed: 0x77af,
    surface: 'metal', genderRu: 'm',
    weapon: { minDamage: 27, maxDamage: 55, attackTime: 0.80, attackRating: 190, twoHanded: false, range: 2.0, handling: 'oneHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W1, socketMax: 0,
  }),
  Object.freeze({
    id: 'sword_short_normal', name: 'Short Sword', category: 'weapon', slot: 'mainHand', tier: 'normal',
    reqLevel: 1, reqStr: 12, reqDex: 12, invW: 1, invH: 3,
    maxDurability: 40, baseValue: 12, dropWeight: 90, iconSeed: 0x0c35,
    surface: 'metal', genderRu: 'm',
    weapon: { minDamage: 4, maxDamage: 8, attackTime: 0.70, attackRating: 45, twoHanded: false, range: 1.9, handling: 'oneHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W1, socketMax: 0,
  }),
  Object.freeze({
    id: 'sword_rune_normal', name: 'Rune Sword', category: 'weapon', slot: 'mainHand', tier: 'normal',
    reqLevel: 8, reqStr: 30, reqDex: 25, invW: 1, invH: 3,
    maxDurability: 53, baseValue: 177, dropWeight: 80, iconSeed: 0x93d2,
    surface: 'metal', genderRu: 'm',
    weapon: { minDamage: 8, maxDamage: 17, attackTime: 0.65, attackRating: 80, twoHanded: false, range: 1.9, handling: 'oneHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W1, socketMax: 0,
  }),
  Object.freeze({
    id: 'sword_sigil_exceptional', name: 'Sigil Blade', category: 'weapon', slot: 'mainHand', tier: 'exceptional',
    reqLevel: 16, reqStr: 45, reqDex: 38, invW: 1, invH: 3,
    maxDurability: 68, baseValue: 660, dropWeight: 60, iconSeed: 0x4e88,
    surface: 'metal', genderRu: 'm',
    weapon: { minDamage: 15, maxDamage: 30, attackTime: 0.65, attackRating: 125, twoHanded: false, range: 2.0, handling: 'oneHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W1, socketMax: 0,
  }),
  Object.freeze({
    id: 'sword_verdict_elite', name: 'Verdict', category: 'weapon', slot: 'mainHand', tier: 'elite',
    reqLevel: 25, reqStr: 62, reqDex: 52, invW: 1, invH: 3,
    // baseValue 1539: authored, formula gives 1540.
    maxDurability: 86, baseValue: 1539, dropWeight: 40, iconSeed: 0xa1c9,
    surface: 'metal', genderRu: 'm',
    weapon: { minDamage: 22, maxDamage: 44, attackTime: 0.66, attackRating: 180, twoHanded: false, range: 2.0, handling: 'oneHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W1, socketMax: 0,
  }),
  Object.freeze({
    id: 'sword_great_exceptional', name: 'Greatsword', category: 'weapon', slot: 'mainHand', tier: 'exceptional',
    reqLevel: 19, reqStr: 68, reqDex: 30, invW: 2, invH: 4,
    maxDurability: 87, baseValue: 1076, dropWeight: 45, iconSeed: 0x6d1b,
    surface: 'metal', genderRu: 'm',
    weapon: { minDamage: 27, maxDamage: 55, attackTime: 1.05, attackRating: 140, twoHanded: true, range: 2.4, handling: 'twoHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W2, socketMax: 0,
  }),
  Object.freeze({
    id: 'mace_flanged_normal', name: 'Flanged Mace', category: 'weapon', slot: 'mainHand', tier: 'normal',
    reqLevel: 11, reqStr: 46, reqDex: 0, invW: 2, invH: 3,
    maxDurability: 59, baseValue: 324, dropWeight: 75, iconSeed: 0x38f0,
    surface: 'metal', genderRu: 'f',
    weapon: { minDamage: 14, maxDamage: 29, attackTime: 0.85, attackRating: 70, twoHanded: false, range: 1.9, handling: 'oneHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W1, socketMax: 0,
  }),
  Object.freeze({
    id: 'mace_censer_exceptional', name: 'Bone Censer', category: 'weapon', slot: 'mainHand', tier: 'exceptional',
    reqLevel: 20, reqStr: 63, reqDex: 0, invW: 2, invH: 3,
    maxDurability: 76, baseValue: 1008, dropWeight: 55, iconSeed: 0xc402,
    surface: 'bone', genderRu: 'n',
    weapon: { minDamage: 24, maxDamage: 48, attackTime: 0.88, attackRating: 120, twoHanded: false, range: 2.0, handling: 'oneHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W1, socketMax: 0,
  }),
  Object.freeze({
    id: 'hammer_edict_elite', name: 'Edict Hammer', category: 'weapon', slot: 'mainHand', tier: 'elite',
    reqLevel: 28, reqStr: 84, reqDex: 0, invW: 2, invH: 3,
    // baseValue 1906: authored, formula gives 1910.
    maxDurability: 91, baseValue: 1906, dropWeight: 35, iconSeed: 0x8e5d,
    surface: 'metal', genderRu: 'm',
    weapon: { minDamage: 33, maxDamage: 67, attackTime: 0.92, attackRating: 175, twoHanded: false, range: 2.1, handling: 'oneHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W1, socketMax: 0,
  }),
  Object.freeze({
    id: 'maul_great_normal', name: 'Great Maul', category: 'weapon', slot: 'mainHand', tier: 'normal',
    reqLevel: 12, reqStr: 62, reqDex: 0, invW: 2, invH: 4,
    maxDurability: 75, baseValue: 449, dropWeight: 60, iconSeed: 0x2f96,
    surface: 'metal', genderRu: 'm',
    weapon: { minDamage: 22, maxDamage: 46, attackTime: 1.25, attackRating: 60, twoHanded: true, range: 2.4, handling: 'twoHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W2, socketMax: 0,
  }),
  Object.freeze({
    id: 'polearm_reave_exceptional', name: 'Reaving Glaive', category: 'weapon', slot: 'mainHand', tier: 'exceptional',
    reqLevel: 18, reqStr: 70, reqDex: 25, invW: 2, invH: 4,
    maxDurability: 86, baseValue: 971, dropWeight: 40, iconSeed: 0xb713,
    surface: 'metal', genderRu: 'f',
    weapon: { minDamage: 27, maxDamage: 55, attackTime: 1.10, attackRating: 135, twoHanded: true, range: 2.8, handling: 'twoHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W2, socketMax: 0,
  }),
  Object.freeze({
    id: 'maul_ossuary_exceptional', name: 'Ossuary Maul', category: 'weapon', slot: 'mainHand', tier: 'exceptional',
    reqLevel: 21, reqStr: 85, reqDex: 0, invW: 2, invH: 4,
    maxDurability: 91, baseValue: 1301, dropWeight: 40, iconSeed: 0x5c60,
    surface: 'bone', genderRu: 'm',
    weapon: { minDamage: 36, maxDamage: 73, attackTime: 1.28, attackRating: 100, twoHanded: true, range: 2.5, handling: 'twoHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W2, socketMax: 0,
  }),
  Object.freeze({
    id: 'maul_anvil_elite', name: 'Anvil of Silence', category: 'weapon', slot: 'mainHand', tier: 'elite',
    reqLevel: 29, reqStr: 96, reqDex: 0, invW: 2, invH: 4,
    // baseValue 2397: authored, formula gives 2402.
    maxDurability: 104, baseValue: 2397, dropWeight: 25, iconSeed: 0xf0a8,
    surface: 'metal', genderRu: 'f',
    weapon: { minDamage: 52, maxDamage: 106, attackTime: 1.40, attackRating: 120, twoHanded: true, range: 2.6, handling: 'twoHandMelee', element: 'physical' },
    allowedAffixGroups: AG.W2, socketMax: 0,
  }),
  Object.freeze({
    id: 'dagger_shard_normal', name: 'Bone Shard', category: 'weapon', slot: 'mainHand', tier: 'normal',
    reqLevel: 1, reqStr: 8, reqDex: 15, invW: 1, invH: 2,
    maxDurability: 29, baseValue: 12, dropWeight: 55, iconSeed: 0x1d44,
    surface: 'bone', genderRu: 'm',
    weapon: { minDamage: 3, maxDamage: 5, attackTime: 0.50, attackRating: 55, twoHanded: false, range: 1.5, handling: 'dagger', element: 'physical' },
    allowedAffixGroups: AG.DG, socketMax: 0,
  }),
  Object.freeze({
    id: 'dagger_kris_normal', name: 'Ash Kris', category: 'weapon', slot: 'mainHand', tier: 'normal',
    reqLevel: 10, reqStr: 18, reqDex: 40, invW: 1, invH: 2,
    // baseValue 206: authored, formula gives 207.
    maxDurability: 41, baseValue: 206, dropWeight: 50, iconSeed: 0x6a21,
    surface: 'metal', genderRu: 'm',
    weapon: { minDamage: 7, maxDamage: 14, attackTime: 0.48, attackRating: 100, twoHanded: false, range: 1.5, handling: 'dagger', element: 'physical' },
    allowedAffixGroups: AG.DG, socketMax: 0,
  }),
  Object.freeze({
    id: 'dagger_scalpel_exceptional', name: "Instructor's Scalpel", category: 'weapon', slot: 'mainHand', tier: 'exceptional',
    reqLevel: 19, reqStr: 25, reqDex: 62, invW: 1, invH: 2,
    maxDurability: 53, baseValue: 699, dropWeight: 35, iconSeed: 0xd39c,
    surface: 'metal', genderRu: 'm',
    weapon: { minDamage: 11, maxDamage: 22, attackTime: 0.46, attackRating: 155, twoHanded: false, range: 1.5, handling: 'dagger', element: 'physical' },
    allowedAffixGroups: AG.DG, socketMax: 0,
  }),
  Object.freeze({
    id: 'dagger_final_elite', name: 'Final Word', category: 'weapon', slot: 'mainHand', tier: 'elite',
    reqLevel: 28, reqStr: 34, reqDex: 78, invW: 1, invH: 2,
    // baseValue 1458: authored, formula gives 1461.
    maxDurability: 64, baseValue: 1458, dropWeight: 22, iconSeed: 0x40e7,
    surface: 'metal', genderRu: 'n',
    weapon: { minDamage: 15, maxDamage: 30, attackTime: 0.45, attackRating: 215, twoHanded: false, range: 1.6, handling: 'dagger', element: 'physical' },
    allowedAffixGroups: AG.DG, socketMax: 0,
  }),
  Object.freeze({
    id: 'wand_ember_normal', name: 'Ember Wand', category: 'weapon', slot: 'mainHand', tier: 'normal',
    // reqLevel 1: moved down from the originally-authored 5 (`04` §1.1) — see
    // file header for why baseValue/maxDurability still reflect reqLevel 5.
    reqLevel: 1, reqStr: 12, reqDex: 0, invW: 1, invH: 2,
    maxDurability: 30, baseValue: 64, dropWeight: 80, iconSeed: 0x9b12,
    surface: 'bone', genderRu: 'm',
    weapon: { minDamage: 3, maxDamage: 7, attackTime: 0.60, attackRating: 10, twoHanded: false, range: 1.5, handling: 'wand', element: 'physical' },
    allowedAffixGroups: AG.WC, socketMax: 0,
  }),
  Object.freeze({
    id: 'wand_cinder_exceptional', name: 'Cinder Wand', category: 'weapon', slot: 'mainHand', tier: 'exceptional',
    reqLevel: 14, reqStr: 20, reqDex: 0, invW: 1, invH: 2,
    maxDurability: 41, baseValue: 452, dropWeight: 55, iconSeed: 0x27ce,
    surface: 'bone', genderRu: 'm',
    weapon: { minDamage: 4, maxDamage: 10, attackTime: 0.58, attackRating: 18, twoHanded: false, range: 1.5, handling: 'wand', element: 'physical' },
    allowedAffixGroups: AG.WC, socketMax: 0,
  }),
  Object.freeze({
    id: 'wand_grammar_elite', name: "Grammarian's Wand", category: 'weapon', slot: 'mainHand', tier: 'elite',
    reqLevel: 24, reqStr: 28, reqDex: 0, invW: 1, invH: 2,
    // baseValue 1257: authored, formula gives 1258.
    maxDurability: 53, baseValue: 1257, dropWeight: 34, iconSeed: 0xe855,
    surface: 'bone', genderRu: 'm',
    weapon: { minDamage: 6, maxDamage: 13, attackTime: 0.56, attackRating: 26, twoHanded: false, range: 1.6, handling: 'wand', element: 'physical' },
    allowedAffixGroups: AG.WC, socketMax: 0,
  }),
  Object.freeze({
    id: 'staff_ash_normal', name: 'Ash Staff', category: 'weapon', slot: 'mainHand', tier: 'normal',
    // invW/invH 1x4: authored `03-combat-math.md` §4.6 grid — `04` §14.2 C-6
    // deliberately disagrees with `09-ui.md` §7.3's 2x4 staff icon recipe.
    // Ship 1x4; do not "fix" it to match the icon recipe.
    reqLevel: 10, reqStr: 20, reqDex: 0, invW: 1, invH: 4,
    maxDurability: 39, baseValue: 286, dropWeight: 72, iconSeed: 0x3c7b,
    surface: 'wood', genderRu: 'm',
    weapon: { minDamage: 6, maxDamage: 14, attackTime: 0.95, attackRating: 20, twoHanded: true, range: 2.4, handling: 'staff', element: 'physical' },
    allowedAffixGroups: AG.ST, socketMax: 0,
  }),
  Object.freeze({
    id: 'staff_sermon_exceptional', name: 'Sermon Staff', category: 'weapon', slot: 'mainHand', tier: 'exceptional',
    reqLevel: 18, reqStr: 30, reqDex: 0, invW: 2, invH: 4,
    maxDurability: 49, baseValue: 874, dropWeight: 50, iconSeed: 0x71e3,
    surface: 'wood', genderRu: 'm',
    weapon: { minDamage: 9, maxDamage: 17, attackTime: 0.92, attackRating: 30, twoHanded: true, range: 2.5, handling: 'staff', element: 'physical' },
    allowedAffixGroups: AG.ST, socketMax: 0,
  }),
  Object.freeze({
    id: 'staff_silence_elite', name: 'Staff of Silence', category: 'weapon', slot: 'mainHand', tier: 'elite',
    reqLevel: 27, reqStr: 40, reqDex: 0, invW: 2, invH: 4,
    // baseValue 1883: authored, formula gives 1888.
    maxDurability: 61, baseValue: 1883, dropWeight: 32, iconSeed: 0xaa19,
    surface: 'wood', genderRu: 'm',
    weapon: { minDamage: 11, maxDamage: 22, attackTime: 0.90, attackRating: 40, twoHanded: true, range: 2.5, handling: 'staff', element: 'physical' },
    allowedAffixGroups: AG.ST, socketMax: 0,
  }),

  // ---------------------------------------------------------------------
  // Armour — `04` §1.5, 29 bases.
  // ---------------------------------------------------------------------
  Object.freeze({
    id: 'shield_buckler_normal', name: 'Buckler', category: 'armour', slot: 'offHand', tier: 'normal',
    reqLevel: 3, reqStr: 16, reqDex: 0, invW: 2, invH: 2,
    maxDurability: 57, baseValue: 26, dropWeight: 100, iconSeed: 0x1102,
    surface: 'metal', genderRu: 'm',
    armour: { defMin: 6, defMax: 12, blockBase: 40, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.SH, socketMax: 0,
  }),
  Object.freeze({
    id: 'shield_targe_normal', name: 'Bone Targe', category: 'armour', slot: 'offHand', tier: 'normal',
    reqLevel: 11, reqStr: 34, reqDex: 0, invW: 2, invH: 3,
    maxDurability: 74, baseValue: 305, dropWeight: 85, iconSeed: 0x5507,
    surface: 'bone', genderRu: 'f',
    armour: { defMin: 21, defMax: 35, blockBase: 50, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.SH, socketMax: 0,
  }),
  Object.freeze({
    id: 'shield_kite_exceptional', name: 'Kite Shield', category: 'armour', slot: 'offHand', tier: 'exceptional',
    reqLevel: 19, reqStr: 55, reqDex: 0, invW: 2, invH: 3,
    maxDurability: 92, baseValue: 861, dropWeight: 60, iconSeed: 0x9a3e,
    surface: 'metal', genderRu: 'm',
    armour: { defMin: 36, defMax: 58, blockBase: 55, moveSpeedPenalty: -3 },
    allowedAffixGroups: AG.SH, socketMax: 0,
  }),
  Object.freeze({
    id: 'shield_tower_elite', name: 'Tower Shield', category: 'armour', slot: 'offHand', tier: 'elite',
    reqLevel: 27, reqStr: 82, reqDex: 0, invW: 2, invH: 4,
    // baseValue 1674: authored, formula gives 1678.
    maxDurability: 109, baseValue: 1674, dropWeight: 38, iconSeed: 0xd2b4,
    surface: 'metal', genderRu: 'm',
    armour: { defMin: 50, defMax: 82, blockBase: 65, moveSpeedPenalty: -7 },
    allowedAffixGroups: AG.SH, socketMax: 0,
  }),
  Object.freeze({
    id: 'armour_rags', name: 'Ragged Vestments', category: 'armour', slot: 'chest', tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 2, invH: 3,
    maxDurability: 52, baseValue: 12, dropWeight: 30, iconSeed: 0x0a91,
    surface: 'ash', genderRu: 'n',
    armour: { defMin: 2, defMax: 5, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.BD, socketMax: 0,
  }),
  Object.freeze({
    id: 'armour_quilted_normal', name: 'Quilted Coat', category: 'armour', slot: 'chest', tier: 'normal',
    reqLevel: 4, reqStr: 14, reqDex: 0, invW: 2, invH: 3,
    maxDurability: 59, baseValue: 53, dropWeight: 95, iconSeed: 0x3320,
    surface: 'flesh', genderRu: 'm',
    armour: { defMin: 16, defMax: 25, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.BD, socketMax: 0,
  }),
  Object.freeze({
    id: 'armour_robe_normal', name: 'Ashweave Robe', category: 'armour', slot: 'chest', tier: 'normal',
    reqLevel: 7, reqStr: 10, reqDex: 0, invW: 2, invH: 3,
    maxDurability: 65, baseValue: 153, dropWeight: 85, iconSeed: 0x6612,
    surface: 'ash', genderRu: 'f',
    armour: { defMin: 16, defMax: 26, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.BD, socketMax: 0,
  }),
  Object.freeze({
    id: 'armour_scale_normal', name: 'Scale Mail', category: 'armour', slot: 'chest', tier: 'normal',
    reqLevel: 10, reqStr: 38, reqDex: 0, invW: 2, invH: 3,
    maxDurability: 72, baseValue: 302, dropWeight: 100, iconSeed: 0x88c3,
    surface: 'metal', genderRu: 'm',
    armour: { defMin: 35, defMax: 58, blockBase: 0, moveSpeedPenalty: -2 },
    allowedAffixGroups: AG.BD, socketMax: 0,
  }),
  Object.freeze({
    id: 'armour_shroud_exceptional', name: 'Ember Shroud', category: 'armour', slot: 'chest', tier: 'exceptional',
    reqLevel: 16, reqStr: 22, reqDex: 0, invW: 2, invH: 3,
    maxDurability: 85, baseValue: 737, dropWeight: 62, iconSeed: 0xb04f,
    surface: 'ash', genderRu: 'm',
    armour: { defMin: 34, defMax: 56, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.BD, socketMax: 0,
  }),
  Object.freeze({
    id: 'armour_plated_exceptional', name: 'Plated Hauberk', category: 'armour', slot: 'chest', tier: 'exceptional',
    reqLevel: 18, reqStr: 62, reqDex: 0, invW: 2, invH: 3,
    maxDurability: 90, baseValue: 922, dropWeight: 65, iconSeed: 0xc95a,
    surface: 'metal', genderRu: 'm',
    armour: { defMin: 62, defMax: 101, blockBase: 0, moveSpeedPenalty: -4 },
    allowedAffixGroups: AG.BD, socketMax: 0,
  }),
  Object.freeze({
    id: 'armour_litany_elite', name: 'Litany Robe', category: 'armour', slot: 'chest', tier: 'elite',
    reqLevel: 25, reqStr: 30, reqDex: 0, invW: 2, invH: 3,
    // baseValue 1720: authored, formula gives 1721.
    maxDurability: 105, baseValue: 1720, dropWeight: 38, iconSeed: 0xe317,
    surface: 'ash', genderRu: 'f',
    armour: { defMin: 53, defMax: 86, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.BD, socketMax: 0,
  }),
  Object.freeze({
    id: 'armour_sepulchre_elite', name: 'Sepulchral Plate', category: 'armour', slot: 'chest', tier: 'elite',
    reqLevel: 27, reqStr: 84, reqDex: 0, invW: 2, invH: 3,
    // baseValue 1988: authored, formula gives 1992.
    maxDurability: 109, baseValue: 1988, dropWeight: 42, iconSeed: 0xf6d0,
    surface: 'metal', genderRu: 'm',
    armour: { defMin: 92, defMax: 149, blockBase: 0, moveSpeedPenalty: -6 },
    allowedAffixGroups: AG.BD, socketMax: 0,
  }),
  Object.freeze({
    id: 'helm_cap_normal', name: 'Leather Cap', category: 'armour', slot: 'head', tier: 'normal',
    reqLevel: 1, reqStr: 8, reqDex: 0, invW: 2, invH: 2,
    maxDurability: 34, baseValue: 12, dropWeight: 100, iconSeed: 0x0451,
    surface: 'flesh', genderRu: 'm',
    armour: { defMin: 2, defMax: 4, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.HL, socketMax: 0,
  }),
  Object.freeze({
    id: 'helm_coif_normal', name: 'Bone Coif', category: 'armour', slot: 'head', tier: 'normal',
    reqLevel: 8, reqStr: 26, reqDex: 0, invW: 2, invH: 2,
    maxDurability: 44, baseValue: 125, dropWeight: 90, iconSeed: 0x4a08,
    surface: 'bone', genderRu: 'm',
    armour: { defMin: 11, defMax: 19, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.HL, socketMax: 0,
  }),
  Object.freeze({
    id: 'helm_diadem_exceptional', name: 'Ashen Diadem', category: 'armour', slot: 'head', tier: 'exceptional',
    reqLevel: 15, reqStr: 16, reqDex: 0, invW: 2, invH: 2,
    maxDurability: 55, baseValue: 412, dropWeight: 60, iconSeed: 0x7fd6,
    surface: 'metal', genderRu: 'f',
    armour: { defMin: 13, defMax: 21, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.HL, socketMax: 0,
  }),
  Object.freeze({
    id: 'helm_barbute_exceptional', name: 'Barbute', category: 'armour', slot: 'head', tier: 'exceptional',
    reqLevel: 17, reqStr: 48, reqDex: 0, invW: 2, invH: 2,
    // baseValue 523: authored, formula gives 522.
    maxDurability: 58, baseValue: 523, dropWeight: 62, iconSeed: 0x9e2a,
    surface: 'metal', genderRu: 'm',
    armour: { defMin: 23, defMax: 38, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.HL, socketMax: 0,
  }),
  Object.freeze({
    id: 'helm_gravemask_elite', name: 'Grave Mask', category: 'armour', slot: 'head', tier: 'elite',
    reqLevel: 26, reqStr: 70, reqDex: 0, invW: 2, invH: 2,
    // baseValue 1170: authored, formula gives 1171.
    maxDurability: 71, baseValue: 1170, dropWeight: 40, iconSeed: 0xcb63,
    surface: 'bone', genderRu: 'f',
    armour: { defMin: 35, defMax: 58, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.HL, socketMax: 0,
  }),
  Object.freeze({
    id: 'gloves_wraps_normal', name: 'Hand Wraps', category: 'armour', slot: 'hands', tier: 'normal',
    reqLevel: 1, reqStr: 6, reqDex: 0, invW: 2, invH: 2,
    maxDurability: 34, baseValue: 12, dropWeight: 100, iconSeed: 0x0777,
    surface: 'flesh', genderRu: 'pl',
    armour: { defMin: 2, defMax: 3, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.GL, socketMax: 0,
  }),
  Object.freeze({
    id: 'gloves_bracers_normal', name: 'Studded Bracers', category: 'armour', slot: 'hands', tier: 'normal',
    reqLevel: 9, reqStr: 24, reqDex: 0, invW: 2, invH: 2,
    maxDurability: 46, baseValue: 124, dropWeight: 90, iconSeed: 0x4c19,
    surface: 'flesh', genderRu: 'pl',
    armour: { defMin: 9, defMax: 15, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.GL, socketMax: 0,
  }),
  Object.freeze({
    id: 'gloves_gauntlets_exceptional', name: 'Ash Gauntlets', category: 'armour', slot: 'hands', tier: 'exceptional',
    reqLevel: 18, reqStr: 46, reqDex: 0, invW: 2, invH: 2,
    maxDurability: 59, baseValue: 461, dropWeight: 62, iconSeed: 0xa5b8,
    surface: 'metal', genderRu: 'pl',
    armour: { defMin: 17, defMax: 28, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.GL, socketMax: 0,
  }),
  Object.freeze({
    id: 'gloves_ordinance_elite', name: 'Gauntlets of Ordinance', category: 'armour', slot: 'hands', tier: 'elite',
    reqLevel: 26, reqStr: 66, reqDex: 0, invW: 2, invH: 2,
    // baseValue 926: authored, formula gives 927.
    maxDurability: 71, baseValue: 926, dropWeight: 40, iconSeed: 0xdd41,
    surface: 'metal', genderRu: 'pl',
    armour: { defMin: 25, defMax: 40, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.GL, socketMax: 0,
  }),
  Object.freeze({
    id: 'boots_hide_normal', name: 'Hide Boots', category: 'armour', slot: 'legs', tier: 'normal',
    reqLevel: 1, reqStr: 6, reqDex: 0, invW: 2, invH: 2,
    maxDurability: 34, baseValue: 12, dropWeight: 100, iconSeed: 0x0932,
    surface: 'flesh', genderRu: 'pl',
    armour: { defMin: 2, defMax: 3, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.BT, socketMax: 0,
  }),
  Object.freeze({
    id: 'boots_greaves_normal', name: 'Bone Greaves', category: 'armour', slot: 'legs', tier: 'normal',
    reqLevel: 9, reqStr: 25, reqDex: 0, invW: 2, invH: 2,
    maxDurability: 46, baseValue: 124, dropWeight: 90, iconSeed: 0x4f6c,
    surface: 'bone', genderRu: 'pl',
    armour: { defMin: 10, defMax: 16, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.BT, socketMax: 0,
  }),
  Object.freeze({
    id: 'boots_march_exceptional', name: 'Marching Greaves', category: 'armour', slot: 'legs', tier: 'exceptional',
    reqLevel: 18, reqStr: 47, reqDex: 0, invW: 2, invH: 2,
    maxDurability: 59, baseValue: 461, dropWeight: 62, iconSeed: 0xa8d5,
    surface: 'metal', genderRu: 'pl',
    armour: { defMin: 19, defMax: 30, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.BT, socketMax: 0,
  }),
  Object.freeze({
    id: 'boots_pilgrim_elite', name: 'Pilgrim Sabatons', category: 'armour', slot: 'legs', tier: 'elite',
    reqLevel: 26, reqStr: 68, reqDex: 0, invW: 2, invH: 2,
    // baseValue 926: authored, formula gives 927.
    maxDurability: 71, baseValue: 926, dropWeight: 40, iconSeed: 0xe0be,
    surface: 'metal', genderRu: 'pl',
    armour: { defMin: 26, defMax: 43, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.BT, socketMax: 0,
  }),
  Object.freeze({
    id: 'belt_sash_normal', name: 'Cord Sash', category: 'armour', slot: 'belt', tier: 'normal',
    reqLevel: 1, reqStr: 5, reqDex: 0, invW: 2, invH: 1,
    maxDurability: 34, baseValue: 12, dropWeight: 100, iconSeed: 0x0b58,
    surface: 'flesh', genderRu: 'm',
    armour: { defMin: 1, defMax: 2, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.BL, socketMax: 0,
  }),
  Object.freeze({
    id: 'belt_studded_normal', name: 'Studded Belt', category: 'armour', slot: 'belt', tier: 'normal',
    reqLevel: 9, reqStr: 22, reqDex: 0, invW: 2, invH: 1,
    maxDurability: 46, baseValue: 117, dropWeight: 90, iconSeed: 0x5271,
    surface: 'flesh', genderRu: 'm',
    armour: { defMin: 7, defMax: 11, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.BL, socketMax: 0,
  }),
  Object.freeze({
    id: 'belt_plated_exceptional', name: 'Plated Girdle', category: 'armour', slot: 'belt', tier: 'exceptional',
    reqLevel: 18, reqStr: 44, reqDex: 0, invW: 2, invH: 1,
    maxDurability: 59, baseValue: 437, dropWeight: 62, iconSeed: 0xab90,
    surface: 'metal', genderRu: 'm',
    armour: { defMin: 14, defMax: 22, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.BL, socketMax: 0,
  }),
  Object.freeze({
    id: 'belt_ledger_elite', name: 'Ledger Belt', category: 'armour', slot: 'belt', tier: 'elite',
    reqLevel: 26, reqStr: 64, reqDex: 0, invW: 2, invH: 1,
    maxDurability: 71, baseValue: 878, dropWeight: 40, iconSeed: 0xe45f,
    surface: 'metal', genderRu: 'm',
    armour: { defMin: 19, defMax: 32, blockBase: 0, moveSpeedPenalty: 0 },
    allowedAffixGroups: AG.BL, socketMax: 0,
  }),

  // ---------------------------------------------------------------------
  // Jewelry — `04` §1.6, 6 bases.
  // ---------------------------------------------------------------------
  Object.freeze({
    id: 'ring_iron', name: 'Iron Band', category: 'jewelry', slot: 'ring1', tier: 'normal',
    reqLevel: 4, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 70, dropWeight: 100, iconSeed: 0x1200,
    surface: 'metal', genderRu: 'm',
    allowedAffixGroups: AG.RG, socketMax: 0,
  }),
  Object.freeze({
    id: 'ring_bone', name: 'Bone Ring', category: 'jewelry', slot: 'ring1', tier: 'exceptional',
    reqLevel: 12, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 562, dropWeight: 70, iconSeed: 0x5a44,
    surface: 'bone', genderRu: 'n',
    allowedAffixGroups: AG.RG, socketMax: 0,
  }),
  Object.freeze({
    id: 'ring_gilt', name: 'Gilt Ring', category: 'jewelry', slot: 'ring1', tier: 'elite',
    reqLevel: 22, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    // baseValue 1776: authored, formula gives 1777.
    maxDurability: 0, baseValue: 1776, dropWeight: 42, iconSeed: 0xc17d,
    surface: 'metal', genderRu: 'n',
    allowedAffixGroups: AG.RG, socketMax: 0,
  }),
  Object.freeze({
    id: 'amulet_cord', name: 'Corded Amulet', category: 'jewelry', slot: 'amulet', tier: 'normal',
    reqLevel: 6, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 181, dropWeight: 100, iconSeed: 0x2d90,
    surface: 'flesh', genderRu: 'm',
    allowedAffixGroups: AG.AM, socketMax: 0,
  }),
  Object.freeze({
    id: 'amulet_reliquary', name: 'Reliquary Amulet', category: 'jewelry', slot: 'amulet', tier: 'exceptional',
    reqLevel: 16, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 1164, dropWeight: 65, iconSeed: 0x86ea,
    surface: 'metal', genderRu: 'm',
    allowedAffixGroups: AG.AM, socketMax: 0,
  }),
  Object.freeze({
    id: 'amulet_seal', name: 'Sealed Amulet', category: 'jewelry', slot: 'amulet', tier: 'elite',
    reqLevel: 25, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    // baseValue 2715: authored, formula gives 2718.
    maxDurability: 0, baseValue: 2715, dropWeight: 40, iconSeed: 0xf29b,
    surface: 'metal', genderRu: 'm',
    allowedAffixGroups: AG.AM, socketMax: 0,
  }),

  // ---------------------------------------------------------------------
  // Quest — `04` §1.6. `dropWeight 0`: placed by `world` on the altar, never
  // rolled by a treasure class (`04` §1.6's own note).
  // ---------------------------------------------------------------------
  Object.freeze({
    id: 'quest_first_tablet', name: 'The First Tablet', category: 'quest', slot: null, tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 2, invH: 2,
    maxDurability: 0, baseValue: 0, dropWeight: 0, iconSeed: 0x0001,
    surface: 'stone', genderRu: 'f',
    allowedAffixGroups: AG.NONE, socketMax: 0,
  }),

  // ---------------------------------------------------------------------
  // Consumables — `04` §8.1, 12 bases. All `1x1`, `stackMax 20` except the
  // single-charge `scroll_respec`. `amountPercent` is `0` for the three
  // effects that do not use a percent (`identify`/`town_portal`/`respec`,
  // table value "—"). See file header for `reqLevel`/`tier`/`dropWeight`
  // and the omitted `Cooldown`/`Drop band` columns.
  // ---------------------------------------------------------------------
  Object.freeze({
    id: 'potion_life_minor', name: 'Minor Healing Potion', category: 'consumable', slot: null, tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 35, dropWeight: 100, iconSeed: 0x2101,
    surface: 'crystal', genderRu: 'm',
    consumable: { effect: 'restore_life', amountPercent: 35, overSeconds: 3.0, stackMax: 20 },
    allowedAffixGroups: AG.NONE, socketMax: 0,
  }),
  Object.freeze({
    id: 'potion_life_lesser', name: 'Lesser Healing Potion', category: 'consumable', slot: null, tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 85, dropWeight: 100, iconSeed: 0x2102,
    surface: 'crystal', genderRu: 'm',
    consumable: { effect: 'restore_life', amountPercent: 45, overSeconds: 3.0, stackMax: 20 },
    allowedAffixGroups: AG.NONE, socketMax: 0,
  }),
  Object.freeze({
    id: 'potion_life_greater', name: 'Greater Healing Potion', category: 'consumable', slot: null, tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 180, dropWeight: 100, iconSeed: 0x2103,
    surface: 'crystal', genderRu: 'm',
    consumable: { effect: 'restore_life', amountPercent: 60, overSeconds: 3.0, stackMax: 20 },
    allowedAffixGroups: AG.NONE, socketMax: 0,
  }),
  Object.freeze({
    id: 'potion_life_grand', name: 'Grand Healing Potion', category: 'consumable', slot: null, tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 340, dropWeight: 100, iconSeed: 0x2104,
    surface: 'crystal', genderRu: 'm',
    consumable: { effect: 'restore_life', amountPercent: 80, overSeconds: 3.0, stackMax: 20 },
    allowedAffixGroups: AG.NONE, socketMax: 0,
  }),
  Object.freeze({
    id: 'potion_mana_minor', name: 'Minor Mana Potion', category: 'consumable', slot: null, tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 40, dropWeight: 100, iconSeed: 0x2105,
    surface: 'crystal', genderRu: 'm',
    consumable: { effect: 'restore_mana', amountPercent: 35, overSeconds: 3.0, stackMax: 20 },
    allowedAffixGroups: AG.NONE, socketMax: 0,
  }),
  Object.freeze({
    id: 'potion_mana_lesser', name: 'Lesser Mana Potion', category: 'consumable', slot: null, tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 95, dropWeight: 100, iconSeed: 0x2106,
    surface: 'crystal', genderRu: 'm',
    consumable: { effect: 'restore_mana', amountPercent: 45, overSeconds: 3.0, stackMax: 20 },
    allowedAffixGroups: AG.NONE, socketMax: 0,
  }),
  Object.freeze({
    id: 'potion_mana_greater', name: 'Greater Mana Potion', category: 'consumable', slot: null, tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 200, dropWeight: 100, iconSeed: 0x2107,
    surface: 'crystal', genderRu: 'm',
    consumable: { effect: 'restore_mana', amountPercent: 60, overSeconds: 3.0, stackMax: 20 },
    allowedAffixGroups: AG.NONE, socketMax: 0,
  }),
  Object.freeze({
    id: 'potion_mana_grand', name: 'Grand Mana Potion', category: 'consumable', slot: null, tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 380, dropWeight: 100, iconSeed: 0x2108,
    surface: 'crystal', genderRu: 'm',
    consumable: { effect: 'restore_mana', amountPercent: 80, overSeconds: 3.0, stackMax: 20 },
    allowedAffixGroups: AG.NONE, socketMax: 0,
  }),
  Object.freeze({
    id: 'potion_rejuvenation', name: 'Rejuvenation Potion', category: 'consumable', slot: null, tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 450, dropWeight: 100, iconSeed: 0x2109,
    surface: 'crystal', genderRu: 'm',
    consumable: { effect: 'restore_both', amountPercent: 40, overSeconds: 0.0, stackMax: 20 },
    allowedAffixGroups: AG.NONE, socketMax: 0,
  }),
  Object.freeze({
    id: 'scroll_identify', name: 'Scroll of Identify', category: 'consumable', slot: null, tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 90, dropWeight: 100, iconSeed: 0x210a,
    surface: 'wood', genderRu: 'm',
    consumable: { effect: 'identify', amountPercent: 0, overSeconds: 0.0, stackMax: 20 },
    allowedAffixGroups: AG.NONE, socketMax: 0,
  }),
  Object.freeze({
    id: 'scroll_portal', name: 'Scroll of Town Portal', category: 'consumable', slot: null, tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 120, dropWeight: 100, iconSeed: 0x210b,
    surface: 'wood', genderRu: 'm',
    consumable: { effect: 'town_portal', amountPercent: 0, overSeconds: 1.0, stackMax: 20 },
    allowedAffixGroups: AG.NONE, socketMax: 0,
  }),
  Object.freeze({
    id: 'scroll_respec', name: 'Scroll of Respec', category: 'consumable', slot: null, tier: 'normal',
    reqLevel: 1, reqStr: 0, reqDex: 0, invW: 1, invH: 1,
    maxDurability: 0, baseValue: 5000, dropWeight: 100, iconSeed: 0x210c,
    surface: 'wood', genderRu: 'm',
    consumable: { effect: 'respec', amountPercent: 0, overSeconds: 0.0, stackMax: 1 },
    allowedAffixGroups: AG.NONE, socketMax: 0,
  }),
]);

/** Built once, at module load, as a plain `Object.create(null)` map — never
 * a `Map` rebuilt per read (`ARCHITECTURE.md`'s measured-cost rule: `Map`
 * leaks on never-repeating keys and `.clear()` allocates unconditionally).
 * This is a one-time load-time index, not a per-frame or per-roll cache. */
export const ITEM_BASES_BY_ID = Object.freeze(
  ITEM_BASES.reduce((acc, base) => {
    acc[base.id] = base;
    return acc;
  }, Object.create(null)),
);
