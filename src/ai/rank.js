// src/ai/rank.js
//
// AI-8 — champions, uniques and the nine affixes. `06-monsters-ai.md` §13
// row 8: "§5.7, §5.8, §6 in full: promotion, minion inheritance, group draws,
// exclusions, the redraw, `immunityValue`, name generation, telegraph hooks".
//
// Assertion set is **D-64's**, not the backlog's: **MB3, MB4, MB7, MB8,
// MB10** (`06` §12.2). The backlog's contiguous `MB01`-`MB10` wrongly sweeps
// in MB5/MB5b (Molgrim, M6) and MB6 (class spread, M7).
//
// Headless by construction — no `three`, no DOM, no browser global, no
// `performance.now()`, no `Math.random()`. Every gameplay number lives in
// `./data/affixes.js` (`ARCHITECTURE.md` rule 9); this file is the logic over
// that table and nothing else. Like `./spawn.js`, every export is a plain
// module-level function reachable by a direct import with no `ctx`, no engine
// and no subsystem alive, so `tools/balance.mjs` can run MB10's draw sweep
// without instantiating `ai`. `AiSystem` forwards to them (`./index.js`) for
// the `02-api-contracts.md` §12 rows; it is never the only way in.
//
// ===========================================================================
// §5.7 promotion is NOT re-implemented here
// ===========================================================================
// `championCount` and `promotionRanks` — §5.7's `clamp(round(count × 0.35),
// 2, 5)` and the per-member rank array — already shipped in `./spawn.js`
// (AI-7, accepted) and are exercised by `tests/ai/spawn.test.js`. A second
// copy here would be two tables to drift. This file's tests re-measure them
// against §5.7's own printed count table rather than restating them.
//
// ===========================================================================
// Two `02-api-contracts.md` §12 signatures that cannot express `06` §6
// ===========================================================================
// Both are real, reported, and worked around additively rather than by
// changing the contracted parameter positions:
//
//   1. `rollAffixes(rank, mlvl, rng, out) => int` carries no archetype, but
//      `06` §6.3's eligibility is stated PER ARCHETYPE and MB10 asserts
//      "never an ineligible affix for the archetype". A fifth, optional
//      parameter `archetypeIds` is accepted here. Omitted, every affix is
//      eligible — which is exactly `bone_ranker`'s own row ("all 3 / all 3 /
//      all 3"), so the four-argument contracted call is not a lie, just the
//      unrestricted case.
//   2. `affixStats(affixId, mlvl, out?) => object` carries no tier, but
//      `06` §6.4's `immunityValue` is tier-gated (85 at Instruction, 100 at
//      Trial and Renunciation) and that value IS the affix's whole stat
//      contribution for the three `immunity`-group affixes. A fourth,
//      optional `tier` parameter is accepted, defaulting to `'instruction'`.
//
// `mlvl` is accepted in both, for the contracted shape, and used by neither:
// `06` §6.1's weights carry no mlvl term and §11.2 states outright that
// "Affix **counts** do not change per tier". It is not silently dropped —
// see `rollAffixes`'s own parameter comment.
//
// ===========================================================================
// The draw stream, and where §07 disagrees with §06
// ===========================================================================
// `06` §14.1 schedules the draws "At `zone:ready`, per pack, in ascending
// `PackDescriptor.id`" and states they come from the ONE `ctx.rng.fork()`
// `ai` takes in `init()`. `07-world-gen.md` §8.3 step 5's pseudocode instead
// writes `ai.rollAffixes(p.rank, p.mlvl, S3, p.affixes)` — `world`'s own S3
// stream. `06` governs this row (D-64), so `./index.js` passes `ai`'s stream.
// `src/world/spawn.js`'s own header already disclosed the resulting S3
// position divergence and asked the `ai` ticket to state which way it went;
// this is that statement. Every function below takes the stream as a
// parameter and forks nothing, so the choice is the caller's and is made in
// exactly one place.
//
// Draw counts, per §14.1, asserted by `tests/ai/rank.test.js` against a
// counting Rng rather than by reading this comment:
//   champion  2  (group by weight, then affix within the group)
//   unique    3  (one per group, `immunity -> power -> utility`)
//             +1 per excluded pair encountered — the §6.5 redraw
//   name      2  (epithet index, then title index), uniques only

import {
  MONSTER_AFFIXES,
  AFFIX_IDS,
  AFFIX_GROUPS,
  AFFIX_GROUP_WEIGHTS,
  AFFIX_INELIGIBLE,
  AFFIX_EXCLUSIONS,
  AFFIX_COUNT_BY_RANK,
  DANGER_BUDGET,
  IMMUNITY_VALUE_BY_TIER,
  UNIQUE_EPITHETS,
  UNIQUE_TITLES,
  RANK_TELEGRAPH,
  AFFIX_TELEGRAPH,
} from './data/affixes.js';

/** The default difficulty tier. No tier system exists anywhere in `src/`
 * (finding O-97: the only shipped tier data is
 * `src/world/spawn.js#DIFFICULTY_MLVL_OFFSET`, and `AI-11` — `06` §13 step 11
 * — is M6), so every caller that does not name a tier gets Instruction, which
 * is the only tier the game can currently be played at. */
export const DEFAULT_TIER = 'instruction';

/** `06` §6.4. 85 at Instruction, 100 at Trial and Renunciation.
 * @param {string} [tier] @returns {number} */
export function immunityValue(tier) {
  const v = IMMUNITY_VALUE_BY_TIER[tier || DEFAULT_TIER];
  return v === undefined ? IMMUNITY_VALUE_BY_TIER[DEFAULT_TIER] : v;
}

/** `03` §9.3 / `06` §6.5 — 1 for a champion, 3 for a unique, 3 inherited by
 * a minion (`06` §5.7: "Every minion inherits **all three**"), 0 otherwise.
 * @param {string} rank @returns {number} */
export function affixCountForRank(rank) {
  const n = AFFIX_COUNT_BY_RANK[rank];
  return n === undefined ? 0 : n;
}

/** True when this rank carries affixes at all — the guard `06` §5.7 implies
 * and `src/ai/spawn.js#spawnPackDescriptor` does not apply (it hands the
 * pack's whole `affixes` array to every member including the un-promoted
 * `normal` ones; see this ticket's report). `./index.js#spawnOne` uses this.
 * @param {string} rank @returns {boolean} */
export function rankCarriesAffixes(rank) {
  return affixCountForRank(rank) > 0;
}

// ===========================================================================
// §6.3 — eligibility
// ===========================================================================

/** `06` §6.3. An unknown archetype excludes nothing — the caller is asking
 * about the unrestricted case (see this file's header, point 1).
 * @param {string} affixId @param {string} [archetypeId] @returns {boolean} */
export function isEligible(affixId, archetypeId) {
  if (!archetypeId) return MONSTER_AFFIXES[affixId] !== undefined;
  const banned = AFFIX_INELIGIBLE[archetypeId];
  if (!banned) return MONSTER_AFFIXES[affixId] !== undefined;
  for (let i = 0; i < banned.length; i++) if (banned[i] === affixId) return false;
  return MONSTER_AFFIXES[affixId] !== undefined;
}

/** `06` §6.5's three hard exclusion pairs, order-independent. The third is
 * archetype-scoped and only fires on that archetype.
 * @param {string} a @param {string} b @param {string} [archetypeId]
 * @returns {boolean} */
export function isExcludedPair(a, b, archetypeId) {
  for (let i = 0; i < AFFIX_EXCLUSIONS.length; i++) {
    const x = AFFIX_EXCLUSIONS[i];
    if (x.archetypeId !== null && x.archetypeId !== archetypeId) continue;
    if ((x.a === a && x.b === b) || (x.a === b && x.b === a)) return true;
  }
  return false;
}

/** `06` §6.5's danger points, summed. Champion budget 3, unique budget 7.
 * @param {ReadonlyArray<string>} affixIds @returns {number} */
export function dangerPoints(affixIds) {
  let n = 0;
  for (let i = 0; i < affixIds.length; i++) {
    const a = MONSTER_AFFIXES[affixIds[i]];
    if (a) n += a.danger;
  }
  return n;
}

/** `06` §6.5's stated budgets, for a rank.
 * @param {string} rank @returns {number} */
export function dangerBudget(rank) {
  const b = DANGER_BUDGET[rank === 'minion' ? 'unique' : rank];
  return b === undefined ? 0 : b;
}

// ---------------------------------------------------------------------------
// Preallocated draw scratch — `ARCHITECTURE.md` rule 6.
// ---------------------------------------------------------------------------
// Nine is the whole affix table, so one group's candidate list can never
// exceed it; three is `AFFIX_GROUPS.length`. Built once at module load, never
// per call. Every function that uses these fills its own length counter
// first, so no state leaks between calls.

// The two candidate arrays are handed straight to `Rng.weighted(candidates,
// weights)`, which reads `weights.length` and `candidates.length` — so their
// LENGTH is the candidate count. `arr.length = n` truncates in place and
// allocates nothing; slicing would allocate two arrays per draw, and MB10's
// own sweep is 100 000 draws.
const CAND_IDS = [];
const CAND_WEIGHTS = [];
const GROUP_IDS = [];
const GROUP_WEIGHTS = [];
const HELD = new Array(AFFIX_GROUPS.length);

/**
 * Fills `CAND_IDS`/`CAND_WEIGHTS` with the eligible members of `group`.
 *
 * `archetypeIds` may be a single id, an array of ids, or null/undefined:
 *
 *   - null/undefined — no restriction (this file's header, point 1).
 *   - one id — `06` §6.3's own row for that archetype.
 *   - several ids — the INTERSECTION of their rows. This is the case `06`
 *     leaves open and it is a real conflict, not a convenience: §5.7 says
 *     "All promoted members share the pack's **one** rolled affix", while
 *     §6.3's eligibility is per archetype, and `06` §5.3's own templates mix
 *     archetypes inside one pack (`pk_warband` is a Shaman, Rankers, Archers
 *     and Swarmers). Intersecting is the only reading under which MB10's
 *     "never an ineligible affix for the archetype" holds for every member
 *     that actually carries the affix. Where the intersection is EMPTY —
 *     provably reachable, e.g. `pk_crawler_nest`'s Crawlers (`utility` =
 *     {hexing}) beside its Swarmers (`utility` = {vampiric}) — the caller's
 *     FIRST id wins, which is the pack leader's archetype, matching
 *     `01-data-model.md` §9.5's own description of `PackDescriptor.rank` as
 *     "ACTOR_RANK of the pack **leader**". The fallback is counted, never
 *     silent: see `rollStats`.
 *
 * @returns {number} candidate count
 */
function fillGroupCandidates(group, archetypeIds) {
  let n = 0;
  const single = typeof archetypeIds === 'string' ? archetypeIds : null;
  const list = Array.isArray(archetypeIds) ? archetypeIds : null;
  for (let i = 0; i < AFFIX_IDS.length; i++) {
    const id = AFFIX_IDS[i];
    const a = MONSTER_AFFIXES[id];
    if (a.group !== group) continue;
    let ok = true;
    if (list) {
      for (let k = 0; k < list.length && ok; k++) ok = isEligible(id, list[k]);
    } else if (single) {
      ok = isEligible(id, single);
    }
    if (!ok) continue;
    CAND_IDS[n] = id;
    CAND_WEIGHTS[n] = a.weight;
    n++;
  }
  CAND_IDS.length = n;
  CAND_WEIGHTS.length = n;
  return n;
}

/** Drops one id from the filled candidate scratch, in place — §6.5's
 * "removed from that group's candidate list ... redrawn once with
 * renormalised weights". `Rng.weighted` renormalises by construction (it
 * sums the weights it is handed), so removal IS the renormalisation.
 * @returns {number} the new candidate count */
function removeCandidate(n, affixId) {
  let w = 0;
  for (let i = 0; i < n; i++) {
    if (CAND_IDS[i] === affixId) continue;
    CAND_IDS[w] = CAND_IDS[i];
    CAND_WEIGHTS[w] = CAND_WEIGHTS[i];
    w++;
  }
  CAND_IDS.length = w;
  CAND_WEIGHTS.length = w;
  return w;
}

/** Counters this module keeps so the two documented compromises above are
 * measurable rather than asserted in prose. Reset by `resetRollStats()`.
 *   `redraws`          — §6.5 redraws taken (an excluded pair was drawn)
 *   `emptyIntersection`— pack-level group draws that fell back to the leader
 *   `championRolls` / `uniqueRolls` / `nameRolls` — call counts */
export const rollStats = {
  championRolls: 0, uniqueRolls: 0, nameRolls: 0, redraws: 0, emptyIntersection: 0,
};

/** @returns {void} */
export function resetRollStats() {
  rollStats.championRolls = 0;
  rollStats.uniqueRolls = 0;
  rollStats.nameRolls = 0;
  rollStats.redraws = 0;
  rollStats.emptyIntersection = 0;
}

/** Fills the candidate scratch for `group`, falling back to the first
 * archetype alone when a multi-archetype intersection comes out empty.
 * @returns {number} candidate count, always >= 1 for a real group */
function fillGroupCandidatesWithFallback(group, archetypeIds, countIt) {
  let n = fillGroupCandidates(group, archetypeIds);
  if (n === 0 && Array.isArray(archetypeIds) && archetypeIds.length > 0) {
    if (countIt !== false) rollStats.emptyIntersection++;
    n = fillGroupCandidates(group, archetypeIds[0]);
  }
  return n;
}

// ===========================================================================
// §6.1 / §6.5 — the draws
// ===========================================================================

/**
 * `06` §6.5's champion draw: **2** draws — "a **group** by group weight
 * (34 / 41 / 25) and then an affix within it by the affix's own weight".
 *
 * On the unrestricted table the two-stage scheme is provably the same
 * distribution as §6.1's flat 100-weight one (`tools/balance.mjs`'s own
 * `MB10.tables` measures the deviation at 2.8e-17), which is why §6.5 says
 * "the two schemes are the same distribution". That equivalence is a
 * property of the FULL table: once §6.3 removes an affix, the two readings
 * diverge — a `blight_crawler`'s `utility` group is `{hexing}` alone, so
 * two-stage gives `hexing` the whole 25 % group weight while a flat
 * renormalisation would give it 9/72 = 12.5 %. §6.5's wording is the
 * procedure, so the procedure is what is implemented; the divergence is
 * measured and printed by `tests/ai/rank.test.js` rather than left implicit.
 *
 * @param {object} rng an `Rng`
 * @param {string|string[]|null} archetypeIds see `fillGroupCandidates`
 * @param {string[]} out written in place
 * @returns {number} 1
 */
export function rollChampionAffix(rng, archetypeIds, out) {
  let gn = 0;
  for (let i = 0; i < AFFIX_GROUPS.length; i++) {
    const g = AFFIX_GROUPS[i];
    // A group with no candidate at all cannot be drawn — §6.3 guarantees
    // this never happens for a single archetype ("Every group is non-empty
    // for every eligible archetype, so a draw can never fail"); it is only
    // reachable for a multi-archetype intersection, and the fallback below
    // resolves that case. Checked, not assumed.
    // `countIt: false` — this is the eligibility SCAN, not the draw. Counting
    // a fallback here would report it three times per roll instead of once.
    if (fillGroupCandidatesWithFallback(g, archetypeIds, false) === 0) continue;
    GROUP_IDS[gn] = g;
    GROUP_WEIGHTS[gn] = AFFIX_GROUP_WEIGHTS[g];
    gn++;
  }
  GROUP_IDS.length = gn;
  GROUP_WEIGHTS.length = gn;
  if (gn === 0) { out.length = 0; return 0; }

  const group = rng.weighted(GROUP_IDS, GROUP_WEIGHTS);  // draw 1
  fillGroupCandidatesWithFallback(group, archetypeIds);
  const affix = rng.weighted(CAND_IDS, CAND_WEIGHTS);    // draw 2

  out.length = 0;
  out.push(affix);
  rollStats.championRolls++;
  return 1;
}

/**
 * `06` §6.5's unique draw: one affix per group, in the fixed order
 * `immunity -> power -> utility`, **3** draws plus **1 per excluded pair
 * encountered**.
 *
 * That single ordering rule delivers most of §6.5's danger budget for free —
 * never two immunities, never two `power` affixes, always exactly three — and
 * caps the maximum at `3 + 2 + 2 = 7`, exactly at budget, with
 * `swift + mighty` structurally impossible (same group).
 *
 * The redraw is **once per group**, per §6.5: the offending affix is removed
 * from that group's candidate list and the group is redrawn with renormalised
 * weights. §6.3's tables guarantee every group still has a candidate after
 * any single removal, so the redraw always succeeds and a unique always ends
 * with three affixes — asserted over all six archetypes by
 * `tests/ai/rank.test.js`, not taken on trust.
 *
 * @param {object} rng an `Rng`
 * @param {string|string[]|null} archetypeIds
 * @param {string[]} out written in place
 * @returns {number} affixes written (3 in every legal case)
 */
export function rollUniqueAffixes(rng, archetypeIds, out) {
  out.length = 0;
  let held = 0;
  const scopeArchetype = typeof archetypeIds === 'string'
    ? archetypeIds
    : (Array.isArray(archetypeIds) && archetypeIds.length > 0 ? archetypeIds[0] : null);

  for (let gi = 0; gi < AFFIX_GROUPS.length; gi++) {
    const group = AFFIX_GROUPS[gi];
    let n = fillGroupCandidatesWithFallback(group, archetypeIds);
    if (n === 0) continue;
    let pick = rng.weighted(CAND_IDS, CAND_WEIGHTS);

    // §6.5's redraw. `isExcludedPair`'s archetype scope is the pack leader's
    // (the third pair is `mighty + multishot` **on `ashen_archer`**); for a
    // mixed pack that is the same id the fallback above uses, so one rule
    // decides both and they cannot disagree.
    let conflict = false;
    for (let h = 0; h < held; h++) if (isExcludedPair(HELD[h], pick, scopeArchetype)) conflict = true;
    if (conflict) {
      rollStats.redraws++;
      n = removeCandidate(n, pick);
      if (n > 0) pick = rng.weighted(CAND_IDS, CAND_WEIGHTS); // the one redraw
    }

    HELD[held++] = pick;
    out.push(pick);
  }
  rollStats.uniqueRolls++;
  return out.length;
}

/**
 * `02-api-contracts.md` §12: `rollAffixes(rank, mlvl, rng, out) => int`.
 *
 * `06` §14.1's two rows in one entry point — row 1 for a champion (2 draws),
 * row 1' for a unique (3 draws + redraws). A `minion` draws NOTHING: §5.7
 * says it "inherits **all three** of the unique's", so the caller hands it
 * the unique's already-rolled array; asking this function for a minion's
 * affixes would spend draws the spec does not schedule, so it returns 0 and
 * leaves `out` empty rather than inventing a second unique.
 *
 * @param {string} rank `normal|minion|champion|unique|boss`
 * @param {number} mlvl accepted for the contracted shape and unused — `06`
 *   §6.1's weights carry no mlvl term and §11.2 states "Affix **counts** do
 *   not change per tier". Not silently dropped: this is the statement.
 * @param {object} rng an `Rng` — the stream is the caller's choice (see this
 *   file's header on `06` §14.1 vs `07` §8.3 step 5)
 * @param {string[]} out written in place
 * @param {string|string[]|null} [archetypeIds] `06` §6.3's eligibility scope;
 *   omitted means unrestricted (see this file's header, point 1)
 * @returns {number} affixes written
 */
export function rollAffixes(rank, mlvl, rng, out, archetypeIds) {
  if (!out) return 0;
  if (rank === 'champion') return rollChampionAffix(rng, archetypeIds || null, out);
  if (rank === 'unique') return rollUniqueAffixes(rng, archetypeIds || null, out);
  out.length = 0;
  return 0;
}

/**
 * `06` §5.8 — "generated from two frozen tables with **two draws** from the
 * `ai` stream, taken immediately after its affixes (§14)":
 * `name = EPITHET[S.int(0,15)] + ', ' + TITLE[S.int(0,11)]`, 192
 * combinations.
 *
 * @param {object} rng an `Rng`
 * @param {{epithet:string,title:string,titleRu:string,name:string}} [out]
 *   reused in place when given (`Alloc: no` for the per-pack path)
 * @returns {{epithet:string,title:string,titleRu:string,name:string}}
 */
export function rollUniqueName(rng, out) {
  const e = rng.int(0, UNIQUE_EPITHETS.length - 1); // draw 1
  const t = rng.int(0, UNIQUE_TITLES.length - 1);   // draw 2
  const epithet = UNIQUE_EPITHETS[e];
  const title = UNIQUE_TITLES[t];
  const dst = out || { epithet: '', title: '', titleRu: '', name: '' };
  dst.epithet = epithet;
  dst.title = title.en;
  dst.titleRu = title.ru;
  dst.name = epithet + ', ' + title.en;
  rollStats.nameRolls++;
  return dst;
}

// ===========================================================================
// §6.1 / §6.2 / §6.4 — the stat contribution
// ===========================================================================

/** Every key any affix can write, so `out` can be cleared without a
 * `delete` (which would deoptimise the shape) and without leaving a stale
 * field behind from a previous call. Derived from the table, not restated —
 * a tenth affix adding a tenth field needs no edit here. */
const AFFIX_STAT_KEYS = Object.freeze((() => {
  const seen = new Set();
  for (let i = 0; i < AFFIX_IDS.length; i++) {
    const a = MONSTER_AFFIXES[AFFIX_IDS[i]];
    for (const k of Object.keys(a.stats)) seen.add(k);
    if (a.immunityResist) seen.add(a.immunityResist);
  }
  return Array.from(seen).sort();
})());

/** @returns {ReadonlyArray<string>} every StatBlock field the nine affixes
 * can touch, sorted — exported so a test can assert the set rather than
 * trusting this file's own prose. */
export function affixStatKeys() {
  return AFFIX_STAT_KEYS;
}

function zeroStatKeys(out) {
  for (let i = 0; i < AFFIX_STAT_KEYS.length; i++) out[AFFIX_STAT_KEYS[i]] = 0;
  return out;
}

/**
 * `02-api-contracts.md` §12: `affixStats(affixId, mlvl, out?) => object`.
 *
 * The one affix stat that is not a constant is an `immunity`-group affix's
 * resist, which `06` §6.4 gates by tier — `fireResist = immunityValue(tier)`,
 * and likewise `lightResist` for `charged` and `coldResist` for `frostbound`.
 * It is a flat SET, and a monster's composed resists are 0 before it (`03`
 * §9.3's own "Phys resist +"/"Elem resists +" rank columns are NOT applied by
 * `src/actors/stats.js` — a real gap outside this ticket's grant, measured
 * and reported), so writing the value into an additive layer lands it
 * exactly. At Instruction that is 85, clamped by `01` §3.4's 75 % resist cap
 * to an effective 75 — which is the number `06` §6.6's own 3.20× champion
 * cell is computed from.
 *
 * `03` §10.2's per-tier monster resist bonus (+0 / +20 / +40) is deliberately
 * NOT added: no difficulty-tier system exists in `src/` (O-97), and adding it
 * from `ai` would double-count the day `AI-11` (M6) lands. It is present in
 * `./data/affixes.js` as `TIER_MONSTER_RESIST_BONUS` so the arithmetic of
 * §6.4's table can be stated where it is needed, and `tests/ai/rank.test.js`
 * states it explicitly rather than hiding it.
 *
 * @param {string} affixId
 * @param {number} mlvl accepted for the contracted shape and unused — see
 *   `rollAffixes`'s own note; no affix effect in `06` §6.1/§6.2 carries an
 *   mlvl term (`burning`'s death burst is a fraction of `maxLife`, which is
 *   already mlvl-scaled by `actors`, and is a packet, not a stat)
 * @param {object} [out] reused in place when given (`Alloc: no`)
 * @param {string} [tier] `06` §6.4's gate; defaults to Instruction
 * @returns {object} a partial StatBlock layer
 */
export function affixStats(affixId, mlvl, out, tier) {
  const dst = zeroStatKeys(out || {});
  const a = MONSTER_AFFIXES[affixId];
  if (!a) return dst;
  const keys = Object.keys(a.stats);
  for (let i = 0; i < keys.length; i++) dst[keys[i]] += a.stats[keys[i]];
  if (a.immunityResist) dst[a.immunityResist] = immunityValue(tier);
  return dst;
}

/**
 * The merged layer for a whole affix list — what `./index.js` hands to
 * `actors.setSourceLayer`. Summed field by field, except `lifeSteal`, which
 * `06` §6.2 states is "a flat SET, not an add"; only one affix writes it
 * (`vampiric`) and one monster can never hold two of the same affix, so the
 * distinction is inert today and is implemented anyway so it cannot become
 * wrong silently.
 *
 * @param {ReadonlyArray<string>} affixIds
 * @param {number} mlvl
 * @param {object} [out] reused in place when given
 * @param {string} [tier]
 * @returns {object}
 */
export function affixLayer(affixIds, mlvl, out, tier) {
  const dst = zeroStatKeys(out || {});
  if (!affixIds) return dst;
  for (let i = 0; i < affixIds.length; i++) {
    const a = MONSTER_AFFIXES[affixIds[i]];
    if (!a) continue;
    const keys = Object.keys(a.stats);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      if (key === 'lifeSteal') dst[key] = Math.max(dst[key], a.stats[key]);
      else dst[key] += a.stats[key];
    }
    if (a.immunityResist) dst[a.immunityResist] = immunityValue(tier);
  }
  return dst;
}

// ===========================================================================
// §6.7 — telegraph hooks
// ===========================================================================

/** `06` §6.7's rank row (aura colour, intensity, radius multiplier, name
 * plate, the two sounds), or `null` for a rank that has none. `fx`/`audio`/
 * `ui` own the light and the sound; this is the hook, not the effect.
 * @param {string} rank @returns {object|null} */
export function rankTelegraph(rank) {
  return RANK_TELEGRAPH[rank] || null;
}

/** `06` §6.7's per-affix row.
 * @param {string} affixId @returns {object|null} */
export function affixTelegraph(affixId) {
  return AFFIX_TELEGRAPH[affixId] || null;
}

/** The one affix whose ground ring `06` §6.7 requires to be drawn
 * permanently rather than on a pulse ("a telegraph that blinks is a telegraph
 * that gets crossed"). Exported as a query so `fx` never has to special-case
 * `frostbound` by name.
 * @param {string} affixId @returns {boolean} */
export function telegraphIsAlwaysDrawn(affixId) {
  const t = AFFIX_TELEGRAPH[affixId];
  return !!t && t.alwaysDrawn === 1;
}

// ===========================================================================
// Per-actor affix record — `ai`'s own, because `Actor` has no field for it
// ===========================================================================
// `01-data-model.md` §2's Actor record carries `rank` but no `affixes`, and
// `src/actors/pool.js#acquire` accepts `SpawnSpec.affixes` (it is in
// `SPAWN_SPEC_DEFAULTS`) and then never writes it anywhere — a real gap
// outside this ticket's grant, reported. So `ai` keeps its own, in the same
// preallocated parallel-array shape `_brains`/`_perception`/`_navStore`/
// `_crowdStore`/`_spawnStore` already use (`ARCHITECTURE.md` rule 6: no
// `Map`, no per-frame allocation), indexed by `actor.poolIndex`.

/** Three slots per actor — `06` §6.5's hard maximum (a unique's one per
 * group), which is also what a minion inherits. */
export const MAX_AFFIXES_PER_ACTOR = 3;

/**
 * @param {number} capacity actors
 * @returns {{capacity:number, count:Uint8Array, slot:Int8Array, names:Array<string|null>}}
 */
export function createAffixStore(capacity) {
  return {
    capacity,
    count: new Uint8Array(capacity),
    // Index into `AFFIX_IDS`; -1 for an empty slot. `Int8Array` is enough
    // for nine affixes and will stay enough — `06` §13's own "What is
    // explicitly not in the order" forbids a tenth before M7.
    slot: new Int8Array(capacity * MAX_AFFIXES_PER_ACTOR).fill(-1),
    names: new Array(capacity).fill(null),
  };
}

/** @param {object} store @returns {void} */
export function resetAffixStore(store) {
  store.count.fill(0);
  store.slot.fill(-1);
  store.names.fill(null);
}

/** @param {object} store @param {number} poolIndex @returns {void} */
export function clearActorAffixes(store, poolIndex) {
  if (poolIndex < 0 || poolIndex >= store.capacity) return;
  store.count[poolIndex] = 0;
  const base = poolIndex * MAX_AFFIXES_PER_ACTOR;
  for (let i = 0; i < MAX_AFFIXES_PER_ACTOR; i++) store.slot[base + i] = -1;
  store.names[poolIndex] = null;
}

/**
 * @param {object} store @param {number} poolIndex
 * @param {ReadonlyArray<string>} affixIds
 * @returns {number} how many were recorded (silently capped at 3)
 */
export function setActorAffixes(store, poolIndex, affixIds) {
  if (poolIndex < 0 || poolIndex >= store.capacity) return 0;
  clearActorAffixes(store, poolIndex);
  if (!affixIds) return 0;
  const base = poolIndex * MAX_AFFIXES_PER_ACTOR;
  let n = 0;
  for (let i = 0; i < affixIds.length && n < MAX_AFFIXES_PER_ACTOR; i++) {
    const at = AFFIX_IDS.indexOf(affixIds[i]);
    if (at < 0) continue;
    store.slot[base + n] = at;
    n++;
  }
  store.count[poolIndex] = n;
  return n;
}

/**
 * Reads an actor's affixes back into `out` (reused; `Alloc: no`).
 * @param {object} store @param {number} poolIndex @param {string[]} out
 * @returns {number} count
 */
export function actorAffixes(store, poolIndex, out) {
  out.length = 0;
  if (poolIndex < 0 || poolIndex >= store.capacity) return 0;
  const n = store.count[poolIndex];
  const base = poolIndex * MAX_AFFIXES_PER_ACTOR;
  for (let i = 0; i < n; i++) {
    const at = store.slot[base + i];
    if (at >= 0) out.push(AFFIX_IDS[at]);
  }
  return out.length;
}

/** True when this actor carries `affixId`. Allocation-free.
 * @param {object} store @param {number} poolIndex @param {string} affixId
 * @returns {boolean} */
export function actorHasAffix(store, poolIndex, affixId) {
  if (poolIndex < 0 || poolIndex >= store.capacity) return false;
  const at = AFFIX_IDS.indexOf(affixId);
  if (at < 0) return false;
  const base = poolIndex * MAX_AFFIXES_PER_ACTOR;
  const n = store.count[poolIndex];
  for (let i = 0; i < n; i++) if (store.slot[base + i] === at) return true;
  return false;
}
