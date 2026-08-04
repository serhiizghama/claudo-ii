// src/world/gen/wastes.js
//
// WRLD-6 — the Ashen Wastes dressing (R8) and boundary treatment (R9),
// `07-world-gen.md` §3.2 R8/R9 + §9.1/§9.2's instancing catalogue. Pure
// function, headless: no `three`, no `document`/`window`, no
// `performance.now()`/`Date.now()`, no `Math.random()` — every draw comes
// from the `S1`/`S2`/`S6` streams `src/world/gen/ridgewalk.js` hands back in
// `layout.streams` (07 §1.8: S1 shape, S2 dress, S6 material). This file is
// a sibling of `ridgewalk.js` under the same `src/world` lint root
// (`checkThree: true, checkGlobals: true`, `tools/check-imports.mjs`) and
// stays clean under that sweep, transitively (it imports only
// `./ridgewalk.js`, already verified clean by WRLD-5).
//
// D-72 (this ticket's own binding note): this file emits a *dressing plan* —
// positions, prototype ids, facings, scales, footprints — as plain data.
// `src/world/build/wastes.js` is the sibling file where `three` is legal; it
// consumes this file's output and builds the actual `InstancedMesh`es. See
// this ticket's report, "D-72/D-65 — the file split", for a real, measured
// problem with that split under the CURRENT `tools/check-imports.mjs` (not
// touched here — out of this ticket's file grant).
//
// ---------------------------------------------------------------------------
// The catalogue (07 §9.1/§9.2) — verbatim data, not invented (rule 6/13)
// ---------------------------------------------------------------------------
// `INSTANCING_GROUPS` is §9.1's nine-row table, verbatim. `PROTOTYPE_CATALOG`
// is §9.2's 42-row table, verbatim (`tris`, `spacing` = `protoSpec.minSpacing`
// for R8's dart throw, `topY`, `block` = `Footprint.blocksNav`,
// `destructible`, `container`). Only `G1/G2/G3/G4/G5/G6/G9` — the groups
// whose `zones` column includes `wastes` or `all` — are actually built into
// geometry by this ticket; `G7`/`G8` (bonereach/altar/town-only) are kept in
// the catalogue as data (so criterion 1's "nine groups, not eight" is a real,
// checkable fact) but never drawn from by `runR8Dressing`/`runR9Boundary`
// below — no seventh archetype, no tenth prototype group (rule 13).

import { cellIndex, cellOf, cellCentre, ARCHETYPE_TABLE } from './ridgewalk.js';

const GRID_DIM = 4; // same fixed grid ridgewalk.js's own R1 establishes

export const INSTANCING_GROUPS = Object.freeze([
  Object.freeze({ id: 'G1', name: 'flora', materialKey: 'wastes_deadwood', zones: Object.freeze(['wastes']), prototypeCount: 4 }),
  Object.freeze({ id: 'G2', name: 'rubble', materialKey: 'wastes_ashrock', zones: Object.freeze(['wastes', 'altar']), prototypeCount: 4 }),
  Object.freeze({ id: 'G3', name: 'ruin', materialKey: 'stone_ruin', zones: Object.freeze(['wastes', 'altar']), prototypeCount: 5 }),
  Object.freeze({ id: 'G4', name: 'bone', materialKey: 'bone_field', zones: Object.freeze(['wastes', 'bonereach', 'altar']), prototypeCount: 4 }),
  Object.freeze({ id: 'G5', name: 'camp', materialKey: 'camp_cloth', zones: Object.freeze(['wastes']), prototypeCount: 4 }),
  Object.freeze({ id: 'G6', name: 'container', materialKey: 'container_mixed', zones: Object.freeze(['all']), prototypeCount: 5 }),
  Object.freeze({ id: 'G7', name: 'crypt', materialKey: 'crypt_stone', zones: Object.freeze(['bonereach', 'altar']), prototypeCount: 6 }),
  Object.freeze({ id: 'G8', name: 'town', materialKey: 'town_timber', zones: Object.freeze(['town']), prototypeCount: 8 }),
  Object.freeze({ id: 'G9', name: 'far', materialKey: 'silhouette', zones: Object.freeze(['wastes']), prototypeCount: 2 }),
]);

/** `id -> { group, tris, spacing, topY, block, destructible, container }` —
 * `07` §9.2, verbatim, all 42 prototypes (not just the 28 wastes touches —
 * criterion 1 wants the full nine/forty-two catalogue to exist as a real,
 * checkable fact, not merely the subset one zone happens to draw from). */
export const PROTOTYPE_CATALOG = Object.freeze({
  dead_tree_tall: Object.freeze({ group: 'G1', tris: 620, spacing: 3.2, topY: 6.4, block: true, destructible: false, container: false }),
  dead_tree_split: Object.freeze({ group: 'G1', tris: 480, spacing: 3.0, topY: 4.8, block: true, destructible: false, container: false }),
  thicket: Object.freeze({ group: 'G1', tris: 260, spacing: 1.6, topY: 1.3, block: false, destructible: false, container: false }),
  root_claw: Object.freeze({ group: 'G1', tris: 180, spacing: 1.4, topY: 0.7, block: false, destructible: false, container: false }),
  boulder_large: Object.freeze({ group: 'G2', tris: 340, spacing: 2.8, topY: 2.2, block: true, destructible: false, container: false }),
  boulder_small: Object.freeze({ group: 'G2', tris: 160, spacing: 1.2, topY: 0.8, block: false, destructible: false, container: false }),
  ash_drift: Object.freeze({ group: 'G2', tris: 96, spacing: 2.0, topY: 0.5, block: false, destructible: false, container: false }),
  slag_shard: Object.freeze({ group: 'G2', tris: 120, spacing: 1.0, topY: 1.1, block: false, destructible: false, container: false }),
  ruin_wall_stub: Object.freeze({ group: 'G3', tris: 420, spacing: 3.4, topY: 2.6, block: true, destructible: false, container: false }),
  ruin_arch: Object.freeze({ group: 'G3', tris: 560, spacing: 4.0, topY: 4.2, block: true, destructible: false, container: false }),
  column_drum: Object.freeze({ group: 'G3', tris: 210, spacing: 1.8, topY: 0.9, block: false, destructible: false, container: false }),
  column_standing: Object.freeze({ group: 'G3', tris: 380, spacing: 2.6, topY: 3.8, block: true, destructible: false, container: false }),
  flagstone_patch: Object.freeze({ group: 'G3', tris: 64, spacing: 2.4, topY: 0.05, block: false, destructible: false, container: false }),
  ribcage: Object.freeze({ group: 'G4', tris: 520, spacing: 3.0, topY: 2.1, block: true, destructible: false, container: false }),
  skull_pile: Object.freeze({ group: 'G4', tris: 300, spacing: 1.6, topY: 0.7, block: false, destructible: false, container: false }),
  spine_arc: Object.freeze({ group: 'G4', tris: 240, spacing: 2.2, topY: 1.4, block: false, destructible: false, container: false }),
  bone_shard_field: Object.freeze({ group: 'G4', tris: 84, spacing: 1.0, topY: 0.2, block: false, destructible: false, container: false }),
  tent_hide: Object.freeze({ group: 'G5', tris: 380, spacing: 3.6, topY: 2.4, block: true, destructible: false, container: false }),
  pyre: Object.freeze({ group: 'G5', tris: 290, spacing: 3.0, topY: 2.0, block: true, destructible: false, container: false }),
  stake_row: Object.freeze({ group: 'G5', tris: 220, spacing: 2.0, topY: 2.8, block: false, destructible: false, container: false }),
  banner_tattered: Object.freeze({ group: 'G5', tris: 150, spacing: 2.4, topY: 3.2, block: false, destructible: false, container: false }),
  urn_clay: Object.freeze({ group: 'G6', tris: 180, spacing: 1.2, topY: 0.9, block: true, destructible: true, container: true }),
  barrel_wood: Object.freeze({ group: 'G6', tris: 220, spacing: 1.4, topY: 1.1, block: true, destructible: true, container: true }),
  crate_wood: Object.freeze({ group: 'G6', tris: 160, spacing: 1.4, topY: 0.9, block: true, destructible: true, container: true }),
  chest_iron: Object.freeze({ group: 'G6', tris: 460, spacing: 3.0, topY: 1.0, block: true, destructible: false, container: true }),
  sarcophagus: Object.freeze({ group: 'G6', tris: 540, spacing: 3.4, topY: 1.2, block: true, destructible: false, container: true }),
  crypt_pillar: Object.freeze({ group: 'G7', tris: 400, spacing: 3.2, topY: 5.0, block: true, destructible: false, container: false }),
  wall_sconce: Object.freeze({ group: 'G7', tris: 140, spacing: 4.0, topY: 2.4, block: false, destructible: false, container: false }),
  chain_hanging: Object.freeze({ group: 'G7', tris: 110, spacing: 1.8, topY: 3.4, block: false, destructible: false, container: false }),
  coffin_stack: Object.freeze({ group: 'G7', tris: 380, spacing: 2.6, topY: 1.5, block: true, destructible: false, container: false }),
  alcove_skeleton: Object.freeze({ group: 'G7', tris: 340, spacing: 3.0, topY: 1.7, block: false, destructible: false, container: false }),
  rubble_interior: Object.freeze({ group: 'G7', tris: 130, spacing: 1.2, topY: 0.6, block: false, destructible: false, container: false }),
  crate_wood_town: Object.freeze({ group: 'G8', tris: 160, spacing: 1.2, topY: 0.9, block: true, destructible: false, container: false }),
  sack_cloth: Object.freeze({ group: 'G8', tris: 190, spacing: 1.0, topY: 0.7, block: false, destructible: false, container: false }),
  market_stall: Object.freeze({ group: 'G8', tris: 520, spacing: 4.5, topY: 2.7, block: true, destructible: false, container: false }),
  cart_broken: Object.freeze({ group: 'G8', tris: 480, spacing: 3.5, topY: 1.8, block: true, destructible: false, container: false }),
  lantern_post: Object.freeze({ group: 'G8', tris: 210, spacing: 5.0, topY: 2.9, block: true, destructible: false, container: false }),
  planter_stone: Object.freeze({ group: 'G8', tris: 170, spacing: 2.0, topY: 0.6, block: true, destructible: false, container: false }),
  bench_stone: Object.freeze({ group: 'G8', tris: 130, spacing: 2.4, topY: 0.5, block: true, destructible: false, container: false }),
  weapon_rack: Object.freeze({ group: 'G8', tris: 290, spacing: 2.0, topY: 1.9, block: true, destructible: false, container: false }),
  far_spire: Object.freeze({ group: 'G9', tris: 180, spacing: 8.0, topY: 26.0, block: false, destructible: false, container: false }),
  far_ridge: Object.freeze({ group: 'G9', tris: 240, spacing: 12.0, topY: 18.0, block: false, destructible: false, container: false }),
});

/** Footprint.surface for every `block: true` prototype this zone actually
 * draws from (the wastes-resident subset below) — ASSIGNED, since §9.2 gives
 * no per-prototype surface (only §9.1's per-GROUP surface, and several
 * groups list more than one, e.g. G2 `stone`/`ash`, G6 `wood`/`stone`/
 * `metal`). Chosen from each prototype's own name/material, one concrete
 * value from ARCHITECTURE.md's twelve-value surface vocabulary per prototype
 * — see this ticket's report, "what the spec left ambiguous". */
export const PROP_SURFACE = Object.freeze({
  dead_tree_tall: 'wood',
  dead_tree_split: 'wood',
  boulder_large: 'stone',
  ruin_wall_stub: 'stone',
  ruin_arch: 'stone',
  column_standing: 'stone',
  ribcage: 'bone',
  tent_hide: 'wood',
  pyre: 'wood',
  urn_clay: 'stone',
  barrel_wood: 'wood',
  crate_wood: 'wood',
  chest_iron: 'metal',
  sarcophagus: 'stone',
});

/**
 * Per-archetype prototype pool for R8's `S2.weighted(archetypeProtoTable)`
 * draw — ASSIGNED (07 gives no archetype->prototype mapping in the read
 * spec, only R7's own "draw-call cost" column: 4/6/6/5/5/7 for
 * ash_flats/dead_grove/ruin_field/bone_yard/ravine/warcamp). Each entry's
 * LENGTH matches that column exactly; membership is this ticket's own
 * documented, thematic choice (rubble for the open ash flats, flora +
 * two G6 containers for the dead grove, ruin prototypes + a sarcophagus for
 * the ruin field, bone prototypes + an urn for the bone yard, the SAME
 * rubble set as ash_flats (shared, not fresh — 07 §3.4's own "prototypes are
 * shared across cells" point, applied across archetypes here too) + a chest
 * for the ravine, camp prototypes + three G6 containers for the densest
 * fight in the zone). Every G6 container in the game (5 total) is used by at
 * least one archetype. Drawn UNIFORMLY (`Rng.pick`) — §9.2 gives no
 * per-prototype weight either (ASSIGNED, documented; see report). */
export const ARCHETYPE_PROTO_TABLE = Object.freeze({
  ash_flats: Object.freeze(['boulder_large', 'boulder_small', 'ash_drift', 'slag_shard']),
  dead_grove: Object.freeze(['dead_tree_tall', 'dead_tree_split', 'thicket', 'root_claw', 'crate_wood', 'barrel_wood']),
  ruin_field: Object.freeze(['ruin_wall_stub', 'ruin_arch', 'column_drum', 'column_standing', 'flagstone_patch', 'sarcophagus']),
  bone_yard: Object.freeze(['ribcage', 'skull_pile', 'spine_arc', 'bone_shard_field', 'urn_clay']),
  ravine: Object.freeze(['boulder_large', 'boulder_small', 'ash_drift', 'slag_shard', 'chest_iron']),
  warcamp: Object.freeze(['tent_hide', 'pyre', 'stake_row', 'banner_tattered', 'crate_wood', 'barrel_wood', 'chest_iron']),
});

// `protoSpec.scaleMin`/`scaleMax` (R8's own pseudocode fields) has no §9.2
// column and no other spec table gives it a number — ASSIGNED, one fixed
// pair applied to every prototype (rule 6: "if the spec does not give you a
// number, stop and ask" — this is exactly that case, resolved with the
// smallest defensible placeholder: enough variance to satisfy
// ARCHITECTURE.md's quality bar ("varied instance rotation/scale") without
// inventing a per-prototype table nothing asks for).
const SCALE_MIN = 0.85;
const SCALE_MAX = 1.15;

export const RESERVED_BOUNDARY = 150; // 07 §3.2 R8, verbatim
export const MAX_RESIDENT_PROTOTYPES = 18; // 07 §3.4, verbatim
export const PLACEMENT_TRIES = 16; // 07 §3.2 R8, verbatim ("sixteen tries")
export const GATE_EXCLUSION_RADIUS = 2.0; // 07 §3.2 R8, verbatim
export const TERRACE_INSET = 2.0; // 07 §3.2 R5, verbatim ("inset 2.0 m from the cell boundary")

export const RIDGE_WALL_THICKNESS = 2.0; // 07 §3.2 R9, verbatim
export const ASH_BERM_WIDTH = 6.0; // 07 §3.2 R9, verbatim
export const ASH_BERM_TOP = 3.0; // 07 §3.2 R9, verbatim
export const SILHOUETTE_RING_MIN = 62; // 07 §3.2 R9, verbatim
export const SILHOUETTE_RING_MAX = 78; // 07 §3.2 R9, verbatim
export const SILHOUETTE_SPIRE_COUNT = 44; // 07 §3.2 R9, verbatim ("44 instances of far_spire")
// `far_ridge` (G9's OTHER prototype) has no instance count anywhere in the
// read spec — ASSIGNED. R9's own table says "Two draw calls for the whole
// ring", and §9.1 lists exactly two G9 prototypes (`far_spire`, `far_ridge`)
// — the only reading that reconciles "44 instances of far_spire" (one draw
// call) with "two draw calls for the whole ring" is that `far_ridge` fills
// the second one. Count ASSIGNED to half of `far_spire`'s (documented, not
// derived) — see this ticket's report.
export const SILHOUETTE_RIDGE_COUNT = 22;

/** In-bounds 4-neighbours of cell `(cx,cz)`, as `{dir, cx, cz}` — local to
 * this file (ridgewalk.js does not export its own equivalent). */
function neighboursOf(cx, cz) {
  return [
    { dir: 'N', cx, cz: cz + 1 },
    { dir: 'S', cx, cz: cz - 1 },
    { dir: 'E', cx: cx + 1, cz },
    { dir: 'W', cx: cx - 1, cz },
  ];
}

/** Every gate's centreline as a 2D segment `{x0,z0,x1,z1}`, derived from
 * `layout.gates` (`{a,b,width,offset}`, 07 §3.2 R6) and the two cells'
 * centres (`cellCentre`). @param {object} descriptor @param {object[]} gates */
function buildGateSegments(descriptor, gates) {
  const half = descriptor.cellSize / 2;
  const segs = [];
  for (const g of gates) {
    const ca = cellOf(g.a);
    const cb = cellOf(g.b);
    const pa = cellCentre(descriptor, ca.cx, ca.cz);
    const pb = cellCentre(descriptor, cb.cx, cb.cz);
    if (ca.cz === cb.cz) {
      // East-west adjacency: shared edge is vertical (fixed x), gate spans z.
      const edgeX = (pa.x + pb.x) / 2;
      const midZ = pa.z; // same for both, same row
      segs.push({ x0: edgeX, z0: midZ + g.offset - g.width / 2, x1: edgeX, z1: midZ + g.offset + g.width / 2 });
    } else {
      // North-south adjacency: shared edge is horizontal (fixed z), gate spans x.
      const edgeZ = (pa.z + pb.z) / 2;
      const midX = pa.x;
      segs.push({ x0: midX + g.offset - g.width / 2, z0: edgeZ, x1: midX + g.offset + g.width / 2, z1: edgeZ });
    }
  }
  return segs;
}

/** Point-to-segment distance (2D), `Math.sqrt`, never `Math.hypot` (rule:
 * "Math.hypot allocates" — measured 5.73 B/call vs 0.34 for
 * `Math.sqrt(x*x+z*z)`, this ticket's own performance rule). */
function pointSegmentDist(px, pz, x0, z0, x1, z1) {
  const ex = x1 - x0, ez = z1 - z0;
  const wx = px - x0, wz = pz - z0;
  const lenSq = ex * ex + ez * ez;
  let t = lenSq > 0 ? (wx * ex + wz * ez) / lenSq : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const nx = x0 + ex * t, nz = z0 + ez * t;
  const dx = px - nx, dz = pz - nz;
  return Math.sqrt(dx * dx + dz * dz);
}

function nearestGateDist(px, pz, gateSegs) {
  let best = Infinity;
  for (let i = 0; i < gateSegs.length; i++) {
    const s = gateSegs[i];
    const d = pointSegmentDist(px, pz, s.x0, s.z0, s.x1, s.z1);
    if (d < best) best = d;
  }
  return best;
}

/** Approximate entry/exit spawnDeny discs — R10 (chests/entries) has not run
 * yet at this pipeline stage (R8/R9 run BETWEEN R7 and R10, per this
 * ticket's brief), so the real, jittered entry/portal positions do not
 * exist. Approximated from the deterministic part of R10's own formula
 * (cell centre + the fixed ±8 m offset, dropping R10's own small
 * `S1.range(-4,4)` jitter, which is not yet drawn) using
 * `src/world/raster.js`'s own `ENTRY_SPAWN_DENY_RADIUS` (8.0 m) — reused,
 * not reinvented. Documented approximation; see this ticket's report. */
function buildApproxSpawnDeny(layout, descriptor) {
  const entryPos = cellOf(layout.entryCell);
  const entryCentre = cellCentre(descriptor, entryPos.cx, entryPos.cz);
  const exitPos = cellOf(layout.exitCell);
  const exitCentre = cellCentre(descriptor, exitPos.cx, exitPos.cz);
  return [
    { x: entryCentre.x, z: entryCentre.z - 8.0, radius: 8.0 },
    { x: exitCentre.x, z: exitCentre.z + 8.0, radius: 8.0 },
  ];
}

function insideAnyDisc(px, pz, discs) {
  for (let i = 0; i < discs.length; i++) {
    const d = discs[i];
    const dx = px - d.x, dz = pz - d.z;
    if (Math.sqrt(dx * dx + dz * dz) < d.radius) return true;
  }
  return false;
}

/**
 * 07 §3.2 R8 — per-cell dressing. Draws from `streams.S2` (position, proto,
 * facing, scale) and `streams.S6` (tint seed), continuing whatever state
 * those streams are already in (never a fresh fork — O-98). Runs over
 * `layout.connected` in the SAME canonical order R7 used (spine then
 * branch), per this file's own header.
 *
 * Ordering decision, documented: R8's own pseudocode references
 * `protoSpec.minSpacing` INSIDE the position tries loop, before the line
 * that (textually) draws `proto`. That is only satisfiable if the
 * prototype draw happens FIRST, so this implementation draws `proto` (one
 * `S2.pick`) before the position search, then position (up to 16 tries),
 * then `facing`/`scale` (S2), then `tintSeed` (S6) — seeI this ticket's
 * report for the full reasoning.
 *
 * @param {object} layout `generateRidgewalkLayout`'s return value.
 * @param {object} descriptor a `ZoneDescriptor` (`ashen_wastes`).
 * @param {{S1: import('../../core/rng.js').Rng, S2: import('../../core/rng.js').Rng, S6: import('../../core/rng.js').Rng}} streams
 * @returns {{props: object[], attempted: number, placedRaw: number, protoCapFired: boolean, droppedPrototypes: string[], rejectionStats: {terraceInset: number, spacing: number, gate: number, spawnDeny: number, accepted: number}}}
 */
export function runR8Dressing(layout, descriptor, streams) {
  const { S2, S6 } = streams;
  const gateSegs = buildGateSegments(descriptor, layout.gates);
  const spawnDenyDiscs = buildApproxSpawnDeny(layout, descriptor);

  const placed = [];
  let placedSoFar = 0;
  let attempted = 0;
  const cellsTotal = layout.connected.length;
  // Diagnostic-only counters (D-79 request, coordinator round 2) — a tally
  // of WHICH of R8's four reject clauses fired on a given try, mutually
  // exclusive per try (the first clause that fails is the one counted; a
  // try that clears every clause is `accepted`). Additive, read-only
  // reporting — nothing here changes an accept/reject decision or the
  // stream draws, so it cannot itself affect determinism or the placed set.
  const rejectionStats = { terraceInset: 0, gate: 0, spawnDeny: 0, spacing: 0, accepted: 0 };

  for (let idx = 0; idx < layout.connected.length; idx++) {
    const cell = layout.connected[idx];
    const archetype = layout.archetypeOf[cell];
    const protoTable = ARCHETYPE_PROTO_TABLE[archetype];
    const archetypeProps = ARCHETYPE_TABLE[archetype].props;
    const cellsLeftToDress = cellsTotal - idx;
    const remaining = descriptor.propBudget - placedSoFar - RESERVED_BOUNDARY;
    const quota = Math.max(0, Math.min(archetypeProps, Math.floor(remaining / cellsLeftToDress)));

    const { cx, cz } = cellOf(cell);
    const centre = cellCentre(descriptor, cx, cz);
    const cellMinX = centre.x - descriptor.cellSize / 2;
    const cellMinZ = centre.z - descriptor.cellSize / 2;
    const elevation = layout.elevationOf[cell];
    const insetMax = descriptor.cellSize / 2 - TERRACE_INSET; // 10, for a terraced cell

    for (let i = 0; i < quota; i++) {
      const protoId = S2.pick(protoTable);
      const protoSpec = PROTOTYPE_CATALOG[protoId];

      let accepted = null;
      for (let t = 0; t < PLACEMENT_TRIES; t++) {
        attempted++;
        const px = cellMinX + S2.range(1.5, 22.5);
        const pz = cellMinZ + S2.range(1.5, 22.5);

        // Clause order below matches 07 §3.2 R8's own pseudocode literally:
        // walkable(p), then minSpacing, then gate centreline, then
        // spawnDeny — kept in THIS order (not the order this file's first
        // pass used) so the diagnostic counts below attribute each
        // rejected try to the SAME clause the spec lists first, not an
        // arbitrary implementation order (round 2 / D-79 request — see this
        // ticket's report). The four checks are a pure AND (a try is
        // accepted only if all four pass), so reordering them changes
        // nothing about WHICH tries are accepted or the RNG draws already
        // taken above — only which counter a rejected try increments.
        if (elevation !== 0) {
          // "walkable(p)" — this file's own proxy for it (see the file
          // header): a terraced cell's own 2.0 m terrace-wall margin.
          if (Math.abs(px - centre.x) > insetMax || Math.abs(pz - centre.z) > insetMax) {
            rejectionStats.terraceInset++;
            continue;
          }
        }

        let nearestPropDist = Infinity;
        for (let p = 0; p < placed.length; p++) {
          const dx = px - placed[p].x, dz = pz - placed[p].z;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d < nearestPropDist) nearestPropDist = d;
        }
        if (nearestPropDist < protoSpec.spacing) {
          rejectionStats.spacing++;
          continue;
        }

        if (nearestGateDist(px, pz, gateSegs) < GATE_EXCLUSION_RADIUS) {
          rejectionStats.gate++;
          continue;
        }
        if (insideAnyDisc(px, pz, spawnDenyDiscs)) {
          rejectionStats.spawnDeny++;
          continue;
        }

        rejectionStats.accepted++;
        accepted = { x: px, z: pz };
        break;
      }
      if (!accepted) continue; // 16 tries exhausted — not placed, reported, no retry (07 §3.2 R8's own callout)

      const facing = S2.range(0, Math.PI * 2);
      const scale = S2.range(SCALE_MIN, SCALE_MAX);
      const tintSeed = S6.u32();
      placed.push({ x: accepted.x, z: accepted.z, cell, archetype, protoId, facing, scale, tintSeed, elevation });
      placedSoFar++;
    }
  }

  // 07 §3.4 PROTO_CAP — drop the least-used resident prototype until at
  // most 18 remain. SIMPLIFIED from the spec's own "redistributes its
  // quota to the next-heaviest prototype" (re-running the weighted draw
  // sequence to redistribute would require re-deriving S2's exact draw
  // order — out of this ticket's time budget; see this ticket's report).
  // This implementation instead REMOVES the dropped prototype's instances
  // outright and reports it — `protoCapFired`/`droppedPrototypes` below —
  // rather than silently reassigning them, so the deviation is visible in
  // both the returned data and the prop-count report.
  const counts = new Map();
  for (const p of placed) counts.set(p.protoId, (counts.get(p.protoId) || 0) + 1);
  const droppedPrototypes = [];
  while (counts.size > MAX_RESIDENT_PROTOTYPES) {
    let leastId = null;
    let leastCount = Infinity;
    for (const [id, c] of counts) {
      if (c < leastCount) { leastCount = c; leastId = id; }
    }
    counts.delete(leastId);
    droppedPrototypes.push(leastId);
  }
  const protoCapFired = droppedPrototypes.length > 0;
  const props = protoCapFired ? placed.filter((p) => !droppedPrototypes.includes(p.protoId)) : placed;

  return { props, attempted, placedRaw: placed.length, protoCapFired, droppedPrototypes, rejectionStats };
}

/**
 * 07 §3.2 R9 — boundary treatment. Ridge wall + ash berm are derived from
 * every `connected`-to-void / `connected`-to-outside edge (never a
 * `connected`-to-`connected` edge — those always carry a gate, R6). The
 * silhouette ring draws from `streams.S2` (07 §3.2 R9 names both S1 and S2
 * for this stage; wall `topY`/jitter are S1, the ring is S2 — matching the
 * table's own "(S1, S2)" heading literally: S1 for the near layer, S2 for
 * the far one).
 *
 * `far_ridge` instance count is this file's own ASSIGNED decision — see
 * `SILHOUETTE_RIDGE_COUNT`'s own comment.
 *
 * @param {object} layout @param {object} descriptor
 * @param {{S1: import('../../core/rng.js').Rng, S2: import('../../core/rng.js').Rng}} streams
 * @returns {{ridgeWall: object[], berm: object[], silhouette: object[]}}
 */
export function runR9Boundary(layout, descriptor, streams) {
  const { S1, S2 } = streams;
  const half = descriptor.cellSize / 2;
  const ridgeWall = [];
  const berm = [];
  let wallId = 0;

  for (const cell of layout.connected) {
    const { cx, cz } = cellOf(cell);
    const centre = cellCentre(descriptor, cx, cz);
    const elevation = layout.elevationOf[cell];

    for (const n of neighboursOf(cx, cz)) {
      const outOfGrid = n.cx < 0 || n.cx > GRID_DIM - 1 || n.cz < 0 || n.cz > GRID_DIM - 1;
      const neighbourConnected = !outOfGrid && layout.connectedFlag[cellIndex(n.cx, n.cz)];
      if (!outOfGrid && neighbourConnected) continue; // gated edge (R6) — no wall

      const topY = S1.range(4.5, 7.5);
      const jitter = S1.range(-0.8, 0.8);
      const outward = n.dir === 'N' || n.dir === 'E' ? 1 : -1;

      let x, z, halfW, halfL;
      if (n.dir === 'N' || n.dir === 'S') {
        x = centre.x;
        z = centre.z + outward * half + jitter;
        halfW = half;
        halfL = RIDGE_WALL_THICKNESS / 2;
      } else {
        x = centre.x + outward * half + jitter;
        z = centre.z;
        halfW = RIDGE_WALL_THICKNESS / 2;
        halfL = half;
      }

      ridgeWall.push({
        id: wallId,
        kind: 'box',
        x, z,
        y: elevation,
        height: topY,
        halfW, halfL,
        facing: 0,
        blocksNav: true,
        blocksSight: true,
        surface: 'stone',
        destructible: false,
      });

      // Ash berm — same edge, pushed further outward by half the wall's own
      // thickness plus half the berm's own width; purely visual (no
      // Footprint at all — "outside the nav grid entirely", 07 §3.2 R9).
      const bermOffset = RIDGE_WALL_THICKNESS / 2 + ASH_BERM_WIDTH / 2;
      let bx = x, bz = z, bHalfW = halfW, bHalfL = halfL;
      if (n.dir === 'N' || n.dir === 'S') {
        bz = centre.z + outward * (half + bermOffset);
        bHalfL = ASH_BERM_WIDTH / 2;
      } else {
        bx = centre.x + outward * (half + bermOffset);
        bHalfW = ASH_BERM_WIDTH / 2;
      }
      berm.push({ x: bx, z: bz, halfW: bHalfW, halfL: bHalfL, topY: ASH_BERM_TOP, wallId });

      wallId++;
    }
  }

  const silhouette = [];
  for (let i = 0; i < SILHOUETTE_SPIRE_COUNT; i++) {
    const r = S2.range(SILHOUETTE_RING_MIN, SILHOUETTE_RING_MAX);
    const theta = S2.range(0, Math.PI * 2);
    silhouette.push({ protoId: 'far_spire', x: r * Math.cos(theta), z: r * Math.sin(theta), topY: S2.range(14, 26), facing: S2.range(0, Math.PI * 2) });
  }
  for (let i = 0; i < SILHOUETTE_RIDGE_COUNT; i++) {
    const r = S2.range(SILHOUETTE_RING_MIN, SILHOUETTE_RING_MAX);
    const theta = S2.range(0, Math.PI * 2);
    silhouette.push({ protoId: 'far_ridge', x: r * Math.cos(theta), z: r * Math.sin(theta), topY: S2.range(14, 26), facing: S2.range(0, Math.PI * 2) });
  }

  return { ridgeWall, berm, silhouette };
}

/**
 * `props` (R8, `block:true` only) + `ridgeWall` (R9) -> plain `Footprint`
 * records, `02-api-contracts.md` §4 shape (O-35: `blocksNav`/`blocksSight`,
 * never `navBlock`; `y`/`height`, never `baseY`/`topY`). Ash berm and the
 * silhouette ring never emit a Footprint (purely visual — R9's own text).
 * @param {object[]} props @param {object[]} ridgeWall @returns {object[]}
 */
export function toFootprints(props, ridgeWall) {
  const out = ridgeWall.slice();
  let id = ridgeWall.length;
  for (const p of props) {
    const spec = PROTOTYPE_CATALOG[p.protoId];
    if (!spec.block) continue;
    out.push({
      id: id++,
      kind: 'cylinder',
      x: p.x,
      z: p.z,
      y: p.elevation,
      height: spec.topY,
      radius: spec.spacing / 2,
      facing: p.facing,
      blocksNav: true,
      blocksSight: spec.topY > 1.5,
      surface: PROP_SURFACE[p.protoId] || 'stone',
      destructible: !!spec.destructible,
    });
  }
  return out;
}

/**
 * Groups `props` + `ridgeWall` + `silhouette` into one InstancedMesh plan
 * per distinct prototype id — `07` §3.4's `worldPropDrawCalls = |union of
 * prototypes|`. `src/world/build/wastes.js` consumes this directly.
 * @returns {{protoId: string, group: string, tris: number, instances: {x:number,z:number,y:number,facing:number,scale:number,topY?:number}[]}[]}
 */
export function buildInstancingPlan(props, ridgeWall, silhouette) {
  const byProto = new Map();
  function bucket(protoId, group, tris) {
    let b = byProto.get(protoId);
    if (!b) {
      b = { protoId, group, tris, instances: [] };
      byProto.set(protoId, b);
    }
    return b;
  }

  for (const p of props) {
    const spec = PROTOTYPE_CATALOG[p.protoId];
    bucket(p.protoId, spec.group, spec.tris).instances.push({ x: p.x, z: p.z, y: p.elevation, facing: p.facing, scale: p.scale, topY: spec.topY });
  }
  for (const w of ridgeWall) {
    bucket('ridge_slab', '_boundary', 12).instances.push({ x: w.x, z: w.z, y: w.y, facing: w.facing, scale: 1, halfW: w.halfW, halfL: w.halfL, topY: w.height });
  }
  for (const s of silhouette) {
    const spec = PROTOTYPE_CATALOG[s.protoId];
    bucket(s.protoId, spec.group, spec.tris).instances.push({ x: s.x, z: s.z, y: 0, facing: s.facing, scale: 1, topY: s.topY });
  }

  return Array.from(byProto.values());
}
