// src/items/quality.js
//
// ITEM-4 — the quality roll, `docs/spec/04-items.md` §4.1 implemented
// verbatim. `rollQuality` is D5 of the fifteen-draw order (§9.2): "the
// quality ladder of §4.1", one draw, whenever the picked treasure-class
// entry is an `item`. It is a plain exported function, not a method on
// `ItemsSystem` — `02-api-contracts.md` never lists `rollQuality` on the
// `items` public surface (only `rollDrop`/`rollItem`, both later tickets),
// so adding it as an instance method would be exactly the "public surface
// invented before its ticket" mistake `src/items/index.js`'s own header
// warns against. `src/items/roll.js` (ITEM-5/6) imports this function
// directly, a sibling-to-sibling import inside `items` — the one-way rule
// ARCHITECTURE.md rule 2 forbids is *between* subsystems, not within one.
//
// ---------------------------------------------------------------------------
// D-6 — one draw, not four (04 §14.1)
// ---------------------------------------------------------------------------
// The obvious reading of a "roll unique, then rare, then magic, then
// superior" ladder is four independent Bernoulli checks. §4.1 fixes this as
// ONE draw against a cumulative, truncating ladder instead — same
// distribution, a quarter of the RNG traffic in the hottest loop of the
// loot pipeline, and simpler draw-count accounting for `tools/lootsim.mjs`'s
// **D2** assertion. `rollQuality` below draws exactly once (`rng.next()`)
// regardless of which rarity it returns — proven in
// `tests/items/quality.test.js` with `./rng.js`'s `CountingRng`, not merely
// asserted by reading this file.
//
// ---------------------------------------------------------------------------
// D-7 — Magic Find does not touch `superior` (04 §14.1)
// ---------------------------------------------------------------------------
// `effMF('superior', mf)` is always 0 — see `EFF_MF` below. `superior` is a
// base-quality roll, not a magic one; letting MF push it would eat the
// `normal` share and make the low end of the loot stream feel identical at
// every MF value (§4.3's own reasoning, restated here because it is easy to
// "fix" by accident if this file is touched without re-reading the spec).
//
// ---------------------------------------------------------------------------
// Zero allocation on the roll path (O-59)
// ---------------------------------------------------------------------------
// `rollQuality` is called on every single drop (ARCHITECTURE.md rule 6,
// this ticket's own brief citing O-59's `buildAttackPacket` regression). The
// function below touches only numbers and returns one of five string
// *literals* — no template string, no object/array literal, no closure
// allocated per call. The lookup tables are built once, at module load, and
// only ever read.

/**
 * `04-items.md` §4.2 "Base probabilities" — a normal-rank monster,
 * Instruction, Magic Find 0. Order matters: it is the ladder order
 * (`rollQuality` walks the same four keys, in this order, when building the
 * cumulative total) and NOT alphabetical, matching §4.1's pseudocode
 * (`for r in ['unique', 'rare', 'magic', 'superior']`).
 */
export const QUALITY_ORDER = Object.freeze(['unique', 'rare', 'magic', 'superior']);

/** `04-items.md` §4.2 "Base probabilities" table. */
export const QUALITY_BASE = Object.freeze({
  unique: 0.0025,
  rare: 0.0180,
  magic: 0.1600,
  superior: 0.2000,
});

/**
 * `04-items.md` §4.2 "Rank multipliers". Keyed by every rank string that
 * table names: the five `ACTOR_RANK` values (`01-data-model.md` §1.3:
 * `normal`/`minion`/`champion`/`unique`/`boss` — note `unique` here is a
 * MONSTER rank, unrelated to the `unique` RARITY key above) plus the five
 * destructible-container kinds the same table row-groups ("chest /
 * sarcophagus", "urn / barrel / crate"); both members of each pair share one
 * row's numbers verbatim, so both keys are listed rather than aliased, to
 * keep every lookup a plain property read (no fallback chain on the hot
 * path).
 */
export const QUALITY_RANK = Object.freeze({
  normal: Object.freeze({ unique: 1.00, rare: 1.00, magic: 1.00, superior: 1.00 }),
  minion: Object.freeze({ unique: 1.30, rare: 1.25, magic: 1.15, superior: 1.00 }),
  champion: Object.freeze({ unique: 2.50, rare: 2.20, magic: 1.60, superior: 1.15 }),
  unique: Object.freeze({ unique: 4.60, rare: 3.60, magic: 2.25, superior: 1.25 }),
  boss: Object.freeze({ unique: 9.20, rare: 6.40, magic: 2.60, superior: 1.00 }),
  chest: Object.freeze({ unique: 1.60, rare: 1.55, magic: 1.35, superior: 1.10 }),
  sarcophagus: Object.freeze({ unique: 1.60, rare: 1.55, magic: 1.35, superior: 1.10 }),
  urn: Object.freeze({ unique: 1.00, rare: 1.00, magic: 1.00, superior: 1.00 }),
  barrel: Object.freeze({ unique: 1.00, rare: 1.00, magic: 1.00, superior: 1.00 }),
  crate: Object.freeze({ unique: 1.00, rare: 1.00, magic: 1.00, superior: 1.00 }),
});

/** `04-items.md` §4.2 "Δ coefficients". */
export const QUALITY_DELTA_COEFF = Object.freeze({
  unique: 0.10,
  rare: 0.08,
  magic: 0.05,
  superior: 0.02,
});

/**
 * `04-items.md` §4.2 "Difficulty multipliers". Keys match
 * `01-data-model.md`'s `DIFFICULTY_ORDER` / `src/combat/xp.js`'s
 * `DIFFICULTY_XP_MULT` convention (`instruction`/`trial`/`renunciation`).
 */
export const QUALITY_TIER = Object.freeze({
  instruction: Object.freeze({ unique: 1.00, rare: 1.00, magic: 1.00, superior: 1.00 }),
  trial: Object.freeze({ unique: 1.35, rare: 1.30, magic: 1.15, superior: 1.00 }),
  renunciation: Object.freeze({ unique: 1.80, rare: 1.65, magic: 1.30, superior: 1.00 }),
});

/** `04-items.md` §4.2 "Caps", applied per rarity before the ladder is built. */
export const QUALITY_CAP = Object.freeze({
  unique: 0.25,
  rare: 0.50,
  magic: 0.95,
  superior: 0.60,
});

/** `04-items.md` §4.3's two hyperbola denominators (`effMF`'s `unique`/`rare` cases). */
const MF_HALF_UNIQUE = 250;
const MF_HALF_RARE = 550;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * `04-items.md` §4.3 — Magic Find's diminishing-returns curve, per rarity.
 * `unique`/`rare` follow the D2 hyperbola; `magic` is linear (no
 * diminishing returns); `superior` is flat zero (D-7, see file header).
 *
 * @param {'unique'|'rare'|'magic'|'superior'} rarity
 * @param {number} magicFind
 * @returns {number} the effective MF value to feed into `(1 + eff/100)`.
 */
export function effMF(rarity, magicFind) {
  if (rarity === 'unique') return (magicFind * MF_HALF_UNIQUE) / (magicFind + MF_HALF_UNIQUE);
  if (rarity === 'rare') return (magicFind * MF_HALF_RARE) / (magicFind + MF_HALF_RARE);
  if (rarity === 'magic') return magicFind;
  return 0; // 'superior'
}

/**
 * `04-items.md` §4.1, implemented verbatim. Exactly one RNG draw
 * (`rng.next()`), compared against a cumulative, truncating ladder built
 * top-down in `QUALITY_ORDER`'s order.
 *
 * @param {number} ilvl - the item's level.
 * @param {number} mlvl - the killing/dropping monster's level.
 * @param {string} rank - a key of `QUALITY_RANK` (monster `ACTOR_RANK` or a
 *   destructible-container kind — see that table's own header).
 * @param {'instruction'|'trial'|'renunciation'} difficulty
 * @param {number} magicFind - the `magicFind` stat, catalogue-capped at
 *   172 % (PROGRESS D-20); this function does not itself enforce that cap,
 *   it is a property of what gear can legally roll, not of the formula.
 * @param {import('../core/rng.js').Rng} rng - the `items` fork (or a
 *   `CountingRng`/any object exposing a one-draw `next()`), never
 *   `ctx.rng` directly (ARCHITECTURE.md's determinism contract: two
 *   subsystems must never share a stream).
 * @returns {'unique'|'rare'|'magic'|'superior'|'normal'}
 */
export function rollQuality(ilvl, mlvl, rank, difficulty, magicFind, rng) {
  const rankMul = QUALITY_RANK[rank];
  if (!rankMul) {
    throw new RangeError(`rollQuality: unknown rank '${rank}'`);
  }
  const tierMul = QUALITY_TIER[difficulty];
  if (!tierMul) {
    throw new RangeError(`rollQuality: unknown difficulty '${difficulty}'`);
  }

  const delta = clamp(ilvl - mlvl, 0, 8);

  const pUnique = clamp(
    QUALITY_BASE.unique *
      rankMul.unique *
      (1 + QUALITY_DELTA_COEFF.unique * delta) *
      tierMul.unique *
      (1 + effMF('unique', magicFind) / 100),
    0,
    QUALITY_CAP.unique,
  );
  const pRare = clamp(
    QUALITY_BASE.rare *
      rankMul.rare *
      (1 + QUALITY_DELTA_COEFF.rare * delta) *
      tierMul.rare *
      (1 + effMF('rare', magicFind) / 100),
    0,
    QUALITY_CAP.rare,
  );
  const pMagic = clamp(
    QUALITY_BASE.magic *
      rankMul.magic *
      (1 + QUALITY_DELTA_COEFF.magic * delta) *
      tierMul.magic *
      (1 + effMF('magic', magicFind) / 100),
    0,
    QUALITY_CAP.magic,
  );
  const pSuperior = clamp(
    QUALITY_BASE.superior *
      rankMul.superior *
      (1 + QUALITY_DELTA_COEFF.superior * delta) *
      tierMul.superior *
      (1 + effMF('superior', magicFind) / 100),
    0,
    QUALITY_CAP.superior,
  );

  const u = rng.next(); // the single draw, from the items stream

  let t = pUnique;
  if (u < t) return 'unique';
  t += pRare;
  if (u < t) return 'rare';
  t += pMagic;
  if (u < t) return 'magic';
  t += pSuperior;
  if (u < t) return 'superior';
  return 'normal';
}
