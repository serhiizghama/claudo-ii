// src/world/gen/ridgewalk.js
//
// WRLD-5 — the Ashen Wastes macro layout: `07-world-gen.md` §3.2's R1-R7
// (spine, branches, connected/void, terraces, gates, archetypes) plus R10
// (entries/exit/chests). R8 (dressing) and R9 (boundary) are WRLD-6's; R11
// (spawns/packs) is WRLD-9's — this file does not touch either.
//
// Pure function, no `ctx`. Every input is an argument, every output is a
// plain object/typed array. No `three`, no `document`/`window`, no
// `performance.now()`/`Date.now()`, no `Math.random()` — the only source of
// randomness is the `Rng` streams forked from the caller's seed, exactly as
// `07` §1.8 lays out. `src/world/gen/` is a subdirectory of the already-
// declared `src/world` lint root (D-72) and inherits its full
// `checkThree: true, checkGlobals: true` sweep the moment it exists, so this
// file (and everything it imports) must stay clean under that sweep too.
//
// Unlike `src/world/raster.js` (WRLD-2), this file is NOT zero-import:
// `src/core/rng.js` (the one authorised RNG implementation — do not
// reimplement `int`/`weighted`/`disc`/etc.) and `src/world/data/zones.js`
// (the already-shipped `ashen_wastes` descriptor — rule 6 says read it, do
// not re-declare it) are both imported. Both are lint-clean under the same
// sweep this file inherits (verified: neither imports `three` nor touches
// `document`/`window`/`performance.now()`), so the transitive closure stays
// clean — `raster.js`'s zero-import discipline was that file's own choice
// for relocatability, not a rule this file needs to match line for line.
//
// ---------------------------------------------------------------------------
// The macro grid — flat arrays, never a `Map` (O-59 / ARCHITECTURE.md)
// ---------------------------------------------------------------------------
// 4x4 cells, indexed `cz * 4 + cx` (never a template-string coordinate key).
// Every per-cell table below (`archetypeOf`, `elevationOf`, `wantsShelf`,
// the various boolean flags) is a length-16 flat array/typed array indexed
// this same way.

import { Rng } from '../../core/rng.js';
import { ZONE_DESCRIPTORS_BY_ID } from '../data/zones.js';

const GRID_DIM = 4; // 07 §3.1: "Macro grid 4 x 4 cells" — fixed by R1's own
// literal `S0.int(0, 3)` bounds, independent of the descriptor's sizeX/
// cellSize (which happen to agree: 96 / 24 = 4).

/** @param {number} cx @param {number} cz @returns {number} flat index `cz*4+cx` */
export function cellIndex(cx, cz) {
  return cz * GRID_DIM + cx;
}

/** @param {number} i @returns {{cx:number, cz:number}} */
export function cellOf(i) {
  return { cx: i % GRID_DIM, cz: (i / GRID_DIM) | 0 };
}

/** `07` §3.1: `centre(cx,cz) = (-sizeX/2 + cellSize/2 + cellSize*cx, ...)`,
 * i.e. `(-36 + 24*cx, -36 + 24*cz)` for the shipped Ashen Wastes descriptor.
 * @param {object} descriptor @param {number} cx @param {number} cz
 * @returns {{x:number, z:number}} */
export function cellCentre(descriptor, cx, cz) {
  const origin = -descriptor.sizeX / 2 + descriptor.cellSize / 2;
  return { x: origin + descriptor.cellSize * cx, z: origin + descriptor.cellSize * cz };
}

// ---------------------------------------------------------------------------
// R7's archetype table — gameplay numbers, kept as a single frozen const,
// not scattered through the logic below (ARCHITECTURE.md rule 9 / this
// ticket's rule 6).
// ---------------------------------------------------------------------------
// This ticket's file list is `src/world/gen/ridgewalk.js` and its own tests
// only — no new `src/world/data/*.js` file is granted. Rule 6 flags this
// exact table as gameplay data that belongs under `data/`; since no such
// file is in scope here, it is defined below as a frozen top-level const —
// data-shaped (a plain literal table, touched by no logic), just physically
// co-located instead of split into its own file. A follow-up ticket that IS
// granted a `src/world/data/ridgewalk.js` path can lift this verbatim.
//
// `terrace` here is each archetype's OWN fixed elevation contribution (07
// §3.2 R7's table column) — `ravine` is the only non-zero entry (-2.20),
// matching R5's `elev(cell) = -2.20 if archetype(cell) == 'ravine'` line
// exactly. `props`/`densityX` are read by R10's chest-remainder placement
// (07 §3.2 R10: "the cell with the highest (props x density x) product").
export const ARCHETYPE_TABLE = Object.freeze({
  ash_flats: Object.freeze({ weight: 26, surface: 'ash', terrace: 0.0, props: 34, densityX: 0.85 }),
  dead_grove: Object.freeze({ weight: 20, surface: 'dirt', terrace: 0.0, props: 92, densityX: 1.1 }),
  ruin_field: Object.freeze({ weight: 18, surface: 'stone', terrace: 0.0, props: 78, densityX: 1.2 }),
  bone_yard: Object.freeze({ weight: 14, surface: 'bone', terrace: 0.0, props: 110, densityX: 1.0 }),
  ravine: Object.freeze({ weight: 12, surface: 'dirt', terrace: -2.2, props: 46, densityX: 0.75 }),
  warcamp: Object.freeze({ weight: 10, surface: 'dirt', terrace: 0.0, props: 66, densityX: 1.6 }),
});
/** Table order — R7's weighted draw and the A5 "half of connected, rounded
 * up" cap iterate this, never `Object.keys()` (insertion order is in
 * practice stable in V8 for these string keys, but an explicit array keeps
 * the draw order legible and independent of that engine detail). */
const ARCHETYPE_IDS = Object.freeze(['ash_flats', 'dead_grove', 'ruin_field', 'bone_yard', 'ravine', 'warcamp']);
const WARCAMP_CAP = 2; // A4
const SHELF_ROLL_THRESHOLD = 0.18; // R5
const SHELF_ELEVATION = 1.2; // R5

// ---------------------------------------------------------------------------
// Fixed neighbour order [N, E, W, S] — 07 §3.2 R2/R3's own binding order.
// North = +cz, east = +cx (07 §3.1: "row cz=3 is the north edge").
// Reordering this changes every seed's map (07 §3.2's own warning).
// ---------------------------------------------------------------------------
const NEIGHBOUR_WEIGHT = Object.freeze({ N: 5, E: 3, W: 3, S: 1 });

/** In-bounds 4-neighbours of flat index `i`, in FIXED order [N, E, W, S].
 * Small per-call array (<=4 entries) — this runs at most a few dozen times
 * per generation (a 16-cell grid), never a hot path (rule 5).
 * @param {number} i @returns {{dir:'N'|'E'|'W'|'S', index:number}[]} */
function neighboursOf(i) {
  const cx = i % GRID_DIM;
  const cz = (i / GRID_DIM) | 0;
  const out = [];
  if (cz < GRID_DIM - 1) out.push({ dir: 'N', index: i + GRID_DIM });
  if (cx < GRID_DIM - 1) out.push({ dir: 'E', index: i + 1 });
  if (cx > 0) out.push({ dir: 'W', index: i - 1 });
  if (cz > 0) out.push({ dir: 'S', index: i - GRID_DIM });
  return out;
}

// ---------------------------------------------------------------------------
// R1 — Endpoints (S0)
// ---------------------------------------------------------------------------

/**
 * 07 §3.2 R1, verbatim. The `for attempt in 0..3` loop is 4 iterations
 * (inclusive both ends — the same convention R8's "for tries in 0..15" uses,
 * confirmed by its own prose: "Sixteen tries"). See this ticket's report for
 * why that reads as `(1/4)^5`, not the prose's own `(1/4)^4` — a spec-prose
 * inconsistency, not a reason to bend the literal pseudocode.
 * @param {import('../../core/rng.js').Rng} S0
 * @returns {{entryCell:number, exitCell:number, forcedFallback:boolean}}
 */
function drawEndpoints(S0) {
  const entryCx = S0.int(0, 3);
  let exitCx = S0.int(0, 3);
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (Math.abs(exitCx - entryCx) >= 1) break;
    exitCx = S0.int(0, 3);
  }
  let forcedFallback = false;
  if (Math.abs(exitCx - entryCx) < 1) {
    exitCx = (entryCx + 2) & 3;
    forcedFallback = true;
  }
  return { entryCell: cellIndex(entryCx, 0), exitCell: cellIndex(exitCx, 3), forcedFallback };
}

// ---------------------------------------------------------------------------
// R2 — The spine (S0), with RESTART / L-path fallback
// ---------------------------------------------------------------------------

/**
 * One attempt at 07 §3.2 R2's weighted self-avoiding walk with
 * backtracking. Returns `null` when the attempt hits a RESTART trigger
 * (stack empties on backtrack, or grows past 12) — the caller re-runs this
 * from scratch, consuming fresh `S0` draws, per the spec's own RESTART
 * semantics. "The popped cell stays visited" (07 §3.2's own callout) is
 * exactly why `visited` here is never cleared on pop.
 * @param {import('../../core/rng.js').Rng} S0 @param {number} entry @param {number} exit
 * @returns {{spine:number[], visited:Uint8Array, maxConsecutiveBacktrack:number}|null}
 */
function attemptSpineWalk(S0, entry, exit) {
  const stack = [entry];
  const visited = new Uint8Array(GRID_DIM * GRID_DIM);
  visited[entry] = 1;
  let consecutiveBacktrack = 0;
  let maxConsecutiveBacktrack = 0;

  while (stack[stack.length - 1] !== exit) {
    const top = stack[stack.length - 1];
    const cands = neighboursOf(top).filter((n) => !visited[n.index]);
    if (cands.length === 0) {
      stack.pop();
      consecutiveBacktrack++;
      if (consecutiveBacktrack > maxConsecutiveBacktrack) maxConsecutiveBacktrack = consecutiveBacktrack;
      if (stack.length === 0) return null; // RESTART
      continue;
    }
    consecutiveBacktrack = 0;
    const weights = cands.map((c) => NEIGHBOUR_WEIGHT[c.dir]);
    const chosen = S0.weighted(cands, weights);
    stack.push(chosen.index);
    visited[chosen.index] = 1;
    if (stack.length > 12) return null; // RESTART
  }
  return { spine: stack.slice(), visited, maxConsecutiveBacktrack };
}

/** The always-succeeds fallback: north along `entryCell.cx` to `cz=3`, then
 * east/west along `cz=3` to `exitCell.cx`. No RNG — deterministic and
 * always in bounds/self-avoiding (07 §3.2's own claim).
 * @param {number} entry @param {number} exit @returns {number[]} */
function buildLPath(entry, exit) {
  const entryCx = cellOf(entry).cx;
  const exitCx = cellOf(exit).cx;
  const path = [];
  for (let cz = 0; cz < GRID_DIM; cz++) path.push(cellIndex(entryCx, cz));
  const step = exitCx > entryCx ? 1 : -1;
  for (let cx = entryCx + step; cx !== exitCx + step; cx += step) path.push(cellIndex(cx, GRID_DIM - 1));
  return path;
}

/**
 * 07 §3.2 R2 in full: up to 7 attempts (1 + up to 6 RESTARTs); the 7th
 * failure emits the L-path fallback instead of an 8th attempt.
 * @param {import('../../core/rng.js').Rng} S0 @param {number} entry @param {number} exit
 * @returns {{spine:number[], visited:Uint8Array, restartCount:number, fallbackUsed:boolean, maxConsecutiveBacktrack:number}}
 */
function buildSpine(S0, entry, exit) {
  let maxConsecutiveBacktrack = 0;
  for (let attempt = 0; attempt < 7; attempt++) {
    const result = attemptSpineWalk(S0, entry, exit);
    if (!result) continue; // RESTART — try again, up to 7 attempts total
    if (result.maxConsecutiveBacktrack > maxConsecutiveBacktrack) maxConsecutiveBacktrack = result.maxConsecutiveBacktrack;
    return { spine: result.spine, visited: result.visited, restartCount: attempt, fallbackUsed: false, maxConsecutiveBacktrack };
  }
  const spine = buildLPath(entry, exit);
  const visited = new Uint8Array(GRID_DIM * GRID_DIM);
  for (const c of spine) visited[c] = 1;
  return { spine, visited, restartCount: 6, fallbackUsed: true, maxConsecutiveBacktrack };
}

// ---------------------------------------------------------------------------
// R3 — Dead-end branches (S0)
// ---------------------------------------------------------------------------

/**
 * 07 §3.2 R3, verbatim. `visited` is mutated in place (shared with R2's
 * spine walk — "visited += nxt" continues the SAME set).
 * @param {import('../../core/rng.js').Rng} S0 @param {number[]} spine
 * @param {Uint8Array} visited @param {number} entry @param {number} exit
 * @returns {{branches:object[], branchCells:number[], deadEndTips:number[]}}
 */
function buildBranches(S0, spine, visited, entry, exit) {
  const nBranch = S0.int(2, 4);
  let cands = [];
  for (const cell of spine) {
    if (cell === entry || cell === exit) continue;
    if (neighboursOf(cell).some((n) => !visited[n.index])) cands.push(cell);
  }

  const branches = [];
  const branchCells = [];
  const deadEndTips = [];
  for (let b = 0; b < nBranch; b++) {
    if (cands.length === 0) break;
    const root = S0.pick(cands);
    cands = cands.filter((c) => c !== root);
    const len = S0.int(1, 2);
    let cur = root;
    const cells = [];
    for (let k = 0; k < len; k++) {
      const free = neighboursOf(cur).filter((n) => !visited[n.index]);
      if (free.length === 0) break;
      const nxt = S0.pick(free);
      visited[nxt.index] = 1;
      branchCells.push(nxt.index);
      cells.push(nxt.index);
      cur = nxt.index;
    }
    deadEndTips.push(cur);
    branches.push({ root, cells, tip: cur });
  }
  return { branches, branchCells, deadEndTips };
}

// ---------------------------------------------------------------------------
// R5 (phase 1) — shelf-candidate roll (S1), drawn at R5's own stream
// position; R6 — gates (S1); R7 — archetypes (S1); R5 (phase 2) — the
// elevation each cell actually ends up with, resolved AFTER R7. See the
// "R5-references-R7" section in this ticket's report for why this is split
// into three functions instead of one.
// ---------------------------------------------------------------------------

/**
 * 07 §3.2 R5's own `S1.next() < 0.18` roll, one draw per connected cell IN
 * CANONICAL ORDER (spine order then branch order — the only per-connected-
 * cell order the spec ever names, R7's). Drawn for every connected cell,
 * including entry/exit (the "cell is not entryCell/exitCell" clause is
 * applied here as a FILTER on the roll's result, not as a reason to skip
 * the draw — skipping it would desync `S1` the moment `entryCell`/
 * `exitCell` fell at a different position in a different seed).
 * @param {import('../../core/rng.js').Rng} S1 @param {number[]} connectedOrder
 * @param {number} entry @param {number} exit @returns {Uint8Array}
 */
function drawShelfRoll(S1, connectedOrder, entry, exit) {
  const wantsShelf = new Uint8Array(GRID_DIM * GRID_DIM);
  for (const cell of connectedOrder) {
    const roll = S1.next();
    if (roll < SHELF_ROLL_THRESHOLD && cell !== entry && cell !== exit) wantsShelf[cell] = 1;
  }
  return wantsShelf;
}

/**
 * 07 §3.2 R6: a gate for every 4-adjacent pair both in `connected`. Pair
 * enumeration order is UNSPECIFIED by the spec (only the per-gate draw
 * order — width then offset — is given); this walks the grid row-major
 * (`cz` outer, `cx` inner — `src/world/raster.js`'s own scan order) and
 * checks the East then North edge of each cell, visiting every undirected
 * edge exactly once. See this ticket's report.
 * @param {import('../../core/rng.js').Rng} S1 @param {Uint8Array} connectedFlag
 * @returns {{a:number, b:number, width:number, offset:number}[]}
 */
function drawGates(S1, connectedFlag) {
  const gates = [];
  for (let cz = 0; cz < GRID_DIM; cz++) {
    for (let cx = 0; cx < GRID_DIM; cx++) {
      const a = cellIndex(cx, cz);
      if (!connectedFlag[a]) continue;
      if (cx < GRID_DIM - 1) {
        const b = cellIndex(cx + 1, cz);
        if (connectedFlag[b]) gates.push({ a, b, width: S1.int(8, 14), offset: S1.int(-5, 5) });
      }
      if (cz < GRID_DIM - 1) {
        const b = cellIndex(cx, cz + 1);
        if (connectedFlag[b]) gates.push({ a, b, width: S1.int(8, 14), offset: S1.int(-5, 5) });
      }
    }
  }
  return gates;
}

/**
 * 07 §3.2 R7. Constraints A1-A6 applied before the weighted draw, per
 * cell, in canonical order. A3's "not 4-adjacent to another ravine" and
 * A5's per-archetype cap only ever look at ALREADY-decided neighbours
 * (forward-only) — sufficient to guarantee no two adjacent connected cells
 * both end up `ravine`, since whichever of the two is decided second always
 * sees the first's already-final archetype (see this ticket's report).
 * A6's first clause ("+1.20 shelf may not be ravine") needs no active
 * check here at all — see `finalizeElevations` below, which is what makes
 * that clause structurally true rather than separately enforced.
 * @param {import('../../core/rng.js').Rng} S1 @param {number[]} connectedOrder
 * @param {number} entry @param {number} exit @param {Uint8Array} deadEndFlag
 * @param {Uint8Array} wantsShelf
 * @returns {{archetypeOf:(string|null)[], w1FallbackCount:number}}
 */
function assignArchetypes(S1, connectedOrder, entry, exit, deadEndFlag, wantsShelf) {
  const archetypeOf = new Array(GRID_DIM * GRID_DIM).fill(null);
  const counts = Object.create(null);
  for (const id of ARCHETYPE_IDS) counts[id] = 0;
  let warcampCount = 0;
  let w1FallbackCount = 0;
  const cap = Math.ceil(connectedOrder.length / 2); // A5

  for (const cell of connectedOrder) {
    let chosen;
    if (cell === entry) {
      chosen = 'ash_flats'; // A1 — forced, no draw
    } else if (cell === exit) {
      chosen = 'ruin_field'; // A2 — forced, no draw
    } else {
      const candidates = [];
      const weights = [];
      for (const id of ARCHETYPE_IDS) {
        if (counts[id] >= cap) continue; // A5
        if (id === 'ravine') {
          if (deadEndFlag[cell]) continue; // A3: not a deadEnd tip
          if (neighboursOf(cell).some((n) => archetypeOf[n.index] === 'ravine')) continue; // A3: not adjacent to another ravine
        }
        if (id === 'warcamp') {
          if (warcampCount >= WARCAMP_CAP) continue; // A4
          if (wantsShelf[cell]) continue; // A6: a +1.20 shelf cell may not be warcamp
        }
        candidates.push(id);
        weights.push(ARCHETYPE_TABLE[id].weight);
      }
      if (candidates.length === 0) {
        chosen = 'ash_flats'; // documented fallback — no constraints, W1
        w1FallbackCount++;
      } else {
        chosen = S1.weighted(candidates, weights);
      }
    }
    archetypeOf[cell] = chosen;
    counts[chosen]++;
    if (chosen === 'warcamp') warcampCount++;
  }
  return { archetypeOf, w1FallbackCount };
}

/**
 * R5 phase 2 — resolves the elevation every connected cell actually gets,
 * now that R7's archetypes are final. No RNG here; this only combines
 * data already drawn (`wantsShelf`, from R5's own S1 position) with R7's
 * result. `archetype === 'ravine'` always wins over a `wantsShelf` roll —
 * this IS the mechanism A6's "(R5 already excludes it)" refers to: a
 * ravine cell's elevation can never be +1.20, so it can never BE a
 * "+1.20 shelf cell" regardless of its own roll.
 * @param {number[]} connectedOrder @param {(string|null)[]} archetypeOf @param {Uint8Array} wantsShelf
 * @returns {Float64Array}
 */
function finalizeElevations(connectedOrder, archetypeOf, wantsShelf) {
  const elevationOf = new Float64Array(GRID_DIM * GRID_DIM);
  for (const cell of connectedOrder) {
    const base = ARCHETYPE_TABLE[archetypeOf[cell]].terrace; // 0.00, or -2.20 for ravine
    if (base === 0 && wantsShelf[cell]) {
      const neighbourIsRavine = neighboursOf(cell).some((n) => archetypeOf[n.index] === 'ravine');
      elevationOf[cell] = neighbourIsRavine ? 0 : SHELF_ELEVATION;
    } else {
      elevationOf[cell] = base;
    }
  }
  return elevationOf;
}

// ---------------------------------------------------------------------------
// R6's ramp clause — WRLD-6/D-79/O-107 fix
// ---------------------------------------------------------------------------
// Found by the coordinator, not this file's own original pass: `07` §3.2 R6
// says verbatim that a gate between cells of differing elevation "becomes a
// ramp: `ceil(Δy / 0.40)` terrace steps of equal height across the 4 m
// band... Ramp width is `max(gateWidth, 3.0)`." The terrace projection below
// this function (unchanged in shape) only ever emitted ONE region per
// non-flat cell, inset 2.0 m from every edge alike — it never distinguished
// "this edge has a gate to a different-elevation neighbour" from "this edge
// faces void/a flat neighbour with no gate", so a gate onto a ravine/shelf
// cell had a bare `Δy` step (up to 2.20 m) sitting directly on the walkable
// path, over four times N3's 0.45 m limit. WRLD-6's O-99 fix (populating
// `nav.groundY` for real, making `passN3Slope` live) is what turned this
// from a silent gap into an actual fragmenting block — the ravine's own
// terrace wall was always meant to block (that IS I1's terrace-blocks-
// itself contract), but the GATED edge was never meant to.
//
// This function builds the missing ramp as additional `{elevation, bounds}`
// terrace regions, layered AFTER (so `terraceElevationAt`'s "later wins"
// rule makes them override) the base per-cell terrace regions above. Placed
// in `ridgewalk.js`, not `src/world/gen/wastes.js` or `src/world/height.js`:
// R6 (the gate) is this file's own pass, `layout.terraces` is this file's
// own return field, and `buildHeightField`/`terraceElevationAt` already
// accept an arbitrary-length terrace list with no change needed on the
// consuming side — the fix belongs entirely on the R5/R6 side of the split,
// exactly as the coordinator's grant framed the question.
//
// Geometry: `07` §3.2 R6's own gate definition already treats the gate as
// "a 4 m band straddling the edge" (2.0 m into each of the two cells) — the
// SAME 4 m the ramp clause reuses, and it is exactly `2 x TERRACE_INSET`
// (the per-cell terrace's own 2.0 m inset, above), so the ramp's outer edges
// land EXACTLY on the two cells' own terrace boundaries with no gap and no
// overlap. The 4 m band is divided into `steps` EQUAL sub-bands along the
// edge-perpendicular axis; sub-band `k` (0-indexed, nearest the LOWER-index
// cell `a` first) is assigned elevation `elev(a) + (k+1) * stepHeight`,
// `stepHeight = (elev(b) - elev(a)) / steps` — so sub-band 0 is one step
// away from `a`'s own native ground (a real, `<=0.45 m` transition) and the
// LAST sub-band (`k = steps-1`) lands EXACTLY on `elev(b)`, seamless with
// `b`'s own terrace region (or `b`'s native 0.00 m default, if `b` is
// flat) — `steps` transitions total, matching R6's own count, never
// `steps + 1`. Verified against R6's own worked number: `Δy = 2.20`
// (ravine<->flat) gives `steps = ceil(2.20/0.40) = 6`, `stepHeight ~ 0.367`,
// matching "6 steps of 0.367 m" verbatim.
//
// Sub-band width is `4.0 / steps` — for the only two `Δy` values R5/A6 ever
// produce (1.20 m shelf<->flat: 3 steps, 1.33 m each; 2.20 m ravine<->flat:
// 6 steps, 0.667 m each) this is always well over the 0.5 m raster cell
// size (`RASTER.CELL_SIZE`), so no single raster cell's centre can ever
// land inside a sub-band whose neighbour crosses more than one step
// boundary — the reason a narrower (e.g. 2 m, terraced-side-only) band was
// rejected: at 6 steps that would be 0.33 m per sub-band, UNDER one raster
// cell, which could silently skip a step and reintroduce exactly the bug
// this function exists to fix.
//
// Ramp WIDTH (`max(gateWidth, 3.0)`, along the edge) is centred on the
// gate's own `offset`, matching the gate's own walkable span exactly — a
// ramp not aligned with its own gate would be a second, unrelated bug.
/**
 * @param {object} descriptor @param {object[]} gates @param {Float64Array} elevationOf
 * @returns {object[]} additional `{elevation, bounds}` terrace regions, one per `ceil(|Δy|/0.40)` step of every gate with `Δy != 0`.
 */
function buildGateRampTerraces(descriptor, gates, elevationOf) {
  const BAND_TOTAL = 4.0; // 07 §3.2 R6 — the same 4 m band the gate itself spans
  const SLOPE_STEP = 0.40; // 07 §3.2 R6 — "ceil(Δy / 0.40)"
  const regions = [];

  for (const g of gates) {
    const elevA = elevationOf[g.a];
    const elevB = elevationOf[g.b];
    const deltaY = elevB - elevA;
    if (deltaY === 0) continue; // flat gate — no ramp, R6's own condition

    const steps = Math.ceil(Math.abs(deltaY) / SLOPE_STEP);
    const stepHeight = deltaY / steps;
    const bandStep = BAND_TOTAL / steps;
    const rampWidth = Math.max(g.width, 3.0); // 07 §3.2 R6, verbatim

    const posA = cellOf(g.a);
    const posB = cellOf(g.b);
    const centreA = cellCentre(descriptor, posA.cx, posA.cz);
    const centreB = cellCentre(descriptor, posB.cx, posB.cz);
    const eastWest = posA.cz === posB.cz; // same row -> shared edge is vertical (x fixed)

    // `dir`: +1 if `b` lies in the increasing-coordinate direction from the
    // shared edge, -1 otherwise — makes the perpendicular-axis mapping
    // below correct regardless of which of `a`/`b` is which side.
    const dir = eastWest ? (centreB.x > centreA.x ? 1 : -1) : (centreB.z > centreA.z ? 1 : -1);
    const edgeCoord = eastWest ? (centreA.x + centreB.x) / 2 : (centreA.z + centreB.z) / 2;
    const alongCoord = eastWest ? centreA.z : centreA.x; // same for a/b — same row/column

    for (let k = 0; k < steps; k++) {
      const dMin = -2.0 + k * bandStep;
      const dMax = -2.0 + (k + 1) * bandStep;
      const worldLo = edgeCoord + dMin * dir;
      const worldHi = edgeCoord + dMax * dir;
      const perpMin = Math.min(worldLo, worldHi);
      const perpMax = Math.max(worldLo, worldHi);
      const elevation = elevA + (k + 1) * stepHeight;

      regions.push({
        elevation,
        bounds: eastWest
          ? { minX: perpMin, maxX: perpMax, minZ: alongCoord + g.offset - rampWidth / 2, maxZ: alongCoord + g.offset + rampWidth / 2 }
          : { minX: alongCoord + g.offset - rampWidth / 2, maxX: alongCoord + g.offset + rampWidth / 2, minZ: perpMin, maxZ: perpMax },
      });
    }
  }

  return regions;
}

// ---------------------------------------------------------------------------
// Public: R1-R7, the macro layout
// ---------------------------------------------------------------------------

/**
 * Runs R1-R7 of 07-world-gen.md §3.2 over a fresh seed. Forks all seven
 * `07` §1.8 streams, in order, even though only S0/S1 are drawn from here
 * (S2-S6 are handed back live in `.streams` so a later caller — R8/R9's
 * dressing/boundary ticket, or this same file's own `placeEntries` below —
 * continues the SAME streams rather than forking fresh ones, which would
 * desync every later subsystem per O-98).
 * @param {number} seed
 * @param {object} [descriptor] — defaults to the shipped `ashen_wastes` descriptor.
 * @returns {object}
 */
export function generateRidgewalkLayout(seed, descriptor = ZONE_DESCRIPTORS_BY_ID.ashen_wastes) {
  const zoneRng = new Rng(seed);
  const S0 = zoneRng.fork(); // macro
  const S1 = zoneRng.fork(); // shape
  const S2 = zoneRng.fork(); // dress — not drawn here (R8, WRLD-6)
  const S3 = zoneRng.fork(); // spawn — not drawn here (R11, WRLD-9)
  const S4 = zoneRng.fork(); // loot — drawn by placeRidgewalkEntries (R10)
  const S5 = zoneRng.fork(); // light — not drawn here
  const S6 = zoneRng.fork(); // material — not drawn in the headless harness

  // R1
  const { entryCell, exitCell, forcedFallback } = drawEndpoints(S0);

  // R2
  const { spine, visited, restartCount, fallbackUsed, maxConsecutiveBacktrack } = buildSpine(S0, entryCell, exitCell);

  // R3
  const { branches, branchCells, deadEndTips } = buildBranches(S0, spine, visited, entryCell, exitCell);

  // R4
  const connectedOrder = spine.concat(branchCells);
  const connectedFlag = new Uint8Array(GRID_DIM * GRID_DIM);
  for (const c of connectedOrder) connectedFlag[c] = 1;
  const deadEndFlag = new Uint8Array(GRID_DIM * GRID_DIM);
  for (const c of deadEndTips) deadEndFlag[c] = 1;

  // R5 phase 1 (draw), R6, R7, R5 phase 2 (resolve) — S1's draw order
  // matches the document exactly; see the section header above.
  const wantsShelf = drawShelfRoll(S1, connectedOrder, entryCell, exitCell);
  const gates = drawGates(S1, connectedFlag);
  const { archetypeOf, w1FallbackCount } = assignArchetypes(S1, connectedOrder, entryCell, exitCell, deadEndFlag, wantsShelf);
  const elevationOf = finalizeElevations(connectedOrder, archetypeOf, wantsShelf);

  // A convenience projection of `elevationOf` into `src/world/height.js`'s
  // own `{elevation, bounds}` terrace shape (07 §1.3), inset 2.0 m from the
  // cell boundary (07 §3.2 R5's own note) — only for cells that actually
  // carry a non-zero elevation. NOT wired into `height.js`/`world` by this
  // ticket (that wiring is a later ticket's, per this ticket's brief); this
  // is plain data on the return value for that ticket to consume.
  const terraces = [];
  const halfCell = descriptor.cellSize / 2;
  const inset = 2.0;
  for (const cell of connectedOrder) {
    const elevation = elevationOf[cell];
    if (elevation === 0) continue;
    const { cx, cz } = cellOf(cell);
    const c = cellCentre(descriptor, cx, cz);
    terraces.push({
      elevation,
      bounds: {
        minX: c.x - halfCell + inset,
        maxX: c.x + halfCell - inset,
        minZ: c.z - halfCell + inset,
        maxZ: c.z + halfCell - inset,
      },
    });
  }
  // WRLD-6/D-79/O-107 — R6's own ramp clause, appended AFTER the base
  // per-cell regions above so `terraceElevationAt`'s "later wins" rule
  // gives them priority over the outer edge of a base region's own inset
  // (they should never actually overlap — see `buildGateRampTerraces`'s own
  // header for why the two are seamless at the 2.0 m boundary — but the
  // ordering is still the correct, documented one). No RNG draw: every
  // input (`gates`, `elevationOf`) is already-drawn R5/R6 data.
  for (const region of buildGateRampTerraces(descriptor, gates, elevationOf)) terraces.push(region);

  return {
    seed,
    entryCell,
    exitCell,
    forcedFallbackR1: forcedFallback,
    spine,
    branches,
    branchCells,
    deadEndTips,
    connected: connectedOrder,
    connectedFlag,
    archetypeOf,
    elevationOf,
    terraces,
    gates,
    restartCount,
    fallbackUsed,
    maxConsecutiveBacktrack,
    w1FallbackCount,
    w1Eligible: connectedOrder.length - 2, // every connected cell except entry/exit, which never draw
    streams: { S0, S1, S2, S3, S4, S5, S6 },
  };
}

// ---------------------------------------------------------------------------
// Public: R10 — entries, exit, chests
// ---------------------------------------------------------------------------

/**
 * 07 §3.2 R10. Continues drawing from the SAME `S1`/`S4` `Rng` instances a
 * `generateRidgewalkLayout` call handed back (or from whatever later state
 * those streams are in, if a caller ran R9's boundary draws on `S1` in
 * between — see this ticket's report, "How R9's gap was handled").
 *
 * `nav.snap` (07 §3.2 R10's own pseudocode) needs a nav grid that does not
 * exist at layout time (R11's note: pure stages run before
 * `nav.rebuild()`), and this file may not import `src/nav/` at all (rule 2).
 * Every chest position below is therefore returned UNSNAPPED
 * (`unsnappedPosition`), for a later stage — the one that already has a
 * live `NavGrid` — to snap.
 * @param {ReturnType<typeof generateRidgewalkLayout>} layout
 * @param {object} [descriptor]
 * @param {{S1: import('../../core/rng.js').Rng, S4: import('../../core/rng.js').Rng}} [streams]
 * @returns {object}
 */
export function placeRidgewalkEntries(layout, descriptor = ZONE_DESCRIPTORS_BY_ID.ashen_wastes, streams = layout.streams) {
  const { S1, S4 } = streams;
  const entryCellPos = cellOf(layout.entryCell);
  const exitCellPos = cellOf(layout.exitCell);
  const entryCentre = cellCentre(descriptor, entryCellPos.cx, entryCellPos.cz);
  const exitCentre = cellCentre(descriptor, exitCellPos.cx, exitCellPos.cz);

  const entries = {
    portal_from_town: {
      x: entryCentre.x + S1.range(-4, 4),
      z: entryCentre.z - 8.0,
      facing: Math.PI / 2,
    },
    // "the descent landing, 3.0 m south of the stair head" — no facing is
    // given anywhere in 07 §3.2 R10 for this entry; left `null` rather than
    // inventing one (this ticket's rule: "if the specification does not
    // give you a number, stop and ask — do not choose one").
    descent_return: {
      x: exitCentre.x,
      z: exitCentre.z + 8.0 - 3.0,
      facing: null,
    },
  };

  const stairCentre = { x: exitCentre.x, z: exitCentre.z + 8.0 };
  const exitDef = {
    toZone: descriptor.exits[0].toZone,
    toEntryTag: descriptor.exits[0].tag,
    stair: { x: stairCentre.x, z: stairCentre.z, width: 6, depth: 4 },
    // "trigger rect 6x4m on its south face" — read as flush against the
    // footprint's south edge, extending 2.0 m further south (a reasonable
    // geometric reading of "on its south face"; see this ticket's report).
    trigger: { x: stairCentre.x, z: stairCentre.z - 2 - 1, width: 6, depth: 2 },
  };

  const count = S4.int(descriptor.chestCount.min, descriptor.chestCount.max);
  const chests = [];
  const usedCells = new Uint8Array(GRID_DIM * GRID_DIM);

  function makeChest(cell) {
    const { cx, cz } = cellOf(cell);
    const c = cellCentre(descriptor, cx, cz);
    const offset = S4.disc(6.0);
    return {
      cell,
      unsnappedPosition: { x: c.x + offset.x, z: c.z + offset.z },
      facing: S4.range(0, Math.PI * 2),
      treasureClass: descriptor.treasureClass,
      subSeed: S4.u32(),
    };
  }

  const firstN = Math.min(count, layout.deadEndTips.length);
  for (let i = 0; i < firstN; i++) {
    const cell = layout.deadEndTips[i]; // in branch order
    chests.push(makeChest(cell));
    usedCells[cell] = 1;
  }

  const remainder = count - firstN;
  if (remainder > 0) {
    const ranked = layout.connected
      .filter((c) => !usedCells[c])
      .map((c) => ({ cell: c, score: ARCHETYPE_TABLE[layout.archetypeOf[c]].props * ARCHETYPE_TABLE[layout.archetypeOf[c]].densityX }))
      .sort((a, b) => b.score - a.score); // stable sort (ES2019+): ties keep canonical `connected` order
    for (let i = 0; i < remainder && i < ranked.length; i++) {
      const cell = ranked[i].cell;
      chests.push(makeChest(cell));
      usedCells[cell] = 1;
    }
  }

  return { entries, exit: exitDef, chests };
}

/**
 * Convenience: R1-R7 followed immediately by R10 on the same seed. See
 * `placeRidgewalkEntries`'s own doc for the R9 gap this skips over (R9 is
 * WRLD-6's, not built yet, and also draws from `S1`).
 * @param {number} seed @param {object} [descriptor]
 * @returns {object}
 */
export function generateRidgewalk(seed, descriptor = ZONE_DESCRIPTORS_BY_ID.ashen_wastes) {
  const layout = generateRidgewalkLayout(seed, descriptor);
  const { entries, exit, chests } = placeRidgewalkEntries(layout, descriptor);
  return { ...layout, entries, exit, chests };
}
