// src/actors/data/statuses.js
//
// ACTR-10 — the ten-status gameplay table (`01-data-model.md` §7.2), kept as
// data per `ARCHITECTURE.md` rule 9 ("gameplay numbers live in data, not in
// code") — the same split `src/actors/data/states.js` (ACTR-9) already
// established for the action state machine's adjacency table. Pure data:
// no imports, so `tools/check-imports.mjs`'s auto-discovered `data/` root
// trivially passes (nothing to walk).
//
// `STATUS` / `STATUS_ORDER` / `STATUS_BIT` are transcribed VERBATIM from
// `01-data-model.md` §7.2 — bit positions and the DoT-resolution order are
// load-bearing (ACTR-8's `vessels.js` already hard-codes `1<<1` for
// `poisoned` because this file did not exist yet; the value here must keep
// agreeing with it — verified below, see `POISONED_BIT_MATCHES_VESSELS`).
//
// `STACK_RULE` and `STATUS_TABLE` are this file's own addition — `01 §7.2`'s
// table has a free-text "Stacking rule" column ("max-wins, refresh
// duration", "independent stacks", "replace if greater total", "additive
// stacks, refresh all") that `status.js` needs as a machine-readable
// dispatch key, not prose. The four values below are exactly `01 §7.3`'s
// four named rules:
//   - `refresh`     — one instance; duration takes max(existing, new); the
//                     table's per-status `magnitudeRule` decides whether
//                     magnitude also takes max() or is left alone (unused).
//   - `independent` — up to `maxStacks` separate instances, each with its
//                     own timer; at the cap the lowest-`totalRemaining`
//                     instance is replaced.
//   - `replaceIfGreater` — one instance; a new application only replaces it
//                     if `newMagnitude * newDuration > existing.totalRemaining`,
//                     otherwise it is discarded entirely (the poison rule).
//   - `additiveStacks` — one instance; `stacks` increments to the cap, and
//                     the newest application overwrites `expiresStep`
//                     (`01 §7.3`: "every stack shares one expiresStep which
//                     the newest application refreshes" — literally the
//                     newest value, not `max()`; this is the one place the
//                     "refresh" family's max-wins duration rule does NOT
//                     apply, and it is easy to conflate the two — see
//                     `status.js#applyAdditiveStacks`).
//
// `tickIntervalSteps` is `01 §7.4`: DoTs tick every 15 fixed steps (4 Hz),
// `bleeding` every 30 (2 Hz); 0 for a non-ticking status. `maxStacks` and
// `statMods` are `01 §7.2`'s own columns, restated as data. `magnitudeRule`
// (`'maxWins' | 'unused'`) exists only to disambiguate the `refresh` family:
// chilled/slowed/blinded/cursed take max-wins on magnitude; frozen/stunned
// have magnitude documented as "unused (0)" and never touch it on a refresh.
//
// `statMods` lists the StatBlock keys this status contributes to (`stats.js`
// field names, verified against that file directly — `movementSpeed`,
// `increasedAttackSpeed`, `fasterCastRate`, `attackRatingPercent`,
// `defensePercent`, `lifeRegen`, and the six `*Resist` keys). NOTE: as of
// this ticket, `stats.js#composeStats` does not fold `actor.statuses[].statMods`
// into the composed StatBlock at all (verified: no `statuses`/`statMods`
// reference anywhere in `stats.js`) — the one status that already has a
// real effect wired up is `poisoned`, and that path (`vessels.js`'s
// `POISONED_STATUS_BIT` gate on life regen) reads `actor.statusMask`
// directly, NOT `instance.statMods`. So every `statMods` object this file's
// sibling builds is real, correctly-shaped data that nothing yet consumes —
// a genuine gap, flagged in this ticket's report, for whoever wires a
// "status layer" into `composeStats` (most likely `stats.js`'s own owner or
// CMBT-4, not this ticket, which does not touch `stats.js`).

export const STATUS = Object.freeze({
  chilled: 'chilled', frozen: 'frozen', burning: 'burning', poisoned: 'poisoned',
  shocked: 'shocked', stunned: 'stunned', slowed: 'slowed', bleeding: 'bleeding',
  blinded: 'blinded', cursed: 'cursed',
});

/** Fixed iteration order — DoT resolution order must be reproducible
 * (`01-data-model.md` §7.2, verbatim). NOT alphabetical, NOT `STATUS_BIT`'s
 * declaration order — preserved exactly as transcribed in this ticket. */
export const STATUS_ORDER = Object.freeze([
  'burning', 'poisoned', 'bleeding', 'shocked', 'chilled', 'frozen',
  'slowed', 'stunned', 'blinded', 'cursed',
]);

export const STATUS_BIT = Object.freeze({
  burning: 1 << 0, poisoned: 1 << 1, bleeding: 1 << 2, shocked: 1 << 3, chilled: 1 << 4,
  frozen: 1 << 5, slowed: 1 << 6, stunned: 1 << 7, blinded: 1 << 8, cursed: 1 << 9,
});

/** ACTR-8's `vessels.js#POISONED_STATUS_BIT` hard-codes `1 << 1` because this
 * file did not exist when that ticket landed. This constant proves the two
 * never drift silently — `status.test.js` asserts it is `true`. */
export const POISONED_BIT_MATCHES_VESSELS = STATUS_BIT.poisoned === (1 << 1);

export const STACK_RULE = Object.freeze({
  refresh: 'refresh',
  independent: 'independent',
  replaceIfGreater: 'replaceIfGreater',
  additiveStacks: 'additiveStacks',
});

/**
 * `01-data-model.md` §7.2's table, one row per status. `tickIntervalSteps`
 * is 0 for a non-ticking status. `magnitudeRule` only matters for
 * `STACK_RULE.refresh` rows (see the file header); left `'unused'` for every
 * other stack rule since those rows compute magnitude their own way
 * (`status.js` reads `stackRule` first, so a `refresh`-only field never gets
 * consulted on a non-`refresh` row).
 */
export const STATUS_TABLE = Object.freeze({
  chilled: Object.freeze({
    stackRule: STACK_RULE.refresh,
    magnitudeRule: 'maxWins',
    maxStacks: 1,
    tickIntervalSteps: 0,
    statMods: Object.freeze(['movementSpeed', 'increasedAttackSpeed', 'fasterCastRate']),
  }),
  frozen: Object.freeze({
    stackRule: STACK_RULE.refresh,
    magnitudeRule: 'unused',
    maxStacks: 1,
    tickIntervalSteps: 0,
    statMods: Object.freeze([]),
  }),
  burning: Object.freeze({
    stackRule: STACK_RULE.independent,
    magnitudeRule: 'unused',
    maxStacks: 3,
    tickIntervalSteps: 15,
    statMods: Object.freeze([]),
  }),
  poisoned: Object.freeze({
    stackRule: STACK_RULE.replaceIfGreater,
    magnitudeRule: 'unused',
    maxStacks: 1,
    tickIntervalSteps: 15,
    statMods: Object.freeze(['lifeRegen']),
  }),
  shocked: Object.freeze({
    stackRule: STACK_RULE.additiveStacks,
    magnitudeRule: 'unused',
    maxStacks: 3,
    tickIntervalSteps: 0,
    statMods: Object.freeze([]),
  }),
  stunned: Object.freeze({
    stackRule: STACK_RULE.refresh,
    magnitudeRule: 'unused',
    maxStacks: 1,
    tickIntervalSteps: 0,
    statMods: Object.freeze([]),
  }),
  slowed: Object.freeze({
    stackRule: STACK_RULE.refresh,
    magnitudeRule: 'maxWins',
    maxStacks: 1,
    tickIntervalSteps: 0,
    statMods: Object.freeze(['movementSpeed']),
  }),
  bleeding: Object.freeze({
    stackRule: STACK_RULE.independent,
    magnitudeRule: 'unused',
    maxStacks: 5,
    tickIntervalSteps: 30,
    statMods: Object.freeze([]),
  }),
  blinded: Object.freeze({
    stackRule: STACK_RULE.refresh,
    magnitudeRule: 'maxWins',
    maxStacks: 1,
    tickIntervalSteps: 0,
    statMods: Object.freeze(['attackRatingPercent']),
  }),
  cursed: Object.freeze({
    stackRule: STACK_RULE.refresh,
    magnitudeRule: 'maxWins',
    maxStacks: 1,
    tickIntervalSteps: 0,
    statMods: Object.freeze([
      'defensePercent', 'fireResist', 'coldResist', 'lightResist', 'poisonResist', 'magicResist', 'physicalResist',
    ]),
  }),
});
