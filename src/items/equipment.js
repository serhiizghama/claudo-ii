// src/items/equipment.js
//
// ITEM-11 — `EquipmentSet`, `canEquip`, `equip`/`unequip`, `slotsFor`, plus
// the small helpers `equipped`/`weaponOf`/`hasShield` (`02-api-contracts.md`
// §11 "Containers and equipment", `04-items.md` §12 step 10's own file list).
// This is where `items` and `actors` actually meet: `equip`/`unequip` are the
// only place `src/items/` writes the `equipment` `StatSources` layer (`01`
// §4.1/§4.4), through `actors.setSourceLayer` (ACTR-15's exposed surface).
//
// ---------------------------------------------------------------------------
// `SLOT_ORDER` — local, frozen, not imported (same precedent as containers.js)
// ---------------------------------------------------------------------------
// `01-data-model.md` §1.5 documents `SLOT_ORDER` but no file in the tree
// exports it yet — `src/items/containers.js`'s own copy is module-private.
// `ARCHITECTURE.md` hard rule 2 forbids reaching into `src/actors/` for it,
// and this ticket's file grant does not include a `data/` file to give this
// constant a shared home, so it is duplicated here, frozen, one line,
// exactly `containers.js`'s own value — flagged in the report, same
// deliberate-deviation precedent that file already set.
//
// ---------------------------------------------------------------------------
// The equipment `StatSources` layer — built here, not via a `statsOf` method
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §11 lists `statsOf(item, out?) => object` as a
// still-unbuilt method (`src/items/mods.js`'s own header: "a later ticket,
// not built yet") — not this ticket's (`04-items.md` §12 step 10 does not
// name it). Rather than invent and publish that method early (the exact
// "public surface before its ticket" mistake this project's rule 7 warns
// against), the merge logic needed to fold N equipped items into ONE
// combined `equipment` partial lives here as a PRIVATE helper
// (`foldItemInto`), built on top of the already-accepted `rolledMods`
// (ITEM-7). A real `statsOf` ticket can still land later and reuse the same
// per-item flattening `rolledMods` already provides.
//
// `FIELD_NAMES`/`AGG_MAX`/`AGG_OR` below are a duplicate of
// `src/actors/stats.js`'s own tables (rule 2 forbids importing that file) —
// the same "small, documented, temporary duplicate" precedent
// `src/combat/data/weapons.js#CLASS_SCALE_TABLE` already set for an
// identical cross-subsystem-constant problem. `skillBonuses`-shaped affix
// mods (`stat: 'skillBonuses.tree'` / `'skillBonuses.all'`, two- and
// one-entry respectively in `data/affixes.js`) are visible through
// `rolledMods` but are NOT folded into the equipment layer here — which tree
// a `'skillBonuses.tree'` roll targets is not present anywhere on the
// `AffixDefinition`/`AffixInstance` shape this ticket's read range covers,
// and inventing an answer would silently misattribute a real gameplay bonus.
// Flagged in the report as a known gap for whichever ticket owns
// `skills`-side item integration.
//
// ---------------------------------------------------------------------------
// Zero allocation — the scratch objects
// ---------------------------------------------------------------------------
// `canEquip`/`equip`/`unequip`/`slotsFor` are all `Alloc: no` rows. Per-call
// state lives in one `EquipmentState` bag (`createEquipmentState`, built once
// in `ItemsSystem.init()`, same shape `containers.js#createContainerState`
// already uses): a preallocated 90-field `_layer` object (rebuilt in place on
// every `equip`/`unequip`, never reallocated), a reused `rolledMods` `out`
// buffer (`_modsScratch`), a reused `{ok,reason}` result
// (`_checkResult`) and a reused `{x,y}` scratch for `findPlacement` previews.
// `slotsFor` returns one of a handful of MODULE-LEVEL frozen arrays, built
// once at load time — never a fresh array per call.
//
// `setSourceLayer(actor, 'equipment', partial)` stores the `partial`
// reference directly (`src/actors/stats.js#setSourceLayer`: `actor.sources[
// layer] = partial`) — it does not clone. Reusing ONE `_layer` object across
// every `equip`/`unequip` call is therefore only correct because `equipment`/
// `inventory`/`belt` are `kind === 'player'`-only fields (`01` §2) and this
// game has exactly one live player actor at a time — the same assumption
// `containers.js#playerActor` already bakes in for its own single shared
// state bag. A second concurrently-equipped actor would corrupt this.
// Flagged in the report, not fixed here (same scope as `containers.js`'s own
// header note on the identical assumption).
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import { ITEM_BASES_BY_ID } from './data/bases.js';
import { rolledMods } from './mods.js';
import {
  findPlacement as findPlacementPure,
  remove as removeContainerItem,
  autoPlace as autoPlaceContainer,
} from './containers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// See file header — local, not imported (containers.js's own copy is
// module-private for the same reason).
export const SLOT_ORDER = Object.freeze([
  'head', 'chest', 'hands', 'legs', 'mainHand', 'offHand',
  'belt', 'amulet', 'ring1', 'ring2',
]);

// Duplicate of `src/actors/stats.js#FIELD_NAMES` — see file header. Order
// does not matter here (unlike `stats.js`, this is never iterated
// positionally), only membership.
const FIELD_NAMES = Object.freeze([
  'strength', 'dexterity', 'vitality', 'energy',
  'maxLife', 'lifePercent', 'maxMana', 'manaPercent', 'maxRage', 'maxResonance', 'maxStamina',
  'lifeRegen', 'lifeRegenPercent', 'manaRegen', 'manaRegenPercent', 'staminaRegen',
  'minDamage', 'maxDamage', 'enhancedDamage', 'attackRating', 'attackRatingPercent',
  'increasedAttackSpeed', 'fasterCastRate', 'critChance', 'critMult',
  'fireMin', 'fireMax', 'coldMin', 'coldMax', 'lightMin', 'lightMax', 'poisonMin', 'poisonMax', 'magicMin', 'magicMax',
  'coldDuration', 'poisonDuration',
  'fireDamagePercent', 'coldDamagePercent', 'lightDamagePercent', 'poisonDamagePercent', 'magicDamagePercent',
  'elementalDamagePercent', 'physicalDamagePercent',
  'fireResistPierce', 'coldResistPierce', 'lightResistPierce', 'poisonResistPierce',
  'lifeSteal', 'manaSteal', 'lifeOnHit', 'manaOnHit', 'lifeOnKill', 'manaOnKill',
  'manaReturnPercent', 'pierceChance', 'knockbackChance', 'thorns', 'rageOnHit', 'rageOnTakeHit', 'resonanceOnHit',
  'defense', 'defensePercent', 'blockChance', 'dodgeChance',
  'fireResist', 'coldResist', 'lightResist', 'poisonResist', 'magicResist', 'physicalResist',
  'maxFireResist', 'maxColdResist', 'maxLightResist', 'maxPoisonResist', 'maxMagicResist', 'maxPhysicalResist',
  'damageReduceFlat', 'damageReducePercent', 'magicDamageReduceFlat', 'fasterHitRecovery', 'ccReduction',
  'movementSpeed', 'magicFind', 'goldFind', 'manaCostReduction', 'lightRadius', 'requirementReduction', 'damageTakenToMana', 'experienceGain',
]);

const AGG_MAX = new Set(['lightRadius']);
const AGG_OR = new Set(['cannotBeFrozen']);

const EMPTY_SLOTS = Object.freeze([]);
const RING_SLOTS = Object.freeze(['ring1', 'ring2']);
const MAINHAND_ONLY = Object.freeze(['mainHand']);
const MAINHAND_OFFHAND = Object.freeze(['mainHand', 'offHand']);
// One frozen singleton array per single-slot equipment position, built once
// at module load — `slotsFor`'s `Alloc: no` contract for the common case.
const SLOT_SINGLETON = Object.freeze({
  head: Object.freeze(['head']),
  chest: Object.freeze(['chest']),
  hands: Object.freeze(['hands']),
  legs: Object.freeze(['legs']),
  belt: Object.freeze(['belt']),
  amulet: Object.freeze(['amulet']),
  offHand: Object.freeze(['offHand']),
});

/** `weaponOf`'s fallback — `03-combat-math.md` §4.6 row 1 / `04` §1.4's
 * "never dropped" pseudo-weapon, reshaped as a minimal frozen `ItemInstance`
 * (`01` §5.3 shape) so a caller expecting an item back never has to
 * special-case `null`. Not the same object `WEAPONS.unarmed` in
 * `src/combat/data/weapons.js` is (that table is combat's own frozen
 * fixture, `ARCHITECTURE.md` rule 2 forbids importing it here); this is
 * `items`'s own equivalent, built from the real `unarmed` `ItemBase`. */
const UNARMED_PSEUDO_ITEM = Object.freeze({
  uid: 0, baseId: 'unarmed', rarity: 'normal', ilvl: 1, identified: true, quantity: 1,
  rolls: Object.freeze({ defense: 0, superior: 0, damageMin: 1, damageMax: 3 }),
  affixes: Object.freeze([]), uniqueId: null, uniqueValues: Object.freeze([]),
  nameOverride: null, durability: 0, maxDurability: 0,
  sockets: Object.freeze([]), socketCount: 0,
  grid: null, slot: null, ground: null,
  _cache: Object.freeze({
    stats: null, displayName: 'Unarmed', sellValue: 0, iconCanvas: null, unusable: false,
    weapon: Object.freeze({ minDamage: 1, maxDamage: 3, attackTime: 0.60, handling: 'unarmed' }),
  }),
});

// ---------------------------------------------------------------------------
// slotsFor — 02-api-contracts.md:994
// ---------------------------------------------------------------------------

/**
 * `slotsFor(item) => string[]` — the real legal slot list for `item`, per
 * `ItemBase.slot`/`category`/`weapon.twoHanded`: a ring is legal in `ring1`
 * AND `ring2` (both bases declare `slot: 'ring1'`, `01` §5.4's own
 * `EquipmentSet` — `ItemBase.slot` is a single value and cannot say so, this
 * is the whole reason the method exists); a one-handed weapon is legal in
 * `mainHand` AND `offHand`; a two-hander is `mainHand`-only (equipping it
 * force-vacates `offHand`, `01` §5.4); a shield/off-hand-only armour piece
 * (declares `slot: 'offHand'` directly) is `offHand`-only; everything else
 * maps 1:1; a consumable/quest item (`slot: null`) has no equipment slot at
 * all — `[]`. Zero-allocation: every branch returns a module-level frozen
 * array, never a fresh one.
 * @param {object} item an `ItemInstance`.
 * @returns {ReadonlyArray<string>}
 */
export function slotsFor(item) {
  if (!item) return EMPTY_SLOTS;
  const base = ITEM_BASES_BY_ID[item.baseId];
  if (!base || !base.slot) return EMPTY_SLOTS;
  if (base.slot === 'ring1') return RING_SLOTS;
  if (base.category === 'weapon') {
    return base.weapon && base.weapon.twoHanded ? MAINHAND_ONLY : MAINHAND_OFFHAND;
  }
  return SLOT_SINGLETON[base.slot] || EMPTY_SLOTS;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function makeZeroLayer() {
  const o = {};
  for (let i = 0; i < FIELD_NAMES.length; i++) o[FIELD_NAMES[i]] = 0;
  o.cannotBeFrozen = false;
  return o;
}

function zeroLayer(layer) {
  for (let i = 0; i < FIELD_NAMES.length; i++) layer[FIELD_NAMES[i]] = 0;
  layer.cannotBeFrozen = false;
}

/**
 * @param {object} ctx the engine ctx (see `ItemsSystem.init()`).
 * @param {object} containersState the SAME state bag `createContainerState`
 *   (`./containers.js`, ITEM-10) already built — `equip`/`canEquip` need
 *   `findPlacement`/`autoPlace`/`remove` against the real inventory grid,
 *   and `01` §5.4 draws no distinction between "the items subsystem's
 *   container bookkeeping" and "the items subsystem's equipment bookkeeping"
 *   that would justify two independent grids.
 * @returns {object} the equipment state bag.
 */
export function createEquipmentState(ctx, containersState) {
  return {
    ctx,
    containers: containersState,
    _layer: makeZeroLayer(),
    _modsScratch: [],
    _ownScratch: { strength: 0, dexterity: 0 },
    _checkResult: { ok: false, reason: '' },
    _xyScratch: { x: 0, y: 0 },
    // Reused `ctx.events.emit` payloads (`item:equip`/`item:unequip`,
    // `01-data-model.md`'s events table) — same "preallocated, mutated in
    // place" precedent `./ground.js#_pickupPayload` already sets, so
    // `equip`/`unequip` never build a fresh `{actor,item,slot}` literal per
    // call (their own `Alloc: no` contract row).
    _equipPayload: { actor: null, item: null, slot: null },
    _unequipPayload: { actor: null, item: null, slot: null },
  };
}

/** Resolves `ctx.get('actors')` defensively: `null` when unavailable OR when
 * the resolved object does not actually expose `stats`/`setSourceLayer`/
 * `markDirty` — e.g. a test's minimal `{ player: actor }` stub ctx
 * (`tests/items/containers.test.js`'s own established precedent, reused by
 * `tests/ui/inventory.test.js`). `canEquip`/`equip` treat that the same as
 * "no actors system": a clean `{ok:false, reason:'no_actors'}`, never an
 * uncaught `TypeError` from calling a method that isn't there — a caller
 * like `src/ui/inventory.js#_handleRmb` (UI-6, out of this ticket's file
 * grant) depends on `equip()` failing gracefully, not throwing, to fall
 * through to its own "not available" toast. */
function getActors(state) {
  const ctx = state.ctx;
  if (!ctx || typeof ctx.get !== 'function') return null;
  let actors;
  try {
    actors = ctx.get('actors');
  } catch {
    return null;
  }
  if (!actors || typeof actors.stats !== 'function' || typeof actors.setSourceLayer !== 'function' ||
      typeof actors.markDirty !== 'function') return null;
  return actors;
}

function createEquipmentSet() {
  // `01-data-model.md` §5.4 `EquipmentSet`, verbatim field order.
  return {
    head: null, chest: null, hands: null, legs: null,
    mainHand: null, offHand: null, belt: null,
    amulet: null, ring1: null, ring2: null,
  };
}

function ensureEquipment(actor) {
  if (!actor.equipment) actor.equipment = createEquipmentSet();
  return actor.equipment;
}

function isEquippedSomewhere(equip, uid) {
  if (!equip) return null;
  for (let i = 0; i < SLOT_ORDER.length; i++) {
    const s = SLOT_ORDER[i];
    const it = equip[s];
    if (it && it.uid === uid) return s;
  }
  return null;
}

/** Folds one item's flattened mods (`rolledMods`) into the shared `layer`,
 * per field's aggregation rule — `add`/`add→mul` accumulate identically
 * across items (`01` §4.2's own rule, applied one level down: across items
 * within one layer, not just across layers), `max`/`or` do not. Skips
 * `skillBonuses.*` dotted stats — see file header. */
function foldItemInto(layer, modsScratch, item) {
  const n = rolledMods(item, modsScratch);
  for (let i = 0; i < n; i++) {
    const e = modsScratch[i];
    const stat = e.stat;
    if (!stat || stat.indexOf('.') !== -1) continue; // skillBonuses.* — not folded, see header
    if (!(stat in layer)) continue; // defensive: unknown/unsupported field
    if (AGG_MAX.has(stat)) {
      if (e.value > layer[stat]) layer[stat] = e.value;
    } else if (AGG_OR.has(stat)) {
      layer[stat] = layer[stat] || !!e.value;
    } else {
      layer[stat] += e.value;
    }
  }
}

/** Rebuilds `state._layer` from every currently-equipped item, in
 * `SLOT_ORDER` (`01` §4.2: "in SLOT_ORDER, deterministic"), and returns it —
 * always the same object reference (see file header). */
function rebuildLayer(state, actor) {
  const layer = state._layer;
  zeroLayer(layer);
  const equip = actor.equipment;
  if (equip) {
    for (let i = 0; i < SLOT_ORDER.length; i++) {
      const it = equip[SLOT_ORDER[i]];
      if (it) foldItemInto(layer, state._modsScratch, it);
    }
  }
  return layer;
}

/** The candidate item's OWN strength/dexterity contribution — used by
 * `canEquip` to exclude it from the requirement check when the item is
 * already equipped somewhere (re-slotting, e.g. ring1 -> ring2; see `canEquip`
 * for why a fresh-from-inventory item needs no such subtraction at all). */
function ownAttributeContribution(state, item) {
  const out = state._ownScratch;
  out.strength = 0;
  out.dexterity = 0;
  const n = rolledMods(item, state._modsScratch);
  for (let i = 0; i < n; i++) {
    const e = state._modsScratch[i];
    if (e.stat === 'strength') out.strength += e.value;
    else if (e.stat === 'dexterity') out.dexterity += e.value;
  }
  return out;
}

/** `01` §5.1 armour shield test: an off-hand armour piece with `blockBase >
 * 0` is a shield (`04-items.md`'s `shield_*` bases, verbatim). */
function isShieldBase(base) {
  return !!(base && base.armour && base.armour.blockBase > 0);
}

/** A conservative, non-mutating room PREVIEW for a would-be-displaced item —
 * `findPlacement` against 'inventory' only (displaced gear always returns to
 * the inventory grid, never the stash/belt). Two independently-displaced
 * items in the SAME `canEquip` call (an occupied `mainHand` one-hander AND
 * an occupied `offHand` item, both kicked out by an incoming two-hander) are
 * each checked against the UNCHANGED grid, so this preview can theoretically
 * report success for both even when only one of the two would actually fit
 * (`findPlacement` does not reserve). `equip`'s own commit (below) does not
 * share this blind spot — it places displaced items one at a time for real
 * and rolls back atomically on failure. Flagged in the report. */
function hasRoomFor(state, item) {
  return findPlacementPure(state.containers, 'inventory', item, state._xyScratch) !== null;
}

function fail(state, reason) {
  const r = state._checkResult;
  r.ok = false;
  r.reason = reason;
  return r;
}

function ok(state) {
  const r = state._checkResult;
  r.ok = true;
  r.reason = '';
  return r;
}

// ---------------------------------------------------------------------------
// canEquip — 02-api-contracts.md:988
// ---------------------------------------------------------------------------

/**
 * `canEquip(actor, item, slot) => { ok, reason }`.
 *
 * Requirement check follows `01-data-model.md` §4.4 literally: "Requirements
 * are evaluated before the item's own contribution is summed, so a +20
 * Strength sword can never satisfy its own 40-strength requirement." The
 * item under test is, in the overwhelmingly common case (equipping from the
 * inventory/cursor), simply NOT YET in `actor.equipment` when this runs —
 * `actors.stats(actor)` already reflects a block that excludes it, with no
 * subtraction needed at all. The one case that DOES need an explicit
 * subtraction is re-validating an item that is already equipped somewhere
 * (e.g. previewing a ring1 -> ring2 move) — `ownAttributeContribution`
 * covers that.
 *
 * `requirementBase.strength`/`.dexterity`/`.requirementReduction` are read
 * off the actor's REAL current `StatBlock` (`actors.stats(actor)`), not a
 * from-scratch `base + allocated + equipment-minus-item` recomposition —
 * the only layers this ticket's sanctioned API surface (`stats`,
 * `markDirty`, `setSourceLayer` — ACTR-15) can reach are the full composed
 * block or a wholesale layer replacement, nothing in between. This is a
 * deliberate, documented approximation: it also includes `skills`/`status`/
 * `difficulty` contributions to strength/dexterity/requirementReduction,
 * which `01` §4.4's literal formula does not. No worked example or
 * acceptance clause in this ticket's scope exercises a skill/status/
 * difficulty modifier to strength or dexterity, so this cannot be
 * distinguished from the literal formula by any test today — flagged in the
 * report as an inference, same discipline `src/combat/packet.js`'s own B8
 * comment already follows for an analogous gap.
 *
 * @param {object} state the equipment state bag.
 * @param {object} actor an `Actor` record.
 * @param {object} item an `ItemInstance`.
 * @param {string} slot a `SLOT` value.
 * @returns {{ok:boolean, reason:string}} the SAME reused object every call.
 */
export function canEquip(state, actor, item, slot) {
  if (!actor || !item || !slot) return fail(state, 'invalid');
  const legal = slotsFor(item);
  let legalSlot = false;
  for (let i = 0; i < legal.length; i++) if (legal[i] === slot) { legalSlot = true; break; }
  if (!legalSlot) return fail(state, 'slot');

  const base = ITEM_BASES_BY_ID[item.baseId];
  if (!base) return fail(state, 'unknown_base');

  if (typeof actor.level === 'number' && actor.level < base.reqLevel) return fail(state, 'level');

  const actors = getActors(state);
  if (!actors) return fail(state, 'no_actors');
  const stats = actors.stats(actor);

  let str = stats.strength;
  let dex = stats.dexterity;
  const equip = actor.equipment;
  if (isEquippedSomewhere(equip, item.uid) !== null) {
    const own = ownAttributeContribution(state, item);
    str -= own.strength;
    dex -= own.dexterity;
  }
  const reduction = stats.requirementReduction / 100;
  const reqStr = base.reqStr * (1 - reduction);
  const reqDex = base.reqDex * (1 - reduction);
  if (str < reqStr) return fail(state, 'strength');
  if (dex < reqDex) return fail(state, 'dexterity');

  const isTwoHanded = !!(base.weapon && base.weapon.twoHanded);

  // A two-hander force-vacates offHand (`01` §5.4) — needs room.
  if (slot === 'mainHand' && isTwoHanded) {
    const offHandItem = equip && equip.offHand;
    if (offHandItem && offHandItem.uid !== item.uid && !hasRoomFor(state, offHandItem)) {
      return fail(state, 'no_room_offhand');
    }
  }
  // The reverse: can't slot anything into offHand while a two-hander sits in
  // mainHand (01 §5.4's rule, symmetric — not itself worked-example-tested,
  // a judgment call, see report).
  if (slot === 'offHand') {
    const mh = equip && equip.mainHand;
    const mhBase = mh && ITEM_BASES_BY_ID[mh.baseId];
    if (mhBase && mhBase.weapon && mhBase.weapon.twoHanded && (!mh || mh.uid !== item.uid)) {
      return fail(state, 'twoHanded_mainHand');
    }
  }
  // The target slot's current occupant (a different item) needs room too.
  const occupant = equip && equip[slot];
  if (occupant && occupant.uid !== item.uid && !hasRoomFor(state, occupant)) {
    return fail(state, 'no_room_slot');
  }

  return ok(state);
}

// ---------------------------------------------------------------------------
// equip / unequip — 02-api-contracts.md:985-986
// ---------------------------------------------------------------------------

function detachItem(state, actor, item) {
  const equip = actor.equipment;
  const prevSlot = isEquippedSomewhere(equip, item.uid);
  if (prevSlot) equip[prevSlot] = null;
  if (item.grid && item.grid.container) {
    removeContainerItem(state.containers, item);
  }
  // Cursor: `containers.js` (ITEM-10) owns the cursor slot's state, but
  // exposes no "detach if this specific item is on it" primitive —
  // `takeToCursor`/`returnCursor` both do more (or less) than that. Reading/
  // clearing `state.containers.cursor.item` directly is a same-subsystem
  // state-bag coordination (the two tickets already share this object, see
  // `createEquipmentState`'s own header), not a `containers.js` file edit.
  const cursor = state.containers && state.containers.cursor;
  if (cursor && cursor.item === item) {
    cursor.item = null;
    cursor.originContainer = null;
    cursor.originX = -1;
    cursor.originY = -1;
  }
  item.slot = null;
}

/** Weapon `_cache` view (D-21, `03-combat-math.md` §4.6 / `src/combat/
 * packet.js#resolveWeapon`). Rebuilt every time an item lands in `mainHand`
 * — the one write path this ticket owns; see the report for the full
 * enumeration of paths that could invalidate it. */
export function refreshWeaponCache(item, base) {
  if (!base || base.category !== 'weapon' || !base.weapon) return;
  if (!item._cache) item._cache = { stats: null, displayName: null, sellValue: 0, iconCanvas: null, unusable: false };
  let w = item._cache.weapon;
  if (!w) {
    w = { minDamage: 0, maxDamage: 0, attackTime: 0, handling: '' };
    item._cache.weapon = w;
  }
  const rolls = item.rolls;
  w.minDamage = rolls ? rolls.damageMin : base.weapon.minDamage;
  w.maxDamage = rolls ? rolls.damageMax : base.weapon.maxDamage;
  w.attackTime = base.weapon.attackTime;
  w.handling = base.weapon.handling;
}

function emit(state, name, payload) {
  const ctx = state.ctx;
  if (ctx && ctx.events && typeof ctx.events.emit === 'function') ctx.events.emit(name, payload);
}

/**
 * `equip(actor, item, slot) => { ok, reason }`. Re-validates via `canEquip`
 * first (never trusts a stale caller-side check), then commits atomically:
 * every item displaced by this equip (the target slot's current occupant,
 * and — for an incoming two-hander — the current `offHand` occupant) is
 * placed into the inventory ONE AT A TIME via the real, mutating
 * `autoPlace`; if any placement fails, everything already placed in this
 * call is rolled back and the whole equip fails with no partial state
 * change. This is the authoritative check `canEquip`'s own `hasRoomFor`
 * preview approximates (see that function's header for the double-
 * displacement edge case it does not fully resolve).
 *
 * At most TWO items can ever be displaced in one call (the target slot's
 * occupant, and — only when `slot === 'mainHand'` and the incoming item is
 * two-handed — the `offHand` occupant), so the two "displaced" slots are
 * plain local variables, never a `[]` array — `Alloc: no` (`02-api-
 * contracts.md:985`); a bare `const toDisplace = []` literal allocates on
 * every call regardless of whether anything is ever pushed to it, which an
 * earlier version of this function did (found by this ticket's own
 * `equipment.perf.test.js` probe never converging below 1 byte/call).
 * @param {object} state
 * @param {object} actor
 * @param {object} item
 * @param {string} slot
 * @returns {{ok:boolean, reason:string}}
 */
export function equip(state, actor, item, slot) {
  const check = canEquip(state, actor, item, slot);
  if (!check.ok) return check;

  const equipSet = ensureEquipment(actor);
  const base = ITEM_BASES_BY_ID[item.baseId];
  const isTwoHanded = !!(base.weapon && base.weapon.twoHanded);

  let d1Slot = null;
  let d1Item = null;
  let d2Slot = null;
  let d2Item = null;

  if (slot === 'mainHand' && isTwoHanded && equipSet.offHand && equipSet.offHand.uid !== item.uid) {
    d1Slot = 'offHand';
    d1Item = equipSet.offHand;
  }
  const occupant = equipSet[slot];
  if (occupant && occupant.uid !== item.uid) {
    if (d1Slot === null) {
      d1Slot = slot;
      d1Item = occupant;
    } else {
      d2Slot = slot;
      d2Item = occupant;
    }
  }

  detachItem(state, actor, item);

  if (d1Item) {
    equipSet[d1Slot] = null;
    d1Item.slot = null;
    if (!autoPlaceContainer(state.containers, 'inventory', d1Item)) {
      equipSet[d1Slot] = d1Item;
      d1Item.slot = d1Slot;
      return fail(state, 'no_room');
    }
  }
  if (d2Item) {
    equipSet[d2Slot] = null;
    d2Item.slot = null;
    if (!autoPlaceContainer(state.containers, 'inventory', d2Item)) {
      // Roll back d1 (already placed for real this call), then re-attach
      // d2, and abort with no net state change.
      if (d1Item) {
        // `removeContainerItem` already sets `d1Item.grid.container = null`
        // in place (`./containers.js#remove`'s own behaviour) — no separate
        // `d1Item.grid = null` here, same reasoning as the main commit path
        // below.
        removeContainerItem(state.containers, d1Item);
        equipSet[d1Slot] = d1Item;
        d1Item.slot = d1Slot;
      }
      equipSet[d2Slot] = d2Item;
      d2Item.slot = d2Slot;
      return fail(state, 'no_room');
    }
  }

  equipSet[slot] = item;
  item.slot = slot;
  // Do NOT null `item.grid` wholesale here — `detachItem` above already
  // cleared it the SAME way `./containers.js#remove` does (keep the object
  // alive, set `.container = null`), for the exact reason that file's own
  // header gives: a caller must test `item.grid && item.grid.container`,
  // never truthiness of `item.grid` alone, and doing so here lets a LATER
  // `place()` (from an `unequip()` that puts this same item back into a
  // container) reuse the existing object instead of allocating a fresh
  // `{container,x,y}` — the "already has .grid, place() reuses it"
  // steady-state `place()`'s own header promises. An earlier version of
  // this line unconditionally set `item.grid = null`, discarding that
  // object on every equip and forcing a fresh allocation on every
  // subsequent unequip — found by this ticket's own `equipment.perf.
  // test.js` probe never converging below 1 byte/call.
  item.ground = null;

  if (slot === 'mainHand') refreshWeaponCache(item, base);

  const actors = getActors(state);
  rebuildLayer(state, actor);
  if (actors) {
    actors.setSourceLayer(actor, 'equipment', state._layer);
    // `setSourceLayer` is deliberately a pure forward (`src/actors/index.js`:
    // "Pure forward only — see markDirty above for why this does not also
    // emit stats:dirty") — it sets `actor.statsDirty` but never fires the
    // event. `01-data-model.md` §4.5 / `02-api-contracts.md`'s `items` Emits
    // row both require `stats:dirty {actor}` on equip/unequip, and
    // `markDirty` (ACTR-15's third exposed method) is the one call that
    // both sets the flag AND emits, exactly once — called ONCE here, after
    // `setSourceLayer` already set the flag, so this is not a second,
    // duplicate composition trigger, just the missing event.
    actors.markDirty(actor);
  }

  const payload = state._equipPayload;
  payload.actor = actor;
  payload.item = item;
  payload.slot = slot;
  emit(state, 'item:equip', payload);

  return ok(state);
}

/**
 * `unequip(actor, slot) => boolean`. Moves the item back to the inventory
 * (first fit); a no-op (returns `false`, item stays equipped) when there is
 * no room — never destroys or strands an item.
 * @param {object} state
 * @param {object} actor
 * @param {string} slot
 * @returns {boolean}
 */
export function unequip(state, actor, slot) {
  const equipSet = actor && actor.equipment;
  if (!equipSet || !equipSet[slot]) return false;
  const item = equipSet[slot];
  if (!autoPlaceContainer(state.containers, 'inventory', item)) return false;

  equipSet[slot] = null;
  item.slot = null; // autoPlace's place() already does this; kept explicit

  const actors = getActors(state);
  rebuildLayer(state, actor);
  if (actors) {
    actors.setSourceLayer(actor, 'equipment', state._layer);
    // Same reasoning as `equip()` above — `setSourceLayer` never emits;
    // `markDirty` is the one call that does, exactly once.
    actors.markDirty(actor);
  }

  const payload = state._unequipPayload;
  payload.actor = actor;
  payload.item = item;
  payload.slot = slot;
  emit(state, 'item:unequip', payload);
  return true;
}

// ---------------------------------------------------------------------------
// equipped / weaponOf / hasShield — 02-api-contracts.md:987, ~1000-1001
// ---------------------------------------------------------------------------

/** `equipped(actor, slot) => ItemInstance | null`. */
export function equipped(actor, slot) {
  return (actor && actor.equipment && actor.equipment[slot]) || null;
}

/** `weaponOf(actor) => ItemInstance | null` — `mainHand`, or the unarmed
 * pseudo-item for a player actor with nothing equipped there; `null` for a
 * non-player actor (`01` §2: `equipment` is "kind === 'player' only, else
 * null"). Checked on `actor.kind`, not `actor.equipment` truthiness — a
 * freshly-spawned player has never had `ensureEquipment` lazily build its
 * `EquipmentSet` yet (`actor.equipment` is still `null`), and that must
 * still read as "wielding nothing" (the pseudo-item), not "not a player". */
export function weaponOf(actor) {
  if (!actor || actor.kind !== 'player') return null;
  return (actor.equipment && actor.equipment.mainHand) || UNARMED_PSEUDO_ITEM;
}

/** `hasShield(actor) => boolean`. */
export function hasShield(actor) {
  const oh = actor && actor.equipment && actor.equipment.offHand;
  if (!oh) return false;
  return isShieldBase(ITEM_BASES_BY_ID[oh.baseId]);
}
