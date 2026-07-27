# 13 — Progression, Quest, Lore and Text

**Owner:** `player` (`src/player/data/`), `ui` (`src/ui/i18n.js`)
**Consumers:** `ui`, `world`, `ai`, `items`, `save`
**Status:** specification, binding for narrative content and quest structure.

This document owns three things and nothing else: **the shape of the character's
climb**, **the quest that holds the act together**, and **every word the game
says out loud**. It restates no formula. The experience curve, the per-monster
experience award, the difficulty multipliers and the death penalty are settled
in `03-combat-math.md` §10 and are used here, never re-derived. The i18n
mechanism — key naming, interpolation, plural suffixes, fallback — is settled in
`09-ui.md` §14 and is used here, never redesigned.

English is canonical. Russian is a complete second dictionary, written to be
read as Russian rather than decoded as translation. Every string below has a
key, an English value and a Russian value.

---

## Table of contents

1. [The progression spine](#1-the-progression-spine)
2. [The quest system](#2-the-quest-system)
3. [The Word That Does Not Fade](#3-the-word-that-does-not-fade)
4. [Character creation](#4-character-creation)
5. [The lore bible](#5-the-lore-bible)
6. [Proper nouns](#6-proper-nouns)
7. [NPC dialogue](#7-npc-dialogue)
8. [Molgrim](#8-molgrim)
9. [The remaining dictionary](#9-the-remaining-dictionary)
10. [Naming pools](#10-naming-pools)
11. [Tone guide](#11-tone-guide)
12. [Implementation order](#12-implementation-order)
13. [Additions requested to `02-api-contracts.md`](#13-additions-requested-to-02-api-contractsmd)
14. [Cross-document requests and conflicts found](#14-cross-document-requests-and-conflicts-found)
15. [Deviations from the plan](#15-deviations-from-the-plan)

---

## 1. The progression spine

### 1.0 What this section proves

Four claims, each with the arithmetic that supports it:

| # | Claim | Where |
|---|---|---|
| P1 | One descent — town → Wastes → Bonereach → Altar → town — takes **20–40 minutes**. | §1.6 |
| P2 | The first Molgrim kill lands at **character level 13 against monster level 15**, which is exactly the fight `03-combat-math.md` §11.4 calibrates. | §1.4 |
| P3 | The Trial kill lands at **level 24** and the Renunciation kill at **level 30**, which are exactly the two experience samples `03-combat-math.md` §10.5 tabulates. | §1.4 |
| P4 | The three tiers chain into a loop that reaches the level cap in **≈ 12 descents / 5–7 hours** without a single grind step that yields nothing new. | §1.7 |

All three staged samples in `03-combat-math.md` §10.5 — Molgrim at clvl 13,
clvl 24 and clvl 30 — fall out of the spine below rather than being asserted
alongside it. That agreement is the acceptance test for this section, and
`tools/balance.mjs` asserts it at a fixed seed.

### 1.1 The reference run

Every figure in this section is computed against a **reference run**: an
explicit table of packs, because the generator's archetype weights are drawn at
runtime and a mean over the bestiary would hide where the experience actually
comes from. The reference run is the fixture `tools/fixtures/progression/`
`reference-run.json` and it is what `tools/balance.mjs` replays.

Sources, all binding, none restated:

- Monster counts, pack counts and elite rates: `07-world-gen.md` §8.1, §8.4, §8.6.
- `baseXp` per archetype and the rank multipliers: `03-combat-math.md` §9.1, §9.3.
- `xpMult(mlvl)`, `difficultyXpMult`, `levelPenalty`: `03-combat-math.md` §10.1, §10.2, §10.5.
- Zone monster levels **6 / 11 / 15**, **18 / 23 / 27**, **28 / 33 / 37**: `03-combat-math.md` §10.3.

#### Ashen Wastes — Instruction, 80 monsters in 10 packs

`xpMult(6) = 3.000`, `difficultyXpMult = 1.00`.

| # | Archetype | Count | Rank | `baseXp` | XP / normal | Pack XP |
|---|---|---:|---|---:|---:|---:|
| 1 | `carrion_swarm` | 10 | normal | 3 | 9 | 90 |
| 2 | `bone_ranker` | 6 | normal | 7 | 21 | 126 |
| 3 | `bone_ranker` | 8 | normal | 7 | 21 | 168 |
| 4 | `ashen_archer` | 8 | normal | 8 | 24 | 192 |
| 5 | `blight_crawler` | 8 | **champion** | 6 | 18 | 54 + 7×18 = 180 |
| 6 | `bone_ranker` | 8 | normal | 7 | 21 | 168 |
| 7 | `carrion_swarm` | 10 | normal | 3 | 9 | 90 |
| 8 | `ashen_archer` | 8 | normal | 8 | 24 | 192 |
| 9 | `dust_shaman` | 6 | **champion** | 12 | 36 | 108 + 5×36 = 288 |
| 10 | `bone_ranker` | 8 | **unique** | 7 | 21 | 126 + 7×31.5 = 346.5 |
| | | **80** | | | | **1 840.5 → 1 841** |

A `champion` pack is one champion (×3.0 XP) plus `count − 1` normals; a `unique`
pack is one unique (×6.0) plus `count − 1` minions (×1.5). That reading is fixed
by `01-data-model.md` §9.5 — `PackDescriptor.rank` is documented as *"ACTOR_RANK
of the pack leader"* — and by `07-world-gen.md` §8.4's escort rule.

#### Bonereach — Instruction, 69 monsters in 8 packs + 6 wanderers

`xpMult(11) = 5.800`.

| # | Archetype | Count | Rank | `baseXp` | XP / normal | Pack XP |
|---|---|---:|---|---:|---:|---:|
| 1 | `bone_ranker` | 8 | normal | 7 | 40.6 | 324.8 |
| 2 | `carrion_swarm` | 9 | normal | 3 | 17.4 | 156.6 |
| 3 | `ashen_archer` | 8 | normal | 8 | 46.4 | 371.2 |
| 4 | `bone_ranker` | 8 | **champion** (vault) | 7 | 40.6 | 406.0 |
| 5 | `maulsmith` | 8 | **champion** (vault) | 16 | 92.8 | 928.0 |
| 6 | `dust_shaman` | 8 | normal | 12 | 69.6 | 556.8 |
| 7 | `blight_crawler` | 7 | **champion** (dead end) | 6 | 34.8 | 313.2 |
| 8 | `bone_ranker` | 7 | **unique** (dead end) | 7 | 40.6 | 609.0 |
| — | wanderers: 3 `bone_ranker`, 3 `carrion_swarm` | 6 | normal | — | — | 174.0 |
| | | **69** | | | | **3 839.6 → 3 840** |

#### Altar of Instruction — Instruction, 8 approach monsters in 2 packs

`xpMult(15) = 8.616`. The arena rolls `uniqueChance: 0`.

| # | Archetype | Count | Rank | XP / normal | Pack XP |
|---|---|---:|---|---:|---:|
| 1 | `bone_ranker` | 4 | **champion** | 60.3 | 180.9 + 3×60.3 = 361.8 |
| 2 | `ashen_archer` | 4 | normal | 68.9 | 275.6 |
| | | **8** | | | **637.4 → 637** |

#### Molgrim

`900 × xpMult(mlvl) × difficultyXpMult`, no rank multiplier (`boss` = 1.0):

| Tier | mlvl | XP |
|---|---:|---:|
| Instruction | 15 | **7 754** |
| Trial | 27 | **21 747** |
| Renunciation | 37 | **43 399** |

These reproduce `03-combat-math.md` §10.5's three boss rows exactly.

#### The other two tiers

Counts scale by `tierDensityMul` (1.00 / 1.10 / 1.20, `07-world-gen.md` §8.6);
elite rates scale by `champChance ×1.35 / ×1.70` and `uniqueChance ×1.30 /
×1.60`, which adds one champion pack per zone at Trial and two at Renunciation.
The full pack tables are in the fixture; the totals are:

| Zone | Instruction | Trial | Renunciation |
|---|---:|---:|---:|
| Ashen Wastes | 80 mon · **1 841** | 88 mon · **8 893** | 96 mon · **22 996** |
| Bonereach | 69 mon · **3 840** | 76 mon · **13 628** | 83 mon · **32 145** |
| Altar approach | 8 mon · **637** | 9 mon · **1 957** | 9 mon · **3 906** |
| **Field total, pre-boss** | **6 318** | **24 478** | **59 047** |
| Molgrim | 7 754 | 21 747 | 43 399 |

### 1.2 The opening ramp

A level-1 character cannot fight a level-6 monster. The to-hit term
`alvl/(alvl+dlvl)` of `03-combat-math.md` §5.1 is `1/7 = 0.143` at that gap, so
a Ravager with a Hand Axe (AR 135) against a Bone Ranker at mlvl 6 (DEF 45) hits
`200 × 135/180 × 0.143 = 21.4 %` of the time, needs 6 landed hits through 53
life, and therefore spends **≈ 20 seconds killing one trash monster**. That is
not a pacing problem, it is an unplayable one, and it exists because the act has
one open zone doing the work Diablo II spread over five.

The fix is an **opening ramp** applied to `PackDescriptor.mlvl` — a field that
already exists per pack, so nothing changes shape. It is keyed to the BFS
distance field `pathDistanceFromEntry` that `07-world-gen.md` §8.5 already
computes for the safety radius, so it costs one table lookup per pack at
generation time.

```js
// src/player/data/progression.js
export const OPENING_RAMP = Object.freeze({
  zoneId: 'ashen_wastes',
  tier: 'instruction',
  activeWhile: (q) => q.word_unquenched.step <= 1,   // first visit only
  bands: [ { maxPathMetres: 30, mlvl: 2 },
           { maxPathMetres: 55, mlvl: 4 },
           { maxPathMetres: Infinity, mlvl: 6 } ],
  bandAArchetypes: ['carrion_swarm', 'bone_ranker'],
});
```

Three properties make this safe rather than a special case:

1. **It switches itself off.** The moment the player first reaches Bonereach the
   quest is at step 2, the predicate is false, and every later Wastes run — the
   ones the spine actually counts on for experience — spawns at the descriptor's
   full mlvl 6. There is no permanent easy zone.
2. **Band A excludes the two archetypes that one-shot a level-1 character.**
   A `blight_crawler` detonating for `(8–14) × damageMult(2)` is 10–17 damage
   against a 55-life Ravager; four of them is a corpse before the first potion
   finishes. Band A fields only Carrion Swarms (11 life at mlvl 2) and small
   Bone Ranker groups.
3. **It is arithmetic, not feel.** At clvl 1 versus mlvl 2 the same Ravager hits
   `200 × 135/158 × 1/3 = 57.0 %`, kills a 25-life Bone Ranker in 3 landed hits,
   and therefore in **3.8 s** — inside the locked 1.5–3.0 s band once the second
   attribute point lands.

The ramp costs experience: the ramped Wastes yields **1 559** instead of 1 841.
That cost is paid once, on the first descent, and §1.4 accounts for it.

### 1.3 Quest experience

Field experience alone puts the first Molgrim kill on descent six. The quest
closes the gap, front-loaded so that it arrives when a new character is thinnest.

| Step completed | XP | Why here |
|---|---:|---|
| Step 2 — cross the gate into the Ashen Wastes | **600** | Levels 1 → 3 in one grant. Two attribute allocations before the first real pack. |
| Step 3 — reach Bonereach | **3 400** | The sharpest difficulty step in the game: mlvl 6 → 11 in one doorway. The grant carries the player from level 5 to level 7 on the threshold. |
| Step 4 — stand before the Altar | **4 000** | Levels 8 → 9. Enough to survive the approach packs at mlvl 15 and read the room before dying to it. |
| Step 7 — return to Kaira and claim | **2 000** | After the kill. Pays the tier transition, not the fight. |

Step numbers are §3.2's. Accepting the quest (step 1) pays nothing, so a player
who accepts and then spends ten minutes shopping does not level up in a shop.

Pre-boss quest total **8 000**, which is **24.6 %** of the 32 493 experience a
character holds when they first walk into the arena at level 13. Three quarters
of the climb is still monsters, which is the right ratio: quest experience should
smooth the two cliffs (level 1, and the Bonereach doorway) and nothing else.

Awards are **once per character**, guarded by the quest's own `step` field — a
step never fires twice because `advanceQuest` is monotonic (§2.3).

### 1.4 The Instruction tier, descent by descent

Level thresholds from `03-combat-math.md` §10.4. Level penalty from §10.5:
`clvl − mlvl ≤ 4 → 1.0`, else `max(0.05, 1 − 0.09 × (clvl − mlvl − 4))`.

| Descent | Wastes | Bonereach | Altar | Quest | Descent XP | Cumulative | Level after |
|---|---:|---:|---:|---:|---:|---:|---:|
| **1** | 1 559 *(ramped)* | 3 840 | 637 | 8 000 | 14 036 | 14 036 | **9** |
| **2** | 1 841 | 3 840 | 637 | — | 6 318 | 20 354 | **11** |
| **3** | 1 675 *(×0.91)* | 3 840 | 637 | — | 6 152 | 26 506 | **12** |
| **4** | 1 510 *(×0.82)* | 3 840 | 637 | — | 5 987 | **32 493** | **13** |

`XP_TOTAL(13) = 31 977`. The character crosses it **on the Altar approach packs
of the fourth descent** and fights Molgrim at level 13 against mlvl 15 — the
exact staging of `03-combat-math.md` §11.4, which gives 76.1 / 63.9 / 86.0 s and
lands inside the locked 60–90 s window.

Within-descent levels, first descent and fourth:

| Moment | Descent 1 | Descent 4 |
|---|---|---|
| leave Last Bastion | 1 | 12 |
| enter the Ashen Wastes (+ step 1) | 3 | 12 |
| leave the Ashen Wastes | 5 | 12 |
| enter Bonereach (+ step 2) | 7 | 12 |
| leave Bonereach | 8 | 12 |
| enter the Altar (+ step 3) | 9 | 12 |
| face Molgrim | 9 — and die | **13** |

Descents 1–3 end at the arena door or on its floor. That is intentional and it
is the same shape as every Act I in the genre: the boss room is found long before
the boss is beaten, and the three failed approaches are where the character's
gear is actually assembled. A level-9 character walking into a 3 091-life boss
whose sweep deals `16–30 × 5.55 × 2.2 = 196–367` against their ~120 life learns
the answer in nine seconds and pays a 5 % death penalty for it.

After the kill and the turn-in: `32 493 + 7 754 + 2 000 = 42 247` → **level 14**,
`+1 to all skills` permanently, one of three items, and **Trial** unlocked.

### 1.5 Trial and Renunciation

**Trial**, entered at level 14. Zone levels 18 / 23 / 27 — the character is
fighting *up* for the whole tier, so the level penalty is 1.0 until level 23.
Player elemental resistances take a flat **−40** (`03-combat-math.md` §10.2),
which is what makes one of the three quest reward items the correct pick (§3.5).

| Descent | Field XP | Cumulative | Level after |
|---|---:|---:|---:|
| 1 | 24 478 | 66 725 | 16 |
| 2 | 24 478 | 91 203 | 18 |
| 3 | 24 478 | 115 681 | 20 |
| 4 | 24 478 | 140 159 | 22 |
| 5 | 24 078 *(Wastes ×0.91 near the end)* | 164 237 | 23 |
| **6** | 23 322 *(Wastes ×0.87 mean)* | **187 559** | **24** |

`XP_TOTAL(24) = 173 565`, crossed inside Bonereach on descent 6. Molgrim is
fought at **level 24 against mlvl 27** — `03-combat-math.md` §10.5's second
staged sample. After the kill: `187 559 + 21 747 = 209 306` → **level 25**, and
**Renunciation** unlocks.

**Renunciation**, entered at level 25. Zone levels 28 / 33 / 37, elemental
resistances **−100**, monster resists +40, monster life ×1.35.

| Descent | Field XP | Cumulative | Level after |
|---|---:|---:|---:|
| 1 | 59 047 | 268 353 | 28 |
| **2** | 59 047 | **327 400** | **30 — cap** |

`XP_TOTAL(30) = 317 106`, crossed inside Bonereach on descent 2. Molgrim is
fought at **level 30 against mlvl 37** — the third staged sample. All three
land.

### 1.6 Time, and the 20–40 minute claim

Combat time is taken from the calibrated time-to-kill figures of
`03-combat-math.md` §11.2–11.4: 2.26 s for a normal, 10.2 s for a champion,
22.6 s for a unique, 76 s for the boss, all at the reference build. To each pack
add 10 s of approach, repositioning and the tail of a scattered swarm.

| Segment | Fighting | Traversal and loot | Total |
|---|---:|---:|---:|
| Last Bastion — equip, identify, repair, stash, sell | — | 2.5 min | **2.5** |
| Ashen Wastes — 10 packs, 80 monsters, 3 chests | 4.6 min | 2.4 min | **7.0** |
| Bonereach — 8 packs + 6 wanderers, 69 monsters, 5 chests | 4.4 min | 3.6 min | **8.0** |
| Altar approach — 2 packs, 8 monsters | 0.8 min | 0.7 min | **1.5** |
| Molgrim | 1.3 min | — | **1.3** |
| Return, sell, identify, claim | — | 2.7 min | **2.7** |
| | | | **23.0 min** |

Traversal: the Wastes ridgewalk spine plus two or three dead-end branches is
≈ 190 m at 4.2 m/s (45 s) plus ≈ 90 s of stopping to pick things up. Bonereach's
12–18 rooms are ≈ 280 m (65 s) plus ≈ 150 s at five chests and the loot they
scatter. Both are ceilings, not means — a player who skips a dead end saves
90 seconds and one champion.

| Tier | Monsters per descent | Descent time | Field XP / hour |
|---|---:|---|---:|
| Instruction | 157 | **20 – 28 min** | ≈ 16 500 |
| Trial | 173 | **24 – 34 min** | ≈ 52 400 |
| Renunciation | 188 | **28 – 40 min** | ≈ 110 800 |

Every tier sits inside the locked 20–40 minute window, and the hourly rate
roughly triples at each step up — which is the entire argument for taking the
step. A player who refuses to move up and farms Instruction at level 25 earns
`6 318 × 0.05 = 316` experience per descent, because the level penalty floors at
0.05. Refusing the ladder is not a strategy; it is a stop.

### 1.7 The replay loop and the level cap

```
        ┌──────────────── Last Bastion ────────────────┐
        │  Veren: sell, repair, buy potions            │
        │  Isa: identify                               │
        │  Stash Keeper: bank what the next tier needs │
        │  Kaira: quest state, difficulty              │
        └───────────────────┬──────────────────────────┘
                            │  gate  (runIndex += 1, new seed)
             ┌──────────────▼───────────────┐
             │  Ashen Wastes    mlvl 6/18/28│
             └──────────────┬───────────────┘
                            │  descent
             ┌──────────────▼───────────────┐
             │  Bonereach       mlvl 11/23/33│
             └──────────────┬───────────────┘
                            │  Gate of Instruction  (quest step ≥ 2)
             ┌──────────────▼───────────────┐
             │  Altar           mlvl 15/27/37│
             │  Molgrim                     │
             └──────────────┬───────────────┘
                            │  arena exit portal (opens on bossDefeated)
                            └──► Last Bastion  ──► tier up when unlocked
```

Each descent draws a fresh layout: `seed = hash(worldSeed, zoneId, runIndex)`
and `runIndex` increments per zone per entry (`01-data-model.md` §10.2). The
difficulty tier is **not** part of the seed (`07-world-gen.md` §8.6), so the same
`runIndex` produces the same map with a heavier population — a player who learned
descent 3's layout can re-walk it on Trial and feel the difference in the
monsters rather than in the geography.

**Tier selection** is made in Last Bastion only, through Kaira, and only among
`difficultyUnlocked`. Changing tier resets nothing: the character keeps level,
items, stash, gold and quest state.

**At level 30** (`XP_TOTAL(30) = 317 106`):

| Behaviour | Rule |
|---|---|
| Experience | Accrues to the counter but `experience` is clamped at `XP_TOTAL(30)`. The XP bar renders full and shows `hud.maxLevel` in place of the progress fraction. |
| Attribute / skill points | No further awards. 145 attribute points and 29 skill points is the whole budget; `save` invariants #3 and #4 keep it exact. |
| Death penalty | **Zero, by arithmetic.** `03-combat-math.md` §10.6 computes `experience = max(XP_TOTAL(clvl), experience − loss)`; at clvl 30 with `experience === XP_TOTAL(30)` the `max` returns the floor unchanged. No special case in the code. |
| Progression | Moves entirely into items. The magic-find, gold-find and item-level curves of Renunciation are the whole of the endgame, and the `+1 to all skills` from the quest is already banked. |
| Message | `banner.maxLevel` fires once, on the level-up that reaches 30, and never again. |

---

## 2. The quest system

### 2.1 Scope

One quest ships. The system is built for more because a quest table with one row
and a quest table with six rows cost the same, and because `save`'s `quests`
object is already a map keyed by quest id (`01-data-model.md` §10.2).

### 2.2 Data model

```js
// src/player/data/quests.js — plain objects, no imports, Node-loadable.

const QuestDefinition = {
  id:          'word_unquenched',     // the key in CharacterSave.quests
  giverNpcId:  'kaira',
  turnInNpcId: 'kaira',
  order:       0,                     // sort order in the quest log
  available:   { minLevel: 1, requiresQuest: null, requiresState: null },
  steps:       [ /* QuestStep[], index 1..N, in order */ ],
  reward: {
    xp:            2000,
    gold:          0,
    skillsAll:     1,                 // the permanent +1 to all skills
    choiceUniques: ['unlearned_edge', 'ashmantle', 'second_syllable'],
    once:          true,              // guarded by CharacterSave.questSkillPointsGranted
  },
  // i18n: quest.<id>.name | .summary | .reward | .step.<n> | .step.<n>.done
};

const QuestStep = {
  index:      2,
  trigger: {
    kind:   'enterZone',              // see the trigger table below
    zoneId: 'bonereach',
  },
  xp:         3400,                   // awarded once, on the transition into this step
  setsFlags:  { reachedBonereach: true },
  autoAdvance: true,                  // false => the step waits for a dialogue node
  tracked:     true,                  // shows in the HUD tracker
};
```

**Trigger kinds — the complete set.** Six kinds; nothing else is legal, and
`player.advanceQuest` throws in dev builds on an unknown kind.

| `kind` | Fields | Fires on | Producer |
|---|---|---|---|
| `talk` | `npcId`, `nodeId` | the player selects a dialogue node with `advancesQuest: true` | `ui` → `player.advanceQuest` |
| `enterZone` | `zoneId` | `zone:ready` with a matching `zoneId` | `world` event, consumed by `player` |
| `kill` | `archetypeId` \| `flag: 'boss'`, `count` | `actor:death` matching the predicate; `count` accumulates in `flags` | `combat` event |
| `interact` | `interactableId` | `Intent.interactId` resolves to a matching `Interactable` | `player` |
| `itemHeld` | `baseId`, `count` | evaluated on `loot:pickup` and on panel open | `items` event |
| `questState` | `questId`, `state` | another quest reaches a state — unused by the shipped quest, present for the table's completeness | `player` |

**States** are exactly the five in `01-data-model.md` §10.2 and the transitions
are a strict chain:

```
unavailable ──► available ──► active ──► complete ──► rewarded
                  (giver in    (accepted)  (last step  (reward
                   the world)              done)        claimed)
```

| State | Meaning | Log appearance |
|---|---|---|
| `unavailable` | The giver exists but will not offer it. Never reached by the shipped quest. | hidden |
| `available` | Offered. `step === 0`. | not listed |
| `active` | Accepted; `step ∈ 1..5`. | `quests.active` |
| `complete` | Every step done; the reward is waiting at the turn-in NPC. | `quests.complete` |
| `rewarded` | Reward taken. Terminal. | `quests.rewarded` |

### 2.3 Runtime rules

1. **`advanceQuest(questId, step)` is monotonic.** A call with `step <=
   current.step` is a no-op and returns without emitting. This is what makes the
   step experience awards idempotent under event replay, and it is the reason
   there is no separate "already granted" bitfield.
2. **Every state or step change emits `quest:update { questId, state, step }`
   exactly once**, from `fixedUpdate`, after the flags are written. `ui` derives
   nothing from it except a banner and a tracker refresh — the tracker's content
   comes from `player.questTracker(out)` (`09-ui.md` §16.4).
3. **Every step change requests an autosave.** `01-data-model.md` §10.4 rule 10
   already lists "quest step" as an autosave trigger.
4. **Quest experience is granted through `player.grantXp(amount, 0)`**, source id
   `0` meaning "not a kill". It therefore respects `experienceGain` from items,
   and it is never scaled by `levelPenalty` — there is no monster level to
   compare against.
5. **Quest state is per character, never per stash.** Two characters in the same
   save file run the quest independently.

### 2.4 Save representation

The shipped shape in `01-data-model.md` §10.2 is used unchanged except for two
optional flags, which is a **default-filled addition and therefore not a schema
version bump** (§10.4 rule 7):

```js
quests: {
  word_unquenched: {
    state: 'active',              // the five-state enum
    step:  3,                     // int 0..6
    flags: {
      tabletTaken:  false,        // shipped
      molgrimSlain: false,        // shipped
      slainOn: {                  // ADDED — default { instruction:false, trial:false, renunciation:false }
        instruction: false, trial: false, renunciation: false,
      },
      rewardChoice: -1,           // ADDED — default -1; index into reward.choiceUniques
    },
  },
},
questSkillPointsGranted: 0,       // shipped; 0 or 1. Guards the permanent +1.
```

`save.validate()` gains two invariants, numbered to continue
`01-data-model.md` §10.3:

| # | Invariant |
|---|---|
| 16 | `quests.<id>.state` is one of the five; `step ∈ 0..definition.steps.length`; `state === 'rewarded'` implies `step === steps.length` and `flags.rewardChoice ∈ 0..2`. |
| 17 | `questSkillPointsGranted ∈ {0,1}` and equals 1 **iff** some quest has `state === 'rewarded'` with `reward.skillsAll > 0`. A save that claims the reward twice fails here, loudly, rather than shipping a `+2 to all skills` character. |

Invariant 17 is the anti-cheat for the single most valuable object in the game.

### 2.5 Where the reward's `+1 to all skills` lives

It is **not** a skill point and **not** an item. It is a contribution to
`skillBonuses.all` on the `quest` stat layer, exactly as
`01-data-model.md` §6.2 describes: *"`skillBonuses.all += 1` from the quest
reward."* Consequences that follow and must not be re-litigated:

- It raises **effective** skill level, never allocated level. A skill with zero
  points allocated stays unusable at effective level 1 — the bonus does not
  unlock skills.
- Synergies read **allocated** levels (`03-combat-math.md` §8.7), so the +1 does
  not compound quadratically through the synergy web.
- It survives a respec scroll. Skill points come back; the quest reward does not
  go away.
- It is applied once, ever, per character, across all three difficulties.

---

## 3. The Word That Does Not Fade

### 3.1 The premise in one paragraph

Kaira the Instructress wants the **First Tablet** — the only written copy of the
lesson that burned the world. She does not want it destroyed. She wants it
*finished*: a sentence that was never completed is still being spoken, and the
ash is the speaking. Molgrim stands at the lectern where he left off. The player
is the interruption.

### 3.2 Steps — complete

`questId: word_unquenched`. Seven steps. `step: 0` means available and
unaccepted; `step: 7` is terminal.

| Step | i18n key | Trigger | Completion condition | Flags set | XP | Tracked |
|---:|---|---|---|---|---:|---|
| **1** | `quest.word_unquenched.step.1` | `talk` — `kaira` / `kaira.offer.accept` | The player selects the accept node. `state → active`. | — | 0 | ✔ |
| **2** | `.step.2` | `enterZone` — `ashen_wastes` | `zone:ready { zoneId: 'ashen_wastes' }`. | `reachedWastes` | 600 | ✔ |
| **3** | `.step.3` | `enterZone` — `bonereach` | `zone:ready { zoneId: 'bonereach' }`. | `reachedBonereach` | 3 400 | ✔ |
| **4** | `.step.4` | `enterZone` — `altar_of_instruction` | `zone:ready { zoneId: 'altar_of_instruction' }`. | `reachedAltar` | 4 000 | ✔ |
| **5** | `.step.5` | `kill` — `flag: 'boss'`, `count: 1` | `actor:death` where `actor.flags & ACTOR_FLAG.boss`. | `molgrimSlain`, `slainOn[difficulty]` | 0 — the boss award is the award | ✔ |
| **6** | `.step.6` | `interact` — `altar_tablet` | The player clicks the altar block after `molgrimSlain`. `state → complete`. | `tabletTaken` | 0 | ✔ |
| **turn-in** | `.step.7` | `talk` — `kaira` / `kaira.turnin.claim` | A reward choice is confirmed. `state → rewarded`. | `rewardChoice` | 2 000 | ✔ |

Numbering note: steps 1 and 2 are separate because accepting the quest and
crossing the gate are separate player actions and the tracker must be able to
say *"Speak to Kaira"* → *"Cross the gate"*. The 600 XP rides on step 2 so that
a player who accepts and then spends ten minutes in town does not level up in a
shop. `steps.length === 7`; `step === 7` is the terminal value and satisfies
invariant 16.

### 3.3 Gating

**The Gate of Instruction** — the `stair` exit at the deepest point of Bonereach,
`toZone: 'altar_of_instruction'`, `toEntryTag: 'gate'`.

| Condition | Gate |
|---|---|
| `quests.word_unquenched.step < 3` | **Sealed.** The arch is there, lit, and refuses. Prompt: `prompt.gateSealed`. |
| `step >= 3` | Open. |

Fiction: Kaira gives the player the **Cinder Sigil** when the quest is accepted —
not an inventory item, a mark. The gate does not read strangers. Mechanically it
prevents a character who skipped the giver from reaching a 3 091-life boss at
level 4, and it costs one boolean.

Implementation: `world.setExitSealed('bonereach', 'gate', sealed)` (§13), called
by `player` on `quest:update` and on `zone:ready`. `world` already listens to
`quest:update` (`02-api-contracts.md` §5).

**The arena exit portal** at `(0, −13)` is closed until `bossDefeated`
(`07-world-gen.md` §5.2) — that is `world`'s rule and this document does not
touch it. The quest reads it, it does not set it.

**Difficulty unlock:**

| Tier | Unlocks when |
|---|---|
| `instruction` | always, from character creation |
| `trial` | `quests.word_unquenched.state === 'rewarded'` **and** `flags.slainOn.instruction === true` |
| `renunciation` | `flags.slainOn.trial === true` |

The two conditions on Trial are not redundant: the reward can only be claimed
after a kill, but the *kill* is what `slainOn` records per tier, and
Renunciation needs the Trial kill without a second turn-in. `player.setDifficulty`
refuses a tier outside `difficultyUnlocked` and returns `false`; `ui` renders the
row with `difficulty.locked` and the reason.

### 3.4 The tracker

`player.questTracker(out)` (requested by `09-ui.md` §16.4) fills:

```js
{ questId: 'word_unquenched', state: 'active', stepCount: 7,
  steps: [ { key:'quest.word_unquenched.step.1', done:true,  have:1, need:1 },
           …
           { key:'quest.word_unquenched.step.7', done:false, have:0, need:1 } ],
  rewardKeys: ['quest.word_unquenched.reward'] }
```

The HUD tracker shows the **current** step plus the two around it; the quest log
shows all seven with the `✔ / ▸ / ○` markers of `09-ui.md` §3.5.

### 3.5 The three reward items

All three are `unique` rarity, generated at `ilvl 15` on Instruction (the mlvl of
the Altar, so their rolls scale with where they were earned), identified on
grant, and delivered straight to the inventory — refused with
`container.inventoryFull` if there is no room, and held by Kaira until there is.

The choice is made once and is permanent. It is offered at level 13, at the exact
moment the character is about to cross into Trial and eat a **−40 to every
elemental resistance**. That is the fact the three options are designed around,
and it is why the correct answer is not obvious.

| # | Name (EN / RU) | Slot | Mods | Who it is for | Why it is a real choice |
|---:|---|---|---|---|---|
| 1 | **The Unlearned Edge** / **Клинок Неучёного** | one-hand axe (`axe_battle_normal` base) | `+55–75 % enhancedDamage`, `+30–50 attackRating`, `+4–7 % lifeSteal`, `+1 to Carnage skills` | Ravager, Runeblade | Trial monsters carry **+20 to every resistance** but nothing to physical. Physical damage is the only school that does not lose 20 points at the tier change, and `lifeSteal` is computed on post-mitigation physical (`03-combat-math.md` §6.2 R14d), so this item scales with itself. |
| 2 | **Ashmantle** / **Пепельная мантия** | chest | `+80–120 defense`, `+25–30 allResist`, `+20–30 % fasterHitRecovery`, `+15–25 maxLife` | any class | The −40 answer. It moves a bare character from −40 to −10 in every element on the first Trial descent, which is a **30 % reduction in every elemental hit taken**. The FHR shortens hit recovery from 0.400 s to 0.308 s (§7.11's table), and hit recovery is what kills characters in packs. |
| 3 | **The Second Syllable** / **Второй слог** | amulet | `+2 to one tree's skills` (the tree with the most allocated points at the moment of the grant), `+25–40 maxMana`, `+15–20 % fasterCastRate`, `+10–15 % manaRegenPercent` | Emberwright, Runeblade | `03-combat-math.md` §11.4 shows the Emberwright finishing Molgrim *"with an empty belt"* — 602 mana needed against 605 available. `+2` skill levels on the damage tree is roughly a 12 % damage increase per cast, and the mana pool and regeneration are the exact resource the calibrated boss fight runs out of. |

The justification in one line: **one item makes you hit harder, one makes you
survive the tier change, one fixes the resource problem the calibration already
proved exists.** No class has a strictly correct pick — a Ravager who intends to
farm Renunciation takes Ashmantle over the axe, and an Emberwright who already
found a resistance chest takes the amulet.

`+2 to one tree` binds at grant time and never re-binds; `items` records the
chosen `treeId` in the `ItemInstance`'s unique roll data so a respec cannot move
it. That is stated here because it is a narrative-facing rule the player must be
told: `unique.second_syllable.lore` says so in as many words.

### 3.6 What the player sees, end to end

```
town   Kaira offers        → quest.available   → banner "Quest Updated"
       accept              → step 1, active    → tracker appears
gate   enter the Wastes    → step 2  +600      → toast "+600 XP"
zone   descend             → step 3  +3 400    → banner "Quest Updated"
zone   pass the Gate       → step 4  +4 000    → banner "Quest Updated"
arena  Molgrim dies        → step 5            → banner "Quest Updated", boss XP
altar  take the Tablet     → step 6, complete  → banner "Quest Complete"
town   return to Kaira     → reward screen     → choose one of three
                           → step 7, rewarded  → banner "+1 to All Skills"
                           → banner "Trial Unlocked"
```

---

## 4. Character creation

### 4.1 What the screen must say

`09-ui.md` §3.5 fixes the layout: three cards on the left, a `uiScene` preview in
the middle, a dossier on the right. This section fills the dossier. Four blocks,
in this order, because that is the order a player asks the questions in:

1. **The fantasy** — one sentence. What am I?
2. **Difficulty of play** — three pips. Will this hurt?
3. **Resource and numbers** — what the class is made of.
4. **Starting kit** — what I walk out of the gate holding.

### 4.2 The three dossiers

| | Ravager | Emberwright | Runeblade |
|---|---|---|---|
| **Fantasy (EN)** | You never learned to read, and that is the only reason you are still alive. | You read the lesson that burned the world, and you decided to say it back. | You could not trust your head with a word, so you wrote it on a sword. |
| **Fantasy (RU)** | Ты не выучился читать — только поэтому ты ещё жив. | Ты прочёл урок, сжёгший мир, и решил ответить тем же. | Ты не доверил слово голове — и вырезал его на клинке. |
| **Difficulty** | ● ○ ○ — **Direct** | ● ● ● — **Unforgiving** | ● ● ○ — **Deliberate** |
| **Resource** | Rage 0–100 | Mana | Mana + Resonance 0–3 |
| **Life / Mana at 1** | 55 / 10 | 40 / 25 | 45 / 18 |
| **Life / Mana at 30** | 345 / 25 | 127 / 228 | 176 / 105 |
| **Trees** | Carnage · Unyielding | Flame · Ash | Enchanted Blade · Conduit |
| **Range** | melee, 1.9 m | ranged, 7–26 m | melee with reach |

**Why those difficulty ratings, in numbers.**

| Class | Rating | The number behind it |
|---|---|---|
| Ravager | **1/3** | The largest life pool at every level (55 → 345, `03-combat-math.md` §2.3) and a resource that is *earned by doing the obvious thing*: rage income at the level-10 reference build is 6.92/s against `cleaving_strike`'s 9 cost, so the primary skill is castable every 1.30 s and can never be locked out by a bad resource decision. A Ravager cannot strand itself. |
| Emberwright | **3/3** | 40 life at level 1 and 127 at 30 — **37 % of the Ravager's bar at cap**. A single Maulsmith `crushing_slam` at mlvl 15 is `9–18 × 5.55 × 2.20 = 110–220`, which one-shots a bare level-30 Emberwright. Its answer is `ashen_step` on a 3.0 s cooldown and never standing still. It also has the only failure mode in the game where the correct play is to stop attacking: §11.4's boss fight ends with an empty belt and 3 mana of margin. |
| Runeblade | **2/3** | Neither pool nor bar is extreme (45 → 176 life), but the resource loop is conditional: mana is spent by casting and returned at 8 % of physical damage dealt (§2.4). A player who only casts runs dry in nine seconds; a player who only swings never uses half their kit. It is not punishing, it is *conditional*, and conditional is the middle pip. |

### 4.3 Starting kits

Everything below exists in the shipped tables. Reference weapon rows are
`03-combat-math.md` §4.6; consumables are §8.8; `startGold` is 120 for all three
classes (§2.1).

| | Ravager | Emberwright | Runeblade |
|---|---|---|---|
| Main hand | Hand Axe `axe_hand_normal` 4–9, 0.80 s, AR 40 | Ember Wand `wand_ember_normal` 3–7, 0.60 s | Hand Axe `axe_hand_normal` |
| Chest | Ashen Rags — the `reqLevel 1` cloth chest | Ashen Rags | Ashen Rags |
| Belt slot 1 | 3 × `potion_life_minor` | 2 × `potion_life_minor` | 2 × `potion_life_minor` |
| Belt slot 2 | — | 2 × `potion_mana_minor` | 1 × `potion_mana_minor` |
| Inventory | 1 × `scroll_identify` | 1 × `scroll_identify` | 1 × `scroll_identify` |
| Gold | 120 | 120 | 120 |
| Hotbar 1 | `cleaving_strike` (1 point pre-spent) | `ember_bolt` | `rune_strike` |

`09-ui.md` §3.5's wireframe reads `START Hand Axe, Rags, 3 ✚` for the Ravager,
which this table reproduces exactly.

**Justification against the level-1 numbers.**

*Damage.* A Ravager at STR 30 with the Hand Axe deals
`6.5 × (1 + 30/100) × 1.05 = 8.87` expected per landed hit. In the opening ramp's
band A a Bone Ranker at mlvl 2 has 25 life and DEF 23, so it dies in **3 landed
hits** at a 57.0 % hit chance — 5.3 swings, **3.8 s**. That is the locked
"2–4 hits" band, reached at level 1 with the starter axe and nothing else.

*The Emberwright's wand.* `ember_bolt` at slvl 1 deals 3–7 fire and always hits
(`attackRating === 0`), so `5 × 1.05 / 0.4675 s = 11.2` damage per second and the
same Bone Ranker dies in **2.2 s** across 5 casts costing 10 of a 25-mana pool.
The wand's 3–7 physical is *strictly worse* than the bolt and is never the
Emberwright's damage source — it is there so the main-hand slot is not empty, so
the paperdoll reads, and so the first `+% fire damage` wand the player finds has
something to replace. This is the reason for the one item-table request in §14.

*Potions.* `potion_life_minor` restores **35 % of `maxLife` over 3.0 s** (§8.8).
Three of them is 105 % of a Ravager's level-1 bar. Against band A's largest
group — three Bone Rankers at mlvl 2, hitting for 3.7–7.4 at a clamped 95 % —
incoming is 11.3 damage per second, so the 55-life bar lasts 4.9 s bare and
**10.0 s** with the belt drunk. The pack dies in 11.4 s of uninterrupted
fighting. The margin is thin on purpose: level 1 is the only place in the game
where the correct play is to retreat, and the kit teaches it in the first minute.
The Emberwright trades one life potion for two mana potions because its 25-mana
pool is 12 casts and its bar is not the thing that runs out first.

*Gold.* 120 gold buys the second wave of potions at Veren's after the first
Wastes run, which is the intended first return trip — the loop that
`IMPLEMENTATION_PLAN.md` §4.7 is built around.

*The pre-spent skill point.* Every class starts with one point in its tier-1
primary so that the first pack is fought with the class's actual verb rather than
with a basic attack. It is spent from the level-1 budget, not added to it, so
`save` invariant #4 (`Σ skills + unspent === level − 1`) holds — at level 1 the
budget is 0, so the point is granted as a **class starting allocation**, exactly
like starting attributes, and invariant #4 is amended to
`Σ skills − Σ classStartSkills + unspent === level − 1`. That mirrors invariant
#3's existing `− Σ classStart` term and needs no version bump.

### 4.4 Name field

`09-ui.md` §3.5 fixes the pattern `[A-Za-z][A-Za-z0-9 '-]{0,15}`. Russian names
are therefore typed in Latin, which is wrong for a Russian player and right for
a save-file key. The resolution: the pattern is extended to
`[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9 '-]{0,15}` and the save keeps the string
verbatim; nothing indexes by name. Suggested names offered by the shuffle button
are drawn from the unique-monster given-name pool of §10.3, which is already
authored in both alphabets.

---

## 5. The lore bible

*Roughly 600 words. Everything a later writer needs; nothing they have to
reconcile.*

**What happened.** There was a school. Its name did not survive, and the
records call it only the Instruction. It taught one discipline: that a statement
made correctly does not need a speaker. Say a thing rightly — the right word, in
the right order, meant — and it keeps being true after your mouth has closed.
This was not summoning. Nothing was called up. The Instruction was a *pedagogy*,
and its masters were proud that it required no gods, no pacts and no blood. It
required only precision.

Four hundred years ago its first master stood at the lectern and taught the
First Lesson to a full hall. The lesson was correct. It is still being taught.

**What the ash is.** The ash is not the residue of a fire. It is the lesson,
still in progress — a sentence begun and never finished, and the world is inside
the sentence. Ash falls thickest where the words are loudest: over the school,
over the plain it stood on, over anything that heard. It does not burn. It
settles on the tongue and makes speech tiring, which is the joke at the centre of
the setting: the thing that ended the world is knowledge, and the world's
punishment is that it can no longer easily say anything.

**What Instruction means.** Three things, and the game uses all three. It is the
name of the school. It is the name of the first difficulty tier, because the
first pass through the act is the course as it was originally taught. And it is
what the ash is *doing* — instructing, endlessly, badly, to nobody.

**Who Molgrim was.** Molgrim was the First Instructor and he was not a villain.
He was a teacher who finished his preparation, opened his mouth and was right.
He has been at the lectern since, because the lesson is not over and a teacher
does not leave mid-sentence. He is not undead in the usual way; he is
*mid-clause*. He will explain this to the player, patiently, while killing them,
and he does not raise his voice. What he wants is an attentive room. What the
player is, to him, is an interruption — and the only genuinely offensive thing
in his world is an interruption.

**Why the three classes exist.** Each is an answer to the same question: what do
you do about knowledge that kills?

- The **Ravager** refuses it. They never learned to read, on purpose, in most
  cases from a family that made the choice a generation earlier. Their resource
  is **Rage**, which cannot be taught, only felt, and therefore cannot be
  corrupted by a correct sentence. They fight with the only argument the ash
  cannot answer.
- The **Emberwright** accepts it and uses it. They read the surviving fragments,
  understood the fire, and decided the correct response to a burning sentence is
  a louder one. Their resource is **Mana**, the ordinary discipline, and their
  trees are **Flame** and **Ash** because they work with both halves of what
  happened.
- The **Runeblade** relocates it. A word held in a head can be finished by the
  ash; a word cut into steel belongs to the steel. Their resource is **Mana** and
  **Resonance**, and the loop between them — hit to earn, cast to spend — is the
  class's whole thesis: knowledge you have to keep paying for cannot own you.

**Last Bastion** is the last inhabited place, a town cut into the face of a
quarry, because stone remembers words worse than wood or flesh does. Four people
of note stayed: a stonecutter who repairs what the ash eats, a weaver who can
read a thing without being read by it, a keeper of a vault nobody has emptied,
and an Instructress — a woman with the school's training and none of its
loyalties, who is the only person alive who can look at the First Tablet and
know what the sentence needs.

**What the player does.** Kaira does not want the Tablet destroyed. A sentence
you erase mid-clause is still unfinished. She wants it **completed** — and a
completed sentence stops. That is the act's whole argument, and it is why the
quest is called *The Word That Does Not Fade* and not *The Word That Must Burn*.

---

## 6. Proper nouns

Canonical. Every later writer names things from this table and from nothing else.
Russian forms are given in the nominative; where a form is declined in dialogue
it is declined normally, and where a name is **interpolated into a template
string** it is quoted and left nominative (§10.6, rule G4).

### 6.1 Places, things and tiers

| EN | RU | Gender | Meaning in one line |
|---|---|---|---|
| Claudo II: Lord of Instruction | Claudo II: Владыка Наставления | — | The game. `Claudo` is never translated or declined. |
| The Instruction | Наставление | n | The school, its discipline, and the first difficulty tier. |
| The First Lesson | Первый урок | m | What Molgrim taught. Still in progress. |
| The First Tablet | Первая Табличка | f | The only written copy of the First Lesson. The quest object. |
| Last Bastion | Последний Оплот | m | The town, cut into a quarry face. |
| Ashen Wastes | Пепельные Пустоши | pl | The plain the school stood on. Zone 1. |
| Bonereach | Кости Предела | pl | The school's undercroft. Zone 2. |
| Altar of Instruction | Алтарь Наставления | m | The lectern. Boss arena. |
| Gate of Instruction | Врата Наставления | pl | The sealed arch between Bonereach and the Altar. |
| The Cinder Sigil | Угольная печать | f | Kaira's mark. Opens the Gate. Not an item. |
| The Ember Court | Угольный двор | m | Last Bastion's central square. |
| Instruction *(tier)* | Наставление | n | Difficulty 1. |
| Trial *(tier)* | Испытание | n | Difficulty 2. |
| Renunciation *(tier)* | Отречение | n | Difficulty 3. |
| The Word That Does Not Fade | Слово, что не гаснет | n | The quest. |

### 6.2 People

| EN | RU | Gender | One line |
|---|---|---|---|
| Molgrim, the First Instructor | Мольгрим, Первый Наставник | m | Taught the First Lesson. Has not stopped. |
| Kaira the Instructress | Наставница Кайра | f | School-trained, school-hostile. Quest giver. |
| Veren the Stonecutter | Каменотёс Верен | m | Vendor, repair. Buries people for free. |
| Isa the Runeweaver | Ткачиха Рун Иса | f | Identify. Reads without being read. |
| the Stash Keeper | Хранитель Сундука | m | Keeps the vault. Has never given a name. |

### 6.3 Classes, resources, trees

| EN | RU | Gender |
|---|---|---|
| Ravager | Разоритель | m |
| Emberwright | Пепельник | m |
| Runeblade | Рунный клинок | m |
| Rage | Ярость | f |
| Mana | Мана | f |
| Resonance | Резонанс | m |
| Carnage | Бойня | f |
| Unyielding | Несгибаемость | f |
| Flame | Пламя | n |
| Ash | Пепел | m |
| Enchanted Blade | Заклятое лезвие | n |
| Conduit | Проводник | m |

### 6.4 Bestiary

Ids are `03-combat-math.md` §9.1's, which are binding. Russian genders are
listed because §10.6's adjective agreement needs them.

| id | EN | RU | Gender |
|---|---|---|---|
| `bone_ranker` | Bone Ranker | Костяной ратник | m |
| `carrion_swarm` | Carrion Swarm | Стая падальщиков | f |
| `ashen_archer` | Ashen Archer | Пепельный лучник | m |
| `dust_shaman` | Dust Shaman | Шаман праха | m |
| `maulsmith` | Maulsmith | Молотобоец | m |
| `blight_crawler` | Blight Crawler | Пузырь-ползун | m |
| `molgrim` | Molgrim | Мольгрим | m |

---

## 7. NPC dialogue

### 7.1 How lines are chosen

Every NPC has five line families. The mechanism is deliberately dumb: no state
machine, no conversation tree beyond the quest offer, no branching that a
translator has to trace.

| Family | Key shape | Selection |
|---|---|---|
| greeting | `dlg.<npc>.greet.<n>` | On `openDialogue`, `world`'s zone stream picks `n` uniformly, never repeating the previous `n` for that NPC in this town visit. |
| service | `dlg.<npc>.svc.<action>` | Fixed per action. No rotation — a player who repairs twice must see the same words, or the words become noise. |
| quest stage | `dlg.<npc>.quest.<state>` / `dlg.kaira.step.<n>` | Deterministic from `player.questState('word_unquenched')`. Every NPC has a line for every state. |
| farewell | `dlg.<npc>.bye.<n>` | Uniform, non-repeating, on panel close. |
| idle bark | `dlg.<npc>.idle.<n>` | Spoken as a floating world line when the player is within 6 m and not in dialogue, at most once per 22 s per NPC, uniform non-repeating. Never fires while any panel is open. |

The quest-stage line **replaces** the greeting whenever the quest state changed
since the player last spoke to that NPC — so the world reacts once, loudly, and
then goes back to being a shop.

**Length rule.** No line exceeds 120 characters in English or 130 in Russian.
The dialogue panel is 1000 × 260 (`09-ui.md` §3.3) at `--t-read` 15/22, which is
roughly 95 characters per line; two lines is the whole budget before a player
starts clicking through instead of reading. Every line below is inside it.

### 7.2 Veren the Stonecutter

> **Voice:** a man who talks about materials because talking about people is
> harder; blunt, unhurried, never asks a question, and is kinder than his
> sentences are.

| Key | EN | RU |
|---|---|---|
| `npc.veren` | Veren the Stonecutter | Каменотёс Верен |
| `dlg.veren.greet.1` | Bring it here. I've seen worse than whatever that is. | Давай сюда. Я и похуже видал. |
| `dlg.veren.greet.2` | Steel keeps. Everything else, the ash eats. | Сталь держится. Остальное пепел съедает. |
| `dlg.veren.greet.3` | You're standing in my good light. | Ты мне свет загораживаешь. |
| `dlg.veren.greet.4` | I fix, I buy. I don't advise. | Чиню, скупаю. Советов не даю. |
| `dlg.veren.greet.5` | Still walking. Good. | Ещё ходишь. Хорошо. |
| `dlg.veren.svc.buy` | Take what you can carry. | Бери, сколько унесёшь. |
| `dlg.veren.svc.sell` | I'll give you what it's worth. Not what you want. | Дам, сколько стоит. Не сколько хочется. |
| `dlg.veren.svc.buyback` | It's on the second shelf. It always is. | На второй полке. Как всегда. |
| `dlg.veren.svc.repair` | Give it here. Come back when I've breathed on it. | Давай сюда. Вернёшься, когда я на неё подышу. |
| `dlg.veren.svc.repaired` | Done. It'll hold longer than you will. | Готово. Переживёт тебя. |
| `dlg.veren.svc.nothingToRepair` | Nothing here needs me. | Тут мне делать нечего. |
| `dlg.veren.svc.poor` | Come back with more. | Приходи с деньгами. |
| `dlg.veren.quest.available` | Kaira's been at that door all morning. Go, or she'll come and find you. | Кайра всё утро у той двери. Иди сам, а то сама придёт. |
| `dlg.veren.quest.active` | You still owe her a stone. Don't owe me one too. | Ты ей ещё камень должен. Мне не задолжай. |
| `dlg.veren.quest.complete` | So that's what a finished sentence sounds like. Quieter. | Вот, значит, как звучит законченная фраза. Тише. |
| `dlg.veren.quest.rewarded` | Wear it. Don't polish it. It wasn't made for looking at. | Носи. Не полируй. Не для красоты сделано. |
| `dlg.veren.bye.1` | Don't die owing me. | Не помирай в долгу. |
| `dlg.veren.bye.2` | Mind the gate. | У ворот смотри в оба. |
| `dlg.veren.bye.3` | Go on, then. | Ну, иди. |
| `dlg.veren.idle.1` | Ash in the joints again. | Опять пепел в стыках. |
| `dlg.veren.idle.2` | Two more and the rack's full. | Ещё две — и стойка полна. |
| `dlg.veren.idle.3` | This stone's older than the school. It'll outlast it too. | Этот камень старше школы. И переживёт её. |
| `dlg.veren.idle.4` | Hm. | Хм. |

### 7.3 Isa the Runeweaver

> **Voice:** precise and faintly cruel, entertained by everything, talks about
> objects as though they can hear her — because in her experience they can.

| Key | EN | RU |
|---|---|---|
| `npc.isa` | Isa the Runeweaver | Ткачиха Рун Иса |
| `dlg.isa.greet.1` | Show me. I'll be careful with your feelings and not with the item. | Показывай. Твои чувства поберегу, вещь — нет. |
| `dlg.isa.greet.2` | It has already told me three things. You'll want the fourth. | Она мне уже три вещи рассказала. Тебе нужна четвёртая. |
| `dlg.isa.greet.3` | Everything wants to be read. That is its entire problem. | Всё хочет, чтобы его прочли. В этом вся его беда. |
| `dlg.isa.greet.4` | Sit. Don't touch the thread. | Садись. Нитку не трогай. |
| `dlg.isa.greet.5` | You've been out in the ash. It shows in the vowels. | Ты был в пепле. Это слышно по гласным. |
| `dlg.isa.svc.identify` | Hold still. Not you — the item. | Не шевелись. Не ты — вещь. |
| `dlg.isa.svc.identified` | There. Now it knows you as well. | Готово. Теперь и она тебя знает. |
| `dlg.isa.svc.noScroll` | I read. I don't supply. Veren sells the paper. | Я читаю, а не снабжаю. Бумагу продаёт Верен. |
| `dlg.isa.svc.sockets` | Later. The stones aren't listening yet. | Позже. Камни ещё не слушают. |
| `dlg.isa.quest.available` | She'll ask you for the Tablet. Say yes. Say it slowly. | Она попросит Табличку. Соглашайся. Только не спеша. |
| `dlg.isa.quest.active` | The Tablet reads back, you know. Kaira knows. She went anyway. | Табличка ведь читает в ответ. Кайра знает. И всё равно пошла. |
| `dlg.isa.quest.complete` | Take it to her, not to me. I would finish it wrong. | Неси ей, не мне. Я закончу не так. |
| `dlg.isa.quest.rewarded` | It's quieter. Not quiet. Quieter. | Тише стало. Не тихо. Тише. |
| `dlg.isa.bye.1` | Come back before it learns your name. | Возвращайся, пока она не выучила твоё имя. |
| `dlg.isa.bye.2` | Mind what you read aloud. | Следи, что читаешь вслух. |
| `dlg.isa.bye.3` | Go and be illegible. | Иди и будь неразборчивым. |
| `dlg.isa.idle.1` | …and the third strand refuses. As usual. | …а третья нить упрямится. Как всегда. |
| `dlg.isa.idle.2` | Some words itch. | Иные слова зудят. |
| `dlg.isa.idle.3` | No, I will not read you. Ask me again in a year. | Нет, тебя я читать не стану. Спроси через год. |
| `dlg.isa.idle.4` | The loom is honest. Rare quality, out here. | Станок честен. Редкое качество в наших краях. |

### 7.4 The Stash Keeper

> **Voice:** speaks in the fewest words that will do the job, mostly numbers and
> single verbs, and has not volunteered a name in thirty years.

| Key | EN | RU |
|---|---|---|
| `npc.stash_keeper` | the Stash Keeper | Хранитель Сундука |
| `dlg.stash_keeper.greet.1` | Vault. | Хранилище. |
| `dlg.stash_keeper.greet.2` | It's all here. Count it. | Всё на месте. Считай. |
| `dlg.stash_keeper.greet.3` | Nothing has been taken. | Ничего не пропало. |
| `dlg.stash_keeper.greet.4` | Eighty spaces. Some are yours. | Восемьдесят мест. Часть — твои. |
| `dlg.stash_keeper.greet.5` | You came back. | Ты вернулся. |
| `dlg.stash_keeper.svc.open` | Open. Don't hurry. | Открыто. Не торопись. |
| `dlg.stash_keeper.svc.full` | No room. Take something out. | Места нет. Забери что-нибудь. |
| `dlg.stash_keeper.svc.gold` | Counted. | Сочтено. |
| `dlg.stash_keeper.svc.close` | Closed. | Закрыто. |
| `dlg.stash_keeper.quest.available` | Kaira waits. West wall. | Кайра ждёт. У западной стены. |
| `dlg.stash_keeper.quest.active` | Leave the heavy things. You'll want the room. | Тяжёлое оставь. Место понадобится. |
| `dlg.stash_keeper.quest.complete` | You are carrying something that is not yours yet. | Ты несёшь то, что ещё не твоё. |
| `dlg.stash_keeper.quest.rewarded` | In the vault or on you. Not both. | Или в хранилище, или на тебе. Не разом. |
| `dlg.stash_keeper.bye.1` | It will be here. | Оно будет здесь. |
| `dlg.stash_keeper.bye.2` | Go. | Иди. |
| `dlg.stash_keeper.bye.3` | Counted and closed. | Сочтено и закрыто. |
| `dlg.stash_keeper.idle.1` | Forty-one. Forty-one. Forty-one. | Сорок один. Сорок один. Сорок один. |
| `dlg.stash_keeper.idle.2` | The lock is older than the town. | Замок старше города. |
| `dlg.stash_keeper.idle.3` | I don't sleep in here. I sleep beside it. | Я тут не сплю. Я сплю рядом. |
| `dlg.stash_keeper.idle.4` | Someone's ring. Twelve years now. | Чьё-то кольцо. Двенадцать лет уже. |

### 7.5 Kaira the Instructress

> **Voice:** a teacher who is out of students; exact, patient, tired, and the
> only person in the game who explains anything — which is why she is also the
> only one allowed two-sentence lines.

| Key | EN | RU |
|---|---|---|
| `npc.kaira` | Kaira the Instructress | Наставница Кайра |
| `dlg.kaira.greet.1` | Sit down. Or don't — I'll talk either way. | Садись. Или не садись — я всё равно скажу. |
| `dlg.kaira.greet.2` | You hear it in the ash too. That's the lesson. Still going. | Ты ведь тоже слышишь это в пепле. Это урок. Он всё идёт. |
| `dlg.kaira.greet.3` | I taught for eleven years. I've spent forty stopping one sentence. | Я преподавала одиннадцать лет. И сорок останавливаю одну фразу. |
| `dlg.kaira.greet.4` | Good, you're on time. Nothing else here is. | Хорошо, ты вовремя. Здесь больше ничто не вовремя. |
| `dlg.kaira.greet.5` | Ask. I don't mind questions. I mind guessing. | Спрашивай. Вопросы не мешают. Мешают догадки. |
| `dlg.kaira.offer.1` | There is a tablet beneath the Altar of Instruction. The First Lesson, entire, in Molgrim's own hand. | Под Алтарём Наставления лежит табличка. Первый урок, целиком, рукой Мольгрима. |
| `dlg.kaira.offer.2` | Not to burn. A sentence stopped halfway is still being spoken. I intend to finish it. | Не для того, чтобы сжечь. Фраза, оборванная на середине, всё равно звучит. Я намерена её закончить. |
| `dlg.kaira.offer.accept` | I'll bring it. | Я принесу. |
| `dlg.kaira.offer.decline` | Not yet. | Не сейчас. |
| `dlg.kaira.offer.declined` | Then come back when the ash reaches your throat. | Тогда возвращайся, когда пепел встанет в горле. |
| `dlg.kaira.accepted` | Take the mark. The Gate under Bonereach doesn't open for strangers. | Возьми знак. Врата под Костями Предела чужому не откроются. |
| `dlg.kaira.step.2` | North, across the Wastes. The school is underneath them. You'll feel where. | На север, через Пустоши. Школа под ними. Сам почувствуешь где. |
| `dlg.kaira.step.3` | You've been down there, then. So you heard the students. Don't answer them. | Значит, ты был внизу. И слышал учеников. Не отвечай им. |
| `dlg.kaira.step.4` | You stood in front of him and lived. Most of my year did not manage that. | Ты стоял перед ним и выжил. Мой курс по большей части не сумел. |
| `dlg.kaira.step.5` | He's silent. Now lift the tablet off the lectern. He never did. | Он замолчал. Теперь сними табличку с кафедры. Сам он так и не снял. |
| `dlg.kaira.step.6` | You have it. Bring it here, and don't read it on the way. | Она у тебя. Неси сюда и по дороге не читай. |
| `dlg.kaira.turnin.1` | Give it here. …Yes. That's his hand. He always did press too hard. | Дай сюда. …Да. Его рука. Он всегда слишком давил. |
| `dlg.kaira.turnin.2` | Listen. Hear that? He is finally, finally at a full stop. | Слушай. Слышишь? Он наконец-то, наконец, поставил точку. |
| `dlg.kaira.turnin.claim` | Take one. | Возьму одно. |
| `dlg.kaira.turnin.reward` | And take this: everything you know how to do, you now do a little better. That is what a finished lesson gives back. | И вот ещё что: всё, что ты умеешь, ты теперь умеешь чуть лучше. Это и отдаёт законченный урок. |
| `dlg.kaira.quest.rewarded` | It begins again in three days. It always does. Go back down and be earlier. | Через три дня начнётся снова. Всегда начинается. Спускайся опять — и приди раньше. |
| `dlg.kaira.svc.difficulty` | Which part would you like to sit again? | Какую часть хочешь пройти снова? |
| `dlg.kaira.svc.difficultyLocked` | Not yet. Finish the part you're in. | Ещё нет. Закончи ту, в которой ты сейчас. |
| `dlg.kaira.svc.difficultySet` | Then that is where you'll be. Try to take notes. | Значит, там и будешь. Постарайся вести записи. |
| `dlg.kaira.bye.1` | Go, before I start explaining. | Иди, пока я не начала объяснять. |
| `dlg.kaira.bye.2` | North. And don't repeat anything. | На север. И ничего не повторяй. |
| `dlg.kaira.bye.3` | Come back with it. Or just come back. | Возвращайся с ней. Или хотя бы возвращайся. |
| `dlg.kaira.idle.1` | …subject, verb, and then he never — no. Later. | …подлежащее, сказуемое, а дальше он так и не — нет. Потом. |
| `dlg.kaira.idle.2` | Eleven years. One word would have stopped him. | Одиннадцать лет. Одно слово — и я бы его остановила. |
| `dlg.kaira.idle.3` | The ash is quieter on this side of the wall. Slightly. | По эту сторону стены пепел тише. Немного. |
| `dlg.kaira.idle.4` | Don't touch the chalk. | Мел не трогай. |

---

## 8. Molgrim

### 8.1 Voice

> A teacher who has not been contradicted in four hundred years, does not raise
> his voice, and regards the player as an interruption rather than as a threat.
> He never insults and never gloats. Every line is a correction.

### 8.2 Triggers

Molgrim's lines are driven by events `ai` already emits. Nothing new is needed
except the spawn-time `boss:phase` that `09-ui.md` §16.5 has already requested.

| Key | Trigger | Rate limit |
|---|---|---|
| `boss.molgrim.entry.1` / `.2` | `boss:phase { phase: 1 }` at spawn. `.1` then `.2`, 2.2 s apart, over the 2 400 ms boss introduction (`09-ui.md` §10.7). | once per encounter |
| `boss.molgrim.phase2` | `boss:phase { phase: 2 }` | once |
| `boss.molgrim.phase3` | `boss:phase { phase: 3 }` | once |
| `boss.molgrim.summon` | `summon_ranker` cast | at most 1 in 3 casts |
| `boss.molgrim.ring` | first `ember_rings` of phase II | once |
| `boss.molgrim.meteor` | first `meteor_rain` of phase III | once |
| `boss.molgrim.taunt.1`–`.6` | idle, uniform non-repeating | at most one per 14 s |
| `boss.molgrim.playerDeath` | the player dies inside the arena | every time |
| `boss.molgrim.death.1` / `.2` | `actor:death` on the boss, 1.6 s apart, over the 6 000 ms `boss.death` cue | once |

Lines render as world-anchored text above the boss at `--t-read` with `--sh-o2`
(`09-ui.md` §2.2), never in the dialogue panel — the fight does not pause.

### 8.3 The lines

| Key | EN | RU |
|---|---|---|
| `monster.molgrim` | Molgrim | Мольгрим |
| `monster.molgrim.title` | the First Instructor | Первый Наставник |
| `boss.molgrim.entry.1` | You are late, and you have not read. | Ты опоздал. И ты не читал. |
| `boss.molgrim.entry.2` | Sit. We had reached the fourth clause. | Садись. Мы дошли до четвёртого оборота. |
| `boss.molgrim.phase2` | No. From the beginning. Everyone — from the beginning. | Нет. С начала. Все — с начала. |
| `boss.molgrim.phase3` | You are not stupid. You are simply not listening. That is worse. | Ты не глуп. Ты просто не слушаешь. Это хуже. |
| `boss.molgrim.summon` | Class. Attend. | Класс. Внимание. |
| `boss.molgrim.ring` | Observe the shape of the argument. | Проследи за формой рассуждения. |
| `boss.molgrim.meteor` | Take this down. | Запиши. |
| `boss.molgrim.taunt.1` | Repeat it. | Повтори. |
| `boss.molgrim.taunt.2` | Again. Correctly, this time. | Ещё раз. Теперь верно. |
| `boss.molgrim.taunt.3` | Four hundred years and not one of you takes notes. | Четыреста лет — и ни один из вас не ведёт записей. |
| `boss.molgrim.taunt.4` | This is the simple part. This is the part that is simple. | Это лёгкая часть. Это как раз лёгкая часть. |
| `boss.molgrim.taunt.5` | Stand still. I cannot teach a moving thing. | Стой ровно. Я не могу учить то, что бегает. |
| `boss.molgrim.taunt.6` | You will understand. Everyone understands eventually. | Ты поймёшь. Все в итоге понимают. |
| `boss.molgrim.playerDeath` | Dismissed. | Свободен. |
| `boss.molgrim.death.1` | …and therefore — and therefore — | …и, следовательно… и, следовательно… |
| `boss.molgrim.death.2` | Oh. So that was the end of it. | А. Так вот где был конец. |

---

## 9. The remaining dictionary

Format, key convention, interpolation, plural suffixes and fallback are
`09-ui.md` §14.1 and are not restated. Everything below is **new** except where
§9.1 says otherwise. All of it goes into `src/ui/i18n.js` alongside the existing
tables.

### 9.1 Duplicates against `09-ui.md` §14.3 — do not redefine

These keys already exist. This document uses them and defines none of them. The
list is exhaustive: every key in §9.2–§9.16 that is not on this list is new.

| Key | Owner | Note for the implementer |
|---|---|---|
| `app.title`, `app.subtitle` | `09-ui` §14.3 | Used verbatim on the main menu and the credits screen. |
| `class.ravager.name`, `class.emberwright.name`, `class.runeblade.name` | `09-ui` §14.3 | §6.3's Russian matches byte-for-byte. No conflict. |
| `class.*.tagline` | `09-ui` §14.3 | Kept. §9.5 adds `.dossier` and `.difficulty`, which §14.2 names but §14.3 leaves empty. |
| `create.title`, `.name`, `.namePlaceholder`, `.begin`, `.back`, `.resource`, `.attributes`, `.trees`, `.startingItems`, `.nameTaken`, `.nameInvalid` | `09-ui` §14.3 | §9.5 adds only the rows the dossier needs on top. |
| `difficulty.instruction`, `.trial`, `.renunciation` | `09-ui` §14.3 | §9.10 adds `.desc` only. |
| `tree.carnage`, `.unyielding`, `.flame`, `.ash`, `.enchanted_blade`, `.conduit` | `09-ui` §14.3 | Used by `stat.skillsTree`'s `{tree}` parameter. |
| `quests.active`, `.complete`, `.rewarded`, `.reward`, `.chooseReward`, `.none` | `09-ui` §14.3 | Quest-log chrome. §9.6 supplies only the quest's own content. |
| `banner.levelUp`, `.levelValue`, `.questComplete`, `.questUpdated`, `.zoneEntered`, `.difficultyUnlocked` | `09-ui` §14.3 | §9.7 adds five banners the shipped set does not cover. |
| `death.title`, `.slainBy`, `.xpLost`, `.noPenalty`, `.itemsKept`, `.return` | `09-ui` §14.3 | The death screen is complete as shipped. §9.13 adds one first-death system line only. |
| `hud.maxLevel` | `09-ui` §14.3 | Rendered in place of `hud.xpProgress` at level 30 (§1.7). |
| `toast.skillPointGained`, `toast.statPointGained`, `toast.identified`, `toast.saved` | `09-ui` §14.3 | §9.8's `levelup.*` are the **banner** body; the toasts stay as they are. |
| `prompt.speak`, `.openStash`, `.enterPortal`, `.openChest`, `.pickUp` | `09-ui` §14.3 | §9.12 adds seven quest- and gate-specific prompts. |
| `panel.dialogue` | `09-ui` §14.3 | Value is `—` because the NPC's name is the panel title. Kept. `npc.<id>` (§7) supplies that name. |
| `panel.quests`, `panel.confirm`, `panel.close` | `09-ui` §14.3 | — |
| `common.confirm`, `.cancel`, `.yes`, `.no` | `09-ui` §14.3 | §9.14's confirmations use these as button labels. |
| `combat.xpGain` | `09-ui` §14.3 | The quest XP toast reuses it: `+{v} XP`. |
| `error.saveCorrupt`, `.saveNewer`, `.storageFull`, `.webgl` | `09-ui` §14.3 | §9.15 adds seven gameplay errors. |

**One genuine collision, resolved.** `09-ui.md` §3.5's quest-log wireframe prints
the zone as *"The Ashen Wastes"* while §14.2 routes zone names through
`zone.<zoneId>`. §9.2 defines `zone.ashen_wastes` as **"Ashen Wastes"** with no
article, because the same string is used in `banner.zoneEntered` where an article
reads wrong. The wireframe is illustrative; the key is canonical.

### 9.2 Zones and places — *screen: quest log, banner, minimap, loading*

| Key | EN | RU |
|---|---|---|
| `zone.last_bastion` | Last Bastion | Последний Оплот |
| `zone.ashen_wastes` | Ashen Wastes | Пепельные Пустоши |
| `zone.bonereach` | Bonereach | Кости Предела |
| `zone.altar_of_instruction` | Altar of Instruction | Алтарь Наставления |
| `zone.last_bastion.desc` | A town cut into a quarry face. Stone remembers words badly. | Город, врезанный в стену каменоломни. Камень плохо помнит слова. |
| `zone.ashen_wastes.desc` | The plain the school stood on. The ash here is still speaking. | Равнина, на которой стояла школа. Пепел здесь всё ещё говорит. |
| `zone.bonereach.desc` | The undercroft. The students never left the lesson. | Подземелье школы. Ученики так и не ушли с урока. |
| `zone.altar_of_instruction.desc` | The lectern. He is still at it. | Кафедра. Он всё ещё там. |
| `place.gate_of_instruction` | Gate of Instruction | Врата Наставления |
| `place.ember_court` | the Ember Court | Угольный двор |
| `place.altar_tablet` | the First Tablet | Первая Табличка |
| `place.cinder_sigil` | the Cinder Sigil | Угольная печать |

### 9.3 Bestiary — *screen: target bar, minimap tooltip*

| Key | EN | RU |
|---|---|---|
| `monster.bone_ranker` | Bone Ranker | Костяной ратник |
| `monster.carrion_swarm` | Carrion Swarm | Стая падальщиков |
| `monster.ashen_archer` | Ashen Archer | Пепельный лучник |
| `monster.dust_shaman` | Dust Shaman | Шаман праха |
| `monster.maulsmith` | Maulsmith | Молотобоец |
| `monster.blight_crawler` | Blight Crawler | Пузырь-ползун |
| `monster.bone_ranker.desc` | A student who stayed in his seat. | Ученик, оставшийся на своём месте. |
| `monster.carrion_swarm.desc` | Whatever eats what a lesson leaves. | То, что доедает оставшееся от урока. |
| `monster.ashen_archer.desc` | Always sat at the back. Still does. | Всегда сидел на задней парте. Сидит и сейчас. |
| `monster.dust_shaman.desc` | Repeats the lesson to the ones who fell. | Повторяет урок тем, кто упал. |
| `monster.maulsmith.desc` | Was not a student. Was the door. | Он не учился. Он был дверью. |
| `monster.blight_crawler.desc` | Held its breath through the whole lesson. | Задержал дыхание на весь урок. |
| `rank.champion` | Champion | Чемпион |
| `rank.unique` | Unique | Уникальный |
| `rank.minion` | Minion | Прислужник |
| `rank.boss` | Boss | Босс |

`monster.molgrim` and `monster.molgrim.title` are defined in §8.3.

### 9.4 Monster affixes — *screen: target bar chips*

These are **adjectives** and Russian declines them. The dictionary carries all
four Russian forms under `monsterAffix.<id>.m|.f|.n|.p`; English carries one
string under `monsterAffix.<id>`. Resolution goes through `ui.adj(key, gender)`
(§13), which tries `key + '.' + gender` and falls back to `key` — so English
needs no extra rows and the fallback chain of §14.1 is untouched.

| Key | EN | RU — m / f / n / pl |
|---|---|---|
| `monsterAffix.burning` | Burning | Огненный / Огненная / Огненное / Огненные |
| `monsterAffix.charged` | Charged | Грозовой / Грозовая / Грозовое / Грозовые |
| `monsterAffix.frostbound` | Frostbound | Мёрзлый / Мёрзлая / Мёрзлое / Мёрзлые |
| `monsterAffix.swift` | Swift | Стремительный / Стремительная / Стремительное / Стремительные |
| `monsterAffix.mighty` | Mighty | Могучий / Могучая / Могучее / Могучие |
| `monsterAffix.stoneskin` | Stoneskin | Каменнокожий / Каменнокожая / Каменнокожее / Каменнокожие |
| `monsterAffix.hexing` | Hexing | Проклинающий / Проклинающая / Проклинающее / Проклинающие |
| `monsterAffix.vampiric` | Vampiric | Кровожадный / Кровожадная / Кровожадное / Кровожадные |
| `monsterAffix.multishot` | Multishot | Многострельный / Многострельная / Многострельное / Многострельные |

### 9.5 Character creation — *screen: character_create*

| Key | EN | RU |
|---|---|---|
| `class.ravager.dossier` | You never learned to read, and that is the only reason you are still alive. | Ты не выучился читать — только поэтому ты ещё жив. |
| `class.emberwright.dossier` | You read the lesson that burned the world, and you decided to say it back. | Ты прочёл урок, сжёгший мир, и решил ответить тем же. |
| `class.runeblade.dossier` | You could not trust your head with a word, so you cut it into a sword. | Ты не доверил слово голове — и вырезал его на клинке. |
| `class.ravager.difficulty` | Direct | Прямой путь |
| `class.emberwright.difficulty` | Unforgiving | Без права на ошибку |
| `class.runeblade.difficulty` | Deliberate | Расчётливый путь |
| `create.difficulty` | Difficulty of Play | Сложность игры |
| `create.difficultyPips` | {filled} of 3 | {filled} из 3 |
| `create.lifeMana` | Life {life} · Mana {mana} | Жизнь {life} · Мана {mana} |
| `create.startingGold` | Gold {v} | Золото {v} |
| `create.rangeLabel` | Range | Дальность |
| `create.range.melee` | Melee | Ближний бой |
| `create.range.ranged` | Ranged | Дальний бой |
| `create.range.reach` | Melee with reach | Ближний бой с досягаемостью |
| `create.shuffleName` | Suggest a name | Предложить имя |
| `create.confirmTitle` | Begin as {class}? | Начать за класс «{class}»? |
| `create.confirmBody` | The class cannot be changed later. | Класс потом не изменить. |

### 9.6 The quest — *screen: quest log, tracker, dialogue*

| Key | EN | RU |
|---|---|---|
| `quest.word_unquenched.name` | The Word That Does Not Fade | Слово, что не гаснет |
| `quest.word_unquenched.summary` | Kaira asks for the First Tablet, taken from the Altar of Instruction. | Кайра просит принести Первую Табличку с Алтаря Наставления. |
| `quest.word_unquenched.giver` | Kaira the Instructress · Last Bastion | Наставница Кайра · Последний Оплот |
| `quest.word_unquenched.lore` | A sentence stopped halfway is still being spoken. | Фраза, оборванная на середине, всё равно звучит. |
| `quest.word_unquenched.step.1` | Speak to Kaira | Поговорить с Кайрой |
| `quest.word_unquenched.step.2` | Cross the gate into the Ashen Wastes | Выйти через ворота в Пепельные Пустоши |
| `quest.word_unquenched.step.3` | Descend into Bonereach | Спуститься в Кости Предела |
| `quest.word_unquenched.step.4` | Pass the Gate of Instruction | Пройти Врата Наставления |
| `quest.word_unquenched.step.5` | Silence Molgrim, the First Instructor | Заставить умолкнуть Мольгрима, Первого Наставника |
| `quest.word_unquenched.step.6` | Take the First Tablet from the altar | Взять Первую Табличку с алтаря |
| `quest.word_unquenched.step.7` | Return to Kaira | Вернуться к Кайре |
| `quest.word_unquenched.reward` | One of three relics, and +1 to all skills, permanently | Одна из трёх реликвий и постоянные +1 ко всем навыкам |
| `quest.stepsRemaining.one` ‡ | {n} step remains | Остался {n} шаг |
| `quest.stepsRemaining.few` ‡ | {n} steps remain | Осталось {n} шага |
| `quest.stepsRemaining.many` ‡ | {n} steps remain | Осталось {n} шагов |

‡ plural family, `pluralRule(lang, n)` per `09-ui.md` §14.1. English uses
`.one` and `.many` as its `.other`.

### 9.7 Banners and notifications — *screen: alert layer*

| Key | EN | RU |
|---|---|---|
| `banner.questAccepted` | Quest Accepted | Задание принято |
| `banner.allSkills` | +1 to All Skills | +1 ко всем навыкам |
| `banner.allSkillsSub` | Permanent. Every skill you own. | Навсегда. Ко всем твоим навыкам. |
| `banner.maxLevel` | Maximum Level | Максимальный уровень |
| `banner.maxLevelSub` | Level 30. From here, it is what you carry. | 30 уровень. Дальше — только то, что ты носишь. |
| `banner.bossSlain` | {name} Is Silent | «{name}» умолк |
| `banner.tierComplete` | {difficulty} Complete | Сложность «{difficulty}» пройдена |
| `notify.questAccepted` | {quest} | «{quest}» |
| `notify.questStep` | {step} | {step} |
| `notify.questReward` | Reward received | Награда получена |

### 9.8 Level-up — *screen: alert layer, HUD*

| Key | EN | RU |
|---|---|---|
| `levelup.title` | Level {level} | Уровень {level} |
| `levelup.statPoints.one` ‡ | +{n} attribute point | +{n} очко характеристик |
| `levelup.statPoints.few` ‡ | +{n} attribute points | +{n} очка характеристик |
| `levelup.statPoints.many` ‡ | +{n} attribute points | +{n} очков характеристик |
| `levelup.skillPoint` | +1 skill point | +1 очко навыка |
| `levelup.life` | +{n} Life | +{n} к жизни |
| `levelup.mana` | +{n} Mana | +{n} к мане |
| `levelup.unlocked` | New skill available — {skill} | Открыт навык — «{skill}» |
| `levelup.hint` | Press C to spend | Нажмите C, чтобы распределить |

### 9.9 The reward screen — *screen: reward_choice*

| Key | EN | RU |
|---|---|---|
| `reward.title` | Choose Your Relic | Выберите реликвию |
| `reward.subtitle` | One only. The choice is permanent. | Только одну. Выбор окончателен. |
| `reward.take` | Take | Взять |
| `reward.confirmTitle` | Take {name}? | Взять «{name}»? |
| `reward.confirmBody` | The other two are lost. | Две другие пропадут. |
| `reward.plus` | And, permanently: | И — навсегда: |
| `reward.noRoom` | Your inventory is full. Kaira will hold it. | Инвентарь полон. Кайра подержит. |
| `reward.held` | Kaira is holding your reward | У Кайры лежит ваша награда |
| `unique.unlearned_edge.name` | The Unlearned Edge | Клинок Неучёного |
| `unique.unlearned_edge.lore` | It was never taught anything, and it never needed to be. | Его ничему не учили — и не понадобилось. |
| `unique.ashmantle.name` | Ashmantle | Пепельная мантия |
| `unique.ashmantle.lore` | Woven from what settled on the ones who stayed to listen. | Соткана из того, что осело на оставшихся слушать. |
| `unique.second_syllable.name` | The Second Syllable | Второй слог |
| `unique.second_syllable.lore` | It chose its branch the first time you wore it, and it will not choose again. | Она выбрала ветвь, когда ты надел её впервые, и второй раз не выберет. |

### 9.10 Difficulty — *screen: dialogue (Kaira), options*

| Key | EN | RU |
|---|---|---|
| `difficulty.instruction.desc` | The course as it was taught. | Курс в том виде, в каком его читали. |
| `difficulty.trial.desc` | The same course, and you were expected to read ahead. Elemental resistances −40. | Тот же курс, но готовиться надо было заранее. Стихийные сопротивления −40. |
| `difficulty.renunciation.desc` | You are not a student here. Elemental resistances −100. | Здесь ты уже не ученик. Стихийные сопротивления −100. |
| `difficulty.locked` | Locked | Закрыто |
| `difficulty.lockedReason` | Silence Molgrim on {difficulty} first | Сначала заставьте Мольгрима умолкнуть на сложности «{difficulty}» |
| `difficulty.current` | Current | Текущая |
| `difficulty.confirmTitle` | Move to {difficulty}? | Перейти на сложность «{difficulty}»? |
| `difficulty.confirmBody` | You keep everything. The monsters do not. | Всё останется при тебе. У монстров — нет. |
| `difficulty.changed` | Now playing — {difficulty} | Текущая сложность — «{difficulty}» |

### 9.11 Dialogue panel — *screen: dialogue*

| Key | EN | RU |
|---|---|---|
| `dialogue.continue` | Continue | Далее |
| `dialogue.leave` | Leave | Уйти |
| `dialogue.trade` | Trade | Торговать |
| `dialogue.repair` | Repair | Ремонт |
| `dialogue.identify` | Identify | Опознать |
| `dialogue.stash` | Stash | Сундук |
| `dialogue.quest` | Quest | Задание |
| `dialogue.difficulty` | Difficulty | Сложность |
| `dialogue.hintAdvance` | Space or click to continue | Пробел или клик — далее |

### 9.12 World prompts — *screen: world layer*

| Key | EN | RU |
|---|---|---|
| `prompt.takeTablet` | Take the First Tablet | Взять Первую Табличку |
| `prompt.gateSealed` | The Gate does not know you | Врата тебя не знают |
| `prompt.gateOpen` | Pass the Gate of Instruction | Пройти Врата Наставления |
| `prompt.descend` | Descend into Bonereach | Спуститься в Кости Предела |
| `prompt.leaveTown` | Cross the gate | Выйти за ворота |
| `prompt.returnTown` | Return to Last Bastion | Вернуться в Последний Оплот |
| `prompt.altarEmpty` | Nothing here yet | Пока здесь ничего |

### 9.13 System messages — *screen: toast column*

| Key | EN | RU |
|---|---|---|
| `system.portalOpened` | A portal to Last Bastion | Портал в Последний Оплот |
| `system.portalClosed` | The portal has closed | Портал закрылся |
| `system.portalRefused` | Not here | Здесь нельзя |
| `system.portalRefusedBoss` | Not while he is speaking | Не пока он говорит |
| `system.zoneCleared` | {zone} — cleared | «{zone}» — зачищено |
| `system.newSeed` | A new path through {zone} | Новый путь через «{zone}» |
| `system.difficultyUnlocked` | {difficulty} is open to you | Открыта сложность «{difficulty}» |
| `system.respecUsed` | All points reclaimed | Все очки возвращены |
| `system.tabletTaken` | You are carrying the First Tablet | Ты несёшь Первую Табличку |
| `system.firstDeath` | Your possessions stay with you. Experience does not. | Вещи остаются при тебе. Опыт — нет. |
| `system.beltHint` | Q W E R drink from the belt | Q W E R — пить из пояса |
| `system.identifyHint` | Isa reads what you cannot | Иса прочтёт то, чего не можешь ты |

### 9.14 Confirmations — *screen: confirm dialog*

| Key | EN | RU |
|---|---|---|
| `confirm.quitToMenu` | Return to the menu? | Выйти в меню? |
| `confirm.quitBody` | Your progress is saved. | Прогресс сохранён. |
| `confirm.deleteCharacter` | Delete {name}? | Удалить «{name}»? |
| `confirm.deleteBody` | This cannot be undone. | Это необратимо. |
| `confirm.respec` | Reclaim every point? | Вернуть все очки? |
| `confirm.respecBody` | Skills and attributes both. The scroll is consumed. | И навыки, и характеристики. Свиток израсходуется. |
| `common.back` | Back | Назад |

### 9.15 Errors — *screen: toast column, prompts*

| Key | EN | RU |
|---|---|---|
| `error.questGate` | Speak to Kaira before you go down | Сначала поговори с Кайрой |
| `error.altarSealed` | The Altar will not open | Алтарь не откроется |
| `error.bossAlive` | He has not finished | Он ещё не закончил |
| `error.difficultyLocked` | That part is not open yet | Эта часть ещё не открыта |
| `error.rewardTaken` | You have already been given it | Тебе это уже дали |
| `error.noCharacterSlot` | All three slots are full | Все три слота заняты |
| `error.i18nMissing` | [missing] {key} | [missing] {key} |

### 9.16 Credits — *screen: credits*

| Key | EN | RU |
|---|---|---|
| `credits.line.1` | Everything you see was generated when the page loaded. | Всё, что вы видите, создано при загрузке страницы. |
| `credits.line.2` | No textures, no models, no sound files, no fonts. | Ни текстур, ни моделей, ни звуковых файлов, ни шрифтов. |
| `credits.line.3` | Engine core derived from Claude-of-Duty, MIT licence. | Ядро движка — из Claude-of-Duty, лицензия MIT. |
| `credits.line.4` | Thank you for sitting through the lesson. | Спасибо, что дослушали урок. |

### 9.17 Count

| Section | Keys |
|---:|---:|
| §7 NPC dialogue (4 NPCs, `npc.*` + `dlg.*`) | 98 |
| §8 Molgrim (`monster.molgrim*`, `boss.molgrim.*`) | 18 |
| §9.2 zones and places | 12 |
| §9.3 bestiary | 16 |
| §9.4 monster affixes | 9 |
| §9.5 character creation | 17 |
| §9.6 the quest | 15 |
| §9.7 banners and notifications | 10 |
| §9.8 level-up | 9 |
| §9.9 reward screen | 14 |
| §9.10 difficulty | 9 |
| §9.11 dialogue panel | 9 |
| §9.12 world prompts | 7 |
| §9.13 system messages | 12 |
| §9.14 confirmations | 7 |
| §9.15 errors | 7 |
| §9.16 credits | 4 |
| §10 naming pools (`name.rare.head.*` 56 + `name.rare.tail.*` 48 + `name.unique.given.*` 40 + `name.unique.epithet.*` 32 + `name.champion.title.*` 24) | 200 |
| **Total added by this document** | **473** |

Russian adds **131** gendered variants on top, resolved through `ui.adj()`. The
base key always carries the masculine form, so only the other forms need a row:

| Family | Extra RU rows |
|---|---:|
| `monsterAffix.<id>` `.f` `.n` `.p` — 9 affixes × 3 | 27 |
| `name.champion.title.<n>` `.f` `.n` `.p` — 24 titles × 3 | 72 |
| `name.unique.epithet.<n>` `.f` — 32 epithets × 1 | 32 |
| | **131** |

`09-ui.md` §14.1's boot check asserts `keys(RU) ⊇ keys(EN)`, which these satisfy
trivially.

Combined with `09-ui.md` §14.3's 344, the shipped dictionary is **817 English
keys and 948 Russian entries**, before the generated `item.base.*`, `affix.*`,
`skill.*` and `stat.*` families that their owning documents supply.

---

## 10. Naming pools

### 10.1 Where the pools live and why they are split

Display strings live in `src/ui/i18n.js` under the `name.*` families, exactly
like every other data-owned string in `09-ui.md` §14.2. The **grammatical
metadata** — gender, number, and which construction a word belongs to — lives
beside the index in `src/items/data/names.js`, because it is language-neutral
structure rather than text and because `tools/lootsim.mjs` must be able to
generate 200 000 names in Node without loading a dictionary.

```js
// src/items/data/names.js
export const RARE_HEAD = [ { g:'m' }, { g:'f' }, … ];  // 56, index-aligned to name.rare.head.<i>
export const RARE_TAIL = [ {}, {}, … ];                // 48, index-aligned to name.rare.tail.<i>
export const UNIQUE_GIVEN = [ { g:'m' }, … ];          // 40
export const UNIQUE_EPITHET = [ {}, … ];               // 32
export const CHAMPION_TITLE = [ {}, … ];               // 24
```

### 10.2 Composition rules

| Construction | English | Russian | Runtime morphology |
|---|---|---|---|
| **magic item** | `PREFIX BASE SUFFIX` — *Ashen Battle Axe of Fortitude* | `ADJ[gender(base)] BASE SUFFIX_gen` — *Пепельный Топор Стойкости* | one array index |
| **rare item** | `HEAD TAIL` — *Doom Ash*, or `HEAD of TAIL` where the tail is definite — *Doom of the Instructor* | `HEAD_nom TAIL_gen` — *Погибель Праха*, *Погибель Наставника* | **none** |
| **unique item** | authored | authored | none |
| **unique monster** | `GIVEN, EPITHET` — *Karth, the Unlearned* | `GIVEN EPITHET[gender(given)]` — *Карт Неучёный* | one array index |
| **champion monster** | `TITLE ARCHETYPE` — *Bloodstained Bone Ranker* | `TITLE[gender(archetype)] ARCHETYPE` — *Окровавленный Костяной ратник* | one array index |

The English "of" is a property of the **tail**, not a runtime decision: tails 10
to 23 and 32 to 48 in §10.5 read as *"of the …"* and carry `definite: true`;
the rest concatenate. This is authored, so the generator never inspects a string.

### 10.3 Sizing, and why repeats do not happen

| Pool | Size | Combinations |
|---|---:|---:|
| rare = head × tail | 56 × 48 | **2 688** |
| unique monster = given × epithet | 40 × 32 | **1 280** |
| champion = title × archetype | 24 × 6 | **144** |

A 25-minute descent drops roughly 45–70 rare items on Instruction and up to 110
on Renunciation, so raw pool size alone would still collide: at 70 draws from
2 688 the birthday probability of *some* repeat is
`1 − exp(−70²/(2 × 2688)) = 60 %`. Pool size is therefore **not** the mechanism.

The mechanism is a **recent-name ring**:

```js
// items, in init(): a fixed Int32Array, never grown, never allocated again.
recent = new Int32Array(64);   ringHead = 0;
code   = headIndex * 48 + tailIndex;
for (tries = 0; tries < 3 && ringContains(code); tries++) redraw();
recent[ringHead++ & 63] = code;
```

Within the last **64 rare items** a repeat is impossible unless three
consecutive redraws all collide, which is `(64/2688)³ = 1.35 × 10⁻⁵`. Sixty-four
rares is more than a full descent's worth on Instruction and about half of one
on Renunciation, so within any window a player can actually hold in their head,
names do not repeat. The ring is 256 bytes, is part of the `items` RNG stream's
determinism contract (the redraws are ordinary draws in fixed order), and is
reset on `zone:enter`.

Champion titles collide freely and that is correct — *Bloodstained Bone Ranker*
appearing twice in an evening reads as a kind of monster, not as a bug. The ring
guards uniques (16 entries) and rares (64) only.

### 10.4 Russian gender agreement — the mechanism

English concatenates. Russian does not: an adjective must agree with its noun in
gender and number, and a noun in a two-noun construction must be in the genitive.
Doing this at runtime with a morphology engine is out of the question — there is
one dependency and it is `three`. The answer is four rules, all of which move the
work to authoring time.

---

**G1 — Every Russian noun in a data table carries a gender tag.**

Item bases, monster archetypes and rare-name heads each declare
`g: 'm' | 'f' | 'n' | 'p'`. Item bases: *Топор* `m`, *Кольчуга* `f`, *Кольцо*
`n`, *Сапоги* `p`. Monster archetypes: §6.4's table. This is one character per
row and it is the only new field.

**G2 — Every Russian adjective is stored as four strings, not one.**

Affix prefixes, monster affixes, champion titles and unique epithets are stored
under `<key>.m`, `<key>.f`, `<key>.n`, `<key>.p`. Resolution is
`ui.adj(key, gender)` → `t(key + '.' + gender)` with a fallback to `t(key)`, so
English — which has one form — needs no extra rows and the §14.1 fallback chain
is unchanged. Agreement is then a single array index:

```
adjective = ui.adj('monsterAffix.burning', ARCHETYPE[id].g);
// 'burning' + m → Огненный      Огненный Костяной ратник
// 'burning' + f → Огненная      Огненная Стая падальщиков
```

**G3 — Two-noun constructions are authored in the genitive, never derived.**

The rare-item tail pool is stored **already inflected**. `name.rare.tail.1` is
`Праха`, not `Прах`; `name.rare.tail.13` is `Учителя`, not `Учитель`. A genitive
noun does not agree with anything — it does not change when the head changes
gender — so `Погибель Праха` (f + gen) and `Клык Праха` (m + gen) are both
correct with zero runtime work. The same trick carries the magic-item suffix:
`affix.sfx_fortitude` is `Стойкости`, and it is correct after *Топор*,
*Кольчуга* and *Сапоги* alike.

This is the load-bearing decision. It converts the hardest Russian problem in
generated naming — case and agreement between two arbitrary nouns — into a
choice of construction made once, in this document, and then into pure
concatenation forever.

**G4 — A proper name interpolated into a sentence is quoted and stays
nominative.**

Russian would normally decline *«Продать Топор Стойкости?»* → *«Продать Топор
Стойкости?»* (accusative, which happens to be identical here) but
*«Войти в Кости Предела»* → *«Войти в Кости Предела»* requires the accusative of
a plural-only noun, and *«Открыта сложность Отречение»* requires nothing at all
because the noun is neuter. Rather than tabulate six cases for every proper name
in the game, every interpolated name is **wrapped in guillemets and left in the
nominative**:

> `vendor.confirmSell` = `Продать «{name}» за {v} зол.?`
> `banner.difficultyUnlocked` = `Открыта сложность «{difficulty}»`
> `system.zoneCleared` = `«{zone}» — зачищено`

`09-ui.md` §14.3 already writes eleven of its Russian templates this way
(`toast.identified`, `container.dropConfirm`, `stat.skillsTree`, …), so G4 is
not a new convention — it is the existing one, made explicit and made binding.
Quoted-nominative is grammatical Russian, it is what a Russian UI does, and it
is the reason this document ships **zero** case tables.

---

**Where the four rules leave the runtime.** One index into a four-element array
for adjectives; one string concatenation for everything else; no branching on
language inside the generator. `items.rollName()` is the same function in both
languages and `tools/lootsim.mjs` produces identical *indices* regardless of the
active dictionary, which is what keeps the loot harness language-independent.

**The test.** `L10` (§12) asserts, for every one of the 56 rare heads × 48 tails
× every item base gender, that the produced Russian string's first word matches
the expected form from the four-string table. It is 2 688 × 4 assertions, it runs
in Node in under 40 ms, and it fails loudly the first time somebody adds an
adjective with only one form.

### 10.5 Rare item pools — complete

**Heads** — `name.rare.head.1` … `.56`. Russian nominative; `g` is the gender tag
in `RARE_HEAD`.

| # | EN | RU | g | # | EN | RU | g |
|---:|---|---|---|---:|---|---|---|
| 1 | Ash | Пепел | m | 29 | Verse | Стих | m |
| 2 | Bone | Кость | f | 30 | Line | Строка | f |
| 3 | Ember | Уголь | m | 31 | Page | Страница | f |
| 4 | Cinder | Головня | f | 32 | Mark | Метка | f |
| 5 | Word | Слово | n | 33 | Brand | Клеймо | n |
| 6 | Silence | Тишина | f | 34 | Seal | Печать | f |
| 7 | Doom | Погибель | f | 35 | Key | Ключ | m |
| 8 | Ruin | Разор | m | 36 | Lock | Замок | m |
| 9 | Grief | Скорбь | f | 37 | Bar | Затвор | m |
| 10 | Dusk | Сумрак | m | 38 | Lantern | Фонарь | m |
| 11 | Iron | Железо | n | 39 | Wick | Фитиль | m |
| 12 | Fang | Клык | m | 40 | Smoke | Дым | m |
| 13 | Claw | Коготь | m | 41 | Soot | Сажа | f |
| 14 | Sigh | Вздох | m | 42 | Slag | Шлак | m |
| 15 | Whisper | Шёпот | m | 43 | Rust | Ржавчина | f |
| 16 | Oath | Клятва | f | 44 | Frost | Иней | m |
| 17 | Vow | Обет | m | 45 | Storm | Буря | f |
| 18 | Scar | Рубец | m | 46 | Gale | Вихрь | m |
| 19 | Wound | Рана | f | 47 | Tide | Прилив | m |
| 20 | Thorn | Шип | m | 48 | Trace | След | m |
| 21 | Shard | Осколок | m | 49 | Echo | Эхо | n |
| 22 | Splinter | Заноза | f | 50 | Tremor | Дрожь | f |
| 23 | Hollow | Пустота | f | 51 | Toll | Набат | m |
| 24 | Husk | Оболочка | f | 52 | Knell | Звон | m |
| 25 | Cage | Клеть | f | 53 | Dirge | Плач | m |
| 26 | Chain | Цепь | f | 54 | Lesson | Урок | m |
| 27 | Nail | Гвоздь | m | 55 | Charge | Наказ | m |
| 28 | Wedge | Клин | m | 56 | Reckoning | Расплата | f |

**Tails** — `name.rare.tail.1` … `.48`. Russian is **pre-inflected genitive**
(rule G3). `def` marks the English tails that read as *"of the …"*.

| # | EN | RU (gen.) | def | # | EN | RU (gen.) | def |
|---:|---|---|:-:|---:|---|---|:-:|
| 1 | Ash | Праха | | 25 | Autumn | Осени | |
| 2 | Bone | Кости | | 26 | Hunger | Голода | |
| 3 | Cinders | Пепла | | 27 | Thirst | Жажды | |
| 4 | Night | Ночи | | 28 | Wrath | Гнева | |
| 5 | Dust | Пыли | | 29 | Spite | Злобы | |
| 6 | Flame | Пламени | | 30 | Mercy | Милости | |
| 7 | Heat | Жара | | 31 | Ruin | Разрухи | |
| 8 | Sorrow | Печали | | 32 | the Ending | Исхода | ✔ |
| 9 | Silence | Молчания | | 33 | the Last Hour | Последнего часа | ✔ |
| 10 | the Instructor | Наставника | ✔ | 34 | the First Lesson | Первого урока | ✔ |
| 11 | the Choir | Хора | ✔ | 35 | the Hollow | Пустоты | ✔ |
| 12 | the Pupil | Ученика | ✔ | 36 | the Deep | Глубины | ✔ |
| 13 | the Master | Учителя | ✔ | 37 | the Fall | Падения | ✔ |
| 14 | the Word | Слова | ✔ | 38 | the Long Road | Долгой дороги | ✔ |
| 15 | the Vault | Склепа | ✔ | 39 | Iron | Железа | |
| 16 | the Crypt | Усыпальницы | ✔ | 40 | Salt | Соли | |
| 17 | the Well | Колодца | ✔ | 41 | Glass | Стекла | |
| 18 | the Pyre | Костра | ✔ | 42 | Cold | Стужи | |
| 19 | the Forge | Горна | ✔ | 43 | Smoke | Дыма | |
| 20 | the Quarry | Каменоломни | ✔ | 44 | Rot | Гнили | |
| 21 | the Waste | Пустоши | ✔ | 45 | Bile | Желчи | |
| 22 | the Gate | Врат | ✔ | 46 | the Faithless | Отступника | ✔ |
| 23 | the Threshold | Порога | ✔ | 47 | the Nameless | Безымянного | ✔ |
| 24 | Winter | Зимы | | 48 | the Unlearned | Неучёного | ✔ |

Worked: head 7 + tail 1 → **Doom Ash** / **Погибель Праха**. Head 12 + tail 10 →
**Fang of the Instructor** / **Клык Наставника**. Head 5 + tail 34 →
**Word of the First Lesson** / **Слово Первого урока**.

### 10.6 Unique monster names — complete

**Given names** — `name.unique.given.1` … `.40`, with the gender tag that
selects the epithet's form.

| # | EN | RU | g | # | EN | RU | g | # | EN | RU | g | # | EN | RU | g |
|---:|---|---|---|---:|---|---|---|---:|---|---|---|---:|---|---|---|
| 1 | Verrin | Веррин | m | 11 | Anser | Ансер | m | 21 | Salvin | Сальвин | m | 31 | Trebek | Требек | m |
| 2 | Karth | Карт | m | 12 | Nedra | Недра | f | 22 | Berd | Берд | m | 32 | Yannic | Янник | m |
| 3 | Molra | Молра | f | 13 | Vosk | Воск | m | 23 | Quenn | Квенна | f | 33 | Ulme | Ульма | f |
| 4 | Esk | Эск | m | 14 | Halim | Халим | m | 24 | Lorric | Лоррик | m | 34 | Kestrel | Кестрель | m |
| 5 | Thalin | Талин | m | 15 | Perrin | Перрин | m | 25 | Ashen | Ашен | m | 35 | Dorn | Дорн | m |
| 6 | Ruve | Рува | f | 16 | Ysolde | Изольда | f | 26 | Draval | Дравал | m | 36 | Havik | Хавик | m |
| 7 | Ordan | Ордан | m | 17 | Grell | Грелл | m | 27 | Ivet | Ивета | f | 37 | Serla | Серла | f |
| 8 | Sevka | Севка | f | 18 | Marn | Марн | m | 28 | Cardis | Кардис | m | 38 | Barrow | Бэрроу | m |
| 9 | Brem | Брем | m | 19 | Teska | Теска | f | 29 | Fenwold | Фенвольд | m | 39 | Nikkas | Никкас | m |
| 10 | Ilth | Ильт | m | 20 | Odric | Одрик | m | 30 | Ossa | Осса | f | 40 | Greta | Грета | f |

**Epithets** — `name.unique.epithet.1` … `.32`. Russian carries `.m` and `.f`;
`.n` and `.p` are absent because a given name is never neuter or plural, and
`ui.adj` falls back to `.m` if one is ever added.

| # | EN | RU m / f | # | EN | RU m / f |
|---:|---|---|---:|---|---|
| 1 | the Unlearned | Неучёный / Неучёная | 17 | the Hollow | Полый / Полая |
| 2 | the Attentive | Прилежный / Прилежная | 18 | the Weeping | Плачущий / Плачущая |
| 3 | the Repeated | Повторённый / Повторённая | 19 | the Toothless | Беззубый / Беззубая |
| 4 | the Unfinished | Незаконченный / Незаконченная | 20 | the Ninefold | Девятикратный / Девятикратная |
| 5 | the Late | Опоздавший / Опоздавшая | 21 | the Left Behind | Оставленный / Оставленная |
| 6 | the Loud | Громкий / Громкая | 22 | the Uncorrected | Неисправленный / Неисправленная |
| 7 | the Quiet | Тихий / Тихая | 23 | the Overheard | Подслушанный / Подслушанная |
| 8 | the Twice-Burned | Дважды сожжённый / Дважды сожжённая | 24 | the Recited | Заученный / Заученная |
| 9 | the Ash-Fed | Пеплом вскормленный / Пеплом вскормленная | 25 | the Iron-Mouthed | Железноустый / Железноустая |
| 10 | the Unmarked | Неотмеченный / Неотмеченная | 26 | the Slow | Медленный / Медленная |
| 11 | the Cold-Handed | Хладорукий / Хладорукая | 27 | the Buried | Погребённый / Погребённая |
| 12 | the Splintered | Расколотый / Расколотая | 28 | the Bright | Светлый / Светлая |
| 13 | the Sworn | Присягнувший / Присягнувшая | 29 | the Nameless | Безымянный / Безымянная |
| 14 | the Forsworn | Отрёкшийся / Отрёкшаяся | 30 | the Last | Последний / Последняя |
| 15 | the Faithless | Вероломный / Вероломная | 31 | the Salted | Просоленный / Просоленная |
| 16 | the Patient | Терпеливый / Терпеливая | 32 | the Unread | Непрочитанный / Непрочитанная |

Worked: given 2 + epithet 1 → **Karth, the Unlearned** / **Карт Неучёный**.
Given 3 + epithet 1 → **Molra, the Unlearned** / **Молра Неучёная**. The English
comma is part of the construction; Russian has none.

### 10.7 Champion titles — complete

`name.champion.title.1` … `.24`. Russian carries all four forms because the
archetype it modifies can be masculine (*Костяной ратник*) or feminine
(*Стая падальщиков*), and because a future archetype may be neuter or plural.

| # | EN | RU m / f / n / pl |
|---:|---|---|
| 1 | Bloodstained | Окровавленный / Окровавленная / Окровавленное / Окровавленные |
| 2 | Sootbound | Закопчённый / Закопчённая / Закопчённое / Закопчённые |
| 3 | Wretched | Убогий / Убогая / Убогое / Убогие |
| 4 | Relentless | Неутомимый / Неутомимая / Неутомимое / Неутомимые |
| 5 | Malformed | Уродливый / Уродливая / Уродливое / Уродливые |
| 6 | Screaming | Кричащий / Кричащая / Кричащее / Кричащие |
| 7 | Sleepless | Бессонный / Бессонная / Бессонное / Бессонные |
| 8 | Ravenous | Ненасытный / Ненасытная / Ненасытное / Ненасытные |
| 9 | Blackened | Почерневший / Почерневшая / Почерневшее / Почерневшие |
| 10 | Scarred | Изрубцованный / Изрубцованная / Изрубцованное / Изрубцованные |
| 11 | Grim | Мрачный / Мрачная / Мрачное / Мрачные |
| 12 | Dreadful | Ужасающий / Ужасающая / Ужасающее / Ужасающие |
| 13 | Withered | Иссохший / Иссохшая / Иссохшее / Иссохшие |
| 14 | Bloated | Раздутый / Раздутая / Раздутое / Раздутые |
| 15 | Splintered | Расколотый / Расколотая / Расколотое / Расколотые |
| 16 | Wailing | Воющий / Воющая / Воющее / Воющие |
| 17 | Twisted | Скрюченный / Скрюченная / Скрюченное / Скрюченные |
| 18 | Merciless | Беспощадный / Беспощадная / Беспощадное / Беспощадные |
| 19 | Unquiet | Неупокоенный / Неупокоенная / Неупокоенное / Неупокоенные |
| 20 | Hoarse | Хриплый / Хриплая / Хриплое / Хриплые |
| 21 | Gilded | Позолоченный / Позолоченная / Позолоченное / Позолоченные |
| 22 | Rotting | Гниющий / Гниющая / Гниющее / Гниющие |
| 23 | Iron-Bound | Окованный / Окованная / Окованное / Окованные |
| 24 | Nameless | Безымянный / Безымянная / Безымянное / Безымянные |

Worked: title 1 + `bone_ranker` (m) → **Bloodstained Bone Ranker** /
**Окровавленный Костяной ратник**. Title 1 + `carrion_swarm` (f) →
**Bloodstained Carrion Swarm** / **Окровавленная Стая падальщиков**.

---

## 11. Tone guide

**How this game writes.** Short sentences. The median line in §7 and §8 is eight
words; the ceiling is 120 characters, which is two rendered lines in the dialogue
panel, and nothing exceeds it. Concrete nouns over abstractions — ash, bone,
stone, gate, thread, chalk, word — and verbs in the present tense. Adverbs only
when the adverb *is* the point ("finally, finally at a full stop"). Everyone
speaks about **things**: what a material does, how many of something there are,
how far away it is, and what a word is currently doing. The register is a
working town at the end of its patience, not a court and not a saga: nobody says
*thee*, *hark*, *mortal*, *ancient evil*, *darkness*, *destiny* or *magicks*.
The player is addressed as *you*, never as *hero*, *champion*, *chosen* or by
class name. Numbers are spoken aloud — "eighty spaces", "forty-one", "eleven
years" — because a character who counts is a character with a job.

**What it never does.** It never explains the setting. There is no exposition
NPC, no codex entry, no opening crawl: the lore arrives sideways, in Veren
complaining about ash in the joints and in Isa telling you not to read a thing
out loud, and a player who never opens a tooltip still learns how the world works
from the way people talk about it. It never uses an exclamation mark — nobody in
Last Bastion has the energy, and Molgrim's entire menace comes from not raising
his voice. It never comments on the player's performance: no congratulation, no
taunt written on the player's behalf, no line that only exists to tell you that
something was hard. Humour is dry, rare and never at a character's expense
except Molgrim's, and the joke about Molgrim is that he does not know he is in
one. Finally, it never writes a line the second dictionary cannot make idiomatic:
a pun that works only in English is a defect, and the Russian value is the test —
if the Russian has to become a paraphrase, the English is rewritten until both
are short and both are true.

### Three lines that work

| Line | Why |
|---|---|
| **"Dismissed."** — Molgrim, on killing the player | One word does the work of a paragraph: it establishes that he is a teacher, that he is not angry, and that your death was an administrative act. A longer line would only dilute it. |
| **"Steel keeps. Everything else, the ash eats."** — Veren | A world rule delivered as a shopkeeper's shrug. The player learns what the ash does and simultaneously learns that Veren does not consider it worth discussing. Lore arriving sideways, at eight words. |
| **"It's quieter. Not quiet. Quieter."** — Isa, after the quest | A correction, which is what every character in this world does instead of emoting, and it refuses the victory lap: the act ends with a small, precise, honest improvement rather than a saved world. |

### Three lines that were rejected

| Rejected line | Why it fails |
|---|---|
| *"Behold, mortal! You dare intrude upon the sanctum of the First Instructor?!"* | Two exclamation marks, an archaism, and a form of address ("mortal") that nobody in this game uses. It also tells the player they are intruding instead of letting Molgrim simply be annoyed, which is both longer and less frightening. |
| *"The ancient magicks of the Instruction were unleashed upon an unsuspecting world, dooming all to a fiery cataclysm."* | A summary pretending to be a line. Four adjectives, no speaker, and it contradicts the premise: the Instruction was **pedagogy, not sorcery**, and the word "magicks" undoes the one idea the setting is built on. |
| *"Ouch — that looked like it hurt!"* | Modern chat register, and it comments on the player rather than on the world. Nothing in Claudo II is chatty about damage; the damage number, the hit-stop and the screen impulse already said it, at zero words and in every language. |

---

## 12. Implementation order

Twelve steps. Each leaves `npm run build` green and `node tools/capture.mjs`
producing a frame, and each has an acceptance check that fails without the step.

| # | Step | Contents | Acceptance check |
|---|---|---|---|
| **L0** | Dictionary | All 473 keys of §7–§10 added to `EN` and `RU` in `src/ui/i18n.js`; `ui.adj(key, gender)`; the RU-only gendered variants. | The §14.1 boot check reports zero missing; `ui.t('dlg.veren.greet.1')` returns both languages; `ui.adj('monsterAffix.burning','f')` returns `Огненная` and `ui.adj('monsterAffix.burning','x')` falls back without throwing. |
| **L1** | Progression tables | `src/player/data/progression.js`: `XP_TABLE` (imported from `combat`, not copied), `OPENING_RAMP`, `CLASS_START_KIT`, `QUEST_XP`. Pure data, Node-loadable. | `node tools/balance.mjs --progression` reproduces §1.4 and §1.5 to the unit, and asserts the three boss levels 13 / 24 / 30. |
| **L2** | Quest definition and state machine | `src/player/data/quests.js`; the six trigger kinds; `advanceQuest` monotonicity; `quest:update` emission; `player.questState` / `questFlag`. | A headless script drives all seven steps and asserts the exact state chain. Replaying `zone:ready { bonereach }` five times awards 3 400 XP **once**. |
| **L3** | Save fields and invariants | `flags.slainOn`, `flags.rewardChoice`, invariants 16 and 17, the amended invariant 4. | `tools/save-fuzz.mjs` gains a v1 fixture with a mid-quest character; a hand-corrupted save claiming the reward twice is quarantined, not loaded. |
| **L4** | The Gate of Instruction | `world.setExitSealed`; `player` calls it on `quest:update` and `zone:ready`; `prompt.gateSealed`. | `tools/playtest.mjs`: a character that never spoke to Kaira is refused at the Gate on ten seeds; accepting the quest and reaching step 3 opens it on all ten. |
| **L5** | Reward grant | The reward screen, `items.grantUnique`, the three uniques, `skillBonuses.all += 1` on the `quest` layer, `questSkillPointsGranted`. | Every skill's effective level rises by exactly 1 and no allocated level changes; a second turn-in returns `false` and emits nothing; a full inventory produces `reward.held` and the item survives a reload. |
| **L6** | Difficulty chain | `flags.slainOn[tier]`, `difficultyUnlocked` derivation, `player.setDifficulty` refusal, Kaira's difficulty node. | Killing Molgrim on Instruction unlocks exactly `trial`; killing on Trial unlocks exactly `renunciation`; `setDifficulty('renunciation')` before the Trial kill returns `false`. |
| **L7** | Character creation | The three dossiers, the difficulty pips, the starting kits, the pre-spent skill point, the extended name pattern. | Three characters created; each holds precisely the §4.3 kit; `save.validate()` passes invariants 3 and 4 on all three; a Cyrillic name round-trips through `localStorage`. |
| **L8** | NPC dialogue | The five line families, the non-repeating rotation, the quest-stage override, the idle-bark timer. | A scripted town visit shows a distinct greeting on each of five consecutive openings per NPC; every NPC returns a non-empty line for all five quest states; no bark fires while a panel is open. |
| **L9** | Molgrim | All eighteen lines on their triggers, the rate limits, world-anchored rendering. | A scripted three-phase fight fires entry ×2, both phase lines, at least three distinct taunts, and both death lines in order; no taunt repeats inside 14 s. |
| **L10** | Naming and agreement | The five pools, `items.rollName()`, the 64-entry recent ring, `ui.adj` integration for monster affixes and champion titles. | 5 000 generated rare names contain no repeat in any 64-name window; the 2 688 × 4 agreement assertion of §10.4 passes; `tools/lootsim.mjs` produces identical index sequences under `EN` and `RU`. |
| **L11** | Level cap | The `experience` clamp, `hud.maxLevel` in place of the XP fraction, `banner.maxLevel` once, the zero death penalty. | A character forced to 317 106 XP gains no points from further kills, shows `hud.maxLevel`, and loses zero experience on death; `banner.maxLevel` fires exactly once across two deaths and a reload. |
| **L12** | End to end | Nothing new — the integration run. | `tools/playtest.mjs --campaign`: create → four Instruction descents → Molgrim → reward → Trial unlocked, on three seeds, reaching level 13 ± 1 at the boss on every one. |

L0 and L1 are the critical path: nothing else in this document can be tested
without the dictionary and the tables. L5 and L10 carry the real risk — L5
because it is the only irreversible grant in the game, and L10 because it is the
only place two languages diverge structurally.

---

## 13. Additions folded into `02-api-contracts.md`

> **Status: applied.** All nine methods are in `02-api-contracts.md` §§14, 13, 5
> and 11. Kept as rationale, not as a request.

Nine methods. Each lives in the subsystem that already owns the state it touches;
none moves ownership. `player.questTracker` is **not** listed — `09-ui.md` §16.4
already requests it, and this document only notes that its `steps[]` entries
carry the `quest.<id>.step.<n>` keys of §9.6.

### 13.1 `ui` — §14

| Method | Signature | Fixed | Alloc | Why |
|---|---|---|---|---|
| `adj` | `(key:string, gender:'m'\|'f'\|'n'\|'p') => string` | N | no | The Russian agreement mechanism of §10.4 rule G2. `t()` cannot do it: a gendered adjective is four dictionary entries in Russian and one in English, and every caller would otherwise have to build the suffixed key itself and know the fallback rule. One method, four callers (`monsterAffix`, champion titles, unique epithets, magic-item prefixes). |
| `dialogueLine` | `(npcId:string, key:string, params?:object) => void` | N | no | `openDialogue(npcId, nodeId)` opens the panel; there is no way to put a *line* in it. The dialogue content is chosen by `player` (it depends on quest state) and rendered by `ui`, so the line has to cross the boundary. |
| `worldLine` | `(actorId:int, key:string, seconds:number) => void` | N | pool | Molgrim's eighteen lines render above his head during a fight (§8.2), not in a panel. `floatingText(x,y,z,text,colour)` takes a *resolved string* and a world position, so `ai` would have to call `ui.t` and track the boss's transform every frame. This takes an actor id and follows it. |
| `setScreen` — enum extension | add `'reward_choice'` | N | yes | `09-ui.md` §16.1 requests `setScreen` with five screens. The reward choice (§9.9) is a sixth: a modal over the game, not a panel, because it must not be dismissible. |

### 13.2 `player` — §13

| Method | Signature | Fixed | Alloc | Why |
|---|---|---|---|---|
| `questFlag` | `(questId:string, flag:string) => boolean\|int` | **Y** | no | `questState()` returns the whole `{state, step, flags}` object, which allocates nothing but hands a mutable reference to every caller. `world` needs exactly one boolean (`step >= 3`) to seal a gate and `ai` needs one to know whether the altar is live. |
| `setQuestFlag` | `(questId:string, flag:string, value) => void` | **Y** | no | The `kill` and `interact` triggers of §2.2 write flags from `fixedUpdate`. Without this, `combat`'s `actor:death` handler would have to reach into the save object. |
| `startingKit` | `(classId:string) => { items:[], gold:int, skill:string }` | N | yes | Character creation needs the kit before an `Actor` exists, and `items` must not own class data. Read-only view onto `CLASS_START_KIT`. |

### 13.3 `world` — §5

| Method | Signature | Fixed | Alloc | Why |
|---|---|---|---|---|
| `setExitSealed` | `(zoneId:string, exitTag:string, sealed:boolean) => void` | **Y** | no | §3.3's gate. `world` already listens to `quest:update` (`02-api-contracts.md` §5) but has no way to act on it — the exit trigger table is frozen at generation time. This flips one boolean on one `Interactable` and makes `interactableAt` return the sealed prompt instead of the transition. |

### 13.4 `items` — §11

| Method | Signature | Fixed | Alloc | Why |
|---|---|---|---|---|
| `grantUnique` | `(uniqueId:string, ilvl:int, actor:Actor) => ItemInstance \| null` | N | yes | The quest reward is the only item in the game created outside a treasure-class roll. `rollDrop` cannot express "this specific unique, identified, at this ilvl, into this inventory". Returns `null` when there is no room, which is what drives `reward.noRoom`. |
| `rollName` | `(item:ItemInstance, rng:Rng) => void` | **Y** | no | Names the item in place using §10's pools and the recent ring. It is listed here because the ring is `items`-owned state that `tools/lootsim.mjs` must be able to reset between batches, and because the draw order is part of the determinism contract of `ARCHITECTURE.md`. |

---

## 14. Cross-document conflicts — all eight resolved

Eight items. Six were conflicts between shipped documents that this one had to
resolve to compute anything; two were single-field requests. **All eight have
been applied in the documents that own them** — the "Resolution" column below is
what shipped, not what was asked for.

| # | Where | What | Resolution used here |
|---:|---|---|---|
| **C1** | `07-world-gen.md` §8.6 vs `03-combat-math.md` §10.2 | `DIFFICULTY_MLVL_OFFSET` is `+0 / +9 / +17` in world-gen and `+0 / +12 / +22` in combat, giving zone levels 6/15/24 versus 6/18/28. | **Applied.** `07` §8.6 now carries `+0 / +12 / +22` and 6/18/28, 11/23/33, 15/27/37; `06` D-5 records the same decision. `mapgen` fixtures regenerate against the new numbers. |
| **C2** | `07-world-gen.md` §4.1 | The Bonereach bestiary lists `hammerfell_brute`; no such archetype exists. | **Applied.** The id is `maulsmith` in `07`; `04` §14's open question about a seventh archetype is closed with it. |
| **C3** | `08-characters-visual.md` §7.1 | Uses "Bone Ratling" and "Ash Archer". | **Applied.** `08`, `10`, `11` and `07` now use Bone Ranker / Ashen Archer / Maulsmith / Blight Crawler throughout, and the audio ids `ratling.*` and `brute.*` are `ranker.*` and `maulsmith.*`. |
| **C4** | `03-combat-math.md` §4.6 | `wand_ember_normal` is `reqLevel: 5`, and it is the only caster weapon in the reference set. An Emberwright therefore starts with an empty main hand. | **Applied.** `reqLevel` is 1 in `03` §4.6 and `04` §1.2. The damage did not move, so the row sits 29 % above `casterBaseDps(1)`; `04` §1.1 names it as the single expected curve exception and says why it is affordable. |
| **C5** | `01-data-model.md` §10.3 invariant 4 | `Σ skills + unspent === level − 1` cannot hold with a pre-spent starting skill point. | **Applied.** Invariant 4 reads `Σ skills.values − Σ classStartSkills + unspentSkillPoints === level − 1`. No version bump. |
| **C6** | `09-ui.md` §3.5 | The name pattern `[A-Za-z][A-Za-z0-9 '-]{0,15}` excludes Cyrillic, so a Russian player cannot type a Russian name. | **Applied.** The pattern is `[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9 '-]{0,15}`. |
| **C7** | `07-world-gen.md` §5.2 | The Altar has a chest at `(0, +14)` but no interactable on the altar block itself, so the First Tablet cannot be taken. | **Applied.** `Interactable { id:'altar_tablet', kind:'altar', x:0, z:+18.2, radius:2.0 }` is in `07` §5.2's arena table, inert until `bossDefeated`. |
| **C8** | `07-world-gen.md` §8.3 | `PackDescriptor.mlvl` is assigned from `descriptor.monsterLevel` with no per-pack variation, so §1.2's opening ramp has nowhere to apply. | **Applied.** Step 3b of `07` §8.3 assigns `p.mlvl` from `OPENING_RAMP` or the tier formula, and §8.6 records that this is the generator's only source of per-pack `mlvl` variation. |

C1 was the only one that changed numbers elsewhere, and it changed them in the
direction this document already computed against — every figure in §1 was
written for 6/11/15, 18/23/27, 28/33/37 and none of them moved. C4, C5, C6 and
C7 were one-line fixes. C8 was the single genuine feature request and §1.2
carries its justification.

---

## 15. Deviations from the plan

**D-19 — the Instruction tier is four descents, not one.**
`IMPLEMENTATION_PLAN.md` §4.7 describes a loop, and it is easy to read that loop
as one pass ending in a boss kill. The binding numbers refuse it: one full pass
through 157 monsters yields 6 318 field experience, and `XP_TOTAL(13)` — the
level at which `03-combat-math.md` §11.4 calibrates the Molgrim fight — is
31 977. Four descents plus 8 000 of quest experience lands on 32 493, and the
alternative (raising the yield fivefold, or dropping the boss to level 8 against
a 3 091-life enemy that deals 196–367 per sweep) breaks a binding document
either way. Four descents is also, plainly, a normal Act I: the boss room is
found long before the boss is beaten, and the three failed approaches are where
the character's gear actually comes from.

**D-20 — the Ashen Wastes have an opening monster-level ramp.**
The plan gives the Wastes a single `monsterLevel: 6` and the act a single open
zone. A level-1 character against a level-6 monster hits 21.4 % of the time and
spends twenty seconds per trash kill. Diablo II solved this with five zones at
levels 1, 2, 4, 5 and 6; with one zone the only place left to put the ramp is
inside it. It is first-visit-only, distance-keyed, costs 282 experience once,
and switches itself off the moment the quest reaches step 3.

**D-21 — the quest awards experience.**
Diablo II's quest rewards are items and permanent bonuses only. This one adds
8 000 experience across three steps, which is 24.6 % of the climb to the boss.
It is not there to shorten the act; it is there to remove the two cliffs the
curve creates — level 1, and the mlvl 6 → 11 doorway into Bonereach — by
arriving exactly at them. Every other level in the game is paid for by monsters.

**D-22 — the Gate of Instruction is quest-sealed.**
The plan gates nothing. A player who skips Kaira and walks straight down reaches
a 3 091-life boss at level 4, dies, and learns nothing except that the game let
them. One boolean prevents it and gives Kaira a reason to hand over the Cinder
Sigil, which is the only piece of fiction the act needed and did not have.

**D-23 — every class starts with one skill point already spent.**
The plan awards points from level 2. A character whose first fight is a basic
attack has not met their class yet, and the first fight is where a player decides
whether they like it. The point is granted as a class starting allocation, like
starting attributes, and invariant 4 gains the matching term (C5).

**D-24 — Molgrim speaks during the fight, not in a cutscene.**
The plan has no boss dialogue at all. Eighteen short world-anchored lines cost
nothing, never pause the fight, and do the entire job of characterising him —
because a boss who calmly corrects your technique while killing you is
frightening in a way a pre-fight monologue is not. `09-ui.md` §10.7's 2 400 ms
boss introduction is the only moment the camera is his, and two lines fit inside
it.



