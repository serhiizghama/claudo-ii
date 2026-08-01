// src/items/drop.js
//
// ITEM-9 — `rollDrop` end to end: `04-items.md` §9.3 steps 1-2 (D1/D2/D14/D15),
// composed on top of `rollItem` (ITEM-5/6/7/8, steps 3-11, already landed in
// `./roll.js`). This file also ships the two sibling public methods
// `02-api-contracts.md` §11 lists next to `rollDrop` — `rollGold` (§7.1) and
// `rollChest` (§5.6) — since both are needed to call `rollDrop` at all
// (`rollGold` is `rollDrop`'s own D2 formula) or to finish the container
// picture `rollDrop` starts (`rollChest`).
//
// ---------------------------------------------------------------------------
// D-19 / D-64 / D-68 — the signature and the shape this file implements
// ---------------------------------------------------------------------------
// `02-api-contracts.md:958` is stale (`rollDrop(tc, ilvl, magicFind, rng) =>
// ItemInstance | null`, four params, single-item return). PROGRESS O-64/O-68
// rule `04:1913`'s seven-parameter form normative:
//   rollDrop(tc, mlvl, rank, ilvl, difficulty, magicFind, rng)
// and note the return type cannot be `ItemInstance | null` either: `PICKS
// [rank]` (§5.4) runs up to 4 picks per call, each of which can itself be an
// item, a gold pile, a potion or a scroll, so one call can produce several
// items *and* gold at once. This file returns
//   { items: ItemInstance[], gold: number }
// — `items` holds every non-gold drop (equipment, potions, scrolls, the
// unique-rank guarantee's extra item), `gold` is the SUM of every gold pile
// this call produced (a champion-rank kill can roll 'gold' on more than one
// of its two picks). See this ticket's report for the exact row text
// proposed for `02-api-contracts.md:958`, which the orchestrator writes.
//
// ---------------------------------------------------------------------------
// D-19 — no recursive treasure-class descent, `nodrop` is one entry of many
// ---------------------------------------------------------------------------
// `resolveTC` (`./data/treasure.js`, ITEM-3) is a zero-draw band-suffix
// lookup, not a recursive weighted pick — called once per `rollDrop`/
// `rollChest` call, not once per pick. `nodrop` is drawn by the SAME D1 pick
// as `gold`/`item`/`potion`/`scroll` (`pickTcEntry` below), never a separate
// always-taken draw.
//
// ---------------------------------------------------------------------------
// The one place `02` overrides `04`: ground scatter is TAKEN AND DISCARDED
// ---------------------------------------------------------------------------
// `04:1881` states the general rule for this whole spec: "a draw that is
// skipped is not consumed." `02-api-contracts.md` (L1481-1483, the stale
// twelve-row table) says the opposite for D15 specifically: the two scatter
// draws are taken whether or not the item actually reaches the floor. This
// ticket's brief rules `02` wins HERE ONLY — it is the only reading under
// which a lootsim histogram over many calls is independent of what the
// caller does with the result afterwards (equip it directly, sell it,
// discard it — none of that is known at roll time, and none of it may
// change the draw sequence). Implemented explicitly below (see
// `DISCARD_D15` and its two call sites) — do not "optimise" this away; the
// two `rng.next()` calls are deliberately unused.
//
// ---------------------------------------------------------------------------
// The `goldFind` gap (04 §7.1 vs the 7-parameter signature) — a judgment call
// ---------------------------------------------------------------------------
// §7.1's gold formula has a `goldFind` term, a stat distinct from
// `magicFind` (`01-data-model.md` lists both, separately, on `StatBlock`).
// `rollDrop`'s seven parameters (mandated verbatim above) have no `goldFind`
// slot, and this is true of BOTH `02`'s stale four-parameter row and `04`
// §9.3's seven-parameter row — it is not something O-64/O-68 flags as an
// omission the way `mlvl`/`rank`/`difficulty` are, so it reads as deliberate,
// not dropped. This file's decision: `rollDrop`'s own gold branch rolls with
// `goldFind = 0` (a legal, well-defined special case of the same formula,
// exactly analogous to how `rollDrop` also has no `killPoint` and so cannot
// place the ground scatter it dutifully still *draws* for). The full,
// correct formula — the real `goldFind` stat included — is `rollGold` below,
// exported and attached exactly as `02-api-contracts.md §11` contracts it,
// for whichever caller (`ai`, most likely) holds the killing actor's real
// `goldFind` and wants to scale a pile after the fact. Flagged for the
// orchestrator: if full §7.1 fidelity inside `rollDrop` itself is wanted,
// `02:958`'s row needs an eighth parameter, `goldFind`, added on top of the
// seven this ticket implements.
//
// ---------------------------------------------------------------------------
// Container ranks — five keys, two different entry points (O-65)
// ---------------------------------------------------------------------------
// `./quality.js` (ITEM-4) already ships all five container rank keys
// (`chest`/`sarcophagus`/`urn`/`barrel`/`crate`) beside the three monster
// ranks `rollQuality` needs. `04` §5.6 draws the RNG-source line between them:
// `urn_clay`/`barrel_wood`/`crate_wood` are "one pick" off the ordinary
// `items` stream (no special seeding mentioned) — so `rollDrop` itself
// supports `rank` in `{normal, minion, champion, unique, urn, barrel,
// crate}`, each with its own `PICKS`/`NODROP_SCALE` entry (containers: 1 pick,
// unscaled — §5.6's tables print the final nodrop weight directly, with no
// rank multiplier mentioned, unlike §5.4's monster ranks). `chest_iron`/
// `sarcophagus`, by contrast, are explicitly rolled "with the seed world
// hands it, not with the live items stream" and carry a variable roll count
// (3-5 / 2-3) `04` never fixes as a constant — both properties are exactly
// why `02-api-contracts.md` gives them their OWN entry point, `rollChest`,
// which takes an explicit `Rng` and an explicit roll count instead of
// `PICKS[rank]`. `rank` is still `'chest'`/`'sarcophagus'` inside
// `rollChest` (so `rollQuality`'s and `RANK_GOLD`'s five-container-key
// tables both still apply) — `rollDrop`'s own picks loop simply never
// reaches those two ranks, since `PICKS` has no entry for them; calling
// `rollDrop(..., 'chest', ...)` throws, by design, pointing at `rollChest`.
//
// `tc_boss` (§5.5) is a fixed ten-step SCRIPT, not a weighted `entries`
// table (`./data/treasure.js`'s own header: "a boss row summed into the
// every-class-sums-to-1000 check ... would be a false failure"), and its
// first two steps (guaranteed unique on first kill, guaranteed rare) need
// `CharacterSave.quests.word_unquenched.flags` — state this file has no
// access to and this ticket's file allowlist does not cover.
// `rollDrop('tc_boss', ...)` therefore still throws (no `.entries` to pick
// from) rather than silently doing the wrong thing, and the thrown message
// names `tc_boss` (the treasure-class id), never the rank — see the two
// separate guards in `rollDrop` below. Noted for whichever ticket wires
// Molgrim's own drop — not this one.
//
// ---------------------------------------------------------------------------
// Round 2 correction: rank `'boss'` is NOT the same axis as `tc_boss`
// ---------------------------------------------------------------------------
// `tc_boss` (above) is a treasure-class ID — Molgrim's one-off scripted
// drop. Rank `'boss'` is an ORDINARY rank modifier, exactly like `'normal'`/
// `'champion'`/`'unique'`, applied to an ORDINARY resolved treasure class
// (e.g. `tc_humanoid_3`) — `04` §10.1's `boss` lootsim profile runs "mlvl
// 27, rank mix 100% boss" against the live bestiary specifically "to
// isolate §4.5c" (the boss-rank rarity ladder `./quality.js`'s
// `QUALITY_RANK.boss` already ships). These are two different things that
// happen to share the English word "boss", and round 1 of this ticket
// conflated them: `PICKS`/`NODROP_SCALE` below had no `boss` row at all, so
// `rollDrop(anyOrdinaryTc, ..., 'boss', ...)` threw — which also made it
// impossible to ever reach `rollDrop('tc_boss', ...)`'s OWN, separate,
// still-intentional refusal, since the rank check ran first and rejected
// every `'boss'`-rank call before the treasure class was even looked at.
//
// The fix reads the numbers off the spec rather than inventing them: §5.4's
// own table prints `boss | — | — | §5.5` — not "not applicable", but "see
// §5.5 for the real values" — and §5.5 states, in its own words, "No
// `nodrop`, no weights" plus "4 × item ... full boss-rank ladder (§4.5c)"
// for its four ordinary item-pick steps. That fixes both constants for the
// ordinary-TC path:
//   PICKS.boss        = 4  (four item-shaped picks, mirroring §5.5's 4-6 range)
//   NODROP_SCALE.boss = 0  (no nodrop possible at all — "No nodrop" is not a
//                           99.99%-scaled-down nodrop, it is a hard zero)
// `NODROP_SCALE.boss = 0` also means `computeNodropWeight` returns `0` for
// any ordinary TC's nodrop row at boss rank, so `pickTcEntry`'s two-pass
// scan simply never selects it (a zero-weight entry is structurally
// unreachable, same guarantee `Rng.weighted`'s own docstring gives).
// §5.5's ENTRY-SPECIFIC content — the guaranteed unique (first kill on this
// difficulty only) and the guaranteed rare floor on step 2 — remains
// entirely out of scope here: those need
// `CharacterSave.quests.word_unquenched.flags`, and belong to whoever
// implements Molgrim's own drop, not to this generic rank modifier. Calling
// `rollDrop(anyOrdinaryTc, ..., 'boss', ...)` runs the SAME generic picks
// loop every other rank runs — no guarantee, no quest-flag read — it is
// only `PICKS`/`NODROP_SCALE` that change.
//
// ---------------------------------------------------------------------------
// `rollChest`'s `chest` object shape — PROVISIONAL, flagged
// ---------------------------------------------------------------------------
// `04` §5.6's own text ("`ilvl = zone monsterLevel + 2`", "3-5 rolls") is the
// only source this ticket is authorised to read for `rollChest` — the actual
// generation-time shape of a chest record lives in `07-world-gen.md` §9.2,
// outside this ticket's assigned reading range. `chest` below is inferred
// from `04` §5.6 alone: `{ tc, mlvl, ilvl, rank, rolls, difficulty?,
// magicFind?, goldFind? }`. No acceptance clause of this ticket exercises
// `rollChest`; ITEM-10 (containers) is the ticket that will actually wire a
// real chest into this call and is the one that should confirm or correct
// this shape. Gold from a chest cannot be expressed through `out`
// (`ItemInstance[]`, per `02-api-contracts.md:964`'s own signature) — this
// file surfaces it as `out.gold` (a plain extra property on the returned
// array, which is a plain object; documented at the call site below), not
// invented as a fake `ItemInstance`.
//
// ---------------------------------------------------------------------------
// Zero allocation on the pick-selection scans (rule 5 of this ticket's brief)
// ---------------------------------------------------------------------------
// `pickTcEntry` (D1) and `pickSubEntryId` (D14) are both hand-rolled
// two-pass scans over the treasure-class's own frozen `entries` array —
// never `rng.weighted(entries)` and never a `.map()`/`.filter()`-built
// substitute array. The reason is specific to D1, not general caution: the
// nodrop entry's weight must be substituted (`04` §5.4's
// `nodropWeight = round(tc.nodrop * NODROP_SCALE[rank])`) on every pick, and
// the `entries` array is `Object.freeze`n — the naive way to "substitute" a
// value on a frozen record is to build a modified copy, which allocates on
// every single pick. The two-pass scan below instead computes the
// nodrop-substituted total and, on the second pass, the nodrop-substituted
// per-entry weight, inline, over the ORIGINAL frozen array — zero
// allocation, matching `./roll.js`'s own `rollBaseGroup`/`rollBaseInGroup`/
// `pickAffix` precedent for exactly this shape.

import { TREASURE_CLASSES_BY_ID, resolveTC } from './data/treasure.js';
import { ITEM_BASES_BY_ID } from './data/bases.js';
import { rollItem } from './roll.js';

// ---------------------------------------------------------------------------
// §5.4 — picks and the nodrop scale. Container ranks (`urn`/`barrel`/
// `crate`) added per the O-65/§5.6 reasoning above: one pick, unscaled.
// `boss` (round 2 correction — see the header's "Round 2 correction"
// section): §5.4's own table reads `boss | — | — | §5.5`, deferring to
// §5.5's "No nodrop, no weights" and its four `4 × item` steps — so
// PICKS.boss = 4, NODROP_SCALE.boss = 0. This is the ORDINARY-rank axis
// (an ordinary resolved TC rolled at boss rank, `04` §10.1's `boss` lootsim
// profile), never `tc_boss` the treasure-class script — that is a
// completely separate refusal, on `tc`, not on `rank` (see `rollDrop`'s own
// two guards below). `chest`/`sarcophagus` remain deliberately absent —
// see header (`rollChest`'s own, variable, externally-decided roll count).
// ---------------------------------------------------------------------------
const PICKS = Object.freeze({
  normal: 1,
  minion: 1,
  champion: 2,
  unique: 4,
  boss: 4,
  urn: 1,
  barrel: 1,
  crate: 1,
});

const NODROP_SCALE = Object.freeze({
  normal: 1.0,
  minion: 0.85,
  champion: 0.55,
  unique: 0.3,
  boss: 0.0,
  urn: 1.0,
  barrel: 1.0,
  crate: 1.0,
});

/**
 * `04` §7.1's `RANK_GOLD` and `CONTAINER_MULT`, pre-combined into one table
 * keyed by `rank` — the same shape `./quality.js`'s own `QUALITY_RANK`
 * already uses for the same five container keys ("both members of each pair
 * share one row's numbers verbatim, so both keys are listed rather than
 * aliased"). Safe to combine because the two axes are mutually exclusive by
 * construction: a call is either a monster-kill pick (`rank` one of
 * `normal`/`minion`/`champion`/`unique`/`boss`) XOR a container pick (`rank`
 * one of `chest`/`sarcophagus`/`urn`/`barrel`/`crate`) — no call is ever
 * both at once, so there is no case this table double-applies a multiplier.
 * `boss` (12.0, §5.5 step 7) is included for whichever ticket implements
 * `tc_boss`'s script and wants `rollGold` directly; `rollDrop`'s own picks
 * loop never reaches `rank === 'boss'` (see header).
 */
const RANK_GOLD = Object.freeze({
  normal: 1.0,
  minion: 1.0,
  champion: 2.2,
  unique: 4.0,
  boss: 12.0,
  chest: 1.4,
  sarcophagus: 1.4,
  urn: 0.35,
  barrel: 0.35,
  crate: 0.35,
});

/** Rarity ordinal, local to this file (`./roll.js`'s own `RARITY_ORDER` is
 * not exported) — only needed here for the unique-rank guarantee's "did any
 * pick already produce an equipment item of magic or better" check (§5.4). */
const RARITY_RANK = Object.freeze({ normal: 0, superior: 1, magic: 2, rare: 3, unique: 4 });

// ---------------------------------------------------------------------------
// uid — `rollItem`'s own header: "whichever ticket owns the counter
// (rollDrop/ITEM-9, most likely, since it is the only caller that loops)
// increments it and passes the next value in." `ItemsSystem` cannot gain an
// instance field from this ticket's file allowlist (`src/items/index.js` is
// re-export/wiring only, same constraint ITEM-5/7/8 were already held to),
// so this is module-level state, the same shape `./roll.js`'s
// `uniquePoolSource` and `./names.js`'s rare-name ring already use for an
// equivalent problem. `uid` must be unique WITHIN A SAVE FILE
// (`01-data-model.md` §5.3) — unlike the rare-name ring, it is never reset
// on `zone:enter`; `resetUidCounter` exists only for test isolation (a fresh
// counter per test file/run), the same role `resetRareRing` already plays
// in `tests/items/roll.test.js`.
// ---------------------------------------------------------------------------
let _nextUid = 1;

/** Test-only reset (see block above). Not part of the gameplay surface —
 * deliberately not attached to `ItemsSystem`, matching `setUniquePoolSource`'s
 * own "exported for tests, not for gameplay" precedent.
 * @param {number} [start] */
export function resetUidCounter(start = 1) {
  _nextUid = start;
}

function nextUid() {
  return _nextUid++;
}

/** `04` §7.1: `goldBase(mlvl) = 4 + 2.40*mlvl + 0.12*mlvl^2`. Pure, no draw. */
function goldBaseAt(mlvl) {
  return 4 + 2.4 * mlvl + 0.12 * mlvl * mlvl;
}

/** The `entries` row with `kind === 'nodrop'`, or `undefined` if the class
 * has none (every container class in §5.6 except `tc_urn`). Linear scan over
 * a small (<= 5), fixed-order, already-frozen array — no allocation. */
function findNodropEntry(entries) {
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].kind === 'nodrop') return entries[i];
  }
  return undefined;
}

/** `04` §5.4 step 1's `nodrop = round(tc.nodrop * NODROP_SCALE[rank])`,
 * generalised over `scale` so both `rollDrop` (rank-scaled) and `rollChest`
 * (unscaled, §5.6's tables print the final weight directly) share one
 * function. `0` when the class has no `nodrop` row at all — harmless, since
 * `pickTcEntry` below only ever substitutes this value into an entry whose
 * `kind === 'nodrop'`, which does not exist on those classes either.
 * @param {object[]} entries
 * @param {number} scale
 * @returns {number}
 */
function computeNodropWeight(entries, scale) {
  const e = findNodropEntry(entries);
  return e ? Math.round(e.weight * scale) : 0;
}

/**
 * D1 — `W(tc.entries with nodrop replaced)`. Two-pass, zero-allocation scan
 * over the class's own frozen `entries` array (see file header for why this
 * is not `rng.weighted(entries)`). Exactly one draw.
 * @param {object[]} entries - a `TreasureClass.entries` array.
 * @param {number} nodropWeight - the already rank-scaled nodrop weight
 *   (`computeNodropWeight`'s result), substituted for whichever entry has
 *   `kind === 'nodrop'`, if any.
 * @param {import('../core/rng.js').Rng} rng
 * @returns {object} the picked `entries` row.
 */
function pickTcEntry(entries, nodropWeight, rng) {
  let total = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    total += e.kind === 'nodrop' ? nodropWeight : e.weight;
  }
  if (total <= 0) {
    throw new RangeError('pickTcEntry: total weight must be > 0 (every entry weighted 0)');
  }
  let r = rng.next() * total; // D1
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const w = e.kind === 'nodrop' ? nodropWeight : e.weight;
    r -= w;
    if (r < 0) return e;
  }
  // Floating-point rounding at the very top of the range — same fallback
  // shape `./roll.js`'s own weighted scans use: the last entry with a
  // positive effective weight is the correct pick.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const w = e.kind === 'nodrop' ? nodropWeight : e.weight;
    if (w > 0) return e;
  }
  throw new RangeError('pickTcEntry: unreachable — total > 0 but no entry matched');
}

/**
 * D14 — `W(tc_potion_<band>)` or `W(tc_scroll)`. Same two-pass,
 * zero-allocation shape, over a sub-table's `{id, weight}` rows. Exactly one
 * draw.
 * @param {object[]} entries - a sub-table's `entries` array (`./data/
 *   treasure.js`'s `tc_potion_<n>`/`tc_scroll`/`tc_scroll_boss` shape).
 * @param {import('../core/rng.js').Rng} rng
 * @returns {string} an `ItemBase.id`.
 */
function pickSubEntryId(entries, rng) {
  let total = 0;
  for (let i = 0; i < entries.length; i++) total += entries[i].weight;
  if (total <= 0) {
    throw new RangeError('pickSubEntryId: total weight must be > 0 (every entry weighted 0)');
  }
  let r = rng.next() * total; // D14
  for (let i = 0; i < entries.length; i++) {
    r -= entries[i].weight;
    if (r < 0) return entries[i].id;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].weight > 0) return entries[i].id;
  }
  throw new RangeError('pickSubEntryId: unreachable — total > 0 but no entry matched');
}

/**
 * The potion/scroll leaf of §9.3 step 2: `emit createItem(base, { quantity:
 * 1 })`. `createItem` itself (`02-api-contracts.md`'s own row) is not this
 * ticket's to build as a public method — this is a local, minimal
 * equivalent shaped exactly like `rollItem`'s own step-5 literal
 * (`01-data-model.md` §5.3), with no rarity ladder (consumables have none):
 * `rarity: 'normal'`, always identified, no affixes, no durability loss
 * (`base.maxDurability` is `0` for every consumable, per `./data/bases.js`).
 * @param {object} base - an `ItemBase` record (a potion or scroll).
 * @param {number} uid
 * @param {number} ilvl
 * @returns {object} an `ItemInstance`.
 */
function createConsumable(base, uid, ilvl) {
  return {
    uid,
    baseId: base.id,
    rarity: 'normal',
    ilvl,
    identified: true,
    quantity: 1,
    rolls: { defense: 0, superior: 0, damageMin: 0, damageMax: 0 },
    affixes: [],
    uniqueId: null,
    uniqueValues: [],
    nameOverride: null,
    durability: base.maxDurability,
    maxDurability: base.maxDurability,
    sockets: [],
    socketCount: 0,
  };
}

/**
 * One pick's worth of §9.3 step 2 (D1, then whichever of D2/D14/steps 3-11
 * its `entry.kind` calls for). Shared by `rollDrop`'s own picks loop and
 * `rollChest` — the only two callers, since both are "loop over N picks
 * against one treasure class" with different pick counts and (for
 * `rollChest`) a different `Rng` source, not different per-pick logic.
 * Ground scatter (D15) is deliberately NOT drawn in here — see the two call
 * sites in `rollDrop`/`rollChest` for why it is drawn once, in the caller,
 * right after this returns non-`'nodrop'`.
 * @returns {{entryKind: 'nodrop'|'gold'|'item'|'potion'|'scroll', item?: object, gold?: number}}
 */
function performPick(tcEntries, nodropWeight, ilvl, mlvl, rank, difficulty, magicFind, goldFind, rng) {
  const entry = pickTcEntry(tcEntries, nodropWeight, rng); // D1
  if (entry.kind === 'nodrop') return { entryKind: 'nodrop' };

  if (entry.kind === 'gold') {
    const gold = rollGold(mlvl, rank, goldFind, rng); // D2, inside rollGold
    return { entryKind: 'gold', gold };
  }

  if (entry.kind === 'potion' || entry.kind === 'scroll') {
    // Ruling 3 (this ticket's brief): tc_urn/the chest classes carry no
    // `sub` — the band is computed here, at roll time, from `ilvl`, never
    // stored on the record. Every monster-table row DOES carry `sub`
    // already band-bound to itself.
    const subId = entry.sub || (entry.kind === 'potion' ? resolveTC('tc_potion', ilvl) : 'tc_scroll');
    const subRec = TREASURE_CLASSES_BY_ID[subId];
    if (!subRec) throw new RangeError(`rollDrop: unknown sub-table '${subId}'`);
    const baseId = pickSubEntryId(subRec.entries, rng); // D14
    const base = ITEM_BASES_BY_ID[baseId];
    if (!base) throw new RangeError(`rollDrop: unknown base '${baseId}' in sub-table '${subId}'`);
    return { entryKind: entry.kind, item: createConsumable(base, nextUid(), ilvl) };
  }

  // entry.kind === 'item' — §9.3 steps 3-11, already `rollItem`'s job.
  const item = rollItem(nextUid(), ilvl, mlvl, rank, difficulty, magicFind, entry.rarityFloor || null, rng);
  return { entryKind: 'item', item };
}

/**
 * `02-api-contracts.md` §11: `rollGold(mlvl, rank, goldFind, rng) => int`.
 * `04` §7.1, verbatim: `goldBase(mlvl) * RANK_GOLD[rank] * (1 + goldFind/100)
 * * U(0.75,1.25)`, rounded, floored at 1. `CONTAINER_MULT` is folded into
 * `RANK_GOLD` above (see that table's own comment) — passing a container
 * rank here (`'chest'`/`'urn'`/etc.) already applies it. Exactly one draw
 * (D2).
 * @param {number} mlvl
 * @param {string} rank - a `RANK_GOLD` key.
 * @param {number} goldFind
 * @param {import('../core/rng.js').Rng} rng
 * @returns {number}
 */
export function rollGold(mlvl, rank, goldFind, rng) {
  const rankMul = RANK_GOLD[rank];
  if (rankMul === undefined) {
    throw new RangeError(`rollGold: unknown rank '${rank}'`);
  }
  const variance = 0.75 + rng.next() * 0.5; // D2 — U(0.75, 1.25)
  const pile = Math.round(goldBaseAt(mlvl) * rankMul * (1 + goldFind / 100) * variance);
  return pile > 1 ? pile : 1;
}

/**
 * `04-items.md` §9.3, steps 1-2 — `rollDrop`. See this file's header for the
 * seven-parameter signature (O-64/O-68), the `{ items, gold }` return shape,
 * the `goldFind = 0` decision, and which ranks this loop supports.
 *
 * @param {string} tc - a treasure-class family or single-class id
 *   (`resolveTC`'s own `family` argument).
 * @param {number} mlvl - the killing monster's level; selects the band
 *   (`resolveTC`) and feeds `04` §4.1's Δ term via `rollItem`.
 * @param {string} rank - `PICKS`/`NODROP_SCALE`/`RANK_GOLD`/`QUALITY_RANK`
 *   key: one of `normal`/`minion`/`champion`/`unique`/`boss` (monster kills —
 *   `boss` here is the ORDINARY rank modifier against an ordinary `tc`, `04`
 *   §10.1's lootsim profile, NOT Molgrim's `tc_boss` script) or `urn`/
 *   `barrel`/`crate` (one-pick destructibles, §5.6). `chest`/`sarcophagus`
 *   go through `rollChest`, not here (variable roll count, external `Rng`).
 *   Calling this with `tc === 'tc_boss'` still throws regardless of `rank`
 *   — that refusal is on the treasure-class id, not on the rank.
 * @param {number} ilvl - the item level to roll at (already includes any
 *   caller-side Δ, e.g. `mlvl + 2` for a chest — `rollDrop` itself applies
 *   none).
 * @param {'instruction'|'trial'|'renunciation'} difficulty
 * @param {number} magicFind
 * @param {import('../core/rng.js').Rng} rng - the `items` fork.
 * @returns {{items: object[], gold: number}}
 */
export function rollDrop(tc, mlvl, rank, ilvl, difficulty, magicFind, rng) {
  const picks = PICKS[rank];
  if (picks === undefined) {
    throw new RangeError(
      `rollDrop: rank '${rank}' has no PICKS entry (§5.4: normal/minion/champion/unique/boss; ` +
        `'chest'/'sarcophagus' roll through rollChest, which takes a variable roll count and ` +
        `an external Rng — rank 'boss' IS supported here, against an ordinary treasure class; ` +
        `it is 'tc_boss' the treasure-class id that is refused separately, below)`,
    );
  }
  const tcId = resolveTC(tc, mlvl);
  const tcRec = TREASURE_CLASSES_BY_ID[tcId];
  if (!tcRec || !tcRec.entries) {
    // This is the OTHER axis (see header's "Round 2 correction"): `tc_boss`
    // the treasure-class id, Molgrim's own fixed §5.5 script, refused by
    // NAME here — never confused with rank 'boss', which is an ordinary
    // rank modifier the PICKS/NODROP_SCALE tables above already handle.
    throw new RangeError(`rollDrop: '${tcId}' has no 'entries' table (tc_boss is a §5.5 script, not supported here)`);
  }
  const scale = NODROP_SCALE[rank] !== undefined ? NODROP_SCALE[rank] : 1;
  const nodropWeight = computeNodropWeight(tcRec.entries, scale);

  const items = [];
  let gold = 0;
  let gotMagicOrBetterItem = false;

  for (let i = 0; i < picks; i++) {
    const result = performPick(tcRec.entries, nodropWeight, ilvl, mlvl, rank, difficulty, magicFind, 0, rng);
    // 04:1881: a nodrop pick produced nothing, so scatter has no subject to
    // place — the take-and-discard rule below exists to make the histogram
    // independent of whether a PRODUCED item lands on the floor, which is
    // not the question here (nothing was produced at all). D15 not drawn.
    if (result.entryKind === 'nodrop') continue;

    // D15 — ground scatter, TAKEN AND DISCARDED. `02` (L1481-1483) overrides
    // `04:1881` here ONLY (see file header): every item/potion/scroll/gold
    // pile that reaches this point draws its angle and radius seed
    // regardless of what the caller does with the result. `rollDrop` has no
    // `killPoint` (that is `world`'s, at placement time — ITEM-12) so there
    // is nothing useful to do with either value here; they are read and
    // thrown away on purpose. Do not delete these two lines as "dead code."
    rng.next(); // D15a — U(0, 2*PI), discarded
    rng.next(); // D15b — U(0, 1), discarded

    if (result.entryKind === 'gold') {
      gold += result.gold;
      continue;
    }
    items.push(result.item);
    if (result.entryKind === 'item' && RARITY_RANK[result.item.rarity] >= RARITY_RANK.magic) {
      gotMagicOrBetterItem = true;
    }
  }

  // §5.4 — the unique-rank guarantee, applied AFTER the picks loop above.
  // No D1: this is "one extra item pick", not a treasure-class entry draw.
  if (rank === 'unique' && !gotMagicOrBetterItem) {
    const extra = rollItem(nextUid(), ilvl, mlvl, rank, difficulty, magicFind, 'magic', rng);
    rng.next(); // D15a, discarded — the guaranteed item reaches the floor too
    rng.next(); // D15b, discarded
    items.push(extra);
  }

  return { items, gold };
}

/**
 * `02-api-contracts.md` §11: `rollChest(chest, rng, out) => int`. See this
 * file's header for the provisional `chest` shape and the gold side-channel
 * (`out.gold`). Pushes every non-gold drop (equipment, potion, scroll) into
 * `out` in pick order and returns the count pushed.
 * @param {{tc: string, mlvl: number, ilvl: number, rank: string, rolls: number,
 *   difficulty?: string, magicFind?: number, goldFind?: number}} chest
 * @param {import('../core/rng.js').Rng} rng - the chest's own `S4`
 *   sub-seed, per `04:1206` — NOT the `items` stream.
 * @param {object[]} out - `ItemInstance[]`, appended to; also gains a
 *   `.gold` property (see header) with the summed gold this call rolled.
 * @returns {number} the count of entries appended to `out`.
 */
export function rollChest(chest, rng, out) {
  if (!chest || typeof chest !== 'object') {
    throw new TypeError('rollChest: chest must be an object');
  }
  const { tc, mlvl, ilvl, rank, rolls, difficulty = 'instruction', magicFind = 0, goldFind = 0 } = chest;
  if (!Number.isInteger(rolls) || rolls < 0) {
    throw new RangeError(`rollChest: chest.rolls must be a non-negative integer, got ${rolls}`);
  }
  const tcId = resolveTC(tc, mlvl);
  const tcRec = TREASURE_CLASSES_BY_ID[tcId];
  if (!tcRec || !tcRec.entries) {
    throw new RangeError(`rollChest: '${tcId}' has no 'entries' table`);
  }
  // §5.6: no rank-based nodrop scale for containers — the printed tables
  // (tc_urn's 300, tc_wastes/tc_bonereach/tc_altar with no nodrop row at
  // all) are already the final weight.
  const nodropWeight = computeNodropWeight(tcRec.entries, 1);

  let count = 0;
  let goldTotal = 0;
  for (let i = 0; i < rolls; i++) {
    const result = performPick(tcRec.entries, nodropWeight, ilvl, mlvl, rank, difficulty, magicFind, goldFind, rng);
    if (result.entryKind === 'nodrop') continue;

    rng.next(); // D15a, discarded — see rollDrop's own comment on why
    rng.next(); // D15b, discarded

    if (result.entryKind === 'gold') {
      goldTotal += result.gold;
      continue;
    }
    out.push(result.item);
    count++;
  }
  out.gold = goldTotal; // side-channel — see file header, `rollChest` section
  return count;
}
