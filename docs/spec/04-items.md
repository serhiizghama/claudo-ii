# 04 — Itemisation

**Claudo II: Lord of Instruction** — the complete item, affix, loot and economy model.

Itemisation is the reason the genre has replay value. Everything here is
concrete: every base, every affix, every weight, every price. There is no
placeholder and no number left "to tune". Where a value was chosen to hit a
locked target, the arithmetic that proves it is shown.

**Binding documents this specification builds on and never contradicts:**

| Document | What it fixes |
|---|---|
| `01-data-model.md` | `ItemBase`, `AffixDefinition`, `AffixInstance`, `ItemInstance`, `UniqueDefinition`, the containers, and **the entire stat vocabulary** (§3). No stat identifier is invented here. |
| `03-combat-math.md` | Class tables, the damage pipeline, the seven reference weapons (§4.6), shield `blockBase` values (§5.3), consumable amounts (§8.8), monster scaling (§10), the calibration targets (§11). |
| `09-ui.md` | How an item is *presented*: tooltip line order and templates (§5), the inventory grid and drag rules (§6), the icon primitive library and framing (§7), the i18n key convention (§14). This document supplies the **content** those systems consume. |
| `02-api-contracts.md` | The `items` public surface (§11). Missing methods are requested in §13 below. |
| `ARCHITECTURE.md` | Determinism: loot rolls draw from the `items` stream in the fixed order base → quality → affix count → affix pick → affix values. |

**Conventions.** Metres, seconds, whole-number percents, `snake_case` data ids,
`lowerCamelCase` fields — all as `01-data-model.md` defines them. English is the
primary language; the Russian column exists so `src/ui/i18n.js` can be filled
from these tables directly (`item.base.<baseId>`, `affix.<affixId>`,
`unique.<uniqueId>.name` / `.lore`, per `09-ui.md` §14.2).

---

## Table of contents

1. [Item base catalogue](#1-item-base-catalogue)
2. [Affix catalogue](#2-affix-catalogue)
3. [Rare item naming](#3-rare-item-naming)
4. [The quality roll](#4-the-quality-roll)
5. [Treasure classes](#5-treasure-classes)
6. [Uniques](#6-uniques)
7. [Economy](#7-economy)
8. [Potions and consumables](#8-potions-and-consumables)
9. [The item generation algorithm](#9-the-item-generation-algorithm)
10. [Balance validation — `tools/lootsim.mjs`](#10-balance-validation--toolslootsimmjs)
11. [Procedural icon content](#11-procedural-icon-content)
12. [Implementation order](#12-implementation-order)
13. [Additions requested to `02-api-contracts.md`](#13-additions-requested-to-02-api-contractsmd)
14. [Deviations and contradictions](#14-deviations-and-contradictions)

---

## 0. What this document decides

| Question | Answer |
|---|---|
| How many bases? | **61 equipment bases** + the `unarmed` pseudo-base + 1 quest item + **12 consumables** = **75** `ItemBase` records |
| How many affixes? | **117** — 61 prefixes, 56 suffixes, organised into 63 exclusion groups and 7 `alvl` bands |
| How many uniques? | **8**, covering head / chest / hands / legs / belt / amulet / two weapons |
| How is the base picked? | Two draws: **group**, then **base within group**, both weighted, both filtered by `reqLevel ≤ ilvl` |
| How is rarity picked? | **One** draw against a cumulative ladder built from base probability × rank × Δ(`ilvl − mlvl`) × difficulty × Magic Find |
| Baseline rarity split | normal 61.95 % / superior 20.00 % / magic 16.00 % / rare 1.80 % / **unique 0.25 %** at MF 0 against a normal monster |
| Where does gold come from? | A `gold` entry inside the treasure class, amount `4 + 2.4·mlvl + 0.12·mlvl²` scaled by rank, `goldFind` and a ±25 % roll |
| Vendor spread | Buy at `itemValue`, sell at `0.25 × itemValue` — a flat **4×** spread |
| Is the player starved or drowning? | §7.7 shows the ledger at clvl 5 / 15 / 28. Neither: a zone clear funds a real upgrade every **1.5 / 3.0 / 0.5** clears. Gold stops being the binding constraint around level 24, which §7.7 names rather than hides |

---

## 1. Item base catalogue

### 1.1 The design rules the tables obey

Every weapon row is generated from a **base-DPS curve** anchored on the seven
reference weapons that `03-combat-math.md` §4.6 fixes. Those seven rows are
reproduced here **verbatim** — they are the calibration anchors for §11 of that
document and may never drift.

```
meleeBaseDps(reqLevel)  = 7.00 + 1.70 × reqLevel
casterBaseDps(reqLevel) = 6.00 + 0.45 × reqLevel

avgDamage = baseDps × attackTime
minDamage = round(avgDamage × 0.66)      maxDamage = round(avgDamage × 1.34)
```

Handling bands applied to `meleeBaseDps`:

| Handling | Band | Why |
|---|---|---|
| `oneHandMelee` | ×1.00 | the reference |
| `twoHandMelee` | ×1.00 | already compensated by `STR / 75` instead of `STR / 100` (`03` §4.1) and by a larger `attackTime` |
| `dagger` | ×0.92 | the fastest weapons in the game; the discount pays for the attack-speed advantage |
| `wand` / `staff` | `casterBaseDps` | a caster's damage comes from skills; the weapon is an affix platform |

Verification against the seven locked rows:

| Locked row | reqLevel | Curve value | Shipped avg DPS | Δ |
|---|---|---|---|---|
| `axe_hand_normal` | 1 | 8.70 | `6.5 / 0.80 = 8.13` | −6.6 % |
| `axe_battle_normal` | 9 | 22.30 | `16.0 / 0.75 = 21.33` | −4.3 % |
| `sword_rune_normal` | 8 | 20.60 | `12.5 / 0.65 = 19.23` | −6.7 % |
| `maul_great_normal` | 12 | 27.40 | `34.0 / 1.25 = 27.20` | −0.7 % |
| `wand_ember_normal` | **1** | 6.45 | `5.0 / 0.60 = 8.33` | **+29.1 %** — deliberate, see below |
| `staff_ash_normal` | 10 | 10.50 | `10.0 / 0.95 = 10.53` | +0.3 % |
| `unarmed` | 1 | — | `2.0 / 0.60 = 3.33` | pseudo-weapon, deliberately terrible |

**`wand_ember_normal` is `reqLevel 1` and is the one row that sits off its
curve.** It shipped at `reqLevel 5`, and it is the only caster weapon in the
reference set — so an Emberwright created at level 1 had an empty main hand for
five levels while `13-progression-lore.md` §4 was handing her one in the
starting kit. The two could not both be true. `reqLevel` moved to 1; the damage
did **not**, because `03-combat-math.md` §4.6's seven rows are calibration
anchors for its §11 and `05-skills.md`'s E-A/E-B/E-C builds are computed against
`3–7 at 0.60 s`. The consequence is a wand 29 % above `casterBaseDps(1) = 6.45`.

That is affordable precisely once, on this row, because the number it inflates
is a caster's *weapon* damage: `ember_bolt` at slvl 1 deals 12–20 fire before
any multiplier, so the wand's 3–7 physical is already the smaller half of the
smallest attack the class owns, and it never becomes relevant again. Every other
row in the catalogue is on its curve within ±7 %, and `S02` in the item harness
asserts that — with this row named as the single expected exception.

Every locked row sits inside ±7 % of the curve, so extending the curve to
`reqLevel 29` is a continuation of the calibrated model rather than a new one.

**Armour defence** follows a matching curve, with the mid-point of
`[defMin, defMax]` given by:

```
bodyDefence(reqLevel)   = 3.0 + 4.35 × reqLevel        (chest)
slotDefence(reqLevel)   = bodyDefence × slotShare
slotShare = { head 0.40, hands 0.28, legs 0.30, belt 0.22, offHand 0.55 }
defMin = round(mid × 0.76)      defMax = round(mid × 1.24)
```

The spread means a rolled `defense` (`ItemInstance.rolls.defense`, drawn in
`[defMin, defMax]`) varies by ±24 %, which is enough that two identical bases are
worth comparing without being enough to beat a tier upgrade.

**Durability**, **base value** and **drop weight**:

```
maxDurability = round(durBase + durPerLevel × reqLevel)
baseValue     = max(12, round(k × max(1, reqLevel) ^ 1.9))
```

| Group | `durBase` | `durPerLevel` | value `k` |
|---|---|---|---|
| one-hand melee weapon | 38 | 1.90 | 3.4 |
| two-hand melee weapon | 55 | 1.70 | 4.0 |
| dagger | 28 | 1.30 | 2.6 |
| wand | 24 | 1.20 | 3.0 |
| staff | 26 | 1.30 | 3.6 |
| shield | 50 | 2.20 | 3.2 |
| body armour | 50 | 2.20 | 3.8 |
| helm | 32 | 1.50 | 2.4 |
| gloves | 32 | 1.50 | 1.9 |
| boots | 32 | 1.50 | 1.9 |
| belt | 32 | 1.50 | 1.8 |
| jewelry / quest / consumable | **0** (indestructible) | — | ring 5.0, amulet 6.0 |

`axe_battle_normal` checks out against the two values `01-data-model.md` §5.1
states literally: `38 + 1.9 × 9 = 55.1 → 55` durability, and
`3.4 × 9^1.9 = 221 → ` the authored **220**. The one-gold difference is
deliberate: the tables carry authored integers, and the formulas are the rule
that generated them, not a runtime computation.

### 1.2 Affix applicability groups

`ItemBase.allowedAffixGroups` and `AffixDefinition.requiresGroups` must
intersect for an affix to be legal on a base. The vocabulary is exactly these
fifteen strings, and no other:

| Group | Meaning |
|---|---|
| `universal` | every item that can carry an affix |
| `weapon.any` | any weapon |
| `weapon.melee` | `oneHandMelee`, `twoHandMelee`, `dagger` |
| `weapon.caster` | `wand`, `staff` |
| `weapon.twohand` | any `twoHanded` weapon, melee or staff |
| `armour.any` | every `category === 'armour'` piece, shields included |
| `armour.body` | `slot === 'chest'` |
| `armour.helm` | `slot === 'head'` |
| `armour.gloves` | `slot === 'hands'` |
| `armour.boots` | `slot === 'legs'` |
| `armour.belt` | `slot === 'belt'` |
| `armour.shield` | `slot === 'offHand'` with `blockBase > 0` |
| `jewelry.any` | rings and amulets |
| `jewelry.ring` | rings |
| `jewelry.amulet` | amulets |

**Naming hazard, stated once.** `AffixDefinition.group` is the **exclusion**
group — one affix per group per item. `requiresGroups` / `allowedAffixGroups`
are the **applicability** groups above. They are different namespaces and never
share a value; exclusion groups are named after their stat family
(`enhanced_damage`, `resist_fire`), applicability groups always contain a dot.

### 1.3 The base-group table — the first draw of a base roll

| Group | Weight | Share | Slots it fills |
|---|---:|---:|---|
| `weapon` | 300 | 30.0 % | `mainHand` |
| `chest` | 120 | 12.0 % | `chest` |
| `helm` | 110 | 11.0 % | `head` |
| `gloves` | 95 | 9.5 % | `hands` |
| `boots` | 95 | 9.5 % | `legs` |
| `ring` | 90 | 9.0 % | `ring1`, `ring2` |
| `belt` | 85 | 8.5 % | `belt` |
| `shield` | 65 | 6.5 % | `offHand` |
| `amulet` | 40 | 4.0 % | `amulet` |
| **Total** | **1000** | 100 % | |

Two rings are worn and only one amulet, which is why `ring` carries more than
twice the `amulet` weight. A group whose eligible base list is empty at the
current `ilvl` is skipped and its weight redistributed proportionally over the
remaining groups **before** the draw, so a level-1 drop never wastes a roll.

At `ilvl 1` the eligible set is **eight** bases across **six** groups —
`shield`, `ring` and `amulet` have nothing until `ilvl 3`, `4` and `6`
respectively, and their weight is redistributed. By `ilvl 12` twenty-seven bases
are eligible across all nine groups; at `ilvl 29` all sixty-one are.

### 1.4 Weapons — 26 bases (plus the `unarmed` pseudo-base)

Affix-set codes in the last column expand via §1.4.1. `Sp` is `weapon.range` in
metres and only appears on the tooltip above 2.4 m (`09-ui.md` §5.2 order 14).
`2H` marks `weapon.twoHanded`. Rows in **bold** are reproduced verbatim from
`03-combat-math.md` §4.6 and are frozen.

| id | EN | RU | Handling | Tier | reqLvl | reqStr | reqDex | Grid | Damage | `attackTime` | AR | 2H | Sp | Dur | Value | Weight | Surface | `iconSeed` | Affix set |
|---|---|---|---|---|---:|---:|---:|---|---|---:|---:|:-:|---:|---:|---:|---:|---|---|---|
| `unarmed` | — | — | `unarmed` | normal | 1 | 0 | 0 | — | **1–3** | **0.60** | 0 | — | 1.4 | 0 | 0 | 0 | `flesh` | — | — |
| **`axe_hand_normal`** | Hand Axe | Ручной топор | `oneHandMelee` | normal | 1 | 18 | 0 | 1×3 | **4–9** | **0.80** | 40 | — | 1.9 | 40 | 12 | 90 | `metal` | `0x1a07` | W1 |
| **`axe_battle_normal`** | Battle Axe | Боевой топор | `oneHandMelee` | normal | 9 | 40 | 0 | 2×3 | **10–22** | **0.75** | 80 | — | 1.9 | 55 | 220 | 80 | `metal` | `0x51c4` | W1 |
| `axe_cleaver_exceptional` | Ash Cleaver | Пепельный колун | `oneHandMelee` | exceptional | 17 | 58 | 0 | 2×3 | 18–38 | 0.78 | 130 | — | 2.0 | 70 | 740 | 60 | `metal` | `0x2be1` | W1 |
| `axe_ruin_elite` | Ruin Axe | Топор разрухи | `oneHandMelee` | elite | 26 | 78 | 0 | 2×3 | 27–55 | 0.80 | 190 | — | 2.0 | 87 | 1658 | 40 | `metal` | `0x77af` | W1 |
| `sword_short_normal` | Short Sword | Короткий меч | `oneHandMelee` | normal | 1 | 12 | 12 | 1×3 | 4–8 | 0.70 | 45 | — | 1.9 | 40 | 12 | 90 | `metal` | `0x0c35` | W1 |
| **`sword_rune_normal`** | Rune Sword | Рунный меч | `oneHandMelee` | normal | 8 | 30 | 25 | 1×3 | **8–17** | **0.65** | 80 | — | 1.9 | 53 | 177 | 80 | `metal` | `0x93d2` | W1 |
| `sword_sigil_exceptional` | Sigil Blade | Клинок печати | `oneHandMelee` | exceptional | 16 | 45 | 38 | 1×3 | 15–30 | 0.65 | 125 | — | 2.0 | 68 | 660 | 60 | `metal` | `0x4e88` | W1 |
| `sword_verdict_elite` | Verdict | Приговор | `oneHandMelee` | elite | 25 | 62 | 52 | 1×3 | 22–44 | 0.66 | 180 | — | 2.0 | 86 | 1539 | 40 | `metal` | `0xa1c9` | W1 |
| `sword_great_exceptional` | Greatsword | Двуручный меч | `twoHandMelee` | exceptional | 19 | 68 | 30 | 2×4 | 27–55 | 1.05 | 140 | ✔ | 2.4 | 87 | 1076 | 45 | `metal` | `0x6d1b` | W2 |
| `mace_flanged_normal` | Flanged Mace | Перистая булава | `oneHandMelee` | normal | 11 | 46 | 0 | 2×3 | 14–29 | 0.85 | 70 | — | 1.9 | 59 | 324 | 75 | `metal` | `0x38f0` | W1 |
| `mace_censer_exceptional` | Bone Censer | Костяное кадило | `oneHandMelee` | exceptional | 20 | 63 | 0 | 2×3 | 24–48 | 0.88 | 120 | — | 2.0 | 76 | 1008 | 55 | `bone` | `0xc402` | W1 |
| `hammer_edict_elite` | Edict Hammer | Молот эдикта | `oneHandMelee` | elite | 28 | 84 | 0 | 2×3 | 33–67 | 0.92 | 175 | — | 2.1 | 91 | 1906 | 35 | `metal` | `0x8e5d` | W1 |
| **`maul_great_normal`** | Great Maul | Большой молот | `twoHandMelee` | normal | 12 | 62 | 0 | 2×4 | **22–46** | **1.25** | 60 | ✔ | 2.4 | 75 | 449 | 60 | `metal` | `0x2f96` | W2 |
| `polearm_reave_exceptional` | Reaving Glaive | Жатвенная глефа | `twoHandMelee` | exceptional | 18 | 70 | 25 | 2×4 | 27–55 | 1.10 | 135 | ✔ | **2.8** | 86 | 971 | 40 | `metal` | `0xb713` | W2 |
| `maul_ossuary_exceptional` | Ossuary Maul | Оссуарный молот | `twoHandMelee` | exceptional | 21 | 85 | 0 | 2×4 | 36–73 | 1.28 | 100 | ✔ | 2.5 | 91 | 1301 | 40 | `bone` | `0x5c60` | W2 |
| `maul_anvil_elite` | Anvil of Silence | Наковальня безмолвия | `twoHandMelee` | elite | 29 | 96 | 0 | 2×4 | 52–106 | 1.40 | 120 | ✔ | 2.6 | 104 | 2397 | 25 | `metal` | `0xf0a8` | W2 |
| `dagger_shard_normal` | Bone Shard | Костяной осколок | `dagger` | normal | 1 | 8 | 15 | 1×2 | 3–5 | 0.50 | 55 | — | 1.5 | 29 | 12 | 55 | `bone` | `0x1d44` | DG |
| `dagger_kris_normal` | Ash Kris | Пепельный крис | `dagger` | normal | 10 | 18 | 40 | 1×2 | 7–14 | 0.48 | 100 | — | 1.5 | 41 | 206 | 50 | `metal` | `0x6a21` | DG |
| `dagger_scalpel_exceptional` | Instructor's Scalpel | Скальпель наставника | `dagger` | exceptional | 19 | 25 | 62 | 1×2 | 11–22 | 0.46 | 155 | — | 1.5 | 53 | 699 | 35 | `metal` | `0xd39c` | DG |
| `dagger_final_elite` | Final Word | Последнее слово | `dagger` | elite | 28 | 34 | 78 | 1×2 | 15–30 | 0.45 | 215 | — | 1.6 | 64 | 1458 | 22 | `metal` | `0x40e7` | DG |
| **`wand_ember_normal`** | Ember Wand | Тлеющий жезл | `wand` | normal | **1** | 12 | 0 | 1×2 | **3–7** | **0.60** | 10 | — | 1.5 | 30 | 64 | 80 | `bone` | `0x9b12` | WC |
| `wand_cinder_exceptional` | Cinder Wand | Угольный жезл | `wand` | exceptional | 14 | 20 | 0 | 1×2 | 4–10 | 0.58 | 18 | — | 1.5 | 41 | 452 | 55 | `bone` | `0x27ce` | WC |
| `wand_grammar_elite` | Grammarian's Wand | Жезл грамматика | `wand` | elite | 24 | 28 | 0 | 1×2 | 6–13 | 0.56 | 26 | — | 1.6 | 53 | 1257 | 34 | `bone` | `0xe855` | WC |
| **`staff_ash_normal`** | Ash Staff | Пепельный посох | `staff` | normal | 10 | 20 | 0 | 1×4 | **6–14** | **0.95** | 20 | ✔ | 2.4 | 39 | 286 | 72 | `wood` | `0x3c7b` | ST |
| `staff_sermon_exceptional` | Sermon Staff | Посох проповеди | `staff` | exceptional | 18 | 30 | 0 | 2×4 | 9–17 | 0.92 | 30 | ✔ | 2.5 | 49 | 874 | 50 | `wood` | `0x71e3` | ST |
| `staff_silence_elite` | Staff of Silence | Посох безмолвия | `staff` | elite | 27 | 40 | 0 | 2×4 | 11–22 | 0.90 | 40 | ✔ | 2.5 | 61 | 1883 | 32 | `wood` | `0xaa19` | ST |

Every weapon carries `weapon.element = 'physical'`. No base grants elemental
damage; that is exclusively an affix and unique job, which keeps the
`elementalDamagePercent` affixes meaningful on every weapon rather than only on
the ones that happened to be authored with a fire roll.

#### 1.4.1 Affix-set codes

| Code | `allowedAffixGroups` |
|---|---|
| W1 | `['universal', 'weapon.any', 'weapon.melee']` |
| W2 | `['universal', 'weapon.any', 'weapon.melee', 'weapon.twohand']` |
| DG | `['universal', 'weapon.any', 'weapon.melee']` |
| WC | `['universal', 'weapon.any', 'weapon.caster']` |
| ST | `['universal', 'weapon.any', 'weapon.caster', 'weapon.twohand']` |
| SH | `['universal', 'armour.any', 'armour.shield']` |
| BD | `['universal', 'armour.any', 'armour.body']` |
| HL | `['universal', 'armour.any', 'armour.helm']` |
| GL | `['universal', 'armour.any', 'armour.gloves']` |
| BT | `['universal', 'armour.any', 'armour.boots']` |
| BL | `['universal', 'armour.any', 'armour.belt']` |
| RG | `['universal', 'jewelry.any', 'jewelry.ring']` |
| AM | `['universal', 'jewelry.any', 'jewelry.amulet']` |

`DG` and `W1` expand identically today. They are kept distinct because a
dagger-only affix is the obvious first addition after M9, and separating them
now costs one table row and avoids a data migration later.

### 1.5 Armour — 29 bases

`Blk` is `armour.blockBase`; `Mv` is `armour.moveSpeedPenalty` in whole
percent, subtracted from `movementSpeed`.

| id | EN | RU | Slot | Tier | reqLvl | reqStr | Grid | Defence | Blk | Mv | Dur | Value | Weight | Surface | `iconSeed` | Affix set |
|---|---|---|---|---|---:|---:|---|---|---:|---:|---:|---:|---:|---|---|---|
| `shield_buckler_normal` | Buckler | Баклер | `offHand` | normal | 3 | 16 | 2×2 | 6–12 | **40** | 0 | 57 | 26 | 100 | `metal` | `0x1102` | SH |
| `shield_targe_normal` | Bone Targe | Костяная тарча | `offHand` | normal | 11 | 34 | 2×3 | 21–35 | **50** | 0 | 74 | 305 | 85 | `bone` | `0x5507` | SH |
| `shield_kite_exceptional` | Kite Shield | Каплевидный щит | `offHand` | exceptional | 19 | 55 | 2×3 | 36–58 | **55** | −3 | 92 | 861 | 60 | `metal` | `0x9a3e` | SH |
| `shield_tower_elite` | Tower Shield | Ростовой щит | `offHand` | elite | 27 | 82 | 2×4 | 50–82 | **65** | −7 | 109 | 1674 | 38 | `metal` | `0xd2b4` | SH |
| `armour_rags` | Ragged Vestments | Рваное облачение | `chest` | normal | 1 | 0 | 2×3 | 2–5 | 0 | 0 | 52 | 12 | 30 | `ash` | `0x0a91` | BD |
| `armour_quilted_normal` | Quilted Coat | Стёганый кафтан | `chest` | normal | 4 | 14 | 2×3 | 16–25 | 0 | 0 | 59 | 53 | 95 | `flesh` | `0x3320` | BD |
| `armour_robe_normal` | Ashweave Robe | Пепельнотканая роба | `chest` | normal | 7 | 10 | 2×3 | 16–26 | 0 | 0 | 65 | 153 | 85 | `ash` | `0x6612` | BD |
| `armour_scale_normal` | Scale Mail | Чешуйчатый доспех | `chest` | normal | 10 | 38 | 2×3 | 35–58 | 0 | −2 | 72 | 302 | 100 | `metal` | `0x88c3` | BD |
| `armour_shroud_exceptional` | Ember Shroud | Тлеющий покров | `chest` | exceptional | 16 | 22 | 2×3 | 34–56 | 0 | 0 | 85 | 737 | 62 | `ash` | `0xb04f` | BD |
| `armour_plated_exceptional` | Plated Hauberk | Пластинчатый хауберк | `chest` | exceptional | 18 | 62 | 2×3 | 62–101 | 0 | −4 | 90 | 922 | 65 | `metal` | `0xc95a` | BD |
| `armour_litany_elite` | Litany Robe | Роба литании | `chest` | elite | 25 | 30 | 2×3 | 53–86 | 0 | 0 | 105 | 1720 | 38 | `ash` | `0xe317` | BD |
| `armour_sepulchre_elite` | Sepulchral Plate | Склепный доспех | `chest` | elite | 27 | 84 | 2×3 | 92–149 | 0 | −6 | 109 | 1988 | 42 | `metal` | `0xf6d0` | BD |
| `helm_cap_normal` | Leather Cap | Кожаный шлем | `head` | normal | 1 | 8 | 2×2 | 2–4 | 0 | 0 | 34 | 12 | 100 | `flesh` | `0x0451` | HL |
| `helm_coif_normal` | Bone Coif | Костяной койф | `head` | normal | 8 | 26 | 2×2 | 11–19 | 0 | 0 | 44 | 125 | 90 | `bone` | `0x4a08` | HL |
| `helm_diadem_exceptional` | Ashen Diadem | Пепельная диадема | `head` | exceptional | 15 | 16 | 2×2 | 13–21 | 0 | 0 | 55 | 412 | 60 | `metal` | `0x7fd6` | HL |
| `helm_barbute_exceptional` | Barbute | Барбют | `head` | exceptional | 17 | 48 | 2×2 | 23–38 | 0 | 0 | 58 | 523 | 62 | `metal` | `0x9e2a` | HL |
| `helm_gravemask_elite` | Grave Mask | Погребальная маска | `head` | elite | 26 | 70 | 2×2 | 35–58 | 0 | 0 | 71 | 1170 | 40 | `bone` | `0xcb63` | HL |
| `gloves_wraps_normal` | Hand Wraps | Обмотки | `hands` | normal | 1 | 6 | 2×2 | 2–3 | 0 | 0 | 34 | 12 | 100 | `flesh` | `0x0777` | GL |
| `gloves_bracers_normal` | Studded Bracers | Клёпаные наручи | `hands` | normal | 9 | 24 | 2×2 | 9–15 | 0 | 0 | 46 | 124 | 90 | `flesh` | `0x4c19` | GL |
| `gloves_gauntlets_exceptional` | Ash Gauntlets | Пепельные рукавицы | `hands` | exceptional | 18 | 46 | 2×2 | 17–28 | 0 | 0 | 59 | 461 | 62 | `metal` | `0xa5b8` | GL |
| `gloves_ordinance_elite` | Gauntlets of Ordinance | Рукавицы устава | `hands` | elite | 26 | 66 | 2×2 | 25–40 | 0 | 0 | 71 | 926 | 40 | `metal` | `0xdd41` | GL |
| `boots_hide_normal` | Hide Boots | Сыромятные сапоги | `legs` | normal | 1 | 6 | 2×2 | 2–3 | 0 | 0 | 34 | 12 | 100 | `flesh` | `0x0932` | BT |
| `boots_greaves_normal` | Bone Greaves | Костяные поножи | `legs` | normal | 9 | 25 | 2×2 | 10–16 | 0 | 0 | 46 | 124 | 90 | `bone` | `0x4f6c` | BT |
| `boots_march_exceptional` | Marching Greaves | Походные поножи | `legs` | exceptional | 18 | 47 | 2×2 | 19–30 | 0 | 0 | 59 | 461 | 62 | `metal` | `0xa8d5` | BT |
| `boots_pilgrim_elite` | Pilgrim Sabatons | Сабатоны паломника | `legs` | elite | 26 | 68 | 2×2 | 26–43 | 0 | 0 | 71 | 926 | 40 | `metal` | `0xe0be` | BT |
| `belt_sash_normal` | Cord Sash | Верёвочный кушак | `belt` | normal | 1 | 5 | 2×1 | 1–2 | 0 | 0 | 34 | 12 | 100 | `flesh` | `0x0b58` | BL |
| `belt_studded_normal` | Studded Belt | Клёпаный пояс | `belt` | normal | 9 | 22 | 2×1 | 7–11 | 0 | 0 | 46 | 117 | 90 | `flesh` | `0x5271` | BL |
| `belt_plated_exceptional` | Plated Girdle | Пластинчатый пояс | `belt` | exceptional | 18 | 44 | 2×1 | 14–22 | 0 | 0 | 59 | 437 | 62 | `metal` | `0xab90` | BL |
| `belt_ledger_elite` | Ledger Belt | Пояс реестра | `belt` | elite | 26 | 64 | 2×1 | 19–32 | 0 | 0 | 71 | 878 | 40 | `metal` | `0xe45f` | BL |

The three **caster** chest bases (`armour_robe_normal`, `armour_shroud_exceptional`,
`armour_litany_elite`) and `helm_diadem_exceptional` carry 62 % of the curve's
defence but roughly a third of its strength requirement and no movement
penalty. That is the whole trade: an Emberwright on the reference allocation
(`03` §2.2) has STR 39 at clvl 25 and can wear `armour_litany_elite` (reqStr 30)
but not `armour_sepulchre_elite` (reqStr 84) without a `strength` prefix.

### 1.6 Jewelry and quest items — 7 bases

Jewelry has `maxDurability = 0` (indestructible), no defence, and exists purely
as an affix platform. That is why `ring` and `amulet` carry the widest affix
sets in §2.

| id | EN | RU | Slot | Tier | reqLvl | Grid | Dur | Value | Weight | Surface | `iconSeed` | Affix set |
|---|---|---|---|---|---:|---|---:|---:|---:|---|---|---|
| `ring_iron` | Iron Band | Железный обруч | `ring1` | normal | 4 | 1×1 | 0 | 70 | 100 | `metal` | `0x1200` | RG |
| `ring_bone` | Bone Ring | Костяное кольцо | `ring1` | exceptional | 12 | 1×1 | 0 | 562 | 70 | `bone` | `0x5a44` | RG |
| `ring_gilt` | Gilt Ring | Золочёное кольцо | `ring1` | elite | 22 | 1×1 | 0 | 1776 | 42 | `metal` | `0xc17d` | RG |
| `amulet_cord` | Corded Amulet | Плетёный амулет | `amulet` | normal | 6 | 1×1 | 0 | 181 | 100 | `flesh` | `0x2d90` | AM |
| `amulet_reliquary` | Reliquary Amulet | Амулет-реликварий | `amulet` | exceptional | 16 | 1×1 | 0 | 1164 | 65 | `metal` | `0x86ea` | AM |
| `amulet_seal` | Sealed Amulet | Запечатанный амулет | `amulet` | elite | 25 | 1×1 | 0 | 2715 | 40 | `metal` | `0xf29b` | AM |
| `quest_first_tablet` | The First Tablet | Первая Табличка | — | normal | 1 | 2×2 | 0 | 0 | **0** | `stone` | `0x0001` | — |

`ItemBase.slot` for a ring is `'ring1'`; `items.slotsFor()`
(`09-ui.md` §16.2) is what reports the real list `['ring1','ring2']`, and a
one-handed weapon likewise reports `['mainHand','offHand']`.

`quest_first_tablet` has `dropWeight 0` and appears in no treasure class — it is
placed by `world` on the altar and taken through the interaction path, never
rolled. It cannot be sold, dropped in a non-town zone, or stashed while the
quest is active.

### 1.7 Coverage check — is every slot fillable at every level?

The lowest `reqLevel` per slot, and the level at which the second tier arrives:

| Slot | First base | reqLvl | Second | reqLvl | Third | reqLvl | Fourth | reqLvl |
|---|---|---:|---|---:|---|---:|---|---:|
| `mainHand` | `axe_hand_normal` / `sword_short_normal` / `dagger_shard_normal` / `wand_ember_normal` | 1 | `staff_ash_normal` | 10 | `sword_rune_normal` | 8 | `axe_battle_normal` | 9 |
| `offHand` | `shield_buckler_normal` | 3 | `shield_targe_normal` | 11 | `shield_kite_exceptional` | 19 | `shield_tower_elite` | 27 |
| `chest` | `armour_rags` | 1 | `armour_quilted_normal` | 4 | `armour_robe_normal` | 7 | `armour_scale_normal` | 10 |
| `head` | `helm_cap_normal` | 1 | `helm_coif_normal` | 8 | `helm_diadem_exceptional` | 15 | `helm_barbute_exceptional` | 17 |
| `hands` | `gloves_wraps_normal` | 1 | `gloves_bracers_normal` | 9 | `gloves_gauntlets_exceptional` | 18 | `gloves_ordinance_elite` | 26 |
| `legs` | `boots_hide_normal` | 1 | `boots_greaves_normal` | 9 | `boots_march_exceptional` | 18 | `boots_pilgrim_elite` | 26 |
| `belt` | `belt_sash_normal` | 1 | `belt_studded_normal` | 9 | `belt_plated_exceptional` | 18 | `belt_ledger_elite` | 26 |
| `ring1` / `ring2` | `ring_iron` | 4 | `ring_bone` | 12 | `ring_gilt` | 22 | — | — |
| `amulet` | `amulet_cord` | 6 | `amulet_reliquary` | 16 | `amulet_seal` | 25 | — | — |

Nine of the ten slots are fillable by character level 4, and all ten by level 6.
`tools/lootsim.mjs` asserts this as a hard gate (§10, check **L1**).

### 1.8 The curve at the far end — checked against `03-combat-math.md` §11

§1.1 proves the weapon curve reproduces the seven anchor rows at
`reqLevel 1…12`. The rows that matter for balance, though, are the ones §11 of
the combat document never reaches: the exceptional and elite tiers. Two checks,
against the locked pacing target of **2–4 hits, 1.5–3.0 s** for a normal
monster.

**Level 28 Ravager vs a Renunciation Ashen Wastes Bone Ranker (`mlvl 28`).**
Target from `03-combat-math.md` §10.3: life **472**, DEF **164**,
`flatDR = ⌊28/8⌋ = 3`, `physicalResist 0` (see C-5). Reference allocation
(2/1/2/0): STR 84, DEX 47, VIT 79 → `maxLife 325`.
Kit: `axe_ruin_elite` (27–55, 0.80 s, AR 190, reqStr 78 ≤ 84 ✔) rolled rare with
`pfx_enhanced_damage_5` at 90, `sfx_attack_rating_3` at 60, `sfx_ias_2` at 22,
`sfx_crit_2` at 9; one ring with `pfx_flat_phys_3` at 9 / 21.

```
B1 weapon average          (27 + 55) / 2                      =  41.000
B3 × enhanced damage       × (1 + 90/100)                     =  77.900
B4 + flat physical         + (9 + 21) / 2                     =  92.900
B5 × attribute bonus       × (1 + 84/100)                     = 170.936
B6 × class melee scale     × 1.00                             = 170.936
R6 × expected crit         × (0.86 + 0.14 × 2.00)             = 194.867
R7a − flat DR              − 3                                = 191.867   per landed hit

hits to kill               472 / 191.867                      =   2.46    → 2–4 ✔
AR                         30 + 5×(47−7) + 190 + 60           = 480
chance to hit              200 × 480/(480+164) × 28/(28+28)   =  74.53 %
attack interval            0.80 × 0.90 / (1 + 22/100)         =   0.5902 s
DPS                        0.7453 × 191.867 / 0.5902          = 242.3
TTK                        472 / 242.3                        =   1.95 s  → 1.5–3.0 ✔
```

**Level 17 Ravager vs a Trial Ashen Wastes Bone Ranker (`mlvl 18`)** — the
exceptional tier, and the tightest point on the whole curve. Target: life
**211**, DEF **110**, `flatDR 2`. STR 62, DEX 36. Kit: `axe_cleaver_exceptional`
(18–38, 0.78 s, AR 130, reqStr 58 ≤ 62 ✔) rolled magic with
`pfx_enhanced_damage_3` at 40 and `sfx_attack_rating_2` at 21.

```
per landed hit   28 × 1.40 × 1.62 × 1.05 − 2                  =  64.71
hits to kill     211 / 64.71                                  =   3.26   → 2–4 ✔
AR               30 + 5×(36−7) + 130 + 21                     = 326
chance to hit    200 × 326/436 × 17/(17+18)                   =  72.63 %
interval         0.78 × 0.90                                  =   0.7020 s
DPS              0.7263 × 64.71 / 0.7020                      =  66.95
TTK              211 / 66.95                                  =   3.15 s  → 0.15 s OVER
```

The exceptional tier with **no attack-speed roll at all** lands 0.15 s outside
the window. One `sfx_ias_1` at its minimum (+6 %) brings it to 2.97 s and at its
maximum (+13 %) to 2.79 s. That is the correct shape for the tightest point on a
curve: the base tier alone is marginal, and the first speed affix fixes it —
which is what makes `sfx_ias_1` feel like an upgrade rather than a rounding
error. It is recorded here rather than tuned away, and `tools/balance.mjs`
should carry it as a known-marginal case at clvl 17.

---

## 2. Affix catalogue

**117 affixes — 61 prefixes and 56 suffixes**, in 63 exclusion groups across
seven `alvl` bands. Every `stat` identifier below is from
`01-data-model.md` §3 and nothing else.

### 2.1 How to read the tables

| Column | Meaning |
|---|---|
| `id` | `AffixDefinition.id`. Stable forever — a save stores it. |
| Group | `AffixDefinition.group`. **One affix per group per item**, prefixes and suffixes share one namespace, so an item can never carry both a prefix and a suffix from the same group. |
| EN / RU | `AffixDefinition.name` and its `affix.<id>` Russian value. |
| `alvl` | minimum `ilvl` to roll. |
| `max` | `AffixDefinition.maxLevel` — above this `ilvl` the tier stops rolling, so low tiers age out. `99` means never. |
| Applies | `requiresGroups`, using the §1.4.1 codes. `appliesTo` is derived: any `W*` code contributes `'weapon'`, any `A*` code `'armour'`, any `J*` code `'jewelry'`, `U` all three. |
| Mods | `mods[]` in array order — the order values are rolled and stored in. |
| W | `weight` inside the filtered pool. |

Applicability shorthand: `U` universal · `W*` weapon.any · `Wm` weapon.melee ·
`Wc` weapon.caster · `W2` weapon.twohand · `A*` armour.any · `Ab` body ·
`Ah` helm · `Ag` gloves · `At` boots · `Al` belt · `As` shield ·
`J*` jewelry.any · `Jr` ring · `Ja` amulet.

### 2.2 The `alvl` bands

An affix tier is authored into one of seven bands. The band is what stops a
level-5 item rolling a level-25 affix, and the `max` column is what stops a
level-40 item still rolling the level-1 junk tier.

| Band | `alvl` range | Reachable from | Typical content |
|---|---|---|---|
| B0 | 1–3 | the first Wastes run | the entry tier of every core family |
| B1 | 4–8 | Wastes, Instruction | second tiers, first elemental flats |
| B2 | 9–13 | Bonereach, Instruction | leech, crit, resist-all, mana return |
| B3 | 14–18 | Altar, Instruction | third tiers, `+1 tree skills`, pierce |
| B4 | 19–22 | Wastes, Trial | fourth tiers, `cannotBeFrozen`, crit multiplier |
| B5 | 23–26 | Bonereach / Altar, Trial | top elemental flats, top attributes |
| B6 | 27–29 | Renunciation | `+2 tree skills`, `+1 all skills`, `maxFireResist` |

Nothing rolls above `alvl 29`, so a Renunciation Altar drop at `ilvl 40` sees
the whole catalogue and no more. That is deliberate: the endgame chase is a
better *roll* inside a known range, not an unseen tier.

### 2.3 Prefixes — 61

| id | Group | EN | RU (masc.) | alvl | max | Applies | Mods | W |
|---|---|---|---|---:|---:|---|---|---:|
| `pfx_enhanced_damage_1` | `enhanced_damage` | Bitter | Едкий | 1 | 18 | `W*` | `enhancedDamage 8–18` | 100 |
| `pfx_enhanced_damage_2` | `enhanced_damage` | Jagged | Зазубренный | 4 | 26 | `W*` | `enhancedDamage 19–29` | 78 |
| `pfx_enhanced_damage_3` | `enhanced_damage` | Keen | Острый | 8 | 40 | `W*` | `enhancedDamage 30–50` | 60 |
| `pfx_enhanced_damage_4` | `enhanced_damage` | Cruel | Жестокий | 20 | 40 | `W*` | `enhancedDamage 51–75` | 42 |
| `pfx_enhanced_damage_5` | `enhanced_damage` | Merciless | Беспощадный | 28 | 99 | `W*` | `enhancedDamage 76–105` | 24 |
| `pfx_flat_phys_1` | `flat_physical` | Rough | Грубый | 1 | 20 | `W*` `Ag` `Jr` `Ja` | `minDamage 1–2`, `maxDamage 3–5` | 92 |
| `pfx_flat_phys_2` | `flat_physical` | Sharp | Резкий | 12 | 32 | `W*` `Ag` `Jr` `Ja` | `minDamage 3–6`, `maxDamage 8–14` | 66 |
| `pfx_flat_phys_3` | `flat_physical` | Sundering | Раскалывающий | 24 | 99 | `W*` `Ag` `Jr` `Ja` | `minDamage 7–12`, `maxDamage 16–26` | 38 |
| `pfx_flat_fire_1` | `flat_fire` | Smoking | Дымный | 4 | 22 | `W*` `Ag` `Jr` `Ja` | `fireMin 1–3`, `fireMax 4–8` | 84 |
| `pfx_flat_fire_2` | `flat_fire` | Smouldering | Тлеющий | 13 | 33 | `W*` `Ag` `Jr` `Ja` | `fireMin 4–8`, `fireMax 11–20` | 60 |
| `pfx_flat_fire_3` | `flat_fire` | Pyre-Born | Рождённый костром | 23 | 99 | `W*` `Ag` `Jr` `Ja` | `fireMin 9–16`, `fireMax 24–40` | 34 |
| `pfx_flat_cold_1` | `flat_cold` | Chilling | Студёный | 4 | 22 | `W*` `Ag` `Jr` `Ja` | `coldMin 1–2`, `coldMax 3–6` | 84 |
| `pfx_flat_cold_2` | `flat_cold` | Frigid | Морозный | 13 | 33 | `W*` `Ag` `Jr` `Ja` | `coldMin 3–6`, `coldMax 8–15` | 60 |
| `pfx_flat_cold_3` | `flat_cold` | Glacial | Ледниковый | 23 | 99 | `W*` `Ag` `Jr` `Ja` | `coldMin 7–13`, `coldMax 18–30` | 34 |
| `pfx_flat_light_1` | `flat_lightning` | Static | Статичный | 4 | 22 | `W*` `Ag` `Jr` `Ja` | `lightMin 1–1`, `lightMax 6–12` | 84 |
| `pfx_flat_light_2` | `flat_lightning` | Arcing | Дуговой | 13 | 33 | `W*` `Ag` `Jr` `Ja` | `lightMin 1–2`, `lightMax 16–30` | 60 |
| `pfx_flat_light_3` | `flat_lightning` | Storm-Sworn | Клятый бурей | 23 | 99 | `W*` `Ag` `Jr` `Ja` | `lightMin 1–3`, `lightMax 34–62` | 34 |
| `pfx_flat_poison_1` | `flat_poison` | Tainted | Порченый | 8 | 26 | `W*` `Ag` `Jr` `Ja` | `poisonMin 6–12`, `poisonMax 14–24` | 56 |
| `pfx_flat_poison_2` | `flat_poison` | Virulent | Ядовитый | 20 | 99 | `W*` `Ag` `Jr` `Ja` | `poisonMin 20–34`, `poisonMax 44–72` | 32 |
| `pfx_flat_magic_1` | `flat_magic` | Unspoken | Несказанный | 18 | 99 | `W*` `Ja` | `magicMin 3–6`, `magicMax 9–16` | 26 |
| `pfx_defense_1` | `defense_flat` | Sturdy | Крепкий | 1 | 18 | `A*` | `defense 4–9` | 100 |
| `pfx_defense_2` | `defense_flat` | Strong | Прочный | 8 | 27 | `A*` | `defense 10–22` | 78 |
| `pfx_defense_3` | `defense_flat` | Bastion | Оплотный | 16 | 34 | `A*` | `defense 23–46` | 56 |
| `pfx_defense_4` | `defense_flat` | Adamant | Непреклонный | 25 | 99 | `A*` | `defense 47–90` | 34 |
| `pfx_defpct_1` | `defense_percent` | Plated | Обшитый | 6 | 24 | `A*` | `defensePercent 12–25` | 80 |
| `pfx_defpct_2` | `defense_percent` | Fortified | Укреплённый | 15 | 33 | `A*` | `defensePercent 26–45` | 56 |
| `pfx_defpct_3` | `defense_percent` | Impenetrable | Непробиваемый | 25 | 99 | `A*` | `defensePercent 46–75` | 32 |
| `pfx_life_1` | `max_life` | Hale | Бодрый | 1 | 18 | `Ab` `Ah` `Al` `As` `J*` | `maxLife 5–11` | 96 |
| `pfx_life_2` | `max_life` | Vigorous | Живучий | 8 | 27 | `Ab` `Ah` `Al` `As` `J*` | `maxLife 12–24` | 76 |
| `pfx_life_3` | `max_life` | Enduring | Стойкий | 16 | 34 | `Ab` `Ah` `Al` `As` `J*` | `maxLife 25–42` | 54 |
| `pfx_life_4` | `max_life` | Undying | Неумирающий | 25 | 99 | `Ab` `Ah` `Al` `As` `J*` | `maxLife 43–70` | 32 |
| `pfx_mana_1` | `max_mana` | Lucid | Ясный | 1 | 20 | `Ab` `Ah` `Al` `Wc` `J*` | `maxMana 6–13` | 92 |
| `pfx_mana_2` | `max_mana` | Arcane | Тайный | 11 | 30 | `Ab` `Ah` `Al` `Wc` `J*` | `maxMana 14–30` | 66 |
| `pfx_mana_3` | `max_mana` | Boundless | Безбрежный | 22 | 99 | `Ab` `Ah` `Al` `Wc` `J*` | `maxMana 31–55` | 38 |
| `pfx_firepct_1` | `fire_damage_percent` | Kindling | Разжигающий | 9 | 28 | `Wc` `J*` | `fireDamagePercent 10–20` | 54 |
| `pfx_firepct_2` | `fire_damage_percent` | Conflagrant | Испепеляющий | 21 | 99 | `Wc` `J*` | `fireDamagePercent 21–38` | 30 |
| `pfx_coldpct_1` | `cold_damage_percent` | Rimed | Инеистый | 9 | 28 | `Wc` `J*` | `coldDamagePercent 10–20` | 54 |
| `pfx_coldpct_2` | `cold_damage_percent` | Deepfrost | Мерзлотный | 21 | 99 | `Wc` `J*` | `coldDamagePercent 21–38` | 30 |
| `pfx_lightpct_1` | `light_damage_percent` | Crackling | Трескучий | 9 | 28 | `Wc` `J*` | `lightDamagePercent 10–20` | 54 |
| `pfx_lightpct_2` | `light_damage_percent` | Tempestuous | Грозовой | 21 | 99 | `Wc` `J*` | `lightDamagePercent 21–38` | 30 |
| `pfx_str_1` | `attr_strength` | Iron | Железный | 2 | 20 | `Ab` `Ah` `Ag` `Al` `As` `J*` | `strength 2–5` | 80 |
| `pfx_str_2` | `attr_strength` | Bull's | Бычий | 12 | 30 | `Ab` `Ah` `Ag` `Al` `As` `J*` | `strength 6–12` | 56 |
| `pfx_str_3` | `attr_strength` | Titan's | Титанов | 23 | 99 | `Ab` `Ah` `Ag` `Al` `As` `J*` | `strength 13–22` | 32 |
| `pfx_dex_1` | `attr_dexterity` | Nimble | Ловкий | 2 | 20 | `Ah` `Ag` `At` `As` `J*` | `dexterity 2–5` | 80 |
| `pfx_dex_2` | `attr_dexterity` | Fox's | Лисий | 12 | 30 | `Ah` `Ag` `At` `As` `J*` | `dexterity 6–12` | 56 |
| `pfx_dex_3` | `attr_dexterity` | Serpent's | Змеиный | 23 | 99 | `Ah` `Ag` `At` `As` `J*` | `dexterity 13–22` | 32 |
| `pfx_vit_1` | `attr_vitality` | Ruddy | Румяный | 2 | 20 | `Ab` `Al` `At` `J*` | `vitality 2–5` | 80 |
| `pfx_vit_2` | `attr_vitality` | Sanguine | Сангвинический | 12 | 30 | `Ab` `Al` `At` `J*` | `vitality 6–12` | 56 |
| `pfx_vit_3` | `attr_vitality` | Deathless | Бессмертный | 23 | 99 | `Ab` `Al` `At` `J*` | `vitality 13–22` | 32 |
| `pfx_ene_1` | `attr_energy` | Clever | Смышлёный | 2 | 20 | `Ab` `Ah` `Wc` `J*` | `energy 2–5` | 80 |
| `pfx_ene_2` | `attr_energy` | Scholar's | Учёный | 12 | 30 | `Ab` `Ah` `Wc` `J*` | `energy 6–12` | 56 |
| `pfx_ene_3` | `attr_energy` | Oracle's | Оракулов | 23 | 99 | `Ab` `Ah` `Wc` `J*` | `energy 13–22` | 32 |
| `pfx_tree_1` | `skills_tree` | Adept's | Умелый | 16 | 99 | `Ah` `Ja` `W*` | `skillBonuses.tree +1` | 14 |
| `pfx_tree_2` | `skills_tree` | Master's | Мастеров | 27 | 99 | `Ah` `Ja` `W*` | `skillBonuses.tree +2` | 6 |
| `pfx_allskills_1` | `skills_all` | Instructor's | Наставников | 29 | 99 | `Ja` `ST` | `skillBonuses.all +1` | 3 |
| `pfx_thorns_1` | `thorns` | Spiked | Шипастый | 5 | 24 | `As` `Ab` | `thorns 3–8` | 46 |
| `pfx_thorns_2` | `thorns` | Barbed | Колючий | 19 | 99 | `As` `Ab` | `thorns 12–30` | 26 |
| `pfx_dr_flat_1` | `damage_reduce_flat` | Warded | Огражденный | 10 | 28 | `As` `Al` `Ab` | `damageReduceFlat 1–2` | 40 |
| `pfx_dr_flat_2` | `damage_reduce_flat` | Bulwark | Бастионный | 24 | 99 | `As` `Al` `Ab` | `damageReduceFlat 3–6` | 22 |
| `pfx_block_1` | `block_chance` | Deflecting | Отражающий | 7 | 26 | `As` | `blockChance 4–8` | 50 |
| `pfx_block_2` | `block_chance` | Interposing | Заслоняющий | 20 | 99 | `As` | `blockChance 9–16` | 28 |

`skillBonuses.tree` and `skillBonuses.all` are the structured record of
`01-data-model.md` §3.5. A `skills_tree` prefix rolls **no numeric value** — its
`mods[0]` is `{ stat: 'skillBonuses.tree', min: 1, max: 1 }` for tier 1 and
`{ min: 2, max: 2 }` for tier 2 — and the tree it names is chosen by the
**base's own class affinity**, resolved at roll time from a fixed table so the
draw stays deterministic:

| Base group | Tree granted |
|---|---|
| axes, maces, mauls, shields, `armour.body` with `reqStr ≥ 38` | `carnage` on even `ilvl`, `unyielding` on odd |
| wands, staves, `helm_diadem_exceptional`, `armour_robe/shroud/litany` | `flame` on even `ilvl`, `ash` on odd |
| swords, daggers, polearms | `enchanted_blade` on even `ilvl`, `conduit` on odd |
| helms, gloves, boots, belts, rings, amulets not covered above | one of the six, index `ilvl mod 6` in the `01-data-model.md` §6.1 tree order |

Using `ilvl mod n` rather than an RNG draw keeps the affix-value step to exactly
one draw per mod and keeps the RNG order in `ARCHITECTURE.md` intact.

### 2.4 Suffixes — 56

| id | Group | EN | RU | alvl | max | Applies | Mods | W |
|---|---|---|---|---:|---:|---|---|---:|
| `sfx_attack_rating_1` | `attack_rating` | of Skill | Умения | 1 | 20 | `W*` `Ag` `J*` | `attackRating 5–11` | 100 |
| `sfx_attack_rating_2` | `attack_rating` | of Accuracy | Меткости | 9 | 30 | `W*` `Ag` `J*` | `attackRating 12–30` | 74 |
| `sfx_attack_rating_3` | `attack_rating` | of Precision | Точности | 22 | 99 | `W*` `Ag` `J*` | `attackRating 31–90` | 40 |
| `sfx_ias_1` | `ias` | of Readiness | Готовности | 5 | 26 | `W*` `Ag` | `increasedAttackSpeed 6–13` | 66 |
| `sfx_ias_2` | `ias` | of Alacrity | Стремительности | 20 | 99 | `W*` `Ag` | `increasedAttackSpeed 14–30` | 34 |
| `sfx_fcr_1` | `fcr` | of Recitation | Чтения | 5 | 26 | `Wc` `Ag` `Ah` `J*` | `fasterCastRate 6–13` | 66 |
| `sfx_fcr_2` | `fcr` | of the Litany | Литании | 20 | 99 | `Wc` `Ag` `Ah` `J*` | `fasterCastRate 14–30` | 34 |
| `sfx_fhr_1` | `fhr` | of Balance | Равновесия | 4 | 26 | `Ab` `Al` `At` `As` `Ah` | `fasterHitRecovery 8–18` | 62 |
| `sfx_fhr_2` | `fhr` | of Stability | Устойчивости | 18 | 99 | `Ab` `Al` `At` `As` `Ah` | `fasterHitRecovery 19–36` | 34 |
| `sfx_res_fire_1` | `resist_fire` | of Warmth | Тепла | 3 | 22 | `A*` `J*` | `fireResist 5–12` | 86 |
| `sfx_res_fire_2` | `resist_fire` | of Cinders | Углей | 13 | 32 | `A*` `J*` | `fireResist 13–24` | 60 |
| `sfx_res_fire_3` | `resist_fire` | of the Pyre | Костра | 24 | 99 | `A*` `J*` | `fireResist 25–40` | 34 |
| `sfx_res_cold_1` | `resist_cold` | of Comfort | Уюта | 3 | 22 | `A*` `J*` | `coldResist 5–12` | 86 |
| `sfx_res_cold_2` | `resist_cold` | of Frost | Мороза | 13 | 32 | `A*` `J*` | `coldResist 13–24` | 60 |
| `sfx_res_cold_3` | `resist_cold` | of the Rime | Инея | 24 | 99 | `A*` `J*` | `coldResist 25–40` | 34 |
| `sfx_res_light_1` | `resist_lightning` | of Grounding | Заземления | 3 | 22 | `A*` `J*` | `lightResist 5–12` | 86 |
| `sfx_res_light_2` | `resist_lightning` | of Insulation | Изоляции | 13 | 32 | `A*` `J*` | `lightResist 13–24` | 60 |
| `sfx_res_light_3` | `resist_lightning` | of the Storm | Бури | 24 | 99 | `A*` `J*` | `lightResist 25–40` | 34 |
| `sfx_res_poison_1` | `resist_poison` | of the Antidote | Противоядия | 10 | 99 | `A*` `J*` | `poisonResist 8–25` | 40 |
| `sfx_res_all_1` | `resist_all` | of Warding | Оберега | 12 | 30 | `Ab` `As` `Ja` | `fireResist`, `coldResist`, `lightResist`, `poisonResist`, `magicResist`, `physicalResist` — all `4–9`, **`sharedRoll`** | 26 |
| `sfx_res_all_2` | `resist_all` | of Renunciation | Отречения | 26 | 99 | `Ab` `As` `Ja` | the same six, `10–20`, **`sharedRoll`** | 10 |
| `sfx_life_steal_1` | `life_steal` | of the Leech | Пиявки | 10 | 30 | `Wm` `Jr` `Ja` | `lifeSteal 2–5` | 44 |
| `sfx_life_steal_2` | `life_steal` | of the Feast | Пира | 24 | 99 | `Wm` `Jr` `Ja` | `lifeSteal 6–10` | 20 |
| `sfx_mana_steal_1` | `mana_steal` | of the Draught | Испития | 12 | 99 | `Wm` `Jr` | `manaSteal 2–6` | 30 |
| `sfx_life_on_hit_1` | `life_on_hit` | of Mending | Штопки | 8 | 99 | `Wm` `Ag` `Ja` | `lifeOnHit 1–6` | 40 |
| `sfx_mana_on_hit_1` | `mana_on_hit` | of Trickle | Струйки | 8 | 99 | `Wm` `Ag` `Ja` | `manaOnHit 1–4` | 36 |
| `sfx_life_regen_1` | `life_regen` | of Renewal | Обновления | 6 | 99 | `Ab` `Al` `J*` | `lifeRegen 0.4–2.6` | 44 |
| `sfx_mana_regen_1` | `mana_regen` | of Meditation | Медитации | 6 | 99 | `Ah` `Wc` `J*` | `manaRegenPercent 3–12` | 44 |
| `sfx_crit_1` | `crit_chance` | of Malice | Злобы | 8 | 28 | `W*` `Ag` `Ja` | `critChance 2–5` | 40 |
| `sfx_crit_2` | `crit_chance` | of Execution | Казни | 25 | 99 | `W*` `Ag` `Ja` | `critChance 6–12` | 16 |
| `sfx_crit_mult_1` | `crit_mult` | of the Deathblow | Смертельного удара | 22 | 99 | `W*` `Ja` | `critMult 25–60` | 14 |
| `sfx_move_1` | `movement_speed` | of Pacing | Ходьбы | 7 | 28 | `At` | `movementSpeed 8–16` | 70 |
| `sfx_move_2` | `movement_speed` | of the Long Road | Долгой дороги | 24 | 99 | `At` | `movementSpeed 17–30` | 32 |
| `sfx_mf_1` | `magic_find` | of Luck | Удачи | 6 | 28 | `Ah` `Ag` `At` `J*` | `magicFind 5–14` | 40 |
| `sfx_mf_2` | `magic_find` | of the Hoard | Клада | 24 | 99 | `Ah` `Ag` `At` `J*` | `magicFind 15–38` | 14 |
| `sfx_gf_1` | `gold_find` | of Greed | Жадности | 2 | 99 | `Ah` `Ag` `At` `Al` `Jr` | `goldFind 12–60` | 56 |
| `sfx_mana_cost_1` | `mana_cost` | of Economy | Бережливости | 14 | 99 | `Ah` `Ja` `Jr` `ST` | `manaCostReduction 4–14` | 26 |
| `sfx_cc_1` | `cc_reduction` | of Footing | Опоры | 14 | 99 | `At` `Al` `Ah` | `ccReduction 8–26` | 30 |
| `sfx_dr_pct_1` | `dr_percent` | of Absorption | Поглощения | 22 | 99 | `As` `Ab` `Al` | `damageReducePercent 3–7` | 18 |
| `sfx_dodge_1` | `dodge_chance` | of Evasion | Уклонения | 11 | 99 | `At` `Ag` `As` | `dodgeChance 3–10` | 28 |
| `sfx_mana_return_1` | `mana_return` | of Circuit | Контура | 9 | 99 | `Wm` `Jr` `Ja` | `manaReturnPercent 2–9` | 26 |
| `sfx_rage_1` | `rage_gain` | of Temper | Норова | 9 | 99 | `Wm` `Al` `Ja` | `rageOnHit 1–4` | 26 |
| `sfx_resonance_1` | `resonance_gain` | of the Chord | Аккорда | 13 | 99 | `Wm` `Jr` `Ja` | `resonanceOnHit 0.2–0.8` step `0.1` | 22 |
| `sfx_unfreezing_1` | `freeze_immune` | of the Thaw | Оттепели | 22 | 99 | `At` `Ab` `Ja` | `cannotBeFrozen 1` | 12 |
| `sfx_dttm_1` | `dttm` | of the Conduit | Проводника | 18 | 99 | `Ah` `Ab` `Ja` | `damageTakenToMana 5–12` | 18 |
| `sfx_poison_dur_1` | `poison_duration` | of Lingering | Затяжной | 16 | 99 | `Wm` `Ja` | `poisonDuration 1–3` | 14 |
| `sfx_cold_dur_1` | `cold_duration` | of the Long Winter | Долгой зимы | 16 | 99 | `Wm` `Ja` | `coldDuration 1–3` | 14 |
| `sfx_knockback_1` | `knockback` | of Repulsion | Отталкивания | 7 | 99 | `W*` `Ag` | `knockbackChance 25–50` | 20 |
| `sfx_light_rad_1` | `light_radius` | of Lantern-Light | Фонаря | 3 | 99 | `Ah` `J*` | `lightRadius 1–3` | 30 |
| `sfx_req_1` | `req_reduction` | of Ease | Лёгкости | 10 | 99 | `Ag` `Al` `Jr` | `requirementReduction 8–18` | 22 |
| `sfx_xp_1` | `experience` | of Tutelage | Обучения | 24 | 99 | `Ah` `Ja` | `experienceGain 3–7` | 8 |
| `sfx_max_res_fire_1` | `max_resist` | of the Ember Seal | Тлеющей печати | 29 | 99 | `Ja` `As` | `maxFireResist 2–5` | 4 |
| `sfx_pierce_1` | `pierce` | of Piercing | Пронзания | 15 | 99 | `Wc` `Ja` | `pierceChance 10–22` | 18 |
| `sfx_fire_pierce_1` | `elem_pierce` | of the Breach | Пролома | 23 | 99 | `Wc` `Ja` | `fireResistPierce 8–16` | 10 |
| `sfx_magic_dr_1` | `magic_dr` | of Nullity | Небытия | 20 | 99 | `Ah` `As` `Ja` | `magicDamageReduceFlat 1–3` | 14 |
| `sfx_fhr_stone_1` | `fhr_stone` | of the Stone | Камня | 26 | 99 | `Ab` `As` | `fasterHitRecovery 12–24`, `defensePercent 10–20` | 12 |

`sharedRoll` is a new optional boolean on `AffixDefinition` (§13). When it is
true the value step draws **once** for the whole affix and writes the same
number into every entry of `values`. It exists so that `sfx_res_all_*` produces
six identical resistances, which is the precondition for `09-ui.md` §5.3's
"collapse into `All Resistances +{v} %`" rule to fire. Without it the six
independent draws would print six lines and the merge would never happen.

`sfx_resonance_1` is the only affix with a non-integer `step`. `01-data-model.md`
§3.3 caps `resonanceOnHit` at 4 and `03-combat-math.md` §2.4 already treats it
as fractional and floored on read, so `0.2 … 0.8` is inside the model.

### 2.5 Magic-item naming — the composition rule

```
displayName(magic item) =
    [prefix.name + ' ']  +  base.name  +  [' ' + suffix.name]
```

- A magic item always has **at least one** affix (`01-data-model.md` §1.6), so
  at least one of the two brackets is present.
- Prefixes are prepended verbatim: `Keen` + `Battle Axe` → **Keen Battle Axe**.
- Suffixes are noun phrases already carrying `of the`:
  `Battle Axe` + `of Accuracy` → **Battle Axe of Accuracy**.
- Both: **Keen Battle Axe of Accuracy**.
- `superior` and `normal` items use `base.name` alone. `unique` items use
  `UniqueDefinition.name` alone. `rare` items use `nameOverride` (§3).

**Russian composition.** Russian adjectives agree with the noun's gender and
number, so `ItemBase` carries a `genderRu` field (`'m' | 'f' | 'n' | 'pl'`) and
the affix dictionary value is the **masculine nominative**. `ui` derives the
other three forms:

```
-ый → -ая / -ое / -ые          Едкий → Едкая / Едкое / Едкие
-ий → -яя / -ее / -ие          (soft stem)
-ой → -ая / -ое / -ые
```

Eight prefixes are not regular adjectives and store all four forms explicitly,
pipe-separated, in `affix.<id>`:

| id | m | f | n | pl |
|---|---|---|---|---|
| `pfx_str_2` | Бычий | Бычья | Бычье | Бычьи |
| `pfx_dex_2` | Лисий | Лисья | Лисье | Лисьи |
| `pfx_str_3` | Титанов | Титанова | Титаново | Титановы |
| `pfx_ene_3` | Оракулов | Оракулова | Оракулово | Оракуловы |
| `pfx_tree_2` | Мастеров | Мастерова | Мастерово | Мастеровы |
| `pfx_allskills_1` | Наставников | Наставникова | Наставниково | Наставниковы |
| `pfx_flat_fire_3` | Рождённый костром | Рождённая костром | Рождённое костром | Рождённые костром |
| `pfx_flat_light_3` | Клятый бурей | Клятая бурей | Клятое бурей | Клятые бурей |

Russian suffixes are genitive noun phrases and never inflect:
`Боевой топор` + `Меткости` → **Боевой топор Меткости**.

`genderRu` per base group: weapons ending `-топор / -меч / -молот / -жезл /
-посох / -клинок / -крис / -осколок / -скальпель / -щит / -баклер / -барбют /
-койф / -хауберк / -доспех / -покров / -кафтан / -кушак / -пояс / -обруч /
-амулет / -приговор` are `m`; `-булава / -глефа / -наковальня / -тарча / -роба /
-диадема / -маска` are `f`; `-кадило / -слово / -облачение / -кольцо` are `n`;
`Обмотки / Наручи / Рукавицы / Сапоги / Поножи / Сабатоны` are `pl`.

---

## 3. Rare item naming

A rare's name is generated once, at drop time, and stored in
`ItemInstance.nameOverride`. It is never regenerated — the same item shows the
same name after a save/load, which is what makes "the Doom Bane I found in
Bonereach" a thing a player can say.

### 3.1 The composition rule

```
nameOverride = A[i] + ' ' + B[j]                            when affixCount ≤ 4
             = A[i] + ' ' + B[j] + ' ' + C[k]               when affixCount ≥ 5
```

- `A` is drawn from the 44-word **head pool**, `B` from the 48-word **tail
  pool**, `C` from the 20-phrase **epithet pool**.
- Three RNG draws maximum, taken at step **D14** of §9, after every affix value
  so that `affixCount` is already known.
- The base type is *not* part of the name; `09-ui.md` §5.1 block 2 prints it on
  its own line underneath.
- Russian uses the same structure with the Russian columns and no agreement —
  every word in all three pools is a nominative or genitive noun, so
  `Рок Погибели` and `Пепел Клыка Легиона` need no inflection machinery.
- An unidentified rare shows the **base name**, never `nameOverride`
  (`09-ui.md` §5.5).

### 3.2 Pool A — head, 44 words

| # | EN | RU | # | EN | RU |
|---:|---|---|---:|---|---|
| 1 | Doom | Рок | 23 | Loath | Мерзость |
| 2 | Grim | Мрак | 24 | Pain | Боль |
| 3 | Vile | Скверна | 25 | Spirit | Дух |
| 4 | Ash | Пепел | 26 | Corpse | Труп |
| 5 | Bone | Кость | 27 | Brimstone | Сера |
| 6 | Ember | Уголь | 28 | Onslaught | Натиск |
| 7 | Dread | Ужас | 29 | Chant | Напев |
| 8 | Hollow | Пустота | 30 | Wound | Рана |
| 9 | Cinder | Зола | 31 | Shadow | Тень |
| 10 | Rune | Руна | 32 | Void | Бездна |
| 11 | Wraith | Призрак | 33 | Grave | Могила |
| 12 | Storm | Гроза | 34 | Frost | Стужа |
| 13 | Blight | Порча | 35 | Fury | Ярость |
| 14 | Iron | Железо | 36 | Sorrow | Скорбь |
| 15 | Havoc | Разор | 37 | Beast | Зверь |
| 16 | Soul | Душа | 38 | Viper | Гадюка |
| 17 | Gloom | Хмарь | 39 | Thunder | Гром |
| 18 | Rot | Гниль | 40 | Woe | Горе |
| 19 | Bitter | Горечь | 41 | Cruel | Лютость |
| 20 | Death | Смерть | 42 | Ruin | Разруха |
| 21 | Ghoul | Упырь | 43 | Silence | Безмолвие |
| 22 | Skull | Череп | 44 | Word | Слово |

### 3.3 Pool B — tail, 48 words

| # | EN | RU | # | EN | RU |
|---:|---|---|---:|---|---|
| 1 | Bane | Погибель | 25 | Hymn | Гимн |
| 2 | Song | Песнь | 26 | Sigil | Печать |
| 3 | Bite | Укус | 27 | Knell | Набат |
| 4 | Edge | Кромка | 28 | Husk | Скорлупа |
| 5 | Whisper | Шёпот | 29 | Root | Корень |
| 6 | Sunder | Раскол | 30 | Thorn | Шип |
| 7 | Gaze | Взор | 31 | Shard | Осколок |
| 8 | Weaver | Ткач | 32 | Chain | Цепь |
| 9 | Reaper | Жнец | 33 | Wing | Крыло |
| 10 | Scourge | Бич | 34 | Maw | Пасть |
| 11 | Bark | Лай | 35 | Cry | Крик |
| 12 | Grasp | Хватка | 36 | Vigil | Бдение |
| 13 | Wrath | Гнев | 37 | Lesson | Урок |
| 14 | Ward | Оберег | 38 | Cipher | Шифр |
| 15 | Shroud | Покров | 39 | Ledger | Реестр |
| 16 | Fang | Клык | 40 | Tally | Счёт |
| 17 | Talon | Коготь | 41 | Gate | Врата |
| 18 | Mark | Метка | 42 | Pyre | Костёр |
| 19 | Vow | Обет | 43 | Anthem | Клич |
| 20 | Coil | Виток | 44 | Rebuke | Укор |
| 21 | Brand | Клеймо | 45 | Errand | Поручение |
| 22 | Prayer | Молитва | 46 | Vessel | Сосуд |
| 23 | Tongue | Язык | 47 | Sermon | Проповедь |
| 24 | Verse | Строфа | 48 | Tremor | Дрожь |

### 3.4 Pool C — epithet, 20 phrases (only when `affixCount ≥ 5`)

| # | EN | RU | # | EN | RU |
|---:|---|---|---:|---|---|
| 1 | of the Legion | Легиона | 11 | of the Dead | Мёртвых |
| 2 | of the Choir | Хора | 12 | of the Long Night | Долгой ночи |
| 3 | of the Ash | Пепла | 13 | of the Broken | Сломленных |
| 4 | of the Bastion | Оплота | 14 | of the Warden | Стража |
| 5 | of the First | Первого | 15 | of the Ninth | Девятого |
| 6 | of the Wastes | Пустошей | 16 | of the Kiln | Печи |
| 7 | of the Deep | Глубин | 17 | of the Hollow | Полых |
| 8 | of the Cinder | Золы | 18 | of the Faithless | Безверных |
| 9 | of the Instructor | Наставника | 19 | of the Unmade | Несотворённых |
| 10 | of the Silent | Безмолвных | 20 | of the Last Word | Последнего слова |

### 3.5 Does it repeat?

`44 × 48 = 2 112` two-word names. At `ilvl 20` the affix-count model of §9.6
gives `P(affixCount ≥ 5) = 0.2912`, so about 29 % of rares also draw an
epithet, expanding those to `2 112 × 20 = 42 240`.

The effective distinct-name count is `1 / Σ pᵢ²`:

```
Σ pᵢ² = 2112 × (0.7088 / 2112)²  +  42240 × (0.2912 / 42240)²
      = 2.3799e-4 + 2.0072e-6
      = 2.4000e-4                    →  effective space  4 167
```

Birthday probability of at least one visible repeat after `n` rares:

| n rares seen | P(a repeat) |
|---:|---:|
| 10 | 1.07 % |
| 20 | 4.46 % |
| 40 | 17.1 % |
| 70 | 47.4 % |
| 100 | 69.4 % |

A single zone clear at level 15 produces **1.6** rares (§7.7), so a two-hour
session is 20–40 rares and a repeat is unlikely. Past 70 rares a repeat becomes
likely, which is the correct place for the illusion to break — by then the
player is comparing rolls, not names.

---

## 4. The quality roll

### 4.1 The algorithm

Exactly **one** RNG draw, compared against a cumulative ladder built
top-down. One draw keeps `tools/lootsim.mjs` cheap and keeps the
`ARCHITECTURE.md` order (`base → quality → …`) literally true.

```
rollQuality(ilvl, mlvl, rank, difficulty, magicFind) →

  Δ = clamp(ilvl − mlvl, 0, 8)

  for r in ['unique', 'rare', 'magic', 'superior']:
      p[r] = BASE[r]
           × RANK[rank][r]
           × (1 + DELTA_COEFF[r] × Δ)
           × TIER[difficulty][r]
           × (1 + effMF(r, magicFind) / 100)
      p[r] = clamp(p[r], 0, CAP[r])

  u = U(0, 1)                       // the single draw, from the items stream
  t = 0
  t += p.unique   ; if u < t: return 'unique'
  t += p.rare     ; if u < t: return 'rare'
  t += p.magic    ; if u < t: return 'magic'
  t += p.superior ; if u < t: return 'superior'
  return 'normal'
```

The ladder **truncates**: once the running total reaches 1.0 the lower rarities
become unreachable. That is why a boss on Trial with Magic Find never drops a
normal item (§4.5c), and it is intended.

### 4.2 The tables

**Base probabilities** — a normal-rank monster, Instruction, Magic Find 0:

| Rarity | `BASE` | As a percent |
|---|---:|---:|
| `unique` | 0.0025 | 0.25 % |
| `rare` | 0.0180 | 1.80 % |
| `magic` | 0.1600 | 16.00 % |
| `superior` | 0.2000 | 20.00 % |
| `normal` | remainder | **61.95 %** |

**Rank multipliers** and the Δ each rank carries (`03-combat-math.md` §9.3 fixes
`ilvl = mlvl + rankBonus`, so Δ is not a free parameter):

| Rank | Δ | `RANK.unique` | `.rare` | `.magic` | `.superior` |
|---|---:|---:|---:|---:|---:|
| `normal` | 0 | 1.00 | 1.00 | 1.00 | 1.00 |
| `minion` | 0 | 1.30 | 1.25 | 1.15 | 1.00 |
| `champion` | 2 | 2.50 | 2.20 | 1.60 | 1.15 |
| `unique` | 3 | 4.60 | 3.60 | 2.25 | 1.25 |
| `boss` | 3 | 9.20 | 6.40 | 2.60 | 1.00 |
| chest / sarcophagus | 2 | 1.60 | 1.55 | 1.35 | 1.10 |
| urn / barrel / crate | 0 | 1.00 | 1.00 | 1.00 | 1.00 |

**Δ coefficients** — how much an item level above the killer's level is worth:

| Rarity | `DELTA_COEFF` |
|---|---:|
| `unique` | 0.10 |
| `rare` | 0.08 |
| `magic` | 0.05 |
| `superior` | 0.02 |

**Difficulty multipliers** — on top of the `mlvl` offset that
`03-combat-math.md` §10.2 already applies:

| Tier | `TIER.unique` | `.rare` | `.magic` | `.superior` |
|---|---:|---:|---:|---:|
| Instruction | 1.00 | 1.00 | 1.00 | 1.00 |
| Trial | 1.35 | 1.30 | 1.15 | 1.00 |
| Renunciation | 1.80 | 1.65 | 1.30 | 1.00 |

**Caps**, applied per rarity before the ladder is built:

| Rarity | `CAP` |
|---|---:|
| `unique` | 0.25 |
| `rare` | 0.50 |
| `magic` | 0.95 |
| `superior` | 0.60 |

The `unique` cap of 25 % is what keeps a unique a thrill at any Magic Find. It
is only ever reached by the boss on Renunciation with more than 900 % MF, which
no legal gear set can produce (the `magicFind` stat caps at 1000 and the whole
catalogue's maximum is 38 + 38 + 38 + 14 + 14 + 30 unique = 172 %).

### 4.3 Magic Find and its diminishing returns

Magic Find is **not** linear on the rare and unique tiers. The curve is the D2
hyperbola, which has the property that the first 100 points are worth nearly
their face value and the thousandth is worth almost nothing:

```
effMF(unique,   MF) = MF × 250 / (MF + 250)
effMF(rare,     MF) = MF × 550 / (MF + 550)
effMF(magic,    MF) = MF                       // no diminishing returns
effMF(superior, MF) = 0                        // MF does not touch superior
```

| `magicFind` | effMF unique | ×unique | effMF rare | ×rare | ×magic |
|---:|---:|---:|---:|---:|---:|
| 0 | 0.00 | 1.000 | 0.00 | 1.000 | 1.00 |
| 25 | 22.73 | 1.227 | 23.91 | 1.239 | 1.25 |
| 50 | 41.67 | 1.417 | 45.83 | 1.458 | 1.50 |
| 75 | 57.69 | 1.577 | 66.00 | 1.660 | 1.75 |
| 100 | 71.43 | 1.714 | 84.62 | 1.846 | 2.00 |
| 150 | 93.75 | 1.938 | 117.86 | 2.179 | 2.50 |
| 200 | 111.11 | 2.111 | 146.67 | 2.467 | 3.00 |
| 300 | 136.36 | 2.364 | 194.12 | 2.941 | 4.00 |
| 500 | 166.67 | 2.667 | 261.90 | 3.619 | 6.00 |

The design consequence, stated plainly: **the first 100 MF nearly doubles rare
and unique output; the next 400 adds barely as much again.** A player who
sacrifices two gear slots to Magic Find is rewarded; one who sacrifices six is
not, and that is the point of the curve.

`superior` is deliberately untouched by MF. Superior is a *base-quality* roll,
not a magic one, and letting MF push it would eat the normal share and make the
low end of the loot stream feel identical at every MF value.

### 4.4 Degradation

The base is rolled before the quality (`ARCHITECTURE.md`). When a rolled quality
cannot be expressed on the rolled base, it degrades one step and the roll is
**not** repeated:

| Situation | Result |
|---|---|
| `unique`, and §6's table has no entry with `alvl ≤ ilvl` | → `rare` |
| `unique`, and at least one entry qualifies | the base is **substituted** for the unique's own `baseId` (§9, draw D6) |
| `rare` on a base whose legal affix pool holds fewer than 2 entries | → `magic` |
| `magic` on a base whose legal affix pool is empty | → `superior` |
| `superior` on a base with neither weapon damage nor armour defence (jewelry, quest) | → `normal` |

Jewelry can therefore never be superior, which is correct — there is nothing on
a ring for `+5..15 %` to apply to.

### 4.5 The three required distributions

**(a) Level 5, normal monster, Instruction, Magic Find 0.**
`ilvl 5`, `mlvl 5`, Δ = 0, every multiplier 1.0.

| Rarity | `p` | Percent |
|---|---:|---:|
| unique | 0.002500 | **0.250 %** |
| rare | 0.018000 | **1.800 %** |
| magic | 0.160000 | **16.000 %** |
| superior | 0.200000 | **20.000 %** |
| normal | 0.619500 | **61.950 %** |

One rare in 55.6 items; one unique in 400. At the level-5 drop rate of §7.7
(13.7 items per Wastes clear) that is a rare every 4.1 runs.

**(b) Level 20 champion, Instruction, Magic Find 50.**
`mlvl 20`, `ilvl 22`, Δ = 2, `RANK.champion`, MF 50.

```
p.unique   = 0.0025 × 2.50 × (1 + 0.10×2) × 1.00 × 1.4167 = 0.010625
p.rare     = 0.0180 × 2.20 × (1 + 0.08×2) × 1.00 × 1.4583 = 0.066976
p.magic    = 0.1600 × 1.60 × (1 + 0.05×2) × 1.00 × 1.5000 = 0.422400
p.superior = 0.2000 × 1.15 × (1 + 0.02×2) × 1.00 × 1.0000 = 0.239200
```

| Rarity | `p` | Percent |
|---|---:|---:|
| unique | 0.010625 | **1.063 %** |
| rare | 0.066976 | **6.698 %** |
| magic | 0.422400 | **42.240 %** |
| superior | 0.239200 | **23.920 %** |
| normal | 0.260799 | **26.080 %** |

A champion is a **26× better** unique source than a normal monster of the same
level, and it drops on two picks instead of one (§5.3). That is the entire
reason a player who sees a blue aura walks towards it.

**(c) Molgrim on Trial, Magic Find 75.**
`mlvl 27`, `ilvl 30`, Δ = 3, `RANK.boss`, `TIER.trial`, MF 75.

```
p.unique   = 0.0025 × 9.20 × 1.30 × 1.35 × 1.5769 = 0.063651
p.rare     = 0.0180 × 6.40 × 1.24 × 1.30 × 1.6600 = 0.308256
p.magic    = 0.1600 × 2.60 × 1.15 × 1.15 × 1.7500 = 0.962780  → truncated
p.superior = 0.2000 × 1.00 × 1.06 × 1.00 × 1.0000 = 0.212000  → unreachable
```

| Rarity | Effective | Percent |
|---|---:|---:|
| unique | 0.063651 | **6.365 %** |
| rare | 0.308256 | **30.826 %** |
| magic | 0.628093 | **62.809 %** |
| superior | 0.000000 | **0 %** |
| normal | 0.000000 | **0 %** |

Every item the boss drops on Trial is magic or better. Across its four
non-guaranteed picks the chance of at least one unique is
`1 − 0.936349⁴ = 23.1 %`, and the guaranteed `rare`-floor pick (§5.5) means the
fight always pays. Plus: the **first** Molgrim kill on each difficulty drops a
guaranteed unique, so the three tiers hand out three uniques no matter how the
dice fall.

---

## 5. Treasure classes

### 5.1 The record and the resolution rule

```js
/** src/items/data/treasure.js */
const TreasureClass = {
  id:      'tc_humanoid_2',
  entries: [                       // weights sum to 1000 in every shipped row
    { kind: 'nodrop',  weight: 620 },
    { kind: 'gold',    weight: 230 },
    { kind: 'item',    weight: 105 },   // rolls a base group, then a base
    { kind: 'potion',  weight:  38, sub: 'tc_potion_2' },
    { kind: 'scroll',  weight:   7, sub: 'tc_scroll'   },
  ],
};
```

Every entry also carries an optional **`rarityFloor`**, `null | 'magic' |
'rare'`, defaulting to `null`. When set, `applyFloor` raises a quality roll that
came in below it (§5.5 step 4). Three shipped mechanics need it and none can be
expressed without it: the unique-rank monster's guaranteed magic-or-better drop,
the boss's guaranteed rare, and `tc_urn`'s "6 % of urns hold a magic base". It
is a field on the entry, not on the class, because the same class can hold one
floored entry and several unfloored ones. Static table only — never serialised.

A `treasureClass` id **without** a trailing band digit is a *family*.
`items.resolveTC(family, mlvl)` appends the band:

| Band | `mlvl` |
|---:|---|
| 1 | 1–9 |
| 2 | 10–19 |
| 3 | 20–29 |
| 4 | 30–40 |

So `bone_ranker` in Renunciation Bonereach (`mlvl 33`) resolves
`tc_humanoid` → `tc_humanoid_4`. Families with no band suffix in the tables
below (`tc_boss`, `tc_urn`, `tc_wastes`, `tc_bonereach`, `tc_altar`,
`tc_scroll`) are single classes and resolve to themselves.

### 5.2 Bestiary assignment

`MonsterArchetype.treasureClass`, one per row of `03-combat-math.md` §9.1:

| Archetype | Family | Rationale |
|---|---|---|
| `bone_ranker` | `tc_humanoid` | the baseline; every other rate is quoted against it |
| `ashen_archer` | `tc_humanoid` | same tier of threat, same reward |
| `carrion_swarm` | `tc_swarm` | 6–10 per pack — a normal rate here would flood the floor |
| `blight_crawler` | `tc_swarm` | dies to its own detonation; cheap kill, cheap drop |
| `dust_shaman` | `tc_caster` | the priority target; paying for that priority is the design |
| `maulsmith` | `tc_heavy` | slowest kill in the bestiary outside a champion |
| `molgrim` | `tc_boss` | §5.5 |

### 5.3 The monster tables — `mlvl` band × role

All weights sum to **1000**. `nodrop` is the "this kill dropped nothing" weight
and it is the single most important number in the loot model: it is what makes
the floor readable.

**`tc_humanoid` — Bone Ranker, Ashen Archer**

| Band | mlvl | nodrop | gold | item | potion | scroll |
|---|---|---:|---:|---:|---:|---:|
| 1 | 1–9 | 660 | 225 | 80 | 32 | 3 |
| 2 | 10–19 | 620 | 230 | 105 | 38 | 7 |
| 3 | 20–29 | 585 | 232 | 130 | 43 | 10 |
| 4 | 30–40 | 555 | 233 | 152 | 47 | 13 |

**`tc_swarm` — Carrion Swarm, Blight Crawler**

| Band | mlvl | nodrop | gold | item | potion | scroll |
|---|---|---:|---:|---:|---:|---:|
| 1 | 1–9 | 830 | 128 | 32 | 9 | 1 |
| 2 | 10–19 | 805 | 137 | 43 | 12 | 3 |
| 3 | 20–29 | 782 | 145 | 54 | 15 | 4 |
| 4 | 30–40 | 762 | 152 | 64 | 17 | 5 |

**`tc_caster` — Dust Shaman**

| Band | mlvl | nodrop | gold | item | potion | scroll |
|---|---|---:|---:|---:|---:|---:|
| 1 | 1–9 | 600 | 210 | 118 | 52 | 20 |
| 2 | 10–19 | 560 | 212 | 148 | 55 | 25 |
| 3 | 20–29 | 525 | 214 | 176 | 57 | 28 |
| 4 | 30–40 | 495 | 215 | 202 | 58 | 30 |

**`tc_heavy` — Maulsmith**

| Band | mlvl | nodrop | gold | item | potion | scroll |
|---|---|---:|---:|---:|---:|---:|
| 1 | 1–9 | 520 | 265 | 165 | 45 | 5 |
| 2 | 10–19 | 480 | 268 | 197 | 47 | 8 |
| 3 | 20–29 | 445 | 270 | 226 | 48 | 11 |
| 4 | 30–40 | 415 | 271 | 251 | 49 | 14 |

The Dust Shaman is the game's scroll faucet — it is the only common monster
that reliably pays for identification, and it is the monster the player is
already told to kill first (`03-combat-math.md` §9.1, "priority target marker").
The two lines of design agree on purpose.

### 5.4 Rank modifiers — picks and the `nodrop` scale

```
picks         = PICKS[rank]
nodropWeight  = round(tc.nodrop × NODROP_SCALE[rank])
```

Only `nodrop` is scaled. Every other weight is unchanged, so the *total* shrinks
and every real entry's share rises together.

| Rank | `PICKS` | `NODROP_SCALE` | Guarantee |
|---|---:|---:|---|
| `normal` | 1 | 1.00 | — |
| `minion` | 1 | 0.85 | — |
| `champion` | 2 | 0.55 | — |
| `unique` | 4 | 0.30 | at least one **magic-or-better equipment item** |
| `boss` | — | — | §5.5 |

Worked, `tc_humanoid_2`:

| Rank | nodrop | Total | P(item) per pick | P(≥ 1 item) | P(gold) per pick |
|---|---:|---:|---:|---:|---:|
| normal | 620 | 1000 | 10.50 % | 10.50 % | 23.00 % |
| minion | 527 | 907 | 11.58 % | 11.58 % | 25.36 % |
| champion | 341 | 721 | 14.56 % | **27.00 %** | 31.90 % |
| unique | 186 | 566 | 18.55 % | **55.98 %** | 40.64 % |

The unique-rank guarantee is applied **after** the four picks: if none of them
produced an equipment item of `magic` or better, one extra `item` pick is run
with a **rarity floor of `magic`** — the ladder of §4.1 is evaluated normally
and any result below `magic` is raised to `magic`. This satisfies
`03-combat-math.md` §9.3 exactly, and it costs one extra draw only on the 44 %
of unique-rank kills that need it.

### 5.5 `tc_boss` — Molgrim

No `nodrop`, no weights. A fixed script, in this order:

| # | Entry | Detail |
|---|---|---|
| 1 | **guaranteed unique** | *first kill on this difficulty only*, tracked by `CharacterSave.quests.word_unquenched.flags`. Drawn from §6 filtered by `alvl ≤ ilvl`, weighted by `dropWeight` |
| 2 | **guaranteed item, rarity floor `rare`** | full §4 ladder, any result below `rare` raised to `rare` |
| 3–6 | 4 × `item` | full boss-rank ladder (§4.5c) |
| 7 | `gold` | one pile at `RANK_GOLD.boss = 12.0` |
| 8–9 | 2 × `potion` | `tc_potion_<band>` |
| 10 | `scroll` | `tc_scroll_boss`: `scroll_identify 500`, `scroll_portal 300`, `scroll_respec 200` |

`scroll_respec` exists nowhere else as a drop, and Isa sells exactly one per
difficulty (§7.5). Three difficulties therefore guarantee a player at least
three respecs across a full playthrough, plus whatever the boss hands out —
which is what makes the plan's "no free respec" stance survivable.

Ten entries at `ilvl = mlvl + 3`. On Instruction (`mlvl 15`, `ilvl 18`) the
expected haul is one unique (first kill), one rare, ~2.0 magic, ~700 gold,
2 potions and a scroll. That is the payoff the whole act builds to.

### 5.6 Containers and destructibles

Ids and behaviour come from `07-world-gen.md` §9.2, which already fixes the
number of rolls per container. The tables below fill in what it defers.

**`tc_urn`** — `urn_clay`, `barrel_wood`, `crate_wood`. One pick, ilvl = zone
`monsterLevel`, Δ = 0.

| Entry | Weight |
|---|---:|
| `nodrop` | 300 |
| `gold` (× 0.35 pile) | 520 |
| `potion` | 120 |
| `item`, **rarity floor `magic`** | 60 |

The `60 / 1000` item weight is exactly the "6 % a magic base" that
`07-world-gen.md` §9.2 states, and the floor is what makes it a *magic* base
rather than an item that happens to roll magic.

**Chests** — `chest_iron` (3–5 rolls), `sarcophagus` (2–3 rolls). No `nodrop`;
`ilvl = zone monsterLevel + 2`, Δ = 2, `RANK` row "chest" from §4.2, gold pile
× 1.4.

| Class | Zone | `gold` | `item` | `potion` | `scroll` |
|---|---|---:|---:|---:|---:|
| `tc_wastes` | Ashen Wastes | 380 | 400 | 170 | 50 |
| `tc_bonereach` | Bonereach | 340 | 450 | 160 | 50 |
| `tc_altar` | Altar of Instruction | 300 | 520 | 130 | 50 |

`07-world-gen.md` §9.2 fixes the contents at generation time from the chest's
`S4` sub-seed, so opening a chest before or after a town trip gives the same
items. `items` must therefore roll a chest with the seed `world` hands it, not
with the live `items` stream — the one place the `items` stream is not the
source. `items.rollChest(chest, out)` (§13) takes the `Rng` explicitly for
exactly this reason.

### 5.7 Sub-tables — potions and scrolls

**`tc_potion_<band>`**, weights summing to 1000:

| Potion | B1 (1–9) | B2 (10–19) | B3 (20–29) | B4 (30–40) |
|---|---:|---:|---:|---:|
| `potion_life_minor` | 460 | 250 | 0 | 0 |
| `potion_life_lesser` | 70 | 300 | 200 | 0 |
| `potion_life_greater` | 0 | 60 | 300 | 260 |
| `potion_life_grand` | 0 | 0 | 60 | 300 |
| `potion_mana_minor` | 390 | 200 | 0 | 0 |
| `potion_mana_lesser` | 60 | 140 | 160 | 0 |
| `potion_mana_greater` | 0 | 30 | 200 | 190 |
| `potion_mana_grand` | 0 | 0 | 40 | 200 |
| `potion_rejuvenation` | 20 | 20 | 40 | 50 |

**`tc_scroll`** (everything except the boss):

| Scroll | Weight |
|---|---:|
| `scroll_identify` | 760 |
| `scroll_portal` | 240 |

A dropped potion or scroll arrives as an `ItemInstance` with
`quantity = 1`; §6.1 of `09-ui.md` tops up an existing stack on pickup rather
than allocating a cell.

### 5.8 Ground placement and decay

```
scatterAngle  = U(0, 2π)                         // draw D15a
scatterRadius = 0.45 + 0.85 × sqrt(U(0,1))       // draw D15b, metres
x = killPoint.x + cos(angle) × radius
z = killPoint.z + sin(angle) × radius
```

Then snapped to the nearest `NAV_FLAG.walkable` cell inside 2.5 m; if none
exists the item is placed on the killer's own cell. The `sqrt` gives a uniform
area distribution, so a ten-item boss drop forms a readable ring rather than a
pile at the centre.

`ItemInstance.ground.expiresAtStep` follows `01-data-model.md` §5.3: eviction by
`q.groundItemBudget`, oldest first, `rare` and `unique` exempt from budget
eviction but not from the 600 s hard timeout.

---

## 6. Uniques

Eight items. Every one rolls **all** of its mods, each independently in its own
range, in `mods` array order, from the `items` stream (`01-data-model.md` §5.5).
Uniques drop unidentified.

The unique is chosen at draw **D6** of §9 from the pool filtered by
`alvl ≤ ilvl`, weighted by `dropWeight`, and the item's `baseId` is
**substituted** for the unique's own. Without that substitution a unique bound
to `axe_battle_normal` would require rolling that exact base first — about
2.4 % of item drops — and then a 0.25 % quality roll, i.e. 0.006 % per item, and
no player would ever see one.

### 6.1 The table

| id | EN | RU | Base | `alvl` | Weight |
|---|---|---|---|---:|---:|
| `verens_reckoning` | Veren's Reckoning | Расплата Верена | `axe_battle_normal` | 12 | 10 |
| `ashen_crown` | Ashen Crown | Пепельный венец | `helm_coif_normal` | 14 | 4 |
| `long_way_back` | The Long Way Back | Долгий путь назад | `boots_march_exceptional` | 16 | 8 |
| `stonecutters_grasp` | Stonecutter's Grasp | Хватка Каменотёса | `gloves_gauntlets_exceptional` | 17 | 9 |
| `kairas_ledger` | Kaira's Ledger | Реестр Кайры | `belt_plated_exceptional` | 18 | 9 |
| `bonereach_vestment` | Bonereach Vestment | Облачение Костей Предела | `armour_plated_exceptional` | 19 | 7 |
| `unfinished_sentence` | The Unfinished Sentence | Незаконченная фраза | `sword_sigil_exceptional` | 20 | 5 |
| `last_syllable` | The Last Syllable | Последний слог | `amulet_seal` | 25 | 4 |

`ItemInstance.rolls.damageMin` / `damageMax` are copied from the substituted
base and then overridden only where a unique's mod list says so; every unique
below leaves the base damage alone and works through `enhancedDamage` and flats,
so a unique weapon still benefits from `strength` at pipeline step B5.

### 6.2 `verens_reckoning` — Veren's Reckoning

*Base* `axe_battle_normal` · *alvl* 12 · *reqLevel* 12 · *weight* 10

> **Lore (EN):** Veren struck the same blow eleven thousand times and called it
> a prayer.
> **RU:** Верен нанёс один и тот же удар одиннадцать тысяч раз и назвал это
> молитвой.

| Stat | Min | Max |
|---|---:|---:|
| `enhancedDamage` | 80 | 110 |
| `minDamage` | 6 | 10 |
| `maxDamage` | 14 | 20 |
| `increasedAttackSpeed` | 15 | 20 |
| `lifeSteal` | 5 | 8 |
| `rageOnHit` | 3 | 5 |
| `critChance` | 8 | 14 |

**Enables:** a sustain Ravager. Life steal plus rage income turns
`whirlwind` from a burst tool into a stance you can hold — at 6 % leech and the
level-13 numbers of `03-combat-math.md` §11 the Ravager recovers ~2.5 life per
landed hit, which is more than a four-Bone-Ranker pack removes. Deliberately
downside-free: it is the first unique most players will see, and a first unique
should feel like a gift.

### 6.3 `ashen_crown` — Ashen Crown

*Base* `helm_coif_normal` · *alvl* 14 · *reqLevel* 14 · *weight* 4

> **Lore (EN):** Worn by the first to read aloud and the first to forget.
> **RU:** Носима первым, кто прочёл вслух, и первым, кто забыл.

| Stat | Min | Max |
|---|---:|---:|
| `manaCostReduction` | 20 | 25 |
| `lifePercent` | −45 | −35 |
| `fireResist` | 15 | 25 |
| `skillBonuses.tree` (`flame`) | 2 | 2 |
| `fasterCastRate` | 15 | 20 |

**Enables — and this is one of the two genuinely build-defining items.** An
Emberwright at clvl 15 has 82 life on the reference allocation
(`03-combat-math.md` §2.3). The Crown takes it to **49**. A single Bone Ranker
hit at `mlvl 11` averages 18 before mitigation — three hits kill you. In
exchange you get `+2 Flame`, a fifth off every mana cost and a fifth off every
cast time, which is roughly a **35 % damage increase** on `fireball` and turns
`meteor` from a 16-mana finisher into a spammable. The Crown is the item that
says: you may play a glass cannon, and it will actually be glass.

The first three mods and their exact ranges, the lore line, the base and the
`dropWeight` are reproduced verbatim from `01-data-model.md` §5.5; the two
additional mods are this document's (§14, D-4).

### 6.4 `long_way_back` — The Long Way Back

*Base* `boots_march_exceptional` · *alvl* 16 · *reqLevel* 16 · *weight* 8

> **Lore (EN):** Bastion is behind you. It is always behind you.
> **RU:** Оплот позади тебя. Он всегда позади тебя.

| Stat | Min | Max |
|---|---:|---:|
| `movementSpeed` | 30 | 40 |
| `dodgeChance` | 8 | 12 |
| `ccReduction` | 20 | 30 |
| `maxStamina` | 40 | 60 |
| `cannotBeFrozen` | 1 | 1 |

**Enables:** the kiting build for every class, and the only pre-Renunciation
answer to a Frostbound champion pack. `cannotBeFrozen` plus 25 % control
reduction plus 35 % run speed is the difference between "walk out of the
Maulsmith telegraph" and "eat it".

### 6.5 `stonecutters_grasp` — Stonecutter's Grasp

*Base* `gloves_gauntlets_exceptional` · *alvl* 17 · *reqLevel* 17 · *weight* 9

> **Lore (EN):** He shaped the gate, the wall and the graves, in that order.
> **RU:** Он вытесал врата, стену и могилы — именно в таком порядке.

| Stat | Min | Max |
|---|---:|---:|
| `increasedAttackSpeed` | 20 | 30 |
| `minDamage` | 4 | 8 |
| `maxDamage` | 9 | 15 |
| `critChance` | 8 | 12 |
| `strength` | 10 | 15 |
| `thorns` | 20 | 35 |

**Enables:** a fast-weapon build — a dagger Runeblade or a one-hand-axe Ravager
— where the `+STR` also pays the requirement of the next weapon tier up. The
thorns roll is what makes it viable to stand inside a Carrion Swarm.

### 6.6 `kairas_ledger` — Kaira's Ledger

*Base* `belt_plated_exceptional` · *alvl* 18 · *reqLevel* 18 · *weight* 9

> **Lore (EN):** Every name she taught, and the day each one stopped answering.
> **RU:** Каждое имя, которому она учила, и день, когда оно перестало отзываться.

| Stat | Min | Max |
|---|---:|---:|
| `maxLife` | 25 | 40 |
| `fasterHitRecovery` | 30 | 45 |
| `damageReducePercent` | 5 | 8 |
| `magicFind` | 20 | 30 |
| `requirementReduction` | 15 | 20 |

**Enables:** the cross-class armour build. At 18 % requirement reduction an
Emberwright with 39 STR can wear `armour_plated_hauberk` (reqStr 62 → 51
effective) — still out of reach on the reference allocation, but one
`pfx_str_2` roll away. It is the item that lets a caster stop being made of
paper without giving up a damage slot.

### 6.7 `bonereach_vestment` — Bonereach Vestment

*Base* `armour_plated_exceptional` · *alvl* 19 · *reqLevel* 19 · *weight* 7

> **Lore (EN):** They stopped burying the dead and started dressing in them.
> **RU:** Мёртвых перестали хоронить и начали в них одеваться.

| Stat | Min | Max |
|---|---:|---:|
| `defensePercent` | 90 | 130 |
| `maxLife` | 40 | 60 |
| `damageReduceFlat` | 4 | 7 |
| `fireResist` | 12 | 18 |
| `coldResist` | 12 | 18 |
| `lightResist` | 12 | 18 |
| `movementSpeed` | −10 | −10 |

**Enables:** the Ravager who intends to survive Renunciation. `damageReduceFlat`
before percentage reduction (`03-combat-math.md` §6.2 R7) makes 4–7 flat
enormous against a Carrion Swarm, whose `mlvl 33` hits average 8 physical each,
and almost irrelevant against Molgrim — which is exactly the shape a tank item
should have.

### 6.8 `unfinished_sentence` — The Unfinished Sentence

*Base* `sword_sigil_exceptional` · *alvl* 20 · *reqLevel* 20 · *weight* 5

> **Lore (EN):** The Instructor was interrupted. The blade remembers where.
> **RU:** Наставника прервали. Клинок помнит, на чём.

| Stat | Min | Max |
|---|---:|---:|
| `enhancedDamage` | 60 | 85 |
| `manaPercent` | −60 | −45 |
| `manaReturnPercent` | 14 | 20 |
| `maxResonance` | 2 | 2 |
| `resonanceOnHit` | 1 | 1 |
| `fasterCastRate` | 15 | 25 |

**Enables — the second genuinely build-defining item, and the harshest.** A
Runeblade at clvl 20 has 75 mana. The Sentence takes it to **32**. That is not
enough to cast `phase_leap` twice. What it *is* enough for is a machine: the
base `manaReturnPercent` of 8 (`03-combat-math.md` §2.4) plus 17 from the sword
is 25 %, so a 30-damage hit returns 7.5 mana and `blade_seal` at 5 mana is paid
for by two swings. `maxResonance +2` on top of `resonance_circuit` pushes the
cap to 5 and `resonanceOnHit +1` doubles the fill rate.

You cannot open a fight with a spell any more. You open with the sword, and the
sword pays for the spells. That is the Runeblade fantasy taken to its
conclusion, and the −50 % mana is the price of admission.

### 6.9 `last_syllable` — The Last Syllable

*Base* `amulet_seal` · *alvl* 25 · *reqLevel* 25 · *weight* 4

> **Lore (EN):** What is left of a word after the meaning is taken out of it.
> **RU:** То, что остаётся от слова, когда из него вынули смысл.

| Stat | Min | Max |
|---|---:|---:|
| `skillBonuses.all` | 2 | 2 |
| `physicalDamagePercent` | −100 | −100 |
| `magicMin` | 20 | 30 |
| `magicMax` | 45 | 65 |
| `elementalDamagePercent` | 40 | 60 |
| `manaRegenPercent` | 8 | 12 |

**Enables:** a weapon that deals no physical damage at all. `−100 %
physicalDamagePercent` zeroes the physical component at pipeline step B6, which
also zeroes `lifeSteal` and `manaSteal` (both are percentages *of physical
dealt*, `03-combat-math.md` §6.2 R14d) and makes every point of `enhancedDamage`
on the weapon worthless. What you get instead is 20–30 / 45–65 flat `magic` —
the one element with no resistance pierce, no immunity affix and no status, and
which Molgrim resists at only 40 against 50/50/50 on the three elements.

It is the item that makes an Emberwright melee build real and turns a Runeblade
into a caster who happens to hold a sword. It is also a trap for anyone wearing
`verens_reckoning`, and the tooltip's `--danger-ink` line (ordinal 990,
`09-ui.md` §5.3.1) says so plainly.

### 6.10 What the eight do not cover

`ring1` / `ring2` and `offHand` have **no** unique. The plan (§4.4) asks for
"one per slot plus two weapons" at a budget of eight items, which is
arithmetically impossible against ten slots — see §14, C-1. Rings and shields
are the two slots where magic and rare rolls are already strongest (a rare ring
can carry six affixes from the widest pool in §2), so they are the two least
damaged by the omission. Two more uniques are the obvious first content
addition after M9.

---

## 7. Economy

### 7.1 Gold from monsters

```
goldBase(mlvl) = 4 + 2.40 × mlvl + 0.12 × mlvl²

goldPile = max(1, round( goldBase(mlvl)
                       × RANK_GOLD[rank]
                       × CONTAINER_MULT
                       × (1 + goldFind / 100)
                       × U(0.75, 1.25) ))
```

| Term | Values |
|---|---|
| `RANK_GOLD` | normal 1.0 · minion 1.0 · champion 2.2 · unique 4.0 · boss 12.0 |
| `CONTAINER_MULT` | monster 1.0 · chest 1.4 · urn/barrel/crate 0.35 |
| `goldFind` | the stat. **The difficulty bonus enters here and only here** — `03-combat-math.md` §10.2 grants +40 % on Trial and +90 % on Renunciation as `goldFind`, so there is no separate difficulty multiplier and the number is never counted twice. |

`goldBase` at the nine zone levels:

| mlvl | 6 | 11 | 15 | 18 | 23 | 27 | 28 | 33 | 37 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `goldBase` | 22.72 | 44.92 | 67.00 | 86.08 | 122.68 | 156.28 | 165.28 | 213.88 | 257.08 |

Growth from `mlvl 6` to `mlvl 37` is **11.3×**, while item prices grow as
`reqLevel^1.9` — from `reqLevel 4` to `reqLevel 26` that is **35×**. Costs
outrun income by design: gold is a real constraint through Instruction, an
easing one through Trial, and a rounding error by the end of Renunciation. §7.7
shows exactly where each of those three lines is crossed.

**Carried gold cap:** `10 000 + 10 000 × clvl` (310 000 at level 30). The
shared stash holds a further **2 500 000**. Gold picked up above the cap is
refused with `toast.goldFull` and stays on the ground.

### 7.2 Item value

One formula, used by the tooltip's Value line, by the vendor and by the
migration credit of `01-data-model.md` §10.4 rule 9:

```
itemValue(item) = max(1, floor(
      base.baseValue
    × RARITY_VALUE[item.rarity]
    × (1 + 0.16 × item.affixes.length)
    × durabilityFactor(item)
    × superiorFactor(item) ))

durabilityFactor = maxDurability === 0 ? 1.0
                 : 0.35 + 0.65 × (durability / maxDurability)
superiorFactor   = rarity === 'superior' ? 1 + rolls.superior / 100 : 1.0
```

| Rarity | `RARITY_VALUE` |
|---|---:|
| `normal` | 1.00 |
| `superior` | 1.35 |
| `magic` | 2.20 |
| `rare` | 3.60 |
| `unique` | 6.00 |

An **unidentified** rare or unique is valued at `RARITY_VALUE.magic` and
`affixes.length = 0` — the vendor cannot see what he is not shown, and this is
what makes it correct to spend 90 gold on a scroll before selling.

### 7.3 Buying and selling

```
playerPays(item)     = max(1, itemValue(item))                    // vendor → player
playerReceives(item) = max(1, min(25 000, floor(itemValue(item) × 0.25)))
```

A flat **4× spread**, with a 25 000 sell cap so a lucky unique cannot fund the
rest of the difficulty. Buyback holds the last **12** items the player sold, at
`playerPays` — buying back a mistake costs four times what you got, which is
punishment enough to make the confirmation dialogue on `rare`/`unique`
(`09-ui.md` §6.3) meaningful without being unrecoverable.

Worked, `axe_battle_normal` (`baseValue 220`) at full durability:

| Item | `itemValue` | Player pays | Player receives |
|---|---:|---:|---:|
| normal | 220 | 220 | 55 |
| superior, `rolls.superior = 10` | 326 | 326 | 81 |
| magic, 2 affixes | 638 | 638 | 159 |
| rare, 4 affixes | 1 298 | 1 298 | 324 |
| rare, 4 affixes, **unidentified** | 484 | — | 121 |
| rare, 4 affixes, durability 11/55 | 623 | 623 | 155 |
| `verens_reckoning` (unique; `affixes.length` is 0) | 1 320 | 1 320 | 330 |

The unidentified row is the whole identification loop in one line: **121 now, or
324 after spending 90 on a scroll** — a net gain of 113. The break-even is
`0.25 × baseValue × (3.6 × (1 + 0.16n) − 2.2) ≥ 90`, which at four affixes is
`baseValue ≥ 98`. Every base at `reqLevel ≥ 7` clears it (the cheapest is
`belt_studded_normal` at 117), and nothing at `reqLevel ≤ 4` does. Identifying
the junk you find in the first hour is a genuine mistake; identifying anything
after that is not.

### 7.4 Durability, repair and death

Nothing outside this document defines how durability is *lost*, so it is
defined here.

| Event | Loss |
|---|---|
| Landed attack (attacker's `mainHand`) | **1 per 12 landed attacks**, carried in an integer accumulator on the item so the fractional part is never lost |
| Hit taken (defender) | **1 per 25 hits taken**, applied round-robin over the equipped `armour` pieces in `SLOT_ORDER`, skipping indestructible items |
| Block (defender, `outcome === 'block'`) | **1 per 20 blocks**, on the shield specifically, in addition to the armour round-robin |
| Death | `ceil(0.08 × maxDurability)` on **every** equipped item |
| `maxDurability === 0` | exempt from all of the above |

At `durability === 0` the item is not destroyed. It stays equipped, is marked
`_cache.unusable = true`, contributes **nothing** (`01-data-model.md` §4.4), and
`items` emits `stats:dirty` — which is the "durability reaching 0 or leaving 0"
trigger that document's §4.5 already lists.

```
repairCost(item) = max(1, ceil(
      0.30 × base.baseValue × RARITY_VALUE[item.rarity]
           × (1 − durability / maxDurability) ))

repairAllCost(actor) = Σ repairCost over equipment + inventory + belt
```

Worked:

| Item | State | Repair |
|---|---|---:|
| magic `axe_battle_normal` | 20/55 | 93 |
| magic `axe_battle_normal` | 0/55 | 146 |
| rare `axe_ruin_elite` | 40/87 | 968 |
| rare `armour_sepulchre_elite` | 55/109 | 1 064 |

Repairing from zero always costs more than selling the broken item gets:
`0.30 × baseValue × RV` to repair against
`0.0875 × baseValue × RV × (1 + 0.16n)` to sell — between **2.1×** (six
affixes) and **3.4×** (no affixes) more. The incentive is therefore: repair what
you use, sell what you do not, and never repair before selling.

### 7.5 Vendor stock

**Veren the Stonecutter** — buy, sell, repair. Stock regenerates on every
`zone:enter` into `last_bastion`, from a **dedicated `Rng` fork owned by
`items`**, never from `ctx.rng` and never from the drop stream — a player
opening the vendor panel must not shift the loot sequence
(`09-ui.md` §16.2 makes the same point about `currentStock`).

| Section | Rows | Content |
|---|---:|---|
| Consumables | 8 | `potion_life_*` and `potion_mana_*` of the two tiers legal at `clvl`, `potion_rejuvenation` from clvl 12, `scroll_portal`. Infinite quantity |
| Equipment | 10 | `ilvl = clvl + 2`, capped at 40. Rarity forced by the table below; base group drawn as §1.3 |

| `clvl` | normal | superior | magic | rare |
|---|---:|---:|---:|---:|
| 1–11 | 4 | 2 | 4 | 0 |
| 12–21 | 3 | 1 | 5 | 1 |
| 22–30 | 2 | 1 | 5 | 2 |

**Isa the Runeweaver** — `scroll_identify` (infinite, 90), `scroll_portal`
(infinite, 120), `scroll_respec` (**one per difficulty**, 5 000, and the row
disappears once bought until the character advances a tier).

Neither vendor buys quest items. Both refuse an item at `durability === 0` with
`vendor.brokenRefused` — repair first.

### 7.6 Consumable and scroll prices

`baseValue` **is** the buy price; the sell price falls out of the 4× spread.

| id | EN | RU | Buy | Sell | Stack |
|---|---|---|---:|---:|---:|
| `potion_life_minor` | Minor Life Potion | Малое зелье жизни | 35 | 8 | 20 |
| `potion_life_lesser` | Lesser Life Potion | Меньшее зелье жизни | 85 | 21 | 20 |
| `potion_life_greater` | Greater Life Potion | Большое зелье жизни | 180 | 45 | 20 |
| `potion_life_grand` | Grand Life Potion | Великое зелье жизни | 340 | 85 | 20 |
| `potion_mana_minor` | Minor Mana Potion | Малое зелье маны | 40 | 10 | 20 |
| `potion_mana_lesser` | Lesser Mana Potion | Меньшее зелье маны | 95 | 23 | 20 |
| `potion_mana_greater` | Greater Mana Potion | Большое зелье маны | 200 | 50 | 20 |
| `potion_mana_grand` | Grand Mana Potion | Великое зелье маны | 380 | 95 | 20 |
| `potion_rejuvenation` | Rejuvenation Potion | Зелье восстановления | 450 | 112 | 20 |
| `scroll_identify` | Scroll of Identify | Свиток опознания | 90 | 22 | 20 |
| `scroll_portal` | Scroll of Town Portal | Свиток городского портала | 120 | 30 | 20 |
| `scroll_respec` | Scroll of Unlearning | Свиток забвения | 5 000 | 1 250 | 1 |

### 7.7 The ledger — income against costs at levels 5, 15 and 28

Each row is **one full zone clear**, using the zone descriptors of
`07-world-gen.md` (pack counts, chest counts) and the drop rates of §5.
"Monsters" is `packCount_avg × packSize_avg`; champions and uniques come from
`champChance` / `uniqueChance` per pack; a unique brings 4 minions on average.

| | **A — clvl 5** | **B — clvl 15** | **C — clvl 28** |
|---|---|---|---|
| Zone / tier | Ashen Wastes / Instruction | Bonereach / Instruction | Bonereach / Renunciation |
| `mlvl` | 6 | 11 | 33 |
| Normal monsters | 97.8 | 93.5 | 93.5 |
| Champions / uniques / minions | 1.84 / 0.69 / 2.76 | 2.20 / 0.88 / 3.52 | 2.20 / 0.88 / 3.52 |
| Chests × rolls | 3.0 × 4 | 5.5 × 4 | 5.5 × 4 |
| Destructibles broken | 14 | 18 | 18 |
| Magic Find / Gold Find | 0 / 0 | 25 / 25 | 120 / 150 |
| **Gold — normals** | 409 | 1 052 | 10 374 |
| **Gold — champions** | 49 | 153 | 1 458 |
| **Gold — uniques** | 92 | 290 | 2 671 |
| **Gold — minions** | 13 | 44 | 428 |
| **Gold — chests** | 145 | 588 | 5 600 |
| **Gold — destructibles** | 58 | 184 | 1 751 |
| **Gold subtotal** | **765** | **2 311** | **22 282** |
| Items dropped | 13.7 | 22.9 | 27.2 |
| Mean `itemValue` | 32 | 131 | 698 |
| Sale income (70 % sold) | 110 | 524 | 3 323 |
| **Total income** | **875** | **2 835** | **25 605** |
| Life potions | 6 × 35 = 210 | 10 × 85 = 850 | 14 × 180 = 2 520 |
| Mana potions (caster) | 4 × 40 = 160 | 6 × 95 = 570 | 8 × 200 = 1 600 |
| Identify scrolls | 0.4 × 90 = 36 | 1.7 × 90 = 153 | 3.2 × 90 = 288 |
| Portal scrolls | 1 × 120 = 120 | 2 × 120 = 240 | 2 × 120 = 240 |
| Repair | 15 | 393 | 2 480 |
| **Total cost (caster, worst case)** | **541** | **2 206** | **7 128** |
| **Net per clear** | **+334** | **+629** | **+18 477** |
| Cost of the next real upgrade at Veren | magic `sword_rune_normal` **514** | magic `sword_sigil_exceptional` **1 916** | rare `axe_ruin_elite` **9 788** |
| **Clears per upgrade** | **1.5** | **3.0** | **0.5** |

**Reading the table.** At level 5 the player finishes a run able to afford
either a full belt of potions or two thirds of a weapon upgrade, and must
choose. At level 15 an upgrade is a three-run goal, which is the tightest point
on the curve and deliberately so — it is the stretch where Bonereach's drops,
not the vendor, are meant to be the answer. At level 28 gold has stopped being
the binding constraint entirely: the player can buy two vendor rares per run and
still bank 8 000.

That last row is not a failure of the model, it is the genre-correct shape, and
it is worth naming: **after roughly level 24 the scarce resource stops being
gold and becomes drop quality.** Veren's rare stock is capped at
`ilvl = clvl + 2` while a Renunciation Bonereach drop is `ilvl 33–36`, so the
gold surplus buys *rolls of the dice*, never a guaranteed upgrade. Any attempt
to keep gold scarce at level 28 would mean either starving level 5 or making
repair costs punitive — both worse.

**Is the player ever starved?** The binding test is: can a level-5 character who
buys nothing but potions still clear the Wastes? Costs 210–370 against 765 gold
of pure monster drops, before selling a single item. Yes, with a 2× margin.

**Is the player ever drowning?** Through Instruction and Trial, no — the
"clears per upgrade" row never drops below 1.5. In Renunciation, yes, and the
design accepts it.

### 7.8 Where the numbers came from

Three drop-rate figures above are worth showing, because everything else in the
ledger scales off them. Row B, Bonereach, `mlvl 11`, band 2, with the zone's
bestiary weighted 40 % humanoid / 34 % swarm / 14 % caster / 12 % heavy:

```
P(gold | normal kill) = 0.40×0.230 + 0.34×0.137 + 0.14×0.212 + 0.12×0.268
                      = 0.0920 + 0.04658 + 0.02968 + 0.03216 = 0.20042
P(item | normal kill) = 0.40×0.105 + 0.34×0.043 + 0.14×0.148 + 0.12×0.197
                      = 0.0420 + 0.01462 + 0.02072 + 0.02364 = 0.10098

gold from normals  = 93.5 × 0.20042 × (44.92 × 1.25) = 1 052
items from normals = 93.5 × 0.10098                  = 9.44
```

A champion's `nodrop` is scaled to 0.55 and it takes two picks, so its per-pick
item chance rises from 10.50 % to 14.56 % and its expected item count is
**0.291** against a normal's 0.105 — 2.8× the loot for 4× the life and 1.6× the
damage (`03-combat-math.md` §9.3). Champions are worth fighting; they are not
worth *hunting* to the exclusion of the pack, which is the balance the rank
table is aiming at.

---

## 8. Potions and consumables

Twelve `ItemBase` records with `category: 'consumable'`, `slot: null`,
`maxDurability: 0`, `dropWeight: 0` (they are never picked by the base-group
draw — they come from the `potion` and `scroll` entries of §5.7).

### 8.1 The catalogue

Amounts, `overSeconds` and effects are **reproduced from
`03-combat-math.md` §8.8** and are not re-decided here.

| id | `effect` | `amountPercent` | `overSeconds` | `stackMax` | Cooldown | Buy | Drop band |
|---|---|---:|---:|---:|---:|---:|---|
| `potion_life_minor` | `restore_life` | 35 | 3.0 | 20 | 0.5 | 35 | B1–B2 |
| `potion_life_lesser` | `restore_life` | 45 | 3.0 | 20 | 0.5 | 85 | B1–B3 |
| `potion_life_greater` | `restore_life` | 60 | 3.0 | 20 | 0.5 | 180 | B2–B4 |
| `potion_life_grand` | `restore_life` | 80 | 3.0 | 20 | 0.5 | 340 | B3–B4 |
| `potion_mana_minor` | `restore_mana` | 35 | 3.0 | 20 | 0.5 | 40 | B1–B2 |
| `potion_mana_lesser` | `restore_mana` | 45 | 3.0 | 20 | 0.5 | 95 | B1–B3 |
| `potion_mana_greater` | `restore_mana` | 60 | 3.0 | 20 | 0.5 | 200 | B2–B4 |
| `potion_mana_grand` | `restore_mana` | 80 | 3.0 | 20 | 0.5 | 380 | B3–B4 |
| `potion_rejuvenation` | `restore_both` | 40 | 0.0 | 20 | 2.0 | 450 | B1–B4 |
| `scroll_identify` | `identify` | — | 0.0 | 20 | 0.5 | 90 | all |
| `scroll_portal` | `town_portal` | — | 1.0 | 20 | 1.0 | 120 | all |
| `scroll_respec` | `respec` | — | 0.0 | 1 | 2.0 | 5 000 | boss only |

Icons, grid size and surface: every consumable is `1 × 1`, `surface: 'crystal'`
for potions and `'wood'` for scrolls, with `iconSeed` values
`0x2101 … 0x210c` in the order above.

### 8.2 Why percentages, not flat amounts

`03-combat-math.md` §8.8 specifies percentages; the reason is worth recording,
because it is the reason the table has four tiers rather than twelve.

Maximum life at the reference allocation (`03` §2.3), no gear:

| clvl | Ravager | Emberwright | Runeblade | Spread |
|---:|---:|---:|---:|---:|
| 5 | 95 | 52 | 63 | 1.83× |
| 15 | 195 | 82 | 108 | 2.38× |
| 30 | 345 | 127 | 176 | **2.72×** |

A **flat** potion tuned to be meaningful for a level-30 Ravager (say 120 life)
would full-heal a level-30 Emberwright from 5 % in a single sip. One tuned for
the Emberwright (45 life) would be 13 % of the Ravager's bar and worthless. The
class life spread is 2.7× at cap and there is exactly one potion table, so
percentages are not a preference — they are the only formulation that survives
the class table.

The tiers still matter, because what scales is the *rate*:

| Potion | Ravager @30 (345 life) | Rate | Emberwright @30 (127) | Rate |
|---|---:|---:|---:|---:|
| minor 35 % | 120.75 | 40.25 /s | 44.45 | 14.82 /s |
| lesser 45 % | 155.25 | 51.75 /s | 57.15 | 19.05 /s |
| greater 60 % | 207.00 | 69.00 /s | 76.20 | 25.40 /s |
| grand 80 % | 276.00 | 92.00 /s | 101.60 | 33.87 /s |

Against the incoming-damage model of `03-combat-math.md` §11.5 — a five-strong
pack deals 29.80 DPS to a level-10 Ravager — a minor potion at level 10
out-heals a full pack. At `mlvl 33` on Renunciation the same pack shape deals
roughly 5.6× that (`damageMult(33)/damageMult(10) = 15.72/3.59`), i.e. ~167 DPS,
and only the grand potion's 92 /s keeps a Ravager standing while the fight is
resolved. That is the whole tier ladder, in one comparison.

### 8.3 Drinking rules

| Rule | Value |
|---|---|
| Global belt cooldown | **0.5 s** between any two consumable uses, so a mis-keyed double-tap cannot drain a slot |
| Same-effect overlap | A `restore_life` potion drunk while another `restore_life` is active **replaces** it iff `newTotal > remainingTotal`, otherwise the use is refused and the potion is not consumed (`toast.potionActive`). Mana follows the same rule independently |
| `potion_rejuvenation` | Instant, ignores the overlap rule, its own 2.0 s cooldown, restores 40 % of **each** pool |
| `poisoned` | Does **not** block potion healing (`03-combat-math.md` §6.4) — it blocks passive regeneration only |
| Death | Cancels an in-progress drink; the potion is still consumed |
| `scroll_portal` | 1.0 s cast, cancelled by any damage taken, refunded if cancelled |
| `scroll_respec` | Town only. Refunds every allocated skill and attribute point |

The replace-if-greater rule is deliberately the same shape as the poison
stacking rule of `01-data-model.md` §7.3. One rule, learned once, applied in two
places.

### 8.4 How many does the player actually find?

From the §5 tables and the §7.7 zone profiles:

| Row | Potions found | Potions used | Net | Scrolls found | Scrolls used |
|---|---:|---:|---:|---:|---:|
| A — clvl 5, Wastes | 6.6 | 6–10 (mid 8) | **−1.4** | 1.1 | 1.4 |
| B — clvl 15, Bonereach | 9.3 | 10–16 (mid 13) | **−3.7** | 2.0 | 3.7 |
| C — clvl 28, Bonereach/Renunciation | 9.9 | 14–22 (mid 18) | **−8.1** | 2.5 | 5.2 |

Consumption exceeds discovery at every level, and the gap **widens**: 21 % at
level 5, 40 % at level 15, 82 % on Renunciation. That is intentional — potion
drops are gated by the treasure-class weights, which grow slowly, while
incoming damage grows with `damageMult(mlvl)`, which does not. It is what
forces the town trip, and it is what gives gold its job in the first half of the
game. A player who never buys potions runs out inside three zone clears at level
5 and inside one on Renunciation.

---

## 9. The item generation algorithm

This is the normative description. Two implementations that follow it produce
byte-identical items from one seed.

### 9.1 Preconditions

- All draws come from the **`items`** stream — a single `ctx.rng.fork()` taken
  once in `init()` (`ARCHITECTURE.md` determinism contract). The only exception
  is a chest, which is rolled with the `Rng` `world` supplies from the chest's
  `S4` sub-seed (§5.6).
- `U(a,b)` is a uniform real on `[a,b)`; `Ui(a,b)` is a uniform integer on
  `[a,b]` inclusive; `W(entries)` is one weighted pick consuming exactly one
  draw.
- Every conditional draw is marked. A draw that is skipped is **not** consumed.

### 9.2 The draw order

| # | Draw | When | Consumes |
|---|---|---|---|
| **D1** | `W(tc.entries)` — which entry this pick produced | every pick | 1 |
| **D2** | `U(0.75, 1.25)` — gold pile variance | entry is `gold` | 1 |
| **D3** | `W(baseGroups)` — the base group | entry is `item` | 1 |
| **D4** | `W(basesInGroup)` — the base | entry is `item` | 1 |
| **D5** | `U(0,1)` — the quality ladder of §4.1 | entry is `item` | 1 |
| **D6** | `W(uniquePool)` — unique substitution | `quality === 'unique'` and the pool is non-empty | 1 |
| **D7** | `Ui(5, 15)` — `rolls.superior` | `quality === 'superior'` | 1 |
| **D8** | `Ui(defMin, defMax)` — `rolls.defense` | `category === 'armour'` | 1 |
| **D9a** | `W({prefixOnly, suffixOnly, both})` | `quality === 'magic'` | 1 |
| **D9b** | `W({1,2,3})` — prefix count | `quality === 'rare'` | 1 |
| **D9c** | `W({1,2,3})` — suffix count | `quality === 'rare'` | 1 |
| **D10** | `W(prefixPool)` × prefixCount, then `W(suffixPool)` × suffixCount | magic or rare | 1 per affix |
| **D11** | one draw per `mods` entry, prefixes in pick order then suffixes in pick order, `mods` in array order | magic or rare | 1 per mod |
| **D12** | one draw per `mods` entry, array order | `quality === 'unique'` | 1 per mod |
| **D13** | `Ui(0, 43)`, `Ui(0, 47)`, `Ui(0, 19)` — rare name A, B, C | `quality === 'rare'`; C only when `affixCount ≥ 5` | 2 or 3 |
| **D14** | `W(tc_potion_<band>)` or `W(tc_scroll)` | entry is `potion` or `scroll` | 1 |
| **D15** | `U(0, 2π)` then `U(0,1)` — ground scatter | every item, potion, scroll and gold pile that reaches the floor | 2 |

D11's ordering — all prefixes before all suffixes, `mods` in array order — is
restated verbatim from `01-data-model.md` §5.2 and must not be reordered for any
reason. `sharedRoll` affixes (§2.4) consume **one** draw regardless of how many
`mods` entries they declare.

### 9.3 The procedure

```
rollDrop(tc, mlvl, rank, ilvl, difficulty, magicFind, rng) → ItemInstance | null

  1  band   = bandOf(mlvl)                        // 1..4, §5.1
     tcRes  = resolveTC(tc, band)
     picks  = PICKS[rank]
     nodrop = round(tcRes.nodrop × NODROP_SCALE[rank])

  2  repeat `picks` times:
       entry = W(tcRes.entries with nodrop replaced)          // D1
       switch entry.kind:
         nodrop  → continue
         gold    → emit a gold pile, amount per §7.1           // D2
         potion  → base = W(tc_potion_band)                    // D14
                   emit createItem(base, { quantity: 1 })
         scroll  → base = W(tc_scroll)                         // D14
                   emit createItem(base, { quantity: 1 })
         item    → emit rollItem(...)  as below

  3  rollItem:
       group  = W(baseGroups, eligible at ilvl)                // D3
       base   = W(basesInGroup, reqLevel ≤ ilvl)               // D4
       rarity = rollQuality(ilvl, mlvl, rank, difficulty, mf)  // D5
       rarity = applyFloor(rarity, entry.rarityFloor)          // §5.5, §5.6
       rarity = degrade(rarity, base, ilvl)                    // §4.4

  4    if rarity === 'unique':
           def  = W(uniquePool where alvl ≤ ilvl)              // D6
           base = bases[def.baseId]                            // substitution

  5    item = { uid: nextUid++, baseId: base.id, rarity, ilvl,
                identified: rarity !== 'rare' && rarity !== 'unique',
                quantity: 1, affixes: [], uniqueId: null,
                nameOverride: null,
                durability: base.maxDurability,
                maxDurability: base.maxDurability,
                sockets: [], socketCount: 0 }

  6    item.rolls.damageMin = base.weapon ? base.weapon.minDamage : 0
       item.rolls.damageMax = base.weapon ? base.weapon.maxDamage : 0
       item.rolls.superior  = rarity === 'superior' ? Ui(5,15) : 0    // D7
       item.rolls.defense   = base.armour ? Ui(defMin, defMax) : 0    // D8

  7    if rarity === 'magic':
           mode = W({ prefixOnly: 25, suffixOnly: 25, both: 50 })     // D9a
           nPre = mode === 'suffixOnly' ? 0 : 1
           nSuf = mode === 'prefixOnly' ? 0 : 1
       else if rarity === 'rare':
           nPre = W(affixCountWeights(ilvl))                          // D9b
           nSuf = W(affixCountWeights(ilvl))                          // D9c
       else nPre = nSuf = 0

  8    usedGroups = new Set()
       for i in 1..nPre:  pick a prefix (D10), push, mark its group
       for i in 1..nSuf:  pick a suffix (D10), push, mark its group
       // a pick whose filtered pool is empty is skipped, not retried

  9    for each affix in pick order (prefixes then suffixes):
           if affix.sharedRoll:  v = rollMod(mods[0]); values = mods.map(() => v)   // 1 draw
           else:                 values = mods.map(m => rollMod(m))                 // 1 draw each
       // D11

 10    if rarity === 'unique':
           item.uniqueId = def.id
           item.affixes  = []                     // uniques carry no AffixInstance
           item.uniqueValues = def.mods.map(m => rollMod(m))          // D12

 11    if rarity === 'rare':
           a = A[Ui(0,43)] ; b = B[Ui(0,47)]                          // D13
           item.nameOverride = (nPre + nSuf >= 5)
                             ? a + ' ' + b + ' ' + C[Ui(0,19)]
                             : a + ' ' + b

 12    rebuildCache(item)                          // no draws, pure
       return item
```

`rollMod(m)` is `Ui(m.min, m.max)` when `m.step` is 1 or absent, and
`m.min + m.step × Ui(0, floor((m.max − m.min) / m.step))` otherwise. It consumes
exactly one draw either way.

### 9.4 The affix filter

A candidate affix is legal for `(base, ilvl, usedGroups)` when **all** hold:

1. `affix.alvl ≤ ilvl`
2. `affix.maxLevel ≥ ilvl`
3. `affix.kind` matches the slot being filled
4. `affix.appliesTo` contains `base.category`
5. `affix.requiresGroups ∩ base.allowedAffixGroups ≠ ∅`
6. `affix.group ∉ usedGroups`

The pool is rebuilt after every pick because rule 6 changes. The build is a
filter over a **fixed-order** array — `src/items/data/affixes.js` exports one
frozen array and the iteration order is its declaration order — so the weighted
pick is reproducible.

Rule 6 is what `01-data-model.md` calls "one affix per group per item", and it
applies across the prefix/suffix boundary: an item can never carry
`sfx_res_all_1` *and* `sfx_res_all_2`, because both are group `resist_all`.

### 9.5 Rarity floors and degradation, in order

Applied between D5 and D6:

```
applyFloor(r, floor)   // floor from the TC entry: null | 'magic' | 'rare'
   → RARITY_ORDER.indexOf(r) < RARITY_ORDER.indexOf(floor) ? floor : r

degrade(r, base, ilvl)
   while true:
     if r === 'unique'   and uniquePool(base, ilvl) is empty  → r = 'rare';    continue
     if r === 'rare'     and legalAffixCount(base, ilvl) < 2  → r = 'magic';   continue
     if r === 'magic'    and legalAffixCount(base, ilvl) < 1  → r = 'superior';continue
     if r === 'superior' and !base.weapon && !base.armour     → r = 'normal'
     break
```

The `unique → rare` branch is only reachable when the whole §6 table is
`alvl`-gated out, i.e. `ilvl < 12`. Below that level uniques do not exist, which
is correct: the first four character levels should be about learning the
controls, not about a chase item.

### 9.6 Affix-count weights for rares

```
w1 = 52 − 0.9 × min(ilvl, 40)
w2 = 34 + 0.2 × min(ilvl, 40)
w3 = 14 + 0.7 × min(ilvl, 40)
```

Drawn independently for prefixes and suffixes, so the total is 2–6 with a
closed-form distribution:

| `ilvl` | w1 / w2 / w3 | P(1) | P(2) | P(3) | E[count] | E[total] |
|---:|---|---:|---:|---:|---:|---:|
| 6 | 46.6 / 35.2 / 18.2 | 0.4660 | 0.3520 | 0.1820 | 1.716 | 3.432 |
| 12 | 41.2 / 36.4 / 22.4 | 0.4120 | 0.3640 | 0.2240 | 1.812 | 3.624 |
| 20 | 34.0 / 38.0 / 28.0 | 0.3400 | 0.3800 | 0.2800 | 1.940 | 3.880 |
| 30 | 25.0 / 40.0 / 35.0 | 0.2500 | 0.4000 | 0.3500 | 2.100 | 4.200 |
| 40 | 16.0 / 42.0 / 42.0 | 0.1600 | 0.4200 | 0.4200 | 2.260 | 4.520 |

Total distribution at `ilvl 20`:

| Total affixes | 2 | 3 | 4 | 5 | 6 |
|---|---:|---:|---:|---:|---:|
| Probability | 11.56 % | 25.84 % | 33.48 % | 21.28 % | **7.84 %** |

`P(total ≥ 5) = 0.2912` — the figure §3.5 uses for the epithet-pool expansion.
A six-affix rare is a one-in-thirteen rare, which is roughly one per two zone
clears at level 20 and is the right frequency for "the good one".

---

## 10. Balance validation — `tools/lootsim.mjs`

`IMPLEMENTATION_PLAN.md` §8 requires this harness from the first day of M3 and
names the failure it exists to catch: *"падает мусор" или "падает всё"*. It
imports `src/items/data/*` and the roll pipeline directly in Node — no browser,
no `three`, no DOM — which is why §9 is arithmetic over plain objects.

### 10.1 Invocation and profiles

```
node tools/lootsim.mjs --drops=200000 --seed=0x4c00751 [--profile=<name>] [--json]
```

Each profile is 200 000 **drop rolls** (not kills — a kill that rolls `nodrop`
still counts as a roll, so the `nodrop` rate is itself measured).

| Profile | mlvl | rank mix | Difficulty | MF | Purpose |
|---|---:|---|---|---:|---|
| `early` | 6 | 100 % normal | Instruction | 0 | the level-5 experience |
| `mid` | 11 | 88 normal / 8 champ / 4 unique | Instruction | 25 | the level-15 experience |
| `late` | 33 | 88 / 8 / 4 | Renunciation | 120 | the level-28 experience |
| `champ` | 20 | 100 % champion | Instruction | 50 | isolates §4.5b |
| `boss` | 27 | 100 % boss | Trial | 75 | isolates §4.5c |
| `sweep` | 1…40, uniform | 90 / 7 / 3 | all three, uniform | 0, 50, 150 | the coverage checks |

`--profile` defaults to running **all six**, 200 000 drops each. The whole suite
must finish in under **20 s** on a 2020-class laptop; if it does not, the roll
pipeline has allocated something it should not have.

### 10.2 The assertions

| # | Check | Tolerance | Severity |
|---|---|---|---|
| **R1** | Rarity distribution per profile matches §4.5 / the closed form | ±0.30 pp absolute for `unique`, ±1.0 pp for the rest | **fail** |
| **R2** | `nodrop` rate per treasure class matches the §5.3 table after rank scaling | ±0.8 pp | **fail** |
| **R3** | Affix-count histogram for rares matches §9.6 | ±1.0 pp per bucket | **fail** |
| **A1** | **No dead affix.** Every one of the 117 ids appears at least **25** times in the `sweep` profile | — | **fail**, prints every id at 0 |
| **A2** | **No dominant affix.** No single affix id exceeds **4.0 %** of all rolled `AffixInstance`s in `sweep` | — | **fail** |
| **A3** | Group exclusion: no item carries two affixes sharing an `AffixDefinition.group` | **zero** | **fail** |
| **A4** | `alvl` gate: no rolled affix has `alvl > item.ilvl` | **zero** | **fail** |
| **A5** | `maxLevel` gate: no rolled affix has `maxLevel < item.ilvl` | **zero** | **fail** |
| **A6** | `values.length === definition.mods.length` on every `AffixInstance` | **zero** | **fail** |
| **A7** | Every rolled value lies inside its mod's `[min, max]` and on its `step` lattice | **zero** | **fail** |
| **A8** | `sharedRoll` affixes have all `values` equal | **zero** | **fail** |
| **B1** | Every one of the 61 equipment bases appears at least **40** times in `sweep` | — | **fail**, prints the missing ids |
| **B2** | Base-group shares in `sweep` at `ilvl ≥ 27` match §1.3 | ±1.0 pp | **warn** |
| **L1** | **Every slot fillable by level N.** For `N ∈ {5, 10, 15, 20, 25, 30}`, running 400 drops at `ilvl = N` yields at least one `magic`-or-better item legal for each of the ten `SLOT` values | — | **fail**, prints `(N, slot)` pairs |
| **L2** | Every base's `reqStr ≤ classStartSTR + 3 × (min(30, reqLevel + 4) − 1)` for its intended class, and the same for `reqDex` | — | **fail** |
| **L3** | Advisory: `reqStr ≤ referenceSTR(min(30, reqLevel + 4)) + 20` under the `03-combat-math.md` §2.2 allocation | — | **warn** |
| **U1** | All **8** uniques appear at least **30** times in `sweep` | — | **fail** |
| **U2** | Unique share of all items in `sweep` matches §4.2 after the substitution of D6 | ±0.15 pp | **fail** |
| **G1** | Mean gold per pile per `mlvl` band is within ±2.0 % of `goldBase(mlvl) × RANK_GOLD` | ±2.0 % | **fail** |
| **G2** | Mean `itemValue` is non-decreasing across the four `mlvl` bands | strict | **fail** |
| **D1** | **Determinism.** Two runs at the same seed produce the same SHA-256 over the serialised item stream (`baseId,rarity,ilvl,affixIds,values` joined) | exact | **fail** |
| **D2** | Draw-count determinism: the number of RNG draws consumed per profile is identical across runs and matches the §9.2 accounting | exact | **fail** |
| **N1** | Every generated rare has a `nameOverride` of 2 or 3 words, and 3 exactly when `affixCount ≥ 5` | **zero** | **fail** |
| **N2** | Rare-name collision rate over the first 100 rares of `sweep` is below **75 %** (§3.5 predicts 69.4 %) | — | **warn** |

**A1 and A2 together are the "no dead affix" check.** A1 catches an affix whose
`requiresGroups` intersects nothing, whose `alvl` exceeds every reachable
`ilvl`, or whose weight is zero — the three ways an affix silently stops
existing. A2 catches the opposite failure: a weight typo that makes one affix
half the loot stream. Both are run on `sweep`, which is the only profile that
spans the whole `ilvl 1…40` range.

### 10.3 Failure output format

Human-readable by default, `--json` for CI. Exit code **1** on any `fail`, **0**
with a printed summary on `warn` only.

```
lootsim  seed=0x04c00751  drops=200000  profiles=6            FAILED (3)

  profile  mid   mlvl 11  Instruction  MF 25            200000 drops
  ─────────────────────────────────────────────────────────────────────
  R1  rarity distribution                                       FAIL
        rarity      observed     expected    delta    tol
        unique        0.412 %      0.311 %  +0.101   ±0.30    ok
        rare          4.981 %      2.230 %  +2.751   ±1.00    OVER
        magic        20.114 %     20.000 %  +0.114   ±1.00    ok
        superior     19.882 %     20.000 %  −0.118   ±1.00    ok
        normal       54.611 %     57.459 %  −2.848   ±1.00    OVER

  profile  sweep  ilvl 1..40  all tiers  MF 0/50/150     200000 drops
  ─────────────────────────────────────────────────────────────────────
  A1  no dead affix                                             FAIL
        3 of 117 affixes never rolled:
          sfx_max_res_fire_1     alvl 29  applies Ja As   w 4
          pfx_allskills_1        alvl 29  applies Ja ST   w 3
          sfx_fire_pierce_1      alvl 23  applies Wc Ja   w 10
        hint: highest ilvl reached in this profile was 40;
              eligible-pool size at ilvl 29 for `Ja` was 41 (weight sum 1204)

  L1  every slot fillable by level N                            FAIL
        (N=5, offHand)   0 magic+ in 400 drops   lowest reqLevel = 3   ok
        (N=5, amulet)    0 magic+ in 400 drops   lowest reqLevel = 6   UNREACHABLE

  B2  base-group shares at ilvl>=27                             warn
        weapon 31.4 % (expected 30.0 %, tol ±1.0)

  ─────────────────────────────────────────────────────────────────────
  22 checks passed · 3 failed · 1 warning · 4.81 s
```

Rules the format obeys:

1. **Every failure prints the offending data, not just the verdict.** A1 prints
   the affix ids *and* the pool size that explains them; L1 prints the lowest
   `reqLevel` in the slot so the fix is obvious from the output.
2. Failures are grouped by profile, in profile order, checks in table order.
3. A `warn` never changes the exit code but always prints.
4. `--json` emits `{ seed, drops, profiles: [{ name, checks: [{ id, status, observed, expected, tolerance, detail }] }], passed, failed, warned, seconds }`.
5. The seed is echoed in the first line of both formats so a failing CI run is
   reproducible by copy-paste.

### 10.4 What lootsim deliberately does not check

- **Whether an item is fun.** That is `tools/balance.mjs` (`03-combat-math.md`
  §11) and the M7 gate of a 2× TTK spread.
- **Icon generation.** It runs headless; there is no `OffscreenCanvas`. Icon
  determinism is covered by the pixel gate of `tools/imagediff.mjs`.
- **Container placement.** `findPlacement` is pure and is unit-tested in
  `src/items/__tests__`, not simulated.

---

## 11. Procedural icon content

`09-ui.md` §7 owns the icon *system*: the 64-px-per-cell resolution, the LRU
cache and its key, the primitive library of §7.2, the recipe selectors of §7.3,
the rarity framing of §7.4 and the overlays of §7.5. **None of that is
redefined here.** This section supplies the per-base content those recipes
consume: which recipe each base selects, which material ramp it uses, and the
parameter deltas that make a Bone Coif read differently from a Barbute.

### 11.1 Recipe assignment

Every base resolves to exactly one `09-ui.md` §7.3 recipe. The `surface` column
is the `ItemBase.surface` of §1.4–§1.6 and it is what picks the three-tone ramp
of §7.2.

| Base | Recipe | Surface | Parameter deltas, in §7.2 primitives |
|---|---|---|---|
| `axe_hand_normal` | `axe1h` | `metal` | head crescent span 30 px, no back-spike, `haft(112, 8, 5)` |
| `axe_battle_normal` | `axe1h` | `metal` | the reference recipe, unchanged |
| `axe_cleaver_exceptional` | `axe1h` | `metal` | crescent span 46 px, back-spike at 55 %, `haft(158, 10, 7)`, `wear(0.55)` |
| `axe_ruin_elite` | `axe1h` | `metal` | double-notched crescent (two 6 px bites out of the edge), spike at 70 %, `pommel(8,'claw')` |
| `sword_short_normal` | `sword1h` | `metal` | `blade(96, 11, 0.01)`, `guard(26, 5, 0.05)`, no fuller |
| `sword_rune_normal` | `sword1h` | `metal` | reference, plus 5 `gem(3, 4)` studs down the fuller at 18 px pitch |
| `sword_sigil_exceptional` | `sword1h` | `metal` | `blade(132, 14, 0.03)`, `guard(38, 7, 0.20)`, a 12 px `gem(6,6)` in the guard centre |
| `sword_verdict_elite` | `sword1h` | `metal` | `blade(138, 15, 0.04)`, guard swept to 0.30, `pommel(9,'hex')`, 3 hairline `wear` notches on the edge |
| `sword_great_exceptional` | `sword2h` | `metal` | reference, `haft` wrap bands 5, `pommel(10,'disc')` |
| `mace_flanged_normal` | `mace` | `metal` | four flanges, head `plate(38, 32, 0.40, rivets 4)` |
| `mace_censer_exceptional` | `mace` | `bone` | head replaced by `skullMask(38, 34)` over `plate(30, 26, 0.5, rivets 0)`, `chain(20,26,44,26,4)` hanging below the head |
| `hammer_edict_elite` | `mace` | `metal` | head `plate(46, 40, 0.25, rivets 8)`, one flat face and one 8 px `taper` claw, 4 carved rune ticks on the face |
| `maul_great_normal` | `mace` | `metal` | footprint 2×4; head `plate(52, 44, 0.30, rivets 6)`, `haft(190, 12, 9)` |
| `maul_ossuary_exceptional` | `mace` | `bone` | head is 3 stacked `skullMask(30, 26)` at 8 px offsets, `haft(196, 12, 10)` |
| `maul_anvil_elite` | `mace` | `metal` | head `plate(60, 52, 0.10, rivets 10)` — a literal anvil silhouette with a 14 px horn `taper` on the +x side |
| `polearm_reave_exceptional` | `spear` | `metal` | leaf head widened to 52 px, one lug replaced by a 16 px `taper` hook |
| `dagger_shard_normal` | `dagger` | `bone` | `blade(58, 9, 0.10)` with `wear(0.7)`, no guard, `haft(18, 5, 1)` |
| `dagger_kris_normal` | `dagger` | `metal` | wavy blade: `blade(70, 10, 0.18)` with the curve parameter driving 3 sine lobes |
| `dagger_scalpel_exceptional` | `dagger` | `metal` | `blade(74, 7, 0.02)` — very narrow — `guard(16, 3, 0)`, mirror-bright ramp (light tone at 60 % coverage) |
| `dagger_final_elite` | `dagger` | `metal` | `blade(78, 9, 0.05)`, `gem(5, 4)` in the pommel, 4 rune ticks along the spine |
| `wand_ember_normal` | `wand` | `bone` | reference: `haft(62, 8, 4, 'bone')`, `gem(7, 5)` tip, gem hue 22° (ember orange) |
| `wand_cinder_exceptional` | `wand` | `bone` | `haft(66, 9, 5)`, twin `gem(5, 5)` at the tip 6 px apart, hue 14° |
| `wand_grammar_elite` | `wand` | `bone` | `haft(68, 9, 7)` with 7 carved bands, tip is a 14 px open `ring(7, 3)` enclosing `gem(5, 6)`, hue 200° |
| `staff_ash_normal` | `staff` | `wood` | reference: 3 prongs, `gem(9, 6)`, hue from `iconSeed` |
| `staff_sermon_exceptional` | `staff` | `wood` | 4 prongs at 20 px, `gem(10, 6)`, a `cloth(18, 26, 3)` ribbon at the crown |
| `staff_silence_elite` | `staff` | `wood` | prongs replaced by a closed `ring(16, 4)` crown with `gem(11, 8)` suspended inside it by two 1 px chords |
| `shield_buckler_normal` | `shield` | `metal` | round: `plate(64, 64, 1.00, rivets 6)`, boss `ring(13, 5)`, no spine |
| `shield_targe_normal` | `shield` | `bone` | `plate(76, 100, 0.70, rivets 6)` with 4 `taper` rib strakes radiating from the boss |
| `shield_kite_exceptional` | `shield` | `metal` | reference heater, plus a 2 px vertical spine and a 10 px `gem(6, 5)` above the boss |
| `shield_tower_elite` | `shield` | `metal` | footprint 2×4; `plate(88, 160, 0.25, rivets 12)`, near-rectangular, 3 horizontal bands |
| `armour_rags` | `chest` | `ash` | `cloth(88, 118, 6)` only, no plate, `wear(0.9)`, 4 torn-hem notches at the bottom edge |
| `armour_quilted_normal` | `chest` | `flesh` | `plate(92, 124, 0.20, rivets 0)` overlaid with 6 horizontal quilt seams at 18 px pitch |
| `armour_robe_normal` | `chest` | `ash` | `cloth(94, 130, 5)` with a 10 px collar `plate(28, 14, 0.5, rivets 0)` and a rope belt line |
| `armour_scale_normal` | `chest` | `metal` | reference torso plus `scale(90, 108, 7, 6)` overlay |
| `armour_shroud_exceptional` | `chest` | `ash` | `cloth(94, 130, 7)` with a `gem(8, 6)` clasp, hue 20°, and 3 ember flecks (`gem(2,4)`) in the lower fold |
| `armour_plated_exceptional` | `chest` | `metal` | reference, `rivets 14`, twin pauldron `plate(28, 22, 0.6, rivets 3)` at the shoulders |
| `armour_litany_elite` | `chest` | `ash` | `cloth(96, 132, 8)` with 5 rows of 2 px script ticks down the centre panel |
| `armour_sepulchre_elite` | `chest` | `metal` | reference, `rivets 16`, a `skullMask(30, 26)` embossed at the sternum, heavy `grime(0.55)` |
| `helm_cap_normal` | `helm` | `flesh` | `skullMask` suppressed; a `cloth(66, 52, 4)` dome with a 4 px brow band |
| `helm_coif_normal` | `helm` | `bone` | reference `skullMask(76, 68)`, jaw line emphasised, 3 hairline cracks from the ramp |
| `helm_diadem_exceptional` | `helm` | `metal` | `skullMask` suppressed; `ring(32, 5)` circlet + 3 `taper` prongs 16 px + `gem(7, 6)` centred, hue 210° |
| `helm_barbute_exceptional` | `helm` | `metal` | `skullMask(78, 72)` with the eye voids narrowed to 2 px slits and a T-shaped face opening |
| `helm_gravemask_elite` | `helm` | `bone` | `skullMask(80, 74)`, 2 `taper` horns 22 px sweeping back, `cloth(22, 20, 3)` plume, `wear(0.6)` |
| `gloves_wraps_normal` | `gloves` | `flesh` | cuffs replaced by two `cloth(32, 48, 4)` wraps, no studs |
| `gloves_bracers_normal` | `gloves` | `flesh` | reference cuffs with 6 `gem(2, 4)` studs instead of 4 knuckle studs |
| `gloves_gauntlets_exceptional` | `gloves` | `metal` | reference, plus 3 finger `plate(6, 18, 0.4, rivets 0)` segments on the front cuff |
| `gloves_ordinance_elite` | `gloves` | `metal` | reference, `rivets 6`, a 10 px `gem(5, 6)` on the back of the front cuff |
| `boots_hide_normal` | `boots` | `flesh` | `boot(36, 56)` ×2, sole band 4 px, 3 lace ticks |
| `boots_greaves_normal` | `boots` | `bone` | `boot(38, 60)` ×2 with a `plate(20, 26, 0.5, rivets 3)` shin guard on the front boot |
| `boots_march_exceptional` | `boots` | `metal` | reference, sole band 6 px with 5 hobnail `gem(2,4)` studs |
| `boots_pilgrim_elite` | `boots` | `metal` | reference, plus a `chain(10, 44, 30, 44, 5)` ankle wrap and a `gem(4, 5)` at the cuff |
| `belt_sash_normal` | `belt` | `flesh` | `plate` replaced by `cloth(84, 26, 5)`, buckle replaced by a knot (two overlapping 10 px `taper`) |
| `belt_studded_normal` | `belt` | `flesh` | reference with 8 studs instead of 4 |
| `belt_plated_exceptional` | `belt` | `metal` | reference, buckle 18 px, plus two 12 px pouch `plate(12, 16, 0.5, rivets 2)` |
| `belt_ledger_elite` | `belt` | `metal` | reference, buckle is a 16 px `gem(7, 6)`, plus 4 rows of 1 px script ticks along the strap |
| `ring_iron` | `ring` | `metal` | `ring(20, 6)` with **no** gem, one 3 px facet notch |
| `ring_bone` | `ring` | `bone` | `ring(21, 7, gem(6, 5, hue 40°))`, 2 hairline cracks |
| `ring_gilt` | `ring` | `metal` | `ring(22, 6, gem(8, 8, hueFromSeed))`, light tone pushed to `#e8cf94` for gilding |
| `amulet_cord` | `amulet` | `flesh` | `chain` replaced by two 1 px cord arcs, pendant is a 16 px `taper` fang |
| `amulet_reliquary` | `amulet` | `metal` | reference `chain(12,8,52,8,9)`, pendant `plate(22, 24, 0.3, rivets 4)` with a 6 px `gem` window |
| `amulet_seal` | `amulet` | `metal` | `chain(12,8,52,8,11)`, pendant is a 22 px `gem(11, 8)` set in a `ring(12, 3)`, 5 rune ticks around the rim |
| `potion_life_*` | `potion` | `crystal` | `liquid` = life gradient `#8e1f22 → #d24a3c`; `fill` 0.62 / 0.70 / 0.78 / 0.86 by tier; the grand tier adds a 2 px gold neck band |
| `potion_mana_*` | `potion` | `crystal` | `liquid` = mana gradient `#1d3a86 → #4a86d8`; same `fill` ladder; grand adds the gold neck band |
| `potion_rejuvenation` | `potion` | `crystal` | `liquid` = a 50/50 vertical split of the two gradients with a 2 px `#c9a227` meniscus |
| `scroll_identify` | `scroll` | `wood` | sigil = an eye (`ring(7,2)` + a 4 px `gem` pupil) |
| `scroll_portal` | `scroll` | `wood` | sigil = a 3-turn spiral, 1.5 px stroke |
| `scroll_respec` | `scroll` | `wood` | sigil = a broken `chain(14,17,30,17,3)` with a 4 px gap at the centre link |
| `quest_first_tablet` | `quest` | `stone` | reference tablet, 5 rune rows, chipped lower-right corner, `grime(0.6)` |

### 11.2 Rules this section inherits and does not restate

- Every icon ends with `wear(0.4)`, `grime(0.35)`, `rim('#070605', 1)` in that
  order (`09-ui.md` §7.2). A delta above that raises `wear` replaces the 0.4,
  it does not add a second pass.
- The `−22°` rotation for weapons taller than they are wide, the `iconSeed` tint
  band (hue ±14°, value ±8 %), the rarity frame/glow/mark of §7.4 and the socket
  / unidentified / broken overlays of §7.5 are all applied by the shared
  pipeline. No base opts out.
- Determinism: every random value comes from an `Rng` forked from
  `ItemBase.iconSeed`, never from `ctx.rng` (`09-ui.md` §7.1). The `iconSeed`
  column of §1.4–§1.6 is therefore load-bearing data, not decoration, and the
  values are fixed forever — changing one changes every icon of that base.
- The 1.2 ms per-icon budget: the heaviest recipe here is
  `armour_sepulchre_elite` (torso plate + 16 rivets + embossed `skullMask` +
  `grime(0.55)`), measured against the budget in the M3 acceptance check of §12
  step 11.

### 11.3 Two selector gaps in `09-ui.md` §7.3

Reported rather than patched, because §7 is not this document's to edit:

1. The `mace` recipe's selector is `mace_`/`hammer_`. Three bases — the mauls —
   use the `maul_` prefix. **The selector needs `maul_` added**, or the four
   maul bases fall through to no recipe.
2. The `bow` recipe has **no base to consume it**. `03-combat-math.md` §4.1 is
   explicit that the player item set contains no bows and that the Ashen
   Archer's shot is a monster skill, not an item. The recipe should be kept
   (post-M9 content) but it is dead code today and `tools/lootsim.mjs` cannot
   exercise it.

---

## 12. Implementation order

Thirteen steps, inside milestone **M3** of `IMPLEMENTATION_PLAN.md` §9. Each is
independently verifiable and each acceptance check is a command, not a
judgement. No step depends on `three` before step 11.

| # | Step | Files | Acceptance check |
|---:|---|---|---|
| 1 | **Base tables.** All 75 `ItemBase` records: 61 equipment (§1.4–§1.6), `unarmed`, `quest_first_tablet`, 12 consumables (§8.1) | `src/items/data/bases.js` | `node tools/lootsim.mjs --validate-data` reports 75 records; every `id` unique; every `iconSeed` unique; `invW ∈ 1..2`, `invH ∈ 1..4`; `reqLevel ≤ 30`; every `surface` in `SURFACE`; every `allowedAffixGroups` entry in the §1.2 vocabulary |
| 2 | **Affix tables.** All 117 `AffixDefinition` records, one frozen array in declaration order | `src/items/data/affixes.js` | 117 records, 61 prefixes / 56 suffixes, 63 distinct `group` values; every `mods[].stat` is one of the 92 identifiers of `01-data-model.md` §3 (assert against a literal list); `alvl ≤ maxLevel` on every row; every `requiresGroups` entry in the §1.2 vocabulary |
| 3 | **Treasure classes.** The 16 monster classes, `tc_boss`, `tc_urn`, three chest classes, four potion sub-tables, two scroll sub-tables, plus `resolveTC` | `src/items/data/treasure.js` | every non-boss class's weights sum to exactly 1000; every `sub` id resolves; `resolveTC('tc_humanoid', n)` returns the §5.1 band for all `n ∈ 1..40` |
| 4 | **RNG plumbing and `rollQuality`.** The `items` fork taken once in `init()`; §4.1 verbatim | `src/items/rng.js`, `src/items/quality.js` | a counting `Rng` wrapper proves `rollQuality` consumes **exactly one** draw; 1 000 000 calls per §4.5 profile reproduce the three tables inside lootsim's R1 tolerance |
| 5 | **`rollItem` skeleton.** Base group draw, base draw, superior and defence rolls, `degrade()` | `src/items/roll.js` | lootsim checks **B1**, **B2** pass; `degrade` unit tests cover all five branches of §9.5 |
| 6 | **Affix rolling.** Count model §9.6, the §9.4 filter, value rolling, `sharedRoll` | `src/items/roll.js` | lootsim **A3–A8** and **R3** pass; a `sfx_res_all_1` roll produces six identical values from one draw |
| 7 | **Uniques.** The 8 records and the D6 substitution | `src/items/data/uniques.js` | lootsim **U1**, **U2** pass; all 8 appear at least 30 times in `sweep`; `ilvl 11` never produces a unique |
| 8 | **Rare naming.** Pools A/B/C and the §3.1 rule | `src/items/data/names.js` | lootsim **N1** passes, **N2** within the §3.5 prediction; 100 000 rares produce no `undefined` or empty word |
| 9 | **`rollDrop`.** TC entry pick, rank picks and `nodrop` scaling, gold, potion and scroll sub-tables, the unique-rank guarantee, ground scatter | `src/items/drop.js` | **the full six-profile `tools/lootsim.mjs` run is green** and completes in under 20 s. This is the M3 gate the plan names |
| 10 | **Containers and equipment.** `canPlace` / `place` / `autoPlace` / `findPlacement` / `remove` / `itemAt` / `sortContainer` / `splitStack`, the belt, `EquipmentSet`, `canEquip`, `equip` / `unequip`, cursor slot | `src/items/containers.js`, `src/items/equipment.js` | property tests: no cell ever holds two `uid`s; every item's rectangle is fully inside its grid; a two-hander refuses to equip without room for the displaced `offHand`; `sortContainer` is idempotent; `findPlacement` never mutates |
| 11 | **Icons.** The §11.1 recipe assignment on top of `09-ui.md` §7 | `src/items/icons/` | all 61 equipment bases × 5 rarities generate; p95 generation time ≤ **1.2 ms**, p100 ≤ 2.0 ms; `tools/imagediff.mjs` on a contact-sheet shot is pixel-identical across two runs |
| 12 | **Economy.** `itemValue` / `sellValue` / `buyValue`, `repairCost` / `repairAll`, durability accrual, `identify`, vendor stock and buyback | `src/items/economy.js`, `src/items/vendor.js` | the §7.3 worked table reproduces to the gold; a scripted town loop — stash 4, sell 3, buy a potion stack, repair all, identify 2 — leaves gold and container state equal to a hand-computed ledger (this is `09-ui.md` §15 step U12) |
| 13 | **Save round-trip.** Serialise exactly the fields `01-data-model.md` §5.3 lists, plus `uniqueValues`; `rebuildCache` on load | `src/items/serialise.js` | `tools/save-fuzz.mjs` round-trips 10 000 generated items with zero drift in `baseId`, `rarity`, `ilvl`, affix ids, values, `durability`; `01-data-model.md` §10.3 invariants 7, 8, 12 and 13 hold on every fixture |

Steps 1–9 are the critical path and have no dependency outside `src/items/data`.
Steps 10, 11 and 12 are parallelisable against each other. Step 11 is the only
one that touches a canvas, which is why it is late: the loot model must be
provably correct before a single pixel is drawn.

---

## 13. Additions folded into `02-api-contracts.md`

> **Status: applied.** Every method below is in `02-api-contracts.md` §11 and
> every data field in `01-data-model.md` §5 or `04`'s own §5.1. This section is
> kept as the rationale — it records why each had to exist and what the
> alternative would have cost — not as an open request.

### 13.1 `items` — §11

None of these moves ownership; each lives where the state already does.

| Method | Signature | Fixed | Alloc | Why |
|---|---|---|---|---|
| `resolveTC` | `(family:string, mlvl:int) => string` | Y | no | `MonsterArchetype.treasureClass` is a family id and the band comes from `mlvl` (§5.1). `ai` and `world` both need to resolve it before calling `rollDrop`, and duplicating the band table in two subsystems is exactly the drift `ARCHITECTURE.md` rule 9 exists to prevent. |
| `rollChest` | `(chest:object, rng:Rng, out:ItemInstance[]) => int` | Y | yes | `07-world-gen.md` §9.2 fixes chest contents at generation time from the chest's `S4` sub-seed. `rollDrop` draws from the `items` stream, which would make a chest's contents depend on how many monsters died first. This is the one entry point that must take an external `Rng`. |
| `rollGold` | `(mlvl:int, rank:string, goldFind:number, rng:Rng) => int` | Y | no | §7.1. `ai` emits the pile; `items` owns the formula. Without this the gold curve lives in `ai` and the loot harness cannot assert **G1**. |
| `itemValue` | `(item:ItemInstance) => int` | Y | no | `sellValue` and `buyValue` are both derived from it (§7.2), the tooltip's Value line (`09-ui.md` §5.1 block 14) shows it, and `01-data-model.md` §10.4 rule 9 credits a stripped item at it during a migration. Three callers of one formula. |
| `beltCooldown` | `(actor:Actor) => number` — seconds remaining | Y | no | §8.3's 0.5 s global cooldown. `09-ui.md` §4.3 draws a belt-slot sweep and has no way to ask. |
| `goldCap` | `(clvl:int) => int` | Y | no | §7.1. `player` enforces the cap on pickup and `ui` prints it; the number belongs with the rest of the economy. |
| `durabilityTick` | `(actor:Actor, kind:'attack'\|'hit'\|'block'\|'death') => void` | Y | no | §7.4. `combat` knows a hit landed; `items` owns the accumulator and the `stats:dirty` emit at 0. An event-only design would need `items` to listen to `actor:damage` for both roles and re-derive which side is which. |
| `rolledMods` | as `09-ui.md` §16.2 | Y | no | **Same request, restated, not a second one.** It is also how a unique's `uniqueValues` reach the tooltip. |
| `repairAllCost` / `repairAll` | as `09-ui.md` §16.2 | Y | no | Same request. §7.4 supplies the formula. |
| `currentStock` / `buyback` | as `09-ui.md` §16.2 | Y | no | Same request. §7.5 supplies the stock composition and the dedicated `Rng` fork. |

**Event table addition.** `items` must also **listen** to `actor:damage` — not
for durability (that is `durabilityTick`) but to reset the ground-item decay
grace period on the player, so an item dropped during a fight is not evicted by
`q.groundItemBudget` while the fight is still going.

### 13.2 `01-data-model.md` — four additive data fields

All four are additive with defined defaults, so **no `SCHEMA_VERSION` bump is
required** (`01-data-model.md` §10.4 rule 7). Three are on static tables and are
never serialised at all.

| Record | Field | Type / default | Why |
|---|---|---|---|
| `ItemBase` | `genderRu` | `'m' \| 'f' \| 'n' \| 'pl'`, default `'m'` | Russian prefix agreement (§2.5). Without it every magic item in Russian reads with a masculine adjective on a feminine noun. Static table only. |
| `AffixDefinition` | `sharedRoll` | `boolean`, default `false` | §2.4. One draw written to every entry of `values`, which is the precondition for `09-ui.md` §5.3's all-resistances merge. Static table only. |
| `TreasureClass` entry | `rarityFloor` | `null \| 'magic' \| 'rare'`, default `null` | §5.5 and §5.6. The unique-rank guarantee, the boss's rare-floor pick and `tc_urn`'s "6 % a magic base" all need it. Static table only. |
| `ItemInstance` | `uniqueValues` | `number[]`, default `[]` | **This one is serialised.** `01-data-model.md` §5.5 says a unique "rolls every mod in `mods`, each independently in its range" but §5.3 provides nowhere to store the results — `affixes` holds `AffixInstance`s keyed to `AffixDefinition`s, and a unique's mods are not affixes. `09-ui.md` §16.2 flags the same gap. `uniqueValues[i]` is positionally aligned with `UniqueDefinition.mods[i]`, exactly as `AffixInstance.values` is with `AffixDefinition.mods`. Adding it to the save's field list is a pure addition; an older save with `uniqueValues` absent defaults to `[]` and `rebuildCache` re-rolls nothing — it treats the unique as carrying its `min` values, which is the safe direction. |

---

## 14. Deviations and contradictions

### 14.1 Deviations from the plan and the binding documents

**D-1 — The base catalogue is 61 equipment bases, not a full tier grid.**
`IMPLEMENTATION_PLAN.md` §4.4 sketches three tiers (`normal` / `exceptional` /
`elite`) without fixing a count. A complete grid — 3 tiers × 10 slots × 2 class
lines — is 60 armour pieces before a single weapon, and `tools/lootsim.mjs`
check **B1** (every base seen 40 times in 200 000 drops) would start failing on
the thinly-weighted rows. 61 is the number at which every slot has at least
three tiers, both a melee and a caster line exist for `chest` and `head`, and
every row still carries enough weight to be seen.

**D-2 — The base is picked in two draws, not one.**
The plan's step 3 says "filter `reqLevel ≤ ilvl`, weighted by `dropWeight`",
which reads as a single weighted pick over the whole catalogue. With 61 bases of
wildly different slot counts that makes slot share an emergent property of
weights nobody can reason about — and it changes every time a base is added. §1.3
picks the **group** first from a table whose shares are stated in percent, then
the base inside it. Two draws, both weighted, both deterministic, and a
designer can now read "rings are 9 % of drops" straight off the table.
`ARCHITECTURE.md`'s order is preserved: this is still the `base` step, and it
still precedes `quality`.

**D-3 — A unique substitutes its own base.**
Rolling the base before the quality (which `ARCHITECTURE.md` requires) means a
unique bound to `axe_battle_normal` would need that exact base *and* a 0.25 %
quality roll — 0.006 % per item, or roughly one sighting per sixteen thousand
drops. Draw **D6** re-points `item.baseId` at the drawn unique's own base. The
draw order is unchanged; one conditional draw is added on the 0.25 % branch.

**D-4 — `ashen_crown` gains two mods.**
`01-data-model.md` §5.5 presents `ashen_crown` as the worked example of the
`UniqueDefinition` shape, with three mods. Shipped as written it is
`+22 % mana cost reduction and +20 fire resistance for −40 % life` — a trade no
player would ever take. Its id, name, `baseId`, `reqLevel`, `dropWeight`, lore
line and all three original mod ranges are reproduced **verbatim**; `+2 to Flame
Skills` and `+15..20 % Faster Cast Rate` are added so the item is worth the
downside it already carried.

**D-5 — `pfx_enhanced_damage_3.requiresGroups` is widened.**
The same §5.2 example declares `requiresGroups: ['weapon.melee']`. Enhanced
damage applies to every weapon in every game in the genre, and restricting the
middle tier of the family to melee would leave wands and staves with a hole at
`ilvl 8–19`. The id, `kind`, `group`, name `Keen`, `alvl 8`, `maxLevel 40`,
`weight 60` and the `enhancedDamage 30–50` range are all kept exactly;
`requiresGroups` becomes `['weapon.any']`. Likewise `sfx_attack_rating_2`'s
range is authored as `12–30` so that the example's `values: [15]` is a legal
roll.

**D-6 — Quality is one draw against a truncating ladder.**
The plan's step 4 reads as four successive rolls (unique, then rare, then magic,
then superior). Four draws per item is four times the RNG traffic in the hottest
loop of the loot pipeline and makes the draw-count assertion (**D2** in §10.2)
harder to reason about. The cumulative ladder of §4.1 is distributionally
identical for one draw. The truncation behaviour it produces at very high
multipliers — a Trial boss dropping nothing below magic — is a feature, and it
is stated rather than hidden.

**D-7 — Magic Find does not affect `superior`.**
`superior` is a base-quality roll, not a magic one. Letting MF push it would eat
the `normal` share, so a 200 %-MF character would see the *same* number of
non-magic items as a 0 %-MF one, just re-labelled. The rare and unique tiers
carry the D2 diminishing-returns hyperbola; `magic` is linear; `superior` is
flat.

**D-8 — The difficulty gold bonus enters only through `goldFind`.**
`03-combat-math.md` §10.2 grants "+40 % / +90 % gold find" per tier. §7.1
therefore has no difficulty term at all — adding one would double-count exactly
the way `03`'s own D-14 warns about for monster scaling.

**D-9 — Durability loss rates are defined here.**
No binding document says how durability is *spent*, only that it exists and that
repair exists. §7.4 fixes it: 1 per 12 landed attacks, 1 per 25 hits taken
round-robin over armour, 1 per 20 blocks on the shield, 8 % of maximum on
death. An item at 0 durability is not destroyed — it is `unusable`, which is the
trigger `01-data-model.md` §4.5 already lists.

**D-10 — A rare's name may be three words.**
See C-2 below. Two words is the D2 rule and it is what §3.1 does for 71 % of
rares; the epithet pool fires only at five or more affixes, which is exactly
when the item deserves a longer name.

**D-11 — Rings and shields have no unique.**
See C-1. Eight items cannot cover ten slots plus two extra weapons.

### 14.2 Contradictions found in the plan and the binding documents

**C-1 — The unique budget is arithmetically impossible.**
`IMPLEMENTATION_PLAN.md` §4.4 asks for "8 uniques: one per slot plus two
weapons". There are ten equipment slots (`01-data-model.md` §1.5), so one per
slot plus two weapons is twelve. §6 ships eight and leaves `ring1`/`ring2` and
`offHand` uncovered, with the reasoning in §6.10. **Someone should decide
whether the count or the coverage was the intent.**

**C-2 — The tooltip mock shows a three-part rare name.**
`09-ui.md` §5.1 renders `Doom Bane of the Legion` as the name line of a rare
Battle Axe. A two-word rare name — the D2 rule the plan's §4.4 states ("два
слова из отдельного пула") — cannot produce it. §3.1 reconciles the two by
appending an epithet only when `affixCount ≥ 5`; the mock's item shows five
rolled properties, so it is consistent with the shipped rule. Flagging it in
case the mock was meant literally and the rule was meant to be three words
always.

**C-3 — `07-world-gen.md` names a monster the bestiary does not have.**
The Bonereach `ZoneDescriptor` lists `hammerfell_brute` in its `bestiary` array.
`03-combat-math.md` §9.1 has six monster archetypes and no such id; the heavy
role is `maulsmith`. §5.2 assigns `tc_heavy` on the assumption that the two are
the same archetype under two names. **If `hammerfell_brute` is a real seventh
archetype it needs a bestiary row, and this document needs a treasure class for
it.**

**C-4 — Two gaps in the `09-ui.md` §7.3 icon selectors.**
The `mace` recipe selects on `mace_`/`hammer_` and misses the four `maul_`
bases; the `bow` recipe has no base at all, because `03-combat-math.md` §4.1
excludes bows from the player item set. Detail in §11.3.

**C-5 — `03-combat-math.md` §10.2 does not say whether monster `physicalResist`
is raised by difficulty.** The table column reads "Monster resists +20 / +40"
without qualification, while the surrounding prose discusses elemental
resistance and immunity only, and the rank table of §9.3 keeps "Phys resist" and
"Elem resists" as separate columns. §1.8's level-28 calibration assumes
**elemental only**; if physical is included, a level-28 melee character's
time-to-kill against a Renunciation Bone Ranker rises from 1.95 s to 3.25 s and
leaves the locked 1.5–3.0 s window.

**C-6 — `03-combat-math.md` §4.6 gives `staff_ash_normal` a 1×4 grid; the
`09-ui.md` §7.3 `staff` recipe is authored at 2×4.** Not a conflict — §7.3
already says other footprints scale the recipe's bounding box — but it means the
only `normal`-tier staff renders at half the width of its two exceptional and
elite siblings, which will look like a bug the first time someone sees it.
Recorded so nobody "fixes" the 1×4 that `03` fixed deliberately.

**C-7 — `01-data-model.md` §5.1's `axe_battle_normal.baseValue` is 220; the
§1.1 value formula yields 221.** The tables carry the authored integer. The
formula is documentation of how the numbers were generated, not something the
runtime evaluates, and `tools/lootsim.mjs` asserts the table, never the formula.
