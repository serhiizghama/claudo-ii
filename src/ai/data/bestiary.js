// src/ai/data/bestiary.js
//
// AI-1 — `06-monsters-ai.md` §13 step 1's first deliverable: "the seven
// `MonsterArchetype` records of §1 and §2, plus the `mlvl` scaling
// functions. Plain objects, imports nothing." `ARCHITECTURE.md` rule 9
// ("gameplay numbers live in data, not in code") is why this exists as a
// standalone table rather than literals scattered through whatever ticket
// spawns a monster.
//
// File name: the backlog says `src/ai/data/monsters.js` once; `06 §13 step
// 1`, `06 §12.2` and `01-data-model.md` all say `src/ai/data/bestiary.js`.
// Per D-7 (spec wins a filename disagreement — same rule already applied to
// `geo.js` and `clips.js`), this is `bestiary.js`.
//
// ---------------------------------------------------------------------------
// Scope of this table — deliberately narrow
// ---------------------------------------------------------------------------
// This ticket's reading was restricted to `06-monsters-ai.md` §2 (the seven
// per-monster datasheets), `06-monsters-ai.md` §13 step 1, and
// `03-combat-math.md` §9.1/§10.1. `06` §2 (six of the seven archetypes) and
// `01-data-model.md`'s illustrative `MonsterArchetype` sample also document
// per-archetype `treasureClass`, `element`, `flags`, `desiredRange`,
// `aggroRadius`, `leashRadius`, corpse rules, `radius`/`height`/`surface` and
// full attack tables. NONE of that is included below, on purpose:
//
//   - `molgrim`'s own datasheet lives entirely in `06` §7 ("Molgrim, the
//     First Instructor"), which is step 10's deliverable (§13), not this
//     ticket's — reading it now would be reading ahead of scope for data
//     this ticket has no acceptance criterion needing. `molgrim`'s ONLY
//     grounded numbers here are its `mlvl 1` base row and resistances from
//     `03-combat-math.md` §9.1 (reproduced in this ticket's brief verbatim).
//   - Because `molgrim` cannot carry `treasureClass`/`aggroRadius`/etc.
//     without reading out-of-scope `06` §7, every archetype record below is
//     kept to the SAME field set — the ten base fields §9.1 defines plus the
//     six resistances — so the table is uniform rather than six rich records
//     and one thin one. Attack tables, aggro/leash, corpse behaviour,
//     `treasureClass` and physical radius/height belong to whichever ticket
//     actually consumes them (the brain, perception/aggro, and crowd/physics
//     tickets of `06` §13 steps 2-6) and should be sourced from `06` §1-§2
//     directly at that point, not guessed at here.
//
// Field names follow `01-data-model.md`'s own `MonsterArchetype` sample
// (`baseLife`, `baseMinDamage`, `baseMaxDamage`, `baseDefense`,
// `baseAttackRating`, `baseXp`, `attackTime`, `runSpeed`, `mass`, `resists`)
// so a later ticket that adds the remaining fields is extending this shape,
// not renaming it.
//
// ---------------------------------------------------------------------------
// Cross-check: `06-monsters-ai.md` §2 vs `03-combat-math.md` §9.1
// ---------------------------------------------------------------------------
// Both documents give the same `mlvl 1` numbers for all six non-boss
// archetypes (life, damage range, DEF, AR, XP, flat DR 0, move speed, and all
// six resistances) — checked field by field while writing this file. No
// discrepancy found. `molgrim` was not cross-checked (its `06` §7 datasheet
// is out of this ticket's reading scope, per above) — its row here is sourced
// from `03-combat-math.md` §9.1 alone.
//
// `attackTime` for `blight_crawler` is `null`, not a number: `06` §2.6 is
// explicit that "the Crawler has no ordinary attack" — its only action is a
// one-shot `detonate` with no repeating attack cadence, which is exactly why
// the ticket's own transcription of §9.1 shows "—" in that column rather than
// a duration.
//
// ---------------------------------------------------------------------------
// mlvl scaling — `03-combat-math.md` §10.1, verbatim
// ---------------------------------------------------------------------------
// `03 §10.1`'s own rounding rule: "A monster's life, damage, defence, attack
// rating and XP are computed in float — `bestiaryValue × mlvlMult ×
// rankMult × difficultyMult` — and rounded ONCE, at spawn, with Math.round.
// Never round an intermediate." Rank and difficulty multiplier tables are
// not part of this ticket (they live elsewhere — champion/unique promotion
// and the difficulty tiers are different sections this ticket did not read),
// so only the six pure `mlvl` functions are exposed below. Deliberately NO
// convenience helper that multiplies `bestiaryValue × mlvlMult(n)` and
// rounds: that would round an intermediate the moment a caller also needs to
// apply `rankMult`/`difficultyMult`, which is exactly what the rule above
// forbids. Whoever builds the real spawn-time scaling (composes all three
// multipliers before its single `Math.round`) is the caller of these
// functions, not this file.

/** `03-combat-math.md` §10.1. `n` is `mlvl`, 1-indexed. */
export function lifeMult(n) {
  return 1 + 0.2600 * (n - 1) + 0.01300 * (n - 1) ** 2;
}

/** `03-combat-math.md` §10.1. */
export function damageMult(n) {
  return 1 + 0.2200 * (n - 1) + 0.00750 * (n - 1) ** 2;
}

/** `03-combat-math.md` §10.1. */
export function defenseMult(n) {
  return 1 + 0.3000 * (n - 1);
}

/** `03-combat-math.md` §10.1. */
export function arMult(n) {
  return 1 + 0.3800 * (n - 1);
}

/** `03-combat-math.md` §10.1. */
export function xpMult(n) {
  return 1 + 0.3200 * (n - 1) + 0.01600 * (n - 1) ** 2;
}

/** `03-combat-math.md` §10.1: `flatDR(n) = ⌊n / 8⌋`. */
export function flatDR(n) {
  return Math.floor(n / 8);
}

// ---------------------------------------------------------------------------
// The seven MonsterArchetype base rows — `mlvl 1`, `normal` rank, Instruction
// difficulty. `06-monsters-ai.md` §2.0: "every row is `bestiaryValue ×
// mlvlMult(n)`... the table below is the `normal` / Instruction column and
// every other combination is derived, never stored."
// ---------------------------------------------------------------------------

export const BESTIARY = Object.freeze({
  bone_ranker: Object.freeze({
    id: 'bone_ranker',
    displayName: 'Bone Ranker',
    role: 'melee',
    baseLife: 20,
    baseMinDamage: 3,
    baseMaxDamage: 6,
    baseDefense: 18,
    baseAttackRating: 45,
    baseXp: 7,
    attackTime: 1.40,
    runSpeed: 3.2,
    mass: 78,
    resists: Object.freeze({ fire: 0, cold: 25, lightning: 0, poison: 50, magic: 0, physical: 0 }),
  }),

  carrion_swarm: Object.freeze({
    id: 'carrion_swarm',
    displayName: 'Carrion Swarm',
    role: 'swarm',
    baseLife: 9,
    baseMinDamage: 2,
    baseMaxDamage: 3,
    baseDefense: 12,
    baseAttackRating: 38,
    baseXp: 3,
    attackTime: 0.75,
    runSpeed: 5.4,
    mass: 22,
    resists: Object.freeze({ fire: 0, cold: 0, lightning: 0, poison: 25, magic: 0, physical: 0 }),
  }),

  ashen_archer: Object.freeze({
    id: 'ashen_archer',
    displayName: 'Ashen Archer',
    role: 'ranged',
    baseLife: 15,
    baseMinDamage: 3,
    baseMaxDamage: 7,
    baseDefense: 14,
    baseAttackRating: 52,
    baseXp: 8,
    attackTime: 1.70,
    runSpeed: 3.6,
    mass: 68,
    resists: Object.freeze({ fire: 25, cold: 0, lightning: 0, poison: 0, magic: 0, physical: 0 }),
  }),

  dust_shaman: Object.freeze({
    id: 'dust_shaman',
    displayName: 'Dust Shaman',
    role: 'support',
    baseLife: 17,
    baseMinDamage: 2,
    baseMaxDamage: 5,
    baseDefense: 15,
    baseAttackRating: 40,
    baseXp: 12,
    attackTime: 1.60,
    runSpeed: 3.4,
    mass: 70,
    resists: Object.freeze({ fire: 25, cold: 25, lightning: 25, poison: 25, magic: 0, physical: 0 }),
  }),

  maulsmith: Object.freeze({
    id: 'maulsmith',
    displayName: 'Maulsmith',
    role: 'heavy',
    baseLife: 42,
    baseMinDamage: 9,
    baseMaxDamage: 18,
    baseDefense: 26,
    baseAttackRating: 55,
    baseXp: 16,
    attackTime: 2.20,
    runSpeed: 2.4,
    mass: 140,
    resists: Object.freeze({ fire: 0, cold: 0, lightning: -25, poison: 25, magic: 0, physical: 15 }),
  }),

  // `baseMinDamage`/`baseMaxDamage` are the Crawler's detonation poison
  // total, not a melee swing — `06` §2.6: "the Crawler has no ordinary
  // attack." `attackTime` is `null`, not a duration — see this file's header.
  blight_crawler: Object.freeze({
    id: 'blight_crawler',
    displayName: 'Blight Crawler',
    role: 'suicide',
    baseLife: 12,
    baseMinDamage: 8,
    baseMaxDamage: 14,
    baseDefense: 10,
    baseAttackRating: 30,
    baseXp: 6,
    attackTime: null,
    runSpeed: 4.6,
    mass: 40,
    resists: Object.freeze({ fire: 0, cold: -25, lightning: 0, poison: 75, magic: 0, physical: 0 }),
  }),

  // Base row only — sourced from `03-combat-math.md` §9.1 alone. Molgrim's
  // full datasheet (`06` §7) is step 10's deliverable, not this ticket's;
  // see this file's header for why no other field is populated here.
  molgrim: Object.freeze({
    id: 'molgrim',
    displayName: 'Molgrim, the First Instructor',
    role: 'boss',
    baseLife: 430,
    baseMinDamage: 16,
    baseMaxDamage: 30,
    baseDefense: 25,
    baseAttackRating: 90,
    baseXp: 900,
    attackTime: 1.80,
    runSpeed: 3.0,
    mass: 400,
    resists: Object.freeze({ fire: 50, cold: 50, lightning: 50, poison: 85, magic: 40, physical: 10 }),
  }),
});
