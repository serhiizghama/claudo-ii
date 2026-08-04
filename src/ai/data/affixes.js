// src/ai/data/affixes.js
//
// AI-8 — the nine monster affixes, the two unique-name tables, the §6.7
// telegraph rows and the §6.4 tier gate, as plain frozen objects.
// `ARCHITECTURE.md` rule 9: "gameplay numbers live in data, not in code" —
// nothing in this file is logic, and it imports nothing at all, so
// `tools/balance.mjs` and `tools/mapgen.mjs` can read it with no engine, no
// `ctx` and no subsystem alive. `tools/check-imports.mjs` auto-discovers
// every `src/**/data/` directory and scans it for `three`/DOM/
// `performance.now()`; this file has none of the three by construction.
//
// Sources, all transcribed rather than derived:
//   §6.1  the nine rows: group, weight, and `03-combat-math.md` §9.4's effect
//   §6.2  the mechanical detail `03` leaves open (radii, cadences, fractions)
//   §6.3  per-archetype eligibility (INVERTED — see `AFFIX_INELIGIBLE`)
//   §6.4  `immunityValue(tier)` — 85 at Instruction, 100 above it
//   §6.5  the danger points, the three hard exclusion pairs
//   §6.7  the rank auras and the per-affix telegraph rows
//   §5.8  the 16 epithets and 12 titles
//
// ---------------------------------------------------------------------------
// File name: `affixes.js`, not `monster-affixes.js`
// ---------------------------------------------------------------------------
// `01-data-model.md` §9.5 names this table's home
// `src/ai/data/monster-affixes.js`. This ticket's file grant names
// `src/ai/data/affixes.js`, and a file grant is not something a ticket may
// widen on its own. The two are the same table under two names; whichever a
// later ticket standardises on, the export shapes below are unchanged.
// Reported, not silently renamed.
//
// ---------------------------------------------------------------------------
// How a multiplicative effect is expressed here
// ---------------------------------------------------------------------------
// `03` §9.4 states three affix effects as MULTIPLIERS on an already-composed
// number (`stoneskin`'s `defense × 2.5`, `mighty`'s `damage × 1.55` and
// `attackRating × 1.25`). `01-data-model.md` §4.2's stat pipeline is additive
// per layer, and it already carries the percent fields those multipliers are
// the spec's prose form of: `defensePercent`, `enhancedDamage`,
// `attackRatingPercent` — each folded by `composeStats`' own `derive()` step
// as `flat × (1 + percent/100)`. So `× 2.5` is stored below as
// `defensePercent: 150`, `× 1.55` as `enhancedDamage: 55`, `× 1.25` as
// `attackRatingPercent: 25`. The raw multiplier is ALSO kept, verbatim, under
// `behaviour`, because `06` §6.2 pins `mighty` to build step **B4** of the
// damage packet (a `combat` step, not a `StatBlock` step) and a future brain
// that builds the packet needs the multiplier itself, not a percent.
//
// Measured, and reported rather than routed around: of the eleven StatBlock
// fields below, only four have a SHIPPED consumer today —
// `fireResist`/`coldResist`/`lightResist` (read by `src/combat/resolve.js`'s
// element mitigation), `damageReducePercent` (its `stepR7b`) and
// `defensePercent` (`derive()` -> `chanceToHit`). `enhancedDamage`,
// `attackRatingPercent`, `increasedAttackSpeed`, `movementSpeed` and
// `lifeSteal` currently reach no shipped code path on a monster: all six
// `src/ai/brains/*.js` build their packets straight from
// `BESTIARY[archetypeId] × damageMult(mlvl)` and read neither `actor.rank`
// nor `actor.stats`, and `src/actors/motion.js#moveSpeed` hardcodes
// `movementSpeed = 0`. Both files are outside this ticket's grant. See the
// ticket report.

/** `06` §6.1's three groups, in `06` §6.5's fixed unique-draw order
 * (`immunity -> power -> utility`). The order is load-bearing: §14.1's draw
 * order is stated against it. */
export const AFFIX_GROUPS = Object.freeze(['immunity', 'power', 'utility']);

/** `06` §6.1's own stated group totals — 34 / 41 / 25, summing to 100.
 * `06` §6.5: a champion draws a GROUP by these weights and then an affix
 * within it by its own weight, which reproduces the flat 100-weight table
 * exactly. Kept here so both schemes read one table, never two. */
export const AFFIX_GROUP_WEIGHTS = Object.freeze({ immunity: 34, power: 41, utility: 25 });

/**
 * The nine rows of `06` §6.1, with §6.2's mechanical detail folded into
 * `behaviour` and §6.5's danger points into `danger`.
 *
 * `stats` is a partial `StatBlock` layer (`01-data-model.md` §4.2 step 6/7
 * shape) carrying only the fields that are CONSTANT. The one field that is
 * not constant — an `immunity` affix's resist, which is `immunityValue(tier)`
 * (§6.4) — is named by `immunityResist` and filled in by
 * `src/ai/rank.js#affixStats`, never hardcoded here.
 *
 * @typedef {{id:string, en:string, ru:string, group:string, weight:number,
 *   danger:number, immunityResist:(string|null),
 *   stats:Readonly<Record<string,number>>,
 *   behaviour:Readonly<Record<string,(number|string)>>}} MonsterAffix
 * @type {Readonly<Record<string, MonsterAffix>>}
 */
export const MONSTER_AFFIXES = Object.freeze({
  burning: Object.freeze({
    id: 'burning', en: 'Burning', ru: 'Огненный',
    group: 'immunity', weight: 12, danger: 2,
    immunityResist: 'fireResist',
    stats: Object.freeze({}),
    // §6.2: one packet, `fireMin = fireMax = 0.60 × maxLife`, AR 0, not
    // dodgeable, not blockable, radius 3.5 m, on the death tick BEFORE the
    // corpse decision, and it never chains.
    behaviour: Object.freeze({
      deathBurstLifeFraction: 0.60, deathBurstRadius: 3.5,
      deathBurstElement: 'fire', deathBurstAttackRating: 0,
      deathBurstDodgeable: 0, deathBurstBlockable: 0, deathBurstChains: 0,
    }),
  }),
  charged: Object.freeze({
    id: 'charged', en: 'Charged', ru: 'Молниевый',
    group: 'immunity', weight: 11, danger: 2,
    immunityResist: 'lightResist',
    stats: Object.freeze({}),
    // §6.2: 3.0 s cooldown STARTING 3.0 s after the brain leaves `dormant`
    // (never at spawn), 4 charges of 40 % of the row damage as lightning,
    // `shocked` rider at chance 100, nearest 4 hostiles within 9.0 m, AR 0.
    behaviour: Object.freeze({
      chargeCount: 4, cooldownSeconds: 3.0, firstVolleyDelaySeconds: 3.0,
      damageFraction: 0.40, element: 'lightning', targetRadius: 9.0,
      status: 'shocked', statusChance: 100, attackRating: 0,
    }),
  }),
  frostbound: Object.freeze({
    id: 'frostbound', en: 'Frostbound', ru: 'Ледяной',
    group: 'immunity', weight: 11, danger: 2,
    immunityResist: 'coldResist',
    stats: Object.freeze({}),
    // §6.2: a status APPLICATION, not a hit — no to-hit, no crit, no
    // `chillPoints`, so a frostbound champion can never freeze the player.
    behaviour: Object.freeze({
      auraRadius: 7.0, reapplyTicks: 30, status: 'chilled',
      magnitude: 35, durationSeconds: 1.0, isHit: 0, contributesChillPoints: 0,
    }),
  }),
  swift: Object.freeze({
    id: 'swift', en: 'Swift', ru: 'Очень быстрый',
    group: 'power', weight: 14, danger: 3,
    immunityResist: null,
    stats: Object.freeze({ increasedAttackSpeed: 60, movementSpeed: 45 }),
    // §6.2: scales W and R and never S, and is subject to the Maulsmith's
    // 0.90 s wind-up floor and the Crawler's un-scalable fuse (MB19, which
    // `tools/balance.mjs` already asserts against exactly this +60).
    behaviour: Object.freeze({ scalesWindup: 1, scalesRecover: 1, scalesActive: 0 }),
  }),
  mighty: Object.freeze({
    id: 'mighty', en: 'Mighty', ru: 'Очень сильный',
    group: 'power', weight: 14, danger: 3,
    immunityResist: null,
    // See this file's header for why `× 1.55` / `× 1.25` are stored as
    // percent fields here AND as raw multipliers under `behaviour`.
    stats: Object.freeze({ enhancedDamage: 55, attackRatingPercent: 25 }),
    behaviour: Object.freeze({ damageMult: 1.55, attackRatingMult: 1.25, packetBuildStep: 'B4' }),
  }),
  stoneskin: Object.freeze({
    id: 'stoneskin', en: 'Stoneskin', ru: 'Каменная кожа',
    group: 'power', weight: 13, danger: 3,
    immunityResist: null,
    // §6.2: `damageReducePercent += 25` SUMS with the rank's contribution and
    // is capped at 50 by `01` §3.4 — the cap is `clampBlock`'s job, not this
    // table's, so 25 is stored raw.
    stats: Object.freeze({ defensePercent: 150, damageReducePercent: 25 }),
    behaviour: Object.freeze({ defenseMult: 2.5, deflectSoundBelowMitigatedFraction: 0.40 }),
  }),
  hexing: Object.freeze({
    id: 'hexing', en: 'Hexing', ru: 'Проклинающий',
    group: 'utility', weight: 9, danger: 2,
    immunityResist: null,
    stats: Object.freeze({}),
    // §6.2: max-wins refresh, so two hexing monsters are no worse than one.
    // `cursed` magnitude 40 is -40 % defence and -15 on all six resists
    // (`03` §7.10) — that expansion belongs to `combat`'s status table, not
    // here.
    behaviour: Object.freeze({
      cooldownSeconds: 6.0, firstCastDelaySeconds: 2.0, castSeconds: 0.6,
      radius: 8.0, status: 'cursed', magnitude: 40, durationSeconds: 8.0, refresh: 'max-wins',
    }),
  }),
  vampiric: Object.freeze({
    id: 'vampiric', en: 'Vampiric', ru: 'Аура вампиризма',
    group: 'utility', weight: 8, danger: 2,
    immunityResist: null,
    // §6.2: a flat SET, not an add — 30 % of POST-mitigation physical dealt
    // (`03` §6.2 R14d), which is why a heavily armoured player starves it.
    stats: Object.freeze({ lifeSteal: 30 }),
    behaviour: Object.freeze({ leechPercent: 30, readsPostMitigation: 1, isSet: 1 }),
  }),
  multishot: Object.freeze({
    id: 'multishot', en: 'Multishot', ru: 'Мультивыстрел',
    group: 'utility', weight: 8, danger: 2,
    immunityResist: null,
    stats: Object.freeze({}),
    // §6.2: 3 packets at 0.70x on bearings `facing -11°/facing/+11°` (the
    // 22° spread of §6.1), all on the same `hitTick`. On a melee archetype
    // the single packet's `overlapCone` becomes radius 2.4 m, half-angle 60°,
    // at UNCHANGED damage.
    behaviour: Object.freeze({
      rangedProjectiles: 3, spreadDegrees: 22, bearingOffsetDegrees: 11,
      rangedDamageFraction: 0.70, meleeCleaveRadius: 2.4, meleeCleaveHalfAngleDegrees: 60,
      meleeDamageFraction: 1.00,
    }),
  }),
});

/** Every affix id, in `06` §6.1's own printed row order. */
export const AFFIX_IDS = Object.freeze(Object.keys(MONSTER_AFFIXES));

/**
 * `06` §6.3, INVERTED — the excluded set per archetype.
 *
 * The spec's own table prints the ELIGIBLE ids in three columns (one per
 * group) and names the exclusions only in its prose "Excluded because"
 * column, so this is a derivation and not a transcription. It is stored this
 * way because `bone_ranker` — the archetype every unrestricted call falls
 * back to — is "all 3 / all 3 / all 3", and an empty array is the honest
 * shape for that. The inversion is checked against the spec's own eligible
 * columns by `tools/balance.mjs`'s `MB10.shipped` row, not trusted.
 *
 * Every archetype not listed with an id is eligible for it. `molgrim` takes
 * no affix at all ("The boss takes no affixes. His three phases are his
 * affixes") and is therefore the one row that excludes all nine.
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const AFFIX_INELIGIBLE = Object.freeze({
  bone_ranker: Object.freeze([]),
  carrion_swarm: Object.freeze(['hexing', 'multishot']),
  ashen_archer: Object.freeze(['vampiric']),
  dust_shaman: Object.freeze(['vampiric']),
  maulsmith: Object.freeze(['multishot']),
  blight_crawler: Object.freeze(['burning', 'vampiric', 'multishot']),
  molgrim: Object.freeze(AFFIX_IDS.slice()),
});

/**
 * `06` §6.5's three hard exclusion pairs. `archetypeId: null` means the pair
 * is illegal on every archetype; the third row is archetype-scoped exactly as
 * §6.5 scopes it ("`mighty` + `multishot` on `ashen_archer`").
 *
 * @type {ReadonlyArray<Readonly<{a:string, b:string, archetypeId:(string|null)}>>}
 */
export const AFFIX_EXCLUSIONS = Object.freeze([
  Object.freeze({ a: 'frostbound', b: 'swift', archetypeId: null }),
  Object.freeze({ a: 'stoneskin', b: 'burning', archetypeId: null }),
  Object.freeze({ a: 'mighty', b: 'multishot', archetypeId: 'ashen_archer' }),
]);

/** `03` §9.3: champions take 1 affix, uniques 3 (restated by `06` §6.5),
 * minions inherit "the unique's" — all three, per `06` §5.7. Everything else
 * takes none. */
export const AFFIX_COUNT_BY_RANK = Object.freeze({
  normal: 0, minion: 3, champion: 1, unique: 3, boss: 0,
});

/** `06` §6.5's danger budgets, stated numerically so the budget is an
 * assertion and not an opinion. One affix per group caps a unique at
 * `3 + 2 + 2 = 7`, exactly at budget. */
export const DANGER_BUDGET = Object.freeze({ champion: 3, unique: 7 });

/** `06` §6.4's tier gate on the one number `03` §9.4 leaves as a single
 * value. 85 at Instruction reads as "this one resists fire"; 100 from Trial
 * upward reads as "you need pierce", and by then `fireResistPierce` is on the
 * affix pool. */
export const IMMUNITY_VALUE_BY_TIER = Object.freeze({
  instruction: 85, trial: 100, renunciation: 100,
});

/** `03` §10.2's per-tier monster resist bonus, restated by `06` §11.4's own
 * table. NOT applied by `src/ai/rank.js#affixStats` — no difficulty-tier
 * system exists anywhere in `src/` (finding O-97; `AI-11` is M6, `06` §13
 * step 11), and inventing one from `ai` would double-count the day it lands.
 * Present as data so a reader of §6.4's "85 + 0 / 100 + 20 / 100 + 40" table
 * can find the second term, and so the tests can state the arithmetic
 * explicitly instead of hiding it. */
export const TIER_MONSTER_RESIST_BONUS = Object.freeze({
  instruction: 0, trial: 20, renunciation: 40,
});

/** `06` §5.8's first table — 16 epithets, index-ordered. The Russian
 * dictionary transliterates these rather than translating them, per the
 * `i18n` rule that identifiers are never mirrored, so there is no RU column
 * here. */
export const UNIQUE_EPITHETS = Object.freeze([
  'Ashgrim', 'Bonewrit', 'Cinderlash', 'Dustmourn',
  'Emberquill', 'Foulscript', 'Gravemark', 'Hollowvow',
  'Ironpsalm', 'Lastlesson', 'Mireglyph', 'Nullword',
  'Pyrelogue', 'Rotverse', 'Thornfable', 'Waxcreed',
]);

/** `06` §5.8's second table — 12 titles, index-ordered, both languages.
 * @type {ReadonlyArray<Readonly<{en:string, ru:string}>>} */
export const UNIQUE_TITLES = Object.freeze([
  Object.freeze({ en: 'the Unlettered', ru: 'Неграмотный' }),
  Object.freeze({ en: 'the Third Draft', ru: 'Третий Черновик' }),
  Object.freeze({ en: 'Keeper of Errata', ru: 'Хранитель Опечаток' }),
  Object.freeze({ en: 'the Redacted', ru: 'Вымаранный' }),
  Object.freeze({ en: 'Margin-Walker', ru: 'Идущий по Полям' }),
  Object.freeze({ en: 'the Misquoted', ru: 'Перевранный' }),
  Object.freeze({ en: 'Scribe of Cinders', ru: 'Писец Углей' }),
  Object.freeze({ en: 'the Unfinished', ru: 'Незавершённый' }),
  Object.freeze({ en: 'Warden of Blank Pages', ru: 'Страж Пустых Страниц' }),
  Object.freeze({ en: 'the Illegible', ru: 'Нечитаемый' }),
  Object.freeze({ en: 'the Palimpsest', ru: 'Палимпсест' }),
  Object.freeze({ en: 'the Recanted', ru: 'Отречённый' }),
]);

/** `06` §5.8: "`name = EPITHET[S.int(0,15)] + ', ' + TITLE[S.int(0,11)]` —
 * 192 combinations". Stated as data so a test asserts the spec's own number
 * rather than recomputing `16 × 12` and agreeing with itself. */
export const UNIQUE_NAME_COMBINATIONS = 192;

/** `06` §6.7's rank telegraph table. Rank aura first, affix layer second.
 * `radiusMult` multiplies `Actor.radius`. Consumed by `fx`/`audio`/`ui`,
 * which own the actual light and sound — this is the hook, not the effect.
 * The champion blue and unique gold are sacred (`ARCHITECTURE.md` § Quality
 * bar) and no affix visual below may use either hue. */
export const RANK_TELEGRAPH = Object.freeze({
  champion: Object.freeze({
    rim: 'blue', intensity: 0.55, radiusMult: 1.4, pulseHz: 0.8, namePlate: 0,
    loopSound: 'champion.aura.loop', spawnSound: 'champion.spawn',
  }),
  unique: Object.freeze({
    rim: 'gold', intensity: 0.85, radiusMult: 1.8, pulseHz: 0, namePlate: 1,
    loopSound: 'unique.aura.loop', spawnSound: 'unique.spawn',
  }),
  minion: Object.freeze({
    rim: 'gold', intensity: 0.30, radiusMult: 1.0, pulseHz: 0, namePlate: 0,
    loopSound: null, spawnSound: null,
  }),
});

/** `06` §6.7's per-affix telegraph rows. `alwaysDrawn` is 1 for exactly one
 * affix: "**The frostbound ring is drawn permanently, not on a pulse.** It is
 * the only affix whose effect has a hard geometric edge the player must
 * respect continuously, and a telegraph that blinks is a telegraph that gets
 * crossed." `ringRadius` is `null` where the affix draws no ground ring. */
export const AFFIX_TELEGRAPH = Object.freeze({
  burning: Object.freeze({ visual: 'ember-ribbon-shoulders', uGlow: 1.4, ringRadius: null, alwaysDrawn: 0, sound: 'affix.fire.death' }),
  charged: Object.freeze({ visual: 'limb-arc-sparks', arcHz: 4, preFlashSeconds: 0.35, ringRadius: null, alwaysDrawn: 0, sound: 'affix.lightning.charge' }),
  frostbound: Object.freeze({ visual: 'ground-ring-pale-blue', ringRadius: 7.0, ringBandWidth: 0.15, alwaysDrawn: 1, sound: 'affix.cold.aura.loop' }),
  swift: Object.freeze({ visual: 'motion-trail', trailSamples: 5, uGlow: 0.4, footstepRateMult: 2.0, ringRadius: null, alwaysDrawn: 0, sound: 'affix.swift.loop' }),
  mighty: Object.freeze({ visual: 'limb-scale-red-rim', uScale: 1.12, ringRadius: null, alwaysDrawn: 0, sound: 'affix.mighty.impact' }),
  stoneskin: Object.freeze({ visual: 'crystalline-shell', roughness: 0.25, ringRadius: null, alwaysDrawn: 0, sound: 'affix.stoneskin.deflect' }),
  hexing: Object.freeze({ visual: 'ground-rune-violet', ringRadius: 8.0, alwaysDrawn: 0, drawnDuringCastSeconds: 0.6, sound: 'affix.curse.cast' }),
  vampiric: Object.freeze({ visual: 'red-tether-to-last-leech', fadeSeconds: 0.4, ringRadius: null, alwaysDrawn: 0, sound: 'affix.vampiric.tick' }),
  multishot: Object.freeze({ visual: 'three-pronged-muzzle-flare', ringRadius: null, alwaysDrawn: 0, sound: 'affix.multishot' }),
});
