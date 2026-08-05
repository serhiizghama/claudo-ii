# 06 — Monsters, AI and the Boss

**Claudo II: Lord of Instruction** — the complete specification for the `ai`
subsystem: the bestiary, the behaviour state machines, perception, packs,
champion and unique affixes, the Molgrim encounter, crowd movement, the
navigation budget, spawning and lifecycle, difficulty tiers, and what the
balance harness asserts about all of it.

**Binding documents.** This document expands, and never contradicts:

| Document | What it binds here |
|---|---|
| `03-combat-math.md` | **Authoritative.** §9 bestiary base rows, monster skills, rank multipliers, affix effects, Molgrim's phase table; §10 `mlvl` and difficulty scaling; §11 the calibration this document must reproduce |
| `01-data-model.md` | `Actor`, `ACTOR_FLAG`, `StatBlock`, `DamagePacket`, `StatusEffectInstance`, `SpawnPoint`, `PackDescriptor`, `Brain` |
| `07-world-gen.md` | The Altar arena (§5), the nav grid (§6), spawn placement (§8). Molgrim's phases are designed to the arena that document specifies, not to a different one |
| `08-characters-visual.md` | §6 the attack timing contract. Every wind-up / active / recovery figure below is that document's, converted to 60 Hz ticks |
| `02-api-contracts.md` | The `ai` and `nav` public surfaces. Six methods this document needs and does not find there are listed in §16 |
| `10-audio.md` | Sound identifiers. Twenty ids this document needs and does not find there are listed in §17 |

Where two binding documents disagree, this document picks one, states the
arithmetic, and records the conflict in **§15**. It invents no stat identifier,
no status, no element and no event that is not either already catalogued or
explicitly requested in §16.

**Scope.** `ai` owns the `Brain` pool, the bestiary and affix tables, pack
instances, boss phase state and the monster spawn decision. It never resolves
damage — it emits `combat:hit-request` and `combat` does the rest. It never
writes `actor.x` / `actor.z` — it calls `actors.moveTo()`. It never builds a
path itself — it asks `nav`. It never places a `SpawnPoint` — `world` does that
and `ai` reads it.

---

## Table of contents

1. [Naming and the bestiary index](#1-naming-and-the-bestiary-index)
2. [Per-monster datasheets](#2-per-monster-datasheets)
3. [Behaviour state machines](#3-behaviour-state-machines)
4. [Perception and aggro](#4-perception-and-aggro)
5. [Pack composition](#5-pack-composition)
6. [Monster affixes](#6-monster-affixes)
7. [Molgrim, the First Instructor](#7-molgrim-the-first-instructor)
8. [Crowd behaviour](#8-crowd-behaviour)
9. [Navigation budget](#9-navigation-budget)
10. [Spawning and lifecycle](#10-spawning-and-lifecycle)
11. [Difficulty tiers](#11-difficulty-tiers)
12. [Validation](#12-validation)
13. [Implementation order](#13-implementation-order)
14. [RNG draw order](#14-rng-draw-order)
15. [Disagreements recorded](#15-disagreements-recorded)
16. [Additions requested to `02-api-contracts.md`](#16-additions-requested-to-02-api-contractsmd)
17. [Additions requested to `10-audio.md`](#17-additions-requested-to-10-audiomd)

---

## 1. Naming and the bestiary index

### 1.1 Canonical identifiers

The `archetypeId` values below are the ones `03-combat-math.md` §9.1 defines and
are the only ones that ship. Two other documents use different display names or
a different id for the same creature; §15 D-1 and D-2 record it. Nothing in the
codebase, no save file and no data table ever uses the alternates.

| `archetypeId` | Name (EN) | Name (RU) | Role | Alternates seen elsewhere |
|---|---|---|---|---|
| `bone_ranker` | Bone Ranker | Костяной ратник | melee | — (was "Bone Ratling" in `08` §6.3; corrected) |
| `carrion_swarm` | Carrion Swarm | Стая падальщиков | swarm | — |
| `ashen_archer` | Ashen Archer | Пепельный лучник | ranged | — (was "Ash Archer" in `08` §6.3; corrected) |
| `dust_shaman` | Dust Shaman | Шаман праха | support | — |
| `maulsmith` | Maulsmith | Молотобоец | heavy | — (was "Hammerfell Brute" in `08` §6.3 and id `hammerfell_brute` in `07` §4.1; both corrected, and the audio ids `brute.*` are now `maulsmith.*`) |
| `blight_crawler` | Blight Crawler | Пузырь-ползун | suicide | — (was "Bloat Crawler" in `08` §2.5, §6.3; corrected) |
| `molgrim` | Molgrim, the First Instructor | Мольгрим, Первый Наставник | boss | — |

Display strings live in `src/ui/i18n.js` keyed by `archetypeId`; the Russian
column is the `ru` dictionary's value, never a second identifier
(`01-data-model.md` conventions).

### 1.2 Where each archetype appears

Zone `bestiary` arrays are `07-world-gen.md`'s (§3.1, §4.1, §5.1). This table is
the same information indexed the other way, and it is what §5's pack templates
are filtered against.

| `archetypeId` | Ashen Wastes | Bonereach | Altar approach | Molgrim adds |
|---|:-:|:-:|:-:|:-:|
| `bone_ranker` | ● | ● | ● | ● |
| `carrion_swarm` | ● | ● | — | — |
| `ashen_archer` | ● | ● | ● | — |
| `dust_shaman` | ● | ● | — | — |
| `maulsmith` | — | ● | — | — |
| `blight_crawler` | ● | ● | — | — |

The Maulsmith is a Bonereach-and-below monster on purpose: it is the first
enemy that cannot be out-traded, and meeting it for the first time in a
corridor rather than in open ground is what makes its telegraph teach anything.

### 1.3 Physical parameters

`mass` values are `03-combat-math.md` §7.12's. `radius` for `bone_ranker` is
`01-data-model.md` §2.3's; for `maulsmith` it is `07-world-gen.md` §6.3's
("the widest agent in the game … at 0.55 m"); for `molgrim` it is
`07-world-gen.md` §5.3 G4's. The remaining four radii and all seven heights are
specified here and are consistent with `01-data-model.md` §2's `0.22 … 1.60`
range.

| `archetypeId` | `radius` (m) | `height` (m) | `mass` (kg) | `hoverY` | `surface` | Knockback at `knockback = 0` |
|---|---:|---:|---:|---:|---|---:|
| `bone_ranker` | 0.38 | 1.85 | 78 | 0.00 | `bone` | 0.528 m |
| `carrion_swarm` | 0.24 | 0.95 | 22 | 0.00 | `flesh` | 0.682 m |
| `ashen_archer` | 0.34 | 1.80 | 68 | 0.00 | `bone` | 0.556 m |
| `dust_shaman` | 0.36 | 1.90 | 70 | 0.00 | `ash` | 0.550 m |
| `maulsmith` | 0.55 | 2.35 | 140 | 0.00 | `metal` | 0.358 m |
| `blight_crawler` | 0.42 | 1.10 | 40 | 0.00 | `flesh` | 0.632 m |
| `molgrim` | 1.10 | 3.20 | 400 | 0.00 | `stone` | immune (`noKnockback`) |

Knockback distances are `03-combat-math.md` §7.12 evaluated at each mass; the
four the source document already tabulates (78, 22, 140, 400) reproduce exactly.

---

## 2. Per-monster datasheets

### 2.0 How to read a datasheet

**Stat tables.** Every row is `bestiaryValue × mlvlMult(n)`, evaluated at full
precision and rounded **once**, with `Math.round`, per `03-combat-math.md`
§10.1. Rank and difficulty multipliers are applied to the same product before
that single rounding, so the table below is the `normal` / Instruction column
and every other combination is derived, never stored.

**Timing.** `attackTime` (`03-combat-math.md` §9.1) is the period **between
attack starts**. `W` / `S` / `R` (`08-characters-visual.md` §6.3) are the
animation phases. Their sum is normally shorter than `attackTime`; the
difference is the **idle tail**, during which the monster may reposition but
may not start another attack. Tick counts use
`08-characters-visual.md` §6.1 exactly:

```
windTicks   = max(2, round(W × 60 × mult))       mult = 1 / (1 + IAS/100)
activeTicks =        round(S × 60)               never scaled
recTicks    = max(1, round(R × 60 × mult))
hitTick     = tick0 + windTicks
```

**Damage packets.** Every packet is built by `combat.buildAttackPacket()` from
the archetype row. `ai` never fills a packet by hand. Unless a row says
otherwise, a monster packet carries `attackRating` = the row's AR,
`attackerLevel` = `mlvl`, `critChance 5`, `critMult 200`, `blockable true`,
`dodgeable true`, and no `onHitStatus` riders.

---

### 2.1 `bone_ranker` — Bone Ranker / Костяной ратник

| Field | Value |
|---|---|
| Role | melee line infantry |
| `mlvl` range | 6 … 33 (Wastes 6/18/28, Bonereach 11/23/33, Altar approach 15/27/37, Molgrim adds `mlvl − 2`) |
| `treasureClass` | `tc_humanoid` |
| `element` | `physical` |
| `flags` | 0 |
| `desiredRange` | 1.9 m |
| Resurrectable | **yes** — the only archetype `dust_shaman` raises |
| Corpse | normal, `resurrectable` for 12.0 s |

**Stat block** (`normal` rank, Instruction; base 20 life, 3–6 damage, 18 DEF,
45 AR, 7 XP):

| `mlvl` | Life | Damage | DEF | AR | XP | flat DR | Move (m/s) |
|---:|---:|---|---:|---:|---:|---:|---:|
| 1 | 20 | 3–6 | 18 | 45 | 7 | 0 | 3.2 |
| 5 | 45 | 6–12 | 40 | 113 | 18 | 0 | 3.2 |
| 10 | 88 | 11–22 | 67 | 199 | 36 | 1 | 3.2 |
| 15 | 144 | 17–33 | 94 | 284 | 60 | 1 | 3.2 |
| 20 | 213 | 24–47 | 121 | 370 | 90 | 2 | 3.2 |
| 25 | 295 | 32–64 | 148 | 455 | 125 | 3 | 3.2 |
| 30 | 389 | 41–82 | 175 | 541 | 166 | 3 | 3.2 |

Resistances (`03-combat-math.md` §9.1): fire 0, cold 25, lightning 0,
poison 50, magic 0, physical 0.

**Attacks**

| id | Type | Range | W | S | R | anim total | idle tail | `W`/`S`/`R` ticks | Packet |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| `attack` | melee arc | 1.9 m | 0.42 | 0.10 | 0.33 | 0.85 s | 0.55 s | 25 / 6 / 20 | `physMin/Max` = row damage, `attackRating` = row AR |
| `shield_guard` | reactive stance | self | 0.14 | 0.46 hold | 0.20 | 0.80 s | — | 8 / 28 / 12 | no packet |

`attack` resolves as a single `physics.overlapCone(x, z, facing, 0.52 rad,
1.9 + targetRadius, MASK.HOSTILE_TO_MONSTER, out)` on `hitTick`, first target
only. The 30° half-angle means a Ranker that has been walked around during its
0.33 s of free facing (`08-characters-visual.md` §6.5) misses.

`shield_guard` (`03-combat-math.md` §9.1: "20 % chance to enter an 0.8 s guard
after being hit, `+40 blockChance` during it"):

| Rule | Value |
|---|---|
| Trigger | on `actor:damage` with `result.outcome === 'hit'`, one `U(0,100) < 20` draw from the `ai` stream |
| Refused while | `actor.state ∈ {windup, active, hitstun, knockback, dead}` |
| Re-entry lockout | 1.60 s from the previous guard's start |
| Effect | `blockChance += 40` for the 0.80 s, applied through the `skills` stat layer as a self-buff |
| Movement | 45 % of `runSpeed` (`08-characters-visual.md` §5.5 `block.hold`) |
| Attacks | none while guarding |
| Ends early on | `stunned`, `frozen`, `knockback`, death |

Monster block bypasses the shield requirement of `03-combat-math.md` §5.3 — see
§15 D-8. **Cost to the player, quantified:** 20 % of landed hits open an 0.80 s
window in which the Ravager (0.675 s interval) lands ~1.2 attacks at 40 % block,
against ~2.37 attacks per 1.60 s lockout period. Expected DPS loss
`0.20 × 1.2 × 0.40 / 2.37 = 4.05 %`, which lifts the level-10 TTK of
`03-combat-math.md` §11.2 from **2.26 s to 2.35 s** — still inside the locked
1.5–3.0 s band. The mechanic is texture, not a wall, and that is deliberate.

**Aggro and leash.** `aggroRadius` 13.0 m, `leashRadius` 34.0 m, perception
half-angle 75°, `proximityRadius` 4.0 m, `hearingRadius` 9.0 m.

**Death.** Normal corpse (`08-characters-visual.md` §8.2), unless the killing
blow was ≥ 35 % of `maxLife` or came from a `burning` affix, in which case it
gibs and leaves nothing (`08-characters-visual.md` §8.4). A gibbed Ranker is not
resurrectable. XP is awarded on every death, including the second death of a
revived Ranker (§10.7).

---

### 2.2 `carrion_swarm` — Carrion Swarm / Стая падальщиков

| Field | Value |
|---|---|
| Role | fast, weak, numerous; surrounds |
| `mlvl` range | 6 … 33 |
| `treasureClass` | `tc_beast` |
| `element` | `physical` |
| `flags` | 0 |
| `desiredRange` | 1.4 m |
| Pack minimum | **6** members; templates that include it force `count ≥ 6` |
| Corpse | **never** — always gibs (§10.6) |

**Stat block** (base 9 life, 2–3 damage, 12 DEF, 38 AR, 3 XP):

| `mlvl` | Life | Damage | DEF | AR | XP | flat DR | Move (m/s) |
|---:|---:|---|---:|---:|---:|---:|---:|
| 1 | 9 | 2–3 | 12 | 38 | 3 | 0 | 5.4 |
| 5 | 20 | 4–6 | 26 | 96 | 8 | 0 | 5.4 |
| 10 | 40 | 7–11 | 44 | 168 | 16 | 1 | 5.4 |
| 15 | 65 | 11–17 | 62 | 240 | 26 | 1 | 5.4 |
| 20 | 96 | 16–24 | 80 | 312 | 39 | 2 | 5.4 |
| 25 | 133 | 21–32 | 98 | 385 | 54 | 3 | 5.4 |
| 30 | 175 | 27–41 | 116 | 457 | 71 | 3 | 5.4 |

Resistances: fire 0, cold 0, lightning 0, poison 25, magic 0, physical 0.

**Attacks**

| id | Type | Range | W | S | R | anim total | idle tail | ticks | Packet |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| `attack` | bite | 1.4 m | 0.22 | 0.06 | 0.26 | 0.54 s | 0.21 s | 13 / 4 / 16 | row damage, row AR, `knockback 0` |

At 5.4 m/s the Swarm is **faster than every class** (4.0–4.3 m/s). It cannot be
outrun, only killed or blocked. That is the whole reason its life is 9 at base:
two hits from any build, one from a crit.

**Surround behaviour.** See §8.2. In summary: members claim slots on a ring of
radius `playerRadius + 0.24 + 1.4 = 2.00 m`, spaced by `2.6 × radius = 0.624 m`
of arc, giving **20 slots** — never the binding constraint at a pack size of
6–12.

**Scatter.** `03-combat-math.md` §9.1: "the pack scatters for 3 s once its
alive count drops below 40 %".

| Rule | Value |
|---|---|
| Condition | `pack.aliveCount / pack.count < 0.40`, evaluated on `actor:death` |
| Effect | every surviving member enters `flee`, `fleeUntilStep = now + 180` |
| Destination | `nav.snap(player + 12.0 m × away, 3.0)`; if `snap` fails, the pack centre |
| Fires | **once per pack per zone visit** — a second scatter would make the last two members unkillable |
| Sound | `swarm.scatter` |

**Aggro and leash.** `aggroRadius` 15.0 m, `leashRadius` 40.0 m, perception
half-angle 110°, `proximityRadius` 5.0 m, `hearingRadius` 12.0 m.

**Death.** Always a gib burst, never a corpse. Swarm members are drawn from a
single `InstancedMesh` (`08-characters-visual.md` §9.5) and cannot join the
per-faction corpse `BatchedMesh`; a corpse would need a second draw call per
body and a swarm's corpses are visual noise besides.

---

### 2.3 `ashen_archer` — Ashen Archer / Пепельный лучник

| Field | Value |
|---|---|
| Role | ranged; kites, retreats inside 6 m |
| `mlvl` range | 6 … 37 |
| `treasureClass` | `tc_humanoid` |
| `element` | `physical` |
| `flags` | `ranged` |
| `desiredRange` | 11.0 m (the centre of the hold band) |
| Corpse | normal, **not** resurrectable |

**Stat block** (base 15 life, 3–7 damage, 14 DEF, 52 AR, 8 XP):

| `mlvl` | Life | Damage | DEF | AR | XP | flat DR | Move (m/s) |
|---:|---:|---|---:|---:|---:|---:|---:|
| 1 | 15 | 3–7 | 14 | 52 | 8 | 0 | 3.6 |
| 5 | 34 | 6–14 | 31 | 131 | 20 | 0 | 3.6 |
| 10 | 66 | 11–25 | 52 | 230 | 41 | 1 | 3.6 |
| 15 | 108 | 17–39 | 73 | 329 | 69 | 1 | 3.6 |
| 20 | 159 | 24–55 | 94 | 427 | 103 | 2 | 3.6 |
| 25 | 221 | 32–74 | 115 | 526 | 143 | 3 | 3.6 |
| 30 | 292 | 41–96 | 136 | 625 | 190 | 3 | 3.6 |

Resistances: fire 25, cold 0, lightning 0, poison 0, magic 0, physical 0.

**Attacks**

| id | Type | Range | W | S | R | anim total | idle tail | ticks | Packet |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| `ash_shot` | projectile | 14.0 m | 0.66 | 0.04 | 0.40 | 1.10 s | 0.60 s | 40 / 2 / 24 | 100 % of row damage, row AR, `pierceChance 0` |

`ProjectileSpec` for `ash_shot`: `speed 22`, `lifetime 0.70 s`, `radius 0.18`,
`pierce false`, `gravity 0`, `homing 0`, `maxTargets 1`, `chain null`. Flight
time at maximum range is `14.0 / 22 = 0.636 s`, inside the 0.70 s lifetime with
0.064 s of margin — an arrow that reaches its range limit expires rather than
falling short of a target that stepped back.

The shot is **fired at the player's position at `hitTick`**, not led. A player
moving laterally at 4.0 m/s at 14 m displaces `4.0 × 0.636 = 2.54 m` during the
flight and is missed. Strafing beats archers; standing still does not. Requires
`physics.lineOfSight(archer, target, MASK.WORLD)` at `hitTick`, else the shot is
withheld and the archer re-enters `reposition`.

**Kiting bands.** Full state machine in §3.5.

| Band | Distance to target | Behaviour |
|---|---|---|
| **retreat** | < 6.0 m | back away at full 3.6 m/s along `away`, no attacks |
| **hold** | 6.0 … 14.0 m | fire `ash_shot` on cooldown; strafe ±1.2 m between shots to break the player's aim |
| **approach** | > 14.0 m | close on the flow field until 11.0 m |

Hysteresis: retreat ends at **8.0 m**, not 6.0 m, so an archer at the boundary
does not oscillate. The player closes at 4.0–4.3 m/s against a 3.6 m/s retreat,
a net 0.4–0.7 m/s, so an archer **always** loses a straight chase — it buys
about 5 s and drags the player off the pack's centre, which is its job.

**Cornered rule.** If `nav.raycastNav` along the retreat direction fails within
1.5 m, switch to tangential retreat (strafe along the wall, direction chosen
once by the sign of the cross product, held until it also fails). If both fail
for 1.0 s continuously, the archer commits: it fires at point-blank with
`ash_shot` and stops retreating. An archer that cowers in a corner forever is
worse than one that shoots you.

**Aggro and leash.** `aggroRadius` 18.0 m — the longest of any normal monster,
because a ranged unit that has to be walked into is not a ranged unit.
`leashRadius` 38.0 m, perception half-angle 60°, `proximityRadius` 4.0 m,
`hearingRadius` 10.0 m.

**Death.** Normal corpse. In-flight `ash_shot` projectiles survive their
owner's death and resolve normally — the packet already carries `sourceId` and
`sourceGen`, and `combat` credits XP to a dead source without incident.

---

### 2.4 `dust_shaman` — Dust Shaman / Шаман праха

| Field | Value |
|---|---|
| Role | support; resurrects, buffs. **Priority target** |
| `mlvl` range | 6 … 33 |
| `treasureClass` | `tc_caster` |
| `element` | `physical` (its bolt is a physical dust shard, not an element) |
| `flags` | `ranged` |
| `desiredRange` | 8.0 m |
| Corpse | normal, not resurrectable |

**Stat block** (base 17 life, 2–5 damage, 15 DEF, 40 AR, 12 XP):

| `mlvl` | Life | Damage | DEF | AR | XP | flat DR | Move (m/s) |
|---:|---:|---|---:|---:|---:|---:|---:|
| 1 | 17 | 2–5 | 15 | 40 | 12 | 0 | 3.4 |
| 5 | 38 | 4–10 | 33 | 101 | 30 | 0 | 3.4 |
| 10 | 75 | 7–18 | 55 | 177 | 62 | 1 | 3.4 |
| 15 | 122 | 11–28 | 78 | 253 | 103 | 1 | 3.4 |
| 20 | 181 | 16–39 | 101 | 329 | 154 | 2 | 3.4 |
| 25 | 250 | 21–53 | 123 | 405 | 215 | 3 | 3.4 |
| 30 | 331 | 27–68 | 146 | 481 | 285 | 3 | 3.4 |

Resistances: fire 25, cold 25, lightning 25, poison 25, magic 0, physical 0.
The flat 25 across four elements is what makes it survive a stray AoE and
forces the player to target it deliberately — which is the entire point of a
priority target.

**Attacks**

| id | Type | Range | W | S | R | anim total | idle tail | ticks | Packet |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| `dust_bolt` | projectile | 9.0 m | 0.50 | 0.06 | 0.42 | 0.98 s | 0.62 s | 30 / 4 / 25 | 100 % of row damage, row AR |
| `raise_ranker` | ritual | 8.0 m | **1.05** | 0.10 | 0.55 | 1.70 s | — | 63 / 6 / 33 | no packet |
| `haste_dust` | pack buff | 10.0 m radius | 0.55 | 0.08 | 0.40 | 1.03 s | — | 33 / 5 / 24 | no packet |

`dust_bolt` has no row in `08-characters-visual.md` §6.3 and is specified here;
§15 D-9 records it. Its `ProjectileSpec` is `speed 18`, `lifetime 0.65 s`,
`radius 0.20`, no pierce, no homing, `maxTargets 1`.

**`raise_ranker`** — `03-combat-math.md` §9.2: "every 8.0 s, revives 1
`bone_ranker` corpse within 8.0 m at 60 % life; the revived actor gets
`ACTOR_FLAG.revived` and can never be revived again; 1 credit per shaman per
zone visit".

| Rule | Value |
|---|---|
| Cooldown | 8.0 s (Instruction); 6.5 s Trial; 5.0 s Renunciation (§11.3) |
| Credits | `Brain.reviveCredits = 1` at spawn, never refilled |
| Wind-up | **1.05 s, never scaled by IAS** (`08-characters-visual.md` §6.2) |
| Candidate query | `actors.resurrectableCorpses(shaman.x, shaman.z, 8.0, out)` — §16 A2 |
| Eligibility | `bone_ranker`, corpse age < 12.0 s, not gibbed, `resurrectCount === 0`, on walkable nav (`08-characters-visual.md` §8.5). The 8.0 m query radius is strictly inside that document's 9.0 m eligibility radius, so both hold (§15 D-6) |
| Target order | **nearest first, ties by ascending corpse id** (`08-characters-visual.md` §8.5). Deterministic; no RNG draw |
| Credit spend | on **`hitTick`**, not on cast start |
| Interruption | `stunned` / `frozen` / death during the wind-up cancels the cast and **refunds the credit** (`08-characters-visual.md` §6.6). This is the counter-play: stun the Shaman |
| Result | `actors.resurrect(handle, 0.60)`, then `ai` creates a fresh `Brain` (§10.7) |
| Retired | when `reviveCredits === 0`, `raise_ranker` leaves the action set entirely and the Shaman falls back on `haste_dust` and `dust_bolt` |
| Telegraph | ground rune decal `r = 2.0 m` from `t = 0.20 s` (`08-characters-visual.md` §6.3) |
| Sound | `shaman.resurrect` |

**`haste_dust`** — `03-combat-math.md` §9.2: "every 12.0 s, pack buff radius
10 m: `+25 increasedAttackSpeed`, `+20 movementSpeed` for 6.0 s".

| Rule | Value |
|---|---|
| Cooldown | 12.0 s |
| Targets | every actor with `team === TEAM.monster` within 10.0 m, including the Shaman itself, **excluding** actors that already carry the buff |
| Cast condition | at least **3** eligible targets, or the pack's `aliveCount ≤ 3` |
| Duration | 6.0 s |
| Applied via | the `skills` buff layer, `sourceId` = the Shaman |
| On the Shaman's death | **every `haste_dust` instance it granted expires immediately** — `combat.expireBySource(shamanId, shamanGen, 'haste_dust')`, §16 A3. This is the tell that killing the support mattered, and it is legible without a UI element |
| Sound | `shaman.haste`, and `shaman.buff.expire` on the early cancel (§17) |

Quantified: a `pk_warband` of 8 at `mlvl 10` deals **43.66 DPS** to the level-10
reference Ravager unbuffed and **54.57 DPS** under `haste_dust`; time-averaged
over the 12 s cycle that is **49.12 DPS**, cutting the Ravager's stand-still
survival from 3.78 s to **3.36 s** (§5.5).

**Priority target.** `ai` publishes every live `dust_shaman` actor id through
`ai.priorityTargets` (§16 A4); `ui` draws the marker. `ai` itself does nothing
with the flag — a monster's threat model has no notion of protecting it.

**Aggro and leash.** `aggroRadius` 16.0 m, `leashRadius` 36.0 m, perception
half-angle 70°, `proximityRadius` 4.0 m, `hearingRadius` 11.0 m.

---

### 2.5 `maulsmith` — Maulsmith / Молотобоец

| Field | Value |
|---|---|
| Role | heavy; slow, enormous damage, committed telegraph |
| `mlvl` range | 11 … 33 (Bonereach only) |
| `treasureClass` | `tc_heavy` |
| `element` | `physical` |
| `flags` | `noKnockback` **while `actor.state === 'windup'` only** |
| `desiredRange` | 2.6 m |
| Corpse | normal, not resurrectable |

**Stat block** (base 42 life, 9–18 damage, 26 DEF, 55 AR, 16 XP):

| `mlvl` | Life | Damage | DEF | AR | XP | flat DR | Move (m/s) |
|---:|---:|---|---:|---:|---:|---:|---:|
| 1 | 42 | 9–18 | 26 | 55 | 16 | 0 | 2.4 |
| 5 | 94 | 18–36 | 57 | 139 | 41 | 0 | 2.4 |
| 10 | 185 | 32–65 | 96 | 243 | 83 | 1 | 2.4 |
| 15 | 302 | 50–100 | 135 | 348 | 138 | 1 | 2.4 |
| 20 | 447 | 71–142 | 174 | 452 | 206 | 2 | 2.4 |
| 25 | 619 | 95–191 | 213 | 557 | 286 | 3 | 2.4 |
| 30 | 818 | 123–246 | 252 | 661 | 380 | 3 | 2.4 |

Resistances: fire 0, cold 0, lightning **−25**, poison 25, magic 0,
physical **15**. The lightning vulnerability is a deliberate, legible signal:
the Runeblade's `blade_seal` lightning imbue is the fastest answer to a
Maulsmith of the three classes (§2.7).

**Attacks**

| id | Type | Radius | W | S | R | anim total | idle tail | ticks | Packet |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| `crushing_slam` | ground AoE | **3.2 m** | **1.20** | 0.14 | 0.85 | 2.19 s | 0.01 s | 72 / 8 / 51 | **220 %** of row damage, row AR, `knockback 100 %` |

`crushing_slam` is the Maulsmith's *only* attack. Its `attackTime` of 2.20 s and
its 2.19 s animation leave a 0.01 s idle tail, so the Maulsmith is essentially
always mid-slam. At `mlvl 15` that is `110–220` per landed hit before
mitigation, on a reference character with 210 life — a single slam is 52–105 %
of the player's health bar and is meant to be.

**Telegraph commitment.** This is the archetype's entire design and it is
specified by `08-characters-visual.md` §6.2, §6.4 and §6.5, restated here as the
contract `ai` must honour:

| Property | Value | Source |
|---|---|---|
| Wind-up | 1.20 s at IAS 0, **floored at 0.90 s** however much IAS it has | `08` §6.2 |
| `swift` affix (+60 IAS) | `mult = 0.625`, `1.20 × 0.625 = 0.75 s` → **floored to 0.90 s**; `S` unchanged; `R` = `0.85 × 0.625 = 0.53 s`. Total 1.57 s | derived |
| Facing free | first **40 %** of the wind-up (0.48 s at IAS 0, 0.36 s floored) | `08` §6.5 |
| Facing locked | remaining 60 %, the whole active window, and the first 60 % of recovery | `08` §6.5 |
| Ground decal | emitted at wind-up tick 9, `shape 'disc'`, `radius 2.6`, growing to full over the remaining wind-up | `08` §6.4 |
| Cancellable by | `stunned` and `frozen` only. A hit that does not stun cancels nothing | `08` §6.6 |
| `noKnockback` | set for the duration of the wind-up, cleared on the active tick | `01` §2.1 |

**`ai` may not start a `crushing_slam` it has any reason to abort.** Once the
wind-up begins, the brain's decision cadence for that actor drops to 12 ticks
and the only transition available is `attack → hitstun` (on a stun) or
`attack → dead`. There is no target re-acquisition, no re-aim and no cancel.
A telegraph the monster can take back is not a telegraph.

**Escape margin.** A player standing at their own melee range is at
`0.36 + 0.55 + 1.9 = 2.81 m` from the Maulsmith's centre (Ravager, Battle Axe).
The slam catches circles overlapping a 3.2 m disc, so the escape line is
`3.2 + 0.36 = 3.56 m` — **0.75 m of travel**.

| Case | Committed window | Required speed | Ravager 4.2 | Emberwright 4.0 | Runeblade 4.3 |
|---|---:|---:|---:|---:|---:|
| IAS 0 | 0.72 s | 1.04 m/s | **4.03×** | **3.84×** | **4.13×** |
| `swift` champion, floored | 0.54 s | 1.39 m/s | **3.02×** | **2.88×** | **3.10×** |

The floor is what keeps the second row above 2×; without it a `swift` Maulsmith
would commit at 0.30 s and the margin would fall to 1.68×, which is the reason
`08-characters-visual.md` §6.2 calls the floor "the telegraph's contract with
the player".

**Aggro and leash.** `aggroRadius` 12.0 m — the shortest, because a 2.4 m/s
monster that notices you from across a hall is just a slow inevitability.
`leashRadius` 30.0 m, perception half-angle 55°, `proximityRadius` 3.5 m,
`hearingRadius` 8.0 m.

**Death.** Normal corpse. Death during the wind-up **cancels** the slam and no
`combat:hit-request` is emitted; death during the active window leaves an
already-emitted request standing (`08-characters-visual.md` §6.6). Sound
`maulsmith.death`.

---

### 2.6 `blight_crawler` — Blight Crawler / Пузырь-ползун

| Field | Value |
|---|---|
| Role | suicide; sprints and detonates in poison |
| `mlvl` range | 6 … 33 |
| `treasureClass` | `tc_beast` |
| `element` | `poison` |
| `flags` | 0 |
| `desiredRange` | 1.2 m |
| Corpse | **never** — always detonates, always gibs |

**Stat block** (base 12 life, 8–14 damage, 10 DEF, 30 AR, 6 XP). The damage
column is the **poison total of its detonation**, not a melee swing — the
Crawler has no ordinary attack.

| `mlvl` | Life | Poison total | DEF | AR | XP | flat DR | Move (m/s) |
|---:|---:|---|---:|---:|---:|---:|---:|
| 1 | 12 | 8–14 | 10 | 30 | 6 | 0 | 4.6 |
| 5 | 27 | 16–28 | 22 | 76 | 15 | 0 | 4.6 |
| 10 | 53 | 29–50 | 37 | 133 | 31 | 1 | 4.6 |
| 15 | 86 | 44–78 | 52 | 190 | 52 | 1 | 4.6 |
| 20 | 128 | 63–110 | 67 | 247 | 77 | 2 | 4.6 |
| 25 | 177 | 85–148 | 82 | 304 | 107 | 3 | 4.6 |
| 30 | 234 | 110–192 | 97 | 361 | 142 | 3 | 4.6 |

Resistances: fire 0, cold **−25**, lightning 0, poison 75, magic 0,
physical 0.

**`detonate`**

| Property | Value | Source |
|---|---|---|
| W / S / R | 0.85 / 0.05 / — (it dies) | `08` §6.3 |
| Ticks | 51 / 3 / — | derived |
| IAS scaling | **none, ever** — "a fuse that gets shorter with an affix is a death sentence with no counter-play" | `08` §6.2 |
| Damage radius | **3.0 m** | `03` §9.2 |
| Telegraph decal | disc `r = 3.2 m` from `t = 0.25 s`, sac swell 1.00 → 1.35, `uGlow` 0 → 3.0 | `08` §6.3 |
| Packet | `poisonMin/Max` = the row's poison total, `poisonDuration 1.0` (giving `4.0 + 1.0 = 5.0 s`, `03` §9.2), `attackRating 0` (always hits), `dodgeable false`, `blockable false` | derived |
| Result | the Crawler dies; no corpse; gib burst | `08` §8.4 |
| Sound | `crawler.inflate` on the fuse, `crawler.death` on the burst | `10` §5.1 G |

**Trigger conditions**, in evaluation order:

| # | Condition | Fuse start |
|---|---|---|
| T1 | `dist(crawler, target) ≤ 1.2 m` (`attackRange`) with line of sight | immediately |
| T2 | the Crawler's life would drop to ≤ 0 from any source | immediately, and the lethal damage is applied **after** the fuse starts, so the Crawler survives its own fuse and detonates 0.85 s later at 1 life |
| T3 | sympathetic chain (below) | after a 0.25 s sympathetic delay |
| T4 | `stateTime` in `chase` exceeds 25.0 s without reaching T1 | immediately — a Crawler that can never reach its target removes itself rather than orbiting forever |

T2 is what makes the Crawler interesting: killing it at range does not defuse
it, it *is* the detonation. The counter is distance, not damage.

**Escape analysis — honest.** At 4.6 m/s the Crawler is faster than every class.
A player at 3.36 m when the fuse lights must reach `3.0 + 0.36 = 3.36 m` from a
target that is closing at `4.6 − 4.2 = 0.4 m/s`; they cannot. **The detonation
is not dodgeable by running once the fuse is lit**, and it is not meant to be.
It is survivable instead:

| Tier | Poison total | vs reference life | % of max life over 5 s |
|---|---|---|---|
| Wastes, `mlvl 6` | 20–35 (avg 27) | Ravager 95 @ clvl 5 | 21–37 % |
| Bonereach, `mlvl 11` | 32–56 (avg 44) | Ravager 175 @ clvl 13 | 18–32 % |
| Altar, `mlvl 15` | 44–78 (avg 61) | Ravager 210 @ clvl 13 | 21–37 % |

Roughly a quarter of the bar, spread over five seconds at 4 Hz, with
`lifeRegen` forced to 0 for the duration (`03-combat-math.md` §7.5). It is a
tax, not a kill — which is why the Crawler's life is 12 at base and every build
one-shots it at range. The correct play is to see it coming and delete it
before T1; the punishment for missing that is a potion, not a death.

**Friendly damage and the sympathetic chain.**

| Rule | Detail |
|---|---|
| Packet team | `team = TEAM.monster`. `combat` applies it to hostiles only, so **no monster is ever damaged by a Crawler** |
| Player summons | `echo_blade` carries `ACTOR_FLAG.visualOnly` and takes no damage; nothing else on the player's team can be hit. In practice the cloud hits exactly one actor: the player |
| **Chain** | On detonation, `ai` runs `physics.overlapCircle(x, z, 3.0, MASK.ACTORS, out)` and, for every `blight_crawler` in the result whose fuse is not already lit, lights it with a **0.25 s** sympathetic delay |
| Chain depth | `brain.chainDepth = parent.chainDepth + 1`, hard cap **3**. A Crawler at depth 3 does not propagate |
| Chain determinism | candidates are processed in ascending `actorId`; no RNG |
| Tier gate | the chain is **off at Instruction** and on at Trial and Renunciation (§11.3) |
| Sound | `crawler.chain.fuse` (§17) at 0.6× the gain of `crawler.inflate` |

The chain is the mechanic, not the friendly fire. A cluster of four Crawlers is
a bomb the player can set off from 12 m with one `ember_bolt`, at a cost of
0.25 s per link — 0.75 s of visible, audible propagation for the whole cluster.
Monster-to-monster damage was considered and rejected: it turns every mixed
pack into an accident, it makes the Crawler's spawn placement load-bearing, and
it gives the player a free win for doing nothing.

**Aggro and leash.** `aggroRadius` 17.0 m, `leashRadius` 44.0 m — the longest,
because a Crawler that gives up is a Crawler that has failed at the one thing it
does. Perception half-angle 130°, `proximityRadius` 6.0 m, `hearingRadius`
14.0 m.

---

### 2.7 The bestiary against the three reference builds

`03-combat-math.md` §11.2 calibrates one monster — the Bone Ranker at `mlvl 10`
— against the three level-10 reference builds of §11.1. This table extends the
same arithmetic to all six archetypes at the same level, using the same
per-landed-hit figures (Ravager `33.810` physical after flat DR 1; Emberwright
`22.313` fire per cast; Runeblade `22.57` physical + `18.45` lightning per
landed swing) and the same intervals (0.675 s / 0.4675 s / a 2.200 s three-swing
cycle). Only the target's DEF and resistances change.

**Ravager** — AR 235, `alvl 10`:

| Target | Life | DEF | Hit % | Per landed hit | DPS | **TTK** | Hits |
|---|---:|---:|---:|---:|---:|---:|---:|
| `bone_ranker` | 88 | 67 | 77.81 | 33.810 | 38.97 | **2.26 s** | 3.35 |
| `carrion_swarm` | 40 | 44 | 84.23 | 33.810 | 42.19 | **0.95 s** | 1.41 |
| `ashen_archer` | 66 | 52 | 81.88 | 33.810 | 41.01 | **1.61 s** | 2.39 |
| `dust_shaman` | 75 | 55 | 81.03 | 33.810 | 40.59 | **1.85 s** | 2.74 |
| `maulsmith` | 185 | 96 | 71.00 | 28.738 | 30.23 | **6.12 s** | 9.07 |
| `blight_crawler` | 53 | 37 | 86.40 | 33.810 | 43.28 | **1.22 s** | 1.81 |

**Emberwright** — `ember_bolt` slvl 5, always hits:

| Target | Life | Fire resist | Per cast | DPS | **TTK** | Casts |
|---|---:|---:|---:|---:|---:|---:|
| `bone_ranker` | 88 | 0 | 22.313 | 47.73 | **1.84 s** | 3.94 |
| `carrion_swarm` | 40 | 0 | 22.313 | 47.73 | **0.84 s** | 1.79 |
| `ashen_archer` | 66 | 25 | 16.735 | 35.80 | **1.84 s** | 3.94 |
| `dust_shaman` | 75 | 25 | 16.735 | 35.80 | **2.09 s** | 4.48 |
| `maulsmith` | 185 | 0 | 22.313 | 47.73 | **3.88 s** | 8.29 |
| `blight_crawler` | 53 | 0 | 22.313 | 47.73 | **1.11 s** | 2.38 |

**Runeblade** — AR 240, three imbued swings per 2.200 s cycle:

| Target | Life | DEF | Phys res | Light res | Hit % | Per landed hit | DPS | **TTK** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `bone_ranker` | 88 | 67 | 0 | 0 | 78.18 | 41.02 | 43.73 | **2.01 s** |
| `carrion_swarm` | 40 | 44 | 0 | 0 | 84.51 | 41.02 | 47.27 | **0.85 s** |
| `ashen_archer` | 66 | 52 | 0 | 0 | 82.19 | 41.02 | 45.98 | **1.44 s** |
| `dust_shaman` | 75 | 55 | 0 | 25 | 81.36 | 36.41 | 40.39 | **1.86 s** |
| `maulsmith` | 185 | 96 | 15 | **−25** | 71.43 | 42.25 | 41.15 | **4.50 s** |
| `blight_crawler` | 53 | 37 | 0 | 0 | 86.64 | 41.02 | 48.46 | **1.09 s** |

**Reading the table.**

- The Bone Ranker row reproduces `03-combat-math.md` §11.2 exactly
  (2.26 / 1.84 / 2.01 s), which is the check that this document's scaling
  arithmetic is the same arithmetic.
- The **baseline band of 1.5–3.0 s applies to `bone_ranker`, `ashen_archer` and
  `dust_shaman`**. Those three are the zone's ordinary infantry and all nine
  cells of the table sit inside it.
- `carrion_swarm` (0.84–0.95 s) and `blight_crawler` (1.09–1.22 s) are **below**
  the band by design. A swarmer that took three seconds to kill would make a
  pack of ten a two-minute chore, and a Crawler that survived one hit would
  always reach the player. Their pacing target is **one to two hits**, and they
  meet it.
- `maulsmith` (3.88–6.12 s) is **above** the band by design. It is the heavy;
  its pacing target is **4–7 s** and a distinct answer per class, which the
  −25 lightning resist provides: the Runeblade beats it in 4.50 s where the
  Ravager needs 6.12 s, an inversion of their ranking on every other row.
- Class spread on the shared rows is **1.23× (Ranker), 1.28× (Archer), 1.13×
  (Shaman)** — all inside the M7 gate of 2× from the median.

Per-archetype target bands, asserted by `tools/balance.mjs` as **MB2** (§12):

| Archetype | TTK band (all three builds, at the zone's `mlvl`) |
|---|---|
| `bone_ranker` | 1.5 – 3.0 s |
| `ashen_archer` | 1.2 – 3.0 s |
| `dust_shaman` | 1.5 – 3.2 s |
| `carrion_swarm` | 0.5 – 1.5 s |
| `blight_crawler` | 0.7 – 1.8 s |
| `maulsmith` | 3.5 – 7.5 s |

---

## 3. Behaviour state machines

### 3.1 The `Brain` record and the decision loop

`ai` keeps one `Brain` per hostile actor, parallel to the `Actor` and never
merged with it (`01-data-model.md` §9.6). The nine states in that record are the
complete set; this document adds none. Sub-modes that would otherwise want a
tenth state are encoded in existing fields:

| `Brain.state` | Sub-mode | Encoding |
|---|---|---|
| `reposition` | leash return | `targetRef.id === 0` **and** `desiredRange === 0` |
| `reposition` | archer retreat | `targetRef.id !== 0` **and** `desiredRange === 8.0` |
| `reposition` | flank waypoint | `targetRef.id !== 0` **and** `path !== null` **and** `desiredRange === archetype.attackRange` |
| `reposition` | doorway queue | `path !== null` **and** `pathIndex` unchanged for ≥ 72 ticks |
| `attack` | Ranker guard | `actor.state === 'channel'` **and** `actor.actionId === 'shield_guard'` |
| `attack` | Crawler fuse | `actor.state === 'windup'` **and** `actor.actionId === 'detonate'` |
| `flee` | swarm scatter | `fleeUntilStep > now` |

`actor.state` is the animation/action machine owned by `actors`
(`01-data-model.md` §1.4); `brain.state` is the decision machine owned by `ai`.
They advance independently and neither reads the other's transition table.

### 3.2 Cadence

Brains decide at **10 Hz** — every 6 fixed steps — and move at 60 Hz
(`02-api-contracts.md` §12). The phase offset is `actorId % 6`, so the decision
load is flat across steps rather than spiking every sixth.

| `Brain.state` | Cadence (ticks) | Cost per decision | Why |
|---|---:|---:|---|
| `dormant` | 30 | 0.4 µs | one squared-distance test against the player |
| `wander` | 30 | 1.6 µs | + `nav.randomPoint` on arrival only |
| `alert` | 6 | 3.8 µs | LOS raycast + `ai.alertPack` |
| `chase` | 6 | 3.5 µs | flow sample or path advance + range test |
| `attack` | 6 | 2.2 µs | range, facing and cooldown tests only |
| `reposition` | 6 | 4.1 µs | destination choice + `nav.snap` |
| `flee` | 6 | 3.2 µs | direction + walkability probe |
| `cast` | 12 | 1.1 µs | timer only; the cast is already committed |
| `dead` | never | 0 | the brain is released on the death tick |

Weighted over a live 12-strong pack in contact (roughly 5 `attack`, 4 `chase`,
2 `reposition`, 1 `cast`) the mean is **3.1 µs per decision**, which §9.5 costs
out at scale.

**Movement runs every step regardless of cadence.** A brain in `chase` samples
the flow field or advances its path node at 60 Hz using the goal its last
decision produced. Decisions choose *where*; movement executes it. Dropping
movement to 10 Hz would produce 100 ms of visible stair-stepping at 5.4 m/s.

### 3.3 The shared skeleton

Every archetype inherits this graph and then overrides or adds edges. Numeric
thresholds in the table are the shared defaults; a per-archetype table that
follows replaces any row it names.

```
                    ┌──────────┐
   pack activated → │ dormant  │ ←──────────────── arrival at leash anchor
                    └────┬─────┘
        perception or noise or pack alert
                         ↓
                    ┌──────────┐   lost target ≥ 6.0 s
        ┌───────────│  alert   │──────────────────┐
        │           └────┬─────┘                  │
        │      target confirmed (LOS or damage)   │
        │                ↓                        ↓
        │           ┌──────────┐            ┌──────────┐
        │           │  chase   │───────────→│  wander  │
        │           └──┬────┬──┘            └────┬─────┘
        │  in range    │    │  out of band       │ perception
        │              ↓    ↓                    ↓
        │        ┌────────┐  ┌────────────┐   (back to alert)
        │        │ attack │←→│ reposition │
        │        └───┬────┘  └─────┬──────┘
        │            │             │
        │            ↓             ↓
        │        ┌────────┐   ┌──────────┐
        └───────→│  cast  │   │   flee   │
                 └────────┘   └──────────┘
                      │             │
                      └──────┬──────┘
                             ↓
                        ┌────────┐
                        │  dead  │   ← from any state, terminal
                        └────────┘
```

**Shared transitions**, evaluated top to bottom; the first that fires wins:

| # | From | To | Condition |
|---:|---|---|---|
| S1 | any | `dead` | `actor.dead === true` |
| S2 | `dormant` | `alert` | pack activated **and** (perception §4.2 **or** noise §4.5 **or** `ai.alertPack`) |
| S3 | `alert` | `chase` | a target is confirmed: LOS to the player, **or** the brain has taken damage in the last 1.0 s |
| S4 | `alert` | `wander` | 6.0 s in `alert` with no confirmation |
| S5 | `wander` | `alert` | perception or noise |
| S6 | `chase` | `attack` | `dist ≤ attackRange + selfRadius + targetRadius` **and** the skill is off cooldown **and** LOS |
| S7 | `chase` | `reposition` | `dist < retreatBand` (ranged types) **or** a flank waypoint was assigned (§8.4) |
| S8 | `chase` | `cast` | a monster skill's precondition and cooldown are both satisfied |
| S9 | `attack` | `chase` | the action completed **and** `dist > attackRange + radii + 0.4 m` |
| S10 | `attack` | `attack` | the action completed **and** still in range — a new action starts on the next `attackReady` step |
| S11 | `reposition` | `chase` | the destination is reached, or 2.5 s elapsed, or the destination became unwalkable |
| S12 | `cast` | `chase` | the cast completed or was interrupted |
| S13 | any but `dead` | `flee` | archetype-specific (only `carrion_swarm` scatter today) |
| S14 | `flee` | `chase` | `now ≥ fleeUntilStep` |
| S15 | `chase`/`attack`/`reposition` | `reposition` (leash) | §4.4's leash condition |
| S16 | `reposition` (leash) | `dormant` | within 2.0 m of the pack centre |
| S17 | any but `dead` | `chase` | the brain took damage from a target it can see, overriding S4/S15 |

**S17 exists to stop the "shot from off screen and shrugged" bug.** Damage
always wins over de-escalation. It cannot override S1.

`0.4 m` in S9 is the range hysteresis; without it a monster at exactly
`attackRange` alternates `attack`/`chase` every decision and never swings.

### 3.4 `bone_ranker`, `maulsmith` — melee overrides

| Override | `bone_ranker` | `maulsmith` |
|---|---|---|
| S6 range | 1.9 m | 2.6 m |
| Approach speed | 3.2 m/s | 2.4 m/s |
| S10 | may re-enter `attack` immediately (0.55 s idle tail absorbs it) | re-enters after the 0.01 s tail; effectively continuous |
| Extra edge | `attack → attack` (guard) on the 20 % `shield_guard` draw | none |
| Cadence in `attack` | 6 ticks | **12 ticks while `actor.state === 'windup'`** — the slam is committed and there is nothing to decide |
| Abort | free before `hitTick` | **impossible**; only `stunned` / `frozen` / death cancel |

The Maulsmith's committed wind-up is enforced structurally: while
`actor.state === 'windup'` and `actor.actionId === 'crushing_slam'`, the brain's
transition table is reduced to `{S1, S17-suppressed}`. There is no code path
from a committed slam to any state but `dead` or `hitstun`.

### 3.5 `ashen_archer` — kiting

Three bands with hysteresis, evaluated in `chase`, `attack` and `reposition`:

| Band | Enter when | Leave when | State | Behaviour |
|---|---|---|---|---|
| **retreat** | `dist < 6.0` | `dist ≥ 8.0` | `reposition` (`desiredRange = 8.0`) | move along `away` at 3.6 m/s; no attacks |
| **hold** | `6.0 ≤ dist ≤ 14.0` | outside | `attack` | fire on cooldown; between shots strafe ±1.2 m, direction flipped every 2.0 s |
| **approach** | `dist > 14.0` | `dist ≤ 11.0` | `chase` | flow field or path toward 11.0 m |

Additional archer-only transitions:

| # | From | To | Condition |
|---:|---|---|---|
| A1 | `attack` | `reposition` | `physics.lineOfSight` fails at the moment of the range check — the archer sidesteps 2.0 m perpendicular to the target bearing and re-tests |
| A2 | `reposition` (retreat) | `attack` | **cornered**: `nav.raycastNav` fails within 1.5 m along `away` **and** along both tangents, continuously for 1.0 s |
| A3 | `attack` | `attack` | `multishot` affix: one action emits three packets in a 22° spread at 70 % damage each (§6.2) |

Withheld shots do not consume the cooldown: `attackReady` is only advanced when
a packet is actually emitted, so an archer that spends four seconds without LOS
fires the instant it gets one.

### 3.6 `dust_shaman` — support priority

Decision priority in `chase` and `attack`, evaluated in this fixed order every
decision. The first satisfied entry wins; there is no scoring and no RNG.

| # | Action | Precondition |
|---:|---|---|
| 1 | `raise_ranker` | `reviveCredits > 0` **and** cooldown expired **and** `actors.resurrectableCorpses(x, z, 8.0, out) > 0` **and** `dist(player) > 5.0` |
| 2 | `haste_dust` | cooldown expired **and** ≥ 3 eligible un-buffed pack members within 10.0 m, **or** `pack.aliveCount ≤ 3` |
| 3 | `dust_bolt` | `6.0 ≤ dist ≤ 9.0` **and** LOS **and** cooldown expired |
| 4 | `reposition` | `dist < 6.0` — back away to 8.0 m, same band logic as §3.5 |
| 5 | `chase` | `dist > 9.0` |

Entry 1's `dist(player) > 5.0` clause is what stops a Shaman starting a 1.70 s
unscalable ritual with the player already on top of it. It is the mechanic's
own self-defence and it is also what makes "run at the Shaman" the correct
player response.

The Shaman never enters `flee`. It backs away in `reposition` and dies where it
stands, because a support unit that runs away is a support unit the player
cannot punish.

### 3.7 `carrion_swarm` — surround and scatter

| # | From | To | Condition |
|---:|---|---|---|
| C1 | `chase` | `chase` | ring slot reassigned every decision (§8.2); the goal is the slot, never the player's centre |
| C2 | any but `dead` | `flee` | `pack.aliveCount / pack.count < 0.40`, **once per pack per zone visit** |
| C3 | `flee` | `chase` | `now ≥ fleeUntilStep` (180 ticks) |

A swarmer in `chase` never paths: its goal is a point on a 2.0 m ring around a
target it can already see, and the flow field plus local avoidance resolve it.
Swarm members are the largest single consumer of the crowd budget and the
smallest consumer of the A* budget — by construction (§9.3).

### 3.8 `blight_crawler` — the fuse

| # | From | To | Condition |
|---:|---|---|---|
| B1 | `chase` | `attack` (fuse) | any of T1–T4 (§2.6) |
| B2 | `attack` (fuse) | — | **no exit**. The fuse is 51 ticks and cannot be cancelled, cleared, stunned out or killed out. `stunned` freezes the animation but not the fuse counter |
| B3 | `chase` | `chase` | goal is the target's **predicted** position `target + targetVelocity × 0.30 s`, clamped to walkable |

B2 is deliberate and is the one place in this document where a stun does not
cancel a wind-up. `08-characters-visual.md` §6.6 makes stun a canceller for
attacks; the detonation is not an attack, it is a death. A Crawler stunned mid-
fuse stands still and explodes on schedule, which is both readable and fair —
the player who stunned it already knew where it was.

The 0.30 s lead in B3 is what makes the Crawler close on a strafing player. It
is the only monster in the game that leads its target.

---

## 4. Perception and aggro

### 4.1 The perception table

`aggroRadius` and `leashRadius` are `03-combat-math.md` §9.1's. The three
remaining columns have no source and are specified here.

| `archetypeId` | `aggroRadius` | Half-angle | `proximityRadius` | `hearingRadius` | `leashRadius` |
|---|---:|---:|---:|---:|---:|
| `bone_ranker` | 13.0 m | 75° | 4.0 m | 9.0 m | 34.0 m |
| `carrion_swarm` | 15.0 m | 110° | 5.0 m | 12.0 m | 40.0 m |
| `ashen_archer` | 18.0 m | 60° | 4.0 m | 10.0 m | 38.0 m |
| `dust_shaman` | 16.0 m | 70° | 4.0 m | 11.0 m | 36.0 m |
| `maulsmith` | 12.0 m | 55° | 3.5 m | 8.0 m | 30.0 m |
| `blight_crawler` | 17.0 m | 130° | 6.0 m | 14.0 m | 44.0 m |
| `molgrim` | 26.0 m | **180°** | 26.0 m | 26.0 m | **∞** |

The half-angle is measured from `actor.facing`. `proximityRadius` is
omnidirectional: inside it, facing is irrelevant. The Maulsmith's narrow 55°
and short 12 m are what let a player walk past one in a Bonereach hall; the
Crawler's 130° and 17 m are what stop that ever working on a Crawler.

### 4.2 The perception test

Run once per decision for brains in `dormant`, `wander` and `alert`. Never run
in `chase`, `attack`, `cast`, `reposition` or `flee` — those states already have
a target.

```
sees(self, target):
    d2 = (target.x - self.x)² + (target.z - self.z)²
    r  = self.aggroRadius × blindFactor(self)          // §4.3
    if d2 > r²                       : return false
    if d2 > self.proximityRadius²:
        cosLimit = cos(self.halfAngle)
        f = (cos(self.facing), sin(self.facing))
        v = normalize(target - self)
        if dot(f, v) < cosLimit      : return false
    return nav.raycastNav(self.x, self.z, target.x, target.z)
```

**Line of sight is a nav-grid line of walk**, `nav.raycastNav`
(`02-api-contracts.md` §6), not a `physics.lineOfSight` ray. Three reasons:

1. It is the same test the movement system will have to satisfy anyway. A
   monster that can see the player but cannot walk to them is a monster that
   walks into a wall for ten seconds.
2. It costs a supercover line walk over `flags[]` — roughly **2.2 µs** over a
   14 m span at 0.5 m cells (28 cells) — against a physics broadphase query.
3. It runs headless in Node, which `physics.lineOfSight` also does but the nav
   grid is the only one `tools/mapgen.mjs` already has loaded.

The consequence is stated plainly: **a monster cannot see over a 0.5 m kerb it
cannot walk over.** For a top-down game whose blockers are all either waist-high
(and `navBlock: false`) or full walls, this is correct in every case the zones
actually contain, and it is checked by invariant MB16 (§12).

> **Ruling (O-143, 2026-08-05) — MB16 asserts the unsafe direction only.** The
> paragraph above predicted the divergence would be negligible on real zones.
> It is not: measured over 400 generated layouts and 2 400 walkable pairs, nav
> refuses **8.000 %** of the sights physics allows (wastes 12.667 %, bonereach
> 3.333 %) against the old **< 1.5 %** budget. The cause is not kerbs — it is
> nav's **0.30 m walkability dilation**, which `07-world-gen.md` §6.3 mandates,
> plus the slope pass; physics's undilated sight geometry knows about neither.
> A budget cannot be met while §6.3 stands, so the old one asserted something
> the spec itself made impossible.
>
> The two directions are not symmetric and only one can hurt. **nav passing
> where physics blocks** is an over-report: a monster aggros through a wall.
> **nav failing where physics passes** is conservative: a monster occasionally
> does not notice a player it could geometrically see, across a 0.30 m safety
> margin that exists on purpose. Measured, the unsafe direction is **0 of
> 2 400** and the divergence is strictly one-sided.
>
> So MB16 now asserts **exactly 0** on the unsafe direction — stricter than the
> budget it replaces — and the conservative direction is measured, printed with
> its cause named, and carries no threshold. Removing a budget that could not
> be met is not the same as removing a check: the clause that can produce a bug
> got harder, not softer.

`raycastNav` is called **at most once per decision per brain** — 4.17 calls per
step at 25 monsters.

### 4.3 Blinding and light

```
blindFactor(self) = (self.statusMask & STATUS_BIT.blinded) ? 0.35 : 1.00
```

`03-combat-math.md` §7.10: `blinded` multiplies monster perception radius by
0.35. At the Ashen Archer's 18 m that is **6.3 m** — inside its own retreat
band, so a blinded archer stops kiting and stands still, which is exactly what
`ashen_step`'s ash cloud is for.

**Light radius does not affect perception.** The player's `lightRadius`
(`03-combat-math.md` §3, base 6 m) is a rendering and readability stat only.
Coupling it to aggro would make a `+light radius` affix a stealth downgrade,
would make the balance harness's results depend on equipment cosmetics, and
would give the player no way to reason about it. Stated here so nobody adds it.

### 4.4 Leash and de-aggro

Leash distance is measured from the **pack centre** (`PackDescriptor.centerX/Z`),
not from the individual spawn point. A pack that legitimately advanced 10 m to
reach the player should not have its rear rank snap home.

| Condition | Value |
|---|---|
| Trigger | `dist(actor, packCentre) > leashRadius` continuously for **1.0 s** **and** `now − actor.lastDamageStep > 180` (3.0 s) |
| Effect | `state = reposition`, `targetRef = {0,0}`, `desiredRange = 0`, goal = pack centre, path requested through the A* ring (leash is A*-eligible, §9.3) |
| Return speed | `runSpeed × 1.25` |
| Return regeneration | `lifeRegen × 4.0` for the duration of the return only |
| Arrival | within 2.0 m of the pack centre → `dormant`, `perceptionAlerted` retained |
| Override | S17 — any damage from a visible source cancels the leash immediately |
| Boss | `leashRadius = ∞`; Molgrim never leashes. His reset condition is different (§7.9) |
| Sound | `monster.leash` (§17) once per pack, on the first member to leash |

De-aggro without leashing: a brain in `alert` that fails to confirm a target for
6.0 s falls to `wander` (S4). A brain in `chase` whose `lastSeenStep` is older
than **8.0 s** and whose current position is within 2.0 m of `lastSeenX/Z`
falls to `alert`. Those two together mean a monster searches the last known
position, gives up, then wanders — it never stands still staring at a wall.

### 4.5 Noise

Sound propagates aggro. The rule is deliberately weak: **hearing never grants a
target, only a direction.**

| Event | Loudness `L` | Emitted at |
|---|---:|---|
| A landed melee hit (`actor:damage`, `result.total > 0`, `sourceSkillId` is a weapon action) | 8.0 m | `result.point` |
| `skill:impact` with `radius < 2.0` | 10.0 m | the impact point |
| `skill:impact` with `radius ≥ 2.0` | 14.0 m | the impact point |
| `meteor`, `essence_burn`, `war_cry`, `thunder_step`, `crushing_slam`, `detonate` | 18.0 m | the impact point |
| `actor:death` of any monster | 12.0 m | the death point |
| Molgrim phase transition | 40.0 m (the whole arena) | the boss |

```
onNoise(x, z, L):
    for each brain in {dormant, wander}:
        if dist² > min(brain.hearingRadius, L)² : continue
        brain.state        = 'alert'
        brain.lastSeenX    = x
        brain.lastSeenZ    = z
        brain.lastSeenStep = now
        // targetRef is NOT set — the brain must still confirm by sight (S3)
```

**Throttle.** At most **4 noise events per fixed step**, held in a 4-deep ring;
a fifth in the same step is dropped. In a dense fight the dropped events are
duplicates of ones already processed, and the alternative — 25 hits per second
each scanning every dormant brain — is 0.4 ms of pure redundancy.

Cost: one squared-distance test per dormant/wander brain per accepted event.
With ≤ 4 events and ≤ 40 dormant brains that is 160 tests at ~14 ns = **2.2 µs**
per step, worst case.

### 4.6 Aggro propagation inside a pack

`02-api-contracts.md` §12 states the contract: *"Packs share an aggro cloud:
waking one wakes all of them."* This document honours it exactly and adds only
the timing.

```
ai.alertPack(packId, x, z):
    wakeStep = now
    for each member m of pack, in ascending actorId:
        if m.brain.state !== 'dormant' and m.brain.state !== 'wander': continue
        d       = dist(m, (x, z))
        delay   = min(30, round(12 × d / pack.aggroCloud))     // ticks
        m.brain.wakeAtStep = wakeStep + delay
```

Every member wakes; the only variable is *when*. `pack.aggroCloud` is 8.0–10.0 m
(`07-world-gen.md` §8.3 step 6), so a member exactly one cloud-radius away wakes
12 ticks (0.20 s) later and the cap of 30 ticks means the whole pack is awake
within **0.50 s** however strung out it is. The result reads as a ripple rather
than a switch, and it costs one integer per member.

**Cross-pack bleed.** When a member wakes, any monster of a *different* pack
within **6.0 m** of it is also alerted — once, with no further propagation, and
flagged so it cannot re-trigger. This is what makes two packs placed 9.0 m apart
(`07-world-gen.md` §8.3's minimum pack separation) merge into one real fight
rather than two sequential ones, and it is bounded: the bleed graph has depth 1.

Triggers for `alertPack`:

| Trigger | Source |
|---|---|
| A member transitions `dormant → alert` | §3.3 S2 |
| A member takes damage from any source | `actor:damage` |
| A member dies | `actor:death` |
| `world` fires a scripted trigger (the Altar gate) | `07-world-gen.md` §5.4 E3 |

### 4.7 Threat

`Actor.threat` (`01-data-model.md` §2) is **`null` on every monster in this
build**. There is exactly one hostile target — the player — and the only other
player-team actor, `echo_blade`, carries `ACTOR_FLAG.visualOnly` and takes no
damage. Targeting an invulnerable duplicate is a soft-lock, so:

> **`skills` must set `ACTOR_FLAG.untargetable` alongside `visualOnly` on the
> `echo_blade` duplicate.** `ai` skips `untargetable` actors in every target
> search. This is a one-flag requirement on another subsystem and it is recorded
> here because `ai` is the system that breaks without it.

A threat table is not implemented, not stubbed and not reserved. If a future
build adds a second player-team combatant, this section is the place that has to
change.

---

## 5. Pack composition

### 5.1 How a mixed pack is expressed

`PackDescriptor.archetypeId` holds a **single** id (`01-data-model.md` §9.5),
and `07-world-gen.md` §8.3 fills it with `S3.weighted(bestiaryWeights(cell))`
without defining `bestiaryWeights`. This document defines it, and resolves the
mixed-pack problem without changing either record:

> `PackDescriptor.archetypeId` may name **either** a bestiary archetype **or** a
> **pack template** from `src/ai/data/pack-templates.js`. Template ids are
> prefixed `pk_` and can never collide with a bestiary id. `ai.spawnPack()`
> resolves the id: a bestiary id spawns `count` identical monsters; a template
> id expands to a mixed roster of exactly `count` monsters.

`world` is unchanged — it draws a weighted id and stores it. `ai` is the only
system that has to know the difference, which is correct, because composition is
a monster decision and `07-world-gen.md` §Scope says so explicitly: *"`world` …
never decides what a pack is made of beyond its archetype and rank."*

`bestiaryWeights(cell)` returns the template weight rows of §5.3 and §5.4.
§16 A1 requests `ai.packTemplate(id)` so `tools/mapgen.mjs` can report
composition without instantiating `ai`.

### 5.2 Template resolution — deterministic, no RNG

```
resolve(template, count):
    roster = []
    for each fixed member f in template.fixed, in array order:
        push f.archetypeId × f.n                       // e.g. { dust_shaman, 1 }
    remaining = count − |roster|
    if remaining < 0: drop fixed members from the END of template.fixed
                      until remaining ≥ 0
    // largest-remainder over template.share, in array order
    exact  = share[i] × remaining
    whole  = floor(exact[i]);  frac = exact[i] − whole[i]
    assign whole[i] of each
    left   = remaining − Σ whole
    award the `left` extra slots to the entries with the largest frac,
      ties broken by ascending array index
    enforce template.min[i]: any entry below its minimum takes slots from the
      entry with the largest surplus above ITS minimum, lowest index first
```

The procedure draws no random numbers, is total, and always produces exactly
`count` members. `PackDescriptor.count` is never reduced
(`07-world-gen.md` §8.3). Asserted as **MB11** (§12) for every template at every
count 5…12.

Worked, `pk_warband` at `count = 8`: fixed `1 × dust_shaman`; remaining 7 split
`bone_ranker 0.40`, `ashen_archer 0.30`, `carrion_swarm 0.30` →
`2.80 / 2.10 / 2.10` → wholes `2 / 2 / 2`, one slot left, largest fraction is
the Ranker's `0.80` → **1 Shaman, 3 Rankers, 2 Archers, 2 Swarmers = 8**.

### 5.3 Ashen Wastes templates

Zone `bestiary`: `bone_ranker`, `carrion_swarm`, `ashen_archer`, `dust_shaman`,
`blight_crawler` (`07-world-gen.md` §3.1). `mlvl` 6 / 18 / 28.

| Template | Fixed | Share | Member minima | Pack size floor |
|---|---|---|---|---:|
| `pk_ranker_line` | — | `bone_ranker 1.00` | — | 5 |
| `pk_ranker_archer` | — | `bone_ranker 0.60`, `ashen_archer 0.40` | archer ≥ 2 | 5 |
| `pk_swarm` | — | `carrion_swarm 1.00` | — | **6** |
| `pk_swarm_ranker` | — | `carrion_swarm 0.65`, `bone_ranker 0.35` | swarm ≥ 4, ranker ≥ 2 | **7** |
| `pk_archer_nest` | — | `ashen_archer 0.55`, `bone_ranker 0.45` | ranker ≥ 2 | 5 |
| `pk_shaman_court` | `1 × dust_shaman` | `bone_ranker 1.00` | — | 6 |
| `pk_crawler_run` | — | `blight_crawler 0.40`, `bone_ranker 0.60` | crawler ≥ 2 | 5 |
| `pk_warband` | `1 × dust_shaman` | `bone_ranker 0.40`, `ashen_archer 0.30`, `carrion_swarm 0.30` | — | 8 |

Weights per macro-cell archetype (`07-world-gen.md` §3.2 R7). Rows sum to 100.

| Cell archetype | `ranker_line` | `ranker_archer` | `swarm` | `swarm_ranker` | `archer_nest` | `shaman_court` | `crawler_run` | `warband` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `ash_flats` | 30 | 22 | 18 | 12 | 8 | 4 | 6 | 0 |
| `dead_grove` | 12 | 20 | 10 | 10 | **30** | 6 | 12 | 0 |
| `ruin_field` | 20 | **26** | 6 | 8 | 24 | 8 | 8 | 0 |
| `bone_yard` | 18 | 14 | 8 | 10 | 8 | **32** | 10 | 0 |
| `ravine` | 16 | 10 | **26** | 20 | 6 | 6 | 16 | 0 |
| `warcamp` | 10 | 16 | 6 | 8 | 12 | 10 | 8 | **30** |

Each row is a design statement, not a spread: the grove is where archers live
because it breaks lines of fire; the bone yard is where the Shaman belongs
because that is where the corpses are; the ravine is a bowl and a swarm in a
bowl is a swarm you cannot walk away from; the warcamp is the only cell that
ever fields a warband, which is why it carries a 1.60 density multiplier.

If a template's `packSize` floor exceeds the size the density budget assigned,
`ai` raises the pack's `count` to the floor and **records a
`PACK_SIZE_RAISED` counter**. Over the 200-seed sweep this fires on 3–5 % of
packs and the resulting density overshoot is under 1.5 %, well inside I4's
±20 % band. It is never the other way round: a pack is never shrunk below the
template's floor, because a five-member "swarm" is not a swarm.

### 5.4 Bonereach templates

Zone `bestiary` adds `maulsmith` (`07-world-gen.md` §4.1, listed there as
`hammerfell_brute` — §15 D-2). `mlvl` 11 / 23 / 33.

| Template | Fixed | Share | Member minima | Pack size floor |
|---|---|---|---|---:|
| `pk_bone_line` | — | `bone_ranker 1.00` | — | 5 |
| `pk_bone_archer` | — | `bone_ranker 0.55`, `ashen_archer 0.45` | archer ≥ 2 | 5 |
| `pk_maul_guard` | `1 × maulsmith` | `bone_ranker 1.00` | — | 5 |
| `pk_swarm_flood` | — | `carrion_swarm 1.00` | — | **6** |
| `pk_crawler_nest` | — | `blight_crawler 0.55`, `carrion_swarm 0.45` | crawler ≥ 3 | **6** |
| `pk_shaman_vault` | `2 × dust_shaman` | `bone_ranker 1.00` | — | 6 |
| `pk_deep_warband` | `1 × maulsmith`, `1 × dust_shaman` | `ashen_archer 0.40`, `bone_ranker 0.60` | — | 8 |

Weights per room role (`07-world-gen.md` §4.2 B7). Rows sum to 100.

| Room role | `bone_line` | `bone_archer` | `maul_guard` | `swarm_flood` | `crawler_nest` | `shaman_vault` | `deep_warband` |
|---|---:|---:|---:|---:|---:|---:|---:|
| `hall` | 26 | 24 | 16 | 10 | 8 | 10 | 6 |
| `vault` | 8 | 14 | 22 | 4 | 8 | **24** | 20 |
| `flooded` | 14 | 10 | 8 | **30** | 26 | 6 | 6 |
| `stair` | 22 | **26** | 18 | 6 | 8 | 10 | 10 |
| corridor (wanderers) | 55 | 0 | 10 | 20 | 15 | 0 | 0 |
| `entry` | — | — | — | — | — | — | — |

`entry` rooms are entirely `spawnDeny` (`07-world-gen.md` §4.2 B7) and receive
no packs at all. Corridor `SpawnPoint`s are `kind: 'wanderer'` with
`packIndex: −1` (`07-world-gen.md` §8.4) and use the corridor row, resolved at
`count = 1`; at that count `pk_bone_line` yields one Ranker, `pk_maul_guard`
yields the fixed Maulsmith alone, and `pk_swarm_flood` / `pk_crawler_nest` yield
one Swarmer / one Crawler. A lone wandering Maulsmith in a Bonereach corridor is
the single most memorable normal encounter in the act and it costs one row of a
weight table.

### 5.5 Altar of Instruction — the approach

Zone `bestiary`: `bone_ranker`, `ashen_archer` only (`07-world-gen.md` §5.1).
`packCount 2–3`, `packSize 4–7`, `champChance 0.35`, `uniqueChance 0.00`.
`mlvl` 15 / 27 / 37.

| Template | Fixed | Share | Weight |
|---|---|---|---:|
| `pk_altar_guard` | — | `bone_ranker 0.55`, `ashen_archer 0.45` | 65 |
| `pk_altar_line` | — | `bone_ranker 1.00` | 35 |

Both are placed in the approach corridor and the first 4 m inside the arena rim
(`07-world-gen.md` §5.4 E3). Neither ever spawns inside `r < 13 m`, so the boss
fight starts clean. `uniqueChance 0.00` means the approach never fields a unique
— the Altar's elite is Molgrim.

### 5.6 Incoming damage — what a pack actually does

The other half of pacing. Method and per-monster figures follow
`03-combat-math.md` §11.5 exactly, including its reference armour's
`damageReduceFlat = 2`; the target is the level-10 reference Ravager, DEF 137,
165 life.

| Monster | AR | Hit % | Avg damage | Per landed hit | `attackTime` | DPS each |
|---|---:|---:|---:|---:|---:|---:|
| `bone_ranker` | 199 | 59.23 | 16.144 | 14.144 | 1.40 | **5.983** |
| `ashen_archer` | 230 | 62.67 | 17.938 | 15.938 | 1.70 | **5.875** |
| `carrion_swarm` | 168 | 55.08 | 8.969 | 6.969 | 0.75 | **5.118** |
| `dust_shaman` | 177 | 56.37 | 12.556 | 10.556 | 1.60 | **3.719** |
| `maulsmith` | 243 | 63.95 | 48.431 | 46.431 | 2.20 | **13.500** ¹ |
| `blight_crawler` | — | always hits | poison 29–50 total | 39.5 over 5 s | one-shot | 7.900 while active |

The first two rows reproduce `03-combat-math.md` §11.5's 5.98 and 5.87.

¹ **The Maulsmith row is `03-combat-math.md` §11.5's figure and it omits the
slam coefficient.** That document computes 13.50 DPS from the bestiary row
(`0.6395 × 46.431 / 2.20`), but the Maulsmith's only attack is `crushing_slam`
at **220 %** (`03-combat-math.md` §9.2), which gives
`0.6395 × 46.431 × 2.20 / 2.20 = 29.69 DPS` — a landed slam is 102.1 of the
Ravager's 165 life, not 46.4. `03` §11.5's own conclusion holds either way and
is the reason the discrepancy is not load-bearing: *"its 1.21 s telegraph is
walkable, so in practice it deals far less"*. This document uses the row as
`03` states it, and states the coefficient here so the number is not read as
the damage a player actually takes. A `maulsmith` never appears in a Wastes
pack template, so no template DPS figure below depends on it.

Template pack DPS against the same target, and stand-still survival time:

| Template | `count` | Roster | Pack DPS | Survival at 165 life |
|---|---:|---|---:|---:|
| `03` §11.5 reference | 5 | 4 Ranker + 1 Archer | 29.80 | 5.54 s |
| `pk_ranker_line` | 8 | 8 Ranker | 47.87 | 3.45 s |
| `pk_ranker_archer` | 8 | 5 Ranker + 3 Archer | 47.55 | 3.47 s |
| `pk_swarm` | 10 | 10 Swarm | 51.18 | 3.22 s |
| `pk_shaman_court` | 8 | 1 Shaman + 7 Ranker | 45.61 | 3.62 s |
| `pk_warband` | 8 | 1 Shaman + 3 Ranker + 2 Archer + 2 Swarm | 43.66 | 3.78 s |
| `pk_warband` under `haste_dust` | 8 | as above, +25 IAS for 6 s in 12 | 49.12 (mean) | **3.36 s** |

**Three seconds is the floor, and it is intentional.** `03-combat-math.md`
§11.5's five-strong pack gives 5.5 s; a full-strength eight gives 3.4–3.8 s; a
warband with its buff up gives 3.36 s. Every one of those numbers assumes the
player stands still, does not block, does not drink and does not move — and the
0.50 s post-recovery immunity window of `03-combat-math.md` §7.11 is what makes
even the worst of them a fight rather than a stun-lock. `tools/balance.mjs`
asserts a floor of **3.0 s** as **MB9**; a template that drops below it is a
tuning bug, not a difficulty choice.

### 5.7 Champion and unique promotion

`07-world-gen.md` §8.3 step 4 rolls the pack's `rank` from a single `S3` draw
and §8.4 fixes mutual exclusion, one unique per zone, dead-end forcing and the
escort rule. What that document does not say is **how many members of a
champion pack are champions**. This document does:

| Pack `rank` | Promotion |
|---|---|
| `normal` | none |
| `champion` | `clamp(round(count × 0.35), 2, 5)` members promoted to `champion`. Selected as the members with the **lowest `SpawnPoint.id`** — deterministic, no RNG. All promoted members share the pack's **one** rolled affix |
| `unique` | exactly **1** unique + `count − 1` at `minion` (`07-world-gen.md` §8.4). Every minion inherits **all three** of the unique's affixes (`03-combat-math.md` §9.3: minion "inherits the unique's") |

| `count` | Champions | Minions if unique |
|---:|---:|---:|
| 5 | 2 | 4 |
| 6 | 2 | 5 |
| 7 | 2 | 6 |
| 8 | 3 | 7 |
| 9 | 3 | 8 |
| 10 | 4 | 9 |
| 11 | 4 | 10 |
| 12 | 4 | 11 |

Three champions per eight-strong pack at ~10 s each (`03-combat-math.md` §11.3)
is **30 s of elite fighting per champion pack**. At the Wastes' `champChance`
0.16 across 9–12 packs that is 1.4–1.9 champion packs per run, or about a minute
of the run spent on elites — which is the right fraction, and it is why the
promotion count is 35 % and not 100 %.

The plan's "3–5 minions" for a unique is satisfied at the low end of
`packSize` (5 → 4 minions) and exceeded at the high end (12 → 11). That is
`07-world-gen.md` §8.4's stated intent and this document does not narrow it.

### 5.8 Unique names

A unique's `Actor.name` is generated from two frozen tables with **two draws**
from the `ai` stream, taken immediately after its affixes (§14).

| # | Epithet (EN) | # | Title (EN) | Title (RU) |
|---:|---|---:|---|---|
| 0 | Ashgrim | 0 | the Unlettered | Неграмотный |
| 1 | Bonewrit | 1 | the Third Draft | Третий Черновик |
| 2 | Cinderlash | 2 | Keeper of Errata | Хранитель Опечаток |
| 3 | Dustmourn | 3 | the Redacted | Вымаранный |
| 4 | Emberquill | 4 | Margin-Walker | Идущий по Полям |
| 5 | Foulscript | 5 | the Misquoted | Перевранный |
| 6 | Gravemark | 6 | Scribe of Cinders | Писец Углей |
| 7 | Hollowvow | 7 | the Unfinished | Незавершённый |
| 8 | Ironpsalm | 8 | Warden of Blank Pages | Страж Пустых Страниц |
| 9 | Lastlesson | 9 | the Illegible | Нечитаемый |
| 10 | Mireglyph | 10 | the Palimpsest | Палимпсест |
| 11 | Nullword | 11 | the Recanted | Отречённый |
| 12 | Pyrelogue | | | |
| 13 | Rotverse | | | |
| 14 | Thornfable | | | |
| 15 | Waxcreed | | | |

`name = EPITHET[S.int(0,15)] + ', ' + TITLE[S.int(0,11)]` — 192 combinations,
e.g. *"Cinderlash, Keeper of Errata"*. The Russian dictionary translates the
title and transliterates the epithet, per the `i18n` rule that identifiers are
never mirrored.

---

## 6. Monster affixes

### 6.1 The nine affixes

Mechanical effects are `03-combat-math.md` §9.4's, restated verbatim. Groups,
weights, eligibility, telegraphs and the danger budget are this document's.

| id | EN | RU | Group | Weight | Effect (`03` §9.4) |
|---|---|---|---|---:|---|
| `burning` | Burning | Огненный | `immunity` | 12 | `fireResist = immunityValue` (§6.4). On death: fire damage `= 60 % of its maxLife` in radius 3.5 m |
| `charged` | Charged | Молниевый | `immunity` | 11 | `lightResist = immunityValue`. Releases 4 lightning charges every 3 s, each 40 % of its attack damage as lightning, applying `shocked` |
| `frostbound` | Frostbound | Ледяной | `immunity` | 11 | `coldResist = immunityValue`. Aura radius 7 m applying `chilled` at magnitude 35 |
| `swift` | Swift | Очень быстрый | `power` | 14 | `increasedAttackSpeed += 60`, `movementSpeed += 45` |
| `mighty` | Mighty | Очень сильный | `power` | 14 | damage × 1.55, `attackRating × 1.25` |
| `stoneskin` | Stoneskin | Каменная кожа | `power` | 13 | `defense × 2.5`, `damageReducePercent += 25` |
| `hexing` | Hexing | Проклинающий | `utility` | 9 | every 6 s applies `cursed` magnitude 40 for 8 s in radius 8 m |
| `vampiric` | Vampiric | Аура вампиризма | `utility` | 8 | `lifeSteal = 30` |
| `multishot` | Multishot | Мультивыстрел | `utility` | 8 | ranged attacks fire 3 projectiles in a 22° spread at 70 % damage each; melee attacks gain a 2.4 m cleave instead |

Weights sum to **100**. Group totals: `immunity` 34, `power` 41, `utility` 25.

### 6.2 Mechanical detail `03` leaves open

| Affix | Detail specified here |
|---|---|
| `burning` | The death explosion is one packet, `fireMin = fireMax = 0.60 × maxLife`, `attackRating 0`, `dodgeable false`, `blockable false`, `team = TEAM.monster`, radius 3.5 m. It fires on the death tick, **before** the corpse decision, and the corpse is always skipped (`08-characters-visual.md` §8.4). It never chains: a second `burning` monster killed by the blast still explodes, but from its own death tick, so the propagation is bounded by the number of `burning` monsters present |
| `charged` | Charges are emitted on a **3.0 s cooldown starting 3.0 s after the brain leaves `dormant`** — never at spawn, so a pack does not greet the player with a volley. Each of the 4 charges is a separate packet at 40 % of the row damage as lightning with a `shocked` rider at `chance 100`, targeting the nearest 4 hostiles within 9.0 m (fewer if fewer exist; the charges are not wasted on empty air). `attackRating 0` |
| `frostbound` | An aura, re-applied every 30 ticks (0.5 s) to every hostile within 7.0 m as a `chilled` instance of magnitude 35, duration 1.0 s. It is a **status application, not a hit**: no to-hit, no crit, no `chillPoints` contribution — a frostbound champion can never freeze the player, only slow them |
| `swift` | Enters through the `difficulty`-adjacent affix stat layer as `increasedAttackSpeed` and `movementSpeed`. It scales `W` and `R` and never `S` (`08-characters-visual.md` §6.2), and it is subject to the Maulsmith's 0.90 s wind-up floor and the Crawler's un-scalable fuse |
| `mighty` | `damage × 1.55` multiplies `physMin`/`physMax` at build step **B4**, after the rank multiplier and before mitigation. `attackRating × 1.25` multiplies the composed AR |
| `stoneskin` | `defense × 2.5` after the rank multiplier. `damageReducePercent += 25` sums with the rank's contribution and is capped at 50 (`01-data-model.md` §3.4). Plays `affix.stoneskin.deflect` in place of the surface hit whenever the mitigated total is below 40 % of the raw total |
| `hexing` | A 6.0 s cooldown, first cast 2.0 s after leaving `dormant`, radius 8.0 m, applies `cursed` magnitude 40 for 8.0 s — which is −40 % defence and −15 points on all six resists (`03-combat-math.md` §7.10). Max-wins refresh, so two hexing monsters are no worse than one |
| `vampiric` | `lifeSteal = 30` is a flat set, not an add; a `vampiric` monster leeches 30 % of post-mitigation physical dealt. Because it reads from the **post-mitigation** figure (`03-combat-math.md` §6.2 R14d), a heavily armoured player starves it |
| `multishot` | On a ranged archetype the action emits 3 packets at `physMin/Max × 0.70` on bearings `facing − 11°`, `facing`, `facing + 11°`, all on the same `hitTick`, each an independent projectile. On a melee archetype the single packet's `overlapCone` radius becomes 2.4 m and its half-angle 60°, at unchanged damage |

### 6.3 Eligibility

An affix is drawn only from the archetype's eligible set. Exclusions are
mechanical, not flavour: an affix that does nothing is worse than no affix,
because it costs the player a champion's worth of time for none of the signal.

| `archetypeId` | `immunity` | `power` | `utility` | Excluded because |
|---|---|---|---|---|
| `bone_ranker` | all 3 | all 3 | all 3 | — |
| `carrion_swarm` | all 3 | all 3 | `vampiric` | `hexing` — ten curse pulses in one pack is unreadable; `multishot` — a 2.4 m cleave on ten bodies at 5.4 m/s is not a champion, it is a wipe |
| `ashen_archer` | all 3 | all 3 | `hexing`, `multishot` | `vampiric` — it never lands a melee hit |
| `dust_shaman` | all 3 | all 3 | `hexing`, `multishot` | `vampiric` — ranged only |
| `maulsmith` | all 3 | all 3 | `hexing`, `vampiric` | `multishot` — `crushing_slam` is already a 3.2 m AoE; a 2.4 m cleave is a strict downgrade and reads as nothing |
| `blight_crawler` | `charged`, `frostbound` | all 3 | `hexing` | `burning` — a second death explosion on top of the poison burst is illegible; `vampiric` and `multishot` — it never lands a hit of any kind |
| `molgrim` | — | — | — | The boss takes no affixes. His three phases are his affixes |

Every group is non-empty for every eligible archetype, so a draw can never fail.
The tightest case is `blight_crawler`'s `utility` group of one, which is a forced
`hexing`.

### 6.4 Immunity is tier-gated

`03-combat-math.md` §9.4 and `ARCHITECTURE.md` both state that immunity
(`resist ≥ 100`) exists on champion affixes only. Neither says at which
difficulty it starts. It matters, and the arithmetic is unambiguous:

> The Emberwright's entire damage output is `fire`. Every skill on both of its
> trees that deals damage deals fire. Against a `burning` champion at
> `fireResist = 100`, an Emberwright's DPS is **exactly zero** and its TTK is
> **infinite**.

So:

```
immunityValue(tier) = 85   at instruction
                    = 100  at trial and renunciation
```

| Tier | `burning` champion `fireResist` | With `03` §10.2's tier bonus | Effective (cap 75) | Emberwright DPS vs it | TTK at `mlvl 10` champion |
|---|---:|---:|---:|---:|---:|
| Instruction | 85 | 85 + 0 = 85 | **75** | 5.578 / 0.4675 = **11.93** | **29.4 s** |
| Trial | 100 | 100 + 20 = 120 | **immune** | 0 | ∞ without pierce |
| Trial, +25 `fireResistPierce` | — | 120 − 25 = 95 | **75** | 11.93 scaled | finishable |
| Renunciation | 100 | 100 + 40 = 140 | **immune** | 0 | ∞ without ≥ 65 pierce |

At Instruction the affix reads as "this one resists fire — take the long way or
walk past it", which is a legible tactical statement. At Trial and above it
reads as "you need pierce", which is a legible *itemisation* statement, and by
then `fireResistPierce` is on the affix pool. A player who meets a true immunity
in the first hour and cannot see why has met a bug, not a mechanic.

This is a roll-time gate on a number `03` leaves as a single value; §15 D-14
records it.

### 6.5 The danger budget

Champions take **1** affix, uniques take **3** (`03-combat-math.md` §9.3).
The unique's three are drawn **one from each group**, in the fixed order
`immunity → power → utility`. That single rule delivers most of the budget for
free:

- Never two immunities, so no build is ever walled out of two of its elements.
- Never two `power` affixes, so no unique is simultaneously fast, strong and
  armoured.
- Always exactly three, so `03-combat-math.md` §9.3's count is met structurally
  rather than by rejection sampling.

Champions draw a **group** by group weight (34 / 41 / 25) and then an affix
within it by the affix's own weight — which reproduces the flat 100-weight
distribution of §6.1 exactly, so the two schemes are the same distribution and
`tools/balance.mjs` can assert one table for both.

**Danger points**, used to state the budget numerically:

| Affix | Points | Rationale |
|---|---:|---|
| `swift`, `mighty`, `stoneskin` | **3** | each roughly doubles either the time to kill or the damage taken |
| `burning`, `charged`, `frostbound`, `hexing`, `vampiric`, `multishot` | **2** | each is a significant but single-axis change |

Champion budget **≤ 3** (trivially satisfied by one affix). Unique budget
**≤ 7**. One affix per group caps the maximum at `3 + 2 + 2 = 7`, exactly at
budget; `swift + mighty` (6 from one group) is structurally impossible.

**Three hard exclusion pairs** sit on top of the group rule, because the group
rule alone permits three genuinely unfair combinations:

| Excluded pair | Arithmetic |
|---|---|
| `frostbound` + `swift` | The aura slows the player 35 % (4.2 → **2.73 m/s**) while the monster gains 45 % (3.2 → **4.64 m/s**). The player cannot disengage from a monster that is 1.7× faster than them, in any direction, ever. This is the only combination in the game with no counter-play at all |
| `stoneskin` + `burning` | The two affixes wall off opposite classes and the pair leaves no one a clean answer. `defense × 2.5` drops the Ravager's hit chance from 70.15 % to 48.45 % and `damageReducePercent 25` takes another quarter; the fire resistance removes the Emberwright's whole kit. Champion TTK at `mlvl 10` goes to **21.43 s / 29.42 s / 17.52 s** at Instruction and to **21.43 s / ∞ / 17.52 s** from Trial upward, where `burning` is a true immunity (§6.4). A unique carrying both is a wall to one class and a chore to the other two |
| `mighty` + `multishot` on `ashen_archer` | `3 × 0.70 × 1.55 = 3.255×` the archer's output, delivered at 14 m. At `mlvl 10` that is 51.9 DPS from a single ranged unit against a 165-life Ravager — more than the Maulsmith's 13.5 DPS in melee, from outside melee range |

**Redraw procedure.** Groups are drawn in order `immunity → power → utility`.
If a drawn affix would form an excluded pair with one already held, it is
removed from that group's candidate list and the group is redrawn **once** with
renormalised weights. The tables of §6.3 guarantee every group still has at
least one candidate after any single removal, so the redraw always succeeds and
a unique always ends with three affixes.

| First held | Group affected | Removed | Remaining candidates |
|---|---|---|---|
| `frostbound` | `power` | `swift` | `mighty`, `stoneskin` |
| `burning` | `power` | `stoneskin` | `swift`, `mighty` |
| `mighty` (on an archer) | `utility` | `multishot` | `hexing` |

### 6.6 Cost to the player, quantified

`03-combat-math.md` §11.3 puts a bare `mlvl 10` champion at
**11.10 / 9.19 / 10.40 s** and a bare unique at **22.62 / 18.41 / 21.84 s**.
This table shows what one affix does to the champion figure, so the danger
budget is an assertion rather than an opinion. Instruction tier;
`immunityValue = 85`.

| Affix | Ravager | Emberwright | Runeblade | Worst multiple |
|---|---:|---:|---:|---:|
| *(none)* | 11.10 s | 9.19 s | 10.40 s | 1.00× |
| `burning` | 11.10 s | **29.42 s** | 10.40 s | **3.20×** |
| `charged` | 11.10 s | 9.19 s | **14.63 s** | 1.41× |
| `frostbound` | 11.10 s | 9.19 s | 10.40 s | 1.00× |
| `swift` | 11.10 s | 9.19 s | 10.40 s | 1.00× |
| `mighty` | 11.10 s | 9.19 s | 10.40 s | 1.00× |
| `stoneskin` | **21.43 s** | 9.19 s | **17.52 s** | **1.93×** |
| `hexing` | 11.10 s | 9.19 s | 10.40 s | 1.00× |
| `vampiric` | 12.27 s | 10.31 s | 11.66 s | 1.12× |
| `multishot` | 11.10 s | 9.19 s | 10.40 s | 1.00× |

`swift`, `mighty`, `hexing` and `multishot` change nothing about time-to-kill —
they change **time-to-die**, which the survival column of §5.6 covers. Four are
defensive, and each in a different way:

- **`burning`** is the only one that targets a *class* rather than a build. At
  3.20× against the mono-element Emberwright and 1.00× against both weapon
  classes, it is the binding constraint on MB7 and the reason §6.4 gates
  immunity by tier.
- **`charged`** costs the Runeblade 1.41× because half its damage is the
  `blade_seal` lightning imbue: `18.45 × 0.25 = 4.61` instead of `14.76` per
  landed hit. It costs the other two nothing.
- **`stoneskin`** is the only affix the **Emberwright ignores entirely**:
  `defense × 2.5` is irrelevant to a packet with `attackRating 0`, and
  `damageReducePercent` is physical-only (`01-data-model.md` §3.4). It is a
  1.93× wall to the Ravager and a free pass to the caster — the exact inverse of
  `burning`, which is why the two are never on the same monster (§6.5).
- **`vampiric`** does not change the monster's life; it changes the *rate*. The
  champion leeches 30 % of the post-mitigation physical it deals, so its
  effective TTK is `351 / (playerDPS − 0.30 × championDPS)`. Against the softer
  reference builds it leeches more (4.13 life/s from the Emberwright versus
  3.02 from the Ravager) and the effect is largest where the player is weakest
  — which is the correct shape for a sustain affix and is why it caps out at
  1.12×.

`tools/balance.mjs` asserts **MB7**: no single affix raises a champion's TTK
above **3.5×** its bare value for any reference build, and no legal three-affix
unique combination raises the unique's TTK above **2.5×** its bare value. The
`burning`/Emberwright case is the binding constraint on the first and is the
reason §6.4 exists.

### 6.7 Telegraphs

Every affix must be identifiable **before** the player commits to the fight,
from the fixed camera, at the 50–92 px/m of `07-world-gen.md` §1.4, through
bloom. Rank aura first, affix layer second.

| Rank | Aura | Sound |
|---|---|---|
| `champion` | Blue rim light, `intensity 0.55`, radius 1.4 × `radius`, 0.8 Hz pulse | `champion.aura.loop`, `champion.spawn` (§17) |
| `unique` | Gold rim light, `intensity 0.85`, radius 1.8 × `radius`, plus a floating name plate | `unique.aura.loop`, `unique.spawn` |
| `minion` | Gold rim at `intensity 0.30`, no name plate | — |

| Affix | Visual | Audio |
|---|---|---|
| `burning` | Orange ember ribbon rising from the shoulders; `uGlow 1.4` on glow-masked vertices | `affix.fire.death` on the explosion |
| `charged` | Blue arc sparks between the limbs, 4 Hz; a bright pre-flash 0.35 s before each volley | `affix.lightning.charge` |
| `frostbound` | Pale-blue ground ring at **exactly the 7.0 m aura radius**, 0.15 m band, always drawn | `affix.cold.aura.loop` |
| `swift` | 5-sample motion trail, `uGlow 0.4`, plus a doubled footstep rate | `affix.swift.loop` (§17) |
| `mighty` | Limb scale `uScale 1.12`, deep red rim, heavier footstep | `affix.mighty.impact` (§17) |
| `stoneskin` | Grey crystalline shell over the silhouette, `roughness 0.25` | `affix.stoneskin.deflect` on a mitigated hit |
| `hexing` | Violet ground rune at the 8.0 m radius, drawn only during the 0.6 s cast | `affix.curse.cast` |
| `vampiric` | Red tether from the monster to whatever it last leeched, 0.4 s fade | `affix.vampiric.tick` |
| `multishot` | Three-pronged muzzle flare on a ranged action; a wider arc sweep on a melee one | `affix.multishot` |

**The frostbound ring is drawn permanently, not on a pulse.** It is the only
affix whose effect has a hard geometric edge the player must respect
continuously, and a telegraph that blinks is a telegraph that gets crossed.

Rarity and telegraph colours are sacred (`ARCHITECTURE.md` § Quality bar): the
champion blue and unique gold must survive tonemapping unchanged, and no affix
visual may use either hue.

---

## 7. Molgrim, the First Instructor

### 7.1 The actor

| Field | Value | Source |
|---|---|---|
| `archetypeId` | `molgrim` | `03` §9.1 |
| `rank` | `boss` — all rank multipliers 1.0; the bestiary row is already scaled | `03` §9.3 |
| `flags` | `boss \| noKnockback \| questCritical` | `03` §9.5, `01` §2.1 |
| `mlvl` | 15 / 27 / 37 (zone level, offset 0) | `03` §10.3 |
| `fasterHitRecovery` | 400 → 0.120 s hit recovery, 1.20 s immunity window | `03` §7.11 |
| `frozen` | immune; a freeze trigger applies `chilled` magnitude 60 for 2.0 s instead | `03` §7.2 |
| `stunned` | duration × 0.25, DR chain shared with `frozen` | `03` §7.7 |
| `lifeRegenRate` | 0.004 (boss and unique rate) | `03` §2.4 |
| Spawn | `SpawnPoint { kind: 'boss', x: 0, z: 5, facing: −π/2 }` via `ai.spawnBoss()` | `07` §8.4 |
| Excluded from | `targetTotal`, density, invariant I4 | `07` §8.4 |
| `leashRadius` | ∞ | `03` §9.1 |
| Corpse | none — a 6.0 s scripted death, then `despawning` | §7.10 |

**Stat block** across the three tiers, from base `430 / 16–30 / 25 / 90 / 900`:

| Tier | `mlvl` | Life | Damage | DEF | AR | XP | flat DR | Move |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| Instruction | 15 | **3 091** | 89–167 | 130 | 569 | 7 754 | 1 | 3.0 m/s |
| Trial | 27 | **8 183** | 208–389 | 220 | 979 | 21 747 | 3 | 3.0 m/s |
| Renunciation | 37 | **15 794** | 358–671 | 295 | 1 321 | 43 399 | 4 | 3.0 m/s |

The three life figures and the three XP awards reproduce `03-combat-math.md`
§10.3 and §10.5 E10.5–E10.7 exactly.

Resistances: fire 50, cold 50, lightning 50, poison 85, magic 40, physical 10.
At Renunciation poison reaches `85 + 40 = 125` — genuinely immune, and
intentionally so, since poison is not one of the three player elements
(`03-combat-math.md` §10.2).

### 7.2 Molgrim has no basic attack

Every hit he lands comes from a named pattern. `attackTime 1.80` and
`attackRange 4.5` exist to define the **damage unit** the pattern coefficients
multiply (`220 %`, `200 %`, `180 %`, `160 %`) and the reach at which a melee
pattern connects. He never throws an unnamed swing.

This is not a simplification, it is the load-bearing design decision of the
encounter. At `mlvl 15` his unit damage averages 128 against a reference clvl-13
Ravager with 210 life and DEF 218 at 77.46 % to hit — an unnamed basic attack on
a 1.80 s cycle would deal **55.1 DPS and kill that Ravager in 3.8 s** while the
player is busy reading a telegraph. Removing it makes the fight entirely a
question of whether the player resolves the pattern in front of them, which is
what a 60–90 s boss fight has to be.

### 7.3 Pattern damage across the tiers

Every coefficient is `03-combat-math.md` §9.5's.

| Pattern | Coefficient | Instruction (`mlvl 15`) | Trial (27) | Renunciation (37) |
|---|---:|---|---|---|
| `instructor_sweep` | 220 % physical | 196–367 | 458–856 | 788–1 476 |
| `instructor_dash` | 200 % physical | 178–334 | 416–778 | 716–1 342 |
| `ember_rings` | 180 % fire | 160–301 | 374–700 | 644–1 208 |
| `meteor_rain` (per impact) | 160 % fire | 142–267 | 333–622 | 573–1 074 |
| `syllable_burn` | 2 % of the **target's** `maxLife` per second as magic, −8 mana/s | — | — | — |
| `summon_ranker` | 4 × `bone_ranker` at `mlvl − 2` | `mlvl 13` | `mlvl 25` | `mlvl 35` |

**These numbers kill the reference builds outright and are meant to.** A single
`instructor_sweep` at Instruction averages 281 against a 210-life Ravager and a
96-life Emberwright. Every one of them is fully telegraphed with a margin of
at least **1.28×** (§7.7), and the entire encounter is the proposition that a
telegraph you can resolve twice over is fair even when failing it is fatal.
§15 D-3 records the lethality with the arithmetic; it is a property of
`03-combat-math.md` §9.5's coefficients, not a choice made here.

Phase I adds at `mlvl 13` (Instruction): life **120**, damage **14–28**,
DEF **83**, AR **250**, XP **50**.

### 7.4 Phase structure

| Phase | Life band | Band weight | Entry | Exit |
|---|---|---:|---|---|
| **I** | 100 – 60 % | 0.40 | `boss:phase {1}` on spawn, after a 1.0 s `spawning` state | `life ≤ 0.60 × maxLife` |
| **II** | 60 – 25 % | 0.35 | transition (below) | `life ≤ 0.25 × maxLife` |
| **III** | < 25 % | 0.25 | transition | death |

**Transitions** (`03-combat-math.md` §9.5): 1.5 s of `ACTOR_FLAG.invulnerable`
and a 0.20 s global hit-stop. During the window:

| t | What |
|---|---|
| 0.00 | `invulnUntil = now + 90`; `boss:phase { phase, actor }` emitted; all pattern cooldowns reset; the current action is cancelled outright |
| 0.00 | `boss.p2.transition` / `boss.p3.transition` (3 400 ms; the tail outlives the window, which is correct) |
| 0.00 → 1.50 | Molgrim walks to `(0, 0)` at 3.0 m/s if he is not already within 2.0 m of it, so every phase begins from the arena centre |
| 1.50 | invulnerability ends; the new phase's schedulers start |
| I → II, +4.00 | every surviving phase-I add enters `despawning` — phase II is never polluted by phase I's adds |
| II → III, 0.00 | the six inlaid rune spokes light (`fx`); `syllable_burn` begins |

The enrage timer (§7.9) is **paused** for the 1.5 s so a transition can never
advance it.

### 7.5 Phase I — 100 % to 60 %

Two patterns, on independent timers, both scheduled from the phase start.

#### `instructor_sweep` — every 4.5 s

| Property | Value | Source |
|---|---|---|
| Geometry | **220° wedge, 4.2 m** from Molgrim's centre | `07` §5.3 G1, `08` §6.3 |
| W / S / R | **0.95 / 0.15 / 0.60**, total 1.70 s | `08` §6.3 |
| Ticks | 57 / 9 / 36, `hitTick = tick0 + 57` | derived |
| Damage | 220 % physical, `knockback 100 %` | `03` §9.5 |
| Facing free | first 40 % of the wind-up = **0.38 s** | `08` §6.5 |
| Facing locked | from t = 0.38 s through the active window | `08` §6.5 |
| Telegraph | `anim:telegraph { shape: 'wedge', radius: 4.2, arc: 3.840 rad, ticks: 51, startTick: tick0 + 6 }` — the wedge decal appears at t = 0.10 s and fills over the wind-up | `08` §5.9, §6.4 |
| Resolution | one `physics.overlapCone(x, z, facing, 1.920 rad, 4.2, MASK.HOSTILE_TO_MONSTER, out)` on `hitTick` | — |
| Sound | `boss.p1.swing` (the sweep's cue; see §17) | `10` §5.1 I |
| Safe sector | the 140° behind him | derived |

The arena guarantees this pattern works: `07-world-gen.md` §5.3 G1 provides a
**clear inner disc of radius 10.6 m** (pillars at 11.5 m minus their 0.9 m
radius), so wherever Molgrim stands within 6.0 m of centre the entire wedge and
the entire safe sector land on open floor. The player resolves the telegraph by
walking, never by pathing around a pillar.

#### `summon_ranker` — every 20 s

| Property | Value | Source |
|---|---|---|
| W / S / R | **1.40 / 0.10 / 0.80**, total 2.30 s | `08` §6.3 |
| Ticks | 84 / 6 / 48 | derived |
| Count | 4 × `bone_ranker` at `mlvl − 2` | `03` §9.5 |
| Anchors | **8 fixed anchors at radius 7.0 m** from the arena centre, at 45° intervals starting at 22.5°; `ai` picks the **four furthest from the player**, ties by ascending anchor index | `07` §5.3 G2 |
| Anchor validity | all eight are on open floor (`7.0 + 0.9 < 10.6`) and 5.36 m apart | `07` §5.3 G2 |
| Telegraph | 4 rune decals at the chosen anchors, from wind-up tick 12 | `08` §6.3 |
| Spawn state | `ACTOR_STATE.spawning` for 1.00 s, invulnerable, no collision | `01` §1.4, `08` §5.5 |
| Cap | **8 boss adds alive**; a summon that would exceed it spawns only up to the cap | this document |
| Sound | `boss.p1.summon` | `10` §5.1 I |
| Despawn | 4.0 s after the I → II transition | §7.4 |

**The summon is free damage.** Molgrim is stationary and threatens nothing for
the full 2.30 s. That is the phase's rhythm: a punish window every 20 s in
exchange for four bodies. Phase I lasts 40 % of a 60–90 s fight — **24 to 36 s**
— so it contains **one or two** summons and never more than 8 adds total.

### 7.6 Phase II — 60 % to 25 %

#### `ember_rings` — every 9.0 s

The mechanic that sized the arena. `07-world-gen.md` §5.3 G3 fixes the
kinematics; `03-combat-math.md` §9.5 fixes the volley shape and the damage.
The two are reconciled here (§15 D-4) and the reconciliation is exact.

| Property | Value | Source |
|---|---|---|
| W / S / R | **1.10 / 0.20 / 0.70**, total 2.00 s | `08` §6.3 |
| Ticks | 66 / 12 / 42 | derived |
| Rings per volley | **3**, released at **1.55 s** intervals from the active tick | `03` §9.5 (three rings) + `07` G3 (`ringInterval 1.55`) |
| Spawn radius | 3.00 m | `07` G3 |
| Death radius | 17.00 m (the arena rim) | `07` G3 |
| Speed | **3.20 m/s** | `07` G3 |
| Lifetime | `(17.00 − 3.00) / 3.20 = 4.375 s` | `07` G3 |
| Concurrent rings | `4.375 / 1.55 = 2.82` → at most 3 | `07` G3 |
| Volley span | first spawn to last death = `3.10 + 4.375 = 7.475 s` | derived |
| Band thickness | **0.90 m**; damage applies once per ring per actor | this document |
| Damage | 180 % as fire, `attackRating 0`, `dodgeable false`, `blockable false` | `03` §9.5 |
| Gaps per ring | **3**, on three of the six inter-pillar bisectors | `03` §9.5 ("3 gaps") + `07` G3.2 (bisectors) |
| Gap width | **4.00 m of arc, constant at every radius** | `07` G3 |
| Gap angular width | `2 · asin(2.00 / r)` — 83.6° at r = 3.0, **40.9° at r = 5.73**, 13.5° at r = 17.0 | derived |
| Cast precondition | Molgrim within **6.0 m** of the arena centre; otherwise he walks there at 3.0 m/s first and the 9 s timer is not reset | `07` G3.4 |
| Sound | `boss.p2.firering` | `10` §5.1 I |

**How `03`'s "3 gaps of 40°" and `07`'s "4.00 m constant linear gap" are the
same statement.** A 4.00 m arc subtends `2 · asin(2.00 / 5.73) = 40.9°` at
`r = 5.73 m`, which is the mid-radius of a ring's useful life. `03`'s figure is
the angular gap at mid-flight; `07`'s is the invariant that produces it. A
constant *angular* gap would be 3.14 m wide at `r = 3` and 17.8 m at `r = 17` —
lethal at the start and free at the end. Constant linear width inverts nothing.

**Gap placement, per volley** (two `ai` draws, §14):

```
tripleIndex = S.int(0, 1)              // 0 → {30°, 150°, 270°}   (set A)
                                       // 1 → {90°, 210°, 330°}   (set B)
jitter      = S.range(-12°, +12°)      // ONE jitter, applied to all three gaps
gapCentres  = triple[tripleIndex] + jitter
```

**All three rings of a volley share the same gap bearings.** This is the single
most important rule in the phase. With rotating gaps the player would have to
cross 60° of arc in the 1.55 s between rings — 12.57 m at `r = 12`, needing
8.1 m/s — which is impossible for every class. With shared bearings the player
finds a **radial corridor** and stands in it for the whole volley. A melee
player standing in a corridor at 3.36 m from a centred Molgrim is safe from all
three rings **and can attack continuously**, which is where phase II's uptime
comes from (§7.8).

`07-world-gen.md` §5.3 G3.2 guarantees the gap is never plugged: the bisectors
sit 30° from every pillar bearing, a pillar subtends 4.49° at `r = 11.5`, and
the ±12° jitter leaves **≥ 13.5° = 2.71 m** of clear gap on the tight side.
G3.5's six permanent inlaid rune spokes are what teach the player that gaps only
ever appear on a spoke, so the mechanic stays readable when the ring's far side
is off screen.

#### `instructor_dash` — every 6.0 s

`03-combat-math.md` §9.5 gives the speed, damage and stun. `08-characters-visual.md`
§6.3 has no row for it, so W / S / R are specified here (§15 D-9) and are chosen
to fit `10-audio.md`'s 900 ms `boss.p2.dash` cue.

| Property | Value |
|---|---|
| W / S / R | **0.90 / (dash) / 0.55**; the dash itself replaces the active window |
| Ticks | 54 wind-up, dash `round(distance / 12 × 60)`, 33 recovery |
| Dash speed | **12 m/s** (`03` §9.5) |
| Dash distance | `clamp(dist(molgrim, lockPoint) + 2.0, 4.0, 10.0)` m → 0.33–0.83 s of travel |
| Lock point | the player's position at **t = 0.36 s** (40 % of the wind-up) |
| Lane | a rectangle `1.60 m` wide (2 × Molgrim's 1.10 m radius, minus overlap tolerance) along the dash bearing; resolved with `physics.overlapRect` at 6 substeps along the path, each actor hit at most once |
| Damage | 200 % physical, applies `stunned` for **0.8 s** |
| End position | at or 2.0 m past the lock point — **Molgrim ends the dash adjacent to where the player was** |
| Telegraph | `anim:telegraph { shape: 'line', radius: 10.0, arc: 1.60, ticks: 32, startTick: tick0 + 22 }` — the lane decal appears at t = 0.36 s, exactly when the lane is committed |
| Total cycle cost | 2.00 s of the 6.0 s period |
| Sound | `boss.p2.dash` |

The dash **ending on the player's old position** is deliberate: it means a melee
player who sidesteps 1.16 m is immediately back in contact and loses only the
sidestep, not a re-approach. A boss that dashes *away* from melee is a boss that
melee cannot fight.

Because the dash takes Molgrim off centre, `ember_rings`' 6.0 m precondition
regularly forces a walk back. That walk is capped at 2.0 s (6.0 m at 3.0 m/s)
and does not reset the 9 s ring timer, so a dash immediately before a ring
volley delays it by up to 2.0 s and nothing else.

### 7.7 Phase III — below 25 %

Three patterns. The cycle is **8.0 s** long and `meteor_rain` owns 5.60 s of it.

#### `meteor_rain` — every 8.0 s

| Property | Value | Source |
|---|---|---|
| W / S / R | **1.60 / 0.10 / 0.90**, total 2.60 s | `08` §6.3 |
| Ticks | 96 / 6 / 54 | derived |
| Impacts | **6**, over **3.0 s** from the active tick — one every 0.60 s | `03` §9.5 |
| Disc radius | **1.8 m** | `07` §5.3 G5, `08` §6.3 |
| Damage per impact | 160 % as fire, `attackRating 0`, `dodgeable false` | `03` §9.5 |
| Placement | disc 0 is forced onto the player's position at the cast tick; discs 1–5 are a **Poisson-disc pass with a 5.0 m minimum separation**, sampled inside `r ≤ 15.0 m` of the arena centre | `07` §5.3 G5 |
| Poisson budget | 12 dart throws per disc, 60 draws maximum; a disc that finds no spot is dropped and the count is reported | this document |
| Coverage | `6 · π · 1.8² = 61.1 m²` of `π · 17² = 907.9 m²` = **6.73 %** | `07` §5.3 G5 |
| Safe region | connected by construction: the minimum edge-to-edge gap is `5.0 − 3.6 = 1.4 m` against a 0.72 m player diameter | `07` §5.3 G5 |
| Telegraph | all six disc decals appear at wind-up tick 8 (t = 0.13 s) and hold for the full 1.60 s wind-up plus their own stagger | `08` §6.3 |
| Sound | `boss.p3.meteorrain`, hard-capped at 3 concurrent impacts | `10` §5.1 I |

Disc 0 landing on the player is the "do not stand still" tax and it is the only
one that is not free. The other five are placed once, visible for at least
1.60 s, and cannot fence anything off.

#### `blink` — 4.0 s cooldown, gated

`03-combat-math.md` §9.5 gives "`blink` every 4 s". Read as an unconditional
period against `07-world-gen.md` §5.3 G4's 6.0–13.0 m anchor rule, a melee class
would spend 20 % of every 4 s running and phase III uptime would collapse to
0.575 (§7.9's arithmetic). Read as a **cooldown with a gate** — which is what
"every 4 s" costs nothing to mean — it produces the 0.85 uptime `03` itself
assumes. The gate:

| Condition | Value |
|---|---|
| Cooldown | 4.0 s |
| Fires only when | the player is within **6.0 m** of Molgrim at the moment the cooldown expires, **or** Molgrim has had no line of sight to the player for 2.0 s |
| Suppressed while | `meteor_rain` is casting or its impacts are still landing — **5.60 s of the 8.0 s cycle** |
| Net rate against a melee player | **once per 8.0 s cycle** |
| Net rate against a ranged player | ~0.2 per cycle (the 6.0 m gate almost never opens) |

| Property | Value |
|---|---|
| W / S / R | **0.35 / 0.05 / 0.70**, total 1.10 s (fitting `boss.p3.teleport`'s 700 ms plus a 0.40 s materialise) |
| Ticks | 21 / 3 / 42 |
| Anchors | **12 fixed** — six at `r = 8.0 m` on 0°, 60° … 300°; six at `r = 14.0 m` on 30°, 90° … 330° (`07` §5.3 G4) |
| Selection | among anchors **6.0–13.0 m from the player**, prefer the inner ring (`r = 8.0`); among those, the one **furthest from the player's facing**; ties by ascending anchor index (`07` §5.3 G4) |
| Clearance | every anchor is ≥ 2.60 m from the nearest pillar surface and ≥ 3.0 m from the rim; Molgrim's 1.10 m radius clears each by ≥ 1.50 m (`07` §5.3 G4) |
| Mean chase for melee | 6.8 m of anchor distance, minus the 3.36 m melee stand-off = **3.44 m of travel** |
| Sound | `boss.p3.teleport` |

The inner-ring preference is what makes the chase 3.44 m instead of 9.6 m. It
is fully inside `07-world-gen.md` G4's stated rule — that rule constrains the
*candidate set* (6.0–13.0 m) and the *tie-break* (furthest from facing); it says
nothing about which of several qualifying anchors to prefer, and this document
fills that in.

#### `syllable_burn` — a persistent aura

| Property | Value | Source |
|---|---|---|
| Radius | 12.0 m from Molgrim | `03` §9.5 |
| Mana drain | **−8 mana/s** | `03` §9.5 |
| Life drain | **2 % of the target's `maxLife` per second as magic** | `03` §9.5 |
| `blinded` | applied for **1.0 s every 4.0 s** | `03` §9.5 |
| Application | a 4 Hz tick, `attackRating 0`, `dodgeable false`, `blockable false`, magic element so `magicResist` applies | this document |
| Escape | the aura is 12.0 m and the arena is 17.0 m, so a ranged class can stand outside it. A melee class cannot and is not meant to | derived |
| Sound | `boss.p3.manaburn.loop` | `10` §5.1 I |

**Cost, quantified.** Phase III is 25 % of the fight. Against the reference
clvl-13 Ravager (210 life, `magicResist 0`) over the ~20 s of phase III in a
77 s fight, `syllable_burn` deals `0.02 × 210 × 20 = 84` magic — 40 % of the
health bar, spread thin. Against the Emberwright it is a mana problem, not a
life problem (§7.10).

`blinded` costs the two attack-rating classes real damage and the Emberwright
none, because spells have `attackRating 0` and always hit:

| Class | AR | Blinded AR (−60 %) | Hit % normal | Hit % blinded | Phase III mean hit % | Phase III DPS ratio |
|---|---:|---:|---:|---:|---:|---:|
| Ravager | 260 | 104 | 61.90 | 41.27 | **56.75** | 0.9167 |
| Runeblade | 275 | 110 | 63.05 | 42.56 | **57.93** | 0.9187 |
| Emberwright | — | — | always hits | always hits | — | **1.0000** |

Weighted over the whole fight (phase III = 25 %) that is a **2.08 % / 2.03 % /
0 %** DPS loss. It is small, it is real, and §7.10 reports the TTK both with and
without it.

### 7.8 Safe-window analysis

Every pattern, against every class, inside the arena `07-world-gen.md` §5
specifies. **Committed window** is the time between the moment the geometry can
no longer change (the facing lock, or the ring's spawn, or the disc placement)
and the moment damage lands. **Required travel** is the distance from the
class's normal fighting position to safety. Required speed is their quotient.

Fighting positions: melee at `1.10 (Molgrim) + 0.36 (player) + 1.90 (weapon) =
3.36 m` from his centre; the Emberwright at 12.0 m, its `ember_bolt` range being
far longer.

| # | Pattern | Class | Committed window | Required travel | Required speed | Available | **Margin** |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | `instructor_sweep` | Ravager | 0.570 s | 1.20 m | 2.105 m/s | 4.2 | **2.00×** |
| 2 | `instructor_sweep` | Runeblade | 0.570 s | 1.20 m | 2.105 m/s | 4.3 | **2.04×** |
| 3 | `instructor_sweep` | Emberwright | — | 0 m (already at 12 m) | — | 4.0 | **∞** |
| 4 | `instructor_dash` | Ravager | 0.540 s | 1.16 m | 2.148 m/s | 4.2 | **1.96×** |
| 5 | `instructor_dash` | Runeblade | 0.540 s | 1.16 m | 2.148 m/s | 4.3 | **2.00×** |
| 6 | `instructor_dash` | Emberwright | 0.540 s | 1.16 m | 2.148 m/s | 4.0 | **1.86×** |
| 7 | `ember_rings` | Ravager @ 3.36 m | 1.100 s | 3.52 m arc | 3.198 m/s | 4.2 | **1.31×** |
| 8 | `ember_rings` | Runeblade @ 3.36 m | 1.100 s | 3.52 m arc | 3.198 m/s | 4.3 | **1.34×** |
| 9 | `ember_rings` | Emberwright @ 12.0 m, walking | 3.659 s | 12.57 m arc | 3.434 m/s | 4.0 | **1.16×** |
| 10 | `ember_rings` | worst case, knocked to r = 15 | 4.597 s | 15.71 m arc | 3.417 m/s | 4.2 | **1.23×** |
| 11 | `meteor_rain` disc 0 | all three | 1.600 s | 2.16 m | 1.350 m/s | 4.0 | **2.96×** |
| 12 | `summon_ranker` | all three | — | none — free damage | — | — | **∞** |
| 13 | `syllable_burn` | Emberwright | — | 0 m (12.0 m boundary) | — | — | **safe** |

**Worst margin in the encounter: 1.16×** — the Emberwright resolving a ring
volley from 12 m **on foot**. It is the only row in the table under 1.2×, and it
is the one place the encounter leans on a class skill rather than on walking
speed: `ashen_step` is a tier-1 blink on a 2.7 s cooldown against a 9.0 s volley
period, and using it makes the row unbounded. A caster that never blinks can
still resolve the volley, with 16 % to spare.

**How row 9 is computed.** With three gaps at 120° spacing the worst case is a
60° angular offset from the nearest gap. A ring of radius `R` and half-thickness
0.45 m first touches a player circle of radius 0.36 m standing at radius `p`
when `R ≥ p − 0.81`. The window is the 1.10 s ring telegraph — during which no
ring exists and the gap is already drawn — plus the ring's travel from
`R = 3.00` to that contact radius:
`1.10 + (12.00 − 0.81 − 3.00) / 3.20 = 1.10 + 2.559 = 3.659 s`. The travel is
60° of arc at `r = 12`: `12 × 60° × π/180 = 12.566 m`. Required
`12.566 / 3.659 = 3.434 m/s` against 4.0 available.

`07-world-gen.md` §5.3 G3.3 performs the same analysis for a **single**-gap ring
(180° worst case) at `r = 3.0` and finds a 2.1× margin. Three gaps at 120° is
strictly easier at every radius, so G3.3's guarantee is met with room to spare
and this document's table is the tighter of the two.

**Row 7's window is the telegraph alone.** A melee player at `p = 3.36 m` has a
contact radius of `3.36 − 0.81 = 2.55 m`, which is **inside** the 3.00 m spawn
radius — the ring is already touching them the instant it appears. Their entire
budget is the 1.10 s wind-up, over 3.518 m of arc, needing 3.198 m/s. A melee
player must therefore commit to a corridor *during the cast*, which is exactly
the read the six permanent rune spokes exist to make possible.

**The `ashen_step` shortcut.** The Emberwright's row 9 margin of 1.28× assumes
it walks. `ashen_step` (8–10 m blink, cooldown 2.7 s at slvl 5) resolves a ring
volley instantly for 8 mana, on a cooldown shorter than the 9.0 s volley period.
A player using it has an effectively infinite margin, which is what §7.9's
uptime figure for the Emberwright assumes.

### 7.9 Uptime, enrage and reset

#### Uptime

`03-combat-math.md` §9.5 declares per-phase uptime factors of
**0.95 / 0.82 / 0.85** with band weights 0.40 / 0.35 / 0.25, giving
`U = 0.8795 ≈ 0.88`, and §11.4 uses that flat 0.88 for all three classes. This
document reproduces `U` from the schedule above, per class, so the figure is
derived rather than asserted.

**Phase I** — dead time per 4.5 s sweep cycle plus per 20 s summon cycle:

| Class | Sweep escape (out + back) | per 4.5 s | Add pressure per 20 s | **Uptime** |
|---|---|---:|---|---:|
| Ravager | `2 × 1.20 / 4.2 = 0.572 s` | 12.71 % | 0.50 s (2.50 %) | **0.848** |
| Runeblade | `2 × 1.20 / 4.3 = 0.558 s` | 12.40 % | 0.50 s (2.50 %) | **0.851** |
| Emberwright | 0 — never inside 4.56 m | 0 % | 2.00 s (10.00 %) | **0.900** |

**Phase II** — per 9.0 s ring volley and per 6.0 s dash:

| Class | Ring corridor move (mean 30° offset) | per 9.0 s | Dash sidestep | per 6.0 s | **Uptime** |
|---|---|---:|---|---:|---:|
| Ravager | `1.76 / 4.2 = 0.419 s` | 4.66 % | `1.16 / 4.2 × 1.30 = 0.359 s` | 5.99 % | **0.893** |
| Runeblade | `1.76 / 4.3 = 0.409 s` | 4.55 % | `1.16 / 4.3 × 1.30 = 0.351 s` | 5.84 % | **0.896** |
| Emberwright | `ashen_step`, 0.15 s cast | 1.67 % | `1.16 / 4.0 × 2.75 = 0.798 s` | 13.30 % | **0.850** |

The Emberwright's dash cost is higher because the dash ends *on* it and it must
re-establish range; the melee classes only pay the sidestep.

**Phase III** — per 8.0 s cycle:

| Class | Blink chase | per 8.0 s | Meteor step | per 8.0 s | **Uptime** |
|---|---|---:|---|---:|---:|
| Ravager | `3.44 / 4.2 = 0.819 s` × 1 | 10.24 % | `2.16 / 4.2 = 0.514 s` | 6.43 % | **0.833** |
| Runeblade | `3.44 / 4.3 = 0.800 s` × 1 | 10.00 % | `2.16 / 4.3 = 0.502 s` | 6.28 % | **0.837** |
| Emberwright | gate rarely opens, 0.10 s | 1.25 % | `2.16 / 4.0 = 0.540 s` | 6.75 % | **0.920** |

**Weighted totals** at `0.40 / 0.35 / 0.25`:

| Class | Phase I | Phase II | Phase III | **U** |
|---|---:|---:|---:|---:|
| Ravager | 0.848 | 0.893 | 0.833 | **0.8600** |
| Emberwright | 0.900 | 0.850 | 0.920 | **0.8875** |
| Runeblade | 0.851 | 0.896 | 0.837 | **0.8633** |
| **mean** | 0.866 | 0.880 | 0.863 | **0.8703** |

Against `03-combat-math.md` §9.5's 0.95 / 0.82 / 0.85 and its `U = 0.8795`, the
schedule-derived mean is **0.8703** — a difference of **1.0 %**. The per-phase
figures diverge more (phase I is 8.8 % lower here, phase II 7.3 % higher)
because `03`'s three numbers are a single competent-player abstraction while
these are per-class dead-time accounting, but the quantity that actually enters
the TTK agrees to a percent. §15 D-10 records it; §7.10 reports both.

#### Enrage

`03-combat-math.md` §9.5 specifies no enrage. One exists solely to make a
stalemate impossible, and it is calibrated so that no build inside the locked
60–90 s window ever sees it.

| Property | Value |
|---|---|
| Arms at | **150 s** of combat time — 1.67× the top of the locked window |
| Stack interval | every 15.0 s thereafter |
| Per stack | `increasedAttackSpeed += 12`, `enhancedDamage += 15`, uncapped |
| At 240 s | 6 stacks → +72 IAS, +90 ED |
| Clock | counts only steps in which Molgrim is not `invulnerable`, so phase transitions cannot be used to stall it and cannot accidentally advance it |
| Reset | on the encounter reset only |
| Sound | `boss.enrage` per stack (§17) |

Enrage is an anti-stalemate device, not a DPS check. A player who out-regenerates
Molgrim but cannot out-damage him would otherwise fight forever; at 150 s the
fight starts closing itself. `tools/balance.mjs` asserts **MB5b**: no reference
build ever reaches the 150 s arm at any tier.

#### Reset

| Trigger | Effect |
|---|---|
| The player leaves the arena disc (`r > 17.0 m` from the arena centre) for **3.0 s** | Molgrim heals to full, every add despawns, `bossPhase` returns to 1, the enrage clock resets, and he walks back to `(0, +5)` |
| The player dies | the same |
| `zone:enter` | the encounter is torn down with the zone |

He never leashes toward the player (`leashRadius: ∞`) and never disengages
inside the arena. The reset is the only way the fight ends other than a death.
`02-api-contracts.md` §12 warns that `bossPhase` is not monotonic across a zone
reset; it is not monotonic across an arena reset either, for the same reason.

### 7.10 Time to kill

The staging is `03-combat-math.md` §11.4's: **clvl 13 against `mlvl 15`**, the
level a reference character reaches at the end of Bonereach. Molgrim: life
**3 091**, DEF 130, physical resist 10, fire/cold/lightning 50, flat DR 1.
Per-class DPS figures are §11.4's, unchanged.

| Class | Weapon / primary | DPS | `03` §11.4 `U = 0.88` | This document's `U` | **TTK (schedule `U`)** |
|---|---|---:|---:|---:|---:|
| Ravager | rare Battle Axe 12–26, +55 % ED, +25 AR, +20 % IAS | 46.18 | 76.1 s | 0.8600 | **77.83 s** |
| Emberwright | `ember_bolt` slvl 9, +35 % fire, +25 % FCR | 54.96 | 63.9 s | 0.8875 | **63.37 s** |
| Runeblade | rare Rune Sword 10–20, +50 % ED, `blade_seal` slvl 7 | 40.84 | 86.0 s | 0.8633 | **87.68 s** |

```
Ravager      3091 / (46.18 × 0.8600) = 3091 / 39.715 = 77.83 s
Emberwright  3091 / (54.96 × 0.8875) = 3091 / 48.777 = 63.37 s
Runeblade    3091 / (40.84 × 0.8633) = 3091 / 35.257 = 87.68 s
```

With `syllable_burn`'s `blinded` folded in as a whole-fight DPS multiplier
(§7.7: 0.9792 / 1.0000 / 0.9797):

| Class | DPS × `U` × blind factor | **TTK** | In 60–90 s? |
|---|---:|---:|:-:|
| Ravager | `39.715 × 0.9792 = 38.889` | **79.48 s** | **yes** |
| Emberwright | `48.777 × 1.0000 = 48.777` | **63.37 s** | **yes** |
| Runeblade | `35.257 × 0.9797 = 34.541` | **89.49 s** | **yes** |

**All three land inside the locked 60–90 s window on both accountings.** The
spread is `89.49 / 63.37 = 1.41×`, inside the M7 gate of 2×. The binding case is
the Runeblade at 89.49 s, with **0.51 s of margin** — the tightest number in the
encounter, and the reason `tools/balance.mjs` asserts it at a fixed seed as
**MB5**.

Compared with `03-combat-math.md` §11.4's 76.1 / 63.9 / 86.0 s, the
schedule-derived figures are +1.7 s / −0.5 s / +1.7 s on the flat-`U` accounting
and +3.4 s / −0.5 s / +3.5 s with `blinded` counted. Nothing here contradicts
§11.4; it refines it with two effects §11.4's method does not include (per-class
uptime, and the phase III blind).

#### The Emberwright's mana budget

`03-combat-math.md` §11.4 finds the Emberwright finishing "with an empty belt"
on **2** mana potions. That line does not include `syllable_burn`'s drain. With
it:

```
casts needed       3091 / 20.55                         = 150.4 → 151
mana needed        151 × 4.0                            = 604.0
pool at start                                           = 139.0
regen              5.56 /s × 63.37 s                    = 352.3
syllable_burn      8 /s × (0.25 × 63.37 s = 15.84 s)    = −126.7
net available      139.0 + 352.3 − 126.7                = 364.6
shortfall                                               = 239.4
potion_mana_greater (60 % of 139 = 83.4 each)           = 2.87 → 3
```

**The Emberwright must budget three `potion_mana_greater` for Molgrim, not
two.** Belt slots hold 20 of a stackable each (`03-combat-math.md` §8.8), so it
is affordable; it is a planning cost, not a wall. §15 D-13 records the
refinement.

#### Rage economy for the Ravager

At 61.90 % to hit on a 0.5625 s interval the Ravager banks
`0.6190 × 6 / 0.5625 = 6.603 rage/s` while in contact, or `6.603 × 0.860 =
5.679 rage/s` across the fight, plus `+4` per hit taken. `cleaving_strike` at
9 rage is therefore castable every **1.585 s** — comfortably inside the sweep's
4.5 s rhythm — and `whirlwind` at 12 rage/s runs a net −6.3/s, giving about
16 s of channelling from a full bar. Both are usable and neither is free, which
is the intent.

---

## 8. Crowd behaviour

### 8.1 Who does what

Three systems move a crowd and they do not overlap:

| Layer | Owner | When | What |
|---|---|---|---|
| **Goal** | `ai` | 10 Hz | Where this monster wants to stand — a ring slot, a lane offset, a flank waypoint |
| **Steering** | `ai` | 60 Hz | The direction it moves this step: flow field or path node, blended with local avoidance |
| **Push-out** | `physics.separate()` | 60 Hz, called by `actors` **once**, never by `ai` | Resolves the overlaps steering could not avoid |

`ai` never calls `physics.separate()` (`02-api-contracts.md` §4 forbids it) and
never writes `actor.x` / `actor.z` (§7 forbids it). Everything below is goal
selection and steering.

### 8.2 Ring slots — why monsters do not stack

A pack in contact does not path to the player's centre. Each member claims a
slot on a ring around the target:

```
ringRadius(archetype) = targetRadius + selfRadius + attackRange − 0.10
slotArc(archetype)    = 2.6 × selfRadius
slotCount             = floor(2π × ringRadius / slotArc)
slotAngle(i)          = targetFacing + π + 2π × i / slotCount
```

The `+ π` puts slot 0 **behind** the player, so a pack fills in from the back
and the front rank arrives last — which is what makes an approach read as a
surround rather than a charge.

| Archetype | `ringRadius` | `slotArc` | **Slots** | Max pack size |
|---|---:|---:|---:|---:|
| `bone_ranker` | 2.54 m | 0.988 m | **16** | 12 |
| `carrion_swarm` | 1.90 m | 0.624 m | **19** | 12 |
| `maulsmith` | 2.71 m | 1.430 m | **11** | 12 |
| `blight_crawler` | 1.88 m | 1.092 m | **10** | 12 |
| `ashen_archer` | 11.00 m (hold band) | 0.884 m | **78** | 12 |
| `dust_shaman` | 8.00 m | 0.936 m | **53** | 12 |

Slot capacity is never the binding constraint at the shipping pack sizes. Slot
assignment is by **ascending `actorId` into ascending slot index**, recomputed
every decision (10 Hz) — deterministic, allocation-free, and stable enough that
a monster does not swap sides every tick.

A member whose slot is unreachable (`nav.flowDistance` infinite, or
`nav.raycastNav` fails) takes the next free slot in index order. If none is
reachable it holds at the last reachable point and re-tests next decision.

### 8.3 Local avoidance

RVO and ORCA are rejected: both are O(n²) inside a neighbourhood, both need a
linear-programming step whose floating-point behaviour depends on constraint
ordering, and neither survives the determinism contract without a sort that
costs more than the algorithm. What ships is a one-step velocity blend:

```
avoid = 0
n = physics.overlapCircle(x, z, 1.60, MASK.ACTORS, out)
sort out by (distance, actorId) ; take the first 4
for each other in the first 4:
    d = dist(self, other)
    w = (other is the player)              ? 1.60
      : (flagsAt(self) & NAV_FLAG.doorway) ? 0.50
      :                                      1.00
    avoid += normalize(self − other) × w × (1.60 − d) / 1.60

steer = normalize( desired × 1.00 + avoid × 0.55 )
```

| Property | Value |
|---|---|
| Query radius | 1.60 m |
| Neighbours considered | **4**, by distance then `actorId` — a total order, so the result is reproducible |
| Cadence | **20 Hz** (every 3 steps, phase `actorId % 3`); the vector is held between updates |
| Blend weight | 0.55 — enough to slide past a pack-mate, not enough to override a path |
| Doorway weight | 0.50, matching the halved separation weight `NAV_FLAG.doorway` already carries (`01-data-model.md` §9.3) |
| Cost | `physics.overlapCircle` ≈ 0.9 µs; at 25 monsters and 20 Hz that is 8.33 queries/step = **7.5 µs/step** |

The player's 1.60 weight is what stops monsters from walking *through* the space
the player is trying to occupy, which is the difference between a surround and a
shove.

### 8.4 Approach formation

Three modes, selected once when a pack transitions from `alert` to `chase` and
held for the engagement.

| Mode | Selected when | Behaviour | Extra A* cost |
|---|---|---|---:|
| `direct` | `count ≤ 5`, **or** the pack is in an open macro cell | every member on the flow field to its ring slot | 0 |
| `arc` | `count` 6–9 | members split by `actorId` parity into two wings; each wing steers to a staging point 3.5 m to the player's left / right, then converges on ring slots | 0 |
| `flank` | `count ≥ 10`, **or** difficulty is Renunciation (§11.3) | three groups by `actorId % 10`: 40 % `direct`, 30 % via a waypoint at `player + 6.0 m` on bearing `+100°` from the pack→player bearing, 30 % at `−100°` | **2 per pack** |

Flank waypoints are `nav.snap`ped with a 3.0 m radius; a group whose waypoint
fails to snap or whose `nav.regionAt` differs from the player's falls back to
`direct` and the fallback is counted. The two extra A* requests are per **pack
engagement**, not per member — which is precisely the load the ring budget of
§9 exists to absorb.

`arc` and `flank` exist for one reason: a pack that arrives as a single mass
from one bearing is a pack the player kills by backing into a corner. Splitting
the arrival bearing is what makes positioning a decision.

### 8.5 The corridor problem

> *How does a pack of 12 avoid becoming a single-file queue in a Bonereach
> corridor?*

Bonereach corridors and doorways are guaranteed **≥ 3.0 m** wide
(`07-world-gen.md` §6.3). A 3.0 m corridor holds three Bone Rankers abreast
(`3 × 0.76 = 2.28 m` of body plus 0.72 m of clearance). Four mechanisms, in
order of how much work they do:

**1. Lane offset.** Every member carries a lane index `L ∈ {−1, 0, +1}`,
assigned so the pack's lanes are balanced (`L = (packSlotIndex % 3) − 1`). In a
corridor — detected as `nav.flagsAt(self) & NAV_FLAG.doorway`, or a cell whose
8-neighbourhood has ≤ 5 walkable cells — the steering target becomes the flow
direction plus a lateral offset of

```
laneOffset = L × min(0.90, (corridorWidth − 2 × selfRadius) / 2)
```

At 3.0 m and `radius 0.38` that is `L × 0.90`, giving three lanes 0.90 m apart.
This alone converts a 12-long queue into a 3 × 4 column.

**2. Ranged and support never queue.** The Ashen Archer's `desiredRange` is
11.0 m and the Dust Shaman's is 8.0 m. Neither ever enters the contact ring, so
in a 12-strong `pk_deep_warband` the 2 archers and 1 shaman occupy the corridor
*behind* the melee and shoot over it. Projectiles are 2.5D
(`07-world-gen.md` §1.3) and a corridor gives them clean line of sight along its
axis. That removes 3 of 12 bodies from the queue before any steering runs.

**3. Doorway yielding.** A member whose next path node is a `doorway` cell
already occupied by ≥ 2 pack-mates enters the `reposition` doorway-queue
sub-mode (§3.1) for up to 1.2 s: it steers to a wall lane and waits instead of
pushing. The `NAV_FLAG.doorway` halved separation weight
(`01-data-model.md` §9.3) does the rest, so a doorway drains rather than jams.

**4. Rank rotation.** A melee member blocked on its own lane by a pack-mate for
> 2.0 s swaps lane index with the front-rank member on an adjacent lane. The
swap is initiated by the **lower `actorId`** and both indices are exchanged in
one operation, so it is deterministic and cannot desynchronise.

**Result.** A 12-strong pack in a 3.0 m Bonereach corridor presents **3 melee in
contact, 3 in the second rank rotating forward, 3 ranged firing over them, and
3 in a doorway queue behind**. The player faces three at a time — which is the
texture `03-combat-math.md` §11.5's five-monster arithmetic is built on, and it
is why a corridor fight is survivable at a pack size that would be lethal in the
open (§5.6: eight in contact is 3.45 s of life).

In open ground the same 12 arrive on 16 ring slots in `flank` formation and the
player faces all of them. That difference — corridor throttles, open ground does
not — is the whole tactical content of choosing where to fight.

---

## 9. Navigation budget

### 9.1 The budget

| Quantity | Value | Source |
|---|---:|---|
| A* solves per fixed step | **4** | `nav.setBudget(4)`, the `02-api-contracts.md` §6 default |
| A* solves per second | **240** | derived |
| Node cap per solve | **1 200** expanded nodes, then abort | this document |
| Cost per expanded node | ~55 ns (heap push/pop + 8 neighbours + cost lookup) | model |
| Worst-case solve | `1 200 × 55 ns = 66 µs` | derived |
| Typical solve | ~180 nodes = **9.9 µs** | model |
| Worst-case A* per step | `4 × 66 = 264 µs` | derived |
| Typical A* per step | `4 × 9.9 = 39.6 µs` | derived |
| Flow-field rebuild | every **12 steps** (5 Hz) or when the player has moved > 2.0 m, whichever first | this document |
| Flow-field extent | cells within **32 m** of the player — a 128 × 128 window, 16 384 cells | this document |
| Flow-field build cost | bucketed monotone Dijkstra, ~18 ns/cell = **0.295 ms** | model |
| Flow-field amortised | `0.295 / 12` = **24.6 µs/step** | derived |
| `ai` fixedUpdate budget | **0.60 ms** (3.6 % of a 16.6 ms frame) | this document |

A solve that hits the 1 200-node cap is **not** retried: the brain is demoted to
the flow field for 30 steps and the abort is counted in
`nav.stats.refusals`. A 1 200-node budget covers a 40 m path through Bonereach's
worst corridor topology with ~6× slack over the straight-line node count; a
solve that exceeds it is asking for something the flow field answers better.

### 9.2 The ring scheduler

```
each fixed step:
  granted = 0
  for k in 0 .. brainCount-1:
      i = (repathCursor + k) % brainCount
      b = brains[i]
      if not needsPath(b): continue
      id = nav.requestPath(b.x, b.z, b.goalX, b.goalZ, b.actorId)
      if id === 0:                       // budget full for this step
          b.useFlowField = true
          b.repathAtStep = now + 30
          break                          // stop offering; try again next step
      b.pathRequestId = id
      b.repathAtStep  = now + 45 + (b.actorId % 9)
      granted += 1
      if granted === 4: break
  repathCursor = (repathCursor + k + 1) % brainCount
```

```
needsPath(b) =
      b.state ∈ {chase, reposition, flee}
  and not b.useFlowField
  and ( b.path === null
     or b.pathVersion !== nav.version
     or now ≥ b.repathAtStep
     or dist²(b.goal, b.pathGoal) > 6.25 )        // goal moved > 2.5 m
```

`repathCursor` advancing past the last brain it *considered* — not the last it
granted — is what makes the queue fair: every brain is offered the budget once
per `ceil(brainCount / 4)` steps regardless of how many refuse. At 25 monsters
that is a full sweep every **7 steps (117 ms)**.

The `+ (actorId % 9)` jitter on `repathAtStep` spreads the 0.75 s repath
interval over 9 steps so a pack that engaged together does not repath together.

### 9.3 Flow field versus A*

**The flow field is the default.** A brain uses it whenever all of:

- its target is the player, **and**
- `nav.flowDistance(x, z)` is finite (same region, inside the 32 m window),
  **and**
- `ai.activeCount ≥ 8`.

A brain **requires A*** when any of:

| Case | Why |
|---|---|
| The goal is not the player | The field is built toward the player only. This covers the Shaman's corpse, the Archer's retreat point, a flank waypoint and a leash anchor |
| `flowDistance` is `Infinity` | Different region, or outside the 32 m window — the field cannot answer |
| `activeCount < 8` | A small fight gets real paths. They look better, they cost nothing at that count, and the budget is idle anyway |
| `state === 'flee'` | The destination is 12 m away from the player, i.e. *up* the field's gradient |
| `state === 'reposition'` (leash) | The destination is the pack centre |

**Hard demotion.** `02-api-contracts.md` §12: *"Above 40 active monsters every
agent is on the field and A* is reserved for agents that have left the crowd."*
Implemented as: when `ai.activeCount > 40`, `needsPath` returns false for every
brain in `chase`; only `flee` and leash-`reposition` may request a path.

**One field per step, at most.** `ai` is the only caller of
`nav.buildFlowField()` (`02-api-contracts.md` §6 forbids anyone else) and calls
it on the 12-step cadence, never more.

### 9.4 Path invalidation

`ZoneInstance.navVersion`, `NavGrid.version` and the `zone:ready` /
`nav:rebuilt` payloads always carry the same process-global monotonic integer
(`07-world-gen.md` §6.2 N11, §6.7). A brain compares `pathVersion !== nav.version`
and repaths; a `PathHandle` is never held across a version change
(`02-api-contracts.md` §6).

On `nav:rebuilt`, `ai` walks every brain **once**:

```
for i, b in brains:
    b.path          = null            // nav has already released the handles
    b.pathIndex     = 0
    b.pathVersion   = nav.version
    b.useFlowField  = true
    b.repathAtStep  = now + (i % 45)  // spread the storm over 0.75 s
```

Without the `i % 45` spread, a zone rebuild would put every brain into
`needsPath` on the same step and the ring scheduler would spend the next
`brainCount / 4` steps at saturation. With it, the demand is flat and the field
covers the gap.

Hazards (`NAV_FLAG.hazard`, `+12` cost) are written by `skills` through
`nav.markHazard` and **do not** bump `nav.version`
(`07-world-gen.md` §6.6). A path planned before an Ash Wall appeared stays
valid; the brain simply walks through a hazard it would have routed around had
it planned a moment later. That is accepted: re-planning 25 paths because a
6 m wall appeared for 8 s costs more than the mistake does, and the local
avoidance layer already steers around the wall's physics body.

### 9.5 Measured cost at 25 monsters

Estimates from the model above, on a 3.0 GHz desktop core, typed arrays,
monomorphic call sites, zero allocation. They become measurements at step 12 of
§13, where `tools/profile.mjs` reports p50/p95/p99.

| Item | Rate | Unit cost | **Per step** |
|---|---|---:|---:|
| Brain decisions | 25 brains at 10 Hz = 4.17/step | 3.5 µs | **14.6 µs** |
| Perception `raycastNav` | ≤ 1 per decision = 4.17/step | 2.2 µs | **9.2 µs** |
| Local avoidance queries | 25 at 20 Hz = 8.33/step | 0.90 µs | **7.5 µs** |
| Steering integrate + slot lookup | 25/step | 0.14 µs | **3.5 µs** |
| Flow-field sampling | 25/step | 0.12 µs | **3.0 µs** |
| Path node advance | 25/step | 0.18 µs | **4.5 µs** |
| A* solves | 4/step, typical | 9.9 µs | **39.6 µs** |
| Flow-field rebuild | 0.295 ms every 12 steps | — | **24.6 µs** |
| Pack bookkeeping, aggro, noise | — | — | **5.2 µs** |
| Boss pattern scheduler | when alive | — | **1.5 µs** |
| | | **typical total** | **113.2 µs** |
| | | **worst case** (4 capped solves) | **337.6 µs** |
| | | **budget** | **600 µs** |
| | | **headroom** | **5.3× typical, 1.8× worst** |

At the plan's stated stress point of **40 active monsters**, decisions rise to
6.67/step (23.3 µs), avoidance to 13.3/step (12.0 µs), steering and sampling to
5.6 + 4.8 + 7.2 µs, and A* is hard-demoted to `flee`-only — so the total
*falls* to roughly **96 µs**, because the dominant term (A*) is exactly what the
demotion removes. The system gets cheaper under load, which is the point of the
demotion rule.

`physics.separate()` is not on this budget. It is called by `actors` once per
step and is charged to `physics` (`02-api-contracts.md` §4).

Assertions: **MB12** (`refusals / (refusals + solved) < 0.02` over a 600 s
scripted run) and **MB13** (`ai` fixedUpdate p95 < 0.30 ms at 25 monsters), §12.

---

## 10. Spawning and lifecycle

### 10.1 The spawn pass

`ai` listens to `zone:ready` and never to `zone:enter`
(`02-api-contracts.md` §5). On that event it reads `world.packs` and
`world.spawnPoints` and instantiates in a fixed order:

```
on zone:ready { zoneId, bounds, navVersion }:
    for pack in world.packs, in ascending PackDescriptor.id:
        roster = resolve(packTemplate(pack.archetypeId) ?? pack.archetypeId,
                         pack.count)                             // §5.2
        promote(roster, pack.rank)                               // §5.7
        affixes = pack.affixes                                   // already rolled by world
        for pt in world.spawnPoints where pt.packIndex === pack.id,
                in ascending SpawnPoint.id:
            actor = ai.spawnOne(roster[k], pt.x, pt.z, pack.mlvl, rank[k], affixes)
            pack.members.push(actors.ref(actor))
    for pt in world.spawnPoints where pt.kind === 'wanderer':  … as above at count 1
    for pt in world.spawnPoints where pt.kind === 'npc':       … team = TEAM.neutral
    if a SpawnPoint of kind 'boss' exists:  ai.spawnBoss(pt.x, pt.z, zone.monsterLevel)
```

`Actor.id` is assigned by `actors.acquire()` in call order, so the id ordering
that every deterministic tie-break in this document relies on — slot assignment,
champion promotion, decision phase offsets, corpse selection, chain propagation
— is itself a function of the seed and nothing else.

`world` writes nothing back; `ai` fills `members[]`, `spawned` and `aliveCount`
on the descriptor, which `01-data-model.md` §9.5 sanctions.

### 10.2 The entrance safety radius

`07-world-gen.md` §8.5 places pack centres and spawn points at a minimum
**path** distance from the zone entry, using the BFS distance field computed
during nav pass N7:

| Zone | Pack centre min | `SpawnPoint` min | `spawnDeny` disc |
|---|---:|---:|---|
| `ashen_wastes` | 16.0 m | 11.0 m | 8.0 m |
| `bonereach` | 14.0 m | 10.0 m | 8.0 m + the whole `entry` room |
| `altar_of_instruction` | 12.0 m | 9.0 m | 8.0 m + the whole approach corridor |
| `last_bastion` | — | — | the whole zone |

`ai` **re-asserts** the `SpawnPoint` minimum at spawn time rather than trusting
it: a point below the minimum is pushed outward along the gradient of the entry
distance field to the nearest cell that satisfies it, and the correction is
counted as `SPAWN_PUSHED`. Over the 200-seed sweep this should fire on zero
points; a non-zero count means `world` and `ai` disagree about the distance
field and that is a bug in one of them, surfaced rather than absorbed.

16.0 m of path against the Bone Ranker's 3.2 m/s is **5.0 s** of grace, against
a black-to-playable window of 1.1 s (`07-world-gen.md` §10.3) — 3.9 s for the
player to read the frame before anything can reach them.

### 10.3 Activation

A pack is instantiated at `zone:ready` but not *running*. Three tiers:

| Tier | Condition | Brain | Animation | Physics body | Cost/monster/step |
|---|---|---|---|---|---:|
| **C — dormant** | pack not activated | not ticked | no mesh, `view.visible = false` | **absent** | ~0 |
| **B — reduced** | pack activated, actor outside the camera trapezoid | decisions at **5 Hz**, movement at 60 Hz, no avoidance query | animator skipped | present | ~1.9 µs |
| **A — full** | pack activated, actor inside the trapezoid + 6 m | decisions at 10 Hz, movement at 60 Hz | L0/L1 per `08` §9.2 | present | ~4.5 µs |

| Property | Value |
|---|---|
| Activation radius | **34.0 m** Euclidean from the pack centre to the player |
| Deactivation radius | **42.0 m** (8 m hysteresis) **and** no member damaged in 10.0 s |
| On activation | bodies added via `physics.addBody`, brains set to `dormant` (not `alert` — activation is not perception), `actor:spawn` emitted |
| On deactivation | bodies removed, brains released, actors returned to `dormant`; **life, statuses and `aliveCount` are preserved** — a pack the player retreats from is the same pack when they come back |

34 m is chosen against the camera: the visible ground reaches **11.68 m ahead of
the player** (`07-world-gen.md` §1.4) and the longest `aggroRadius` is the
Archer's 18.0 m, so a pack activates 34 − 18 = 16 m before it could possibly
notice the player and 34 − 11.68 = 22 m before it could be seen to appear.
Nothing ever pops in on screen.

**This is how "10–25 on screen" is met.** A Wastes run holds 55–105 monsters
across 9–12 packs; typically **2–3 packs, 12–30 monsters** are active at once,
and the camera trapezoid shows a subset of those. Tier B still moves at 60 Hz so
a pack that was fought and fled arrives coherently rather than teleporting.

`ai.setDensityBudget(maxActive)` (`02-api-contracts.md` §12) hard-caps tier A+B:
above it, the pack whose centre is furthest from the player is forced back to
tier C regardless of hysteresis. Defaults track `config.q.maxActors`.

### 10.4 Off-screen LOD detail

Tier B suppresses, in this order:

1. The local-avoidance `overlapCircle` query (§8.3) — the held vector is reused.
2. The perception `raycastNav` (§4.2) — off-screen packs still wake from noise
   and from `alertPack`, which need no ray.
3. `view.visible = false`, so `actors` skips pose evaluation, IK, springs and
   the skeleton upload entirely (`08-characters-visual.md` §9.4's whole cost).
4. Ring-slot recomputation drops to 5 Hz with the decision.

Tier B does **not** suppress movement, cooldowns, DoT ticks, status expiry or
`combat:hit-request`. An off-screen monster that is in range still attacks; a
burning off-screen monster still burns down. Suppressing simulation off screen
would make `tools/balance.mjs` results depend on the camera, which the
determinism contract forbids.

### 10.5 Despawn

| Trigger | Behaviour |
|---|---|
| `world.enterZone` | `ai.despawnAll(keepQuestCritical = true)`; brains released, bodies removed, pools returned |
| Owner death | `ACTOR_FLAG.summoned` actors expire with their owner (`01-data-model.md` §2.1) |
| Molgrim I → II | phase I adds enter `despawning` 4.0 s after the transition (§7.4) |
| Escaped the bounds | any actor more than 2.0 m outside `ZoneInstance.bounds` is despawned immediately and counted as `ESCAPED` — it should never happen, and if it does, `physics` has a bug |
| `blight_crawler` T4 | 25.0 s in `chase` without reaching its target → it detonates rather than despawning (§2.6) |
| `questCritical` | Molgrim is never despawned by cleanup, only by the zone teardown |

Nothing despawns because it went off screen. Deactivation (§10.3) is not
despawn: the actor record persists with its life and statuses intact.

### 10.6 Corpses

Corpse policy is `08-characters-visual.md` §8's and `ai` only reads it.
Restated because the Shaman depends on the numbers:

| Property | Value | Source |
|---|---|---|
| Lifetime | **25.0 s**, then a 1.5 s ash dissolve | `08` §8.3 |
| Budget | `q.corpseBudget` = 6 / 10 / 16 / 20 by preset | `08` §8.3 |
| Eviction | oldest first; a **resurrectable** corpse is exempt for its first 12.0 s | `08` §8.3 |
| All exempt | the oldest exempt corpse is marked non-resurrectable and then evicted, so the order stays total | `08` §8.3 |
| Gibbed instead | killing blow ≥ 35 % of `maxLife`, a `burning`-affix death, or a Crawler detonation | `08` §8.4 |
| Never a corpse | `carrion_swarm` (instanced, §2.2), `blight_crawler` (always detonates, §2.6), `molgrim` (§7.10) | this document |
| Not resurrectable | everything except `bone_ranker` | `08` §8.5 |

### 10.7 Resurrection

The one place `ai` writes a dead actor back into the live world.

```
on raise_ranker hitTick:
    handle = the corpse chosen at cast start                 // §2.4, §3.6
    if handle is no longer valid (dissolved, evicted, gibbed):
        the cast fizzles, the credit is NOT refunded, cooldown starts
        sound: none
        return
    ok = actors.resurrect(handle, 0.60)                      // 60 % of base maxLife
    if not ok: as above
    brain              = ai.acquireBrain(actor)
    brain.packId       = shaman.brain.packId
    brain.state        = 'chase'
    brain.targetRef    = shaman.brain.targetRef
    brain.pathVersion  = nav.version
    brain.useFlowField = true
    actor.flags       |= ACTOR_FLAG.revived
    pack.aliveCount   += 1
    shaman.brain.reviveCredits -= 1
```

| Rule | Detail |
|---|---|
| Fizzle | If the corpse vanished between cast start and `hitTick`, the credit **is** consumed — the Shaman spent the ritual. A refund would let it re-target for free every 8 s |
| Interruption | A `stunned` / `frozen` / death **before** `hitTick` cancels the cast and **refunds** the credit (`08-characters-visual.md` §6.6) |
| Cannot re-raise | `ACTOR_FLAG.revived` is permanent and `08-characters-visual.md` §8.5's eligibility test excludes `resurrectCount > 0` |
| Visual | `uDissolve` 1 → 0 over 0.80 s, root rises from −0.35 m; targetable and AI-active from t = 0.45 s; a permanent `uDissolve` floor of 0.08 marks it as revived (`08-characters-visual.md` §8.5) |
| No visual gap | the skinned mesh is added in the same `lateUpdate` in which the batched corpse instance is released — an acceptance criterion, not an aspiration (`08-characters-visual.md` §8.5) |
| Pack accounting | `aliveCount` increases, which can lift a `carrion_swarm` pack back above its 40 % scatter threshold. That is correct and it is why the scatter fires **once per pack per zone visit** (§2.2) |
| XP | The revived Ranker awards XP again on its second death. With 1 credit per Shaman per zone visit, the maximum extra XP in a Wastes run is 3 Shamans × 21 XP = **63 XP** against a level costing 4 769. Not exploitable; not worth a special case |
| Determinism | No RNG anywhere in this path. Corpse selection is nearest-then-id (`08` §8.5); the credit is an integer |

### 10.8 What `ai` must never do to a corpse

`ai` does not despawn corpses, does not extend their lifetime, does not reserve
them, and does not mark one as claimed. Two Shamans in the same pack that both
cast at the same corpse will both pick it (the selection is a pure function of
position and id); the second one's `actors.resurrect` returns `false` and its
cast fizzles per §10.7. Reserving corpses would require cross-brain state, a
release path on the Shaman's death, and a leak whenever a reservation outlived
its holder — for a case that occurs only in `pk_shaman_vault` and resolves
correctly by itself.

---

## 11. Difficulty tiers

`03-combat-math.md` §10.2 owns the scaling: `mlvl` offsets **+0 / +12 / +22**,
life × 1.00 / 1.15 / 1.35, damage × 1.00 / 1.10 / 1.20, XP × 1.00 / 1.20 / 1.45,
monster resists +0 / +20 / +40, player elemental resists −0 / −40 / −100.
`07-world-gen.md` §8.6 owns population: `tierDensityMul` 1.00 / 1.10 / 1.20,
`champChance` × 1.00 / 1.35 / 1.70, `uniqueChance` × 1.00 / 1.30 / 1.60. This
section is only what `ai` adds on top of those two.

### 11.1 Resulting monster levels

Using `03-combat-math.md` §10.2's offsets, which are authoritative
(§15 D-5):

| Zone | Instruction | Trial | Renunciation |
|---|---:|---:|---:|
| `ashen_wastes` | 6 | **18** | **28** |
| `bonereach` | 11 | **23** | **33** |
| `altar_of_instruction` | 15 | **27** | **37** |

### 11.2 Affix frequency

| Tier | `champChance` (Wastes) | `uniqueChance` (Wastes) | Champions/run | Affixes per champion | Affixes per unique |
|---|---:|---:|---:|---:|---:|
| Instruction | 0.160 | 0.060 | ~1.7 packs → **5** champions | 1 | 3 |
| Trial | 0.216 | 0.078 | ~2.3 packs → **7** champions | 1 | 3 |
| Renunciation | **0.272** | 0.096 | ~2.9 packs → **9** champions | 1 | 3 |

Affix **counts** do not change per tier — `03-combat-math.md` §9.3 fixes them at
1 and 3 and this document does not override that. What changes is how often you
meet one. At Renunciation a little over one pack in four is elite, which is
`07-world-gen.md` §8.6's stated intent: *"Renunciation is not 'the same map with
bigger numbers', it is a map where a quarter of the fights are elite."*

### 11.3 New behaviours per tier

Every entry is a behaviour `ai` owns outright. None touches a number another
document fixes.

| Tier | Change | Rationale |
|---|---|---|
| **Instruction** | baseline; `blight_crawler` sympathetic chain **off**; `immunityValue = 85` (§6.4) | The first hour teaches one mechanic at a time |
| **Trial** | `ashen_archer` gains **`retreat_volley`**: one shot per retreat, fired while moving backwards at 70 % damage, once per entry into the retreat band | Kiting stops being free for the player |
| | `dust_shaman` `raise_ranker` cooldown **8.0 → 6.5 s** (credit count unchanged at 1) | The ritual is a shorter window to interrupt |
| | `blight_crawler` sympathetic chain **on**, 0.25 s links, depth cap 3 | Clusters become a hazard and an opportunity at once |
| | `immunityValue = 100` — true immunity; `fireResistPierce` and friends become load-bearing | Itemisation starts mattering |
| **Renunciation** | `bone_ranker` `shield_guard` trigger **20 % → 35 %** | Player DPS loss against a Ranker rises from 4.05 % to 7.09 % |
| | `dust_shaman` `raise_ranker` cooldown **6.5 → 5.0 s** | — |
| | `maulsmith` gains a **second slam** inside the same commitment: a second `overlapCircle` 0.35 s after the first, radius 3.2 m, at **60 %** of the slam's damage. The wind-up, the floor and the facing lock are unchanged | The telegraph now teaches "and then step back again", without shortening a single committed window |
| | Every pack of `count ≥ 6` uses **`flank`** approach formation regardless of size (§8.4) | You cannot back into a corner any more |
| | `carrion_swarm` scatter threshold **40 % → 25 %** | The swarm holds together longer |

The Renunciation Maulsmith's second slam is the only new damage instance in the
table, and it is deliberately placed **after** the first: a player who resolved
the telegraph is already outside 3.56 m and the second slam misses them for
free. It punishes stepping back in early, not failing to step out.

### 11.4 Immunities

| Source | Instruction | Trial | Renunciation |
|---|---|---|---|
| `03` §10.2 monster resist bonus | +0 | +20 | +40 |
| `immunity`-group affix (§6.4) | 85 → **75 % effective**, not immune | 100 → 120 with the tier bonus, **immune** | 100 → 140, **immune** |
| Molgrim poison | 85 | 105 → **immune** | 125 → **immune** |
| Anything else | none | none | none |

No normal or champion monster reaches 100 in a player-facing element without the
corresponding affix, at any tier — which is `03-combat-math.md` §10.2's stated
guarantee and this section does not break it. Molgrim's poison immunity from
Trial upward is intentional: poison is not one of the three player elements.

Pierce requirements, so the itemisation target is explicit:

| Tier | Affix immunity | Pierce needed to reach the 75 % cap |
|---|---:|---:|
| Trial | 120 | **45** points |
| Renunciation | 140 | **65** points |

`fireResistPierce` and its four siblings cap at 150 (`01-data-model.md` §3.3),
so both are reachable, and 65 points is a real itemisation commitment rather
than a formality.

### 11.5 What does not change per tier

Stated so nobody adds it later:

- **No new archetypes.** Six plus a boss at every tier.
- **No new patterns for Molgrim.** His three phases are identical at every tier;
  only his numbers scale. A boss whose moveset changes per difficulty has to be
  re-learned three times, which is a worse experience than a harder version of a
  fight you know.
- **No layout change.** `seed = hash(worldSeed, zoneId, runIndex)` contains no
  tier term (`07-world-gen.md` §8.6), so the same `runIndex` produces the
  identical map with a heavier population.
- **No change to any committed telegraph window.** The Maulsmith's 0.90 s floor,
  the Crawler's 0.85 s fuse, the Shaman's 1.05 s ritual and all four of
  Molgrim's wind-ups are the same in Renunciation as in Instruction. Difficulty
  raises the cost of failing a telegraph; it never shortens the time to read
  one.

---

## 12. Validation

### 12.1 What `tools/balance.mjs` runs

Four modes, all headless in Node, all at a fixed seed. `ai`'s data tables, the
FSM transition tables, `combat` and `nav` import nothing from `three` and touch
no DOM, which is what makes this possible (`ARCHITECTURE.md` hard rule 9).

| Mode | Invocation | What it does |
|---|---|---|
| `--bestiary` | scaling only | Evaluates every bestiary row at `mlvl` 1…40 × 5 ranks × 3 tiers and compares against the closed forms of `03-combat-math.md` §10.1 |
| `--ttk` | combat only | Runs each reference build against each archetype, rank and tier; no brains, no nav |
| `--boss` | scripted encounter | Runs the Molgrim schedule with a scripted "competent player" that resolves every telegraph at the margins of §7.8, producing measured uptime and TTK |
| `--sim` | full | Spawns real packs on a real nav grid over the 200 `mapgen` seeds and runs 600 s of simulation per seed |

### 12.2 Assertions

| id | Assertion | Bound |
|---|---|---|
| **MB1** | Every bestiary row's life, damage, DEF, AR and XP at every `mlvl` 1…40, every rank and every tier equals `round(base × mlvlMult × rankMult × difficultyMult)` | exact, integer |
| **MB2** | Normal-rank TTK for each reference build against each archetype at its zone `mlvl` | inside §2.7's per-archetype band |
| **MB3** | Champion TTK at `mlvl 10`, no affix | 8.0 – 13.0 s |
| **MB4** | Unique TTK at `mlvl 10`, no affix | 17.0 – 26.0 s |
| **MB5** | Molgrim TTK, clvl 13 vs `mlvl 15`, all three builds, with the schedule-derived `U` and the phase III blind | **60.0 – 90.0 s** |
| **MB5b** | Molgrim combat time never reaches the 150 s enrage arm for any reference build at any tier | < 150 s |
| **MB6** | Class TTK spread against every target, every rank, every tier | < 2.0× the median |
| **MB7** | No single affix raises a champion's TTK above 3.5× its bare value; no legal three-affix unique combination raises a unique's TTK above 2.5× | see §6.6 |
| **MB8** | No legal affix combination produces an infinite TTK for any reference build at any tier | TTK finite |
| **MB9** | Stand-still survival time of every pack template against the reference build at the zone `mlvl` | ≥ 3.0 s |
| **MB10** | `ai.rollAffixes` over 100 000 draws matches §6.1's weights; never two affixes from one group on a unique; never an excluded pair; never an ineligible affix for the archetype | ±1.5 % on weights, 0 violations |
| **MB11** | Every pack template resolves to exactly `count` members at every count 5…12 and never violates a member minimum | exact |
| **MB12** | `nav.stats.refusals / (refusals + solved)` over a 600 s `--sim` run | < 0.02 |
| **MB13** | `ai` `fixedUpdate` cost at 25 active monsters | p95 < 0.30 ms |
| **MB14** | Determinism: the same seed produces an identical kill order, identical cumulative damage and an identical final `ai.stats` over 10 000 steps, across two processes | byte-identical |
| **MB15** | Measured per-phase boss uptime in `--boss` against §7.9's declared 0.848 / 0.893 / 0.833 (Ravager) and the other two rows | ±0.05 absolute |
| **MB16** | Perception, the **unsafe** direction: no walkable cell pair within `aggroRadius` may pass `nav.raycastNav` while `physics.lineOfSight` blocks it. See the ruling below for why the conservative direction carries no budget | **exactly 0** |
| **MB17** | Every `SpawnPoint` satisfies its zone's path-distance minimum (§10.2) without correction | `SPAWN_PUSHED === 0` |
| **MB18** | Every archetype's `hitTick`, computed from `08-characters-visual.md` §6.1 at IAS 0, matches §2's tick columns | exact |
| **MB19** | The Maulsmith's wind-up never falls below 0.90 s and the Crawler's fuse never below 0.85 s, at any IAS from any affix or tier combination | floors hold |
| **MB20** | Every `archetypeId` referenced by a pack template appears in that zone's `ZoneDescriptor.bestiary` | exact |

### 12.3 Failure output format

One block per failure on `stderr`, machine-greppable, followed by a summary line
on `stdout`. Exit code **1** if any `FAIL` was emitted, **0** otherwise.

```
FAIL  MB5.runeblade  boss ttk out of band
      expect   60.000 <= ttk <= 90.000
      actual   ttk = 94.583 s
      inputs   clvl=13 mlvl=15 tier=instruction seed=0x1F3AC09B
               dps=40.840 uptime=0.817 blindFactor=0.9797 life=3091
      derive   3091 / (40.840 * 0.817 * 0.9797) = 94.583
      source   docs/spec/06-monsters-ai.md §7.10
```

```
FAIL  MB10.exclusion  illegal affix pair on unique
      expect   {frostbound, swift} never co-occur
      actual   unique 'Mireglyph, the Palimpsest' archetype=bone_ranker
               affixes=[frostbound, swift, vampiric]
      inputs   mlvl=18 tier=trial seed=0x00000B27 packId=7 draw=41293
      source   docs/spec/06-monsters-ai.md §6.5
```

Field contract:

| Line | Content |
|---|---|
| `FAIL` | `<assertion id>.<case>` then a short lower-case description |
| `expect` | the bound, as an expression a reader can evaluate |
| `actual` | the measured value, to three decimals for reals |
| `inputs` | every input needed to reproduce, including the seed and the RNG draw index |
| `derive` | the arithmetic, present only when the failure is a computed quantity |
| `source` | the document section the number came from |

Summary line, always emitted:

```
balance: 20 assertions, 18 pass, 2 fail, 0 skip — 4.31 s — seed 0x1F3AC09B
```

A `skip` is recorded and never silently ignored: an assertion that could not run
because its dependency failed prints `SKIP <id> blocked by <id>`. An assertion
that is not implemented yet prints `SKIP <id> unimplemented`, so the step-by-step
build of §13 has an honest progress readout rather than a green run that tests
nothing.

### 12.4 What is deliberately not asserted

- **Nothing about frame rate, draw calls or triangle counts.** Those belong to
  `tools/profile.mjs` and to `08-characters-visual.md` §9.
- **Nothing about how a fight *feels*.** MB2's bands and MB5's window are the
  only proxies, and they are honest about being proxies.
- **No assertion on affix visual legibility.** That is a `baseline.mjs` shot
  ("dense fight", per the plan's risk table), not an arithmetic test.

---

## 13. Implementation order

Twelve steps. Each ends with a check that can be run in isolation and that fails
loudly if the step is wrong. The first two deliver the single monster M2 needs.

| # | Step | Deliverable | Verified by |
|---:|---|---|---|
| **1** | **Bestiary data** | `src/ai/data/bestiary.js` — the seven `MonsterArchetype` records of §1 and §2, plus the `mlvl` scaling functions. Plain objects, imports nothing | `node tools/balance.mjs --bestiary` → **MB1**, **MB18**, **MB20** pass. No `three`, no DOM, no brain |
| **2** | **The `bone_ranker` brain — M2's monster** | `Brain` pool, the shared FSM of §3.3 restricted to `{dormant, chase, attack, dead}`, `attack` emitting `combat:hit-request` on `hitTick`, direct steering with no nav | A Bone Ranker spawned by hand in the M1 test map walks to the player, swings on schedule, deals damage, dies, and awards XP. `tools/balance.mjs --ttk` → **MB2** passes for `bone_ranker` alone |
| **3** | **Perception and aggro** | §4 in full: the perception test, `blindFactor`, leash, de-aggro, the noise ring, `ai.alertPack` and its wake ripple, cross-pack bleed | **MB16**. A hand-placed six-Ranker pack wakes as a ripple within 0.50 s from one trigger, and leashes home when the player runs 34 m |
| **4** | **Nav integration** | §9 in full: the ring scheduler, `needsPath`, flow-field cadence and extent, the demotion rules, `nav:rebuilt` invalidation with the `i % 45` spread, local avoidance | **MB12**, **MB13** at 25 hand-spawned Rankers. `nav.stats.refusals` stays under 2 % and `ai.stats.flowUsers` rises as the count does |
| **5** | **Crowd** | §8: ring slots, lane offsets, doorway yielding, rank rotation, the three approach formations | A 12-strong pack in a 3.0 m corridor presents 3 abreast and never single-files; the same pack in the open arrives on 16 slots from three bearings |
| **6** | **The remaining five archetypes** | §2.2–2.6 and §3.4–3.8: swarm surround and scatter, archer kiting and the cornered rule, shaman priority and `haste_dust`, Maulsmith commitment, Crawler fuse and chain | **MB2** passes for all six. **MB19**: the wind-up floors hold under every IAS the affix and tier tables can produce |
| **7** | **Pack templates and the spawn pass** | §5.1–5.6, §10.1–10.5: template resolution, `bestiaryWeights`, `ai.spawnPack`, activation tiers, despawn | **MB11**, **MB17**, **MB20**, **MB9**. `tools/mapgen.mjs` reports composition per zone and the density stays inside I4's ±20 % |
| **8** | **Champions, uniques, affixes** | §5.7, §5.8, §6 in full: promotion, minion inheritance, group draws, exclusions, the redraw, `immunityValue`, name generation, telegraph hooks | **MB3**, **MB4**, **MB7**, **MB8**, **MB10** |
| **9** | **Corpses and resurrection** | §10.6–10.8: `actors.resurrectableCorpses` wiring, `raise_ranker`'s fizzle and refund rules, the fresh brain, pack accounting | A Shaman raises exactly one Ranker per zone visit; a stun before `hitTick` refunds the credit and a stun after does not; no corpse is ever raised twice |
| **10** | **Molgrim** | §7 in full: the three phases, all six patterns, transitions, the 8-anchor summon ring, the 12 teleport anchors, gap-triple selection, the enrage and the reset | **MB5**, **MB5b**, **MB15**. `tools/balance.mjs --boss` reports uptime within ±0.05 of §7.9 and TTK inside 60–90 s for all three builds |
| **11** | **Difficulty tiers** | §11.3's per-tier behaviours, `immunityValue(tier)`, the cooldown and threshold changes, `flank` forcing | **MB2**–**MB8** re-run at Trial and Renunciation. **MB11** at every tier |
| **12** | **The harness** | §12: all twenty assertions, the failure format, `--sim` over the 200 `mapgen` seeds, and the `ai` cost profile that replaces §9.5's estimates with measurements | `balance.mjs` exits 0 with 20/20 pass, and `tools/profile.mjs` reports `ai` p95 under 0.30 ms at 25 monsters |

**Dependency notes.** Steps 1–2 are the critical path and gate M2. Step 4
depends on `nav` being complete (M1) and is the gate for M5's density. Steps 6
and 7 can run in parallel with 8. Step 10 depends on 7 (the approach packs) and
on `07-world-gen.md`'s arena existing, and it gates M6. Step 12 can begin at
step 1 and grow one assertion at a time — the `SKIP … unimplemented` line of
§12.3 exists precisely so it does.

**What is explicitly not in the order.** No seventh monster, no fourth boss
phase, no additional affix, and no behaviour not listed above, before M7. The
plan's anti-scope-creep rule applies to `ai` more than to any other subsystem,
because a monster is the cheapest thing in the project to add and the most
expensive to balance.

---

## 14. RNG draw order

`ai` takes one `ctx.rng.fork()` in `init()` and never re-forks
(`ARCHITECTURE.md` determinism contract). Every draw below comes from that one
stream, in this order. Reordering any two of them changes every run from a given
seed and invalidates every fixture.

### 14.1 At `zone:ready`, per pack, in ascending `PackDescriptor.id`

| # | Draw | Count | Notes |
|---:|---|---:|---|
| 1 | affixes — champion: group by weight, then affix within the group | 2 | only when `rank === 'champion'`; `world` has already rolled the rank |
| 1' | affixes — unique: one per group in the order `immunity → power → utility` | 3 | plus **1** redraw per excluded pair encountered (§6.5) |
| 2 | unique name: epithet index, then title index | 2 | only when `rank === 'unique'` |

Template resolution (§5.2), champion member selection (§5.7), minion inheritance
and ring-slot assignment draw **nothing** — all four are deterministic functions
of `count` and `actorId`.

### 14.2 Per fixed step, brains processed in ascending `actorId`

| Draw | When | Count |
|---|---|---:|
| `shield_guard` trigger | on every landed hit against a `bone_ranker` | 1 |
| wander destination | when a `wander` brain reaches its previous destination | 1 (`nav.randomPoint` consumes it) |
| archer strafe flip | every 2.0 s while in the hold band | 1 |

`raise_ranker` target selection, `haste_dust` targeting, Crawler chain
propagation, leash destinations, flank waypoints and every boss anchor choice
draw nothing.

### 14.3 Molgrim, per cast

| Pattern | Draws | Order |
|---|---:|---|
| `instructor_sweep` | 0 | facing is the target's bearing |
| `summon_ranker` | 0 | the four furthest of eight fixed anchors, ties by index |
| `ember_rings` | **2** | `tripleIndex` = `S.int(0,1)`, then `jitter` = `S.range(−12°, +12°)`, once per volley and shared by all three rings |
| `instructor_dash` | 0 | the lock point is the player's position at t = 0.36 s |
| `blink` | 0 | anchor selection is a total order (§7.7) |
| `meteor_rain` | **≤ 60** | disc 0 is forced; discs 1–5 are Poisson darts, ≤ 12 throws each |

`meteor_rain` is the only pattern with a variable draw count, and it is bounded:
the loop is `for i in 1..5 { for try in 0..11 { … } }` with no retry-until-success
anywhere, so the draw count depends on the arena geometry and the disc positions
already accepted, both of which are themselves deterministic. A retry-until-
success loop would be an unbounded number of draws and a determinism hazard the
moment a single position changed — the same reasoning `07-world-gen.md` §3.2 R8
gives for its sixteen-try dart throw.

### 14.4 What must never draw

- **No draw in `update()` or `lateUpdate()`.** Every one of the above is in
  `fixedUpdate`.
- **No draw from wall-clock time, `Math.random`, `performance.now` or
  `Date.now`.**
- **No draw whose count depends on the frame rate**, the camera, the LOD tier,
  or whether an actor is on screen. §10.4 is explicit that tier B suppresses
  presentation only.

---

## 15. Disagreements recorded

Fourteen places where two binding documents disagree, or where a binding
document leaves a number this one had to supply. Each states what was chosen,
why, and the arithmetic.

**D-1 — Display names.** `03-combat-math.md` §9.1 names four archetypes
*Bone Ranker*, *Ashen Archer*, *Maulsmith*, *Blight Crawler*;
`08-characters-visual.md` §6.3 names the same four *Bone Ratling*, *Ash Archer*,
*Hammerfell Brute*, *Bloat Crawler*. `01-data-model.md` §2.3's worked
`MonsterArchetype` carries `displayName: 'Bone Ranker'`, which sides with `03`.
**Chosen: `03`'s names** (§1.1), on the grounds that it is the authoritative
document, that `01` agrees with it, and that the ids are unambiguous either way.
`08` §6.3's rows map one-to-one and no timing figure is affected.

**D-2 — The Maulsmith's id.** `03-combat-math.md` §9.1 and §9.2 use
`maulsmith`. `07-world-gen.md` §4.1's Bonereach `bestiary` array uses
`hammerfell_brute`. Only one can be the key into
`src/ai/data/bestiary.js`. **Chosen: `maulsmith`.** `07` §4.1's array needs the
one-token correction; until it is made, **MB20** fails on Bonereach, which is
the correct behaviour for an id mismatch.

**D-3 — Sweep geometry, telegraph length and lethality.**
`03-combat-math.md` §9.5 describes `instructor_sweep` as *"0.90 s telegraph,
180° cone 5.5 m"*. `08-characters-visual.md` §6.3 gives *W 0.95 / S 0.15 /
R 0.60, 220° wedge, 4.2 m*, and `07-world-gen.md` §5.3 G1 sizes the arena's
clear inner disc against *"a 220° wedge at 4.2 m"* explicitly.
**Chosen: 220° at 4.2 m with W 0.95** — the two later documents agree with each
other and the arena guarantee is built on those exact numbers. Period (4.5 s),
coefficient (220 %) and knockback (100 %) are taken from `03` unchanged.

The arithmetic that decides it: at 5.5 m a melee player at 3.36 m must travel
`5.5 + 0.36 − 3.36 = 2.50 m` in the 0.54 s committed window (0.90 s telegraph,
40 % free facing), needing **4.63 m/s** — more than any class has. At 4.2 m the
travel is 1.20 m in 0.570 s, needing **2.105 m/s**, a 2.00× margin (§7.8 row 1).
`03`'s geometry is not dodgeable by a melee class; `08`'s and `07`'s is.

Separately: at `mlvl 15` the sweep averages **281 damage** against a 210-life
reference Ravager and a ~96-life Emberwright, so a landed sweep is usually
fatal. That is a property of `03` §9.5's 220 % coefficient applied to `03`
§9.1's damage row, not a choice made here. It is recorded rather than softened,
and §7.8 is the compensating guarantee.

**D-4 — Ember ring kinematics.** `03-combat-math.md` §9.5: *"three rings
expanding at 4.0 m/s to 14 m, 180 % as fire, each ring has 3 gaps of 40°"*.
`07-world-gen.md` §5.3 G3: spawn 3.00 m, death 17.00 m, speed **3.20 m/s**,
lifetime 4.375 s, interval 1.55 s, gap **4.00 m of constant linear width**
centred on an inter-pillar bisector with ±12° jitter.
**Chosen: `07`'s kinematics, `03`'s volley shape and damage** (§7.6). `07` G3 is
the constraint that sizes the arena and its arithmetic is self-consistent with
the 17 m rim, the 11.5 m pillar ring and the 10.6 m clear disc; `03`'s 14 m
would leave a 3 m safe annulus at the rim and delete the mechanic.

The two "gap" figures reconcile exactly rather than by fiat: a 4.00 m arc
subtends `2 · asin(2.00 / 5.73) = 40.9°` at `r = 5.73 m`, a ring's mid-flight
radius. `03`'s "40°" is `07`'s constant width, measured mid-flight.

**D-5 — Difficulty `mlvl` offsets.** `03-combat-math.md` §10.2 gives
**+0 / +12 / +22**, producing zone levels 6/18/28, 11/23/33, 15/27/37, and its
§10.3 worked table, its §11 calibration and its §10.5 XP examples all use them.
`07-world-gen.md` §8.6 gives **+0 / +9 / +17**, producing 6/15/23, 11/20/28,
15/24/32 — and says in the same section that *"`DIFFICULTY_MLVL_OFFSET` is a
combat-owned table: its authority is `03-combat-math.md` §10"*.
**Chosen: `03`'s +12 / +22** (§11.1), on `07`'s own instruction, and **applied**:
`07` §8.6 now carries `+0 / +12 / +22` and the zone-level table 6/18/28,
11/23/33, 15/27/37. Its `tierDensityMul`, `champChance` and `uniqueChance`
multipliers are `world`'s own and are used unchanged.

**D-6 — Resurrection radius.** `03-combat-math.md` §9.2 says *"within 8.0 m"*;
`08-characters-visual.md` §8.5 says *"within 9.0 m of the Shaman"*.
**Chosen: query at 8.0 m** (§2.4), which is strictly inside 9.0 m, so both
constraints hold simultaneously and neither document is contradicted.

**D-7 — Crawler radius.** `03-combat-math.md` §9.2 gives a damage radius of
3.0 m; `08-characters-visual.md` §6.3 gives a telegraph decal of `r = 3.2 m`.
**Chosen: damage 3.0 m, decal 3.2 m** — kept as written. The decal being 0.2 m
larger than the hit is player-favourable (the safe line is inside the drawn
line) and is the right direction for a mismatch to run.

**D-8 — Monster block has no shield.** `03-combat-math.md` §5.3: *"`block%` is
**0** without a shield in `offHand`, regardless of `stats.blockChance`"*. But
`01-data-model.md` §2 gives every monster `equipment: null`, so a Bone Ranker
can never satisfy it, and `03` §9.1 nonetheless specifies a guard that grants
*"`+40 blockChance` during it"*. **Chosen: extend `03` §5.3's short-circuit** to

```
blockEligible = (target.equipment?.offHand !== null)
             || (target.kind === 'monster' && target.stats.blockChance > 0)
```

which changes nothing for the player and enables exactly one monster mechanic.
Quantified cost: 4.05 % of player DPS against a Bone Ranker, lifting its
level-10 TTK from 2.26 s to 2.35 s (§2.1) — inside the locked 1.5–3.0 s band, so
no calibration figure in `03` §11 moves.

**D-9 — `attackTime` versus W / S / R, and two missing rows.**
`03-combat-math.md` §4.5 says the three phases *"sum to the interval"*, and
`01-data-model.md` §2.3 stores `windupFrac 0.42` for the Bone Ranker against an
`attackTime` of 1.40 s — implying a 0.588 s wind-up. `08-characters-visual.md`
§6.3 gives the Bone Ranker `W = 0.42 s` and a 0.85 s total.
**Chosen: `attackTime` is the period between attack *starts*, and W / S / R are
the animation** (§2.0). The difference is an **idle tail** during which the
monster may reposition but may not start another attack: 0.55 s for the Ranker,
0.60 s for the Archer, 0.21 s for the Swarm, 0.01 s for the Maulsmith. This
reading satisfies `08` exactly, satisfies `03` §4.3's definition of
`attackInterval` exactly, and reproduces `03` §9.2's *"1.21 s windup"* for the
Maulsmith through `08`'s 1.20 s to within a rounding step.

Two rows have no source and are specified here: `dust_shaman`'s basic
`dust_bolt` (W 0.50 / S 0.06 / R 0.42) and Molgrim's `instructor_dash`
(W 0.90 / dash / R 0.55). Both are chosen to fit an existing `10-audio.md` cue
length and both are listed in §2.4 and §7.6.

**D-10 — Boss uptime.** `03-combat-math.md` §9.5 declares per-phase uptime of
0.95 / 0.82 / 0.85 → `U = 0.8795`, and §11.4 applies that flat figure to all
three classes. This document derives uptime from the schedule, per class, and
gets **0.8600 / 0.8875 / 0.8633**, mean **0.8703** — a 1.0 % difference in the
quantity that enters TTK, and larger per-phase differences (phase I 8.8 % lower,
phase II 7.3 % higher) because `03`'s three numbers are one competent-player
abstraction and these are per-class dead-time accounting. **Both are reported**
(§7.10) and both put all three builds inside 60–90 s. `03` §11.4's figures are
not contradicted; they are refined.

**D-11 — Mixed packs.** `PackDescriptor.archetypeId` is a single id
(`01-data-model.md` §9.5) and `07-world-gen.md` §8.3 draws it from an undefined
`bestiaryWeights()`. A pack of one archetype cannot express *"one Shaman, three
Rankers, two Archers, two Swarmers"*. **Chosen: `archetypeId` may name a pack
template** (§5.1), prefixed `pk_` so it can never collide with a bestiary id,
resolved by `ai.spawnPack()`. No record changes, `world` is untouched, and
`07`'s own scope statement — *"`world` … never decides what a pack is made of"*
— is honoured rather than worked around.

**D-12 — The Emberwright's base speed.** `07-world-gen.md` §5.3 G3.3 computes a
ring-crossing margin *"at the Emberwright's 3.9 m/s base"*.
`03-combat-math.md` §2.1 gives `runSpeed 4.0`. **Chosen: 4.0 m/s.** The
difference favours the player, so `07` G3.3's guarantee holds a fortiori; every
margin in §7.8 uses 4.0.

**D-13 — The Emberwright's boss mana budget.** `03-combat-math.md` §11.4
concludes the Emberwright finishes Molgrim on 2 mana potions with 605 mana
available against 602 needed. That line does not include `syllable_burn`'s
−8 mana/s over the 25 % of the fight that is phase III — **126.7 mana** at a
63.37 s TTK. With it counted the shortfall is 239.4 mana and the requirement is
**three `potion_mana_greater`, not two** (§7.10). A refinement of §11.4's
method, not a contradiction of its result: the TTK is unchanged.

**D-14 — Immunity would break the Emberwright at Instruction.** Every damaging
skill on both Emberwright trees deals `fire`. Against a `burning` champion at
`fireResist = 100` its DPS is exactly zero and its TTK is infinite, at a
difficulty where no `fireResistPierce` affix is yet in the drop pool.
`03-combat-math.md` §9.4 and `ARCHITECTURE.md` both state that immunity exists
on champion affixes, and neither says from which tier. **Chosen: gate it** —
`immunityValue = 85` at Instruction (75 % effective reduction, TTK 29.4 s) and
`100` at Trial and above (§6.4). This is a roll-time gate on a value `03` leaves
as a single number, and it is the binding constraint on assertion **MB7**.

---

## 16. Additions folded into `02-api-contracts.md`

> **Status: applied.** A1–A6 are in `02-api-contracts.md` §§7, 8, 6 and 12, and
> the three new events are in that document's `ai` row and in
> `ARCHITECTURE.md`'s event table. Kept as rationale, not as a request.

Six entries. Each names the section it belongs in, the exact signature, and the
place in this document that needs it. Nothing here changes an existing
signature.

### A1 — `ai.packTemplate`

```
| `packTemplate` | `(id:string) => PackTemplate \| null` | Y | no |
```

§12 `ai`. Returns the frozen template record for a `pk_`-prefixed id, or `null`
for a bestiary id. Needed by §5.1 so `tools/mapgen.mjs` can report pack
composition per zone without instantiating `ai`, and by **MB11** and **MB20**.

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

### A2 — `actors.resurrectableCorpses`

```
| `resurrectableCorpses` | `(x,z,radius:number, out:int[]) => int count` | Y | no |
```

§7 `actors`, in **Lifecycle**. `08-characters-visual.md` §8.5 names this method
and specifies its ordering ("sorted by distance then by corpse id") but
`02-api-contracts.md` §7 does not list it. `actors.resurrect(actor, lifeFraction)`
is already listed; this is the query that finds its argument. Needed by §2.4 and
§10.7.

### A3 — `combat.expireBySource`

```
| `expireBySource` | `(sourceId:int, sourceGen:int, status:string\|null) => int expired` | Y | no |
```

§8 `combat`. Expires every `StatusEffectInstance` whose `sourceId`/`sourceGen`
match, optionally filtered by status, and emits `actor:status` with
`duration: 0` for each. `StatusEffectInstance` already carries both fields
(`01-data-model.md` §7.1), so this is a query over existing state. Needed by
§2.4: killing a Dust Shaman strips the `haste_dust` it granted, which is the
mechanic that teaches the player to kill it.

### A4 — `ai.priorityTargets`

```
| `priorityTargets` | property → `int[]` — actor ids, read-only | Y | no |
```

§12 `ai`. The live list of actors `ui` should mark. Today it holds every
`dust_shaman`; `03-combat-math.md` §9.1 requires the marker ("priority target
marker in `ui`") without providing a way for `ui` to learn about it. Needed by
§2.4.

### A5 — `nav.flowVersion`

```
| `flowVersion` | property → `int` | Y | no |
```

§6 `nav`. Increments on every `buildFlowField()`. `ai` samples the field on
every step but rebuilds it only every 12 (§9.1); a brain that cached a
`flowDistance` needs to know whether the field under it is the one it sampled.
`nav.version` cannot serve — it tracks the **grid**, not the field, and the two
change on completely different cadences.

### A6 — `ai.bossPhaseProgress`

```
| `bossPhaseProgress` | property → `number` 0..1 | Y | no |
```

§12 `ai`. The boss's progress through its current life band, so `ui` can draw
phase pips on the boss health bar. `ai.bossPhase` is already listed and returns
the integer; this is the fraction within it. Needed by §7.4's band table.

### New events

Three events `ai` emits that `ARCHITECTURE.md`'s table does not list. Per that
document's own rule they are added in the same commit as the code that emits
them.

| event | payload | emitted by |
|---|---|---|
| `ai:pack-alert` | `{ packId, x, z, memberCount }` | ai |
| `ai:priority-target` | `{ actor, reason: 'support' }` | ai |
| `ai:corpse-raised` | `{ actor, shaman, point }` | ai |

`boss:phase { phase, actor }` is already listed in `02-api-contracts.md` §12 and
needs no addition.

### Not requested, and why

- **No threat API.** §4.7: there is one target and a threat table would be dead
  code.
- **No `nav.setBudget` change.** The default of 4 is exactly the budget §9.1
  settles on; §9.5's cost model is built around it.
- **No `physics.overlapCircleSorted`.** §8.3 sorts four elements itself, which
  is cheaper than a general sort in `physics` and keeps the tie-break rule
  visible where it matters.
- **No `PackDescriptor` schema change.** §5.1's template-id reading makes one
  unnecessary, which is the whole point of choosing it.

---

## 17. Additions folded into `10-audio.md`

> **Status: applied.** All twenty ids are in `10-audio.md` §5.1. Sections G, H
> and I now read 51 / 14 / 15 and the catalogue total is **263** — the header
> arithmetic below said 47 / 16 / 15 and 261, which double-counted the champion
> rows and counted the twelve `monster.footstep.<surface>` entries as one. The
> id list itself was right; the section totals now match it. Kept as rationale.

Twenty ids. Section G (Monsters, 35), H (Champions, uniques and affixes, 11) and
I (Molgrim, 14) already carry the bulk of this document's cues; these are the
gaps this specification found. Counts in the section headers move from
35 / 11 / 14 to **47 / 16 / 15**, and the catalogue total from 241 to **261**.

### Section G — monster footsteps (12 ids)

`10-audio.md` §2.3 budgets a distance model for "monster footstep",
§4.2 gives it a per-category cap of 6 voices / 4 per emitter / 0.20 s
retrigger, and §7.1 mixes it at −26 dB — but §5.1 catalogues no id for it, so
the mix table refers to a sound that does not exist.

| id | Trigger | Notes |
|---|---|---|
| `monster.footstep.<surface>` × 12 | `actor:footstep` (`08-characters-visual.md` §5.9) where `actor.kind === 'monster'` | One per `SURFACE` value, mirroring `player.footstep.<surface>`. Recipe: `player.footstep.<surface>` at 0.55 gain, −2 st, with the boot-leather layer removed. Per-archetype pitch offset: Swarm +7 st, Archer +2 st, Ranker 0, Shaman −1 st, Crawler −3 st (and a wet layer), Maulsmith **−8 st with a 31 Hz sub** |

The Maulsmith's footstep is the only monster step with sub content, which is
consistent with §5.1 G's timbral identity for it ("the only monster with real
sub") and is what makes one audible approaching off screen.

### Section G — Bone Ranker guard (2 ids)

| id | ms | Notes |
|---|---:|---|
| `ratling.guard.enter` | 320 | `ratling.block` with the impact transient removed and a 0.18 s leather-and-strap creak; plays on the 0.14 s guard entry, not on a blocked hit |
| `ratling.guard.exit` | 220 | the same creak reversed, 0.6× gain, on the 0.20 s exit |

`ratling.block` already covers the *blocked hit*. The stance itself is a
separate, quieter event and without it a guard is inaudible — which matters,
because the guard is the player's cue that this Ranker is briefly harder to hurt
(§2.1).

### Section G — Crawler chain (1 id)

| id | ms | Notes |
|---|---:|---|
| `crawler.chain.fuse` | 640 | `crawler.inflate` at 0.6× gain, 0.7× duration, +3 st, with the 4 Hz pulse present from the start. Plays on a **sympathetic** fuse (§2.6), never on the primary |

A four-Crawler cluster chains over 0.75 s; without a distinct, quieter cue the
chain is four copies of the same 900 ms sound and reads as a bug.

### Section G — leash (1 id)

| id | ms | Notes |
|---|---:|---|
| `monster.leash` | 900 | that monster's `idle` sound at 0.7× gain with a descending 4-sine glide over 700 ms; played **once per pack** by the first member to leash (§4.4) |

De-aggro is otherwise silent, and a pack that walks away without a sound reads
as the AI breaking rather than the player escaping.

### Section H — champion spawn and two silent affixes (3 ids)

| id | ms | Notes |
|---|---:|---|
| `champion.spawn` | 900 | `unique.spawn` at 0.5× level, 0.55× duration, one octave up, without the bell partial; ducks ambience −4 dB. §5.1 H has `unique.spawn` but no champion equivalent, so a champion pack arrives silently |
| `affix.swift.loop` | loop | a 6.4 Hz amplitude-gated pink band at 2 800 Hz Q 3.5, g 0.03, tracked on the emitter — the affix is currently audible only through a doubled footstep rate |
| `affix.mighty.impact` | 300 | layered **on top of** the surface hit: a 62→38 Hz sub AD(4, 260) g 0.22 plus one 180 Hz body partial. `mighty` is a 55 % damage increase with no audio at all today |

`swift` and `mighty` are the two most common affixes by weight (14 each, §6.1)
and the only two with no sound. A champion that is simply faster and stronger is
currently indistinguishable by ear from a normal monster with a blue rim light.

### Section I — boss enrage (1 id)

| id | ms | Notes |
|---|---:|---|
| `boss.enrage` | 1 400 | `boss.p1.roar` at +3 st with a 7 Hz tremolo and a 44 Hz sub, one instance per enrage stack (§7.9). `monster.enrage` exists but is defined as "*that monster's* `aggro` sound pitched +4 st", which for Molgrim would be `boss.spawn` — a 3 400 ms cue that ducks everything, fired every 15 s |

### One rename, not an addition

§5.1 I lists `boss.p1.swing`, but phase I's signature pattern is
`instructor_sweep`, not a swing, and Molgrim has no basic attack at all (§7.2).
The id is used unchanged by this document; a rename to `boss.p1.sweep` in a
future pass of `10-audio.md` would make the catalogue match the encounter, and
is noted here rather than requested, because an id rename costs more than the
clarity is worth today.










