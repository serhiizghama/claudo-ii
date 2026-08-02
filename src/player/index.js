// src/player/index.js
//
// PLYR-1 — click-to-move intent and camera follow (docs/spec/11-flows.md §3,
// §2.2 position 7; docs/spec/02-api-contracts.md §13). The last M0 ticket:
// `nav`, `world`, `ui`, `skills`, `items` do not exist yet, so this file
// implements exactly one branch of §3.3's classification ladder — priority 4,
// "anything else -> hasMoveOrder = true" — and goes straight to the click
// point instead of through `nav`. Everything path-related (`nav.snap`,
// `nav.raycastNav`, `requestPath`, hold-to-move re-pathing, moving-target
// chase) is PLYR-2 (M1), not here. See this ticket's report for the full
// boundary list.
//
// ---------------------------------------------------------------------------
// PLYR-2 addendum — `moveOrder`/`stop`/`_followOrder` now wire into `./move.js`
// ---------------------------------------------------------------------------
// `nav` exists now (NAV-1..5, all accepted). The straight-line-only
// `_followOrder` PLYR-1 shipped is replaced below by a thin delegation into
// `PathFollower` (`./move.js`, this ticket's real file — see its own header
// for the full §3.4 twelve-step algorithm, the blocked-streak anti-wedge
// mechanism, the missing-`raycastNav` guard and the `PathHandle` lifetime
// argument). This file's job is unchanged in shape: `moveOrder` still just
// starts an order, `_followOrder` still runs every fixed step regardless of
// the latch, `stop`/`_cancelOrder` still cancels one — only what happens
// *inside* those three now goes through `move.js` instead of a bare
// straight-line lerp. `computeArriveRadius` moved to `./move.js` too (its
// natural home now that arrival is `move.js`'s own concern) and is
// re-exported below unchanged, so `tests/player/plyr1.test.js`'s existing
// `import { computeArriveRadius } from '../../src/player/index.js'` keeps
// working byte-for-bit. Nothing about the intent latch, the ladder dispatch,
// `groundCursor`, or the camera follow below changed at all.
//
// ---------------------------------------------------------------------------
// The latch, precisely (11-flows.md §3.1)
// ---------------------------------------------------------------------------
// `update(dt, ctx)` is the ONLY place this file reads `ctx.input` or
// `ctx.camera`. It builds the ground cursor, classifies the click and writes
// `this._intent` — bumping `intent.sequence` exactly on a fresh press edge,
// never on a hold-refresh (§3.5). `fixedUpdate(h, ctx)` never reads
// `ctx.input` at all; it only ever reads `this._intent`, the snapshot
// `update()` already wrote. Because `src/core/engine.js#frame()` runs the
// whole fixed-step loop BEFORE `update()` in the same call (engine.js phases
// 2 then 3), an intent written by frame F's `update()` is not visible to any
// `fixedUpdate` until frame F+1's fixed-step loop — exactly the "one frame
// later" `11-flows.md` §3.1 draws. `fixedUpdate` compares `intent.sequence`
// against `this._consumedSequence`; a frame that happens to run six fixed
// steps (the `MAX_SUBSTEPS` spiral guard) only sees that comparison flip once,
// so the "new order" dispatch (which calls `moveOrder()`) fires exactly once
// — the steering/`actors.moveTo()` call below it still runs every one of the
// six steps, because that is how six ticks of walking happen at all. See
// `tests/player/plyr1.test.js` for this exercised directly, across two real
// `engine.frame()` calls.
//
// ---------------------------------------------------------------------------
// Unprojecting the cursor without `three` (why, and how)
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md` rule 2 / this ticket's brief: no `three` import anywhere
// in `src/player/` — the directory must `import` cleanly under plain Node
// (`tests/player/plyr1.test.js` asserts exactly that). `ctx.camera` is a real
// `THREE.PerspectiveCamera`, built by `src/render/camera.js` (RNDR-2), but
// this file never imports that class — it only ever reads raw numbers off
// the object it is handed: `camera.matrixWorld.elements` (a flat, column-
// major 16-number array), `camera.fov`, `camera.aspect`. This is the exact
// duck-typing precedent `src/physics/index.js#_footprintFromNode` already
// established for the same reason (see that file's header, "why this file
// never imports three"). `unprojectRay`/`intersectPlaneY` below are pure,
// three-free functions built on that convention — a symmetric-frustum
// perspective unprojection (this engine never sets a camera view offset),
// mathematically equivalent to `THREE.Raycaster.setFromCamera` for this
// camera shape.
//
// ---------------------------------------------------------------------------
// `world.groundHeight` and the flat plane (this ticket's own boundary)
// ---------------------------------------------------------------------------
// `11-flows.md` §3.3 step 3 intersects the cursor ray with
// `y = world.groundHeight(px, pz)`, refined over three iterations as the
// estimate walks across terraces. `world` does not exist (M1/M5) — per this
// ticket's brief, the ground is a literal `y = GROUND_Y` (0) plane. With a
// constant ground height the exact intersection is captured on the first
// pass; a three-iteration loop against a function that always returns the
// same number would just repeat the identical arithmetic, so it is not
// written here as dead-looking padding. When `world.groundHeight` lands,
// `intersectPlaneY`'s `planeY` argument is exactly the seam to swap a
// constant for a real per-point read.
//
// ---------------------------------------------------------------------------
// The `renderX`/`renderZ` gap — a deliberate, documented deviation
// ---------------------------------------------------------------------------
// `11-flows.md` §2.2/§2.4 are explicit: the camera (and, per this ticket's
// dev-view brief, the debug capsule) must read `actor.renderX`/`renderZ`
// (interpolated by `actors`' own `update()`, position 3 in the phase table),
// never `actor.x`/`z`. But ACTR-1 (the only `actors` ticket landed so far)
// does not implement that `update()` — `src/actors/pool.js#acquire` sets
// `renderX = x` once, at spawn, and nothing ever touches it again, so
// reading `actor.renderX` today would show a capsule and a camera frozen at
// the spawn point forever, regardless of how far `actor.x`/`z` (correctly
// updated by `actors.moveTo`) actually moved — silently failing this
// ticket's own live-browser acceptance check ("the capsule walks to the
// clicked point"). This file does NOT patch that by writing
// `actor.renderX`/`renderZ` itself: `11-flows.md` §2.4 states in as many
// words that those fields are "written only in update(), only by actors",
// and `player.update()` runs at phase-7, after `actors`' future
// interpolation step at phase-3 — a second writer downstream would win the
// race and silently corrupt whatever ACTR's own interpolation ticket writes
// once it lands. Instead, `_interpolatedFocus` below computes the identical
// `lerp(prevX, x, alpha)` locally, from fields ACTR-1 already correctly
// maintains (`x`/`z`/`prevX`/`prevZ`) plus `ctx.time.alpha` (engine-owned,
// already correct) — the same number the real `renderX` will hold once it
// exists, just not persisted onto the shared `Actor` record. `src/dev/
// debugview.js` repeats the identical three-line formula for the same
// reason (it cannot reach this file's private state — see that file's own
// header). Flagged prominently in this ticket's report; the fix once ACTR-1
// (or a future ACTR-2/6) ships the real interpolation is a one-line swap to
// `actor.renderX`/`renderZ` in both places, not a redesign.
//
// ---------------------------------------------------------------------------
// No player actor exists yet either — spawned here, not by `createCharacter`
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §13's `createCharacter`/`loadCharacter` are the real,
// documented way a player `Actor` comes to exist — but they need
// `startingKit`/`items` (M3+) and a character-creation UI screen (M2+),
// neither of which exists. Without SOME player actor, `player.actor` stays
// `null` forever and nothing in this ticket is observable at all. `init()`
// below spawns a minimal placeholder (`kind: 'player'`, `team: 0`, at the
// origin) only when `actors.player` is not already set — a deliberate,
// narrow stand-in for M0, not an implementation of `createCharacter`. Flagged
// in this ticket's report.
//
// ---------------------------------------------------------------------------
// Camera write — the one legal path (docs/PROGRESS.md O-17)
// ---------------------------------------------------------------------------
// `render`'s write guard (RNDR-2) throws in dev on any direct write to
// `ctx.camera.position`/`.quaternion`. The only sanctioned path is
// `ctx.get('render').cameraRig` (`{ solveOrbitLock, withCameraWrite }`,
// cached once in `init()` — `ARCHITECTURE.md` rule 2 forbids importing
// `src/render/camera.js` directly): `solveOrbitLock` is called every
// `update()` (never `fixedUpdate` — reading `ctx.time.alpha` there would be
// illegal, §2.2), and the actual write happens only inside
// `rig.withCameraWrite(camera, fn)`.
//
// ---------------------------------------------------------------------------
// The dev-only capsule/ground view — wired without touching src/main.js twice
// ---------------------------------------------------------------------------
// docs/PROGRESS.md O-12: a ticket is granted exactly two `src/main.js` lines,
// by name, in its own brief — this ticket's grant covers `PlayerSystem`
// only. `src/dev/debugview.js` (explicitly authorised by this ticket's brief
// so the acceptance criterion is checkable at all — see that file's header)
// is therefore never `registry.add()`-ed; nothing else in this codebase
// drives its `update()` for it. `init()` below dynamically `import()`s it,
// gated behind `typeof window !== 'undefined'` — a *runtime* check, so this
// module's own static import graph never mentions `three` or that file, and
// a plain Node `import` of `src/player/index.js` (this ticket's own
// `tests/player/plyr1.test.js`) never triggers it even when `init()` runs
// against a Node ctx.

// ---------------------------------------------------------------------------
// PLYR-10 addendum — `hudState(out)`, round 2: O-57 is closed (ACTR-15)
// ---------------------------------------------------------------------------
// docs/PROGRESS.md D-23: `player.hudState()` had a contract row
// (`02-api-contracts.md:1189`, the `HudState` literal at `:1199-1213`) but no
// ticket owned writing it — `09-ui.md` §D-A is explicit that this is the
// *only* legal path a persistent value reaches the HUD. `hudState(out)`
// below fills it.
//
// **Round 1 hit O-57 and correctly stopped** (docs/PROGRESS.md D-29):
// `maxLife`/`maxMana`/`secondary`/`maxSecondary`/`secondaryKind` all need the
// COMPOSED `StatBlock`, and `src/actors/index.js` (`ActorsSystem`) exposed no
// accessor for it — `ARCHITECTURE.md` hard rule 2 forbids importing
// `src/actors/stats.js`/`vessels.js` directly to work around that, so round 1
// left those fields at the literal's defaults rather than reach around the
// gap. **ACTR-15 (accepted, docs/PROGRESS.md D-29) closes it**:
// `ctx.get('actors').stats(actor)` now recomposes-if-dirty and returns the
// real `StatBlock` — `maxLife`/`maxMana`/`maxRage`/`maxResonance` all live on
// it (`src/actors/stats.js` FIELD_NAMES, composed per-class by its
// `CLASS_TABLE`, `01-data-model.md` §4.2 steps 2+8).
//
// `maxLife`/`maxMana` are read straight off the returned `StatBlock`. The
// live secondary VALUE (as opposed to its cap) is NOT on the `StatBlock` at
// all — `actor.rage`/`actor.resonance` are plain fields on the Actor record,
// the same tier as `life`/`mana` (`src/actors/vessels.js`'s own
// `KNOWN_RESOURCES` list, ACTR-8, already merged in M2) — so once it is known
// WHICH of the two applies to this actor, that value is read directly, no
// accessor needed, exactly like `life`/`mana` above.
//
// `secondaryKind` — round 1 correctly refused to duplicate `stats.js`'s
// `CLASS_TABLE` (`classId -> {rage|resonance|mana}`) here (rule 9: gameplay
// numbers live in data, owned by their subsystem; risking the O-51/O-48
// drift class). It turns out no duplication is needed: the composed
// `StatBlock` already encodes the answer PER ACTOR — `01-data-model.md` §2.1
// "secondary resource" base contributions (`maxRage`/`maxResonance`, via
// `CLASS_TABLE`'s `baseRage`/`baseResonance`) mean exactly one of
// `stats.maxRage`/`stats.maxResonance` is nonzero for a class that has a
// secondary resource at all (`01-data-model.md` §2: "Ravager -> rage,
// Emberwright -> none, Runeblade -> resonance"). So `secondaryKind` (and
// which actor field to read for `secondary`/`maxSecondary`) is DERIVED from
// which of those two is nonzero — never a second copy of the table. A class
// with neither (Emberwright) falls to `'mana'`: `09-ui.md` §4.1.2 draws that
// class's resource orb straight off `mana`/`maxMana`, not `secondary` at all,
// so `secondary`/`maxSecondary` stay at 0 in that case — correct, not a
// missing accessor.
//
// `secondaryDecay`/`inCombat` were, at PLYR-3 time, left at their contract
// defaults (O-83): `09-ui.md` §16.4 says plainly the rage orb's decay arrow
// is gated by `inCombat`, but nothing computed it, and the decay RATE
// (`RAGE_DECAY_PER_SECOND`/`RESONANCE_DECAY_PER_SECOND`) was private data
// inside `src/actors/vessels.js`, not exposed by `ActorsSystem`.
//
// ---------------------------------------------------------------------------
// PLYR-4 addendum — O-83 closed: `inCombat`/`secondaryDecay` are real
// ---------------------------------------------------------------------------
// `./progress.js` transcribes `RAGE_DECAY_PER_SECOND`/
// `RESONANCE_DECAY_PER_SECOND` from `03-combat-math.md` §2.4 (matching the
// live, private constants at `src/actors/vessels.js:91,93` — not imported,
// `actors` owns that file; pinned to it by a live-behaviour test instead,
// see `./progress.js`'s own header) and `computeInCombat`, the same
// "now - max(lastDamageStep, lastDealtStep) < 4.0 s" formula
// `vessels.js#isInCombat` runs privately. `computeSecondaryDecay` mirrors
// `vessels.js#decayOutOfCombat`'s exact gating, so the exposed rate always
// matches what the NEXT fixed step's real decay (already running, ACTR-21)
// will do. `level`/`statPoints`/`skillPoints`/`xp`/`xpFloor`/`xpCeiling`/
// `xpTotal` are also real now — `ProgressTracker` (`./progress.js`) tracks
// them and `PlayerSystem.fixedUpdate` runs its level-up check every fixed
// step (`11-flows.md` §8).
//
// Every other field still has an explicit contract default per PLYR-3's own
// brief (`gold`/`questStep`/`belt` — owned by systems landing M4/M6) or has
// no owning feature wired into `player` yet (`targetId`/`difficulty`/
// `zoneId`/`name`/`classId` — each needs something outside this ticket's
// scope too: target selection, the `difficulty` property's own M6 ticket,
// or zone tracking) — left at the literal's own defaults, per O-27 (a
// default is honestly documented as today's contract value, never asserted
// as a permanent fact).

// PLYR-2: the real path-following state machine. Same directory, not a
// cross-subsystem import (hard rule 2 only forbids reaching into another
// subsystem's own module) — see move.js's own header.
import { PathFollower, computeArriveRadius } from './move.js';

// PLYR-3: hotbar/cast-order/targeting state machine — see cast.js's own
// header for the full design (the five targeting modes, cost-at-cast-start,
// the held-repeat mechanism, the weapon-range gap in `items`).
import { CastController, createHotbar, HOTBAR_SLOT_COUNT, isHostile } from './cast.js';

// PLYR-4: resources/decay/level-up — see progress.js's own header for the
// full design (`11-flows.md` §8's level-up sequence, O-83's decay/inCombat
// exposure). `XP_TABLE` (D-38, `./data/progression.js`) is read directly
// here for `hudState()`'s `xpFloor`/`xpCeiling` — everything else about the
// curve goes through `ProgressTracker`.
import {
  ProgressTracker,
  computeInCombat,
  computeSecondaryDecay,
  LEVEL_CAP,
} from './progress.js';
import { XP_TABLE } from './data/progression.js';

const DEG2RAD = Math.PI / 180;

/** `PointerEvent.button` for the primary/left button — `11-flows.md` §3
 * uses "LMB" for every click-to-move/attack/interact order; RMB (§3.2 row 5)
 * is skills, out of this ticket's scope. */
const MOVE_BUTTON = 0;

/** `src/core/input.js`'s pre-registered code for the stop order (§3.2 row 3,
 * "S"). */
const STOP_KEY_CODE = 'KeyS';

/** `PointerEvent.button` for the cast trigger — `05-skills.md` §1.4: "right
 * mouse casts the skill bound to `hotbar.rightMouse`". */
const CAST_BUTTON = 2;

/** `src/core/input.js`'s pre-registered codes for hotbar slots 1-4
 * (`05-skills.md` §1.4: "keys 1-4 fire hotbar slots at the cursor"). Index
 * `i` casts hotbar slot `i`. */
const DIGIT_KEY_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];

/** Raw `KeyboardEvent.code` for the modifier `11-flows.md` §3.3 calls
 * "Shift held" as a single condition — CORE-7 deliberately tracks the two
 * physical keys separately (docs/PROGRESS.md O-6: "ShiftLeft and ShiftRight
 * are two different keys, there is no generic Shift"), so a consumer must
 * check both or the modifier silently does not work on half the keyboards.
 * Read every `update()` (see `isShiftHeld`) even though, in this ticket's
 * reduced classification ladder (only priority 4, plain move), Shift changes
 * nothing yet — §3.3 only assigns Shift a meaning for priorities 2/3
 * (attack-in-place / interact-in-place), neither implemented here. Kept live
 * and tested now so the O-6 trap cannot quietly resurface once PLYR-3/4 add
 * those branches. */
const SHIFT_LEFT_CODE = 'ShiftLeft';
const SHIFT_RIGHT_CODE = 'ShiftRight';

/** Metres. `world.groundHeight` does not exist (M1/M5) — this ticket's
 * boundary is a literal flat plane. See the file header. */
const GROUND_Y = 0;

/** `11-flows.md` §3.3 step 5, verbatim: "physics.overlapCircle(gx, gz, 0.65,
 * MASK.ACTORS, scratch)". */
const HOVER_PICK_RADIUS_M = 0.65;

/** Preallocated `overlapCircle` `out`-array capacity for the hover pick —
 * generously above what a 0.65 m circle can ever contain (pack-occupancy
 * bodies are 0.22-0.60 m radius, `05-skills.md` §1.5). */
const HOVER_PICK_CAPACITY = 16;

/** `01-data-model.md` §2.1, `ACTOR_FLAG.untargetable`. Not exposed via
 * `actors`' public surface — same "hardcode the one field, cite the
 * source" precedent `PLACEHOLDER_TEAM` below already sets. `isHostile`
 * (the team-comparison half of §3.3 step 5's selection rule) is imported
 * from `./cast.js` above rather than re-derived here, so the two files
 * never carry two independently-drifting copies of the same formula. */
const ACTOR_FLAG_UNTARGETABLE = 1 << 1;

/** A ray this close to horizontal never happens at the fixed 52° camera
 * pitch; guarded anyway so a future camera-peek perturbation can never
 * divide by (near-)zero. */
const RAY_VERTICAL_EPSILON = 1e-8;

/** Metres. ASSIGNED — `11-flows.md` §2.2 names "camera follow with the dead
 * zone" but gives no number anywhere in the five spec documents this ticket
 * checked. Picked to absorb an ordinary walk-cycle's lateral sway without
 * ever nudging the camera on it (a capsule walking in a straight line only
 * drifts a few centimetres off a locked focus per fixed step), while still
 * being small enough that the camera visibly starts following well before
 * the player nears the screen edge. Revisit once real playtesting exists. */
const CAMERA_DEAD_ZONE_M = 1.5;

/** No character-creation flow exists yet (`createCharacter`,
 * `02-api-contracts.md` §13, needs `items`/M3+ and a UI screen/M2+) — see
 * the file header, "No player actor exists yet either". This is the
 * placeholder spawned in `init()` only when no player actor already exists. */
const PLACEHOLDER_ARCHETYPE_ID = 'ravager';
const PLACEHOLDER_TEAM = 0; // TEAM.player, 01-data-model.md §1.2

/** PLYR-4 fix — a fresh character starts at level 1 (`13-progression-lore.md`
 * §1's whole spine, `XP_TABLE[1] === 0`). Without this, the spawn call below
 * omitted `level` entirely, so `actors.spawn()`'s merge
 * (`src/actors/index.js#spawn`, `{ ...SPAWN_SPEC_DEFAULTS, ...spec }`) fell
 * through to `SPAWN_SPEC_DEFAULTS.level: 10` — a MONSTER-oriented default
 * (`02-api-contracts.md` §7's own `SpawnSpec` sample; `archetypeId` and
 * `kind` default to a monster too) that this placeholder call already
 * overrides for every other field except this one. That silent 10 was
 * harmless before `ProgressTracker` existed (nothing else read `actor.level`
 * as a source of truth for the player), but became actively harmful once
 * PLYR-4 landed: the FIRST `checkLevelUp()` call overwrote it with the
 * tracker's own (previously hardcoded) starting level, shrinking
 * `maxLife`/`maxMana` on the player's very first XP gain. See this ticket's
 * report. */
const PLACEHOLDER_LEVEL = 1;

/**
 * `02-api-contracts.md` §13's `Intent` shape, verbatim defaults. Every field
 * this ticket does not write (`attackTargetId`, `castSkillIndex`/`castX`/
 * `castZ`, `beltSlot`, `interactId`) stays at its neutral default forever —
 * PLYR-3/4/5's job, not this ticket's (see the file header's boundary list).
 * @returns {object}
 */
function createIntent() {
  return {
    moveX: 0,
    moveZ: 0,
    hasMoveOrder: false,
    attackTargetId: 0,
    castSkillIndex: -1,
    castX: 0,
    castZ: 0,
    beltSlot: -1,
    interactId: 0,
    stopRequested: false,
    sequence: 0,
  };
}

/**
 * `02-api-contracts.md:1199-1213`'s `HudState` literal, verbatim defaults —
 * PLYR-10's own scratch (built once, reused by `hudState()`'s no-`out` form,
 * mirroring `createIntent()` above). `cooldowns`/`hotbar`/`belt` are the
 * fixed-length arrays the literal itself shows; allocated exactly once here
 * and never replaced (ARCHITECTURE.md rule 6 — `array.length = 0` or a
 * fresh `[...]` would tear/reallocate the backing store on every call).
 * @returns {object}
 */
function createHudState() {
  return {
    life: 0, maxLife: 0, mana: 0, maxMana: 0,
    secondary: 0, maxSecondary: 0, secondaryKind: 'rage',
    secondaryDecay: 0,
    level: 1, xp: 0, xpFloor: 0, xpCeiling: 50, xpTotal: 0,
    statPoints: 0, skillPoints: 0, gold: 0,
    cooldowns: [0, 0, 0, 0], hotbar: [null, null, null, null],
    belt: [0, 0, 0, 0], targetId: 0, difficulty: 'instruction',
    zoneId: 'last_bastion', questStep: 0,
    name: '', classId: 'ravager',
    inCombat: false,
  };
}

/**
 * True if either physical Shift key is currently held. See the
 * `SHIFT_LEFT_CODE`/`SHIFT_RIGHT_CODE` comment above (docs/PROGRESS.md O-6)
 * for why both must be checked. Pure — takes CORE-7's `Input` instance (or
 * anything duck-typed the same way) and nothing else.
 * @param {{keyHeld:(code:string)=>boolean}} input
 * @returns {boolean}
 */
export function isShiftHeld(input) {
  return input.keyHeld(SHIFT_LEFT_CODE) || input.keyHeld(SHIFT_RIGHT_CODE);
}

// `computeArriveRadius` now lives in `./move.js` (PLYR-2 addendum, see this
// file's header, imported above) — re-exported here unchanged so
// `tests/player/plyr1.test.js`'s existing
// `import { computeArriveRadius } from '../../src/player/index.js'` keeps
// resolving.
export { computeArriveRadius };

/**
 * Unprojects one NDC point through `camera` into a world-space ray, without
 * ever importing `three` — see the file header. `camera` is duck-typed:
 * `.matrixWorld.elements` (16 numbers, column-major, three's own layout —
 * `src/physics/index.js#_footprintFromNode`'s exact precedent), `.fov`
 * (degrees), `.aspect`. Zero allocation: writes into the caller-owned
 * `outOrigin`/`outDir`.
 * @param {{matrixWorld:{elements:number[]}, fov:number, aspect:number}} camera
 * @param {number} ndcX -1..1, left to right
 * @param {number} ndcY -1..1, bottom to top
 * @param {{x:number,y:number,z:number}} outOrigin
 * @param {{x:number,y:number,z:number}} outDir
 */
export function unprojectRay(camera, ndcX, ndcY, outOrigin, outDir) {
  const e = camera.matrixWorld.elements;
  const rightX = e[0];
  const rightY = e[1];
  const rightZ = e[2];
  const upX = e[4];
  const upY = e[5];
  const upZ = e[6];
  // A camera looks down its own local -Z; matrixWorld's third column is
  // local +Z in world space, so "forward" is its negation.
  const fwdX = -e[8];
  const fwdY = -e[9];
  const fwdZ = -e[10];

  const halfHeight = Math.tan((camera.fov * DEG2RAD) / 2);
  const halfWidth = halfHeight * camera.aspect;
  const dx = ndcX * halfWidth;
  const dy = ndcY * halfHeight;

  let dirX = fwdX + dx * rightX + dy * upX;
  let dirY = fwdY + dx * rightY + dy * upY;
  let dirZ = fwdZ + dx * rightZ + dy * upZ;
  const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
  dirX /= len;
  dirY /= len;
  dirZ /= len;

  outOrigin.x = e[12];
  outOrigin.y = e[13];
  outOrigin.z = e[14];
  outDir.x = dirX;
  outDir.y = dirY;
  outDir.z = dirZ;
}

/**
 * Ray/plane-`y` intersection distance, or `null` if the ray is (near-)
 * parallel to the plane. `origin + dir * t` is the hit point.
 * @param {{y:number}} origin
 * @param {{y:number}} dir - unit length
 * @param {number} planeY
 * @returns {number | null}
 */
export function intersectPlaneY(origin, dir, planeY) {
  if (dir.y > -RAY_VERTICAL_EPSILON && dir.y < RAY_VERTICAL_EPSILON) return null;
  return (planeY - origin.y) / dir.y;
}

export class PlayerSystem {
  static id = 'player';
  // `02-api-contracts.md` §13's real deps: `['actors','nav','skills',
  // 'items','world']`. O-61 (docs/PROGRESS.md): this array used to be
  // trimmed to `['actors','nav']` — everything `skills`/`items`/`world`
  // still not registered as of M0/M1. All five are real subsystems now
  // (M2-M4 accepted); this ticket (PLYR-3) restores the full list.
  // `render` stays out of it deliberately — it is not in the CONTRACT's own
  // deps list either (reached via `ctx.get('render')` at runtime, never a
  // static import — rule 2), and does not need to be: `src/main.js`
  // registers `render` before `player` (B4's registration order), and
  // `Registry.resolve()`'s DFS ties are broken by registration order, so
  // `render` is guaranteed initialized first regardless.
  //
  // O-89's warning (SKIL-8: "adding a dep drags its whole chain into every
  // light-Registry test and broke three of them; it reverted and used
  // ctx.peek() instead") does NOT apply the same way here — checked
  // directly: no test anywhere constructs `PlayerSystem` through a
  // trimmed/light `Registry` (the two places `PlayerSystem` is imported
  // outside `tests/player/` — `tests/ui/inventory.perf.test.js`,
  // `tests/ui/sheet.test.js` — never mention it; the only direct,
  // non-`boot()` construction is `tests/player/hudstate.test.js`'s bare
  // `new PlayerSystem()`, which never touches `Registry`/`static deps` at
  // all). This file ALSO never caches `skills`/`items`/`world` from
  // `init()` (every use above is `ctx.peek('skills')` /
  // `ctx.peek('items')` at call time, inside `fixedUpdate`/`update`/
  // `hudState` — see `castOrder`/`_followCast`/`hudState`'s own comments),
  // so correctness never depended on this change either; it is made purely
  // to match the contract and guarantee init ORDER (skills/items/world
  // fully initialized before `player`), not because anything here would
  // break without it. Verified: full `npm run test:unit` (1914) and
  // `npm run test:perf` (144) both still pass with this restored, run
  // immediately before and after the change for comparison. See this
  // ticket's report.
  static deps = ['actors', 'nav', 'skills', 'items', 'world'];

  constructor() {
    this._ctx = null;
    this._actors = null;
    this._nav = null;
    this._rig = null;
    this._actor = null;

    this._controlEnabled = true;

    /** Latched every `_latchIntent` (`update()`) call — see `isShiftHeld`'s
     * own doc comment. Initialized here (not just assigned inside
     * `_latchIntent`) so `_followCast`'s `deps.shiftHeld` read is never
     * `undefined` on a `fixedUpdate` that runs before this instance's first
     * real `update()` frame (a direct `castOrder()` call in a test, e.g.). */
    this._shiftHeld = false;

    this._intent = createIntent();
    /** last `intent.sequence` value `fixedUpdate`'s ladder dispatch has
     * acted on — see the file header, "The latch, precisely". */
    this._consumedSequence = 0;

    /** The current move order — PLYR-2 addendum: `moveOrder()`/`stop()`/
     * `_followOrder()` below are thin wiring into this; see `./move.js`'s own
     * header for the real §3.4 state machine (destination validation,
     * requestPath/pollPath/smooth, blocked-streak repathing, arrival). One
     * instance for the lifetime of this `PlayerSystem`, reused across every
     * order — no per-order allocation. */
    this._pathFollower = new PathFollower();

    /** `groundCursor()`'s live value, recomputed once per `update()` frame
     * (§3.3) — never touched from `fixedUpdate`. */
    this._cursor = { x: 0, y: GROUND_Y, z: 0 };
    /** The scratch `groundCursor(out)` returns when called with no `out` —
     * kept separate from `_cursor` so a caller mutating its own copy can
     * never corrupt this file's next classification read. */
    this._cursorScratch = { x: 0, y: GROUND_Y, z: 0 };

    // Reused every frame by `_updateGroundCursor`/`unprojectRay` — zero
    // allocation on the hot path (ARCHITECTURE.md rule 6).
    this._rayOrigin = { x: 0, y: 0, z: 0 };
    this._rayDir = { x: 0, y: 0, z: 0 };

    /** PLYR-3: `hoverTarget` -> `int actorId`, 0 when none. Recomputed once
     * per `update()` frame by `_updateHoverTarget` (`11-flows.md` §3.3 step
     * 5) — `physics.overlapCircle` now exists (PHYS-3, accepted). Never
     * touched from `fixedUpdate` (`hoverTarget`'s own contract row is
     * `Fixed: N`). */
    this._hoverTarget = 0;
    // Reused every frame by `_updateHoverTarget` — zero allocation
    // (ARCHITECTURE.md rule 6).
    this._hoverScratch = new Int32Array(HOVER_PICK_CAPACITY);

    /** PLYR-3 — `01-data-model.md` §6.4 `Hotbar`. One instance for the
     * lifetime of this `PlayerSystem`; `setHotbar` mutates its `slots`
     * array in place, never replaces it. */
    this._hotbar = createHotbar();

    /** PLYR-3 — the cast-order state machine; see `./cast.js`'s own header.
     * One instance, reused across every order (same discipline as
     * `_pathFollower` above). */
    this._castController = new CastController();

    /** True while the physical RMB or a hotbar digit key (1-4) is
     * currently held — latched every `update()` frame from `ctx.input`,
     * never read from `fixedUpdate` directly (the file's own "fixedUpdate
     * never reads ctx.input" rule; `_followCast` reads this field instead,
     * the same one-frame-later discipline `intent.sequence` already uses).
     * Governs whether a repeat-mode cast order (`point`/`actor`/
     * `direction`) keeps retrying after each attempt — see cast.js's own
     * header, "Repeats". */
    this._castHeld = false;

    /** The live `hoverTarget` snapshotted at the moment a new cast order is
     * latched (press edge) — `Intent`'s own contract literal
     * (`02-api-contracts.md:1199`) has no field for a cast's target actor
     * id, so this is carried alongside `intent` rather than inside it (the
     * same one-frame-later latch, just not on the shared object). */
    this._latchedCastTargetId = 0;

    /** The camera's own focus point — trails the actor's interpolated
     * position outside the dead zone; see `_followCamera`. */
    this._camFocus = { x: 0, y: GROUND_Y, z: 0 };
    this._camPos = { x: 0, y: 0, z: 0 };
    this._camLookAt = { x: 0, y: 0, z: 0 };

    /** See the file header's "dev-only capsule/ground view" section —
     * `null` outside a real browser session (Node tests, SSR-style
     * boot()s). */
    this._debugView = null;

    /** PLYR-10: `hudState()`'s no-`out` scratch — built once, written into
     * every call, never reassigned (same discipline as `_cursorScratch`
     * above). See the file header's "PLYR-10 addendum" for which fields
     * this actually tracks the live actor for today. */
    this._hudScratch = createHudState();

    /** PLYR-4 — experience, level, stat/skill point budget, and the
     * one-step-deferred level-up refill. See `./progress.js`'s own header.
     * One instance for the lifetime of this `PlayerSystem`, same discipline
     * as `_pathFollower`/`_castController` above. */
    this._progress = new ProgressTracker();

    /** PLYR-4 — the `xp:gain` listener (`combat`, `src/combat/xp.js`,
     * already emits this — `11-flows.md` §8's own sequence sketch).
     * Registered in `init()`, removed in `dispose()`; kept as a bound
     * instance field (not an inline arrow at `on()`-time) so `off()` can
     * find the exact same function reference later — `EventBus#off`
     * matches by identity. */
    this._onXpGain = (payload) => {
      if (!this._actor || payload.actor !== this._actor) return;
      this.grantXp(payload.amount, payload.source ? payload.source.id : 0);
    };
  }

  async init(ctx) {
    this._ctx = ctx;
    this._actors = ctx.get('actors');
    this._nav = ctx.get('nav');
    this._rig = ctx.get('render').cameraRig;

    // See the file header, "No player actor exists yet either". `level:
    // PLACEHOLDER_LEVEL` explicit — see that constant's own comment for why
    // omitting it is the exact bug PLYR-4 fixed.
    this._actor =
      this._actors.player ||
      this._actors.spawn({
        kind: 'player',
        team: PLACEHOLDER_TEAM,
        archetypeId: PLACEHOLDER_ARCHETYPE_ID,
        level: PLACEHOLDER_LEVEL,
        x: 0,
        z: 0,
        facing: 0,
      });

    if (this._actor) {
      this._camFocus.x = this._actor.x;
      this._camFocus.z = this._actor.z;

      // PLYR-4 — single-valued level, from the moment `player` first has an
      // actor to read: `ProgressTracker` adopts whatever `actor.level`
      // ALREADY is (the freshly-spawned placeholder above, or a real
      // `actors.player` this file did not spawn itself — a future save/
      // character-load) rather than assuming 1. `hudState().level` and
      // `actor.level` must never disagree, at boot or after — see
      // `ProgressTracker#seedFromActor`'s own doc comment and this ticket's
      // report.
      this._progress.seedFromActor(this._actor);
    }

    // See the file header, "The dev-only capsule/ground view" — dynamic,
    // runtime-gated import so this module's own static graph never mentions
    // `three` or `src/dev/debugview.js`.
    if (typeof window !== 'undefined' && ctx.scene) {
      const { DebugView } = await import('../dev/debugview.js');
      this._debugView = new DebugView();
      this._debugView.init(ctx);
    }

    // PLYR-4 — `11-flows.md` §8: "combat R14(j) -> xp:gain -> player
    // listener (fixedUpdate, synchronous) -> experience accumulates".
    // `combat` (src/combat/xp.js, already landed) emits this whenever a
    // kill is credited; harmless to subscribe before `combat` exists at all
    // (a minimal test ctx with no `combat` registered simply never emits
    // it — `EventBus#emit` on an unknown/empty bucket is a no-op).
    ctx.events.on('xp:gain', this._onXpGain);
  }

  // ─── 02-api-contracts.md §13 — the slice this ticket implements ────────

  /** `actor` -> `Actor | null`. */
  get actor() {
    return this._actor;
  }

  /** `intent` -> `Intent`, read-only by convention (`player` is the only
   * legal writer — 02-api-contracts.md §13: "Never read player.intent in
   * update() [as a caller]; it is consumed in fixedUpdate"). Returns the
   * live object, not a copy — matching every other shared-scratch
   * convention in this codebase (`MoveResult`, `groundCursor`). */
  get intent() {
    return this._intent;
  }

  /** `hoverTarget` -> `int actorId`, 0 when none. PLYR-3: real now —
   * `_updateHoverTarget` (called from `update()`, never `fixedUpdate` —
   * this row's own contract is `Fixed: N`) recomputes it every frame via
   * `physics.overlapCircle` at the ground cursor, `11-flows.md` §3.3 step
   * 5. */
  get hoverTarget() {
    return this._hoverTarget;
  }

  /** `hotbar` -> `Hotbar` (`01-data-model.md` §6.4). `Fixed: Y` — returns
   * the live object, same convention as `intent`. PLYR-3. */
  get hotbar() {
    return this._hotbar;
  }

  /** `setHotbar(index, skillId) => void` — binds (or clears, `skillId ===
   * null`) hotbar slot `index`. `Fixed: N`. Silently no-ops on an
   * out-of-range index or a non-string/non-null `skillId` — the same
   * "drop rather than throw" convention `moveOrder`'s own dropped-order
   * path already uses. Does not validate that `skillId` is a real,
   * allocated skill: `skills` is reached only at call time via
   * `ctx.peek` (never cached — see the file header's O-61 note), and a
   * caller binding a not-yet-allocated skill to a slot is not itself
   * wrong (the player may allocate the point later); `canCast`/`cast`
   * are what actually gate usability, every time the slot is pressed. */
  setHotbar(index, skillId) {
    if (!Number.isInteger(index) || index < 0 || index >= HOTBAR_SLOT_COUNT) return;
    if (skillId !== null && typeof skillId !== 'string') return;
    this._hotbar.slots[index] = skillId;
  }

  /** `castOrder(hotbarIndex, x, z, targetId) => void` — `02-api-contracts.md`
   * §13's row (`Fixed: Y`). Starts (or replaces) the cast-order state
   * machine (`./cast.js#CastController`) for the skill bound to hotbar
   * slot `hotbarIndex`. Silently no-ops on an out-of-range index, an empty
   * slot, an unknown `skills` id, or when `skills` is not reachable
   * (`ctx.peek` — never a hard dep, see the O-61 note on `static deps`
   * below) — the same drop-don't-throw convention `moveOrder` already
   * uses. Called both from `fixedUpdate`'s ladder dispatch (priority 5,
   * RMB/1-4 — see `_latchIntent`) AND directly by `ui/hotbar.js#pressSlot`
   * (a mouse click on the hotbar icon) — see cast.js's own header for why
   * the two call sites end up with different "held" behaviour even though
   * they share this one method. */
  castOrder(hotbarIndex, x, z, targetId) {
    if (!Number.isInteger(hotbarIndex) || hotbarIndex < 0 || hotbarIndex >= HOTBAR_SLOT_COUNT) return;
    const skillId = this._hotbar.slots[hotbarIndex];
    if (!skillId) return;
    const skills = this._ctx && this._ctx.peek ? this._ctx.peek('skills') : null;
    if (!skills) return;
    const def = skills.definition(skillId);
    if (!def) return;
    this._castController.beginOrder(hotbarIndex, skillId, def, x, z, targetId | 0);
  }

  /** `setControlEnabled(on) => void`. §3.2 ladder priority 0: a disabled
   * player drops every intent outright (a zone-transition fade, per
   * 11-flows.md §9). */
  setControlEnabled(on) {
    this._controlEnabled = !!on;
  }

  /** `02-api-contracts.md` §13: `grantXp(amount, sourceId) => void`. `Fixed:
   * Y` — safe to call from any `fixedUpdate` (this is exactly how the
   * `xp:gain` listener reaches it — see the constructor's `_onXpGain`).
   * `11-flows.md` §8 step 1's own formula already applies every factor
   * `combat` owns; the one factor left outstanding for `player` is
   * `(1 + experienceGain/100)` — `src/combat/xp.js`'s own header states
   * this explicitly: `xpForMonster`'s contract signature has no
   * `experienceGain` parameter, and the multiplier is applied here,
   * against the live `StatBlock`, not duplicated as a second copy of the
   * formula. Silently no-ops without a live actor (mirrors every other
   * drop-don't-throw method in this file). `sourceId` is accepted per the
   * documented signature (the same "not consumed yet" convention
   * `vessels.js#addLife`'s own `sourceId` parameter already established)
   * — nothing in this ticket's scope reads it back.
   * @param {number} amount
   * @param {number} [sourceId]
   */
  // eslint-disable-next-line no-unused-vars
  grantXp(amount, sourceId) {
    if (!this._actor || !Number.isFinite(amount) || amount <= 0) return;
    const s = this._actors.stats(this._actor);
    const scaled = amount * (1 + s.experienceGain / 100);
    this._progress.grantXp(scaled);
  }

  /** `02-api-contracts.md` §13: `xpToNextLevel() => int` — remaining XP to
   * the next threshold, `0` at the level cap. `Fixed: Y`. Pure forward into
   * `ProgressTracker` — see `./progress.js`. */
  xpToNextLevel() {
    return this._progress.xpToNextLevel();
  }

  /** `moveOrder(x,z) => void` — an explicit click-to-move destination.
   * `fixedUpdate`'s ladder dispatch calls this at most once per latched
   * intent (see the file header); nothing stops another subsystem calling
   * it directly later (a future "walk here" UI affordance), which is
   * exactly why it is its own public method and not inlined into the
   * dispatch.
   *
   * PLYR-2 addendum: validation (§3.4 steps 1-2) can now DROP the order —
   * `PathFollower.beginOrder` returns `false` on an unreachable destination
   * (`nav.snap`/`nav.connected` failure). When that happens this clears
   * `intent.hasMoveOrder` right back to `false` in the same call, so a
   * dropped order never leaves the intent looking like a live one — see
   * `./move.js`'s header for why `nav.version === 0` (no real zone yet, e.g.
   * `tests/player/plyr1.test.js`'s own boot()) always succeeds unconditionally
   * instead, preserving that suite's original behaviour exactly. */
  moveOrder(x, z) {
    const accepted = this._pathFollower.beginOrder(this._nav, this._actor, x, z);
    if (!accepted) this._intent.hasMoveOrder = false;
  }

  /** `stop() => void` — §3.2 ladder priority 3. Releases the current order
   * and clears the intent's one-shot request. `actors.setState` does not
   * exist yet (ACTR-1 ships only the Lifecycle + `moveTo` slice) — guarded
   * by `typeof`, the same defensive-duck-typing convention `src/main.js`
   * already uses for every not-yet-built subsystem hook.
   *
   * Delegates to `_cancelOrder()` rather than being called by name from
   * `fixedUpdate` below: `docs/spec/02-api-contracts.md` §15 (`audio`) also
   * declares a `stop(voice, fadeSeconds)`, Fixed=N — `tools/check-fixed.mjs`
   * (TEST-2) matches Fixed=N call sites by bare method NAME across the whole
   * contract, with no per-subsystem disambiguation, so a literal
   * `this.stop()` written inside `fixedUpdate`'s own body false-positives
   * against `audio`'s unrelated row even though `player.stop` is itself
   * Fixed=Y. `_cancelOrder` is the real shared logic; both the public
   * `stop()` and the ladder dispatch call it. */
  stop() {
    this._cancelOrder();
  }

  /** PLYR-3 — releases only the move order, leaving cast/interrupt state
   * untouched. `./cast.js#CastController`'s own collaboration point: it
   * calls this (not `stop()`) to stop WALKING once a chase order has
   * arrived in range or is being replaced, without cancelling the cast
   * order itself or triggering `skills.interrupt()` (which `stop()` does,
   * and which would wrongly interrupt the very cast a chase just arrived
   * to perform — `_stopChasing` in cast.js runs mid-`_attempt()`, often the
   * same tick the actor gets into range and is about to cast). Not part of
   * `02-api-contracts.md` — an intra-subsystem collaboration surface, the
   * same tier `./move.js#PathFollower`'s own `beginOrder`/`step`/`cancel`
   * already occupy (real methods, just not the contracted public API). */
  releaseMoveOrder() {
    this._pathFollower.cancel(this._nav);
    this._intent.hasMoveOrder = false;
  }

  /** @private */
  _cancelOrder() {
    // PLYR-2 addendum: releases/cancels any PathHandle/requestId the order
    // was holding — see move.js's header, "PathHandle lifetime".
    this.releaseMoveOrder();
    this._intent.stopRequested = false;

    // PLYR-3 — §3.2 ladder priority 3's own row: "player.stop();
    // skills.interrupt(actor); release the path; actors.setState(actor,
    // 'idle')". Cancels any in-progress cast order (including a chase it
    // started — already released by `releaseMoveOrder()` above;
    // `CastController.cancel` only resets its own bookkeeping, see its own
    // doc comment) and interrupts the skill itself (cancels a cast/channel
    // — `02-api-contracts.md` §10). `skills` reached via `ctx.peek` — never
    // cached (O-61 note on `static deps`).
    this._intent.castSkillIndex = -1;
    this._castHeld = false;
    if (this._actor) {
      this._castController.cancel(this);
      const skills = this._ctx && this._ctx.peek ? this._ctx.peek('skills') : null;
      if (skills && typeof skills.interrupt === 'function') skills.interrupt(this._actor);
    }

    if (this._actor && typeof this._actors.setState === 'function') {
      this._actors.setState(this._actor, 'idle');
    }
  }

  /** `groundCursor(out?) => Vec3` — where the pointer met the ground plane
   * at the start of the most recent `update()` frame. `Fixed: N`: never
   * call from `fixedUpdate` (nothing here does). Returns `out` when given,
   * else the shared scratch, valid until the next call — the standard
   * `02-api-contracts.md` `out` convention. */
  groundCursor(out) {
    const dst = out || this._cursorScratch;
    dst.x = this._cursor.x;
    dst.y = this._cursor.y;
    dst.z = this._cursor.z;
    return dst;
  }

  /**
   * `02-api-contracts.md:1189` — `hudState(out?) => HudState`: "everything
   * `ui` needs, in one object". `Fixed: N` — `ui` calls this once per
   * `lateUpdate` (`09-ui.md` §D-A); never call it from `fixedUpdate`.
   * `Alloc: no` on the hot (supplied-`out`) path — writes fields in place,
   * writes the fixed-length arrays' elements in place, never allocates.
   * Falls back to the reused `_hudScratch` when called with no argument.
   *
   * See the file header's "PLYR-10 addendum" / "PLYR-4 addendum" for exactly
   * which fields track the live actor/`StatBlock` today (O-57 closed by
   * ACTR-15; `inCombat`/`secondaryDecay`/`level`/XP/point fields closed by
   * O-83/PLYR-4) and which simply have no owning feature wired into
   * `player` yet (left at the `HudState` literal's own contract defaults,
   * per O-27 — a default, not an assertion that nothing else will ever
   * exist).
   * @param {object} [out]
   * @returns {object}
   */
  hudState(out) {
    const dst = out || this._hudScratch;
    const actor = this._actor;

    // Real today — plain fields on the Actor record, no accessor needed
    // (01-data-model.md §2 / src/actors/vessels.js).
    dst.life = actor ? actor.life : 0;
    dst.mana = actor ? actor.mana : 0;

    if (actor) {
      // O-57 closed (ACTR-15, docs/PROGRESS.md D-29): `actors.stats(actor)`
      // recomposes if dirty, then returns the same `StatBlock` reference on
      // a clean actor (Alloc: no) — see the file header's "PLYR-10
      // addendum" for the full reasoning below.
      const s = this._actors.stats(actor);
      dst.maxLife = s.maxLife;
      dst.maxMana = s.maxMana;

      if (s.maxRage > 0) {
        // Ravager. `actor.rage` is a plain Actor-record field (ACTR-8),
        // same tier as `life`/`mana` above.
        dst.secondaryKind = 'rage';
        dst.secondary = actor.rage;
        dst.maxSecondary = s.maxRage;
      } else if (s.maxResonance > 0) {
        // Runeblade.
        dst.secondaryKind = 'resonance';
        dst.secondary = actor.resonance;
        dst.maxSecondary = s.maxResonance;
      } else {
        // Emberwright (01-data-model.md §2: "Emberwright -> none") — the
        // resource orb reads mana/maxMana directly for this class
        // (09-ui.md §4.1.2), so secondary/maxSecondary have nothing to hold.
        dst.secondaryKind = 'mana';
        dst.secondary = 0;
        dst.maxSecondary = 0;
      }
    } else {
      dst.maxLife = 0;
      dst.maxMana = 0;
      dst.secondary = 0;
      dst.maxSecondary = 0;
      dst.secondaryKind = 'rage';
    }

    // PLYR-4/O-83 — real now. `computeSecondaryDecay` mirrors
    // `src/actors/vessels.js#decayOutOfCombat`'s own gating (0 while
    // `inCombat`, 0 once the resource is already at 0) so this always
    // matches what the NEXT fixed step's decay will actually do — see
    // `./progress.js`'s own header. `dst.inCombat` is computed a few lines
    // below (it needs `step`, read once here since both derive from the
    // same live actor fields).
    {
      const step = this._ctx && this._ctx.time ? this._ctx.time.step : 0;
      dst.inCombat = computeInCombat(actor, step);
      dst.secondaryDecay = computeSecondaryDecay(dst.secondaryKind, dst.secondary, dst.inCombat);
    }

    // PLYR-4 — real now. `experience`/`level`/`statPoints`/`skillPoints`
    // are `ProgressTracker`'s own fields (`./progress.js`); `xpFloor`/
    // `xpCeiling` are `XP_TABLE[level]`/`XP_TABLE[level+1]` (D-38,
    // `./data/progression.js`), capped at the level-cap entry once
    // `level === LEVEL_CAP` (13-progression-lore.md §1.7: no level 31 —
    // `ui` shows `hud.maxLevel` in place of the fraction at the cap, not
    // this file's concern). `xp` is progress WITHIN the current level's
    // band (`xpTotal - xpFloor`), matching the literal's own worked
    // default at level 1 (`xp:0, xpFloor:0, xpCeiling:50, xpTotal:0`).
    {
      const p = this._progress;
      const level = p.level;
      const floor = XP_TABLE[level];
      const ceiling = level < LEVEL_CAP ? XP_TABLE[level + 1] : XP_TABLE[LEVEL_CAP];
      dst.level = level;
      dst.xpTotal = p.experience;
      dst.xpFloor = floor;
      dst.xpCeiling = ceiling;
      dst.xp = dst.xpTotal - floor;
      dst.statPoints = p.statPoints;
      dst.skillPoints = p.skillPoints;
    }

    // Owned by systems landing M4/M6 (this ticket's brief, point 5) —
    // contract literal defaults, verbatim.
    dst.gold = 0;
    dst.questStep = 0;

    // PLYR-3 — real now. `src/ui/hotbar.js:14-21`'s own gap note: this used
    // to zero `hotbar[0..3]`/`cooldowns[0..3]` unconditionally because
    // `player.hotbar`/`castOrder`/`setHotbar` did not exist. `dst.hotbar[i]`
    // is the slot's `skillId | null` straight off the live `Hotbar` record
    // (mutated in place, never reallocated — Alloc: no); `dst.cooldowns[i]`
    // is `skills.cooldownRemaining(actor, skillId)` (seconds) when a real
    // skill sits there and `skills` is reachable, else `0` — an EMPTY slot
    // on a fresh actor still reads `null`/`0`, so this stays compatible
    // with `tests/player/hudstate.test.js`'s own already-accepted
    // "fields owned by systems landing M4/M6 hold the HudState literal's
    // own defaults" assertion (nothing in that test ever calls
    // `setHotbar`). `ctx.peek` — never cached (O-61 note on `static deps`).
    {
      const skills = actor && this._ctx && this._ctx.peek ? this._ctx.peek('skills') : null;
      const slots = this._hotbar.slots;
      const cds = dst.cooldowns;
      const hb = dst.hotbar;
      for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
        const skillId = slots[i];
        hb[i] = skillId;
        cds[i] = skillId && skills ? skills.cooldownRemaining(actor, skillId) : 0;
      }
    }

    dst.belt[0] = 0;
    dst.belt[1] = 0;
    dst.belt[2] = 0;
    dst.belt[3] = 0;

    // No owning feature wired into `player` yet — contract literal
    // defaults. See the file header's "PLYR-10 addendum". `level`/
    // `inCombat` are set above now (PLYR-4/O-83).
    dst.targetId = 0;
    dst.difficulty = 'instruction';
    dst.zoneId = 'last_bastion';
    dst.name = '';
    dst.classId = 'ravager';

    return dst;
  }

  // ─── frame ───────────────────────────────────────────────────────────

  /**
   * Presentation + the intent latch (11-flows.md §2.2 position 7). Reads
   * `ctx.input`/`ctx.camera` — the only place in this file that does.
   * @param {number} dt
   * @param {object} ctx
   */
  update(dt, ctx) {
    this._ctx = ctx;

    this._updateGroundCursor(ctx);
    this._updateHoverTarget(ctx);
    this._latchIntent(ctx);
    this._followCamera(ctx);

    if (this._debugView) this._debugView.update(dt, ctx);
  }

  /**
   * The intent-consuming half of §3 — sub-step P1 of `player.fixedUpdate`.
   * Priority 3 (stop), priority 5 (PLYR-3: cast, `intent.castSkillIndex >=
   * 0`) and priority 8 (move order) — priorities 4/6/7 (belt/interact/
   * attack) need `items`/`world`/`combat` wiring this ticket does not own
   * (see this ticket's report). Never reads `ctx.input` (see the file
   * header) — only `this._intent`/`this._latchedCastTargetId`/
   * `this._castHeld`, all already latched by a *previous* frame's
   * `update()`.
   * @param {number} h - the fixed step, `FIXED_DT`. Never `ctx.time.dt`.
   * @param {object} ctx
   */
  fixedUpdate(h, ctx) {
    if (!this._actor || !this._actor.active) return;

    // PLYR-4 — resources/decay/level-up bookkeeping. Runs unconditionally,
    // even while `_controlEnabled` is false (a zone-transition fade is an
    // INPUT concern, `11-flows.md` §9 — XP/level bookkeeping keeps running
    // under it). `applyPendingRefill` first: it consumes a flag set by a
    // level-up on a PREVIOUS step, one full step before `checkLevelUp`
    // below can set a new one — see `./progress.js`'s own header for why
    // that ordering, not the reverse, is what gives the documented
    // one-step delay. Both are `Fixed: Y`-safe (`markDirty`/`stats` are
    // both `Fixed: Y` in `02-api-contracts.md` §7).
    this._progress.applyPendingRefill(this._actor, this._actors);
    this._progress.checkLevelUp(this._actor, this._actors, ctx.events);

    if (!this._controlEnabled) return; // ladder priority 0

    const intent = this._intent;
    if (intent.sequence !== this._consumedSequence) {
      this._consumedSequence = intent.sequence;
      if (intent.stopRequested) {
        intent.stopRequested = false; // one-shot, consumed
        this._cancelOrder(); // not `this.stop()` — see that method's own comment
      } else if (intent.castSkillIndex >= 0) {
        this.castOrder(intent.castSkillIndex, intent.castX, intent.castZ, this._latchedCastTargetId);
      } else if (intent.hasMoveOrder) {
        this.moveOrder(intent.moveX, intent.moveZ);
      }
    }

    this._followOrder(h, ctx);
    this._followCast(ctx);
  }

  dispose() {
    if (this._debugView) {
      this._debugView.dispose();
      this._debugView = null;
    }
    // PLYR-2 addendum: release/cancel any outstanding PathHandle/requestId
    // before this instance goes away — see move.js's header, "PathHandle
    // lifetime".
    this._pathFollower.cancel(this._nav);
    // PLYR-3: reset the cast controller too — `player: null` since
    // `releaseMoveOrder` above already handled the path, and nothing
    // downstream needs `skills.interrupt()` called during teardown.
    this._castController.cancel(null);
    // PLYR-4 — unsubscribe `xp:gain` (see `init()`); `EventBus#off` matches
    // by function identity, so this only ever removes this instance's own
    // handler.
    if (this._ctx && this._ctx.events) this._ctx.events.off('xp:gain', this._onXpGain);
    this._ctx = null;
    this._actors = null;
    this._nav = null;
    this._rig = null;
    this._actor = null;
  }

  // ─── internals ───────────────────────────────────────────────────────

  /**
   * §3.3 steps 1-4: NDC from client coordinates, unproject through
   * `ctx.camera`, intersect `y = GROUND_Y` (see the file header for why a
   * constant, not `world.groundHeight`), write `this._cursor`. A no-op,
   * holding the last good cursor, when a camera/canvas/input is not present
   * (a minimal test `ctx`) or the ray is edge-on to the ground.
   * @private
   */
  _updateGroundCursor(ctx) {
    const camera = ctx.camera;
    const canvas = ctx.canvas;
    const input = ctx.input;
    if (!camera || !canvas || !input) return;

    // Guards against reading a stale matrixWorld on the very first frame,
    // before `render` has ever called `renderer.render()` (which is what
    // normally keeps it current — see the file header). Reads
    // position/quaternion, writes matrix/matrixWorld: neither of those is
    // behind RNDR-2's write guard, so this never trips it.
    if (typeof camera.updateMatrixWorld === 'function') camera.updateMatrixWorld();

    const width = canvas.clientWidth || canvas.width || 1;
    const height = canvas.clientHeight || canvas.height || 1;
    const pointer = input.pointer;
    const ndcX = (pointer.x / width) * 2 - 1;
    const ndcY = -((pointer.y / height) * 2 - 1);

    unprojectRay(camera, ndcX, ndcY, this._rayOrigin, this._rayDir);
    const t = intersectPlaneY(this._rayOrigin, this._rayDir, GROUND_Y);
    if (t === null) return;

    this._cursor.x = this._rayOrigin.x + this._rayDir.x * t;
    this._cursor.y = GROUND_Y;
    this._cursor.z = this._rayOrigin.z + this._rayDir.z * t;
  }

  /**
   * PLYR-3 — §3.3 step 5, verbatim: `physics.overlapCircle(gx, gz, 0.65,
   * MASK.ACTORS, scratch)`, keep the nearest whose `ACTOR_FLAG.untargetable`
   * is clear, preferring hostile over neutral, breaking ties by lower
   * `actor.id`. Writes `this._hoverTarget`; a no-op (holds the last value)
   * without a live actor/`physics` (a minimal test `ctx`).
   * @private
   */
  _updateHoverTarget(ctx) {
    const physics = ctx.peek ? ctx.peek('physics') : null;
    if (!physics || !this._actor) {
      this._hoverTarget = 0;
      return;
    }

    const cursor = this._cursor;
    const scratch = this._hoverScratch;
    const count = physics.overlapCircle(cursor.x, cursor.z, HOVER_PICK_RADIUS_M, physics.MASK.ACTORS, scratch);

    let bestId = 0;
    let bestHostile = false;
    let bestDistSq = Infinity;
    for (let i = 0; i < count; i++) {
      const id = scratch[i];
      if (id === this._actor.id) continue;
      const target = this._actors.byId(id);
      if (!target || target.dead) continue;
      if ((target.flags & ACTOR_FLAG_UNTARGETABLE) !== 0) continue;

      const dx = target.x - cursor.x;
      const dz = target.z - cursor.z;
      const distSq = dx * dx + dz * dz;
      const hostile = isHostile(this._actor, target);

      if (bestId === 0) {
        bestId = id;
        bestHostile = hostile;
        bestDistSq = distSq;
        continue;
      }
      if (hostile && !bestHostile) {
        // Preferring hostile over neutral outranks distance.
        bestId = id;
        bestHostile = hostile;
        bestDistSq = distSq;
      } else if (hostile === bestHostile) {
        if (distSq < bestDistSq || (distSq === bestDistSq && id < bestId)) {
          bestId = id;
          bestHostile = hostile;
          bestDistSq = distSq;
        }
      }
      // hostile === false && bestHostile === true: keep the current best.
    }

    this._hoverTarget = bestId;
  }

  /**
   * §3.1/§3.3/§3.5: writes `this._intent` from this frame's input snapshot.
   * The whole latch lives here — `fixedUpdate` never repeats any of it.
   * @private
   */
  _latchIntent(ctx) {
    const input = ctx.input;
    if (!input) return;

    // O-78 — the player half of `ui.pointerOverUi` (`11-flows.md` §3.2
    // priority 1 / §3.7's "click on the plinth" row): drop EVERY new order
    // this frame while the pointer is over solid UI, including the
    // one-extra-frame close-click swallow guard — both already folded into
    // `ui.pointerOverUi` itself by UI-10 (`src/ui/index.js`'s own O-78
    // header). `ui` is not one of this subsystem's `deps` (see the O-61
    // note on `static deps`) — reached via `ctx.peek`, the file's existing
    // degrade-don't-throw convention, so a minimal test `ctx` with no `ui`
    // registered behaves exactly as before (guard is a no-op). This does
    // NOT touch any order already in progress — `_followOrder`/
    // `_followCast` keep running regardless, only NEW input is dropped.
    const ui = ctx.peek ? ctx.peek('ui') : undefined;
    if (ui && ui.pointerOverUi) {
      this._castHeld = false;
      return;
    }

    // Read, not yet acted on in this ticket's classification ladder — see
    // the `SHIFT_*_CODE` comment above.
    this._shiftHeld = isShiftHeld(input);

    const intent = this._intent;

    if (input.keyPressed(STOP_KEY_CODE)) {
      intent.stopRequested = true;
      intent.sequence++;
      this._castHeld = false;
      return; // §3.2: stop outranks a move order latched the same frame.
    }

    // PLYR-3 — §3.2 ladder priority 5: RMB / 1-4 -> castOrder
    // (`05-skills.md` §1.4: RMB casts `hotbar.rightMouse`'s slot, keys 1-4
    // cast their own index). `this._castHeld` tracks the RAW held state
    // every frame (needed by `CastController`'s own "repeats while held"
    // mechanism — see cast.js's header); the press edge is what starts a
    // NEW order and bumps `intent.sequence`, the same press-only-advances
    // rule `hasMoveOrder` already follows.
    const rmbHeld = input.buttonHeld(CAST_BUTTON);
    let digitHeld = false;
    for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
      if (input.keyHeld(DIGIT_KEY_CODES[i])) { digitHeld = true; break; }
    }
    this._castHeld = rmbHeld || digitHeld;

    let pressedIndex = -1;
    if (input.buttonPressed(CAST_BUTTON)) pressedIndex = this._hotbar.rightMouse; // -1 = 'attack', out of this ticket's scope
    if (pressedIndex < 0) {
      for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
        if (input.keyPressed(DIGIT_KEY_CODES[i])) { pressedIndex = i; break; }
      }
    }
    if (pressedIndex >= 0) {
      intent.castSkillIndex = pressedIndex;
      intent.castX = this._cursor.x;
      intent.castZ = this._cursor.z;
      // `Intent`'s own contract literal has no target-actor field
      // (`02-api-contracts.md:1199`) — carried alongside it instead, the
      // same one-frame-later latch, just not on the shared object. See the
      // constructor's own comment on `_latchedCastTargetId`.
      this._latchedCastTargetId = this._hoverTarget;
      intent.sequence++;
      return; // exclusive with move this frame — matches STOP's own precedent above.
    }

    const pressed = input.buttonPressed(MOVE_BUTTON);
    const held = input.buttonHeld(MOVE_BUTTON);
    if (!pressed && !held) return; // nothing new — a click's order sticks
    // until fixedUpdate's own arrival/stop logic clears it.

    // §3.3's classification ladder: priorities 1-3 need a ground-item pick
    // and `world.interactableAt` (priority 2's own hostile-actor pick now
    // has a real value to read, `this._hoverTarget` — but wiring the
    // `attackTargetId` branch itself is PLYR-4/5's basic-attack territory,
    // not this ticket's, see this ticket's report). Every click still
    // reaches priority 4 here.
    intent.hasMoveOrder = true;
    intent.moveX = this._cursor.x;
    intent.moveZ = this._cursor.z;
    if (pressed) intent.sequence++; // §3.5: only the press edge advances it.
  }

  /**
   * PLYR-3 — the cast-order-consuming half, mirroring `_followOrder`
   * exactly: runs every fixed step regardless of the latch (a held repeat
   * needs to keep re-attempting), and clears `intent.castSkillIndex` back
   * to `-1` the instant the order stops being active (arrived+cast,
   * refused terminally, or the button was released) — see cast.js's own
   * header for the full state machine.
   * @private
   */
  _followCast(ctx) {
    if (!this._castController.active) return;
    const deps = {
      actors: this._actors,
      skills: ctx.peek ? ctx.peek('skills') : null,
      items: ctx.peek ? ctx.peek('items') : null,
      audio: ctx.peek ? ctx.peek('audio') : null,
      held: this._castHeld,
      shiftHeld: this._shiftHeld,
      step: ctx.time ? ctx.time.step : 0,
    };
    this._castController.step(this, deps);
    if (!this._castController.active) this._intent.castSkillIndex = -1;
  }

  /**
   * §2.2 position 7 / docs/PROGRESS.md O-17: camera follow, dead zone, the
   * one legal write path. No-ops without a live actor/camera/rig (a
   * minimal test `ctx`).
   * @private
   */
  _followCamera(ctx) {
    const actor = this._actor;
    const camera = ctx.camera;
    if (!actor || !camera || !this._rig || !ctx.config) return;

    const alpha = ctx.time ? ctx.time.alpha : 0;
    const focusX = actor.prevX + (actor.x - actor.prevX) * alpha;
    const focusZ = actor.prevZ + (actor.z - actor.prevZ) * alpha;

    const camFocus = this._camFocus;
    const dx = focusX - camFocus.x;
    const dz = focusZ - camFocus.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > CAMERA_DEAD_ZONE_M) {
      // Pull the focus toward the actor, leaving exactly the dead-zone
      // radius of slack — a snap-to-the-edge follow, not an elastic spring:
      // frame-rate-independent with no extra smoothing state to tune.
      const pull = (dist - CAMERA_DEAD_ZONE_M) / dist;
      camFocus.x += dx * pull;
      camFocus.z += dz * pull;
    }

    this._rig.solveOrbitLock(
      camFocus.x,
      camFocus.y,
      camFocus.z,
      ctx.config.camPitch,
      0,
      ctx.config.camDist,
      this._camPos,
      this._camLookAt,
    );

    const camPos = this._camPos;
    const camLookAt = this._camLookAt;
    this._rig.withCameraWrite(camera, () => {
      camera.position.set(camPos.x, camPos.y, camPos.z);
      camera.lookAt(camLookAt.x, camLookAt.y, camLookAt.z);
    });
  }

  /**
   * Steers toward the current order every fixed step (see the file header
   * — this is deliberately NOT gated by the sequence latch: six ticks of
   * walking need six `actors.moveTo()` calls).
   *
   * PLYR-2 addendum: the straight-line-only walk is now `PathFollower`'s
   * `MODE_DIRECT`/`nav.version===0` fallback, one branch among the full
   * §3.4 state machine — see `./move.js`'s header. This method is reduced
   * to exactly the delegation + the one bit of bookkeeping `move.js` cannot
   * do itself (it never touches `Intent`): clearing `intent.hasMoveOrder`
   * the instant the order stops being active, whether that is because it
   * arrived (step 12) or was dropped (a mid-walk repath finding the
   * destination no longer reachable).
   * @private
   */
  _followOrder(h) {
    if (!this._pathFollower.active) return;
    this._pathFollower.step(h, this._nav, this._actors, this._actor);
    if (!this._pathFollower.active) this._intent.hasMoveOrder = false;
  }
}
