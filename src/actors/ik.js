// src/actors/ik.js
//
// ACTR-13 — "Foot IK and contact" (`08-characters-visual.md` §5.8/§5.9,
// `08 §11 step 7`). Node-safe: no `three`, no `document`/`window`, no
// `performance.now()` anywhere in this file — `src/actors/` is a strict
// `check-imports.mjs` root (`checkGlobals: true`, O-29) and this file must
// stay inside that boundary, same discipline `rig.js`/`clips.js`/`anim.js`
// already keep. No `Math.random()` (rule 3 — nothing here needs
// randomness at all). No `Math.hypot` (banned, allocates) — every distance
// below is `Math.sqrt(x*x+y*y+z*z)`. No `Map` for per-actor state — every
// per-actor record this file defines (`createIKState`) is a plain object
// with fixed, named scalar fields, allocated once and mutated in place.
//
// ---------------------------------------------------------------------------
// Scope: what `08 §5.8`/§5.9 ask for, and what this file actually builds
// ---------------------------------------------------------------------------
// IK-A (foot placement) is this ticket's brief: ground probe, pelvis drop,
// analytic two-bone solve, sole roll, footfall events. IK-B (look-at) and
// IK-C (hand-to-target) are named in §5.8 but are NOT this ticket's own
// deliverable line (`08 §11 step 7`'s row is "ground probe, pelvis drop,
// two-bone solve, sole roll, GroundShadows" — no look-at, no hand IK) and
// are not built here (O-27: this file does not assert "nothing else exists
// yet" — they are simply out of THIS ticket's scope, for a later one).
//
// This file is PRESENTATION (`ARCHITECTURE.md` rule 5): every function here
// is meant to be called from `update()`, never `fixedUpdate()`, and nothing
// here writes back into simulation state (actor.x/z, physics bodies, combat
// numbers). It never reads a clock itself — the caller's own `dt`/gait
// phase drives everything.
//
// **Not wired in.** Per this ticket's brief, `src/actors/index.js` and
// `anim.js` are not this ticket's files to edit, so nothing here is called
// from anywhere yet. `updateFootIK` (bottom of this file) is the intended
// single entry point for whichever ticket does that wiring: it is written
// to be called once per actor per frame with that actor's already-composed
// FK hip/ankle world positions (`anim.js#composeSkeletonWorld`'s
// `worldPos`, already built by `updateAnimator` before this would run) and
// a `ctx` for the ground probe. Reported, not silently left undiscoverable.
//
// ---------------------------------------------------------------------------
// The ground probe — a real conflict between this ticket's own two source
// documents, resolved here, reported
// ---------------------------------------------------------------------------
// `08` §5.8 step 1 is explicit and reasons about cost: "Ground probe per
// foot: `nav.heightAt(x, z)` — an O(1) bilinear lookup on the 0.5 m
// walkability grid... **Not a physics raycast**: 52 raycasts per frame is
// not affordable and not necessary" (26 actors x 2 feet = 52 - the spec's
// own number is exactly this game's own worst case, not a round figure).
//
// This ticket's OWN engine-contract paragraph, separately, says: "The
// ground probe is a ray cast — use it via `ctx.get('physics')` at runtime,
// never by importing the module." Both cannot be read literally at once:
//
//   - `nav.heightAt` does not exist. `docs/spec/02-api-contracts.md`'s frozen
//     `NavSystem` row table (§5, `const nav = ctx.get('nav')`) has no
//     `heightAt` method at all — `walkable`, `flagsAt`, `regionAt`, `snap`,
//     path/flow-field methods, nothing height-related. Calling a method
//     that is not in the frozen contract is not an option.
//   - A literal `physics.rayCast` is ALSO wrong for this: `src/physics/
//     cast.js`'s own header says casts are 2D ("footprint y/height is
//     ignored... every cast here treats every footprint as an infinite
//     vertical column") — a horizontal XZ-plane ray has no notion of "the
//     ground's height under this point" to report at all.
//
// What DOES exist, is Fixed/zero-alloc, and is reached exactly the way this
// ticket's own paragraph says ("use it via `ctx.get('physics')` at
// runtime"): `physics.groundHeight(x,z) => number`
// (`02-api-contracts.md` §4, "Fixed: Y, Alloc: no") — described there as
// exact/analytic, the same word `world.groundHeight` gets for the same
// query. An O(1) analytic evaluation is not a raycast at all and does not
// carry the "52 raycasts/frame" cost §5.8 is actually worried about — so
// using it satisfies BOTH documents' real intent (cheap, O(1), reached via
// `ctx.get('physics')`) without calling a method (`nav.heightAt`) that this
// codebase never built. This file's ground probe (`probeGround` below)
// calls `ctx.get('physics').groundHeight` for height and
// `ctx.get('world').surfaceAt` for the footstep event's `surface` field
// (`ARCHITECTURE.md`'s own surface vocabulary) — never `ctx.get('nav')`,
// never a static import of either module (hard rule 2).
//
// The ground NORMAL (needed for sole roll, §5.8 step 4 — nav's bilinear
// lookup would have given this "from the 4-neighbour gradient" for free)
// is not exposed by any single call in the frozen API, so this file derives
// it itself: a central-difference gradient from four extra `groundHeight`
// calls (`IK_DATA.groundNormalEps` apart). Five analytic calls per foot,
// ten per actor, 260 for 26 actors — cheap relative to `ANIM-12`'s own
// measured 1.5 ms budget headroom (0.0225 ms/26 actors), and nothing like
// the 52-raycast cost §5.8 was actually rejecting.
//
// ---------------------------------------------------------------------------
// Leg lengths and the ankle-ground offset — derived from `rig.js`, not
// hardcoded (rule 6: "gameplay numbers live in data, not literals in the
// solver")
// ---------------------------------------------------------------------------
// `solveTwoBoneLeg` takes `L1`/`L2` (thigh/shin) as PARAMETERS, not module
// constants — a caller derives them from `rig.boneLength[legIdx]` /
// `rig.boneLength[footIdx]` (`rig.js`'s own per-bone parent-distance table,
// already computed once at module load there). This keeps the solver
// rig-agnostic (works for any archetype's own proportions, not just the
// Bone Ranker's) and avoids a second, independently-drifting copy of a
// number `rig.js` already owns. Likewise the ankle-ground offset (how far
// above the ground plane the ankle JOINT sits when the foot is flat) is a
// parameter, ideally `rig.bindPos[footIdx*3+1]` (the Foot bone's own
// authored bind-pose Y — `08 §2.3`'s table already puts this at 0.09 m for
// both `FootR`/`FootL`, i.e. the rig's own authored "ankle height off the
// sole", not a number this file invents).
//
// `IK_DATA.legLength`/`IK_DATA.ankleGroundOffset` below are kept anyway —
// NOT as literals the solver reads, but as this file's own DOCUMENTED
// fallback/reference values (the ticket's own given numbers: thigh
// 0.4286 m, shin 0.4308 m, ankle 0.09 m) so a caller with no rig handy yet
// (or this file's own tests, verifying against the ticket's own figures)
// has a named, sourced default instead of a bare magic number scattered
// through call sites.
//
// ---------------------------------------------------------------------------
// The "held world contact point" — how this file actually closes D-15
// ---------------------------------------------------------------------------
// `clips.js`'s own header (and `tests/actors/clips.test.js`'s own measured
// numbers) established that the raw gait curve alone cannot produce a
// planted foot: walk drifts ~43.8 cm, run ~53.8 cm, over the SAME disclosed
// stance-window definition this file reuses below (10% of the cycle's own
// height minimum) — bound to this ticket precisely because "a two-bone
// solve against a HELD WORLD CONTACT POINT" is what turns a raw curve's
// brief low point into a real, slide-free stance.
//
// A per-frame ground-height SNAP alone (just clamping the ankle's Y to
// `groundHeight(x,z)` every frame, still following the raw curve's X/Z)
// would fix vertical penetration but do NOTHING for horizontal slide — the
// foot's (x,z) would still track the un-corrected curve's own drift. This
// file's `updateFootLock` is the actual fix: once a foot's raw (pre-IK)
// height drops within `IK_DATA.lockEngageMarginM` of the ground plane, its
// WORLD (x,y,z) contact point is captured ONCE and held fixed — not
// re-derived from the moving curve — until the raw curve's height rises
// back above `IK_DATA.lockReleaseMarginM` (a second, larger margin, so a
// foot hovering exactly at the engage line does not chatter — the same
// hysteresis shape `08 §5.4`'s own walk<->run crossfade uses, and the exact
// reason `clips.js`'s O-52 fix (this ticket's other repair, see that file)
// had to make the DISCRETE half of that mechanism trustworthy: this file's
// `dominant`-driven footfall-phase lookup below depends on it being
// non-flickering).
//
// This is a genuinely different, and correct, mechanism from "clamp Y every
// frame" — it is what the ticket brief and `08 §11 step 7` both call a
// "held" contact point. `tests/actors/ik.test.js` re-measures foot slide
// under this mechanism, over the SAME stance-window definition
// `clips.test.js` used, and prints the result — see that file, and this
// ticket's report, for the actual number (NOT assumed here to be zero).
//
// ---------------------------------------------------------------------------
// Sole roll — a documented single-axis simplification
// ---------------------------------------------------------------------------
// `08` §5.8 step 4: "align the foot's local +Z to the ground normal, clamped
// to 20°." `clips.js`'s own leg model (`gaitAngles`) is ALREADY single-axis
// per joint (thigh/knee/ankle are each one scalar degree value, rotating
// about the leg's own local X — `clips.test.js`'s own header confirms this
// is the sagittal-swing axis for this rig's convention). A full "align an
// axis to an arbitrary 3D normal" needs a second rotation freedom (roll,
// lateral tilt) this codebase's leg joints have no established convention
// for yet. `computeSoleRollDeg` below reads the ground normal's SAGITTAL
// component only (`atan2(-nz, ny)`, the pitch of the normal relative to
// world-up in the actor's forward/vertical plane) and returns a single
// clamped degree value meant to add onto the `Foot` bone's existing
// (ankle-flex) X-axis rotation, exactly like `writeLegDelta` already
// composes `ankle` onto that same bone/axis. A ramp tilted purely in pitch
// (this ticket's own `08 §11 step 7` criterion — "a 12° ramp") has zero
// lateral (`nx`) component, so this simplification is exact for the
// acceptance criterion itself; a laterally-tilted (cambered) surface would
// need the second axis this file does not add, and that gap is reported
// here rather than silently handled.
//
// ---------------------------------------------------------------------------
// Disabled states — `08` §5.8 step 5 names states this codebase's data
// model does not have under those names
// ---------------------------------------------------------------------------
// §5.8 step 5: "Foot IK is disabled during `death`, `spawn`, `dash` and any
// `scripted` state." `src/actors/data/states.js`'s frozen `ACTOR_STATE`
// enum (the actual twelve states this engine has) is: `spawning`, `idle`,
// `move`, `windup`, `active`, `recover`, `channel`, `hitstun`, `knockback`,
// `interact`, `dead`, `despawning`. There is no `dash` state anywhere in it,
// and no `scripted` state either — `death`/`spawn` map cleanly onto
// `dead`/`spawning`, but the other two names in the spec's prose simply do
// not exist in this codebase's actual state machine. `isFootIKEnabled`
// below therefore checks the two states that DO map (`dead`, `spawning`)
// against the real enum, and accepts two caller-supplied booleans
// (`opts.dashing`, `opts.scripted`) for the two that don't — whichever
// system tracks a dash action or a cutscene/scripted-camera flag (neither
// exists in `src/actors/` today, per O-27) can set them once that concept
// exists, rather than this file inventing a matching state that isn't
// real. Reported, not guessed past.
//
// ---------------------------------------------------------------------------
// Zero allocation
// ---------------------------------------------------------------------------
// Every per-frame-shaped function below (`probeGround`, `solveTwoBoneLeg`,
// `computePelvisDrop`, `updateFootLock`, `computeSoleRollDeg`,
// `detectFootstepCrossings`, `updateFootIK`) uses scalar local variables
// only — no `{x,y,z}` object literals, no array literals, no `.slice()`/
// `.map()`/spread — matching `anim.js#composeSkeletonWorld`'s own
// established style for exactly this reason. Every buffer/record a caller
// needs across frames is allocated once by `createIKState()` and reused by
// field-write forever after. `emitFootstep`'s event payload is the one
// deliberate exception — see that function's own doc comment for why (it
// fires at most twice per gait cycle per actor, not once per frame; the
// same rarity `ARCHITECTURE.md` already accepts for `actor:spawn`/
// `skill:cast`-shaped events, as opposed to the `actor:damage`-rate events
// its own "EventBus must not allocate" rule is actually about).

import { ACTOR_STATE } from './data/states.js';

// ---------------------------------------------------------------------------
// Data — `08` §5.8's own numbers, plus this file's documented additions.
// (`ARCHITECTURE.md` rule 9 / this ticket's rule 6: gameplay numbers live in
// data, not literals in the solver.)
// ---------------------------------------------------------------------------

export const IK_DATA = Object.freeze({
  /** `08` §5.8 step 2, verbatim: pelvis drop never exceeds this (metres, a
   * downward-only correction — see `computePelvisDrop`'s own doc comment
   * for why this file also clamps the upper end at 0). */
  pelvisDropLimit: -0.30,

  /** `08` §5.8 step 3, verbatim: "Knee pole = the actor's forward vector
   * rotated +-7 deg outward." */
  kneePoleDeg: 7,

  /** `08` §5.8 step 4, verbatim: sole-roll clamp. */
  soleRollClampDeg: 20,

  /** Reference/fallback only — see the file header's "Leg lengths" section.
   * A real caller derives these from `rig.boneLength` instead. Ticket's own
   * given numbers for the Bone Ranker's leg (`rig.js`, ACTR-3). */
  legLength: Object.freeze({ thigh: 0.4286, shin: 0.4308 }),

  /** Reference/fallback only, same reasoning — a real caller derives this
   * from `rig.bindPos[footIdx*3+1]`. `08 §2.3`'s own `FootR`/`FootL` bind Y. */
  ankleGroundOffset: 0.09,

  /** `08 §11 step 7`'s own acceptance number: "both feet plant within
   * 1.5 cm of the ground plane." */
  plantToleranceM: 0.015,

  /** Finite-difference step for the ground-normal gradient (metres) — see
   * the file header's "ground probe" section for why this file derives its
   * own normal instead of getting one from a single call. Small enough to
   * stay locally accurate on the 0.5 m nav grid's own resolution, large
   * enough not to be swallowed by analytic float noise. */
  groundNormalEps: 0.05,

  /** Foot-lock hysteresis margins (metres, above the ground plane) — see
   * the file header's "held world contact point" section. Engage close to
   * the ground; release only once meaningfully clear of it, so a foot
   * hovering right at the engage line cannot chatter lock/unlock every
   * frame. Not sourced from `08` §5.8 (silent on the exact margin) — sized
   * against BOTH clips' own measured curves, not guessed: sampling
   * `gaitAngles`' own raw ankle height at 200,000 points per cycle, `walk`'s
   * minimum sits 0.91 cm above the flat-ground ankle offset, `run`'s sits
   * 2.14 cm above it (run's stance dwell is shallower — the SAME "run's
   * stance window is only ~9.2% of the cycle vs walk's ~13.8%" finding
   * `clips.js`'s own header already records). `lockEngageMarginM` is set
   * above run's own 2.14 cm gap (with headroom) so BOTH clips' feet
   * actually reach the engage condition at their own real minimum, not
   * just walk's shallower one — `tests/actors/ik.test.js`'s D-15 tests
   * caught this exact gap empirically (run never engaged at a tighter
   * margin) before this number was picked. */
  lockEngageMarginM: 0.03,
  lockReleaseMarginM: 0.08,

  /** `08` §5.8's own footfall table: "walk at 0.06 and 0.56, run at 0.10
   * and 0.60" — a SINGLE shared gait phase (`clips.js`/`anim.js`'s own
   * `state.phase`/`gaitPhase`), sampled at these two points per cycle
   * (right foot's plant, then, half a cycle later at the same raw-phase
   * variable, left foot's — `LEG_SIDE_OFFSET` already puts the two legs a
   * half-cycle apart in that same shared phase, so this is not a
   * per-foot-effective-phase computation, just two fixed points on the one
   * curve). */
  footPlantPhase: Object.freeze({
    walk: Object.freeze({ R: 0.06, L: 0.56 }),
    run: Object.freeze({ R: 0.10, L: 0.60 }),
  }),
});

/** `08` §5.8 step 5's two states that DO map onto this codebase's real
 * `ACTOR_STATE` enum — see the file header's "Disabled states" section for
 * why `dash`/`scripted` are handled as caller-supplied flags instead. */
const IK_DISABLED_STATES = new Set([ACTOR_STATE.dead, ACTOR_STATE.spawning]);

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * `08 §5.8` step 5 — whether foot IK should run at all this frame.
 * @param {string} actorState one of `ACTOR_STATE`'s values.
 * @param {{dashing?:boolean, scripted?:boolean}} [opts] — see the file
 *   header's "Disabled states" section for why these two are caller flags,
 *   not a state-enum lookup.
 * @returns {boolean}
 */
export function isFootIKEnabled(actorState, opts) {
  if (IK_DISABLED_STATES.has(actorState)) return false;
  if (opts && (opts.dashing || opts.scripted)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Ground probe
// ---------------------------------------------------------------------------

/**
 * Probes the ground under one foot: height, an estimated normal (central-
 * difference gradient), and the surface tag. Reached ONLY via `ctx.get()`
 * (hard rule 2) — see the file header for why `physics.groundHeight` is the
 * right call here, not `nav.heightAt` (does not exist) or a literal
 * `physics.rayCast` (2D, no vertical notion at all).
 * @param {{get:(id:string)=>object}} ctx
 * @param {number} x world X
 * @param {number} z world Z
 * @param {{y:number,nx:number,ny:number,nz:number,surface:string}} out reused.
 * @returns {object} `out`
 */
export function probeGround(ctx, x, z, out) {
  const physics = ctx.get('physics');
  const world = ctx.get('world');
  const eps = IK_DATA.groundNormalEps;

  const yC = physics.groundHeight(x, z);
  const yXp = physics.groundHeight(x + eps, z);
  const yXm = physics.groundHeight(x - eps, z);
  const yZp = physics.groundHeight(x, z + eps);
  const yZm = physics.groundHeight(x, z - eps);

  const dYdx = (yXp - yXm) / (2 * eps);
  const dYdz = (yZp - yZm) / (2 * eps);

  let nx = -dYdx;
  let ny = 1;
  let nz = -dYdz;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 1e-9) {
    nx /= len;
    ny /= len;
    nz /= len;
  } else {
    nx = 0;
    ny = 1;
    nz = 0;
  }

  out.y = yC;
  out.nx = nx;
  out.ny = ny;
  out.nz = nz;
  out.surface = world.surfaceAt(x, z);
  return out;
}

// ---------------------------------------------------------------------------
// Pelvis drop — `08 §5.8` step 2, verbatim
// ---------------------------------------------------------------------------

/**
 * `min` over both feet of `(desiredAnkleY - currentAnkleY)`, clamped to
 * `[IK_DATA.pelvisDropLimit, 0]` — `08` §5.8 step 2 verbatim gives only the
 * lower bound (-0.30 m); this file clamps the upper end at exactly `0`
 * because a POSITIVE value would mean "raise the pelvis above the
 * animator's own baseline," which is not what "drop" names and which §5.8
 * gives no limit for either — the conservative, documented reading is that
 * foot IK only ever lowers the pelvis to help a leg reach a lower foot, it
 * never raises it to help reach a higher one (a raised foot is handled by
 * the two-bone solve's own reach alone, and clamped/reported as
 * `residualM` if it still doesn't fit).
 * @param {number} desiredAnkleYR
 * @param {number} currentAnkleYR
 * @param {number} desiredAnkleYL
 * @param {number} currentAnkleYL
 * @returns {number} metres, `<= 0`.
 */
export function computePelvisDrop(desiredAnkleYR, currentAnkleYR, desiredAnkleYL, currentAnkleYL) {
  const dR = desiredAnkleYR - currentAnkleYR;
  const dL = desiredAnkleYL - currentAnkleYL;
  const raw = dR < dL ? dR : dL;
  return clamp(raw, IK_DATA.pelvisDropLimit, 0);
}

// ---------------------------------------------------------------------------
// Two-bone analytic solve — `08 §5.8` step 3
// ---------------------------------------------------------------------------

/**
 * Analytic two-bone IK: hip -> knee -> ankle, ankle driven to `target`
 * (clamped to the reachable annulus `[|L1-L2|, L1+L2]` when the target is
 * out of reach), knee placed by the standard law-of-cosines construction in
 * the plane spanned by the hip-target axis and a pole vector (`08` §5.8
 * step 3: "Knee pole = the actor's forward vector rotated +-7 deg
 * outward"). Closed-form — one analytic pass, never iterative — so
 * `out.iterations` is always `1`; Rule 12 ("a tolerance criterion hides an
 * abort") is satisfied by `out.residualM` instead: `0` when the target was
 * genuinely reachable, `> 0` (and exactly how much) when it was clamped
 * short, so a caller/test can tell "solved" from "gave up" at a glance.
 * Zero allocation — every intermediate is a scalar local.
 *
 * @param {number} hipX @param {number} hipY @param {number} hipZ world hip position.
 * @param {number} targetX @param {number} targetY @param {number} targetZ world ankle target.
 * @param {number} fwdX @param {number} fwdZ actor's forward direction (unit, Y=0).
 * @param {'R'|'L'} side which leg — determines the pole's outward sign.
 * @param {number} L1 thigh length (metres) — see the file header, derive from `rig.boneLength`.
 * @param {number} L2 shin length (metres).
 * @param {object} out `{kneeX,kneeY,kneeZ,ankleX,ankleY,ankleZ,reachable,residualM,iterations}`, reused.
 * @returns {object} `out`
 */
export function solveTwoBoneLeg(hipX, hipY, hipZ, targetX, targetY, targetZ, fwdX, fwdZ, side, L1, L2, out) {
  const dx = targetX - hipX;
  const dy = targetY - hipY;
  const dz = targetZ - hipZ;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

  const minReach = Math.abs(L1 - L2) + 1e-6;
  const maxReach = L1 + L2 - 1e-6;
  const distClamped = clamp(dist, minReach, maxReach);
  const residual = Math.abs(dist - distClamped);

  let ux, uy, uz;
  if (dist > 1e-9) {
    ux = dx / dist;
    uy = dy / dist;
    uz = dz / dist;
  } else {
    // Degenerate: target coincides with the hip. Point straight down —
    // arbitrary but deterministic, and never expected for a real foot
    // target (see the file header's zero-allocation note: this branch
    // exists to keep the function total, same convention `rig.js`'s own
    // `boneQuatFromAim` fallback uses).
    ux = 0;
    uy = -1;
    uz = 0;
  }

  const ankleX = hipX + ux * distClamped;
  const ankleY = hipY + uy * distClamped;
  const ankleZ = hipZ + uz * distClamped;

  // Pole = forward rotated +-kneePoleDeg about world Y. Sign is this file's
  // own documented reading of "outward": at this rig's bind pose (`rig.js`)
  // UpLegR sits at x=-0.09 (right leg is -X of centreline), UpLegL at
  // x=+0.09 — so "outward" for R is the -X direction, for L the +X
  // direction, i.e. rotating `forward` toward -X for R and toward +X for L.
  const sign = side === 'R' ? -1 : 1;
  const theta = (sign * IK_DATA.kneePoleDeg * Math.PI) / 180;
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const poleX = fwdX * ct - fwdZ * st;
  const poleY = 0;
  const poleZ = fwdX * st + fwdZ * ct;

  // Bend-plane normal = normalize(u x pole) — perpendicular to u by
  // construction, so the Rodrigues rotation below drops its k.v term.
  let bnx = uy * poleZ - uz * poleY;
  let bny = uz * poleX - ux * poleZ;
  let bnz = ux * poleY - uy * poleX;
  const bnLen = Math.sqrt(bnx * bnx + bny * bny + bnz * bnz);
  if (bnLen > 1e-9) {
    bnx /= bnLen;
    bny /= bnLen;
    bnz /= bnLen;
  } else {
    // u parallel to the pole (target dead vertical from the hip and the
    // pole happens to line up too) — fall back to world +X as the bend
    // normal, same "keep the function total" convention as above.
    bnx = 1;
    bny = 0;
    bnz = 0;
  }

  // Law of cosines: angle at the hip between the hip->target axis and the
  // hip->knee axis, given sides L1 (hip-knee), distClamped (hip-target),
  // L2 (knee-target). This is the construction that guarantees
  // |knee-target| == L2 exactly (up to float error) once rotated.
  const cosA = clamp((L1 * L1 + distClamped * distClamped - L2 * L2) / (2 * L1 * distClamped), -1, 1);
  const angleA = Math.acos(cosA);
  const ca = Math.cos(angleA);
  const sa = Math.sin(angleA);

  // Rodrigues: rotate u by angleA around bn (bn . u == 0 by construction,
  // so the (1-cos) term drops).
  const crossX = bny * uz - bnz * uy;
  const crossY = bnz * ux - bnx * uz;
  const crossZ = bnx * uy - bny * ux;
  const kdx = ux * ca + crossX * sa;
  const kdy = uy * ca + crossY * sa;
  const kdz = uz * ca + crossZ * sa;

  out.kneeX = hipX + kdx * L1;
  out.kneeY = hipY + kdy * L1;
  out.kneeZ = hipZ + kdz * L1;
  out.ankleX = ankleX;
  out.ankleY = ankleY;
  out.ankleZ = ankleZ;
  out.reachable = residual < 1e-9;
  out.residualM = residual;
  out.iterations = 1; // closed-form — see this function's own doc comment, Rule 12
  return out;
}

// ---------------------------------------------------------------------------
// Sole roll — `08 §5.8` step 4 (see the file header's own simplification note)
// ---------------------------------------------------------------------------

/**
 * Sagittal-plane-only sole roll, clamped to `IK_DATA.soleRollClampDeg`. See
 * the file header for why this is a documented single-axis simplification
 * (the lateral `nx` component of the ground normal is not read) rather than
 * a full 2-axis alignment.
 * @param {number} nx @param {number} ny @param {number} nz ground normal (unit).
 * @returns {number} degrees, meant to add onto the `Foot` bone's own
 *   ankle-flex rotation (same local axis `writeLegDelta` already writes).
 */
export function computeSoleRollDeg(nx, ny, nz) {
  const angleRad = Math.atan2(-nz, ny);
  const angleDeg = (angleRad * 180) / Math.PI;
  return clamp(angleDeg, -IK_DATA.soleRollClampDeg, IK_DATA.soleRollClampDeg);
}

// ---------------------------------------------------------------------------
// Foot lock — the "held world contact point" mechanism, see the file header
// ---------------------------------------------------------------------------

/** One foot's lock state — allocate once per actor per foot, reuse forever. */
export function createFootLockState() {
  return { locked: false, lockX: 0, lockY: 0, lockZ: 0 };
}

/**
 * Runtime foot-lock/hysteresis: decides whether this foot should be WORLD-
 * LOCKED this frame and writes the effective IK target into `out` — either
 * the held lock point (captured once, at the instant of engagement) or the
 * raw FK (x,z) snapped onto the ground plane's Y when not locked. See the
 * file header's "held world contact point" section for why this, not a
 * per-frame Y-only snap, is what actually cancels foot slide.
 * @param {{locked:boolean,lockX:number,lockY:number,lockZ:number}} lockState reused.
 * @param {number} rawX @param {number} rawY @param {number} rawZ the raw (pre-IK) FK ankle position this frame.
 * @param {number} desiredY ground height + ankle offset at `(rawX,rawZ)`.
 * @param {{x:number,y:number,z:number,locked:boolean}} out reused.
 * @returns {object} `out`
 */
export function updateFootLock(lockState, rawX, rawY, rawZ, desiredY, out) {
  const engageAt = desiredY + IK_DATA.lockEngageMarginM;
  const releaseAt = desiredY + IK_DATA.lockReleaseMarginM;

  if (!lockState.locked) {
    if (rawY <= engageAt) {
      lockState.locked = true;
      lockState.lockX = rawX;
      lockState.lockY = desiredY;
      lockState.lockZ = rawZ;
    }
  } else if (rawY > releaseAt) {
    lockState.locked = false;
  }

  if (lockState.locked) {
    out.x = lockState.lockX;
    out.y = lockState.lockY;
    out.z = lockState.lockZ;
  } else {
    out.x = rawX;
    out.y = desiredY;
    out.z = rawZ;
  }
  out.locked = lockState.locked;
  return out;
}

// ---------------------------------------------------------------------------
// Footfall events — `08` §5.9 / `ARCHITECTURE.md`'s already-canonical
// `actor:footstep` row
// ---------------------------------------------------------------------------
//
// `08` §5.9 (this ticket's own §5.9 reading) prints the payload as
// `{ actor, point, surface, speed }`. `ARCHITECTURE.md`'s event table
// (already-canonical, read in full per this ticket's brief) has
// `actor:footstep` at `{ actor, foot, x, y, z, surface }` instead. Rule 7 in
// this ticket's own brief is explicit that the ARCHITECTURE.md shape is the
// one to emit — this file follows that instruction literally, over §5.9's
// own prose, and flags the mismatch here rather than silently picking one.

/**
 * @param {number} prevPhase previous frame's shared gait phase, `[0,1)`.
 * @param {number} currPhase this frame's, `[0,1)`.
 * @param {number} threshold a plant point, `[0,1)`.
 * @returns {boolean} true iff the phase crossed `threshold` going from
 *   `prevPhase` to `currPhase` (wraparound-aware, half-open `(prev, curr]`
 *   so a threshold sitting exactly on a sample fires exactly once).
 */
function crossedPhaseThreshold(prevPhase, currPhase, threshold) {
  if (currPhase >= prevPhase) {
    return prevPhase < threshold && threshold <= currPhase;
  }
  // Wrapped through 1 -> 0 this frame.
  return prevPhase < threshold || threshold <= currPhase;
}

/**
 * `08` §5.8's footfall table: which of the two plant points (per the
 * currently-`dominant` clip — see `clips.js`'s O-52-fixed `crossfadeWeight`
 * for why this input is trustworthy across the walk<->run flip) each foot
 * crossed this frame.
 * @param {number} prevPhase @param {number} currPhase shared gait phase.
 * @param {'walk'|'run'} dominant
 * @param {{R:boolean,L:boolean}} out reused.
 * @returns {object} `out`
 */
export function detectFootstepCrossings(prevPhase, currPhase, dominant, out) {
  const points = IK_DATA.footPlantPhase[dominant];
  out.R = crossedPhaseThreshold(prevPhase, currPhase, points.R);
  out.L = crossedPhaseThreshold(prevPhase, currPhase, points.L);
  return out;
}

/**
 * Emits `actor:footstep` in `ARCHITECTURE.md`'s canonical shape (rule 7 —
 * see this section's own header note on the §5.9-vs-ARCHITECTURE.md
 * mismatch). This is the one deliberate per-call allocation in this file —
 * see the file header's "Zero allocation" section for why (fires at most
 * twice per gait cycle per actor, an `actor:spawn`-rate event, not an
 * `actor:damage`-rate one).
 * @param {{events:{emit:(name:string, payload:object)=>void}}} ctx
 * @param {object} actor
 * @param {'R'|'L'} foot
 * @param {number} x @param {number} y @param {number} z world contact point.
 * @param {string} surface
 */
export function emitFootstep(ctx, actor, foot, x, y, z, surface) {
  ctx.events.emit('actor:footstep', { actor, foot, x, y, z, surface });
}

// ---------------------------------------------------------------------------
// Contact data for `08 §4.6`'s contact-occlusion sprite — NOT the sprite
// itself
// ---------------------------------------------------------------------------
//
// `08 §11 step 7`'s own acceptance line also asks for "the contact patch is
// present in the shot; 2 draw calls for all contact occlusion" (`08 §4.6`:
// two `InstancedMesh`es, "body + feet"). That sprite is `three` geometry —
// this file cannot import `three` (`src/actors/` outside `archetypes/` has
// no exemption, D-13) and is not itself allowed to touch
// `src/actors/archetypes/` or any dev-shot file (out of this ticket's file
// list). What this file DOES provide is exactly the per-foot data such a
// renderer needs to place its two instances: each foot's held contact point
// (`updateFootLock`'s `out.x/y/z`), whether it is currently planted
// (`out.locked`), and the ground normal at that point (`probeGround`'s
// `out.nx/ny/nz`) to orient the decal. Reported here, and in this ticket's
// report, rather than built: the actual `GroundShadows`/contact-occlusion
// mesh is a rendering concern for the archetype file (or a dev shot) that
// this ticket does not own.

// ---------------------------------------------------------------------------
// updateFootIK — the one per-actor, per-frame entry point tying the above
// together. NOT wired into `anim.js`/`index.js` (see file header).
// ---------------------------------------------------------------------------

/**
 * Allocates everything one actor's foot IK needs, once. Nothing in
 * `updateFootIK` below allocates beyond `emitFootstep`'s own event payload
 * (see that function's doc comment).
 * @returns {object} opaque per-actor IK state — pass to `updateFootIK`.
 */
export function createIKState() {
  return {
    footLockR: createFootLockState(),
    footLockL: createFootLockState(),
    groundR: { y: 0, nx: 0, ny: 1, nz: 0, surface: 'stone' },
    groundL: { y: 0, nx: 0, ny: 1, nz: 0, surface: 'stone' },
    targetR: { x: 0, y: 0, z: 0, locked: false },
    targetL: { x: 0, y: 0, z: 0, locked: false },
    solveR: { kneeX: 0, kneeY: 0, kneeZ: 0, ankleX: 0, ankleY: 0, ankleZ: 0, reachable: true, residualM: 0, iterations: 0 },
    solveL: { kneeX: 0, kneeY: 0, kneeZ: 0, ankleX: 0, ankleY: 0, ankleZ: 0, reachable: true, residualM: 0, iterations: 0 },
    soleRollDegR: 0,
    soleRollDegL: 0,
    pelvisDropM: 0,
    footstepPrevPhase: 0,
    footstepFlags: { R: false, L: false },
    active: false,
  };
}

/**
 * One actor's foot-IK update for this frame. See the file header for the
 * full pipeline this composes (ground probe -> foot lock -> pelvis drop ->
 * two-bone solve -> sole roll -> footfall events) and for why nothing here
 * is wired into `anim.js`'s own pose pipeline yet.
 *
 * @param {{get:(id:string)=>object, events:{emit:Function}}} ctx
 * @param {object} state from `createIKState()`.
 * @param {object} input
 * @param {string} input.actorState one of `ACTOR_STATE`'s values.
 * @param {boolean} [input.dashing] @param {boolean} [input.scripted] see `isFootIKEnabled`.
 * @param {object} input.actor the actor record (passed through to `actor:footstep`).
 * @param {number} input.hipRX @param {number} input.hipRY @param {number} input.hipRZ FK `UpLegR` world position.
 * @param {number} input.hipLX @param {number} input.hipLY @param {number} input.hipLZ FK `UpLegL` world position.
 * @param {number} input.rawAnkleRX @param {number} input.rawAnkleRY @param {number} input.rawAnkleRZ FK `FootR` world position, pre-IK.
 * @param {number} input.rawAnkleLX @param {number} input.rawAnkleLY @param {number} input.rawAnkleLZ FK `FootL` world position, pre-IK.
 * @param {number} input.fwdX @param {number} input.fwdZ actor forward (unit, Y=0).
 * @param {number} input.legLengthR1 @param {number} input.legLengthR2 thigh/shin, right leg (see the file header — derive from `rig.boneLength`).
 * @param {number} input.legLengthL1 @param {number} input.legLengthL2 thigh/shin, left leg.
 * @param {number} [input.ankleOffsetR] @param {number} [input.ankleOffsetL] defaults to `IK_DATA.ankleGroundOffset`.
 * @param {number} [input.gaitPhase] shared gait phase, `[0,1)` — omit to skip footfall detection this call.
 * @param {'walk'|'run'} [input.dominant] from `clips.js#crossfadeWeight`'s `state.dominant`.
 * @returns {object} `state`, for a caller that wants to read `state.targetR/L`, `state.solveR/L`, `state.pelvisDropM`, etc. directly.
 */
export function updateFootIK(ctx, state, input) {
  const enabled = isFootIKEnabled(input.actorState, input);
  state.active = enabled;
  if (!enabled) {
    state.pelvisDropM = 0;
    state.solveR.iterations = 0;
    state.solveL.iterations = 0;
    return state;
  }

  probeGround(ctx, input.rawAnkleRX, input.rawAnkleRZ, state.groundR);
  probeGround(ctx, input.rawAnkleLX, input.rawAnkleLZ, state.groundL);

  const ankleOffsetR = input.ankleOffsetR !== undefined ? input.ankleOffsetR : IK_DATA.ankleGroundOffset;
  const ankleOffsetL = input.ankleOffsetL !== undefined ? input.ankleOffsetL : IK_DATA.ankleGroundOffset;
  const desiredYR = state.groundR.y + ankleOffsetR;
  const desiredYL = state.groundL.y + ankleOffsetL;

  updateFootLock(state.footLockR, input.rawAnkleRX, input.rawAnkleRY, input.rawAnkleRZ, desiredYR, state.targetR);
  updateFootLock(state.footLockL, input.rawAnkleLX, input.rawAnkleLY, input.rawAnkleLZ, desiredYL, state.targetL);

  state.pelvisDropM = computePelvisDrop(desiredYR, input.rawAnkleRY, desiredYL, input.rawAnkleLY);

  const hipRY = input.hipRY + state.pelvisDropM;
  const hipLY = input.hipLY + state.pelvisDropM;

  const L1R = input.legLengthR1 !== undefined ? input.legLengthR1 : IK_DATA.legLength.thigh;
  const L2R = input.legLengthR2 !== undefined ? input.legLengthR2 : IK_DATA.legLength.shin;
  const L1L = input.legLengthL1 !== undefined ? input.legLengthL1 : IK_DATA.legLength.thigh;
  const L2L = input.legLengthL2 !== undefined ? input.legLengthL2 : IK_DATA.legLength.shin;

  solveTwoBoneLeg(
    input.hipRX, hipRY, input.hipRZ,
    state.targetR.x, state.targetR.y, state.targetR.z,
    input.fwdX, input.fwdZ, 'R', L1R, L2R, state.solveR,
  );
  solveTwoBoneLeg(
    input.hipLX, hipLY, input.hipLZ,
    state.targetL.x, state.targetL.y, state.targetL.z,
    input.fwdX, input.fwdZ, 'L', L1L, L2L, state.solveL,
  );

  state.soleRollDegR = computeSoleRollDeg(state.groundR.nx, state.groundR.ny, state.groundR.nz);
  state.soleRollDegL = computeSoleRollDeg(state.groundL.nx, state.groundL.ny, state.groundL.nz);

  if (input.gaitPhase !== undefined && input.dominant) {
    detectFootstepCrossings(state.footstepPrevPhase, input.gaitPhase, input.dominant, state.footstepFlags);
    if (state.footstepFlags.R) {
      emitFootstep(ctx, input.actor, 'R', state.targetR.x, state.targetR.y, state.targetR.z, state.groundR.surface);
    }
    if (state.footstepFlags.L) {
      emitFootstep(ctx, input.actor, 'L', state.targetL.x, state.targetL.y, state.targetL.z, state.groundL.surface);
    }
    state.footstepPrevPhase = input.gaitPhase;
  }

  return state;
}
