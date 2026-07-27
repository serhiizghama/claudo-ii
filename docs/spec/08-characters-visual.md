# 08 — Characters: procedural meshes, skeletons and animation

**Owner:** `actors` (`src/actors/`)
**Consumers:** `ai`, `player`, `skills`, `combat`, `items`, `fx`
**Depends on:** `materials`, `physics`, `nav` (height queries), `render` (shadow-cascade mask)
**Status:** specification, binding. Numbers here are budgets, not suggestions.

There are no art assets. Every character mesh, every bone and every animation in
this game is produced by code before the first frame. This document defines how,
and — just as importantly — defines what we refuse to build, because the camera
cannot see it.

---

## 0. The camera is the specification

Everything below is derived from three locked numbers: **pitch 52°, vertical FOV
35°, orbit distance 22 m**. They fix the on-screen size of every character for
the entire life of the project, and that in turn fixes the geometry, texture and
animation budgets.

At 1920×1080, pixels per metre for a surface perpendicular to the view axis:

```
px_per_m(d) = 1080 / (2 · d · tan(17.5°)) = 1713.0 / d
```

A world-vertical segment is foreshortened by `cos(52°) = 0.6157`.

| quantity | value |
|---|---|
| camera height above the focal point | 22 · sin 52° = **17.34 m** |
| ground distance at the bottom screen edge (pitch 69.5°) | **18.50 m** |
| ground distance at the top screen edge (pitch 34.5°) | **30.50 m** |
| px/m at 18.50 m / 22.00 m / 30.50 m | **92.6 / 77.9 / 56.2** |
| screen height of a 1.80 m humanoid, near edge | **102.6 px** |
| screen height of a 1.80 m humanoid, far edge | **62.3 px** |
| screen width of a 0.55 m shoulder span at 22 m | **42.8 px** |
| screen height of the 2.85 m Maulsmith at 22 m | **136.7 px** |
| screen height of the 3.20 m boss at 22 m | **153.5 px** |
| **3-pixel feature threshold at the closest possible distance** | **0.032 m** |

Three consequences, and they are not negotiable.

1. **Nothing smaller than 3.2 cm gets geometry.** Fingers (1.5 cm), teeth, belt
   buckles, chain links, eyeballs, boot laces. They go into the normal map, the
   vertex colour, or nowhere. This is the direct answer to the reference
   project's *"blocky finger slabs"* failure: it was solving a problem we do not
   have, because its camera got to 0.5 m from the hands and ours never gets
   closer than 18.5 m.
2. **The distance ratio across the whole screen is 1.65 : 1.** Classic
   distance-based LOD therefore buys almost nothing (see §9.2). The LOD that
   matters is per-archetype authored density plus a count-driven pressure LOD.
3. **Surface micro-detail is invisible.** One screen pixel covers 10.8 mm of
   surface at the closest distance. The reference project's two-scale
   base+detail texture system exists to survive a 1 m close-up; we delete it and
   spend the saved boot time and memory on silhouette and value structure
   instead. This is also why its *"material richness reads as procedural noise at
   close range"* failure cannot occur here — there is no close range.

---

## 1. Approach decision

### 1.1 The three candidates

| | skinned procedural mesh | rigid-part hierarchy | baked billboard imposters |
|---|---|---|---|
| draw calls / actor | 1 | 1 (if merged as 1-bone skinning) or 8–14 (if separate meshes) | 1, and instanceable to 1 per archetype |
| joint quality at 62–103 px | continuous | visible 1–2 px gap or interpenetration at shoulder/hip; unusable for the Emberwright's robe and the Shaman's floor-length skirt | n/a |
| dynamic light + shadow | full | full | flat; loses the per-zone lighting mood the plan builds its art direction on |
| 4 visible equipment slots | rebuild geometry once per equip (3.5 ms) | same | **impossible** — helm × chest × weapon × shield × 5 rarities is a combinatorial atlas |
| champion / unique variants | uniform change, free | uniform change, free | rescale only; no aura recolour without a second atlas |
| per-frame CPU at 26 actors | 0.55 ms (measured estimate, §9.4) | 0.40 ms | 0.05 ms |
| VRAM | 5.3 MB shared | 5.3 MB shared | 63–94 MB of atlas |
| implementation risk | **medium** — binder and blend tree are the only novel parts, both bounded | low | **high** — the offscreen bake pipeline, the atlas packer, the direction/frame selection and the lighting mismatch are four separate systems, all of which must work before anything is on screen |

Note the second row of the first column pair: a rigid-part hierarchy expressed as
skinning with one bone per vertex costs *exactly the same* as smooth skinning on
the GPU — Three's skinning chunk is an unrolled 4-tap loop either way. Rigid
parts are therefore a strict subset of skinning, not a cheaper alternative. There
is no performance argument for choosing them; there is only a quality argument
against.

### 1.2 Decision

**Skinned procedural meshes.** One `THREE.SkinnedMesh` per actor, one shared
`BufferGeometry` per (archetype, LOD, equipment-hash), one `THREE.Skeleton` per
actor instance.

The deciding facts:

- Characters are **1.2 % of the scene triangle budget** (31 k of 2.5 M, §9.1).
  Geometry is not the constraint, so the cheapest-geometry options buy nothing.
- The plan locks *four visible equipment slots on the player*. Imposters cannot
  do it; that alone eliminates them as the primary path.
- At 62–103 px the visible cost of rigid-part joints is 1–2 px of seam — but the
  Emberwright, the Dust Shaman and the boss all have floor-length cloth whose
  entire read is a continuous deforming surface. Two of six monster types and one
  of three classes are unbuildable as rigid parts.
- The skinning work that remains is two bounded algorithms (a distance-based
  binder, §3.5; a layered blend tree, §5). Both have known-good reference
  implementations we have read.

Rigid-part construction is still used *inside* the skinned mesh: helms, shields,
pauldrons, weapon heads and skull plates are bound to a single bone at weight 1
(§3.5 step 1). We get the rigid-part cost profile for the parts that want it,
inside one draw call, with smooth skin everywhere else.

### 1.3 Hard opt-out: the Carrion Swarm

The Carrion Swarm spawns 6–10 at a time and is 0.85 m tall (≈ 52 px). It carries
no equipment, has no champion variant, and its whole behavioural read is "a
scuttling mass". It gets a separate path from M5 onward:

**Vertex-animated instanced quadruped.** No skeleton. One `THREE.InstancedMesh`,
one 260-triangle geometry, per-instance attributes `aPhase` (float, gait phase),
`aState` (float, 0 = alive, 0…1 = death collapse, 2 = lunge), `aScale`. The
gallop, the body roll, the head bob and the death collapse are computed in the
vertex shader from `aPhase`, `aState` and a per-vertex "spine parameter" stored
in `uv.y` (0 at the nose, 1 at the tail tip).

Result: **the entire swarm is one draw call** and costs nothing on the CPU.
Fallback if the vertex-shader gait is not convincing by the end of M5: the swarm
uses the 16-bone quadruped rig (§2.3) at lean density — costs 10 more draw calls
and 0.19 ms, both of which fit inside the budget in §9.

### 1.4 Fallback path and its exact trigger

The fallback is **baked octahedral imposters for the Bone Ranker and the Carrion
Swarm only** — never the player, never the boss, never any archetype with a
telegraph. Bake at boot from the same procedural mesh under the same lights:
8 facing directions × 3 states (idle / run / attack) × 8 frames at 64×128 RGBA
= 4.7 MB per archetype, 9.4 MB total. Champion and unique variants remain
skinned, so the aura and scale rules survive.

**Trigger — all of the following must hold, measured, twice:**

| # | condition | tool |
|---|---|---|
| T1 | `profile.mjs`, `high` preset, `dense-combat` shot (26 live actors, 12 corpses) reports **character CPU p95 > 2.4 ms** | `tools/profile.mjs` |
| T2 | …or total frame p95 > 20.0 ms **and** character work is attributed > 25 % of the frame | `tools/profile.mjs` |
| T3 | the condition survives two consecutive optimisation attempts, each landing at least one of: rig reduction (§1.5), animation rate halving, LOD pressure widening | changelog |

If T1/T2 still fail after the imposter swap, the next and final step is a
**design** change, not a technology change: `q.maxActors` on `high` drops from 44
to 30 and the pack-size table in the AI spec is re-tuned.

### 1.5 Earlier, cheaper escape hatch

At the end of implementation step 6 (§11), a Node harness measures pose + skeleton
cost at 26 actors. If it exceeds **1.5 ms**, the humanoid rig drops from 24 bones
to 16 by deleting `ClavicleR/L`, `WeaponR`, `ShieldL`, `Neck` and the two cloak
bones (weapon and shield become bone-space offsets on `HandR` / `ForearmL`;
`Neck` folds into `Head`). This is a 33 % cut in pose cost and costs us the
shoulder-pull component of the attack telegraph, which is the least valuable of
the three telegraph channels (§6.4). Take this before considering imposters.

---

## 2. Skeletons

### 2.1 Conventions

Authored in metres, in the actor's bind space, **feet on y = 0, character facing
+Z**. Y is up, right-handed, so the character's own **right** is at negative X.
Every `*R` bone has x < 0. Getting this backwards puts the shield on the sword
arm; the rig self-test in §11 step 1 asserts it.

Bone axis convention, matched by every clip and every IK solver:

- local **+Y runs down the bone** toward its primary child
- local **+Z points roughly forward** (the "up hint" resolves the twist)
- pose deltas are **euler degrees, XYZ order**, meaning
  **x = flexion** (positive bends forward: knee extends, spine bows),
  **y = twist** (roll about the bone's own length),
  **z = lateral** (positive tips toward the character's right)

Only local rest *offsets* are authored. Rest *rotations* are derived: aim +Y at
the primary child (or along an explicit leaf direction for leaves), then resolve
the remaining roll from the per-bone up hint. Local transforms come from the
world bind transforms by

```
localPos[i]  = inverse(bindQuat[parent]) · (bindPos[i] − bindPos[parent])
localQuat[i] = inverse(bindQuat[parent]) ·  bindQuat[i]
```

### 2.2 The bind pose is a guard stance, not a T-pose

Linear blend skinning degrades with the angle between the bind pose and the
played pose. A T-pose forces every shoulder weight to survive a 90° rotation,
which is exactly where the classic candy-wrapper collapse comes from. The bind
pose is therefore an actual combat idle: feet 0.18 m apart, knees flexed 16.7°,
elbows flexed 16.1°, weapon hand forward and low, shield forearm angled across
the body. Every pose we ever play is within **72°** of it on every bone.

### 2.3 Humanoid rig — 24 bones

Reference height **H = 1.80 m**. Segment lengths: upper arm 0.270, forearm
0.240, hand 0.080, thigh 0.4285, shin 0.4308, ankle height 0.090. All non-boss
humanoids are this rig, uniformly scaled by the archetype's `heightScale` and
non-uniformly widened by `bulk` on X and Z (§3.3).

| # | bone | parent | world bind pos (m) | up hint | exists because |
|---:|---|---|---|---|---|
| 0 | `Root` | — | (0, 0, 0) | (0,0,1) | actor origin; foot-IK pelvis drop and boss levitation write here, never to the world transform |
| 1 | `Hips` | `Root` | (0, 0.955, 0.000) | (0,0,1) | pelvis bob, roll and counter-yaw — the base of every gait read |
| 2 | `Spine` | `Hips` | (0, 1.105, −0.010) | (0,0,1) | lower torso bow; carries the wind-up wind and the hit fold |
| 3 | `Chest` | `Spine` | (0, 1.300, 0.005) | (0,0,1) | upper torso twist; parent of both clavicles and of the cloak chain |
| 4 | `Neck` | `Chest` | (0, 1.455, −0.010) | (0,0,1) | half of the look-at chain; the head must lead a turn or the actor reads as a mannequin |
| 5 | `Head` | `Neck` | (0, 1.560, 0.005) | (0,0,1) | helm socket, look-at, glow-mask eye sockets |
| 6 | `ClavicleR` | `Chest` | (−0.040, 1.415, 0.015) | (0,1,0) | shoulder pull-back is 40 % of the readable attack wind-up at 90 px |
| 7 | `UpperArmR` | `ClavicleR` | (−0.170, 1.410, 0.000) | (0,0,1) | — |
| 8 | `ForearmR` | `UpperArmR` | (−0.196, 1.148, 0.055) | (0,0,1) | — |
| 9 | `HandR` | `ForearmR` | (−0.210, 0.925, 0.135) | (0,0,1) | mitten form + spell FX socket |
| 10 | `WeaponR` | `HandR` | (−0.216, 0.860, 0.180) | (0,0,1) | weapon geometry binds here rigidly; lets the inertia spring overshoot the blade without dragging the wrist |
| 11 | `ClavicleL` | `Chest` | (0.040, 1.415, 0.015) | (0,1,0) | mirror of 6 |
| 12 | `UpperArmL` | `ClavicleL` | (0.170, 1.410, 0.000) | (0,0,1) | — |
| 13 | `ForearmL` | `UpperArmL` | (0.196, 1.143, 0.030) | (0,0,1) | — |
| 14 | `HandL` | `ForearmL` | (0.104, 0.975, 0.172) | (0,0,1) | forearm crosses the body in bind; grip bar of the shield |
| 15 | `ShieldL` | `ForearmL` | (0.155, 1.055, 0.105) | (0,0,1) | a strapped shield rides the forearm, not the palm — binding it to `HandL` makes the block pose look like a held tray |
| 16 | `UpLegR` | `Hips` | (−0.090, 0.940, 0.000) | (0,0,1) | — |
| 17 | `LegR` | `UpLegR` | (−0.095, 0.515, 0.055) | (0,0,1) | — |
| 18 | `FootR` | `LegR` | (−0.100, 0.090, −0.015) | (0,1,0) | ankle; foot roll to the ground normal. No toe bone — a toe is 6 px |
| 19 | `UpLegL` | `Hips` | (0.090, 0.940, 0.000) | (0,0,1) | — |
| 20 | `LegL` | `UpLegL` | (0.095, 0.515, 0.055) | (0,0,1) | — |
| 21 | `FootL` | `LegL` | (0.100, 0.090, −0.015) | (0,1,0) | — |
| 22 | `Cloak0` | `Chest` | (0, 1.340, −0.105) | (0,0,1) | optional; robe/cloak spring chain |
| 23 | `Cloak1` | `Cloak0` | (0, 1.000, −0.145) | (0,0,1) | optional; the hem |

**Required core: 22.** Bones 22–23 are omitted for archetypes with no cloth
chain (Bone Ranker, Ashen Archer, Maulsmith). Derived values: eye height
1.660 m, shoulder span 0.340 m, `HeadTop` (leaf stub, not a bone) at 1.800 m.

**Explicitly rejected bones and why:**

| rejected | count saved | screen size of what it would drive |
|---|---:|---|
| fingers (3 per hand × 2) | 6 | a finger is 1.4 cm = **1.3 px** |
| toes | 2 | a toe is 4 cm at a 40° foreshortening = **2.3 px** |
| third spine segment | 1 | adds 4° of extra bow that is < 1 px of silhouette change |
| twist bones (forearm/thigh) | 4 | our forearm never twists past 55°; the joint clamp in §3.5 step 4 covers it |
| jaw | 1 | invisible at 62–103 px; monster vocalisation is audio-only |
| eye bones | 2 | eyes are a glow mask, not geometry |

### 2.4 Quadruped rig — 16 bones (Carrion Swarm, skinned fallback only)

Reference length 1.15 m nose-to-tail, shoulder height 0.55 m, total silhouette
height 0.85 m with the head raised.

| # | bone | parent | world bind pos (m) | exists because |
|---:|---|---|---|---|
| 0 | `Root` | — | (0, 0, 0) | actor origin |
| 1 | `Hips` | `Root` | (0, 0.500, −0.280) | rear body; carries the gallop's vertical bob |
| 2 | `Spine` | `Hips` | (0, 0.520, −0.050) | the arch — the whole "scuttle" read is spine flexion |
| 3 | `Chest` | `Spine` | (0, 0.530, 0.190) | fore body |
| 4 | `Head` | `Chest` | (0, 0.560, 0.400) | lunge and bite |
| 5 | `TailA` | `Hips` | (0, 0.480, −0.470) | counterweight; sells the direction change |
| 6 | `TailB` | `TailA` | (0, 0.430, −0.640) | spring-driven whip |
| 7 | `FRA` | `Chest` | (−0.135, 0.470, 0.290) | front-right upper |
| 8 | `FRB` | `FRA` | (−0.150, 0.230, 0.320) | front-right lower |
| 9 | `FLA` | `Chest` | (0.135, 0.470, 0.290) | — |
| 10 | `FLB` | `FLA` | (0.150, 0.230, 0.320) | — |
| 11 | `BRA` | `Hips` | (−0.140, 0.470, −0.330) | back-right upper |
| 12 | `BRB` | `BRA` | (−0.155, 0.225, −0.365) | back-right lower |
| 13 | `BLA` | `Hips` | (0.140, 0.470, −0.330) | — |
| 14 | `BLB` | `BLA` | (0.155, 0.225, −0.365) | — |
| 15 | `Maw` | `Head` | (0, 0.520, 0.500) | the only articulated head part; opens 34° on the bite, a 5 px change on a 52 px creature but it is on the silhouette edge |

No feet bones: a 3 cm paw is 2.8 px, and the ground contact is carried by the
contact-occlusion sprite (§4.6).

### 2.5 Crawler rig — 12 bones (Blight Crawler)

A pressurised sac on six stubby legs, 1.10 m tall, 0.90 m wide.

| # | bone | parent | world bind pos (m) | exists because |
|---:|---|---|---|---|
| 0 | `Root` | — | (0, 0, 0) | actor origin |
| 1 | `Body` | `Root` | (0, 0.520, 0.000) | the scuttle bob and the death lurch |
| 2 | `Sac` | `Body` | (0, 0.640, −0.060) | **scaled**, not rotated: the prime-to-detonate swell drives `Sac.scale` from 1.00 to 1.35 |
| 3 | `Head` | `Body` | (0, 0.500, 0.360) | a blind proboscis; points at the target |
| 4–9 | `LegA`…`LegF` | `Body` | ring of six at radius 0.335, y 0.300, at 0°, 60°, …, 300° from +Z | one bone each; the leg is a rigid 0.35 m taper. Six legs at 60° spacing is the cheapest thing that does not read as a quadruped |
| 10 | `ArmL` | `Body` | (0.300, 0.560, 0.190) | grasping claw, raised on the prime — a silhouette spike |
| 11 | `ArmR` | `Body` | (−0.300, 0.560, 0.190) | mirror |

`Sac` is the only bone in the project that carries a non-unit scale. The binder
(§3.5) allows it because the sac's vertices are bound to `Sac` at weight 1 —
scale on a shared bone would tear the skin.

### 2.6 Boss rig — 26 bones (Molgrim)

Humanoid 24 (with cloak) + `Cloak2` (a third mantle segment, parent `Cloak1`, at
(0, 0.640, −0.170)) + `Tome` (parent `Chest`, at (0.380, 1.480, 0.220)) — a
floating grimoire that orbits the boss on a spring and becomes the phase-III
meteor origin. Reference height 3.20 m; the humanoid rig is scaled 1.778× and
widened `bulk = 1.35`.

### 2.7 Bone count summary

| rig | bones | actors using it | skeleton bytes / frame |
|---|---:|---|---:|
| humanoid | 22–24 | 3 player classes, Ranker, Archer, Shaman, Maulsmith, all champions/uniques | 1 536 |
| quadruped | 16 | Carrion Swarm (skinned fallback only) | 1 024 |
| crawler | 12 | Blight Crawler | 768 |
| boss | 26 | Molgrim | 1 664 |

Three uploads one bone texture per skeleton per frame. Worst case, 26 humanoid
skeletons = **40 KB / frame**. Not a concern.

---

## 3. Mesh construction

### 3.1 Primitive toolkit (`src/actors/geo.js`)

One lofting core builds everything, so the vertex layout, the UV convention and
the normal handling are identical across every part.

| function | signature | used for |
|---|---|---|
| `loft(rings, opts)` | rings of equal point count, optional caps | the core; everything below calls it |
| `tube(points, profileFn, opts)` | tapered tube along a polyline with parallel-transport frames | limbs, torso, neck, tails, robe sleeves |
| `revolve(profile, seg)` | 2D `[r, y]` profile about +Y | helms, bowls, spikes, the Crawler sac |
| `ellipsoid(rx, ry, rz, {v0, v1})` | latitude-clamped | skulls, shoulder caps, sacs |
| `boxRound(hx, hy, hz, {n, roundY})` | superellipse rings under a rounding envelope | cuirasses, shields, hammer heads, hands, feet |
| `ribbon(points, w, t, {upright})` | flat extrusion along a polyline | straps, robe hems, cloaks, bowstrings, quiver slings |
| `spineRow(path, n, scaleFn)` | `n` tapered cones distributed along a path | bone spikes, ribs, crowns |
| `superEllipse(rx, rz, n, seg)` | ring generator, `n = 2` ellipse, `n ≥ 6` rounded box | profile source for all of the above |

Mesh records are plain flat arrays `{ p[], n[], uv[], i[] }` — no GPU resources
until `build()`. Nothing in this file runs per frame.

Post-ops: `computeNormals`, `weldNormals(eps = 1e-4)` (so smooth normals cross
loft seams), `displace(fn)` (normal-direction noise for bone pitting and cloth
folds), `warp(fn)`, `transformMesh(m)`, `mirrorX`, `appendMesh`.

### 3.2 Part list — the shared humanoid kit

Triangle count for a loft = `(rings − 1) · seg · 2`; caps add `seg` each.

| part | primitive | dense (rings × seg) | tris | lean (rings × seg) | tris |
|---|---|---|---:|---|---:|
| torso | `tube` | 8 × 12 | 168 | 6 × 10 | 100 |
| pelvis | `tube` | 4 × 12 | 72 | 3 × 10 | 40 |
| arm ×2 | `tube` | 8 × 8 | 224 | 6 × 6 | 120 |
| shoulder cap ×2 | `ellipsoid` | 5 × 10 | 160 | 4 × 8 | 96 |
| hand (mitten) ×2 | `boxRound` + thumb ridge | 4 × 6 | 96 | 3 × 6 | 72 |
| leg ×2 | `tube` | 9 × 9 | 288 | 7 × 8 | 192 |
| foot ×2 | `boxRound` | 4 × 6 | 96 | 3 × 6 | 72 |
| neck | `tube` | 3 × 8 | 32 | 2 × 8 | 16 |
| head / skull | `ellipsoid` | 8 × 12 | 168 | 6 × 10 | 100 |
| **body subtotal** | | | **1 304** | | **808** |

The hand is **one closed mitten volume plus a single thumb ridge, 48 triangles**.
No finger geometry exists anywhere in this project. At 92.6 px/m a hand is
9.3 × 5.1 px.

### 3.3 Per-archetype geometry

`heightScale` scales the whole rig uniformly; `bulk` widens X and Z only.

| archetype | height (m) | heightScale | bulk | density | kit parts added | L0 tris | L1 tris | rig |
|---|---:|---:|---:|---|---|---:|---:|---|
| Ravager | 1.85 | 1.028 | 1.14 | dense | cuirass, 2 pauldrons, helm, 2 greaves, tabard ribbon, weapon, shield | **2 100** | 940 | humanoid 22 |
| Emberwright | 1.80 | 1.000 | 0.94 | dense | robe skirt (6×14 tube), hood revolve, sleeve flares, cloak chain, staff | **1 850** | 830 | humanoid 24 |
| Runeblade | 1.82 | 1.011 | 1.02 | dense | half-plate, single pauldron, open helm, cloak chain, sword, offhand focus | **1 950** | 880 | humanoid 24 |
| Bone Ranker | 1.70 | 0.944 | 0.78 | lean | rib cage `spineRow`, skull-with-jaw, kite shield, notched blade, hip rags | **1 150** | 520 | humanoid 22 |
| Ashen Archer | 1.75 | 0.972 | 0.80 | lean | 1.50 m recurve bow arc + string ribbon, back quiver, hood, wrapped legs | **1 080** | 490 | humanoid 22 |
| Dust Shaman | 1.80 | 1.000 | 0.86 | lean | floor robe (7×16, hem radius 0.35 m), horned crown `spineRow`, staff, 2 hanging fetish ribbons | **1 290** | 580 | humanoid 24 |
| Maulsmith | 2.85 | 1.583 | 1.62 | dense | asymmetric shoulder slab (R only), 2-segment hammer haft, 0.75 × 0.50 m head, chain skirt | **2 050** | 920 | humanoid 22 |
| Blight Crawler | 1.10 | — | — | lean | sac `revolve` (7 × 14), 6 leg tapers, proboscis, 2 claw arms | **760** | 340 | crawler 12 |
| Carrion Swarm | 0.85 | — | — | far | body tube 6 × 8, 4 leg tapers 3 × 5, head, tail ribbon | **260** | 150 | none / quad 16 |
| Molgrim | 3.20 | 1.778 | 1.35 | dense | 3-segment mantle, crowned skull, 2 pauldron slabs, floating tome, greatstaff, chain-of-keys ribbon | **3 400** | 1 530 | boss 26 |

L1 is not decimated. It is **rebuilt from the same part list at 0.7× rings and
0.7× segments** (≈ 0.49 of the triangles) and re-bound. This buys us the whole
LOD system for the cost of one parameter and zero new algorithms.

### 3.4 Merging: one geometry, one group, one draw

Every part is concatenated into a single interleaved `BufferGeometry` with **no
geometry groups at all**, because every character shares one material (§4). The
per-part surface difference lives in a vertex attribute instead.

The reference project used nine material groups per soldier — nine draw calls per
actor. At 26 actors that is 234 draws before shadows, which is over the whole
scene budget by itself. Collapsing to one is the single most valuable structural
change we make.

Vertex layout, **48 bytes**:

| attribute | type | bytes | meaning |
|---|---|---:|---|
| `position` | `float32 × 3` | 12 | metres, bind space |
| `normal` | `float32 × 3` | 12 | welded across loft seams |
| `uv` | `float32 × 2` | 8 | metres of surface ÷ `TILE` (§3.6) |
| `color` | `uint8 × 3` norm | 3 (+1 pad) | baked grime / dirt / wear tint, multiplied into albedo |
| `aSurf` | `uint8 × 4` **non-normalised** | 4 | see below |
| `skinIndex` | `uint8 × 4` | 4 | bone indices |
| `skinWeight` | `uint8 × 4` norm | 4 | sums to exactly 255 after quantisation |

```
aSurf.x  bits 0-3 : surface layer index (0..5 used, 0..15 reserved)
         bit  4   : trim mask  -> tinted by uTrimTint, lit by uTrimEmissive
         bit  5   : glow mask  -> emissive uGlow (eye sockets, runes, fissures)
         bits 6-7 : reserved, must be 0
aSurf.y  roughness multiplier   (/255)
aSurf.z  metalness multiplier   (/255)
aSurf.w  baked ambient occlusion (/255) — applied to INDIRECT light only
```

A 900-vertex archetype geometry is 43 KB. Ten archetypes × 2 LODs ≈ **0.9 MB**
of geometry for the entire cast.

### 3.5 Skin weight assignment — the algorithm

Constants:

```
K        = 3.2      // inverse-distance exponent
D_MIN    = 0.012    // m, distance floor (a vertex on the bone axis stays finite)
W_CUT    = 0.06     // influences below W_CUT · w_max are dropped
JOINT_R  = 0.050    // m, radius around a shared joint where weights are forced 50/50
SMOOTH_N = 2        // Laplacian smoothing iterations
WELD_EPS = 0.001    // m, cross-part seam weld radius
```

Each part declares either `bone: 'Name'` (rigid) or
`bones: [names], bias: [floats]` (smooth). The bias vector is authored — it is
how a sleeve is told that the shoulder matters more than the chest even though
the chest bone segment is closer to some of its vertices.

**Step 1 — rigid parts.** Any part with `bone` set: `skinIndex = [b,0,0,0]`,
`skinWeight = [1,0,0,0]`. Skip steps 2–5. Rule of thumb, and it is a rule: any
part whose material layer is `metal` or `bone` and whose bounding box is under
0.30 m is rigid. That covers every helm, pauldron, shield boss, weapon head,
buckle-scale detail and skull plate.

**Step 2 — inverse-distance weights.** For vertex `v` and candidate bone `c`:

```
d_c = distancePointSegment(v, bindPos[c], tail[c])
w_c = bias[c] / max(d_c, D_MIN)^K
```

`tail[c]` is the bone's end: the primary child's bind position, or a 0.075 m stub
along the leaf direction.

**Step 3 — prune and normalise.** Keep the 4 largest. Drop any with
`w < W_CUT · w_max`. Renormalise to sum 1. The prune is what stops a single
shoulder-pad vertex from being grabbed by the head bone and shooting off during a
look-at.

**Step 4 — joint clamp.** If `v` lies within `JOINT_R` of the shared endpoint of
two candidate bones in a parent/child relation, force those two weights to
0.5 / 0.5 and zero the rest. This is the fix for elbow and knee volume collapse:
a ring of vertices at exactly 50/50 rotates rigidly about the joint bisector and
preserves its cross-section.

**Step 5 — Laplacian smoothing.** Build the part's vertex adjacency once from its
index buffer. For `SMOOTH_N` iterations, over the union of candidate bones:

```
w'_v = 0.5 · w_v + 0.5 · mean(w_u for u adjacent to v)
```

then renormalise. Skip vertices clamped in step 4 and all rigid parts. This is
the fix for faceted deformation — inverse-distance weights alone produce visible
per-triangle creasing at the hip, which reads as a broken hinge even at 62 px.
Cost: ~1 ms per archetype at boot.

**Step 6 — cross-part seam weld.** After every part is bound, hash all vertices
into a 1 mm grid. Any set of coincident vertices (sleeve meets glove, cuirass
meets torso, robe meets skirt) has its weight vectors **averaged and
renormalised**, so the parts can never split apart under deformation. The
reference project omitted this and paid for it with visible gaps at the collar.

**Step 7 — quantise.** Multiply by 255, round, then add the residual
`255 − Σ` to the largest component so the quantised weights sum to exactly 255.

**Validation** (`tools/rigcheck.mjs`, step 3 of §11):

| check | threshold |
|---|---|
| weights sum to 1 | ± 1e-5 before quantisation, exactly 255 after |
| no influence below the cut | 0 violations |
| candy-wrapper test: bend the elbow 90°, measure the convex-hull area of the vertex ring nearest the joint, projected onto the bisecting plane | **loss < 12 %** vs bind |
| knee, same test | loss < 12 % |
| no vertex bound to a bone more than 0.45 m away in bind pose | 0 violations |

### 3.6 UVs

`TILE = 0.90 m`. UVs are written in **metres of surface** and divided by `TILE`
at build time, so a texel is the same physical size on a boot, a sleeve and a
shield without any per-part tuning.

- Loft: `u` = cumulative arc length around the ring, `v` = cumulative path length
  along the loft. The seam column is duplicated so the wrap does not smear.
- Revolve: `u` = ring arc length, `v` = profile arc length.
- Caps: planar projection in metres, centred on the cap.
- **Per-part jitter**: each part adds a deterministic `(rng.range(0,1),
  rng.range(0,1))` offset, so the left and right boot never show the same texel
  pattern. Drawn from the geometry RNG fork, never the runtime one.
- Mirrored parts (`mirrorX`) leave UVs untouched. Three derives tangents from
  screen-space derivatives when `USE_TANGENT` is undefined, which handles the
  handedness flip automatically. Do not add a tangent attribute.

There is **no unwrap, no chart packing and no atlas**. Each surface lives in its
own layer of an array texture (§4.1), each layer tiles seamlessly with itself,
and the layer is chosen per vertex by `aSurf.x`. This is the whole reason one
material can dress the entire cast.

Why 0.90 m and not the reference's 0.15–0.42 m: at 92.6 px/m a 0.90 m tile has an
on-screen period of 83 px, so its macro variation is visible across a body; at
256² per layer that is 284 texels/m against 92.6 screen px/m, a 3.07 : 1 ratio
that lands near mip 1.6 — properly sampled, not wasted. A 0.35 m tile at 256²
would be 7.9 : 1, three mip levels of pure waste.

### 3.7 Baked vertex shading

Each archetype declares 8–14 **occluder capsules** `{a, b, r, k}` — torso core,
chest plate, helm interior, brim, armpits, belt line, strap crossings, knees,
elbows, ankle cuffs. During `build()`:

```
ao = Π over capsules of ( 1 − 0.45 · w )
     w = (1 − clamp(max(0, d − r) / 0.09, 0, 1)) · max(0, n · toCapsule) · k
```

The result goes in `aSurf.w` and is applied to **indirect light only** in the
shader patch, injected after `<lights_fragment_begin>`:

```glsl
irradiance    *= vAO;
iblIrradiance *= vAO;
radiance      *= mix(1.0, vAO, 0.6);
```

This is the physically correct place for it, and it matters more here than it did
in the reference: because characters are excluded from the depth prepass (§9.3)
there is no GTAO on them, so `aSurf.w` is the *only* occlusion the body gets.

Separately, the vertex `color` attribute carries **grime, ground dirt, settled
dust and edge wear**, computed from the same AO term plus fbm noise, exactly as in
the reference — cavity grime pulls toward a dark warm neutral, ground dirt toward
pale ash below y = 0.55 m, dust on up-facing normals, edge wear on outward-facing
high parts. These are albedo modifiers and belong in `color`, not in `aSurf.w`.
Per-part strengths (`grime`, `dirt`, `dust`, `wear`, each 0…1) are authored on
the part.

### 3.8 Silhouette differentiation at 20 m

At 62–103 px the outline is the entire read. Each archetype gets **exactly three
silhouette claims**; nothing else may break the outline. Claims are chosen so no
two archetypes share more than one.

| archetype | on-screen at 22 m (w × h px) | claim 1 | claim 2 | claim 3 |
|---|---|---|---|---|
| Bone Ranker | 40 × 81 | kite shield 0.55 × 0.42 m held at chest height, 34 % of outline area | limbs at radius 0.045 m — half the player's 0.090 m; a visibly *thin* figure | notched blade held low and back, a 0.70 m diagonal |
| Carrion Swarm | 90 × 41 | quadruped: aspect ratio **2.2**, unique in the cast | body below human knee height | arched spine + whipping tail, 1.15 m of horizontal outline |
| Ashen Archer | 63 × 84 | 1.50 m recurve bow arc held vertically off the left side — a thin arc no other unit has | quiver rising 0.30 m above the shoulder line | asymmetric: right arm extended forward on the draw |
| Dust Shaman | 55 × 86 | floor-length robe: **base 0.70 m wide, wider than the shoulders** — the only unit shaped like a triangle standing on its base | horned crown, 0.42 m spread | no visible legs, ever |
| Maulsmith | 93 × 137 | 2.4× the pixel area of any other monster | asymmetric hunch: right shoulder 0.18 m above the left | hammer head 0.75 × 0.50 m, a solid rectangle on the outline |
| Blight Crawler | 70 × 53 | the only **round** outline: sac Ø 0.80 m | six radial legs, a spiked ring at the base | swells to 1.35× while priming — the outline itself is the telegraph |

**Gate — `tools/silhouette.mjs`.** Renders each archetype to a 1-bit mask at the
canonical camera, 22 m, three yaw angles (0°, 45°, 90°). For every pair:

- normalised-area IoU after centroid alignment must be **< 0.55**, and
- at least one of {aspect ratio, pixel area, outline convexity} must differ by
  **≥ 25 %**.

Non-zero exit blocks the build. This runs from M5 onward.

### 3.9 The anti-mannequin rules

The reference project's honest failure was *"enemies read as mannequins at
distance"*. These six rules are our answer, and every one is measurable.

| # | rule | number |
|---|---|---|
| 1 | No feature under the pixel threshold gets geometry | 0.032 m |
| 2 | Three silhouette claims per archetype, no more | §3.8 |
| 3 | Mandated three-band value structure per archetype | high : mid : low ≥ **2.4 : 1.4 : 1** in linear albedo (§4.3) |
| 4 | Motion never stops. Every state carries the breath/idle additive | ≥ **0.25** weight in every state including `block.hold` and `stun` |
| 5 | Per-instance desync is mandatory | `phaseOffset ∈ [0,1)`, `rateJitter ∈ [0.93, 1.07]`, `scaleJitter ∈ [0.94, 1.06]`, `hueJitter = ±0.04` — all drawn at spawn from the `actors` variation stream |
| 6 | Contact occlusion always on, rim separation always on | body ellipse + one lobe per foot; Fresnel rim ≥ 0.30 intensity |

**Gate — `tools/mannequin.mjs`.** Captures two frames 0.50 s apart of a pack of
10 Rankers at rest (state `idle`, no target). At least **22 %** of the pixels
covered by characters must have changed. A pack of mannequins scores 0 %; a pack
animating in lockstep scores high but fails a second assertion: the pairwise
cross-correlation of the 10 actors' `Chest` world quaternions over 2 s must be
**< 0.30**.

---

## 4. Material and colour

### 4.1 One material family, four programs, for the whole cast

The plan's render notes are blunt about shader permutations: every extra program
is a 640–900 ms compile hitch if it lands mid-play. The character system
therefore owns exactly **four programs**, all compiled during prewarm:

| # | program | why it is distinct |
|---|---|---|
| 1 | skinned opaque, world scene | the main character program |
| 2 | skinned opaque, UI scene | `outputColorSpace` and `toneMapping` are part of Three's cache key and are read from the *currently bound* target — the paperdoll and the rotating item preview need their own compile |
| 3 | batched opaque, world scene | `USE_BATCHING` is a define; corpses live in a `BatchedMesh` |
| 4 | stock skinned depth | cascade shadow rendering; already in `render`'s set, we just make sure it is warmed with our attribute layout |

Everything else — faction, champion, unique, affix, rarity, hit flash, dissolve —
is a **uniform**, never a define.

**Per-actor material instances, one shared program.** Each live actor and each
archetype template gets its own `MeshStandardMaterial` instance, cloned from one
template. Three keys its program cache on shader source + defines + attribute
set, all of which are identical, so N material instances collapse to 1 program.
We use instances rather than one shared material with per-draw uniform pokes
because Three's uniform refresh path for `onBeforeCompile`-injected uniforms is
guarded by `refreshMaterial`, and relying on it firing every draw is a bug
waiting to happen. 26 live + 12 corpse + 10 template = **48 material instances**,
allocated once at boot, pooled and recycled.

**Acceptance test, run in CI:** spawning 25 actors including 4 champions and
2 uniques must leave `renderer.info.programs.length` unchanged. Any increase is a
build failure.

### 4.2 Surface array textures

`materials` owns texture generation (ownership rule 1 — `actors` must not build
these itself). Required addition to the `materials` public API:

```js
materials.characterSurfaces()
// -> { albedo: DataArrayTexture, normal: DataArrayTexture, orm: DataArrayTexture }
```

One set, shared by every character in the game.

| layer | name | ARCHITECTURE.md surface tag | content |
|---:|---|---|---|
| 0 | `bone` | `bone` | porous calcified surface, hairline cracks, ash staining in the pits |
| 1 | `cloth` | `flesh` | coarse woven wrap, 2 cm weave, frayed noise, damp patches |
| 2 | `metal` | `metal` | pitted wrought iron, forge hammer facets, rust bloom in crevices |
| 3 | `hide` | `flesh` | cured leather, stretch marks, edge polish |
| 4 | `ash` | `ash` | compacted ash crust, fine crazing, a matte 0.94 roughness floor |
| 5 | `crystal` | `crystal` | fractured runestone, internal facets, low roughness |

Format and size:

| map | format | size | mips | bytes |
|---|---|---|---|---:|
| albedo | RGBA8 | 256 × 256 × 6 | yes | 2.10 MB |
| normal | RG8 (Z reconstructed) | 256 × 256 × 6 | yes | 1.05 MB |
| ORM | RGBA8 (occl/rough/metal/height) | 256 × 256 × 6 | yes | 2.10 MB |
| | | | **total** | **5.25 MB** |

Sampling is `texture(tAlbedo, vec3(vUv, vLayer))` with `vLayer` a `flat` varying
decoded from `aSurf.x`. `RepeatWrapping` works natively per layer, so there is no
atlas seam, no `fract`, no `textureGrad` workaround and no bleed guard band.

**There is no detail layer.** One screen pixel is 10.8 mm at the closest
distance; a 1.5 mm weave cannot be resolved. Deleting the reference project's
second texture scale saves 5.3 MB, one texture unit, four ALU ops per fragment
and about 90 ms of boot.

### 4.3 Palettes

Linear albedo, post-vertex-tint. The scale is set by the environment, not by
physical accuracy — the reference project's most expensive lesson was that a
physically honest albedo standing in a scene whose effective albedo is 0.05–0.09
reads as a white mannequin. Our zones are ash and stone at 0.06–0.12, so
characters live in **0.034–0.240** and the *hierarchy* is what carries the read.

**Undead (Bone Ranker, Ashen Archer, Dust Shaman, Carrion Swarm, Molgrim)**

| band | element | linear RGB | ratio to low |
|---|---|---|---:|
| high | bleached bone: skull, rib cage, forearms | 0.185, 0.176, 0.152 | 4.3 |
| mid | tattered wrap, robe, hide | 0.082, 0.074, 0.062 | 1.9 |
| low | pitted iron: shield, blade, helm | 0.043, 0.044, 0.048 | 1.0 |
| accent | ember in the eye sockets (glow mask) | emissive 2.4, `#ff6a2a` | — |

**Ashen (Maulsmith, Blight Crawler)**

| band | element | linear RGB | ratio |
|---|---|---|---:|
| high | ash-crusted hide | 0.140, 0.122, 0.104 | 4.1 |
| mid | burnt leather, chain skirt | 0.062, 0.052, 0.044 | 1.8 |
| low | blackened iron | 0.034, 0.034, 0.036 | 1.0 |
| accent | glowing fissures (glow mask) | emissive 1.8, `#ff8a3a` | — |

**Order (player classes)** — must be the brightest thing on screen.

| class | high | mid | low | accent |
|---|---|---|---|---|
| Ravager | steel plate 0.215 | crimson tabard 0.115 (`#8a2a26`) | leather 0.048 | none |
| Emberwright | bone-white robe 0.240 | ember trim 0.130 | charcoal underrobe 0.038 | emissive 1.2 `#ff9a40` |
| Runeblade | brushed steel 0.200 | indigo cloth 0.090 (`#2a3060`) | black leather 0.036 | emissive 1.6 `#4ad8e0` |

**Readability gate:** the player's peak albedo band must be **≥ 1.6×** the peak
band of any monster on screen. Ravager 0.215 vs Undead high 0.185 is 1.16 — which
fails, deliberately, to make the point: the player's separation comes from the
*rim term and the trim emissive*, not from raw albedo, because raising player
albedo further makes them a white cutout under bloom. The gate is therefore
enforced on **perceived luminance after rim and emissive**, measured by
`tools/readability.mjs` on the `dense-combat` shot: the player's mean pixel
luminance in the rendered frame must be ≥ 1.6× the mean of the monster pixels.

### 4.4 Per-actor uniforms

All eight are plain uniforms on the per-actor material instance. None is a define.
None creates a program.

| uniform | type | drives |
|---|---|---|
| `uTint` | `vec3` | base albedo tint: faction × champion/unique × per-instance hue jitter |
| `uTrimTint` | `vec3` | colour applied where `aSurf.x` bit 4 is set — the rarity band |
| `uTrimEmissive` | `float` | rarity glow on the same band |
| `uGlow` | `vec3` | colour × intensity where `aSurf.x` bit 5 is set — eye sockets, runes, fissures |
| `uRim` | `vec4` | Fresnel rim colour (rgb) and intensity (a) |
| `uDissolve` | `float` | 0…1 ash dissolve threshold; spawn, blink, corpse fade |
| `uHitFlash` | `float` | 0…1 additive white flash on damage; 0.09 s exponential decay |
| `uAge` | `float` | seconds since spawn, for the unique-rarity emissive pulse |

The dissolve is available on every character for free because every character
material is created with `alphaTest = 0.0001`, which defines `USE_ALPHATEST` and
brings in the discard path. The patched fragment shader replaces the stock
threshold with a noise-vs-`uDissolve` comparison. Fill cost of losing early-Z on
26 characters at ~4 000 px each is 104 k fragments — negligible.

### 4.5 Champion, unique and affix variants

No new geometry, no new material, no new program.

| variant | `uTint` mix | `uRim` | mesh scale | extra |
|---|---|---|---:|---|
| normal | faction base | zone fog colour, intensity 0.35 | 1.00 × `scaleJitter` | — |
| champion | `#4a7cff` at 0.40 | `#6a9bff`, intensity 1.4 | **1.12** | blue ground aura decal (owned by `fx`), r = 1.1 m |
| unique | `#c8973f` at 0.45 | `#ffcf6a`, intensity 2.2 | **1.22** | gold aura r = 1.4 m, name plate (owned by `ui`) |
| boss | faction base | `#ff6a2a`, intensity 1.8 | 1.00 | phase-dependent `uGlow` |

Monster affixes (`Fire Enchanted`, `Lightning Enchanted`, `Cold Enchanted`, …)
ride `uGlow` and a `uRim` hue shift. **At most one affix may drive the rim.**
Priority order: `Fire` > `Lightning` > `Cold` > `Cursed` > everything else. The
rest are FX-only (aura particles owned by `fx`). Two rim colours on one 62 px
actor is unreadable and directly violates the readability rule in
ARCHITECTURE.md.

### 4.6 Contact occlusion

Cast shadows from a 52° key light cannot resolve the millimetre wedge under a
boot; the actor floats. Two `InstancedMesh` quads, lying flat, alpha-over with a
near-black colour (algebraically a multiply, so it is exposure-independent and
can never paint a grey silhouette on the floor):

| mesh | capacity | radius (m) | opacity | texture |
|---|---:|---|---:|---|
| body ellipse | `q.maxSkinned + q.corpseBudget` | 0.44 × 0.34 × `scale` | 0.62 | 64², `exp(−r²·3.4) · (1 − r³)` |
| foot lobes | 2 × capacity | 0.15 × 0.21 × `scale` × `k` | 0.85 | 64², `exp(−r²·4.6) · (1 − r³)` |

`k = 1 − clamp((footHeight − 0.06) / 0.29, 0, 1)`. A foot leaving the ground
**shrinks** its contact patch rather than fading it, which is what a real contact
does. Total cost: **2 draw calls for every actor and corpse in the game**.

---

## 5. Animation system

### 5.1 Architecture

A `Pose` is `Float32Array(bones × 3)` of euler-degree deltas on top of the bind
pose, plus a `rootOffset: Vector3` and a `rootYaw: float`. Layers accumulate into
it in a fixed order. Lerping euler degrees is only safe because all deltas are
small and expressed in the consistent per-bone frame of §2.1 — this is the entire
justification for that convention.

```
                     ┌─ L1  locomotion base   (crossfaded pair)          full mask
                     ├─ L2  state override    (attack/cast/block/…)      masked, weighted
  Pose  ←  accumulate┤
                     ├─ L3  additive overlays (breath, hit, lean, flash) masked, weighted
                     └─ L4  spring/damper     (weapon, cloak, head, hip) per-bone
                              ↓
                        write bone quaternions:  q = bindLocal · euler(delta)
                              ↓
                        updateMatrixWorld
                              ↓
                     ┌─ IK-A  foot placement   (probe → pelvis drop → 2-bone → sole roll)
                     ├─ IK-B  look-at          (Neck 0.4, Head 0.6, clamped)
                     └─ IK-C  hand-to-target   (block grip, two-handed haft, bow draw)
```

`update(dt)` allocates nothing. All scratch vectors, quaternions and eulers are
preallocated in `init()`.

**Death is the one exception to euler blending.** Its rotations exceed 90° on the
spine and hips, so the death clip writes quaternions directly into a parallel
array and blends with `slerp`. Everything else stays in euler space.

### 5.2 Blend weights

Each layer holds `w`, driven toward `target` linearly and then shaped:

```
w_raw  += clamp((target − w_raw), −dt/τ_out, dt/τ_in)
w       = smoothstep(0, 1, w_raw)
```

Linear approach guarantees the weight actually reaches 1 in `τ` seconds; the
smoothstep supplies the S-curve. An exponential approach never arrives and leaves
a permanent 2 % residual of the outgoing clip, which is visible as a limb ghost.

### 5.3 Bone masks

Four masks, each a `Uint8Array(bones)` of 0…255 built once:

| mask | bones |
|---|---|
| `full` | all, 255 |
| `upper` | `Chest`, `Neck`, `Head`, both clavicle→weapon/shield chains, cloak: 255. `Spine`: 160. `Hips`: 64. legs: 0 |
| `lower` | `Hips`, `Spine`: 255. legs: 255. everything else 0 |
| `arms` | clavicle→weapon/shield chains: 255. `Chest`: 96. everything else 0 |

Attacks use `upper` so a Ranker can keep walking into range while it winds up —
which is what makes a pack feel like a pack rather than a line of statues.

### 5.4 Locomotion

Phase is driven by **measured ground speed**, never by a timer, so feet do not
skate:

```
strideHz = clamp(speed / strideLength, minHz, maxHz) · rateJitter
phase    = (phase + dt · strideHz) mod 1
```

| clip | strideLength (m) | minHz | maxHz | ref speed | cycle at ref |
|---|---:|---:|---:|---:|---:|
| `walk` | 1.45 | 0.60 | 2.40 | 2.2 m/s | 0.66 s |
| `run` | 2.90 | 1.05 | 2.80 | 4.6 m/s | 0.63 s |
| `idle` | — | 0.3125 | 0.3125 | — | 3.20 s (breath) |

Walk→run crossfade over a 0.60 m/s band centred on **3.20 m/s**, with 0.25 m/s
of hysteresis so an actor jostled at the boundary does not flicker.

Per-archetype speeds:

| actor | walk (m/s) | run (m/s) |
|---|---:|---:|
| player (all classes) | 2.2 | 4.6 |
| Bone Ranker | 1.7 | 3.4 |
| Carrion Swarm | 2.4 | 5.6 |
| Ashen Archer | 1.9 | 3.8 |
| Dust Shaman | 1.6 | 3.0 |
| Maulsmith | 1.4 | 2.2 |
| Blight Crawler | 2.2 | 5.0 |
| Molgrim | 1.8 | 3.2 |

Gait curve shape, per leg, phase `a = 2π·phase + sideOffset`:

```
thigh = A_t · sin(a) + bias_t
knee  = −( base_k + A_k · lobe(a − 0.55, 1.5) + stance_k · lobe(a + π + 0.4, 2) )
ankle = A_a · sin(a − 1.9) + bias_a
lobe(x, p) = sin(x) > 0 ? sin(x)^p : 0
```

Pelvis: two vertical bobs per stride (`cos 2t`), lateral sway (`sin t`), roll
toward the stance leg, counter-yaw against the shoulders. Spine counter-rotates
against the pelvis at 0.45 / 0.75 / 1.00 of the yaw amplitude on
`Spine` / `Chest` / `Neck`.

| parameter | walk | run |
|---|---:|---:|
| `A_t` thigh swing (°) | 21 | 34 |
| `base_k` knee base (°) | 7 | 14 |
| `A_k` knee flexion (°) | 46 | 86 |
| `A_a` ankle (°) | 12 | 20 |
| sway / bob (m) | 0.014 / 0.014 | 0.020 / 0.030 |
| pelvis yaw / roll (°) | 4.5 / 3.2 | 7 / 5 |
| forward lean (°) | 4 | 13 |
| arm swing (°) | 3.5 | 7 |

### 5.5 State table

Blend times are seconds. Root policy is defined in §5.7.

| state | duration | loop | root | blend in | blend out | mask | notes |
|---|---|---|---|---:|---:|---|---|
| `idle` | 3.20 s cycle | yes | free | 0.20 | 0.16 | full | breath + weight shift + micro head motion |
| `walk` | speed-driven | yes | free | 0.16 | 0.16 | full | — |
| `run` | speed-driven | yes | free | 0.14 | 0.18 | full | — |
| `attack.windup` | `W · mult` | no | locked | 0.10 | — | upper @ 1.0, lower @ 0.35 | facing free for the first 40 % only |
| `attack.active` | `S` (never scaled) | no | locked | 0 | — | upper | hit emitted at entry |
| `attack.recovery` | `R · mult` | no | locked → free at 60 % | — | 0.14 | upper | cancellable by another attack from 75 % |
| `cast` | `W·mult + S + R·mult` | no | locked | 0.12 | 0.16 | upper | projectile spawns at entry to `active` |
| `block.enter` | 0.14 | no | free, speed × 0.45 | 0.10 | — | upper | — |
| `block.hold` | ∞ | yes | free, speed × 0.45 | — | — | upper | breath additive stays at 0.35 |
| `block.exit` | 0.20 | no | free | — | 0.14 | upper | — |
| `block.impact` | 0.18 | no | — | 0.05 | 0.10 | arms, additive | shield kicks back 18°, `uHitFlash` 0.4 |
| `hit` | 0.30 | no | free | 0.06 | 0.14 | full, additive @ 0.55 | never interrupts an attack |
| `stun` | `0.4 / (1 + FHR/100)` | no | locked | 0.08 | 0.18 | full | cancels a wind-up; a hit already emitted stays emitted |
| `death` | 1.30 | no | scripted | 0.10 | — | full, quaternion blend | 0.35 stagger + 0.55 fall + 0.40 settle |
| `corpse` | ∞ | — | — | — | — | baked | see §8 |
| `spawn` | 1.00 | no | locked | 0 | 0.20 | full | root Y −1.10 → 0 over 0.70 s, `uDissolve` 0.85 → 0 over 0.55 s |
| `resurrect` | 0.80 | no | locked | 0 | 0.18 | full | reverse of `death`, `uDissolve` 1 → 0 |
| `dash` | per skill | no | scripted | 0.08 | 0.12 | full | Ravager Charge, Runeblade Phase Step, Emberwright Ashen Step |
| `channel` | ∞ | yes | free, speed × 0.60 | 0.15 | 0.15 | upper | Ravager Whirlwind |

### 5.6 Additive overlays

| overlay | source | envelope | peak amplitude | bones |
|---|---|---|---:|---|
| breath | always on, `≥ 0.25` weight in every state | `sin(2π·phase·0.3125)` | 1.6° spine, 0.004 m hip | Spine, Chest, Neck, Hips |
| hit flinch | `actor:damage` | `exp(−8t) · min(1, 25t)`, 0.30 s | region table below | varies |
| lean-to-target | aim direction vs facing | continuous, `τ = 0.18 s` | 14° Chest yaw, 9° Neck | Chest, Neck, Head |
| impact recoil | own hit landing | `exp(−16t) · sin(92t)`, 0.26 s | 9° upper arm, 3.5° chest | right arm chain, Chest |
| stagger | knockback ≥ 0.4 m | `exp(−6t)`, 0.45 s | 12° hips, 0.05 m root | Hips, Root |

Hit-flinch regions, chosen from `actor:damage.point` relative to the actor's
facing:

| region | Chest (°) | Neck / Head (°) | Hips (°) | root offset (m) |
|---|---:|---:|---:|---:|
| front | −11 flexion | +6 / −8 | +4 | (0, −0.02, −0.03) |
| back | +9 | −5 / +7 | −3 | (0, −0.02, +0.03) |
| left | −5, +4 lateral | +3 lateral | +2 lateral | (+0.02, −0.02, 0) |
| right | −5, −4 lateral | −3 lateral | −2 lateral | (−0.02, −0.02, 0) |

### 5.7 Spring / damper overlays

Integrated with semi-implicit Euler at a **fixed internal step of 1/120 s**, with
an accumulator and a hard cap of 4 substeps per frame so a 60 ms hitch cannot
detonate the spring.

```
v += (−ω²·(x − target) − 2ζω·v) · h
x += v · h
```

| overlay | driven by | ω (rad/s) | ζ | max deflection | bones |
|---|---|---:|---:|---|---|
| weapon inertia | `WeaponR` world acceleration | 26 | 0.85 | 22° | `WeaponR` |
| cloak sway | `Chest` velocity + a 0.4 m/s zone wind | 12 | 0.70 | 34° per segment | `Cloak0..2` |
| head lag | `Chest` angular velocity | 34 | 1.00 | 12° | `Neck`, `Head` |
| hip settle | root vertical velocity | 30 | 0.95 | 0.06 m | `Root.y` |
| shield bob | `ForearmL` acceleration | 22 | 0.90 | 15° | `ShieldL` |
| hit shake | `actor:damage` impulse | 55 | 0.55 | 9° | `Chest` |
| tome orbit (boss) | `Chest` velocity | 8 | 0.55 | 0.45 m | `Tome` |
| tail whip (swarm) | `Hips` angular velocity | 18 | 0.62 | 40° | `TailA/B` |

Springs are presentation and run in `update(dt)`. The harness pumps frames in
lockstep with a fixed clock, so spring output is reproducible and survives the
`imagediff` gate.

### 5.8 IK

**IK-A — foot placement.** Runs before look-at and hand IK.

1. Ground probe per foot: `nav.heightAt(x, z)` — an O(1) bilinear lookup on the
   0.5 m walkability grid, plus a normal from the 4-neighbour gradient. **Not a
   physics raycast**: 52 raycasts per frame is not affordable and not necessary.
2. Pelvis drop = `min` over both feet of `(desiredAnkleY − currentAnkleY)`,
   clamped to **−0.30 m**, written to `Root.position.y`.
3. Analytic two-bone solve per leg. Knee pole = the actor's forward vector rotated
   ±7° outward.
4. Sole roll: align the foot's local +Z to the ground normal, clamped to **20°**.
5. Foot IK is disabled during `death`, `spawn`, `dash` and any `scripted` state.

**IK-B — look-at.** `Neck` at 0.40 of the residual, `Head` at 0.60, each capped
at 29° per bone per frame and 55° total from bind. Weight 0.35 in `idle`, 1.0
when the actor has a target. Disabled during `death` and `stun`.

**IK-C — hand-to-target.** Two-bone solve on the left arm to a socket-space
target: the shield grip in `block`, the weapon haft for two-handed weapons, the
bowstring anchor during the Archer's draw. Elbow pole is down and out at (0.6,
−1, −0.25) in actor space.

**Footfall events.** When a foot's phase crosses its plant point — walk at 0.06
and 0.56, run at 0.10 and 0.60 — the animator emits:

```js
ctx.events.emit('actor:footstep', { actor, point, surface, speed });
```

`surface` comes from the ground tile's tag (ARCHITECTURE.md surface vocabulary).
`fx` uses it for dust, `audio` for the step transient. Emitted from `update`, not
`fixedUpdate` — it is presentation and drives no game state.

### 5.9 New events this subsystem introduces

Not currently in ARCHITECTURE.md's table. **Whoever implements step 8 of §11 must
add these three rows to that table in the same commit** (per its own rule).

| event | payload | emitted by |
|---|---|---|
| `actor:footstep` | `{ actor, point, surface, speed }` | actors |
| `anim:telegraph` | `{ actor, shape: 'disc'\|'wedge'\|'line'\|'rune', origin, radius, arc, ticks, startTick }` | actors |
| `anim:hitframe` | `{ actor, attackId, tick }` | actors |

`anim:telegraph` is consumed by `fx` (it draws the decal) and by nothing else.
`anim:hitframe` exists so impact FX and audio can be scheduled on exactly the
tick the hit resolves, without `fx` having to duplicate the timing maths.

---

## 6. Attack timing contract

This is the interface between a 60 Hz deterministic simulation and a
frame-rate-dependent presentation layer. It has one rule:

> **The simulation owns the clock. The animator reads it. Never the other way
> around.**

### 6.1 The tick maths

Everything is integer ticks. `mult` is computed **once**, at the tick the attack
starts, and is not re-read if IAS changes mid-swing.

```js
onAttackStart(tick0, attack, ias) {
  const mult        = 1 / (1 + ias / 100);
  const windTicks   = Math.max(2, Math.round(attack.W * 60 * mult));
  const activeTicks =            Math.round(attack.S * 60);      // NEVER scaled
  const recTicks    = Math.max(1, Math.round(attack.R * 60 * mult));
  const hitTick     = tick0 + windTicks;
  const endTick     = hitTick + activeTicks + recTicks;
  return { windTicks, activeTicks, recTicks, hitTick, endTick };
}
```

`combat:hit-request` is emitted by `ai` / `skills` on `hitTick`, in
`fixedUpdate`, in the same fixed order every run. The animator is handed the tick
counts and derives its phases from them:

```js
// in update(), presentation only
const t = (ticksElapsed + ctx.time.alpha) / windTicks;   // smooth between ticks
```

The animator never decides when a hit lands. `tools/balance.mjs` therefore
produces identical results whether the game runs at 30 fps or 144 fps.

### 6.2 What scales and what does not

| phase | scales with IAS | why |
|---|---|---|
| wind-up `W` | **yes** | this is where attack speed is felt — the anticipation shortens |
| active `S` | **no** | scaling it would change how many enemies a sweep or cone catches at high IAS. That is a balance bug, not a feature |
| recovery `R` | **yes** | shortens the gap to the next input |
| Maulsmith slam wind-up | yes, **floored at 0.90 s** | an `Extra Fast` champion Maulsmith must still be dodgeable. The floor is the telegraph's contract with the player |
| Blight Crawler detonate | **no** | a fuse that gets shorter with an affix is a death sentence with no counter-play |
| Shaman resurrect | **no** | a fixed ritual; the player learns one number |
| all boss phases | **no** | boss timing is memorised, not rolled |

`total = (W + R) · mult + S`. Worked examples:

| case | W | S | R | IAS | mult | total | hit at |
|---|---:|---:|---:|---:|---:|---:|---:|
| Ravager 1H, base | 0.28 | 0.10 | 0.22 | 0 | 1.000 | 0.600 s | tick 17 |
| Ravager 1H, +60 % IAS | 0.28 | 0.10 | 0.22 | 60 | 0.625 | 0.413 s | tick 11 |
| Ravager 1H, +160 % IAS | 0.28 | 0.10 | 0.22 | 160 | 0.385 | 0.293 s | tick 6 |
| Maulsmith slam, base | 1.20 | 0.14 | 0.85 | 0 | 1.000 | 2.190 s | tick 72 |
| Maulsmith slam, Extra Fast (+45 %) | 0.90 (floored) | 0.14 | 0.85 | 45 | 0.690 | 1.727 s | tick 54 |

### 6.3 Attack table

| actor / attack | W (s) | S (s) | R (s) | total @ IAS 0 | telegraph |
|---|---:|---:|---:|---:|---|
| Ravager 1H swing | 0.28 | 0.10 | 0.22 | 0.60 | none |
| Ravager 2H swing | 0.40 | 0.12 | 0.33 | 0.85 | none |
| Emberwright cast | 0.42 | 0.05 | 0.33 | 0.80 | hand `uGlow` ramp |
| Runeblade thrust | 0.24 | 0.08 | 0.20 | 0.52 | none |
| Bone Ranker swing | 0.42 | 0.10 | 0.33 | 0.85 | weapon `uGlow` 0.4 |
| Bone Ranker block | 0.14 enter | loop | 0.20 exit | — | shield tilts to face the threat |
| Carrion Swarm bite | 0.22 | 0.06 | 0.26 | 0.54 | none |
| Ashen Archer draw + loose | 0.66 | 0.04 | 0.40 | 1.10 | bow `uGlow` + a 0.6 m line decal from t = 0.35 s |
| Dust Shaman resurrect | 1.05 | 0.10 | 0.55 | 1.70 | ground rune decal r = 2.0 m from t = 0.20 s |
| Dust Shaman haste | 0.55 | 0.08 | 0.40 | 1.03 | staff `uGlow` |
| **Maulsmith slam** | **1.20** | 0.14 | 0.85 | **2.19** | see §6.4 |
| Blight Crawler detonate | 0.85 | 0.05 | — (dies) | 0.90 | sac swell 1.00 → 1.35, `uGlow` 0 → 3.0, disc decal r = 3.2 m from t = 0.25 s |
| Molgrim sweep | 0.95 | 0.15 | 0.60 | 1.70 | 220° wedge, 4.2 m |
| Molgrim summon | 1.40 | 0.10 | 0.80 | 2.30 | 4 rune decals at the spawn points |
| Molgrim fire ring | 1.10 | 0.20 | 0.70 | 2.00 | concentric ring decals with the gap marked |
| Molgrim meteor | 1.60 | 0.10 | 0.90 | 2.60 | 6 disc decals r = 1.8 m |

### 6.4 Producing the Maulsmith's 1.2 s telegraph

Three redundant channels. Redundancy is the point: at 137 px a single channel
occluded by a corpse, a particle or another actor is a channel the player did not
see.

**Channel 1 — pose.** Timed against the wind-up's normalised `t ∈ [0, 1]`:

| segment | `t` | what happens |
|---|---|---|
| lift | 0.00 → 0.71 | the hammer head rises through a **155° arc**; `ClavicleR` pulls back 26°, `Chest` counter-rotates 38° yaw, forward lean goes to −14°, weight shifts to the back foot (`Hips` −0.05 m Z) |
| **hold** | 0.71 → 1.00 | **the pose stops.** 0.35 s of near-stillness at the apex, with only the breath additive at 0.25 weight |
| strike | active phase | 155° down through the arc in 0.14 s, `Hips` +0.09 m forward |

The hold is the readable part. Continuous motion reads as "swinging"; motion that
*stops* reads as "about to happen". This is the single highest-value 3 lines in
the whole animation system.

**Channel 2 — ground decal.** The animator emits, at wind-up tick 9 (t = 0.125, so
a wind-up cancelled inside 150 ms never flashes a decal):

```js
ctx.events.emit('anim:telegraph', {
  actor, shape: 'disc', origin: impactPoint,
  radius: 2.6, arc: 0, ticks: 63, startTick: tick0 + 9
});
```

`fx` grows the disc from r = 0 to 2.6 m over the remaining wind-up, opacity 0 →
0.85, with a 4 Hz opacity pulse over the last 0.30 s. Colour is the Ashen accent
`#ff8a3a` at a fixed intensity that survives bloom — rarity and telegraph colours
are sacred per ARCHITECTURE.md.

**Channel 3 — emissive.** `uGlow` on the hammer head's glow-masked vertices ramps
0 → 1.6 over the wind-up, `1.6 → 3.2` over the hold. Under the bloom pyramid this
is a bright arc that reads at 62 px even when the Maulsmith is behind two Rankers.

**Cancellation.** A stun during the wind-up cancels all three: the animator
blends out over 0.18 s and emits `anim:telegraph` with `ticks: 0`, which `fx`
treats as an immediate fade. A hit that does *not* stun cancels nothing.

### 6.5 Facing lock

An attack that can be walked out of has no weight. Turn rate during a locked
state:

| phase | turn rate |
|---|---|
| wind-up, first 40 % | 540 °/s |
| wind-up, remaining 60 % | **0** |
| active | 0 |
| recovery, first 60 % | 0 |
| recovery, last 40 % | 540 °/s |

### 6.6 Interruption rules

| event during… | wind-up | active | recovery |
|---|---|---|---|
| `hit` (no stun) | continues | continues | continues |
| `stun` | **cancels**, no hit emitted | hit already emitted, active truncated | cancels |
| `death` | cancels immediately | hit already emitted stands | cancels |
| own input (next attack) | ignored | ignored | **accepted from 75 %** |
| target dies | continues to completion | continues | continues |

A hit that has already been emitted is never retroactively withdrawn. `combat` is
the only system that resolves it, and it may resolve into nothing.

---

## 7. Equipment visualisation

### 7.1 Socket list

Sockets are bone-space offsets, not bones (except `WeaponR` and `ShieldL`, which
earn bone status in §2.3).

| socket | bone | local offset (m) | local rot XYZ (°) | carries |
|---|---|---|---|---|
| `helm` | `Head` | (0, 0.055, 0.010) | (0, 0, 0) | helm shell, crest, plume |
| `chest` | `Chest` | (0, 0, 0) | — | cuirass / robe torso — merged and skinned, not rigid |
| `weaponMain` | `WeaponR` | (0, 0, 0) | (0, 0, 0) | weapon, +Y down the blade / haft |
| `offhand` | `ShieldL` | (0, 0, 0) | (0, −12, 0) | shield, orb, focus, second weapon |
| `backpack` | `Chest` | (0, −0.020, −0.140) | (0, 0, 0) | quiver, tome, satchel — cosmetic, tied to the equipped weapon |
| `capeRoot` | `Chest` | (0, 0.040, −0.100) | — | cloak / mantle chain root |
| `fxHandR` | `HandR` | (0, 0.050, 0.020) | — | spell origin, right |
| `fxHandL` | `HandL` | (0, 0.050, 0.020) | — | spell origin, left |
| `fxMuzzle` | `WeaponR` | (0, `L_blade`, 0) | — | projectile origin, weapon trail tip; `L_blade` comes from the item base |
| `fxChest` | `Chest` | (0, 0.030, 0.120) | — | shield-hit sparks, aura origin |

Public accessor: `actors.socket(actor, socketId, outVec3, outQuat)`. Callers pass
their own scratch objects; the method allocates nothing.

### 7.2 How equipment changes the model

**Player: merged rebuild.** On `item:equip` / `item:unequip`, `actors` rebuilds
the player's merged geometry from the base body part list plus the four
equipment part lists. Measured budget: **3.5 ms**. It runs in `lateUpdate`,
double-buffered — build into a spare geometry, swap `mesh.geometry`, dispose the
old one on the next frame. Geometries are keyed by `class|helmId|chestId|
weaponId|offhandId|rarityHash` and held in a **6-entry LRU**, so swapping back
and forth between two weapons rebuilds nothing.

This costs one frame's worth of work at most once per equip, and keeps the player
at **one draw call**. The alternative — four extra `SkinnedMesh` objects sharing
the skeleton — costs 4 draw calls every frame forever and produces a visible seam
where the cuirass meets the torso.

**Monsters: fixed.** Equipment is part of the archetype's part list. Champions
and uniques change `uTint`, `uRim` and mesh scale, never geometry (§4.5).

**Silhouette contribution requirement.** Each visible slot must measurably change
the outline, or it is not worth a draw:

| slot | minimum outline delta | achieved by |
|---|---:|---|
| helm | 6 % of character pixels | crest / horns / brim breaking the head circle |
| chest | 9 % | pauldron width, tabard hem, robe flare |
| weapon | 11 % | blade length 0.7–1.6 m at a 35° carry angle |
| offhand | 12 % | shield plate 0.42–0.62 m² of frontal area |

**Gate:** `tools/equipdiff.mjs` captures the player in a fixed pose, changes one
slot, recaptures, and asserts the character-pixel delta meets the row above.
Equipping all four slots must change **≥ 18 %** of the player's silhouette pixels.

### 7.3 Rarity

Rarity adds a small amount of geometry and sets two uniforms. It never adds a
material or a program.

| rarity | extra tris | trim mask | `uTrimTint` | `uTrimEmissive` |
|---|---:|---|---|---:|
| normal | 0 | none | — | 0 |
| superior | +60 (edge ribbon) | ribbon vertices | `#c8c8c8` | 0 |
| magic | +140 (2nd ribbon + pommel) | ribbon + pommel | `#6a7bff` | 0.15 |
| rare | +220 (+ crest or gem) | ribbon + crest | `#ffe066` | 0.30 |
| unique | +180…+420, bespoke per item (8 total) | the bespoke element | `#c8973f` | 0.55 × (1 + 0.35·sin(2π·`uAge`·0.6)) |

The trim mask is bit 4 of `aSurf.x`, set at build time on the vertices of the
trim ribbon and ornament parts. The rarity colours are exactly the ones in the
plan's rarity table; the emissive is what makes them survive bloom and AgX, per
ARCHITECTURE.md's "rarity colours are sacred".

The eight unique items each get one authored silhouette element (a broken crown
rim, an asymmetric spiked pauldron, a trailing chain, a splintered blade tip…) so
a unique is recognisable at 62 px before the name plate is read.

---

## 8. Death, corpses and gibbing

### 8.1 Death

There is **no ragdoll**. The reference project's PBD ragdoll rides on a BVH
physics system the plan explicitly does not port. A scripted death is cheaper,
deterministic, and at 62–103 px indistinguishable.

`death` is 1.30 s in three segments, quaternion-blended (§5.1):

| segment | duration | what |
|---|---:|---|
| stagger | 0.35 s | knees buckle 40°, spine folds 28°, head drops; root falls 0.18 m |
| fall | 0.55 s | rotate about a horizontal axis derived from the killing blow's `point` and `knockback`, root falls the remaining height, arms trail on the inertia springs |
| settle | 0.40 s | two damped bounces (ω 22, ζ 0.35), limbs come to rest, foot IK off |

Fall direction: the horizontal component of `(actorPos − damagePoint)` normalised,
plus the knockback vector. Fully determined by the damage packet, so it replays
identically from a seed.

### 8.2 Corpse baking

On the settle frame the skinned pose is baked once on the CPU: for each vertex,
`p' = Σ w_i · boneMatrix_i · p`, plus the same for normals. 900 vertices × 4
influences ≈ **40 µs**. The result is written into a per-faction
`THREE.BatchedMesh` via `setGeometryAt`, and the live `SkinnedMesh` returns to the
pool.

| | value |
|---|---|
| corpse geometry | the LOD the actor was at when it died, frozen |
| draw calls | **1 per faction BatchedMesh**, 2 total |
| `castShadow` | **false** — a corpse lying flat under a 52° key light contributes nothing, and turning it off removes a whole batched-depth program |
| prepass | excluded, like all characters |
| memory | `BatchedMesh` reserves `q.corpseBudget × 1 200` vertices per faction |

### 8.3 Persistence budget and fade

| preset | `q.corpseBudget` |
|---|---:|
| low | 6 |
| medium | 10 |
| high | 16 |
| ultra | 20 |

Lifetime **25 s**, then a **1.5 s ash dissolve**: `uDissolve` runs 0 → 1 on the
batched material's per-instance colour channel while the instance matrix sinks
0.35 m and scales to 0.92. `fx` emits a 24-particle ash puff at 60 % of the
dissolve. Because the dissolve is an alpha-test discard, corpses stay in the
opaque pass — no transparency, no sorting, no second draw.

When the budget is full, the **oldest** corpse begins dissolving immediately.
Exception: a corpse that is still resurrectable (§8.5) is exempt from eviction
for its first 12 s; if every corpse is exempt, the oldest exempt one is evicted
anyway and marked non-resurrectable first, so the eviction order stays total and
deterministic.

### 8.4 Gibbing

Per-limb gib meshes are not built. An overkill or a `Fire Enchanted` death skips
the corpse entirely:

| trigger | result |
|---|---|
| single hit ≥ 35 % of `maxLife` | no corpse; gib burst; `actor:despawn` on the death tick |
| `Fire Enchanted` affix death | no corpse; gib burst + the affix's fire explosion (owned by `skills`) |
| Blight Crawler detonation | no corpse; gib burst + poison cloud |
| anything else | normal corpse |

A gib burst is **18 particles** drawn from `fx`'s existing pool: 6 bone shards,
8 ash motes, 4 blood/ichor blobs, tinted by the faction's high band. At most
**3 concurrent bursts**; a fourth request replaces the oldest. Gibbing costs zero
new geometry and zero new draw calls.

### 8.5 Resurrection

The Dust Shaman is the only system that reads corpses back.

A corpse is `resurrectable` when **all** hold:

1. it is a Bone Ranker (the only archetype the Shaman raises),
2. age < **12.0 s**,
3. it was not gibbed,
4. it has been resurrected **0** times — a corpse can be raised exactly once,
5. it is within **9.0 m** of the Shaman and on walkable nav.

Query: `actors.resurrectableCorpses(point, radius) → handle[]`, sorted by distance
then by corpse id, so the Shaman's choice is deterministic.

Sequence, from the resurrect attack's `hitTick` (§6.3, W = 1.05 s, unscalable):

| t | what |
|---|---|
| 0.00 | `actors.resurrect(handle)`: the BatchedMesh instance is released, a fresh `SkinnedMesh` is taken from the pool at the corpse's exact position and yaw |
| 0.00 → 0.80 | `resurrect` state plays; `uDissolve` runs 1 → 0; root rises from −0.35 m to 0 |
| 0.45 | the actor becomes targetable and its AI resumes |
| 0.80 | normal `idle` |

There is **no frame where neither the corpse nor the actor is visible** — the
skinned mesh is added to the scene in the same `lateUpdate` in which the batched
instance is released. This is an acceptance criterion, not an aspiration.

A resurrected Ranker spawns with `resurrectCount = 1` and 60 % of base max life
(a `combat` rule, listed here so the visual state — a permanently raised
`uDissolve` floor of 0.08, giving a faintly eroded look — is unambiguous).

---

## 9. Performance budgets

### 9.1 Triangles

| archetype | L0 | L1 |
|---|---:|---:|
| Ravager / Emberwright / Runeblade | 2 100 / 1 850 / 1 950 | 940 / 830 / 880 |
| Bone Ranker | 1 150 | 520 |
| Ashen Archer | 1 080 | 490 |
| Dust Shaman | 1 290 | 580 |
| Maulsmith | 2 050 | 920 |
| Blight Crawler | 760 | 340 |
| Carrion Swarm | 260 | 150 |
| Molgrim | 3 400 | 1 530 |

Worst realistic scene — 1 player + 25 monsters + 16 corpses:

| group | count | tris each | total |
|---|---:|---:|---:|
| player (Ravager, full kit) | 1 | 2 100 | 2 100 |
| Bone Ranker | 8 | 1 150 | 9 200 |
| Carrion Swarm | 10 | 260 | 2 600 |
| Ashen Archer | 4 | 1 080 | 4 320 |
| Dust Shaman | 2 | 1 290 | 2 580 |
| Maulsmith | 1 | 2 050 | 2 050 |
| corpses (L1 Ranker) | 16 | 520 | 8 320 |
| contact occlusion quads | 74 | 2 | 148 |
| | | **total** | **31 318** |

Boss encounter — Molgrim + 4 Rankers + 6 corpses: **3 400 + 4 600 + 3 120 =
11 120**.

| budget | value |
|---|---|
| **per-actor mean (monsters)** | **1 250 tris** |
| **per-actor hard cap (non-boss)** | **2 100 tris** |
| boss cap | 3 400 tris |
| **whole-cast scene cap** | **45 000 tris — 1.8 % of the 2.5 M scene budget** |

Characters are not a triangle problem. Anyone proposing to raise these numbers to
"improve quality" should read §0 first: the limit is 3.2 cm of feature size, not
triangles.

### 9.2 LOD

The honest finding: the camera's distance range is 18.5–30.5 m, a **1.65 : 1**
ratio. Classic distance LOD would save roughly 15 % of character vertex work, on
a workload that is already 1 % of the scene. It is not worth a system on its own.

What we ship instead:

| tier | trigger | geometry |
|---|---|---|
| L0 | camera distance < 24.0 m | authored density |
| L1 | camera distance ≥ 25.0 m (1.0 m hysteresis) | 0.49× rebuild |
| L1 forced | actor ranks beyond `q.maxSkinned` by distance from the **player** | 0.49× rebuild |
| L1 forced | every corpse | frozen at whatever it was |
| L1 forced | Molgrim phase III, all non-boss actors | known frame-cost peak |

Hysteresis is mandatory: without it an actor jittering at the boundary swaps
geometry every frame, which is a visible pop and a `BufferGeometry` bind churn.

### 9.3 Draw calls

| pass | characters | note |
|---|---:|---|
| depth / normal prepass | **0** | characters are excluded — see below |
| shadow, cascade 0 only | 26 | `mesh.userData.shadowCascadeMask = 0b001` |
| shadow, cascades 1–2 | 0 | a 1.8 m actor contributes nothing to a 40 m cascade |
| opaque main, live skinned | 26 | one material group each |
| opaque main, corpses | 2 | one `BatchedMesh` per faction |
| opaque main, swarm instanced | 1 | the whole swarm |
| contact occlusion | 2 | body + feet `InstancedMesh` |
| ground telegraph decals | 0 | owned by `fx`, batched with its decal atlas |
| **character total** | **57** | **38 % of the 150-call scene budget** |

**Why characters skip the depth prepass**, and what covers the gap:

| prepass consumer | what we lose | replacement |
|---|---|---|
| GTAO | no ambient occlusion contact around feet and between limbs | `aSurf.w` baked vertex AO on indirect light (§3.7) + the contact occlusion sprites (§4.6) |
| soft particles | blood and impact FX clip hard against character geometry | those FX are 2–5 px and last < 0.25 s; `fx` uses its `noSoft` path for character-anchored emitters |
| velocity buffer | no motion-vector-based AA or motion blur on characters | the plan already leans SMAA over TAA because the camera is near-static; SMAA needs no velocity |
| early-Z overdraw saving | characters overlap the world in the main pass | ~104 k character fragments total; the saving was never material |

This is a **required contract on `render`**: it must honour
`mesh.userData.noPrepass = true` (already in ARCHITECTURE.md) and must add
`mesh.userData.shadowCascadeMask` so a mesh can opt into a subset of cascades.
Without the cascade mask the character shadow cost triples to 78 draws and the
budget in this table fails.

### 9.4 CPU cost at 26 actors

Estimates, to be replaced with `profile.mjs` measurements at step 15.

| item | work | estimate |
|---|---|---:|
| pose evaluation | 4 layers × 24 bones × 26 actors ≈ 2 500 euler→quat + multiply | 0.21 ms |
| `Bone.updateMatrixWorld` | 24 × 26 = 624 compose + multiply | 0.075 ms |
| `Skeleton.update` + bone texture write | 624 matrix multiplies, 40 KB upload | 0.090 ms |
| foot IK | 52 grid probes + 52 two-bone solves + 52 sole rolls | 0.120 ms |
| look-at + hand IK | 26 + ~12 solves | 0.045 ms |
| springs | 26 actors × 6 springs × 2 substeps | 0.020 ms |
| contact occlusion matrix writes | 78 `compose` | 0.015 ms |
| **total** | | **0.575 ms** |
| **budget** | | **1.20 ms (7.2 % of a 16.6 ms frame)** |
| headroom | | **2.1×** |

GPU vertex cost: 26 × 900 = 23 400 skinned vertices in the main pass, the same
again in the shadow pass. Under 0.1 ms on any desktop GPU. Not tracked.

### 9.5 Instancing strategy

| group | technique | draws |
|---|---|---:|
| live skinned actors | none — skinned instancing needs a custom bone-data-texture shader, which is out of scope for MVP | 1 each |
| Carrion Swarm | `InstancedMesh` + vertex-shader gait from `aPhase` / `aState` (§1.3) | 1 total |
| corpses | `BatchedMesh` (`multi_draw`), per faction | 1 per faction |
| contact occlusion | `InstancedMesh` ×2 | 2 total |
| ground telegraphs | `fx`'s decal atlas | 0 |

### 9.6 Exceeding the budget

Deterministic, staged, and it never touches simulation.

| preset | `q.maxActors` (simulated) | `q.maxSkinned` (visible skinned) | `q.corpseBudget` |
|---|---:|---:|---:|
| low | 24 | 14 | 6 |
| medium | 32 | 20 | 10 |
| high | 44 | 26 | 16 |
| ultra | 56 | 32 | 20 |

1. **`ai` will not spawn beyond `q.maxActors`.** Spawn requests are **queued, not
   dropped**, FIFO by request order, and drain as actors die. Dropping would make
   `balance.mjs` non-reproducible across presets.
2. **Beyond `q.maxSkinned` visible actors**, the surplus — ranked by distance from
   the *player*, farthest first, ties broken by actor id — switches to L1 and
   animates at **30 Hz**, updating on frames where `(frame + actorId) & 1 === 0`
   and holding the previous bone matrices otherwise. At 62 px this is invisible.
3. **Beyond `q.maxSkinned + 8`**, the surplus additionally drops foot IK, the
   cloak springs and the look-at.
4. **Never** is an actor's `fixedUpdate` simulation skipped, throttled or
   reordered. Everything above is presentation. A monster you cannot see properly
   still hits you at exactly the right tick, which is what the determinism
   contract requires and what `balance.mjs` depends on.

---

## 10. Boot cost

### 10.1 Budget

Total boot target is **≤ 4.5 s** (the reference project landed at 3.7–4.6 s after
its prewarm work). Characters get **1.10 s** of that, hard cap.

| step | budget | notes |
|---|---:|---|
| surface array textures (3 arrays × 6 layers × 256², GPU forge) | 220 ms | owned by `materials`, one set for the whole cast |
| rig construction (humanoid, quadruped, crawler, boss) | 3 ms | pure math, no GPU |
| archetype geometry: 10 archetypes × 2 LODs | 380 ms | ≈ 19 ms per geometry |
| skin binding + joint clamp + Laplacian smoothing + seam weld | 145 ms | ≈ 7 ms per geometry |
| occluder AO + grime/dust/wear vertex bake | 95 ms | |
| `BatchedMesh` allocation (2 factions) | 15 ms | |
| material templates + pool allocation | 25 ms | 48 instances |
| shader prewarm (4 programs, §10.3) | 200 ms | `compileAsync` |
| **total** | **1 083 ms** | cap **1 100 ms** |

**Over-budget policy:** build L0 only for the archetypes present in the current
zone (from the zone's spawn table), and defer the remainder to the first
`zone:ready` after the player has control. Never defer the player's own geometry
or the shader prewarm — a compile during play is the one thing prewarm exists to
prevent.

### 10.2 Caching

Nothing is written to `localStorage`. A single archetype geometry is ~43 KB of
binary; `localStorage` is a ~5 MB string store and base64 would triple it. The
save system's budget is for game state, not for a geometry cache we can rebuild in
19 ms.

In-memory caches, alive for the session:

| cache | key | size | eviction |
|---|---|---|---|
| archetype geometry | `archetype\|lod` | 20 entries | never |
| player equipment geometry | `class\|helm\|chest\|weapon\|offhand\|rarityHash` | 6 entries | LRU |
| material instances | pool index | 48 | recycled, never freed |
| skeletons | pool index | `q.maxSkinned + 8` | recycled |
| skinned meshes | pool index | `q.maxSkinned + 8` | recycled |

Geometry is **never rebuilt on a zone change**. `zone:enter` only changes which
archetypes are spawned, not what exists.

### 10.3 Prewarm

`actors` implements `prewarmMaterials(ctx)`, called by `src/core/prewarm.js`
before the first frame. The contract from ARCHITECTURE.md: build and compile every
material the subsystem can produce, without spawning gameplay objects, drawing a
gameplay frame, or touching the clock or the RNG.

```
1. materials.characterSurfaces()          // forces the array textures to exist
2. build the 4 material templates          // skinned world, skinned UI, batched world, depth
3. build a 2-triangle stand-in geometry carrying EXACTLY the character attribute set:
       position, normal, uv, color, aSurf, skinIndex, skinWeight
   Three derives half the shader permutation from the attribute set; a stand-in
   missing aSurf compiles a different program and the prewarm is worthless.
4. bind it to a real 24-bone Skeleton from the humanoid rig
5. await renderer.compileAsync(scene, ctx.camera, ctx.scene)          // program 1
6. await renderer.compileAsync(scene, ctx.uiCamera, uiRenderTarget)   // program 2
7. swap in render.csm.depthMaterial, compile again                    // program 4
8. build a 1-instance BatchedMesh with the same attributes, compile   // program 3
9. dispose the stand-ins
```

Three hard rules, all learned the expensive way by the reference project:

- **A render target must be bound while compiling.** `outputColorSpace` and
  `toneMapping` are part of Three's program cache key and are read from the
  *currently bound* target. Compiling against the default framebuffer produces
  programs the game never uses, and the real ones still compile mid-play.
- **Never draw from `ctx.rng` here.** Geometry construction consumes the RNG
  stream; doing it during prewarm shifts every downstream draw and changes the
  picture, which breaks the `imagediff` gate. `actors` takes a dedicated
  `geoRng = this.rng.fork()` in `init()` *before* prewarm and uses only that.
- **Never read the clock.** Any subsystem that animates off `performance.now()`
  instead of the engine clock makes boot duration observable in the output, and
  then no prewarm change can ever be proven pixel-neutral.

Idempotent, never throws. A failed prewarm degrades to the old stutter; it must
not prevent boot.

**Acceptance gate:** `renderer.info.programs.length` is recorded at the end of
prewarm and asserted unchanged after a full `playtest.mjs` run including a boss
kill, four champion spawns, two unique spawns, sixteen corpses and a full
equipment swap. **Target: 0 shader compiles during play.**

---

## 11. Implementation order

Fifteen steps. Each is independently verifiable and each has an acceptance check
that fails the build if it regresses. Milestone mapping follows the plan's §9.

| # | step | deliverable | acceptance check | milestone |
|---:|---|---|---|---|
| 1 | **Rig** | `src/actors/rig.js` — bone tables for all four rigs, derived local transforms, `createSkeleton()` | `tools/rigcheck.mjs`: 22/16/12/26 bones; every world bind position round-trips through the local transforms within **1e-6 m**; no bone length is 0; every `*R` bone has x < 0; every parent index is less than its child index | M2 |
| 2 | **Geometry toolkit** | `src/actors/geo.js` — loft, tube, revolve, ellipsoid, boxRound, ribbon, spineRow, mesh ops | Node self-test: no NaN, no degenerate triangle (area < 1e-9), no duplicate index triple, triangle counts within **±5 %** of §3.2 | M2 |
| 3 | **Skin binder** | steps 1–7 of §3.5, plus adjacency and the 1 mm weld grid | `tools/rigcheck.mjs`: weights sum to 255 exactly; zero influences below the cut; **candy-wrapper loss < 12 %** at the elbow and the knee under a 90° bend; no vertex bound to a bone > 0.45 m away | M2 |
| 4 | **One archetype on screen** | Bone Ranker, L0, static bind pose, one material, in the M2 test scene | `capture.mjs` produces a frame; the Ranker measures **40 ± 3 px wide × 81 ± 4 px tall** in the shot; **1 draw call** for the actor | M2 |
| 5 | **Poser + locomotion** | `src/actors/clips.js` — the Poser accumulator, idle/walk/run, speed-driven phase | three `walk` shots at phase 0.0 / 0.33 / 0.66; Node harness integrates foot world position over a stride and reports **foot slide < 4 cm** | M2 |
| 6 | **Animator** | layer stack, masks, crossfade, spring/damper bank | idle→run→idle produces no bone-angle discontinuity **> 6° per frame** (logged); `update()` allocates 0 bytes over 600 frames (heap sampled); **pose + skeleton cost < 1.5 ms at 26 actors** — failing this triggers §1.5 | M2 |
| 7 | **Foot IK + contact occlusion** | ground probe, pelvis drop, two-bone solve, sole roll, `GroundShadows` | on a 12° ramp both feet plant within **1.5 cm** of the ground plane; the contact patch is present in the shot; **2 draw calls** for all contact occlusion | M2 |
| 8 | **Attack timing** | the state machine, §6.1 tick maths, `anim:telegraph` / `anim:hitframe`, the three new event rows added to ARCHITECTURE.md | Node harness: 1 000 attacks at IAS 0 / +40 / +100 / +160 assert `hitTick == tick0 + max(2, round(W·60·mult))` **every time**, and that the active window is exactly `round(S·60)` ticks regardless of IAS | M2 |
| 9 | **Character material** | array-texture sampling, `aSurf` decode, the 8 per-actor uniforms, tint / rim / trim / glow / dissolve / hit flash, `prewarmMaterials` | spawning 25 actors including 4 champions and 2 uniques adds **0 programs**; prewarm reports exactly **4** | M2 |
| 10 | **Remaining archetypes** | Archer, Shaman, Maulsmith, Crawler, plus the three player classes | `tools/silhouette.mjs`: pairwise normalised IoU **< 0.55** for every pair at three yaws, and ≥ 25 % difference in at least one of {aspect, area, convexity}; `tools/mannequin.mjs`: **≥ 22 %** pixel change over 0.5 s, actor cross-correlation **< 0.30** | M5 |
| 11 | **Swarm instanced path** | vertex-shader gait, `aPhase` / `aState` / `aScale` | 10 swarm members render in **1 draw call** and cost **< 0.15 ms** CPU; the death collapse and lunge read correctly in a 3-shot sequence | M5 |
| 12 | **Death, corpses, gibbing, resurrection** | death clip, CPU pose bake, `BatchedMesh`, dissolve, gib bursts, `resurrectableCorpses` / `resurrect` | 16 corpses render in **≤ 2 draw calls**; a resurrect has **no frame** in which neither the corpse nor the actor is visible; the eviction order is identical across two runs from the same seed | M5 |
| 13 | **Equipment** | sockets, merged rebuild, LRU, rarity trim | `tools/equipdiff.mjs`: each slot meets its outline delta in §7.2, all four together change **≥ 18 %** of player pixels; the rebuild costs **< 5 ms**; **0** new programs | M6 |
| 14 | **Boss** | the 26-bone rig, three phase sets, phase transition, levitation, tome spring | every phase's telegraph decal appears within **±1 tick** of its specified time across 20 runs; the phase transition is 2.2 s ± 1 tick; `renderer.info.programs.length` unchanged | M6 |
| 15 | **Budget enforcement + profiling** | `q.maxSkinned` pressure LOD, 30 Hz throttle, IK drop tiers, `actors.stats` | `profile.mjs` at `high` with the `dense-combat` shot: **character CPU p95 < 1.2 ms**, **character draw calls ≤ 60**, **0 shader compiles**; `playtest.mjs` passes 10 consecutive runs | M9 |

### 11.1 Public API (frozen at step 9)

```js
const actors = ctx.get('actors');

actors.create(archetypeId, opts)               // -> actor record
actors.playState(actor, stateId, params)       // -> { ticks }
actors.attack(actor, attackId, ias)            // -> { windTicks, activeTicks, recTicks, hitTick, endTick }
actors.socket(actor, socketId, outVec3, outQuat)
actors.setEquipment(actor, slot, itemVisual)   // player only; queues a merged rebuild
actors.setVariant(actor, { tint, rim, scale, glow, trimTint, trimEmissive })
actors.kill(actor, { dir, overkill, gib })
actors.resurrectableCorpses(point, radius)     // -> corpse handles, deterministic order
actors.resurrect(handle)                       // -> actor record
actors.stats                                   // { skinned, corpses, drawCalls, poseMs, tris }
```

Every out-parameter is caller-supplied. Nothing on this surface allocates.

---

## 12. Summary of the risks this document closes

| risk (plan §10) | status after this spec |
|---|---|
| "Procedural character animation is the highest-risk item" | Reduced to two bounded algorithms (§3.5 binder, §5 blend tree), both with working reference implementations, both with Node-verifiable acceptance checks at steps 3 and 6. A cheap rig-reduction escape hatch at step 6 (§1.5) precedes the expensive imposter fallback (§1.4). |
| "Enemies read as mannequins at distance" | Six numbered rules (§3.9) with two automated gates (`silhouette.mjs`, `mannequin.mjs`) running from M5. |
| "Blocky finger slabs" | No finger geometry exists. The 3.2 cm threshold in §0 makes it a structural impossibility, not a discipline problem. |
| "Nine material groups per soldier" (implied draw-call blow-up) | One material, one geometry group, one draw call per actor (§3.4, §4.1). Character passes total 57 of 150 draws (§9.3). |
| "Shader compiles during play cost 640–900 ms" | Exactly 4 character programs, all compiled in prewarm against the correct render targets (§10.3), gated by an assertion on `renderer.info.programs.length`. |
| "Readability drowns in FX" | Rarity and telegraph colours are emissive-backed uniforms on a fixed palette (§4.3, §4.5, §6.4); at most one affix may drive the rim; the Maulsmith telegraph has three redundant channels. |
| "Determinism breaks" | The simulation owns the clock and the animator reads it (§6). No presentation path can move a hit tick. Presentation degradation under budget pressure never touches `fixedUpdate` (§9.6). |
