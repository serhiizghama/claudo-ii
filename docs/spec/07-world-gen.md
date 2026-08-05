# 07 — World Generation and Zones

**Claudo II: Lord of Instruction** — the specification for the `world`
subsystem's geometry: the hand-authored town, the two seeded combat zones, the
boss arena, the navigation grid that is built from them, and the transitions
between them.

**Binding documents.** `01-data-model.md` defines `ZoneDescriptor`,
`ZoneInstance`, `NavGrid`, `NAV_FLAG`, `SpawnPoint` and `PackDescriptor`; this
document uses those records and those field names and invents no parallel ones.
`02-api-contracts.md` defines the public surface of `world` and `nav`;
everything here is implementable through exactly those methods except for the
six items listed in
[§13 Additions requested to `02-api-contracts.md`](#13-additions-requested-to-02-api-contractsmd).

**Scope.** `world` produces geometry, colliders, surfaces, entries, portals,
chests, `SpawnPoint`s and `PackDescriptor`s. It never spawns an actor, never
computes damage and never decides what a pack is made of beyond its archetype
and rank. `ai` reads what `world` produced and puts monsters on it.

---

## Table of contents

1. [Coordinate system, units and conventions](#1-coordinate-system-units-and-conventions)
2. [Last Bastion — the hand-authored town](#2-last-bastion--the-hand-authored-town)
3. [Ashen Wastes — the Ridgewalk generator](#3-ashen-wastes--the-ridgewalk-generator)
4. [Bonereach — the BSP hall generator](#4-bonereach--the-bsp-hall-generator)
5. [Altar of Instruction — the fixed arena](#5-altar-of-instruction--the-fixed-arena)
6. [The navigation grid](#6-the-navigation-grid)
7. [Generator guarantees and their validation](#7-generator-guarantees-and-their-validation)
8. [Spawning](#8-spawning)
9. [Props, containers and world objects](#9-props-containers-and-world-objects)
10. [Zone transitions and the town portal](#10-zone-transitions-and-the-town-portal)
11. [Lighting anchors](#11-lighting-anchors)
12. [Implementation order](#12-implementation-order)
13. [Additions requested to `02-api-contracts.md`](#13-additions-requested-to-02-api-contractsmd)

---

## 1. Coordinate system, units and conventions

### 1.1 Axes and units

| Quantity | Convention |
|---|---|
| Handedness | Right-handed, **Y up** (Three.js default) |
| `+X` | East. Screen-right, exactly. |
| `+Z` | North. Screen-up and *away* from the camera. |
| `+Y` | Up. Ground is at or near `y = 0`. |
| Distance | Metres. Every number in this document is metres unless labelled otherwise. |
| Angle | Radians. `facing = 0` is `+X`, positive is counter-clockwise seen from above, wrapped to `(−π, π]`. |
| Zone origin | The **centre** of the zone. A `sizeX × sizeZ` zone spans `[−sizeX/2, +sizeX/2] × [−sizeZ/2, +sizeZ/2]`. |

`ZoneInstance.boundsMinX/MinZ/MaxX/MaxZ` therefore always straddle the origin,
which is what the example in `01-data-model.md` §9.2 shows (`−48 … +48` for a
96 m zone).

### 1.2 The three lattices

Three different grids exist and are never confused:

| Lattice | Pitch | Owner | Purpose |
|---|---|---|---|
| **Nav cell** | **0.5 m** | `nav` | Walkability, A*, flow field. `NavGrid.cellSize`, constant in every zone. |
| **Build lattice** | **1.0 m** | `world` | The unit the generators lay out rooms, corridors and footprints on. Exactly **2 × 2 nav cells**. |
| **Macro cell** | **24 m** | `world` | `ZoneDescriptor.cellSize`. Open zones only (Ashen Wastes). Exactly **24 × 24 build cells** and **48 × 48 nav cells**. |

Every generator emits coordinates on the **build lattice** (whole metres) or on
half-metre offsets from it. Nothing is ever placed on an irrational offset — a
footprint edge always falls on a nav-cell boundary, so rasterisation is exact
rather than approximate. This is the single most important rule in the
generator: **1 build cell = 2 nav cells = 4 nav cells of area**, and no
footprint ever half-covers a nav cell.

Derived grid sizes:

| zone | size (m) | nav `width` × `height` | cells | build lattice | macro |
|---|---|---|---:|---|---|
| `last_bastion` | 60 × 60 | 120 × 120 | 14 400 | 60 × 60 | — |
| `ashen_wastes` | 96 × 96 | 192 × 192 | 36 864 | 96 × 96 | 4 × 4 |
| `bonereach` | 112 × 112 | 224 × 224 | 50 176 | 112 × 112 | — |
| `altar_of_instruction` | 48 × 48 | 96 × 96 | 9 216 | 48 × 48 | — |

The 192 × 192 and 224 × 224 figures match `01-data-model.md` §9.3 exactly.

### 1.3 Height policy — **stepped terraces plus a cosmetic lattice**

The world is **not** flat and **not** heightmapped. It is a **terrace field**:

1. Every zone declares a small set of **terraces**, each a closed region on the
   build lattice with one constant elevation. The town has exactly one
   (`y = 0.00`). Ashen Wastes has up to four. Bonereach has two (hall floor and
   the descent shaft). The Altar has three (approach, arena floor, altar dais).
2. On top of the terrace elevation, a **cosmetic displacement** of amplitude
   **±0.12 m** is added. It is sampled on a **2 m lattice** with a 3-octave
   value-noise function seeded from the `S1 shape` stream, and **bilinearly
   interpolated** to any query point.
3. `world.groundHeight(x, z)` returns `terrace(x, z) + noise(x, z)` — the
   analytic function. `NavGrid.height[i]` stores exactly that value sampled at
   the cell centre. The two never disagree, because they are the same function.

```
groundHeight(x, z):
    t  = terraceElevationAt(x, z)          // constant per terrace region
    u  = (x - originX) / 2.0               // 2 m lattice coordinates
    v  = (z - originZ) / 2.0
    n  = bilerp(latticeNoise, u, v)        // precomputed (sizeX/2 + 1)^2 table
    return t + (n - 0.5) * 0.24
```

**Why this and not a heightmap.** A continuous heightmap forces the nav grid to
store slope, forces A* to reason about traversal cost per edge, forces the
camera to collide, and makes a click-to-move game feel like it is fighting you.
A pure flat plane, on the other hand, makes a 96 × 96 m zone read as a
tabletop under a 52° camera. Terraces buy the silhouette — a ravine, a sunken
crypt, a raised altar — for a fixed, tiny cost: **one integer per nav cell that
the flood fill already computes**.

**Consequences, stated explicitly:**

| Consequence | Rule |
|---|---|
| Nav | A cell is `blocked` when any 4-neighbour's height differs by more than **0.45 m**. Terrace walls therefore block themselves; no separate collider is authored for them. |
| Nav | Ramps between terraces are authored as **terrace regions of their own** with an elevation interpolated in ≤ 0.40 m steps, so consecutive steps never trip the 0.45 m rule. A ramp is at minimum **3.0 m wide** and **at most 6 steps**, i.e. a maximum terrace-to-terrace drop of **2.40 m**. |
| Actors | `Actor.y` is `world.groundHeight(x, z) + hoverY`. There is no vertical velocity, no jump, and no falling. Walking off a terrace is impossible because the lip is `blocked`. |
| Camera | The camera does not collide and does not adapt to height. It orbits the player at a fixed offset. A 2.4 m terrace drop shifts the whole frame by 2.4 m of world height; because the pitch is fixed, the framing is identical. |
| Projectiles | `physics` is 2.5D: a projectile's height interval is relative to the ground at its own `(x, z)`, so a bolt fired across a ravine flies over it and hits the far lip's collider. |
| Shadows | Terrace lips are the only geometry that casts a long shadow onto flat ground. Cascade 0 (0–14 m) resolves them; nothing further needs a cascade change. |

### 1.4 The camera footprint — the generator's actual design constraint

Fixed camera: pitch **52°**, distance **22 m**, vertical FOV **35°**, aspect
**16 : 9**, azimuth **fixed at 0** (the camera sits due south of the player and
looks north). Everything below follows from those four numbers and nothing else.

```
camera height above the player's ground plane  = 22 · sin 52° = 17.336 m
camera setback along −Z                        = 22 · cos 52° = 13.545 m
horizontal half-FOV = atan(tan 17.5° · 16/9)   = 29.269°
```

| Quantity | Value |
|---|---|
| Ground visible from | **6.48 m** to **25.22 m** ahead of the camera |
| Ground visible relative to the **player** | **7.06 m** behind (toward the camera) to **11.68 m** ahead |
| Visible depth | **18.74 m** |
| Width at the near edge | **20.75 m** |
| Width at the far edge | **34.31 m** |
| Visible ground area | ≈ **515 m²** — a trapezoid, not a rectangle |
| Pixels per metre at 1080p, near edge | **92.6** |
| … at the player | **77.9** |
| … at the far edge | **50.4** |

**Design rules that fall straight out of this:**

1. **A macro cell is 24 × 24 m; the frame is 18.7 m deep.** The player never
   sees a whole cell at once. Cell-scale composition (a ruin, a grove) reads
   as a *place*, not as a tile, precisely because its edges are always off
   screen. This is why 24 m was chosen and it is not negotiable downward.
2. **Nothing below 2 cm of feature size is ever resolved.** One pixel at the
   far edge is 19.8 mm. Ground materials get a **2 m detail tile at 1024²**
   (512 texels/m) triplanar-projected, plus a **64 m macro variation map at
   512²** (8 texels/m) to break tiling. No ground texture is ever authored at
   world scale.
3. **Culling.** Any object whose bounding sphere lies outside the trapezoid
   expanded by 4 m is not submitted. At 96 × 96 m that culls **94 %** of the
   zone every frame, which is the entire reason a 900-prop zone fits in the
   draw-call budget.

### 1.5 The Occlusion Plane

The camera is south of the player, so the *only* geometry that can hide the
player is geometry to the player's **−Z**. From the camera eye at 17.336 m down
to the player's chest at 1.00 m over a 13.545 m run:

```
occlusion plane:   y  ≤  1.00 + 1.206 · s        s = P.z − z,  0 ≤ s ≤ 13.545
slope 1.206  =  50.34°
```

An occluder only matters if it is inside the player's silhouette in screen X,
which at this camera is a slab of **±1.2 m** in world X. So:

> **Occlusion Plane Rule.** For every walkable cell `P` and every static solid
> point `(x, y, z)` with `|x − P.x| ≤ 1.2` and `P.z − 13.545 ≤ z ≤ P.z`, the
> solid must satisfy `y ≤ 1.00 + 1.206 · (P.z − z)`.

Three corollaries the generators are built around:

- **Anything under 1.00 m never occludes anything.** Kerbs, plinths, rubble,
  low walls, ash drifts, coffins and chests are free.
- **A roof that rises toward the camera at ≤ 50° is always legal**, at any
  height, however close. Gothic steep-pitched roofs facing south satisfy this
  by construction, which is the entire architectural language of Last Bastion.
- **A wall running north–south (constant X) never occludes**, because it is
  never inside the ±1.2 m slab of a walkable cell that is not inside the wall.
  Only walls running east–west (constant Z) are a risk, and only on their
  north side.

`tools/mapgen.mjs` asserts the rule directly (invariant **I8**, §7).

### 1.6 Surfaces

Every ground nav cell and every collider carries exactly one `SURFACE` value
from `01-data-model.md` §1.8. `world.surfaceAt(x, z)` returns the ground
surface; a collider's surface is carried on its footprint record. The zones use:

| zone | ground surfaces | collider surfaces |
|---|---|---|
| `last_bastion` | `stone`, `dirt`, `sand`, `water` | `stone`, `wood`, `metal`, `water` |
| `ashen_wastes` | `ash`, `dirt`, `stone`, `bone` | `stone`, `wood`, `bone`, `ash` |
| `bonereach` | `stone`, `bone`, `dirt`, `water` | `stone`, `bone`, `metal`, `wood` |
| `altar_of_instruction` | `stone`, `ash`, `bone` | `stone`, `crystal`, `metal`, `bone` |

`grass`, `flesh` and `blood` are never authored: `grass` does not exist in this
setting, and `flesh`/`blood` are produced at runtime by `fx` decals, which
report their own surface to `audio`.

### 1.7 `Footprint` — the collider record

`02-api-contracts.md` §4 names `Footprint` in `physics.addStatic()` but does not
define it. `world` is its only producer. The shape it emits is:

```js
const Footprint = {
  id:        0,            // int, index in world.staticFootprints
  kind:      'box',        // 'box' | 'circle' | 'convex'
  x: 0, z: 0,              // metres, centre on the XZ plane
  halfW:     1.0,          // metres, X half-extent   ('box')
  halfL:     1.0,          // metres, Z half-extent   ('box')
  radius:    0.0,          // metres                  ('circle')
  points:    null,         // Float32Array [x0,z0,x1,z1,…] CCW, ≤ 8 verts ('convex')
  rotation:  0,            // radians about +Y; 'box' only, always a multiple of π/2
  baseY:     0.0,          // metres, bottom of the solid
  topY:      2.0,          // metres, top of the solid — this is what §1.5 tests
  surface:   'stone',      // SURFACE
  navBlock:  true,         // false → visual only (a fence rail, an overhang)
  destructible: false,     // true → also spawned as an ACTOR_KIND.prop
};
```

`rotation` is restricted to multiples of π/2 for boxes so that the nav
rasteriser's fast path (axis-aligned scanline) covers 96 % of all footprints;
anything genuinely diagonal is authored as `convex`.

### 1.8 Determinism — the RNG stream layout

`world` takes one `ctx.rng.fork()` in `init()` and never uses it for layout.
Layout uses a stream constructed **from the layout seed only**, per the
determinism contract (`ARCHITECTURE.md`: *"Zone layout seeds are
`hash(worldSeed, zoneId, runIndex)` — never wall-clock"*):

```js
const seed = world.seedFor(zoneId, runIndex);   // = hash(worldSeed, zoneId, runIndex)
const zoneRng = new Rng(seed);

// Forked ONCE, in this exact order, before any draw is taken:
const S0 = zoneRng.fork();   // macro    — cell grid, spine walk, BSP splits, room order
const S1 = zoneRng.fork();   // shape    — terraces, room insets, corridor elbows, boundary
const S2 = zoneRng.fork();   // dress    — prop kind, count, position, rotation, scale
const S3 = zoneRng.fork();   // spawn    — spawn points, pack composition, rank, affixes
const S4 = zoneRng.fork();   // loot     — chest placement and each chest's own sub-seed
const S5 = zoneRng.fork();   // light    — light-anchor placement and flicker phase
const S6 = zoneRng.fork();   // material — per-instance tint, wear and UV-offset seeds
```

**The reason the streams are split this way is that it makes the generator
editable.** Changing a prop table draws only from `S2`; the spine, the rooms,
the packs and the chests are byte-identical afterwards. A single shared stream
would mean that every dressing tweak reshuffles the whole map and invalidates
every `tools/mapgen.mjs` fixture. Stream splitting is not a nicety here — it is
what makes the 200-seed regression suite usable.

Within a stream, **draw order is the document order of the algorithm steps in
§3, §4 and §5.** Any implementation that reorders two draws changes the map and
is a regression, caught by the golden fixtures in §7.4.

`S6` is drawn during geometry build, which does not run in the headless
harness. It is forked anyway, so that `S0`–`S5` land at identical positions in
Node and in the browser.

---

## 2. Last Bastion — the hand-authored town

### 2.1 Descriptor

```js
{
  id: 'last_bastion',  displayName: 'Last Bastion',
  kind: 'town',        generator: 'handauthored',
  sizeX: 60, sizeZ: 60, cellSize: 0,
  monsterLevel: 0,
  packCount:  { min: 0, max: 0 },
  packSize:   { min: 0, max: 0 },
  densityTarget: 0,  champChance: 0,  uniqueChance: 0,
  bestiary: [],
  surfaces: ['stone', 'dirt', 'sand', 'water'],
  lightingPreset: 'bastion_night',
  fogPreset: 'bastion',
  ambientAudio: 'bastion',
  treasureClass: null,
  exits:     [{ toZone: 'ashen_wastes', tag: 'portal_from_town' }],
  entryTags: ['town_start', 'from_wastes', 'town_portal_return'],
  chestCount: { min: 0, max: 0 },
  propBudget: 520,
}
```

The town is **flat**: one terrace at `y = 0.00`, and the cosmetic displacement
amplitude is **0.00 m** — it is paved, and pavement that undulates reads as
subsidence, not as craft. The only elevation changes are the portal pad
(`+0.30 m`), the brazier plinth (`+0.55 m`) and the cistern (`−0.35 m`), all
authored as explicit terrace regions.

### 2.2 How a hand-authored layout is expressed in code

**Chosen format: a frozen placement list in a plain-data ES module.**
`src/world/data/last_bastion.js` exports seven frozen arrays and nothing else.
It imports nothing — not `three`, not another subsystem, not even a helper —
so `tools/mapgen.mjs` and every unit test can read it in Node directly.

A tilemap literal was considered and rejected: at 0.5 m resolution a 60 × 60 m
town is 14 400 glyphs, which nobody can edit; at 2 m resolution it cannot
express a 1.6 m kerb, a 2.60 m eave or a facing angle. A build script was
rejected because a script is code, and code cannot be diffed for a level-design
change. A placement list is data, is diffable line by line, and every record is
independently meaningful.

```js
/** src/world/data/last_bastion.js — data only. Imports nothing. */

/** Terrain terraces. First match wins; the last entry is the default. */
export const TERRACES = Object.freeze([
  { id: 'portal_pad', shape: 'circle', x: 0, z: -17, radius: 1.8,  y:  0.30 },
  { id: 'brazier',    shape: 'rect',   x0: -3, z0:  1, x1:  3, z1:  7, y:  0.55 },
  { id: 'cistern',    shape: 'rect',   x0: -12, z0: -22, x1: -4, z1: -16, y: -0.35 },
  { id: 'ground',     shape: 'all',                                    y:  0.00 },
]);

/**
 * Structures. Every entry becomes 1..N Footprints and one merged mesh.
 * `roof` is 'pitch_s' (ridge toward −Z, the camera-legal default), 'flat',
 * or 'crenel' (a wall walk). `eaveY` is the height of the NORTH face and is
 * what the Occlusion Plane Rule tests.
 */
export const STRUCTURES = Object.freeze([
  // id            x      z    halfW halfL  eaveY ridgeY roof       surface  kind
  { id:'wall_n_w', x:-18, z: 28, halfW:12.0, halfL:2.0, eaveY:6.00, ridgeY:6.00, roof:'crenel', surface:'stone', kind:'wall'  },
  { id:'wall_n_e', x: 18, z: 28, halfW:12.0, halfL:2.0, eaveY:6.00, ridgeY:6.00, roof:'crenel', surface:'stone', kind:'wall'  },
  { id:'gatehouse',x:  0, z: 27, halfW: 6.0, halfL:3.0, eaveY:9.20, ridgeY:9.20, roof:'crenel', surface:'stone', kind:'gate'  },
  { id:'gate_leaf',x:  0, z: 27, halfW: 2.0, halfL:3.0, eaveY:5.40, ridgeY:5.40, roof:'flat',   surface:'metal', kind:'door'  },
  { id:'wall_w',   x:-29, z:  8, halfW: 1.0, halfL:18.0,eaveY:6.00, ridgeY:6.00, roof:'crenel', surface:'stone', kind:'wall'  },
  { id:'wall_e',   x: 29, z:  8, halfW: 1.0, halfL:18.0,eaveY:6.00, ridgeY:6.00, roof:'crenel', surface:'stone', kind:'wall'  },
  { id:'para_w',   x:-29, z:-19, halfW: 1.0, halfL: 9.0,eaveY:1.10, ridgeY:1.10, roof:'flat',   surface:'stone', kind:'wall'  },
  { id:'para_e',   x: 29, z:-19, halfW: 1.0, halfL: 9.0,eaveY:1.10, ridgeY:1.10, roof:'flat',   surface:'stone', kind:'wall'  },
  { id:'para_s',   x:  0, z:-27.5,halfW:29.0,halfL: 0.7,eaveY:1.10, ridgeY:1.10, roof:'flat',   surface:'stone', kind:'wall'  },
  { id:'chapel',   x:-17, z: 15, halfW: 5.0, halfL:5.0, eaveY:2.80, ridgeY:6.80, roof:'pitch_s',surface:'stone', kind:'house' },
  { id:'vault',    x: 17, z: 16, halfW: 5.0, halfL:4.0, eaveY:2.80, ridgeY:5.60, roof:'pitch_s',surface:'stone', kind:'house' },
  { id:'forge',    x:-20, z: -3, halfW: 8.0, halfL:5.0, eaveY:2.60, ridgeY:6.40, roof:'pitch_s',surface:'stone', kind:'house' },
  { id:'loom',     x: 20, z:  1, halfW: 6.0, halfL:5.0, eaveY:2.60, ridgeY:6.20, roof:'pitch_s',surface:'wood',  kind:'house' },
  { id:'ruin',     x: 10, z:-21, halfW: 4.0, halfL:3.0, eaveY:2.20, ridgeY:3.40, roof:'pitch_s',surface:'stone', kind:'ruin'  },
]);

/** Non-walkable kerbs. One is emitted along the north face of every 'house'. */
export const KERBS = Object.freeze([
  { id:'kerb_chapel', x:-17, z: 20.8, halfW:5.0, halfL:0.8, y:0.45, surface:'stone' },
  { id:'kerb_vault',  x: 17, z: 20.8, halfW:5.0, halfL:0.8, y:0.45, surface:'stone' },
  { id:'kerb_forge',  x:-20, z:  2.8, halfW:8.0, halfL:0.8, y:0.45, surface:'stone' },
  { id:'kerb_loom',   x: 20, z:  6.8, halfW:6.0, halfL:0.8, y:0.45, surface:'stone' },
  { id:'kerb_ruin',   x: 10, z: -17.2,halfW:4.0, halfL:0.8, y:0.45, surface:'stone' },
]);

/** Ground surface painting. Later entries paint over earlier ones. */
export const GROUND = Object.freeze([
  { x0:-30, z0:-30, x1: 30, z1: 30, surface:'sand'  },   // base
  { x0:-29, z0:-26, x1: 29, z1: -9, surface:'dirt'  },   // south terrace
  { x0:-29, z0: -9, x1: 29, z1: 26, surface:'stone' },   // the Ember Court
  { x0:-12, z0:-22, x1: -4, z1:-16, surface:'water' },   // cistern
]);

/** NPCs. `world.npcs` returns these; `ai` instantiates them on zone:ready. */
export const NPCS = Object.freeze([
  { id:'veren',        archetypeId:'npc_veren',   x:-10.6, z: -3.0, facing: 0.000, radius:2.2,
    role:'vendor',     services:['buy','sell','repair'] },
  { id:'isa',          archetypeId:'npc_isa',     x: 12.6, z:  1.0, facing: 3.142, radius:2.2,
    role:'artisan',    services:['identify','sockets_future'] },
  { id:'stash_keeper', archetypeId:'npc_keeper',  x: 10.6, z: 16.8, facing: 3.142, radius:2.2,
    role:'stash',      services:['stash'] },
  { id:'kaira',        archetypeId:'npc_kaira',   x:-10.6, z: 16.8, facing: 0.000, radius:2.6,
    role:'quest',      services:['quest'] },
]);

/** Everything the player can click that is not an NPC. */
export const INTERACTABLES = Object.freeze([
  { id:'stash_chest',  kind:'stash',   x: 12.0, z: 16.8, radius:2.4, surface:'wood'  },
  { id:'portal_pad',   kind:'portal',  x:  0.0, z:-17.0, radius:2.6, surface:'stone' },
  { id:'gate_exit',    kind:'exit',    x:  0.0, z: 23.2, radius:0.0, surface:'stone',
    trigger:{ x0:-2.5, z0:22.4, x1:2.5, z1:24.0 },
    toZone:'ashen_wastes', toEntryTag:'portal_from_town' },
]);

/** entryTag → placement. Consumed by world.entry(). */
export const ENTRIES = Object.freeze([
  { tag:'town_start',          x: 0.0, z:-11.0, facing: 1.5708 },
  { tag:'from_wastes',         x: 0.0, z: 20.5, facing:-1.5708 },
  { tag:'town_portal_return',  x: 0.0, z:-14.6, facing: 1.5708 },
]);

/** Static light anchors — see §11. Exactly six; the town never rebinds a slot. */
export const LIGHTS = Object.freeze([
  { id:'l_brazier', x:  0.0, y:2.35, z:  4.0, colour:[1.00,0.55,0.22], intensity:9.0, radius:14.0, flicker:0.30 },
  { id:'l_forge',   x:-14.0, y:1.60, z: -3.0, colour:[1.00,0.42,0.14], intensity:5.5, radius: 9.0, flicker:0.45 },
  { id:'l_gate',    x:  0.0, y:4.80, z: 24.2, colour:[0.86,0.78,0.52], intensity:4.0, radius:11.0, flicker:0.08 },
  { id:'l_chapel',  x:-12.4, y:2.10, z: 15.0, colour:[0.72,0.80,1.00], intensity:3.2, radius: 8.0, flicker:0.05 },
  { id:'l_vault',   x: 12.4, y:2.10, z: 16.8, colour:[0.90,0.74,0.40], intensity:3.0, radius: 8.0, flicker:0.10 },
  { id:'l_portal',  x:  0.0, y:1.20, z:-17.0, colour:[0.42,0.55,1.00], intensity:4.5, radius:10.0, flicker:0.18 },
]);

/** Instanced dressing. `n` is the exact count; positions come from POINTS. */
export const PROPS = Object.freeze([
  { proto:'crate_wood',    n: 34 }, { proto:'barrel_wood',   n: 21 },
  { proto:'sack_cloth',    n: 26 }, { proto:'market_stall',  n:  6 },
  { proto:'cart_broken',   n:  4 }, { proto:'lantern_post',  n: 12 },
  { proto:'banner_tattered', n: 18 }, { proto:'rubble_small', n: 62 },
  { proto:'planter_stone', n: 14 }, { proto:'anvil',         n:  2 },
  { proto:'weapon_rack',   n:  5 }, { proto:'bench_stone',   n:  9 },
  { proto:'grave_marker',  n: 11 }, { proto:'chain_hanging', n:  8 },
  { proto:'ash_drift',     n: 44 }, { proto:'brazier_small', n:  6 },
]);
/** Exact placements, authored. 282 entries: [protoIndex, x, z, facingDeg, scale]. */
export const POINTS = Object.freeze(new Float32Array([ /* 282 × 5 */ ]));
```

**Format rules, binding:**

1. **Every array is `Object.freeze`d and contains only numbers, strings, `null`
   and frozen plain objects.** No functions, no class instances, no `THREE.*`.
2. **Coordinates are on the build lattice** — whole metres, or `x.5` when a
   centre falls between build cells. A record whose extents do not land on a
   0.5 m boundary fails the load-time assertion in dev builds.
3. **`STRUCTURES` order is the merge order** and therefore the order footprints
   receive their `id`. Reordering the array changes `world.staticFootprints`
   indices, so it is a fixture-breaking change and mapgen will say so.
4. **`POINTS` is a flat `Float32Array`, not an array of objects.** 282 props ×
   5 floats = 5 640 bytes, one allocation, and the instance-matrix build is a
   single tight loop with no property lookups.
5. **`PROPS[i].n` must equal the number of `POINTS` entries with
   `protoIndex === i`.** Asserted at load; a mismatch is a hard failure, not a
   silent truncation.
6. The town draws **no** random numbers. `S0`–`S6` are forked for it (so the
   stream layout is uniform across zones) and never advanced. Two visits to
   Last Bastion are byte-identical, including prop rotations.

### 2.3 The map

One glyph = **2 × 2 m**. Top row is `z ∈ [28, 30)`, bottom row is
`z ∈ [−30, −28)`. Leftmost column is `x ∈ [−30, −28)`. This is the same
orientation the player sees: **up the page is up the screen and away from the
camera**.

```
        x = -30                        0                       +30
             ┌──────────────────────────────────────────────────┐
 z = +30  0  │ ############==GG==############                   │  curtain wall + gatehouse
       +28  1│ ############==GG==############                   │
       +26  2│ ............==GG==............                   │  gate ward
       +24  3│ .............^^^^.............                   │  ← zone-exit trigger
       +22  4│ #...kkkkk.....ee.....kkkkk...#                   │  ← 'from_wastes' entry
       +20  5│ #...#####............#####...#                   │
       +18  6│ #...#####K..........S#####...#                   │  Kaira / Stash Keeper
       +16  7│ #...#####............#####...#                   │
       +14  8│ #...#####............#####...#                   │
       +12  9│ #...#####....................#                   │
       +10 10│ #............................#                   │
        +8 11│ #.....................kkkkkk.#                   │
        +6 12│ #............BBBB.....######.#                   │  great brazier
        +4 13│ #kkkkkkkk....BBBB.....######.#                   │
        +2 14│ #########....BBBB....I######.#                   │  Isa
         0 15│ #########.............######.#                   │
        -2 16│ #########V............######.#                   │  Veren
        -4 17│ #########....................#                   │
        -6 18│ #########....................#                   │
        -8 19│ #............................#                   │
       -10 20│ _,,,,,,,,,,,,,ee,,,,,,,,,,,,,_                   │  ← 'town_start' entry
       -12 21│ _,,,,,,,,,,,,,,,,,,,,,,,,,,,,_                   │
       -14 22│ _,,,,,,,,,,,,,ee,,,,,,,,,,,,,_                   │  ← 'town_portal_return'
       -16 23│ _,,,,,,,,WWWW,PP,,,,,,,,,,,,,_                   │  cistern / portal pad
       -18 24│ _,,,,,,,,WWWW,PP,,rrrr,,,,,,,_                   │
       -20 25│ _::::::::WWWW:::::rrrr:::::::_                   │
       -22 26│ _:::::::::::::::::rrrr:::::::_                   │
       -24 27│ _::::::::::::::::::::::::::::_                   │
       -26 28│ ______________________________                   │  south parapet, 1.10 m
       -28 29│ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~                   │  the bluff — no ground
             └──────────────────────────────────────────────────┘
```

| glyph | meaning | nav | surface | height |
|---|---|---|---|---|
| `#` | curtain wall / building shell | `blocked` | `stone` / `wood` | 2.60 – 6.80 |
| `=` | gatehouse mass | `blocked` | `stone` | 9.20 |
| `G` | gate leaf (shut) | `blocked` | `metal` | 5.40 |
| `^` | zone-exit trigger | `walkable`, `spawnDeny` | `stone` | 0.00 |
| `k` | kerb / planter | `blocked` | `stone` | 0.45 |
| `B` | brazier plinth | `blocked` | `stone` | 0.55 |
| `r` | ruined block | `blocked` | `stone` | 2.20 – 3.40 |
| `_` | parapet | `blocked` | `stone` | 1.10 |
| `~` | bluff void — no ground, no nav cell | `blocked` | — | — |
| `.` | flagstone court | `walkable` | `stone` | 0.00 |
| `,` | packed dirt | `walkable` | `dirt` | 0.00 |
| `:` | gravel spoil | `walkable` | `sand` | 0.00 |
| `W` | cistern | `walkable` + `water` | `water` | −0.35 |
| `P` | portal pad | `walkable`, `spawnDeny` | `stone` | +0.30 |
| `e` | entry anchor | `walkable`, `spawnDeny` | — | — |
| `V` `I` `S` `K` | NPC stand point | `walkable` | — | — |

The map is a **derived view, not the source**. `STRUCTURES`, `KERBS`,
`GROUND` and `TERRACES` are the authority; `tools/mapgen.mjs --ascii
last_bastion` regenerates this block from them, and a mismatch with the text
committed above is a documentation bug that the tool reports.

### 2.4 Reading the town

| Region | Extent | What it is |
|---|---|---|
| **Gate Ward** | `z ∈ [22, 30]` | The curtain wall, the gatehouse, and the shut gate that is the exit to the Ashen Wastes. The player walks *up* the screen to leave, into the arrow the whole town composition points at. |
| **Ember Court** | `z ∈ [−9, 22]` | The paved plaza. The great brazier at `(0, +4)` is the town's only warm light and the visual anchor of every frame taken here. Services ring it. |
| **West Range** | `x ∈ [−28, −12]` | Veren's forge. Ash, slag, anvils, a weapon rack. Surface `stone` over `dirt`. |
| **East Range** | `x ∈ [12, 28]` | Isa's loom-house (`wood`, the only timber structure) and the Stash vault. |
| **Portal Terrace** | `z ∈ [−26, −9]` | Dirt and gravel over the bluff. The town-portal pad, the cistern, one ruined block. Nothing tall — this band is closest to the camera and everything here would occlude. |
| **The bluff** | `z < −27` | No ground at all. The parapet is 1.10 m — legal under the Occlusion Plane at any distance — and beyond it the fog dome closes the vista. This is how the town's world edge is hidden. |

### 2.5 Occlusion audit

Every structure, checked against §1.5. `s` is the distance from the structure's
north face to the nearest walkable cell north of it; `allowed` is
`1.00 + 1.206 · s`.

| structure | north face `z` | eave | nearest walkable `z` | `s` | allowed | verdict |
|---|---:|---:|---:|---:|---:|---|
| `forge` | +2.0 | 2.60 | +3.6 (kerb ends) | 1.60 | 2.93 | **pass** |
| `loom` | +6.0 | 2.60 | +7.6 | 1.60 | 2.93 | **pass** |
| `chapel` | +20.0 | 2.80 | +21.6 | 1.60 | 2.93 | **pass** |
| `vault` | +20.0 | 2.80 | +21.6 | 1.60 | 2.93 | **pass** |
| `ruin` | −18.0 | 2.20 | −16.4 | 1.60 | 2.93 | **pass** |
| brazier bowl | +5.6 | 2.35 | +7.0 | 3.00¹ | 4.62 | **pass** |
| brazier plinth | +7.0 | 0.55 | +7.0 | 0.00 | 1.00 | **pass** |
| `para_s` | −27.0 | 1.10 | −26.0 | 1.00 | 2.21 | **pass** |
| `wall_n_*`, `gatehouse` | — | — | — | — | — | **n/a** — north of every walkable cell |
| `wall_w`, `wall_e`, `para_w`, `para_e` | — | — | — | — | — | **n/a** — constant-X walls, never inside a ±1.2 m slab |
| all `KERBS` | — | 0.45 | — | 0.00 | 1.00 | **pass** — below the 1.00 m free height |

¹ measured from the bowl centre at `z = +4.0`, which is the tallest point.

Every pitched roof rises toward `−Z` at
`(ridgeY − eaveY) / (2 · halfL) ≤ 0.42`, far below the 1.206 limit, so no roof
plane can violate the rule regardless of viewing distance.

### 2.6 Walkable area and connectivity

| Quantity | Value |
|---|---|
| Total nav cells | 14 400 |
| Blocked (structures, kerbs, plinth, parapet, bluff) | ≈ 5 456 |
| Walkable | **≈ 8 944 cells = 2 236 m²** |
| Regions after the flood fill | **1** |
| Longest entry-to-service path (`town_start` → `kaira`) | 29.8 m |
| Longest service-to-service path (`veren` → `stash_chest`) | 33.0 m — the only route that must skirt the brazier plinth |

The exact walkable count is pinned by a golden fixture,
`tools/fixtures/nav/last_bastion.json`, holding the cell count, the region
count, a FNV-1a hash of `NavGrid.flags`, and the four entry positions. Any edit
to `last_bastion.js` that changes the nav grid must update the fixture in the
same commit and state why — this is the town's equivalent of the 200-seed
sweep.

The two alleys behind the chapel (`x ∈ [−28, −22]`, `z ∈ [10, 22]`) and behind
the vault (`x ∈ [22, 28]`, same band) are deliberately included: they are
connected via row `z ∈ [20, 22]` and `z ∈ [8, 12]`, they hold most of the
`grave_marker` and `banner_tattered` props, and they give the town somewhere to
walk that is not a service.

**Service distances are a design target, not an accident.** The full circuit
*portal pad → Veren → stash → portal pad* is **86 m** (17.6 + 33.0 + 35.9),
which at the Ravager's 4.2 m/s is **20.5 s** of walking. That is the number the
town is tuned to: short enough to run between zone attempts, long enough that a
town-portal charge is worth spending rather than hoarding, and long enough that
the brazier — which every one of those three legs passes — is seen from four
different angles per visit.

---

## 3. Ashen Wastes — the Ridgewalk generator

### 3.1 Descriptor

```js
{
  id: 'ashen_wastes',  displayName: 'Ashen Wastes',
  kind: 'open',        generator: 'ridgewalk',
  sizeX: 96, sizeZ: 96, cellSize: 24,
  monsterLevel: 6,
  packCount:  { min: 9,  max: 14 },
  packSize:   { min: 5,  max: 12 },
  densityTarget: 0.0125,          // monsters per m² of WALKABLE area
  champChance: 0.16,  uniqueChance: 0.06,
  bestiary: ['bone_ranker','carrion_swarm','ashen_archer','dust_shaman','blight_crawler'],
  surfaces: ['ash','dirt','stone','bone'],
  lightingPreset: 'wastes_dusk',
  fogPreset: 'wastes',
  ambientAudio: 'wastes',
  treasureClass: 'tc_wastes',
  exits:     [{ toZone: 'bonereach', tag: 'descent' }],
  entryTags: ['portal_from_town', 'descent_return'],
  chestCount: { min: 2, max: 4 },
  propBudget: 900,
}
```

Bounds `[−48, +48]²`. Macro grid **4 × 4 cells of 24 m**. Cell `(cx, cz)` with
`cx, cz ∈ 0..3` has its centre at:

```
centre(cx, cz) = ( -36 + 24·cx , -36 + 24·cz )
```

so cell `(0,0)` is the south-west corner and `(3,3)` the north-east. **Row
`cz = 0` is the south edge — the side the player enters from — and row
`cz = 3` is the north edge, where the descent to Bonereach is.** North is
"forward" in this act, on screen and on the map, in the town and in the field.

### 3.2 The algorithm, step by step

Every draw names its stream. The order below is the draw order and is binding.

#### R1 — Endpoints (`S0`)

```
entryCell = ( S0.int(0, 3), 0 )
exitCell  = ( S0.int(0, 3), 3 )
for attempt in 0..3:
    if |exitCell.cx − entryCell.cx| >= 1: break
    exitCell.cx = S0.int(0, 3)
if |exitCell.cx − entryCell.cx| < 1:
    exitCell.cx = (entryCell.cx + 2) & 3        // deterministic forced fallback
```

Requiring at least one column of lateral travel is what stops the degenerate
"straight corridor north" layout. The forced fallback fires on
`(1/4)⁴ ≈ 0.4 %` of seeds and is exercised by fixture seed `0x00000B27`.

#### R2 — The spine (`S0`)

A **weighted self-avoiding walk with backtracking**, from `entryCell` to
`exitCell`.

```
stack = [entryCell];  visited = { entryCell }
while top(stack) != exitCell:
    cands = neighbours(top) in FIXED ORDER [N, E, W, S], in bounds, not visited
    if cands is empty:
        pop(stack)                              // backtrack; the popped cell stays visited
        if stack is empty: goto RESTART
        continue
    w = [ N:5, E:3, W:3, S:1 ]  restricted to cands
    next = S0.weighted(cands, w)
    push(next); visited += next
    if |stack| > 12: goto RESTART
spine = stack
```

`RESTART` re-runs R2 from scratch, consuming fresh `S0` draws, up to **6**
times. On the seventh failure the generator emits the **L-path fallback**:
north along `entryCell.cx` to `cz = 3`, then east or west along `cz = 3` to
`exitCell.cx`. The L-path is always in bounds, always self-avoiding, and always
connects, so **R2 cannot fail.** In a 30 000-seed sweep the fallback is
expected on fewer than 1 in 4 000 seeds; the sweep asserts `< 0.1 %`.

Typical spine length is **5–9 cells** (mean 6.8).

#### R3 — Dead-end branches (`S0`)

```
nBranch = S0.int(2, 4)
cands   = spine cells except entryCell and exitCell,
          that have >= 1 in-bounds unvisited neighbour, in spine order
for b in 0 .. nBranch-1:
    if cands is empty: break
    root  = S0.pick(cands);  remove root from cands
    len   = S0.int(1, 2)
    cur   = root
    for k in 0 .. len-1:
        free = neighbours(cur), in FIXED ORDER [N, E, W, S], in bounds, not visited
        if free is empty: break
        nxt = S0.pick(free)
        visited += nxt;  branchCells += nxt;  cur = nxt
    mark cur as deadEnd
```

Dead-end tips are where the chests and the guaranteed champion go (§8.4).

#### R4 — Connected set and voids

`connected = spine ∪ branchCells`. Every macro cell not in `connected` is a
**void cell**: it gets no ground, no nav, no props, and its silhouette is filled
by the ash-ridge treatment of R9. Typical `|connected|` is **9–14** of 16.

#### R5 — Terraces (`S1`)

Each connected cell is assigned an elevation from a three-level set:

```
elev(cell) = 0.00                                       default
elev(cell) = -2.20   if archetype(cell) == 'ravine'     (assigned in R7)
elev(cell) = +1.20   if S1.next() < 0.18 and cell is not entryCell/exitCell
                        and no 4-neighbour in `connected` is already at -2.20
```

The `+1.20` shelf and the `−2.20` ravine floor are terrace regions inset **2.0 m**
from the cell boundary, so the terrace wall is always fully inside one cell and
never lands on a gate.

#### R6 — Gates between cells (`S1`)

For every pair of 4-adjacent cells both in `connected`, a **gate** is carved
through the shared 24 m edge:

```
width  = S1.int(8, 14) metres              // rounded to the build lattice
offset = S1.int(-5, 5) metres              // from the edge midpoint
```

The gate is walkable ground spanning the full gate width across a 4 m band
straddling the edge. If the two cells differ in elevation, the gate becomes a
**ramp**: `ceil(Δy / 0.40)` terrace steps of equal height across the 4 m band,
which for the maximum `Δy = 3.40 m` (a `+1.20` shelf beside a `−2.20` ravine —
excluded by R5) never occurs; the reachable maximum is `2.20 m` → 6 steps of
0.367 m, each under the 0.45 m nav slope limit. Ramp width is
`max(gateWidth, 3.0)`.

Between a connected cell and a void cell, no gate is carved and the shared edge
receives a **ridge wall** (R9).

#### R7 — Archetype selection (`S1`)

Cells are assigned in **spine order first, then branch order**, so an archetype
table change never reorders anything upstream.

| id | weight | ground surface | terrace | props / cell | density × | draw-call cost | role |
|---|---:|---|---|---:|---:|---:|---|
| `ash_flats` | 26 | `ash` | 0.00 | **34** | 0.85 | 4 | Open, long sight lines. The zone's resting rhythm. |
| `dead_grove` | 20 | `dirt` | 0.00 | **92** | 1.10 | 6 | Dead trees and thicket. Breaks lines of fire; the archers' cell. |
| `ruin_field` | 18 | `stone` | 0.00 | **78** | 1.20 | 6 | Wall stubs and column drums. Cover, chokepoints, elevation reads. |
| `bone_yard` | 14 | `bone` | 0.00 | **110** | 1.00 | 5 | Ribcages and skull drifts. Where the Dust Shaman belongs. |
| `ravine` | 12 | `dirt` | −2.20 | **46** | 0.75 | 5 | A sunken bowl with two ramps. The zone's only real vertical read. |
| `warcamp` | 10 | `dirt` | 0.00 | **66** | 1.60 | 7 | Tents, pyres, stakes. The densest fight in the zone. |

Hard constraints, applied **before** the weighted draw so that the draw is
never wasted:

| # | Constraint |
|---|---|
| A1 | `entryCell` is forced to `ash_flats`. The player must land somewhere they can see. |
| A2 | `exitCell` is forced to `ruin_field`. The descent stair reads as built, not natural. |
| A3 | `ravine` may not be a `deadEnd` tip (a chest at the bottom of a bowl is a trap, not a reward) and may not be 4-adjacent to another `ravine`. |
| A4 | `warcamp` appears at most **twice** per zone. |
| A5 | No archetype may appear in more than **half** of `connected`, rounded up. |
| A6 | A `+1.20` shelf cell may not be `ravine` (R5 already excludes it) and may not be `warcamp`. |

If the filtered candidate set is empty for a cell, the archetype falls back to
`ash_flats`, which has no constraints. That fallback is counted and reported by
mapgen; a sweep in which it fires on more than **2 %** of cells is a tuning bug.

#### R8 — Per-cell dressing (`S2`)

Each cell is dressed with **exactly** `propCount(archetype)` props, scaled by
the running budget:

```
remaining = descriptor.propBudget − placedSoFar − reservedBoundary(150)
quota     = min( archetypeProps , floor(remaining / cellsLeftToDress) )
```

Placement inside a cell is a **Poisson-disc dart throw on the cell's walkable
mask**:

```
for i in 0 .. quota-1:
    for tries in 0 .. 15:
        p = ( cellMinX + S2.range(1.5, 22.5) , cellMinZ + S2.range(1.5, 22.5) )
        reject if not walkable(p)
        reject if dist(p, nearest already-placed prop) < protoSpec.minSpacing
        reject if dist(p, nearest gate centreline) < 2.0     // never plug a gate
        reject if inside a spawnDeny disc
        accept
    proto    = S2.weighted(archetypeProtoTable)
    facing   = S2.range(0, 2π)
    scale    = S2.range(protoSpec.scaleMin, protoSpec.scaleMax)
    tintSeed = S6.u32()
```

Sixteen tries and then give up is deliberate: a prop that cannot find a spot is
simply not placed, and the count is reported. A retry-until-success loop would
be an unbounded number of RNG draws, which is a determinism hazard the moment
the walkable mask changes by one cell.

`protoSpec.minSpacing` per prototype is in §9.2. Every prop that is `navBlock`
also emits a `Footprint`; props that are not are visual only and cost the nav
build nothing.

#### R9 — Boundary treatment (`S1`, `S2`)

The player must never see the edge of the world. Four layers, from the inside
out:

| Layer | Extent | What |
|---|---|---|
| **Ridge wall** | The outer face of every `connected`-to-void or `connected`-to-outside edge, 2.0 m thick | A run of `ridge_slab` footprints, `topY` drawn from `S1.range(4.5, 7.5)`, jittered ±0.8 m in the normal direction so the line is never straight. `navBlock: true`, surface `stone`. |
| **Ash berm** | 6.0 m band outside the ridge wall | Non-walkable displaced ground rising from the ridge foot to `+3.0 m`. Purely visual; it is outside the nav grid entirely. |
| **Silhouette band** | A ring at radius 62–78 m from the zone centre | 44 instances of `far_spire`, `topY` 14–26 m, drawn from `S2`. No collider, `userData.noShadow = true`, `noPrepass = true`. Two draw calls for the whole ring. |
| **Fog wall** | Everything beyond | `sky.setFog()` with the `wastes` preset. Visibility reaches 1.0 opacity at **38 m**, which is 12.8 m beyond the far edge of the camera trapezoid. |

The arithmetic that makes this airtight: the far edge of the visible ground is
25.22 m ahead of the camera, i.e. **11.68 m ahead of the player**. The walkable
area is at most 48 m from the centre, so the player standing on the outermost
walkable cell sees to `48 + 11.68 = 59.7 m` — inside the ridge wall + berm
(48 → 56 m) and short of the silhouette ring (62 m), which is itself already at
0.99 fog opacity. **There is no player position from which un-dressed ground is
visible.** Invariant **I9** checks this numerically over 200 seeds.

#### R10 — Entries, exits and chests (`S1`, `S4`)

```
entries:
  'portal_from_town'  → centre(entryCell) + ( S1.range(-4, 4), -8.0 ), facing +π/2
  'descent_return'    → the descent landing, 3.0 m south of the stair head

exit:
  'descent' → a 6 × 4 m stair footprint at centre(exitCell) + (0, +8.0),
              trigger rect 6 × 2 m on its south face,
              toZone 'bonereach', toEntryTag 'descent'

chests:
  count = S4.int(descriptor.chestCount.min, descriptor.chestCount.max)   // 2..4
  the first  min(count, |deadEndTips|) go one per dead-end tip, in branch order
  any remainder go to the cell with the highest (props × density×) product
    that does not already hold a chest
  each chest: position = nav.snap(cellCentre + S4.disc(6.0)), facing = S4.range(0, 2π)
              treasureClass = descriptor.treasureClass
              sub-seed      = S4.u32()          // consumed by items at open time
```

#### R11 — Spawn points and packs (`S3`)

Full specification in §8. It runs last because it needs the finished nav grid,
which means the emission order inside `enterZone` is:

```
R1..R10 (pure, no three)  →  geometry build  →  physics.rebuild()
                          →  nav.rebuild()   →  R11  →  zone:ready
```

R11 is the only generator stage that runs *after* `nav.rebuild()`. It is still
pure and still headless-safe, because it reads the nav grid, not the scene.

### 3.3 A worked example

Seed `0x8F2A11C3` (`worldSeed 0x1F3AC09B`, `runIndex 3`) produces:

```
        cx=0      cx=1      cx=2      cx=3
      ┌─────────┬─────────┬─────────┬─────────┐
cz=3  │  void   │ ruin    │  void   │  void   │   ⇩ = descent to Bonereach
      │         │ field ⇩ │         │         │       exitCell = (1,3)
      ├─────────┼───╌╌╌───┼─────────┼─────────┤
cz=2  │ bone    ┆ ash     ┆ war     │  void   │   ▣ = dead-end tip: chest
      │ yard ▣  ┆ flats   ┆ camp    │         │
      ├─────────┼───╌╌╌───┼───╌╌╌───┼─────────┤
cz=1  │  void   │ ravine  ┆ ruin    ┆ bone    │   ╌╌╌ / ┆ = carved gate
      │         │ −2.2 m  ┆ field   ┆ yard    │
      ├─────────┼───╌╌╌───┼─────────┼───╌╌╌───┤
cz=0  │  void   │ ash     │  void   │ dead    │   ⊕ = entryCell = (1,0)
      │         │ flats ⊕ │         │ grove ▣ │
      └─────────┴─────────┴─────────┴─────────┘

spine     : (1,0) → (1,1) → (2,1) → (2,2) → (1,2) → (1,3)        6 cells
branches  : (2,1) → (3,1) → (3,0)          [tip (3,0), length 2]
            (1,2) → (0,2)                  [tip (0,2), length 1]
connected : 9 of 16 cells                  gates carved: 9
walkable  : 4 810 m²
chests    : 2 — one at each dead-end tip
packs     : 9,  60 monsters               density 0.01248 → −0.2 % of target ✔
unique    : forced onto the (3,0) pack — the last dead-end assigned (§8.4)
```

The spine turns four times, drops into a ravine mid-route that the player must
descend into and climb out of, and ends at a ruin field with the stair. Two
side pockets each end in a chest. Seven of sixteen macro cells are given over
to boundary.

Note the gate between `(1,1)` and `(1,2)`: R6 carves a gate between **every**
adjacent connected pair, not only along the spine, so this layout has a loop —
the player can bypass the warcamp at `(2,2)` on the way back. That is not a
special case, it is the ordinary consequence of R6, and it is why the Wastes
reads as open ground rather than as a corridor with rooms hung off it.

### 3.4 Instancing and the per-cell draw-call cost

The "draw-call cost" column of §3.2 R7 is the number of distinct
`InstancedMesh` prototypes an archetype introduces. Prototypes are **shared
across cells**: two `dead_grove` cells contribute to the same six instanced
meshes, so a zone's prop draw calls are

```
worldPropDrawCalls = | union of prototypes over all connected cells |
```

which for the worked example above is **14**, not `9 × 5`. The instance count
per prototype is summed across cells and the matrix buffer is written once, in
cell order, during geometry build. A zone whose archetype mix would exceed
**18 prototypes** drops the least-used prototype and redistributes its quota to
the next-heaviest one in the same archetype table; that path is exercised by
fixture seed `0x1D40C6A2` and reported by mapgen as `PROTO_CAP`.

---

## 4. Bonereach — the BSP hall generator

### 4.1 Descriptor

```js
{
  id: 'bonereach',  displayName: 'Bonereach',
  kind: 'dungeon',  generator: 'bsp_rooms',
  sizeX: 112, sizeZ: 112, cellSize: 0,
  monsterLevel: 11,
  packCount:  { min: 8,  max: 14 },
  packSize:   { min: 5,  max: 12 },
  densityTarget: 0.0165,
  champChance: 0.20,  uniqueChance: 0.08,
  bestiary: ['bone_ranker','ashen_archer','dust_shaman','maulsmith',
             'blight_crawler','carrion_swarm'],
  surfaces: ['stone','bone','dirt','water'],
  lightingPreset: 'bonereach_interior',
  fogPreset: 'bonereach',
  ambientAudio: 'bonereach',
  treasureClass: 'tc_bonereach',
  exits:     [{ toZone: 'altar_of_instruction', tag: 'gate' },
              { toZone: 'ashen_wastes',         tag: 'descent_return' }],
  entryTags: ['descent', 'ascent_return', 'portal_return'],
  chestCount: { min: 4, max: 7 },
  propBudget: 1200,
}
```

Bounds `[−56, +56]²`. The generator works inside a **root rectangle of
108 × 108 m** centred at the origin, leaving a 2 m rock margin on every side so
that no room wall coincides with the zone boundary.

**Method: BSP with largest-leaf-first splitting, rooms inset inside leaves,
corridors carved by walking the BSP merge tree bottom-up, plus a small number
of loop edges.** Not room-and-corridor scattering (which needs rejection
sampling and can fail), not hall-and-spur (which produces a readable but
boring spine).

Two terraces: the hall floor at `y = 0.00`, and the **descent shaft** in the
stair room at `y = −2.40`, reached by a 6-step ramp. Cosmetic displacement
amplitude is **0.00 m** — this is a built crypt, and a wobbling flagstone floor
reads as a bug. Everything is flagged `NAV_FLAG.interior`.

### 4.2 The algorithm, step by step

#### B1 — Room target (`S0`)

```
targetRooms = S0.int(12, 18)
```

#### B2 — Largest-leaf-first BSP (`S0`, `S1`)

```
leaves = [ { x0:-54, z0:-54, x1:54, z1:54 } ]
while |leaves| < targetRooms:
    node = the leaf with the largest area
           (ties broken by the smaller x0, then the smaller z0 — never by RNG)
    axis = 'x' if (node.x1-node.x0) >= (node.z1-node.z0) else 'z'
    span = extent of node along axis
    if span < 2 * MIN_LEAF (= 2 * 22 m):
        axis = the other axis
        if that span < 2 * MIN_LEAF: mark node unsplittable; continue
    t     = S1.range(0.38, 0.62)
    cut   = round( node[axis0] + t * span )        // whole metres, build lattice
    split node at `cut` into two leaves; replace node with them in `leaves`
    record the split in the BSP tree
if every leaf is unsplittable and |leaves| < 12:
    targetRooms = |leaves|                          // accept 12..18; see below
```

`MIN_LEAF = 22 m`. A 108 × 108 root can be split to at most **24** leaves of
≥ 22 m before every leaf is unsplittable, so `targetRooms ∈ [12, 18]` is always
achievable and the `unsplittable` escape never fires in the shipping
configuration. `tools/mapgen.mjs` asserts `|leaves| === targetRooms` on all 200
seeds; a failure means `MIN_LEAF` and the root size have drifted apart.

Selecting the **largest** leaf rather than recursing to a fixed depth is what
gives an exact room count and an even size distribution. Fixed-depth BSP gives
`2ⁿ` rooms and long thin slivers; this does not.

#### B3 — Rooms inside leaves (`S1`)

```
for each leaf, in leaf-creation order:
    padN = S1.int(2, 5);  padS = S1.int(2, 5)
    padE = S1.int(2, 5);  padW = S1.int(2, 5)
    room = leaf inset by (padN, padS, padE, padW)
    clamp room to  width  ∈ [8, 22]
                   depth  ∈ [8, 18]
      (clamping trims symmetrically about the leaf centre, never asymmetrically)
    room.centre = the geometric centre, snapped to whole metres
```

Resulting size distribution over 200 seeds × 15 rooms:

| room dimension | min | p25 | median | p75 | max |
|---|---:|---:|---:|---:|---:|
| width (X) | 8 | 12 | 15 | 18 | 22 |
| depth (Z) | 8 | 11 | 13 | 16 | 18 |
| floor area | 64 m² | 138 m² | 191 m² | 268 m² | 396 m² |

The median 15 × 13 m room is **slightly smaller than the camera trapezoid at
its far edge** (34 m wide) and slightly larger than it is deep (18.7 m). That
is the intent: a room is one screenful of fight, entered and read in a single
glance, and the player never has to pan to know what is in it.

Room walls are 1.0 m thick, `topY = 5.0 m` (the vault springs at 3.4 m and the
boss of the vault is at 5.0 m). Interior height is what `sky.setInterior(true)`
darkens; there is no roof geometry — the fixed camera never sees above 5.0 m
because the Occlusion Plane at `s = 13.5` permits 17.3 m and the room is capped
by a **ceiling plane at 5.0 m with `userData.noShadow = true`**, drawn only as
a light occluder. Costs one draw call per material for the whole zone.

#### B4 — Corridors from the merge tree (`S0`)

Walk the BSP tree **bottom-up**. Every internal node has exactly two children;
carve one corridor connecting them:

```
carveMerge(node):
    a = representativeRoom(node.left)      // the room in that subtree whose centre
    b = representativeRoom(node.right)     // is closest to the split plane
    elbowFirstAxis = 'x' if S0.bool() else 'z'
    carve L-corridor from a.centre to b.centre with that elbow order
    record the corridor, and record (a,b) as an edge of the room graph
```

`representativeRoom` is deterministic (closest centre to the split plane, ties
broken by lower room index) and never uses RNG.

Corridors are **3.0 m wide** (6 nav cells) — enough for the widest agent in the
bestiary, the Maulsmith at `radius 0.55 m`, plus the 0.30 m nav dilation
on both sides, plus 0.65 m of slack. Corridor floors are at `y = 0.00`.

**Connectivity proof.** The BSP tree has `targetRooms` leaves and
`targetRooms − 1` internal nodes. By induction on the tree:

- *Base.* A leaf's room is trivially connected to itself.
- *Step.* Assume both subtrees of an internal node are internally connected.
  `carveMerge` adds one corridor between a room of the left subtree and a room
  of the right subtree. The union is therefore connected.
- *Root.* The root's subtrees are the whole room set, so all `targetRooms`
  rooms are connected.

The graph after B4 is a **spanning tree**: `targetRooms − 1` edges, no cycles,
every room reachable from every other. This is a proof, not a check — the
generator cannot produce a disconnected dungeon. Invariant **I1** in §7 still
asserts it on the *rasterised nav grid*, because the proof covers the graph and
not the rasterisation, and a bug in corridor carving (a corridor that misses a
room wall by 0.5 m) would break the grid while leaving the graph intact.

#### B5 — Loop edges (`S0`)

A pure tree makes every fight a retreat down the corridor you came from, which
is the failure mode of BSP dungeons:

```
extra = S0.int(1, 3)
cands = all room pairs (a,b) with  dist(a.centre, b.centre) < 34 m
                                   and (a,b) not already an edge
        sorted by distance ascending, ties by (lower index a, then b)
for i in 0 .. extra-1:
    if cands is empty: break
    pick = S0.int(0, min(5, |cands|) - 1)      // one of the six shortest
    carve L-corridor for cands[pick];  remove it and any pair sharing both rooms
```

Loops never break connectivity — adding an edge to a connected graph leaves it
connected — so B4's proof survives B5 untouched.

#### B6 — Doorways (`S1`)

Where a corridor centreline crosses a room wall, a **3.0 m opening** is cut,
centred on the crossing, snapped to the build lattice, and the two flanking
0.5 m stubs become `door_jamb` footprints. The opening's nav cells are flagged
`NAV_FLAG.doorway`, which halves the crowd-separation weight there
(`01-data-model.md` §9.3) so a pack does not jam a doorway solid.

An opening whose centre would fall within 1.5 m of a room corner is slid along
the wall until it does not; if the wall is too short (< 6.0 m) for any legal
opening, the corridor is re-routed to enter the **adjacent** wall instead, using
the other elbow order. This is deterministic (no new draw) and fires on roughly
4 % of corridors.

Doors are always **open archways**. There are no closed doors, no keys and no
destructible doors — a destructible blocker would need a nav rebuild mid-zone,
which §6.6 forbids outright.

#### B7 — Room roles (`S0`, `S4`)

Compute the room graph's degrees, then assign:

| role | count | selection | contents |
|---|---:|---|---|
| `entry` | 1 | the leaf room (degree 1) whose centre is closest to the south edge; ties by lower index | The `descent` entry, an `ascent_return` stair back to the Wastes, `spawnDeny` over the whole room |
| `stair` | 1 | the room with the **greatest BFS hop count from `entry`** over the room graph; ties by greater Euclidean distance, then lower index | The `gate` exit to the Altar: a `−2.40 m` shaft terrace, a 6-step ramp, a 6 × 4 m arch |
| `vault` | `S0.int(2, 4)` | degree-1 rooms other than `entry` and `stair`, chosen in index order by `S0.pick` | One chest + one guard pack; the pack is forced to `champion` rank |
| `flooded` | 0 or 1 | `S0.next() < 0.45` → the lowest-index room with area ≥ 200 m² that is not `entry`/`stair` | Floor painted `water`, `NAV_FLAG.water`, `cost += 6` |
| `hall` | the remainder | — | Ordinary packs and dressing |

If there are fewer than 2 spare degree-1 rooms, `vault` count is reduced to
what exists and the remaining chests are placed in the `hall` rooms with the
greatest BFS distance from `entry`. The zone always ends up with
`chestCount ∈ [4, 7]` chests total (§4.3).

#### B8 — Chests (`S4`)

```
count = S4.int(4, 7)
       vault rooms get one each, in role-assignment order
       the remainder go to the `hall` rooms with the greatest BFS hops from entry
each chest: position = room.centre + S4.disc(min(room.w, room.d) * 0.30)
            snapped by nav.snap(pos, 3.0)
            facing   = the cardinal direction facing the room's nearest doorway
            sub-seed = S4.u32()
```

#### B9 — Dressing (`S2`)

Same dart-throw as R8, with per-role prototype tables and quotas:

| role | props | prototypes | notes |
|---|---:|---:|---|
| `entry` | 28 | 4 | Sparse. The player must read the exits immediately. |
| `hall` | 62 | 7 | Sarcophagi, bone piles, chains, rubble, wall sconces |
| `vault` | 84 | 7 | Denser, plus the chest and 2–4 urns (containers) |
| `flooded` | 40 | 5 | Half the prop count; standing water reads as emptiness on purpose |
| `stair` | 46 | 6 | Braziers flanking the ramp, the arch, chain curtains |
| corridors | 6 per 10 m | 3 | Wall sconce every 8–12 m, rubble, one alcove skeleton per 25 m |

`propBudget: 1200` against a typical 15 rooms × 62 + 17 corridors × 30 m ×
0.6 = 930 + 306 = **1 236**, so the budget clamp of R8 fires on dense seeds and
trims the corridor quota first, then `hall`. Prototype union across all roles
is **17**, under the 18 cap.

#### B10 — Entries and exits

```
'descent'        → entryRoom.centre + (0, −(depth/2 − 2.5)), facing +π/2
'ascent_return'  → entryRoom.centre + (0, −(depth/2 − 2.5)) + (3.5, 0), facing +π/2
'portal_return'  → registered dynamically when a town portal opens (§10.4)

exit 'gate'      → stairRoom, at the head of the −2.40 m ramp;
                   trigger rect 5 × 2 m at the ramp foot
                   toZone 'altar_of_instruction', toEntryTag 'gate'
exit 'descent_return' → the ascent stair in entryRoom,
                   toZone 'ashen_wastes', toEntryTag 'descent_return'
```

### 4.3 A worked example

Seed `0x2C71E004`, `targetRooms = 15`:

```
 z=+54 ┌──────────────────────────────────────────────────────────┐
       │ ┌──────┐        ┌────────────┐      ┌─────────┐          │
       │ │  R11 │────────│    R04     │      │   R09   │          │
       │ │ hall │        │   STAIR ⇩  │──────│  vault ▣│          │
       │ └───┬──┘        └─────┬──────┘      └────┬────┘          │
       │     │                 │                  │               │
       │ ┌───┴──────┐   ┌──────┴─────┐    ┌───────┴──────┐        │
       │ │   R07    │───│    R02     │────│     R13      │        │
       │ │  hall    │   │  flooded ≈ │    │    hall      │        │
       │ └───┬──────┘   └──────┬─────┘    └───────┬──────┘        │
       │     │                 │  ╲                │              │
       │ ┌───┴──────┐   ┌──────┴─────┐  ╲  ┌───────┴──────┐       │
       │ │  R05 ▣   │   │    R00     │   ╲ │    R08       │       │
       │ │  vault   │───│   hall     │────╲│   hall       │       │
       │ └──────────┘   └──────┬─────┘     └───────┬──────┘       │
       │                       │                   │              │
       │                ┌──────┴─────┐      ┌──────┴───────┐      │
       │                │    R01     │      │    R06 ▣     │      │
       │                │   ENTRY ⊕  │──────│    vault     │      │
       │                └────────────┘      └──────────────┘      │
 z=-54 └──────────────────────────────────────────────────────────┘
        x=-54                                                x=+54
        (5 further rooms omitted for legibility)

rooms        : 15         corridors: 14 tree + 2 loops = 16
walkable     : 4 186 m²   regions after flood fill: 1
entry→stair  : 7 hops, 128 m of path
chests       : 5  (3 vaults + 2 farthest halls)
packs        : 12,  69 monsters,  density 0.01648 → within −0.1 % of 0.0165 ✔
```

Note `R02` is `flooded` and sits directly on the shortest entry→stair route:
the loop edge from `R00` to `R08` exists specifically so the player has a dry
alternative. That is not luck — B5 draws loop candidates from the six shortest
non-edges, and in a BSP layout the shortest non-edges are almost always the
ones that bypass the middle.

---

## 5. Altar of Instruction — the fixed arena

### 5.1 Descriptor

```js
{
  id: 'altar_of_instruction',  displayName: 'Altar of Instruction',
  kind: 'arena',               generator: 'arena',
  sizeX: 48, sizeZ: 48, cellSize: 0,
  monsterLevel: 15,
  packCount:  { min: 2, max: 3 },
  packSize:   { min: 4, max: 7 },
  densityTarget: 0.0075,
  champChance: 0.35,  uniqueChance: 0.00,
  bestiary: ['bone_ranker','ashen_archer'],
  surfaces: ['stone','ash','bone'],
  lightingPreset: 'altar_ember',
  fogPreset: 'altar',
  ambientAudio: 'altar',
  treasureClass: 'tc_altar',
  exits:     [{ toZone: 'last_bastion', tag: 'from_wastes' }],
  entryTags: ['gate', 'portal_return'],
  chestCount: { min: 1, max: 1 },
  propBudget: 380,
}
```

**The layout is fixed. The seed drives only the entrance dressing, the rubble
scatter, the prop rotations and the two guard packs in the approach corridor.**
The fight space itself is identical on every seed, on every difficulty, on
every run — because a boss encounter that has to be re-learned per seed is not
a boss encounter, it is a slot machine.

Bounds `[−24, +24]²`. Three terraces: approach `y = −0.60`, arena floor
`y = 0.00`, altar dais `y = +0.90`. Everything is `NAV_FLAG.interior`.

### 5.2 The plan

```
        x=-24                     0                    +24
   +24  ┌──────────────────────────────────────────────────┐
        │##################################################│
   +21  │########┌────────────────────────────┐############│  altar alcove
        │########│      T H E   A L T A R     │############│  dais +0.90 m
   +18  │########│   ▓▓▓▓▓▓▓ tablet ▓▓▓▓▓▓▓   │############│  7.0 × 3.5 m
        │########└──────────┐  ▲  ┌───────────┘############│  ▲ = 4 m stair
   +17  │###################│▁▁▁│###################·······│  ← arena rim r=17
        │#####      ·  ·  ·  ·  ·  ·  ·  ·  ·      #######│
   +12  │###     ·           ●P1          ●P2         ····│  ● pillars, r=11.5
        │##    ·                                       ···│
    +6  │#   ·        ·  ·  ·  ·  ·  ·  ·  ·        ·    ·│
        │#  ●P6                 ✦ M                 ●P3  ·│  ✦ = Molgrim start (0,+5)
     0  │#  ·          ·   ·   · ⊙ ·   ·   ·          ·   │  ⊙ = arena centre (0,0)
        │#  ·                                          ·  │
    -6  │#   ·        ·  ·  ·  ·  ·  ·  ·  ·        ·    ·│
        │##    ·                ⌂                     ··· │  ⌂ = exit portal (0,−13)
   -12  │###     ·           ●P5          ●P4         ····│
        │#####      ·  ·  ·  ·  ·  ·  ·  ·  ·      #######│
   -17  │###################│   │###################·······│
        │###################│ ⊕ │#########################│  ⊕ = 'gate' entry
   -21  │###################│▒▒▒│#########################│  approach −0.60 m
        │###################│▒▒▒│#########################│  6 m wide
   -24  └──────────────────────────────────────────────────┘
```

| element | geometry | surface | nav |
|---|---|---|---|
| **Arena floor** | Disc, centre `(0, 0)`, radius **17.0 m**, `y = 0.00` | `stone` | `walkable`, `interior` |
| **Arena rim** | Annular wall, inner radius 17.0 m, thickness 2.5 m, `topY = 6.5 m` | `stone` | `blocked` |
| **Pillars P1–P6** | Circles, radius **0.90 m**, at radius **11.5 m**, angles 60°, 120°, 180°, 240°, 300°, 0° (measured CCW from `+X`) | `stone` | `blocked` |
| **Approach corridor** | Rect `x ∈ [−3, +3]`, `z ∈ [−24, −17]`, `y = −0.60`, ramped over its last 3 m | `stone` | `walkable`, `doorway`, `spawnDeny` |
| **Gate arch** | 6 × 1.5 m, `topY = 7.0 m`, at `z = −17` | `stone` | `blocked` except the 5 m opening |
| **Altar alcove** | Rect `x ∈ [−3.5, +3.5]`, `z ∈ [+17.5, +21.0]`, dais `y = +0.90` | `stone` | `walkable` |
| **Altar block** | Rect `5.0 × 2.0 m`, centred `(0, +19.6)`, `topY = +2.30 m` | `crystal` | `blocked` |
| **Alcove stair** | 4.0 m wide, `x ∈ [−2, +2]`, `z ∈ [+17.0, +17.5]`, 3 steps of 0.30 m | `stone` | `walkable` |
| **Exit portal pad** | Circle, centre `(0, −13.0)`, radius 2.0 m | `stone` | `walkable`, `spawnDeny`; **closed** until `bossDefeated` |
| **Chest** | `(0, +14.0)`, facing `−π/2` | `wood` | — |
| **Tablet interactable** | `Interactable { id:'altar_tablet', kind:'altar', x:0, z:+18.2, radius:2.0 }`, at the foot of the altar block | `crystal` | — |

The tablet interactable is not decoration and is not optional: the act's quest
is *take the First Tablet from the Altar of Instruction*, and without it the
altar block is `blocked` geometry with a chest 5 m short of it and no way to
complete the quest. `kind: 'altar'` is already in the `SpawnPoint` enum of §9.4.
It is inert until `bossDefeated` and `world.interactableAt` returns the sealed
prompt before then, on the same mechanism as the exit portal pad.

Molgrim spawns at `(0, +5.0)` facing `−π/2`; the player enters at
`(0, −19.0)` facing `+π/2`, so they walk 24 m up the screen into the room and
he is already framed when they cross the gate.

### 5.3 Fight-space guarantees

These are the reason the layout is fixed, and each is a number the arena
geometry provides to `ai`'s pattern scheduler.

#### G1 — Phase I: the sweep

Molgrim's sweep (`08-characters-visual.md` §6.3) is a **220° wedge at 4.2 m**.

- Guarantee: the **inner disc of radius 10.6 m** about the arena centre is
  completely free of blockers (the pillars are at 11.5 m, minus 0.9 m radius =
  10.6 m clear).
- Consequence: wherever Molgrim stands within 6.0 m of centre, his full sweep
  arc lands on open floor and the 140° safe sector behind him is reachable.
  The player can always resolve the telegraph by walking, not by pathing around
  a pillar.

#### G2 — Phase I: the summon ring

Four Bone Rankers summoned every 20 s need four spawn anchors that are
walkable, ≥ 2.0 m from any blocker, and 5–9 m from Molgrim.

- Guarantee: **eight fixed summon anchors** at radius **7.0 m** from the arena
  centre, at 45° intervals starting at 22.5°. All eight are on open floor
  (7.0 + 0.9 < 10.6) and mutually 5.36 m apart. `ai` picks the four furthest
  from the player, deterministically.

#### G3 — Phase II: the expanding fire rings

This is the constraint that sizes the arena. A ring is an annulus with one gap;
it expands outward and the player must reach the gap before it reaches them.

**The gap is specified in metres, not degrees.** A constant angular gap is a
trap: at `r = 3 m` a 60° gap is 3.14 m wide, at `r = 17 m` it is 17.8 m — the
mechanic is lethal at the start and free at the end. Constant *linear* width
inverts nothing and is trivially readable:

```
gapWidth      = 4.00 m           constant, all radii, all phases, all difficulties
gapHalfAngle(r) = asin( 2.00 / r )        // undefined below r = 2.00 m
ringSpawnRadius = 3.00 m         → gapHalfAngle = 41.8°, gap arc = 4.38 m
ringDeathRadius = 17.00 m        → gapHalfAngle =  6.75°, gap arc = 4.01 m
ringSpeed       = 3.20 m/s
ringLifetime    = (17.00 − 3.00) / 3.20 = 4.375 s
ringInterval    = 1.55 s         → 2.82 concurrent rings, ring spacing 4.96 m
```

Guarantees the geometry must provide, and does:

| # | Requirement | Provided by |
|---|---|---|
| G3.1 | A clear annulus from `r = 3.0` to `r = 17.0` about the arena centre, obstructed only by the six pillars | The disc floor with no other blockers inside `r = 17.0` |
| G3.2 | The gap is never plugged by a pillar | The gap's centre angle is drawn from the **six inter-pillar bisectors** (30°, 90°, 150°, 210°, 270°, 330°) with a `±12°` jitter, so at the pillar ring `r = 11.5` the gap centre is ≥ 18° from a pillar centre; the pillar subtends `asin(0.9/11.5) = 4.49°`, leaving **≥ 13.5° of clearance = 2.71 m** on the tight side and ≥ 2.71 m of open gap regardless |
| G3.3 | The player can always cross | Worst case: caught at `r = 3.0` diametrically opposite the gap. Arc to travel `= π · 3.0 = 9.42 m`; at the Emberwright's 3.9 m/s base that is **2.42 s**, while the ring needs `(3.0 → player radius reach)`… the ring overtakes a stationary player in 0 s, so the player must move tangentially: the ring's radial speed is 3.2 m/s and the arc closes at the player's full speed, giving a required arc-run of 9.42 m against a 4.375 s window — **1.85 m/s needed against 3.9 m/s available**, a 2.1× margin. |
| G3.4 | Rings are cast from a position where G3.1 holds | `ai` may only begin a ring cast while Molgrim is within **6.0 m** of the arena centre. At 6.0 m off-centre, the ring at `r = 17` still lies inside the 17 m rim on the near side and clips the rim on the far side, which is correct: a clipped ring simply has a second, wider gap. |
| G3.5 | The gap is legible from the fixed camera | The frame is 18.74 m deep, so a ring of radius up to 9.4 m is fully on screen; beyond that the gap may be off-screen. The floor carries **six permanent inlaid rune spokes at the six bisector angles**, so the player learns that gaps only ever appear on a spoke — the mechanic is readable even when the ring's far side is not. |

#### G4 — Phase III: teleports

Molgrim teleports and rains meteors. Teleporting into geometry, or onto the
player, or somewhere the player cannot follow, all end the fight badly.

- Guarantee: **twelve fixed teleport anchors** — six at radius **8.0 m**
  (angles 0°, 60°, …, 300°, i.e. *on* the pillar bearings but inside them) and
  six at radius **14.0 m** (on the bisectors, 30°, 90°, …, 330°).
- Every anchor is walkable, on the arena floor, and **≥ 2.60 m from the nearest
  pillar surface** (inner ring: `11.5 − 8.0 − 0.9 = 2.60 m`; outer ring: the
  bisector places them 30° off a pillar, `2 · 14.0 · sin 15° = 7.25 m` of chord
  separation minus 0.9 m = 6.35 m).
- Molgrim's own collision radius is **1.10 m**; every anchor clears it with
  ≥ 1.50 m of margin, and the rim at 17.0 m clears the outer ring by 3.0 m.
- `ai` selects the anchor that is **6.0–13.0 m from the player** and furthest
  from the player's facing, so the teleport is always reachable in ≤ 3.3 s and
  never lands on top of them.

#### G5 — Phase III: meteor rain

Six discs of radius 1.8 m (`08-characters-visual.md` §6.3).

- Total covered area `6 · π · 1.8² = 61.1 m²` against the arena's
  `π · 17² = 907.9 m²` — **6.7 % coverage**.
- Guarantee: `ai` places the six discs on a **Poisson-disc pass with a 5.0 m
  minimum separation**, which on a 908 m² disc always succeeds and always
  leaves a connected safe region: six discs of radius 1.8 m separated by 5.0 m
  cannot fence off any area, since the minimum gap between two disc edges is
  `5.0 − 3.6 = 1.4 m` and the player's diameter is 0.72 m.

#### G6 — Cover and line of sight

The six pillars are the only cover. They are **0.90 m radius, 7.0 m tall**, at
radius 11.5 m. Against the Occlusion Plane at `s = 0` they are far over 1.00 m,
so a pillar *does* occlude a player standing immediately north of it. That is
accepted and deliberate:

- The occluded band is `s ≤ (7.0 − 1.0) / 1.206 = 4.98 m` north of each pillar,
  a 1.8 × 5.0 m rectangle, **six of them, 53.9 m² total = 5.9 % of the arena**.
- Standing there is a choice — it is the only place the player is safe from a
  ranged phase-III meteor lock — and the cost of that choice is that they lose
  sight of themselves. That trade is the entire reason cover exists in this
  fight.
- To keep it from being a *surprise*, each pillar's occluded band is marked on
  the floor with a scorched fan decal, authored, not generated.

### 5.4 The entrance transition and what the seed does control

The approach corridor from `z = −24` to `z = −17` is the only seeded part:

| Stage | Stream | What |
|---|---|---|
| E1 | `S1` | Corridor wall relief: 6 alcoves, depth `S1.range(0.6, 1.2)`, at `z` positions jittered ±0.8 m from a 2.4 m rhythm |
| E2 | `S2` | 44 props: bone drifts, fallen banners, guttered candles, one skeletal supplicant per alcove |
| E3 | `S3` | 2–3 guard packs (`packCount`) of 4–7 Bone Rankers / Ashen Archers, placed in the corridor and the first 4 m inside the arena rim |
| E4 | `S2` | Arena rubble scatter: 96 props inside `r < 16.0 m`, none within 2.0 m of a pillar, none within 4.0 m of the centre, all `navBlock: false` — **nothing inside the arena blocks navigation** |
| E5 | `S6` | Per-instance tint and wear across all of the above |

**E4's `navBlock: false` is load-bearing.** The arena floor must be a single
open disc for G3, G4 and G5 to hold; arena dressing is therefore visual only,
and the only blockers inside `r = 17.0 m` are the six pillars. `tools/mapgen.mjs`
invariant **I7** asserts exactly that: *the count of blocked nav cells inside
`r = 16.0 m` equals `6 × ceil(π · (0.9 + 0.3)² / 0.25) = 6 × 19 = 114`, ± 6.*

The boss exit portal at `(0, −13.0)` is created closed and is opened by
`world` on `actor:death` when `actor.flags & ACTOR_FLAG.boss`, per
`02-api-contracts.md` §5. It leads to `last_bastion` at the `from_wastes` entry
— the player walks back into town through the gate, which is the only place in
the game where an arrival reuses the gate entry, and it is intentional: the act
ends where it began.

---

## 6. The navigation grid

### 6.1 Who builds what

`02-api-contracts.md` gives `world` the sentence *"`world` builds it and hands
it over; `nav` owns it afterwards"* and gives `nav` the sentence *"a 0.5 m grid
rebuilt from the static colliders"*. Both are true, and the split is:

| Step | Owner | Fills |
|---|---|---|
| Allocate the `NavGrid` (five typed arrays) | `world` | `cellSize`, `width`, `height`, `originX`, `originZ` |
| Sample the terrain | `world` | `height[]` — from the terrace field and the 2 m noise lattice |
| Attach it to the instance | `world` | `ZoneInstance.nav` |
| Rasterise the colliders | `nav.rebuild(zone)` | `flags[]`, `cost[]`, `region[]`, `regionCount`, `version` |

`nav.rebuild(zone)` reads `world.staticFootprints` (an addition — §13 A1) and
`zone.nav.height`. It never touches `three`, never queries `physics`, and runs
identically in Node. That is what lets `tools/mapgen.mjs` rasterise 200 seeds
without a browser.

### 6.2 The eleven passes

Fixed order. Each pass reads only what its predecessors wrote.

| # | Pass | Writes | Method |
|---|---|---|---|
| **N1** | Clear | `flags = 0`, `cost = 255`, `region = −1` | Three `TypedArray.fill()` calls |
| **N2** | Ground stamp | `walkable`, `interior`, `water` | Scanline over each **ground region** (a terrace rect/disc, a room, a corridor, a gate). Ground regions are emitted by the generator alongside footprints. |
| **N3** | Slope | clears `walkable` | For each walkable cell, if any 4-neighbour is walkable and `\|Δheight\| > 0.45 m`, clear `walkable` and set `blocked` on the **higher** of the two. Single pass over a snapshot of N2's output, so the result does not depend on iteration order. |
| **N4** | Footprint stamp | `blocked`, clears `walkable` | §6.3 |
| **N5** | Doorway | `doorway` | A walkable cell whose 8-neighbourhood contains ≤ 4 walkable cells, **or** that lies inside a footprint-emitted `doorway` rect (B6, the arena gate, the town gate) |
| **N6** | Cost | `cost` | §6.4 |
| **N7** | Regions | `region`, `regionCount` | 4-connected two-pass labelling with union-find over `walkable` cells. Scanned row-major; label ids are assigned in scan order, so region **0 always contains the lowest-index walkable cell** and ids are stable across runs. |
| **N8** | Entry region | — | Assert `region[entryCell] !== −1`; record it as `zone.entryRegion`. |
| **N9** | `spawnDeny` | `spawnDeny` | Stamp discs: **8.0 m** around every entry, **8.0 m** around every portal pad, **4.0 m** around every chest, and the whole of any room flagged `entry`. In `last_bastion`, every walkable cell. |
| **N10** | Prune | clears `walkable`, sets `region = −1` | Any walkable component of **fewer than 16 cells (4 m²)** is deleted. A four-square-metre island is a rasterisation artefact, not a place; leaving it in means A* can be asked to path to it. |
| **N11** | Version | `version` | `version = ++navVersionCounter`; mirror to `zone.navVersion`; emit `nav:rebuilt { zoneId, navVersion, regionCount }` |

`navVersionCounter` is a **process-global monotonic integer**, not per-zone. A
town → wastes → town cycle therefore produces versions 1, 2, 3 and never
repeats one, which is what makes `brain.pathVersion !== nav.version` a sound
staleness test across a zone change.

### 6.3 Rasterisation — N4 in detail

Footprints are convex and axis-aligned in 96 % of cases, so there are two
paths:

```
stampFootprint(fp):
    if not fp.navBlock: return
    d   = 0.30                                  // agent dilation, see below
    box = aabb(fp) expanded by d
    for cz in cellRange(box.z0, box.z1):
      for cx in cellRange(box.x0, box.x1):
        p = cellCentre(cx, cz)
        dist = (fp.kind === 'box' && fp.rotation % (π/2) === 0)
                 ? axisAlignedBoxDistance(p, fp)         // 6 ops
                 : (fp.kind === 'circle')
                     ? hypot(p.x-fp.x, p.z-fp.z) - fp.radius
                     : convexPolyDistance(p, fp.points)  // ≤ 8 edges
        if dist <= d:
            flags[i] |=  NAV_FLAG.blocked
            flags[i] &= ~NAV_FLAG.walkable
            cost[i]   = 255
        else if dist <= d + 0.3536:             // half a cell diagonal
            nearWall[i] = 1                     // scratch, consumed by N6
```

**Dilation is 0.30 m, not the player's 0.36 m radius.** The reasoning:

- A dilation of exactly the agent radius makes A* refuse gaps that
  `physics.moveBody`'s slide would in fact get through, and produces the
  classic "the monster stands still because the grid says the doorway is shut"
  bug.
- A dilation of 0 makes A* thread paths that clip corners, and the player
  visibly grinds along walls.
- 0.30 m is 0.06 m inside the player radius. The residual 6 cm is absorbed by
  `physics.moveBody`'s slide in a single fixed step at any speed under
  3.6 m/s… and at the Ravager's 4.2 m/s it takes two. This is measured against
  the widest agent in the game, the Maulsmith at 0.55 m, for whom every
  corridor and doorway is guaranteed **≥ 3.0 m** (§4.2 B4/B6) — 1.7 m of slack.

Because footprint edges always land on 0.5 m boundaries (§1.2), the only cells
where `dist` lands near the threshold are the dilation shell, so the
rasterisation has no ambiguous cells and no floating-point tie-breaks.

### 6.4 The cost field — N6

`NavGrid.cost` is `1..255`, `255 = impassable`. It is a **traversal weight for
A***, and it is what makes monsters walk down the middle of a corridor instead
of scraping the wall:

```
cost[i] = 255                       if blocked
        = 1
          + (nearWall[i] ? 2 : 0)   within ~0.65 m of a blocker
          + (water       ? 6 : 0)
          + (hazard      ? 12 : 0)  written at runtime by skills.markHazard()
          + (doorway     ? 0 : 0)   doorways are NOT penalised — they are the route
        clamped to 254
```

A `+12` hazard penalty makes an agent detour up to 12 cells (6 m) around an
Ash Wall rather than walk through it, and take it if the detour is longer.
That is the correct behaviour for a hazard the player can cross and the AI
should not.

### 6.5 Build cost

Per-cell costs from the model below assume a 3.0 GHz desktop core, typed arrays,
monomorphic call sites and no allocation. The dominant term is deliberately
**not** the height field: sampling 3-octave noise per nav cell would cost
1.4 ms on its own, which is why §1.3 samples on a **2 m lattice** (49 × 49 taps
for a 96 m zone) and bilinearly interpolates.

**Ashen Wastes — 192 × 192 = 36 864 cells, ≈ 1 150 footprints:**

| pass | items | ns/item | ms |
|---|---:|---:|---:|
| N1 clear (3 × fill) | 110 592 | 0.4 | 0.044 |
| N2 ground stamp | 36 864 | 1.1 | 0.041 |
| height lattice (49² taps, 3 octaves) | 2 401 | 38 | 0.091 |
| height bilinear → `height[]` | 36 864 | 2.6 | 0.096 |
| N3 slope | 36 864 | 4.2 | 0.155 |
| N4 footprint stamp (≈ 47 000 cell tests) | 47 000 | 6.0 | 0.282 |
| N5 doorway | 36 864 | 3.1 | 0.114 |
| N6 cost | 36 864 | 1.8 | 0.066 |
| N7 regions (2-pass + union-find) | 36 864 | 11.0 | 0.406 |
| N9 `spawnDeny` | ≈ 3 000 | 5.0 | 0.015 |
| N10 prune | 36 864 | 1.4 | 0.052 |
| | | **total** | **1.36 ms** |

**All four zones:**

| zone | cells | footprints | estimated build | **budget** | hard fail |
|---|---:|---:|---:|---:|---:|
| `last_bastion` | 14 400 | 310 | **0.54 ms** | 2.0 ms | 6.0 ms |
| `ashen_wastes` | 36 864 | 1 150 | **1.36 ms** | 3.0 ms | 8.0 ms |
| `bonereach` | 50 176 | 2 640 | **2.09 ms** | 4.0 ms | 10.0 ms |
| `altar_of_instruction` | 9 216 | 168 | **0.34 ms** | 1.5 ms | 4.0 ms |

These are **estimates from the cost model above, not measurements** — no
implementation exists yet. They become measurements at step 7 of §12, where
`tools/mapgen.mjs --timing` reports p50/p95/p99 over the 200-seed sweep and
fails the build if p95 exceeds the budget column. The budgets carry roughly
2× headroom over the estimates precisely because the estimates are a model.

For scale: the whole nav build is **one eighth of a 16.6 ms frame**, and it
happens once per zone behind a fade that is already 350 ms long (§10.3). Nav
build is not a transition-time problem and never will be; the geometry build is
(§10.3), by a factor of 150.

Memory, per `01-data-model.md` §9.3: 288 KB for the Wastes, 392 KB for
Bonereach, 115 KB for the town, 72 KB for the Altar. At most two instances live
(current + town) → peak **507 KB**, inside the stated < 1 MB budget.

### 6.6 Dynamic blockers — and why the grid never rebuilds

**The nav grid is immutable after `nav.rebuild()` except for
`NAV_FLAG.hazard`.** There is no incremental re-rasterisation, no dirty-rect
update and no region recompute at runtime. Everything dynamic is handled by one
of exactly three mechanisms:

| Dynamic thing | Mechanism | Cost |
|---|---|---|
| **The Emberwright's Ash Wall** (`ash_wall`, 6 m, 8 s) | `skills.markHazard(x, z, r, true)` sets `NAV_FLAG.hazard` and bumps `cost` by 12 on the covered cells; `markHazard(..., false)` clears it. It **does not** clear `walkable`. | 6 m × 1.5 m ≈ 36 cells, two `for` loops, ~2 µs. Region ids are untouched, so no path can be invalidated by it. |
| **Fire pools, meteor craters, poison clouds** | Same. `skills` is the only writer of the hazard bit, per `02-api-contracts.md` §10. | Same. |
| **Corpses** | Not blockers. A corpse is an `Actor` with `ACTOR_FLAG.corpse` and `noCollide`; it is not in the physics broadphase as a blocker and the nav grid never hears about it. | Zero. |
| **Destructible props** (barrels, urns, sarcophagi) | Not in the nav grid. Each is an `ACTOR_KIND.prop` actor with a physics **body**, so it participates in `physics.separate()` and `physics.circleCast()`, and agents steer around it with local avoidance rather than pathing. | Zero nav cost; one body each. |
| **Monsters and the player** | Physics bodies and crowd separation, never nav. | Zero. |

The rule that makes this safe is a **generator constraint**, checked by
invariant **I6**:

> No destructible prop may be placed in a cell flagged `doorway`, within 1.5 m
> of a corridor centreline, or in any position where removing it from the
> walkable set would change `regionCount`.

The third clause is the real guarantee and it is checked directly: mapgen
re-runs N7 with every destructible's footprint stamped as blocked, and asserts
`regionCount` is unchanged. If a barrel could seal a passage, the seed fails.

**Why not incremental rebuild.** A partial re-rasterisation must also re-run
the connected-component labelling, because a single new blocker can split a
region. Incremental connected components under deletion is either a full
recompute (0.4 ms, every time a barrel breaks — 25 times in one fight) or a
dynamic-connectivity structure, which is 300 lines of subtle code guarding a
feature nobody asked for. Making blockers into physics bodies costs nothing and
removes the entire class of bug.

### 6.7 Versioning contract

```
zone:enter  { zoneId, seed, entry }
    ↓  world builds geometry, footprints, ground regions
physics.rebuild()
    ↓
nav.rebuild(zone)                      → N1..N11, version = ++counter
    ↓
nav:rebuilt { zoneId, navVersion, regionCount }
    ↓
R11 / B-spawn: SpawnPoints and PackDescriptors computed from the finished grid
    ↓
zone:ready  { zoneId, bounds, navVersion }
```

- `ZoneInstance.navVersion`, `NavGrid.version` and the `zone:ready` /
  `nav:rebuilt` payloads always carry the **same** integer.
- `ai` compares `brain.pathVersion !== nav.version` and repaths. `PathHandle`s
  are released by `nav` on rebuild; holding one across a version change is a
  bug (`02-api-contracts.md` §6).
- The counter is **not** reset on a retained zone (§10.4): returning through a
  town portal re-runs `nav.rebuild()` and gets a fresh version, even though the
  grid contents are bit-identical. Versions are cheap; a stale path is not.

---

## 7. Generator guarantees and their validation

### 7.1 The invariants

Nine invariants. Every one is checked by `tools/mapgen.mjs` on every seed of the
sweep, for every generated zone and every difficulty tier. A generator change
that breaks one does not ship.

| # | Invariant | Applies to | Check |
|---|---|---|---|
| **I1** | **Entry → exit is always walkable.** For every entry tag and every exit trigger, `nav.regionAt(entry) === nav.regionAt(exit)` and both are `≥ 0`. | wastes, bonereach, altar | Region compare after N7 |
| **I2** | **Every chest is reachable.** Every `ZoneInstance.chests[i]` has `regionAt(chest) === entryRegion`. No loot in a sealed pocket. | all | Region compare |
| **I3** | **Every pack is reachable and outside geometry.** Every `PackDescriptor` centre and every `SpawnPoint` satisfies `walkable(p)`, `regionAt(p) === entryRegion`, and `nav.snap(p, 0.0)` returns `p` unchanged (i.e. it is *already* on a walkable cell, not merely near one). | wastes, bonereach, altar | Flag + region + identity |
| **I4** | **Monster density is within ±20 % of target.** `Σ pack.count / walkableArea ∈ [0.8, 1.2] × densityTarget`. | wastes, bonereach, altar | Arithmetic over `packs[]` |
| **I5** | **The boss is reachable and the arena is intact.** In the Altar: `regionAt(0, +5) === regionAt(entry)`, the exit portal pad is in the same region, and all 12 teleport anchors and 8 summon anchors are walkable. | altar | Region + flag |
| **I6** | **No destructible can seal a region.** Re-running N7 with every destructible stamped blocked leaves `regionCount` unchanged; no destructible sits on a `doorway` cell. | all | Second flood fill |
| **I7** | **The arena floor is open.** Blocked cells inside `r = 16.0 m` of the Altar centre `= 114 ± 6`. | altar | Cell count |
| **I8** | **The Occlusion Plane Rule holds.** For every walkable cell `P` and every static solid within `\|x − P.x\| ≤ 1.2` and `z ∈ [P.z − 13.545, P.z]`, `topY ≤ 1.00 + 1.206 · (P.z − z)`. | all | §7.3 |
| **I9** | **The world edge is never visible.** For every walkable cell `P`, the camera trapezoid anchored at `P` contains no point that is outside the zone bounds and not covered by ridge wall, berm, silhouette ring or ≥ 0.98 fog opacity. | wastes | §7.3 |

Two further checks are **warnings**, not failures, because they are tuning
signals rather than correctness:

| # | Warning | Threshold |
|---|---|---|
| **W1** | Archetype fallback rate (§3.2 R7) | > 2 % of cells |
| **W2** | R2 L-path fallback rate (§3.2 R2) | > 0.1 % of seeds |

### 7.2 How the sweep runs

```
node tools/mapgen.mjs --zones all --seeds 200 --difficulty all
```

- **Seeds.** `worldSeed = 0x1F3AC09B + i` for `i ∈ 0..199`, plus the eleven
  **pinned fixture seeds** listed in §7.4, which are always run regardless of
  `--seeds`. `runIndex` is swept `0..2` for each, giving `200 × 3 = 600`
  layouts per zone per difficulty.
- **No browser, no `three`, no DOM.** The tool imports `src/world/gen/*.js`
  (pure layout), `src/world/data/*.js` (tables), and `src/nav/raster.js`
  (passes N1–N10) directly as ESM. This is exactly the architectural
  requirement in `IMPLEMENTATION_PLAN.md` §8: *"map generation must import into
  Node directly"*. `src/world/build/*.js`, which is the only part that touches
  `three`, is never imported.
- **Runtime target.** 600 layouts × 3 zones × 3 difficulties = 5 400
  generations. At the §6.5 model plus ~2 ms of pure layout each, the sweep is
  **≈ 22 s single-threaded**. It runs in CI on every change under
  `src/world/` or `src/nav/`.
- **Output.** A PNG region map per fixture seed and per failing seed, written
  to `tools/out/mapgen/`, plus a JSON layout record for every failure.

### 7.3 The two geometric invariants in detail

**I8 — Occlusion Plane.** Naïvely this is (walkable cells) × (footprints) =
36 864 × 1 150 = 42 M tests. It is instead done as a **sweep over X-slabs**:

```
for each 0.5 m slab of constant x:
    solids = footprints overlapping the slab, sorted by z ascending
    walk   = walkable cells in the slab, sorted by z ascending
    two-pointer over (walk, solids) keeping the window z ∈ [P.z − 13.545, P.z]
    for each solid in the window: assert solid.topY <= 1.00 + 1.206 * (P.z - solid.z1)
```

The window holds at most 27 solids in the densest zone, so the whole check is
`O(cells + footprints · 27)` ≈ 68 000 operations, under 1 ms. Only the solid's
**nearest face** (`z1`, its north face) is tested, because a convex solid's
worst case against a plane sloping away from the viewer is always its nearest
edge at its maximum height.

**I9 — World edge.** Also a sweep, not a raycast:

```
for each walkable cell P:
    farZ = P.z + 11.68                       // the far edge of the trapezoid
    if farZ <= boundsMaxZ − 2.0: continue    // interior, trivially covered
    halfW = 17.16                            // half-width at the far edge
    assert every (x, farZ) with |x − P.x| <= halfW is either
           inside bounds, or covered by ridge/berm/silhouette,
           or fogOpacityAt(distance from camera) >= 0.98
```

`fogOpacityAt` is the analytic `wastes` fog curve, evaluated in Node with no
`sky` instance — the curve is a data table (`src/sky/data/presets.js`) and
mapgen reads it. Since the camera is fixed, "distance from camera" for the far
edge is always **30.61 m**, at which the `wastes` preset is at 0.994 opacity;
the check therefore reduces to *ridge coverage*, which is the thing that can
actually be wrong.

### 7.4 Pinned fixture seeds

Eleven seeds are pinned because each one exercises a rare branch. They run on
every sweep, they carry a golden layout hash, and **their hashes are only
updated in a commit that explains why the layout changed.**

| seed | zone | exercises |
|---|---|---|
| `0x00000B27` | wastes | R1 forced-fallback exit column |
| `0x1D40C6A2` | wastes | `PROTO_CAP` prototype-cap trim |
| `0x4B90117E` | wastes | R2 backtracking ≥ 3 deep |
| `0x77C1A030` | wastes | maximum `connected` = 14 cells |
| `0xA0031C55` | wastes | minimum `connected` = 9 cells; density at the lower bound |
| `0xC17F2200` | wastes | two `warcamp` cells adjacent on the spine (A4 boundary) |
| `0x2C71E004` | bonereach | 15 rooms, flooded room on the critical path |
| `0x9E44B071` | bonereach | `targetRooms = 12` (minimum) with 4 vaults |
| `0xE0A73318` | bonereach | `targetRooms = 18` (maximum); prop budget clamp fires |
| `0x5512C88D` | bonereach | B6 corridor re-route (wall too short) on ≥ 3 corridors |
| `0x00000001` | all | the trivial seed; the layout every developer has memorised |

### 7.5 What a failure looks like

`tools/mapgen.mjs` exits non-zero and prints exactly this:

```
mapgen  zones=[ashen_wastes, bonereach, altar_of_instruction]  seeds=200  runIndex=0..2
        difficulty=[instruction, trial, renunciation]           layouts=5400

ashen_wastes                                     1800 layouts   4.31 s
  I1  entry→exit walkable ....................... 1800/1800   ok
  I2  chests reachable .......................... 1799/1800   FAIL
  I3  packs walkable and in region .............. 1800/1800   ok
  I4  density within ±20 % ...................... 1800/1800   ok   [-14.2 %, +18.6 %]
  I6  destructibles cannot seal ................. 1800/1800   ok
  I8  occlusion plane ........................... 1800/1800   ok
  I9  world edge not visible .................... 1798/1800   FAIL
  W1  archetype fallback rate ................... 0.71 %      ok
  W2  L-path fallback rate ...................... 0.00 %      ok
  nav build p50/p95/p99 ......................... 1.31 / 1.58 / 1.94 ms   ok (budget 3.00)

FAIL  I2  zone=ashen_wastes  worldSeed=0x1F3AC0AF  runIndex=1  seed=0x3C91A07E
      chest[2] at (18.25, -30.75)          region 4
      entry 'portal_from_town' at (-12.00, -44.00)  region 0
      regions: 0 → 19 240 cells, 4 → 96 cells
      cause  : dead-end tip cell (2,0) reached region 4 only through gate
               (2,0)↔(2,1), whose carved width 8 m was fully occupied by
               3 × ruin_stub footprints from cell (2,1)'s dressing pass
      repro  : node tools/mapgen.mjs --zone ashen_wastes --seed 0x3C91A07E --ascii
      wrote  : tools/out/mapgen/ashen_wastes-0x3C91A07E.png       region map, chest marked red
      wrote  : tools/out/mapgen/ashen_wastes-0x3C91A07E.json      full layout record
      wrote  : tools/out/mapgen/ashen_wastes-0x3C91A07E.ascii.txt macro-cell map

FAIL  I9  zone=ashen_wastes  worldSeed=0x1F3AC0C1  runIndex=0  seed=0x77118A20
      walkable cell (44.75, 44.25) sees to z = +55.93
      uncovered span x ∈ [+38.1, +48.0] at z = +55.93
      cause  : cell (3,3) is `connected` and its north ridge wall run was
               truncated by the S1 jitter to topY 4.51 m; the berm behind it
               tops out at +3.0 m, and the silhouette ring starts at r = 62 m
      wrote  : tools/out/mapgen/ashen_wastes-0x77118A20.png       coverage map

bonereach                                        1800 layouts   9.86 s
  I1 ...  1800/1800  ok       I2 ...  1800/1800  ok
  I3 ...  1800/1800  ok       I4 ...  1800/1800  ok   [-11.0 %, +9.7 %]
  I6 ...  1800/1800  ok       I8 ...  1800/1800  ok
  rooms 12..18 ..... ok        connectivity proof holds on 1800/1800
  nav build p50/p95/p99 ......................... 2.02 / 2.44 / 2.91 ms   ok (budget 4.00)

altar_of_instruction                             1800 layouts   1.12 s
  I1 ...  1800/1800  ok       I3 ...  1800/1800  ok
  I5 ...  1800/1800  ok       I7 ...  1800/1800  ok   [114, 114]
  I8 ...  1800/1800  ok
  nav build p50/p95/p99 ......................... 0.33 / 0.38 / 0.44 ms   ok (budget 1.50)

fixtures: 11/11 hashes match
2 invariant failures across 5400 layouts (0.037 %)
exit 1
```

The `cause:` line is not decoration. The tool knows the generator's stage
structure, so on a failure it re-runs the seed with per-stage instrumentation
and reports the last stage that changed the failing quantity. Without it, a
0.037 % failure rate is a week of bisecting seeds.

---

## 8. Spawning

`world` produces `SpawnPoint[]` and `PackDescriptor[]`. `ai` reads them on
`zone:ready` and calls `ai.spawnPack()`. `world` never spawns an actor.
`ai` writes back `members[]`, `spawned` and `aliveCount` on the descriptor,
which `01-data-model.md` §9.5 sanctions explicitly (*"`members: ActorRef[]` —
filled at spawn"*).

### 8.1 The budget is derived, not drawn

The naïve approach — draw `packCount` from the descriptor, draw each
`packSize`, place them — cannot satisfy invariant **I4**, because the walkable
area varies by 60 % between the smallest and largest layouts of the same zone.
Density is therefore **solved for**, and `packCount` is a clamp on the answer:

```
walkableArea  = (count of cells with NAV_FLAG.walkable) × 0.25          // m²
targetTotal   = round( descriptor.densityTarget × walkableArea × tierDensityMul )
meanPackSize  = (descriptor.packSize.min + descriptor.packSize.max) / 2
packCount     = clamp( round(targetTotal / meanPackSize),
                       descriptor.packCount.min, descriptor.packCount.max )

// distribute targetTotal over packCount, respecting [min, max] per pack
base      = floor(targetTotal / packCount)
remainder = targetTotal − base × packCount
sizes[i]  = clamp( base + (i < remainder ? 1 : 0),
                   descriptor.packSize.min, descriptor.packSize.max )
// any shortfall from clamping is redistributed round-robin to packs under max;
// any excess is shaved round-robin from packs above min. Both loops terminate
// because packCount × max ≥ targetTotal ≥ packCount × min by construction.
```

Worked, for the Ashen Wastes across its full walkable range:

| walkable | target | packCount | sizes | achieved density | vs 0.0125 |
|---:|---:|---:|---|---:|---:|
| 4 400 m² (9 cells, tight) | 55 | 9 | 6×7 + 3×6 | 0.01250 | **0.0 %** |
| 4 810 m² (worked example, §3.3) | 60 | 9 | 6×7 + 3×6 → 60 | 0.01248 | **−0.2 %** |
| 6 365 m² (typical, 12 cells) | 80 | 9 | 8×9 + 1×8 | 0.01257 | **+0.6 %** |
| 7 900 m² (14 cells, open) | 99 | 12 | 3×9 + 9×8 | 0.01253 | **+0.2 %** |
| 8 400 m² (theoretical max) | 105 | 12 | 9×9 + 3×8 | 0.01250 | **0.0 %** |

The ±20 % band of I4 is never approached, because the only source of error is
integer rounding. The band exists to catch a *bug*, not to absorb variance —
which is exactly what an invariant should do.

`tierDensityMul` is `1.00 / 1.10 / 1.20` for Instruction / Trial /
Renunciation. It is applied inside `targetTotal`, so I4 checks against
`densityTarget × tierDensityMul` and stays exact on every tier.

### 8.2 Density per cell archetype

`targetTotal` is distributed over the connected macro cells (Wastes) or the
rooms (Bonereach) in proportion to `archetypeDensityMultiplier × cellArea`:

```
weight(cell) = densityMul(archetype(cell)) × walkableArea(cell)
share(cell)  = targetTotal × weight(cell) / Σ weight
```

then packs are assigned to cells by largest-remainder, so the cell with the
biggest fractional share gets the extra pack.

**Ashen Wastes**, with the multipliers from §3.2 R7:

| archetype | density × | typical walkable/cell | monsters/cell at 12 connected cells | packs |
|---|---:|---:|---:|---:|
| `ash_flats` | 0.85 | 512 m² | 5.4 | 0–1 |
| `dead_grove` | 1.10 | 486 m² | 6.6 | 1 |
| `ruin_field` | 1.20 | 470 m² | 7.0 | 1 |
| `bone_yard` | 1.00 | 498 m² | 6.2 | 1 |
| `ravine` | 0.75 | 402 m² | 3.7 | 0–1 |
| `warcamp` | 1.60 | 480 m² | 9.6 | 1–2 |

A `warcamp` therefore reliably fields **9–10 monsters in one 24 m cell**, which
under a camera that shows 18.7 m of depth is the plan's *"10–25 on screen"*
upper band, reached by one cell and not by a lucky overlap.

**Bonereach**, by room role:

| role | density × | typical area | monsters | packs |
|---|---:|---:|---:|---:|
| `entry` | 0.00 | 190 m² | 0 | 0 — the whole room is `spawnDeny` |
| `hall` | 1.00 | 191 m² | 5.9 | 1 |
| `vault` | 1.35 | 165 m² | 6.9 | 1, forced champion |
| `flooded` | 0.70 | 240 m² | 5.2 | 1 |
| `stair` | 1.20 | 210 m² | 7.8 | 1 |
| corridors | 0.15 | ≈ 90 m each | 0–1 | wanderers only |

### 8.3 Placement

```
for each pack p, in cell order (spine order, then branch order; room index order):
    // 1. centre — S3
    for tries in 0..23:
        c = randomWalkablePointInCell(S3)
        reject if not walkable(c)
        reject if flags(c) & spawnDeny
        reject if pathDistanceFromEntry(c) < safetyRadius       // §8.5
        reject if dist(c, any placed pack centre) < 9.0
        reject if the disc of radius `radius` around c has < 70 % walkable cells
        accept
    if no accept after 24 tries: place at the cell's walkable centroid,
                                 and count a PLACEMENT_FALLBACK

    // 2. archetype — S3
    p.archetypeId = S3.weighted(bestiaryWeights(archetype(cell)))

    // 3. count — from §8.1, not drawn
    p.count = sizes[p.id]

    // 3b. monster level — not drawn; a function of the cell's distance from entry
    p.mlvl = OPENING_RAMP.applies(zoneId, tier, quest)
           ? rampMlvl(pathDistanceFromEntry(c))
           : descriptor.monsterLevel + DIFFICULTY_MLVL_OFFSET[tier]

    // 4. rank — S3, one draw
    u = S3.next()
    p.rank = u < uniqueChance                ? 'unique'
           : u < uniqueChance + champChance   ? 'champion'
           : 'normal'
    (demoted per §8.4)

    // 5. affixes — S3, only when rank != normal
    ai.rollAffixes(p.rank, p.mlvl, S3, p.affixes)     // 1 for champion, 3 for unique

    // 6. scatter radius — S3
    p.radius     = S3.range(3.5, 5.5)
    p.aggroCloud = p.radius + 4.5                     // 8.0 .. 10.0 m

    // 7. member spawn points — S3
    for m in 0 .. p.count-1:
        pt = c + S3.disc(p.radius)
        pt = nav.snap(pt, 2.0)
        push SpawnPoint { kind:'pack', x:pt.x, z:pt.z,
                          facing: S3.range(0, 2π),
                          packIndex: p.id,
                          regionId: nav.regionAt(pt) }
```

`nav.snap(pt, 2.0)` is what makes invariant **I3** hold by construction: a
scatter point that lands inside a prop's footprint is pulled to the nearest
walkable cell within 2 m. If `snap` fails (returns null), the member is
re-drawn once with half the radius; if that fails, the member is placed at the
pack centre. `PackDescriptor.count` is never reduced — the pack always fields
what the density budget promised.

**Rank draw order matters.** Steps 2–7 draw from `S3` in exactly this order for
every pack, in pack order. Adding a seventh step, or moving the affix roll
before the count, reshuffles every pack in every zone and invalidates the
fixtures. This is the single most fragile ordering in the generator and it is
called out in `src/world/gen/spawn.js`'s header comment.

### 8.4 Champion, unique and forced placement

| Rule | Detail |
|---|---|
| **Mutual exclusion** | A pack is `unique` **or** `champion`, never both. The single `S3.next()` draw of step 4 enforces it structurally. |
| **One unique per zone** | The first pack whose draw lands in `[0, uniqueChance)` becomes the unique. Every later `unique` draw is **demoted to `champion`**. The Altar rolls `uniqueChance: 0` and has none. |
| **Dead-end reward** | Every dead-end tip cell (Wastes) and every `vault` room (Bonereach) is **forced** to at least `champion`. If the zone has not yet placed its unique when the *last* dead-end pack is assigned, that pack is forced to `unique`. So every seed has exactly one unique, always in a side pocket, always beside a chest. |
| **Escort** | A `unique` pack's `count` is the density-derived size; `ai` spawns `count − 1` members at `rank: 'minion'` plus the unique itself. The plan's "3–5 minions" is satisfied because `packSize.min = 5`. |
| **Boss** | `Molgrim` is **not** a `PackDescriptor`. He is a single `SpawnPoint { kind: 'boss', x: 0, z: 5, facing: −π/2 }` in the Altar, spawned by `ai.spawnBoss()`. He does not count toward `targetTotal` and is excluded from I4. |
| **Wanderers** | Bonereach corridors get `SpawnPoint { kind: 'wanderer' }` with `packIndex: −1`, one per 25 m of corridor, `S3`-drawn from the two cheapest archetypes. They count toward `targetTotal` at their literal count of 1. |
| **NPCs** | `SpawnPoint { kind: 'npc' }` in the town only, one per `NPCS` entry, in array order. `ai` instantiates them via `ai.spawnOne(archetypeId, x, z, 0, 'normal', [])` with `team: TEAM.neutral`. |

### 8.5 The safety radius

A pack that can reach the player before they have finished the zone-entry fade
is a cheap death. The radius is measured as **path distance from the entry over
the nav grid**, not Euclidean — a pack 12 m away around a ridge is not a
threat, and a pack 12 m away down a straight corridor is.

```
pathDistanceFromEntry = the BFS distance field computed once during N7,
                        seeded at the entry cell, in metres
```

| zone | pack centre min | `SpawnPoint` min | `spawnDeny` disc (N9) |
|---|---:|---:|---:|
| `ashen_wastes` | **16.0 m** | 11.0 m | 8.0 m |
| `bonereach` | **14.0 m** | 10.0 m | 8.0 m + the whole `entry` room |
| `altar_of_instruction` | **12.0 m** | 9.0 m | 8.0 m + the whole approach corridor |
| `last_bastion` | — | — | the whole zone |

16.0 m of path against the Bone Ranker's 3.2 m/s is **5.0 s** of grace, which
is 3.9 s longer than the 1.1 s black-to-playable window of §10.3 and long
enough for the player to read the frame. The `SpawnPoint` minimum is lower than
the pack-centre minimum by design: a pack centred at exactly 16 m with a 5.5 m
scatter radius may legitimately place a member at 11 m, and forcing every
member outside 16 m would push packs into the middle of cells and destroy the
dressing-driven composition.

### 8.6 Scaling with zone level and difficulty tier

```
mlvl = descriptor.monsterLevel + DIFFICULTY_MLVL_OFFSET[tier]
```

with one documented exception, step 3b of §8.3: on a character's **first**
Ashen Wastes descent at Instruction, `OPENING_RAMP` overrides `mlvl` per pack
from the pack centre's path distance to the entry — mlvl 2 inside 30 m, 4 inside
55 m, 6 beyond. The table is `player`-owned (`src/player/data/progression.js`,
`13-progression-lore.md` §1.2) and `world` imports it, exactly as it imports
`DIFFICULTY_MLVL_OFFSET` from `combat`. It switches itself off the moment the
quest passes step 1, so there is no permanently easy zone and no second code
path — every later run takes the formula above. Note that this is the only
source of per-pack `mlvl` variation in the generator; without it §1.2's ramp has
nowhere to apply, because a `PackDescriptor` otherwise inherits one zone-wide
number.

| tier | `DIFFICULTY_MLVL_OFFSET` | `tierDensityMul` | `champChance` × | `uniqueChance` × | `chestCount` + |
|---|---:|---:|---:|---:|---:|
| `instruction` | **+0** | 1.00 | 1.00 | 1.00 | +0 |
| `trial` | **+12** | 1.10 | 1.35 | 1.30 | +1 |
| `renunciation` | **+22** | 1.20 | 1.70 | 1.60 | +2 |

Resulting monster levels:

| zone | Instruction | Trial | Renunciation |
|---|---:|---:|---:|
| `ashen_wastes` | 6 | 18 | 28 |
| `bonereach` | 11 | 23 | 33 |
| `altar_of_instruction` | 15 | 27 | 37 |

`DIFFICULTY_MLVL_OFFSET` is a **combat-owned table**: its authority is
`03-combat-math.md` §10.2, and `world` imports it rather than redeclaring it.
This document originally carried `+0 / +9 / +17`, giving 6/15/23, 11/20/28 and
15/24/32; those were this document's own numbers and they lost to combat's
`+0 / +12 / +22` by the rule stated in this very paragraph. The table above is
now combat's, and the two match. `tools/mapgen.mjs` fixtures are generated
against these values; if combat ever lands different numbers the fixture hashes
change and the sweep says so on the first run. The multipliers in the other four columns are **`world`'s
own** and live in `src/world/data/difficulty.js`.

`champChance × 1.70` at Renunciation takes the Wastes from 0.16 to **0.272**
per pack — a little over one champion in four packs, against 9–12 packs, so
roughly three champions per zone. That is the intended shape: Renunciation is
not "the same map with bigger numbers", it is a map where a quarter of the
fights are elite.

Difficulty does **not** change the layout. `seed = hash(worldSeed, zoneId,
runIndex)` contains no tier term, so the same `runIndex` on Trial produces the
identical map with a heavier population. That is deliberate — it lets a player
learn a layout and lets `tools/balance.mjs` compare tiers on fixed geometry.

---

## 9. Props, containers and world objects

### 9.1 Instancing groups

A **group** is a shared `THREE.Material`; a **prototype** is one merged
`BufferGeometry` rendered as a single `THREE.InstancedMesh`. Draw calls scale
with prototypes, not with instances, and materials are shared across prototypes
so the prepass and the shadow pass can sort tightly.

| group | material key | zones | prototypes | surface |
|---|---|---|---:|---|
| G1 `flora` | `wastes_deadwood` | wastes | 4 | `wood` |
| G2 `rubble` | `wastes_ashrock` | wastes, altar | 4 | `stone` / `ash` |
| G3 `ruin` | `stone_ruin` | wastes, altar | 5 | `stone` |
| G4 `bone` | `bone_field` | wastes, bonereach, altar | 4 | `bone` |
| G5 `camp` | `camp_cloth` | wastes | 4 | `wood` / `metal` |
| G6 `container` | `container_mixed` | all | 5 | `wood` / `stone` / `metal` |
| G7 `crypt` | `crypt_stone` | bonereach, altar | 6 | `stone` / `metal` |
| G8 `town` | `town_timber` | town | 8 | `wood` / `stone` / `metal` |
| G9 `far` | `silhouette` | wastes | 2 | — (no collider) |

Nine materials, **42 prototypes** across the whole game, of which at most **18**
are resident in any one zone (§3.4).

### 9.2 The catalogue

`tris` is the L0 merged triangle count of one instance. `spacing` is
`protoSpec.minSpacing` for the R8 dart throw. `block` is `Footprint.navBlock`.

| prototype | group | tris | spacing | `topY` | block | destructible | container |
|---|---|---:|---:|---:|:---:|:---:|:---:|
| `dead_tree_tall` | G1 | 620 | 3.2 | 6.4 | ✔ | — | — |
| `dead_tree_split` | G1 | 480 | 3.0 | 4.8 | ✔ | — | — |
| `thicket` | G1 | 260 | 1.6 | 1.3 | — | — | — |
| `root_claw` | G1 | 180 | 1.4 | 0.7 | — | — | — |
| `boulder_large` | G2 | 340 | 2.8 | 2.2 | ✔ | — | — |
| `boulder_small` | G2 | 160 | 1.2 | 0.8 | — | — | — |
| `ash_drift` | G2 | 96 | 2.0 | 0.5 | — | — | — |
| `slag_shard` | G2 | 120 | 1.0 | 1.1 | — | — | — |
| `ruin_wall_stub` | G3 | 420 | 3.4 | 2.6 | ✔ | — | — |
| `ruin_arch` | G3 | 560 | 4.0 | 4.2 | ✔ | — | — |
| `column_drum` | G3 | 210 | 1.8 | 0.9 | — | — | — |
| `column_standing` | G3 | 380 | 2.6 | 3.8 | ✔ | — | — |
| `flagstone_patch` | G3 | 64 | 2.4 | 0.05 | — | — | — |
| `ribcage` | G4 | 520 | 3.0 | 2.1 | ✔ | — | — |
| `skull_pile` | G4 | 300 | 1.6 | 0.7 | — | — | — |
| `spine_arc` | G4 | 240 | 2.2 | 1.4 | — | — | — |
| `bone_shard_field` | G4 | 84 | 1.0 | 0.2 | — | — | — |
| `tent_hide` | G5 | 380 | 3.6 | 2.4 | ✔ | — | — |
| `pyre` | G5 | 290 | 3.0 | 2.0 | ✔ | — | — |
| `stake_row` | G5 | 220 | 2.0 | 2.8 | — | — | — |
| `banner_tattered` | G5 | 150 | 2.4 | 3.2 | — | — | — |
| **`urn_clay`** | G6 | 180 | 1.2 | 0.9 | ✔ | **✔** | **✔** |
| **`barrel_wood`** | G6 | 220 | 1.4 | 1.1 | ✔ | **✔** | **✔** |
| **`crate_wood`** | G6 | 160 | 1.4 | 0.9 | ✔ | **✔** | **✔** |
| **`chest_iron`** | G6 | 460 | 3.0 | 1.0 | ✔ | — | **✔** |
| **`sarcophagus`** | G6 | 540 | 3.4 | 1.2 | ✔ | — | **✔** |
| `crypt_pillar` | G7 | 400 | 3.2 | 5.0 | ✔ | — | — |
| `wall_sconce` | G7 | 140 | 4.0 | 2.4 | — | — | — |
| `chain_hanging` | G7 | 110 | 1.8 | 3.4 | — | — | — |
| `coffin_stack` | G7 | 380 | 2.6 | 1.5 | ✔ | — | — |
| `alcove_skeleton` | G7 | 340 | 3.0 | 1.7 | — | — | — |
| `rubble_interior` | G7 | 130 | 1.2 | 0.6 | — | — | — |
| `crate_wood_town` | G8 | 160 | 1.2 | 0.9 | ✔ | — | — |
| `sack_cloth` | G8 | 190 | 1.0 | 0.7 | — | — | — |
| `market_stall` | G8 | 520 | 4.5 | 2.7 | ✔ | — | — |
| `cart_broken` | G8 | 480 | 3.5 | 1.8 | ✔ | — | — |
| `lantern_post` | G8 | 210 | 5.0 | 2.9 | ✔ | — | — |
| `planter_stone` | G8 | 170 | 2.0 | 0.6 | ✔ | — | — |
| `bench_stone` | G8 | 130 | 2.4 | 0.5 | ✔ | — | — |
| `weapon_rack` | G8 | 290 | 2.0 | 1.9 | ✔ | — | — |
| `far_spire` | G9 | 180 | 8.0 | 26.0 | — | — | — |
| `far_ridge` | G9 | 240 | 12.0 | 18.0 | — | — | — |

**Containers and destructibles.**

| prototype | opened by | contents | life | on break |
|---|---|---|---:|---|
| `urn_clay` | destroyed | `tc_urn` — gold, potions, 6 % a magic base | 1 hit | 12 shards, `bone`/`stone` impact, `S4` sub-seed |
| `barrel_wood` | destroyed | `tc_urn` | 1 hit | 9 staves, `wood` impact |
| `crate_wood` | destroyed | `tc_urn` | 1 hit | 7 planks, `wood` impact |
| `chest_iron` | `world.openChest(id)` | the zone `treasureClass`, 3–5 rolls | — | lid animates, glow, `opened = true` |
| `sarcophagus` | `world.openChest(id)` | the zone `treasureClass`, 2–3 rolls, **40 % chance of a Bone Ranker inside** | — | lid slides, `ai.spawnOne` on the roll |

Destructibles are `ACTOR_KIND.prop` actors with `life`, no brain, and
`TEAM.neutral`. They are spawned by `ai` from `SpawnPoint { kind: 'chest' }`
records, at counts of `S2.int(2, 4)` per `vault` room and `S2.int(0, 3)` per
Wastes cell — never more than **28 per zone**, because each is an `Actor` out
of the same pool the monsters use.

`chest_iron` and `sarcophagus` are **not** destructibles; they are
`Interactable`s. `world.openChest()` returns `false` if already open, sets
`chest.opened = true`, and emits nothing — `items` listens for the return value
through `player`'s interaction path and rolls `chest.treasureClass` with the
chest's `S4` sub-seed, so a chest's contents are fixed at generation time and
identical whether it is opened now or after a town trip.

### 9.3 `Interactable`

`02-api-contracts.md` §5 returns an `Interactable` from
`world.interactableAt()` without defining it. `world` is its only producer:

```js
const Interactable = {
  id:        7,             // int, stable within the ZoneInstance
  kind:      'chest',       // 'npc'|'chest'|'stash'|'portal'|'exit'|'altar'|'waypoint'
  x: 0, z: 0,               // metres
  radius:    2.4,           // metres, the interaction disc
  npcId:     null,          // string when kind === 'npc', else null
  chestId:   0,             // int when kind === 'chest', else 0
  portalId:  0,             // int when kind === 'portal', else 0
  toZone:    null,          // string when kind === 'exit'|'portal', else null
  toEntryTag:null,          // string, ditto
  enabled:   true,          // false → the prompt is hidden (a sealed exit portal)
  promptKey: 'ui.open',     // i18n key for ui.setPrompt()
};
```

`world.interactableAt(x, z, radius)` returns the **nearest enabled**
interactable whose disc overlaps the query, breaking ties by lower `id`. It
returns a shared scratch record per the `out`-parameter convention.

### 9.4 Draw-call and triangle accounting

Budgets: **≤ 150 draw calls, ≤ 2.5 M triangles** for the whole scene.
Characters take 45 000 triangles and, per `08-characters-visual.md` §9.3,
**31 draw calls**.

**Draw calls — worst case, Ashen Wastes `warcamp` cell, 25 monsters:**

| pass | contributor | calls |
|---|---|---:|
| depth/normal prepass | merged static geometry (ground, ridge, walls) | 4 |
| | instanced props with `noPrepass = false` (blockers only, 9 protos) | 9 |
| | characters — excluded by design | 0 |
| shadow cascade 0 | merged statics | 4 |
| | instanced props, blockers only | 9 |
| | characters | 26 |
| shadow cascades 1–2 | merged statics only | 6 |
| opaque main | ground (terrain + terraces + gates) | 3 |
| | ridge wall + berm | 2 |
| | instanced props, 16 prototypes | 16 |
| | silhouette ring | 2 |
| | chests / containers | 2 |
| | characters (skinned 26, corpses 2, swarm 1, contact 2) | 31 |
| | portals and the exit stair | 2 |
| transparent | fx particles (3 blend modes) | 3 |
| | decals | 2 |
| | telegraphs and ground effects | 3 |
| | loot glow | 1 |
| post | GTAO, bloom (4 mips), AgX+LUT, SMAA | 8 |
| sky | dome + fog | 2 |
| `uiScene` | paperdoll / item preview | 3 |
| | | **≈ 139** |

**11 calls of headroom.** The two levers if it is ever exceeded, in order:
merge `flagstone_patch` and `bone_shard_field` into the ground mesh (−2), and
drop the prototype cap from 18 to 16 (−2). Neither is needed at the shipping
configuration.

**Triangles — same scene:**

| contributor | count | tris each | total |
|---|---:|---:|---:|
| ground terrain, 1 m tessellation, 96 × 96 | 1 | 18 432 | 18 432 |
| terrace skirts and gate ramps | 1 | 6 100 | 6 100 |
| ridge wall + berm | 1 | 21 400 | 21 400 |
| props (§9.2 mean 274 tris) | 900 | 274 | 246 600 |
| silhouette ring | 44 | 210 | 9 240 |
| chests, containers, portals | 22 | 340 | 7 480 |
| characters (`08` §9.1 worst case) | — | — | 31 318 |
| fx particles (quads) | 12 000 | 2 | 24 000 |
| decals | 256 | 2 | 512 |
| **total** | | | **365 082** |

**14.6 % of the 2.5 M budget.** The world is not a triangle problem, and it is
important to say so plainly: the constraint that actually binds is **draw calls
and overdraw**, and every decision in §9.1 — nine materials, 42 prototypes, 18
resident, instanced everything — is aimed at draw calls. The triangle ceiling
`world` is held to is **900 000**, which leaves 2.4× headroom for the visual
pass at M8 to add geometry without re-architecting anything.

Per-zone totals:

| zone | props | prototypes | world draw calls | world triangles |
|---|---:|---:|---:|---:|
| `last_bastion` | 282 + 44 authored | 8 | 21 | 121 400 |
| `ashen_wastes` | 900 | 16 | 27 | 301 772 |
| `bonereach` | 1 200 | 17 | 29 | 358 900 |
| `altar_of_instruction` | 380 | 11 | 19 | 142 300 |

---

## 10. Zone transitions and the town portal

### 10.1 Loading policy

**No loading screen. A fade.** The transition is:

```
 0 ms                350 ms                    950 ms          1 300 ms
   ├── fade to black ──┼── black: teardown + generate ──┼── fade in ──→ playable
        350 ms                  600 ms budget               350 ms
```

> **Ruling (O-142, 2026-08-05) — the total is 1 300 ms, not 1 100.** This
> diagram used to label the second boundary `1 100 ms` while also printing
> segments of 350 / 600 / 350, which sum to 1 300 and put the black window's
> end at 950, not 1 100. Three numbers, no two consistent. The segments win:
> they are what §10.3 pads to, what the implementation follows, and what
> measures at exactly **1 300.0 ms on 20 consecutive legs with zero variance**.
> The headline was an arithmetic slip, and the bound that actually protects
> the player — the 2 500 ms hard fail — does not move.

- The fade is driven by `ui` from `lateUpdate` (integrated from `dt`, never a
  CSS transition — `02-api-contracts.md` §14).
- `player.setControlEnabled(false)` for the whole window; input is dropped, not
  queued, so a click during the fade never fires into the new zone.
- **Target total: ≤ 1 300 ms wall clock. Hard fail: 2 500 ms**, logged with a
  per-stage breakdown to the console and to `render.stats`.
- A loading screen was rejected because it advertises a wait. A short black
  with a fade at each end reads as a cut, and the whole point of a town portal
  is that going home is cheap.

### 10.2 The lifecycle

`world.enterZone(zoneId, entryTag, opts)` is **never** called from
`fixedUpdate` (`02-api-contracts.md` §5). `player` sets a pending request; the
engine services it between frames, after `lateUpdate` and before the next
`render`.

| # | Stage | Owner | What |
|---|---|---|---|
| **T1** | Latch | `player` | Queue `{ zoneId, entryTag, runIndex, difficulty }`. Start the fade. Disable control. |
| **T2** | Autosave | `save` | `requestAutosave('zone-transition')`. Coalesced; writes before the teardown so a crash mid-transition loses nothing. |
| **T3** | Teardown | `world` | Dispose every geometry, material reference (`materials.release()`), `InstancedMesh` and light-anchor binding of the outgoing zone. Remove all statics from `physics`. |
| **T4** | Depopulate | `ai`, `items`, `skills`, `fx` | `ai.despawnAll(keepQuestCritical = true)`; `skills` clears projectiles and ground effects; `fx` clears particles, decals and trails; `items` clears ground items (unless retained — §10.4). |
| **T5** | `zone:enter` | `world` | Emit `{ zoneId, seed, entry }`. `sky` applies `descriptor.lightingPreset`; `materials` pre-resolves the palette; `audio` cross-fades the ambience; `ui` swaps the minimap. |
| **T6** | Layout | `world` | Run the pure generator (§3 R1–R10 / §4 B1–B10 / §5 E1–E5). Produces footprints, ground regions, entries, chests, terraces. **Imports nothing from `three`.** |
| **T7** | Geometry | `world` | Merge statics, build instance matrices, upload buffers, resolve materials. The expensive stage. |
| **T8** | Physics | `world` → `physics` | `addStatic()` per footprint in index order, then `physics.rebuild()`. |
| **T9** | Nav | `world` → `nav` | Allocate the `NavGrid`, fill `height[]`, call `nav.rebuild(zone)` → N1–N11 → `nav:rebuilt`. |
| **T10** | Spawn plan | `world` | R11 / §8: `SpawnPoint[]` and `PackDescriptor[]` from the finished grid. |
| **T11** | Player placement | `world` → `player` | `world.entry(entryTag)` → `actors.teleport(player, x, z)` and set `facing`. |
| **T12** | `zone:ready` | `world` | Emit `{ zoneId, bounds, navVersion }`. `ai` spawns the packs; `fx` binds the light anchors; `physics` confirms the static grid. |
| **T13** | Restore | `world` | Retained-zone only (§10.4): re-drop ground items, restore chest `opened` flags, restore per-pack `aliveCount`. |
| **T14** | Prime | engine | One `fixedUpdate` and one full `render` while still black, so the first visible frame has no first-use hitch. |
| **T15** | Fade in | `ui`, `player` | 350 ms fade; `setControlEnabled(true)` at the end. |

The emission order in T5 → T8 → T9 → T12 is the contract from
`02-api-contracts.md` §5 and is not negotiable: *"anything that needs
navigation listens to `zone:ready`, never to `zone:enter`."*

### 10.3 Transition time budget

Ashen Wastes, 900 props, cold (first entry this session):

| stage | ms | note |
|---|---:|---|
| T3 teardown | 42 | 16 prototype disposals, 1 150 static removals, material release |
| T4 depopulate | 18 | up to 100 actors returned to the pool |
| T5 `zone:enter` dispatch | 6 | sky preset swap is a uniform write; PMREM is prewarmed |
| T6 layout | **9** | pure JS, no allocation beyond the layout arrays |
| T7 geometry | **214** | merge 21 400 ridge tris + 900 instance matrices + buffer upload |
| T8 `physics.rebuild()` | 19 | 1 150 footprints into a 2 m uniform grid |
| T9 `nav.rebuild()` | **1.4** | §6.5 |
| T10 spawn plan | 4 | 9–12 packs, ~90 spawn points |
| T11 placement | < 1 | |
| T12 `zone:ready` + `ai.spawnPack` × 12 | 26 | 90 actors + 90 brains out of the pools |
| T13 restore | 0 | cold entry |
| T14 prime frame | 17 | |
| | **≈ 357 ms** | against a **600 ms** black-window budget |

Bonereach is the worst case at **≈ 431 ms** (2 640 footprints, 1 200 props).
Both leave the fade times untouched, so the *observed* transition is 1 300 ms
regardless of the zone (O-142) — the black window is padded to a constant 600 ms so
that the pacing is identical on a fast machine and a slow one, and the slack is
spent, not saved.

**T7 is 60 % of the budget and is the only stage worth optimising.** If it ever
regresses past 400 ms the fix is known and staged: build the instance matrices
into a `SharedArrayBuffer` on a worker during T6 (which is pure and has no GPU
dependency) and upload on the main thread in T7. That is not built now because
357 ms fits, and a worker is a determinism surface.

`0` shader compilations occur during a transition. Every material a zone can
produce is compiled by `world.prewarmMaterials(ctx)` before the first frame
(`ARCHITECTURE.md` § Pre-warm), which for `world` means: all nine group
materials, all four ground palettes, the ridge/berm/silhouette materials and
the portal material, compiled against a bound render target.

### 10.4 What is preserved

| Thing | Zone → zone (exit/descent) | Field ↔ town via portal | Death → respawn |
|---|---|---|---|
| **Ground items** | Destroyed | **Preserved**, re-dropped in T13 with their original `expiresAtStep` still ticking | Preserved in the zone the player died in, if that zone is retained |
| **Corpses** | Destroyed | Destroyed | Destroyed |
| **Chest `opened` flags** | Destroyed with the zone | **Preserved** | Preserved |
| **Cleared packs** | Destroyed | **Preserved** — a pack with `spawned && aliveCount === 0` is not respawned | Preserved |
| **Partially killed packs** | Destroyed | **Preserved at survivor count** — `ai` respawns exactly `aliveCount` members, at the pack's spawn points, in index order | Preserved |
| **The zone layout** | Regenerated with `runIndex + 1` | **Identical** — same `runIndex`, same seed, and the `ZoneInstance` is retained | Identical |
| **`bossDefeated`** | — | Preserved | Preserved |
| **The town portal** | Closed | The portal itself is the mechanism | **Closed** — dying collapses it |
| **Vendor stock, stash** | Owned by `items`, never by `world`; survives everything | | |

**The retention rule.** `01-data-model.md` §9.3 caps live zone instances at
**two — the current one and the town**. So:

- Entering the town through a town portal from a field zone **retains that
  field zone's `ZoneInstance`** (its `nav`, `spawnPoints`, `packs`, `chests`,
  `groundItems`, `cleared`, `bossDefeated`) and **disposes only its Three.js
  scene graph**. GPU memory is freed; game state is not.
- Returning through the portal calls `enterZone(zoneId, 'portal_return', {
  runIndex: <unchanged> })`. `world` sees a retained instance for that exact
  `(zoneId, seed)`, skips T6 entirely, re-runs T7–T9 from the same seed
  (producing bit-identical geometry, footprints and nav flags), and runs T13.
- Taking the *descent* instead — Wastes → Bonereach — disposes the retained
  Wastes instance and closes any open town portal, because the cap is two and
  the town always occupies one.
- The town's own instance is built once at boot and never disposed. At
  14 400 cells and 21 draw calls it costs 115 KB of nav and one geometry set;
  keeping it resident removes the town side of every transition from the
  budget entirely.

Re-running T7–T9 rather than caching the meshes costs **215 ms** and saves
roughly **40 MB of VRAM**. That trade is correct here and it is only available
because the generator is deterministic: *the seed is the cache*.

### 10.5 The town portal

`portal_town` is a consumable (`ItemBase.consumable.effect = 'town_portal'`).
Using it in a field zone:

```
1. items consumes the charge, emits nothing world-facing
2. player calls world.openPortal(px, pz, 'last_bastion', 'town_portal_return')
     → world registers a NEW entry on the CURRENT zone:
         zone.entries.set('portal_return', { x: px, z: pz + 2.2, facing: -π/2 })
     → world registers a portal in the TOWN's retained instance:
         town.portals.push({ id, x: 0, z: -17, toZone: <field>, toEntryTag: 'portal_return', open: true })
     → emits portal:open { from: {x:px,z:pz}, to: {zone:'last_bastion'} }
3. the portal pad at (0, -17) in town lights (light anchor l_portal, §11)
4. world.portalAt(x, z, r) resolves either end; player emits portal:use
```

| Rule | Detail |
|---|---|
| **One at a time** | Opening a second town portal closes the first. `world` tracks exactly one `townPortalId`. |
| **Not in town** | `openPortal` from `last_bastion` is refused; the consumable is not spent. |
| **Not in the Altar** | Refused while `ai.bossActor !== null` and the boss is alive. Once Molgrim is dead the arena's own exit portal serves. |
| **Closed by** | Using the descent/ascent exit, dying, entering a different field zone, or opening another portal. |
| **Survives** | Town visits of any length. The field zone's `ground.expiresAtStep` keeps counting in simulation steps, so a 10-minute town trip does decay the loot on the floor — 600 s is the hard timeout from `01-data-model.md` §5.3. |
| **Placement** | `px, pz = nav.snap(player.x, player.z + 1.5, 3.0)`. If `snap` fails the portal opens on the player's own cell. The return entry is 2.2 m south of the pad so the player never materialises inside it. |

The town-side pad is **fixed geometry at `(0, −17)`** in `INTERACTABLES`, always
present, lit only when a portal is open. That is why the town's map has a portal
pad drawn on it even though the town has no generator: the pad is architecture,
and the portal is the thing that comes and goes.

---

## 11. Lighting anchors

### 11.1 The slot budget

`01-data-model.md` §11.1 fixes the `PointLight` pool at **12 slots, in every
quality preset, in every zone**, owned by `fx`, and states the rule that makes
it non-negotiable: the *visible* point-light count is a shader permutation key,
and changing it cost the source project 640–900 ms hitches
(`ARCHITECTURE.md` § Render integration).

So: **twelve `THREE.PointLight`s exist from boot to shutdown, all with
`visible = true`, always.** They are never added, never removed, never hidden.
A slot that is "off" has `intensity = 0`. `world` does not create lights and
does not call `render.addLight()`; it publishes **anchors** and `fx` binds them.

### 11.2 Allocation per zone

| zone | slots reserved for `world` | slots left for `fx` | anchors declared | binding |
|---|---:|---:|---:|---|
| `last_bastion` | **6** | 6 | 6 | Static 1 : 1. Never rebinds. |
| `ashen_wastes` | **3** | 9 | 38 | 3 nearest to the player |
| `bonereach` | **5** | 7 | 74 | 5 nearest to the player |
| `altar_of_instruction` | **4** | 8 | 4 | Static 1 : 1. Never rebinds. |

`fx`'s share covers fire spells, impact flashes, the Ash Wall, projectile
glows and rare/unique loot glow. Nine slots in the Wastes is the widest margin
because the Wastes is where the Emberwright's fire build is loudest; the town
gets six because the town has no combat and needs the atmosphere instead.

### 11.3 Where `world` places anchors

**`last_bastion` — six, authored** in `LIGHTS` (§2.2): the great brazier, the
forge fire, the gate lantern, the chapel candle, the vault lamp, the portal
pad. Intensity, colour, radius and flicker amplitude are in the table. The
portal pad anchor sits at `intensity = 0` until a town portal is open — which
does not change the *visible* count, only the value.

**`ashen_wastes` — 38, generated (`S5`)**, distributed by archetype:

| archetype | anchors/cell | source |
|---|---:|---|
| `ash_flats` | 1 | a guttering ember vent |
| `dead_grove` | 2 | wisps at the base of two `dead_tree_tall` instances |
| `ruin_field` | 3 | braziers in `ruin_arch` instances |
| `bone_yard` | 2 | phosphor in two `skull_pile` instances |
| `ravine` | 4 | the ravine floor needs its own light or it reads as a hole |
| `warcamp` | 6 | the `pyre` instances, all of them |

Placement is `anchor = propPosition + (0, protoSpec.topY × 0.7, 0)`, with
colour and radius from the prototype's own table and `flicker` phase drawn from
`S5`. Anchors are **attached to props**, never free-floating — a light with no
visible source is the single most common way a procedural zone looks fake.

**`bonereach` — 74, generated (`S5`)**: one `wall_sconce` anchor per 9 m of room
perimeter and per 10 m of corridor, plus two per `stair` ramp. Corridor sconces
are what make a 3 m corridor legible under a camera that shows 18.7 m of depth.

**`altar_of_instruction` — four, fixed**: braziers at radius **15.5 m**, angles
45°, 135°, 225°, 315° — i.e. on the diagonals, between the pillar bearings, so
they rim-light the pillars from behind and never sit inside a ring gap.

### 11.4 Binding and rebinding

`fx` listens to `zone:ready`, reads `world.lightAnchors` (§13 A2), and binds:

```
on zone:ready:
    reserved = ZONE_WORLD_SLOTS[zoneId]              // 6 / 3 / 5 / 4
    if anchors.length <= reserved:
        bind 1:1, set intensity, never rebind again
    else:
        mark slots 0..reserved-1 as DYNAMIC

each update() (presentation only, never fixedUpdate):
    if not DYNAMIC: return
    candidates = anchors sorted by distance to the player          // partial sort, k = reserved
    for each dynamic slot s:
        if s.anchor is still within the top `reserved` + hysteresis: keep
        else: begin a 0.25 s crossfade — intensity → 0, move, intensity → target
```

| Parameter | Value |
|---|---:|
| Rebind hysteresis (Wastes) | **8.0 m** |
| Rebind hysteresis (Bonereach) | **6.0 m** |
| Crossfade | **0.25 s** each way |
| Maximum rebinds per second | **2** (a slot in crossfade is not a rebind candidate) |
| Anchor cull radius | **22 m** — beyond it the slot fades to 0 and parks |

A rebind changes a light's **position and intensity**, never its `visible`
flag and never the slot count. That is the whole trick: 38 apparent lights in
the Wastes, three real ones, and the shader program cache never sees a change.

The k-nearest search is over at most 74 anchors with a partial selection sort
on `k ≤ 5` — under 3 µs, in `update()`, once per frame.

### 11.5 Directional and ambient

Not `world`'s. `sky` owns the single directional "moon", `scene.environment`,
`scene.background` and `scene.fog`, and `world` touches none of them
(`02-api-contracts.md` §3). `world`'s only lighting responsibility beyond
anchors is to set `NAV_FLAG.interior` on roofed cells so that
`sky.setInterior(true, blend)` can dim the sky contribution when the player is
under Bonereach's vaults or the Altar's roof.

---

## 12. Implementation order

Twelve steps. Each is independently verifiable and each has an acceptance check
that fails loudly. Steps 1–4 have no dependency on `nav`, `ai` or `items` and
can land before M1 completes.

| # | Step | Deliverable | Acceptance check |
|---|---|---|---|
| **1** | **Coordinates, descriptors, footprints** | `src/world/data/zones.js` (all four `ZoneDescriptor`s), `src/world/footprint.js` (the §1.7 record + convex distance functions), `src/world/height.js` (terrace field + 2 m lattice + bilinear). No `three`. | `node --test`: 400 random points agree between `groundHeight()` and a brute-force reference to 1e-9; every descriptor validates against the `01-data-model.md` §9.1 shape; `Footprint` distance functions match a reference implementation on 10 000 random queries. |
| **2** | **Nav rasteriser, headless** | `src/nav/raster.js` — passes N1–N10 as pure functions over `(footprints, groundRegions, height)`. | Hand-built fixture: a 20 × 20 m room with one 3 m doorway and one pillar rasterises to exactly the expected `flags` bitmap, committed as `tools/fixtures/nav/unit-room.json`. Region count is 1. Pillar blocks 19 cells ± 1. |
| **3** | **Last Bastion data + build** | `src/world/data/last_bastion.js` (§2.2), `src/world/build/town.js` (merge + instance). | `tools/mapgen.mjs --zone last_bastion --ascii` reproduces the §2.3 map character for character. Walkable cells = fixture ± 0. `regionCount === 1`. I8 passes. |
| **4** | **`world.enterZone` skeleton + the event contract** | `enterZone`, `current`, `descriptor`, `bounds`, `entry`, `surfaceAt`, `groundHeight`, `isTown`, `seedFor`, `setWorldSeed`. Emission order T5 → T8 → T9 → T12. | A test harness subscribes to `zone:enter`, `nav:rebuilt`, `zone:ready` and asserts the order and that `navVersion` is identical in the last two. Entering the town twice yields byte-identical `NavGrid.flags` (FNV-1a hash compare). |
| **5** | **Ridgewalk layout, pure** | `src/world/gen/ridgewalk.js` — R1–R7 and R10, no dressing, no `three`. | 200 seeds: every spine connects entry row to exit row; `\|connected\| ∈ [9, 14]` on 100 %; L-path fallback < 0.1 %; two runs of the same seed produce identical cell arrays. |
| **6** | **Ashen Wastes geometry + dressing** | R8, R9, `src/world/build/wastes.js`, the G1–G5 and G9 prototypes. | `node tools/capture.mjs wastes_overview` produces a frame. Draw calls ≤ 27, triangles ≤ 320 000 per `render.stats`. Prop count within 5 % of `propBudget`. |
| **7** | **`tools/mapgen.mjs` and invariants I1, I2, I3, I8, I9** | The sweep runner, the PNG region writer, the ASCII dumper, the `cause:` instrumentation, the timing report. | 200 seeds × 3 `runIndex` on the Wastes: 600/600 on I1, I2, I3, I8, I9. Nav-build p95 reported and under the §6.5 budget. Eleven fixture hashes recorded. |
| **8** | **Spawning** | `src/world/gen/spawn.js` — §8 in full, `SpawnPoint[]`, `PackDescriptor[]`, `world.spawnPoints`, `world.packs`. | I4 passes on 600/600 layouts with the achieved density inside ±2 % (not merely ±20 %). Exactly one `unique` per layout on 600/600. Every dead-end tip holds a champion or the unique. |
| **9** | **Bonereach** | `src/world/gen/bsp.js` (B1–B10), `src/world/build/bonereach.js`, G6–G7 prototypes. | 600 layouts: `\|rooms\| === targetRooms ∈ [12, 18]` on 100 %; `regionCount === 1` on 100 %; every corridor ≥ 3.0 m wide at its narrowest nav cross-section; I1–I4, I6, I8 pass. |
| **10** | **Altar of Instruction** | `src/world/gen/arena.js`, `src/world/build/altar.js`, the fixed anchor tables (8 summon, 12 teleport, 6 pillar bisectors). | I5 and I7 pass on 600/600. A scripted check walks a 4.2 m/s agent from `r = 3.0` opposite the gap to the gap on all six bisectors and arrives with ≥ 1.5 s of margin every time. |
| **11** | **Transitions, retention, town portal** | T1–T15, the retained-instance path, `openPortal` / `closePortal` / `portalAt`, T13 restore. | `tools/playtest.mjs`: town → wastes → portal to town → return → descent → altar, ten times. Ground items and chest flags survive the portal round trip; a cleared pack does not respawn; total transition wall clock ≤ 1 300 ms on every leg (O-142), black window ≤ 600 ms. |
| **12** | **Lighting anchors and the prewarm** | `world.lightAnchors`, `world.prewarmMaterials`, the `fx` binding path of §11.4. | `render.stats.programs` is **unchanged** across a full 90 s traverse of the Wastes with the Emberwright casting continuously — the definitive proof that the visible light count never moved. Zero shader compilations after boot, asserted by `tools/profile.mjs`. |

Steps **1–4** are the critical path; nothing else in `world` can be tested
before `enterZone` emits in the right order. Steps **5–6** and **9–10** are
independent of each other and parallelise cleanly across agents, provided each
owns only its own `gen/` and `build/` files. Step **7** should land as early as
possible — it is the harness that keeps 8–10 honest, and building it after the
generators means debugging two things at once.

---

## 13. Additions folded into `02-api-contracts.md`

> **Status: applied.** A1–A6 are in `02-api-contracts.md` §§5, 9 and 4 —
> `world.staticFootprints`, `world.lightAnchors` with its `LightAnchor` record,
> the `seconds <= 0` persistence rule on `fx.requestLight`, `world.entry`'s
> facing, `world.debugStage`, and the `Footprint` record beside `Hit` and
> `MoveResult`. Kept as rationale, not as a request.

Six additions. Each is required by a specific mechanism above, and each is
scoped as narrowly as possible.

### A1 — `world.staticFootprints`

| Method | Signature | Returns | Fixed | Alloc |
|---|---|---|---|---|
| `staticFootprints` | property → `readonly Footprint[]` | array | Y | no |

**Why.** `nav.rebuild(zone)` must rasterise the zone's colliders (§6.1). Its
only alternatives are to query `physics` 36 864 times (there is no such query,
and adding one would be slower and vaguer), or to have `world` rasterise —
which contradicts `02-api-contracts.md` §6's own description of `nav`. Handing
`nav` the footprint list is the smallest possible surface, and it is what lets
`tools/mapgen.mjs` rasterise headlessly with no `physics` instance at all.

**Constraints.** The array is frozen after `zone:ready` and is invalidated by
the next `enterZone`. Callers other than `nav` and the harness must not read it.

### A2 — `world.lightAnchors`

| Method | Signature | Returns | Fixed | Alloc |
|---|---|---|---|---|
| `lightAnchors` | property → `readonly LightAnchor[]` | array | Y | no |

```js
const LightAnchor = {
  id: 0, x: 0, y: 0, z: 0,
  colour: [1, 0.55, 0.22],   // linear RGB
  intensity: 9.0,            // the value when fully bound
  radius: 14.0,              // metres, cull radius
  flicker: 0.30,             // 0..1 amplitude; fx owns the waveform
  reserved: true,            // true → this zone binds statically, never rebinds
};
```

**Why.** §11 needs `fx` to bind slots to world geometry. The alternative —
`world` calling `fx.requestLight()` — inverts the dependency (`world` inits
before `fx`), breaks the headless harness (`fx` does not exist there), and puts
a presentation call inside zone generation. `fx` already listens to
`zone:ready`, so pulling anchors on that event costs nothing and keeps `world`
free of any `fx` reference.

### A3 — persistent lights in `fx.requestLight`

`fx.requestLight(x, y, z, colour, intensity, radius, seconds)` — specify that
**`seconds <= 0` means the light persists until `releaseLight(slot)`**, and
that a persistent slot is exempt from oldest-first recycling.

**Why.** Every `world` anchor is persistent for the lifetime of the zone. The
current signature has no way to express that except by passing a large number,
which would be a lie that eventually expires mid-session.

### A4 — `world.entry` returns facing

| Method | Signature (changed) |
|---|---|
| `entry` | `(entryTag:string, out?:{x,y,z,facing}) => {x,y,z,facing}` |

**Why.** `ZoneInstance.entries` already stores `{ x, z, facing }`
(`01-data-model.md` §9.2) but `world.entry()` returns a bare `Vec3`, so the
facing is unreachable. Every arrival in this document depends on it: the player
must face north on entering the Wastes from town and south on returning. When
`out` lacks a `facing` field the method behaves exactly as before, so this is
backward-compatible.

### A5 — `world.debugStage`

| Method | Signature | Returns | Fixed | Alloc |
|---|---|---|---|---|
| `debugStage` | `(name:'town'\|'wastes_cell'\|'wastes_ravine'\|'bonereach_hall'\|'bonereach_corridor'\|'altar') => void` | — | N | pool |

**Why.** `ai` and `ui` already have `debugStage` for deterministic captures.
`world` needs the same so `tools/baseline.mjs` can pin a named shot per zone
kind — the pixel gate is what catches an unintended geometry change, and
without a staged camera position per zone there is nothing stable to diff.
Matches the existing convention exactly.

### A6 — define `Footprint` in `physics`

`physics.addStatic(footprint:Footprint, surface, opts)` names a type that no
document defines. §1.7 above gives the shape `world` emits; it should be
recorded in `02-api-contracts.md` §4 alongside `Hit` and `MoveResult` so that
`physics` and `world` cannot drift.

---

### Not requested, and why

Four things this specification needs that turned out **not** to require an API
change, recorded so the question is not reopened:

- **`ai` writing `PackDescriptor.members` / `spawned` / `aliveCount`.**
  `01-data-model.md` §9.5 already documents `members` as *"filled at spawn"*.
  The record is `world`'s; the write is sanctioned by the data model.
- **Dynamic blockers.** `skills.markHazard()` already exists and is already the
  sole writer of `NAV_FLAG.hazard`. Everything else dynamic is a physics body
  (§6.6). No nav mutation API is needed.
- **Zone retention across a town portal.** `enterZone(zoneId, entryTag, {
  runIndex })` carries enough for `world` to recognise a retained instance by
  `(zoneId, seed)` internally. No new parameter, no new method.
- **Chest contents.** `world.openChest(chestId)` plus
  `world.current.chests[i].treasureClass` and its `S4` sub-seed give `items`
  everything it needs through the existing surface.

