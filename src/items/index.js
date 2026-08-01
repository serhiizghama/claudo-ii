// src/items/index.js
//
// ITEM-1 — the `items` subsystem shell. This ticket's only job is the base
// catalogue (`./data/bases.js`) and registering `items` so M3's later
// tickets (ITEM-2..15) have a subsystem to attach to. Everything else is
// deliberately absent — see below for exactly what and which ticket fills it,
// the same "deliberately absent, not stubbed" discipline `src/ui/index.js`
// (UI-1) and `src/combat/packet.js` already establish for their own tickets.
//
// ---------------------------------------------------------------------------
// `static deps` — why this is `[]`, not `['materials']`
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §11 declares `static deps = ['materials']`.
// `materials` does not exist yet — there is no `src/materials/` directory in
// this tree at all, and nothing has ever called
// `registry.add(MaterialsSystem)` — so `src/core/registry.js#resolve()` would
// throw `'items' depends on 'materials', which is not registered` the
// instant this class is registered, before any subsystem's `init()` runs:
// the whole boot, dead, for every other landed ticket too. `src/ui/index.js`
// (UI-1, "why this is ['player'], not ['items','player']") and
// `src/actors/index.js` (ACTR-1) set the exact precedent for this. Once
// `materials` is registered, this line must go back to `['materials']` — and
// `src/ui/index.js`'s own deps line must go back to `['items', 'player']` at
// the same time, since `items` will then exist too.
//
// ---------------------------------------------------------------------------
// ITEM-4 — the `items` fork, taken here
// ---------------------------------------------------------------------------
// `init()` now takes the ONE `ctx.rng.fork()` this subsystem is allowed
// (ARCHITECTURE.md hard rule 4 / the Determinism contract: "one fork per
// subsystem ... taken once in init(), never re-forked per event") and keeps
// it on `this.rng` for the subsystem's lifetime. This is the fork every
// later M3 ticket's roll (`rollItem`, `rollDrop`, affix values, unique
// substitution, ground scatter — the fifteen draws of `04-items.md` §9.2)
// must draw from — never `ctx.rng` directly, and never a second
// `ctx.rng.fork()` anywhere else in `src/items/`.
//
// This is exactly the second, later fork the previous header (below,
// retained for the tickets it still documents) said would falsify
// `tests/core/boot.test.js`'s RNG snapshot if taken prematurely — it is not
// premature now, this is that ticket. See that test's own comment block
// (L319-342) for how it accounts for every subsystem's init-time fork,
// `items`'s included.
//
// ---------------------------------------------------------------------------
// What this ticket deliberately does NOT build (per its own brief)
// ---------------------------------------------------------------------------
// - No `prewarmMaterials(ctx)` — icons are ITEM-15, the last step of M3
//   (`04-items.md` §12 step 11).
// - No public API methods for a pipeline that does not exist yet
//   (`rollDrop`, the container/equipment group, the economy group, `icon`,
//   etc.). `02-api-contracts.md` §11 lists the full, final surface, but
//   that table describes the whole subsystem's eventual contract, not what
//   an individual ticket ships — every such method belongs to the ticket
//   that builds the pipeline behind it (ITEM-9 for `rollDrop`, ITEM-10 for
//   the container/equipment group, ITEM-12 for the economy group, ITEM-11
//   for `icon`). `rollQuality` (`./quality.js`) is likewise a plain
//   exported function, not attached here, for the same reason —
//   `02-api-contracts.md` never lists it. Adding any of these, with nothing
//   real behind them, is exactly the "public surface invented before its
//   ticket" mistake this project's rule 7 warns against.
//   `base`/`bases`/`affix`/`unique`/`resolveTC`/`rolledMods`/`rollItem`/
//   `rollName` are the documented exception: every one of them already had
//   a correct, already-accepted implementation (ITEM-2/3/5-8) sitting as a
//   module-level export only, never wired as an `ItemsSystem` instance
//   method — so `02` §11 contracted them, the pipeline existed, and yet
//   `ctx.get('items')` could not reach any of the eight. ITEM-19 (a
//   micro-ticket, the ACTR-15/PLYR-10 precedent) closes exactly that gap,
//   across two rounds (round 1: the four data accessors below; round 2: the
//   `ITEM_BASES_BY_ID` prototype-pollution fix in `./data/bases.js`; round
//   3: the four rolling/lookup forwards further down this file) — see each
//   method's own comment for what, if anything, needed a judgment call.
//
// `ITEM_BASES` / `ITEM_BASES_BY_ID` are re-exported here (module-level, not
// only as instance methods — see above) so a later ticket, and any test or
// tool that wants the raw catalogue, has one canonical import path:
// `./index.js`, not reaching past it into `./data/`.

export { ITEM_BASES, ITEM_BASES_BY_ID } from './data/bases.js';

// ITEM-3 — same re-export-only precedent as the ITEM_BASES line above:
// `src/items/data/treasure.js` owns the table and `resolveTC`; this file
// gives later tickets and tests one canonical import path for both.
export { TREASURE_CLASSES, TREASURE_CLASSES_BY_ID, resolveTC } from './data/treasure.js';

// ITEM-4 — same re-export-only precedent, for the quality-roll surface.
// `./rng.js`'s `CountingRng` is deliberately NOT re-exported here — it is
// draw-counting test/proof infrastructure, not part of the gameplay
// surface `bases`/`treasure`/`quality` share, so tests import it directly
// from `../../src/items/rng.js`.
export { rollQuality, effMF } from './quality.js';

// ITEM-5 — same re-export-only precedent, for the rollItem-skeleton surface
// (`./roll.js`). `rollBaseGroup`/`rollBaseInGroup`/`rollSuperiorAmount`/
// `rollDefenseAmount`/`BASE_GROUPS` are deliberately NOT re-exported here —
// they are `rollItem`'s own internal pieces, not a surface anything outside
// `src/items/` (or this ticket's own test) needs; `02-api-contracts.md`
// never lists them, matching the same "no public method invented before its
// ticket" rule `rollQuality` itself was re-exported under above.
export { rollItem, applyFloor, degrade, legalAffixCount, setUniquePoolSource } from './roll.js';

// ITEM-7 — same re-export-only precedent, for the unique catalogue and the
// rolledMods surface (`02-api-contracts.md:962`). `pickUnique`/`uniquePoolAt`
// (the D6 draw and the pool filter, see below) are deliberately NOT
// re-exported — same "internal piece, not a public surface" rule
// `rollBaseGroup` etc. are held to above.
export { UNIQUES, UNIQUES_BY_ID } from './data/uniques.js';
export { rolledMods } from './mods.js';

// ITEM-8 — same re-export-only precedent, for the rare-naming surface
// (`./names.js`). `RARE_HEAD`/`RARE_TAIL` (`./data/names.js`) are
// deliberately NOT re-exported here — `rollRareName`/`composeRareName` are
// the whole public surface a caller outside `src/items/` needs; the raw
// pools are `rollItem`'s (and this ticket's own test's) business, same
// "internal piece, not a public surface" rule `BASE_GROUPS`'s siblings in
// `roll.js` are held to. `resetRareRing` IS re-exported and wired below —
// it is not gameplay-facing, but `init()` needs it at this same call site
// as every other subsystem wiring in this file.
export { rollRareName, composeRareName, resetRareRing } from './names.js';

// ITEM-9 — same re-export-only precedent, for `rollDrop`/`rollGold`/
// `rollChest` (`./drop.js`). `resetUidCounter` is deliberately NOT
// re-exported — test-only infrastructure, same "internal piece" rule
// `setUniquePoolSource`'s own re-export note is held to.
export { rollDrop, rollGold, rollChest } from './drop.js';

// Local (non-re-export) import — see `init()`'s own comment below for why
// `ItemsSystem` still touches `setUniquePoolSource` even though it is no
// longer what makes uniques work.
import { setUniquePoolSource, uniquePoolAt } from './roll.js';
import { resetRareRing } from './names.js';

// ITEM-19 — local (non-re-export) imports backing `base`/`bases`/`affix`/
// `unique` below. `ITEM_BASES`/`ITEM_BASES_BY_ID`/`UNIQUES_BY_ID` are already
// re-exported above for outside callers, but `export { X } from 'Y'` does not
// bind `X` in *this* module's own scope, so the accessor methods need their
// own import of the same live bindings. `AFFIXES_BY_ID` has never been
// re-exported at all (ITEM-2 only authored the affix data, not a public
// surface over it) — same house pattern `./mods.js` already uses for all
// three of these `*_BY_ID` tables (see that file's own imports).
import { ITEM_BASES, ITEM_BASES_BY_ID } from './data/bases.js';
import { AFFIXES_BY_ID } from './data/affixes.js';
import { UNIQUES_BY_ID } from './data/uniques.js';

// ITEM-19 round 3 — local (non-re-export, aliased `Pure` suffix, same
// convention `src/actors/index.js` uses for `statsPure`/`markDirtyPure`)
// imports backing `resolveTC`/`rolledMods`/`rollItem`/`rollName` below.
// Every one of these four already has a correct, already-accepted
// implementation (ITEM-3/ITEM-5.. /ITEM-7/ITEM-8) and is already
// re-exported at module level above — this file was simply never wired as
// the `ctx.get('items')` instance surface `02-api-contracts.md` §11
// contracts, which is the sole gap this round closes. No logic moves or
// changes; every method below is a one-line forward.
import { resolveTC as resolveTCPure } from './data/treasure.js';
import { rollItem as rollItemPure } from './roll.js';
import { rolledMods as rolledModsPure } from './mods.js';
import { rollRareName as rollRareNamePure } from './names.js';

// ITEM-9 — local (non-re-export) imports backing `rollDrop`/`rollGold`/
// `rollChest` below. Same thin-forward convention as the ITEM-19 imports
// just above: `./drop.js` already re-exports all three at module level for
// outside callers; `ItemsSystem` needs its own binding to wire them as
// `ctx.get('items')` instance methods, per `02-api-contracts.md` §11.
import { rollDrop as rollDropPure, rollGold as rollGoldPure, rollChest as rollChestPure } from './drop.js';

// ITEM-10 — containers, tetris placement, and the belt (`02-api-contracts.md`
// §11 "Containers and equipment" — every row below except `equip`/
// `unequip`/`equipped`/`canEquip`/`weaponOf`/`hasShield`, which belong to
// `equipment.js`, a different, not-yet-built ticket per `04-items.md` §12
// step 10's own file list). `./containers.js` owns the whole implementation
// as plain functions over an explicit `state` bag (`createContainerState`,
// built once in `init()` below) — the same "index.js forwards, the sibling
// file owns the logic" split every other ITEM-* ticket already uses here.
import {
  createContainerState,
  canPlace as canPlacePure,
  place as placePure,
  autoPlace as autoPlacePure,
  remove as removePure,
  itemAt as itemAtPure,
  freeCells as freeCellsPure,
  findPlacement as findPlacementPure,
  sortContainer as sortContainerPure,
  splitStack as splitStackPure,
  beltCooldown as beltCooldownPure,
  beltCount as beltCountPure,
  beltUse as beltUsePure,
  cursorItem as cursorItemPure,
  takeToCursor as takeToCursorPure,
  dropCursor as dropCursorPure,
  returnCursor as returnCursorPure,
  releaseCursor as releaseCursorPure,
} from './containers.js';

// ITEM-12 — ground items: placement, the budget-capped registry, decay, and
// pickup (`02-api-contracts.md` §11 "World interaction" — `dropToGround`/
// `groundItemsNear`/`pickUp`). `./ground.js` owns the whole implementation
// as plain functions over its own explicit `state` bag (`createGroundState`,
// built once in `init()` below), the same "index.js forwards, the sibling
// file owns the logic" split every other ITEM-* ticket already uses here.
import {
  createGroundState,
  dropToGround as dropToGroundPure,
  groundItemsNear as groundItemsNearPure,
  removeFromGround as removeFromGroundPure,
  resetGrace as resetGracePure,
  decaySweep as decaySweepPure,
} from './ground.js';

// ITEM-11 — `EquipmentSet`, `canEquip`, `equip`/`unequip`, `slotsFor`, plus
// `equipped`/`weaponOf`/`hasShield` (`02-api-contracts.md` §11 "Containers
// and equipment" — the six rows ITEM-10's own header named as belonging to
// `equipment.js`, a different ticket). Same thin-forward convention as every
// import block above; `./equipment.js` owns the implementation over its own
// state bag (`createEquipmentState`, built in `init()` below from the SAME
// `this._containers` bag ITEM-10 already built — see that function's own
// header for why the two share one grid).
import {
  createEquipmentState,
  slotsFor as slotsForPure,
  canEquip as canEquipPure,
  equip as equipPure,
  unequip as unequipPure,
  equipped as equippedPure,
  weaponOf as weaponOfPure,
  hasShield as hasShieldPure,
} from './equipment.js';

// ITEM-13 — identification and durability (`02-api-contracts.md` §11 "World
// interaction, identification, durability, vendors" — `durabilityTick`/
// `identify`). `./state.js` owns the whole implementation over its own
// small state bag (`createDurabilityState`, built in `init()` below), the
// same "index.js forwards, the sibling file owns the logic" split every
// other ITEM-* ticket already uses here.
import {
  createDurabilityState,
  durabilityTick as durabilityTickPure,
  identify as identifyPure,
} from './state.js';

// ITEM-14 — economy (value, repair) and vendor stock/buyback
// (`02-api-contracts.md` §11 "World interaction, identification,
// durability, vendors": `itemValue`/`sellValue`/`buyValue`/`repairCost`/
// `repairAllCost`/`repairAll`/`vendorStock`/`currentStock`/`buyback`).
// `./economy.js` and `./vendor.js` own the two implementations (ruling
// D-28 names both files); same "index.js forwards, the sibling file owns
// the logic" split every other ITEM-* ticket in this directory already
// uses. `itemValue`/`sellValue`/`buyValue`/`repairCost` are pure
// item-in-number-out math and need no state bag at all.
import {
  itemValue as itemValuePure,
  sellValue as sellValuePure,
  buyValue as buyValuePure,
  repairCost as repairCostPure,
  repairAllCost as repairAllCostPure,
  repairAll as repairAllPure,
  createEconomyState,
} from './economy.js';
import {
  createVendorState,
  vendorStock as vendorStockPure,
  currentStock as currentStockPure,
  buyback as buybackPure,
  regenerateVendorStock,
} from './vendor.js';

// ITEM-16 — save round-trip (`02-api-contracts.md:973` `rebuildCache`; the
// serialise half, `serialiseItem`, has no contracted row — `save`'s own
// `serialise()` at L1161 is the CharacterSave-level method, a different,
// not-yet-built ticket's — so it is re-exported at module level only, the
// same "no public method invented before its ticket" precedent `degrade`/
// `applyFloor`/`legalAffixCount` are held to above, for `src/save/` (SAVE-1)
// and this ticket's own test to import from one canonical path).
export { serialiseItem } from './serialise.js';
import { rebuildCache as rebuildCachePure } from './serialise.js';

// ITEM-15 — procedural item icons (`02-api-contracts.md:1028` `icon`;
// `04-items.md` §11 / `09-ui.md` §7). `./icons/` owns the whole
// implementation (primitives, recipes, rarity framing, the 192-entry LRU) —
// same "index.js forwards, the sibling directory owns the logic" split
// every other ITEM-* ticket in this file already uses. `createIconCache()`
// is built once in `init()` below (a state bag, not a second
// `ctx.rng.fork()` — `./icons/generate.js` seeds its own per-icon `Rng`
// straight from `ItemBase.iconSeed`, never from `this.rng`/`ctx.rng`, so
// icon generation draws zero times against the `items` stream — see this
// ticket's report for the determinism proof `tools/lootsim.mjs` depends on).
import { createIconCache, iconFor, generateIconCanvas } from './icons/index.js';

export class ItemsSystem {
  static id = 'items';
  static deps = []; // 'materials' omitted — not registered yet, see header above

  /**
   * Takes the `items` fork (see header above) and keeps it on `this.rng`.
   *
   * `setUniquePoolSource(uniquePoolAt)` here is a DEFENSIVE RESET, not the
   * wiring: `roll.js`'s own module-level default is already `uniquePoolAt`
   * (a bare `import './roll.js'`, e.g. `tools/lootsim.mjs`'s headless
   * harness, produces real uniques with zero setup — see that file's own
   * comment on `let uniquePoolSource = uniquePoolAt`). This call exists only
   * to restore that default in case some earlier code running in the same
   * process — a test, a REPL, another tool — called `setUniquePoolSource`
   * with an override and left it in place; without this line a long-lived
   * process (not a fresh `node --test` child) could start a real game with
   * a stale override still active. Idempotent, and not a new `rng.fork()`
   * (there is still exactly one `items` fork, taken above).
   */
  async init(ctx) {
    this.rng = ctx.rng.fork();
    setUniquePoolSource(uniquePoolAt);

    // ITEM-15 — the icon LRU (`09-ui.md` §7.1: "LRU, 192 entries"). Not a
    // second `ctx.rng.fork()` — see the import comment above.
    this._icons = createIconCache();

    // ITEM-10 — the container/belt/cursor state bag. Not a second
    // `ctx.rng.fork()` (it draws no randomness at all); see
    // `./containers.js`'s own header for the shape and why it is not a
    // `Map`.
    this._containers = createContainerState(ctx);

    // ITEM-11 — the equipment state bag, built over the SAME `this._containers`
    // grid ITEM-10 already created (`equip`/`unequip` place displaced gear
    // into the real inventory — see `./equipment.js`'s own header for why
    // the two tickets share one state bag rather than each keeping their
    // own). Not a second `ctx.rng.fork()` (draws no randomness at all).
    this._equipment = createEquipmentState(ctx, this._containers);

    // ITEM-12 — the ground-item registry state bag. Not a second
    // `ctx.rng.fork()` (it draws no randomness at all, by design — see
    // `./ground.js`'s own header on why ground placement never touches
    // `this.rng`); sized from `ctx.config.q.groundItemBudget` there.
    this._ground = createGroundState(ctx);

    // ITEM-13 — the identification/durability state bag. Not a second
    // `ctx.rng.fork()` (durability loss and identification both draw zero
    // randomness — `04-items.md` §7.4/§14.1 D-9 fix the four rates, and
    // identify is a flag flip, not a roll).
    this._durability = createDurabilityState(ctx);

    // ITEM-14 — the economy state bag (just `{ ctx }`, `repairAll`'s own
    // `stats:dirty` emit is the only thing in `./economy.js` that needs
    // it) and the vendor stock/buyback state bag. Neither takes a second
    // `ctx.rng.fork()` (both draw zero randomness at their own
    // construction — `./vendor.js`'s own header on why `vendorStock`'s
    // `Rng` comes from `zone:enter`'s own seed field instead).
    this._economy = createEconomyState(ctx);
    this._vendor = createVendorState(ctx);

    // ITEM-8 — `13-progression-lore.md` §10.3: the rare-name ring "is reset
    // on zone:enter". `resetRareRing` is idempotent module-level state (see
    // `./names.js`'s header), so subscribing once here, never re-subscribing
    // per event, is the correct shape — matches `physics/index.js`'s own
    // `ctx.events.on('zone:ready', ...)` precedent for a one-time `init()`
    // subscription to a `world`-emitted event. Guarded the same way
    // `src/ui/feedback.js`'s constructor already guards its own
    // `ctx.events.on(...)` calls — `tests/items/quality.test.js`'s
    // `ITMS.Q01` (pre-existing, not this ticket's to edit) constructs a
    // minimal `ctx` with only `rng` to test the fork in isolation; a real
    // `ctx` always has `events` (`ARCHITECTURE.md`'s subsystem interface).
    if (ctx && ctx.events && typeof ctx.events.on === 'function') {
      ctx.events.on('zone:enter', () => resetRareRing());

      // ITEM-12 — `02-api-contracts.md` Listens row for `items`:
      // "`actor:damage` (resets the ground-item decay grace ...)", the `04`
      // §13.1 event-table addition this ticket's brief names as its second
      // acceptance clause. Same one-time-subscription shape as `zone:enter`
      // just above; see `./ground.js#resetGrace` for what "resets" means
      // (a single overwritten step stamp, not an accumulator).
      ctx.events.on('actor:damage', () => resetGracePure(this._ground));

      // ITEM-14 — `04-items.md` §7.5: "Stock regenerates on every
      // zone:enter into last_bastion". Same one-time-subscription shape as
      // the two listeners above; `./vendor.js#regenerateVendorStock` itself
      // guards for any other `zoneId`. Passing the real event payload
      // (`{zoneId, seed, entry}`) through, not just re-deriving a seed —
      // `seed` here is `world`'s own `hash(worldSeed, zoneId, runIndex)`,
      // the deterministic, non-forked source this ticket's own report
      // explains in full.
      ctx.events.on('zone:enter', (payload) => regenerateVendorStock(this._vendor, payload));
    }
  }

  // ─── Data and rolling (02-api-contracts.md §11) ────────────────────────
  // ITEM-19: these four accessors only — see the file header for why they
  // were orphaned until now. Plain bracket reads on the `*_BY_ID` tables
  // `./data/*.js` already built once at module load (`ARCHITECTURE.md`'s
  // measured-cost rule: a `Map` keyed by a never-repeating id leaks
  // ~456 B/call — these are the opposite, a build-once index, so a read is
  // one property access, zero allocation, same convention `./mods.js`
  // already uses on the identical tables). An unknown id resolves to
  // `undefined`, never a throw — plain object property access on a missing
  // key already behaves that way; no extra guard needed to keep that
  // contract, and it matches how `./mods.js`/`./roll.js` already read these
  // same tables.

  /** `02-api-contracts.md` §11: `base(baseId) => ItemBase`. `undefined` for
   * an unknown id. */
  base(baseId) {
    return ITEM_BASES_BY_ID[baseId];
  }

  /** `02-api-contracts.md` §11: `bases` -> `ItemBase[]`. Returns the same
   * frozen `ITEM_BASES` reference every call — never a copy (`[...arr]`/
   * `.slice()` on a property read would allocate on every access, which the
   * contract's `Alloc: no` forbids). */
  get bases() {
    return ITEM_BASES;
  }

  /** `02-api-contracts.md` §11: `affix(affixId) => AffixDefinition`.
   * `undefined` for an unknown id. */
  affix(affixId) {
    return AFFIXES_BY_ID[affixId];
  }

  /** `02-api-contracts.md` §11: `unique(uniqueId) => UniqueDefinition`.
   * `undefined` for an unknown id. */
  unique(uniqueId) {
    return UNIQUES_BY_ID[uniqueId];
  }

  // ─── Data and rolling, round 3 (02-api-contracts.md §11) ───────────────
  // Four more contracted rows that already had a correct implementation as
  // a module-level export only (ITEM-3/5-8), never reachable through
  // `ctx.get('items')` — the same gap ITEM-19 round 1 found and closed for
  // `base`/`bases`/`affix`/`unique`. Thin one-line forwards only; see each
  // method's own comment for anything that needed a judgment call.

  /** `02-api-contracts.md` §11: `resolveTC(family, mlvl) => string`. Thin
   * delegation to `./data/treasure.js`'s already-accepted (ITEM-3)
   * `resolveTC` — `ai`/`world` need this before `rollDrop` exists, and this
   * is the one legal path to it (ARCHITECTURE.md rule 2). */
  resolveTC(family, mlvl) {
    return resolveTCPure(family, mlvl);
  }

  /** `02-api-contracts.md` §11: `rolledMods(item, out) => int`. Thin
   * delegation to `./mods.js`'s already-accepted (ITEM-7) `rolledMods` —
   * the tooltip ticket's own blocked path (see this ticket's report). */
  rolledMods(item, out) {
    return rolledModsPure(item, out);
  }

  /**
   * `02-api-contracts.md:959` contracts `rollItem` as
   * `(baseId:string, ilvl:int, rarity:string, rng:Rng) => ItemInstance` —
   * that row is STALE (predates ITEM-5/6/7/8's real draw order; the
   * normative `04-items.md` §9.3 has `rollItem` draw its own base group
   * (D3), base-in-group (D4) and quality (D5) rather than take them as
   * arguments, and `03-combat-math.md`'s `04` cross-reference already
   * agrees with the live shape, not the stale row). Wired here to the LIVE
   * signature `./roll.js#rollItem` actually ships —
   * `(uid, ilvl, mlvl, rank, difficulty, magicFind, rarityFloor, rng)` — a
   * thin delegation, no new logic. `02:959` needs amending to match; not
   * done here (out of this ticket's file allowlist, and the orchestrator
   * owns that edit per this round's brief).
   */
  rollItem(uid, ilvl, mlvl, rank, difficulty, magicFind, rarityFloor, rng) {
    return rollItemPure(uid, ilvl, mlvl, rank, difficulty, magicFind, rarityFloor, rng);
  }

  /**
   * `02-api-contracts.md` §11 / `13-progression-lore.md` §13.4:
   * `rollName(item, rng) => void` — "Names the item in place using §10's
   * pools and the recent ring." `./names.js` exports no function shaped
   * `(item, rng)`; its only draw-producing export is `rollRareName(rng)`,
   * which returns `{headIndex, tailIndex, code, en, ru}` and touches no
   * item. The one faithful, non-invented adapter is the exact assignment
   * `./roll.js`'s own D13 call site already performs, verbatim
   * (`item.nameOverride = rollRareName(rng)`, matching
   * `01-data-model.md`'s own field comment: "rare items store their
   * generated two-word name here"). No rarity guard is added here:
   * `rollItem`'s inline call decides WHEN to roll a name (only when
   * `rarity === 'rare'`); this method, like that inline call, only decides
   * WHERE the result goes once a caller has already decided to name the
   * item — inventing an internal rarity check here (e.g. silently no-op on
   * a non-rare item) is behaviour no spec or existing code states, so it is
   * deliberately not added.
   */
  rollName(item, rng) {
    item.nameOverride = rollRareNamePure(rng);
  }

  // ─── ITEM-9 — rollDrop/rollGold/rollChest (02-api-contracts.md §11) ────
  // Thin delegations to `./drop.js`'s already-implemented functions — see
  // that file's header for the seven-parameter `rollDrop` signature
  // (O-64/O-68), the `{ items, gold }` return shape, and the `rollChest`
  // `chest`-object caveat.

  /** `rollDrop(tc, mlvl, rank, ilvl, difficulty, magicFind, rng) =>
   * { items, gold }`. See `./drop.js` for the full contract. */
  rollDrop(tc, mlvl, rank, ilvl, difficulty, magicFind, rng) {
    return rollDropPure(tc, mlvl, rank, ilvl, difficulty, magicFind, rng);
  }

  /** `rollGold(mlvl, rank, goldFind, rng) => int`, `04` §7.1. */
  rollGold(mlvl, rank, goldFind, rng) {
    return rollGoldPure(mlvl, rank, goldFind, rng);
  }

  /** `rollChest(chest, rng, out) => int` — the one entry point that takes
   * an external `Rng` (the chest's own `S4` sub-seed, `04:1206`). */
  rollChest(chest, rng, out) {
    return rollChestPure(chest, rng, out);
  }

  // ─── ITEM-10 — containers, tetris placement, and the belt ──────────────
  // (`02-api-contracts.md` §11 "Containers and equipment"). Thin forwards
  // into `./containers.js`, passing this instance's one `_containers` state
  // bag — see that file's header for the data structures and the zero-
  // allocation design.

  /** `canPlace(container, item, x, y) => boolean`. */
  canPlace(container, item, x, y) {
    return canPlacePure(this._containers, container, item, x, y);
  }

  /** `place(container, item, x, y) => boolean`. */
  place(container, item, x, y) {
    return placePure(this._containers, container, item, x, y);
  }

  /** `autoPlace(container, item) => boolean` — first fit, row-major. */
  autoPlace(container, item) {
    return autoPlacePure(this._containers, container, item);
  }

  /** `remove(item) => boolean`. */
  remove(item) {
    return removePure(this._containers, item);
  }

  /** `itemAt(container, x, y) => ItemInstance | null`. */
  itemAt(container, x, y) {
    return itemAtPure(this._containers, container, x, y);
  }

  /** `freeCells(container) => int`. */
  freeCells(container) {
    return freeCellsPure(this._containers, container);
  }

  /** `findPlacement(container, item, out?) => {x,y} | null` — non-mutating. */
  findPlacement(container, item, out) {
    return findPlacementPure(this._containers, container, item, out);
  }

  /** `sortContainer(container) => boolean`. */
  sortContainer(container) {
    return sortContainerPure(this._containers, container);
  }

  /** `splitStack(item, count) => ItemInstance | null`. The one `Alloc: yes`
   * row — see `./containers.js` for the uid-partitioning caveat (report). */
  splitStack(item, count) {
    return splitStackPure(item, count);
  }

  /** `beltCooldown(actor) => number` — seconds left on the 0.5s global belt
   * cooldown (`04-items.md` §8.3, ruling D-23). */
  beltCooldown(actor) {
    return beltCooldownPure(this._containers, actor);
  }

  /** `beltCount(actor, slotIndex) => int`. */
  beltCount(actor, slotIndex) {
    return beltCountPure(this._containers, actor, slotIndex);
  }

  /** `beltUse(actor, slotIndex) => boolean` — container/cooldown bookkeeping
   * only; see `./containers.js` for what this deliberately does not do. */
  beltUse(actor, slotIndex) {
    return beltUsePure(this._containers, actor, slotIndex);
  }

  /** `cursorItem` -> `ItemInstance | null`. */
  get cursorItem() {
    return cursorItemPure(this._containers);
  }

  /** `takeToCursor(item) => boolean`. */
  takeToCursor(item) {
    return takeToCursorPure(this._containers, item);
  }

  /** `dropCursor(container, x, y) => { ok, swapped }`. */
  dropCursor(container, x, y) {
    return dropCursorPure(this._containers, container, x, y);
  }

  /** `returnCursor() => boolean`. */
  returnCursor() {
    return returnCursorPure(this._containers);
  }

  // ─── ITEM-12 — ground items: placement, registry, decay, pickup ────────
  // (`02-api-contracts.md` §11 "World interaction"). Thin forwards into
  // `./ground.js`, passing this instance's `_ground` state bag — see that
  // file's header for the eviction/grace policy, the data structures and
  // the zero-allocation design.

  /** `02-api-contracts.md:1013`: `dropToGround(item, x, z) => void`.
   * Detaches `item` from any container it currently occupies
   * (`./containers.js#remove`, a safe no-op if it has none) before placing
   * it on the ground registry — composed here rather than in `ground.js`
   * itself, which never reaches into `this._containers` (ARCHITECTURE.md
   * rule 2 is about crossing subsystem boundaries, but the same
   * "sibling file stays single-purpose" discipline applies within one
   * subsystem too, matching how `./containers.js`'s own `place()` never
   * reaches into `./ground.js` either). Equipped items (`item.slot` set)
   * are not unequipped here — that is `equipment.js`'s job (a different,
   * not-yet-built ticket); see this ticket's report.
   *
   * ITEM-12 round 3/4 (item-duplication bug at this wiring seam, reported
   * by the orchestrator's own live probe, `cur.mjs`): `remove()` above
   * only vacates a GRID container (`item.grid.container`) — the cursor
   * (`02-api-contracts.md` §16.2's canonical "a dragged item belongs to no
   * container" slot) is a SEPARATE location `./containers.js` tracks on
   * `state.cursor.item`, untouched by `.grid`. Calling this while `item`
   * is the cursor item used to leave it referenced by BOTH
   * `this._containers`' cursor slot AND `this._ground`'s registry at once.
   * Round 3 fixed the duplication by refusing outright — but `09-ui.md`
   * §6.6's container matrix declares `inventory -> ground` as
   * `dropToGround`, and every drag goes through the cursor by construction
   * (§6.4), so refusing removed the ONLY way to drop an item on the
   * ground by dragging — trading duplication for a lost, spec'd move
   * kind. Round 4's real fix: `./containers.js#releaseCursor` (an
   * additive, module-level-only export — never attached to
   * `ItemsSystem`, the same "internal seam, not a public method"
   * precedent `./roll.js`'s `degrade`/`applyFloor`/`legalAffixCount`
   * already set, so no `02-api-contracts.md` row is needed for it) clears
   * the cursor slot when it holds `item`, without placing it anywhere —
   * the one operation `cursorItem`/`takeToCursor`/`dropCursor`/
   * `returnCursor` never provided (all three of the latter only ever
   * clear `cursor.item` as a side effect of a successful `place()`). The
   * item ends up in exactly one place: the ground. */
  dropToGround(item, x, z) {
    if (!item) return;
    releaseCursorPure(this._containers, item);
    this.remove(item);
    dropToGroundPure(this._ground, item, x, z);
  }

  /** `02-api-contracts.md:1014`: `groundItemsNear(x,z,radius,out) => int`. */
  groundItemsNear(x, z, radius, out) {
    return groundItemsNearPure(this._ground, x, z, radius, out);
  }

  /** `02-api-contracts.md:1015`: `pickUp(actor, item) => boolean`. `item`
   * must currently be on the ground; attempts to place it into the
   * player's inventory (`autoPlace`, ITEM-10 — the only container this
   * targets, matching that module's own "only the player's own inventory
   * is resolvable today" precedent). On success, detaches `item` from the
   * ground registry and emits `loot:pickup`; on failure (no room) `item`
   * is left exactly where it was, still on the ground. */
  pickUp(actor, item) {
    if (!item || !item.ground) return false;
    if (!this.autoPlace('inventory', item)) return false;
    removeFromGroundPure(this._ground, item);

    const ctx = this._ground.ctx;
    const events = ctx && ctx.events;
    if (events && typeof events.emit === 'function') {
      const payload = this._ground._pickupPayload;
      payload.item = item;
      payload.actor = actor;
      events.emit('loot:pickup', payload);
    }
    return true;
  }

  /** 60 Hz decay sweep — the 600 s hard timeout (`04:1252`/`01:895`).
   * Simulation-only: reads `ctx.time.step` (via `./ground.js`'s own stored
   * `state.ctx`), never `dt`/the wall clock (ARCHITECTURE.md rule 4). */
  fixedUpdate() {
    decaySweepPure(this._ground);
  }

  // ─── ITEM-13 — identification and durability ───────────────────────────
  // (`02-api-contracts.md` §11 "World interaction, identification,
  // durability, vendors"). Thin forwards into `./state.js`, passing this
  // instance's `_durability` state bag — see that file's header for the
  // per-cause accumulator placement, the round-robin over equipped armour,
  // and the "0 durability is unusable, never destroyed" invariant.

  /** `durabilityTick(actor, kind:'attack'|'hit'|'block'|'death') => void` —
   * `combat` knows a hit landed; `items` owns the accumulator and the
   * `stats:dirty` at zero (`04-items.md` §7.4, ruling D-9). */
  durabilityTick(actor, kind) {
    durabilityTickPure(this._durability, actor, kind);
  }

  /** `identify(item) => boolean` — flips `identified` and emits
   * `item:identify {item}`; `false`, a no-op, if `item` is missing or
   * already identified. */
  identify(item) {
    return identifyPure(this._durability, item);
  }

  // ─── ITEM-14 — economy: value, repair, vendor ──────────────────────────
  // (`02-api-contracts.md` §11 "Data and rolling" / "World interaction,
  // identification, durability, vendors"). Thin forwards into
  // `./economy.js`/`./vendor.js` — see each file's own header for the
  // formulas, the C-7 authored-integer discipline, the repair/gold
  // atomicity call and the vendor-stock RNG derivation.

  /** `itemValue(item) => int` — `04` §7.2, the one formula `sellValue`/
   * `buyValue` derive from. */
  itemValue(item) {
    return itemValuePure(item);
  }

  /** `sellValue(item) => int` — `04` §7.3, `playerReceives`. */
  sellValue(item) {
    return sellValuePure(item);
  }

  /** `buyValue(item) => int` — `04` §7.3, `playerPays`. */
  buyValue(item) {
    return buyValuePure(item);
  }

  /** `repairCost(item) => int` — `04` §7.4. `0` for an indestructible or
   * already-full item; see `./economy.js` for that judgment call. */
  repairCost(item) {
    return repairCostPure(item);
  }

  /** `repairAllCost(actor) => int` — `04` §7.4, Σ over equipment +
   * inventory + belt. */
  repairAllCost(actor) {
    return repairAllCostPure(actor);
  }

  /** `repairAll(actor) => int` — gold spent; atomic (full cost or nothing),
   * see `./economy.js` for the judgment call. */
  repairAll(actor) {
    return repairAllPure(this._economy, actor);
  }

  /** `vendorStock(npcId, rng, clvl) => ItemInstance[]` — regenerated per
   * town visit. `rng` must never be `this.rng`/`ctx.rng` — see
   * `./vendor.js`'s header for why and how `zone:enter` already drives this
   * without a caller ever needing to call it directly. */
  vendorStock(npcId, rng, clvl) {
    return vendorStockPure(this._vendor, npcId, rng, clvl);
  }

  /** `currentStock(npcId) => readonly ItemInstance[]` — the live stock,
   * read-only, zero-allocation, draws from no RNG at all (`09-ui.md`
   * §16.2's own rationale: `ui` must never desynchronise
   * `tools/lootsim.mjs`). */
  currentStock(npcId) {
    return currentStockPure(this._vendor, npcId);
  }

  /** `buyback(npcId) => readonly ItemInstance[]` — the last 12 items sold,
   * oldest evicted. Empty until a future `vendorSell` ticket wires a sale
   * into `./vendor.js#sellIntoBuyback` — see that file's header. */
  buyback(npcId) {
    return buybackPure(this._vendor, npcId);
  }

  // ─── ITEM-11 — EquipmentSet, canEquip, equip/unequip, slotsFor ─────────
  // (`02-api-contracts.md` §11 "Containers and equipment"). Thin forwards
  // into `./equipment.js`, passing this instance's `_equipment` state bag —
  // see that file's header for the requirement-check design, the two-hander/
  // off-hand displacement rule and the zero-allocation scratch objects.

  /** `slotsFor(item) => string[]` — the real legal slot list; a ring is
   * legal in `ring1` AND `ring2`. */
  slotsFor(item) {
    return slotsForPure(item);
  }

  /** `canEquip(actor, item, slot) => { ok, reason }`. */
  canEquip(actor, item, slot) {
    return canEquipPure(this._equipment, actor, item, slot);
  }

  /** `equip(actor, item, slot) => { ok, reason }`. Writes the `equipment`
   * `StatSources` layer via `actors.setSourceLayer` on success (`01` §4.1/
   * §4.4) — this is the write path `02-api-contracts.md`'s `stats:dirty`
   * emitter table already credits to `items`: "equip, unequip, ...". */
  equip(actor, item, slot) {
    return equipPure(this._equipment, actor, item, slot);
  }

  /** `unequip(actor, slot) => boolean`. */
  unequip(actor, slot) {
    return unequipPure(this._equipment, actor, slot);
  }

  /** `equipped(actor, slot) => ItemInstance | null`. */
  equipped(actor, slot) {
    return equippedPure(actor, slot);
  }

  /** `weaponOf(actor) => ItemInstance | null` — `mainHand`, or the unarmed
   * pseudo-item. */
  weaponOf(actor) {
    return weaponOfPure(actor);
  }

  /** `hasShield(actor) => boolean`. */
  hasShield(actor) {
    return hasShieldPure(actor);
  }

  // ─── ITEM-16 — save round-trip ──────────────────────────────────────────
  // (`02-api-contracts.md:973` "Data and rolling": `rebuildCache`). Thin
  // forward into `./serialise.js` — see that file's header for the
  // nameOverride/uniqueValues/_cache.weapon rebuild rules and the zero-RNG-
  // draw proof (this ticket's report).

  /** `rebuildCache(item) => void` — "after load or identify". */
  rebuildCache(item) {
    rebuildCachePure(item);
  }

  // ─── ITEM-15 — procedural item icons ────────────────────────────────────
  // (`02-api-contracts.md:1028`). Thin forward into `./icons/index.js`,
  // passing this instance's `_icons` LRU state bag — see that directory's
  // own files for the recipe selection (ruling D-24's `mace_`/`hammer_`/
  // `maul_` selector fix, `bow` kept implemented-but-unreachable), the
  // material ramps, the rarity framing and the cache design.

  /** `02-api-contracts.md:1028`: `icon(item) => OffscreenCanvas`, generated
   * once and cached. `null` (never a throw) when `item`/its base cannot be
   * resolved, when the base selects no recipe, or when the current realm has
   * no `OffscreenCanvas` (bare Node — see `./icons/generate.js`'s header;
   * this is the test-form rule's "explicit refusal", exercised directly by
   * `tests/items/icons.test.js`). */
  icon(item) {
    if (!item) return null;
    const base = ITEM_BASES_BY_ID[item.baseId];
    if (!base) return null;
    return iconFor(this._icons, item, base);
  }

  /**
   * Dev/tooling-only escape hatch — the same "internal seam, not a public
   * method" precedent this file already sets for `./roll.js`'s `degrade`/
   * `applyFloor`/`legalAffixCount` and (visual tooling specifically)
   * `src/actors/index.js`'s `__archetypeVisuals` (ACTR-6). `icon()` above is
   * the CACHED path `02-api-contracts.md` contracts; `tools/iconbench.mjs`
   * needs the raw, non-cached generator to time actual generation cost
   * across repeated calls for the SAME base/rarity (a cache hit is a
   * property read, not a measurement of the 1.2 ms generation budget) — see
   * that tool's own header. Not part of `02-api-contracts.md` and never
   * called from gameplay code.
   */
  __iconGenerate(base, opts) {
    return generateIconCanvas(base, opts);
  }
}
