// src/combat/packet.js
//
// CMBT-1 — the attacker-side damage packet build pipeline: `03-combat-
// math.md` §6.1's B1-B8 table, plus `attackInterval`/`castInterval` (§4.3/
// §4.4). This is the first file in `src/combat/` — `CombatSystem` (the
// subsystem shell `src/main.js` registers) lives here too; a later ticket
// that adds `resolve()`/`chanceToHit()`/etc. (CMBT-2 onward) may split those
// into sibling files and grow this class from wherever it lands, but this
// ticket's file list is exactly `packet.js` + `data/weapons.js`, so there is
// no `src/combat/index.js` yet.
//
// **The assembly rule every later CMBT-* ticket must follow (fixed after
// CMBT-2 first got it backwards):** `main.js` imports ONLY this file for the
// `combat` registration — a sibling file's `CombatSystem.prototype`
// extension never runs unless something reachable from `main.js` imports
// that sibling. So the dependency direction is always ONE way: a sibling
// (`tohit.js`, and whatever `resolve.js`/`resist.js`/etc. CMBT-3 onward add)
// exports plain pure functions and imports NOTHING from this file; this
// file imports the sibling and attaches its functions to `CombatSystem`
// here. Never the reverse — a sibling importing `CombatSystem` from here
// would make this file importing the sibling back a cycle.
//
// ---------------------------------------------------------------------------
// Scope — what this file owns, and what it deliberately does not
// ---------------------------------------------------------------------------
// Owns: `buildAttackPacket`, `buildSpellPacket`, `releasePacket`,
// `scratchPacket`, `attackInterval`, `castInterval` — the six methods this
// ticket's brief names as "everything you need". Every other method on
// `02-api-contracts.md` §8's table (`resolve`, `applyDirect`, `heal`,
// `chanceToHit`, `blockChanceOf`, `effectiveResist`, `isImmune`,
// `hitRecoveryTime`, `applyStatusFromPacket`, `expireBySource`, `awardXp`,
// `xpForMonster`, `threatOf`, `addThreat`) belongs to a later ticket
// (CMBT-2..7) and is deliberately absent, not stubbed — O-27: "CMBT-2
// through CMBT-7 land on top of you and will add methods to this
// subsystem", and this ticket's own brief is explicit that `chanceToHit`/
// `blockChanceOf` are CMBT-2's, not mine.
//
// The rows below R6 in `03-combat-math.md`'s E3 table (crit application,
// flat DR, resistance, the actual damage roll) are resolve-side (CMBT-3) —
// this file only has to produce the packet that feeds them
// (`packet.physMin`/`physMax`/`critChance`/`critMult`, correct to the exact
// values those rows consume). `tests/combat/packet.test.js` reproduces those
// downstream numbers too (the ticket's acceptance bar names them), but as
// plain arithmetic local to the test file — not as a public method here.
//
// ---------------------------------------------------------------------------
// Cross-subsystem data gaps this ticket ran into, and how each was resolved
// ---------------------------------------------------------------------------
// 1. CMBT-10/D-59 — CLOSED for the damage-curve half, still open for the
//    rest. `src/skills/` now exists (M2/M3) and `03 §6.1` B2's
//    `skill.weaponDamage` ("100 for a basic attack") and B7's "...and the
//    skill's flatDamage" are both wired below: `buildAttackPacket`/
//    `buildSpellPacket` resolve `SKILL_BY_ID[skillId]` (see "Where a skill's
//    OWN curve comes from" below) and feed its real `weaponDamage`/
//    `flatDamage` curve into B2/B7 for the given `level`, instead of the
//    flat `BASIC_ATTACK_WEAPON_DAMAGE = 100` this file used unconditionally
//    before. `skillScale` (B2's OTHER coefficient, `03 §4.3`'s attack-speed
//    term, unrelated to weaponDamage) stays fixed at `BASIC_SKILL_SCALE =
//    1.00` — no skill's `attackScale` is read by `attackInterval()` yet —
//    and B8's `onHitStatus`/synergy riders are STILL never populated here:
//    `onHitStatus` is applied by `skills/status.js#applyOnHitStatuses` AFTER
//    `resolve()` returns (by design — see that file's own header, "riders
//    are applied AFTER resolve(), never before"), and B2/B7's own "including
//    synergy bonuses (§8.7)" clause is likewise a CALLER-side multiply today
//    (`src/skills/summon.js`'s own `skills.synergyBonus(owner, 'unity',
//    'flatDamage')`, applied to `packet.lightMin/lightMax` AFTER
//    `buildSpellPacket` returns — the established precedent this ticket
//    follows, not invents). Neither gap is this ticket's acceptance
//    criterion (which names only "a skill's own damage curve"); both are
//    flagged again in this ticket's report as the two pieces of gap 1 that
//    remain.
//
//    `skillId`/`level` were already accepted and stored as packet provenance
//    (`sourceSkillId`/`sourceLevel`) before this ticket — no caller's
//    request shape changes: every existing call site
//    (`combat.buildAttackPacket(actor, skillId, level)` /
//    `buildSpellPacket(...)`, unchanged signatures, `02-api-contracts.md`
//    §8) already passed a real `skillId`/`level` for a real skill; this
//    ticket only changed what `combat` DOES with them.
//
//    ---------------------------------------------------------------------
//    Where a skill's OWN curve comes from — the design decision this
//    ticket had to make, and its cost
//    ---------------------------------------------------------------------
//    `combat` cannot import the `skills` SUBSYSTEM (`ARCHITECTURE.md` rule
//    2: "never import another subsystem's module... `skills` already
//    depends on `combat`" — a `combat -> skills` runtime import would be
//    circular). Three shapes were weighed for getting a skill's coefficient
//    into B2/B7 without that:
//
//    (a) THE CALLER PASSES IT — `skills` resolves the curve and hands the
//        number(s) into `buildAttackPacket`/`buildSpellPacket` as new
//        parameters. Rejected on a PRACTICAL, not just architectural,
//        ground: every real call site lives OUTSIDE this ticket's file
//        grant (`src/skills/channel.js`, `ground.js`, `imbue.js`,
//        `summon.js`, `projectile.js`, `mobility.js`, `impl/rune_strike.js`,
//        `impl/cleaving_strike.js` — nine call sites across eight files,
//        none of them `src/skills/index.js`). A signature change here would
//        leave every one of those callers passing the OLD shape, silently
//        reverting to the flat-100 default the moment `out` or a changed
//        parameter list stopped matching — i.e. this shape could not
//        actually ship from this ticket's grant.
//    (b) COMBAT READS `src/skills/data/skills.js` DIRECTLY (chosen). It is
//        the exact category `ARCHITECTURE.md` rule 9 exists for: "plain-
//        object tables under their owning subsystem's `data/` folder, so
//        the balance harness can read them headlessly" — `tools/
//        balance.mjs` already does precisely this import
//        (`import { SKILLS } from '../src/skills/data/skills.js'`), and
//        that file's own header states it is "Flat data, zero logic, zero
//        imports of engine code" — no subsystem instance, no lifecycle, no
//        `ctx`, nothing rule 2's "get it at runtime via `ctx.get(id)`"
//        prescription is actually protecting against (a live, stateful
//        `SkillsSystem`). The cost, named honestly: this is still a
//        `combat -> skills` STATIC import, which is rule 2's letter, not
//        just its spirit, and `CLASS_SCALE_TABLE` in `./data/weapons.js`
//        (this same file's own CMBT-1 precedent, for the analogous
//        `class.meleeScale`/`spellScale` problem) chose the OPPOSITE
//        resolution — a small, local, documented DUPLICATE of just the
//        needed columns, specifically to avoid this exact cross-subsystem
//        edge. This ticket diverges from that precedent deliberately: the
//        class table is 3 classes x 4 stable, rarely-tuned numbers; the
//        skill damage curves are up to 30 records x up to 6 fields each,
//        under ACTIVE balance iteration (`03-combat-math.md` itself is nine
//        of its own thirteen sections of ongoing calibration), and the
//        orchestrator's own brief states these 30 records are "verified
//        number by number by the orchestrator" against `03 §8` — a hand-
//        copied duplicate here would be a SECOND transcription of the same
//        30 records, each future balance edit landing in `skills.js` alone
//        and silently stranding this file's copy, which is a strictly worse
//        failure mode than the import's static coupling. Flagged plainly
//        for the orchestrator: if this precedent split (weapons.js
//        duplicates, packet.js imports) is not acceptable, the fix is a
//        `02-api-contracts.md`/`ARCHITECTURE.md` note making shape (b)'s
//        exception explicit — not a request to revisit the class-scale
//        table, which is unaffected by this ticket.
//    (c) THE CALLER ADJUSTS THE PACKET AFTER BUILD — `02 §8`'s caller-
//        adjustable whitelist (`radius`, `pierceIndex`, `onHitStatus`,
//        `knockback`, `originX/Y/Z`, `requesterOwnsRageCredit`) does not
//        include any damage field, and SKIL-9's ground-tick packets already
//        stretch that precedent past the documented list (see `ground.js`'s
//        own header, "beyond `02-api-contracts.md`'s own documented
//        'caller-adjustable' list... but the EXACT same category... this
//        file's own header already establishes and ships as accepted
//        code"). This ticket does not lean on that further-stretched
//        precedent for the GENERAL weaponDamage/flatDamage wiring (shape
//        (b) is a real fix, not another workaround), but flags SKIL-9's own
//        stretch here as something worth the orchestrator's separate
//        attention, per this ticket's own brief.
//
//    No `02-api-contracts.md` row is needed for this decision:
//    `buildAttackPacket`/`buildSpellPacket`'s public signatures are
//    unchanged (`(source, skillId, level, out?)`, exactly as documented) —
//    only what this file does internally with the already-contracted
//    `skillId`/`level` arguments changed.
//
// 2. No `items` table exists yet (`src/items/`, M3) — `Actor.equipment` is
//    always `null` (`src/actors/pool.js#createActorRecord`). `resolveWeapon()`
//    below reads `source.equipment.mainHand` when present (forward-
//    compatible with a future `ItemInstance` shaped compatibly:
//    `minDamage`/`maxDamage`/`attackTime`/`handling`) and falls back to
//    `WEAPONS.unarmed` (`03 §4.1`'s own default) otherwise. A test fixture
//    sets `actor.equipment = { mainHand: WEAPONS.axe_battle_normal }`
//    directly — see `data/weapons.js`'s header for why that table lives
//    there instead of inside an item system that does not exist yet.
//
// 3. `03 §2.1`'s class table (`attackScale`/`castScale`/`meleeScale`/
//    `spellScale`) has no single owner today — `src/actors/stats.js`'s own
//    `CLASS_TABLE` doesn't carry these four columns at all (they are not
//    `StatBlock` fields), and `ActorsSystem` exposes no getter for the raw
//    class table. `ARCHITECTURE.md` rule 2 forbids importing
//    `src/actors/stats.js` directly to reach for it. `data/weapons.js`'s
//    `CLASS_SCALE_TABLE` is a small, clearly-labelled, documented-as-
//    temporary duplicate of just those four columns — see that file's
//    header for the full reasoning and the precedent it follows
//    (`src/actors/stats.js`'s own header documents the identical situation
//    for its copy of the class table).
//
// 4. `castInterval(actor, skillId)`'s formula (`03 §4.4`) needs
//    `skill.castTime` — a per-skill base that, again, no skill table
//    provides yet. `DEFAULT_CAST_TIME` below is a documented placeholder
//    (not derived from any spec figure) standing in until `src/skills/`
//    can supply a real per-`skillId` cast time; `computeCastInterval()`
//    itself (the pure formula) is fully implemented and tested against
//    all four cast rows of `03-combat-math.md`'s E6 table directly.
//
// ---------------------------------------------------------------------------
// The DamagePacket shape — `01-data-model.md` §8.1, not `ARCHITECTURE.md`'s
// sketch
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md`'s "damage packet" section nests elemental damage as
// `elem: { fire, cold, light, poison }`. `01-data-model.md` §8.1 opens with
// "Expanded from the sketch in ARCHITECTURE.md" and gives the real, flat
// shape this file builds: `fireMin`/`fireMax`/`coldMin`/`coldMax`/
// `lightMin`/`lightMax`/`poisonMin`/`poisonMax`/`magicMin`/`magicMax`,
// `poisonDuration`, `coldDuration` — five elements (`ARCHITECTURE.md`'s own
// prose lists `magic` among the six damage elements even though its sketch's
// nested object omits it), not four, and no nested `elem` object anywhere.
// This file follows `01-data-model.md`'s literal field list.
//
// ---------------------------------------------------------------------------
// Poison is a TOTAL, not a rate — and B7 bakes the base duration in
// ---------------------------------------------------------------------------
// `01-data-model.md` §8.1's own sample shows `poisonDuration: 4.0` as a
// packet FIELD (not a bare stat), and separately documents the duration
// formula as "4.0 s + poisonDuration, from the packet" — i.e. `4.0` is a
// combat-side base constant, `poisonDuration` the stat's own (additive,
// gear/skill-sourced) bonus seconds. B7 below folds the two together and
// stores the FULL usable duration directly on the packet
// (`BASE_POISON_DURATION + stats.poisonDuration`), so `packet.poisonDuration`
// is already what a DoT tick (CMBT-4) should divide damage by — nobody
// downstream re-adds the `4.0` base. This exactly reproduces this ticket's
// E5 worked example ("Duration | 4.0 + 2.0 = 6.0 s") and the sample's own
// "no bonus" default (`stats.poisonDuration = 0` ⇒ packet shows `4.0`,
// matching the illustrative sample verbatim). The analogous chill base
// (`2.0 s + coldDuration`) is applied the same way for `coldDuration`, for
// consistency, though no worked example in this ticket's scope exercises it
// (chill accumulation itself is CMBT-4's, E8).
//
// ---------------------------------------------------------------------------
// critChance/critMult — two different "100"s, resolved
// ---------------------------------------------------------------------------
// `03-combat-math.md` §6.1: "Base critChance is 5 and base critMult is 200
// for every actor... Both are packet fields, so a skill may override them."
// `StatBlock.critChance`/`.critMult` (`src/actors/stats.js`) are a DIFFERENT
// pair of numbers: `critChance` defaults to `0` (an additive gear/skill
// bonus, in percentage points) and `critMult` defaults to `100` ("100% = no
// bonus" — that file's own comment, cap `[100,600]`). B8 below adds combat's
// packet-level base to each: `packet.critChance = BASE_CRIT_CHANCE +
// stats.critChance` (5 + 0 = 5 with no gear bonus) and `packet.critMult =
// BASE_CRIT_MULT + (stats.critMult - 100)` (200 + (100-100) = 200 with no
// gear bonus) — i.e. `stats.critMult`'s own neutral point (100) is
// subtracted back out before adding it on top of combat's 200 base. Both
// reduce to this ticket's E3 inputs (`critChance 5, critMult 200`) exactly
// when the actor carries no crit-related gear/skill bonus, which is the
// only combination any worked example in this ticket's scope exercises —
// flagged in this ticket's report as an inference, not a spec-stated
// formula, since no worked example shows a NON-zero crit bonus flowing
// through B8.
//
// ---------------------------------------------------------------------------
// Zero-allocation / determinism discipline
// ---------------------------------------------------------------------------
// `PacketPool` preallocates every `DamagePacket` (and its four `onHitStatus`
// slots) once, in its constructor (called from `init()`); `acquire()`/
// `release()` never allocate afterward. `onHitStatus` is a fixed 4-element
// array for the LIFE of the pool — `resetPacketFields()` zeroes each slot's
// fields in place and resets `onHitCount` to 0, but never touches the
// array's own `.length` (this ticket's brief: "`array.length = 0` tears the
// backing store" — the same V8 elements-backing-store transition
// `src/actors/pool.js`'s header measured for its own dense-list view).
// Packet liveness is tracked in a private `Uint8Array` alongside the pool,
// not as a public packet field (`01-data-model.md`'s own `DamagePacket`
// sample carries no `active` field), so a double-`releasePacket()` is a
// safe no-op — the same "never throw on a stale handle" discipline
// `src/actors/pool.js#release` cites from `src/physics/`. No `Map`
// anywhere, no `Math.hypot` (nothing here needs a distance), no
// `Math.random()` anywhere.
//
// `CombatSystem.init()` deliberately does NOT take a `ctx.rng.fork()` —
// this ticket's own B1-B8 pipeline draws no randomness at all (R5/R6/R8 are
// CMBT-3's). `ARCHITECTURE.md` rule 4 reads as "one fork per subsystem in
// init()", but `src/physics/index.js` (PHYS-1/2), `src/world/index.js` and
// `src/nav/index.js` all establish the same precedent for exactly this
// situation: `tests/core/boot.test.js`'s "prewarm: ... leaves ctx.rng
// untouched" hard-asserts the ENTIRE currently-registered subsystem set
// draws nothing from the root stream during boot (`Rng.fork()` itself
// consumes four `u32()` draws from its parent to seed the child, so any
// subsystem taking an unused fork in `init()` desyncs that test) — a file
// this ticket may not touch. `src/world/index.js`'s header states the
// resolution explicitly: "Whichever later ticket adds [this subsystem]'s
// first real use of randomness takes the fork then, and updates that boot
// test in the same commit." CMBT-3 (resolve(), the first ticket that
// actually rolls R5/R6/R8) is that later ticket for `combat`.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` scans `src/combat/` with
// `checkGlobals: true` the moment this directory exists).

import { WEAPONS, CLASS_SCALE_TABLE, NEUTRAL_CLASS_SCALE } from './data/weapons.js';
// CMBT-10/D-59 — a `combat -> skills/data` STATIC import, not `ctx.get`.
// `SKILLS` is the flat, logic-free, zero-engine-import table this file's own
// header ("Where a skill's OWN curve comes from") already argues is the
// category `ARCHITECTURE.md` rule 9 exists to make headlessly readable —
// see that header block for the full reasoning, the two alternatives
// weighed, and the cost named against `./data/weapons.js`'s own opposite
// (duplicate-instead-of-import) precedent for the analogous class-table
// problem.
import { SKILLS } from '../skills/data/skills.js';
import { chanceToHit, blockChanceOf } from './tohit.js';
import {
  DamageResultPool,
  RESULT_POOL_CAPACITY,
  resolveDamage,
  applyDirectDamage,
  healTarget,
  effectiveResistOf,
  isImmuneOf,
} from './resolve.js';
// CMBT-4 — src/combat/status.js exports plain pure functions and imports
// nothing from this file (O-51's assembly rule); this file imports them and
// attaches the class surface below, same as the tohit.js/resolve.js pairs
// above.
import {
  applyStatusFromPacket,
  expireBySourceAcrossActors,
  runDotTicks,
  onActorDamageForChill,
  createColdHitTracker,
} from './status.js';
// CMBT-5 — src/combat/reaction.js exports plain pure functions (R14(g) hit
// recovery, R14(h) knockback, §7.13 hit-stop) and imports nothing from this
// file (O-51's assembly rule); this file imports it and calls
// `applyReaction` from `resolve()` below, right after `resolveDamage()`
// hands back a `DamageResult` — see reaction.js's own header for why that
// wiring lives here rather than as an edit to `resolve.js` (not this
// ticket's file).
import { applyReaction, computeHitRecoveryTime } from './reaction.js';
// CMBT-7 — src/combat/onhit.js exports plain pure functions (the
// manaReturnPercent remainder of R14(d), and the whole of R14(f): rage gain
// on both sides, Resonance gain) and imports nothing from this file (O-51's
// assembly rule); this file imports it and calls `applyOnHitEconomy` from
// `resolve()` below, right after `resolveDamage()` and BEFORE
// `applyReaction()` — R14(d)/(f) precede (g)/(h) in the documented order.
// See onhit.js's own header for why this wiring lives here rather than as
// an edit to `resolve.js` (not this ticket's file either).
import { applyOnHitEconomy } from './onhit.js';
// CMBT-6 — src/combat/xp.js exports plain pure functions (R14(i)'s death
// check/the sole actor:death emitter, R14(j)'s XP award) and imports
// nothing from this file (O-51's assembly rule); this file imports it and
// wires `handleActorDamageForDeath` as a SECOND `ctx.events.on('actor:
// damage', ...)` listener in `init()` (same shape CMBT-4's own chill
// listener already established — see xp.js's own header for why this
// hooks `actor:damage` rather than being inlined into `resolve()` like
// CMBT-5/CMBT-7), plus attaches `xpForMonster`/`awardXp` to the class
// surface below.
import { xpForMonster, awardXp, handleActorDamageForDeath, DEFAULT_DIFFICULTY } from './xp.js';

// ---------------------------------------------------------------------------
// Combat-owned constants — 03-combat-math.md §6.1/§4.3/§4.4, and this
// file's own documented placeholders (see the header, gaps 1 and 4)
// ---------------------------------------------------------------------------

/** `01-data-model.md` §11.1: `DamagePacket | combat | 256`. */
export const PACKET_POOL_CAPACITY = 256;

/** `03-combat-math.md` §6.1: "Base critChance is 5 ... for every actor." */
export const BASE_CRIT_CHANCE = 5;
/** `03-combat-math.md` §6.1: "... and base critMult is 200 for every actor." */
export const BASE_CRIT_MULT = 200;
/** See the file header, "Poison is a TOTAL" — the packet's own base seconds
 * of poison duration before `stats.poisonDuration`'s bonus is added. */
export const BASE_POISON_DURATION = 4.0;
/** Analogous chill base — see the file header for the same reasoning. */
export const BASE_COLD_DURATION = 2.0;

/** `03-combat-math.md` §6.1 B2: "100 for a basic attack." Still the default
 * for a basic attack (`skillId` null/`'attack'`/unrecognised) and for any
 * skill whose own `weaponDamage` curve is `null` (a spell) — see
 * `weaponDamagePercentFor` below for the real-skill case, wired by
 * CMBT-10/D-59. */
export const BASIC_ATTACK_WEAPON_DAMAGE = 100;
/** `03-combat-math.md` §4.3's `skill.attackScale` term, fixed at 1.00 (no
 * skill table read for THIS one yet — `attackInterval()`'s own gap, not
 * CMBT-10/D-59's: that ticket's acceptance criterion is a skill's DAMAGE
 * curve, not its `attackScale`. See the file header, gap 1, "still open"). */
export const BASIC_SKILL_SCALE = 1.0;

// ---------------------------------------------------------------------------
// CMBT-10/D-59 — the skill lookup table and the two small pure helpers B2/B7
// read from it. Built ONCE at module load from the imported `SKILLS` (see
// the file header for why this file may import it at all); every lookup
// after that is a single plain-object property read — no `Map`, no
// allocation, matching this file's own "Zero-allocation / determinism
// discipline" section.
// ---------------------------------------------------------------------------

/** `SKILLS[i].id -> SkillDefinition`, built once. A plain `Object.create(null)`
 * dictionary (no prototype chain to shadow a skillId against, same
 * reasoning `CLASS_SCALE_TABLE`'s own plain-object lookup already
 * establishes in `./data/weapons.js`). */
const SKILL_BY_ID = Object.create(null);
for (let i = 0; i < SKILLS.length; i++) SKILL_BY_ID[SKILLS[i].id] = SKILLS[i];

/** `01-data-model.md` §6.1's `element` field ('fire'|'cold'|'lightning'|
 * 'poison'|'magic'|'physical') -> this file's own `ELEMENTS` array index
 * (`ELEMENTS[2] === 'light'`, not `'lightning'` — `01`'s own packet-field-
 * prefix naming quirk, already documented where `ELEMENTS` is declared
 * below). `'physical'` (every weapon-damage skill, every passive/buff/
 * toggle with no damage of its own) has no entry — `skillFlatElementIndex`
 * below returns `-1` for it, which never matches any `ELEMENTS` index in
 * `stepB7`'s loop, i.e. a correct no-op. */
const SKILL_ELEMENT_TO_INDEX = Object.freeze({ fire: 0, cold: 1, lightning: 2, poison: 3, magic: 4 });

/** `skillId -> SkillDefinition | null`. `null`/`undefined`/`'attack'`/any
 * id absent from `SKILLS` (a basic attack, or a test-only placeholder id —
 * `tests/combat/packet.test.js`'s own `'test_poison_bolt'`) all resolve to
 * `null`, preserving this file's pre-CMBT-10 default behaviour exactly.
 * @param {string|null|undefined} skillId
 * @returns {object|null}
 */
function skillRecordFor(skillId) {
  return (skillId && SKILL_BY_ID[skillId]) || null;
}

/** `03-combat-math.md` §6.1 B2, resolved for a real skill: `skillDef.
 * weaponDamage.base + perLevel × (level − 1)` — `03` §8's own "L denotes
 * effective skill level... base + perLevel × (L − 1)" formula, the same
 * arithmetic `src/skills/cost.js#levelValue` already applies (a small,
 * self-contained duplicate here rather than an added cross-subsystem call —
 * no `weaponDamage`/`flatDamage` curve in `03` §8 carries a `cap`, so
 * `levelValue`'s own cap-clamp branch would be dead code if reached for).
 * Falls back to `BASIC_ATTACK_WEAPON_DAMAGE` when `skillDef` is `null` (a
 * basic attack) or carries no `weaponDamage` curve of its own (a spell,
 * `01-data-model.md` §6.1: "null for spells").
 * @param {object|null} skillDef
 * @param {number} level
 * @returns {number} percent, e.g. `100` for a basic attack, `143` for
 *   `rune_strike` at L5.
 */
function weaponDamagePercentFor(skillDef, level) {
  if (skillDef && skillDef.weaponDamage) {
    return skillDef.weaponDamage.base + skillDef.weaponDamage.perLevel * (level - 1);
  }
  return BASIC_ATTACK_WEAPON_DAMAGE;
}

/** `skillDef.element -> ELEMENTS` index, or `-1` for `'physical'`/any value
 * `SKILL_ELEMENT_TO_INDEX` does not carry. A single primitive-returning
 * property lookup — no allocation.
 * @param {string} element
 * @returns {number}
 */
function skillFlatElementIndex(element) {
  const idx = SKILL_ELEMENT_TO_INDEX[element];
  return idx === undefined ? -1 : idx;
}

/** Placeholder `skill.castTime` — see the file header, gap 4. NOT a spec
 * figure; chosen to match `unarmed`'s attack time as a neutral standby
 * value, nothing more. */
export const DEFAULT_CAST_TIME = 0.60;

/** `03-combat-math.md` §6.1 B7's five elements, in the order every `${el}Min`/
 * `${el}Max`/`${el}DamagePercent` field name is built from. */
const ELEMENTS = Object.freeze(['fire', 'cold', 'light', 'poison', 'magic']);

/** `01-data-model.md` §8.1: "Preallocated array of 4 slots; `onHitCount` is
 * the live length." */
const ONHIT_SLOT_COUNT = 4;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** `03-combat-math.md` §4.1/§4.2: `attributeBonus = 1 + handlingBonus`, per
 * weapon handling class. Unknown/missing `handling` falls back to `1`
 * (neutral, no-op) rather than throwing — a defensive default, never
 * exercised by any worked example in this ticket's scope.
 * @param {string} handling
 * @param {number} strength
 * @param {number} dexterity
 * @returns {number}
 */
export function attributeBonusFor(handling, strength, dexterity) {
  switch (handling) {
    case 'oneHandMelee':
    case 'unarmed':
      return 1 + strength / 100;
    case 'twoHandMelee':
      return 1 + strength / 75;
    case 'dagger':
      return 1 + (strength + dexterity) / 150;
    case 'wand':
    case 'staff':
      return 1 + strength / 150;
    default:
      return 1;
  }
}

/** See the file header, gap 2 — amended by ITEM-11/D-21 now that `items`
 * exists. `source.equipment.mainHand` when present, else `WEAPONS.unarmed`.
 *
 * `actor.equipment.mainHand` carries the literal `ItemInstance | null` of
 * `01-data-model.md` §5.4, not a flat weapon profile: an `ItemInstance` has
 * `rolls.damageMin`/`damageMax` (different names) and no `attackTime`/
 * `handling` at all — those live on `ItemBase`, reachable only through
 * `baseId`, which only `items` may resolve (`ARCHITECTURE.md` rule 2 forbids
 * `combat` doing that lookup itself). `items.equip()`/`unequip()` (the only
 * write paths for `mainHand`) maintain a derived `_cache.weapon = {
 * minDamage, maxDamage, attackTime, handling }` on the item for exactly this
 * read — `01` §5's own "cached, never serialised, rebuilt on load" `_cache`
 * contract. Discriminated on `'baseId' in mainHand`: a real `ItemInstance`
 * always carries `baseId` (`01` §5.3); `data/weapons.js`'s own fixture rows
 * (used directly by tests/fixtures that set `actor.equipment.mainHand =
 * WEAPONS.axe_battle_normal` verbatim, and by any monster/no-`items`-yet
 * caller) carry `id`, never `baseId`, and are returned as-is unchanged. A
 * real item with no `_cache.weapon` yet built (not equipped through
 * `items.equip()` — e.g. a save loaded before `rebuildCache` learns to
 * populate it, ITEM-13, not yet built) falls back to `WEAPONS.unarmed`
 * rather than reading `undefined` fields — this is O-55's now-half-open
 * "stale cache reads as unarmed" edge case, carried forward for the
 * `ai`/monster side per this ticket's report.
 * @param {object} source an Actor record.
 * @returns {object} a weapon-shaped object (`data/weapons.js`'s shape).
 */
export function resolveWeapon(source) {
  const mainHand = source && source.equipment && source.equipment.mainHand;
  if (!mainHand) return WEAPONS.unarmed;
  if (mainHand.baseId !== undefined) {
    return (mainHand._cache && mainHand._cache.weapon) || WEAPONS.unarmed;
  }
  return mainHand;
}

/** See the file header, gap 3. `CLASS_SCALE_TABLE[classId]`, else the
 * neutral (×1) fallback for a monster/no-class actor.
 * @param {string|null} classId
 * @returns {{attackScale:number, castScale:number, meleeScale:number, spellScale:number}}
 */
export function classScaleFor(classId) {
  return CLASS_SCALE_TABLE[classId] || NEUTRAL_CLASS_SCALE;
}

/** Reads the already-composed `StatBlock` off a passed-in Actor record.
 * `combat` never composes stats itself and never imports `src/actors/`
 * (`ARCHITECTURE.md` rule 2) — `source.stats` is a plain data field on the
 * shared `Actor` record (`01-data-model.md` §2), populated elsewhere
 * (`actors.stats(actor)` once that method is wired, or `composeStats(actor)`
 * directly in a test — see this ticket's report). Throws a clear error
 * rather than silently building a packet out of `undefined` arithmetic.
 * @param {object} source
 * @returns {object} a `StatBlock`.
 */
function requireStats(source) {
  const stats = source && source.stats;
  if (!stats) {
    throw new Error(
      "combat: source.stats is not composed — call actors.stats(source) (or composeStats(source)) " +
        'before requesting a damage packet; combat does not compose stats itself (ARCHITECTURE.md rule 2).',
    );
  }
  return stats;
}

// ---------------------------------------------------------------------------
// DamagePacket — shape, pool, reset
// ---------------------------------------------------------------------------

function createOnHitSlot() {
  return { status: null, chance: 0, duration: 0, magnitude: 0, stacks: 0 };
}

/** `01-data-model.md` §8.1, verbatim field set. Built once per pool slot,
 * mutated in place forever after (never reassigned) — see the file header.
 * @param {number} poolIndex
 */
function createDamagePacket(poolIndex) {
  const onHitStatus = new Array(ONHIT_SLOT_COUNT);
  for (let i = 0; i < ONHIT_SLOT_COUNT; i++) onHitStatus[i] = createOnHitSlot();

  return {
    // ─── provenance ───────────────────────────────────────────────────────
    sourceId: 0, sourceGen: 0, sourceSkillId: null, sourceLevel: 0, team: 0,

    // ─── physical, post-ED, post-attribute, pre-mitigation ───────────────
    physMin: 0, physMax: 0,

    // ─── elemental, post-percent, pre-resistance ─────────────────────────
    fireMin: 0, fireMax: 0,
    coldMin: 0, coldMax: 0,
    lightMin: 0, lightMax: 0,
    poisonMin: 0, poisonMax: 0,
    magicMin: 0, magicMax: 0,
    poisonDuration: 0,
    coldDuration: 0,

    // ─── to-hit ───────────────────────────────────────────────────────────
    attackRating: 0, attackerLevel: 0, blockable: false, dodgeable: false,

    // ─── crit ─────────────────────────────────────────────────────────────
    critChance: 0, critMult: 0,

    // ─── resistance pierce ────────────────────────────────────────────────
    fireResistPierce: 0, coldResistPierce: 0, lightResistPierce: 0, poisonResistPierce: 0,

    // ─── on-hit riders ────────────────────────────────────────────────────
    onHitStatus, onHitCount: 0,

    lifeSteal: 0, manaSteal: 0, lifeOnHit: 0, manaOnHit: 0, manaReturnPercent: 0,

    // ─── requester-owned economy (SKIL-7/D-52, src/combat/onhit.js's own
    // header — not yet in 01-data-model.md §8; flag pending a doc update) ──
    requesterOwnsRageCredit: false,

    // ─── impulse ──────────────────────────────────────────────────────────
    knockback: 0, knockbackDistance: 0, hitStop: 0,

    // ─── geometry ─────────────────────────────────────────────────────────
    originX: 0, originY: 0, originZ: 0, pierceIndex: 0,

    // ─── pooling ──────────────────────────────────────────────────────────
    poolIndex,
  };
}

/** `01-data-model.md` §11.2's reset contract, applied to a `DamagePacket`.
 * Every field but `poolIndex` (rule 6) goes back to its type default
 * (numbers → 0, strings → `null`, booleans → `false` — rule 1);
 * `onHitStatus`'s four slot OBJECTS are zeroed in place, the array itself
 * never resized (see the file header). Never allocates.
 * @param {object} p a pooled `DamagePacket`.
 */
function resetPacketFields(p) {
  p.sourceId = 0; p.sourceGen = 0; p.sourceSkillId = null; p.sourceLevel = 0; p.team = 0;

  p.physMin = 0; p.physMax = 0;

  p.fireMin = 0; p.fireMax = 0;
  p.coldMin = 0; p.coldMax = 0;
  p.lightMin = 0; p.lightMax = 0;
  p.poisonMin = 0; p.poisonMax = 0;
  p.magicMin = 0; p.magicMax = 0;
  p.poisonDuration = 0;
  p.coldDuration = 0;

  p.attackRating = 0; p.attackerLevel = 0; p.blockable = false; p.dodgeable = false;

  p.critChance = 0; p.critMult = 0;

  p.fireResistPierce = 0; p.coldResistPierce = 0; p.lightResistPierce = 0; p.poisonResistPierce = 0;

  for (let i = 0; i < p.onHitStatus.length; i++) {
    const slot = p.onHitStatus[i];
    slot.status = null; slot.chance = 0; slot.duration = 0; slot.magnitude = 0; slot.stacks = 0;
  }
  p.onHitCount = 0;

  p.lifeSteal = 0; p.manaSteal = 0; p.lifeOnHit = 0; p.manaOnHit = 0; p.manaReturnPercent = 0;

  p.requesterOwnsRageCredit = false;

  p.knockback = 0; p.knockbackDistance = 0; p.hitStop = 0;

  p.originX = 0; p.originY = 0; p.originZ = 0; p.pierceIndex = 0;

  // p.poolIndex is untouched — 01-data-model.md §11.2 rule 6.
}

/** Fixed-capacity `DamagePacket` pool — same free-list-of-indices shape as
 * `src/actors/pool.js`'s `ActorPool`/`src/physics/body.js`'s body store; no
 * `Map` anywhere (this ticket's brief: banned for pooled state). Liveness is
 * tracked in a private `Uint8Array`, off the public packet shape — see the
 * file header.
 */
export class PacketPool {
  /** @param {number} capacity */
  constructor(capacity) {
    this._capacity = capacity;
    this._records = new Array(capacity);
    for (let i = 0; i < capacity; i++) this._records[i] = createDamagePacket(i);

    this._freeSlots = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this._freeSlots[i] = i;
    this._freeCount = capacity;

    this._inUse = new Uint8Array(capacity);
  }

  get capacity() {
    return this._capacity;
  }

  /** @returns {object|null} `null` when the pool is dry — `01-data-
   * model.md` §11.1's documented overflow policy for `DamagePacket` ("drop
   * the request, log once per second in dev") is the CALLER's job
   * (`CombatSystem` methods below), not this pool's. */
  acquire() {
    if (this._freeCount === 0) return null;
    const slot = this._freeSlots[--this._freeCount];
    const p = this._records[slot];
    resetPacketFields(p);
    this._inUse[slot] = 1;
    return p;
  }

  /** Safe no-op on a double release or a packet this pool doesn't own —
   * same discipline `src/actors/pool.js#release` cites from
   * `src/physics/index.js`/`body.js`.
   * @param {object} p
   */
  release(p) {
    if (!p) return;
    const slot = p.poolIndex;
    if (slot < 0 || slot >= this._capacity || this._records[slot] !== p) return;
    if (!this._inUse[slot]) return;
    resetPacketFields(p);
    this._inUse[slot] = 0;
    this._freeSlots[this._freeCount++] = slot;
  }

  dispose() {
    this._freeCount = 0;
  }
}

// ---------------------------------------------------------------------------
// B1-B8 — 03-combat-math.md §6.1, one exported pure function per step so a
// test can chain them and assert every intermediate (this ticket's brief:
// "Make the B-stage intermediates observable and assertable").
// ---------------------------------------------------------------------------

/** B1: weapon base range. `weapon` falsy (or omitted) ⇒ `physMin =
 * physMax = 0` — "Spells start at physMin = physMax = 0."
 * @param {object} packet
 * @param {{minDamage:number,maxDamage:number}|null} weapon
 */
export function stepB1(packet, weapon) {
  if (weapon) {
    packet.physMin = weapon.minDamage;
    packet.physMax = weapon.maxDamage;
  } else {
    packet.physMin = 0;
    packet.physMax = 0;
  }
}

/** B2: skill coefficient, `× skill.weaponDamage / 100` ("100 for a basic
 * attack" — see the file header, gap 1, for why every call today uses 100).
 * @param {object} packet
 * @param {number} weaponDamagePercent
 */
export function stepB2(packet, weaponDamagePercent) {
  const mult = weaponDamagePercent / 100;
  packet.physMin *= mult;
  packet.physMax *= mult;
}

/** B3: enhanced damage, `× (1 + enhancedDamage / 100)`.
 * @param {object} packet
 * @param {number} enhancedDamage
 */
export function stepB3(packet, enhancedDamage) {
  const mult = 1 + enhancedDamage / 100;
  packet.physMin *= mult;
  packet.physMax *= mult;
}

/** B4: flat added damage, added AFTER ED (`03 §6.1`: "flat damage from a
 * ring is not multiplied by a weapon's ED").
 * @param {object} packet
 * @param {number} minDamage
 * @param {number} maxDamage
 */
export function stepB4(packet, minDamage, maxDamage) {
  packet.physMin += minDamage;
  packet.physMax += maxDamage;
}

/** B5: attribute bonus, `× (1 + handlingBonus)`. Skipped entirely for
 * spells — callers simply do not invoke this step for a spell packet (see
 * `buildSpellPacket` below), rather than passing a neutral `1`, so the
 * pipeline shape matches `03 §6.1`'s own wording exactly.
 * @param {object} packet
 * @param {number} attributeBonus
 */
export function stepB5(packet, attributeBonus) {
  packet.physMin *= attributeBonus;
  packet.physMax *= attributeBonus;
}

/** B6: class damage scale (`meleeScale` for weapon physical, `spellScale`
 * for a `flatDamage` skill's physical share — the caller picks which),
 * then `× (1 + physicalDamagePercent / 100)`.
 * @param {object} packet
 * @param {number} classScale
 * @param {number} physicalDamagePercent
 */
export function stepB6(packet, classScale, physicalDamagePercent) {
  const mult = classScale * (1 + physicalDamagePercent / 100);
  packet.physMin *= mult;
  packet.physMax *= mult;
}

/** B7: elemental assembly. For each of fire/cold/lightning('light')/
 * poison/magic: `stats.<el>Min`/`Max` (the composed total of affixes —
 * gear, other passives; `composeStats`' own layers) PLUS the casting
 * skill's own `flatDamage` curve when `el` is that skill's `element`
 * (CMBT-10/D-59 — see the file header; `03 §6.1` B7: "min/max from the
 * weapon, affixes AND THE SKILL'S FLATDAMAGE, then the element's percent
 * stats" — the skill term was never added here before this ticket) ×
 * that element's own percent stat × `elementalDamagePercent`. Poison/cold
 * additionally carry their assembled total duration — see the file header,
 * "Poison is a TOTAL".
 *
 * The three extra parameters are OPTIONAL and default to "no skill flat
 * contribution" — every pre-CMBT-10 2-arg call (`tests/combat/
 * packet.test.js`'s own direct `stepB7(packet, stats)` calls, E5 included)
 * reproduces byte-identical output; only `buildAttackPacket`/
 * `buildSpellPacket` below pass real values, resolved once by
 * `skillFlatElementIndex`/the casting skill's curve before this call, never
 * as a fresh `${el}...` template string per element (this file's own "do
 * not add an eleventh" budget, O-59).
 * @param {object} packet
 * @param {object} stats a `StatBlock`.
 * @param {number} [skillFlatElementIndex] index into `ELEMENTS` the casting
 *   skill's own `flatDamage` belongs to, or `-1` for none (default).
 * @param {number} [skillFlatMin] the casting skill's own flat min, already
 *   evaluated for `level` (default `0`).
 * @param {number} [skillFlatMax] likewise, flat max (default `0`).
 */
export function stepB7(packet, stats, skillFlatElementIndex = -1, skillFlatMin = 0, skillFlatMax = 0) {
  const elementalMult = 1 + stats.elementalDamagePercent / 100;
  for (let i = 0; i < ELEMENTS.length; i++) {
    const el = ELEMENTS[i];
    const pctMult = (1 + stats[`${el}DamagePercent`] / 100) * elementalMult;
    let baseMin = stats[`${el}Min`];
    let baseMax = stats[`${el}Max`];
    if (i === skillFlatElementIndex) {
      baseMin += skillFlatMin;
      baseMax += skillFlatMax;
    }
    packet[`${el}Min`] = baseMin * pctMult;
    packet[`${el}Max`] = baseMax * pctMult;
  }
  packet.poisonDuration = BASE_POISON_DURATION + stats.poisonDuration;
  packet.coldDuration = BASE_COLD_DURATION + stats.coldDuration;
}

/** B6, elemental half — a defect found in CMBT-3 review, fixed here (still
 * this ticket's file): `03 §6.1`'s own B6 row is "`× class.meleeScale` for
 * weapon physical, `× class.spellScale` for `flatDamage` skills" — TWO
 * channels, not one. The `stepB6` above only ever multiplied
 * `physMin`/`physMax`; elemental damage (fire/cold/lightning/poison/magic —
 * always `flatDamage`-sourced, per `01-data-model.md` §3.3's own field
 * docs) never got a class-scale term at all, which desyncs from `03`'s E13
 * worked example (`blade_seal` lightning 12-25 × Runeblade `spellScale`
 * 0.95 = 17.575) the moment anything drives that example through the real
 * `buildAttackPacket`/`buildSpellPacket` pipeline instead of reproducing
 * the missing multiply as test-local arithmetic.
 *
 * Called AFTER `stepB7` (never before — `packet.fireMin`/etc. do not exist
 * until B7 assembles them), which reverses `03`'s own "class scale, THEN
 * percent stats" order for the elemental channel. This is safe: both are
 * plain multiplicative factors on the same base value, and multiplication
 * commutes — `raw × classScale × percentMult` and `raw × percentMult ×
 * classScale` are identical to the bit, so running the class-scale pass
 * after B7 (which already folds in `elementDamagePercent`/
 * `elementalDamagePercent`) changes nothing about the final number, only
 * the order two commuting multiplies happen to run in.
 * @param {object} packet
 * @param {number} classScale class.spellScale — elemental damage is always
 *   the `flatDamage` channel, on both an attack packet (a weapon imbue) and
 *   a spell packet, so both build methods pass `spellScale` here, never
 *   `meleeScale`.
 */
export function stepB6Elemental(packet, classScale) {
  packet.fireMin *= classScale; packet.fireMax *= classScale;
  packet.coldMin *= classScale; packet.coldMax *= classScale;
  packet.lightMin *= classScale; packet.lightMax *= classScale;
  packet.poisonMin *= classScale; packet.poisonMax *= classScale;
  packet.magicMin *= classScale; packet.magicMax *= classScale;
}

/** B8: riders. `03 §6.1`'s own list: attackRating, attackerLevel,
 * critChance, critMult, `*ResistPierce`, lifeSteal, manaSteal, lifeOnHit,
 * manaOnHit, manaReturnPercent, knockback, onHitStatus[], blockable,
 * dodgeable, hitStop — plus the provenance fields every packet needs
 * (sourceId/sourceGen/sourceSkillId/sourceLevel/team), which `03 §6.1`'s
 * table does not itemise but `01-data-model.md` §8.1's shape requires.
 * `knockbackDistance` (mass-dependent — the target isn't known yet at
 * build time) and `hitStop` (no skill table to source a value from — gap
 * 1) are left at their reset default; both are documented gaps, not bugs.
 * @param {object} packet
 * @param {{stats:object, source:object, skillId:string|null|undefined, level:number|null|undefined}} args
 */
export function stepB8(packet, { stats, source, skillId, level }) {
  packet.sourceId = source.id;
  packet.sourceGen = source.generation;
  packet.sourceSkillId = skillId || 'attack'; // 01-data-model.md §8.1: 'skillId | attack | thorns | dot | environment'
  packet.sourceLevel = level || 0; // "0 for basic attacks"
  packet.team = source.team;

  packet.attackRating = stats.attackRating;
  packet.attackerLevel = source.level;
  packet.blockable = true;
  packet.dodgeable = true;

  packet.critChance = BASE_CRIT_CHANCE + stats.critChance;
  packet.critMult = BASE_CRIT_MULT + (stats.critMult - 100); // see the file header

  packet.fireResistPierce = stats.fireResistPierce;
  packet.coldResistPierce = stats.coldResistPierce;
  packet.lightResistPierce = stats.lightResistPierce;
  packet.poisonResistPierce = stats.poisonResistPierce;

  packet.lifeSteal = stats.lifeSteal;
  packet.manaSteal = stats.manaSteal;
  packet.lifeOnHit = stats.lifeOnHit;
  packet.manaOnHit = stats.manaOnHit;
  packet.manaReturnPercent = stats.manaReturnPercent;

  packet.knockback = stats.knockbackChance;
  // packet.knockbackDistance: target-mass-dependent, left at 0 — see this
  // function's own header.
  // packet.hitStop: no skill table yet to source a value from — left at 0.

  packet.onHitCount = 0; // no skill table yet — see the file header, gap 1
}

// ---------------------------------------------------------------------------
// Attack / cast interval — 03-combat-math.md §4.3/§4.4
// ---------------------------------------------------------------------------

/** `03-combat-math.md` §4.3, verbatim (including its own inner clamp on the
 * speed stat itself, `[-75,+300]`).
 * @param {number} base weapon.attackTime
 * @param {number} classScale class.attackScale
 * @param {number} skillScale skill.attackScale
 * @param {number} increasedAttackSpeed the actor's IAS stat, unclamped
 * @returns {number} seconds
 */
export function computeAttackInterval(base, classScale, skillScale, increasedAttackSpeed) {
  const ias = clamp(increasedAttackSpeed, -75, 300);
  const raw = (base * classScale * skillScale) / (1 + ias / 100);
  return clamp(raw, 0.25, 3.0);
}

/** `03-combat-math.md` §4.4, verbatim (including its own inner clamp on the
 * speed stat itself, `[-75,+200]`). No `skillScale` term — the formula has
 * none.
 * @param {number} base skill.castTime
 * @param {number} classScale class.castScale
 * @param {number} fasterCastRate the actor's FCR stat, unclamped
 * @returns {number} seconds
 */
export function computeCastInterval(base, classScale, fasterCastRate) {
  const fcr = clamp(fasterCastRate, -75, 200);
  const raw = (base * classScale) / (1 + fcr / 100);
  return clamp(raw, 0.15, 3.0);
}

// ---------------------------------------------------------------------------
// CombatSystem — the subsystem shell src/main.js registers
// ---------------------------------------------------------------------------

/** Simulation steps between exhausted-pool warnings — `01-data-model.md`
 * §11.1's documented overflow policy is "log once per second in dev"; combat
 * may not read the wall clock (`ARCHITECTURE.md` rule 4 / this ticket's own
 * rule 4), so this rate-limits against the deterministic `ctx.time.step`
 * counter instead (60 steps ≈ 1 s at the fixed 60 Hz simulation rate). */
const POOL_WARN_STEP_INTERVAL = 60;

export class CombatSystem {
  static id = 'combat';
  static deps = ['actors'];

  constructor() {
    this._ctx = null;
    this._pool = null;
    this._lastPoolWarnStep = -Infinity;
    // CMBT-10/D-59 — reused scratch for the per-call skill-curve resolution
    // `buildAttackPacket`/`buildSpellPacket` share below, via
    // `_resolveSkillCurve()`. Same "preallocated, mutated per call, never
    // reallocated" discipline every other `this._*Scratch` field in this
    // class already uses (see `init()`'s own block for the fuller
    // precedent); safe as a single shared object because neither build
    // method is reentrant (no event dispatch happens mid-build).
    this._skillCurveScratch = { weaponDamagePercent: BASIC_ATTACK_WEAPON_DAMAGE, flatElementIndex: -1, flatMin: 0, flatMax: 0 };
  }

  async init(ctx) {
    this._ctx = ctx;
    this._pool = new PacketPool(PACKET_POOL_CAPACITY);

    // CMBT-3: resolve()/R5/R6/R8/R14(c) are the first real draws this
    // subsystem makes — the ONE `ctx.rng.fork()` `ARCHITECTURE.md`'s
    // determinism contract wants, taken here and never re-forked per event
    // (see `resolve.js`'s header, and `tests/core/boot.test.js`'s rewritten
    // O-36 assertion for the boot-time consequence of this).
    this._rng = ctx.rng.fork();
    this._resultPool = new DamageResultPool(RESULT_POOL_CAPACITY);

    // Preallocated scratch for `resolveDamage`'s `env` bag and the one
    // nested (thorns) call it may make — built once, mutated per call, so
    // `resolve()` itself never allocates (12.A05). See resolve.js's header.
    this._sourceRefScratch = { id: 0, generation: 0 };
    this._statusSpecScratch = { status: null, step: 0, sourceId: 0, sourceGen: 0, sourceSkill: null, element: null, magnitude: 0, duration: 0, stacks: 1 };
    this._damagePayloadScratch = { target: null, source: null, result: null };
    this._resolveEnv = {
      source: null, rng: this._rng, step: 0, actorsSystem: null, events: ctx.events,
      packetPool: this._pool, resultPool: this._resultPool,
      statusSpec: this._statusSpecScratch, damagePayload: this._damagePayloadScratch,
      thornsEnv: null, isThornsCounter: false,
    };
    this._resolveEnv.thornsEnv = {
      source: null, rng: this._rng, step: 0, actorsSystem: null, events: ctx.events,
      packetPool: this._pool, resultPool: this._resultPool,
      statusSpec: this._statusSpecScratch, damagePayload: this._damagePayloadScratch,
      thornsEnv: null, isThornsCounter: true,
    };

    // CMBT-8/D-51 — the pooled-object OWNERSHIP RULE for this listener,
    // fixing the leak `02-api-contracts.md` §8's own "never hold a
    // DamagePacket or DamageResult past the synchronous dispatch of the
    // event that carried it" rule already forbids:
    //
    //  PACKET: owned by the REQUESTER (whoever emitted `combat:hit-request`
    //  after acquiring the packet via `buildAttackPacket`/`buildSpellPacket`/
    //  `scratchPacket`) — this listener never acquires or releases one.
    //  Both real callers in this tree (`ai/brains/melee.js#emitRankerHit`,
    //  `src/skills/impl/cleaving_strike.js#resolveHit`) already follow this:
    //  they call `releasePacket()` themselves once they are done with it.
    //  This matters because a single packet is legitimately reused across
    //  SEVERAL `combat:hit-request` emits for one action (a cone/nova hitting
    //  N targets with the same packet, `cleaving_strike`'s own shape) —
    //  releasing it here after the FIRST resolve would zero it out from
    //  under the remaining targets (`release()` resets fields in place on
    //  the shared object), corrupting every hit after the first.
    //
    //  RESULT: this listener is the ONLY consumer of `resolve()`'s return
    //  value on this path — `combat:hit-request` is fire-and-forget (no
    //  event carries `resolve()`'s return value back to the emitter), and
    //  everything that needs the outcome already read it off `actor:damage`
    //  itself, synchronously, before this call returns ("copy what you need
    //  during dispatch"). Before this fix, `resolve(packet, target)` was
    //  called with no `out`, so every call acquired a fresh `DamageResult`
    //  from `_resultPool` and NOTHING ever released it — `DamageResultPool
    //  acquire()` returns `null` once dry (256 calls), and every
    //  `combat:hit-request` after that silently dropped (`resolve()` itself
    //  returns `null` and does nothing). Fixed by handing `resolve()` a
    //  permanent, reused scratch `DamageResult` as `out` — the same
    //  "preallocated, mutated per call" discipline `_sourceRefScratch`/
    //  `_damagePayloadScratch` above already use — so this path never draws
    //  from `_resultPool` at all and cannot leak by construction, not merely
    //  by remembering to release. Safe to reuse across a cone's whole
    //  multi-target loop for the same reason the packet reuse above is safe:
    //  `resolveDamage()` resets it (`resetResultFields`) at the top of every
    //  call, and nothing downstream holds a reference past its own
    //  synchronous handling of that one hit's `actor:damage`.
    //
    //  Not reentrancy-safe by design, same assumption
    //  `cleaving_strike.js#resolveHit`'s own `resolvingSource`/
    //  `landedThisAction` scratch already documents: nothing in this
    //  codebase re-emits `combat:hit-request` synchronously from inside an
    //  `actor:damage` handler today, so a single shared scratch `out` is
    //  safe. A future caller that DID would need this promoted the same way
    //  `resolveDamage`'s own `thornsEnv` is a SECOND, separate scratch for
    //  its one legitimate nested call.
    this._hitRequestResultScratch = this._resultPool.acquire();
    // `ARCHITECTURE.md`'s event table: "combat:hit-request ... the only
    // entry point for a requested hit" — the sole listener. Subscribed once
    // here; `resolve()` re-derives `source` from the packet's own
    // `sourceId`/`sourceGen` regardless of what the payload's own `source`
    // field carries (a packet must be resolvable on its own — see
    // `resolve.js`'s header).
    this._onHitRequest = ({ target, packet }) => {
      this.resolve(packet, target, this._hitRequestResultScratch);
    };
    ctx.events.on('combat:hit-request', this._onHitRequest);

    // CMBT-4 — the `env` bag `status.js`'s functions take, same discipline
    // as `_resolveEnv` above (built once, mutated in place, never
    // reallocated). `tracker` is combat's own per-slot "last cold hit step"
    // side table (see status.js's header for why it can't live on the
    // Actor record). `actorsSystem`/`step` are refreshed at each call site
    // below, exactly like `resolve()` refreshes `_resolveEnv.source`/`.step`.
    this._statusEnv = {
      actorsSystem: null, rng: this._rng, step: 0, events: ctx.events,
      resultPool: this._resultPool, tracker: createColdHitTracker(),
    };
    // The one place this subsystem reacts to its OWN emitted event (see
    // status.js's header, "onActorDamageForChill") — the chill-accumulation
    // trigger point, since `resolve.js` (accepted, not this ticket's file)
    // never calls it directly.
    this._onActorDamageForChill = (payload) => {
      this._statusEnv.step = ctx.time.step;
      this._statusEnv.actorsSystem = ctx.get('actors');
      onActorDamageForChill(payload, this._statusEnv);
    };
    ctx.events.on('actor:damage', this._onActorDamageForChill);

    // CMBT-6 — R14(i)/(j): death check + the sole `actor:death` emitter,
    // then XP award. A second reaction to this subsystem's own emitted
    // `actor:damage` event, same shape as the chill listener just above —
    // see `xp.js`'s own header for why this hooks `actor:damage` (it sees
    // applyDirect/thorns/DoT kills too) rather than being inlined into
    // `resolve()` below like CMBT-5/CMBT-7's seams.
    this._deathPayload = { actor: null, killer: null, point: { x: 0, y: 0, z: 0 } };
    this._xpGainPayload = { actor: null, amount: 0, source: null };
    this._deathEnv = {
      actorsSystem: null, world: null, events: ctx.events,
      deathPayload: this._deathPayload, xpGainPayload: this._xpGainPayload,
    };
    this._onActorDamageForDeath = (payload) => {
      this._deathEnv.actorsSystem = ctx.get('actors');
      // `world` is NOT one of `combat`'s declared `deps` — `ctx.peek`
      // (never `ctx.get`) so a bare/headless ctx with no `world`
      // subsystem registered degrades to `xp.js`'s own `DEFAULT_DIFFICULTY`
      // instead of throwing.
      this._deathEnv.world = ctx.peek('world');
      handleActorDamageForDeath(payload, this._deathEnv);
    };
    ctx.events.on('actor:damage', this._onActorDamageForDeath);
  }

  _warnPoolExhausted(method) {
    const step = this._ctx && this._ctx.time ? this._ctx.time.step : 0;
    if (step - this._lastPoolWarnStep >= POOL_WARN_STEP_INTERVAL) {
      this._lastPoolWarnStep = step;
      // eslint-disable-next-line no-console
      console.warn(`[combat] ${method}: DamagePacket pool (${PACKET_POOL_CAPACITY}) is exhausted — request dropped`);
    }
  }

  /** CMBT-10/D-59 — resolves `skillId`'s own `weaponDamage`/`flatDamage`
   * curve for `level` into `this._skillCurveScratch` (reused, mutated in
   * place — see the constructor) and returns it. Shared by
   * `buildAttackPacket`/`buildSpellPacket` below so the lookup/arithmetic
   * lives in exactly one place. `skillId`/`level` may describe a basic
   * attack (`null`/`'attack'`/unrecognised) or a spell/skill with no
   * `flatDamage` of its own — both resolve to the pre-CMBT-10 defaults
   * (`weaponDamagePercent = 100`, no flat injection), never a thrown error.
   * @param {string|null|undefined} skillId
   * @param {number} level
   * @returns {{weaponDamagePercent:number, flatElementIndex:number, flatMin:number, flatMax:number}}
   */
  _resolveSkillCurve(skillId, level) {
    const out = this._skillCurveScratch;
    const skillDef = skillRecordFor(skillId);
    out.weaponDamagePercent = weaponDamagePercentFor(skillDef, level);
    if (skillDef && skillDef.flatDamage) {
      out.flatElementIndex = skillFlatElementIndex(skillDef.element);
      const fd = skillDef.flatDamage;
      out.flatMin = fd.minBase + fd.minPerLevel * (level - 1);
      out.flatMax = fd.maxBase + fd.maxPerLevel * (level - 1);
    } else {
      out.flatElementIndex = -1;
      out.flatMin = 0;
      out.flatMax = 0;
    }
    return out;
  }

  /** `02-api-contracts.md` §8: `buildAttackPacket(source, skillId, level,
   * out?) => DamagePacket`. Runs B1-B8 for a weapon-based physical attack —
   * see the file header for the basic-attack-only limitation (gap 1).
   * `out`, when given, is built in place (no pool traffic); otherwise a
   * packet is acquired from the pool, returning `null` if it is dry.
   * @param {object} source an Actor with a composed `.stats`.
   * @param {string|null} [skillId]
   * @param {number} [level]
   * @param {object} [out]
   * @returns {object|null}
   */
  buildAttackPacket(source, skillId, level, out) {
    const packet = out || this._pool.acquire();
    if (!packet) {
      this._warnPoolExhausted('buildAttackPacket');
      return null;
    }
    resetPacketFields(packet);

    const stats = requireStats(source);
    const weapon = resolveWeapon(source);
    const scale = classScaleFor(source.classId);
    const curve = this._resolveSkillCurve(skillId, level); // CMBT-10/D-59

    stepB1(packet, weapon);
    stepB2(packet, curve.weaponDamagePercent);
    stepB3(packet, stats.enhancedDamage);
    stepB4(packet, stats.minDamage, stats.maxDamage);
    stepB5(packet, attributeBonusFor(weapon.handling, stats.strength, stats.dexterity));
    stepB6(packet, scale.meleeScale, stats.physicalDamagePercent);
    stepB7(packet, stats, curve.flatElementIndex, curve.flatMin, curve.flatMax);
    stepB6Elemental(packet, scale.spellScale); // 03 §6.1 B6: elemental damage is always the flatDamage channel — see stepB6Elemental's own header
    stepB8(packet, { stats, source, skillId, level });

    return packet;
  }

  /** `02-api-contracts.md` §8: `buildSpellPacket(source, skillId, level,
   * out?) => DamagePacket`. B1 zeroes physMin/physMax (no weapon
   * contribution) and B5 (attribute bonus) is skipped entirely, per `03
   * §6.1`; B6 uses `spellScale` rather than `meleeScale`. See the file
   * header for the basic-attack-coefficient limitation (gap 1) — no
   * worked example in this ticket's scope exercises this method.
   * @param {object} source an Actor with a composed `.stats`.
   * @param {string|null} [skillId]
   * @param {number} [level]
   * @param {object} [out]
   * @returns {object|null}
   */
  buildSpellPacket(source, skillId, level, out) {
    const packet = out || this._pool.acquire();
    if (!packet) {
      this._warnPoolExhausted('buildSpellPacket');
      return null;
    }
    resetPacketFields(packet);

    const stats = requireStats(source);
    const scale = classScaleFor(source.classId);
    const curve = this._resolveSkillCurve(skillId, level); // CMBT-10/D-59

    stepB1(packet, null); // spells: physMin = physMax = 0
    stepB2(packet, curve.weaponDamagePercent); // a no-op while physMin/physMax are still 0 from B1, harmless if ever nonzero
    stepB3(packet, stats.enhancedDamage);
    stepB4(packet, stats.minDamage, stats.maxDamage);
    // B5 intentionally not called — "skipped entirely for spells" (03 §6.1).
    stepB6(packet, scale.spellScale, stats.physicalDamagePercent);
    stepB7(packet, stats, curve.flatElementIndex, curve.flatMin, curve.flatMax);
    stepB6Elemental(packet, scale.spellScale);
    stepB8(packet, { stats, source, skillId, level });

    return packet;
  }

  /** `02-api-contracts.md` §8: `releasePacket(packet) => void`. */
  releasePacket(packet) {
    this._pool.release(packet);
  }

  /** `02-api-contracts.md` §8: `scratchPacket() => DamagePacket` — a zeroed
   * packet the caller must release. `null` when the pool is dry. */
  scratchPacket() {
    const packet = this._pool.acquire();
    if (!packet) this._warnPoolExhausted('scratchPacket');
    return packet;
  }

  /** `02-api-contracts.md` §8: `attackInterval(actor, skillId) => number`
   * (seconds). See the file header, gap 1 — `skillScale` is fixed at
   * `BASIC_SKILL_SCALE` until a skill table exists.
   * @param {object} actor
   * @param {string} [skillId]
   * @returns {number}
   */
  attackInterval(actor, skillId) {
    const stats = requireStats(actor);
    const weapon = resolveWeapon(actor);
    const scale = classScaleFor(actor.classId);
    return computeAttackInterval(weapon.attackTime, scale.attackScale, BASIC_SKILL_SCALE, stats.increasedAttackSpeed);
  }

  /** `02-api-contracts.md` §8: `castInterval(actor, skillId) => number`
   * (seconds). See the file header, gap 4 — `base` is `DEFAULT_CAST_TIME`,
   * a documented placeholder, until a skill table can supply a real
   * per-`skillId` cast time.
   * @param {object} actor
   * @param {string} [skillId]
   * @returns {number}
   */
  castInterval(actor, skillId) {
    const stats = requireStats(actor);
    const scale = classScaleFor(actor.classId);
    return computeCastInterval(DEFAULT_CAST_TIME, scale.castScale, stats.fasterCastRate);
  }

  /** `02-api-contracts.md` §8: `chanceToHit(attackRating, defense, alvl,
   * dlvl) => number` (5..95) — CMBT-2, `03-combat-math.md` §5.1. The
   * formula itself lives in `./tohit.js`; see this class's own header for
   * why the wiring lives here rather than there. */
  chanceToHit(attackRating, defense, alvl, dlvl) {
    return chanceToHit(attackRating, defense, alvl, dlvl);
  }

  /** `02-api-contracts.md` §8: `blockChanceOf(actor) => number` (0..75, 0
   * without a shield) — CMBT-2, `03-combat-math.md` §5.3. See `chanceToHit`
   * above for the same sibling-file wiring note. */
  blockChanceOf(actor) {
    return blockChanceOf(actor);
  }

  /** `02-api-contracts.md` §8: `resolve(packet, target, out?) => DamageResult`
   * — CMBT-3, `03-combat-math.md` §6.2, R1-R14. The pipeline itself lives in
   * `./resolve.js`; see that file's header for the full reasoning. `out`,
   * when given, is populated in place; otherwise a `DamageResult` is
   * acquired from the pool (`null` if it is dry).
   * @param {object} packet
   * @param {object} target
   * @param {object} [out]
   * @returns {object|null}
   */
  resolve(packet, target, out) {
    const result = out || this._resultPool.acquire();
    if (!result) {
      this._warnPoolExhausted('resolve (DamageResult pool)');
      return null;
    }

    const refScratch = this._sourceRefScratch;
    refScratch.id = packet.sourceId;
    refScratch.generation = packet.sourceGen;
    const actorsSystem = this._ctx.get('actors');
    const source = actorsSystem.resolve(refScratch);

    const env = this._resolveEnv;
    env.source = source;
    env.step = this._ctx.time.step;
    env.actorsSystem = actorsSystem;
    env.isThornsCounter = false;
    env.thornsEnv.actorsSystem = actorsSystem;

    resolveDamage(packet, target, env, result);
    // CMBT-7 — the manaReturnPercent remainder of R14(d) and all of R14(f)
    // (rage gain on both sides, Resonance gain), left as no-op/partial seams
    // inside resolve.js (not this ticket's file): decided and applied here,
    // using the same `env`/`result` resolveDamage() just populated. Must run
    // BEFORE applyReaction() — (d)/(f) precede (g)/(h). See onhit.js's header.
    applyOnHitEconomy(packet, target, result, env);
    // CMBT-5 — R14(g)/(h), left as no-op seams inside resolve.js (not this
    // ticket's file): decided and applied here instead, using the same
    // `env`/`result` resolveDamage() just populated. See reaction.js's
    // header for the full reasoning.
    applyReaction(packet, target, result, env);
    return result;
  }

  /** `02-api-contracts.md` §8: `applyDirect(target, amount, element,
   * sourceId, skillId) => DamageResult` — mitigation-free scripted damage.
   * @param {object} target
   * @param {number} amount
   * @param {string} element
   * @param {number} sourceId
   * @param {string} skillId
   * @param {object} [out]
   * @returns {object|null}
   */
  applyDirect(target, amount, element, sourceId, skillId, out) {
    const result = out || this._resultPool.acquire();
    if (!result) {
      this._warnPoolExhausted('applyDirect (DamageResult pool)');
      return null;
    }

    const actorsSystem = this._ctx.get('actors');
    const env = this._resolveEnv;
    env.source = actorsSystem.byId(sourceId);
    env.actorsSystem = actorsSystem;

    return applyDirectDamage(target, amount, element, sourceId, skillId, env, result);
  }

  /** `02-api-contracts.md` §8: `heal(target, amount, sourceId) => number` —
   * `03-combat-math.md` §6.4. `sourceId` is accepted per the documented
   * signature but not read here — emitting `actor:heal` needs `ctx.events`
   * and is a caller-side concern the same way `vessels.js#addLife` documents
   * for its own `sourceId` parameter. */
  // eslint-disable-next-line no-unused-vars
  heal(target, amount, sourceId) {
    return healTarget(target, amount);
  }

  /** `02-api-contracts.md` §8: `effectiveResist(target, element, pierce) =>
   * number` — post-cap, post-pierce. */
  effectiveResist(target, element, pierce) {
    return effectiveResistOf(target, element, pierce);
  }

  /** `02-api-contracts.md` §8: `isImmune(target, element) => boolean`. */
  isImmune(target, element) {
    return isImmuneOf(target, element);
  }

  /** `02-api-contracts.md` §8: `hitRecoveryTime(actor) => number` (seconds)
   * — CMBT-5, `03-combat-math.md` §7.11. The formula itself lives in
   * `./reaction.js`; see that file's header for the same sibling-file
   * wiring note `chanceToHit`/`blockChanceOf` above already establish.
   * @param {object} actor
   * @returns {number}
   */
  hitRecoveryTime(actor) {
    const stats = requireStats(actor);
    return computeHitRecoveryTime(stats.fasterHitRecovery);
  }

  /** `02-api-contracts.md` §8: `applyStatusFromPacket(packet, target, result)
   * => void` — CMBT-4, `03-combat-math.md` §7. See `status.js`'s own header
   * for why this is a standalone method, not a second call into
   * `resolve.js`'s own inline R14(b)/(c). */
  applyStatusFromPacket(packet, target, result) {
    this._statusEnv.step = this._ctx.time.step;
    this._statusEnv.actorsSystem = this._ctx.get('actors');
    applyStatusFromPacket(packet, target, result, this._statusEnv);
  }

  /** `02-api-contracts.md` §8: `expireBySource(sourceId, sourceGen, status)
   * => int expired` — CMBT-4. See `status.js#expireBySourceAcrossActors`'s
   * own header for how this differs from `actors`' single-actor method of
   * the same name. */
  expireBySource(sourceId, sourceGen, status) {
    this._statusEnv.actorsSystem = this._ctx.get('actors');
    return expireBySourceAcrossActors(sourceId, sourceGen, status ?? null, this._statusEnv);
  }

  /** `02-api-contracts.md` §8: `xpForMonster(mlvl, rank, baseXp, clvl,
   * difficulty) => int` — CMBT-6, `03-combat-math.md` §10.5. The formula
   * itself lives in `./xp.js`; see that file's header for the same
   * sibling-file wiring note `chanceToHit`/`blockChanceOf` above already
   * establish. */
  xpForMonster(mlvl, rank, baseXp, clvl, difficulty) {
    return xpForMonster(mlvl, rank, baseXp, clvl, difficulty);
  }

  /** `02-api-contracts.md` §8: `awardXp(killer, victim) => int` — CMBT-6.
   * Resolves `difficulty` off `ctx.peek('world')` (not a declared `deps`
   * entry — degrades to `xp.js`'s `DEFAULT_DIFFICULTY` when absent) and
   * emits `xp:gain` through the same preallocated scratch the death-check
   * listener uses. See `xp.js#awardXp`'s own doc comment.
   * @param {object} killer
   * @param {object} victim
   * @returns {number} int
   */
  awardXp(killer, victim) {
    const world = this._ctx.peek('world');
    const difficulty = world && world.current ? world.current.difficulty : DEFAULT_DIFFICULTY;
    return awardXp(killer, victim, difficulty, this._ctx.events, this._xpGainPayload);
  }

  /** `ARCHITECTURE.md` rule 5 / `02-api-contracts.md`: CMBT-4's DoT tick
   * cadence — 4 Hz (15 steps) for burning/poisoned, 2 Hz (30 steps) for
   * bleeding, scheduled purely against `ctx.time.step`. See
   * `status.js#runDotTicks`. */
  fixedUpdate(h, ctx) {
    this._statusEnv.step = ctx.time.step;
    this._statusEnv.actorsSystem = ctx.get('actors');
    runDotTicks(this._statusEnv);
  }

  dispose() {
    if (this._ctx) {
      this._ctx.events.off('combat:hit-request', this._onHitRequest);
      this._ctx.events.off('actor:damage', this._onActorDamageForChill);
      this._ctx.events.off('actor:damage', this._onActorDamageForDeath);
    }
    this._ctx = null;
    this._pool = null;
    this._resultPool = null;
    this._rng = null;
    this._sourceRefScratch = null;
    this._statusSpecScratch = null;
    this._damagePayloadScratch = null;
    this._resolveEnv = null;
    this._hitRequestResultScratch = null;
    this._onHitRequest = null;
    this._statusEnv = null;
    this._onActorDamageForChill = null;
    this._deathPayload = null;
    this._xpGainPayload = null;
    this._deathEnv = null;
    this._onActorDamageForDeath = null;
  }
}
