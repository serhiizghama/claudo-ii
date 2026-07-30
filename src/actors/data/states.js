// src/actors/data/states.js
//
// ACTR-9 — the twelve `ACTOR_STATE` values (`01-data-model.md` §1.4,
// verbatim) and the frozen adjacency table `01 §1.4` requires by name:
// "Legal transitions are declared as a frozen adjacency table in
// `src/actors/data/states.js`". Pure data — imports nothing, so
// `tools/check-imports.mjs`'s auto-discovered `data/` root (this file makes
// `src/actors/data/` one, raising the lint's root count 6 -> 7) trivially
// passes for this file: there is no `import` statement to walk.
//
// `src/actors/action.js` is the only reader. Nothing here reaches `three`,
// `document`/`window`, `performance.now()`, `Math.random()`, or `ctx` of any
// kind — it is a plain object literal, evaluated once at module load.
//
// ---------------------------------------------------------------------------
// The adjacency table was NOT written down anywhere in the spec (this
// ticket's brief says so explicitly) — it is derived below from three
// sources: `01-data-model.md` §1.4's own one-line-per-state prose (quoted
// inline on `ACTOR_STATE` itself), `08-characters-visual.md` §6.6's
// interruption table (`hit` / `stun` / `death` / own-input / target-dies,
// during wind-up / active / recovery), and `03-combat-math.md` §7.11 (hit
// recovery -> `hitstun`). Every edge that is NOT a direct restatement of one
// of those three sources is called out below with its own reasoning — the
// orchestrator asked for this to be reviewable edge by edge, not eyeballed.
//
// ---------------------------------------------------------------------------
// Ground rules applied uniformly (stated once here, not repeated per edge)
// ---------------------------------------------------------------------------
// R1. Reflexive transitions (state -> itself) are legal for EVERY state,
//     including `dead`/`despawning`/`spawning`. This is NOT encoded as table
//     rows — `action.js#setState` special-cases `state === actor.state` as
//     an unconditional no-op success before ever consulting this table, the
//     same way a `Map.set` of an already-current value is not usually
//     modelled as a graph edge. Keeps every row below to genuinely DIFFERENT
//     destinations only.
// R2. `dead` is reachable from every live, non-invulnerable state (`idle`,
//     `move`, `windup`, `active`, `recover`, `channel`, `hitstun`,
//     `knockback`, `interact`) — death is a categorical override, not a
//     combat "interrupt" in the §6.6 sense (see the `windup` note below for
//     why this does not contradict "cancellable by hitstun only"). NOT
//     reachable from `spawning` (explicitly invulnerable, §1.4) or
//     `despawning` (already leaving; nothing re-enters `dead` from there).
// R3. `spawning` is entered only by the pool's own `acquire()` writing
//     `actor.state` directly (see `pool.js#acquire`, already-landed code
//     that bypasses `setState` on purpose, same discipline `dead`'s own
//     terminal-ness gets below) — so `spawning` has NO legal IN-edges here
//     at all. Its only OUT-edge is `spawning -> idle` (spawn/invulnerability
//     window ends). `hitstun`/`knockback`/`dead` are deliberately absent
//     from spawning's neighbours: "invulnerable, no collision" (§1.4) reads
//     as "cannot be the target of a damage-driven state change," not merely
//     "usually isn't."
//
// ---------------------------------------------------------------------------
// Non-obvious edges, argued individually
// ---------------------------------------------------------------------------
//
// `windup -> {active, hitstun, dead}` ONLY. §1.4 says windup is "cancellable
// by hitstun only" — read narrowly, on purpose, against the *combat-interrupt
// event types* §6.6's own table enumerates (`hit (no stun)` / `stun` /
// `input`): among those three, only `stun` (-> `hitstun`) cancels; a
// non-stunning hit and the actor's own next-attack input both explicitly
// "continue"/"ignored" per that table, so neither gets an edge. `death` is a
// FOURTH, more fundamental event outside that framing (§6.6 lists it
// separately from `stun`, with its own "cancels immediately" row) — every
// state dies regardless of what it was doing, so `windup -> dead` is kept
// despite the "hitstun only" wording, which this file reads as scoped to
// "combat interrupts," not "categorically the only thing that can end this
// state." `windup -> knockback` is deliberately NOT included even though
// `active`/`recover`/others get it below (see the next paragraph) — the
// explicit, named restriction for windup wins over the general symmetry
// argument used elsewhere.
//
// `active -> {recover, hitstun, knockback, dead}`. `recover` is the natural
// completion. `hitstun`: §6.6 — "hit already emitted, active truncated" (the
// hit already fired via `combat:hit-request` at `hitTick`; truncating the
// remaining active ticks does not retract it — see `actionSeq` notes in
// `action.js`). `knockback` is NOT in §6.6's table (which only names
// hit/stun/death/input/target-dies) but is added here by direct symmetry
// with `hitstun`: both are hit-driven, involuntary hard-CC states applied to
// whoever just got hit, and `motion.js`'s own header (quoting
// `03-combat-math.md`'s knockback section) describes knockback as a state
// the target "cannot act for [the whole window]" — the same shape of
// interrupt as a stun, just a different payload. `dead` per R2.
//
// `recover -> {idle, windup, hitstun, knockback, dead}`. `idle` is the
// natural completion (post-action lock expires). `hitstun`/`knockback`/
// `dead` as above. `recover -> windup` is the one QUANTITATIVE rule §6.6
// hands over almost complete: "own input (next attack): ... accepted from
// 75 %" — i.e. a NEW action's `beginAction` may fire while still inside
// `recover`, once `actionProgress(actor) >= 0.75`. This is deliberately a
// DIRECT edge, not `recover -> idle -> windup` — the entire point of the
// named exception is to shave off the tail of recovery for input
// responsiveness; routing it through `idle` first would reintroduce exactly
// the latency the rule exists to remove. `action.js#cancelAction` enforces
// the 75 % gate itself for `reason: 'input'` (see that file) rather than
// trusting every future caller to check `actionProgress` first.
//
// `idle -> {move, windup, channel, interact, hitstun, knockback, dead}` /
// `move -> {idle, windup, channel, interact, hitstun, knockback, dead}`.
// The two "at rest" / "in transit" states are treated symmetrically: both
// can start an action, start channelling, interact, or be hit/killed. Note
// what neither includes: `active`/`recover` directly (an action is always
// entered via `windup`, never skipped into) and NOT `despawning` (see R3's
// sibling reasoning below — `despawning` is entered from `dead` only).
//
// `channel -> {idle, hitstun, knockback, dead}` (whirlwind, ash-wall
// placement — §1.4). `idle` is the normal end of the channel.
// `hitstun`/`knockback`/`dead`: a continuous channel is exactly the kind of
// state a hard CC or death should be able to cut short — no textual
// interruption table covers `channel` (it is outside §6.6's wind/active/
// recovery framing entirely), so this extends the same hit-driven-interrupt
// reasoning used for `active`/`recover` above. Channel is NOT reachable from
// `windup`/`active`/`recover` (channelled skills are not staged through the
// beginAction wind/active/recover pipeline in this ticket's model — see
// `action.js`'s header on scope) and does not connect to `move`: whirlwind
// famously moves the caster, but that motion is presentation/physics, not a
// state-machine transition into `move` — the actor's action state stays
// `channel` for the whole effect.
//
// `interact -> {idle, hitstun, knockback, dead}` (vendor/stash/portal/quest
// dialogue — §1.4). Unlike `spawning`, nothing in §1.4 marks `interact` as
// invulnerable, so this file does NOT invent an exemption — an actor
// mid-dialogue can still be hit, knocked back, or killed by a monster that
// wandered up, same as `channel`. `interact -> move` is deliberately absent:
// closing a menu returns control to `idle` first (matching `knockback`'s and
// `hitstun`'s own landing state below); whatever system reads player intent
// next frame re-issues `idle -> move` on its own if movement is still held.
//
// `hitstun -> {idle, knockback, dead}` / `knockback -> {idle, hitstun,
// dead}`. Both are involuntary, duration-gated states (03 §7.11's
// `hitstunUntil` / `motion.js`'s knockback-window quote) that release back
// to `idle` when their timer elapses — never straight to `move`, for the
// same "let intent re-assert itself next frame" reason as `interact`. The
// two are allowed to chain INTO each other (a stunned actor can still be
// knocked back by a second, harder hit, and vice versa) since nothing in the
// spec forbids overlapping hard-CC and real combat frequently stacks them;
// this is a symmetry-driven extension, flagged as such rather than
// presented as textually mandated.
//
// `dead -> {despawning}` ONLY. §1.4: "`dead` is terminal until the record is
// recycled... nothing leaves `dead` except the pool recycling the slot into
// `spawning`." Read literally that would give `dead` ZERO `setState`-legal
// exits (the pool's `resetActorRecord`+`acquire()` cycle bypasses `setState`
// entirely, exactly like `spawning`'s own entry). This file instead carves
// out exactly one edge, `dead -> despawning`, because `despawning` is
// ITSELF defined as "corpse fade / pool return" (§1.4) — i.e. despawning
// does not compete with "terminal," it names the terminal state's own
// wind-down animation. The alternative reading (some non-`setState` code
// writes `actor.state = 'despawning'` directly, mirroring `acquire()`'s
// bypass of `spawning`) was considered and rejected: unlike `spawning`
// (whose only writer, the pool, is not this ticket's to gate) `despawning`
// has no such established direct-write precedent anywhere in the codebase
// today, so routing it through the one legality-checked entry point this
// ticket owns is the more conservative choice.
//
// `despawning -> {}`. No legal exits at all via `setState` — recycling back
// to `spawning` is the pool's `acquire()` writing the field directly (the
// same bypass `spawning`'s entry already uses), never a `setState` call.
//
// ---------------------------------------------------------------------------
// What is deliberately NOT modelled here
// ---------------------------------------------------------------------------
// `target dies` (§6.6's fifth row: "continues to completion" / "continues" /
// "continues" for wind-up/active/recovery) has NO adjacency implication —
// it describes the ATTACKER's own action continuing when their TARGET
// happens to die, which is a statement about a different actor entirely,
// not a transition this actor's own table needs an edge for. Included here
// only so a reviewer can see all five §6.6 rows were considered, not just
// the four that produced edges.

/** `01-data-model.md` §1.4, verbatim value set. `actor.state` (the
 * animation/action machine `pool.js` already allocates the field for) is
 * always one of these twelve strings, or `null` before the pool's own
 * `acquire()` assigns the first one. */
export const ACTOR_STATE = Object.freeze({
  spawning:   'spawning',   // materialising, invulnerable, no collision
  idle:       'idle',
  move:       'move',
  windup:     'windup',     // telegraph; cancellable by hitstun only
  active:     'active',     // the damage window of an action
  recover:    'recover',    // post-action lock
  channel:    'channel',    // whirlwind, ash wall placement
  hitstun:    'hitstun',    // hit recovery, see 03-combat-math §7
  knockback:  'knockback',
  interact:   'interact',   // vendor, stash, portal, quest dialogue
  dead:       'dead',
  despawning: 'despawning', // corpse fade / pool return
});

/** Not a `02-api-contracts.md` row — a small internal companion enum for
 * `actor.actionPhase` (already allocated by `pool.js`, "ACTR-9/10 drives
 * transitions"), naming which third of `beginAction`'s wind/active/recover
 * schedule the action is currently in. `action.js`'s `advanceAction` is the
 * only place that reads or writes it. */
export const ACTION_PHASE = Object.freeze({
  windup:  0,
  active:  1,
  recover: 2,
});

/** The frozen adjacency table `01-data-model.md` §1.4 requires by name.
 * Keys are every value of `ACTOR_STATE`; each value is a frozen array of the
 * OTHER states legal to transition to (reflexive edges are never listed —
 * see ground rule R1 above). `action.js#setState` is the only reader. */
export const ACTION_STATE_TRANSITIONS = Object.freeze({
  spawning: Object.freeze([
    'idle',
  ]),
  idle: Object.freeze([
    'move', 'windup', 'channel', 'interact', 'hitstun', 'knockback', 'dead',
  ]),
  move: Object.freeze([
    'idle', 'windup', 'channel', 'interact', 'hitstun', 'knockback', 'dead',
  ]),
  windup: Object.freeze([
    'active', 'hitstun', 'dead',
  ]),
  active: Object.freeze([
    'recover', 'hitstun', 'knockback', 'dead',
  ]),
  recover: Object.freeze([
    'idle', 'windup', 'hitstun', 'knockback', 'dead',
  ]),
  channel: Object.freeze([
    'idle', 'hitstun', 'knockback', 'dead',
  ]),
  hitstun: Object.freeze([
    'idle', 'knockback', 'dead',
  ]),
  knockback: Object.freeze([
    'idle', 'hitstun', 'dead',
  ]),
  interact: Object.freeze([
    'idle', 'hitstun', 'knockback', 'dead',
  ]),
  dead: Object.freeze([
    'despawning',
  ]),
  despawning: Object.freeze([
  ]),
});
