// src/skills/passive.js
//
// SKIL-5 — Passives (`05-skills.md` §14 row 5 / `05.S08`): computes the
// `sources.skills` `StatBlock` partial (`01-data-model.md` §4.1) for every
// passive-type skill an actor has allocated. `./index.js` owns wiring this
// onto `actors.setSourceLayer(actor, 'skills', partial)` +
// `actors.markDirty(actor)` — this file is the pure engine only: no `ctx`,
// no subsystem import, no RNG/clock (`ARCHITECTURE.md` rule 2/4, the same
// discipline `./cost.js`'s own header documents).
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` sweeps `src/skills/`
// with `checkGlobals: true`). No `Math.random()`.
//
// ---------------------------------------------------------------------------
// D-46 — eight `type: 'passive'` skills, six of which grant a stat
// ---------------------------------------------------------------------------
// `bloodthirst`, `shield_stance`, `iron_skin`, `last_stand`, `incinerate`,
// `mana_weave`, `cascade`, `resonance_circuit` — eight rows, per the
// registry table (`05` §1.7), not the nine the prose miscounts (`05` §14
// row 5's own gloss: "the six PURE passives"). `last_stand` and `cascade`
// are passive TRIGGERS: their entire effect is trigger machinery (SKIL-10
// absorb-pool application, SKIL-13 the three-hit wave), not a permanent
// `sources.skills` grant — `./data/skills.js` (SKIL-1) already states this
// at each record's own `passiveStats: null` line ("triggered, not a
// permanent stat grant"). This file does not special-case those two ids
// anywhere: it walks whatever `passiveDefs` it is handed and a `null`
// `passiveStats` table naturally contributes nothing (the loop below skips
// it). Nothing here hard-codes "eight" or "six" or "nine" — `./index.js`
// builds `passiveDefs` by filtering the real registry on `type ===
// 'passive'` alone (eight defs, including the two triggers); THIS file is
// what narrows that down to a stat contribution, by skipping a `null`
// `passiveStats` table on each one it walks.
//
// ---------------------------------------------------------------------------
// `polarity` is not read here
// ---------------------------------------------------------------------------
// `polarity` (`type: 'toggle'`) also carries `passiveStats: null` — its two
// stances (`extra.stances.blade`/`.storm`) contribute stats conditionally on
// which stance is active, which is SKIL-7's toggle-state machinery, not a
// permanent per-level grant this file's `passiveDefs`-over-`type ===
// 'passive'` filter would even reach (`polarity`'s own `type` is
// `'toggle'`, never `'passive'`) — see this ticket's own trap #4 in the
// brief. Not built here.
//
// ---------------------------------------------------------------------------
// The one synergy that lands inside a passive's own contribution
// ---------------------------------------------------------------------------
// `iron_skin.passiveStats.defensePercent` is `25 + 5 × (slvl − 1)` in the
// data table, but `05` §3.4's binding formula is `25 + 5 × (slvl − 1) + 4 ×
// allocated(shield_stance)` — the synergy term lives in `iron_skin`'s own
// `synergies` array (`{skillId:'shield_stance', stat:'defensePercent',
// perLevel:4}`, already SKIL-1 data) and in `SkillsSystem#synergyBonus`
// (already SKIL-1 code, `05` §1.3: "synergies read the source's ALLOCATED
// level, never its effective level"). `computePassiveLayer` below calls it
// back in through the `synergyBonusFn` callback its own caller (`./index.js`)
// already owns — generic over every `passiveStats` key of every passive
// def, not special-cased to `iron_skin`/`shield_stance` by name, so a
// future passive with an incoming synergy on one of its own `passiveStats`
// fields gets this for free.
//
// ---------------------------------------------------------------------------
// `resonance_circuit.maxResonance`'s L>=10 threshold step
// ---------------------------------------------------------------------------
// `passiveStats.maxResonance` is a flat `{base:1, perLevel:0}` — a
// constant `+1` for any effective level >= 1 — and the extra `+1` at
// effective level >= 10 lives in the record's own `extra.thresholdBonus`
// (`{atLevel:10, maxResonanceBonus:1}`, SKIL-1 data, `03` §2.4/§8.6: "+1 at
// slvl >= 1 and +1 more at slvl >= 10, for a hard maximum of 5"). Read
// generically below (`def.extra && def.extra.thresholdBonus`), not by
// checking `def.id === 'resonance_circuit'`.
//
// ---------------------------------------------------------------------------
// `Alloc: no` after an actor's first call — the O-79 discipline
// ---------------------------------------------------------------------------
// `docs/PROGRESS.md` O-79: `actors.setSourceLayer()` immediately followed
// by `actors.stats()`, driven back-to-back, already reads a small but
// stable inherited floor inside `actors` itself (found under ITEM-11,
// unexplained, not this ticket's file to fix). `computePassiveLayer` does
// not add anything of its own on top of that floor: the partial object it
// returns is a SCRATCH OBJECT OWNED BY THE ACTOR (`actor._skillsPassiveLayer`,
// lazily created once, mutated in place and returned by reference on every
// later call — the same "attach a field the Actor record doesn't declare"
// precedent `./index.js`'s own header already establishes for
// `actor.skillPoints`), with a FIXED key shape (`PASSIVE_STAT_KEYS`,
// below) written in full on every call — every key always assigned, never
// added or `delete`d, so the object's hidden class never changes after the
// first call for a given actor. See `tests/skills/passive.perf.test.js`.

/** Every `StatBlock` field any of the six stat-granting passives can
 * contribute, transcribed from their own `passiveStats` tables in
 * `./data/skills.js` (`01-data-model.md` §3's names). Fixed and frozen —
 * the scratch object's shape is built from this ONCE per actor and never
 * grows or shrinks afterward (see the file header's "Alloc: no" section).
 */
const PASSIVE_STAT_KEYS = Object.freeze([
  'lifeSteal', // bloodthirst
  'blockChance', 'thorns', 'dodgeChance', // shield_stance (dodgeChance: D-05-3)
  'defensePercent', 'physicalResist', // iron_skin
  'fireDamagePercent', // incinerate
  'maxMana', 'manaRegen', 'damageTakenToMana', // mana_weave
  'maxResonance', 'manaReturnPercent', 'resonanceOnHit', // resonance_circuit
]);

/**
 * `base + perLevel × (slvl − 1)`, clamped to `entry.cap` if the entry
 * declares one (`iron_skin.physicalResist` cap 25, `mana_weave.
 * damageTakenToMana` cap 30 — both `03-combat-math.md` §8's own per-skill
 * caps, distinct from the `StatBlock`'s own cap machinery in
 * `src/actors/stats.js`, which clamps the SUMMED total across every
 * source, not one skill's own contribution).
 * @param {{base:number, perLevel:number, cap?:number}} entry
 * @param {number} slvl effective level, >= 1 (callers never call this at 0)
 * @returns {number}
 */
function evalEntry(entry, slvl) {
  let v = entry.base + entry.perLevel * (slvl - 1);
  if (entry.cap !== undefined && v > entry.cap) v = entry.cap;
  return v;
}

/** Resets every field of a passive-layer scratch object to 0 — same shape
 * every time, never a `delete` (see the file header). */
function zeroPassiveLayer(out) {
  for (let i = 0; i < PASSIVE_STAT_KEYS.length; i++) out[PASSIVE_STAT_KEYS[i]] = 0;
}

/**
 * Lazily creates (once) and returns `actor`'s own passive-layer scratch
 * object. NOT shared across actors — `actors.setSourceLayer` stores this
 * exact reference as `actor.sources.skills` (`01` §4.1: a layer is
 * replaced wholesale), so two actors sharing one scratch object would alias
 * each other's `sources.skills` the moment either recomposed.
 * @param {object} actor
 * @returns {object}
 */
function passiveLayerOf(actor) {
  let out = actor._skillsPassiveLayer;
  if (!out) {
    out = {};
    zeroPassiveLayer(out);
    actor._skillsPassiveLayer = out;
  }
  return out;
}

/**
 * Recomputes the full passive `sources.skills` partial for `actor`.
 * Mutates and returns `actor`'s own scratch object in place — `Alloc: no`
 * from an actor's second call onward (see the file header).
 * @param {object} actor
 * @param {object[]} passiveDefs every `SkillDefinition` with `type ===
 *   'passive'`, in registry order (`01` §4.2 step 5: "in skill-registry
 *   order") — `./index.js` builds this once in `init()`.
 * @param {(actor:object, skillId:string) => number} effectiveLevelFn
 *   `SkillsSystem#effectiveLevel`, bound by the caller.
 * @param {(actor:object, skillId:string, statKey:string) => number} synergyBonusFn
 *   `SkillsSystem#synergyBonus`, bound by the caller — see the file
 *   header's synergy section.
 * @returns {object} `actor._skillsPassiveLayer`, fully recomputed.
 */
export function computePassiveLayer(actor, passiveDefs, effectiveLevelFn, synergyBonusFn) {
  const out = passiveLayerOf(actor);
  zeroPassiveLayer(out);

  for (let i = 0; i < passiveDefs.length; i++) {
    const def = passiveDefs[i];
    const slvl = effectiveLevelFn(actor, def.id);
    if (slvl < 1) continue; // 01 §6.2: unallocated is forced to effective level 0 — contributes nothing

    const table = def.passiveStats;
    if (table) {
      for (const key in table) {
        let v = evalEntry(table[key], slvl);
        v += synergyBonusFn(actor, def.id, key);
        out[key] += v;
      }
    }

    const tb = def.extra && def.extra.thresholdBonus;
    if (tb && slvl >= tb.atLevel) out.maxResonance += tb.maxResonanceBonus;
  }

  return out;
}

export { PASSIVE_STAT_KEYS };
