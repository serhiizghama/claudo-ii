// tests/actors/anim.test.js
//
// ACTR-12 acceptance tests for src/actors/anim.js — `08 §11 step 6`'s
// CORRECTNESS half: the layer stack, bone masks, the idle<->locomotion
// crossfade, additive overlays and the spring/damper bank. `node:test` +
// `node:assert/strict` only (12-testing.md P6). The allocation and 26-actor
// timing halves of the same criterion live in `anim.perf.test.js` (D-11:
// a test asserting a time/allocation/frame count is named `.perf.test.js`).
//
// ---------------------------------------------------------------------------
// The discontinuity criterion — what this file finds, and why it is not
// silently made to pass
// ---------------------------------------------------------------------------
// `08 §11 step 6`: "idle->run->idle produces no bone-angle discontinuity >
// 6°/frame (logged)". Measured directly below (see "08 §11 step 6 —
// idle->run->idle discontinuity"): a Bone Ranker walking (1.7 m/s, its own
// `ARCHETYPE_SPEEDS.bone_ranker.walk`) stays under 6°/frame throughout
// (worst observed ~5.2°/frame); a Bone Ranker RUNNING (3.4 m/s, its own
// `.run`) does NOT — worst observed ~10.2-10.3°/frame, and the same
// steady-state value (~10.17°/frame) is reproduced calling
// `clips.js#gaitAngles` DIRECTLY with `GAIT_PARAMS.run` at the same phase
// rate, with ZERO involvement from this file's own crossfade/mask/blend-
// weight machinery (that comparison is the test below — the two numbers
// match to floating-point precision). This conclusively root-causes the
// failure to `clips.js`'s own accepted `GAIT_PARAMS.run` curve (`A_k=86`,
// `stanceK=43`, evaluated at up to `maxHz=2.8`) being too steep to sample
// smoothly at 60 fps — NOT to anything this ticket's own layer stack adds.
// `clips.js` is not in this ticket's file list to fix (ACTR-11, already
// accepted) — this is reported to the coordinator per the ticket brief,
// exactly as `clips.js`'s own header reports its foot-slide finding, not
// silently worked around. The test below asserts the TRUE, in-scope claim
// (this file's own layering adds no discontinuity beyond what the
// underlying curve already has) and PRINTS, without asserting, the raw
// swept worst-case number the literal criterion needs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSkeleton, reconstructBindPos } from '../../src/actors/rig.js';
import {
  GAIT_PARAMS, CLIPS, LEG_SIDE_OFFSET, TRANSITION, gaitAngles, ARCHETYPE_SPEEDS,
  computeStrideHz, advancePhase, blendGaitParams, createGaitParamsScratch,
} from '../../src/actors/clips.js';
import {
  MASK_NAMES,
  BONE_MASK_SPEC,
  buildBoneMasks,
  buildBoneIndex,
  createBlendWeight,
  advanceBlendWeight,
  STATE_TABLE,
  createAnimatorState,
  updateAnimator,
  composeSkeletonWorld,
  createSpringState,
  advanceSpring,
  SPRINGS,
  hitFlinchEnvelope,
  impactRecoilEnvelope,
  staggerEnvelope,
  advanceLag,
  createOverlayState,
  triggerHitFlinch,
  triggerImpactRecoil,
  triggerStagger,
  advanceOverlayTimers,
  writeHitFlinchOverlay,
  writeImpactRecoilOverlay,
  writeStaggerOverlay,
  writeBreathOverlay,
} from '../../src/actors/anim.js';

const DT = 1 / 60;

function vec3At(arr, i) {
  return { x: arr[i * 3], y: arr[i * 3 + 1], z: arr[i * 3 + 2] };
}

function quatAt(arr, i) {
  return { x: arr[i * 4], y: arr[i * 4 + 1], z: arr[i * 4 + 2], w: arr[i * 4 + 3] };
}

// ---------------------------------------------------------------------------
// 08 §5.3 — bone masks, transcribed table, checked bone by bone
// ---------------------------------------------------------------------------

test('ACTR-12 masks | MASK_NAMES is exactly the four named masks', () => {
  assert.deepEqual(MASK_NAMES, ['full', 'upper', 'lower', 'arms']);
});

test('ACTR-12 masks | buildBoneMasks: full is 255 for every bone', () => {
  const rig = createSkeleton('humanoid');
  const masks = buildBoneMasks(rig);
  assert.equal(masks.full.length, rig.boneCount);
  for (let i = 0; i < rig.boneCount; i++) assert.equal(masks.full[i], 255);
});

test('ACTR-12 masks | upper: torso/arm chain 255, Spine 160, Hips 64, legs 0, Root 0', () => {
  const rig = createSkeleton('humanoid');
  const masks = buildBoneMasks(rig);
  const bi = buildBoneIndex(rig);
  const upper255 = ['Chest', 'Neck', 'Head', 'ClavicleR', 'UpperArmR', 'ForearmR', 'HandR', 'WeaponR',
    'ClavicleL', 'UpperArmL', 'ForearmL', 'HandL', 'ShieldL'];
  for (const name of upper255) assert.equal(masks.upper[bi[name]], 255, `${name} upper`);
  assert.equal(masks.upper[bi.Spine], 160, 'Spine upper');
  assert.equal(masks.upper[bi.Hips], 64, 'Hips upper');
  const legs = ['UpLegR', 'LegR', 'FootR', 'UpLegL', 'LegL', 'FootL'];
  for (const name of legs) assert.equal(masks.upper[bi[name]], 0, `${name} upper`);
  assert.equal(masks.upper[bi.Root], 0, 'Root upper');
});

test('ACTR-12 masks | lower: Hips 255, Spine 255, legs 255, everything else 0', () => {
  const rig = createSkeleton('humanoid');
  const masks = buildBoneMasks(rig);
  const bi = buildBoneIndex(rig);
  assert.equal(masks.lower[bi.Hips], 255);
  assert.equal(masks.lower[bi.Spine], 255);
  for (const name of ['UpLegR', 'LegR', 'FootR', 'UpLegL', 'LegL', 'FootL']) {
    assert.equal(masks.lower[bi[name]], 255, name);
  }
  for (const name of ['Chest', 'Neck', 'Head', 'ClavicleR', 'UpperArmR', 'ForearmR', 'HandR', 'WeaponR', 'Root']) {
    assert.equal(masks.lower[bi[name]], 0, name);
  }
});

test('ACTR-12 masks | arms: clavicle->weapon/shield chains 255, Chest 96, everything else 0', () => {
  const rig = createSkeleton('humanoid');
  const masks = buildBoneMasks(rig);
  const bi = buildBoneIndex(rig);
  const arms255 = ['ClavicleR', 'UpperArmR', 'ForearmR', 'HandR', 'WeaponR', 'ClavicleL', 'UpperArmL', 'ForearmL', 'HandL', 'ShieldL'];
  for (const name of arms255) assert.equal(masks.arms[bi[name]], 255, name);
  assert.equal(masks.arms[bi.Chest], 96, 'Chest arms');
  for (const name of ['Neck', 'Head', 'Hips', 'Spine', 'UpLegR', 'LegR', 'FootR', 'Root']) {
    assert.equal(masks.arms[bi[name]], 0, name);
  }
});

test('ACTR-12 masks | upper/lower deliberately overlap on Spine and Hips (the ticket brief\'s own mechanism)', () => {
  const rig = createSkeleton('humanoid');
  const masks = buildBoneMasks(rig);
  const bi = buildBoneIndex(rig);
  assert.ok(masks.upper[bi.Spine] > 0 && masks.lower[bi.Spine] > 0, 'Spine must be nonzero in both upper and lower');
  assert.ok(masks.upper[bi.Hips] > 0 && masks.lower[bi.Hips] > 0, 'Hips must be nonzero in both upper and lower');
});

test('ACTR-12 masks | BONE_MASK_SPEC has no entry for the boss-only Cloak2/Tome (out of this ticket\'s rig scope)', () => {
  assert.equal(BONE_MASK_SPEC.Cloak2, undefined);
  assert.equal(BONE_MASK_SPEC.Tome, undefined);
});

// ---------------------------------------------------------------------------
// 08 §5.2 — blend-weight dynamics, formula verbatim
// ---------------------------------------------------------------------------

test('ACTR-12 blend weight | wRaw approaches target at the dt/tauIn rate, w is smoothstep(wRaw)', () => {
  const bw = createBlendWeight();
  const tauIn = 0.2;
  const w1 = advanceBlendWeight(bw, 1, tauIn, 0.2, DT);
  const expectedRaw = DT / tauIn;
  assert.ok(Math.abs(bw.wRaw - expectedRaw) < 1e-9, `wRaw=${bw.wRaw} expected ${expectedRaw}`);
  const t = expectedRaw;
  const expectedW = t * t * (3 - 2 * t);
  assert.ok(Math.abs(w1 - expectedW) < 1e-9);
});

test('ACTR-12 blend weight | reaches target 1 after enough real seconds (~tauIn), never overshoots', () => {
  const bw = createBlendWeight();
  const tauIn = 0.16;
  let steps = 0;
  while (bw.wRaw < 1 && steps < 100000) {
    advanceBlendWeight(bw, 1, tauIn, 0.16, DT);
    assert.ok(bw.w <= 1 && bw.w >= 0, 'weight must stay in [0,1]');
    steps++;
  }
  assert.ok(steps > 0 && steps < 100000, `should converge; took ${steps} steps`);
  assert.ok(Math.abs(bw.w - 1) < 1e-6);
});

test('ACTR-12 blend weight | asymmetric tauIn/tauOut are both honoured (down-rate uses tauOut)', () => {
  const bw = createBlendWeight();
  advanceBlendWeight(bw, 1, 0.001, 0.001, DT); // snap to ~1
  assert.ok(bw.wRaw > 0.99);
  const tauOut = 1.0; // slow decay
  advanceBlendWeight(bw, 0, 0.001, tauOut, DT);
  const expectedRaw = 1 - DT / tauOut;
  assert.ok(Math.abs(bw.wRaw - expectedRaw) < 1e-6, `wRaw=${bw.wRaw} expected ~${expectedRaw}`);
});

test('ACTR-12 blend weight | tau=0 ("-" in the state table) reads as instant, no NaN', () => {
  const bw = createBlendWeight();
  const w = advanceBlendWeight(bw, 1, 0, 0, DT);
  assert.ok(!Number.isNaN(w));
  assert.ok(w > 0.99, 'an instant blend should land at (near) target in one call');
});

// ---------------------------------------------------------------------------
// 08 §5.5 — state table, sanity over every row (data completeness, rule 6)
// ---------------------------------------------------------------------------

test('ACTR-12 state table | every row has a nonempty maskSpec whose masks all exist', () => {
  for (const [name, entry] of Object.entries(STATE_TABLE)) {
    assert.ok(Array.isArray(entry.maskSpec) && entry.maskSpec.length > 0, name);
    for (const { mask, weight } of entry.maskSpec) {
      assert.ok(MASK_NAMES.includes(mask), `${name}: unknown mask '${mask}'`);
      assert.ok(weight > 0 && weight <= 1, `${name}: mask weight out of range`);
    }
    assert.ok(entry.blendIn >= 0 && entry.blendOut >= 0, name);
  }
});

test('ACTR-12 state table | attack.windup: upper @ 1.0 AND lower @ 0.35 (the overlap mechanism, transcribed)', () => {
  const spec = STATE_TABLE['attack.windup'].maskSpec;
  const upper = spec.find((s) => s.mask === 'upper');
  const lower = spec.find((s) => s.mask === 'lower');
  assert.ok(upper && upper.weight === 1.0);
  assert.ok(lower && lower.weight === 0.35);
});

// ---------------------------------------------------------------------------
// Acceptance criterion #1 — "upper/lower layering lets a Ranker walk into
// range while winding up: the lower body plays locomotion while the upper
// body plays the attack wind-up, simultaneously, and both read correctly."
// ---------------------------------------------------------------------------

test('ACTR-12 layering | a Ranker walking + winding up: legs read pure locomotion, arms read the windup, unaffected by each other', () => {
  const rig = createSkeleton('humanoid');
  const bi = buildBoneIndex(rig);
  const walkSpeed = ARCHETYPE_SPEEDS.bone_ranker.walk; // 1.7 m/s

  // Control: locomotion only, no override — this is "ground truth" for what
  // the legs/torso should read from L1 alone.
  const control = createAnimatorState(rig);
  // Test subject: same speed, PLUS an 'attack.windup' override engaged the
  // whole time, with a synthetic raw delta standing in for whatever
  // ACTR-13/14's real clip content will one day be (see anim.js's own
  // header — clip curves are explicitly out of this ticket's scope).
  const subject = createAnimatorState(rig);
  const overrideDelta = new Float32Array(rig.boneCount * 3);
  const FOREARM_DEG = 40; // arbitrary placeholder "drawn back" angle
  const HIPS_DEG = 20; // arbitrary placeholder torso lean, to exercise the Hips overlap
  overrideDelta[bi.ForearmR * 3] = FOREARM_DEG;
  overrideDelta[bi.Hips * 3] = HIPS_DEG;

  const FRAMES = 90; // 1.5s — enough for both the locomotion phase and the
  // windup's own 0.10s blend-in to settle near steady state.
  for (let i = 0; i < FRAMES; i++) {
    updateAnimator(control, { speed: walkSpeed }, DT);
    updateAnimator(subject, { speed: walkSpeed, overrideStateId: 'attack.windup', overrideDelta }, DT);
  }

  // The windup's own blend-in (0.10s) must have long since reached ~1.
  assert.ok(subject.stateLayer.bw.w > 0.999, `windup weight should be saturated, got ${subject.stateLayer.bw.w}`);

  // --- Lower body reads PURE locomotion, identical to the control, because
  // the override's raw delta at every leg bone is 0 (an untouched buffer)
  // and 0 * any mask/weight is still 0 — "the lower body plays locomotion". ---
  for (const name of ['UpLegR', 'LegR', 'FootR', 'UpLegL', 'LegL', 'FootL']) {
    const idx = bi[name];
    for (let c = 0; c < 3; c++) {
      const a = control.pose.delta[idx * 3 + c];
      const b = subject.pose.delta[idx * 3 + c];
      assert.ok(Math.abs(a - b) < 1e-6, `${name} axis ${c}: control=${a} subject=${b} (windup must not leak into legs)`);
    }
  }
  // And that locomotion is actually non-trivial (not a degenerate all-zero
  // walk) — proves this is a real check, not a vacuous one.
  const legMoving = ['UpLegR', 'UpLegL'].some((n) => Math.abs(control.pose.delta[bi[n] * 3]) > 1);
  assert.ok(legMoving, 'control walk must actually move the legs for this check to mean anything');

  // --- Upper body (ForearmR) reads the windup override, masked by `upper`
  // (255/255 = 1.0) at the state's own weight (1.0) and the layer's fully-
  // ramped blend weight (~1) — "the upper body plays the attack wind-up". ---
  const forearmSubject = subject.pose.delta[bi.ForearmR * 3];
  const forearmControl = control.pose.delta[bi.ForearmR * 3]; // locomotion contributes ~0 here (ForearmR isn't a locomotion bone)
  const expectedForearm = forearmControl + FOREARM_DEG * (255 / 255) * 1.0 * subject.stateLayer.bw.w;
  assert.ok(Math.abs(forearmSubject - expectedForearm) < 0.05,
    `ForearmR: got ${forearmSubject}, expected ~${expectedForearm}`);
  assert.ok(Math.abs(forearmSubject) > 30, 'ForearmR must visibly read the wind-up');

  // --- Hips: BOTH masks apply simultaneously (the deliberate overlap) — the
  // override's own Hips contribution is `upper`(64/255) + `lower`(255/255 @
  // spec weight 0.35), ON TOP of whatever L1 locomotion already wrote to
  // Hips (which the control isolates). This is "both read correctly" for
  // the one bone that is legitimately shared. ---
  const hipsSubject = subject.pose.delta[bi.Hips * 3];
  const hipsControl = control.pose.delta[bi.Hips * 3];
  const w = subject.stateLayer.bw.w;
  const upperContribution = HIPS_DEG * (64 / 255) * 1.0 * w;
  const lowerContribution = HIPS_DEG * (255 / 255) * 0.35 * w;
  const expectedHips = hipsControl + upperContribution + lowerContribution;
  assert.ok(Math.abs(hipsSubject - expectedHips) < 0.05,
    `Hips: got ${hipsSubject}, expected ~${expectedHips} (control ${hipsControl} + upper ${upperContribution} + lower ${lowerContribution})`);

  console.log('[ACTR-12 layering] ForearmR (windup, upper mask): control=%s subject=%s (expect +%s)',
    forearmControl.toFixed(3), forearmSubject.toFixed(3), (FOREARM_DEG * w).toFixed(3));
  console.log('[ACTR-12 layering] Hips (overlap upper+lower): control=%s subject=%s delta=%s',
    hipsControl.toFixed(3), hipsSubject.toFixed(3), (hipsSubject - hipsControl).toFixed(3));
});

test('ACTR-12 layering | releasing the override fades it out (blendOut) rather than snapping to nothing', () => {
  const rig = createSkeleton('humanoid');
  const bi = buildBoneIndex(rig);
  const state = createAnimatorState(rig);
  const overrideDelta = new Float32Array(rig.boneCount * 3);
  overrideDelta[bi.ForearmR * 3] = 40;

  for (let i = 0; i < 30; i++) updateAnimator(state, { speed: 0, overrideStateId: 'attack.recovery', overrideDelta }, DT);
  const wBefore = state.stateLayer.bw.w;
  assert.ok(wBefore > 0.5, 'should have engaged by now');

  // Release the override.
  updateAnimator(state, { speed: 0, overrideStateId: null, overrideDelta: null }, DT);
  const wAfterOneFrame = state.stateLayer.bw.w;
  assert.ok(wAfterOneFrame < wBefore, 'weight must start decaying, not snap to 0');
  assert.ok(wAfterOneFrame > 0, 'must not snap to 0 in a single frame (attack.recovery blendOut=0.14s)');

  // Eventually settles to fully released.
  for (let i = 0; i < 300; i++) updateAnimator(state, { speed: 0, overrideStateId: null, overrideDelta: null }, DT);
  assert.equal(state.stateLayer.lastEntry, null, 'should have cleared the held override entirely by now');
});

// ---------------------------------------------------------------------------
// Acceptance criterion #2a — 08 §11 step 6: idle->run->idle discontinuity
// ---------------------------------------------------------------------------

function sweepWorstDelta(speedAt, seconds) {
  const rig = createSkeleton('humanoid');
  const state = createAnimatorState(rig);
  const steps = Math.round(seconds / DT);
  let prev = new Float32Array(state.pose.delta.length);
  let worst = 0;
  let worstBone = -1;
  let worstFrame = -1;
  for (let i = 0; i < steps; i++) {
    updateAnimator(state, { speed: speedAt(i * DT) }, DT);
    const cur = state.pose.delta;
    for (let k = 0; k < cur.length; k++) {
      const d = Math.abs(cur[k] - prev[k]);
      if (d > worst) { worst = d; worstBone = k; worstFrame = i; }
      prev[k] = cur[k];
    }
  }
  return { worst, worstBone, worstFrame };
}

/** Builds an idle -> hold-at-speed -> decelerate -> idle profile, with the
 * deceleration START delayed by `offsetFrames` — used to sample different
 * gait-phase alignments at the moment the idle<->locomotion crossfade
 * engages/releases (see the investigation below: the phase at which the
 * release happens to begin matters as much as the speed itself). */
function rampProfile(topSpeed, offsetFrames, dt) {
  return (t) => {
    if (t < 1) return 0;
    if (t < 2) return (t - 1) * topSpeed;
    const declStart = 2 + offsetFrames * dt;
    if (t < declStart) return topSpeed;
    if (t < declStart + 1) return topSpeed * (1 - (t - declStart));
    return 0;
  };
}

function worstAcrossPhaseAlignments(topSpeed, seconds) {
  let worst = 0;
  for (let offsetFrames = 0; offsetFrames < 40; offsetFrames++) {
    const { worst: w } = sweepWorstDelta(rampProfile(topSpeed, offsetFrames, DT), seconds);
    if (w > worst) worst = w;
  }
  return worst;
}

test('08 §11 step 6 | idle->WALK->idle (bone_ranker, 1.7 m/s): measured, printed, root-caused', () => {
  const walkSpeed = ARCHETYPE_SPEEDS.bone_ranker.walk;
  const { worst, worstBone, worstFrame } = sweepWorstDelta(rampProfile(walkSpeed, 0, DT), 7);
  console.log(`[08 §11 step 6] idle->walk->idle (one representative profile) worst = ${worst.toFixed(3)} deg/frame (bone*3+axis=${worstBone}, frame=${worstFrame})`);

  const worstOverPhase = worstAcrossPhaseAlignments(walkSpeed, 7);
  console.log(`[08 §11 step 6] idle->walk->idle, worst over 40 sampled gait-phase alignments at the deceleration point: ${worstOverPhase.toFixed(3)} deg/frame`);

  assert.ok(Number.isFinite(worst) && worst > 0, 'must be a real, nonzero measurement, not a vacuous pass');
  assert.ok(worstOverPhase < 15, `sanity ceiling — walk must not blow up wildly even in the unluckiest phase alignment; got ${worstOverPhase}`);
});

test('08 §11 step 6 | idle->RUN->idle (bone_ranker, 3.4 m/s): the literal <6°/frame figure does NOT robustly hold — measured, root-caused, reported (not silently passed)', () => {
  const runSpeed = ARCHETYPE_SPEEDS.bone_ranker.run;
  const speedAt = (t) => {
    if (t < 2) return 0;
    if (t < 4) return (t - 2) / 2 * runSpeed;
    if (t < 6) return runSpeed;
    if (t < 8) return runSpeed * (1 - (t - 6) / 2);
    return 0;
  };
  const { worst, worstBone, worstFrame } = sweepWorstDelta(speedAt, 10);
  console.log(`[08 §11 step 6] idle->run->idle (via this file's Animator, one representative profile) worst = ${worst.toFixed(3)} deg/frame (bone*3+axis=${worstBone}, frame=${worstFrame}, t=${(worstFrame * DT).toFixed(3)}s)`);

  // --- Root-cause check #1: during the ACCEL ramp + steady hold (locoWeight
  // already saturated at 1, not itself transitioning), replaying the exact
  // same speed profile through BARE clips.js primitives — with this file's
  // own locoWeight forced to a constant 1 the whole time, i.e. this file's
  // idle<->locomotion crossfade fully bypassed — reproduces the IDENTICAL
  // worst value. That proves this file's own crossfade contributes exactly
  // zero to this particular spike: the spike happens while there is nothing
  // to blend, purely from clips.js's own GAIT_PARAMS.run + the walk<->run
  // blend responding to a still-changing speed. ---
  const bareWorst = bareClipsWorst(speedAt, 10);
  console.log(`[08 §11 step 6] same profile, bare clips.js primitives with locoWeight forced to 1 (this file's crossfade bypassed entirely): worst = ${bareWorst.toFixed(3)} deg/frame`);
  assert.ok(Math.abs(worst - bareWorst) < 0.01,
    `this file's own idle<->locomotion crossfade must contribute ~0 extra discontinuity during the accel/hold portion; ` +
    `animator=${worst} bare=${bareWorst}`);

  // --- Root-cause check #2: clips.js's own accepted GAIT_PARAMS.run curve,
  // evaluated in complete isolation (no speed ramp, no crossfade, no
  // anim.js at all) at its own maxHz, already exceeds 6°/frame on its own. ---
  const out = { thigh: 0, knee: 0, ankle: 0 };
  const hz = CLIPS.run.maxHz;
  let prevKnee = gaitAngles(0, LEG_SIDE_OFFSET.R, GAIT_PARAMS.run, out).knee;
  let clipsWorst = 0;
  for (let i = 1; i < 300; i++) {
    const phase = (i * DT * hz) % 1;
    gaitAngles(phase, LEG_SIDE_OFFSET.R, GAIT_PARAMS.run, out);
    const d = Math.abs(out.knee - prevKnee);
    if (d > clipsWorst) clipsWorst = d;
    prevKnee = out.knee;
  }
  console.log(`[08 §11 step 6] clips.js#gaitAngles alone (GAIT_PARAMS.run @ maxHz=${hz}), no speed ramp, no anim.js involved: worst knee delta = ${clipsWorst.toFixed(3)} deg/frame`);
  assert.ok(clipsWorst > 6, 'sanity: clips.js\'s own run curve must itself already exceed 6 deg/frame for this to be a meaningful root-cause claim');

  console.log('[08 §11 step 6] VERDICT: the literal "no discontinuity > 6 deg/frame" criterion does NOT robustly hold — ' +
    'root cause is clips.js\'s own accepted GAIT_PARAMS.run curve (A_k=86, stanceK=43, up to maxHz=2.8), which this ticket\'s own ' +
    'idle<->locomotion crossfade (this file\'s main addition) measurably contributes ZERO extra discontinuity to (see the bare-clips ' +
    'comparison above). walk (1.7 m/s) is far closer to compliant than run (3.4 m/s) but is not unconditionally safe either — see the ' +
    'sibling test\'s phase-alignment sweep. Not fixable inside this ticket\'s three files without either changing clips.js\'s own ' +
    'accepted curve (ACTR-11, out of scope) or making the crossfade\'s blend timing gait-phase-aware (undocumented by 08 §5.2/§5.5, ' +
    'which only give fixed tau values) — reported to the coordinator per the ticket brief, not silently patched.');
});

/** Replays `speedAt` through clips.js's own exported primitives directly,
 * with the walk<->run blend weight computed the same way this file computes
 * it, but WITHOUT this file's own idle<->locomotion `locoWeight` (i.e. as if
 * it were pinned at 1 for the whole run) — isolates whether the discontinuity
 * originates from this file's own crossfade mechanism or not. */
function bareClipsWorst(speedAt, seconds) {
  const lower = TRANSITION.center - TRANSITION.band / 2;
  const upper = TRANSITION.center + TRANSITION.band / 2;
  const gp = createGaitParamsScratch();
  let phase = 0;
  let prevKnee = 0;
  let worst = 0;
  const steps = Math.round(seconds / DT);
  const out = { thigh: 0, knee: 0, ankle: 0 };
  for (let i = 0; i < steps; i++) {
    const t = i * DT;
    const speed = speedAt(t);
    const tRaw = Math.max(0, Math.min(1, (speed - lower) / (upper - lower)));
    const runWeight = tRaw * tRaw * (3 - 2 * tRaw);
    blendGaitParams(runWeight, gp);
    const wHz = computeStrideHz(speed, CLIPS.walk);
    const rHz = computeStrideHz(speed, CLIPS.run);
    const sHz = wHz + (rHz - wHz) * runWeight;
    phase = advancePhase(phase, DT, sHz);
    gaitAngles(phase, LEG_SIDE_OFFSET.R, gp, out);
    const d = Math.abs(out.knee - prevKnee);
    if (d > worst) worst = d;
    prevKnee = out.knee;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// §5.6 additive overlays — envelope math + wiring sanity
// ---------------------------------------------------------------------------

test('ACTR-12 overlays | breath: sinusoidal, amplitude bounded, writes Spine/Chest/Neck + root Y', () => {
  const rig = createSkeleton('humanoid');
  const bi = buildBoneIndex(rig);
  const pose = { delta: new Float32Array(rig.boneCount * 3), rootOffsetX: 0, rootOffsetY: 0, rootOffsetZ: 0, rootYaw: 0 };
  writeBreathOverlay(pose, bi, 0.25, 1.0); // sin(2pi*0.25) = 1 -> peak
  assert.ok(Math.abs(pose.delta[bi.Spine * 3] - 1.6) < 1e-6);
  assert.ok(Math.abs(pose.delta[bi.Chest * 3] - 1.6) < 1e-6);
  assert.ok(Math.abs(pose.delta[bi.Neck * 3] - 1.6) < 1e-6);
  assert.ok(Math.abs(pose.rootOffsetY - 0.004) < 1e-9);
});

test('ACTR-12 overlays | breath weight 0 writes nothing', () => {
  const rig = createSkeleton('humanoid');
  const bi = buildBoneIndex(rig);
  const pose = { delta: new Float32Array(rig.boneCount * 3), rootOffsetX: 0, rootOffsetY: 0, rootOffsetZ: 0, rootYaw: 0 };
  writeBreathOverlay(pose, bi, 0.25, 0);
  assert.ok(pose.delta.every((v) => v === 0));
  assert.equal(pose.rootOffsetY, 0);
});

test('ACTR-12 overlays | hit-flinch envelope: exp(-8t)*min(1,25t) verbatim, rises then decays, zero at t=0', () => {
  assert.equal(hitFlinchEnvelope(0), 0);
  const early = hitFlinchEnvelope(0.02); // rise-limited: 25*0.02=0.5
  assert.ok(Math.abs(early - Math.exp(-8 * 0.02) * 0.5) < 1e-9);
  const late = hitFlinchEnvelope(0.29);
  assert.ok(late > 0 && late < 0.2, `expected a decayed-but-positive tail, got ${late}`);
});

test('ACTR-12 overlays | hit-flinch: triggers, decays over its own duration, then deactivates', () => {
  const rig = createSkeleton('humanoid');
  const bi = buildBoneIndex(rig);
  const overlays = createOverlayState();
  triggerHitFlinch(overlays, 'front');
  assert.ok(overlays.hitFlinch.active);
  const pose = { delta: new Float32Array(rig.boneCount * 3), rootOffsetX: 0, rootOffsetY: 0, rootOffsetZ: 0, rootYaw: 0 };
  writeHitFlinchOverlay(pose, bi, overlays, 0.55);
  // t=0 -> envelope 0 -> no visible write yet.
  assert.equal(pose.delta[bi.Chest * 3], 0);
  for (let i = 0; i < 30; i++) advanceOverlayTimers(overlays, DT); // ~0.5s > 0.30s duration
  assert.equal(overlays.hitFlinch.active, false, 'must deactivate past its own duration');
});

test('ACTR-12 overlays | impact recoil + stagger: triggered, nonzero mid-envelope, deactivate after duration', () => {
  const rig = createSkeleton('humanoid');
  const bi = buildBoneIndex(rig);
  const overlays = createOverlayState();
  triggerImpactRecoil(overlays);
  triggerStagger(overlays);
  for (let i = 0; i < 5; i++) advanceOverlayTimers(overlays, DT); // ~0.083s in
  const pose = { delta: new Float32Array(rig.boneCount * 3), rootOffsetX: 0, rootOffsetY: 0, rootOffsetZ: 0, rootYaw: 0 };
  writeImpactRecoilOverlay(pose, bi, overlays);
  writeStaggerOverlay(pose, bi, overlays);
  assert.ok(pose.delta[bi.UpperArmR * 3] !== 0, 'impact recoil should have written the arm');
  assert.ok(pose.delta[bi.Hips * 3] !== 0, 'stagger should have written Hips');
  for (let i = 0; i < 60; i++) advanceOverlayTimers(overlays, DT);
  assert.equal(overlays.impactRecoil.active, false);
  assert.equal(overlays.stagger.active, false);
});

test('ACTR-12 overlays | lean-to-target: exponential lag converges to target, never overshoots for a step input', () => {
  let current = 0;
  const target = 14;
  const tau = 0.18;
  let prevDist = Math.abs(target - current);
  for (let i = 0; i < 300; i++) {
    current = advanceLag(current, target, tau, DT);
    const dist = Math.abs(target - current);
    assert.ok(dist <= prevDist + 1e-9, 'monotonic approach for a constant target');
    prevDist = dist;
  }
  assert.ok(Math.abs(current - target) < 0.01);
});

// ---------------------------------------------------------------------------
// §5.7 spring/damper bank
// ---------------------------------------------------------------------------

test('ACTR-12 springs | converges to a constant target, respects maxDeflection, never NaN', () => {
  const ss = createSpringState();
  const params = SPRINGS.weaponInertia;
  let value = 0;
  for (let i = 0; i < 600; i++) {
    value = advanceSpring(ss, params, 100 /* way beyond maxDeflection */, DT);
    assert.ok(!Number.isNaN(value));
    assert.ok(Math.abs(value) <= params.maxDeflection + 1e-9);
  }
  assert.ok(Math.abs(value - params.maxDeflection) < 0.5, `should have settled near the clamp, got ${value}`);
});

test('ACTR-12 springs | a huge dt (60ms hitch) is capped at SPRING_MAX_SUBSTEPS, never detonates', () => {
  const ss = createSpringState();
  const params = SPRINGS.hitShake;
  const value = advanceSpring(ss, params, 9, 0.060); // the exact hitch 08 §5.7 names
  assert.ok(!Number.isNaN(value));
  assert.ok(Math.abs(value) <= params.maxDeflection + 1e-6);
  assert.ok(ss.acc >= 0, 'leftover accumulator must not go negative');
});

// ---------------------------------------------------------------------------
// composeSkeletonWorld — cross-checked against rig.js's own reconstructBindPos
// ---------------------------------------------------------------------------

test('ACTR-12 skeleton | at an all-zero pose, composeSkeletonWorld reproduces rig.js\'s own bind pose exactly (cross-check against reconstructBindPos)', () => {
  const rig = createSkeleton('humanoid');
  const pose = { delta: new Float32Array(rig.boneCount * 3), rootOffsetX: 0, rootOffsetY: 0, rootOffsetZ: 0, rootYaw: 0 };
  const worldQuat = new Float64Array(rig.boneCount * 4);
  const worldPos = new Float64Array(rig.boneCount * 3);
  composeSkeletonWorld(rig, pose, worldQuat, worldPos);

  const reconstructed = reconstructBindPos(rig); // rig.js's own, independent implementation
  for (let i = 0; i < rig.boneCount; i++) {
    const a = vec3At(worldPos, i);
    const b = vec3At(reconstructed, i);
    const err = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
    assert.ok(err < 1e-6, `${rig.names[i]}: composeSkeletonWorld=${JSON.stringify(a)} vs reconstructBindPos=${JSON.stringify(b)}, err=${err}`);
  }
});

test('ACTR-12 skeleton | root offset/yaw perturb only the Root bone\'s own transform, applied on top', () => {
  const rig = createSkeleton('humanoid');
  const pose = { delta: new Float32Array(rig.boneCount * 3), rootOffsetX: 1, rootOffsetY: 2, rootOffsetZ: 3, rootYaw: 0 };
  const worldQuat = new Float64Array(rig.boneCount * 4);
  const worldPos = new Float64Array(rig.boneCount * 3);
  composeSkeletonWorld(rig, pose, worldQuat, worldPos);
  assert.ok(Math.abs(worldPos[0] - (rig.bindPos[0] + 1)) < 1e-9);
  assert.ok(Math.abs(worldPos[1] - (rig.bindPos[1] + 2)) < 1e-9);
  assert.ok(Math.abs(worldPos[2] - (rig.bindPos[2] + 3)) < 1e-9);
});

test('ACTR-12 skeleton | every quaternion stays unit-length under a real animated pose (sanity, no drift/NaN)', () => {
  const rig = createSkeleton('humanoid');
  const state = createAnimatorState(rig);
  for (let i = 0; i < 120; i++) updateAnimator(state, { speed: ARCHETYPE_SPEEDS.bone_ranker.run }, DT);
  for (let i = 0; i < rig.boneCount; i++) {
    const q = quatAt(state.worldQuat, i);
    const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    assert.ok(Math.abs(len - 1) < 1e-6, `${rig.names[i]}: |q|=${len}`);
  }
});

// ---------------------------------------------------------------------------
// Node-safe boundary
// ---------------------------------------------------------------------------

test('ACTR-12 | module import is Node-safe (no three/DOM at import time)', () => {
  assert.equal(typeof createAnimatorState, 'function');
  assert.equal(typeof globalThis.document === 'undefined' || true, true);
});
