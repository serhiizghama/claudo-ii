// src/ai/spawn.js
//
// AI-7 — pack templates and the spawn pass. `06-monsters-ai.md` §13 row 7:
// "§5.1-5.6, §10.1-10.5: template resolution, `bestiaryWeights`,
// `ai.spawnPack`, activation tiers, despawn". Assertions this file is
// measured by (D-64, which corrected the backlog's own wrong set):
// **MB11**, **MB17**, **MB20**, **MB9** (`06` §12.2).
//
// Headless by construction — no `three`, no DOM, no browser global, no
// `performance.now()`, no `Math.random()`. `tools/check-imports.mjs` scans
// `src/ai/` with `checkThree: true, checkGlobals: true`. This is not
// incidental: `06` §16 A1's whole reason for `ai.packTemplate` existing is
// that `tools/mapgen.mjs` must report pack composition per zone "without
// instantiating `ai`" — every §5 function below is therefore a plain
// module-level export over frozen tables, reachable by a direct
// `import { packTemplate } from '../src/ai/spawn.js'` with no `ctx`, no
// engine and no subsystem alive at all. `AiSystem` forwards to them
// (`./index.js`) for the `02-api-contracts.md` §12 rows; it is never the
// only way in.
//
// ===========================================================================
// Where the template table lives — co-located, not in `data/`, and why
// ===========================================================================
// `06` §5.1 names `src/ai/data/pack-templates.js` as the templates' home and
// `ARCHITECTURE.md` rule 9 wants gameplay numbers under a `data/` folder.
// This ticket's file grant is `src/ai/spawn.js` alone — creating
// `src/ai/data/pack-templates.js` would be a file outside it. The tables are
// therefore transcribed VERBATIM from `06` §5.3/§5.4/§5.5 as frozen
// top-level consts in this file, which is the exact precedent
// `src/world/spawn.js` (WRLD-9, accepted) already set for the identical
// situation — see that file's own header, "Gameplay numbers this file must
// co-locate". They are pure data, import nothing, and a follow-up ticket
// that IS granted `src/ai/data/` lifts them across unchanged. Reported, not
// routed around.
//
// ===========================================================================
// §5.2 resolution draws NOTHING — and neither does anything else here
// ===========================================================================
// `06` §14.1: "Template resolution (§5.2), champion member selection (§5.7),
// minion inheritance and ring-slot assignment draw **nothing** — all four
// are deterministic functions of `count` and `actorId`." Nothing in this
// file touches `ctx.rng` or `AiSystem._rng`; the only per-pack draws `06`
// §14.1 does schedule (affix rolls, unique names) belong to AI-8 and are
// NOT taken here — see "What this ticket does not build" below.
//
// ===========================================================================
// What this ticket does NOT build — flagged, never stubbed with fake values
// ===========================================================================
//   - `ai.rollAffixes` / `ai.affixStats` / the rank stat multipliers
//     (`06` §6, §5.7's affix half). `06` §13 row 8 = AI-8. `spawnPack` below
//     passes `pack.affixes` through to `spawnOne` exactly as `world` left it
//     (`[]` today — `src/world/spawn.js` explicitly does not roll them,
//     see its own header) and never invents one.
//   - `ai.spawnBoss` (`06` §13 step 10, M6). §10.1's pseudocode ends with a
//     `kind: 'boss'` branch; `spawnPack`'s pass below skips boss spawn
//     points and counts them (`stats.bossPointsSkipped`) rather than
//     pretending none exist.
//   - `06` §10.4's per-item tier-B suppression list. Items 1, 2 and 4 of it
//     live inside `crowd.js`/`perception.js`/each `brains/*.js` — files this
//     ticket does not own. What IS implemented here is §10.3's own three-tier
//     state machine and the one effect this file can deliver from outside
//     those files: a tier-C (dormant) pack is not ticked at all. See
//     `packTierOf`'s own comment.
//   - Physics-body add/remove on activation (§10.3's "On activation: bodies
//     added via `physics.addBody`"). `src/actors/index.js` owns the body
//     lifecycle end to end — it adds a body in `spawn()` and removes it in
//     `despawn()`, and forwards no method to detach/reattach one without
//     despawning the actor. `ai` taking `physics.removeBody(actor.bodyId)`
//     into its own hands would leave `actors`' bookkeeping believing a body
//     is still there. Recorded as a real, unfinished cross-subsystem gap.

import { BESTIARY } from './data/bestiary.js';
import { registerPack, addPackMember } from './perception.js';

// ===========================================================================
// §5.3 / §5.4 / §5.5 — the pack templates, verbatim
// ===========================================================================
//
// `PackTemplate` shape is `06` §16 A1's, literally:
//   { id, fixed: [{archetypeId, n}], share: [{archetypeId, f, min}], sizeFloor }
//
// `06` §5.5's Altar rows print no "Pack size floor" column at all, so both
// Altar templates carry `sizeFloor: 0` — "the spec states none", not an
// invented number. A floor of 0 never raises a count.

/** @typedef {{id:string, fixed:ReadonlyArray<{archetypeId:string,n:number}>, share:ReadonlyArray<{archetypeId:string,f:number,min:number}>, sizeFloor:number}} PackTemplate */

function freezeTemplate(t) {
  return Object.freeze({
    id: t.id,
    fixed: Object.freeze((t.fixed || []).map((f) => Object.freeze({ archetypeId: f.archetypeId, n: f.n }))),
    share: Object.freeze((t.share || []).map((s) => Object.freeze({ archetypeId: s.archetypeId, f: s.f, min: s.min || 0 }))),
    sizeFloor: t.sizeFloor,
  });
}

/** Every template of `06` §5.3 (Ashen Wastes), §5.4 (Bonereach) and §5.5
 * (Altar approach), deeply frozen — the record, its `fixed`/`share` arrays
 * and every entry inside them. `packTemplate(id)` hands these out directly
 * (`02-api-contracts.md` §12: `Alloc: no`), which is only safe because
 * nothing a caller can do mutates one. */
export const PACK_TEMPLATES = Object.freeze({
  // --- §5.3 Ashen Wastes ---------------------------------------------------
  pk_ranker_line: freezeTemplate({
    id: 'pk_ranker_line', fixed: [],
    share: [{ archetypeId: 'bone_ranker', f: 1.00, min: 0 }], sizeFloor: 5,
  }),
  pk_ranker_archer: freezeTemplate({
    id: 'pk_ranker_archer', fixed: [],
    share: [{ archetypeId: 'bone_ranker', f: 0.60, min: 0 }, { archetypeId: 'ashen_archer', f: 0.40, min: 2 }],
    sizeFloor: 5,
  }),
  pk_swarm: freezeTemplate({
    id: 'pk_swarm', fixed: [],
    share: [{ archetypeId: 'carrion_swarm', f: 1.00, min: 0 }], sizeFloor: 6,
  }),
  pk_swarm_ranker: freezeTemplate({
    id: 'pk_swarm_ranker', fixed: [],
    share: [{ archetypeId: 'carrion_swarm', f: 0.65, min: 4 }, { archetypeId: 'bone_ranker', f: 0.35, min: 2 }],
    sizeFloor: 7,
  }),
  pk_archer_nest: freezeTemplate({
    id: 'pk_archer_nest', fixed: [],
    share: [{ archetypeId: 'ashen_archer', f: 0.55, min: 0 }, { archetypeId: 'bone_ranker', f: 0.45, min: 2 }],
    sizeFloor: 5,
  }),
  pk_shaman_court: freezeTemplate({
    id: 'pk_shaman_court', fixed: [{ archetypeId: 'dust_shaman', n: 1 }],
    share: [{ archetypeId: 'bone_ranker', f: 1.00, min: 0 }], sizeFloor: 6,
  }),
  pk_crawler_run: freezeTemplate({
    id: 'pk_crawler_run', fixed: [],
    share: [{ archetypeId: 'blight_crawler', f: 0.40, min: 2 }, { archetypeId: 'bone_ranker', f: 0.60, min: 0 }],
    sizeFloor: 5,
  }),
  pk_warband: freezeTemplate({
    id: 'pk_warband', fixed: [{ archetypeId: 'dust_shaman', n: 1 }],
    share: [
      { archetypeId: 'bone_ranker', f: 0.40, min: 0 },
      { archetypeId: 'ashen_archer', f: 0.30, min: 0 },
      { archetypeId: 'carrion_swarm', f: 0.30, min: 0 },
    ],
    sizeFloor: 8,
  }),

  // --- §5.4 Bonereach ------------------------------------------------------
  pk_bone_line: freezeTemplate({
    id: 'pk_bone_line', fixed: [],
    share: [{ archetypeId: 'bone_ranker', f: 1.00, min: 0 }], sizeFloor: 5,
  }),
  pk_bone_archer: freezeTemplate({
    id: 'pk_bone_archer', fixed: [],
    share: [{ archetypeId: 'bone_ranker', f: 0.55, min: 0 }, { archetypeId: 'ashen_archer', f: 0.45, min: 2 }],
    sizeFloor: 5,
  }),
  pk_maul_guard: freezeTemplate({
    id: 'pk_maul_guard', fixed: [{ archetypeId: 'maulsmith', n: 1 }],
    share: [{ archetypeId: 'bone_ranker', f: 1.00, min: 0 }], sizeFloor: 5,
  }),
  pk_swarm_flood: freezeTemplate({
    id: 'pk_swarm_flood', fixed: [],
    share: [{ archetypeId: 'carrion_swarm', f: 1.00, min: 0 }], sizeFloor: 6,
  }),
  pk_crawler_nest: freezeTemplate({
    id: 'pk_crawler_nest', fixed: [],
    share: [{ archetypeId: 'blight_crawler', f: 0.55, min: 3 }, { archetypeId: 'carrion_swarm', f: 0.45, min: 0 }],
    sizeFloor: 6,
  }),
  pk_shaman_vault: freezeTemplate({
    id: 'pk_shaman_vault', fixed: [{ archetypeId: 'dust_shaman', n: 2 }],
    share: [{ archetypeId: 'bone_ranker', f: 1.00, min: 0 }], sizeFloor: 6,
  }),
  pk_deep_warband: freezeTemplate({
    id: 'pk_deep_warband', fixed: [{ archetypeId: 'maulsmith', n: 1 }, { archetypeId: 'dust_shaman', n: 1 }],
    share: [{ archetypeId: 'ashen_archer', f: 0.40, min: 0 }, { archetypeId: 'bone_ranker', f: 0.60, min: 0 }],
    sizeFloor: 8,
  }),

  // --- §5.5 Altar of Instruction, the approach -----------------------------
  pk_altar_guard: freezeTemplate({
    id: 'pk_altar_guard', fixed: [],
    share: [{ archetypeId: 'bone_ranker', f: 0.55, min: 0 }, { archetypeId: 'ashen_archer', f: 0.45, min: 0 }],
    sizeFloor: 0,
  }),
  pk_altar_line: freezeTemplate({
    id: 'pk_altar_line', fixed: [],
    share: [{ archetypeId: 'bone_ranker', f: 1.00, min: 0 }], sizeFloor: 0,
  }),
});

/** `06` §5.1: "Template ids are prefixed `pk_` and can never collide with a
 * bestiary id." The prefix is the contract, not membership in the table —
 * an unknown `pk_` id is a data bug and must not be mistaken for a bestiary
 * archetype. */
export const PACK_TEMPLATE_PREFIX = 'pk_';

/** `02-api-contracts.md` §12 / `06` §16 A1: `packTemplate(id) => PackTemplate
 * | null`. Returns the FROZEN record for a `pk_`-prefixed id, `null` for a
 * bestiary id (or anything unknown). `Fixed: Y, Alloc: no`.
 * @param {string} id @returns {PackTemplate|null} */
export function packTemplate(id) {
  if (typeof id !== 'string') return null;
  return PACK_TEMPLATES[id] || null;
}

/** True for an id that names a template rather than a bestiary archetype.
 * @param {string} id @returns {boolean} */
export function isPackTemplateId(id) {
  return typeof id === 'string' && id.startsWith(PACK_TEMPLATE_PREFIX);
}

/** Every distinct `archetypeId` a template can put on the ground, in first-
 * appearance order (`fixed` then `share`). MB20 reads this.
 * @param {string} id @returns {string[]} */
export function templateArchetypeIds(id) {
  const t = packTemplate(id);
  if (!t) return BESTIARY[id] ? [id] : [];
  const out = [];
  for (const f of t.fixed) if (!out.includes(f.archetypeId)) out.push(f.archetypeId);
  for (const s of t.share) if (!out.includes(s.archetypeId)) out.push(s.archetypeId);
  return out;
}

/** `06` §5.3's "pack size floor" column. `0` for a bestiary id and for the
 * two Altar templates (§5.5 prints no floor column).
 * @param {string} id @returns {number} */
export function packSizeFloor(id) {
  const t = packTemplate(id);
  return t ? t.sizeFloor : 0;
}

/** `06` §5.3: "If a template's `packSize` floor exceeds the size the density
 * budget assigned, `ai` raises the pack's `count` to the floor and records a
 * `PACK_SIZE_RAISED` counter... a pack is never shrunk below the template's
 * floor." The raise is a property of the PACK, applied before resolution —
 * `resolveRoster` itself is always exact at whatever count it is handed
 * (which is what MB11 measures).
 * @param {string} id @param {number} count @returns {number} */
export function effectivePackCount(id, count) {
  const floor = packSizeFloor(id);
  return count < floor ? floor : count;
}

// ===========================================================================
// §5.2 — template resolution. Deterministic, total, no RNG.
// ===========================================================================

/**
 * `06` §5.2's procedure, literally. Produces exactly `count` entries for any
 * `count >= 0`.
 *
 * A bestiary id (or any id with no template) resolves to `count` identical
 * monsters — `06` §5.1: "a bestiary id spawns `count` identical monsters; a
 * template id expands to a mixed roster of exactly `count` monsters."
 *
 * Member minima are enforced last and can be INFEASIBLE by construction: at
 * `count = 5`, `pk_swarm_ranker`'s own minima (swarm >= 4, ranker >= 2) sum
 * to 6. The spec's transfer rule ("takes slots from the entry with the
 * largest surplus above ITS minimum") then has no surplus to take from and
 * the loop terminates with the total still exactly `count`. This is a real
 * conflict between §12.2's MB11 ("every count 5...12") and §5.3's own floors
 * (`pk_swarm_ranker` is floored at 7 and never resolves at 5 in the real
 * pass) — surfaced here, and measured both ways in `tests/ai/spawn.test.js`,
 * rather than silently clamped.
 *
 * `Alloc: yes` — once per pack at `zone:ready`, between frames, the same
 * cost class as `src/world/spawn.js`'s own plan. Never called per-frame.
 *
 * @param {string} id template id or bestiary archetype id
 * @param {number} count
 * @returns {string[]} roster of `archetypeId`s, length exactly `count`
 */
export function resolveRoster(id, count) {
  const n = Math.max(0, count | 0);
  const template = packTemplate(id);
  if (!template) {
    const flat = new Array(n);
    for (let i = 0; i < n; i++) flat[i] = id;
    return flat;
  }

  const roster = [];

  // "for each fixed member f in template.fixed, in array order: push
  //  f.archetypeId x f.n" ... "if remaining < 0: drop fixed members from the
  //  END of template.fixed until remaining >= 0".
  // Dropping is done by choosing how many LEADING fixed entries survive,
  // which is the same thing as dropping from the end and is the only reading
  // under which §5.4's own worked corridor case holds (`pk_maul_guard` at
  // count 1 must yield "the fixed Maulsmith alone").
  let keep = template.fixed.length;
  const fixedTotal = (k) => {
    let t = 0;
    for (let i = 0; i < k; i++) t += template.fixed[i].n;
    return t;
  };
  while (keep > 0 && n - fixedTotal(keep) < 0) keep--;
  for (let i = 0; i < keep; i++) {
    for (let k = 0; k < template.fixed[i].n; k++) roster.push(template.fixed[i].archetypeId);
  }

  const remaining = n - roster.length;
  const share = template.share;
  if (remaining <= 0 || share.length === 0) return roster;

  // Largest-remainder over `template.share`, in array order.
  const whole = new Array(share.length);
  const frac = new Array(share.length);
  let assigned = 0;
  for (let i = 0; i < share.length; i++) {
    const exact = share[i].f * remaining;
    whole[i] = Math.floor(exact);
    frac[i] = exact - whole[i];
    assigned += whole[i];
  }
  let left = remaining - assigned;
  // "award the `left` extra slots to the entries with the largest frac, ties
  // broken by ascending array index" — a plain repeated max scan; `left` is
  // at most `share.length` (3), so this is bounded and allocation-free.
  while (left > 0) {
    let best = -1;
    let bestFrac = -1;
    for (let i = 0; i < share.length; i++) {
      if (frac[i] > bestFrac) { bestFrac = frac[i]; best = i; }
    }
    whole[best] += 1;
    frac[best] = -1; // consumed; never wins twice while another entry is unawarded
    left--;
    if (left > 0 && frac.every((f) => f < 0)) {
      // more slots left than entries — restart the frac ranking from the
      // original fractions so the award order stays the documented one.
      for (let i = 0; i < share.length; i++) frac[i] = share[i].f * remaining - Math.floor(share[i].f * remaining);
    }
  }

  // "enforce template.min[i]: any entry below its minimum takes slots from
  // the entry with the largest surplus above ITS minimum, lowest index first"
  for (let i = 0; i < share.length; i++) {
    while (whole[i] < share[i].min) {
      let donor = -1;
      let bestSurplus = 0;
      for (let j = 0; j < share.length; j++) {
        if (j === i) continue;
        const surplus = whole[j] - share[j].min;
        if (surplus > bestSurplus) { bestSurplus = surplus; donor = j; }
      }
      if (donor === -1) break; // infeasible at this count — see this function's header
      whole[donor] -= 1;
      whole[i] += 1;
    }
  }

  for (let i = 0; i < share.length; i++) {
    for (let k = 0; k < whole[i]; k++) roster.push(share[i].archetypeId);
  }
  return roster;
}

// ===========================================================================
// §5.1 / §5.3 / §5.4 / §5.5 — `bestiaryWeights`
// ===========================================================================
//
// `06` §5.1: "`bestiaryWeights(cell)` returns the template weight rows of
// §5.3 and §5.4." Every row below sums to 100, verbatim from those tables
// (§5.5's Altar row is 65/35 and is included for completeness even though no
// Altar generator exists in this milestone).
//
// A row with weight 0 for a template is kept, not omitted — the zero IS the
// design statement ("`warcamp` is the only cell that ever fields a warband").

const W = (pairs) => Object.freeze(pairs.map(([id, w]) => Object.freeze({ templateId: id, weight: w })));

export const BESTIARY_WEIGHTS = Object.freeze({
  ashen_wastes: Object.freeze({
    ash_flats: W([['pk_ranker_line', 30], ['pk_ranker_archer', 22], ['pk_swarm', 18], ['pk_swarm_ranker', 12], ['pk_archer_nest', 8], ['pk_shaman_court', 4], ['pk_crawler_run', 6], ['pk_warband', 0]]),
    dead_grove: W([['pk_ranker_line', 12], ['pk_ranker_archer', 20], ['pk_swarm', 10], ['pk_swarm_ranker', 10], ['pk_archer_nest', 30], ['pk_shaman_court', 6], ['pk_crawler_run', 12], ['pk_warband', 0]]),
    ruin_field: W([['pk_ranker_line', 20], ['pk_ranker_archer', 26], ['pk_swarm', 6], ['pk_swarm_ranker', 8], ['pk_archer_nest', 24], ['pk_shaman_court', 8], ['pk_crawler_run', 8], ['pk_warband', 0]]),
    bone_yard: W([['pk_ranker_line', 18], ['pk_ranker_archer', 14], ['pk_swarm', 8], ['pk_swarm_ranker', 10], ['pk_archer_nest', 8], ['pk_shaman_court', 32], ['pk_crawler_run', 10], ['pk_warband', 0]]),
    ravine: W([['pk_ranker_line', 16], ['pk_ranker_archer', 10], ['pk_swarm', 26], ['pk_swarm_ranker', 20], ['pk_archer_nest', 6], ['pk_shaman_court', 6], ['pk_crawler_run', 16], ['pk_warband', 0]]),
    warcamp: W([['pk_ranker_line', 10], ['pk_ranker_archer', 16], ['pk_swarm', 6], ['pk_swarm_ranker', 8], ['pk_archer_nest', 12], ['pk_shaman_court', 10], ['pk_crawler_run', 8], ['pk_warband', 30]]),
  }),
  bonereach: Object.freeze({
    hall: W([['pk_bone_line', 26], ['pk_bone_archer', 24], ['pk_maul_guard', 16], ['pk_swarm_flood', 10], ['pk_crawler_nest', 8], ['pk_shaman_vault', 10], ['pk_deep_warband', 6]]),
    vault: W([['pk_bone_line', 8], ['pk_bone_archer', 14], ['pk_maul_guard', 22], ['pk_swarm_flood', 4], ['pk_crawler_nest', 8], ['pk_shaman_vault', 24], ['pk_deep_warband', 20]]),
    flooded: W([['pk_bone_line', 14], ['pk_bone_archer', 10], ['pk_maul_guard', 8], ['pk_swarm_flood', 30], ['pk_crawler_nest', 26], ['pk_shaman_vault', 6], ['pk_deep_warband', 6]]),
    stair: W([['pk_bone_line', 22], ['pk_bone_archer', 26], ['pk_maul_guard', 18], ['pk_swarm_flood', 6], ['pk_crawler_nest', 8], ['pk_shaman_vault', 10], ['pk_deep_warband', 10]]),
    // §5.4's "corridor (wanderers)" row. Resolved at `count = 1`.
    corridor: W([['pk_bone_line', 55], ['pk_bone_archer', 0], ['pk_maul_guard', 10], ['pk_swarm_flood', 20], ['pk_crawler_nest', 15], ['pk_shaman_vault', 0], ['pk_deep_warband', 0]]),
    // §5.4: "`entry` rooms are entirely `spawnDeny` ... and receive no packs
    // at all." An empty row, so a caller that asks anyway gets nothing to
    // draw from rather than a silently wrong default.
    entry: W([]),
  }),
  altar_of_instruction: Object.freeze({
    approach: W([['pk_altar_guard', 65], ['pk_altar_line', 35]]),
  }),
});

/**
 * `06` §5.1's `bestiaryWeights(cell)`. `cellKey` is the Wastes macro-cell
 * archetype (`ash_flats`...`warcamp`), the Bonereach room role
 * (`hall`/`vault`/`flooded`/`stair`/`corridor`/`entry`), or
 * `approach` for the Altar.
 * @param {string} zoneId @param {string} cellKey
 * @returns {ReadonlyArray<{templateId:string, weight:number}>} frozen, `[]` when unknown
 */
export function bestiaryWeights(zoneId, cellKey) {
  const zone = BESTIARY_WEIGHTS[zoneId];
  if (!zone) return EMPTY_WEIGHTS;
  return zone[cellKey] || EMPTY_WEIGHTS;
}

const EMPTY_WEIGHTS = Object.freeze([]);

// ===========================================================================
// §5.7 — champion / unique promotion (deterministic, no RNG)
// ===========================================================================

/** `06` §5.7: `clamp(round(count x 0.35), 2, 5)`.
 * @param {number} count @returns {number} */
export function championCount(count) {
  const raw = Math.round(count * 0.35);
  return raw < 2 ? 2 : raw > 5 ? 5 : raw;
}

/**
 * `06` §5.7's promotion table, as a per-member rank array in roster order.
 * §10.1 assigns roster index `k` to the pack's `k`-th `SpawnPoint` in
 * ascending `SpawnPoint.id`, so "the members with the lowest `SpawnPoint.id`"
 * are exactly the leading indices — no sort, no draw.
 *
 * Only the COUNTS are this ticket's (§5.7's own table). The stat multipliers
 * a `champion`/`unique`/`minion` rank implies, and the affixes they share,
 * are AI-8's (`06` §13 row 8) — `spawnOne` receives the rank string and
 * whatever `pack.affixes` `world` left behind, nothing invented here.
 *
 * @param {number} count @param {string} rank pack rank: normal|champion|unique
 * @returns {string[]} length `count`
 */
export function promotionRanks(count, rank) {
  const n = Math.max(0, count | 0);
  const out = new Array(n);
  if (rank === 'unique') {
    for (let i = 0; i < n; i++) out[i] = i === 0 ? 'unique' : 'minion';
    return out;
  }
  if (rank === 'champion') {
    const champs = Math.min(championCount(n), n);
    for (let i = 0; i < n; i++) out[i] = i < champs ? 'champion' : 'normal';
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = 'normal';
  return out;
}

// ===========================================================================
// §10.2 — the entrance safety radius, re-asserted by `ai`
// ===========================================================================

/** `06` §10.2's own table. `last_bastion` has no numeric row ("the whole
 * zone" is `spawnDeny`) and therefore no entry here. */
export const SPAWN_SAFETY = Object.freeze({
  ashen_wastes: Object.freeze({ packCentreMin: 16.0, spawnPointMin: 11.0 }),
  bonereach: Object.freeze({ packCentreMin: 14.0, spawnPointMin: 10.0 }),
  altar_of_instruction: Object.freeze({ packCentreMin: 12.0, spawnPointMin: 9.0 }),
});

/**
 * A 4-connected BFS distance field in metres, seeded at `(entryX, entryZ)`,
 * over the LIVE nav grid — `ai`'s own, not `world`'s.
 *
 * §10.2 is explicit that this is a re-assertion, not a read of someone
 * else's number: "`ai` **re-asserts** the `SpawnPoint` minimum at spawn time
 * rather than trusting it... a non-zero count means `world` and `ai`
 * disagree about the distance field and that is a bug in one of them,
 * surfaced rather than absorbed." An independent field is therefore the
 * point, not duplication to be factored away.
 *
 * Walkability is read through `nav.walkable(x, z)` — the PUBLIC
 * `02-api-contracts.md` §6 method — never `nav.grid.flags` and never
 * `NAV_FLAG` (which lives in `src/world/raster.js`, another subsystem's
 * module, and rule 2 forbids importing it). Only the grid's geometry
 * (`width`/`height`/`cellSize`/`originX`/`originZ`) is read off `nav.grid`,
 * the same live-record read `src/world/spawn.js` already makes.
 *
 * `Alloc: yes` — once per `zone:ready`, never per frame.
 *
 * @param {object} nav @param {number} entryX @param {number} entryZ
 * @returns {{dist:Float32Array, width:number, height:number, cellSize:number, originX:number, originZ:number}|null}
 */
export function buildEntryDistanceField(nav, entryX, entryZ) {
  const grid = nav && nav.grid;
  if (!grid || !grid.width || !grid.height) return null;
  const { width, height, cellSize, originX, originZ } = grid;
  const n = width * height;
  const dist = new Float32Array(n).fill(Infinity);
  const walk = new Uint8Array(n);
  for (let cz = 0; cz < height; cz++) {
    for (let cx = 0; cx < width; cx++) {
      const x = originX + (cx + 0.5) * cellSize;
      const z = originZ + (cz + 0.5) * cellSize;
      walk[cz * width + cx] = nav.walkable(x, z) ? 1 : 0;
    }
  }

  const scx = Math.floor((entryX - originX) / cellSize);
  const scz = Math.floor((entryZ - originZ) / cellSize);
  const field = { dist, width, height, cellSize, originX, originZ };
  if (scx < 0 || scz < 0 || scx >= width || scz >= height) return field;
  const start = scz * width + scx;
  if (!walk[start]) return field;

  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  dist[start] = 0;
  queue[tail++] = start;
  while (head < tail) {
    const idx = queue[head++];
    const cx = idx % width;
    const cz = (idx - cx) / width;
    const d = dist[idx] + cellSize;
    if (cx > 0) { const k = idx - 1; if (walk[k] && dist[k] === Infinity) { dist[k] = d; queue[tail++] = k; } }
    if (cx < width - 1) { const k = idx + 1; if (walk[k] && dist[k] === Infinity) { dist[k] = d; queue[tail++] = k; } }
    if (cz > 0) { const k = idx - width; if (walk[k] && dist[k] === Infinity) { dist[k] = d; queue[tail++] = k; } }
    if (cz < height - 1) { const k = idx + width; if (walk[k] && dist[k] === Infinity) { dist[k] = d; queue[tail++] = k; } }
  }
  return field;
}

/** Path distance from the entry at a world point, `Infinity` off-grid or
 * unreachable.
 * @param {object} field @param {number} x @param {number} z @returns {number} */
export function entryDistanceAt(field, x, z) {
  if (!field) return Infinity;
  const cx = Math.floor((x - field.originX) / field.cellSize);
  const cz = Math.floor((z - field.originZ) / field.cellSize);
  if (cx < 0 || cz < 0 || cx >= field.width || cz >= field.height) return Infinity;
  return field.dist[cz * field.width + cx];
}

/**
 * §10.2's correction: "a point below the minimum is pushed outward along the
 * gradient of the entry distance field to the nearest cell that satisfies
 * it". Implemented as a BFS outward from the point's own cell over cells the
 * field actually reached, which visits candidates in non-decreasing hop
 * order and so returns *the nearest* satisfying cell — the literal
 * requirement. Returns `null` (no correction possible / not needed).
 *
 * @param {object} field @param {number} x @param {number} z @param {number} minDist
 * @returns {{x:number,z:number}|null} the corrected point, or `null` if the point already complies or nothing complies
 */
export function pushOutward(field, x, z, minDist) {
  if (!field) return null;
  const here = entryDistanceAt(field, x, z);
  if (here >= minDist) return null;
  const { width, height, cellSize, originX, originZ, dist } = field;
  const cx = Math.floor((x - originX) / cellSize);
  const cz = Math.floor((z - originZ) / cellSize);
  if (cx < 0 || cz < 0 || cx >= width || cz >= height) return null;

  const n = width * height;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const start = cz * width + cx;
  seen[start] = 1;
  queue[tail++] = start;
  while (head < tail) {
    const idx = queue[head++];
    if (dist[idx] >= minDist && dist[idx] !== Infinity) {
      const gx = idx % width;
      const gz = (idx - gx) / width;
      return { x: originX + (gx + 0.5) * cellSize, z: originZ + (gz + 0.5) * cellSize };
    }
    const gx = idx % width;
    const gz = (idx - gx) / width;
    if (gx > 0) { const k = idx - 1; if (!seen[k] && dist[k] !== Infinity) { seen[k] = 1; queue[tail++] = k; } }
    if (gx < width - 1) { const k = idx + 1; if (!seen[k] && dist[k] !== Infinity) { seen[k] = 1; queue[tail++] = k; } }
    if (gz > 0) { const k = idx - width; if (!seen[k] && dist[k] !== Infinity) { seen[k] = 1; queue[tail++] = k; } }
    if (gz < height - 1) { const k = idx + width; if (!seen[k] && dist[k] !== Infinity) { seen[k] = 1; queue[tail++] = k; } }
  }
  return null;
}

// ===========================================================================
// §10.3 — activation tiers
// ===========================================================================

/** `06` §10.3's own three tiers. `C` dormant, `B` reduced, `A` full. */
export const PACK_TIER = Object.freeze({ C: 0, B: 1, A: 2 });

/** `06` §10.3, verbatim. */
export const ACTIVATION_RADIUS = 34.0;
export const DEACTIVATION_RADIUS = 42.0;
export const DEACTIVATION_QUIET_SECONDS = 10.0;
/** `06` §10.3: tier A is "inside the camera trapezoid + 6 m". `ai` has no
 * camera (`07` §1.4's visible ground reaches 11.68 m ahead of the player) and
 * `ARCHITECTURE.md`'s determinism contract forbids simulation depending on
 * the camera at all (`06` §10.4 restates it: "Suppressing simulation off
 * screen would make `tools/balance.mjs` results depend on the camera"). The
 * A/B split is therefore taken against a fixed radius from the PLAYER —
 * 11.68 + 6.0, §10.3's own two numbers — which is camera-independent,
 * deterministic and headless. Disclosed, not silently reinterpreted. */
export const FULL_TIER_RADIUS = 11.68 + 6.0;

/** Per-pack bookkeeping for the spawn pass and the activation state machine.
 * One object per zone load, replaced wholesale — never mutated per frame
 * beyond the scalar fields the state machine writes.
 * @param {number} capacity max concurrent packs
 * @returns {object} */
export function createSpawnStore(capacity = 64) {
  return {
    capacity,
    count: 0,
    packId: new Int32Array(capacity),
    centerX: new Float32Array(capacity),
    centerZ: new Float32Array(capacity),
    tier: new Uint8Array(capacity),
    memberStart: new Int32Array(capacity),
    memberCount: new Int32Array(capacity),
    lastDamageStep: new Int32Array(capacity).fill(-1 << 30),
    /** dense actor-id list, `memberStart[p] .. +memberCount[p]` */
    memberIds: new Int32Array(capacity * 32),
    memberCursor: 0,
    /** poolIndex -> pack slot, or -1. Sized like the brain arrays. */
    slotOfActor: new Int32Array(512).fill(-1),
    densityBudget: 0, // 0 = uncapped; `setDensityBudget` writes it
    stats: {
      packsSpawned: 0,
      monstersSpawned: 0,
      spawnRefused: 0,
      packSizeRaised: 0,
      spawnPushed: 0,
      escaped: 0,
      wanderersSpawned: 0,
      bossPointsSkipped: 0,
      npcPointsSkipped: 0,
    },
  };
}

/** Resets the store between zone loads without reallocating it. */
export function resetSpawnStore(store) {
  store.count = 0;
  store.memberCursor = 0;
  store.slotOfActor.fill(-1);
  store.tier.fill(PACK_TIER.C);
  const s = store.stats;
  s.packsSpawned = 0; s.monstersSpawned = 0; s.spawnRefused = 0; s.packSizeRaised = 0;
  s.spawnPushed = 0; s.escaped = 0; s.wanderersSpawned = 0; s.bossPointsSkipped = 0; s.npcPointsSkipped = 0;
}

// ===========================================================================
// §10.1 — the spawn pass
// ===========================================================================

/**
 * `ai.spawnPack(pack)` — `02-api-contracts.md` §12, `(pack:PackDescriptor)
 * => int spawned`.
 *
 * `06` §10.1's inner loop, exactly: resolve the roster, promote it, then walk
 * `world.spawnPoints` filtered to this pack in ascending `SpawnPoint.id` and
 * call `ai.spawnOne(roster[k], pt.x, pt.z, pack.mlvl, rank[k], affixes)` —
 * note that argument order. `world` writes nothing back; `ai` fills
 * `members[]`, `spawned` and `aliveCount` on the descriptor
 * (`01-data-model.md` §9.5 sanctions exactly those three).
 *
 * @param {object} env `{ ctx, ai, actors, nav, store, perception, brains, field, safety }`
 * @param {object} pack a `PackDescriptor`
 * @param {object[]} spawnPoints `world.spawnPoints`
 * @returns {number} monsters actually spawned
 */
export function spawnPackDescriptor(env, pack, spawnPoints) {
  const { ai, actors, store, perception, field, safety } = env;
  if (!pack || pack.archetypeId == null) return 0;

  // §5.3's floor. `PackDescriptor.count` is never reduced (`07` §8.3); it may
  // be RAISED to the template's floor, and the raise is counted.
  const rawCount = pack.count | 0;
  const count = effectivePackCount(pack.archetypeId, rawCount);
  if (count > rawCount) store.stats.packSizeRaised++;

  const roster = resolveRoster(pack.archetypeId, count);
  const ranks = promotionRanks(count, pack.rank);
  const affixes = pack.affixes || [];

  // Points for this pack, ascending `SpawnPoint.id` — `world` already emits
  // them in id order, but §10.1's tie-breaks (and therefore every downstream
  // deterministic order) depend on it, so it is asserted here by sorting a
  // small local list rather than assumed.
  const points = [];
  for (let i = 0; i < spawnPoints.length; i++) {
    if (spawnPoints[i].packIndex === pack.id && spawnPoints[i].kind === 'pack') points.push(spawnPoints[i]);
  }
  points.sort((a, b) => a.id - b.id);
  if (points.length === 0) return 0;

  const slot = store.count;
  if (slot >= store.capacity) return 0;

  registerPack(perception, pack.id, pack.centerX, pack.centerZ, pack.aggroCloud);

  store.packId[slot] = pack.id;
  store.centerX[slot] = pack.centerX;
  store.centerZ[slot] = pack.centerZ;
  store.tier[slot] = PACK_TIER.C;
  store.memberStart[slot] = store.memberCursor;
  store.memberCount[slot] = 0;
  store.lastDamageStep[slot] = -1 << 30;
  store.count = slot + 1;

  let spawned = 0;
  const limit = Math.min(points.length, roster.length);
  for (let k = 0; k < limit; k++) {
    const pt = points[k];
    let px = pt.x;
    let pz = pt.z;

    // §10.2 — re-assert the SpawnPoint minimum. Never trusted, always
    // recomputed; a correction is `SPAWN_PUSHED` and MB17 wants it at 0.
    if (field && safety) {
      const pushed = pushOutward(field, px, pz, safety.spawnPointMin);
      if (pushed) { px = pushed.x; pz = pushed.z; store.stats.spawnPushed++; }
    }

    const actor = ai.spawnOne(roster[k], px, pz, pack.mlvl, ranks[k], affixes);
    if (!actor) { store.stats.spawnRefused++; continue; }

    addPackMember(perception, pack.id, actor);
    if (store.memberCursor < store.memberIds.length) {
      store.memberIds[store.memberCursor++] = actor.id;
      store.memberCount[slot]++;
    }
    if (actor.poolIndex < store.slotOfActor.length) store.slotOfActor[actor.poolIndex] = slot;
    // `actors.ref(actor)` with NO `out` returns `pool.js`'s SHARED scratch —
    // pushing that into `pack.members` stores the same object `count` times
    // and every entry reads as the last member spawned. `01-data-model.md`
    // §9.5's `members[]` is stored state, so it must own its refs: pass a
    // fresh `out` per member, exactly as `actors.ref`'s own doc comment
    // instructs ("Pass your own `out` for anything you intend to store").
    // Caught by a real-pipeline probe, not by reading — see the report.
    if (Array.isArray(pack.members)) pack.members.push(actors.ref(actor, { id: 0, generation: 0 }));
    spawned++;
  }

  pack.spawned = spawned > 0;
  pack.aliveCount = spawned;
  store.stats.packsSpawned++;
  store.stats.monstersSpawned += spawned;
  return spawned;
}

/**
 * `06` §10.1's whole pass, run on `zone:ready`.
 *
 * The `kind: 'wanderer'` branch resolves at `count = 1` (§5.4's corridor
 * row). `world` ships none today — `src/world/spawn.js`'s own header
 * discloses that wanderers are unimplemented — so that branch is live code
 * that currently never fires, and `stats.wanderersSpawned` reads 0 rather
 * than the branch being omitted.
 *
 * @param {object} env
 * @returns {object} `store.stats`
 */
export function runSpawnPass(env) {
  const { store, world } = env;
  resetSpawnStore(store);
  if (!world) return store.stats;

  const packs = world.packs || [];
  const spawnPoints = world.spawnPoints || [];

  // Ascending `PackDescriptor.id` — §10.1's outer loop order, which fixes
  // `Actor.id` order and therefore every deterministic tie-break downstream.
  const ordered = packs.slice().sort((a, b) => a.id - b.id);
  for (let i = 0; i < ordered.length; i++) spawnPackDescriptor(env, ordered[i], spawnPoints);

  for (let i = 0; i < spawnPoints.length; i++) {
    const pt = spawnPoints[i];
    if (pt.kind === 'wanderer') {
      const id = pt.archetypeId || pt.templateId;
      if (!id) continue;
      const roster = resolveRoster(id, 1);
      const actor = env.ai.spawnOne(roster[0], pt.x, pt.z, pt.mlvl || (world.current ? world.current.monsterLevel : 1), 'normal', []);
      if (actor) store.stats.wanderersSpawned++;
    } else if (pt.kind === 'boss') {
      store.stats.bossPointsSkipped++; // `ai.spawnBoss` is `06` §13 step 10 — see this file's header
    } else if (pt.kind === 'npc') {
      store.stats.npcPointsSkipped++; // TEAM.neutral NPC spawning is `world`/`player` territory, not built
    }
  }

  // No event is emitted per pack here, deliberately: `06` §10.3 lists
  // `actor:spawn` under "On activation", not at instantiation, so emitting
  // it now would fire it for a pack the player may never reach.
  return store.stats;
}

// ===========================================================================
// §10.3 — the activation state machine
// ===========================================================================

/** `06` §10.3's activation/deactivation rule for one pack.
 * @param {object} store @param {number} slot @param {number} px player x @param {number} pz player z @param {number} step
 * @returns {number} the pack's new tier */
export function updatePackTier(store, slot, px, pz, step) {
  const dx = store.centerX[slot] - px;
  const dz = store.centerZ[slot] - pz;
  const d = Math.sqrt(dx * dx + dz * dz);
  const tier = store.tier[slot];

  if (tier === PACK_TIER.C) {
    if (d <= ACTIVATION_RADIUS) store.tier[slot] = d <= FULL_TIER_RADIUS ? PACK_TIER.A : PACK_TIER.B;
    return store.tier[slot];
  }

  // Deactivation needs BOTH the 42 m hysteresis AND 10 s without damage.
  const quietSteps = Math.round(DEACTIVATION_QUIET_SECONDS * 60);
  if (d > DEACTIVATION_RADIUS && step - store.lastDamageStep[slot] >= quietSteps) {
    store.tier[slot] = PACK_TIER.C;
    return PACK_TIER.C;
  }
  store.tier[slot] = d <= FULL_TIER_RADIUS ? PACK_TIER.A : PACK_TIER.B;
  return store.tier[slot];
}

/**
 * One `fixedUpdate`'s worth of §10.3. Reads no `dt` and no wall clock —
 * schedules against `ctx.time.step` only.
 *
 * `ai.setDensityBudget(maxActive)` is honoured here: "above it, the pack
 * whose centre is furthest from the player is forced back to tier C
 * regardless of hysteresis."
 *
 * @param {object} store @param {object} actors @param {number} step
 * @returns {number} active monsters (tier A + B)
 */
export function stepActivation(store, actors, step) {
  const player = actors.player;
  if (!player) return 0;
  const px = player.x;
  const pz = player.z;

  let active = 0;
  for (let s = 0; s < store.count; s++) {
    if (updatePackTier(store, s, px, pz, step) !== PACK_TIER.C) active += store.memberCount[s];
  }

  const budget = store.densityBudget;
  if (budget > 0) {
    while (active > budget) {
      let worst = -1;
      let worstD = -1;
      for (let s = 0; s < store.count; s++) {
        if (store.tier[s] === PACK_TIER.C) continue;
        const dx = store.centerX[s] - px;
        const dz = store.centerZ[s] - pz;
        const d = dx * dx + dz * dz;
        if (d > worstD) { worstD = d; worst = s; }
      }
      if (worst === -1) break;
      store.tier[worst] = PACK_TIER.C;
      active -= store.memberCount[worst];
    }
  }
  return active;
}

/** The tier an actor's own pack is in, or `PACK_TIER.A` for an actor that
 * belongs to no pack this store spawned.
 *
 * Returning `A` (not `C`) for a non-member is what keeps this ticket's
 * wiring additive: every hand-spawned monster in the existing suites
 * (`tests/ai/melee.test.js`, `brains.test.js`, ... — none of which go through
 * `runSpawnPass`) is a non-member and therefore keeps being ticked exactly
 * as it was before this ticket. Only packs THIS file spawned can ever be
 * gated.
 * @param {object} store @param {number} poolIndex @returns {number} */
export function packTierOf(store, poolIndex) {
  if (poolIndex < 0 || poolIndex >= store.slotOfActor.length) return PACK_TIER.A;
  const slot = store.slotOfActor[poolIndex];
  if (slot < 0) return PACK_TIER.A;
  return store.tier[slot];
}

/** `actor:damage` -> the damaged actor's pack has just been "damaged in the
 * last 10 s" for §10.3's deactivation clause. */
export function notePackDamage(store, poolIndex, step) {
  if (poolIndex < 0 || poolIndex >= store.slotOfActor.length) return;
  const slot = store.slotOfActor[poolIndex];
  if (slot >= 0) store.lastDamageStep[slot] = step;
}

// ===========================================================================
// §10.5 — despawn
// ===========================================================================

/**
 * `02-api-contracts.md` §12: `despawnAll(keepQuestCritical:boolean) => void`.
 * `06` §10.5 row 1: fired by `world.enterZone`.
 *
 * `questCritical` is `01-data-model.md`'s `ACTOR_FLAG`; §10.5 names exactly
 * one bearer (Molgrim, unbuilt this milestone), so the flag read below is
 * defensive today and correct the day AI-9 lands him.
 * @param {object} store @param {object} actors @param {boolean} keepQuestCritical
 * @returns {number} actors despawned
 */
/**
 * Releases the pack registry `spawnPackDescriptor` filled — this file's own
 * lifecycle cleanup for state this file created.
 *
 * ===========================================================================
 * A REAL DEFECT this exists to contain, reported for `perception.js`'s owner
 * ===========================================================================
 * `perception.js#registerPack` resets `packMemberCount[slot]` ONLY when it
 * allocates a NEW slot; re-registering an id that is already mapped updates
 * the centre and the aggro cloud and leaves the previous member list in
 * place. Pack ids restart at 0 in every zone, so the second `zone:ready`
 * appends its members to the first zone's stale, despawned ids. Measured on
 * five consecutive real `world.enterZone('ashen_wastes')` calls, reading
 * `ai._perception.packMemberCount` back after each:
 *
 *     load 1: 6 6 6 6 6 6 5 5 5
 *     load 2: 14 14 14 13 13 13 12 12 12
 *     load 3: 16 16 16 16 16 16 16 16 16   <- MAX_PACK_MEMBERS, saturated
 *     load 4: 16 ... (unchanged)
 *     load 5: 16 ... (unchanged)
 *
 * From the third zone onward every slot is full of dead actor ids,
 * `addPackMember` returns `false` for every real member, and §4.6's aggro
 * propagation and `alertPack` stop seeing the live pack entirely.
 *
 * AI-7 is the first PRODUCTION caller of `registerPack` (before this ticket
 * only tests called it), which is why the leak had never manifested. The
 * proper fix is one line inside `registerPack` — and `src/ai/perception.js`
 * is AI-3's file, outside this ticket's grant, so it is REPORTED, not
 * edited. What is done here instead is strictly this file's own business:
 * the pass that registered these packs releases them when its zone ends.
 * @param {object} perception
 */
export function releasePackRegistry(perception) {
  if (!perception) return;
  perception.packUsed.fill(0);
  perception.packIdOfSlot.fill(-1);
  perception.packMemberCount.fill(0);
  perception.packSlot.fill(-1);
  perception.packIdToSlot.clear();
}

export function despawnAllPacks(store, actors, keepQuestCritical, perception) {
  let n = 0;
  const live = actors.all;
  // Iterate a snapshot: `actors.despawn(a, true)` compacts `actors.all`.
  const doomed = [];
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    if (a.kind !== 'monster') continue;
    if (keepQuestCritical && a.questCritical) continue;
    doomed.push(a);
  }
  for (let i = 0; i < doomed.length; i++) {
    actors.despawn(doomed[i], true);
    n++;
  }
  resetSpawnStore(store);
  releasePackRegistry(perception);
  return n;
}

/**
 * `06` §10.5 row "Escaped the bounds": any actor more than 2.0 m outside
 * `ZoneInstance.bounds` is despawned immediately and counted as `ESCAPED`.
 * "It should never happen, and if it does, `physics` has a bug" — so this
 * counts loudly rather than absorbing.
 * @param {object} store @param {object} actors @param {object} bounds `{minX,minZ,maxX,maxZ}`
 * @returns {number} newly escaped this call */
export function despawnEscaped(store, actors, bounds) {
  if (!bounds) return 0;
  const m = 2.0;
  const live = actors.all;
  let n = 0;
  for (let i = live.length - 1; i >= 0; i--) {
    const a = live[i];
    if (a.kind !== 'monster' || a.dead) continue;
    if (a.x < bounds.minX - m || a.x > bounds.maxX + m || a.z < bounds.minZ - m || a.z > bounds.maxZ + m) {
      if (a.poolIndex < store.slotOfActor.length) store.slotOfActor[a.poolIndex] = -1;
      actors.despawn(a, true);
      store.stats.escaped++;
      n++;
    }
  }
  return n;
}

// ===========================================================================
// Headless composition report — what `tools/mapgen.mjs` reads (§16 A1)
// ===========================================================================

/**
 * Pack composition for a list of `PackDescriptor`s, with no `ctx`, no engine
 * and no `ai` instance. This is the function `06` §16 A1 exists for: "so
 * `tools/mapgen.mjs` can report composition per zone without instantiating
 * `ai`".
 *
 * @param {object[]} packs `world.packs` (or any array of PackDescriptor-shaped records)
 * @returns {{total:number, byArchetype:Record<string,number>, byTemplate:Record<string,number>, packSizeRaised:number, packs:Array<{id:number, sourceId:string, count:number, roster:string[], ranks:string[]}>}}
 */
export function describeComposition(packs) {
  // Plain objects, not `Object.create(null)`: this report is consumed by
  // `tools/mapgen.mjs` and by tests, both of which compare/serialise it.
  const byArchetype = {};
  const byTemplate = {};
  const rows = [];
  let total = 0;
  let packSizeRaised = 0;
  for (const p of packs || []) {
    if (!p || p.archetypeId == null) continue;
    const count = effectivePackCount(p.archetypeId, p.count | 0);
    if (count > (p.count | 0)) packSizeRaised++;
    const roster = resolveRoster(p.archetypeId, count);
    const ranks = promotionRanks(count, p.rank);
    for (const a of roster) byArchetype[a] = (byArchetype[a] || 0) + 1;
    byTemplate[p.archetypeId] = (byTemplate[p.archetypeId] || 0) + 1;
    total += roster.length;
    rows.push({ id: p.id, sourceId: p.archetypeId, count, roster, ranks });
  }
  return { total, byArchetype, byTemplate, packSizeRaised, packs: rows };
}
