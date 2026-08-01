// src/items/roll.js
//
// ITEM-5 — `rollItem` skeleton: the base-group draw (D3), the base draw
// (D4), the quality call (D5), `applyFloor`, `degrade` (§9.5), and the
// `ItemInstance` construction of §9.3 steps 5 and 6 (D7 `rolls.superior`,
// D8 `rolls.defense`).
//
// ---------------------------------------------------------------------------
// THIS FILE IS SHARED WITH ITEM-6 — read this before touching anything below
// ---------------------------------------------------------------------------
// `04-items.md` §9.3's pseudocode (L1912-1990) is one procedure, `rollItem`,
// with eleven numbered steps. This ticket (PROGRESS D-28: `roll.js` is the
// shared filename; the backlog's `affix.js` is the same file under ITEM-6's
// old name) owns steps 3, 5, 6 and the degrade/floor logic of §9.5. ITEM-6
// runs immediately after this ticket and owns steps 7, 8, 9 (the affix-count
// model, the §9.4 filter for *picking*, `sharedRoll` value rolling) — ITEM-7
// owns step 4 (unique substitution, D6) and step 10 (`uniqueValues`, D12);
// ITEM-8 owns step 11 (rare naming, D13); ITEM-9 owns `rollDrop` itself
// (steps 1-2, D1/D2/D14/D15) in its own file, `src/items/drop.js`.
//
// `rollItem` below is therefore deliberately INCOMPLETE: it performs steps
// 3, 5 and 6 verbatim and then returns. The gaps for steps 4 and 7-11 are
// marked with a comment naming the owning ticket and the spec lines — no
// stub function, no placeholder shape, nothing ITEM-6/7/8 has to delete.
// Editing this same function body to fill those gaps, in place, is exactly
// what those tickets are expected to do.
//
// ---------------------------------------------------------------------------
// The two dependency tensions this ticket's brief called out
// ---------------------------------------------------------------------------
// 1. `degrade`'s `unique -> rare` branch (§9.5) needs `uniquePool(base,
//    ilvl)`. The 8 uniques are ITEM-7's data and do not exist in this tree
//    yet, and inventing them here would be exactly the "game content past
//    the shipped lists" this project's rule 13 forbids. `degrade` below
//    takes its pool source through an INJECTABLE hook: a module-level
//    `uniquePoolSource` (default: always returns an empty, frozen array) that
//    ITEM-7 repoints with `setUniquePoolSource(fn)` once its data lands, plus
//    a per-call override (`degrade`'s optional 4th argument) for tests. With
//    the default empty source, `uniquePool(...).length === 0` is ALWAYS true,
//    so the `unique -> rare` branch fires unconditionally whenever quality
//    rolls `'unique'` — which is the spec's own stated correct behaviour
//    below `ilvl 12` ("the unique -> rare branch is only reachable when the
//    whole §6 table is alvl-gated out") widened to hold at every `ilvl`
//    until ITEM-7 wires the real table in. See this ticket's report for the
//    consequence spelled out.
// 2. `degrade`'s `rare -> magic` and `magic -> superior` branches need
//    `legalAffixCount(base, ilvl)`. The 117 affixes DO exist
//    (`src/items/data/affixes.js`, ITEM-2, accepted) and the filter rule is
//    `04` §9.4 (L1993-2012) — `legalAffixCount` below is a COUNTING
//    implementation of that filter (rules 1, 2, 4, 5; rule 3 does not apply
//    here because this function is not filling a specific prefix/suffix
//    slot, and rule 6 does not apply because no affix has been picked yet at
//    the point `degrade` runs — `usedGroups` is empty). ITEM-6 will reuse
//    this exact function when it builds the real picking pool; this ticket
//    does NOT implement picking, only counting.
//
// ---------------------------------------------------------------------------
// D3/D4 — why the base-group weight table lives here, not in `data/`
// ---------------------------------------------------------------------------
// ARCHITECTURE.md rule 9 ("gameplay numbers live in data, not code") would
// normally put `04` §1.3's nine-row weight table in a new
// `src/items/data/basegroups.js`. This ticket's file allowlist is exactly
// three paths — `src/items/roll.js`, `src/items/index.js` (re-export only),
// `tests/items/roll.test.js` — and does not include a new data file; adding
// one anyway is the exact "if you need a file not listed, STOP" case the
// brief calls out. `BASE_GROUPS` below is therefore a plain frozen table
// declared in this file, transcribed verbatim from `04` §1.3, flagged here
// for whoever next touches `src/items/data/` to relocate if the project
// wants the rule held without exception. It is still data, not logic — nine
// literal `{id, weight}` pairs, nothing computed.
//
// ---------------------------------------------------------------------------
// D3/D4 — zero allocation per pick (O-59, O-43/O-23)
// ---------------------------------------------------------------------------
// `rollItem` runs 1.2M times in the lootsim gate (a later ticket). Both
// `rollBaseGroup` and `rollBaseInGroup` below do their weighted pick as two
// manual passes over a PRE-BUILT, module-load-time-frozen array (`GROUP_BASES
// [groupId]`) — summing eligible weight, then re-walking to find the pick —
// instead of calling `Rng.weighted` against a freshly `.filter()`-ed
// candidate array, which would allocate one throwaway array per pick. Group
// eligibility ("does this group have at least one base with `reqLevel <=
// ilvl`") is answered from a precomputed `MIN_REQ_LEVEL[groupId]` (module
// load time), an O(1) comparison, never a per-call scan.
//
// ---------------------------------------------------------------------------
// `uid` is a parameter, not subsystem state
// ---------------------------------------------------------------------------
// `04` §9.3 step 5 writes `uid: nextUid++`, which reads as `ItemsSystem`
// owning a running counter. This ticket may only touch `src/items/index.js`
// as a re-export (no logic — the same precedent ITEM-1/3/4 set), so
// `ItemsSystem` cannot gain a `nextUid` field here. `rollItem` below takes
// `uid` as a plain argument instead: whichever ticket owns the counter
// (`rollDrop`/ITEM-9, most likely, since it is the only caller that loops)
// increments it and passes the next value in. This also keeps `rollItem`
// itself a pure function of its arguments plus the RNG stream, which is
// easier to test and to reason about under the determinism contract.

import { ITEM_BASES, ITEM_BASES_BY_ID } from './data/bases.js';
import { AFFIXES } from './data/affixes.js';
import { UNIQUES } from './data/uniques.js';
import { rollQuality } from './quality.js';
// ITEM-8 — the only addition this ticket makes outside its marked D13
// insertion point (~L765 below): a plain import, required to call into
// `./names.js`'s composer/ring. The insertion point itself is untouched in
// shape; see that comment block for the D-25 ruling this replaces `04`
// §9.3 step 11's superseded three-word form with.
import { rollRareName } from './names.js';

// ---------------------------------------------------------------------------
// `04` §1.6 / `01-data-model.md` §1.6 — rarity ordinal, for `applyFloor`.
// Not re-exported anywhere in the tree as code yet; transcribed verbatim.
// ---------------------------------------------------------------------------
const RARITY_ORDER = Object.freeze(['normal', 'superior', 'magic', 'rare', 'unique']);

// ---------------------------------------------------------------------------
// `04` §1.3 — the base-group table, D3's own data. Weights and shares
// transcribed verbatim; see the file header for why this lives here.
// ---------------------------------------------------------------------------
export const BASE_GROUPS = Object.freeze([
  Object.freeze({ id: 'weapon', weight: 300 }),
  Object.freeze({ id: 'chest', weight: 120 }),
  Object.freeze({ id: 'helm', weight: 110 }),
  Object.freeze({ id: 'gloves', weight: 95 }),
  Object.freeze({ id: 'boots', weight: 95 }),
  Object.freeze({ id: 'ring', weight: 90 }),
  Object.freeze({ id: 'belt', weight: 85 }),
  Object.freeze({ id: 'shield', weight: 65 }),
  Object.freeze({ id: 'amulet', weight: 40 }),
]);

/**
 * Which `04` §1.3 group a base belongs to, or `null` if it is never part of
 * the base-group draw at all (quest, consumable — those enter the drop
 * stream through their own `04` §9.2 rows, D14 and the quest placement
 * `world` does directly, never through D3/D4).
 * @param {object} base - an `ItemBase` record.
 * @returns {string | null}
 */
function baseGroupOf(base) {
  if (base.category === 'weapon' && base.slot === 'mainHand') return 'weapon';
  if (base.category === 'armour') {
    switch (base.slot) {
      case 'chest': return 'chest';
      case 'head': return 'helm';
      case 'hands': return 'gloves';
      case 'legs': return 'boots';
      case 'belt': return 'belt';
      case 'offHand': return 'shield';
      default: return null;
    }
  }
  if (base.category === 'jewelry') {
    if (base.slot === 'ring1') return 'ring';
    if (base.slot === 'amulet') return 'amulet';
    return null;
  }
  return null; // 'quest', 'consumable' — never drawn by D3/D4
}

/**
 * `BASE_GROUPS[].id -> ItemBase[]`, built once at module load, in
 * `ITEM_BASES`' own declaration order (the fixed-order-array determinism
 * `04` §9.4 requires of the affix pool applies equally here — a weighted
 * pick must walk the same order every time for the same draw to mean the
 * same thing). `base.dropWeight <= 0` is excluded here, not filtered per
 * call: that is exactly `unarmed` (pseudo-weapon, `04` §1.4) and
 * `quest_first_tablet` (placed by `world`, never rolled, `04` §1.6) — the
 * two `ITEM_BASES` rows that are not among the 61 real equipment bases this
 * draw is over. Their exclusion here is equivalent to leaving them in with
 * weight 0 (they could never be picked either way — `Rng.weighted`'s
 * subtraction loop never crosses zero on a zero-weight entry) but is
 * clearer to read and keeps every group's list exactly its real
 * `04` §1.4-§1.6 membership.
 *
 * Exported (read-only) so a test can verify group membership directly
 * instead of re-deriving it from `ITEM_BASES` a second, differently-written
 * way for every assertion; the B1/B2-style distribution checks still derive
 * their own expectations independently — see `tests/items/roll.test.js`.
 */
export const GROUP_BASES = Object.freeze(
  (() => {
    const map = Object.create(null);
    for (const g of BASE_GROUPS) map[g.id] = [];
    for (const base of ITEM_BASES) {
      if (base.dropWeight <= 0) continue;
      const g = baseGroupOf(base);
      if (g && map[g]) map[g].push(base);
    }
    const out = Object.create(null);
    for (const g of BASE_GROUPS) out[g.id] = Object.freeze(map[g.id]);
    return out;
  })(),
);

/** `BASE_GROUPS[].id -> number` — the lowest `reqLevel` among that group's
 * real bases, computed once. A group has at least one eligible base at
 * `ilvl` iff `ilvl >= MIN_REQ_LEVEL[groupId]`; this turns "is this group
 * non-empty at this ilvl" (`04` §1.3's redistribution precondition) into one
 * comparison instead of a per-call scan. */
const MIN_REQ_LEVEL = Object.freeze(
  (() => {
    const out = Object.create(null);
    for (const g of BASE_GROUPS) {
      let min = Infinity;
      for (const b of GROUP_BASES[g.id]) if (b.reqLevel < min) min = b.reqLevel;
      out[g.id] = min;
    }
    return out;
  })(),
);

/**
 * D3 — `W(baseGroups)`, filtered to groups with at least one base eligible
 * at `ilvl` (`04` §1.3: "a group whose eligible base list is empty at the
 * current ilvl is skipped and its weight redistributed proportionally over
 * the remaining groups before the draw"). Filtering the candidate set before
 * the weighted sum, rather than assigning an empty group weight 0 and
 * leaving it in, produces exactly that proportional redistribution — it is
 * the same arithmetic `Rng.weighted` would do with the empty group already
 * removed from its input. Exactly one draw (`rng.next()`), zero allocation
 * — see the file header.
 * @param {number} ilvl
 * @param {import('../core/rng.js').Rng} rng - the `items` fork (or a
 *   draw-counting/tagging wrapper around it).
 * @returns {string} a `BASE_GROUPS[].id`.
 */
export function rollBaseGroup(ilvl, rng) {
  let total = 0;
  for (let i = 0; i < BASE_GROUPS.length; i++) {
    if (MIN_REQ_LEVEL[BASE_GROUPS[i].id] <= ilvl) total += BASE_GROUPS[i].weight;
  }
  if (total <= 0) {
    throw new RangeError(`rollBaseGroup: no group has an eligible base at ilvl ${ilvl}`);
  }
  let r = rng.next() * total;
  for (let i = 0; i < BASE_GROUPS.length; i++) {
    const g = BASE_GROUPS[i];
    if (MIN_REQ_LEVEL[g.id] > ilvl) continue;
    r -= g.weight;
    if (r < 0) return g.id;
  }
  // Floating-point rounding at the very top of the range: return the last
  // eligible group, mirroring `Rng`'s own `_weightedTable` fallback.
  for (let i = BASE_GROUPS.length - 1; i >= 0; i--) {
    if (MIN_REQ_LEVEL[BASE_GROUPS[i].id] <= ilvl) return BASE_GROUPS[i].id;
  }
  throw new RangeError(`rollBaseGroup: unreachable — total > 0 but no group matched at ilvl ${ilvl}`);
}

/**
 * D4 — `W(basesInGroup, reqLevel <= ilvl)`, weighted by `dropWeight`. Same
 * two-pass, zero-allocation shape as `rollBaseGroup`. Exactly one draw.
 * @param {string} groupId - a `BASE_GROUPS[].id`, as returned by `rollBaseGroup`.
 * @param {number} ilvl
 * @param {import('../core/rng.js').Rng} rng
 * @returns {object} an `ItemBase` record.
 */
export function rollBaseInGroup(groupId, ilvl, rng) {
  const bases = GROUP_BASES[groupId];
  if (!bases) throw new RangeError(`rollBaseInGroup: unknown group '${groupId}'`);
  let total = 0;
  for (let i = 0; i < bases.length; i++) {
    if (bases[i].reqLevel <= ilvl) total += bases[i].dropWeight;
  }
  if (total <= 0) {
    throw new RangeError(`rollBaseInGroup: group '${groupId}' has no eligible base at ilvl ${ilvl}`);
  }
  let r = rng.next() * total;
  for (let i = 0; i < bases.length; i++) {
    const b = bases[i];
    if (b.reqLevel > ilvl) continue;
    r -= b.dropWeight;
    if (r < 0) return b;
  }
  for (let i = bases.length - 1; i >= 0; i--) {
    if (bases[i].reqLevel <= ilvl) return bases[i];
  }
  throw new RangeError(`rollBaseInGroup: unreachable — total > 0 but no base matched in '${groupId}' at ilvl ${ilvl}`);
}

// ---------------------------------------------------------------------------
// §9.5 — `applyFloor`, verbatim.
// ---------------------------------------------------------------------------

/**
 * `04` §9.5: `RARITY_ORDER.indexOf(r) < RARITY_ORDER.indexOf(floor) ? floor : r`.
 * @param {string} rarity
 * @param {null | 'magic' | 'rare'} floor - a `TreasureClass` entry's `rarityFloor`.
 * @returns {string}
 */
export function applyFloor(rarity, floor) {
  if (!floor) return rarity;
  return RARITY_ORDER.indexOf(rarity) < RARITY_ORDER.indexOf(floor) ? floor : rarity;
}

// ---------------------------------------------------------------------------
// §9.4 — the affix filter, COUNTING form only (see file header, tension 2).
// ---------------------------------------------------------------------------

/** `true` if any element of `a` is also in `b`. No allocation — no `Set`,
 * no derived array; `Array.prototype.includes` itself does not allocate.
 * `a`/`b` are always small, frozen, static arrays (`AffixDefinition
 * .requiresGroups`, `ItemBase.allowedAffixGroups`), so the O(|a|*|b|)
 * worst case is a handful of comparisons in practice. */
function groupsIntersect(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (b.includes(a[i])) return true;
  }
  return false;
}

/**
 * `04` §9.4 rules 1, 2, 4, 5 — how many of the 117 `AFFIXES` are legal for
 * `(base, ilvl)` before any pick has been made. Rule 3 ("kind matches the
 * slot being filled") does not apply: this function is not filling a
 * specific prefix/suffix slot, it is answering `degrade`'s "does at least
 * one/two legal affix(es) exist at all" question, which is what `04` §9.5's
 * own pseudocode calls it for. Rule 6 ("group not already used") does not
 * apply either: at the point `degrade` runs, no affix has been picked yet
 * for this item, so `usedGroups` is always empty.
 *
 * ITEM-6 reuses this exact function for the real picking pool (which DOES
 * need rules 3 and 6, applied on top of this one) — this ticket implements
 * counting only, not picking (this ticket's own brief).
 *
 * @param {object} base - an `ItemBase` record.
 * @param {number} ilvl
 * @returns {number}
 */
export function legalAffixCount(base, ilvl) {
  let count = 0;
  for (let i = 0; i < AFFIXES.length; i++) {
    const affix = AFFIXES[i];
    if (affix.alvl > ilvl) continue;
    if (affix.maxLevel < ilvl) continue;
    if (!affix.appliesTo.includes(base.category)) continue;
    if (!groupsIntersect(affix.requiresGroups, base.allowedAffixGroups)) continue;
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// §9.5 — `degrade`, verbatim, with the unique-pool hook (see file header,
// tension 1).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ITEM-7 — the real unique pool: `04` §6, "the pool filtered by
// `alvl <= ilvl`". `UNIQUES` has no separate `alvl` field (see
// `data/uniques.js`'s own header) — `reqLevel` is numerically identical to
// `alvl` for all 8 shipped rows, so it is the gate value. `base` is accepted
// (matching `setUniquePoolSource`'s `(base, ilvl) => object[]` contract that
// `degrade` already calls, and `null` is a legal, expected value for it —
// `04` §6/§9.2 never conditions the unique pool on which base was drawn,
// only on `ilvl`, so this parameter is read by nothing below) but unused.
// ---------------------------------------------------------------------------

/**
 * `degrade`'s real pool source, and the module's shipped DEFAULT (see the
 * `let uniquePoolSource = uniquePoolAt;` initialiser below — a bare,
 * headless import of this file, exactly `tools/lootsim.mjs`'s (TEST-7)
 * shape, must produce real uniques with zero setup, since the 8
 * `UniqueDefinition` records this ticket ships are no longer conditional on
 * anything). Builds a small (<= 8 entries) filtered array — this only ever
 * runs when the quality roll already produced `'unique'` (a
 * 0.25%-base-rate branch, `04` §4.2), not a per-frame or per-drop hot path,
 * so the allocation here is not the one `rolledMods`'s `Alloc = no` binds.
 * @param {object | null} base - unused, see block header above; `null` is
 *   fine (accepted for signature parity with `setUniquePoolSource`'s
 *   contract, not read).
 * @param {number} ilvl
 * @returns {object[]} the `UniqueDefinition`s eligible at `ilvl`.
 */
export function uniquePoolAt(base, ilvl) {
  const out = [];
  for (let i = 0; i < UNIQUES.length; i++) {
    if (UNIQUES[i].reqLevel <= ilvl) out.push(UNIQUES[i]);
  }
  return out;
}

/**
 * The module-level default unique-pool source `degrade` uses when its own
 * 4th argument is omitted. Defaults to `uniquePoolAt` itself — the real,
 * `reqLevel`-filtered table — not an empty stub: ITEM-5's original stub
 * existed only because the 8 `UniqueDefinition` records did not exist yet
 * in this tree; that reason is gone, and a stub default here would mean a
 * bare `import './roll.js'` (no `ItemsSystem`, no `init()` — exactly how
 * `tools/lootsim.mjs` and any other headless harness reaches this module)
 * silently produces zero uniques forever, which reads exactly like a
 * weight-table bug to anyone auditing a histogram. `uniquePoolAt` is a
 * `function` declaration (hoisted), so referencing it here, above its own
 * textual definition, is safe.
 */
let uniquePoolSource = uniquePoolAt;

/**
 * Repoints the default unique-pool source `degrade` uses when its own 4th
 * argument is omitted. Still the legal way for a test to force an empty
 * pool (`setUniquePoolSource(() => [])`) or to restore the shipped default
 * (`setUniquePoolSource(uniquePoolAt)`) after doing so.
 * @param {(base: object, ilvl: number) => object[]} fn
 */
export function setUniquePoolSource(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('setUniquePoolSource: fn must be a function');
  }
  uniquePoolSource = fn;
}

/**
 * D6 — `04` §9.2: `W(uniquePool where alvl <= ilvl)`. Two-pass,
 * zero-allocation weighted scan over the fixed-order `UNIQUES` array — the
 * same shape as `rollBaseGroup`/`rollBaseInGroup`/`pickAffix` above, and for
 * the same reason (ITEM-6's finding, restated in this ticket's brief):
 * `rng.weighted(table)` calls `Object.keys()` on every call, which allocates.
 * Returns `null`, consuming no draw, if the filtered pool is empty — the
 * caller (`rollItem`'s step 4) must not reach here in that case anyway,
 * since `degrade` already downgraded `'unique' -> 'rare'` whenever
 * `uniquePoolAt(base, ilvl)` is empty, but this function is independently
 * safe either way (`04:1881`, "a draw that is skipped is not consumed").
 * @param {number} ilvl
 * @param {import('../core/rng.js').Rng} rng
 * @returns {object | null} a `UniqueDefinition`, or `null`.
 */
export function pickUnique(ilvl, rng) {
  let total = 0;
  for (let i = 0; i < UNIQUES.length; i++) {
    if (UNIQUES[i].reqLevel <= ilvl) total += UNIQUES[i].dropWeight;
  }
  if (total <= 0) return null;
  let r = rng.next() * total; // D6
  for (let i = 0; i < UNIQUES.length; i++) {
    const u = UNIQUES[i];
    if (u.reqLevel > ilvl) continue;
    r -= u.dropWeight;
    if (r < 0) return u;
  }
  for (let i = UNIQUES.length - 1; i >= 0; i--) {
    if (UNIQUES[i].reqLevel <= ilvl) return UNIQUES[i];
  }
  throw new RangeError('pickUnique: unreachable — total > 0 but no candidate matched');
}

/**
 * `04` §9.5's degrade ladder, verbatim: `unique -> rare -> magic ->
 * superior -> normal`, each step guarded by its own condition, re-evaluated
 * from the top after every downgrade (so a single call can cascade more than
 * one step). `degrade` itself draws nothing from `rng` — it is a pure
 * function of `(rarity, base, ilvl)` plus whichever pool/count sources are
 * in effect.
 *
 * @param {string} rarity
 * @param {object} base - an `ItemBase` record.
 * @param {number} ilvl
 * @param {(base: object, ilvl: number) => object[]} [uniquePoolFn] - override
 *   for this call only; defaults to the module's `uniquePoolSource`
 *   (`setUniquePoolSource`'s target). Tests use this to exercise the
 *   `unique` branch without mutating shared module state.
 * @returns {string}
 */
export function degrade(rarity, base, ilvl, uniquePoolFn) {
  const getPool = uniquePoolFn || uniquePoolSource;
  let r = rarity;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (r === 'unique' && getPool(base, ilvl).length === 0) { r = 'rare'; continue; }
    if (r === 'rare' && legalAffixCount(base, ilvl) < 2) { r = 'magic'; continue; }
    if (r === 'magic' && legalAffixCount(base, ilvl) < 1) { r = 'superior'; continue; }
    if (r === 'superior' && !base.weapon && !base.armour) { r = 'normal'; }
    break;
  }
  return r;
}

// ---------------------------------------------------------------------------
// §9.3 steps 6 (D7/D8) — small named helpers, so a caller/test can exercise
// one roll without going through the whole `rollItem` pipeline.
// ---------------------------------------------------------------------------

/** D7 — `Ui(5, 15)`, `rolls.superior`. Only ever called when `rarity ===
 * 'superior'`; `rollItem` enforces that, not this helper. */
export function rollSuperiorAmount(rng) {
  return rng.int(5, 15);
}

/** D8 — `Ui(defMin, defMax)`, `rolls.defense`. Only ever called when
 * `base.armour` exists; `rollItem` enforces that, not this helper. */
export function rollDefenseAmount(base, rng) {
  return rng.int(base.armour.defMin, base.armour.defMax);
}

// ---------------------------------------------------------------------------
// §9.3 steps 7-9 (ITEM-6) — the affix-count model, picking, value rolling.
// ---------------------------------------------------------------------------
// D9a/D9b/D9c are both written as manual single-branch weighted picks
// (`rollAffixCount`, `rollMagicAffixMode`) rather than `rng.weighted(table)`
// calls: `Rng._weightedTable` does `Object.keys(table)`, a fresh array
// every call, and this runs on every magic/rare drop. Same zero-allocation
// shape ITEM-5's `rollBaseGroup`/`rollBaseInGroup` already established
// above — one arithmetic pass, no intermediate array or table object.
//
// `pickAffix` (D10) is the same two-pass shape again: sum eligible weight
// over the fixed-order `AFFIXES` array, then re-walk to find the draw —
// never a `.filter()`-ed candidate array. This is exactly the
// `usedGroups`-shaped allocation the ticket brief's rule 5 flags by name;
// `usedGroups` itself is a plain array (`.push`/`.includes`, <= 6 entries
// ever), never a `Set`/`Map`. `04:1881` — a draw that is skipped (pool
// empty) is not consumed: `pickAffix` returns `null` before calling
// `rng.next()` in that case, so the caller must not charge a draw for it.
//
// `legalAffixCount` (ITEM-5, reused verbatim) implements §9.4 rules 1, 2,
// 4, 5; `pickAffix` below layers rule 3 (the `kind` parameter — prefix pool
// vs suffix pool are never mixed) and rule 6 (`usedGroups`) on top, per
// ITEM-5's note that this ticket would need exactly that.

/** D9a — `04` §9.3 step 7: `W({prefixOnly: 25, suffixOnly: 25, both: 50})`.
 * One manual weighted branch, zero allocation (see block header above).
 * Exactly one draw.
 * @param {import('../core/rng.js').Rng} rng
 * @returns {'prefixOnly' | 'suffixOnly' | 'both'}
 */
export function rollMagicAffixMode(rng) {
  const r = rng.next() * 100; // D9a
  if (r < 25) return 'prefixOnly';
  if (r < 50) return 'suffixOnly';
  return 'both';
}

/** D9b/D9c — `04` §9.6's affix-count weights, `w1 = 52 - 0.9*min(ilvl,40)`,
 * `w2 = 34 + 0.2*min(ilvl,40)`, `w3 = 14 + 0.7*min(ilvl,40)`, transcribed
 * verbatim. Called once for the prefix count (D9b) and once, independently,
 * for the suffix count (D9c) — PROGRESS D-19: these are two draws, never
 * collapsed into one. Same manual single-pass weighted-branch shape as
 * `rollMagicAffixMode`. Exactly one draw per call.
 * @param {number} ilvl
 * @param {import('../core/rng.js').Rng} rng
 * @returns {1 | 2 | 3}
 */
export function rollAffixCount(ilvl, rng) {
  const lvl = Math.min(ilvl, 40);
  const w1 = 52 - 0.9 * lvl;
  const w2 = 34 + 0.2 * lvl;
  const w3 = 14 + 0.7 * lvl;
  const total = w1 + w2 + w3;
  const r = rng.next() * total; // D9b / D9c
  if (r < w1) return 1;
  if (r < w1 + w2) return 2;
  return 3;
}

/** D10 — `04` §9.4, the full six-rule filter (rules 1/2/4/5 delegated
 * verbatim to `legalAffixCount`'s own conditions, inlined here so the
 * weighted walk can be a single pass; rule 3 is the `kind` parameter; rule
 * 6 is `usedGroups`). Two-pass zero-allocation weighted pick over the
 * fixed-order `AFFIXES` array — see block header above. Returns `null`,
 * consuming no draw, when the filtered pool is empty (skipped, not
 * retried, per `04:1881` / the step-8 pseudocode comment).
 * @param {'prefix' | 'suffix'} kind
 * @param {object} base - an `ItemBase` record.
 * @param {number} ilvl
 * @param {string[]} usedGroups - groups already picked onto this item;
 *   mutated by the caller (`.push`), never by this function.
 * @param {import('../core/rng.js').Rng} rng
 * @returns {object | null} an `AFFIXES` entry, or `null` if none is legal.
 */
export function pickAffix(kind, base, ilvl, usedGroups, rng) {
  let total = 0;
  for (let i = 0; i < AFFIXES.length; i++) {
    const a = AFFIXES[i];
    if (a.kind !== kind) continue;
    if (a.alvl > ilvl) continue;
    if (a.maxLevel < ilvl) continue;
    if (!a.appliesTo.includes(base.category)) continue;
    if (!groupsIntersect(a.requiresGroups, base.allowedAffixGroups)) continue;
    if (usedGroups.includes(a.group)) continue;
    total += a.weight;
  }
  if (total <= 0) return null; // filtered pool empty: skipped, no draw consumed
  let r = rng.next() * total; // D10
  for (let i = 0; i < AFFIXES.length; i++) {
    const a = AFFIXES[i];
    if (a.kind !== kind) continue;
    if (a.alvl > ilvl) continue;
    if (a.maxLevel < ilvl) continue;
    if (!a.appliesTo.includes(base.category)) continue;
    if (!groupsIntersect(a.requiresGroups, base.allowedAffixGroups)) continue;
    if (usedGroups.includes(a.group)) continue;
    r -= a.weight;
    if (r < 0) return a;
  }
  // Floating-point rounding at the very top of the range, same fallback
  // shape as rollBaseGroup/rollBaseInGroup above.
  for (let i = AFFIXES.length - 1; i >= 0; i--) {
    const a = AFFIXES[i];
    if (a.kind !== kind) continue;
    if (a.alvl > ilvl) continue;
    if (a.maxLevel < ilvl) continue;
    if (!a.appliesTo.includes(base.category)) continue;
    if (!groupsIntersect(a.requiresGroups, base.allowedAffixGroups)) continue;
    if (usedGroups.includes(a.group)) continue;
    return a;
  }
  throw new RangeError('pickAffix: unreachable — total > 0 but no candidate matched');
}

/** `04` §9.3's `rollMod(m)`. The spec states it as two textual branches
 * ("`Ui(m.min, m.max)` when `step` is 1 or absent" / "`m.min + m.step ×
 * Ui(0, floor((m.max − m.min) / m.step))` otherwise") — collapsed here into
 * one formula, because for integer bounds with step 1 the two are
 * arithmetically identical, and for the one mod where they are NOT
 * (`sfx_life_regen_1`: `0.4-2.6` authored with `step: 1` — a non-integer
 * range under an integer step) only the lattice form is well-defined, and
 * it is the one that reproduces the documented quirk verbatim: `0.4 + 1 ×
 * Ui(0, floor(2.2/1)) = 0.4 + Ui(0,2)` → exactly `{0.4, 1.4, 2.4}`, `2.6`
 * unreachable. `+1e-9` guards the one fractional-step mod in the table
 * (`sfx_resonance_1`, step `0.1`) against `floor()` clipping a legal top
 * step to floating-point error (`(0.8-0.2)/0.1` evaluates to
 * `6.000000000000001` in IEEE 754, which floors correctly anyway, but the
 * epsilon makes that not-by-luck). Exactly one draw (`rng.int`) either way.
 * @param {{min: number, max: number, step?: number}} m
 * @param {import('../core/rng.js').Rng} rng
 * @returns {number}
 */
export function rollMod(m, rng) {
  const step = m.step === undefined ? 1 : m.step;
  const steps = Math.floor((m.max - m.min) / step + 1e-9);
  return m.min + step * rng.int(0, steps); // D11
}

/** D11 — one `AffixInstance`'s `values`, `01-data-model.md` §5.2 / `04`
 * §2.4's `sharedRoll`. A `sharedRoll` affix draws once and copies the value
 * into every entry of `values`; every other affix draws once per `mods`
 * entry, in array order.
 * @param {object} def - an `AFFIXES` entry (`AffixDefinition`).
 * @param {import('../core/rng.js').Rng} rng
 * @returns {{id: string, kind: string, values: number[]}} an `AffixInstance`.
 */
export function rollAffixInstance(def, rng) {
  const n = def.mods.length;
  const values = new Array(n);
  if (def.sharedRoll) {
    const v = rollMod(def.mods[0], rng); // one draw for the whole affix
    for (let i = 0; i < n; i++) values[i] = v;
  } else {
    for (let i = 0; i < n; i++) values[i] = rollMod(def.mods[i], rng);
  }
  return { id: def.id, kind: def.kind, values };
}

// ---------------------------------------------------------------------------
// `rollItem` — `04` §9.3's procedure. Steps 3, 5, 6 (ITEM-5) and 7, 8, 9
// (ITEM-6) are implemented below, in order. Steps 4 and 11 are ITEM-7's and
// ITEM-8's, marked and left empty — see the file header. Nothing here is a
// stub for them to delete: no fake unique substitution, no invented name.
// ---------------------------------------------------------------------------

/**
 * @param {number} uid - see file header: caller-owned counter, not
 *   subsystem state.
 * @param {number} ilvl
 * @param {number} mlvl
 * @param {string} rank - a `QUALITY_RANK` key (`./quality.js`).
 * @param {'instruction'|'trial'|'renunciation'} difficulty
 * @param {number} magicFind
 * @param {null | 'magic' | 'rare'} rarityFloor - the drawn `TreasureClass`
 *   entry's `rarityFloor` (`04` §5.5/§5.6); pass `null` when the entry
 *   carries none.
 * @param {import('../core/rng.js').Rng} rng - the `items` fork.
 * @returns {object} a partial `ItemInstance` — every field step 5 lists,
 *   `rolls` filled per step 6, `affixes: []` and `uniqueId: null` until
 *   ITEM-6/7 fill them in.
 */
export function rollItem(uid, ilvl, mlvl, rank, difficulty, magicFind, rarityFloor, rng) {
  // --- step 3 (ITEM-5) -----------------------------------------------------
  const group = rollBaseGroup(ilvl, rng); // D3
  let base = rollBaseInGroup(group, ilvl, rng); // D4
  let rarity = rollQuality(ilvl, mlvl, rank, difficulty, magicFind, rng); // D5
  rarity = applyFloor(rarity, rarityFloor); // §5.5, §5.6
  rarity = degrade(rarity, base, ilvl); // §4.4 / §9.5

  // --- step 4 (ITEM-7 — unique substitution, D6) ----------------------------
  let uniqueDef = null;
  if (rarity === 'unique') {
    uniqueDef = pickUnique(ilvl, rng); // D6
    // degrade() above only leaves rarity === 'unique' when
    // uniquePoolAt(base, ilvl) (the same reqLevel <= ilvl filter pickUnique
    // uses) was non-empty, so uniqueDef is never null here in practice; the
    // guard is defensive, matching D-3's "the draw order is unchanged" —
    // no draw is consumed if it were.
    if (uniqueDef) base = ITEM_BASES_BY_ID[uniqueDef.baseId]; // substitution, 04 §14.1 D-3
  }

  // --- step 5 (ITEM-5) — the ItemInstance literal, 01-data-model.md §5.3 --
  const item = {
    uid,
    baseId: base.id,
    rarity,
    ilvl,
    identified: rarity !== 'rare' && rarity !== 'unique',
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

  // --- step 6 (ITEM-5) ------------------------------------------------------
  item.rolls.damageMin = base.weapon ? base.weapon.minDamage : 0;
  item.rolls.damageMax = base.weapon ? base.weapon.maxDamage : 0;
  item.rolls.superior = rarity === 'superior' ? rollSuperiorAmount(rng) : 0; // D7
  item.rolls.defense = base.armour ? rollDefenseAmount(base, rng) : 0; // D8

  // --- step 7 (ITEM-6) — affix-count model, D9a/D9b/D9c --------------------
  let nPre = 0;
  let nSuf = 0;
  if (rarity === 'magic') {
    const mode = rollMagicAffixMode(rng); // D9a
    nPre = mode === 'suffixOnly' ? 0 : 1;
    nSuf = mode === 'prefixOnly' ? 0 : 1;
  } else if (rarity === 'rare') {
    nPre = rollAffixCount(ilvl, rng); // D9b
    nSuf = rollAffixCount(ilvl, rng); // D9c
  }
  // else (normal, superior, unique): nPre = nSuf = 0, no draws — matches
  // step 10's "uniques carry no AffixInstance" (that's ITEM-7's assignment
  // to make, this loop just never runs for them).

  // --- step 8 (ITEM-6) — picking, D10, usedGroups (§9.4 rule 6) -----------
  if (nPre > 0 || nSuf > 0) {
    const usedGroups = [];
    const picked = [];
    for (let i = 0; i < nPre; i++) {
      const def = pickAffix('prefix', base, ilvl, usedGroups, rng); // D10
      if (!def) continue; // empty pool: skipped, not retried
      usedGroups.push(def.group);
      picked.push(def);
    }
    for (let i = 0; i < nSuf; i++) {
      const def = pickAffix('suffix', base, ilvl, usedGroups, rng); // D10
      if (!def) continue;
      usedGroups.push(def.group);
      picked.push(def);
    }

    // --- step 9 (ITEM-6) — value rolling, D11 -----------------------------
    // `picked` is already prefixes-in-pick-order then suffixes-in-pick-order
    // (two separate loops above, never interleaved), so a plain forward walk
    // here reproduces 01-data-model.md §5.2's D11 ordering exactly.
    for (let i = 0; i < picked.length; i++) {
      item.affixes.push(rollAffixInstance(picked[i], rng));
    }
  }

  // --- step 10 (ITEM-7: uniqueValues, D12) ----------------------------------
  if (rarity === 'unique' && uniqueDef) {
    item.uniqueId = uniqueDef.id;
    // item.affixes is already [] from step 5 — uniques carry no AffixInstance.
    const n = uniqueDef.mods.length;
    const values = new Array(n);
    for (let i = 0; i < n; i++) values[i] = rollMod(uniqueDef.mods[i], rng); // D12, array order
    item.uniqueValues = values;
  }

  // --- step 11 (ITEM-8: rare naming, D13) -----------------------------------
  // STALE COMMENT REPLACED — the block this ticket found here still had
  // `04` §9.2/§9.3's SUPERSEDED form: `rng.int(0, 43)` / `rng.int(0, 47)`
  // (44 heads, not 56) plus a third `rng.int(0, 19)` epithet draw gated on
  // `nPre + nSuf >= 5`. PROGRESS D-25 (this ticket's binding ruling,
  // `13-progression-lore.md` §10.3/§10.5) overrides all of it: 56 heads x 48
  // tails, exactly two draws (`Ui(0,55)`, `Ui(0,47)`) plus the 64-entry
  // recent-name ring's redraws — never a third "epithet" word. `nPre`/`nSuf`
  // are therefore NOT read here at all; the `affixCount >= 5` three-word
  // branch they were kept in scope for no longer exists.
  //
  // `rollRareName` (`./names.js`) owns the draws, the ring lookup/redraw
  // loop and the two-language composition; this call site only decides
  // WHEN to draw (`quality === 'rare'`, matching `04` §9.2's own "When"
  // column) and where the result goes.
  //
  // `item.nameOverride` — deviation from `01-data-model.md` §5.3's literal
  // typing of this field as a plain string. That document predates D-25 and
  // was written against `04` §3's single-language-at-a-time assumption;
  // `rollItem`'s signature (fixed by ITEM-5, outside this ticket's edit
  // point) carries no active-language parameter, and `items` may not import
  // `src/ui/i18n.js` to ask for one (`ARCHITECTURE.md` hard rule 2). Baking
  // only one language in at drop time would silently discard the other
  // forever — the opposite of Ruling A's whole point, that `./data/
  // names.js` is the single source of truth for both. Storing the full
  // `{ headIndex, tailIndex, code, en, ru }` object here keeps both display
  // strings and the raw indices available to whichever ticket wires actual
  // UI display / tooltip rendering, at zero extra RNG cost. Flagged for the
  // orchestrator to journal alongside Ruling A.
  if (rarity === 'rare') {
    item.nameOverride = rollRareName(rng); // D13 — 2, 4, 6 or 8 draws, see ./names.js
  }

  return item;
}
