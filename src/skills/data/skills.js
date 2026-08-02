// src/skills/data/skills.js
//
// SKIL-1 — all thirty `SkillDefinition` records (`01-data-model.md` §6.1's
// shape, `05-skills.md` §1.7's 30-row index for id/class/tree/tier/type/
// target, `03-combat-math.md` §8 for every base/perLevel number — §8 is
// "binding, never contradicted" per `05` §1.1). Every base/perLevel figure
// below is transcribed from `03` §8. `05-skills.md` §2-§7 (the per-skill
// sections, granted after this ticket's first pass found `03` §8 alone did
// not cover projectile flight, chain-growth formulas and a handful of
// status riders — see "Fields beyond..." below) supplies everything `03` §8
// does not carry: `ProjectileSpec` numbers, exact `onHitStatus` rows, and
// the numbers now living in `extra`. Where `05`'s per-skill sections repeat
// a `03` §8 base/perLevel figure, it is not re-transcribed from `05` — `03`
// §8 stays the source for those, `05` §2-§7 is read only for what `03` §8
// does not carry.
//
// Flat data, zero logic, zero imports of engine code (`ARCHITECTURE.md`
// rule 9 / this ticket's brief). Node-safe: no `three`, no DOM/browser
// global, no `performance.now()` — `tools/check-imports.mjs` sweeps
// `src/skills/` with `checkGlobals: true`.
//
// ---------------------------------------------------------------------------
// D-05-1 / D-05-2 / D-05-3 — already applied, not re-applied here
// ---------------------------------------------------------------------------
// `03-combat-math.md` §8 (the binding source this file transcribes) ALREADY
// prints the decided numbers: `whirlwind` ticks at 0.55 s (§8.1, D-05-1),
// `shield_stance` grants `dodgeChance += 3 + 0.5/L` (§8.2, D-05-3), and
// `rune_strike` carries only the class-base +1 Resonance while `blade_seal`
// spends the whole current Resonance bar (§8.5, D-05-2). No transcription
// below fights those; they are simply what `03` §8 already says. Checked
// directly against `05` §4007-4146's decision blocks while authoring this
// file — no other place `05`'s body prose and `03` §8 disagreed on a printed
// number was found (see this ticket's report for the search).
//
// ---------------------------------------------------------------------------
// Fields beyond `01-data-model.md` §6.1's shown example — read this before
// editing a record
// ---------------------------------------------------------------------------
// §6.1 shows exactly ONE illustrative `SkillDefinition` (whirlwind's own
// shape, reused verbatim below for id/classId/tree/tier/maxLevel/type/
// target/element/cost/cooldown/attackScale/weaponDamage/radius/synergies/
// tags/fxId — even `iconSeed: 0x9a71` is the example's own literal value,
// not invented here). That example does not, however, give a field for
// EVERY number `03-combat-math.md` §8 binds for the other 29 skills —
// travel distances, chain-jump growth, a "spend all mana" cost, an
// on-kill-percent-of-life detonation, a mana-to-damage conversion rate, a
// temporary self-buff, a triggered (non-permanent) passive, a level-
// threshold table. Rule 9 says gameplay numbers live in data, not in code;
// rule 6 says never fabricate a missing number — but says nothing about
// refusing to STORE a number the spec plainly gives just because §6.1's one
// example didn't happen to need a slot for it. Every record below therefore
// carries one additional, optional field not in the illustrative example:
//
//   extra: { ... } | null
//
// It is free-form, per-skill, and every key inside it is commented with the
// exact `03-combat-math.md` §8 clause it transcribes. Nothing in `src/
// skills/index.js` reads `extra` this ticket — SKIL-1 is registry and
// allocation only ("no casting yet", `05` §14 row 1) — it exists purely so
// the numbers are not silently dropped before the ticket that implements
// casting (§14 steps 2-13) needs them. Flagged in this ticket's report as a
// schema gap for whoever owns `01-data-model.md` to fold `extra`'s keys
// into named top-level fields, formally, once their shape has been used by
// a second ticket and is no longer a guess.
//
// One established-field extension, not a new field (kept out of `extra`
// because it fits the EXISTING field's own documented shape):
//   - `essence_burn.cost.base = 'all'` — `01` §6.1's own comment on
//     `cost.resonance` already establishes the string `'all'` as a legal
//     value meaning "spend everything currently held, floored per
//     `cost.minimum`"; `03` §8.4 needs exactly that same convention on the
//     PRIMARY resource (mana) for this one skill ("all current mana,
//     minimum 20"), so it is read the same way rather than inventing a
//     second mechanism for one skill.
//
// `discharge.projectile` is now filled from `05` §7.1 L2344-2427, printed
// verbatim: `{ speed: 0 (instant beam), lifetime: 0.35, radius: 0,
// pierce: false, chain: { jumps: min(6, 3 + floor(slvl/6)), range: 6.0,
// falloffPercent: 25 } }`. `jumps` is still decomposed into
// `{jumpsBase, jumpsLevelDivisor, jumpsCap}` rather than one static number
// — not a new invented shape, just the printed formula's own three
// constants named as fields, the same way every OTHER level-scaling number
// in this file is `{base, perLevel}` rather than a precomputed table.
// `fireball.projectile` and `thunder_step`'s `onHitStatus` duration are
// likewise now filled from `05` §4.3 and §7.4 respectively — see those
// records' own comments for the exact citation. None of the three needed
// an `extra` field once `05` §2-§7 was available; they fit `01` §6.1's own
// `ProjectileSpec`/`onHitStatus` shapes exactly.
//
// ---------------------------------------------------------------------------
// A note on damage shape: rolled ranges vs single deterministic values
// ---------------------------------------------------------------------------
// `flatDamage` (`01` §6.1) is a min/max ROLL range. Three records
// (`smouldering_ward`'s break nova, `ash_wall`'s per-second tick,
// `blade_seal`'s imbue) use it too, but `03` §8 gives two of those
// (`smouldering_ward`, `ash_wall`) as a single deterministic figure, e.g.
// `(20 + 11/L)`, not a range. Represented as a degenerate range
// (`minBase === maxBase`, `minPerLevel === maxPerLevel`) rather than adding
// a third damage shape — the evaluated number is identical either way, and
// a reader who diffs `minBase`/`maxBase` immediately sees there is no roll.
//
// ---------------------------------------------------------------------------
// Element for skills with no damage of their own, or a runtime-chosen one
// ---------------------------------------------------------------------------
// `01` §6.1's `element` field has six legal values and no `null` variant
// (`ELEMENT`, `01` §2, has no "none" member). Every record below therefore
// carries a real element: the one its own damage figure states (`fire`,
// `lightning`, or `magic` for `cascade` per `05` §1.6 reading R3, applied
// even though this ticket does not read `05`'s casting sections, because R3
// is inside the authorized §1.6 range), and `'physical'` — the value §6.1's
// own comment names as the default ("`'physical'` for weapon skills") —
// for every skill with no damage of its own (pure passives, `war_cry`,
// `polarity`, `unity`) and for `blade_seal`, whose imbue element is chosen
// at cast time from fire/cold/lightning/cycled and therefore has no single
// static value to print here (`extra` does not invent one either).
//
// ---------------------------------------------------------------------------
// What is NOT encoded here, and why that is not a rule-6 violation
// ---------------------------------------------------------------------------
// `05-skills.md` §14's implementation order puts costs/cooldowns/resources
// at step 2, casting/timing at steps 3-4, statuses at step 6, channels at 7,
// mobility at 8, ground effects at 9, buffs/absorbs/triggers at 10, synergy
// WIRING at 12 (this ticket only DECLARES the synergy graph, per S11 — `05`
// §14 row 1 lists `synergyBonus` as this ticket's deliverable, and it is
// implemented below, but nothing in this file applies a synergy to a damage
// roll, because there is no damage roll here to apply it to).
//
// Cone/nova ANGLES (120° for `cleaving_strike`, 90° for `flame_wave`, the
// implicit 360° for every `nova`/`channel`) are the one category of real
// `05` §2-§7 number still not stored anywhere, `extra` included: `type`
// already distinguishes `cone` from `nova`/`channel`, and a full-circle
// shape needs no angle at all, so the only genuinely missing number is the
// two cones' own arc width. Not added because `radius` already carries the
// cone's reach and no S1/S2/S11/S12 assertion or this ticket's own tests
// touch shape geometry — it belongs with the step-3 ticket that builds the
// actual shape query (`combat.buildAttackPacket`'s cone/nova resolution),
// which is the first consumer that would need to read it. Named here and
// in this ticket's report so it is a recorded gap, not a silent drop.

/** @typedef {{base:number, perLevel:number, cap?:number}} LevelCurve */

export const SKILLS = Object.freeze([
  // ===========================================================================
  // Ravager — Carnage (`03-combat-math.md` §8.1)
  // ===========================================================================
  Object.freeze({
    id: 'cleaving_strike', classId: 'ravager', tree: 'carnage',
    displayName: 'Cleaving Strike', tier: 1, maxLevel: 20, requires: [],
    type: 'cone', target: 'point', element: 'physical',
    cost: { resource: 'rage', base: 6, perLevel: 0.25, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0, attackScale: 1.05,
    weaponDamage: { base: 40, perLevel: 6.32 }, // 03 §8.1: "40% + 6.32%/L (L1 40%, L20 160.1%)"
    flatDamage: null,
    radius: { base: 3.2, perLevel: 0 }, // 03 §8.1: "120° cone, radius 3.2 m"
    duration: null, projectile: null, onHitStatus: [],
    synergies: [], // this skill is a SOURCE (-> whirlwind), never a target; sources live on the TARGET's own record (01 §6.1's own example)
    passiveStats: null,
    tags: ['melee', 'aoe', 'cone'],
    fxId: 'cleaving_strike', iconSeed: 0x235f6165,
    extra: null,
  }),
  Object.freeze({
    id: 'bloodletting', classId: 'ravager', tree: 'carnage',
    displayName: 'Bloodletting', tier: 6, maxLevel: 20, requires: [],
    type: 'attack', target: 'actor', element: 'physical',
    cost: { resource: 'rage', base: 8, perLevel: 0.30, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0, attackScale: 1.00,
    weaponDamage: { base: 90, perLevel: 5 }, // 03 §8.1: "90% + 5%/L"
    flatDamage: null, radius: null, duration: null, projectile: null,
    onHitStatus: [
      // 03 §8.1: "Applies bleeding, magnitude physDealt x (0.08 + 0.010/L) per
      // second for 5 s, up to 5 stacks" — magnitude is a COEFFICIENT on the
      // physical damage just dealt, not a flat number; applied at cast time
      // (step 6), not here. `chance` is 05 §2.2 L367's own printed value,
      // `onHitStatus: [{ status:'bleeding', chance:100, duration:5.0,
      // magnitude:0 }]` — a percentage on 0..100 (`src/combat/status.js:562`:
      // `env.rng.next() * 100 >= rider.chance` — 100 means "always").
      { status: 'bleeding', chance: 100, duration: { base: 5, perLevel: 0 }, magnitude: { base: 0.08, perLevel: 0.010 }, maxStacks: 5 },
    ],
    synergies: [],
    passiveStats: null,
    tags: ['melee', 'bleed'],
    fxId: 'bloodletting', iconSeed: 0xf9ec6414,
    extra: null,
  }),
  Object.freeze({
    // Verbatim shape of `01-data-model.md` §6.1's own illustrative
    // `SkillDefinition` example (that example IS this record) — id, cost,
    // cooldown, attackScale, weaponDamage, radius, synergies, tags, fxId
    // and iconSeed below are its literal values, not independently
    // transcribed. Tick period (0.55 s, D-05-1) and the 70% channel move
    // speed (03 §8.1) have no home in that example's shown fields; both go
    // in `extra.channel` — see the file header.
    id: 'whirlwind', classId: 'ravager', tree: 'carnage',
    displayName: 'Whirlwind', tier: 6, maxLevel: 20, requires: [],
    type: 'channel', target: 'point', element: 'physical',
    cost: { resource: 'rage', base: 12, perLevel: -0.25, perSecond: true, minimum: 6, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0, attackScale: 1.00,
    weaponDamage: { base: 55, perLevel: 4 }, // 03 §8.1: "55% + 4%/L per tick"
    flatDamage: null,
    radius: { base: 2.6, perLevel: 0 },
    duration: null, projectile: null, onHitStatus: [],
    synergies: [{ skillId: 'cleaving_strike', stat: 'weaponDamage', perLevel: 8 }], // 05 §8.7 #1
    passiveStats: null,
    tags: ['melee', 'aoe', 'channel'],
    fxId: 'whirlwind', iconSeed: 0x9a71,
    extra: {
      channel: { tickPeriodS: 0.55, moveSpeedPercent: 70 }, // 03 §8.1, D-05-1 applied
    },
  }),
  Object.freeze({
    id: 'bloodthirst', classId: 'ravager', tree: 'carnage',
    displayName: 'Bloodthirst', tier: 12, maxLevel: 20, requires: [],
    type: 'passive', target: 'none', element: 'physical',
    cost: { resource: null, base: 0, perLevel: 0, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0, attackScale: 1.00,
    weaponDamage: null, flatDamage: null, radius: null, duration: null, projectile: null, onHitStatus: [],
    synergies: [],
    passiveStats: { lifeSteal: { base: 3, perLevel: 0.9 } }, // 03 §8.1: "3 + 0.9/L (L1 3%, L20 20.1%)"
    tags: ['passive', 'sustain'],
    fxId: 'bloodthirst', iconSeed: 0x4cf21f43,
    extra: null,
  }),
  Object.freeze({
    id: 'sunder', classId: 'ravager', tree: 'carnage',
    displayName: 'Sunder', tier: 18, maxLevel: 20,
    requires: [{ skillId: 'bloodletting', level: 3 }], // 03 §8.1, 05 §8.8
    type: 'nova', target: 'point', element: 'physical',
    cost: { resource: 'rage', base: 14, perLevel: 0.50, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 6.0, perLevel: 0, minimum: 6.0 },
    castTime: 0, attackScale: 1.25,
    weaponDamage: { base: 130, perLevel: 9 }, // 03 §8.1: "130% + 9%/L"
    flatDamage: null,
    radius: { base: 4.0, perLevel: 0 },
    duration: null, projectile: null,
    // `chance` is 05 §2.5 L609's own printed value: `onHitStatus: [{
    // status:'cursed', chance:100, duration:6.0, magnitude: 40 + 1 x (slvl
    // - 1) }]` — percentage on 0..100, "always applies".
    onHitStatus: [
      { status: 'cursed', chance: 100, duration: { base: 6, perLevel: 0 }, magnitude: { base: 40, perLevel: 1, cap: 70 } },
    ],
    synergies: [{ skillId: 'bloodletting', stat: 'weaponDamage', perLevel: 6 }], // 05 §8.7 #2
    passiveStats: null,
    tags: ['melee', 'aoe', 'nova', 'curse'],
    fxId: 'sunder', iconSeed: 0xb11f27f4,
    extra: null,
  }),

  // ===========================================================================
  // Ravager — Unyielding (`03-combat-math.md` §8.2)
  // ===========================================================================
  Object.freeze({
    id: 'ram_charge', classId: 'ravager', tree: 'unyielding',
    displayName: 'Ram Charge', tier: 1, maxLevel: 20, requires: [],
    type: 'mobility', target: 'point', element: 'physical',
    cost: { resource: 'rage', base: 10, perLevel: 0.40, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 8.0, perLevel: -0.20, minimum: 4.0 }, // 03 §8.2, S4's own named floor
    castTime: 0, attackScale: 1.00, // no cast/attack-scale clause in 03 §8.2 — see extra.travel for the dash's own timing
    weaponDamage: { base: 100, perLevel: 7 }, // 03 §8.2: "100% + 7%/L on arrival"
    flatDamage: null,
    radius: { base: 1.8, perLevel: 0 },
    duration: null, projectile: null,
    // `chance` is 05 §3.1 L706's own printed value: `onHitStatus: [{
    // status:'stunned', chance:100, duration: 1.5 + 0.05 x (slvl - 1) }]`.
    onHitStatus: [
      { status: 'stunned', chance: 100, duration: { base: 1.5, perLevel: 0.05, cap: 2.5 }, magnitude: null },
    ],
    synergies: [],
    passiveStats: null,
    tags: ['melee', 'mobility', 'stun'],
    fxId: 'ram_charge', iconSeed: 0x2c9a0dc0,
    extra: {
      travel: { speedMps: 16, rangeM: 9 }, // 03 §8.2: "dash at 16 m/s, up to 9 m"
    },
  }),
  Object.freeze({
    id: 'shield_stance', classId: 'ravager', tree: 'unyielding',
    displayName: 'Shield Stance', tier: 6, maxLevel: 20, requires: [],
    type: 'passive', target: 'none', element: 'physical',
    cost: { resource: null, base: 0, perLevel: 0, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0, attackScale: 1.00,
    weaponDamage: null, flatDamage: null, radius: null, duration: null, projectile: null, onHitStatus: [],
    synergies: [],
    // 03 §8.2 (D-05-3 applied): blockChance/thorns/dodgeChance. dodgeChance
    // was the finding of D-05-3 — §8.2's row now states it, transcribed here.
    passiveStats: {
      blockChance: { base: 8, perLevel: 1.6 },
      thorns: { base: 6, perLevel: 4 },
      dodgeChance: { base: 3, perLevel: 0.5 }, // D-05-3
    },
    tags: ['passive', 'defense'],
    fxId: 'shield_stance', iconSeed: 0x9c4754ed,
    extra: null,
  }),
  Object.freeze({
    id: 'war_cry', classId: 'ravager', tree: 'unyielding',
    displayName: 'War Cry', tier: 12, maxLevel: 20, requires: [],
    type: 'nova', target: 'self', element: 'physical', // no direct damage of its own — stun + self-buff only
    cost: { resource: 'rage', base: 18, perLevel: 0.60, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 14.0, perLevel: 0, minimum: 14.0 },
    castTime: 0.50, attackScale: 1.00,
    weaponDamage: null, flatDamage: null,
    radius: { base: 7.0, perLevel: 0 },
    duration: null, projectile: null,
    // `chance` is 05 §3.3 L868's own printed value: `onHitStatus: [{
    // status:'stunned', chance:100, duration: (1.2 + 0.06 x (slvl - 1)) x
    // (1 + 0.05 x allocated(ram_charge)) }]`.
    onHitStatus: [
      { status: 'stunned', chance: 100, duration: { base: 1.2, perLevel: 0.06 }, magnitude: null },
    ],
    synergies: [{ skillId: 'ram_charge', stat: 'stunDuration', perLevel: 5 }], // 05 §8.7 #3
    passiveStats: null,
    tags: ['self', 'nova', 'stun', 'buff'],
    fxId: 'war_cry', iconSeed: 0x26cc7f12,
    extra: {
      // 03 §8.2: "Self-buff enhancedDamage += 15 + 2/L for 12 s" — temporary
      // (not permanent, so not `passiveStats`, which is for type:'passive'
      // records — `war_cry` is type:'nova').
      selfBuff: { enhancedDamagePercent: { base: 15, perLevel: 2 }, durationS: 12 },
    },
  }),
  Object.freeze({
    id: 'iron_skin', classId: 'ravager', tree: 'unyielding',
    displayName: 'Iron Skin', tier: 12, maxLevel: 20, requires: [],
    type: 'passive', target: 'none', element: 'physical',
    cost: { resource: null, base: 0, perLevel: 0, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0, attackScale: 1.00,
    weaponDamage: null, flatDamage: null, radius: null, duration: null, projectile: null, onHitStatus: [],
    synergies: [{ skillId: 'shield_stance', stat: 'defensePercent', perLevel: 4 }], // 05 §8.7 #4
    passiveStats: {
      defensePercent: { base: 25, perLevel: 5 },
      physicalResist: { base: 1, perLevel: 0.5, cap: 25 },
    },
    tags: ['passive', 'defense'],
    fxId: 'iron_skin', iconSeed: 0x7f3e405d,
    extra: null,
  }),
  Object.freeze({
    id: 'last_stand', classId: 'ravager', tree: 'unyielding',
    displayName: 'Last Stand', tier: 18, maxLevel: 20, requires: [],
    type: 'passive', target: 'self', element: 'physical',
    cost: { resource: null, base: 0, perLevel: 0, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 90, perLevel: -2, minimum: 50 }, // 03 §8.2, S4's own named floor
    castTime: 0, attackScale: 1.00,
    weaponDamage: null, flatDamage: null, radius: null,
    duration: { base: 8, perLevel: 0 }, // absorb shield duration
    projectile: null, onHitStatus: [],
    // 05 §8.2: "the only completely isolated skill in the game" — no
    // synergy in or out, by design (a synergisable death-save stops being
    // a save).
    synergies: [],
    passiveStats: null, // triggered, not a permanent stat grant — see extra.trigger
    tags: ['passive', 'trigger', 'survival'],
    fxId: 'last_stand', iconSeed: 0x6bf5cfc6,
    extra: {
      // 03 §8.2: "passive trigger at life <= 25% maxLife: absorb shield of
      // 40 + 22/L for 8 s; +40 rage"
      trigger: { condition: 'life<=0.25*maxLife', absorb: { base: 40, perLevel: 22 }, rageGrant: 40 },
    },
  }),

  // ===========================================================================
  // Emberwright — Flame (`03-combat-math.md` §8.3)
  // ===========================================================================
  Object.freeze({
    id: 'ember_bolt', classId: 'emberwright', tree: 'flame',
    displayName: 'Ember Bolt', tier: 1, maxLevel: 20, requires: [],
    type: 'projectile', target: 'point', element: 'fire',
    cost: { resource: 'mana', base: 2.0, perLevel: 0.25, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0.55, attackScale: 1.00,
    weaponDamage: null,
    flatDamage: { minBase: 3, minPerLevel: 2.25, maxBase: 7, maxPerLevel: 3.75 }, // 03 §8.3
    radius: null, duration: null,
    projectile: { speed: 26, lifetime: 2.2, radius: 0.30, pierce: { fromLevel: 10 }, gravity: 0, homing: 0, maxTargets: 1, chain: null },
    onHitStatus: [],
    synergies: [],
    passiveStats: null,
    tags: ['ranged', 'fire', 'projectile'],
    fxId: 'ember_bolt', iconSeed: 0x4004d8fa,
    extra: null,
  }),
  Object.freeze({
    id: 'flame_wave', classId: 'emberwright', tree: 'flame',
    displayName: 'Flame Wave', tier: 6, maxLevel: 20, requires: [],
    type: 'cone', target: 'direction', element: 'fire',
    cost: { resource: 'mana', base: 5.0, perLevel: 0.50, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0.65, attackScale: 1.00,
    weaponDamage: null,
    flatDamage: { minBase: 6, minPerLevel: 3.2, maxBase: 12, maxPerLevel: 5.4 }, // 03 §8.3
    radius: { base: 7.0, perLevel: 0 }, // 90 deg cone, 7.0 m
    duration: null, projectile: null,
    // `chance` here is an INFERENCE, not a literal printed number, unlike
    // the other seven riders in this file — flagged distinctly in this
    // round's report. 05 §4.2 L1211 says only "this skill overrides the
    // default seeding (03 §7.4): 0.45x ... over 4.0s instead of 0.35x over
    // 3.0s" — RATE and DURATION only. No `onHitStatus`/`chance` field is
    // printed anywhere in this section. The "default seeding" it overrides
    // (used unconditionally by ember_bolt/fireball/meteor/smouldering_ward/
    // essence_burn, none of which carry a `chance` field in this file
    // either) has no probability roll described anywhere in the read
    // range — it applies whenever fire damage lands. Since the override
    // names only rate and duration, applicability is read as unchanged
    // from that default, hence 100.
    onHitStatus: [
      { status: 'burning', chance: 100, duration: { base: 4, perLevel: 0 }, magnitude: { base: 0.45, perLevel: 0 } }, // "45% of the fire damage dealt"
    ],
    synergies: [],
    passiveStats: null,
    tags: ['fire', 'cone', 'aoe'],
    fxId: 'flame_wave', iconSeed: 0xb5155f9c,
    extra: null,
  }),
  Object.freeze({
    id: 'fireball', classId: 'emberwright', tree: 'flame',
    displayName: 'Fireball', tier: 12, maxLevel: 20, requires: [],
    type: 'projectile', target: 'point', element: 'fire',
    cost: { resource: 'mana', base: 7.0, perLevel: 0.70, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0.60, attackScale: 1.00,
    weaponDamage: null,
    flatDamage: { minBase: 14, minPerLevel: 6, maxBase: 26, maxPerLevel: 10 }, // 03 §8.3
    radius: { base: 2.8, perLevel: 0.03 }, // blast radius 2.8 + 0.03/L m
    duration: null,
    // 05 §4.3 L1241-1324 `DamagePacket` row: `ProjectileSpec | { speed: 26,
    // lifetime: 2.2, radius: 0.34, pierce: false, gravity: 0, homing: 0,
    // maxTargets: 1 }` — "it detonates on the first body or on lifetime
    // expiry". `03` §8 alone gave no number here (confirmed absent from
    // that section); this section does. An earlier draft of this record,
    // written before this section was granted, is why the coordinator's
    // review caught a fabricated placeholder here — see this ticket's
    // report for that history.
    projectile: { speed: 26, lifetime: 2.2, radius: 0.34, pierce: false, gravity: 0, homing: 0, maxTargets: 1, chain: null },
    onHitStatus: [],
    synergies: [],
    passiveStats: null,
    tags: ['ranged', 'fire', 'projectile', 'aoe'],
    fxId: 'fireball', iconSeed: 0x83bad9b8,
    extra: null,
  }),
  Object.freeze({
    id: 'meteor', classId: 'emberwright', tree: 'flame',
    displayName: 'Meteor', tier: 18, maxLevel: 20,
    requires: [{ skillId: 'fireball', level: 3 }], // 03 §8.3, 05 §8.8
    type: 'ground', target: 'point', element: 'fire',
    cost: { resource: 'mana', base: 16.0, perLevel: 1.20, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 4.0, perLevel: 0, minimum: 4.0 },
    castTime: 0.70, attackScale: 1.00,
    weaponDamage: null,
    flatDamage: { minBase: 34, minPerLevel: 14, maxBase: 58, maxPerLevel: 22 }, // impact damage, 03 §8.3
    radius: { base: 4.2, perLevel: 0 }, // impact blast radius
    duration: { base: 6, perLevel: 0 }, // the ground pool's own lifetime
    projectile: null, onHitStatus: [],
    // Two incoming synergies — the only skill with two (05 §8.3).
    synergies: [
      { skillId: 'ember_bolt', stat: 'flatDamage', perLevel: 6 }, // 05 §8.7 #5
      { skillId: 'fireball', stat: 'flatDamage', perLevel: 5 }, // 05 §8.7 #6
    ],
    passiveStats: null,
    tags: ['fire', 'ground', 'aoe', 'capstone'],
    fxId: 'meteor', iconSeed: 0x49ca6f59,
    extra: {
      impactDelayS: 1.20, // 03 §8.3: "cast 0.70 s, impact after 1.20 s"
      groundPool: { radiusM: 3.2, tickFire: { base: 6, perLevel: 2.4 } }, // 03 §8.3: "fire pool for 6 s dealing (6 + 2.4/L) fire/s in radius 3.2 m"
    },
  }),
  Object.freeze({
    id: 'incinerate', classId: 'emberwright', tree: 'flame',
    displayName: 'Incinerate', tier: 18, maxLevel: 20, requires: [],
    type: 'passive', target: 'none', element: 'fire',
    cost: { resource: null, base: 0, perLevel: 0, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0, attackScale: 1.00,
    weaponDamage: null, flatDamage: null,
    radius: { base: 2.5, perLevel: 0 }, // on-kill detonation radius
    duration: null, projectile: null, onHitStatus: [],
    synergies: [{ skillId: 'flame_wave', stat: 'detonationDamage', perLevel: 4 }], // 05 §8.7 #7
    passiveStats: { fireDamagePercent: { base: 12, perLevel: 4 } }, // 03 §8.3
    tags: ['passive', 'fire', 'trigger'],
    fxId: 'incinerate', iconSeed: 0x531b6fd1,
    extra: {
      // 03 §8.3: "An enemy killed by fire detonates for (25 + 3/L)% of its
      // maxLife as fire in radius 2.5 m (does not chain)"
      onKillDetonation: { percentOfMaxLife: { base: 25, perLevel: 3 }, chains: false },
    },
  }),

  // ===========================================================================
  // Emberwright — Ash (`03-combat-math.md` §8.4)
  // ===========================================================================
  Object.freeze({
    id: 'ashen_step', classId: 'emberwright', tree: 'ash',
    displayName: 'Ashen Step', tier: 1, maxLevel: 20, requires: [],
    type: 'mobility', target: 'point', element: 'physical', // no damage of its own — blink + status cloud
    cost: { resource: 'mana', base: 6.0, perLevel: 0.40, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 3.0, perLevel: -0.06, minimum: 1.8 }, // 03 §8.4, S4's own named floor
    castTime: 0, attackScale: 1.00, // "instant"
    weaponDamage: null, flatDamage: null,
    radius: { base: 2.5, perLevel: 0 }, // ash cloud radius
    duration: { base: 4, perLevel: 0 }, // ash cloud duration
    projectile: null,
    // 05 §5.1 L1506-1594 (status effects table): slowed refreshes every
    // 0.5 s while inside the cloud and lingers 1.0 s after leaving — that
    // 1.0 s is the per-application `duration` below, distinct from the
    // cloud's own 4.0 s lifetime (the top-level `duration` field above).
    // blinded is FIXED at magnitude 60 for 3.0 s per application — not
    // tied to the cloud's own 4.0 s lifetime either.
    //
    // `chance` here is an INFERENCE, like flame_wave's, not a literal
    // printed number — the "Field application" row (L1556) reads: "every
    // 0.5 s the field re-applies slowed ... and blinded ... to every
    // hostile inside it, each as an attackRating = 0, zero-damage packet
    // SO THE RIDERS LAND without a to-hit roll." No `chance` field is
    // printed. Read as 100: the clause states the riders LAND, as a direct
    // consequence of there being no roll to fail, for every hostile inside
    // the field every 0.5 s tick — there is no described gate beyond that.
    onHitStatus: [
      { status: 'slowed', chance: 100, duration: { base: 1.0, perLevel: 0 }, magnitude: { base: 40, perLevel: 1, cap: 60 } },
      { status: 'blinded', chance: 100, duration: { base: 3.0, perLevel: 0 }, magnitude: { base: 60, perLevel: 0 } },
    ],
    synergies: [],
    passiveStats: null,
    tags: ['mobility', 'utility'],
    fxId: 'ashen_step', iconSeed: 0x18389e17,
    extra: {
      travel: { range: { base: 8.0, perLevel: 0.10, cap: 10 } }, // 03 §8.4: "Blink up to 8.0 + 0.10/L m (cap 10 m)"
    },
  }),
  Object.freeze({
    id: 'mana_weave', classId: 'emberwright', tree: 'ash',
    displayName: 'Mana Weave', tier: 6, maxLevel: 20, requires: [],
    type: 'passive', target: 'none', element: 'physical',
    cost: { resource: null, base: 0, perLevel: 0, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0, attackScale: 1.00,
    weaponDamage: null, flatDamage: null, radius: null, duration: null, projectile: null, onHitStatus: [],
    synergies: [],
    passiveStats: {
      maxMana: { base: 12, perLevel: 6 },
      manaRegen: { base: 0.8, perLevel: 0.35 },
      damageTakenToMana: { base: 10, perLevel: 1, cap: 30 },
    },
    tags: ['passive', 'resource'],
    fxId: 'mana_weave', iconSeed: 0xfeda39db,
    extra: null,
  }),
  Object.freeze({
    id: 'smouldering_ward', classId: 'emberwright', tree: 'ash',
    displayName: 'Smouldering Ward', tier: 12, maxLevel: 20, requires: [],
    type: 'buff', target: 'self', element: 'fire',
    cost: { resource: 'mana', base: 12.0, perLevel: 1.00, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 10.0, perLevel: 0, minimum: 10.0 },
    castTime: 0.45, attackScale: 1.00,
    weaponDamage: null,
    // On-break nova — single deterministic figure, degenerate range (see file header)
    flatDamage: { minBase: 20, minPerLevel: 11, maxBase: 20, maxPerLevel: 11 },
    radius: { base: 3.5, perLevel: 0 },
    duration: { base: 20, perLevel: 0 }, // absorb duration
    projectile: null, onHitStatus: [],
    synergies: [],
    passiveStats: null,
    tags: ['self', 'buff', 'absorb', 'fire'],
    fxId: 'smouldering_ward', iconSeed: 0x904dae79,
    extra: {
      absorb: { base: 45, perLevel: 25 }, // 03 §8.4: "Absorbs 45 + 25/L damage for 20 s"
    },
  }),
  Object.freeze({
    id: 'ash_wall', classId: 'emberwright', tree: 'ash',
    displayName: 'Ash Wall', tier: 12, maxLevel: 20, requires: [],
    type: 'ground', target: 'point', element: 'fire',
    cost: { resource: 'mana', base: 14.0, perLevel: 1.10, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 12.0, perLevel: 0, minimum: 12.0 },
    castTime: 0.55, attackScale: 1.00,
    weaponDamage: null,
    // Per-second tick — single deterministic figure, degenerate range (see file header)
    flatDamage: { minBase: 8, minPerLevel: 3.4, maxBase: 8, maxPerLevel: 3.4 },
    radius: { base: 6.0, perLevel: 0 }, // wall LENGTH, not a circle — 03 §8.4: "A 6.0 m wall"
    duration: { base: 8, perLevel: 0 },
    projectile: null, onHitStatus: [],
    synergies: [{ skillId: 'ashen_step', stat: 'flatDamage', perLevel: 5 }], // 05 §8.7 #8
    passiveStats: null,
    tags: ['fire', 'ground', 'wall', 'block-projectiles'],
    fxId: 'ash_wall', iconSeed: 0xea521694,
    extra: {
      // 03 §8.4: "(8 + 3.4/L) fire per second to anything within 0.8 m" —
      // the tick figure is flatDamage above; 0.8 m is the proximity range.
      // `thickness` is 05 §5.4 L1751-1836's own ground-effect row: "a 6.0 m
      // line ... skills.addGroundEffect({ preset:'ash_wall', shape:'line',
      // length: 6.0, thickness: 1.6, seconds: 8.0 })" — a second, distinct
      // dimension from the 0.8 m damage-proximity check, both printed on
      // the same line of that section.
      proximityRangeM: 0.8,
      thicknessM: 1.6,
      blocksProjectiles: true,
    },
  }),
  Object.freeze({
    id: 'essence_burn', classId: 'emberwright', tree: 'ash',
    displayName: 'Essence Burn', tier: 18, maxLevel: 20, requires: [],
    type: 'nova', target: 'self', element: 'fire',
    // 03 §8.4: "all current mana, minimum 20" — see file header's note on
    // extending the `cost.base = 'all'` convention.
    cost: { resource: 'mana', base: 'all', perLevel: 0, perSecond: false, minimum: 20, resonance: 0 },
    cooldown: { base: 8.0, perLevel: 0, minimum: 8.0 },
    castTime: 0.80, attackScale: 1.00,
    weaponDamage: null, flatDamage: null, // damage is spentMana x manaConversion, not a flat/weapon table — see extra
    radius: { base: 5.0, perLevel: 0.05 }, // 03 §8.4: "radius 5.0 + 0.05/L m"
    duration: null, projectile: null, onHitStatus: [],
    synergies: [{ skillId: 'mana_weave', stat: 'manaConversion', perLevel: 4 }], // 05 §8.7 #9
    passiveStats: null,
    tags: ['self', 'nova', 'fire', 'capstone'],
    fxId: 'essence_burn', iconSeed: 0x27495f7f,
    extra: {
      // 03 §8.4: "Fire damage = spentMana x (1.10 + 0.14/L)"
      manaConversion: { base: 1.10, perLevel: 0.14 },
    },
  }),

  // ===========================================================================
  // Runeblade — Enchanted Blade (`03-combat-math.md` §8.5)
  // ===========================================================================
  Object.freeze({
    id: 'rune_strike', classId: 'runeblade', tree: 'enchanted_blade',
    displayName: 'Rune Strike', tier: 1, maxLevel: 20, requires: [],
    type: 'attack', target: 'actor', element: 'physical',
    cost: { resource: 'mana', base: 2.0, perLevel: 0.20, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0, attackScale: 1.00,
    weaponDamage: { base: 115, perLevel: 7 }, // 03 §8.5: "115% + 7%/L"
    flatDamage: null, radius: null, duration: null, projectile: null, onHitStatus: [],
    synergies: [], // this is a SOURCE (-> cascade), see cascade's own record
    passiveStats: null,
    tags: ['melee', 'resonance'],
    fxId: 'rune_strike', iconSeed: 0xda76e65c,
    extra: {
      // 03 §8.5 (D-05-2 applied): "manaReturnPercent doubled for this hit.
      // Grants the class-base +1 Resonance of any landed melee hit and no
      // more" — the +1/landed-hit itself is the general Runeblade class
      // mechanic (every weapon hit grants it, not just this skill), so it
      // is not a per-skill number to store here; only the multiplier this
      // skill specifically adds is.
      manaReturnMultiplier: 2,
    },
  }),
  Object.freeze({
    id: 'blade_seal', classId: 'runeblade', tree: 'enchanted_blade',
    displayName: 'Blade Seal', tier: 1, maxLevel: 20, requires: [],
    type: 'buff', target: 'self', element: 'physical', // imbue element is chosen at cast time — see file header
    cost: { resource: 'mana', base: 5.0, perLevel: 0.35, perSecond: false, minimum: null, resonance: 'all' }, // D-05-2, 01 §6.1's own 'all' convention
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0.25, attackScale: 1.00,
    weaponDamage: null,
    flatDamage: { minBase: 2, minPerLevel: 2.5, maxBase: 7, maxPerLevel: 4.5 }, // imbue amount per hit, 03 §8.5
    radius: null, duration: null, projectile: null, onHitStatus: [],
    synergies: [], // this is a SOURCE (-> phase_leap), see phase_leap's own record
    passiveStats: null,
    tags: ['self', 'buff', 'resonance'],
    fxId: 'blade_seal', iconSeed: 0x705b5cd7,
    extra: {
      // 03 §8.5: "Imbues the next 3 weapon hits (4 at L >= 8, 5 at L >= 15)"
      // — a level-threshold table, not a linear per-level curve.
      imbueCount: { tiers: [{ minLevel: 1, count: 3 }, { minLevel: 8, count: 4 }, { minLevel: 15, count: 5 }] },
      // 05 §6.2 L2012-2100 status effects row: "cold imbues feed
      // `chillPoints` at magnitude 30 per hit" — fixed, not per-level (the
      // freeze threshold of 100 and the "7 cold hits at 0.650 s cadence"
      // reading are both derived from this one constant plus the weapon's
      // own attack interval, not stored again here). Fire imbues seed
      // `burning` by the default rule (no data needed — see the file
      // header's "default seeding" note); lightning imbues carry no rider.
      imbueEffects: { cold: { chillMagnitudePerHit: 30 } },
    },
  }),
  Object.freeze({
    id: 'cascade', classId: 'runeblade', tree: 'enchanted_blade',
    displayName: 'Cascade', tier: 6, maxLevel: 20, requires: [],
    type: 'passive', target: 'none', element: 'magic', // R3 (05 §1.6): computed on weapon physical, re-typed to magic
    cost: { resource: null, base: 0, perLevel: 0, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0, attackScale: 1.00,
    weaponDamage: { base: 70, perLevel: 6 }, // 03 §8.5: "70% + 6%/L as magic in radius 4.5 m"
    flatDamage: null,
    radius: { base: 4.5, perLevel: 0 },
    duration: null, projectile: null, onHitStatus: [],
    synergies: [{ skillId: 'rune_strike', stat: 'weaponDamage', perLevel: 7 }], // 05 §8.7 #10
    passiveStats: null, // triggered, not a permanent stat grant — see extra.trigger
    tags: ['passive', 'trigger', 'magic'],
    fxId: 'cascade', iconSeed: 0x0a253055,
    extra: {
      trigger: { afterEmpoweredHits: 3 }, // 03 §8.5: "After 3 empowered hits (rune_strike or imbued), releases a wave"
    },
  }),
  Object.freeze({
    id: 'phase_leap', classId: 'runeblade', tree: 'enchanted_blade',
    displayName: 'Phase Leap', tier: 12, maxLevel: 20, requires: [],
    type: 'mobility', target: 'actor', element: 'physical',
    cost: { resource: 'mana', base: 9.0, perLevel: 0.70, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 5.0, perLevel: -0.12, minimum: 2.5 }, // 03 §8.5, S4's own named floor
    castTime: 0, attackScale: 1.00, // "instant"
    weaponDamage: { base: 140, perLevel: 9 }, // 03 §8.5: "strike for weapon damage 140% + 9%/L"
    flatDamage: null, radius: null, duration: null, projectile: null, onHitStatus: [],
    synergies: [{ skillId: 'blade_seal', stat: 'weaponDamage', perLevel: 5 }], // 05 §8.7 #11
    passiveStats: null,
    tags: ['melee', 'mobility'],
    fxId: 'phase_leap', iconSeed: 0x87b342d3,
    extra: {
      travel: { teleportRangeM: 10 }, // 03 §8.5: "Teleport to a target within 10 m"
    },
  }),
  Object.freeze({
    id: 'echo_blade', classId: 'runeblade', tree: 'enchanted_blade',
    displayName: 'Echo Blade', tier: 18, maxLevel: 20, requires: [],
    type: 'summon', target: 'self', element: 'physical',
    cost: { resource: 'mana', base: 22.0, perLevel: 1.50, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 25.0, perLevel: 0, minimum: 25.0 },
    castTime: 0.60, attackScale: 1.00,
    weaponDamage: { base: 40, perLevel: 2 }, // 03 §8.5: "repeats ... at 40% + 2%/L damage"
    flatDamage: null, radius: null,
    duration: { base: 10, perLevel: 0.3 }, // 03 §8.5: "Spectral duplicate for 10 + 0.3/L s"
    projectile: null, onHitStatus: [],
    synergies: [{ skillId: 'resonance_circuit', stat: 'echoDamage', perLevel: 4 }], // 05 §8.7 #14, the one cross-tree synergy
    passiveStats: null,
    tags: ['summon', 'capstone'],
    fxId: 'echo_blade', iconSeed: 0xf9905a9d,
    extra: {
      // 03 §8.5: "carries ACTOR_FLAG.visualOnly (deals damage, takes none),
      // and does not generate Resonance or mana" — flags, not level curves.
      visualOnly: true, generatesResonanceOrMana: false,
    },
  }),

  // ===========================================================================
  // Runeblade — Conduit (`03-combat-math.md` §8.6)
  // ===========================================================================
  Object.freeze({
    id: 'discharge', classId: 'runeblade', tree: 'conduit',
    displayName: 'Discharge', tier: 1, maxLevel: 20, requires: [],
    type: 'projectile', target: 'actor', element: 'lightning',
    cost: { resource: 'mana', base: 4.0, perLevel: 0.35, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0.40, attackScale: 1.00,
    weaponDamage: null,
    flatDamage: { minBase: 3, minPerLevel: 2.6, maxBase: 11, maxPerLevel: 6.2 }, // 03 §8.6
    radius: null, duration: null,
    // 05 §7.1 L2344-2427 `DamagePacket` row, printed verbatim: `ProjectileSpec
    // | { speed: 0 (instant beam), lifetime: 0.35, radius: 0, pierce: false,
    // chain: { jumps: min(6, 3 + floor(slvl/6)), range: 6.0, falloffPercent:
    // 25 } }`. `speed: 0` / `radius: 0` are the printed values for an
    // instant beam, not the schema's "absent" sentinel this ticket used
    // before this section was granted (an earlier draft here read `null`
    // for all three and was corrected against this table — see this
    // ticket's report). `gravity`/`homing` stay at their schema-documented
    // "feature absent" defaults (`01` §6.1) — 05 §7.1 doesn't mention
    // either, consistent with a beam that travels in a straight line with
    // no arc.
    //
    // `jumps` is decomposed into `{jumpsBase, jumpsLevelDivisor, jumpsCap}`
    // rather than stored as a single number, because it is a function of
    // `slvl` (evaluated at cast time, `05` §14 step 12's job), not a static
    // per-record constant — the SAME reason every other level-scaling field
    // in this file is `{base, perLevel}` rather than one number. The
    // formula transcribed here is EXACTLY the printed one:
    // `jumps = min(jumpsCap, jumpsBase + floor(slvl / jumpsLevelDivisor))`.
    // Verified against all five printed target-count rows: L1..5 -> 3
    // (floor(1/6)=0 .. floor(5/6)=0), L6..11 -> 4 (floor(6/6)=1 ..
    // floor(11/6)=1), L12..17 -> 5, L18..20 -> 6, capped. An EARLIER DRAFT
    // of this record used `floor((slvl-1)/6)` (matching every OTHER curve's
    // `(L-1)` convention) — that reads L6 as 3 targets, not 4, and is wrong
    // against this table; fixed to the printed `floor(slvl/6)` here, which
    // deliberately does NOT follow the `(L - 1)` convention every other
    // curve in this file uses.
    projectile: {
      speed: 0, lifetime: 0.35, radius: 0, pierce: false, gravity: 0, homing: 0, maxTargets: 1,
      chain: { jumpsBase: 3, jumpsLevelDivisor: 6, jumpsCap: 6, range: 6.0, falloffPercent: 25 },
    },
    onHitStatus: [],
    synergies: [], // this is a SOURCE (-> unity, -> thunder_step), see those records
    passiveStats: null,
    tags: ['ranged', 'lightning', 'chain'],
    fxId: 'discharge', iconSeed: 0x8b83f9b7,
    extra: null,
  }),
  Object.freeze({
    id: 'resonance_circuit', classId: 'runeblade', tree: 'conduit',
    displayName: 'Resonance Circuit', tier: 6, maxLevel: 20, requires: [],
    type: 'passive', target: 'none', element: 'physical',
    cost: { resource: null, base: 0, perLevel: 0, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 0, perLevel: 0, minimum: 0 },
    castTime: 0, attackScale: 1.00,
    weaponDamage: null, flatDamage: null, radius: null, duration: null, projectile: null, onHitStatus: [],
    synergies: [], // this is a SOURCE (-> echo_blade, cross-tree), see that record
    passiveStats: {
      maxResonance: { base: 1, perLevel: 0 }, // "+1" flat, plus the L>=10 threshold bonus below
      manaReturnPercent: { base: 4, perLevel: 0.8 },
      // 05's own printed reading (§1.6, not inferred): no base term — 0 at
      // L1, 1.9 at L20.
      resonanceOnHit: { base: 0, perLevel: 0.1 },
    },
    tags: ['passive', 'resonance'],
    fxId: 'resonance_circuit', iconSeed: 0x49402693,
    extra: {
      thresholdBonus: { atLevel: 10, maxResonanceBonus: 1 }, // 03 §8.6: "(and +1 more at L >= 10)"
    },
  }),
  Object.freeze({
    id: 'polarity', classId: 'runeblade', tree: 'conduit',
    displayName: 'Polarity', tier: 12, maxLevel: 20, requires: [],
    type: 'toggle', target: 'self', element: 'physical', // modifies percentages, no damage of its own
    cost: { resource: 'mana', base: 10, perLevel: 0, perSecond: false, minimum: null, resonance: 0 }, // "10 mana to switch"
    cooldown: { base: 1.5, perLevel: 0, minimum: 1.5 }, // the 1.5 s switch lockout, modelled as a cooldown between toggles
    castTime: 0, attackScale: 1.00,
    weaponDamage: null, flatDamage: null, radius: null, duration: null, projectile: null, onHitStatus: [],
    synergies: [],
    passiveStats: null, // conditional on active stance — see extra.stances
    tags: ['self', 'toggle'],
    fxId: 'polarity', iconSeed: 0x9db7fdc9,
    extra: {
      // 03 §8.6: "Blade: physicalDamagePercent += 30 + 2/L, elementalDamagePercent -= 15.
      // Storm: elementalDamagePercent += 30 + 2/L, physicalDamagePercent -= 15"
      stances: {
        blade: { physicalDamagePercent: { base: 30, perLevel: 2 }, elementalDamagePercent: -15 },
        storm: { elementalDamagePercent: { base: 30, perLevel: 2 }, physicalDamagePercent: -15 },
      },
    },
  }),
  Object.freeze({
    id: 'thunder_step', classId: 'runeblade', tree: 'conduit',
    displayName: 'Thunder Step', tier: 12, maxLevel: 20, requires: [],
    type: 'mobility', target: 'point', element: 'lightning',
    cost: { resource: 'mana', base: 11.0, perLevel: 0.80, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 6.0, perLevel: -0.15, minimum: 3.0 }, // 03 §8.6, S4's own named floor
    castTime: 0, attackScale: 1.00, // "instant, 7 m dash"
    weaponDamage: null,
    flatDamage: { minBase: 10, minPerLevel: 5, maxBase: 22, maxPerLevel: 9 }, // on-arrival damage, 03 §8.6
    radius: { base: 3.5, perLevel: 0 },
    duration: null, projectile: null,
    // 05 §7.4 L2632 `DamagePacket` row, printed verbatim: `onHitStatus:
    // [{ status:'shocked', chance:100, stacks:1, duration:4.0 }]`. No
    // `magnitude` field is printed on this row — the status effects table
    // right below it in the same section states the +12%/stack figure as a
    // property of `shocked` itself ("+12% extra damage taken per stack ...
    // additive stacks to 3"), not a per-skill number this record scales;
    // every skill that applies `shocked` would print the same +12%, so it
    // belongs to the global status registry (03 §7, not read this ticket),
    // not here. `magnitude: null` reflects that split, not an unknown.
    //
    // `chance` is on 0..100 (`src/combat/status.js:562`: `env.rng.next() *
    // 100 >= rider.chance`) — a previous round of this file wrote `1` here
    // despite this very comment already saying `chance:100`, which read as
    // "applies 1% of the time" to the real consumer. Caught by the
    // coordinator's review across all eight `onHitStatus` riders in this
    // file; fixed here and at every other occurrence — see this round's
    // report.
    onHitStatus: [
      { status: 'shocked', chance: 100, stacks: 1, duration: { base: 4.0, perLevel: 0 }, magnitude: null },
    ],
    synergies: [{ skillId: 'discharge', stat: 'flatDamage', perLevel: 5 }], // 05 §8.7 #13
    passiveStats: null,
    tags: ['mobility', 'lightning'],
    fxId: 'thunder_step', iconSeed: 0x2911ab08,
    extra: {
      travel: { rangeM: 7 }, // 03 §8.6: "7 m dash"
    },
  }),
  Object.freeze({
    id: 'unity', classId: 'runeblade', tree: 'conduit',
    displayName: 'Unity', tier: 18, maxLevel: 20, requires: [],
    type: 'buff', target: 'self', element: 'physical', // no damage of its own — the free-cast discharge carries its own lightning element
    cost: { resource: 'mana', base: 26.0, perLevel: 1.60, perSecond: false, minimum: null, resonance: 0 },
    cooldown: { base: 30.0, perLevel: 0, minimum: 30.0 },
    castTime: 0.50, attackScale: 1.00,
    weaponDamage: null, flatDamage: null, radius: null,
    duration: { base: 8, perLevel: 0.2 }, // 03 §8.6: "For 8 + 0.2/L s"
    projectile: null, onHitStatus: [],
    synergies: [{ skillId: 'discharge', stat: 'flatDamage', perLevel: 6 }], // 05 §8.7 #12
    passiveStats: null,
    tags: ['self', 'buff', 'lightning', 'capstone'],
    fxId: 'unity', iconSeed: 0xd318b45a,
    extra: {
      // 03 §8.6: "every landed weapon hit free-casts discharge at its own
      // current level, at no mana cost and off cooldown"
      freeCast: { skillId: 'discharge', costsResource: false, respectsCooldown: false },
    },
  }),
]);

// Sanity: 30 records, 30 unique ids — checked here (a static assertion over
// static data, not "logic" that computes a gameplay number) so an author
// error throws at import time in every harness, not just in a test file
// that happens to count.
if (SKILLS.length !== 30) {
  throw new Error(`src/skills/data/skills.js: expected 30 SkillDefinition records, found ${SKILLS.length}`);
}
{
  const seen = new Set();
  for (const def of SKILLS) {
    if (seen.has(def.id)) throw new Error(`src/skills/data/skills.js: duplicate skill id '${def.id}'`);
    seen.add(def.id);
  }
}
