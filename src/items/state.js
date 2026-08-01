// src/items/state.js
//
// ITEM-13 — identification and durability (`02-api-contracts.md` §11 "World
// interaction, identification, durability, vendors": `durabilityTick(actor,
// kind)` and `identify(item)`). `04-items.md` §7.4 fixes the loss table;
// `04` §14.1 D-9 fixes the failure mode — an item at 0 durability is
// `unusable`, never destroyed.
//
// This filename is invented: no spec names it (recorded as invented under
// ruling D-28, per this ticket's own brief). `equipment.js`/`ground.js`/
// `containers.js` all own an explicit `state` bag built once in
// `ItemsSystem.init()`; this file follows the identical shape
// (`createDurabilityState(ctx)`), even though its own bag is small (just
// `ctx` and one reused event payload — see below).
//
// ---------------------------------------------------------------------------
// The four rates — 04 §7.4 / D-9, not negotiable, not in data/
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md` rule 9 wants gameplay numbers in `data/`, but this
// ticket's file grant does not include a `data/` file to give these four
// constants a home — the exact situation `./quality.js`, `./containers.js`
// and `./ground.js` already hit and resolved the same way (frozen constants
// local to the owning module, flagged as a deviation). Same precedent here,
// same flag, in this ticket's report.
//
//   attack: 1 durability per 12 landed attacks (attacker's mainHand)
//   hit:    1 durability per 25 hits taken, round-robin over equipped
//           armour (SLOT_ORDER order), skipping indestructible pieces
//   block:  1 durability per 20 blocks, on the shield specifically, IN
//           ADDITION to that same block also feeding the hit-taken
//           round-robin (04 §7.4's own wording — a block is still a hit)
//   death:  ceil(0.08 * maxDurability) on every equipped item
//
// `maxDurability === 0` (the `unarmed` pseudo-item, quest items) is exempt
// from every one of the above (04 §7.4's own table) — checked once, in
// `applyLoss`, so every call site gets it for free.
//
// ---------------------------------------------------------------------------
// Where each accumulator lives — no Map, ever
// ---------------------------------------------------------------------------
// `04` §7.4 says the attack accumulator is "carried in an integer
// accumulator ON THE ITEM so the fractional part is never lost" — and the
// project's own measured-cost rule (this ticket's brief) bans a `Map`
// keyed by item `uid` for exactly this shape (never-repeating keys, ~456
// B/call even with one live entry). So:
//
//   - attack: `item._durAtk` — a plain int field on the mainHand item.
//   - block:  `item._durBlk` — a plain int field on the offHand shield.
//   - hit:    `actor._durHit` (the accumulator) + `actor._durCursor` (the
//     round-robin position) — plain int fields on the actor, the same
//     "write a field directly onto the object we were handed" precedent
//     `equipment.js#ensureEquipment` already sets for `actor.equipment`
//     (no `src/actors/` import anywhere in this file — ARCHITECTURE.md
//     rule 2 — these are reads/writes on an object reference, not a module
//     import).
//
// `actor._durGen` guards the one real hazard of writing state directly onto
// a POOLED actor object (`src/actors/pool.js`, out of this ticket's file
// grant): `resetActorRecord` increments `actor.generation` on every
// despawn/respawn but does not know about (and cannot be taught, without
// editing that file) these two new fields, so a monster's in-progress hit
// count would otherwise leak into whatever spawns into the same pool slot
// next. `ensureActorDurState` below compares `actor._durGen` against the
// CURRENT `actor.generation` (a field this file only ever reads) on every
// 'hit'/'block' tick and resets both counters the moment they disagree —
// self-healing, no `src/actors/pool.js` edit required. Flagged in the
// report as a finding for whoever owns that file next: the clean fix is a
// `01-data-model.md` §11.2-style explicit reset in `resetActorRecord`
// itself, which this ticket cannot make.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import { ITEM_BASES_BY_ID } from './data/bases.js';

// `01-data-model.md` §1.5's `SLOT_ORDER`, verbatim — local, not imported.
// Same duplication precedent `equipment.js`'s own header documents (no file
// in the tree exports it yet, and this ticket's grant has no `data/` file
// to give it a shared home either).
const SLOT_ORDER = Object.freeze([
  'head', 'chest', 'hands', 'legs', 'mainHand', 'offHand',
  'belt', 'amulet', 'ring1', 'ring2',
]);

const ATTACK_THRESHOLD = 12;
const HIT_THRESHOLD = 25;
const BLOCK_THRESHOLD = 20;
const DEATH_PERCENT = 0.08;

/**
 * The durability/identify state bag — built once in `ItemsSystem.init()`,
 * same shape `createContainerState`/`createEquipmentState`/
 * `createGroundState` already use. `_identifyPayload` is the reused
 * `item:identify` emit object (`./ground.js#_pickupPayload`'s "mutated in
 * place, never a fresh literal per emit" precedent, this ticket's brief).
 * `durabilityTick`'s own `stats:dirty` emit goes through
 * `actors.markDirty(actor)` (see `getActors`/`applyLoss` below) — `actors`
 * owns that payload already (`src/actors/index.js#_statsDirtyPayload`), so
 * there is nothing of that shape to reuse here.
 * @param {object} ctx
 * @returns {object}
 */
export function createDurabilityState(ctx) {
  return {
    ctx,
    _identifyPayload: { item: null },
  };
}

function emit(state, name, payload) {
  const ctx = state.ctx;
  if (ctx && ctx.events && typeof ctx.events.emit === 'function') ctx.events.emit(name, payload);
}

/** Resolves `ctx.get('actors')` defensively — `null` when unavailable OR
 * when the resolved object does not actually expose `markDirty`, the one
 * of the three sanctioned `actors` methods (`stats`/`markDirty`/
 * `setSourceLayer`) this file needs. Same "never throw, degrade to a
 * no-op" precedent `equipment.js#getActors` already sets for the identical
 * problem. */
function getActors(state) {
  const ctx = state.ctx;
  if (!ctx || typeof ctx.get !== 'function') return null;
  let actors;
  try {
    actors = ctx.get('actors');
  } catch {
    return null;
  }
  if (!actors || typeof actors.markDirty !== 'function') return null;
  return actors;
}

function isArmourBase(base) {
  return !!(base && base.category === 'armour');
}

/** `01` §5.1 armour shield test — verbatim copy of
 * `equipment.js#isShieldBase` (an off-hand armour piece with
 * `blockBase > 0`); duplicated here for the same "no shared home for this
 * predicate" reason `SLOT_ORDER` above is duplicated. */
function isShieldBase(base) {
  return !!(base && base.armour && base.armour.blockBase > 0);
}

/** Lazily attaches `_cache` in the `01-data-model.md` §5.3 shape — a fresh
 * item out of `rollItem`/`createItem` (`./roll.js`/`./drop.js`) carries no
 * `_cache` at all until something builds one; `equipment.js
 * #refreshWeaponCache` sets exactly this same precedent for a mainHand
 * weapon. Runs at most once per item (a real caller checks `if
 * (!item._cache)` first, same as here), on the rare "just crossed to 0"
 * event, not on every steady-state tick — see this ticket's report on why
 * that keeps `durabilityTick`'s `Alloc: no` contract honest in the
 * no-crossing steady state that dominates real play. */
function ensureCache(item) {
  if (!item._cache) item._cache = { stats: null, displayName: null, sellValue: 0, iconCanvas: null, unusable: false };
  return item._cache;
}

/**
 * Applies `amount` durability loss to `item`, clamped at 0. Marks
 * `_cache.unusable = true` and calls `actors.markDirty(actor)` — which
 * both sets `actor.statsDirty` and emits `stats:dirty {actor}`
 * (`src/actors/index.js#markDirty`'s own contract) — EXACTLY on the call
 * that crosses to 0, never again while already at 0 (this ticket's clause
 * 2/3, and the "two things that will bite you" note in its brief).
 * `maxDurability === 0` items are exempt from all loss (04 §7.4's table);
 * checked here once so every `durabilityTick` case gets it for free.
 * @param {object} state
 * @param {object} actor
 * @param {object} item
 * @param {number} amount
 */
function applyLoss(state, actor, item, amount) {
  if (!item || amount <= 0) return;
  if (!item.maxDurability || item.maxDurability <= 0) return; // indestructible — exempt
  if (item.durability <= 0) { item.durability = 0; return; } // already unusable: silent, no re-emit
  const next = item.durability - amount;
  if (next <= 0) {
    item.durability = 0;
    ensureCache(item).unusable = true;
    const actors = getActors(state);
    if (actors) actors.markDirty(actor);
  } else {
    item.durability = next;
  }
}

/**
 * Ticks a threshold accumulator kept as a plain int field on `obj` (an item
 * for the attack/block causes, an actor for the hit-taken cause) —
 * subtracts the threshold rather than resetting to 0 on the call that
 * crosses it, so a remainder is never lost across repeated crossings (04
 * §7.4: "carried in an integer accumulator ... so the fractional part is
 * never lost"). Returns `true` exactly on a crossing call.
 * @param {object} obj
 * @param {string} field
 * @param {number} threshold
 * @returns {boolean}
 */
function tickAccum(obj, field, threshold) {
  const n = (obj[field] || 0) + 1;
  if (n >= threshold) {
    obj[field] = n - threshold;
    return true;
  }
  obj[field] = n;
  return false;
}

/** Resets the actor's hit-taken accumulator/cursor when the pooled record
 * has been recycled since the last tick (`actor.generation` changed) —
 * see the file header's "no Map, ever" section for why this exists and
 * why it cannot instead live in `src/actors/pool.js`. Also the one-time
 * lazy init for a freshly-spawned actor this file has never touched
 * before. */
function ensureActorDurState(actor) {
  const gen = actor.generation;
  if (actor._durGen !== gen || actor._durHit === undefined) {
    actor._durHit = 0;
    actor._durCursor = 0;
    actor._durGen = gen;
  }
}

/** Round-robin cursor over `actor`'s equipped ARMOUR pieces
 * (`base.category === 'armour'` — head/chest/hands/legs/belt/offHand-
 * shield all qualify, `01` §5.1's category field), in `SLOT_ORDER`,
 * skipping indestructible (`maxDurability === 0`) pieces and empty slots.
 * Advances `actor._durCursor` PAST whichever slot it returns, so the next
 * point lands on a different piece next time (04 §7.4: "round-robin").
 * `null` when no eligible piece is equipped — the accumulated hit is then
 * simply not spent on anything, same as a naked actor taking a hit with no
 * armour to damage.
 * @param {object} actor
 * @returns {object|null}
 */
function nextArmourPiece(actor) {
  const equip = actor.equipment;
  if (!equip) return null;
  const n = SLOT_ORDER.length;
  const start = actor._durCursor || 0;
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    const it = equip[SLOT_ORDER[idx]];
    if (it) {
      const base = ITEM_BASES_BY_ID[it.baseId];
      if (isArmourBase(base) && it.maxDurability > 0) {
        actor._durCursor = (idx + 1) % n;
        return it;
      }
    }
  }
  return null;
}

function tickHitRoundRobin(state, actor) {
  ensureActorDurState(actor);
  if (tickAccum(actor, '_durHit', HIT_THRESHOLD)) {
    const piece = nextArmourPiece(actor);
    if (piece) applyLoss(state, actor, piece, 1);
  }
}

/**
 * `02-api-contracts.md` §11: `durabilityTick(actor, kind:'attack'|'hit'|
 * 'block'|'death') => void` — "`combat` knows a hit landed; `items` owns
 * the accumulator and the `stats:dirty` at zero." `04-items.md` §7.4's
 * table, one case per row:
 *
 *   'attack' — the attacker's own `mainHand` weapon, 1 per 12 landed hits.
 *   'hit'    — the defender's armour round-robin, 1 per 25 hits taken.
 *   'block'  — the defender's shield specifically, 1 per 20 blocks, PLUS
 *              the same armour round-robin 'hit' uses (04 §7.4: "in
 *              addition to").
 *   'death'  — `ceil(0.08 * maxDurability)` applied immediately to every
 *              equipped item (no accumulator — a single event, not a rate).
 *
 * An unrecognised `kind` (or a missing `actor`) is a silent no-op, never a
 * throw — `combat` is a different ticket's file and this call is
 * `Fixed: Y`, reachable from `fixedUpdate`.
 * @param {object} state
 * @param {object} actor
 * @param {'attack'|'hit'|'block'|'death'} kind
 */
export function durabilityTick(state, actor, kind) {
  if (!actor) return;
  const equip = actor.equipment;
  switch (kind) {
    case 'attack': {
      const weapon = equip && equip.mainHand;
      if (weapon && tickAccum(weapon, '_durAtk', ATTACK_THRESHOLD)) {
        applyLoss(state, actor, weapon, 1);
      }
      break;
    }
    case 'hit': {
      tickHitRoundRobin(state, actor);
      break;
    }
    case 'block': {
      const shield = equip && equip.offHand;
      if (shield) {
        const base = ITEM_BASES_BY_ID[shield.baseId];
        if (isShieldBase(base) && tickAccum(shield, '_durBlk', BLOCK_THRESHOLD)) {
          applyLoss(state, actor, shield, 1);
        }
      }
      // "in addition to the armour round-robin" (04 §7.4) — a block is
      // still a hit taken, feeding the SAME accumulator/cursor 'hit' does.
      tickHitRoundRobin(state, actor);
      break;
    }
    case 'death': {
      if (equip) {
        for (let i = 0; i < SLOT_ORDER.length; i++) {
          const it = equip[SLOT_ORDER[i]];
          if (it && it.maxDurability > 0) {
            applyLoss(state, actor, it, Math.ceil(DEATH_PERCENT * it.maxDurability));
          }
        }
      }
      break;
    }
    default:
      break; // unrecognised kind: no-op, never a throw (test-form rule)
  }
}

/**
 * `02-api-contracts.md` §11: `identify(item) => boolean`. Flips
 * `identified` to `true` and emits `item:identify {item}` — the flag
 * `ui`'s already-shipped `09-ui.md` §5.5 rendering (base name, suppressed
 * blocks, the `?` glyph) reads directly (`src/ui/tooltip.js` branches on
 * `item.identified` itself, not on any `items` method — this ticket's
 * report). `false`, no-op, on a missing item or one already identified —
 * never a throw.
 *
 * Does NOT also emit `stats:dirty`, even though `01-data-model.md` §4.5's
 * emitter table lists "identify" alongside "durability reaching 0 or
 * leaving 0" under `items`. Two reasons, both in this ticket's report: (1)
 * `identify(item)`'s contracted signature (`02-api-contracts.md` §11)
 * carries no `actor` to attach to that event's `{actor}` payload, and this
 * file is not permitted to reach for `actors.player` (out of the three
 * sanctioned `actors` methods this ticket's brief grants — a fourth is "a
 * finding to report, not a workaround to build"); (2)
 * `equipment.js#foldItemInto` already folds an item's affix mods into the
 * equipment stat layer regardless of `identified`, so identifying an
 * already-equipped item announces no numeric stat delta an emit would be
 * for.
 * @param {object} state
 * @param {object} item
 * @returns {boolean}
 */
export function identify(state, item) {
  if (!item || item.identified) return false;
  item.identified = true;
  const payload = state._identifyPayload;
  payload.item = item;
  emit(state, 'item:identify', payload);
  return true;
}
