// src/player/data/progression.js
//
// PLYR-4 / D-38 — `XP_TOTAL`/`XP_TABLE`, transcribed VERBATIM from
// `docs/spec/03-combat-math.md` §10.4 (L1058-1097): the closed form and the
// printed 1..30 cumulative-XP table, checked row by row against each other
// by `tests/player/progress.test.js` (a transcription error shows up at the
// row it happens, not as a vague "the curve is wrong somewhere").
//
// ---------------------------------------------------------------------------
// D-38's scope, verbatim — this file is exactly this and nothing else
// ---------------------------------------------------------------------------
// `13-progression-lore.md:1793`'s own row for ticket L1/PLYR-6 (M6, not this
// milestone) names four things for this same path: `XP_TABLE`,
// `OPENING_RAMP`, `CLASS_START_KIT`, `QUEST_XP`. The owner's ruling (D-38,
// this ticket's brief) is explicit: PLYR-4 creates ONLY `XP_TOTAL`/
// `XP_TABLE` here, transcribed from `03` §10.4 — `OPENING_RAMP`,
// `CLASS_START_KIT` and `QUEST_XP` stay with L1/PLYR-6. Nothing below this
// point reaches past that boundary.
//
// ---------------------------------------------------------------------------
// Why transcribed, not re-derived — the recorded incident this ticket must
// not repeat
// ---------------------------------------------------------------------------
// `src/save/schema.js`'s own header (its `checkInvariant2` note) records
// that a FABRICATED level->XP curve was tried here once already, caught,
// and removed — "a validator asserting a made-up curve is worse than not
// checking at all". `XP_TABLE` below is copied by hand from the table
// printed in `03-combat-math.md` §10.4, cell by cell, in the same order —
// not computed by looping `XP_TOTAL` over 1..30 and trusting the closed
// form alone (a bug in the closed form would then never be caught, since
// the "check" would just be the bug checking itself). The test file for
// this ticket runs both — `XP_TOTAL(n)` AND the hand-copied `XP_TABLE[n]`
// — against the literal printed table, independently, so either one going
// wrong is visible.
//
// Pure data + one pure function. No import, no `three`, no `document`/
// `window`, no `performance.now()`, no `Math.random()` — this file loads
// under plain Node and is one more root `tools/check-imports.mjs`'s
// auto-discovered `data/` sweep (12-testing.md §2.1) passes trivially,
// there being nothing to walk.

/** `03-combat-math.md` §10.4, verbatim:
 * `XP_TOTAL(n) = round( 50 × (n − 1)^2.6 )` — cumulative XP required to BE
 * level `n`. Valid for `n` in `1..30` (the level cap, `13-progression-lore.md`
 * §1.7); nothing above 30 is specified and this function is not clamped —
 * callers own the `n <= 30` boundary (see `../progress.js`'s `LEVEL_CAP`).
 * @param {number} n
 * @returns {number} int
 */
export function XP_TOTAL(n) {
  return Math.round(50 * Math.pow(n - 1, 2.6));
}

/**
 * The printed 1..30 table, `03-combat-math.md` §10.4's "Cumulative" column,
 * transcribed by hand — index `n` (1..30) holds `XP_TOTAL(n)`; index `0` is
 * an unused placeholder (there is no level 0) so every real caller can index
 * directly by level, `XP_TABLE[level]`, with no off-by-one translation —
 * the exact shape `src/save/schema.js`'s own deferred invariant-2 comment
 * describes wanting ("experience >= XP_TABLE[level] and < XP_TABLE[level+1]").
 * Frozen: this is gameplay data, never mutated at runtime.
 */
export const XP_TABLE = Object.freeze([
  0, // index 0 — unused, no level 0
  0, // level 1
  50, // level 2
  303, // level 3
  870, // level 4
  1838, // level 5
  3283, // level 6
  5274, // level 7
  7875, // level 8
  11143, // level 9
  15136, // level 10
  19905, // level 11
  25503, // level 12
  31977, // level 13
  39375, // level 14
  47742, // level 15
  57123, // level 16
  67559, // level 17
  79093, // level 18
  91765, // level 19
  105616, // level 20
  120684, // level 21
  137006, // level 22
  154621, // level 23
  173565, // level 24
  193874, // level 25
  215583, // level 26
  238727, // level 27
  263339, // level 28
  289455, // level 29
  317106, // level 30
]);
