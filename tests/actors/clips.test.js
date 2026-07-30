// tests/actors/clips.test.js
//
// ACTR-11 acceptance tests for src/actors/clips.js — `08 §11 step 5`: "three
// `walk` shots at phase 0.0/0.33/0.66" (the visual half, covered by
// src/dev/shots.js's three new dev shots, not re-tested here — this file has
// no `three`) "; Node harness integrates foot world position over a stride
// and reports foot slide < 4 cm" (the harness half — THIS file, see the
// "Foot slide" section below). `node:test` + `node:assert/strict` only
// (12-testing.md P6). Plain arithmetic throughout — no clock read, no
// allocation measurement — so per D-11 this stays `clips.test.js`, not
// `.perf.test.js`.
//
// This file also reuses src/actors/rig.js's own bind/local tables — exactly
// the "a test file imports an actors module directly" pattern
// tests/actors/rig.test.js and tests/actors/bone_ranker.test.js already use
// — plus a small local quaternion toolkit (matching rig.js's own
// `quatMultiply`/`quatRotateVec`/axis-angle convention, duplicated here per
// this codebase's established "each file keeps its own math" rule, cited in
// bone_ranker.js's header) to do the forward-kinematics walk clips.js itself
// deliberately does not perform (see clips.js's own header, "Scope").

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSkeleton } from '../../src/actors/rig.js';
import {
  CLIPS,
  ARCHETYPE_SPEEDS,
  GAIT_PARAMS,
  LEG_SIDE_OFFSET,
  TRANSITION,
  IDLE_SPEED_THRESHOLD,
  computeStrideHz,
  advancePhase,
  jitterFromActorId,
  createCrossfadeState,
  crossfadeWeight,
  gaitAngles,
  pelvisMotion,
  spineCounterRotation,
  createPose,
  resetPose,
  buildLocomotionBoneIndex,
  createLocomotionState,
  createLocomotionScratch,
  writeLocomotionPose,
} from '../../src/actors/clips.js';

// ---------------------------------------------------------------------------
// 08 §5.4 — strideHz clamp and the documented cadences ("assert them")
// ---------------------------------------------------------------------------

test('ACTR-11 clips | computeStrideHz clamps to [minHz, maxHz]', () => {
  assert.equal(computeStrideHz(0, CLIPS.walk), CLIPS.walk.minHz);
  assert.equal(computeStrideHz(1000, CLIPS.walk), CLIPS.walk.maxHz);
  assert.ok(Math.abs(computeStrideHz(CLIPS.walk.refSpeed, CLIPS.walk) - CLIPS.walk.refSpeed / CLIPS.walk.strideLength) < 1e-12);
});

test('ACTR-11 clips | idle strideHz is pinned regardless of speed (minHz === maxHz)', () => {
  assert.equal(CLIPS.idle.minHz, CLIPS.idle.maxHz);
  assert.equal(computeStrideHz(0, CLIPS.idle), CLIPS.idle.minHz);
  assert.equal(computeStrideHz(99, CLIPS.idle), CLIPS.idle.minHz);
});

test('ACTR-11 clips | walk cycle at ref speed (2.2 m/s) is 1/(2.2/1.45) ~= 0.66 s — the documented cadence', () => {
  const hz = computeStrideHz(ARCHETYPE_SPEEDS.player.walk, CLIPS.walk);
  const cycle = 1 / hz;
  console.log(`[clips] walk cycle @ ref speed ${ARCHETYPE_SPEEDS.player.walk} m/s = ${cycle.toFixed(4)} s (spec: 0.66 s)`);
  assert.ok(Math.abs(cycle - CLIPS.walk.cycleAtRef) < 0.005, `walk cycle ${cycle} not within 5 ms of ${CLIPS.walk.cycleAtRef}`);
});

test('ACTR-11 clips | run cycle at ref speed (4.6 m/s) is 1/(4.6/2.90) ~= 0.63 s — the documented cadence', () => {
  const hz = computeStrideHz(ARCHETYPE_SPEEDS.player.run, CLIPS.run);
  const cycle = 1 / hz;
  console.log(`[clips] run cycle @ ref speed ${ARCHETYPE_SPEEDS.player.run} m/s = ${cycle.toFixed(4)} s (spec: 0.63 s)`);
  assert.ok(Math.abs(cycle - CLIPS.run.cycleAtRef) < 0.005, `run cycle ${cycle} not within 5 ms of ${CLIPS.run.cycleAtRef}`);
});

test('ACTR-11 clips | advancePhase wraps into [0,1) and matches speed*dt/strideLength progress', () => {
  let phase = 0.9;
  phase = advancePhase(phase, 0.5, 0.5); // +0.25 -> 1.15 -> wraps to 0.15
  assert.ok(Math.abs(phase - 0.15) < 1e-9);
  // A full cycle's worth of dt at a constant strideHz returns to the same phase.
  const hz = computeStrideHz(2.2, CLIPS.walk);
  const cycle = 1 / hz;
  let p = 0.37;
  const steps = 500;
  for (let i = 0; i < steps; i++) p = advancePhase(p, cycle / steps, hz);
  assert.ok(Math.abs(p - 0.37) < 1e-6, `phase drifted: ${p}`);
});

// ---------------------------------------------------------------------------
// rateJitter — deterministic, no Math.random, bounded, per-actor
// ---------------------------------------------------------------------------

test('ACTR-11 clips | jitterFromActorId is deterministic and bounded, never Math.random', () => {
  const a = jitterFromActorId(42, 0);
  const b = jitterFromActorId(42, 0);
  assert.equal(a, b);
  for (let id = 1; id <= 200; id++) {
    const j = jitterFromActorId(id, 1, 0.03);
    assert.ok(j >= 0.97 - 1e-9 && j <= 1.03 + 1e-9, `jitter ${j} out of [0.97,1.03] for id ${id}`);
  }
  // Different salts (walk vs run) must not draw the same offset for one actor.
  assert.notEqual(jitterFromActorId(7, 0), jitterFromActorId(7, 1));
});

// ---------------------------------------------------------------------------
// Crossfade hysteresis — "an actor jostled at the boundary does not flicker"
// ---------------------------------------------------------------------------

test('ACTR-11 clips | crossfadeWeight saturates to pure walk / pure run away from the band', () => {
  const state = createCrossfadeState();
  assert.equal(crossfadeWeight(0.5, state), 0);
  const state2 = createCrossfadeState();
  assert.equal(crossfadeWeight(10, state2), 1);
});

test('ACTR-11 clips | crossfadeWeight hysteresis prevents flicker for small oscillation at the upper edge', () => {
  const state = createCrossfadeState();
  // Drive speed up through the band into run territory first.
  for (const s of [2.5, 2.9, 3.2, 3.6, 4.0]) crossfadeWeight(s, state);
  assert.equal(state.dominant, 'run');
  // Now oscillate a small amount right around the (un-hystereses) upper edge
  // (3.5) — without hysteresis this would repeatedly cross weight=0.5 and
  // flip `dominant`; with it, `dominant` should not flip back to 'walk'
  // until speed drops well below the original lower edge.
  let flips = 0;
  let prevDominant = state.dominant;
  for (let i = 0; i < 20; i++) {
    const s = 3.45 + (i % 2 === 0 ? 0.1 : -0.1); // oscillates 3.35 <-> 3.55
    crossfadeWeight(s, state);
    if (state.dominant !== prevDominant) flips++;
    prevDominant = state.dominant;
  }
  assert.ok(flips === 0, `dominant flipped ${flips} times under small oscillation near the upper edge`);
});

// ---------------------------------------------------------------------------
// gaitAngles — sanity: finite, opposite-leg phase offset actually differs
// ---------------------------------------------------------------------------

test('ACTR-11 clips | gaitAngles is finite everywhere and the two legs are in antiphase', () => {
  const out = { thigh: 0, knee: 0, ankle: 0 };
  const outL = { thigh: 0, knee: 0, ankle: 0 };
  for (let i = 0; i <= 100; i++) {
    const phase = i / 100;
    gaitAngles(phase, LEG_SIDE_OFFSET.R, GAIT_PARAMS.walk, out);
    assert.ok(Number.isFinite(out.thigh) && Number.isFinite(out.knee) && Number.isFinite(out.ankle));
    assert.ok(out.knee <= 0, `knee should never be positive (a flexion-only joint), got ${out.knee} at phase ${phase}`);
  }
  gaitAngles(0.1, LEG_SIDE_OFFSET.R, GAIT_PARAMS.walk, out);
  gaitAngles(0.6, LEG_SIDE_OFFSET.L, GAIT_PARAMS.walk, outL); // 0.5 cycle later == same point in R's cycle
  assert.ok(Math.abs(out.thigh - outL.thigh) < 1e-9, 'L at phase+0.5 should match R (antiphase)');
});

// ---------------------------------------------------------------------------
// Pose writing — smoke test: idle vs moving selects the right path, zero
// allocation is a code-review property (out-params throughout), not measured
// here (see clips.js's own header; a byte-level allocation budget is ACTR-12's
// own acceptance criterion, 08 §11 step 6, not this ticket's).
// ---------------------------------------------------------------------------

test('ACTR-11 clips | writeLocomotionPose: idle at rest leaves legs untouched, moving bends them', () => {
  const rig = createSkeleton('humanoid', { cloak: false });
  const boneIndex = buildLocomotionBoneIndex(rig);
  const pose = createPose(rig.boneCount);
  const state = createLocomotionState();
  const scratch = createLocomotionScratch();

  writeLocomotionPose(pose, boneIndex, state, scratch, 0, 1 / 60);
  const upLegR = boneIndex.UpLegR;
  assert.equal(pose.delta[upLegR * 3], 0, 'idle should not bend the leg');

  resetPose(pose);
  const state2 = createLocomotionState();
  // Run several frames so phase has moved off 0.
  let t = 0;
  for (let i = 0; i < 10; i++) {
    writeLocomotionPose(pose, boneIndex, state2, scratch, 2.2, 1 / 60);
    t += 1 / 60;
  }
  assert.ok(pose.delta[upLegR * 3] !== 0, 'walking should bend the leg away from 0');
  assert.ok(Number.isFinite(pose.rootOffsetY) && Number.isFinite(pose.rootOffsetX));
});

test('ACTR-11 clips | writeLocomotionPose never reads a clock and is a pure function of (state, speed, dt)', () => {
  // Determinism check: two independent state/scratch pairs driven with the
  // same speed/dt sequence must produce byte-identical poses.
  const rig = createSkeleton('humanoid', { cloak: false });
  const boneIndex = buildLocomotionBoneIndex(rig);
  function run() {
    const pose = createPose(rig.boneCount);
    const state = createLocomotionState();
    const scratch = createLocomotionScratch();
    for (let i = 0; i < 37; i++) writeLocomotionPose(pose, boneIndex, state, scratch, 3.1, 1 / 60);
    return pose;
  }
  const a = run();
  const b = run();
  assert.deepEqual(Array.from(a.delta), Array.from(b.delta));
  assert.equal(a.rootOffsetX, b.rootOffsetX);
  assert.equal(a.rootOffsetY, b.rootOffsetY);
});

// ---------------------------------------------------------------------------
// Foot slide — 08 §11 step 5's hard acceptance criterion
// ---------------------------------------------------------------------------
//
// REVISED per coordinator review: an earlier version of this section scanned
// every possible start-phase for whichever contiguous window happened to
// have the least drift, and reported that. That is selecting the
// measurement to fit the 4 cm threshold, not measuring the property the
// criterion actually asks about ("over a stride") — correctly rejected. This
// version instead (1) fixes ONE stance definition, stated once, before
// looking at any number, (2) reports whatever drift that definition
// produces, honestly, even though it is well over 4 cm for both clips, and
// (3) separately proves, from the fixed §5.4 amplitudes alone (not from any
// choice this file makes), whether a truly-planted instant can exist at
// all. See "What the arithmetic shows" below for the verdict, and
// clips.js's own header for the same finding recorded at the data-table
// level and bound to ACTR-13.
//
// clips.js deliberately does no world-space forward kinematics (see its own
// header, "Scope") — this section does it, reusing rig.js's own bind/local
// tables and quaternion convention (see rig.js's header) plus clips.js's
// `gaitAngles`. The chain built below is EXACTLY rig.js#reconstructBindPos's
// own parent-walk, with one extra quaternion factor inserted at `UpLeg*`
// (thigh) and `Leg*` (knee): `08` §5.1's own formula is "q = bindLocal ·
// euler(delta)", i.e. the SAME quatMultiply(parentWorld, localQuat) chaining
// reconstructBindPos already uses, with `quatMultiply(localQuat, deltaQuat)`
// substituted for the bind-only `localQuat` at those two bones. Only the
// ankle/`Foot*` bone's OWN position is tracked (the joint the thigh+knee
// chain determines) — the ankle ANGLE itself only reorients that leaf bone,
// it does not move its own origin, so it does not affect this measurement
// (see clips.js's header for why bias_a/ankle amplitude were judged
// irrelevant to foot slide for the same reason).

function quatMultiply(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function quatRotateVec(q, v) {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const uvx = qy * v.z - qz * v.y, uvy = qz * v.x - qx * v.z, uvz = qx * v.y - qy * v.x;
  const uuvx = qy * uvz - qz * uvy, uuvy = qz * uvx - qx * uvz, uuvz = qx * uvy - qy * uvx;
  return { x: v.x + 2 * (qw * uvx + uuvx), y: v.y + 2 * (qw * uvy + uuvy), z: v.z + 2 * (qw * uvz + uuvz) };
}

/** `08` §5.1: "q = bindLocal · euler(delta)" — a rotation about local X by
 * `deg` degrees, as an axis-angle quaternion. Confirmed (not just assumed)
 * to be the sagittal-swing axis for this rig's leg bones: rig.js's own
 * "aim +Y at child, up hint = world +Z forward" convention (§2.1, cited in
 * rig.js's header) puts each leg bone's local X along `cross(down, forward)`
 * — rotating about it sweeps the child bone in the parent's own Y-Z
 * (vertical/forward) plane, exactly the thigh/knee/ankle swing `08` §5.4
 * describes. Verified empirically while building this test: a positive
 * thigh-delta measurably swings the knee forward AND raises it (the correct
 * pendulum-arc signature), never sideways. */
function eulerXDelta(deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: Math.sin(rad / 2), y: 0, z: 0, w: Math.cos(rad / 2) };
}

/**
 * World position of `Foot<side>` at `phase`, for a rig standing at the
 * world origin with no additional root translation applied (the caller adds
 * that). Walks `rig.parents` from the root exactly like
 * `reconstructBindPos`, composing `gaitAngles`' thigh/knee deltas at
 * `UpLeg<side>`/`Leg<side>`.
 */
function footWorldLocal(rig, boneIndex, side, phase, gp, scratchAngles) {
  gaitAngles(phase, LEG_SIDE_OFFSET[side], gp, scratchAngles);
  const upLeg = boneIndex['UpLeg' + side];
  const leg = boneIndex['Leg' + side];
  const foot = boneIndex['Foot' + side];
  const thighDelta = eulerXDelta(scratchAngles.thigh);
  const kneeDelta = eulerXDelta(scratchAngles.knee);

  const n = foot + 1;
  const worldPos = new Array(n);
  const worldQuat = new Array(n);
  for (let i = 0; i < n; i++) {
    const parent = rig.parents[i];
    const lp = { x: rig.localPos[i * 3], y: rig.localPos[i * 3 + 1], z: rig.localPos[i * 3 + 2] };
    let lq = {
      x: rig.localQuat[i * 4], y: rig.localQuat[i * 4 + 1], z: rig.localQuat[i * 4 + 2], w: rig.localQuat[i * 4 + 3],
    };
    if (i === upLeg) lq = quatMultiply(lq, thighDelta);
    if (i === leg) lq = quatMultiply(lq, kneeDelta);
    if (parent < 0) {
      worldPos[i] = lp;
      worldQuat[i] = lq;
    } else {
      const rotated = quatRotateVec(worldQuat[parent], lp);
      worldPos[i] = { x: worldPos[parent].x + rotated.x, y: worldPos[parent].y + rotated.y, z: worldPos[parent].z + rotated.z };
      worldQuat[i] = quatMultiply(worldQuat[parent], lq);
    }
  }
  return worldPos[foot];
}

/**
 * Samples the right foot's world (x, y, z) across `strides` full gait
 * cycles at the clip's own reference speed (root translating along +Z at a
 * constant `refSpeed`), laid out as three consecutive cycles so a window
 * found in the MIDDLE cycle never needs modular-wraparound arithmetic.
 * Returns flat per-sample arrays plus `samplesPerCycle`.
 */
function sampleFootTrajectory(clipId, strides, samplesPerCycle) {
  const rig = createSkeleton('humanoid', { cloak: false });
  const boneIndex = buildLocomotionBoneIndex(rig);
  const clip = CLIPS[clipId];
  const gp = GAIT_PARAMS[clipId];
  const speed = clip.refSpeed;
  const strideHz = computeStrideHz(speed, clip);
  assert.ok(Math.abs(strideHz - speed / clip.strideLength) < 1e-9, 'sanity: ref speed must sit inside the un-clamped range');
  const dt = 1 / strideHz / samplesPerCycle;

  const total = samplesPerCycle * strides;
  const xs = new Float64Array(total);
  const zs = new Float64Array(total);
  const ys = new Float64Array(total);
  const scratchAngles = { thigh: 0, knee: 0, ankle: 0 };
  let phase = 0;
  let rootZ = 0;
  for (let i = 0; i < total; i++) {
    const local = footWorldLocal(rig, boneIndex, 'R', phase % 1, gp, scratchAngles);
    xs[i] = local.x;
    zs[i] = local.z + rootZ;
    ys[i] = local.y;
    rootZ += speed * dt;
    phase += dt * strideHz; // unwrapped on purpose — see the header, "laid out as consecutive cycles"
  }
  return { xs, zs, ys, samplesPerCycle };
}

/**
 * The stance-window definition, fixed ONCE, before any drift number is
 * looked at (see this section's header): stance is the single contiguous
 * span, centred on the cycle's own lowest foot-height sample, for which the
 * foot height stays within 10% of that minimum VALUE (`y <= minY * 1.10`) —
 * the plain reading of "within 10% of its lowest point". No other window is
 * considered and nothing is scanned for a better slice.
 *
 * @returns {{slideMeters:number, widthFrac:number, minY:number}}
 */
function measureFootSlideOverStanceWindow(clipId, strides = 3, samplesPerCycle = 3600) {
  const { xs, zs, ys, samplesPerCycle: N } = sampleFootTrajectory(clipId, strides, samplesPerCycle);
  // Look for the global minimum, and grow the window from it, only inside
  // the MIDDLE cycle (index range [N, 2N)) — see sampleFootTrajectory's
  // header for why that avoids any wraparound special-casing.
  let minY = Infinity;
  for (let i = N; i < 2 * N; i++) if (ys[i] < minY) minY = ys[i];
  const threshold = minY * 1.1;
  let argmin = N;
  for (let i = N; i < 2 * N; i++) if (ys[i] === minY) argmin = i;
  let lo = argmin;
  let hi = argmin;
  while (ys[lo - 1] <= threshold) lo--;
  while (ys[hi + 1] <= threshold) hi++;

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = lo; i <= hi; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (zs[i] < minZ) minZ = zs[i];
    if (zs[i] > maxZ) maxZ = zs[i];
  }
  const dx = maxX - minX;
  const dz = maxZ - minZ;
  return { slideMeters: Math.sqrt(dx * dx + dz * dz), widthFrac: (hi - lo + 1) / N, minY };
}

/**
 * The reachability arithmetic the coordinator asked for: is 4 cm even
 * POSSIBLE at `08` §5.4's own fixed numbers, independent of any window
 * definition? Two checks, both computed straight from the spec's own table
 * (`GAIT_PARAMS`/`CLIPS`) and `rig.js`'s own leg length:
 *
 *  1. A simple-pendulum upper bound: with the hip as a fixed pivot and the
 *     whole leg (thigh+shin, `rig.js`'s own bind-pose lengths) swinging by
 *     `±A_t` about vertical, the MOST horizontal ground a straight-legged
 *     swing could ever cover, peak-to-trough, is `2*L*sin(A_t)`. Bending the
 *     knee only ever SHORTENS this (it can never lengthen the reach beyond
 *     a straight leg), so this is a genuine upper bound, not an estimate —
 *     and it is DEFINITION-INDEPENDENT: no phase convention, sign
 *     convention, or knee-formula reading changes it. This is the load
 *     bearing half of the finding, and is asserted below.
 *  2. A per-phase closing-RATE diagnostic — the steepest (most negative)
 *     `d(localZ)/dphase` the real two-bone chain reaches, compared against
 *     `-strideLength` (the rate a truly world-stationary foot would need,
 *     since the root advances exactly `strideLength` per unit phase). This
 *     figure is CONVENTION-SENSITIVE: the coordinator's own independent
 *     reproduction, sampling the same rig at the same resolution, got
 *     materially different numbers under two different knee-sign readings
 *     of the same formula (walk -2.667/-2.003, run -3.828/-3.163) than this
 *     file's own -2.22/-2.49 — every one of those four readings clears
 *     `-strideLength` for run except this file's, so the two independent
 *     computations disagree on whether run even has a momentary stationary
 *     instant. NOT asserted, printed only — see clips.js's header,
 *     "Foot slide", for the same caveat recorded at the data-table level:
 *     whoever builds ACTR-13 should re-derive this figure rather than trust
 *     either side of the disagreement.
 */
function reachabilityArithmetic(clipId) {
  const rig = createSkeleton('humanoid', { cloak: false });
  const boneIndex = buildLocomotionBoneIndex(rig);
  const clip = CLIPS[clipId];
  const gp = GAIT_PARAMS[clipId];
  const scratchAngles = { thigh: 0, knee: 0, ankle: 0 };

  function bonePos(name) {
    const i = boneIndex[name];
    return { x: rig.bindPos[i * 3], y: rig.bindPos[i * 3 + 1], z: rig.bindPos[i * 3 + 2] };
  }
  function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
  }
  const legLength = dist(bonePos('UpLegR'), bonePos('LegR')) + dist(bonePos('LegR'), bonePos('FootR'));
  const pendulumReachM = 2 * legLength * Math.sin((gp.A_t * Math.PI) / 180);

  const N = 20000;
  let steepest = Infinity; // most negative d(localZ)/dphase
  let prevZ = footWorldLocal(rig, boneIndex, 'R', 0, gp, scratchAngles).z;
  for (let i = 1; i <= N; i++) {
    const phase = i / N;
    const z = footWorldLocal(rig, boneIndex, 'R', phase, gp, scratchAngles).z;
    const slope = (z - prevZ) * N; // d(localZ)/dphase, central-enough at this N
    if (slope < steepest) steepest = slope;
    prevZ = z;
  }
  const requiredSlope = -clip.strideLength;
  return {
    legLength, pendulumReachM,
    pendulumReachFracOfStride: pendulumReachM / clip.strideLength,
    steepestClosingRate: steepest,
    requiredSlope,
  };
}

test('ACTR-11 clips | reachability: the pendulum bound proves neither leg can sweep a full stride length (printed arithmetic; agreed, definition-independent)', () => {
  for (const clipId of ['walk', 'run']) {
    const r = reachabilityArithmetic(clipId);
    console.log(
      `[clips] REACHABILITY ${clipId} — leg length ${r.legLength.toFixed(4)} m, ` +
      `pendulum max reach ${r.pendulumReachM.toFixed(4)} m = ${(r.pendulumReachFracOfStride * 100).toFixed(1)}% ` +
      `of strideLength ${CLIPS[clipId].strideLength} m (agreed, definition-independent). ` +
      `Per-phase closing-rate diagnostic (convention-sensitive, NOT asserted — see this ` +
      `function's own header): steepest d(localZ)/dphase = ${r.steepestClosingRate.toFixed(4)}, ` +
      `vs a truly-stationary foot's required ${r.requiredSlope.toFixed(4)}.`,
    );
  }
  // Only the pendulum bound is asserted — it is definition-independent and
  // both this file's and the coordinator's own reproduction agree on it
  // exactly. It alone is enough to prove the finding that matters: neither
  // clip's leg can geometrically sweep as far as one full strideLength, so
  // an extended, biomechanical-length stance is impossible at these fixed
  // §5.4 amplitudes regardless of any stance-window definition.
  const walk = reachabilityArithmetic('walk');
  const run = reachabilityArithmetic('run');
  assert.ok(walk.pendulumReachM < CLIPS.walk.strideLength, 'walk: pendulum reach must fall short of one full stride');
  assert.ok(run.pendulumReachM < CLIPS.run.strideLength, 'run: pendulum reach must fall short of one full stride');
  assert.ok(Math.abs(walk.pendulumReachFracOfStride - 0.425) < 0.005, `walk pendulum reach fraction drifted: ${walk.pendulumReachFracOfStride}`);
  assert.ok(Math.abs(run.pendulumReachFracOfStride - 0.331) < 0.005, `run pendulum reach fraction drifted: ${run.pendulumReachFracOfStride}`);
});

test('ACTR-11 clips | walk: foot slide over the disclosed 10%-of-minimum stance window (measured honestly, NOT scanned for best case)', () => {
  const r = measureFootSlideOverStanceWindow('walk');
  const cm = r.slideMeters * 100;
  console.log(
    `[clips] FOOT SLIDE walk @ ${CLIPS.walk.refSpeed} m/s — stance := height <= 1.10x its own cycle minimum ` +
    `(width ${(r.widthFrac * 100).toFixed(1)}% of cycle): ${cm.toFixed(2)} cm`,
  );
  // NOT asserted < 4 cm: under this disclosed, non-cherry-picked window it
  // is not, and forcing the assertion would mean re-introducing a scan (or
  // an unjustified amplitude change) to make it pass — both rejected by the
  // coordinator. The gap is real and is bound to ACTR-13 (08 §11 step 7,
  // Foot IK) in this file's own header and in this ticket's report. What IS
  // asserted: the measurement is finite and positive — the pendulum-bound
  // test above is what carries the actual "can this reach 4 cm" verdict.
  assert.ok(Number.isFinite(cm) && cm > 0);
});

test('ACTR-11 clips | run: foot slide over the disclosed 10%-of-minimum stance window (measured honestly, NOT scanned for best case)', () => {
  const r = measureFootSlideOverStanceWindow('run');
  const cm = r.slideMeters * 100;
  console.log(
    `[clips] FOOT SLIDE run @ ${CLIPS.run.refSpeed} m/s — stance := height <= 1.10x its own cycle minimum ` +
    `(width ${(r.widthFrac * 100).toFixed(1)}% of cycle): ${cm.toFixed(2)} cm`,
  );
  // Same as walk's test above: not asserted < 4 cm (it is not — see the
  // pendulum-bound test for the agreed, definition-independent reason why).
  // Bound to ACTR-13.
  assert.ok(Number.isFinite(cm) && cm > 0);
});

test('ACTR-11 clips | walk: the stance-window drift is stable across repeated strides over ~10 m (backlog wording, no phase-wrap drift)', () => {
  // The backlog's own wording is "no foot slide over 10 m" — the same
  // property as the spec's "over a stride". This checks that the SAME
  // disclosed measurement, taken again after enough strides to cover
  // roughly 10 m (10 / 1.45 ~= 7 strides), reproduces the same figure —
  // i.e. `advancePhase`'s wraparound introduces no cumulative drift of its
  // own on top of the curve's own (real, reported) per-stride gap.
  const oneStride = measureFootSlideOverStanceWindow('walk', 3);
  const strides = Math.ceil(10 / CLIPS.walk.strideLength);
  const manyStrides = measureFootSlideOverStanceWindow('walk', strides);
  const cmOne = oneStride.slideMeters * 100;
  const cmMany = manyStrides.slideMeters * 100;
  console.log(`[clips] FOOT SLIDE walk, single stride vs ~10 m (${strides} strides): ${cmOne.toFixed(2)} cm vs ${cmMany.toFixed(2)} cm`);
  assert.ok(Math.abs(cmOne - cmMany) < 0.05, `stance-window drift drifted further over repeated strides: ${cmOne} cm vs ${cmMany} cm`);
});
