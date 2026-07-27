# 05 — Skills

**Claudo II: Lord of Instruction** — the complete per-level specification of all
thirty skills.

`03-combat-math.md` §8 fixes every base value and every per-level increment in
this document. Nothing here overrides it. What this document adds is the twenty
rows behind each of those formulas, the packet each skill produces, the exact
interaction with click-to-move, the animation and audio hooks, and the build,
balance and validation arithmetic that proves the set works as a whole.

Six trees, five skills each, twenty allocatable levels each, **29 skill points**
at the level cap plus a permanent `skillBonuses.all += 1` from the quest reward.
Maxing one skill costs 20 of those 29. That is the choice the whole system is
built around.

---

## Table of contents

1. [Conventions](#1-conventions)
2. [Ravager — Carnage](#2-ravager--carnage-carnage)
3. [Ravager — Unyielding](#3-ravager--unyielding-unyielding)
4. [Emberwright — Flame](#4-emberwright--flame-flame)
5. [Emberwright — Ash](#5-emberwright--ash-ash)
6. [Runeblade — Enchanted Blade](#6-runeblade--enchanted-blade-enchanted_blade)
7. [Runeblade — Conduit](#7-runeblade--conduit-conduit)
8. [Tree layouts](#8-tree-layouts)
9. [Build analysis](#9-build-analysis)
10. [Balance table](#10-balance-table)
11. [Resource economy](#11-resource-economy)
12. [Anti-patterns](#12-anti-patterns)
13. [Validation](#13-validation)
14. [Implementation order](#14-implementation-order)
15. [Additions requested to 10-audio.md](#additions-requested-to-10-audiomd)
16. [Additions requested to 02-api-contracts.md](#additions-requested-to-02-api-contractsmd)
17. [Disagreements with 03-combat-math.md](#disagreements-with-03-combat-mathmd)

---

## 1. Conventions

### 1.1 Sources and precedence

| Document | Role here |
|---|---|
| `03-combat-math.md` §8 | **Binding.** Every base and per-level figure. Never contradicted; disagreements are recorded, not applied |
| `03-combat-math.md` §§2, 4, 6, 7, 10, 11 | **Binding.** Resource math, timing, the damage pipeline, statuses, scaling, calibration |
| `01-data-model.md` §§3, 6, 7 | **Binding.** `SkillDefinition`, `SkillInstance`, `StatBlock` vocabulary, `StatusEffectInstance` |
| `08-characters-visual.md` §§5–6 | **Binding.** Animation states and the wind-up / active / recovery contract |
| `10-audio.md` §5.1 | **Binding.** Every `audio` identifier used below exists in that catalogue, except the two listed in §15 |
| `02-api-contracts.md` §10 | **Binding.** The `skills` API. Methods this document needs and does not find there are listed in §16 |

### 1.2 Names

The plan and the design brief use working names for four of the six trees and
for several skills. The shipped identifiers are the ones in `01-data-model.md`
§6.3, and they are what this document uses throughout.

| Working name | Shipped identifier | Working name | Shipped identifier |
|---|---|---|---|
| Bulwark (tree) | `unyielding` | Pyre (tree) | `flame` |
| Cinders (tree) | `ash` | Runic Edge (tree) | `enchanted_blade` |
| Cleave | `cleaving_strike` | Rend | `bloodletting` |
| Charge | `ram_charge` | Bracing | `shield_stance` |
| Ironhide | `iron_skin` | Ashstep | `ashen_step` |
| Mana Conduit | `mana_weave` | Ember Ward | `smouldering_ward` |
| Combust | `essence_burn` | Sigil | `blade_seal` |
| Phase Lunge | `phase_leap` | Arc | `discharge` |
| Thunderstep | `thunder_step` | Convergence | `unity` |

Every skill carries an English and a Russian display name. `src/ui/i18n.js` maps
the display strings only; the identifier is never translated
(`01-data-model.md`, conventions).

### 1.3 Reading a level table

`L` is the **effective** skill level, `slvl` — `allocated + skillBonuses.all +
skillBonuses.tree[tree] + skillBonuses.skill[id]`, clamped to `[0, 40]`, and
forced to 0 whenever `allocated === 0` (`01-data-model.md` §6.2). Every table
runs `L = 1..20` because 20 is the allocation cap; `+skills` pushes the same
formulas past row 20 without changing them.

Every "per level" figure evaluates as `base + perLevel × (L − 1)`. Where
`03-combat-math.md` §8 writes a cost as `6 rage +0.25/L`, that is
`6 + 0.25 × (L − 1)`, so **row 1 is always the bare base**.

- Mana costs are reduced by `manaCostReduction` and floored at **1**.
- Rage and Resonance costs are **not** reduced by `manaCostReduction`.
- Synergies read the source skill's **allocated** level, never its effective
  level (`03-combat-math.md` §8.7). A `+3 to all skills` amulet never compounds
  through a synergy.
- Cooldowns are stored in `actor.cooldowns` as integer simulation step indices.

### 1.4 Targeting and click-to-move

The control scheme is Diablo II's: **left mouse moves and attacks**, right mouse
casts the skill bound to `hotbar.rightMouse`, and keys 1–4 fire hotbar slots at
the cursor. Every skill below declares a `target` mode from `01-data-model.md`
§6.1, and the mode fully determines how the click behaves.

| `target` | Cursor supplies | Walks into range? | Held button | Refusal reason |
|---|---|---|---|---|
| `none` | nothing | no | one press = one use | — |
| `self` | nothing | no | one use per press | `cooldown`, `resource`, `active` |
| `point` | a ground position | **only if** the skill declares a maximum range and the point is beyond it | repeats while the resource lasts | `no-path`, `resource` |
| `actor` | a hostile actor | **yes** — the actor walks to weapon range and swings on arrival | repeats on the same target | `no-target`, `resource` |
| `direction` | a facing vector | no | repeats in place | `resource` |

Four rules apply to every skill:

1. **A refused cast never moves the character.** `skills.canCast()` is evaluated
   before any movement intent is issued, and a failure plays
   `player.cast.fail` and emits nothing else.
2. **Movement input is accepted from 0.60 of the action interval**
   (`03-combat-math.md` §4.5). A move click inside that window cancels a held
   repeat; a click before it is buffered and consumed at 0.60.
3. **Facing is locked** for the last 60 % of the wind-up, the whole `active`
   window and the first 60 % of recovery (`08-characters-visual.md` §6.5). An
   attack that can be steered mid-swing has no weight.
4. **Channels** (`whirlwind` only) move the actor toward the cursor at the
   skill's reduced speed for as long as the button is held.

### 1.5 The reference multipliers

Every column headed **Ref.** converts a coefficient into a damage number using
the **clvl-10 reference builds of `03-combat-math.md` §11.1**, before the
target's mitigation. They exist so twenty rows can be compared across classes
without re-deriving a build each time.

| Class | Reference build | Multiplier | Derivation |
|---|---|---|---|
| Ravager | Battle Axe 10–22, `enhancedDamage 40`, STR 48 | **34.8096** per 100 % weapon damage | `16 × 1.40 × 1.48 × 1.00 × 1.05` (§11.2, E3) |
| Emberwright | Ember Wand, `+25 %` fire damage | **× 1.3125** on the average roll | `1.25 × 1.05 × 1.00` (§11.2) |
| Runeblade, weapon | Rune Sword 8–17, `enhancedDamage 35`, STR 40 | **23.5659** per 100 % weapon damage | `12.5 × 1.35 × 1.40 × 0.95 × 1.05` (E13) |
| Runeblade, elemental | as above | **× 0.9975** on the average roll | `0.95 × 1.05` (E13) |

`1.05` is the expected-crit multiplier `0.95 + 0.05 × 2.00` at base
`critChance 5` and `critMult 200`. It is a DPS convenience; a single resolved
hit uses one crit draw and is never exactly this figure (`03-combat-math.md`
E3).

The **pack-occupancy model** used in every multi-target figure: a pack of 5–12
monsters at the plan's spacing occupies a blob roughly 5 m across, and a monster
collision circle is 0.22–0.60 m. From that, the number of bodies a shape catches:

| Shape | Bodies |
|---|---|
| 120° cone, 3.2 m (`cleaving_strike`) | 4 |
| 360°, 2.6 m (`whirlwind`) | 3 |
| 360°, 4.0–4.5 m (`sunder`, `cascade`) | 5 |
| 90° cone, 7.0 m (`flame_wave`) | 5 |
| 3.4 m blast (`fireball`), 3.5 m nova (`thunder_step`, `smouldering_ward`) | 4 |
| 4.2 m (`meteor`) | 5 |
| 5.95 m (`essence_burn`) | 6 |
| 7.0 m (`war_cry`) | 8 |
| pierce line (`ember_bolt` from level 10) | 3 |
| 6-link chain (`discharge` at level 18+) | 3.2881 damage-equivalents |

### 1.6 Readings of `03-combat-math.md` adopted here

Four places in §8 admit more than one implementation. Each is resolved below in
the way that reproduces §2.4, §11 and E9 exactly. None of them changes a printed
number.

| # | Question | Reading adopted | Why |
|---|---|---|---|
| **R1** | Does a cone or nova that hits four monsters award `+6` rage four times? | **No — one award per action**, credited on the first landed hit. | §2.4 computes the level-10 income as `0.778146 × 6 / 0.675 = 6.9161 /s`, which is one award per swing. Per-target awards make `whirlwind` self-funding at 3 targets (`6 × 3 / 0.55 = 32.7 rage/s` against a 12/s drain). See §12. |
| **R2** | Does a channel tick award rage? | **No.** A channel earns at the actor's `attackInterval` cadence, not at its tick cadence. | This is the only reading under which §2.4's `6.9161 − 12 = −5.0839 /s` and its 19.67 s channel duration are both true. |
| **R3** | Does `cascade` get the strength bonus at B5, given that its output is `magic`? | **Yes.** B1–B5 run on the weapon's physical line; the result is re-typed to `magic` at B7. | B5 is a rule about *what is being multiplied* (weapon physical), not about the packet's final element. The alternative reading costs `cascade` a factor of `1/(1 + STR/100)` — 41 % at the level-30 reference — and would make the skill unpickable. |
| **R4** | Does §10.2's "Monster resists +20 / +40" include `physicalResist`? | **No — the five elemental resists only.** | §9.3 lists physical and elemental resistance as separate rank columns, and §10.2's own reasoning for sparing player `physicalResist` ("would make Renunciation melee unplayable") applies symmetrically. Applying it to monsters would cut every physical build by 40 % in Renunciation with no counter-stat. |

One more reading, printed rather than inferred: `resonance_circuit`'s
`resonanceOnHit += 0.1/L` has **no base term**, so it contributes `0` at level 1
and `1.9` at level 20 (`0 + 0.1 × (L − 1)`). The first point buys the fourth
Resonance pip and the mana return; the fill rate starts at the second.

### 1.7 Index

| # | id | Class | Tree | Lvl | Type | Resource | Prereq | Target |
|---|---|---|---|---|---|---|---|---|
| 1 | `cleaving_strike` | Ravager | `carnage` | 1 | `cone` | rage | — | `point` |
| 2 | `bloodletting` | Ravager | `carnage` | 6 | `attack` | rage | — | `actor` |
| 3 | `whirlwind` | Ravager | `carnage` | 6 | `channel` | rage/s | — | `point` |
| 4 | `bloodthirst` | Ravager | `carnage` | 12 | `passive` | — | — | `none` |
| 5 | `sunder` | Ravager | `carnage` | 18 | `nova` | rage | `bloodletting` ≥ 3 | `point` |
| 6 | `ram_charge` | Ravager | `unyielding` | 1 | `mobility` | rage | — | `point` |
| 7 | `shield_stance` | Ravager | `unyielding` | 6 | `passive` | — | — | `none` |
| 8 | `war_cry` | Ravager | `unyielding` | 12 | `nova` | rage | — | `self` |
| 9 | `iron_skin` | Ravager | `unyielding` | 12 | `passive` | — | — | `none` |
| 10 | `last_stand` | Ravager | `unyielding` | 18 | `passive` | — | — | `self` |
| 11 | `ember_bolt` | Emberwright | `flame` | 1 | `projectile` | mana | — | `point` |
| 12 | `flame_wave` | Emberwright | `flame` | 6 | `cone` | mana | — | `direction` |
| 13 | `fireball` | Emberwright | `flame` | 12 | `projectile` | mana | — | `point` |
| 14 | `meteor` | Emberwright | `flame` | 18 | `ground` | mana | `fireball` ≥ 3 | `point` |
| 15 | `incinerate` | Emberwright | `flame` | 18 | `passive` | — | — | `none` |
| 16 | `ashen_step` | Emberwright | `ash` | 1 | `mobility` | mana | — | `point` |
| 17 | `mana_weave` | Emberwright | `ash` | 6 | `passive` | — | — | `none` |
| 18 | `smouldering_ward` | Emberwright | `ash` | 12 | `buff` | mana | — | `self` |
| 19 | `ash_wall` | Emberwright | `ash` | 12 | `ground` | mana | — | `point` |
| 20 | `essence_burn` | Emberwright | `ash` | 18 | `nova` | all mana | — | `self` |
| 21 | `rune_strike` | Runeblade | `enchanted_blade` | 1 | `attack` | mana | — | `actor` |
| 22 | `blade_seal` | Runeblade | `enchanted_blade` | 1 | `buff` | mana + 1 Res | — | `self` |
| 23 | `cascade` | Runeblade | `enchanted_blade` | 6 | `passive` | — | — | `none` |
| 24 | `phase_leap` | Runeblade | `enchanted_blade` | 12 | `mobility` | mana | — | `actor` |
| 25 | `echo_blade` | Runeblade | `enchanted_blade` | 18 | `summon` | mana | — | `self` |
| 26 | `discharge` | Runeblade | `conduit` | 1 | `projectile` | mana | — | `actor` |
| 27 | `resonance_circuit` | Runeblade | `conduit` | 6 | `passive` | — | — | `none` |
| 28 | `polarity` | Runeblade | `conduit` | 12 | `toggle` | mana | — | `self` |
| 29 | `thunder_step` | Runeblade | `conduit` | 12 | `mobility` | mana | — | `point` |
| 30 | `unity` | Runeblade | `conduit` | 18 | `buff` | mana | — | `self` |

Nine of the thirty are passive or passive-trigger, one is a toggle and one is a
channel. **There are no auras.** No skill in the shipped set uses
`SkillDefinition.type === 'aura'`; the enumeration keeps the value for monster
affixes (`frostbound`) and for post-M9 unique items.

---

## 2. Ravager — Carnage (`carnage`)

Five skills that convert Rage into damage on more than one target at a time.
The tree has one gate (`sunder` needs `bloodletting ≥ 3`) and two synergies
running left to right across it.

---

### 2.1 `cleaving_strike` — Cleaving Strike / Рассекающий удар

| Field | Value |
|---|---|
| `id` | `cleaving_strike` |
| Name EN / RU | Cleaving Strike / Рассекающий удар |
| Class / tree | Ravager / `carnage` |
| Tree position | row 1, column 2 (root) |
| Character level | 1 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `cone` |
| Plain class | Active — weapon attack |
| `target` | `point` |
| `element` | `physical` |
| Range | weapon range; the cone is cast from the actor, not from the cursor |
| Radius / shape | 3.2 m, 120° arc centred on `facing` |
| Cost | **6 rage**, `+0.25` per level (L20 = 10.75). Never reduced by `manaCostReduction` — that stat is mana-only |
| Cooldown | none |
| Timing | `attackScale 1.05` — `weapon.attackTime × 0.90 × 1.05 / (1 + IAS/100)`. Battle Axe at IAS 0: **0.7088 s**. Scales with `increasedAttackSpeed` |
| Click-to-move | Bound to a hotbar slot and fired with RMB (or LMB when `hotbar.leftMouse` points at it). The cursor supplies the facing only; the actor never walks to the cursor, it turns and swings in place. Holding the button repeats the swing while rage ≥ cost. A move click during the last 40 % of `recover` cancels the repeat (03 §4.5). |

**Twenty levels**

| L | Rage | Weapon dmg % | Ref. hit | Ref. 4-target burst | Dmg / rage (4 tgt) | → `whirlwind` +wd % |
|---|---|---|---|---|---|---|
| 1 | 6 | 40 | 13.92 | 55.7 | 9.28 | 8 |
| 2 | 6.25 | 46.32 | 16.12 | 64.5 | 10.32 | 16 |
| 3 | 6.5 | 52.64 | 18.32 | 73.3 | 11.28 | 24 |
| 4 | 6.75 | 58.96 | 20.52 | 82.09 | 12.16 | 32 |
| 5 | 7 | 65.28 | 22.72 | 90.89 | 12.98 | 40 |
| 6 | 7.25 | 71.6 | 24.92 | 99.69 | 13.75 | 48 |
| 7 | 7.5 | 77.92 | 27.12 | 108.49 | 14.47 | 56 |
| 8 | 7.75 | 84.24 | 29.32 | 117.29 | 15.13 | 64 |
| 9 | 8 | 90.56 | 31.52 | 126.09 | 15.76 | 72 |
| 10 | 8.25 | 96.88 | 33.72 | 134.89 | 16.35 | 80 |
| 11 | 8.5 | 103.2 | 35.92 | 143.69 | 16.91 | 88 |
| 12 | 8.75 | 109.52 | 38.12 | 152.49 | 17.43 | 96 |
| 13 | 9 | 115.84 | 40.32 | 161.29 | 17.92 | 104 |
| 14 | 9.25 | 122.16 | 42.52 | 170.09 | 18.39 | 112 |
| 15 | 9.5 | 128.48 | 44.72 | 178.89 | 18.83 | 120 |
| 16 | 9.75 | 134.8 | 46.92 | 187.69 | 19.25 | 128 |
| 17 | 10 | 141.12 | 49.12 | 196.49 | 19.65 | 136 |
| 18 | 10.25 | 147.44 | 51.32 | 205.29 | 20.03 | 144 |
| 19 | 10.5 | 153.76 | 53.52 | 214.09 | 20.39 | 152 |
| 20 | 10.75 | 160.08 | 55.72 | 222.89 | 20.73 | 160 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildAttackPacket(actor, 'cleaving_strike', slvl)` |
| B1 physical | weapon `minDamage` / `maxDamage` |
| B2 coefficient | `weaponDamage = 40 + 6.32 × (slvl − 1)`, plus synergies (none received) |
| B3–B4 | `enhancedDamage`, then flat `minDamage` / `maxDamage` |
| B5 | attribute bonus applies — this is a weapon attack |
| B6 | `× meleeScale 1.00`, then `× (1 + physicalDamagePercent/100)` |
| B7 elemental | whatever the weapon and affixes carry; the skill adds none |
| B8 riders | `attackRating` full, `blockable true`, `dodgeable true`, `knockback` 0, `hitStop` standard |
| Targets | one packet is built and `combat.resolve()` is called once per actor inside the cone, in ascending `actor.id` order |
| `+skills` | through `effectiveLevel` (01 §6.2) — 20 allocated + 1 quest + gear reaches slvl 40 at the clamp |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| grants → | `whirlwind` | `weaponDamage` | +8 % | +160 % |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| `attack.windup` (0.40 of the interval) | `fx.trail('cleave_arc', actorRef)` on `WeaponR` | — (the swing layer of `skill.cleave` starts at `active`) |
| `attack.active` (0.15, never scaled) | `fx.telegraph` not used — the player skill has no telegraph; `fx.burst('cleave_sweep')` at the cone centroid | `skill.cleave` |
| per resolved hit | `fx.impact(point, normal, target.surface, power)` | `melee.hit.<surface>`, `melee.crit` layered on a crit, `melee.block` on a block |
| `attack.recover` | `fx.endTrail(handle)` | — |

**AI and monster interaction**

- No telegraph. Monster AI does not read player wind-ups, so the cone is never dodged; its counter-play is spacing, which the 3.2 m radius already limits.
- Every actor struck adds threat through `combat.addThreat()` in the same pass, so a cone that clips a Dust Shaman at the back of a pack pulls it — this is the intended way to reach support monsters.
- Hitting a `bone_ranker` inside its 0.8 s guard window (`shield_guard`, 03 §9.1) resolves against `+40 blockChance`; the cone does not bypass block.

The **highest damage-per-rage skill in the game against four targets** and deliberately so: it is the Ravager's level-1 answer to a pack of 5–12, and every other Carnage skill is measured against it.

---

### 2.2 `bloodletting` — Bloodletting / Кровопускание

| Field | Value |
|---|---|
| `id` | `bloodletting` |
| Name EN / RU | Bloodletting / Кровопускание |
| Class / tree | Ravager / `carnage` |
| Tree position | row 2, column 1 |
| Character level | 6 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `attack` |
| Plain class | Active — weapon attack, single target |
| `target` | `actor` |
| `element` | `physical` |
| Range | weapon range |
| Radius / shape | single target |
| Cost | **8 rage**, `+0.30` per level (L20 = 13.7) |
| Cooldown | none |
| Timing | `attackScale 1.00` — identical to a basic attack. Battle Axe at IAS 0: **0.675 s** |
| Click-to-move | Needs a hostile actor under the cursor; `canCast` returns `{ ok:false, reason:'no-target' }` on empty ground. If the target is out of weapon range the actor walks to it first, exactly as a basic attack does, and swings on arrival. |

**Twenty levels**

| L | Rage | Weapon dmg % | Ref. hit | Bleed coeff. /s | Bleed total ×phys | Ref. bleed /s (1 stack) | Ref. 5-stack total | → `sunder` +wd % |
|---|---|---|---|---|---|---|---|---|
| 1 | 8 | 90 | 31.33 | 0.08 | 0.4 | 2.51 | 62.66 | 6 |
| 2 | 8.3 | 95 | 33.07 | 0.09 | 0.45 | 2.98 | 74.41 | 12 |
| 3 | 8.6 | 100 | 34.81 | 0.1 | 0.5 | 3.48 | 87.02 | 18 |
| 4 | 8.9 | 105 | 36.55 | 0.11 | 0.55 | 4.02 | 100.51 | 24 |
| 5 | 9.2 | 110 | 38.29 | 0.12 | 0.6 | 4.59 | 114.87 | 30 |
| 6 | 9.5 | 115 | 40.03 | 0.13 | 0.65 | 5.2 | 130.1 | 36 |
| 7 | 9.8 | 120 | 41.77 | 0.14 | 0.7 | 5.85 | 146.2 | 42 |
| 8 | 10.1 | 125 | 43.51 | 0.15 | 0.75 | 6.53 | 163.17 | 48 |
| 9 | 10.4 | 130 | 45.25 | 0.16 | 0.8 | 7.24 | 181.01 | 54 |
| 10 | 10.7 | 135 | 46.99 | 0.17 | 0.85 | 7.99 | 199.72 | 60 |
| 11 | 11 | 140 | 48.73 | 0.18 | 0.9 | 8.77 | 219.3 | 66 |
| 12 | 11.3 | 145 | 50.47 | 0.19 | 0.95 | 9.59 | 239.75 | 72 |
| 13 | 11.6 | 150 | 52.21 | 0.2 | 1 | 10.44 | 261.07 | 78 |
| 14 | 11.9 | 155 | 53.95 | 0.21 | 1.05 | 11.33 | 283.26 | 84 |
| 15 | 12.2 | 160 | 55.7 | 0.22 | 1.1 | 12.25 | 306.32 | 90 |
| 16 | 12.5 | 165 | 57.44 | 0.23 | 1.15 | 13.21 | 330.26 | 96 |
| 17 | 12.8 | 170 | 59.18 | 0.24 | 1.2 | 14.2 | 355.06 | 102 |
| 18 | 13.1 | 175 | 60.92 | 0.25 | 1.25 | 15.23 | 380.73 | 108 |
| 19 | 13.4 | 180 | 62.66 | 0.26 | 1.3 | 16.29 | 407.27 | 114 |
| 20 | 13.7 | 185 | 64.4 | 0.27 | 1.35 | 17.39 | 434.68 | 120 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildAttackPacket(actor, 'bloodletting', slvl)` |
| B2 coefficient | `weaponDamage = 90 + 5 × (slvl − 1)` |
| B5 / B6 | attribute bonus, then `× meleeScale 1.00` |
| B8 riders | `onHitStatus: [{ status:'bleeding', chance:100, duration:5.0, magnitude:0 }]` — `magnitude` is filled in by `combat` at R14(c) from the **post-mitigation physical** figure, per 03 §7.9 |
| Bleed application | `magnitude = physDealt × (0.08 + 0.010 × (slvl − 1))` damage per second, 5.0 s, ticking at 2 Hz |
| Stacking | up to **5 independent instances** (01 §7.2). A sixth application replaces the instance with the lowest `totalRemaining` |
| DoT rules | a bleed tick is not a hit (03 §6.3): no crit, no leech, no proc, no hit recovery, mitigated by `physicalResist` only |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| grants → | `sunder` | `weaponDamage` | +6 % | +120 % |

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `bleeding` | `physDealt × (0.08 + 0.010 × (slvl − 1))` per second | 5.0 s, fixed — `ccReduction` does not shorten it | 5 stacks, 2 Hz, `physicalResist` only |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| `attack.windup` | `fx.trail('rend_arc', actorRef)` | — |
| `attack.active` | `fx.burst('rend_spray', point, 1.0)` | `skill.rend` |
| on `actor:status` bleeding | `fx.groundEffect('blood_pool', x, z, 0.4, 5.0)` | `status.bleeding` |
| per DoT tick | `fx.burst('blood_drip', point, 0.35)` at LOD 0 only | `dot.bleed.tick` — capped at 4 concurrent by 10 §4.4 |

**AI and monster interaction**

- Bleed damage credits the original `sourceId` for XP and for threat, so a monster that walks away from the Ravager and dies to the DoT still awards XP and still counts for `incinerate`-style on-kill triggers on other actors.
- Applying five stacks takes five landed hits ≈ 3.4 s at the level-10 reference cadence; the DoT is therefore a champion/boss tool, not a trash-clear tool.

Against a normal monster the bleed is mostly wasted — the target dies inside 2–4 hits and the remaining 5 s of DoT is thrown away. That is the intended cost of the skill's very high sustained figure on a long fight.

---

### 2.3 `whirlwind` — Whirlwind / Вихрь

| Field | Value |
|---|---|
| `id` | `whirlwind` |
| Name EN / RU | Whirlwind / Вихрь |
| Class / tree | Ravager / `carnage` |
| Tree position | row 2, column 3 |
| Character level | 6 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `channel` |
| Plain class | Channelled — held, drains per second |
| `target` | `point` |
| `element` | `physical` |
| Range | self-centred; the channel follows the actor |
| Radius / shape | 2.6 m, full 360° |
| Cost | **12 rage per second**, `−0.25` per level, floor **6/s** (L20 = 7.25/s; the floor is reached at effective level 25). Deducted every fixed step through `manaAccum`-style fractional carry, never in whole points |
| Cooldown | none |
| Timing | not an attack and not a cast — a `channel` state (01 §1.4). Damage ticks every **0.55 s**, unaffected by `increasedAttackSpeed`. Entry costs one `attack.windup` at `attackScale 1.00`, exit is 0.15 s of `recover` |
| Click-to-move | Hold the bound button. The actor moves toward the cursor at **70 %** of `moveSpeed` for as long as it is held, re-pathing every step through `nav`. Releasing ends the channel; so does running out of rage, death, `stunned` and `frozen`. `hitstun` does **not** interrupt it — 03 §8.1 is explicit, and this is the skill's defining property. |

**Twenty levels**

| L | Rage /s | Weapon % / tick | Ref. tick | Ref. DPS 1 tgt | Ref. DPS 3 tgt | Dmg / rage (3 tgt) | Net rage /s at 6.92 income | Channel s from 100 rage |
|---|---|---|---|---|---|---|---|---|
| 1 | 12 | 55 | 19.15 | 34.82 | 104.45 | 8.70 | -5.08 | 19.67 |
| 2 | 11.75 | 59 | 20.54 | 37.35 | 112.04 | 9.54 | -4.83 | 20.69 |
| 3 | 11.5 | 63 | 21.93 | 39.87 | 119.62 | 10.40 | -4.58 | 21.82 |
| 4 | 11.25 | 67 | 23.32 | 42.40 | 127.20 | 11.31 | -4.33 | 23.07 |
| 5 | 11 | 71 | 24.71 | 44.93 | 134.78 | 12.25 | -4.08 | 24.49 |
| 6 | 10.75 | 75 | 26.11 | 47.47 | 142.42 | 13.25 | -3.83 | 26.08 |
| 7 | 10.5 | 79 | 27.5 | 50.00 | 150.00 | 14.29 | -3.58 | 27.9 |
| 8 | 10.25 | 83 | 28.89 | 52.53 | 157.58 | 15.37 | -3.33 | 29.99 |
| 9 | 10 | 87 | 30.28 | 55.05 | 165.16 | 16.52 | -3.08 | 32.43 |
| 10 | 9.75 | 91 | 31.68 | 57.60 | 172.80 | 17.72 | -2.83 | 35.29 |
| 11 | 9.5 | 95 | 33.07 | 60.13 | 180.38 | 18.99 | -2.58 | 38.7 |
| 12 | 9.25 | 99 | 34.46 | 62.65 | 187.96 | 20.32 | -2.33 | 42.85 |
| 13 | 9 | 103 | 35.85 | 65.18 | 195.55 | 21.73 | -2.08 | 47.99 |
| 14 | 8.75 | 107 | 37.25 | 67.73 | 203.18 | 23.22 | -1.83 | 54.53 |
| 15 | 8.5 | 111 | 38.64 | 70.25 | 210.76 | 24.80 | -1.58 | 63.14 |
| 16 | 8.25 | 115 | 40.03 | 72.78 | 218.35 | 26.47 | -1.33 | 74.97 |
| 17 | 8 | 119 | 41.42 | 75.31 | 225.93 | 28.24 | -1.08 | 92.26 |
| 18 | 7.75 | 123 | 42.82 | 77.85 | 233.56 | 30.14 | -0.83 | 119.92 |
| 19 | 7.5 | 127 | 44.21 | 80.38 | 241.15 | 32.15 | -0.58 | 171.26 |
| 20 | 7.25 | 131 | 45.6 | 82.91 | 248.73 | 34.31 | -0.33 | 299.49 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildAttackPacket(actor, 'whirlwind', slvl)` — **once per tick**, not once per channel |
| B2 coefficient | `weaponDamage = 55 + 4 × (slvl − 1) + 8 × allocated(cleaving_strike)` |
| B5 / B6 | attribute bonus, then `× meleeScale 1.00` |
| B8 riders | `blockable true`, `dodgeable true`. `hitStop` suppressed — a 1.82 Hz tick that freezes the target animation reads as stutter |
| Targets | every hostile actor whose collision circle intersects 2.6 m, resolved in ascending `actor.id`. No per-target cooldown: a monster inside the radius takes every tick |
| Life steal | `bloodthirst` applies to every tick, which is why the pair is the tree's sustain engine |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| receives ← | `cleaving_strike` | `weaponDamage` | +8 % | +160 % (at 20 allocated points in `cleaving_strike`) |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| channel entry | `fx.trail('whirlwind_ribbon', actorRef)` — two counter-rotating ribbons on `WeaponR` | `skill.whirlwind.loop` starts, tracked emitter on the actor |
| each 0.55 s tick | `fx.burst('whirlwind_tick', x, y, z, 0.6)` | per-target `melee.hit.<surface>` at 0.6 gain, hard-capped at 3 voices per tick by 10 §4.2 |
| channel exit | `fx.endTrail(handle)` | `skill.whirlwind.loop` released with a 120 ms fade |

**AI and monster interaction**

- Immunity to hit recovery is the counter to packs of `carrion_swarm`, whose whole design is chip damage at 0.75 s cadence.
- It is **not** immunity to `stunned` or `frozen`. A `maulsmith` landing `crushing_slam` ends the channel, and that telegraph is the intended counter-play.
- Movement at 70 % speed is slower than `carrion_swarm` (5.4 m/s) and `blight_crawler` (4.6 m/s) — a Ravager cannot outrun a swarm while channelling and must commit.

At the level-10 reference cadence rage income is `0.778146 × 6 / 0.675 = 6.9161 /s` (03 §2.4, E9), so at slvl 1 the channel runs a net **−5.08 /s** and empties a full bar in **19.67 s**. From effective level 21 upward the drain falls below income only if the Ravager keeps landing hits, which is exactly the same condition that funds it.

---

### 2.4 `bloodthirst` — Bloodthirst / Жажда крови

| Field | Value |
|---|---|
| `id` | `bloodthirst` |
| Name EN / RU | Bloodthirst / Жажда крови |
| Class / tree | Ravager / `carnage` |
| Tree position | row 3, column 1 |
| Character level | 12 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `passive` |
| Plain class | Passive — always on, no resource |
| `target` | `none` |
| `element` | `physical` |
| Range | — |
| Radius / shape | — |
| Cost | none |
| Cooldown | none |
| Timing | none — contributes to the `skills` layer of `composeStats()` (01 §4.1) and emits `stats:dirty` when a point is spent |
| Click-to-move | Not castable and never appears on the hotbar. `skills.canCast()` returns `{ ok:false, reason:'passive' }`. |

**Twenty levels**

| L | `lifeSteal` % | Life / ref. basic hit | Life /s, basic @ 0.675 s | Life /s, `whirlwind` L20 × 3 tgt |
|---|---|---|---|---|
| 1 | 3 | 1 | 1.15 | 8.57 |
| 2 | 3.9 | 1 | 1.15 | 8.57 |
| 3 | 4.8 | 1 | 1.15 | 17.14 |
| 4 | 5.7 | 1 | 1.15 | 17.14 |
| 5 | 6.6 | 2 | 2.31 | 17.14 |
| 6 | 7.5 | 2 | 2.31 | 25.71 |
| 7 | 8.4 | 2 | 2.31 | 25.71 |
| 8 | 9.3 | 3 | 3.46 | 34.29 |
| 9 | 10.2 | 3 | 3.46 | 34.29 |
| 10 | 11.1 | 3 | 3.46 | 34.29 |
| 11 | 12 | 4 | 4.61 | 42.86 |
| 12 | 12.9 | 4 | 4.61 | 42.86 |
| 13 | 13.8 | 4 | 4.61 | 51.43 |
| 14 | 14.7 | 4 | 4.61 | 51.43 |
| 15 | 15.6 | 5 | 5.76 | 51.43 |
| 16 | 16.5 | 5 | 5.76 | 60 |
| 17 | 17.4 | 5 | 5.76 | 60 |
| 18 | 18.3 | 6 | 6.92 | 68.57 |
| 19 | 19.2 | 6 | 6.92 | 68.57 |
| 20 | 20.1 | 6 | 6.92 | 68.57 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Produces | no packet |
| Contributes | `{ lifeSteal: 3 + 0.9 × (slvl − 1) }` to `sources.skills` |
| Applied at | R14(d) — **after** mitigation, from `phys` only. Elemental damage never leeches |
| Rounding | `⌊phys × lifeSteal/100⌋`. At slvl 1 against a 5-damage hit the floor produces 0, and that is correct: leech is a scaling stat, not a starter stat |
| Cap | `lifeSteal` caps at 100 in the `StatBlock`; 20.1 from this skill leaves ample room for affixes |

**Synergies**

None in either direction.

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| on a leeching hit | `fx.burst('lifesteal_wisp', target → actor, 0.4)` at LOD 0, throttled to 6 Hz | `skill.bloodthirst.tick` — capped at 4 concurrent, and suppressed entirely while `whirlwind` is channelling so the loop stays audible |

**AI and monster interaction**

- Leech is the Ravager's only real sustain against a five-strong pack (29.80 incoming DPS at the level-10 reference, 03 §11.5). At slvl 6 it returns 12.7 life/s against three whirlwind targets, which is the point where a pack becomes a resource rather than a threat.
- It does not work on a `blight_crawler` detonation (poison, not physical) and returns nothing from a blocked or dodged hit.

---

### 2.5 `sunder` — Sunder / Разлом

| Field | Value |
|---|---|
| `id` | `sunder` |
| Name EN / RU | Sunder / Разлом |
| Class / tree | Ravager / `carnage` |
| Tree position | row 4, column 2 (capstone) |
| Character level | 18 |
| Prerequisite | **`bloodletting ≥ 3`** — three allocated points, checked against `allocated`, never `effectiveLevel` |
| `type` (`SkillDefinition`) | `nova` |
| Plain class | Active — weapon attack, ground nova |
| `target` | `point` |
| `element` | `physical` |
| Range | self-centred |
| Radius / shape | 4.0 m, full 360° |
| Cost | **14 rage**, `+0.50` per level (L20 = 23.5) |
| Cooldown | **6.0 s**, flat — does not scale with level |
| Timing | `attackScale 1.25` — Battle Axe at IAS 0: **0.84375 s**. The 0.40 wind-up is 0.3375 s, the longest player wind-up in the game outside `meteor` |
| Click-to-move | Fires at the actor's feet regardless of cursor position; the cursor only sets facing for the animation. On cooldown the click is refused with `reason:'cooldown'` and plays `player.cast.fail` — it never silently walks the actor. |

**Twenty levels**

| L | Rage | Weapon dmg % | Ref. hit | Ref. 5-target burst | `cursed` magnitude | − defence % | − all resists (pts) | Dmg / rage (5 tgt) |
|---|---|---|---|---|---|---|---|---|
| 1 | 14 | 130 | 45.25 | 226.26 | 40 | 40 | 15 | 16.16 |
| 2 | 14.5 | 139 | 48.39 | 241.93 | 41 | 41 | 15.38 | 16.68 |
| 3 | 15 | 148 | 51.52 | 257.59 | 42 | 42 | 15.75 | 17.17 |
| 4 | 15.5 | 157 | 54.65 | 273.26 | 43 | 43 | 16.13 | 17.63 |
| 5 | 16 | 166 | 57.78 | 288.92 | 44 | 44 | 16.5 | 18.06 |
| 6 | 16.5 | 175 | 60.92 | 304.58 | 45 | 45 | 16.88 | 18.46 |
| 7 | 17 | 184 | 64.05 | 320.25 | 46 | 46 | 17.25 | 18.84 |
| 8 | 17.5 | 193 | 67.18 | 335.91 | 47 | 47 | 17.63 | 19.2 |
| 9 | 18 | 202 | 70.32 | 351.58 | 48 | 48 | 18 | 19.53 |
| 10 | 18.5 | 211 | 73.45 | 367.24 | 49 | 49 | 18.38 | 19.85 |
| 11 | 19 | 220 | 76.58 | 382.91 | 50 | 50 | 18.75 | 20.15 |
| 12 | 19.5 | 229 | 79.71 | 398.57 | 51 | 51 | 19.13 | 20.44 |
| 13 | 20 | 238 | 82.85 | 414.23 | 52 | 52 | 19.5 | 20.71 |
| 14 | 20.5 | 247 | 85.98 | 429.9 | 53 | 53 | 19.88 | 20.97 |
| 15 | 21 | 256 | 89.11 | 445.56 | 54 | 54 | 20.25 | 21.22 |
| 16 | 21.5 | 265 | 92.25 | 461.23 | 55 | 55 | 20.63 | 21.45 |
| 17 | 22 | 274 | 95.38 | 476.89 | 56 | 56 | 21 | 21.68 |
| 18 | 22.5 | 283 | 98.51 | 492.56 | 57 | 57 | 21.38 | 21.89 |
| 19 | 23 | 292 | 101.64 | 508.22 | 58 | 58 | 21.75 | 22.1 |
| 20 | 23.5 | 301 | 104.78 | 523.88 | 59 | 59 | 22.13 | 22.29 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildAttackPacket(actor, 'sunder', slvl)` |
| B2 coefficient | `weaponDamage = 130 + 9 × (slvl − 1) + 6 × allocated(bloodletting)` |
| B5 / B6 | attribute bonus, then `× meleeScale 1.00` |
| B8 riders | `onHitStatus: [{ status:'cursed', chance:100, duration:6.0, magnitude: 40 + 1 × (slvl − 1) }]`, `blockable true`, `dodgeable false` — a ground nova is not dodged (03 §5.2) |
| Curse effect | `defensePercent −= magnitude`; all six resists `−= magnitude × 0.375` (03 §7.10). At magnitude 40 that is −40 % defence and −15 resistance points |
| Order | the curse is applied at R14(c) of the **same** resolve, so `sunder`'s own damage is *not* amplified by it — every following hit is |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| receives ← | `bloodletting` | `weaponDamage` | +6 % | +120 % (at 20 allocated points in `bloodletting`) |

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `cursed` | `40 + 1 × (slvl − 1)`, capped 70 | 6.0 s, shortened by target `ccReduction` | max-wins, refresh. −%defence and −0.375×magnitude to all six resists |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| `attack.windup` (0.3375 s) | `fx.telegraph('circle', x, z, 0, 4.0, 0, 0.3375)` — the Ravager's only self-telegraph, drawn so allies-of-nothing and the player both read the radius | — |
| `attack.active` | `fx.burst('sunder_shock', x, y, z, 4.0)` + `fx.decal('ground_crack', x, z, 4.0, U(0,2π), 6.0)` | `skill.rupture.slam` |
| on `actor:status` cursed | `fx.burst('curse_mark', target, 0.8)` | `status.cursed`, one voice for the whole nova, not per target |

**AI and monster interaction**

- The resistance component is what lets a physical Ravager help an elemental follow-up; against `molgrim` at 50 fire resist a magnitude-59 curse removes 22 points, taking the effective multiplier from ×0.50 to ×0.72 — a **44 % increase** in every fire hit for 6 seconds.
- `cursed` is a `statMods`-carrying status (01 §7.2), so it emits `stats:dirty` on the target and recomposition happens once at the top of the next `fixedUpdate`, not per hit.
- Champions and uniques take the full magnitude; the boss takes it too — `cursed` is not in the `frozen`/`stunned` DR chain.

The 6.0 s cooldown against a 6.0 s curse means **100 % uptime is possible and intended**: the capstone's job is to hold the debuff, not to be the damage rotation.

---
## 3. Ravager — Unyielding (`unyielding`)

The survival half. Two of its five skills are pure passives, one is a passive
trigger, and the two actives both buy time rather than deal it. A Ravager that
ignores this tree dies to the 29.80 DPS a five-strong pack puts out at
level 10 (03 §11.5) in 5.5 seconds.

*The plan calls this tree "Bulwark"; the shipped identifier is `unyielding`
(01 §6.1). Both names refer to the same five skills.*

---

### 3.1 `ram_charge` — Ram Charge / Рывок-таран

| Field | Value |
|---|---|
| `id` | `ram_charge` |
| Name EN / RU | Ram Charge / Рывок-таран |
| Class / tree | Ravager / `unyielding` |
| Tree position | row 1, column 2 (root) |
| Character level | 1 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `mobility` |
| Plain class | Active — dash with a terminal attack |
| `target` | `point` |
| `element` | `physical` |
| Range | up to **9.0 m** along the ground path, travelled at 16 m/s (0.5625 s at full range) |
| Radius / shape | 1.8 m on arrival |
| Cost | **10 rage**, `+0.40` per level (L20 = 17.6) |
| Cooldown | `8.0 − 0.20 × (slvl − 1)` s, floor **4.0 s** (L20 = 4.2 s) |
| Timing | 0.12 s of `attack.windup`, then the `dash` animation state (08 §5.5, `root: scripted`), then the arrival hit and 0.20 s of `recover`. The dash duration is **distance / 16**, not an attack interval, and does not scale with IAS |
| Click-to-move | Click a point or an actor. The dash direction is the straight line to the cursor, clipped by `nav` to the last walkable cell — a charge into a wall stops at the wall and still detonates. Movement input is ignored for the whole dash; the actor is in `actionLock`. |

**Twenty levels**

| L | Rage | Cooldown s | Weapon dmg % | Ref. hit | `stunned` s | Ref. 3-target burst | Dmg / rage (3 tgt) | → `war_cry` +stun % |
|---|---|---|---|---|---|---|---|---|
| 1 | 10 | 8 | 100 | 34.81 | 1.5 | 104.43 | 10.44 | 5 |
| 2 | 10.4 | 7.8 | 107 | 37.25 | 1.55 | 111.74 | 10.74 | 10 |
| 3 | 10.8 | 7.6 | 114 | 39.68 | 1.6 | 119.05 | 11.02 | 15 |
| 4 | 11.2 | 7.4 | 121 | 42.12 | 1.65 | 126.36 | 11.28 | 20 |
| 5 | 11.6 | 7.2 | 128 | 44.56 | 1.7 | 133.67 | 11.52 | 25 |
| 6 | 12 | 7 | 135 | 46.99 | 1.75 | 140.98 | 11.75 | 30 |
| 7 | 12.4 | 6.8 | 142 | 49.43 | 1.8 | 148.29 | 11.96 | 35 |
| 8 | 12.8 | 6.6 | 149 | 51.87 | 1.85 | 155.6 | 12.16 | 40 |
| 9 | 13.2 | 6.4 | 156 | 54.3 | 1.9 | 162.91 | 12.34 | 45 |
| 10 | 13.6 | 6.2 | 163 | 56.74 | 1.95 | 170.22 | 12.52 | 50 |
| 11 | 14 | 6 | 170 | 59.18 | 2 | 177.53 | 12.68 | 55 |
| 12 | 14.4 | 5.8 | 177 | 61.61 | 2.05 | 184.84 | 12.84 | 60 |
| 13 | 14.8 | 5.6 | 184 | 64.05 | 2.1 | 192.15 | 12.98 | 65 |
| 14 | 15.2 | 5.4 | 191 | 66.49 | 2.15 | 199.46 | 13.12 | 70 |
| 15 | 15.6 | 5.2 | 198 | 68.92 | 2.2 | 206.77 | 13.25 | 75 |
| 16 | 16 | 5 | 205 | 71.36 | 2.25 | 214.08 | 13.38 | 80 |
| 17 | 16.4 | 4.8 | 212 | 73.8 | 2.3 | 221.39 | 13.5 | 85 |
| 18 | 16.8 | 4.6 | 219 | 76.23 | 2.35 | 228.7 | 13.61 | 90 |
| 19 | 17.2 | 4.4 | 226 | 78.67 | 2.4 | 236.01 | 13.72 | 95 |
| 20 | 17.6 | 4.2 | 233 | 81.11 | 2.45 | 243.32 | 13.82 | 100 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildAttackPacket(actor, 'ram_charge', slvl)` on arrival, once |
| B2 coefficient | `weaponDamage = 100 + 7 × (slvl − 1)` |
| B8 riders | `onHitStatus: [{ status:'stunned', chance:100, duration: 1.5 + 0.05 × (slvl − 1) }]`, `knockback: 0`, `dodgeable false` |
| Targets | every hostile inside 1.8 m of the arrival point. Actors **passed through** during the dash are not hit — the charge is a reposition with a payload, not a line attack |
| Collision | the dashing actor carries `ACTOR_FLAG.noCollide` for the flight so it cannot be body-blocked by a `carrion_swarm` ring |
| Stun DR | subject to the 6 s diminishing-returns chain of 03 §7.7 — ×1, ×0.6, ×0.36, ×0.216, then refused |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| grants → | `war_cry` | `stunDuration` | +5 % | +100 % (doubles the War Cry stun) |

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `stunned` | n/a (0) | `1.5 + 0.05 × (slvl − 1)` s, capped **2.5 s**, × `(1 − ccReduction/100)` | max-wins on remaining; DR chain shared with `frozen`; boss duration × 0.25 |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| `attack.windup` (0.12 s) | `fx.burst('charge_brace', actor, 0.6)` | — |
| `dash` (scripted root) | `fx.trail('charge_dust', actorRef)`, `fx.decal('scrape', …)` every 0.10 s | `skill.charge.dash`, tracked emitter |
| arrival / `active` | `fx.burst('charge_impact', point, 1.8)` | `skill.charge.impact`, then `status.stunned` per stunned target (one voice, 10 §4.4) |

**AI and monster interaction**

- A charge into a pack of `carrion_swarm` stuns the whole cluster for 1.5 s at slvl 1 — the standard opener, and the reason the skill sits at character level 1.
- A `maulsmith` stunned during its 1.21 s `crushing_slam` wind-up loses the hit entirely (08 §6.6: a stun cancels a wind-up and no hit is emitted). This is the highest-value interrupt the Ravager has.
- `molgrim` takes the stun at ×0.25 duration and shares the DR chain, so a chain-charge lock is arithmetically impossible: 2.45 × 0.25 = 0.61 s, then 0.37, 0.22, 0.13, then refused.

---

### 3.2 `shield_stance` — Shield Stance / Стойка щита

| Field | Value |
|---|---|
| `id` | `shield_stance` |
| Name EN / RU | Shield Stance / Стойка щита |
| Class / tree | Ravager / `unyielding` |
| Tree position | row 2, column 1 |
| Character level | 6 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `passive` |
| Plain class | Passive — always on |
| `target` | `none` |
| `element` | `physical` |
| Range | — |
| Radius / shape | — |
| Cost | none |
| Cooldown | none |
| Timing | none — a `sources.skills` contribution |
| Click-to-move | Not castable; never on the hotbar. |

**Twenty levels**

| L | `blockChance` + | `thorns` + | `dodgeChance` + | Block % — kite shield, DEX 32, clvl 13 | Thorns returned / 5-monster pack hit-round |
|---|---|---|---|---|---|
| 1 | 8 | 6 | 3 | 43.96 | 30 |
| 2 | 9.6 | 10 | 3.5 | 45.56 | 50 |
| 3 | 11.2 | 14 | 4 | 47.16 | 70 |
| 4 | 12.8 | 18 | 4.5 | 48.76 | 90 |
| 5 | 14.4 | 22 | 5 | 50.36 | 110 |
| 6 | 16 | 26 | 5.5 | 51.96 | 130 |
| 7 | 17.6 | 30 | 6 | 53.56 | 150 |
| 8 | 19.2 | 34 | 6.5 | 55.16 | 170 |
| 9 | 20.8 | 38 | 7 | 56.76 | 190 |
| 10 | 22.4 | 42 | 7.5 | 58.36 | 210 |
| 11 | 24 | 46 | 8 | 59.96 | 230 |
| 12 | 25.6 | 50 | 8.5 | 61.56 | 250 |
| 13 | 27.2 | 54 | 9 | 63.16 | 270 |
| 14 | 28.8 | 58 | 9.5 | 64.76 | 290 |
| 15 | 30.4 | 62 | 10 | 66.36 | 310 |
| 16 | 32 | 66 | 10.5 | 67.96 | 330 |
| 17 | 33.6 | 70 | 11 | 69.56 | 350 |
| 18 | 35.2 | 74 | 11.5 | 71.16 | 370 |
| 19 | 36.8 | 78 | 12 | 72.76 | 390 |
| 20 | 38.4 | 82 | 12.5 | 74.36 | 410 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Produces | no packet of its own. `thorns` is emitted by `combat` at R14(e) as a separate `attackRating = 0` packet that always hits and never recurses |
| Contributes | `{ blockChance: 8 + 1.6 × (slvl − 1), thorns: 6 + 4 × (slvl − 1), dodgeChance: 3 + 0.5 × (slvl − 1) }` |
| `blockChance` | flat, added **after** the DEX/shield term of 03 §5.3, and still **0 without a shield in `offHand`** — the whole roll short-circuits |
| `dodgeChance` | rolled only when `packet.dodgeable === true`; ground effects, DoT ticks and `essence_burn` set it false |
| Caps | `blockChance` 75, `dodgeChance` 50, both well clear of this skill alone |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| grants → | `iron_skin` | `defensePercent` | +4 % | +80 % |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| on a successful block | `fx.burst('block_spark', point, 0.8)`, `block.impact` overlay (08 §5.5) kicks the shield back 18° | `melee.block`; `melee.parry` when the block lands inside the 0.20 s block-recovery window |
| on a thorns return | `fx.burst('thorn_prick', attacker, 0.3)` | `melee.hit.metal` at 0.5 gain |

**AI and monster interaction**

- Block reduces damage to **zero** (03 §5.3) but still triggers `thorns` and still applies `onHitStatus` riders with unchanged chance — a blocked `blight_crawler` detonation still poisons.
- A block puts the Ravager into a 0.20 s block-recovery lock that does **not** stack with hit recovery, which is what makes a high-block Ravager immune to the stun-lock spiral 03 §7.11 exists to prevent.

**`dodgeChance` closes an internal gap in 03-combat-math.md**, and the fix is applied on both sides: 03 §8.2's `shield_stance` row now carries `dodgeChance += 3 + 0.5/L`, matching §5.2's claim that dodge "comes only from affixes and from `shield_stance`". See **D-05-3** at the end of this document.

---

### 3.3 `war_cry` — War Cry / Боевой клич

| Field | Value |
|---|---|
| `id` | `war_cry` |
| Name EN / RU | War Cry / Боевой клич |
| Class / tree | Ravager / `unyielding` |
| Tree position | row 3, column 3 |
| Character level | 12 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `nova` |
| Plain class | Active — nova stun plus a self-buff |
| `target` | `self` |
| `element` | `physical` |
| Range | self-centred |
| Radius / shape | **7.0 m**, flat at every level |
| Cost | **18 rage**, `+0.60` per level (L20 = 29.4) |
| Cooldown | **14.0 s**, flat |
| Timing | `castTime 0.50 s` × `castScale 1.15` = **0.575 s** at FCR 0, scaled by `fasterCastRate`. Wind-up fraction 0.65 (03 §4.5), so the stun lands 0.374 s after the button |
| Click-to-move | Self-cast; the cursor is ignored entirely. The actor stops moving for the cast. On cooldown the click is refused and plays `player.cast.fail`. |

**Twenty levels**

| L | Rage | `stunned` s (no synergy) | `stunned` s (`ram_charge` 20) | `enhancedDamage` +% | Buff s | Ref. basic hit under buff | Damage gain vs unbuffed | Uptime (12 s / 14 s CD) |
|---|---|---|---|---|---|---|---|---|
| 1 | 18 | 1.2 | 2.4 | 15 | 12 | 38.54 | 10.71 % | 85.7 % |
| 2 | 18.6 | 1.26 | 2.52 | 17 | 12 | 39.04 | 12.14 % | 85.7 % |
| 3 | 19.2 | 1.32 | 2.64 | 19 | 12 | 39.53 | 13.57 % | 85.7 % |
| 4 | 19.8 | 1.38 | 2.76 | 21 | 12 | 40.03 | 15 % | 85.7 % |
| 5 | 20.4 | 1.44 | 2.88 | 23 | 12 | 40.53 | 16.43 % | 85.7 % |
| 6 | 21 | 1.5 | 3 | 25 | 12 | 41.03 | 17.86 % | 85.7 % |
| 7 | 21.6 | 1.56 | 3.12 | 27 | 12 | 41.52 | 19.29 % | 85.7 % |
| 8 | 22.2 | 1.62 | 3.24 | 29 | 12 | 42.02 | 20.71 % | 85.7 % |
| 9 | 22.8 | 1.68 | 3.36 | 31 | 12 | 42.52 | 22.14 % | 85.7 % |
| 10 | 23.4 | 1.74 | 3.48 | 33 | 12 | 43.01 | 23.57 % | 85.7 % |
| 11 | 24 | 1.8 | 3.6 | 35 | 12 | 43.51 | 25 % | 85.7 % |
| 12 | 24.6 | 1.86 | 3.72 | 37 | 12 | 44.01 | 26.43 % | 85.7 % |
| 13 | 25.2 | 1.92 | 3.84 | 39 | 12 | 44.51 | 27.86 % | 85.7 % |
| 14 | 25.8 | 1.98 | 3.96 | 41 | 12 | 45 | 29.29 % | 85.7 % |
| 15 | 26.4 | 2.04 | 4.08 | 43 | 12 | 45.5 | 30.71 % | 85.7 % |
| 16 | 27 | 2.1 | 4.2 | 45 | 12 | 46 | 32.14 % | 85.7 % |
| 17 | 27.6 | 2.16 | 4.32 | 47 | 12 | 46.5 | 33.57 % | 85.7 % |
| 18 | 28.2 | 2.22 | 4.44 | 49 | 12 | 46.99 | 35 % | 85.7 % |
| 19 | 28.8 | 2.28 | 4.56 | 51 | 12 | 47.49 | 36.43 % | 85.7 % |
| 20 | 29.4 | 2.34 | 4.68 | 53 | 12 | 47.99 | 37.86 % | 85.7 % |

**`DamagePacket`**

| Field | Value |
|---|---|
| Produces | a **damage-free** packet: all `min/max` components are 0, `attackRating = 0` (always hits), `dodgeable false`, `blockable false` |
| Riders | `onHitStatus: [{ status:'stunned', chance:100, duration: (1.2 + 0.06 × (slvl − 1)) × (1 + 0.05 × allocated(ram_charge)) }]` |
| Self-buff | `skills.applyBuff(actor, 'war_cry', slvl, 12.0)` contributing `{ enhancedDamage: 15 + 2 × (slvl − 1) }` to `sources.skills`; emits `stats:dirty` |
| Enhanced damage stacking | `add→mul` (01 §3.3) — the buff **sums** with gear ED and the sum is applied once at B3. It is not a separate multiplier |
| Targets | every hostile inside 7.0 m, resolved in ascending `actor.id` |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| receives ← | `ram_charge` | stun duration | +5 % | +100 % |

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `stunned` | n/a (0) | `1.2 + 0.06 × (slvl − 1)` s, doubled at 20 points of `ram_charge`, × `(1 − ccReduction/100)` | DR chain of 03 §7.7; boss × 0.25 |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| `cast` wind-up (0.374 s) | `fx.burst('warcry_intake', actor, 0.5)` | — (the shout's intake is the first 300 ms of `skill.warcry`) |
| `cast` active | `fx.burst('warcry_ring', x, y, z, 7.0)` expanding ring + `fx.requestLight(actor, [1.0,0.55,0.2], 2.4, 8.0, 0.4)` | `skill.warcry` (1400 ms, ducks music −4 dB) |
| buff active | `fx.trail('rage_aura', actorRef)` at 0.3 intensity for 12 s | — |
| per stunned target | — | `status.stunned`, **one** voice for the whole nova |

**AI and monster interaction**

- A 7.0 m nova reaches every monster in a standard pack blob and interrupts every wind-up in it simultaneously — the Ravager's panic button and the only skill that answers a `dust_shaman` mid-`raise_ranker` (a 1.05 s ritual that a stun cancels outright).
- Because the packet carries no damage, it generates **no threat** through damage; `combat.addThreat()` is called with a flat 1 per target so the pack still turns, which is intended.
- The buff is on the caster only. There are no allies in this game, so `war_cry` never needs a party path.

---

### 3.4 `iron_skin` — Iron Skin / Железная кожа

| Field | Value |
|---|---|
| `id` | `iron_skin` |
| Name EN / RU | Iron Skin / Железная кожа |
| Class / tree | Ravager / `unyielding` |
| Tree position | row 3, column 1 |
| Character level | 12 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `passive` |
| Plain class | Passive — always on |
| `target` | `none` |
| `element` | `physical` |
| Range | — |
| Radius / shape | — |
| Cost | none |
| Cooldown | none |
| Timing | none — a `sources.skills` contribution |
| Click-to-move | Not castable; never on the hotbar. |

**Twenty levels**

| L | `defensePercent` + (alone) | `defensePercent` + (`shield_stance` 20) | `physicalResist` + | DEF from 130 armour, alone | DEF from 130 armour, + synergy | Bone Ranker hit chance vs that DEF |
|---|---|---|---|---|---|---|
| 1 | 25 | 105 | 1 | 169.5 | 273.5 | 42.12 % |
| 2 | 30 | 110 | 1.5 | 176 | 280 | 41.54 % |
| 3 | 35 | 115 | 2 | 182.5 | 286.5 | 40.99 % |
| 4 | 40 | 120 | 2.5 | 189 | 293 | 40.45 % |
| 5 | 45 | 125 | 3 | 195.5 | 299.5 | 39.92 % |
| 6 | 50 | 130 | 3.5 | 202 | 306 | 39.41 % |
| 7 | 55 | 135 | 4 | 208.5 | 312.5 | 38.91 % |
| 8 | 60 | 140 | 4.5 | 215 | 319 | 38.42 % |
| 9 | 65 | 145 | 5 | 221.5 | 325.5 | 37.94 % |
| 10 | 70 | 150 | 5.5 | 228 | 332 | 37.48 % |
| 11 | 75 | 155 | 6 | 234.5 | 338.5 | 37.02 % |
| 12 | 80 | 160 | 6.5 | 241 | 345 | 36.58 % |
| 13 | 85 | 165 | 7 | 247.5 | 351.5 | 36.15 % |
| 14 | 90 | 170 | 7.5 | 254 | 358 | 35.73 % |
| 15 | 95 | 175 | 8 | 260.5 | 364.5 | 35.31 % |
| 16 | 100 | 180 | 8.5 | 267 | 371 | 34.91 % |
| 17 | 105 | 185 | 9 | 273.5 | 377.5 | 34.52 % |
| 18 | 110 | 190 | 9.5 | 280 | 384 | 34.13 % |
| 19 | 115 | 195 | 10 | 286.5 | 390.5 | 33.76 % |
| 20 | 120 | 200 | 10.5 | 293 | 397 | 33.39 % |

**`DamagePacket`**

| Field | Value |
|---|---|
| Produces | no packet |
| Contributes | `{ defensePercent: 25 + 5 × (slvl − 1) + 4 × allocated(shield_stance), physicalResist: 1 + 0.5 × (slvl − 1) }` |
| `defensePercent` | `add→mul` — applied in `derive()` as `(Σ item defence + Σ flat defense) × (1 + defensePercent/100) + ⌊DEX/4⌋`. Note the DEX term is **outside** the multiplier |
| `physicalResist` | applied at R7c, **after** `damageReduceFlat` and `damageReducePercent`. Capped by `maxPhysicalResist` (default 75), so the skill's own 25-point cap is the binding one |
| Difficulty | `physicalResist` is never penalised by difficulty (03 §10.2) — this skill is worth exactly as much in Renunciation as in Instruction, which is the point of putting it here |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| receives ← | `shield_stance` | `defensePercent` | +4 % | +80 % |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| on a hit that `physicalResist` reduced by ≥ 25 % | `fx.impact(point, normal, 'metal', power × 0.6)` | `melee.glance` |
| passive | a `materials` tint: `uRimBoost += 0.10` on the chest and helm sockets so a high-`iron_skin` Ravager reads as armoured at 20 m (08 §3.8) | — |

**AI and monster interaction**

- Defence enters the monster's to-hit roll, not its damage, so `iron_skin` converts incoming DPS into *misses*. Against a `bone_ranker` at AR 199 and clvl 10, taking DEF from 137 to 460 drops its hit chance from 59.23 % to 29.62 % — a straight halving of pack DPS.
- It works against ranged attacks too: `ash_shot` is a normal attack packet with `attackRating > 0` and is rolled against DEF like any other.
- It does nothing against `blight_crawler` `detonate` (poison, `attackRating = 0`, always hits) or against `molgrim`'s `syllable_burn` aura. Elemental resistance is the answer there.

---

### 3.5 `last_stand` — Last Stand / Последний рубеж

| Field | Value |
|---|---|
| `id` | `last_stand` |
| Name EN / RU | Last Stand / Последний рубеж |
| Class / tree | Ravager / `unyielding` |
| Tree position | row 4, column 2 (capstone) |
| Character level | 18 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `passive` |
| Plain class | Passive trigger — fires itself, cannot be cast |
| `target` | `self` |
| `element` | `physical` |
| Range | — |
| Radius / shape | — |
| Cost | none. **Grants +40 rage** on trigger (03 §2.4) |
| Cooldown | `90 − 2 × (slvl − 1)` s, floor **50 s** (L20 = 52 s) |
| Timing | instantaneous, inside R14(a) of the hit that crossed the threshold. It costs no animation state and cannot be interrupted |
| Click-to-move | Never castable. It appears on the character sheet with its cooldown, and `ui` shows the absorb as an overlay on the life globe. |

**Twenty levels**

| L | Cooldown s | Absorb | Absorb as % of 345 life (clvl 30) | Extra seconds vs 29.80 pack DPS | Effective life added over a 90 s fight |
|---|---|---|---|---|---|
| 1 | 90 | 40 | 11.59 % | 1.34 | 80 |
| 2 | 88 | 62 | 17.97 % | 2.08 | 124 |
| 3 | 86 | 84 | 24.35 % | 2.82 | 168 |
| 4 | 84 | 106 | 30.72 % | 3.56 | 212 |
| 5 | 82 | 128 | 37.1 % | 4.3 | 256 |
| 6 | 80 | 150 | 43.48 % | 5.03 | 300 |
| 7 | 78 | 172 | 49.86 % | 5.77 | 344 |
| 8 | 76 | 194 | 56.23 % | 6.51 | 388 |
| 9 | 74 | 216 | 62.61 % | 7.25 | 432 |
| 10 | 72 | 238 | 68.99 % | 7.99 | 476 |
| 11 | 70 | 260 | 75.36 % | 8.72 | 520 |
| 12 | 68 | 282 | 81.74 % | 9.46 | 564 |
| 13 | 66 | 304 | 88.12 % | 10.2 | 608 |
| 14 | 64 | 326 | 94.49 % | 10.94 | 652 |
| 15 | 62 | 348 | 100.87 % | 11.68 | 696 |
| 16 | 60 | 370 | 107.25 % | 12.42 | 740 |
| 17 | 58 | 392 | 113.62 % | 13.15 | 784 |
| 18 | 56 | 414 | 120 % | 13.89 | 828 |
| 19 | 54 | 436 | 126.38 % | 14.63 | 872 |
| 20 | 52 | 458 | 132.75 % | 15.37 | 916 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Produces | no packet |
| Trigger | evaluated in R14(a) after `life -= total`: fires when `life ≤ 0.25 × maxLife` **and** `cooldowns.get('last_stand') ≤ now` |
| Effect | `skills.applyBuff(actor, 'last_stand', slvl, 8.0)` creating an absorb pool of `40 + 22 × (slvl − 1)`; `actor.rage = min(maxRage, rage + 40)` |
| Absorb semantics | absorb is consumed at R13, **before** `life -= total`, across every element including poison seeding. It is not a resistance and is not affected by `physicalResist` |
| Expiry | the pool ends at 8.0 s or at 0 remaining, whichever comes first. Unlike `smouldering_ward` it does **not** detonate |
| Interaction with death | a single hit larger than `life + absorb` still kills. The absorb is not a death save |

**Synergies**

None in either direction.

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| on trigger | `fx.burst('laststand_flare', actor, 2.0)`, `fx.requestLight(actor, [1.0,0.35,0.15], 3.2, 9.0, 0.6)`, `fx.trail('absorb_shell', actorRef)` for 8 s | `skill.laststand` (1600 ms, ducks music −8 dB) |
| when the +40 rage fills the bar | — | `rage.full`, at most once per 4 s |
| on pool depletion | `fx.burst('absorb_crack', actor, 1.0)` | `embershield.break` at 0.7 gain |

**AI and monster interaction**

- The +40 rage is the mechanical point: the trigger arrives exactly when the Ravager is out of resource and needs `war_cry` or a `ram_charge` disengage immediately. At slvl 1 that is 40 rage — two War Cries or four Cleaving Strikes.
- It cannot be baited into a wasted trigger by chip damage, because the threshold is a life fraction, not a damage amount.
- Against `molgrim` phase III (`syllable_burn`, 2 % `maxLife`/s as magic) the shield buys `absorb / (0.02 × maxLife)` seconds — 66 s at slvl 20 and 345 life. The aura alone can never kill through it.

The **50 s cooldown floor** exists so that a boss fight at the locked 60–90 s target gets **at most two** triggers. Twenty points buy a 458-point shield twice, not a permanent one.

---
## 4. Emberwright — Flame (`flame`)

A straight damage ladder: a spammable bolt, a cone, a burst projectile, a
delayed nuke and a passive that multiplies all four. Every number here is fire,
so the tree lives and dies on `fireResist` — and the two `meteor` synergies are
the reason a pure-Flame Emberwright still has something to spend late points on.

*The plan calls this tree "Pyre"; the shipped identifier is `flame` (01 §6.1).*

---

### 4.1 `ember_bolt` — Ember Bolt / Огненный болт

| Field | Value |
|---|---|
| `id` | `ember_bolt` |
| Name EN / RU | Ember Bolt / Огненный болт |
| Class / tree | Emberwright / `flame` |
| Tree position | row 1, column 2 (root) |
| Character level | 1 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `projectile` |
| Plain class | Active — single projectile |
| `target` | `point` |
| `element` | `fire` |
| Range | `speed × lifetime = 26 × 2.2 = 57.2 m`, in practice limited by the camera |
| Radius / shape | projectile collision radius 0.30 m; no blast |
| Cost | **2.0 mana**, `+0.25` per level (L20 = 6.75). Reduced by `manaCostReduction`, floored at 1 |
| Cooldown | none |
| Timing | `castTime 0.55 s` × `castScale 0.85` = **0.4675 s** at FCR 0 (03 E6.8). The projectile spawns at the entry to `active`, i.e. 0.65 of the interval in |
| Click-to-move | Fires at the cursor's ground point. No line of sight test and no walk-into-range — the Emberwright casts from wherever it stands, which is the whole reason its `castScale` is 0.85 and its life is the lowest in the game. Holding the button repeats while mana lasts. |

**Twenty levels**

| L | Mana | Fire min | Fire max | Avg | Ref. hit | Ref. DPS @ 0.4675 s | Dmg / mana | Pierce | → `meteor` +fire % |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 3 | 7 | 5 | 6.56 | 14.04 | 3.28 | no | 6 |
| 2 | 2.25 | 5.25 | 10.75 | 8 | 10.5 | 22.46 | 4.67 | no | 12 |
| 3 | 2.5 | 7.5 | 14.5 | 11 | 14.44 | 30.88 | 5.78 | no | 18 |
| 4 | 2.75 | 9.75 | 18.25 | 14 | 18.38 | 39.3 | 6.68 | no | 24 |
| 5 | 3 | 12 | 22 | 17 | 22.31 | 47.73 | 7.44 | no | 30 |
| 6 | 3.25 | 14.25 | 25.75 | 20 | 26.25 | 56.15 | 8.08 | no | 36 |
| 7 | 3.5 | 16.5 | 29.5 | 23 | 30.19 | 64.57 | 8.63 | no | 42 |
| 8 | 3.75 | 18.75 | 33.25 | 26 | 34.13 | 72.99 | 9.1 | no | 48 |
| 9 | 4 | 21 | 37 | 29 | 38.06 | 81.42 | 9.52 | no | 54 |
| 10 | 4.25 | 23.25 | 40.75 | 32 | 42 | 89.84 | 9.88 | yes | 60 |
| 11 | 4.5 | 25.5 | 44.5 | 35 | 45.94 | 98.26 | 10.21 | yes | 66 |
| 12 | 4.75 | 27.75 | 48.25 | 38 | 49.88 | 106.68 | 10.5 | yes | 72 |
| 13 | 5 | 30 | 52 | 41 | 53.81 | 115.11 | 10.76 | yes | 78 |
| 14 | 5.25 | 32.25 | 55.75 | 44 | 57.75 | 123.53 | 11 | yes | 84 |
| 15 | 5.5 | 34.5 | 59.5 | 47 | 61.69 | 131.95 | 11.22 | yes | 90 |
| 16 | 5.75 | 36.75 | 63.25 | 50 | 65.63 | 140.37 | 11.41 | yes | 96 |
| 17 | 6 | 39 | 67 | 53 | 69.56 | 148.8 | 11.59 | yes | 102 |
| 18 | 6.25 | 41.25 | 70.75 | 56 | 73.5 | 157.22 | 11.76 | yes | 108 |
| 19 | 6.5 | 43.5 | 74.5 | 59 | 77.44 | 165.64 | 11.91 | yes | 114 |
| 20 | 6.75 | 45.75 | 78.25 | 62 | 81.38 | 174.06 | 12.06 | yes | 120 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildSpellPacket(actor, 'ember_bolt', slvl)` |
| B1 / B5 | `physMin = physMax = 0`; the attribute bonus is **skipped entirely for spells** (03 §4.2) |
| B6 | `× spellScale 1.00`, then `× (1 + fireDamagePercent/100) × (1 + elementalDamagePercent/100)` |
| B7 fire | `fireMin = 3 + 2.25 × (slvl − 1)`, `fireMax = 7 + 3.75 × (slvl − 1)`, plus flat `fireMin`/`fireMax` from gear |
| B8 riders | `attackRating = 0` → **always hits** (03 §5.1, R2 skipped). `dodgeable false`, `blockable false` |
| `ProjectileSpec` | `{ speed: 26, lifetime: 2.2, radius: 0.30, pierce: { fromLevel: 10 }, gravity: 0, homing: 0, maxTargets: 1 }` |
| Pierce | from effective level 10 the projectile passes through and re-resolves on every actor along its path, once each. `actor.hitsThisAction` carries the pierce accounting |
| `burning` | seeded by the default rule of 03 §7.4 — `totalFireDamage × 0.35` over 3.0 s, up to 3 independent stacks |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| grants → | `meteor` | `flatDamage` (fire) | +6 % | +120 % |

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `burning` | `fireDealt × 0.35 / 3.0` per second (the default seeding, not a skill override) | 3.0 s, fixed | up to 3 independent stacks; a fourth replaces the lowest `totalRemaining`; 4 Hz |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| `cast` wind-up (0.65 of the interval) | `uGlow` ramp on the casting hand (08 §6.3), `fx.requestLight(hand, [1.0,0.45,0.15], 1.2, 3.0, 0.30)` | `spell.cast.fire` |
| entry to `active` | `fx.trail('ember_bolt', projectileRef)`; `projectile:spawn` emitted | `firebolt.launch`, then `firebolt.loop` tracked to the projectile |
| impact | `fx.elementalImpact(x,y,z,'fire',0.6,power)`; `skill:impact` emitted | `firebolt.impact` |
| `burning` applied | `fx.trail('burn_wisp', targetRef)` | `status.burning`, ticks `dot.burning.tick` |

**AI and monster interaction**

- The projectile is stopped by `ash_wall` only when the wall belongs to an enemy — the player's own wall blocks **enemy** projectiles and nothing else (03 §8.4).
- Pierce from level 10 turns the bolt into the Emberwright's answer to a `carrion_swarm` line; a single 57 m bolt through a queued pack resolves once per body.
- Monsters do not dodge projectiles and have no perception of them; they react to `actor:damage` only. There is no counter-play to a bolt except closing distance, which is why `ashen_step` sits in the other tree at level 1.

**Best damage per mana in the game at level 1 and still competitive at 20.** This is deliberate: the Emberwright's mana pool is its life bar, and the level-1 skill has to remain the sustain option for all thirty levels.

---

### 4.2 `flame_wave` — Flame Wave / Волна пламени

| Field | Value |
|---|---|
| `id` | `flame_wave` |
| Name EN / RU | Flame Wave / Волна пламени |
| Class / tree | Emberwright / `flame` |
| Tree position | row 2, column 2 |
| Character level | 6 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `cone` |
| Plain class | Active — instant cone |
| `target` | `direction` |
| `element` | `fire` |
| Range | **7.0 m** |
| Radius / shape | 90° arc, 7.0 m — an area of 38.5 m² |
| Cost | **5.0 mana**, `+0.50` per level (L20 = 14.5) |
| Cooldown | none |
| Timing | `castTime 0.65 s` × `castScale 0.85` = **0.5525 s** at FCR 0 |
| Click-to-move | The cone is aimed at the cursor; the actor turns to face it during the first 40 % of the wind-up and is facing-locked thereafter (08 §6.5). It never walks. Hold to repeat. |

**Twenty levels**

| L | Mana | Fire min | Fire max | Avg | Ref. hit | Ref. burn /s | Ref. hit + full burn | Ref. 5-target burst | Dmg / mana (5 tgt) | → `incinerate` +det. % |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 5 | 6 | 12 | 9 | 11.81 | 1.33 | 17.13 | 85.64 | 17.13 | 4 |
| 2 | 5.5 | 9.2 | 17.4 | 13.3 | 17.46 | 1.96 | 25.31 | 126.56 | 23.01 | 8 |
| 3 | 6 | 12.4 | 22.8 | 17.6 | 23.1 | 2.6 | 33.5 | 167.47 | 27.91 | 12 |
| 4 | 6.5 | 15.6 | 28.2 | 21.9 | 28.74 | 3.23 | 41.68 | 208.39 | 32.06 | 16 |
| 5 | 7 | 18.8 | 33.6 | 26.2 | 34.39 | 3.87 | 49.86 | 249.31 | 35.62 | 20 |
| 6 | 7.5 | 22 | 39 | 30.5 | 40.03 | 4.5 | 58.05 | 290.23 | 38.7 | 24 |
| 7 | 8 | 25.2 | 44.4 | 34.8 | 45.68 | 5.14 | 66.23 | 331.14 | 41.39 | 28 |
| 8 | 8.5 | 28.4 | 49.8 | 39.1 | 51.32 | 5.77 | 74.41 | 372.06 | 43.77 | 32 |
| 9 | 9 | 31.6 | 55.2 | 43.4 | 56.96 | 6.41 | 82.6 | 412.98 | 45.89 | 36 |
| 10 | 9.5 | 34.8 | 60.6 | 47.7 | 62.61 | 7.04 | 90.78 | 453.9 | 47.78 | 40 |
| 11 | 10 | 38 | 66 | 52 | 68.25 | 7.68 | 98.96 | 494.81 | 49.48 | 44 |
| 12 | 10.5 | 41.2 | 71.4 | 56.3 | 73.89 | 8.31 | 107.15 | 535.73 | 51.02 | 48 |
| 13 | 11 | 44.4 | 76.8 | 60.6 | 79.54 | 8.95 | 115.33 | 576.65 | 52.42 | 52 |
| 14 | 11.5 | 47.6 | 82.2 | 64.9 | 85.18 | 9.58 | 123.51 | 617.56 | 53.7 | 56 |
| 15 | 12 | 50.8 | 87.6 | 69.2 | 90.83 | 10.22 | 131.7 | 658.48 | 54.87 | 60 |
| 16 | 12.5 | 54 | 93 | 73.5 | 96.47 | 10.85 | 139.88 | 699.4 | 55.95 | 64 |
| 17 | 13 | 57.2 | 98.4 | 77.8 | 102.11 | 11.49 | 148.06 | 740.32 | 56.95 | 68 |
| 18 | 13.5 | 60.4 | 103.8 | 82.1 | 107.76 | 12.12 | 156.25 | 781.23 | 57.87 | 72 |
| 19 | 14 | 63.6 | 109.2 | 86.4 | 113.4 | 12.76 | 164.43 | 822.15 | 58.73 | 76 |
| 20 | 14.5 | 66.8 | 114.6 | 90.7 | 119.04 | 13.39 | 172.61 | 863.07 | 59.52 | 80 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildSpellPacket(actor, 'flame_wave', slvl)` — one packet, resolved per target in ascending `actor.id` |
| B7 fire | `fireMin = 6 + 3.2 × (slvl − 1)`, `fireMax = 12 + 5.4 × (slvl − 1)` |
| B8 riders | `attackRating = 0`, `dodgeable false`, `blockable false` |
| `burning` override | **this skill overrides the default seeding** (03 §7.4): `0.45 ×` the fire damage dealt, spread over **4.0 s** instead of `0.35 ×` over 3.0 s |
| Independent rolls | each target gets its own `U(min,max)` draw at R8 and its own crit draw at R6 — a five-target cone is five draws from the `combat` stream, in `actor.id` order |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| grants → | `incinerate` | detonation damage | +4 % | +80 % |

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `burning` | `0.45 × fireDealt / 4.0` per second | 4.0 s, fixed | 3 stacks, 4 Hz. Re-casting into the same pack stacks up to 3 and then replaces the weakest |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| `cast` wind-up | `fx.telegraph('cone', x, z, facing, 7.0, π/2, 0.36)` at 0.25 opacity — a courtesy read for the player, not a monster telegraph | `flamewave.cast` (620 ms, starts on the wind-up) |
| `active` | `fx.burst('flame_cone', x, y, z, 7.0)`, `fx.requestLight` 1 slot for 0.5 s | `flamewave.loop` for the 0.9 s tail |
| per target | `fx.elementalImpact(target,'fire',0.8,power)` | `status.burning` once per cast, not per target |

**AI and monster interaction**

- Three burning stacks on the same monster is the fastest route to an `incinerate` detonation, and the detonation does **not** chain (03 §8.3) — so the combo clears a pack in two casts without ever becoming a screen-clearing loop.
- A cone aimed through a `maulsmith` reaches the `dust_shaman` behind it; the 7 m range is exactly the Shaman's 9 m attack range minus a step, so closing two metres is the intended play.

---

### 4.3 `fireball` — Fireball / Огненный шар

| Field | Value |
|---|---|
| `id` | `fireball` |
| Name EN / RU | Fireball / Огненный шар |
| Class / tree | Emberwright / `flame` |
| Tree position | row 3, column 2 |
| Character level | 12 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `projectile` |
| Plain class | Active — projectile with a blast |
| `target` | `point` |
| `element` | `fire` |
| Range | projectile, `26 × 2.2 = 57.2 m` travel |
| Radius / shape | blast `2.8 + 0.03 × (slvl − 1)` m on impact |
| Cost | **7.0 mana**, `+0.70` per level (L20 = 20.3) |
| Cooldown | none |
| Timing | `castTime 0.60 s` × `castScale 0.85` = **0.51 s** at FCR 0 |
| Click-to-move | As `ember_bolt`: cast at the cursor point, no walk-into-range, hold to repeat. |

**Twenty levels**

| L | Mana | Fire min | Fire max | Avg | Ref. hit | Blast radius m | Ref. 4-target burst | Ref. DPS @ 0.51 s, 4 tgt | Dmg / mana (4 tgt) | → `meteor` +fire % |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 7 | 14 | 26 | 20 | 26.25 | 2.8 | 105 | 205.88 | 15 | 5 |
| 2 | 7.7 | 20 | 36 | 28 | 36.75 | 2.83 | 147 | 288.24 | 19.09 | 10 |
| 3 | 8.4 | 26 | 46 | 36 | 47.25 | 2.86 | 189 | 370.59 | 22.5 | 15 |
| 4 | 9.1 | 32 | 56 | 44 | 57.75 | 2.89 | 231 | 452.94 | 25.38 | 20 |
| 5 | 9.8 | 38 | 66 | 52 | 68.25 | 2.92 | 273 | 535.29 | 27.86 | 25 |
| 6 | 10.5 | 44 | 76 | 60 | 78.75 | 2.95 | 315 | 617.65 | 30 | 30 |
| 7 | 11.2 | 50 | 86 | 68 | 89.25 | 2.98 | 357 | 700 | 31.88 | 35 |
| 8 | 11.9 | 56 | 96 | 76 | 99.75 | 3.01 | 399 | 782.35 | 33.53 | 40 |
| 9 | 12.6 | 62 | 106 | 84 | 110.25 | 3.04 | 441 | 864.71 | 35 | 45 |
| 10 | 13.3 | 68 | 116 | 92 | 120.75 | 3.07 | 483 | 947.06 | 36.32 | 50 |
| 11 | 14 | 74 | 126 | 100 | 131.25 | 3.1 | 525 | 1029.41 | 37.5 | 55 |
| 12 | 14.7 | 80 | 136 | 108 | 141.75 | 3.13 | 567 | 1111.76 | 38.57 | 60 |
| 13 | 15.4 | 86 | 146 | 116 | 152.25 | 3.16 | 609 | 1194.12 | 39.55 | 65 |
| 14 | 16.1 | 92 | 156 | 124 | 162.75 | 3.19 | 651 | 1276.47 | 40.43 | 70 |
| 15 | 16.8 | 98 | 166 | 132 | 173.25 | 3.22 | 693 | 1358.82 | 41.25 | 75 |
| 16 | 17.5 | 104 | 176 | 140 | 183.75 | 3.25 | 735 | 1441.18 | 42 | 80 |
| 17 | 18.2 | 110 | 186 | 148 | 194.25 | 3.28 | 777 | 1523.53 | 42.69 | 85 |
| 18 | 18.9 | 116 | 196 | 156 | 204.75 | 3.31 | 819 | 1605.88 | 43.33 | 90 |
| 19 | 19.6 | 122 | 206 | 164 | 215.25 | 3.34 | 861 | 1688.24 | 43.93 | 95 |
| 20 | 20.3 | 128 | 216 | 172 | 225.75 | 3.37 | 903 | 1770.59 | 44.48 | 100 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildSpellPacket(actor, 'fireball', slvl)` once on impact |
| B7 fire | `fireMin = 14 + 6 × (slvl − 1)`, `fireMax = 26 + 10 × (slvl − 1)` |
| `ProjectileSpec` | `{ speed: 26, lifetime: 2.2, radius: 0.34, pierce: false, gravity: 0, homing: 0, maxTargets: 1 }` — it detonates on the **first** body or on lifetime expiry |
| Blast | on detonation one packet is resolved against every hostile inside `radiusOf()`, including the body it hit. Full damage at every distance — there is no falloff |
| `burning` | default seeding, `× 0.35` over 3.0 s |
| Terrain | a fireball that expires in flight detonates at its last position; one that reaches a `nav` blocker detonates against it |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| grants → | `meteor` | `flatDamage` (fire) | +5 % | +100 % |

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `burning` | `fireDealt × 0.35 / 3.0` per second | 3.0 s, fixed | default seeding; 3 stacks |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| `cast` wind-up | `uGlow` ramp, `fx.requestLight(hand, [1.0,0.5,0.2], 1.8, 4.0, 0.33)` | `spell.cast.fire` |
| entry to `active` | `fx.trail('fireball', projectileRef)` | `fireball.launch` |
| impact | `fx.elementalImpact(x,y,z,'fire',radius,power)`, `fx.decal('scorch', x, z, radius, U(0,2π), 8.0)`, `fx.requestLight` 1 slot 0.35 s | `fireball.impact` (1100 ms, 28 nodes — the most expensive routine spell voice; capped at 3 concurrent by 10 §4.2) |

**AI and monster interaction**

- The blast radius grows only 0.57 m across twenty levels. That is on purpose: `fireball` is the single-target and small-cluster answer, and `meteor` is the pack answer. Making the radius scale would collapse the two into one skill.
- Prerequisite provider: `meteor` requires **`fireball ≥ 3`** allocated.

---

### 4.4 `meteor` — Meteor / Метеор

| Field | Value |
|---|---|
| `id` | `meteor` |
| Name EN / RU | Meteor / Метеор |
| Class / tree | Emberwright / `flame` |
| Tree position | row 4, column 3 (capstone) |
| Character level | 18 |
| Prerequisite | **`fireball ≥ 3`** — three allocated points |
| `type` (`SkillDefinition`) | `ground` |
| Plain class | Active — delayed ground strike plus a lingering field |
| `target` | `point` |
| `element` | `fire` |
| Range | cursor point, no maximum beyond the camera |
| Radius / shape | impact **4.2 m**; fire pool **3.2 m** for 6.0 s |
| Cost | **16.0 mana**, `+1.20` per level (L20 = 38.8) |
| Cooldown | **4.0 s**, flat |
| Timing | `castTime 0.70 s` × `castScale 0.85` = **0.595 s**, then a fixed **1.20 s** fall. The fall is *not* scaled by `fasterCastRate` — the delay is the skill's counter-play and the player learns one number (08 §6.2) |
| Click-to-move | Ground-targeted. The impact point is frozen at the cursor position on the tick the cast completes; moving the mouse afterwards changes nothing. The Emberwright may move freely during the 1.20 s fall. |

**Twenty levels**

| L | Mana | Fire min | Fire max | Avg | Ref. impact | Pool fire /s | Ref. pool /s | Ref. pool total (6 s) | Ref. 5-target impact+pool | Dmg / mana (5 tgt) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 16 | 34 | 58 | 46 | 60.38 | 6 | 7.88 | 47.25 | 538.13 | 33.63 |
| 2 | 17.2 | 48 | 80 | 64 | 84 | 8.4 | 11.03 | 66.15 | 750.75 | 43.65 |
| 3 | 18.4 | 62 | 102 | 82 | 107.63 | 10.8 | 14.18 | 85.05 | 963.38 | 52.36 |
| 4 | 19.6 | 76 | 124 | 100 | 131.25 | 13.2 | 17.32 | 103.95 | 1176 | 60 |
| 5 | 20.8 | 90 | 146 | 118 | 154.88 | 15.6 | 20.47 | 122.85 | 1388.63 | 66.76 |
| 6 | 22 | 104 | 168 | 136 | 178.5 | 18 | 23.63 | 141.75 | 1601.25 | 72.78 |
| 7 | 23.2 | 118 | 190 | 154 | 202.13 | 20.4 | 26.77 | 160.65 | 1813.88 | 78.18 |
| 8 | 24.4 | 132 | 212 | 172 | 225.75 | 22.8 | 29.93 | 179.55 | 2026.5 | 83.05 |
| 9 | 25.6 | 146 | 234 | 190 | 249.38 | 25.2 | 33.07 | 198.45 | 2239.13 | 87.47 |
| 10 | 26.8 | 160 | 256 | 208 | 273 | 27.6 | 36.22 | 217.35 | 2451.75 | 91.48 |
| 11 | 28 | 174 | 278 | 226 | 296.63 | 30 | 39.38 | 236.25 | 2664.38 | 95.16 |
| 12 | 29.2 | 188 | 300 | 244 | 320.25 | 32.4 | 42.52 | 255.15 | 2877 | 98.53 |
| 13 | 30.4 | 202 | 322 | 262 | 343.88 | 34.8 | 45.67 | 274.05 | 3089.63 | 101.63 |
| 14 | 31.6 | 216 | 344 | 280 | 367.5 | 37.2 | 48.83 | 292.95 | 3302.25 | 104.5 |
| 15 | 32.8 | 230 | 366 | 298 | 391.13 | 39.6 | 51.98 | 311.85 | 3514.88 | 107.16 |
| 16 | 34 | 244 | 388 | 316 | 414.75 | 42 | 55.13 | 330.75 | 3727.5 | 109.63 |
| 17 | 35.2 | 258 | 410 | 334 | 438.38 | 44.4 | 58.27 | 349.65 | 3940.13 | 111.94 |
| 18 | 36.4 | 272 | 432 | 352 | 462 | 46.8 | 61.42 | 368.55 | 4152.75 | 114.09 |
| 19 | 37.6 | 286 | 454 | 370 | 485.63 | 49.2 | 64.57 | 387.45 | 4365.38 | 116.1 |
| 20 | 38.8 | 300 | 476 | 388 | 509.25 | 51.6 | 67.73 | 406.35 | 4578 | 117.99 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildSpellPacket(actor, 'meteor', slvl)` on impact, and a second, separate packet per pool tick |
| B7 fire (impact) | `fireMin = 34 + 14 × (slvl − 1)`, `fireMax = 58 + 22 × (slvl − 1)`, then `× (1 + (6 × allocated(ember_bolt) + 5 × allocated(fireball))/100)` |
| Synergy ceiling | at 20 points in each source that is `+120 % + 100 % = +220 %`, i.e. **×3.20** on the impact roll — the largest synergy multiplier in the game |
| Pool | `skills.addGroundEffect({ preset:'fire_pool', radius: 3.2, seconds: 6.0, dps: 6 + 2.4 × (slvl − 1) })`, which calls `nav.markHazard()` and deregisters on expiry |
| Pool ticks | resolved at 4 Hz as `attackRating = 0`, `dodgeable false` packets. They are **hits**, not DoT ticks — they can crit and can proc |
| `burning` | the impact seeds `burning` by the default rule. The pool does **not** — 03 §7.4 is explicit that the pool is a ground effect, not a burn |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| receives ← | `ember_bolt` | `flatDamage` (fire) | +6 % | +120 % |
| receives ← | `fireball` | `flatDamage` (fire) | +5 % | +100 % |

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `burning` | `fireDealt × 0.35 / 3.0` per second, impact only | 3.0 s | the pool applies no status |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| cast | `fx.telegraph('circle', x, z, 0, 4.2, 0, 1.795)` — the ring grows for the whole 0.595 s cast plus the 1.20 s fall | `meteor.telegraph` (1200 ms, scheduled at impact − 1.2 s) |
| fall | `fx.trail('meteor_streak', from 18 m above)` | — |
| impact | `fx.elementalImpact(x,y,z,'fire',4.2,power)`, `fx.decal('crater', x, z, 4.2, U(0,2π), 12.0)`, `fx.requestLight` 1 slot 0.5 s | `meteor.impact` (1600 ms, 38 nodes — hard-capped at 3 concurrent) |
| pool | `fx.groundEffect('fire_pool', x, z, 3.2, 6.0)` | `firepool.loop`, tracked, released on `removeGroundEffect` |

**AI and monster interaction**

- `nav.markHazard()` makes monsters path **around** the pool. That is what stops the pool from being free damage: a competent pack walks out, and the skill's real job is area denial that splits a pack into two halves the Emberwright can kill separately.
- The 4.0 s cooldown against a 6.0 s pool means two pools can overlap. Their damage does not stack per tick — an actor inside two pools takes both, resolved as two independent packets, which is intended and is the Emberwright's boss-phase burst.
- `molgrim` ignores hazards (it has `leashRadius: ∞` and a scripted pattern list); the pool is therefore full uptime on the boss and this is the single biggest reason a Flame Emberwright beats the 60–90 s target.

---

### 4.5 `incinerate` — Incinerate / Испепеление

| Field | Value |
|---|---|
| `id` | `incinerate` |
| Name EN / RU | Incinerate / Испепеление |
| Class / tree | Emberwright / `flame` |
| Tree position | row 4, column 1 (capstone) |
| Character level | 18 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `passive` |
| Plain class | Passive — a stat plus an on-kill trigger |
| `target` | `none` |
| `element` | `fire` |
| Range | — |
| Radius / shape | detonation **2.5 m** |
| Cost | none |
| Cooldown | none |
| Timing | the detonation is resolved inside R14(i) of the killing hit, on the same fixed step |
| Click-to-move | Not castable; never on the hotbar. |

**Twenty levels**

| L | `fireDamagePercent` + | Detonation % of `maxLife` | + `flame_wave` 20 → det. % | Det. vs 88-life Bone Ranker | Det. vs same, `flame_wave` 20 | `ember_bolt` L20 ref. hit with this | Damage gain on every fire hit |
|---|---|---|---|---|---|---|---|
| 1 | 12 | 25 | 45 | 22 | 39.6 | 89.19 | 9.6 % |
| 2 | 16 | 28 | 50.4 | 24.64 | 44.35 | 91.79 | 12.8 % |
| 3 | 20 | 31 | 55.8 | 27.28 | 49.1 | 94.4 | 16 % |
| 4 | 24 | 34 | 61.2 | 29.92 | 53.86 | 97 | 19.2 % |
| 5 | 28 | 37 | 66.6 | 32.56 | 58.61 | 99.6 | 22.4 % |
| 6 | 32 | 40 | 72 | 35.2 | 63.36 | 102.21 | 25.6 % |
| 7 | 36 | 43 | 77.4 | 37.84 | 68.11 | 104.81 | 28.8 % |
| 8 | 40 | 46 | 82.8 | 40.48 | 72.86 | 107.42 | 32 % |
| 9 | 44 | 49 | 88.2 | 43.12 | 77.62 | 110.02 | 35.2 % |
| 10 | 48 | 52 | 93.6 | 45.76 | 82.37 | 112.62 | 38.4 % |
| 11 | 52 | 55 | 99 | 48.4 | 87.12 | 115.23 | 41.6 % |
| 12 | 56 | 58 | 104.4 | 51.04 | 91.87 | 117.83 | 44.8 % |
| 13 | 60 | 61 | 109.8 | 53.68 | 96.62 | 120.44 | 48 % |
| 14 | 64 | 64 | 115.2 | 56.32 | 101.38 | 123.04 | 51.2 % |
| 15 | 68 | 67 | 120.6 | 58.96 | 106.13 | 125.64 | 54.4 % |
| 16 | 72 | 70 | 126 | 61.6 | 110.88 | 128.25 | 57.6 % |
| 17 | 76 | 73 | 131.4 | 64.24 | 115.63 | 130.85 | 60.8 % |
| 18 | 80 | 76 | 136.8 | 66.88 | 120.38 | 133.46 | 64 % |
| 19 | 84 | 79 | 142.2 | 69.52 | 125.14 | 136.06 | 67.2 % |
| 20 | 88 | 82 | 147.6 | 72.16 | 129.89 | 138.66 | 70.4 % |

**`DamagePacket`**

| Field | Value |
|---|---|
| Produces | a detonation packet on a fire kill, and a `sources.skills` contribution otherwise |
| Contributes | `{ fireDamagePercent: 12 + 4 × (slvl − 1) }` — `add→mul`, summed with gear fire damage and applied once at B6 |
| Trigger condition | the victim died to a packet whose **surviving** fire component was greater than zero. A kill by the physical half of a hybrid packet does not trigger it |
| Detonation packet | `fireMin = fireMax = victim.stats.maxLife × (25 + 3 × (slvl − 1) + 4 × allocated(flame_wave)) / 100`, `attackRating = 0`, `dodgeable false`, `blockable false`, radius 2.5 m |
| Chaining | **explicitly does not chain** (03 §8.3). A detonation kill sets a re-entrancy guard on the emitting step and cannot trigger another detonation. This is the anti-pattern lock — see §12 |
| `maxLife`, not current life | the coefficient reads the victim's **maximum** life, so a champion at 4.0× life produces a 4.0× bigger corpse bomb |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| receives ← | `flame_wave` | detonation damage | +4 % | +80 % |

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `burning` | the detonation seeds `burning` by the default rule on survivors | 3.0 s | and those burns can themselves kill — but a burn kill does **not** re-detonate, per the guard above |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| on detonation | `fx.elementalImpact(corpse,'fire',2.5,power)`, `fx.burst('immolate', x, y, z, 2.5)`, `fx.requestLight` 1 slot 0.3 s | `immolate.explode` (700 ms) — replaces the corpse's normal death voice, never layered with it |
| corpse | the corpse is **gibbed** rather than baked (08 §8.4) when the detonation exceeds 50 % of its `maxLife` | — |

**AI and monster interaction**

- Detonation removes the corpse, so it also removes the `dust_shaman`'s `raise_ranker` target. Killing Bone Rankers with fire is the mechanical counter to the Shaman, and this is the tree's answer to a monster the other trees have to solve by burst.
- The detonation credits the Emberwright for XP and for `magicFind` on anything it finishes.

The `fireDamagePercent` half is the reason this passive is a genuine competitor for capstone points against `meteor`: at slvl 20 it is `+88 %` on every fire number in the tree, applied through the same `add→mul` pool as gear.

---
## 5. Emberwright — Ash (`ash`)

Mobility, mana and mitigation, plus one capstone that converts the entire mana
bar into a single number. Nothing in this tree is a rotation skill; every entry
is either a passive or something pressed once per fight.

*The plan calls this tree "Cinders"; the shipped identifier is `ash` (01 §6.1).*

---

### 5.1 `ashen_step` — Ashen Step / Пепельный шаг

| Field | Value |
|---|---|
| `id` | `ashen_step` |
| Name EN / RU | Ashen Step / Пепельный шаг |
| Class / tree | Emberwright / `ash` |
| Tree position | row 1, column 1 (root) |
| Character level | 1 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `mobility` |
| Plain class | Active — instant blink, leaves a field |
| `target` | `point` |
| `element` | `fire` |
| Range | `8.0 + 0.10 × (slvl − 1)` m, hard cap **10 m** |
| Radius / shape | ash cloud **2.5 m** for **4.0 s** at the departure point |
| Cost | **6.0 mana**, `+0.40` per level (L20 = 13.6) |
| Cooldown | `3.0 − 0.06 × (slvl − 1)` s, floor **1.8 s** (L20 = 1.86 s) |
| Timing | **instant** — no `castTime`, no wind-up, no `active` window. The actor enters the `dash` animation state for 0.24 s of presentation only; the position write happens on the tick the button is read |
| Click-to-move | Blinks toward the cursor. If the cursor is beyond the range the actor lands at the maximum distance along that ray; if the landing cell is not walkable, `nav` walks the ray backwards to the last walkable cell. Never fails silently — an entirely blocked ray refuses the cast with `reason:'no-path'` and refunds nothing because nothing was spent. |

**Twenty levels**

| L | Mana | Cooldown s | Blink m | `slowed` % | Blink m /s (dist ÷ CD) | Mana /s at max rate | Cloud uptime (4 s / CD) | → `ash_wall` +fire % |
|---|---|---|---|---|---|---|---|---|
| 1 | 6 | 3 | 8 | 40 | 2.67 | 2 | 100 % | 5 |
| 2 | 6.4 | 2.94 | 8.1 | 41 | 2.76 | 2.18 | 100 % | 10 |
| 3 | 6.8 | 2.88 | 8.2 | 42 | 2.85 | 2.36 | 100 % | 15 |
| 4 | 7.2 | 2.82 | 8.3 | 43 | 2.94 | 2.55 | 100 % | 20 |
| 5 | 7.6 | 2.76 | 8.4 | 44 | 3.04 | 2.75 | 100 % | 25 |
| 6 | 8 | 2.7 | 8.5 | 45 | 3.15 | 2.96 | 100 % | 30 |
| 7 | 8.4 | 2.64 | 8.6 | 46 | 3.26 | 3.18 | 100 % | 35 |
| 8 | 8.8 | 2.58 | 8.7 | 47 | 3.37 | 3.41 | 100 % | 40 |
| 9 | 9.2 | 2.52 | 8.8 | 48 | 3.49 | 3.65 | 100 % | 45 |
| 10 | 9.6 | 2.46 | 8.9 | 49 | 3.62 | 3.9 | 100 % | 50 |
| 11 | 10 | 2.4 | 9 | 50 | 3.75 | 4.17 | 100 % | 55 |
| 12 | 10.4 | 2.34 | 9.1 | 51 | 3.89 | 4.44 | 100 % | 60 |
| 13 | 10.8 | 2.28 | 9.2 | 52 | 4.04 | 4.74 | 100 % | 65 |
| 14 | 11.2 | 2.22 | 9.3 | 53 | 4.19 | 5.05 | 100 % | 70 |
| 15 | 11.6 | 2.16 | 9.4 | 54 | 4.35 | 5.37 | 100 % | 75 |
| 16 | 12 | 2.1 | 9.5 | 55 | 4.52 | 5.71 | 100 % | 80 |
| 17 | 12.4 | 2.04 | 9.6 | 56 | 4.71 | 6.08 | 100 % | 85 |
| 18 | 12.8 | 1.98 | 9.7 | 57 | 4.9 | 6.46 | 100 % | 90 |
| 19 | 13.2 | 1.92 | 9.8 | 58 | 5.1 | 6.88 | 100 % | 95 |
| 20 | 13.6 | 1.86 | 9.9 | 59 | 5.32 | 7.31 | 100 % | 100 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Produces | no damage packet at all — this skill deals **zero** damage at every level |
| Field | `skills.addGroundEffect({ preset:'ash_cloud', radius: 2.5, seconds: 4.0, statuses: ['slowed','blinded'] })` |
| Field application | every 0.5 s the field re-applies `slowed` at magnitude `40 + 1 × (slvl − 1)` (cap 60) and `blinded` at magnitude 60 to every hostile inside it, each as an `attackRating = 0`, zero-damage packet so the riders land without a to-hit roll |
| `nav` | the cloud is **not** a hazard — it does not call `nav.markHazard()`. Monsters walk into it, which is the entire point |
| Blink | the actor is `ACTOR_FLAG.untargetable` for the 0.06 s of travel; in-flight projectiles that were homing on it lose their target and continue straight |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| grants → | `ash_wall` | `flatDamage` (fire) | +5 % | +100 % |

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `slowed` | `40 + 1 × (slvl − 1)`, capped **60** | refreshed every 0.5 s while inside, 1.0 s after leaving | max-wins; additive with `chilled` through `movementSpeed`, floored at −90 total |
| `blinded` | **60** (fixed) | 3.0 s | `attackRatingPercent −= 60` and monster perception radius × 0.35 — a blinded `ashen_archer` loses the player at 6.3 m instead of 18 m |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| departure | `fx.burst('ash_out', from, 1.0)`, `fx.groundEffect('ash_cloud', x, z, 2.5, 4.0)` | `ashstep.out` (240 ms) |
| arrival (+40 ms) | `fx.burst('ash_in', to, 1.0)` | `ashstep.in` (760 ms) |
| field | — | `ashcloud.loop`, tracked to the ground effect |
| per affected monster | — | `status.slowed` / `status.blinded`, throttled to one voice per monster per application window |

**AI and monster interaction**

- `blinded` cuts perception to 0.35× and attack rating by 60 %, so the cloud is both an escape and a disengage: a pack that loses the player re-enters its search behaviour and drifts.
- The cloud is deliberately not a `nav` hazard because a hazard would make monsters path around it and the skill would stop working. Contrast `meteor`, whose pool *is* a hazard for exactly the opposite reason.
- It is the counter to `blight_crawler`: a 60 % slow on a 4.6 m/s sprinter buys the 0.85 s its detonate wind-up needs to be walked out of.

Zero damage at every level and still worth points, because range, cooldown and slow all improve. This is the only skill in the game whose twenty levels contain no damage number at all.

---

### 5.2 `mana_weave` — Mana Weave / Мановая связь

| Field | Value |
|---|---|
| `id` | `mana_weave` |
| Name EN / RU | Mana Weave / Мановая связь |
| Class / tree | Emberwright / `ash` |
| Tree position | row 2, column 1 |
| Character level | 6 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `passive` |
| Plain class | Passive — always on |
| `target` | `none` |
| `element` | `fire` |
| Range | — |
| Radius / shape | — |
| Cost | none |
| Cooldown | none |
| Timing | none — a `sources.skills` contribution |
| Click-to-move | Not castable; never on the hotbar. |

**Twenty levels**

| L | `maxMana` + | `manaRegen` + flat /s | `damageTakenToMana` % | clvl-10 pool (108 base) | clvl-10 regen /s | clvl-30 pool (228 base) | clvl-30 regen /s | `ember_bolt` L20 casts /s funded by regen alone | → `essence_burn` +conv. % |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 12 | 0.8 | 10 | 120 | 5.6 | 240 | 10.4 | 1.54 | 4 |
| 2 | 18 | 1.15 | 11 | 126 | 6.19 | 246 | 10.99 | 1.63 | 8 |
| 3 | 24 | 1.5 | 12 | 132 | 6.78 | 252 | 11.58 | 1.72 | 12 |
| 4 | 30 | 1.85 | 13 | 138 | 7.37 | 258 | 12.17 | 1.8 | 16 |
| 5 | 36 | 2.2 | 14 | 144 | 7.96 | 264 | 12.76 | 1.89 | 20 |
| 6 | 42 | 2.55 | 15 | 150 | 8.55 | 270 | 13.35 | 1.98 | 24 |
| 7 | 48 | 2.9 | 16 | 156 | 9.14 | 276 | 13.94 | 2.07 | 28 |
| 8 | 54 | 3.25 | 17 | 162 | 9.73 | 282 | 14.53 | 2.15 | 32 |
| 9 | 60 | 3.6 | 18 | 168 | 10.32 | 288 | 15.12 | 2.24 | 36 |
| 10 | 66 | 3.95 | 19 | 174 | 10.91 | 294 | 15.71 | 2.33 | 40 |
| 11 | 72 | 4.3 | 20 | 180 | 11.5 | 300 | 16.3 | 2.41 | 44 |
| 12 | 78 | 4.65 | 21 | 186 | 12.09 | 306 | 16.89 | 2.5 | 48 |
| 13 | 84 | 5 | 22 | 192 | 12.68 | 312 | 17.48 | 2.59 | 52 |
| 14 | 90 | 5.35 | 23 | 198 | 13.27 | 318 | 18.07 | 2.68 | 56 |
| 15 | 96 | 5.7 | 24 | 204 | 13.86 | 324 | 18.66 | 2.76 | 60 |
| 16 | 102 | 6.05 | 25 | 210 | 14.45 | 330 | 19.25 | 2.85 | 64 |
| 17 | 108 | 6.4 | 26 | 216 | 15.04 | 336 | 19.84 | 2.94 | 68 |
| 18 | 114 | 6.75 | 27 | 222 | 15.63 | 342 | 20.43 | 3.03 | 72 |
| 19 | 120 | 7.1 | 28 | 228 | 16.22 | 348 | 21.02 | 3.11 | 76 |
| 20 | 126 | 7.45 | 29 | 234 | 16.81 | 354 | 21.61 | 3.2 | 80 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Produces | no packet |
| Contributes | `{ maxMana: 12 + 6 × (slvl − 1), manaRegen: 0.8 + 0.35 × (slvl − 1), damageTakenToMana: 10 + 1 × (slvl − 1) }` |
| Order | `maxMana` is a **flat** contribution inside the `derive()` parenthesis, so `manaPercent` from gear multiplies it. `manaRegen` is flat and is added *after* the `manaRegenPercent` term |
| `damageTakenToMana` | read at R14(a): `mana += ⌊total × damageTakenToMana/100⌋`, from the **post-mitigation** total, all elements. Capped at 40 in the `StatBlock`; this skill reaches 29 |
| Interaction | it does not reduce the damage taken. The Emberwright still loses the life — it gains the mana to answer with |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| grants → | `essence_burn` | mana conversion | +4 % | +80 % |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| on a `damageTakenToMana` gain | `fx.burst('mana_siphon', actor, 0.3)` at LOD 0, throttled 6 Hz | — (deliberately silent; the mana globe is the feedback) |
| passive | `ui` draws the flat regen separately in the character sheet's advanced page | — |

**AI and monster interaction**

- Against the 29.80 DPS five-monster pack of 03 §11.5, slvl 10 returns 5.66 mana/s — roughly one extra `ember_bolt` every second, funded by being hit. The tree's thesis in one number.
- It is the only mana source that is *not* blocked by `molgrim` phase III `syllable_burn` (−8 mana/s): the aura damage itself feeds it back `2 % maxLife × damageTakenToMana` per second.

---

### 5.3 `smouldering_ward` — Smouldering Ward / Тлеющий щит

| Field | Value |
|---|---|
| `id` | `smouldering_ward` |
| Name EN / RU | Smouldering Ward / Тлеющий щит |
| Class / tree | Emberwright / `ash` |
| Tree position | row 3, column 1 |
| Character level | 12 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `buff` |
| Plain class | Active — self buff with a detonating expiry |
| `target` | `self` |
| `element` | `fire` |
| Range | — |
| Radius / shape | burst **3.5 m** on break or expiry |
| Cost | **12.0 mana**, `+1.00` per level (L20 = 31) |
| Cooldown | **10.0 s**, flat |
| Timing | `castTime 0.45 s` × `castScale 0.85` = **0.3825 s** at FCR 0 |
| Click-to-move | Self-cast; the cursor is ignored. Casting while a ward is already up **refreshes** it, discarding the old pool without detonating — refreshing is not a damage rotation. |

**Twenty levels**

| L | Mana | Absorb | Burst fire | Ref. burst | Ref. 5-target burst | Absorb as % of 87 life (clvl 10) | Absorb as % of 127 life (clvl 30) | Absorb /s over 20 s uptime | Absorb per mana |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 12 | 45 | 20 | 26.25 | 131.25 | 51.72 % | 35.43 % | 2.25 | 3.75 |
| 2 | 13 | 70 | 31 | 40.69 | 203.44 | 80.46 % | 55.12 % | 3.5 | 5.38 |
| 3 | 14 | 95 | 42 | 55.13 | 275.63 | 109.2 % | 74.8 % | 4.75 | 6.79 |
| 4 | 15 | 120 | 53 | 69.56 | 347.81 | 137.93 % | 94.49 % | 6 | 8 |
| 5 | 16 | 145 | 64 | 84 | 420 | 166.67 % | 114.17 % | 7.25 | 9.06 |
| 6 | 17 | 170 | 75 | 98.44 | 492.19 | 195.4 % | 133.86 % | 8.5 | 10 |
| 7 | 18 | 195 | 86 | 112.88 | 564.38 | 224.14 % | 153.54 % | 9.75 | 10.83 |
| 8 | 19 | 220 | 97 | 127.31 | 636.56 | 252.87 % | 173.23 % | 11 | 11.58 |
| 9 | 20 | 245 | 108 | 141.75 | 708.75 | 281.61 % | 192.91 % | 12.25 | 12.25 |
| 10 | 21 | 270 | 119 | 156.19 | 780.94 | 310.34 % | 212.6 % | 13.5 | 12.86 |
| 11 | 22 | 295 | 130 | 170.63 | 853.13 | 339.08 % | 232.28 % | 14.75 | 13.41 |
| 12 | 23 | 320 | 141 | 185.06 | 925.31 | 367.82 % | 251.97 % | 16 | 13.91 |
| 13 | 24 | 345 | 152 | 199.5 | 997.5 | 396.55 % | 271.65 % | 17.25 | 14.38 |
| 14 | 25 | 370 | 163 | 213.94 | 1069.69 | 425.29 % | 291.34 % | 18.5 | 14.8 |
| 15 | 26 | 395 | 174 | 228.38 | 1141.88 | 454.02 % | 311.02 % | 19.75 | 15.19 |
| 16 | 27 | 420 | 185 | 242.81 | 1214.06 | 482.76 % | 330.71 % | 21 | 15.56 |
| 17 | 28 | 445 | 196 | 257.25 | 1286.25 | 511.49 % | 350.39 % | 22.25 | 15.89 |
| 18 | 29 | 470 | 207 | 271.69 | 1358.44 | 540.23 % | 370.08 % | 23.5 | 16.21 |
| 19 | 30 | 495 | 218 | 286.13 | 1430.63 | 568.97 % | 389.76 % | 24.75 | 16.5 |
| 20 | 31 | 520 | 229 | 300.56 | 1502.81 | 597.7 % | 409.45 % | 26 | 16.77 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Produces | no packet on cast; one nova packet on break or expiry |
| Buff | `skills.applyBuff(actor, 'smouldering_ward', slvl, 20.0)` with an absorb pool of `45 + 25 × (slvl − 1)` |
| Absorb semantics | consumed at R13 before `life -= total`, across every element. Shares the pool ordering with `last_stand`: absorb pools are consumed **oldest first** |
| Burst packet | `fireMin = fireMax = 20 + 11 × (slvl − 1)`, radius 3.5 m, `attackRating = 0`, `dodgeable false`, `blockable false`, `spellScale 1.00` |
| Trigger | fires on **either** the pool reaching 0 **or** the 20 s expiry — never on a re-cast |
| `burning` | the burst seeds `burning` by the default rule |

**Synergies**

None in either direction.

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `burning` | burst only, `fireDealt × 0.35 / 3.0` per second | 3.0 s | default seeding |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| cast | `fx.trail('ward_shell', actorRef)` — a 0.9 m translucent shell whose opacity tracks the remaining pool | `embershield.on` (620 ms) |
| break / expiry | `fx.elementalImpact(actor,'fire',3.5,power)`, `fx.endTrail(handle)` | `embershield.break` (900 ms, 26 nodes) |

**AI and monster interaction**

- Twenty seconds of duration against a ten-second cooldown gives **100 % uptime**, so the real decision is whether to hold the cast until the pool will actually be spent — a ward that expires unbroken still detonates, so there is no wasted cast, only a mistimed one.
- The burst is centred on the Emberwright, so the skill rewards being surrounded. Against a pack that has already closed, a slvl-12 ward absorbs 320 and returns 151 fire to five bodies.

---

### 5.4 `ash_wall` — Ash Wall / Стена пепла

| Field | Value |
|---|---|
| `id` | `ash_wall` |
| Name EN / RU | Ash Wall / Стена пепла |
| Class / tree | Emberwright / `ash` |
| Tree position | row 3, column 3 |
| Character level | 12 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `ground` |
| Plain class | Active — placed terrain |
| `target` | `point` |
| `element` | `fire` |
| Range | placed at the cursor, up to 12 m from the caster |
| Radius / shape | a **6.0 m** line, oriented perpendicular to the caster→cursor ray, damaging within **0.8 m** of it, for **8.0 s** |
| Cost | **14.0 mana**, `+1.10` per level (L20 = 34.9) |
| Cooldown | **12.0 s**, flat |
| Timing | `castTime 0.55 s` × `castScale 0.85` = **0.4675 s** at FCR 0 |
| Click-to-move | Ground-targeted, and the only skill in the game whose *orientation* is derived from the click: the wall is laid across the caster→cursor line so that clicking at an approaching pack always produces a wall between the Emberwright and it. Placement snaps to `nav` — segments over unwalkable cells are simply not created. |

**Twenty levels**

| L | Mana | Fire /s | Ref. fire /s | + `ashen_step` 20 → /s | Ref. total, 1 body, 8 s | Ref. total, 3 bodies, 8 s | Uptime (8 s / 12 s CD) | Dmg / mana (3 bodies) |
|---|---|---|---|---|---|---|---|---|
| 1 | 14 | 8 | 10.5 | 21 | 84 | 252 | 66.7 % | 18 |
| 2 | 15.1 | 11.4 | 14.96 | 29.93 | 119.7 | 359.1 | 66.7 % | 23.78 |
| 3 | 16.2 | 14.8 | 19.43 | 38.85 | 155.4 | 466.2 | 66.7 % | 28.78 |
| 4 | 17.3 | 18.2 | 23.89 | 47.77 | 191.1 | 573.3 | 66.7 % | 33.14 |
| 5 | 18.4 | 21.6 | 28.35 | 56.7 | 226.8 | 680.4 | 66.7 % | 36.98 |
| 6 | 19.5 | 25 | 32.81 | 65.63 | 262.5 | 787.5 | 66.7 % | 40.38 |
| 7 | 20.6 | 28.4 | 37.27 | 74.55 | 298.2 | 894.6 | 66.7 % | 43.43 |
| 8 | 21.7 | 31.8 | 41.74 | 83.48 | 333.9 | 1001.7 | 66.7 % | 46.16 |
| 9 | 22.8 | 35.2 | 46.2 | 92.4 | 369.6 | 1108.8 | 66.7 % | 48.63 |
| 10 | 23.9 | 38.6 | 50.66 | 101.32 | 405.3 | 1215.9 | 66.7 % | 50.87 |
| 11 | 25 | 42 | 55.13 | 110.25 | 441 | 1323 | 66.7 % | 52.92 |
| 12 | 26.1 | 45.4 | 59.59 | 119.17 | 476.7 | 1430.1 | 66.7 % | 54.79 |
| 13 | 27.2 | 48.8 | 64.05 | 128.1 | 512.4 | 1537.2 | 66.7 % | 56.51 |
| 14 | 28.3 | 52.2 | 68.51 | 137.02 | 548.1 | 1644.3 | 66.7 % | 58.1 |
| 15 | 29.4 | 55.6 | 72.98 | 145.95 | 583.8 | 1751.4 | 66.7 % | 59.57 |
| 16 | 30.5 | 59 | 77.44 | 154.88 | 619.5 | 1858.5 | 66.7 % | 60.93 |
| 17 | 31.6 | 62.4 | 81.9 | 163.8 | 655.2 | 1965.6 | 66.7 % | 62.2 |
| 18 | 32.7 | 65.8 | 86.36 | 172.72 | 690.9 | 2072.7 | 66.7 % | 63.39 |
| 19 | 33.8 | 69.2 | 90.82 | 181.65 | 726.6 | 2179.8 | 66.7 % | 64.49 |
| 20 | 34.9 | 72.6 | 95.29 | 190.57 | 762.3 | 2286.9 | 66.7 % | 65.53 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Produces | one `attackRating = 0` packet per 0.25 s tick against everything within 0.8 m of the line |
| B7 fire | `fireMin = fireMax = (8 + 3.4 × (slvl − 1)) × 0.25` per tick, i.e. the table figure is per **second**, and `× (1 + 5 × allocated(ashen_step)/100)` |
| Ground effect | `skills.addGroundEffect({ preset:'ash_wall', shape:'line', length: 6.0, thickness: 1.6, seconds: 8.0 })` → `nav.markHazard()` along the line |
| Projectile blocking | the wall consumes **enemy** projectiles on contact: `ash_shot`, `molgrim`'s ring segments and every monster projectile end at it. Player projectiles pass through freely |
| Not a collider | monsters may still walk through the wall — it is a hazard, not a physics blocker, so `nav` routes them around it but a leashed or scripted monster crosses and burns |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| receives ← | `ashen_step` | `flatDamage` (fire) | +5 % | +100 % |

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `burning` | ticks seed `burning` at the default rate; three ticks will hold three stacks on anything standing in it | 3.0 s | stacks refresh continuously while a body is inside |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| cast | `fx.telegraph('line', x, z, facing, 6.0, 1.6, 0.30)` | `ashwall.raise` (900 ms) |
| active | `fx.groundEffect('ash_wall', …)` — 12 emitter points along the line, one `fx.requestLight` slot for the whole wall | `ashwall.loop`, tracked |
| projectile absorbed | `fx.burst('ash_absorb', point, 0.5)` | `melee.hit.ash` at 0.6 gain |
| expiry | `fx.endGroundEffect(handle)` | `ashwall.raise` reversed at 0.7 gain |

**AI and monster interaction**

- This is the hard counter to `ashen_archer` (14 m range, kites) and to `molgrim` phase II `ember_rings`. It converts a ranged fight into a melee one on the Emberwright's terms.
- Because it calls `nav.markHazard()`, a wall laid across a corridor forces the pack to funnel around its ends — the deliberate pack-splitting tool the tree provides, and the reason `meteor` and `ash_wall` in the same build is a real strategy rather than redundancy.
- Two walls can be up at once only if the first expires within the 12 s cooldown, which it cannot. One wall at a time, by construction.

---

### 5.5 `essence_burn` — Essence Burn / Сожжение сущности

| Field | Value |
|---|---|
| `id` | `essence_burn` |
| Name EN / RU | Essence Burn / Сожжение сущности |
| Class / tree | Emberwright / `ash` |
| Tree position | row 4, column 2 (capstone) |
| Character level | 18 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `nova` |
| Plain class | Active — consumes the entire mana pool |
| `target` | `self` |
| `element` | `fire` |
| Range | self-centred |
| Radius / shape | `5.0 + 0.05 × (slvl − 1)` m (L20 = 5.95 m) |
| Cost | **all current mana**, minimum **20**. `manaCostReduction` has no effect — the cost is not a number, it is the pool |
| Cooldown | **8.0 s**, flat |
| Timing | `castTime 0.80 s` × `castScale 0.85` = **0.68 s** at FCR 0. Mana is deducted at the **end** of the cast, so an interruption costs nothing |
| Click-to-move | Self-cast, cursor ignored. Refused with `reason:'resource'` below 20 mana. The mana bar is drained to zero on the tick the cast completes — `ui` must show the pending drain during the wind-up or the skill reads as a bug. |

**Twenty levels**

| L | Min mana | Multiplier | + `mana_weave` 20 → | Radius m | Damage at 100 mana | Ref. dmg at 108 mana | Ref. dmg at 248 mana (clvl 30) | Ref. 6-target burst @ 248 | Damage per mana spent |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 20 | 1.1 | 1.98 | 5 | 110 | 155.93 | 358.05 | 2148.3 | 1.44 |
| 2 | 20 | 1.24 | 2.23 | 5.05 | 124 | 175.77 | 403.62 | 2421.72 | 1.63 |
| 3 | 20 | 1.38 | 2.48 | 5.1 | 138 | 195.62 | 449.19 | 2695.14 | 1.81 |
| 4 | 20 | 1.52 | 2.74 | 5.15 | 152 | 215.46 | 494.76 | 2968.56 | 2 |
| 5 | 20 | 1.66 | 2.99 | 5.2 | 166 | 235.31 | 540.33 | 3241.98 | 2.18 |
| 6 | 20 | 1.8 | 3.24 | 5.25 | 180 | 255.15 | 585.9 | 3515.4 | 2.36 |
| 7 | 20 | 1.94 | 3.49 | 5.3 | 194 | 275 | 631.47 | 3788.82 | 2.55 |
| 8 | 20 | 2.08 | 3.74 | 5.35 | 208 | 294.84 | 677.04 | 4062.24 | 2.73 |
| 9 | 20 | 2.22 | 4 | 5.4 | 222 | 314.69 | 722.61 | 4335.66 | 2.91 |
| 10 | 20 | 2.36 | 4.25 | 5.45 | 236 | 334.53 | 768.18 | 4609.08 | 3.1 |
| 11 | 20 | 2.5 | 4.5 | 5.5 | 250 | 354.38 | 813.75 | 4882.5 | 3.28 |
| 12 | 20 | 2.64 | 4.75 | 5.55 | 264 | 374.22 | 859.32 | 5155.92 | 3.47 |
| 13 | 20 | 2.78 | 5 | 5.6 | 278 | 394.06 | 904.89 | 5429.34 | 3.65 |
| 14 | 20 | 2.92 | 5.26 | 5.65 | 292 | 413.91 | 950.46 | 5702.76 | 3.83 |
| 15 | 20 | 3.06 | 5.51 | 5.7 | 306 | 433.76 | 996.03 | 5976.18 | 4.02 |
| 16 | 20 | 3.2 | 5.76 | 5.75 | 320 | 453.6 | 1041.6 | 6249.6 | 4.2 |
| 17 | 20 | 3.34 | 6.01 | 5.8 | 334 | 473.45 | 1087.17 | 6523.02 | 4.38 |
| 18 | 20 | 3.48 | 6.26 | 5.85 | 348 | 493.29 | 1132.74 | 6796.44 | 4.57 |
| 19 | 20 | 3.62 | 6.52 | 5.9 | 362 | 513.13 | 1178.31 | 7069.86 | 4.75 |
| 20 | 20 | 3.76 | 6.77 | 5.95 | 376 | 532.98 | 1223.88 | 7343.28 | 4.94 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildSpellPacket(actor, 'essence_burn', slvl)` with `flatDamage` computed at cast time from `actor.mana` |
| B7 fire | `fireMin = fireMax = spentMana × (1.10 + 0.14 × (slvl − 1)) × (1 + 4 × allocated(mana_weave)/100)` |
| No roll | min equals max — `essence_burn` never rolls a range. It can still crit at R6 |
| B8 riders | `attackRating = 0`, **`dodgeable false`** (03 §5.2 names this skill explicitly), `blockable false` |
| Worked (03 §8.4) | 100 mana at slvl 5 → `100 × (1.10 + 0.56) = 166` fire before resistance; slvl 1 → 110; slvl 20 → 376 |
| `burning` | default seeding — 35 % of a very large number over 3 s, which on a 376-point hit is 43.9 burn per second |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| receives ← | `mana_weave` | mana conversion | +4 % | +80 % |

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `burning` | `fireDealt × 0.35 / 3.0` per second | 3.0 s | default seeding; on a full-pool burn this is the largest burn in the game |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| `cast` wind-up (0.442 s) | `fx.trail('essence_gather', actorRef)` — the mana globe visibly drains into the caster, `fx.requestLight(actor, [1.0,0.6,0.25], ramp 0→4.0, 6.0, 0.68)` | `spell.cast.ash` |
| `active` | `fx.elementalImpact(actor,'fire',radius,power)`, `fx.burst('essence_nova', x, y, z, radius)`, `fx.decal('scorch_ring', x, z, radius, 0, 10.0)` | `manaburn.release` (1300 ms) |

**AI and monster interaction**

- The 8 s cooldown is not the real limiter — the mana pool is. At clvl 30 with `mana_weave` 20 the pool is 354 and refills at 15.6 mana/s, so a full-value re-cast is **22.7 s** away, not 8.
- The skill is the Emberwright's answer to being surrounded, and it is the only player skill that ignores dodge outright, so the `dodgeChance` affix cannot save a champion pack from it.

This is the highest single-hit number any class can produce, and it is balanced by leaving the caster at zero mana — with 40 life at clvl 1 and 127 at clvl 30, an Emberwright at zero mana is a corpse with a walk animation.

---
## 6. Runeblade — Enchanted Blade (`enchanted_blade`)

The melee half of the mana loop. `rune_strike` pays for `blade_seal`,
`blade_seal` pays `cascade`, and the two capstones spend what is left. This is
the only tree in the game with **two** level-1 skills, because the class loop
does not exist until both halves are on the hotbar.

*The plan calls this tree "Runic Edge"; the shipped identifier is
`enchanted_blade` (01 §6.1).*

---

### 6.1 `rune_strike` — Rune Strike / Рунный удар

| Field | Value |
|---|---|
| `id` | `rune_strike` |
| Name EN / RU | Rune Strike / Рунный удар |
| Class / tree | Runeblade / `enchanted_blade` |
| Tree position | row 1, column 1 (root) |
| Character level | 1 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `attack` |
| Plain class | Active — weapon attack, single target |
| `target` | `actor` |
| `element` | `physical` |
| Range | weapon range |
| Radius / shape | single target |
| Cost | **2.0 mana**, `+0.20` per level (L20 = 5.8). Reduced by `manaCostReduction`, floored at 1 |
| Cooldown | none |
| Timing | `attackScale 1.00` — Rune Sword at IAS 0: **0.650 s** |
| Click-to-move | Needs a hostile actor under the cursor. Out of range the actor walks in and swings, exactly like a basic attack. Holding repeats while mana lasts — and because the strike returns more mana than it costs against anything with meaningful life, holding it is the class's idle state. |

**Twenty levels**

| L | Mana | Weapon dmg % | Ref. hit | Ref. phys after DR 1 | Mana returned @ 16 % (base ×2) | Net mana per swing | Resonance per swing | → `cascade` +wd % |
|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 115 | 27.1 | 26.1 | 4.18 | 2.18 | 1 (class base) | 7 |
| 2 | 2.2 | 122 | 28.75 | 27.75 | 4.44 | 2.24 | 1 (class base) | 14 |
| 3 | 2.4 | 129 | 30.4 | 29.4 | 4.7 | 2.3 | 1 (class base) | 21 |
| 4 | 2.6 | 136 | 32.05 | 31.05 | 4.97 | 2.37 | 1 (class base) | 28 |
| 5 | 2.8 | 143 | 33.7 | 32.7 | 5.23 | 2.43 | 1 (class base) | 35 |
| 6 | 3 | 150 | 35.35 | 34.35 | 5.5 | 2.5 | 1 (class base) | 42 |
| 7 | 3.2 | 157 | 37 | 36 | 5.76 | 2.56 | 1 (class base) | 49 |
| 8 | 3.4 | 164 | 38.65 | 37.65 | 6.02 | 2.62 | 1 (class base) | 56 |
| 9 | 3.6 | 171 | 40.3 | 39.3 | 6.29 | 2.69 | 1 (class base) | 63 |
| 10 | 3.8 | 178 | 41.95 | 40.95 | 6.55 | 2.75 | 1 (class base) | 70 |
| 11 | 4 | 185 | 43.6 | 42.6 | 6.82 | 2.82 | 1 (class base) | 77 |
| 12 | 4.2 | 192 | 45.25 | 44.25 | 7.08 | 2.88 | 1 (class base) | 84 |
| 13 | 4.4 | 199 | 46.9 | 45.9 | 7.34 | 2.94 | 1 (class base) | 91 |
| 14 | 4.6 | 206 | 48.55 | 47.55 | 7.61 | 3.01 | 1 (class base) | 98 |
| 15 | 4.8 | 213 | 50.2 | 49.2 | 7.87 | 3.07 | 1 (class base) | 105 |
| 16 | 5 | 220 | 51.84 | 50.84 | 8.14 | 3.14 | 1 (class base) | 112 |
| 17 | 5.2 | 227 | 53.49 | 52.49 | 8.4 | 3.2 | 1 (class base) | 119 |
| 18 | 5.4 | 234 | 55.14 | 54.14 | 8.66 | 3.26 | 1 (class base) | 126 |
| 19 | 5.6 | 241 | 56.79 | 55.79 | 8.93 | 3.33 | 1 (class base) | 133 |
| 20 | 5.8 | 248 | 58.44 | 57.44 | 9.19 | 3.39 | 1 (class base) | 140 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildAttackPacket(actor, 'rune_strike', slvl)` |
| B2 coefficient | `weaponDamage = 115 + 7 × (slvl − 1)` |
| B5 / B6 | attribute bonus, then `× meleeScale 0.95` |
| B8 riders | `manaReturnPercent` **doubled for this hit** — the class base 8 becomes 16, and `resonance_circuit`'s contribution is doubled with it |
| Resonance | `+1` from the standard landed-hit rule and nothing more (03 §2.4). This skill's Resonance advantage is not a bigger charge — it is that its doubled mana return lets the Runeblade keep swinging, and every swing is a charge |
| Mana return | `manaReturned = physicalDamageDealt × manaReturnPercent / 100`, computed at R14(d) from the **post-mitigation physical** figure. A blocked or missed hit returns nothing |
| Imbue | a Rune Strike consumes one `blade_seal` charge like any other weapon hit, and counts as an "empowered hit" for `cascade` on its own even without an imbue |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| grants → | `cascade` | `weaponDamage` | +7 % | +140 % |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| `attack.windup` | `uGlow` ramp on the blade's glow-masked vertices, 0 → 1.4 | — |
| `attack.active` | `fx.trail('rune_arc', actorRef)` | `runestrike` (420 ms) |
| on resolve | `fx.impact(...)`, plus `fx.burst('mana_return', target → actor, 0.5)` scaled by the returned amount | `melee.hit.<surface>` |
| Resonance pip gained | `ui` pip fill | `resonance.charge` at pitch `73.42 × n` Hz for pip *n* |

**AI and monster interaction**

- Doubling the return makes this the skill that refills the bar; against a 611-life Renunciation Bone Ranker the Runeblade recovers 16 % of everything it deals, which at the level-30 reference kit is about 13 mana per swing against a 5.8 cost.
- It generates one Resonance per landed swing like any other weapon hit, so `maxResonance 3` fills in three landed hits — which is exactly the number of hits a three-charge `blade_seal` imbues. The bar is a counter of the imbue window, and the recast lands on the swing after the last imbued one.

---

### 6.2 `blade_seal` — Blade Seal / Печать клинка

| Field | Value |
|---|---|
| `id` | `blade_seal` |
| Name EN / RU | Blade Seal / Печать клинка |
| Class / tree | Runeblade / `enchanted_blade` |
| Tree position | row 1, column 3 (root) |
| Character level | 1 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `buff` |
| Plain class | Active — weapon imbue, spends the whole Resonance bar |
| `target` | `self` |
| `element` | `fire / cold / lightning — cycled on each re-cast, in that order` |
| Range | — |
| Radius / shape | — |
| Cost | **5.0 mana**, `+0.35` per level (L20 = 11.65), **plus every Resonance charge held**. Requires `resonance ≥ 1`; refused with `reason:'resonance'` below that. The spend is `floor(resonance)`, the fractional remainder from `resonanceOnHit` survives the cast, and the number of hits imbued is a function of skill level alone — spending four charges does not buy a fourth hit (03 §2.4) |
| Cooldown | none |
| Timing | `castTime 0.25 s` × `castScale 1.00` = **0.25 s** at FCR 0 (03 E6.10 shows 0.2174 s at 15 % FCR) |
| Click-to-move | Self-cast, cursor ignored, no movement. Because the cast is a quarter of a second and the class fights in melee, the intended binding is a hotbar key rather than RMB. |

**Twenty levels**

| L | Mana | Resonance spent | Imbue min | Imbue max | Avg | Ref. added per hit | Hits imbued | Ref. total per seal | Ref. dmg per mana | → `phase_leap` +wd % |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 5 | all (3 at a matched bar) | 2 | 7 | 4.5 | 4.49 | 3 | 13.47 | 2.69 | 5 |
| 2 | 5.35 | all (3 at a matched bar) | 4.5 | 11.5 | 8 | 7.98 | 3 | 23.94 | 4.47 | 10 |
| 3 | 5.7 | all (3 at a matched bar) | 7 | 16 | 11.5 | 11.47 | 3 | 34.41 | 6.04 | 15 |
| 4 | 6.05 | all (3 at a matched bar) | 9.5 | 20.5 | 15 | 14.96 | 3 | 44.89 | 7.42 | 20 |
| 5 | 6.4 | all (3 at a matched bar) | 12 | 25 | 18.5 | 18.45 | 3 | 55.36 | 8.65 | 25 |
| 6 | 6.75 | all (3 at a matched bar) | 14.5 | 29.5 | 22 | 21.95 | 3 | 65.84 | 9.75 | 30 |
| 7 | 7.1 | all (3 at a matched bar) | 17 | 34 | 25.5 | 25.44 | 3 | 76.31 | 10.75 | 35 |
| 8 | 7.45 | all (4 at a matched bar) | 19.5 | 38.5 | 29 | 28.93 | 4 | 115.71 | 15.53 | 40 |
| 9 | 7.8 | all (4 at a matched bar) | 22 | 43 | 32.5 | 32.42 | 4 | 129.68 | 16.63 | 45 |
| 10 | 8.15 | all (4 at a matched bar) | 24.5 | 47.5 | 36 | 35.91 | 4 | 143.64 | 17.62 | 50 |
| 11 | 8.5 | all (4 at a matched bar) | 27 | 52 | 39.5 | 39.4 | 4 | 157.61 | 18.54 | 55 |
| 12 | 8.85 | all (4 at a matched bar) | 29.5 | 56.5 | 43 | 42.89 | 4 | 171.57 | 19.39 | 60 |
| 13 | 9.2 | all (4 at a matched bar) | 32 | 61 | 46.5 | 46.38 | 4 | 185.53 | 20.17 | 65 |
| 14 | 9.55 | all (4 at a matched bar) | 34.5 | 65.5 | 50 | 49.88 | 4 | 199.5 | 20.89 | 70 |
| 15 | 9.9 | all (5 at a matched bar) | 37 | 70 | 53.5 | 53.37 | 5 | 266.83 | 26.95 | 75 |
| 16 | 10.25 | all (5 at a matched bar) | 39.5 | 74.5 | 57 | 56.86 | 5 | 284.29 | 27.74 | 80 |
| 17 | 10.6 | all (5 at a matched bar) | 42 | 79 | 60.5 | 60.35 | 5 | 301.74 | 28.47 | 85 |
| 18 | 10.95 | all (5 at a matched bar) | 44.5 | 83.5 | 64 | 63.84 | 5 | 319.2 | 29.15 | 90 |
| 19 | 11.3 | all (5 at a matched bar) | 47 | 88 | 67.5 | 67.33 | 5 | 336.66 | 29.79 | 95 |
| 20 | 11.65 | all (5 at a matched bar) | 49.5 | 92.5 | 71 | 70.82 | 5 | 354.11 | 30.4 | 100 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Produces | no packet of its own. It writes imbue state that the **next N weapon hits** carry |
| Imbue | each imbued hit adds `elementMin = 2 + 2.5 × (slvl − 1)`, `elementMax = 7 + 4.5 × (slvl − 1)` of the selected element at B7, and the whole component takes `× spellScale 0.95` at B6 |
| Charges | **3** hits, **4** from effective level 8, **5** from effective level 15. `skills.imbueRemaining(actor)` reports what is left |
| Element cycle | each cast advances fire → cold → lightning → fire. `skills.imbueElement(actor)` reports the current one (**requested API**, see the additions section) |
| Consumption | a charge is spent on a **landed** weapon hit only. A miss, a dodge and a block all leave the charge intact; a block still consumes nothing because no damage was dealt |
| Refresh | re-casting replaces the remaining charges rather than adding to them, and always empties the Resonance bar. Re-sealing early is therefore a real cost — it throws away both the unspent imbue charges and every charge on the bar |
| Status riders | cold imbues feed `chillPoints` at magnitude 30 per hit (03 §7.3) — 5 imbued hits at a 0.65 s cadence reach 100 and **freeze**. Fire imbues seed `burning`. Lightning imbues carry no rider on their own |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| grants → | `phase_leap` | `weaponDamage` | +5 % | +100 % |

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `chilled` → `frozen` | magnitude 30 per cold-imbued hit | `2.0 s + coldDuration`; freeze at 100 chill points | at the 0.650 s Runeblade cadence, **7 cold hits** freeze (03 E8.1); with 25 % IAS it is 5 |
| `burning` | `fireDealt × 0.35 / 3.0` per second on a fire imbue | 3.0 s | default seeding, 3 stacks |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| `cast` | `fx.burst('seal_ring', actor, 1.0)`; blade `uGlow` set to the element colour for the imbue's life | `resonance.seal` (520 ms). At 5 Resonance held, `resonance.discharge` (1100 ms) replaces it |
| per imbued hit | `fx.elementalImpact(point, element, 0.5, power)` | element impact at 0.5 gain — `firebolt.impact` / `ice.impact` / `lightning.arc` |
| last charge spent | blade `uGlow` returns to 0 over 0.2 s | — |

**AI and monster interaction**

- The cold cycle is the class's only crowd control: a 1.20 s freeze on a `maulsmith` mid-telegraph removes a `crushing_slam` outright.
- The lightning cycle is the one that pairs with `polarity: storm` and with `thunder_step`; the fire cycle is the one that survives `molgrim`'s 50 cold resist worst.
- Against a boss the imbue is a flat add per hit, so its value falls as weapon damage rises — which is why `blade_seal`'s late points are usually bought for the `phase_leap` synergy rather than for the imbue.
- The imbue count and `maxResonance` are meant to be read together. At slvl 1–7 a three-charge seal is paid for by the three hits it imbues, and the bar cycles 0 → 3 → 0 with nothing wasted. Past effective level 8 the window widens to 4 and past 15 to 5, and a bar that has not widened with it (`resonance_circuit`) discards the surplus — 25 % and 40 % respectively. §12.5 carries the table.

---

### 6.3 `cascade` — Cascade / Каскад

| Field | Value |
|---|---|
| `id` | `cascade` |
| Name EN / RU | Cascade / Каскад |
| Class / tree | Runeblade / `enchanted_blade` |
| Tree position | row 2, column 2 |
| Character level | 6 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `passive` |
| Plain class | Passive trigger — fires itself on a counter |
| `target` | `none` |
| `element` | `magic` |
| Range | self-centred |
| Radius / shape | **4.5 m**, full 360° |
| Cost | none |
| Cooldown | none — gated by the three-hit counter instead |
| Timing | resolved on the same fixed step as the third empowered hit, inside its `active` window. It costs no animation state |
| Click-to-move | Never castable. `ui` shows the 0–3 counter next to the Resonance pips. |

**Twenty levels**

| L | Weapon dmg % (magic) | + `rune_strike` 20 → | Ref. wave | Ref. wave + synergy | Ref. 5-target wave | Ref. 5-target + synergy | Waves per 10 s at 0.65 s cadence | Added DPS, 5 tgt, + synergy |
|---|---|---|---|---|---|---|---|---|
| 1 | 70 | 210 | 16.5 | 49.49 | 82.48 | 247.44 | 5.1 | 126.89 |
| 2 | 76 | 216 | 17.91 | 50.9 | 89.55 | 254.51 | 5.1 | 130.52 |
| 3 | 82 | 222 | 19.32 | 52.32 | 96.62 | 261.58 | 5.1 | 134.14 |
| 4 | 88 | 228 | 20.74 | 53.73 | 103.69 | 268.65 | 5.1 | 137.77 |
| 5 | 94 | 234 | 22.15 | 55.14 | 110.76 | 275.72 | 5.1 | 141.4 |
| 6 | 100 | 240 | 23.57 | 56.56 | 117.83 | 282.79 | 5.1 | 145.02 |
| 7 | 106 | 246 | 24.98 | 57.97 | 124.9 | 289.86 | 5.1 | 148.65 |
| 8 | 112 | 252 | 26.39 | 59.39 | 131.97 | 296.93 | 5.1 | 152.27 |
| 9 | 118 | 258 | 27.81 | 60.8 | 139.04 | 304 | 5.1 | 155.9 |
| 10 | 124 | 264 | 29.22 | 62.21 | 146.11 | 311.07 | 5.1 | 159.52 |
| 11 | 130 | 270 | 30.64 | 63.63 | 153.18 | 318.14 | 5.1 | 163.15 |
| 12 | 136 | 276 | 32.05 | 65.04 | 160.25 | 325.21 | 5.1 | 166.77 |
| 13 | 142 | 282 | 33.46 | 66.46 | 167.32 | 332.28 | 5.1 | 170.4 |
| 14 | 148 | 288 | 34.88 | 67.87 | 174.39 | 339.35 | 5.1 | 174.03 |
| 15 | 154 | 294 | 36.29 | 69.28 | 181.46 | 346.42 | 5.1 | 177.65 |
| 16 | 160 | 300 | 37.71 | 70.7 | 188.53 | 353.49 | 5.1 | 181.28 |
| 17 | 166 | 306 | 39.12 | 72.11 | 195.6 | 360.56 | 5.1 | 184.9 |
| 18 | 172 | 312 | 40.53 | 73.53 | 202.67 | 367.63 | 5.1 | 188.53 |
| 19 | 178 | 318 | 41.95 | 74.94 | 209.74 | 374.7 | 5.1 | 192.15 |
| 20 | 184 | 324 | 43.36 | 76.35 | 216.81 | 381.77 | 5.1 | 195.78 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildAttackPacket(actor, 'cascade', slvl)`, then the physical component is re-typed to `magic` at B7 |
| B2 coefficient | `weaponDamage = 70 + 6 × (slvl − 1) + 7 × allocated(rune_strike)` |
| B5 | the attribute bonus **is** applied — the coefficient is taken off the weapon's physical line before the element is re-typed. See the readings note in §1.6 |
| B6 | `× meleeScale 0.95` (weapon-derived), then `× (1 + magicDamagePercent/100) × (1 + elementalDamagePercent/100)` |
| Element | `magic` — neither blocked by armour nor walled off by an elemental immunity (01 §1.1). Nothing in the bestiary is magic-immune; `molgrim` at 40 base reaches 80 in Renunciation, clamped to 75 |
| Counter | an **empowered hit** is a landed `rune_strike` **or** a landed hit carrying a `blade_seal` imbue. A hit that is both counts once. The counter is per-actor, resets on zone change, and does not decay |
| B8 riders | `attackRating = 0` — the wave always hits. `dodgeable false`, `blockable false` |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| receives ← | `rune_strike` | `weaponDamage` | +7 % | +140 % |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| on trigger | `fx.burst('cascade_wave', x, y, z, 4.5)` — an expanding ring, `fx.requestLight(actor, [0.55,0.6,1.0], 2.0, 6.0, 0.35)` | `cascade.wave` (620 ms) |
| counter at 2/3 | `ui` pip pulse | — (deliberately silent; a tick per hit would machine-gun) |

**AI and monster interaction**

- The wave is the Runeblade's only reliable area damage before level 12, and its trigger condition forces the class loop: three empowered hits means either three Rune Strikes (6 mana) or one Blade Seal plus three swings.
- Because it is `magic`, it is the class's answer to the `burning` / `charged` / `frostbound` immunity affixes (03 §9.4) — none of which grant magic immunity.
- It cannot crit-chain into itself; the wave is not an empowered hit and never advances its own counter.

---

### 6.4 `phase_leap` — Phase Leap / Скачок фазы

| Field | Value |
|---|---|
| `id` | `phase_leap` |
| Name EN / RU | Phase Leap / Скачок фазы |
| Class / tree | Runeblade / `enchanted_blade` |
| Tree position | row 3, column 2 |
| Character level | 12 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `mobility` |
| Plain class | Active — teleport plus a weapon strike |
| `target` | `actor` |
| `element` | `physical` |
| Range | **10.0 m** to the target actor |
| Radius / shape | single target |
| Cost | **9.0 mana**, `+0.70` per level (L20 = 22.3) |
| Cooldown | `5.0 − 0.12 × (slvl − 1)` s, floor **2.5 s** (L20 = 2.72 s) |
| Timing | **instant** teleport, then the strike resolves on the next fixed step. Presentation runs the `dash` state for 0.20 s. Neither half scales with IAS or FCR |
| Click-to-move | Requires a hostile actor under the cursor within 10 m; refused with `reason:'no-target'` otherwise. The arrival point is the nearest walkable cell on the target's far side, so the leap always ends **behind** the target — a deliberate, readable rule the player can aim with. |

**Twenty levels**

| L | Mana | Cooldown s | Weapon dmg % | + `blade_seal` 20 → | Ref. hit | Ref. hit + synergy | Ref. DPS contribution | Dmg per mana (+ synergy) |
|---|---|---|---|---|---|---|---|---|
| 1 | 9 | 5 | 140 | 240 | 32.99 | 56.56 | 11.31 | 6.28 |
| 2 | 9.7 | 4.88 | 149 | 249 | 35.11 | 58.68 | 12.02 | 6.05 |
| 3 | 10.4 | 4.76 | 158 | 258 | 37.23 | 60.8 | 12.77 | 5.85 |
| 4 | 11.1 | 4.64 | 167 | 267 | 39.36 | 62.92 | 13.56 | 5.67 |
| 5 | 11.8 | 4.52 | 176 | 276 | 41.48 | 65.04 | 14.39 | 5.51 |
| 6 | 12.5 | 4.4 | 185 | 285 | 43.6 | 67.16 | 15.26 | 5.37 |
| 7 | 13.2 | 4.28 | 194 | 294 | 45.72 | 69.28 | 16.19 | 5.25 |
| 8 | 13.9 | 4.16 | 203 | 303 | 47.84 | 71.4 | 17.16 | 5.14 |
| 9 | 14.6 | 4.04 | 212 | 312 | 49.96 | 73.53 | 18.2 | 5.04 |
| 10 | 15.3 | 3.92 | 221 | 321 | 52.08 | 75.65 | 19.3 | 4.94 |
| 11 | 16 | 3.8 | 230 | 330 | 54.2 | 77.77 | 20.47 | 4.86 |
| 12 | 16.7 | 3.68 | 239 | 339 | 56.32 | 79.89 | 21.71 | 4.78 |
| 13 | 17.4 | 3.56 | 248 | 348 | 58.44 | 82.01 | 23.04 | 4.71 |
| 14 | 18.1 | 3.44 | 257 | 357 | 60.56 | 84.13 | 24.46 | 4.65 |
| 15 | 18.8 | 3.32 | 266 | 366 | 62.69 | 86.25 | 25.98 | 4.59 |
| 16 | 19.5 | 3.2 | 275 | 375 | 64.81 | 88.37 | 27.62 | 4.53 |
| 17 | 20.2 | 3.08 | 284 | 384 | 66.93 | 90.49 | 29.38 | 4.48 |
| 18 | 20.9 | 2.96 | 293 | 393 | 69.05 | 92.61 | 31.29 | 4.43 |
| 19 | 21.6 | 2.84 | 302 | 402 | 71.17 | 94.73 | 33.36 | 4.39 |
| 20 | 22.3 | 2.72 | 311 | 411 | 73.29 | 96.86 | 35.61 | 4.34 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildAttackPacket(actor, 'phase_leap', slvl)` |
| B2 coefficient | `weaponDamage = 140 + 9 × (slvl − 1) + 5 × allocated(blade_seal)` |
| B5 / B6 | attribute bonus, then `× meleeScale 0.95` |
| B8 riders | `blockable true` — the strike arrives inside the target's frontal arc only if the leap failed to reach its far side, so a completed leap is usually **unblockable in practice** by geometry rather than by flag |
| Imbue and Resonance | it is a weapon hit: it consumes a `blade_seal` charge, returns mana, grants 1 Resonance and advances the `cascade` counter if imbued |
| Teleport | the actor is `untargetable` for the 0.05 s of transit; in-flight projectiles targeting it are orphaned |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| receives ← | `blade_seal` | `weaponDamage` | +5 % | +100 % |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| departure | `fx.burst('phase_out', from, 0.8)` | `phaseleap` (560 ms) — the departure half |
| arrival + strike | `fx.burst('phase_in', to, 0.8)`, `fx.trail('rune_arc', actorRef)`, `fx.impact(...)` | the arrival `melee.hit.metal` layer of `phaseleap`, +90 ms |

**AI and monster interaction**

- Landing behind the target breaks the frontal-arc requirement of block (03 §5.3) for the following swings as well, until the monster re-faces — worth roughly one free swing against a `bone_ranker` with its 20 % guard.
- It is the Runeblade's gap-closer onto `ashen_archer` and `dust_shaman`, both of which kite or hold at range. A 2.72 s cooldown at slvl 20 means it is available for every backline monster in a pack.
- Against `molgrim` it is the phase-III answer to `blink`: the boss teleports away, the Runeblade follows.

---

### 6.5 `echo_blade` — Echo Blade / Клинок-эхо

| Field | Value |
|---|---|
| `id` | `echo_blade` |
| Name EN / RU | Echo Blade / Клинок-эхо |
| Class / tree | Runeblade / `enchanted_blade` |
| Tree position | row 4, column 2 (capstone) |
| Character level | 18 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `summon` |
| Plain class | Active — timed duplicate |
| `target` | `self` |
| `element` | `physical` |
| Range | the echo spawns within 2 m of the caster and mirrors its attacks from its own position |
| Radius / shape | — |
| Cost | **22.0 mana**, `+1.50` per level (L20 = 50.5) |
| Cooldown | **25.0 s**, flat |
| Timing | `castTime 0.60 s` × `castScale 1.00` = **0.60 s** at FCR 0 |
| Click-to-move | Self-cast, cursor ignored. Casting while an echo is alive refuses with `reason:'active'` — the echo is never re-summoned early, and its remaining time is readable in `ui`. |

**Twenty levels**

| L | Mana | Duration s | Echo damage % | + `resonance_circuit` 20 → | Ref. echo hit (+ synergy) | Echo swings per cast | Ref. total per cast (+ synergy) | Uptime (dur / 25 s) | Added DPS over the cooldown |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 22 | 10 | 40 | 120 | 28.28 | 15.4 | 435.06 | 40 % | 17.4 |
| 2 | 23.5 | 10.3 | 42 | 122 | 28.75 | 15.8 | 455.58 | 41.2 % | 18.22 |
| 3 | 25 | 10.6 | 44 | 124 | 29.22 | 16.3 | 476.54 | 42.4 % | 19.06 |
| 4 | 26.5 | 10.9 | 46 | 126 | 29.69 | 16.8 | 497.93 | 43.6 % | 19.92 |
| 5 | 28 | 11.2 | 48 | 128 | 30.16 | 17.2 | 519.75 | 44.8 % | 20.79 |
| 6 | 29.5 | 11.5 | 50 | 130 | 30.64 | 17.7 | 542.02 | 46 % | 21.68 |
| 7 | 31 | 11.8 | 52 | 132 | 31.11 | 18.2 | 564.71 | 47.2 % | 22.59 |
| 8 | 32.5 | 12.1 | 54 | 134 | 31.58 | 18.6 | 587.84 | 48.4 % | 23.51 |
| 9 | 34 | 12.4 | 56 | 136 | 32.05 | 19.1 | 611.41 | 49.6 % | 24.46 |
| 10 | 35.5 | 12.7 | 58 | 138 | 32.52 | 19.5 | 635.41 | 50.8 % | 25.42 |
| 11 | 37 | 13 | 60 | 140 | 32.99 | 20 | 659.85 | 52 % | 26.39 |
| 12 | 38.5 | 13.3 | 62 | 142 | 33.46 | 20.5 | 684.72 | 53.2 % | 27.39 |
| 13 | 40 | 13.6 | 64 | 144 | 33.93 | 20.9 | 710.02 | 54.4 % | 28.4 |
| 14 | 41.5 | 13.9 | 66 | 146 | 34.41 | 21.4 | 735.76 | 55.6 % | 29.43 |
| 15 | 43 | 14.2 | 68 | 148 | 34.88 | 21.8 | 761.94 | 56.8 % | 30.48 |
| 16 | 44.5 | 14.5 | 70 | 150 | 35.35 | 22.3 | 788.55 | 58 % | 31.54 |
| 17 | 46 | 14.8 | 72 | 152 | 35.82 | 22.8 | 815.6 | 59.2 % | 32.62 |
| 18 | 47.5 | 15.1 | 74 | 154 | 36.29 | 23.2 | 843.08 | 60.4 % | 33.72 |
| 19 | 49 | 15.4 | 76 | 156 | 36.76 | 23.7 | 871 | 61.6 % | 34.84 |
| 20 | 50.5 | 15.7 | 78 | 158 | 37.23 | 24.2 | 899.35 | 62.8 % | 35.97 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | the echo calls `combat.buildAttackPacket(echo, 'attack', 0)` and then scales every damage component by `(40 + 2 × (slvl − 1) + 4 × allocated(resonance_circuit)) / 100` |
| Actor | a real `Actor` with `kind: 'summon'`, `ACTOR_FLAG.summoned \| ACTOR_FLAG.visualOnly`, `team` inherited from `ownerId` (01 §1.2) |
| `visualOnly` | deals damage, **takes none** (01 §2.1). It cannot be targeted, cannot be killed, and does not occupy a monster's attention |
| What it copies | the Runeblade's **weapon attacks**, at the same cadence, against the Runeblade's current target. It does not copy skills — no Rune Strike, no Phase Leap |
| What it does not do | generates **no Resonance**, returns **no mana**, does not advance the `cascade` counter, does not consume `blade_seal` charges, and does not carry the imbue |
| Expiry | the echo despawns at `10 + 0.3 × (slvl − 1)` s, on the owner's death, or on zone change |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| receives ← | `resonance_circuit` | echo damage | +4 % | +80 % |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| cast | `fx.burst('echo_split', actor, 1.2)` | `echoblade.spawn` (900 ms) |
| alive | the echo's `MaterialSet` uses `uDissolve 0.35` and the `magic` rarity blue at 0.4 emissive so it is never mistaken for the player (08 §4.5) | — (silent; its hits use `melee.hit.<surface>` at 0.6 gain) |
| expiry | `uDissolve` 0.35 → 1.0 over 0.4 s | **`echoblade.expire`** — requested addition, see the audio additions section |

**AI and monster interaction**

- Monsters ignore the echo entirely: it has no threat entry, so it never pulls and never body-blocks. It is a damage multiplier, not a pet.
- The 40 %-of-cooldown uptime at slvl 1 rising to 62.8 % at slvl 20 is the whole scaling story; the damage coefficient nearly doubles over the same span, so the skill is worth roughly 3.1× more at 20 points than at 1.

Deliberately the weakest of the three Runeblade capstones on a single target and the only one that costs nothing to keep running. It is the boss-fight capstone; `unity` is the pack capstone.

---
## 7. Runeblade — Conduit (`conduit`)

The caster half. It holds the class's only chain damage, the passive that makes
the Resonance loop breathe, a stance that forces a commitment to one damage type,
and a capstone that turns every sword swing into a spell.

---

### 7.1 `discharge` — Discharge / Разряд

| Field | Value |
|---|---|
| `id` | `discharge` |
| Name EN / RU | Discharge / Разряд |
| Class / tree | Runeblade / `conduit` |
| Tree position | row 1, column 2 (root) |
| Character level | 1 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `projectile` |
| Plain class | Active — chaining bolt |
| `target` | `actor` |
| `element` | `lightning` |
| Range | first target within 9 m; each jump reaches **6.0 m** from the previous target |
| Radius / shape | — |
| Cost | **4.0 mana**, `+0.35` per level (L20 = 10.65) |
| Cooldown | none |
| Timing | `castTime 0.40 s` × `castScale 1.00` = **0.40 s** at FCR 0 |
| Click-to-move | Needs a hostile actor under the cursor or within 9 m of the cursor ray; on empty ground it is refused with `reason:'no-target'`. The Runeblade does not walk into range — 9 m is already outside every melee monster's reach. Hold to repeat. |

**Twenty levels**

| L | Mana | Light. min | Light. max | Avg | Targets | Chain multiplier | Ref. first target | Ref. full chain | Ref. DPS @ 0.40 s | Dmg / mana (full chain) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 4 | 3 | 11 | 7 | 3 | 2.3125 | 6.98 | 16.15 | 40.37 | 4.04 |
| 2 | 4.35 | 5.6 | 17.2 | 11.4 | 3 | 2.3125 | 11.37 | 26.3 | 65.74 | 6.05 |
| 3 | 4.7 | 8.2 | 23.4 | 15.8 | 3 | 2.3125 | 15.76 | 36.45 | 91.12 | 7.75 |
| 4 | 5.05 | 10.8 | 29.6 | 20.2 | 3 | 2.3125 | 20.15 | 46.6 | 116.49 | 9.23 |
| 5 | 5.4 | 13.4 | 35.8 | 24.6 | 3 | 2.3125 | 24.54 | 56.75 | 141.86 | 10.51 |
| 6 | 5.75 | 16 | 42 | 29 | 4 | 2.7344 | 28.93 | 79.1 | 197.75 | 13.76 |
| 7 | 6.1 | 18.6 | 48.2 | 33.4 | 4 | 2.7344 | 33.32 | 91.1 | 227.75 | 14.93 |
| 8 | 6.45 | 21.2 | 54.4 | 37.8 | 4 | 2.7344 | 37.71 | 103.1 | 257.75 | 15.98 |
| 9 | 6.8 | 23.8 | 60.6 | 42.2 | 4 | 2.7344 | 42.09 | 115.1 | 287.76 | 16.93 |
| 10 | 7.15 | 26.4 | 66.8 | 46.6 | 4 | 2.7344 | 46.48 | 127.1 | 317.76 | 17.78 |
| 11 | 7.5 | 29 | 73 | 51 | 4 | 2.7344 | 50.87 | 139.1 | 347.76 | 18.55 |
| 12 | 7.85 | 31.6 | 79.2 | 55.4 | 5 | 3.0508 | 55.26 | 168.59 | 421.48 | 21.48 |
| 13 | 8.2 | 34.2 | 85.4 | 59.8 | 5 | 3.0508 | 59.65 | 181.98 | 454.95 | 22.19 |
| 14 | 8.55 | 36.8 | 91.6 | 64.2 | 5 | 3.0508 | 64.04 | 195.37 | 488.43 | 22.85 |
| 15 | 8.9 | 39.4 | 97.8 | 68.6 | 5 | 3.0508 | 68.43 | 208.76 | 521.9 | 23.46 |
| 16 | 9.25 | 42 | 104 | 73 | 5 | 3.0508 | 72.82 | 222.15 | 555.38 | 24.02 |
| 17 | 9.6 | 44.6 | 110.2 | 77.4 | 5 | 3.0508 | 77.21 | 235.54 | 588.85 | 24.54 |
| 18 | 9.95 | 47.2 | 116.4 | 81.8 | 6 | 3.2881 | 81.6 | 268.29 | 670.73 | 26.96 |
| 19 | 10.3 | 49.8 | 122.6 | 86.2 | 6 | 3.2881 | 85.98 | 282.72 | 706.81 | 27.45 |
| 20 | 10.65 | 52.4 | 128.8 | 90.6 | 6 | 3.2881 | 90.37 | 297.16 | 742.89 | 27.9 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildSpellPacket(actor, 'discharge', slvl)` once; the same packet is resolved against each link with a growing falloff |
| B7 lightning | `lightMin = 3 + 2.6 × (slvl − 1)`, `lightMax = 11 + 6.2 × (slvl − 1)` |
| B6 | `× spellScale 0.95`, then `× (1 + lightDamagePercent/100) × (1 + elementalDamagePercent/100)` |
| `ProjectileSpec` | `{ speed: 0 (instant beam), lifetime: 0.35, radius: 0, pierce: false, chain: { jumps: min(6, 3 + ⌊slvl/6⌋), range: 6.0, falloffPercent: 25 } }` |
| Falloff | link *k* (0-indexed) deals `0.75^k` of the rolled damage. Each link draws its **own** `U(min,max)` and its own crit at R6 |
| Target selection | nearest un-hit hostile within 6.0 m of the previous link, ties broken by ascending `actor.id`. A target is never hit twice by one cast — this is the anti-pattern lock against a two-monster infinite bounce |
| B8 riders | `attackRating = 0`, `dodgeable false`, `blockable false` |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| grants → | `unity` | `flatDamage` (lightning) | +6 % | +120 % |
| grants → | `thunder_step` | `flatDamage` (lightning) | +5 % | +100 % |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| `cast` wind-up | blade `uGlow` ramp to 2.0 | `spell.cast.lightning` (180 ms) |
| `active`, link 0 | `fx.beam('arc', caster, target, 0.12)`, `fx.elementalImpact(target,'lightning',0.4,power)` | `lightning.arc` (340 ms) |
| links 1..n | `fx.beam('arc', prev, next, 0.12)` | `lightning.chain.jump` at `0.7^n` gain, +2 semitones per jump, played at each target's position |

**AI and monster interaction**

- The 6.0 m jump range is tuned to a pack blob: a pack of 5–12 at the plan's spacing sits inside two jumps of any member, so a full six-link chain is reachable from any entry point.
- Chaining ignores line of sight but not range, so a wall or a `maulsmith` body does not break the chain.
- It is the class's only ranged option and its only answer to `ashen_archer` before level 12.

`discharge` is the source of **two** synergies — the only skill in the game that feeds two targets — because the Conduit tree has to fund both its mobility skill and its capstone from one investment.

---

### 7.2 `resonance_circuit` — Resonance Circuit / Резонансный контур

| Field | Value |
|---|---|
| `id` | `resonance_circuit` |
| Name EN / RU | Resonance Circuit / Резонансный контур |
| Class / tree | Runeblade / `conduit` |
| Tree position | row 2, column 2 |
| Character level | 6 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `passive` |
| Plain class | Passive — always on |
| `target` | `none` |
| `element` | `lightning` |
| Range | — |
| Radius / shape | — |
| Cost | none |
| Cooldown | none |
| Timing | none — a `sources.skills` contribution |
| Click-to-move | Not castable; never on the hotbar. |

**Twenty levels**

| L | `maxResonance` + | `maxResonance` total | `manaReturnPercent` + | Total return % (base 8) | Rune Strike return % (×2) | `resonanceOnHit` + | Resonance per landed swing | Swings to fill the bar | → `echo_blade` +dmg % |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 4 | 4 | 12 | 24 | 0 | 1 | 4 | 4 |
| 2 | 1 | 4 | 4.8 | 12.8 | 25.6 | 0.1 | 1.1 | 3.64 | 8 |
| 3 | 1 | 4 | 5.6 | 13.6 | 27.2 | 0.2 | 1.2 | 3.33 | 12 |
| 4 | 1 | 4 | 6.4 | 14.4 | 28.8 | 0.3 | 1.3 | 3.08 | 16 |
| 5 | 1 | 4 | 7.2 | 15.2 | 30.4 | 0.4 | 1.4 | 2.86 | 20 |
| 6 | 1 | 4 | 8 | 16 | 32 | 0.5 | 1.5 | 2.67 | 24 |
| 7 | 1 | 4 | 8.8 | 16.8 | 33.6 | 0.6 | 1.6 | 2.5 | 28 |
| 8 | 1 | 4 | 9.6 | 17.6 | 35.2 | 0.7 | 1.7 | 2.35 | 32 |
| 9 | 1 | 4 | 10.4 | 18.4 | 36.8 | 0.8 | 1.8 | 2.22 | 36 |
| 10 | 2 | 5 | 11.2 | 19.2 | 38.4 | 0.9 | 1.9 | 2.63 | 40 |
| 11 | 2 | 5 | 12 | 20 | 40 | 1 | 2 | 2.5 | 44 |
| 12 | 2 | 5 | 12.8 | 20.8 | 41.6 | 1.1 | 2.1 | 2.38 | 48 |
| 13 | 2 | 5 | 13.6 | 21.6 | 43.2 | 1.2 | 2.2 | 2.27 | 52 |
| 14 | 2 | 5 | 14.4 | 22.4 | 44.8 | 1.3 | 2.3 | 2.17 | 56 |
| 15 | 2 | 5 | 15.2 | 23.2 | 46.4 | 1.4 | 2.4 | 2.08 | 60 |
| 16 | 2 | 5 | 16 | 24 | 48 | 1.5 | 2.5 | 2 | 64 |
| 17 | 2 | 5 | 16.8 | 24.8 | 49.6 | 1.6 | 2.6 | 1.92 | 68 |
| 18 | 2 | 5 | 17.6 | 25.6 | 51.2 | 1.7 | 2.7 | 1.85 | 72 |
| 19 | 2 | 5 | 18.4 | 26.4 | 52.8 | 1.8 | 2.8 | 1.79 | 76 |
| 20 | 2 | 5 | 19.2 | 27.2 | 54.4 | 1.9 | 2.9 | 1.72 | 80 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Produces | no packet |
| Contributes | `{ maxResonance: 1 (2 from effective level 10), manaReturnPercent: 4 + 0.8 × (slvl − 1), resonanceOnHit: 0.1 × (slvl − 1) }` |
| `maxResonance` | class base **3**, `+1` at effective level ≥ 1, `+1` more at effective level ≥ 10 — a hard maximum of **5** (03 §2.4). The `StatBlock` cap is 8, unreachable by design |
| `manaReturnPercent` | summed with the class base 8 and doubled by `rune_strike` for its own hit. Applied at R14(d) from post-mitigation physical |
| `resonanceOnHit` | fractional, floored on read (03 §2.4). `actor.resonance` is stored as a float and displayed as `⌊resonance⌋` |
| At slvl 1 | `resonanceOnHit` contributes **0** — the first point buys the fourth pip and the mana return, not the fill rate. This is the documented reading of `+0.1/L` in 03 §8.6 |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| grants → | `echo_blade` | echo damage | +4 % | +80 % |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| pip gained | `ui` pip fill; `fx.burst('resonance_pip', actor, 0.25)` at LOD 0 | `resonance.charge`, pitch `73.42 × n` Hz, gains 0.30 / 0.20 / 0.12 / 0.07 / 0.04 for pips 1..5 |
| bar full | blade `uGlow` holds at 1.2 | — (the fifth `resonance.charge` at 0.04 gain is the cue) |

**AI and monster interaction**

- Out of combat Resonance decays at **1 per 3 s**, so a five-pip bar survives 15 s of walking — long enough to open a fight sealed, short enough that it cannot be banked between zones.
- The extra pips are worth points only if the build actually spends them. Since `blade_seal` empties the whole bar (03 §2.4), the pairing runs both ways and both mispairings are traps the balance harness reports (§13, §12.5): `blade_seal 1` with `resonance_circuit 20` builds a five-wide bar to feed a three-hit window and pays for pips it never fills usefully; `blade_seal 15+` with no `resonance_circuit` runs a five-hit window off a three-wide bar and discards 40 % of what it generates. The matched pairs are 3/3, 4/4 and 5/5.

---

### 7.3 `polarity` — Polarity / Полярность

| Field | Value |
|---|---|
| `id` | `polarity` |
| Name EN / RU | Polarity / Полярность |
| Class / tree | Runeblade / `conduit` |
| Tree position | row 3, column 1 |
| Character level | 12 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `toggle` |
| Plain class | Toggle — two stances, one active at a time |
| `target` | `self` |
| `element` | `physical` |
| Range | — |
| Radius / shape | — |
| Cost | **10 mana to switch**, flat at every level. Holding a stance costs nothing |
| Cooldown | **1.5 s lockout** after a switch — not a cooldown in `actor.cooldowns`, a stance lockout `skills` owns |
| Timing | instant. No animation state; the blade's `uGlow` colour changes over 0.25 s |
| Click-to-move | A hotbar press toggles to the other stance. Neither stance is "off" — the Runeblade is always in one of the two, starting in **Blade**. Pressing during the lockout is refused with `reason:'cooldown'` and plays `player.cast.fail`. |

**Twenty levels**

| L | Blade: `physicalDamagePercent` + | Blade: `elementalDamagePercent` − | Storm: `elementalDamagePercent` + | Storm: `physicalDamagePercent` − | Blade net on a pure-physical hit | Storm net on a pure-elemental hit | Blade net on a 50/50 hybrid hit | Swing-to-swing swing between stances |
|---|---|---|---|---|---|---|---|---|
| 1 | 30 | 15 | 30 | 15 | 30 % | 30 % | 7.5 % | 45 pts |
| 2 | 32 | 15 | 32 | 15 | 32 % | 32 % | 8.5 % | 47 pts |
| 3 | 34 | 15 | 34 | 15 | 34 % | 34 % | 9.5 % | 49 pts |
| 4 | 36 | 15 | 36 | 15 | 36 % | 36 % | 10.5 % | 51 pts |
| 5 | 38 | 15 | 38 | 15 | 38 % | 38 % | 11.5 % | 53 pts |
| 6 | 40 | 15 | 40 | 15 | 40 % | 40 % | 12.5 % | 55 pts |
| 7 | 42 | 15 | 42 | 15 | 42 % | 42 % | 13.5 % | 57 pts |
| 8 | 44 | 15 | 44 | 15 | 44 % | 44 % | 14.5 % | 59 pts |
| 9 | 46 | 15 | 46 | 15 | 46 % | 46 % | 15.5 % | 61 pts |
| 10 | 48 | 15 | 48 | 15 | 48 % | 48 % | 16.5 % | 63 pts |
| 11 | 50 | 15 | 50 | 15 | 50 % | 50 % | 17.5 % | 65 pts |
| 12 | 52 | 15 | 52 | 15 | 52 % | 52 % | 18.5 % | 67 pts |
| 13 | 54 | 15 | 54 | 15 | 54 % | 54 % | 19.5 % | 69 pts |
| 14 | 56 | 15 | 56 | 15 | 56 % | 56 % | 20.5 % | 71 pts |
| 15 | 58 | 15 | 58 | 15 | 58 % | 58 % | 21.5 % | 73 pts |
| 16 | 60 | 15 | 60 | 15 | 60 % | 60 % | 22.5 % | 75 pts |
| 17 | 62 | 15 | 62 | 15 | 62 % | 62 % | 23.5 % | 77 pts |
| 18 | 64 | 15 | 64 | 15 | 64 % | 64 % | 24.5 % | 79 pts |
| 19 | 66 | 15 | 66 | 15 | 66 % | 66 % | 25.5 % | 81 pts |
| 20 | 68 | 15 | 68 | 15 | 68 % | 68 % | 26.5 % | 83 pts |

**`DamagePacket`**

| Field | Value |
|---|---|
| Produces | no packet |
| Contributes (Blade) | `{ physicalDamagePercent: +30 + 2 × (slvl − 1), elementalDamagePercent: −15 }` |
| Contributes (Storm) | `{ elementalDamagePercent: +30 + 2 × (slvl − 1), physicalDamagePercent: −15 }` |
| Where it lands | both stats are `add→mul` and are applied at **B6**, alongside the class scales. `elementalDamagePercent` multiplies all five elements, including the `blade_seal` imbue and `cascade`'s magic |
| State | `skills` owns the stance (02 §10, "Owns exclusively: … `polarity` stance"). It survives zone changes, is written to the save, and emits `stats:dirty` on every switch |
| Switching cost | 10 mana is charged even if the switch is a no-op back to the same stance; the UI never offers that |

**Synergies**

None in either direction.

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| switch | blade `uGlow` colour lerps over 0.25 s: Blade `#c8c8c8`, Storm `#6a7bff`. `fx.burst('polarity_flip', actor, 0.6)` | **`skill.polarity.switch`** — requested addition, see the audio additions section |
| held | a 0.15-intensity rim on the weapon socket in the stance colour, readable at 20 m (08 §3.8) | — |

**AI and monster interaction**

- The −15 on the opposite type is what stops the skill being a free 68 % at level 20: a Runeblade running `blade_seal` **and** a physical weapon is in a hybrid packet and gains only `(68 − 15)/2 = 26.5 %`. Committing to one damage type is the price of the full value.
- Against `molgrim` in Renunciation (fire/cold/lightning at 90, clamped to 75; physical 10) **Blade is correct**, and the arithmetic is not close: physical keeps 90 % of the number, elemental keeps 25 %.
- Against `maulsmith` (−25 lightning, +15 physical) **Storm** is correct. Reading the bestiary is the skill.

---

### 7.4 `thunder_step` — Thunder Step / Громовой шаг

| Field | Value |
|---|---|
| `id` | `thunder_step` |
| Name EN / RU | Thunder Step / Громовой шаг |
| Class / tree | Runeblade / `conduit` |
| Tree position | row 3, column 3 |
| Character level | 12 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `mobility` |
| Plain class | Active — dash with an arrival nova |
| `target` | `point` |
| `element` | `lightning` |
| Range | **7.0 m** dash |
| Radius / shape | **3.5 m** on arrival |
| Cost | **11.0 mana**, `+0.80` per level (L20 = 26.2) |
| Cooldown | `6.0 − 0.15 × (slvl − 1)` s, floor **3.0 s** (L20 = 3.15 s) |
| Timing | **instant** dash (0.28 s of `dash` presentation), then the nova on the same step as arrival. Neither half scales with IAS or FCR |
| Click-to-move | Dashes toward the cursor point, clipped by `nav` to the last walkable cell. Unlike `phase_leap` it needs no target and can be used to escape as well as to engage. |

**Twenty levels**

| L | Mana | Cooldown s | Light. min | Light. max | Avg | + `discharge` 20 → avg | Ref. hit (+ synergy) | Ref. 4-target burst | Dmg / mana (4 tgt) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 11 | 6 | 10 | 22 | 16 | 32 | 31.92 | 127.68 | 11.61 |
| 2 | 11.8 | 5.85 | 15 | 31 | 23 | 46 | 45.89 | 183.54 | 15.55 |
| 3 | 12.6 | 5.7 | 20 | 40 | 30 | 60 | 59.85 | 239.4 | 19 |
| 4 | 13.4 | 5.55 | 25 | 49 | 37 | 74 | 73.81 | 295.26 | 22.03 |
| 5 | 14.2 | 5.4 | 30 | 58 | 44 | 88 | 87.78 | 351.12 | 24.73 |
| 6 | 15 | 5.25 | 35 | 67 | 51 | 102 | 101.75 | 406.98 | 27.13 |
| 7 | 15.8 | 5.1 | 40 | 76 | 58 | 116 | 115.71 | 462.84 | 29.29 |
| 8 | 16.6 | 4.95 | 45 | 85 | 65 | 130 | 129.68 | 518.7 | 31.25 |
| 9 | 17.4 | 4.8 | 50 | 94 | 72 | 144 | 143.64 | 574.56 | 33.02 |
| 10 | 18.2 | 4.65 | 55 | 103 | 79 | 158 | 157.61 | 630.42 | 34.64 |
| 11 | 19 | 4.5 | 60 | 112 | 86 | 172 | 171.57 | 686.28 | 36.12 |
| 12 | 19.8 | 4.35 | 65 | 121 | 93 | 186 | 185.53 | 742.14 | 37.48 |
| 13 | 20.6 | 4.2 | 70 | 130 | 100 | 200 | 199.5 | 798 | 38.74 |
| 14 | 21.4 | 4.05 | 75 | 139 | 107 | 214 | 213.47 | 853.86 | 39.9 |
| 15 | 22.2 | 3.9 | 80 | 148 | 114 | 228 | 227.43 | 909.72 | 40.98 |
| 16 | 23 | 3.75 | 85 | 157 | 121 | 242 | 241.4 | 965.58 | 41.98 |
| 17 | 23.8 | 3.6 | 90 | 166 | 128 | 256 | 255.36 | 1021.44 | 42.92 |
| 18 | 24.6 | 3.45 | 95 | 175 | 135 | 270 | 269.32 | 1077.3 | 43.79 |
| 19 | 25.4 | 3.3 | 100 | 184 | 142 | 284 | 283.29 | 1133.16 | 44.61 |
| 20 | 26.2 | 3.15 | 105 | 193 | 149 | 298 | 297.25 | 1189.02 | 45.38 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Built by | `combat.buildSpellPacket(actor, 'thunder_step', slvl)` on arrival, resolved against every hostile inside 3.5 m |
| B7 lightning | `lightMin = 10 + 5 × (slvl − 1)`, `lightMax = 22 + 9 × (slvl − 1)`, then `× (1 + 5 × allocated(discharge)/100)` |
| B8 riders | `onHitStatus: [{ status:'shocked', chance:100, stacks:1, duration:4.0 }]`, `attackRating = 0`, `dodgeable false` |
| `shocked` | **+12 % damage taken per stack**, up to 3 stacks, applied at **R12 — after resistances**, so it is a true damage-taken multiplier that immunity cannot blunt (03 §7.6) |
| Stacking to 3 | one cast is one stack. Three stacks needs three casts inside 4.0 s, which at the slvl-20 cooldown of 3.15 s is impossible alone — `unity`'s free casts are the only route, and they do not carry the rider |
| Transit | `untargetable` for 0.06 s; passed-through actors are not hit |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| receives ← | `discharge` | `flatDamage` (lightning) | +5 % | +100 % |

**Status effects**

| Status | Magnitude | Duration | Notes |
|---|---|---|---|
| `shocked` | **12 %** extra damage taken per stack | 4.0 s, refreshed for all stacks on re-application | additive stacks to 3 (+12 / +24 / +36 %); enters the pipeline at R12 only |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| departure | `fx.trail('thunder_dash', actorRef)` | `thunderstep` (760 ms) — the 300 ms dash whoosh |
| arrival | `fx.elementalImpact(x,y,z,'lightning',3.5,power)`, `fx.requestLight(x,y,z,[0.6,0.7,1.0], 3.4, 7.0, 0.25)` | the `lightning.arc` at 1.3× and the 62→28 Hz sub of `thunderstep` |
| `shocked` applied | `fx.trail('shock_veins', targetRef)` for 4 s | `status.shocked`, one voice for the whole nova |

**AI and monster interaction**

- The `shocked` rider is the Runeblade's contribution to its own burst window: opening a champion fight with Thunder Step means every following swing lands into +12 %.
- It is the escape from a `carrion_swarm` surround — 7 m clears the blob, and the nova thins it on the way out.
- A `maulsmith` at **−25 lightning resistance** takes `× 1.25` from this skill; it is the single most efficient answer to that archetype in the game.

---

### 7.5 `unity` — Unity / Единство

| Field | Value |
|---|---|
| `id` | `unity` |
| Name EN / RU | Unity / Единство |
| Class / tree | Runeblade / `conduit` |
| Tree position | row 4, column 2 (capstone) |
| Character level | 18 |
| Prerequisite | — |
| `type` (`SkillDefinition`) | `buff` |
| Plain class | Active — timed self buff that free-casts a second skill |
| `target` | `self` |
| `element` | `lightning` |
| Range | — |
| Radius / shape | each free `discharge` uses its own 6.0 m jump range |
| Cost | **26.0 mana**, `+1.60` per level (L20 = 56.4) |
| Cooldown | **30.0 s**, flat |
| Timing | `castTime 0.50 s` × `castScale 1.00` = **0.50 s** at FCR 0 |
| Click-to-move | Self-cast, cursor ignored. Refused while already active with `reason:'active'`. |

**Twenty levels**

| L | Mana | Duration s | Uptime (dur / 30 s) | Free casts @ 0.65 s swing | Ref. chain each | Ref. total per cast | Mana per point of damage | Added DPS over the cooldown |
|---|---|---|---|---|---|---|---|---|
| 1 | 26 | 8 | 26.67 % | 12.3 | 222.56 | 2739.2 | 0.0095 | 91.31 |
| 2 | 27.6 | 8.2 | 27.33 % | 12.6 | 222.56 | 2807.68 | 0.0098 | 93.59 |
| 3 | 29.2 | 8.4 | 28 % | 12.9 | 222.56 | 2876.16 | 0.0102 | 95.87 |
| 4 | 30.8 | 8.6 | 28.67 % | 13.2 | 222.56 | 2944.64 | 0.0105 | 98.15 |
| 5 | 32.4 | 8.8 | 29.33 % | 13.5 | 222.56 | 3013.12 | 0.0108 | 100.44 |
| 6 | 34 | 9 | 30 % | 13.8 | 222.56 | 3081.6 | 0.011 | 102.72 |
| 7 | 35.6 | 9.2 | 30.67 % | 14.2 | 222.56 | 3150.08 | 0.0113 | 105 |
| 8 | 37.2 | 9.4 | 31.33 % | 14.5 | 222.56 | 3218.56 | 0.0116 | 107.29 |
| 9 | 38.8 | 9.6 | 32 % | 14.8 | 222.56 | 3287.04 | 0.0118 | 109.57 |
| 10 | 40.4 | 9.8 | 32.67 % | 15.1 | 222.56 | 3355.52 | 0.012 | 111.85 |
| 11 | 42 | 10 | 33.33 % | 15.4 | 222.56 | 3424 | 0.0123 | 114.13 |
| 12 | 43.6 | 10.2 | 34 % | 15.7 | 222.56 | 3492.48 | 0.0125 | 116.42 |
| 13 | 45.2 | 10.4 | 34.67 % | 16 | 222.56 | 3560.96 | 0.0127 | 118.7 |
| 14 | 46.8 | 10.6 | 35.33 % | 16.3 | 222.56 | 3629.44 | 0.0129 | 120.98 |
| 15 | 48.4 | 10.8 | 36 % | 16.6 | 222.56 | 3697.92 | 0.0131 | 123.26 |
| 16 | 50 | 11 | 36.67 % | 16.9 | 222.56 | 3766.4 | 0.0133 | 125.55 |
| 17 | 51.6 | 11.2 | 37.33 % | 17.2 | 222.56 | 3834.88 | 0.0135 | 127.83 |
| 18 | 53.2 | 11.4 | 38 % | 17.5 | 222.56 | 3903.36 | 0.0136 | 130.11 |
| 19 | 54.8 | 11.6 | 38.67 % | 17.8 | 222.56 | 3971.84 | 0.0138 | 132.39 |
| 20 | 56.4 | 11.8 | 39.33 % | 18.2 | 222.56 | 4040.32 | 0.014 | 134.68 |

**`DamagePacket`**

| Field | Value |
|---|---|
| Produces | no packet of its own. Each free cast is an ordinary `discharge` packet built by `combat.buildSpellPacket(actor, 'discharge', effectiveLevel(discharge))` |
| Buff | `skills.applyBuff(actor, 'unity', slvl, 8 + 0.2 × (slvl − 1))` |
| Trigger | every **landed weapon hit** — a miss, a dodge and a block trigger nothing |
| Cost of the free cast | **zero mana**, and it ignores `discharge`'s (nonexistent) cooldown. It does not consume a `blade_seal` charge and does not advance the `cascade` counter |
| `discharge` level | the free cast reads `discharge`'s **current effective level**, so `unity` is worthless in a build with no points in `discharge`. At `discharge 0` the buff fires nothing at all and `skills` logs a dev-build warning |
| Synergy | `+6 % lightning per allocated point of `discharge`` applies to the free casts, on top of the level they already read |
| Rate limit | one free cast per landed hit, and the weapon's attack interval floors at 0.25 s (03 §4.3) — so the hard ceiling is **4 free chains per second**, which is the anti-pattern lock (§12) |

**Synergies**

| Direction | Skill | Coefficient | Per source point | At 20 source points |
|---|---|---|---|---|
| receives ← | `discharge` | `flatDamage` (lightning) | +6 % | +120 % |

**Visual and audio hooks**

| Animation phase (08 §6) | `fx` | `audio` |
|---|---|---|
| cast | `fx.burst('unity_ring', actor, 2.0)`, blade `uGlow` to 2.4 for the duration | `spell.cast.lightning`, then `unity.loop` tracked for the buff's life |
| each free cast | `fx.beam('arc', …)` per link, at 0.7 scale so the screen stays readable | `lightning.arc` at 0.6 gain with a **120 ms retrigger guard** (10 §4.4) — at 4 casts/s the guard is what stops the machine-gun |
| expiry | blade `uGlow` back to base over 0.3 s | `unity.loop` released with a 200 ms fade |

**AI and monster interaction**

- Against a pack this is the largest burst in the class: at the slvl-20 duration of 11.8 s and a 0.65 s swing, 18 chains of 6 links each is 108 resolves — the reason the projectile pool cap exists (02 §10, "the pool cap is what keeps a Runeblade `unity` burst from allocating").
- It does nothing against a single target that the chain cannot leave, since links 1..5 have nowhere to jump. Boss value is `1.0 ×` the chain, not `3.29 ×`.

**Reference chain used above:** `discharge` at effective level 11 (10 allocated + 1 quest), the most a `unity` build can afford alongside twenty points here. Avg roll `(29 + 73)/2 = 51`; `× 0.9975` reference multiplier `= 50.8725`; `× 2.734375` for four links `= 139.10`; `× 1.60` for the `+6 %/point × 10` synergy `= **222.56**` per landed swing.

`unity` is the pack capstone and `echo_blade` the boss capstone; the 30 s cooldown against an 11.8 s duration is 39 % uptime at twenty points, and the balance table (§10) treats it as burst, not sustain.

---
## 8. Tree layouts

Six trees. Each diagram has two halves: a grid placing the five skills by the
character level that unlocks the row, and a link map listing every edge.
`══▶` is a **synergy** — the source's allocated points raise a named coefficient
on the target. `──▶` is a **prerequisite** — the target cannot be allocated
until the source holds the stated points. A skill with neither is a **leaf**,
taken purely for itself. The table under each diagram is the authority on
values.

### 8.1 Ravager — Carnage

```
              col 1                       col 2                       col 3

lvl  1                              ┌──────────────────┐
                                    │ 1 cleaving_strike│
                                    └──────────────────┘
        ┌──────────────────┐                                    ┌──────────────────┐
lvl  6  │ 2 bloodletting   │                                    │ 3 whirlwind      │
        └──────────────────┘                                    └──────────────────┘
        ┌──────────────────┐
lvl 12  │ 4 bloodthirst    │
        └──────────────────┘
                                    ┌──────────────────┐
lvl 18                              │ 5 sunder         │
                                    └──────────────────┘

links
  cleaving_strike ══ +8 %/pt weapon damage ══▶ whirlwind
  bloodletting    ── prereq, 3 pts ──────────▶ sunder
  bloodletting    ══ +6 %/pt weapon damage ══▶ sunder
  bloodthirst     ── leaf
```

| Link | From | To | Kind | Value |
|---|---|---|---|---|
| 1 | `cleaving_strike` | `whirlwind` | synergy | +8 % `weaponDamage` per allocated point (max +160 %) |
| 2 | `bloodletting` | `sunder` | prerequisite | ≥ 3 allocated points |
| 3 | `bloodletting` | `sunder` | synergy | +6 % `weaponDamage` per allocated point (max +120 %) |

### 8.2 Ravager — Unyielding

```
              col 1                       col 2                       col 3

lvl  1                              ┌──────────────────┐
                                    │ 6 ram_charge     │
                                    └──────────────────┘
        ┌──────────────────┐
lvl  6  │ 7 shield_stance  │
        └──────────────────┘
        ┌──────────────────┐                                    ┌──────────────────┐
lvl 12  │ 9 iron_skin      │                                    │ 8 war_cry        │
        └──────────────────┘                                    └──────────────────┘
                                    ┌──────────────────┐
lvl 18                              │10 last_stand     │
                                    └──────────────────┘

links
  ram_charge    ══ +5 %/pt stun duration ══▶ war_cry
  shield_stance ══ +4 %/pt defensePercent ═▶ iron_skin
  last_stand    ── leaf, no link in or out
```

| Link | From | To | Kind | Value |
|---|---|---|---|---|
| 1 | `ram_charge` | `war_cry` | synergy | +5 % stun duration per allocated point (max +100 %) |
| 2 | `shield_stance` | `iron_skin` | synergy | +4 % `defensePercent` per allocated point (max +80 %) |

`last_stand` has no incoming link and no outgoing link — it is the only
completely isolated skill in the game, and it is isolated on purpose: a
death-save that could be synergised into permanence would stop being a save.

### 8.3 Emberwright — Flame

```
              col 1                       col 2                       col 3

lvl  1                              ┌──────────────────┐
                                    │11 ember_bolt     │
                                    └──────────────────┘
                                    ┌──────────────────┐
lvl  6                              │12 flame_wave     │
                                    └──────────────────┘
                                    ┌──────────────────┐
lvl 12                              │13 fireball       │
                                    └──────────────────┘
        ┌──────────────────┐                                    ┌──────────────────┐
lvl 18  │15 incinerate     │                                    │14 meteor         │
        └──────────────────┘                                    └──────────────────┘

links
  ember_bolt ══ +6 %/pt fire flatDamage ══▶ meteor
  fireball   ══ +5 %/pt fire flatDamage ══▶ meteor      (two synergies on one target)
  fireball   ── prereq, 3 pts ────────────▶ meteor
  flame_wave ══ +4 %/pt detonation ═══════▶ incinerate
```

| Link | From | To | Kind | Value |
|---|---|---|---|---|
| 1 | `ember_bolt` | `meteor` | synergy | +6 % fire `flatDamage` per allocated point (max +120 %) |
| 2 | `fireball` | `meteor` | synergy | +5 % fire `flatDamage` per allocated point (max +100 %) |
| 3 | `fireball` | `meteor` | prerequisite | ≥ 3 allocated points |
| 4 | `flame_wave` | `incinerate` | synergy | +4 % detonation damage per allocated point (max +80 %) |

`meteor` is the only skill in the game with **two** incoming synergies. At twenty
points in each source they sum to `+220 %`, i.e. **×3.20** on the impact roll —
the largest multiplier available anywhere, and the reason a Flame Emberwright
still has somewhere to put its 21st through 29th points.

### 8.4 Emberwright — Ash

```
              col 1                       col 2                       col 3

        ┌──────────────────┐
lvl  1  │16 ashen_step     │
        └──────────────────┘
        ┌──────────────────┐
lvl  6  │17 mana_weave     │
        └──────────────────┘
        ┌──────────────────┐                                    ┌──────────────────┐
lvl 12  │18 smouldering_   │                                    │19 ash_wall       │
        │   ward           │                                    └──────────────────┘
        └──────────────────┘
                                    ┌──────────────────┐
lvl 18                              │20 essence_burn   │
                                    └──────────────────┘

links
  ashen_step ══ +5 %/pt fire flatDamage ══▶ ash_wall
  mana_weave ══ +4 %/pt mana conversion ══▶ essence_burn
  smouldering_ward ── leaf                            (no prerequisites in this tree)
```

| Link | From | To | Kind | Value |
|---|---|---|---|---|
| 1 | `ashen_step` | `ash_wall` | synergy | +5 % fire `flatDamage` per allocated point (max +100 %) |
| 2 | `mana_weave` | `essence_burn` | synergy | +4 % mana conversion per allocated point (max +80 %) |

The Ash tree has **no prerequisites**. Every skill in it is reachable the moment
its character level is met, which is what allows the tree to be a support
purchase for a Flame build rather than a commitment.

### 8.5 Runeblade — Enchanted Blade

```
              col 1                       col 2                       col 3

        ┌──────────────────┐                                    ┌──────────────────┐
lvl  1  │21 rune_strike    │                                    │22 blade_seal     │
        └──────────────────┘                                    └──────────────────┘
                                    ┌──────────────────┐
lvl  6                              │23 cascade        │
                                    └──────────────────┘
                                    ┌──────────────────┐
lvl 12                              │24 phase_leap     │
                                    └──────────────────┘
                                    ┌──────────────────┐
lvl 18                              │25 echo_blade     │
                                    └──────────────────┘

links
  rune_strike ══ +7 %/pt weapon damage ══▶ cascade
  blade_seal  ══ +5 %/pt weapon damage ══▶ phase_leap
  resonance_circuit (Conduit) ══ +4 %/pt ▶ echo_blade   ← the one cross-tree synergy
```

| Link | From | To | Kind | Value |
|---|---|---|---|---|
| 1 | `rune_strike` | `cascade` | synergy | +7 % `weaponDamage` per allocated point (max +140 %) |
| 2 | `blade_seal` | `phase_leap` | synergy | +5 % `weaponDamage` per allocated point (max +100 %) |
| 3 | `resonance_circuit` (`conduit`) | `echo_blade` | synergy | +4 % echo damage per allocated point (max +80 %) |

The only **cross-tree** synergy in the game. It is what stops a Runeblade from
treating the two trees as separate classes, and it is why `echo_blade` is
listed as the boss capstone rather than the melee one.

### 8.6 Runeblade — Conduit

```
              col 1                       col 2                       col 3

                                    ┌──────────────────┐
lvl  1                              │26 discharge      │
                                    └──────────────────┘
                                    ┌──────────────────┐
lvl  6                              │27 resonance_     │
                                    │   circuit        │
                                    └──────────────────┘
        ┌──────────────────┐                                    ┌──────────────────┐
lvl 12  │28 polarity       │                                    │29 thunder_step   │
        └──────────────────┘                                    └──────────────────┘
                                    ┌──────────────────┐
lvl 18                              │30 unity          │
                                    └──────────────────┘

links
  discharge         ══ +5 %/pt lightning ══▶ thunder_step
  discharge         ══ +6 %/pt lightning ══▶ unity        (one source, two targets)
  resonance_circuit ══ +4 %/pt echo dmg ═══▶ echo_blade   (Enchanted Blade)
  polarity          ── leaf
```

| Link | From | To | Kind | Value |
|---|---|---|---|---|
| 1 | `discharge` | `thunder_step` | synergy | +5 % lightning `flatDamage` per allocated point (max +100 %) |
| 2 | `discharge` | `unity` | synergy | +6 % lightning `flatDamage` per allocated point (max +120 %) |
| 3 | `resonance_circuit` | `echo_blade` (`enchanted_blade`) | synergy | +4 % echo damage per allocated point (max +80 %) |

`discharge` is the only skill that feeds **two** targets, which is what lets a
single twenty-point investment fund both the tree's mobility skill and its
capstone.

### 8.7 All fourteen synergies

Exactly as `03-combat-math.md` §8.7, with the maximum each reaches at twenty
allocated points in the source.

| # | Source | Target | Coefficient | Per point | At 20 points |
|---|---|---|---|---|---|
| 1 | `cleaving_strike` | `whirlwind` | `weaponDamage` | +8 % | +160 % |
| 2 | `bloodletting` | `sunder` | `weaponDamage` | +6 % | +120 % |
| 3 | `ram_charge` | `war_cry` | stun duration | +5 % | +100 % |
| 4 | `shield_stance` | `iron_skin` | `defensePercent` | +4 % | +80 % |
| 5 | `ember_bolt` | `meteor` | fire `flatDamage` | +6 % | +120 % |
| 6 | `fireball` | `meteor` | fire `flatDamage` | +5 % | +100 % |
| 7 | `flame_wave` | `incinerate` | detonation damage | +4 % | +80 % |
| 8 | `ashen_step` | `ash_wall` | fire `flatDamage` | +5 % | +100 % |
| 9 | `mana_weave` | `essence_burn` | mana conversion | +4 % | +80 % |
| 10 | `rune_strike` | `cascade` | `weaponDamage` | +7 % | +140 % |
| 11 | `blade_seal` | `phase_leap` | `weaponDamage` | +5 % | +100 % |
| 12 | `discharge` | `unity` | lightning `flatDamage` | +6 % | +120 % |
| 13 | `discharge` | `thunder_step` | lightning `flatDamage` | +5 % | +100 % |
| 14 | `resonance_circuit` | `echo_blade` | echo damage | +4 % | +80 % |

At least two per tree. Twelve are intra-tree; two (#14 and, read from the other
side, the Runeblade's use of it) cross a tree boundary within a class. **No
synergy crosses a class boundary**, and none is reciprocal — the graph is
acyclic, which is what makes `skills.synergyBonus()` a single lookup rather than
a fixed-point solve.

### 8.8 Prerequisites

| Target | Requires | Points | Checked against |
|---|---|---|---|
| `sunder` | `bloodletting` | 3 | `SkillInstance.allocated`, never `effectiveLevel` |
| `meteor` | `fireball` | 3 | as above |

Two prerequisites in thirty skills. Both sit on a capstone, both cost three
points, and both point at a skill that also feeds the capstone a synergy — so
the prerequisite is never a dead tax.

`skills.canAllocate()` returns `{ ok:false, reason:'prereq' }` when the
requirement is unmet and `{ ok:false, reason:'tier' }` when the character level
is too low. `skills.allocate()` deliberately does **not** re-check either
(`02-api-contracts.md` §10) so that `respec()` can rebuild a tree in one pass.

---

## 9. Build analysis

Nine builds, three per class, each spending exactly **29 points** with a
permanent `+1 to all skills` from the quest reward on top. Every figure below is
derived from the level tables in §§2–7 and the pipeline of
`03-combat-math.md` §6; nothing is estimated.

### 9.1 The level-30 reference kits

Rare gear only — no uniques, no elite bases, no sockets. Bases are the seven
rows of `03-combat-math.md` §4.6, because those are the only weapon bases fixed
outside the items specification.

| | Ravager | Emberwright | Runeblade |
|---|---|---|---|
| Attributes (§2.3) | 88 / 49 / 83 / 10 | 44 / 54 / 44 / 93 | 80 / 54 / 49 / 51 |
| `maxLife` / `maxMana` | 345 / 25 | 127 / 228 | 176 / 105 |
| Weapon | `maul_great_normal` 22–46, `twoHandMelee`, 1.25 s | `wand_ember_normal` 3–7, 0.60 s | `sword_rune_normal` 8–17, 0.65 s |
| Weapon affixes | +75 % ED, +45 AR, +20 % IAS | +55 % fire damage, +30 % FCR | +70 % ED, +45 AR, +25 % IAS, +20 % FCR |
| Other gear | +45 % ED, +35 AR, +20 % IAS | +25 % fire damage | +40 % ED, +35 AR, +15 % IAS |
| Totals | ED **120 %**, IAS **40 %**, flat AR **140** | fire **80 %**, FCR **30 %** | ED **110 %**, IAS **40 %**, FCR **20 %**, flat AR **160** |
| Armour defence | 420 | 180 | 300 |
| Attribute bonus (§4.2) | `1 + 88/75` = **2.1733** | n/a (spells skip B5) | `1 + 80/100` = **1.80** |
| Final `attackRating` | `30 + 5×42 + 140` = **380** | — | `25 + 5×47 + 160` = **420** |
| One 100 %-weapon hit | `34 × 2.20 × 2.1733 × 1.00 × 1.05` = **170.69** | — | `12.5 × 2.10 × 1.80 × 0.95 × 1.05` = **47.13** |
| Basic interval | `1.25 × 0.90 / 1.40` = **0.8036 s** | cast `0.55 × 0.85 / 1.30` = **0.3596 s** | `0.65 / 1.40` = **0.4643 s** |
| Spell multiplier | — | `1.05 × 1.80` = **1.89** (before `incinerate`) | `1.05 × 0.95` = **0.9975** |
| Belt | 4 × `potion_life_greater` | 2 × life, 2 × mana | 3 × life, 1 × mana |

### 9.2 The four yardsticks

| Key | Target | Life | DEF | flat DR | Resists | Note |
|---|---|---|---|---|---|---|
| **A** | Bone Ranker, **mlvl 30**, level-matched | 389 | 175 | 3 | fire 0, cold 25, lightning 0, magic 0, physical 0 | The pacing yardstick: `clvl == mlvl`, exactly the shape of `03-combat-math.md` §11.2 |
| **B** | Champion, mlvl 30 | 1 558 | 262 | 3 | +10 physical, +20 elemental | `03-combat-math.md` §9.3 rank multipliers |
| **C** | Bone Ranker, mlvl 33, Renunciation (Bonereach) | 611 | 191 | 4 | fire 40, cold 65, lightning 40, magic 40, physical 0 | The real endgame farm, §10.3 |
| **D** | Molgrim, mlvl 37, Renunciation | 15 794 | 295 | 4 | physical 10; fire/cold/lightning 90 → clamped **75**; magic 80 → **75**; poison 125 → **immune** | `U = 0.88` uptime applied to every TTK |

Two consequences of yardstick D worth stating before the tables. First, R10
clamps `effectiveResist` at `maxResistForElement` — default **75** — for
*every* actor, so Molgrim's 90 fire resistance in Renunciation resolves to a
×0.25 multiplier, not ×0.10. Second, R9 tests immunity **before** that clamp, so
its 125 poison is genuinely immune; poison is not a player element, which is why
that is safe.

The locked pacing targets are checked against **A**, because §11 of
`03-combat-math.md` calibrates at `clvl == mlvl` and the difficulty tiers
deliberately inflate monsters beyond that window (a +22 `mlvl` offset plus a
×1.35 life multiplier). Columns C and D are reported so the gear the endgame
actually needs is visible.

### 9.3 The nine builds

Column meanings: **Burst DPS** runs the rotation at full rate from a full
resource bar; **Sustained DPS** throttles it to the build's own resource income
and fills the remainder with the free action (basic attack, or nothing for a
caster); **Burst window** is how long the full rate lasts from a full bar;
**TTK** uses the sustained figure.

### R-A — Cleaver (Ravager)

**Allocation (29 points):** cleaving_strike 20, bloodthirst 6, whirlwind 3  
**Effective levels (+1 to all skills, quest reward):** cleaving_strike 21, bloodthirst 7, whirlwind 4

**Arithmetic**

- cleaving_strike coefficient = 40 + 6.32 × 20 = **166.4 %**
- 100 %-weapon hit = 34 × 2.20 × 2.17333 × 1.00 × 1.05 = **170.69**
- raw skill hit = 170.69 × 1.664 = **284.03**
- interval = 1.25 × 0.90 × 1.05 / 1.40 = **0.8438 s**, cost 11 rage → **13.04 rage/s**
- the same 20 points give `whirlwind` 55 + 4 × 3 + 8 × 20 = **227 %** per tick as a second button
- `bloodthirst` 7 → `lifeSteal` **8.4 %**, ≈ 23.86 life per landed cleave, per target

| Target | Hit chance | Per landed hit | Burst DPS (1 tgt) | Sustained DPS (1 tgt) | Burst DPS (pack) | Burst window | TTK (sustained) | Landed hits |
|---|---|---|---|---|---|---|---|---|
| Bone Ranker mlvl 30 (level-matched) | 68.47 % | 281.03 | 228.05 | 227.83 | 912.21 | 2882.9 s | 1.71 | 1.4 |
| Champion mlvl 30 | 59.19 % | 252.93 | 177.43 | 149.9 | 177.43 | 18.46 s | 10.39 | 6.2 |
| Bone Ranker mlvl 33, Renunciation | 63.38 % | 280.03 | 210.36 | 196.14 | 841.42 | 42.55 s | 3.12 | 2.2 |
| Molgrim mlvl 37, Renunciation | 50.41 % | 252.03 | 150.59 | 116.19 | 150.59 | 12.59 s | 154.47 | 62.7 |

**Eight-monster pack, 3 112 life at mlvl 30: 3.41 s → 0.43 s per monster.**

### R-B — Whirlwind (Ravager)

**Allocation (29 points):** whirlwind 20, cleaving_strike 9  
**Effective levels (+1 to all skills, quest reward):** whirlwind 21, cleaving_strike 10

**Arithmetic**

- whirlwind coefficient = 55 + 4 × 20 + 8 × 9 = **207 %** per tick
- raw tick = 170.69 × 2.07 = **353.34**
- tick period **0.55 s**, fixed — never scaled by IAS, so a 1.818 Hz tick rate is 376 % of weapon damage per second
- drain = 12 − 0.25 × 20 = **7.0 rage/s**; income at this kit is 5.11 rage/s from swings alone
- the channel is the whole build: `cleaving_strike` 10 is bought for its synergy, not to press

| Target | Hit chance | Per landed hit | Burst DPS (1 tgt) | Sustained DPS (1 tgt) | Burst DPS (pack) | Burst window | TTK (sustained) | Landed hits |
|---|---|---|---|---|---|---|---|---|
| Bone Ranker mlvl 30 (level-matched) | 68.47 % | 350.34 | 436.13 | 436.13 | 1308.38 | ∞ | 0.89 | 1.1 |
| Champion mlvl 30 | 59.19 % | 315.3 | 339.32 | 339.32 | 339.32 | ∞ | 4.59 | 4.9 |
| Bone Ranker mlvl 33, Renunciation | 63.38 % | 349.34 | 402.57 | 402.57 | 1207.72 | ∞ | 1.52 | 1.7 |
| Molgrim mlvl 37, Renunciation | 50.41 % | 314.4 | 288.19 | 226.04 | 288.19 | 52.47 s | 79.42 | 50.2 |

**Eight-monster pack, 3 112 life at mlvl 30: 2.38 s → 0.30 s per monster.**

The tick period is 0.55 s and not 0.35 s by the decision recorded in **D-05-1**: at
0.35 s this build reached 685.34 DPS, **3.01×** the nine-build median, and was
the only M7 gate failure in the set. The rage economy is untouched by the change
— drain and income are both per-second — so the burst windows above are the same
figures the 0.35 s channel had. Only throughput moved, by exactly `0.35 / 0.55`.

### R-C — Bulwark (Ravager)

**Allocation (29 points):** sunder 20, bloodletting 3, iron_skin 3, shield_stance 3  
**Effective levels (+1 to all skills, quest reward):** sunder 21, bloodletting 4, iron_skin 4, shield_stance 4

**Arithmetic**

- `sunder` = 130 + 9 × 20 + 6 × 3 = **328 %**, raw 559.88, on a 6.0 s cooldown
- `cursed` magnitude 60 for 6.0 s against a 6.0 s cooldown → **100 % uptime**: −60 % target defence, −22.5 to every resist
- hit chance against a cursed mlvl-30 target rises from 68.47 % to **84.44 %**
- rotation = 1 sunder + **6.2** `bloodletting` swings (105 %, raw 179.23) per 6.0 s cycle
- rage: 23.5 + 6.2 × 13.7 = **108.67 per cycle** = 18.11 rage/s
- defence: `defensePercent` 25 + 15 + 12 = **52 %** → 130 armour becomes 209.6; `physicalResist` 2.5; block +12.8; thorns 18; dodge 4.5
- bleeding: 4 stacks × 0.11 × 176.23 = **77.54 physical per second** riding on top

| Target | Hit chance | Per landed hit | Burst DPS (1 tgt) | Sustained DPS (1 tgt) | Burst DPS (pack) | Burst window | TTK (sustained) | Landed hits |
|---|---|---|---|---|---|---|---|---|
| Bone Ranker mlvl 30 (level-matched) | 84.44 % | 556.88 | 232.56 | 210.05 | 546.06 | 11.62 s | 1.85 | 0.7 |
| Champion mlvl 30 | 78.38 % | 556.88 | 215.87 | 193.88 | 215.87 | 11.04 s | 8.04 | 2.8 |
| Bone Ranker mlvl 33, Renunciation | 79.3 % | 555.88 | 217.43 | 195.33 | 511.29 | 11.12 s | 3.13 | 1.1 |
| Molgrim mlvl 37, Renunciation | 68.33 % | 555.88 | 187.37 | 162.63 | 187.37 | 8.56 s | 110.36 | 28.4 |

**Eight-monster pack, 3 112 life at mlvl 30: 5.7 s → 0.71 s per monster.**

### E-A — Bolt (Emberwright)

**Allocation (29 points):** ember_bolt 20, incinerate 6, mana_weave 3  
**Effective levels (+1 to all skills, quest reward):** ember_bolt 21, incinerate 7, mana_weave 4

**Arithmetic**

- `ember_bolt` eff 21 → 48–82, average **65**
- `incinerate` 7 → `fireDamagePercent` +36; total fire % = 80 gear + 36 = **116** → multiplier 1.05 × 2.16 = **2.268**
- interval 0.55 × 0.85 / 1.30 = **0.3596 s** → 2.78 casts/s; cost 6.75 → **18.77 mana/s**
- `mana_weave` 4 → pool 258, regen 258 × 0.040 + 1.85 = **12.17 mana/s**, `damageTakenToMana` 13 %
- pierce from level 10; the pack column assumes **3 bodies** on the line
- corpse detonation 43 % of `maxLife` in 2.5 m closes any pack the bolt started

| Target | Hit chance | Per landed hit | Burst DPS (1 tgt) | Sustained DPS (1 tgt) | Burst DPS (pack) | Burst window | TTK (sustained) | Landed hits |
|---|---|---|---|---|---|---|---|---|
| Bone Ranker mlvl 30 (level-matched) | 100 % | 147.42 | 409.94 | 265.79 | 1229.81 | 39.09 s | 1.46 | 2.64 |
| Champion mlvl 30 | 100 % | 117.94 | 327.95 | 212.63 | 327.95 | 39.09 s | 7.33 | 13.21 |
| Bone Ranker mlvl 33, Renunciation | 100 % | 88.45 | 245.96 | 159.48 | 737.89 | 39.09 s | 3.83 | 6.91 |
| Molgrim mlvl 37, Renunciation | 100 % | 36.86 | 102.48 | 66.45 | 102.48 | 39.09 s | 270.1 | 428.54 |

**Eight-monster pack, 3 112 life at mlvl 30: 2.53 s → 0.32 s per monster.**

### E-B — Meteor (Emberwright)

**Allocation (29 points):** meteor 16, ember_bolt 10, fireball 3  
**Effective levels (+1 to all skills, quest reward):** meteor 17, ember_bolt 11, fireball 4

**Arithmetic**

- `meteor` eff 17 → 258–410, average **334**; synergy 6 × 10 + 5 × 3 = **+75 %** → **584.5** effective
- pool 44.4 fire/s for 6 s in 3.2 m, and `nav.markHazard()` splits the pack around it
- multiplier 1.05 × 1.80 = **1.89** (no `incinerate` in this build)
- cadence = the **4.0 s cooldown**; 9.9 `ember_bolt` casts (eff 11, avg 30.75) fill each gap
- mana: 36.4 for the meteor + 9.9 × 4.75 for the bolts = **20.8 mana/s** against 11.12 regen

| Target | Hit chance | Per landed hit | Burst DPS (1 tgt) | Sustained DPS (1 tgt) | Burst DPS (pack) | Burst window | TTK (sustained) | Landed hits |
|---|---|---|---|---|---|---|---|---|
| Bone Ranker mlvl 30 (level-matched) | 100 % | 1104.71 | 545.17 | 291.49 | 2725.84 | 26.66 s | 1.33 | 0.35 |
| Champion mlvl 30 | 100 % | 883.76 | 436.13 | 233.2 | 436.13 | 26.66 s | 6.68 | 1.76 |
| Bone Ranker mlvl 33, Renunciation | 100 % | 662.82 | 327.1 | 174.9 | 1635.51 | 26.66 s | 3.49 | 0.92 |
| Molgrim mlvl 37, Renunciation | 100 % | 276.18 | 136.29 | 72.87 | 136.29 | 26.66 s | 246.29 | 57.19 |

**Eight-monster pack, 3 112 life at mlvl 30: 1.14 s → 0.14 s per monster.**

### E-C — Essence (Emberwright)

**Allocation (29 points):** essence_burn 20, mana_weave 6, ashen_step 3  
**Effective levels (+1 to all skills, quest reward):** essence_burn 21, mana_weave 7, ashen_step 4

**Arithmetic**

- `mana_weave` 7 → +42 `maxMana`, +2.55 flat regen, 16 % `damageTakenToMana`
- pool **270**, regen 270 × 0.040 + 2.55 = **13.35 mana/s**
- multiplier = (1.10 + 0.14 × 20) × 1.24 synergy = **4.66** per mana spent
- full-pool burn = 270 × 4.66 = **1258.85** fire before resistance, in a 5.95 m nova that **ignores dodge**
- real cadence = the refill, 270 / 13.35 = **20.22 s** — the printed 8.0 s cooldown never binds
- `ashen_step` 4 → a 2.82 s-cooldown blink with a 43 % slow and `blinded`, which is how the build survives the empty bar

| Target | Hit chance | Per landed hit | Burst DPS (1 tgt) | Sustained DPS (1 tgt) | Burst DPS (pack) | Burst window | TTK (sustained) | Landed hits |
|---|---|---|---|---|---|---|---|---|
| Bone Ranker mlvl 30 (level-matched) | 100 % | 2379.22 | 117.64 | 117.64 | 705.84 | ∞ | 3.31 | 0.16 |
| Champion mlvl 30 | 100 % | 1903.38 | 94.11 | 94.11 | 94.11 | ∞ | 16.55 | 0.82 |
| Bone Ranker mlvl 33, Renunciation | 100 % | 1427.53 | 70.58 | 70.58 | 423.5 | ∞ | 8.66 | 0.43 |
| Molgrim mlvl 37, Renunciation | 100 % | 594.81 | 29.41 | 29.41 | 29.41 | ∞ | 610.26 | 26.55 |

**Eight-monster pack, 3 112 life at mlvl 30: 4.41 s → 0.55 s per monster.**

### B-A — Rune Edge (Runeblade)

**Allocation (29 points):** rune_strike 20, cascade 6, blade_seal 3  
**Effective levels (+1 to all skills, quest reward):** rune_strike 21, cascade 7, blade_seal 4

**Arithmetic**

- `rune_strike` = 115 + 7 × 20 = **255 %**, raw 120.19; 100 %-weapon hit = 12.5 × 2.10 × 1.80 × 0.95 × 1.05 = **47.13**
- `cascade` = 70 + 6 × 6 + 7 × 20 = **246 %** as `magic`, raw 115.94, fired every 3rd empowered hit
- `blade_seal` eff 4 → 9.5–20.5 (avg 15) lightning on 3 hits, and it spends the whole bar — 3 charges, the exact number those 3 imbued hits give back
- swing interval 0.65 / 1.40 = **0.4643 s**, seal cast 0.25 / 1.20 = **0.2083 s**
- mana: `rune_strike` costs 5.8 and returns **16 %** of post-mitigation physical (class base 8, doubled); `blade_seal` costs 11.65 per 3 hits
- cycle = 3 strikes + 1 seal = 1.6012 s, and it fires exactly one `cascade`

| Target | Hit chance | Per landed hit | Burst DPS (1 tgt) | Sustained DPS (1 tgt) | Burst DPS (pack) | Burst window | TTK (sustained) | Landed hits |
|---|---|---|---|---|---|---|---|---|
| Bone Ranker mlvl 30 (level-matched) | 70.59 % | 132.15 | 243.56 | 243.56 | 1217.82 | ∞ | 1.6 | 2.9 |
| Champion mlvl 30 | 61.58 % | 117.44 | 190.54 | 190.54 | 190.54 | ∞ | 8.18 | 13.3 |
| Bone Ranker mlvl 33, Renunciation | 65.47 % | 125.16 | 194.8 | 194.8 | 973.99 | ∞ | 3.14 | 4.9 |
| Molgrim mlvl 37, Renunciation | 52.6 % | 108.31 | 123.95 | 123.95 | 123.95 | ∞ | 144.8 | 145.8 |

**Eight-monster pack, 3 112 life at mlvl 30: 2.56 s → 0.32 s per monster.**

### B-B — Storm (Runeblade)

**Allocation (29 points):** discharge 20, thunder_step 6, resonance_circuit 3  
**Effective levels (+1 to all skills, quest reward):** discharge 21, thunder_step 7, resonance_circuit 4

**Arithmetic**

- `discharge` eff 21 → 55–135, average **95**; 6 links, chain multiplier **3.2881**; multiplier 1.05 × 0.95 = **0.9975**
- cast 0.40 / 1.20 = **0.3333 s**, cost **10.65 mana** → 31.95 mana/s at full rate against a 105-point pool
- `resonance_circuit` 4 → `manaReturnPercent` 8 + 6.4 = **14.4 %**, `maxResonance` 4, +0.3 Resonance per hit
- the build is **mana-bound and must melee to cast**: each landed basic swing returns 6.35 mana
- sustainable mix solves 4.48a + 3.15 × (0.4643a + 0.3333b) = 10.65b → **b = 0.619a**, i.e. 0.62 casts per swing
- `thunder_step` eff 7 (+100 % `discharge` synergy) → avg 116 in 3.5 m every 5.1 s, applying `shocked` (+12 % damage taken)

| Target | Hit chance | Per landed hit | Burst DPS (1 tgt) | Sustained DPS (1 tgt) | Burst DPS (pack) | Burst window | TTK (sustained) | Landed hits |
|---|---|---|---|---|---|---|---|---|
| Bone Ranker mlvl 30 (level-matched) | 70.59 % | 94.76 | 284.29 | 133.97 | 934.76 | 3.65 s | 2.9 | 4.1 |
| Champion mlvl 30 | 61.58 % | 75.81 | 227.43 | 100.14 | 227.43 | 3.65 s | 15.56 | 20.6 |
| Bone Ranker mlvl 33, Renunciation | 65.47 % | 56.86 | 170.57 | 92.92 | 560.86 | 3.65 s | 6.58 | 10.7 |
| Molgrim mlvl 37, Renunciation | 52.6 % | 23.69 | 71.07 | 50.69 | 71.07 | 3.65 s | 354.05 | 666.7 |

**Eight-monster pack, 3 112 life at mlvl 30: 3.33 s → 0.42 s per monster.**

### B-C — Unity (Runeblade)

**Allocation (29 points):** unity 8, discharge 18, rune_strike 3  
**Effective levels (+1 to all skills, quest reward):** unity 9, discharge 19, rune_strike 4

**Arithmetic**

- `discharge` eff 19 → 49.8–122.6, average **86.2**; 6 links, chain multiplier **3.2881**
- `unity` eff 9 → duration 8 + 0.2 × 8 = **9.6 s** against a 30 s cooldown = **32 % uptime**; cost 38.8 mana
- `discharge` → `unity` synergy = 6 × 18 = **+108 %** on every free cast
- free chain per landed swing = 86.2 × 0.9975 × 3.2881 × 2.08 = **588.07** across six links
- `rune_strike` eff 4 = 136 %, raw 64.1, and it is what pays for the next `unity`
- outside the window the build casts `discharge` at the mana-bound rate; inside it, every swing is free

| Target | Hit chance | Per landed hit | Burst DPS (1 tgt) | Sustained DPS (1 tgt) | Burst DPS (pack) | Burst window | TTK (sustained) | Landed hits |
|---|---|---|---|---|---|---|---|---|
| Bone Ranker mlvl 30 (level-matched) | 70.59 % | 239.95 | 364.81 | 199.69 | 1199.52 | 9.6 s | 1.95 | 1.6 |
| Champion mlvl 30 | 61.58 % | 198.07 | 262.72 | 141.18 | 262.72 | 9.6 s | 11.04 | 7.9 |
| Bone Ranker mlvl 33, Renunciation | 65.47 % | 167.41 | 236.05 | 139.85 | 776.16 | 9.6 s | 4.37 | 3.6 |
| Molgrim mlvl 37, Renunciation | 52.6 % | 98.8 | 111.94 | 77.53 | 111.94 | 9.6 s | 231.48 | 159.9 |

**Eight-monster pack, 3 112 life at mlvl 30: 2.59 s → 0.32 s per monster.**

### 9.4 The nine builds against the locked targets

| Build | Sustained DPS (A) | Landed hits (A) | Pack clear, 8 bodies | Per monster | Champion TTK | Molgrim TTK (D) |
|---|---|---|---|---|---|---|
| R-A Cleaver | 227.83 | 1.4 | 3.41 s | 0.43 s | 10.39 s | 154.5 s |
| R-B Whirlwind | 436.13 | 1.1 | 2.38 s | 0.30 s | 4.59 s | 79.4 s |
| R-C Bulwark | 210.05 | 0.7 | 5.70 s | 0.71 s | 8.04 s | 110.4 s |
| E-A Bolt | 265.79 | 2.6 | 2.53 s | 0.32 s | 7.33 s | 270.1 s |
| E-B Meteor | 291.49 | 0.4 | 1.14 s | 0.14 s | 6.68 s | 246.3 s |
| E-C Essence | 117.64 | 0.2 | 4.41 s | 0.55 s | 16.55 s | 610.3 s |
| B-A Rune Edge | 243.56 | 2.9 | 2.56 s | 0.32 s | 8.18 s | 144.8 s |
| B-B Storm | 133.97 | 4.1 | 3.33 s | 0.42 s | 15.56 s | 354.1 s |
| B-C Unity | 199.69 | 1.6 | 2.59 s | 0.32 s | 11.04 s | 231.5 s |
| **Median** | **227.83** | — | **2.59 s** | **0.32 s** | **8.18 s** | **231.5 s** |

**Against the pacing targets.**

| Target | Required | Result | Verdict |
|---|---|---|---|
| Normal monster, hits | 2–4 | the free action takes **2.32** landed hits (Ravager basic, `389 / 167.69`), **2.64** (`ember_bolt`), **2.94** (`rune_strike`) | **met** |
| Normal monster, time | 1.5–3.0 s | basic attack 2.72 s (Ravager); every *skill* rotation kills faster | **met by the basic attack; skills deliberately beat it** |
| Pack of 8 | the same window per monster | 0.14–0.71 s per monster | **met** — a maxed skill is an AoE upgrade, not a single-target one |
| Champion | ≈ 10 s | 4.59–16.55 s, median **8.18 s** | **met at the median**; the spread is Finding 1 |
| Boss (Instruction) | 60–90 s | verified at `clvl 13` vs `mlvl 15` in `03-combat-math.md` §11.4 (76.1 / 63.9 / 86.0 s) | **met** |
| Boss (Renunciation, rare gear) | 60–90 s | 79.4–610.3 s | **not met across the set** — see below |
| Build DPS spread from the median | < 2× (M7 gate) | 436.13 / 227.83 = **1.91×** high, 227.83 / 117.64 = **1.94×** low | **met on both sides** |

**Finding 1 — the spread is 1.94×, and the binding side is the floor, not the
ceiling.** With `whirlwind` at its 0.55 s tick (**D-05-1**) the widest build is
`E-C Essence` at **1.94× below** the median, not R-B at 1.91× above it. That
floor is a deliberate shape and not a defect: `essence_burn` trades sustained
throughput for a single detonation whose size is a function of the mana pool, so
it measures badly on a DPS column and well on a burst column the yardsticks do
not have. It sits inside the gate and is left alone. The ceiling that used to be
Finding 1 — a 0.35 s tick delivering `2.07 × 2.857 = 591 %` of weapon damage per
second against `cleaving_strike`'s `1.664 / 0.84375 = 197 %/s` — is closed by the
decision recorded in §12.4.

**Finding 2 — Renunciation Molgrim needs a gear tier this document does not
own.** To land 15 794 life inside 90 s at `U = 0.88` a build needs
`15794 / (90 × 0.88) = **199 sustained DPS** against yardstick D. Only R-B
(226) and R-C (163, close) approach it on rare gear; the median build reaches
116. The multiplier required over the §9.1 kit is **1.7× for the Ravager, 3.0×
for the Emberwright, 1.6× for the Runeblade** — which is precisely the job of
elite bases, uniques and resistance-piercing affixes, all owned by the items
specification. This is a gear-progression requirement, not a skill defect: the
same builds hit the target in Instruction, where §11.4 already proves it.

**Finding 3 — the Emberwright's boss numbers are resistance, not damage.**
E-A deals 147.42 per bolt against yardstick A and 36.86 against D — a **4×**
collapse, of which 3× is the 75 % resistance clamp. The class's boss answer is
`fireResistPierce` (an items-side stat) and `sunder`-style resistance
stripping, which it does not have. That asymmetry is intentional class identity
— the Emberwright is the pack class — but it is why `meteor`'s ground pool,
which `molgrim` never paths around, is the difference between E-B and E-A on
the boss.

**Finding 4 — every build spends its last points on a synergy, not a skill.**
Eight of the nine allocations put 3–10 points into a source skill purely for its
coefficient. That is the intended shape: with 29 points and a 20-point cap, the
second skill is always cheaper as a multiplier on the first than as a second
rotation button.


---

## 10. Balance table

All thirty skills on one page, each measured **in isolation on its own cadence**
at effective level 20, using the reference multipliers of §1.5 and the
pack-occupancy model in the same section. Isolation is the point: it makes an
outlier visible without a build hiding it behind a synergy.

Cadence rules used in the table:

- an attack or cast uses its own interval at the clvl-10 reference build with
  no IAS or FCR;
- a skill on a cooldown uses `max(interval, cooldown)`;
- `whirlwind` uses its 0.55 s tick, and its cost column is the per-tick share of the 7.25 rage/s drain (`7.25 × 0.55 = 3.99`);
- `essence_burn` uses its **refill time** (108 mana ÷ 4.32 mana/s = 25 s), not
  its printed 8 s cooldown, because the pool is what actually gates it;
- `cascade` uses the three-empowered-hit period, 1.95 s at a 0.65 s swing;
- `blade_seal` uses one seal covering five imbued hits, 3.50 s;
- passives have no cadence and no damage per use, and carry a utility rating
  instead.

`Dmg / resource` divides the pack figure by the numeric part of the cost. It is
the column that answers "is this skill worth pressing", and it is the one the
harness asserts a spread on.

| # | Skill | Class · tree | Cost @ L20 | Cadence s | Ref. dmg / use | Pack tgts | Ref. dmg / use (pack) | Ref. DPS 1 tgt | Ref. DPS pack | Dmg / resource (pack) | Utility | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `cleaving_strike` | Rav · carnage | 10.75 rage | 0.71 | 55.73 | 4 | 222.92 | 78.63 | 314.53 | 20.74 | ★★ | Cone; the AoE baseline |
| 2 | `bloodletting` | Rav · carnage | 13.7 rage | 0.68 | 151.33 | 1 | 151.33 | 224.2 | 224.2 | 11.05 | ★★★ | Hit + its own 5 s bleed (1.35 × the hit at 0.27/s) |
| 3 | `whirlwind` | Rav · carnage | 3.99 rage/tick | 0.55 | 45.6 | 3 | 136.8 | 82.91 | 248.73 | 34.31 | ★★★★ | Channel; hit-recovery immune |
| 4 | `bloodthirst` | Rav · carnage | — | — | — | — | — | — | — | — | ★★★★ | Passive: 20.1 % life steal — the class sustain |
| 5 | `sunder` | Rav · carnage | 23.5 rage | 6 | 104.78 | 5 | 523.88 | 17.46 | 87.31 | 22.29 | ★★★★★ | Nova + `cursed` 59 at 100 % uptime |
| 6 | `ram_charge` | Rav · unyielding | 17.6 rage | 4.2 | 81.11 | 3 | 243.32 | 19.31 | 57.93 | 13.82 | ★★★★★ | Gap-close, 2.45 s stun, interrupt |
| 7 | `shield_stance` | Rav · unyielding | — | — | — | — | — | — | — | — | ★★★★ | Passive: +38.4 block, 82 thorns, +12.5 dodge |
| 8 | `war_cry` | Rav · unyielding | 29.4 rage | 14 | — | 8 | — | — | — | — | ★★★★★ | 7 m stun + 53 % ED for 12 s; zero damage |
| 9 | `iron_skin` | Rav · unyielding | — | — | — | — | — | — | — | — | ★★★★ | Passive: +120 % defence, +10.5 physical resist |
| 10 | `last_stand` | Rav · unyielding | — | 52 | — | — | — | — | — | — | ★★★★ | Passive trigger: 458 absorb + 40 rage |
| 11 | `ember_bolt` | Emb · flame | 6.75 mana | 0.47 | 81.38 | 3 | 244.13 | 174.06 | 522.19 | 36.17 | ★★★ | Pierces from level 10 |
| 12 | `flame_wave` | Emb · flame | 14.5 mana | 0.55 | 172.61 | 5 | 863.07 | 312.42 | 1562.11 | 59.52 | ★★★ | Cone; figure includes the 4 s burn |
| 13 | `fireball` | Emb · flame | 20.3 mana | 0.51 | 225.75 | 4 | 903 | 442.65 | 1770.59 | 44.48 | ★★ | Projectile with a 3.37 m blast |
| 14 | `meteor` | Emb · flame | 38.8 mana | 4 | 915.6 | 5 | 4578 | 228.9 | 1144.5 | 117.99 | ★★★★★ | Impact + 6 s pool; `nav` hazard |
| 15 | `incinerate` | Emb · flame | — | — | — | — | — | — | — | — | ★★★★ | Passive: +88 % fire, 82 % corpse detonation |
| 16 | `ashen_step` | Emb · ash | 13.6 mana | 1.86 | — | — | — | — | — | — | ★★★★★ | Blink 9.9 m, `slowed` 59 + `blinded`; zero damage |
| 17 | `mana_weave` | Emb · ash | — | — | — | — | — | — | — | — | ★★★★★ | Passive: +126 mana, +7.45 regen, 29 % damage→mana |
| 18 | `smouldering_ward` | Emb · ash | 31 mana | 10 | 300.56 | 5 | 1502.81 | 30.06 | 150.28 | 48.48 | ★★★★ | 520 absorb, then a 3.5 m burst |
| 19 | `ash_wall` | Emb · ash | 34.9 mana | 12 | 762.3 | 3 | 2286.9 | 63.52 | 190.57 | 65.53 | ★★★★★ | Blocks enemy projectiles; figure is 8 s of standing in it |
| 20 | `essence_burn` | Emb · ash | 248 mana | 25 | 1223.88 | 6 | 7343.28 | 48.96 | 293.73 | 29.61 | ★★★ | Whole pool; ignores dodge; cadence is the refill |
| 21 | `rune_strike` | Run · enchanted_blade | 5.8 mana | 0.65 | 58.44 | 1 | 58.44 | 89.91 | 89.91 | 10.08 | ★★★★ | Doubles mana return; +1 Resonance like any landed hit |
| 22 | `blade_seal` | Run · enchanted_blade | 11.65 mana + whole bar | 3.5 | 354.11 | 1 | 354.11 | 101.17 | 101.17 | 30.4 | ★★★★★ | Imbues 5 hits; cold path freezes |
| 23 | `cascade` | Run · enchanted_blade | — | 1.95 | 43.36 | 5 | 216.81 | 22.24 | 111.18 | — | ★★★★ | Free `magic` nova every 3 empowered hits |
| 24 | `phase_leap` | Run · enchanted_blade | 22.3 mana | 2.72 | 73.29 | 1 | 73.29 | 26.94 | 26.94 | 3.29 | ★★★★ | Teleport behind the target, then strike |
| 25 | `echo_blade` | Run · enchanted_blade | 50.5 mana | 25 | 443.98 | 1 | 443.98 | 17.76 | 17.76 | 8.79 | ★★★ | Untargetable duplicate for 15.7 s |
| 26 | `discharge` | Run · conduit | 10.65 mana | 0.4 | 90.37 | 3.29 | 297.16 | 225.93 | 742.89 | 27.9 | ★★★ | 6 links, −25 % per jump |
| 27 | `resonance_circuit` | Run · conduit | — | — | — | — | — | — | — | — | ★★★★★ | Passive: +2 max Resonance, +19.2 % mana return |
| 28 | `polarity` | Run · conduit | 10 mana / switch | — | — | — | — | — | — | — | ★★★★ | Toggle: ±68/−15 on one damage type |
| 29 | `thunder_step` | Run · conduit | 26.2 mana | 3.15 | 148.63 | 4 | 594.51 | 47.18 | 188.73 | 22.69 | ★★★★★ | Dash + nova + `shocked` (+12 % taken) |
| 30 | `unity` | Run · conduit | 56.4 mana | 30 | 4040.32 | 1 | 4040.32 | 134.68 | 134.68 | 71.64 | ★★★★ | 11.8 s of free `discharge`; the figure is already the full 5-link chain |

**Pack-DPS ranking (reference multipliers, effective level 20):**

| Rank | Skill | Ref. pack DPS |
|---|---|---|
| 1 | `fireball` | 1770.59 |
| 2 | `flame_wave` | 1562.11 |
| 3 | `meteor` | 1144.5 |
| 4 | `discharge` | 742.89 |
| 5 | `ember_bolt` | 522.19 |
| 6 | `cleaving_strike` | 314.53 |
| 7 | `essence_burn` | 293.73 |
| 8 | `whirlwind` | 248.73 |
| 9 | `bloodletting` | 224.2 |
| 10 | `ash_wall` | 190.57 |
| 11 | `thunder_step` | 188.73 |
| 12 | `smouldering_ward` | 150.28 |
| 13 | `unity` | 134.68 |
| 14 | `cascade` | 111.18 |
| 15 | `blade_seal` | 101.17 |
| 16 | `rune_strike` | 89.91 |
| 17 | `sunder` | 87.31 |
| 18 | `ram_charge` | 57.93 |
| 19 | `phase_leap` | 26.94 |
| 20 | `echo_blade` | 17.76 |
### 10.1 Outliers, and which are intentional

| Skill | Figure | Reading | Intentional? |
|---|---|---|---|
| `fireball` | **1 770.59** pack DPS — highest in the game | 225.75 per cast every 0.51 s across four bodies, with no cooldown and no cast-time penalty | **No.** It is 13 % above `flame_wave` while costing 40 % more mana, which makes `flame_wave` the strictly better cone and `fireball` the strictly better everything-else. The mana column is the corrective: 44.48 against `flame_wave`'s 59.52. A caster that presses `fireball` empties in 12.7 s; one that presses `flame_wave` lasts 17.8 s. Playable, but the two skills are closer than the tree wants |
| `flame_wave` | **1 562.11** pack DPS, **59.52** per mana | the best damage-per-mana in the Flame tree | **Yes.** It is the level-6 skill and it has a 90° arc — it converts positioning into damage, which is the Emberwright's entire skill expression |
| `meteor` | **117.99** damage per mana, 2.6× the next best | the impact plus six seconds of pool, on a 4 s cooldown, at 38.8 mana | **Yes.** It is a capstone, it needs a prerequisite, it has a 1.20 s telegraphed fall a monster can walk out of, and its pool calls `nav.markHazard()` so competent packs leave it |
| `unity` | **71.64** damage per mana, 4 040 per cast | 18.2 free six-link chains for one 56.4-mana button | **Yes,** and it is rate-limited by the 0.25 s attack-interval floor to 4 chains/s — see §12.4 |
| `essence_burn` | **293.73** pack DPS, **29.61** per mana | the whole pool in one nova every 25 s of refill | **Yes.** It is the low end of the build spread (E-C at 1.94× below the median) because a DPS column cannot express a burst skill; the refill time, not the cooldown, is what gates it |
| `whirlwind` | **248.73** pack DPS at 3.99 rage per tick | 131 % of weapon damage every 0.55 s | **Yes, now.** At the original 0.35 s tick it was 390.86 and drove a 3.01× build spread; **D-05-1** moved the period and it now sits eighth of twenty, between `essence_burn` and `bloodletting` |
| `echo_blade` | **17.76** pack DPS — lowest of any active | 78 % of weapon damage on a duplicate that runs 62.8 % of a 25 s cooldown | **Yes.** It is the only capstone that costs nothing to maintain, cannot be killed, and stacks multiplicatively with every weapon upgrade the Runeblade will ever find. Its floor is low because its ceiling is gear |
| `phase_leap` | **26.94** pack DPS, **3.29** per mana — worst ratio in the game | 311 % of weapon damage on a 2.72 s cooldown for 22.3 mana | **Yes.** It is priced as mobility. A 10 m teleport that lands behind the target, breaks the block arc and closes onto an `ashen_archer` is worth more than its damage column says |
| `sunder` | **87.31** pack DPS, ★★★★★ utility | 301 % of weapon damage every 6 s | **Yes.** The damage is the smaller half. `cursed` at magnitude 59 is −59 % target defence and −22 to every resistance at **100 % uptime**, which raises the Ravager's own hit chance from 68.47 % to 84.44 % and multiplies any elemental follow-up by 1.44 against a 50-resist target |
| `ashen_step`, `war_cry` | **zero damage**, ★★★★★ | — | **Yes.** Two of the thirty skills deal no damage at any level. A tree in which every entry is a damage number is a tree with no decisions in it |

**Strongest skill in the set: `fireball`, and it is the mana column that says
so.** At 1 770.59 reference pack DPS it leads the raw ranking outright, and
unlike the capstones above it in damage-per-cast it carries no cooldown, no
prerequisite and no telegraph. What holds it is the pool: 44.48 damage per mana
against `flame_wave`'s 59.52, and 12.7 seconds of unbroken casting before the
bar is empty.

`whirlwind` is the strongest *shape*. At 248.73 pack DPS it is eighth of twenty,
but it is the only skill in the game that costs a resource the class regenerates
from the act of using it, is immune to hit recovery, moves at 70 % speed while
active, and has no cooldown, no cast time and no mana. That combination is why
its throughput is priced below its rank — and why the tick period, not the
coefficient, was the number **D-05-1** moved.

**Weakest skill in the set: `echo_blade`.** 17.76 reference pack DPS is 7.1 %
of `whirlwind`, and it is a level-18 capstone competing for the same points as
`unity` (134.68) and the same tree slot as a maxed `rune_strike`. Its damage
coefficient is the smallest capstone coefficient in the game (78 % at level 20
against `sunder`'s 301 %, `meteor`'s 388 average and `unity`'s free chains), and
40 % of it is spent standing still on a 25 s cooldown. It is deliberately the
"free damage while you keep playing normally" capstone, but the arithmetic puts
it a tier below its two siblings and any future re-tune should start there.

### 10.2 Spread check

| Metric | Min | Median | Max | Max ÷ median |
|---|---|---|---|---|
| Reference pack DPS (20 damaging skills) | 17.76 (`echo_blade`) | 189.65 | 1 770.59 (`fireball`) | **9.3×** |
| Reference pack DPS, the 10 skills with no cooldown | 89.91 (`rune_strike`) | 281.63 | 1 770.59 | 6.3× |
| Damage per resource point (19 costed skills) | 3.29 (`phase_leap`) | 29.61 | 117.99 (`meteor`) | **4.0×** |
| Damage per resource, within a class | Ravager 11.05–34.31 | Emberwright 29.61–117.99 | Runeblade 3.29–71.64 | 3.1× / 4.0× / **21.8×** |

A 9.3× spread on raw pack DPS is expected and not a defect: a level-1 skill on
no cooldown and a level-18 capstone on a 30 s cooldown are not comparable
per second, which is exactly why §9 measures **builds** and not skills. The
number the M7 gate cares about is the build spread, and that is 1.91×.

The Runeblade's 21.8× internal spread on damage-per-resource is the one
class-level warning: `phase_leap` at 3.29 and `unity` at 71.64 sit in the same
class, and a player reading only the numbers will never press `phase_leap`. The
mitigation is that it is the class's only targeted teleport; the harness asserts
it separately as a utility skill (§13.2).


---

## 11. Resource economy

Three thirty-second simulations, one per class, run at the real fixed step
`h = 1/60 s` and sampled once per second. Hit chance and damage are carried as
expected values so the tables are reproducible without a seed; `tools/balance.mjs`
runs the same loop with the deterministic `combat` stream and asserts the
one-second totals to ±2 %.

All three use the level-30 reference kits of §9.1 and the level-30 build listed.
The question each answers is the same: **does the class's loop close?**

#### 11.1 Ravager — Rage, build R-A against three waves of eight

Waves of eight Bone Rankers at mlvl 30 arrive at **t = 0, 12 and 24 s**; at most four are in contact at once. Cleaving Strike costs 11 rage and swings every 0.8438 s against 4 bodies; the basic attack is free and swings every 0.8036 s. Player hit chance 68.47 %, monster hit chance 55.6 % against DEF 432 for 61.6 damage. Rage: **+6 per landed action** (one award per action, never per target), **+4 per hit taken**, **+8 per kill**, **−8/s after 4 s out of combat**, cap 100. Bloodthirst 7 returns 8.4 % of physical dealt; the belt holds four `potion_life_greater`.

| t (s) | Alive | Actions | +hits | +taken | +kills | −spent | −decay | Rage end | Kills total | Life |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 6 | 2 | 8.22 | 8.9 | 16 | 11 | 0 | 22.11 | 2 | 274.72 |
| 2 | 4 | 1 | 4.11 | 8.9 | 16 | 11 | 0 | 40.12 | 4 | 204.44 |
| 3 | 2 | 1 | 4.11 | 4.45 | 16 | 11 | 0 | 53.67 | 6 | 202.67 |
| 4 | 1 | 1 | 4.11 | 0 | 8 | 11 | 0 | 54.78 | 7 | 237.06 |
| 5 | 1 | 1 | 4.11 | 2.22 | 0 | 11 | 0 | 50.11 | 7 | 221.05 |
| 6 | 0 | 1 | 4.11 | 0 | 8 | 11 | 0 | 51.22 | 8 | 239.28 |
| 7 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 51.22 | 8 | 241.35 |
| 8 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 51.22 | 8 | 243.42 |
| 9 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 51.22 | 8 | 245.49 |
| 10 | 0 | 0 | 0 | 0 | 0 | 0 | 7.47 | 43.75 | 8 | 247.56 |
| 11 | 0 | 0 | 0 | 0 | 0 | 0 | 8 | 35.75 | 8 | 249.63 |
| 12 | 6 | 1 | 4.11 | 8.9 | 16 | 11 | 7.87 | 45.89 | 10 | 179.35 |
| 13 | 4 | 1 | 4.11 | 0 | 16 | 11 | 0 | 55 | 12 | 246.07 |
| 14 | 2 | 1 | 4.11 | 8.9 | 16 | 11 | 0 | 73 | 14 | 216.05 |
| 15 | 1 | 1 | 4.11 | 2.22 | 8 | 11 | 0 | 76.33 | 15 | 285.19 |
| 16 | 1 | 1 | 4.11 | 0 | 0 | 11 | 0 | 69.44 | 15 | 345 |
| 17 | 0 | 1 | 4.11 | 2.22 | 8 | 11 | 0 | 72.77 | 16 | 344.7 |
| 18 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 72.77 | 16 | 345 |
| 19 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 72.77 | 16 | 345 |
| 20 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 72.77 | 16 | 345 |
| 21 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 66.77 | 16 | 345 |
| 22 | 0 | 0 | 0 | 0 | 0 | 0 | 8 | 58.77 | 16 | 345 |
| 23 | 0 | 0 | 0 | 0 | 0 | 0 | 8 | 50.77 | 16 | 345 |
| 24 | 0 | 0 | 0 | 0 | 0 | 0 | 8 | 42.77 | 16 | 345 |
| 25 | 4 | 2 | 8.22 | 8.9 | 32 | 22 | 0 | 69.88 | 20 | 274.72 |
| 26 | 2 | 1 | 4.11 | 8.9 | 16 | 11 | 0 | 87.89 | 22 | 204.44 |
| 27 | 1 | 1 | 4.11 | 2.22 | 8 | 11 | 0 | 91.22 | 23 | 204.59 |
| 28 | 1 | 1 | 4.11 | 0 | 0 | 11 | 0 | 84.33 | 23 | 222.82 |
| 29 | 0 | 1 | 4.11 | 0 | 8 | 11 | 0 | 85.44 | 24 | 241.06 |
| 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 85.44 | 24 | 243.13 |

#### 11.2 Emberwright — Mana, build E-A over 30 s of unbroken casting

Pool **258** (228 base + 30 from `mana_weave` 4), regen **12.17 mana/s**, `ember_bolt` at **6.75 mana** every **0.3596 s** = **18.77 mana/s**. `damageTakenToMana` 13 % against 25 incoming DPS returns **3.25 mana/s**. Net **-3.35 mana/s**.

| t (s) | Casts | +mana regen | +mana from damage | −mana spent | Mana end | Dry time (s) |
|---|---|---|---|---|---|---|
| 1 | 3 | 12.17 | 3.25 | 20.25 | 252.91 | 0 |
| 2 | 3 | 12.17 | 3.25 | 20.25 | 248.08 | 0 |
| 3 | 3 | 12.17 | 3.25 | 20.25 | 243.25 | 0 |
| 4 | 2 | 12.17 | 3.25 | 13.5 | 245.17 | 0 |
| 5 | 3 | 12.17 | 3.25 | 20.25 | 240.34 | 0 |
| 6 | 3 | 12.17 | 3.25 | 20.25 | 235.51 | 0 |
| 7 | 3 | 12.17 | 3.25 | 20.25 | 230.68 | 0 |
| 8 | 2 | 12.17 | 3.25 | 13.5 | 232.6 | 0 |
| 9 | 3 | 12.17 | 3.25 | 20.25 | 227.77 | 0 |
| 10 | 3 | 12.17 | 3.25 | 20.25 | 222.94 | 0 |
| 11 | 2 | 12.17 | 3.25 | 13.5 | 224.86 | 0 |
| 12 | 3 | 12.17 | 3.25 | 20.25 | 220.03 | 0 |
| 13 | 3 | 12.17 | 3.25 | 20.25 | 215.2 | 0 |
| 14 | 3 | 12.17 | 3.25 | 20.25 | 210.37 | 0 |
| 15 | 2 | 12.17 | 3.25 | 13.5 | 212.29 | 0 |
| 16 | 3 | 12.17 | 3.25 | 20.25 | 207.46 | 0 |
| 17 | 3 | 12.17 | 3.25 | 20.25 | 202.63 | 0 |
| 18 | 3 | 12.17 | 3.25 | 20.25 | 197.8 | 0 |
| 19 | 2 | 12.17 | 3.25 | 13.5 | 199.72 | 0 |
| 20 | 3 | 12.17 | 3.25 | 20.25 | 194.89 | 0 |
| 21 | 3 | 12.17 | 3.25 | 20.25 | 190.06 | 0 |
| 22 | 2 | 12.17 | 3.25 | 13.5 | 191.98 | 0 |
| 23 | 3 | 12.17 | 3.25 | 20.25 | 187.15 | 0 |
| 24 | 3 | 12.17 | 3.25 | 20.25 | 182.32 | 0 |
| 25 | 3 | 12.17 | 3.25 | 20.25 | 177.49 | 0 |
| 26 | 2 | 12.17 | 3.25 | 13.5 | 179.41 | 0 |
| 27 | 3 | 12.17 | 3.25 | 20.25 | 174.58 | 0 |
| 28 | 3 | 12.17 | 3.25 | 20.25 | 169.75 | 0 |
| 29 | 3 | 12.17 | 3.25 | 20.25 | 164.92 | 0 |
| 30 | 2 | 12.17 | 3.25 | 13.5 | 166.84 | 0 |

#### 11.3 Runeblade — Mana and Resonance, build B-A over 30 s

Pool **105**, regen **3.15 mana/s**. `rune_strike` costs **5.8** and returns **16 %** of 117.19 post-mitigation physical at 70.59 % hit chance = **13.24 mana per swing**, so each swing is **+7.44 mana net**. `blade_seal` costs **11.65 mana and the whole Resonance bar** (03 §2.4) and is recast whenever the imbue runs dry. `maxResonance` is **3** in this build (no `resonance_circuit`); each landed hit grants **1**, `rune_strike` included — it carries no extra charge.

The mana columns below are unchanged from the run that produced this table: the Resonance rule touches no mana quantity. Only the last two columns moved.

| t (s) | Strikes | Seals | +mana returned | +mana regen | −mana spent | Mana end | Resonance | Res. overflow | Cascades |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 1 | 26.47 | 3.15 | 23.25 | 102.41 | 0 | 0 | 0 |
| 2 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 1.41 | 0 | 0 |
| 3 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 2.82 | 0 | 1 |
| 4 | 2 | 1 | 26.47 | 3.15 | 23.25 | 105 | 0 | 1.24 | 1 |
| 5 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 1.41 | 0 | 2 |
| 6 | 2 | 1 | 26.47 | 3.15 | 23.25 | 102.1 | 0 | 0 | 2 |
| 7 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 1.41 | 0 | 3 |
| 8 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 2.82 | 0 | 3 |
| 9 | 2 | 1 | 26.47 | 3.15 | 23.25 | 105 | 0 | 1.24 | 4 |
| 10 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 1.41 | 0 | 4 |
| 11 | 2 | 1 | 26.47 | 3.15 | 23.25 | 101.78 | 0 | 0 | 5 |
| 12 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 1.41 | 0 | 5 |
| 13 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 2.82 | 0 | 6 |
| 14 | 2 | 1 | 26.47 | 3.15 | 23.25 | 105 | 0 | 1.24 | 6 |
| 15 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 1.41 | 0 | 7 |
| 16 | 2 | 1 | 26.47 | 3.15 | 23.25 | 101.47 | 0 | 0 | 7 |
| 17 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 1.41 | 0 | 8 |
| 18 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 2.82 | 0 | 8 |
| 19 | 1 | 1 | 13.24 | 3.15 | 17.45 | 102.89 | 0 | 0.53 | 8 |
| 20 | 3 | 0 | 39.71 | 3.15 | 17.4 | 105 | 2.12 | 0 | 9 |
| 21 | 1 | 1 | 13.24 | 3.15 | 17.45 | 93.72 | 0 | 0 | 9 |
| 22 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 1.41 | 0 | 10 |
| 23 | 3 | 0 | 39.71 | 3.15 | 17.4 | 105 | 3 | 0.53 | 10 |
| 24 | 1 | 1 | 13.24 | 3.15 | 17.45 | 102.57 | 0 | 0.71 | 11 |
| 25 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 1.41 | 0 | 11 |
| 26 | 2 | 1 | 26.47 | 3.15 | 23.25 | 93.4 | 0 | 0 | 12 |
| 27 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 1.41 | 0 | 12 |
| 28 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 2.82 | 0 | 12 |
| 29 | 2 | 1 | 26.47 | 3.15 | 23.25 | 102.26 | 0 | 1.24 | 13 |
| 30 | 2 | 0 | 26.47 | 3.15 | 11.6 | 105 | 1.41 | 0 | 13 |

### 11.4 What the three simulations show

| Class | Does the loop close? | Binding constraint | Failure mode when it breaks |
|---|---|---|---|
| Ravager | **Yes, in packs; no, on a boss** | kills. `+8` per kill is 61 % of all rage earned in the wave simulation | Against a single target the income falls to `6 × 0.5041 / 0.8036 = 3.76 /s` and `cleaving_strike` at 13.04 rage/s runs a **−9.28 /s** deficit — 10.8 s of skill use, then basic attacks |
| Emberwright | **No, and deliberately** | the pool. 18.77 mana/s out against 15.42 in | 77 s of unbroken casting, then a hard stop. The belt and `mana_weave` are the whole answer, and running dry is the class's designed failure |
| Runeblade | **Yes for mana; Resonance now binds** | position. Both income lines are zero outside weapon range | Each `rune_strike` is **+7.44 mana net** and the pool sits pinned at 105 from t = 2 s onward — mana is a floor problem, not a ceiling one. Resonance cycles 0 → 3 → 0 twelve times in the trace and discards **16.1 %**, inside the 30 % gate. See §12.5 |

**Ravager — the decay window matters.** Between waves the simulation shows rage
falling 8 per second from t = 10 and t = 21, exactly as `03-combat-math.md` §2.4
specifies after 4.0 s out of combat. Over the 30 s the Ravager loses 45.3 rage
to decay — four Cleaving Strikes — which is why a Ravager runs *into* the next
pack rather than resting between them. That is the mechanic working.

**Emberwright — the potion is part of the rotation, not a mistake.** At the
observed drain the pool empties at t ≈ 77 s. A `potion_mana_greater` restores
60 % of 258 = 154.8 mana over 3 s, i.e. **51.6 mana/s** — 2.75× the drain — so
one potion buys 46 s of casting and a four-slot belt buys 184 s. The boss fight
in `03-combat-math.md` §11.4 ends with an empty belt on purpose, and this
simulation is the same shape one difficulty tier later.

**Runeblade — mana never binds, and Resonance now does.** After the opening
`blade_seal` the pool is pinned at maximum for 28 of the 30 seconds; that half
of the class economy is a floor problem, not a ceiling one, and §12.5 records
the locks that keep it from being degenerate. Resonance is the half that moved.
Under the rule of 03 §2.4 — `blade_seal` spends the whole bar, `rune_strike`
carries no extra charge — the trace shows the bar cycling **0 → 3 → 0** twelve
times instead of standing at maximum, and **6.7 of the 41.7 charges generated
are discarded (16.1 %)** against the 30 % gate. The identity behind it is exact:
an imbue window is consumed by *landed* hits and a landed hit is exactly what
grants a charge, so a three-charge seal is paid for by the three hits it
imbues — one in, one out, whatever the hit chance. The residual 16 % is the gap
between the trace's observed seal cadence (4.92 swings) and the analytic one
(4.25 swings); in steady state the figure is **0 %**.

The corollary is that the Runeblade's limiter is **positional, not numeric**:
the class must stand in weapon range to earn anything at all, and both its
income lines (`manaReturnPercent`, `resonanceOnHit`) are zero at range. Against
`ashen_archer` and `dust_shaman`, both of which hold distance, a Runeblade with
no `phase_leap` or `thunder_step` has no economy whatsoever. That is the trade
the class makes.

---

## 12. Anti-patterns

Seven ways this skill set could become degenerate, and the exact mechanism that
prevents each. Every mechanism is either a number already in
`03-combat-math.md` or a rule stated in §1.6 of this document.

### 12.1 Multi-target rage farming → infinite `whirlwind`

**The loop.** If `+6 rage per landed hit` were credited once per *target*, a
360° skill would fund itself. `whirlwind` against three bodies would earn
`6 × 3 / 0.55 = 32.7 rage/s` against a 12 rage/s drain — a net **+20.7/s**,
capped only by the bar. `cleaving_strike` against four would earn 28.4/s against
a 13.0/s cost. Rage would stop being a resource.

**The lock.** Reading **R1** of §1.6: **one rage award per action**, credited on
the first landed hit, regardless of how many targets resolved. Reading **R2**: a
channel earns at the actor's `attackInterval` cadence, not its tick cadence.
Together they reproduce `03-combat-math.md` §2.4 and E9 exactly
(`0.778146 × 6 / 0.675 = 6.9161 /s`, `6.9161 − 12 = −5.0839 /s`, 19.67 s of
channel from a full bar), and they are the only reading under which both of
those printed figures are true.

**Assertion.** `balance.mjs` runs a 10 s `whirlwind` channel against 1, 3 and 8
targets and asserts identical rage income in all three.

### 12.2 `incinerate` corpse-explosion chains

**The loop.** A detonation for 82 % of a victim's `maxLife` in a 2.5 m radius,
inside a pack of 5–12 monsters standing 1–2 m apart, kills its neighbours. If
those deaths detonated, one `ember_bolt` would clear a screen — and in a pack
with mixed life totals the chain would terminate only when the last body died.

**The lock.** `03-combat-math.md` §8.3 states plainly that the detonation
**does not chain**. This document implements it as a re-entrancy guard: a
detonation packet carries a flag that suppresses `incinerate` on any kill it
causes, and the guard is set for the whole emitting fixed step so a death
resolved later in the same step is also covered. Burn ticks seeded by a
detonation likewise cannot re-detonate.

**Assertion.** Nine monsters at 1.2 m spacing, one killed by fire: exactly one
`immolate.explode` and at most one round of deaths.

### 12.3 `essence_burn` at minimum cost

**The loop.** The skill costs "all current mana, minimum 20" and pays
`spentMana × 3.76` at level 20. A player who casts at exactly 20 mana pays 20
and receives 75 damage — bad. But a player with `manaCostReduction` might expect
the *minimum* to shrink, turning the skill into a cheap 8 s-cooldown nova that
never empties the bar.

**The lock.** The cost is not a number, it is the pool.
`manaCostReduction` has **no effect** on `essence_burn`, and the 20-mana minimum
is a floor on what may be spent, not a cap. The output is strictly proportional
to the input, so there is no cast rate at which the skill outperforms simply
holding the mana. §11.2's arithmetic makes the real cadence the refill —
20.22 s at the E-C build — not the printed 8 s cooldown.

**Assertion.** `damagePerManaSpent` is constant to within `1e-9` across spends
of 20, 100 and 354 mana at every level.

### 12.4 `unity` free-cast machine gun

**The loop.** Every landed weapon hit free-casts `discharge` at no cost and off
cooldown. With enough attack speed the free casts become continuous, and each
one is a six-link chain resolving against up to six actors — 24 resolves per
second, 108 per `unity` window, all allocating projectile records.

**The lock.** Three, stacked:

1. `attackInterval` **floors at 0.25 s** (`03-combat-math.md` §4.3), so the hard
   ceiling is **4 free chains per second**, i.e. 24 resolves/s.
2. `unity` triggers on a **landed** hit only. A miss, a dodge and a block all
   trigger nothing, so a build with poor attack rating gets proportionally
   fewer.
3. The projectile pool cap refuses a spawn rather than allocating
   (`02-api-contracts.md` §10: "the pool cap is what keeps a Runeblade `unity`
   burst from allocating"). A refused spawn is a no-op, never an error.

Audio adds a fourth in presentation only: `lightning.arc` carries a **120 ms
retrigger guard** under `10-audio.md` §4.4, so 4 casts/s produce at most 8
voices/s.

**Assertion.** 20 s at 300 % IAS with `unity` up: zero allocations after warm-up,
`projectileCount` never exceeds the pool cap, and free-cast count equals landed
hit count exactly.

### 12.5 Runeblade resource overflow

**The loop.** §11.3 shows mana pinned at maximum for 28 of 30 seconds. Before
the rule in 03 §2.4 was settled, Resonance did the same and discarded **81 %** of
what it generated. A resource that never binds is not a resource; a player who
never has to think about either is playing a class with one button.

**The locks that exist.** `rune_strike` costs mana *before* it returns any, so a
Runeblade at 0 mana cannot open with it and must use the free basic attack to
climb back — the bar is a floor problem, not a ceiling problem. Mana return is
computed from **post-mitigation physical**, so it collapses against high
`physicalResist` and against a target that blocks; a 65-defence `stoneskin`
champion cuts the return by 25 % immediately. Resonance decays at 1 per 3 s out
of combat, so it cannot be banked between packs, and `blade_seal` costs mana as
well as a charge.

**The lock that closes it.** `blade_seal` spends the **whole** bar and
`rune_strike` grants no charge beyond the class base (03 §2.4, D-05-2). That
makes generation and consumption the same quantity: an imbue charge is spent by
a landed hit, and a landed hit is what grants a Resonance charge, so a seal that
imbues `n` hits is paid for by the `n` charges those hits produce. Misses cost
nothing on either side. The bar cycles instead of standing full, and the class
fantasy in the plan — *strike to build, cast to spend* — is the literal
mechanic.

**The residual, and the one build shape that still overflows.** Overflow is
`max(0, imbueCount − maxResonance) / imbueCount` in steady state:

| `blade_seal` slvl | Imbue hits | `maxResonance` without `resonance_circuit` | Overflow |
|---|---|---|---|
| 1–7 | 3 | 3 | **0 %** |
| 8–14 | 4 | 3 | 25 % |
| 15–20 | 5 | 3 | **40 %** |
| 8–14, `resonance_circuit ≥ 1` | 4 | 4 | **0 %** |
| 15–20, `resonance_circuit ≥ 10` | 5 | 5 | **0 %** |

A Runeblade who levels `blade_seal` past 15 without a point in
`resonance_circuit` has an imbue window wider than the bar that pays for it, and
loses 40 % of what it generates. That is a legible build consequence, not a
defect: the counter is one point in a passive that exists for exactly this, and
the skill tree shows the pairing. The harness **reports** these builds and does
not fail on them; the inverse trap — `blade_seal 1` with `resonance_circuit 20`,
a bar four wide feeding a three-charge spender — is flagged by the same line
(§7.2).

**Assertion.** Over a 60 s pack simulation, Resonance overflow must be **below
30 %** of Resonance generated for every Runeblade build in which
`maxResonance ≥ blade_seal`'s imbue count. B-A measures **16.1 %** in the §11.3
trace and **0 %** in the analytic steady state. Builds that allocate no
`blade_seal` at all (B-B, B-C) have no sink by construction and are reported,
not failed.

### 12.6 One-button pack clears

**The loop.** A single skill that kills a pack of 5–12 in under a second removes
every decision from the encounter. `meteor` at 388 average with a +220 % synergy
ceiling and a 5-body radius is the obvious candidate; `flame_wave` at 1 562
reference pack DPS is the sustained one.

**The locks.** `meteor` has a **1.20 s fall that is never scaled by
`fasterCastRate`** (`08-characters-visual.md` §6.2: "a fixed ritual; the player
learns one number"), an unmistakable expanding-ring telegraph, and a pool that
calls `nav.markHazard()` so the pack paths *away* from where the meteor landed.
Monsters that walk out take the pool for zero seconds. `flame_wave` is a **90°
arc**, so it clears a pack only from a position the player had to earn, and its
14.5 mana at 1.81 casts/s is 26.2 mana/s against a 15.42 mana/s income — 17.8 s
before the bar is empty.

The general principle: every screen-clearing number in this document is gated by
**a telegraph, a shape or a resource**, and the three capstones that are not
gated by a shape (`meteor`, `essence_burn`, `unity`) are all gated by a
cooldown longer than a pack fight.

### 12.7 Permanent crowd control

**The loop.** `ram_charge` at 2.45 s stun on a 4.2 s cooldown, plus `war_cry` at
2.34 s (4.68 s with the synergy) on a 14 s cooldown, plus a five-hit cold
`blade_seal` freeze — a pack that never acts.

**The lock.** `03-combat-math.md` §7.7's diminishing-returns chain: within a
**6.0 s** window, successive stuns on the same actor scale ×1, ×0.6, ×0.36,
×0.216, and the fifth is refused with 6.0 s of stun immunity.
`frozen` shares the chain and adds its own 3.0 s re-application block (§7.2).
Worked against a single monster at the R-C build: 2.45 → 1.47 → 0.88 → 0.53,
total **5.33 s of stun across 4 applications and a 6 s window**, then immunity.
Molgrim takes ×0.25 on top, so the same chain yields 1.33 s in total.

**Assertion.** No actor is ever unable to act for more than 60 % of any rolling
6.0 s window, boss included.

---

## 13. Validation

`tools/balance.mjs` imports `combat`, `skills` and `items` directly — none of
them touch `three` or the DOM — and runs headless in Node at a fixed seed. It
exits non-zero on any failed assertion and prints every failure, never just the
first.

### 13.1 Per skill (30 × the checks below)

| # | Assertion | Fails when |
|---|---|---|
| S1 | The level table has exactly **20 rows** and every scaling quantity is finite, non-`NaN` and monotonic in the intended direction | a `perLevel` sign is wrong, or a table was truncated |
| S2 | Row 1 equals the `base` of `03-combat-math.md` §8 exactly, and row 20 equals `base + 19 × perLevel` | any transcription error against the binding source |
| S3 | Cost at every level is `> 0` after `manaCostReduction` at its 75 % cap, and the stated floor is respected | a floor was forgotten (`whirlwind` 6/s, `essence_burn` 20) |
| S4 | Cooldown at every level respects its floor and never goes below it | `ram_charge` 4.0, `ashen_step` 1.8, `phase_leap` 2.5, `thunder_step` 3.0, `last_stand` 50 |
| S5 | `castTime × castScale` and `attackTime × attackScale × classScale` land inside the clamps of §4.3/§4.4 at IAS/FCR from −75 to the cap | a skill becomes uncastable or breaks the 0.15/0.25 s floor |
| S6 | The wind-up / active / recovery decomposition sums to the interval and `active` is never scaled by IAS | `08-characters-visual.md` §6.2 violated |
| S7 | Every `fx` and `audio` identifier resolves in the fx registry and in `10-audio.md` §5.1 | a hook was invented |
| S8 | Every stat named in `passiveStats` exists in the `StatBlock` of `01-data-model.md` §3 and respects its cap | a passive tries to grant a stat that does not exist |
| S9 | Every status applied names a `STATUS` key, with magnitude and duration inside the ranges of §7 | an invented status or an out-of-range magnitude |
| S10 | Damage per resource at level 20 is inside `[0.5×, 4×]` of the class median | a new outlier appears |
| S11 | Synergy sources exist, are in the same class, and the synergy graph is acyclic | a reciprocal or cross-class synergy is added |
| S12 | Prerequisites reference an allocated level, resolve to a real skill, and are satisfiable within 29 points | an unreachable capstone |

### 13.2 Per build (the nine of §9, plus a generated sweep)

| # | Assertion | Threshold |
|---|---|---|
| B1 | Allocation sums to exactly **29** points, no skill above 20, every tier and prerequisite met | exact |
| B2 | Landed hits to kill yardstick **A** with the build's free action | `2 ≤ hits ≤ 4` |
| B3 | Time to kill yardstick **A** with the build's free action | `1.5 s ≤ t ≤ 3.0 s` |
| B4 | Time to clear an eight-body pack, per monster | `≤ 1.5 s` |
| B5 | Champion TTK against yardstick **B** | `5 s ≤ t ≤ 20 s` |
| B6 | Molgrim TTK in **Instruction** at `clvl 15` | `60 s ≤ t ≤ 90 s` |
| B7 | Sustained DPS spread from the median of all builds in the sweep | `< 2.0×` — **the M7 gate** |
| B8 | Resource never goes negative, and the burst window is `≥ 8 s` from a full bar | exact / threshold |
| B9 | Resonance overflow over 60 s, for builds where `maxResonance ≥ blade_seal`'s imbue count | `< 30 %` of generated. Mispaired and sinkless builds are **reported**, not failed (§12.5) |
| B10 | No rolling 6.0 s window in which a monster is unable to act for more than 60 % | threshold |
| B11 | Two runs at the same seed produce byte-identical output | exact |

The sweep is every allocation that puts ≥ 15 points into one skill and
distributes the remainder over at most two others — 1 386 builds per class at
the level cap. B7 is evaluated over the sweep, not over the nine hand-written
builds, so a degenerate combination cannot hide by not being written down.

### 13.3 Failure output format

One line per failure on `stderr`, machine-parseable, sorted by
`class, tree, skill, level`:

```
FAIL  <check>  <scope>  <detail>  expected=<expected>  actual=<actual>  delta=<delta>
```

```
FAIL  S02  skill=whirlwind level=20            expected=131.0000  actual=130.0000  delta=-1.0000
FAIL  S10  skill=phase_leap                    expected=[14.81,118.44]  actual=3.29  delta=-11.52
```

Reports are a separate stream, never an exit code:

```
NOTE  B09  build=B-B/discharge-20              no blade_seal — Resonance has no sink by construction
NOTE  B09  build=gen/blade_seal-17+circuit-0   imbue 5 vs maxResonance 3 — 40 % discarded, mispaired
```

followed by a summary block on `stdout`:

```
balance.mjs  seed=0x5eed0001  skills=30  builds=4158  elapsed=8.42s
  per-skill   360 checks   360 pass   0 fail
  per-build  45738 checks 45738 pass   0 fail   112 notes
  RESULT: PASS
```

Exit codes: `0` all pass, `1` assertion failures, `2` a skill definition failed
to load, `3` non-determinism detected between the two B11 runs. Notes never
change the exit code.

**The set is green as specified.** The two failures this document used to report
— the `whirlwind` spread at 3.01× and the Resonance overflow at 81 % — are
closed by the decisions recorded in **D-05-1** and **D-05-2**, and both numbers
are now inside their gates (1.91× and 16.1 %). The `FAIL S02` and `FAIL S10`
lines above are format examples, not live results.

---

## 14. Implementation order

Fourteen steps. Each is independently verifiable and leaves the build green.
Steps 1–4 are everything **M4** needs: three skills per class, the three
resources, the hotbar, projectiles, AoE and cooldowns.

| # | Step | Deliverable | Verified by |
|---|---|---|---|
| **1** | `SkillDefinition` registry and allocation | All 30 definitions as data in `src/skills/data/skills.js`; `definition`, `all`, `forClass`, `forTree`, `trees`, `instanceOf`, `effectiveLevel`, `canAllocate`, `allocate`, `respec`, `synergyBonus`. No casting yet | S1, S2, S11, S12 over all 30; `respec()` round-trips to the same 29 points |
| **2** | Costs, cooldowns and the three resources | `costOf`, `cooldownRemaining`, rage/mana/Resonance accounting including the R1 and R2 readings, decay, `manaReturnPercent`, `resonanceOnHit` | S3, S4; §11's three simulations reproduce to ±2 % |
| **3** | **M4 skill 1 of 3 — `cleaving_strike`** | Cone targeting, `buildAttackPacket`, multi-target resolve in `actor.id` order, `attackScale`, the wind-up/active/recovery decomposition | S5, S6; a 4-body cone produces exactly 4 `combat:hit-request` events and **one** rage award |
| **4** | **M4 skills 2 and 3 — `ember_bolt` and `rune_strike`** | The projectile pool, `spawnProjectile`/`killProjectile`, pierce from level 10; the mana-return and Resonance path on a weapon hit | `03-combat-math.md` E13 reproduces exactly (39 damage, 1.7155 mana, +1 Resonance); pierce hits each body once |
| — | **M4 gate** | Each class clears the test room with its level-1 skills; Resonance visibly fills and is spent | manual + B11 determinism |
| **5** | Passives | `sources.skills` contributions, `stats:dirty` on allocation, the six pure passives and `polarity`'s two stances | S8; `composeStats()` stays inside the 40 µs budget with all passives at 20 |
| **6** | Statuses from skills | `onHitStatus` riders, `bleeding` stacking to 5, `cursed`, `stunned` with the DR chain, `shocked`, `slowed`, `blinded`, chill accumulation from a cold `blade_seal` | S9, B10; E8.1 reproduces (7 cold hits to freeze at 0.675 s) |
| **7** | Channels and toggles | `whirlwind`'s channel state, 0.55 s ticking, 70 % movement, hit-recovery immunity; `polarity`'s 1.5 s lockout | §12.1's three-target rage-income equality |
| **8** | Mobility | `ram_charge`, `ashen_step`, `phase_leap`, `thunder_step` — `nav` ray clipping, `untargetable` transit, arrival packets | a charge into a wall stops at the wall and still detonates; a leap always lands on the target's far side |
| **9** | Ground effects | `addGroundEffect`/`removeGroundEffect`, `nav.markHazard()` and its deregistration, `meteor`'s pool, `ash_wall`'s line and projectile absorption, `ashen_step`'s non-hazard cloud | every ground effect deregisters on expiry, on zone change and on owner death — zero leaked hazard cells |
| **10** | Buffs, absorbs and triggers | `applyBuff`/`removeBuff`/`hasBuff`, absorb pools consumed oldest-first at R13, `war_cry`, `smouldering_ward`, `last_stand`, `cascade`'s counter, `incinerate`'s guarded detonation | §12.2's nine-monster chain test; a hit larger than `life + absorb` still kills |
| **11** | Summons and free-casts | `echo_blade` as a `visualOnly` summon with no threat entry; `unity`'s landed-hit hook and its three locks | §12.4's 300 % IAS allocation test |
| **12** | Synergies wired end to end | All 14 reading `allocated`, applied at B2 for weapon coefficients and B7 for `flatDamage` | S11; `meteor` at 20/20 sources measures exactly ×3.20 |
| **13** | `fx` and `audio` hooks | Every identifier in §§2–7 wired to `skill:cast`, `skill:impact`, `projectile:spawn`/`end` and the animation phases | S7; the two additions of §15 exist or the check fails loudly |
| **14** | `tools/balance.mjs` | Every assertion of §13, the 4 158-build sweep, the failure format, CI wiring | the harness reproduces every number in §§9–11 of this document at seed `0x5eed0001` |

Steps 1–4 are the critical path and nothing else may start before step 2 is
green: every later step reads a resource number, and a resource bug found at
step 11 costs ten steps of re-verification.

---

## Additions folded into `10-audio.md`

> **Status: applied.** `skill.polarity.switch` and `echoblade.expire` are in
> `10-audio.md` §5.1 D, which now carries 14 ids. Kept as rationale.

Two identifiers are needed that the catalogue of §5.1 does not contain. Both
follow the conventions of their section (node counts and recipes are proposals,
not requirements).

| id | Section | Event | ms | nodes | Proposed recipe |
|---|---|---|---|---|---|
| `skill.polarity.switch` | **D. Lightning and Runeblade** | `polarity` toggled between Blade and Storm | 340 | 9 | Two sine banks crossfading over 220 ms: Blade = 146.83 / 293.66 Hz through LP 1 800 Hz; Storm = 220 / 440 / 659.3 Hz through HP 900 Hz with a 63 Hz-gated shimmer. AD(20, 300), g 0.16. The crossfade direction encodes which stance was entered, so the switch is readable blind |
| `echoblade.expire` | **D. Lightning and Runeblade** | the `echo_blade` duplicate despawns | 620 | 11 | `echoblade.spawn` reversed: the same three sines (293.66 / 440 / 587.33 Hz) with AD(280, 340) and a falling ±14-cent detune collapsing to unison, g 0.10 — the duplicate rejoining the caster |

Everything else in §§2–7 references an existing identifier. Three reuses are
worth flagging so they are not mistaken for omissions:

- `iron_skin`'s high-mitigation feedback uses `melee.glance`, not the
  monster-affix `affix.stoneskin.deflect`.
- `blade_seal`'s per-hit element impact reuses `firebolt.impact` / `ice.impact`
  / `lightning.arc` at **0.5 gain**, rather than asking for three new ids.
- `mana_weave` and `resonance_circuit` are deliberately **silent** passives; the
  globe and the Resonance pips are the feedback, and `resonance.charge` already
  covers the pip.

---

## Additions folded into `02-api-contracts.md`

> **Status: applied.** All seven methods and both events are in
> `02-api-contracts.md` §10, and the events are in `ARCHITECTURE.md`'s table.
> Kept as rationale, not as a request.

The `skills` API of §10 covers everything this document needs to *cast*. Seven
methods and two events are needed for `ui`, `fx` and `audio` to display state
this document creates without any of them re-deriving it.

| Method | Signature | Fixed | Alloc | Why |
|---|---|---|---|---|
| `imbueElement` | `(actor:Actor) => 'fire'\|'cold'\|'lightning'\|null` | Y | no | `imbueRemaining` reports how many `blade_seal` charges are left but not which element they are. `ui` colours the buff icon and `fx` picks the impact preset from it |
| `polarityStance` | `(actor:Actor) => 'blade'\|'storm'\|null` | Y | no | `skills` owns the stance (§10, "Owns exclusively"); nothing can read it |
| `cascadeCharges` | `(actor:Actor) => int` — 0..2 | Y | no | The empowered-hit counter is per-actor state with no accessor. `ui` draws it next to the Resonance pips |
| `buffRemaining` | `(actor:Actor, buffId:string) => number` — seconds | Y | no | `hasBuff` is a boolean. `war_cry`, `unity`, `echo_blade` and `smouldering_ward` all need a countdown |
| `absorbRemaining` | `(actor:Actor) => number` | Y | no | `smouldering_ward` and `last_stand` both write absorb pools that `ui` overlays on the life globe |
| `summonOf` | `(actor:Actor, skillId:string) => ActorRef\|null` | Y | no | `echo_blade`'s duplicate is untargetable and has no threat entry, so nothing else can find it. Never return an `Actor` — the pool recycles |
| `pointsInTree` | `(actor:Actor, treeId:string) => int` | Y | no | The skill panel shows per-tree totals; deriving it means iterating the registry on every draw |

| Direction | Event | Payload | Why |
|---|---|---|---|
| Emits | `skill:trigger` | `{ actor, skillId, level }` | Passive triggers — `cascade`, `last_stand`, `incinerate`'s detonation — currently emit nothing. `audio` and `fx` have to infer them from `skill:impact`, which cannot distinguish a triggered nova from a cast one |
| Emits | `skill:channel` | `{ actor, skillId, active:boolean }` | `whirlwind`'s tracked audio loop and its `fx` ribbons need an explicit start and stop. `skill:cast` fires once and `interrupt()` is a method, not an event |

All seven methods are pure reads of state `skills` already owns, allocate
nothing, and are safe in `fixedUpdate`. Neither event carries a pooled object.

---

## Balance decisions taken against `03-combat-math.md`

Three. Each was found by writing this document, each was raised with the owner,
and each is now **applied** — the numbers in `03-combat-math.md` and in the
sections above are the decided ones, and `tools/balance.mjs` asserts them. The
arithmetic is kept so the decision can be re-examined rather than re-discovered.

| # | Finding | Decision | Applied in |
|---|---|---|---|
| D-05-1 | `whirlwind` at a 0.35 s tick is 3.01× the median build | **Option A** — tick period 0.55 s | 03 §8.1; §2.3, §9 R-B, §9.4 here |
| D-05-2 | Resonance overflows 81 %; the bar is never not full | **Option C** — `blade_seal` spends the whole bar *and* `rune_strike` loses its extra charge | 03 §2.4, §8.5; §6.1, §6.2, §11.3, §12.5 here |
| D-05-3 | `shield_stance` is named as a dodge source but grants none | **§8.2's row is incomplete** — the skill grants `dodgeChance` | §3.2 here |

### D-05-1 — `whirlwind` was 3× the median build and 1.7× its own tree's best

**Decided: option A. Tick period 0.35 → 0.55 s.**

`03-combat-math.md` §8.1 gave `whirlwind` **55 % + 4 %/L** of weapon damage per
tick with a tick every **0.35 s**, and the tick is not scaled by attack speed.
That made the skill's throughput a pure function of its coefficient:

```
level 20, no synergy      1.31 × (1 / 0.35)             = 374 % weapon damage / s
level 21, cleaving 9      2.07 × (1 / 0.35)             = 591 % / s
cleaving_strike level 21  1.664 / 0.84375               = 197 % / s
bloodletting level 21     1.90 / 0.675 + bleed          = 282 % / s
sunder level 21           3.28 / 6.0  + filler          = 219 % / s
```

Build R-B reached **685.34 sustained DPS** against a nine-build median of
227.83 — a **3.01×** spread that failed the M7 gate of "no build more than 2×
from the median" while every other build passed it comfortably. The rage cost
did not restrain it: at effective level 21 the drain is `12 − 0.25 × 20 =
7.0 rage/s`, and the level-30 reference kit earns 5.11 rage/s from swings alone
before kills, so in a pack the channel was very close to free.

Either of two one-number changes closed it, and both stayed inside the shape of
§8.1:

| Option | Change | Result |
|---|---|---|
| **A** | Tick period **0.35 → 0.55 s** | 591 % / s becomes 376 % / s; R-B falls to 436 DPS, **1.91×** the median — inside the gate. The channel still ticks nearly twice a second and still feels like a blender |
| **B** | Coefficient **55 % + 4 %/L → 34 % + 2.5 %/L** | level 21 with 9 synergy points becomes `1.29`, i.e. 369 % / s; identical effect, but it also lowers the skill at low levels, which option A does not |

**Option A was taken.** It leaves the level-6 experience intact and only removes
the ceiling: the channel still ticks nearly twice a second. `03-combat-math.md`
§8.1 now reads 0.55 s and carries the reasoning; §2.3's twenty-level table, R-B
in §9 and the gate row in §9.4 are recomputed against it. Nothing else moved —
the rage economy is per-second on both sides, so drain, income, burst windows
and the R1/R2 readings of §1.6 are untouched. The spread is now **1.91×**, and
the widest build in the set is `E-C Essence` at 1.94× below the median.

### D-05-2 — Runeblade Resonance has no sink, and overflows 81 %

**Decided: option C. `blade_seal` spends the whole bar, and `rune_strike` loses
its extra charge.**

As originally written, §2.4 granted **+1 Resonance per landed melee hit** and
`rune_strike` **+1 extra**, against a `maxResonance` of 3 (4 or 5 with
`resonance_circuit`). §8.5 gave exactly one spender: `blade_seal`, at **−1
Resonance** per cast, and that cast imbues 3–5 hits, so at a 70.59 % hit chance
three charges last **4.25** swings and the seal was recast only that often.

```
generation, build B-A   2 per landed swing × 0.7059     = 1.412 per swing
                        1.412 / 0.4643 s                = 3.041 Resonance / s
consumption             1 charge per seal, 1 seal / 4.25 swings
                        1 / (4.25 × 0.4643)             = 0.507 Resonance / s
overflow, analytic      (3.041 − 0.507) / 3.041         = 83.3 %
overflow, measured (§11.3)  67.6 discarded of 83.3 generated = 81.2 %
```

The bar sat at maximum from t = 2 s onward and stayed there for 28 of the 30
seconds. A resource that is always full is a decoration.

Three fixes were on the table. Their arithmetic:

| Option | Change | Consumption | Overflow |
|---|---|---|---|
| **A** | `blade_seal` spends **all** current Resonance rather than exactly 1; the imbue count is unchanged | `3 × 0.507` = **1.52 /s** | **50 %** |
| **B** | `rune_strike` loses its **+1 extra** (§8.5), leaving only the class base of +1 per landed hit | unchanged at 0.507 /s, generation falls to 1.52 /s | **67 %** |
| **C** | **A and B together** | 1.52 /s against a generation of 1.52 /s | **≈ 0 %** |

Only **C** clears the 30 % assertion, and it has a second virtue: it turns the
bar into a legible three-swings-per-seal rhythm — build three, spend three —
which is what the class fantasy in the plan describes ("удары оружием … дают
+1 Резонанса; касты тратят ману и при наличии Резонанса навешивают элемент").
It cost two edits to §§2.4 and 8.5 and changed no damage number anywhere.

**Applied.** `03-combat-math.md` §2.4 now states that `blade_seal` spends
`floor(resonance)` and §8.5's `rune_strike` row carries only the class-base
charge. In this document §6.1's level table, §6.2's cost row and level table,
§11.3's trace, §11.4, §12.5 and §7.2's trap note follow it.

The identity that makes C exact is worth stating on its own, because it is what
the implementation should assert: **an imbue charge is consumed by a landed hit,
and a landed hit is what grants a Resonance charge.** A seal that imbues `n`
hits is therefore repaid by exactly `n` charges, whatever the hit chance, and
overflow in steady state is `max(0, n − maxResonance) / n` — zero at the matched
pairs 3/3, 4/4 and 5/5. The §11.3 trace measures 16.1 % rather than 0 % only
because its recorded seal cadence (4.92 swings) is looser than the analytic one
(4.25 swings); both are inside the 30 % gate.

### D-05-3 — `shield_stance` was named as a dodge source but granted no dodge

**Decided: §8.2's row was incomplete. The skill grants `dodgeChance`, and 03
§8.2 now says so.**

§5.2 states that `dodgeChance` "comes only from affixes and from
`shield_stance`", and deviation **D-15** repeats it: "granted only by affixes and
`shield_stance`". The skill's own row in §8.2 granted exactly two stats —
`blockChance` and `thorns` — and no dodge at any level.

The two statements could not both be implemented. A `shield_stance` with no
`dodgeChance` contradicts §5.2 and D-15; a `shield_stance` with dodge adds a
stat §8.2 did not list. The reading taken is that **§8.2's row was incomplete
rather than §5.2 being wrong**, because §5.2 and D-15 agree with each other and
are the more specific claims. The smallest value that satisfies them:

```
dodgeChance += 3 + 0.5 × (slvl − 1)        level 1 → 3 %,  level 20 → 12.5 %
```

Checked against the caps and the calibration:

- `dodgeChance` caps at **50** (`01-data-model.md` §3.4). 12.5 from twenty
  points leaves 37.5 for affixes, so the "no build becomes untouchable" reason
  §5.2 gives for the cap is untouched.
- Dodge is rolled only when `packet.dodgeable === true`, which excludes ground
  effects, auras, DoT ticks and `essence_burn` — so it never applies to the
  damage the Ravager most needs to survive.
- §11's calibration figures are unaffected: they use no `shield_stance` points
  and D-15 states explicitly that "no class has it by default, so the
  calibration in §11 is unaffected".

The opposite resolution — §5.2 and D-15 stop naming `shield_stance` — was
rejected because it would leave `dodgeChance` with affixes as its only source,
and a defensive stat no skill can buy is a weaker stat than the two documents
describe. The build figures in §9 that use `shield_stance` (R-C only, at 4.5 %
dodge) are unaffected either way; they move by less than 1 %.
