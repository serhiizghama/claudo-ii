// src/actors/stats.js
//
// ACTR-7 — `StatBlock` composition: `01-data-model.md` §3 (the stat
// vocabulary) and §4 (`StatSources` / the ten-step composition order /
// `derive()` / `stats:dirty`), calibrated against `03-combat-math.md` §2.1
// (class table) and §3 (derived-stat formulas). E14 (`03-combat-math.md`
// §12) is the acceptance gate — see tests/actors/stats.test.js.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` scans `src/actors/` with
// `checkGlobals: true`). Pure function, no RNG/clock — `ARCHITECTURE.md`
// rule 4 / `01` §4.2: "it may not touch RNG, the clock or `three`".
//
// ---------------------------------------------------------------------------
// What this file owns, and what it deliberately does not
// ---------------------------------------------------------------------------
// `composeStats(actor)` performs the full ten-step pipeline (01 §4.2) and
// writes into `actor.stats`/`actor.sources`, both preallocated once per
// actor and mutated in place thereafter — never reallocated on a
// recompose (see "Alloc" section below). `stats(actor)`, `markDirty(actor)`
// and `setSourceLayer(actor, layer, partial)` are the three PURE engines
// behind `02-api-contracts.md` §7's "Stats and vessels" row of the same
// names; the public `ActorsSystem` methods that forward to them (with
// `markDirty` additionally emitting `stats:dirty` via `ctx.events`, per
// `ARCHITECTURE.md`'s emitter table) belong in `src/actors/index.js`, which
// this ticket's file list does not include and which is already-accepted,
// committed code owned by another ticket (see this ticket's report — not
// edited here).
//
// Vessel/regen accessor methods (`addLife`, `spend`, `lifeFraction`, ...),
// the action state machine and status-effect application are ACTR-8/9/10 —
// not this ticket, not touched.
//
// ---------------------------------------------------------------------------
// The class table — why it lives here, not in a data/ file
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md` rule 9 wants gameplay numbers in `data/`, not in code —
// but this ticket's file list is exactly `src/actors/stats.js` and its own
// test, no `data/` directory (the same situation ACTR-1's `index.js` header
// documents for `POOL_CAPACITY`, and the same resolution: the table lives
// here, isolated in one clearly-labelled constant, rather than scattered
// through the composition logic, and moves to `src/player/data/classes.js`
// the moment that ticket exists).
//
// Only the subset `derive()`/the base layer actually need is included:
// `baseLife`/`lifePerVit`/`lifePerLevel`/`baseMana`/`manaPerEne`/
// `manaPerLevel`/`baseStamina`/`start{Str,Dex,Vit,Ene}`/`classBaseAR`/
// `manaRegenRate`/`lifeRegenRate` — `03-combat-math.md` §2.1's own
// `attackScale`/`castScale`/`meleeScale`/`spellScale`/`runSpeed`/secondary
// resource/`startGold` columns belong to the combat/skills/player pipeline
// (B-steps, resource caps, movement) and are out of this ticket's scope
// (its own brief: do not read `04-items.md`/`05-skills.md`, and combat's
// B-steps are `src/combat/`'s business, not `actors`'). Whoever builds the
// real class-archetype table should delete this stand-in and point
// `composeStats` at theirs.
//
// A monster actor (`kind !== 'player'`) has `classId === null`
// (`src/actors/pool.js#acquire`) and no bestiary table exists yet either
// (`03-combat-math.md`: "Monsters do not use these formulas — their AR,
// DEF, life and damage come straight from the bestiary row") — AI-owned,
// not this ticket's. `CLASS_TABLE[null]` falls back to `ZERO_CLASS` (every
// parameter 0) so `derive()` still runs the full pipeline safely for a
// monster rather than crashing or branching around it; the resulting
// numbers are not meaningful until AI/bestiary data lands, exactly the
// placeholder discipline `src/actors/motion.js#computeMoveSpeed` already
// uses for the same reason.

/** `03-combat-math.md` §2.1, the columns this ticket's formulas read, plus
 * `baseRage`/`baseResonance` — §2.1's "secondary resource" row (Ravager:
 * Rage 0..100, Runeblade: Resonance 0..3, Emberwright: neither) and §2.4's
 * explicit "`maxRage` base 100" / "`maxResonance` base 3". These are BASE
 * contributions the `base` layer sums into `StatBlock.maxRage`/
 * `.maxResonance` like any other flat term (`01` §3.2: `add` aggregation,
 * caps 200/8) — not a second, competing cap. A class with no secondary
 * resource contributes 0 to the one it lacks, same as any other unused
 * stat; it is not "uncapped", it is simply absent from that class's base.
 *
 * `manaReturnPercent` — SKIL-5's O-84/D-53 named micro-scope, and NOTHING
 * else in this file was touched for it. `03-combat-math.md:223` ("Base
 * `manaReturnPercent` for the Runeblade class is **8**") is the only base
 * this table gives for any class — Ravager and Emberwright are given
 * NOTHING (D-53: "if the spec does not give it, give them nothing and say
 * so" — not invented as some other number). `0` here is not an invented
 * figure; it is the `add`-aggregation identity element, the same role `0`
 * already plays for `baseRage`/`baseResonance` on the two classes that
 * lack those resources, immediately above. Before this, `CLASS_TABLE` had
 * no `manaReturnPercent` row for any class at all, so a really-composed
 * Runeblade read `manaReturnPercent = 0` — SKIL-2 and SKIL-4 could only
 * reproduce `05` §11.3 / E13 by passing the value in by hand
 * (`setSourceLayer`), never by a real `composeStats()` run. See this
 * ticket's report. */
const CLASS_TABLE = Object.freeze({
  ravager: Object.freeze({
    baseLife: 55, lifePerVit: 4.0, lifePerLevel: 2.0,
    baseMana: 10, manaPerEne: 1.0, manaPerLevel: 0.5,
    baseStamina: 60,
    startStr: 30, startDex: 20, startVit: 25, startEne: 10,
    classBaseAR: 30,
    manaRegenRate: 0.020, lifeRegenRate: 0.006,
    baseRage: 100, baseResonance: 0, manaReturnPercent: 0,
  }),
  emberwright: Object.freeze({
    baseLife: 40, lifePerVit: 2.0, lifePerLevel: 1.0,
    baseMana: 25, manaPerEne: 2.5, manaPerLevel: 2.0,
    baseStamina: 54,
    startStr: 15, startDex: 25, startVit: 15, startEne: 35,
    classBaseAR: 0,
    manaRegenRate: 0.040, lifeRegenRate: 0.006,
    baseRage: 0, baseResonance: 0, manaReturnPercent: 0,
  }),
  runeblade: Object.freeze({
    baseLife: 45, lifePerVit: 3.0, lifePerLevel: 1.5,
    baseMana: 18, manaPerEne: 1.75, manaPerLevel: 1.25,
    baseStamina: 57,
    startStr: 22, startDex: 25, startVit: 20, startEne: 22,
    classBaseAR: 25,
    manaRegenRate: 0.030, lifeRegenRate: 0.006,
    baseRage: 0, baseResonance: 3, manaReturnPercent: 8, // 03 §2.4 — O-84/D-53
  }),
});

/** See the file header — the monster/no-class fallback. */
const ZERO_CLASS = Object.freeze({
  baseLife: 0, lifePerVit: 0, lifePerLevel: 0,
  baseMana: 0, manaPerEne: 0, manaPerLevel: 0,
  baseStamina: 0,
  startStr: 0, startDex: 0, startVit: 0, startEne: 0,
  classBaseAR: 0,
  manaRegenRate: 0, lifeRegenRate: 0,
  baseRage: 0, baseResonance: 0, manaReturnPercent: 0,
});

// ---------------------------------------------------------------------------
// The stat vocabulary — 01-data-model.md §3, all 90 numeric fields
// ---------------------------------------------------------------------------
// Order matches the spec's own §3.1-3.5 grouping. `cannotBeFrozen` (the one
// flag) and `skillBonuses` (the one structured record) are handled outside
// this list — see `createStatBlock()`.

const FIELD_NAMES = Object.freeze([
  // 3.1 primary attributes
  'strength', 'dexterity', 'vitality', 'energy',
  // 3.2 vessels and regeneration
  'maxLife', 'lifePercent', 'maxMana', 'manaPercent', 'maxRage', 'maxResonance', 'maxStamina',
  'lifeRegen', 'lifeRegenPercent', 'manaRegen', 'manaRegenPercent', 'staminaRegen',
  // 3.3 offence
  'minDamage', 'maxDamage', 'enhancedDamage', 'attackRating', 'attackRatingPercent',
  'increasedAttackSpeed', 'fasterCastRate', 'critChance', 'critMult',
  'fireMin', 'fireMax', 'coldMin', 'coldMax', 'lightMin', 'lightMax', 'poisonMin', 'poisonMax', 'magicMin', 'magicMax',
  'coldDuration', 'poisonDuration',
  'fireDamagePercent', 'coldDamagePercent', 'lightDamagePercent', 'poisonDamagePercent', 'magicDamagePercent',
  'elementalDamagePercent', 'physicalDamagePercent',
  'fireResistPierce', 'coldResistPierce', 'lightResistPierce', 'poisonResistPierce',
  'lifeSteal', 'manaSteal', 'lifeOnHit', 'manaOnHit', 'lifeOnKill', 'manaOnKill',
  'manaReturnPercent', 'pierceChance', 'knockbackChance', 'thorns', 'rageOnHit', 'rageOnTakeHit', 'resonanceOnHit',
  // 3.4 defence
  'defense', 'defensePercent', 'blockChance', 'dodgeChance',
  'fireResist', 'coldResist', 'lightResist', 'poisonResist', 'magicResist', 'physicalResist',
  'maxFireResist', 'maxColdResist', 'maxLightResist', 'maxPoisonResist', 'maxMagicResist', 'maxPhysicalResist',
  'damageReduceFlat', 'damageReducePercent', 'magicDamageReduceFlat', 'fasterHitRecovery', 'ccReduction',
  // 3.5 utility
  'movementSpeed', 'magicFind', 'goldFind', 'manaCostReduction', 'lightRadius', 'requirementReduction', 'damageTakenToMana', 'experienceGain',
]);

/** `01` §3.6: 90 numeric fields. Kept as a live check, not a comment. */
if (FIELD_NAMES.length !== 90) {
  throw new Error(`actors/stats: FIELD_NAMES must hold exactly 90 fields (01-data-model.md §3.6), got ${FIELD_NAMES.length}`);
}

/** Zero unless noted. `critMult`'s own range is `100..600` (100% = no
 * bonus, per its Sheet-Y row) and the six `max*Resist` stats "default to
 * 75" (`01` §3.4's own prose, restated at line ~584) — both defaults are
 * `zero()`'s job, not a layer's; every other field's spec-documented "base
 * value" is 0.
 *
 * Built zero-fill-first, THEN the seven non-zero overrides applied on top —
 * not the other way round. An earlier version passed the override object
 * as the reducer's seed (`acc`) and then walked `FIELD_NAMES` setting
 * `acc[key] = 0` for every field; since all seven overridden keys are
 * themselves in `FIELD_NAMES`, that walk clobbered every one of them back
 * to 0 (found when CMBT-4 read `maxFireResist === 0` off a freshly-composed
 * block — see this ticket's report). Applying the overrides AFTER the
 * zero-fill, on a plain `{}` seed, cannot suffer that: nothing later
 * touches these seven keys again. */
const DEFAULTS = Object.freeze(
  Object.assign(
    FIELD_NAMES.reduce((acc, key) => {
      acc[key] = 0;
      return acc;
    }, {}),
    {
      critMult: 100,
      maxFireResist: 75,
      maxColdResist: 75,
      maxLightResist: 75,
      maxPoisonResist: 75,
      maxMagicResist: 75,
      maxPhysicalResist: 75,
    },
  ),
);

/** `01` §3's Aggregation column: everything not listed here is `add` or
 * `add→mul`, which `01` §4.2 says "accumulate identically" during
 * composition (the difference is only where the sum is later used, e.g.
 * `enhancedDamage`'s sum becomes a damage-pipeline multiplier — B3, not
 * this ticket's business). Only `max` and `or` fields need a different
 * accumulation rule here. */
const AGG_MAX = new Set(['lightRadius']);
const AGG_OR = new Set(['cannotBeFrozen']);

/**
 * `01` §3's Cap column, `[lo, hi]`, for every field with a concrete numeric
 * cap. Fields absent from this table are either genuinely uncapped ("—") or
 * are one of the six dynamic resist stats (`fireResist`, ...), whose cap is
 * its own `max*Resist` companion field, not a constant — see
 * `RESIST_CAP_PAIRS` and `clampBlock()` below. `attackRating`/`defense`
 * clamp to `>= 0` per `01` §4.3 (a `derive()`-time rule, not this table);
 * both have Cap `—` here on purpose.
 */
const CAPS = Object.freeze({
  strength: [1, 600], dexterity: [1, 600], vitality: [1, 600], energy: [1, 600],
  maxLife: [1, 40000], lifePercent: [-90, 500], maxMana: [0, 20000], manaPercent: [-90, 500],
  maxRage: [0, 200], maxResonance: [0, 8], maxStamina: [0, 2000],
  lifeRegenPercent: [-100, 20], manaRegenPercent: [-100, 20],
  enhancedDamage: [-100, 2000],
  attackRatingPercent: [-100, 500], increasedAttackSpeed: [-75, 300], fasterCastRate: [-75, 200],
  critChance: [0, 75], critMult: [100, 600],
  coldDuration: [0, 8], poisonDuration: [0, 12],
  fireDamagePercent: [-100, 1000], coldDamagePercent: [-100, 1000], lightDamagePercent: [-100, 1000],
  poisonDamagePercent: [-100, 1000], magicDamagePercent: [-100, 1000],
  elementalDamagePercent: [-100, 1000], physicalDamagePercent: [-100, 1000],
  fireResistPierce: [0, 150], coldResistPierce: [0, 150], lightResistPierce: [0, 150], poisonResistPierce: [0, 150],
  lifeSteal: [0, 100], manaSteal: [0, 100],
  manaReturnPercent: [0, 100], pierceChance: [0, 100], knockbackChance: [0, 100],
  rageOnHit: [0, 40], rageOnTakeHit: [0, 40], resonanceOnHit: [0, 4],
  defensePercent: [-100, 1000],
  blockChance: [0, 75], dodgeChance: [0, 50],
  maxFireResist: [0, 90], maxColdResist: [0, 90], maxLightResist: [0, 90],
  maxPoisonResist: [0, 90], maxMagicResist: [0, 90], maxPhysicalResist: [0, 90],
  damageReducePercent: [0, 50],
  fasterHitRecovery: [-75, 400], ccReduction: [0, 75],
  movementSpeed: [-90, 200], magicFind: [0, 1000], goldFind: [0, 2000], manaCostReduction: [0, 75],
  lightRadius: [0, 14], requirementReduction: [0, 80], damageTakenToMana: [0, 40], experienceGain: [-100, 200],
});

const CAP_ENTRIES = Object.freeze(
  Object.keys(CAPS).map((key) => Object.freeze({ key, lo: CAPS[key][0], hi: CAPS[key][1] })),
);

/** The six dynamic resist/cap pairs — `01` §3.4: "the only way to exceed
 * [75%]... they themselves cap at 90. Negative resistance from difficulty
 * is applied to the resist stat, not the cap." Lower bound `-200` is each
 * resist stat's own Range column. */
const RESIST_CAP_PAIRS = Object.freeze([
  Object.freeze({ resist: 'fireResist', cap: 'maxFireResist' }),
  Object.freeze({ resist: 'coldResist', cap: 'maxColdResist' }),
  Object.freeze({ resist: 'lightResist', cap: 'maxLightResist' }),
  Object.freeze({ resist: 'poisonResist', cap: 'maxPoisonResist' }),
  Object.freeze({ resist: 'magicResist', cap: 'maxMagicResist' }),
  Object.freeze({ resist: 'physicalResist', cap: 'maxPhysicalResist' }),
]);
const RESIST_LOWER_BOUND = -200;

/** Only these four layers are externally settable — `02-api-contracts.md`
 * §7's own `setSourceLayer` signature. `base`/`allocated` are computed
 * fresh by `composeStats` every recompose (see steps 2/3 below) from
 * `actor.classId`/`actor.level`/`actor.attributes` — nothing else can set
 * them, so they are deliberately absent from this set. */
const SETTABLE_LAYERS = new Set(['equipment', 'skills', 'status', 'difficulty']);

/** Number of composition steps `composeStats` performs — `01` §4.2's own
 * ten-step list. Exported so a test can assert against the *name*, not a
 * magic `10`. */
export const COMPOSITION_STEP_COUNT = 10;

// ---------------------------------------------------------------------------
// StatBlock — one preallocated instance per actor, mutated in place
// ---------------------------------------------------------------------------

/**
 * A fresh `StatBlock`, every numeric field at its `zero()` default (see
 * `DEFAULTS`), `cannotBeFrozen: false`, `skillBonuses: {all:0,tree:{},
 * skill:{}}`. Built once per actor (lazily, on that actor's first
 * `composeStats`/`stats()` call — see those functions) and mutated in place
 * on every recompose thereafter; never reallocated.
 * @returns {object}
 */
function createStatBlock() {
  const block = {};
  for (let i = 0; i < FIELD_NAMES.length; i++) {
    const key = FIELD_NAMES[i];
    block[key] = DEFAULTS[key];
  }
  block.cannotBeFrozen = false;
  block.skillBonuses = { all: 0, tree: {}, skill: {} };
  return block;
}

/**
 * A fresh `StatSources` (`01` §4.1) — `base`/`allocated` are plain objects
 * `composeStats` overwrites in place every call (steps 2/3);
 * `equipment`/`skills`/`status`/`difficulty` start empty and are only ever
 * replaced wholesale by `setSourceLayer`.
 * @returns {object}
 */
function createEmptySources() {
  return {
    base: {
      strength: 0, dexterity: 0, vitality: 0, energy: 0,
      lifeRegenPercent: 0, manaRegenPercent: 0, maxRage: 0, maxResonance: 0,
      manaReturnPercent: 0, // O-84/D-53 — Runeblade class base only, see CLASS_TABLE's own comment
    },
    allocated: { strength: 0, dexterity: 0, vitality: 0, energy: 0 },
    equipment: {},
    skills: {},
    status: {},
    difficulty: {},
  };
}

/** Resets every `StatBlock` field to its `zero()` default — step 1.
 * Mutates `block` in place; never allocates (the `skillBonuses` sub-object
 * is cleared key-by-key, not replaced). */
function zeroBlock(block) {
  for (let i = 0; i < FIELD_NAMES.length; i++) {
    const key = FIELD_NAMES[i];
    block[key] = DEFAULTS[key];
  }
  block.cannotBeFrozen = false;
  const sb = block.skillBonuses;
  sb.all = 0;
  for (const k in sb.tree) delete sb.tree[k];
  for (const k in sb.skill) delete sb.skill[k];
}

/** Adds `partial.skillBonuses` (if present) into `target` per `01` §3.5:
 * "Aggregation for SkillBonuses is `add` at each of the three levels." */
function applySkillBonuses(target, partial) {
  if (!partial) return;
  target.all += partial.all || 0;
  if (partial.tree) {
    for (const t in partial.tree) target.tree[t] = (target.tree[t] || 0) + partial.tree[t];
  }
  if (partial.skill) {
    for (const s in partial.skill) target.skill[s] = (target.skill[s] || 0) + partial.skill[s];
  }
}

/** Sums one layer's partial `StatBlock` into `block`, per `01` §4.2: "`add`
 * and `add→mul` accumulate identically here"; `max` takes the running
 * maximum; `or` ORs. Iterates the PARTIAL's own keys (typically a handful),
 * never all 90 fields — this is what keeps an empty/sparse layer (a
 * monster's `equipment: {}`) free. */
function applyLayer(block, partial) {
  for (const key in partial) {
    if (key === 'skillBonuses') {
      applySkillBonuses(block.skillBonuses, partial.skillBonuses);
      continue;
    }
    const v = partial[key];
    if (AGG_MAX.has(key)) {
      if (v > block[key]) block[key] = v;
    } else if (AGG_OR.has(key)) {
      block[key] = block[key] || v;
    } else {
      block[key] += v;
    }
  }
}

/**
 * `derive()` — step 8, `01` §4.3 / `03-combat-math.md` §3, verbatim. Reads
 * the composed primary attributes and the Σ-flat terms layers 2-7 already
 * summed into `block`, then OVERWRITES the seven derived fields (never
 * leaves a field reachable by both the summed path and this one — see the
 * file's own binding rule from the ticket brief). `lifeRegen`/`manaRegen`
 * are the two exceptions that `+=` onto their own flat sum rather than
 * replacing it (`01` §4.3's own `+=` in the formula).
 */
function derive(block, classRow, level) {
  const vitality = block.vitality;
  const energy = block.energy;
  const dexterity = block.dexterity;

  const flatMaxLife = block.maxLife;
  const flatMaxMana = block.maxMana;
  const flatMaxStamina = block.maxStamina;
  const flatAR = block.attackRating;
  const flatDefense = block.defense;
  const flatLifeRegen = block.lifeRegen;
  const flatManaRegen = block.manaRegen;

  const maxLife = (classRow.baseLife + (vitality - classRow.startVit) * classRow.lifePerVit
    + (level - 1) * classRow.lifePerLevel + flatMaxLife) * (1 + block.lifePercent / 100);
  const maxMana = (classRow.baseMana + (energy - classRow.startEne) * classRow.manaPerEne
    + (level - 1) * classRow.manaPerLevel + flatMaxMana) * (1 + block.manaPercent / 100);
  const maxStamina = classRow.baseStamina + vitality * 1.0 + (level - 1) * 1.0 + flatMaxStamina;

  let attackRating = (classRow.classBaseAR + 5 * (dexterity - 7) + flatAR) * (1 + block.attackRatingPercent / 100);
  if (attackRating < 0) attackRating = 0; // 01 §4.3: "attackRating clamps to >= 0"

  let defense = flatDefense * (1 + block.defensePercent / 100) + Math.floor(dexterity / 4);
  if (defense < 0) defense = 0; // 01 §4.3: "defense clamps to >= 0"

  block.maxLife = maxLife;
  block.maxMana = maxMana;
  block.maxStamina = maxStamina;
  block.attackRating = attackRating;
  block.defense = defense;
  block.lifeRegen = flatLifeRegen + maxLife * block.lifeRegenPercent / 100;
  block.manaRegen = flatManaRegen + maxMana * block.manaRegenPercent / 100;
}

/** `clamp()` — step 9, every Cap column in `01` §3, plus the six dynamic
 * resist/cap pairs (see `RESIST_CAP_PAIRS`'s own comment). Runs the static
 * `CAP_ENTRIES` pass first so the six `max*Resist` fields are already
 * clamped to `[0,90]` by the time the resist pass reads them. */
function clampBlock(block) {
  for (let i = 0; i < CAP_ENTRIES.length; i++) {
    const e = CAP_ENTRIES[i];
    const v = block[e.key];
    if (v < e.lo) block[e.key] = e.lo;
    else if (v > e.hi) block[e.key] = e.hi;
  }
  for (let i = 0; i < RESIST_CAP_PAIRS.length; i++) {
    const p = RESIST_CAP_PAIRS[i];
    const hi = block[p.cap];
    const v = block[p.resist];
    if (v < RESIST_LOWER_BOUND) block[p.resist] = RESIST_LOWER_BOUND;
    else if (v > hi) block[p.resist] = hi;
  }
}

/**
 * The ten-step composition pipeline (`01` §4.2), writing into
 * `actor.stats`/`actor.sources` in place. Both are allocated lazily —
 * exactly once per actor, the first time this (or `stats()`) ever runs for
 * it — and mutated thereafter; a recompose never allocates a fresh block,
 * satisfying `02-api-contracts.md` §7's `stats` row (`Alloc: no`) and this
 * ticket's own µs budget without fighting GC pressure on every dirty
 * recompute.
 *
 * @param {object} actor an `Actor` record (`src/actors/pool.js`'s shape) —
 *   needs `classId`, `level`, `attributes` (`allocated` layer's raw spent
 *   points) and `stats`/`sources`/`statsDirty` (all present on every pooled
 *   record, per `pool.js#createActorRecord`).
 * @returns {number} `COMPOSITION_STEP_COUNT` (10) once every step has run.
 *   A primitive, not a fresh array/object — proof-of-work for the ≤40µs/
 *   ≤6µs budget test (this ticket's rule 12) without itself allocating. A
 *   future regression that returns early (skips a step) would return
 *   something other than 10, or throw before returning at all — either way
 *   a paired `=== 10` assertion catches a "fast because it bailed" bug the
 *   same class as NAV-2's.
 */
export function composeStats(actor) {
  if (!actor.stats) actor.stats = createStatBlock();
  if (!actor.sources) actor.sources = createEmptySources();

  const block = actor.stats;
  const sources = actor.sources;
  let steps = 0;

  // 1. zero()
  zeroBlock(block);
  steps++;

  // 2. += base — class archetype × level (01 §4.1: "monsters: archetype ×
  // mlvl tables", not this ticket's table; see ZERO_CLASS above).
  const classRow = CLASS_TABLE[actor.classId] || ZERO_CLASS;
  const base = sources.base;
  base.strength = classRow.startStr;
  base.dexterity = classRow.startDex;
  base.vitality = classRow.startVit;
  base.energy = classRow.startEne;
  base.lifeRegenPercent = classRow.lifeRegenRate * 100; // 01 §3.2: "carries the class base rate"
  base.manaRegenPercent = classRow.manaRegenRate * 100;
  // 03 §2.1 "secondary resource" / §2.4's explicit "maxRage base 100" /
  // "maxResonance base 3" — a flat add contribution like any other, capped
  // (200/8) by the normal clamp() pass, not clamped to this base value.
  base.maxRage = classRow.baseRage;
  base.maxResonance = classRow.baseResonance;
  base.manaReturnPercent = classRow.manaReturnPercent; // O-84/D-53 micro-scope — 03 §2.4
  applyLayer(block, base);
  steps++;

  // 3. += allocated — the player's spent attribute points, read straight
  // off actor.attributes (pool.js's own field for exactly this — see the
  // file header).
  const allocated = sources.allocated;
  allocated.strength = actor.attributes.strength;
  allocated.dexterity = actor.attributes.dexterity;
  allocated.vitality = actor.attributes.vitality;
  allocated.energy = actor.attributes.energy;
  applyLayer(block, allocated);
  steps++;

  // 4. += equipment (in SLOT_ORDER, deterministic) — SLOT_ORDER iteration
  // itself is the items subsystem's job (not built yet, M3): whatever it
  // resolves is stored here as one combined partial via setSourceLayer.
  applyLayer(block, sources.equipment);
  steps++;

  // 5. += skills
  applyLayer(block, sources.skills);
  steps++;

  // 6. += status
  applyLayer(block, sources.status);
  steps++;

  // 7. += difficulty
  applyLayer(block, sources.difficulty);
  steps++;

  // 8. derive()
  derive(block, classRow, actor.level);
  steps++;

  // 9. clamp()
  clampBlock(block);
  steps++;

  // 10. actor.statsDirty = false
  actor.statsDirty = false;
  steps++;

  return steps;
}

/**
 * `02-api-contracts.md` §7: `stats(actor) => StatBlock` — "recomposes if
 * dirty, then returns". `Alloc: no` — a clean actor returns the same
 * `actor.stats` reference every call, no work done.
 * @param {object} actor
 * @returns {object}
 */
export function stats(actor) {
  if (actor.statsDirty) composeStats(actor);
  return actor.stats;
}

/**
 * `02-api-contracts.md` §7: `markDirty(actor) => void`. This is the pure
 * half only — "sets the flag"; the `stats:dirty` EMISSION half needs
 * `ctx.events`, which this headless module does not and must not touch
 * (see the file header). The real `ActorsSystem.markDirty` (owned by
 * whichever ticket wires this into `src/actors/index.js`) should call this,
 * then emit `stats:dirty` itself.
 * @param {object} actor
 */
export function markDirty(actor) {
  actor.statsDirty = true;
}

/**
 * `02-api-contracts.md` §7: `setSourceLayer(actor, layer, partial) =>
 * void`. Only `'equipment'|'skills'|'status'|'difficulty'` are legal —
 * `'base'`/`'allocated'` are computed fresh by `composeStats` every
 * recompose (see its steps 2/3) and are never set from outside. Replaces
 * the named layer wholesale (a layer is "the fields the layer actually
 * contributes" per `01` §4.1 — its complete current state, not a merge)
 * and marks the actor dirty: every real caller of this method is, by
 * definition, changing what a layer contributes, so requiring a second,
 * separate `markDirty()` call for the common case would be a footgun this
 * function does not need to create. A caller with an unrelated reason to
 * force a recompose (no layer changed) still has `markDirty()` directly.
 * @param {object} actor
 * @param {'equipment'|'skills'|'status'|'difficulty'} layer
 * @param {object} partial
 */
export function setSourceLayer(actor, layer, partial) {
  if (!SETTABLE_LAYERS.has(layer)) {
    throw new Error(
      `actors/stats: setSourceLayer: layer must be one of 'equipment'|'skills'|'status'|'difficulty' ` +
        `(got '${layer}') — 'base'/'allocated' are computed internally by composeStats, never set externally.`,
    );
  }
  if (!actor.sources) actor.sources = createEmptySources();
  actor.sources[layer] = partial || {};
  actor.statsDirty = true;
}

// Exported for tests that want to check the field/cap tables directly
// without depending on a live actor.
export { FIELD_NAMES, DEFAULTS, CAPS, CLASS_TABLE };
