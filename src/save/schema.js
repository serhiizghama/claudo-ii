// src/save/schema.js
//
// SAVE-1 — schema v1 constants and the pure `validate()` engine behind
// `01-data-model.md` §10.3's fifteen invariants (ruling D-27: 16/17 are
// M6/PLYR-5/PLYR-9, not this ticket's — see the bottom of this file for the
// exact boundary). `src/save/index.js` wires this onto `ItemsSystem`
// (`02-api-contracts.md` §16's `validate(obj, version) => { ok, failures }`
// row) — nothing here touches `ctx`, `three`, `document`/`window`, or
// `performance.now()`; this whole file loads and runs in bare Node
// (`tools/check-imports.mjs` now scans `src/save/` as a full root).
//
// ---------------------------------------------------------------------------
// Why the invariants are checked against a `deps` object, not `ctx`
// ---------------------------------------------------------------------------
// `02`'s contracted signature is `validate(obj, version)` — no `ctx`
// parameter. `SaveSystem#validate` (index.js) is the instance method that
// actually matches that contract; it closes over the `items`/`world`
// references it captured in its own `init(ctx)` and forwards them here as a
// plain `deps` bag, so this function can be called directly from a test with
// hand-built `deps` and prove each invariant in isolation, with no live
// engine required.
//
// ---------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------
// Every failure string in the returned array starts with `"invariant N: "`,
// `N` matching §10.3's own numbering — the format this ticket's own tests
// (and, later, `tools/save-fuzz.mjs`, TEST-10) key off to prove a specific
// invariant tripped, not just that "something" did.
//
// ---------------------------------------------------------------------------
// Data this ticket owns vs. data it borrows vs. data it stands in for
// ---------------------------------------------------------------------------
// - `SLOT_ORDER`, `RARITY_AFFIX_RULE`, `DIFFICULTY_ORDER`,
//   `INVENTORY_W/H`, `STASH_W/H`, `BELT_LEN`, `SKILL_LEVEL_RANGE` — copied
//   from `01-data-model.md` §1.5/§1.6/§1.7 and `src/items/containers.js`'s
//   own already-shipped constants (real, load-bearing numbers).
// - `SKILL_REGISTRY` — transcribed VERBATIM from `01-data-model.md` §6.3
//   ("Skill registry — all 30"), which is inside this ticket's authorised
//   reading only by a narrow extension: invariant 12 (`04` — no, `01`
//   §10.3 row 12) cites "the rarity rule (§1.6)", a citation embedded in the
//   very row this ticket IS authorised to read, so resolving it (and the
//   equally-cited class/rarity/skill enumerations sitting a few lines away
//   in the same document) was treated as due diligence on an already-
//   granted row rather than new exploration — flagged in this ticket's
//   report for the orchestrator to confirm or reject.
// - `CLASS_START_ATTRIBUTES` — MIRRORS (copied by value, not imported —
//   ARCHITECTURE.md rule 2) the already-shipped `CLASS_TABLE.start{Str,Dex,
//   Vit,Ene}` rows in `src/actors/stats.js` (ACTR-7, accepted). Real numbers,
//   not invented — but `actors` exposes no public accessor for them
//   (`02-api-contracts.md` §7 lists only `stats`/`markDirty`/
//   `setSourceLayer`), so there is no legal `ctx.get('actors')` path to them
//   yet. `src/actors/stats.js`'s own header already flags this table as
//   "moves to `src/player/data/classes.js` the moment that ticket exists" —
//   this copy moves with it, at the same time.
// - `CLASS_START_SKILL_POINTS` — a single scalar (1), grounded in this
//   ticket's OWN brief, which states plainly that "every class kit
//   pre-spends a skill point" (`13-progression-lore.md` §4, cited verbatim
//   in the invariant-4 row this ticket was handed). No per-class or
//   per-skill breakdown is given anywhere in this ticket's authorised
//   reading, so only the total is used — see invariant 4's own comment.
//   Pinned against `src/actors/stats.js`'s live `CLASS_TABLE` by
//   `tests/save/save1.test.js` (no `ctx.get('actors')` accessor exists to
//   read it directly — `02-api-contracts.md` §7 lists only `stats`/
//   `markDirty`/`setSourceLayer` — so the copy stays, but a test pins it: an
//   edit to either side that drifts turns that test red instead of turning
//   this validator quietly wrong).
//
// ---------------------------------------------------------------------------
// What this file does NOT implement
// ---------------------------------------------------------------------------
// Invariants 16/17 (quest state — `definition.steps.length`,
// `reward.skillsAll`) are not checked here at all — not stubbed, not
// asserted absent.
//
// Invariant 2 is PARTIAL, for the identical reason: its `level ∈ 1..30`
// half needs no external data and is fully checked below, but its
// `experience ≥ XP_TABLE[level] and < XP_TABLE[level+1]` half is DEFERRED.
// No level→XP threshold curve exists anywhere in this codebase or in this
// ticket's authorised reading — a fabricated one was tried, caught, and
// removed (a validator asserting a made-up curve is worse than not
// checking at all: it fails silently, rejecting valid saves and accepting
// invalid ones, until compared against the real curve). The real owner is
// `13-progression-lore.md` §12 ticket L1 — `XP_TABLE` in
// `src/player/data/progression.js`, specified there as "imported from
// `combat`, not copied". That ticket is not in M3. See `checkInvariant2`'s
// own comment for the exact deferred clause.
//
// `01-data-model.md` §10.3 has exactly fifteen rows; this file's own
// `INVARIANT_COUNT` constant is 15 — every row is addressed (checked in
// full, or checked in the part that has real data, per invariant 2 above)
// — checked by this ticket's own test so a future accidental 16th row
// doesn't silently change the contract this file promises. It does NOT
// mean "fifteen invariants fully enforced"; see this ticket's report for
// the exact full/partial breakdown.

// ---------------------------------------------------------------------------
// §10.4 rule 1 — the one field guaranteed to exist forever
// ---------------------------------------------------------------------------
export const SCHEMA_VERSION = 1;

export const INVARIANT_COUNT = 15;

// 01-data-model.md §1.5 "Equipment slots" (SLOT_ORDER, verbatim).
export const SLOT_ORDER = Object.freeze([
  'head', 'chest', 'hands', 'legs', 'mainHand', 'offHand',
  'belt', 'amulet', 'ring1', 'ring2',
]);

// 01-data-model.md §1.6 "Rarities" table — the affix-count rule invariant
// 12 cites by section number. `superior`/`unique` carry zero AffixInstance
// entries: superior's +5..15% lives in `rolls.superior`, not `affixes[]`;
// a unique's mods live in `uniqueValues`, not `affixes[]` (01 §5.3's own
// field comment — "affixes[] cannot hold them, because a unique's mods are
// not affixes").
export const RARITY_AFFIX_RULE = Object.freeze({
  normal:   Object.freeze({ prefixMin: 0, prefixMax: 0, suffixMin: 0, suffixMax: 0, totalMin: 0, totalMax: 0 }),
  superior: Object.freeze({ prefixMin: 0, prefixMax: 0, suffixMin: 0, suffixMax: 0, totalMin: 0, totalMax: 0 }),
  // "1 prefix + 1 suffix, at least one" — up to one of each, at least one total.
  magic:    Object.freeze({ prefixMin: 0, prefixMax: 1, suffixMin: 0, suffixMax: 1, totalMin: 1, totalMax: 2 }),
  // "1-3 prefixes + 1-3 suffixes, total 2-6".
  rare:     Object.freeze({ prefixMin: 1, prefixMax: 3, suffixMin: 1, suffixMax: 3, totalMin: 2, totalMax: 6 }),
  unique:   Object.freeze({ prefixMin: 0, prefixMax: 0, suffixMin: 0, suffixMax: 0, totalMin: 0, totalMax: 0 }),
});

// 01-data-model.md §1.7 "Difficulty tiers".
export const DIFFICULTY_ORDER = Object.freeze(['instruction', 'trial', 'renunciation']);

// 01-data-model.md §1.9 "Classes".
export const CLASS_ID_ORDER = Object.freeze(['ravager', 'emberwright', 'runeblade']);

// src/items/containers.js's own already-shipped constants (ITEM-10),
// restated here by value (not imported — ARCHITECTURE.md rule 2; `items`
// is reached at runtime via `ctx.get('items')` in index.js, never
// `import`-ed by this subsystem). 01-data-model.md §10.2 confirms the same
// numbers for `inventory`/`belt` shape.
export const INVENTORY_W = 10;
export const INVENTORY_H = 4;
export const STASH_W = 10;
export const STASH_H = 8;
export const BELT_LEN = 4;

export const SKILL_LEVEL_MIN = 1;
export const SKILL_LEVEL_MAX = 20;
export const ATTRIBUTE_POINTS_PER_LEVEL = 5;

// ---------------------------------------------------------------------------
// SKILL_REGISTRY — 01-data-model.md §6.3, "Skill registry — all 30",
// transcribed field-for-field (id / classId / tier / requires only — the
// columns invariants 5/6 actually need; `tree`/`type`/`resource` are not
// checked by either invariant and are omitted rather than copied
// speculatively).
// ---------------------------------------------------------------------------
export const SKILL_REGISTRY = Object.freeze([
  Object.freeze({ id: 'cleaving_strike', classId: 'ravager', tier: 1, requires: Object.freeze([]) }),
  Object.freeze({ id: 'bloodletting', classId: 'ravager', tier: 6, requires: Object.freeze([]) }),
  Object.freeze({ id: 'whirlwind', classId: 'ravager', tier: 6, requires: Object.freeze([]) }),
  Object.freeze({ id: 'bloodthirst', classId: 'ravager', tier: 12, requires: Object.freeze([]) }),
  Object.freeze({ id: 'sunder', classId: 'ravager', tier: 18, requires: Object.freeze([Object.freeze({ skillId: 'bloodletting', level: 3 })]) }),
  Object.freeze({ id: 'ram_charge', classId: 'ravager', tier: 1, requires: Object.freeze([]) }),
  Object.freeze({ id: 'shield_stance', classId: 'ravager', tier: 6, requires: Object.freeze([]) }),
  Object.freeze({ id: 'war_cry', classId: 'ravager', tier: 12, requires: Object.freeze([]) }),
  Object.freeze({ id: 'iron_skin', classId: 'ravager', tier: 12, requires: Object.freeze([]) }),
  Object.freeze({ id: 'last_stand', classId: 'ravager', tier: 18, requires: Object.freeze([]) }),
  Object.freeze({ id: 'ember_bolt', classId: 'emberwright', tier: 1, requires: Object.freeze([]) }),
  Object.freeze({ id: 'flame_wave', classId: 'emberwright', tier: 6, requires: Object.freeze([]) }),
  Object.freeze({ id: 'fireball', classId: 'emberwright', tier: 12, requires: Object.freeze([]) }),
  Object.freeze({ id: 'meteor', classId: 'emberwright', tier: 18, requires: Object.freeze([Object.freeze({ skillId: 'fireball', level: 3 })]) }),
  Object.freeze({ id: 'incinerate', classId: 'emberwright', tier: 18, requires: Object.freeze([]) }),
  Object.freeze({ id: 'ashen_step', classId: 'emberwright', tier: 1, requires: Object.freeze([]) }),
  Object.freeze({ id: 'mana_weave', classId: 'emberwright', tier: 6, requires: Object.freeze([]) }),
  Object.freeze({ id: 'smouldering_ward', classId: 'emberwright', tier: 12, requires: Object.freeze([]) }),
  Object.freeze({ id: 'ash_wall', classId: 'emberwright', tier: 12, requires: Object.freeze([]) }),
  Object.freeze({ id: 'essence_burn', classId: 'emberwright', tier: 18, requires: Object.freeze([]) }),
  Object.freeze({ id: 'rune_strike', classId: 'runeblade', tier: 1, requires: Object.freeze([]) }),
  Object.freeze({ id: 'blade_seal', classId: 'runeblade', tier: 1, requires: Object.freeze([]) }),
  Object.freeze({ id: 'cascade', classId: 'runeblade', tier: 6, requires: Object.freeze([]) }),
  Object.freeze({ id: 'phase_leap', classId: 'runeblade', tier: 12, requires: Object.freeze([]) }),
  Object.freeze({ id: 'echo_blade', classId: 'runeblade', tier: 18, requires: Object.freeze([]) }),
  Object.freeze({ id: 'discharge', classId: 'runeblade', tier: 1, requires: Object.freeze([]) }),
  Object.freeze({ id: 'resonance_circuit', classId: 'runeblade', tier: 6, requires: Object.freeze([]) }),
  Object.freeze({ id: 'polarity', classId: 'runeblade', tier: 12, requires: Object.freeze([]) }),
  Object.freeze({ id: 'thunder_step', classId: 'runeblade', tier: 12, requires: Object.freeze([]) }),
  Object.freeze({ id: 'unity', classId: 'runeblade', tier: 18, requires: Object.freeze([]) }),
]);

export const SKILL_REGISTRY_BY_ID = Object.freeze(
  Object.fromEntries(SKILL_REGISTRY.map((s) => [s.id, s])),
);

// ---------------------------------------------------------------------------
// PLACEHOLDER — see this file's header. Mirrors src/actors/stats.js's
// already-shipped CLASS_TABLE.start{Str,Dex,Vit,Ene} rows by value.
// ---------------------------------------------------------------------------
export const CLASS_START_ATTRIBUTES = Object.freeze({
  ravager:     Object.freeze({ strength: 30, dexterity: 20, vitality: 25, energy: 10 }),
  emberwright: Object.freeze({ strength: 15, dexterity: 25, vitality: 15, energy: 35 }),
  runeblade:   Object.freeze({ strength: 22, dexterity: 25, vitality: 20, energy: 22 }),
});

// PLACEHOLDER — see this file's header. The scalar total every class's
// starting kit pre-spends; the specific skill it goes into is not given
// anywhere in this ticket's authorised reading and does not matter to
// invariant 4's formula, which only ever sums the total.
export const CLASS_START_SKILL_POINTS = 1;

/** @param {string} classId @returns {number} */
function classStartAttributeSum(classId) {
  const row = CLASS_START_ATTRIBUTES[classId];
  if (!row) return NaN;
  return row.strength + row.dexterity + row.vitality + row.energy;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function fail(failures, n, msg) {
  failures.push(`invariant ${n}: ${msg}`);
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Every non-null ItemInstance reachable from a CharacterSave (or a
 * StashSave, which only ever contributes `items`), tagged with where it
 * lives. Never a `Map` (ARCHITECTURE.md's Map-leak warning) — a plain
 * array built once per `validate()` call, which is not a per-frame path
 * (this ticket's brief: "validation is not a per-frame path, ... building a
 * readable failure message is fine and wanted").
 *
 * @param {object} obj
 * @returns {{ item: object, location: string, index: number|string }[]}
 */
function collectItems(obj) {
  const out = [];
  if (obj.equipment && typeof obj.equipment === 'object') {
    for (const slot of SLOT_ORDER) {
      const item = obj.equipment[slot];
      if (item) out.push({ item, location: 'equipment', index: slot });
    }
  }
  if (Array.isArray(obj.inventory)) {
    for (let i = 0; i < obj.inventory.length; i++) {
      const item = obj.inventory[i];
      if (item) out.push({ item, location: 'inventory', index: i });
    }
  }
  if (Array.isArray(obj.belt)) {
    for (let i = 0; i < obj.belt.length; i++) {
      const item = obj.belt[i];
      if (item) out.push({ item, location: 'belt', index: i });
    }
  }
  // StashSave's own shape (01 §10.2): `{ schemaVersion, gold, items }`.
  // A CharacterSave never carries this field; included so the same
  // collector serves either shape without a second code path.
  if (Array.isArray(obj.items)) {
    for (let i = 0; i < obj.items.length; i++) {
      const item = obj.items[i];
      if (item) out.push({ item, location: 'stash', index: i });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Invariant checks — one function per row, each pushing `invariant N: ...`
// on failure. Every quoted invariant text below is 01-data-model.md
// §10.3's own row, verbatim, per this ticket's own instructions.
// ---------------------------------------------------------------------------

/** 1 | `schemaVersion` present and ≤ the running `SCHEMA_VERSION` */
function checkInvariant1(obj, version, failures) {
  if (!isInt(obj.schemaVersion)) {
    fail(failures, 1, `schemaVersion must be an integer, got ${JSON.stringify(obj.schemaVersion)}`);
    return;
  }
  if (obj.schemaVersion > version) {
    fail(failures, 1, `schemaVersion ${obj.schemaVersion} exceeds the running SCHEMA_VERSION ${version}`);
  }
}

/** 2 | `level` ∈ 1..30, `experience` ≥ `XP_TABLE[level]` and < `XP_TABLE[level+1]` (level 30: ≥ only)
 *
 * PARTIAL — only the `level ∈ 1..30` half is checked. The `experience`
 * half is DEFERRED: it needs `XP_TABLE`, a level→XP threshold curve that
 * exists nowhere in this codebase or in this ticket's authorised reading.
 * Its real owner is `13-progression-lore.md` §12 ticket L1 —
 * `src/player/data/progression.js`'s `XP_TABLE`, "imported from `combat`,
 * not copied" — which is not in M3. Matches ruling D-27's own treatment of
 * invariants 16/17: `experience` already exists in the save shape; what's
 * missing is the data this check would need, not the field. A synthetic
 * curve was tried and removed — see this file's header — rather than ship
 * a validator that fails silently against invented balance numbers. */
function checkInvariant2(obj, failures) {
  const { level } = obj;
  if (!isInt(level) || level < 1 || level > 30) {
    fail(failures, 2, `level must be an integer in 1..30, got ${JSON.stringify(level)}`);
  }
}

/** 3 | `Σ attributes − Σ classStart + unspentStatPoints === (level − 1) × 5` */
function checkInvariant3(obj, failures) {
  const { attributes, classId, unspentStatPoints, level } = obj;
  if (!attributes || typeof attributes !== 'object') {
    fail(failures, 3, `attributes must be an object`);
    return;
  }
  const sumAttrs = attributes.strength + attributes.dexterity + attributes.vitality + attributes.energy;
  if (!Number.isFinite(sumAttrs)) {
    fail(failures, 3, `attributes.{strength,dexterity,vitality,energy} must all be numbers`);
    return;
  }
  const sumStart = classStartAttributeSum(classId);
  if (!Number.isFinite(sumStart)) {
    fail(failures, 3, `classId '${classId}' has no known starting-attribute row`);
    return;
  }
  if (!isInt(unspentStatPoints)) {
    fail(failures, 3, `unspentStatPoints must be an integer, got ${JSON.stringify(unspentStatPoints)}`);
    return;
  }
  if (!isInt(level)) {
    fail(failures, 3, `level must be an integer to evaluate this invariant`);
    return;
  }
  const lhs = sumAttrs - sumStart + unspentStatPoints;
  const rhs = (level - 1) * 5;
  if (lhs !== rhs) {
    fail(failures, 3, `Σattributes(${sumAttrs}) − ΣclassStart(${sumStart}) + unspentStatPoints(${unspentStatPoints}) = ${lhs}, expected (level−1)×5 = ${rhs}`);
  }
}

/** 4 | `Σ skills.values − Σ classStartSkills + unspentSkillPoints === level − 1`
 * (amended form, 13-progression-lore.md §14 C5 — the `− Σ classStartSkills`
 * term mirrors invariant 3's `− Σ classStart`; see this file's header for
 * where `CLASS_START_SKILL_POINTS` comes from). */
function checkInvariant4(obj, failures) {
  const { skills, unspentSkillPoints, level } = obj;
  if (!skills || typeof skills !== 'object') {
    fail(failures, 4, `skills must be an object`);
    return;
  }
  let sumSkills = 0;
  for (const v of Object.values(skills)) {
    if (!isInt(v)) {
      fail(failures, 4, `skills value ${JSON.stringify(v)} is not an integer`);
      return;
    }
    sumSkills += v;
  }
  if (!isInt(unspentSkillPoints)) {
    fail(failures, 4, `unspentSkillPoints must be an integer, got ${JSON.stringify(unspentSkillPoints)}`);
    return;
  }
  if (!isInt(level)) {
    fail(failures, 4, `level must be an integer to evaluate this invariant`);
    return;
  }
  const lhs = sumSkills - CLASS_START_SKILL_POINTS + unspentSkillPoints;
  const rhs = level - 1;
  if (lhs !== rhs) {
    fail(failures, 4, `Σskills.values(${sumSkills}) − ΣclassStartSkills(${CLASS_START_SKILL_POINTS}) + unspentSkillPoints(${unspentSkillPoints}) = ${lhs}, expected level−1 = ${rhs}`);
  }
}

/** 5 | Every `skills` key exists in the registry and belongs to `classId`; every value ∈ 1..20 */
function checkInvariant5(obj, failures) {
  const { skills, classId } = obj;
  if (!skills || typeof skills !== 'object') return; // already reported by invariant 4
  for (const [skillId, value] of Object.entries(skills)) {
    const def = SKILL_REGISTRY_BY_ID[skillId];
    if (!def) {
      fail(failures, 5, `skill '${skillId}' does not exist in the registry`);
      continue;
    }
    if (def.classId !== classId) {
      fail(failures, 5, `skill '${skillId}' belongs to class '${def.classId}', not '${classId}'`);
    }
    if (!isInt(value) || value < SKILL_LEVEL_MIN || value > SKILL_LEVEL_MAX) {
      fail(failures, 5, `skill '${skillId}' has ${JSON.stringify(value)}, expected an integer in ${SKILL_LEVEL_MIN}..${SKILL_LEVEL_MAX}`);
    }
  }
}

/** 6 | Every skill's `tier` ≤ `level`, and every prerequisite in `requires` is satisfied */
function checkInvariant6(obj, failures) {
  const { skills, level } = obj;
  if (!skills || typeof skills !== 'object' || !isInt(level)) return; // already reported elsewhere
  for (const skillId of Object.keys(skills)) {
    const def = SKILL_REGISTRY_BY_ID[skillId];
    if (!def) continue; // already reported by invariant 5
    if (def.tier > level) {
      fail(failures, 6, `skill '${skillId}' has tier ${def.tier}, character is only level ${level}`);
    }
    for (const req of def.requires) {
      const have = isInt(skills[req.skillId]) ? skills[req.skillId] : 0;
      if (have < req.level) {
        fail(failures, 6, `skill '${skillId}' requires '${req.skillId}' ≥ ${req.level}, character has ${have}`);
      }
    }
  }
}

/** 7 | Every `baseId`, `uniqueId` and affix `id` resolves in the current data tables */
function checkInvariant7(entries, deps, failures) {
  const seen = new Set(); // dedupe identical (baseId) misses across many stacked items — one message per bad id, not one per item
  for (const { item, location, index } of entries) {
    const where = `${location}[${index}]`;
    if (!deps.itemBase(item.baseId)) {
      const key = `base:${item.baseId}`;
      if (!seen.has(key)) {
        seen.add(key);
        fail(failures, 7, `${where}: baseId '${item.baseId}' does not resolve`);
      }
    }
    if (item.uniqueId != null && !deps.itemUnique(item.uniqueId)) {
      fail(failures, 7, `${where}: uniqueId '${item.uniqueId}' does not resolve`);
    }
    if (Array.isArray(item.affixes)) {
      for (const affix of item.affixes) {
        if (!deps.itemAffix(affix.id)) {
          fail(failures, 7, `${where}: affix '${affix.id}' does not resolve`);
        }
      }
    }
  }
}

/** 8 | Every `ItemInstance.uid` is unique across equipment + inventory + belt + stash, and `< nextItemUid` */
function checkInvariant8(obj, entries, failures) {
  const byUid = new Map(); // build-once bookkeeping over the whole save, not a per-frame/pooled path — Map is fine here
  for (const { item, location, index } of entries) {
    const where = `${location}[${index}]`;
    if (!isInt(item.uid)) {
      fail(failures, 8, `${where}: uid must be an integer, got ${JSON.stringify(item.uid)}`);
      continue;
    }
    const prior = byUid.get(item.uid);
    if (prior) {
      fail(failures, 8, `uid ${item.uid} is used by both ${prior} and ${where}`);
    } else {
      byUid.set(item.uid, where);
    }
    if (isInt(obj.nextItemUid) && item.uid >= obj.nextItemUid) {
      fail(failures, 8, `${where}: uid ${item.uid} is not < nextItemUid (${obj.nextItemUid})`);
    }
  }
}

/** 9 | Inventory rectangles are inside 10×4, do not overlap; stash inside 10×8 */
function checkRectangles(entries, container, W, H, deps, failures) {
  const placed = [];
  for (const { item, location, index } of entries) {
    if (location !== container) continue;
    const where = `${location}[${index}]`;
    const grid = item.grid;
    if (!grid || typeof grid.x !== 'number' || typeof grid.y !== 'number') {
      fail(failures, 9, `${where}: missing grid.x/grid.y`);
      continue;
    }
    const base = deps.itemBase(item.baseId);
    if (!base) continue; // already reported by invariant 7 — cannot know its footprint
    const w = base.invW;
    const h = base.invH;
    if (grid.x < 0 || grid.y < 0 || grid.x + w > W || grid.y + h > H) {
      fail(failures, 9, `${where}: rectangle (${grid.x},${grid.y} ${w}x${h}) is outside the ${W}x${H} grid`);
      continue;
    }
    for (const other of placed) {
      const overlaps = grid.x < other.x + other.w && grid.x + w > other.x
        && grid.y < other.y + other.h && grid.y + h > other.y;
      if (overlaps) {
        fail(failures, 9, `${where}: rectangle overlaps ${other.where}`);
      }
    }
    placed.push({ x: grid.x, y: grid.y, w, h, where });
  }
}
/** Extends invariant 9 per this ticket's Ruling 1: `serialiseItem` (ITEM-16)
 * always writes BOTH `grid` and `slot` keys, exactly one non-null — "a
 * missing key and a stale non-null pair are separate, distinctly-reported
 * failures". Not a literal §10.3 row of its own (grid is the only field of
 * the pair that row 9's text names), so it is folded into invariant 9,
 * the row that actually concerns `grid`, rather than invented as an
 * unlisted 16th check. Applies to EVERY item, not just inventory/stash —
 * an equipped item's `grid` must be null and its `slot` must name a real
 * slot; a bagged/belted item's `slot` must be null and its `grid` must be
 * present. Rectangle bounds (`checkRectangles` above) stay inventory/stash
 * -only, matching row 9's own literal text. */
function checkGridSlotExclusivity(entries, failures) {
  for (const { item, location, index } of entries) {
    const where = `${location}[${index}]`;
    const hasGrid = 'grid' in item;
    const hasSlot = 'slot' in item;
    if (!hasGrid || !hasSlot) {
      fail(failures, 9, `${where}: missing the '${!hasGrid ? 'grid' : 'slot'}' key — both must always be present`);
      continue;
    }
    const gridNonNull = item.grid !== null;
    const slotNonNull = item.slot !== null;
    if (location === 'equipment') {
      if (!slotNonNull) {
        fail(failures, 9, `${where}: equipped item has a null slot`);
      }
      if (gridNonNull) {
        fail(failures, 9, `${where}: equipped item has a stale non-null grid`);
      }
    } else {
      if (!gridNonNull) {
        fail(failures, 9, `${where}: bagged item has a null grid`);
      }
      if (slotNonNull) {
        fail(failures, 9, `${where}: bagged item has a stale non-null slot`);
      }
    }
  }
}

function checkInvariant9(entries, deps, failures) {
  checkGridSlotExclusivity(entries, failures);
  checkRectangles(entries, 'inventory', INVENTORY_W, INVENTORY_H, deps, failures);
  checkRectangles(entries, 'stash', STASH_W, STASH_H, deps, failures);
}

/** 10 | Belt entries are `category === 'consumable'` or `null` */
function checkInvariant10(obj, deps, failures) {
  if (!Array.isArray(obj.belt)) return;
  for (let i = 0; i < obj.belt.length; i++) {
    const item = obj.belt[i];
    if (!item) continue;
    const base = deps.itemBase(item.baseId);
    if (!base) continue; // already reported by invariant 7
    if (base.category !== 'consumable') {
      fail(failures, 10, `belt[${i}]: baseId '${item.baseId}' has category '${base.category}', expected 'consumable'`);
    }
  }
}

/** 11 | Two-handed `mainHand` implies `offHand === null` */
function checkInvariant11(obj, deps, failures) {
  const equipment = obj.equipment;
  if (!equipment || !equipment.mainHand) return;
  const base = deps.itemBase(equipment.mainHand.baseId);
  if (!base || !base.weapon) return; // already reported by invariant 7, or not a weapon at all
  if (base.weapon.twoHanded && equipment.offHand !== null && equipment.offHand !== undefined) {
    fail(failures, 11, `mainHand '${equipment.mainHand.baseId}' is two-handed but offHand is not null`);
  }
}

/** 12 | `affixes` length matches the rarity rule (§1.6); `values.length === definition.mods.length` */
function checkInvariant12(entries, deps, failures) {
  for (const { item, location, index } of entries) {
    const where = `${location}[${index}]`;
    const rule = RARITY_AFFIX_RULE[item.rarity];
    if (!rule) {
      fail(failures, 12, `${where}: unknown rarity '${item.rarity}'`);
      continue;
    }
    const affixes = Array.isArray(item.affixes) ? item.affixes : [];
    let prefixCount = 0;
    let suffixCount = 0;
    let otherCount = 0;
    for (const a of affixes) {
      if (a.kind === 'prefix') prefixCount++;
      else if (a.kind === 'suffix') suffixCount++;
      else otherCount++;
    }
    if (otherCount > 0) {
      fail(failures, 12, `${where}: ${otherCount} affix(es) with an unrecognised kind (not 'prefix'/'suffix')`);
    }
    const total = affixes.length;
    if (
      prefixCount < rule.prefixMin || prefixCount > rule.prefixMax
      || suffixCount < rule.suffixMin || suffixCount > rule.suffixMax
      || total < rule.totalMin || total > rule.totalMax
    ) {
      fail(failures, 12, `${where}: rarity '${item.rarity}' has ${prefixCount} prefix/${suffixCount} suffix (total ${total}), does not match the §1.6 rule`);
    }
    for (const a of affixes) {
      const def = deps.itemAffix(a.id);
      if (!def) continue; // already reported by invariant 7
      const gotLen = Array.isArray(a.values) ? a.values.length : -1;
      if (gotLen !== def.mods.length) {
        fail(failures, 12, `${where}: affix '${a.id}' has ${gotLen} values, definition has ${def.mods.length} mods`);
      }
    }
  }
}

/** 13 | `durability` ∈ 0..`maxDurability` */
function checkInvariant13(entries, failures) {
  for (const { item, location, index } of entries) {
    const where = `${location}[${index}]`;
    if (!isInt(item.durability) || !isInt(item.maxDurability)) {
      fail(failures, 13, `${where}: durability/maxDurability must be integers`);
      continue;
    }
    if (item.durability < 0 || item.durability > item.maxDurability) {
      fail(failures, 13, `${where}: durability ${item.durability} is outside 0..${item.maxDurability}`);
    }
  }
}

/** 14 | `difficulty` ∈ `difficultyUnlocked` */
function checkInvariant14(obj, failures) {
  if (!Array.isArray(obj.difficultyUnlocked) || !obj.difficultyUnlocked.includes(obj.difficulty)) {
    fail(failures, 14, `difficulty '${obj.difficulty}' is not in difficultyUnlocked ${JSON.stringify(obj.difficultyUnlocked)}`);
  }
}

/** 15 | `currentZone` resolves; on any failure it falls back to `last_bastion`.
 * `validate()`'s own job is only detection (§10.3's own intro: every row is
 * "checked by save.validate() before the save is handed to the game") — the
 * fallback-to-last_bastion behaviour this row also describes is a `load()`-
 * time repair, not something this function performs; SAVE-2 (M6) owns that.
 */
function checkInvariant15(obj, deps, failures) {
  if (!deps.zoneResolves(obj.currentZone)) {
    fail(failures, 15, `currentZone '${obj.currentZone}' does not resolve`);
  }
}

// ---------------------------------------------------------------------------
// The public engine
// ---------------------------------------------------------------------------

/**
 * `02-api-contracts.md` §16: `validate(obj, version) => { ok, failures }`.
 * Pure — draws no RNG, touches no clock, allocates freely (the contract's
 * own `Alloc: yes` — building a readable failure message is fine and
 * wanted, per this ticket's own brief).
 *
 * @param {object} obj - a `CharacterSave` (or a `StashSave`, for the item-
 *   shaped invariants 7-13 — see `collectItems`'s own comment).
 * @param {number} version - the running `SCHEMA_VERSION` to validate against.
 * @param {{ itemBase: Function, itemAffix: Function, itemUnique: Function, zoneResolves: Function }} deps
 *   - real lookups, supplied by the caller (`SaveSystem#validate` wires
 *   these to `ctx.get('items')`/`ctx.get('world')`; a test wires them to
 *   whatever fixture it needs).
 * @returns {{ ok: boolean, failures: string[] }}
 */
export function validate(obj, version, deps) {
  const failures = [];
  if (!obj || typeof obj !== 'object') {
    fail(failures, 1, 'obj must be an object');
    return { ok: false, failures };
  }

  const entries = collectItems(obj);

  checkInvariant1(obj, version, failures);
  checkInvariant2(obj, failures);
  checkInvariant3(obj, failures);
  checkInvariant4(obj, failures);
  checkInvariant5(obj, failures);
  checkInvariant6(obj, failures);
  checkInvariant7(entries, deps, failures);
  checkInvariant8(obj, entries, failures);
  checkInvariant9(entries, deps, failures);
  checkInvariant10(obj, deps, failures);
  checkInvariant11(obj, deps, failures);
  checkInvariant12(entries, deps, failures);
  checkInvariant13(entries, failures);
  checkInvariant14(obj, failures);
  checkInvariant15(obj, deps, failures);

  return { ok: failures.length === 0, failures };
}

// Real, already-shipped zone ids (src/world/data/zones.js, WRLD-1) — used
// as `SaveSystem`'s fallback `zoneResolves` when `world` is not reachable
// (e.g. an isolated boot with `world` unregistered); the real path always
// prefers `ctx.get('world').descriptor(zoneId)`. Source code, not spec —
// freely readable, not subject to this ticket's spec-range restriction.
export const KNOWN_ZONE_IDS = Object.freeze([
  'last_bastion', 'ashen_wastes', 'bonereach', 'altar_of_instruction',
]);
