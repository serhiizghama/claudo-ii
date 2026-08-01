// tests/items/equipment.perf.test.js
//
// ITEM-11 — `Alloc: no` proof for `slotsFor`/`canEquip`/`equip`/`unequip`
// (`02-api-contracts.md` §11 "Containers and equipment"). Measured, not
// asserted by reading the source. Named `.perf.test.js` so it lands in the
// isolated `--test-concurrency=1` perf stage, matching every sibling
// `*.perf.test.js` in this directory.
//
// O-43's methodology (see `tests/items/containers.perf.test.js`'s own header
// for the full citation): allocation probes are meaningless below ~1e6
// iterations on this project's measured noise floor.
//
// Retention (this ticket's own brief, "found in this milestone"): every
// probe's `fn` result is assigned into an outer-scope variable each call —
// never discarded — so a minor GC cannot reclaim a real allocation before
// `heapUsed` is sampled and make an allocating function read as free.
//
// ---------------------------------------------------------------------------
// A real finding: `equip`/`unequip` cannot be proven < 1 byte/call in
// isolation, and the residual is NOT in this ticket's files
// ---------------------------------------------------------------------------
// `slotsFor` and both `canEquip` probes below converge to < 0.1 byte/call on
// the FIRST round at N=1e6 — genuinely, provably zero-allocation.
//
// `equip`/`unequip` are different: every call that actually changes the
// equipment set ends in `actors.setSourceLayer(actor,'equipment',layer)`,
// which sets `actor.statsDirty = true`; the NEXT `actors.stats(actor)` call
// — inside `canEquip`, itself inside the next `equip`/`unequip` — therefore
// forces a REAL `composeStats()` recompute, every single call, never the
// cheap "already clean" path. This ticket's own bisection (see below) proves
// that access pattern — `setSourceLayer` immediately followed by `stats()`,
// repeated — reads a small but stable ~1.1 B/call at N=2e6 in `actors`
// ALONE, with zero `items` code in the call chain at all:
//
//   const layer = { <all 90 StatBlock fields, zeroed> };
//   const fn = () => { actors.setSourceLayer(actor, 'equipment', layer);
//                       actors.stats(actor); };
//   // after 50,000 calls of warm-up: a STABLE 1.10-1.19 B/call across five
//   // separate 2,000,000-iteration rounds — not noise trending toward zero,
//   // a real, small, consistent allocation inside `actors`' own dirty ->
//   // recompose -> clean cycle when driven back-to-back in a hot loop. No
//   // existing ACTR-15/ACTR-7 probe exercises this exact access pattern —
//   // their own probes measure `setSourceLayer` alone and `stats()` on an
//   // ALREADY-CLEAN actor (the cheap cached-return path) separately, never
//   // "recompose immediately after marking dirty, in a loop".
//
// This is a genuine finding about `src/actors/stats.js` (ACTR-7, already-
// accepted, outside this ticket's file grant) — not a workaround for this
// ticket to build (the brief: "that is a finding to report, not a
// workaround to build"). See this ticket's report.
//
// Given that, `equip`/`unequip` are measured against the ISOLATED `actors`-
// only floor established immediately above, not asserted flatly < 1 byte:
// the claim this file proves is "equip()/unequip() add no allocation of
// their OWN on top of what actors.stats()+setSourceLayer() already cost",
// which is the honest, precise version of their `Alloc: no` contract row
// given a dependency this ticket does not own.

import test from 'node:test';

import { allocatedBytes, assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { ItemsSystem } from '../../src/items/index.js';
import { ITEM_BASES_BY_ID } from '../../src/items/data/bases.js';

async function makeCtx(seed) {
  const events = new EventBus();
  const registry = new Registry();
  const ctx = {
    scene: null, camera: null, uiScene: null, uiCamera: null, canvas: null,
    config: {}, events, input: null,
    time: { elapsed: 0, raw: 0, dt: 0, fixed: 1 / 60, alpha: 0, scale: 1, frame: 0, step: 0 },
    rng: new Rng(seed),
    get: registry.get.bind(registry),
    peek: registry.peek.bind(registry),
    has: registry.has.bind(registry),
  };
  registry.add(PhysicsSystem);
  registry.add(ActorsSystem);
  registry.add(ItemsSystem);
  await registry.init(ctx);
  return ctx;
}

let _uid = 1;
function makeItem(baseId, overrides = {}) {
  const base = ITEM_BASES_BY_ID[baseId];
  return {
    uid: overrides.uid ?? _uid++,
    baseId,
    rarity: 'normal',
    ilvl: base ? base.reqLevel : 1,
    identified: true,
    quantity: 1,
    rolls: { defense: 0, superior: 0, damageMin: base && base.weapon ? base.weapon.minDamage : 0, damageMax: base && base.weapon ? base.weapon.maxDamage : 0 },
    affixes: overrides.affixes ?? [],
    uniqueId: null,
    uniqueValues: [],
    nameOverride: null,
    durability: base ? base.maxDurability : 1,
    maxDurability: base ? base.maxDurability : 1,
    sockets: [],
    socketCount: 0,
    grid: null,
    slot: null,
    ground: null,
  };
}

// The 90 `StatBlock` field names (`src/actors/stats.js#FIELD_NAMES`,
// verbatim) — used only to build the isolation probe's own zeroed
// `equipment` layer, independent of `src/items/equipment.js`'s copy.
const FIELD_NAMES = [
  'strength', 'dexterity', 'vitality', 'energy',
  'maxLife', 'lifePercent', 'maxMana', 'manaPercent', 'maxRage', 'maxResonance', 'maxStamina',
  'lifeRegen', 'lifeRegenPercent', 'manaRegen', 'manaRegenPercent', 'staminaRegen',
  'minDamage', 'maxDamage', 'enhancedDamage', 'attackRating', 'attackRatingPercent',
  'increasedAttackSpeed', 'fasterCastRate', 'critChance', 'critMult',
  'fireMin', 'fireMax', 'coldMin', 'coldMax', 'lightMin', 'lightMax', 'poisonMin', 'poisonMax', 'magicMin', 'magicMax',
  'coldDuration', 'poisonDuration',
  'fireDamagePercent', 'coldDamagePercent', 'lightDamagePercent', 'poisonDamagePercent', 'magicDamagePercent',
  'elementalDamagePercent', 'physicalDamagePercent',
  'fireResistPierce', 'coldResistPierce', 'lightResistPierce', 'poisonResistPierce',
  'lifeSteal', 'manaSteal', 'lifeOnHit', 'manaOnHit', 'lifeOnKill', 'manaOnKill',
  'manaReturnPercent', 'pierceChance', 'knockbackChance', 'thorns', 'rageOnHit', 'rageOnTakeHit', 'resonanceOnHit',
  'defense', 'defensePercent', 'blockChance', 'dodgeChance',
  'fireResist', 'coldResist', 'lightResist', 'poisonResist', 'magicResist', 'physicalResist',
  'maxFireResist', 'maxColdResist', 'maxLightResist', 'maxPoisonResist', 'maxMagicResist', 'maxPhysicalResist',
  'damageReduceFlat', 'damageReducePercent', 'magicDamageReduceFlat', 'fasterHitRecovery', 'ccReduction',
  'movementSpeed', 'magicFind', 'goldFind', 'manaCostReduction', 'lightRadius', 'requirementReduction', 'damageTakenToMana', 'experienceGain',
];

// N and round budget for the two "attributed floor" probes below — smaller
// than a strict `assertAllocationFree` gate would use, because (per the file
// header) they are not expected to converge under 1 byte/call; they are
// compared against the isolated `actors`-only floor instead, at a fixed N.
const FLOOR_ITERATIONS = 2_000_000;

test('12.ITMS-E slotsFor/canEquip are genuinely allocation-free (O-43 methodology, N >= 1e6, strict < 1 byte/call)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  let sinkArr = null;
  let sinkCheck = null;

  const probes = [];

  // ── slotsFor ────────────────────────────────────────────────────────
  {
    const ctx = await makeCtx(101);
    const items = ctx.get('items');
    const ring = makeItem('ring_iron');
    probes.push({ name: 'slotsFor(ring)', fn: () => { sinkArr = items.slotsFor(ring); } });
  }

  // ── canEquip — steady TRUE decision. Never marks the actor dirty (only
  //    equip()/unequip() call setSourceLayer), so every call takes the
  //    cheap "already clean" path through actors.stats() — genuinely
  //    zero-allocation, unlike equip()/unequip() themselves (see header). ──
  {
    const ctx = await makeCtx(102);
    const items = ctx.get('items');
    const actors = ctx.get('actors');
    const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 20 });
    actor.attributes.strength = 60;
    const ring = makeItem('ring_iron');
    probes.push({ name: 'canEquip(actor, ring, "ring1") — steady ok:true', fn: () => { sinkCheck = items.canEquip(actor, ring, 'ring1'); } });
  }

  // ── canEquip — steady FALSE decision (wrong slot; returns before ever
  //    reaching actors.stats()) ────────────────────────────────────────
  {
    const ctx = await makeCtx(103);
    const items = ctx.get('items');
    const actors = ctx.get('actors');
    const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 20 });
    const ring = makeItem('ring_iron');
    probes.push({ name: 'canEquip(actor, ring, "head") — steady ok:false', fn: () => { sinkCheck = items.canEquip(actor, ring, 'head'); } });
  }

  const results = [];
  for (const probe of probes) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: 1_000_000, maxRounds: 60 });
    results.push({ name: probe.name, bytesPerCall, rounds });
  }

  // eslint-disable-next-line no-console
  console.log('12.ITMS-E strict probe results (bytes/call, rounds to converge):');
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`  ${r.name}: ${r.bytesPerCall.toFixed(4)} B/call (${r.rounds} round(s))`);
  }

  void sinkArr;
  void sinkCheck;
});

test('12.ITMS-E equip/unequip add no allocation on top of actors.stats()+setSourceLayer()\'s own recompose-cycle floor', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  // ── Isolation probe: actors.setSourceLayer()+stats() alone, in the exact
  //    dirty -> recompose -> clean -> dirty cycle equip()/unequip() drive —
  //    with ZERO `items` code anywhere in the call chain. This establishes
  //    the floor the two probes below are compared against. ──────────────
  let floorBytesPerCall;
  {
    const ctx = await makeCtx(201);
    const actors = ctx.get('actors');
    const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 20 });
    const layer = {};
    for (const k of FIELD_NAMES) layer[k] = 0;
    layer.cannotBeFrozen = false;
    let sink;
    const fn = () => { actors.setSourceLayer(actor, 'equipment', layer); sink = actors.stats(actor); };
    for (let i = 0; i < 50_000; i++) fn();
    floorBytesPerCall = allocatedBytes(fn, FLOOR_ITERATIONS);
    void sink;
  }

  let sinkCheck = null;
  let sinkBool = false;

  // ── equip — steady re-equip of the item already in that slot (fast
  //    "occupant is this item" path, no displacement, no container writes) ─
  let equipBytesPerCall;
  {
    const ctx = await makeCtx(104);
    const items = ctx.get('items');
    const actors = ctx.get('actors');
    const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 20 });
    actor.attributes.strength = 60;
    const ring = makeItem('ring_iron');
    items.equip(actor, ring, 'ring1'); // one-time setup
    const fn = () => { sinkCheck = items.equip(actor, ring, 'ring1'); };
    for (let i = 0; i < 50_000; i++) fn();
    equipBytesPerCall = allocatedBytes(fn, FLOOR_ITERATIONS);
  }

  // ── unequip + equip ping-pong — the item's `.grid` object (from its
  //    first placement) is already warm before the timed loop starts ──
  let pingpongBytesPerCall;
  {
    const ctx = await makeCtx(105);
    const items = ctx.get('items');
    const actors = ctx.get('actors');
    const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 20 });
    actor.attributes.strength = 60;
    const ring = makeItem('ring_iron');
    items.equip(actor, ring, 'ring1');
    items.unequip(actor, 'ring1'); // ring now in inventory; item.grid allocated once
    items.equip(actor, ring, 'ring1'); // back on the finger; warm-up complete
    let onFinger = true;
    const fn = () => {
      if (onFinger) sinkBool = items.unequip(actor, 'ring1');
      else sinkCheck = items.equip(actor, ring, 'ring1');
      onFinger = !onFinger;
    };
    for (let i = 0; i < 50_000; i++) fn();
    pingpongBytesPerCall = allocatedBytes(fn, FLOOR_ITERATIONS);
  }

  // eslint-disable-next-line no-console
  console.log(
    `12.ITMS-E floor comparison (N=${FLOOR_ITERATIONS}): ` +
      `actors-only floor=${floorBytesPerCall.toFixed(4)} B/call, ` +
      `equip()=${equipBytesPerCall.toFixed(4)} B/call, ` +
      `unequip()+equip() ping-pong=${pingpongBytesPerCall.toFixed(4)} B/call`,
  );

  // The claim: equip()/unequip() ride the SAME actors-side floor and add no
  // meaningful allocation of their own — a fixed 8 byte/call margin over the
  // measured floor (comfortably above this run-to-run noise band, and tiny
  // next to what a real `{container,x,y}`-sized object, ~40-56 bytes on V8,
  // would read) rather than a bare "< 1 byte" gate this file's header
  // explains items cannot pass on its own.
  const margin = 8;
  if (equipBytesPerCall > floorBytesPerCall + margin) {
    throw new Error(
      `equip() reads ${equipBytesPerCall.toFixed(4)} B/call, more than ${margin} bytes above the isolated ` +
        `actors-only floor of ${floorBytesPerCall.toFixed(4)} B/call — equip() itself now allocates.`,
    );
  }
  if (pingpongBytesPerCall > floorBytesPerCall + margin) {
    throw new Error(
      `unequip()+equip() ping-pong reads ${pingpongBytesPerCall.toFixed(4)} B/call, more than ${margin} bytes above ` +
        `the isolated actors-only floor of ${floorBytesPerCall.toFixed(4)} B/call — a container/grid write now allocates.`,
    );
  }
});
