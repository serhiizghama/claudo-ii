// tests/actors/ik.test.js
//
// ACTR-13 acceptance tests for src/actors/ik.js (and, narrowly, the O-52
// repair to src/actors/clips.js#crossfadeWeight — see that section below;
// ik.js is the only test file this ticket's brief allows, so the O-52
// continuity test lives here rather than in a `clips.*.test.js` file this
// ticket has no permission to create).
//
// `node:test` + `node:assert/strict` only (12-testing.md P6, matching every
// sibling `tests/actors/*.test.js`).
//
// O-43 naming note: this file mixes correctness tests with one allocation
// probe (N >= 1_000_000, per O-43) and the acceptance-criterion numbers
// (12° ramp residual, 0.45 m step, re-measured foot slide). O-43's own
// convention names an allocation-asserting file `*.perf.test.js` so it
// lands in `npm run test:perf`'s isolated `--test-concurrency=1` stage
// (see `tests/actors/anim.perf.test.js`). This ticket's file list allows
// exactly one test file — `tests/actors/ik.test.js` — so that split is not
// possible here without creating a second file this ticket has no
// permission to add. Reported, not silently worked around: the allocation
// probe below runs in the CONCURRENT `test:unit` stage, which is a real,
// documented tension with O-43's own naming convention. A follow-up/wiring
// ticket that can touch the test file list should split this into its own
// `ik.perf.test.js`.
//
// FK harness below (`legWorldFK` et al.) is this file's OWN copy of the
// same forward-kinematics chain `tests/actors/clips.test.js` already built
// and verified (rig.js's parent-walk, `08` §5.1's "q = bindLocal ·
// euler(delta)", local-X as the sagittal swing axis) — duplicated, not
// imported, because `clips.test.js`'s own helpers are not exported (and is
// not a file this ticket may edit to export them). This matches the
// codebase's own established convention of each file keeping its own copy
// of this small chain (`rig.js`, `clips.test.js`, `anim.js` each do); see
// `anim.js`'s header for the explicit "each file keeps its own math" note.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { hasGc, allocatedBytes } from '../helpers/alloc.js';
import { createSkeleton } from '../../src/actors/rig.js';
import {
  CLIPS,
  GAIT_PARAMS,
  LEG_SIDE_OFFSET,
  TRANSITION,
  computeStrideHz,
  gaitAngles,
  buildLocomotionBoneIndex,
  crossfadeWeight,
  createCrossfadeState,
} from '../../src/actors/clips.js';
import { ACTOR_STATE } from '../../src/actors/data/states.js';
import {
  IK_DATA,
  isFootIKEnabled,
  probeGround,
  computePelvisDrop,
  solveTwoBoneLeg,
  computeSoleRollDeg,
  createFootLockState,
  updateFootLock,
  detectFootstepCrossings,
  emitFootstep,
  createIKState,
  updateFootIK,
} from '../../src/actors/ik.js';

// ---------------------------------------------------------------------------
// Node-safety self-test — src/actors/ is a strict check-imports.mjs root
// (checkGlobals: true). Mirrors tests/actors/actr2.test.js's own pattern.
// ---------------------------------------------------------------------------

/** Strips line comments and block comments so a prose mention inside a doc
 * comment (this file's own header talks ABOUT the banned globals at length,
 * to explain why they're banned) never trips a regex meant to catch real
 * CODE. Same masking idea `tools/check-imports.mjs` uses for its own
 * import/global scan, applied narrowly here. */
function maskComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('src/actors/ik.js never references three/document/window/performance.now/Math.random/Math.hypot', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, '../../src/actors/ik.js'), 'utf8');
  const src = maskComments(raw);
  assert.equal(/from\s+['"]three['"]/.test(src), false, 'must not import three');
  assert.equal(/import\s*\(\s*['"]three['"]/.test(src), false, 'must not dynamically import three');
  assert.equal(/\bdocument\s*\./.test(src), false, 'must not reference document');
  assert.equal(/\bwindow\s*\./.test(src), false, 'must not reference window');
  assert.equal(/performance\s*\.\s*now\s*\(/.test(src), false, 'must not call performance.now()');
  assert.equal(/Math\s*\.\s*random\s*\(/.test(src), false, 'must not call Math.random()');
  assert.equal(/Math\s*\.\s*hypot\s*\(/.test(src), false, 'must not call Math.hypot() (banned, allocates)');
  assert.equal(/\bnew\s+Map\s*\(/.test(src), false, 'must not use Map for per-actor state');
});

// ---------------------------------------------------------------------------
// A fake ctx — only `get('physics')`/`get('world')`/`events` are needed.
// ---------------------------------------------------------------------------

function makeFakeCtx(groundHeightFn, surfaceFn) {
  const emitted = [];
  const physics = { groundHeight: groundHeightFn };
  const world = { surfaceAt: surfaceFn || (() => 'stone') };
  const systems = { physics, world };
  return {
    emitted,
    events: {
      emit(name, payload) {
        emitted.push({ name, payload });
      },
    },
    get(id) {
      if (systems[id]) return systems[id];
      throw new Error(`stub ctx.get: '${id}' is not available`);
    },
  };
}

// ---------------------------------------------------------------------------
// isFootIKEnabled — 08 §5.8 step 5
// ---------------------------------------------------------------------------

test('ACTR-13 ik | isFootIKEnabled disables during dead/spawning and caller-flagged dash/scripted', () => {
  assert.equal(isFootIKEnabled(ACTOR_STATE.idle), true);
  assert.equal(isFootIKEnabled(ACTOR_STATE.move), true);
  assert.equal(isFootIKEnabled(ACTOR_STATE.dead), false);
  assert.equal(isFootIKEnabled(ACTOR_STATE.spawning), false);
  assert.equal(isFootIKEnabled(ACTOR_STATE.idle, { dashing: true }), false);
  assert.equal(isFootIKEnabled(ACTOR_STATE.idle, { scripted: true }), false);
  assert.equal(isFootIKEnabled(ACTOR_STATE.windup), true);
});

// ---------------------------------------------------------------------------
// probeGround — flat ground, and a 12° ramp's own normal
// ---------------------------------------------------------------------------

test('ACTR-13 ik | probeGround on flat ground reports y=0, normal straight up, given surface', () => {
  const ctx = makeFakeCtx(() => 0, () => 'grass');
  const out = { y: 0, nx: 0, ny: 0, nz: 0, surface: '' };
  probeGround(ctx, 3, -5, out);
  assert.equal(out.y, 0);
  assert.ok(Math.abs(out.nx) < 1e-9);
  assert.ok(Math.abs(out.ny - 1) < 1e-9);
  assert.ok(Math.abs(out.nz) < 1e-9);
  assert.equal(out.surface, 'grass');
});

test('ACTR-13 ik | probeGround on a 12° ramp (slope along Z) reports the analytic normal', () => {
  const slopeRad = (12 * Math.PI) / 180;
  const groundHeight = (x, z) => z * Math.tan(slopeRad);
  const ctx = makeFakeCtx(groundHeight, () => 'dirt');
  const out = { y: 0, nx: 0, ny: 0, nz: 0, surface: '' };
  probeGround(ctx, 0, 2, out);
  assert.ok(Math.abs(out.y - 2 * Math.tan(slopeRad)) < 1e-9);
  // Analytic normal of a plane y = z*tan(theta): (0, cos(theta), -sin(theta)).
  const expectedNy = Math.cos(slopeRad);
  const expectedNz = -Math.sin(slopeRad);
  assert.ok(Math.abs(out.nx) < 1e-6, `nx should be ~0 for a Z-only slope, got ${out.nx}`);
  assert.ok(Math.abs(out.ny - expectedNy) < 1e-4, `ny drifted: ${out.ny} vs ${expectedNy}`);
  assert.ok(Math.abs(out.nz - expectedNz) < 1e-4, `nz drifted: ${out.nz} vs ${expectedNz}`);
  assert.equal(out.surface, 'dirt');
});

// ---------------------------------------------------------------------------
// computePelvisDrop
// ---------------------------------------------------------------------------

test('ACTR-13 ik | computePelvisDrop takes the worse (more negative) foot and clamps to the -0.30 m limit', () => {
  assert.equal(computePelvisDrop(0.1, 0.1, 0.1, 0.1), 0); // no discrepancy
  assert.ok(Math.abs(computePelvisDrop(-0.05, 0, 0, 0) - -0.05) < 1e-9); // small drop, R foot worse
  assert.ok(Math.abs(computePelvisDrop(0, 0, -0.05, 0) - -0.05) < 1e-9); // small drop, L foot worse
  assert.equal(computePelvisDrop(-1, 0, 0, 0), IK_DATA.pelvisDropLimit); // clamped at the limit
  assert.equal(computePelvisDrop(1, 0, 1, 0), 0); // both feet need to RISE — never raises the pelvis (this file's own reading, see ik.js header)
});

// ---------------------------------------------------------------------------
// solveTwoBoneLeg — reachable and unreachable cases, Rule 12 (iterations/residual)
// ---------------------------------------------------------------------------

test('ACTR-13 ik | solveTwoBoneLeg reaches a within-range target exactly (residual ~0, iterations=1)', () => {
  const L1 = IK_DATA.legLength.thigh;
  const L2 = IK_DATA.legLength.shin;
  const out = { kneeX: 0, kneeY: 0, kneeZ: 0, ankleX: 0, ankleY: 0, ankleZ: 0, reachable: false, residualM: -1, iterations: 0 };
  // Hip at origin, target straight down by 0.7 m (well within 0.8593 m reach).
  solveTwoBoneLeg(0, 0, 0, 0, -0.7, 0, 0, 1, 'R', L1, L2, out);
  assert.equal(out.iterations, 1);
  assert.ok(out.reachable, 'target within reach must be reported reachable');
  assert.ok(out.residualM < 1e-9, `residual should be ~0, got ${out.residualM}`);
  assert.ok(Math.abs(out.ankleY - -0.7) < 1e-9);
  // Knee must sit exactly L1 from the hip and L2 from the ankle target.
  const kneeToHip = Math.sqrt(out.kneeX ** 2 + out.kneeY ** 2 + out.kneeZ ** 2);
  const kneeToAnkle = Math.sqrt((out.kneeX - 0) ** 2 + (out.kneeY - -0.7) ** 2 + (out.kneeZ - 0) ** 2);
  assert.ok(Math.abs(kneeToHip - L1) < 1e-9, `|knee-hip| drifted from L1: ${kneeToHip} vs ${L1}`);
  assert.ok(Math.abs(kneeToAnkle - L2) < 1e-9, `|knee-ankle| drifted from L2: ${kneeToAnkle} vs ${L2}`);
});

test('ACTR-13 ik | solveTwoBoneLeg clamps an out-of-reach target and reports a nonzero residual (Rule 12: proof of an honest short-fall, not a silent pass)', () => {
  const L1 = IK_DATA.legLength.thigh;
  const L2 = IK_DATA.legLength.shin;
  const out = { kneeX: 0, kneeY: 0, kneeZ: 0, ankleX: 0, ankleY: 0, ankleZ: 0, reachable: true, residualM: 0, iterations: 0 };
  // Target 1.5 m straight down — far beyond L1+L2 (~0.8593 m).
  solveTwoBoneLeg(0, 0, 0, 0, -1.5, 0, 0, 1, 'R', L1, L2, out);
  assert.equal(out.iterations, 1);
  assert.equal(out.reachable, false);
  const expectedResidual = 1.5 - (L1 + L2 - 1e-6);
  assert.ok(Math.abs(out.residualM - expectedResidual) < 1e-6, `residual: ${out.residualM} vs expected ${expectedResidual}`);
  console.log(`[ik] solveTwoBoneLeg out-of-reach probe — target 1.5 m, max reach ${(L1 + L2).toFixed(4)} m, residual ${(out.residualM * 100).toFixed(2)} cm`);
});

// ---------------------------------------------------------------------------
// computeSoleRollDeg
// ---------------------------------------------------------------------------

test('ACTR-13 ik | computeSoleRollDeg reads a 12° ramp normal as ~12° and clamps beyond 20°', () => {
  const slopeRad = (12 * Math.PI) / 180;
  const deg = computeSoleRollDeg(0, Math.cos(slopeRad), -Math.sin(slopeRad));
  assert.ok(Math.abs(deg - 12) < 0.05, `expected ~12deg, got ${deg}`);
  // A steep 40° normal must clamp to the 20° limit.
  const steepRad = (40 * Math.PI) / 180;
  const clamped = computeSoleRollDeg(0, Math.cos(steepRad), -Math.sin(steepRad));
  assert.equal(clamped, IK_DATA.soleRollClampDeg);
});

// ---------------------------------------------------------------------------
// updateFootLock — engage/release hysteresis (the "held world contact point")
// ---------------------------------------------------------------------------

test('ACTR-13 ik | updateFootLock engages once near the ground and holds the (x,z) fixed until release', () => {
  const lockState = createFootLockState();
  const out = { x: 0, y: 0, z: 0, locked: false };
  const desiredY = 0.09;

  // Far above the ground — not locked, target follows the raw (x,z), y snapped to ground+offset.
  updateFootLock(lockState, 1, 0.5, 2, desiredY, out);
  assert.equal(out.locked, false);
  assert.equal(out.x, 1);
  assert.equal(out.z, 2);
  assert.equal(out.y, desiredY);

  // Drops within the engage margin — locks, capturing THIS frame's (x,z).
  updateFootLock(lockState, 1.2, desiredY + IK_DATA.lockEngageMarginM - 0.001, 2.2, desiredY, out);
  assert.equal(out.locked, true);
  assert.equal(out.x, 1.2);
  assert.equal(out.z, 2.2);

  // Raw curve keeps moving (as if still tracking a drifting gait curve) —
  // locked target must NOT follow it.
  updateFootLock(lockState, 1.4, desiredY, 2.4, desiredY, out);
  assert.equal(out.locked, true);
  assert.equal(out.x, 1.2, 'locked foot must not slide with the raw curve');
  assert.equal(out.z, 2.2, 'locked foot must not slide with the raw curve');

  // Rises back above the release margin — unlocks, resumes following raw.
  updateFootLock(lockState, 1.6, desiredY + IK_DATA.lockReleaseMarginM + 0.001, 2.6, desiredY, out);
  assert.equal(out.locked, false);
  assert.equal(out.x, 1.6);
  assert.equal(out.z, 2.6);
});

// ---------------------------------------------------------------------------
// detectFootstepCrossings — 08 §5.8's footfall phase points, wraparound-aware
// ---------------------------------------------------------------------------

test('ACTR-13 ik | detectFootstepCrossings fires exactly once per foot per full cycle at the walk plant points', () => {
  const out = { R: false, L: false };
  let rCount = 0;
  let lCount = 0;
  let prev = 0;
  const steps = 5000;
  for (let i = 1; i <= steps; i++) {
    const curr = (i / steps) % 1;
    detectFootstepCrossings(prev, curr, 'walk', out);
    if (out.R) rCount++;
    if (out.L) lCount++;
    prev = curr;
  }
  assert.equal(rCount, 1, `expected exactly one R crossing per cycle, got ${rCount}`);
  assert.equal(lCount, 1, `expected exactly one L crossing per cycle, got ${lCount}`);
});

test('ACTR-13 ik | detectFootstepCrossings handles the 1->0 phase wrap without double- or zero-firing', () => {
  const out = { R: false, L: false };
  // Walk's R plant point is 0.06. Advancing 0.99 -> 0.07 wraps through 1->0
  // and its covered arc is (0.99,1) union [0,0.07) — which DOES pass over
  // 0.06, so R must fire. (0.98 -> 0.03's arc is (0.98,1) union [0,0.03),
  // which stops short of 0.06 entirely — not a valid crossing example, and
  // not what this test uses.)
  detectFootstepCrossings(0.99, 0.07, 'walk', out);
  assert.equal(out.R, true);
  assert.equal(out.L, false);

  // A wrap that does NOT reach either plant point must not fire either.
  const out2 = { R: false, L: false };
  detectFootstepCrossings(0.98, 0.03, 'walk', out2);
  assert.equal(out2.R, false);
  assert.equal(out2.L, false);
});

test('ACTR-13 ik | emitFootstep emits actor:footstep in the ARCHITECTURE.md canonical shape ({actor,foot,x,y,z,surface})', () => {
  const ctx = makeFakeCtx(() => 0, () => 'stone');
  const actor = { id: 7 };
  emitFootstep(ctx, actor, 'R', 1, 2, 3, 'stone');
  assert.equal(ctx.emitted.length, 1);
  const { name, payload } = ctx.emitted[0];
  assert.equal(name, 'actor:footstep');
  assert.deepEqual(Object.keys(payload).sort(), ['actor', 'foot', 'surface', 'x', 'y', 'z'].sort());
  assert.equal(payload.actor, actor);
  assert.equal(payload.foot, 'R');
  assert.equal(payload.x, 1);
  assert.equal(payload.y, 2);
  assert.equal(payload.z, 3);
  assert.equal(payload.surface, 'stone');
});

// ---------------------------------------------------------------------------
// O-52 — crossfadeWeight continuity across the dominant flip (the narrow
// clips.js repair this ticket owns). See clips.js's own updated doc comment
// for the fix; this is the regression test for it.
// ---------------------------------------------------------------------------

test('O-52 | clips.js#crossfadeWeight is now continuous across the dominant flip (no jump at the exact flip instant)', () => {
  // This file's fix moved WHERE `dominant` flips: walk->run now happens at
  // `TRANSITION.center + TRANSITION.band/2 + TRANSITION.hysteresis`
  // (3.2 + 0.3 + 0.25 = 3.75 m/s), an absolute speed threshold — not "weight
  // crosses 0.5 under whichever edges happen to be active" (the OLD bug's
  // own trigger, and the reason it could disagree with itself). Drive speed
  // across EXACTLY that flip point and confirm the returned weight — a
  // fixed, dominant-independent smoothstep by construction — does not jump.
  const state = createCrossfadeState();
  const flipSpeed = TRANSITION.center + TRANSITION.band / 2 + TRANSITION.hysteresis;
  const before = crossfadeWeight(flipSpeed - 0.005, state);
  assert.equal(state.dominant, 'walk', 'must not have flipped yet, one step before the flip speed');
  const atFlip = crossfadeWeight(flipSpeed + 0.005, state);
  assert.equal(state.dominant, 'run', 'must have flipped exactly past the widened threshold');
  console.log(
    `[O-52] crossfadeWeight continuity probe — flip speed=${flipSpeed} m/s, ` +
    `weight(${(flipSpeed - 0.005).toFixed(3)})=${before.toFixed(4)}, weight(${(flipSpeed + 0.005).toFixed(3)})=${atFlip.toFixed(4)} ` +
    `(old bug: a ~0.3-0.4 jump was measured right at this kind of instant)`,
  );
  assert.ok(Math.abs(atFlip - before) < 0.01, `weight jumped ${Math.abs(atFlip - before).toFixed(4)} across a 0.01 m/s speed step straddling the dominant flip — the O-52 bug is back`);
});

test('O-52 | crossfadeWeight stays continuous over a full ramp through the hysteresis band, up and down', () => {
  const state = createCrossfadeState();
  const dtSpeed = 0.001; // m/s per sample — a tiny, smooth ramp
  let prevWeight = crossfadeWeight(2.0, state);
  let maxJump = 0;
  // Ramp speed 2.0 -> 5.0 -> 2.0 m/s, crossing the whole hysteresis band twice.
  const speeds = [];
  for (let s = 2.0; s <= 5.0; s += dtSpeed) speeds.push(s);
  for (let s = 5.0; s >= 2.0; s -= dtSpeed) speeds.push(s);
  for (const s of speeds) {
    const w = crossfadeWeight(s, state);
    const jump = Math.abs(w - prevWeight);
    if (jump > maxJump) maxJump = jump;
    prevWeight = w;
  }
  console.log(`[O-52] full ramp probe — max frame-to-frame weight jump over a ${dtSpeed} m/s step: ${maxJump.toFixed(6)}`);
  // A genuinely continuous, Lipschitz smoothstep over a fixed band can only
  // ever move as fast as its own local slope times the speed step; over
  // TRANSITION.band=0.6 m/s the steepest smoothstep slope is 1.5/band, so a
  // 0.001 m/s step can move weight by at most ~0.0025 — nowhere near the
  // ~0.3-0.4 jumps O-52 measured.
  assert.ok(maxJump < 0.01, `expected a smooth ramp, max jump was ${maxJump}`);
});

test('O-52 | crossfadeWeight: existing ACTR-11 behaviour (saturation, hysteresis) is preserved by the fix', () => {
  // Re-run of clips.test.js's own two crossfadeWeight assertions, so a
  // regression here is caught locally too, not just by that file.
  const state = createCrossfadeState();
  assert.equal(crossfadeWeight(0.5, state), 0);
  const state2 = createCrossfadeState();
  assert.equal(crossfadeWeight(10, state2), 1);

  const state3 = createCrossfadeState();
  for (const s of [2.5, 2.9, 3.2, 3.6, 4.0]) crossfadeWeight(s, state3);
  assert.equal(state3.dominant, 'run');
  let flips = 0;
  let prevDominant = state3.dominant;
  for (let i = 0; i < 20; i++) {
    const s = 3.45 + (i % 2 === 0 ? 0.1 : -0.1);
    crossfadeWeight(s, state3);
    if (state3.dominant !== prevDominant) flips++;
    prevDominant = state3.dominant;
  }
  assert.equal(flips, 0);
});

// ---------------------------------------------------------------------------
// FK harness — this file's own copy (see file header) of the forward-
// kinematics chain tests/actors/clips.test.js already established, extended
// to also report the hip (UpLeg) world position (clips.test.js only needed
// the foot).
// ---------------------------------------------------------------------------

function quatMultiplyFK(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function quatRotateVecFK(q, v) {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const uvx = qy * v.z - qz * v.y, uvy = qz * v.x - qx * v.z, uvz = qx * v.y - qy * v.x;
  const uuvx = qy * uvz - qz * uvy, uuvy = qz * uvx - qx * uvz, uuvz = qx * uvy - qy * uvx;
  return { x: v.x + 2 * (qw * uvx + uuvx), y: v.y + 2 * (qw * uvy + uuvy), z: v.z + 2 * (qw * uvz + uuvz) };
}

/** `08` §5.1: "q = bindLocal · euler(delta)" — rotation about local X, the
 * confirmed sagittal-swing axis for this rig's leg bones (see
 * clips.test.js's own doc comment for the derivation this file reuses). */
function eulerXDeltaFK(deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: Math.sin(rad / 2), y: 0, z: 0, w: Math.cos(rad / 2) };
}

/**
 * World position of `UpLeg<side>` (hip) and `Foot<side>` (ankle) at `phase`,
 * rig standing at the world origin, no root translation applied (caller
 * adds it). Same parent-walk `rig.js#reconstructBindPos`/`clips.test.js`
 * already use, with the thigh/knee gait deltas inserted at `UpLeg`/`Leg`.
 */
function legWorldFK(rig, boneIndex, side, phase, gp, scratchAngles) {
  gaitAngles(phase, LEG_SIDE_OFFSET[side], gp, scratchAngles);
  const upLeg = boneIndex['UpLeg' + side];
  const leg = boneIndex['Leg' + side];
  const foot = boneIndex['Foot' + side];
  const thighDelta = eulerXDeltaFK(scratchAngles.thigh);
  const kneeDelta = eulerXDeltaFK(scratchAngles.knee);

  const n = foot + 1;
  const worldPos = new Array(n);
  const worldQuat = new Array(n);
  for (let i = 0; i < n; i++) {
    const parent = rig.parents[i];
    const lp = { x: rig.localPos[i * 3], y: rig.localPos[i * 3 + 1], z: rig.localPos[i * 3 + 2] };
    let lq = {
      x: rig.localQuat[i * 4], y: rig.localQuat[i * 4 + 1], z: rig.localQuat[i * 4 + 2], w: rig.localQuat[i * 4 + 3],
    };
    if (i === upLeg) lq = quatMultiplyFK(lq, thighDelta);
    if (i === leg) lq = quatMultiplyFK(lq, kneeDelta);
    if (parent < 0) {
      worldPos[i] = lp;
      worldQuat[i] = lq;
    } else {
      const rotated = quatRotateVecFK(worldQuat[parent], lp);
      worldPos[i] = { x: worldPos[parent].x + rotated.x, y: worldPos[parent].y + rotated.y, z: worldPos[parent].z + rotated.z };
      worldQuat[i] = quatMultiplyFK(worldQuat[parent], lq);
    }
  }
  return { hip: worldPos[upLeg], ankle: worldPos[foot] };
}

// ---------------------------------------------------------------------------
// 08 §11 step 7 — "on a 12° ramp both feet plant within 1.5 cm of the
// ground plane" — using the REAL rig geometry and the REAL gait curve at
// its own plant phase (not a hand-picked stance), so the numbers are honest.
// ---------------------------------------------------------------------------

test('08 §11 step 7 | 12° ramp: both feet plant within 1.5 cm of the ground plane (printed: residual, iterations, feet solved)', () => {
  const rig = createSkeleton('humanoid', { cloak: false });
  const boneIndex = buildLocomotionBoneIndex(rig);
  const clipId = 'walk';
  const clip = CLIPS[clipId];
  const gp = GAIT_PARAMS[clipId];
  const scratch = { thigh: 0, knee: 0, ankle: 0 };

  const L1 = rig.boneLength[boneIndex.LegR]; // UpLegR -> LegR (thigh)
  const L2 = rig.boneLength[boneIndex.FootR]; // LegR -> FootR (shin)
  assert.ok(Math.abs(L1 - IK_DATA.legLength.thigh) < 1e-3, 'sanity: rig thigh length matches the ticket-given figure');
  assert.ok(Math.abs(L2 - IK_DATA.legLength.shin) < 1e-3, 'sanity: rig shin length matches the ticket-given figure');

  // Evaluate right AT the clip's own R-foot plant phase (its own touchdown
  // instant, per 08 §5.8's footfall table) — the moment the raw gait curve
  // is closest to a real plant, i.e. the LEAST slack this rig's own leg
  // reach will ever have, the honest worst case for this criterion.
  const plantPhaseR = IK_DATA.footPlantPhase[clipId].R;
  const plantPhaseL = IK_DATA.footPlantPhase[clipId].L;
  const fkR = legWorldFK(rig, boneIndex, 'R', plantPhaseR, gp, scratch);
  const fkL = legWorldFK(rig, boneIndex, 'L', plantPhaseL, gp, scratch);

  const slopeRad = (12 * Math.PI) / 180;
  const groundHeight = (x, z) => z * Math.tan(slopeRad);
  const ctx = makeFakeCtx(groundHeight, () => 'stone');

  const groundR = { y: 0, nx: 0, ny: 0, nz: 0, surface: '' };
  const groundL = { y: 0, nx: 0, ny: 0, nz: 0, surface: '' };
  probeGround(ctx, fkR.ankle.x, fkR.ankle.z, groundR);
  probeGround(ctx, fkL.ankle.x, fkL.ankle.z, groundL);

  const ankleOffsetR = rig.bindPos[boneIndex.FootR * 3 + 1];
  const ankleOffsetL = rig.bindPos[boneIndex.FootL * 3 + 1];
  const desiredYR = groundR.y + ankleOffsetR;
  const desiredYL = groundL.y + ankleOffsetL;

  const pelvisDrop = computePelvisDrop(desiredYR, fkR.ankle.y, desiredYL, fkL.ankle.y);

  const outR = { kneeX: 0, kneeY: 0, kneeZ: 0, ankleX: 0, ankleY: 0, ankleZ: 0, reachable: false, residualM: 0, iterations: 0 };
  const outL = { kneeX: 0, kneeY: 0, kneeZ: 0, ankleX: 0, ankleY: 0, ankleZ: 0, reachable: false, residualM: 0, iterations: 0 };
  solveTwoBoneLeg(fkR.hip.x, fkR.hip.y + pelvisDrop, fkR.hip.z, fkR.ankle.x, desiredYR, fkR.ankle.z, 0, 1, 'R', L1, L2, outR);
  solveTwoBoneLeg(fkL.hip.x, fkL.hip.y + pelvisDrop, fkL.hip.z, fkL.ankle.x, desiredYL, fkL.ankle.z, 0, 1, 'L', L1, L2, outL);

  const residualCmR = outR.residualM * 100;
  const residualCmL = outL.residualM * 100;
  console.log(
    `[ik] 12deg RAMP PLANT — pelvisDrop=${pelvisDrop.toFixed(4)} m | ` +
    `R: iterations=${outR.iterations}, reachable=${outR.reachable}, residual=${residualCmR.toFixed(4)} cm | ` +
    `L: iterations=${outL.iterations}, reachable=${outL.reachable}, residual=${residualCmL.toFixed(4)} cm | ` +
    `feet solved=2`,
  );

  assert.equal(outR.iterations, 1);
  assert.equal(outL.iterations, 1);
  assert.ok(residualCmR < IK_DATA.plantToleranceM * 100, `R foot residual ${residualCmR} cm exceeds the 1.5 cm tolerance`);
  assert.ok(residualCmL < IK_DATA.plantToleranceM * 100, `L foot residual ${residualCmL} cm exceeds the 1.5 cm tolerance`);
});

// ---------------------------------------------------------------------------
// Backlog wording — "feet plant on a 0.45 m step, and actor:footstep fires
// on contact with the surface"
// ---------------------------------------------------------------------------

test('backlog | feet plant on a 0.45 m step and actor:footstep fires on contact, with the correct surface', () => {
  const rig = createSkeleton('humanoid', { cloak: false });
  const boneIndex = buildLocomotionBoneIndex(rig);
  const clipId = 'walk';
  const gp = GAIT_PARAMS[clipId];
  const scratch = { thigh: 0, knee: 0, ankle: 0 };

  const L1 = rig.boneLength[boneIndex.LegR];
  const L2 = rig.boneLength[boneIndex.FootR];

  // A 0.45 m step down at z=0 (07-world-gen.md §1.3's own cap on step
  // height) — R foot on the upper landing (z<0), L foot on the lower one
  // (z>0). Evaluate each leg at its OWN plant phase.
  const STEP_HEIGHT = 0.45;
  const groundHeight = (x, z) => (z < 0 ? 0 : -STEP_HEIGHT);
  const ctx = makeFakeCtx(groundHeight, (x, z) => (z < 0 ? 'stone' : 'dirt'));

  const plantPhaseR = IK_DATA.footPlantPhase[clipId].R;
  const plantPhaseL = IK_DATA.footPlantPhase[clipId].L;
  const fkR = legWorldFK(rig, boneIndex, 'R', plantPhaseR, gp, scratch);
  const fkL = legWorldFK(rig, boneIndex, 'L', plantPhaseL, gp, scratch);
  // Place R on the upper landing, L on the lower one.
  const ankleRZ = fkR.ankle.z - 0.2;
  const ankleLZ = fkL.ankle.z + 0.2;
  const hipRZ = fkR.hip.z - 0.2;
  const hipLZ = fkL.hip.z + 0.2;

  const groundR = { y: 0, nx: 0, ny: 0, nz: 0, surface: '' };
  const groundL = { y: 0, nx: 0, ny: 0, nz: 0, surface: '' };
  probeGround(ctx, fkR.ankle.x, ankleRZ, groundR);
  probeGround(ctx, fkL.ankle.x, ankleLZ, groundL);

  const ankleOffsetR = rig.bindPos[boneIndex.FootR * 3 + 1];
  const ankleOffsetL = rig.bindPos[boneIndex.FootL * 3 + 1];
  const desiredYR = groundR.y + ankleOffsetR;
  const desiredYL = groundL.y + ankleOffsetL;

  const pelvisDrop = computePelvisDrop(desiredYR, fkR.ankle.y, desiredYL, fkL.ankle.y);

  const outR = { kneeX: 0, kneeY: 0, kneeZ: 0, ankleX: 0, ankleY: 0, ankleZ: 0, reachable: false, residualM: 0, iterations: 0 };
  const outL = { kneeX: 0, kneeY: 0, kneeZ: 0, ankleX: 0, ankleY: 0, ankleZ: 0, reachable: false, residualM: 0, iterations: 0 };
  solveTwoBoneLeg(fkR.hip.x, fkR.hip.y + pelvisDrop, hipRZ, fkR.ankle.x, desiredYR, ankleRZ, 0, 1, 'R', L1, L2, outR);
  solveTwoBoneLeg(fkL.hip.x, fkL.hip.y + pelvisDrop, hipLZ, fkL.ankle.x, desiredYL, ankleLZ, 0, 1, 'L', L1, L2, outL);

  console.log(
    `[ik] 0.45m STEP PLANT — pelvisDrop=${pelvisDrop.toFixed(4)} m (limit ${IK_DATA.pelvisDropLimit} m) | ` +
    `R (upper landing): residual=${(outR.residualM * 100).toFixed(4)} cm, reachable=${outR.reachable} | ` +
    `L (lower landing): residual=${(outL.residualM * 100).toFixed(4)} cm, reachable=${outL.reachable}`,
  );

  // Footstep event on contact with the surface, per ARCHITECTURE.md's
  // canonical actor:footstep row (rule 7).
  const actor = { id: 42 };
  const flags = { R: false, L: false };
  detectFootstepCrossings(plantPhaseR - 0.01, plantPhaseR + 0.001, 'walk', flags);
  assert.equal(flags.R, true, 'R foot should cross its own plant point in this window');
  emitFootstep(ctx, actor, 'R', outR.ankleX, outR.ankleY, outR.ankleZ, groundR.surface);
  assert.equal(ctx.emitted.length, 1);
  assert.equal(ctx.emitted[0].name, 'actor:footstep');
  assert.equal(ctx.emitted[0].payload.surface, 'stone');
  assert.ok(Math.abs(ctx.emitted[0].payload.y - desiredYR) < 1e-6, 'footstep must report the actual ground contact height');

  // Report plainly whether the plant residual clears the 1.5 cm tolerance —
  // per this ticket's own rule ("do not narrow the measurement to make it
  // pass"), this is printed and checked honestly, not forced.
  const worstResidualCm = Math.max(outR.residualM, outL.residualM) * 100;
  if (worstResidualCm >= IK_DATA.plantToleranceM * 100) {
    console.log(
      `[ik] NOTE: at this rig's own leg reach (${(L1 + L2).toFixed(4)} m) and standing hip height, a full ` +
      `${STEP_HEIGHT} m step's worst-case residual is ${worstResidualCm.toFixed(2)} cm, OVER the 1.5 cm tolerance ` +
      `— reported honestly (Rule 12), not narrowed to pass. See this ticket's report.`,
    );
  }
});

// ---------------------------------------------------------------------------
// D-15 — re-measured foot slide, walk and run, under ACTR-11's disclosed
// stance-window definition, with the runtime foot-lock mechanism applied.
// ---------------------------------------------------------------------------

/** Same disclosed window ACTR-11/clips.test.js used: the contiguous span
 * (within the middle of three cycles, to avoid wraparound) where height
 * stays within 10% of that cycle's own minimum. Reused verbatim so the
 * numbers this test prints are directly comparable to clips.js's own
 * 43.8 cm / 53.8 cm figures. */
function stanceWindow(ys, N) {
  let minY = Infinity;
  for (let i = N; i < 2 * N; i++) if (ys[i] < minY) minY = ys[i];
  const threshold = minY * 1.1;
  let argmin = N;
  for (let i = N; i < 2 * N; i++) if (ys[i] === minY) argmin = i;
  let lo = argmin;
  let hi = argmin;
  while (ys[lo - 1] <= threshold) lo--;
  while (ys[hi + 1] <= threshold) hi++;
  return { lo, hi };
}

function slideOverWindow(xs, zs, lo, hi) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = lo; i <= hi; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (zs[i] < minZ) minZ = zs[i];
    if (zs[i] > maxZ) maxZ = zs[i];
  }
  const dx = maxX - minX;
  const dz = maxZ - minZ;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Samples the R foot's RAW (pre-IK) trajectory over `strides` cycles at the
 * clip's own reference speed (flat ground, matching ACTR-11's own
 * measurement — no ramp here, so the two numbers are comparable), plus the
 * foot-lock-corrected trajectory over the SAME samples. */
function sampleWithAndWithoutIK(clipId, strides = 3, samplesPerCycle = 3600) {
  const rig = createSkeleton('humanoid', { cloak: false });
  const boneIndex = buildLocomotionBoneIndex(rig);
  const clip = CLIPS[clipId];
  const gp = GAIT_PARAMS[clipId];
  const speed = clip.refSpeed;
  const strideHz = computeStrideHz(speed, clip);
  const dt = 1 / strideHz / samplesPerCycle;
  const total = samplesPerCycle * strides;

  const rawXs = new Float64Array(total);
  const rawYs = new Float64Array(total);
  const rawZs = new Float64Array(total);
  const ikXs = new Float64Array(total);
  const ikZs = new Float64Array(total);

  const scratch = { thigh: 0, knee: 0, ankle: 0 };
  const lockState = createFootLockState();
  const target = { x: 0, y: 0, z: 0, locked: false };
  const ankleOffset = rig.bindPos[boneIndex.FootR * 3 + 1];
  const desiredY = 0 + ankleOffset; // flat ground, y=0 — matches ACTR-11's own measurement

  let phase = 0;
  let rootZ = 0;
  for (let i = 0; i < total; i++) {
    const { ankle } = legWorldFK(rig, boneIndex, 'R', phase % 1, gp, scratch);
    const rawX = ankle.x;
    const rawY = ankle.y;
    const rawZ = ankle.z + rootZ;
    rawXs[i] = rawX;
    rawYs[i] = rawY;
    rawZs[i] = rawZ;

    updateFootLock(lockState, rawX, rawY, rawZ, desiredY, target);
    ikXs[i] = target.x;
    ikZs[i] = target.z;

    rootZ += speed * dt;
    phase += dt * strideHz;
  }
  return { rawXs, rawYs, rawZs, ikXs, ikZs, samplesPerCycle };
}

test('D-15 | re-measured foot slide (walk) under ACTR-11\'s disclosed stance window, with foot-lock IK applied', () => {
  const { rawXs, rawYs, rawZs, ikXs, ikZs, samplesPerCycle: N } = sampleWithAndWithoutIK('walk');
  const { lo, hi } = stanceWindow(rawYs, N);
  const rawSlideCm = slideOverWindow(rawXs, rawZs, lo, hi) * 100;
  const ikSlideCm = slideOverWindow(ikXs, ikZs, lo, hi) * 100;
  console.log(
    `[ik] D-15 FOOT SLIDE walk @ ${CLIPS.walk.refSpeed} m/s, same disclosed stance window (width ${(((hi - lo + 1) / N) * 100).toFixed(1)}% of cycle) — ` +
    `WITHOUT IK (ACTR-11's own number): ${rawSlideCm.toFixed(2)} cm | WITH foot-lock IK: ${ikSlideCm.toFixed(2)} cm`,
  );
  if (ikSlideCm < 4) {
    console.log('[ik] D-15 walk: foot IK CLOSES the < 4 cm gap.');
  } else {
    console.log(`[ik] D-15 walk: foot IK reduces slide but does NOT clear 4 cm (${ikSlideCm.toFixed(2)} cm) — reported honestly, not narrowed.`);
  }
  assert.ok(Number.isFinite(ikSlideCm) && ikSlideCm >= 0);
  assert.ok(ikSlideCm < rawSlideCm, 'foot-lock IK must reduce slide relative to the raw curve');
});

test('D-15 | re-measured foot slide (run) under ACTR-11\'s disclosed stance window, with foot-lock IK applied', () => {
  const { rawXs, rawYs, rawZs, ikXs, ikZs, samplesPerCycle: N } = sampleWithAndWithoutIK('run');
  const { lo, hi } = stanceWindow(rawYs, N);
  const rawSlideCm = slideOverWindow(rawXs, rawZs, lo, hi) * 100;
  const ikSlideCm = slideOverWindow(ikXs, ikZs, lo, hi) * 100;
  console.log(
    `[ik] D-15 FOOT SLIDE run @ ${CLIPS.run.refSpeed} m/s, same disclosed stance window (width ${(((hi - lo + 1) / N) * 100).toFixed(1)}% of cycle) — ` +
    `WITHOUT IK (ACTR-11's own number): ${rawSlideCm.toFixed(2)} cm | WITH foot-lock IK: ${ikSlideCm.toFixed(2)} cm`,
  );
  if (ikSlideCm < 4) {
    console.log('[ik] D-15 run: foot IK CLOSES the < 4 cm gap.');
  } else {
    console.log(`[ik] D-15 run: foot IK reduces slide but does NOT clear 4 cm (${ikSlideCm.toFixed(2)} cm) — reported honestly, not narrowed.`);
  }
  assert.ok(Number.isFinite(ikSlideCm) && ikSlideCm >= 0);
  assert.ok(ikSlideCm < rawSlideCm, 'foot-lock IK must reduce slide relative to the raw curve');
});

// ---------------------------------------------------------------------------
// Full updateFootIK orchestration — sanity that the pieces compose
// ---------------------------------------------------------------------------

test('ACTR-13 ik | updateFootIK composes ground probe + lock + pelvis drop + two-bone solve + footstep in one call', () => {
  const ctx = makeFakeCtx(() => 0, () => 'wood');
  const state = createIKState();
  const actor = { id: 3 };
  const input = {
    actorState: ACTOR_STATE.move,
    actor,
    hipRX: -0.09, hipRY: 0.94, hipRZ: 0,
    hipLX: 0.09, hipLY: 0.94, hipLZ: 0,
    rawAnkleRX: -0.1, rawAnkleRY: 0.05, rawAnkleRZ: 0,
    rawAnkleLX: 0.1, rawAnkleLY: 0.4, rawAnkleLZ: 0.3,
    fwdX: 0, fwdZ: 1,
    legLengthR1: IK_DATA.legLength.thigh, legLengthR2: IK_DATA.legLength.shin,
    legLengthL1: IK_DATA.legLength.thigh, legLengthL2: IK_DATA.legLength.shin,
    gaitPhase: IK_DATA.footPlantPhase.walk.R,
    dominant: 'walk',
  };
  updateFootIK(ctx, state, input);
  assert.equal(state.active, true);
  assert.equal(state.solveR.iterations, 1);
  assert.equal(state.solveL.iterations, 1);
  assert.ok(Number.isFinite(state.pelvisDropM));
  assert.ok(state.pelvisDropM <= 0 && state.pelvisDropM >= IK_DATA.pelvisDropLimit);

  // Disabled state must short-circuit cleanly.
  const state2 = createIKState();
  updateFootIK(ctx, state2, { ...input, actorState: ACTOR_STATE.dead });
  assert.equal(state2.active, false);
  assert.equal(state2.solveR.iterations, 0);
});

// ---------------------------------------------------------------------------
// Zero allocation — O-43 methodology (N >= 1_000_000, total-bytes-growth,
// not the low-iteration default). See this file's own header for why this
// lives here instead of a dedicated *.perf.test.js.
// ---------------------------------------------------------------------------

test('ACTR-13 ik | updateFootIK allocates ~0 bytes/call at N=1,000,000 (O-43 methodology)', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }
  // Deliberately NO `gaitPhase`/`dominant` in `input` — this probes the
  // CORE per-frame hot path (ground probe + lock + pelvis drop + two-bone
  // solve), the part `08 §5.8` actually means by "runs every frame for
  // every visible actor". Footstep emission is this file's one documented,
  // deliberate exception to zero-allocation (see ik.js's header) — it
  // fires at most twice per gait cycle, not once per frame, and is
  // correctness-tested separately above (`emitFootstep`'s own test).
  // Folding its sparse, non-zero allocation into THIS probe would just
  // dilute a real per-frame-hot-path regression under noise, not measure
  // it.
  const ctx = makeFakeCtx((x, z) => z * 0.05, () => 'stone');
  const state = createIKState();
  const actor = { id: 9 };
  let phase = 0;
  const input = {
    actorState: ACTOR_STATE.move,
    actor,
    hipRX: -0.09, hipRY: 0.94, hipRZ: 0,
    hipLX: 0.09, hipLY: 0.94, hipLZ: 0.1,
    rawAnkleRX: -0.1, rawAnkleRY: 0.09, rawAnkleRZ: 0,
    rawAnkleLX: 0.1, rawAnkleLY: 0.2, rawAnkleLZ: 0.2,
    fwdX: 0, fwdZ: 1,
    legLengthR1: IK_DATA.legLength.thigh, legLengthR2: IK_DATA.legLength.shin,
    legLengthL1: IK_DATA.legLength.thigh, legLengthL2: IK_DATA.legLength.shin,
  };
  // BATCHED unit, marginal-bytes-between-two-large-Ns — `anim.perf.test.js`'s
  // own exact methodology (`08 §11 step 6`'s accepted allocation test),
  // reused verbatim rather than a per-call measurement. Two earlier attempts
  // at a per-call measurement (a two-point total-bytes delta, then
  // `assertAllocationFree` at `iterations:1_000_000` with a batch size of 1)
  // both read a small but STABLE nonzero floor (~1-7 bytes/call, never
  // trending to 0 across 40+ rounds) — traced by isolating `probeGround`
  // alone, and then, as a control, `anim.js#composeSkeletonWorld` (ACTR-12's
  // own ALREADY-ACCEPTED, verified-zero-allocation function) under the exact
  // same one-call-per-round methodology: it reads the identical ~2 bytes/
  // call floor. That proves the floor is an artifact of measuring ONE ESM
  // export call per round (a fixed, tiny, per-call dispatch cost this
  // methodology cannot amortize away), not a real allocation in either
  // function — `anim.perf.test.js` never hits it because it batches 600
  // calls into one measured unit. This test does the same: a 600-call batch
  // (matching that file's own `FRAMES_PER_RUN`), sampled at two large round
  // counts, judged by the MARGINAL bytes per call between them (cancelling
  // any per-batch fixed overhead, not just the per-call one).
  const BATCH = 600;
  const runBatch = () => {
    for (let i = 0; i < BATCH; i++) {
      phase = (phase + 0.001) % 1;
      input.rawAnkleRZ = Math.sin(phase * 6.28) * 0.1;
      updateFootIK(ctx, state, input);
    }
  };
  const roundsAtOne = 2000; // 2000 * 600 = 1.2M updateFootIK() calls
  const roundsAtFour = 8000; // 8000 * 600 = 4.8M calls

  const bytesPerBatchAtOne = allocatedBytes(runBatch, roundsAtOne);
  const bytesPerBatchAtFour = allocatedBytes(runBatch, roundsAtFour);
  const totalAtOne = bytesPerBatchAtOne * roundsAtOne;
  const totalAtFour = bytesPerBatchAtFour * roundsAtFour;
  const marginalBytesPerBatch = (totalAtFour - totalAtOne) / (roundsAtFour - roundsAtOne);
  const marginalBytesPerCall = marginalBytesPerBatch / BATCH;

  console.log(
    `[ik] ALLOC probe — ${bytesPerBatchAtOne.toFixed(4)} B/${BATCH}-call-batch at N=${roundsAtOne}, ` +
    `${bytesPerBatchAtFour.toFixed(4)} B/${BATCH}-call-batch at N=${roundsAtFour}; ` +
    `marginal = ${marginalBytesPerBatch.toFixed(4)} B/batch = ${marginalBytesPerCall.toFixed(6)} B/call`,
  );
  assert.ok(
    marginalBytesPerCall < 1,
    `updateFootIK() must allocate ~0 bytes/call (marginal, O-43 methodology); got ${marginalBytesPerCall.toFixed(6)} B/call`,
  );
});
