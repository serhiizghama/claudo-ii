# CLAUDO II: LORD OF INSTRUCTION — engine contract

**Every agent must read this before writing code. It is the only coordination
mechanism.**

Target: a browser action-RPG in the lineage of Diablo II — fixed 3/4 camera,
click-to-move, deep itemisation, skill trees, one seeded act. WebGL2 +
Three.js r180. **No external art assets** — every texture, mesh, animation,
item icon and sound is generated procedurally at load time.

Lineage note: the engine core (`src/core/`), the render/materials/sky/fx
pipeline and `tools/` are derived from `mshumer/Claude-of-Duty` (MIT). Keep the
copyright notice in `LICENSE-THIRD-PARTY`.

---

## Hard rules

1. **You own your directory. Never edit files outside it.** Another agent owns
   every other directory and your edit will be clobbered or will break them.
2. **Never import another subsystem's module.** Get it at runtime:
   `const combat = ctx.get('combat')`. This is what makes parallel work safe.
   `static deps` declares *init order only*, not an import.
3. **No new npm dependencies.** `three` only. No CDN fetches, no external
   images/models/audio — the game must run fully offline from a static build.
4. **No `Math.random()` anywhere.** Use `ctx.rng` or a `ctx.rng.fork()` you keep
   in `init()`. Map layout, loot rolls, affix values, monster packs, crit rolls
   and FX jitter all run through it. A seed must reproduce a run exactly.
5. **Simulation runs in `fixedUpdate` (60 Hz), presentation in `update`.**
   Anything that changes game state — damage, resource drain, AI decisions,
   cooldowns, DoT ticks — happens in `fixedUpdate` and must not read `dt`.
   Interpolate rendered transforms with `ctx.time.alpha`.
6. **Allocate nothing per-frame.** Preallocate vectors, matrices, pools and
   arrays in `init()` and reuse. A `new THREE.Vector3()` inside `update()` is a
   bug. Projectiles, damage numbers, corpses and ground items come from pools.
7. **Dispose what you create.** Geometries, materials, textures, render targets
   and DOM nodes are freed in `dispose()`.
8. `npm run build` must pass and `node tools/capture.mjs` must produce a frame
   after your change. If you break the boot, nobody else can work.
9. **Gameplay numbers live in data, not in code.** Item bases, affixes, skills,
   monsters and treasure classes are plain-object tables under their owning
   subsystem's `data/` folder, so the balance harness can read them headlessly.

---

## Subsystem interface

```js
export class MySystem {
  static id = 'mysystem';       // unique; how others reach you
  static deps = ['render'];     // ids that must init before you

  async init(ctx) {}            // build resources; may await
  fixedUpdate(h, ctx) {}        // 60 Hz, deterministic simulation
  update(dt, ctx) {}            // once per frame — animation, cameras, lerps
  lateUpdate(dt, ctx) {}        // after all update()
  resize(w, h, ctx) {}          // optional
  dispose() {}                  // optional
}
```

`ctx` provides: `scene`, `camera`, `uiScene`, `uiCamera`, `canvas`, `config`,
`events`, `input`, `time`, `rng`, `get(id)`, `peek(id)`, `has(id)`.

- `scene` / `camera` — the world. The camera is orbit-locked: fixed pitch
  (`config.camPitch`, default 52°), fixed yaw, distance from `config.camDist`,
  smoothly following the player. Nothing else may write to it — ask `player`.
- `uiScene` / `uiCamera` — a separate scene for 3D rendered into the HUD (the
  rotating item preview, the character paperdoll). Drawn after the world with a
  cleared depth buffer.
- `time` — `{ elapsed, raw, dt, fixed, alpha, scale, frame, step }`.
  **`step` is the monotonic simulation step index** and it is the clock every
  scheduled field in `01-data-model.md` is written against — `attackReady`,
  `castReady`, `invulnUntil`, `hitstunUntil`, `ccImmuneUntil`, `lastDamageStep`,
  `nextTickStep`, `nextDecisionStep`, `repathAtStep` and the rest. It is
  incremented by the engine immediately before the first `fixedUpdate` of a
  step, is never reset and is never derived from the wall clock. `frame` is the
  **render** frame and is a different number: a frame may run zero steps or six.
  Do not invent a private step counter — two of them drift the first time a
  frame runs two steps.
- Fixed-step constants, also engine-owned: `PHYSICS_HZ = 60`,
  `FIXED_DT = 1/60`, `MAX_SUBSTEPS = 6`, and `rawDt` clamped to `0.10 s` before
  accumulation. Six substeps is exactly `0.10 / (1/60)`, so a frame at the clamp
  is fully consumed and only a stall beyond it sheds time.
- `config.q` — the active quality preset. Respect `q.shadowMapSize`,
  `q.particleBudget`, `q.decalBudget`, `q.maxActors`, `q.groundItemBudget`.
  Never exceed a budget.

---

## Ownership map

| id | directory | owns |
|---|---|---|
| `render` | `src/render/` | WebGLRenderer, HDR pipeline, post-processing, shadows, final composite |
| `materials` | `src/materials/` | procedural PBR texture generation, shared material library, triplanar/detail mapping |
| `sky` | `src/sky/` | sky dome, sun/moon, per-zone lighting mood, IBL/env maps, fog |
| `world` | `src/world/` | zone generation, the hand-authored town, tile kit, props, static colliders, zone transitions, portals |
| `nav` | `src/nav/` | walkability grid, A*, path smoothing, flow fields, crowd separation |
| `physics` | `src/physics/` | 2.5D broadphase, circle/ray/cone casts, actor push-out, projectile sweeps |
| `actors` | `src/actors/` | the actor record, procedural skeletons + animation, stat block, status effects, health/resource state |
| `combat` | `src/combat/` | all combat math: to-hit, damage, resists, crit, block, DoT, threat |
| `skills` | `src/skills/` | skill registry, trees, projectiles, auras, skill effects |
| `items` | `src/items/` | item bases, affixes, rolling, treasure classes, inventory/equipment model, vendors, procedural item icons |
| `ai` | `src/ai/` | monster behaviour, packs, champions/uniques, boss patterns, spawning |
| `player` | `src/player/` | input intent, click targeting, hotbar, resources, level-up, quest state |
| `fx` | `src/fx/` | GPU particles, impacts, decals, ground-item glow, projectile trails |
| `ui` | `src/ui/` | HUD, inventory grid, skill tree, item tooltips, minimap, NPC dialogue, menus |
| `audio` | `src/audio/` | Web Audio synthesis, spatialisation, mix |
| `save` | `src/save/` | localStorage serialisation, schema versioning, character slots, stash |

Shared, owned by the lead (do not edit): `src/core/`, `src/main.js`,
`src/dev/`, `tools/`, `vite.config.js`.

---

## Cross-subsystem events

Emit and listen via `ctx.events`. Payloads are plain objects, pooled where they
fire more than once per frame. The canonical set:

| event | payload | emitted by |
|---|---|---|
| `zone:teardown` | `{ zoneId }` | world |
| `zone:enter` | `{ zoneId, seed, entry }` | world |
| `zone:ready` | `{ zoneId, bounds, navVersion }` | world |
| `nav:rebuilt` | `{ zoneId, navVersion, regionCount }` | nav |
| `actor:spawn` | `{ actor }` | ai / player |
| `actor:despawn` | `{ actor }` | ai |
| `actor:footstep` | `{ actor, foot, x, y, z, surface }` | actors |
| `anim:hitframe` | `{ actor, actionId, actionSeq }` | actors |
| `anim:telegraph` | `{ actor, actionId, seconds }` | actors |
| `combat:hit-request` | `{ source, target, packet }` | skills / ai |
| `actor:damage` | `{ target, source, amount, element, crit, blocked, killed, point }` | combat |
| `actor:heal` | `{ target, amount, source }` | combat |
| `actor:status` | `{ target, status, stacks, duration, source }` | combat |
| `actor:death` | `{ actor, killer, point }` | combat |
| `skill:cast` | `{ actor, skillId, level, target, point }` | skills |
| `skill:impact` | `{ point, element, radius, skillId }` | skills |
| `skill:trigger` | `{ actor, skillId, level }` | skills |
| `skill:channel` | `{ actor, skillId, active }` | skills |
| `projectile:spawn` / `projectile:end` | `{ id, from, to, element }` | skills |
| `loot:drop` | `{ item, point, rarity }` | items |
| `loot:pickup` | `{ item, actor }` | items |
| `item:equip` / `item:unequip` | `{ actor, item, slot }` | items |
| `item:identify` | `{ item }` | items |
| `stats:dirty` | `{ actor }` | items / skills / combat |
| `xp:gain` | `{ actor, amount, source }` | combat |
| `player:levelup` | `{ level, statPoints, skillPoints }` | player |
| `player:resource` | `{ life, maxLife, mana, maxMana, secondary }` | player |
| `quest:update` | `{ questId, state, step }` | player |
| `portal:open` / `portal:use` | `{ from, to, point }` | world |
| `vendor:open` / `vendor:close` | `{ npcId }` | ui |
| `ui:pause` | `{ paused }` | ui |
| `ui:setting` | `{ key, value }` | ui |
| `ui:respec-request` | `{}` | ui |
| `ui:difficulty-request` | `{ tier }` | ui |
| `render:quality` | `{ preset }` | render |
| `sky:preset` | `{ presetId, zoneId }` | sky |
| `boss:phase` | `{ phase, actor }` | ai |
| `ai:pack-alert` | `{ packId, x, z, memberCount }` | ai |
| `ai:priority-target` | `{ actor, reason }` | ai |
| `ai:corpse-raised` | `{ actor, shaman, point }` | ai |
| `save:written` / `save:error` / `save:migrated` | `{ slot, … }` | save |
| `render:context-lost` / `render:context-restored` | `{}` | render |
| `resize` | `{ width, height }` | engine |

Rules:

- **Damage is requested, never applied by the requester.** A skill or a monster
  emits `combat:hit-request` with a *damage packet*; `combat` is the only system
  that resolves it and the only system that emits `actor:damage`.
- **Stat recomputation is lazy.** Anything that changes an actor's derived stats
  emits `stats:dirty`; `actors` rebuilds the stat block once, before the next
  `fixedUpdate` that reads it.
- If you need an event that is not listed, add a row here in the same commit.

### The damage packet

```js
{
  physMin, physMax,          // pre-mitigation physical range
  elem: { fire, cold, light, poison },   // flat elemental, each {min,max,dur?}
  attackRating,              // 0 => always hits (spells)
  critChance, critMult,
  onHitStatus: [{ status, chance, duration, stacks }],
  lifeSteal, manaSteal,
  knockback, sourceSkillId,
}
```

---

## Damage elements and status effects

Elements: `physical`, `fire`, `cold`, `lightning`, `poison`, `magic`.
Statuses: `chilled` (−attack/move speed), `frozen` (no action), `burning` (fire
DoT), `poisoned` (poison DoT, blocks regen), `shocked` (+damage taken),
`stunned`, `slowed`, `bleeding` (physical DoT), `blinded`, `cursed`.

Resistance cap is **75%**. Immunity (≥100%) exists on champion affixes only.

---

## Surface types

Shared vocabulary for impact FX, decals, footsteps and audio. `world` tags every
collider and every ground tile with one of: `stone`, `dirt`, `grass`, `sand`,
`ash`, `wood`, `metal`, `water`, `bone`, `flesh`, `blood`, `crystal`.

---

## Render integration

```js
const r = ctx.get('render');
r.renderer            // THREE.WebGLRenderer — do not change its state outside a frame
r.registerPass(pass)  // insert a custom post pass
r.addLight(light)     // register a punctual light so it participates in culling/budgets
r.requestEnvMap()     // PMREM env map currently in use
r.screenSize          // { width, height } of the internal render target
r.depthTexture        // linear depth, for soft particles
```

Per-object opt-outs, honoured every frame by `render._collect`:

```js
mesh.userData.noPrepass = true   // keep out of the depth/normal prepass
mesh.userData.noShadow  = true   // do not cast into the shadow cascades
```

**The visible point-light count is a shader permutation key.** Three bakes the
number of visible point lights into every material's program cache key, so one
light crossing its cull radius recompiles every lit material in the scene. Any
system registering distance-culled lights (torches, fire spells, glowing loot)
must keep the *visible* count constant: drive `intensity` to 0 and leave
`visible` true, or park zero-intensity ballast lights up to a fixed slot budget.
This cost the source project 640–900 ms hitches — do not rediscover it.

### Pre-warm

`src/core/prewarm.js` runs before the first frame and calls
`prewarmMaterials(ctx)` on every subsystem that implements it. The contract:
**build and compile every material the subsystem can produce, without spawning
gameplay objects, drawing a gameplay frame, or touching the clock/RNG.** A
render target must be bound while compiling — `outputColorSpace` and
`toneMapping` are part of the cache key and are read off the *currently bound*
target.

---

## Determinism contract

The balance and map harnesses depend on this:

- One `ctx.rng.fork()` per subsystem, taken once in `init()`, never re-forked
  per event. Two subsystems must never share a stream.
- Zone layout seeds are `hash(worldSeed, zoneId, runIndex)` — never wall-clock.
- Loot rolls draw from the `items` stream in a fixed order: base → quality →
  affix count → affix pick → affix values. A real drop draws more than those
  five times; the full twelve-step order is in `02-api-contracts.md`
  § Determinism and it is the contract `tools/lootsim.mjs` reproduces.
- Nothing in `fixedUpdate` may read `performance.now()`, `Date.now()` or `dt`.
  Schedule against `ctx.time.step`.
- `EventBus.emit` must not allocate. The obvious implementation copies the
  handler set on every dispatch (`for (const fn of [...set])`); at `actor:damage`
  rates in a 25-monster fight that is a per-frame allocation, which rule 6
  forbids. Use a generation-guarded index walk over a dense array.

---

## Quality bar

- **No flat/untextured surfaces.** Albedo variation, normal map, roughness
  variation, and a detail layer visible at 1 m under the 3/4 camera.
- **Readability first.** This is a top-down game with 60 things on screen: the
  player silhouette, enemy telegraphs and dropped-item labels must never be lost
  in FX. Rarity colours are sacred and must survive bloom and tonemapping.
- **Every action has weight.** Hit-stop on heavy blows, impact FX, a damage
  number, an audio transient, and a screen-space impulse on player damage.
- **Nothing perfectly straight, clean, or repeated.** Varied instance
  rotation/scale, edge wear, grime in crevices.
