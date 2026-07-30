// src/combat/data/weapons.js
//
// CMBT-1 — the seven reference weapons of `03-combat-math.md` §4.6, plus a
// small class-scale table `src/combat/packet.js`'s B6/interval formulas need
// from §2.1. `ARCHITECTURE.md` rule 9 ("gameplay numbers live in data, not
// in code") and this ticket's own rule 6 are why these live here rather than
// as literals inside the build pipeline.
//
// ---------------------------------------------------------------------------
// Why WEAPONS lives here
// ---------------------------------------------------------------------------
// `03-combat-math.md` §4.6: "Used by every calibration figure. The full base
// catalogue belongs to the items specification; these seven rows are fixed
// here because §11 depends on them." `items` (M3) does not exist yet, so
// there is no `ItemInstance`/`WeaponBase` table anywhere in the codebase for
// `buildAttackPacket()`'s B1 step to read a real equipped weapon from —
// `Actor.equipment` is `null` until then (`src/actors/pool.js`'s own
// `createActorRecord`). `resolveWeapon()` in `packet.js` reads
// `source.equipment.mainHand` when present (forward-compatible with a future
// `ItemInstance` shaped compatibly: `minDamage`/`maxDamage`/`attackTime`/
// `handling`) and falls back to `WEAPONS.unarmed` otherwise — exactly
// `04-4.1`'s own "the 1-3 damage, 0.60s pseudo-weapon" default for an actor
// with nothing equipped.
//
// Only the columns `packet.js`'s B1/B5 steps and the interval formulas
// actually consume are kept: `handling` (§4.1's attribute-bonus lookup),
// `minDamage`/`maxDamage` (B1), `attackTime` (§4.3's attack-interval base).
// `attackRating`/`reqLevel`/`reqStr`/`reqDex`/grid size are §4.6's own
// columns, kept here as reference documentation for whichever ticket builds
// the real item system, but NOT consumed by combat's B8 rider step —
// `attackRating` there reads the actor's already-composed
// `stats.attackRating` (a `StatBlock` field an equipment layer would fold a
// weapon's own AR bonus into), not this table, so keeping a column here that
// combat itself never reads is deliberate, not dead weight (see
// `packet.js`'s header for the full reasoning).
//
// ---------------------------------------------------------------------------
// Why CLASS_SCALE_TABLE also lives here (a documented, temporary duplicate)
// ---------------------------------------------------------------------------
// `03-combat-math.md` §2.1's class table already has one accepted, landed
// home: `src/actors/stats.js`'s `CLASS_TABLE` — but that constant only
// carries the subset `composeStats()` needs (`baseLife`, `startStr`, ...); it
// does NOT include `attackScale`/`castScale`/`meleeScale`/`spellScale` at
// all (those four columns are not `StatBlock` fields — grep
// `src/actors/stats.js`'s own `FIELD_NAMES`; they aren't there). Combat's B6
// and its `attackInterval`/`castInterval` formulas need exactly those four
// numbers per class, and `ARCHITECTURE.md` rule 2 ("never import another
// subsystem's module... `static deps` declares init order only") means
// `packet.js` may not `import { CLASS_TABLE } from '../actors/stats.js'` to
// get them, and `ActorsSystem` does not expose a getter for the raw class
// table today (only `stats(actor) => StatBlock`, itself not wired into
// `src/actors/index.js` yet — see this ticket's report).
//
// `src/actors/stats.js`'s own file header documents this exact situation for
// its OWN copy of the class table — "the same resolution: the table lives
// here, isolated in one clearly-labelled constant... moves to
// `src/player/data/classes.js` the moment that ticket exists" — and that is
// the precedent this file follows for the four scale columns `combat` needs.
// This is a deliberate, temporary duplication of four numbers per class
// (twelve numbers total), not a drift risk in practice: `03-combat-math.md`
// §2.1 is the single source both copies transcribe from, and whichever
// ticket builds `src/player/data/classes.js` should delete both stand-ins
// and point every reader at it instead. Flagged in this ticket's report.
export const CLASS_SCALE_TABLE = Object.freeze({
  ravager: Object.freeze({ attackScale: 0.90, castScale: 1.15, meleeScale: 1.00, spellScale: 0.85 }),
  emberwright: Object.freeze({ attackScale: 1.15, castScale: 0.85, meleeScale: 0.75, spellScale: 1.00 }),
  runeblade: Object.freeze({ attackScale: 1.00, castScale: 1.00, meleeScale: 0.95, spellScale: 0.95 }),
});

/** Neutral (no-op, ×1) fallback for a monster/no-class actor
 * (`actor.classId === null`, per `src/actors/pool.js#acquire`). §2.1's class
 * table only covers the three player classes — monsters "come straight from
 * the bestiary row" (`src/actors/stats.js`'s own note, citing
 * `03-combat-math.md`), and no bestiary exists yet (`ai`, out of scope). `1`
 * rather than `0` is the deliberate choice: a monster's own melee/cast scale
 * defaulting to `0` would silently zero every monster's damage and attack
 * speed, which is a much worse placeholder than "unscaled" until the real
 * bestiary data lands — the same "neutral until real data exists" call
 * `src/actors/motion.js#computeMoveSpeed` already makes for its own
 * placeholder inputs. */
export const NEUTRAL_CLASS_SCALE = Object.freeze({ attackScale: 1, castScale: 1, meleeScale: 1, spellScale: 1 });

/** `03-combat-math.md` §4.6, verbatim — the seven reference weapons every
 * calibration figure in §11/§12 uses. Grid size is intentionally omitted —
 * inventory placement is `items`' concern, not combat's. */
export const WEAPONS = Object.freeze({
  unarmed: Object.freeze({
    id: 'unarmed', name: '—', handling: 'unarmed',
    minDamage: 1, maxDamage: 3, attackTime: 0.60,
    attackRating: 0, reqLevel: 1, reqStr: 0, reqDex: 0,
  }),
  axe_hand_normal: Object.freeze({
    id: 'axe_hand_normal', name: 'Hand Axe', handling: 'oneHandMelee',
    minDamage: 4, maxDamage: 9, attackTime: 0.80,
    attackRating: 40, reqLevel: 1, reqStr: 18, reqDex: 0,
  }),
  axe_battle_normal: Object.freeze({
    id: 'axe_battle_normal', name: 'Battle Axe', handling: 'oneHandMelee',
    minDamage: 10, maxDamage: 22, attackTime: 0.75,
    attackRating: 80, reqLevel: 9, reqStr: 40, reqDex: 0,
  }),
  sword_rune_normal: Object.freeze({
    id: 'sword_rune_normal', name: 'Rune Sword', handling: 'oneHandMelee',
    minDamage: 8, maxDamage: 17, attackTime: 0.65,
    attackRating: 80, reqLevel: 8, reqStr: 30, reqDex: 25,
  }),
  maul_great_normal: Object.freeze({
    id: 'maul_great_normal', name: 'Great Maul', handling: 'twoHandMelee',
    minDamage: 22, maxDamage: 46, attackTime: 1.25,
    attackRating: 60, reqLevel: 12, reqStr: 62, reqDex: 0,
  }),
  wand_ember_normal: Object.freeze({
    id: 'wand_ember_normal', name: 'Ember Wand', handling: 'wand',
    minDamage: 3, maxDamage: 7, attackTime: 0.60,
    attackRating: 10, reqLevel: 1, reqStr: 12, reqDex: 0,
  }),
  staff_ash_normal: Object.freeze({
    id: 'staff_ash_normal', name: 'Ash Staff', handling: 'staff',
    minDamage: 6, maxDamage: 14, attackTime: 0.95,
    attackRating: 20, reqLevel: 10, reqStr: 20, reqDex: 0,
  }),
});
