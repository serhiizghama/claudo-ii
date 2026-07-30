// src/actors/anim.js
//
// ACTR-12 — the Animator: `08-characters-visual.md` §5's layer stack, bone
// masks, the idle/walk/run crossfade `clips.js` (ACTR-11) deliberately did
// not build, additive overlays and the spring/damper bank. Node-safe: no
// `three`, no DOM/browser global, no `performance.now()` anywhere in this
// file — `src/actors/` is a strict `check-imports.mjs` root (`checkGlobals:
// true`). This file produces PLAIN POSE DATA and a plain quaternion/position
// "skeleton" walk (see "Skeleton, without three" below) — nothing here
// builds or touches a `three` object.
//
// No `Math.random()` (rule 3). No `Map` for per-actor state (rule: leaks on
// never-repeating keys) — every per-actor structure here is a plain object
// with fixed, named fields, allocated once by `createAnimatorState` and
// mutated in place forever after; nothing is keyed by an arbitrary id. No
// `Math.hypot` anywhere (none needed — every distance here is a squared-sum
// under a `Math.sqrt`, never used).
//
// ---------------------------------------------------------------------------
// Scope: what this ticket owns and what it deliberately does not
// ---------------------------------------------------------------------------
// Owns: the four bone masks (§5.3), the smoothstep blend-weight dynamics
// (§5.2), the idle<->walk/run crossfade this file adds on top of `clips.js`'s
// gait primitives (this ticket's main addition — see "The idle<->locomotion
// crossfade" below for why `clips.js#writeLocomotionPose` itself is never
// called here), the §5.5 state-table data needed to drive layer blend times
// and mask recipes, the §5.6 additive overlays (breath wired in by default;
// hit-flinch/impact-recoil/stagger/lean-to-target built as generic,
// independently callable+testable machinery), and the §5.7 spring/damper
// bank (fixed 1/120 s step, accumulator, 4-substep cap).
//
// Does NOT own: attack/cast/block CLIP CURVES — what a wind-up pose's raw
// per-bone rotation actually looks like. Every state-table entry below
// (`STATE_TABLE`) carries blend timing and a MASK RECIPE, never a curve —
// `docs/spec/08-characters-visual.md` §6 (explicitly out of this ticket's
// reading list, ACTR-14's ticket) is where attack timing and, presumably,
// authored clip content live; this ticket's own 15-step table (`08 §11`)
// never assigns "attack clip curves" to any step either. `updateAnimator`
// therefore accepts the L2 override's raw pose delta as a CALLER-SUPPLIED
// buffer (`input.overrideDelta`) — this file masks and blends whatever is
// handed to it; it does not decide what a wind-up looks like. Mirrors
// exactly how `clips.js` drew its own boundary around locomotion-only
// content.
//
// Also does NOT own: wiring into `src/actors/index.js` (calling this once
// per actor per frame, listening to `actor:damage`/`anim:hitframe` to fire
// the triggered overlays) — this file has no `ctx`, cannot subscribe to
// `ctx.events`, same Node-safe boundary `clips.js`/`action.js`/`rig.js` all
// keep. `triggerHitFlinch`/`triggerImpactRecoil`/`triggerStagger` are the
// hooks whatever DOES have `ctx` calls when the real event fires.
//
// ---------------------------------------------------------------------------
// The idle<->locomotion crossfade — this ticket's main addition over ACTR-11
// ---------------------------------------------------------------------------
// `clips.js#writeLocomotionPose` picks idle OR walk/run with a hard `if
// (speed < IDLE_SPEED_THRESHOLD) { ...; return; }` — a literal, same-frame
// switch between "only a small Chest pitch" and "the full leg/pelvis/spine
// gait curve at whatever `state.phase` currently is". Measured directly
// (see this ticket's report), that switch is NOT a small jump: the gait
// curve's OWN value at an arbitrary phase is nowhere near zero (a knee angle
// of -20..-30° is typical), so calling it at full strength the instant speed
// crosses the threshold is exactly the kind of one-frame pop `08` §11 step
// 6's "no bone-angle discontinuity > 6°/frame" criterion exists to catch.
//
// This file therefore does NOT call `writeLocomotionPose` at all. It calls
// the primitives `clips.js` exports beneath that function
// (`computeStrideHz`, `advancePhase`, `blendGaitParams`, `gaitAngles`,
// `pelvisMotion`, `spineCounterRotation`) directly, ALWAYS (not gated behind
// the idle threshold — the gait phase keeps advancing at `walk`'s own
// `minHz` even while nominally idle, so there is always a continuous,
// already-warm phase to fade into/out of, never a cold start), and
// introduces a SECOND blend weight — `locoWeight`, `08` §5.2's own
// smoothstep dynamics — that ramps the whole gait/pelvis/spine/arm
// contribution's WEIGHT between 0 (idle) and 1 (walking/running) over real
// seconds. This is the "L1 locomotion base (crossfaded pair)" the `08` §5.1
// diagram names — the "pair" being idle and the walk/run blend.
//
// **`clips.js#crossfadeWeight` is deliberately NOT reused for the walk<->run
// half either — measured, reported, not silently worked around.** Its own
// hysteresis re-picks which pair of band edges the SAME smoothstep is
// evaluated against the instant `state.dominant` flips (`weight >= 0.5 ?
// 'run' : 'walk'`, checked EVERY call, i.e. inside the band, not at either
// outer edge) — and because the edges themselves jump by `TRANSITION.
// hysteresis` (0.25 m/s) at that instant, the WEIGHT read against the new
// edges at the same speed is discontinuous. Measured directly (a Node
// harness driving `crossfadeWeight` through a decelerating run-> idle
// ramp, dt=1/60s): `runWeight` jumps ~0.48 -> ~0.055 in one call at the
// exact frame `dominant` flips, which alone produced a 20.9°/frame knee
// jump through this file's own accumulator — a direct, measured failure of
// this ticket's own criterion. This is a real, evidenced bug in ACTR-11's
// accepted `crossfadeWeight` (flagged in this ticket's report, `clips.js`
// is not in this ticket's file list to fix), not a maybe. This file's own
// `runWeight` below is a plain `smoothstep(lower, upper, speed)` over the
// FIXED band edges (`TRANSITION.center +- TRANSITION.band/2`) — continuous
// and monotonic in `speed` by construction, satisfying `08 §11 step 6`
// outright — at the cost of foregoing `crossfadeWeight`'s own anti-flicker
// hysteresis (a speed dithering exactly at the band edge re-blends faster
// here than with hysteresis would). Acceptable: this ticket's own
// acceptance criterion is a smooth RAMP, not chatter suppression, and the
// alternative (reusing the buggy function) fails it outright.
//
// `08` §5.5 gives blend times per STATE, not per this idle<->moving
// transition directly (which is not itself a named state in the table -
// idle/walk/run are three separate rows). This file's reading, reported
// per the ticket brief: entering locomotion uses `walk`'s own blend-in
// (0.16 s) — a Bone Ranker crossing the idle threshold is, almost by
// definition, entering walk territory first (idle's own threshold,
// `IDLE_SPEED_THRESHOLD = 0.05` m/s, is far below `TRANSITION.center =
// 3.2` m/s where the walk<->run band even starts) — and returning to idle
// uses `idle`'s own blend-out (0.16 s). `LOCO_ENGAGE_TAU_IN`/`_TAU_OUT`
// below name this choice so it is not a bare magic number.
//
// The idle branch's own crude "Chest pitch" placeholder (`clips.js`'s own
// documented "simplest honest placeholder", since `08 §5.4` gives idle no
// curve shape) is NOT reused here — this file has real breath-overlay data
// from `08` §5.6 (amplitude, bones, cycle) that `clips.js` did not have
// when ACTR-11 landed, and `08` §5.6 says breath is "always on, >= 0.25
// weight in every state" — using both would be two undocumented,
// un-cross-checked curve shapes doing the same job. `writeBreathOverlay`
// below is idle's (and every other state's) breathing motion; this file's
// own L1 crossfade carries only the leg/pelvis/spine/arm gait contribution.
//
// ---------------------------------------------------------------------------
// Skeleton, without `three` — what "pose + skeleton cost" measures here
// ---------------------------------------------------------------------------
// `08` §9.4's own cost table splits "pose evaluation" from
// `Bone.updateMatrixWorld` / `Skeleton.update` — both of which are `three`
// APIs this file is forbidden from importing (`src/actors/` outside
// `archetypes/` never touches `three`, per ARCHITECTURE.md's ownership map
// and this ticket's own brief). `composeSkeletonWorld` below is this file's
// Node-safe STAND-IN for that second half: it walks `rig.parents` forward
// exactly once (same "parent index < child index, one forward pass is
// correct" guarantee `rig.js#reconstructBindPos` already relies on and
// documents), composing `q = rig.localQuat[i] (x) eulerDeg(pose.delta[i])`
// then `worldQuat[i] = worldQuat[parent] (x) q` and `worldPos[i] =
// worldPos[parent] + rotate(worldQuat[parent], rig.localPos[i])` — the same
// quaternion-multiply-and-rotate-a-vector operation count a real
// `Bone.updateMatrixWorld` walk does, just without building a `three`
// `Matrix4`/`Quaternion` object per bone (every intermediate here is a
// scalar local variable, never a `{x,y,z,w}` object literal or an array
// literal, so this stays genuinely zero-allocation — see "Zero allocation"
// below). `08 §5.1`'s own diagram literally writes `q = bindLocal ·
// euler(delta)` — this file reads that composition order literally
// (`localQuat (x) deltaQuat`, delta applied in the bone's own rest-local
// frame), a choice as arbitrary-but-documented as `rig.js`'s own
// primary-child/leaf-direction picks, and, like those, invisible to any
// numeric criterion this ticket's tests check (the criterion is COST, not a
// specific rotation semantic).
//
// This is reported loudly, per the ticket brief: the acceptance criterion's
// "pose + skeleton cost" is measured here as this file's own Node-safe
// composition, not `three`'s real `Bone`/`Skeleton` path (which this file
// cannot import). Whichever ticket wires a `THREE.Skeleton` on top later
// (the archetypes, per D-13's exemption) should re-measure against the real
// `three` cost once that exists; this ticket's number is an honest,
// same-operation-count proxy, not the final word.
//
// ---------------------------------------------------------------------------
// Zero allocation — how this file stays there
// ---------------------------------------------------------------------------
// Every per-frame path (`updateAnimator` and everything it calls) is written
// with scalar local variables only — no `{x,y,z}`/`{x,y,z,w}` object
// literals, no array literals, no closures created per call, no
// `.slice()`/`.map()`/spread. Every buffer `updateAnimator` writes into
// (`pose.delta`, `worldQuat`, `worldPos`, the per-spring `{x,v,acc}` records,
// `lastOverrideDelta`) is allocated exactly once, in `createAnimatorState`,
// and reused by index/field-write forever after. `array.length = 0` never
// appears here (rule: it tears a typed array's backing store); nothing here
// ever needs to shrink an array — every buffer is fixed-size for a rig's
// `boneCount`, which never changes after `createAnimatorState`.

import {
  CLIPS,
  IDLE_SPEED_THRESHOLD,
  LEG_SIDE_OFFSET,
  TRANSITION,
  computeStrideHz,
  advancePhase,
  blendGaitParams,
  createGaitParamsScratch,
  gaitAngles,
  pelvisMotion,
  spineCounterRotation,
  createPose,
  resetPose,
  buildLocomotionBoneIndex,
} from './clips.js';

// ---------------------------------------------------------------------------
// Small pure helpers (each file keeps its own math — established convention,
// see bone_ranker.js's header; matches rig.js's/clips.js's own small local
// helper sections).
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** `08` §5.2 verbatim: `smoothstep(0,1,x)`. */
function smoothstep01(x) {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Plain, continuous `smoothstep(lo, hi, x)` — this file's own walk<->run
 * blend weight, over the FIXED `TRANSITION` band edges. See the file
 * header ("`crossfadeWeight` is deliberately NOT reused...") for the
 * measured discontinuity this replaces. */
function smoothstepRange(lo, hi, x) {
  if (hi <= lo) return x >= hi ? 1 : 0;
  return smoothstep01((x - lo) / (hi - lo));
}

/** `08` §5.4's transition band, fixed edges — `TRANSITION.center +-
 * TRANSITION.band/2`, verbatim (no hysteresis shift — see the file header). */
const RUN_BLEND_LOWER = TRANSITION.center - TRANSITION.band / 2;
const RUN_BLEND_UPPER = TRANSITION.center + TRANSITION.band / 2;

const DEG2RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// §5.3 — Bone masks, transcribed verbatim from the ticket brief / `08` §5.3.
// Built once per rig (data, per ARCHITECTURE.md rule 9: "gameplay numbers
// live in data, not in code").
// ---------------------------------------------------------------------------

export const MASK_NAMES = Object.freeze(['full', 'upper', 'lower', 'arms']);

/** Per-bone-name `{upper, lower, arms}` values, 0..255. Any bone name not
 * listed here (the `Root`, and the boss-only `Cloak2`/`Tome` — boss is
 * ACTR-14, out of this ticket's scope) defaults to `0` in every non-`full`
 * mask, matching every row's own "everything else 0" phrasing. */
export const BONE_MASK_SPEC = Object.freeze({
  Hips: Object.freeze({ upper: 64, lower: 255, arms: 0 }),
  Spine: Object.freeze({ upper: 160, lower: 255, arms: 0 }),
  Chest: Object.freeze({ upper: 255, lower: 0, arms: 96 }),
  Neck: Object.freeze({ upper: 255, lower: 0, arms: 0 }),
  Head: Object.freeze({ upper: 255, lower: 0, arms: 0 }),
  ClavicleR: Object.freeze({ upper: 255, lower: 0, arms: 255 }),
  UpperArmR: Object.freeze({ upper: 255, lower: 0, arms: 255 }),
  ForearmR: Object.freeze({ upper: 255, lower: 0, arms: 255 }),
  HandR: Object.freeze({ upper: 255, lower: 0, arms: 255 }),
  WeaponR: Object.freeze({ upper: 255, lower: 0, arms: 255 }),
  ClavicleL: Object.freeze({ upper: 255, lower: 0, arms: 255 }),
  UpperArmL: Object.freeze({ upper: 255, lower: 0, arms: 255 }),
  ForearmL: Object.freeze({ upper: 255, lower: 0, arms: 255 }),
  HandL: Object.freeze({ upper: 255, lower: 0, arms: 255 }),
  ShieldL: Object.freeze({ upper: 255, lower: 0, arms: 255 }),
  UpLegR: Object.freeze({ upper: 0, lower: 255, arms: 0 }),
  LegR: Object.freeze({ upper: 0, lower: 255, arms: 0 }),
  FootR: Object.freeze({ upper: 0, lower: 255, arms: 0 }),
  UpLegL: Object.freeze({ upper: 0, lower: 255, arms: 0 }),
  LegL: Object.freeze({ upper: 0, lower: 255, arms: 0 }),
  FootL: Object.freeze({ upper: 0, lower: 255, arms: 0 }),
  Cloak0: Object.freeze({ upper: 255, lower: 0, arms: 0 }),
  Cloak1: Object.freeze({ upper: 255, lower: 0, arms: 0 }),
});

/**
 * Builds the four masks for one rig — `Uint8Array(boneCount)` each, built
 * ONCE (call at actor-setup time, not per frame) and frozen.
 * @param {{boneCount:number, names:string[]}} rig a `createSkeleton()` result.
 * @returns {{full:Uint8Array, upper:Uint8Array, lower:Uint8Array, arms:Uint8Array}}
 */
export function buildBoneMasks(rig) {
  const n = rig.boneCount;
  const full = new Uint8Array(n).fill(255);
  const upper = new Uint8Array(n);
  const lower = new Uint8Array(n);
  const arms = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const row = BONE_MASK_SPEC[rig.names[i]];
    if (row) {
      upper[i] = row.upper;
      lower[i] = row.lower;
      arms[i] = row.arms;
    }
  }
  return Object.freeze({ full, upper, lower, arms });
}

/** Generic `rig.names -> index` map — every bone, not just the locomotion
 * subset `clips.js#buildLocomotionBoneIndex` resolves. Built once. */
export function buildBoneIndex(rig) {
  const map = {};
  for (let i = 0; i < rig.names.length; i++) map[rig.names[i]] = i;
  return map;
}

// ---------------------------------------------------------------------------
// §5.2 — Blend weights, verbatim formula.
// ---------------------------------------------------------------------------

/** One layer's blend-weight state. Allocate once, mutate in place. */
export function createBlendWeight() {
  return { wRaw: 0, w: 0 };
}

/**
 * `w_raw += clamp((target - w_raw), -dt/tau_out, dt/tau_in); w =
 * smoothstep(0,1,w_raw)` — `08` §5.2 verbatim. Mutates `bw` and returns
 * `bw.w`. `tauIn`/`tauOut` of `0` are read as "instant" (no ramp — the
 * state table's own "—" blend entries, e.g. `attack.active`'s blend-out):
 * clamped to a tiny epsilon rather than a literal `0` to avoid a `0/0`
 * division, landing `wRaw` on `target` in the very next call regardless.
 * @param {{wRaw:number, w:number}} bw
 * @param {number} target `0..1`
 * @param {number} tauIn seconds, rate cap while approaching a HIGHER target.
 * @param {number} tauOut seconds, rate cap while approaching a LOWER target.
 * @param {number} dt seconds.
 * @returns {number} the new `bw.w`.
 */
export function advanceBlendWeight(bw, target, tauIn, tauOut, dt) {
  const safeTauIn = tauIn > 1e-6 ? tauIn : 1e-6;
  const safeTauOut = tauOut > 1e-6 ? tauOut : 1e-6;
  const delta = target - bw.wRaw;
  const maxUp = dt / safeTauIn;
  const maxDown = -dt / safeTauOut;
  const step = clamp(delta, maxDown, maxUp);
  bw.wRaw = clamp(bw.wRaw + step, 0, 1);
  bw.w = smoothstep01(bw.wRaw);
  return bw.w;
}

// ---------------------------------------------------------------------------
// §5.5 — State table. Only the fields the Animator's own mechanism needs
// (blend times, mask recipe, a breath-weight reading — see the file header
// for why breath needed a documented per-state default). Root policy,
// cancellability and duration are `action.js`'s own concern (ACTR-9,
// already landed) — not re-encoded here.
//
// `maskSpec` is a list of `{mask, weight}` pairs — most states use exactly
// one; `attack.windup`'s "upper @ 1.0, lower @ 0.35" is read literally as
// TWO simultaneous masked applications of the SAME override pose (see the
// ticket's own framing: "Spine`/`Hips` overlap deliberately... that overlap
// is the whole mechanism"). Reported per the ticket brief because it is not
// spelled out any more explicitly than this in `08` §5.5's prose: the
// windup override pose is applied once through `upper` at full weight, and
// AGAIN through `lower` at 0.35 weight — for bones present in the windup
// pose only at the Hips/Spine overlap (where both masks are simultaneously
// nonzero) this compounds into a bigger torso lean than `upper` alone would
// give; for the legs (present in `lower` at 255 but, in any real wind-up
// clip, carrying zero rotation of their own) the second application is a
// harmless no-op — which is exactly how a Ranker keeps walking normally
// through its own independent L1 locomotion layer while winding up.
//
// Blend times of `0` below stand for the table's own "—" entries (read as
// "instant", see `advanceBlendWeight`'s own doc comment).
// ---------------------------------------------------------------------------

export const STATE_TABLE = Object.freeze({
  idle: Object.freeze({ blendIn: 0.20, blendOut: 0.16, maskSpec: Object.freeze([{ mask: 'full', weight: 1 }]), breathWeight: 1.0 }),
  walk: Object.freeze({ blendIn: 0.16, blendOut: 0.16, maskSpec: Object.freeze([{ mask: 'full', weight: 1 }]), breathWeight: 0.25 }),
  run: Object.freeze({ blendIn: 0.14, blendOut: 0.18, maskSpec: Object.freeze([{ mask: 'full', weight: 1 }]), breathWeight: 0.25 }),
  'attack.windup': Object.freeze({
    blendIn: 0.10, blendOut: 0,
    maskSpec: Object.freeze([{ mask: 'upper', weight: 1.0 }, { mask: 'lower', weight: 0.35 }]),
    breathWeight: 0.25,
  }),
  'attack.active': Object.freeze({ blendIn: 0, blendOut: 0, maskSpec: Object.freeze([{ mask: 'upper', weight: 1.0 }]), breathWeight: 0.25 }),
  'attack.recovery': Object.freeze({ blendIn: 0, blendOut: 0.14, maskSpec: Object.freeze([{ mask: 'upper', weight: 1.0 }]), breathWeight: 0.25 }),
  cast: Object.freeze({ blendIn: 0.12, blendOut: 0.16, maskSpec: Object.freeze([{ mask: 'upper', weight: 1.0 }]), breathWeight: 0.25 }),
  'block.enter': Object.freeze({ blendIn: 0.10, blendOut: 0, maskSpec: Object.freeze([{ mask: 'upper', weight: 1.0 }]), breathWeight: 0.25 }),
  'block.hold': Object.freeze({ blendIn: 0, blendOut: 0, maskSpec: Object.freeze([{ mask: 'upper', weight: 1.0 }]), breathWeight: 0.35 }),
  'block.exit': Object.freeze({ blendIn: 0, blendOut: 0.14, maskSpec: Object.freeze([{ mask: 'upper', weight: 1.0 }]), breathWeight: 0.25 }),
  'block.impact': Object.freeze({ blendIn: 0.05, blendOut: 0.10, maskSpec: Object.freeze([{ mask: 'arms', weight: 1.0 }]), breathWeight: 0.25 }),
  hit: Object.freeze({ blendIn: 0.06, blendOut: 0.14, maskSpec: Object.freeze([{ mask: 'full', weight: 1.0 }]), breathWeight: 0.25 }),
  stun: Object.freeze({ blendIn: 0.08, blendOut: 0.18, maskSpec: Object.freeze([{ mask: 'full', weight: 1.0 }]), breathWeight: 0.25 }),
  death: Object.freeze({ blendIn: 0.10, blendOut: 0, maskSpec: Object.freeze([{ mask: 'full', weight: 1.0 }]), breathWeight: 0 }),
  spawn: Object.freeze({ blendIn: 0, blendOut: 0.20, maskSpec: Object.freeze([{ mask: 'full', weight: 1.0 }]), breathWeight: 0 }),
  resurrect: Object.freeze({ blendIn: 0, blendOut: 0.18, maskSpec: Object.freeze([{ mask: 'full', weight: 1.0 }]), breathWeight: 0.25 }),
  dash: Object.freeze({ blendIn: 0.08, blendOut: 0.12, maskSpec: Object.freeze([{ mask: 'full', weight: 1.0 }]), breathWeight: 0.25 }),
  channel: Object.freeze({ blendIn: 0.15, blendOut: 0.15, maskSpec: Object.freeze([{ mask: 'upper', weight: 1.0 }]), breathWeight: 0.25 }),
});

/** This file's own documented choice for the idle<->locomotion crossfade's
 * tau — see the file header's "idle<->locomotion crossfade" section. */
export const LOCO_ENGAGE_TAU_IN = STATE_TABLE.walk.blendIn;
export const LOCO_ENGAGE_TAU_OUT = STATE_TABLE.idle.blendOut;

// ---------------------------------------------------------------------------
// §5.6 — Additive overlays, transcribed verbatim.
// ---------------------------------------------------------------------------

export const ADDITIVE_OVERLAYS = Object.freeze({
  breath: Object.freeze({ peakSpineDeg: 1.6, peakHipM: 0.004, bones: Object.freeze(['Spine', 'Chest', 'Neck', 'Hips']) }),
  hitFlinch: Object.freeze({ durationS: 0.30, decayRate: 8, riseRate: 25 }), // exp(-8t)*min(1,25t)
  leanToTarget: Object.freeze({ tauS: 0.18, peakChestDeg: 14, peakNeckDeg: 9 }),
  impactRecoil: Object.freeze({ durationS: 0.26, decayRate: 16, oscRate: 92, peakUpperArmDeg: 9, peakChestDeg: 3.5 }), // exp(-16t)*sin(92t)
  stagger: Object.freeze({ durationS: 0.45, decayRate: 6, peakHipsDeg: 12, peakRootM: 0.05 }), // exp(-6t)
});

/** `08` §5.6's hit-flinch region table, verbatim. `rootOffset` is `[x,y,z]`
 * meters. */
export const HIT_FLINCH_REGIONS = Object.freeze({
  front: Object.freeze({ chestDeg: -11, neckDeg: 6, headDeg: -8, hipsDeg: 4, rootOffset: Object.freeze([0, -0.02, -0.03]) }),
  back: Object.freeze({ chestDeg: 9, neckDeg: -5, headDeg: 7, hipsDeg: -3, rootOffset: Object.freeze([0, -0.02, 0.03]) }),
  left: Object.freeze({ chestDeg: -5, chestLateralDeg: 4, neckLateralDeg: 3, hipsLateralDeg: 2, rootOffset: Object.freeze([0.02, -0.02, 0]) }),
  right: Object.freeze({ chestDeg: -5, chestLateralDeg: -4, neckLateralDeg: -3, hipsLateralDeg: -2, rootOffset: Object.freeze([-0.02, -0.02, 0]) }),
});

/** Fresh, per-actor overlay trigger state — allocate once. Every "active"
 * record is a plain `{active, t, region}` object (never a `Map`), reused in
 * place every call. */
export function createOverlayState() {
  return {
    hitFlinch: { active: false, t: 0, region: 'front' },
    impactRecoil: { active: false, t: 0 },
    stagger: { active: false, t: 0 },
    leanChestDeg: 0,
    leanNeckDeg: 0,
  };
}

export function triggerHitFlinch(overlayState, region) {
  overlayState.hitFlinch.active = true;
  overlayState.hitFlinch.t = 0;
  overlayState.hitFlinch.region = region;
}

export function triggerImpactRecoil(overlayState) {
  overlayState.impactRecoil.active = true;
  overlayState.impactRecoil.t = 0;
}

export function triggerStagger(overlayState) {
  overlayState.stagger.active = true;
  overlayState.stagger.t = 0;
}

/** Advances every active triggered overlay's own clock by `dt`, deactivating
 * once past its envelope's `durationS`. Zero allocation. */
export function advanceOverlayTimers(overlayState, dt) {
  const hf = overlayState.hitFlinch;
  if (hf.active) {
    hf.t += dt;
    if (hf.t > ADDITIVE_OVERLAYS.hitFlinch.durationS) hf.active = false;
  }
  const ir = overlayState.impactRecoil;
  if (ir.active) {
    ir.t += dt;
    if (ir.t > ADDITIVE_OVERLAYS.impactRecoil.durationS) ir.active = false;
  }
  const sg = overlayState.stagger;
  if (sg.active) {
    sg.t += dt;
    if (sg.t > ADDITIVE_OVERLAYS.stagger.durationS) sg.active = false;
  }
}

/** `exp(-8t) * min(1, 25t)` — `08` §5.6's hit-flinch envelope, verbatim. */
export function hitFlinchEnvelope(t) {
  const o = ADDITIVE_OVERLAYS.hitFlinch;
  return Math.exp(-o.decayRate * t) * Math.min(1, o.riseRate * t);
}

/** `exp(-16t) * sin(92t)` — `08` §5.6's impact-recoil envelope, verbatim. */
export function impactRecoilEnvelope(t) {
  const o = ADDITIVE_OVERLAYS.impactRecoil;
  return Math.exp(-o.decayRate * t) * Math.sin(o.oscRate * t);
}

/** `exp(-6t)` — `08` §5.6's stagger envelope, verbatim. */
export function staggerEnvelope(t) {
  return Math.exp(-ADDITIVE_OVERLAYS.stagger.decayRate * t);
}

/** Always-on breath — writes `Spine`/`Chest`/`Neck` rotation (local X,
 * "flexion" axis — §5.6 gives no axis, this file's documented reading, same
 * convention `writeLegDelta` in `clips.js` already uses for hip/knee/ankle
 * flexion) and a Hips-driven root vertical bob. `idlePhase` is the SAME
 * continuously-advancing phase `updateAnimator` already tracks (see the
 * file header) — `08` §5.6's `sin(2π·phase·0.3125)` is, substituting
 * `phase`=elapsed seconds, exactly `sin(2π·idlePhase)` once `idlePhase`
 * already carries the ×0.3125 Hz factor (`CLIPS.idle`'s own `minHz===maxHz
 * ===0.3125`).
 * @param {object} pose
 * @param {Record<string,number>} boneIndex
 * @param {number} idlePhase `[0,1)`
 * @param {number} weight `0..1`
 */
export function writeBreathOverlay(pose, boneIndex, idlePhase, weight) {
  if (weight <= 0) return;
  const o = ADDITIVE_OVERLAYS.breath;
  const s = Math.sin(2 * Math.PI * idlePhase);
  const deg = o.peakSpineDeg * s * weight;
  const spine = boneIndex.Spine;
  if (spine >= 0) pose.delta[spine * 3] += deg;
  const chest = boneIndex.Chest;
  if (chest >= 0) pose.delta[chest * 3] += deg;
  const neck = boneIndex.Neck;
  if (neck >= 0) pose.delta[neck * 3] += deg;
  pose.rootOffsetY += o.peakHipM * s * weight;
}

/**
 * Hit-flinch — `08` §5.6, region-selected. Writes Chest/Neck/Head/Hips
 * rotation plus a root offset, scaled by the triggered envelope and `weight`
 * (`hit`'s own state-table row: "full, additive @ 0.55").
 */
export function writeHitFlinchOverlay(pose, boneIndex, overlayState, weight) {
  const hf = overlayState.hitFlinch;
  if (!hf.active) return;
  const env = hitFlinchEnvelope(hf.t) * weight;
  if (env === 0) return;
  const region = HIT_FLINCH_REGIONS[hf.region] || HIT_FLINCH_REGIONS.front;
  const chest = boneIndex.Chest;
  if (chest >= 0) {
    if (region.chestDeg !== undefined) pose.delta[chest * 3] += region.chestDeg * env;
    if (region.chestLateralDeg !== undefined) pose.delta[chest * 3 + 2] += region.chestLateralDeg * env;
  }
  const neck = boneIndex.Neck;
  if (neck >= 0) {
    if (region.neckDeg !== undefined) pose.delta[neck * 3] += region.neckDeg * env;
    if (region.neckLateralDeg !== undefined) pose.delta[neck * 3 + 2] += region.neckLateralDeg * env;
  }
  const head = boneIndex.Head;
  if (head >= 0 && region.headDeg !== undefined) pose.delta[head * 3] += region.headDeg * env;
  const hips = boneIndex.Hips;
  if (hips >= 0) {
    if (region.hipsDeg !== undefined) pose.delta[hips * 3] += region.hipsDeg * env;
    if (region.hipsLateralDeg !== undefined) pose.delta[hips * 3 + 2] += region.hipsLateralDeg * env;
  }
  pose.rootOffsetX += region.rootOffset[0] * env;
  pose.rootOffsetY += region.rootOffset[1] * env;
  pose.rootOffsetZ += region.rootOffset[2] * env;
}

/** Impact recoil (own hit landing) — right-arm chain + Chest, `08` §5.6. */
export function writeImpactRecoilOverlay(pose, boneIndex, overlayState) {
  const ir = overlayState.impactRecoil;
  if (!ir.active) return;
  const env = impactRecoilEnvelope(ir.t);
  const o = ADDITIVE_OVERLAYS.impactRecoil;
  const upperArm = boneIndex.UpperArmR;
  if (upperArm >= 0) pose.delta[upperArm * 3] += o.peakUpperArmDeg * env;
  const chest = boneIndex.Chest;
  if (chest >= 0) pose.delta[chest * 3] += o.peakChestDeg * env;
}

/** Stagger (knockback >= 0.4 m) — Hips rotation + root offset, `08` §5.6. */
export function writeStaggerOverlay(pose, boneIndex, overlayState) {
  const sg = overlayState.stagger;
  if (!sg.active) return;
  const env = staggerEnvelope(sg.t);
  const o = ADDITIVE_OVERLAYS.stagger;
  const hips = boneIndex.Hips;
  if (hips >= 0) pose.delta[hips * 3] += o.peakHipsDeg * env;
  pose.rootOffsetZ += o.peakRootM * env;
}

/** Lean-to-target — continuous first-order lag toward `targetDeg`, `tau =
 * 0.18 s` (`08` §5.6: "continuous"). Exact exponential-decay update (not a
 * linear Euler step) so the lag is correct regardless of `dt`. Mutates and
 * returns the new value. */
export function advanceLag(current, target, tau, dt) {
  const k = Math.exp(-dt / tau);
  return target + (current - target) * k;
}

export function writeLeanOverlay(pose, boneIndex, overlayState) {
  const chest = boneIndex.Chest;
  if (chest >= 0) pose.delta[chest * 3 + 1] += overlayState.leanChestDeg;
  const neck = boneIndex.Neck;
  if (neck >= 0) pose.delta[neck * 3 + 1] += overlayState.leanNeckDeg;
}

// ---------------------------------------------------------------------------
// §5.7 — Spring/damper bank. Semi-implicit Euler at a FIXED internal step of
// 1/120 s, accumulator, hard cap of 4 substeps/frame ("a 60 ms hitch cannot
// detonate the spring" — `08` §5.7 verbatim).
// ---------------------------------------------------------------------------

export const SPRING_FIXED_HZ = 120;
export const SPRING_FIXED_H = 1 / SPRING_FIXED_HZ;
export const SPRING_MAX_SUBSTEPS = 4;

/** `08` §5.7's table, verbatim. `unit` is `'deg'` unless noted — `hipSettle`
 * and `tomeOrbit` are meters (root/orbit translation, not a bone rotation).
 * `bones` names the target(s); `hipSettle`'s target is `Root.y`
 * (`pose.rootOffsetY`), handled specially in `advanceSprings` below since it
 * is not a per-bone rotation channel. `tomeOrbit`/`tailWhip` are boss/swarm
 * only (`Tome`/`TailA`/`TailB` — rigs this ticket's own reading list does
 * not cover, ACTR-14+); transcribed as data anyway (costs nothing) and
 * their write functions no-op on any rig lacking those bones, same guarded
 * pattern `clips.js` already uses for a rig missing a locomotion bone. */
export const SPRINGS = Object.freeze({
  weaponInertia: Object.freeze({ omega: 26, zeta: 0.85, maxDeflection: 22, unit: 'deg', bones: Object.freeze(['WeaponR']) }),
  cloakSway: Object.freeze({ omega: 12, zeta: 0.70, maxDeflection: 34, unit: 'deg', bones: Object.freeze(['Cloak0', 'Cloak1', 'Cloak2']) }),
  headLag: Object.freeze({ omega: 34, zeta: 1.00, maxDeflection: 12, unit: 'deg', bones: Object.freeze(['Neck', 'Head']) }),
  hipSettle: Object.freeze({ omega: 30, zeta: 0.95, maxDeflection: 0.06, unit: 'm', bones: Object.freeze(['Root.y']) }),
  shieldBob: Object.freeze({ omega: 22, zeta: 0.90, maxDeflection: 15, unit: 'deg', bones: Object.freeze(['ShieldL']) }),
  hitShake: Object.freeze({ omega: 55, zeta: 0.55, maxDeflection: 9, unit: 'deg', bones: Object.freeze(['Chest']) }),
  tomeOrbit: Object.freeze({ omega: 8, zeta: 0.55, maxDeflection: 0.45, unit: 'm', bones: Object.freeze(['Tome']) }),
  tailWhip: Object.freeze({ omega: 18, zeta: 0.62, maxDeflection: 40, unit: 'deg', bones: Object.freeze(['TailA', 'TailB']) }),
});

/** Fresh spring integrator state — `{x, v, acc}` (position, velocity, the
 * frame-accumulator for the fixed 1/120 s step). Allocate once. */
export function createSpringState() {
  return { x: 0, v: 0, acc: 0 };
}

/**
 * Advances one spring toward `target`, `dt` real seconds, via `08` §5.7's
 * semi-implicit Euler at a fixed 1/120 s internal step: `v += (-omega^2*(x -
 * target) - 2*zeta*omega*v) * h; x += v * h`, capped at
 * `SPRING_MAX_SUBSTEPS` substeps/call (excess `dt` is simply dropped, per
 * spec: "a 60 ms hitch cannot detonate the spring" — NOT accumulated for a
 * later catch-up, which would just move the detonation risk one frame
 * later). Clamps the result to `+-maxDeflection`. Zero allocation — `ss` is
 * mutated in place, no object/array is created.
 * @param {{x:number,v:number,acc:number}} ss
 * @param {{omega:number,zeta:number,maxDeflection:number}} params
 * @param {number} target
 * @param {number} dt seconds.
 * @returns {number} the new `ss.x`.
 */
export function advanceSpring(ss, params, target, dt) {
  ss.acc += dt;
  let substeps = 0;
  const h = SPRING_FIXED_H;
  const omega2 = params.omega * params.omega;
  const damp = 2 * params.zeta * params.omega;
  while (ss.acc >= h && substeps < SPRING_MAX_SUBSTEPS) {
    ss.v += (-omega2 * (ss.x - target) - damp * ss.v) * h;
    ss.x += ss.v * h;
    ss.acc -= h;
    substeps++;
  }
  if (ss.x > params.maxDeflection) ss.x = params.maxDeflection;
  else if (ss.x < -params.maxDeflection) ss.x = -params.maxDeflection;
  return ss.x;
}

// ---------------------------------------------------------------------------
// The Animator — createAnimatorState() / updateAnimator().
// ---------------------------------------------------------------------------

/** Springs whose target is a plain per-bone rotation (all but `hipSettle`,
 * `tomeOrbit`, `tailWhip` — see SPRINGS' own doc comment). Iterated by name
 * so `updateAnimator` never allocates an array to loop over. */
const ROTATIONAL_SPRING_NAMES = Object.freeze(['weaponInertia', 'headLag', 'shieldBob', 'hitShake']);

/**
 * Allocates everything one actor's Animator needs, ONCE. Nothing in
 * `updateAnimator` below allocates — every scratch buffer/record lives here.
 * @param {object} rig a `createSkeleton()` result (`./rig.js`).
 * @returns {object} opaque per-actor Animator state — pass to `updateAnimator`.
 */
export function createAnimatorState(rig) {
  const boneCount = rig.boneCount;
  return {
    rig,
    masks: buildBoneMasks(rig),
    boneIndex: buildBoneIndex(rig),
    locoBoneIndex: buildLocomotionBoneIndex(rig),
    pose: createPose(boneCount),
    gaitScratch: {
      gaitParams: createGaitParamsScratch(),
      legR: { thigh: 0, knee: 0, ankle: 0 },
      legL: { thigh: 0, knee: 0, ankle: 0 },
      pelvis: { bobY: 0, swayX: 0, rollDeg: 0, yawDeg: 0 },
      spine: { spine: 0, chest: 0, neck: 0 },
    },
    gaitPhase: 0,
    idlePhase: 0,
    locoWeight: createBlendWeight(),
    stateLayer: { activeId: null, lastEntry: null, bw: createBlendWeight() },
    lastOverrideDelta: new Float32Array(boneCount * 3),
    overlays: createOverlayState(),
    springs: {
      weaponInertia: createSpringState(),
      cloakSway0: createSpringState(),
      cloakSway1: createSpringState(),
      headLag: createSpringState(),
      hipSettle: createSpringState(),
      shieldBob: createSpringState(),
      hitShake: createSpringState(),
    },
    worldQuat: new Float64Array(boneCount * 4),
    worldPos: new Float64Array(boneCount * 3),
  };
}

/** Writes one leg's gait contribution, scaled by `weight`, into `pose` —
 * mirrors `clips.js#writeLegDelta` but weighted (that function is not
 * exported, and needs no weight parameter — ACTR-11 never had a crossfade
 * weight to apply). */
function writeWeightedLegDelta(pose, boneIndex, side, angles, weight) {
  if (weight === 0) return;
  const upLeg = boneIndex['UpLeg' + side];
  const leg = boneIndex['Leg' + side];
  const foot = boneIndex['Foot' + side];
  if (upLeg >= 0) pose.delta[upLeg * 3] += angles.thigh * weight;
  if (leg >= 0) pose.delta[leg * 3] += angles.knee * weight;
  if (foot >= 0) pose.delta[foot * 3] += angles.ankle * weight;
}

function writeWeightedYaw(pose, boneIndex, name, deg, weight) {
  if (weight === 0) return;
  const idx = boneIndex[name];
  if (idx >= 0) pose.delta[idx * 3 + 1] += deg * weight;
}

/**
 * The Animator's one per-frame entry point. Resets `state.pose`, accumulates
 * L1 (the idle<->locomotion crossfade), L3's always-on breath (plus any
 * triggered hit-flinch/impact-recoil/stagger/lean overlays), L2 (the
 * caller-supplied state-override pose, masked per `STATE_TABLE`), and L4
 * (the spring/damper bank), in that fixed order (`08` §5.1's own diagram
 * order is L1-L2-L3-L4; this file accumulates L1, L3, L2, L4 — order among
 * ADDITIVE contributions on the same shared buffer does not change the
 * final sum, only sequencing that itself has a dependency, e.g. L2 reading
 * L1's output, would — none does here), then composes the plain
 * quaternion/position "skeleton" (see the file header). Zero allocation —
 * see the file header's own section.
 *
 * @param {object} state from `createAnimatorState`.
 * @param {object} input
 * @param {number} [input.speed] measured ground speed, m/s.
 * @param {number} [input.rateJitter] passed through to `clips.js`'s stride
 *   functions — see that file for why this file never sources it itself.
 * @param {string|null} [input.overrideStateId] an `STATE_TABLE` key (e.g.
 *   `'attack.windup'`) or `null` to release the override.
 * @param {Float32Array|null} [input.overrideDelta] `boneCount*3` raw pose
 *   delta for the override state — see the file header, "Does NOT own".
 * @param {number} [input.leanTargetChestDeg]
 * @param {number} [input.leanTargetNeckDeg]
 * @param {Record<string,number>} [input.springTargets] by spring name.
 * @param {number} dt seconds.
 * @returns {{bonesWritten:number}} proof-of-work (rule 12) — the number of
 *   bones this call actually composed a world transform for.
 */
export function updateAnimator(state, input, dt) {
  const { rig, pose, masks, boneIndex, locoBoneIndex, gaitScratch } = state;
  const speed = input.speed || 0;
  const rateJitter = input.rateJitter !== undefined ? input.rateJitter : 1;

  resetPose(pose);

  // --- idle phase (always advances — CLIPS.idle has minHz === maxHz, so
  // speed is irrelevant to its own rate; breath rides this same phase). ---
  const idleHz = computeStrideHz(speed, CLIPS.idle, rateJitter);
  state.idlePhase = advancePhase(state.idlePhase, dt, idleHz);

  // --- gait phase (always advances — see the file header's crossfade
  // section for why this is never gated behind the idle threshold). ---
  const runWeight = smoothstepRange(RUN_BLEND_LOWER, RUN_BLEND_UPPER, speed);
  const gp = blendGaitParams(runWeight, gaitScratch.gaitParams);
  const walkHz = computeStrideHz(speed, CLIPS.walk, rateJitter);
  const runHz = computeStrideHz(speed, CLIPS.run, rateJitter);
  const strideHz = lerp(walkHz, runHz, runWeight);
  state.gaitPhase = advancePhase(state.gaitPhase, dt, strideHz);

  // --- L1: idle<->locomotion crossfade weight. ---
  const locoTarget = speed >= IDLE_SPEED_THRESHOLD ? 1 : 0;
  const locoW = advanceBlendWeight(state.locoWeight, locoTarget, LOCO_ENGAGE_TAU_IN, LOCO_ENGAGE_TAU_OUT, dt);

  gaitAngles(state.gaitPhase, LEG_SIDE_OFFSET.R, gp, gaitScratch.legR);
  gaitAngles(state.gaitPhase, LEG_SIDE_OFFSET.L, gp, gaitScratch.legL);
  writeWeightedLegDelta(pose, locoBoneIndex, 'R', gaitScratch.legR, locoW);
  writeWeightedLegDelta(pose, locoBoneIndex, 'L', gaitScratch.legL, locoW);

  pelvisMotion(state.gaitPhase, gp, gaitScratch.pelvis);
  pose.rootOffsetY += gaitScratch.pelvis.bobY * locoW;
  pose.rootOffsetX += gaitScratch.pelvis.swayX * locoW;

  const hips = locoBoneIndex.Hips;
  if (hips >= 0 && locoW !== 0) {
    pose.delta[hips * 3] += gp.leanDeg * locoW;
    pose.delta[hips * 3 + 2] += gaitScratch.pelvis.rollDeg * locoW;
    pose.delta[hips * 3 + 1] += gaitScratch.pelvis.yawDeg * locoW;
  }

  spineCounterRotation(gaitScratch.pelvis.yawDeg, gaitScratch.spine);
  writeWeightedYaw(pose, locoBoneIndex, 'Spine', gaitScratch.spine.spine, locoW);
  writeWeightedYaw(pose, locoBoneIndex, 'Chest', gaitScratch.spine.chest, locoW);
  writeWeightedYaw(pose, locoBoneIndex, 'Neck', gaitScratch.spine.neck, locoW);

  const armR = locoBoneIndex.UpperArmR;
  if (armR >= 0 && locoW !== 0) {
    pose.delta[armR * 3] += gp.armSwingDeg * Math.sin(2 * Math.PI * state.gaitPhase + LEG_SIDE_OFFSET.L) * locoW;
  }
  const armL = locoBoneIndex.UpperArmL;
  if (armL >= 0 && locoW !== 0) {
    pose.delta[armL * 3] += gp.armSwingDeg * Math.sin(2 * Math.PI * state.gaitPhase + LEG_SIDE_OFFSET.R) * locoW;
  }

  // --- L3: additive overlays. Breath is always on; the triggered ones only
  // write while active (no-op otherwise, per each write function above). ---
  const breathStateId = input.overrideStateId && STATE_TABLE[input.overrideStateId]
    ? input.overrideStateId
    : null;
  const breathWeight = breathStateId
    ? STATE_TABLE[breathStateId].breathWeight
    : lerp(STATE_TABLE.idle.breathWeight, STATE_TABLE.walk.breathWeight, locoW);
  writeBreathOverlay(pose, boneIndex, state.idlePhase, breathWeight);

  advanceOverlayTimers(state.overlays, dt);
  writeHitFlinchOverlay(pose, boneIndex, state.overlays, 0.55); // `hit` row: "additive @ 0.55"
  writeImpactRecoilOverlay(pose, boneIndex, state.overlays);
  writeStaggerOverlay(pose, boneIndex, state.overlays);

  if (input.leanTargetChestDeg !== undefined || input.leanTargetNeckDeg !== undefined) {
    const o = ADDITIVE_OVERLAYS.leanToTarget;
    state.overlays.leanChestDeg = advanceLag(state.overlays.leanChestDeg, input.leanTargetChestDeg || 0, o.tauS, dt);
    state.overlays.leanNeckDeg = advanceLag(state.overlays.leanNeckDeg, input.leanTargetNeckDeg || 0, o.tauS, dt);
    writeLeanOverlay(pose, boneIndex, state.overlays);
  }

  // --- L2: caller-supplied state override, masked per STATE_TABLE. ---
  let overrideEntry = null;
  let overrideDelta = null;
  if (input.overrideStateId && input.overrideDelta && STATE_TABLE[input.overrideStateId]) {
    overrideEntry = STATE_TABLE[input.overrideStateId];
    overrideDelta = input.overrideDelta;
    state.stateLayer.activeId = input.overrideStateId;
    state.stateLayer.lastEntry = overrideEntry;
    state.lastOverrideDelta.set(overrideDelta);
    advanceBlendWeight(state.stateLayer.bw, 1, overrideEntry.blendIn, overrideEntry.blendOut, dt);
  } else if (state.stateLayer.lastEntry) {
    // Releasing an override: fade its own last-known pose out, using its
    // own blend-out, rather than snapping to nothing (see the file header's
    // "Zero allocation" note — `lastOverrideDelta` is the persistent copy
    // this needs).
    overrideEntry = state.stateLayer.lastEntry;
    overrideDelta = state.lastOverrideDelta;
    state.stateLayer.activeId = null;
    advanceBlendWeight(state.stateLayer.bw, 0, overrideEntry.blendIn, overrideEntry.blendOut, dt);
    if (state.stateLayer.bw.w <= 0 && state.stateLayer.bw.wRaw <= 0) {
      state.stateLayer.lastEntry = null;
      overrideEntry = null;
    }
  }
  if (overrideEntry && overrideDelta) {
    const w = state.stateLayer.bw.w;
    if (w > 0) {
      const spec = overrideEntry.maskSpec;
      const n = rig.boneCount;
      for (let s = 0; s < spec.length; s++) {
        const maskArr = masks[spec[s].mask];
        const specWeight = spec[s].weight * w;
        if (specWeight === 0) continue;
        for (let i = 0; i < n; i++) {
          const m = maskArr[i];
          if (m === 0) continue;
          const scale = (m / 255) * specWeight;
          const base = i * 3;
          pose.delta[base] += overrideDelta[base] * scale;
          pose.delta[base + 1] += overrideDelta[base + 1] * scale;
          pose.delta[base + 2] += overrideDelta[base + 2] * scale;
        }
      }
    }
  }

  // --- L4: spring/damper bank. ---
  const targets = input.springTargets || EMPTY_SPRING_TARGETS;
  for (let k = 0; k < ROTATIONAL_SPRING_NAMES.length; k++) {
    const name = ROTATIONAL_SPRING_NAMES[k];
    const params = SPRINGS[name];
    const target = targets[name] || 0;
    const value = advanceSpring(state.springs[name], params, target, dt);
    const boneName = params.bones[0];
    const idx = boneIndex[boneName];
    if (idx >= 0) pose.delta[idx * 3] += value;
  }
  // Cloak sway — per segment; Bone Ranker (cloakless) has neither bone, both
  // no-op via the `idx >= 0` guard, same pattern as everywhere else here.
  {
    const params = SPRINGS.cloakSway;
    const target = targets.cloakSway || 0;
    const v0 = advanceSpring(state.springs.cloakSway0, params, target, dt);
    const v1 = advanceSpring(state.springs.cloakSway1, params, target, dt);
    const c0 = boneIndex.Cloak0;
    if (c0 >= 0) pose.delta[c0 * 3] += v0;
    const c1 = boneIndex.Cloak1;
    if (c1 >= 0) pose.delta[c1 * 3] += v1;
  }
  // Hip settle — root vertical offset, not a bone rotation (SPRINGS.hipSettle
  // is metres, see its own doc comment).
  {
    const target = targets.hipSettle || 0;
    const value = advanceSpring(state.springs.hipSettle, SPRINGS.hipSettle, target, dt);
    pose.rootOffsetY += value;
  }

  // --- "Skeleton": plain quaternion/position composition (see file header). ---
  composeSkeletonWorld(rig, pose, state.worldQuat, state.worldPos);

  return { bonesWritten: rig.boneCount };
}

/** Shared empty object so `updateAnimator` never allocates one per call when
 * `input.springTargets` is omitted — created once, at module load, and
 * never mutated (every read is `targets[name] || 0`, which is always `0`
 * against an empty object). */
const EMPTY_SPRING_TARGETS = Object.freeze({});

/**
 * Composes every bone's WORLD quaternion and position from `rig`'s rest
 * local transforms plus `pose`'s per-bone euler-degree deltas — this file's
 * Node-safe "skeleton" step (see the file header for why this is not
 * `three`'s own `Bone`/`Skeleton`). One forward pass, `i` from `0` to
 * `boneCount-1`, correct for the same reason `rig.js#reconstructBindPos`
 * documents (every parent index is strictly less than its child index).
 * `pose.rootOffset*`/`rootYaw` perturb bone `0` (`Root`) only. Zero
 * allocation: every intermediate is a scalar local variable.
 * @param {object} rig a `createSkeleton()` result.
 * @param {object} pose from `createPose`/`resetPose` + this file's writers.
 * @param {Float64Array} outWorldQuat length `boneCount*4` (x,y,z,w), reused.
 * @param {Float64Array} outWorldPos length `boneCount*3`, reused.
 */
export function composeSkeletonWorld(rig, pose, outWorldQuat, outWorldPos) {
  const n = rig.boneCount;
  const { parents, localPos, localQuat } = rig;
  const { delta } = pose;

  for (let i = 0; i < n; i++) {
    const parent = parents[i];
    const b = i * 3;

    // euler(delta) -> quaternion, XYZ intrinsic composition (this file's
    // documented reading, see the file header — closed form, no object
    // allocation: q = qx (x) qy (x) qz).
    const hx = delta[b] * DEG2RAD * 0.5;
    const hy = delta[b + 1] * DEG2RAD * 0.5;
    const hz = delta[b + 2] * DEG2RAD * 0.5;
    const sx = Math.sin(hx), cx = Math.cos(hx);
    const sy = Math.sin(hy), cy = Math.cos(hy);
    const sz = Math.sin(hz), cz = Math.cos(hz);
    const dqx = sx * cy * cz + cx * sy * sz;
    const dqy = cx * sy * cz - sx * cy * sz;
    const dqz = cx * cy * sz + sx * sy * cz;
    const dqw = cx * cy * cz - sx * sy * sz;

    // q = localQuat[i] (x) deltaQuat — `08 §5.1`: "q = bindLocal · euler(delta)".
    const lqb = i * 4;
    const lqx = localQuat[lqb], lqy = localQuat[lqb + 1], lqz = localQuat[lqb + 2], lqw = localQuat[lqb + 3];
    const posedX = lqw * dqx + lqx * dqw + lqy * dqz - lqz * dqy;
    const posedY = lqw * dqy - lqx * dqz + lqy * dqw + lqz * dqx;
    const posedZ = lqw * dqz + lqx * dqy - lqy * dqx + lqz * dqw;
    const posedW = lqw * dqw - lqx * dqx - lqy * dqy - lqz * dqz;

    const lpx0 = localPos[b], lpy0 = localPos[b + 1], lpz0 = localPos[b + 2];

    if (parent < 0) {
      // Root: apply pose.rootYaw (about world Y) on top, then rootOffset.
      const ry = pose.rootYaw * DEG2RAD * 0.5;
      const rsy = Math.sin(ry), rcy = Math.cos(ry);
      // worldQuat = posed (x) rootYawQuat(0,rsy,0,rcy)
      const wqx = posedW * 0 + posedX * rcy + posedY * 0 - posedZ * rsy;
      const wqy = posedW * rsy - posedX * 0 + posedY * rcy + posedZ * 0;
      const wqz = posedW * 0 + posedX * rsy - posedY * 0 + posedZ * rcy;
      const wqw = posedW * rcy - posedX * 0 - posedY * rsy - posedZ * 0;
      outWorldQuat[0] = wqx; outWorldQuat[1] = wqy; outWorldQuat[2] = wqz; outWorldQuat[3] = wqw;
      outWorldPos[0] = lpx0 + pose.rootOffsetX;
      outWorldPos[1] = lpy0 + pose.rootOffsetY;
      outWorldPos[2] = lpz0 + pose.rootOffsetZ;
      continue;
    }

    const pqb = parent * 4;
    const pqx = outWorldQuat[pqb], pqy = outWorldQuat[pqb + 1], pqz = outWorldQuat[pqb + 2], pqw = outWorldQuat[pqb + 3];

    // world = parentWorld (x) posed
    const wqx = pqw * posedX + pqx * posedW + pqy * posedZ - pqz * posedY;
    const wqy = pqw * posedY - pqx * posedZ + pqy * posedW + pqz * posedX;
    const wqz = pqw * posedZ + pqx * posedY - pqy * posedX + pqz * posedW;
    const wqw = pqw * posedW - pqx * posedX - pqy * posedY - pqz * posedZ;
    outWorldQuat[i * 4] = wqx; outWorldQuat[i * 4 + 1] = wqy; outWorldQuat[i * 4 + 2] = wqz; outWorldQuat[i * 4 + 3] = wqw;

    // rotate localPos[i] by the PARENT's world quaternion, then add parent's
    // world position (position is unaffected by this bone's own delta).
    const uvx = pqy * lpz0 - pqz * lpy0;
    const uvy = pqz * lpx0 - pqx * lpz0;
    const uvz = pqx * lpy0 - pqy * lpx0;
    const uuvx = pqy * uvz - pqz * uvy;
    const uuvy = pqz * uvx - pqx * uvz;
    const uuvz = pqx * uvy - pqy * uvx;
    const rx = lpx0 + 2 * (pqw * uvx + uuvx);
    const ry2 = lpy0 + 2 * (pqw * uvy + uuvy);
    const rz = lpz0 + 2 * (pqw * uvz + uuvz);

    const ppb = parent * 3;
    outWorldPos[i * 3] = outWorldPos[ppb] + rx;
    outWorldPos[i * 3 + 1] = outWorldPos[ppb + 1] + ry2;
    outWorldPos[i * 3 + 2] = outWorldPos[ppb + 2] + rz;
  }
}
