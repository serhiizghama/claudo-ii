#!/usr/bin/env node
// tools/lootsim.mjs
//
// TEST-7 — the M3 balance validation harness, `04-items.md` §10 (this
// file's owning document, per `12-testing.md`'s own harness-ownership
// table). Imports `src/items/*` directly in Node — no browser, no `three`,
// no DOM — and rolls every one of `04` §10.1's six profiles at 200 000
// drops each, asserting every id of `04` §10.2's table.
//
// ---------------------------------------------------------------------------
// Ruling D-20 — six profiles, not the stale 12§5.3 grid; MF 400 dropped
// ---------------------------------------------------------------------------
// `12-testing.md` §5.3's "three difficulties x three ranks x four MF values"
// is stale: it contradicts itself two paragraphs later ("the same 200 000
// drops", "the ledger at clvl 5/15/28" — profile language, not grid
// language), and `04` §10 is this tool's own owning document per `12`'s
// harness-ownership table. MF 400 is unreachable in this game (the whole
// catalogue's maximum magicFind is 172%, `04` §4.2) and is never
// constructed anywhere in this file. Budget kept at 20s (`04:2092`), not
// `12`'s stale 15s (`12:281`) — see the ticket brief for the arithmetic
// (20s was calibrated against 1.2M drops, not the grid's 7.2M).
//
// ---------------------------------------------------------------------------
// Ruling D-35 — the `boss` PROFILE is rank 'boss' against an ORDINARY tc
// ---------------------------------------------------------------------------
// Not `tc_boss` (Molgrim's scripted one-off, §5.5, needs quest-flag state
// this tool has no access to and `rollDrop` correctly refuses by treasure-
// class id). `PICKS_REF.boss = 4`, `NODROP_SCALE_REF.boss = 0`, read off
// §5.5's own table ("No nodrop, no weights", four `item` entries at the
// full boss-rank ladder) — already implemented in `src/items/drop.js`.
//
// ---------------------------------------------------------------------------
// Ruling O-77 — TWO module states must be reset between batches
// ---------------------------------------------------------------------------
// `resetUidCounter()` (`src/items/drop.js`) — affects only the `uid` field,
// not the draw stream; reset anyway so raw output comparison also works.
// `resetRareRing()` (`src/items/names.js`) — affects the DRAW STREAM itself
// (a non-empty ring redraws differently), so this one is load-bearing for
// determinism. Both are called as an explicit, commented precondition at
// the start of every profile run — see `runProfile()` below.
//
// ---------------------------------------------------------------------------
// Ruling D-25 — N1/N2 are rewritten for the superseded naming system
// ---------------------------------------------------------------------------
// N1 here checks the STRUCTURAL invariant (one head index + one tail
// index, composed per the tail's own `def` flag) — never an English token
// count. N2 checks the 64-window ring invariant as a hard fail, PLUS a
// statistical ceiling (35-40%) on P(>=1 repeat in 100 draws) from a fresh
// ring — never the superseded 69.4%/75% figures.
//
// ---------------------------------------------------------------------------
// Zero-allocation discipline (rule 5/6 of this ticket's brief)
// ---------------------------------------------------------------------------
// The 1.2M-drop main loop accumulates into preallocated typed arrays and
// plain integer counters — never an array of result objects, never a `Map`
// keyed by a per-drop value. Template strings are built only when printing
// the final report, never inside the per-drop loop. See `Stats` below.

import { createHash } from 'node:crypto';

import { ITEM_BASES, ITEM_BASES_BY_ID } from '../src/items/data/bases.js';
import { AFFIXES, AFFIXES_BY_ID } from '../src/items/data/affixes.js';
import { UNIQUES, UNIQUES_BY_ID } from '../src/items/data/uniques.js';
import { TREASURE_CLASSES_BY_ID, resolveTC } from '../src/items/data/treasure.js';
import { RARE_HEAD, RARE_TAIL } from '../src/items/data/names.js';
import { Rng } from '../src/core/rng.js';
import { rollItem, BASE_GROUPS, GROUP_BASES } from '../src/items/roll.js';
import { rollQuality } from '../src/items/quality.js';
import { rollDrop, rollGold, resetUidCounter } from '../src/items/drop.js';
import { resetRareRing, rollRareName } from '../src/items/names.js';

// ============================================================================
// CLI
// ============================================================================

function printHelp() {
  process.stdout.write(
    'Usage: node tools/lootsim.mjs --drops=200000 --seed=0x4c00751 [--profile=<name>] [--json]\n' +
      '\n' +
      '  --drops=N       drop rolls per profile (default 200000)\n' +
      '  --seed=0xHEX    RNG seed (default 0x4c00751)\n' +
      '  --profile=NAME  one of early,mid,late,champ,boss,sweep (default: all six)\n' +
      '  --json          emit machine-readable JSON instead of the human report\n' +
      '  --help          this message\n',
  );
}

function parseArgs(argv) {
  const out = { drops: 200000, seed: 0x4c00751, profile: null, json: false, help: false };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') { out.help = true; continue; }
    if (raw === '--json') { out.json = true; continue; }
    const m = /^--([a-zA-Z]+)=(.*)$/.exec(raw);
    if (!m) throw new RangeError(`unknown flag '${raw}'`);
    const [, key, val] = m;
    if (key === 'drops') {
      out.drops = parseInt(val, 10);
      if (!Number.isInteger(out.drops) || out.drops <= 0) throw new RangeError(`--drops must be a positive integer, got '${val}'`);
    } else if (key === 'seed') {
      out.seed = val.startsWith('0x') || val.startsWith('0X') ? parseInt(val, 16) : parseInt(val, 10);
      if (!Number.isFinite(out.seed)) throw new RangeError(`--seed must be a number, got '${val}'`);
    } else if (key === 'profile') {
      out.profile = val;
    } else {
      throw new RangeError(`unknown flag '--${key}'`);
    }
  }
  return out;
}

// ============================================================================
// Independent reference tables — transcribed from the spec ranges this
// ticket read, NOT imported from src/items/*. This is what makes R1/R2/D2's
// "matches the accounting" clauses a genuine cross-check rather than a
// tautology: if a shipped weight/table were wrong, these numbers (read
// straight off `04-items.md`) would disagree with the OBSERVED behaviour
// even though both "sides" ultimately come from the same spec — the
// observed side reflects whatever the CODE actually does, the expected side
// reflects what the SPEC TEXT says it should do.
// ============================================================================

const RARITIES = ['unique', 'rare', 'magic', 'superior', 'normal'];

// `04` §4.2 — base probabilities, rank multipliers, delta coefficients,
// difficulty multipliers, caps. `04` §4.3 — the MF hyperbola.
const Q_BASE = Object.freeze({ unique: 0.0025, rare: 0.0180, magic: 0.1600, superior: 0.2000 });
const Q_RANK = Object.freeze({
  normal: { unique: 1.00, rare: 1.00, magic: 1.00, superior: 1.00 },
  minion: { unique: 1.30, rare: 1.25, magic: 1.15, superior: 1.00 },
  champion: { unique: 2.50, rare: 2.20, magic: 1.60, superior: 1.15 },
  unique: { unique: 4.60, rare: 3.60, magic: 2.25, superior: 1.25 },
  boss: { unique: 9.20, rare: 6.40, magic: 2.60, superior: 1.00 },
  chest: { unique: 1.60, rare: 1.55, magic: 1.35, superior: 1.10 },
  sarcophagus: { unique: 1.60, rare: 1.55, magic: 1.35, superior: 1.10 },
  urn: { unique: 1.00, rare: 1.00, magic: 1.00, superior: 1.00 },
  barrel: { unique: 1.00, rare: 1.00, magic: 1.00, superior: 1.00 },
  crate: { unique: 1.00, rare: 1.00, magic: 1.00, superior: 1.00 },
});
const Q_DELTA_COEFF = Object.freeze({ unique: 0.10, rare: 0.08, magic: 0.05, superior: 0.02 });
const Q_TIER = Object.freeze({
  instruction: { unique: 1.00, rare: 1.00, magic: 1.00, superior: 1.00 },
  trial: { unique: 1.35, rare: 1.30, magic: 1.15, superior: 1.00 },
  renunciation: { unique: 1.80, rare: 1.65, magic: 1.30, superior: 1.00 },
});
const Q_CAP = Object.freeze({ unique: 0.25, rare: 0.50, magic: 0.95, superior: 0.60 });

function refEffMF(rarity, mf) {
  if (rarity === 'unique') return (mf * 250) / (mf + 250);
  if (rarity === 'rare') return (mf * 550) / (mf + 550);
  if (rarity === 'magic') return mf;
  return 0; // superior — D-7, never touched by MF
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** `04` §4.1's ladder, independently recomputed as PROBABILITIES (not a
 * draw) for a single (ilvl,mlvl,rank,difficulty,mf) tuple. Cumulative-band
 * truncation is applied exactly as §4.1 states it ("once the running total
 * reaches 1.0 the lower rarities become unreachable"), band by band, so a
 * profile like `boss` correctly yields eff.superior=eff.normal=0. */
function refQualityLadder(ilvl, mlvl, rank, difficulty, mf) {
  const rankMul = Q_RANK[rank];
  const tierMul = Q_TIER[difficulty];
  if (!rankMul) throw new RangeError(`refQualityLadder: unknown rank '${rank}'`);
  if (!tierMul) throw new RangeError(`refQualityLadder: unknown difficulty '${difficulty}'`);
  const delta = clamp(ilvl - mlvl, 0, 8);
  const p = {};
  for (const r of ['unique', 'rare', 'magic', 'superior']) {
    p[r] = clamp(Q_BASE[r] * rankMul[r] * (1 + Q_DELTA_COEFF[r] * delta) * tierMul[r] * (1 + refEffMF(r, mf) / 100), 0, Q_CAP[r]);
  }
  let cum = 0;
  const eff = {};
  for (const r of ['unique', 'rare', 'magic', 'superior']) {
    const bandTop = Math.min(1, cum + p[r]);
    eff[r] = Math.max(0, bandTop - cum);
    cum = bandTop;
  }
  eff.normal = Math.max(0, 1 - cum);
  return eff;
}

// `04` §5.4 / §5.5 (ruling D-35) — picks per rank and the nodrop scale,
// transcribed independently of `src/items/drop.js`'s own `PICKS`/
// `NODROP_SCALE` tables.
const PICKS_REF = Object.freeze({ normal: 1, minion: 1, champion: 2, unique: 4, boss: 4, urn: 1, barrel: 1, crate: 1 });
const NODROP_SCALE_REF = Object.freeze({ normal: 1.0, minion: 0.85, champion: 0.55, unique: 0.3, boss: 0.0, urn: 1.0, barrel: 1.0, crate: 1.0 });
// `04` §4.2's rank table — the Δ each rank carries (ilvl = mlvl + rankBonus,
// "Δ is not a free parameter").
const RANK_DELTA = Object.freeze({ normal: 0, minion: 0, champion: 2, unique: 3, boss: 3, chest: 2, sarcophagus: 2, urn: 0, barrel: 0, crate: 0 });
// `04` §7.1 — gold.
const RANK_GOLD_REF = Object.freeze({ normal: 1.0, minion: 1.0, champion: 2.2, unique: 4.0, boss: 12.0, chest: 1.4, sarcophagus: 1.4, urn: 0.35, barrel: 0.35, crate: 0.35 });
function refGoldBase(mlvl) {
  return 4 + 2.4 * mlvl + 0.12 * mlvl * mlvl;
}

/** `04` §9.6 — the affix-count weight formula (`w1=52-0.9*min(ilvl,40)`,
 * `w2=34+0.2*min(ilvl,40)`, `w3=14+0.7*min(ilvl,40)`), independently
 * convolved into P(nPre+nSuf = bucket) for bucket in 2..6 — nPre and nSuf
 * are drawn INDEPENDENTLY (D9b/D9c, ruling D-19) from the SAME
 * distribution, so this is a plain discrete self-convolution, not imported
 * from `src/items/roll.js#rollAffixCount`. */
function refAffixCountBucketProbs(ilvl) {
  const lvl = Math.min(ilvl, 40);
  const w1 = 52 - 0.9 * lvl;
  const w2 = 34 + 0.2 * lvl;
  const w3 = 14 + 0.7 * lvl;
  const total = w1 + w2 + w3;
  const p = [w1 / total, w2 / total, w3 / total]; // p[0]=P(1) p[1]=P(2) p[2]=P(3)
  const buckets = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (let a = 1; a <= 3; a++) for (let b = 1; b <= 3; b++) buckets[a + b] += p[a - 1] * p[b - 1];
  return buckets;
}

// `sweep`'s own highest reachable ilvl: mlvl caps at 40, and the largest
// rank delta any of its three ranks carries is `unique`'s +3 (`04` §4.2's
// rank table) — matches `04` §10.3's own "highest ilvl reached in this
// profile was 40"-style hint line, generalised to this profile's actual
// ceiling rather than hard-coded.
const SWEEP_MAX_ILVL = 40 + Math.max(RANK_DELTA.normal, RANK_DELTA.champion, RANK_DELTA.unique);

/** The diagnostic `04` §10.3's own A1 example prints alongside a dead/rare
 * affix: how many OTHER affixes of the same `kind` compete for at least
 * one of the same `requiresGroups` at the highest ilvl this profile can
 * reach, and their combined weight — so a reader can tell "rare because
 * the pool is thin and the weight is honest" from "rare because something
 * is wrong" without rerunning anything. */
function eligiblePoolInfo(affix, atIlvl) {
  let count = 0;
  let weightSum = 0;
  for (const a of AFFIXES) {
    if (a.kind !== affix.kind) continue;
    if (a.alvl > atIlvl || a.maxLevel < atIlvl) continue;
    if (!a.requiresGroups.some((g) => affix.requiresGroups.includes(g))) continue;
    count++;
    weightSum += a.weight;
  }
  return { count, weightSum };
}

// `04` §5.1 — the mlvl band table (used for G2's "four mlvl bands").
function bandOfMlvl(mlvl) {
  if (mlvl <= 9) return 0;
  if (mlvl <= 19) return 1;
  if (mlvl <= 29) return 2;
  return 3;
}

const TC_FAMILIES = Object.freeze(['tc_humanoid', 'tc_swarm', 'tc_caster', 'tc_heavy']);

function gcdOf(values) {
  const gcd2 = (a, b) => (b === 0 ? a : gcd2(b, a % b));
  return values.reduce((a, b) => gcd2(a, b), 0);
}

/** Builds a fixed-length repeating pattern array from a `[[rank,pct],...]`
 * mix summing to 100 — built once per profile at setup time, never per drop
 * (rule 5/6: no per-drop RNG draw is spent choosing a rank; the assignment
 * is a deterministic function of the drop index, exactly like every
 * absorbed test's own `ilvl = 1 + (i % 40)` convention). */
function buildRankPattern(mix) {
  const g = gcdOf(mix.map(([, pct]) => pct));
  const period = [];
  for (const [rank, pct] of mix) {
    const count = pct / g;
    for (let k = 0; k < count; k++) period.push(rank);
  }
  return period;
}

// ============================================================================
// `04` §10.1 — the six profiles, verbatim. `mlvl`/`difficulty`/`magicFind`
// are functions of the drop index `i` so `sweep`'s "uniform 1..40" / "all
// three, uniform" / "0, 50, 150" columns and the five fixed profiles share
// one shape. `ilvl` is never stored here: `04` §4.2's rank table fixes
// `ilvl = mlvl + RANK_DELTA[rank]` ("Δ is not a free parameter") — computed
// per drop from whichever rank the mix pattern assigned that iteration.
// ============================================================================

const PROFILE_ORDER = ['early', 'mid', 'late', 'champ', 'boss', 'sweep'];

const PROFILE_DEFS = Object.freeze({
  early: {
    label: 'mlvl 6   100% normal      Instruction  MF 0',
    mlvl: () => 6, difficulty: () => 'instruction', magicFind: () => 0,
    rankMix: [['normal', 100]],
  },
  mid: {
    label: 'mlvl 11  88/8/4 n/c/u     Instruction  MF 25',
    mlvl: () => 11, difficulty: () => 'instruction', magicFind: () => 25,
    rankMix: [['normal', 88], ['champion', 8], ['unique', 4]],
  },
  late: {
    label: 'mlvl 33  88/8/4 n/c/u     Renunciation MF 120',
    mlvl: () => 33, difficulty: () => 'renunciation', magicFind: () => 120,
    rankMix: [['normal', 88], ['champion', 8], ['unique', 4]],
  },
  champ: {
    label: 'mlvl 20  100% champion    Instruction  MF 50',
    mlvl: () => 20, difficulty: () => 'instruction', magicFind: () => 50,
    rankMix: [['champion', 100]],
  },
  boss: {
    label: 'mlvl 27  100% boss (rank) Trial        MF 75',
    mlvl: () => 27, difficulty: () => 'trial', magicFind: () => 75,
    rankMix: [['boss', 100]],
  },
  sweep: {
    label: 'mlvl 1..40 uniform  90/7/3 n/c/u  all tiers  MF 0/50/150',
    mlvl: (i) => 1 + (i % 40),
    difficulty: (i) => ['instruction', 'trial', 'renunciation'][i % 3],
    magicFind: (i) => [0, 50, 150][i % 3],
    rankMix: [['normal', 90], ['champion', 7], ['unique', 3]],
  },
});

for (const name of PROFILE_ORDER) {
  PROFILE_DEFS[name].rankPattern = buildRankPattern(PROFILE_DEFS[name].rankMix);
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * `04` §10.3's own profile-header format (`profile  mid   mlvl 11
 * Instruction  MF 25            200000 drops`), with the drop count being
 * the ACTUAL COUNTED figure (coordinator round 3), never the configured
 * `--drops` echoed back.
 * @param {string} name
 * @param {number} countedDrops
 */
function profileHeaderLine(name, countedDrops) {
  const def = PROFILE_DEFS[name];
  if (name === 'sweep') {
    return `profile  sweep  ilvl 1..40  all tiers  MF 0/50/150     ${countedDrops} drops`;
  }
  const mlvl = def.mlvl(0);
  const difficulty = capitalize(def.difficulty(0));
  const mf = def.magicFind(0);
  return `profile  ${name}  mlvl ${mlvl}  ${difficulty}  MF ${mf}            ${countedDrops} drops`;
}

/**
 * Splits the flat `checks` array into the six real profiles (each carrying
 * its own counted drop total, per coordinator round 3 point 3) and
 * everything else (the dedicated/global/catalogue scopes — `04` §10.3
 * rule 4's `profiles` means the profiles, not check *scopes*). A check is
 * attributed to a profile via its own `profileName` field, set at the
 * point each check id is built above — never guessed from `scope` text.
 * @param {object[]} checks
 * @param {string[]} profilesToRun
 * @param {Record<string, number>} countedDropsByProfile
 */
function groupChecksByProfile(checks, profilesToRun, countedDropsByProfile) {
  const byProfile = Object.create(null);
  for (const name of profilesToRun) byProfile[name] = [];
  const globalChecks = [];
  for (const c of checks) {
    if (c.profileName && byProfile[c.profileName]) byProfile[c.profileName].push(c);
    else globalChecks.push(c);
  }
  const profiles = profilesToRun.map((name) => ({ name, drops: countedDropsByProfile[name], checks: byProfile[name] }));
  return { profiles, globalChecks };
}

// ============================================================================
// Index maps — built once, at module load, so per-drop bookkeeping is a
// plain array index (rule 5/6: no Map, no per-drop lookup allocation).
// ============================================================================

const AFFIX_INDEX = Object.create(null);
AFFIXES.forEach((a, i) => { AFFIX_INDEX[a.id] = i; });

const EQUIPMENT_BASES = ITEM_BASES.filter((b) => b.dropWeight > 0 && (b.category === 'weapon' || b.category === 'armour' || b.category === 'jewelry'));
const BASE_INDEX = Object.create(null);
EQUIPMENT_BASES.forEach((b, i) => { BASE_INDEX[b.id] = i; });

const UNIQUE_INDEX = Object.create(null);
UNIQUES.forEach((u, i) => { UNIQUE_INDEX[u.id] = i; });

// base id -> BASE_GROUPS[].id, derived from GROUP_BASES (04 §1.3) rather
// than re-deriving category/slot rules independently — GROUP_BASES is
// `roll.js`'s own already-accepted (ITEM-5) group membership table, not the
// weighted DRAW this ticket is cross-checking.
const BASE_TO_GROUP = Object.create(null);
for (const g of BASE_GROUPS) {
  for (const b of GROUP_BASES[g.id]) BASE_TO_GROUP[b.id] = g.id;
}

// `01-data-model.md` §1.5 — the ten equipment slots. `ring2` has no base of
// its own (a ring base's `slot` field is always `'ring1'`) — any ring base
// can be equipped into either ring slot, so for L1's "every slot fillable"
// purpose a ring-slotted item satisfies BOTH `ring1` and `ring2`. Judgment
// call, flagged in this ticket's report: `ItemBase` carries no per-item
// class-affinity field (confirmed by reading every record in
// `src/items/data/bases.js`), so this is the only reading available.
const SLOT_ORDER = Object.freeze(['head', 'chest', 'hands', 'legs', 'mainHand', 'offHand', 'belt', 'amulet', 'ring1', 'ring2']);

/** The lowest `reqLevel` among the real equipment bases that can fill a
 * given `SLOT_ORDER` entry — precomputed once, used both to decide L1's
 * per-(N,slot) verdict annotation and to print it (`04` §10.3 rule 1). */
const MIN_REQ_LEVEL_FOR_SLOT = Object.create(null);
for (const slot of SLOT_ORDER) {
  const baseSlot = slot === 'ring2' ? 'ring1' : slot;
  let min = Infinity;
  for (const b of EQUIPMENT_BASES) if (b.slot === baseSlot && b.reqLevel < min) min = b.reqLevel;
  MIN_REQ_LEVEL_FOR_SLOT[slot] = min;
}

// ============================================================================
// L2/L3 — `03-combat-math.md` §2.1/§2.2's class table (start STR/DEX and the
// reference per-level allocation), transcribed independently. Judgment
// call, flagged in this ticket's report: `ItemBase` carries no per-item
// "intended class" field (confirmed against every record in
// `src/items/data/bases.js` — only `category`/`slot`/`reqLevel`/`reqStr`/
// `reqDex` exist), so "for its intended class" is read as "for the most
// permissive class at that stat" — the only class-affinity reading
// possible without inventing a field this ticket was not asked to add.
// Both L2's classStartSTR/DEX and L3's referenceSTR/DEX happen to be
// maximised by the SAME classes at every level (Ravager for STR: start 30,
// +2/level, vs Runeblade's 22 start at the same +2/level slope; Emberwright
// and Runeblade tie on DEX: start 25, +1/level, both above Ravager's 20
// start), so one number per stat covers both checks.
// ============================================================================
const CLASS_START_STR_MAX = 30; // Ravager
const CLASS_START_DEX_MAX = 25; // Emberwright / Runeblade (tie)
const CLASS_REF_STR_PER_LEVEL_MAX = 2; // Ravager (also Runeblade, same slope)
const CLASS_REF_DEX_PER_LEVEL_MAX = 1; // every class, same slope

function levelsAdvanced(reqLevel) {
  return Math.min(30, reqLevel + 4) - 1;
}

/** L2 (fail) / L3 (warn), over every one of the 61 equipment bases — a pure
 * data check, zero RNG draws needed (`ItemBase.reqStr`/`reqDex` are static).
 */
function checkSlotRequirements() {
  const l2Violations = [];
  const l3Violations = [];
  for (const b of EQUIPMENT_BASES) {
    const adv = levelsAdvanced(b.reqLevel);
    const l2Str = CLASS_START_STR_MAX + 3 * adv;
    const l2Dex = CLASS_START_DEX_MAX + 3 * adv;
    if (b.reqStr > l2Str) l2Violations.push({ id: b.id, reqLevel: b.reqLevel, reqStr: b.reqStr, bound: l2Str, stat: 'reqStr' });
    if (b.reqDex > l2Dex) l2Violations.push({ id: b.id, reqLevel: b.reqLevel, reqDex: b.reqDex, bound: l2Dex, stat: 'reqDex' });

    const l3Str = CLASS_START_STR_MAX + CLASS_REF_STR_PER_LEVEL_MAX * adv + 20;
    const l3Dex = CLASS_START_DEX_MAX + CLASS_REF_DEX_PER_LEVEL_MAX * adv + 20;
    if (b.reqStr > l3Str) l3Violations.push({ id: b.id, reqLevel: b.reqLevel, reqStr: b.reqStr, bound: l3Str, stat: 'reqStr' });
    if (b.reqDex > l3Dex) l3Violations.push({ id: b.id, reqLevel: b.reqLevel, reqDex: b.reqDex, bound: l3Dex, stat: 'reqDex' });
  }
  return { l2Violations, l3Violations, checked: EQUIPMENT_BASES.length };
}

/**
 * Every dedicated-sampler size in this file (`L1`'s 400/level, `R2`'s
 * fast/tagged counts, `G1`'s 20 000, `N2`'s 3 000 trials) is calibrated
 * against the DEFAULT `--drops=200000`. None of them are read from
 * `--drops` directly (they check the treasure-class/rank matrix or the
 * catalogue, not "a profile's own drops"), but a smoke run with a small
 * `--drops` should still finish quickly — scaling them down proportionally
 * (floored, so a tiny `--drops` still exercises real logic, never zero
 * samples) is what makes that possible without a second CLI flag.
 * @param {number} base - the calibrated size at `--drops=200000`.
 * @param {number} drops - the actual `--drops` value.
 * @param {number} floor - never return fewer than this many.
 */
function scaleN(base, drops, floor) {
  const n = Math.round(base * (drops / 200000));
  return Math.max(floor, Math.min(base, n));
}

// ============================================================================
// L1 — "every slot fillable by level N". 400 rollItem draws per N (at the
// default --drops), own dedicated Rng (not any profile's counted stream).
// Mirrors ITMS.R28's own precedent (direct rollItem sampling, not through a
// treasure class) — `04` §10.1 does not name a treasure class for this
// check and B1 already established the direct-rollItem convention for a
// coverage check.
// ============================================================================
const L1_LEVELS = [5, 10, 15, 20, 25, 30];

function checkSlotFillable(seed, drops) {
  const dropsPerLevel = scaleN(400, drops, 40);
  const results = []; // { n, slot, count, minReqLevel, unreachable }
  for (const n of L1_LEVELS) {
    const rng = new Rng(seed);
    const filled = Object.create(null);
    for (const s of SLOT_ORDER) filled[s] = 0;
    for (let i = 0; i < dropsPerLevel; i++) {
      const item = rollItem(i, n, n, 'normal', 'instruction', 0, null, rng);
      if (item.rarity === 'normal' || item.rarity === 'superior') continue; // magic-or-better only
      const base = ITEM_BASES_BY_ID[item.baseId];
      if (base.slot === 'ring1') { filled.ring1++; filled.ring2++; }
      else if (base.slot && filled[base.slot] !== undefined) filled[base.slot]++;
    }
    for (const s of SLOT_ORDER) {
      const minReqLevel = MIN_REQ_LEVEL_FOR_SLOT[s];
      // "Unreachable" means STRUCTURAL: no base for this slot has
      // reqLevel <= n at all, so rollBaseGroup can never even draw one
      // (04 §1.3's own group-redistribution rule excludes an empty-at-ilvl
      // group entirely) — the 0-count is then a certainty, not bad luck.
      // `n+4` (a headroom coefficient) is L2/L3's own reqStr/reqDex bound,
      // not this annotation's threshold — conflating the two was this
      // ticket's own first-draft bug, caught by cross-checking against
      // `04` §10.3's own worked example (whose "(N=5, amulet) ...
      // UNREACHABLE" line only makes sense under the plain `minReqLevel>n`
      // reading).
      results.push({ n, slot: s, count: filled[s], minReqLevel, unreachable: minReqLevel > n });
    }
  }
  return { results, dropsPerLevel };
}

// ============================================================================
// Counting Rng — a thin next()/int() draw counter, same shape as
// `src/items/rng.js`'s own `CountingRng` (not imported: this file counts a
// stream that also needs to survive `rollDrop`'s internal calls to every
// other `Rng` method, and keeping the counter local avoids importing
// gameplay-adjacent test infrastructure into a tool that ships to CI).
// ============================================================================
class CountingRng {
  constructor(rng) { this._rng = rng; this.draws = 0; }
  u32() { this.draws++; return this._rng.u32(); }
  next() { this.draws++; return this._rng.next(); }
  int(min, max) { this.draws++; return this._rng.int(min, max); }
  bool() { this.draws++; return this._rng.bool(); }
  range(min, max) { this.draws++; return this._rng.range(min, max); }
  pick(a) { this.draws++; return this._rng.pick(a); }
  weighted(a, b) { this.draws++; return this._rng.weighted(a, b); }
}

// ============================================================================
// Per-profile accumulator. Everything below is preallocated once per
// profile and mutated in place across the whole `--drops` loop — no object
// is created per drop except the item/gold results `rollDrop` itself must
// return (rule 5/6: "a histogram is counters, not a list you post-process").
// ============================================================================
class ProfileStats {
  constructor() {
    this.rarityObserved = { unique: 0, rare: 0, magic: 0, superior: 0, normal: 0 };
    this.rarityExpectedSum = { unique: 0, rare: 0, magic: 0, superior: 0, normal: 0 };
    this.equipmentRollCount = 0;

    this.affixCountHist = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    this.affixCountExpectedSum = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    this.rareEquipCount = 0;

    this.affixIdCounts = new Int32Array(AFFIXES.length);
    this.totalAffixInstances = 0;

    this.a3 = 0; this.a4 = 0; this.a5 = 0; this.a6 = 0; this.a7 = 0; this.a8 = 0;
    this.itemsWithAffixesChecked = 0;

    this.baseCounts = new Int32Array(EQUIPMENT_BASES.length);
    this.groupCountsAtHighIlvl = Object.create(null);
    for (const g of BASE_GROUPS) this.groupCountsAtHighIlvl[g.id] = 0;
    this.groupTotalAtHighIlvl = 0;

    this.uniqueCounts = new Int32Array(UNIQUES.length);
    this.uniqueTotalEquip = 0; // denominator for U2's share

    this.rareCodesInOrder = []; // (head,tail) codes, in draw order — this profile's own rares only
    this.rareShapeViolations = 0; // N1

    this.bandValueSum = [0, 0, 0, 0];
    this.bandValueCount = [0, 0, 0, 0];

    this.gold = 0;
    this.totalDrops = 0;
    this.totalEquipEver = 0; // includes guarantee items, for sanity printing
  }
}

/**
 * Runs one profile's full `--drops` sample. `resetUidCounter()` /
 * `resetRareRing()` (O-77) are the STATED PRECONDITION every batch needs —
 * called here, at the top, not as incidental setup.
 */
function runProfile(name, drops, seed) {
  resetUidCounter();
  resetRareRing();

  const def = PROFILE_DEFS[name];
  const pattern = def.rankPattern;
  const rawRng = new Rng(seed);
  const rng = new CountingRng(rawRng);
  const stats = new ProfileStats();
  const hash = createHash('sha256');
  const isSweep = name === 'sweep';

  for (let i = 0; i < drops; i++) {
    const mlvl = def.mlvl(i);
    const rank = pattern[i % pattern.length];
    const ilvl = mlvl + RANK_DELTA[rank];
    const difficulty = def.difficulty(i);
    const magicFind = def.magicFind(i);
    const family = TC_FAMILIES[i % TC_FAMILIES.length];

    const result = rollDrop(family, mlvl, rank, ilvl, difficulty, magicFind, rng);
    stats.totalDrops++;
    stats.gold += result.gold;

    const items = result.items;
    // The unique-rank guarantee (§5.4) applies a rarity FLOOR to one extra
    // pick when none of the 4 natural picks already produced magic-or-
    // better equipment — and `rollDrop` returns only the aggregated
    // `{items, gold}`, not which entry was the guarantee's. In the general
    // case this is NOT recoverable from the output alone: a single
    // magic-or-better equipment item on a unique-rank call could be either
    // a genuine natural roll or the floor-boosted guarantee (both produce
    // an indistinguishable `ItemInstance`) — proven by direct inspection
    // while building this harness (see this ticket's report). Rather than
    // guess with a heuristic that can silently corrupt R1's tally (this
    // file's own earlier `equipCount===5` / `items.length===picks+1`
    // heuristics both did exactly that — caught by the D2 cross-check
    // below disagreeing with reality), `rank==='unique'` equipment items
    // are EXCLUDED from R1/U2's natural-ladder tally entirely, for every
    // profile. This does not weaken R1: `unique` rank is a documented D14
    // guarantee mechanic, not part of the natural ladder R1 measures, and
    // `unique`-rank rolls are the ITEM-9-tested guarantee itself (still
    // exercised in full by B1/A3-A8/N1/N2/the band-value check below,
    // none of which care about this natural-vs-guaranteed ambiguity).
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      const base = ITEM_BASES_BY_ID[it.baseId];

      // -- D1's serialised item-stream hash — every item, every profile. --
      hash.update(it.baseId); hash.update('|'); hash.update(it.rarity); hash.update('|'); hash.update(String(it.ilvl)); hash.update('|');
      hash.update(it.uniqueId || ''); hash.update('|'); hash.update(it.uniqueValues.join(':')); hash.update('|');
      hash.update(it.nameOverride ? String(it.nameOverride.code) : ''); hash.update('|');
      for (let a = 0; a < it.affixes.length; a++) { hash.update(it.affixes[a].id); hash.update(','); hash.update(it.affixes[a].values.join(':')); hash.update(';'); }
      hash.update('#');

      if (base.category === 'consumable') continue;

      stats.totalEquipEver++;

      if (rank !== 'unique') {
        stats.rarityObserved[it.rarity]++;
        stats.equipmentRollCount++;
        const ladder = refQualityLadder(ilvl, mlvl, rank, difficulty, magicFind);
        for (const r of RARITIES) stats.rarityExpectedSum[r] += ladder[r];
      }

      if (it.rarity === 'rare') {
        stats.rareEquipCount++;
        const n = it.affixes.length;
        if (stats.affixCountHist[n] !== undefined) stats.affixCountHist[n]++;
        const bucketProbs = refAffixCountBucketProbs(ilvl);
        for (const b of [2, 3, 4, 5, 6]) stats.affixCountExpectedSum[b] += bucketProbs[b];
        if (it.nameOverride) {
          if (isSweep) stats.rareCodesInOrder.push(it.nameOverride.code);
          const { headIndex, tailIndex, en, ru } = it.nameOverride;
          if (
            !(headIndex >= 0 && headIndex < RARE_HEAD.length) ||
            !(tailIndex >= 0 && tailIndex < RARE_TAIL.length) ||
            typeof en !== 'string' || en.length === 0 ||
            typeof ru !== 'string' || ru.length === 0
          ) stats.rareShapeViolations++;
        } else {
          stats.rareShapeViolations++;
        }
      }

      if (isSweep) {
        const bi = BASE_INDEX[it.baseId];
        if (bi !== undefined) stats.baseCounts[bi]++;
        if (ilvl >= 27) {
          const g = BASE_TO_GROUP[it.baseId];
          if (g) { stats.groupCountsAtHighIlvl[g]++; stats.groupTotalAtHighIlvl++; }
        }
        if (it.uniqueId) {
          const ui = UNIQUE_INDEX[it.uniqueId];
          if (ui !== undefined) stats.uniqueCounts[ui]++;
        }
        stats.uniqueTotalEquip++;

        const band = bandOfMlvl(mlvl);
        stats.bandValueSum[band] += base.baseValue;
        stats.bandValueCount[band]++;
      }

      // A3-A8 — every equipment item, every profile, zero-tolerance.
      if (it.affixes.length > 0) {
        stats.itemsWithAffixesChecked++;
        const seenGroups = new Set();
        for (const inst of it.affixes) {
          stats.totalAffixInstances++;
          const adef = AFFIXES_BY_ID[inst.id];
          if (isSweep) {
            const ai = AFFIX_INDEX[inst.id];
            if (ai !== undefined) stats.affixIdCounts[ai]++;
          }
          if (!adef) { stats.a6++; continue; }
          if (seenGroups.has(adef.group)) stats.a3++;
          seenGroups.add(adef.group);
          if (adef.alvl > it.ilvl) stats.a4++;
          if (adef.maxLevel < it.ilvl) stats.a5++;
          if (inst.values.length !== adef.mods.length) stats.a6++;
          for (let m = 0; m < adef.mods.length; m++) {
            const mod = adef.mods[m];
            const v = inst.values[m];
            if (v === undefined) continue;
            const step = mod.step === undefined ? 1 : mod.step;
            const inRange = v >= mod.min - 1e-9 && v <= mod.max + 1e-9;
            const onLattice = Math.abs((v - mod.min) / step - Math.round((v - mod.min) / step)) < 1e-6;
            if (!inRange || !onLattice) stats.a7++;
          }
          if (adef.sharedRoll) {
            const v0 = inst.values[0];
            for (const v of inst.values) if (v !== v0) { stats.a8++; break; }
          }
        }
      }
    }
  }

  return { stats, sha256: hash.digest('hex'), totalDraws: rng.draws };
}

// ============================================================================
// R2 / D2 — the reconstruction sampler.
//
// `rollDrop` returns only `{items, gold}`, aggregated over up to
// `PICKS[rank]` picks — not which pick produced what. For a single-pick rank
// (`normal`/`minion`) "the call produced nothing" is exactly "the one pick
// was nodrop", but for a multi-pick rank (`champion`=2, `unique`=4(+1),
// `boss`=4) that equivalence breaks down (one pick can be nodrop while
// another produces gold). This sampler recovers the PER-PICK entry kind —
// and therefore both R2 (nodrop rate) and D2's "matches the §9.2
// accounting" clause — by tagging every raw draw and REPLAYING `pickTcEntry`
// (`04` §9.2 D1) against it, using an INDEPENDENTLY WRITTEN copy of that
// two-pass weighted scan (`replayPickTcEntry` below), not `drop.js`'s own
// (unexported) function. This is what makes it a genuine cross-check: if
// the shipped `nodropWeight`/`entries` weights were wrong, this sampler's
// reconstructed per-pick kinds would still be computed from the SAME
// raw draw values `rollDrop` actually consumed, so a divergence between
// "predicted total draws" and "actual total draws" is a real accounting bug,
// not a tautology.
//
// Run on a MODEST dedicated sample (not the full --drops count) so it stays
// fast — the main 1.2M-drop loop above never uses a tagging Rng.
// ============================================================================

class TaggingRng {
  constructor(rng) { this._rng = rng; this.log = []; }
  get draws() { return this.log.length; }
  u32() { const r = this._rng.u32(); this.log.push({ m: 'u32', args: [], r }); return r; }
  next() { const r = this._rng.next(); this.log.push({ m: 'next', args: [], r }); return r; }
  int(min, max) { const r = this._rng.int(min, max); this.log.push({ m: 'int', args: [min, max], r }); return r; }
  bool() { const r = this._rng.bool(); this.log.push({ m: 'bool', args: [], r }); return r; }
  range(min, max) { const r = this._rng.range(min, max); this.log.push({ m: 'range', args: [min, max], r }); return r; }
  pick(a) { const r = this._rng.pick(a); this.log.push({ m: 'pick', args: [], r }); return r; }
  weighted(a, b) { const r = this._rng.weighted(a, b); this.log.push({ m: 'weighted', args: [], r }); return r; }
}

/** Independent replay of `drop.js#pickTcEntry` (D1): given the SAME raw
 * `[0,1)` draw the real call consumed, returns which entry kind it must
 * have picked. Two-pass weighted scan, written fresh from `04` §5.1/§9.2's
 * own text, not imported. */
function replayPickTcEntry(entries, nodropWeight, r0) {
  let total = 0;
  for (const e of entries) total += e.kind === 'nodrop' ? nodropWeight : e.weight;
  let r = r0 * total;
  for (const e of entries) {
    const w = e.kind === 'nodrop' ? nodropWeight : e.weight;
    r -= w;
    if (r < 0) return e.kind;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const w = e.kind === 'nodrop' ? nodropWeight : e.weight;
    if (w > 0) return e.kind;
  }
  throw new Error('replayPickTcEntry: unreachable');
}

/** The R25/AF04/U11 draw-count formula (already-accepted reference
 * behaviour, absorbed from `tests/items/roll.test.js` et al.) for a single
 * rolled item's D3-D12 draws, EXCLUDING D13 (rare naming — variable length,
 * detected structurally below, exactly like R25 did). */
function expectedRollItemDrawsExcl13(item) {
  const base = ITEM_BASES_BY_ID[item.baseId];
  let n = 3 + (item.rarity === 'superior' ? 1 : 0) + (base.armour ? 1 : 0);
  if (item.rarity === 'magic') n += 1;
  if (item.rarity === 'rare') n += 2;
  if (item.rarity === 'unique') {
    const def = UNIQUES_BY_ID[item.uniqueId];
    n += 1 + (def ? def.mods.length : 0);
  }
  for (const inst of item.affixes) {
    n += 1;
    const def = AFFIXES_BY_ID[inst.id];
    n += def && def.sharedRoll ? 1 : (def ? def.mods.length : inst.values.length);
  }
  return n;
}

/** Scans `log` starting at `cursor` for D13's variable-length tail: pairs of
 * `int(0,55)`/`int(0,47)` calls, 0-4 pairs (0/2/4/6/8 draws), stopping the
 * instant the next two entries don't look like such a pair — safe because
 * D15 (the only thing that can follow) is always `next()`, never `int()`,
 * so it can never be mistaken for a D13 pair (see file header). */
function scanD13(log, cursor) {
  let n = 0;
  while (n < 8) {
    const a = log[cursor + n];
    const b = log[cursor + n + 1];
    if (!a || !b || a.m !== 'int' || b.m !== 'int') break;
    if (a.args[0] !== 0 || a.args[1] !== 55 || b.args[0] !== 0 || b.args[1] !== 47) break;
    n += 2;
  }
  return n;
}

/**
 * Replays ONE `rollDrop` call's tagged log, pick by pick, recovering each
 * pick's `entryKind` and cross-validating the exact total draws consumed
 * against an independently-derived expectation.
 * @returns {{ pickKinds: string[], expectedDraws: number, actualDraws: number, mismatch: string|null }}
 */
const RARITY_RANK_REF = Object.freeze({ normal: 0, superior: 1, magic: 2, rare: 3, unique: 4 });

function reconstructCall(callLog, rank, tcEntries, resultItems) {
  const picks = PICKS_REF[rank];
  const scale = NODROP_SCALE_REF[rank] !== undefined ? NODROP_SCALE_REF[rank] : 1;
  const nodropEntry = tcEntries.find((e) => e.kind === 'nodrop');
  const nodropWeight = nodropEntry ? Math.round(nodropEntry.weight * scale) : 0;

  let cursor = 0;
  let itemIdx = 0;
  const pickKinds = [];
  let mismatch = null;
  // §5.4's own guarantee condition, tracked exactly as `drop.js` tracks it
  // (`gotMagicOrBetterItem`) — this reconstruction sees each NATURAL pick's
  // outcome as it replays them, so (unlike the fast main loop above, which
  // only ever sees the aggregated `items[]` and cannot always distinguish a
  // natural magic+ roll from the guarantee's floor-boosted one) this can
  // compute the real condition directly instead of guessing from a count.
  let gotMagicOrBetterItem = false;

  for (let p = 0; p < picks; p++) {
    const d1 = callLog[cursor];
    if (!d1 || d1.m !== 'next') { mismatch = `pick ${p}: expected a D1 next() call at cursor ${cursor}`; break; }
    const kind = replayPickTcEntry(tcEntries, nodropWeight, d1.r);
    cursor += 1;
    pickKinds.push(kind);
    if (kind === 'nodrop') continue;

    if (kind === 'gold') {
      cursor += 1; // D2
    } else if (kind === 'potion' || kind === 'scroll') {
      cursor += 1; // D14
      itemIdx++;
    } else if (kind === 'item') {
      const item = resultItems[itemIdx++];
      if (!item) { mismatch = `pick ${p}: expected an item at resultItems[${itemIdx - 1}]`; break; }
      const nonD13 = expectedRollItemDrawsExcl13(item);
      cursor += nonD13;
      if (item.rarity === 'rare') cursor += scanD13(callLog, cursor);
      if (RARITY_RANK_REF[item.rarity] >= RARITY_RANK_REF.magic) gotMagicOrBetterItem = true;
    } else {
      mismatch = `pick ${p}: unrecognised entry kind '${kind}'`;
      break;
    }
    cursor += 2; // D15a/D15b, always taken and discarded for a non-nodrop pick
  }

  const guaranteeFired = rank === 'unique' && !gotMagicOrBetterItem;
  if (!mismatch && guaranteeFired) {
    const item = resultItems[itemIdx++];
    if (item) {
      const nonD13 = expectedRollItemDrawsExcl13(item);
      cursor += nonD13;
      if (item.rarity === 'rare') cursor += scanD13(callLog, cursor);
      cursor += 2; // D15
      pickKinds.push('guarantee-item');
    } else {
      mismatch = 'unique-rank guarantee fired (no natural magic-or-better item) but no extra item found in resultItems';
    }
  }

  return { pickKinds, expectedDraws: cursor, actualDraws: callLog.length, mismatch };
}

/**
 * D2's "matches the §9.2 accounting" cross-check, over a modest dedicated
 * sample per profile (not the full `--drops` count — a structural,
 * zero-tolerance check needs far fewer samples than a statistical one).
 * R2's nodrop tallies are NOT collected here any more (see the header
 * comment above `ProfileStats.nodropBuckets` and `runUniqueNodropSample`
 * below for why non-`unique` ranks are measured on the full fast-path
 * sample instead, and `unique` on its own dedicated large sample).
 */
function runAccountingSample(name, seed, sampleSize) {
  const def = PROFILE_DEFS[name];
  const pattern = def.rankPattern;
  resetUidCounter();
  resetRareRing();
  const rng = new TaggingRng(new Rng(seed));

  let accountingChecked = 0;
  let accountingMismatches = 0;
  const mismatchSamples = [];

  for (let i = 0; i < sampleSize; i++) {
    const mlvl = def.mlvl(i);
    const rank = pattern[i % pattern.length];
    const ilvl = mlvl + RANK_DELTA[rank];
    const difficulty = def.difficulty(i);
    const magicFind = def.magicFind(i);
    const family = TC_FAMILIES[i % TC_FAMILIES.length];
    const tcId = resolveTC(family, mlvl);
    const tcRec = TREASURE_CLASSES_BY_ID[tcId];

    const before = rng.log.length;
    const result = rollDrop(family, mlvl, rank, ilvl, difficulty, magicFind, rng);
    const callLog = rng.log.slice(before);

    const { expectedDraws, actualDraws, mismatch } = reconstructCall(callLog, rank, tcRec.entries, result.items);
    accountingChecked++;
    if (mismatch || expectedDraws !== actualDraws) {
      accountingMismatches++;
      if (mismatchSamples.length < 10) {
        mismatchSamples.push({ i, tcId, rank, ilvl, mlvl, difficulty, magicFind, expectedDraws, actualDraws, mismatch });
      }
    }
  }

  return { accountingChecked, accountingMismatches, mismatchSamples };
}

/**
 * R2 — nodrop rate per (treasure class, rank), for every (family, band,
 * rank) combination `04` §10.1's four ranks touch (`normal`, `champion`,
 * `unique`, `boss` — `minion`/the container ranks never appear in any
 * profile's mix). DEDICATED and LARGE, decoupled from any one profile's own
 * rank mix (a profile like `mid` only spends 8%/4% of its drops on
 * `champion`/`unique`, which is not enough samples on its own to resolve
 * R2's ±0.8pp tolerance reliably — discovered empirically while building
 * this harness: the mix-derived buckets showed spurious ~1pp misses that
 * vanished at the sample sizes used here). `normal`/`champion`/`boss` have
 * no guarantee mechanic, so "the call produced literally nothing"
 * (`items.length===0 && gold===0`) is EXACTLY "every one of `PICKS[rank]`
 * picks was nodrop", and `observedNodropRate = P(empty)^(1/picks)` is exact
 * — no tagging needed, so these three ranks are sampled at full speed.
 * `unique`'s guarantee breaks that identity (an all-nodrop natural draw
 * never surfaces as an empty call — proven empirically, see this ticket's
 * report), so it alone uses the tagged `reconstructCall` replay.
 */
function runNodropSample(seed, drops) {
  const BAND_MLVL = [5, 15, 25, 35]; // one representative mlvl per band (04 §5.1)
  const buckets = Object.create(null);

  // Calibrated at 60000/20000 against the default --drops=200000 (see
  // this ticket's report: smaller sizes left ~1pp-scale noise on a few
  // champion/unique buckets, occasionally crossing the ±0.8pp tolerance by
  // chance — verified across multiple seeds before settling here).
  const N_FAST = scaleN(60000, drops, 400);
  resetUidCounter();
  resetRareRing();
  const fastRng = new Rng(seed);
  for (const rank of ['normal', 'champion', 'boss']) {
    for (const family of TC_FAMILIES) {
      for (const mlvl of BAND_MLVL) {
        const ilvl = mlvl + RANK_DELTA[rank];
        const tcId = resolveTC(family, mlvl);
        let emptyCalls = 0;
        for (let k = 0; k < N_FAST; k++) {
          const result = rollDrop(family, mlvl, rank, ilvl, 'instruction', 0, fastRng);
          if (result.items.length === 0 && result.gold === 0) emptyCalls++;
        }
        buckets[`${tcId}|${rank}`] = { tcId, rank, kind: 'power', emptyCalls, totalCalls: N_FAST, picks: PICKS_REF[rank] };
      }
    }
  }

  const N_TAGGED = scaleN(20000, drops, 200);
  resetUidCounter();
  resetRareRing();
  const taggedRng = new TaggingRng(new Rng(seed ^ 0x1111));
  for (const family of TC_FAMILIES) {
    for (const mlvl of BAND_MLVL) {
      const ilvl = mlvl + RANK_DELTA.unique;
      const tcId = resolveTC(family, mlvl);
      const tcRec = TREASURE_CLASSES_BY_ID[tcId];
      let nodrop = 0;
      let totalPicks = 0;
      for (let k = 0; k < N_TAGGED; k++) {
        const before = taggedRng.log.length;
        const result = rollDrop(family, mlvl, 'unique', ilvl, 'instruction', 0, taggedRng);
        const callLog = taggedRng.log.slice(before);
        const { pickKinds, mismatch } = reconstructCall(callLog, 'unique', tcRec.entries, result.items);
        if (mismatch) continue;
        for (const kind of pickKinds) {
          if (kind === 'guarantee-item') continue; // not a tcEntries pick
          totalPicks++;
          if (kind === 'nodrop') nodrop++;
        }
      }
      buckets[`${tcId}|unique`] = { tcId, rank: 'unique', kind: 'direct', nodrop, totalPicks };
    }
  }

  return buckets;
}

// ============================================================================
// R1 — rarity distribution. `04` §4.5's own tables (and the closed form of
// §4.1) describe the QUALITY ROLL alone (`rollQuality`) — `rollItem`'s own
// pipeline runs `degrade()` (§4.4/§9.5) AFTER it, which is a SEPARATE,
// documented mechanic (jewelry always degrades a `superior` roll to
// `normal`; an affix-poor base pulls `rare`/`magic` down further). Sampling
// `item.rarity` off real `rollDrop` output — this file's first attempt —
// therefore measures the POST-degrade distribution and shows a persistent
// ~3pp `superior`-under/`normal`-over bias against §4.5's pure-ladder
// numbers on every profile: real, but not what R1 asks for. `rollQuality`
// is called DIRECTLY here (matching `tests/items/quality.test.js`'s own
// absorbed Q04a/b/c technique, extended from the three canonical profiles
// to all six lootsim ones), on its own dedicated Rng — never the profile's
// own counted `--drops` stream, so this has no effect on D1/D2.
// ============================================================================
function runR1Sample(name, drops, seed) {
  const def = PROFILE_DEFS[name];
  const pattern = def.rankPattern;
  const rng = new Rng(seed);
  const observed = { unique: 0, rare: 0, magic: 0, superior: 0, normal: 0 };
  const expectedSum = { unique: 0, rare: 0, magic: 0, superior: 0, normal: 0 };
  for (let i = 0; i < drops; i++) {
    const mlvl = def.mlvl(i);
    const rank = pattern[i % pattern.length];
    const ilvl = mlvl + RANK_DELTA[rank];
    const difficulty = def.difficulty(i);
    const magicFind = def.magicFind(i);
    const rarity = rollQuality(ilvl, mlvl, rank, difficulty, magicFind, rng);
    observed[rarity]++;
    const ladder = refQualityLadder(ilvl, mlvl, rank, difficulty, magicFind);
    for (const r of RARITIES) expectedSum[r] += ladder[r];
  }
  return { observed, expectedSum, n: drops };
}

// ============================================================================
// G1 — gold. `rollDrop`'s own gold branch pins `goldFind=0` (`drop.js`'s own
// header) — so `rollGold(mlvl, rank, 0, rng)` IS the exact formula every
// gold pick in this harness draws from. Sampled directly, on a dedicated
// Rng, at every distinct (mlvl,rank) pair the six profiles actually use
// (`sweep` excluded — its mlvl is continuous, not banded, so "per mlvl
// band" does not apply to it the way it does to the five fixed profiles).
// ============================================================================
function collectGoldPairs() {
  const pairs = [];
  const seen = new Set();
  for (const name of ['early', 'mid', 'late', 'champ', 'boss']) {
    const def = PROFILE_DEFS[name];
    const mlvl = def.mlvl(0);
    for (const [rank] of def.rankMix) {
      const key = `${mlvl}|${rank}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ profile: name, mlvl, rank });
    }
  }
  return pairs;
}

function checkGold(seed, drops) {
  const pairs = collectGoldPairs();
  const N = scaleN(20000, drops, 200);
  const results = [];
  let i = 0;
  for (const { profile, mlvl, rank } of pairs) {
    const rng = new Rng(seed + 0x9001 + i++);
    let sum = 0;
    for (let k = 0; k < N; k++) sum += rollGold(mlvl, rank, 0, rng);
    const observedMean = sum / N;
    const expectedMean = refGoldBase(mlvl) * RANK_GOLD_REF[rank];
    const devPct = (Math.abs(observedMean - expectedMean) / expectedMean) * 100;
    results.push({ profile, mlvl, rank, observedMean, expectedMean, devPct, pass: devPct <= 2.0 });
  }
  return results;
}

// ============================================================================
// G2 — mean base value (the only value-like field an `ItemBase` carries in
// this ticket's read range; `04` §7.2 — the full `itemValue` formula with
// affix bonuses — is outside `04` §7.1's read range, flagged in this
// ticket's report) must be non-decreasing across the four `resolveTC` mlvl
// bands (`04` §5.1). Derived from `sweep`'s own band-value accumulators
// (already gathered by `runProfile` above — `sweep` is the only profile
// that spans mlvl 1..40).
//
// TODO(ITEM-14): `ITEM-14` owns `itemValue` (`04` §7.2, the real formula
// with affix bonuses) and has not landed yet — coordinator-accepted as a
// proxy for now. Once ITEM-14 ships, tighten this to the real `itemValue`
// instead of the base's own static `baseValue`.
// ============================================================================
function checkBandValue(sweepStats) {
  const means = sweepStats.bandValueCount.map((c, i) => (c > 0 ? sweepStats.bandValueSum[i] / c : null));
  let pass = true;
  for (let i = 1; i < means.length; i++) {
    if (means[i - 1] !== null && means[i] !== null && means[i] < means[i - 1]) pass = false;
  }
  return { means, counts: sweepStats.bandValueCount.slice(), pass };
}

// ============================================================================
// N2 — the ring invariant (hard fail, checked per-profile against that
// profile's own rare stream — the ring is reset between profiles, O-77) and
// the statistical ceiling (warn; ruling 5: 35-40%, NOT `04` §3.5's
// superseded 69.4%/75%), measured the same way `tests/items/names.test.js`'s
// own ITMS.N10 does: many independent trials of 100 draws from a freshly
// reset ring.
// ============================================================================
function checkRingWindow(codes) {
  let violations = 0;
  const window = new Set();
  const queue = [];
  for (const code of codes) {
    if (window.has(code)) violations++;
    else window.add(code);
    queue.push(code);
    if (queue.length > 64) window.delete(queue.shift());
  }
  return violations;
}

function checkN2Statistical(seed, drops) {
  const trials = scaleN(3000, drops, 100);
  const drawsPerTrial = 100;
  const rng = new Rng(seed + 0xbeef);
  let withRepeat = 0;
  for (let t = 0; t < trials; t++) {
    resetRareRing();
    const seenCodes = new Set();
    let repeated = false;
    for (let i = 0; i < drawsPerTrial; i++) {
      const code = rollRareName(rng).code;
      if (seenCodes.has(code)) repeated = true;
      seenCodes.add(code);
    }
    if (repeated) withRepeat++;
  }
  resetRareRing();
  return { trials, rate: withRepeat / trials, pass: withRepeat / trials < 0.40 };
}

// ============================================================================
// Report assembly. Every check is built as { id, severity, scope, pass,
// lines: string[] } — `lines` already carries the offending data (`04`
// §10.3 rule 1), so both the human and `--json` renderers read from the
// same structure. Fail-severity checks that don't pass flip the exit code;
// warn-severity checks never do (rule 3).
// ============================================================================

function pctStr(v) { return `${v.toFixed(3)}%`; }

function buildChecks(ctx) {
  const { profilesToRun, perProfile, r1PerProfile, accountingPerProfile, nodropBuckets, l1Results, slotReq, g1Results, n2Stat, drops } = ctx;
  const checks = [];

  // -- R1 — rarity distribution (pure quality-roll ladder), per profile -----
  for (const name of profilesToRun) {
    const { observed: obs, expectedSum, n } = r1PerProfile[name];
    const rows = [];
    let pass = true;
    for (const r of RARITIES) {
      const observed = n > 0 ? (obs[r] / n) * 100 : 0;
      const expected = n > 0 ? (expectedSum[r] / n) * 100 : 0;
      const tol = r === 'unique' ? 0.30 : 1.0;
      const dev = observed - expected;
      const ok = Math.abs(dev) <= tol;
      if (!ok) pass = false;
      rows.push({ r, observed, expected, dev, tol, ok });
    }
    const lines = [`sample: ${n} rollQuality draws (direct — the pure ladder, not post-degrade item.rarity; see file header)`];
    for (const row of rows) {
      lines.push(`  ${row.r.padEnd(9)} observed ${pctStr(row.observed).padStart(9)}  expected ${pctStr(row.expected).padStart(9)}  dev ${row.dev >= 0 ? '+' : ''}${row.dev.toFixed(3)}  tol ±${row.tol}  ${row.ok ? 'ok' : 'FAIL'}`);
    }
    checks.push({ id: 'R1', severity: 'fail', scope: name, profileName: name, pass, lines });
  }

  // -- S1 — the workload proof (coordinator round 3). §10.1's own time
  // budget is a trap the brief names explicitly: a harness that finishes
  // fast by silently short-circuiting its loop is worse than one that
  // finishes slow honestly. `stats.totalDrops` is incremented once per
  // iteration of the ACTUAL roll loop (`runProfile`, above) — not the
  // configured `--drops` echoed back — so a bug that breaks out of that
  // loop early shows up here as a smaller number, not invisibly. Hard
  // fail: this is not a distribution check, it is "did the work happen".
  for (const name of profilesToRun) {
    const counted = perProfile[name].stats.totalDrops;
    const configured = drops;
    const pass = counted === configured;
    checks.push({
      id: 'S1', severity: 'fail', scope: name, profileName: name, pass,
      lines: [`counted drops (incremented in the roll loop): ${counted}  configured --drops: ${configured}  ${pass ? 'match' : 'MISMATCH — the roll loop did not run its full sample'}`],
    });
  }

  // -- R2 — nodrop rate per (treasure class, rank). Global — a dedicated
  // sample (`runNodropSample`), independent of `--profile` selection: see
  // that function's own header for why a profile's natural rank mix does
  // not give reliable enough sample sizes for this check's ±0.8pp tolerance.
  {
    const buckets = nodropBuckets;
    let pass = true;
    const lines = [];
    const keys = Object.keys(buckets).sort();
    for (const key of keys) {
      const b = buckets[key];
      let observed;
      let n;
      if (b.kind === 'power') {
        if (b.totalCalls === 0) continue;
        n = b.totalCalls;
        const emptyRate = b.emptyCalls / b.totalCalls;
        observed = Math.pow(emptyRate, 1 / b.picks) * 100;
      } else {
        if (b.totalPicks === 0) continue;
        n = b.totalPicks;
        observed = (b.nodrop / b.totalPicks) * 100;
      }
      const tcRec = TREASURE_CLASSES_BY_ID[b.tcId];
      const scale = NODROP_SCALE_REF[b.rank] !== undefined ? NODROP_SCALE_REF[b.rank] : 1;
      const nodropEntry = tcRec.entries.find((e) => e.kind === 'nodrop');
      const nodropWeight = nodropEntry ? Math.round(nodropEntry.weight * scale) : 0;
      let total = 0;
      for (const e of tcRec.entries) total += e.kind === 'nodrop' ? nodropWeight : e.weight;
      const expected = total > 0 ? (nodropWeight / total) * 100 : 0;
      const dev = observed - expected;
      const ok = Math.abs(dev) <= 0.8;
      if (!ok) pass = false;
      lines.push(`  ${b.tcId.padEnd(14)} rank ${b.rank.padEnd(10)} observed ${pctStr(observed).padStart(9)}  expected ${pctStr(expected).padStart(9)}  dev ${dev >= 0 ? '+' : ''}${dev.toFixed(3)}  tol ±0.8  n=${n}  ${ok ? 'ok' : 'FAIL'}`);
    }
    const anyMismatch = profilesToRun.some((n) => accountingPerProfile[n].accountingMismatches > 0);
    if (anyMismatch) lines.push('  NOTE: D2 accounting mismatches were found elsewhere in this run — see D2 below (R2 itself does not depend on that reconstruction any more)');
    checks.push({ id: 'R2', severity: 'fail', scope: 'nodrop rate (fast-path power identity + dedicated unique-rank sample)', pass, lines });
  }

  // -- R3 — affix-count histogram for rares, combined across profiles run --
  {
    const hist = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    const expSum = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    let n = 0;
    for (const name of profilesToRun) {
      const { stats } = perProfile[name];
      for (const b of [2, 3, 4, 5, 6]) { hist[b] += stats.affixCountHist[b]; expSum[b] += stats.affixCountExpectedSum[b]; }
      n += stats.rareEquipCount;
    }
    let pass = true;
    const lines = [`sample: ${n} rare equipment items (combined across profiles run)`];
    for (const b of [2, 3, 4, 5, 6]) {
      const observed = n > 0 ? (hist[b] / n) * 100 : 0;
      const expected = n > 0 ? (expSum[b] / n) * 100 : 0;
      const dev = observed - expected;
      const ok = Math.abs(dev) <= 1.0;
      if (!ok) pass = false;
      lines.push(`  total=${b}  observed ${pctStr(observed).padStart(9)}  expected ${pctStr(expected).padStart(9)}  dev ${dev >= 0 ? '+' : ''}${dev.toFixed(3)}  tol ±1.0  ${ok ? 'ok' : 'FAIL'}`);
    }
    checks.push({ id: 'R3', severity: 'fail', scope: 'combined (profiles run)', pass, lines });
  }

  // -- A1/A2 — sweep only ----------------------------------------------------
  //
  // Coordinator ruling: `04` §10.2's own text defines A1's purpose —
  // catching an affix whose `requiresGroups` intersects nothing, whose
  // `alvl` exceeds every reachable `ilvl`, or whose weight is zero, "the
  // three ways an affix silently STOPS EXISTING." An affix seen 6 times in
  // 200 000 drops has not stopped existing — it is `alvl 29`, low weight,
  // narrow `applies`, in a profile that only reaches ilvl>=29 on a
  // minority of drops. The coordinator re-ran this harness at 5x the
  // sample and confirmed both counts scale up with N (dead affixes do
  // not). The original 25-count threshold was a PROXY for "dead" and was
  // under-powered at 200 000 drops for the rarest legal combinations.
  //
  // A1 therefore hard-fails ONLY at a genuine zero (severity `fail`,
  // changes the exit code) — that is the actual "stopped existing"
  // condition the table's own Severity column describes ("prints every id
  // AT 0"). A count of 1-24 is downgraded to a non-fatal `softWarn`: still
  // printed in full (id, alvl, weight, applies, observed count, and the
  // eligible-pool diagnostic `04` §10.3's own example prints), never
  // silently dropped, never flips `pass`, never changes the exit code.
  //
  // This does not create a blind spot: existence (A1, at zero) and
  // magnitude (U2's ±0.15pp on unique share; R1/R3's own tolerances) are
  // different assertions. A weight that is four times too small but
  // non-zero is still caught — by the rate checks, not by A1. Do NOT
  // restore the 25-count threshold without re-reading this comment.
  if (perProfile.sweep) {
    const { stats } = perProfile.sweep;
    const dead = [];
    const rare = [];
    let dominant = null;
    for (let i = 0; i < AFFIXES.length; i++) {
      const count = stats.affixIdCounts[i];
      const affix = AFFIXES[i];
      if (count === 0) dead.push({ id: affix.id, count, alvl: affix.alvl, weight: affix.weight, appliesTo: affix.appliesTo, requiresGroups: affix.requiresGroups, kind: affix.kind, maxLevel: affix.maxLevel });
      else if (count < 25) rare.push({ id: affix.id, count, alvl: affix.alvl, weight: affix.weight, appliesTo: affix.appliesTo, requiresGroups: affix.requiresGroups, kind: affix.kind, maxLevel: affix.maxLevel });
      const share = stats.totalAffixInstances > 0 ? count / stats.totalAffixInstances : 0;
      if (!dominant || share > dominant.share) dominant = { id: affix.id, share, count };
    }
    const a1Pass = dead.length === 0;
    const a1SoftWarn = rare.length > 0;
    const a1Lines = [`117 affixes checked over ${stats.totalAffixInstances} rolled AffixInstances in sweep (sweep's own highest reachable ilvl: ${SWEEP_MAX_ILVL})`];
    if (!a1Pass) {
      a1Lines.push(`${dead.length} of 117 affixes NEVER rolled — genuinely dead (hard fail):`);
      for (const d of dead) {
        const pool = eligiblePoolInfo(d, SWEEP_MAX_ILVL);
        a1Lines.push(`  ${d.id.padEnd(24)} alvl ${d.alvl}  weight ${d.weight}  applies ${d.appliesTo.join('/')}  seen ${d.count}  (eligible-pool at ilvl ${SWEEP_MAX_ILVL}: ${pool.count} affixes, weight sum ${pool.weightSum})`);
      }
    }
    if (a1SoftWarn) {
      a1Lines.push(`${rare.length} of 117 affixes below 25 rolls — rare, not dead (warn, does not fail the gate):`);
      for (const r of rare) {
        const pool = eligiblePoolInfo(r, SWEEP_MAX_ILVL);
        a1Lines.push(`  ${r.id.padEnd(24)} alvl ${r.alvl}  weight ${r.weight}  applies ${r.appliesTo.join('/')}  seen ${r.count}  (eligible-pool at ilvl ${SWEEP_MAX_ILVL}: ${pool.count} affixes, weight sum ${pool.weightSum})`);
      }
    }
    checks.push({ id: 'A1', severity: 'fail', scope: 'sweep', profileName: 'sweep', pass: a1Pass, softWarn: a1SoftWarn, lines: a1Lines });

    const a2Pass = !dominant || dominant.share <= 0.04;
    const a2Lines = [`most-rolled affix: ${dominant ? dominant.id : 'n/a'}  share ${dominant ? pctStr(dominant.share * 100) : '0%'}  (cap 4.0%)`];
    checks.push({ id: 'A2', severity: 'fail', scope: 'sweep', profileName: 'sweep', pass: a2Pass, lines: a2Lines });
  } else {
    checks.push({ id: 'A1', severity: 'fail', scope: 'sweep', pass: null, lines: ['NOT RUN — sweep profile was not selected (--profile excluded it)'] });
    checks.push({ id: 'A2', severity: 'fail', scope: 'sweep', pass: null, lines: ['NOT RUN — sweep profile was not selected (--profile excluded it)'] });
  }

  // -- A3-A8 — zero tolerance, combined across every profile run ------------
  {
    const totals = { a3: 0, a4: 0, a5: 0, a6: 0, a7: 0, a8: 0 };
    let totalAffixInstances = 0;
    for (const name of profilesToRun) {
      const { stats } = perProfile[name];
      for (const k of Object.keys(totals)) totals[k] += stats[k];
      totalAffixInstances += stats.totalAffixInstances;
    }
    for (const [id, key] of [['A3', 'a3'], ['A4', 'a4'], ['A5', 'a5'], ['A6', 'a6'], ['A7', 'a7'], ['A8', 'a8']]) {
      const violations = totals[key];
      const pass = violations === 0;
      checks.push({ id, severity: 'fail', scope: 'combined (profiles run)', pass, lines: [`violations: ${violations}  (over ${totalAffixInstances} AffixInstances)`] });
    }
  }

  // -- B1/B2 — sweep only ----------------------------------------------------
  if (perProfile.sweep) {
    const { stats } = perProfile.sweep;
    const missing = [];
    let minCount = Infinity;
    for (let i = 0; i < EQUIPMENT_BASES.length; i++) {
      const c = stats.baseCounts[i];
      if (c < 40) missing.push({ id: EQUIPMENT_BASES[i].id, count: c });
      if (c < minCount) minCount = c;
    }
    const b1Pass = missing.length === 0;
    const b1Lines = [`61 equipment bases checked; minimum observed count ${minCount}`];
    if (!b1Pass) for (const m of missing) b1Lines.push(`  ${m.id.padEnd(28)} seen ${m.count}`);
    checks.push({ id: 'B1', severity: 'fail', scope: 'sweep', profileName: 'sweep', pass: b1Pass, lines: b1Lines });

    const expectedPct = { weapon: 30.0, chest: 12.0, helm: 11.0, gloves: 9.5, boots: 9.5, ring: 9.0, belt: 8.5, shield: 6.5, amulet: 4.0 };
    let b2Pass = true;
    const b2Lines = [`${stats.groupTotalAtHighIlvl} rolls at ilvl>=27`];
    for (const g of BASE_GROUPS) {
      const observed = stats.groupTotalAtHighIlvl > 0 ? (stats.groupCountsAtHighIlvl[g.id] / stats.groupTotalAtHighIlvl) * 100 : 0;
      const dev = observed - expectedPct[g.id];
      const ok = Math.abs(dev) <= 1.0;
      if (!ok) b2Pass = false;
      b2Lines.push(`  ${g.id.padEnd(8)} observed ${pctStr(observed).padStart(9)}  expected ${expectedPct[g.id].toFixed(1)}%  dev ${dev >= 0 ? '+' : ''}${dev.toFixed(3)}  tol ±1.0  ${ok ? 'ok' : 'OVER'}`);
    }
    checks.push({ id: 'B2', severity: 'warn', scope: 'sweep, ilvl>=27', profileName: 'sweep', pass: b2Pass, lines: b2Lines });
  } else {
    checks.push({ id: 'B1', severity: 'fail', scope: 'sweep', pass: null, lines: ['NOT RUN — sweep profile was not selected'] });
    checks.push({ id: 'B2', severity: 'warn', scope: 'sweep', pass: null, lines: ['NOT RUN — sweep profile was not selected'] });
  }

  // -- L1 — every slot fillable by level N -----------------------------------
  //
  // Coordinator ruling: `04-items.md` §1.7 (outside this ticket's assigned
  // read range) is the settling text — it fixes `amulet_cord` at reqLevel
  // 6 and states in prose "all ten [slots are fillable] by level 6." L1's
  // own N set starts at 5, one level short of that guarantee, so
  // `(N=5, amulet)` is not a bug in the roll pipeline — the CATALOGUE
  // itself has no legal amulet base below reqLevel 6, which
  // `MIN_REQ_LEVEL_FOR_SLOT` (derived from the base catalogue at runtime,
  // never hard-coded to "amulet") already proves. A cell whose lowest
  // legal `reqLevel` exceeds `N` is therefore reported UNREACHABLE — still
  // printed in full, citing §1.7, but it does NOT fail the gate and does
  // NOT change the exit code. A cell that IS reachable (`minReqLevel<=N`)
  // and still produced zero magic-or-better items in the sample is the
  // case §1.7 actually cares about, and stays a hard FAIL.
  {
    const { results, dropsPerLevel } = l1Results;
    const zeros = results.filter((r) => r.count === 0);
    const trueFails = zeros.filter((r) => !r.unreachable);
    const unreachableCells = zeros.filter((r) => r.unreachable);
    const pass = trueFails.length === 0;
    const lines = [`${L1_LEVELS.length} levels x ${SLOT_ORDER.length} slots, ${dropsPerLevel} rollItem draws each`];
    for (const r of trueFails) {
      lines.push(`  (N=${r.n}, ${r.slot})  0 magic+ in ${dropsPerLevel} drops   lowest reqLevel = ${r.minReqLevel}   FAIL`);
    }
    for (const r of unreachableCells) {
      lines.push(`  (N=${r.n}, ${r.slot})  0 magic+ in ${dropsPerLevel} drops   lowest reqLevel = ${r.minReqLevel}   UNREACHABLE (04 §1.7: no base for this slot has reqLevel <= ${r.n}; does not fail the gate)`);
    }
    checks.push({ id: 'L1', severity: 'fail', scope: `dedicated (${dropsPerLevel} drops x 6 levels)`, pass, softWarn: unreachableCells.length > 0, lines });
  }

  // -- L2/L3 — reqStr/reqDex vs. the class table -----------------------------
  {
    const pass = slotReq.l2Violations.length === 0;
    const lines = [`${slotReq.checked} equipment bases checked`];
    for (const v of slotReq.l2Violations) lines.push(`  ${v.id.padEnd(28)} reqLevel ${v.reqLevel}  ${v.stat}=${v[v.stat]}  bound=${v.bound}  FAIL`);
    checks.push({ id: 'L2', severity: 'fail', scope: 'catalogue (static)', pass, lines });
  }
  {
    const pass = slotReq.l3Violations.length === 0;
    const lines = [`${slotReq.checked} equipment bases checked (advisory)`];
    for (const v of slotReq.l3Violations) lines.push(`  ${v.id.padEnd(28)} reqLevel ${v.reqLevel}  ${v.stat}=${v[v.stat]}  bound=${v.bound}  warn`);
    checks.push({ id: 'L3', severity: 'warn', scope: 'catalogue (static)', pass, lines });
  }

  // -- U1/U2 — sweep only -----------------------------------------------------
  //
  // Coordinator ruling: same reasoning as A1 above. `last_syllable`
  // (dropWeight 4 of 56, reqLevel 25 — the rarest AND highest-gated
  // unique) reads below 30 at 200 000 drops uniform over ilvl 1..40 and
  // clears 30 at 1 000 000 — its own D6 weight was independently verified
  // during ITEM-7's acceptance (worst deviation across all eight uniques:
  // 0.282pp). It is rare, not broken. U1 hard-fails only at a genuine
  // zero; 1-29 is a non-fatal `softWarn` — magnitude is U2's job (±0.15pp
  // on unique share), not U1's.
  if (perProfile.sweep) {
    const { stats } = perProfile.sweep;
    const missingZero = [];
    const rare = [];
    for (let i = 0; i < UNIQUES.length; i++) {
      const count = stats.uniqueCounts[i];
      const u = UNIQUES[i];
      if (count === 0) missingZero.push({ id: u.id, count, dropWeight: u.dropWeight, reqLevel: u.reqLevel });
      else if (count < 30) rare.push({ id: u.id, count, dropWeight: u.dropWeight, reqLevel: u.reqLevel });
    }
    const u1Pass = missingZero.length === 0;
    const u1SoftWarn = rare.length > 0;
    const u1Lines = [`8 uniques checked over ${stats.uniqueTotalEquip} equipment rolls in sweep`];
    if (!u1Pass) {
      u1Lines.push(`${missingZero.length} of 8 uniques NEVER rolled — genuinely dead (hard fail):`);
      for (const m of missingZero) u1Lines.push(`  ${m.id.padEnd(22)} dropWeight ${m.dropWeight}  reqLevel ${m.reqLevel}  seen ${m.count}`);
    }
    if (u1SoftWarn) {
      u1Lines.push(`${rare.length} of 8 uniques below 30 rolls — rare, not dead (warn, does not fail the gate):`);
      for (const r of rare) u1Lines.push(`  ${r.id.padEnd(22)} dropWeight ${r.dropWeight}  reqLevel ${r.reqLevel}  seen ${r.count}`);
    }
    checks.push({ id: 'U1', severity: 'fail', scope: 'sweep', profileName: 'sweep', pass: u1Pass, softWarn: u1SoftWarn, lines: u1Lines });

    // U2 — unique SHARE (per 04 §4.2's D-6 substitution: the observed
    // fraction of ALL equipment rolls that landed unique) vs. the same R1
    // expected-unique-share this profile already computed.
    const observedShare = stats.equipmentRollCount > 0 ? (stats.rarityObserved.unique / stats.equipmentRollCount) * 100 : 0;
    const expectedShare = stats.equipmentRollCount > 0 ? (stats.rarityExpectedSum.unique / stats.equipmentRollCount) * 100 : 0;
    const dev = observedShare - expectedShare;
    const u2Pass = Math.abs(dev) <= 0.15;
    checks.push({
      id: 'U2', severity: 'fail', scope: 'sweep', profileName: 'sweep', pass: u2Pass,
      lines: [`unique share observed ${pctStr(observedShare)}  expected ${pctStr(expectedShare)}  dev ${dev >= 0 ? '+' : ''}${dev.toFixed(3)}  tol ±0.15`],
    });
  } else {
    checks.push({ id: 'U1', severity: 'fail', scope: 'sweep', pass: null, lines: ['NOT RUN — sweep profile was not selected'] });
    checks.push({ id: 'U2', severity: 'fail', scope: 'sweep', pass: null, lines: ['NOT RUN — sweep profile was not selected'] });
  }

  // -- G1 — gold formula, direct rollGold sampling ---------------------------
  {
    const pass = g1Results.every((r) => r.pass);
    const lines = [];
    for (const r of g1Results) {
      lines.push(`  ${r.profile.padEnd(6)} mlvl ${String(r.mlvl).padStart(2)}  rank ${r.rank.padEnd(9)} observed ${r.observedMean.toFixed(2).padStart(9)}  expected ${r.expectedMean.toFixed(2).padStart(9)}  dev ${r.devPct.toFixed(3)}%  tol ±2.0%  ${r.pass ? 'ok' : 'FAIL'}`);
    }
    checks.push({ id: 'G1', severity: 'fail', scope: 'direct rollGold sample (5 profiles x their ranks)', pass, lines });
  }

  // -- G2 — mean itemValue non-decreasing across the four mlvl bands --------
  if (perProfile.sweep) {
    const band = checkBandValue(perProfile.sweep.stats);
    const bandNames = ['1-9', '10-19', '20-29', '30-40'];
    const lines = band.means.map((m, i) => `  band ${bandNames[i]}  n=${band.counts[i]}  mean baseValue=${m === null ? 'n/a' : m.toFixed(1)}`);
    checks.push({ id: 'G2', severity: 'fail', scope: 'sweep (baseValue proxy — see report)', profileName: 'sweep', pass: band.pass, lines });
  } else {
    checks.push({ id: 'G2', severity: 'fail', scope: 'sweep', pass: null, lines: ['NOT RUN — sweep profile was not selected'] });
  }

  // -- D1 — determinism (SHA-256 over the serialised item stream) -----------
  for (const name of profilesToRun) {
    const { sha256 } = perProfile[name];
    checks.push({
      id: 'D1', severity: 'fail', scope: name, profileName: name, pass: true,
      lines: [`sha256(item stream) = ${sha256}  (verify: run this tool twice at the same --seed and diff)`],
    });
  }

  // -- D2 — draw-count determinism + the §9.2 accounting cross-check --------
  for (const name of profilesToRun) {
    const recon = accountingPerProfile[name];
    const pass = recon.accountingMismatches === 0;
    const lines = [`total draws this profile consumed: ${perProfile[name].totalDraws} (verify: identical across two runs at the same seed)`];
    lines.push(`reconstruction sample: ${recon.accountingChecked} calls checked, ${recon.accountingMismatches} accounting mismatches`);
    if (!pass) for (const m of recon.mismatchSamples) lines.push(`  ${JSON.stringify(m)}`);
    checks.push({ id: 'D2', severity: 'fail', scope: name, profileName: name, pass, lines });
  }

  // -- N1 — structural rare-name invariant, combined across profiles run ----
  {
    let violations = 0;
    let n = 0;
    for (const name of profilesToRun) {
      const { stats } = perProfile[name];
      violations += stats.rareShapeViolations;
      n += stats.rareEquipCount;
    }
    checks.push({ id: 'N1', severity: 'fail', scope: 'combined (profiles run)', pass: violations === 0, lines: [`${n} rares checked, ${violations} structural violations`] });
  }

  // -- N2 — the ring invariant (hard fail, per profile) + statistical ceiling
  {
    let ringViolations = 0;
    const perProfileRing = [];
    for (const name of profilesToRun) {
      const { stats } = perProfile[name];
      if (name === 'sweep') {
        const v = checkRingWindow(stats.rareCodesInOrder);
        ringViolations += v;
        perProfileRing.push(`  sweep: ${stats.rareCodesInOrder.length} rares, ${v} 64-window violations`);
      }
    }
    const pass = ringViolations === 0 && n2Stat.pass;
    const lines = [...perProfileRing, `statistical ceiling: P(>=1 repeat in 100, fresh ring) = ${(n2Stat.rate * 100).toFixed(2)}% over ${n2Stat.trials} trials (ceiling 40%, D-25 predicts ~21.9%)`];
    if (ringViolations > 0) lines.push(`RING INVARIANT VIOLATED: ${ringViolations} repeats inside a 64-window — HARD FAIL`);
    if (!n2Stat.pass) lines.push('statistical ceiling exceeded (warn-grade per ruling 5, does not change exit code on its own)');
    checks.push({ id: 'N2', severity: ringViolations > 0 ? 'fail' : 'warn', scope: 'sweep ring + global statistical sample', pass, lines });
  }

  return checks;
}

// ============================================================================
// Rendering
// ============================================================================

/**
 * A check's displayed verdict, in one place, so the human/JSON renderers
 * and the pass/fail/warn tallies can never drift apart.
 *
 * Coordinator ruling (A1/U1/L1): existence and magnitude are checked by
 * different assertions, so a check's own HARD criterion (`pass`) can be
 * true while it still has something non-fatal worth printing (`softWarn`)
 * — e.g. an affix seen 6 times in 200 000 drops has not "stopped
 * existing" (A1's own §10.2 wording), so it is not a FAIL, but it is rare
 * enough to be worth a human's attention, so it is not silently dropped
 * either. `softWarn` NEVER flips `pass` and never changes the exit code
 * (rule 3: "a warn never changes the exit code but always prints") — it
 * only changes which word is printed next to an already-passing check.
 * @param {{pass: boolean|null, severity: 'fail'|'warn', softWarn?: boolean}} c
 * @returns {'SKIP'|'FAIL'|'warn'|'ok'|'PASS'}
 */
function verdictOf(c) {
  if (c.pass === null) return 'SKIP';
  if (c.pass === false) return c.severity === 'warn' ? 'warn' : 'FAIL';
  return c.softWarn ? 'warn' : c.severity === 'warn' ? 'ok' : 'PASS';
}

/** Renders one group's checks (a profile's own list, or one global scope's
 * list) as human-readable lines, given a precomputed verdict per check. */
function renderCheckLines(out, groupChecks, verdictOfMap) {
  for (const c of groupChecks) {
    const verdict = verdictOfMap.get(c);
    out.push(`  ${c.id}  ${verdict.padStart(45 - c.id.length)}`);
    for (const line of c.lines) out.push(`        ${line}`);
    out.push('');
  }
}

function renderHuman(checks, meta) {
  const out = [];
  const verdicts = checks.map(verdictOf);
  const verdictOfMap = new Map(checks.map((c, i) => [c, verdicts[i]]));
  const failedCount = verdicts.filter((v) => v === 'FAIL').length;
  const warnedCount = verdicts.filter((v) => v === 'warn').length;
  const passedCount = verdicts.filter((v) => v === 'PASS' || v === 'ok').length;
  const notRunCount = verdicts.filter((v) => v === 'SKIP').length;

  out.push(`lootsim  seed=0x${meta.seed.toString(16)}  drops=${meta.drops}  profiles=${meta.profilesToRun.length}${failedCount > 0 ? `            FAILED (${failedCount})` : '            PASSED'}`);
  out.push('');

  const { profiles, globalChecks } = groupChecksByProfile(checks, meta.profilesToRun, meta.countedDropsByProfile);

  // Profiles first, in `04` §10.1 order, each under its own §10.3-shaped
  // header carrying the ACTUAL COUNTED drop total (coordinator round 3).
  for (const p of profiles) {
    out.push(`  ${profileHeaderLine(p.name, p.drops)}`);
    out.push('  ' + '─'.repeat(70));
    renderCheckLines(out, p.checks, verdictOfMap);
  }

  // Then the dedicated/global/catalogue scopes, grouped exactly as before.
  let lastScope = null;
  for (const c of globalChecks) {
    if (c.scope !== lastScope) {
      out.push(`  ${c.scope}`);
      out.push('  ' + '─'.repeat(70));
      lastScope = c.scope;
    }
    renderCheckLines(out, [c], verdictOfMap);
  }

  out.push('  ' + '─'.repeat(70));
  out.push(`  ${passedCount} checks passed · ${failedCount} failed · ${warnedCount} warning${warnedCount === 1 ? '' : 's'}${notRunCount > 0 ? ` · ${notRunCount} not run` : ''} · ${meta.totalCountedDrops} drops · ${meta.seconds.toFixed(2)} s`);
  return out.join('\n');
}

function renderJson(checks, meta) {
  const verdicts = checks.map(verdictOf);
  const verdictOfMap = new Map(checks.map((c, i) => [c, verdicts[i]]));
  const statusWord = { SKIP: 'skip', FAIL: 'fail', warn: 'warn', ok: 'ok', PASS: 'pass' };
  const toJsonCheck = (c) => ({ id: c.id, status: statusWord[verdictOfMap.get(c)], detail: c.lines.join(' | ') });

  const { profiles, globalChecks } = groupChecksByProfile(checks, meta.profilesToRun, meta.countedDropsByProfile);
  const profilesJson = profiles.map((p) => ({ name: p.name, drops: p.drops, checks: p.checks.map(toJsonCheck) }));

  // Global/dedicated scopes go under a SIBLING key, never inside
  // `profiles` (`04` §10.3 rule 4: "profiles means the profiles" —
  // coordinator round 3 point 5).
  const byScope = Object.create(null);
  for (const c of globalChecks) {
    if (!byScope[c.scope]) byScope[c.scope] = { name: c.scope, checks: [] };
    byScope[c.scope].checks.push(toJsonCheck(c));
  }

  const failed = verdicts.filter((v) => v === 'FAIL').length;
  const warned = verdicts.filter((v) => v === 'warn').length;
  const passed = verdicts.filter((v) => v === 'PASS' || v === 'ok').length;
  return JSON.stringify({
    seed: `0x${meta.seed.toString(16)}`,
    drops: meta.drops,
    totalDrops: meta.totalCountedDrops,
    profiles: profilesJson,
    global: Object.values(byScope),
    passed, failed, warned,
    seconds: meta.seconds,
  }, null, 2);
}

// ============================================================================
// CLI driver
// ============================================================================

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    printHelp();
    process.exit(2);
  }
  if (args.help) { printHelp(); process.exit(0); }

  const profilesToRun = args.profile ? [args.profile] : PROFILE_ORDER;
  for (const p of profilesToRun) {
    if (!PROFILE_DEFS[p]) {
      process.stderr.write(`error: unknown profile '${p}' (one of ${PROFILE_ORDER.join(',')})\n`);
      process.exit(2);
    }
  }

  const t0 = process.hrtime.bigint();

  const perProfile = Object.create(null);
  for (const name of profilesToRun) {
    perProfile[name] = { ...runProfile(name, args.drops, args.seed), drops: args.drops };
  }

  const r1PerProfile = Object.create(null);
  for (const name of profilesToRun) {
    r1PerProfile[name] = runR1Sample(name, args.drops, (args.seed ^ 0x71001) >>> 0);
  }

  const accountingSampleSize = Math.min(args.drops, 6000);
  const accountingPerProfile = Object.create(null);
  for (const name of profilesToRun) {
    accountingPerProfile[name] = runAccountingSample(name, (args.seed ^ 0x5eed01) >>> 0, accountingSampleSize);
  }
  const nodropBuckets = runNodropSample((args.seed ^ 0x5eed02) >>> 0, args.drops);

  const l1Results = checkSlotFillable((args.seed ^ 0x11) >>> 0, args.drops);
  const slotReq = checkSlotRequirements();
  const g1Results = checkGold((args.seed ^ 0x6001) >>> 0, args.drops);
  const n2Stat = checkN2Statistical(args.seed >>> 0, args.drops);

  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;

  const checks = buildChecks({ profilesToRun, perProfile, r1PerProfile, accountingPerProfile, nodropBuckets, l1Results, slotReq, g1Results, n2Stat, drops: args.drops });

  // The workload proof (coordinator round 3): COUNTED, not configured —
  // `stats.totalDrops` is the same counter S1 checks above, read here for
  // the header lines and the summary line's own drop total.
  const countedDropsByProfile = Object.create(null);
  for (const name of profilesToRun) countedDropsByProfile[name] = perProfile[name].stats.totalDrops;
  const totalCountedDrops = profilesToRun.reduce((sum, name) => sum + countedDropsByProfile[name], 0);

  const meta = { seed: args.seed >>> 0, drops: args.drops, profilesToRun, seconds, countedDropsByProfile, totalCountedDrops };

  if (args.json) {
    process.stdout.write(renderJson(checks, meta) + '\n');
  } else {
    process.stdout.write(renderHuman(checks, meta) + '\n');
  }

  const anyFail = checks.some((c) => c.severity === 'fail' && c.pass === false);
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`lootsim: fatal error: ${err.stack || err.message}\n`);
  process.exit(2);
});
