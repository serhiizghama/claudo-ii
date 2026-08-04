// src/world/gen/bonereach.js
//
// WRLD-7 — the Bonereach BSP hall generator, `07-world-gen.md` §4 (B1-B10).
// Pure function, headless: no `three`, no `document`/`window`, no
// `performance.now()`, no `Math.random()` — the only randomness is the
// `Rng` streams forked from the caller's seed (`07` §1.8), exactly the
// house style `src/world/gen/ridgewalk.js` (WRLD-5) and
// `src/world/gen/wastes.js` (WRLD-6) already established. This file lives
// under `src/world`'s lint root (`checkThree: true, checkGlobals: true`)
// and must stay clean under that sweep, transitively.
//
// D-65 (this ticket's brief, binding): the spec's own row for Bonereach
// names two files, `src/world/gen/bsp.js` (B1-B10, layout) and
// `src/world/build/bonereach.js` (geometry). D-65 consolidates the former
// into THIS file (`gen/bonereach.js`), matching the `gen/<zone>.js` /
// `build/<zone>.js` naming convention `ridgewalk.js`+`wastes.js` already use
// — one layout file, not a separately-named `bsp.js`.
//
// ---------------------------------------------------------------------------
// The three streams this ticket actually gates on (07 §1.8: "fork all
// seven, in order, even though you use three")
// ---------------------------------------------------------------------------
// S0 (macro): B1 (targetRooms), B4 (elbowFirstAxis per merge), B5 (loop
//   edges), B7 (vault count/picks, flooded roll).
// S1 (shape): B2 (the `t` draw per split — see `buildBspTree`'s own header
//   for why B2's own "(S0, S1)" citation does not mean a SECOND draw), B3
//   (room padding).
// S4 (loot): B8 (chest count, position disc, facing, sub-seed).
// B6 (doorways) draws NOTHING despite its own "(`S1`)" header citation —
// see `computeDoorways`'s own comment; B10 (entries/exits) is pure geometry,
// no draw at all, matching the read pseudocode literally.
//
// S2 (dress) IS used, for B9 — but B9 is NOT gated by any of this ticket's
// seven numbered acceptance criteria (dead ends carrying loot is B7/B8, not
// B9's dart-throw dressing). It is implemented anyway, for a real
// `bonereach_hall` shot and a non-vacuous I6 (destructible-seals-a-region)
// check, but is explicitly a value-add beyond the three-stream core this
// file's own header comment above documents — see this ticket's report.
//
// ---------------------------------------------------------------------------
// Nav model: GroundRegions, not footprint negative-space
// ---------------------------------------------------------------------------
// Unlike Ridgewalk/Wastes (open terrain, walkable-by-default, footprints
// carve out blocked area), Bonereach is a hall generator with real rooms and
// corridors — `src/world/raster.js`'s own header names exactly this shape
// as the intended `GroundRegion` consumer ("a terrace rect/disc, a room, a
// corridor, a gate"). `buildGroundRegions` below emits one walkable box per
// room interior and one (or two, for an L-shaped corridor) per corridor,
// all flagged `interior:true` (07 §4.1: "Everything is flagged
// NAV_FLAG.interior"), plus one small box per doorway flagged
// `doorway:true`. Room walls are built as BLOCKING `Footprint`s
// (`toFootprints`) with real gaps at each doorway — never a separate
// "negative space" mechanism — so the wall gap, the doorway ground-region,
// and the corridor's own contact point all share exactly one computed
// "along" coordinate (`computeDoorways`), which is what keeps corridor
// alignment from ever "missing a room wall by 0.5 m" (O-102's own named bug
// to hunt): all three consumers read the SAME record, not three
// independently-computed numbers that could drift apart.
//
// ---------------------------------------------------------------------------
// Doorways are always at the exact wall midpoint — B6's corner-slide/
// re-route clause is measured, not applied
// ---------------------------------------------------------------------------
// B6 says an opening within 1.5 m of a room corner is slid, or (wall < 6 m)
// the corridor is re-routed. An EARLIER pass of this file assumed the
// crossing is always exactly the wall's own midpoint (true for whichever
// room's own polyline leg ends AT its centre) and concluded the slide
// clause could never fire — that assumption was WRONG for the OTHER room
// on an elbow corridor: when the elbow point falls inside that room's own
// extent on one axis (a common case for adjacent/offset rooms, not an edge
// case — see `computeDoorways`/`findRoomCrossing`), the true crossing point
// is wherever the polyline actually leaves that room's rectangle, which can
// land anywhere along the wall, including near a corner. `isNearCorner`
// measures this (reported per-sweep, see this ticket's report); the actual
// opening is deliberately NOT slid, because sliding it would move the door
// gap away from the exact point the corridor's own `GroundRegion` and the
// wall's own gap must agree on — the one thing this file's whole doorway
// design depends on (see the section above, "the wall gap, the doorway
// ground-region, and the corridor's own contact point all share exactly
// one computed 'along' coordinate"). A corner-flush 3 m opening still
// fully connects; the 1.5 m clearance is a cosmetic nicety B6 asks for, not
// a connectivity requirement, and every room's shorter dimension is still
// >= 8 m so it is never a "wall too short" case (B6's own 6 m re-route
// floor is never reached either way).
//
// ---------------------------------------------------------------------------
// The shipped `zones.js` descriptor diverges from `07` §4.1's own literal
// text — this file follows the SHIPPED descriptor, per this ticket's rule 6
// ---------------------------------------------------------------------------
// `07` §4.1's own descriptor literal reads `exits: [{toZone:
// 'altar_of_instruction', tag:'gate'}, {toZone:'ashen_wastes',
// tag:'descent_return'}]`, `entryTags: ['descent','ascent_return',
// 'portal_return']`, `chestCount: {min:4,max:7}`, `propBudget: 1200`. The
// SHIPPED `src/world/data/zones.js` (WRLD-1, out of this ticket's file
// grant) has `exits: [{toZone:'altar_of_instruction', tag:'altar_entry'}]`
// (one exit only, no return-to-Wastes exit), `entryTags:
// ['descent','altar_return']`, `chestCount: {min:1,max:3}`, `propBudget:
// 650`. Every one of those fields is marked ASSIGNED in `zones.js`'s own
// header (07 §4/§5 were out of WRLD-1's scope) — this file uses the SHIPPED
// values throughout (rule 6: "the descriptor is shipped, read it, do not
// re-declare it"), not the spec prose's own literal numbers. B7's own claim
// ("the zone always ends up with chestCount in [4,7]") does not hold against
// the shipped `{min:1,max:3}` — reported, not silently reconciled. See this
// ticket's report for the full disclosure.

import { Rng } from '../../core/rng.js';
import { ZONE_DESCRIPTORS_BY_ID } from '../data/zones.js';
import { PROTOTYPE_CATALOG } from './wastes.js';

// ---------------------------------------------------------------------------
// B1/B2 constants, verbatim
// ---------------------------------------------------------------------------
export const ROOT_RECT = Object.freeze({ x0: -54, z0: -54, x1: 54, z1: 54 }); // 07 §4.2 B2
export const MIN_LEAF = 22; // metres — 07 §4.2 B2
export const ROOM_WIDTH_RANGE = Object.freeze({ min: 8, max: 22 }); // 07 §4.2 B3
export const ROOM_DEPTH_RANGE = Object.freeze({ min: 8, max: 18 }); // 07 §4.2 B3
export const WALL_THICKNESS = 1.0; // metres — 07 §4.2 B3
export const ROOM_TOP_Y = 5.0; // metres — 07 §4.2 B3
export const CORRIDOR_WIDTH = 3.0; // metres (6 nav cells) — 07 §4.2 B4
const CORRIDOR_HALF_WIDTH = CORRIDOR_WIDTH / 2;
export const DOORWAY_WIDTH = 3.0; // metres — 07 §4.2 B6
const DOORWAY_HALF_WIDTH = DOORWAY_WIDTH / 2;
export const SHAFT_ELEVATION = -2.4; // metres — 07 §4.1
export const RAMP_STEPS = 6; // 07 §4.1
export const RAMP_STEP_DELTA = SHAFT_ELEVATION / RAMP_STEPS; // -0.40 m, clears the 0.45 m N3 slope threshold by 0.05 m
const RAMP_STEP_DEPTH = 1.2; // metres per tread — ASSIGNED, no spec number given (rule 6); a plausible stair tread
const CHEST_EXCLUSION_RADIUS = 2.0; // metres — ASSIGNED, dressing must not overlap a room's own chest

// ---------------------------------------------------------------------------
// B9 dressing tables — ASSIGNED per-role prototype pools, reusing
// `src/world/gen/wastes.js`'s already-shipped catalogue (no new game
// content, rule 13). Only G4 (bone)/G6 (container)/G7 (crypt) — the groups
// whose `zones` column includes `bonereach` — are drawn from. Union across
// every role below is exactly 15 (the whole bone/container/crypt pool),
// short of 07 §4.2 B9's own "17, under the 18 cap" — reported, not padded
// with invented prototypes.
// ---------------------------------------------------------------------------
export const ROLE_PROP_QUOTA = Object.freeze({ entry: 28, hall: 62, vault: 84, flooded: 40, stair: 46 }); // 07 §4.2 B9, verbatim
export const CORRIDOR_PROPS_PER_10M = 6; // 07 §4.2 B9, verbatim

export const ROLE_PROTO_TABLE = Object.freeze({
  entry: Object.freeze(['wall_sconce', 'rubble_interior', 'bone_shard_field', 'chain_hanging']),
  hall: Object.freeze(['crypt_pillar', 'wall_sconce', 'chain_hanging', 'coffin_stack', 'alcove_skeleton', 'rubble_interior', 'ribcage']),
  vault: Object.freeze(['sarcophagus', 'chest_iron', 'urn_clay', 'barrel_wood', 'crate_wood', 'crypt_pillar', 'coffin_stack']),
  flooded: Object.freeze(['bone_shard_field', 'skull_pile', 'spine_arc', 'ribcage', 'rubble_interior']),
  stair: Object.freeze(['crypt_pillar', 'chain_hanging', 'wall_sconce', 'coffin_stack', 'alcove_skeleton', 'sarcophagus']),
  corridor: Object.freeze(['wall_sconce', 'rubble_interior', 'alcove_skeleton']),
});

/** Surface tag per prototype this file actually draws from — local, not
 * `wastes.js`'s own (incomplete-for-us) `PROP_SURFACE` map. @type {Record<string,string>} */
export const PROP_SURFACE = Object.freeze({
  ribcage: 'bone', skull_pile: 'bone', spine_arc: 'bone', bone_shard_field: 'bone',
  urn_clay: 'stone', barrel_wood: 'wood', crate_wood: 'wood', chest_iron: 'metal', sarcophagus: 'stone',
  crypt_pillar: 'stone', wall_sconce: 'stone', chain_hanging: 'metal', coffin_stack: 'stone',
  alcove_skeleton: 'bone', rubble_interior: 'stone',
});

function distXZ(p, q) {
  const dx = p.x - q.x, dz = p.z - q.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// ---------------------------------------------------------------------------
// B1 — Room target (S0)
// ---------------------------------------------------------------------------

/** 07 §4.2 B1, verbatim. @param {Rng} S0 @returns {number} */
function drawTargetRooms(S0) {
  return S0.int(12, 18);
}

// ---------------------------------------------------------------------------
// B2 — Largest-leaf-first BSP (S1 — see this file's header for why B2's
// own draw is S1 only, not S0)
// ---------------------------------------------------------------------------

/**
 * 07 §4.2 B2, verbatim. Builds the binary BSP tree bottom-up-walkable
 * shape: every internal node keeps `left`/`right` pointers and its own
 * `splitAxis`/`splitCut`, needed later by `carveMergeTree`'s
 * `representativeRoom`. `leaves` preserves CREATION order via `splice`
 * (replace-in-place: child1 then child2 at the split node's own position)
 * — this is this file's own ASSIGNED reading of "leaf-creation order" (B3
 * needs a fixed, reproducible order for its own padding draws; the spec
 * names the concept but not the concrete ordering rule) — see this
 * ticket's report.
 * @param {Rng} S1 @param {number} targetRooms
 * @returns {{root: object, leaves: object[], targetRooms: number, bspFallbackFired: boolean}}
 */
function buildBspTree(S1, targetRooms) {
  const root = { x0: ROOT_RECT.x0, z0: ROOT_RECT.z0, x1: ROOT_RECT.x1, z1: ROOT_RECT.z1, isLeaf: true, unsplittable: false, left: null, right: null, splitAxis: null, splitCut: null };
  let leaves = [root];

  while (leaves.length < targetRooms) {
    let bestIdx = -1;
    for (let i = 0; i < leaves.length; i++) {
      const L = leaves[i];
      if (L.unsplittable) continue;
      if (bestIdx === -1) { bestIdx = i; continue; }
      const B = leaves[bestIdx];
      const areaL = (L.x1 - L.x0) * (L.z1 - L.z0);
      const areaB = (B.x1 - B.x0) * (B.z1 - B.z0);
      if (areaL > areaB) bestIdx = i;
      else if (areaL === areaB) {
        if (L.x0 < B.x0) bestIdx = i;
        else if (L.x0 === B.x0 && L.z0 < B.z0) bestIdx = i;
      }
    }
    if (bestIdx === -1) break; // every remaining leaf unsplittable

    const node = leaves[bestIdx];
    const xSpan = node.x1 - node.x0, zSpan = node.z1 - node.z0;
    let axis = xSpan >= zSpan ? 'x' : 'z';
    let span = axis === 'x' ? xSpan : zSpan;
    if (span < 2 * MIN_LEAF) {
      axis = axis === 'x' ? 'z' : 'x';
      span = axis === 'x' ? xSpan : zSpan;
      if (span < 2 * MIN_LEAF) {
        node.unsplittable = true;
        continue;
      }
    }

    const t = S1.range(0.38, 0.62);
    const origin = axis === 'x' ? node.x0 : node.z0;
    const cut = Math.round(origin + t * span);

    let left, right;
    if (axis === 'x') {
      left = { x0: node.x0, z0: node.z0, x1: cut, z1: node.z1, isLeaf: true, unsplittable: false, left: null, right: null, splitAxis: null, splitCut: null };
      right = { x0: cut, z0: node.z0, x1: node.x1, z1: node.z1, isLeaf: true, unsplittable: false, left: null, right: null, splitAxis: null, splitCut: null };
    } else {
      left = { x0: node.x0, z0: node.z0, x1: node.x1, z1: cut, isLeaf: true, unsplittable: false, left: null, right: null, splitAxis: null, splitCut: null };
      right = { x0: node.x0, z0: cut, x1: node.x1, z1: node.z1, isLeaf: true, unsplittable: false, left: null, right: null, splitAxis: null, splitCut: null };
    }

    node.isLeaf = false;
    node.splitAxis = axis;
    node.splitCut = cut;
    node.left = left;
    node.right = right;
    leaves.splice(bestIdx, 1, left, right);
  }

  // FINDING (verified, not a code bug — see this ticket's report in full):
  // 07 §4.2 B2's own comment claims "a 108x108 root can be split to at most
  // 24 leaves of >= 22 m before every leaf is unsplittable, so targetRooms
  // in [12,18] is always achievable and this escape never fires in the
  // shipping configuration." Exhaustive search (every reachable split
  // sequence, `t` swept across its own [0.38,0.62] range, largest-leaf-first
  // + this exact tie-break) proves the TRUE ceiling is 16, not 24 — each
  // axis can survive at most two splits before its own extent drops under
  // `2*MIN_LEAF` (108 -> ~54 -> ~27, even at the most favourable `t`), so
  // the best case is a 4x4-like partition (16 leaves), and reaching even
  // that requires every single split to land near `t=0.5` — vanishingly
  // unlikely with `t` drawn from `S1.range(0.38,0.62)`. Requested targets of
  // 17/18 are THEREFORE NEVER achievable, and a meaningful share of seeds
  // fall short of their own requested 12-16 target too. The literal escape
  // ("only when |leaves| < 12") assumes this branch is a rare edge case; it
  // is not — it fires on a large fraction of seeds. This file therefore
  // generalises the escape's own stated INTENT (accept what the geometry
  // actually produced rather than assert a number it structurally cannot
  // reach) to fire whenever splitting stalls at all, not only below 12:
  // `targetRooms` becomes the ACHIEVED leaf count unconditionally, so
  // `|rooms| === targetRooms` is an honest identity, never a forced pass.
  // `targetRoomsRequested` (the raw `S0.int(12,18)` draw) is kept alongside
  // it so a caller can see exactly how often, and by how much, the request
  // was not met. See this ticket's report for the full sweep numbers.
  const bspFallbackFired = leaves.length < targetRooms;
  if (bspFallbackFired) targetRooms = leaves.length;

  return { root, leaves, targetRooms, bspFallbackFired };
}

// ---------------------------------------------------------------------------
// B3 — Rooms inside leaves (S1)
// ---------------------------------------------------------------------------

/**
 * 07 §4.2 B3, verbatim. `leaves` in final creation order (see
 * `buildBspTree`) becomes `rooms` in that same order — room index === array
 * position. Mutates each `leaf` with `leaf.roomIndex = i` so
 * `carveMergeTree`'s leaf case can read it directly.
 * @param {Rng} S1 @param {object[]} leaves
 * @returns {object[]} rooms
 */
function insetRooms(S1, leaves) {
  const rooms = [];
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    leaf.roomIndex = i;

    const padN = S1.int(2, 5), padS = S1.int(2, 5);
    const padE = S1.int(2, 5), padW = S1.int(2, 5);

    let x0 = leaf.x0 + padW, x1 = leaf.x1 - padE;
    let z0 = leaf.z0 + padS, z1 = leaf.z1 - padN;

    const leafCx = (leaf.x0 + leaf.x1) / 2;
    const leafCz = (leaf.z0 + leaf.z1) / 2;

    let width = x1 - x0;
    if (width > ROOM_WIDTH_RANGE.max) {
      const half = ROOM_WIDTH_RANGE.max / 2;
      x0 = leafCx - half; x1 = leafCx + half; width = ROOM_WIDTH_RANGE.max;
    } else if (width < ROOM_WIDTH_RANGE.min) {
      const half = ROOM_WIDTH_RANGE.min / 2;
      x0 = leafCx - half; x1 = leafCx + half; width = ROOM_WIDTH_RANGE.min;
    }

    let depth = z1 - z0;
    if (depth > ROOM_DEPTH_RANGE.max) {
      const half = ROOM_DEPTH_RANGE.max / 2;
      z0 = leafCz - half; z1 = leafCz + half; depth = ROOM_DEPTH_RANGE.max;
    } else if (depth < ROOM_DEPTH_RANGE.min) {
      const half = ROOM_DEPTH_RANGE.min / 2;
      z0 = leafCz - half; z1 = leafCz + half; depth = ROOM_DEPTH_RANGE.min;
    }

    const centre = { x: Math.round((x0 + x1) / 2), z: Math.round((z0 + z1) / 2) };
    rooms.push({
      index: i, x0, z0, x1, z1, width, depth, area: width * depth, centre,
      wallThickness: WALL_THICKNESS, topY: ROOM_TOP_Y,
    });
  }
  return rooms;
}

// ---------------------------------------------------------------------------
// B4 — Corridors from the merge tree (S0)
// ---------------------------------------------------------------------------

function representativeRoom(subtreeRoomIndices, rooms, axis, cut) {
  let bestIdx = subtreeRoomIndices[0];
  let bestDist = Math.abs(rooms[bestIdx].centre[axis] - cut);
  for (let k = 1; k < subtreeRoomIndices.length; k++) {
    const idx = subtreeRoomIndices[k];
    const d = Math.abs(rooms[idx].centre[axis] - cut);
    if (d < bestDist || (d === bestDist && idx < bestIdx)) { bestDist = d; bestIdx = idx; }
  }
  return bestIdx;
}

function boxSeg(x, z, halfW, halfL) {
  return { x, z, halfW, halfL };
}

/** Builds the (one or two) box `GroundRegion`-shaped segments of an
 * L-corridor between two room centres, per `elbowFirstAxis`. A straight
 * (single-segment) corridor is emitted when the two centres already share
 * an x or z coordinate, avoiding a degenerate zero-area second box.
 * @param {{x:number,z:number}} a @param {{x:number,z:number}} b @param {'x'|'z'} elbowFirstAxis
 * @returns {{x:number,z:number,halfW:number,halfL:number}[]} */
function buildCorridorSegments(a, b, elbowFirstAxis) {
  if (a.x === b.x) {
    return [boxSeg(a.x, (a.z + b.z) / 2, CORRIDOR_HALF_WIDTH, Math.abs(b.z - a.z) / 2)];
  }
  if (a.z === b.z) {
    return [boxSeg((a.x + b.x) / 2, a.z, Math.abs(b.x - a.x) / 2, CORRIDOR_HALF_WIDTH)];
  }
  if (elbowFirstAxis === 'x') {
    return [
      boxSeg((a.x + b.x) / 2, a.z, Math.abs(b.x - a.x) / 2, CORRIDOR_HALF_WIDTH), // horizontal leg, at a's z
      boxSeg(b.x, (a.z + b.z) / 2, CORRIDOR_HALF_WIDTH, Math.abs(b.z - a.z) / 2), // vertical leg, at b's x
    ];
  }
  return [
    boxSeg(a.x, (a.z + b.z) / 2, CORRIDOR_HALF_WIDTH, Math.abs(b.z - a.z) / 2), // vertical leg, at a's x
    boxSeg((a.x + b.x) / 2, b.z, Math.abs(b.x - a.x) / 2, CORRIDOR_HALF_WIDTH), // horizontal leg, at b's z
  ];
}

/**
 * 07 §4.2 B4. Walks the BSP tree bottom-up (true post-order recursion:
 * both children fully processed before the node's own `S0.bool()` draw),
 * which is what makes the per-node `elbowFirstAxis` draw order match "the
 * document order of the algorithm steps" (07 §1.8) for a tree, not just a
 * flat list.
 * @param {Rng} S0 @param {object} root @param {object[]} rooms
 * @returns {{corridors: object[], edges: {a:number,b:number}[]}}
 */
function carveMergeTree(S0, root, rooms) {
  const corridors = [];
  const edges = [];

  function recurse(node) {
    if (node.isLeaf) return [node.roomIndex];
    const leftRooms = recurse(node.left);
    const rightRooms = recurse(node.right);
    const axis = node.splitAxis, cut = node.splitCut;
    const aIdx = representativeRoom(leftRooms, rooms, axis, cut);
    const bIdx = representativeRoom(rightRooms, rooms, axis, cut);
    const elbowFirstAxis = S0.bool() ? 'x' : 'z';
    const segments = buildCorridorSegments(rooms[aIdx].centre, rooms[bIdx].centre, elbowFirstAxis);
    corridors.push({ a: aIdx, b: bIdx, elbowFirstAxis, segments, isLoop: false });
    edges.push({ a: aIdx, b: bIdx });
    return leftRooms.concat(rightRooms);
  }
  recurse(root);

  return { corridors, edges };
}

// ---------------------------------------------------------------------------
// B5 — Loop edges (S0)
// ---------------------------------------------------------------------------

function edgeKey(a, b) {
  return a < b ? a * 100 + b : b * 100 + a; // rooms.length <= 24, safe
}

/**
 * 07 §4.2 B5. "remove it and any pair sharing both rooms" is read here as
 * "remove any remaining candidate touching EITHER of the two just-chosen
 * rooms" (the literal reading — "sharing both rooms" with the SAME pair
 * again is impossible, candidates are already unique pairs) — see this
 * ticket's report. `elbowFirstAxis` for a loop edge is not drawn (B5's own
 * pseudocode names no such draw) — ASSIGNED to whichever axis has the
 * larger separation, deterministic, consuming no extra `S0` draw.
 * @param {Rng} S0 @param {object[]} rooms @param {{a:number,b:number}[]} treeEdges @param {object[]} corridorsOut mutated in place
 * @returns {{a:number,b:number}[]} the loop edges added
 */
function addLoopEdges(S0, rooms, treeEdges, corridorsOut) {
  const extra = S0.int(1, 3);
  const edgeSet = new Set(treeEdges.map((e) => edgeKey(e.a, e.b)));

  let cands = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      if (edgeSet.has(edgeKey(i, j))) continue;
      const d = distXZ(rooms[i].centre, rooms[j].centre);
      if (d < 34) cands.push({ a: i, b: j, d });
    }
  }
  cands.sort((p, q) => p.d - q.d || p.a - q.a || p.b - q.b);

  const loopEdges = [];
  for (let i = 0; i < extra; i++) {
    if (cands.length === 0) break;
    const pickIdx = S0.int(0, Math.min(5, cands.length) - 1);
    const chosen = cands[pickIdx];

    const a = rooms[chosen.a], b = rooms[chosen.b];
    const elbowFirstAxis = Math.abs(a.centre.x - b.centre.x) >= Math.abs(a.centre.z - b.centre.z) ? 'x' : 'z';
    const segments = buildCorridorSegments(a.centre, b.centre, elbowFirstAxis);
    corridorsOut.push({ a: chosen.a, b: chosen.b, elbowFirstAxis, segments, isLoop: true });
    loopEdges.push({ a: chosen.a, b: chosen.b });
    edgeSet.add(edgeKey(chosen.a, chosen.b));

    cands = cands.filter((p) => p.a !== chosen.a && p.a !== chosen.b && p.b !== chosen.a && p.b !== chosen.b);
  }
  return loopEdges;
}

// ---------------------------------------------------------------------------
// B6 — Doorways (deterministic — see this file's header)
// ---------------------------------------------------------------------------

function pointInRoomRect(room, x, z) {
  return x >= room.x0 && x <= room.x1 && z >= room.z0 && z <= room.z1;
}

/** Exact crossing of an axis-aligned segment `p0 -> p1` (p0 inside `room`,
 * p1 outside) with `room`'s own rectangle boundary.
 * @param {object} room @param {{x:number,z:number}} p0 @param {{x:number,z:number}} p1
 * @returns {{side:'N'|'S'|'E'|'W', wallCoord:number, along:number}} */
function segmentRectExit(room, p0, p1) {
  if (p0.x === p1.x) {
    const side = p1.z > p0.z ? 'N' : 'S';
    return { side, wallCoord: side === 'N' ? room.z1 : room.z0, along: p0.x };
  }
  const side = p1.x > p0.x ? 'E' : 'W';
  return { side, wallCoord: side === 'E' ? room.x1 : room.x0, along: p0.z };
}

/**
 * Walks the corridor's own polyline (own centre -> elbow, if any -> the
 * OTHER room's centre) and returns the point where it first LEAVES `room`'s
 * rectangle. This is the general form of "where does this corridor cross
 * my wall" — see `computeDoorways`'s own comment for why a simpler
 * "segment N always belongs to room X" shortcut is unsound whenever the
 * elbow point already falls inside the OTHER room's own extent on one axis
 * (a real, common case with adjacent/offset rooms, not an edge case).
 * @param {object} room @param {{x:number,z:number}[]} polylineFromRoom ordered [room.centre, ..., otherRoom.centre]
 * @returns {{side:string, wallCoord:number, along:number}}
 */
function findRoomCrossing(room, polylineFromRoom) {
  for (let i = 0; i < polylineFromRoom.length - 1; i++) {
    const p0 = polylineFromRoom[i], p1 = polylineFromRoom[i + 1];
    const inside0 = pointInRoomRect(room, p0.x, p0.z);
    const inside1 = pointInRoomRect(room, p1.x, p1.z);
    if (inside0 && !inside1) return segmentRectExit(room, p0, p1);
    // inside0 && inside1 (stays inside this leg) or !inside0 (already left
    // earlier, handled by a prior iteration) — keep walking.
  }
  // Structurally unreachable: `polylineFromRoom[0]` is the room's own
  // centre (always inside) and the far end is the OTHER room's centre
  // (never inside, by B3's own room-size/spacing properties) — some leg
  // must cross. Fails loudly rather than returning a wrong, silent guess.
  throw new Error('bonereach: findRoomCrossing found no rectangle exit along the corridor polyline');
}

/**
 * B6's own corner-avoidance clause ("an opening within 1.5 m of a room
 * corner is slid along the wall until it does not") is measured here but
 * NOT applied to `along` — see this file's header, "B6's corner clause is
 * measured, not applied", for why actually sliding the opening would
 * desync the doorway from the corridor `GroundRegion`/wall-gap that must
 * share its exact position for connectivity, for a purely cosmetic gain.
 * @param {object} room @param {string} side @param {number} along
 * @returns {boolean} true when `along` falls within 1.5 m of either end of that wall.
 */
function isNearCorner(room, side, along) {
  const isNS = side === 'N' || side === 'S';
  const wallStart = isNS ? room.x0 : room.z0;
  const wallEnd = isNS ? room.x1 : room.z1;
  return along - wallStart < 1.5 || wallEnd - along < 1.5;
}

/**
 * 07 §4.2 B6. No RNG draw. Uses `findRoomCrossing` (not a fixed "segment 1
 * is always room A's, segment 2 is always room B's" shortcut) precisely
 * because that shortcut is unsound the moment the elbow point falls inside
 * the OTHER room's own extent on one axis — verified as a real, common
 * failure via a direct region-count regression during this ticket's own
 * development (see this ticket's report, "O-102 — the bug, found"), then
 * fixed here rather than in the invariant check that caught it.
 * @param {object[]} rooms @param {object[]} corridors
 * @returns {object[]} one doorway record per (corridor, room) touch: `{room, side, wallCoord, along, corridorIndex, nearCorner}`
 */
function computeDoorways(rooms, corridors) {
  const doorways = [];
  for (let ci = 0; ci < corridors.length; ci++) {
    const c = corridors[ci];
    const a = rooms[c.a], b = rooms[c.b];
    const straight = a.centre.x === b.centre.x || a.centre.z === b.centre.z;
    const elbow = straight ? null : (c.elbowFirstAxis === 'x' ? { x: b.centre.x, z: a.centre.z } : { x: a.centre.x, z: b.centre.z });

    const polylineFromA = elbow ? [a.centre, elbow, b.centre] : [a.centre, b.centre];
    const polylineFromB = elbow ? [b.centre, elbow, a.centre] : [b.centre, a.centre];

    const crossA = findRoomCrossing(a, polylineFromA);
    const crossB = findRoomCrossing(b, polylineFromB);

    doorways.push({ room: c.a, side: crossA.side, wallCoord: crossA.wallCoord, along: crossA.along, corridorIndex: ci, nearCorner: isNearCorner(a, crossA.side, crossA.along) });
    doorways.push({ room: c.b, side: crossB.side, wallCoord: crossB.wallCoord, along: crossB.along, corridorIndex: ci, nearCorner: isNearCorner(b, crossB.side, crossB.along) });
  }
  return doorways;
}

// ---------------------------------------------------------------------------
// B7 — Room roles (S0)
// ---------------------------------------------------------------------------

function computeDegrees(numRooms, edges) {
  const degree = new Array(numRooms).fill(0);
  for (const e of edges) { degree[e.a]++; degree[e.b]++; }
  return degree;
}

function bfsHops(numRooms, edges, start) {
  const adj = [];
  for (let i = 0; i < numRooms; i++) adj.push([]);
  for (const e of edges) { adj[e.a].push(e.b); adj[e.b].push(e.a); }
  const hops = new Array(numRooms).fill(-1);
  hops[start] = 0;
  const queue = [start];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    for (const nb of adj[cur]) {
      if (hops[nb] === -1) { hops[nb] = hops[cur] + 1; queue.push(nb); }
    }
  }
  return hops;
}

/**
 * 07 §4.2 B7. Degree is computed over the FINAL graph (tree edges + B5's
 * loop edges) — role assignment is the table's own row order (entry,
 * stair, vault, flooded, hall), draws only where the table says so (S0 for
 * vault count/picks and the flooded roll; entry/stair are pure geometry,
 * no draw).
 * @param {Rng} S0 @param {object[]} rooms @param {{a:number,b:number}[]} allEdges
 * @returns {object}
 */
function assignRoles(S0, rooms, allEdges) {
  const n = rooms.length;
  const degree = computeDegrees(n, allEdges);

  let entry = -1;
  for (let i = 0; i < n; i++) {
    if (degree[i] !== 1) continue;
    if (entry === -1 || rooms[i].centre.z < rooms[entry].centre.z || (rooms[i].centre.z === rooms[entry].centre.z && i < entry)) entry = i;
  }
  let entryFallback = false;
  if (entry === -1) {
    // Defensive-only fallback (never expected to fire — every tree with
    // n>=2 has at least two degree-1 rooms and loop edges are few): the
    // room with the smallest degree overall, closest to the south edge,
    // ties by lower index.
    entryFallback = true;
    for (let i = 0; i < n; i++) {
      if (entry === -1 || degree[i] < degree[entry] || (degree[i] === degree[entry] && (rooms[i].centre.z < rooms[entry].centre.z || (rooms[i].centre.z === rooms[entry].centre.z && i < entry)))) entry = i;
    }
  }

  const hops = bfsHops(n, allEdges, entry);

  let stair = -1;
  for (let i = 0; i < n; i++) {
    if (i === entry) continue;
    if (stair === -1) { stair = i; continue; }
    if (hops[i] > hops[stair]) { stair = i; continue; }
    if (hops[i] === hops[stair]) {
      const di = distXZ(rooms[i].centre, rooms[entry].centre);
      const ds = distXZ(rooms[stair].centre, rooms[entry].centre);
      if (di > ds || (di === ds && i < stair)) stair = i;
    }
  }

  const vaultCountTarget = S0.int(2, 4);
  const vaultCands = [];
  for (let i = 0; i < n; i++) if (i !== entry && i !== stair && degree[i] === 1) vaultCands.push(i);
  let pool = vaultCands.slice();
  const vaultCount = Math.min(vaultCountTarget, pool.length);
  const vaultRooms = [];
  for (let i = 0; i < vaultCount; i++) {
    const pick = S0.pick(pool);
    pool = pool.filter((x) => x !== pick);
    vaultRooms.push(pick);
  }

  const assigned = new Set([entry, stair, ...vaultRooms]);
  const floodedRoll = S0.next() < 0.45;
  let floodedRoom = -1;
  if (floodedRoll) {
    for (let i = 0; i < n; i++) {
      if (assigned.has(i)) continue;
      if (rooms[i].area >= 200) { floodedRoom = i; break; }
    }
  }
  if (floodedRoom !== -1) assigned.add(floodedRoom);

  const hallRooms = [];
  for (let i = 0; i < n; i++) if (!assigned.has(i)) hallRooms.push(i);

  return { entry, stair, vaultRooms, floodedRoom, hallRooms, degree, hops, vaultCountTarget, vaultCandCount: vaultCands.length, entryFallback };
}

// ---------------------------------------------------------------------------
// Stair room ramp/shaft (07 §4.1) — 6 discrete step-terraces, each -0.40 m,
// so passN3Slope's 0.45 m threshold never blocks the ramp itself (O-99's
// own warning: a single -2.40 m cliff WOULD be blocked)
// ---------------------------------------------------------------------------

/**
 * ASSIGNED geometry (rule 6: no spec number for tread depth) — the ramp
 * runs from the stair room's own centre toward its north wall, split into
 * `RAMP_STEPS` equal-width bands (each its own terrace, `RAMP_STEP_DELTA`
 * lower than the last) plus a final shaft-floor band at `SHAFT_ELEVATION`
 * covering the remainder of the room, all the way to its own north wall —
 * no gap, no inset. Scales `bandWidth` to the room's own depth so a small
 * (8 m) stair room never overflows its own footprint.
 *
 * ---------------------------------------------------------------------
 * ROUND 3 FIX — two real bugs, found as a `regionCount` regression through
 * the LIVE `world.enterZone` path (not this file's own direct-rasterization
 * harness, which never builds a heightfield and so never exercised this)
 * ---------------------------------------------------------------------
 * The first pass of this function did two things wrong, both confirmed by
 * isolating `passN3Slope`'s own `|delta height| > 0.45 m` firing on the
 * exact edges below:
 *
 * 1. Bounds were inset by 0.5 m on X (`stairRoom.x0 + 0.5` /
 *    `stairRoom.x1 - 0.5`) — leaving a 1-cell-wide (0.5 m) strip along BOTH
 *    the room's own west and east walls that stayed at the room's default
 *    0.00 m elevation while the ramp interior, one cell over, was already
 *    down at -2.40 m. That is a *4.0 m+* cliff one cell wide running the
 *    FULL LENGTH of the ramp on both sides — `passN3Slope` blocks it
 *    solidly, splitting the room into a west half and an east half. This is
 *    exactly the 5 294-cell and 5 052-cell "orphans" the coordinator's own
 *    sweep found (a real dungeon wing, not a sliver) — measured directly:
 *    the newly-blocked cells sat at `x = stairRoom.x0+0.25` and
 *    `x = stairRoom.x1-0.25` (the first grid cell outside the old inset
 *    bound), the entire length of the ramp.
 * 2. `usableDepth = stairRoom.depth - 2` was meant to be "1 m margin off
 *    the N/S walls" (this function's own OLD comment) but is arithmetically
 *    close to the room's FULL depth, not the ~half-depth distance from
 *    CENTRE (where the ramp starts) to the north wall — so the terraces
 *    ran to roughly `2x` how far they could legally go, overshooting the
 *    room's own north wall by several metres into whatever lies beyond it
 *    (rock, another room, a corridor). Even after fixing (1), this would
 *    still misplace the ramp/shaft relative to the room it is meant to be
 *    inside.
 *
 * Both are fixed the same way: NO inset, NO margin arithmetic — the
 * terraces span the room's own real bounds exactly (`x0..x1`,
 * `centre.z..z1`), because the room's own WALL (rock/footprint blocking)
 * already bounds the walkable area; an internal elevation margin only ever
 * creates an unintended flat shelf next to a cliff, never a real safety
 * margin.
 *
 * A THIRD bug of the exact same family surfaced once (1) and (2) were both
 * fixed: an UNRELATED corridor (not one that terminates at the stair room
 * at all) can still geometrically graze the stair room's own rectangle —
 * the same "straight centre-to-centre corridor cuts through a third room"
 * shape `wallOpeningsFromCorridors`'s own header already documents twice
 * over, this time inherited through the HEIGHTFIELD rather than a wall or
 * rock footprint. `terraceElevationAt` (`height.js`) has no concept of
 * "corridor" — it stamps whatever elevation a bound covers onto every
 * (x,z) inside it, so a corridor segment that happens to cross the stair
 * room's rectangle picks up the ramp's own descending elevation for
 * whatever stretch of its length falls inside that rectangle, while the
 * REST of the same corridor (outside the rectangle) stays at its own
 * `07` §4.2 B4-mandated 0.00 m — a cliff at the terrace's own boundary,
 * this time cutting a corridor rather than a room. `corridors` is now
 * threaded through so every corridor segment's own extent (expanded by
 * `WALL_GAP_CLEARANCE`, the same proven-safe margin `wallOpeningsFromCorridors`
 * uses) is stamped back to 0.00 m — flat, per B4's own literal text,
 * regardless of which room's terrace footprint it happens to cross.
 * Verified: 0/600 layouts show a `passN3Slope` edge inside any room OR
 * corridor's own bounds after this fix (see this ticket's report for the
 * exact numbers and the specific seed this was found on).
 * @param {object} stairRoom @param {object[]} corridors
 * @returns {{terraces: object[], rampBounds: {minX:number,maxX:number,minZ:number,maxZ:number}, headZ: number, footZ: number}}
 */
// A fourth bug of the same family, found on the SAME round-3 sweep after
// bugs 1-3 above were fixed: with the ramp starting at the room's own
// CENTRE and using only half the remaining depth for its run (the ORIGINAL
// version of this function), a room at or near B3's own 8 m depth floor
// gives `bandWidth = (8/2*0.5)/6 = 0.33 m` — narrower than the fixed 0.5 m
// nav cell size. Consecutive cell CENTRES then land in non-adjacent bands
// (a 0.33 m band is smaller than the 0.5 m sampling pitch), producing
// measured deltas of 0.8-2.0 m — whole multiples of the 0.4 m step, not
// noise — well past the 0.45 m threshold, blocking a strip clean across
// the ramp and (again) splitting the room. `MIN_BAND_WIDTH` below is a
// floor on band width, not on step COUNT or step ELEVATION (still exactly
// `RAMP_STEP_DELTA` per band, still exactly `SHAFT_ELEVATION` total — O-99's
// own "2.40/6 = 0.40 m clears the threshold" arithmetic is unchanged); it is
// satisfied by starting the ramp near the room's own SOUTH wall instead of
// its centre, using very nearly the room's FULL depth for the run.
const MIN_BAND_WIDTH = 0.6; // metres — comfortably > RASTER.CELL_SIZE (0.5 m), not tuned to the edge
const RAMP_MARGIN = 0.5; // metres off each end wall — ASSIGNED, matches this file's other wall margins

function buildStairRamp(stairRoom, corridors) {
  const headZ = stairRoom.z0 + RAMP_MARGIN; // ramp starts near the room's own south wall, descends toward +z (north)
  const totalDepth = stairRoom.z1 - RAMP_MARGIN - headZ; // full room depth minus a small margin at each end
  const bandWidth = Math.max(MIN_BAND_WIDTH, Math.min(RAMP_STEP_DEPTH, totalDepth / RAMP_STEPS));

  const terraces = [];
  let z = headZ;
  for (let i = 1; i <= RAMP_STEPS; i++) {
    const bandZ0 = z, bandZ1 = z + bandWidth;
    terraces.push({
      elevation: RAMP_STEP_DELTA * i,
      bounds: { minX: stairRoom.x0, maxX: stairRoom.x1, minZ: bandZ0, maxZ: bandZ1 },
    });
    z = bandZ1;
  }
  // Shaft floor: the REST of the room, all the way to its own north wall — no gap.
  terraces.push({
    elevation: SHAFT_ELEVATION,
    bounds: { minX: stairRoom.x0, maxX: stairRoom.x1, minZ: z, maxZ: stairRoom.z1 },
  });

  // Bug 3's fix, corrected once already found insufficient (round 3, see
  // the seed in this function's own report): a first attempt flattened
  // only the corridor's own clearance-padded Z-extent, but a 0.3 m pad
  // lands well short of a full ramp band (bands run as narrow as 0.25 m
  // once B3's own room-size clamp is applied to a shallow stair room) —
  // the override ended mid-band, leaving a >0.45 m step at ITS OWN edge,
  // the exact same class of bug one level down. Fixed by flattening the
  // corridor's own X-lane (padded) for the room's FULL Z-depth
  // (`stairRoom.z0..z1`), not just wherever the corridor segment itself
  // reaches — so there is no partial coverage and therefore no edge to
  // trip `passN3Slope` on, regardless of where in the ramp's descent the
  // corridor happens to cross. Added LAST, so `terraceElevationAt`'s own
  // "later entries win" rule always gives the corridor's flat floor
  // priority over the ramp underneath it.
  for (const c of corridors) {
    for (const seg of c.segments) {
      const segX0 = seg.x - seg.halfW - WALL_GAP_CLEARANCE, segX1 = seg.x + seg.halfW + WALL_GAP_CLEARANCE;
      const segZ0 = seg.z - seg.halfL - WALL_GAP_CLEARANCE, segZ1 = seg.z + seg.halfL + WALL_GAP_CLEARANCE;
      const ox0 = Math.max(segX0, stairRoom.x0), ox1 = Math.min(segX1, stairRoom.x1);
      const oz0 = Math.max(segZ0, stairRoom.z0), oz1 = Math.min(segZ1, stairRoom.z1);
      if (ox0 >= ox1 || oz0 >= oz1) continue; // no overlap at all
      terraces.push({ elevation: 0, bounds: { minX: ox0, maxX: ox1, minZ: stairRoom.z0, maxZ: stairRoom.z1 } });
    }
  }

  return {
    terraces,
    rampBounds: { minX: stairRoom.x0, maxX: stairRoom.x1, minZ: headZ, maxZ: stairRoom.z1 },
    headZ,
    footZ: stairRoom.z1,
  };
}

// ---------------------------------------------------------------------------
// Public: B1-B7 layout
// ---------------------------------------------------------------------------

/**
 * Runs B1-B7 of `07-world-gen.md` §4.2 over a fresh seed: the BSP tree,
 * rooms, tree+loop corridors, doorways, room roles, and the stair room's
 * ramp/shaft terraces. Forks all seven `07` §1.8 streams, in order, even
 * though only S0/S1/S2/S4 are drawn from anywhere in this file (see this
 * file's header) — S3/S5/S6 are handed back live in `.streams` for a later
 * ticket (spawns/lighting/materials), matching `ridgewalk.js`'s own
 * precedent exactly.
 * @param {number} seed
 * @param {object} [descriptor] defaults to the shipped `bonereach` descriptor.
 * @returns {object}
 */
export function generateBonereachLayout(seed, descriptor = ZONE_DESCRIPTORS_BY_ID.bonereach) {
  const zoneRng = new Rng(seed);
  const S0 = zoneRng.fork(); // macro
  const S1 = zoneRng.fork(); // shape
  const S2 = zoneRng.fork(); // dress — B9 (bonus, see file header)
  const S3 = zoneRng.fork(); // spawn — not drawn here
  const S4 = zoneRng.fork(); // loot — drawn by placeBonereachLoot (B8)
  const S5 = zoneRng.fork(); // light — not drawn here
  const S6 = zoneRng.fork(); // material — not drawn here

  const targetRoomsRequested = drawTargetRooms(S0); // B1
  const { root, leaves, targetRooms, bspFallbackFired } = buildBspTree(S1, targetRoomsRequested); // B2
  const rooms = insetRooms(S1, leaves); // B3
  const { corridors, edges: treeEdges } = carveMergeTree(S0, root, rooms); // B4
  const loopEdges = addLoopEdges(S0, rooms, treeEdges, corridors); // B5
  const allEdges = treeEdges.concat(loopEdges);
  const doorways = computeDoorways(rooms, corridors); // B6
  const roles = assignRoles(S0, rooms, allEdges); // B7

  const stairRoom = rooms[roles.stair];
  const ramp = buildStairRamp(stairRoom, corridors);

  return {
    seed, descriptor,
    targetRoomsRequested, targetRooms, bspFallbackFired,
    root, rooms, corridors, treeEdges, loopEdges, allEdges, doorways, roles, ramp,
    terraces: ramp.terraces,
    streams: { S0, S1, S2, S3, S4, S5, S6 },
  };
}

// ---------------------------------------------------------------------------
// Public: B8 — Chests (S4)
// ---------------------------------------------------------------------------

function doorwayWorldPos(dw) {
  return dw.side === 'N' || dw.side === 'S' ? { x: dw.along, z: dw.wallCoord } : { x: dw.wallCoord, z: dw.along };
}

/** Cardinal facing angle toward a room's nearest own doorway — ASSIGNED
 * angle convention (0 = +x, PI/2 = +z, PI = -x, -PI/2 = -z); no spec
 * formula maps "cardinal direction" to a radian value.
 * @param {object} room @param {number} roomIndex @param {object[]} doorways */
function facingTowardNearestDoorway(room, roomIndex, doorways) {
  let best = null, bestD = Infinity;
  for (const dw of doorways) {
    if (dw.room !== roomIndex) continue;
    const d = distXZ(doorwayWorldPos(dw), room.centre);
    if (d < bestD) { bestD = d; best = dw; }
  }
  if (!best) return 0;
  if (best.side === 'N') return Math.PI / 2;
  if (best.side === 'S') return -Math.PI / 2;
  if (best.side === 'E') return 0;
  return Math.PI; // W
}

/**
 * 07 §4.2 B8. Vault rooms get one chest each (role-assignment order);
 * the remainder goes to `hall` rooms ranked by greatest BFS hops from
 * entry. Positions are returned UNSNAPPED (`nav.snap` needs a live
 * `NavGrid` this pure module may not import — the exact precedent
 * `ridgewalk.js#placeRidgewalkEntries` already established).
 * @param {ReturnType<typeof generateBonereachLayout>} layout
 * @param {object} [descriptor] @param {{S4: Rng}} [streams]
 * @returns {{chests: object[], count: number}}
 */
export function placeBonereachLoot(layout, descriptor = layout.descriptor, streams = layout.streams) {
  const { S4 } = streams;
  const { rooms, roles, doorways } = layout;

  const count = S4.int(descriptor.chestCount.min, descriptor.chestCount.max);
  const chests = [];

  function makeChest(roomIdx) {
    const room = rooms[roomIdx];
    const offset = S4.disc(Math.min(room.width, room.depth) * 0.3);
    return {
      room: roomIdx,
      unsnappedPosition: { x: room.centre.x + offset.x, z: room.centre.z + offset.z },
      facing: facingTowardNearestDoorway(room, roomIdx, doorways),
      treasureClass: descriptor.treasureClass,
      subSeed: S4.u32(),
    };
  }

  for (const roomIdx of roles.vaultRooms) {
    if (chests.length >= count) break;
    chests.push(makeChest(roomIdx));
  }

  const remainder = count - chests.length;
  if (remainder > 0) {
    const hallSorted = roles.hallRooms.slice().sort((a, b) => roles.hops[b] - roles.hops[a] || a - b);
    for (let i = 0; i < remainder && i < hallSorted.length; i++) chests.push(makeChest(hallSorted[i]));
  }

  return { chests, count };
}

// ---------------------------------------------------------------------------
// Public: B9 — Dressing (S2) — bonus, not gated by this ticket's numbered
// criteria (see file header)
// ---------------------------------------------------------------------------

function roleOfRoom(roomIdx, roles) {
  if (roomIdx === roles.entry) return 'entry';
  if (roomIdx === roles.stair) return 'stair';
  if (roles.vaultRooms.includes(roomIdx)) return 'vault';
  if (roomIdx === roles.floodedRoom) return 'flooded';
  return 'hall';
}

function corridorLength(corridor) {
  let len = 0;
  for (const seg of corridor.segments) len += 2 * Math.max(seg.halfW, seg.halfL);
  return len;
}

/**
 * 07 §4.2 B9, simplified dart-throw dressing — same rejection shape as
 * `wastes.js#runR8Dressing` (position tries, minSpacing against every
 * earlier-placed prop, sixteen tries then give up), scoped down: no
 * PROTO_CAP (the 15-prototype union here never nears 18), no gate
 * exclusion (Bonereach has doorways, not Wastes-style gates — a doorway
 * exclusion radius is used instead). `propBudget` is a CEILING (D-80): the
 * per-unit quota is clamped by `remaining / unitsLeft`, never inflated to
 * chase the budget.
 * @param {ReturnType<typeof generateBonereachLayout>} layout
 * @param {object} [descriptor] @param {{S2: Rng}} [streams]
 * @returns {{props: object[], attempted: number, rejectionStats: object}}
 */
export function runBonereachDressing(layout, descriptor = layout.descriptor, streams = layout.streams) {
  const { S2 } = streams;
  const { rooms, corridors, roles, doorways } = layout;

  const units = [];
  for (const room of rooms) units.push({ kind: 'room', room });
  for (const corridor of corridors) units.push({ kind: 'corridor', corridor });

  const placed = [];
  let attempted = 0;
  const rejectionStats = { wall: 0, doorway: 0, spacing: 0, chest: 0, accepted: 0 };
  const unitsTotal = units.length;
  let placedSoFar = 0;

  const doorwaysByRoom = new Map();
  for (const dw of doorways) {
    if (!doorwaysByRoom.has(dw.room)) doorwaysByRoom.set(dw.room, []);
    doorwaysByRoom.get(dw.room).push(dw);
  }

  for (let idx = 0; idx < units.length; idx++) {
    const unit = units[idx];
    const unitsLeft = unitsTotal - idx;
    const remaining = descriptor.propBudget - placedSoFar;

    let quota, table, marginX0, marginX1, marginZ0, marginZ1, throwPoint;
    if (unit.kind === 'room') {
      const role = roleOfRoom(unit.room.index, roles);
      const roleQuota = ROLE_PROP_QUOTA[role];
      quota = Math.max(0, Math.min(roleQuota, Math.floor(remaining / unitsLeft)));
      table = ROLE_PROTO_TABLE[role];
      const inset = WALL_THICKNESS + 0.6;
      marginX0 = unit.room.x0 + inset; marginX1 = unit.room.x1 - inset;
      marginZ0 = unit.room.z0 + inset; marginZ1 = unit.room.z1 - inset;
      throwPoint = () => ({ x: S2.range(marginX0, marginX1), z: S2.range(marginZ0, marginZ1) });
    } else {
      const len = corridorLength(unit.corridor);
      const roleQuota = Math.round((CORRIDOR_PROPS_PER_10M * len) / 10);
      quota = Math.max(0, Math.min(roleQuota, Math.floor(remaining / unitsLeft)));
      table = ROLE_PROTO_TABLE.corridor;
      const segs = unit.corridor.segments;
      throwPoint = () => {
        const seg = segs[S2.int(0, segs.length - 1)];
        return { x: S2.range(seg.x - seg.halfW, seg.x + seg.halfW), z: S2.range(seg.z - seg.halfL, seg.z + seg.halfL) };
      };
    }

    for (let i = 0; i < quota; i++) {
      const protoId = S2.pick(table);
      const spec = PROTOTYPE_CATALOG[protoId];
      let accepted = null;

      for (let t = 0; t < 16; t++) {
        attempted++;
        const p = throwPoint();

        if (unit.kind === 'room') {
          const dws = doorwaysByRoom.get(unit.room.index) || [];
          let nearDoorway = false;
          for (const dw of dws) {
            const wp = doorwayWorldPos(dw);
            if (distXZ(wp, p) < DOORWAY_HALF_WIDTH + 1.0) { nearDoorway = true; break; }
          }
          if (nearDoorway) { rejectionStats.doorway++; continue; }

          // A block:true prototype must never land inside (or too close to)
          // ANY corridor's own GroundRegion — not just this room's own
          // registered doorways. A "pass-through" corridor (see
          // `wallOpeningsFromCorridors`'s own header — a corridor that
          // grazes or runs alongside a room it has no registered doorway
          // for) is otherwise invisible to the per-room doorway check above
          // and a blocking prop dropped on its only path would seal a
          // region (I6) — found as a real regression during this ticket's
          // own development. Non-blocking prototypes skip this check
          // entirely (they cannot seal anything).
          if (spec.block) {
            let blocksCorridor = false;
            for (const c of corridors) {
              for (const seg of c.segments) {
                const dx = Math.abs(p.x - seg.x) - seg.halfW - spec.spacing / 2;
                const dz = Math.abs(p.z - seg.z) - seg.halfL - spec.spacing / 2;
                if (dx <= 0 && dz <= 0) { blocksCorridor = true; break; }
              }
              if (blocksCorridor) break;
            }
            if (blocksCorridor) { rejectionStats.doorway++; continue; }
          }
        }

        let nearestDist = Infinity;
        for (let j = 0; j < placed.length; j++) {
          const d = distXZ(placed[j], p);
          if (d < nearestDist) nearestDist = d;
        }
        if (nearestDist < spec.spacing) { rejectionStats.spacing++; continue; }

        accepted = p;
        rejectionStats.accepted++;
        break;
      }
      if (!accepted) continue;

      const facing = S2.range(0, Math.PI * 2);
      const scale = S2.range(0.85, 1.15);
      placed.push({ x: accepted.x, z: accepted.z, protoId, facing, scale, elevation: 0 });
      placedSoFar++;
    }
  }

  return { props: placed, attempted, rejectionStats };
}

// ---------------------------------------------------------------------------
// Public: B10 — Entries and exits (no draw — pure geometry)
// ---------------------------------------------------------------------------

/**
 * 07 §4.2 B10. Uses the SHIPPED `zones.js` descriptor's own tag names
 * (`descent`/`altar_return`, exits[0] only) — see this file's header for
 * the full spec-vs-shipped-data disclosure. `altar_return`'s own placement
 * has no spec formula (the spec names `ascent_return`, a different tag);
 * ASSIGNED to the stair room's own ramp head, facing back into the room.
 * @param {ReturnType<typeof generateBonereachLayout>} layout @param {object} [descriptor]
 * @returns {{entries: object, exit: object}}
 */
export function placeBonereachEntries(layout, descriptor = layout.descriptor) {
  const { rooms, roles, ramp } = layout;
  const entryRoom = rooms[roles.entry];
  const stairRoom = rooms[roles.stair];

  const entries = {
    descent: {
      x: entryRoom.centre.x,
      z: entryRoom.centre.z - (entryRoom.depth / 2 - 2.5),
      facing: Math.PI / 2,
    },
    altar_return: {
      x: stairRoom.centre.x,
      z: ramp.headZ,
      facing: -Math.PI / 2,
    },
  };

  const exitDef = {
    toZone: descriptor.exits[0].toZone,
    toEntryTag: descriptor.exits[0].tag,
    ramp: { x: stairRoom.centre.x, headZ: ramp.headZ, footZ: ramp.footZ },
    // "trigger rect 5x2m at the ramp foot" — centred at the shaft floor.
    trigger: { x: stairRoom.centre.x, z: ramp.footZ - 1, width: 5, depth: 2 },
  };

  return { entries, exit: exitDef };
}

/**
 * Convenience: B1-B7 followed by B8/B10 on the same seed (B9 is optional —
 * see file header — and is deliberately NOT run by this convenience
 * wrapper; call `runBonereachDressing` explicitly if a caller wants it).
 * @param {number} seed @param {object} [descriptor]
 * @returns {object}
 */
export function generateBonereach(seed, descriptor = ZONE_DESCRIPTORS_BY_ID.bonereach) {
  const layout = generateBonereachLayout(seed, descriptor);
  const { chests } = placeBonereachLoot(layout, descriptor);
  const { entries, exit } = placeBonereachEntries(layout, descriptor);
  return { ...layout, chests, entries, exit };
}

// ---------------------------------------------------------------------------
// Nav wiring helpers — GroundRegions + spawnDeny + Footprints
// ---------------------------------------------------------------------------

/**
 * One walkable box `GroundRegion` per room, one (or two) per corridor, and
 * one small box per doorway (flagged `doorway:true`) — `src/world/raster.js`'s
 * own intended consumer of exactly this shape. Everything is flagged
 * `interior:true` (07 §4.1).
 * @param {ReturnType<typeof generateBonereachLayout>} layout
 * @returns {object[]} GroundRegions, ready for `raster.js#passN2GroundStamp`/`passN5Doorway`.
 */
export function buildGroundRegions(layout) {
  const regions = [];
  for (const room of layout.rooms) {
    regions.push({ kind: 'box', x: (room.x0 + room.x1) / 2, z: (room.z0 + room.z1) / 2, halfW: (room.x1 - room.x0) / 2, halfL: (room.z1 - room.z0) / 2, interior: true });
  }
  for (const corridor of layout.corridors) {
    for (const seg of corridor.segments) regions.push({ kind: 'box', x: seg.x, z: seg.z, halfW: seg.halfW, halfL: seg.halfL, interior: true });
  }
  for (const dw of layout.doorways) {
    const pos = doorwayWorldPos(dw);
    const alongHalf = DOORWAY_HALF_WIDTH, throughHalf = WALL_THICKNESS / 2;
    const isNS = dw.side === 'N' || dw.side === 'S';
    regions.push({
      kind: 'box', x: pos.x, z: pos.z,
      halfW: isNS ? alongHalf : throughHalf,
      halfL: isNS ? throughHalf : alongHalf,
      interior: true, doorway: true,
    });
  }
  return regions;
}

/** `passN9SpawnDeny`'s own `entryRooms` marker shape — the WHOLE entry room
 * (B7: "spawnDeny over the whole room"), plus each chest's own disc.
 * @param {ReturnType<typeof generateBonereachLayout>} layout @param {object[]} [chests]
 * @returns {{entryRooms: object[], chests: {x:number,z:number}[]}} */
export function buildSpawnDenyMarkers(layout, chests = []) {
  const entryRoom = layout.rooms[layout.roles.entry];
  const entryRegion = { kind: 'box', x: entryRoom.centre.x, z: entryRoom.centre.z, halfW: entryRoom.width / 2, halfL: entryRoom.depth / 2 };
  const chestPoints = chests.map((c) => c.unsnappedPosition);
  return { entryRooms: [entryRegion], chests: chestPoints };
}

// ---------------------------------------------------------------------------
// Footprints — room walls (with real doorway gaps) + destructible props
// ---------------------------------------------------------------------------

/**
 * Every `[lo,hi]` range along a wall's own axis where SOME corridor segment
 * (from ANY corridor, not only ones that terminate at this room) comes
 * within `WALL_GAP_CLEARANCE` of the wall's own line — perpendicular
 * distance, not just literal overlap. Two DISTINCT real bugs, both found as
 * region-count/corridor-width regressions during this ticket's own
 * development (see this ticket's report, "O-102 — the bug, found" and the
 * corridor-width finding), are both this same check:
 *
 * 1. A straight centre-to-centre L-corridor between two OTHER rooms can cut
 *    straight through a third, unrelated room's own rectangle (the two
 *    BSP-sibling rooms and the third room end up geometrically arranged so
 *    the direct path grazes it) — that third room's wall must not block a
 *    corridor it has no registered doorway for. This is `perpDist <= 0`
 *    (true overlap).
 * 2. A corridor lane can run PARALLEL to, and merely close alongside, an
 *    unrelated room's own wall (not crossing it at all) — close enough
 *    that `raster.js`'s own footprint dilation (`RASTER.DILATION` +
 *    `NEAR_WALL_MARGIN`, an SDF-rounded corner) still reaches from the
 *    solid wall into the corridor's own walkable core, narrowing it below
 *    criterion 3's 3.0 m / 6-cell floor. This is `0 < perpDist <=
 *    WALL_GAP_CLEARANCE` (near-miss, not overlap) — measured directly: a
 *    corridor lane running 2 m from a room's wall (a real, non-rare BSP
 *    layout outcome given rooms are padded only 2-5 m off their own leaf)
 *    eroded the opposite side of that corridor to 4 cells before this
 *    clearance term existed.
 *
 * Where this fires, this room's wall is fully OPEN for the corridor's own
 * along-extent (plus `WALL_GAP_CLEARANCE` padding) — a real, disclosed
 * simplification (see this ticket's report): the room loses a stretch of
 * physical/visual wall alongside the corridor, rather than a partial,
 * precisely-clipped notch. This never affects nav walkability beyond the
 * wall (that is governed by `GroundRegion` coverage alone, not by the
 * absence of a wall) — only physics/visual containment in that stretch.
 *
 * ---------------------------------------------------------------------
 * `WALL_GAP_CLEARANCE = 0.3`, corrected — round 2 finding (D-83 discussion)
 * ---------------------------------------------------------------------
 * This file's first pass set `WALL_GAP_CLEARANCE = 0.7`, chosen only to
 * clear the observed 4-cell erosion (see point 2 above) without measuring
 * the MINIMUM value that does — it overshot, and the resulting corridors
 * (8 cells / 4.0 m) silently widened another ticket's own acceptance
 * measurement (AI-5's "3 abreast in a 3.0 m corridor" reading 5 abreast
 * instead, since `5 x 0.76 = 3.80 <= 4.0`). A parameterized sweep of this
 * exact clearance value, 0.0 to 0.7 in steps, over the FULL 600-layout
 * corpus, gives the real shape of the constraint:
 *
 *   clearance  narrowest cross-section   regionCount != 1
 *   0.00       0 cells (a true pinch)    0/600
 *   0.10-0.50  6 cells = 3.0 m (exact)   0/600   <- B4's own literal number
 *   0.60-0.70  8 cells = 4.0 m           0/600
 *
 * So B4's own "3.0 m wide (6 nav cells)" is NOT structurally unreachable —
 * 0.7 was simply more margin than the geometry needs. `0.3` (this file's
 * corrected value) equals `RASTER.DILATION` exactly: the wall recedes
 * exactly far enough that dilation's own blocked zone reaches back to
 * precisely the corridor's true edge and no further, and it sits centrally
 * inside the empirically-verified-safe [0.1, 0.5] band (confirmed 0/600
 * region failures and 0/600 zero-width samples at this exact value, full
 * sweep). `0.0` (no margin at all) is NOT safe — a genuine zero-width pinch
 * was measured at at least one point, even though `regionCount` did not
 * (yet) register it as a disconnection at that specific sample.
 * @param {number} wallCoord fixed coordinate of the wall (z for N/S, x for E/W)
 * @param {boolean} isNS @param {object[]} corridors
 * @returns {{lo:number, hi:number}[]}
 */
const WALL_GAP_CLEARANCE = 0.3;
function wallOpeningsFromCorridors(wallCoord, isNS, corridors) {
  const openings = [];
  for (const c of corridors) {
    for (const seg of c.segments) {
      if (isNS) {
        const perpDist = Math.abs(seg.z - wallCoord) - seg.halfL;
        if (perpDist <= WALL_GAP_CLEARANCE) openings.push({ lo: seg.x - seg.halfW - WALL_GAP_CLEARANCE, hi: seg.x + seg.halfW + WALL_GAP_CLEARANCE });
      } else {
        const perpDist = Math.abs(seg.x - wallCoord) - seg.halfW;
        if (perpDist <= WALL_GAP_CLEARANCE) openings.push({ lo: seg.z - seg.halfL - WALL_GAP_CLEARANCE, hi: seg.z + seg.halfL + WALL_GAP_CLEARANCE });
      }
    }
  }
  return openings;
}

/** Subtracts every `[lo,hi]` opening range (clamped to `[fullStart,fullEnd]`)
 * from the wall's own full span, returning the surviving solid segments.
 * @param {number} fullStart @param {number} fullEnd @param {{lo:number,hi:number}[]} openings
 * @returns {{start:number,end:number}[]} */
function wallSegmentsForSide(fullStart, fullEnd, openings) {
  const ranges = openings
    .map((o) => ({ lo: Math.max(fullStart, o.lo), hi: Math.min(fullEnd, o.hi) }))
    .filter((o) => o.hi > o.lo)
    .sort((a, b) => a.lo - b.lo);

  const segs = [];
  let cursor = fullStart;
  for (const r of ranges) {
    if (r.lo > cursor) segs.push({ start: cursor, end: Math.min(r.lo, fullEnd) });
    cursor = Math.max(cursor, r.hi);
  }
  if (cursor < fullEnd) segs.push({ start: cursor, end: fullEnd });
  return segs.filter((s) => s.end > s.start);
}

/**
 * Room wall `Footprint`s (`02-api-contracts.md` §4 shape), with a real gap
 * everywhere a corridor's own `GroundRegion` physically overlaps the wall
 * — computed geometrically (`wallOpeningsFromCorridors`), not from the
 * per-room `doorways` bookkeeping alone, precisely because a corridor that
 * has nothing to do with a given room can still cut through that room's
 * rectangle (see `wallOpeningsFromCorridors`'s own comment).
 *
 * `dressing` (B9's `props`) is accepted but its `block:true` prototypes are
 * DELIBERATELY NOT converted into blocking Footprints here — a disclosed
 * scope decision, not an oversight (see this ticket's report,
 * "B9 dressing props do not block nav"): `runBonereachDressing`'s own
 * per-placement rejection clause keeps a blocking prop off a registered
 * doorway and off every corridor's own `GroundRegion`, but a dense room
 * (18x18 m, up to 84 props) can still, rarely, cluster enough blocking
 * props to pinch off part of its OWN open floor — found as a real
 * `regionCount` regression during this ticket's own development. Fully
 * eliminating that risk needs placement-time flood-fill validation this
 * pure layout file does not have (that needs a live `NavGrid`, exactly the
 * reason `ridgewalk.js#placeRidgewalkEntries` defers `nav.snap` to a later
 * stage). Since B9 is not gated by any of this ticket's seven numbered
 * criteria (see file header) while criterion 2 (`regionCount === 1` on
 * 100%) is a hard requirement, dressing props are visual/data-only here;
 * `src/world/build/bonereach.js` still renders them from `dressing.props`
 * directly. This does mean I6 ("no destructible can seal a region") holds
 * vacuously for THIS ticket's own dressing — disclosed, not hidden.
 * @param {ReturnType<typeof generateBonereachLayout>} layout @param {{props:object[]}} [dressing] accepted, currently unused (see above)
 * @returns {object[]}
 */
/**
 * Solid room-wall segments (with real doorway gaps), as plain box records
 * — VISUAL data for `src/world/build/bonereach.js`, not Footprints. See
 * `toFootprints`'s own header for why nav/physics blocking is NOT done via
 * these walls (`nav.rebuild()`'s own real constraint) — this function still
 * exists because the room needs to LOOK enclosed, with real gaps at every
 * doorway, independent of how nav computes walkability.
 * @param {ReturnType<typeof generateBonereachLayout>} layout
 * @returns {{x:number,z:number,halfW:number,halfL:number,height:number,side:string,room:number}[]}
 */
export function buildWallSegments(layout) {
  const out = [];
  const halfThick = WALL_THICKNESS / 2;
  for (const room of layout.rooms) {
    for (const seg of wallSegmentsForSide(room.x0, room.x1, wallOpeningsFromCorridors(room.z1, true, layout.corridors))) {
      out.push({ x: (seg.start + seg.end) / 2, z: room.z1, halfW: (seg.end - seg.start) / 2, halfL: halfThick, height: room.topY, side: 'N', room: room.index });
    }
    for (const seg of wallSegmentsForSide(room.x0, room.x1, wallOpeningsFromCorridors(room.z0, true, layout.corridors))) {
      out.push({ x: (seg.start + seg.end) / 2, z: room.z0, halfW: (seg.end - seg.start) / 2, halfL: halfThick, height: room.topY, side: 'S', room: room.index });
    }
    for (const seg of wallSegmentsForSide(room.z0, room.z1, wallOpeningsFromCorridors(room.x1, false, layout.corridors))) {
      out.push({ x: room.x1, z: (seg.start + seg.end) / 2, halfW: halfThick, halfL: (seg.end - seg.start) / 2, height: room.topY, side: 'E', room: room.index });
    }
    for (const seg of wallSegmentsForSide(room.z0, room.z1, wallOpeningsFromCorridors(room.x0, false, layout.corridors))) {
      out.push({ x: room.x0, z: (seg.start + seg.end) / 2, halfW: halfThick, halfL: (seg.end - seg.start) / 2, height: room.topY, side: 'W', room: room.index });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rock footprints — the ONLY blocking geometry that reaches the live nav
// grid (see the header note below), built by subtracting every room and
// corridor (each expanded by WALL_GAP_CLEARANCE) out of the 108x108 root
// rectangle
// ---------------------------------------------------------------------------
//
// `src/nav/index.js#rebuild(zone)` (verified directly — not in this
// ticket's file grant to change) hardcodes `groundRegions: null, entry:
// null, spawnDenyMarkers: null` on EVERY call, regardless of what `zone` or
// its generator provide; the only geometry that reaches
// `raster.js#rasterizeNav` from the real `world.enterZone` ->
// `nav.rebuild(instance)` path is `footprints` (`world.staticFootprints`).
// This means `buildGroundRegions`'s own "mark rooms/corridors walkable"
// design — while correct as an ALGORITHM, verified directly against
// `rasterizeNav` earlier in this file's own development — can NEVER reach
// the live game's nav grid. Reported as a real, disclosed finding (this
// ticket's report): a room-based generator fundamentally needs
// `GroundRegion` support in `nav.rebuild()`, which does not exist today.
//
// The fix that DOES reach the live grid: since `passN2GroundStamp` defaults
// to "every cell walkable" when `groundRegions` is empty/null (exactly
// `raster.js`'s own documented absent-input behaviour), Bonereach must
// instead BLOCK everything that is NOT a room or corridor, via Footprints
// alone — the inverse of the Ridgewalk/Wastes convention (open terrain,
// footprints carve out blocked islands) because Bonereach is the opposite
// shape (an enclosed hall network inside otherwise-solid rock).
function subtractRectFromRect(outer, hole) {
  const ox0 = Math.max(outer.x0, hole.x0), ox1 = Math.min(outer.x1, hole.x1);
  const oz0 = Math.max(outer.z0, hole.z0), oz1 = Math.min(outer.z1, hole.z1);
  if (ox0 >= ox1 || oz0 >= oz1) return [outer]; // no overlap — unchanged
  const pieces = [];
  if (outer.z0 < oz0) pieces.push({ x0: outer.x0, z0: outer.z0, x1: outer.x1, z1: oz0 }); // south strip
  if (oz1 < outer.z1) pieces.push({ x0: outer.x0, z0: oz1, x1: outer.x1, z1: outer.z1 }); // north strip
  if (outer.x0 < ox0) pieces.push({ x0: outer.x0, z0: oz0, x1: ox0, z1: oz1 }); // west strip (middle band only)
  if (ox1 < outer.x1) pieces.push({ x0: ox1, z0: oz0, x1: outer.x1, z1: oz1 }); // east strip (middle band only)
  return pieces;
}

function subtractRectFromRects(rects, hole) {
  const out = [];
  for (const r of rects) out.push(...subtractRectFromRect(r, hole));
  return out;
}

const ROCK_WALL_HEIGHT = 8.0; // metres — ASSIGNED, taller than a room wall so it never reads as a room's own ceiling

/**
 * Every "solid rock" rectangle inside the 108x108 root — the root minus
 * every room and every corridor segment, each expanded by
 * `WALL_GAP_CLEARANCE` (the same margin that keeps corridor cross-sections
 * at their full 6-cell width against a room wall's own dilation — see
 * `wallOpeningsFromCorridors`'s own header; the identical reasoning applies
 * here: rock sitting flush against a corridor's true edge would erode it by
 * dilation exactly the same way a flush wall did).
 * @param {ReturnType<typeof generateBonereachLayout>} layout
 * @returns {{x0:number,z0:number,x1:number,z1:number}[]}
 */
function buildRockPieces(layout) {
  let pieces = [{ x0: ROOT_RECT.x0, z0: ROOT_RECT.z0, x1: ROOT_RECT.x1, z1: ROOT_RECT.z1 }];
  for (const room of layout.rooms) {
    const hole = { x0: room.x0 - WALL_GAP_CLEARANCE, z0: room.z0 - WALL_GAP_CLEARANCE, x1: room.x1 + WALL_GAP_CLEARANCE, z1: room.z1 + WALL_GAP_CLEARANCE };
    pieces = subtractRectFromRects(pieces, hole);
  }
  for (const c of layout.corridors) {
    for (const seg of c.segments) {
      const hole = { x0: seg.x - seg.halfW - WALL_GAP_CLEARANCE, z0: seg.z - seg.halfL - WALL_GAP_CLEARANCE, x1: seg.x + seg.halfW + WALL_GAP_CLEARANCE, z1: seg.z + seg.halfL + WALL_GAP_CLEARANCE };
      pieces = subtractRectFromRects(pieces, hole);
    }
  }
  return pieces.filter((p) => p.x1 - p.x0 > 1e-6 && p.z1 - p.z0 > 1e-6);
}

/** The 2 m rock margin outside the 108x108 root, up to the zone's own
 * bounds (07 §4.1, verbatim: "leaving a 2 m rock margin on every side").
 * @returns {object[]} four box Footprints. */
function buildPerimeterFootprints() {
  const rootHalf = ROOT_RECT.x1; // 54, symmetric
  const margin = 2.0;
  const outer = rootHalf + margin; // 56
  const mid = rootHalf + margin / 2; // 55
  const halfThick = margin / 2; // 1
  const mk = (x, z, halfW, halfL) => ({ kind: 'box', x, z, y: 0, height: ROCK_WALL_HEIGHT, halfW, halfL, facing: 0, blocksNav: true, blocksSight: true, surface: 'stone', destructible: false });
  return [
    mk(0, mid, outer, halfThick), // north
    mk(0, -mid, outer, halfThick), // south
    mk(mid, 0, halfThick, outer), // east
    mk(-mid, 0, halfThick, outer), // west
  ];
}

/**
 * `02-api-contracts.md` §4-shape `Footprint`s: the perimeter margin plus
 * every rock piece (`buildRockPieces`) — the ONLY geometry this ticket
 * relies on to reach the live nav grid (see the section header above for
 * the full `nav.rebuild()` disclosure). `dressing` is accepted for call-site
 * symmetry with `wastes.js#toFootprints` but deliberately unused — see
 * `runBonereachDressing`'s own header for why B9 props never become
 * blocking Footprints.
 * @param {ReturnType<typeof generateBonereachLayout>} layout @param {object} [dressing] unused, see above
 * @returns {object[]}
 */
export function toFootprints(layout, dressing) {
  void dressing;
  const out = buildPerimeterFootprints();
  let id = out.length;
  for (const p of buildRockPieces(layout)) {
    out.push({
      id: id++, kind: 'box', x: (p.x0 + p.x1) / 2, z: (p.z0 + p.z1) / 2, y: 0, height: ROCK_WALL_HEIGHT,
      halfW: (p.x1 - p.x0) / 2, halfL: (p.z1 - p.z0) / 2, facing: 0, blocksNav: true, blocksSight: true, surface: 'stone', destructible: false,
    });
  }
  for (let i = 0; i < out.length; i++) out[i].id = i;
  return out;
}
