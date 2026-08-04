// src/player/cast.js
//
// PLYR-3 — hotbar, cast orders, targeting (docs/spec/11-flows.md §5, the
// casting/targeting flow; `05-skills.md` §1.4's five-mode table and its four
// universal rules; `02-api-contracts.md` §13's `castOrder`/`hotbar`/
// `setHotbar` rows). `src/player/index.js` owns the intent latch and the
// ladder dispatch (PLYR-1/2's own precedent); this file owns everything
// downstream of "a cast order has a hotbar slot and a target" — resolving
// the skill's `target` mode, walking into range when the mode allows it,
// calling `skills.canCast`/`cast`, and reporting a refusal reason. Same
// division of labour `./move.js` (`PathFollower`) already established for
// move orders: `PlayerSystem.castOrder`/`_followCast` are thin wiring into
// the `CastController` class below.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`.
// No `Math.random()` — nothing here draws randomness.
//
// ---------------------------------------------------------------------------
// The five targeting modes, and where each rule in `05-skills.md` §1.4 lives
// ---------------------------------------------------------------------------
// | `target`    | Walks into range?                          | Held button          |
// |-------------|---------------------------------------------|-----------------------|
// | `none`      | no                                           | one press = one use  |
// | `self`      | no                                           | one use per press     |
// | `point`     | only if `def.range` is declared and the      | repeats while the     |
// |             | point is beyond it                           | resource lasts        |
// | `actor`     | yes — walks to weapon range, swings on       | repeats on the same   |
// |             | arrival                                      | target                |
// | `direction` | no                                            | repeats in place      |
//
// Rule 1 ("a refused cast never moves the character") holds structurally
// here: `_attempt` below calls `skills.canCast()` FIRST, before any
// `player.moveOrder()` call. The one exception that is NOT a violation:
// `point` mode's own `no-path` reason IS the walk trigger (`canCast()`
// already computes it — `05-skills.md`'s own text: "point: ... only if the
// skill declares a maximum range and the point is beyond it"), and
// `actor` mode's own range gate is checked only AFTER `canCast()` already
// said `ok` (i.e. cooldown/resource/busy/unallocated are all fine) — so by
// the time either mode issues a `moveOrder`, the cast is NOT refused, it is
// "not yet in range", exactly the table's own distinction.
//
// `11-flows.md` §5.2, verbatim, is the tie-breaker between this file's
// simpler five-row table and the fuller behaviour: "Out of range on point /
// actor and Shift not held -> the order becomes a move order toward the
// target, re-evaluating canCast every step until in range; the cast fires
// the first step it succeeds. With Shift held the cast is refused with
// `_feedback = 'out_of_range'` and nothing moves." That is exactly what
// `_attempt` implements.
//
// ---------------------------------------------------------------------------
// "Repeats" — how held-button repetition works without a per-mode timer
// ---------------------------------------------------------------------------
// `step()` calls `_attempt()` every fixed step for as long as the order is
// `active`. Two things end it: `_oneShot` (`none`/`self` — always exactly
// one attempt) and `!deps.held` (a private field `PlayerSystem` latches
// every `update()` from the physical RMB/1-4 state — never read here from
// `ctx.input` directly, matching the file's own "fixedUpdate never reads
// ctx.input" rule) — but ONLY once `_attempt()` has actually resolved to
// `'cast'` or a terminal `'refused'`. A `'walking'` result (still closing
// range) is NOT a resolution and is never gated on `held` — see `step()`'s
// own comment: an un-held single click on an `actor`/`point` skill still
// has to be allowed to finish walking into range and fire once, or a plain
// click would never complete at all. No extra bookkeeping is needed for
// "wait for cooldown, then fire again" once in range: a cast that just
// started puts the actor into an action (`actor.actionId !== null`), which
// makes every subsequent `canCast()` call refuse with `'busy'` until the
// action completes, and the held loop simply keeps re-trying (a cheap,
// allocation-free failure) until it stops being busy — the same technique
// `05-skills.md`'s "repeats" text describes, without a duplicate copy of
// `actors`' own action clock.
//
// A UI hotbar click (`ui/hotbar.js#pressSlot` -> `player.castOrder(...)`
// directly, not through the RMB/1-4 latch) carries no "held" concept at
// all — `deps.held` reads whatever the CURRENT physical input state happens
// to be (almost always `false`, since no key is actually down), so a mouse
// click on the hotbar icon does exactly one attempt and stops. This is a
// deliberate, reasonable reading of a contract that gives `castOrder` no
// `held` parameter at all (`02-api-contracts.md:1168`) — see this ticket's
// report.
//
// ---------------------------------------------------------------------------
// `none`/`self` — never repeat, regardless of `held`
// ---------------------------------------------------------------------------
// "one press = one use" / "one use per press" (05 §1.4's own words for both
// rows) — `_oneShot` below forces exactly one `_attempt()` then
// deactivates, whatever the outcome and whatever `deps.held` says.
//
// ---------------------------------------------------------------------------
// Weapon range for `actor` mode — a real, reachable gap, not fabricated
// ---------------------------------------------------------------------------
// `11-flows.md` §3.6 step 3 gives the exact formula: `range =
// items.weaponOf(actor).weapon.range` (unarmed: 1.4 m).
//
// PLYR-3 shipped against a broken half of that formula and said so: `items`'
// `_cache.weapon` view carried `minDamage`/`maxDamage`/`attackTime`/
// `handling` but never `range`, so `weaponRangeOf` fell back to the unarmed
// literal for EVERY actor no matter what it held. That gap became O-94's
// cause 1 — the M4 gate's "each class clears the test room" was measuring
// reach, not damage, with monsters standing at 1.6 m and every class swinging
// at 1.4 m. Closed 2026-08-04 in `src/items/equipment.js#refreshWeaponCache`
// (one line, plus `range` in the preallocated view's shape).
//
// `weaponRangeOf` below is unchanged and still reads the field defensively —
// a normal "this field may be absent from the data" check, not an O-27/O-39
// "assert the method doesn't exist" guard — because the unarmed pseudo-weapon
// legitimately has no `_cache` at all.
//
// ---------------------------------------------------------------------------
// Zero-allocation discipline
// ---------------------------------------------------------------------------
// One `CastController` per `PlayerSystem`, constructed once, reused for
// every order (rule 5/6) — every scratch object below is a constructor
// field. `_approachScratch` is the one reused `{x,z}` output of
// `computeApproachPoint`.

/** `01-data-model.md` §6.4 — the `Hotbar` record. Preallocated; every array
 * is fixed-length and mutated in place by `setHotbar`, never replaced. */
export function createHotbar() {
  return {
    slots: [null, null, null, null],
    rightMouse: 0, // int 0..3, or -1 = 'attack' — see 01-data-model.md §6.4
    leftMouse: -1, // -1 = move/attack (the D2 default)
    beltKeys: [0, 1, 2, 3],
  };
}

export const HOTBAR_SLOT_COUNT = 4;

/** `01-data-model.md` §1.2, `TEAM.neutral`. Not reachable via `actors`'
 * public surface (`02-api-contracts.md` §7 has no `TEAM` export) — same
 * "hardcode the one field, cite the source" precedent
 * `src/player/index.js#PLACEHOLDER_TEAM` already set for `TEAM.player`. */
const TEAM_NEUTRAL = 2;

/** `01-data-model.md` §2.1, `ACTOR_FLAG.untargetable` (`1 << 1`). Same
 * not-exposed-via-contract situation as `TEAM_NEUTRAL` above. */
const ACTOR_FLAG_UNTARGETABLE = 1 << 1;

/** `11-flows.md` §3.6 step 3, verbatim: "range = items.weaponOf(actor).
 * weapon.range (unarmed: 1.4 m)". The fallback for an actor with nothing in
 * `mainHand`; an equipped weapon now carries its own reach (O-94 cause 1
 * closed the `items` gap this file's header used to describe). */
export const UNARMED_RANGE_M = 1.4;

/** `11-flows.md` §3.6's own chase-destination formula: `dest = target.pos -
 * normalize(target.pos - actor.pos) x (range - 0.10)` — stop just inside
 * weapon range, not exactly on its edge. */
const ACTOR_RANGE_STANDOFF_M = 0.10;

/** ASSIGNED — no spec range gives a standoff for `point` mode's own
 * approach point (only `actor` mode's `0.10` is a real spec number, §3.6).
 * A `point`-mode chase walks to `def.range` minus this small buffer so the
 * actor lands strictly inside `canCast()`'s own `> def.range` boundary
 * rather than exactly on it, where per-step floating point / PathFollower's
 * own `arriveRadius` could leave it flickering across the line. Revisit if
 * a real number ever gets attached to this in the spec. */
const POINT_RANGE_STANDOFF_M = 0.15;

/** `11-flows.md` §3.6's own moving-target hysteresis: re-path only when the
 * destination has moved more than this far, or this many steps have
 * elapsed — reused here verbatim for `actor`-mode skill casts (the table
 * gives no separate number for a skill chase, and the mechanism is
 * identical: "don't repath every step chasing a moving target"). */
const CHASE_REPATH_DIST_M = 1.5;
const CHASE_REPATH_STEPS = 15;

/**
 * `a.team !== b.team && a.team !== TEAM.neutral && b.team !== TEAM.neutral`
 * — `01-data-model.md` §1.2's hostility test, verbatim.
 * @param {object} a @param {object} b @returns {boolean}
 */
export function isHostile(a, b) {
  return a.team !== b.team && a.team !== TEAM_NEUTRAL && b.team !== TEAM_NEUTRAL;
}

/**
 * `05-skills.md` §1.4's `actor` mode: "a live, hostile, targetable
 * ActorRef". `target` may be `null` (a stale/dead id).
 * @param {object} caster @param {object|null} target
 * @returns {boolean}
 */
export function isValidCastTarget(caster, target) {
  if (!target || target.dead) return false;
  if ((target.flags & ACTOR_FLAG_UNTARGETABLE) !== 0) return false;
  return isHostile(caster, target);
}

/**
 * See the file header, "Weapon range for `actor` mode".
 * @param {object|null} items `ctx.peek('items')` — may be absent
 * @param {object} actor
 * @returns {number} metres
 */
export function weaponRangeOf(items, actor) {
  if (!items || typeof items.weaponOf !== 'function') return UNARMED_RANGE_M;
  const weapon = items.weaponOf(actor);
  const cached = weapon && weapon._cache && weapon._cache.weapon;
  if (cached && typeof cached.range === 'number') return cached.range;
  return UNARMED_RANGE_M;
}

/**
 * A point `standoff` metres back from `(toX,toZ)` along the line from
 * `(fromX,fromZ)` to it — `11-flows.md` §3.6's own formula, generalised to
 * any standoff (this file's `point`-mode use reuses it with
 * `POINT_RANGE_STANDOFF_M`). Writes into `out`, returns it.
 * @param {number} fromX @param {number} fromZ
 * @param {number} toX @param {number} toZ
 * @param {number} standoff
 * @param {{x:number,z:number}} out
 * @returns {{x:number,z:number}}
 */
export function computeApproachPoint(fromX, fromZ, toX, toZ, standoff, out) {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const dist = Math.sqrt(dx * dx + dz * dz); // never Math.hypot — rule 5
  if (dist <= standoff || dist < 1e-6) {
    out.x = fromX;
    out.z = fromZ;
    return out;
  }
  const t = (dist - standoff) / dist;
  out.x = fromX + dx * t;
  out.z = fromZ + dz * t;
  return out;
}

/** `ctx.peek('audio')`-guarded `player.cast.fail` (`10-audio.md:935`) — see
 * O-69 (`render.screenImpulse`/`player.cameraShake`) for the identical
 * "the whole SUBSYSTEM doesn't exist yet, not just one of its methods"
 * guard. `src/audio/` has no ticket yet — `ctx.peek('audio')` is always
 * `undefined` today; this is future-proofing, not dead code exercised now.
 * @param {object|null} audio
 */
function playCastFailSfx(audio) {
  if (audio && typeof audio.play === 'function') audio.play('player.cast.fail', null);
}

/**
 * One reusable order controller — see the file header for the full design.
 */
export class CastController {
  constructor() {
    this._active = false;
    this._oneShot = false;
    this._hotbarIndex = -1;
    this._skillId = null;
    this._mode = null;
    this._x = 0;
    this._z = 0;
    this._targetId = 0;

    /** Whether THIS controller currently owns the player's move order (a
     * range-closing chase it started itself) — only ever released via
     * `player.stop()` when it is the one holding it, never someone else's
     * order. */
    this._chasing = false;
    this._chaseDestX = 0;
    this._chaseDestZ = 0;
    this._chaseIssuedStep = -1;

    this._refusalReason = null;
    this._lastResult = 'idle'; // 'idle' | 'walking' | 'cast' | 'refused'

    // Reused scratch — zero allocation per tick (rule 5/6).
    this._approachScratch = { x: 0, z: 0 };
  }

  get active() {
    return this._active;
  }

  /** `null` while walking/casting successfully; the last refusal reason
   * otherwise. Not part of `02-api-contracts.md` (no method names this) —
   * exposed for this ticket's own diagnostics/tests only. */
  get refusalReason() {
    return this._refusalReason;
  }

  /** `'idle' | 'walking' | 'cast' | 'refused'` — same non-contract,
   * diagnostics-only status as `refusalReason`. */
  get lastResult() {
    return this._lastResult;
  }

  get skillId() {
    return this._skillId;
  }

  get mode() {
    return this._mode;
  }

  /**
   * Starts (or replaces) the current order. Mirrors `PathFollower.
   * beginOrder`'s own shape: validation that can refuse outright happens in
   * `PlayerSystem.castOrder` (unknown slot/skill), this method just records
   * state for `step()` to act on next.
   * @param {number} hotbarIndex
   * @param {string} skillId
   * @param {object} def `SkillDefinition`
   * @param {number} x @param {number} z
   * @param {number} targetId
   */
  beginOrder(hotbarIndex, skillId, def, x, z, targetId) {
    this._active = true;
    this._oneShot = def.target === 'none' || def.target === 'self';
    this._hotbarIndex = hotbarIndex;
    this._skillId = skillId;
    this._mode = def.target;
    this._x = x;
    this._z = z;
    this._targetId = targetId | 0;
    this._chasing = false;
    this._chaseIssuedStep = -1;
    this._refusalReason = null;
    this._lastResult = 'idle';
  }

  /**
   * Ends the order. Releases the chase move order it owns, if any —
   * `player` may be `null`/absent (dispose-time teardown), in which case
   * this only clears local state.
   * @param {object|null} player
   */
  cancel(player) {
    // `player.releaseMoveOrder()`, never `player.stop()` — `stop()` (via
    // `_cancelOrder`) would itself call back into `CastController.cancel`
    // and `skills.interrupt`, recursing and wrongly interrupting a cast
    // this very call may be in the middle of starting. See the file
    // header's own cross-reference in `_stopChasing` below.
    if (this._chasing && player && typeof player.releaseMoveOrder === 'function') player.releaseMoveOrder();
    this._active = false;
    this._chasing = false;
    this._hotbarIndex = -1;
    this._skillId = null;
    this._mode = null;
    // `_refusalReason`/`_lastResult` are deliberately NOT reset here — they
    // are `step()`'s own last-attempt outcome (`'cast'`, `'refused'`, …)
    // and stay readable after the order ends (a one-shot's own `cancel()`
    // runs in the SAME tick as its one attempt — see `step()` below); a
    // fresh order's `beginOrder()` is what resets them for the next one.
  }

  /**
   * One fixed-step tick. `player` is the owning `PlayerSystem` (for
   * `moveOrder`/`stop` — same-directory coupling, not a cross-subsystem
   * import). `deps`: `{ actors, skills, items, audio, held, shiftHeld,
   * step }` — `step` is `ctx.time.step`, for the chase hysteresis.
   * @param {object} player
   * @param {{actors:object, skills:object|null, items:object|null,
   *   audio:object|null, held:boolean, shiftHeld:boolean, step:number}} deps
   */
  step(player, deps) {
    if (!this._active) return;
    const actor = player.actor;
    if (!actor || actor.dead) {
      this.cancel(player);
      return;
    }

    this._attempt(actor, player, deps);

    // A `'walking'` result means this ONE logical cast attempt (whether it
    // came from a held key or a single UI click) has not resolved yet — it
    // must keep going regardless of `deps.held`, or a plain, un-held click
    // on an `actor`/`point` skill would never get a chance to arrive
    // in range at all. `held` only decides whether to try AGAIN once an
    // attempt has actually resolved (`'cast'` or a terminal `'refused'`).
    if (this._lastResult === 'walking') return;

    if (this._oneShot || !deps.held) this.cancel(player);
  }

  /** @private */
  _refuse(reason, deps) {
    this._refusalReason = reason;
    this._lastResult = 'refused';
    playCastFailSfx(deps.audio);
  }

  /**
   * Releases just the move sub-order a chase started, WITHOUT cancelling
   * this cast order or calling `skills.interrupt()` — `player.
   * releaseMoveOrder()`, not `player.stop()`. This runs mid-`_attempt()`,
   * often the very step the actor arrived in range and is about to cast;
   * `stop()` would recurse back into `CastController.cancel` (via
   * `PlayerSystem._cancelOrder`) and interrupt the skill that is about to
   * fire. See `PlayerSystem#releaseMoveOrder`'s own doc comment.
   * @private
   */
  _stopChasing(player) {
    if (this._chasing) {
      player.releaseMoveOrder();
      this._chasing = false;
    }
  }

  /**
   * @private
   * @param {object} actor @param {object} player @param {object} deps
   */
  _attempt(actor, player, deps) {
    const { actors, skills, items } = deps;
    if (!skills || !actors) {
      this._stopChasing(player);
      this._refuse('no-skills', deps);
      return;
    }

    // Rule 1: canCast() first, before any movement intent — see file header.
    const check = skills.canCast(actor, this._skillId, this._x, this._z);
    if (!check.ok) {
      if (this._mode === 'point' && check.reason === 'no-path') {
        // The ONE case where "not ok" is the walk trigger, not a refusal —
        // 11-flows.md §5.2, verbatim, quoted in the file header.
        if (deps.shiftHeld) {
          this._stopChasing(player);
          this._refuse('out_of_range', deps);
          return;
        }
        this._chasePoint(actor, player, deps);
        this._lastResult = 'walking';
        this._refusalReason = null;
        return;
      }
      this._stopChasing(player);
      this._refuse(check.reason, deps);
      return;
    }

    // canCast() is ok — cooldown/resource/busy/unallocated all clear.
    if (this._mode === 'actor') {
      const target = actors.byId(this._targetId);
      if (!isValidCastTarget(actor, target)) {
        this._stopChasing(player);
        this._refuse('no-target', deps);
        return;
      }
      const range = weaponRangeOf(items, actor);
      if (!actors.inRange(actor, target, range)) {
        if (deps.shiftHeld) {
          this._stopChasing(player);
          this._refuse('out_of_range', deps);
          return;
        }
        this._chaseActor(actor, target, range, player, deps);
        this._lastResult = 'walking';
        this._refusalReason = null;
        return;
      }
    }

    this._stopChasing(player);
    const ok = skills.cast(actor, this._skillId, this._x, this._z, this._targetId);
    if (!ok) {
      // Defensive — canCast() already said ok; a handler-level refusal
      // (e.g. no wired cast handler for this skillId yet, D-37 scope) still
      // reports honestly rather than claiming success.
      this._refuse('cast-failed', deps);
      return;
    }
    this._refusalReason = null;
    this._lastResult = 'cast';
  }

  /** @private */
  _chasePoint(actor, player, deps) {
    const skills = deps.skills;
    const def = skills.definition(this._skillId);
    const maxRange = def && typeof def.range === 'number' ? def.range : 0;
    const standoff = Math.max(0, maxRange - POINT_RANGE_STANDOFF_M);
    const dest = computeApproachPoint(actor.x, actor.z, this._x, this._z, standoff, this._approachScratch);
    this._issueChase(dest.x, dest.z, player, deps);
  }

  /** @private */
  _chaseActor(actor, target, range, player, deps) {
    const standoff = Math.max(0, range - ACTOR_RANGE_STANDOFF_M);
    const dest = computeApproachPoint(actor.x, actor.z, target.x, target.z, standoff, this._approachScratch);
    this._issueChase(dest.x, dest.z, player, deps);
  }

  /**
   * Issues (or refreshes) the chase move order — §3.6's own hysteresis:
   * only re-path when the destination moved more than `CHASE_REPATH_DIST_M`
   * or `CHASE_REPATH_STEPS` have elapsed since the last order.
   * @private
   */
  _issueChase(destX, destZ, player, deps) {
    const step = deps.step || 0;
    if (this._chasing) {
      const dx = destX - this._chaseDestX;
      const dz = destZ - this._chaseDestZ;
      const moved = Math.sqrt(dx * dx + dz * dz);
      if (moved < CHASE_REPATH_DIST_M && step - this._chaseIssuedStep < CHASE_REPATH_STEPS) return;
    }
    player.moveOrder(destX, destZ);
    this._chasing = true;
    this._chaseDestX = destX;
    this._chaseDestZ = destZ;
    this._chaseIssuedStep = step;
  }
}
