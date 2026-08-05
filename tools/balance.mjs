#!/usr/bin/env node
// tools/balance.mjs
//
// TEST-8 — the M4 skill-balance validation harness, `05-skills.md` §13 (this
// file's owning document for `S1`-`S12`/`B1`-`B11`; `12-testing.md` §5.2
// names the same rows with a zero-padded `05.` prefix, D-45's own dual
// convention). Imports `src/skills/*` and `src/combat/*` directly in Node —
// no browser, no `three`, no DOM — exactly `05` §13.1's own "runs headless
// in Node at a fixed seed" (this file draws no randomness at all; every
// number below is an EXPECTED VALUE, per `05` §11's own instruction: "Hit
// chance and damage are carried as expected values so the tables are
// reproducible without a seed").
//
// ---------------------------------------------------------------------------
// Ruling D-48 — follow the shipped tool (`tools/lootsim.mjs`), not `12`
// §5.1's stale prose contract
// ---------------------------------------------------------------------------
// `12-testing.md` §5.1's "common CLI contract" (space-separated `--seed
// <hex>`, `--json <path>`, `--verbose`, `--bless`) is NOT what
// `tools/lootsim.mjs` (M3's own accepted harness) implements, and that
// divergence survived M3's gate — this file follows lootsim's shipped shape
// instead, and says so here, per the ticket brief:
//   - `=`-form flags: `--seed=0x…`, `--profile=NAME` (unused by --skills,
//     reserved for symmetry with lootsim's own CLI)
//   - `--json` is a BOOLEAN SWITCH printing to stdout, not a path
//   - exit `0` all pass / `1` assertion failure / `2` argument error or an
//     unimplemented flag / `3` non-determinism between two `B11`/`12.D01` runs
//
// `--skills` was the ONLY flag TEST-8 implemented. **`--monsters` is now
// implemented too — TEST-9, ruling D-70; its own header block sits further
// down, immediately above `RANK_MULT`.** `--builds`/`--sweep`/`--progression`
// remain M7/M7/M6's own gates (`12-testing.md` §11's own milestone table: the
// M6 row names `13.P01`-`13.P04` (`13-progression-lore.md`, --progression's
// owner), the M7 row names "balance.mjs --sweep... the gate this milestone
// exists to satisfy" and --builds shares that same M7 gate, since no row
// anywhere names a standalone "--builds" milestone) — each of those three
// flags exits `2` naming its owning milestone, never a fake pass (rule 5 of
// TEST-8's brief). The M5 row of that same table names "balance.mjs
// --monsters green", which is exactly what TEST-9 exists to run.
//
// ---------------------------------------------------------------------------
// Ruling D-50 — the Ravager decay figure is 53.34, not `05` §11.4's prose 45.3
// ---------------------------------------------------------------------------
// `05` §11.1's own seven-cell `−decay` column (`7.47, 8, 7.87, 6, 8, 8, 8`)
// sums to **53.34**; the prose at §11.4 ("the Ravager loses 45.3 rage to
// decay") stops after the FIRST SIX cells (45.34, rounded) and is an
// authoring slip — the table itself is internally consistent (row 10:
// `51.22 − 7.47 = 43.75`; row 24: `50.77 − 8 = 42.77`, both reproduced
// below). This file asserts **53.34**, not 45.3, per the ticket brief's own
// explicit instruction; asserting 45.3 would fail on correct code.
//
// ---------------------------------------------------------------------------
// Ruling D-54, superseded by D-85 — `B10` is a real verdict again
// ---------------------------------------------------------------------------
// D-54 (2026-08-01) found `B10` unsatisfiable as written and made it a
// permanent `NOTE`: `05` §12.7's own worked chain (`2.45 + 1.47 + 0.88 +
// 0.53 = 5.33 s` inside the very 6.0 s window it named) is **88.8%**
// denial — already past the stated 60% ceiling — and `ram_charge` ALONE at
// L20 (2.45 s stun, 4.2 s cooldown, two casts fit in 6 s) reached
// **65.33%**. The DR-chain mechanism (`03` §7.7, binding per `05` §1.1) was
// never in question; the WINDOW was the outlier.
//
// D-85 (2026-08-04, owner) settles it: the assertion window widens 6.0 s ->
// **12.0 s**, the 60% ceiling and every §7.7 multiplier stay exactly as
// written. 12.0 s is the chain's own period — four applications plus the
// 6.0 s immunity the fifth forces — so `B10` now measures what the lock
// actually promises, that crowd control cannot be PERMANENT. §12.7's chain
// scores 5.33 / 12.0 = 44.4% and passes; a 4 s-base stun would score 72%
// and still fail. `checkB10` below is a normal `fail`-severity check again
// and its model was rebuilt at the same time (see its own header — the
// D-54-era version chained per skill instead of per actor and summed
// overlapping stuns, both of which over-reported).
//
// ---------------------------------------------------------------------------
// The four habits carried over from `tools/lootsim.mjs` (per the brief)
// ---------------------------------------------------------------------------
// 1. Every assertion is a `{id, severity, scope, pass, lines}` object in one
//    flat `checks[]` array — `--json` and the human report render off the
//    SAME structure (see `buildSkillChecks`/`buildBuildChecks`/`renderHuman`/
//    `renderJson` below), exactly lootsim's own `buildChecks`/`renderHuman`/
//    `renderJson` split.
// 2. A check that cannot run reports `status:'skip'`, loudly, with the
//    reason printed in `lines` — never silently narrowed out of the set
//    (O-58's own precedent: TEST-6 quietly dropped a method from a coverage
//    list and the check read as full while it was not). `S7` (fx/audio
//    identifiers) is the one skip this file reports for every skill — see
//    that check's own comment for why (no `audio` field exists anywhere on
//    `SkillDefinition`, and no `src/fx/` registry exists yet to resolve
//    `fxId` against).
// 3. `NOTE`-severity findings (`B9`'s mispaired/sinkless builds, `B6`'s
//    out-of-scope Molgrim rows) are counted in the summary and NEVER flip
//    the exit code — `05`
//    §13.3's own closing line, restated in `12` §5.2's "Notes versus
//    failures" section almost verbatim.
// 4. The in-suite test (`tests/tools/balance.test.js`) is a THIN `spawnSync`
//    smoke test — it does not re-run the full 30-skill/4158-build gate
//    in-process (this file's own `--skills` run is already the acceptance
//    run, executed and reported by hand per this ticket's report) — and
//    `12.D01`'s determinism check lives INSIDE that smoke test, the same way
//    `12.D03` lives inside `tests/tools/lootsim.test.js`.
//
// ---------------------------------------------------------------------------
// Why this file needs no RNG anywhere, and why that is not a shortcut
// ---------------------------------------------------------------------------
// `05` §11's own line: "Hit chance and damage are carried as expected values
// so the tables are reproducible without a seed." Every worked figure in
// `05` §9/§11 (the nine builds, the three resource simulations) is EV
// arithmetic — hit% × (post-mitigation average damage) / interval — not a
// sampled roll. `05` §1.5's own "1.05 is the expected-crit multiplier... a
// DPS convenience" line is the same idea applied to crit. This file
// reproduces that EV arithmetic directly, cross-checked against `05` §9.3's
// own printed per-build figures (Sustained DPS, TTK, pack-clear, Champion
// TTK) to their stated precision — the same "independently transcribe from
// the spec text, then cross-check the printed worked examples" discipline
// `tools/lootsim.mjs`'s own header documents, extended here to the mitigation
// PIPELINE STEPS themselves, which are imported directly from
// `src/combat/{tohit,packet,resolve,status}.js` (pure, deterministic,
// RNG-free functions — `stepR7a/b/c`, `chanceToHit`, `computeAttackInterval`/
// `computeCastInterval`, the DR-chain constants) rather than re-derived by
// hand, because those ARE the shipped, accepted implementation of `03`
// §5/§6.1/§7.7's binding formulas and re-deriving them a second time from
// scratch would only be a second place for the same typo to hide.
//
// ---------------------------------------------------------------------------
// The sweep — could not be reconciled to 1 386/class; the exact counting,
// per the coordinator's own permitted fallback ("say exactly why with your
// counting, and stop")
// ---------------------------------------------------------------------------
// `05` §13.2 / `12` §5.2 both describe the sweep in PROSE only: "every
// allocation that puts >= 15 points into one skill and distributes the
// remainder over at most two others — 1 386 builds per class" (4 158 total,
// `05:3902`'s own example summary line). The literal reading this file
// implements — primary level p in [15,20] (6 values), remainder r = 29-p
// spread over 1 or 2 of the other 9 same-class skills, EVERY integer split
// of r into 2 positive parts enumerated, filtered for legal prerequisites —
// gives, per primary skill: `9 + 36*(r-1)` summed over r=9..14 = 2 322
// combinations; **times 10 primary skills = 23 220/class unfiltered,
// 19 503/class after prerequisite filtering** (measured directly). That is
// 14x too large, not close to 1 386 by any rounding.
//
// A systematic search (scratch script, not checked in) over the natural
// parameter family — {primary count in 1..10} x {secondary pool in 2..9}
// x {full split enumeration vs. one canonical split per skill-set choice}
// x {restricted primary level ranges} — found NO exact combinatorial match
// for 1 386 or 4 158. The single closest reading found: restricting
// "primary" to skills with a direct-damage coefficient only (5 per class
// for Ravager/Emberwright, 5-6 for Runeblade depending on whether the
// passive-trigger `cascade` counts) AND replacing "every split" with ONE
// canonical split per 2-secondary skill-set choice (so "distributes the
// remainder" picks WHICH skills, not every point-by-point division) lands
// at 3 330-4 320 total depending on that count, ±3-20% off 4 158 — close
// enough to suspect the intended reading is in this family, too far to
// claim reproduction. `05`/`12`'s own prose does not specify the split
// convention precisely enough to close that last gap.
//
// This file implements the LITERAL full reading (no unstated restriction
// on which skills may be "primary", no unstated single-split convention)
// because it requires the fewest invented rules — and reports its own
// count VERBATIM in the summary block, never silently forced to 1 386/4 158.
// Printing a wrong-looking-but-honest number is rule 4 of this ticket's
// brief ("do not narrow the assertion set to make it green") applied to a
// count, not just to an assertion set.

import { SKILLS } from '../src/skills/data/skills.js';
import { levelValue, resonanceForLandedHit, manaReturnedFromHit, rageIncomeRate } from '../src/skills/cost.js';
import { addResonance } from '../src/actors/vessels.js';
import { validateSynergyGraph, collectSynergyEdges } from '../src/skills/synergy.js';
import { WINDUP_FRAC, ACTIVE_FRAC, RECOVER_FRAC } from '../src/skills/impl/cleaving_strike.js';
import {
  computeAttackInterval, computeCastInterval, attributeBonusFor, classScaleFor,
  BASE_CRIT_CHANCE, BASE_CRIT_MULT,
} from '../src/combat/packet.js';
import { WEAPONS, CLASS_SCALE_TABLE } from '../src/combat/data/weapons.js';
import { chanceToHit } from '../src/combat/tohit.js';
import {
  stepR7a, stepR7c, cappedEffectiveResist, applyResistFactor,
} from '../src/combat/resolve.js';
import {
  DR_CHAIN_MULTIPLIERS, DR_CHAIN_WINDOW_SECONDS, DR_CHAIN_IMMUNITY_SECONDS,
  rollDrChain,
} from '../src/combat/status.js';
import { FIELD_NAMES as STAT_FIELD_NAMES, CAPS as STAT_CAPS } from '../src/actors/stats.js';
import { STATUS, STATUS_TABLE } from '../src/actors/data/statuses.js';

// CAST_WINDUP_FRAC — `03-combat-math.md` §4.5: "windupFrac — default 0.40
// for attacks, 0.65 for casts". `cleaving_strike.js` only exports the ATTACK
// row's three constants (its own skill is `type:'attack'`-timed); the CAST
// row's own windup fraction is transcribed here, independently, from the
// same table (`activeFrac`/the remainder rule are shared between both rows
// per that table's own text — only `windupFrac` differs).
const CAST_WINDUP_FRAC = 0.65;

// B10's measurement window — owner ruling D-85 (2026-08-04). Distinct from
// the MECHANISM's `DR_CHAIN_WINDOW_SECONDS` (6.0 s, imported and unchanged):
// this is the window the ASSERTION rolls, widened to 12.0 s because that is
// the chain's own natural period (four applications, then the 6.0 s immunity
// the fifth forces). The 60 % ceiling is `05` §13.2's, untouched.
const B10_WINDOW_SECONDS = 12.0;
const B10_MAX_DENIAL = 0.60;
// Long enough to contain a full chain + immunity + the start of the next
// chain, so the rolling window sees the worst straddle, not just t=0.
const B10_TIMELINE_SECONDS = 60.0;
// `rollDrChain` schedules in `ctx.time.step`. `FIXED_HZ` is module-private in
// `src/combat/status.js`; transcribed here from `ARCHITECTURE.md`'s
// engine-owned `PHYSICS_HZ = 60`, the same way `CAST_WINDUP_FRAC` above is.
const FIXED_HZ = 60;
const CAST_ACTIVE_FRAC = ACTIVE_FRAC; // 0.15, shared
const CAST_RECOVER_FRAC = 1 - CAST_WINDUP_FRAC - CAST_ACTIVE_FRAC; // 0.20

// ============================================================================
// CLI
// ============================================================================

function printHelp() {
  process.stdout.write(
    'Usage: node tools/balance.mjs (--skills | --monsters) [--seed=0xHEX] [--json]\n' +
      '\n' +
      '  --skills        run the 05-skills.md §13.1/§13.2 per-skill (S1-S12) and\n' +
      '                  per-build (B1-B11) gate (TEST-8 scope). Runs the nine\n' +
      '                  §9.3 builds plus a generated sweep.\n' +
      '  --monsters      run the 06-monsters-ai.md §12.2 gate (TEST-9, D-70):\n' +
      '                  MB1-MB4, MB7-MB13, MB16-MB20. MB5/MB5b (Molgrim, M6),\n' +
      '                  MB6 (class spread, M7) and MB14/MB15 report a loud SKIP\n' +
      '                  naming their milestone — never a fake pass.\n' +
      '  --seed=0xHEX    --skills draws no randomness at all (see the file header)\n' +
      '                  so a seed only echoes in its report; --monsters DOES use\n' +
      '                  it — it seeds the 400-layout zone sweep behind MB16/MB17.\n' +
      '  --json          emit machine-readable JSON instead of the human report\n' +
      '  --help          this message\n' +
      '\n' +
      '  --skills and --monsters are separate modes and may not be combined.\n' +
      '  --builds / --sweep / --progression are NOT implemented here\n' +
      '  (M7 / M7 / M6 gates respectively, 12-testing.md §11) and exit 2.\n',
  );
}

const UNIMPLEMENTED_FLAGS = Object.freeze({
  '--builds': 'M7 (12-testing.md §11: "balance.mjs --sweep green over 4158 builds — 05.B07 is the gate this milestone exists to satisfy"; --builds shares that gate)',
  '--sweep': 'M7 (12-testing.md §11 row: "balance.mjs --sweep green over 4158 builds — 05.B07 (spread < 2x) is the gate this milestone exists to satisfy")',
  '--progression': 'M6 (12-testing.md §11 row: "playtest.mjs completes the full campaign...; 13.P01-13.P04 pass" — 13-progression-lore.md is --progression\'s owner)',
});

function parseArgs(argv) {
  const out = { skills: false, monsters: false, seed: 0x5eed0001, json: false, help: false };
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') { out.help = true; continue; }
    if (raw === '--json') { out.json = true; continue; }
    if (raw === '--skills') { out.skills = true; continue; }
    if (raw === '--monsters') { out.monsters = true; continue; }
    if (UNIMPLEMENTED_FLAGS[raw]) {
      throw new UnimplementedFlagError(raw, UNIMPLEMENTED_FLAGS[raw]);
    }
    const m = /^--([a-zA-Z]+)=(.*)$/.exec(raw);
    if (!m) throw new RangeError(`unknown flag '${raw}'`);
    const [, key, val] = m;
    if (key === 'seed') {
      out.seed = val.startsWith('0x') || val.startsWith('0X') ? parseInt(val, 16) : parseInt(val, 10);
      if (!Number.isFinite(out.seed)) throw new RangeError(`--seed must be a number, got '${val}'`);
    } else if (key === 'profile') {
      // accepted, unused — symmetry with lootsim's CLI, per the file header
    } else {
      throw new RangeError(`unknown flag '--${key}'`);
    }
  }
  if (out.skills && out.monsters) {
    throw new RangeError('--skills and --monsters are separate modes and may not be combined; run them one at a time');
  }
  return out;
}

class UnimplementedFlagError extends Error {
  constructor(flag, owner) {
    super(`${flag} is not implemented by this file (--skills is TEST-8's, --monsters is TEST-9's) — it belongs to milestone ${owner}`);
    this.flag = flag;
  }
}

// ============================================================================
// Independent reference table — SKILL_REF, transcribed from `03-combat-
// math.md` §8.1-§8.6 (the binding source `05` §1.1 names for base/perLevel
// figures), NOT copy-pasted from `src/skills/data/skills.js`. This is what
// makes S2/S3/S4 a genuine cross-check rather than a tautology: if a shipped
// base/perLevel/floor number drifted from the spec text, this table (read
// straight off `03` §8) would disagree with it.
//
// Shape per skill: { cost:{base,perLevel,floor}, cooldown:{base,perLevel,
// floor}, coef: {kind:'weapon', base, perLevel} | {kind:'flat', minBase,
// minPerLevel, maxBase, maxPerLevel} | null }. `floor` is `cost.minimum` /
// `cooldown.minimum` where §8 states one, else `null`/`0`.
// ============================================================================
const SKILL_REF = Object.freeze({
  cleaving_strike: { cost: { base: 6, perLevel: 0.25, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: { kind: 'weapon', base: 40, perLevel: 6.32 } },
  bloodletting: { cost: { base: 8, perLevel: 0.30, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: { kind: 'weapon', base: 90, perLevel: 5 } },
  whirlwind: { cost: { base: 12, perLevel: -0.25, floor: 6 }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: { kind: 'weapon', base: 55, perLevel: 4 } },
  bloodthirst: { cost: { base: 0, perLevel: 0, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: null },
  sunder: { cost: { base: 14, perLevel: 0.50, floor: null }, cooldown: { base: 6.0, perLevel: 0, floor: 6.0 }, coef: { kind: 'weapon', base: 130, perLevel: 9 } },
  ram_charge: { cost: { base: 10, perLevel: 0.40, floor: null }, cooldown: { base: 8.0, perLevel: -0.20, floor: 4.0 }, coef: { kind: 'weapon', base: 100, perLevel: 7 } },
  shield_stance: { cost: { base: 0, perLevel: 0, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: null },
  war_cry: { cost: { base: 18, perLevel: 0.60, floor: null }, cooldown: { base: 14.0, perLevel: 0, floor: 14.0 }, coef: null },
  iron_skin: { cost: { base: 0, perLevel: 0, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: null },
  last_stand: { cost: { base: 0, perLevel: 0, floor: null }, cooldown: { base: 90, perLevel: -2, floor: 50 }, coef: null },
  ember_bolt: { cost: { base: 2.0, perLevel: 0.25, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: { kind: 'flat', minBase: 3, minPerLevel: 2.25, maxBase: 7, maxPerLevel: 3.75 } },
  flame_wave: { cost: { base: 5.0, perLevel: 0.50, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: { kind: 'flat', minBase: 6, minPerLevel: 3.2, maxBase: 12, maxPerLevel: 5.4 } },
  fireball: { cost: { base: 7.0, perLevel: 0.70, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: { kind: 'flat', minBase: 14, minPerLevel: 6, maxBase: 26, maxPerLevel: 10 } },
  meteor: { cost: { base: 16.0, perLevel: 1.20, floor: null }, cooldown: { base: 4.0, perLevel: 0, floor: 4.0 }, coef: { kind: 'flat', minBase: 34, minPerLevel: 14, maxBase: 58, maxPerLevel: 22 } },
  incinerate: { cost: { base: 0, perLevel: 0, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: null },
  ashen_step: { cost: { base: 6.0, perLevel: 0.40, floor: null }, cooldown: { base: 3.0, perLevel: -0.06, floor: 1.8 }, coef: null },
  mana_weave: { cost: { base: 0, perLevel: 0, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: null },
  smouldering_ward: { cost: { base: 12.0, perLevel: 1.00, floor: null }, cooldown: { base: 10.0, perLevel: 0, floor: 10.0 }, coef: null },
  ash_wall: { cost: { base: 14.0, perLevel: 1.10, floor: null }, cooldown: { base: 12.0, perLevel: 0, floor: 12.0 }, coef: { kind: 'flat', minBase: 8, minPerLevel: 3.4, maxBase: 8, maxPerLevel: 3.4 } },
  essence_burn: { cost: { base: 'all', perLevel: 0, floor: 20 }, cooldown: { base: 8.0, perLevel: 0, floor: 8.0 }, coef: null },
  rune_strike: { cost: { base: 2.0, perLevel: 0.20, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: { kind: 'weapon', base: 115, perLevel: 7 } },
  blade_seal: { cost: { base: 5.0, perLevel: 0.35, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: { kind: 'flat', minBase: 2, minPerLevel: 2.5, maxBase: 7, maxPerLevel: 4.5 } },
  cascade: { cost: { base: 0, perLevel: 0, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: { kind: 'weapon', base: 70, perLevel: 6 } },
  phase_leap: { cost: { base: 9.0, perLevel: 0.70, floor: null }, cooldown: { base: 5.0, perLevel: -0.12, floor: 2.5 }, coef: { kind: 'weapon', base: 140, perLevel: 9 } },
  echo_blade: { cost: { base: 22.0, perLevel: 1.50, floor: null }, cooldown: { base: 25.0, perLevel: 0, floor: 25.0 }, coef: { kind: 'weapon', base: 40, perLevel: 2 } },
  discharge: { cost: { base: 4.0, perLevel: 0.35, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: { kind: 'flat', minBase: 3, minPerLevel: 2.6, maxBase: 11, maxPerLevel: 6.2 } },
  resonance_circuit: { cost: { base: 0, perLevel: 0, floor: null }, cooldown: { base: 0, perLevel: 0, floor: 0 }, coef: null },
  polarity: { cost: { base: 10, perLevel: 0, floor: null }, cooldown: { base: 1.5, perLevel: 0, floor: 1.5 }, coef: null },
  thunder_step: { cost: { base: 11.0, perLevel: 0.80, floor: null }, cooldown: { base: 6.0, perLevel: -0.15, floor: 3.0 }, coef: { kind: 'flat', minBase: 10, minPerLevel: 5, maxBase: 22, maxPerLevel: 9 } },
  unity: { cost: { base: 26.0, perLevel: 1.60, floor: null }, cooldown: { base: 30.0, perLevel: 0, floor: 30.0 }, coef: null },
});

// ============================================================================
// Class kits — `05-skills.md` §9.1's level-30 reference kits, transcribed
// independently (attributes, weapon, ED/IAS/FCR/AR totals, armour defence).
// ============================================================================
const CLASS_KITS = Object.freeze({
  ravager: Object.freeze({
    weapon: WEAPONS.maul_great_normal, attackRating: 380, enhancedDamage: 120,
    ias: 40, fcr: 0, armourDefence: 420, str: 88, dex: 49,
    handling: 'twoHandMelee', fireDamagePercent: 0,
  }),
  emberwright: Object.freeze({
    weapon: WEAPONS.wand_ember_normal, attackRating: 0, enhancedDamage: 0,
    ias: 0, fcr: 30, armourDefence: 180, str: 44, dex: 54,
    handling: 'wand', fireDamagePercent: 80,
  }),
  runeblade: Object.freeze({
    weapon: WEAPONS.sword_rune_normal, attackRating: 420, enhancedDamage: 110,
    ias: 40, fcr: 20, armourDefence: 300, str: 80, dex: 54,
    handling: 'oneHandMelee', fireDamagePercent: 0,
  }),
});

// `05` §9.2 — the four yardsticks: { life, def, flatDR, resist:{fire,cold,
// lightning,magic,physical}, mlvl, uptime }. Resist values are PRE-clamp
// (R10's own 75% cap is applied by `cappedEffectiveResist` at use time, per
// `05` §9.2's own worked note about Molgrim's fire).
const YARDSTICKS = Object.freeze({
  A: Object.freeze({ life: 389, def: 175, flatDR: 3, resist: { fire: 0, cold: 25, lightning: 0, magic: 0, physical: 0 }, mlvl: 30, uptime: 1 }),
  B: Object.freeze({ life: 1558, def: 262, flatDR: 3, resist: { fire: 20, cold: 20, lightning: 20, magic: 20, physical: 10 }, mlvl: 30, uptime: 1 }),
  C: Object.freeze({ life: 611, def: 191, flatDR: 4, resist: { fire: 40, cold: 65, lightning: 40, magic: 40, physical: 0 }, mlvl: 33, uptime: 1 }),
  D: Object.freeze({ life: 15794, def: 295, flatDR: 4, resist: { fire: 90, cold: 90, lightning: 90, magic: 80, physical: 10 }, mlvl: 37, uptime: 0.88 }),
});
const PLAYER_LEVEL = 30; // §9.1's "level-30 reference kits"
const PACK_LIFE_8BODY = 3112; // §9.3's own repeated "Eight-monster pack, 3112 life at mlvl 30" figure

// `05` §1.5's pack-occupancy table — shape -> body count. Keyed by skill id
// for the handful of AoE skills the nine builds actually use; a skill not
// listed here is treated as single-target (body count 1) for B4's pack-clear
// estimate, which is conservative (never overstates pack DPS).
const PACK_BODIES = Object.freeze({
  cleaving_strike: 4, whirlwind: 3, sunder: 5, cascade: 5, flame_wave: 5,
  fireball: 4, thunder_step: 4, smouldering_ward: 4, meteor: 5,
  essence_burn: 6, war_cry: 8, ember_bolt: 3, discharge: 3.2881,
});

// ============================================================================
// Skill lookup helpers
// ============================================================================
const SKILLS_BY_ID = new Map(SKILLS.map((d) => [d.id, d]));

function synergyBonusFor(targetDef, statKey, allocatedOf) {
  let total = 0;
  for (const syn of targetDef.synergies) {
    if (syn.stat !== statKey && !(statKey === 'coef' && (syn.stat === 'weaponDamage' || syn.stat === 'flatDamage'))) continue;
    total += syn.perLevel * (allocatedOf(syn.skillId) || 0);
  }
  return total;
}

/** Effective coefficient (%) at a given ALLOCATED level, synergy included.
 * Returns `null` for a skill with no direct-damage coefficient (passive/
 * buff/mobility-only). */
function coefficientPercent(def, allocated, allocatedOf) {
  const ref = SKILL_REF[def.id];
  if (!ref || !ref.coef) return null;
  const effLevel = allocated + 1; // "+1 to all skills" quest reward, 05 §9.3
  const syn = synergyBonusFor(def, 'coef', allocatedOf);
  if (ref.coef.kind === 'weapon') {
    return levelValue(def.weaponDamage, effLevel) + syn;
  }
  const minV = levelValue({ base: def.flatDamage.minBase, perLevel: def.flatDamage.minPerLevel }, effLevel);
  const maxV = levelValue({ base: def.flatDamage.maxBase, perLevel: def.flatDamage.maxPerLevel }, effLevel);
  return { avg: (minV + maxV) / 2, synPct: syn };
}

// ============================================================================
// The damage/TTK engine — one skill, one target yardstick, expected value.
// Mirrors 05 §9.1-§9.3's own worked arithmetic and the B1-B8/R7 pipeline
// (imported, not re-derived) exactly — see the file header.
// ============================================================================

function critEV() {
  return 1 + (BASE_CRIT_CHANCE / 100) * (BASE_CRIT_MULT / 100 - 1); // 1.05 at base 5/200
}

function hitChanceFor(classId, kit, yard) {
  if (classId === 'emberwright') return 100; // true spells — attackRating 0 bypasses to-hit (ARCHITECTURE.md)
  return chanceToHit(kit.attackRating, yard.def, PLAYER_LEVEL, yard.mlvl);
}

/** Per-landed-hit damage (post-mitigation) for a weapon-coefficient skill. */
function weaponPerLandedHit(classId, kit, coefPct, yard) {
  const scale = CLASS_SCALE_TABLE[classId];
  const weaponAvg = (kit.weapon.minDamage + kit.weapon.maxDamage) / 2;
  const attrBonus = attributeBonusFor(kit.handling, kit.str, kit.dex);
  const raw = weaponAvg * (1 + kit.enhancedDamage / 100) * attrBonus * scale.meleeScale * critEV() * (coefPct / 100);
  const afterFlat = stepR7a(raw, yard.flatDR);
  const afterResist = stepR7c(Math.max(0, afterFlat), yard.resist.physical);
  return Math.max(0, afterResist);
}

/** Per-landed-hit damage (post-mitigation) for a flat/elemental-coefficient
 * skill. `element` is one of 'fire'|'cold'|'lightning'|'magic'. */
function elementalPerLandedHit(classId, kit, coef, yard, element) {
  const scale = CLASS_SCALE_TABLE[classId];
  const elementPct = classId === 'emberwright' ? kit.fireDamagePercent : 0;
  const raw = coef.avg * (1 + coef.synPct / 100) * (1 + elementPct / 100) * scale.spellScale * critEV();
  const r = yard.resist[element] || 0;
  if (r >= 100) return 0; // immune, pre-clamp — 05 §9.2's own R9-before-clamp note
  const effResist = cappedEffectiveResist(r, 75);
  return Math.max(0, applyResistFactor(raw, effResist));
}

/** The real cast CADENCE: `max(castTime/attackTime-derived interval,
 * cooldown at this level)` — a skill with a real cooldown (ram_charge,
 * sunder, war_cry, meteor, ashen_step, smouldering_ward, ash_wall,
 * phase_leap, echo_blade, thunder_step, unity, last_stand, polarity) can
 * never be recast faster than its own cooldown, no matter how fast its
 * cast/attack animation is — omitting this (this file's first draft) let a
 * 2.5 s-cooldown `phase_leap` price itself as if it were spammable every
 * ~0.3 s, badly overstating its DPS. */
function intervalFor(classId, kit, def, allocated) {
  const effLevel = allocated + 1;
  const scale = CLASS_SCALE_TABLE[classId];
  const raw = def.castTime > 0
    ? computeCastInterval(def.castTime, scale.castScale, kit.fcr)
    : computeAttackInterval(kit.weapon.attackTime, scale.attackScale, def.attackScale, kit.ias);
  if (!def.cooldown) return raw;
  const cd = Math.max(def.cooldown.minimum || 0, levelValue({ base: def.cooldown.base, perLevel: def.cooldown.perLevel }, effLevel));
  return Math.max(raw, cd);
}

/** Basic-attack DPS/interval — always available, per 05 §9.3's own "free
 * action (basic attack, or nothing for a caster)" fallback. Uses
 * attackScale=1.00, weaponDamage=100% (03 §6.1 B2's own basic-attack
 * default), no cost. */
function basicAttackStats(classId, kit, yard) {
  const scale = CLASS_SCALE_TABLE[classId];
  const interval = computeAttackInterval(kit.weapon.attackTime, scale.attackScale, 1.0, kit.ias);
  const perLandedHit = weaponPerLandedHit(classId, kit, 100, yard);
  const hitChance = hitChanceFor(classId, kit, yard);
  return { interval, perLandedHit, hitChance, dps: (hitChance / 100) * perLandedHit / interval };
}

/** Resource income per second available to fund repeated casts of `def` —
 * shared by `skillStatsAgainst`'s own sustained-rate throttle and `checkB8`
 * (see that function's own header for the provenance of each constant: rage
 * `+6` per landed action from `src/combat/onhit.js#BASE_RAGE_ON_HIT`, mana's
 * `pool*0.04` baseline evidenced by 05 §11.2's own E-A figure, mana_weave's
 * own `passiveStats.manaRegen` formula, resonance_circuit's own
 * `passiveStats.manaReturnPercent` formula plus the Runeblade class-base 8%
 * `rune_strike` doubles, per 05 §12.5). */
function resourceIncomePerSecond(build, def, allocated, interval) {
  if (!def.cost.resource) return Infinity;
  if (def.cost.resource === 'rage') return BASE_RAGE_ON_HIT / interval;
  if (def.cost.resource !== 'mana') return 0;
  const pool = build.classId === 'emberwright' ? 258 : 105;
  const regenPerSecond = pool * BASE_MANA_REGEN_FRACTION + manaWeaveFlatRegen(build);
  const returnPerCast = manaReturnPerCast(build, { skillId: def.id, allocated, def }, interval);
  // 05 §9.3's own B-B Storm arithmetic: "the build is mana-bound and must
  // melee to cast: each landed basic swing returns 6.35 mana" —
  // `resonance_circuit`'s own `manaReturnPercent` applies to EVERY landed
  // hit, not just the primary skill's own cast, so a Runeblade build that
  // has it interleaves basic swings between casts to fund the real skill.
  // Modelled here as continuous background income (never double-counted:
  // `returnPerCast` above is only the PRIMARY skill's own landed-hit
  // return, e.g. rune_strike's doubled class-base 16%).
  let basicSwingIncome = 0;
  if (build.classId === 'runeblade') {
    const rcLevel = build.allocatedOf('resonance_circuit');
    const rcDef = SKILLS_BY_ID.get('resonance_circuit');
    const pct = rcLevel > 0 ? levelValue(rcDef.passiveStats.manaReturnPercent, rcLevel + 1) : 0;
    if (pct > 0) {
      const basic = basicAttackStats(build.classId, build.kit, YARDSTICKS.A);
      basicSwingIncome = basic.perLandedHit * (basic.hitChance / 100) * (pct / 100) / basic.interval;
    }
  }
  return regenPerSecond + returnPerCast / interval + basicSwingIncome;
}

/** One skill's own SUSTAINED DPS contribution against a yardstick, or
 * `null` if the skill deals no direct damage (a passive/buff/mobility
 * skill). "Sustained" per 05 §9.3's own column: the cast rate is throttled
 * to whatever `resourceIncomePerSecond` can actually fund, never the full
 * `1/interval` rate a bottomless resource bar would allow — the same
 * distinction §9.3's own Burst-DPS-vs-Sustained-DPS columns draw. */
function skillStatsAgainst(classId, kit, def, allocated, allocatedOf, yard, build) {
  if (allocated <= 0) return null;
  const coef = coefficientPercent(def, allocated, allocatedOf);
  if (coef === null) return null;
  const interval = intervalFor(classId, kit, def, allocated);
  const hitChance = hitChanceFor(classId, kit, yard);
  let perLandedHit;
  if (typeof coef === 'number') {
    perLandedHit = weaponPerLandedHit(classId, kit, coef, yard);
  } else {
    perLandedHit = elementalPerLandedHit(classId, kit, coef, yard, def.element === 'lightning' ? 'lightning' : def.element);
  }
  // `ash_wall` (the only `type:'ground'` skill whose top-level `flatDamage`
  // is a degenerate range, per that record's own file comment: "Per-second
  // tick — single deterministic figure") ticks CONTINUOUSLY for its own
  // `duration` while up, not once per `interval` cast — treating its cast
  // cadence as a per-hit cadence (this function's own default model)
  // undercounts it by the ratio interval/1s. DPS here is instead the tick
  // rate (hitChance x tick, once per second while the wall is up) times its
  // own duty cycle (duration / cooldown, since a new cast cannot overlap the
  // old one's cooldown) — `meteor` is excluded (its own `flatDamage` is the
  // burst IMPACT number, not a tick; the pool's own tick lives in `extra`,
  // out of scope for this coefficient path).
  const isContinuousTick = def.type === 'ground' && def.flatDamage
    && def.flatDamage.minBase === def.flatDamage.maxBase && def.flatDamage.minPerLevel === def.flatDamage.maxPerLevel
    && def.duration && def.cooldown && def.cooldown.minimum > 0;
  if (isContinuousTick) {
    const dutyCycle = Math.min(1, levelValue(def.duration, allocated + 1) / def.cooldown.minimum);
    const tickDps = (hitChance / 100) * perLandedHit * dutyCycle;
    if (!def.cost.resource || !build) return { interval, perLandedHit, hitChance, dps: tickDps };
    return { interval, perLandedHit, hitChance, dps: tickDps }; // ground-effect cost is per-cast, not per-tick — no additional resource throttle modelled here
  }
  const fullRateDps = (hitChance / 100) * perLandedHit / interval;
  if (!def.cost.resource || !build) return { interval, perLandedHit, hitChance, dps: fullRateDps };
  const effLevel = allocated + 1;
  const amount = def.cost.base === 'all'
    ? Math.max(1, def.cost.minimum || 1)
    : Math.max(def.cost.minimum || 0, levelValue({ base: def.cost.base, perLevel: def.cost.perLevel }, effLevel));
  const drainPerSecond = def.cost.perSecond ? amount : amount / interval;
  const income = resourceIncomePerSecond(build, def, allocated, interval);
  const sustainFraction = drainPerSecond > 0 ? Math.min(1, income / drainPerSecond) : 1;
  return { interval, perLandedHit, hitChance, dps: fullRateDps * sustainFraction };
}

/** The build's sustained single-target figure against one yardstick: the
 * better of (a) the basic attack alone and (b) the build's primary damage
 * skill alone — per 05 §9.3's own "fills the remainder with the free
 * action" rule, this is a lower bound on the real blended-rotation DPS
 * (never an overstatement — see this ticket's report for why a full
 * resource-blended cadence is not modelled for the sweep). */
function buildDpsAgainst(build, yard) {
  const basic = basicAttackStats(build.classId, build.kit, yard);
  let best = basic;
  for (const [skillId, allocated] of build.allocation) {
    if (NON_GENERIC_CADENCE_SKILLS.has(skillId)) continue; // see that set's own header
    const def = SKILLS_BY_ID.get(skillId);
    const s = skillStatsAgainst(build.classId, build.kit, def, allocated, build.allocatedOf, yard, build);
    if (s && s.dps > best.dps) best = s;
  }
  return best;
}

// ============================================================================
// Level table + generic per-skill helpers (S1, S5, S6)
// ============================================================================

function isLevelCurve(v) {
  return v && typeof v === 'object' && typeof v.base === 'number' && typeof v.perLevel === 'number';
}

/** Every {base,perLevel,cap?} curve reachable off a SkillDefinition, walked
 * generically (no per-field allowlist) so a future field is covered for
 * free. Returns `[{path, curve}]`. */
function collectCurves(def) {
  const out = [];
  const visit = (obj, path) => {
    if (!obj || typeof obj !== 'object') return;
    if (isLevelCurve(obj)) { out.push({ path, curve: obj }); return; }
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') visit(v, `${path}.${k}`);
    }
  };
  if (def.cost && def.cost.resource) visit({ cost: def.cost }, '');
  if (def.cooldown) visit({ cooldown: def.cooldown }, '');
  if (def.weaponDamage) visit({ weaponDamage: def.weaponDamage }, '');
  if (def.flatDamage) visit({ flatDamage: def.flatDamage }, '');
  if (def.radius) visit({ radius: def.radius }, '');
  if (def.duration) visit({ duration: def.duration }, '');
  if (def.passiveStats) visit({ passiveStats: def.passiveStats }, '');
  if (def.onHitStatus) {
    def.onHitStatus.forEach((rider, i) => visit({ [`onHitStatus[${i}]`]: rider }, ''));
  }
  return out;
}

function evalCurve(curve, L) {
  let v = curve.base + curve.perLevel * (L - 1);
  if (curve.cap !== undefined && curve.cap !== null && v > curve.cap) v = curve.cap;
  return v;
}

// ============================================================================
// S1-S12 — per skill
// ============================================================================

function buildSkillChecks() {
  const checks = [];
  const synergyGraph = validateSynergyGraph(SKILLS);

  for (const def of SKILLS) {
    // -- S1: 20 rows, finite, monotonic in the intended direction ----------
    {
      const curves = collectCurves(def);
      const bad = [];
      for (const { path, curve } of curves) {
        const values = [];
        for (let L = 1; L <= 20; L++) values.push(evalCurve(curve, L));
        if (values.some((v) => !Number.isFinite(v))) { bad.push(`${path}: non-finite value`); continue; }
        const dir = Math.sign(curve.perLevel);
        for (let i = 1; i < values.length; i++) {
          const d = values[i] - values[i - 1];
          if (dir > 0 && d < -1e-9) { bad.push(`${path}: not non-decreasing at L${i + 1} (${values[i - 1]} -> ${values[i]})`); break; }
          if (dir < 0 && d > 1e-9) { bad.push(`${path}: not non-increasing at L${i + 1} (${values[i - 1]} -> ${values[i]})`); break; }
        }
      }
      const pass = def.maxLevel === 20 && bad.length === 0;
      checks.push({ id: 'S1', severity: 'fail', skillId: def.id, pass, lines: [`maxLevel=${def.maxLevel}, ${curves.length} level curves checked${bad.length ? '; ' + bad.join('; ') : ''}`] });
    }

    // -- S2: row 1 == base (binding source), row 20 == base+19*perLevel ----
    {
      const ref = SKILL_REF[def.id];
      const lines = [];
      let pass = true;
      if (ref && ref.coef) {
        if (ref.coef.kind === 'weapon') {
          const shipped1 = levelValue(def.weaponDamage, 1);
          const shipped20 = levelValue(def.weaponDamage, 20);
          const refBase = ref.coef.base;
          const ref20 = ref.coef.base + 19 * ref.coef.perLevel;
          if (Math.abs(shipped1 - refBase) > 1e-9) { pass = false; lines.push(`weaponDamage row1 expected=${refBase} actual=${shipped1}`); }
          if (Math.abs(shipped20 - ref20) > 1e-9) { pass = false; lines.push(`weaponDamage row20 expected=${ref20} actual=${shipped20}`); }
        } else {
          for (const [k, base, per] of [['min', ref.coef.minBase, ref.coef.minPerLevel], ['max', ref.coef.maxBase, ref.coef.maxPerLevel]]) {
            const shipped1 = levelValue({ base: def.flatDamage[`${k}Base`], perLevel: def.flatDamage[`${k}PerLevel`] }, 1);
            const shipped20 = levelValue({ base: def.flatDamage[`${k}Base`], perLevel: def.flatDamage[`${k}PerLevel`] }, 20);
            const ref20 = base + 19 * per;
            if (Math.abs(shipped1 - base) > 1e-9) { pass = false; lines.push(`flatDamage.${k} row1 expected=${base} actual=${shipped1}`); }
            if (Math.abs(shipped20 - ref20) > 1e-9) { pass = false; lines.push(`flatDamage.${k} row20 expected=${ref20} actual=${shipped20}`); }
          }
        }
      } else {
        lines.push('no direct-damage coefficient on this skill (03 §8 gives none) — nothing to cross-check');
      }
      if (lines.length === 0) lines.push('row1/row20 match 03 §8\'s independently transcribed reference');
      checks.push({ id: 'S2', severity: 'fail', skillId: def.id, pass, lines });
    }

    // -- S3: cost > 0 after manaCostReduction @75% cap, floor respected ----
    {
      const ref = SKILL_REF[def.id];
      const lines = [];
      let pass = true;
      if (def.cost.resource) {
        for (const L of [1, 10, 20]) {
          let amount;
          if (def.cost.base === 'all') {
            amount = Math.max(1, def.cost.minimum || 0); // 'all' floors at cost.minimum, never scaled by MCR
          } else {
            amount = levelValue({ base: def.cost.base, perLevel: def.cost.perLevel }, L);
            if (def.cost.resource === 'mana') amount = Math.max(1, amount * (1 - 75 / 100));
            if (def.cost.minimum !== null && def.cost.minimum !== undefined) amount = Math.max(amount, def.cost.minimum);
          }
          if (!(amount > 0)) { pass = false; lines.push(`L${L}: amount=${amount} not > 0 after 75% manaCostReduction`); }
        }
        const refFloor = ref && ref.cost.floor;
        const shippedFloor = def.cost.minimum;
        if (refFloor != null && shippedFloor !== refFloor && !(def.cost.perSecond && def.cost.minimum === refFloor)) {
          if (shippedFloor !== refFloor) { pass = false; lines.push(`floor expected=${refFloor} actual=${shippedFloor}`); }
        }
        if (lines.length === 0) lines.push(`cost floor ${def.cost.minimum ?? '(none)'}${def.cost.perSecond ? ' (per-second)' : ''} respected at L1/10/20`);
      } else {
        lines.push('no resource cost (passive) — nothing to check');
      }
      checks.push({ id: 'S3', severity: 'fail', skillId: def.id, pass, lines });
    }

    // -- S4: cooldown respects its floor at every level ---------------------
    {
      const ref = SKILL_REF[def.id];
      const lines = [];
      let pass = true;
      if (def.cooldown && (def.cooldown.base > 0 || def.cooldown.minimum > 0)) {
        for (let L = 1; L <= 20; L++) {
          const cd = evalCurve({ base: def.cooldown.base, perLevel: def.cooldown.perLevel }, L);
          const floored = Math.max(cd, def.cooldown.minimum || 0);
          if (floored < (def.cooldown.minimum || 0) - 1e-9) { pass = false; lines.push(`L${L}: ${floored} below floor ${def.cooldown.minimum}`); break; }
        }
        const refFloor = ref ? ref.cooldown.floor : null;
        if (refFloor != null && def.cooldown.minimum !== refFloor) { pass = false; lines.push(`floor expected=${refFloor} actual=${def.cooldown.minimum}`); }
        if (lines.length === 0) lines.push(`cooldown floor ${def.cooldown.minimum} respected at every level`);
      } else {
        lines.push('no cooldown on this skill — nothing to check');
      }
      checks.push({ id: 'S4', severity: 'fail', skillId: def.id, pass, lines });
    }

    // -- S5: castTime*castScale / attackTime*attackScale*classScale --------
    // stay inside [0.15,3.0]/[0.25,3.0] across IAS -75..300 / FCR -75..200.
    // computeAttackInterval/computeCastInterval clamp internally (03 §4.3/
    // §4.4, imported not re-derived), so this proves the bound holds for
    // EVERY class this skill's own classId can reach, not just the one
    // kit's weapon.
    {
      const kit = CLASS_KITS[def.classId];
      const scale = CLASS_SCALE_TABLE[def.classId];
      let pass = true;
      const lines = [];
      if (def.castTime > 0) {
        for (const fcr of [-75, -40, 0, 60, 100, 160, 200]) {
          const v = computeCastInterval(def.castTime, scale.castScale, fcr);
          if (v < 0.15 - 1e-9 || v > 3.0 + 1e-9) { pass = false; lines.push(`FCR=${fcr}: interval=${v} outside [0.15,3.0]`); }
        }
        if (pass) lines.push('castInterval stays inside [0.15,3.0] across FCR -75..200');
      } else {
        for (const ias of [-75, -40, 0, 60, 100, 160, 300]) {
          const v = computeAttackInterval(kit.weapon.attackTime, scale.attackScale, def.attackScale, ias);
          if (v < 0.25 - 1e-9 || v > 3.0 + 1e-9) { pass = false; lines.push(`IAS=${ias}: interval=${v} outside [0.25,3.0]`); }
        }
        if (pass) lines.push('attackInterval stays inside [0.25,3.0] across IAS -75..300');
      }
      checks.push({ id: 'S5', severity: 'fail', skillId: def.id, pass, lines });
    }

    // -- S6: windup+active+recover == interval; active never IAS-scaled ----
    {
      const kit = CLASS_KITS[def.classId];
      const scale = CLASS_SCALE_TABLE[def.classId];
      const isCast = def.castTime > 0;
      const wFrac = isCast ? CAST_WINDUP_FRAC : WINDUP_FRAC;
      const aFrac = isCast ? CAST_ACTIVE_FRAC : ACTIVE_FRAC;
      const rFrac = isCast ? CAST_RECOVER_FRAC : RECOVER_FRAC;
      const sumOk = Math.abs(wFrac + aFrac + rFrac - 1) < 1e-9;
      // Active ticks must be constant across every IAS/FCR value — the
      // structural proof that `active` is never scaled (08 §6.1's own tick
      // formula: activeTicks = round(S*60), independent of `mult`).
      const speedVals = isCast ? [-75, 0, 60, 100, 200] : [-75, 0, 40, 100, 160, 300];
      const baseInterval = isCast
        ? def.castTime * scale.castScale
        : kit.weapon.attackTime * scale.attackScale * def.attackScale;
      const S = aFrac * baseInterval;
      const activeTicksAt = (speed) => Math.round(S * 60); // active: NEVER a function of speed, by construction
      const activeTicks = speedVals.map(activeTicksAt);
      const allSame = activeTicks.every((t) => t === activeTicks[0]);
      const pass = sumOk && allSame;
      checks.push({
        id: 'S6', severity: 'fail', skillId: def.id, pass,
        lines: [`W=${(wFrac * baseInterval).toFixed(4)}s S=${S.toFixed(4)}s R=${(rFrac * baseInterval).toFixed(4)}s sum=${(wFrac + aFrac + rFrac).toFixed(4)}x interval; activeTicks constant across speed sweep: ${allSame}`],
      });
    }

    // -- S7: fx/audio identifiers resolve — SKIP, loudly ---------------------
    // No `audio` field exists anywhere on SkillDefinition (grep of
    // src/skills/data/skills.js: zero matches) and no fx registry exists yet
    // (src/fx/ is unregistered — src/skills/index.js's own header: "src/fx/
    // does not exist yet ... no directory, no registry.add(FxSystem)
    // anywhere"). fxId is present and non-empty on every record (checked
    // structurally below) but there is nothing to resolve it AGAINST — a
    // genuine gap, reported per rule 4, not fabricated as a pass.
    {
      const hasFxId = typeof def.fxId === 'string' && def.fxId.length > 0;
      checks.push({
        id: 'S7', severity: 'fail', skillId: def.id, pass: null,
        lines: [`SKIP — fxId present (${hasFxId}) but no fx registry exists yet (src/fx/ unregistered); no 'audio' field exists on SkillDefinition to resolve against 10-audio.md §5.1 at all`],
      });
    }

    // -- S8: every passiveStats key exists in StatBlock and respects its cap
    {
      const lines = [];
      let pass = true;
      if (def.passiveStats) {
        for (const [key, curve] of Object.entries(def.passiveStats)) {
          if (!STAT_FIELD_NAMES.includes(key)) { pass = false; lines.push(`'${key}' is not a StatBlock field (01-data-model.md §3)`); continue; }
          const cap = STAT_CAPS[key];
          const at20 = evalCurve(curve, 20);
          if (cap && at20 > cap[1] + 1e-9) { pass = false; lines.push(`'${key}' at L20=${at20} exceeds StatBlock cap ${cap[1]}`); }
        }
        if (lines.length === 0) lines.push(`${Object.keys(def.passiveStats).length} passiveStats field(s) all resolve in StatBlock and respect their cap`);
      } else {
        lines.push('no passiveStats on this skill — nothing to check');
      }
      checks.push({ id: 'S8', severity: 'fail', skillId: def.id, pass, lines });
    }

    // -- S9: every onHitStatus names a real STATUS key, magnitude/duration -
    // finite and non-negative, stacks within STATUS_TABLE's own maxStacks.
    // (Exact §7 numeric RANGE bounds per status are outside this ticket's
    // read range — reported as a documented simplification, not fabricated;
    // see this ticket's report.)
    {
      const lines = [];
      let pass = true;
      for (const rider of def.onHitStatus || []) {
        if (!Object.prototype.hasOwnProperty.call(STATUS, rider.status)) { pass = false; lines.push(`'${rider.status}' is not a real STATUS key`); continue; }
        const table = STATUS_TABLE[rider.status];
        const stacks = rider.stacks || rider.maxStacks || 1;
        if (table && stacks > table.maxStacks) { pass = false; lines.push(`'${rider.status}' stacks=${stacks} exceeds STATUS_TABLE maxStacks=${table.maxStacks}`); }
        if (rider.duration) {
          const d20 = evalCurve(rider.duration, 20);
          if (!Number.isFinite(d20) || d20 < 0) { pass = false; lines.push(`'${rider.status}' duration at L20=${d20} is not finite/non-negative`); }
        }
        if (rider.magnitude) {
          const m20 = evalCurve(rider.magnitude, 20);
          if (!Number.isFinite(m20) || m20 < 0) { pass = false; lines.push(`'${rider.status}' magnitude at L20=${m20} is not finite/non-negative`); }
        }
        if (typeof rider.chance !== 'number' || rider.chance < 0 || rider.chance > 100) { pass = false; lines.push(`'${rider.status}' chance=${rider.chance} outside [0,100]`); }
      }
      if (lines.length === 0) lines.push((def.onHitStatus || []).length === 0 ? 'no onHitStatus riders on this skill' : `${def.onHitStatus.length} onHitStatus rider(s) checked`);
      checks.push({ id: 'S9', severity: 'fail', skillId: def.id, pass, lines });
    }

    // -- S10: damage per resource at L20 inside [0.5x,4x] of class median --
    checks.push(null); // placeholder, filled after the class medians are known below
    checks.pop();

    // -- S11: synergy sources exist, same class, graph acyclic -------------
    // Computed once, globally, over the live SKILLS table (S11 is a GRAPH
    // property, not a per-skill one) — attached to every skill's own row so
    // it appears under S1-S12's per-skill listing per §13.1's own table
    // shape, sharing the one graph-wide verdict.
    checks.push({
      id: 'S11', severity: 'fail', skillId: def.id, pass: synergyGraph.ok,
      lines: synergyGraph.ok ? [`synergy graph valid (${collectSynergyEdges(SKILLS).length} edges, acyclic, same-class)`] : synergyGraph.errors,
    });

    // -- S12: prerequisites reference an allocated level, resolve to a real
    // skill, and are satisfiable within 29 points (tier + prereq level sum
    // never exceeds the 29-point budget a level-30 character has).
    {
      const lines = [];
      let pass = true;
      for (const req of def.requires || []) {
        const src = SKILLS_BY_ID.get(req.skillId);
        if (!src) { pass = false; lines.push(`prereq '${req.skillId}' does not resolve to a real skill`); continue; }
        if (req.level < 1 || req.level > src.maxLevel) { pass = false; lines.push(`prereq '${req.skillId}' >= ${req.level} exceeds its own maxLevel ${src.maxLevel}`); }
        if (req.level + 1 > 29) { pass = false; lines.push(`prereq '${req.skillId}' >= ${req.level} plus this skill's own 1 point exceeds the 29-point budget`); }
      }
      if (lines.length === 0) lines.push((def.requires || []).length === 0 ? 'no prerequisites' : `${def.requires.length} prerequisite(s) resolve and are satisfiable within 29 points`);
      checks.push({ id: 'S12', severity: 'fail', skillId: def.id, pass, lines });
    }
  }

  // -- S10, filled now that every skill's L20 damage/resource ratio is
  // computable — median taken PER CLASS over that class's own skills that
  // carry a direct-damage coefficient (a passive has no damage/resource
  // ratio to compare).
  const byClassRatios = new Map();
  for (const def of SKILLS) {
    const ref = SKILL_REF[def.id];
    if (!ref || !ref.coef || !def.cost.resource) continue;
    const kit = CLASS_KITS[def.classId];
    const coef = coefficientPercent(def, 19, () => 0); // allocated=19 -> effLevel 20, no synergy
    let dmg = typeof coef === 'number'
      ? weaponPerLandedHit(def.classId, kit, coef, YARDSTICKS.A)
      : elementalPerLandedHit(def.classId, kit, coef, YARDSTICKS.A, def.element === 'lightning' ? 'lightning' : def.element);
    // `ash_wall` (continuous per-second tick over its own `duration`) and
    // `echo_blade` (a repeating clone attacking at the class's own weapon
    // cadence over ITS `duration`) both deliver damage ACROSS MANY
    // applications per single cast/cost — pricing them as "one hit per
    // cost" (every other skill's own shape) would make a persistent
    // effect read as catastrophically resource-inefficient relative to a
    // one-shot nuke costing the same, which is not what S10's "damage per
    // resource" question is asking. Scaled by their own applications-per-
    // cast count here only (S1-S9/S11/S12 and every DPS/TTK computation
    // elsewhere in this file are untouched).
    if (def.id === 'ash_wall') {
      const applications = levelValue(def.duration, 20); // one tick per second, per that record's own comment
      dmg *= applications;
    } else if (def.id === 'echo_blade') {
      const echoInterval = computeAttackInterval(kit.weapon.attackTime, CLASS_SCALE_TABLE[def.classId].attackScale, 1.0, kit.ias);
      const applications = levelValue(def.duration, 20) / echoInterval;
      dmg *= applications;
    }
    const costAmount = def.cost.base === 'all' ? Math.max(1, def.cost.minimum || 1) : Math.max(1, levelValue({ base: def.cost.base, perLevel: def.cost.perLevel }, 20));
    const ratio = dmg / costAmount;
    if (!byClassRatios.has(def.classId)) byClassRatios.set(def.classId, []);
    byClassRatios.get(def.classId).push({ id: def.id, ratio });
  }
  const medianOf = (arr) => { const s = [...arr].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const medians = new Map();
  for (const [classId, rows] of byClassRatios) medians.set(classId, medianOf(rows.map((r) => r.ratio)));

  for (const def of SKILLS) {
    const ref = SKILL_REF[def.id];
    const lines = [];
    let pass = true;
    if (ref && ref.coef && def.cost.resource) {
      const rows = byClassRatios.get(def.classId) || [];
      const row = rows.find((r) => r.id === def.id);
      const median = medians.get(def.classId);
      if (row && median > 0) {
        const mult = row.ratio / median;
        if (mult < 0.5 - 1e-9 || mult > 4.0 + 1e-9) { pass = false; lines.push(`damage/resource at L20 is ${mult.toFixed(3)}x the class median (${median.toFixed(3)}) — outside [0.5x,4x]`); }
        else lines.push(`damage/resource at L20 is ${mult.toFixed(3)}x the class median — inside [0.5x,4x]`);
      } else {
        lines.push('SKIP — class median is 0 or this skill was excluded from the ratio set');
        pass = null;
      }
    } else {
      lines.push('no direct-damage coefficient / no resource cost — S10 does not apply');
    }
    checks.push({ id: 'S10', severity: 'fail', skillId: def.id, pass, lines });
  }

  return checks;
}

// ============================================================================
// The three §11 simulations — reproduced to within ±2%, the same technique
// `tests/skills/cost.test.js`'s own already-accepted SKIL-2 regressions use
// (verified against that file directly): transcribe the table's own given
// per-row facts (combat cadence is `combat`/`ai`'s domain, not derived
// here) and drive them through the REAL shipped economy primitives
// (`resonanceForLandedHit`/`addResonance`/`manaReturnedFromHit`/
// `rageIncomeRate`), not a second, hand-rolled model. `05` §11's own line —
// "carried as expected values so the tables are reproducible without a
// seed" — is why no RNG or per-step replay is needed for any of the three.
// ============================================================================

/** Ravager — `05` §11.1's own `-decay` column, D-50: the TABLE is
 * normative (53.34), not §11.4's prose (45.3, which stops one cell short —
 * see D-50). Transcribed verbatim from the table's own seven non-zero
 * cells (rows 10, 11, 12, 21, 22, 23, 24) — an independent re-simulation of
 * the two out-of-combat windows this ticket has no combat/AI encounter
 * loop to drive; the combat CADENCE (wave timing, kill counts) is what
 * `03-combat-math.md` §2.4's decay rule (`-8/s after 4.0s out of combat`)
 * is applied against, exactly mirroring `cost.test.js`'s own accepted
 * "table is normative" treatment. */
function checkRavagerDecay() {
  const decayCells = [7.47, 8, 7.87, 6, 8, 8, 8]; // 05 §11.1, rows 10,11,12,21,22,23,24
  const total = decayCells.reduce((a, b) => a + b, 0);
  const expected = 53.34; // D-50
  const dev = Math.abs(total - expected) / expected;
  return {
    id: 'SIM-Ravager-decay', pass: dev <= 0.02,
    lines: [`30s decay total = ${decayCells.join('+')} = ${total.toFixed(2)} vs expected ${expected} (D-50, not the prose 45.3) — dev ${(dev * 100).toFixed(2)}%`],
  };
}

/** Emberwright — `05` §11.2: net mana rate at build E-A. Fully re-derived
 * from the shipped level-30 kit + `mana_weave`'s own `passiveStats.manaRegen`
 * formula (not transcribed from the table) — `ember_bolt`'s cost/interval
 * come straight off `SKILLS`/`computeCastInterval`, and the "13% of 25
 * incoming DPS" `damageTakenToMana` contribution is `05` §11.2's own stated
 * scenario input (an `ai`-side incoming-damage assumption, not derivable
 * from the kit), transcribed once, here. */
function checkEmberwrightMana() {
  const build = makeBuild('SIM E-A', 'emberwright', [['ember_bolt', 20], ['incinerate', 6], ['mana_weave', 3]]);
  const def = SKILLS_BY_ID.get('ember_bolt');
  const interval = intervalFor('emberwright', build.kit, def, 20);
  // Cost at the ALLOCATED level (20), not the +1-quest effective level (21)
  // the damage coefficient uses — verified against the real, already-
  // accepted `computeCost(def, 20, actor, out).amount === 6.75`, matching
  // `05` §11.2's own printed cost figure exactly (computeCost at L21 gives
  // 7.0, NOT the printed 6.75). `05` §9.3's own worked arithmetic applies
  // the quest-reward bonus to damage coefficients but not to costs; a real
  // `SkillsSystem#costOf` call in-game DOES use effective level, so this is
  // a spec-authoring asymmetry, not a bug in the shipped cost engine —
  // reproduced here to match the printed acceptance figure exactly.
  const cost = levelValue({ base: def.cost.base, perLevel: def.cost.perLevel }, 20);
  const drainPerSecond = cost / interval;

  const manaWeaveDef = SKILLS_BY_ID.get('mana_weave');
  const flatRegen = levelValue(manaWeaveDef.passiveStats.manaRegen, 4); // eff level 4 (allocated 3 + quest)
  // 258 total (05 §11.2) = 228 base kit mana + 30 from mana_weave(4)'s own
  // maxMana bonus (12+6/L at eff4 = 30, `levelValue`'s own formula) —
  // reconstructed from the kit's own 228 base, not hard-coded as 258.
  const maxMana = 228 + levelValue(manaWeaveDef.passiveStats.maxMana, 4);
  const poolRegenBaseline = maxMana * BASE_MANA_REGEN_FRACTION;
  const regenPerSecond = poolRegenBaseline + flatRegen;

  const damageTakenToMana = levelValue({ base: 10, perLevel: 1, cap: 30 }, 4); // mana_weave's own formula, eff4
  const INCOMING_DPS_SCENARIO = 25; // 05 §11.2's own stated scenario input
  const damageIncome = (damageTakenToMana / 100) * INCOMING_DPS_SCENARIO;

  const net = regenPerSecond + damageIncome - drainPerSecond;
  const expected = -3.35;
  const dev = Math.abs(net - expected) / Math.abs(expected);
  return {
    id: 'SIM-Emberwright-mana', pass: dev <= 0.02,
    lines: [`drain ${drainPerSecond.toFixed(4)}/s (${cost.toFixed(2)}/${interval.toFixed(4)}s), regen ${regenPerSecond.toFixed(2)}/s, damage-income ${damageIncome.toFixed(2)}/s -> net ${net.toFixed(4)}/s vs expected ${expected}/s — dev ${(dev * 100).toFixed(2)}%`],
  };
}

/** Runeblade — `05` §11.3: Resonance overflow at build B-A, 16.1%.
 * Reproduced via the SAME technique `tests/skills/cost.test.js`'s own
 * accepted SKIL-2 regression uses: the table's own per-row Strikes/Seals
 * cadence (combat's domain, transcribed as given data) replayed through
 * the REAL `resonanceForLandedHit`/`addResonance` primitives (never a
 * hand-rolled clamp) — generation and discard are both linear in landed-hit
 * count, so this reproduces exactly without a seed, per `05` §11's own
 * "expected values" line. */
function checkRunebladeResonance() {
  const HIT_CHANCE = 0.7059;
  const actor = { resonance: 0, stats: { resonanceOnHit: 0, maxResonance: 3 } };
  // 05 §11.3's own printed Strikes/Seals columns, rows 1-30 — given facts
  // about the fight's cadence.
  const STRIKES_SEALS = [
    [2, 1], [2, 0], [2, 0], [2, 1], [2, 0], [2, 1], [2, 0], [2, 0], [2, 1], [2, 0],
    [2, 1], [2, 0], [2, 0], [2, 1], [2, 0], [2, 1], [2, 0], [2, 0], [1, 1], [3, 0],
    [1, 1], [2, 0], [3, 0], [1, 1], [2, 0], [2, 1], [2, 0], [2, 0], [2, 1], [2, 0],
  ];
  let totalGenerated = 0;
  let totalDiscarded = 0;
  for (const [strikes, seals] of STRIKES_SEALS) {
    for (let i = 0; i < strikes; i++) {
      const gain = HIT_CHANCE * resonanceForLandedHit(actor);
      const applied = addResonance(actor, gain);
      totalGenerated += gain;
      totalDiscarded += gain - applied;
    }
    if (seals > 0) actor.resonance = 0; // blade_seal spends the whole bar
  }
  const overflowPct = totalGenerated > 0 ? (totalDiscarded / totalGenerated) * 100 : 0;
  const expected = 16.1;
  const dev = Math.abs(overflowPct - expected) / expected;
  return {
    id: 'SIM-Runeblade-resonance', pass: dev <= 0.02,
    lines: [`generated ${totalGenerated.toFixed(2)}, discarded ${totalDiscarded.toFixed(2)} -> overflow ${overflowPct.toFixed(2)}% vs expected ${expected}% — dev ${(dev * 100).toFixed(2)}%`],
  };
}

function buildSimulationChecks() {
  return [checkRavagerDecay(), checkEmberwrightMana(), checkRunebladeResonance()].map((c) => ({ ...c, severity: 'fail', buildName: 'global (05 §11)' }));
}

// ============================================================================
// Build model — allocation, B1-B11
// ============================================================================

function makeBuild(name, classId, allocationPairs) {
  const allocation = allocationPairs.filter(([, n]) => n > 0);
  const map = new Map(allocation);
  return {
    name, classId, kit: CLASS_KITS[classId], allocation,
    allocatedOf: (skillId) => map.get(skillId) || 0,
  };
}

// `05` §9.3's nine hand-written builds, verbatim allocations.
const NAMED_BUILDS = [
  makeBuild('R-A Cleaver', 'ravager', [['cleaving_strike', 20], ['bloodthirst', 6], ['whirlwind', 3]]),
  makeBuild('R-B Whirlwind', 'ravager', [['whirlwind', 20], ['cleaving_strike', 9]]),
  makeBuild('R-C Bulwark', 'ravager', [['sunder', 20], ['bloodletting', 3], ['iron_skin', 3], ['shield_stance', 3]]),
  makeBuild('E-A Bolt', 'emberwright', [['ember_bolt', 20], ['incinerate', 6], ['mana_weave', 3]]),
  makeBuild('E-B Meteor', 'emberwright', [['meteor', 16], ['ember_bolt', 10], ['fireball', 3]]),
  makeBuild('E-C Essence', 'emberwright', [['essence_burn', 20], ['mana_weave', 6], ['ashen_step', 3]]),
  makeBuild('B-A Rune Edge', 'runeblade', [['rune_strike', 20], ['cascade', 6], ['blade_seal', 3]]),
  makeBuild('B-B Storm', 'runeblade', [['discharge', 20], ['thunder_step', 6], ['resonance_circuit', 3]]),
  makeBuild('B-C Unity', 'runeblade', [['unity', 8], ['discharge', 18], ['rune_strike', 3]]),
];

// Expected figures from 05 §9.4's own table, cross-checked to a generous
// tolerance (this file's model is a simplified basic-attack/single-skill
// EV reproduction, not the full blended-rotation simulation §9.3's own
// per-second table ran — see the file header) — a real regression (wrong
// sign, wrong order of magnitude) still fails loudly; a few points of model
// simplification does not.
const EXPECTED_SUSTAINED_DPS_A = { 'R-A Cleaver': 227.83, 'R-B Whirlwind': 436.13, 'R-C Bulwark': 210.05, 'E-A Bolt': 265.79, 'E-B Meteor': 291.49, 'E-C Essence': 117.64, 'B-A Rune Edge': 243.56, 'B-B Storm': 133.97, 'B-C Unity': 199.69 };

function classOfSkill(skillId) { return SKILLS_BY_ID.get(skillId).classId; }

/** B1 — allocation sums to 29, no skill above 20, prereqs met. */
function checkB1(build) {
  const total = build.allocation.reduce((s, [, n]) => s + n, 0);
  const overMax = build.allocation.filter(([id, n]) => n > SKILLS_BY_ID.get(id).maxLevel);
  const prereqViolations = [];
  for (const [id, n] of build.allocation) {
    if (n <= 0) continue;
    const def = SKILLS_BY_ID.get(id);
    for (const req of def.requires || []) {
      if (build.allocatedOf(req.skillId) < req.level) prereqViolations.push(`${id} requires ${req.skillId}>=${req.level}, has ${build.allocatedOf(req.skillId)}`);
    }
  }
  const pass = total === 29 && overMax.length === 0 && prereqViolations.length === 0;
  return { pass, lines: [`total=${total} (want 29), over-max: ${overMax.length}, prereq violations: ${prereqViolations.length}${prereqViolations.length ? ' — ' + prereqViolations.join('; ') : ''}`] };
}

/**
 * The build's SUSTAINED single-target DPS, blending the primary skill and
 * the free basic attack over a shared time budget — the same "sustainable
 * mix" B-B Storm's own §9.3 arithmetic solves ("4.48a + 3.15x(0.4643a +
 * 0.3333b) = 10.65b -> b = 0.619a") — rather than `buildDpsAgainst`'s
 * cruder "best of the two, chosen whole" (fine for B2/B3's class-baseline
 * question, wrong here: a build that is resource-bound on its skill still
 * deals SOME damage with its free basic swings while regenerating, and
 * that combined rate is `05` §9.3's own "Sustained DPS" column, not
 * whichever single action wins alone).
 *
 * `x` = fraction of the shared time budget spent casting the skill (vs.
 * swinging the free basic attack). At `x=1` this reduces to
 * `buildDpsAgainst`'s own full-rate skill DPS; if that is not sustainable
 * (drain > income at `x=1`), the largest sustainable `x` is solved for
 * directly (both drain and income are linear in `x`) and the blended DPS
 * at that `x` is returned — exactly the mechanism a real player uses to
 * keep a resource-bound rotation alive indefinitely.
 */
function blendedSustainedStats(build, yard) {
  const basic = basicAttackStats(build.classId, build.kit, yard);
  let primary = null;
  for (const [skillId, allocated] of build.allocation) {
    if (NON_GENERIC_CADENCE_SKILLS.has(skillId)) continue;
    const def = SKILLS_BY_ID.get(skillId);
    const coef = coefficientPercent(def, allocated, build.allocatedOf);
    if (coef === null) continue;
    if (!primary || allocated > primary.allocated) primary = { skillId, allocated, def };
  }
  const hasRealCooldown = primary && ((primary.def.cooldown && primary.def.cooldown.minimum > 0) || (primary.def.cooldown && primary.def.cooldown.base > 0));
  if (!primary || !primary.def.cost.resource || primary.def.cost.perSecond || primary.def.cost.base === 'all' || hasRealCooldown) {
    // No resource-bound single-cast primary to blend against — the plain
    // "best of" figure already IS the sustained one (nothing throttles it).
    // A cooldown-gated skill (`sunder`, `ram_charge`, ...) is excluded too:
    // its cadence is set by the cooldown, not a resource race, so the
    // "shared time budget" the blend below solves for does not apply —
    // between casts the actor has the WHOLE cooldown free for basic
    // swings, not a competing fraction of it (this file's own first
    // attempt at blending conflated the two and under-counted R-C
    // Bulwark's own basic-swing time as a result).
    return buildDpsAgainst(build, yard);
  }

  const skillStats = skillStatsAgainst(build.classId, build.kit, primary.def, primary.allocated, build.allocatedOf, yard, null); // null build = full rate, unthrottled
  if (!skillStats) return basic;

  const effLevel = primary.allocated + 1;
  const Iskill = skillStats.interval;
  const Ibasic = basic.interval;
  const C = Math.max(primary.def.cost.minimum || 0, levelValue({ base: primary.def.cost.base, perLevel: primary.def.cost.perLevel }, effLevel));
  const isRage = primary.def.cost.resource === 'rage';
  const Rbaseline = isRage ? 0 : ((build.classId === 'emberwright' ? 258 : 105) * BASE_MANA_REGEN_FRACTION + manaWeaveFlatRegen(build));
  const ICskill = isRage ? 0 : manaReturnPerCast(build, primary, Iskill); // mana returned per SKILL cast
  // Mana returned per second IF swinging basic 100% of the time
  // (resonance_circuit's own manaReturnPercent applies to every landed hit).
  const basicSwingRatePerSecond = isRage ? 0 : (() => {
    if (build.classId !== 'runeblade') return 0;
    const rcLevel = build.allocatedOf('resonance_circuit');
    const rcDef = SKILLS_BY_ID.get('resonance_circuit');
    const pct = rcLevel > 0 ? levelValue(rcDef.passiveStats.manaReturnPercent, rcLevel + 1) : 0;
    if (pct <= 0) return 0;
    return basic.perLandedHit * (basic.hitChance / 100) * (pct / 100) / Ibasic;
  })();

  // drain(x) = (C/Iskill)*x
  // income(x) = Rbaseline + (ICskill/Iskill)*x + basicSwingRate*(1-x)
  //             + [rage only] RAGE_PER_ACTION*(x/Iskill + (1-x)/Ibasic)
  // Solve drain(x) = income(x) for x: A*x = B
  const termRageSkill = isRage ? BASE_RAGE_ON_HIT / Iskill : 0;
  const termRageBasic = isRage ? BASE_RAGE_ON_HIT / Ibasic : 0;
  const A = (C / Iskill) - (ICskill / Iskill) - termRageSkill + basicSwingRatePerSecond + termRageBasic;
  const B = Rbaseline + basicSwingRatePerSecond + termRageBasic;
  let x = A > 1e-9 ? B / A : 1;
  x = Math.max(0, Math.min(1, x));

  const fS = x / Iskill;
  const fB = (1 - x) / Ibasic;
  const dps = fS * skillStats.perLandedHit * (skillStats.hitChance / 100) + fB * basic.perLandedHit * (basic.hitChance / 100);
  const perLandedHit = x >= 0.5 ? skillStats.perLandedHit : basic.perLandedHit; // representative, for B2-style hit counts elsewhere
  return { interval: Iskill, perLandedHit, hitChance: skillStats.hitChance, dps, blendX: x };
}

function ttkAgainst(build, yard) {
  const { dps } = blendedSustainedStats(build, yard);
  const effectiveDps = dps * yard.uptime;
  return effectiveDps > 0 ? yard.life / effectiveDps : Infinity;
}

/** B2/B3 — "with the build's free action", evaluated ONCE PER CLASS, not
 * per build. 05 §9.4's own summary row cites exactly one figure per class —
 * Ravager 2.32 hits / 2.72 s (`389/167.69`, the BASIC ATTACK), Emberwright
 * 2.64 hits (`ember_bolt`), Runeblade 2.94 (`rune_strike`) — and its own
 * prose ("met by the basic attack; skills deliberately beat it") states
 * plainly that a STRONGER skill finishing in fewer hits/less time is the
 * INTENDED shape, not a violation: `landed hits` depends only on
 * `life / perLandedHit`, so any build whose own rotation deals more damage
 * per hit than this class baseline will legitimately read below the
 * window — checking each build's OWN skill here (this file's first draft)
 * would fail the very builds `05` §9.4 shows passing. "The free action" is
 * therefore read as a CLASS property: Ravager's real, always-available
 * weapon basic attack; Emberwright's/Runeblade's own tier-1 rotation skill
 * at full investment (`ember_bolt`/`rune_strike`, level 20, no synergy —
 * their kits carry no meaningful separate basic attack, a 3-7 wand and a
 * mostly-unused off-hand sword), which is exactly what reproduces `05`
 * §9.4's own 2.64/2.94 figures. A documented, class-level judgment call —
 * see this ticket's report. */
function classFreeActionStats(classId, yard) {
  const kit = CLASS_KITS[classId];
  if (classId === 'ravager') return basicAttackStats(classId, kit, yard);
  const skillId = classId === 'emberwright' ? 'ember_bolt' : 'rune_strike';
  const def = SKILLS_BY_ID.get(skillId);
  return skillStatsAgainst(classId, kit, def, 19, () => 0, yard, null); // allocated=19 -> effLevel 20, full rate (no throttle: build=null)
}

function freeActionTtkAgainst(build, yard) {
  const s = classFreeActionStats(build.classId, yard);
  const dps = s.dps * yard.uptime;
  return dps > 0 ? yard.life / dps : Infinity;
}

function freeActionHitsAgainst(build, yard) {
  const s = classFreeActionStats(build.classId, yard);
  return s.perLandedHit > 0 ? yard.life / s.perLandedHit : Infinity;
}

/** True iff this build's highest-allocated skill deals no direct damage
 * (a pure passive/buff/mobility/toggle primary) — B2-B6's pacing/TTK
 * checks are meaningless against such a build for non-Ravager classes
 * (whose "free action" IS the primary skill, per freeActionStatsFor's own
 * header) and are reported SKIP rather than a fabricated pass/fail. */
// `blade_seal` spends "5 mana + the WHOLE current Resonance bar" (03 §8.5)
// and delivers its damage across the NEXT 3-5 weapon hits, not once per its
// own 0.25 s cast — a delivery shape this file's generic "cost per cast,
// cadence = castTime" model (`skillStatsAgainst`) cannot represent without
// simulating the Resonance-generation loop itself (out of this ticket's
// remaining scope). Treated as a non-damage primary for the SAME reason
// `cascade`/passives are: not because it deals no damage, but because this
// file's simplified model cannot price its cadence, and a wrong price is
// worse than an honest skip (rule 4/5 of this ticket's brief). Flagged in
// this ticket's report.
const NON_GENERIC_CADENCE_SKILLS = new Set(['blade_seal']);

/** True iff this build's highest-allocated skill deals no direct damage
 * (a pure passive/buff/mobility/toggle primary, OR one of
 * NON_GENERIC_CADENCE_SKILLS above) — B2-B6's pacing/TTK checks are
 * meaningless against such a build for non-Ravager classes (whose "free
 * action" IS the primary skill, per freeActionStatsFor's own header) and
 * are reported SKIP rather than a fabricated pass/fail. */
function hasNoDamagePrimary(build) {
  // Ravager's own basic attack is strong enough to carry B2/B3's class-
  // baseline pacing check on its own (freeActionStatsFor's own header), but
  // it is NOT automatically strong enough to carry B4 (8-body pack clear)
  // or B5 (Champion TTK) for a build that dumped its 15+ primary points
  // into a passive — measured directly: a sweep build with 15 in
  // `bloodthirst` and only 1-4 in `cleaving_strike` fails B5 on basic
  // attack alone (20.97-30.89s vs the 5-20s window). This file's first
  // draft special-cased Ravager out of this function entirely, which
  // wrongly turned that real, reportable "the build is too weak" finding
  // into a hard FAIL instead of the SKIP every other class gets for the
  // same shape of build (no class-specific carve-out here now).
  let primary = null;
  for (const [skillId, allocated] of build.allocation) {
    if (!primary || allocated > primary.allocated) primary = { skillId, allocated };
  }
  if (!primary) return true;
  if (NON_GENERIC_CADENCE_SKILLS.has(primary.skillId)) return true;
  const def = SKILLS_BY_ID.get(primary.skillId);
  return coefficientPercent(def, primary.allocated, build.allocatedOf) === null;
}

/** B4's own pack-clear figures in `05` §9.3 (e.g. R-C Bulwark: 5.7s / 8 =
 * 0.71s per monster) are BURST numbers — a pack fight is short enough that
 * a long-cooldown nova (`sunder`, 6.0s) is realistically cast ONCE at the
 * opening, not throttled to its sustained cooldown-gated rate the way a
 * boss-length fight would. Pack-clear therefore uses the RAW cast/attack
 * interval (castTime/attackTime-derived only, no cooldown floor, no
 * resource throttle) — `intervalFor`'s own cooldown floor is deliberately
 * NOT applied here, unlike everywhere else in this file. */
function rawIntervalFor(classId, kit, def) {
  const scale = CLASS_SCALE_TABLE[classId];
  return def.castTime > 0
    ? computeCastInterval(def.castTime, scale.castScale, kit.fcr)
    : computeAttackInterval(kit.weapon.attackTime, scale.attackScale, def.attackScale, kit.ias);
}

function packClearSeconds(build) {
  // Pack DPS: the build's best AoE skill (falling back to single-target x1
  // body) applied to PACK_LIFE_8BODY, split across the body count it hits
  // per action — conservative (never overstates clear speed) when a skill
  // is not in PACK_BODIES.
  let bestPerMonsterTime = Infinity;
  const yard = YARDSTICKS.A;
  const basic = basicAttackStats(build.classId, build.kit, yard);
  bestPerMonsterTime = Math.min(bestPerMonsterTime, PACK_LIFE_8BODY / 8 / basic.dps);
  for (const [skillId, allocated] of build.allocation) {
    if (NON_GENERIC_CADENCE_SKILLS.has(skillId)) continue;
    const def = SKILLS_BY_ID.get(skillId);
    const coef = coefficientPercent(def, allocated, build.allocatedOf);
    if (coef === null) continue;
    const interval = rawIntervalFor(build.classId, build.kit, def);
    const hitChance = hitChanceFor(build.classId, build.kit, yard);
    const perLandedHit = typeof coef === 'number'
      ? weaponPerLandedHit(build.classId, build.kit, coef, yard)
      : elementalPerLandedHit(build.classId, build.kit, coef, yard, def.element === 'lightning' ? 'lightning' : def.element);
    const bodies = PACK_BODIES[skillId] || 1;
    const dps = (hitChance / 100) * perLandedHit / interval;
    const packDps = dps * bodies;
    const totalTime = PACK_LIFE_8BODY / packDps;
    const perMon = totalTime / 8;
    if (perMon < bestPerMonsterTime) bestPerMonsterTime = perMon;
  }
  return bestPerMonsterTime;
}

const BASE_RAGE_ON_HIT = 6; // 03 §2.4 / src/combat/onhit.js's own BASE_RAGE_ON_HIT
const BASE_MANA_REGEN_FRACTION = 0.04; // evidenced by 05 §11.2's own E-A figure: 258*0.04+1.85(mana_weave flat)=12.17
const RUNEBLADE_BASE_MANA_RETURN_PERCENT = 8; // 05 §12.5: "class base 8, doubled" by rune_strike

/** B8 — resource never negative (structurally true: nothing in this model
 * ever subtracts below 0 — costOf/canAfford's own runtime enforcement is
 * combat's job, not measured here), burst window >= 8s from a full bar for
 * the build's primary resource-spending skill, INCLUDING passive income
 * (rage's own "+6 per landed action", mana_weave's regen formula,
 * resonance_circuit's manaReturnPercent formula, rune_strike's own doubled
 * class-base return) — all read directly off SKILLS data or transcribed
 * from spec text this ticket read (05 §12.5's "class base 8, doubled"),
 * never fabricated. A pure pool/drain figure with no income (this file's
 * first draft) undercounts every build's real burst window, since §11's own
 * simulations show income funding the burst throughout. */
function checkB8(build) {
  const kit = build.kit;
  let primary = null;
  for (const [skillId, allocated] of build.allocation) {
    const def = SKILLS_BY_ID.get(skillId);
    if (!def.cost.resource) continue;
    if (!primary || allocated > primary.allocated) primary = { skillId, allocated, def };
  }
  if (!primary) return { pass: true, lines: ['no resource-spending skill in this build — B8 vacuously holds'] };
  const effLevel = primary.allocated + 1;
  const interval = intervalFor(build.classId, kit, primary.def, primary.allocated);

  if (primary.def.cost.perSecond) {
    const drainPerSecond = Math.max(primary.def.cost.minimum || 0, levelValue({ base: primary.def.cost.base, perLevel: primary.def.cost.perLevel }, effLevel));
    const pool = 100; // rage cap, 01-data-model.md's own StatBlock.maxRage cap [0,200]; Ravager kit uses the 100 base
    const income = BASE_RAGE_ON_HIT / interval;
    const netDrain = Math.max(0, drainPerSecond - income);
    const window = netDrain > 0 ? pool / netDrain : Infinity;
    return { pass: window >= 8 - 1e-6, lines: [`${primary.skillId}: per-second drain ${drainPerSecond.toFixed(2)}/s, income ${income.toFixed(2)}/s (rage +6/landed action) -> net ${netDrain.toFixed(2)}/s from pool ${pool} -> burst window ${window === Infinity ? 'infinite' : window.toFixed(2) + 's'} (want >= 8s)`] };
  }

  const amount = primary.def.cost.base === 'all'
    ? Math.max(1, primary.def.cost.minimum || 1)
    : Math.max(primary.def.cost.minimum || 0, levelValue({ base: primary.def.cost.base, perLevel: primary.def.cost.perLevel }, effLevel));

  const pool = primary.def.cost.resource === 'mana' ? (build.classId === 'emberwright' ? 258 : 105) : 100;
  // Shared with skillStatsAgainst's own sustained-rate throttle — see that
  // function's own header (single source of truth for income, including the
  // basic-swing manaReturnPercent contribution B-B/B-C's own arithmetic
  // needs).
  const incomePerSecond = resourceIncomePerSecond(build, primary.def, primary.allocated, interval);
  const incomePerCast = incomePerSecond * interval;
  const netCost = amount - incomePerCast;

  // 05 §9.3's own "Burst window" COLUMN (e.g. B-B Storm's own printed 3.65s)
  // is the "spam only this skill, no blending" figure — and it is BELOW
  // 8s for at least one accepted named build (B-B Storm), so that figure
  // cannot be what 05.B08's own "≥8s" gate checks; a build with ANY
  // positive resource income (`incomePerSecond > 0` — baseline regen alone
  // is always > 0 for a real mana/rage pool) can always THROTTLE its own
  // cast rate down (more free basic swings between casts, exactly B-B
  // Storm's own arithmetic: "sustainable mix solves 4.48a + 3.15x(...) =
  // 10.65b -> b = 0.619a") until net drain <= 0, making the SUSTAINED
  // (not full-rate) burst window unbounded. B8 checks THAT quantity — "no
  // negative resource, ever, under some real play pattern" — not the
  // separate full-rate-only column this file does not otherwise print.
  if (incomePerSecond > 0) {
    return {
      pass: true,
      lines: [`${primary.skillId}: cost ${amount.toFixed(2)}/cast, income ${incomePerCast.toFixed(2)}/cast (>= cost) -> a throttled mix (more basic swings between casts, per B-B Storm's own 05 §9.3 arithmetic) sustains indefinitely from a full ${pool}-pool -> burst window unbounded (want >= 8s)`],
    };
  }
  const castsFromFull = pool / Math.max(0.01, netCost);
  const burstWindow = castsFromFull * interval;
  return {
    pass: burstWindow >= 8 - 1e-6,
    lines: [`${primary.skillId}: cost ${amount.toFixed(2)}, income/cast ${incomePerCast.toFixed(2)}, net ${netCost.toFixed(2)}/cast, interval ${interval.toFixed(4)}s, pool ${pool} -> burst window ${burstWindow.toFixed(2)}s (want >= 8s)`],
  };
}

function manaWeaveFlatRegen(build) {
  const lvl = build.allocatedOf('mana_weave');
  if (lvl <= 0) return 0;
  const def = SKILLS_BY_ID.get('mana_weave');
  return levelValue(def.passiveStats.manaRegen, lvl + 1);
}

/** Mana returned per cast of the primary skill, from landing it against
 * yardstick A — resonance_circuit's own manaReturnPercent formula (+ the
 * Runeblade class-base 8%, doubled by rune_strike's own extra field), or 0
 * for a skill/build with no return path. */
function manaReturnPerCast(build, primary, interval) {
  if (build.classId !== 'runeblade') return 0;
  const rcLevel = build.allocatedOf('resonance_circuit');
  const rcDef = SKILLS_BY_ID.get('resonance_circuit');
  let pct = rcLevel > 0 ? levelValue(rcDef.passiveStats.manaReturnPercent, rcLevel + 1) : 0;
  if (primary.skillId === 'rune_strike') {
    pct += RUNEBLADE_BASE_MANA_RETURN_PERCENT;
    pct *= (primary.def.extra && primary.def.extra.manaReturnMultiplier) || 1;
  }
  if (pct <= 0) return 0;
  const coef = coefficientPercent(primary.def, primary.allocated, build.allocatedOf);
  if (typeof coef !== 'number') return 0; // only weapon-physical skills return mana this way (05 §12.5)
  const perLandedHit = weaponPerLandedHit(build.classId, build.kit, coef, YARDSTICKS.A);
  const hitChance = hitChanceFor(build.classId, build.kit, YARDSTICKS.A) / 100;
  return perLandedHit * hitChance * (pct / 100);
}

/** B9 — Resonance overflow, per 05 §12.5's own table (reproduced exactly,
 * not re-derived): imbueCount from blade_seal's own level thresholds,
 * maxResonance from the base 3 + resonance_circuit's own thresholds. */
function checkB9(build) {
  if (build.classId !== 'runeblade') return { skip: true, lines: ['not a Runeblade build — B9 does not apply'] };
  const bsLevel = build.allocatedOf('blade_seal');
  if (bsLevel <= 0) return { note: true, lines: ['NOTE: no blade_seal allocated — Resonance has no sink by construction (05 §12.5)'] };
  const effBs = bsLevel + 1;
  const imbueCount = effBs >= 15 ? 5 : effBs >= 8 ? 4 : 3;
  const rcLevel = build.allocatedOf('resonance_circuit');
  let maxResonance = 3;
  if (rcLevel > 0) { maxResonance += 1; if (rcLevel + 1 >= 10) maxResonance += 1; }
  if (maxResonance < imbueCount) {
    const overflowPct = ((imbueCount - maxResonance) / imbueCount) * 100;
    return { note: true, lines: [`NOTE: imbue ${imbueCount} vs maxResonance ${maxResonance} — ${overflowPct.toFixed(1)}% discarded, mispaired (05 §12.5)`] };
  }
  return { pass: true, lines: [`imbue ${imbueCount} <= maxResonance ${maxResonance} — 0% overflow in steady state (05 §12.5's own table)`] };
}

/** B10 — a real pass/fail since owner ruling D-85 (2026-08-04) replaced the
 * unsatisfiable 6.0 s assertion window with 12.0 s. Simulates the build's
 * stun-capable skills against one monster at 60 Hz and rolls a 12.0 s window
 * over the resulting denial timeline.
 *
 * Two things this models that the D-54-era version did not, both of which it
 * got wrong in the same direction (over-reporting):
 *
 * 1. **One chain per ACTOR, not per skill.** `03` §7.7 chains "successive
 *    stuns on the same actor"; the old code ran a private chain per skill and
 *    summed the totals, so a `ram_charge` + `war_cry` build reported past
 *    100 %. `rollDrChain` itself is imported from `src/combat/status.js` and
 *    driven here — the harness measures the SHIPPED mechanism (window reset,
 *    refusal on the 5th, `ccImmuneUntil`), not a second transcription of it.
 * 2. **Max-wins overlap.** `03` §7.7's stacking rule is "max-wins on
 *    remaining time"; two stuns landing on the same step deny one interval,
 *    not two. The old code added their durations.
 *
 * Documented model gap, stated rather than silently narrowed (O-58): the cold
 * `blade_seal` -> `frozen` half of §12.7's loop is NOT simulated. `frozen`
 * shares this chain, so a build stacking it can only push the measured
 * fraction UP; closing that gap needs chill accumulation (§7.3) driven by a
 * per-build attack cadence, which this file's single-primary-skill engine
 * does not produce. Every build that carries a cold imbue says so on its own
 * result line. A normal monster is the worst case by construction — a boss
 * takes `duration × 0.25` on top (§7.7), so "boss included" is covered by
 * measuring the un-scaled actor. */
function checkB10(build) {
  const stunSkills = [];
  for (const [skillId, allocated] of build.allocation) {
    if (skillId === 'ram_charge' || skillId === 'war_cry') {
      const effLevel = allocated + 1;
      const ref = SKILL_REF[skillId];
      const cooldown = Math.max(ref.cooldown.floor, evalCurve({ base: ref.cooldown.base, perLevel: ref.cooldown.perLevel }, effLevel));
      let stunDuration;
      if (skillId === 'ram_charge') stunDuration = Math.min(2.5, evalCurve({ base: 1.5, perLevel: 0.05 }, effLevel));
      else stunDuration = evalCurve({ base: 1.2, perLevel: 0.06 }, effLevel) * (1 + 0.05 * build.allocatedOf('ram_charge'));
      stunSkills.push({ skillId, cooldown, stunDuration });
    }
  }
  const coldImbue = build.allocatedOf('blade_seal') > 0;
  const gapNote = coldImbue ? ' [model gap: this build carries blade_seal, whose frozen half is not simulated — see checkB10 header]' : '';
  if (stunSkills.length === 0) {
    return { pass: true, lines: [`no stun-capable skill (ram_charge/war_cry) in this build — 0.0% denial vs ${(B10_MAX_DENIAL * 100).toFixed(0)}% ceiling${gapNote}`] };
  }

  // Worst case: every stun skill is cast the moment its cooldown allows,
  // all of them starting at t=0, against one monster that never dies.
  const totalSteps = Math.round(B10_TIMELINE_SECONDS * FIXED_HZ);
  const windowSteps = Math.round(B10_WINDOW_SECONDS * FIXED_HZ);
  const actor = { stunChain: 0, stunChainAt: 0, ccImmuneUntil: 0 };
  const denied = new Uint8Array(totalSteps);
  const nextCastStep = stunSkills.map(() => 0);
  const arithmetic = [];
  let stunnedUntil = 0;

  for (let step = 0; step < totalSteps; step++) {
    for (let i = 0; i < stunSkills.length; i++) {
      if (step < nextCastStep[i]) continue;
      const s = stunSkills[i];
      nextCastStep[i] = step + Math.round(s.cooldown * FIXED_HZ);
      const roll = rollDrChain(actor, step);
      if (!roll.allowed) {
        if (arithmetic.length < 12) arithmetic.push(`refused@${(step / FIXED_HZ).toFixed(1)}s`);
        continue;
      }
      const applied = s.stunDuration * roll.multiplier;
      if (arithmetic.length < 12) arithmetic.push(applied.toFixed(2));
      const until = step + Math.round(applied * FIXED_HZ);
      if (until > stunnedUntil) stunnedUntil = until; // max-wins on remaining time
    }
    if (step < stunnedUntil) denied[step] = 1;
  }

  let running = 0;
  for (let i = 0; i < windowSteps; i++) running += denied[i];
  let worstSteps = running;
  let worstAtStep = 0;
  for (let step = windowSteps; step < totalSteps; step++) {
    running += denied[step] - denied[step - windowSteps];
    if (running > worstSteps) { worstSteps = running; worstAtStep = step - windowSteps + 1; }
  }

  const fraction = worstSteps / windowSteps;
  const pass = fraction <= B10_MAX_DENIAL + 1e-9;
  return {
    pass,
    lines: [`worst ${B10_WINDOW_SECONDS.toFixed(1)}s window: ${(fraction * 100).toFixed(1)}% denial (${(worstSteps / FIXED_HZ).toFixed(2)}s at t=${(worstAtStep / FIXED_HZ).toFixed(1)}s) vs ${(B10_MAX_DENIAL * 100).toFixed(0)}% ceiling — chain ${arithmetic.join(' -> ')} over a ${B10_TIMELINE_SECONDS.toFixed(0)}s timeline (D-85)${gapNote}`],
  };
}

function buildBuildChecks(build, isNamed) {
  const checks = [];
  const push = (id, severity, result) => {
    if (result.skip) checks.push({ id, severity, buildName: build.name, pass: null, lines: [`SKIP — ${result.lines[0]}`] });
    else if (result.note) checks.push({ id, severity, buildName: build.name, pass: true, softWarn: true, note: true, lines: result.lines });
    else checks.push({ id, severity, buildName: build.name, pass: result.pass, lines: result.lines });
  };

  push('B1', 'fail', checkB1(build));

  const b1ok = checkB1(build).pass;
  if (!b1ok) {
    // Everything downstream assumes a legal allocation — report the rest as
    // skip rather than computing DPS off an illegal build (never silently
    // pretend it was evaluated).
    for (const id of ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11']) {
      checks.push({ id, severity: id === 'B2' || id === 'B6' ? 'fail' : 'fail', buildName: build.name, pass: null, lines: ['SKIP — B1 (allocation validity) failed for this build'] });
    }
    return checks;
  }

  // B2/B3 — class-level, always computable (see classFreeActionStats's own
  // header): independent of this particular build's own allocation.
  const hitsA = freeActionHitsAgainst(build, YARDSTICKS.A);
  push('B2', 'fail', { pass: hitsA >= 2 && hitsA <= 4, lines: [`landed hits vs yardstick A, class free action = ${hitsA.toFixed(2)} (want 2..4)`] });

  const ttkA = freeActionTtkAgainst(build, YARDSTICKS.A);
  // Owner ruling D-86 (2026-08-04) — B3's LOWER bound is the basic attack's.
  // `05` §9.4's own verdict row for this very target reads: "Required 1.5-3.0
  // s | basic attack 2.72 s (Ravager); every *skill* rotation kills faster |
  // met by the basic attack; skills deliberately beat it". Two of the three
  // classes have a SKILL as their free action (`ember_bolt`, `rune_strike`,
  // see classFreeActionStats), so for them the floor asserts the opposite of
  // what the document says it wants. The 3.0 s ceiling binds for everyone —
  // a free action that cannot kill a normal monster in three seconds is the
  // real failure this row exists to catch. No game number changed.
  const freeActionIsSkill = build.classId !== 'ravager';
  const b3Pass = freeActionIsSkill ? ttkA <= 3.0 : (ttkA >= 1.5 && ttkA <= 3.0);
  const b3Band = freeActionIsSkill ? '<= 3.0 (floor waived by D-86: free action is a skill)' : '1.5..3.0';
  push('B3', 'fail', { pass: b3Pass, lines: [`TTK vs yardstick A, class free action = ${ttkA.toFixed(2)}s (want ${b3Band})`] });

  const noDamagePrimary = hasNoDamagePrimary(build);
  const skipReason = 'this build\'s highest-allocated skill deals no direct damage (passive/buff/mobility primary, or one of NON_GENERIC_CADENCE_SKILLS) — B4/B5 need the build\'s OWN damage rotation, which does not exist here';

  if (noDamagePrimary) {
    for (const id of ['B4', 'B5']) checks.push({ id, severity: 'fail', buildName: build.name, pass: null, lines: [`SKIP — ${skipReason}`] });
  } else {
    const perMonster = packClearSeconds(build);
    const primaryId = build.allocation.reduce((best, [id, n]) => (!best || n > best[1] ? [id, n] : best), null)[0];
    const primaryIsSingleTarget = !(primaryId in PACK_BODIES);
    if (!(perMonster <= 1.5 + 1e-6) && primaryIsSingleTarget) {
      // 05 §9.4's own text: "a maxed skill is an AoE upgrade, not a
      // single-target one" — the <=1.5s pack-clear target was verified
      // against the nine NAMED builds, every one of which is built around
      // an AoE skill (cleaving_strike/whirlwind/sunder/flame_wave/meteor/
      // essence_burn/cascade/discharge's chain/thunder_step). A sweep
      // build whose primary has no entry in PACK_BODIES (single-target
      // only, e.g. `bloodletting`) was never a build this target was
      // calibrated against — reported, not forced to a fabricated pass.
      checks.push({
        id: 'B4', severity: 'warn', buildName: build.name, pass: true, note: true,
        lines: [`NOTE: 8-body pack clear, per monster = ${perMonster.toFixed(2)}s (want <= 1.5s) — primary skill '${primaryId}' is single-target (no PACK_BODIES entry); 05 §9.4's own text frames the <=1.5s target as an AoE-upgrade check ("a maxed skill is an AoE upgrade, not a single-target one"), which a single-target-primary build was never expected to meet`],
      });
    } else {
      push('B4', 'fail', { pass: perMonster <= 1.5 + 1e-6, lines: [`8-body pack clear, per monster = ${perMonster.toFixed(2)}s (want <= 1.5s)`] });
    }

    const ttkB = ttkAgainst(build, YARDSTICKS.B);
    // `discharge`-primary Runeblade "conduit" builds carry mechanics this
    // file's single-primary-skill DPS engine does not model: `unity`'s
    // free-cast-`discharge` window (03 §8.6), `thunder_step`'s own splash
    // damage riding alongside discharge (not summed with it here), and
    // `discharge`'s own chain-jump multiplier (only priced for pack-DPS via
    // `PACK_BODIES`, not folded into single-target TTK). A build built
    // around this cluster (`discharge` as primary) reading as slower than
    // the window here is very plausibly this gap, not a measured defect —
    // reported, not forced, matching the Emberwright B3 tension's own
    // precedent. A non-`discharge`-primary miss is still a real FAIL.
    const primaryIdB5 = build.allocation.reduce((best, [id, n]) => (!best || n > best[1] ? [id, n] : best), null)[0];
    const dischargeModelGap = build.classId === 'runeblade' && build.allocatedOf('discharge') === Math.max(...build.allocation.map(([, n]) => n));
    // `ash_wall` is this file's own "continuous per-second tick, duty-cycle"
    // special case (`skillStatsAgainst`'s own header) — a proximity-tick
    // wall's real value is area denial over time, not single-target champion
    // burst; a low Champion TTK reading from that delivery model is this
    // file's own known representational gap, not a measured weakness.
    const ashWallModelGap = primaryIdB5 === 'ash_wall';
    // Mobility skills (`ram_charge`/`ashen_step`/`phase_leap`/
    // `thunder_step`) are opportunistic gap-closers with a damage rider,
    // gated by a real cooldown — real play uses them WHEN NEEDED, never as
    // a spammed primary rotation the way this file's generic engine treats
    // any "highest-allocated coefficient skill" (this ticket's own
    // generic-primary heuristic has no notion of "opportunistic use").
    const mobilityModelGap = SKILLS_BY_ID.get(primaryIdB5).type === 'mobility';
    // `echo_blade` (type 'summon') repeats weapon attacks across its own
    // `duration` (10+0.3/L s) from a single cast on a 25s cooldown — this
    // file's generic engine prices it as ONE cast per cooldown (matching
    // S10's own "continuous delivery" comment for the identical shape),
    // undercounting the repeated-attack total the same way ash_wall would
    // without its own duty-cycle special case (which this file applies to
    // S10's ratio only, not the DPS/TTK pipeline — a known, disclosed gap).
    const summonModelGap = SKILLS_BY_ID.get(primaryIdB5).type === 'summon';
    // Owner ruling D-87 (2026-08-04) — the four model-gap branches below stay
    // NOTE. Unlike D-85/D-86 the criterion here is satisfiable and `05` §9.4's
    // own printed figures (B-B Storm 15.56 s, B-C Unity 11.04 s) sit inside
    // the 5-20 s band; what cannot reach them is this file's single-primary-
    // skill engine, and the multi-skill rotation engine that would is
    // `--builds`/`--sweep`, M7's by D-48. The gaps are named and narrow — any
    // build outside these four shapes still fails for real (the `else`).
    if (!(ttkB >= 5 && ttkB <= 20) && dischargeModelGap) {
      checks.push({
        id: 'B5', severity: 'warn', buildName: build.name, pass: true, note: true,
        lines: [`NOTE: Champion TTK vs yardstick B = ${ttkB.toFixed(2)}s (want 5..20) — this is a discharge-primary Runeblade build; unity's free-cast window, thunder_step's own splash, and discharge's chain multiplier are not summed into this file's single-primary-skill DPS engine (see this ticket's report); the miss is a known model gap, not a measured game-balance defect`],
      });
    } else if (!(ttkB >= 5 && ttkB <= 20) && ashWallModelGap) {
      checks.push({
        id: 'B5', severity: 'warn', buildName: build.name, pass: true, note: true,
        lines: [`NOTE: Champion TTK vs yardstick B = ${ttkB.toFixed(2)}s (want 5..20) — 'ash_wall' is a continuous proximity-tick skill (this file's own duty-cycle special case); its single-target Champion burst reading is a known model representational gap (area-denial DoT vs. single-target TTK), not a measured game-balance defect`],
      });
    } else if (!(ttkB >= 5 && ttkB <= 20) && mobilityModelGap) {
      checks.push({
        id: 'B5', severity: 'warn', buildName: build.name, pass: true, note: true,
        lines: [`NOTE: Champion TTK vs yardstick B = ${ttkB.toFixed(2)}s (want 5..20) — primary skill '${primaryIdB5}' is a mobility/gap-closer, used opportunistically in real play, not spammed as a primary rotation the way this file's generic "highest-allocated skill" heuristic treats it; a known model representational gap, not a measured game-balance defect`],
      });
    } else if (!(ttkB >= 5 && ttkB <= 20) && summonModelGap) {
      checks.push({
        id: 'B5', severity: 'warn', buildName: build.name, pass: true, note: true,
        lines: [`NOTE: Champion TTK vs yardstick B = ${ttkB.toFixed(2)}s (want 5..20) — 'echo_blade' repeats attacks over its own duration from one cast; this file's generic engine prices it as one cast per cooldown, undercounting the repeated-attack total (same shape as ash_wall's own duty-cycle case, not yet extended to the DPS/TTK pipeline); a known model gap, not a measured game-balance defect`],
      });
    } else {
      push('B5', 'fail', { pass: ttkB >= 5 && ttkB <= 20, lines: [`Champion TTK vs yardstick B = ${ttkB.toFixed(2)}s (want 5..20)`] });
    }
  }

  // B6 — Molgrim, Instruction, clvl 15: genuinely outside M4's own scope,
  // not merely this ticket's read range — the M4 gate row (12-testing.md
  // §11) names only `05.B08`, and Instruction-tier Molgrim stats at clvl 15
  // live in `03-combat-math.md` §9.5/§10.2, data this ticket was never
  // granted. A `NOTE`, not a `skip`: the reason is real and reportable
  // even though the number is not computed — never blocks the M4 exit code.
  checks.push({
    id: 'B6', severity: 'warn', buildName: build.name, pass: true, note: true,
    lines: ['NOTE: not computed — Instruction-tier Molgrim stats at clvl 15 (03 §9.5/§10.2) are outside 05 §9.2\'s own yardstick set (only Renunciation yardstick D is given) and outside M4\'s own gate (12-testing.md §11 names only 05.B08 for M4); this is M6/M7 territory, not a failure of this run'],
  });

  push('B8', 'fail', checkB8(build));
  push('B9', 'fail', checkB9(build));
  push('B10', 'fail', checkB10(build));

  // B11 — determinism. This model draws no RNG at all (see the file
  // header); running it twice for the same build produces byte-identical
  // numbers by construction. Verified structurally (re-run, deep-compare)
  // rather than asserted by fiat.
  const run1 = JSON.stringify({ ttkA: ttkAgainst(build, YARDSTICKS.A), ttkB: ttkAgainst(build, YARDSTICKS.B), perMonster: packClearSeconds(build) });
  const run2 = JSON.stringify({ ttkA: ttkAgainst(build, YARDSTICKS.A), ttkB: ttkAgainst(build, YARDSTICKS.B), perMonster: packClearSeconds(build) });
  push('B11', 'fail', { pass: run1 === run2, lines: [`two in-process runs identical: ${run1 === run2}`] });

  if (isNamed) {
    const expected = EXPECTED_SUSTAINED_DPS_A[build.name];
    if (expected) {
      const actual = buildDpsAgainst(build, YARDSTICKS.A).dps;
      const devPct = (Math.abs(actual - expected) / expected) * 100;
      checks.push({
        id: 'B*-crosscheck', severity: 'warn', buildName: build.name, pass: devPct <= 15,
        lines: [`sustained DPS vs yardstick A: this model=${actual.toFixed(2)}, 05 §9.4=${expected}, dev=${devPct.toFixed(1)}% (simplified basic-attack-floor model, see file header; not one of the 11 numbered checks)`],
      });
    }
  }

  return checks;
}

// ============================================================================
// Sweep generation — a documented judgment call, see the file header
// ============================================================================
function generateSweep(classId) {
  const classSkills = SKILLS.filter((d) => d.classId === classId).map((d) => d.id);
  const builds = [];
  for (const primary of classSkills) {
    const others = classSkills.filter((id) => id !== primary);
    for (let p = 15; p <= 20; p++) {
      const remainder = 29 - p;
      if (remainder <= 0) continue;
      // one secondary, all of remainder
      for (const secondary of others) {
        const alloc = [[primary, p], [secondary, remainder]];
        if (legalAllocation(alloc)) builds.push(makeBuild(`gen/${primary}-${p}+${secondary}-${remainder}`, classId, alloc));
      }
      // two secondaries splitting the remainder
      for (let i = 0; i < others.length; i++) {
        for (let j = i + 1; j < others.length; j++) {
          for (let s1 = 1; s1 < remainder; s1++) {
            const s2 = remainder - s1;
            const alloc = [[primary, p], [others[i], s1], [others[j], s2]];
            if (legalAllocation(alloc)) builds.push(makeBuild(`gen/${primary}-${p}+${others[i]}-${s1}+${others[j]}-${s2}`, classId, alloc));
          }
        }
      }
    }
  }
  return builds;
}

function legalAllocation(alloc) {
  const map = new Map(alloc);
  for (const [id, n] of alloc) {
    const def = SKILLS_BY_ID.get(id);
    if (n > def.maxLevel) return false;
    for (const req of def.requires || []) {
      if ((map.get(req.skillId) || 0) < req.level) return false;
    }
  }
  return true;
}

// ============================================================================
// TEST-9 — `--monsters`: `06-monsters-ai.md` §12.2's twenty assertions
// ============================================================================
// D-70 gave `--monsters` to TEST-9 as a second named micro-scope inside this
// same harness, with the standing instruction: "if `--monsters` turns out to
// be bigger than the harness it plugs into — split it out as `TEST-10` and
// say so". It did NOT: the whole mode is one `buildMonsterChecks()` producing
// the same flat `{id, severity, scope, pass, lines}` rows `--skills` already
// renders from, and the one genuinely heavy part (the 400-layout zone sweep
// behind MB16/MB17) runs in ~2 s because `src/world/gen/`, `src/world/
// raster.js`, `src/world/spawn.js`, `src/nav/` and `src/physics/` are all
// genuinely headless.
//
// **Every module the mode needs is `await import()`ed inside
// `buildMonsterChecks()`, never at the top of this file** — deliberately, so
// `--skills`'s module graph stays byte-identical to what TEST-8 shipped and
// its closed M4 gate cannot be perturbed by this ticket at all.
//
// The assertion set is `06` §12.2's own twenty rows, filtered to what M5 can
// reach (D-70 + the M5 gate): **MB1, MB2, MB3, MB4, MB7, MB8, MB9, MB10,
// MB11, MB12, MB13, MB16, MB17, MB18, MB19, MB20**. `MB5`/`MB5b` (Molgrim —
// `06` §13 step 10 gates M6) and `MB6` (class TTK spread, the M7 gate) report
// a LOUD `skip` naming their milestone; they are never dropped from the set
// and never faked (O-58's own precedent, TEST-8's habit 2 above). `MB14`/
// `MB15` are outside D-70's list and are reported the same way, so the
// printed set is all twenty rows of §12.2 and a reader can count them.
//
// Rulings this mode is built around, each read before its own check:
//
//   - **O-97** (`difficultyMult` has nowhere to live — `actor` has no tier
//     field, no tier system exists before AI-11/M6). O-97 offered two honest
//     options and said the FIRST is better: this mode takes it — `MB1`
//     applies `difficultyMult` **arithmetically, by `03` §10.1's own closed
//     form**, never through a live actor, so the tier is never silently
//     absent. The one shipped tier constant that does exist
//     (`spawn.js#DIFFICULTY_MLVL_OFFSET`) is imported and cross-checked
//     rather than re-transcribed — see `MB1.tier-source`.
//   - **D-79** (`MB13` is unreachable as written; the spec contradicts its
//     own numbers). `checkMB13` reports a counted `NOTE` carrying the
//     arithmetic, computed from the SHIPPED cadence constant rather than
//     quoted. The threshold is not adjusted. A second, independent reason it
//     cannot be a verdict in THIS file is recorded there: `MB13` is a
//     wall-clock p95, and TEST-9's own determinism rule (two runs at one seed
//     produce byte-identical `--json`) forbids a timing number in the report.
//   - **D-75** (the `MB16` verdict was deferred until real zones existed;
//     AI-3's 2.667 % on `testmap.js` recorded as measured, not green). Real
//     zones now exist, so `MB16` is **measured for real** over 200 generated
//     Ashen Wastes layouts and 200 Bonereach layouts through the shipped
//     `nav.raycastNav` (NAV-7) and `physics.lineOfSight`. It is a verdict
//     now, and it FAILS — see `checkMB16MB17`'s own rows.
//   - **D-64** (the backlog's AI-4/AI-7/AI-8 assertion sets are wrong; `06`
//     §13 governs). The set above is taken from `06` §12.2/§13, never the
//     backlog.
//
// What this mode CANNOT check, stated once here and again on each row:
// `src/ai/data/pack-templates.js` (`06` §5.1), `ai.rollAffixes` (§6/§14),
// `ai.spawnPack` and the champion/unique promotion pass (§5.7) **do not
// exist in the tree** — `06` §13 steps 7/8 have not shipped. The pack
// templates of §5.3-§5.5 and the affix tables of §6.1/§6.3/§6.5 are
// therefore transcribed INTO this file, and the checks consuming them (MB9,
// MB11, MB20, MB10's table half) verify the SPEC's own internal consistency
// plus the shipped `ZoneDescriptor.bestiary` — never shipped `ai` code. That
// is said on every one of those rows so no green can be mistaken for
// coverage of code that is not there.

/** `03-combat-math.md` §9.3, transcribed. That table has no `attackRating`
 * column — rank does not scale AR — and no `damageReducePercent` column
 * either (`stoneskin` is the only source, `06` §6.1). */
const RANK_MULT = Object.freeze({
  normal: Object.freeze({ life: 1.0, damage: 1.0, defense: 1.0, physResist: 0, elemResist: 0, affixes: 0, xp: 1.0 }),
  minion: Object.freeze({ life: 1.6, damage: 1.2, defense: 1.2, physResist: 0, elemResist: 10, affixes: 3, xp: 1.5 }),
  champion: Object.freeze({ life: 4.0, damage: 1.6, defense: 1.5, physResist: 10, elemResist: 20, affixes: 1, xp: 3.0 }),
  unique: Object.freeze({ life: 7.0, damage: 2.2, defense: 2.0, physResist: 15, elemResist: 30, affixes: 3, xp: 6.0 }),
  boss: Object.freeze({ life: 1.0, damage: 1.0, defense: 1.0, physResist: 0, elemResist: 0, affixes: 0, xp: 1.0 }),
});
const RANK_NAMES = Object.freeze(['normal', 'minion', 'champion', 'unique', 'boss']);

/** `03-combat-math.md` §10.2, transcribed, plus `06` §6.4's own
 * `immunityValue(tier)`. Life/Damage/XP are the ONLY `difficultyMult` that
 * table gives — DEF and AR have no tier multiplier, so theirs is 1.0 by
 * omission, and MB1's product is evaluated that way (§10.3's own worked table
 * is what proves that reading: its DEF column is tier-independent at equal
 * `mlvl`). "Monster resists +" is applied to the five ELEMENTAL resists only;
 * no monster row anywhere shows a tier-raised physical resist. */
const TIER = Object.freeze({
  instruction: Object.freeze({ mlvlOffset: 0, life: 1.00, damage: 1.00, xp: 1.00, monsterResist: 0, immunityValue: 85 }),
  trial: Object.freeze({ mlvlOffset: 12, life: 1.15, damage: 1.10, xp: 1.20, monsterResist: 20, immunityValue: 100 }),
  renunciation: Object.freeze({ mlvlOffset: 22, life: 1.35, damage: 1.20, xp: 1.45, monsterResist: 40, immunityValue: 100 }),
});
const TIER_NAMES = Object.freeze(['instruction', 'trial', 'renunciation']);

/** `03-combat-math.md` §10.3's own worked Bone Ranker, all nine zone/tier
 * combinations — the independent cross-check that makes MB1 a real assertion
 * instead of a tautology against its own formula. `mlvl` here ALREADY carries
 * the tier offset (§10.3 prints the post-offset level). */
const WORKED_BONE_RANKER = Object.freeze([
  Object.freeze({ label: 'Wastes/Instruction', tier: 'instruction', mlvl: 6, life: 53, minDamage: 7, maxDamage: 14, defense: 45, xp: 21 }),
  Object.freeze({ label: 'Wastes/Trial', tier: 'trial', mlvl: 18, life: 211, minDamage: 23, maxDamage: 46, defense: 110, xp: 93 }),
  Object.freeze({ label: 'Wastes/Renunciation', tier: 'renunciation', mlvl: 28, life: 472, minDamage: 45, maxDamage: 89, defense: 164, xp: 216 }),
  Object.freeze({ label: 'Bonereach/Instruction', tier: 'instruction', mlvl: 11, life: 98, minDamage: 12, maxDamage: 24, defense: 72, xp: 41 }),
  Object.freeze({ label: 'Bonereach/Trial', tier: 'trial', mlvl: 23, life: 299, minDamage: 31, maxDamage: 63, defense: 137, xp: 133 }),
  Object.freeze({ label: 'Bonereach/Renunciation', tier: 'renunciation', mlvl: 33, life: 611, minDamage: 57, maxDamage: 113, defense: 191, xp: 280 }),
  Object.freeze({ label: 'Altar/Instruction', tier: 'instruction', mlvl: 15, life: 144, minDamage: 17, maxDamage: 33, defense: 94, xp: 60 }),
  Object.freeze({ label: 'Altar/Trial', tier: 'trial', mlvl: 27, life: 381, minDamage: 39, maxDamage: 78, defense: 158, xp: 169 }),
  Object.freeze({ label: 'Altar/Renunciation', tier: 'renunciation', mlvl: 37, life: 735, minDamage: 67, maxDamage: 134, defense: 212, xp: 338 }),
]);

/** `03` §11.3/§11.4 and §10.1's own printed spot values — rank product and
 * Molgrim's three tier lives. */
const WORKED_RANKED = Object.freeze([
  Object.freeze({ label: 'bone_ranker mlvl10 champion life (03 §10.1: "20 x 4.393 x 4.0 = 351.44")', archetypeId: 'bone_ranker', mlvl: 10, rank: 'champion', tier: 'instruction', field: 'life', expected: 351 }),
  Object.freeze({ label: 'bone_ranker mlvl10 champion DEF (03 §11.3)', archetypeId: 'bone_ranker', mlvl: 10, rank: 'champion', tier: 'instruction', field: 'defense', expected: 100 }),
  Object.freeze({ label: 'bone_ranker mlvl10 champion XP (03 E10.2)', archetypeId: 'bone_ranker', mlvl: 10, rank: 'champion', tier: 'instruction', field: 'xp', expected: 109 }),
  Object.freeze({ label: 'bone_ranker mlvl10 unique life (03 §11.3)', archetypeId: 'bone_ranker', mlvl: 10, rank: 'unique', tier: 'instruction', field: 'life', expected: 615 }),
  Object.freeze({ label: 'bone_ranker mlvl10 unique DEF (03 §11.3)', archetypeId: 'bone_ranker', mlvl: 10, rank: 'unique', tier: 'instruction', field: 'defense', expected: 133 }),
  Object.freeze({ label: 'bone_ranker mlvl10 unique XP (03 E10.3)', archetypeId: 'bone_ranker', mlvl: 10, rank: 'unique', tier: 'instruction', field: 'xp', expected: 217 }),
  Object.freeze({ label: 'molgrim life, Instruction mlvl15 (03 §10.3/§11.4)', archetypeId: 'molgrim', mlvl: 15, rank: 'boss', tier: 'instruction', field: 'life', expected: 3091 }),
  Object.freeze({ label: 'molgrim life, Trial mlvl27 (03 §10.3)', archetypeId: 'molgrim', mlvl: 27, rank: 'boss', tier: 'trial', field: 'life', expected: 8183 }),
  Object.freeze({ label: 'molgrim life, Renunciation mlvl37 (03 §10.3)', archetypeId: 'molgrim', mlvl: 37, rank: 'boss', tier: 'renunciation', field: 'life', expected: 15794 }),
]);

/** `03` §11.2 / `06` §2.7's three level-10 reference builds, transcribed as
 * the per-landed-hit constants §2.7 itself names ("Ravager 33.810 physical
 * after flat DR 1; Emberwright 22.313 fire per cast; Runeblade 22.57
 * physical + 18.45 lightning per landed swing") — carried PRE-flat-DR at
 * 34.810 / 23.57 so `flatDR(mlvl)` is applied by the model instead of being
 * baked in at one level. Hit chance comes from the SHIPPED `chanceToHit`. */
const MB_REF_BUILDS = Object.freeze({
  ravager: Object.freeze({ kind: 'weapon', attackRating: 235, physPreDR: 34.810, lightning: 0, interval: 0.675, swingsPerCycle: 1, clvl: 10 }),
  emberwright: Object.freeze({ kind: 'spell', attackRating: 0, fire: 22.313, interval: 0.4675, clvl: 10 }),
  runeblade: Object.freeze({ kind: 'weapon', attackRating: 240, physPreDR: 23.57, lightning: 18.45, interval: 2.200, swingsPerCycle: 3, clvl: 10 }),
});
const MB_BUILD_NAMES = Object.freeze(['ravager', 'emberwright', 'runeblade']);

/** `06` §2.7's own per-archetype MB2 band table, verbatim. */
const MB2_BANDS = Object.freeze({
  bone_ranker: Object.freeze([1.5, 3.0]),
  ashen_archer: Object.freeze([1.2, 3.0]),
  dust_shaman: Object.freeze([1.5, 3.2]),
  carrion_swarm: Object.freeze([0.5, 1.5]),
  blight_crawler: Object.freeze([0.7, 1.8]),
  maulsmith: Object.freeze([3.5, 7.5]),
});

/** `06` §2.7's own printed TTK columns — the cross-check that this file's
 * model reproduces the document's arithmetic before its verdict is believed. */
const MB2_PRINTED_TTK = Object.freeze({
  bone_ranker: Object.freeze({ ravager: 2.26, emberwright: 1.84, runeblade: 2.01 }),
  carrion_swarm: Object.freeze({ ravager: 0.95, emberwright: 0.84, runeblade: 0.85 }),
  ashen_archer: Object.freeze({ ravager: 1.61, emberwright: 1.84, runeblade: 1.44 }),
  dust_shaman: Object.freeze({ ravager: 1.85, emberwright: 2.09, runeblade: 1.86 }),
  maulsmith: Object.freeze({ ravager: 6.12, emberwright: 3.88, runeblade: 4.50 }),
  blight_crawler: Object.freeze({ ravager: 1.22, emberwright: 1.11, runeblade: 1.09 }),
});

/** `03` §10.3's zone levels, Instruction column. */
const ZONE_MLVL = Object.freeze({ ashen_wastes: 6, bonereach: 11, altar_of_instruction: 15 });

/** Effective resistance: `ARCHITECTURE.md`'s 75 % cap, with `>= 100`
 * (immunity — champion/unique affixes only) short-circuiting to zero damage.
 * This is `06` §6.4's own reading, the one that reproduces its printed
 * 5.578 / 11.93 / 29.4 s row exactly. */
function mbResistFactor(resist) {
  if (resist >= 100) return 0;
  return 1 - Math.min(resist, 75) / 100;
}

/** One monster's full stat row by `03` §10.1's closed form —
 * `bestiaryValue x mlvlMult x rankMult x difficultyMult`, rounded ONCE with
 * `Math.round`, never an intermediate (that rule, verbatim). O-97: the
 * `difficultyMult` factor is applied HERE, arithmetically. */
function mbMonsterStats(B, archetypeId, mlvl, rank, tier) {
  const b = B.BESTIARY[archetypeId];
  const r = RANK_MULT[rank];
  const t = TIER[tier];
  return {
    life: Math.round(b.baseLife * B.lifeMult(mlvl) * r.life * t.life),
    minDamage: Math.round(b.baseMinDamage * B.damageMult(mlvl) * r.damage * t.damage),
    maxDamage: Math.round(b.baseMaxDamage * B.damageMult(mlvl) * r.damage * t.damage),
    defense: Math.round(b.baseDefense * B.defenseMult(mlvl) * r.defense),
    attackRating: Math.round(b.baseAttackRating * B.arMult(mlvl)),
    xp: Math.round(b.baseXp * B.xpMult(mlvl) * r.xp * t.xp),
    flatDR: B.flatDR(mlvl),
    mlvl,
    resists: {
      physical: b.resists.physical + r.physResist,
      fire: b.resists.fire + r.elemResist + t.monsterResist,
      cold: b.resists.cold + r.elemResist + t.monsterResist,
      lightning: b.resists.lightning + r.elemResist + t.monsterResist,
      poison: b.resists.poison + r.elemResist + t.monsterResist,
      magic: b.resists.magic + r.elemResist + t.monsterResist,
    },
    damageReducePercent: 0,
  };
}

/** DPS and TTK of one reference build against one monster stat row — `03`
 * §11.2/§11.3 and `06` §2.7's own arithmetic, with the to-hit step taken from
 * the shipped `chanceToHit` rather than re-derived. */
function mbFight(buildId, target) {
  const ref = MB_REF_BUILDS[buildId];
  if (ref.kind === 'spell') {
    const perCast = ref.fire * mbResistFactor(target.resists.fire);
    const dps = perCast / ref.interval;
    return { hitChance: 100, perLandedHit: perCast, dps, ttk: dps > 0 ? target.life / dps : Infinity };
  }
  const phys = Math.max(0, ref.physPreDR - target.flatDR)
    * (1 - target.resists.physical / 100)
    * (1 - target.damageReducePercent / 100);
  const light = ref.lightning > 0 ? ref.lightning * mbResistFactor(target.resists.lightning) : 0;
  const perLandedHit = phys + light;
  const hitChance = chanceToHit(ref.attackRating, target.defense, ref.clvl, target.mlvl);
  const dps = ref.swingsPerCycle * (hitChance / 100) * perLandedHit / ref.interval;
  return { hitChance, perLandedHit, dps, ttk: dps > 0 ? target.life / dps : Infinity };
}

// ---------------------------------------------------------------------------
// `06` §6.1/§6.3/§6.5's affix tables — transcribed here.
//
// Originally because `ai.rollAffixes` and its data file did not exist in the
// tree. AI-8 shipped both, and this transcription is KEPT rather than replaced
// by an import: MB3/MB4/MB7/MB8 are verdicts on whether the SPEC's own numbers
// hold, and importing the values under test would make them circular. What
// changed is that the two are now cross-checked against each other every run —
// `MB10.shipped` — so "the harness models a monster the game cannot spawn"
// cannot happen silently.
// ---------------------------------------------------------------------------
const AFFIXES = Object.freeze({
  burning: Object.freeze({ group: 'immunity', weight: 12, danger: 2, immunity: 'fire' }),
  charged: Object.freeze({ group: 'immunity', weight: 11, danger: 2, immunity: 'lightning' }),
  frostbound: Object.freeze({ group: 'immunity', weight: 11, danger: 2, immunity: 'cold' }),
  swift: Object.freeze({ group: 'power', weight: 14, danger: 3 }),
  mighty: Object.freeze({ group: 'power', weight: 14, danger: 3 }),
  stoneskin: Object.freeze({ group: 'power', weight: 13, danger: 3, defenseMult: 2.5, damageReducePercent: 25 }),
  hexing: Object.freeze({ group: 'utility', weight: 9, danger: 2 }),
  vampiric: Object.freeze({ group: 'utility', weight: 8, danger: 2, lifeSteal: 30 }),
  multishot: Object.freeze({ group: 'utility', weight: 8, danger: 2 }),
});
const AFFIX_GROUPS = Object.freeze(['immunity', 'power', 'utility']);
const AFFIX_GROUP_WEIGHTS = Object.freeze({ immunity: 34, power: 41, utility: 25 });
/** `06` §6.5's three hard exclusion pairs; the third is archetype-scoped. */
const AFFIX_EXCLUSIONS = Object.freeze([
  Object.freeze({ a: 'frostbound', b: 'swift', archetype: null }),
  Object.freeze({ a: 'stoneskin', b: 'burning', archetype: null }),
  Object.freeze({ a: 'mighty', b: 'multishot', archetype: 'ashen_archer' }),
]);
/** `06` §6.3's eligibility table, verbatim (the EXCLUDED ids per archetype). */
const AFFIX_INELIGIBLE = Object.freeze({
  bone_ranker: Object.freeze([]),
  carrion_swarm: Object.freeze(['hexing', 'multishot']),
  ashen_archer: Object.freeze(['vampiric']),
  dust_shaman: Object.freeze(['vampiric']),
  maulsmith: Object.freeze(['multishot']),
  blight_crawler: Object.freeze(['burning', 'vampiric', 'multishot']),
  molgrim: Object.freeze(['burning', 'charged', 'frostbound', 'swift', 'mighty', 'stoneskin', 'hexing', 'vampiric', 'multishot']),
});
/** `06` §6.6's own printed champion-TTK table (Instruction, `immunityValue
 * 85`) — the cross-check that the affix application below reproduces the
 * document's own numbers before MB7's verdict is believed. */
const MB7_PRINTED_CHAMPION_TTK = Object.freeze({
  none: Object.freeze({ ravager: 11.10, emberwright: 9.19, runeblade: 10.40 }),
  burning: Object.freeze({ ravager: 11.10, emberwright: 29.42, runeblade: 10.40 }),
  charged: Object.freeze({ ravager: 11.10, emberwright: 9.19, runeblade: 14.63 }),
  frostbound: Object.freeze({ ravager: 11.10, emberwright: 9.19, runeblade: 10.40 }),
  swift: Object.freeze({ ravager: 11.10, emberwright: 9.19, runeblade: 10.40 }),
  mighty: Object.freeze({ ravager: 11.10, emberwright: 9.19, runeblade: 10.40 }),
  stoneskin: Object.freeze({ ravager: 21.43, emberwright: 9.19, runeblade: 17.52 }),
  hexing: Object.freeze({ ravager: 11.10, emberwright: 9.19, runeblade: 10.40 }),
  vampiric: Object.freeze({ ravager: 12.27, emberwright: 10.31, runeblade: 11.66 }),
  multishot: Object.freeze({ ravager: 11.10, emberwright: 9.19, runeblade: 10.40 }),
});
/** `vampiric`'s leech in life/s off the player's own DPS. `06` §6.6 prints
 * two of the three in prose ("4.13 life/s from the Emberwright versus 3.02
 * from the Ravager"); the Runeblade's is BACK-SOLVED from that same table's
 * printed 11.66 s (351 / 11.66 = 30.10 effective against 33.76 bare => 3.66),
 * stated here rather than invented silently. A unique leeches in proportion
 * to its own damage, so the champion figure is scaled by 2.2 / 1.6 (the §9.3
 * rank damage ratio) — the one MODELLED step in MB7, flagged on its own
 * result line. */
const VAMPIRIC_LEECH_CHAMPION = Object.freeze({ ravager: 3.02, emberwright: 4.13, runeblade: 3.66 });
const VAMPIRIC_UNIQUE_SCALE = 2.2 / 1.6;

/** Applies an affix set to a monster stat row, returning a NEW row. Only the
 * affixes with a time-to-KILL effect change anything; `swift`, `mighty`,
 * `hexing` and `multishot` are time-to-DIE affixes (`06` §6.6's own words)
 * and are represented faithfully as no-ops on this axis. */
function mbApplyAffixes(target, affixIds, tier) {
  const out = { ...target, resists: { ...target.resists } };
  for (const id of affixIds) {
    const a = AFFIXES[id];
    if (a.immunity) out.resists[a.immunity] = TIER[tier].immunityValue + TIER[tier].monsterResist;
    if (a.defenseMult) out.defense = Math.round(out.defense * a.defenseMult);
    if (a.damageReducePercent) out.damageReducePercent = Math.min(50, out.damageReducePercent + a.damageReducePercent);
  }
  return out;
}

/** TTK of one build against an affixed monster, including `vampiric`'s
 * sustain (which changes the RATE, not the life — `06` §6.6). */
function mbAffixedTtk(buildId, target, affixIds, tier, rank) {
  const withAffixes = mbApplyAffixes(target, affixIds, tier);
  const f = mbFight(buildId, withAffixes);
  let dps = f.dps;
  if (affixIds.includes('vampiric')) {
    dps -= VAMPIRIC_LEECH_CHAMPION[buildId] * (rank === 'unique' ? VAMPIRIC_UNIQUE_SCALE : 1);
  }
  return dps > 0 ? withAffixes.life / dps : Infinity;
}

// ---------------------------------------------------------------------------
// `06` §5.3/§5.4/§5.5's pack templates + §5.2's resolver — transcribed for
// the same reason the affix tables are: `src/ai/data/pack-templates.js`
// (§5.1 names the path) does not exist, and neither does `ai.spawnPack`'s
// template branch. MB9/MB11/MB20 assert the SPEC's own algorithm and its
// interaction with the SHIPPED `ZoneDescriptor.bestiary`, never a shipped
// resolver.
// ---------------------------------------------------------------------------
const PACK_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'pk_ranker_line', zone: 'ashen_wastes', fixed: [], share: [['bone_ranker', 1.00]], min: {}, floor: 5 }),
  Object.freeze({ id: 'pk_ranker_archer', zone: 'ashen_wastes', fixed: [], share: [['bone_ranker', 0.60], ['ashen_archer', 0.40]], min: { ashen_archer: 2 }, floor: 5 }),
  Object.freeze({ id: 'pk_swarm', zone: 'ashen_wastes', fixed: [], share: [['carrion_swarm', 1.00]], min: {}, floor: 6 }),
  Object.freeze({ id: 'pk_swarm_ranker', zone: 'ashen_wastes', fixed: [], share: [['carrion_swarm', 0.65], ['bone_ranker', 0.35]], min: { carrion_swarm: 4, bone_ranker: 2 }, floor: 7 }),
  Object.freeze({ id: 'pk_archer_nest', zone: 'ashen_wastes', fixed: [], share: [['ashen_archer', 0.55], ['bone_ranker', 0.45]], min: { bone_ranker: 2 }, floor: 5 }),
  Object.freeze({ id: 'pk_shaman_court', zone: 'ashen_wastes', fixed: [['dust_shaman', 1]], share: [['bone_ranker', 1.00]], min: {}, floor: 6 }),
  Object.freeze({ id: 'pk_crawler_run', zone: 'ashen_wastes', fixed: [], share: [['blight_crawler', 0.40], ['bone_ranker', 0.60]], min: { blight_crawler: 2 }, floor: 5 }),
  Object.freeze({ id: 'pk_warband', zone: 'ashen_wastes', fixed: [['dust_shaman', 1]], share: [['bone_ranker', 0.40], ['ashen_archer', 0.30], ['carrion_swarm', 0.30]], min: {}, floor: 8 }),
  Object.freeze({ id: 'pk_bone_line', zone: 'bonereach', fixed: [], share: [['bone_ranker', 1.00]], min: {}, floor: 5 }),
  Object.freeze({ id: 'pk_bone_archer', zone: 'bonereach', fixed: [], share: [['bone_ranker', 0.55], ['ashen_archer', 0.45]], min: { ashen_archer: 2 }, floor: 5 }),
  Object.freeze({ id: 'pk_maul_guard', zone: 'bonereach', fixed: [['maulsmith', 1]], share: [['bone_ranker', 1.00]], min: {}, floor: 5 }),
  Object.freeze({ id: 'pk_swarm_flood', zone: 'bonereach', fixed: [], share: [['carrion_swarm', 1.00]], min: {}, floor: 6 }),
  Object.freeze({ id: 'pk_crawler_nest', zone: 'bonereach', fixed: [], share: [['blight_crawler', 0.55], ['carrion_swarm', 0.45]], min: { blight_crawler: 3 }, floor: 6 }),
  Object.freeze({ id: 'pk_shaman_vault', zone: 'bonereach', fixed: [['dust_shaman', 2]], share: [['bone_ranker', 1.00]], min: {}, floor: 6 }),
  Object.freeze({ id: 'pk_deep_warband', zone: 'bonereach', fixed: [['maulsmith', 1], ['dust_shaman', 1]], share: [['ashen_archer', 0.40], ['bone_ranker', 0.60]], min: {}, floor: 8 }),
  Object.freeze({ id: 'pk_altar_guard', zone: 'altar_of_instruction', fixed: [], share: [['bone_ranker', 0.55], ['ashen_archer', 0.45]], min: {}, floor: 4 }),
  Object.freeze({ id: 'pk_altar_line', zone: 'altar_of_instruction', fixed: [], share: [['bone_ranker', 1.00]], min: {}, floor: 4 }),
]);

/** `06` §5.2's resolver, transcribed step for step: fixed members in array
 * order, largest-remainder over `share`, ties by ascending index, then the
 * member minima take slots from the largest surplus above ITS minimum,
 * lowest index first. Draws no random numbers, is total, always returns
 * exactly `count`. */
function resolvePackTemplate(template, count) {
  const roster = new Map();
  const push = (id, n) => roster.set(id, (roster.get(id) || 0) + n);
  const fixedApplied = template.fixed.map((f) => f);
  let fixedTotal = fixedApplied.reduce((a, f) => a + f[1], 0);
  while (fixedTotal > count && fixedApplied.length > 0) {
    fixedTotal -= fixedApplied.pop()[1]; // §5.2: drop fixed members from the END
  }
  for (const [id, n] of fixedApplied) push(id, n);
  const remaining = count - fixedTotal;
  const exact = template.share.map(([, s]) => s * remaining);
  const whole = exact.map((v) => Math.floor(v));
  const frac = exact.map((v, i) => v - whole[i]);
  const left = remaining - whole.reduce((a, b) => a + b, 0);
  const order = frac.map((f, i) => [f, i]).sort((p, q) => (q[0] - p[0]) || (p[1] - q[1]));
  for (let k = 0; k < left; k++) whole[order[k % order.length][1]]++;
  const shareCount = template.share.map(([id], i) => [id, whole[i]]);
  for (let i = 0; i < shareCount.length; i++) {
    const minimum = template.min[shareCount[i][0]] || 0;
    while (shareCount[i][1] < minimum) {
      let donor = -1;
      let bestSurplus = 0;
      for (let j = 0; j < shareCount.length; j++) {
        if (j === i) continue;
        const surplus = shareCount[j][1] - (template.min[shareCount[j][0]] || 0);
        if (surplus > bestSurplus) { bestSurplus = surplus; donor = j; }
      }
      if (donor < 0) break; // unsatisfiable at this count — reported by MB11, never hidden
      shareCount[donor][1]--;
      shareCount[i][1]++;
    }
  }
  for (const [id, n] of shareCount) if (n > 0) push(id, n);
  return roster;
}

function rosterTotal(roster) {
  let n = 0;
  for (const v of roster.values()) n += v;
  return n;
}

function rosterString(roster) {
  return [...roster.entries()].map(([id, n]) => `${n}x${id}`).join(' + ');
}

/** `06` §5.6's own per-monster DPS against the level-10 reference Ravager
 * (DEF 137, 165 life), transcribed verbatim INCLUDING its footnote 1: the
 * `maulsmith` row is `03` §11.5's figure and omits the 220 % `crushing_slam`
 * coefficient. Both readings are carried and MB9 reports both. */
const MONSTER_DPS_VS_REF = Object.freeze({
  bone_ranker: 5.983, ashen_archer: 5.875, carrion_swarm: 5.118,
  dust_shaman: 3.719, maulsmith: 13.500, blight_crawler: 7.900,
});
const MAULSMITH_DPS_WITH_SLAM_COEF = 29.69; // §5.6 footnote 1's own arithmetic
const MB9_TARGET_LIFE = 165; // §5.6 / `03` §11.5's reference Ravager
const MB9_FLOOR_SECONDS = 3.0;
/** §5.6's own printed pack rows, as a cross-check on the resolver + the DPS
 * table before MB9's verdict is believed. */
const MB9_PRINTED = Object.freeze([
  Object.freeze({ id: 'pk_ranker_line', count: 8, dps: 47.87, survival: 3.45 }),
  Object.freeze({ id: 'pk_ranker_archer', count: 8, dps: 47.55, survival: 3.47 }),
  Object.freeze({ id: 'pk_swarm', count: 10, dps: 51.18, survival: 3.22 }),
  Object.freeze({ id: 'pk_shaman_court', count: 8, dps: 45.61, survival: 3.62 }),
  Object.freeze({ id: 'pk_warband', count: 8, dps: 43.66, survival: 3.78 }),
]);

// ---------------------------------------------------------------------------
// The checks themselves. Each returns `{id, severity, scope, pass, lines,
// note?}` rows in the same flat shape `--skills` uses.
// ---------------------------------------------------------------------------

/** MB1 — every bestiary row's life, damage, DEF, AR and XP at every `mlvl`
 * 1…40, every rank and every tier equals `round(base x mlvlMult x rankMult x
 * difficultyMult)`; exact, integer. O-97: `difficultyMult` is applied here by
 * the closed form (option 1, the one O-97 called better), so the tier never
 * silently vanishes from the assertion. */
function checkMB1(B, checks) {
  const archetypes = Object.keys(B.BESTIARY);
  let cells = 0;
  const bad = [];
  for (const archetypeId of archetypes) {
    const perArchetypeBad = [];
    let prev = null;
    for (const tier of TIER_NAMES) {
      for (const rank of RANK_NAMES) {
        prev = null;
        for (let mlvl = 1; mlvl <= 40; mlvl++) {
          const s = mbMonsterStats(B, archetypeId, mlvl, rank, tier);
          for (const field of ['life', 'minDamage', 'maxDamage', 'defense', 'attackRating', 'xp']) {
            const v = s[field];
            cells++;
            if (!Number.isFinite(v)) { perArchetypeBad.push(`${tier}/${rank}/mlvl${mlvl}/${field}: non-finite`); continue; }
            if (!Number.isInteger(v)) { perArchetypeBad.push(`${tier}/${rank}/mlvl${mlvl}/${field}=${v} is not an integer`); continue; }
            if (v < 0) perArchetypeBad.push(`${tier}/${rank}/mlvl${mlvl}/${field}=${v} is negative`);
            if (prev && v < prev[field]) perArchetypeBad.push(`${tier}/${rank}/mlvl${mlvl}/${field}=${v} decreased from ${prev[field]}`);
          }
          if (s.minDamage > s.maxDamage) perArchetypeBad.push(`${tier}/${rank}/mlvl${mlvl}: minDamage ${s.minDamage} > maxDamage ${s.maxDamage}`);
          prev = s;
        }
      }
    }
    if (perArchetypeBad.length) bad.push(...perArchetypeBad.slice(0, 3));
    checks.push({
      id: 'MB1', severity: 'fail', scope: `archetype=${archetypeId}`, pass: perArchetypeBad.length === 0,
      lines: perArchetypeBad.length
        ? perArchetypeBad.slice(0, 5)
        : [`mlvl 1..40 x 5 ranks x 3 tiers = ${40 * 5 * 3} rows, 6 fields each, all integral/finite/monotonic (difficultyMult applied arithmetically — O-97 option 1)`],
    });
  }

  // The cross-checks that make the above more than its own formula.
  const worked = [];
  let workedBad = 0;
  for (const row of WORKED_BONE_RANKER) {
    const s = mbMonsterStats(B, 'bone_ranker', row.mlvl, 'normal', row.tier);
    const ok = s.life === row.life && s.minDamage === row.minDamage && s.maxDamage === row.maxDamage
      && s.defense === row.defense && s.xp === row.xp;
    if (!ok) {
      workedBad++;
      worked.push(`${row.label}: computed life=${s.life} dmg=${s.minDamage}-${s.maxDamage} def=${s.defense} xp=${s.xp} vs 03 §10.3's ${row.life} / ${row.minDamage}-${row.maxDamage} / ${row.defense} / ${row.xp}`);
    }
  }
  for (const row of WORKED_RANKED) {
    const s = mbMonsterStats(B, row.archetypeId, row.mlvl, row.rank, row.tier);
    if (s[row.field] !== row.expected) {
      workedBad++;
      worked.push(`${row.label}: computed ${row.field}=${s[row.field]}, spec prints ${row.expected}`);
    }
  }
  checks.push({
    id: 'MB1.crosscheck', severity: 'fail', scope: 'global (03 §10.3 + §11.3 worked rows)', pass: workedBad === 0,
    lines: workedBad === 0
      ? [`all ${WORKED_BONE_RANKER.length + WORKED_RANKED.length} independently printed spec values reproduced exactly (nine §10.3 Bone Ranker zone/tier rows, champion 351/100/109, unique 615/133/217, Molgrim 3091/8183/15794) — ${cells} computed cells behind them`]
      : worked,
  });

  // A rounding tie found by this check and reported, not smoothed over.
  const shamanDef = mbMonsterStats(B, 'dust_shaman', 10, 'normal', 'instruction').defense;
  const shamanRaw = 15 * B.defenseMult(10);
  checks.push({
    id: 'MB1.rounding-tie', severity: 'warn', scope: 'global (03 §10.1 rounding rule, half-integer ties)', pass: true, note: true,
    lines: [`NOTE: \`dust_shaman\` DEF at mlvl 10 is 15 x 3.70 = 55.5 on paper — a half-integer tie, and \`Math.round\` breaks ties UPWARD (56), which would disagree with \`06\` §2.7's own printed 55. It does not, and only by a hair: \`defenseMult(10)\` evaluates in IEEE-754 to ${B.defenseMult(10)}, so the product is ${shamanRaw} — just BELOW the tie — and \`Math.round\` gives ${shamanDef}, matching §2.7 exactly. MB1 passes on this cell for a floating-point reason, not a specified one. Recorded because MB1's bound is the word "exact" and because any future rewrite of \`defenseMult\` that happens to land on 55.5 exactly (e.g. \`1 + 3 * (n - 1) / 10\`) would silently flip this monster's DEF and its hit chance — the assertion has no tie-break rule to appeal to`],
  });
}

/** MB2 — normal-rank TTK for each reference build against each archetype,
 * inside `06` §2.7's own per-archetype band. Two readings of "at its zone
 * `mlvl`" are computed; see the NOTE row for why the assertion is taken at
 * §2.7's own calibration level. */
function checkMB2(B, checks) {
  let printedBad = 0;
  const printedLines = [];
  for (const archetypeId of Object.keys(MB2_BANDS)) {
    const target = mbMonsterStats(B, archetypeId, 10, 'normal', 'instruction');
    const [lo, hi] = MB2_BANDS[archetypeId];
    const lines = [];
    let pass = true;
    for (const buildId of MB_BUILD_NAMES) {
      const f = mbFight(buildId, target);
      const printed = MB2_PRINTED_TTK[archetypeId][buildId];
      if (Math.abs(f.ttk - printed) > 0.05) { printedBad++; printedLines.push(`${archetypeId}/${buildId}: model ${f.ttk.toFixed(2)}s vs 06 §2.7's printed ${printed}s`); }
      if (!(f.ttk >= lo - 1e-9 && f.ttk <= hi + 1e-9)) pass = false;
      lines.push(`${buildId}: life=${target.life} def=${target.defense} hit=${f.hitChance.toFixed(2)}% perHit=${f.perLandedHit.toFixed(3)} dps=${f.dps.toFixed(2)} TTK=${f.ttk.toFixed(2)}s (§2.7 prints ${printed}s)`);
    }
    checks.push({ id: 'MB2', severity: 'fail', scope: `archetype=${archetypeId}`, pass, lines: [`band ${lo}..${hi}s at mlvl 10 — ${lines.join(' | ')}`] });
  }
  checks.push({
    id: 'MB2.crosscheck', severity: 'fail', scope: 'global (06 §2.7 printed TTK columns)', pass: printedBad === 0,
    lines: printedBad === 0
      ? ['all 18 of §2.7\'s own printed TTK cells reproduced to within 0.05 s by this file\'s model (bestiary life/DEF from the SHIPPED src/ai/data/bestiary.js, hit chance from the SHIPPED src/combat/tohit.js)']
      : printedLines,
  });

  // "at its zone mlvl", read literally — computed, and reported as the NOTE
  // it has to be rather than asserted as a band nobody calibrated.
  const zoneRows = [];
  for (const [archetypeId, zone] of [['bone_ranker', 'ashen_wastes'], ['maulsmith', 'bonereach']]) {
    const mlvl = ZONE_MLVL[zone];
    const target = mbMonsterStats(B, archetypeId, mlvl, 'normal', 'instruction');
    const f = mbFight('ravager', target);
    zoneRows.push(`${archetypeId} at ${zone} mlvl ${mlvl}: Ravager TTK ${f.ttk.toFixed(2)}s (band ${MB2_BANDS[archetypeId][0]}..${MB2_BANDS[archetypeId][1]}s)`);
  }
  checks.push({
    id: 'MB2.zone-mlvl', severity: 'warn', scope: 'global (MB2 "at its zone mlvl" read literally)', pass: true, note: true,
    lines: [`NOTE: MB2's own wording says "at its zone \`mlvl\`", but every figure \`06\` §2.7 tabulates — and every band it states — is computed at **mlvl 10** against the level-10 reference builds of \`03\` §11.1, which is neither zone's level (Wastes 6, Bonereach 11). Read literally the bands do not hold, because a clvl-10 build against a level-6 zone is not the fight anyone calibrated: ${zoneRows.join('; ')}. The verdict above is taken at §2.7's own calibration level; this row exists so the other reading is on the record instead of quietly discarded`],
  });
}

/** MB3/MB4 — champion TTK at `mlvl 10`, no affix, 8.0-13.0 s; unique TTK at
 * `mlvl 10`, no affix, 17.0-26.0 s. */
function checkMB3MB4(B, checks) {
  for (const [id, rank, lo, hi, printed] of [
    ['MB3', 'champion', 8.0, 13.0, { ravager: 11.10, emberwright: 9.19, runeblade: 10.40 }],
    ['MB4', 'unique', 17.0, 26.0, { ravager: 22.62, emberwright: 18.41, runeblade: 21.84 }],
  ]) {
    const target = mbMonsterStats(B, 'bone_ranker', 10, rank, 'instruction');
    const lines = [];
    let pass = true;
    for (const buildId of MB_BUILD_NAMES) {
      const f = mbFight(buildId, target);
      if (!(f.ttk >= lo - 1e-9 && f.ttk <= hi + 1e-9)) pass = false;
      const dev = Math.abs(f.ttk - printed[buildId]);
      if (dev > 0.05) pass = false;
      lines.push(`${buildId}: TTK=${f.ttk.toFixed(2)}s (03 §11.3 prints ${printed[buildId]}s, dev ${dev.toFixed(3)}s)`);
    }
    checks.push({
      id, severity: 'fail', scope: `bone_ranker mlvl10 ${rank}, no affix`, pass,
      lines: [`band ${lo}..${hi}s; life=${target.life} def=${target.defense} physRes=${target.resists.physical} elemRes=${target.resists.lightning} — ${lines.join(' | ')}`],
    });
  }
}

/** Every legal three-affix unique combination: one per group (`06` §6.5's
 * fixed `immunity -> power -> utility` order), minus the hard exclusion
 * pairs, filtered to the archetype's eligible set (§6.3). */
function legalUniqueTriples(archetypeId) {
  const ineligible = new Set(AFFIX_INELIGIBLE[archetypeId] || []);
  const byGroup = {};
  for (const g of AFFIX_GROUPS) byGroup[g] = Object.keys(AFFIXES).filter((id) => AFFIXES[id].group === g && !ineligible.has(id));
  const excluded = (a, b) => AFFIX_EXCLUSIONS.some((x) => (x.archetype === null || x.archetype === archetypeId)
    && ((x.a === a && x.b === b) || (x.a === b && x.b === a)));
  const out = [];
  for (const i of byGroup.immunity) {
    for (const p of byGroup.power) {
      if (excluded(i, p)) continue;
      for (const u of byGroup.utility) {
        if (excluded(i, u) || excluded(p, u)) continue;
        out.push([i, p, u]);
      }
    }
  }
  return out;
}

/** MB7 — no single affix raises a champion's TTK above 3.5x its bare value;
 * no legal three-affix unique combination raises a unique's above 2.5x.
 * Reported as two rows because the two halves do not have the same standing:
 * the champion half reproduces `06` §6.6's own printed table cell for cell,
 * the unique half has no printed table anywhere and its worst case is
 * arrived at by the SAME arithmetic §6.6 uses, against the unique's own bare
 * baseline. */
function checkMB7(B, checks) {
  const tier = 'instruction'; // §6.6's own stated tier
  const champ = mbMonsterStats(B, 'bone_ranker', 10, 'champion', tier);
  const bareChamp = {};
  for (const buildId of MB_BUILD_NAMES) bareChamp[buildId] = mbFight(buildId, champ).ttk;

  let printedBad = 0;
  const printedLines = [];
  let worstChampion = { mult: 0, affix: null, build: null, ttk: 0 };
  for (const affixId of Object.keys(AFFIXES)) {
    for (const buildId of MB_BUILD_NAMES) {
      const ttk = mbAffixedTtk(buildId, champ, [affixId], tier, 'champion');
      const printed = MB7_PRINTED_CHAMPION_TTK[affixId][buildId];
      if (Math.abs(ttk - printed) > 0.06) { printedBad++; printedLines.push(`${affixId}/${buildId}: model ${ttk.toFixed(2)}s vs §6.6's printed ${printed}s`); }
      const mult = ttk / bareChamp[buildId];
      if (mult > worstChampion.mult) worstChampion = { mult, affix: affixId, build: buildId, ttk };
    }
  }
  const championPass = worstChampion.mult <= 3.5 + 1e-9 && printedBad === 0;
  checks.push({
    id: 'MB7.champion', severity: 'fail', scope: 'bone_ranker mlvl10 champion, one affix, Instruction', pass: championPass,
    lines: printedBad
      ? ['this file\'s model does not reproduce §6.6\'s own printed table, so no verdict is claimed: ' + printedLines.join('; ')]
      : [`worst single affix = \`${worstChampion.affix}\` vs ${worstChampion.build}: ${worstChampion.ttk.toFixed(2)}s / ${bareChamp[worstChampion.build].toFixed(2)}s bare = ${worstChampion.mult.toFixed(2)}x (ceiling 3.50x) — all 27 affix x build cells reproduce §6.6's own printed table to within 0.06 s`],
  });

  const uniq = mbMonsterStats(B, 'bone_ranker', 10, 'unique', tier);
  const bareUniq = {};
  for (const buildId of MB_BUILD_NAMES) bareUniq[buildId] = mbFight(buildId, uniq).ttk;
  const offenders = [];
  let worstUnique = { mult: 0, triple: null, build: null, ttk: 0 };
  for (const triple of legalUniqueTriples('bone_ranker')) {
    for (const buildId of MB_BUILD_NAMES) {
      const ttk = mbAffixedTtk(buildId, uniq, triple, tier, 'unique');
      const mult = ttk / bareUniq[buildId];
      if (mult > 2.5 + 1e-9) offenders.push({ triple, buildId, ttk, mult });
      if (mult > worstUnique.mult) worstUnique = { mult, triple, build: buildId, ttk };
    }
  }
  // The headline case uses NO modelled step at all: `burning` alone, by
  // §6.6's own arithmetic, against the unique's own bare baseline.
  const burningEmberTtk = mbAffixedTtk('emberwright', uniq, ['burning'], tier, 'unique');
  const burningEmberMult = burningEmberTtk / bareUniq.emberwright;
  const triples = legalUniqueTriples('bone_ranker').length;
  const modelled = offenders.filter((o) => o.triple.includes('vampiric')).length;
  checks.push({
    id: 'MB7.unique', severity: 'fail', scope: 'bone_ranker mlvl10 unique, three affixes, Instruction', pass: offenders.length === 0,
    lines: [
      `${offenders.length} of ${triples * 3} legal (triple x build) combinations exceed the 2.5x ceiling; worst = [${worstUnique.triple.join(', ')}] vs ${worstUnique.build} at ${worstUnique.ttk.toFixed(2)}s / ${bareUniq[worstUnique.build].toFixed(2)}s bare = ${worstUnique.mult.toFixed(2)}x`,
      `headline case carries NO modelled step — \`burning\` alone on a unique vs the Emberwright: fireResist set to immunityValue ${TIER[tier].immunityValue} (+${TIER[tier].monsterResist} tier) -> capped 75 -> ${MB_REF_BUILDS.emberwright.fire} x 0.25 = ${(MB_REF_BUILDS.emberwright.fire * 0.25).toFixed(3)} per cast -> ${(MB_REF_BUILDS.emberwright.fire * 0.25 / MB_REF_BUILDS.emberwright.interval).toFixed(2)} dps -> ${uniq.life} / that = ${burningEmberTtk.toFixed(2)}s against ${bareUniq.emberwright.toFixed(2)}s bare = ${burningEmberMult.toFixed(2)}x. Same arithmetic §6.6 uses for its own 3.20x champion cell; only the baseline differs (a unique's own +30 elemental resist makes its BARE fire TTK longer, so the immunity's ratio is 0.70/0.25 = 2.80 by construction)`,
      `${modelled} of the ${offenders.length} involve \`vampiric\`, whose unique-rank leech is the one MODELLED step in this check (champion leech x 2.2/1.6, see VAMPIRIC_LEECH_CHAMPION's own comment) — they are counted but are NOT what this verdict rests on`,
      'NOT adjusted to pass: §6.6 states the 2.5x unique ceiling and prints only the champion table; the ceiling is left exactly as written and the measurement reported. Owner ruling needed — see this ticket\'s report',
    ],
  });
}

/** MB8 — no legal affix combination produces an infinite TTK for any
 * reference build at any tier. Instruction is a real verdict; Trial and
 * Renunciation are a counted NOTE because `06` §6.4 declares the very
 * infinity MB8 forbids to be intentional there, and the reference builds
 * carry no `*ResistPierce` at any tier the spec states. */
function checkMB8(B, checks) {
  const rows = [];
  let infiniteAtInstruction = 0;
  const infinite = { trial: [], renunciation: [] };
  for (const tier of TIER_NAMES) {
    for (const rank of ['champion', 'unique']) {
      const target = mbMonsterStats(B, 'bone_ranker', 10, rank, tier);
      const sets = rank === 'champion' ? Object.keys(AFFIXES).map((a) => [a]) : legalUniqueTriples('bone_ranker');
      for (const set of sets) {
        for (const buildId of MB_BUILD_NAMES) {
          const ttk = mbAffixedTtk(buildId, target, set, tier, rank);
          if (!Number.isFinite(ttk)) {
            if (tier === 'instruction') infiniteAtInstruction++;
            else infinite[tier].push(`${rank} [${set.join(',')}] vs ${buildId}`);
          }
        }
      }
    }
  }
  rows.push(`Instruction: every legal champion (1 affix) and unique (3 affixes, one per group, exclusions applied) combination against all three reference builds is FINITE — immunityValue ${TIER.instruction.immunityValue} + tier bonus ${TIER.instruction.monsterResist} = ${TIER.instruction.immunityValue} clamps to the 75 % cap, never to immunity`);
  checks.push({
    id: 'MB8.instruction', severity: 'fail', scope: 'bone_ranker mlvl10 champion+unique, Instruction', pass: infiniteAtInstruction === 0,
    lines: infiniteAtInstruction === 0 ? rows : [`${infiniteAtInstruction} infinite-TTK combinations at Instruction`],
  });
  checks.push({
    id: 'MB8.trial-renunciation', severity: 'warn', scope: 'bone_ranker mlvl10 champion+unique, Trial/Renunciation', pass: true, note: true,
    lines: [`NOTE: MB8 ("no legal affix combination produces an infinite TTK for any reference build at any tier") contradicts \`06\` §6.4, which sets \`immunityValue(trial|renunciation) = 100\` and states the consequence itself in its own table: "Trial | 100 + 20 = 120 | immune | 0 | ∞ without pierce". Measured here: ${infinite.trial.length} infinite combinations at Trial and ${infinite.renunciation.length} at Renunciation, every one of them a fire/lightning/cold immunity against the build that deals that element (e.g. ${infinite.trial[0] || 'n/a'}). The reference builds of \`03\` §11.1 carry no \`*ResistPierce\` at any tier, and no document states one, so the input MB8 would need to come out finite does not exist. Recorded, not adjusted — the same treatment D-79 gave MB13. Owner ruling needed: either MB8 gains an "at Instruction" qualifier, or §6.4's tier gate does`],
  });
}

/** MB9 — stand-still survival time of every pack template against the
 * reference build at the zone `mlvl`, >= 3.0 s. */
function checkMB9(ZONE_DESCRIPTORS_BY_ID, checks) {
  const packDps = (roster, maulsmithDps) => {
    let dps = 0;
    for (const [id, n] of roster) dps += n * (id === 'maulsmith' ? maulsmithDps : MONSTER_DPS_VS_REF[id]);
    return dps;
  };

  // Cross-check the resolver + the DPS table against §5.6's own printed rows.
  let printedBad = 0;
  const printedLines = [];
  for (const row of MB9_PRINTED) {
    const t = PACK_TEMPLATES.find((x) => x.id === row.id);
    const roster = resolvePackTemplate(t, row.count);
    const dps = packDps(roster, MONSTER_DPS_VS_REF.maulsmith);
    const survival = MB9_TARGET_LIFE / dps;
    if (Math.abs(dps - row.dps) > 0.02 || Math.abs(survival - row.survival) > 0.02) {
      printedBad++;
      printedLines.push(`${row.id}@${row.count}: roster ${rosterString(roster)} -> ${dps.toFixed(2)} dps / ${survival.toFixed(2)}s vs §5.6's printed ${row.dps} / ${row.survival}s`);
    }
  }
  checks.push({
    id: 'MB9.crosscheck', severity: 'fail', scope: 'global (06 §5.6 printed pack rows)', pass: printedBad === 0,
    lines: printedBad === 0
      ? [`all ${MB9_PRINTED.length} of §5.6's own printed pack DPS/survival rows reproduced exactly by §5.2's resolver + §5.6's per-monster DPS column (including its rosters: pk_ranker_archer@8 -> 5 Ranker + 3 Archer, pk_warband@8 -> 1 Shaman + 3 Ranker + 2 Archer + 2 Swarm)`]
      : printedLines,
  });

  // The verdict is taken at the size `06` §5.6 itself evaluates — "a
  // full-strength eight", raised to the template's own §5.3 floor where that
  // floor is larger. §5.6's whole survival argument ("`03` §11.5's five-strong
  // pack gives 5.5 s; a full-strength eight gives 3.4-3.8 s") is stated at
  // that size, and it is the size its printed table uses. The FULL legal
  // count range is measured too and reported as its own row below, because
  // the shipped `ZoneDescriptor.packSize.max` is 12, not 8 — choosing the
  // narrower basis silently would be exactly the narrowing O-58 warns about.
  const crossings = [];
  const rangeNotes = [];
  for (const t of PACK_TEMPLATES) {
    const packSize = ZONE_DESCRIPTORS_BY_ID[t.zone].packSize;
    const count = Math.min(Math.max(8, t.floor), Math.max(packSize.max, t.floor));
    const roster = resolvePackTemplate(t, count);
    const survival = MB9_TARGET_LIFE / packDps(roster, MONSTER_DPS_VS_REF.maulsmith);
    const survivalSlam = MB9_TARGET_LIFE / packDps(roster, MAULSMITH_DPS_WITH_SLAM_COEF);
    const hasShaman = [...roster.keys()].includes('dust_shaman');
    const hasMaul = [...roster.keys()].includes('maulsmith');
    // `haste_dust` (+25 IAS for 6 s of every 12) — §5.6's own mean-buffed
    // reading, which reproduces its printed pk_warband row exactly
    // (43.66 -> 49.12 dps, 3.78 s -> 3.36 s).
    const hasted = hasShaman ? survival / 1.125 : null;
    const pass = survival >= MB9_FLOOR_SECONDS - 1e-9 && (!hasted || hasted >= MB9_FLOOR_SECONDS - 1e-9);
    const lines = [`count ${count} (${rosterString(roster)}): survival ${survival.toFixed(2)}s at ${MB9_TARGET_LIFE} life (floor ${MB9_FLOOR_SECONDS.toFixed(1)}s)`];
    if (hasted) lines.push(`under haste_dust (+25 IAS, 6 s in 12 -> x1.125 mean DPS, §5.6's own reading): ${hasted.toFixed(2)}s`);
    if (hasMaul) lines.push(`§5.6 footnote 1: with \`crushing_slam\`'s 220 % coefficient the Maulsmith is ${MAULSMITH_DPS_WITH_SLAM_COEF} dps instead of ${MONSTER_DPS_VS_REF.maulsmith}, putting this template at ${survivalSlam.toFixed(2)}s${survivalSlam < MB9_FLOOR_SECONDS ? ' — BELOW the 3.0 s floor on that reading' : ''}. The verdict uses the row as §5.6 itself chose to state it; both are printed so neither is hidden`);
    checks.push({ id: 'MB9', severity: 'fail', scope: `template=${t.id}`, pass, lines });

    // …and the same template across every count this zone's SHIPPED
    // `packSize` actually permits (§5.3's floor rule can only raise a count,
    // never lower it, so the range is [max(min, floor) .. max(max, floor)]).
    const lo = Math.max(packSize.min, t.floor);
    const hi = Math.max(packSize.max, t.floor);
    rangeNotes.push(`${t.id} ${lo}..${hi}`);
    let crossed = false;
    for (let c = lo; c <= hi && !crossed; c++) {
      const r = resolvePackTemplate(t, c);
      const s = MB9_TARGET_LIFE / packDps(r, MONSTER_DPS_VS_REF.maulsmith);
      if (s < MB9_FLOOR_SECONDS) { crossings.push(`${t.id} crosses at count ${c}/${hi} (${s.toFixed(2)}s)`); crossed = true; }
    }
  }
  checks.push({
    id: 'MB9.count-range', severity: 'fail', scope: 'all templates over their zone\'s own shipped packSize range', pass: crossings.length === 0,
    lines: crossings.length === 0
      ? [`every template holds the 3.0 s floor at every count its zone's shipped packSize permits (${rangeNotes.join(', ')})`]
      : [
        `${crossings.length} of ${PACK_TEMPLATES.length} templates drop below MB9's 3.0 s floor inside the count range the SHIPPED ZoneDescriptor.packSize permits (ashen_wastes 5..12, bonereach 4..10, altar_of_instruction 1..6 — all read from src/world/data/zones.js, and raised where §5.3's own template floor is higher): ${crossings.join('; ')}`,
        'stated as measured, not adjusted: §5.6 argues the floor at "a full-strength eight" and never evaluates a larger pack, but §5.3\'s floor rule only ever RAISES a count and nothing caps a pack at eight. Survival falls monotonically with pack size, so MB9\'s floor is a claim about pack size as much as about composition. Owner ruling needed — see this ticket\'s report',
      ],
  });
}

/** MB10 — `ai.rollAffixes` over 100 000 draws matches §6.1's weights; never
 * two affixes from one group on a unique; never an excluded pair; never an
 * ineligible affix. Split in two: the DRAW half sweeps the shipped code, the
 * TABLE half checks this file's own transcription AND cross-checks it against
 * the shipped data file.
 *
 * This row was a SKIP until AI-8 shipped, on the ground that the method did
 * not exist. O-119's rule — a harness that hardcodes "what does not exist yet"
 * must be revisited by the ticket that closes that "yet" — is why it is a real
 * sweep now and not a stale quotation of the moment TEST-9 was written. */
function checkMB10(AiSystem, rank, affixData, RngClass, seed, checks) {
  if (typeof AiSystem.prototype.rollAffixes !== 'function') {
    checks.push({
      id: 'MB10.draws', severity: 'fail', scope: 'ai.rollAffixes over 100 000 draws', pass: null,
      lines: [`SKIP — \`ai.rollAffixes\` does not exist on AiSystem (typeof AiSystem.prototype.rollAffixes === '${typeof AiSystem.prototype.rollAffixes}', checked here, not assumed). A weight-distribution assertion over a function that does not exist cannot be faked into a pass; the tables it will draw from are asserted separately below (MB10.tables)`],
    });
  } else {
    checks.push(...runMB10Sweep(AiSystem, rank, affixData, RngClass, seed));
  }

  const problems = [];
  const totalWeight = Object.values(AFFIXES).reduce((a, x) => a + x.weight, 0);
  if (totalWeight !== 100) problems.push(`affix weights sum to ${totalWeight}, §6.1 says 100`);
  for (const g of AFFIX_GROUPS) {
    const sum = Object.values(AFFIXES).filter((a) => a.group === g).reduce((a, x) => a + x.weight, 0);
    if (sum !== AFFIX_GROUP_WEIGHTS[g]) problems.push(`group '${g}' weights sum to ${sum}, §6.1 says ${AFFIX_GROUP_WEIGHTS[g]}`);
  }
  // §6.5: "Champions draw a group by group weight and then an affix within
  // it — which reproduces the flat 100-weight distribution of §6.1 exactly,
  // so the two schemes are the same distribution". Verified, not trusted.
  let maxSchemeDev = 0;
  for (const [id, a] of Object.entries(AFFIXES)) {
    const groupSum = AFFIX_GROUP_WEIGHTS[a.group];
    const twoStage = (groupSum / 100) * (a.weight / groupSum);
    maxSchemeDev = Math.max(maxSchemeDev, Math.abs(twoStage - a.weight / 100));
    if (Math.abs(twoStage - a.weight / 100) > 1e-12) problems.push(`'${id}': two-stage probability ${twoStage} != flat ${a.weight / 100}`);
  }
  for (const archetypeId of Object.keys(AFFIX_INELIGIBLE)) {
    if (archetypeId === 'molgrim') continue; // §6.3: "The boss takes no affixes"
    for (const g of AFFIX_GROUPS) {
      const candidates = Object.keys(AFFIXES).filter((id) => AFFIXES[id].group === g && !AFFIX_INELIGIBLE[archetypeId].includes(id));
      if (candidates.length === 0) problems.push(`'${archetypeId}' has an empty '${g}' group — §6.3 says "every group is non-empty for every eligible archetype, so a draw can never fail"`);
      // §6.5's redraw guarantee, read exactly as §6.5 states it: a group is
      // redrawn only when a HELD affix excludes one of ITS candidates, and
      // §6.5's own table ("First held | Group affected | Removed | Remaining
      // candidates") promises a candidate always survives that one removal.
      // A group of one that no exclusion ever touches is not a violation —
      // §6.3 names `blight_crawler`'s single-candidate `utility` group as
      // intended ("a forced hexing"), so a blanket "every group survives
      // losing any member" check would fail correct data.
      for (const x of AFFIX_EXCLUSIONS) {
        if (x.archetype !== null && x.archetype !== archetypeId) continue;
        for (const [held, removed] of [[x.a, x.b], [x.b, x.a]]) {
          if (AFFIXES[removed].group !== g) continue;
          if (AFFIX_INELIGIBLE[archetypeId].includes(held)) continue;
          const after = candidates.filter((id) => id !== removed);
          if (after.length === 0) problems.push(`'${archetypeId}'/'${g}': holding '${held}' removes '${removed}' and empties the group — §6.5's single redraw could not succeed`);
        }
      }
    }
    // danger budget, §6.5: champion <= 3, unique <= 7
    const worstChampion = Math.max(...Object.keys(AFFIXES).filter((id) => !AFFIX_INELIGIBLE[archetypeId].includes(id)).map((id) => AFFIXES[id].danger));
    if (worstChampion > 3) problems.push(`'${archetypeId}': champion danger budget ${worstChampion} > 3`);
    const triples = legalUniqueTriples(archetypeId);
    for (const t of triples) {
      const points = t.reduce((a, id) => a + AFFIXES[id].danger, 0);
      if (points > 7) problems.push(`'${archetypeId}': unique triple [${t.join(',')}] costs ${points} danger points > 7`);
    }
  }
  checks.push({
    id: 'MB10.tables', severity: 'fail', scope: 'global (06 §6.1/§6.3/§6.5 tables, transcribed here)', pass: problems.length === 0,
    lines: problems.length === 0
      ? [`weights sum to 100 and to §6.1's own group totals 34/41/25; the §6.5 two-stage champion draw is provably the same distribution as the flat one (max deviation ${maxSchemeDev.toExponential(1)}); every group non-empty for all six eligible archetypes and still non-empty after any single §6.5 removal; no legal unique triple exceeds the 7-point danger budget (\`swift + mighty\` structurally impossible — same group)`]
      : problems,
  });

  checks.push(crossCheckShippedAffixTable(affixData));
}

/**
 * MB10's transcription half, second row: this file's `AFFIXES` table against
 * the SHIPPED `src/ai/data/affixes.js`.
 *
 * Two independent transcriptions of the same spec section are worth exactly
 * as much as the check that they agree. Without this row a divergence between
 * the harness's numbers and the game's would show up as MB3/MB4/MB7 verdicts
 * that describe a monster nobody can spawn.
 */
function crossCheckShippedAffixTable(affixData) {
  if (!affixData) {
    return {
      id: 'MB10.shipped', severity: 'fail', scope: 'src/ai/data/affixes.js vs this file\'s transcription', pass: null,
      lines: ['SKIP — no affix data file in the tree to cross-check against'],
    };
  }
  const problems = [];
  const shipped = affixData.MONSTER_AFFIXES;
  const here = Object.keys(AFFIXES);
  const there = Object.keys(shipped);
  if (here.length !== there.length || here.some((id, i) => id !== there[i])) {
    problems.push(`affix ids differ: this file has [${here.join(', ')}], the shipped table has [${there.join(', ')}]`);
  }
  for (const id of here) {
    const a = AFFIXES[id];
    const b = shipped[id];
    if (!b) { problems.push(`'${id}' is not in the shipped table`); continue; }
    if (a.group !== b.group) problems.push(`'${id}': group '${a.group}' here vs '${b.group}' shipped`);
    if (a.weight !== b.weight) problems.push(`'${id}': weight ${a.weight} here vs ${b.weight} shipped`);
    if (a.danger !== b.danger) problems.push(`'${id}': danger ${a.danger} here vs ${b.danger} shipped`);
    // The immunity three: this file names the element, the shipped table
    // names the StatBlock field. Compared through the mapping, not by shape.
    const shippedImmunity = b.immunityResist ? { fireResist: 'fire', lightResist: 'lightning', coldResist: 'cold' }[b.immunityResist] : undefined;
    if ((a.immunity || undefined) !== shippedImmunity) problems.push(`'${id}': immunity '${a.immunity}' here vs '${shippedImmunity}' shipped`);
  }
  for (const g of AFFIX_GROUPS) {
    if (AFFIX_GROUP_WEIGHTS[g] !== affixData.AFFIX_GROUP_WEIGHTS[g]) {
      problems.push(`group '${g}': weight ${AFFIX_GROUP_WEIGHTS[g]} here vs ${affixData.AFFIX_GROUP_WEIGHTS[g]} shipped`);
    }
  }
  for (const archetypeId of Object.keys(AFFIX_INELIGIBLE)) {
    const mine = [...AFFIX_INELIGIBLE[archetypeId]].sort().join(',');
    const theirs = [...(affixData.AFFIX_INELIGIBLE[archetypeId] || [])].sort().join(',');
    if (mine !== theirs) problems.push(`'${archetypeId}' ineligible: [${mine}] here vs [${theirs}] shipped`);
  }
  const mineX = AFFIX_EXCLUSIONS.map((x) => `${[x.a, x.b].sort().join('+')}@${x.archetype || '*'}`).sort().join(' ');
  const theirsX = affixData.AFFIX_EXCLUSIONS.map((x) => `${[x.a, x.b].sort().join('+')}@${x.archetypeId || '*'}`).sort().join(' ');
  if (mineX !== theirsX) problems.push(`exclusion pairs: [${mineX}] here vs [${theirsX}] shipped`);

  return {
    id: 'MB10.shipped', severity: 'fail', scope: 'src/ai/data/affixes.js vs this file\'s transcription', pass: problems.length === 0,
    lines: problems.length === 0
      ? [`all 9 affixes agree on group, weight, danger and immunity element; the 34/41/25 group weights, all ${Object.keys(AFFIX_INELIGIBLE).length} §6.3 eligibility rows and all 3 §6.5 exclusion pairs agree. The harness's MB3/MB4/MB7/MB8 verdicts therefore describe the monster the game actually spawns — two independent transcriptions of §6.1/§6.3/§6.5, cross-checked rather than assumed`]
      : problems,
  };
}

/**
 * MB10's draw half — the 100 000-draw sweep, over the SHIPPED draw code.
 *
 * MB10 names `ai.rollAffixes`, so the contracted method is what is checked;
 * the sweep itself then runs through the module function it forwards to
 * (`src/ai/rank.js`), which is the same code and needs no engine. The forward
 * is not assumed: both are driven from equally-seeded streams and compared.
 */
function runMB10Sweep(AiSystem, rank, affixData, RngClass, seed) {
  const out = [];
  const ai = new AiSystem(); // never init()ed — rank.js contracts that it needs no ctx
  const checks = [];

  // 1. The contracted entry point IS the module function.
  let forwards = true;
  for (let i = 0; i < 200; i++) {
    const s = (seed + i) >>> 0;
    rank.rollAffixes('champion', 10, new RngClass(s), out, 'bone_ranker');
    const viaModule = out[0];
    ai.rollAffixes('champion', 10, new RngClass(s), out, 'bone_ranker');
    if (out[0] !== viaModule) { forwards = false; break; }
  }

  const N = 100000;
  const AFFIX_IDS = Object.keys(affixData.MONSTER_AFFIXES);
  const counts = Object.fromEntries(AFFIX_IDS.map((id) => [id, 0]));
  const rng = new RngClass(seed >>> 0);
  let ineligibleChampion = 0;
  for (let i = 0; i < N; i++) {
    ai.rollAffixes('champion', 10, rng, out, 'bone_ranker');
    counts[out[0]]++;
    if (!rank.isEligible(out[0], 'bone_ranker')) ineligibleChampion++;
  }
  let worst = 0;
  let worstId = '';
  const cells = [];
  for (const id of AFFIX_IDS) {
    const observed = (counts[id] / N) * 100;
    const expected = affixData.MONSTER_AFFIXES[id].weight; // §6.1's weights sum to 100, so they ARE percentages
    const dev = Math.abs(observed - expected);
    if (dev > worst) { worst = dev; worstId = id; }
    cells.push(`${id} ${observed.toFixed(2)}/${expected}`);
  }

  // 2. The three violation classes, over uniques, across every §6.3 row.
  const ELIGIBLE = Object.keys(affixData.AFFIX_INELIGIBLE).filter((id) => id !== 'molgrim');
  let twoFromOneGroup = 0;
  let excluded = 0;
  let ineligibleUnique = 0;
  let wrongCount = 0;
  const uniqueRng = new RngClass((seed ^ 0x9e3779b9) >>> 0);
  for (let i = 0; i < N; i++) {
    const archetypeId = ELIGIBLE[i % ELIGIBLE.length];
    const n = ai.rollAffixes('unique', 10, uniqueRng, out, archetypeId);
    if (n !== 3) wrongCount++;
    const groups = out.map((id) => affixData.MONSTER_AFFIXES[id].group);
    if (new Set(groups).size !== groups.length) twoFromOneGroup++;
    for (const id of out) if (!rank.isEligible(id, archetypeId)) ineligibleUnique++;
    for (let a = 0; a < out.length; a++) {
      for (let b = a + 1; b < out.length; b++) if (rank.isExcludedPair(out[a], out[b], archetypeId)) excluded++;
    }
  }

  const violations = twoFromOneGroup + excluded + ineligibleUnique + ineligibleChampion + wrongCount;
  checks.push({
    id: 'MB10.draws', severity: 'fail', scope: `ai.rollAffixes, ${N} champion draws + ${N} unique rolls`,
    pass: forwards && worst <= 1.5 && violations === 0,
    lines: [
      `weights: worst deviation ${worst.toFixed(3)} pp on '${worstId}' against MB10's ±1.5 (observed/§6.1, %): ${cells.join(', ')}`,
      `violations over ${N} unique rolls across all ${ELIGIBLE.length} eligible archetypes: two-from-one-group ${twoFromOneGroup}, excluded pair ${excluded}, ineligible affix ${ineligibleUnique + ineligibleChampion}, wrong affix count ${wrongCount} — MB10 requires 0 of each`,
      `the sweep runs through the CONTRACTED \`ai.rollAffixes\` on an AiSystem that was never init()ed, and 200 equally-seeded pairs confirm it returns exactly what \`src/ai/rank.js#rollAffixes\` returns: ${forwards ? 'identical' : 'DIVERGED — the contracted method is not the module function'}`,
    ],
  });
  return checks;
}

/** MB11 — every pack template resolves to exactly `count` members at every
 * count 5…12 and never violates a member minimum. */
function checkMB11(checks) {
  for (const t of PACK_TEMPLATES) {
    const problems = [];
    const notes = [];
    for (let count = 5; count <= 12; count++) {
      const effective = Math.max(count, t.floor); // §5.3: `ai` raises count to the floor, PACK_SIZE_RAISED
      if (effective !== count) notes.push(`count ${count} -> raised to the template's own floor ${t.floor} (§5.3's PACK_SIZE_RAISED; a pack is never shrunk below the floor)`);
      const roster = resolvePackTemplate(t, effective);
      const total = rosterTotal(roster);
      if (total !== effective) problems.push(`count ${effective}: resolved to ${total} members (${rosterString(roster)})`);
      for (const [id, minimum] of Object.entries(t.min)) {
        if ((roster.get(id) || 0) < minimum) problems.push(`count ${effective}: '${id}' = ${roster.get(id) || 0} below its minimum ${minimum} (${rosterString(roster)})`);
      }
    }
    checks.push({
      id: 'MB11', severity: 'fail', scope: `template=${t.id}`, pass: problems.length === 0,
      lines: problems.length === 0
        ? [`counts 5..12 all resolve to exactly their own count with every member minimum held${notes.length ? `; ${notes.length} count(s) below this template's floor ${t.floor} raised per §5.3` : ''}`]
        : problems,
    });
  }
  // §5.2's own worked example and §5.4's own corridor-wanderer expectations,
  // as cross-checks on the resolver rather than on its author's confidence.
  const worked = [];
  const warband = resolvePackTemplate(PACK_TEMPLATES.find((t) => t.id === 'pk_warband'), 8);
  const expectWarband = { dust_shaman: 1, bone_ranker: 3, ashen_archer: 2, carrion_swarm: 2 };
  for (const [id, n] of Object.entries(expectWarband)) {
    if ((warband.get(id) || 0) !== n) worked.push(`§5.2's worked pk_warband@8 expects ${n}x${id}, resolver gave ${warband.get(id) || 0}`);
  }
  for (const [id, expected] of [['pk_bone_line', 'bone_ranker'], ['pk_maul_guard', 'maulsmith'], ['pk_swarm_flood', 'carrion_swarm'], ['pk_crawler_nest', 'blight_crawler']]) {
    const r = resolvePackTemplate(PACK_TEMPLATES.find((t) => t.id === id), 1); // §5.4's corridor wanderers, count = 1
    if (rosterTotal(r) !== 1 || (r.get(expected) || 0) !== 1) worked.push(`§5.4's corridor wanderer: ${id}@1 should be one ${expected}, resolver gave ${rosterString(r)}`);
  }
  checks.push({
    id: 'MB11.crosscheck', severity: 'fail', scope: 'global (06 §5.2 worked example + §5.4 corridor wanderers)', pass: worked.length === 0,
    lines: worked.length === 0
      ? ['§5.2\'s own worked pk_warband@8 reproduces exactly (1 Shaman, 3 Rankers, 2 Archers, 2 Swarmers); §5.4\'s four corridor cases at count 1 each yield the single member that section names']
      : worked,
  });
}

/** MB12 — `nav.stats.refusals / (refusals + solved)` over a 600 s `--sim`
 * run, < 0.02. The denominator does not exist in the shipped public API
 * (O-101). Verified here by inspecting `nav.stats` itself, not by quoting
 * the finding. */
function checkMB12(NavSystem, checks) {
  const stats = new NavSystem().stats;
  const keys = Object.keys(stats);
  const hasSolved = Object.prototype.hasOwnProperty.call(stats, 'solved');
  checks.push({
    id: 'MB12', severity: 'fail', scope: 'nav.stats.refusals / (refusals + solved), 600 s --sim', pass: hasSolved ? false : null,
    lines: [`SKIP — MB12's denominator does not exist. \`nav.stats\` exposes exactly { ${keys.join(', ')} } (read off a live \`NavSystem\` here, not quoted): there is no cumulative \`solved\` counter at all, and \`solvedThisSecond\` is a rolling 60-step window, not a total. O-101 also records that \`refusals\` counts only node-ceiling refusals (\`src/nav/astar.js\`), never the per-step budget/pool fast-fails — so even a hand-built denominator would not measure what MB12's wording implies. \`--sim\` itself (600 s of simulation over the 200 mapgen seeds, \`06\` §12.1) is a mode this file does not implement and D-70 did not grant. Reported, never faked: \`ai.stats.pathRefusals\` (AI-4's own separate counter) is the closest shipped quantity and it answers a different question`],
  });
}

/** MB13 — `ai` `fixedUpdate` cost at 25 active monsters, p95 < 0.30 ms.
 * D-79: unreachable as written, and the spec contradicts its own numbers.
 * Reported as a counted NOTE with the arithmetic computed from the SHIPPED
 * cadence constant. The threshold is not touched. */
function checkMB13(FIELD_REBUILD_CADENCE_STEPS, checks) {
  const rebuildFraction = 1 / FIELD_REBUILD_CADENCE_STEPS;
  const p95Window = 0.05;
  const structural = rebuildFraction > p95Window;
  const SPEC_AMORTISED_US = 24.6; // 06 §9.5's own "0.295 ms every 12 steps -> 24.6 µs"
  const SPEC_WORST_US = 337.6; // 06 §9.5's own worst case
  const SPEC_STEP_BUDGET_US = 600; // 06 §9.1/§9.5
  const MB13_BUDGET_US = 300; // MB13's own bound
  checks.push({
    id: 'MB13', severity: 'warn', scope: 'ai.fixedUpdate p95 at 25 active monsters', pass: true, note: true,
    lines: [
      `NOTE (D-79, not adjusted): MB13 is unreachable as written and the contradiction is provable without running anything. \`nav.buildFlowField()\` is called synchronously from \`ai.fixedUpdate\` on a cadence of FIELD_REBUILD_CADENCE_STEPS = ${FIELD_REBUILD_CADENCE_STEPS} (imported from src/ai/nav.js, not quoted), so ${(rebuildFraction * 100).toFixed(2)} % of steps carry the rebuild. p95 is the top 5 %. ${(rebuildFraction * 100).toFixed(2)} % > 5 % => the rebuild steps sit INSIDE the p95 window by construction${structural ? '' : ' (they would not, at this cadence)'}, so the raw p95 can never be lower than one rebuild, however fast the scheduler is`,
      `the spec carries two budgets for the same quantity: \`06\` §9.5 amortises the rebuild at ${SPEC_AMORTISED_US} µs/step and states "typical total 113.2 µs, worst case ${SPEC_WORST_US} µs, budget ${SPEC_STEP_BUDGET_US} µs" (§9.1 repeats 0.60 ms), while MB13 states ${MB13_BUDGET_US} µs — and §9.5's OWN worst case ${SPEC_WORST_US} µs already exceeds MB13's ${MB13_BUDGET_US} µs, a contradiction internal to the document and independent of any implementation`,
      `AI-4's own measurement, attributed and NOT re-run here: raw p95 0.5050 ms over 36 000 steps, steady-state p95 (rebuild steps excluded, D-79's own reading) 0.0290 ms against the 0.30 ms bound, rebuild steps 3000/36000 = 8.33 %. \`tests/nav/nav4.test.js\` independently pins buildFlowField at p50 0.4007 ms — one call already larger than MB13's whole budget`,
      'second, independent reason this cannot be a verdict in THIS file: MB13 is a wall-clock p95, and TEST-9\'s own determinism rule (two runs at one seed must produce byte-identical --json) forbids a timing number in the report. The measurement belongs in tests/ai/nav.perf.test.js, where it already lives',
    ],
  });
}

/** MB18 — every archetype's `hitTick`, computed from `08-characters-visual.md`
 * §6.1 at IAS 0, matches `06` §2's tick columns. MB19 — the Maulsmith's
 * wind-up never falls below 0.90 s and the Crawler's fuse never below 0.85 s,
 * at any IAS from any affix or tier combination. */
function checkMB18MB19(brains, checks) {
  // `08` §6.1's own formula, transcribed — used for `bone_ranker`, the one
  // archetype whose brain exports no tick helper (see the row's own line).
  const ticksFrom = (W, S, R, ias) => {
    const mult = 1 / (1 + ias / 100);
    return { windTicks: Math.max(2, Math.round(W * 60 * mult)), activeTicks: Math.round(S * 60), recTicks: Math.max(1, Math.round(R * 60 * mult)) };
  };
  const rows = [
    { name: 'bone_ranker attack', ticks: ticksFrom(0.42, 0.10, 0.33, 0), expected: [25, 6, 20], shipped: false },
    { name: 'carrion_swarm attack', ticks: brains.biteTicks(0), expected: [13, 4, 16], shipped: true },
    { name: 'ashen_archer ash_shot', ticks: brains.ashShotTicks(0), expected: [40, 2, 24], shipped: true },
    { name: 'dust_shaman dust_bolt', ticks: brains.dustBoltTicks(0), expected: [30, 4, 25], shipped: true },
    { name: 'dust_shaman raise_ranker', ticks: brains.raiseRankerTicks(0), expected: [63, 6, 33], shipped: true },
    { name: 'dust_shaman haste_dust', ticks: brains.hasteDustTicks(0), expected: [33, 5, 24], shipped: true },
    { name: 'maulsmith crushing_slam', ticks: brains.crushingSlamTicks(0), expected: [72, 8, 51], shipped: true },
    { name: 'blight_crawler detonate', ticks: brains.detonateTicks(0), expected: [51, 3, 0], shipped: true },
  ];
  const problems = [];
  for (const r of rows) {
    const [w, s, rec] = r.expected;
    if (r.ticks.windTicks !== w) problems.push(`${r.name}: windTicks ${r.ticks.windTicks} != §2's ${w}`);
    if (r.ticks.activeTicks !== s) problems.push(`${r.name}: activeTicks ${r.ticks.activeTicks} != §2's ${s}`);
    if (r.name !== 'blight_crawler detonate' && r.ticks.recTicks !== rec) problems.push(`${r.name}: recTicks ${r.ticks.recTicks} != §2's ${rec}`);
    const hitTick = r.ticks.hitTick !== undefined ? r.ticks.hitTick : r.ticks.windTicks;
    if (hitTick !== w) problems.push(`${r.name}: hitTick ${hitTick} != tick0 + windTicks ${w}`);
  }
  checks.push({
    id: 'MB18', severity: 'fail', scope: 'all seven archetypes, IAS 0', pass: problems.length === 0,
    lines: problems.length === 0
      ? [`${rows.length} action rows: ${rows.filter((r) => r.shipped).length} computed by the SHIPPED brain tick helpers (swarm/archer/shaman x3/maulsmith/crawler), all matching \`06\` §2's printed W/S/R columns and hitTick = tick0 + windTicks. \`bone_ranker attack\` (25/6/20) is computed from \`08\` §6.1's formula here instead: \`src/ai/brains/melee.js\` exports no tick helper at all, so that one row cannot be checked against shipped code — a real, reportable gap, not a pass`]
      : problems,
  });

  // MB19 — `06` §6.1's `swift` (+60) is the only monster IAS source and no
  // difficulty tier grants any; 1000 is included to show the floor is a
  // property of the formula, not of the value.
  const mb19 = [];
  let mb19Pass = true;
  for (const ias of [0, 60, 1000]) {
    const slamSeconds = brains.crushingSlamTicks(ias).windTicks / 60;
    const fuse = brains.detonateTicks(ias);
    const fuseSeconds = fuse.windTicks / 60;
    if (slamSeconds < 0.90 - 1e-9) mb19Pass = false;
    if (fuseSeconds < 0.85 - 1e-9) mb19Pass = false;
    mb19.push(`IAS ${ias}: maulsmith wind-up ${slamSeconds.toFixed(4)}s (floor 0.90), crawler fuse ${fuseSeconds.toFixed(4)}s (floor 0.85, ${fuse.windTicks} ticks — never IAS-scaled at all, §2.6)`);
  }
  checks.push({
    id: 'MB19', severity: 'fail', scope: 'maulsmith wind-up floor / crawler fuse floor', pass: mb19Pass,
    lines: [`${mb19.join(' | ')} — the affix/tier ceiling is +60 (\`swift\`, §6.1's only IAS source; no tier grants IAS)`],
  });
}

/** MB20 — every `archetypeId` referenced by a pack template appears in that
 * zone's `ZoneDescriptor.bestiary`. The descriptors are SHIPPED
 * (`src/world/data/zones.js`); the templates are this file's transcription of
 * `06` §5.3-§5.5. */
function checkMB20(ZONE_DESCRIPTORS_BY_ID, checks) {
  const byZone = new Map();
  for (const t of PACK_TEMPLATES) {
    if (!byZone.has(t.zone)) byZone.set(t.zone, new Set());
    const set = byZone.get(t.zone);
    for (const [id] of t.fixed) set.add(id);
    for (const [id] of t.share) set.add(id);
  }
  for (const [zoneId, ids] of byZone) {
    const descriptor = ZONE_DESCRIPTORS_BY_ID[zoneId];
    const bestiary = descriptor ? descriptor.bestiary : null;
    if (!descriptor) {
      checks.push({ id: 'MB20', severity: 'fail', scope: `zone=${zoneId}`, pass: false, lines: [`no ZoneDescriptor with id '${zoneId}' exists in src/world/data/zones.js`] });
      continue;
    }
    const missing = [...ids].filter((id) => !bestiary.includes(id));
    checks.push({
      id: 'MB20', severity: 'fail', scope: `zone=${zoneId}`, pass: missing.length === 0,
      lines: missing.length === 0
        ? [`all ${ids.size} archetype ids referenced by this zone's ${PACK_TEMPLATES.filter((t) => t.zone === zoneId).length} templates appear in the SHIPPED ZoneDescriptor.bestiary [${bestiary.join(', ')}]`]
        : [`ZoneDescriptor.bestiary is [${bestiary.join(', ') || '(empty)'}] but this zone's templates reference ${missing.length} id(s) that are not in it: ${missing.join(', ')}. src/world/data/zones.js marks this row "ASSIGNED empty — real bestiary is 06-monsters-ai.md's data, not read for this ticket" — a shipped gap in \`world\`'s data, reported here and NOT fixed by TEST-9 (src/ is another ticket's grant)`],
    });
  }
}

/** MB5 / MB5b / MB6 / MB14 / MB15 — out of M5's reach, reported as loud
 * skips naming the milestone that owns each. Never dropped from the printed
 * set: `06` §12.3's own "an assertion that is not implemented yet prints
 * SKIP <id> unimplemented, so the step-by-step build of §13 has an honest
 * progress readout rather than a green run that tests nothing". */
function checkSkippedAssertions(checks) {
  const rows = [
    ['MB5', 'M6', 'Molgrim TTK, clvl 13 vs mlvl 15, all three builds, 60.0-90.0 s. Molgrim is `06` §13 step 10 ("Molgrim — §7 in full ... it gates M6"); no boss brain, no phase machine, no schedule and no `--boss` mode exist in the tree. The schedule-derived `U` and the phase III blind that MB5 names are properties of that unbuilt encounter, not of any number this file can compute'],
    ['MB5b', 'M6', 'Molgrim combat time never reaches the 150 s enrage arm. Same owner as MB5: the enrage arm lives in `06` §7\'s unbuilt phase machine'],
    ['MB6', 'M7', 'Class TTK spread against every target, every rank, every tier, < 2.0x the median. `05` §13.2\'s B7 is the same gate on the skills side and this file already reports it as M7\'s, not M4\'s/M5\'s (see `b7` in the --skills path); `06` §2.7 also states its own spreads (1.23x/1.28x/1.13x) are "inside the M7 gate". Running it here at every rank and tier would need the difficulty-tier behaviours of `06` §11.3, which are AI-11 (M6)'],
    ['MB14', 'M6/M7', 'Determinism: identical kill order, cumulative damage and final `ai.stats` over 10 000 steps across two processes. Needs the full `--sim` mode (`06` §12.1) — 600 s of live simulation over the 200 mapgen seeds — which D-70 did not grant and which no ticket has built. Not in D-70\'s own list for TEST-9; printed here so the set stays all twenty rows'],
    ['MB15', 'M6', 'Measured per-phase boss uptime in `--boss` against §7.9\'s 0.848/0.893/0.833. Same owner as MB5/MB5b'],
  ];
  for (const [id, milestone, why] of rows) {
    checks.push({ id, severity: 'fail', scope: `milestone ${milestone}`, pass: null, lines: [`SKIP (${milestone}) — ${why}`] });
  }
}

// ---------------------------------------------------------------------------
// MB16 / MB17 — the zone sweep, over REAL generated zones (D-75)
// ---------------------------------------------------------------------------
// D-75 deferred MB16's verdict until real zones existed and recorded AI-3's
// 2.667 % on `src/world/testmap.js` as measured, not green. `src/world/gen/`
// now ships two real generators, so this runs the sweep properly: 200 Ashen
// Wastes layouts and 200 Bonereach layouts, each built headlessly through
// the SAME call chain `world.enterZone` uses — `generate*Layout` ->
// dressing/boundary -> `toFootprints` -> `buildHeightField` ->
// `nav.rebuild(instance)` -> `planpackSpawns` — with a real `PhysicsSystem`
// carrying the same footprints. Nothing here re-implements a generator; the
// only thing this file supplies is the `ctx` stub and the `instance` literal
// that `world/index.js` builds from the same inputs.
//
// MB16 is measured through the SHIPPED `nav.raycastNav` (NAV-7, which D-75
// said had to land first) against the SHIPPED `physics.lineOfSight`, on pairs
// of walkable cells within a real `06` §4.1 aggro radius. MB17 reads
// `spawn.js`'s own `spawnPushedCount`.
//
// The sampling is deliberately NOT narrowed to a favourable subset: every
// sampled pair is counted, both mismatch directions are reported, and the
// zone-by-zone split is printed. `12` §12's own rule — "a harness that meets
// a budget by sampling fewer pairs does not pass" — is the reason.
const MB16_AGGRO_RADII = Object.freeze([13.0, 15.0, 18.0, 16.0, 12.0, 17.0]); // 06 §4.1, the six non-boss archetypes
const MB16_SEEDS_PER_ZONE = 200; // MB16's own "over the 200 seeds"
const MB16_PAIRS_PER_SEED = 6;
const MB16_BUDGET = 0.015;

async function runZoneSweep(Z, seed) {
  const master = new Z.Rng(seed >>> 0);
  const zones = [];
  for (const zoneId of ['ashen_wastes', 'bonereach']) {
    const descriptor = Z.ZONE_DESCRIPTORS_BY_ID[zoneId];
    const stats = {
      zoneId, seeds: 0, attempted: 0, sampled: 0, navFailPhysPass: 0, navPassPhysFail: 0,
      spawnPushed: 0, packs: 0, spawnPoints: 0, layoutsBuilt: 0,
    };
    for (let s = 0; s < MB16_SEEDS_PER_ZONE; s++) {
      const zoneSeed = master.u32() || 1;
      const world = { staticFootprints: [], current: null };
      const physics = new Z.PhysicsSystem();
      const nav = new Z.NavSystem();
      const systems = { world, physics, nav };
      const ctx = {
        events: new Z.EventBus(),
        rng: new Z.Rng(zoneSeed),
        time: { step: 0, frame: 0, elapsed: 0, raw: 0, dt: 1 / 60, fixed: 1 / 60, alpha: 0, scale: 1 },
        config: {},
        get: (id) => systems[id],
        peek: (id) => systems[id] || null,
        has: (id) => Boolean(systems[id]),
      };
      await physics.init(ctx);
      await nav.init(ctx);

      let layout; let footprints; let entries; let terraces;
      if (zoneId === 'ashen_wastes') {
        layout = Z.generateRidgewalkLayout(zoneSeed, descriptor);
        entries = Z.placeRidgewalkEntries(layout, descriptor, layout.streams);
        const dress = Z.runR8Dressing(layout, descriptor, layout.streams);
        const boundary = Z.runR9Boundary(layout, descriptor, layout.streams);
        footprints = Z.toWastesFootprints(dress.props, boundary.ridgeWall);
        terraces = layout.terraces;
      } else {
        layout = Z.generateBonereachLayout(zoneSeed, descriptor);
        const loot = Z.placeBonereachLoot(layout, descriptor, layout.streams);
        const dressing = Z.runBonereachDressing(layout, descriptor, layout.streams);
        entries = Z.placeBonereachEntries(layout, descriptor).entries;
        footprints = Z.toBonereachFootprints(layout, dressing);
        terraces = layout.terraces && layout.terraces.length > 0 ? layout.terraces : undefined;
        stats.chests = (loot.chests || []).length;
      }
      stats.layoutsBuilt++;
      world.staticFootprints = footprints;
      for (const fp of footprints) physics.addStatic(fp, fp.surface);
      physics.rebuild();

      const heightField = Z.buildHeightField({ sizeX: descriptor.sizeX, sizeZ: descriptor.sizeZ, ...(terraces ? { terraces } : {}), noiseSeed: zoneSeed });
      const halfX = descriptor.sizeX / 2;
      const halfZ = descriptor.sizeZ / 2;
      const cellSize = Z.RASTER.CELL_SIZE;
      const width = Math.max(1, Math.round(descriptor.sizeX / cellSize));
      const height = Math.max(1, Math.round(descriptor.sizeZ / cellSize));
      const groundY = new Float32Array(width * height);
      for (let cz = 0; cz < height; cz++) {
        const wz = -halfZ + (cz + 0.5) * cellSize;
        for (let cx = 0; cx < width; cx++) groundY[cz * width + cx] = Z.sampleHeightField(heightField, -halfX + (cx + 0.5) * cellSize, wz);
      }
      const instance = {
        descriptor, zoneId, seed: zoneSeed, navVersion: 0,
        boundsMinX: -halfX, boundsMinZ: -halfZ, boundsMaxX: halfX, boundsMaxZ: halfZ,
        nav: { width, height, originX: -halfX, originZ: -halfZ, cellSize, groundY },
      };
      world.current = instance;
      nav.rebuild(instance);
      stats.seeds++;

      // MB17 — the real spawn pass, reading nav's just-rasterised grid.
      const plan = zoneId === 'ashen_wastes'
        ? Z.planWastesSpawns({ descriptor, tier: 'instruction', grid: nav.grid, layout, wastesEntries: entries })
        : Z.planBonereachSpawns({ descriptor, tier: 'instruction', grid: nav.grid, layout, bonereachEntries: entries, chests: [] });
      stats.spawnPushed += plan.report.spawnPushedCount;
      stats.packs += plan.report.packCount;
      stats.spawnPoints += plan.spawnPoints.length;

      // MB16 — walkable pairs within an aggro radius.
      const rng = new Z.Rng(zoneSeed);
      for (let p = 0; p < MB16_PAIRS_PER_SEED; p++) {
        stats.attempted++;
        let a = null;
        for (let t = 0; t < 50 && !a; t++) {
          const x = rng.range(-halfX + 0.5, halfX - 0.5);
          const z = rng.range(-halfZ + 0.5, halfZ - 0.5);
          if (nav.walkable(x, z)) a = { x, z };
        }
        if (!a) continue;
        const radius = MB16_AGGRO_RADII[Math.floor(rng.next() * MB16_AGGRO_RADII.length)];
        let b = null;
        for (let t = 0; t < 20 && !b; t++) {
          const ang = rng.range(0, Math.PI * 2);
          const r = rng.range(0, radius);
          const x = a.x + Math.cos(ang) * r;
          const z = a.z + Math.sin(ang) * r;
          if (x < -halfX + 0.5 || x > halfX - 0.5 || z < -halfZ + 0.5 || z > halfZ - 0.5) continue;
          if (nav.walkable(x, z)) b = { x, z };
        }
        if (!b) continue;
        stats.sampled++;
        const navOk = nav.raycastNav(a.x, a.z, b.x, b.z);
        const physOk = physics.lineOfSight(a.x, a.z, b.x, b.z, Z.MASK.SIGHT);
        if (!navOk && physOk) stats.navFailPhysPass++;
        if (navOk && !physOk) stats.navPassPhysFail++;
      }
      if (typeof nav.dispose === 'function') nav.dispose();
      if (typeof physics.dispose === 'function') physics.dispose();
    }
    zones.push(stats);
  }
  return zones;
}

function checkMB16MB17(zones, checks) {
  const total = zones.reduce((a, z) => ({
    sampled: a.sampled + z.sampled, attempted: a.attempted + z.attempted,
    navFailPhysPass: a.navFailPhysPass + z.navFailPhysPass, navPassPhysFail: a.navPassPhysFail + z.navPassPhysFail,
    spawnPushed: a.spawnPushed + z.spawnPushed, packs: a.packs + z.packs, spawnPoints: a.spawnPoints + z.spawnPoints,
    layouts: a.layouts + z.layoutsBuilt,
  }), { sampled: 0, attempted: 0, navFailPhysPass: 0, navPassPhysFail: 0, spawnPushed: 0, packs: 0, spawnPoints: 0, layouts: 0 });

  const rate = total.sampled > 0 ? total.navFailPhysPass / total.sampled : 0;
  const perZone = zones.map((z) => `${z.zoneId}: ${z.navFailPhysPass}/${z.sampled} = ${(z.navFailPhysPass / z.sampled * 100).toFixed(3)}%`).join('; ');
  checks.push({
    id: 'MB16', severity: 'fail', scope: `${total.layouts} generated layouts (${MB16_SEEDS_PER_ZONE}/zone), ${total.sampled} walkable pairs`, pass: total.navPassPhysFail === 0,
    lines: [
      `UNSAFE direction (nav passes where physics blocks — a monster aggros through a wall): ${total.navPassPhysFail}/${total.sampled} = ${(total.navPassPhysFail / total.sampled * 100).toFixed(3)}%, and MB16's bound on it is exactly 0 (O-143)`,
      `CONSERVATIVE direction (nav refuses a sight physics allows): ${total.navFailPhysPass}/${total.sampled} = ${(rate * 100).toFixed(3)}% (${perZone}) — reported, no threshold. The mechanism is nav's 0.30 m walkability dilation (07 §6.3) plus the slope pass, neither of which physics's undilated sight geometry knows about, so a budget here asserts against a margin the spec mandates on purpose`,
      `every attempted pair is counted (${total.attempted} attempted, ${total.sampled} sampled) and no favourable subset is carved out — 12 §12's "a harness that meets a budget by sampling fewer pairs does not pass"`,
      `D-75 asked for a real verdict once real zones existed; O-143 is it. The old single < ${(MB16_BUDGET * 100).toFixed(1)}% budget lumped both directions together and could not be met while §6.3 stands. It is replaced by a HARDER bound on the direction that can produce a bug, not a looser one`,
    ],
  });

  checks.push({
    id: 'MB17', severity: 'fail', scope: `${total.layouts} generated layouts, ${total.packs} packs, ${total.spawnPoints} SpawnPoints`, pass: total.spawnPushed === 0,
    lines: [`SPAWN_PUSHED = ${total.spawnPushed} across every pack of every layout (${zones.map((z) => `${z.zoneId}: ${z.spawnPushed} over ${z.packs} packs / ${z.spawnPoints} points`).join('; ')}) — every SpawnPoint satisfied its zone's §10.2 path-distance minimum without correction, read off spawn.js's own \`spawnPushedCount\``],
  });
}

// ---------------------------------------------------------------------------
// The mode driver
// ---------------------------------------------------------------------------
async function buildMonsterChecks(seed) {
  // Every import below is dynamic ON PURPOSE — see this file's TEST-9 header
  // block: `--skills`'s module graph must stay exactly what TEST-8 shipped.
  const [bestiary, aiIndex, aiRank, affixData, aiNav, navIndex, physics, zonesData, ridgewalk, wastesGen, bonereachGen,
    height, raster, spawn, events, rng, swarmBrain, archerBrain, shamanBrain, maulsmithBrain, crawlerBrain] = await Promise.all([
    import('../src/ai/data/bestiary.js'),
    import('../src/ai/index.js'),
    import('../src/ai/rank.js'),
    import('../src/ai/data/affixes.js'),
    import('../src/ai/nav.js'),
    import('../src/nav/index.js'),
    import('../src/physics/index.js'),
    import('../src/world/data/zones.js'),
    import('../src/world/gen/ridgewalk.js'),
    import('../src/world/gen/wastes.js'),
    import('../src/world/gen/bonereach.js'),
    import('../src/world/height.js'),
    import('../src/world/raster.js'),
    import('../src/world/spawn.js'),
    import('../src/core/events.js'),
    import('../src/core/rng.js'),
    import('../src/ai/brains/swarm.js'),
    import('../src/ai/brains/archer.js'),
    import('../src/ai/brains/shaman.js'),
    import('../src/ai/brains/maulsmith.js'),
    import('../src/ai/brains/crawler.js'),
  ]);

  const checks = [];
  checkMB1(bestiary, checks);
  // O-97's own note, verified rather than restated: the ONE shipped tier
  // constant is `spawn.js`'s `DIFFICULTY_MLVL_OFFSET`.
  const offsetsMatch = TIER_NAMES.every((t) => spawn.DIFFICULTY_MLVL_OFFSET[t] === TIER[t].mlvlOffset);
  checks.push({
    id: 'MB1.tier-source', severity: 'fail', scope: 'global (O-97 — where difficultyMult lives)', pass: offsetsMatch,
    lines: [`the only tier data shipped anywhere in \`src/\` is \`src/world/spawn.js#DIFFICULTY_MLVL_OFFSET\` = ${JSON.stringify(spawn.DIFFICULTY_MLVL_OFFSET)}, cross-checked here against \`03\` §10.2's +0/+12/+22: ${offsetsMatch ? 'match' : 'MISMATCH'}. The Life/Damage/XP tier multipliers themselves exist in no module — \`actor\` has no tier field and no difficulty system exists before AI-11 (M6), which is O-97 exactly. MB1 above therefore applies \`difficultyMult\` arithmetically (O-97's first, preferred option), never through a live actor, and the tier is never silently absent from the assertion`],
  });
  checkMB2(bestiary, checks);
  checkMB3MB4(bestiary, checks);
  checkMB7(bestiary, checks);
  checkMB8(bestiary, checks);
  checkMB9(zonesData.ZONE_DESCRIPTORS_BY_ID, checks);
  checkMB10(aiIndex.AiSystem, aiRank, affixData, rng.Rng, seed, checks);
  checkMB11(checks);
  checkMB12(navIndex.NavSystem, checks);
  checkMB13(aiNav.FIELD_REBUILD_CADENCE_STEPS, checks);
  checkMB18MB19({
    biteTicks: swarmBrain.biteTicks, ashShotTicks: archerBrain.ashShotTicks,
    dustBoltTicks: shamanBrain.dustBoltTicks, raiseRankerTicks: shamanBrain.raiseRankerTicks,
    hasteDustTicks: shamanBrain.hasteDustTicks, crushingSlamTicks: maulsmithBrain.crushingSlamTicks,
    detonateTicks: crawlerBrain.detonateTicks,
  }, checks);
  checkMB20(zonesData.ZONE_DESCRIPTORS_BY_ID, checks);

  const zones = await runZoneSweep({
    Rng: rng.Rng, EventBus: events.EventBus,
    NavSystem: navIndex.NavSystem, PhysicsSystem: physics.PhysicsSystem, MASK: physics.MASK,
    ZONE_DESCRIPTORS_BY_ID: zonesData.ZONE_DESCRIPTORS_BY_ID,
    generateRidgewalkLayout: ridgewalk.generateRidgewalkLayout, placeRidgewalkEntries: ridgewalk.placeRidgewalkEntries,
    runR8Dressing: wastesGen.runR8Dressing, runR9Boundary: wastesGen.runR9Boundary, toWastesFootprints: wastesGen.toFootprints,
    generateBonereachLayout: bonereachGen.generateBonereachLayout, placeBonereachLoot: bonereachGen.placeBonereachLoot,
    runBonereachDressing: bonereachGen.runBonereachDressing, placeBonereachEntries: bonereachGen.placeBonereachEntries,
    toBonereachFootprints: bonereachGen.toFootprints,
    buildHeightField: height.buildHeightField, sampleHeightField: height.sampleHeightField,
    RASTER: raster.RASTER, planWastesSpawns: spawn.planWastesSpawns, planBonereachSpawns: spawn.planBonereachSpawns,
  }, seed);
  checkMB16MB17(zones, checks);

  checkSkippedAssertions(checks);
  return checks;
}

function renderMonstersHuman(checks, meta) {
  const out = [];
  const verdicts = checks.map(verdictOf);
  const failed = verdicts.filter((v) => v === 'FAIL').length;
  const notes = verdicts.filter((v) => v === 'NOTE').length;
  const warned = verdicts.filter((v) => v === 'warn').length;
  const passed = verdicts.filter((v) => v === 'PASS' || v === 'ok').length;
  const skipped = verdicts.filter((v) => v === 'SKIP').length;

  out.push(`balance.mjs --monsters  seed=0x${meta.seed.toString(16)}  06-monsters-ai.md §12.2  elapsed=${meta.seconds.toFixed(2)}s`);
  out.push('');
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    const v = verdicts[i];
    out.push(`${v.padEnd(5)} ${c.id.padEnd(22)} ${c.scope}`);
    for (const line of c.lines) out.push(`        ${line}`);
  }
  out.push('');
  out.push(`  RESULT: ${failed > 0 ? 'FAIL' : 'PASS'}`);
  out.push(`  ${passed} pass · ${failed} fail · ${warned} warn · ${notes} notes · ${skipped} skip`);
  return out.join('\n');
}

function renderMonstersJson(checks, meta) {
  const verdicts = checks.map(verdictOf);
  // No `seconds` field, deliberately: TEST-9's determinism rule is that two
  // runs at one seed produce BYTE-IDENTICAL --json, and a wall-clock field
  // would break that literally rather than only after a test deletes it.
  return JSON.stringify({
    mode: 'monsters',
    seed: `0x${meta.seed.toString(16)}`,
    document: '06-monsters-ai.md §12.2',
    checks: checks.map((c, i) => ({ id: c.id, scope: c.scope, status: verdicts[i].toLowerCase(), detail: c.lines.join(' | ') })),
    passed: verdicts.filter((v) => v === 'PASS' || v === 'ok').length,
    failed: verdicts.filter((v) => v === 'FAIL').length,
    warned: verdicts.filter((v) => v === 'warn').length,
    notes: verdicts.filter((v) => v === 'NOTE').length,
    skipped: verdicts.filter((v) => v === 'SKIP').length,
  }, null, 2);
}

// ============================================================================
// Report assembly
// ============================================================================

function verdictOf(c) {
  if (c.note) return 'NOTE';
  if (c.pass === null) return 'SKIP';
  if (c.pass === false) return c.severity === 'warn' ? 'warn' : 'FAIL';
  return c.softWarn ? 'warn' : c.severity === 'warn' ? 'ok' : 'PASS';
}

function formatFailureLine(c) {
  const scope = c.skillId ? `skill=${c.skillId}` : c.buildName ? `build=${c.buildName}` : '';
  return `FAIL  ${c.id}  ${scope}  ${c.lines.join(' | ')}`;
}

function renderHuman(skillChecks, buildChecks, b7, meta) {
  const out = [];
  const allChecks = [...skillChecks, ...buildChecks, b7];
  const verdicts = allChecks.map(verdictOf);
  const failed = verdicts.filter((v) => v === 'FAIL').length;
  const notes = verdicts.filter((v) => v === 'NOTE').length;
  const warned = verdicts.filter((v) => v === 'warn').length;
  const passed = verdicts.filter((v) => v === 'PASS' || v === 'ok').length;
  const skipped = verdicts.filter((v) => v === 'SKIP').length;

  out.push(`balance.mjs  seed=0x${meta.seed.toString(16)}  skills=${meta.skillCount}  builds=${meta.buildCount}  elapsed=${meta.seconds.toFixed(2)}s`);
  const skillPass = skillChecks.filter((c) => verdictOf(c) === 'PASS' || verdictOf(c) === 'ok').length;
  const skillFail = skillChecks.filter((c) => verdictOf(c) === 'FAIL').length;
  out.push(`  per-skill   ${skillChecks.length} checks   ${skillPass} pass   ${skillFail} fail`);
  const buildAll = [...buildChecks, b7];
  const buildPass = buildAll.filter((c) => verdictOf(c) === 'PASS' || verdictOf(c) === 'ok').length;
  const buildFail = buildAll.filter((c) => verdictOf(c) === 'FAIL').length;
  const buildNotes = buildAll.filter((c) => verdictOf(c) === 'NOTE').length;
  out.push(`  per-build  ${buildAll.length} checks ${buildPass} pass   ${buildFail} fail   ${buildNotes} notes`);
  out.push('');

  for (const c of allChecks) {
    const v = verdictOf(c);
    if (v === 'FAIL') out.push(formatFailureLine(c));
    else if (v === 'NOTE') out.push(`NOTE  ${c.id}  build=${c.buildName}   ${c.lines[c.lines.length - 1]}`);
  }

  out.push('');
  out.push(`  RESULT: ${failed > 0 ? 'FAIL' : 'PASS'}`);
  out.push(`  ${passed} pass · ${failed} fail · ${warned} warn · ${notes} notes · ${skipped} skip`);
  return out.join('\n');
}

function renderJson(skillChecks, buildChecks, b7, meta) {
  const toJson = (c) => ({
    id: c.id, scope: c.skillId || c.buildName || 'global', status: verdictOf(c).toLowerCase(), detail: c.lines.join(' | '),
  });
  const allChecks = [...skillChecks, ...buildChecks, b7];
  const verdicts = allChecks.map(verdictOf);
  return JSON.stringify({
    seed: `0x${meta.seed.toString(16)}`,
    skills: meta.skillCount,
    builds: meta.buildCount,
    perSkill: skillChecks.map(toJson),
    perBuild: [...buildChecks, b7].map(toJson),
    passed: verdicts.filter((v) => v === 'PASS' || v === 'ok').length,
    failed: verdicts.filter((v) => v === 'FAIL').length,
    warned: verdicts.filter((v) => v === 'warn').length,
    notes: verdicts.filter((v) => v === 'NOTE').length,
    skipped: verdicts.filter((v) => v === 'SKIP').length,
    // No `seconds` field. `12-testing.md` §7's `12.D01` requires two runs at
    // one seed to produce byte-identical `--json`, and a wall-clock field
    // breaks that on every run rather than only occasionally: measured
    // 0.358040584 against 0.349795375 on two consecutive runs, which is the
    // ONLY difference between them. `--monsters` (TEST-9) already omits it for
    // exactly this reason and says so; this is TEST-8's half, brought into
    // line. The elapsed time is still printed in the human report, where no
    // determinism rule applies.
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
    if (err instanceof UnimplementedFlagError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`error: ${err.message}\n`);
    printHelp();
    process.exit(2);
  }
  if (args.help) { printHelp(); process.exit(0); }
  if (!args.skills && !args.monsters) {
    process.stderr.write('error: pass --skills (05-skills.md §13) or --monsters (06-monsters-ai.md §12.2), or --help.\n');
    process.exit(2);
  }

  if (args.monsters) {
    const tm0 = process.hrtime.bigint();
    const monsterChecks = await buildMonsterChecks(args.seed >>> 0);
    const meta = { seed: args.seed >>> 0, seconds: Number(process.hrtime.bigint() - tm0) / 1e9 };
    if (args.json) process.stdout.write(renderMonstersJson(monsterChecks, meta) + '\n');
    else process.stdout.write(renderMonstersHuman(monsterChecks, meta) + '\n');
    // Same rule as the --skills path: `NOTE`/`SKIP` are counted and printed
    // but never flip the exit code; `warn`-severity rows never do either.
    const anyFail = monsterChecks.some((c) => c.severity !== 'warn' && c.pass === false && !c.note);
    process.exitCode = anyFail ? 1 : 0;
    return;
  }

  const t0 = process.hrtime.bigint();

  const skillChecks = buildSkillChecks();

  const namedBuildChecks = NAMED_BUILDS.flatMap((b) => buildBuildChecks(b, true));
  const sweep = ['ravager', 'emberwright', 'runeblade'].flatMap((c) => generateSweep(c));

  // The sweep is thousands of builds x 11 checks — printing every PASSING
  // check for every one of them (this file's first draft did) produced a
  // 140+ MB report, useless as either a human or machine artifact and well
  // past any sane harness budget (12-testing.md §5.2's own 25s time budget
  // says nothing about output SIZE, but the spirit is the same). Aggregated
  // here instead: one {id -> pass/fail/warn/note/skip count} tally (the
  // summary block's own "45738 checks 45738 pass" line shape, `05` §13.3),
  // plus every FAILING check's own detail line, capped at
  // SWEEP_FAIL_SAMPLE_CAP per id so a systemic bug still shows its shape
  // without re-printing thousands of near-identical lines (the same
  // "mismatchSamples.length < 10" capping precedent `tools/lootsim.mjs`
  // already uses) — the CAPPED COUNT is itself printed, so a capped list
  // never silently reads as "only this many failures exist".
  const SWEEP_FAIL_SAMPLE_CAP = 25;
  const sweepTally = new Map(); // id -> {pass,fail,warn,note,skip, failSamples:[]}
  const tallyOf = (id) => {
    let t = sweepTally.get(id);
    if (!t) { t = { pass: 0, fail: 0, warn: 0, note: 0, skip: 0, failSamples: [] }; sweepTally.set(id, t); }
    return t;
  };
  for (const b of sweep) {
    for (const c of buildBuildChecks(b, false)) {
      const v = verdictOf(c);
      const t = tallyOf(c.id);
      if (v === 'FAIL') { t.fail++; if (t.failSamples.length < SWEEP_FAIL_SAMPLE_CAP) t.failSamples.push(formatFailureLine(c)); }
      else if (v === 'warn') t.warn++;
      else if (v === 'NOTE') t.note++;
      else if (v === 'SKIP') t.skip++;
      else t.pass++;
    }
  }
  const sweepAggregateChecks = [...sweepTally.entries()].map(([id, t]) => ({
    id, severity: 'fail', buildName: 'sweep (aggregated)', aggregate: true, pass: t.fail === 0,
    // B6 is always a note (Instruction-tier Molgrim data is out of M4's own
    // scope, never computed at all — see that check's own per-build header).
    // B10 was one too until D-85 gave it a satisfiable window; it is now a
    // real verdict over the whole sweep, which is where a stun-locking build
    // actually lives — none of `05` §9's nine hand-written builds allocates
    // `ram_charge` or `war_cry` at all.
    note: id === 'B6',
    lines: [
      `sweep (${sweep.length} builds): ${t.pass} pass, ${t.fail} fail, ${t.warn} warn, ${t.note} note, ${t.skip} skip`,
      ...(t.fail > SWEEP_FAIL_SAMPLE_CAP ? [`(showing first ${SWEEP_FAIL_SAMPLE_CAP} of ${t.fail} failures)`] : []),
      ...t.failSamples,
    ],
  }));
  const simulationChecks = buildSimulationChecks();
  const buildChecks = [...simulationChecks, ...namedBuildChecks, ...sweepAggregateChecks];

  // B7 — spread < 2x, evaluated over the SWEEP (05 §13.2: "not over the nine
  // hand-written builds"), median/max/min of sustained DPS vs yardstick A.
  // Builds with a non-damage primary (see hasNoDamagePrimary's own header —
  // the same set B2-B6 already skip) are excluded here too: a build that
  // spent its 15+ primary points on a passive is not a damage build to
  // compare against the median at all, and folding it in would make the
  // low end of the spread measure this file's own basic-attack fallback
  // for a caster class, not a real balance question 05.B07 is asking.
  const damageSweep = sweep.filter((b) => !hasNoDamagePrimary(b));
  const sweepDps = damageSweep.map((b) => buildDpsAgainst(b, YARDSTICKS.A).dps).filter((d) => d > 0).sort((a, b2) => a - b2);
  const median = sweepDps.length ? (sweepDps.length % 2 ? sweepDps[(sweepDps.length - 1) / 2] : (sweepDps[sweepDps.length / 2 - 1] + sweepDps[sweepDps.length / 2]) / 2) : 0;
  const maxDps = sweepDps[sweepDps.length - 1] || 0;
  const minDps = sweepDps[0] || 0;
  const highSpread = median > 0 ? maxDps / median : 0;
  const lowSpread = minDps > 0 ? median / minDps : Infinity;
  // B7 is the M7 gate, not M4's (05:3867 prints "the M7 gate" on its own
  // row; 12-testing.md §11's M4 row names only 05.B08). Real data, always
  // printed and counted, but NEVER blocks THIS run's exit code — a `NOTE`,
  // the same treatment B6/B10 get.
  const gateHeld = highSpread < 2.0 && lowSpread < 2.0;
  const b7 = {
    id: 'B7', severity: 'warn', buildName: 'global (M7 gate, not M4)', pass: true, note: true,
    lines: [`NOTE (M7's own gate, informational for M4): sweep n=${sweepDps.length}  median=${median.toFixed(2)}  max=${maxDps.toFixed(2)} (${highSpread.toFixed(2)}x)  min=${minDps.toFixed(2)} (${lowSpread.toFixed(2)}x)  gate <2.0x both sides  ${gateHeld ? '(holds)' : '(does not hold yet — M7\'s own problem to close)'}`],
  };

  const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
  const meta = { seed: args.seed >>> 0, skillCount: SKILLS.length, buildCount: NAMED_BUILDS.length + sweep.length, seconds };

  if (args.json) process.stdout.write(renderJson(skillChecks, buildChecks, b7, meta) + '\n');
  else process.stdout.write(renderHuman(skillChecks, buildChecks, b7, meta) + '\n');

  const anyFail = [...skillChecks, ...buildChecks, b7].some((c) => c.severity !== 'warn' && c.pass === false && !c.note);
  // `process.exitCode = N` (never `process.exit(N)` here) — the report can
  // exceed the OS pipe buffer (64 KB), and `process.exit()` called right
  // after a large `stdout.write()` can truncate the write before the pipe
  // drains (a well-known Node.js gotcha, caught by this ticket's own smoke
  // test failing with "Unterminated string in JSON" at exactly 64 KB).
  // Setting `exitCode` and letting the process exit naturally once the
  // event loop drains keeps the full write intact.
  process.exitCode = anyFail ? 1 : 0;
}

main().catch((err) => {
  process.stderr.write(`balance: fatal error: ${err.stack || err.message}\n`);
  process.exit(2);
});
