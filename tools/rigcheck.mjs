#!/usr/bin/env node
// tools/rigcheck.mjs
//
// ACTR-3's acceptance check, `08-characters-visual.md §11 step 1`, verbatim:
// "22/16/12/26 bones; every world bind position round-trips through the
// local transforms within 1e-6 m; no bone length is 0; every `*R` bone has
// x < 0; every parent index is less than its child index."
//
// ACTR-5 (this ticket's own addition) adds `08 §11 step 3`'s acceptance
// check, verbatim: "weights sum to 255 exactly; zero influences below the
// cut; candy-wrapper loss < 12 % at the elbow and the knee under a 90 deg
// bend; no vertex bound to a bone > 0.45 m away" — see `SKIN_GROUPS` below.
//
// ---------------------------------------------------------------------------
// A registry, not a script — ACTR-3's own rig groups are untouched
// ---------------------------------------------------------------------------
// This file was deliberately structured by ACTR-3 so a second check group
// could be added as `const SKIN_GROUPS = [...]` alongside `RIG_GROUPS` below,
// sharing `main()`, the one reporting path, and the one exit code — never by
// rewriting what was already here. ACTR-3's four `RIG_GROUPS` entries and the
// `RIGS`/`EXPECTED_COUNT` tables above are UNCHANGED by this ticket — they
// are an accepted, verified criterion (22/16/12/26 bones, 245 checks) and
// must keep passing untouched. `run()`'s shape for `SKIN_GROUPS` is `{
// checks, violations }`, same as `RIG_GROUPS`, but called with NO arguments
// (`main()`'s aggregation loop below calls `group.run()` — each skin group is
// fully self-contained, building its own fixture via `src/actors/skin.js`'s
// diagnostic helpers) rather than per-rig, since a skin binding is not itself
// a rig.
//
// ---------------------------------------------------------------------------
// Falsifiability (rule 12 of this ticket's brief)
// ---------------------------------------------------------------------------
// Every group reports the number of bones and the number of individual
// assertions it actually performed, per rig, in both the human and the
// `--json` output — a PASS with `checks=0` is exactly as visible as a PASS
// with `checks=140`, so a check group that quietly does nothing cannot hide
// behind a green result. `SKIN_GROUPS` follows the same discipline: each
// entry reports real vertex/influence counts (`SKIN.sum255`/`SKIN.cut`/
// `SKIN.boneDistance` iterate a real bound scene, not a stub) or, for the two
// candy-wrapper groups, the actual measured bind/posed convex-hull areas —
// never a bare boolean.
//
// ---------------------------------------------------------------------------
// CLI contract (12-testing.md §5.1, matching check-imports.mjs/check-fixed.mjs)
// ---------------------------------------------------------------------------
// Implemented: --json <path>, --verbose, --help, exit codes 0/1/2.
// NOT implemented, on purpose: --seed (this check has no randomness — the
// bone tables in src/actors/rig.js are static data, not sampled) and --bless
// (nothing here is a fixture to regenerate; the "fixture" IS the spec table,
// and that is edited in docs/, not blessed by this tool). Passing either is
// reported as a CLI error (exit 2), the same discipline the other two tools
// already use, rather than silently accepted.
//
// Exit codes: 0 every check passed. 1 at least one assertion failed. 2 could
// not run (bad CLI usage, or src/actors/rig.js failed to load/threw).

import { writeFileSync } from 'node:fs';
import { createSkeleton, reconstructBindPos, RIG_BONE_COUNTS } from '../src/actors/rig.js';
import { SKIN_CONSTANTS, runSkinDiagnostics, elbowCandyWrapperCheck, kneeCandyWrapperCheck } from '../src/actors/skin.js';

const HELP_TEXT = `rigcheck.mjs — 08-characters-visual.md §11 steps 1 and 3's acceptance checks (ACTR-3, ACTR-5)

Usage:
  node tools/rigcheck.mjs [--json <path>] [--verbose] [--help]

Builds all four rigs via src/actors/rig.js#createSkeleton() (humanoid
cloakless, quadruped, crawler, boss) and checks, per rig:
  - bone count matches 08 §2.7's summary (22/16/12/26)
  - every world bind position round-trips through localPos/localQuat within
    1e-6 m (08 §2.1's formula, run forward)
  - no bone has zero length (excluding the root, which is not a segment)
  - every bone whose name ends in 'R' has bindPos.x < 0 (08 §2.1's
    right-hand convention)
  - every parent index is less than its own bone's index

Then binds a diagnostic scene via src/actors/skin.js#bindSkin() (a real limb
built from rig.js + geo.js — a rigid part, two smooth parts, one deliberate
cross-part weld) and checks, per 08 §11 step 3:
  - quantised skinWeight sums to exactly 255 for every vertex, and every
    vertex has at least one live influence
  - no influence survives below W_CUT * that vertex's max
  - the elbow's and the knee's joint-clamped ring loses < 12% convex-hull
    area under a 90 deg bend (measured elbow/knee separately)
  - no vertex is bound to a bone more than 0.45 m away in bind pose

Options:
  --json <path>   also write a machine-readable result to <path>
  --verbose       print every bone checked, not just failures
  --help          print this message and exit 0

Exit codes:
  0  every check passed
  1  at least one assertion failed
  2  could not run (bad CLI usage, or src/actors/rig.js failed to load)

Not implemented (see the header for why):
  --seed   this check has no randomness; the bone tables are static data
  --bless  nothing here is a fixture; the source of truth is docs/spec/08-characters-visual.md
`;

function parseArgs(argv) {
  const args = { json: null, verbose: false, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--verbose') {
      args.verbose = true;
    } else if (a === '--json') {
      const val = argv[i + 1];
      if (val === undefined) {
        args.error = `--json requires a path argument`;
        return args;
      }
      args.json = val;
      i++;
    } else if (a === '--seed' || a === '--bless') {
      args.error = `${a} is not implemented by rigcheck.mjs — see --help (no randomness, no fixtures)`;
      return args;
    } else {
      args.error = `unknown flag: ${a} (see --help)`;
      return args;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// The four rigs under test — cloakless humanoid, per this ticket's own
// reading of §2.3/§2.7 (the Bone Ranker, M2's only archetype, is cloakless;
// see src/actors/rig.js's header). The 24-bone cloak variant is exercised by
// tests/actors/rig.test.js but is not part of this tool's fixed rig list —
// rigcheck's contract is the FOUR counts in the acceptance criterion
// (22/16/12/26), not every createSkeleton() option.
// ---------------------------------------------------------------------------

const RIGS = [
  { rigId: 'humanoid', opts: {} },
  { rigId: 'quadruped', opts: {} },
  { rigId: 'crawler', opts: {} },
  { rigId: 'boss', opts: {} },
];

const EXPECTED_COUNT = {
  humanoid: RIG_BONE_COUNTS.humanoid,
  quadruped: RIG_BONE_COUNTS.quadruped,
  crawler: RIG_BONE_COUNTS.crawler,
  boss: RIG_BONE_COUNTS.boss,
};

function vec3At(arr, i) {
  return { x: arr[i * 3], y: arr[i * 3 + 1], z: arr[i * 3 + 2] };
}

/**
 * One check group's `run()` — takes a skeleton and returns every violation
 * found plus how many individual assertions it performed (rule 12:
 * falsifiability). `id` prefixes every reported failure line.
 */
const RIG_GROUPS = [
  {
    id: 'RIG.count',
    describe: 'bone count matches 08 §2.7',
    run(skeleton, expectedCount, verbose) {
      const violations = [];
      if (skeleton.boneCount !== expectedCount) {
        violations.push({
          detail: `boneCount=${skeleton.boneCount}, expected ${expectedCount}`,
          expected: String(expectedCount),
          actual: String(skeleton.boneCount),
        });
      }
      if (verbose) console.log(`  [RIG.count] ${skeleton.rigId}: ${skeleton.boneCount} bones (expected ${expectedCount})`);
      return { checks: 1, violations };
    },
  },
  {
    id: 'RIG.roundtrip',
    describe: 'world bind position round-trips within 1e-6 m',
    run(skeleton, _expectedCount, verbose) {
      const violations = [];
      const reconstructed = reconstructBindPos(skeleton);
      for (let i = 0; i < skeleton.boneCount; i++) {
        const original = vec3At(skeleton.bindPos, i);
        const rebuilt = vec3At(reconstructed, i);
        const dx = rebuilt.x - original.x;
        const dy = rebuilt.y - original.y;
        const dz = rebuilt.z - original.z;
        const err = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (verbose) console.log(`  [RIG.roundtrip] ${skeleton.rigId}.${skeleton.names[i]} err=${err.toExponential(3)} m`);
        if (!(err < 1e-6)) {
          violations.push({
            bone: skeleton.names[i],
            detail: `round-trip error ${err} m >= 1e-6 m`,
            expected: '< 1e-6',
            actual: String(err),
          });
        }
      }
      return { checks: skeleton.boneCount, violations };
    },
  },
  {
    id: 'RIG.length',
    describe: 'no bone length is 0',
    run(skeleton, _expectedCount, verbose) {
      const violations = [];
      let checked = 0;
      for (let i = 0; i < skeleton.boneCount; i++) {
        if (skeleton.parents[i] < 0) continue; // the root is not a bone segment
        checked++;
        const length = skeleton.boneLength[i];
        if (verbose) console.log(`  [RIG.length] ${skeleton.rigId}.${skeleton.names[i]} length=${length.toFixed(4)} m`);
        if (!(length > 0)) {
          violations.push({ bone: skeleton.names[i], detail: `length=${length}`, expected: '> 0', actual: String(length) });
        }
      }
      return { checks: checked, violations };
    },
  },
  {
    id: 'RIG.rightX',
    describe: 'every *R bone has x < 0',
    run(skeleton, _expectedCount, verbose) {
      const violations = [];
      let checked = 0;
      for (let i = 0; i < skeleton.boneCount; i++) {
        if (!skeleton.names[i].endsWith('R')) continue;
        checked++;
        const x = skeleton.bindPos[i * 3];
        if (verbose) console.log(`  [RIG.rightX] ${skeleton.rigId}.${skeleton.names[i]} x=${x}`);
        if (!(x < 0)) {
          violations.push({ bone: skeleton.names[i], detail: `x=${x}`, expected: '< 0', actual: String(x) });
        }
      }
      return { checks: checked, violations };
    },
  },
  {
    id: 'RIG.parentOrder',
    describe: 'every parent index is less than its child index',
    run(skeleton, _expectedCount, verbose) {
      const violations = [];
      for (let i = 0; i < skeleton.boneCount; i++) {
        const parent = skeleton.parents[i];
        if (verbose) console.log(`  [RIG.parentOrder] ${skeleton.rigId}.${skeleton.names[i]} parent=${parent} self=${i}`);
        if (!(parent < i)) {
          violations.push({
            bone: skeleton.names[i],
            detail: `parent index ${parent} >= self index ${i}`,
            expected: `< ${i}`,
            actual: String(parent),
          });
        }
      }
      return { checks: skeleton.boneCount, violations };
    },
  },
];

// ---------------------------------------------------------------------------
// ACTR-5 — the skin binder, `08 §11 step 3`: "weights sum to 255 exactly;
// zero influences below the cut; candy-wrapper loss < 12 % at the elbow and
// the knee under a 90 deg bend; no vertex bound to a bone > 0.45 m away."
// Every group below shares `run()`'s `{ checks, violations }` shape with
// `RIG_GROUPS` above; `main()`'s aggregation loop calls each with NO
// arguments (see that loop) — each group is fully self-contained, building
// its own fixture via `src/actors/skin.js`'s diagnostic helpers (a real
// skinned limb built from ACTR-3's rig + ACTR-4's geometry toolkit, per the
// ticket's own instruction not to invent geometry). See `skin.js`'s header
// for why the candy-wrapper measurement poses the mesh with a quaternion
// rotation blend about the shared joint, not naive per-vertex position
// averaging — the latter measurably fails this exact criterion (~29% loss)
// while the former matches the spec's own claim that a 50/50-clamped ring
// "rotates rigidly... preserves its cross-section".
// ---------------------------------------------------------------------------

const SKIN_GROUPS = [
  {
    id: 'SKIN.sum255',
    describe: 'quantised weights sum to exactly 255 per vertex; every vertex bound',
    run() {
      const { totalVertices, violations } = runSkinDiagnostics();
      return { checks: totalVertices, violations: violations.sum255 };
    },
  },
  {
    id: 'SKIN.cut',
    describe: `no influence below the cut (W_CUT=${SKIN_CONSTANTS.W_CUT})`,
    run() {
      const { totalInfluences, violations } = runSkinDiagnostics();
      return { checks: totalInfluences, violations: violations.cut };
    },
  },
  {
    id: 'SKIN.boneDistance',
    describe: 'no vertex bound to a bone > 0.45 m away in bind pose',
    run() {
      const { totalInfluences, violations } = runSkinDiagnostics();
      return { checks: totalInfluences, violations: violations.distance };
    },
  },
  // The next two groups assert on the QUATERNION-BLENDED loss (the
  // orchestrator's accepted reading of `08 §3.5` step 4 — see
  // `measureCandyWrapper`'s own doc comment in `src/actors/skin.js` for the
  // full derivation). They ALSO surface the plain-LBS figure for the exact
  // same weights, informationally, on the same report line: this assertion
  // is a statement about the WEIGHTS this binder produces, and it only
  // holds if whatever consumes them at runtime blends bone ROTATIONS
  // (quaternion NLERP about the shared joint) rather than blending already-
  // transformed POSITIONS (plain linear-blend skinning, `08 §2.2`'s own
  // named method and Three's stock skinning chunk). If the eventual GPU
  // shader ships plain LBS instead, THIS SAME BINDING measures ~29% loss at
  // the elbow, not the ~0% a PASS here reports — that number is printed
  // every run specifically so a green result can never be read as "safe
  // under any skinning method".
  {
    id: 'SKIN.candyWrapperElbow',
    describe: 'candy-wrapper loss < 12% at the elbow under a 90 deg bend (blended-rotation assertion; LBS figure informational)',
    run() {
      const { loss, lbsLoss, bindArea, posedArea, ringVertexCount } = elbowCandyWrapperCheck();
      const violations = [];
      if (!(loss < 0.12)) {
        violations.push({
          detail: `elbow candy-wrapper loss ${(loss * 100).toFixed(2)}% (bindArea=${bindArea.toFixed(6)}, posedArea=${posedArea.toFixed(6)}, ring=${ringVertexCount}v)`,
          expected: '< 12%', actual: `${(loss * 100).toFixed(2)}%`,
        });
      }
      const note = `blended=${(Math.max(0, loss) * 100).toFixed(2)}%  (LBS would be ${(lbsLoss * 100).toFixed(1)}%)`;
      return { checks: 1, violations, note };
    },
  },
  {
    id: 'SKIN.candyWrapperKnee',
    describe: 'candy-wrapper loss < 12% at the knee under a 90 deg bend (blended-rotation assertion; LBS figure informational)',
    run() {
      const { loss, lbsLoss, bindArea, posedArea, ringVertexCount } = kneeCandyWrapperCheck();
      const violations = [];
      if (!(loss < 0.12)) {
        violations.push({
          detail: `knee candy-wrapper loss ${(loss * 100).toFixed(2)}% (bindArea=${bindArea.toFixed(6)}, posedArea=${posedArea.toFixed(6)}, ring=${ringVertexCount}v)`,
          expected: '< 12%', actual: `${(loss * 100).toFixed(2)}%`,
        });
      }
      const note = `blended=${(Math.max(0, loss) * 100).toFixed(2)}%  (LBS would be ${(lbsLoss * 100).toFixed(1)}%)`;
      return { checks: 1, violations, note };
    },
  },
];

function toFailLine(groupId, rigId, v) {
  const scope = v.bone ? `${rigId}.${v.bone}` : rigId;
  return `FAIL  ${groupId}  ${scope}  ${v.detail}  expected=${v.expected}  actual=${v.actual}  delta=—`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`rigcheck: ${args.error}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(HELP_TEXT);
    process.exitCode = 0;
    return;
  }

  const t0 = Date.now();
  const allViolations = [];
  const perRig = [];
  let totalBones = 0;
  let totalChecks = 0;

  for (const { rigId, opts } of RIGS) {
    let skeleton;
    try {
      skeleton = createSkeleton(rigId, opts);
    } catch (err) {
      console.error(`rigcheck: could not build rig '${rigId}': ${err.message}`);
      process.exitCode = 2;
      return;
    }
    const expectedCount = EXPECTED_COUNT[rigId];
    totalBones += skeleton.boneCount;

    let rigChecks = 0;
    let rigFail = 0;
    for (const group of RIG_GROUPS) {
      const { checks, violations } = group.run(skeleton, expectedCount, args.verbose);
      rigChecks += checks;
      for (const v of violations) {
        allViolations.push({ groupId: group.id, rigId, ...v });
        rigFail++;
      }
    }
    totalChecks += rigChecks;
    perRig.push({ rigId, boneCount: skeleton.boneCount, checks: rigChecks, fail: rigFail });
  }

  // ACTR-5's skin-binder groups — each self-contained (`run()` takes no
  // arguments; see `SKIN_GROUPS`'s own header), aggregated through the exact
  // same loop shape `RIG_GROUPS` uses above.
  let totalSkinChecks = 0;
  const perSkinGroup = [];
  for (const group of SKIN_GROUPS) {
    const { checks, violations, note } = group.run();
    totalChecks += checks;
    totalSkinChecks += checks;
    for (const v of violations) allViolations.push({ groupId: group.id, rigId: '(skin)', ...v });
    perSkinGroup.push({ groupId: group.id, checks, fail: violations.length, note: note ?? null });
  }

  for (const v of allViolations) console.error(toFailLine(v.groupId, v.rigId, v));

  const elapsedS = ((Date.now() - t0) / 1000).toFixed(2);
  const exitCode = allViolations.length > 0 ? 1 : 0;

  console.log(
    `rigcheck.mjs  seed=n/a  rigs=${RIGS.length}  bones=${totalBones}  checks=${totalChecks}  elapsed=${elapsedS}s`,
  );
  for (const r of perRig) {
    console.log(`  rig ${r.rigId.padEnd(10)} ${String(r.boneCount).padStart(2)} bones   ${r.checks} checks   ${r.fail} fail`);
  }
  console.log(`  skin binder (ACTR-5)  ${totalSkinChecks} checks  ${perSkinGroup.reduce((s, g) => s + g.fail, 0)} fail`);
  for (const g of perSkinGroup) {
    const noteSuffix = g.note ? `   ${g.note}` : '';
    console.log(`    ${g.groupId.padEnd(24)} ${String(g.checks).padStart(4)} checks   ${g.fail} fail${noteSuffix}`);
  }
  console.log(`  RESULT: ${exitCode === 0 ? 'PASS' : `FAIL (${allViolations.length})`}`);

  if (args.json) {
    const payload = {
      tool: 'rigcheck.mjs',
      exitCode,
      elapsedMs: Date.now() - t0,
      rigsChecked: RIGS.length,
      totalBones,
      totalChecks,
      perRig,
      totalSkinChecks,
      perSkinGroup,
      failures: allViolations.map((v) => ({
        group: v.groupId,
        rig: v.rigId,
        bone: v.bone ?? null,
        detail: v.detail,
        expected: v.expected,
        actual: v.actual,
      })),
    };
    writeFileSync(args.json, JSON.stringify(payload, null, 2));
  }

  process.exitCode = exitCode;
}

main();
