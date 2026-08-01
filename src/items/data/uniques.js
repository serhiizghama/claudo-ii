// src/items/data/uniques.js
//
// ITEM-7 — the 8 `UniqueDefinition` records, `04-items.md` §6 transcribed
// verbatim (table §6.1, mod tables §6.2-§6.9). Plain frozen data, no logic
// (`ARCHITECTURE.md` rule 9 / this ticket's brief "Data lives in data/"):
// the D6 pool filter and the D12 value roll are logic and live in
// `src/items/roll.js`, not here.
//
// ---------------------------------------------------------------------------
// Count — exactly 8, PROGRESS D-26 (settled, binding)
// ---------------------------------------------------------------------------
// `04` §14.2 C-1 flags a contradiction: `IMPLEMENTATION_PLAN.md` §4.4 asks
// for "one per slot plus two weapons" at a budget of eight, which is
// arithmetically twelve against the ten slots `01-data-model.md` §1.5
// defines. The orchestrator ruled (PROGRESS D-26): eight, as shipped in
// `04` §6, and `04` §6.10 documents `ring1`/`ring2`/`offHand` as a
// deliberate, deferred-past-M9 gap (`04` §14.1 D-11). This file ships
// exactly the eight rows of §6.1's table — no ninth, no ring, no shield.
//
// ---------------------------------------------------------------------------
// `alvl` vs `reqLevel` — no separate field, by design
// ---------------------------------------------------------------------------
// `01-data-model.md` §5.5's `UniqueDefinition` example has no `alvl` field,
// only `reqLevel` ("may exceed the base's own reqLevel"). `04` §6.1's table
// and every one of §6.2-§6.9's per-item headers print BOTH an `alvl` and a
// `reqLevel` value — and for all eight rows the two are numerically
// identical (verens_reckoning: alvl 12 / reqLevel 12; ashen_crown: 14 / 14;
// long_way_back: 16 / 16; stonecutters_grasp: 17 / 17; kairas_ledger: 18 /
// 18; bonereach_vestment: 19 / 19; unfinished_sentence: 20 / 20;
// last_syllable: 25 / 25). Rather than invent a field `01` does not define,
// this table's single `reqLevel` does double duty: it is both the schema's
// own `reqLevel` and the value `04` §9.2's D6 gate ("`W(uniquePool where
// alvl <= ilvl)`") reads (`src/items/roll.js`'s `pickUnique`/`uniquePoolAt`
// filter on `.reqLevel`, not on a nonexistent `.alvl`). If a future unique
// is ever authored with alvl != reqLevel this will need revisiting; flagged
// in this ticket's report.
//
// ---------------------------------------------------------------------------
// `ashen_crown` — 5 mods, not 3 (`04` §14.1 D-4, binding)
// ---------------------------------------------------------------------------
// `01-data-model.md` §5.5 uses `ashen_crown` as its worked example with only
// three mods (manaCostReduction, lifePercent, fireResist) — shipped as
// written it is a straight downside with no payoff. `04` §6.3 adds
// `skillBonuses.tree` (+2 Flame) and `fasterCastRate` (15-20%) on top of the
// three original ranges, kept verbatim. Shipped here as five mods, per D-4
// and `04` §6.3's own table.
//
// ---------------------------------------------------------------------------
// `skillBonuses.tree`'s `tree` key — an addition to the mod shape
// ---------------------------------------------------------------------------
// `src/items/data/affixes.js` already uses the stat id `skillBonuses.tree`
// (`pfx_tree_1`/`pfx_tree_2`) for a prefix that grants points to a tree
// resolved elsewhere (nothing in the mod itself says which tree — it is
// presumably decided per-affix-instance by a later ticket). `ashen_crown`'s
// copy of that stat is NOT that generic case: `04` §6.3 fixes it to the
// `flame` tree specifically ("+2 to Flame Skills"), permanently, as static
// data. `{ stat, min, max }` alone cannot express "which tree", so this one
// mod entry carries one extra key, `tree: 'flame'` — the same pattern
// `AffixDefinition.mods` already uses for its own extra key, `step`.
// `last_syllable`'s `skillBonuses.all` needs no such key; it is inherently
// unscoped.
//
// ---------------------------------------------------------------------------
// No `step` on any mod
// ---------------------------------------------------------------------------
// Every min/max pair below is an integer range (including the two
// deliberately-degenerate ones, `cannotBeFrozen` 1-1 and `maxResonance`/
// `resonanceOnHit`/`skillBonuses.*` 2-2 or 1-1). `roll.js#rollMod` already
// defaults `step` to 1 when absent, which reproduces `Ui(min,max)` exactly
// for all of these — no mod here needs the non-1-step lattice form.
//
// ---------------------------------------------------------------------------
// Lore — English only, per `01`'s canonical `UniqueDefinition.lore` field
// ---------------------------------------------------------------------------
// `04` §6 prints both an EN and a RU lore line for every unique, but
// `01-data-model.md` §5.5's shape has one `lore` string field and `04` §13.2
// (the four additive fields folded into `01`) does not add a `loreRu`
// alongside it the way it does add `ItemBase.genderRu`. The EN line is
// stored as `lore`; the RU line is reproduced in this file's own comments,
// next to each record, for a future ticket that adds localisation to reach
// without re-deriving it from `04` a second time.

export const UNIQUES = Object.freeze([
  Object.freeze({
    // RU: "Расплата Верена" — Верен нанёс один и тот же удар одиннадцать
    // тысяч раз и назвал это молитвой.
    id: 'verens_reckoning', name: "Veren's Reckoning", baseId: 'axe_battle_normal',
    reqLevel: 12, dropWeight: 10,
    lore: 'Veren struck the same blow eleven thousand times and called it a prayer.',
    mods: [
      { stat: 'enhancedDamage', min: 80, max: 110 },
      { stat: 'minDamage', min: 6, max: 10 },
      { stat: 'maxDamage', min: 14, max: 20 },
      { stat: 'increasedAttackSpeed', min: 15, max: 20 },
      { stat: 'lifeSteal', min: 5, max: 8 },
      { stat: 'rageOnHit', min: 3, max: 5 },
      { stat: 'critChance', min: 8, max: 14 },
    ],
  }),
  Object.freeze({
    // RU: "Пепельный венец" — Носима первым, кто прочёл вслух, и первым,
    // кто забыл. Five mods per 04 §14.1 D-4 — see file header.
    id: 'ashen_crown', name: 'Ashen Crown', baseId: 'helm_coif_normal',
    reqLevel: 14, dropWeight: 4,
    lore: 'Worn by the first to read aloud and the first to forget.',
    mods: [
      { stat: 'manaCostReduction', min: 20, max: 25 },
      { stat: 'lifePercent', min: -45, max: -35 },
      { stat: 'fireResist', min: 15, max: 25 },
      { stat: 'skillBonuses.tree', tree: 'flame', min: 2, max: 2 },
      { stat: 'fasterCastRate', min: 15, max: 20 },
    ],
  }),
  Object.freeze({
    // RU: "Долгий путь назад" — Оплот позади тебя. Он всегда позади тебя.
    id: 'long_way_back', name: 'The Long Way Back', baseId: 'boots_march_exceptional',
    reqLevel: 16, dropWeight: 8,
    lore: 'Bastion is behind you. It is always behind you.',
    mods: [
      { stat: 'movementSpeed', min: 30, max: 40 },
      { stat: 'dodgeChance', min: 8, max: 12 },
      { stat: 'ccReduction', min: 20, max: 30 },
      { stat: 'maxStamina', min: 40, max: 60 },
      { stat: 'cannotBeFrozen', min: 1, max: 1 },
    ],
  }),
  Object.freeze({
    // RU: "Хватка Каменотёса" — Он вытесал врата, стену и могилы — именно
    // в таком порядке.
    id: 'stonecutters_grasp', name: "Stonecutter's Grasp", baseId: 'gloves_gauntlets_exceptional',
    reqLevel: 17, dropWeight: 9,
    lore: 'He shaped the gate, the wall and the graves, in that order.',
    mods: [
      { stat: 'increasedAttackSpeed', min: 20, max: 30 },
      { stat: 'minDamage', min: 4, max: 8 },
      { stat: 'maxDamage', min: 9, max: 15 },
      { stat: 'critChance', min: 8, max: 12 },
      { stat: 'strength', min: 10, max: 15 },
      { stat: 'thorns', min: 20, max: 35 },
    ],
  }),
  Object.freeze({
    // RU: "Реестр Кайры" — Каждое имя, которому она учила, и день, когда
    // оно перестало отзываться.
    id: 'kairas_ledger', name: "Kaira's Ledger", baseId: 'belt_plated_exceptional',
    reqLevel: 18, dropWeight: 9,
    lore: 'Every name she taught, and the day each one stopped answering.',
    mods: [
      { stat: 'maxLife', min: 25, max: 40 },
      { stat: 'fasterHitRecovery', min: 30, max: 45 },
      { stat: 'damageReducePercent', min: 5, max: 8 },
      { stat: 'magicFind', min: 20, max: 30 },
      { stat: 'requirementReduction', min: 15, max: 20 },
    ],
  }),
  Object.freeze({
    // RU: "Облачение Костей Предела" — Мёртвых перестали хоронить и начали
    // в них одеваться.
    id: 'bonereach_vestment', name: 'Bonereach Vestment', baseId: 'armour_plated_exceptional',
    reqLevel: 19, dropWeight: 7,
    lore: 'They stopped burying the dead and started dressing in them.',
    mods: [
      { stat: 'defensePercent', min: 90, max: 130 },
      { stat: 'maxLife', min: 40, max: 60 },
      { stat: 'damageReduceFlat', min: 4, max: 7 },
      { stat: 'fireResist', min: 12, max: 18 },
      { stat: 'coldResist', min: 12, max: 18 },
      { stat: 'lightResist', min: 12, max: 18 },
      { stat: 'movementSpeed', min: -10, max: -10 },
    ],
  }),
  Object.freeze({
    // RU: "Незаконченная фраза" — Наставника прервали. Клинок помнит,
    // на чём.
    id: 'unfinished_sentence', name: 'The Unfinished Sentence', baseId: 'sword_sigil_exceptional',
    reqLevel: 20, dropWeight: 5,
    lore: 'The Instructor was interrupted. The blade remembers where.',
    mods: [
      { stat: 'enhancedDamage', min: 60, max: 85 },
      { stat: 'manaPercent', min: -60, max: -45 },
      { stat: 'manaReturnPercent', min: 14, max: 20 },
      { stat: 'maxResonance', min: 2, max: 2 },
      { stat: 'resonanceOnHit', min: 1, max: 1 },
      { stat: 'fasterCastRate', min: 15, max: 25 },
    ],
  }),
  Object.freeze({
    // RU: "Последний слог" — То, что остаётся от слова, когда из него
    // вынули смысл.
    id: 'last_syllable', name: 'The Last Syllable', baseId: 'amulet_seal',
    reqLevel: 25, dropWeight: 4,
    lore: 'What is left of a word after the meaning is taken out of it.',
    mods: [
      { stat: 'skillBonuses.all', min: 2, max: 2 },
      { stat: 'physicalDamagePercent', min: -100, max: -100 },
      { stat: 'magicMin', min: 20, max: 30 },
      { stat: 'magicMax', min: 45, max: 65 },
      { stat: 'elementalDamagePercent', min: 40, max: 60 },
      { stat: 'manaRegenPercent', min: 8, max: 12 },
    ],
  }),
]);

/** `UniqueDefinition.id -> UniqueDefinition`, built once at module load —
 * same precedent as `ITEM_BASES_BY_ID` (`./bases.js`). */
export const UNIQUES_BY_ID = Object.freeze(
  (() => {
    const out = Object.create(null);
    for (const u of UNIQUES) out[u.id] = u;
    return out;
  })(),
);
