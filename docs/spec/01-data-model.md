# 01 — Data Model

**Claudo II: Lord of Instruction** — the canonical runtime data structures.

This document is the vocabulary every other specification and every subsystem
builds on. Where another document names a stat, a slot, an element, a status or
a field, it uses the identifier defined here. Nothing outside this document may
invent a stat identifier.

**Conventions used throughout:**

| Convention | Rule |
|---|---|
| Units | Distance **metres**, time **seconds**, mass **kilograms**, angle **radians** |
| Percent stats | Whole numbers. `enhancedDamage: 40` means **+40 %**. Never `0.40` |
| Chance stats | Whole-number percent, `0..100`, unless a field says otherwise |
| Rate stats | Per **second**, never per tick and never per frame |
| Identifiers | `lowerCamelCase` for fields, `snake_case` for data-table ids, `PascalCase` for record types |
| Integers | Fields whose comment says `int` must hold an integer at all times |
| Simulation step | `h = 1/60 s` exactly. Written `FIXED_DT` |
| Absent value | `null`, never `undefined`, never `-1` as a sentinel |

**Language:** all identifiers, table keys and default display strings are
English. The Russian dictionary in `src/ui/i18n.js` maps display strings only —
it never mirrors an identifier.

---

## Table of contents

1. [Enumerations](#1-enumerations)
2. [Actor](#2-actor)
3. [StatBlock — the canonical stat vocabulary](#3-statblock--the-canonical-stat-vocabulary)
4. [StatSources and stat composition](#4-statsources-and-stat-composition)
5. [Items](#5-items)
6. [Skills](#6-skills)
7. [Status effects](#7-status-effects)
8. [Damage](#8-damage)
9. [World, zones and navigation](#9-world-zones-and-navigation)
10. [Save schema v1](#10-save-schema-v1)
11. [Object pools](#11-object-pools)
12. [Deviations from the plan](#12-deviations-from-the-plan)

---

## 1. Enumerations

Every enumeration below is a frozen string-keyed constant object exported from
the owning subsystem's `data/` folder. String values, never bare numbers —
saves are readable and a renumbering never silently corrupts a save.

### 1.1 Elements

```js
/** src/combat/data/elements.js */
export const ELEMENT = Object.freeze({
  physical:  'physical',
  fire:      'fire',
  cold:      'cold',
  lightning: 'lightning',
  poison:    'poison',
  magic:     'magic',
});
/** Iteration order is fixed. Every loop over elements uses this array so that
 *  RNG draw order is identical in the browser and in the Node harness. */
export const ELEMENT_ORDER = Object.freeze([
  'physical', 'fire', 'cold', 'lightning', 'poison', 'magic',
]);
```

`magic` is unresistable by resistance *pierce* and has no status of its own; it
exists so `cascade`, `unity` and unique-item procs have a damage type that is
neither physical (blocked by armour) nor elemental (walled off by immunities).

### 1.2 Teams

```js
export const TEAM = Object.freeze({
  player:  0,   // the character and anything it owns
  monster: 1,   // everything hostile
  neutral: 2,   // town NPCs, breakables, the stash — never targeted by attacks
});
```

Hostility test: `a.team !== b.team && a.team !== TEAM.neutral && b.team !== TEAM.neutral`.
Summons (`echo_blade`, Dust Shaman revivals) inherit `team` from `ownerId`.

### 1.3 Actor kinds and ranks

```js
export const ACTOR_KIND = Object.freeze({
  player:  'player',
  monster: 'monster',
  npc:     'npc',
  summon:  'summon',
  prop:    'prop',        // destructible barrel/urn: has life, no brain
});

export const ACTOR_RANK = Object.freeze({
  normal:   'normal',
  minion:   'minion',     // escort of a unique
  champion: 'champion',
  unique:   'unique',
  boss:     'boss',
});
```

### 1.4 Action states (owned by `actors`)

`actor.state` is the **animation / action** state machine. It is *not* the AI
decision state — that lives on the brain record owned by `ai` (§9.6).

```js
export const ACTOR_STATE = Object.freeze({
  spawning:   'spawning',   // materialising, invulnerable, no collision
  idle:       'idle',
  move:       'move',
  windup:     'windup',     // telegraph; cancellable by hitstun only
  active:     'active',     // the damage window of an action
  recover:    'recover',    // post-action lock
  channel:    'channel',    // whirlwind, ash wall placement
  hitstun:    'hitstun',    // hit recovery, see 03-combat-math §7
  knockback:  'knockback',
  interact:   'interact',   // vendor, stash, portal, quest dialogue
  dead:       'dead',
  despawning: 'despawning', // corpse fade / pool return
});
```

Legal transitions are declared as a frozen adjacency table in
`src/actors/data/states.js`; `actors.setState()` throws in dev builds on an
illegal transition. `dead` is terminal until the record is recycled.

### 1.5 Equipment slots

```js
export const SLOT = Object.freeze({
  head:     'head',
  chest:    'chest',
  hands:    'hands',
  legs:     'legs',        // greaves / boots
  mainHand: 'mainHand',
  offHand:  'offHand',     // shield or second weapon; blocked by two-handers
  belt:     'belt',
  amulet:   'amulet',
  ring1:    'ring1',
  ring2:    'ring2',
});
export const SLOT_ORDER = Object.freeze([
  'head', 'chest', 'hands', 'legs', 'mainHand', 'offHand',
  'belt', 'amulet', 'ring1', 'ring2',
]);
```

Ten slots. Four of them (`head`, `chest`, `mainHand`, `offHand`) drive visible
geometry on the character — see the render specification.

### 1.6 Rarities

```js
export const RARITY = Object.freeze({
  normal:   'normal',
  superior: 'superior',
  magic:    'magic',
  rare:     'rare',
  unique:   'unique',
});
export const RARITY_ORDER = Object.freeze(['normal','superior','magic','rare','unique']);
```

| Rarity | Colour | Affixes | Needs identify | Label ordinal |
|---|---|---|---|---|
| `normal` | `#c8c8c8` | none | no | 0 |
| `superior` | `#c8c8c8` | none; `+5..15 %` defence or damage | no | 1 |
| `magic` | `#6a7bff` | 1 prefix + 1 suffix, at least one | no | 2 |
| `rare` | `#ffe066` | 1–3 prefixes + 1–3 suffixes, total 2–6 | **yes** | 3 |
| `unique` | `#c8973f` | fixed mod list, values rolled in range | **yes** | 4 |

Rarity colours are sacred (`ARCHITECTURE.md` § Quality bar): `ui` and `fx` must
reproduce these exact hex values after tonemapping.

### 1.7 Difficulty tiers

```js
export const DIFFICULTY = Object.freeze({
  instruction:  'instruction',   // Normal
  trial:        'trial',         // Nightmare
  renunciation: 'renunciation',  // Hell
});
export const DIFFICULTY_ORDER = Object.freeze(['instruction','trial','renunciation']);
```

Numeric effects: `03-combat-math.md` §10.

### 1.8 Surface types

Shared vocabulary from `ARCHITECTURE.md`, restated so data tables can import it:

```js
export const SURFACE = Object.freeze({
  stone:'stone', dirt:'dirt', grass:'grass', sand:'sand', ash:'ash',
  wood:'wood', metal:'metal', water:'water', bone:'bone', flesh:'flesh',
  blood:'blood', crystal:'crystal',
});
```

### 1.9 Classes

```js
export const CLASS_ID = Object.freeze({
  ravager:     'ravager',
  emberwright: 'emberwright',
  runeblade:   'runeblade',
});
```

Secondary resource per class: Ravager → `rage`, Emberwright → *none*,
Runeblade → `resonance`. Every class uses `life`; Emberwright and Runeblade use
`mana`; the Ravager has a small mana pool (skills that cost mana are not on its
trees, but potions, auras and unique items may still touch it).

---

## 2. Actor

The universal record for **player, monster, NPC, summon and destructible prop**.
One shape, one pool, one update path. `actors` owns it exclusively; every other
subsystem reads it and writes only through `actors`' API (`02-api-contracts.md`
§2.7).

```js
/** src/actors/actor.js — created only by actors.acquire(), never with `new`. */
const Actor = {
  // ─── identity ───────────────────────────────────────────────────────────
  id:          0,          // int, unique for the process lifetime, 1..2^31-1, never reused
  generation:  0,          // int, incremented on every pool release; see ActorRef
  kind:        'monster',  // ACTOR_KIND
  rank:        'normal',   // ACTOR_RANK
  archetypeId: 'bone_ranker', // key into the class table or the bestiary
  classId:     null,       // CLASS_ID for kind==='player', else null
  name:        'Bone Ranker', // display string; uniques get a generated name
  team:        1,          // TEAM
  level:       10,         // int 1..40. Player: character level. Monster: mlvl
  flags:       0,          // uint32 bitfield, see ACTOR_FLAG below

  // ─── transform: simulation authority, written only in fixedUpdate ───────
  x:           0,          // metres, world space
  y:           0,          // metres, ground height at (x,z) + hover offset
  z:           0,          // metres
  facing:      0,          // radians, 0 = +X, CCW positive, wrapped to (-PI, PI]
  prevX:       0,          // previous fixed step, for update() interpolation
  prevY:       0,
  prevZ:       0,
  prevFacing:  0,

  // ─── transform: presentation, written only in update() ──────────────────
  renderX:     0,          // lerp(prevX, x, ctx.time.alpha)
  renderY:     0,
  renderZ:     0,
  renderFacing:0,          // shortest-arc slerp of prevFacing → facing

  // ─── motion ─────────────────────────────────────────────────────────────
  velX:        0,          // m/s, the velocity actually applied last step
  velZ:        0,
  desiredX:    0,          // m/s, what nav/input asked for before separation
  desiredZ:    0,
  speed:       0,          // m/s, |vel| cached for the animator
  radius:      0.36,       // metres, collision circle. 0.22..1.60
  height:      1.80,       // metres, for camera occlusion and projectile hits
  mass:        78,         // kg, drives knockback and separation weight
  hoverY:      0,          // metres above ground; flying/floating archetypes

  // ─── action state machine (owned by actors) ─────────────────────────────
  state:       'idle',     // ACTOR_STATE
  stateTime:   0,          // seconds in the current state, integrated at 60 Hz
  actionId:    null,       // skillId or 'attack' driving windup/active/recover
  actionPhase: 0,          // 0 windup, 1 active, 2 recover
  actionTimer: 0,          // seconds remaining in the current phase
  actionSeq:   0,          // int, +1 on every action start; invalidates stale callbacks
  actionLock:  false,      // true while movement input must be ignored
  hitsThisAction: 0,       // int, for multi-hit windows and pierce accounting

  // ─── vitals (current values; maxima live in `stats`) ─────────────────────
  life:        88,         // 0..stats.maxLife
  mana:        0,          // 0..stats.maxMana
  rage:        0,          // 0..stats.maxRage      (Ravager only, else 0)
  resonance:   0,          // 0..stats.maxResonance (Runeblade only, int)
  stamina:     0,          // 0..stats.maxStamina
  lifeAccum:   0,          // fractional life carry from regen/DoT; never displayed
  manaAccum:   0,          // fractional mana carry
  dead:        false,

  // ─── stats ──────────────────────────────────────────────────────────────
  attributes:  { strength: 30, dexterity: 20, vitality: 25, energy: 10 },
                           // int. Player: class start + allocated. Monster: 0s
  stats:       null,       // StatBlock — the composed, final block. Never null after init
  sources:     null,       // StatSources — per-layer partials, for the sheet
  statsDirty:  true,       // recomposed before the next fixedUpdate that reads it

  // ─── status effects ─────────────────────────────────────────────────────
  statuses:    [],         // StatusEffectInstance[], max 24, dense, unordered
  statusMask:  0,          // uint16 bitfield mirror of statuses for O(1) tests
  chillPoints: 0,          // 0..100, accumulator that converts chilled → frozen
  stunChain:   0,          // int 0..4, diminishing-returns counter
  stunChainAt: 0,          // simulation step index of the last stun
  ccImmuneUntil: 0,        // int, simulation step index

  // ─── combat bookkeeping ─────────────────────────────────────────────────
  attackReady:   0,        // int step index when the next attack may start
  castReady:     0,        // int step index when the next cast may start
  cooldowns:     null,     // Map<string skillId, int stepIndex>. Preallocated
  hitstunUntil:  0,        // int step index
  hitstunImmuneUntil: 0,   // int step index; stops stun-lock
  lastDamageStep: -1,      // int; drives the 4 s "in combat" window
  lastDealtStep:  -1,      // int
  lastAttackerId: 0,       // int actor id, 0 = none
  killerId:       0,       // int actor id, set once on death
  threat:        null,     // Map<int actorId, number> | null. Monsters only
  invulnUntil:    0,       // int step index; spawn protection, phase transitions

  // ─── references (ids, never object pointers) ────────────────────────────
  targetId:    0,          // int, 0 = none
  ownerId:     0,          // int, summoner / corpse owner
  packId:      0,          // int, PackInstance id
  zoneId:      'ashen_wastes',
  spawnPointId: 0,         // int, index into ZoneInstance.spawnPoints

  // ─── inventory (kind === 'player' only, else null) ──────────────────────
  equipment:   null,       // EquipmentSet
  inventory:   null,       // InventoryGrid 10×4
  belt:        null,       // BeltSlots ×4
  gold:        0,          // int

  // ─── presentation handles (written by actors, read by fx/ui/audio) ──────
  view: {
    root:      null,       // THREE.Group | null (headless harness: null)
    skeleton:  null,       // Skeleton
    animator:  null,       // Animator
    materialSet: null,     // MaterialSet key
    visible:   true,
    lod:       0,          // int 0 full, 1 reduced rate, 2 billboard
    hitStopUntil: 0,       // seconds on ctx.time.raw; presentation only
    flashUntil:   0,       // seconds on ctx.time.raw; damage flash
  },

  // ─── pooling ────────────────────────────────────────────────────────────
  active:      false,      // in the live list
  poolIndex:   -1,         // int index in the backing array
};
```

### 2.1 `ACTOR_FLAG` bitfield

```js
export const ACTOR_FLAG = Object.freeze({
  invulnerable:     1 << 0,   // ignores all damage
  untargetable:     1 << 1,   // click targeting and AI skip it
  noKnockback:      1 << 2,   // bosses, Maulsmith while winding up
  noCollide:        1 << 3,   // does not push or get pushed
  flying:           1 << 4,   // ignores hazard tiles, uses hoverY
  ranged:           1 << 5,   // AI keeps distance
  boss:             1 << 6,   // drives the boss health bar in ui
  summoned:         1 << 7,   // expires with its owner
  corpse:           1 << 8,   // dead, but revivable by dust_shaman
  revived:          1 << 9,   // was revived once; cannot be revived again
  questCritical:    1 << 10,  // never despawns on zone cleanup
  visualOnly:       1 << 11,  // echo_blade duplicate: deals damage, takes none
  perceptionAlerted:1 << 12,  // has ever seen the player in this zone
});
```

### 2.2 `ActorRef` — safe cross-frame references

Never hold an `Actor` across a frame boundary. Hold an `ActorRef` and resolve
it. `generation` makes a stale reference detectable after the pool recycles the
record.

```js
const ActorRef = {
  id:         0,   // int
  generation: 0,   // int
};
// resolve: actors.resolve(ref) -> Actor | null
```

Damage packets, projectiles, threat tables, summon ownership, quest state and
the boss's summon list all store `ActorRef`, never `Actor`.

### 2.3 Archetype records

An **archetype** is the static definition an actor is instantiated from.
Player archetypes live in `src/player/data/classes.js`; monster archetypes in
`src/ai/data/bestiary.js`. Numbers are in `03-combat-math.md` §§2, 9.

```js
const ClassArchetype = {
  id:            'ravager',       // CLASS_ID
  displayName:   'Ravager',
  baseLife:      55,              // life at level 1 with starting vitality
  lifePerVit:    4.0,             // life per point of vitality above the start
  lifePerLevel:  2.0,             // life per character level above 1
  baseMana:      10,
  manaPerEne:    1.0,
  manaPerLevel:  0.5,
  baseStamina:   60,              // + vitality × 1.0 + (level − 1) × 1.0
  start:         { strength: 30, dexterity: 20, vitality: 25, energy: 10 },
  classBaseAR:   30,              // flat attack-rating floor
  attackScale:   0.90,            // multiplier on weapon base attack time
  castScale:     1.15,            // multiplier on skill base cast time
  meleeScale:    1.00,            // multiplier on physical weapon damage
  spellScale:    0.85,            // multiplier on skill (non-weapon) damage
  manaRegenRate: 0.020,           // fraction of maxMana per second
  lifeRegenRate: 0.006,           // fraction of maxLife per second (0.006 for all three)
  runSpeed:      4.2,             // m/s before movementSpeed
  secondary:     'rage',          // 'rage' | 'resonance' | null
  trees:         ['carnage', 'unyielding'],
  startingItems: ['axe_hand_normal', 'armour_rags', 'potion_life_minor:3'],
  startGold:     120,
};

const MonsterArchetype = {
  id:            'bone_ranker',
  displayName:   'Bone Ranker',
  role:          'melee',         // 'melee'|'swarm'|'ranged'|'support'|'heavy'|'suicide'|'boss'
  baseLife:      20,              // at mlvl 1; scaled by the mlvl tables
  baseMinDamage: 3,
  baseMaxDamage: 6,
  baseDefense:   18,
  baseAttackRating: 45,
  baseXp:        7,
  attackTime:    1.40,            // seconds between attack starts, before IAS
  windupFrac:    0.42,            // fraction of attackTime spent telegraphing
  impactFrac:    0.58,            // fraction at which the damage window opens
  activeFrac:    0.12,            // width of the damage window
  attackRange:   1.9,             // metres, measured surface-to-surface
  aggroRadius:   13.0,
  leashRadius:   34.0,
  runSpeed:      3.2,             // m/s
  radius:        0.38,
  height:        1.85,
  mass:          78,
  resists:       { fire: 0, cold: 25, lightning: 0, poison: 50, magic: 0, physical: 0 },
  element:       'physical',      // element of its basic attack
  surface:       'bone',          // impact FX / audio material
  treasureClass: 'tc_humanoid',
  flags:         0,
  skills:        [],              // monster skill ids, see 03 §9.2
};
```

---

## 3. StatBlock — the canonical stat vocabulary

`StatBlock` is a flat object of numbers plus one structured sub-record. Every
field below exists on **every** actor, always, initialised to its base value —
there are no optional stats and no `undefined` reads. An implementation may back
the numeric fields with a `Float64Array` and a name→index map as an internal
optimisation, provided the accessor names are exactly these.

**Column meanings**

- **Aggregation** — how contributions from different sources combine:
  - `add` — plain sum.
  - `add→mul` — sources sum, and the *sum* is applied as a multiplier
    `(1 + sum / 100)` at a defined point in the pipeline. This is the D2 rule and
    it is why two `+40 % Enhanced Damage` items give `+80 %`, not `+96 %`.
  - `max` — the largest contribution wins; others are ignored.
  - `or` — boolean flags, logical OR.
- **Cap** — hard clamp applied at the end of composition. `—` means uncapped.
- **Sheet** — shown on the character sheet: `Y` always, `A` only on the
  advanced/expanded page, `N` never (internal).

### 3.1 Primary attributes

| Identifier | Type/units | Range | Aggregation | Cap | Sheet |
|---|---|---|---|---|---|
| `strength` | int | 1..600 | `add` | 600 | Y |
| `dexterity` | int | 1..600 | `add` | 600 | Y |
| `vitality` | int | 1..600 | `add` | 600 | Y |
| `energy` | int | 1..600 | `add` | 600 | Y |

Item requirements are checked against the **equipment-inclusive** attribute
totals, but an item may never satisfy its own requirement: composition runs the
requirement check against the block *without* that item (§4.4).

### 3.2 Vessels and regeneration

| Identifier | Type/units | Range | Aggregation | Cap | Sheet |
|---|---|---|---|---|---|
| `maxLife` | life points | 1..40000 | `add` | 40000 | Y |
| `lifePercent` | % | −90..+500 | `add→mul` | +500 | A |
| `maxMana` | mana points | 0..20000 | `add` | 20000 | Y |
| `manaPercent` | % | −90..+500 | `add→mul` | +500 | A |
| `maxRage` | rage points | 0..200 | `add` | 200 | Y (Ravager) |
| `maxResonance` | int charges | 0..8 | `add` | 8 | Y (Runeblade) |
| `maxStamina` | stamina points | 0..2000 | `add` | 2000 | A |
| `lifeRegen` | life / s, flat | −50..+200 | `add` | — | A |
| `lifeRegenPercent` | % of maxLife / s | −100..+20 | `add` | +20 | A |
| `manaRegen` | mana / s, flat | −50..+200 | `add` | — | A |
| `manaRegenPercent` | % of maxMana / s | −100..+20 | `add` | +20 | A |
| `staminaRegen` | stamina / s, flat | 0..100 | `add` | — | N |

`lifeRegenPercent` carries the class base rate (0.6 %/s for every class);
`manaRegenPercent` carries the class rate (2.0 / 4.0 / 3.0 %/s).

### 3.3 Offence

| Identifier | Type/units | Range | Aggregation | Cap | Sheet |
|---|---|---|---|---|---|
| `minDamage` | flat physical | 0..5000 | `add` | — | Y |
| `maxDamage` | flat physical | 0..5000 | `add` | — | Y |
| `enhancedDamage` | % | −100..+2000 | `add→mul` | +2000 | Y |
| `attackRating` | flat AR | 0..30000 | `add` | — | Y |
| `attackRatingPercent` | % | −100..+500 | `add→mul` | +500 | A |
| `increasedAttackSpeed` | % | −75..+300 | `add→mul` | +300 | Y |
| `fasterCastRate` | % | −75..+200 | `add→mul` | +200 | Y |
| `critChance` | % | 0..75 | `add` | **75** | Y |
| `critMult` | % of damage | 100..600 | `add` | 600 | Y |
| `fireMin` / `fireMax` | flat fire | 0..8000 | `add` | — | Y |
| `coldMin` / `coldMax` | flat cold | 0..8000 | `add` | — | Y |
| `lightMin` / `lightMax` | flat lightning | 0..8000 | `add` | — | Y |
| `poisonMin` / `poisonMax` | flat poison, **total over the DoT** | 0..8000 | `add` | — | Y |
| `magicMin` / `magicMax` | flat magic | 0..8000 | `add` | — | Y |
| `coldDuration` | s added to `chilled` | 0..8 | `add` | 8 | A |
| `poisonDuration` | s added to `poisoned` | 0..12 | `add` | 12 | A |
| `fireDamagePercent` | % | −100..+1000 | `add→mul` | +1000 | Y |
| `coldDamagePercent` | % | −100..+1000 | `add→mul` | +1000 | Y |
| `lightDamagePercent` | % | −100..+1000 | `add→mul` | +1000 | Y |
| `poisonDamagePercent` | % | −100..+1000 | `add→mul` | +1000 | Y |
| `magicDamagePercent` | % | −100..+1000 | `add→mul` | +1000 | Y |
| `elementalDamagePercent` | % applied to all five | −100..+1000 | `add→mul` | +1000 | A |
| `physicalDamagePercent` | % | −100..+1000 | `add→mul` | +1000 | A |
| `fireResistPierce` | points off target `fireResist` | 0..150 | `add` | 150 | A |
| `coldResistPierce` | points | 0..150 | `add` | 150 | A |
| `lightResistPierce` | points | 0..150 | `add` | 150 | A |
| `poisonResistPierce` | points | 0..150 | `add` | 150 | A |
| `lifeSteal` | % of physical dealt | 0..100 | `add` | **100** | Y |
| `manaSteal` | % of physical dealt | 0..100 | `add` | **100** | Y |
| `lifeOnHit` | flat life per landed hit | 0..500 | `add` | — | A |
| `manaOnHit` | flat mana per landed hit | 0..500 | `add` | — | A |
| `lifeOnKill` | flat life per kill | 0..500 | `add` | — | A |
| `manaOnKill` | flat mana per kill | 0..500 | `add` | — | A |
| `manaReturnPercent` | % of physical dealt → mana | 0..100 | `add` | 100 | Y (Runeblade) |
| `pierceChance` | % projectile passes through | 0..100 | `add` | 100 | A |
| `knockbackChance` | % | 0..100 | `add` | 100 | A |
| `thorns` | flat physical returned to melee attacker | 0..2000 | `add` | — | A |
| `rageOnHit` | rage per landed hit | 0..40 | `add` | 40 | A |
| `rageOnTakeHit` | rage per hit taken | 0..40 | `add` | 40 | A |
| `resonanceOnHit` | charges per landed hit | 0..4 | `add` | 4 | A |

`poisonMin` / `poisonMax` are the **total** poison damage of the application,
not a per-second rate; the DoT divides by its duration. This is deliberate: it
makes `poisonDuration` a pure duration extender rather than a damage multiplier,
which is the bug the D2 model is famous for.

### 3.4 Defence

| Identifier | Type/units | Range | Aggregation | Cap | Sheet |
|---|---|---|---|---|---|
| `defense` | flat DEF | 0..30000 | `add` | — | Y |
| `defensePercent` | % | −100..+1000 | `add→mul` | +1000 | A |
| `blockChance` | % (needs a shield) | 0..75 | `add` | **75** | Y |
| `dodgeChance` | % | 0..50 | `add` | **50** | Y |
| `fireResist` | points | −200..+200 | `add` | see `maxFireResist` | Y |
| `coldResist` | points | −200..+200 | `add` | see cap stat | Y |
| `lightResist` | points | −200..+200 | `add` | see cap stat | Y |
| `poisonResist` | points | −200..+200 | `add` | see cap stat | Y |
| `magicResist` | points | −200..+200 | `add` | see cap stat | Y |
| `physicalResist` | points | −200..+200 | `add` | see cap stat | Y |
| `maxFireResist` | cap in points | 0..90 | `add` | **90** | A |
| `maxColdResist` | cap in points | 0..90 | `add` | 90 | A |
| `maxLightResist` | cap in points | 0..90 | `add` | 90 | A |
| `maxPoisonResist` | cap in points | 0..90 | `add` | 90 | A |
| `maxMagicResist` | cap in points | 0..90 | `add` | 90 | A |
| `maxPhysicalResist` | cap in points | 0..90 | `add` | 90 | A |
| `damageReduceFlat` | flat, physical only | 0..2000 | `add` | — | Y |
| `damageReducePercent` | % physical | 0..50 | `add` | **50** | Y |
| `magicDamageReduceFlat` | flat, all non-physical | 0..2000 | `add` | — | A |
| `fasterHitRecovery` | % | −75..+400 | `add→mul` | +400 | Y |
| `ccReduction` | % duration cut on control effects | 0..75 | `add` | **75** | Y |
| `cannotBeFrozen` | flag | 0/1 | `or` | — | A |

The six `max*Resist` stats default to **75** (the cap in `ARCHITECTURE.md`).
They are the only way to exceed it, and they themselves cap at 90.
Negative resistance from difficulty is applied to the resist stat, not the cap.

### 3.5 Utility

| Identifier | Type/units | Range | Aggregation | Cap | Sheet |
|---|---|---|---|---|---|
| `movementSpeed` | % | −90..+200 | `add→mul` | +200 | Y |
| `magicFind` | % | 0..1000 | `add` | 1000 | Y |
| `goldFind` | % | 0..2000 | `add` | 2000 | Y |
| `manaCostReduction` | % | 0..75 | `add` | **75** | Y |
| `lightRadius` | metres added to the base 6 m | 0..14 | `max` | 14 | A |
| `requirementReduction` | % off item requirements | 0..80 | `add` | 80 | A |
| `damageTakenToMana` | % of damage taken → mana | 0..40 | `add` | 40 | A |
| `experienceGain` | % | −100..+200 | `add→mul` | +200 | A |
| `skillBonuses` | `SkillBonuses` record | — | see below | — | Y |

```js
const SkillBonuses = {
  all:   0,                     // int, +N to every skill of this actor
  tree:  { carnage: 0, ... },   // int, +N to every skill in a named tree
  skill: { whirlwind: 0, ... }, // int, +N to one skill
};
```

Aggregation for `SkillBonuses` is `add` at each of the three levels. Effective
skill level (§6.2) sums all three plus the allocated points.

### 3.6 Stat count and completeness

The block holds exactly **90 numeric fields**, one flag (`cannotBeFrozen`) and
one structured record (`skillBonuses`) — 92 identifiers in total, all listed
above. Nothing else. An affix, a skill or a difficulty modifier that cannot
express itself in these terms does not ship; it is redesigned until it can.

Split by group: 4 primary attributes, 12 vessel and regeneration, 45 offence,
21 defence (plus the flag), 8 utility (plus `skillBonuses`).

---

## 4. StatSources and stat composition

### 4.1 Layers

`StatSources` holds one *partial* `StatBlock` per layer. A partial contains only
the fields the layer actually contributes, so the character sheet can answer
"where do my 43 % fire resist come from" without re-running composition.

```js
const StatSources = {
  base:       {},   // class archetype × level; monsters: archetype × mlvl tables
  allocated:  {},   // the player's spent attribute points
  equipment:  {},   // every equipped ItemInstance, including its affixes
  skills:     {},   // passive skills and active buffs the actor owns
  status:     {},   // StatusEffectInstance modifiers currently applied
  difficulty: {},   // resistance penalties, monster tier multipliers
};
```

### 4.2 Composition order

Composition is a pure function. It must run identically in the browser and in
the Node balance harness, and it may not touch RNG, the clock or `three`.

```
composeStats(actor) →
  1. zero()                          reset every field to its type default
  2. += base                         class table / bestiary row
  3. += allocated                    attribute points
  4. += equipment                    in SLOT_ORDER, deterministic
  5. += skills                       in skill-registry order
  6. += status                       in statuses[] order (insertion order)
  7. += difficulty
  8. derive()                        formulas below
  9. clamp()                         every Cap column in §3
 10. actor.statsDirty = false
```

Layers 2–7 use the aggregation rule from §3 per field. `add` and `add→mul`
accumulate identically here — the difference is only *where the sum is used*.
`max` takes the running maximum. `or` ORs.

### 4.3 `derive()` — fields computed, not contributed

Run after summation, before clamping. Full derivations with numbers in
`03-combat-math.md` §2.

```
maxLife      = (classBaseLife + (vitality − classStartVit) × lifePerVit
                              + (level − 1) × lifePerLevel
                              + Σ flat maxLife) × (1 + lifePercent / 100)
maxMana      = (classBaseMana + (energy − classStartEne) × manaPerEne
                              + (level − 1) × manaPerLevel
                              + Σ flat maxMana) × (1 + manaPercent / 100)
maxStamina   =  classBaseStamina + vitality × 1.0 + (level − 1) × 1.0
                              + Σ flat maxStamina
attackRating = (classBaseAR + 5 × (dexterity − 7) + Σ flat attackRating)
                              × (1 + attackRatingPercent / 100)
defense      = (Σ item defence + Σ flat defense) × (1 + defensePercent / 100)
                              + floor(dexterity / 4)
lifeRegen   += maxLife × lifeRegenPercent / 100
manaRegen   += maxMana × manaRegenPercent / 100
```

`attackRating` clamps to `>= 0`. `defense` clamps to `>= 0`.

### 4.4 The equipment layer and requirement checking

Requirements are evaluated **before** the item's own contribution is summed, so
a `+20 Strength` sword can never satisfy its own 40-strength requirement:

```
requirementBase = base + allocated + (equipment layer minus the item under test)
itemUsable      = requirementBase.strength  >= item.reqStr  × (1 − requirementReduction/100)
               && requirementBase.dexterity >= item.reqDex  × (1 − requirementReduction/100)
               && actor.level               >= item.reqLevel
```

Chains are resolved by a **single fixed pass in `SLOT_ORDER`**, never by
iterating to a fixed point — iteration is order-dependent and would break
determinism. An item that fails its requirement stays equipped but is marked
`item.unusable = true` and contributes **nothing** except its own weight in the
paperdoll; `ui` draws its tooltip requirement line in red.

### 4.5 `stats:dirty`

Anything that changes a contribution emits `stats:dirty` with `{ actor }`.
`actors` sets `actor.statsDirty = true` and recomposes **once**, at the top of
the next `fixedUpdate`, before any subsystem reads `actor.stats`. Reading
`actor.stats` while `statsDirty` is true is a bug; in dev builds the getter
asserts.

Emitters and their triggers:

| Emitter | Trigger |
|---|---|
| `items` | equip, unequip, identify, socket change, durability reaching 0 or leaving 0 |
| `skills` | skill point spent, passive re-evaluated, buff applied or expired, `polarity` toggled |
| `combat` | status effect applied, refreshed or expired |
| `player` | level-up, attribute point spent, difficulty changed |
| `ai` | champion/unique affixes rolled at spawn, boss phase transition |

Recomposition cost budget: **≤ 40 µs** for a fully-equipped player, **≤ 6 µs**
for a monster. Monsters recompose at most once per second unless a status
changed.

---

## 5. Items

### 5.1 `ItemBase` — the static definition

Catalogued in `src/items/data/bases.js`. The complete catalogue is owned by the
items specification; this is the shape it must conform to.

```js
const ItemBase = {
  id:        'axe_battle_normal',   // snake_case, stable forever — saves store it
  name:      'Battle Axe',          // English display name
  category:  'weapon',              // 'weapon' | 'armour' | 'jewelry' | 'consumable' | 'quest'
  slot:      'mainHand',            // SLOT, or null for consumables
  tier:      'normal',              // 'normal' | 'exceptional' | 'elite'
  reqLevel:  9,                     // int, character level
  reqStr:    40,                    // int
  reqDex:    0,                     // int
  invW:      2,                     // int, inventory grid cells wide, 1..2
  invH:      3,                     // int, inventory grid cells tall, 1..4
  maxDurability: 55,                // int; 0 = indestructible (jewelry, quest)
  baseValue: 220,                   // int gold, before rarity/affix multipliers
  dropWeight: 100,                  // int, relative weight inside its treasure class
  iconSeed:  0x51c4,                // uint32, drives the procedural icon generator
  surface:   'metal',               // SURFACE, for pickup audio and icon material
  genderRu:  'm',                   // 'm'|'f'|'n'|'pl', default 'm'. Russian prefix
                                    // agreement: without it every magic item reads
                                    // with a masculine adjective on a feminine noun.
                                    // Static table only — never serialised.

  /** present iff category === 'weapon' */
  weapon: {
    minDamage: 10,                  // int
    maxDamage: 22,                  // int
    attackTime: 0.75,               // seconds per swing before IAS
    attackRating: 80,               // flat AR granted by the base
    twoHanded: false,
    range:     1.9,                 // metres, surface-to-surface
    handling:  'oneHandMelee',      // see 03-combat-math §4.5
    element:   'physical',
  },

  /** present iff category === 'armour' */
  armour: {
    defMin: 22,                     // int, rolled at drop time
    defMax: 38,                     // int
    blockBase: 0,                   // % base block; > 0 only on shields
    moveSpeedPenalty: 0,            // % subtracted from movementSpeed
  },

  /** present iff category === 'consumable' */
  consumable: {
    effect: 'restore_life',         // 'restore_life'|'restore_mana'|'restore_both'|'identify'|'town_portal'|'respec'
    amountPercent: 35,              // % of the relevant maximum
    overSeconds: 3.0,               // 0 = instant
    stackMax: 20,                   // int, cells stack this deep
  },

  allowedAffixGroups: ['weapon.melee', 'weapon.any', 'universal'],
  socketMax: 0,                     // int 0..6. Reserved: sockets ship after M9
};
```

### 5.2 `AffixDefinition` and `AffixInstance`

```js
/** src/items/data/affixes.js — static */
const AffixDefinition = {
  id:      'pfx_enhanced_damage_3',
  kind:    'prefix',                // 'prefix' | 'suffix'
  group:   'enhanced_damage',       // one affix per group per item
  name:    'Keen',                  // prefix: prepended. suffix: 'of the Legion'
  alvl:    8,                       // int, minimum item level to roll
  maxLevel: 40,                     // int, above this the affix stops rolling
  weight:  60,                      // int, relative weight inside the filtered pool
  appliesTo: ['weapon'],            // ItemBase.category values
  requiresGroups: ['weapon.melee'], // must intersect base.allowedAffixGroups
  sharedRoll: false,                // true → ONE draw is written to every entry of
                                    // values[], instead of one draw per mod. This is
                                    // the precondition for the all-resistances merge
                                    // in the tooltip. Static table only.
  mods: [
    { stat: 'enhancedDamage', min: 30, max: 50, step: 1 },
  ],
};

/** rolled onto an ItemInstance — this is what the save stores */
const AffixInstance = {
  id:      'pfx_enhanced_damage_3',  // key back into the definition table
  kind:    'prefix',
  values:  [40],                     // one rolled number per entry in mods[], in order
};
```

`values` is a plain number array, positionally aligned with `mods`. Rolling
uses the `items` RNG stream in the fixed order declared in `ARCHITECTURE.md`
(base → quality → affix count → affix pick → affix values), and inside "affix
values" the order is: all prefixes in pick order, then all suffixes in pick
order, and inside one affix, `mods` in array order. Never deviate — the loot
harness reproduces exact histograms from a seed.

### 5.3 `ItemInstance` — the runtime and serialised record

```js
const ItemInstance = {
  uid:        1743,          // int, unique within a save file; assigned by items
  baseId:     'axe_battle_normal',
  rarity:     'magic',       // RARITY
  ilvl:       12,            // int, item level; gates which affixes could roll
  identified: true,
  quantity:   1,             // int; > 1 only for stackable consumables

  /** rolled at drop time, immutable afterwards */
  rolls: {
    defense:   0,            // int, rolled in [armour.defMin, armour.defMax]; 0 for weapons
    superior:  0,            // int %, 5..15, only when rarity === 'superior'
    damageMin: 10,           // int, copied from the base (uniques may override)
    damageMax: 22,           // int
  },

  affixes:    [              // AffixInstance[]; [] for normal/superior
    { id: 'pfx_enhanced_damage_3', kind: 'prefix', values: [40] },
    { id: 'sfx_attack_rating_2',   kind: 'suffix', values: [15] },
  ],
  uniqueId:   null,          // 'ashen_crown' when rarity === 'unique', else null
  uniqueValues: [],          // number[], positionally aligned with
                             // UniqueDefinition.mods[], exactly as AffixInstance.values
                             // is with AffixDefinition.mods. A unique rolls every mod
                             // in its range and this is where those rolls live —
                             // affixes[] cannot hold them, because a unique's mods are
                             // not affixes. SERIALISED. Absent in an older save → [],
                             // and rebuildCache treats the unique as carrying its min
                             // values, which is the safe direction.
  nameOverride: null,        // rare items store their generated two-word name here

  durability:    52,         // int, current
  maxDurability: 55,         // int, base value after any affix modification
  sockets:       [],         // (uid|null)[]; length === socketCount. Empty until post-M9
  socketCount:   0,          // int

  /** location — exactly one of these is non-null */
  grid:  { container: 'inventory', x: 3, y: 0 },  // container: 'inventory'|'stash'|'belt'|'vendor'|'ground'
  slot:  null,                                    // SLOT when equipped
  ground: null,                                   // { x, y, z, droppedAtStep, expiresAtStep }

  /** cached, never serialised — rebuilt on load by items.rebuildCache(item) */
  _cache: {
    stats:      null,        // partial StatBlock this item contributes
    displayName:'Keen Battle Axe of the Legion',
    sellValue:  310,         // int gold
    iconCanvas: null,        // OffscreenCanvas
    unusable:   false,
  },
};
```

Fields prefixed `_` are never written to `localStorage`. The save writes
`uid`, `baseId`, `rarity`, `ilvl`, `identified`, `quantity`, `rolls`,
`affixes`, `uniqueId`, `nameOverride`, `durability`, `maxDurability`,
`sockets`, `socketCount`, and exactly one of `grid` / `slot`.

`ground.expiresAtStep` implements the plan's decay budget: a ground item that
outlives `groundItemBudget` is removed oldest-first, and any item older than
**600 s** of simulation is removed regardless. Rare and unique items are exempt
from budget eviction but not from the 600 s timeout.

### 5.4 Containers

```js
const InventoryGrid = {
  width:  10,               // int, constant
  height: 4,                // int, constant
  cells:  new Int32Array(40),  // item uid per cell, 0 = empty. Row-major, y*10+x
  items:  new Map(),        // uid → ItemInstance, for O(1) lookup
};

const StashGrid = {
  width:  10,
  height: 8,
  cells:  new Int32Array(80),
  items:  new Map(),
};

const BeltSlots = {
  slots: [null, null, null, null],   // ItemInstance | null, keys 1..4
  // Only ItemBase.category === 'consumable' may occupy a belt slot.
};

const EquipmentSet = {
  head: null, chest: null, hands: null, legs: null,
  mainHand: null, offHand: null, belt: null,
  amulet: null, ring1: null, ring2: null,     // ItemInstance | null
};
```

A multi-cell item occupies a rectangle; `cells` stores the same `uid` in every
covered cell, and the item's `grid.x/grid.y` is the **top-left** cell.
Placement is valid when every covered cell is inside the grid and either empty
or covered by the item being moved.

Equipping a two-handed weapon forces `offHand` to `null` (its item is returned
to the inventory, and the equip fails if there is no room). A shield in
`offHand` is the only source of `blockChance` — the stat exists on every actor
but the block roll (`03-combat-math.md` §5) short-circuits to 0 without one.

### 5.5 `UniqueDefinition`

```js
const UniqueDefinition = {
  id:        'ashen_crown',
  name:      'Ashen Crown',
  baseId:    'helm_coif_normal',
  reqLevel:  14,                 // may exceed the base's own reqLevel
  lore:      'Worn by the first to read aloud and the first to forget.',
  mods: [
    { stat: 'manaCostReduction', min: 20, max: 25 },
    { stat: 'lifePercent',       min: -45, max: -35 },  // the rule it breaks
    { stat: 'fireResist',        min: 15, max: 25 },
  ],
  dropWeight: 4,
};
```

A unique rolls **every** mod in `mods`, each independently in its range, using
the `items` stream in array order.

---

## 6. Skills

### 6.1 `SkillDefinition`

Static, in `src/skills/data/skills.js`. Complete numeric tables for all 30
skills are in `03-combat-math.md` §8.

```js
const SkillDefinition = {
  id:        'whirlwind',
  classId:   'ravager',
  tree:      'carnage',            // 'carnage'|'unyielding'|'flame'|'ash'|'enchanted_blade'|'conduit'
  displayName: 'Whirlwind',
  tier:      6,                    // int, minimum character level to allocate
  maxLevel:  20,                   // int, allocated points cap
  requires:  [],                   // [{ skillId, level }] — prerequisite allocations
  type:      'channel',            // 'attack'|'projectile'|'cone'|'nova'|'aura'|'buff'
                                   // |'passive'|'channel'|'mobility'|'summon'|'ground'|'toggle'
  target:    'point',              // 'none'|'self'|'point'|'actor'|'direction'
  element:   'physical',           // ELEMENT of its damage, 'physical' for weapon skills

  /** resource cost. Evaluated as base + perLevel × (effectiveLevel − 1). */
  cost: {
    resource:  'rage',             // 'mana'|'rage'|'resonance'|'life'|null
    base:      12,                 // for channels this is per SECOND
    perLevel:  -0.25,
    perSecond: true,               // true → drained continuously while channelling
    minimum:   6,                  // floor after perLevel scaling
    resonance: 0,                  // Resonance consumed on cast, in addition to
                                   // `resource`. An integer spends exactly that
                                   // many; the string 'all' spends
                                   // floor(actor.resonance) and requires ≥ 1.
                                   // Only `blade_seal` uses 'all' (03 §2.4);
                                   // the amount spent never changes the effect.
  },

  cooldown:      { base: 0, perLevel: 0, minimum: 0 },   // seconds
  castTime:      0,                // seconds; 0 → uses weapon attack time instead
  attackScale:   1.00,             // multiplier on the weapon attack time
  weaponDamage:  { base: 55, perLevel: 4 },  // % of weapon damage; null for spells
  flatDamage:    null,             // { minBase, minPerLevel, maxBase, maxPerLevel }
  radius:        { base: 2.6, perLevel: 0 }, // metres
  duration:      { base: 0, perLevel: 0 },   // seconds, for buffs/ground effects
  projectile:    null,             // ProjectileSpec, see below
  onHitStatus:   [],               // [{ status, chance, duration, magnitude }]
  synergies:     [{ skillId: 'cleaving_strike', stat: 'weaponDamage', perLevel: 8 }],
  passiveStats:  null,             // partial StatBlock scaled per level, for type 'passive'
  tags:          ['melee', 'aoe', 'channel'],
  fxId:          'whirlwind',      // key into the fx registry
  iconSeed:      0x9a71,           // uint32, procedural icon
};

const ProjectileSpec = {
  speed:      26,      // m/s
  lifetime:   2.2,     // seconds
  radius:     0.30,    // metres, collision
  pierce:     false,   // or a level threshold: { fromLevel: 10 }
  gravity:    0,       // m/s², 0 = flat trajectory
  homing:     0,       // rad/s turn rate, 0 = straight
  maxTargets: 1,       // int
  chain:      null,    // { jumps, range, falloffPercent } for discharge
};
```

### 6.2 `SkillInstance` — per-actor allocation

```js
const SkillInstance = {
  skillId:        'whirlwind',
  allocated:      5,     // int 0..20, what the player spent
  effectiveLevel: 7,     // int, derived — see below. Never serialised
  unlocked:       true,  // tier and prerequisites are met
  onHotbar:       2,     // int 1..4, or 0
};
```

```
effectiveLevel = allocated
               + skillBonuses.all
               + (skillBonuses.tree[def.tree]  ?? 0)
               + (skillBonuses.skill[skillId]  ?? 0)
```

- `allocated === 0` → the skill is not usable, and `effectiveLevel` is forced to
  0 no matter how many `+skills` the actor has. `+skills` amplify, they do not
  grant.
- `effectiveLevel` clamps to `[0, 40]`.
- Recomputed whenever `stats:dirty` resolves.

### 6.3 Skill registry — all 30

Complete list. Numeric scaling per skill is in `03-combat-math.md` §8.

| # | id | Class | Tree | Tier | Type | Resource | Prereq |
|---|---|---|---|---|---|---|---|
| 1 | `cleaving_strike` | ravager | carnage | 1 | attack (cone) | rage | — |
| 2 | `bloodletting` | ravager | carnage | 6 | attack | rage | — |
| 3 | `whirlwind` | ravager | carnage | 6 | channel | rage/s | — |
| 4 | `bloodthirst` | ravager | carnage | 12 | passive | — | — |
| 5 | `sunder` | ravager | carnage | 18 | attack (nova) | rage | `bloodletting` ≥ 3 |
| 6 | `ram_charge` | ravager | unyielding | 1 | mobility | rage | — |
| 7 | `shield_stance` | ravager | unyielding | 6 | passive | — | — |
| 8 | `war_cry` | ravager | unyielding | 12 | nova (buff) | rage | — |
| 9 | `iron_skin` | ravager | unyielding | 12 | passive | — | — |
| 10 | `last_stand` | ravager | unyielding | 18 | passive (trigger) | — | — |
| 11 | `ember_bolt` | emberwright | flame | 1 | projectile | mana | — |
| 12 | `flame_wave` | emberwright | flame | 6 | cone | mana | — |
| 13 | `fireball` | emberwright | flame | 12 | projectile | mana | — |
| 14 | `meteor` | emberwright | flame | 18 | ground | mana | `fireball` ≥ 3 |
| 15 | `incinerate` | emberwright | flame | 18 | passive | — | — |
| 16 | `ashen_step` | emberwright | ash | 1 | mobility | mana | — |
| 17 | `mana_weave` | emberwright | ash | 6 | passive | — | — |
| 18 | `smouldering_ward` | emberwright | ash | 12 | buff | mana | — |
| 19 | `ash_wall` | emberwright | ash | 12 | ground | mana | — |
| 20 | `essence_burn` | emberwright | ash | 18 | nova | mana (all) | — |
| 21 | `rune_strike` | runeblade | enchanted_blade | 1 | attack | mana | — |
| 22 | `blade_seal` | runeblade | enchanted_blade | 1 | buff | mana + resonance (all) | — |
| 23 | `cascade` | runeblade | enchanted_blade | 6 | passive (trigger) | — | — |
| 24 | `phase_leap` | runeblade | enchanted_blade | 12 | mobility (attack) | mana | — |
| 25 | `echo_blade` | runeblade | enchanted_blade | 18 | summon | mana | — |
| 26 | `discharge` | runeblade | conduit | 1 | projectile (chain) | mana | — |
| 27 | `resonance_circuit` | runeblade | conduit | 6 | passive | — | — |
| 28 | `polarity` | runeblade | conduit | 12 | toggle | mana | — |
| 29 | `thunder_step` | runeblade | conduit | 12 | mobility | mana | — |
| 30 | `unity` | runeblade | conduit | 18 | buff | mana | — |

Ten skills per class, five per tree, two trees per class. A level-30 character
holds **29 skill points** (one per level from 2 to 30) plus a permanent
`skillBonuses.all += 1` from the quest reward. Maxing one skill costs 20 of
those 29 — the build is a real choice, which is the intent.

### 6.4 `Hotbar`

```js
const Hotbar = {
  slots:      ['cleaving_strike', 'ram_charge', null, null],  // skillId | null, keys 1..4
  rightMouse: 0,        // int 0..3 — which hotbar slot RMB casts. 'attack' when -1
  leftMouse:  -1,       // -1 = move/attack (the D2 default), else a hotbar index
  beltKeys:   [0, 1, 2, 3],   // belt slot indices bound to keys 1..4 of the belt row
};
```

---

## 7. Status effects

### 7.1 `StatusEffectInstance`

```js
const StatusEffectInstance = {
  status:      'burning',    // STATUS key, see §7.2
  sourceId:    41,           // int actor id of the applier
  sourceGen:   3,            // int generation, for ActorRef safety
  sourceSkill: 'flame_wave', // skillId | 'attack' | 'affix:burning' | null
  element:     'fire',       // ELEMENT that produced it

  magnitude:   8.4,          // meaning depends on the status — see §7.2
  stacks:      1,            // int 1..maxStacks
  appliedStep: 4120,         // int, simulation step index when applied
  expiresStep: 4300,         // int, simulation step index
  nextTickStep:4135,         // int, next DoT tick; 0 for non-ticking statuses

  totalRemaining: 25.2,      // for DoTs: damage still owed. Drives replace-if-greater
  statMods:    null,         // partial StatBlock, or null. Contributes to the status layer
  poolIndex:   -1,           // int, pool bookkeeping
};
```

Maximum **24** concurrent instances per actor. On overflow the instance with the
earliest `expiresStep` among non-boss-critical statuses is dropped.

### 7.2 The ten statuses

Magnitudes, durations and interactions with numbers: `03-combat-math.md` §7.

| status | `magnitude` means | Stacking rule | Max stacks | Ticks | `statMods` |
|---|---|---|---|---|---|
| `chilled` | % speed reduction | **max-wins**, refresh duration | 1 | no | `increasedAttackSpeed`, `fasterCastRate`, `movementSpeed` |
| `frozen` | unused (0) | **refresh only**, then 3 s immunity | 1 | no | none — `actors` blocks all actions |
| `burning` | damage per second | **independent stacks** | 3 | 4 Hz | none |
| `poisoned` | damage per second | **replace if greater total** | 1 | 4 Hz | `lifeRegen` set to 0 |
| `shocked` | % extra damage taken | **additive stacks**, refresh all | 3 | no | none — read by the pipeline |
| `stunned` | unused (0) | **max-wins on remaining**, DR chain | 1 | no | none — `actors` blocks all actions |
| `slowed` | % movement reduction | **max-wins**, refresh duration | 1 | no | `movementSpeed` |
| `bleeding` | damage per second | **independent stacks** | 5 | 2 Hz | none |
| `blinded` | % attack-rating reduction | **max-wins**, refresh duration | 1 | no | `attackRatingPercent` |
| `cursed` | % defence reduction | **max-wins**, refresh duration | 1 | no | `defensePercent`, all six resists |

```js
export const STATUS = Object.freeze({
  chilled:'chilled', frozen:'frozen', burning:'burning', poisoned:'poisoned',
  shocked:'shocked', stunned:'stunned', slowed:'slowed', bleeding:'bleeding',
  blinded:'blinded', cursed:'cursed',
});
/** Fixed iteration order — DoT resolution order must be reproducible. */
export const STATUS_ORDER = Object.freeze([
  'burning','poisoned','bleeding','shocked','chilled','frozen',
  'slowed','stunned','blinded','cursed',
]);
export const STATUS_BIT = Object.freeze({
  burning:1<<0, poisoned:1<<1, bleeding:1<<2, shocked:1<<3, chilled:1<<4,
  frozen:1<<5, slowed:1<<6, stunned:1<<7, blinded:1<<8, cursed:1<<9,
});
```

### 7.3 Refresh versus stack

- **refresh** — the existing instance's `expiresStep` is set to
  `max(existing.expiresStep, now + newDuration)`. `magnitude` follows the rule in
  the table (max-wins or additive). No new instance is allocated.
- **independent stacks** — a new `StatusEffectInstance` is pushed while
  `stacks < maxStacks`. At the cap, the instance with the lowest
  `totalRemaining` is replaced. Each instance keeps its own timer and ticks
  independently.
- **replace if greater total** — the new application replaces the old one iff
  `newMagnitude × newDuration > existing.totalRemaining`. Otherwise it is
  discarded entirely. This is the poison rule and it is the reason
  `poisonMin/Max` are totals, not rates.
- **additive stacks** — one instance, `stacks` increments to the cap, and every
  stack shares one `expiresStep` which the newest application refreshes.

### 7.4 Tick cadence

All DoTs tick on a shared **4 Hz** cadence: every **15** fixed steps. Bleeding
ticks every **30** steps (2 Hz). To spread cost, an actor's tick phase is
`actor.id % 15` — deterministic, because `actor.id` is assigned in a
deterministic spawn order. A tick applies
`magnitude × (tickInterval)` damage and decrements `totalRemaining`.

A DoT tick is **not** a hit: it never triggers to-hit, block, dodge, crit,
life steal, thorns, hit recovery, knockback or `combat:hit-request`. It applies
resistance and `physicalResist` (for `bleeding`), but never `damageReduceFlat`.

---

## 8. Damage

### 8.1 `DamagePacket`

Expanded from the sketch in `ARCHITECTURE.md`. Built by
`combat.buildAttackPacket()` (never by hand), pooled, and valid only until the
end of the `fixedUpdate` step that created it.

```js
const DamagePacket = {
  // ─── provenance ─────────────────────────────────────────────────────────
  sourceId:      41,        // int actor id
  sourceGen:     3,         // int generation
  sourceSkillId: 'cleaving_strike',  // skillId | 'attack' | 'thorns' | 'dot' | 'environment'
  sourceLevel:   7,         // int effective skill level, 0 for basic attacks
  team:          0,         // TEAM of the source, for friendly-fire filtering

  // ─── physical, post-ED, post-attribute, pre-mitigation ──────────────────
  physMin:       28.4,      // float
  physMax:       47.2,      // float

  // ─── elemental, post-percent, pre-resistance ────────────────────────────
  fireMin: 0, fireMax: 0,
  coldMin: 0, coldMax: 0,
  lightMin: 0, lightMax: 0,
  poisonMin: 0, poisonMax: 0,   // TOTAL over poisonDuration, not a rate
  magicMin: 0, magicMax: 0,
  poisonDuration: 4.0,      // seconds
  coldDuration:   2.0,      // seconds of `chilled` this hit applies

  // ─── to-hit ─────────────────────────────────────────────────────────────
  attackRating:  235,       // 0 → the attack always hits (spells, DoTs, thorns)
  attackerLevel: 10,        // int, for the level term of the to-hit formula
  blockable:     true,      // false for spells that ignore shields
  dodgeable:     true,      // false for ground effects and auras

  // ─── crit ───────────────────────────────────────────────────────────────
  critChance:    5,         // %
  critMult:      200,       // % of damage on a crit

  // ─── resistance pierce, points subtracted from the target's resist ──────
  fireResistPierce: 0,
  coldResistPierce: 0,
  lightResistPierce: 0,
  poisonResistPierce: 0,

  // ─── on-hit riders ──────────────────────────────────────────────────────
  onHitStatus:   [],        // [{ status, chance:%, duration:s, magnitude, stacks:int }]
                            // Preallocated array of 4 slots; `onHitCount` is the live length
  onHitCount:    0,         // int 0..4

  lifeSteal:     0,         // % of physical dealt
  manaSteal:     0,         // %
  lifeOnHit:     0,         // flat
  manaOnHit:     0,         // flat
  manaReturnPercent: 0,     // % (Runeblade)

  /** When true, the REQUESTER accounts for the attacker's rage credit for
   *  this hit and `combat` skips R14(f)'s attacker-rage row. Resonance is
   *  unaffected (it is per landed hit — 03 §2.4, 05 D-05-2), and so is the
   *  defender's +4 per hit taken. Default false: combat credits, as always.
   *  Exists because a CHANNEL earns at the actor's `attackInterval` cadence,
   *  not per hit and not per step (05 §1.6 reading R2), so `skills` owns that
   *  cadence outright — see 05 §12.1's infinite-`whirlwind` lock. Added by
   *  SKIL-7 / PROGRESS D-57. */
  requesterOwnsRageCredit: false,

  // ─── impulse ────────────────────────────────────────────────────────────
  knockback:        0,      // % chance
  knockbackDistance: 0.55,  // metres at mass 70 kg
  hitStop:          0.06,   // seconds of presentation-only freeze on a landed hit

  // ─── geometry (for FX and for multi-hit accounting) ─────────────────────
  originX: 0, originY: 0, originZ: 0,   // where the attack came from
  pierceIndex: 0,           // int, 0 for the first target a projectile hits

  // ─── pooling ────────────────────────────────────────────────────────────
  poolIndex: -1,
};
```

### 8.2 `DamageResult`

Returned by `combat.resolve()` and carried in the `actor:damage` payload.
Pooled, valid until the end of the step.

```js
const DamageResult = {
  targetId:   88,           // int
  targetGen:  1,
  sourceId:   41,
  sourceGen:  3,
  sourceSkillId: 'cleaving_strike',

  outcome:    'hit',        // 'hit'|'miss'|'dodge'|'block'|'immune'|'invalid'
  crit:       false,
  blocked:    false,
  killed:     false,
  overkill:   0,            // damage beyond the target's remaining life

  physical:   31.8,         // applied, post-mitigation, per element
  fire:       0,
  cold:       0,
  lightning:  0,
  poison:     0,            // the instalment applied THIS step (0 for the DoT seed)
  magic:      0,
  total:      31.8,         // sum of the six above

  lifeStolen: 0,
  manaStolen: 0,
  manaReturned: 0,
  thornsDealt: 0,

  statusApplied: 0,         // uint16 bitfield of STATUS_BIT actually applied
  hitRecovery: false,       // target entered hitstun
  knockedBack: false,

  pointX: 0, pointY: 0, pointZ: 0,   // impact position for FX and damage numbers
  poolIndex: -1,
};
```

The `actor:damage` event payload is
`{ target, source, result }` where `result` is this record —
a superset of the fields listed in `ARCHITECTURE.md` (see §12, Deviation D-2).

---

## 9. World, zones and navigation

### 9.1 `ZoneDescriptor` — static

```js
const ZoneDescriptor = {
  id:            'ashen_wastes',
  displayName:   'Ashen Wastes',
  kind:          'open',        // 'town' | 'open' | 'dungeon' | 'arena'
  generator:     'ridgewalk',   // 'handauthored' | 'ridgewalk' | 'bsp_rooms' | 'arena'
  sizeX:         96,            // metres
  sizeZ:         96,            // metres
  cellSize:      24,            // metres, generator macro-cell (open zones)
  monsterLevel:  6,             // int, at DIFFICULTY.instruction
  packCount:     { min: 9, max: 14 },   // int, packs placed per run
  packSize:      { min: 5, max: 12 },   // int, monsters per pack
  densityTarget: 0.0125,        // monsters per m², checked by tools/mapgen.mjs (±20 %)
  champChance:   0.16,          // per pack
  uniqueChance:  0.06,          // per pack; mutually exclusive with champion
  bestiary:      ['bone_ranker','carrion_swarm','ashen_archer','dust_shaman','blight_crawler'],
  surfaces:      ['ash','dirt','stone','bone'],
  lightingPreset:'wastes_dusk', // key into the sky subsystem
  fogPreset:     'wastes',
  ambientAudio:  'wastes',
  treasureClass: 'tc_wastes',
  exits:         [{ toZone: 'bonereach', tag: 'descent' }],
  entryTags:     ['portal_from_town', 'descent_return'],
  chestCount:    { min: 2, max: 4 },
  propBudget:    900,           // int, instanced props
};
```

The four shipping zones:

| id | displayName | kind | size | mlvl (Instruction) |
|---|---|---|---|---|
| `last_bastion` | Last Bastion | town | 60 × 60 | — |
| `ashen_wastes` | Ashen Wastes | open | 96 × 96 | 6 |
| `bonereach` | Bonereach | dungeon | 112 × 112 | 11 |
| `altar_of_instruction` | Altar of Instruction | arena | 48 × 48 | 15 |

### 9.2 `ZoneInstance` — runtime

```js
const ZoneInstance = {
  descriptor:   null,        // ZoneDescriptor
  zoneId:       'ashen_wastes',
  seed:         0x8f2a11c3,  // uint32 = hash(worldSeed, zoneId, runIndex)
  runIndex:     3,           // int, increments each time the zone is regenerated
  difficulty:   'instruction',
  monsterLevel: 6,           // int, after the difficulty offset
  navVersion:   7,           // int, +1 on every rebuild; ai invalidates paths on change

  boundsMinX: -48, boundsMinZ: -48,
  boundsMaxX:  48, boundsMaxZ:  48,

  nav:          null,        // NavGrid
  spawnPoints:  [],          // SpawnPoint[]
  packs:        [],          // PackDescriptor[]
  portals:      [],          // [{ id, x, z, toZone, toEntryTag, open:boolean }]
  entries:      new Map(),   // entryTag → { x, z, facing }
  chests:       [],          // [{ id, x, z, opened, treasureClass }]

  cleared:      false,       // all packs dead
  bossDefeated: false,
  monstersAlive: 0,          // int
  monstersKilled: 0,         // int
  groundItems:  [],          // ItemInstance[] currently on the floor
  createdAtStep: 0,          // int
};
```

### 9.3 `NavGrid`

```js
const NavGrid = {
  cellSize: 0.5,             // metres. Constant across all zones
  width:    192,             // int cells = sizeX / cellSize
  height:   192,             // int cells
  originX: -48,              // metres, world position of cell (0,0)'s corner
  originZ: -48,

  flags:    new Uint8Array(192 * 192),   // NAV_FLAG bitfield per cell
  cost:     new Uint8Array(192 * 192),   // 1..255 traversal cost; 255 = impassable
  region:   new Int16Array(192 * 192),   // connected-component id, −1 = blocked
  groundY:  new Float32Array(192 * 192), // ground height in metres, for actor placement

  regionCount: 1,            // int
  version:     7,            // int, mirrors ZoneInstance.navVersion
};

export const NAV_FLAG = Object.freeze({
  walkable:  1 << 0,
  blocked:   1 << 1,   // static collider
  hazard:    1 << 2,   // fire pool, ash cloud — AI avoids, player may cross
  water:     1 << 3,   // slows, blocks nothing
  doorway:   1 << 4,   // funnel; separation weight is halved here
  spawnDeny: 1 << 5,   // never spawn a monster here (near entries and portals)
  interior:  1 << 6,   // roofed; sky dims
});
```

Index of world `(x, z)`: `cy * width + cx` where
`cx = floor((x − originX) / cellSize)`, `cz = floor((z − originZ) / cellSize)`.
`region` guarantees the generator's connectivity contract — the entry cell and
every exit, chest and boss cell must share one region id.

Memory at 192×192: 36,864 cells → 36 KB flags + 36 KB cost + 72 KB region
+ 144 KB `groundY` = **288 KB** per zone. Bonereach at 224×224 is 392 KB. Two
zone instances are live at most (current + the town), so the nav budget is
< 1 MB.

### 9.4 `SpawnPoint`

```js
const SpawnPoint = {
  id:        0,              // int, index into ZoneInstance.spawnPoints
  x: 0, z: 0,                // metres
  facing:    0,              // radians
  kind:      'pack',         // 'pack'|'wanderer'|'boss'|'npc'|'chest'|'portal'|'player'
  packIndex: 2,              // int index into ZoneInstance.packs, −1 if none
  regionId:  0,              // int, from NavGrid.region — must match the entry region
  consumed:  false,
};
```

### 9.5 `PackDescriptor`

```js
const PackDescriptor = {
  id:          3,            // int
  archetypeId: 'bone_ranker',
  count:       8,            // int, 5..12
  rank:        'normal',     // ACTOR_RANK of the pack leader
  affixes:     [],           // MonsterAffix ids when rank is champion/unique
  centerX: 12.5, centerZ: -8.0,
  radius:      4.5,          // metres, initial scatter
  aggroCloud:  9.0,          // metres — waking one wakes the whole pack
  mlvl:        6,            // int
  members:     [],           // ActorRef[], filled at spawn
  spawned:     false,
  aliveCount:  0,            // int
};
```

Monster affixes (nine, per the plan) are ids into
`src/ai/data/monster-affixes.js`:
`burning`, `charged`, `frostbound`, `swift`, `mighty`, `stoneskin`, `hexing`,
`vampiric`, `multishot`. Their numeric effects are in `03-combat-math.md` §9.4.

### 9.6 `Brain` — the AI decision record

Owned by `ai`, one per hostile actor, parallel to the `Actor`. Kept separate so
`actors` stays a pure state/animation subsystem and the balance harness can run
combat without instantiating brains.

```js
const Brain = {
  actorId:     88,           // int
  actorGen:    1,
  state:       'wander',     // 'dormant'|'wander'|'alert'|'chase'|'attack'|'reposition'|'flee'|'cast'|'dead'
  stateTime:   0,            // seconds
  packId:      3,            // int
  targetRef:   { id: 0, generation: 0 },   // ActorRef
  lastSeenX: 0, lastSeenZ: 0,
  lastSeenStep: -1,          // int
  pathVersion: 7,            // int; !== nav.version → repath
  path:        null,         // PathHandle from nav, or null when on the flow field
  pathIndex:   0,            // int
  repathAtStep: 0,           // int
  useFlowField: true,
  nextDecisionStep: 0,       // int — brains decide at 10 Hz, not 60 Hz
  skillCooldowns: null,      // Map<skillId, int stepIndex>
  desiredRange: 1.9,         // metres, from the archetype; ranged types keep 6+
  fleeUntilStep: 0,          // int
  reviveCredits: 1,          // int, dust_shaman only
};
```

---

## 10. Save schema v1

`localStorage`, JSON, three character slots plus one shared stash.

### 10.1 Keys

| Key | Holds |
|---|---|
| `claudo2.save.v1.meta` | `SaveMeta` |
| `claudo2.save.v1.char.0` … `.2` | `CharacterSave` |
| `claudo2.save.v1.stash` | `StashSave` |
| `claudo2.save.v1.settings` | `SettingsSave` |

### 10.2 Shapes

```js
const SaveMeta = {
  schemaVersion: 1,          // int — the only field guaranteed to exist forever
  createdAt:   1785000000000,  // ms epoch, informational only, never read by the sim
  updatedAt:   1785000123456,
  slots: [                   // exactly 3 entries, null for an empty slot
    { name: 'Verrin', classId: 'ravager', level: 13, difficulty: 'trial', playSeconds: 7412 },
    null,
    null,
  ],
};

const CharacterSave = {
  schemaVersion: 1,
  slot:        0,            // int 0..2
  name:        'Verrin',     // 1..16 chars, [A-Za-z][A-Za-z0-9 '-]{0,15}
  classId:     'ravager',
  level:       13,           // int 1..30
  experience:  33150,        // int, cumulative
  playSeconds: 7412,         // int

  attributes:  { strength: 54, dexterity: 32, vitality: 49, energy: 10 },
  unspentStatPoints:  0,     // int
  unspentSkillPoints: 2,     // int
  skills: {                  // skillId → allocated points. Absent key === 0
    cleaving_strike: 6, whirlwind: 4, bloodletting: 3, ram_charge: 1,
  },
  hotbar: {
    slots: ['cleaving_strike','whirlwind','ram_charge', null],
    rightMouse: 0, leftMouse: -1,
  },

  equipment: {               // SLOT → ItemInstance | null
    head: null, chest: {/*…*/}, hands: null, legs: null,
    mainHand: {/*…*/}, offHand: null, belt: {/*…*/},
    amulet: null, ring1: null, ring2: null,
  },
  inventory: [ /* ItemInstance[]; each carries its own grid.x / grid.y */ ],
  belt:      [ /* 4 entries, ItemInstance | null */ ],
  gold:      4820,           // int
  nextItemUid: 1744,         // int, so uids never collide after a reload

  difficulty:      'trial',
  difficultyUnlocked: ['instruction','trial'],
  worldSeed:       0x1f3ac09b,   // uint32
  runIndex:        { ashen_wastes: 4, bonereach: 2, altar_of_instruction: 1 },
  currentZone:     'last_bastion',

  quests: {
    word_unquenched: {
      state: 'active',       // 'unavailable'|'available'|'active'|'complete'|'rewarded'
      step:  2,              // int
      flags: { tabletTaken: false, molgrimSlain: false },
    },
  },
  questSkillPointsGranted: 0,   // int — protects the +1 all-skills reward from re-granting

  stats: {                   // vanity counters, never read by the simulation
    monstersKilled: 1843, championsKilled: 22, uniquesKilled: 4, bossKills: 1,
    deaths: 6, itemsFound: 512, uniquesFound: 1, goldCollected: 41200,
    highestDamage: 418,
  },
};

const StashSave = {
  schemaVersion: 1,
  gold:  12500,              // int, shared across characters
  items: [ /* ItemInstance[]; grid.container === 'stash' */ ],
};

const SettingsSave = {
  schemaVersion: 1,
  quality:     'high',       // 'low'|'medium'|'high'|'ultra'
  language:    'en',         // 'en'|'ru'
  masterVolume: 0.8, sfxVolume: 1.0, musicVolume: 0.6,
  alwaysShowLoot: false,
  minimapOpacity: 0.75,

  // --- added for 09-ui.md §16.6. All optional with defaults, so rule 7 of
  //     §10.4 applies and SCHEMA_VERSION does not move.
  keybinds:          {},     // { actionId: KeyboardEvent.code }; {} = defaults
  colourBlindMode:   'off',  // 'off'|'protan'|'deutan'|'tritan'
  rarityLabels:      true,
  alwaysCompare:     false,
  uiScale:           1.00,   // 0.85 | 1.00 | 1.15 | 1.30
  damageNumberMode:  'own',  // 'off'|'own'|'all'
  reduceShake:       false,
  hudOpacity:        1.00,   // 0.70 .. 1.00
};
```

`damageNumberMode` supersedes the `showDamageNumbers: boolean` this record
originally carried. The conversion is a pure default-fill applied by
`rebuildCache`, not a migration: `showDamageNumbers === false ? 'off' : 'own'`.
A settings blob written before the field existed reads as `'own'`, which is what
`true` meant.

### 10.3 Invariants validated on load

Every one of these is checked by `save.validate()` before the save is handed to
the game. A failure quarantines the slot (renamed to
`claudo2.save.v1.char.<n>.corrupt.<timestamp>`) rather than crashing.

| # | Invariant |
|---|---|
| 1 | `schemaVersion` present and ≤ the running `SCHEMA_VERSION` |
| 2 | `level` ∈ 1..30, `experience` ≥ `XP_TABLE[level]` and < `XP_TABLE[level+1]` (level 30: ≥ only) |
| 3 | `Σ attributes − Σ classStart + unspentStatPoints === (level − 1) × 5` |
| 4 | `Σ skills.values − Σ classStartSkills + unspentSkillPoints === level − 1` — the `− Σ classStartSkills` term mirrors invariant 3's `− Σ classStart`. Without it the invariant cannot hold for a character whose class kit pre-spends a skill point, which every class does (`13-progression-lore.md` §4) |
| 5 | Every `skills` key exists in the registry and belongs to `classId`; every value ∈ 1..20 |
| 6 | Every skill's `tier` ≤ `level`, and every prerequisite in `requires` is satisfied |
| 7 | Every `baseId`, `uniqueId` and affix `id` resolves in the current data tables |
| 8 | Every `ItemInstance.uid` is unique across equipment + inventory + belt + stash, and `< nextItemUid` |
| 9 | Inventory rectangles are inside 10×4, do not overlap; stash inside 10×8 |
| 10 | Belt entries are `category === 'consumable'` or `null` |
| 11 | Two-handed `mainHand` implies `offHand === null` |
| 12 | `affixes` length matches the rarity rule (§1.6); `values.length === definition.mods.length` |
| 13 | `durability` ∈ 0..`maxDurability` |
| 14 | `difficulty` ∈ `difficultyUnlocked` |
| 15 | `currentZone` resolves; on any failure it falls back to `last_bastion` |

Invariants 3 and 4 are the anti-cheat and the migration canary at once: a
migration that silently changes a class's starting attributes will trip #3 on
the first load, loudly, instead of corrupting the character.

### 10.4 Migration policy

**Rules, binding from the first commit of `save`:**

1. `SCHEMA_VERSION` is a single integer exported from `src/save/schema.js`.
   It increments **only** when an old save can no longer be read field-for-field.
2. Migrations live in `src/save/migrations/` as pure functions
   `vN_to_vN1(obj) → obj`. They take and return plain JSON. They never import
   another subsystem, never touch `three`, never touch the clock or RNG.
3. `save.load()` applies migrations in strict ascending order from the stored
   `schemaVersion` to `SCHEMA_VERSION`. Every intermediate step must produce a
   structure that passes §10.3 for *its own* version.
4. **A migration is written in the same commit as the change that requires it.**
   No exceptions. A PR that bumps `SCHEMA_VERSION` without a migration file and
   a fixture does not build.
5. `tools/save-fuzz.mjs` holds one committed fixture per historical version in
   `tools/fixtures/save/vN.json` and asserts that each migrates cleanly to the
   current version and passes validation. Fixtures are never edited after they
   land — they are the record of what shipped.
6. **Forward compatibility is not supported.** A save whose `schemaVersion`
   exceeds the running one is refused with a clear message and left untouched;
   it is never partially read and never overwritten.
7. Changes that do **not** need a version bump: adding an optional field with a
   defined default; adding a new item base, affix, unique, skill or monster;
   any pure balance number change.
8. Changes that **do** need a bump: renaming or removing a field; changing a
   field's type or units; changing the meaning of a stat identifier; removing
   an item base, affix or skill that a save could reference; changing the
   attribute or skill-point budget per level.
9. Data referenced by a save but missing from the tables (a removed affix) is
   handled by the migration, not at runtime: the migration strips it and
   credits the player back at the current vendor sell value in gold.
10. Autosave fires on: zone transition, level-up, difficulty change, quest step,
    vendor transaction, and every **60 s** of play. It writes to a shadow key
    first (`…char.0.tmp`), then swaps — a browser killed mid-write never
    destroys a save.

---

## 11. Object pools

`ARCHITECTURE.md` rule 6 is absolute: nothing allocates per frame. Every record
below is preallocated in `init()` and recycled. **A pool that runs dry does not
grow** — it refuses, and the caller degrades gracefully (drops the lowest
priority entry, or skips a cosmetic effect). Growth would be a frame hitch, and
a silent one.

### 11.1 The pools

| Record | Owner | Size (low / medium / high / ultra) | Overflow policy |
|---|---|---|---|
| `Actor` | `actors` | 60 / 100 / 160 / 220 (`q.maxActors`) | `ai` refuses to spawn; packs queue |
| `Brain` | `ai` | same as `Actor` | tied 1:1 to a spawned monster |
| `StatBlock` | `actors` | `maxActors` + 8 | never overflows — one per actor |
| `StatusEffectInstance` | `combat` | 1024 | drop the shortest-remaining status on the target |
| `DamagePacket` | `combat` | 256 | drop the request, log once per second in dev |
| `DamageResult` | `combat` | 256 | drop the result; damage is still applied |
| `Projectile` | `skills` | 128 / 256 / 384 / 512 | oldest projectile expires early |
| `GroundEffect` | `skills` | 24 / 32 / 48 / 64 | oldest non-player effect expires |
| `Corpse` | `actors` | 24 / 40 / 56 / 72 | oldest corpse fades immediately |
| `GroundItem` view | `items` | 48 / 96 / 160 / 256 (`q.groundItemBudget`) | oldest non-rare item despawns |
| `DamageNumber` | `ui` | 64 / 96 / 128 / 128 | oldest number is recycled |
| `PathRequest` | `nav` | 64 | request is refused; the brain uses the flow field |
| `PathNode` arena | `nav` | 64 paths × 256 nodes | path is truncated; the tail re-plans |
| `Particle` | `fx` | 2000 / 6000 / 12000 / 24000 (`q.particleBudget`) | emitter is throttled |
| `Decal` | `fx` | 64 / 128 / 256 / 512 (`q.decalBudget`) | oldest decal fades |
| `PointLight` slot | `fx` | 12 (fixed, all presets) | intensity 0, never `visible = false` |
| `Vector3` scratch | every subsystem | 16 per subsystem, `init()`-owned | — |

`PointLight` deserves its fixed count: `ARCHITECTURE.md` documents that the
*visible* point-light count is a shader permutation key and that changing it
cost the source project 640–900 ms hitches. Twelve slots are parked at
`intensity = 0, visible = true` in every zone, and `fx` and `world` bid for
them. **The count never changes, in any preset, in any zone.**

### 11.2 The reset contract

Every pooled type implements exactly this pair:

```js
pool.acquire()   // returns a record with EVERY field at its type default,
                 // active = true, poolIndex set. Returns null when dry.
pool.release(r)  // calls r.reset(), sets active = false, pushes the index back
```

`reset()` obligations, in order:

1. **Numbers → 0, booleans → false, strings → `null`.** Never leave a stale
   value that a `??` or a truthiness check could read as meaningful.
2. **Arrays are emptied in place** (`arr.length = 0`), never reassigned. A
   reassignment allocates, which is the thing pools exist to avoid.
3. **Maps are cleared in place** (`map.clear()`).
4. **Object references are nulled**, including `view.root`, `path`, `stats`,
   `targetRef` contents. A pooled record must not keep a `THREE.Object3D`
   alive; `actors` returns the view to its own mesh pool first.
5. **`generation` is incremented** on `Actor` and on any record that an
   `ActorRef` can point at. This is what makes a stale reference detectable
   rather than silently wrong.
6. **`poolIndex` is preserved.** It identifies the slot and is the only field
   `reset()` does not clear.
7. `reset()` never emits an event, never touches RNG, never reads the clock.

Releasing a record twice is a bug and is asserted in dev builds
(`if (!r.active) throw`). Holding a pooled record past the step that acquired it
is a bug — `DamagePacket` and `DamageResult` are released by `combat` at the end
of the step regardless of who else is looking at them, which is why every
listener must copy what it needs during the synchronous dispatch.

### 11.3 Not pooled

`ItemInstance`, `AffixInstance`, `SkillInstance`, `ZoneInstance`, `NavGrid` and
everything in the save schema are **not** pooled. They are long-lived, they are
serialised, and pooling them would make `uid` reuse a save-corruption vector.
They are allocated at drop / load / generation time — all of which are already
frame-hitch events covered by a loading screen or a fade.

---

## 12. Deviations from the plan

**D-1 — Damage packet is built by `combat`, not by the caller.**
`IMPLEMENTATION_PLAN.md` §4.2 and `ARCHITECTURE.md` present the damage packet as
something `skills` or `ai` fills in. Doing so would put the enhanced-damage,
attribute-bonus and elemental-percent formulas in three subsystems, and the
first balance change would desynchronise them. Instead `combat` exposes
`buildAttackPacket(actor, skillId, level)`; callers adjust the returned packet
(radius, pierce index, on-hit riders) and emit it. `combat` remains the only
place damage arithmetic lives, which is what the ownership map actually intends.

**D-2 — `actor:damage` carries a `DamageResult`, not loose fields.**
`ARCHITECTURE.md` lists the payload as
`{ target, source, amount, element, crit, blocked, killed, point }`. That shape
cannot express a hit that dealt three elements at once, which every Runeblade
imbued strike does. The payload is `{ target, source, result }` where `result`
is the `DamageResult` of §8.2 — a strict superset: `amount` → `result.total`,
`element` → the per-element fields, `point` → `result.pointX/Y/Z`. No listed
information is lost.

**D-3 — Poison damage is specified as a total, not a rate.**
`poisonMin` / `poisonMax` describe the whole DoT, and `poisonDuration` only
stretches it. In D2 the same stats are rates, which makes every
`+poison length` affix a hidden damage multiplier and makes poison impossible to
balance against direct damage. The totals form costs nothing and removes the
trap.

**D-4 — A separate `Brain` record.**
The plan's subsystem map gives `ai` behaviour and `actors` the actor record.
Putting AI fields on `Actor` would force the headless balance harness to
allocate `maxActors` brains it never ticks, and would let `ai` write to a record
`actors` owns. `Brain` is a parallel record keyed by `actorId`.

**D-5 — Champion and unique multipliers differ from the plan.**
`IMPLEMENTATION_PLAN.md` §4.5 specifies champion ×2.5 life / ×1.5 damage and
unique ×5 life / ×2 damage. Those values produce a 5.7 s champion kill against
the plan's own locked pacing target of ~10 s. The shipped values are
champion **×4.0 life / ×1.6 damage / ×1.5 defence** and unique **×7.0 life /
×2.2 damage / ×2.0 defence**, which hit the target exactly — see the arithmetic
in `03-combat-math.md` §11.3. The pacing target was locked; the multipliers were
not.

**D-6 — Ten equipment slots, with `legs` covering greaves.**
The plan lists head / torso / hands / legs / weapon / shield / belt / amulet /
2 rings. `legs` is specified here as the boot-and-greave slot; there is no
separate footwear slot. This keeps the count at ten and matches the four
visible-geometry slots the render specification budgets for.
