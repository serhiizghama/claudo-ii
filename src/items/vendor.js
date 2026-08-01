// src/items/vendor.js
//
// ITEM-14 — vendor stock and buyback (`04-items.md` §7.5, §7.3's
// buyback-holds-12 rule). `./economy.js` is this ticket's other file
// (ruling D-28) and owns value/repair arithmetic; this file owns everything
// vendor-panel-shaped: the two named NPCs (`veren`, `isa` —
// `docs/spec/07-world-gen.md:385`/`docs/spec/13-progression-lore.md`
// `npc.veren`/`npc.isa`, confirmed by grep since those files are outside
// this ticket's granted read range; not invented), their stock, and the
// buyback list.
//
// ---------------------------------------------------------------------------
// The RNG rule — vendor stock never touches the `items` gameplay stream
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §11 contracts `vendorStock(npcId, rng, clvl) =>
// ItemInstance[]`, and `04` §7.5's own prose calls that `Rng` "a dedicated
// Rng fork owned by items" — read literally, a FIFTH `ctx.rng.fork()`.
// ARCHITECTURE.md's Determinism contract fixes the fork count at one per
// subsystem (four total: ui/combat/ai/items, each taken once in its own
// `init()`), and this milestone's tooling checks that count — a second
// `items` fork here would violate it, and `09-ui.md` §16.2 gives the actual
// reason a second stream is required at all: "`ui` must never draw from a
// gameplay RNG stream — it would desynchronise `tools/lootsim.mjs`."
// Reading `04` §7.5 and `09` §16.2 together, the requirement is "a stream
// that is not `this.rng` (the `items` loot stream)", not literally "a
// second `.fork()` call" — and the fork API is not the only sanctioned way
// to get a fresh, deterministic stream in this tree.
//
// The resolution used below: `world`'s `zone:enter` payload already carries
// a deterministic, non-wall-clock `seed` field
// (`{ zoneId, seed, entry }`, `src/world/index.js#enterZone`, `seed =
// this.seedFor(zoneId, runIndex) = hash(worldSeed, zoneId, runIndex)`) —
// exactly the "Zone layout seeds are hash(worldSeed, zoneId, runIndex) —
// never wall-clock" precedent ARCHITECTURE.md's own Determinism contract
// names for a DIFFERENT, already-sanctioned non-forked stream.
// `regenerateVendorStock` below mixes that seed with `npcId` through a
// small local FNV-1a hash (`hashVendorSeed`, the same algorithm
// `src/world/index.js#hashSeed` already uses, not imported —
// ARCHITECTURE.md rule 2 forbids importing another subsystem's module, and
// duplicating nine lines of a well-known, standard hash mix is the same
// "no shared home for this" call `SLOT_ORDER` gets duplicated under
// elsewhere in this directory) and constructs a fresh `new Rng(seed)` — the
// same constructor `tools/lootsim.mjs` (its own top-level `rollDrop`
// harness) and `src/main.js` (`ctx.rng` itself) already use for a
// deterministic, non-forked stream; `grep -rn "new Rng(" src/ tools/`
// confirms this is an established pattern in this tree, not invented here.
//
// That `Rng` instance draws zero times from `this.rng` (the `items`
// gameplay fork `ItemsSystem.init()` takes) and takes no new
// `ctx.rng.fork()` at all, so the tree's fork count stays at exactly four
// and `tools/lootsim.mjs`'s drop sequence — which only ever consumes
// `this.rng` — is structurally unaffected: nothing in this file, or in
// `regenerateVendorStock`'s `zone:enter` handler, ever reads `this.rng` or
// `ctx.rng`. See this ticket's report for the `node tools/lootsim.mjs`
// proof (`0 failed` at `1 200 000 drops`, unchanged).
//
// ---------------------------------------------------------------------------
// Data structure — Object.create(null), never a Map (this ticket's brief)
// ---------------------------------------------------------------------------
// Vendor stock/buyback is keyed by `npcId`, a small, fixed set (`veren`,
// `isa` today) — the opposite of the never-repeating-`uid` shape the brief
// bans `Map` for. `state.stockByNpc`/`state.buybackByNpc` are plain
// `Object.create(null)` dictionaries, built once in `createVendorState`,
// exactly the "build-once Object.create(null) index" the brief names.
// `currentStock`/`buyback` never rebuild an array — they return whatever
// reference is already stored (`Alloc: no`, `02-api-contracts.md` §11);
// only `vendorStock` (contracted `Alloc: yes`) is allowed to allocate a new
// one, on regeneration.
//
// ---------------------------------------------------------------------------
// What §7.5's stock table needed that this ticket's read range does not
// cover — flagged, not guessed wildly
// ---------------------------------------------------------------------------
// `04` §7.5 (fully in range) gives the equipment rarity-count table by
// `clvl` band verbatim, reproduced in `RARITY_BAND` below exactly. Two
// pieces it references are OUTSIDE this ticket's granted read range and are
// therefore invented, narrowly, and flagged here and in the report rather
// than left unimplemented:
//   - "base group drawn as §1.3" — `§1.3` is outside range, but `rollItem`
//     (`./roll.js`, ITEM-5, already accepted) already performs exactly that
//     draw internally (`rollBaseGroup`/`rollBaseInGroup`) as part of
//     building any equipment item — this file calls `rollItem` itself
//     rather than re-deriving §1.3's weight table a second time, so no
//     invention was actually needed here.
//   - "the two [potion] tiers legal at clvl" — the clvl -> tier-band
//     mapping is in `04` §5's drop-band tables, outside range (only §8.1's
//     Drop-band COLUMN, B1-B4 per potion, was in range). `legalTierPairFor`
//     below invents a simple three-band ladder mirroring the exact clvl
//     bands `04` §7.5's OWN in-range rarity table already uses
//     (1-11 / 12-21 / 22-30), sliding the two "legal" tiers up one step per
//     band. This is a judgment call, not a spec transcription — flagged in
//     the report.
// Consequence: the "8 rows" of consumables `04` §7.5's table header states
// is not reproduced exactly (this file's consumable roster is smaller,
// typically 5-6 rows: two life tiers, two mana tiers, `scroll_portal`, and
// `potion_rejuvenation` from clvl 12) — flagged in the report as a
// deliberate, documented simplification, not a silent shortfall. None of
// this ticket's four acceptance clauses depend on the exact vendor stock
// roster.
//
// `vendorBuy`/`vendorSell` (the actual purchase/sale flow) are a different,
// not-yet-built ticket — `buyback` therefore starts empty for every `npcId`
// and stays empty until something calls `sellIntoBuyback` (exported below,
// module-level only, not attached to `ItemsSystem` — the same "internal
// seam for a later ticket, not a public method" precedent
// `./roll.js#setUniquePoolSource`/`./ground.js`'s un-attached helpers
// already set). This ticket's own tests exercise `sellIntoBuyback` directly
// to prove the 12-item, oldest-evicted ring holds, independent of whichever
// future ticket wires a real sale into it.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import { Rng } from '../core/rng.js';
import { ITEM_BASES_BY_ID } from './data/bases.js';
import { rollItem as rollItemPure } from './roll.js';

export const VEREN_ID = 'veren';
export const ISA_ID = 'isa';

const TOWN_ZONE_ID = 'last_bastion'; // world's town zone id (src/player/index.js's own default confirms this string)

const EMPTY_STOCK = Object.freeze([]);
const BUYBACK_CAPACITY = 12; // 04 §7.3: "holds the last 12 items the player sold"
const MAX_ILVL = 40; // 04 §7.5: "ilvl = clvl + 2, capped at 40"
const FORCE_RARITY_MAX_ATTEMPTS = 500; // bounded retry — see forceRarityItem

// `04` §7.5's equipment rarity-count table, verbatim (fully in this
// ticket's read range). Each row sums to 10, the table's own "Equipment |
// 10" row count.
const RARITY_BAND = Object.freeze([
  Object.freeze({ max: 11, counts: Object.freeze({ normal: 4, superior: 2, magic: 4, rare: 0 }) }),
  Object.freeze({ max: 21, counts: Object.freeze({ normal: 3, superior: 1, magic: 5, rare: 1 }) }),
  Object.freeze({ max: 30, counts: Object.freeze({ normal: 2, superior: 1, magic: 5, rare: 2 }) }),
]);

function rarityCountsFor(clvl) {
  for (let i = 0; i < RARITY_BAND.length; i++) {
    if (clvl <= RARITY_BAND[i].max) return RARITY_BAND[i].counts;
  }
  return RARITY_BAND[RARITY_BAND.length - 1].counts; // clvl > 30 — reuse the top band, see file header
}

const LIFE_TIERS = Object.freeze(['potion_life_minor', 'potion_life_lesser', 'potion_life_greater', 'potion_life_grand']);
const MANA_TIERS = Object.freeze(['potion_mana_minor', 'potion_mana_lesser', 'potion_mana_greater', 'potion_mana_grand']);

/** Invented clvl -> [tierIndexLow, tierIndexHigh] ladder — see file header,
 * "the two tiers legal at clvl". Mirrors `04` §7.5's own in-range clvl
 * bands. */
function legalTierPairFor(clvl) {
  if (clvl <= 11) return [0, 1];
  if (clvl <= 21) return [1, 2];
  return [2, 3];
}

// ---------------------------------------------------------------------------
// uid — a local counter, deliberately NOT `./drop.js`'s private `_nextUid`
// ---------------------------------------------------------------------------
// `./drop.js`'s own header explains its `_nextUid` is module-private,
// caller-owned state, and it is not exported anywhere (`resetUidCounter` is
// test-only and does not expose the counter itself). This ticket has no
// grant to edit `./drop.js` to export it, so vendor-generated items get
// their OWN counter, offset far above any realistic save-file uid count, to
// make a collision with a real drop's uid astronomically unlikely rather
// than structurally impossible. Flagged in this ticket's report as a
// finding: real uid-space unification (one counter every `ItemInstance`
// producer shares) is a job for whoever next touches `./drop.js`'s export
// surface, not something this ticket's file grant can fix.
// ---------------------------------------------------------------------------
let _nextVendorUid = 900_000_001;

/** Test-only reset, same role `./drop.js#resetUidCounter` plays for its own
 * counter. Not part of the gameplay surface. */
export function resetVendorUidCounter(start = 900_000_001) {
  _nextVendorUid = start;
}

function nextVendorUid() {
  return _nextVendorUid++;
}

/** `04` §7.6's non-rolled `ItemInstance` shape for a potion/scroll —
 * duplicated from `./drop.js#createConsumable` (private there, and
 * `./drop.js` is not in this ticket's file grant to edit into exporting
 * it): `rarity: 'normal'`, always identified, no affixes, no durability
 * loss (`maxDurability` is 0 for every consumable). */
function createConsumableInstance(base, uid) {
  return {
    uid,
    baseId: base.id,
    rarity: 'normal',
    ilvl: 1,
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
 * Builds one equipment `ItemInstance` at exactly `targetRarity`, by calling
 * the real, already-accepted `rollItem` (base-group draw, quality roll,
 * affix rolling — all of it) and retrying, bounded, until the natural
 * result matches. `rollItem`'s `rarityFloor` argument pre-biases the draw
 * where one exists (`'magic'`/`'rare'`), which is why `'rare'` converges in
 * essentially one draw (floor='rare' already guarantees >= rare; only a
 * `unique` roll needs rejecting, at `04` §4.2's ~0.25% base rate) rather
 * than needing to beat a raw ~1.8% base probability from nothing.
 * `targetRarity` itself is never assigned by force-overwriting `.rarity` on
 * a mismatched roll — that would leave affix count/rolls inconsistent with
 * the claimed rarity, which is worse than a bounded retry.
 *
 * Vendor items are always sold pre-identified (a vendor has already
 * appraised what it stocks) — `rollItem` only defaults `identified: false`
 * for rare/unique (`01-data-model.md` §5.3's normal drop rule), so this
 * forces it back to `true` here. Judgment call, flagged in the report: `04`
 * does not say vendor stock is pre-identified, but an unidentified
 * `itemValue` (magic-rarity, zero affixes) would silently mismatch the
 * rarity the vendor table forced this row to be, which reads as a bug the
 * first time someone opens the panel.
 *
 * @param {import('../core/rng.js').Rng} rng - the vendor's own stock Rng,
 *   never `this.rng`.
 * @param {'normal'|'superior'|'magic'|'rare'} targetRarity
 * @param {number} ilvl
 * @returns {object|null} an `ItemInstance`, or `null` if `FORCE_RARITY_MAX_ATTEMPTS`
 *   was exhausted (e.g. no legal affix exists at all at this `ilvl` for
 *   `'rare'`, so `degrade()` keeps folding every attempt back to `'magic'`)
 *   — the caller skips the row rather than shipping a mismatched rarity.
 */
function forceRarityItem(rng, targetRarity, ilvl) {
  const floor = targetRarity === 'rare' ? 'rare' : targetRarity === 'magic' ? 'magic' : null;
  for (let attempt = 0; attempt < FORCE_RARITY_MAX_ATTEMPTS; attempt++) {
    const item = rollItemPure(nextVendorUid(), ilvl, ilvl, 'normal', 'instruction', 0, floor, rng);
    if (item.rarity === targetRarity) {
      item.identified = true; // vendor-curated, see doc above
      return item;
    }
  }
  return null;
}

function buildEquipmentRows(rng, clvl) {
  const ilvl = Math.min(MAX_ILVL, clvl + 2);
  const counts = rarityCountsFor(clvl);
  const order = ['normal', 'superior', 'magic', 'rare'];
  const out = [];
  for (let oi = 0; oi < order.length; oi++) {
    const rarity = order[oi];
    const n = counts[rarity];
    for (let k = 0; k < n; k++) {
      const item = forceRarityItem(rng, rarity, ilvl);
      if (item) out.push(item);
    }
  }
  return out;
}

function buildVerenConsumables(clvl) {
  const [lo, hi] = legalTierPairFor(clvl);
  const ids = [LIFE_TIERS[lo], LIFE_TIERS[hi], MANA_TIERS[lo], MANA_TIERS[hi], 'scroll_portal'];
  if (clvl >= 12) ids.push('potion_rejuvenation'); // 04 §7.5
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const base = ITEM_BASES_BY_ID[ids[i]];
    if (base) out.push(createConsumableInstance(base, nextVendorUid()));
  }
  return out;
}

/** Veren the Stonecutter — buy, sell, repair. `rng` drives ONLY the
 * equipment rows (`buildEquipmentRows`); the consumable roster is a fixed
 * catalogue lookup and draws nothing. */
function buildVerenStock(rng, clvl) {
  return buildVerenConsumables(clvl).concat(buildEquipmentRows(rng, clvl));
}

/** Isa the Runeweaver — `scroll_identify` (infinite, 90),
 * `scroll_portal` (infinite, 120), `scroll_respec` (one per difficulty,
 * 5000). Draws nothing — a pure catalogue lookup, `rng` unused (accepted
 * but ignored, matching the contracted signature every `npcId` shares).
 * The "row disappears once bought until the character advances a tier"
 * rule needs purchase tracking this ticket does not build (`vendorBuy` is
 * a different ticket, see file header) — `scroll_respec` is therefore
 * always present here, flagged in the report. */
function buildIsaStock() {
  const out = [];
  const ids = ['scroll_identify', 'scroll_portal', 'scroll_respec'];
  for (let i = 0; i < ids.length; i++) {
    const base = ITEM_BASES_BY_ID[ids[i]];
    if (base) out.push(createConsumableInstance(base, nextVendorUid()));
  }
  return out;
}

/** Builds the vendor state bag — `stockByNpc`/`buybackByNpc` are
 * `Object.create(null)` dictionaries, pre-populated for the two known
 * NPCs (see file header: never a `Map`, this is a small fixed key set).
 * @param {object} ctx
 * @returns {object}
 */
export function createVendorState(ctx) {
  const stockByNpc = Object.create(null);
  const buybackByNpc = Object.create(null);
  stockByNpc[VEREN_ID] = EMPTY_STOCK;
  stockByNpc[ISA_ID] = EMPTY_STOCK;
  buybackByNpc[VEREN_ID] = [];
  buybackByNpc[ISA_ID] = [];
  return { ctx, stockByNpc, buybackByNpc };
}

/**
 * `02-api-contracts.md` §11: `vendorStock(npcId, rng, clvl) =>
 * ItemInstance[]`. `Fixed: Y`, `Alloc: yes` — regenerates and stores this
 * NPC's stock, then returns it. An unknown `npcId` produces (and stores) an
 * empty array — a well-formed refusal, never a throw.
 * @param {object} state - `createVendorState`'s return value.
 * @param {string} npcId
 * @param {import('../core/rng.js').Rng} rng - the vendor's own dedicated
 *   stream — see file header for why this is never `this.rng`/`ctx.rng`.
 * @param {number} clvl
 * @returns {object[]}
 */
export function vendorStock(state, npcId, rng, clvl) {
  let items;
  if (npcId === VEREN_ID) items = buildVerenStock(rng, clvl);
  else if (npcId === ISA_ID) items = buildIsaStock();
  else items = [];
  state.stockByNpc[npcId] = items;
  return items;
}

/** `02-api-contracts.md` §11: `currentStock(npcId) => readonly
 * ItemInstance[]`. `Alloc: no` — returns whatever reference is already
 * stored, never rebuilds. Draws NOTHING from any RNG (clause 3 of this
 * ticket's acceptance criteria) — there is no `Rng` in scope here at all.
 * @param {object} state
 * @param {string} npcId
 * @returns {object[]}
 */
export function currentStock(state, npcId) {
  return state.stockByNpc[npcId] || EMPTY_STOCK;
}

/** `02-api-contracts.md` §11: `buyback(npcId) => readonly ItemInstance[]`.
 * `Alloc: no` — same "return the stored reference" contract as
 * `currentStock`. Starts, and today stays, empty for every `npcId` — see
 * file header (`vendorSell` is a different, not-yet-built ticket).
 * @param {object} state
 * @param {string} npcId
 * @returns {object[]}
 */
export function buyback(state, npcId) {
  return state.buybackByNpc[npcId] || EMPTY_STOCK;
}

/** Pushes `item` onto `npcId`'s buyback list, evicting the OLDEST entry
 * once the list exceeds `04` §7.3's cap of 12. Module-level export, NOT
 * attached to `ItemsSystem` — see file header: this is the seam a future
 * `vendorSell` ticket calls into, and this ticket's own tests call it
 * directly to prove the eviction rule without a purchase flow to drive it.
 * @param {object} state
 * @param {string} npcId
 * @param {object} item - an `ItemInstance`.
 * @returns {object[]|undefined} the (mutated, stable) buyback list, or
 *   `undefined` if `item` is missing.
 */
export function sellIntoBuyback(state, npcId, item) {
  if (!item) return undefined;
  let list = state.buybackByNpc[npcId];
  if (!list) {
    list = [];
    state.buybackByNpc[npcId] = list;
  }
  list.push(item);
  if (list.length > BUYBACK_CAPACITY) list.shift(); // oldest evicted; bounded at 12, shift() cost is trivial
  return list;
}

/**
 * FNV-1a 32-bit mix — the same algorithm `src/world/index.js#hashSeed`
 * already uses for `hash(worldSeed, zoneId, runIndex)` (duplicated, not
 * imported — see file header, ARCHITECTURE.md rule 2). Folds `zoneSeed`
 * then every char of `npcId`.
 * @param {number} zoneSeed
 * @param {string} npcId
 * @returns {number} uint32
 */
function hashVendorSeed(zoneSeed, npcId) {
  const FNV_PRIME = 0x01000193;
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis

  h = (h ^ (zoneSeed >>> 0)) >>> 0;
  h = Math.imul(h, FNV_PRIME) >>> 0;

  for (let i = 0; i < npcId.length; i++) {
    h = (h ^ npcId.charCodeAt(i)) >>> 0;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }

  return h >>> 0;
}

/** Resolves `ctx.get('actors').player`, defensively — `null` when
 * unavailable. Same guarded-resolution shape `./economy.js#getActors`
 * already uses; only `.level` is read from the result. */
function resolvePlayerLevel(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return 1;
  let actors;
  try {
    actors = ctx.get('actors');
  } catch {
    return 1;
  }
  const player = actors && actors.player;
  return player && Number.isInteger(player.level) ? player.level : 1;
}

/**
 * `zone:enter` handler (`04` §7.5: "Stock regenerates on every zone:enter
 * into `last_bastion`"). No-op for any other `zoneId` — a real town visit
 * is the only trigger, never a bare subscription-exists check. See file
 * header for the seed derivation and why it never touches `this.rng`.
 * @param {object} state
 * @param {{zoneId: string, seed: number, entry: string}} payload
 */
export function regenerateVendorStock(state, payload) {
  if (!payload || payload.zoneId !== TOWN_ZONE_ID) return;
  const zoneSeed = payload.seed >>> 0;
  const clvl = resolvePlayerLevel(state.ctx);
  vendorStock(state, VEREN_ID, new Rng(hashVendorSeed(zoneSeed, VEREN_ID)), clvl);
  vendorStock(state, ISA_ID, new Rng(hashVendorSeed(zoneSeed, ISA_ID)), clvl);
}
