# 03 — Combat Mathematics

**Claudo II: Lord of Instruction** — the complete, closed-form combat model.

Every number in this document is final. There are no placeholders, no ranges
left to tuning, and no formula that resolves to "feel". Where a number was
chosen to hit a locked pacing target, §11 shows the arithmetic that proves it.

**Binding constraints this model was built against** (locked, not re-litigated):

- Simulation at **60 Hz** in `fixedUpdate`. `h = 1/60 s` exactly.
- Deterministic xoshiro128\*\* RNG, one forked stream per subsystem.
- **No frame breakpoints.** Attack and cast speed are continuous multipliers on
  animation duration. D2's breakpoints were an artefact of a 25 fps engine.
- Resistance cap **75 %**; immunity (≥ 100 %) exists on champion affixes only.
- Level cap **30**. Three difficulty tiers. Six monster types plus one boss.
- Combat pacing: normal monster **2–4 hits / 1.5–3 s**, champion **≈ 10 s**,
  boss **60–90 s**, 10–25 monsters on screen.

Everything here is pure arithmetic over plain objects. `combat`, `skills` and
`items` import nothing from `three` and touch no DOM, because
`tools/balance.mjs` and `tools/lootsim.mjs` run them in Node.

---

## Table of contents

1. [Notation](#1-notation)
2. [Class tables](#2-class-tables)
3. [Attributes and derived stats](#3-attributes-and-derived-stats)
4. [Weapons, attack speed and cast speed](#4-weapons-attack-speed-and-cast-speed)
5. [To-hit, dodge and block](#5-to-hit-dodge-and-block)
6. [The damage pipeline](#6-the-damage-pipeline)
7. [Status effects](#7-status-effects)
8. [Skills — all thirty](#8-skills--all-thirty)
9. [Monsters](#9-monsters)
10. [Level and difficulty scaling](#10-level-and-difficulty-scaling)
11. [Calibration](#11-calibration)
12. [Worked examples](#12-worked-examples)
13. [Deviations from the plan](#13-deviations-from-the-plan)

---

## 1. Notation

| Symbol | Meaning |
|---|---|
| `clvl` | character level, 1..30 |
| `mlvl` | monster level, 1..40 |
| `slvl` | effective skill level, 0..40 (`01-data-model.md` §6.2) |
| `h` | fixed step, `1/60 s` |
| `clamp(v, lo, hi)` | `min(hi, max(lo, v))` |
| `U(a,b)` | uniform real draw on `[a, b)` from the owning subsystem's stream |
| `⌊x⌋` | `Math.floor` |
| **round** | `Math.round`, half away from zero, applied only where stated |

Percent stats are whole numbers throughout: `enhancedDamage = 40` means +40 %.
All damage arithmetic is done in **float**; only the number shown to the player
and the value subtracted from `life` are rounded, and both round **down** with a
floor of 1 (§6, step R13).

---

## 2. Class tables

### 2.1 Core class table

| Field | Ravager | Emberwright | Runeblade |
|---|---|---|---|
| `baseLife` (at clvl 1) | 55 | 40 | 45 |
| `lifePerVit` | 4.0 | 2.0 | 3.0 |
| `lifePerLevel` | 2.0 | 1.0 | 1.5 |
| `baseMana` (at clvl 1) | 10 | 25 | 18 |
| `manaPerEne` | 1.0 | 2.5 | 1.75 |
| `manaPerLevel` | 0.5 | 2.0 | 1.25 |
| `baseStamina` | 60 | 54 | 57 |
| start STR / DEX / VIT / ENE | 30 / 20 / 25 / 10 | 15 / 25 / 15 / 35 | 22 / 25 / 20 / 22 |
| `classBaseAR` | 30 | 0 | 25 |
| `attackScale` | 0.90 | 1.15 | 1.00 |
| `castScale` | 1.15 | 0.85 | 1.00 |
| `meleeScale` (class damage bonus, physical weapon) | **1.00** | **0.75** | **0.95** |
| `spellScale` (class damage bonus, skill damage) | **0.85** | **1.00** | **0.95** |
| `manaRegenRate` (fraction of `maxMana` / s) | 0.020 | 0.040 | 0.030 |
| `lifeRegenRate` (fraction of `maxLife` / s) | 0.006 | 0.006 | 0.006 |
| `runSpeed` (m/s) | 4.2 | 4.0 | 4.3 |
| secondary resource | Rage 0..100 | — | Resonance 0..3 |
| `startGold` | 120 | 120 | 120 |

**Class damage bonus rules.** `meleeScale` multiplies the physical damage of a
weapon attack; `spellScale` multiplies the damage of a skill that does not use
the weapon's damage (every `flatDamage` skill, and the elemental part of
`blade_seal`). They enter the pipeline at step **B6** and nowhere else. There is
no per-class attribute-to-damage difference — the strength bonus of §4.2 is
identical for all three classes, and class identity is carried by these two
scales, by `attackScale` / `castScale`, and by the skill trees.

### 2.2 Reference allocation

Used by `tools/balance.mjs` and by every calibration figure in this document.
Points per level: **5 attribute, 1 skill**, awarded on levels 2..30 → 145
attribute points and 29 skill points at cap.

| Class | STR / DEX / VIT / ENE per level |
|---|---|
| Ravager | 2 / 1 / 2 / 0 |
| Emberwright | 1 / 1 / 1 / 2 |
| Runeblade | 2 / 1 / 1 / 1 |

### 2.3 Progression under the reference allocation (no equipment)

**Ravager**

| clvl | STR | DEX | VIT | ENE | maxLife | maxMana | maxStamina | AR (base) | manaRegen /s | lifeRegen /s |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 30 | 20 | 25 | 10 | 55 | 10 | 85 | 95 | 0.20 | 0.33 |
| 5 | 38 | 24 | 33 | 10 | 95 | 12 | 97 | 115 | 0.24 | 0.57 |
| 10 | 48 | 29 | 43 | 10 | 145 | 15 | 112 | 140 | 0.29 | 0.87 |
| 13 | 54 | 32 | 49 | 10 | 175 | 16 | 121 | 155 | 0.32 | 1.05 |
| 15 | 58 | 34 | 53 | 10 | 195 | 17 | 127 | 165 | 0.34 | 1.17 |
| 20 | 68 | 39 | 63 | 10 | 245 | 20 | 142 | 190 | 0.39 | 1.47 |
| 25 | 78 | 44 | 73 | 10 | 295 | 22 | 157 | 215 | 0.44 | 1.77 |
| 30 | 88 | 49 | 83 | 10 | 345 | 25 | 172 | 240 | 0.49 | 2.07 |

**Emberwright**

| clvl | STR | DEX | VIT | ENE | maxLife | maxMana | maxStamina | AR (base) | manaRegen /s | lifeRegen /s |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 15 | 25 | 15 | 35 | 40 | 25 | 69 | 90 | 1.00 | 0.24 |
| 5 | 19 | 29 | 19 | 43 | 52 | 53 | 77 | 110 | 2.12 | 0.31 |
| 10 | 24 | 34 | 24 | 53 | 67 | 88 | 87 | 135 | 3.52 | 0.40 |
| 13 | 27 | 37 | 27 | 59 | 76 | 109 | 93 | 150 | 4.36 | 0.46 |
| 15 | 29 | 39 | 29 | 63 | 82 | 123 | 97 | 160 | 4.92 | 0.49 |
| 20 | 34 | 44 | 34 | 73 | 97 | 158 | 107 | 185 | 6.32 | 0.58 |
| 25 | 39 | 49 | 39 | 83 | 112 | 193 | 117 | 210 | 7.72 | 0.67 |
| 30 | 44 | 54 | 44 | 93 | 127 | 228 | 127 | 235 | 9.12 | 0.76 |

**Runeblade**

| clvl | STR | DEX | VIT | ENE | maxLife | maxMana | maxStamina | AR (base) | manaRegen /s | lifeRegen /s |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 22 | 25 | 20 | 22 | 45 | 18 | 77 | 115 | 0.54 | 0.27 |
| 5 | 30 | 29 | 24 | 26 | 63 | 30 | 85 | 135 | 0.90 | 0.38 |
| 10 | 40 | 34 | 29 | 31 | 86 | 45 | 95 | 160 | 1.35 | 0.51 |
| 13 | 46 | 37 | 32 | 34 | 99 | 54 | 101 | 175 | 1.62 | 0.59 |
| 15 | 50 | 39 | 34 | 36 | 108 | 60 | 105 | 185 | 1.80 | 0.65 |
| 20 | 60 | 44 | 39 | 41 | 131 | 75 | 115 | 210 | 2.25 | 0.78 |
| 25 | 70 | 49 | 44 | 46 | 153 | 90 | 125 | 235 | 2.70 | 0.92 |
| 30 | 80 | 54 | 49 | 51 | 176 | 105 | 135 | 260 | 3.15 | 1.05 |

### 2.4 Resource math

**Life regeneration** — applied every fixed step, integrated through
`actor.lifeAccum` so fractions are never lost:

```
lifeRegen/s = maxLife × 0.006 + Σ flat lifeRegen + maxLife × lifeRegenPercent/100
```

Set to **0** while `poisoned`. Never regenerates a dead actor. Monsters use the
same rate; boss and unique ranks use `0.004`.

**Mana regeneration**

```
manaRegen/s = maxMana × classManaRegenRate × (1 + manaRegenPercent/100)
            + Σ flat manaRegen
```

Not blocked by `poisoned`. Rates: Ravager 0.020, Emberwright 0.040,
Runeblade 0.030.

**Rage — Ravager, 0..100**

| Event | Change |
|---|---|
| Landed melee hit dealt | **+6** (`+ rageOnHit`) |
| Hit taken (any damage > 0) | **+4** (`+ rageOnTakeHit`) |
| Kill credited | **+8** |
| Out of combat | **−8 / s** |
| `last_stand` trigger | **+40** |

"In combat" means `now − max(lastDamageStep, lastDealtStep) < 4.0 s`. There is
no passive gain and no decay while in combat. `maxRage` base 100.

At the level-10 reference build (attack interval 0.675 s, 77.8146 % hit chance)
rage income is `0.778146 × 6 / 0.675 = 6.9161 rage/s`. `cleaving_strike` at
9 rage is therefore castable every 1.30 s, and `whirlwind` at 12 rage/s runs a
net −5.08/s — about **19.7 s** of continuous channelling from a full bar. Both
are intended.

**Resonance — Runeblade, 0..3 (up to 5)**

| Event | Change |
|---|---|
| Landed melee hit dealt | **+1** (`+ resonanceOnHit`, fractional, floored on read) |
| Out of combat | **−1 per 3 s** |
| `blade_seal` cast | **all of it** — the cast spends the whole bar (see below) |

`maxResonance` base **3**; `resonance_circuit` adds +1 at slvl ≥ 1 and +1 more
at slvl ≥ 10, for a hard maximum of 5.

**`blade_seal` spends the entire bar.** The cast requires `resonance ≥ 1`, reads
`spent = floor(resonance)`, sets `resonance = resonance − spent` (keeping the
fractional remainder from `resonanceOnHit`), and imbues the number of hits its
row in §8.5 gives — the imbue count depends on skill level, **not** on `spent`.
Spending is therefore all-or-nothing in resource terms and level-driven in
effect terms, which is what makes the bar a rhythm rather than a stockpile.

*Why the whole bar and no `rune_strike` bonus charge* — with a single-charge
spender and a `rune_strike` that granted **+1 extra**, generation ran at
`3.041/s` against a consumption of `0.507/s`: **81 % of generated Resonance was
discarded** and the bar sat pinned at maximum for 28 of every 30 seconds. Both
edits together bring consumption to `1.52/s` against a generation of `1.52/s`
— overflow ≈ 0 %, and the bar reads as *build three, spend three*. See
`05-skills.md` **D-05-2** for the full arithmetic. No damage number changes.

**Mana return — Runeblade**

```
manaReturned = physicalDamageDealt × manaReturnPercent / 100
```

Base `manaReturnPercent` for the Runeblade class is **8**. `rune_strike` doubles
it for its own hit. `resonance_circuit` adds `4 + 0.8 × (slvl − 1)`.

**Stamina** (specified in full; `config.stamina` defaults to **false** and the
sprint control is hidden while it is)

```
maxStamina = classBaseStamina + vitality × 1.0 + (clvl − 1) × 1.0
sprint speed multiplier = 1.45
drain while sprinting    = 12 / s
regen                    = 8 / s, after 0.5 s without sprinting
sprint blocked below     = 5 stamina
```

---

## 3. Attributes and derived stats

All five derivations run in `composeStats().derive()`
(`01-data-model.md` §4.3).

```
maxLife    = ( baseLife + (VIT − startVIT) × lifePerVit
                        + (clvl − 1) × lifePerLevel
                        + Σ flat maxLife )            × (1 + lifePercent/100)

maxMana    = ( baseMana + (ENE − startENE) × manaPerEne
                        + (clvl − 1) × manaPerLevel
                        + Σ flat maxMana )            × (1 + manaPercent/100)

maxStamina =   baseStamina + VIT × 1.0 + (clvl − 1) × 1.0 + Σ flat maxStamina

AR         = ( classBaseAR + 5 × (DEX − 7) + Σ flat attackRating )
                                                      × (1 + attackRatingPercent/100)

DEF        = ( Σ equipped item defence + Σ flat defense )
                                                      × (1 + defensePercent/100)
             + ⌊DEX / 4⌋
```

`AR` and `DEF` clamp to `≥ 0`. Monsters do not use these formulas — their `AR`,
`DEF`, life and damage come straight from the bestiary row times the `mlvl`
tables of §10.1.

**Movement speed**

```
moveSpeed (m/s) = classRunSpeed × (1 + clamp(movementSpeed, −90, +200)/100)
                  clamped to [0.8, 12.0]
```

`chilled` and `slowed` contribute *negative* `movementSpeed` through the status
layer, so all slows stack **additively** and the −90 floor guarantees an actor
is never fully immobilised by slows alone. `frozen` and `stunned` stop movement
by blocking the state machine, not by touching this number.

**Light radius**

```
lightRadius (m) = 6.0 + stats.lightRadius        (max-wins aggregation, cap +14)
```

---

## 4. Weapons, attack speed and cast speed

### 4.1 Weapon handling classes

| `handling` | Attribute bonus | Two-handed | Notes |
|---|---|---|---|
| `oneHandMelee` | `STR / 100` | no | axes, swords, maces, clubs |
| `twoHandMelee` | `STR / 75` | yes | greataxes, mauls, polearms |
| `dagger` | `(STR + DEX) / 150` | no | fast, low base damage |
| `wand` | `STR / 150` | no | caster; carries `+% elemental damage` affixes |
| `staff` | `STR / 150` | yes | caster; carries `+skills` affixes |
| `unarmed` | `STR / 100` | no | the 1–3 damage, 0.60 s pseudo-weapon |

The player item set contains no bows or thrown weapons; the Ashen Archer's shot
is a monster skill, not an item. `dexterity`'s damage contribution is therefore
confined to `dagger`, and `DEX` earns its points through attack rating, defence,
block and dodge.

### 4.2 Attribute bonus

```
attributeBonus = 1 + handlingBonus            // e.g. 1 + STR/100
```

Applied at pipeline step **B5** to physical weapon damage only. It never
touches flat elemental damage and never touches a skill's `flatDamage`.

### 4.3 Attack interval

```
attackInterval (s) = clamp(
    weapon.attackTime × class.attackScale × skill.attackScale
    / (1 + clamp(increasedAttackSpeed, −75, +300) / 100),
    0.25, 3.0 )
```

### 4.4 Cast interval

```
castInterval (s) = clamp(
    skill.castTime × class.castScale
    / (1 + clamp(fasterCastRate, −75, +200) / 100),
    0.15, 3.0 )
```

There are no breakpoints: `+1 %` IAS always produces a shorter interval, right
up to the clamp. The floor of 0.25 s (4 attacks/s) and 0.15 s (6.7 casts/s)
exists to keep the 60 Hz simulation from having to resolve more than one action
per 15 steps, and to keep `combat:hit-request` inside the packet pool budget.

### 4.5 Action phases

Every attack and cast is decomposed into three phases summing to the interval:

| Phase | Fraction of interval | Cancellable by |
|---|---|---|
| `windup` | `windupFrac` — default **0.40** for attacks, **0.65** for casts | `hitstun`, death |
| `active` | `activeFrac` — default **0.15**; the damage window opens at the start | nothing |
| `recover` | the remainder | movement input after `0.60` of the interval has elapsed |

Monster archetypes override `windupFrac` — the Maulsmith's 0.55 is its
telegraph, and the ground marker `fx` draws is exactly that window.

### 4.6 Reference weapons

Used by every calibration figure. The full base catalogue belongs to the items
specification; these seven rows are fixed here because §11 depends on them.

| id | Name | Handling | Damage | `attackTime` | AR | reqLvl | reqStr | reqDex | Grid |
|---|---|---|---|---|---|---|---|---|---|
| `unarmed` | — | `unarmed` | 1–3 | 0.60 | 0 | 1 | 0 | 0 | — |
| `axe_hand_normal` | Hand Axe | `oneHandMelee` | 4–9 | 0.80 | 40 | 1 | 18 | 0 | 1×3 |
| `axe_battle_normal` | Battle Axe | `oneHandMelee` | 10–22 | 0.75 | 80 | 9 | 40 | 0 | 2×3 |
| `sword_rune_normal` | Rune Sword | `oneHandMelee` | 8–17 | 0.65 | 80 | 8 | 30 | 25 | 1×3 |
| `maul_great_normal` | Great Maul | `twoHandMelee` | 22–46 | 1.25 | 60 | 12 | 62 | 0 | 2×4 |
| `wand_ember_normal` | Ember Wand | `wand` | 3–7 | 0.60 | 10 | **1** | 12 | 0 | 1×2 |
| `staff_ash_normal` | Ash Staff | `staff` | 6–14 | 0.95 | 20 | 10 | 20 | 0 | 1×4 |

---

## 5. To-hit, dodge and block

The defender gets three independent chances to avoid a hit, resolved in this
order and short-circuiting on the first success. Each is a single RNG draw from
the `combat` stream.

### 5.1 Chance to hit

```
CTH% = clamp( 200 × AR / (AR + DEF) × alvl / (alvl + dlvl), 5, 95 )
```

`AR` is the attacker's final attack rating, `DEF` the defender's final defence,
`alvl` the attacker's level, `dlvl` the defender's level. A packet with
`attackRating === 0` **always hits** — that is every spell, every DoT tick,
`thorns`, and all environmental damage.

The `alvl / (alvl + dlvl)` term means an equal-level fight caps at 100 % *before*
the AR ratio, so the practical ceiling against a same-level target is
`200 × AR/(AR+DEF) × 0.5`. Fighting seven levels up (clvl 30 vs mlvl 37) caps the
term at `30/67 = 0.448`, i.e. **89.6 %** even with infinite AR. This is
deliberate: it is what makes attack rating a stat worth carrying in
Renunciation.

### 5.2 Dodge

```
dodge% = clamp(stats.dodgeChance, 0, 50)
```

Rolled only when `packet.dodgeable === true`. Ground effects, auras, DoT ticks
and `essence_burn` set it `false`. Base `dodgeChance` is **0** for every class
and every monster; it comes only from affixes and from `shield_stance`. The 50 %
cap exists so that no build becomes untouchable.

### 5.3 Block

```
shieldTerm = shield.blockBase × (DEX − 15) / (2 × clvl)
block%     = clamp( shieldTerm + stats.blockChance, 0, 75 )
```

`block%` is **0** without a shield in `offHand`, regardless of `stats.blockChance`.
Rolled only when `packet.blockable === true` and the attack arrives inside the
defender's frontal **180°** arc.

A successful block sets `outcome = 'block'` and reduces all damage to **zero** —
there is no partial block. It still triggers `thorns`, still applies
`onHitStatus` riders with `chance` unchanged, and puts the blocker into a
0.20 s block-recovery lock that does not stack with hit recovery.

Shield `blockBase` values: buckler 40, targe 50, kite shield 55, tower shield 65.

---

## 6. The damage pipeline

Two halves. **Build** runs on the attacker's stats and produces a
`DamagePacket`. **Resolve** runs on the defender and produces a `DamageResult`.
`combat` owns both; nothing else may perform any of these steps.

### 6.1 Build — attacker side, `combat.buildAttackPacket()`

| Step | Operation | Stats consumed |
|---|---|---|
| **B1** | Weapon base range: `physMin = weapon.minDamage`, `physMax = weapon.maxDamage`. Spells start at `physMin = physMax = 0`. | `mainHand` |
| **B2** | Skill coefficient: multiply both by `skill.weaponDamage / 100` where present (`100` for a basic attack), including synergy bonuses (§8.7). | skill tables |
| **B3** | Enhanced damage: `× (1 + enhancedDamage / 100)`. | `enhancedDamage` |
| **B4** | Flat added damage: `physMin += minDamage`, `physMax += maxDamage`. Added **after** ED — flat damage from a ring is not multiplied by a weapon's ED. | `minDamage`, `maxDamage` |
| **B5** | Attribute bonus: `× (1 + handlingBonus)` (§4.2). Skipped entirely for spells. | `strength`, `dexterity` |
| **B6** | Class damage scale: `× class.meleeScale` for weapon physical, `× class.spellScale` for `flatDamage` skills. Then `× (1 + physicalDamagePercent / 100)` for physical, `× (1 + elementDamagePercent / 100) × (1 + elementalDamagePercent / 100)` per element. | §2.1, `*DamagePercent` |
| **B7** | Elemental assembly: for each of fire/cold/lightning/poison/magic, `min/max` from the weapon, affixes and the skill's `flatDamage`, then the element's percent stats. Poison and cold also carry `poisonDuration` and `coldDuration`. | `fireMin`…`magicMax` |
| **B8** | Riders: `attackRating`, `attackerLevel`, `critChance`, `critMult`, `*ResistPierce`, `lifeSteal`, `manaSteal`, `lifeOnHit`, `manaOnHit`, `manaReturnPercent`, `knockback`, `onHitStatus[]`, `blockable`, `dodgeable`, `hitStop`. | rest of the block |

Base `critChance` is **5** and base `critMult` is **200** for every actor
("Deadly Strike" in display text). Both are packet fields, so a skill may
override them.

### 6.2 Resolve — defender side, `combat.resolve()`

| Step | Operation |
|---|---|
| **R1** | **Validity.** Target exists, `!dead`, hostile team, not `invulnerable`, `now ≥ invulnUntil`. Failure → `outcome = 'invalid'`, no event. |
| **R2** | **To-hit.** If `packet.attackRating > 0`, draw `U(0,100)` against §5.1. Failure → `outcome = 'miss'`, stop after R14's event. |
| **R3** | **Dodge.** If `packet.dodgeable`, draw against §5.2. Failure → `outcome = 'dodge'`. |
| **R4** | **Block.** If `packet.blockable`, the target has a shield and the hit is frontal, draw against §5.3. Success → `outcome = 'block'`, all damage 0, continue to R14 for thorns and riders. |
| **R5** | **Physical roll.** `phys = U(physMin, physMax)`. One draw, not per-component. |
| **R6** | **Crit.** One draw `U(0,100) < critChance` for the **whole hit**. On success every damage component is multiplied by `critMult / 100`, and `result.crit = true`. |
| **R7** | **Physical mitigation**, in this order: `phys −= damageReduceFlat`; `phys ×= (1 − clamp(damageReducePercent, 0, 50)/100)`; `phys ×= (1 − effectiveResist(physical)/100)`. Clamp `phys ≥ 0`. |
| **R8** | **Elemental rolls.** For each element in `ELEMENT_ORDER` (fire, cold, lightning, poison, magic), `dmg = U(min, max)`, then `× critMult/100` if R6 succeeded. Poison's roll is the **total** over its duration. |
| **R9** | **Pierce and immunity.** `r = targetResist − packetPierce`. If `r ≥ 100` → that element is **immune**: its damage is 0 and `result.outcome` becomes `'immune'` when it is the only component. Piercing *can* break an immunity — that is intentional. |
| **R10** | **Resistance application.** `effective = clamp(r, −200, maxResistForElement)`, then `dmg ×= (1 − effective/100)`. `maxResistForElement` defaults to 75 and rises only via the six `max*Resist` stats, themselves capped at 90. |
| **R11** | **Magic-side flat reduction.** `nonPhysical = fire + cold + lightning + poison + magic`; subtract `magicDamageReduceFlat` from the running non-physical sum, proportionally across the surviving components, clamped at 0. |
| **R12** | **Amplification.** `× (1 + 0.12 × shockedStacks)` applied to every component. This is the only place `shocked` enters. |
| **R13** | **Sum, floor, and absorb.** `total = phys + fire + cold + lightning + magic` (poison is *not* summed here — it is seeded as a DoT in R14). If any component was greater than 0 before mitigation and `total < 1`, set `total = 1`. Then `total = ⌊total⌋`. **Then consume absorb pools.** If the target holds one or more active absorb pools (`last_stand`, `smouldering_ward`), drain them **oldest-first**, in the order granted: `absorbed = min(total, pool.remaining)`; `pool.remaining -= absorbed`; `total -= absorbed`; a pool that reaches 0, or whose own duration has expired, is removed. Absorb applies **across every element**, is **not** a resistance (`physicalResist` does not affect it), and is **not** a death save — R14(a)'s `life -= total` uses this already-adjusted `total`, so a hit exceeding `life + absorb` still kills. Sources and level tables: `05-skills.md` §3.5 (`last_stand`, L1031–1034) and §5.3 (`smouldering_ward`, L1722). Added by SKIL-10 / `PROGRESS` O-90 — this row previously described the sum and floor only, while `05` already required the absorb step here and nothing implemented it. |
| **R14** | **Apply.** In this fixed order: (a) `life −= total`; (b) seed the poison DoT if poison damage survived; (c) apply `onHitStatus[]` riders, each with its own `U(0,100) < chance` draw, in array order; (d) life steal `= ⌊phys × lifeSteal/100⌋`, mana steal likewise, `lifeOnHit`, `manaOnHit`, `manaReturnPercent`; (e) `thorns` back at a melee attacker as a separate `attackRating = 0` packet, which never recurses; (f) rage gain on both sides; (g) hit recovery (§7.11); (h) knockback (§7.12); (i) death check and `actor:death`; (j) XP award; (k) emit `actor:damage`. |

**Ordering notes that matter.** `damageReduceFlat` before `damageReducePercent`
before `physicalResist` is the D2 order and is what makes flat reduction strong
against swarms and weak against the boss. `shocked` amplifies *after*
resistances, so it is a true damage-taken multiplier and does not interact with
immunity. Life steal is computed from the **post-mitigation physical** figure, so
leech scales with how much you actually hurt the target.

### 6.3 Damage over time

A DoT tick is not a hit. It skips R2, R3, R4, R6, R14(c–h) entirely. It applies
resistance (R9, R10) and, for `bleeding`, `physicalResist`, but never
`damageReduceFlat` and never `damageReducePercent`. It cannot crit, cannot
leech, cannot proc a status, cannot cause hit recovery, and cannot knock back.
It can kill, and it credits the original `sourceId` for XP.

Tick cadence: **every 15 fixed steps (4 Hz)** for `burning` and `poisoned`,
**every 30 steps (2 Hz)** for `bleeding`, phase-offset by `actor.id % 15`.

```
tickDamage = magnitude × tickInterval          // magnitude is damage per second
```

### 6.4 Healing

```
applied = clamp(amount, 0, maxLife − life)
```

Potions apply over their `overSeconds` window as a `lifeRegen`-style integration,
not instantly; the drink is interruptible only by death. `poisoned` does **not**
block potion healing — it blocks passive regeneration only.

---

## 7. Status effects

Every duration is multiplied by `(1 − clamp(ccReduction, 0, 75)/100)` on the
target, except `burning`, `poisoned` and `bleeding`, whose durations are fixed
by the applying skill (their *damage* is already reduced by resistance).

### 7.1 `chilled`

| Field | Value |
|---|---|
| Magnitude | `30` (% reduction), or the skill's override |
| Applies | `movementSpeed −= magnitude`, `increasedAttackSpeed −= magnitude`, `fasterCastRate −= magnitude` |
| Duration | `2.0 s + coldDuration` |
| Stacking | max-wins on magnitude, refresh on duration |
| Source | any hit with cold damage > 0 |

### 7.2 `frozen`

| Field | Value |
|---|---|
| Trigger | `chillPoints ≥ 100` (§7.3) |
| Effect | `canAct()` and `canMove()` both false; the actor's animator holds its pose |
| Duration | `1.20 s`, × 0.50 on champions, × 0.35 on uniques |
| Re-application | blocked for **3.0 s** after it ends (`ccImmuneUntil`) |
| Boss | immune; a freeze trigger instead applies `chilled` at magnitude 60 for 2.0 s |
| `cannotBeFrozen` | blocks it entirely; the chill still applies |

Damage does **not** break `frozen`.

### 7.3 Chill accumulation

```
on a cold hit:  chillPoints = max(0, chillPoints − 25 × secondsSinceLastColdHit) + magnitude
if chillPoints ≥ 100 → apply `frozen`, set chillPoints = 0
```

Decay is **25 points per second**. With the default magnitude of 30 this means:

| Attacker cadence | Cold hits to freeze |
|---|---|
| 0.675 s (level-10 Ravager swing) | 7 |
| 0.4675 s (level-10 Emberwright cast) | 5 |
| 0.350 s (fast dagger / `unity` proc) | 5 |

A slow, single-hit cold source can never freeze; sustained cold pressure can.
That is the whole design of the mechanic.

### 7.4 `burning`

| Field | Value |
|---|---|
| Magnitude | damage **per second** |
| Default seeding | `totalFireDamageOfTheHit × 0.35`, spread over `3.0 s` |
| Skill override | `flame_wave` seeds `× 0.45` over `4.0 s`; `meteor`'s pool is a ground effect, not a burn |
| Duration | 3.0 s default |
| Stacking | up to **3** independent instances; a fourth replaces the one with the lowest `totalRemaining` |
| Tick | 4 Hz |

### 7.5 `poisoned`

| Field | Value |
|---|---|
| Magnitude | `appliedPoisonTotal / duration` |
| Duration | `4.0 s + poisonDuration`, from the packet |
| Stacking | **replace if greater total** — the new application wins iff `newMagnitude × newDuration > existing.totalRemaining`, otherwise it is discarded entirely |
| Side effect | `lifeRegen` forced to 0 for the whole duration |
| Tick | 4 Hz |

### 7.6 `shocked`

| Field | Value |
|---|---|
| Magnitude | `12` (% extra damage taken) per stack |
| Stacks | up to **3**, i.e. +12 / +24 / +36 % |
| Duration | `4.0 s`, refreshed for all stacks on re-application |
| Applied by | `thunder_step`, the `charged` monster affix, and any hit with the `shocked` rider |
| Enters the pipeline | step R12 only |

### 7.7 `stunned`

| Field | Value |
|---|---|
| Effect | `canAct()` and `canMove()` false |
| Duration | from the source |
| Stacking | max-wins on remaining time |
| Diminishing returns | within a **6.0 s** window, successive stuns on the same actor scale ×1, ×0.6, ×0.36, ×0.216; the fifth is refused and the actor is stun-immune for 6.0 s |
| Boss | duration × 0.25, DR chain shared with `frozen` |

### 7.8 `slowed`

| Field | Value |
|---|---|
| Magnitude | % `movementSpeed` reduction |
| Duration | from the source |
| Stacking | max-wins, refresh |
| Interaction | additive with `chilled` through `movementSpeed`, floored at −90 total |

### 7.9 `bleeding`

| Field | Value |
|---|---|
| Magnitude | damage **per second**, `physicalDamageOfTheHit × (0.08 + 0.010 × (slvl − 1))` |
| Duration | `5.0 s` |
| Stacking | up to **5** independent instances (`bloodletting`) |
| Tick | 2 Hz |
| Mitigation | `physicalResist` only |

### 7.10 `blinded` and `cursed`

| Status | Magnitude | Applies | Duration | Source |
|---|---|---|---|---|
| `blinded` | 60 | `attackRatingPercent −= magnitude`; monster perception radius × 0.35 | 3.0 s | ash cloud (`ashen_step`), Molgrim phase III |
| `cursed` | `%` defence reduction | `defensePercent −= magnitude`; all six resists `−= magnitude × 0.375` | 6.0 s (`sunder`) / 8.0 s (`hexing`) | `sunder`, `hexing` affix |

`cursed` at magnitude 40 is therefore −40 % defence and −15 resistance points,
which is exactly the plan's `sunder` description.

### 7.11 Hit recovery

```
if damageThisHit > 0.05 × target.maxLife  and  now ≥ hitstunImmuneUntil:
    duration = clamp( 0.40 / (1 + fasterHitRecovery/100), 0.12, 0.40 )
    state    = 'hitstun' for `duration`
    hitstunImmuneUntil = now + duration + 0.50
```

| FHR | Hit recovery |
|---|---|
| 0 | 0.400 s |
| 30 | 0.308 s |
| 60 | 0.250 s |
| 120 | 0.182 s |
| 400 | 0.120 s (floor) |

The 0.50 s immunity window after recovering is what stops a six-monster pack
from stun-locking the player to death, and it is the reason champion packs are
survivable at all. Bosses and uniques have `fasterHitRecovery = 400` and a
1.20 s immunity window.

### 7.12 Knockback

```
massFactor = clamp( 1 − (targetMass − 70) / 200, 0.25, 1.5 )
distance   = 0.55 m × (1 + knockback/100) × massFactor
```

Applied as a velocity impulse over **0.18 s**; the target enters `knockback`
state and cannot act for that window. Rolled against `packet.knockback` as a
percent chance. `ACTOR_FLAG.noKnockback` refuses it outright; uniques take
0.25 × distance; the boss is immune.

| Mass | Distance at `knockback = 0` |
|---|---|
| 22 kg (Carrion Swarm) | 0.682 m |
| 78 kg (Bone Ranker) | 0.528 m |
| 140 kg (Maulsmith) | 0.358 m |
| 400 kg (Molgrim) | immune |

### 7.13 Hit-stop

Hit-stop is **presentation only**. It never touches `ctx.time.scale`, never runs
in `fixedUpdate`, and never affects a single simulation number — the balance
harness produces identical results with it on or off.

| Condition | Target animation freeze |
|---|---|
| Damage ≥ 12 % of the target's `maxLife` | 0.06 s |
| Critical hit | 0.09 s |
| A killing blow | 0.12 s |
| Boss phase transition | 0.20 s (boss only) |

Only the *struck* actor freezes, and only if the attacker is the player. Two
overlapping freezes take the maximum, never the sum.

---

## 8. Skills — all thirty

`L` denotes effective skill level (`slvl`). Every "per level" figure is
`base + perLevel × (L − 1)`. Resource costs are reduced by
`manaCostReduction` (mana only) and floored at 1.

### 8.1 Ravager — Carnage

| Skill | Tier | Cost | Cooldown | Timing | Effect |
|---|---|---|---|---|---|
| `cleaving_strike` | 1 | 6 rage `+0.25/L` | — | attack × 1.05 | 120° cone, radius 3.2 m. Weapon damage **40 % + 6.32 %/L** (L1 40 %, L20 160.1 %) |
| `bloodletting` | 6 | 8 rage `+0.30/L` | — | attack × 1.00 | Weapon damage **90 % + 5 %/L**. Applies `bleeding`, magnitude `physDealt × (0.08 + 0.010/L)` per second for 5 s, up to 5 stacks |
| `whirlwind` | 6 | 12 rage/s `−0.25/L`, floor 6 | — | channel, damage tick every **0.55 s** | Radius 2.6 m. Weapon damage **55 % + 4 %/L** per tick. Movement at 70 % speed; cannot be interrupted by hit recovery |
| `bloodthirst` | 12 | — | — | passive | `lifeSteal += 3 + 0.9/L` (L1 3 %, L20 20.1 %) |
| `sunder` | 18 | 14 rage `+0.50/L` | 6.0 s | attack × 1.25 | Radius 4.0 m. Weapon damage **130 % + 9 %/L**. Applies `cursed` magnitude `40 + 1/L` (cap 70) for 6 s |

Prerequisite: `sunder` requires `bloodletting ≥ 3`.

**Why `whirlwind` ticks at 0.55 s and not faster.** The channel is the only
skill in the game whose damage rate is set by a period rather than by an attack
interval, so it does not pay the hit-chance and animation costs everything else
pays. At a 0.35 s period the level-21-effective channel with nine synergy points
runs at **591 % weapon damage per second** — the Ravager build carrying it
reached 685 DPS against a nine-build median of 228, a spread of **3.01×** against
the M7 gate of 2×. Rage does not restrain it either: 12/s out against 6.92/s in
still funds ~20 s of continuous channelling, and inside a pack the lifesteal
return makes it effectively free. Moving the period to 0.55 s scales the rate to
`591 × 0.35/0.55 = 376 %/s`, the build to **436 DPS = 1.91× the median**, inside
the gate. The period was chosen over cutting the coefficient because it leaves
the level-6 experience untouched — the channel still ticks nearly twice a second
and still reads as a blender. `05-skills.md` §2.3 carries the per-level table and
**D-05-1** the nine-build recomputation.

### 8.2 Ravager — Unyielding

| Skill | Tier | Cost | Cooldown | Timing | Effect |
|---|---|---|---|---|---|
| `ram_charge` | 1 | 10 rage `+0.40/L` | `8.0 − 0.20/L`, floor 4.0 s | dash at 16 m/s, up to 9 m | Weapon damage **100 % + 7 %/L** on arrival, radius 1.8 m. Applies `stunned` for `1.5 + 0.05/L` s (cap 2.5) |
| `shield_stance` | 6 | — | — | passive | `blockChance += 8 + 1.6/L` (flat, added after the DEX term); `thorns += 6 + 4/L`; `dodgeChance += 3 + 0.5/L` (L1 3 %, L20 12.5 %) |
| `war_cry` | 12 | 18 rage `+0.60/L` | 14.0 s | cast 0.50 s | Radius 7.0 m. Applies `stunned` for `1.2 + 0.06/L` s. Self-buff `enhancedDamage += 15 + 2/L` for 12 s |
| `iron_skin` | 12 | — | — | passive | `defensePercent += 25 + 5/L`; `physicalResist += 1 + 0.5/L` (cap 25) |
| `last_stand` | 18 | — | `90 − 2/L`, floor 50 s | passive trigger at `life ≤ 25 % maxLife` | Absorb shield of `40 + 22/L` for 8 s; `+40` rage |

### 8.3 Emberwright — Flame

| Skill | Tier | Cost | Cooldown | Timing | Damage / effect |
|---|---|---|---|---|---|
| `ember_bolt` | 1 | 2.0 mana `+0.25/L` | — | cast 0.55 s | Fire `(3 + 2.25/L)`–`(7 + 3.75/L)`. Projectile 26 m/s, lifetime 2.2 s. Pierces at `L ≥ 10` |
| `flame_wave` | 6 | 5.0 mana `+0.50/L` | — | cast 0.65 s | Fire `(6 + 3.2/L)`–`(12 + 5.4/L)`, 90° cone, 7.0 m. Applies `burning` for 4 s at 45 % of the fire damage dealt |
| `fireball` | 12 | 7.0 mana `+0.70/L` | — | cast 0.60 s | Fire `(14 + 6/L)`–`(26 + 10/L)`. Blast radius `2.8 + 0.03/L` m |
| `meteor` | 18 | 16.0 mana `+1.20/L` | 4.0 s | cast 0.70 s, impact after 1.20 s | Fire `(34 + 14/L)`–`(58 + 22/L)` in radius 4.2 m. Leaves a fire pool for 6 s dealing `(6 + 2.4/L)` fire/s in radius 3.2 m |
| `incinerate` | 18 | — | — | passive | `fireDamagePercent += 12 + 4/L`. An enemy killed by fire detonates for `(25 + 3/L) %` of its `maxLife` as fire in radius 2.5 m (does not chain) |

Prerequisite: `meteor` requires `fireball ≥ 3`.

| L | `ember_bolt` | `flame_wave` | `fireball` | `meteor` |
|---|---|---|---|---|
| 1 | 3–7 | 6–12 | 14–26 | 34–58 |
| 5 | 12–22 | 18.8–33.6 | 38–66 | 90–146 |
| 10 | 23.25–40.75 | 34.8–60.6 | 68–116 | 160–256 |
| 15 | 34.5–59.5 | 50.8–87.6 | 98–166 | 230–366 |
| 20 | 45.75–78.25 | 66.8–114.6 | 128–216 | 300–476 |

### 8.4 Emberwright — Ash

| Skill | Tier | Cost | Cooldown | Timing | Effect |
|---|---|---|---|---|---|
| `ashen_step` | 1 | 6.0 mana `+0.40/L` | `3.0 − 0.06/L`, floor 1.8 s | instant | Blink up to `8.0 + 0.10/L` m (cap 10 m). Leaves an ash cloud, radius 2.5 m for 4 s, applying `slowed` at `40 + 1/L` (cap 60) and `blinded` to anything inside |
| `mana_weave` | 6 | — | — | passive | `maxMana += 12 + 6/L`; `manaRegen += 0.8 + 0.35/L`; `damageTakenToMana += 10 + 1/L` (cap 30) |
| `smouldering_ward` | 12 | 12.0 mana `+1.00/L` | 10.0 s | cast 0.45 s | Absorbs `45 + 25/L` damage for 20 s. On break or expiry, fire `(20 + 11/L)` in radius 3.5 m |
| `ash_wall` | 12 | 14.0 mana `+1.10/L` | 12.0 s | cast 0.55 s | A 6.0 m wall for 8 s. Blocks enemy projectiles entirely. `(8 + 3.4/L)` fire per second to anything within 0.8 m |
| `essence_burn` | 18 | **all** current mana, minimum 20 | 8.0 s | cast 0.80 s | Fire damage `= spentMana × (1.10 + 0.14/L)` in radius `5.0 + 0.05/L` m |

`essence_burn` worked: 100 mana spent at L5 → `100 × (1.10 + 0.56) = 166` fire
before resistances. At L1 → 110. At L20 → 376.

### 8.5 Runeblade — Enchanted Blade

| Skill | Tier | Cost | Cooldown | Timing | Effect |
|---|---|---|---|---|---|
| `rune_strike` | 1 | 2.0 mana `+0.20/L` | — | attack × 1.00 | Weapon damage **115 % + 7 %/L**. `manaReturnPercent` doubled for this hit. Grants the class-base **+1** Resonance of any landed melee hit and no more |
| `blade_seal` | 1 | 5.0 mana `+0.35/L`, **all current Resonance** (requires ≥ 1) | — | cast 0.25 s | Imbues the next **3** weapon hits (4 at `L ≥ 8`, 5 at `L ≥ 15`) with `(2 + 2.5/L)`–`(7 + 4.5/L)` of the chosen element (fire / cold / lightning, cycled by re-cast). The imbue count is set by skill level; the amount spent does not change it |
| `cascade` | 6 | — | — | passive trigger | After **3** empowered hits (`rune_strike` or imbued), releases a wave: weapon damage **70 % + 6 %/L** as `magic` in radius 4.5 m |
| `phase_leap` | 12 | 9.0 mana `+0.70/L` | `5.0 − 0.12/L`, floor 2.5 s | instant | Teleport to a target within 10 m and strike for weapon damage **140 % + 9 %/L** |
| `echo_blade` | 18 | 22.0 mana `+1.50/L` | 25.0 s | cast 0.60 s | Spectral duplicate for `10 + 0.3/L` s. It repeats the Runeblade's weapon attacks at **40 % + 2 %/L** damage, carries `ACTOR_FLAG.visualOnly` (deals damage, takes none), and does not generate Resonance or mana |

| L | `blade_seal` imbue | `rune_strike` | `cascade` | `phase_leap` |
|---|---|---|---|---|
| 1 | 2–7 | 115 % | 70 % | 140 % |
| 5 | 12–25 | 143 % | 94 % | 176 % |
| 10 | 24.5–47.5 | 178 % | 124 % | 221 % |
| 15 | 37–70 | 213 % | 154 % | 266 % |
| 20 | 49.5–92.5 | 248 % | 184 % | 311 % |

### 8.6 Runeblade — Conduit

| Skill | Tier | Cost | Cooldown | Timing | Effect |
|---|---|---|---|---|---|
| `discharge` | 1 | 4.0 mana `+0.35/L` | — | cast 0.40 s | Lightning `(3 + 2.6/L)`–`(11 + 6.2/L)`. Chains to **3** targets, `+1` per 6 levels, cap 6. Jump range 6 m, **−25 %** damage per jump |
| `resonance_circuit` | 6 | — | — | passive | `maxResonance += 1` (and `+1` more at `L ≥ 10`); `manaReturnPercent += 4 + 0.8/L`; `resonanceOnHit += 0.1/L` |
| `polarity` | 12 | 10 mana to switch | — | toggle, 1.5 s lockout | **Blade:** `physicalDamagePercent += 30 + 2/L`, `elementalDamagePercent −= 15`. **Storm:** `elementalDamagePercent += 30 + 2/L`, `physicalDamagePercent −= 15` |
| `thunder_step` | 12 | 11.0 mana `+0.80/L` | `6.0 − 0.15/L`, floor 3.0 s | instant, 7 m dash | On arrival: lightning `(10 + 5/L)`–`(22 + 9/L)` in radius 3.5 m, applies 1 stack of `shocked` |
| `unity` | 18 | 26.0 mana `+1.60/L` | 30.0 s | cast 0.50 s | For `8 + 0.2/L` s, every landed weapon hit free-casts `discharge` at its own current level, at no mana cost and off cooldown |

| L | `discharge` | `thunder_step` | `discharge` jumps |
|---|---|---|---|
| 1 | 3–11 | 10–22 | 3 |
| 5 | 13.4–35.8 | 30–58 | 3 |
| 10 | 26.4–66.8 | 55–103 | 4 |
| 15 | 39.4–97.8 | 80–148 | 5 |
| 20 | 52.4–128.8 | 105–193 | 6 |

### 8.7 Synergies

A synergy adds `perLevel × sourceAllocatedLevel` percent to the named
coefficient of the target skill. Synergies read the **allocated** level of the
source, never the effective level — otherwise `+skills` would compound
quadratically.

| Source | Target | Bonus per source level |
|---|---|---|
| `cleaving_strike` | `whirlwind` | +8 % weapon damage |
| `bloodletting` | `sunder` | +6 % weapon damage |
| `ram_charge` | `war_cry` | +5 % stun duration |
| `shield_stance` | `iron_skin` | +4 % `defensePercent` |
| `ember_bolt` | `meteor` | +6 % fire damage |
| `fireball` | `meteor` | +5 % fire damage |
| `flame_wave` | `incinerate` | +4 % detonation damage |
| `ashen_step` | `ash_wall` | +5 % fire damage |
| `mana_weave` | `essence_burn` | +4 % mana conversion |
| `rune_strike` | `cascade` | +7 % weapon damage |
| `blade_seal` | `phase_leap` | +5 % weapon damage |
| `discharge` | `unity` | +6 % lightning damage |
| `discharge` | `thunder_step` | +5 % lightning damage |
| `resonance_circuit` | `echo_blade` | +4 % echo damage |

Fourteen synergies, at least two per tree.

### 8.8 Consumables

| id | Effect | Amount | Over |
|---|---|---|---|
| `potion_life_minor` | `restore_life` | 35 % of `maxLife` | 3.0 s |
| `potion_life_lesser` | `restore_life` | 45 % | 3.0 s |
| `potion_life_greater` | `restore_life` | 60 % | 3.0 s |
| `potion_life_grand` | `restore_life` | 80 % | 3.0 s |
| `potion_mana_minor` | `restore_mana` | 35 % of `maxMana` | 3.0 s |
| `potion_mana_lesser` | `restore_mana` | 45 % | 3.0 s |
| `potion_mana_greater` | `restore_mana` | 60 % | 3.0 s |
| `potion_mana_grand` | `restore_mana` | 80 % | 3.0 s |
| `potion_rejuvenation` | `restore_both` | 40 % of each | instant |
| `scroll_identify` | `identify` | one item | instant |
| `scroll_portal` | `town_portal` | opens a portal to Last Bastion | 1.0 s cast |
| `scroll_respec` | `respec` | refunds all skill and attribute points | instant |

Belt slots hold **20** of a stackable consumable each.

---

## 9. Monsters

### 9.1 Bestiary — base values at `mlvl 1`

| id | Name | Role | Life | Damage | DEF | AR | XP | `attackTime` | Speed m/s | Mass |
|---|---|---|---|---|---|---|---|---|---|---|
| `bone_ranker` | Bone Ranker | melee | 20 | 3–6 | 18 | 45 | 7 | 1.40 | 3.2 | 78 |
| `carrion_swarm` | Carrion Swarm | swarm | 9 | 2–3 | 12 | 38 | 3 | 0.75 | 5.4 | 22 |
| `ashen_archer` | Ashen Archer | ranged | 15 | 3–7 | 14 | 52 | 8 | 1.70 | 3.6 | 68 |
| `dust_shaman` | Dust Shaman | support | 17 | 2–5 | 15 | 40 | 12 | 1.60 | 3.4 | 70 |
| `maulsmith` | Maulsmith | heavy | 42 | 9–18 | 26 | 55 | 16 | 2.20 | 2.4 | 140 |
| `blight_crawler` | Blight Crawler | suicide | 12 | 8–14 | 10 | 30 | 6 | — | 4.6 | 40 |
| `molgrim` | Molgrim, the First Instructor | boss | 430 | 16–30 | 25 | 90 | 900 | 1.80 | 3.0 | 400 |

Resistances (points; negative = vulnerable):

| id | fire | cold | lightning | poison | magic | physical |
|---|---|---|---|---|---|---|
| `bone_ranker` | 0 | 25 | 0 | 50 | 0 | 0 |
| `carrion_swarm` | 0 | 0 | 0 | 25 | 0 | 0 |
| `ashen_archer` | 25 | 0 | 0 | 0 | 0 | 0 |
| `dust_shaman` | 25 | 25 | 25 | 25 | 0 | 0 |
| `maulsmith` | 0 | 0 | −25 | 25 | 0 | 15 |
| `blight_crawler` | 0 | −25 | 0 | 75 | 0 | 0 |
| `molgrim` | 50 | 50 | 50 | 85 | 40 | 10 |

Perception and movement:

| id | `aggroRadius` | `leashRadius` | `attackRange` | `windupFrac` | Behaviour note |
|---|---|---|---|---|---|
| `bone_ranker` | 13.0 | 34.0 | 1.9 | 0.42 | closes and swings; 20 % chance to enter an 0.8 s guard after being hit (`+40 blockChance` during it) |
| `carrion_swarm` | 15.0 | 40.0 | 1.4 | 0.30 | surrounds; the pack scatters for 3 s once its alive count drops below 40 % |
| `ashen_archer` | 18.0 | 38.0 | 14.0 | 0.50 | kites; retreats while the player is inside 6.0 m |
| `dust_shaman` | 16.0 | 36.0 | 9.0 | 0.45 | stays behind the line; priority target marker in `ui` |
| `maulsmith` | 12.0 | 30.0 | 2.6 | 0.55 | slow; the 1.21 s windup draws a ground telegraph you can walk out of |
| `blight_crawler` | 17.0 | 44.0 | 1.2 | — | sprints and detonates |
| `molgrim` | 26.0 | ∞ | 4.5 | 0.50 | see §9.5 |

### 9.2 Monster skills

| id | Skill | Numbers |
|---|---|---|
| `ashen_archer` | `ash_shot` | projectile 22 m/s, range 14 m, 100 % of its attack damage, `pierceChance 0` |
| `dust_shaman` | `raise_ranker` | every 8.0 s, revives 1 `bone_ranker` corpse within 8.0 m at 60 % life; the revived actor gets `ACTOR_FLAG.revived` and can never be revived again; 1 credit per shaman per zone visit |
| `dust_shaman` | `haste_dust` | every 12.0 s, pack buff radius 10 m: `+25 increasedAttackSpeed`, `+20 movementSpeed` for 6.0 s |
| `maulsmith` | `crushing_slam` | 1.21 s windup, radius 3.2 m, **220 %** of its attack damage, `knockback 100 %` |
| `blight_crawler` | `detonate` | on contact or on death: poison total `(8–14) × damageMult(mlvl)` over 5.0 s in radius 3.0 m; the crawler dies |
| `bone_ranker` | `shield_guard` | reactive, see §9.1 |

### 9.3 Rank multipliers

Applied on top of the `mlvl` tables of §10.1.

| Rank | Life × | Damage × | Defence × | Phys resist + | Elem resists + | Affixes | ilvl | XP × |
|---|---|---|---|---|---|---|---|---|
| `normal` | 1.0 | 1.0 | 1.0 | 0 | 0 | 0 | mlvl | 1.0 |
| `minion` | 1.6 | 1.2 | 1.2 | 0 | 10 | inherits the unique's | mlvl | 1.5 |
| `champion` | **4.0** | **1.6** | **1.5** | +10 | +20 | 1 | mlvl + 2 | 3.0 |
| `unique` | **7.0** | **2.2** | **2.0** | +15 | +30 | 3 | mlvl + 3 | 6.0 |
| `boss` | 1.0 | 1.0 | 1.0 | 0 | 0 | — | mlvl + 3 | 1.0 |

The boss's rank multipliers are all 1.0 because Molgrim's bestiary row is
already scaled for the job. Uniques spawn with **3–5** minions and are
guaranteed at least one magic-or-better drop.

Monster flat damage reduction: `damageReduceFlat = ⌊mlvl / 8⌋`, all ranks.

### 9.4 Monster affixes

Rolled by `ai.rollAffixes()` from the `ai` stream; one per group, no duplicates.

| id | Display | Effect |
|---|---|---|
| `burning` | Burning | `fireResist = 100` (immune). On death: fire damage `= 60 % of its maxLife` in radius 3.5 m |
| `charged` | Charged | `lightResist = 100`. Releases 4 lightning charges every 3 s, each `40 %` of its attack damage as lightning, applying `shocked` |
| `frostbound` | Frostbound | `coldResist = 100`. Aura radius 7 m applying `chilled` at magnitude 35 |
| `swift` | Swift | `increasedAttackSpeed += 60`, `movementSpeed += 45` |
| `mighty` | Mighty | damage × 1.55, `attackRating × 1.25` |
| `stoneskin` | Stoneskin | `defense × 2.5`, `damageReducePercent += 25` |
| `hexing` | Hexing | every 6 s applies `cursed` magnitude 40 for 8 s in radius 8 m |
| `vampiric` | Vampiric | `lifeSteal = 30` |
| `multishot` | Multishot | ranged attacks fire 3 projectiles in a 22° spread at 70 % damage each; melee attacks gain a 2.4 m cleave instead |

Immunity is granted **only** by `burning`, `charged` and `frostbound`, which
matches `ARCHITECTURE.md`. All three can be broken by the corresponding
`*ResistPierce` stat.

### 9.5 Molgrim, the First Instructor

Base row in §9.1. `mlvl` = zone level + 0 (Altar of Instruction: 15 / 27 / 37).
`ACTOR_FLAG.boss | noKnockback`. `fasterHitRecovery = 400`, stun and freeze DR
as §7.7 / §7.2.

| Phase | Life band | Patterns | Uptime factor |
|---|---|---|---|
| **I** | 100–60 % | `instructor_sweep` every 4.5 s: 0.90 s telegraph, 180° cone 5.5 m, **220 %** attack damage, `knockback 100 %`. `summon_ranker` every 20 s: 4 × `bone_ranker` at `mlvl − 2` | 0.95 |
| **II** | 60–25 % | `ember_rings` every 9 s: three rings expanding at 4.0 m/s to 14 m, **180 %** as fire, each ring has 3 gaps of 40°. `instructor_dash` every 6 s: 12 m/s charge, **200 %** damage, applies `stunned` 0.8 s | 0.82 |
| **III** | < 25 % | `blink` every 4 s. `meteor_rain` every 8 s: 6 impacts over 3 s, each **160 %** as fire in radius 3.0 m. `syllable_burn` aura: radius 12 m, **−8 mana/s** and `2 % maxLife/s` as magic, and applies `blinded` for 1 s every 4 s | 0.85 |

Phase transitions grant 1.5 s of `invulnerable` and a 0.20 s global hit-stop.

**Uptime factor** is the fraction of the fight a competent player spends
dealing damage rather than repositioning. Weighted by the health bands
(0.40 / 0.35 / 0.25):

```
U = 0.40 × 0.95 + 0.35 × 0.82 + 0.25 × 0.85 = 0.380 + 0.287 + 0.2125 = 0.8795 ≈ 0.88
```

`U = 0.88` is used in every boss TTK figure in §11.

---

## 10. Level and difficulty scaling

### 10.1 Monster scaling by `mlvl`

```
lifeMult(n)    = 1 + 0.2600 (n−1) + 0.01300 (n−1)²
damageMult(n)  = 1 + 0.2200 (n−1) + 0.00750 (n−1)²
defenseMult(n) = 1 + 0.3000 (n−1)
arMult(n)      = 1 + 0.3800 (n−1)
xpMult(n)      = 1 + 0.3200 (n−1) + 0.01600 (n−1)²
flatDR(n)      = ⌊n / 8⌋
```

**Rounding rule.** The multipliers in the table below are shown to two decimal
places for reading; implementations evaluate the formula at full precision. A
monster's life, damage, defence, attack rating and XP are computed in float —
`bestiaryValue × mlvlMult × rankMult × difficultyMult` — and rounded **once**,
at spawn, with `Math.round`. Never round an intermediate. This is why a
level-10 champion has 351 life and not 352: `20 × 4.393 × 4.0 = 351.44`.

| mlvl | life × | damage × | defence × | AR × | XP × | flat DR |
|---|---|---|---|---|---|---|
| 1 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0 |
| 2 | 1.27 | 1.23 | 1.30 | 1.38 | 1.34 | 0 |
| 3 | 1.57 | 1.47 | 1.60 | 1.76 | 1.70 | 0 |
| 4 | 1.90 | 1.73 | 1.90 | 2.14 | 2.10 | 0 |
| 5 | 2.25 | 2.00 | 2.20 | 2.52 | 2.54 | 0 |
| 6 | 2.63 | 2.29 | 2.50 | 2.90 | 3.00 | 0 |
| 7 | 3.03 | 2.59 | 2.80 | 3.28 | 3.50 | 0 |
| 8 | 3.46 | 2.91 | 3.10 | 3.66 | 4.02 | 1 |
| 9 | 3.91 | 3.24 | 3.40 | 4.04 | 4.58 | 1 |
| 10 | 4.39 | 3.59 | 3.70 | 4.42 | 5.18 | 1 |
| 11 | 4.90 | 3.95 | 4.00 | 4.80 | 5.80 | 1 |
| 12 | 5.43 | 4.33 | 4.30 | 5.18 | 6.46 | 1 |
| 13 | 5.99 | 4.72 | 4.60 | 5.56 | 7.14 | 1 |
| 14 | 6.58 | 5.13 | 4.90 | 5.94 | 7.86 | 1 |
| 15 | 7.19 | 5.55 | 5.20 | 6.32 | 8.62 | 1 |
| 16 | 7.83 | 5.99 | 5.50 | 6.70 | 9.40 | 2 |
| 17 | 8.49 | 6.44 | 5.80 | 7.08 | 10.22 | 2 |
| 18 | 9.18 | 6.91 | 6.10 | 7.46 | 11.06 | 2 |
| 19 | 9.89 | 7.39 | 6.40 | 7.84 | 11.94 | 2 |
| 20 | 10.63 | 7.89 | 6.70 | 8.22 | 12.86 | 2 |
| 21 | 11.40 | 8.40 | 7.00 | 8.60 | 13.80 | 2 |
| 22 | 12.19 | 8.93 | 7.30 | 8.98 | 14.78 | 2 |
| 23 | 13.01 | 9.47 | 7.60 | 9.36 | 15.78 | 2 |
| 24 | 13.86 | 10.03 | 7.90 | 9.74 | 16.82 | 3 |
| 25 | 14.73 | 10.60 | 8.20 | 10.12 | 17.90 | 3 |
| 26 | 15.63 | 11.19 | 8.50 | 10.50 | 19.00 | 3 |
| 27 | 16.55 | 11.79 | 8.80 | 10.88 | 20.14 | 3 |
| 28 | 17.50 | 12.41 | 9.10 | 11.26 | 21.30 | 3 |
| 29 | 18.47 | 13.04 | 9.40 | 11.64 | 22.50 | 3 |
| 30 | 19.47 | 13.69 | 9.70 | 12.02 | 23.74 | 3 |
| 31 | 20.50 | 14.35 | 10.00 | 12.40 | 25.00 | 3 |
| 32 | 21.55 | 15.03 | 10.30 | 12.78 | 26.30 | 4 |
| 33 | 22.63 | 15.72 | 10.60 | 13.16 | 27.62 | 4 |
| 34 | 23.74 | 16.43 | 10.90 | 13.54 | 28.98 | 4 |
| 35 | 24.87 | 17.15 | 11.20 | 13.92 | 30.38 | 4 |
| 36 | 26.03 | 17.89 | 11.50 | 14.30 | 31.80 | 4 |
| 37 | 27.21 | 18.64 | 11.80 | 14.68 | 33.26 | 4 |
| 38 | 28.42 | 19.41 | 12.10 | 15.06 | 34.74 | 4 |
| 39 | 29.65 | 20.19 | 12.40 | 15.44 | 36.26 | 4 |
| 40 | 30.91 | 20.99 | 12.70 | 15.82 | 37.82 | 5 |

### 10.2 Difficulty tiers

| Tier | `mlvl` offset | Life × | Damage × | XP × | Monster resists + | Player resist penalty | Gold find + |
|---|---|---|---|---|---|---|---|
| **Instruction** | +0 | 1.00 | 1.00 | 1.00 | 0 | 0 | 0 % |
| **Trial** | **+12** | 1.15 | 1.10 | 1.20 | +20 | **−40** to fire/cold/lightning/poison/magic | +40 % |
| **Renunciation** | **+22** | 1.35 | 1.20 | 1.45 | +40 | **−100** to fire/cold/lightning/poison/magic | +90 % |

The resist penalty is a `difficulty`-layer contribution to the five elemental
resistance stats. `physicalResist` is never penalised — physical mitigation is
carried by defence and by `damageReduce*`, and penalising it too would make
Renunciation melee unplayable. The penalty applies to the resist value, never
to the `max*Resist` cap: a Renunciation character with `+100` fire resistance
from gear sits at 0, and needs `+175` to reach the 75 % cap.

Monster resistance additions never create an immunity on their own: the highest
base resistance in the bestiary is Molgrim's 85 poison, which reaches 125 in
Renunciation — genuinely immune, and intentionally so, since poison is not one
of the three player elements. No normal or champion monster reaches 100 in a
player-facing element without the corresponding affix.

Item level of a drop is `mlvl` of the killer plus the rank bonus of §9.3, so the
ilvl progression across difficulties falls out of the `mlvl` offsets rather than
needing a separate table.

### 10.3 Zone levels

| Zone | Instruction | Trial | Renunciation |
|---|---|---|---|
| Ashen Wastes | 6 | 18 | 28 |
| Bonereach | 11 | 23 | 33 |
| Altar of Instruction | 15 | 27 | 37 |

Worked Bone Ranker, all nine combinations:

| Zone / tier | mlvl | Life | Damage | DEF | XP |
|---|---|---|---|---|---|
| Wastes / Instruction | 6 | 53 | 7–14 | 45 | 21 |
| Wastes / Trial | 18 | 211 | 23–46 | 110 | 93 |
| Wastes / Renunciation | 28 | 472 | 45–89 | 164 | 216 |
| Bonereach / Instruction | 11 | 98 | 12–24 | 72 | 41 |
| Bonereach / Trial | 23 | 299 | 31–63 | 137 | 133 |
| Bonereach / Renunciation | 33 | 611 | 57–113 | 191 | 280 |
| Altar / Instruction | 15 | 144 | 17–33 | 94 | 60 |
| Altar / Trial | 27 | 381 | 39–78 | 158 | 169 |
| Altar / Renunciation | 37 | 735 | 67–134 | 212 | 338 |

Molgrim's life across the three tiers: **3 091 / 8 183 / 15 794**.

### 10.4 Experience curve

```
XP_TOTAL(n) = round( 50 × (n − 1)^2.6 )        // cumulative XP required to BE level n
```

| Level | Cumulative | To next |
|---|---|---|
| 1 | 0 | 50 |
| 2 | 50 | 253 |
| 3 | 303 | 567 |
| 4 | 870 | 968 |
| 5 | 1,838 | 1,445 |
| 6 | 3,283 | 1,991 |
| 7 | 5,274 | 2,601 |
| 8 | 7,875 | 3,268 |
| 9 | 11,143 | 3,993 |
| 10 | 15,136 | 4,769 |
| 11 | 19,905 | 5,598 |
| 12 | 25,503 | 6,474 |
| 13 | 31,977 | 7,398 |
| 14 | 39,375 | 8,367 |
| 15 | 47,742 | 9,381 |
| 16 | 57,123 | 10,436 |
| 17 | 67,559 | 11,534 |
| 18 | 79,093 | 12,672 |
| 19 | 91,765 | 13,851 |
| 20 | 105,616 | 15,068 |
| 21 | 120,684 | 16,322 |
| 22 | 137,006 | 17,615 |
| 23 | 154,621 | 18,944 |
| 24 | 173,565 | 20,309 |
| 25 | 193,874 | 21,709 |
| 26 | 215,583 | 23,144 |
| 27 | 238,727 | 24,612 |
| 28 | 263,339 | 26,116 |
| 29 | 289,455 | 27,651 |
| 30 | 317,106 | — (cap) |

### 10.5 Experience award

```
levelPenalty = (clvl − mlvl ≤ 4) ? 1.0
                                 : max(0.05, 1 − 0.09 × (clvl − mlvl − 4))

xp = max(1, round( baseXp
                   × xpMult(mlvl)
                   × rankXpMult
                   × difficultyXpMult
                   × levelPenalty
                   × (1 + experienceGain/100) ))
```

There is no penalty for fighting *above* your level — the to-hit level term of
§5.1 is punishment enough.

| Rank | `rankXpMult` |
|---|---|
| `normal` | 1.0 |
| `minion` | 1.5 |
| `champion` | 3.0 |
| `unique` | 6.0 |
| `boss` | 1.0 |

Sample awards (Instruction unless stated):

| Kill | clvl | XP |
|---|---|---|
| Bone Ranker, mlvl 10, normal | 10 | 36 |
| Bone Ranker, mlvl 10, champion | 10 | 109 |
| Bone Ranker, mlvl 10, unique | 10 | 217 |
| Bone Ranker, mlvl 6, normal (Δ = 10, penalty 0.46) | 16 | 10 |
| Molgrim, mlvl 15 | 13 | 7,754 |
| Molgrim, mlvl 27, Trial | 24 | 21,747 |
| Molgrim, mlvl 37, Renunciation | 30 | 43,399 |

Sanity check on the whole curve: at clvl 10 the next level costs 4,769 XP and a
Bonereach normal monster at mlvl 11 gives 41, so a level is ~116 kills — about
one zone run at the plan's density of 9–14 packs of 5–12. At clvl 29 the next
level costs 27,651 and a Renunciation Bonereach monster at mlvl 33 gives 280,
so ~99 kills. The curve and the reward grow together on purpose.

### 10.6 Death penalty

On death at `clvl ≥ 5`:

```
loss = round( 0.05 × (XP_TOTAL(clvl + 1) − XP_TOTAL(clvl)) )
experience = max(XP_TOTAL(clvl), experience − loss)
```

Five percent of the **current level's band**, never of the lifetime total, and
never enough to de-level. At clvl 10 that is 238 XP; at clvl 29, 1,383. Items
are kept, the character respawns in Last Bastion at 30 % life and 30 % mana with
its secondary resource emptied, and there is no corpse run.

---

## 11. Calibration

This section proves the locked pacing targets. Every figure is reproducible from
the tables above; `tools/balance.mjs` asserts each of them at a fixed seed.

### 11.1 The three reference builds at clvl 10

All use the reference allocation of §2.2 plus one magic weapon and a set of
normal armour totalling the defence shown.

| | Ravager | Emberwright | Runeblade |
|---|---|---|---|
| STR / DEX / VIT / ENE | 48 / 29 / 43 / 10 | 24 / 34 / 24 / 53 | 40 / 34 / 29 / 31 |
| Weapon | Battle Axe, +40 % ED, +15 AR | Ember Wand, +25 % fire damage | Rune Sword, +35 % ED |
| Armour defence | 130 | 60 | 95 |
| Gear vitals | +20 life | +20 life, +20 mana | +20 life, +20 mana |
| `maxLife` | 165 | 87 | 106 |
| `maxMana` | 15 | 108 | 65 |
| Final DEF | 137 | 68 | 103 |
| Final AR | 235 | — (spell) | 240 |
| Attack / cast interval | 0.675 s | 0.4675 s | 0.650 s / 0.250 s |
| Primary action | basic attack | `ember_bolt` slvl 5 | Rune Sword + `blade_seal` slvl 5 |

### 11.2 Versus a level-10 Bone Ranker — target: 2–4 hits, 1.5–3.0 s

Bone Ranker at mlvl 10: **life 88**, DEF 67, `flatDR` 1, all resists 0.

**Ravager**

```
weapon average        (10 + 22) / 2                       = 16.000
× enhanced damage     × 1.40                              = 22.400
× attribute bonus     × (1 + 48/100)                      = 33.152
× class melee scale   × 1.00                              = 33.152
× expected crit       × (0.95 + 0.05 × 2.00)              = 34.810
− flat DR             − 1                                 = 33.810
× physical resist     × (1 − 0/100)                       = 33.810   per landed hit
chance to hit         200 × 235/(235+67) × 10/20          = 77.81 %
DPS                   0.7781 × 33.810 / 0.675             = 38.97
TTK                   88 / 38.97                          = 2.26 s       swings 3.35
```

**Emberwright**

```
ember_bolt slvl 5     (12 + 22) / 2                       = 17.000
× fire damage %       × 1.25                              = 21.250
× expected crit       × 1.05                              = 22.313
× class spell scale   × 1.00                              = 22.313
× fire resist         × (1 − 0/100)                       = 22.313   per cast (always hits)
DPS                   22.313 / 0.4675                     = 47.73
TTK                   88 / 47.73                          = 1.84 s       casts 3.94
```

**Runeblade** — rotation is three weapon swings under one `blade_seal`, then a
recast:

```
physical: (8+17)/2 = 12.5 × 1.35 ED × 1.40 STR × 1.05 crit × 0.95 class = 23.57
          − 1 flat DR                                                    = 22.57
lightning: (12+25)/2 = 18.5 × 1.05 crit × 0.95 class                     = 18.45
per landed imbued hit                                                    = 41.02
chance to hit  200 × 240/(240+67) × 0.5                                  = 78.18 %
cycle          3 × 0.650 + 0.250                                         = 2.200 s
damage/cycle   3 × 0.781759 × 41.02                                      = 96.20
DPS            96.20 / 2.200                                             = 43.73
TTK            88 / 43.73                                                = 2.01 s
```

| Class | TTK | Swings/casts | In 1.5–3.0 s? | In 2–4 hits? |
|---|---|---|---|---|
| Ravager | **2.26 s** | 3.35 | yes | yes |
| Emberwright | **1.84 s** | 3.94 | yes | yes |
| Runeblade | **2.01 s** | 3.4 (3 + 1 seal) | yes | yes |

Spread between the fastest and slowest class: **1.23×**, well inside the M7
gate of 2× from the median.

### 11.3 Versus a level-10 champion — target: ≈ 10 s

Champion (§9.3): life `round(20 × 4.393 × 4.0) = 351`, DEF
`round(18 × 3.70 × 1.5) = 100`, `+10` physical resist, `+20` elemental resists,
`flatDR` 1.

| Class | Per landed hit | Hit chance | DPS | **TTK** |
|---|---|---|---|---|
| Ravager | `33.810 × 0.90 = 30.43` | 70.15 % | 31.62 | **11.10 s** |
| Emberwright | `22.313 × 0.80 = 17.85` | — | 38.18 | **9.19 s** |
| Runeblade | `(22.57 × 0.90) + (18.45 × 0.80) = 35.07` | 70.59 % | 33.76 | **10.40 s** |

Mean 10.23 s against a target of ≈ 10 s. Uniques at the same level
(life `round(20 × 4.393 × 7.0) = 615`, DEF `round(18 × 3.70 × 2.0) = 133`,
`+15`/`+30` resists) come out at **22.62 / 18.41 / 21.84 s** — a genuine
mini-boss, and the reason they carry a guaranteed magic-or-better drop.

### 11.4 Versus Molgrim — target: 60–90 s

Fight staged at **clvl 13 vs mlvl 15**, the level a reference character reaches
by the end of Bonereach. Molgrim: life `round(430 × 7.188) = 3 091`, DEF
`25 × 5.20 = 130`, physical resist 10, fire/cold/lightning 50, `flatDR` 1,
`U = 0.88` (§9.5).

**Ravager** — rare Battle Axe 12–26, +55 % ED, +25 AR, +20 % IAS:

```
(12+26)/2 = 19 × 1.55 ED × 1.54 STR × 1.05 crit × 1.00 class = 47.62
− 1 flat DR = 46.62 ; × 0.90 physical resist                 = 41.96
AR 30 + 5×(32−7) + 80 + 25 = 260
hit  200 × 260/390 × 13/28                                   = 61.90 %
interval 0.75 × 0.90 / 1.20                                  = 0.5625 s
DPS  0.6190 × 41.96 / 0.5625                                 = 46.18
TTK  3091 / (46.18 × 0.88)                                   = 76.1 s
```

**Emberwright** — `ember_bolt` at effective slvl 9, +35 % fire damage,
+25 % FCR:

```
(21 + 37)/2 = 29 × 1.35 fire% × 1.05 crit × 1.00 class       = 41.11
× 0.50 fire resist                                           = 20.55
interval 0.55 × 0.85 / 1.25                                  = 0.3740 s
DPS  20.55 / 0.3740                                          = 54.96
TTK  3091 / (54.96 × 0.88)                                   = 63.9 s
casts needed 3091 / 20.55 = 150 ; mana 150 × 4.0             = 602
mana available: pool 139 + regen 5.56/s × 63.9 s = 494, + 2 mana potions (≈ 111) = 605
```

The Emberwright finishes the boss with an empty belt. That is the intended
shape of the fight for a caster.

**Runeblade** — rare Rune Sword 10–20, +50 % ED, +20 AR, +15 % IAS, +15 % FCR,
`blade_seal` at effective slvl 7:

```
physical  (10+20)/2 = 15 × 1.50 ED × 1.46 STR × 1.05 crit × 0.95 class = 32.77
          − 1 = 31.77 ; × 0.90 physical resist                          = 28.59
lightning (17+34)/2 = 25.5 × 1.05 crit × 0.95 class × 0.50 resist       = 12.72
per landed hit                                                          = 41.31
AR 25 + 5×(37−7) + 80 + 20 = 275 ; hit 200 × 275/405 × 13/28            = 63.05 %
cycle 3 × (0.65/1.15) + (0.25/1.15) = 1.6957 + 0.2174                   = 1.9131 s
DPS   3 × 0.6305 × 41.31 / 1.9131                                       = 40.84
TTK   3091 / (40.84 × 0.88)                                             = 86.0 s
```

| Class | **Boss TTK** | In 60–90 s? |
|---|---|---|
| Ravager | **76.1 s** | yes |
| Emberwright | **63.9 s** | yes |
| Runeblade | **86.0 s** | yes |

Spread 1.35×, inside the 2× gate.

### 11.5 Incoming damage — the other half of pacing

A five-strong pack against the level-10 Ravager (DEF 137, 165 life):

| Monster | AR | Count | Hit chance | Avg damage | Per landed hit | DPS each | Pack DPS |
|---|---|---|---|---|---|---|---|
| Bone Ranker | 199 | 4 | 59.23 % | 16.14 | 14.14 | 5.98 | 23.93 |
| Ashen Archer | 230 | 1 | 62.67 % | 17.94 | 15.94 | 5.87 | 5.87 |
| **Total** | | 5 | | | | | **29.80** |

165 life ÷ 29.80 = **5.5 s** standing still without drinking. With one minor
life potion (57.75 life over 3 s) that becomes 7.5 s; with movement, blocking
and hit-recovery immunity it is a fight you win. A Maulsmith alone (AR 243,
63.95 % hit chance, 46.43 per landed hit, 2.20 s interval) deals 13.50 DPS and
would take 12.2 s to kill the same Ravager — and its 1.21 s telegraph is
walkable, so in practice it deals far less.

This is the intended texture: a pack is lethal in seconds if ignored, and
trivially survivable if played. It is also why `hitstunImmuneUntil` (§7.11) is
not optional — without the 0.50 s window, four Bone Rankers hitting a 0.400 s
recovery would lock the player in place permanently.

### 11.6 Summary against the locked targets

| Target | Required | Achieved |
|---|---|---|
| Normal monster, hits | 2–4 | 3.35 / 3.94 / 3.4 |
| Normal monster, time | 1.5–3.0 s | 2.26 / 1.84 / 2.01 s |
| Champion | ≈ 10 s | 11.10 / 9.19 / 10.40 s |
| Boss | 60–90 s | 76.1 / 63.9 / 86.0 s |
| Class TTK spread | < 2× | 1.23× (normal), 1.35× (boss) |
| Monsters on screen | 10–25 | packs of 5–12, 9–14 packs per zone |

---

## 12. Worked examples

Every row is a complete input set and an expected output, computed from the
formulas above. These are the unit tests: paste them into
`src/combat/__tests__` and they must pass to four decimal places (tolerance
`1e-4`) unless a row says otherwise.

### E1 — Chance to hit

`combat.chanceToHit(AR, DEF, alvl, dlvl)`

| # | AR | DEF | alvl | dlvl | Expected |
|---|---|---|---|---|---|
| E1.1 | 235 | 67 | 10 | 10 | `77.8146` |
| E1.2 | 240 | 67 | 10 | 10 | `78.1759` |
| E1.3 | 260 | 130 | 13 | 15 | `61.9048` |
| E1.4 | 275 | 130 | 13 | 15 | `63.0511` |
| E1.5 | 199 | 137 | 10 | 10 | `59.2262` |
| E1.6 | 243 | 137 | 10 | 10 | `63.9474` |
| E1.7 | 50 | 900 | 5 | 30 | `5` (low clamp) |
| E1.8 | 5000 | 10 | 30 | 1 | `95` (high clamp) |

### E2 — Block chance

`shieldTerm = blockBase × (DEX − 15) / (2 × clvl)`, `+ stats.blockChance`, clamp `0..75`

| # | `blockBase` | flat | DEX | clvl | Expected |
|---|---|---|---|---|---|
| E2.1 | 55 | 0 | 32 | 13 | `35.9615` |
| E2.2 | 55 | 12 | 32 | 13 | `47.9615` |
| E2.3 | 55 | 0 | 20 | 13 | `10.5769` |
| E2.4 | 0 (no shield) | 40 | 32 | 13 | `0` |
| E2.5 | 65 | 30 | 90 | 12 | `75` (clamp) |

### E3 — Ravager basic attack, full build pipeline

Inputs: Battle Axe 10–22, `enhancedDamage 40`, STR 48, `oneHandMelee`,
`meleeScale 1.00`, `critChance 5`, `critMult 200`, target `flatDR 1`,
`physicalResist 0`.

| Stage | Value |
|---|---|
| B1 weapon average | `16.0000` |
| B3 after enhanced damage | `22.4000` |
| B5 after attribute bonus | `33.1520` |
| B6 after class melee scale | `33.1520` |
| R6 expected crit multiplier `0.95 + 0.05 × 2.0 = 1.05` | `34.8096` |
| R7a after flat DR | `33.8096` |
| R7c after physical resist | `33.8096` |
| Non-crit minimum roll (`10 × 1.40 × 1.48 − 1`) | `19.7200` |
| Non-crit maximum roll (`22 × 1.40 × 1.48 − 1`) | `44.5840` |
| Critical maximum roll (`× 2.0`) | `90.1680` |

The expected-crit figure is for DPS arithmetic only; a single resolved hit uses
one crit draw and one damage draw, and is never `34.8096`.

### E4 — Elemental damage against resistance

Input: rolled lightning `17.0000`, `critMult` expectation `1.05`,
`spellScale 0.95`, no pierce.

| # | Target resist | Effective resist | Expected damage |
|---|---|---|---|
| E4.1 | 0 | 0 | `16.9575` |
| E4.2 | 20 | 20 | `13.5660` |
| E4.3 | 50 | 50 | `8.4788` |
| E4.4 | 75 | 75 | `4.2394` |
| E4.5 | 90 (cap 75) | 75 | `4.2394` |
| E4.6 | 100 | — | `0` — **immune**, `outcome = 'immune'` |
| E4.7 | 100, `lightResistPierce 30` | 70 | `5.0873` — immunity broken |
| E4.8 | −50 | −50 | `25.4363` |

### E5 — Poison as a total

Input: `poisonMin 30`, `poisonMax 54`, roll lands on the average `42`,
`poisonDuration` stat `2.0`, target `poisonResist 50`.

| Quantity | Value |
|---|---|
| Duration | `4.0 + 2.0 = 6.0 s` |
| Applied total | `42 × (1 − 0.50) = 21.0000` |
| Magnitude (damage/s) | `21.0 / 6.0 = 3.5000` |
| Tick count at 4 Hz | `24` |
| Damage per tick | `0.8750` |

Re-application rule: a second poison of magnitude `3.0` and duration `6.0`
(total 18.0) applied at `t = 1.0 s` when `totalRemaining = 17.5` **replaces**
the first (18.0 > 17.5). At `t = 2.0 s`, when `totalRemaining = 14.0`, the same
application also replaces. A poison of magnitude `2.0` for `6.0 s` (total 12.0)
applied at `t = 1.0 s` is **discarded**.

### E6 — Attack and cast intervals

`attackInterval = clamp(base × classScale × skillScale / (1 + IAS/100), 0.25, 3.0)`

| # | base | classScale | skillScale | IAS | Expected |
|---|---|---|---|---|---|
| E6.1 | 0.75 | 0.90 | 1.00 | 0 | `0.6750` |
| E6.2 | 0.75 | 0.90 | 1.00 | 20 | `0.5625` |
| E6.3 | 0.75 | 0.90 | 1.00 | 100 | `0.3375` |
| E6.4 | 0.65 | 1.00 | 1.00 | 15 | `0.5652` |
| E6.5 | 2.20 | 1.00 | 1.00 | 0 | `2.2000` |
| E6.6 | 0.75 | 0.90 | 1.00 | 300 | `0.2500` (floor) |
| E6.7 | 0.75 | 0.90 | 1.00 | −75 | `2.7000` |

`castInterval = clamp(base × classScale / (1 + FCR/100), 0.15, 3.0)`

| # | base | classScale | FCR | Expected |
|---|---|---|---|---|
| E6.8 | 0.55 | 0.85 | 0 | `0.4675` |
| E6.9 | 0.55 | 0.85 | 25 | `0.3740` |
| E6.10 | 0.25 | 1.00 | 15 | `0.2174` |
| E6.11 | 0.70 | 0.85 | 200 | `0.1983` |

### E7 — Hit recovery

`clamp(0.40 / (1 + FHR/100), 0.12, 0.40)`

| # | FHR | Expected |
|---|---|---|
| E7.1 | 0 | `0.4000` |
| E7.2 | 30 | `0.3077` |
| E7.3 | 60 | `0.2500` |
| E7.4 | 120 | `0.1818` |
| E7.5 | 400 | `0.1200` (floor) |

Trigger threshold: a hit of `8.0` damage on a `165`-life actor does **not**
trigger (`8 / 165 = 4.85 % < 5 %`); a hit of `8.5` does (`5.15 %`).

### E8 — Chill accumulation to freeze

Magnitude `30`, decay `25`/s, threshold `100`.

| # | Hit interval | `chillPoints` after each hit | Frozen on hit |
|---|---|---|---|
| E8.1 | 0.675 s | 30.00, 43.13, 56.25, 69.38, 82.50, 95.63, 108.75 | **7** |
| E8.2 | 0.4675 s | 30.00, 48.31, 66.63, 84.94, 103.25 | **5** |
| E8.3 | 0.350 s | 30.00, 51.25, 72.50, 93.75, 115.00 | **5** |
| E8.4 | 2.000 s | 30.00, 30.00, 30.00, … | **never** |

### E9 — Rage economy

Level-10 Ravager, interval `0.675 s`, hit chance `77.81 %`, `+6` rage per
landed hit.

| Quantity | Value |
|---|---|
| Rage per second | `0.778146 × 6 / 0.675 = 6.9161` |
| `cleaving_strike` (9 rage) castable every | `9 / 6.9161 = 1.3013 s` |
| `whirlwind` net drain (12/s) | `6.9161 − 12 = −5.0839 /s` |
| Channel duration from a full 100 rage | `100 / 5.0839 = 19.67 s` |
| Out-of-combat decay from 100 to 0 | `100 / 8 = 12.5 s` |

### E10 — Experience awards

`xp = max(1, round(baseXp × xpMult(mlvl) × rankXpMult × difficultyXpMult × levelPenalty))`

| # | Monster | mlvl | Rank | clvl | Tier | Penalty | Expected |
|---|---|---|---|---|---|---|---|
| E10.1 | Bone Ranker | 10 | normal | 10 | Instruction | 1.000 | `36` |
| E10.2 | Bone Ranker | 10 | champion | 10 | Instruction | 1.000 | `109` |
| E10.3 | Bone Ranker | 10 | unique | 10 | Instruction | 1.000 | `217` |
| E10.4 | Bone Ranker | 6 | normal | 16 | Instruction | 0.460 | `10` |
| E10.5 | Molgrim | 15 | boss | 13 | Instruction | 1.000 | `7754` |
| E10.6 | Molgrim | 27 | boss | 24 | Trial | 1.000 | `21747` |
| E10.7 | Molgrim | 37 | boss | 30 | Renunciation | 1.000 | `43399` |
| E10.8 | Bone Ranker | 1 | normal | 30 | Instruction | 0.050 | `1` |

### E11 — Knockback distance

`0.55 × (1 + knockback/100) × clamp(1 − (mass − 70)/200, 0.25, 1.5)`

| # | `knockback` | mass | Expected |
|---|---|---|---|
| E11.1 | 0 | 78 | `0.5280` |
| E11.2 | 0 | 22 | `0.6820` |
| E11.3 | 100 | 78 | `1.0560` |
| E11.4 | 0 | 140 | `0.3575` |
| E11.5 | 0 | 400 | `0.1375` — but Molgrim has `noKnockback`, so `0` |

### E12 — Mitigation ordering

Raw physical `100.0000`, `damageReduceFlat 12`, `damageReducePercent 25`,
`physicalResist 30`.

| Step | Value |
|---|---|
| R7a `− 12` | `88.0000` |
| R7b `× 0.75` | `66.0000` |
| R7c `× 0.70` | `46.2000` |

Reversing the order would give `100 × 0.70 × 0.75 − 12 = 40.5000`. The
specified order is the one that ships; a test asserting `46.2000` guards it.

### E13 — Full resolve, level-10 Runeblade imbued hit

Inputs: Rune Sword 8–17, `enhancedDamage 35`, STR 40, `meleeScale 0.95`;
`blade_seal` slvl 5 lightning 12–25, `spellScale 0.95`; both rolls land on their
averages; crit does **not** proc; target Bone Ranker mlvl 10 (`flatDR 1`, all
resists 0); AR 230, DEF 67, both level 10.

| Step | Value |
|---|---|
| B1 weapon average | `12.5000` |
| B3 `× 1.35` | `16.8750` |
| B5 `× 1.40` | `23.6250` |
| B6 `× 0.95` | `22.4438` |
| R7a `− 1` | `21.4438` |
| Lightning roll | `18.5000` |
| B6 lightning `× 0.95` | `17.5750` |
| R10 lightning `× 1.00` | `17.5750` |
| R13 `total = 21.4438 + 17.5750 = 39.0188`, floored | `39` |
| Hit chance | `78.1759 %` |
| `manaReturned = 21.4438 × 0.08` | `1.7155` |
| Resonance gained | `+1` |

With the expected-crit multiplier of `1.05` folded in instead of a single draw,
the same hit averages `41.0188` — the figure used in §11.2.

### E14 — Composed stat block, level-13 Ravager

Reference allocation, rare Battle Axe (+55 % ED, +25 AR), armour totalling
defence 210, `+35` life, `+18` fire resist, difficulty Trial.

| Stat | Working | Value |
|---|---|---|
| `strength` | `30 + 2 × 12` | `54` |
| `dexterity` | `20 + 1 × 12` | `32` |
| `vitality` | `25 + 2 × 12` | `49` |
| `maxLife` | `55 + (49 − 25) × 4.0 + 12 × 2.0 + 35` | `210` |
| `maxMana` | `10 + (10 − 10) × 1.0 + 12 × 0.5` | `16` |
| `attackRating` | `30 + 5 × (32 − 7) + 80 + 25` | `260` |
| `defense` | `210 + ⌊32 / 4⌋` | `218` |
| `fireResist` | `0 + 18 − 40 (Trial)` | `−22` |
| `lifeRegen` /s | `210 × 0.006` | `1.260` |
| `manaRegen` /s | `16 × 0.020` | `0.320` |
| `maxStamina` | `60 + 49 + 12` | `121` |

### E15 — Difficulty scaling of one monster

Bone Ranker, all nine zone × tier combinations, from §10.3:

| Zone / tier | mlvl | Life | Min–max damage | DEF | XP |
|---|---|---|---|---|---|
| Wastes / Instruction | 6 | `53` | `7–14` | `45` | `21` |
| Wastes / Trial | 18 | `211` | `23–46` | `110` | `93` |
| Wastes / Renunciation | 28 | `472` | `45–89` | `164` | `216` |
| Bonereach / Instruction | 11 | `98` | `12–24` | `72` | `41` |
| Bonereach / Trial | 23 | `299` | `31–63` | `137` | `133` |
| Bonereach / Renunciation | 33 | `611` | `57–113` | `191` | `280` |
| Altar / Instruction | 15 | `144` | `17–33` | `94` | `60` |
| Altar / Trial | 27 | `381` | `39–78` | `158` | `169` |
| Altar / Renunciation | 37 | `735` | `67–134` | `212` | `338` |

Rounding rule for these: multiply, then `Math.round`, once, at the end.

### E16 — Potion throughput

| # | Potion | `maxLife` | Restored | Rate |
|---|---|---|---|---|
| E16.1 | `potion_life_minor` (35 %, 3 s) | 165 | `57.7500` | `19.2500` /s |
| E16.2 | `potion_life_greater` (60 %, 3 s) | 165 | `99.0000` | `33.0000` /s |
| E16.3 | `potion_mana_minor` (35 %, 3 s) | 108 | `37.8000` | `12.6000` /s |
| E16.4 | `potion_rejuvenation` (40 %, instant) | 165 life / 108 mana | `66.0000` / `43.2000` | instant |

---

## 13. Deviations from the plan

**D-11 — Champion and unique multipliers.**
`IMPLEMENTATION_PLAN.md` §4.5 specifies champion ×2.5 life / ×1.5 damage and
unique ×5 life / ×2 damage. At those values a level-10 champion dies in 5.7 s
against the plan's own locked target of ≈ 10 s. The shipped values are champion
**×4.0 / ×1.6 / ×1.5 defence / +10 physical and +20 elemental resist** and unique
**×7.0 / ×2.2 / ×2.0 defence / +15 and +30 resist**, which land the three
reference builds at 11.10 / 9.19 / 10.40 s (§11.3). The pacing target was
locked; the multipliers were not.

**D-12 — Class damage scales are new.**
The plan gives no per-class damage modifier, which leaves the Emberwright with
an unpunished melee option and the Runeblade dominating both halves of its
kit. `meleeScale` and `spellScale` (§2.1) are the minimum mechanism that makes
each class best at its own thing. They are two numbers per class, they enter the
pipeline at exactly one point (B6), and they are what brings the level-10 TTK
spread down to 1.23×.

**D-13 — Death penalty is 5 % of the current level's band.**
The plan says "−5 % experience from level 5". Read as 5 % of the lifetime total
that is 14,472 XP at level 29 — more than half a level, which contradicts the
locked "soft death" design in the same table. It is specified here as 5 % of the
XP required for the current level (238 XP at clvl 10, 1,383 at clvl 29) and can
never de-level.

**D-14 — Difficulty uses a monster-level offset plus a small multiplier.**
The plan describes difficulty as "multipliers on monster life and damage".
Applying a raw multiplier *and* raising monster level would double-count, so
difficulty is defined as an `mlvl` offset (+12 / +22) that drives life, damage,
defence, AR and XP through the one scaling table, plus a modest extra multiplier
(×1.15 / ×1.35 life) for bite. This keeps a single source of truth for
progression and makes item level fall out of `mlvl` instead of needing its own
table.

**D-15 — Dodge is a stat, not a class mechanic.**
The plan's combat section covers to-hit and block but not dodge, while the
foundation brief requires it. `dodgeChance` is specified as a universal stat with
a base of 0 and a cap of 50 %, granted only by affixes and `shield_stance`. No
class has it by default, so the calibration in §11 is unaffected.

**D-16 — `attackScale` / `castScale` per class.**
Not in the plan. Without them the only lever on class feel is weapon choice, and
the Emberwright ends up casting at the same rate a Ravager swings a maul. Three
numbers per class, applied at exactly one point each (§4.3, §4.4).

**D-17 — Poison is specified as a total.**
See `01-data-model.md` §12 D-3. It changes the meaning of `poisonMin` /
`poisonMax` relative to the D2 model the plan draws on, and it is the reason
`poisonDuration` is safe to put on affixes.
