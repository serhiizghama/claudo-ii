// src/items/data/treasure.js
//
// ITEM-3 — treasure classes (`04-items.md` §5) and `resolveTC`
// (`02-api-contracts.md:963`, `Fixed = Y`, `Alloc = no`). Plain frozen data,
// no logic (`ARCHITECTURE.md` rule 9 / this ticket's brief rule 6) — the one
// exception the spec itself grants this file is `resolveTC`, "the one
// function the spec puts here" (this ticket's brief), and it is written
// below as a pure band-suffix lookup: zero RNG draws, no recursion, zero
// allocation per call.
//
// ---------------------------------------------------------------------------
// PROGRESS rulings this file is bound by
// ---------------------------------------------------------------------------
// - D-28: this is the spec file name (`04` §5.1's own header comment),
//   overriding `BACKLOG.md`'s stale name.
// - D-19: `04` §9.2 is normative over `02-api-contracts.md`'s stale
//   twelve-row table. `resolveTC(family, mlvl)` (`04:1042-1054`) is a
//   deterministic band-suffix lookup — no draws, no recursive descent — and
//   `nodrop` is one weighted entry of `entries`, resolved by the same first
//   draw (`D1` in `04` §9.2), not a separate always-taken draw. Both are
//   reflected in the shape below: `nodrop` is just another `entries` row,
//   and `resolveTC` never touches `ctx.rng`.
// - D-27: `06-monsters-ai.md` §15 D-2 / `13` §14 C2 / `07-world-gen.md`'s
//   live array / `src/ai/data/bestiary.js` (shipped, M2) all agree the
//   heavy-role archetype is `maulsmith`, not a `hammerfell_brute` that does
//   not exist anywhere in the tree. `tc_heavy`'s bestiary rationale below
//   names `maulsmith` per that ruling; no seventh archetype invented.
//
// ---------------------------------------------------------------------------
// Shape — two kinds of table, and why they are not the same shape
// ---------------------------------------------------------------------------
// Top-level classes (the 16 monster classes, `tc_urn`, the three chest
// classes) hold `entries: [{ kind, weight, sub?, rarityFloor? }]` — `kind` is
// one of `'nodrop' | 'gold' | 'item' | 'potion' | 'scroll'`, exactly `04`
// §5.1's record. `sub` and `rarityFloor` are omitted (not set to `null`)
// when absent, matching §5.1's own printed example, which shows only the
// fields a row actually uses.
//
// Sub-tables (`tc_potion_1..4`, `tc_scroll`, `tc_scroll_boss`, §5.7) hold
// `entries: [{ id, weight }]` — `id` is a literal `ItemBase.id` from
// `src/items/data/bases.js` (ITEM-1), not a `kind` tag, because these tables
// are the leaf the `potion`/`scroll` draw (`04` §9.2 `D14`) lands on.
//
// `tc_boss` (§5.5) is neither: "No `nodrop`, no weights. A fixed script."
// It is given its own `script: [{ step, rarityFloor?, sub? }]` array instead
// of `entries`, deliberately a different key — a boss row summed into the
// "every class sums to 1000" check by an incautious test would be a false
// failure (ten fixed steps, not a weighted pick), and a different key makes
// that structurally impossible rather than relying on every reader
// remembering to special-case `id === 'tc_boss'`.
//
// ---------------------------------------------------------------------------
// What is deliberately NOT in this file
// ---------------------------------------------------------------------------
// - `PICKS[rank]` / `NODROP_SCALE[rank]` (§5.4) and `RANK_GOLD` (§5.5 item 7)
//   are rank-modifier constants consumed by `rollDrop`, not treasure-class
//   data — this ticket's own acceptance criterion (`04` §12 step 3) lists
//   the inventory this file ships and neither table is in it. They belong to
//   ITEM-9 (`rollDrop`, §9.3), which is also where the unique-rank
//   guarantee's extra pick lives; nothing here bakes a rank-conditional
//   floor into a class, because the floor those ten worked-example rows
//   describe is dynamic (applied *after* the picks, §5.4), not a property of
//   any one `entries` row.
// - Ground placement and decay (§5.8) — explicitly out of scope, ITEM-12.
// - `rollDrop`/`rollItem`/`rollChest`/`rollGold` themselves — ITEM-9, and
//   `02-api-contracts.md` §11 is the authority on their signatures, not this
//   file.
//
// ---------------------------------------------------------------------------
// The one real ambiguity: `sub` on `tc_urn` / the three chest classes
// ---------------------------------------------------------------------------
// `04` §5.1's own example bakes a literal band into `sub`
// (`tc_humanoid_2`'s `potion` row points at `tc_potion_2`) because that
// family is already band-resolved by construction — a `tc_humanoid_2` row
// only ever fires for a monster whose `mlvl` resolved to band 2, so pointing
// its `potion` entry at the same band is not a choice, it is the only value
// that can ever be correct. `tc_urn` and the three chest classes have no
// such fixed band: §5.6 states their `ilvl` as a *runtime* formula (`zone
// monsterLevel` for the urn, `zone monsterLevel + 2` for a chest) that this
// static table cannot evaluate, and `04` §9.3 step 2's own pseudocode
// resolves a `potion`/`scroll` pick against `tc_potion_<band>` /
// `tc_scroll` computed from context at roll time, not from a value read off
// the entry. Baking a guessed band into these four classes' `potion`/
// `scroll` rows would be inventing a number the spec does not provide
// (this ticket's rule 13) and would silently go stale the moment a zone's
// `monsterLevel` changes. `sub` is therefore left unset on exactly these
// rows; `sub` is set only where the source band is fixed by the row's own
// id (every monster-table `potion` row, matching its own band; every
// `scroll` row, `'tc_scroll'`; `tc_boss`'s `scroll` step, the explicit
// override `'tc_scroll_boss'`). Flagged in this ticket's report.

/** `04` §5.1's band table, transcribed once as an array indexed by `mlvl`
 * (1..40) so `resolveTC` never branches or divides per call — array index,
 * nothing else. Built once here, at module load; `resolveTC` only reads it. */
const BAND_OF_MLVL = Object.freeze((() => {
  const bands = new Array(41);
  for (let mlvl = 1; mlvl <= 9; mlvl++) bands[mlvl] = 1;
  for (let mlvl = 10; mlvl <= 19; mlvl++) bands[mlvl] = 2;
  for (let mlvl = 20; mlvl <= 29; mlvl++) bands[mlvl] = 3;
  for (let mlvl = 30; mlvl <= 40; mlvl++) bands[mlvl] = 4;
  bands[0] = 1; // degenerate/clamped low end; no real mlvl is ever 0
  return bands;
})());

/** The band-suffixed id strings, built once here (rule 5 of this ticket's
 * brief: "Build the band strings once at module level and index into
 * them" — the naive `` `${family}_${band}` `` allocates on every call, which
 * `resolveTC`'s `Alloc = no` contract (`02-api-contracts.md:963`) forbids).
 * Only families that actually carry four bands appear here. Every other
 * family id (`tc_boss`, `tc_urn`, `tc_wastes`, `tc_bonereach`, `tc_altar`,
 * `tc_scroll`, `tc_scroll_boss`) is, per §5.1, "a single class" that
 * "resolves to itself" — `resolveTC` falls through to that case for any
 * family not listed here, with no per-family entry needed for it. */
const BANDED_FAMILY_IDS = Object.freeze({
  tc_humanoid: Object.freeze(['tc_humanoid_1', 'tc_humanoid_2', 'tc_humanoid_3', 'tc_humanoid_4']),
  tc_swarm: Object.freeze(['tc_swarm_1', 'tc_swarm_2', 'tc_swarm_3', 'tc_swarm_4']),
  tc_caster: Object.freeze(['tc_caster_1', 'tc_caster_2', 'tc_caster_3', 'tc_caster_4']),
  tc_heavy: Object.freeze(['tc_heavy_1', 'tc_heavy_2', 'tc_heavy_3', 'tc_heavy_4']),
  tc_potion: Object.freeze(['tc_potion_1', 'tc_potion_2', 'tc_potion_3', 'tc_potion_4']),
});

/** `(family:string, mlvl:int) => string` — `02-api-contracts.md:963`.
 * `Fixed = Y`, `Alloc = no`: no draw, no recursion (`04` §5.1, D-19), no
 * allocation (two object-property reads and one array index, always). */
export function resolveTC(family, mlvl) {
  const bands = BANDED_FAMILY_IDS[family];
  if (bands === undefined) return family; // single class — resolves to itself, §5.1
  const clamped = mlvl < 1 ? 1 : mlvl > 40 ? 40 : mlvl;
  return bands[BAND_OF_MLVL[clamped] - 1];
}

// ---------------------------------------------------------------------------
// §5.3 — the 16 monster classes (4 families × 4 `mlvl` bands)
// ---------------------------------------------------------------------------
// Bestiary assignment (§5.2): `bone_ranker` / `ashen_archer` -> `tc_humanoid`;
// `carrion_swarm` / `blight_crawler` -> `tc_swarm`; `dust_shaman` ->
// `tc_caster`; `maulsmith` -> `tc_heavy` (D-27); `molgrim` -> `tc_boss`.

export const TREASURE_CLASSES = Object.freeze([
  // --- tc_humanoid — Bone Ranker, Ashen Archer -----------------------------
  Object.freeze({
    id: 'tc_humanoid_1',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 660 }),
      Object.freeze({ kind: 'gold', weight: 225 }),
      Object.freeze({ kind: 'item', weight: 80 }),
      Object.freeze({ kind: 'potion', weight: 32, sub: 'tc_potion_1' }),
      Object.freeze({ kind: 'scroll', weight: 3, sub: 'tc_scroll' }),
    ]),
  }),
  Object.freeze({
    id: 'tc_humanoid_2',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 620 }),
      Object.freeze({ kind: 'gold', weight: 230 }),
      Object.freeze({ kind: 'item', weight: 105 }),
      Object.freeze({ kind: 'potion', weight: 38, sub: 'tc_potion_2' }),
      Object.freeze({ kind: 'scroll', weight: 7, sub: 'tc_scroll' }),
    ]),
  }),
  Object.freeze({
    id: 'tc_humanoid_3',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 585 }),
      Object.freeze({ kind: 'gold', weight: 232 }),
      Object.freeze({ kind: 'item', weight: 130 }),
      Object.freeze({ kind: 'potion', weight: 43, sub: 'tc_potion_3' }),
      Object.freeze({ kind: 'scroll', weight: 10, sub: 'tc_scroll' }),
    ]),
  }),
  Object.freeze({
    id: 'tc_humanoid_4',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 555 }),
      Object.freeze({ kind: 'gold', weight: 233 }),
      Object.freeze({ kind: 'item', weight: 152 }),
      Object.freeze({ kind: 'potion', weight: 47, sub: 'tc_potion_4' }),
      Object.freeze({ kind: 'scroll', weight: 13, sub: 'tc_scroll' }),
    ]),
  }),

  // --- tc_swarm — Carrion Swarm, Blight Crawler ----------------------------
  Object.freeze({
    id: 'tc_swarm_1',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 830 }),
      Object.freeze({ kind: 'gold', weight: 128 }),
      Object.freeze({ kind: 'item', weight: 32 }),
      Object.freeze({ kind: 'potion', weight: 9, sub: 'tc_potion_1' }),
      Object.freeze({ kind: 'scroll', weight: 1, sub: 'tc_scroll' }),
    ]),
  }),
  Object.freeze({
    id: 'tc_swarm_2',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 805 }),
      Object.freeze({ kind: 'gold', weight: 137 }),
      Object.freeze({ kind: 'item', weight: 43 }),
      Object.freeze({ kind: 'potion', weight: 12, sub: 'tc_potion_2' }),
      Object.freeze({ kind: 'scroll', weight: 3, sub: 'tc_scroll' }),
    ]),
  }),
  Object.freeze({
    id: 'tc_swarm_3',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 782 }),
      Object.freeze({ kind: 'gold', weight: 145 }),
      Object.freeze({ kind: 'item', weight: 54 }),
      Object.freeze({ kind: 'potion', weight: 15, sub: 'tc_potion_3' }),
      Object.freeze({ kind: 'scroll', weight: 4, sub: 'tc_scroll' }),
    ]),
  }),
  Object.freeze({
    id: 'tc_swarm_4',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 762 }),
      Object.freeze({ kind: 'gold', weight: 152 }),
      Object.freeze({ kind: 'item', weight: 64 }),
      Object.freeze({ kind: 'potion', weight: 17, sub: 'tc_potion_4' }),
      Object.freeze({ kind: 'scroll', weight: 5, sub: 'tc_scroll' }),
    ]),
  }),

  // --- tc_caster — Dust Shaman ----------------------------------------------
  Object.freeze({
    id: 'tc_caster_1',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 600 }),
      Object.freeze({ kind: 'gold', weight: 210 }),
      Object.freeze({ kind: 'item', weight: 118 }),
      Object.freeze({ kind: 'potion', weight: 52, sub: 'tc_potion_1' }),
      Object.freeze({ kind: 'scroll', weight: 20, sub: 'tc_scroll' }),
    ]),
  }),
  Object.freeze({
    id: 'tc_caster_2',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 560 }),
      Object.freeze({ kind: 'gold', weight: 212 }),
      Object.freeze({ kind: 'item', weight: 148 }),
      Object.freeze({ kind: 'potion', weight: 55, sub: 'tc_potion_2' }),
      Object.freeze({ kind: 'scroll', weight: 25, sub: 'tc_scroll' }),
    ]),
  }),
  Object.freeze({
    id: 'tc_caster_3',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 525 }),
      Object.freeze({ kind: 'gold', weight: 214 }),
      Object.freeze({ kind: 'item', weight: 176 }),
      Object.freeze({ kind: 'potion', weight: 57, sub: 'tc_potion_3' }),
      Object.freeze({ kind: 'scroll', weight: 28, sub: 'tc_scroll' }),
    ]),
  }),
  Object.freeze({
    id: 'tc_caster_4',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 495 }),
      Object.freeze({ kind: 'gold', weight: 215 }),
      Object.freeze({ kind: 'item', weight: 202 }),
      Object.freeze({ kind: 'potion', weight: 58, sub: 'tc_potion_4' }),
      Object.freeze({ kind: 'scroll', weight: 30, sub: 'tc_scroll' }),
    ]),
  }),

  // --- tc_heavy — Maulsmith (D-27: not `hammerfell_brute`) -----------------
  Object.freeze({
    id: 'tc_heavy_1',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 520 }),
      Object.freeze({ kind: 'gold', weight: 265 }),
      Object.freeze({ kind: 'item', weight: 165 }),
      Object.freeze({ kind: 'potion', weight: 45, sub: 'tc_potion_1' }),
      Object.freeze({ kind: 'scroll', weight: 5, sub: 'tc_scroll' }),
    ]),
  }),
  Object.freeze({
    id: 'tc_heavy_2',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 480 }),
      Object.freeze({ kind: 'gold', weight: 268 }),
      Object.freeze({ kind: 'item', weight: 197 }),
      Object.freeze({ kind: 'potion', weight: 47, sub: 'tc_potion_2' }),
      Object.freeze({ kind: 'scroll', weight: 8, sub: 'tc_scroll' }),
    ]),
  }),
  Object.freeze({
    id: 'tc_heavy_3',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 445 }),
      Object.freeze({ kind: 'gold', weight: 270 }),
      Object.freeze({ kind: 'item', weight: 226 }),
      Object.freeze({ kind: 'potion', weight: 48, sub: 'tc_potion_3' }),
      Object.freeze({ kind: 'scroll', weight: 11, sub: 'tc_scroll' }),
    ]),
  }),
  Object.freeze({
    id: 'tc_heavy_4',
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 415 }),
      Object.freeze({ kind: 'gold', weight: 271 }),
      Object.freeze({ kind: 'item', weight: 251 }),
      Object.freeze({ kind: 'potion', weight: 49, sub: 'tc_potion_4' }),
      Object.freeze({ kind: 'scroll', weight: 14, sub: 'tc_scroll' }),
    ]),
  }),

  // ---------------------------------------------------------------------
  // §5.5 — tc_boss (Molgrim). Ten fixed steps, not a weighted table — see
  // this file's header for why `script`, not `entries`.
  // ---------------------------------------------------------------------
  Object.freeze({
    id: 'tc_boss',
    script: Object.freeze([
      Object.freeze({ step: 'uniqueGuaranteed' }), // #1 first kill on this difficulty only (CharacterSave.quests.word_unquenched.flags), weighted by dropWeight, alvl <= ilvl
      Object.freeze({ step: 'item', rarityFloor: 'rare' }), // #2 guaranteed item, floor rare
      Object.freeze({ step: 'item' }), // #3
      Object.freeze({ step: 'item' }), // #4
      Object.freeze({ step: 'item' }), // #5
      Object.freeze({ step: 'item' }), // #6
      Object.freeze({ step: 'gold' }), // #7 one pile at RANK_GOLD.boss = 12.0 (ITEM-9)
      Object.freeze({ step: 'potion' }), // #8
      Object.freeze({ step: 'potion' }), // #9
      Object.freeze({ step: 'scroll', sub: 'tc_scroll_boss' }), // #10
    ]),
  }),

  // ---------------------------------------------------------------------
  // §5.6 — containers and destructibles
  // ---------------------------------------------------------------------
  Object.freeze({
    id: 'tc_urn', // urn_clay, barrel_wood, crate_wood — one pick, ilvl = zone monsterLevel, Δ = 0
    entries: Object.freeze([
      Object.freeze({ kind: 'nodrop', weight: 300 }),
      Object.freeze({ kind: 'gold', weight: 520 }), // × 0.35 pile, ITEM-9
      Object.freeze({ kind: 'potion', weight: 120 }),
      Object.freeze({ kind: 'item', weight: 60, rarityFloor: 'magic' }), // the "6% a magic base", 07-world-gen.md §9.2
    ]),
  }),
  Object.freeze({
    id: 'tc_wastes', // chest_iron (3-5 rolls) / sarcophagus (2-3 rolls) in Ashen Wastes; ilvl = zone monsterLevel + 2, Δ = 2, gold pile × 1.4
    entries: Object.freeze([
      Object.freeze({ kind: 'gold', weight: 380 }),
      Object.freeze({ kind: 'item', weight: 400 }),
      Object.freeze({ kind: 'potion', weight: 170 }),
      Object.freeze({ kind: 'scroll', weight: 50 }),
    ]),
  }),
  Object.freeze({
    id: 'tc_bonereach', // same container mechanics, Renunciation Bonereach
    entries: Object.freeze([
      Object.freeze({ kind: 'gold', weight: 340 }),
      Object.freeze({ kind: 'item', weight: 450 }),
      Object.freeze({ kind: 'potion', weight: 160 }),
      Object.freeze({ kind: 'scroll', weight: 50 }),
    ]),
  }),
  Object.freeze({
    id: 'tc_altar', // same container mechanics, Altar of Instruction
    entries: Object.freeze([
      Object.freeze({ kind: 'gold', weight: 300 }),
      Object.freeze({ kind: 'item', weight: 520 }),
      Object.freeze({ kind: 'potion', weight: 130 }),
      Object.freeze({ kind: 'scroll', weight: 50 }),
    ]),
  }),

  // ---------------------------------------------------------------------
  // §5.7 — sub-tables. `entries[].id` is a literal `ItemBase.id`
  // (`src/items/data/bases.js`, ITEM-1), not a `kind` tag.
  // ---------------------------------------------------------------------
  Object.freeze({
    id: 'tc_potion_1',
    entries: Object.freeze([
      Object.freeze({ id: 'potion_life_minor', weight: 460 }),
      Object.freeze({ id: 'potion_life_lesser', weight: 70 }),
      Object.freeze({ id: 'potion_life_greater', weight: 0 }),
      Object.freeze({ id: 'potion_life_grand', weight: 0 }),
      Object.freeze({ id: 'potion_mana_minor', weight: 390 }),
      Object.freeze({ id: 'potion_mana_lesser', weight: 60 }),
      Object.freeze({ id: 'potion_mana_greater', weight: 0 }),
      Object.freeze({ id: 'potion_mana_grand', weight: 0 }),
      Object.freeze({ id: 'potion_rejuvenation', weight: 20 }),
    ]),
  }),
  Object.freeze({
    id: 'tc_potion_2',
    entries: Object.freeze([
      Object.freeze({ id: 'potion_life_minor', weight: 250 }),
      Object.freeze({ id: 'potion_life_lesser', weight: 300 }),
      Object.freeze({ id: 'potion_life_greater', weight: 60 }),
      Object.freeze({ id: 'potion_life_grand', weight: 0 }),
      Object.freeze({ id: 'potion_mana_minor', weight: 200 }),
      Object.freeze({ id: 'potion_mana_lesser', weight: 140 }),
      Object.freeze({ id: 'potion_mana_greater', weight: 30 }),
      Object.freeze({ id: 'potion_mana_grand', weight: 0 }),
      Object.freeze({ id: 'potion_rejuvenation', weight: 20 }),
    ]),
  }),
  Object.freeze({
    id: 'tc_potion_3',
    entries: Object.freeze([
      Object.freeze({ id: 'potion_life_minor', weight: 0 }),
      Object.freeze({ id: 'potion_life_lesser', weight: 200 }),
      Object.freeze({ id: 'potion_life_greater', weight: 300 }),
      Object.freeze({ id: 'potion_life_grand', weight: 60 }),
      Object.freeze({ id: 'potion_mana_minor', weight: 0 }),
      Object.freeze({ id: 'potion_mana_lesser', weight: 160 }),
      Object.freeze({ id: 'potion_mana_greater', weight: 200 }),
      Object.freeze({ id: 'potion_mana_grand', weight: 40 }),
      Object.freeze({ id: 'potion_rejuvenation', weight: 40 }),
    ]),
  }),
  Object.freeze({
    id: 'tc_potion_4',
    entries: Object.freeze([
      Object.freeze({ id: 'potion_life_minor', weight: 0 }),
      Object.freeze({ id: 'potion_life_lesser', weight: 0 }),
      Object.freeze({ id: 'potion_life_greater', weight: 260 }),
      Object.freeze({ id: 'potion_life_grand', weight: 300 }),
      Object.freeze({ id: 'potion_mana_minor', weight: 0 }),
      Object.freeze({ id: 'potion_mana_lesser', weight: 0 }),
      Object.freeze({ id: 'potion_mana_greater', weight: 190 }),
      Object.freeze({ id: 'potion_mana_grand', weight: 200 }),
      Object.freeze({ id: 'potion_rejuvenation', weight: 50 }),
    ]),
  }),
  Object.freeze({
    id: 'tc_scroll', // everything except the boss
    entries: Object.freeze([
      Object.freeze({ id: 'scroll_identify', weight: 760 }),
      Object.freeze({ id: 'scroll_portal', weight: 240 }),
    ]),
  }),
  Object.freeze({
    id: 'tc_scroll_boss', // §5.5 step 10
    entries: Object.freeze([
      Object.freeze({ id: 'scroll_identify', weight: 500 }),
      Object.freeze({ id: 'scroll_portal', weight: 300 }),
      Object.freeze({ id: 'scroll_respec', weight: 200 }),
    ]),
  }),
]);

/** Built once, at module load, as a plain `Object.create(null)` map — same
 * measured-cost rule as `ITEM_BASES_BY_ID` / `AFFIXES_BY_ID`: `Map` leaks on
 * never-repeating keys and this is a one-time load-time index, never rebuilt
 * per read. */
export const TREASURE_CLASSES_BY_ID = (() => {
  const map = Object.create(null);
  for (const tc of TREASURE_CLASSES) {
    map[tc.id] = tc;
  }
  return Object.freeze(map);
})();
