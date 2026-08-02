// src/skills/synergy.js
//
// SKIL-12 — Synergies end to end (`05-skills.md` §14 row 12) and
// `skills.describe()` (`02-api-contracts.md:886` / `09-ui.md:3139`, UI-9's
// blocker). Two things live in this one file because they share the same
// math: a synergy is "a percent added to the target skill's own
// coefficient", and `describe()` is the one place that coefficient (with
// the synergy folded in) is ever printed for a human — "so skill
// mathematics never lives in two subsystems" is this file's whole reason
// to exist, not a slogan.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// (`tools/check-imports.mjs` sweeps `src/skills/` with `checkGlobals:
// true`). No `Math.random()` — nothing here needs randomness. No `Map`
// held across calls (`validateSynergyGraph`'s two `Map`s are built and
// discarded inside one call — not recycled state, not a per-frame cost;
// this function is called once, at `SkillsSystem#init()`, never from
// `fixedUpdate`).
//
// ---------------------------------------------------------------------------
// `synergyBonus` is NOT reimplemented here
// ---------------------------------------------------------------------------
// `SkillsSystem#synergyBonus(actor, skillId, statKey)` (SKIL-1,
// `./index.js`) already sums `perLevel × sourceAllocatedLevel` across every
// incoming synergy edge for a `(skillId, statKey)` pair, reading each
// source's `allocated` points — never its `effectiveLevel` — per
// `05-skills.md` §1.3 / `03-combat-math.md` §8.7: "otherwise `+skills`
// would compound quadratically." This file consumes that method (through
// the `synergyBonusFn` callback `buildSkillDescription` takes, the same
// bound-callback convention `./passive.js#computePassiveLayer` already
// uses for the same method), it does not duplicate its sum.
//
// ---------------------------------------------------------------------------
// S11 — every synergy source exists, is same-class, and the graph is
// acyclic (`05-skills.md` §13.1 row S11, quoted in this ticket's brief)
// ---------------------------------------------------------------------------
// `01-data-model.md` §6.1's own convention: a synergy lives on the TARGET
// record, naming its source (`{skillId, stat, perLevel}` inside
// `synergies`) — `collectSynergyEdges` below just flattens that back into
// one flat edge list. `validateSynergyGraph` proves the three S11 clauses
// over that edge list:
//   - source exists: `byId.has(edge.sourceId)`.
//   - same class: `source.classId === target.classId` (`05` §8.7: "no
//     synergy crosses a class boundary" — #14, `resonance_circuit` (Conduit)
//     -> `echo_blade` (Runic Edge), is the one CROSS-TREE synergy, still
//     within one class, `runeblade`).
//   - acyclic: every one of the fourteen edges' SOURCE id (`cleaving_strike`,
//     `bloodletting`, `ram_charge`, `shield_stance`, `ember_bolt`,
//     `fireball`, `flame_wave`, `ashen_step`, `mana_weave`, `rune_strike`,
//     `blade_seal`, `discharge` ×2, `resonance_circuit`) has an EMPTY
//     `synergies` array of its own — no target is ever also a source, so the
//     graph is trivially bipartite (source-set ∩ target-set = ∅) and cannot
//     contain a cycle. `validateSynergyGraph` does not special-case that
//     shortcut, though — it runs a real 3-colour DFS cycle search over
//     every node that appears as an edge endpoint, so a FUTURE synergy that
//     broke the bipartite shortcut (chained a target into a new source) would
//     still be caught, not silently passed by an assumption baked into the
//     checker itself.
// `SkillsSystem#init()` (`./index.js`) runs this once, at boot, over the
// live `SKILLS` table and throws if it ever fails — a real, wired
// invariant, not just a standalone test's opinion.

import { levelValue, computeCost, cooldownOf } from './cost.js';

/** `05-skills.md` §8.7's own heading: "All fourteen synergies." The S11/AC1
 * invariant this ticket exists to prove — never loosened, never widened. */
export const SYNERGY_EDGE_COUNT = 14;

/**
 * Flattens every `SkillDefinition.synergies` entry (target-owned, per
 * `01-data-model.md` §6.1) into one source -> target edge list.
 * @param {object[]} skills `SKILLS`, or a subset for a test
 * @returns {{sourceId:string, targetId:string, stat:string, perLevel:number}[]}
 */
export function collectSynergyEdges(skills) {
  const edges = [];
  for (const def of skills) {
    for (const syn of def.synergies) {
      edges.push({ sourceId: syn.skillId, targetId: def.id, stat: syn.stat, perLevel: syn.perLevel });
    }
  }
  return edges;
}

/**
 * S11: every synergy source exists, is same-class as its target, and the
 * source -> target graph is acyclic. Pure, one-shot (not a hot-path call —
 * `SkillsSystem#init()` calls this once; nothing calls it per-frame).
 * @param {object[]} skills `SKILLS`
 * @returns {{ok:boolean, edges:object[], errors:string[]}}
 */
export function validateSynergyGraph(skills) {
  const byId = new Map();
  for (const def of skills) byId.set(def.id, def);

  const edges = collectSynergyEdges(skills);
  const errors = [];

  if (edges.length !== SYNERGY_EDGE_COUNT) {
    errors.push(`expected exactly ${SYNERGY_EDGE_COUNT} synergies, found ${edges.length}`);
  }

  const adjacency = new Map(); // sourceId -> targetId[]
  const nodes = new Set();
  for (const edge of edges) {
    const source = byId.get(edge.sourceId);
    const target = byId.get(edge.targetId);
    nodes.add(edge.sourceId);
    nodes.add(edge.targetId);
    if (!source) { errors.push(`${edge.targetId}: synergy source '${edge.sourceId}' does not exist`); continue; }
    if (!target) { errors.push(`unknown target '${edge.targetId}' in synergy edge list`); continue; }
    if (source.classId !== target.classId) {
      errors.push(`${edge.sourceId} -> ${edge.targetId}: crosses a class boundary (${source.classId} -> ${target.classId})`);
    }
    let list = adjacency.get(edge.sourceId);
    if (!list) { list = []; adjacency.set(edge.sourceId, list); }
    list.push(edge.targetId);
  }

  // 3-colour DFS cycle search over every node touched by an edge (real
  // traversal, not the bipartite shortcut the header above documents).
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const path = [];
  const visit = (id) => {
    color.set(id, GRAY);
    path.push(id);
    const targets = adjacency.get(id);
    if (targets) {
      for (const t of targets) {
        const c = color.get(t) || WHITE;
        if (c === GRAY) errors.push(`cycle detected: ${path.concat(t).join(' -> ')}`);
        else if (c === WHITE) visit(t);
      }
    }
    path.pop();
    color.set(id, BLACK);
  };
  for (const id of nodes) {
    if ((color.get(id) || WHITE) === WHITE) visit(id);
  }

  return { ok: errors.length === 0, edges, errors };
}

// ===========================================================================
// describe() — the coefficient math (`03-combat-math.md` §6.1 B2/B7)
// ===========================================================================
//
// A synergy "adds `perLevel × sourceAllocatedLevel` percent to the named
// coefficient of the target skill" (`03` §8.7). Two different skill shapes,
// two different meanings of "add":
//
//   - `weaponDamage` skills carry an EXPLICIT percent coefficient
//     (`{base, perLevel}`, e.g. `whirlwind` 55% + 4%/L) — B2 "multiplies by
//     skill.weaponDamage/100 ... including synergy bonuses" reads as: the
//     synergy percent is added directly to that explicit number before the
//     /100 multiply. `weaponDamagePercentAt` below does exactly that
//     addition.
//
//   - `flatDamage` skills (min/max roll curves) carry NO separate percent
//     field — the curve's own printed numbers ARE the 100% baseline. A
//     synergy here has nothing explicit to add to, so it scales the curve's
//     result by `(100 + synergyPercent) / 100` instead. This is what the
//     ticket's own worked check proves: `ember_bolt` (+6%/L) and `fireball`
//     (+5%/L) at 20/20 allocated into `meteor` sum to `120 + 100 = 220`
//     synergy percent, and `(100 + 220) / 100 = 3.20` — NOT `100 + 220 =
//     320` (a raw damage number, not a multiplier). `flatDamageRangeAt`
//     below is this multiply.
//
// `def.weaponDamage` and `def.flatDamage` are never both non-null on one
// `SkillDefinition` (checked against every one of the 30 records in
// `./data/skills.js` while writing this file) — a skill is one shape or
// the other, never both, so `describe()`/`buildSkillDescription` branch on
// which is present rather than needing to combine them.

/**
 * B2: the effective weapon-damage coefficient at `level`, in PERCENT —
 * base curve plus every incoming `weaponDamage` synergy's flat
 * percentage-point addition. `null` for a skill with no `weaponDamage`
 * curve of its own (every `flatDamage`/passive/utility skill).
 * @param {object} def `SkillDefinition`
 * @param {number} level
 * @param {number} synergyPercent `skills.synergyBonus(actor, def.id, 'weaponDamage')`
 * @returns {number|null}
 */
export function weaponDamagePercentAt(def, level, synergyPercent) {
  if (!def.weaponDamage) return null;
  return levelValue(def.weaponDamage, level) + synergyPercent;
}

/**
 * B7: a skill's own `flatDamage` min/max curve at `level`, scaled by
 * `(100 + synergyPercent) / 100` (see the section header above for why this
 * is a MULTIPLY, not an add, unlike `weaponDamagePercentAt`). `out`
 * defaults to a fresh `{min, max}` for a standalone/test call — the same
 * "shared scratch, caller-owned when it matters" convention
 * `./cost.js#computeCost` already documents; `SkillsSystem#describe` passes
 * its own instance-owned scratch (`Alloc: no`).
 * @param {object} def `SkillDefinition`
 * @param {number} level
 * @param {number} synergyPercent `skills.synergyBonus(actor, def.id, 'flatDamage')`
 * @param {{min:number, max:number}} [out]
 * @returns {{min:number, max:number}} `{min:0, max:0}` if `def.flatDamage` is `null`
 */
export function flatDamageRangeAt(def, level, synergyPercent, out) {
  if (!out) out = { min: 0, max: 0 };
  if (!def.flatDamage) { out.min = 0; out.max = 0; return out; }
  const mult = (100 + synergyPercent) / 100;
  const fd = def.flatDamage;
  out.min = (fd.minBase + fd.minPerLevel * (level - 1)) * mult;
  out.max = (fd.maxBase + fd.maxPerLevel * (level - 1)) * mult;
  return out;
}

// Fixed, module-scope string literals for `SkillDescription.lines[i].labelKey`
// — NEVER a template string at call time (a per-hover template-string build
// is exactly the allocation this ticket's brief calls out: "a tooltip
// builder is exactly where they creep in"). `ui`'s own `i18n.js` (out of
// this ticket's file list — UI-9's job) maps these the same way it already
// maps every `stat.*` key.
const LABEL_COST = 'skill.cost';
const LABEL_COOLDOWN = 'skill.cooldown';
const LABEL_CAST_TIME = 'skill.castTime';
const LABEL_RADIUS = 'skill.radius';
const LABEL_DURATION = 'skill.duration';
const LABEL_WEAPON_DAMAGE = 'skill.weaponDamagePercent';
const LABEL_DAMAGE = 'skill.damage';

/**
 * Resets a `SkillDescription` to its all-zero shape, WITHOUT touching
 * `out.lines`' preallocated entries beyond clearing `lineCount` to 0 (a
 * stale `lines[i]` beyond the new `lineCount` is simply unread by any
 * correct caller — `lineCount` is the length, `lines` is the backing
 * array, same convention `01-data-model.md` uses everywhere a preallocated
 * array carries a separate count). Used for an unknown `skillId` — fail
 * closed, same convention `costOf`/`definition` already use.
 * @param {object} out a `SkillDescription`
 * @returns {object} `out`
 */
export function resetSkillDescription(out) {
  out.lineCount = 0;
  out.costResource = null; out.costAmount = 0;
  out.cooldown = 0; out.castTime = 0; out.radius = 0; out.range = 0; out.duration = 0;
  out.damageMin = 0; out.damageMax = 0;
  return out;
}

/**
 * `describe(actor, skillId, level, out)`'s real engine
 * (`02-api-contracts.md:886` / `09-ui.md:3139`) — `SkillsSystem#describe`
 * (`./index.js`) is a thin wrapper: look up `def`, fail closed via
 * `resetSkillDescription` if unknown, else call this. `Alloc: no`: writes
 * into `out`'s own fields and mutates `out.lines[i]`'s PREALLOCATED entries
 * in place (never a new object, never `push`); `scratch` is the caller's
 * own preallocated `{cost:{resource,amount}, damageRange:{min,max}}` bag
 * (`SkillsSystem` builds it once in `init()`), reused every call.
 *
 * `level` is caller-given, NOT re-derived from `actor.skillPoints` — this
 * is what lets `ui` preview level N and N+1 for a skill the actor has not
 * (yet) allocated a point into. `actor` is read only for
 * `manaCostReduction` (cost) and the INCOMING synergy amount — every OTHER
 * skill's ALLOCATED level on this actor (`05` §1.3) — never for this
 * skill's own level.
 *
 * The two open gaps this ticket's report documents (rule 6: "if the spec
 * does not give you a number, STOP AND SAY SO" — neither is fabricated
 * here):
 *   - `out.range` is always `0`. `./data/skills.js` has no single field
 *     that means "cast/attack range" the way `radius`/`duration` do —
 *     mobility skills alone spell it three different ways
 *     (`extra.travel.rangeM`, `extra.travel.range.base/perLevel`,
 *     `extra.travel.teleportRangeM`), and `02-api-contracts.md` §10
 *     separately contracts a dedicated `rangeOf(actor, skillId)` method
 *     (Casting table) that is NOT implemented anywhere yet and is not this
 *     ticket's to build.
 *   - A `weaponDamage` skill's `damageMin`/`damageMax` stay `0`. The
 *     coefficient (with its synergy folded in) is reported as a `lines`
 *     percent entry instead — turning it into an absolute damage number
 *     needs the actor's resolved weapon (`combat`'s `resolveWeapon`,
 *     `src/combat/packet.js`, a different subsystem `ARCHITECTURE.md` rule
 *     2 forbids importing directly), which is real damage-pipeline work,
 *     not a "number the spec didn't give."
 * @param {object} def `SkillDefinition`
 * @param {object} actor
 * @param {number} level
 * @param {(actor:object, skillId:string, statKey:string) => number} synergyBonusFn `SkillsSystem#synergyBonus`, bound by the caller
 * @param {{cost:{resource:string|null,amount:number}, damageRange:{min:number,max:number}}} scratch
 * @param {object} out a `SkillDescription`
 * @returns {object} `out`
 */
export function buildSkillDescription(def, actor, level, synergyBonusFn, scratch, out) {
  const lines = out.lines;
  const maxLines = lines.length;
  let lineCount = 0;

  computeCost(def, level, actor, scratch.cost);
  out.costResource = scratch.cost.resource;
  out.costAmount = scratch.cost.amount;
  if (scratch.cost.resource !== null && lineCount < maxLines) {
    const line = lines[lineCount++];
    line.labelKey = LABEL_COST; line.value = scratch.cost.amount; line.unit = scratch.cost.resource; line.format = 'number';
  }

  out.cooldown = cooldownOf(def, level);
  if (out.cooldown > 0 && lineCount < maxLines) {
    const line = lines[lineCount++];
    line.labelKey = LABEL_COOLDOWN; line.value = out.cooldown; line.unit = 's'; line.format = 'number';
  }

  out.castTime = def.castTime || 0;
  if (out.castTime > 0 && lineCount < maxLines) {
    const line = lines[lineCount++];
    line.labelKey = LABEL_CAST_TIME; line.value = out.castTime; line.unit = 's'; line.format = 'number';
  }

  out.radius = def.radius ? levelValue(def.radius, level) : 0;
  if (out.radius > 0 && lineCount < maxLines) {
    const line = lines[lineCount++];
    line.labelKey = LABEL_RADIUS; line.value = out.radius; line.unit = 'm'; line.format = 'number';
  }

  out.range = 0; // see this function's own doc comment, "open gaps"

  out.duration = def.duration ? levelValue(def.duration, level) : 0;
  if (out.duration > 0 && lineCount < maxLines) {
    const line = lines[lineCount++];
    line.labelKey = LABEL_DURATION; line.value = out.duration; line.unit = 's'; line.format = 'number';
  }

  out.damageMin = 0;
  out.damageMax = 0;
  if (def.weaponDamage) {
    const synergyPercent = synergyBonusFn(actor, def.id, 'weaponDamage');
    const pct = weaponDamagePercentAt(def, level, synergyPercent);
    if (lineCount < maxLines) {
      const line = lines[lineCount++];
      line.labelKey = LABEL_WEAPON_DAMAGE; line.value = pct; line.unit = '%'; line.format = 'percent';
    }
  } else if (def.flatDamage) {
    const synergyPercent = synergyBonusFn(actor, def.id, 'flatDamage');
    flatDamageRangeAt(def, level, synergyPercent, scratch.damageRange);
    out.damageMin = scratch.damageRange.min;
    out.damageMax = scratch.damageRange.max;
    if (lineCount < maxLines) {
      const line = lines[lineCount++];
      line.labelKey = LABEL_DAMAGE; line.value = out.damageMin; line.unit = null; line.format = 'range';
    }
  }

  out.lineCount = lineCount;
  return out;
}
