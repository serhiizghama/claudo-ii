# BACKLOG — Claudo II: Lord of Instruction

The specifications say what to build. This says **in what order, in whose
directory, and how you know a piece is finished.**

**Status:** ready to execute. 180 tickets across M0–M9.
Every ticket is 1–3 files, has an explicit owner subsystem, names the
specification section that defines it, and carries an acceptance check that can
be run rather than judged.

---

## How to read a ticket

| Field | Meaning |
|---|---|
| **ID** | `<SUBSYS>-<n>`. Stable forever — a commit message, a branch name and a review all cite it |
| **Files** | The 1–3 files the ticket creates or modifies. A ticket that needs a fourth file is two tickets |
| **Deps** | Ticket ids that must be merged first. Empty means it can start now |
| **Spec** | The section that defines the work. If the spec is silent, the ticket is not ready |
| **Done when** | A command, an assertion id, or a captured frame. Never "looks right" |

**Ownership.** The `SUBSYS` prefix is the directory owner from
`ARCHITECTURE.md`'s ownership map. A ticket never edits a file outside its
owner's directory. Two tickets with different prefixes never touch the same
file, which is what makes the parallel lanes in §"Scheduling" safe.

**Prefixes.** `CORE` `RNDR` `MATL` `SKY` `PHYS` `WRLD` `NAV` `ACTR` `CMBT`
`SKIL` `ITEM` `AI` `PLYR` `FX` `UI` `AUD` `SAVE` `TEST`.

**The definition of done, for every ticket without exception:**
`npm run build` passes, `node tools/capture.mjs` produces a frame, and the
ticket's own check is green. `ARCHITECTURE.md` rule 8 — if you break the boot,
nobody else can work.

---

## Scheduling

The plan's parallelism rule, restated as lanes:

| Phase | Lanes that can run at once | Lane that must run alone |
|---|---|---|
| M0–M1 | — | the whole phase is the critical path |
| M2 | `ACTR` ‖ `CMBT` (they meet at `CMBT-6`) | — |
| M3–M4 | (`ITEM` ‖ `SKIL`), (`NAV` ‖ `AI`), (`UI` ‖ `SAVE`) | — |
| M5–M7 | `WRLD` ‖ `AI` ‖ `ITEM` ‖ `SKIL` ‖ `UI` | — |
| **M8** | **none** | **the entire visual pass, one owner, sequentially** |
| M9 | `AUD` ‖ `TEST` | the perf pass |

M8 is not a scheduling preference. It is the one lesson the source project paid
for: tone mapping, sky, indirect light and materials are a single coupled
system, and parallel agents break each other's assumptions inside it.

---

# M0 — Skeleton

*Goal: a controllable capsule under a 3/4 camera. `capture.mjs` produces a frame.*

| ID | Title | Files | Deps | Spec | Done when |
|---|---|---|---|---|---|
| CORE-1 | Repo, vite, three, MIT notice | `package.json`, `vite.config.js`, `LICENSE-THIRD-PARTY` | — | plan §2 | `npm run dev` serves a blank page; the Claude-of-Duty copyright is present |
| CORE-2 | Port `engine.js`, add `time.step` | `src/core/engine.js` | CORE-1 | ARCH §ctx, 02 C-1/C-2 | `PHYSICS_HZ === 60`, `MAX_SUBSTEPS === 6`, `rawDt` clamped to 0.10 s; `time.step` increments once per fixed step and never from wall clock |
| CORE-3 | Port `registry.js`, topological init | `src/core/registry.js` | CORE-2 | 02 §Init order | `Registry.resolve()` reproduces the documented order; a cyclic `deps` throws at init, not at first use |
| CORE-4 | Allocation-free `EventBus` | `src/core/events.js` | CORE-3 | ARCH §Determinism, 02 C-4 | `12.A03`: 8 handlers, 10 000 emits, 0 bytes allocated |
| CORE-5 | Port `rng.js`, add `weighted()` | `src/core/rng.js` | CORE-1 | plan §1, ARCH rule 4 | `tests/core/rng.test.js`: xoshiro128\*\* reference vectors; `fork()` streams are independent; `weighted()` is uniform over 10⁶ draws |
| CORE-6 | Config and quality presets | `src/core/config.js` | CORE-1 | ARCH §ctx | Four presets carry `maxActors`, `groundItemBudget`, `particleBudget`, `decalBudget`, `shadowMapSize` |
| CORE-7 | Input latching | `src/core/input.js` | CORE-2 | 02 §13 | Pointer and key state are sampled once per frame; reading input inside `fixedUpdate` is impossible by construction |
| CORE-8 | Port `prewarm.js` | `src/core/prewarm.js` | CORE-3 | ARCH §Pre-warm | Calls `prewarmMaterials(ctx)` on every subsystem that implements it, with a render target bound |
| CORE-9 | `main.js` and the boot sequence | `src/main.js` | CORE-3…8 | 11 §1 | The 16 subsystems init in order and the boot log matches `11-flows.md` §1's stage table |
| RNDR-1 | Renderer, HDR target, AgX composite | `src/render/index.js`, `src/render/composite.js` | CORE-9 | plan §5 | A cleared HDR frame reaches the canvas; `outputColorSpace` and `toneMapping` are set before any material compiles |
| RNDR-2 | Camera rig, orbit-locked 3/4 | `src/render/camera.js` | RNDR-1 | ARCH §ctx, plan §5 | FOV 35°, pitch 52°, distance 22 m; nothing but `player` can write it |
| RNDR-3 | Context-loss events | `src/render/index.js` | RNDR-1 | 02 §1, 11 §13.4 | Forcing `WEBGL_lose_context` emits `render:context-lost` and sets `time.scale = 0` |
| PHYS-1 | Uniform grid, statics, `Footprint` | `src/physics/index.js`, `src/physics/grid.js` | CORE-9 | 02 §4 | 10 000 statics hash in ≤ 2 ms; `Footprint` matches 02 §4's record exactly |
| PHYS-2 | Bodies, `moveBody` slide+step | `src/physics/body.js` | PHYS-1 | 02 §4 | A capsule slides along a wall and steps a 0.45 m ledge; `MoveResult` comes from the 32-deep ring |
| ACTR-1 | Actor pool and `SpawnSpec` | `src/actors/index.js`, `src/actors/pool.js` | PHYS-2 | 01 §2 | `spawn`/`despawn`/`ref`/`resolve` round-trip; a recycled slot never resolves through a stale `ActorRef` |
| PLYR-1 | Click-to-move intent, camera follow | `src/player/index.js` | ACTR-1, RNDR-2 | 11 §3 | A capsule walks to the clicked point; `Intent` is latched once per frame |
| TEST-1 | Runner, helpers, state hash | `tests/helpers/*.js`, `package.json` | CORE-5 | 12 §4.1, §7 | `npm test` runs `node --test tests/` |
| TEST-2 | `check-imports`, `check-fixed` | `tools/check-imports.mjs`, `tools/check-fixed.mjs` | TEST-1 | 12 §2.1, §4.5 | Importing `three` into `src/combat/` fails the lint |
| TEST-3 | `capture.mjs`, `imagediff.mjs`, shot `boot_clean` | `tools/capture.mjs`, `tools/imagediff.mjs`, `src/dev/shots.js` | RNDR-1 | 12 §9 | `capture.mjs --shot boot_clean` produces a non-blank PNG; a re-run is pixel-identical |

**M0 gate.** `npm run build`; `capture.mjs --shot boot_clean` non-blank;
`check-imports` green; `12.D07` passes on an empty world.

---

# M1 — World and navigation

*Goal: a character that walks around obstacles without wedging.*

| ID | Title | Files | Deps | Spec | Done when |
|---|---|---|---|---|---|
| PHYS-3 | Casts: circle, ray, cone, rect | `src/physics/cast.js` | PHYS-2 | 02 §4 | All allocation-free (`12.A01`); `lineOfSight` agrees with `rayCast` on 10 000 random pairs |
| PHYS-4 | Separation pass | `src/physics/separate.js` | PHYS-2 | 02 §4 | 40 bodies in a 6 m circle resolve in ≤ 0.4 ms and never overlap by > 1 cm |
| PHYS-5 | Projectile sweep | `src/physics/sweep.js` | PHYS-3 | 02 §4 | A 30 m/s projectile at 60 Hz never tunnels a 0.2 m wall over 10 000 trials |
| WRLD-1 | Coordinates, descriptors, footprint emission | `src/world/index.js`, `src/world/data/zones.js` | PHYS-1 | 07 §1, §12.1 | `staticFootprints` is frozen at `zone:ready`; the four `ZoneDescriptor`s load |
| WRLD-2 | Headless nav rasteriser | `src/world/raster.js` | WRLD-1 | 07 §6, §12.2 | Rasterises 96×96 m from footprints alone, in Node, with no `physics` instance |
| NAV-1 | Grid, flags, regions | `src/nav/index.js`, `src/nav/grid.js` | WRLD-2 | 02 §6, 07 §6 | `regionAt` labels connected components; `nav.version` bumps on rebuild |
| NAV-2 | A\* with a ring budget | `src/nav/astar.js` | NAV-1 | 02 §6, 06 §9 | `12.P09`: worst-case solve ≤ 1 ms; `requestPath` returns 0 when the budget is full, never blocks |
| NAV-3 | String-pull smoothing | `src/nav/smooth.js` | NAV-2 | 02 §6 | A staircase path over 40 m collapses to ≤ 6 nodes and stays walkable |
| NAV-4 | Flow field + `flowVersion` | `src/nav/flow.js` | NAV-1 | 02 §6, 06 §9 | Rebuild ≤ 0.8 ms on 96×96 m; `flowVersion` increments per build |
| NAV-5 | `snap` with the null contract | `src/nav/index.js` | NAV-1 | 02 §6 A-6 | Returns `null` when nothing walkable is inside `maxRadius`; the three call sites branch on it |
| WRLD-3 | Test map + `zone:teardown`/`enter`/`ready` | `src/world/index.js`, `src/world/testmap.js` | NAV-1 | 07 §10, 02 §5 | The emission order is `teardown → enter → physics.rebuild → nav.rebuild → ready`, asserted by a listener log |
| ACTR-2 | `moveTo`, `teleport`, `face`, speed | `src/actors/motion.js` | ACTR-1, PHYS-2 | 02 §7 | `actor.x/z` is written only here; a direct write is caught by a dev-build guard |
| PLYR-2 | Path following and re-pathing | `src/player/move.js` | PLYR-1, NAV-3 | 11 §3 | 200 scripted runs across the test map: zero wedges, zero corner sticks |
| TEST-4 | `nav` unit suite | `tests/nav/*.test.js` | NAV-4 | 12 §4 | `12.P08` and `12.P09` green |

**M1 gate.** The capsule crosses the test map in 200 scripted runs without
wedging; `nav.rebuild ≤ 3 ms`; A\* ≤ 1 ms.

---

# M2 — Actors and combat

*Critical path. Nothing after this milestone works without it.*

| ID | Title | Files | Deps | Spec | Done when |
|---|---|---|---|---|---|
| ACTR-3 | Humanoid rig, 22–24 bones | `src/actors/rig.js` | ACTR-1 | 08 §2, §11.1 | `tools/rigcheck.mjs`: bone counts exact, bind poses valid, no NaN transform |
| ACTR-4 | Geometry toolkit | `src/actors/geom.js` | ACTR-3 | 08 §3, §11.2 | `revolve`, `taper`, `spineRow` produce the documented vertex counts |
| ACTR-5 | Skin binder | `src/actors/skin.js` | ACTR-4 | 08 §4, §11.3 | Weights sum to 1.0 per vertex; ≤ 4 influences; no vertex unbound |
| ACTR-6 | One archetype on screen | `src/actors/archetypes/bone_ranker.js` | ACTR-5 | 08 §11.4 | The Ranker measures 40 ± 3 × 81 ± 4 px in the M2 shot, in **1 draw call** |
| ACTR-7 | `StatBlock` composition, 10 steps | `src/actors/stats.js` | ACTR-1 | 01 §3, §4.2 | E14 reproduces exactly; recompose ≤ 40 µs player, ≤ 6 µs monster |
| ACTR-8 | Vessels, regen, resource accumulators | `src/actors/vessels.js` | ACTR-7 | 01 §3.2, 03 §2 | `spend('all')` works for Resonance; fractional carry never rounds up |
| ACTR-9 | Action state machine | `src/actors/action.js` | ACTR-7 | 02 §7, 08 §6 | Illegal transitions return false; `actionSeq` invalidates a stale hit |
| ACTR-10 | Status instances and the bitfield | `src/actors/status.js` | ACTR-7 | 01 §7 | `hasStatus` is a bit test; `expireBySource` removes exactly the matching set |
| ACTR-11 | Poser and locomotion | `src/actors/poser.js` | ACTR-6 | 08 §5, §11.5 | Walk and run cycles at the documented cadences; no foot slide over 10 m |
| ACTR-12 | Animator, layers, additive mix | `src/actors/anim.js` | ACTR-11 | 08 §6, §11.6 | `upper`/`lower` layering lets a Ranker walk into range while winding up |
| ACTR-13 | Foot IK and contact | `src/actors/ik.js` | ACTR-11 | 08 §7, §11.7 | Feet plant on a 0.45 m step; `actor:footstep` fires on contact with the surface |
| ACTR-14 | Attack timing decomposition | `src/actors/timing.js` | ACTR-12, ACTR-9 | 08 §6.2, §11.8 | wind-up/active/recovery sums to the interval; `active` is never scaled by IAS; `anim:hitframe` fires once |
| CMBT-1 | Packet build B1–B8 | `src/combat/packet.js` | ACTR-7 | 03 §6.1 | E1–E6 reproduce exactly |
| CMBT-2 | To-hit, block, dodge | `src/combat/tohit.js` | CMBT-1 | 03 §5 | `chanceToHit` clamps to 5..95; E7/E8 reproduce |
| CMBT-3 | Resolve pipeline R1–R14 | `src/combat/resolve.js` | CMBT-2 | 03 §6.2 | **E9–E13 reproduce exactly, every intermediate value** |
| CMBT-4 | Statuses, DoT ticking, CC chain | `src/combat/status.js` | CMBT-3, ACTR-10 | 03 §7 | Diminishing returns ×1/0.6/0.36/0.216 then immunity; 4 Hz DoT cadence |
| CMBT-5 | Hit recovery, hit-stop, knockback | `src/combat/reaction.js` | CMBT-3 | 03 §7.11 | Hitstun `0.4/(1+FHR/100)`; hit-stop freezes only the struck actor |
| CMBT-6 | XP award and death | `src/combat/xp.js` | CMBT-3 | 03 §10.5 | `actor:death` is emitted only here; `xpForMonster` reproduces §10.5 |
| CMBT-7 | Life/mana steal, mana return, rage/resonance | `src/combat/onhit.js` | CMBT-3, ACTR-8 | 03 §2.4, 11 §4 | R14(d)/(f) credit in the documented order; a landed hit grants exactly 1 Resonance |
| AI-1 | Bestiary data tables | `src/ai/data/monsters.js` | — | 06 §2, §13.1 | Seven archetypes load in Node; base values equal `03-combat-math.md` §9.1 |
| AI-2 | The `bone_ranker` brain | `src/ai/brains/melee.js` | AI-1, NAV-2, CMBT-3 | 06 §13.2 | It closes, attacks, and dies; `06.S01`–`06.S04` green |
| UI-1 | Skeleton, tokens, i18n | `src/ui/index.js`, `src/ui/style.js`, `src/ui/i18n.js` | CORE-9 | 09 §15 U0 | `ui_clean` shot: 9 nodes; `ui.t('hud.life')` returns both languages |
| TEST-5 | The fourteen worked examples | `tests/combat/examples.test.js` | CMBT-6 | 12 §4.2 | **All of `03.E01`–`03.E14` green** |
| TEST-6 | Allocation probes | `tests/helpers/alloc.js`, `tests/core/alloc.test.js` | CMBT-3 | 12 §4.4 | `12.A01`, `12.A02`, `12.A05` green |

**M2 gate.** E1–E14 reproduce exactly; `12.A01`/`12.A02` pass; a mob damages the
player, the player dies and respawns.

---

# M3 — Loot and inventory

| ID | Title | Files | Deps | Spec | Done when |
|---|---|---|---|---|---|
| ITEM-1 | 75 `ItemBase` records | `src/items/data/bases.js` | — | 04 §12.1 | Loads in Node; the seven reference weapons equal `03-combat-math.md` §4.6 |
| ITEM-2 | 117 `AffixDefinition` records | `src/items/data/affixes.js` | ITEM-1 | 04 §12.2 | 61 prefixes, 56 suffixes, 63 groups, 7 `alvl` bands; every `requiresGroups` intersects a real base group |
| ITEM-3 | Treasure classes and `resolveTC` | `src/items/data/treasure.js` | ITEM-1 | 04 §12.3 | Every class sums to 1000; `resolveTC('tc_humanoid', 33)` → `tc_humanoid_4` |
| ITEM-4 | RNG fork and `rollQuality` | `src/items/roll.js` | ITEM-3, CORE-5 | 04 §12.4 | The ladder reproduces §4.1's split at MF 0 within 0.05 pp over 10⁶ draws |
| ITEM-5 | `rollItem`: base, superior, defence | `src/items/roll.js` | ITEM-4 | 04 §12.5 | Draw order matches the twelve-step contract, checked by `12.D08` |
| ITEM-6 | Affix rolling and `sharedRoll` | `src/items/affix.js` | ITEM-5 | 04 §12.6 | Count model §9.6; one group never appears twice; `sharedRoll` draws once |
| ITEM-7 | The 8 uniques and `uniqueValues` | `src/items/data/uniques.js` | ITEM-6 | 04 §12.7 | Each rolls into `uniqueValues` positionally; a missing array defaults to mins |
| ITEM-8 | Rare naming and the recent ring | `src/items/name.js` | ITEM-6 | 04 §12.8, 13 §10 | 5 000 names, no repeat in any 64-name window |
| ITEM-9 | `rollDrop` end to end | `src/items/drop.js` | ITEM-7, ITEM-8 | 04 §12.9 | `nodrop`, sub-tables, gold, the unique-rank floor, ground scatter, all in order |
| ITEM-10 | Containers, tetris placement, belt | `src/items/container.js` | ITEM-1 | 04 §12.10 | `findPlacement` never mutates; `dropCursor` swaps atomically |
| ITEM-11 | Equipment, `canEquip`, `slotsFor` | `src/items/equip.js` | ITEM-10, ACTR-7 | 04 §12.10 | A ring fits `ring1`/`ring2`; an item never satisfies its own requirement |
| ITEM-12 | Ground items, pickup, decay | `src/items/ground.js` | ITEM-9 | 04 §6 | `groundItemBudget` is respected; `actor:damage` resets the fresh-drop grace |
| ITEM-13 | Identification and durability | `src/items/state.js` | ITEM-11 | 04 §12.12 | `durabilityTick` accrues per kind; `identify` reveals affixes and emits |
| ITEM-14 | Economy: value, repair, vendor | `src/items/economy.js` | ITEM-13 | 04 §12.12 | The 4× spread holds; `currentStock` never draws from a gameplay stream |
| ITEM-15 | Procedural icons | `src/items/icon.js` | ITEM-1, UI-5 | 04 §11, §12.11 | Every base renders to an OffscreenCanvas once and caches |
| ITEM-16 | Save round-trip | `src/items/serial.js` | ITEM-13 | 04 §12.13 | Exactly `01-data-model.md` §5.3's fields plus `uniqueValues`; `rebuildCache` restores |
| UI-2 | Plinth, orbs, XP bar | `src/ui/hud.js` | UI-1, PLYR-1 | 09 §15 U1 | Three resource dialects; a paused frame is byte-identical across two captures |
| UI-3 | Hotbar, belt, prompts, toasts | `src/ui/hotbar.js` | UI-2 | 09 §15 U2 | Belt sweep reads `items.beltCooldown` |
| UI-4 | Damage numbers, feedback layer | `src/ui/feedback.js` | UI-2, CMBT-3 | 09 §15 U3 | Pooled, coalesced at 0.12 s, ≤ 3 live per target, ≤ 24 drawn per frame |
| UI-5 | Tooltip engine | `src/ui/tooltip.js` | UI-1, ITEM-6 | 09 §15 U5 | Line-per-affix from `items.rolledMods`; the all-resistances merge fires |
| UI-6 | Inventory panel and drag/drop | `src/ui/inventory.js` | UI-5, ITEM-10 | 09 §15 U7 | Valid-placement highlight; Esc returns the cursor item |
| UI-7 | Comparison tooltips | `src/ui/tooltip.js` | UI-6 | 09 §15 U9 | Ctrl held while open switches live via `setCompareHeld` |
| TEST-7 | `tools/lootsim.mjs` | `tools/lootsim.mjs` | ITEM-9 | 12 §5.3 | 36 configurations green; `12.D03` passes |
| SAVE-1 | Schema v1 and `validate()` | `src/save/index.js`, `src/save/schema.js` | ITEM-16 | 01 §10 | All 17 invariants, including the amended invariant 4 |

**M3 gate.** `lootsim.mjs` green on 36 configurations; an item can be picked up,
identified, equipped, and the stat block changes.

---

# M4 — Classes and skills (core)

| ID | Title | Files | Deps | Spec | Done when |
|---|---|---|---|---|---|
| SKIL-1 | 30 `SkillDefinition` records, allocation | `src/skills/data/skills.js`, `src/skills/index.js` | — | 05 §14.1 | `05.S01`, `05.S02`, `05.S11`, `05.S12` over all 30; `respec()` round-trips to 29 points |
| SKIL-2 | Costs, cooldowns, three resources | `src/skills/cost.js` | SKIL-1, ACTR-8 | 05 §14.2 | `05.S03`, `05.S04`; §11's three simulations reproduce to ±2 % |
| SKIL-3 | `cleaving_strike` — cone, multi-target | `src/skills/impl/cleaving_strike.js` | SKIL-2, CMBT-1 | 05 §14.3 | A 4-body cone emits 4 hit-requests and **one** rage award |
| SKIL-4 | `ember_bolt`, `rune_strike`, projectile pool | `src/skills/projectile.js`, `src/skills/impl/bolt.js` | SKIL-3 | 05 §14.4 | E13 reproduces (39 damage, 1.7155 mana, +1 Resonance); pierce hits each body once |
| SKIL-5 | Passives | `src/skills/passive.js` | SKIL-2 | 05 §14.5 | Every `passiveStats` key exists in `StatBlock` and respects its cap (`05.S08`) |
| SKIL-6 | Skill-applied statuses | `src/skills/status.js` | SKIL-4, CMBT-4 | 05 §14.6 | `05.S09`: no invented status, no out-of-range magnitude |
| SKIL-7 | Channels and toggles | `src/skills/channel.js` | SKIL-3 | 05 §14.7 | `whirlwind` ticks at **0.55 s**; §12.1's three-target rage equality holds |
| SKIL-8 | Mobility skills | `src/skills/mobility.js` | SKIL-4, NAV-5 | 05 §14.8 | Blink and dash respect `nav.snap`'s null contract |
| SKIL-9 | Ground effects and hazards | `src/skills/ground.js` | SKIL-6, NAV-1 | 05 §14.9 | Every ground effect registers and deregisters `NAV_FLAG.hazard` |
| SKIL-10 | Buffs, absorbs, triggers | `src/skills/buff.js` | SKIL-5 | 05 §14.10 | `buffRemaining`, `absorbRemaining`, `buffList` all read without allocating |
| SKIL-11 | Summons and free-casts | `src/skills/summon.js` | SKIL-10 | 05 §14.11 | `unity` is floored at 4 chains/s by the 0.25 s interval; the pool refuses rather than allocates |
| SKIL-12 | Synergies end to end | `src/skills/synergy.js` | SKIL-11 | 05 §14.12 | All 14 synergies; the graph is acyclic and same-class (`05.S11`) |
| SKIL-13 | `blade_seal` imbue and `cascade` | `src/skills/imbue.js` | SKIL-6 | 05 §6.2, 11 §5.8 | The seal spends the **whole bar**; `imbueHits` decrements only on a landed hit |
| PLYR-3 | Hotbar, cast orders, targeting | `src/player/cast.js` | SKIL-4, PLYR-2 | 11 §5 | All five targeting modes; cost is spent at cast start, never at impact |
| PLYR-4 | Resources, decay, level-up | `src/player/progress.js` | ACTR-8, CMBT-6 | 13 §1 | Rage and Resonance are **not** refilled on level-up |
| UI-8 | Target bar and buff strip | `src/ui/target.js` | UI-2, SKIL-10 | 09 §15 U4 | Champion and boss bars; the strip reads `skills.buffList` |
| UI-9 | Skill tree | `src/ui/tree.js` | UI-1, SKIL-12 | 09 §15 U10 | DOM + SVG links; N vs N+1 from `skills.describe` |
| UI-10 | Character sheet and paperdoll | `src/ui/sheet.js` | UI-6 | 09 §15 U8 | Renders into `ctx.uiScene`; `I` opens sheet and inventory as a pair |
| TEST-8 | `tools/balance.mjs` — skills and builds | `tools/balance.mjs` | SKIL-12 | 12 §5.2 | `05.S01`–`05.S12` and `05.B01`–`05.B11` green; `12.D01` passes |

**M4 gate.** Each class clears the test room with its level-1 skills; Resonance
visibly fills and empties; `balance.mjs --skills` green.

---

# M5 — Zones and bestiary

| ID | Title | Files | Deps | Spec | Done when |
|---|---|---|---|---|---|
| WRLD-4 | `enterZone` skeleton, event contract | `src/world/zone.js` | WRLD-3 | 07 §12.4 | `requestZone` latches; the engine services it between `lateUpdate` and `render` |
| WRLD-5 | Ridgewalk layout, pure function | `src/world/gen/ridgewalk.js` | WRLD-1 | 07 §12.5 | Runs in Node with no `three`; same seed → same layout |
| WRLD-6 | Ashen Wastes geometry and dressing | `src/world/gen/wastes.js` | WRLD-5, MATL-1 | 07 §12.6 | 96×96 m, 4×4 cells; nine instancing groups |
| WRLD-7 | Bonereach BSP generator | `src/world/gen/bonereach.js` | WRLD-5 | 07 §12.9 | 12–18 rooms, guaranteed connectivity, dead ends carry loot |
| WRLD-8 | Altar arena, fixed layout | `src/world/gen/altar.js` | WRLD-6 | 07 §5, §12.10 | G1–G3 hold; the `altar_tablet` interactable is present and inert |
| WRLD-9 | Spawn points and pack descriptors | `src/world/spawn.js` | WRLD-6 | 07 §8, §12.8 | Step 3b assigns `p.mlvl` from `OPENING_RAMP` or the tier formula |
| WRLD-10 | Transitions, retention, town portal | `src/world/transition.js` | WRLD-4 | 07 §10, §12.11 | The 350/600/350 ms envelope; a retained instance is recognised by `(zoneId, seed)` |
| AI-3 | Perception and aggro clouds | `src/ai/perception.js` | AI-2 | 06 §13.3 | Waking one pack member wakes the pack; `ai:pack-alert` fires once |
| AI-4 | Nav integration and the A\* budget | `src/ai/nav.js` | AI-3, NAV-4 | 06 §13.4 | Above 40 actives every agent is on the field; `flowVersion` invalidates a cached distance |
| AI-5 | Crowd: ring slots, lanes, doorways | `src/ai/crowd.js` | AI-4, PHYS-4 | 06 §13.5 | A 12-pack in a 3.0 m corridor presents 3 abreast and never single-files |
| AI-6 | The remaining five archetypes | `src/ai/brains/*.js` | AI-5 | 06 §13.6 | `06.S05`–`06.S17` green |
| AI-7 | Pack templates and the spawn pass | `src/ai/spawn.js` | AI-6, WRLD-9 | 06 §13.7 | `packTemplate` returns frozen records; `mapgen` reports composition headlessly |
| AI-8 | Champions, uniques, the nine affixes | `src/ai/rank.js` | AI-7 | 06 §13.8 | ×4.0 life / ×1.6 damage for champions; `06.MB01`–`06.MB10` green |
| AI-9 | Corpses and resurrection | `src/ai/corpse.js` | AI-8, ACTR-1 | 06 §13.9 | `resurrectableCorpses` sorts by distance then id; killing the Shaman strips `haste_dust` |
| MATL-1 | GPU texture forge, surface palette | `src/materials/index.js`, `src/materials/forge.js` | RNDR-1 | plan §1 | Stone/dirt/grass/ash/bone; triplanar and edge wear present |
| TEST-9 | `tools/mapgen.mjs` | `tools/mapgen.mjs` | WRLD-9 | 12 §5.5 | 5 400 layouts; `07.I01`–`07.I09` green; `12.D02` passes |
| UI-11 | Minimap and ground labels | `src/ui/minimap.js` | UI-2, NAV-1 | 09 §15 U11 | Alt labels coloured by rarity; Tab overlay |

**M5 gate.** `mapgen.mjs` green on 5 400 layouts; a zone is walkable end to end;
`balance.mjs --monsters` green.

---

# M6 — Town, quest, boss — **first playable**

| ID | Title | Files | Deps | Spec | Done when |
|---|---|---|---|---|---|
| WRLD-11 | Last Bastion layout and build | `src/world/town.js`, `src/world/data/town.js` | WRLD-1 | 07 §3, §12.3 | 310 footprints; built once and never disposed; `nav.rebuild` 0.54 ms |
| WRLD-12 | NPCs, chest, stash, gate sealing | `src/world/interact.js` | WRLD-11 | 07 §3, 13 §3.3 | `setExitSealed` flips one `Interactable`; the sealed prompt shows |
| PLYR-5 | Quest state machine | `src/player/quest.js`, `src/player/data/quests.js` | WRLD-12 | 13 §12 L2 | Seven steps; replaying `zone:ready` five times awards the XP **once** |
| PLYR-6 | Progression tables | `src/player/data/progression.js` | CMBT-6 | 13 §12 L1 | `balance.mjs --progression` reproduces §1.4/§1.5 and the three boss levels |
| PLYR-7 | Character creation and starting kits | `src/player/create.js` | PLYR-6, ITEM-11 | 13 §12 L7 | Invariants 3 and 4 pass on all three classes; a Cyrillic name round-trips |
| PLYR-8 | Death, respawn, XP penalty | `src/player/death.js` | PLYR-4 | 11 §8, 13 §1 | −5 % of the current level's band, never a level loss |
| PLYR-9 | Reward grant and the difficulty chain | `src/player/reward.js` | PLYR-5, ITEM-7 | 13 §12 L5, L6 | +1 to all skills on the `quest` layer; a second turn-in returns false |
| AI-10 | Molgrim: three phases | `src/ai/boss.js`, `src/ai/data/molgrim.js` | AI-9, WRLD-8 | 06 §7, §13.10 | `boss:phase` at spawn and each transition; all three phases dodgeable by all three classes |
| AI-11 | Difficulty tiers | `src/ai/difficulty.js` | AI-10 | 06 §13.11 | `+0/+12/+22` imported from `combat`, never redeclared |
| SAVE-2 | localStorage, 3 slots, stash | `src/save/store.js` | SAVE-1 | 01 §10 | Keys match `claudo2.save.v1.*`; a mid-drag autosave keeps `cursorItem` |
| SAVE-3 | Migration framework | `src/save/migrate.js` | SAVE-2 | 01 §10.4 | A `SCHEMA_VERSION` bump without a fixture fails the build |
| UI-12 | Stash, vendor, quest log, dialogue | `src/ui/panels.js` | UI-6, WRLD-12 | 09 §15 U12 | `dialogueLine` and `worldLine` render; five consecutive greetings differ |
| UI-13 | Screens: menu, creation, pause, death | `src/ui/screens.js` | UI-10, PLYR-7 | 09 §15 U13 | `setScreen` covers all six, including `reward_choice` |
| UI-14 | i18n dictionary, 473 keys | `src/ui/i18n.js` | UI-1 | 13 §12 L0 | Boot check reports zero missing; `ui.adj` agrees in RU and falls back safely |
| TEST-10 | `tools/save-fuzz.mjs` | `tools/save-fuzz.mjs` | SAVE-3 | 12 §5.4 | 5 000 round-trips, every migration path, 8 000 corrupt mutants quarantined |
| TEST-11 | `tools/playtest.mjs` | `tools/playtest.mjs` | AI-10, PLYR-9 | 12 §5.6 | `12.B01`–`12.B08` green on three seeds |

**M6 gate.** **The game is completable**: create a character, four descents,
kill Molgrim, take the reward, Trial unlocks. `save-fuzz` green.

---

# M7 — Full trees, uniques, difficulties

| ID | Title | Files | Deps | Spec | Done when |
|---|---|---|---|---|---|
| SKIL-14 | The remaining Ravager skills | `src/skills/impl/ravager.js` | SKIL-12 | 05 §2–§3 | All 10 at all 20 levels; `05.S01`–`05.S12` green for the class |
| SKIL-15 | The remaining Emberwright skills | `src/skills/impl/emberwright.js` | SKIL-12 | 05 §4–§5 | As above |
| SKIL-16 | The remaining Runeblade skills | `src/skills/impl/runeblade.js` | SKIL-13 | 05 §6–§7 | As above; `05.B09` overflow ≤ 30 % on every sinked build |
| SKIL-17 | Respec scroll | `src/skills/respec.js` | SKIL-14…16 | plan §11 | Refunds exactly 29 points and rebuilds the tree in one pass |
| ITEM-17 | Exceptional and elite tiers | `src/items/data/bases.js` | ITEM-1 | 04 §1.8 | The far-end ladders of §1.8 reproduce |
| ITEM-18 | Magic Find and the rarity ladder | `src/items/roll.js` | ITEM-4 | 04 §5 | `lootsim` green at MF 0/50/150/400 |
| AI-12 | Monster affix stat blocks | `src/ai/affix.js` | AI-8 | 06 §6 | All nine; `swift` and `mighty` carry their new audio |
| ACTR-15 | Equipment visuals, four slots | `src/actors/equip.js` | ACTR-6, ITEM-11 | 08 §9, §11.13 | `tools/equipdiff.mjs`: each of the four slots changes the mesh |
| ACTR-16 | Remaining archetypes and the swarm path | `src/actors/archetypes/*.js` | ACTR-12 | 08 §11.10, §11.11 | `silhouette.mjs` distinguishes all six at 62 px |
| ACTR-17 | Death, corpses, gibbing, resurrection | `src/actors/death.js` | ACTR-16 | 08 §11.12 | Corpse budget respected; a Crawler leaves no corpse |
| ACTR-18 | Molgrim's rig and patterns | `src/actors/archetypes/molgrim.js` | ACTR-17, AI-10 | 08 §11.14 | The sweep is a 220° wedge at 4.2 m and reads at the telegraph |
| TEST-12 | `balance.mjs --sweep` | `tools/balance.mjs` | SKIL-16 | 12 §5.2 | **`05.B07` green over 4 158 builds — the M7 gate** |

**M7 gate.** `balance.mjs --sweep`: no build more than 2× from the median.

---

# M8 — Visual pass — **one owner, sequential**

*No parallel tickets. Each depends on the previous. This is deliberate.*

| ID | Title | Files | Deps | Spec | Done when |
|---|---|---|---|---|---|
| MATL-2 | Surface library, wear, triplanar | `src/materials/library.js` | MATL-1 | plan §5 | No flat surface at 1 m under the 3/4 camera |
| MATL-3 | Character material and skin shading | `src/materials/character.js` | MATL-2, ACTR-16 | 08 §11.9 | Six archetypes read distinctly at 62 px |
| SKY-1 | Atmosphere, PMREM, per-zone presets | `src/sky/index.js`, `src/sky/presets.js` | MATL-2 | plan §5 | Four zone moods; `sky:preset` fires on zone change |
| SKY-2 | Volumetric fog and light shafts | `src/sky/fog.js` | SKY-1 | plan §5 | Bonereach reads as interior, the Wastes as open |
| RNDR-4 | Cascaded shadows, 2–3 cascades to 40 m | `src/render/shadow.js` | SKY-1 | plan §5 | Contact shadows land under every actor |
| RNDR-5 | Prepass, GTAO, bloom | `src/render/post.js` | RNDR-4 | plan §5 | Rare items glow; bloom never eats a rarity colour |
| RNDR-6 | SMAA vs TAA — decided by measurement | `src/render/aa.js` | RNDR-5 | plan §5 | The measurement is in the commit message, and the loser is deleted |
| RNDR-7 | Grade LUT and exposure | `src/render/grade.js` | RNDR-6 | plan §5 | Per-zone LUT; the palette holds across all four zones |
| FX-1 | GPU particle system and pools | `src/fx/index.js`, `src/fx/particles.js` | RNDR-5 | 02 §9 | Budgets respected per quality preset |
| FX-2 | Impacts, decals, the atlas | `src/fx/impact.js` | FX-1, MATL-2 | 02 §9 | Every surface type has an impact; the decal ring recycles |
| FX-3 | Projectiles, trails, beams | `src/fx/trail.js` | FX-1 | 02 §9 | Handles recycle silently; a stale handle is a no-op |
| FX-4 | Light slots and world anchors | `src/fx/light.js` | FX-1, WRLD-6 | 07 §11, 02 §9 | **The visible point-light count never changes**; `seconds <= 0` persists |
| FX-5 | Loot glow, telegraphs, ground effects | `src/fx/gameplay.js` | FX-4 | 02 §9 | `readability.mjs` green on `dense_combat` |
| ACTR-19 | Animation polish: springs, overlays | `src/actors/anim.js` | ACTR-18 | 08 §5–§7 | `mannequin.mjs` ≥ 12 % of covered pixels change over 0.50 s |
| TEST-13 | Re-bless the full baseline, once | `tests/fixtures/shots/*.png` | FX-5, ACTR-19 | 12 §11 | **One commit, twelve shots, one review.** Not shot by shot |

**M8 gate.** Adversarial critic: readability 8/10, no flat material, the frame
is comparable to a modern ARPG. `readability`, `silhouette`, `mannequin` green.

---

# M9 — Audio, performance, polish

| ID | Title | Files | Deps | Spec | Done when |
|---|---|---|---|---|---|
| AUD-1 | Skeleton and the no-op-before-start contract | `src/audio/index.js` | CORE-9 | 10 §9.1 | Every call before `start()` is a no-op, never an error |
| AUD-2 | DSP toolkit and the offline harness | `src/audio/dsp.js`, `tools/audio-bench.mjs` | AUD-1 | 10 §9.2 | Offline render reproduces node counts and peaks |
| AUD-3 | Mixer, buses, ducking, master chain | `src/audio/mix.js` | AUD-2 | 10 §9.3 | Four buses; ducking recovers in the documented envelope |
| AUD-4 | Reverb and per-zone IRs | `src/audio/reverb.js` | AUD-3 | 10 §9.4 | IRs generated in code; the zone switch crossfades |
| AUD-5 | Spatial field, panning, distance | `src/audio/spatial.js` | AUD-3 | 10 §9.5 | The listener is at the player, not the camera |
| AUD-6 | Melee family, 20 ids | `src/audio/voices/melee.js` | AUD-5 | 10 §9.6 | `audio-bench` green for section A |
| AUD-7 | Anti-machine-gun rules | `src/audio/limit.js` | AUD-6 | 10 §9.7 | Retrigger guards and per-category caps hold under a 25-monster fight |
| AUD-8 | Spell families, 63 ids | `src/audio/voices/spells.js` | AUD-7 | 10 §9.8 | Sections B–F green, including `skill.polarity.switch` and `echoblade.expire` |
| AUD-9 | Monsters and boss, 66 ids | `src/audio/voices/monsters.js` | AUD-7 | 10 §9.9 | Sections G–I green, including the 12 `monster.footstep.<surface>` ids |
| AUD-10 | Player, items, UI, 63 ids | `src/audio/voices/player.js` | AUD-7 | 10 §9.10 | Sections J–L green |
| AUD-11 | World objects and ambience, 34 ids | `src/audio/voices/world.js` | AUD-7 | 10 §9.11 | Sections M–N green |
| AUD-12 | Generative music, 5 layers | `src/audio/music.js` | AUD-11 | 10 §9.12 | Combat intensity drives layers; scheduling never allocates in `update` |
| AUD-13 | Mix pass and degradation | `src/audio/mix.js` | AUD-12 | 10 §9.13, §9.14 | 263 ids at the documented levels; graceful voice stealing |
| AUD-14 | Live probe | `tools/audio-probe.mjs` | AUD-13 | 10 §9.15 | `AUDIO PROBE: PASS` five runs out of five |
| RNDR-8 | Prewarm every permutation | `src/render/prewarm.js` | CORE-8, FX-5 | ARCH §Pre-warm | **`12.P05`: zero shader compilations after the first frame** |
| CORE-10 | Hit-stop, screen impulse, time scale | `src/core/engine.js` | CMBT-5 | 03 §7.12 | The harness is identical with hit-stop on or off |
| TEST-14 | `tools/profile.mjs` | `tools/profile.mjs` | RNDR-8 | 12 §8 | `12.P01`–`12.P11` measured with hitch attribution |
| TEST-15 | `tools/baseline.mjs`, the 12-shot set | `tools/baseline.mjs`, `src/dev/shots.js` | TEST-13 | 12 §9.1 | Each shot renders in an isolated page; two runs are pixel-identical |
| TEST-16 | CI pipeline, four stages | `.github/workflows/ci.yml` | TEST-14 | 12 §10 | A green run finishes in under 9 minutes |
| UI-15 | Accessibility, budgets, polish | `src/ui/a11y.js` | UI-14 | 09 §15 U14 | Colour-blind modes; `ui` ≤ 1.0 ms; node count ≤ 700 with everything open |

**M9 gate.** 60 fps at 1080p; zero shader compilations in play; `playtest.mjs`
passes 10 consecutive runs; `imagediff` green.

---

## Post-M9 — explicitly not scheduled

Recorded so they are not smuggled into a milestone. Each needs its own decision
before it becomes a ticket.

| Item | Where it was deferred |
|---|---|
| Sockets, runes, crafting recipes | plan §11.2 — the NPC Isa exists as the hook, `socketMax` is reserved in the data model |
| Waypoints inside a zone | plan §11.3 — MVP has the entry and the town portal |
| Stamina and sprint | plan §11.4 — fully specified in `03-combat-math.md` §2.4, `config.stamina` defaults to **false** |
| Multiplayer | plan §11.1 — the event architecture does not forbid it; no network code is written |
| Mutation testing | `12-testing.md` §13 — revisit after M9 if the suite proves permissive |
| A second act | not in scope. The hard rule of plan §10: no new skill, monster or item outside the shipped lists before M7, and no new content at all before M9 |

---

## Ticket count by milestone

| Milestone | Tickets | Cumulative |
|---|---:|---:|
| M0 Skeleton | 19 | 19 |
| M1 World and navigation | 14 | 33 |
| M2 Actors and combat | 24 | 57 |
| M3 Loot and inventory | 24 | 81 |
| M4 Classes and skills | 19 | 100 |
| M5 Zones and bestiary | 17 | 117 |
| M6 Town, quest, boss | 16 | 133 |
| M7 Trees, uniques, difficulties | 12 | 145 |
| M8 Visual pass | 15 | 160 |
| M9 Audio, perf, polish | 20 | 180 |

180 tickets. The estimate in `IMPLEMENTATION_PLAN.md` §9 is 25–35k lines, which
puts the median ticket at roughly 150–200 lines — the size at which one person
holds the whole change in their head and a reviewer can read it in one sitting.
A ticket that grows past 400 lines is two tickets that have not been split yet.
