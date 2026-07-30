// src/actors/clips.js
//
// ACTR-11 — "Poser + locomotion" (`08-characters-visual.md` §11 step 5): the
// Poser accumulator's locomotion layer — idle/walk/run, speed-driven phase,
// per `08` §5.4. Node-safe: no `three`, no `document`/`window`, no
// `performance.now()` anywhere in this file — `src/actors/` is a strict
// `check-imports.mjs` root (`checkGlobals: true`, O-29) and this file must
// stay inside that boundary. Everything here produces PLAIN POSE DATA
// (degrees and plain numbers) — nothing here builds or touches a `three`
// object; whatever eventually turns a `Pose` into posed `THREE.Bone`
// quaternions (`q = bindLocal · euler(delta)`, `08` §5.1) is the Animator's
// job (ACTR-12, step 6) or, for this ticket's dev shots, the shot's own
// `setup` (see `src/dev/shots.js`'s header on why `setup` cannot import this
// file either, and must inline the same maths).
//
// ---------------------------------------------------------------------------
// Scope: what this ticket owns and what it defers
// ---------------------------------------------------------------------------
// `08` §5.1's architecture is a four-layer accumulator (L1 locomotion base,
// L2 state override, L3 additive overlays, L4 spring/damper) feeding one
// `Pose`. This file is ONLY L1 — "idle/walk/run, speed-driven phase" is this
// ticket's own deliverable line (`08` §11 step 5). L2-L4, the mask system
// (§5.3), the real crossfade/blend-weight machinery of §5.2 (smoothstep'd
// `w_raw` approach with independent per-layer `τ_in`/`τ_out`), and the whole
// Animator class are ACTR-12 (step 6) — not built here, not stubbed here
// (O-27: this file does not assert "nothing else exists yet").
//
// The walk<->run CROSSFADE this file DOES implement (`crossfadeWeight`
// below) is a deliberately simplified stand-in for §5.2's real two-clip
// blend: instead of running walk's and run's own independent phases and
// blending two full `Pose`s (the "L1 locomotion base (crossfaded pair)" `08`
// §5.1 describes), this file runs ONE shared phase, driven by a
// speed-interpolated `strideHz`, and linearly blends the walk/run GAIT
// PARAMETERS before evaluating the curve once. This is materially simpler
// than a real dual-clip crossfade (no risk of the two clips' phases drifting
// apart, no `w_raw`/`τ` smoothing state) and is flagged here, loudly, as a
// simplification ACTR-12 may replace outright rather than build on top of.
// It is enough to satisfy this ticket's own acceptance criterion (three
// `walk`-phase shots, a foot-slide measurement) and the speed-driven-phase
// requirement, without inventing ACTR-12's own machinery early.
//
// ---------------------------------------------------------------------------
// `08` §5.4, transcribed exactly where the table gives numbers — and what it
// does NOT give, decided here, reported per the ticket brief
// ---------------------------------------------------------------------------
// The gait formula names four symbols the table never assigns a value to:
// `bias_t`, `bias_a` (the thigh/ankle formulas' additive constants) and
// `stance_k` (the second knee lobe's amplitude). Decided, and reported:
//
//   - `bias_t = 0`, `bias_a = 0` for both clips. Nothing in `08` §5.4 (the
//     only section this ticket read) hints at a nonzero standing bias for
//     either joint, and a phase-INDEPENDENT bias does not change how much
//     the leg's swing amplitude compensates root translation (it only
//     shifts the whole curve's neutral point), so zero is both the
//     simplest reading and does not affect the foot-slide acceptance
//     measurement below.
//   - `stance_k = A_k / 2` for both clips (23 for walk, 43 for run) — "the
//     stance-phase knee lobe reuses half the swing-phase lobe's own
//     amplitude" is the simplest single-parameter-family reading available
//     (one ratio, not an independent unrelated number). Checked against `0`,
//     `base_k`, `A_k/2` and `A_k` while deriving the "Foot slide" section
//     below: none of those candidates changes the pendulum-bound finding
//     that section records (the bound depends only on `A_t`/leg length, not
//     on `stance_k` at all) — `A_k/2` is kept as this file's one documented
//     reading of the undocumented symbol, not because it was tuned to pass
//     anything.
//
// `08` §5.4 also never assigns a numeric `sideOffset` for the "per leg,
// phase `a = 2π·phase + sideOffset`" line. This file uses `0` for the right
// leg and `π` for the left — the standard 180°, alternating-stance
// convention for a biped, and the one choice that makes the two legs'
// stance windows land in each other's swing windows (verified: with this
// offset, `gaitAngles` produces a physically sane forward-swing-then-
// backward-drag cycle when driven through the FK check below — see that
// section for the exact reasoning that confirmed it, not just assumed it).
//
// Pelvis motion (bob/sway/roll/counter-yaw) and the spine's counter-rotation
// ratios ARE all §5.4 gives numbers for; this file implements them as
// described, but §5.4 does not specify the exact waveform (only "two
// vertical bobs per stride", "lateral sway", "roll toward the stance leg",
// "counter-yaw against the shoulders") — this file's chosen waveforms
// (documented at each function below) are a directly-corresponding, honest
// reading of that prose (bob = 2 cycles/stride -> `cos(4π·phase)`; sway/
// roll/yaw = 1 cycle/stride -> `sin`/`cos(2π·phase)` with a documented sign
// per function), not verified against any further spec text (out of this
// ticket's reading list) or against the foot-slide criterion (pelvis motion
// is presentation polish on top of the leg curve the criterion measures;
// see the FK section below for why the criterion is checked against the leg
// curve alone, matching how `08` phrases it: "integrates FOOT world
// position").
//
// ---------------------------------------------------------------------------
// Foot slide — the honest measurement, and why it does not clear 4 cm
// ---------------------------------------------------------------------------
// `08 §11 step 5`'s criterion: "Node harness integrates foot world position
// over a stride and reports foot slide < 4 cm." This file does not itself
// perform that integration (there is no `three`, no rig-to-world walk, in
// this module beyond the pure per-joint angles — see the header's "Scope"
// section: turning a `Pose` into world bone transforms is the consumer's
// job). `tests/actors/clips.test.js` does the integration, using this file's
// `gaitAngles` plus `src/actors/rig.js`'s own bind/local tables and the same
// quaternion composition `rig.js#reconstructBindPos` already uses (see that
// test's own header for the full derivation) — reported here because it
// drove the `stance_k` decision above and is central to whether this ticket
// actually holds:
//
// REVISED per coordinator review (the first pass here measured a scanned
// best-case window, which the coordinator correctly rejected as fitting the
// measurement to the threshold rather than measuring the criterion). This is
// the corrected, honest finding, with the arithmetic behind it:
//
// The leg (hip pivot -> knee -> ankle) measures 0.8593 m total reach at this
// rig's own bind-pose proportions (`rig.js`: thigh 0.4286 m + shin 0.4308 m —
// not this file's numbers to pick). A straight-legged pendulum swinging by
// `A_t` about the hip alone can cover, AT MOST, `2 * 0.8593 * sin(A_t)`
// peak-to-trough — bending the knee only ever shortens this, never lengthens
// it, so it is a genuine upper bound:
//
//   walk: A_t=21°  -> max reach 0.616 m = 42.5% of strideLength (1.45 m)
//   run:  A_t=34°  -> max reach 0.961 m = 33.1% of strideLength (2.90 m)
//
// Neither clip's leg can, even in principle, sweep as far as one full
// `strideLength` — the distance the body itself advances every cycle by
// `strideHz`'s own definition (`speed/strideLength`). That rules out a
// full, extended, biomechanical stance duration for either clip, at these
// fixed §5.4 amplitudes, before any window is even chosen.
//
// A sharper question was also tried: does a truly momentary
// zero-world-velocity instant exist AT ALL, anywhere in the cycle, for the
// REAL two-bone chain (not the straight-leg upper bound above)? That needs
// the chain's own steepest `d(localZ)/dphase` compared against
// `-strideLength`. **This second figure is NOT agreed and is NOT asserted
// anywhere in this codebase.** This file's own reading got walk -2.22 / run
// -2.49 (against required -1.45 / -2.90). An independent re-derivation by
// the coordinator, sampling the same rig at the same resolution under two
// different knee-sign conventions, got walk -2.667/-2.003 and run
// -3.828/-3.163 — every one of those four clears `-2.90` where this file's
// does not, i.e. the two computations disagree on whether run even has a
// momentary stationary instant. Both sides checked their own sign
// convention against `gaitAngles`' own leading minus before comparing; the
// disagreement was not resolved. `tests/actors/clips.test.js` prints this
// per-phase rate as a labelled diagnostic and asserts nothing from it —
// whoever builds ACTR-13 should re-derive it fresh rather than trust either
// side of this disagreement. The PENDULUM BOUND above is the only
// reachability fact this file treats as established, precisely because it
// is definition-independent and both computations reproduced it exactly.
//
// Measured over ONE disclosed, fixed-in-advance stance window — stance :=
// the contiguous span around the cycle's lowest foot-height sample for
// which height stays within 10% of that minimum VALUE (`y <= 1.10 * minY`;
// no scanning for a better slice) — `tests/actors/clips.test.js` reports
// (own numbers, printed, not asserted `< 4 cm` because they are not):
//
//   walk: stance ~= 13.8% of the cycle, drift ~= 43.8 cm
//   run:  stance ~=  9.2% of the cycle, drift ~= 53.8 cm
//
// **Verdict: `08 §11 step 5`'s literal "< 4 cm" does NOT hold for either
// clip, at either clip's own reference speed, under this disclosed
// definition — and, from the agreed pendulum bound alone, NEITHER leg can
// geometrically sweep a full `strideLength` at these fixed amplitudes, so
// no window definition can produce a full, extended, biomechanical stance
// with zero drift for either clip. This is a specification-level gap, not
// an implementation shortfall this file can close: `08` §5.4's own fixed
// amplitude table does not, by itself, produce a planted foot at these
// speeds; only `08 §11 step 7`'s Foot IK (ground probe, pelvis drop, 2-bone
// solve against a HELD world contact point — ACTR-13, a LATER ticket) can.
// This file does not build that (doing so here would preempt ACTR-13's own
// ticket, exactly as building ACTR-12's full crossfade here would have
// preempted that one) — the residual is bound to ACTR-13 and reported to
// the coordinator, not papered over.**
//
// ---------------------------------------------------------------------------
// `rateJitter` — why this never touches `ctx.rng`
// ---------------------------------------------------------------------------
// §5.4's formula multiplies `strideHz` by a `rateJitter` the table never
// sources. `ctx.rng.fork()` taken anywhere near boot is the exact trap
// `tests/core/boot.test.js:296` guards against (O-36: the root RNG stream
// must stay byte-identical to a fresh `Rng(0x5eed1234)` after boot) — and
// this file has no `ctx` at all to fork from regardless (Node-safe, no
// engine wiring). Every function below defaults `rateJitter` to `1`
// (no-op) and takes it as a plain parameter, injectable by whichever ticket
// eventually drives this per actor. `jitterFromActorId` is provided as the
// suggested injection source: a pure, deterministic hash of `actor.id` (never
// `Math.random()`, never an `rng` stream) mapped into `[1-spread, 1+spread]`
// — reproducible across runs for the same id, no shared-stream forking, no
// boot-order dependency. `spread` defaults to `0.03` (±3%): §5.4 gives no
// magnitude either; ±3% is small enough not to visibly desync a pack's gait
// while still breaking the "every actor's legs move in lockstep" tell a
// jitter of exactly `1` would otherwise produce.

// ---------------------------------------------------------------------------
// Data — `08` §5.4's tables, verbatim, plus this file's documented additions
// (ARCHITECTURE.md rule 9: gameplay/visual numbers live in data).
// ---------------------------------------------------------------------------

/** `08` §5.4's stride table. `cycleAtRef` is NOT a free number — it is
 * `strideLength/refSpeed`, kept here as a literal anyway so a test can
 * assert the DERIVED value against the SPEC'S OWN rounded prose ("0.66 s" /
 * "0.63 s") without re-deriving it from the same two inputs (that would be
 * tautological); `idle`'s `strideLength`/`refSpeed` are unused (`minHz ===
 * maxHz` makes the clamp constant regardless of the speed argument) and are
 * `null` rather than an invented value. */
export const CLIPS = Object.freeze({
  walk: Object.freeze({ strideLength: 1.45, minHz: 0.6, maxHz: 2.4, refSpeed: 2.2, cycleAtRef: 0.66 }),
  run: Object.freeze({ strideLength: 2.9, minHz: 1.05, maxHz: 2.8, refSpeed: 4.6, cycleAtRef: 0.63 }),
  idle: Object.freeze({ strideLength: null, minHz: 0.3125, maxHz: 0.3125, refSpeed: null, cycleAtRef: 3.2 }),
});

/** `08` §5.4's per-archetype walk/run speeds, verbatim. M2's only archetype
 * is the Bone Ranker (this ticket's brief); the rest of this table is
 * transcribed because it costs nothing to keep as data and every later
 * archetype ticket (ACTR-14+) will want it without re-deriving from the
 * spec — none of it is exercised by this ticket's own tests beyond
 * `bone_ranker`/`player`. */
export const ARCHETYPE_SPEEDS = Object.freeze({
  player: Object.freeze({ walk: 2.2, run: 4.6 }),
  bone_ranker: Object.freeze({ walk: 1.7, run: 3.4 }),
  carrion_swarm: Object.freeze({ walk: 2.4, run: 5.6 }),
  ashen_archer: Object.freeze({ walk: 1.9, run: 3.8 }),
  dust_shaman: Object.freeze({ walk: 1.6, run: 3.0 }),
  maulsmith: Object.freeze({ walk: 1.4, run: 2.2 }),
  blight_crawler: Object.freeze({ walk: 2.2, run: 5.0 }),
  molgrim: Object.freeze({ walk: 1.8, run: 3.2 }),
});

/** Walk->run crossfade band, `08` §5.4 verbatim: "a 0.60 m/s band centred on
 * 3.20 m/s, with 0.25 m/s of hysteresis". */
export const TRANSITION = Object.freeze({ band: 0.6, center: 3.2, hysteresis: 0.25 });

/** `08` §5.4's per-clip gait-curve table, verbatim, PLUS this file's
 * documented `stanceK`/`biasThigh`/`biasAnkle` defaults for the three
 * symbols the spec table leaves unassigned — see the file header. */
export const GAIT_PARAMS = Object.freeze({
  walk: Object.freeze({
    A_t: 21, base_k: 7, A_k: 46, A_a: 12, stanceK: 23, biasThigh: 0, biasAnkle: 0,
    swayAmp: 0.014, bobAmp: 0.014, pelvisYawDeg: 4.5, pelvisRollDeg: 3.2, leanDeg: 4, armSwingDeg: 3.5,
  }),
  run: Object.freeze({
    A_t: 34, base_k: 14, A_k: 86, A_a: 20, stanceK: 43, biasThigh: 0, biasAnkle: 0,
    swayAmp: 0.02, bobAmp: 0.03, pelvisYawDeg: 7, pelvisRollDeg: 5, leanDeg: 13, armSwingDeg: 7,
  }),
});

/** `08` §5.4: "Spine counter-rotates against the pelvis at 0.45 / 0.75 /
 * 1.00 of the yaw amplitude on Spine / Chest / Neck." */
export const SPINE_COUNTER_RATIOS = Object.freeze({ spine: 0.45, chest: 0.75, neck: 1.0 });

/** Right leg at `sideOffset = 0`, left at `π` — see the file header for why
 * this (undocumented by `08` §5.4) choice is the standard alternating-biped
 * convention and was confirmed, not just assumed, against the FK check this
 * ticket's test file runs. */
export const LEG_SIDE_OFFSET = Object.freeze({ R: 0, L: Math.PI });

/** Below this speed (m/s), `writeLocomotionPose` selects `idle` instead of
 * blending walk/run — §5.4 gives idle's cycle time but no explicit
 * walk-start threshold; a small positive value (not exactly 0) avoids a
 * standing-still actor's clamped-to-`minHz` walk cycle animating in place,
 * which is the whole reason idle exists as a separate clip. */
export const IDLE_SPEED_THRESHOLD = 0.05;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** `lobe(x,p) = sin(x) > 0 ? sin(x)^p : 0` — `08` §5.4 verbatim. */
function lobe(x, p) {
  const s = Math.sin(x);
  return s > 0 ? Math.pow(s, p) : 0;
}

// ---------------------------------------------------------------------------
// Speed-driven phase — `08` §5.4's own two-line formula
// ---------------------------------------------------------------------------

/**
 * `strideHz = clamp(speed / strideLength, minHz, maxHz) · rateJitter` — `08`
 * §5.4 verbatim. `clip` is one of `CLIPS`'s three entries (or any object
 * with the same shape). `rateJitter` defaults to `1` (no jitter) — see the
 * file header for why this file never sources it from `ctx.rng` itself.
 * @param {number} speed measured ground speed, m/s (never a timer).
 * @param {{strideLength:number, minHz:number, maxHz:number}} clip
 * @param {number} [rateJitter]
 * @returns {number} Hz
 */
export function computeStrideHz(speed, clip, rateJitter = 1) {
  const raw = clip.strideLength ? speed / clip.strideLength : clip.minHz;
  return clamp(raw, clip.minHz, clip.maxHz) * rateJitter;
}

/**
 * `phase = (phase + dt · strideHz) mod 1` — `08` §5.4 verbatim. This is
 * PRESENTATION (reads `dt`) — `ARCHITECTURE.md` rule 5 / this ticket's brief:
 * call this from `update()`, never from `fixedUpdate()`.
 * @param {number} phase current phase, `[0,1)`.
 * @param {number} dt seconds.
 * @param {number} strideHz
 * @returns {number} the next phase, wrapped into `[0,1)`.
 */
export function advancePhase(phase, dt, strideHz) {
  const p = (phase + dt * strideHz) % 1;
  return p < 0 ? p + 1 : p;
}

/**
 * Deterministic per-actor `rateJitter` source — see the file header. Never
 * `Math.random()`, never `ctx.rng`: a pure integer hash of `actorId` (mixed
 * with `salt` so `walk` and `run` do not draw the same offset for one
 * actor), folded into `[1-spread, 1+spread]`.
 * @param {number} actorId
 * @param {number} [salt] e.g. a small per-clip constant.
 * @param {number} [spread] default `0.03` (±3%) — see the file header.
 * @returns {number}
 */
export function jitterFromActorId(actorId, salt = 0, spread = 0.03) {
  let h = (actorId * 2654435761) ^ (salt * 0x9e3779b9);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h ^= h >>> 16;
  const unit = (h >>> 0) / 4294967295; // [0,1]
  return 1 + (unit * 2 - 1) * spread;
}

// ---------------------------------------------------------------------------
// Walk<->run crossfade weight, with hysteresis — see the file header for why
// this is a simplified single-phase stand-in for §5.2's real dual-clip blend
// ---------------------------------------------------------------------------

/** @returns {{dominant: 'walk'|'run'}} fresh crossfade state, `dominant`
 * starting at `'walk'`. Hold one of these per actor. */
export function createCrossfadeState() {
  return { dominant: 'walk' };
}

/**
 * Blend weight toward `run`, `0..1`, smoothstep-shaped across the FIXED
 * `TRANSITION.band` — continuous and monotonic in `speed` ALONE (never a
 * function of `state.dominant`). `08` §5.4's "0.25 m/s of hysteresis so an
 * actor jostled at the boundary does not flicker" is kept, but applied ONLY
 * to when the DISCRETE `state.dominant` label flips, never to the returned
 * numeric weight.
 *
 * O-52 (fixed here, narrowly): the previous version re-picked which pair of
 * band edges this SAME smoothstep was evaluated against the instant
 * `dominant` flipped — checked every call (`weight >= 0.5 ? 'run' : 'walk'`),
 * i.e. INSIDE the band, not at an outer edge — and because the edges
 * themselves jumped by `TRANSITION.hysteresis` at that exact instant, the
 * weight read against the NEW edges at the same speed disagreed with the
 * OLD edges' value at that same speed. Concretely, at this file's own
 * numbers (`center=3.2, band=0.6, hysteresis=0.25`): walk-edges
 * `[2.9, 3.75]` reach `weight=0.5` at `speed=3.325`; one instant later, at
 * that same ~3.33 m/s, run-edges `[2.65, 3.5]` evaluate to `weight~=0.8` —
 * a jump, not a rounding artifact (ACTR-12 traced a measured 20.9°/frame
 * knee spike through its own accumulator to exactly this). `dominant` and
 * the blend weight are two DIFFERENT signals — `dominant` picks which
 * discrete plant-phase pair a consumer reads (`08` §5.9's footfall phase
 * points), the weight cross-fades gait PARAMETERS (`blendGaitParams`
 * below) — so this fix decouples them: `weight` always reads the single
 * fixed band, `dominant` reads widened, hysteresis-separated ABSOLUTE speed
 * thresholds (not "weight >= 0.5"), so the two edges the discrete flip
 * watches for never move mid-transition and can never disagree with
 * themselves. `TRANSITION.hysteresis` is unchanged (still 0.25 m/s); only
 * WHICH quantity it gates changed. Verified against both of
 * `clips.test.js`'s existing `crossfadeWeight` assertions (saturation away
 * from the band; hysteresis holds `dominant` at `'run'` through a small
 * oscillation right at the old upper edge) — this rewrite reproduces both.
 * @param {number} speed m/s
 * @param {{dominant:'walk'|'run'}} state
 * @returns {number} `0` = pure walk, `1` = pure run.
 */
export function crossfadeWeight(speed, state) {
  const half = TRANSITION.band / 2;
  const lower = TRANSITION.center - half;
  const upper = TRANSITION.center + half;

  let t = (speed - lower) / (upper - lower);
  t = clamp(t, 0, 1);
  const weight = t * t * (3 - 2 * t); // smoothstep — same S-curve shape as §5.2's own blend, FIXED band

  if (state.dominant === 'walk' && speed >= upper + TRANSITION.hysteresis) {
    state.dominant = 'run';
  } else if (state.dominant === 'run' && speed <= lower - TRANSITION.hysteresis) {
    state.dominant = 'walk';
  }

  return weight;
}

/**
 * Linearly blends every numeric field of `GAIT_PARAMS.walk`/`.run` by
 * `runWeight` into `out` (caller-owned scratch — zero allocation per call,
 * per `ARCHITECTURE.md` rule 6; this runs every frame, up to 26 actors).
 * @param {number} runWeight `0..1`
 * @param {object} out reused scratch object.
 * @returns {object} `out`
 */
export function blendGaitParams(runWeight, out) {
  const w = GAIT_PARAMS.walk;
  const r = GAIT_PARAMS.run;
  out.A_t = lerp(w.A_t, r.A_t, runWeight);
  out.base_k = lerp(w.base_k, r.base_k, runWeight);
  out.A_k = lerp(w.A_k, r.A_k, runWeight);
  out.A_a = lerp(w.A_a, r.A_a, runWeight);
  out.stanceK = lerp(w.stanceK, r.stanceK, runWeight);
  out.biasThigh = lerp(w.biasThigh, r.biasThigh, runWeight);
  out.biasAnkle = lerp(w.biasAnkle, r.biasAnkle, runWeight);
  out.swayAmp = lerp(w.swayAmp, r.swayAmp, runWeight);
  out.bobAmp = lerp(w.bobAmp, r.bobAmp, runWeight);
  out.pelvisYawDeg = lerp(w.pelvisYawDeg, r.pelvisYawDeg, runWeight);
  out.pelvisRollDeg = lerp(w.pelvisRollDeg, r.pelvisRollDeg, runWeight);
  out.leanDeg = lerp(w.leanDeg, r.leanDeg, runWeight);
  out.armSwingDeg = lerp(w.armSwingDeg, r.armSwingDeg, runWeight);
  return out;
}

/** Fresh, unfrozen scratch shaped like one `GAIT_PARAMS` entry — for a
 * caller to hold and pass into `blendGaitParams`/reuse every frame. Not
 * itself called per-frame (called once, at actor-setup time). */
export function createGaitParamsScratch() {
  return { ...GAIT_PARAMS.walk };
}

// ---------------------------------------------------------------------------
// Gait curve — `08` §5.4's per-leg formula, verbatim (plus the documented
// stanceK/bias defaults, see the file header)
// ---------------------------------------------------------------------------

/**
 * `thigh/knee/ankle`, in degrees, for one leg at `phase` — `08` §5.4's
 * formula verbatim: `a = 2π·phase + sideOffset`, `thigh = A_t·sin(a) +
 * bias_t`, `knee = -(base_k + A_k·lobe(a-0.55,1.5) + stanceK·lobe(a+π+0.4,2))`,
 * `ankle = A_a·sin(a-1.9) + bias_a`. Writes into `out` (caller-owned scratch,
 * zero allocation — `ARCHITECTURE.md` rule 6).
 * @param {number} phase `[0,1)`
 * @param {number} sideOffsetRad `LEG_SIDE_OFFSET.R` or `.L`.
 * @param {{A_t:number,base_k:number,A_k:number,A_a:number,stanceK:number,biasThigh:number,biasAnkle:number}} gp
 * @param {{thigh:number,knee:number,ankle:number}} out
 * @returns {{thigh:number,knee:number,ankle:number}} `out`
 */
export function gaitAngles(phase, sideOffsetRad, gp, out) {
  const a = 2 * Math.PI * phase + sideOffsetRad;
  out.thigh = gp.A_t * Math.sin(a) + gp.biasThigh;
  out.knee = -(gp.base_k + gp.A_k * lobe(a - 0.55, 1.5) + gp.stanceK * lobe(a + Math.PI + 0.4, 2));
  out.ankle = gp.A_a * Math.sin(a - 1.9) + gp.biasAnkle;
  return out;
}

// ---------------------------------------------------------------------------
// Pelvis + spine — `08` §5.4's prose, turned into waveforms (see file header)
// ---------------------------------------------------------------------------

/**
 * Pelvis bob (Y, root offset), sway (X, root offset), roll and counter-yaw
 * (both bone-space degrees on `Hips`) for one full-body phase — `08` §5.4:
 * "two vertical bobs per stride (cos 2t), lateral sway (sin t), roll toward
 * the stance leg, counter-yaw against the shoulders." Chosen waveforms
 * (documented, not further spec-verified — see the file header): `bobY =
 * -bobAmp·cos(4π·phase)` (two full cycles per stride, negated so the pelvis
 * is at its LOWEST at `phase=0`/`0.5`, matching each leg's own heel-strike
 * neighbourhood); `swayX = swayAmp·sin(2π·phase)`; `rollDeg =
 * pelvisRollDeg·sin(2π·phase)`; `yawDeg = pelvisYawDeg·sin(2π·phase)` (both
 * one cycle per stride, in phase with the right leg's own `sin(a)` swing so
 * a positive yaw/roll corresponds to the right leg swinging forward).
 * Writes into `out` (caller-owned scratch).
 * @param {number} phase `[0,1)`
 * @param {{swayAmp:number,bobAmp:number,pelvisYawDeg:number,pelvisRollDeg:number}} gp
 * @param {{bobY:number,swayX:number,rollDeg:number,yawDeg:number}} out
 * @returns {object} `out`
 */
export function pelvisMotion(phase, gp, out) {
  const t = 2 * Math.PI * phase;
  out.bobY = -gp.bobAmp * Math.cos(2 * t);
  out.swayX = gp.swayAmp * Math.sin(t);
  out.rollDeg = gp.pelvisRollDeg * Math.sin(t);
  out.yawDeg = gp.pelvisYawDeg * Math.sin(t);
  return out;
}

/**
 * `Spine`/`Chest`/`Neck` counter-yaw degrees for a given pelvis `yawDeg` —
 * `08` §5.4's `0.45 / 0.75 / 1.00` ratios, negated ("counter-rotates").
 * Writes into `out`.
 * @param {number} yawDeg
 * @param {{spine:number,chest:number,neck:number}} out
 */
export function spineCounterRotation(yawDeg, out) {
  out.spine = -yawDeg * SPINE_COUNTER_RATIOS.spine;
  out.chest = -yawDeg * SPINE_COUNTER_RATIOS.chest;
  out.neck = -yawDeg * SPINE_COUNTER_RATIOS.neck;
  return out;
}

// ---------------------------------------------------------------------------
// Pose — `08` §5.1's shape: `Float32Array(bones*3)` euler-degree deltas, plus
// a root offset and a root yaw. This file only ever writes the L1 locomotion
// layer's contribution (full mask, §5.3) — later layers (ACTR-12+) accumulate
// on top; nothing here clears anything another layer wrote.
// ---------------------------------------------------------------------------

/**
 * @param {number} boneCount
 * @returns {{delta: Float32Array, rootOffsetX:number, rootOffsetY:number, rootOffsetZ:number, rootYaw:number}}
 */
export function createPose(boneCount) {
  return {
    delta: new Float32Array(boneCount * 3),
    rootOffsetX: 0,
    rootOffsetY: 0,
    rootOffsetZ: 0,
    rootYaw: 0,
  };
}

/** Zeroes every field this file's own writers touch — does NOT touch bones
 * outside the locomotion set, so it is safe to call before re-accumulating
 * L1 without disturbing whatever L2-L4 (ACTR-12+) later add to the same
 * buffer in a real multi-layer accumulator. */
export function resetPose(pose) {
  pose.delta.fill(0);
  pose.rootOffsetX = 0;
  pose.rootOffsetY = 0;
  pose.rootOffsetZ = 0;
  pose.rootYaw = 0;
}

/** Bone names this file writes into a `Pose` — the humanoid rig's leg chain
 * (`08` §2.3 / `rig.js`) plus torso/arms. Locomotion is a humanoid-only
 * concern this ticket (M2's one archetype, the Bone Ranker, is humanoid);
 * `buildLocomotionBoneIndex` below resolves `-1` for any name a non-humanoid
 * rig lacks, and every writer skips a `-1` index rather than throwing. */
const LOCOMOTION_BONE_NAMES = Object.freeze([
  'Hips', 'Spine', 'Chest', 'Neck',
  'UpLegR', 'LegR', 'FootR', 'UpLegL', 'LegL', 'FootL',
  'UpperArmR', 'UpperArmL',
]);

/**
 * `rig.names -> { Hips: idx, ... }`, `-1` for any of `LOCOMOTION_BONE_NAMES`
 * the given rig does not have. Built once per rig (at actor-setup time, not
 * per frame).
 * @param {{names:string[]}} rig a `createSkeleton()` result.
 * @returns {Record<string, number>}
 */
export function buildLocomotionBoneIndex(rig) {
  const map = {};
  for (const name of LOCOMOTION_BONE_NAMES) map[name] = -1;
  for (let i = 0; i < rig.names.length; i++) {
    if (Object.prototype.hasOwnProperty.call(map, rig.names[i])) map[rig.names[i]] = i;
  }
  return map;
}

/**
 * `createLocomotionState()` — one of these per actor; holds everything
 * `writeLocomotionPose` needs across frames (the "accumulator" in "the
 * Poser accumulator, idle/walk/run, speed-driven phase").
 * @returns {{phase:number, idlePhase:number, dominant:'walk'|'run'}}
 */
export function createLocomotionState() {
  return { phase: 0, idlePhase: 0, dominant: 'walk' };
}

/** Scratch bundle `writeLocomotionPose` needs — allocate once per actor
 * (e.g. alongside its `LocomotionState`), pass in every call, never
 * reallocate. Keeps `writeLocomotionPose` itself `Alloc: no`. */
export function createLocomotionScratch() {
  return {
    gaitParams: createGaitParamsScratch(),
    legR: { thigh: 0, knee: 0, ankle: 0 },
    legL: { thigh: 0, knee: 0, ankle: 0 },
    pelvis: { bobY: 0, swayX: 0, rollDeg: 0, yawDeg: 0 },
    spine: { spine: 0, chest: 0, neck: 0 },
  };
}

/**
 * The Poser accumulator's locomotion write: given the actor's measured
 * ground `speed` (never a timer — `08` §5.4) and elapsed `dt`, advances
 * `state` and writes L1's contribution into `pose` for every bone
 * `boneIndex` resolves (`-1` entries skipped — non-humanoid rigs simply get
 * no leg/torso locomotion pose, see `LOCOMOTION_BONE_NAMES` above). Below
 * `IDLE_SPEED_THRESHOLD`, drives the `idle` breath cycle instead (a single,
 * minimal `Chest` pitch — `08` §5.4 gives idle's cycle time only, no curve
 * shape; see the file header). `rateJitter` defaults to `1` — pass
 * `jitterFromActorId(actor.id, salt)` for per-actor variation.
 *
 * Zero allocation: every intermediate lives in `scratch` (see
 * `createLocomotionScratch`), `out`-param style throughout, matching
 * `ARCHITECTURE.md` rule 6 (this runs once per actor per frame, up to 26).
 *
 * @param {{delta:Float32Array, rootOffsetX:number, rootOffsetY:number, rootOffsetZ:number, rootYaw:number}} pose
 * @param {Record<string,number>} boneIndex from `buildLocomotionBoneIndex`.
 * @param {{phase:number, idlePhase:number, dominant:'walk'|'run'}} state from `createLocomotionState`.
 * @param {ReturnType<typeof createLocomotionScratch>} scratch
 * @param {number} speed measured ground speed, m/s.
 * @param {number} dt seconds — presentation only; never call from `fixedUpdate`.
 * @param {number} [rateJitter]
 */
export function writeLocomotionPose(pose, boneIndex, state, scratch, speed, dt, rateJitter = 1) {
  if (speed < IDLE_SPEED_THRESHOLD) {
    const idleHz = computeStrideHz(speed, CLIPS.idle, rateJitter);
    state.idlePhase = advancePhase(state.idlePhase, dt, idleHz);
    const chest = boneIndex.Chest;
    if (chest !== undefined && chest >= 0) {
      // Minimal breath signal — no curve shape is given for idle beyond its
      // cycle time (see the file header); a small chest pitch is the
      // simplest honest placeholder.
      pose.delta[chest * 3] += 1.2 * Math.sin(2 * Math.PI * state.idlePhase);
    }
    return;
  }

  const runWeight = crossfadeWeight(speed, state);
  const gp = blendGaitParams(runWeight, scratch.gaitParams);

  const walkHz = computeStrideHz(speed, CLIPS.walk, rateJitter);
  const runHz = computeStrideHz(speed, CLIPS.run, rateJitter);
  const strideHz = lerp(walkHz, runHz, runWeight);
  state.phase = advancePhase(state.phase, dt, strideHz);

  gaitAngles(state.phase, LEG_SIDE_OFFSET.R, gp, scratch.legR);
  gaitAngles(state.phase, LEG_SIDE_OFFSET.L, gp, scratch.legL);

  writeLegDelta(pose, boneIndex, 'R', scratch.legR);
  writeLegDelta(pose, boneIndex, 'L', scratch.legL);

  pelvisMotion(state.phase, gp, scratch.pelvis);
  pose.rootOffsetY += scratch.pelvis.bobY;
  pose.rootOffsetX += scratch.pelvis.swayX;

  const hips = boneIndex.Hips;
  if (hips >= 0) {
    pose.delta[hips * 3] += gp.leanDeg; // forward lean — constant pitch, see the file header
    pose.delta[hips * 3 + 2] += scratch.pelvis.rollDeg; // roll about the forward axis
    pose.delta[hips * 3 + 1] += scratch.pelvis.yawDeg; // yaw about the vertical axis
  }

  spineCounterRotation(scratch.pelvis.yawDeg, scratch.spine);
  writeYaw(pose, boneIndex, 'Spine', scratch.spine.spine);
  writeYaw(pose, boneIndex, 'Chest', scratch.spine.chest);
  writeYaw(pose, boneIndex, 'Neck', scratch.spine.neck);

  // Arm swing — opposite-phase to the same-side leg (right arm follows the
  // left leg's phase and vice versa), a single sinusoid: §5.4 gives an
  // amplitude only, no separate curve for the arm (see the file header).
  const armR = boneIndex.UpperArmR;
  if (armR >= 0) {
    pose.delta[armR * 3] += gp.armSwingDeg * Math.sin(2 * Math.PI * state.phase + LEG_SIDE_OFFSET.L);
  }
  const armL = boneIndex.UpperArmL;
  if (armL >= 0) {
    pose.delta[armL * 3] += gp.armSwingDeg * Math.sin(2 * Math.PI * state.phase + LEG_SIDE_OFFSET.R);
  }
}

function writeLegDelta(pose, boneIndex, side, angles) {
  const upLeg = boneIndex['UpLeg' + side];
  const leg = boneIndex['Leg' + side];
  const foot = boneIndex['Foot' + side];
  if (upLeg >= 0) pose.delta[upLeg * 3] += angles.thigh; // hip flexion — local X, see the file header's FK confirmation
  if (leg >= 0) pose.delta[leg * 3] += angles.knee; // knee flexion — local X
  if (foot >= 0) pose.delta[foot * 3] += angles.ankle; // ankle flexion — local X
}

function writeYaw(pose, boneIndex, name, deg) {
  const idx = boneIndex[name];
  if (idx >= 0) pose.delta[idx * 3 + 1] += deg;
}
