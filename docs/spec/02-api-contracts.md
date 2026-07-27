# 02 — API Contracts

**Claudo II: Lord of Instruction** — the public surface of all 16 subsystems.

`ARCHITECTURE.md` rule 2 is absolute: **never import another subsystem's
module.** Everything below is reached at runtime through `ctx.get(id)` or
`ctx.peek(id)`. `static deps` declares *initialisation order only* — it is not
an import and it is not a licence to reach into internals.

This document is the contract. A method that is not listed here is private,
regardless of whether the language can reach it. Adding a public method means
adding a row here in the same commit.

---

## Reading the tables

Every subsystem section carries the same four parts: a header block in the
style of `src/ui/index.js`, an API table, an event table, and a forbidden list.

| Column | Meaning |
|---|---|
| **Fixed** | `Y` — safe to call from `fixedUpdate`. `N` — must not be: it touches DOM, GPU state, `performance.now()`, or allocates unboundedly. `—` — `init()`/`dispose()` only. |
| **Alloc** | `no` — allocates nothing. `pool` — draws from a preallocated pool and must be released. `yes` — allocates; legal only in `init()`, on zone load, or on a user action behind a fade. |

Types are written in JSDoc shorthand. `Vec3` means a plain
`{ x, y, z }` object of numbers, never a `THREE.Vector3`, at any boundary
between subsystems — gameplay data must be readable by the Node harness, which
has no `three`.

**`out` parameters.** Any method that would return a fresh object instead takes
an optional `out` object as its last parameter, writes into it and returns it.
When `out` is omitted the method returns a **shared scratch object owned by the
callee, valid until the next call to that method.** Copy it or pass an `out`;
never store it.

---

## Init order

Resolved by `Registry.resolve()` from `static deps`:

```
render → materials → sky → physics → world → nav → actors → combat
       → fx → skills → items → ai → player → ui → audio → save
```

`audio` and `physics` have no dependencies and may float earlier; the topological
sort is the authority, not this line.

---

## What the core owes the subsystems

`src/core/` is lead-owned and outside this document's ownership, but three of
its properties are load-bearing for the contracts below. They are recorded in
`ARCHITECTURE.md` and restated here because a subsystem that assumes them and
finds them missing fails silently.

| # | Requirement | Depended on by |
|---:|---|---|
| C-1 | **`ctx.time.step`** — the monotonic simulation step index, incremented immediately before the first `fixedUpdate` of a step. Every scheduled field in `01-data-model.md` is written against it, and `ctx.time.frame` is not the same number | `actors`, `combat`, `skills`, `ai`, `items` — all of them |
| C-2 | `PHYSICS_HZ = 60`, `FIXED_DT = 1/60`, `MAX_SUBSTEPS = 6`, `rawDt` clamped to `0.10 s` | the spiral guard; six substeps is exactly the clamp |
| C-3 | The engine services a pending `world.requestZone()` **between `lateUpdate` and `render`** | `world`, `player` |
| C-4 | `EventBus.emit` allocates nothing — a generation-guarded index walk, not a copied handler set | every subsystem, at `actor:damage` rates |

---

## Consolidation note

Seven specifications (`04`, `05`, `06`, `07`, `09`, `11`, `13`) were written
against an earlier version of this document and each ended with a section
listing the methods and events it needed and could not find. Those sections have
been folded in: every method they requested now appears in the subsystem table
that owns it, every event in that subsystem's event row, and `ARCHITECTURE.md`'s
event table carries the ones it was missing. The requesting sections remain in
their documents as the rationale — each explains *why* the method has to exist
and what the alternative would have cost — but they are records, not open
requests. Where two documents asked for the same method under different names,
the name in this table is the one that ships.

---

## 1. `render`

```
/**
 * ===========================================================================
 * RENDER — WebGL2 device, HDR pipeline, shadows, post-processing, composite
 * ===========================================================================
 *
 * Owns the one WebGLRenderer and the only place that calls renderer.render().
 * Everything else contributes objects to ctx.scene / ctx.uiScene and lights
 * through addLight(). The frame is composited in render(ctx), called by the
 * engine after every lateUpdate.
 *
 * Pipeline: depth/normal prepass → shadow cascades → opaque HDR → sky →
 * transparent → GTAO → bloom → AgX tonemap + procedural grade LUT → SMAA →
 * uiScene with a cleared depth buffer.
 *
 * PUBLIC API — const r = ctx.get('render')
 * ...
 */
export class RenderSystem { static id = 'render'; static deps = []; }
```

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `renderer` | property — returns ``THREE.WebGLRenderer``| N | no |
| `screenSize` | property — returns ``{ width:int, height:int }` — internal RT size`| N | no |
| `depthTexture` | property — returns ``THREE.DepthTexture` — linear depth for soft particles`| N | no |
| `frameIndex` | property — returns ``int` — frames composited since boot`| Y | no |
| `registerPass` | `(pass:PostPass, order:int) => int` — returns `handle`| — | yes |
| `unregisterPass` | `(handle:int) => void`| — | no |
| `addLight` | `(light:THREE.Light, opts?:{ cullRadius:number, ballast:boolean }) => LightHandle` — returns `handle`| N | yes |
| `removeLight` | `(handle:LightHandle) => void`| N | no |
| `requestEnvMap` | `() => THREE.Texture` — the PMREM env map in use | N | no |
| `setExposure` | `(ev:number) => void` — EV, −4..+4 | N | no |
| `setQuality` | `(preset:'low'\|'medium'\|'high'\|'ultra') => Promise<void>` — returns `promise`| N | yes |
| `screenImpulse` | `(strength:number, dirX:number, dirY:number) => void` — 0..1 damage punch | N | no |
| `setColourGrade` | `(gradeId:string, blend:number) => void` — per-zone LUT | N | no |
| `worldToScreen` | `(x,y,z:number, out?:{x,y,visible}) => {x:number,y:number,visible:boolean}` — returns `out`| N | no |
| `stats` | property → `{ drawCalls, triangles, programs, gpuMs, cpuMs }` | N | no |
| `prewarmMaterials` | `(ctx) => Promise<void>` — returns `promise`| — | yes |

| Direction | Events |
|---|---|
| Emits | `resize` (re-emitted with the internal RT size), `render:quality`, `render:context-lost` `{}`, `render:context-restored` `{}` |
| Listens | — |

`render` owns the canvas listeners, so it is the only subsystem that can know
the context died. `materials`, `sky`, `world`, `actors`, `fx`, `items` and `ui`
all hold GPU resources that are dead the moment `render:context-lost` fires, and
the engine sets `time.scale = 0` on it. The alternative — seven subsystems
polling `renderer.getContext().isContextLost()` every frame — is both wasteful
and racy.

**Owns exclusively:** `THREE.WebGLRenderer`, all render targets, the post-process
chain, shadow cascades, tone mapping, `outputColorSpace`, the light-slot budget.

**Forbidden for callers:**
- Never call `renderer.render()`, `setRenderTarget()`, `clear()`, `setViewport()`
  or mutate `renderer.state` outside `render`'s own frame.
- Never add a `THREE.Light` directly to `ctx.scene` — it bypasses culling and
  the slot budget, and it recompiles every lit material. Use `addLight`.
- Never set `visible = false` on a registered light. Drive `intensity` to 0.
  The **visible** point-light count is a shader permutation key; changing it
  cost the source project 640–900 ms hitches.
- Never read `screenSize` in `fixedUpdate` — the simulation must not depend on
  resolution.

---

## 2. `materials`

```
/**
 * ===========================================================================
 * MATERIALS — procedural PBR texture forge and the shared material library
 * ===========================================================================
 *
 * Every texture in the game is generated here on the GPU at load time: value
 * and gradient noise, Worley, periodic tiling variants, Sobel height→normal,
 * curvature-driven edge wear, grime in crevices. Nothing is fetched.
 *
 * Materials are shared and reference-counted. Two callers asking for
 * 'stone_wall' at the same tier get the same THREE.Material instance.
 *
 * PUBLIC API — const mat = ctx.get('materials')
 * ...
 */
export class MaterialsSystem { static id = 'materials'; static deps = ['render']; }
```

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `get` | `(key:string, opts?:MaterialOpts) => THREE.Material` — ref-counted | N | yes (first call) |
| `release` | `(key:string) => void` — decrements the refcount | N | no |
| `texture` | `(key:string, size:int) => THREE.Texture` | N | yes (first call) |
| `makeSurface` | `(surface:SurfaceType, seed:uint32, opts?) => MaterialSet` | N | yes |
| `variant` | `(baseKey:string, tint:[r,g,b], roughDelta:number) => THREE.Material` | N | yes |
| `atlas` | `(name:string) => { texture, uvFor(id) }` — icon/decal atlases | N | no |
| `noiseTexture` | `(kind:'value'\|'gradient'\|'worley'\|'blue', size:int, seed:uint32) => THREE.Texture` | N | yes |
| `heightToNormal` | `(heightTex:THREE.Texture, strength:number) => THREE.Texture` | N | yes |
| `paletteFor` | `(zoneId:string) => Palette` — the zone's surface colour set | Y | no |
| `rarityColour` | `(rarity:string, out?:{r,g,b}) => {r,g,b}` — the sacred colours | Y | no |
| `keys` | property → `string[]` of every producible key | — | no |
| `prewarmMaterials` | `(ctx) => Promise<void>` | — | yes |

| Direction | Events |
|---|---|
| Emits | — |
| Listens | `zone:enter` (to pre-resolve the zone's palette) |

**Owns exclusively:** every `THREE.Texture` and shared `THREE.Material` in the
game, the texture-forge render targets, the icon and decal atlases, the surface
palette tables.

**Forbidden for callers:**
- Never `dispose()` a material obtained from `get()`. Call `release()`.
- Never mutate a shared material's `color`, `roughness`, `map` or defines —
  another subsystem is using the same instance. Ask for a `variant()`.
- Never create a `THREE.Texture` from a canvas outside `materials`; the only
  exception is `items`' item-icon `OffscreenCanvas`, which `items` owns and
  registers through `materials.atlas('items')`.
- Never call `get()` inside `update()` or `fixedUpdate()` — the first call
  compiles.

---

## 3. `sky`

```
/**
 * ===========================================================================
 * SKY — atmosphere, celestial bodies, per-zone lighting mood, IBL, fog
 * ===========================================================================
 *
 * Analytic atmospheric scattering into a cube target, PMREM-filtered for
 * image-based lighting, plus the one directional light ("moon") and the
 * exponential height fog. Time of day is FIXED per zone by preset — it is
 * never animated, because a moving sun rebuilds the PMREM chain and moves the
 * shadow cascades, and this game has no day cycle.
 *
 * PUBLIC API — const sky = ctx.get('sky')
 * ...
 */
export class SkySystem { static id = 'sky'; static deps = ['render','materials']; }
```

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `applyPreset` | `(presetId:string, blendSeconds:number) => void`| N | no |
| `preset` | property → `string` — the active preset id | Y | no |
| `sunDirection` | `(out?:Vec3) => Vec3` — unit vector toward the light | Y | no |
| `sunColour` | `(out?:{r,g,b}) => {r,g,b}` | N | no |
| `ambientLevel` | `() => number` — 0..1, used by `ai` for perception | Y | no |
| `setFog` | `(density:number, heightFalloff:number, colour:[r,g,b]) => void` | N | no |
| `fogAt` | `(x,z:number) => number` — 0..1 fog factor, for minimap dimming | N | no |
| `envMap` | property → `THREE.Texture` — current PMREM | N | no |
| `setInterior` | `(inside:boolean, blend:number) => void` — Bonereach roof dimming | N | no |
| `presets` | property → `string[]` | — | no |
| `prewarmMaterials` | `(ctx) => Promise<void>` | — | yes |

Shipping presets: `bastion_night`, `wastes_dusk`, `bonereach_interior`,
`altar_ember`, `menu_void`.

| Direction | Events |
|---|---|
| Emits | `sky:preset` `{ presetId }` |
| Listens | `zone:enter` (applies `descriptor.lightingPreset`), `resize` |

**Owns exclusively:** the sky dome, the directional light, `scene.fog`, the
PMREM env map, `scene.environment`, `scene.background`.

**Forbidden for callers:**
- Never write `ctx.scene.fog`, `.background` or `.environment`.
- Never add a second directional light. Punctual lights go through
  `render.addLight`.
- Never animate a preset from `fixedUpdate` — lighting is presentation.

---

## 4. `physics`

```
/**
 * ===========================================================================
 * PHYSICS — 2.5D broadphase, casts, actor push-out, projectile sweeps
 * ===========================================================================
 *
 * There is no 3D rigid-body solver here and there will not be one. The camera
 * is fixed and the game is played on a plane: actors are circles on the XZ
 * plane with a height interval, static geometry is a set of convex footprints,
 * and the whole thing lives in a uniform grid of 2 m cells. Everything is
 * O(actors in a cell), deterministic, and runs headless in Node.
 *
 * Stepped from fixedUpdate at 60 Hz. All queries are allocation-free.
 *
 * PUBLIC API — const phys = ctx.get('physics')
 * ...
 */
export class PhysicsSystem { static id = 'physics'; static deps = []; }
```

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `addStatic` | `(footprint:Footprint, surface:SurfaceType, opts?) => int handle` | Y | yes |
| `addStaticGroup` | `(object3D:THREE.Object3D, surface:SurfaceType) => int[]` | N | yes |
| `removeStatic` | `(handle:int) => void` | Y | no |
| `rebuild` | `() => void` — rehash the static grid; call once per zone | N | yes |
| `addBody` | `(actorId:int, x,z,radius,height,mass:number, layer:int) => int` | Y | no |
| `removeBody` | `(bodyId:int) => void` | Y | no |
| `setBody` | `(bodyId:int, x,z:number) => void` | Y | no |
| `moveBody` | `(bodyId:int, dx,dz:number, out?:MoveResult) => MoveResult` — slide + step | Y | no |
| `circleCast` | `(x,z,dx,dz,radius,maxDist:number, mask:int, out?:Hit) => Hit` | Y | no |
| `rayCast` | `(x,z,dx,dz,maxDist:number, mask:int, out?:Hit) => Hit` | Y | no |
| `lineOfSight` | `(ax,az,bx,bz:number, mask:int) => boolean` | Y | no |
| `overlapCircle` | `(x,z,radius:number, mask:int, out:int[]) => int count` — fills `out` with actor ids | Y | no |
| `overlapCone` | `(x,z,facing,halfAngle,radius:number, mask:int, out:int[]) => int` | Y | no |
| `overlapRect` | `(x,z,halfW,halfL,facing:number, mask:int, out:int[]) => int` | Y | no |
| `nearest` | `(x,z,radius:number, mask:int, excludeId:int) => int actorId \| 0` | Y | no |
| `groundHeight` | `(x,z:number) => number` — metres, `-Infinity` off-map | Y | no |
| `separate` | `(iterations:int) => void` — one crowd push-out pass over all bodies | Y | no |
| `sweepProjectile` | `(x,z,dx,dz,radius:number, mask:int, excludeId:int, out?:Hit) => Hit` | Y | no |
| `setBodyFlags` | `(bodyId:int, flags:int) => void` — `noCollide`, `flying` | Y | no |
| `LAYER` / `MASK` | frozen constant objects | Y | no |
| `stats` | property → `{ statics, bodies, cells, casts, separationMs }` | Y | no |
| `setDebugDraw` | `(on:boolean) => void` | N | yes |

```js
const Hit = {
  hit: false, x: 0, z: 0, nx: 0, nz: 0,     // point and normal, XZ plane
  distance: 0, fraction: 0,
  surface: 'stone', actorId: 0, staticHandle: 0,
};
const MoveResult = { x: 0, z: 0, blocked: false, slid: false, hitStatic: 0, hitActorId: 0 };
export const LAYER = { STATIC:1, PLAYER:2, MONSTER:4, NEUTRAL:8, PROJECTILE:16, TRIGGER:32 };
export const MASK   = { WORLD:1, ACTORS:14, HOSTILE_TO_PLAYER:4, HOSTILE_TO_MONSTER:2, SIGHT:1 };

/** The convex footprint `world` emits and `physics` and `nav` both consume.
 *  Recorded here so the two cannot drift (07-world-gen.md §1.7, §13 A6). */
const Footprint = {
  kind:   'box',       // 'box' | 'cylinder' | 'poly'
  x: 0, z: 0,          // centre on the XZ plane
  y: 0,                // floor height of the interval
  height: 3.0,         // metres; the interval is [y, y + height)
  halfW: 1.0,          // 'box': half-extents before rotation
  halfL: 1.0,
  radius: 0,           // 'cylinder' only
  points: null,        // 'poly' only: [x0,z0, x1,z1, …] CCW, convex, ≤ 8 points
  facing: 0,           // radians, 'box' and 'poly'
  blocksNav: true,     // false → physics collides, nav ignores (low rubble)
  blocksSight: true,   // false → physics collides, lineOfSight passes (rails)
};
```

`Hit` and `MoveResult` records come from a **32-deep ring**. Read or copy them
immediately; never stash one.

| Direction | Events |
|---|---|
| Emits | — |
| Listens | `zone:ready` (rebuilds the static grid) |

**Owns exclusively:** the static footprint set, the uniform grid, every body
record, the separation pass, all cast implementations.

**Forbidden for callers:**
- Never move an actor by writing `actor.x` / `actor.z` directly. Go through
  `actors.moveTo()`, which calls `physics.moveBody()`. Direct writes desync the
  body from the actor and actors fall through walls.
- Never call `separate()` — `actors` calls it exactly once per fixed step, in a
  fixed position in the step order.
- Never keep a `Hit` past the current call.
- Never call `addStatic` after `zone:ready` without a matching `rebuild()`.

---

## 5. `world`

```
/**
 * ===========================================================================
 * WORLD — zone generation, the hand-authored town, tile kit, props, portals
 * ===========================================================================
 *
 * Two authorities in one subsystem: Last Bastion is a fixed 60x60 m layout
 * placed by hand, and the three combat zones are generated from
 * seed = hash(worldSeed, zoneId, runIndex). The generator's guarantees
 * (entry→exit connectivity, boss reachability, density within +/-20 %, no
 * sealed loot pockets) are asserted by tools/mapgen.mjs over 200 seeds, and
 * a generator change that breaks one of them does not ship.
 *
 * world does not spawn monsters. It produces SpawnPoints and PackDescriptors;
 * `ai` decides what stands on them.
 *
 * PUBLIC API — const world = ctx.get('world')
 * ...
 */
export class WorldSystem { static id = 'world'; static deps = ['materials','physics']; }
```

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `enterZone` | `(zoneId:string, entryTag:string, opts?:{ runIndex:int, difficulty:string }) => Promise<ZoneInstance>` | N | yes |
| `current` | property → `ZoneInstance \| null` | Y | no |
| `descriptor` | `(zoneId:string) => ZoneDescriptor` | Y | no |
| `descriptors` | property → `ZoneDescriptor[]` — all four | Y | no |
| `bounds` | `(out?:{minX,minZ,maxX,maxZ}) => Bounds` | Y | no |
| `groundHeight` | `(x,z:number) => number` — analytic; `physics` is exact | Y | no |
| `surfaceAt` | `(x,z:number) => SurfaceType` | Y | no |
| `entry` | `(entryTag:string, out?:{x,y,z,facing}) => {x,y,z,facing}` — when `out` has no `facing` field the method behaves exactly as the old `Vec3` form | Y | no |
| `spawnPoints` | property → `SpawnPoint[]` | Y | no |
| `packs` | property → `PackDescriptor[]` | Y | no |
| `requestZone` | `(zoneId:string, entryTag:string, opts?:{ runIndex:int, difficulty:string }) => boolean` — latches a pending zone change; `false` when one is already pending. The engine services it after `lateUpdate` and before `render` | **Y** | no |
| `staticFootprints` | property → `readonly Footprint[]` — frozen at `zone:ready`, invalidated by the next `enterZone` | Y | no |
| `lightAnchors` | property → `readonly LightAnchor[]` | Y | no |
| `setExitSealed` | `(zoneId:string, exitTag:string, sealed:boolean) => void` — flips one `Interactable` between its transition and its sealed prompt | **Y** | no |
| `debugStage` | `(name:'town'\|'wastes_cell'\|'wastes_ravine'\|'bonereach_hall'\|'bonereach_corridor'\|'altar') => void` | N | pool |
| `openPortal` | `(fromX,fromZ:number, toZone:string, toEntryTag:string) => int portalId` | Y | no |
| `closePortal` | `(portalId:int) => void` | Y | no |
| `portalAt` | `(x,z,radius:number) => int portalId \| 0` | Y | no |
| `interactableAt` | `(x,z,radius:number) => Interactable \| null` — NPC, chest, stash, waypoint | Y | no |
| `npcs` | property → `NpcDescriptor[]` — town only | Y | no |
| `openChest` | `(chestId:int) => boolean` — returns false if already open | Y | no |
| `isTown` | property → `boolean` | Y | no |
| `seedFor` | `(zoneId:string, runIndex:int) => uint32` — `hash(worldSeed, zoneId, runIndex)` | Y | no |
| `setWorldSeed` | `(seed:uint32) => void` — from the save, before the first `enterZone` | — | no |
| `prewarmMaterials` | `(ctx) => Promise<void>` | — | yes |

```js
/** Static light positions a zone hands to `fx` on `zone:ready`. `world` never
 *  calls into `fx` — the dependency only runs one way (07 §13 A2). */
const LightAnchor = {
  id: 0, x: 0, y: 0, z: 0,
  colour: [1, 0.55, 0.22],   // linear RGB
  intensity: 9.0,            // the value when fully bound
  radius: 14.0,              // metres, cull radius
  flicker: 0.30,             // 0..1 amplitude; `fx` owns the waveform
  reserved: true,            // true → bound statically for the zone's life
};
```

| Direction | Events |
|---|---|
| Emits | `zone:teardown` `{ zoneId }`, `zone:enter` `{ zoneId, seed, entry }`, `zone:ready` `{ zoneId, bounds, navVersion }`, `portal:open` / `portal:use` `{ from, to, point }` |
| Listens | `actor:death` (to open the boss exit portal when `flags & boss`), `quest:update` |

**Emission order on a zone change is contractual:**
`zone:teardown` → **the old zone's population is cleared** → `zone:enter` →
world geometry built → `physics.rebuild()` → `nav.rebuild()` → `zone:ready`.
Anything that needs navigation listens to `zone:ready`, never to `zone:enter`.

`zone:teardown` is what `ai`, `items`, `skills` and `fx` depopulate on. They may
not use `zone:ready` for it: that fires nine stages later, after the new zone's
packs have been planned, and would clear them.

**Owns exclusively:** all static level geometry and its colliders, the tile kit,
props, the town layout, chests, portals, `ZoneInstance` and `ZoneDescriptor`,
and the zone RNG stream.

**Forbidden for callers:**
- Never call `enterZone()` from `fixedUpdate` — it disposes geometry and
  allocates a new nav grid. `player` queues the request and `world` services it
  between frames.
- Never add a mesh to `ctx.scene` at world scale. Props are instanced and
  budgeted; an un-instanced tree breaks the 150-draw-call budget.
- Never read `world.current.nav` — read `nav`. `world` builds it and hands it
  over; `nav` owns it afterwards.
- Never spawn an actor. Emit nothing on `world`'s behalf.

---

## 6. `nav`

```
/**
 * ===========================================================================
 * NAV — walkability grid, A*, path smoothing, flow fields, crowd separation
 * ===========================================================================
 *
 * A 0.5 m grid rebuilt from the static colliders immediately after generation
 * and versioned, so `ai` can detect a stale path in O(1). Two movement modes:
 * a shared flow field toward the player (the default, O(1) per agent) and
 * rationed A* for agents that need a real path (fleeing, repositioning,
 * a target that is not the player). The A* budget is a ring queue, never a
 * spike.
 *
 * PUBLIC API — const nav = ctx.get('nav')
 * ...
 */
export class NavSystem { static id = 'nav'; static deps = ['world']; }
```

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `grid` | property → `NavGrid` (read-only) | Y | no |
| `version` | property → `int` — tracks the **grid** | Y | no |
| `flowVersion` | property → `int` — tracks the **flow field**; increments on every `buildFlowField()`. The two change on completely different cadences and neither can stand in for the other | Y | no |
| `rebuild` | `(zone:ZoneInstance) => void` — called by `world` only, with `world.staticFootprints` as its source | N | yes |
| `walkable` | `(x,z:number) => boolean` | Y | no |
| `flagsAt` | `(x,z:number) => int` — `NAV_FLAG` bitfield | Y | no |
| `regionAt` | `(x,z:number) => int` — `-1` when blocked | Y | no |
| `connected` | `(ax,az,bx,bz:number) => boolean` — same region | Y | no |
| `snap` | `(x,z:number, maxRadius:number, out?:Vec3) => Vec3 \| null` — nearest walkable point, **`null` when nothing walkable lies within `maxRadius`**. Three flows branch on that: a move order to a blocked destination, loot scatter placement and town-portal placement | Y | no |
| `requestPath` | `(fromX,fromZ,toX,toZ:number, ownerId:int) => int requestId \| 0` — 0 = budget full | Y | pool |
| `pollPath` | `(requestId:int) => PathHandle \| null` — null while pending | Y | no |
| `cancelPath` | `(requestId:int) => void` | Y | no |
| `releasePath` | `(path:PathHandle) => void` | Y | no |
| `pathNode` | `(path:PathHandle, i:int, out?:Vec3) => Vec3` | Y | no |
| `pathLength` | `(path:PathHandle) => int` — node count | Y | no |
| `buildFlowField` | `(targetX,targetZ:number) => void` — one per fixed step, at most | Y | no |
| `flowAt` | `(x,z:number, out?:{dx,dz}) => {dx,dz}` — unit direction, `{0,0}` if unreachable | Y | no |
| `flowDistance` | `(x,z:number) => number` — metres along the field, `Infinity` if unreachable | Y | no |
| `raycastNav` | `(ax,az,bx,bz:number) => boolean` — grid-space line of walk | Y | no |
| `smooth` | `(path:PathHandle) => void` — string-pull in place | Y | no |
| `randomPoint` | `(rng:Rng, regionId:int, out?:Vec3) => Vec3` | Y | no |
| `markHazard` | `(x,z,radius:number, on:boolean) => void` — the only writer of `NAV_FLAG.hazard` | Y | no |
| `setBudget` | `(pathsPerStep:int) => void` — default 4 | Y | no |
| `stats` | property → `{ pending, solvedThisSecond, avgNodes, fieldMs, refusals }` | Y | no |
| `debugTexture` | `() => THREE.DataTexture` — for the minimap | N | yes |

`requestPath` is asynchronous **within the fixed step budget**: it returns a
request id immediately and `pollPath` returns the result on a later step
(typically 1–3 steps). The budget is `pathsPerStep = 4` at 60 Hz = 240 solves
per second, which the plan's ring-queue rule requires.

| Direction | Events |
|---|---|
| Emits | `nav:rebuilt` `{ zoneId, navVersion, regionCount }` |
| Listens | `zone:ready` |

**Owns exclusively:** `NavGrid` after `world` hands it over, all path memory,
the flow field, the A* open/closed arenas, `NAV_FLAG`.

**Forbidden for callers:**
- Never write to `nav.grid.flags` or `.cost` directly. Hazards are registered
  through `nav.markHazard()`, and `skills` is its only caller.
- Never hold a `PathHandle` across a `version` change. Compare
  `brain.pathVersion !== nav.version` and repath.
- Never call `buildFlowField` — `ai` calls it exactly once per fixed step.
- Never call `requestPath` in a loop over all monsters; that is what the budget
  and the flow field exist to prevent.

---

## 7. `actors`

```
/**
 * ===========================================================================
 * ACTORS — the actor record, procedural skeletons and animation, stat blocks,
 *          status effects, the health and resource vessels
 * ===========================================================================
 *
 * The single owner of the Actor pool (01-data-model.md §2). Everything that
 * exists in the world as a thing with life — the player, every monster, every
 * NPC, every summon, every breakable urn — is an Actor from this pool.
 *
 * Also the only writer of actor.x/z: movement requests go through moveTo(),
 * which drives physics.moveBody() and keeps the body and the record in step.
 *
 * Skeletons are built in code (no clips, no imported rigs) and animated
 * procedurally: IK footfall, spring overlays, additive pose mixing.
 *
 * PUBLIC API — const actors = ctx.get('actors')
 * ...
 */
export class ActorsSystem { static id = 'actors'; static deps = ['materials','physics']; }
```

### Lifecycle

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `spawn` | `(spec:SpawnSpec) => Actor \| null` — null when the pool is dry | Y | pool |
| `despawn` | `(actor:Actor, immediate?:boolean) => void` | Y | no |
| `kill` | `(actor:Actor, killerId:int) => void` — forces death without damage | Y | no |
| `resurrect` | `(actor:Actor, lifeFraction:number) => boolean` — corpse revival | Y | no |
| `resurrectableCorpses` | `(x,z,radius:number, out:int[]) => int count` — the query that finds `resurrect`'s argument. Sorted by distance, then by corpse id | Y | no |
| `resolve` | `(ref:ActorRef) => Actor \| null` | Y | no |
| `ref` | `(actor:Actor, out?:ActorRef) => ActorRef` | Y | no |
| `byId` | `(id:int) => Actor \| null` | Y | no |
| `all` | property → `Actor[]` — the live dense list, **read-only** | Y | no |
| `player` | property → `Actor \| null` | Y | no |
| `count` | property → `int` | Y | no |
| `forEachInRadius` | `(x,z,radius:number, team:int\|-1, fn:(actor)=>void) => void` | Y | no |

```js
const SpawnSpec = {
  kind: 'monster', archetypeId: 'bone_ranker', rank: 'normal',
  level: 10, team: 1, x: 0, z: 0, facing: 0,
  packId: 0, ownerId: 0, affixes: [], nameOverride: null,
};
```

### Transform and motion

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `moveTo` | `(actor:Actor, dx,dz:number) => MoveResult` — a per-step delta, not a destination | Y | no |
| `teleport` | `(actor:Actor, x,z:number) => boolean` — snaps to nav, returns false if none | Y | no |
| `face` | `(actor:Actor, targetX,targetZ:number, maxTurnRate:number) => void` | Y | no |
| `distance` | `(a:Actor, b:Actor) => number` — surface-to-surface, radii subtracted | Y | no |
| `inRange` | `(a:Actor, b:Actor, range:number) => boolean` | Y | no |
| `applyImpulse` | `(actor:Actor, dx,dz:number, seconds:number) => void` — knockback, dashes | Y | no |
| `moveSpeed` | `(actor:Actor) => number` — m/s after stats and statuses | Y | no |

### Stats and vessels

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `stats` | `(actor:Actor) => StatBlock` — recomposes if dirty, then returns | Y | no |
| `markDirty` | `(actor:Actor) => void` — sets the flag and emits `stats:dirty` | Y | no |
| `setSourceLayer` | `(actor:Actor, layer:'equipment'\|'skills'\|'status'\|'difficulty', partial:object) => void` | Y | no |
| `addLife` | `(actor:Actor, amount:number, sourceId:int) => number` — actual amount applied | Y | no |
| `addMana` | `(actor:Actor, amount:number) => number` | Y | no |
| `addRage` | `(actor:Actor, amount:number) => number` | Y | no |
| `addResonance` | `(actor:Actor, amount:number) => number` | Y | no |
| `spend` | `(actor:Actor, resource:string, amount:number\|'all') => boolean` — atomic; false if short. `'all'` spends `floor(actor[resource])` and fails below 1; only `blade_seal`'s Resonance cost uses it (03 §2.4) | Y | no |
| `canAfford` | `(actor:Actor, resource:string, amount:number) => boolean` | Y | no |
| `lifeFraction` | `(actor:Actor) => number` — 0..1 | Y | no |

### Action state machine

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `setState` | `(actor:Actor, state:string) => boolean` — false on an illegal transition | Y | no |
| `beginAction` | `(actor:Actor, actionId:string, windup,active,recover:number) => int actionSeq` | Y | no |
| `cancelAction` | `(actor:Actor, reason:'hitstun'\|'death'\|'interrupt'\|'input') => boolean` | Y | no |
| `canAct` | `(actor:Actor) => boolean` — false while frozen, stunned, dead, in hitstun | Y | no |
| `canMove` | `(actor:Actor) => boolean` | Y | no |
| `actionProgress` | `(actor:Actor) => number` — 0..1 across the whole action | Y | no |

### Status effects

`combat` is the only legitimate caller of `applyStatus` / `removeStatus`;
they are public so the balance harness can drive them directly.

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `applyStatus` | `(actor:Actor, spec:StatusSpec) => StatusEffectInstance \| null` | Y | pool |
| `removeStatus` | `(actor:Actor, status:string) => int` — instances removed | Y | no |
| `hasStatus` | `(actor:Actor, status:string) => boolean` — bitfield test | Y | no |
| `statusStacks` | `(actor:Actor, status:string) => int` | Y | no |
| `statusRemaining` | `(actor:Actor, status:string) => number` — seconds, 0 if absent | Y | no |
| `clearStatuses` | `(actor:Actor, onlyHarmful:boolean) => void` | Y | no |

### Presentation

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `playAnim` | `(actor:Actor, clipId:string, opts?:{ speed, layer, fade }) => void` | N | no |
| `hitStop` | `(actor:Actor, seconds:number) => void` — presentation freeze only | N | no |
| `flash` | `(actor:Actor, colour:[r,g,b], seconds:number) => void` | N | no |
| `attachAt` | `(actor:Actor, boneName:string, out?:Vec3) => Vec3` — world position of a bone | N | no |
| `setEquipVisual` | `(actor:Actor, slot:string, visualId:string\|null) => void` | N | yes |
| `setLod` | `(actor:Actor, lod:int) => void` | N | no |
| `prewarmMaterials` | `(ctx) => Promise<void>` | — | yes |

| Direction | Events |
|---|---|
| Emits | `actor:spawn` `{ actor }`, `actor:despawn` `{ actor }`, `stats:dirty` `{ actor }` |
| Listens | `zone:ready` (despawns everything not `questCritical`), `item:equip` / `item:unequip` (visual slots) |

`actor:death` is emitted by **`combat`**, not by `actors` — a death is a damage
outcome and `combat` owns damage. `actors.kill()` routes through `combat` for
the emission.

**Owns exclusively:** the `Actor` pool, `StatBlock` composition, the
`StatusEffectInstance` pool, skeletons, animators, the action state machine, and
the sole write access to `actor.x/y/z/facing` and to every vessel field.

**Forbidden for callers:**
- Never write any field of an `Actor` directly. Every mutation has a method.
  The one exception is `brain`-adjacent scratch on records `ai` owns.
- Never call `actors.stats()` inside a loop that also emits `stats:dirty` —
  that recomposes N times. Batch the dirty marks, then read.
- Never hold an `Actor` reference across a frame. Hold an `ActorRef`.
- Never call `playAnim`, `hitStop` or `flash` from `fixedUpdate` — they are
  presentation and would desynchronise the headless harness.
- Never apply damage through `addLife(actor, -n)`. Damage goes through `combat`.

---

## 8. `combat`

```
/**
 * ===========================================================================
 * COMBAT — all combat mathematics
 * ===========================================================================
 *
 * The single authority on damage. Nothing else computes a hit chance, rolls a
 * crit, applies a resistance or subtracts life. Callers describe an intent —
 * a DamagePacket — and combat resolves it, applies it and reports it.
 *
 * Two halves:
 *   BUILD    buildAttackPacket() reads the attacker's stats, the skill and the
 *            weapon, and produces a packet with every attacker-side number
 *            already folded in.
 *   RESOLVE  resolve() runs the fourteen-step defender-side pipeline of
 *            03-combat-math.md §6 and returns a DamageResult.
 *
 * Everything here is pure arithmetic over plain objects: combat imports nothing
 * from three, reads no DOM, and is unit-tested in Node.
 *
 * PUBLIC API — const combat = ctx.get('combat')
 * ...
 */
export class CombatSystem { static id = 'combat'; static deps = ['actors']; }
```

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `buildAttackPacket` | `(source:Actor, skillId:string, level:int, out?:DamagePacket) => DamagePacket` | Y | pool |
| `buildSpellPacket` | `(source:Actor, skillId:string, level:int, out?:DamagePacket) => DamagePacket` | Y | pool |
| `releasePacket` | `(packet:DamagePacket) => void` | Y | no |
| `resolve` | `(packet:DamagePacket, target:Actor, out?:DamageResult) => DamageResult` | Y | pool |
| `applyDirect` | `(target:Actor, amount:number, element:string, sourceId:int, skillId:string) => DamageResult` — mitigation-free, for scripted damage | Y | pool |
| `heal` | `(target:Actor, amount:number, sourceId:int) => number` | Y | no |
| `chanceToHit` | `(attackRating:number, defense:number, alvl:int, dlvl:int) => number` — 5..95 | Y | no |
| `blockChanceOf` | `(actor:Actor) => number` — 0..75, 0 without a shield | Y | no |
| `effectiveResist` | `(target:Actor, element:string, pierce:number) => number` — post-cap, post-pierce | Y | no |
| `isImmune` | `(target:Actor, element:string) => boolean` | Y | no |
| `attackInterval` | `(actor:Actor, skillId:string) => number` — seconds | Y | no |
| `castInterval` | `(actor:Actor, skillId:string) => number` — seconds | Y | no |
| `hitRecoveryTime` | `(actor:Actor) => number` — seconds | Y | no |
| `applyStatusFromPacket` | `(packet:DamagePacket, target:Actor, result:DamageResult) => void` | Y | pool |
| `expireBySource` | `(sourceId:int, sourceGen:int, status:string\|null) => int expired` — expires every `StatusEffectInstance` matching the source, optionally filtered by status, emitting `actor:status` with `duration: 0` for each. Killing a Dust Shaman strips the `haste_dust` it granted | Y | no |
| `awardXp` | `(killer:Actor, victim:Actor) => int` — the amount granted | Y | no |
| `xpForMonster` | `(mlvl:int, rank:string, baseXp:number, clvl:int, difficulty:string) => int` | Y | no |
| `threatOf` | `(monster:Actor) => int actorId` | Y | no |
| `addThreat` | `(monster:Actor, actorId:int, amount:number) => void` | Y | no |
| `scratchPacket` | `() => DamagePacket` — a zeroed packet the caller must release | Y | pool |

| Direction | Events |
|---|---|
| Emits | `actor:damage` `{ target, source, result }`, `actor:heal` `{ target, amount, source }`, `actor:status` `{ target, status, stacks, duration, source }`, `actor:death` `{ actor, killer, point }`, `xp:gain` `{ actor, amount, source }`, `stats:dirty` (on status apply/expire) |
| Listens | `combat:hit-request` `{ source, target, packet }` — the only entry point for a requested hit |

**Owns exclusively:** the damage pipeline, to-hit, block, dodge, crit,
resistance and immunity resolution, DoT ticking, hit recovery, knockback
decision, life/mana steal, the threat tables, XP award, and the `DamagePacket` /
`DamageResult` pools.

**Forbidden for callers:**
- **Never apply damage yourself.** `ARCHITECTURE.md` is explicit: damage is
  requested via `combat:hit-request`, and `combat` is the only emitter of
  `actor:damage`. A subsystem that subtracts life directly will disagree with
  the balance harness within a week.
- Never emit `actor:death`. Kill through `actors.kill()`.
- Never hold a `DamagePacket` or `DamageResult` past the synchronous dispatch of
  the event that carried it — both are pooled and released at end of step.
- Never mutate a packet returned by `buildAttackPacket()` other than the fields
  documented as caller-adjustable (`radius` consumers, `pierceIndex`,
  `onHitStatus`, `knockback`, `originX/Y/Z`).
- Never call `resolve()` on a target on another team's behalf to "preview"
  damage — it applies. Use `chanceToHit` and the packet's own ranges.

---

## 9. `fx`

```
/**
 * ===========================================================================
 * FX — GPU particles, impacts, decals, ground-item glow, projectile trails
 * ===========================================================================
 *
 * One instanced particle system per blend mode, driven by a GPU simulation
 * texture; decals on a ring buffer; a fixed slot budget of twelve point lights
 * shared with `world`, whose VISIBLE count never changes.
 *
 * Everything here is presentation. fx never affects the simulation, never
 * reads RNG that gameplay reads (it owns its own fork), and is entirely
 * absent in the headless harness.
 *
 * PUBLIC API — const fx = ctx.get('fx')
 * ...
 */
export class FxSystem { static id = 'fx'; static deps = ['render','materials']; }
```

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `impact` | `(x,y,z:number, nx,ny,nz:number, surface:SurfaceType, power:number) => void` | N | no |
| `elementalImpact` | `(x,y,z:number, element:string, radius:number, power:number) => void` | N | no |
| `burst` | `(presetId:string, x,y,z:number, scale:number) => int handle` | N | no |
| `trail` | `(presetId:string, fromRef:ActorRef\|null, x,y,z:number) => int handle` | N | no |
| `updateTrail` | `(handle:int, x,y,z:number) => void` | N | no |
| `endTrail` | `(handle:int) => void` | N | no |
| `decal` | `(presetId:string, x,z:number, radius,rotation:number, ttl:number) => void` | N | no |
| `beam` | `(presetId:string, ax,ay,az,bx,by,bz:number, seconds:number) => void` | N | no |
| `groundEffect` | `(presetId:string, x,z,radius:number, seconds:number) => int handle` | N | no |
| `endGroundEffect` | `(handle:int) => void` | N | no |
| `lootGlow` | `(itemUid:int, x,y,z:number, rarity:string) => void` | N | no |
| `endLootGlow` | `(itemUid:int) => void` | N | no |
| `telegraph` | `(shape:'cone'\|'circle'\|'line', x,z,facing,a,b:number, seconds:number) => int` | N | no |
| `endTelegraph` | `(handle:int) => void` | N | no |
| `requestLight` | `(x,y,z:number, colour:[r,g,b], intensity,radius,seconds:number) => int slot \| -1` — **`seconds <= 0` means the slot persists until `releaseLight()`** and is exempt from oldest-first recycling. Every `world.lightAnchors` entry is bound this way | N | no |
| `releaseLight` | `(slot:int) => void` | N | no |
| `setQualityBudget` | `(particles:int, decals:int) => void` | N | no |
| `stats` | property → `{ particles, decals, trails, lightsUsed, gpuMs }` | N | no |
| `prewarmMaterials` | `(ctx) => Promise<void>` | — | yes |

| Direction | Events |
|---|---|
| Emits | — |
| Listens | `actor:damage`, `actor:death`, `actor:status`, `skill:cast`, `skill:impact`, `projectile:spawn` / `projectile:end`, `loot:drop`, `loot:pickup`, `zone:ready` |

**Owns exclusively:** the particle pools and their GPU targets, the decal ring,
the trail pool, the twelve shared light slots, all FX materials and presets.

**Forbidden for callers:**
- Never call any `fx` method from `fixedUpdate`. Every one of them is
  presentation and reading them into the simulation makes the run
  irreproducible. `skills` and `combat` queue intents in `fixedUpdate` and flush
  them in `update`.
- Never assume a handle stays valid: a pool under pressure recycles the oldest
  entry, and a stale handle is a no-op, never an error.
- Never occlude a rarity colour or an enemy telegraph. Readability outranks
  spectacle — `ARCHITECTURE.md` § Quality bar.
- Never toggle `visible` on a light slot.

---

## 10. `skills`

```
/**
 * ===========================================================================
 * SKILLS — the registry, the trees, projectiles, ground effects, auras
 * ===========================================================================
 *
 * Owns the thirty skill definitions (01-data-model.md §6.3) and everything
 * that happens between "the player pressed the button" and
 * "combat:hit-request was emitted": cost, cooldown, cast/attack timing,
 * targeting, projectile flight, area queries, ground effects, buffs.
 *
 * Skills never compute damage. They ask combat for a packet, adjust the fields
 * they own, and emit the request.
 *
 * PUBLIC API — const skills = ctx.get('skills')
 * ...
 */
export class SkillsSystem { static id = 'skills'; static deps = ['actors','combat','fx']; }
```

### Registry and allocation

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `definition` | `(skillId:string) => SkillDefinition` | Y | no |
| `all` | property → `SkillDefinition[]` — all 30 | Y | no |
| `forClass` | `(classId:string) => SkillDefinition[]` — 10 | Y | no |
| `forTree` | `(treeId:string) => SkillDefinition[]` — 5 | Y | no |
| `trees` | `(classId:string) => string[]` — 2 | Y | no |
| `instanceOf` | `(actor:Actor, skillId:string) => SkillInstance \| null` | Y | no |
| `effectiveLevel` | `(actor:Actor, skillId:string) => int` | Y | no |
| `canAllocate` | `(actor:Actor, skillId:string) => { ok:boolean, reason:string }` | Y | no |
| `allocate` | `(actor:Actor, skillId:string) => boolean` — spends one point | Y | no |
| `respec` | `(actor:Actor) => int` — points refunded | Y | no |
| `synergyBonus` | `(actor:Actor, skillId:string, statKey:string) => number` — % | Y | no |

### Casting

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `canCast` | `(actor:Actor, skillId:string, targetX,targetZ:number) => { ok:boolean, reason:string }` | Y | no |
| `cast` | `(actor:Actor, skillId:string, targetX,targetZ:number, targetId:int) => boolean` | Y | pool |
| `basicAttack` | `(actor:Actor, targetId:int) => boolean` | Y | pool |
| `interrupt` | `(actor:Actor) => void` — cancels a cast or a channel | Y | no |
| `isChannelling` | `(actor:Actor) => boolean` | Y | no |
| `cooldownRemaining` | `(actor:Actor, skillId:string) => number` — seconds | Y | no |
| `costOf` | `(actor:Actor, skillId:string) => { resource:string, amount:number }` | Y | no |
| `rangeOf` | `(actor:Actor, skillId:string) => number` — metres | Y | no |
| `radiusOf` | `(actor:Actor, skillId:string) => number` — metres | Y | no |

### Projectiles, ground effects, buffs

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `spawnProjectile` | `(spec:ProjectileSpawn) => int id \| 0` | Y | pool |
| `killProjectile` | `(id:int) => void` | Y | no |
| `projectileCount` | property → `int` | Y | no |
| `addGroundEffect` | `(spec:GroundEffectSpawn) => int id \| 0` — registers a nav hazard | Y | pool |
| `removeGroundEffect` | `(id:int) => void` | Y | no |
| `applyBuff` | `(actor:Actor, buffId:string, level:int, seconds:number) => void` | Y | pool |
| `removeBuff` | `(actor:Actor, buffId:string) => void` | Y | no |
| `hasBuff` | `(actor:Actor, buffId:string) => boolean` | Y | no |
| `imbueRemaining` | `(actor:Actor) => int` — `blade_seal` hits left | Y | no |
| `imbueElement` | `(actor:Actor) => 'fire'\|'cold'\|'lightning'\|null` — which element those charges carry | Y | no |
| `polarityStance` | `(actor:Actor) => 'blade'\|'storm'\|null` | Y | no |
| `cascadeCharges` | `(actor:Actor) => int` — 0..2, the empowered-hit counter | Y | no |
| `buffRemaining` | `(actor:Actor, buffId:string) => number` — seconds; `hasBuff` is only a boolean | Y | no |
| `buffList` | `(actor:Actor, out:Array) => int` — entries `{ buffId, level, remaining, stacks }`, into a caller-owned array | Y | no |
| `absorbRemaining` | `(actor:Actor) => number` — the `smouldering_ward` / `last_stand` pool `ui` overlays on the life globe | Y | no |
| `summonOf` | `(actor:Actor, skillId:string) => ActorRef \| null` — never an `Actor`; the pool recycles | Y | no |
| `pointsInTree` | `(actor:Actor, treeId:string) => int` | Y | no |
| `describe` | `(actor:Actor, skillId:string, level:int, out:SkillDescription) => SkillDescription` — the tooltip's numbers at any level, so skill mathematics never lives in two subsystems | Y | no |
| `prewarmMaterials` | `(ctx) => Promise<void>` | — | yes |

```js
/** Preallocated; `ui` renders it and never recomputes a skill number. */
const SkillDescription = {
  lineCount: 0,
  lines: [ /* { labelKey, value, unit, format } × 8, preallocated */ ],
  costResource: 'mana', costAmount: 0,
  cooldown: 0, castTime: 0, radius: 0, range: 0, duration: 0,
  damageMin: 0, damageMax: 0,
};
```

| Direction | Events |
|---|---|
| Emits | `skill:cast` `{ actor, skillId, level, target, point }`, `skill:impact` `{ point, element, radius, skillId }`, `skill:trigger` `{ actor, skillId, level }`, `skill:channel` `{ actor, skillId, active:boolean }`, `projectile:spawn` / `projectile:end` `{ id, from, to, element }`, `combat:hit-request` `{ source, target, packet }`, `stats:dirty` |
| Listens | `actor:damage` (the only way to know a hit **landed** — `blade_seal`'s imbue and `cascade`'s counter both decrement on it and on nothing else), `actor:death` (drops summons, ends channels), `player:levelup`, `zone:teardown` (clears projectiles and ground effects) |

`skill:trigger` exists because a passive that fires — `cascade`, `last_stand`,
`incinerate`'s detonation — is indistinguishable from a cast one through
`skill:impact`, and `audio` and `fx` need to tell them apart. `skill:channel`
exists because `whirlwind`'s tracked audio loop needs an explicit start and
stop, and `interrupt()` is a method, not an event.

**Owns exclusively:** the 30 skill definitions and trees, the projectile pool,
the ground-effect pool, buff instances, cooldown bookkeeping, `blade_seal`
imbue state, `polarity` stance, summon ownership.

**Forbidden for callers:**
- Never compute a skill's damage. Ask `combat.buildAttackPacket()`.
- Never call `allocate()` without checking `canAllocate()` — it does not
  validate tier or prerequisites, by design, so the respec path can rebuild a
  tree in one pass.
- Never spawn a projectile outside `spawnProjectile()`; the pool cap is what
  keeps a Runeblade `unity` burst from allocating.
- Never write `NAV_FLAG.hazard`. Call `nav.markHazard()` — `skills` is its only
  legitimate caller, and every ground effect must register and deregister.

---

## 11. `items`

```
/**
 * ===========================================================================
 * ITEMS — bases, affixes, rolling, treasure classes, inventory, vendors,
 *         procedural item icons
 * ===========================================================================
 *
 * The whole itemisation model: the static tables, the deterministic roll
 * pipeline (base → quality → affix count → affix pick → affix values, in that
 * order, always), the tetris containers, equipment, identification, durability,
 * vendor stock and pricing, and the OffscreenCanvas icon generator.
 *
 * The roll pipeline imports nothing from three and runs headless — that is
 * what tools/lootsim.mjs depends on.
 *
 * PUBLIC API — const items = ctx.get('items')
 * ...
 */
export class ItemsSystem { static id = 'items'; static deps = ['materials']; }
```

### Data and rolling

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `base` | `(baseId:string) => ItemBase` | Y | no |
| `bases` | property → `ItemBase[]` | Y | no |
| `affix` | `(affixId:string) => AffixDefinition` | Y | no |
| `unique` | `(uniqueId:string) => UniqueDefinition` | Y | no |
| `rollDrop` | `(tc:string, ilvl:int, magicFind:number, rng:Rng) => ItemInstance \| null` | Y | yes |
| `rollItem` | `(baseId:string, ilvl:int, rarity:string, rng:Rng) => ItemInstance` | Y | yes |
| `createItem` | `(baseId:string, opts?:{ quantity, identified }) => ItemInstance` | Y | yes |
| `statsOf` | `(item:ItemInstance, out?:object) => object` — the partial StatBlock it contributes | Y | no |
| `rolledMods` | `(item:ItemInstance, out:Array) => int` — the per-affix structure `statsOf`'s merge destroys. Entries `{ stat, value, min, max, source:'base'\|'affix'\|'unique', affixId, kind }`. Line-per-affix rendering, the all-resistances merge, the Alt range reveal, negative-mod colouring and a unique's `uniqueValues` all read it | Y | no |
| `resolveTC` | `(family:string, mlvl:int) => string` — the treasure-class band for a `MonsterArchetype.treasureClass` family. `ai` and `world` both need it before `rollDrop`, and a duplicated band table is exactly the drift rule 9 exists to stop | Y | no |
| `rollChest` | `(chest:object, rng:Rng, out:ItemInstance[]) => int` — **the one entry point that takes an external `Rng`**: chest contents come from the chest's own `S4` sub-seed, so they cannot depend on how many monsters died first | Y | yes |
| `rollGold` | `(mlvl:int, rank:string, goldFind:number, rng:Rng) => int` | Y | no |
| `rollName` | `(item:ItemInstance, rng:Rng) => void` — names in place from the §10 pools and the recent-name ring. Public because `tools/lootsim.mjs` must reset that ring between batches | **Y** | no |
| `grantUnique` | `(uniqueId:string, ilvl:int, actor:Actor) => ItemInstance \| null` — the quest reward is the only item created outside a treasure-class roll. `null` when there is no room | N | yes |
| `itemValue` | `(item:ItemInstance) => int` — the one formula `sellValue`, `buyValue`, the tooltip's Value line and the migration's stripped-item credit all derive from | Y | no |
| `displayName` | `(item:ItemInstance) => string` | N | no |
| `sellValue` | `(item:ItemInstance) => int` | Y | no |
| `buyValue` | `(item:ItemInstance) => int` | Y | no |
| `goldCap` | `(clvl:int) => int` | Y | no |
| `rebuildCache` | `(item:ItemInstance) => void` — after load or identify | N | yes |

### Containers and equipment

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `canPlace` | `(container:string, item:ItemInstance, x,y:int) => boolean` | Y | no |
| `place` | `(container:string, item:ItemInstance, x,y:int) => boolean` | Y | no |
| `autoPlace` | `(container:string, item:ItemInstance) => boolean` — first fit, row-major | Y | no |
| `remove` | `(item:ItemInstance) => boolean` | Y | no |
| `itemAt` | `(container:string, x,y:int) => ItemInstance \| null` | Y | no |
| `freeCells` | `(container:string) => int` | Y | no |
| `equip` | `(actor:Actor, item:ItemInstance, slot:string) => { ok:boolean, reason:string }` | Y | no |
| `unequip` | `(actor:Actor, slot:string) => boolean` | Y | no |
| `equipped` | `(actor:Actor, slot:string) => ItemInstance \| null` | Y | no |
| `canEquip` | `(actor:Actor, item:ItemInstance, slot:string) => { ok:boolean, reason:string }` | Y | no |
| `weaponOf` | `(actor:Actor) => ItemInstance \| null` — `mainHand`, or the unarmed pseudo-item | Y | no |
| `hasShield` | `(actor:Actor) => boolean` | Y | no |
| `beltUse` | `(actor:Actor, slotIndex:int) => boolean` — drink/read | Y | no |
| `beltCount` | `(actor:Actor, slotIndex:int) => int` | Y | no |
| `beltCooldown` | `(actor:Actor) => number` — seconds left on the 0.5 s global belt cooldown, for the slot sweep | Y | no |
| `slotsFor` | `(item:ItemInstance) => string[]` — the real list: a ring is legal in `ring1` and `ring2`, a one-hander in `mainHand` and `offHand`. `ItemBase.slot` is a single value and cannot say so | Y | no |
| `findPlacement` | `(container:string, item:ItemInstance, out?:{x,y}) => {x,y} \| null` — **non-mutating** first fit. `autoPlace` mutates and so cannot preview a pickup, a quick-move or a sort | Y | no |
| `sortContainer` | `(container:string) => boolean` | Y | no |
| `splitStack` | `(item:ItemInstance, count:int) => ItemInstance \| null` | Y | yes |
| `consume` | `(item:ItemInstance, count:int) => boolean` — decrements `quantity` and removes at zero. `remove()` deletes the whole stack, which is wrong for a scroll read from the inventory or a partial vendor purchase | Y | no |
| `byUid` | `(uid:int) => ItemInstance \| null` — resolves the uid a label click hands `player.pickUpOrder`, and the `save` validation invariant | Y | no |
| `cursorItem` | property → `ItemInstance \| null` — the canonical slot for an item under the cursor. Without it a mid-drag autosave loses an orphan | Y | no |
| `takeToCursor` | `(item:ItemInstance) => boolean` | Y | no |
| `dropCursor` | `(container:string, x,y:int) => { ok:boolean, swapped:ItemInstance\|null }` — swap-on-drop must be atomic; `remove` then `place` can leave the grid half-written | Y | no |
| `returnCursor` | `() => boolean` — `Esc` and window-blur cancellation | Y | no |
| `addGold` | `(actor:Actor, amount:int) => int` — the amount actually added, after `goldCap` | Y | no |
| `spendGold` | `(actor:Actor, amount:int) => boolean` — atomic | Y | no |
| `dropGold` | `(amount:int, x,z:number) => void` | Y | no |
| `stashGold` | property → `int`, with `moveGold(actor, amount, toStash:boolean) => boolean` | Y | no |

### World interaction, identification, durability, vendors

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `dropToGround` | `(item:ItemInstance, x,z:number) => void` | Y | no |
| `groundItemsNear` | `(x,z,radius:number, out:ItemInstance[]) => int` | Y | no |
| `pickUp` | `(actor:Actor, item:ItemInstance) => boolean` | Y | no |
| `identify` | `(item:ItemInstance) => boolean` | Y | no |
| `damageDurability` | `(item:ItemInstance, amount:int) => boolean` — true when it reaches 0 | Y | no |
| `repair` | `(item:ItemInstance) => int` — gold cost applied | Y | no |
| `repairCost` | `(item:ItemInstance) => int` | Y | no |
| `vendorStock` | `(npcId:string, rng:Rng, clvl:int) => ItemInstance[]` — regenerated per town visit | Y | yes |
| `currentStock` | `(npcId:string) => readonly ItemInstance[]` — the live stock, read-only. `ui` must never call `vendorStock`: drawing from a gameplay RNG stream would desynchronise `tools/lootsim.mjs` | Y | no |
| `buyback` | `(npcId:string) => readonly ItemInstance[]` | Y | no |
| `repairAllCost` | `(actor:Actor) => int` | Y | no |
| `repairAll` | `(actor:Actor) => int` — gold spent | Y | no |
| `durabilityTick` | `(actor:Actor, kind:'attack'\|'hit'\|'block'\|'death') => void` — `combat` knows a hit landed; `items` owns the accumulator and the `stats:dirty` at zero | Y | no |
| `vendorBuy` | `(actor:Actor, item:ItemInstance, npcId:string) => boolean` | Y | no |
| `vendorSell` | `(actor:Actor, item:ItemInstance, npcId:string) => boolean` | Y | no |
| `icon` | `(item:ItemInstance) => OffscreenCanvas` — generated once, cached | N | yes (first call) |
| `prewarmMaterials` | `(ctx) => Promise<void>` | — | yes |

| Direction | Events |
|---|---|
| Emits | `loot:drop` `{ item, point, rarity }`, `loot:pickup` `{ item, actor }`, `item:equip` / `item:unequip` `{ actor, item, slot }`, `item:identify` `{ item }`, `stats:dirty` `{ actor }` |
| Listens | `actor:death` (rolls the treasure class), `actor:damage` (resets the ground-item decay grace on the player, so an item dropped mid-fight is not evicted by `q.groundItemBudget` while the fight is still running), `zone:teardown` (clears ground items), `player:levelup` (re-evaluates `unusable`) |

**Owns exclusively:** all item data tables, the roll pipeline and its RNG
stream, every `ItemInstance` in the game, the inventory/stash/belt grids, the
equipment set, vendor stock, item icons.

**Forbidden for callers:**
- Never construct an `ItemInstance` literal. Use `createItem` / `rollItem` —
  they assign `uid` and build `_cache`.
- Never write `item.affixes`, `item.rolls` or `item.rarity` after the drop.
  Rolled values are immutable; that is what makes a save auditable.
- Never call `rollDrop` with `ctx.rng` — pass the `items` fork. Sharing the
  stream desynchronises the loot harness from the game.
- Never draw an item icon yourself; the rarity frame and tint are part of the
  readability contract.

---

## 12. `ai`

```
/**
 * ===========================================================================
 * AI — monster behaviour, packs, champions and uniques, boss patterns, spawning
 * ===========================================================================
 *
 * One Brain per hostile actor (01-data-model.md §9.6), decided at 10 Hz, moved
 * at 60 Hz. The default movement mode is the shared flow field; A* is rationed
 * through nav's ring budget and reserved for agents that cannot use the field.
 * Above 40 active monsters every agent is on the field and A* is reserved for
 * agents that have left the crowd.
 *
 * Packs share an aggro cloud: waking one wakes all of them.
 *
 * PUBLIC API — const ai = ctx.get('ai')
 * ...
 */
export class AiSystem { static id = 'ai'; static deps = ['actors','nav','combat','world']; }
```

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `archetype` | `(id:string) => MonsterArchetype` | Y | no |
| `archetypes` | property → `MonsterArchetype[]` — the six plus Molgrim | Y | no |
| `spawnPack` | `(pack:PackDescriptor) => int spawned` | Y | pool |
| `spawnOne` | `(archetypeId:string, x,z:number, mlvl:int, rank:string, affixes:string[]) => Actor \| null` | Y | pool |
| `spawnBoss` | `(x,z:number, mlvl:int) => Actor \| null` | Y | pool |
| `despawnAll` | `(keepQuestCritical:boolean) => void` | Y | no |
| `brainOf` | `(actor:Actor) => Brain \| null` | Y | no |
| `alertPack` | `(packId:int, x,z:number) => void` | Y | no |
| `setTarget` | `(actor:Actor, targetId:int) => void` | Y | no |
| `aliveCount` | property → `int` | Y | no |
| `activeCount` | property → `int` — brains not `dormant` | Y | no |
| `rollAffixes` | `(rank:string, mlvl:int, rng:Rng, out:string[]) => int` | Y | no |
| `affixStats` | `(affixId:string, mlvl:int, out?:object) => object` | Y | no |
| `bossPhase` | property → `int` — 1, 2 or 3; 0 when no boss is alive | Y | no |
| `bossPhaseProgress` | property → `number` 0..1 — progress through the current life band, for the phase pips on the boss bar | Y | no |
| `bossActor` | property → `Actor \| null` | Y | no |
| `packTemplate` | `(id:string) => PackTemplate \| null` — the frozen template for a `pk_`-prefixed id, `null` for a bestiary id. `tools/mapgen.mjs` reports pack composition per zone through it without instantiating `ai` | Y | no |
| `priorityTargets` | property → `readonly int[]` — actor ids `ui` should mark. Today every live `dust_shaman` | Y | no |
| `setDensityBudget` | `(maxActive:int) => void` | Y | no |
| `stats` | property → `{ brains, decisions, pathRequests, pathRefusals, flowUsers }` | Y | no |
| `debugStage` | `(name:'pack'\|'champion'\|'boss'\|'dense') => void` — staged tableau for captures | N | pool |
| `prewarmMaterials` | `(ctx) => Promise<void>` | — | yes |

```js
const PackTemplate = {
  id:     'pk_warband',
  fixed:  [{ archetypeId: 'dust_shaman', n: 1 }],
  share:  [{ archetypeId: 'bone_ranker',   f: 0.40, min: 0 },
           { archetypeId: 'ashen_archer',  f: 0.30, min: 0 },
           { archetypeId: 'carrion_swarm', f: 0.30, min: 0 }],
  sizeFloor: 8,
};
```

| Direction | Events |
|---|---|
| Emits | `actor:spawn` `{ actor }`, `actor:despawn` `{ actor }`, `combat:hit-request` `{ source, target, packet }`, `boss:phase` `{ phase, actor }`, `ai:pack-alert` `{ packId, x, z, memberCount }`, `ai:priority-target` `{ actor, reason:'support' }`, `ai:corpse-raised` `{ actor, shaman, point }` |
| Listens | `zone:teardown` (despawns its population), `zone:ready` (spawns the packs), `actor:damage` (threat, aggro, flee), `actor:death` (pack bookkeeping, revive credits), `skill:cast` (telegraph reaction), `nav:rebuilt` |

`boss:phase` is emitted **at spawn with `phase: 1`**, not only on transitions.
The boss introduction has no other trigger, and polling `ai.bossActor` from
`ui`, `audio` and `fx` every frame is exactly what the event exists to avoid.

**Owns exclusively:** the `Brain` pool, the bestiary and monster-affix tables,
pack instances and their aggro clouds, boss phase state and pattern scheduling,
the monster spawn decision, the AI RNG stream.

**Forbidden for callers:**
- Never write a `Brain` field from outside `ai`.
- Never spawn a monster through `actors.spawn()` directly — a monster without a
  brain is a statue and pack bookkeeping will never see it.
- Never call `nav.requestPath()` on a monster's behalf.
- Never assume `bossPhase` is monotonic across a zone reset.

---

## 13. `player`

```
/**
 * ===========================================================================
 * PLAYER — input intent, click targeting, hotbar, resources, levelling, quest
 * ===========================================================================
 *
 * Translates raw input into intent in update(), and consumes that intent in
 * fixedUpdate(). This split is what keeps the simulation reproducible: mouse
 * position is sampled once per frame and latched, and fixedUpdate never reads
 * the pointer.
 *
 * Also the only writer of the camera. Nothing else moves ctx.camera.
 *
 * PUBLIC API — const p = ctx.get('player')
 * ...
 */
export class PlayerSystem {
  static id = 'player';
  static deps = ['actors','nav','skills','items','world'];
}
```

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `actor` | property → `Actor \| null` | Y | no |
| `createCharacter` | `(classId:string, name:string, worldSeed:uint32) => Actor` | N | yes |
| `loadCharacter` | `(save:CharacterSave) => Actor` | N | yes |
| `serialise` | `(out?:CharacterSave) => CharacterSave` | N | yes |
| `intent` | property → `Intent` (read-only, latched once per frame) | Y | no |
| `setControlEnabled` | `(on:boolean) => void` | N | no |
| `moveOrder` | `(x,z:number) => void` — an explicit click-to-move destination | Y | no |
| `pickUpOrder` | `(itemUid:int) => void` — walk into range and pick up **that** item. `moveOrder` loses the identity | Y | no |
| `interactOrder` | `(kind:'npc'\|'portal'\|'chest'\|'stash', id:int) => void` | Y | no |
| `stop` | `() => void` | Y | no |
| `castOrder` | `(hotbarIndex:int, x,z:number, targetId:int) => void` | Y | no |
| `useBelt` | `(slotIndex:int) => boolean` | Y | no |
| `hotbar` | property → `Hotbar` | Y | no |
| `setHotbar` | `(index:int, skillId:string\|null) => void` | N | no |
| `hoverTarget` | property → `int actorId` — 0 when none | N | no |
| `groundCursor` | `(out?:Vec3) => Vec3` — where the pointer meets the ground plane | N | no |
| `grantXp` | `(amount:int, sourceId:int) => void` | Y | no |
| `xpToNextLevel` | `() => int` | Y | no |
| `spendStatPoint` | `(attribute:string) => boolean` | Y | no |
| `spendSkillPoint` | `(skillId:string) => boolean` | Y | no |
| `die` | `() => void` | Y | no |
| `respawn` | `() => void` — Last Bastion, keeps items, applies the XP penalty | N | no |
| `setDifficulty` | `(tier:string) => boolean` | N | no |
| `difficulty` | property → `string` | Y | no |
| `questState` | `(questId:string) => { state:string, step:int, flags:object }` — hands out a mutable reference; prefer `questFlag` | Y | no |
| `questFlag` | `(questId:string, flag:string) => boolean\|int` — one value, no reference. `world` seals a gate on it, `ai` arms the altar on it | **Y** | no |
| `setQuestFlag` | `(questId:string, flag:string, value) => void` — the `kill` and `interact` triggers write from `fixedUpdate` | **Y** | no |
| `questTracker` | `(out:QuestTracker) => QuestTracker` — the step list with per-step counters. `questState` cannot express "2 of 3 tablets" | N | no |
| `advanceQuest` | `(questId:string, step:int) => void` | Y | no |
| `grantQuestReward` | `(questId:string, choiceIndex:int) => boolean` | Y | no |
| `startingKit` | `(classId:string) => { items:[], gold:int, skill:string }` — read-only view of `CLASS_START_KIT`; creation needs it before an `Actor` exists, and `items` must not own class data | N | yes |
| `hudState` | `(out?:HudState) => HudState` — everything `ui` needs, in one object | N | no |
| `cameraShake` | `(amount:number) => void` | N | no |
| `setCameraPeek` | `(amount:number) => void` — 0..1 cursor lean | N | no |

```js
const Intent = {
  moveX: 0, moveZ: 0, hasMoveOrder: false,
  attackTargetId: 0, castSkillIndex: -1, castX: 0, castZ: 0,
  beltSlot: -1, interactId: 0, stopRequested: false, sequence: 0,
};
const HudState = {
  life: 0, maxLife: 0, mana: 0, maxMana: 0,
  secondary: 0, maxSecondary: 0, secondaryKind: 'rage',
  secondaryDecay: 0,             // signed units/s — the rage orb's decay arrow
  level: 1, xp: 0, xpFloor: 0, xpCeiling: 50, xpTotal: 0,
  statPoints: 0, skillPoints: 0, gold: 0,
  cooldowns: [0,0,0,0], hotbar: [null,null,null,null],
  belt: [0,0,0,0], targetId: 0, difficulty: 'instruction',
  zoneId: 'last_bastion', questStep: 0,
  name: '', classId: 'ravager',  // the two ledgers
  inCombat: false,               // gates the fresh-drop grace and the decay arrow
};
const QuestTracker = {
  questId: '', state: 'active', stepCount: 0,
  steps: [ /* { key, done, have, need } — key is `quest.<id>.step.<n>` */ ],
  rewardKeys: [],
};
```

| Direction | Events |
|---|---|
| Emits | `player:levelup` `{ level, statPoints, skillPoints }`, `player:resource` `{ life, maxLife, mana, maxMana, secondary }`, `quest:update` `{ questId, state, step }`, `stats:dirty`, `actor:spawn` (the player itself) |
| Listens | `xp:gain`, `actor:death` (its own → death sequence; a monster's → quest flags), `zone:ready`, `portal:use`, `item:equip` / `item:unequip` |

`player:resource` is emitted **at most once per fixed step**, and only when a
value actually changed, so `ui` can rely on it instead of polling.

**Owns exclusively:** the player actor's intent, the camera transform, the
hotbar, attribute and skill point budgets, quest state, difficulty selection,
the death/respawn sequence, `worldSeed` and `runIndex`.

**Forbidden for callers:**
- **Never write `ctx.camera`.** Ask `player`. The camera is orbit-locked at
  `config.camPitch` / `config.camDist` and a second writer produces a fighting,
  jittering frame.
- Never read `ctx.input` outside `player`. Input is latched into `Intent` once
  per frame; a second reader gets a different answer on the same frame.
- Never read `player.intent` in `update()` — it is the simulation's input and it
  is consumed in `fixedUpdate`.
- Never grant XP or levels from another subsystem. `combat` emits `xp:gain`;
  `player` decides what it means.

---

## 14. `ui`

```
/**
 * ===========================================================================
 * UI — HUD, inventory grid, skill tree, tooltips, minimap, dialogue, menus
 * ===========================================================================
 *
 * A DOM+CSS overlay driven entirely from lateUpdate, after the camera has
 * reached its final transform for the frame. Nothing animates on a CSS
 * transition or keyframe: every value is integrated from dt here, which is what
 * makes the capture harness deterministic and lets the HUD freeze correctly
 * when the game is paused.
 *
 * The 3D item preview and the paperdoll render into ctx.uiScene, drawn after
 * the world with a cleared depth buffer.
 *
 * PUBLIC API — const ui = ctx.get('ui')
 * ...
 */
export class UiSystem { static id = 'ui'; static deps = ['items','player']; }
```

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `damageNumber` | `(x,y,z:number, amount:int, kind:'hit'\|'crit'\|'heal'\|'immune'\|'miss', element:string) => void` | N | pool |
| `floatingText` | `(x,y,z:number, text:string, colour:string) => void` | N | pool |
| `setTargetBar` | `(actor:Actor\|null) => void` | N | no |
| `banner` | `(title:string, subtitle:string, seconds:number) => void` | N | no |
| `toast` | `(text:string, kind:'info'\|'warn'\|'loot') => void` | N | no |
| `setPrompt` | `(spec:{ key:string, text:string, sub:string }\|null) => void` | N | no |
| `openInventory` / `closeInventory` / `toggleInventory` | `() => void` | N | no |
| `openSkillTree` / `closeSkillTree` | `() => void` | N | no |
| `openStash` / `openVendor` | `(npcId:string) => void` | N | no |
| `openDialogue` | `(npcId:string, nodeId:string) => void` | N | no |
| `closeAll` | `() => void` | N | no |
| `isModalOpen` | property → `boolean` — input is captured while true | Y | no |
| `showTooltip` | `(item:ItemInstance, screenX,screenY:number, compare:boolean) => void` | N | no |
| `hideTooltip` | `() => void` | N | no |
| `setLootLabels` | `(on:boolean) => void` — the settings-driven override for the Alt overlay | N | no |
| `setAltHeld` | `(on:boolean) => void` — Alt drives both the loot labels and the tooltip range reveal | N | no |
| `setCompareHeld` | `(on:boolean) => void` — Ctrl pressed *while* a tooltip is open must switch it live; `showTooltip`'s `compare` is fixed at open time | N | no |
| `setScreen` | `(screenId:'boot'\|'main_menu'\|'character_create'\|'game'\|'death'\|'reward_choice') => void` — `reward_choice` is a non-dismissible modal over the game, not a panel | N | yes |
| `toggleCharacterSheet` / `toggleQuestLog` / `toggleSkillTree` | `() => void` — `ui` may not read `ctx.input` to discover the key itself | N | no |
| `pointerOverUi` | property → `boolean` — the hit test `player` asks from `fixedUpdate` before honouring a latched click. `isModalOpen` is too coarse: the plinth is solid but not modal | **Y** | no |
| `captureBinding` | `(code:string) => boolean` — the Controls tab's next-key capture, forwarded by `player` | N | no |
| `fadeTo` | `(target:number, seconds:number) => void` — 0 clear, 1 black | N | no |
| `fadeLevel` | property → `number` 0..1 — what the engine reads to know the black window has opened | N | no |
| `adj` | `(key:string, gender:'m'\|'f'\|'n'\|'p') => string` — Russian adjective agreement. A gendered adjective is four dictionary entries in Russian and one in English; `t()` cannot express that and every caller would otherwise build the suffixed key itself | N | no |
| `dialogueLine` | `(npcId:string, key:string, params?:object) => void` — `openDialogue` opens the panel; this puts a line in it. `player` chooses the line (it depends on quest state), `ui` renders it | N | no |
| `worldLine` | `(actorId:int, key:string, seconds:number) => void` — Molgrim's lines render above his head and follow him. `floatingText` takes a resolved string and a fixed world position | N | pool |
| `setMinimapOpen` | `(on:boolean) => void` | N | no |
| `minimapMarker` | `(id:int, x,z:number, kind:string) => void` | N | no |
| `clearMinimapMarker` | `(id:int) => void` | N | no |
| `setLanguage` | `(lang:'en'\|'ru') => void` | N | yes |
| `t` | `(key:string, params?:object) => string` — i18n lookup | N | no |
| `pause` / `resume` | `() => void` | N | no |
| `setHudVisible` | `(on:boolean) => void` | N | no |
| `debugState` | `(name:'combat'\|'inventory'\|'tree'\|'vendor'\|'clean') => void` | N | no |

| Direction | Events |
|---|---|
| Emits | `vendor:open` / `vendor:close` `{ npcId }`, `ui:pause`, `ui:setting` `{ key, value }`, `ui:respec-request`, `ui:difficulty-request` `{ tier }` |
| Listens | `actor:damage`, `actor:heal`, `actor:death`, `actor:status`, `player:resource`, `player:levelup`, `quest:update`, `loot:drop`, `loot:pickup`, `item:equip` / `item:unequip` / `item:identify`, `zone:enter` / `zone:ready`, `boss:phase`, `resize` |

**Owns exclusively:** every DOM node under `#ui`, the injected stylesheet, the
i18n dictionaries, the minimap canvas, drag-and-drop state, modal focus, and
everything drawn into `ctx.uiScene`.

**Forbidden for callers:**
- Never create a DOM node outside `ui`. There is exactly one overlay.
- Never use a CSS `transition`, `animation` or `@keyframes` on anything the
  capture harness sees. Integrate from `dt` in `lateUpdate`.
- Never call a `ui` method from `fixedUpdate`.
- Never mutate an `ItemInstance` from a UI handler. Ask `items`.
- Never render into `ctx.scene` from `ui`; the HUD's 3D lives in `ctx.uiScene`.

---

## 15. `audio`

```
/**
 * ===========================================================================
 * AUDIO — Web Audio synthesis, spatialisation, mix
 * ===========================================================================
 *
 * Zero files. Every sound is synthesised: band-passed noise bursts and metal
 * ring for weapons, swept filtered noise for fire, impulse plus resonance for
 * lightning, FM crystal for ice, formant-filtered FM growls per monster type,
 * and a generative dark ambient bed per zone.
 *
 * Buses: master → [sfx, ui, music, ambient]. HRTF panning on sfx, a
 * code-generated impulse response for reverb, occlusion driven by physics
 * line-of-sight, and a scheduler that never starts more than
 * `maxVoices` sources.
 *
 * PUBLIC API — const audio = ctx.get('audio')
 * ...
 */
export class AudioSystem { static id = 'audio'; static deps = []; }
```

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `play` | `(id:string, opts?:{ gain, rate, delay }) => int voice \| 0` | N | no |
| `playAt` | `(id:string, x,y,z:number, opts?) => int voice \| 0` | N | no |
| `playUi` | `(id:string, gain?:number) => void` | N | no |
| `stop` | `(voice:int, fadeSeconds?:number) => void` | N | no |
| `impact` | `(surface:SurfaceType, power:number, x,y,z:number) => void` | N | no |
| `element` | `(element:string, power:number, x,y,z:number) => void` | N | no |
| `voice` | `(archetypeId:string, kind:'idle'\|'alert'\|'attack'\|'hurt'\|'death', x,y,z:number) => void` | N | no |
| `setAmbience` | `(presetId:string, blendSeconds:number) => void` | N | no |
| `setMusicIntensity` | `(level:number) => void` — 0..1, driven by nearby hostiles | N | no |
| `setListener` | `(x,y,z:number, forwardX,forwardZ:number) => void` — `player` only | N | no |
| `setBusVolume` | `(bus:'master'\|'sfx'\|'ui'\|'music'\|'ambient', v:number) => void` | N | no |
| `duck` | `(amount:number, seconds:number) => void` | N | no |
| `suspend` / `resumeContext` | `() => Promise<void>` | N | no |
| `ready` | property → `boolean` — false until the first user gesture unlocks it | Y | no |
| `stats` | property → `{ voices, nodes, cpuLoad }` | N | no |

| Direction | Events |
|---|---|
| Emits | — |
| Listens | `actor:damage`, `actor:death`, `actor:status`, `skill:cast`, `skill:impact`, `projectile:spawn`, `loot:drop`, `loot:pickup`, `item:equip`, `player:levelup`, `zone:enter`, `boss:phase`, `ui:pause` |

**Owns exclusively:** the `AudioContext`, all buses, the synthesis graph, the
generated impulse response, the voice scheduler and its cap.

**Forbidden for callers:**
- Never create an `AudioContext` or any Web Audio node outside `audio`.
- Never call an `audio` method from `fixedUpdate` — `currentTime` is wall clock.
- Never call `setListener` from anything but `player`.
- Never fetch or decode an audio file. There are none, and there will be none.

---

## 16. `save`

```
/**
 * ===========================================================================
 * SAVE — localStorage serialisation, schema versioning, slots, stash
 * ===========================================================================
 *
 * Three character slots plus one shared stash, JSON in localStorage under
 * claudo2.save.v1.*. Every write is shadow-then-swap, so a browser killed
 * mid-write never destroys a save.
 *
 * Migrations are pure JSON→JSON functions in src/save/migrations/, applied in
 * ascending order, written in the same commit as the change that requires
 * them, and covered by a committed fixture per historical version. The full
 * policy is 01-data-model.md §10.4 and it is binding.
 *
 * PUBLIC API — const save = ctx.get('save')
 * ...
 */
export class SaveSystem { static id = 'save'; static deps = ['items','player']; }
```

| Method | Signature | Fixed | Alloc |
|---|---|---|---|
| `SCHEMA_VERSION` | static property → `int` | Y | no |
| `meta` | `() => SaveMeta` | N | yes |
| `hasSlot` | `(slot:int) => boolean` | N | no |
| `load` | `(slot:int) => { ok:boolean, save:CharacterSave\|null, error:string, migratedFrom:int }` | N | yes |
| `save` | `(slot:int) => { ok:boolean, error:string, bytes:int }` | N | yes |
| `deleteSlot` | `(slot:int) => boolean` | N | no |
| `loadStash` | `() => StashSave` | N | yes |
| `saveStash` | `() => boolean` | N | yes |
| `settings` | `() => SettingsSave` | N | yes |
| `saveSettings` | `(settings:SettingsSave) => boolean` | N | no |
| `validate` | `(obj:object, version:int) => { ok:boolean, failures:string[] }` — the 15 invariants | Y | yes |
| `migrate` | `(obj:object, fromVersion:int) => { ok:boolean, obj:object, error:string }` | Y | yes |
| `quarantine` | `(slot:int, reason:string) => string` — the key the bad save was moved to | N | no |
| `setAutosave` | `(on:boolean, everySeconds:number) => void` — default `true, 60` | N | no |
| `requestAutosave` | `(reason:string) => void` — coalesced; writes at most once per second | N | no |
| `exportSlot` | `(slot:int) => string` — JSON, for bug reports and the fuzz harness | N | yes |
| `importSlot` | `(slot:int, json:string) => { ok:boolean, error:string }` | N | yes |
| `estimateBytes` | `(slot:int) => int` | N | no |

| Direction | Events |
|---|---|
| Emits | `save:written` `{ slot, bytes }`, `save:error` `{ slot, error }`, `save:migrated` `{ slot, from, to }` |
| Listens | `zone:enter`, `player:levelup`, `quest:update`, `vendor:close`, `item:identify` — each calls `requestAutosave` |

**Owns exclusively:** every `localStorage` key under `claudo2.`, the schema
version, all migrations and fixtures, the validation invariants, quarantine.

**Forbidden for callers:**
- **Never touch `localStorage` directly.** Not for settings, not for a debug
  flag, not "just this once". One writer, one namespace, one version.
- Never call `save()` from `fixedUpdate` — `JSON.stringify` over a full
  inventory is a multi-millisecond stall.
- Never bump `SCHEMA_VERSION` without a migration function and a fixture in the
  same commit. The build refuses.
- Never edit a committed fixture. It is the record of what shipped.
- Never write a save containing a `_`-prefixed cache field.

---

## Cross-cutting rules

### Determinism

Restating the contract from `ARCHITECTURE.md`, because it is the thing most
easily broken across an API boundary:

- One `ctx.rng.fork()` per subsystem, taken once in `init()`, never re-forked
  per event and never shared. The streams that matter to the harnesses are
  `items`, `world`, `ai`, `skills` and `combat`.
- Nothing called from `fixedUpdate` may read `performance.now()`, `Date.now()`,
  `dt`, the pointer position, `window.innerWidth`, or any `fx`/`ui`/`audio`
  state.
- A method marked `Fixed = N` in this document is not merely discouraged in
  `fixedUpdate` — calling it there is a determinism bug even when it appears to
  work.

**The `items` draw order.** `ARCHITECTURE.md` fixes five steps —
`base → quality → affix count → affix pick → affix values`. A real drop draws
more than five times, and `tools/lootsim.mjs` cannot reproduce a histogram
without knowing where the rest sit. The full order is contractual:

| # | Draw | Notes |
|---:|---|---|
| 1 | `nodrop` check | one draw, even when it passes |
| 2 | treasure-class pick | recursive; each level of nesting is one draw, in descent order |
| 3 | base pick | weighted by `dropWeight` over the `reqLevel ≤ ilvl` filter |
| 4 | quality roll | unique → rare → magic → superior → normal, tested in that order |
| 5 | `superior` bonus | only when quality resolved to superior |
| 6 | `defense` roll | armour only, within `[defMin, defMax]` |
| 7 | affix count | prefixes and suffixes in one draw |
| 8 | affix pick | one draw per affix, in prefix-then-suffix order, groups excluded as they are taken |
| 9 | affix values | one draw per mod, in the order `AffixDefinition.mods` lists them; `sharedRoll` affixes draw **once** and write every entry |
| 10 | unique mod values | one draw per `UniqueDefinition.mods` entry, positionally into `uniqueValues` |
| 11 | rare name | two draws, noun then adjective, both against the recent-name ring |
| 12 | ground scatter | one draw for the scatter angle, one for the radius |

Steps 1–11 come from the `items` stream. Step 12 is the only one a caller can
skip (an item created straight into a container), and skipping it must not shift
the stream — the two draws are taken and discarded.

`items.rollChest` is the single documented exception to the one-stream rule: it
takes an external `Rng` because chest contents are fixed by the chest's own `S4`
sub-seed at generation time and must not depend on how many monsters died first.

### Allocation

- Methods marked `Alloc = no` must remain so. Adding an array literal, a
  template string, a closure, a spread or a `Map` iteration that boxes an entry
  to such a method is a regression, and `tools/profile.mjs` will attribute the
  resulting GC hitch to it.
- `Alloc = pool` methods must be paired with their release. Every pool asserts
  double-release in dev builds.
- `Alloc = yes` is legal only in `init()`, on zone load, on a user action behind
  a fade, or in a headless harness.

### Event discipline

- Handlers are called **synchronously** during `emit`. A handler that emits
  re-enters the bus; keep chains at most two deep.
- Payload objects for events that fire more than once per frame
  (`actor:damage`, `combat:hit-request`, `xp:gain`) are pooled and released at
  end of step. **Copy what you need during dispatch.**
- Never `emit` from `dispose()`.
- A handler that throws is caught and logged by the bus and does not stop other
  handlers — so a silently swallowed exception is possible. Check the console
  before concluding an event "did not fire".

---

## Deviations from the plan

**D-7 — `combat` owns packet construction as well as resolution.**
See `01-data-model.md` §12 D-1. The API consequence is
`combat.buildAttackPacket()` / `buildSpellPacket()`, which `skills` and `ai`
call rather than filling a packet literal.

**D-8 — Two events not listed in `ARCHITECTURE.md`.**
`nav:rebuilt` `{ zoneId, navVersion, regionCount }` and `boss:phase`
`{ phase, actor }`. `ARCHITECTURE.md` requires a new event to be added to its
table in the same commit; both are recorded here because these specifications
must not edit that file. The first exists because `zone:ready` fires before
`nav` has finished versioning in the town case, and `ai` needs a hard edge to
invalidate paths on. The second exists because `ui`, `audio` and `fx` all need
the boss transition and polling `ai.bossPhase` every frame from three
subsystems is worse than one event. `save:written`, `save:error` and
`save:migrated` are likewise additions, scoped to diagnostics.

**D-9 — `player` owns the camera, and `ui` owns all DOM.**
`ARCHITECTURE.md` says "Nothing else may write to it — ask `player`" about the
camera but does not name a DOM owner. Naming one here prevents the classic
failure where three subsystems append to `document.body` and disagree about
z-order and pointer capture.

**D-10 — `nav.requestPath` is asynchronous.**
The plan describes an A* budget per frame. A synchronous `findPath()` cannot
honour a budget without either blocking or lying, so the API is
request/poll: `requestPath` returns an id or `0` when the budget is full, and
`ai` falls back to the flow field on `0`. This makes the budget observable
(`nav.stats.refusals`) rather than a hidden stall.
