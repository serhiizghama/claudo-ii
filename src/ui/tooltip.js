// src/ui/tooltip.js
//
// UI-5 — `09-ui.md` §5: the item tooltip. Anatomy/line order (§5.1), base
// statistics (§5.2), the rolled-property line builder (§5.3, including the
// pair merge, the all-resistances merge and the Alt range reveal), the
// requirement-not-met treatment (§5.4), the unidentified state (§5.5) and —
// this ticket's own named algorithmic risk — the placement/degradation
// algorithm (§5.7). Comparison mode (§5.6, §15 U9) is explicitly OUT of
// scope: `showTooltip`'s `compare` parameter is accepted and stored, never
// acted on, and `setCompareHeld` is not added — both are UI-7's, which
// reopens this same file.
//
// ---------------------------------------------------------------------------
// Why the model-building logic is exported as plain functions, not buried in
// the `Tooltip` class
// ---------------------------------------------------------------------------
// `buildTooltipModel`, `computeContentWidth`, `computeHeightPlan` and
// `computePlacement` are pure (no DOM, no `ctx`) — the acceptance criterion
// ("the orchestrator will run this, not eyeball it") needs the block order,
// the resistance merge and the placement algorithm to be directly assertable
// against plain fixtures, the same way `03-combat-math`'s pure formulas are
// tested without spinning up a scene. `Tooltip` (the class `UiSystem`
// constructs) is a thin DOM-driving shell around them: it gathers the
// `ctx`-shaped inputs (`items.rolledMods`, `items.base`, `items.canEquip`,
// the player actor's stats) once per content change and hands them to these
// functions.
//
// ---------------------------------------------------------------------------
// `items.base` / `items.canEquip` / a unique-lookup accessor — what exists
// today, and how this file degrades (see the report for the full account)
// ---------------------------------------------------------------------------
// `02-api-contracts.md:954-955` contracts `items.base(baseId) => ItemBase`
// and `items.bases` (Fixed=Y), but `src/items/index.js` (ITEM-1..7, landed)
// does not yet implement either as an INSTANCE method — only module-level
// re-exports (`ITEM_BASES_BY_ID`) exist, which this file may not import
// (`ARCHITECTURE.md` rule 2: reach another subsystem through `ctx.get`,
// never its module). Every read of `items.base` below is therefore
// defensive (`typeof items.base === 'function'`) and degrades to "no
// `ItemBase` data" (base-statistics/requirement lines simply do not render)
// until a later ITEM ticket adds the method — the same "ask, don't assume"
// discipline the ticket brief itself applies to `canEquip`/`icon`.
// `items.canEquip` (ITEM-11) and a unique-lore accessor (`items.unique(id)`,
// not named anywhere in `02-api-contracts.md` today — this ticket's own
// finding, see the report) are handled the same way: absent means "no
// requirement is unmet" / "no lore text", never a thrown error.
//
// ---------------------------------------------------------------------------
// Requirement-unmet, per line — `ui` never recomputes composition (§5.4)
// ---------------------------------------------------------------------------
// `items.canEquip(actor, item, slot)` is the ONE authority for whether the
// item is usable AT ALL — when it is absent or returns `true`, no
// requirement line is ever flagged, full stop (the ticket's own instruction:
// "degrade gracefully — no requirement is unmet"). When it returns `false`,
// deciding WHICH of (possibly several) requirement lines gets the red ✕ still
// needs a per-stat comparison; this file compares the actor's own already
// -composed `stats.strength/dexterity` and `actor.level` (read-only values
// `actors.stats()` already produced, never re-derived here) against the
// item's static `reqStr`/`reqDex`/`reqLevel`. That is a display comparison,
// not a re-run of `composeStats` or of the equipment-exclusive requirement
// check itself (`01-data-model.md` §4.4) — the verdict this file trusts is
// still `items.canEquip`'s, only the "which line" detail is local.

import { el, setText, setStyle, setClass, place, countNodes, clamp, damp, Pool } from './util.js';

// ---------------------------------------------------------------------------
// Constants — `09 §2` typography (px @ k=1) and `§5.1` metrics
// ---------------------------------------------------------------------------

const LH_NAME = 23;
const LH_BODY = 18;
const LH_MICRO = 13;
const LH_READ = 22;
const PAD = 12; // §5.1 metrics: "padding 12 px all round"
const RULE_SPACE = 6 + 1 + 6; // "6 px above and below each rule" + the rule's own 1px
const BLOCK_GAP = 8; // "8 px between blocks"
const PROP_LINE_GAP = 2; // "2 px between consecutive property lines"
const WIDTH_MIN = 288;
const WIDTH_MAX = 428;
const WIDTH_PAD = 24; // measuredContentWidth + 24 (== PAD*2)
const GAP_PLACE = 14; // §5.7 GAP
const EDGE_PLACE = 12; // §5.7 EDGE
const CURSOR_PUSH = 20; // §5.7's cursor-escape push distance
const ANCHOR_MOVE_EPS = 2; // §5.7 "moves more than 2 px"
const FADE_RATE = 26; // §2.6 "tooltip fade ... rate 26 /s"
const POOL_CAPACITY = 32; // "≤32 line nodes each" (09 §13.1)

// ---------------------------------------------------------------------------
// UI-7 — §5.6 comparison mode constants
// ---------------------------------------------------------------------------
const COMPARE_GAP = 10; // §5.6.3: "10 px apart" (opposite-side chain)
const COMPARE_BELOW_GAP = 8; // §5.6.3: "stack below the primary with an 8 px gap"
const COMPARE_OPACITY = 0.86; // §5.6.2: "opacity 0.86"
const MAX_COMPARE_PANELS = 2; // §5.6.2: "up to two"
const CHIP_EPS = 1e-6;

// Average glyph width per font token, px @ k=1 — a deterministic heuristic
// (see this file's header note in the report) used instead of an
// `offsetWidth` read: `09 §13.4` rule 2 explicitly permits one measurement
// on content-build, but a live DOM read is unavailable under the Node test
// harness (`./util.js`'s shim has no layout) and would make the very same
// content build a different width in Node vs. the browser — this keeps the
// two identical, at the cost of the tooltip not hugging its text pixel
// -perfectly. Never read in `lateUpdate`.
const CHAR_W = { name: 9.6, body: 7.1, micro: 7.6, read: 7.7 };

function estWidth(text, font) {
  return text ? text.length * (CHAR_W[font] || CHAR_W.body) : 0;
}

// ---------------------------------------------------------------------------
// §3 StatBlock declaration order — used only as the tie-break for stats that
// share one ordinal group (§5.3 rule 4: "ties break on the stat identifier's
// position in the StatBlock declaration order, which is fixed"). Transcribed
// from `01-data-model.md` §3.1-3.5, in file order.
// ---------------------------------------------------------------------------
const STAT_DECL_ORDER = [
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
  'lifeSteal', 'manaSteal', 'lifeOnHit', 'manaOnHit', 'lifeOnKill', 'manaOnKill', 'manaReturnPercent',
  'pierceChance', 'knockbackChance', 'thorns', 'rageOnHit', 'rageOnTakeHit', 'resonanceOnHit',
  'defense', 'defensePercent', 'blockChance', 'dodgeChance',
  'fireResist', 'coldResist', 'lightResist', 'poisonResist', 'magicResist', 'physicalResist',
  'maxFireResist', 'maxColdResist', 'maxLightResist', 'maxPoisonResist', 'maxMagicResist', 'maxPhysicalResist',
  'damageReduceFlat', 'damageReducePercent', 'magicDamageReduceFlat', 'fasterHitRecovery', 'ccReduction', 'cannotBeFrozen',
  'movementSpeed', 'magicFind', 'goldFind', 'manaCostReduction', 'lightRadius', 'requirementReduction',
  'damageTakenToMana', 'experienceGain', 'skillBonuses',
];
const DECL_INDEX = Object.create(null);
for (let i = 0; i < STAT_DECL_ORDER.length; i++) DECL_INDEX[STAT_DECL_ORDER[i]] = i;

/** The six resistances the all-resistances merge (§5.3 rule 2) operates
 * over, in `StatBlock` declaration order. */
export const RESIST_STATS = ['fireResist', 'coldResist', 'lightResist', 'poisonResist', 'magicResist', 'physicalResist'];
/** The four the merge calls "Elemental Resistances" instead of "All
 * Resistances" — exactly these four, no more, no fewer. */
export const ELEMENTAL_RESIST_STATS = ['fireResist', 'coldResist', 'lightResist', 'poisonResist'];

// ---------------------------------------------------------------------------
// §5.3.2 — the stat line templates. `unit` drives number formatting
// ("Percent stats print without a decimal; rates print one decimal; flat
// life/mana print as integers", §5.3.2's own header): 'pct'/'int' round to
// an integer, 'pct1' keeps one decimal, 'flag' has no `{v}` at all.
// ---------------------------------------------------------------------------
const STAT_META = {
  increasedAttackSpeed: { ord: 200, key: 'stat.increasedAttackSpeed', unit: 'pct' },
  fasterCastRate: { ord: 205, key: 'stat.fasterCastRate', unit: 'pct' },
  fasterHitRecovery: { ord: 210, key: 'stat.fasterHitRecovery', unit: 'pct' },
  enhancedDamage: { ord: 300, key: 'stat.enhancedDamage', unit: 'pct' },
  fireDamagePercent: { ord: 320, key: 'stat.fireDamagePercent', unit: 'pct' },
  coldDamagePercent: { ord: 320, key: 'stat.coldDamagePercent', unit: 'pct' },
  lightDamagePercent: { ord: 320, key: 'stat.lightDamagePercent', unit: 'pct' },
  poisonDamagePercent: { ord: 320, key: 'stat.poisonDamagePercent', unit: 'pct' },
  magicDamagePercent: { ord: 320, key: 'stat.magicDamagePercent', unit: 'pct' },
  elementalDamagePercent: { ord: 330, key: 'stat.elementalDamagePercent', unit: 'pct' },
  physicalDamagePercent: { ord: 332, key: 'stat.physicalDamagePercent', unit: 'pct' },
  fireResistPierce: { ord: 336, key: 'stat.fireResistPierce', unit: 'int' },
  coldResistPierce: { ord: 336, key: 'stat.coldResistPierce', unit: 'int' },
  lightResistPierce: { ord: 336, key: 'stat.lightResistPierce', unit: 'int' },
  poisonResistPierce: { ord: 336, key: 'stat.poisonResistPierce', unit: 'int' },
  coldDuration: { ord: 340, key: 'stat.coldDuration', unit: 'int' },
  poisonDuration: { ord: 342, key: 'stat.poisonDuration', unit: 'int' },
  attackRating: { ord: 400, key: 'stat.attackRating', unit: 'int' },
  attackRatingPercent: { ord: 405, key: 'stat.attackRatingPercent', unit: 'pct' },
  critChance: { ord: 410, key: 'stat.critChance', unit: 'pct' },
  critMult: { ord: 412, key: 'stat.critMult', unit: 'pct' },
  pierceChance: { ord: 420, key: 'stat.pierceChance', unit: 'pct' },
  knockbackChance: { ord: 425, key: 'stat.knockbackChance', unit: 'pct' },
  lifeSteal: { ord: 500, key: 'stat.lifeSteal', unit: 'pct' },
  manaSteal: { ord: 505, key: 'stat.manaSteal', unit: 'pct' },
  lifeOnHit: { ord: 510, key: 'stat.lifeOnHit', unit: 'int' },
  manaOnHit: { ord: 512, key: 'stat.manaOnHit', unit: 'int' },
  lifeOnKill: { ord: 514, key: 'stat.lifeOnKill', unit: 'int' },
  manaOnKill: { ord: 516, key: 'stat.manaOnKill', unit: 'int' },
  manaReturnPercent: { ord: 520, key: 'stat.manaReturnPercent', unit: 'pct' },
  rageOnHit: { ord: 522, key: 'stat.rageOnHit', unit: 'int' },
  rageOnTakeHit: { ord: 524, key: 'stat.rageOnTakeHit', unit: 'int' },
  resonanceOnHit: { ord: 526, key: 'stat.resonanceOnHit', unit: 'int' },
  thorns: { ord: 528, key: 'stat.thorns', unit: 'int' },
  defense: { ord: 600, key: 'stat.defense', unit: 'int' },
  defensePercent: { ord: 605, key: 'stat.defensePercent', unit: 'pct' },
  blockChance: { ord: 610, key: 'stat.blockChance', unit: 'pct' },
  dodgeChance: { ord: 612, key: 'stat.dodgeChance', unit: 'pct' },
  fireResist: { ord: 620, key: 'stat.fireResist', unit: 'pct' },
  coldResist: { ord: 620, key: 'stat.coldResist', unit: 'pct' },
  lightResist: { ord: 620, key: 'stat.lightResist', unit: 'pct' },
  poisonResist: { ord: 620, key: 'stat.poisonResist', unit: 'pct' },
  magicResist: { ord: 620, key: 'stat.magicResist', unit: 'pct' },
  physicalResist: { ord: 620, key: 'stat.physicalResist', unit: 'pct' },
  maxFireResist: { ord: 630, key: 'stat.maxFireResist', unit: 'pct' },
  maxColdResist: { ord: 630, key: 'stat.maxColdResist', unit: 'pct' },
  maxLightResist: { ord: 630, key: 'stat.maxLightResist', unit: 'pct' },
  maxPoisonResist: { ord: 630, key: 'stat.maxPoisonResist', unit: 'pct' },
  maxMagicResist: { ord: 630, key: 'stat.maxMagicResist', unit: 'pct' },
  maxPhysicalResist: { ord: 630, key: 'stat.maxPhysicalResist', unit: 'pct' },
  damageReduceFlat: { ord: 640, key: 'stat.damageReduceFlat', unit: 'int' },
  damageReducePercent: { ord: 642, key: 'stat.damageReducePercent', unit: 'pct' },
  magicDamageReduceFlat: { ord: 644, key: 'stat.magicDamageReduceFlat', unit: 'int' },
  ccReduction: { ord: 650, key: 'stat.ccReduction', unit: 'pct' },
  cannotBeFrozen: { ord: 652, key: 'stat.cannotBeFrozen', unit: 'flag' },
  maxLife: { ord: 700, key: 'stat.maxLife', unit: 'int' },
  lifePercent: { ord: 702, key: 'stat.lifePercent', unit: 'pct' },
  maxMana: { ord: 704, key: 'stat.maxMana', unit: 'int' },
  manaPercent: { ord: 706, key: 'stat.manaPercent', unit: 'pct' },
  maxRage: { ord: 710, key: 'stat.maxRage', unit: 'int' },
  maxResonance: { ord: 712, key: 'stat.maxResonance', unit: 'int' },
  lifeRegen: { ord: 720, key: 'stat.lifeRegen', unit: 'int' },
  lifeRegenPercent: { ord: 722, key: 'stat.lifeRegenPercent', unit: 'pct1' },
  manaRegen: { ord: 724, key: 'stat.manaRegen', unit: 'int' },
  manaRegenPercent: { ord: 726, key: 'stat.manaRegenPercent', unit: 'pct1' },
  movementSpeed: { ord: 800, key: 'stat.movementSpeed', unit: 'pct' },
  magicFind: { ord: 805, key: 'stat.magicFind', unit: 'pct' },
  goldFind: { ord: 810, key: 'stat.goldFind', unit: 'pct' },
  experienceGain: { ord: 815, key: 'stat.experienceGain', unit: 'pct' },
  manaCostReduction: { ord: 900, key: 'stat.manaCostReduction', unit: 'pct' },
  requirementReduction: { ord: 905, key: 'stat.requirementReduction', unit: 'pct' },
  lightRadius: { ord: 910, key: 'stat.lightRadius', unit: 'int' },
  damageTakenToMana: { ord: 915, key: 'stat.damageTakenToMana', unit: 'pct' },
};

/** Stats with a language-specific negative wording (§5.3.2: "a stat whose
 * negative wording differs ... additionally has `statNeg.<identifier>`").
 * Only `lifePercent` is named in the range this ticket read. */
const STAT_NEG_KEY = { lifePercent: 'statNeg.lifePercent' };

/** §5.3 rule 1 — the six merged pairs. `poisonMin`/`poisonMax` additionally
 * consumes a same-affix `poisonDuration` entry, or falls back to
 * `POISON_DEFAULT_DURATION` when the affix rolled no explicit duration (an
 * ambiguity this ticket resolved — see the report). */
const POISON_DEFAULT_DURATION = 3;
const PAIR_DEFS = [
  { min: 'minDamage', max: 'maxDamage', key: 'stat.damageRange', ord: 305 },
  { min: 'fireMin', max: 'fireMax', key: 'stat.fireRange', ord: 310 },
  { min: 'coldMin', max: 'coldMax', key: 'stat.coldRange', ord: 312 },
  { min: 'lightMin', max: 'lightMax', key: 'stat.lightRange', ord: 314 },
  { min: 'poisonMin', max: 'poisonMax', key: 'stat.poisonRange', ord: 316, duration: 'poisonDuration' },
  { min: 'magicMin', max: 'magicMax', key: 'stat.magicRange', ord: 318 },
];

function fmtInt(v) {
  return String(Math.round(v));
}
function fmtByUnit(v, unit) {
  if (unit === 'pct1') return v.toFixed(1);
  if (unit === 'flag') return '';
  return fmtInt(v);
}

// ---------------------------------------------------------------------------
// Attack-speed word bands — §5.2's table, "effective seconds per swing
// after increasedAttackSpeed".
// ---------------------------------------------------------------------------
function speedWordKey(intervalSeconds) {
  if (intervalSeconds <= 0.60) return 'speed.veryFast';
  if (intervalSeconds <= 0.80) return 'speed.fast';
  if (intervalSeconds <= 1.05) return 'speed.normal';
  if (intervalSeconds <= 1.35) return 'speed.slow';
  return 'speed.verySlow';
}

// ---------------------------------------------------------------------------
// The rolled-property line builder — §5.3, steps 1-5, in order. Pure: takes
// the flat `rolledMods` buffer (`modBuf[0..n)`) and returns an ordered array
// of `{ text, danger, rangeMin, rangeMax, hasRange }` ready for the Alt
// reveal and the DOM writer. No `Map`/`Set` anywhere (`ARCHITECTURE.md`
// -adjacent perf rule this ticket's brief restates): grouping is a linear
// scan over the small, per-item `modBuf`.
// ---------------------------------------------------------------------------
function buildPropertyLines(modBuf, n, t) {
  const consumed = new Uint8Array(n);
  const work = [];

  // Step 1 — pair merge.
  for (let p = 0; p < PAIR_DEFS.length; p++) {
    const pd = PAIR_DEFS[p];
    let idxA = -1;
    let idxB = -1;
    for (let i = 0; i < n && idxA < 0; i++) {
      if (consumed[i] || modBuf[i].stat !== pd.min) continue;
      for (let j = 0; j < n; j++) {
        if (j === i || consumed[j]) continue;
        if (modBuf[j].stat === pd.max && modBuf[j].affixId === modBuf[i].affixId) { idxA = i; idxB = j; break; }
      }
    }
    if (idxA < 0 || idxB < 0) continue;
    consumed[idxA] = 1; consumed[idxB] = 1;
    const a = modBuf[idxA]; const b = modBuf[idxB];
    let params = { a: fmtInt(a.value), b: fmtInt(b.value) };
    if (pd.duration) {
      let dVal = POISON_DEFAULT_DURATION;
      for (let k = 0; k < n; k++) {
        if (consumed[k] || modBuf[k].stat !== pd.duration || modBuf[k].affixId !== a.affixId) continue;
        dVal = modBuf[k].value; consumed[k] = 1; break;
      }
      params.d = fmtInt(dVal);
    }
    work.push({
      ordinal: pd.ord, declIndex: DECL_INDEX[pd.min] || 0,
      text: t(pd.key, params), danger: a.value < 0 || b.value < 0,
      hasRange: false, rangeMin: 0, rangeMax: 0,
      // UI-7 — §5.6's delta chips key on "the contributed total for that
      // stat"; a merged min/max pair has no single stat id, so the anchor is
      // the pair's own `min` identifier (unique per PAIR_DEFS entry) and the
      // comparable magnitude is the pair's mean, the same basis §5.6 already
      // names for the analogous base-weapon-damage case.
      compareKey: 'pair:' + pd.min, compareValue: (a.value + b.value) / 2,
    });
  }

  // Step 2 — resistance merge (rule 2: same affixId, same value, >=3 of the
  // six resistances; exactly the four elemental ones -> "Elemental
  // Resistances", any other qualifying combination -> "All Resistances").
  for (let i = 0; i < n; i++) {
    if (consumed[i] || RESIST_STATS.indexOf(modBuf[i].stat) === -1) continue;
    const group = [i];
    for (let j = i + 1; j < n; j++) {
      if (consumed[j] || RESIST_STATS.indexOf(modBuf[j].stat) === -1) continue;
      if (modBuf[j].affixId === modBuf[i].affixId && modBuf[j].value === modBuf[i].value) group.push(j);
    }
    if (group.length < 3) continue;
    for (let g = 0; g < group.length; g++) consumed[group[g]] = 1;
    const stats = group.map((gi) => modBuf[gi].stat);
    const isElemental = stats.length === 4 && ELEMENTAL_RESIST_STATS.every((s) => stats.indexOf(s) !== -1);
    const key = isElemental ? 'stat.elementalResistances' : 'stat.allResistances';
    const val = modBuf[i].value;
    // UI-7 — the compare anchor is the SORTED (canonical RESIST_STATS order)
    // set of merged stat ids, so two items merging the identical resist
    // SHAPE match regardless of the order their own affixes happened to
    // list them in `modBuf`. Two items that merge a DIFFERENT shape (e.g.
    // 3 resists vs. the same 3 plus a 4th) deliberately do NOT match — see
    // this file's header for why an exact-shape requirement was chosen over
    // a fuzzier per-resist match.
    const compareKey = 'resistgrp:' + stats.slice().sort((s1, s2) => RESIST_STATS.indexOf(s1) - RESIST_STATS.indexOf(s2)).join(',');
    work.push({
      ordinal: 620, declIndex: DECL_INDEX.fireResist,
      text: t(key, { v: fmtInt(val) }), danger: val < 0,
      hasRange: true, rangeMin: modBuf[i].min, rangeMax: modBuf[i].max,
      compareKey, compareValue: val,
    });
  }

  // Step 3 — skill bonus expansion. Affix data encodes the scope as a
  // dotted stat id (`skillBonuses.all` / `.tree.<id>` / `.skill.<id>`) —
  // the only shape that can flow through `rolledMods`'s flat `{stat,
  // value}` entries at all, matching §5.3's own dotted notation.
  for (let i = 0; i < n; i++) {
    if (consumed[i]) continue;
    const stat = modBuf[i].stat;
    if (typeof stat !== 'string' || stat.indexOf('skillBonuses.') !== 0) continue;
    consumed[i] = 1;
    const rest = stat.slice('skillBonuses.'.length);
    const v = fmtInt(modBuf[i].value);
    let text; let ord;
    if (rest === 'all') { text = t('stat.skillBonusAll', { v }); ord = 100; }
    else if (rest.indexOf('tree.') === 0) { text = t('stat.skillBonusTree', { v, tree: t('tree.' + rest.slice(5)) }); ord = 105; }
    else if (rest.indexOf('skill.') === 0) { text = t('stat.skillBonusSkill', { v, skill: rest.slice(6) }); ord = 110; }
    else continue; // unrecognised shape — skip, never throw
    work.push({
      ordinal: ord, declIndex: 0, text, danger: modBuf[i].value < 0,
      hasRange: true, rangeMin: modBuf[i].min, rangeMax: modBuf[i].max,
      compareKey: 'skill:' + stat, compareValue: modBuf[i].value,
    });
  }

  // Generic single-stat lines for everything else.
  for (let i = 0; i < n; i++) {
    if (consumed[i]) continue;
    const e = modBuf[i];
    const meta = STAT_META[e.stat];
    if (!meta) continue; // unknown/unmapped stat id — skip, never throw
    consumed[i] = 1;
    const value = e.value;
    const isDrawback = e.source === 'unique' && value < 0;
    const ordinal = isDrawback ? 990 : meta.ord;
    let key = meta.key;
    let vStr;
    if (value < 0 && STAT_NEG_KEY[e.stat]) { key = STAT_NEG_KEY[e.stat]; vStr = fmtByUnit(Math.abs(value), meta.unit); }
    else vStr = fmtByUnit(value, meta.unit);
    work.push({
      ordinal, declIndex: DECL_INDEX[e.stat] || 0,
      text: t(key, { v: vStr }), danger: value < 0,
      hasRange: meta.unit !== 'flag', rangeMin: e.min, rangeMax: e.max,
      // UI-7 — a `flag` stat (`cannotBeFrozen`) has no magnitude to compare;
      // its compareKey stays set (so a genuine mismatch still reads as
      // new/lost) but compareValue is 0 for both sides, so it never shows a
      // spurious +/- delta.
      compareKey: e.stat, compareValue: meta.unit === 'flag' ? 0 : value,
    });
  }

  // Step 4 — sort by (ordinal, declIndex); Array#sort is stable, so this is
  // the whole tie-break contract §5.3 rule 4 asks for.
  work.sort((a, b) => (a.ordinal - b.ordinal) || (a.declIndex - b.declIndex));
  return work;
}

// ---------------------------------------------------------------------------
// buildTooltipModel — §5.1's anatomy, §5.2's base statistics, §5.4's
// requirement treatment and §5.5's unidentified state, assembled into one
// plain-object model the DOM writer (and the height/width planners) read.
// Pure: every external fact (the `ItemBase`, the `canEquip` verdict, the
// actor snapshot, a unique's lore) is passed in, never fetched here.
// ---------------------------------------------------------------------------

/**
 * @param {object} item - `ItemInstance`.
 * @param {object|null} base - `ItemBase`, or `null` when `items.base` is
 *   unavailable (see file header) — base-statistics/requirement lines are
 *   then simply omitted.
 * @param {Array} modBuf - `items.rolledMods`'s `out` buffer.
 * @param {number} modCount - `rolledMods`'s return value.
 * @param {object} opts - `{ altHeld, requirementUnmet, actorSnap, loreText,
 *   lang, uniqueName }`. `lang` is `'en'|'ru'`, the ACTIVE `ui` language —
 *   `items` has no active-language parameter and may not import
 *   `src/ui/i18n.js` (ARCHITECTURE.md rule 2), so a rare's
 *   `item.nameOverride` carries both `{ en, ru }` (ITEM-8) and `ui` is the
 *   one that picks. `uniqueName` is `items.unique(item.uniqueId).name`,
 *   fetched by the caller (never English-only-fallback guessed here).
 * @param {(key:string, params?:object) => string} t
 * @returns {object} the model.
 */
export function buildTooltipModel(item, base, modBuf, modCount, opts, t) {
  const altHeld = !!opts.altHeld;
  const requirementUnmet = !!opts.requirementUnmet;
  const actorSnap = opts.actorSnap || null;
  const loreText = opts.loreText || '';
  const lang = opts.lang === 'ru' ? 'ru' : 'en';

  const rarity = item.rarity || 'normal';
  const isUnidentifiable = rarity === 'rare' || rarity === 'unique';
  const isUnidentified = isUnidentifiable && item.identified === false;

  const baseName = base ? base.name : (item._cache && item._cache.displayName) || item.baseId;

  // Name resolution precedence (§5.1 block 1), most specific first:
  //   1. unidentified rare/unique -> the base name, never a generated one.
  //   2. a unique -> `UniqueDefinition.name` (English-only today — no
  //      `{en,ru}` split exists for uniques, unlike rares; not this
  //      ticket's gap to invent).
  //   3. a rare with a rolled name -> `item.nameOverride[lang]` (ITEM-8's
  //      `{headIndex, tailIndex, code, en, ru}` shape) — or the bare
  //      string, for any fixture/old-save shape that still uses one.
  //   4. fall back to whatever `items` cached, or the base name.
  let displayName;
  if (isUnidentified) {
    displayName = baseName;
  } else if (item.uniqueId && opts.uniqueName) {
    displayName = opts.uniqueName;
  } else if (item.nameOverride && typeof item.nameOverride === 'object') {
    displayName = item.nameOverride[lang] || item.nameOverride.en || baseName;
  } else if (typeof item.nameOverride === 'string' && item.nameOverride) {
    displayName = item.nameOverride;
  } else {
    displayName = (item._cache && item._cache.displayName) || baseName;
  }

  const model = {
    rarity,
    isUnidentified,
    name: displayName,
    showBaseType: !isUnidentified && !!base && displayName !== base.name,
    baseTypeText: base ? base.name : '',
    rarityText: isUnidentified ? t('tooltip.unidentified') : t('rarity.' + rarity),
    statLines: [],
    propLines: [],
    socketLines: [],
    showLore: false,
    loreText: '',
    showDurabilityWarning: false,
    durabilityWarningText: '',
    showUnidentifiedNotice: isUnidentified,
    unidentifiedNoticeText: isUnidentified ? t('tooltip.unidentifiedHint') : '',
    itemLevelText: t('tooltip.itemLevel', { v: item.ilvl || 0 }),
    requirementUnmetAny: false,
    // UI-7 (§5.6.5) — the two-hand/shield warning and the §5.6's own compare
    // basis footnote. Neither depends on anything buildTooltipModel itself
    // computes (both are comparison-context facts the Tooltip class knows,
    // not the item alone) — declared here only so every model has the same
    // shape whether or not comparison ever touches it; `Tooltip` overwrites
    // them, never buildTooltipModel.
    showTwoHandWarning: false,
    isCompare: false,
    compareLabelText: '',
    // §5.6: "Both comparisons name their basis in a --ink-4 footnote" —
    // shown on whichever tooltip(s) actually carry a weapon-damage-mean or
    // post-bonus-defense line while comparison is active. Set by
    // `Tooltip#_rebuildCompare`/`writeComparePanel`, never here (comparison
    // context, not an item-alone fact — same reasoning as
    // `showTwoHandWarning`).
    showCompareBasis: false,
  };

  // --- Block 5+6 — base statistics + requirements. One continuous list,
  // no internal gap (matches §5.1's own worked example, which draws them
  // with no blank line between "Durability" and "Required Level"). ---
  const statLines = model.statLines;
  let enhancedDamagePct = 0; let iasPct = 0; let defensePct = 0;
  for (let i = 0; i < modCount; i++) {
    const st = modBuf[i].stat;
    if (st === 'enhancedDamage') enhancedDamagePct += modBuf[i].value;
    else if (st === 'increasedAttackSpeed') iasPct += modBuf[i].value;
    else if (st === 'defensePercent') defensePct += modBuf[i].value;
  }

  if (base && base.category === 'weapon' && base.weapon) {
    const w = base.weapon;
    const mul = 1 + enhancedDamagePct / 100;
    const dMin = Math.round(w.minDamage * mul);
    const dMax = Math.round(w.maxDamage * mul);
    // UI-7 — §5.6: "Weapon damage compares the mean of (min + max) / 2
    // after enhancedDamage" — compareValue is exactly that, computed once
    // here rather than re-derived by the comparison machinery.
    statLines.push({ label: t(w.twoHanded ? 'tooltip.twoHandDamage' : 'tooltip.oneHandDamage'), value: dMin + ' – ' + dMax, modified: enhancedDamagePct !== 0, compareKey: 'weaponDamageMean', compareValue: (dMin + dMax) / 2 });
    const interval = w.attackTime / (1 + iasPct / 100);
    const rate = 1 / interval;
    statLines.push({ label: t('tooltip.attackSpeed'), value: rate.toFixed(2) + ' /s (' + t(speedWordKey(interval)) + ')', modified: iasPct !== 0, compareKey: 'attackSpeedRate', compareValue: rate });
    if (w.range > 2.4) statLines.push({ label: t('tooltip.reach'), value: w.range.toFixed(1) + ' m', modified: false });
  } else if (base && base.category === 'armour' && base.armour) {
    const a = base.armour;
    const mul = 1 + defensePct / 100;
    const disp = Math.round((item.rolls ? item.rolls.defense : 0) * mul);
    // §5.6: "defence compares rolls.defense after defensePercent" — `disp`
    // above already is exactly that.
    statLines.push({ label: t('tooltip.defence'), value: fmtInt(disp), modified: defensePct !== 0, compareKey: 'defense', compareValue: disp });
    if (a.blockBase > 0) {
      const blockVal = actorSnap && typeof actorSnap.blockChance === 'number' ? actorSnap.blockChance : a.blockBase;
      statLines.push({ label: t('tooltip.blockChance'), value: fmtInt(blockVal) + ' %', modified: false, compareKey: 'blockChance', compareValue: blockVal });
    }
    if (a.moveSpeedPenalty) {
      statLines.push({ label: t('tooltip.movement', { v: fmtInt(a.moveSpeedPenalty) }), value: '', danger: true, singleText: true });
    }
  } else if (base && base.category === 'consumable' && base.consumable) {
    const c = base.consumable;
    const key = c.overSeconds > 0 ? 'tooltip.restoresOverTime' : 'tooltip.restoresInstant';
    const resourceKey = c.effect === 'restore_mana' ? 'hud.mana' : 'hud.life';
    statLines.push({ label: t(key, { pct: fmtInt(c.amountPercent), resource: t(resourceKey), sec: fmtInt(c.overSeconds) }), value: '', singleText: true });
    if (c.stackMax > 1) statLines.push({ label: t('tooltip.quantity'), value: fmtInt(item.quantity || 1), modified: false });
  }

  if (item.maxDurability > 0) {
    statLines.push({ label: t('tooltip.durability'), value: t('tooltip.durabilityValue', { cur: item.durability, max: item.maxDurability }), modified: false });
    const ratio = item.maxDurability > 0 ? item.durability / item.maxDurability : 1;
    if (ratio <= 0.20) {
      model.showDurabilityWarning = true;
      model.durabilityWarningText = t(item.durability <= 0 ? 'tooltip.durabilityBroken' : 'tooltip.durabilityLow');
    }
  }

  let anyUnmet = false;
  if (base) {
    if (base.reqLevel > 0) {
      const unmet = requirementUnmet && actorSnap && actorSnap.level < base.reqLevel;
      if (unmet) anyUnmet = true;
      statLines.push({ label: t('tooltip.requiredLevel'), value: fmtInt(base.reqLevel) + (unmet ? '  ✕' : ''), danger: unmet, req: true });
    }
    if (base.reqStr > 0) {
      const unmet = requirementUnmet && actorSnap && actorSnap.strength < base.reqStr;
      if (unmet) anyUnmet = true;
      statLines.push({ label: t('tooltip.requiredStrength'), value: fmtInt(base.reqStr) + (unmet ? '  ✕' : ''), danger: unmet, req: true });
    }
    if (base.reqDex > 0) {
      const unmet = requirementUnmet && actorSnap && actorSnap.dexterity < base.reqDex;
      if (unmet) anyUnmet = true;
      statLines.push({ label: t('tooltip.requiredDexterity'), value: fmtInt(base.reqDex) + (unmet ? '  ✕' : ''), danger: unmet, req: true });
    }
  }
  // requirementUnmet (items.canEquip's own verdict) still drives the Ember
  // Seam even when no per-line comparison could be made (no actor snapshot
  // available) — §5.4: "the tooltip's Ember Seam turns --danger for its
  // whole length" is unconditional on the overall verdict.
  model.requirementUnmetAny = requirementUnmet || anyUnmet;

  // --- Block 8 — rolled properties (§5.3), suppressed when unidentified. ---
  if (!isUnidentified && (modCount > 0 || item.uniqueId)) {
    model.propLines = buildPropertyLines(modBuf, modCount, t).map((line) => ({
      text: line.text,
      danger: line.danger,
      rangeText: (altHeld && line.hasRange) ? ('[' + fmtInt(line.rangeMin) + ' – ' + fmtInt(line.rangeMax) + ']') : '',
      // UI-7 (§5.6's delta chips) — carried through from buildPropertyLines'
      // own work items; undefined on nothing here (every branch of that
      // function sets both).
      compareKey: line.compareKey, compareValue: line.compareValue,
    }));
  } else {
    model.propLines = [];
  }

  // --- Block 9 — sockets, suppressed when unidentified. ---
  if (!isUnidentified && item.socketCount > 0) {
    model.socketLines.push({ label: t('tooltip.sockets', { v: item.socketCount }), value: '', singleText: true });
  }

  // --- Block 11 — lore, uniques only, suppressed when unidentified. ---
  if (!isUnidentified && item.uniqueId && loreText) {
    model.showLore = true;
    model.loreText = loreText;
  }

  return model;
}

// ---------------------------------------------------------------------------
// Width — clamp(288, measuredContentWidth + 24, 428) at k=1 (§5.1 metrics).
// ---------------------------------------------------------------------------
export function computeContentWidth(model, k = 1) {
  let maxW = estWidth(model.name, 'name');
  if (model.showBaseType) maxW = Math.max(maxW, estWidth(model.baseTypeText, 'body'));
  maxW = Math.max(maxW, estWidth(model.rarityText, 'micro'));
  for (const l of model.statLines) maxW = Math.max(maxW, estWidth((l.label || '') + '   ' + (l.value || ''), 'body'));
  for (const l of model.propLines) maxW = Math.max(maxW, estWidth(l.text + (l.rangeText ? '   ' + l.rangeText : ''), 'body'));
  for (const l of model.socketLines) maxW = Math.max(maxW, estWidth(l.label, 'body'));
  maxW = Math.max(maxW, estWidth(model.itemLevelText, 'micro'));
  if (model.showUnidentifiedNotice) maxW = Math.max(maxW, estWidth(model.unidentifiedNoticeText, 'body'));
  return clamp(maxW + WIDTH_PAD, WIDTH_MIN, WIDTH_MAX) * k;
}

// ---------------------------------------------------------------------------
// Height — §5.7's degradation ladder, applied in exact order (a)-(e) until
// the content fits `vh - 2*EDGE`. Never scrolls: step (e) accepts overflow.
// ---------------------------------------------------------------------------
function measureHeight(model, contentWidth, propLineHeight, showLore, showItemLevel, k) {
  let h = PAD * 2 * k;
  h += LH_NAME * k;
  if (model.showBaseType) h += LH_BODY * k;
  h += LH_MICRO * k; // rarity word / "Unidentified"
  h += RULE_SPACE * k; // rule before block 5
  h += model.statLines.length * LH_BODY * k;
  const propCount = model.propLines.length + model.socketLines.length;
  if (propCount > 0) {
    h += RULE_SPACE * k;
    h += model.propLines.length * propLineHeight * k;
    if (model.propLines.length > 1) h += (model.propLines.length - 1) * PROP_LINE_GAP * k;
    h += model.socketLines.length * LH_BODY * k;
  }
  if (showLore && model.showLore) {
    h += RULE_SPACE * k;
    const readCharsPerLine = Math.max(8, Math.floor((contentWidth / k - PAD * 2) / CHAR_W.read));
    const loreLines = Math.max(1, Math.ceil(model.loreText.length / readCharsPerLine));
    h += loreLines * LH_READ * k;
  }
  if (model.showDurabilityWarning) h += BLOCK_GAP * k + LH_MICRO * k;
  if (model.showUnidentifiedNotice) h += BLOCK_GAP * k + LH_BODY * k;
  if (showItemLevel) h += BLOCK_GAP * k + LH_MICRO * k;
  // UI-7 (§5.6.5) — the two-hand/shield warning line, when comparison mode
  // put one under the primary. Sized like block 13's own notice row
  // (`.cl2-tt-notice`, `--t-body` — see `_buildDom`'s reuse of that class).
  if (model.showTwoHandWarning) h += BLOCK_GAP * k + LH_BODY * k;
  // §5.6's compare-basis footnote — a single `--t-micro` line.
  if (model.showCompareBasis) h += BLOCK_GAP * k + LH_MICRO * k;
  return h;
}

/** §5.6's compare-basis footnote fires only for a tooltip that itself
 * carries the one of the two special-basis lines the spec names by name
 * (weapon damage's mean, defence's post-% value) — never for a tooltip
 * that has neither (nothing to name a basis for). */
function hasCompareBasisLine(model) {
  for (let i = 0; i < model.statLines.length; i++) {
    const k = model.statLines[i].compareKey;
    if (k === 'weaponDamageMean' || k === 'defense') return true;
  }
  return false;
}

/**
 * @returns {{height:number, propLineHeight:number, showLore:boolean,
 *   showItemLevel:boolean, overflow:boolean}}
 */
export function computeHeightPlan(model, contentWidth, vh, k = 1) {
  const maxH = vh - 2 * EDGE_PLACE * k;
  let propLineHeight = 18; let showLore = true; let showItemLevel = true;
  let h = measureHeight(model, contentWidth, propLineHeight, showLore, showItemLevel, k);
  if (h > maxH) { propLineHeight = 16; h = measureHeight(model, contentWidth, propLineHeight, showLore, showItemLevel, k); }
  if (h > maxH) { showLore = false; h = measureHeight(model, contentWidth, propLineHeight, showLore, showItemLevel, k); }
  // (c) "drop the hint row" — this ticket never renders a hint row (UI-7's
  // compare hint / an equip-context hint neither exist yet), so this step
  // is already satisfied; kept as a no-op so the ladder's ORDER stays
  // faithful to §5.7 if a later ticket adds a real hint row here.
  if (h > maxH) { showItemLevel = false; h = measureHeight(model, contentWidth, propLineHeight, showLore, showItemLevel, k); }
  return { height: h, propLineHeight, showLore, showItemLevel, overflow: h > maxH };
}

// ---------------------------------------------------------------------------
// Placement — §5.7's algorithm, verbatim, plus the cursor-escape rule.
// ---------------------------------------------------------------------------

/**
 * @param {number} anchorX
 * @param {number} anchorY
 * @param {number} w
 * @param {number} h
 * @param {number} vw
 * @param {number} vh
 * @param {number|null} cursorX
 * @param {number|null} cursorY
 * @param {number} [k]
 * @returns {{x:number, y:number}}
 */
export function computePlacement(anchorX, anchorY, w, h, vw, vh, cursorX, cursorY, k = 1) {
  const GAP = GAP_PLACE * k;
  const EDGE = EDGE_PLACE * k;

  let x = anchorX + GAP;
  if (x + w > vw - EDGE) {
    x = anchorX - GAP - w;
    if (x < EDGE) x = clamp(anchorX - w / 2, EDGE, vw - w - EDGE);
  }

  let y = anchorY - 8 * k;
  if (y + h > vh - EDGE) y = vh - EDGE - h;
  if (y < EDGE) y = EDGE;

  if (cursorX !== null && cursorX !== undefined && cursorY !== null && cursorY !== undefined) {
    const insideX = cursorX >= x && cursorX <= x + w;
    const insideY = cursorY >= y && cursorY <= y + h;
    if (insideX && insideY) {
      const escX = Math.min(cursorX - x, (x + w) - cursorX);
      const escY = Math.min(cursorY - y, (y + h) - cursorY);
      const push = CURSOR_PUSH * k;
      if (escX <= escY) x += (cursorX < x + w / 2) ? push : -push;
      else y += (cursorY < y + h / 2) ? push : -push;
    }
  }

  return { x, y };
}

// ---------------------------------------------------------------------------
// UI-7 — §5.6 comparison mode: delta-chip computation and the opposite-side
// stacking placement. All pure (no DOM, no `ctx`) — same "directly
// assertable against plain fixtures" reason this file's header already
// gives for buildTooltipModel/computeContentWidth/computeHeightPlan/
// computePlacement.
//
// ---------------------------------------------------------------------------
// WHERE a chip renders — a documented departure from a literal reading of
// §5.6's own paragraph
// ---------------------------------------------------------------------------
// §5.6 says a chip is added to "every numeric line in the PRIMARY tooltip
// that also exists in the comparison" — singular "the comparison". But
// §5.6.4 puts up to TWO comparison panels on screen at once (a ring's
// ring1/ring2 trade), each against a DIFFERENT equipped item, so a single
// primary line can have two different, simultaneously-true deltas — there
// is only one chip slot per line, so both cannot render on the primary at
// once without inventing a second slot the spec never describes.
//
// This file's resolution: delta chips render on each COMPARISON PANEL's own
// line (comparing that panel's item against the primary), not on the
// primary. This has no multi-panel collision (each panel is independent),
// still reads exactly like the spec's own worked semantics ("primary
// better" -> good, "primary worse" -> danger — the sign is always
// primary-relative, only its ON-SCREEN location moves), and is the only
// placement of the two that has a well-defined answer when two panels are
// open. The one asymmetric case the table names — "present only on the
// primary -> new" — has no panel line to attach to when it is new-relative-
// to-every-open-panel; that one case DOES render on the primary (see
// `applyPrimaryNewChips` below), so a primary chip is not literally
// impossible, just reserved for the one case with no collision risk.
// ---------------------------------------------------------------------------

/** @returns {{good:string,danger:string,cls:'good'|'danger'}|null} formats
 * one delta chip. `compareKey==='attackSpeedRate'` keeps 2 decimals (its own
 * line already prints 2); everything else rounds to an integer — see this
 * file's report for why a blanket integer round would hide a real, sub-1
 * attack-speed delta. Returns `null` when the rounded delta is exactly 0
 * (the table's "equal -> no chip" row). */
function formatDeltaChip(delta) {
  const r = Math.round(delta * 1000) / 1000; // kill float noise before the sign test
  if (Math.abs(r) < CHIP_EPS) return null;
  return r > 0 ? { text: '▲ +' + fmtInt(r), cls: 'good' } : { text: '▼ −' + fmtInt(-r), cls: 'danger' };
}
function formatDeltaChipRate(delta) {
  const r = Math.round(delta * 100) / 100;
  if (Math.abs(r) < CHIP_EPS) return null;
  return r > 0 ? { text: '▲ +' + r.toFixed(2), cls: 'good' } : { text: '▼ −' + (-r).toFixed(2), cls: 'danger' };
}

/** Linear scan (no Map — ARCHITECTURE.md-adjacent perf rule; these arrays
 * are a handful of lines, this is a content-rebuild-time cost, not a
 * per-frame one) for the line in `model` (its `statLines` then its
 * `propLines`) whose `compareKey === key`. */
function findByCompareKey(model, key) {
  for (let i = 0; i < model.statLines.length; i++) if (model.statLines[i].compareKey === key) return model.statLines[i];
  for (let i = 0; i < model.propLines.length; i++) if (model.propLines[i].compareKey === key) return model.propLines[i];
  return null;
}

/**
 * Annotates every comparable line of `panelModel` (a comparison panel's own
 * model — the currently-equipped item) with a `.chip` (`{text, cls}` or
 * `null`), computed against `primaryModel` (the hovered item). Mutates
 * `panelModel`'s lines in place (fresh objects every content rebuild, so
 * this is safe — see `buildTooltipModel`'s own header on why the model is
 * never shared/pooled).
 * @param {object} primaryModel
 * @param {object} panelModel
 * @param {(key:string, params?:object) => string} t
 * @returns {string[]} every `compareKey` this panel carries (matched or
 *   not) — the caller unions this across every open panel to know which
 *   primary lines are genuinely absent everywhere (`applyPrimaryNewChips`).
 */
export function computePanelChips(primaryModel, panelModel, t) {
  const keys = [];
  const annotate = (line) => {
    if (!line.compareKey) { line.chip = null; return; }
    keys.push(line.compareKey);
    const match = findByCompareKey(primaryModel, line.compareKey);
    if (!match) {
      // §5.6 table: "present only on the comparison -> chip ▼ lost" — the
      // primary would not have this stat at all if equipped.
      line.chip = { text: '▼ ' + t('tooltip.compareLost'), cls: 'danger' };
      return;
    }
    const delta = match.compareValue - line.compareValue; // primary − this panel
    line.chip = line.compareKey === 'attackSpeedRate' ? formatDeltaChipRate(delta) : formatDeltaChip(delta);
  };
  for (let i = 0; i < panelModel.statLines.length; i++) annotate(panelModel.statLines[i]);
  for (let i = 0; i < panelModel.propLines.length; i++) annotate(panelModel.propLines[i]);
  return keys;
}

/**
 * Marks every `primaryModel` line whose `compareKey` is absent from
 * `unionPanelKeys` (present on neither open comparison panel) with a
 * `▲ new` chip — §5.6 table's "present only on the primary" row. Every
 * other comparable primary line is left with `chip: null` — that
 * information already rendered on the panel that has it
 * (`computePanelChips`, matched or "lost").
 * @param {object} primaryModel
 * @param {string[]} unionPanelKeys
 * @param {(key:string, params?:object) => string} t
 */
export function applyPrimaryNewChips(primaryModel, unionPanelKeys, t) {
  const mark = (line) => {
    if (!line.compareKey) { line.chip = null; return; }
    line.chip = unionPanelKeys.indexOf(line.compareKey) === -1 ? { text: '▲ ' + t('tooltip.compareNew'), cls: 'good' } : null;
  };
  for (let i = 0; i < primaryModel.statLines.length; i++) mark(primaryModel.statLines[i]);
  for (let i = 0; i < primaryModel.propLines.length; i++) mark(primaryModel.propLines[i]);
}

/** Clears every `.chip` on `model` — the "comparison just turned off" path,
 * so a stale chip never survives a `setCompareHeld(false)`. */
export function clearChips(model) {
  for (let i = 0; i < model.statLines.length; i++) model.statLines[i].chip = null;
  for (let i = 0; i < model.propLines.length; i++) model.propLines[i].chip = null;
}

/**
 * §5.6.3's placement algorithm for up to `MAX_COMPARE_PANELS` comparison
 * panels: chained on the side OPPOSITE the primary tooltip, top-aligned
 * with it, `COMPARE_GAP` apart; if the chain would leave the viewport, ALL
 * panels instead stack BELOW the primary, `COMPARE_BELOW_GAP` apart. Every
 * returned rect is additionally clamped inside `[EDGE, vw/vh - EDGE]` — the
 * orchestrator's own sweep requirement ("the containment ... guarantee
 * still hold with two extra panels on screen").
 * @param {{x:number,y:number,w:number,h:number}} primaryRect
 * @param {{w:number,h:number}[]} panelSizes - up to 2 entries.
 * @param {number} anchorX
 * @param {number} vw
 * @param {number} vh
 * @param {number} [k]
 * @returns {{x:number,y:number}[]} same length as `panelSizes`.
 */
export function computeComparePlacement(primaryRect, panelSizes, anchorX, vw, vh, k = 1) {
  const GAP = COMPARE_GAP * k;
  const BELOW_GAP = COMPARE_BELOW_GAP * k;
  const EDGE = EDGE_PLACE * k;
  const out = new Array(panelSizes.length);

  const primaryOnRight = primaryRect.x >= anchorX;
  // Try the opposite-side chain first.
  let fits = true;
  let cursor = primaryOnRight ? primaryRect.x - GAP : primaryRect.x + primaryRect.w + GAP;
  const chained = new Array(panelSizes.length);
  for (let i = 0; i < panelSizes.length; i++) {
    const w = panelSizes[i].w;
    let x;
    if (primaryOnRight) { x = cursor - w; cursor = x - GAP; }
    else { x = cursor; cursor = x + w + GAP; }
    if (x < EDGE || x + w > vw - EDGE) fits = false;
    chained[i] = { x, y: primaryRect.y };
  }

  if (fits) {
    for (let i = 0; i < panelSizes.length; i++) out[i] = chained[i];
  } else {
    // Fallback: stack below the primary, each COMPARE_BELOW_GAP apart,
    // left-aligned to the primary's own x (never measured against the
    // opposite side again — the primary's own x is already known-contained).
    let y = primaryRect.y + primaryRect.h + BELOW_GAP;
    for (let i = 0; i < panelSizes.length; i++) {
      out[i] = { x: primaryRect.x, y };
      y += panelSizes[i].h + BELOW_GAP;
    }
  }

  // Defensive containment clamp — always applied, on both paths (see this
  // function's own doc comment).
  for (let i = 0; i < panelSizes.length; i++) {
    const w = panelSizes[i].w; const h = panelSizes[i].h;
    out[i].x = clamp(out[i].x, EDGE, Math.max(EDGE, vw - EDGE - w));
    out[i].y = clamp(out[i].y, EDGE, Math.max(EDGE, vh - EDGE - h));
  }
  return out;
}

// ---------------------------------------------------------------------------
// A pooled row — label (left) + value (right), reused across rebuilds. The
// generic shape every base-stat/requirement/property/socket line renders
// through (§13.3: pool, never allocate a node per redraw).
// ---------------------------------------------------------------------------
function makeRow(doc) {
  const root = el('div', 'cl2-tt-row');
  const label = el('span', 'cl2-tt-label');
  const value = el('span', 'cl2-tt-value');
  // UI-7 — a third child, always present (never conditionally appended), so
  // a redraw never has to add/remove a node: `writeRowChip` below just sets
  // its text to `''` and hides it when the line carries no chip.
  const chip = el('span', 'cl2-tt-chip');
  root.appendChild(label);
  root.appendChild(value);
  root.appendChild(chip);
  return { root, label, value, chip };
}

/** Writes a row's optional trailing delta chip (`§5.6`'s "right-aligned
 * chip"). Shared by the primary tooltip's own row writer and the
 * comparison-panel writer — see this file's header on where a chip
 * actually renders. */
function writeRowChip(rec, chip) {
  if (!chip) {
    setStyle(rec.chip, 'display', 'none');
    return;
  }
  setStyle(rec.chip, 'display', 'inline');
  setText(rec.chip, chip.text);
  setClass(rec.chip, 'cl2-tt-chip-good', chip.cls === 'good');
  setClass(rec.chip, 'cl2-tt-chip-danger', chip.cls === 'danger');
}

const COLOUR_CLASSES = ['cl2-tt-c-normal', 'cl2-tt-c-superior', 'cl2-tt-c-magic', 'cl2-tt-c-rare', 'cl2-tt-c-unique', 'cl2-tt-c-danger', 'cl2-tt-c-property', 'cl2-tt-c-ink1', 'cl2-tt-c-ink2', 'cl2-tt-c-ink3', 'cl2-tt-c-ink4', 'cl2-tt-c-unidentified'];
function setColourClass(node, cls) {
  for (let i = 0; i < COLOUR_CLASSES.length; i++) setClass(node, COLOUR_CLASSES[i], COLOUR_CLASSES[i] === cls);
}

function safeGet(ctx, id) {
  if (!ctx) return null;
  if (typeof ctx.peek === 'function') return ctx.peek(id) || null;
  if (typeof ctx.has === 'function' && typeof ctx.get === 'function') return ctx.has(id) ? ctx.get(id) : null;
  if (typeof ctx.get === 'function') { try { return ctx.get(id); } catch { return null; } }
  return null;
}

// ---------------------------------------------------------------------------
// UI-7 — comparison panels. A comparison panel is "identical layout" to the
// primary (§5.6.2) MINUS the two-hand warning line (primary-only, §5.6.5)
// PLUS the `tooltip.equipped` micro label (§5.6.2). Built as its OWN small
// DOM tree/row-pool via `makeComparePanel`/`writeComparePanel`, deliberately
// NOT sharing `_buildDom`/`_writeDom` with the primary tooltip: the primary
// path is UI-5's, already tested end-to-end, and re-plumbing it to serve a
// second, structurally-different caller (no two-hand line, an extra label,
// a forced ink-4 seam, a forced 0.86 opacity ceiling) is a real risk to
// behaviour UI-5's own suite already locks down for a benefit (a few dozen
// shared lines) this project's own precedent (e.g. `equipment.js`'s
// `SLOT_ORDER` duplication note) already treats as the wrong trade. The
// duplication is the row-writing/block-toggling shape only — the DATA
// (`buildTooltipModel`, `computeContentWidth`, `computeHeightPlan`) is
// fully shared with the primary, never re-derived.
// ---------------------------------------------------------------------------

function makeComparePanel() {
  const root = el('div', 'cl2-tooltip cl2-tt-compare');
  const seam = el('div', 'cl2-tt-seam cl2-tt-seam-compare');
  root.appendChild(seam);

  const equippedLabelEl = el('div', 'cl2-tt-micro cl2-tt-center cl2-tt-c-ink3');
  const nameEl = el('div', 'cl2-tt-name');
  const baseTypeEl = el('div', 'cl2-tt-basetype');
  const rarityEl = el('div', 'cl2-tt-micro cl2-tt-center');
  const rule1 = el('div', 'cl2-tt-rule');
  const rule2 = el('div', 'cl2-tt-rule');
  const rule3 = el('div', 'cl2-tt-rule');
  const loreEl = el('div', 'cl2-tt-lore');
  const durabilityWarnEl = el('div', 'cl2-tt-micro cl2-tt-c-danger');
  const unidNoticeEl = el('div', 'cl2-tt-notice');
  const itemLevelEl = el('div', 'cl2-tt-micro cl2-tt-right');
  const compareBasisEl = el('div', 'cl2-tt-micro cl2-tt-c-ink4');

  root.appendChild(equippedLabelEl);
  root.appendChild(nameEl);
  root.appendChild(baseTypeEl);
  root.appendChild(rarityEl);
  root.appendChild(rule1);
  root.appendChild(rule2);
  root.appendChild(rule3);
  root.appendChild(loreEl);
  root.appendChild(durabilityWarnEl);
  root.appendChild(unidNoticeEl);
  root.appendChild(itemLevelEl);
  root.appendChild(compareBasisEl);

  return {
    root, seam, equippedLabelEl, nameEl, baseTypeEl, rarityEl,
    rule1, rule2, rule3, loreEl, durabilityWarnEl, unidNoticeEl, itemLevelEl, compareBasisEl,
    rows: [], rowPool: new Pool(POOL_CAPACITY, () => makeRow(), null),
    attached: false, slot: null, model: null,
    rectX: 0, rectY: 0, rectW: 0, rectH: 0,
  };
}

/** Writes `model` (a comparison item's own `buildTooltipModel` output, with
 * `.chip` already annotated by `computePanelChips`) into `panel`'s DOM —
 * the same 16-block sequence `Tooltip#_writeDom` writes for the primary,
 * minus block 16 (no hint row anywhere yet) and the two-hand warning
 * (primary-only), plus the `tooltip.equipped` label above block 1.
 */
function writeComparePanel(panel, model, t) {
  setText(panel.equippedLabelEl, t('tooltip.equipped'));

  setText(panel.nameEl, model.name);
  setColourClass(panel.nameEl, model.isUnidentified ? 'cl2-tt-c-' + model.rarity : 'cl2-tt-c-' + model.rarity);

  setStyle(panel.baseTypeEl, 'display', model.showBaseType ? 'block' : 'none');
  if (model.showBaseType) { setText(panel.baseTypeEl, model.baseTypeText); setColourClass(panel.baseTypeEl, 'cl2-tt-c-' + model.rarity); }

  setText(panel.rarityEl, model.rarityText);
  setColourClass(panel.rarityEl, model.isUnidentified ? 'cl2-tt-c-unidentified' : 'cl2-tt-c-' + model.rarity);

  panel.rowPool.forEachActive((rec) => { if (rec.root.parentNode) rec.root.parentNode.removeChild(rec.root); });
  for (let i = panel.rows.length - 1; i >= 0; i--) panel.rowPool.release(panel.rows[i], panel.rows[i].__slot);
  panel.rows.length = 0;

  const used = [];
  const addRow = (label, value, labelClass, valueClass, centered, chip) => {
    const rec = panel.rowPool.acquire();
    if (!rec) return;
    let slot = -1;
    panel.rowPool.forEachActive((r, s) => { if (r === rec) slot = s; });
    rec.__slot = slot;
    setText(rec.label, label || '');
    setText(rec.value, value || '');
    setColourClass(rec.label, labelClass);
    setColourClass(rec.value, valueClass);
    setClass(rec.root, 'cl2-tt-center', !!centered);
    writeRowChip(rec, chip || null);
    used.push(rec);
  };

  for (const l of model.statLines) {
    const cls = l.req ? (l.danger ? 'cl2-tt-c-danger' : 'cl2-tt-c-ink2') : (l.danger ? 'cl2-tt-c-danger' : (l.modified ? 'cl2-tt-c-property' : 'cl2-tt-c-ink1'));
    if (l.singleText) addRow(l.label, '', l.danger ? 'cl2-tt-c-danger' : 'cl2-tt-c-ink2', 'cl2-tt-c-ink1', false, l.chip);
    else addRow(l.label, l.value, l.req ? cls : 'cl2-tt-c-ink3', cls, false, l.chip);
  }
  for (const l of model.propLines) addRow(l.text, l.rangeText, l.danger ? 'cl2-tt-c-danger' : 'cl2-tt-c-property', 'cl2-tt-c-ink4', false, l.chip);
  for (const l of model.socketLines) addRow(l.label, '', 'cl2-tt-c-ink2', 'cl2-tt-c-ink1', false, null);

  panel.rows = used;
  for (const r of used) panel.root.appendChild(r.root);

  setStyle(panel.rule2, 'display', (model.propLines.length + model.socketLines.length) > 0 ? 'block' : 'none');
  setStyle(panel.rule3, 'display', model.showLore ? 'block' : 'none');
  setStyle(panel.loreEl, 'display', model.showLore ? 'block' : 'none');
  if (model.showLore) setText(panel.loreEl, model.loreText);

  setStyle(panel.durabilityWarnEl, 'display', model.showDurabilityWarning ? 'block' : 'none');
  if (model.showDurabilityWarning) setText(panel.durabilityWarnEl, model.durabilityWarningText);

  setStyle(panel.unidNoticeEl, 'display', model.showUnidentifiedNotice ? 'block' : 'none');
  if (model.showUnidentifiedNotice) setText(panel.unidNoticeEl, model.unidentifiedNoticeText);

  setText(panel.itemLevelEl, model.itemLevelText);

  // §5.6's compare-basis footnote — this panel names its own basis whenever
  // it itself carries the weapon-damage-mean or post-% defence line (see
  // `hasCompareBasisLine`); a panel is only ever built while comparison is
  // active (`_rebuildCompare` skips unoccupied slots), so no extra "is
  // compare active" test is needed here the way the primary needs one.
  model.showCompareBasis = hasCompareBasisLine(model);
  setStyle(panel.compareBasisEl, 'display', model.showCompareBasis ? 'block' : 'none');
  if (model.showCompareBasis) setText(panel.compareBasisEl, t('tooltip.compareBasis'));

  // Re-append the trailing structural nodes so DOM order matches §5.1 even
  // though they are appended unconditionally in `makeComparePanel()` —
  // same reasoning `Tooltip#_writeDom` already documents for the primary.
  panel.root.appendChild(panel.rule3);
  panel.root.appendChild(panel.loreEl);
  panel.root.appendChild(panel.durabilityWarnEl);
  panel.root.appendChild(panel.unidNoticeEl);
  panel.root.appendChild(panel.itemLevelEl);
  panel.root.appendChild(panel.compareBasisEl);
}

export class Tooltip {
  /**
   * @param {object} ctx
   * @param {object} layer - the `tooltip` `cl2-layer` node (`./style.js`).
   * @param {(key:string, params?:object) => string} translate
   * @param {object|null} [rng] - the shared `ui`-subsystem fork (see
   *   `hud.js`/`feedback.js`'s own constructors) — accepted for the same
   *   one-fork-per-subsystem reason, unused: nothing here needs jitter.
   */
  constructor(ctx, layer, translate, rng) {
    this._ctx = ctx;
    this._layer = layer;
    this._t = translate || ((key) => key);
    this._rng = rng || null;

    this._attached = false;
    this._visible = false; // fade target
    this._opacity = 0;

    this._altHeld = false;
    this._compare = false; // showTooltip's own per-call flag — fixed at open time (§16.1)
    this._compareHeld = false; // UI-7 — ui.setCompareHeld's live toggle (§16.1: switches an OPEN tooltip)
    this._compareActive = false; // last computed (this._compare || this._compareHeld) — change-guard for _rebuildCompare
    this._lang = 'en'; // active `ui` language — a rare's nameOverride carries both, `ui` picks (see buildTooltipModel's header)

    // UI-7 (§5.6) — up to MAX_COMPARE_PANELS comparison panels, built once
    // here (never per open — `ARCHITECTURE.md` rule 6), each its own small
    // DOM tree/row-pool (`makeComparePanel`). One shared scratch
    // `rolledMods` buffer: each panel is built fully (rolledMods -> a fresh
    // model object) before the next one starts, so reuse is safe — see
    // `_rebuildCompare`.
    this._comparePanels = [makeComparePanel(), makeComparePanel()];
    this._compareModBuf = [];

    this._pendingItem = null;
    this._pendingX = 0;
    this._pendingY = 0;
    this._showRequested = false;

    this._builtItem = null;
    this._builtIdentified = null;
    this._builtAlt = null;
    this._builtLang = null;
    this._model = null;

    this._anchorX = -1e9; this._anchorY = -1e9;
    this._vw = 1920; this._vh = 1080;
    this._rectX = 0; this._rectY = 0; this._rectW = 0; this._rectH = 0;
    this._placementDirty = false;
    this._lastOpacityQ = -1; // change-guard: `String(number)` allocates, only pay for it when the quantised value actually moved
    this._lastDisplayVisible = null;

    this._modBuf = [];

    this._rows = [];
    this._rowPool = new Pool(POOL_CAPACITY, () => makeRow(), null);

    this._buildDom();
  }

  _buildDom() {
    this._root = el('div', 'cl2-tooltip');
    this._seam = el('div', 'cl2-tt-seam');
    this._root.appendChild(this._seam);

    this._nameEl = el('div', 'cl2-tt-name');
    this._baseTypeEl = el('div', 'cl2-tt-basetype');
    this._rarityEl = el('div', 'cl2-tt-micro cl2-tt-center');
    this._rule1 = el('div', 'cl2-tt-rule');
    this._rule2 = el('div', 'cl2-tt-rule');
    this._rule3 = el('div', 'cl2-tt-rule');
    this._loreEl = el('div', 'cl2-tt-lore');
    this._durabilityWarnEl = el('div', 'cl2-tt-micro cl2-tt-c-danger');
    this._unidNoticeEl = el('div', 'cl2-tt-notice');
    this._itemLevelEl = el('div', 'cl2-tt-micro cl2-tt-right');
    // UI-7 (§5.6.5) — "prints tooltip.twoHandWarning under the primary".
    // Reuses `.cl2-tt-notice`'s existing style (the same italic-body
    // "special notice under the primary" look block 13 already uses) rather
    // than inventing a new CSS rule for a line the spec gives no worked
    // example of.
    this._twoHandWarnEl = el('div', 'cl2-tt-notice cl2-tt-c-danger');
    // §5.6 — the compare-basis footnote, `--ink-4` per spec.
    this._compareBasisEl = el('div', 'cl2-tt-micro cl2-tt-c-ink4');

    this._root.appendChild(this._nameEl);
    this._root.appendChild(this._baseTypeEl);
    this._root.appendChild(this._rarityEl);
    this._root.appendChild(this._rule1);
    this._root.appendChild(this._rule2);
    this._root.appendChild(this._rule3);
    this._root.appendChild(this._loreEl);
    this._root.appendChild(this._durabilityWarnEl);
    this._root.appendChild(this._unidNoticeEl);
    this._root.appendChild(this._itemLevelEl);
    this._root.appendChild(this._twoHandWarnEl);
    this._root.appendChild(this._compareBasisEl);
  }

  // -------------------------------------------------------------------
  // Public API — `02-api-contracts.md:1280-1283`.
  // -------------------------------------------------------------------

  /**
   * `(item, screenX, screenY, compare) => void`. `compare` is accepted and
   * stored, never acted on — comparison mode is UI-7 (see file header).
   */
  showTooltip(item, screenX, screenY, compare) {
    if (!item) return;
    this._pendingItem = item;
    this._pendingX = screenX;
    this._pendingY = screenY;
    this._compare = !!compare;
    this._showRequested = true;
  }

  hideTooltip() {
    this._showRequested = false;
    this._pendingItem = null;
  }

  /** Alt drives the roll-range reveal (§5.3.2) live on an already-open
   * tooltip — the one field whose change alone must force a content
   * rebuild even though the item itself did not change (clause 6). */
  setAltHeld(on) {
    this._altHeld = !!on;
  }

  /** `02-api-contracts.md:1284` — `setCompareHeld(on) => void`. Ctrl
   * pressed/released while a tooltip is already open must switch comparison
   * mode live (clause 4); `showTooltip`'s own `compare` flag is fixed at
   * open time, this is the other half. `update()` recomputes
   * `this._compare || this._compareHeld` every call, so simply flipping
   * this field is enough — no explicit rebuild trigger needed here. */
  setCompareHeld(on) {
    this._compareHeld = !!on;
  }

  /** Called by `UiSystem#setLanguage` (not `02-api-contracts.md` surface
   * itself — that method already exists; this is its internal wiring to
   * this module, the same shape `setScreen` already uses to inform
   * `hud`/`feedback`). A rare's `nameOverride` carries both `{en,ru}`
   * (ITEM-8) with no active-language parameter on `items` at all — `ui` is
   * the one place that knows which language is active, so a language
   * switch must force a content rebuild on an already-open tooltip, the
   * same live-update shape `setAltHeld` already has. */
  setLanguage(lang) {
    this._lang = lang === 'ru' ? 'ru' : 'en';
  }

  // -------------------------------------------------------------------
  // Frame update — `lateUpdate` only.
  // -------------------------------------------------------------------

  update(dt, ctx) {
    this._ctx = ctx;
    this._syncViewport(ctx);

    const item = this._showRequested ? this._pendingItem : null;
    if (item) {
      const needsRebuild = item !== this._builtItem
        || item.identified !== this._builtIdentified
        || this._altHeld !== this._builtAlt
        || this._lang !== this._builtLang;
      if (needsRebuild) {
        this._rebuildContent(item, ctx);
        this._placementDirty = true;
      }
      const dx = this._pendingX - this._anchorX;
      const dy = this._pendingY - this._anchorY;
      if ((dx * dx + dy * dy) > ANCHOR_MOVE_EPS * ANCHOR_MOVE_EPS) {
        this._anchorX = this._pendingX; this._anchorY = this._pendingY;
        this._placementDirty = true;
      }

      // UI-7 — comparison mode is recomputed on its OWN change-guard
      // (`compareActive`), independent of `needsRebuild`: `setCompareHeld`
      // (clause 4) must switch an already-open tooltip live, with no new
      // `showTooltip` call at all, so `_rebuildCompare` cannot be gated
      // behind the same `needsRebuild` the content model uses. It IS also
      // re-run whenever the primary content itself changed (`needsRebuild`)
      // — a different hovered item can mean different candidate slots.
      const compareActive = this._compare || this._compareHeld;
      if (compareActive !== this._compareActive || needsRebuild) {
        this._compareActive = compareActive;
        this._rebuildCompare(item, ctx, compareActive);
        this._placementDirty = true;
      }

      if (this._placementDirty) {
        this._recomputePlacement(ctx);
        this._placementDirty = false;
      }
    }

    // §2.6 tooltip fade — `damp` toward the visibility target, integrated
    // from `dt` (never a CSS transition, per the project-wide D-D rule).
    const target = item ? 1 : 0;
    this._opacity = damp(this._opacity, target, FADE_RATE, dt);
    if (Math.abs(this._opacity - target) < 0.004) this._opacity = target;
    this._applyVisibility();
  }

  _syncViewport(ctx) {
    const vw = (ctx && ctx.canvas && ctx.canvas.width) || this._vw;
    const vh = (ctx && ctx.canvas && ctx.canvas.height) || this._vh;
    if (vw === this._vw && vh === this._vh) return;
    this._vw = vw; this._vh = vh;
    if (this._builtItem) this._placementDirty = true;
  }

  _actorSnapshot(ctx) {
    const player = safeGet(ctx, 'player');
    const actor = player && player.actor;
    if (!actor) return null;
    const actors = safeGet(ctx, 'actors');
    const stats = actors && typeof actors.stats === 'function' ? actors.stats(actor) : null;
    if (!stats) return null;
    return { level: actor.level || 1, strength: stats.strength, dexterity: stats.dexterity, blockChance: stats.blockChance };
  }

  _rebuildContent(item, ctx) {
    const items = safeGet(ctx, 'items');
    const base = items && typeof items.base === 'function' ? items.base(item.baseId) : null;
    const n = items && typeof items.rolledMods === 'function' ? items.rolledMods(item, this._modBuf) : 0;

    let requirementUnmet = false;
    if (items && typeof items.canEquip === 'function') {
      const player = safeGet(ctx, 'player');
      const actor = player && player.actor;
      const slot = item.slot || (base ? base.slot : null);
      // UI-7 fix — `items.canEquip` (ITEM-11, real) returns `{ok, reason}`,
      // not a boolean; `!items.canEquip(...)` on an object is always
      // `false` regardless of `.ok`, so this line never actually flagged an
      // unmet requirement against the real subsystem (only the fixture-
      // driven tests, which pass `requirementUnmet` straight into
      // `buildTooltipModel`'s `opts`, ever exercised the flag). Found while
      // extending this exact function for comparison mode; not part of
      // this ticket's own acceptance clauses but a genuine pre-existing
      // correctness bug in the file this ticket reopens.
      const check = actor ? items.canEquip(actor, item, slot) : null;
      requirementUnmet = !!(check && check.ok === false);
    }
    const actorSnap = this._actorSnapshot(ctx);

    let loreText = '';
    let uniqueName = '';
    if (item.uniqueId && items && typeof items.unique === 'function') {
      const uniqueDef = items.unique(item.uniqueId);
      if (uniqueDef && uniqueDef.lore) loreText = uniqueDef.lore;
      if (uniqueDef && uniqueDef.name) uniqueName = uniqueDef.name;
    }

    this._model = buildTooltipModel(item, base, this._modBuf, n, {
      altHeld: this._altHeld, requirementUnmet, actorSnap, loreText, uniqueName, lang: this._lang,
    }, this._t);

    this._builtItem = item;
    this._builtIdentified = item.identified;
    this._builtAlt = this._altHeld;
    this._builtLang = this._lang;

    this._writeDom(this._model);
  }

  /**
   * UI-7 (§5.6) — resolves the candidate equip slots for the CURRENTLY
   * hovered item (`items.slotsFor`, plus the §5.6.5 two-hand/shield
   * extension), builds a full `buildTooltipModel` for whatever is actually
   * equipped in each occupied one (up to `MAX_COMPARE_PANELS`), annotates
   * delta chips on both sides (`computePanelChips`/`applyPrimaryNewChips`),
   * and writes the comparison panels' DOM. A panel with no occupant this
   * frame gets `panel.slot = null` — `_recomputePlacement`/`_applyVisibility`
   * treat that as "not on screen", never destroying its DOM (§ARCHITECTURE
   * rule 6: pools/panels are built once in `init()`/the constructor).
   * @param {object} item - the hovered item (== `this._builtItem`).
   * @param {object} ctx
   * @param {boolean} active - `this._compare || this._compareHeld`.
   */
  _rebuildCompare(item, ctx, active) {
    const items = safeGet(ctx, 'items');
    const player = safeGet(ctx, 'player');
    const actor = player && player.actor;
    const base = items && typeof items.base === 'function' ? items.base(item.baseId) : null;

    let slots = [];
    let twoHandWarning = false;
    if (active && items && actor) {
      slots = (typeof items.slotsFor === 'function') ? items.slotsFor(item) : [];
      // §5.6.5 — "A two-handed weapon hovered while a shield is equipped
      // shows the shield as a second comparison" even though `slotsFor` a
      // two-hander is `mainHand`-only (that is the whole reason clause 2's
      // ring case exists: `slotsFor` alone is not always the full candidate
      // list). `items.hasShield` (ITEM-11) is the authority on "is the
      // offHand item a shield", not a guessed base-slot check.
      if (base && base.category === 'weapon' && base.weapon && base.weapon.twoHanded
          && typeof items.hasShield === 'function' && items.hasShield(actor)
          && slots.indexOf('offHand') === -1) {
        slots = slots.concat('offHand');
        twoHandWarning = true;
      }
      if (slots.length > MAX_COMPARE_PANELS) slots = slots.slice(0, MAX_COMPARE_PANELS); // §5.6.2 "up to two"
    }

    const occupied = [];
    if (active && items && actor && typeof items.equipped === 'function') {
      for (let i = 0; i < slots.length && occupied.length < MAX_COMPARE_PANELS; i++) {
        const eq = items.equipped(actor, slots[i]);
        // §5.6.2: "For each OCCUPIED candidate slot" — an empty slot builds
        // no panel at all, it does not count toward "up to two".
        if (eq) occupied.push({ slot: slots[i], item: eq });
      }
    }

    if (this._model) {
      this._model.showTwoHandWarning = twoHandWarning && occupied.length > 0;
      // `_writeDom` (which owns this element's normal write) already ran
      // earlier this same `update()` call, before `showTwoHandWarning` was
      // known — same "lightweight refresh after the fact" shape
      // `_refreshPrimaryChips` uses for the chip spans, applied here
      // directly since it is one element, not a pooled row list.
      setStyle(this._twoHandWarnEl, 'display', this._model.showTwoHandWarning ? 'block' : 'none');
      if (this._model.showTwoHandWarning) setText(this._twoHandWarnEl, this._t('tooltip.twoHandWarning'));

      // §5.6's compare-basis footnote — the primary names its own basis
      // only once comparison has actually found something to compare
      // against (`occupied.length > 0`); before that (Ctrl held over an
      // empty slot) there is no comparison to explain a basis for.
      this._model.showCompareBasis = occupied.length > 0 && hasCompareBasisLine(this._model);
      setStyle(this._compareBasisEl, 'display', this._model.showCompareBasis ? 'block' : 'none');
      if (this._model.showCompareBasis) setText(this._compareBasisEl, this._t('tooltip.compareBasis'));
    }

    const unionKeys = [];
    for (let p = 0; p < this._comparePanels.length; p++) {
      const panel = this._comparePanels[p];
      const occ = occupied[p];
      if (!occ) { panel.slot = null; panel.model = null; continue; }

      panel.slot = occ.slot;
      const pBase = items && typeof items.base === 'function' ? items.base(occ.item.baseId) : null;
      const n = items && typeof items.rolledMods === 'function' ? items.rolledMods(occ.item, this._compareModBuf) : 0;

      let pRequirementUnmet = false;
      if (items && typeof items.canEquip === 'function' && actor) {
        const r = items.canEquip(actor, occ.item, occ.slot);
        pRequirementUnmet = !!(r && r.ok === false);
      }
      let pLoreText = ''; let pUniqueName = '';
      if (occ.item.uniqueId && items && typeof items.unique === 'function') {
        const uniqueDef = items.unique(occ.item.uniqueId);
        if (uniqueDef && uniqueDef.lore) pLoreText = uniqueDef.lore;
        if (uniqueDef && uniqueDef.name) pUniqueName = uniqueDef.name;
      }

      const pModel = buildTooltipModel(occ.item, pBase, this._compareModBuf, n, {
        altHeld: this._altHeld, requirementUnmet: pRequirementUnmet, actorSnap: this._actorSnapshot(ctx),
        loreText: pLoreText, uniqueName: pUniqueName, lang: this._lang,
      }, this._t);
      panel.model = pModel;

      if (this._model) {
        const keys = computePanelChips(this._model, pModel, this._t);
        for (let k = 0; k < keys.length; k++) if (unionKeys.indexOf(keys[k]) === -1) unionKeys.push(keys[k]);
      }
      writeComparePanel(panel, pModel, this._t);
    }

    if (this._model) {
      if (occupied.length > 0) applyPrimaryNewChips(this._model, unionKeys, this._t);
      else clearChips(this._model);
      // `_writeDom` already wrote the primary's rows before this method
      // ran (see `update()`'s ordering) — the chips it wrote were
      // necessarily stale/absent, so the chip spans need their own
      // lightweight refresh rather than a full row rebuild.
      this._refreshPrimaryChips();
    }
  }

  /** Re-syncs every primary row's chip span from `this._model`'s current
   * `.chip` fields, without touching the pool or any other row content —
   * `_rebuildCompare` calls this after annotating the model, since
   * `_writeDom` (which built the rows) already ran by that point. Row order
   * is `[stat lines][prop lines][socket lines]`, the same fixed slice
   * `_applyHeightPlan` already relies on. */
  _refreshPrimaryChips() {
    const model = this._model;
    if (!model) return;
    const statCount = model.statLines.length;
    const propCount = model.propLines.length;
    for (let i = 0; i < this._rows.length; i++) {
      let chip = null;
      if (i < statCount) chip = model.statLines[i].chip;
      else if (i < statCount + propCount) chip = model.propLines[i - statCount].chip;
      writeRowChip(this._rows[i], chip || null);
    }
  }

  _writeDom(model) {
    setText(this._nameEl, model.name);
    setColourClass(this._nameEl, model.isUnidentified ? 'cl2-tt-c-' + model.rarity : 'cl2-tt-c-' + model.rarity);

    setStyle(this._baseTypeEl, 'display', model.showBaseType ? 'block' : 'none');
    if (model.showBaseType) { setText(this._baseTypeEl, model.baseTypeText); setColourClass(this._baseTypeEl, 'cl2-tt-c-' + model.rarity); }

    setText(this._rarityEl, model.rarityText);
    setColourClass(this._rarityEl, model.isUnidentified ? 'cl2-tt-c-unidentified' : 'cl2-tt-c-' + model.rarity);

    const seamClass = model.requirementUnmetAny ? 'cl2-tt-seam-danger' : 'cl2-tt-seam-' + model.rarity;
    for (const c of ['cl2-tt-seam-normal', 'cl2-tt-seam-superior', 'cl2-tt-seam-magic', 'cl2-tt-seam-rare', 'cl2-tt-seam-unique', 'cl2-tt-seam-danger']) setClass(this._seam, c, c === seamClass);

    this._rowPool.forEachActive((rec) => { if (rec.root.parentNode) rec.root.parentNode.removeChild(rec.root); });
    for (let i = this._rows.length - 1; i >= 0; i--) this._rowPool.release(this._rows[i], this._rows[i].__slot);
    this._rows.length = 0;

    const usedRows = [];
    const addRow = (label, value, labelClass, valueClass, centered, chip) => {
      const rec = this._rowPool.acquire();
      if (!rec) return;
      let slot = -1;
      this._rowPool.forEachActive((r, s) => { if (r === rec) slot = s; });
      rec.__slot = slot;
      setText(rec.label, label || '');
      setText(rec.value, value || '');
      setColourClass(rec.label, labelClass);
      setColourClass(rec.value, valueClass);
      setClass(rec.root, 'cl2-tt-center', !!centered);
      // UI-7 — a row's `.chip` is `undefined` until comparison mode has run
      // at least once for this content; the pool never resets a record on
      // acquire (`Pool`'s own `reset` arg is `null` here), so this write
      // must be UNCONDITIONAL (never skipped when `chip` is falsy) or a
      // chip from a previous item's comparison would linger on a reused row.
      writeRowChip(rec, chip || null);
      usedRows.push(rec);
      return rec;
    };

    for (const l of model.statLines) {
      const cls = l.req ? (l.danger ? 'cl2-tt-c-danger' : 'cl2-tt-c-ink2') : (l.danger ? 'cl2-tt-c-danger' : (l.modified ? 'cl2-tt-c-property' : 'cl2-tt-c-ink1'));
      if (l.singleText) addRow(l.label, '', l.danger ? 'cl2-tt-c-danger' : 'cl2-tt-c-ink2', 'cl2-tt-c-ink1', false, l.chip);
      else addRow(l.label, l.value, l.req ? cls : 'cl2-tt-c-ink3', cls, false, l.chip);
    }
    for (const l of model.propLines) addRow(l.text, l.rangeText, l.danger ? 'cl2-tt-c-danger' : 'cl2-tt-c-property', 'cl2-tt-c-ink4', false, l.chip);
    for (const l of model.socketLines) addRow(l.label, '', 'cl2-tt-c-ink2', 'cl2-tt-c-ink1', false, null);

    this._rows = usedRows;
    for (const r of usedRows) this._root.appendChild(r.root);

    setStyle(this._rule2, 'display', (model.propLines.length + model.socketLines.length) > 0 ? 'block' : 'none');
    setStyle(this._rule3, 'display', model.showLore ? 'block' : 'none');
    setStyle(this._loreEl, 'display', model.showLore ? 'block' : 'none');
    if (model.showLore) setText(this._loreEl, model.loreText);

    setStyle(this._durabilityWarnEl, 'display', model.showDurabilityWarning ? 'block' : 'none');
    if (model.showDurabilityWarning) setText(this._durabilityWarnEl, model.durabilityWarningText);

    setStyle(this._unidNoticeEl, 'display', model.showUnidentifiedNotice ? 'block' : 'none');
    if (model.showUnidentifiedNotice) setText(this._unidNoticeEl, model.unidentifiedNoticeText);

    setText(this._itemLevelEl, model.itemLevelText);

    // §5.6.5 — the two-hand/shield warning. `model.showTwoHandWarning` is
    // set by `_rebuildCompare`, not by `buildTooltipModel` (it depends on
    // comparison context, not the item alone) — this call runs BEFORE that
    // one this frame (see `update()`'s ordering), so it reads whatever the
    // model already carried from its last comparison pass; `_rebuildCompare`
    // does not need to re-invoke `_writeDom` for this one field, only the
    // display/text below, the same lightweight-refresh shape
    // `_refreshPrimaryChips` already uses for the chip spans.
    setStyle(this._twoHandWarnEl, 'display', model.showTwoHandWarning ? 'block' : 'none');
    if (model.showTwoHandWarning) setText(this._twoHandWarnEl, this._t('tooltip.twoHandWarning'));

    // Re-append the trailing structural rows so DOM order matches §5.1
    // even though they are appended unconditionally in `_buildDom()`.
    this._root.appendChild(this._rule3);
    this._root.appendChild(this._loreEl);
    this._root.appendChild(this._durabilityWarnEl);
    this._root.appendChild(this._unidNoticeEl);
    this._root.appendChild(this._itemLevelEl);
    this._root.appendChild(this._twoHandWarnEl);
  }

  _recomputePlacement(ctx) {
    const model = this._model;
    if (!model) return;
    const w = computeContentWidth(model);
    const plan = computeHeightPlan(model, w, this._vh);
    this._applyHeightPlan(model, plan);

    const input = ctx && ctx.input;
    const cursorX = input && input.pointer ? input.pointer.x : null;
    const cursorY = input && input.pointer ? input.pointer.y : null;

    const pos = computePlacement(this._anchorX, this._anchorY, w, plan.height, this._vw, this._vh, cursorX, cursorY);
    this._rectX = pos.x; this._rectY = pos.y; this._rectW = w; this._rectH = plan.height;
    setStyle(this._root, 'width', w + 'px');
    place(this._root, pos.x, pos.y);

    this._recomputeComparePlacement();
  }

  /** UI-7 (§5.6.3) — sizes and places every currently-occupied comparison
   * panel against the primary's just-computed rect. Panels with
   * `panel.slot === null` this frame are left alone (their DOM state does
   * not matter — `_applyVisibility` never attaches them). */
  _recomputeComparePlacement() {
    const openPanels = [];
    const sizes = [];
    for (let p = 0; p < this._comparePanels.length; p++) {
      const panel = this._comparePanels[p];
      if (panel.slot === null || !panel.model) continue;
      const pw = computeContentWidth(panel.model);
      const pplan = computeHeightPlan(panel.model, pw, this._vh);
      this._applyHeightPlanToPanel(panel, panel.model, pplan);
      panel.rectW = pw; panel.rectH = pplan.height;
      setStyle(panel.root, 'width', pw + 'px');
      openPanels.push(panel);
      sizes.push({ w: pw, h: pplan.height });
    }
    if (openPanels.length === 0) return;

    const primaryRect = { x: this._rectX, y: this._rectY, w: this._rectW, h: this._rectH };
    const positions = computeComparePlacement(primaryRect, sizes, this._anchorX, this._vw, this._vh);
    for (let i = 0; i < openPanels.length; i++) {
      openPanels[i].rectX = positions[i].x;
      openPanels[i].rectY = positions[i].y;
      place(openPanels[i].root, positions[i].x, positions[i].y);
    }
  }

  /** Comparison-panel analogue of `_applyHeightPlan` — same degradation
   * ladder, applied to `panel`'s own DOM instead of the primary's. */
  _applyHeightPlanToPanel(panel, model, plan) {
    setStyle(panel.loreEl, 'display', (model.showLore && plan.showLore) ? 'block' : 'none');
    setStyle(panel.rule3, 'display', (model.showLore && plan.showLore) ? 'block' : 'none');
    setStyle(panel.itemLevelEl, 'display', plan.showItemLevel ? 'block' : 'none');
    const statCount = model.statLines.length;
    const propCount = model.propLines.length;
    for (let i = 0; i < panel.rows.length; i++) {
      const isProp = i >= statCount && i < statCount + propCount;
      setStyle(panel.rows[i].root, 'lineHeight', (isProp ? plan.propLineHeight : LH_BODY) + 'px');
    }
    setStyle(panel.rule2, 'display', (model.propLines.length + model.socketLines.length) > 0 ? 'block' : 'none');
  }

  _applyHeightPlan(model, plan) {
    setStyle(this._loreEl, 'display', (model.showLore && plan.showLore) ? 'block' : 'none');
    setStyle(this._rule3, 'display', (model.showLore && plan.showLore) ? 'block' : 'none');
    setStyle(this._itemLevelEl, 'display', plan.showItemLevel ? 'block' : 'none');
    // Ladder step (a) reduces ONLY the property line-height (§5.7) — the
    // pooled rows are appended in a fixed order (stat/requirement lines,
    // then property lines, then socket lines), so that slice is exactly
    // `[statCount, statCount + propCount)`.
    const statCount = model.statLines.length;
    const propCount = model.propLines.length;
    for (let i = 0; i < this._rows.length; i++) {
      const isProp = i >= statCount && i < statCount + propCount;
      setStyle(this._rows[i].root, 'lineHeight', (isProp ? plan.propLineHeight : LH_BODY) + 'px');
    }
    setStyle(this._rule2, 'display', (model.propLines.length + model.socketLines.length) > 0 ? 'block' : 'none');
  }

  _applyVisibility() {
    const visible = this._opacity > 0.004;
    if (visible && !this._attached) { this._layer.appendChild(this._root); this._attached = true; }
    if (this._lastDisplayVisible !== visible) {
      this._lastDisplayVisible = visible;
      setStyle(this._root, 'display', visible ? 'block' : 'none');
    }
    // Quantise, then compare the NUMBER before `String()`-ing it — the
    // same change-guard `feedback.js#_updateVignette`/`_updateFlash` use.
    // `String(n)` allocates a fresh string every call; skipping it when
    // the quantised value is unchanged is what keeps a steady-state (fully
    // open or fully closed, nothing moving) frame allocation-free.
    const opacityQ = Math.round(this._opacity * 1000) / 1000;
    if (this._lastOpacityQ !== opacityQ) {
      this._lastOpacityQ = opacityQ;
      setStyle(this._root, 'opacity', String(opacityQ));
    }
    if (!visible && this._attached) { this._root.remove(); this._attached = false; }

    this._applyComparePanelsVisibility(visible);
  }

  /** UI-7 — every comparison panel shares the primary's own `_opacity`
   * integrator (one fade, driven by whether the tooltip itself is shown),
   * scaled by `COMPARE_OPACITY` (§5.6.2's fixed 0.86 ceiling) — a panel
   * never fades independently of the tooltip it belongs to. A panel with
   * `slot === null` this frame (nothing equipped there / comparison off) is
   * force-detached regardless of the primary's own visibility. */
  _applyComparePanelsVisibility(primaryVisible) {
    const opacityQ = Math.round(this._opacity * COMPARE_OPACITY * 1000) / 1000;
    for (let p = 0; p < this._comparePanels.length; p++) {
      const panel = this._comparePanels[p];
      const shouldShow = primaryVisible && panel.slot !== null && !!panel.model;
      if (shouldShow && !panel.attached) { this._layer.appendChild(panel.root); panel.attached = true; }
      if (shouldShow) {
        setStyle(panel.root, 'display', 'block');
        setStyle(panel.root, 'opacity', String(opacityQ));
      } else if (panel.attached) {
        setStyle(panel.root, 'display', 'none');
      }
      if (!shouldShow && panel.attached) { panel.root.remove(); panel.attached = false; }
    }
  }

  dispose() {
    if (this._root && this._root.remove) this._root.remove();
    this._root = null;
    this._attached = false;
    for (let p = 0; p < this._comparePanels.length; p++) {
      const panel = this._comparePanels[p];
      if (panel.root && panel.root.remove) panel.root.remove();
      panel.attached = false;
    }
  }

  // -------------------------------------------------------------------
  // Dev-only inspection — double-underscore, not `02-api-contracts.md`
  // surface (rule 7), matching `hud.js`/`feedback.js`'s own convention.
  // -------------------------------------------------------------------

  __nodeCount() {
    return this._root ? countNodes(this._root) : 0;
  }

  __isVisible() {
    return this._opacity > 0.004;
  }

  __rect() {
    return { x: this._rectX, y: this._rectY, w: this._rectW, h: this._rectH };
  }

  __model() {
    return this._model;
  }

  // -- UI-7 comparison-mode dev inspection ------------------------------

  /** @returns {number} how many comparison panels are attached (visible)
   * right now — 0, 1 or 2. */
  __comparePanelCount() {
    let n = 0;
    for (let p = 0; p < this._comparePanels.length; p++) if (this._comparePanels[p].attached) n++;
    return n;
  }

  /** @returns {object|null} panel `p`'s (0 or 1) own model, or `null` when
   * that panel has nothing equipped this frame. */
  __comparePanelModel(p) {
    const panel = this._comparePanels[p];
    return panel ? panel.model : null;
  }

  /** @returns {string|null} panel `p`'s equip slot (e.g. `'ring1'`), or
   * `null`. */
  __comparePanelSlot(p) {
    const panel = this._comparePanels[p];
    return panel ? panel.slot : null;
  }

  __compareRect(p) {
    const panel = this._comparePanels[p];
    if (!panel) return null;
    return { x: panel.rectX, y: panel.rectY, w: panel.rectW, h: panel.rectH };
  }

  /** @returns {number} the primary tooltip's node count plus every
   * currently-ATTACHED comparison panel's — the real on-screen total the
   * `09 §13.1` 700-node ceiling is measured against, as opposed to
   * `__nodeCount()` (primary only, UI-5's own established contract, left
   * unchanged for its own test's sake). */
  __totalNodeCount() {
    let n = this.__nodeCount();
    for (let p = 0; p < this._comparePanels.length; p++) {
      if (this._comparePanels[p].attached) n += countNodes(this._comparePanels[p].root);
    }
    return n;
  }
}
