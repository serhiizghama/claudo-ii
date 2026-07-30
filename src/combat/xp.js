// src/combat/xp.js
//
// CMBT-6 — the last two R14 seams `resolve.js` (CMBT-3) deliberately left
// open, closing the CMBT combat chain: (i) the death check and the sole
// `actor:death` emitter in the tree, and (j) `03-combat-math.md` §10.5's
// XP award (`xpForMonster`/`awardXp`, `02-api-contracts.md` §8).
//
// O-51's assembly rule: this file exports plain functions/data and imports
// nothing from `./packet.js`. It DOES import two small pieces from
// `./onhit.js` (`BASE_RAGE_ON_KILL`, `addResourceClamped`) — a sibling-to-
// sibling import, which `status.js`'s own header already establishes as
// fine within `src/combat/` (only a *back*-import into `packet.js` would
// create the cycle O-51 forbids). `onhit.js`'s own header names exactly
// this reuse: "BASE_RAGE_ON_KILL... kept as a documented constant... for
// whichever ticket wires the kill-credit event" — that ticket is this one.
// `packet.js` imports this file and wires `handleActorDamageForDeath` as a
// SECOND listener on `ctx.events`'s `actor:damage` bucket, registered in
// `CombatSystem.init()` right after CMBT-4's own chill listener, plus
// attaches `xpForMonster`/`awardXp` to the class surface — see that file's
// own "CMBT-6" comment block.
//
// ---------------------------------------------------------------------------
// Why `actor:damage`, not a `CombatSystem#resolve()` call site
// ---------------------------------------------------------------------------
// This ticket's brief says CMBT-5/CMBT-7 were "both wired from
// packet.js#resolve() rather than by editing resolve.js" and to follow
// that precedent "exactly" — but `resolve.js`'s own R14(a) computes
// `out.killed` as a plain byproduct for EVERY path that ends in
// `resolve.js`'s shared `emitDamageEvent` / `status.js`'s `emitDotTick`,
// not only the normal hit path `CombatSystem#resolve()` drives. Three
// other paths reach that same emit without ever calling
// `CombatSystem#resolve()`:
//   - `CombatSystem#applyDirect()` (packet.js, already implemented;
//     mitigation-free scripted/environmental damage) — `resolve.js`'s own
//     `applyDirectDamage` computes `out.killed` and calls `emitDamageEvent`
//     directly.
//   - The R14(e) thorns counter-hit — `resolve.js` calls `resolveDamage()`
//     on the counter-packet directly, bypassing `CombatSystem#resolve()`
//     entirely (`onhit.js`'s and `reaction.js`'s own headers already
//     document this exact bypass for their own seams).
//   - DoT ticks — `status.js#runDotTicks` -> `tickActorDots` ->
//     `applyOneDotTick` -> `emitDotTick`, which computes `killed` itself
//     and states outright: "It can kill, and it credits the original
//     sourceId for XP... XP crediting is CMBT-6's own seam" (`status.js`,
//     verbatim, right above `applyOneDotTick`).
// All four paths funnel through the one event `ARCHITECTURE.md` already
// documents as combat's own emission point: `actor:damage`. Subscribing
// there — the exact shape CMBT-4's own `onActorDamageForChill` already
// established for "combat's own math needs to run after a damage event,
// but the call site that produces it is not this ticket's file" — is the
// only single wiring point that observes every one of the four kill paths.
// Inlining into `CombatSystem#resolve()` alone (the literal reading of
// "wired from resolve()") would silently miss applyDirect/thorns/DoT
// kills — status.js's own comment is an explicit, textual instruction that
// DoT kills ARE in this ticket's scope, so that narrower reading is
// rejected here. Flagged in this ticket's report as a deliberate deviation
// from the literal instruction, not an oversight.
//
// ---------------------------------------------------------------------------
// A pre-existing ordering quirk this ticket inherits, not introduces
// ---------------------------------------------------------------------------
// `resolve.js`'s own R14(k) (`emitDamageEvent`) fires INSIDE
// `resolveDamage()`, before `CombatSystem#resolve()` (packet.js) even
// returns from that call — but `applyOnHitEconomy` (CMBT-7, R14(d)
// remainder/(f)) and `applyReaction` (CMBT-5, R14(g)/(h)) both run AFTER
// `resolveDamage()` returns, i.e. AFTER `actor:damage` (and now this
// file's `actor:death`/`xp:gain`) has already fired. So in the REAL call
// order, this file's listener runs BEFORE R14(f)'s "+6 landed hit" rage
// credit is applied, even though the lettered spec order (and onhit.js's
// own header: "this ticket runs BEFORE CMBT-6 so the on-hit credit paths
// settle first") both assume the opposite. Both are plain additions to a
// clamped resource, so the FINAL value is identical unless the sum crosses
// `maxRage` — in that one case, which credit "wins" the clamp depends on
// this pre-existing call order, not on anything below. Noticed, not fixed
// here — `packet.js#resolve()`'s own call sequence (not this ticket's
// file to redesign) is what would need reordering, and every sibling
// ticket to date (CMBT-4/5/7) already inherits the identical quirk for its
// own `actor:damage`-triggered logic.
//
// ---------------------------------------------------------------------------
// The exclusivity criterion — this file is the ONLY `actor:death` emitter
// ---------------------------------------------------------------------------
// `grep -rn "actor:death" src/` shows exactly one `events.emit(...)` call
// in the whole tree, and it is in this file (see this ticket's report for
// the literal output). `handleActorDamageForDeath` below guards on
// `!target.dead` before ever emitting, and sets `target.dead = true`
// synchronously before emitting — R1's own `isValidTarget` (already
// accepted, `resolve.js`) already refuses a `target.dead` actor as a hit
// target (`outcome: 'invalid', no event`), so a genuinely later hit on a
// corpse never reaches `emitDamageEvent` at all, and this file's listener
// never runs a second time for that target through the normal pipeline.
// The `target.dead` guard here is the second, independent line of
// defence — for `applyDirect`/DoT paths, which check `target.dead`
// themselves (`resolve.js#applyDirectDamage`, `status.js#tickActorDots`)
// but reach this file through the SAME shared listener as the normal
// path, and for direct/duplicate-emission robustness in general.
//
// ---------------------------------------------------------------------------
// `target.dead`/`target.killerId` — plain field writes, matching
// `resolve.js`'s own discipline
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md` rule 2 forbids importing `src/actors/`; `resolve.js`'s
// own R14(a)/(d) already write `target.life`/`source.life`/`.mana` as
// plain Actor-record fields rather than calling into `actors`, for exactly
// this reason. This file follows the identical discipline for the two
// fields `01-data-model.md` §2 already reserves for this exact moment:
// `dead` and `killerId` ("set once on death"). `ActorsSystem` has no
// `kill()` method and no `actor:death` listener anywhere in `src/actors/`
// today (verified: `grep -rn "kill\|actor:death" src/actors/` turns up
// nothing) — `ARCHITECTURE.md` §7's "`actors.kill()` routes through
// combat" is therefore NOT a routing this file builds (`src/actors/
// index.js` is not this ticket's file — the brief is explicit: say so,
// don't build it). A full state-machine transition (`ACTOR_STATE.dead`,
// the `corpse` flag, a despawn timer) is `src/actors/action.js`'s /
// `src/ai/`'s territory and stays a documented gap — flagged in this
// ticket's report.
//
// ---------------------------------------------------------------------------
// `xpForMonster` — 03-combat-math.md §10.5, exactly the 5-arg
// `02-api-contracts.md` §8 signature; no `experienceGain` term
// ---------------------------------------------------------------------------
// §10.5's own formula block (and `11-flows.md`'s identical restatement)
// includes a trailing `x (1 + experienceGain/100)` factor — but
// `xpForMonster`'s contract signature is exactly `(mlvl, rank, baseXp,
// clvl, difficulty)`, no `experienceGain` parameter, and this ticket's own
// E10 worked-example formula (given verbatim in the brief) omits that
// factor entirely. `11-flows.md`'s own sequence sketch resolves the
// apparent conflict: "combat R14(j) --> xp:gain { actor, amount, source }
// | experience += amount x (1 + experienceGain/100)" — the multiplier is
// applied by `xp:gain`'s LISTENER (`player`, accumulating `experience`),
// not by `combat` computing it. `xpForMonster` below is therefore the
// complete formula for combat's part of the pipeline; all eight E10 rows
// (`experienceGain` implicitly 0 for every one) confirm this reading
// numerically. Flagged in this ticket's report as a read beyond the
// ticket's literal line-range list (`11-flows.md` isn't on it, isn't on
// the do-not-read list either) — necessary to resolve a real ambiguity the
// listed lines alone left open.
//
// ---------------------------------------------------------------------------
// `xpMult(mlvl)` — read from 03 §10.1, one section above this ticket's
// assigned range
// ---------------------------------------------------------------------------
// `03-combat-math.md` lines 1009-1057 (this ticket's assigned range for
// "the tier multipliers §10.5 consumes") give `rankXpMult`/
// `difficultyXpMult` directly, and lines 1097-1139 give the `xp = ...`
// formula itself — but that formula NAMES `xpMult(mlvl)` without defining
// it. The curve (`xpMult(n) = 1 + 0.3200(n-1) + 0.01600(n-1)^2`) lives in
// §10.1, lines 953-956, one short section above the assigned 1009-1057
// range and not itself listed. Excluding it would make `xpForMonster`
// uncomputable and the acceptance criterion (E10 exact) unsatisfiable, so
// it was read anyway — flagged here rather than silently included.
// `04-items.md`, `05-skills.md`, `06-monsters-ai.md` were NOT read, per
// the brief.
//
// ---------------------------------------------------------------------------
// `baseXp` — missing from the Actor record; a documented, forward-
// compatible gap
// ---------------------------------------------------------------------------
// `01-data-model.md` §2's Actor record (and `src/actors/pool.js
// #createActorRecord`, checked field for field) has no `baseXp` field — a
// monster's base XP lives only in the bestiary (`03-combat-math.md` §9.1,
// `06-monsters-ai.md` territory), and no bestiary table exists anywhere in
// `src/` yet (`src/ai/` doesn't exist — verified). `awardXp` below reads
// `victim.baseXp` defensively (`Number.isFinite(...) ? ... : 0`) — forward
// compatible with a future `ai`/bestiary ticket populating it on spawn,
// the same "read a field a future system will populate, default safely
// today" discipline `packet.js`'s own header already uses for
// `source.equipment.mainHand`. Until that ticket lands, a real monster
// kill's `awardXp` returns the `max(1, ...)` floor (1) regardless of the
// monster — flagged in this ticket's report as missing data, not a bug in
// the formula (`xpForMonster` itself, given a real `baseXp`, is exact —
// see E10).
//
// ---------------------------------------------------------------------------
// `point` on `actor:death` — inferred shape
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md`'s event table gives `actor:death { actor, killer,
// point }` without defining `point`'s shape. `DamageResult` (`resolve.js`)
// uses flat `pointX/pointY/pointZ`, but a bare, un-prefixed `point` field
// (the same name `skill:cast`'s payload uses) reads as a small vector
// object. This file preallocates ONE `{ x, y, z }` scratch (never
// reallocated — rule 5/allocation discipline) and fills it from the dying
// actor's own position (`target.x/y/z`) — the death location, not the
// original hit's origin, which is the more useful figure for fx/audio and
// is available uniformly across all four kill paths (thorns/applyDirect/
// DoT never populate `result.pointX/Y/Z` — only the normal hit path
// does). Flagged in this ticket's report as an inference, matching the
// discipline `packet.js`'s own header already used for the critChance/
// critMult inference.
//
// Zero-allocation: `handleActorDamageForDeath`/`awardXp` take plain
// objects already in scope and mutate preallocated scratch (`env.
// deathPayload`, its nested `.point`, `env.xpGainPayload`) — nothing here
// is ever constructed.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file. No `Math.random()` — this file draws nothing.

import { BASE_RAGE_ON_KILL, addResourceClamped } from './onhit.js';

// ---------------------------------------------------------------------------
// Data — 03-combat-math.md §10.1/§10.2/§10.5 (rule 6: gameplay numbers live
// in data, not literals)
// ---------------------------------------------------------------------------

/** `03 §10.1`: `xpMult(n) = 1 + 0.3200(n-1) + 0.01600(n-1)^2`. See the file
 * header for why this curve (defined one section above this ticket's
 * assigned reading range) is needed anyway. */
export const XP_MULT_LINEAR = 0.3200;
export const XP_MULT_QUADRATIC = 0.01600;

/** `03 §10.5`'s own Rank table — `rankXpMult`. */
export const RANK_XP_MULT = Object.freeze({
  normal: 1.0,
  minion: 1.5,
  champion: 3.0,
  unique: 6.0,
  boss: 1.0,
});

/** `03 §10.2`: Difficulty tiers' XP × column — `difficultyXpMult`. */
export const DIFFICULTY_XP_MULT = Object.freeze({
  instruction: 1.00,
  trial: 1.20,
  renunciation: 1.45,
});

/** `src/world/index.js`'s own default (`opts.difficulty || 'instruction'`) —
 * reused here so a killer with no live `world` zone (a headless test, or a
 * scripted kill before any zone is entered) still gets a defined answer. */
export const DEFAULT_DIFFICULTY = 'instruction';

/** `03 §10.5`: level-penalty pieces. */
export const LEVEL_PENALTY_FREE_DELTA = 4;
export const LEVEL_PENALTY_PER_LEVEL = 0.09;
export const LEVEL_PENALTY_FLOOR = 0.05;

// ---------------------------------------------------------------------------
// Pure formulas — each independently testable, matching resolve.js's own
// granular per-step export style (stepR7a/b/c, resistAfterPierce, ...).
// ---------------------------------------------------------------------------

/** `03 §10.1`: the monster mlvl-scaling XP curve.
 * @param {number} mlvl
 * @returns {number}
 */
export function xpMultOf(mlvl) {
  const n1 = mlvl - 1;
  return 1 + XP_MULT_LINEAR * n1 + XP_MULT_QUADRATIC * n1 * n1;
}

/** `03 §10.5`: `levelPenalty = (clvl - mlvl <= 4) ? 1.0 : max(0.05, 1 -
 * 0.09 x (clvl - mlvl - 4))`.
 * @param {number} clvl
 * @param {number} mlvl
 * @returns {number}
 */
export function levelPenaltyOf(clvl, mlvl) {
  const delta = clvl - mlvl;
  if (delta <= LEVEL_PENALTY_FREE_DELTA) return 1.0;
  return Math.max(LEVEL_PENALTY_FLOOR, 1 - LEVEL_PENALTY_PER_LEVEL * (delta - LEVEL_PENALTY_FREE_DELTA));
}

/** The full raw product BEFORE `max(1, round(...))` — exported so tests
 * (and this ticket's own report) can show the pre-floor/pre-round value
 * next to the final one, per the brief's rule 12.
 * @param {number} mlvl
 * @param {string} rank
 * @param {number} baseXp
 * @param {number} clvl
 * @param {string} difficulty
 * @returns {number}
 */
export function rawXpFor(mlvl, rank, baseXp, clvl, difficulty) {
  const rankMult = RANK_XP_MULT[rank] ?? 1.0;
  const diffMult = DIFFICULTY_XP_MULT[difficulty] ?? 1.0;
  return baseXp * xpMultOf(mlvl) * rankMult * diffMult * levelPenaltyOf(clvl, mlvl);
}

/** `02-api-contracts.md` §8: `xpForMonster(mlvl, rank, baseXp, clvl,
 * difficulty) => int` — `03-combat-math.md` §10.5, verbatim.
 * @param {number} mlvl
 * @param {string} rank
 * @param {number} baseXp
 * @param {number} clvl
 * @param {string} difficulty
 * @returns {number} int
 */
export function xpForMonster(mlvl, rank, baseXp, clvl, difficulty) {
  return Math.max(1, Math.round(rawXpFor(mlvl, rank, baseXp, clvl, difficulty)));
}

// ---------------------------------------------------------------------------
// awardXp — 02-api-contracts.md §8: `awardXp(killer, victim) => int`
// ---------------------------------------------------------------------------

/**
 * Computes the XP a `killer` earns for `victim` and, when both a real
 * killer and a positive amount exist, emits `xp:gain { actor, amount,
 * source }` (`actor` = the killer/gainer, `source` = the monster killed —
 * see `11-flows.md`'s own "combat R14(j) --> xp:gain" sketch). Takes
 * `difficulty`/`events`/`xpGainPayload` as explicit parameters (not `ctx`)
 * so this file stays a plain, Node-testable pure-function module —
 * `CombatSystem#awardXp` (packet.js) is the thin ctx-aware wrapper that
 * supplies them, matching `hitRecoveryTime`/`chanceToHit`'s own precedent.
 * @param {object} killer an Actor — `.level` read as clvl.
 * @param {object} victim an Actor — `.level`/`.rank`/`.baseXp` read as
 *   mlvl/rank/baseXp (`baseXp` defensively defaulted to 0 — see the file
 *   header's "baseXp is missing from the Actor record" note).
 * @param {string} [difficulty] defaults to `DEFAULT_DIFFICULTY`.
 * @param {object} [events] `ctx.events`, for the `xp:gain` emit.
 * @param {object} [xpGainPayload] preallocated `{ actor, amount, source }`
 *   scratch, reused every call — never constructed here.
 * @returns {number} int — the amount granted.
 */
export function awardXp(killer, victim, difficulty, events, xpGainPayload) {
  if (!killer || !victim) return 0;
  const baseXp = Number.isFinite(victim.baseXp) ? victim.baseXp : 0;
  const amount = xpForMonster(victim.level, victim.rank, baseXp, killer.level, difficulty || DEFAULT_DIFFICULTY);
  if (amount > 0 && events && xpGainPayload) {
    xpGainPayload.actor = killer;
    xpGainPayload.amount = amount;
    xpGainPayload.source = victim;
    events.emit('xp:gain', xpGainPayload);
  }
  return amount;
}

// ---------------------------------------------------------------------------
// R14(i)/(j) orchestrator — see the file header for why this hooks
// `actor:damage` rather than a `CombatSystem#resolve()` call site.
// ---------------------------------------------------------------------------

/**
 * `env` — built once by `CombatSystem` (packet.js's wiring), mutated in
 * place before each `actor:damage` dispatch:
 *   actorsSystem:  ctx.get('actors') — for the killer lookup (`byId`,
 *                  generation-safe by construction — see `pool.js`'s own
 *                  id-encodes-generation header note)
 *   world:         ctx.peek('world') — `null`/`undefined` when no world
 *                  subsystem is registered (a bare unit-test ctx); NOT
 *                  `ctx.get`, since `world` is not one of `combat`'s
 *                  declared `deps` and must not throw when absent
 *   events:        ctx.events
 *   deathPayload:  reusable `{ actor, killer, point: {x,y,z} }` scratch
 *                  for the `actor:death` emit
 *   xpGainPayload: reusable `{ actor, amount, source }` scratch, passed
 *                  straight through to `awardXp`
 * @param {{target: object, source: object|null, result: object}} payload
 *   the same object `actor:damage`'s own emitters build (`resolve.js`'s
 *   `emitDamageEvent`, `status.js`'s `emitDotTick`).
 * @param {object} env see above.
 */
export function handleActorDamageForDeath(payload, env) {
  const result = payload ? payload.result : null;
  const target = payload ? payload.target : null;
  if (!result || !result.killed || !target || target.dead) return;

  // (i) death check — the actor:death emitter of record. Setting `dead`
  // BEFORE emitting is what stops a second kill event for this actor: R1's
  // `isValidTarget` (resolve.js) already refuses a `dead` target for every
  // future hit-request, and this same guard (`target.dead` above) refuses
  // a same-frame duplicate reaching this far in the first place.
  target.dead = true;

  const actorsSystem = env.actorsSystem;
  const killer = actorsSystem && result.sourceId ? actorsSystem.byId(result.sourceId) : null;
  target.killerId = killer ? killer.id : 0;

  // "Kill credited | +8" (03 §2.4) — onhit.js's own documented,
  // deliberately-unapplied constant, wired here per this ticket's brief.
  if (killer && !killer.dead && killer.stats) {
    addResourceClamped(killer, 'rage', BASE_RAGE_ON_KILL, killer.stats.maxRage);
  }

  const deathPayload = env.deathPayload;
  deathPayload.actor = target;
  deathPayload.killer = killer;
  const point = deathPayload.point;
  point.x = target.x;
  point.y = target.y;
  point.z = target.z;
  if (env.events) env.events.emit('actor:death', deathPayload);

  // (j) XP award — only when a real killer resolved; see the file header,
  // "baseXp is missing" and awardXp's own doc comment.
  if (killer) {
    const world = env.world;
    const difficulty = world && world.current ? world.current.difficulty : DEFAULT_DIFFICULTY;
    awardXp(killer, target, difficulty, env.events, env.xpGainPayload);
  }
}
