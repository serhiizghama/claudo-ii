// src/skills/index.js
//
// SKIL-1 — the `skills` subsystem shell: the registry over the 30
// `SkillDefinition` records (`./data/skills.js`) and per-actor allocation
// (`02-api-contracts.md` §10's "Registry and allocation" table, all eleven
// rows, `05-skills.md` §14 row 1: "definition, all, forClass, forTree,
// trees, instanceOf, effectiveLevel, canAllocate, allocate, respec,
// synergyBonus. No casting yet").
//
// SKIL-2 adds the Casting table's two `05` §14 step-2 rows — `costOf` and
// `cooldownRemaining` (below, thin wrappers over `./cost.js`'s pure
// engines) — and nothing else: still no `cast()`, no damage packet, no
// `ctx.events`. That was step 3+ (`05` §14).
//
// SKIL-3 is step 3+: the first real `cast()`/`canCast()` (below), wired for
// `cleaving_strike` only (D-37 scope — the remaining 29 skills' cast paths
// are later tickets' and stay absent, not stubbed, per this project's own
// convention for a partially-built table — see e.g. `src/actors/index.js`'s
// "Stats and vessels" section comment). `_castHandlers` is an array indexed
// by the SAME O-59 integer index `_indexById`/`_indexById.get(skillId)`
// already resolves (never a `skillId` string switch on the hot path) —
// `null` for every skill without a wired handler; `cast()` reports `false`
// for those rather than pretending they do not exist (O-27).
//
// SKIL-4 adds two more wired skills — `ember_bolt` (projectile, D-37 scope
// still just the three M4 skills) and `rune_strike` (melee, D-43: NOT a
// projectile) — plus the `Projectile` pool itself (`./projectile.js`,
// `01-data-model.md:1691`), this subsystem's first `fixedUpdate` (the
// pool's flight simulation), and `spawnProjectile`/`killProjectile`/
// `projectileCount` (`02-api-contracts.md` §10). `cast()` below now forwards
// `targetId` to the handler and adds the generic `target: 'actor'`
// no-target refusal `canCast()`'s own doc comment already assigns to
// `cast()` (rune_strike is the first skill to actually need it). See
// `./impl/bolt.js`/`./impl/rune_strike.js`/`./projectile.js`'s own headers
// for the mechanics each one owns.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` sweeps `src/skills/`
// with `checkGlobals: true`).
//
// ---------------------------------------------------------------------------
// `static deps` — why this is `['actors', 'combat', 'physics']`, not
// `['actors', 'combat', 'physics', 'fx']`
// ---------------------------------------------------------------------------
// `02-api-contracts.md:832` declares `static deps = ['actors','combat',
// 'fx']` (no `physics` row at all — that table predates cone targeting).
// `src/fx/` does not exist yet — no directory, no `registry.add(FxSystem)`
// anywhere — so `src/core/registry.js#resolve()` throws `'skills' depends
// on 'fx', which is not registered` the instant this class is registered,
// before any subsystem's `init()` runs: the whole boot, dead.
// `src/items/index.js` ("why this is `[]`, not `['materials']`"),
// `src/world/index.js:324` and `src/actors/index.js:218` are the established
// precedent for this exact move (each omits a not-yet-built dependency and
// says so here). Once `src/fx/` is registered, this line goes back to
// `['actors', 'combat', 'fx', 'physics']` at the same time `fx` itself is
// added.
//
// `physics` is ADDED here (SKIL-3): `cleaving_strike`'s cone query
// (`physics.overlapCone`) is this ticket's own reason to reach it, and
// `physics` is registered well before `skills` in `main.js` (physics has no
// deps of its own), so this is a safe, correctly-ordered addition, not a
// cycle.
//
// `actors` and `combat` ARE both registered already, and THIS ticket is the
// first to actually call `ctx.get('actors')`/`ctx.get('combat')` (cached
// once below, in `init()`, never re-fetched per cast — `ctx.get()` itself
// is cheap/non-allocating, but a single stable reference is simpler to
// reason about than N `Map#get` calls per action).
//
// ---------------------------------------------------------------------------
// No `ctx.rng.fork()` here (true through SKIL-5 — SKIL-6 changes this, see
// below)
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md`'s Determinism contract: "one fork per subsystem, taken
// once in init(), never re-forked" — a rule about how a fork is taken IF
// randomness is needed, not a mandate to take an unused one. Nothing in
// this ticket draws randomness (no casting, no rolls, no jitter — `all`,
// `forClass`, `forTree`, `trees`, `instanceOf`, `effectiveLevel`,
// `canAllocate`, `allocate`, `respec`, `synergyBonus` are all pure reads/
// writes over static data and per-actor allocation state). A fork taken now
// and left unused would be dead code that the FIRST later ticket to
// actually need RNG (skill FX jitter, per `03 §8`'s procedural systems)
// would have to notice and reuse correctly anyway — so it is left for that
// ticket to take, once there is a real call site to point at.
//
// SKIL-6 IS that later ticket: `./status.js#applyCoefficientRider`'s
// `bleeding`/`burning` chance roll (`U(0,100) < rider.chance`) cannot reach
// `combat`'s own forked stream (those two statuses never touch
// `combat.applyStatusFromPacket()` — see `status.js`'s own header for why),
// so `skills` now takes its own single fork, below, used ONLY by that one
// call site. Rule 3's "Status riders roll U(0,100) < chance — that draw must
// come from a forked stream, deterministically" is this ticket's own
// instruction, verbatim.
//
// ---------------------------------------------------------------------------
// Storage gap: where per-actor allocated points live (report this)
// ---------------------------------------------------------------------------
// `01-data-model.md` §2's `Actor` record (`src/actors/`, out of this
// ticket's scope — file-list discipline forbids editing it) has NO field
// for "skillId -> allocated points". `SkillBonuses` (`+N to a skill`) DOES
// already have a home — `actor.stats.skillBonuses` (`{all, tree, skill}`),
// built once per actor by `src/actors/stats.js#createStatBlock()` and read
// directly below for `effectiveLevel()` — but the player's own SPENT points
// (`SkillInstance.allocated`, `01` §6.2) have nowhere else to live. The
// closest existing shape is `CharacterSave.skills` (`01` §10.2: `{ skillId:
// allocated points }`, absent key === 0) — so that is the shape reused
// here, lazily attached as `actor.skillPoints` the first time any
// allocation method touches a given actor (see `pointsOf()` below).
//
// This is a real, load-bearing choice, not a private implementation detail:
// `actor.skillPoints` is NOT declared on the Actor record, so nothing in
// `src/actors/` resets it when a pooled actor slot is recycled
// (`poolIndex`/`active`/`generation`) — a stale allocation could, in
// principle, leak onto a freshly spawned actor reusing the same pool slot.
// This does not happen in practice for the SINGLE player actor a session
// currently spawns once, but it is a real gap for whichever ticket adds
// multi-character load/character-select within one process. Flagged in
// this ticket's report; not fixed here (would require editing
// `src/actors/`, outside this ticket's file list).
//
// ---------------------------------------------------------------------------
// Alloc: no, over eleven methods — the discipline every one of them follows
// ---------------------------------------------------------------------------
// Every row of `02-api-contracts.md` §10's table is `Alloc: no`. Two
// different techniques make that true here:
//
//   1. `all` / `forClass` / `forTree` / `trees` — built ONCE, in `init()`,
//      into `this._all` / `this._byClass` / `this._byTree` /
//      `this._treesByClass`, and the SAME array reference is returned on
//      every call thereafter (never rebuilt per call). Callers must treat
//      the returned array as READ-ONLY — mutating it corrupts the registry
//      for every other caller. `EMPTY` (module scope, one frozen array) is
//      returned for an unknown `classId`/`treeId` so that path never
//      allocates a fresh `[]` either.
//
//   2. `instanceOf` / `canAllocate` — return a SHARED SCRATCH OBJECT owned
//      by this instance (`this._scratchInstance` / `this._scratchResult`),
//      mutated in place and returned, exactly the "shared scratch object
//      owned by the callee, valid until the next call to that method"
//      convention `02-api-contracts.md`'s own conventions section
//      documents for `out`-less methods, and the same discipline
//      `combat.scratchPacket()` already established (`src/combat/
//      packet.js`). Copy the fields out; never hold the reference across
//      another call.
//
// `definition`, `effectiveLevel`, `allocate`, `respec` and `synergyBonus`
// return plain numbers/booleans/`null` — no object to reuse, nothing to
// allocate.
//
// `allocate()`/`respec()` mutate `actor.skillPoints` (a plain object) via
// EXISTING-key writes wherever possible: `respec()` walks it with `for...in`
// (never `Object.keys()`, which would allocate an array) and sets each
// value to `0` rather than deleting the key (deleting reshapes the
// object's hidden class every time; writing `0` does not). The ONE
// unavoidable allocation is the very first time a given actor's
// `skillPoints` object itself is created (`pointsOf()`, below) — a one-time
// per-actor cost, the same shape as `actors/stats.js#createStatBlock()`'s
// own lazy first-composition, and not part of any steady-state `Alloc: no`
// call once that first call has happened for a given actor.

import { SKILLS } from './data/skills.js';
import { computeCost, cooldownRemainingSteps } from './cost.js';
// SKIL-3 — the first real cast path (`05` §14 row 3). `./impl/` holds one
// file per skill with a wired `cast()`; only `cleaving_strike` exists yet
// (D-37 scope — this ticket implements that skill only). See
// `createCleavingStrikeSkill`'s own file header for what it owns.
import { createCleavingStrikeSkill } from './impl/cleaving_strike.js';
// SKIL-4 — `ember_bolt` (projectile) and `rune_strike` (melee, NOT a
// projectile — D-43). `./projectile.js` is the `Projectile` pool
// (`01-data-model.md:1691`) and its flight simulation, driven from
// `fixedUpdate` below; see that file's own header for the pool-cap
// reconciliation (D-47) and the pierce/exclusion design.
import { createEmberBoltSkill } from './impl/bolt.js';
import { createRuneStrikeSkill } from './impl/rune_strike.js';
import { ProjectilePool, projectilePoolCapacityFor, advanceProjectiles } from './projectile.js';
// SKIL-5 — passives (`05` §14 row 5 / `05.S08`). `./passive.js` is the pure
// engine (see that file's own header); this module owns wiring its output
// onto `actors.setSourceLayer(actor, 'skills', partial)` +
// `actors.markDirty(actor)` — see `_syncPassiveLayer` below.
import { computePassiveLayer } from './passive.js';
// SKIL-6 — the general skill-applied-status engine and `incinerate`'s
// on-kill detonation reaction. `./status.js` is the pure/near-pure engine
// (see that file's own header for the full reasoning); this module owns
// taking the one RNG fork it needs and wiring `createIncinerateReaction`'s
// output onto a permanent `ctx.events.on('actor:damage', ...)` listener —
// incinerate is a passive, always live, never cast, so this is the one
// piece of SKIL-6's engine reachable through real gameplay today (the
// onHitStatus rider engine has no cast-wired skill among its ten to reach
// it from yet — D-37 scope, see `status.js`'s own header and this ticket's
// report).
import { createIncinerateReaction } from './status.js';
// SKIL-13 — `blade_seal` (the Resonance imbue) and `cascade` (the three-
// empowered-hit trigger). `./imbue.js` is the engine (see that file's own
// header for D-44/D-05-2 and every other decision this ticket made); this
// module owns wiring its `blade_seal` cast handler onto the dispatch table,
// its shared `actor:damage`/`zone:teardown` listeners, and the three
// `02-api-contracts.md` §10 read methods (`imbueRemaining`/`imbueElement`/
// `cascadeCharges`) plus the buff-view methods below.
import { createImbueEngine } from './imbue.js';
// SKIL-7 — `whirlwind` (channel) and `polarity` (toggle). `./channel.js` is
// the engine (see that file's own header for the R2-vs-CMBT-8 reconciliation
// and every other decision this ticket made); this module owns wiring its
// two cast handlers onto the dispatch table, its own `fixedUpdate`, the
// `interrupt`/`isChannelling`/`polarityStance` §10 read methods, and merging
// its stat contribution into `_syncPassiveLayer` below.
import { createChannelEngine } from './channel.js';
// SKIL-8 — ram_charge, ashen_step, phase_leap, thunder_step (mobility).
// `./mobility.js` is the engine (see that file's own header for the O-25
// routing decision, the nav backward-walk, and every gap it found); this
// module owns wiring its four cast handlers onto the dispatch table and its
// own `fixedUpdate` (phase_leap's one-step-delayed strike). `nav` is a NEW
// dependency this ticket adds — see "why nav is added here" below.
import { createMobilityEngine } from './mobility.js';
// SKIL-9 — ground effects and hazards (`05` §14 row 9). `./ground.js` is the
// engine (see that file's own header for the `nav.markHazard` gap, the
// `GroundEffectSpawn` shape, the projectile-absorption internal-field read,
// and every other decision this ticket made); this module owns wiring the
// two `02-api-contracts.md` §10 contract methods, the pool's own
// `fixedUpdate` advance, the `zone:teardown`/`actor:death` listeners (two of
// this ticket's three deregistration exit paths — the third, expiry, lives
// entirely inside `advanceGroundEffects` itself), and augmenting the already-
// wired `ashen_step` cast (SKIL-8, `./mobility.js`, unedited) to spawn its
// non-hazard cloud at the departure point.
import {
  GroundEffectPool, groundEffectPoolCapacityFor,
  addGroundEffect as spawnGroundEffect, removeGroundEffect as despawnGroundEffect,
  advanceGroundEffects, onZoneTeardown as groundOnZoneTeardown, onActorDeath as groundOnActorDeath,
  buildAshenStepCloudSpec,
} from './ground.js';
// SKIL-10 — the general buff/absorb/trigger engine (`05` §14 row 10):
// `applyBuff`/`removeBuff`/`hasBuff`/`buffRemaining`/`buffList` GENERALISED
// beyond `blade_seal` (see `./buff.js`'s own header — it delegates to
// `_imbueEngine` for that one, never reimplementing it), `absorbRemaining`
// added from scratch, and `war_cry`/`smouldering_ward`'s buff mechanics plus
// `last_stand`'s own automatic passive trigger. This module owns wiring its
// `writeStatPartial` into the SAME `'skills'` layer partial `_syncPassiveLayer`
// already composes, and its `actor:damage` listener (the `last_stand`
// trigger — see `buff.js`'s own header for why that reaction lives there
// rather than inside `src/combat/resolve.js`'s R14).
import { createBuffEngine } from './buff.js';
// SKIL-11 — `echo_blade` (the `visualOnly` summon) and `unity` (the
// landed-hit free-cast of `discharge`). `./summon.js` is the engine (see
// that file's own header for the reentrancy hazard this ticket found in
// already-accepted `src/combat/` code, the O-88 finding, and every other
// decision it made); this module owns wiring its two cast handlers onto the
// dispatch table, its own `fixedUpdate` drain, the `actor:damage`/
// `actor:death`/`zone:teardown` listeners, the new `summonOf` contract
// method, and special-casing `'unity'` inside the five already-existing
// generalised buff methods below (SKIL-10's `_buffEngine` has no data curve
// for `'unity'` and is not this ticket's file to extend).
import { createSummonEngine } from './summon.js';
// SKIL-12 — the synergy graph proof (S11, `05` §14 row 12) and
// `describe()`'s coefficient engine (`02-api-contracts.md:886`, UI-9's
// blocker). See `./synergy.js`'s own header for the B2-add-vs-B7-multiply
// distinction and the two documented gaps (`range`, weapon-skill absolute
// damage) this ticket's report carries.
import { validateSynergyGraph, buildSkillDescription, resetSkillDescription } from './synergy.js';

/** One frozen, reused empty array — returned for an unknown classId/treeId
 * instead of allocating a fresh `[]` per miss. */
const EMPTY = Object.freeze([]);

/** `01-data-model.md` §3.5's `SkillBonuses` shape, at its zero default —
 * returned when `actor.stats` (or `actor.stats.skillBonuses`) is not yet
 * composed, so `effectiveLevel()` never allocates a fallback object either. */
const ZERO_SKILL_BONUSES = Object.freeze({ all: 0, tree: Object.freeze({}), skill: Object.freeze({}) });

/**
 * `actor.skillPoints` — see the file header's "Storage gap" section. Lazily
 * creates the map on first touch for a given actor; every call after the
 * first for that actor is a property read, not an allocation.
 * @param {object} actor
 * @returns {Record<string, number>}
 */
function pointsOf(actor) {
  let p = actor.skillPoints;
  if (!p) {
    p = Object.create(null);
    actor.skillPoints = p;
  }
  return p;
}

/** @param {object} actor @param {string} skillId @returns {number} */
function allocatedOf(actor, skillId) {
  const p = actor.skillPoints;
  if (!p) return 0;
  const v = p[skillId];
  return v || 0;
}

export class SkillsSystem {
  static id = 'skills';
  // SKIL-8 — 'nav' deliberately NOT added here, unlike 'physics' (SKIL-3).
  // ram_charge/ashen_step/thunder_step's own dash clipping and phase_leap's
  // far-side landing all need `nav.snap()`, but `NavSystem.deps = ['world']`
  // and `WorldSystem.deps = ['materials', 'physics']` — declaring 'nav'
  // here would force EVERY ctx that boots `skills` (including several
  // already-accepted SKIL-5 "light Registry" tests —
  // `tests/skills/passive.test.js`/`passive.perf.test.js`/
  // `cleaving_strike.perf.test.js`, none of them this ticket's to edit — to
  // also register `WorldSystem` + `MaterialsSystem`, real subsystems this
  // ticket has no reason to pull into a lightweight skills-only ctx and
  // which live closer to the render/N-boundary than this file's own
  // Node-safe scope. `nav` is instead reached ONLY via `ctx.peek('nav')`
  // (below, and in `_skillDeps`) — the same "degrade, don't throw against a
  // minimal ctx" convention `physics`/`actors`/`combat` already use. On the
  // real `main.js` boot path this is still SAFE, not merely hopeful:
  // `NavSystem` is registered (position 6) strictly before `SkillsSystem`
  // (position 8) and nothing forces `skills` to resolve earlier, so
  // `Registry.resolve()`'s own top-level `for (const id of
  // this._registrationOrder) visit(id)` loop (`src/core/registry.js`)
  // finishes `nav`'s subtree — and marks it `_ready` — before `skills`'
  // `init()` ever runs, with no declared edge required. This IS a real,
  // documented risk if `main.js`'s registration order ever changes nav
  // after skills — flagged in this ticket's report, not silently relied on.
  static deps = ['actors', 'combat', 'physics']; // 'fx' omitted — not registered yet, see header above

  async init(ctx) {
    this._ctx = ctx;

    // --- registry caches, built once, returned by reference forever after ---
    this._all = SKILLS; // SKILLS is itself Object.freeze()'d and immutable — no copy needed
    this._byId = new Map();
    this._byClass = new Map();
    this._byTree = new Map();
    this._treesByClass = new Map();
    // O-59: integer index per skillId, resolved once here so a later
    // ticket's hot-path skill dispatch can key on an int rather than a
    // template-string-built Map key. Not a `02-api-contracts.md` contract
    // method (rule 7 forbids inventing one) — a plain internal property a
    // same-subsystem ticket can read directly (`skills._indexById`).
    this._indexById = new Map();

    for (let i = 0; i < this._all.length; i++) {
      const def = this._all[i];
      this._byId.set(def.id, def);
      this._indexById.set(def.id, i);

      let classArr = this._byClass.get(def.classId);
      if (!classArr) { classArr = []; this._byClass.set(def.classId, classArr); }
      classArr.push(def);

      let treeArr = this._byTree.get(def.tree);
      if (!treeArr) { treeArr = []; this._byTree.set(def.tree, treeArr); }
      treeArr.push(def);

      let treeList = this._treesByClass.get(def.classId);
      if (!treeList) { treeList = []; this._treesByClass.set(def.classId, treeList); }
      if (!treeList.includes(def.tree)) treeList.push(def.tree);
    }

    for (const arr of this._byClass.values()) Object.freeze(arr);
    for (const arr of this._byTree.values()) Object.freeze(arr);
    for (const arr of this._treesByClass.values()) Object.freeze(arr);

    // SKIL-12 — S11, wired: run once here, at boot, over the live SKILLS
    // table, not just asserted by a standalone test. Not a hot-path call
    // (one Registry per process lifetime calls `init()` once), so the two
    // throwaway `Map`s/`Set`s `validateSynergyGraph` builds internally are
    // fine — see `./synergy.js`'s own header. Throws rather than degrading:
    // a broken synergy graph (a reciprocal edge, a cross-class edge, a
    // dangling source) is a data-authoring defect this ticket has no
    // business silently tolerating at runtime.
    const synergyCheck = validateSynergyGraph(this._all);
    if (!synergyCheck.ok) {
      throw new Error(`skills: synergy graph invalid (S11) — ${synergyCheck.errors.join('; ')}`);
    }

    // SKIL-5 — every `type: 'passive'` skill (D-46: eight, never hard-coded
    // as a literal here — see `./passive.js`'s own header), built once and
    // reused by `_syncPassiveLayer` below in registry order (`01` §4.2 step
    // 5: "in skill-registry order"). `last_stand`/`cascade` are included
    // (their own `type` IS `'passive'`) even though their `passiveStats` is
    // `null` — `computePassiveLayer` skips a `null` table on its own.
    this._passiveDefs = Object.freeze(this._all.filter((d) => d.type === 'passive'));

    // --- scratch objects, mutated in place and returned by reference ---
    // (see the file header's "Alloc: no" section, technique 2)
    this._scratchInstance = { skillId: null, allocated: 0, effectiveLevel: 0, unlocked: false, onHotbar: 0 };
    this._scratchResult = { ok: false, reason: null };
    // SKIL-2 — same "shared scratch object" technique as `_scratchInstance`/
    // `_scratchResult` above, for `costOf`'s `{resource, amount}` return
    // (`02-api-contracts.md` §10: `Alloc: no`).
    this._scratchCost = { resource: null, amount: 0 };
    // SKIL-12 — `describe()`'s own scratch bag, the same technique as
    // `_scratchCost` just above, passed to `buildSkillDescription`
    // (`./synergy.js`) every call and mutated in place there.
    this._scratchDescribe = { cost: { resource: null, amount: 0 }, damageRange: { min: 0, max: 0 } };

    // ---------------------------------------------------------------------
    // SKIL-3 — casting: cached subsystem refs, the O-59 int-indexed cast
    // dispatch table, and the permanent `ctx.events` listener that drives
    // `cleaving_strike`'s deferred hit resolution. See the file header and
    // `./impl/cleaving_strike.js`'s own header for the full reasoning.
    // ---------------------------------------------------------------------
    // `ctx.peek()`, not `ctx.get()` — `static deps` above guarantees these
    // ARE present on the real `main.js` boot path, but several already-
    // accepted SKIL-1/SKIL-2 tests build a bare stub `ctx` with no
    // `systems` at all (registry-only methods never needed one) and must
    // keep working unchanged; `ctx.get()` would throw for them the instant
    // `init()` ran. `canCast()`/`cast()` below fail closed (`false`/a
    // refusal) rather than null-deref when one of these is absent — the
    // same "degrade, don't throw, when an optional dep is missing from a
    // minimal ctx" convention `src/actors/index.js#init` already uses for
    // `physics` itself.
    this._actorsSys = ctx.peek('actors') ?? null;
    this._combatSys = ctx.peek('combat') ?? null;
    this._physicsSys = ctx.peek('physics') ?? null;
    // SKIL-8 — same "peek, degrade rather than throw against a minimal test
    // ctx" convention as the three above.
    this._navSys = ctx.peek('nav') ?? null;

    // SKIL-5 — two stable callbacks for `_syncPassiveLayer`/
    // `computePassiveLayer` below, created ONCE here rather than as a fresh
    // arrow function inside `_syncPassiveLayer` on every call — `allocate`/
    // `respec` are both contracted `Alloc: no` (`02-api-contracts.md` §10's
    // "Registry and allocation" table), so a per-call closure allocation on
    // a passive `allocate()` would be a real, if small, contract violation.
    this._effectiveLevelFn = (a, id) => this.effectiveLevel(a, id);
    this._synergyBonusFn = (a, id, statKey) => this.synergyBonus(a, id, statKey);

    this._scratchCanCast = { ok: false, reason: null };
    // SKIL-6 — the one RNG fork this subsystem takes (see the file header,
    // "No ctx.rng.fork() here"), used only by `status.js#applyCoefficientRider`'s
    // `bleeding`/`burning` chance roll.
    this._statusRng = ctx.rng.fork();
    // A single stable deps bag, reused for every `anim:hitframe`/cast call —
    // never rebuilt per call (rule 5/6: zero allocation on the cast path).
    // `time`/`events` are the live `ctx` objects themselves (mutated in
    // place by the engine, never replaced), so holding these references for
    // the subsystem's whole lifetime is safe.
    this._skillDeps = {
      actors: this._actorsSys, combat: this._combatSys, physics: this._physicsSys,
      nav: this._navSys, // SKIL-8
      events: ctx.events, time: ctx.time, skills: this, rng: this._statusRng,
      // SKIL-13 — a private (non-contract) callback threaded through `deps`,
      // the same "bound helper, not a public method" precedent
      // `_effectiveLevelFn`/`_synergyBonusFn` already establish. Lets
      // imbue.js recompose the merged 'skills' stat layer (passives + the
      // imbue's own fireMin/coldMin/lightMin) without a second, competing
      // `setSourceLayer('skills', ...)` call — see imbue.js's own header.
      syncSkillsLayer: (actor) => this._syncPassiveLayer(actor),
    };

    this._castHandlers = new Array(this._all.length).fill(null);
    const cleavingStrikeIdx = this._indexById.get('cleaving_strike');
    const cleavingStrike = createCleavingStrikeSkill();
    this._castHandlers[cleavingStrikeIdx] = cleavingStrike;

    // SKIL-4 — ember_bolt (projectile) and rune_strike (melee). Same
    // dispatch-table wiring as cleaving_strike above.
    const emberBoltIdx = this._indexById.get('ember_bolt');
    this._castHandlers[emberBoltIdx] = createEmberBoltSkill();
    const runeStrikeIdx = this._indexById.get('rune_strike');
    this._castHandlers[runeStrikeIdx] = createRuneStrikeSkill();

    // SKIL-13 — blade_seal (cast-wired) and cascade (purely reactive — no
    // cast handler, same as incinerate's own passive-trigger shape). One
    // engine instance per SkillsSystem (never module-scope state — see
    // imbue.js's own header).
    this._imbueEngine = createImbueEngine();
    const bladeSealIdx = this._indexById.get('blade_seal');
    this._castHandlers[bladeSealIdx] = this._imbueEngine.bladeSeal;
    // SKIL-10 — `buff.js`'s generalised buff/absorb/trigger engine needs a
    // reference to `_imbueEngine` for its own `blade_seal` delegation (see
    // that file's header) — added onto the shared `_skillDeps` bag the same
    // way `_skillDeps.projectilePool` is added later, below, after its own
    // pool is constructed.
    this._buffEngine = createBuffEngine();
    this._skillDeps.imbueEngine = this._imbueEngine;

    // SKIL-11 — echo_blade (summon) and unity (free-cast). Same dispatch-
    // table wiring as every other skill above; see summon.js's own header
    // for why this engine also needs its OWN fixedUpdate call (below, after
    // advanceProjectiles so a freed pool slot from this same step's decay is
    // visible to a chain resolved later in the same step) and its own
    // `actor:damage`/`actor:death`/`zone:teardown` listeners.
    this._summonEngine = createSummonEngine();
    this._castHandlers[this._indexById.get('unity')] = this._summonEngine.unity;
    this._castHandlers[this._indexById.get('echo_blade')] = this._summonEngine.echoBlade;

    // SKIL-7 — whirlwind (channel) and polarity (toggle). Same dispatch-
    // table wiring as every other skill above; see channel.js's own header
    // for why this engine also needs its OWN fixedUpdate call (below) and
    // is merged into _syncPassiveLayer's partial (also below).
    this._channelEngine = createChannelEngine(this._effectiveLevelFn);
    const whirlwindIdx = this._indexById.get('whirlwind');
    this._castHandlers[whirlwindIdx] = this._channelEngine.whirlwind;
    const polarityIdx = this._indexById.get('polarity');
    this._castHandlers[polarityIdx] = this._channelEngine.polarity;

    // SKIL-8 — ram_charge, ashen_step, phase_leap, thunder_step (mobility).
    // Same dispatch-table wiring as every other skill above; see
    // mobility.js's own header for why this engine also needs its OWN
    // fixedUpdate call (below), for phase_leap's one-step-delayed strike.
    this._mobilityEngine = createMobilityEngine();
    this._castHandlers[this._indexById.get('ram_charge')] = this._mobilityEngine.ram_charge;
    this._castHandlers[this._indexById.get('ashen_step')] = this._mobilityEngine.ashen_step;
    this._castHandlers[this._indexById.get('phase_leap')] = this._mobilityEngine.phase_leap;
    this._castHandlers[this._indexById.get('thunder_step')] = this._mobilityEngine.thunder_step;

    // SKIL-4 — the Projectile pool (`01-data-model.md:1691`, D-47's own
    // reconciliation — see `./projectile.js`'s header). LOD-tiered off
    // `ctx.config.quality`, same lookup-table precedent
    // `src/actors/index.js`'s own `POOL_CAPACITY` establishes for the
    // identical "no ctx.config.q field for this budget" situation.
    this._projectilePool = new ProjectilePool(projectilePoolCapacityFor(ctx));

    // SKIL-9 — the GroundEffect pool (`01-data-model.md:1702`). Same LOD-
    // tiered lookup precedent as the Projectile pool immediately above.
    this._groundEffectPool = new GroundEffectPool(groundEffectPoolCapacityFor(ctx));
    // `ground.js`'s own ash_wall absorption reads this pool's internal
    // fields directly (see that file's header) — wired onto the SAME shared
    // `_skillDeps` bag every other engine already reads, as a field no
    // other engine looks at.
    this._skillDeps.projectilePool = this._projectilePool;

    // `anim:hitframe` — the tick `cleaving_strike`'s cast() recorded gets
    // resolved (see that file's header for why resolution is deferred to
    // this event rather than run synchronously inside `cast()`).
    // `this._indexById.get(payload.actionId)` is undefined for a non-skill
    // `anim:hitframe` (a basic attack, `actionId: 'attack'`) —
    // `_castHandlers[undefined]` is `undefined`, which the `handler &&`
    // guard below already treats as "not mine".
    //
    // No `actor:damage` listener here: R1's "one rage award per action" is
    // `combat`'s own job (CMBT-8/D-51 — `src/combat/onhit.js#applyOnHitEconomy`
    // now gates on `(source.generation, source.actionSeq)` itself), so
    // `skills` has nothing left to react to on that event for this ticket's
    // skill. See `impl/cleaving_strike.js`'s own header for the finding and
    // the fix.
    this._onHitframe = (payload) => {
      const handler = this._castHandlers[this._indexById.get(payload.actionId)];
      if (handler && typeof handler.onHitframe === 'function') handler.onHitframe(payload, this._skillDeps);
    };
    ctx.events.on('anim:hitframe', this._onHitframe);

    // SKIL-6 — `incinerate`'s on-kill detonation. A permanent listener
    // (matching `_onHitframe`'s own shape above), since the trigger is a
    // passive condition on `actor:damage`, not tied to any one skill's
    // cast — see `status.js#createIncinerateReaction`'s own header for the
    // re-entrancy guard and why this is real, live-reachable gameplay today
    // even though the other nine skills this ticket touches are not
    // cast-wired.
    this._incinerateReaction = createIncinerateReaction(this._skillDeps);
    this._onActorDamageForIncinerate = (payload) => this._incinerateReaction.onActorDamage(payload);
    ctx.events.on('actor:damage', this._onActorDamageForIncinerate);

    // SKIL-13 — the shared listener imbue.js's own header describes: imbue
    // decrement AND cascade's counter/trigger, one `actor:damage` reaction.
    // `zone:teardown` resets cascade's own counter only (05 §6.3) — see
    // imbue.js's own header for why the imbue itself is not reset there.
    this._onActorDamageForImbue = (payload) => this._imbueEngine.onActorDamage(payload, this._skillDeps);
    ctx.events.on('actor:damage', this._onActorDamageForImbue);
    this._onZoneTeardownForCascade = () => this._imbueEngine.onZoneTeardown();
    ctx.events.on('zone:teardown', this._onZoneTeardownForCascade);

    // SKIL-10 — `last_stand`'s own automatic passive trigger (`05` §3.5):
    // evaluated on every `actor:damage` since the trigger condition
    // (`life <= 0.25 x maxLife`) can only be checked AFTER R14(a) already
    // ran `life -= total` — see `buff.js#maybeTriggerLastStand`'s own header
    // for why this is a post-hoc reaction rather than an edit to
    // `resolve.js`'s R14 (out of this ticket's granted micro-scope, O-90).
    this._onActorDamageForBuff = (payload) => this._buffEngine.onActorDamage(payload, this._skillDeps);
    ctx.events.on('actor:damage', this._onActorDamageForBuff);

    // SKIL-9 — two of the three ground-effect deregistration exit paths
    // (the third, expiry, is driven every step from `fixedUpdate` below,
    // inside `advanceGroundEffects` itself — no event needed for it).
    // `02-api-contracts.md` §10's own "Listens" row names `zone:teardown`
    // for "clears projectiles and ground effects" — this is the ground-
    // effect half of that row (the projectile half is unwired, a pre-
    // existing gap this ticket found but does not own — see this ticket's
    // report). `actor:death`'s payload (`ARCHITECTURE.md`'s own event
    // table: `{actor, killer, point}`) names the ACTOR record itself, not
    // just an id — `payload.actor.id` is read directly, matching every
    // other `actor:death`/`actor:damage` listener in this file.
    this._onZoneTeardownForGround = () => groundOnZoneTeardown(this._groundEffectPool, this._skillDeps);
    ctx.events.on('zone:teardown', this._onZoneTeardownForGround);
    this._onActorDeathForGround = (payload) => {
      if (payload && payload.actor) groundOnActorDeath(this._groundEffectPool, this._skillDeps, payload.actor.id);
    };
    ctx.events.on('actor:death', this._onActorDeathForGround);

    // SKIL-11 — `unity`'s landed-hit hook. NEVER emits `combat:hit-request`
    // itself (see summon.js's header for the reentrancy hazard this would
    // hit if it did) — only enqueues; the real chain resolves from
    // `fixedUpdate` below. `echo_blade`'s own two exit paths mirror
    // ground.js's own precedent immediately above.
    this._onActorDamageForSummon = (payload) => this._summonEngine.onActorDamage(payload, this._skillDeps);
    ctx.events.on('actor:damage', this._onActorDamageForSummon);
    this._onActorDeathForSummon = (payload) => {
      if (payload && payload.actor) this._summonEngine.onActorDeath(payload.actor, this._skillDeps);
    };
    ctx.events.on('actor:death', this._onActorDeathForSummon);
    // `actors` emits `actor:despawn` for every despawn (death, an explicit
    // external `actors.despawn()` call, or `zone:ready`'s own sweep) — see
    // summon.js's own `onActorDespawn` comment for why this general
    // backstop exists alongside the death-specific listener above.
    this._onActorDespawnForSummon = (payload) => {
      if (payload && payload.actor) this._summonEngine.onActorDespawn(payload.actor);
    };
    ctx.events.on('actor:despawn', this._onActorDespawnForSummon);
    this._onZoneTeardownForSummon = () => this._summonEngine.onZoneTeardown();
    ctx.events.on('zone:teardown', this._onZoneTeardownForSummon);
  }

  // ---------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------

  /** @param {string} skillId @returns {object|null} */
  definition(skillId) {
    return this._byId.get(skillId) || null;
  }

  /** @returns {object[]} all 30, read-only, same reference every call */
  get all() {
    return this._all;
  }

  /** @param {string} classId @returns {object[]} 10, read-only, same reference every call for a given classId */
  forClass(classId) {
    return this._byClass.get(classId) || EMPTY;
  }

  /** @param {string} treeId @returns {object[]} 5, read-only, same reference every call for a given treeId */
  forTree(treeId) {
    return this._byTree.get(treeId) || EMPTY;
  }

  /** @param {string} classId @returns {string[]} 2, read-only, same reference every call for a given classId */
  trees(classId) {
    return this._treesByClass.get(classId) || EMPTY;
  }

  // ---------------------------------------------------------------------
  // Per-actor allocation
  // ---------------------------------------------------------------------

  /**
   * @param {object} actor
   * @param {string} skillId
   * @returns {object|null} a SHARED SCRATCH `SkillInstance` — copy its
   *   fields or use them before the next `instanceOf`/`canAllocate` call.
   */
  instanceOf(actor, skillId) {
    const def = this._byId.get(skillId);
    if (!def) return null;

    const inst = this._scratchInstance;
    inst.skillId = skillId;
    inst.allocated = allocatedOf(actor, skillId);
    inst.effectiveLevel = this.effectiveLevel(actor, skillId);
    inst.unlocked = this._tierAndPrereqMet(actor, def);
    // Hotbar assignment lives on the `player`/`Hotbar` record (`01` §6.4),
    // not tracked by `skills` this ticket (no casting, no hotbar wiring —
    // `05` §14 row 1). Always 0 until that ticket reads the real hotbar via
    // `ctx.get('player')`.
    inst.onHotbar = 0;
    return inst;
  }

  /** @param {object} actor @param {string} skillId @returns {number} 0..40 */
  effectiveLevel(actor, skillId) {
    const allocated = allocatedOf(actor, skillId);
    // 01 §6.2: "allocated === 0 -> effectiveLevel is forced to 0 no matter
    // how many +skills the actor has."
    if (allocated <= 0) return 0;

    const def = this._byId.get(skillId);
    if (!def) return 0;

    const sb = (actor.stats && actor.stats.skillBonuses) || ZERO_SKILL_BONUSES;
    let level = allocated + (sb.all || 0) + (sb.tree[def.tree] || 0) + (sb.skill[skillId] || 0);
    if (level < 0) level = 0;
    else if (level > 40) level = 40;
    return level;
  }

  /**
   * Tier and prerequisite check only — deliberately NOT what `allocate()`
   * itself checks (`02-api-contracts.md:918`, quoted in this ticket's brief:
   * "canAllocate() ... allocate() ... does not validate tier or
   * prerequisites, by design, so the respec path can rebuild a tree in one
   * pass").
   * @param {object} actor @param {string} skillId
   * @returns {object} a SHARED SCRATCH `{ok, reason}` — copy before the next call.
   */
  canAllocate(actor, skillId) {
    const def = this._byId.get(skillId);
    const out = this._scratchResult;
    if (!def) { out.ok = false; out.reason = 'unknown'; return out; }

    if (actor.classId && actor.classId !== def.classId) { out.ok = false; out.reason = 'class'; return out; }
    if ((actor.level || 0) < def.tier) { out.ok = false; out.reason = 'tier'; return out; }
    if (!this._prereqMet(actor, def)) { out.ok = false; out.reason = 'prereq'; return out; }
    if (allocatedOf(actor, skillId) >= def.maxLevel) { out.ok = false; out.reason = 'maxed'; return out; }

    out.ok = true; out.reason = null;
    return out;
  }

  /**
   * Spends one point. Deliberately does NOT re-check tier or prerequisites
   * (`02-api-contracts.md:918` — see `canAllocate`'s own doc comment above)
   * so `respec()` can replay an allocation in any order. DOES enforce the
   * `maxLevel` cap (a structural invariant of `SkillInstance.allocated`,
   * `01` §6.2, not a tier/prereq check) and that the id is real.
   * @param {object} actor @param {string} skillId
   * @returns {boolean} whether a point was spent
   */
  allocate(actor, skillId) {
    const def = this._byId.get(skillId);
    if (!def) return false;

    const points = pointsOf(actor);
    const current = points[skillId] || 0;
    if (current >= def.maxLevel) return false;

    points[skillId] = current + 1;
    // SKIL-5 — `05` §14 row 5: "stats:dirty on allocation". Only a
    // `type:'passive'` skill can change what the `skills` layer contributes
    // (a non-passive spend, e.g. `cleaving_strike`, cannot — see
    // `./passive.js`'s own header for which ids reach `_syncPassiveLayer`'s
    // `passiveDefs` walk at all), so this stays a no-op resync for every
    // other skill rather than an unconditional one.
    if (def.type === 'passive') this._syncPassiveLayer(actor);
    return true;
  }

  /**
   * Refunds every allocated point on this actor back to zero.
   * @param {object} actor
   * @returns {number} points refunded
   */
  respec(actor) {
    const points = pointsOf(actor);
    let refunded = 0;
    // for...in, never Object.keys() (which allocates a fresh array) — see
    // the file header's "Alloc: no" section.
    for (const skillId in points) {
      refunded += points[skillId];
      points[skillId] = 0;
    }
    // SKIL-5 — a respec that actually refunded something can only ever
    // zero out every passive's contribution (never raise one), so this
    // still counts as "allocation changed" for `stats:dirty` purposes. A
    // no-op respec (already-empty actor, `refunded === 0`) skips the
    // resync/emit — nothing changed to report.
    if (refunded > 0) this._syncPassiveLayer(actor);
    return refunded;
  }

  /**
   * Recomputes the actor's full passive `sources.skills` partial
   * (`./passive.js#computePassiveLayer`) and pushes it through
   * `actors.setSourceLayer` + `actors.markDirty` — `setSourceLayer` alone
   * does NOT emit `stats:dirty` (D-29/ACTR-15, `src/actors/index.js`'s own
   * `markDirty`/`setSourceLayer` doc comments); `markDirty` is the only row
   * whose contract says it does, so both are called here, in that order.
   * A no-op if `actors` was never wired into this `ctx` (several accepted
   * SKIL-1/SKIL-2 tests build a bare stub `ctx` with no `systems` at all —
   * same degrade-don't-throw convention `canCast()` already uses).
   * @param {object} actor
   */
  _syncPassiveLayer(actor) {
    if (!this._actorsSys) return;
    const partial = computePassiveLayer(actor, this._passiveDefs, this._effectiveLevelFn, this._synergyBonusFn);
    // SKIL-13 — merge blade_seal's own fireMin/coldMin/lightMin contribution
    // into the SAME partial before the one setSourceLayer call below (see
    // imbue.js's own header, "The stat layer" section — a second,
    // independent setSourceLayer('skills', ...) call would silently erase
    // whichever of the two ran second).
    if (this._imbueEngine) this._imbueEngine.writeImbueStatPartial(actor, partial);
    // SKIL-7 — polarity's physicalDamagePercent/elementalDamagePercent and
    // whirlwind's movementSpeed cap, merged into the SAME partial before the
    // one setSourceLayer call below (see channel.js's own header).
    if (this._channelEngine) this._channelEngine.writeStatPartial(actor, partial);
    // SKIL-10 — war_cry's own enhancedDamage contribution, merged into the
    // SAME partial before the one setSourceLayer call below (see buff.js's
    // own header, "Explicitly NOT implemented" item 1, for why this can go
    // stale between real-time expiry and the next resync trigger).
    if (this._buffEngine) this._buffEngine.writeStatPartial(actor, partial, this._ctx.time.step);
    this._actorsSys.setSourceLayer(actor, 'skills', partial);
    this._actorsSys.markDirty(actor);
  }

  /**
   * `01-data-model.md` §3.5 / `05-skills.md` §1.3: synergies read the
   * source's ALLOCATED level, never its effective level.
   * @param {object} actor @param {string} skillId - the TARGET skill
   * @param {string} statKey
   * @returns {number} summed percentage bonus, 0 if none apply
   */
  synergyBonus(actor, skillId, statKey) {
    const def = this._byId.get(skillId);
    if (!def || def.synergies.length === 0) return 0;

    let total = 0;
    for (let i = 0; i < def.synergies.length; i++) {
      const syn = def.synergies[i];
      if (syn.stat !== statKey) continue;
      total += syn.perLevel * allocatedOf(actor, syn.skillId);
    }
    return total;
  }

  // ---------------------------------------------------------------------
  // Costs and cooldowns (SKIL-2) — `02-api-contracts.md` §10 Casting table
  // ---------------------------------------------------------------------

  /**
   * `amount = max(cost.minimum, cost.base + cost.perLevel × (effectiveLevel −
   * 1))`, then `× (1 − manaCostReduction/100)` for MANA ONLY, floored at 1
   * (`05-skills.md` §1.3; `essence_burn`'s `cost.base === 'all'` path is
   * `./cost.js#computeCost`'s own documented exception — see that file's
   * header). An unknown `skillId` reports `{resource:null, amount:0}` rather
   * than throwing — same "fail closed, never throw on a bad id" convention
   * `definition()` above already uses.
   * @param {object} actor
   * @param {string} skillId
   * @returns {{resource:string|null, amount:number}} a SHARED SCRATCH object
   *   — copy before the next call to `costOf`.
   */
  costOf(actor, skillId) {
    const def = this._byId.get(skillId);
    const out = this._scratchCost;
    if (!def) { out.resource = null; out.amount = 0; return out; }

    const level = this.effectiveLevel(actor, skillId);
    return computeCost(def, level, actor, out);
  }

  /**
   * Seconds remaining before `skillId` is usable again. Reads
   * `actor.cooldowns` through `./cost.js#cooldownRemainingSteps`'s
   * generation-stamped lookup — a stale entry from a recycled pool slot's
   * previous occupant reads as "no cooldown" without ever calling
   * `Map#clear()`/`Map#delete()` (see that file's header). An unknown
   * `skillId` reports `0` (usable), matching "never claim a nonexistent
   * skill is on cooldown".
   * @param {object} actor
   * @param {string} skillId
   * @returns {number} seconds, >= 0
   */
  cooldownRemaining(actor, skillId) {
    if (!this._byId.has(skillId)) return 0;
    const steps = cooldownRemainingSteps(actor, skillId, this._ctx.time.step);
    return steps / 60;
  }

  /**
   * `02-api-contracts.md:886` / `09-ui.md:3139`: `describe(actor, skillId,
   * level, out) => SkillDescription` — the tooltip's numbers at any level,
   * "so skill mathematics never lives in two subsystems." `level` is
   * caller-given, not re-derived from `actor`'s own allocation, so `ui` can
   * show level N versus N+1 for a skill the actor may not have allocated
   * yet — SKIL-12's own reason to exist, and UI-9's blocker. A thin wrapper
   * — the real engine, including the two documented open gaps (`range`
   * always 0; a `weaponDamage` skill's `damageMin`/`damageMax` stay 0, its
   * coefficient reported as a `lines` percent entry instead), is
   * `./synergy.js#buildSkillDescription` — see that function's own doc
   * comment. An unknown `skillId` fails closed via `resetSkillDescription`
   * (same convention `costOf`/`definition` already use for a bad id).
   * @param {object} actor
   * @param {string} skillId
   * @param {number} level
   * @param {object} out a `SkillDescription`
   * @returns {object} `out`
   */
  describe(actor, skillId, level, out) {
    const def = this._byId.get(skillId);
    if (!def) return resetSkillDescription(out);
    return buildSkillDescription(def, actor, level, this._synergyBonusFn, this._scratchDescribe, out);
  }

  /** `02-api-contracts.md` §10: `interrupt(actor) => void` — "cancels a
   * cast or a channel." SKIL-7 — see `channel.js`'s own header for the full
   * reasoning (`whirlwind`'s own release path; a best-effort forward onto
   * `actors.cancelAction` for anything else in progress).
   * @param {object} actor */
  interrupt(actor) {
    if (this._channelEngine) this._channelEngine.interrupt(actor, this._skillDeps);
  }

  /** `02-api-contracts.md` §10: `isChannelling(actor) => boolean`. SKIL-7.
   * @param {object} actor @returns {boolean} */
  isChannelling(actor) {
    return this._channelEngine ? this._channelEngine.isChannelling(actor) : false;
  }

  /** `02-api-contracts.md` §10: `polarityStance(actor) =>
   * 'blade'|'storm'|null`. SKIL-7 — `null` for an actor with no points in
   * `polarity`.
   * @param {object} actor @returns {string|null} */
  polarityStance(actor) {
    return this._channelEngine ? this._channelEngine.polarityStance(actor) : null;
  }

  // ---------------------------------------------------------------------
  // Casting (SKIL-3) — `02-api-contracts.md` §10 Casting table
  // ---------------------------------------------------------------------

  /**
   * `05-skills.md` §1.4's four universal rules plus the per-`target`-mode
   * refusal reasons its own table names (`none`: none beyond the universal
   * checks; `self`: `cooldown`/`resource`; `point`: `no-path` — only when
   * `def.range` is declared, since a point-mode skill with no declared
   * range (`cleaving_strike`'s own case: "cast from the actor, not the
   * cursor") never needs to path at all — /`resource`; `actor`: `resource`
   * only — `no-target` needs a `targetId`, which this method's own
   * contract signature does not carry, so that refusal is `cast()`'s to
   * make, not `canCast()`'s; `direction`: `resource`). Generic across all
   * five modes so a future skill's cast handler gets the right refusal
   * reason for free — today only `cleaving_strike` (`point`, no `def.range`)
   * is exercised through a real `cast()` call.
   *
   * Rule 1 ("a refused cast never moves the character") holds structurally:
   * this method never calls `actors.face`/`moveTo`/`teleport` on any path.
   * @param {object} actor
   * @param {string} skillId
   * @param {number} targetX
   * @param {number} targetZ
   * @returns {{ok:boolean, reason:string|null}} a SHARED SCRATCH object —
   *   copy before the next call.
   */
  canCast(actor, skillId, targetX, targetZ) {
    const def = this._byId.get(skillId);
    const out = this._scratchCanCast;
    if (!def) { out.ok = false; out.reason = 'unknown'; return out; }

    if (this.effectiveLevel(actor, skillId) <= 0) { out.ok = false; out.reason = 'unallocated'; return out; }
    if (!this._actorsSys) { out.ok = false; out.reason = 'no-actors'; return out; } // actors not wired into this ctx — see init()'s ctx.peek note
    // `actors.canAct()` is FALSE only for dead/despawning/spawning/hitstun/
    // knockback/frozen/stunned (`02-api-contracts.md` §7's own row text,
    // `src/actors/action.js#canAct` verbatim) — NOT for `windup`/`active`/
    // `recover`, so an actor already mid-swing still reads `canAct() ===
    // true`. `actor.actionId !== null` is the correct "already busy with an
    // action" gate (an Actor record field, read-only here — never written).
    if (actor.actionId !== null || !this._actorsSys.canAct(actor)) { out.ok = false; out.reason = 'busy'; return out; }

    const step = this._ctx.time.step;
    if (cooldownRemainingSteps(actor, skillId, step) > 0) { out.ok = false; out.reason = 'cooldown'; return out; }

    // `point` mode's own `no-path` refusal — only meaningful for a skill
    // that DECLARES a max range (`05` §1.4's table); `cleaving_strike` does
    // not (see this method's own doc comment), so this branch is never live
    // for it.
    if (def.target === 'point' && typeof def.range === 'number') {
      const dx = targetX - actor.x;
      const dz = targetZ - actor.z;
      if (Math.sqrt(dx * dx + dz * dz) > def.range) { out.ok = false; out.reason = 'no-path'; return out; }
    }

    const cost = this.costOf(actor, skillId);
    if (cost.resource && !this._actorsSys.canAfford(actor, cost.resource, cost.amount)) {
      out.ok = false; out.reason = 'resource'; return out;
    }

    out.ok = true; out.reason = null;
    return out;
  }

  /**
   * `cast(actor, skillId, targetX, targetZ, targetId) => boolean`. Runs
   * `canCast()` first (rule 1) and dispatches to `_castHandlers`, indexed
   * by the SAME O-59 integer index the registry already resolves — never a
   * `skillId` string switch. A `skillId` with no wired handler reports
   * `false`, same as a refused `canCast()` — `05-skills.md`'s D-37 scope
   * limits this to `cleaving_strike`/`ember_bolt`/`rune_strike`; the other
   * 27 are a later ticket's, not stubbed (O-27).
   *
   * SKIL-4 — `target: 'actor'` no-target refusal (`rune_strike`'s own
   * mode): `canCast()`'s own doc comment already names this as `cast()`'s
   * job, not `canCast()`'s, because `canCast()`'s contracted signature
   * (`02-api-contracts.md` §10) carries no `targetId` param to check
   * against. Implemented HERE, generically over `def.target === 'actor'`,
   * rather than duplicated inside every such skill's own handler — the
   * check is the same for any present/future `target: 'actor'` skill
   * (`bloodletting` included, once a later ticket wires it): `targetId`
   * must resolve to a live (`!dead`) actor. Weapon-range gating and
   * click-to-move's "walks into range" (`05` §1.4's own table) are NOT
   * implemented here — that is movement/`ai` territory this ticket's file
   * list does not reach; flagged in this ticket's report as a scoped gap,
   * not a silent omission.
   * @param {object} actor
   * @param {string} skillId
   * @param {number} targetX
   * @param {number} targetZ
   * @param {number} [targetId] required for a `target: 'actor'` skill
   *   (`rune_strike`); unused by `point`-mode skills (`cleaving_strike`,
   *   `ember_bolt`) — carried through to `handler.cast()` as a TRAILING
   *   argument (after `deps`) so `cleaving_strike`'s/`ember_bolt`'s own
   *   5-arg `cast(actor, def, level, targetX, targetZ, deps)` signatures
   *   are unaffected (JS silently drops an unread trailing argument) while
   *   `rune_strike`'s 7-arg one can still read it.
   * @returns {boolean}
   */
  cast(actor, skillId, targetX, targetZ, targetId) {
    const idx = this._indexById.get(skillId);
    const handler = idx === undefined ? null : this._castHandlers[idx];
    if (!handler) return false;

    const check = this.canCast(actor, skillId, targetX, targetZ);
    if (!check.ok) return false;

    const def = this._all[idx];
    if (def.target === 'actor') {
      if (!this._actorsSys) return false;
      const target = this._actorsSys.byId(targetId);
      if (!target || target.dead) return false; // "no-target" — see this method's own doc comment
    }

    const level = this.effectiveLevel(actor, skillId);

    // SKIL-9 — `ashen_step` leaves an ash-cloud ground effect at the
    // DEPARTURE point (`05` §5.1). The departure position must be captured
    // BEFORE `handler.cast()` runs — that call is `./mobility.js`'s own
    // (unedited) `castAshenStep`, which teleports `actor.x`/`actor.z` in
    // place on success. Generic over `skillId === 'ashen_step'` only; every
    // other skill's dispatch below is unchanged.
    const isAshenStep = skillId === 'ashen_step';
    const departureX = isAshenStep ? actor.x : 0;
    const departureZ = isAshenStep ? actor.z : 0;

    const result = handler.cast(actor, def, level, targetX, targetZ, this._skillDeps, targetId);
    if (result && isAshenStep) this._spawnAshenStepCloud(actor, level, departureX, departureZ);
    return result;
  }

  /** SKIL-9 — see `cast()`'s own comment above. A no-op if the ground-
   * effect pool was never wired into this `ctx` (a bare test stub).
   * @param {object} actor @param {number} level @param {number} x @param {number} z */
  _spawnAshenStepCloud(actor, level, x, z) {
    if (!this._groundEffectPool) return;
    const spec = buildAshenStepCloudSpec(actor, level, x, z);
    spawnGroundEffect(this._groundEffectPool, spec, this._skillDeps);
  }

  // ---------------------------------------------------------------------
  // Projectiles (SKIL-4) — 02-api-contracts.md §10
  // ---------------------------------------------------------------------

  /** `02-api-contracts.md` §10: `spawnProjectile(spec) => int id | 0`. A
   * thin forward onto `./projectile.js`'s own pool — see that file's header
   * for the pool-cap reconciliation (D-47) and why a dry pool refuses
   * rather than growing or evicting.
   * @param {object} spec see `ProjectilePool#spawnProjectile`'s own doc comment.
   * @returns {number}
   */
  spawnProjectile(spec) {
    return this._projectilePool.spawnProjectile(spec);
  }

  /** `02-api-contracts.md` §10: `killProjectile(id) => void`. Safe no-op on
   * a stale/already-dead id.
   * @param {number} id */
  killProjectile(id) {
    this._projectilePool.killProjectile(id);
  }

  /** `02-api-contracts.md` §10: `projectileCount` property -> `int`. */
  get projectileCount() {
    return this._projectilePool.count;
  }

  // ---------------------------------------------------------------------
  // Ground effects (SKIL-9) — 02-api-contracts.md §10
  // ---------------------------------------------------------------------

  /** `02-api-contracts.md` §10: `addGroundEffect(spec) => int id | 0` —
   * "registers a nav hazard" (only when `spec.hazard` is true — `ashen_step`
   * deliberately spawns one with `hazard:false`, see `./ground.js`'s own
   * header). A thin forward onto `./ground.js`'s own pool + free functions
   * — see that file's header for the overflow policy, the hazard-sample
   * discipline and the `GroundEffectSpawn` shape.
   * @param {import('./ground.js').GroundEffectSpawn} spec
   * @returns {number}
   */
  addGroundEffect(spec) {
    return spawnGroundEffect(this._groundEffectPool, spec, this._skillDeps);
  }

  /** `02-api-contracts.md` §10: `removeGroundEffect(id) => void`. Safe
   * no-op on a stale/already-removed id.
   * @param {number} id */
  removeGroundEffect(id) {
    despawnGroundEffect(this._groundEffectPool, id, this._skillDeps);
  }

  /** Not a `02-api-contracts.md` row — exposed for tests/debugging, same
   * "implicit count" precedent `projectileCount` establishes for its own
   * pool, without adding a second contract row nobody asked for. */
  get groundEffectCount() {
    return this._groundEffectPool.count;
  }

  // ---------------------------------------------------------------------
  // Imbue and cascade (SKIL-13) — 02-api-contracts.md §10
  // ---------------------------------------------------------------------

  /** `02-api-contracts.md` §10: `imbueRemaining(actor) => int` — `blade_seal`
   * hits left. @param {object} actor @returns {number} */
  imbueRemaining(actor) {
    return this._imbueEngine.imbueRemaining(actor);
  }

  /** `02-api-contracts.md` §10: `imbueElement(actor) =>
   * 'fire'|'cold'|'lightning'|null`. @param {object} actor @returns {string|null} */
  imbueElement(actor) {
    return this._imbueEngine.imbueElement(actor);
  }

  /** `02-api-contracts.md` §10: `cascadeCharges(actor) => int` — 0..2, the
   * empowered-hit counter. @param {object} actor @returns {number} */
  cascadeCharges(actor) {
    return this._imbueEngine.cascadeCharges(actor);
  }

  // ---------------------------------------------------------------------
  // Buffs and absorbs (SKIL-10) — 02-api-contracts.md §10. SKIL-13 shipped a
  // minimal stand-in backed only by `blade_seal`'s own imbue state (D-37
  // scope at the time); this ticket GENERALISES all five rows — `./buff.js`
  // is the real engine, proven against `war_cry`/`last_stand`/
  // `smouldering_ward` (that file's own D-37 scope) and still delegating to
  // `_imbueEngine` for `blade_seal`, never reimplementing it. `absorbRemaining`
  // is new. See `./buff.js`'s own header for the full reasoning.
  // ---------------------------------------------------------------------

  /** `02-api-contracts.md` §10: `applyBuff(actor, buffId, level, seconds) =>
   * void`. Thin forward onto `./buff.js#createBuffEngine().applyBuff` — see
   * that file's own header for what each `buffId` does and why `blade_seal`
   * alone still throws (a bare `(buffId, level, seconds)` call cannot
   * correctly re-derive its hits/element/flat-damage state). SKIL-11 —
   * `'unity'` is special-cased HERE, not inside `_buffEngine` (`./buff.js`
   * is not this ticket's file, and its own `applyBuff` throws for any
   * `buffId` it has no data curve for, `'unity'` included) — same
   * "special-case at the index.js layer, delegate to the owning engine"
   * shape `_buffEngine.hasBuff` itself already uses for `'blade_seal'` one
   * level down.
   * @param {object} actor @param {string} buffId @param {number} level @param {number} seconds */
  applyBuff(actor, buffId, level, seconds) {
    if (buffId === 'unity') { this._summonEngine.applyUnity(actor, level, seconds, this._skillDeps); return; }
    this._buffEngine.applyBuff(actor, buffId, level, seconds, this._skillDeps);
  }

  /** `02-api-contracts.md` §10: `removeBuff(actor, buffId) => void`.
   * SKIL-11 — `'unity'` special-cased, see `applyBuff`'s own comment.
   * @param {object} actor @param {string} buffId */
  removeBuff(actor, buffId) {
    if (buffId === 'unity') { this._summonEngine.removeUnity(actor); return; }
    this._buffEngine.removeBuff(actor, buffId, this._skillDeps);
  }

  /** `02-api-contracts.md` §10: `hasBuff(actor, buffId) => boolean`.
   * SKIL-11 — `'unity'` special-cased, see `applyBuff`'s own comment.
   * @param {object} actor @param {string} buffId @returns {boolean} */
  hasBuff(actor, buffId) {
    if (buffId === 'unity') return this._summonEngine.hasUnity(actor, this._ctx.time.step);
    return this._buffEngine.hasBuff(actor, buffId, this._skillDeps);
  }

  /** `02-api-contracts.md` §10: `buffRemaining(actor, buffId) => number`
   * seconds; `hasBuff` is only a boolean. SKIL-11 — `'unity'` special-cased,
   * see `applyBuff`'s own comment.
   * @param {object} actor @param {string} buffId @returns {number} */
  buffRemaining(actor, buffId) {
    if (buffId === 'unity') return this._summonEngine.unityRemaining(actor, this._ctx.time.step);
    return this._buffEngine.buffRemaining(actor, buffId, this._skillDeps);
  }

  /** `02-api-contracts.md` §10: `buffList(actor, out:Array) => int` —
   * entries `{buffId, level, remaining, stacks}`, into a caller-owned array.
   * Mutates up to `out.length` EXISTING slot objects in place (never
   * pushes/grows `out` — `Alloc: no`). SKIL-11 — `unity`'s own entry (if
   * active) is appended AFTER `_buffEngine`'s own (blade_seal/war_cry/
   * absorb pools), writing into the NEXT free slot rather than reordering
   * or re-slicing `out` (a `.slice()` here would allocate).
   * @param {object} actor @param {Array<{buffId:string,level:number,remaining:number,stacks:number}>} out
   * @returns {number} entries written */
  buffList(actor, out) {
    let n = this._buffEngine.buffList(actor, out, this._skillDeps);
    n += this._summonEngine.appendUnityToBuffList(actor, out, n, this._ctx.time.step);
    return n;
  }

  /** `02-api-contracts.md` §10: `summonOf(actor, skillId) => ActorRef |
   * null` — never an `Actor`; the pool recycles. SKIL-11 — thin forward
   * onto `./summon.js`; see that file's own header for the D-37 scope
   * (`echo_blade` only) and how the returned `ActorRef` survives the
   * summon's own slot being recycled.
   * @param {object} actor @param {string} skillId @returns {object|null} */
  summonOf(actor, skillId) {
    return this._summonEngine.summonOf(actor, skillId, this._actorsSys);
  }

  /** `02-api-contracts.md` §10: `absorbRemaining(actor) => number` — the
   * `smouldering_ward` / `last_stand` pool total `ui` overlays on the life
   * globe.
   * @param {object} actor @returns {number} */
  absorbRemaining(actor) {
    return this._buffEngine.absorbRemaining(actor, this._skillDeps);
  }

  // ---------------------------------------------------------------------
  // internal
  // ---------------------------------------------------------------------

  /** @param {object} actor @param {object} def @returns {boolean} */
  _prereqMet(actor, def) {
    for (let i = 0; i < def.requires.length; i++) {
      const req = def.requires[i];
      if (allocatedOf(actor, req.skillId) < req.level) return false;
    }
    return true;
  }

  /** @param {object} actor @param {object} def @returns {boolean} */
  _tierAndPrereqMet(actor, def) {
    return (actor.level || 0) >= def.tier && this._prereqMet(actor, def);
  }

  /** `ARCHITECTURE.md` rule 5: simulation lives in `fixedUpdate` (60 Hz),
   * never reads `dt`/the wall clock — `h` is the caller's own fixed step.
   * SKIL-4's own addition: advances every live `Projectile` one step (see
   * `./projectile.js#advanceProjectiles`'s own header for the flight/pierce/
   * damage reasoning). A no-op before `init()` has run.
   * @param {number} h
   * @param {object} ctx */
  fixedUpdate(h, ctx) {
    if (!this._projectilePool) return;
    advanceProjectiles(this._projectilePool, h, this._skillDeps);
    // SKIL-7 — whirlwind's own per-actor schedule (damage ticks, R2's rage
    // cadence, the continuous rage drain). See channel.js's own header for
    // why this cannot be driven off actors.beginAction/advanceAction.
    if (this._channelEngine) this._channelEngine.fixedUpdate(this._skillDeps);
    // SKIL-8 — phase_leap's one-step-delayed strike. See mobility.js's own
    // header for why this cannot be driven off anim:hitframe.
    if (this._mobilityEngine) this._mobilityEngine.fixedUpdate(this._skillDeps);
    // SKIL-9 — ground-effect lifetime, the tickSteps-cadenced field
    // application, and ash_wall's per-step projectile absorption. See
    // ground.js#advanceGroundEffects's own header.
    if (this._groundEffectPool) advanceGroundEffects(this._groundEffectPool, h, this._skillDeps);
    // SKIL-11 — echo_blade expiry sweep, then the pending-free-cast drain.
    // AFTER advanceProjectiles (above), so a pool slot freed by THIS step's
    // own lifetime decay is already visible to a chain resolved later in
    // this same step — see summon.js's own header for why the drain never
    // runs from inside the `actor:damage` listener itself.
    if (this._summonEngine) this._summonEngine.fixedUpdate(this._skillDeps);
    void ctx; // unused — this._skillDeps already carries every live subsystem ref fixedUpdate needs
  }

  /** Not a `02-api-contracts.md` row (optional per `ARCHITECTURE.md`'s
   * subsystem interface) — removes the two `ctx.events` listeners SKIL-3
   * registered in `init()`, so a test that builds/tears down several
   * `SkillsSystem` instances against one shared `EventBus` does not
   * accumulate stale subscribers. SKIL-4 additionally releases the
   * `Projectile` pool.
   */
  dispose() {
    if (this._ctx && this._ctx.events) {
      if (this._onHitframe) this._ctx.events.off('anim:hitframe', this._onHitframe);
      // SKIL-6
      if (this._onActorDamageForIncinerate) this._ctx.events.off('actor:damage', this._onActorDamageForIncinerate);
      // SKIL-13
      if (this._onActorDamageForImbue) this._ctx.events.off('actor:damage', this._onActorDamageForImbue);
      if (this._onZoneTeardownForCascade) this._ctx.events.off('zone:teardown', this._onZoneTeardownForCascade);
      // SKIL-10
      if (this._onActorDamageForBuff) this._ctx.events.off('actor:damage', this._onActorDamageForBuff);
      // SKIL-9
      if (this._onZoneTeardownForGround) this._ctx.events.off('zone:teardown', this._onZoneTeardownForGround);
      if (this._onActorDeathForGround) this._ctx.events.off('actor:death', this._onActorDeathForGround);
      // SKIL-11
      if (this._onActorDamageForSummon) this._ctx.events.off('actor:damage', this._onActorDamageForSummon);
      if (this._onActorDeathForSummon) this._ctx.events.off('actor:death', this._onActorDeathForSummon);
      if (this._onActorDespawnForSummon) this._ctx.events.off('actor:despawn', this._onActorDespawnForSummon);
      if (this._onZoneTeardownForSummon) this._ctx.events.off('zone:teardown', this._onZoneTeardownForSummon);
    }
    if (this._projectilePool) this._projectilePool.dispose();
    if (this._groundEffectPool) this._groundEffectPool.dispose();
  }
}
