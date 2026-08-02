// tests/skills/passive.test.js
//
// SKIL-5 acceptance tests for `src/skills/passive.js` and the
// `sources.skills` wiring added to `src/skills/index.js#allocate`/`respec`
// (`05-skills.md` §14 row 5, `05.S08`).
//
// Built against a light, real Registry (`Physics` + `Actors` + `Combat` +
// `Skills`, real `init()` for each) — the same pattern
// `tests/items/equipment.perf.test.js` already established for a subsystem
// whose contract only needs `actors`' real composition path, not a full
// `boot()` (`src/main.js`) with render/world/ui attached. `allocate()`
// deliberately does NOT validate class/tier/prereq (`02-api-contracts.md:
// 918`), so a single stub actor can carry all eight passives at once for
// the cross-class checks below without needing eight separate spawns.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { CombatSystem } from '../../src/combat/packet.js';
import { SkillsSystem } from '../../src/skills/index.js';

async function makeCtx(seed = 1) {
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
  registry.add(CombatSystem);
  registry.add(SkillsSystem);
  await registry.init(ctx);
  return ctx;
}

const EPS = 1e-4;
function approx(got, expected, msg) {
  assert.ok(Math.abs(got - expected) < EPS, `${msg}: got ${got}, expected ${expected}`);
}

// ---------------------------------------------------------------------------
// A LITERAL, independently-transcribed subset of 01-data-model.md §3's
// StatBlock table — the caps every field our six stat-granting passives
// touch. Deliberately NOT read off src/actors/stats.js's own CAPS/FIELD_NAMES
// (this ticket's own trap #1: "a test that reads the live object's keys
// will pass even when both sides are wrong together"). `null` means the
// spec's own Cap column is "—" (uncapped); `dynamic` means the field's cap
// is its own companion stat (physicalResist -> maxPhysicalResist, default
// 75, `01` §3.4), not a static [lo,hi].
// ---------------------------------------------------------------------------
const STATBLOCK_CAPS = Object.freeze({
  lifeSteal: [0, 100],
  blockChance: [0, 75],
  thorns: null, // "—", uncapped
  dodgeChance: [0, 50],
  defensePercent: [-100, 1000],
  physicalResist: 'dynamic', // capped by maxPhysicalResist, default 75 (01 §3.4)
  fireDamagePercent: [-100, 1000],
  maxMana: [0, 20000],
  manaRegen: null, // "—", uncapped
  damageTakenToMana: [0, 40],
  maxResonance: [0, 8],
  manaReturnPercent: [0, 100],
  resonanceOnHit: [0, 4],
});

function spawnActor(actors, classId, level = 30) {
  return actors.spawn({ kind: 'player', archetypeId: classId, level });
}

// ===========================================================================
// D-46 — eight type:'passive' skills, not nine
// ===========================================================================

test('D-46: exactly eight skills carry type:"passive" in the registry', async () => {
  const ctx = await makeCtx(1);
  const skills = ctx.get('skills');
  const passiveIds = skills.all.filter((d) => d.type === 'passive').map((d) => d.id).sort();
  assert.equal(passiveIds.length, 8, `expected 8 passive-type skills, got ${passiveIds.length}: ${passiveIds.join(', ')}`);
  assert.deepEqual(
    passiveIds,
    ['bloodthirst', 'cascade', 'incinerate', 'iron_skin', 'last_stand', 'mana_weave', 'resonance_circuit', 'shield_stance'],
  );
});

// ===========================================================================
// S8 — every passiveStats key exists in StatBlock and respects its cap,
// checked at slvl 1 and slvl 20, over all eight passives.
// ===========================================================================

test('S8: every passiveStats key of all eight passives exists in the literal StatBlock cap table and respects its cap at slvl 1 and slvl 20', async () => {
  const ctx = await makeCtx(2);
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const actor = spawnActor(actors, 'ravager', 30);

  const passiveDefs = skills.all.filter((d) => d.type === 'passive');
  assert.equal(passiveDefs.length, 8);

  const rows = [];
  for (const def of passiveDefs) {
    // actor starts (or was just respec()'d) at 0 for every skill — allocate
    // to 1, read; allocate 19 more (to 20), read again.
    for (let i = skills.instanceOf(actor, def.id).allocated; i < 1; i++) skills.allocate(actor, def.id);
    const statsAt1 = { ...actors.stats(actor) };
    for (let i = skills.instanceOf(actor, def.id).allocated; i < 20; i++) skills.allocate(actor, def.id);
    const statsAt20 = { ...actors.stats(actor) };

    if (!def.passiveStats) {
      rows.push({ id: def.id, note: 'no passiveStats (trigger-only, D-46)' });
      continue;
    }
    for (const key of Object.keys(def.passiveStats)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(STATBLOCK_CAPS, key),
        `S8: passive '${def.id}' names stat '${key}', which is not in this test's literal StatBlock transcription`,
      );
      const cap = STATBLOCK_CAPS[key];
      const v1 = statsAt1[key];
      const v20 = statsAt20[key];
      rows.push({ id: def.id, key, v1, v20, cap });

      if (cap === null) continue; // uncapped by spec
      if (cap === 'dynamic') {
        // physicalResist — dynamic cap is its own maxPhysicalResist
        // companion (default 75, 01 §3.4). This skill's own contribution
        // (cap 25 internally, well under 75 alone) can never approach it.
        assert.ok(v20 <= statsAt20.maxPhysicalResist, `S8: physicalResist ${v20} exceeds its own maxPhysicalResist ${statsAt20.maxPhysicalResist}`);
        continue;
      }
      const [lo, hi] = cap;
      assert.ok(v1 >= lo && v1 <= hi, `S8: ${def.id}.${key} at slvl1 = ${v1}, outside literal StatBlock cap [${lo},${hi}]`);
      assert.ok(v20 >= lo && v20 <= hi, `S8: ${def.id}.${key} at slvl20 = ${v20}, outside literal StatBlock cap [${lo},${hi}]`);
    }
    skills.respec(actor); // clear before the next passive so contributions do not stack across rows
  }

  // eslint-disable-next-line no-console
  console.log('S8 table (passive.key: cap, value@1, value@20):');
  for (const r of rows) {
    // eslint-disable-next-line no-console
    if (r.note) console.log(`  ${r.id}: ${r.note}`);
    // eslint-disable-next-line no-console
    else console.log(`  ${r.id}.${r.key}: cap=${JSON.stringify(r.cap)} v@1=${r.v1} v@20=${r.v20}`);
  }
});

// ===========================================================================
// last_stand / cascade contribute nothing to sources.skills (D-46's "six
// pure passives" reading, `./passive.js`'s own header)
// ===========================================================================

test('last_stand and cascade (passive triggers) contribute no StatBlock stat at any level', async () => {
  const ctx = await makeCtx(3);
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const actor = spawnActor(actors, 'ravager', 30);

  const before = { ...actors.stats(actor) };
  for (let i = 0; i < 20; i++) skills.allocate(actor, 'last_stand');
  for (let i = 0; i < 20; i++) skills.allocate(actor, 'cascade');
  const after = { ...actors.stats(actor) };

  for (const key of Object.keys(before)) {
    if (key === 'skillBonuses') continue;
    assert.equal(after[key], before[key], `stat '${key}' changed after maxing last_stand/cascade, but neither has a passiveStats table`);
  }
});

// ===========================================================================
// shield_stance dodgeChance — D-05-3, 3 -> 12.5
// ===========================================================================

test('shield_stance: dodgeChance is 3 at slvl 1 and 12.5 at slvl 20 (D-05-3)', async () => {
  const ctx = await makeCtx(4);
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const actor = spawnActor(actors, 'ravager', 30);

  skills.allocate(actor, 'shield_stance');
  approx(actors.stats(actor).dodgeChance, 3, 'dodgeChance at slvl 1');

  for (let i = 0; i < 19; i++) skills.allocate(actor, 'shield_stance');
  approx(actors.stats(actor).dodgeChance, 12.5, 'dodgeChance at slvl 20');

  // blockChance/thorns, same passive, same table (05 §3.2's own row 20).
  approx(actors.stats(actor).blockChance, 38.4, 'blockChance at slvl 20 (8 + 1.6x19)');
  approx(actors.stats(actor).thorns, 82, 'thorns at slvl 20 (6 + 4x19)');
});

// ===========================================================================
// resonance_circuit maxResonance — 3 -> 4 (>=1) -> 5 (>=10), never 6
// ===========================================================================

test('resonance_circuit: maxResonance is 3,4,4,5,5 at effective level 0,1,9,10,20', async () => {
  const ctx = await makeCtx(5);
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const actor = spawnActor(actors, 'runeblade', 30);

  assert.equal(actors.stats(actor).maxResonance, 3, 'effective level 0 (unallocated) — class base only');

  skills.allocate(actor, 'resonance_circuit');
  assert.equal(actors.stats(actor).maxResonance, 4, 'effective level 1');

  for (let i = 0; i < 8; i++) skills.allocate(actor, 'resonance_circuit'); // now at 9
  assert.equal(skills.instanceOf(actor, 'resonance_circuit').allocated, 9);
  assert.equal(actors.stats(actor).maxResonance, 4, 'effective level 9 — threshold not yet reached');

  skills.allocate(actor, 'resonance_circuit'); // now at 10
  assert.equal(actors.stats(actor).maxResonance, 5, 'effective level 10 — threshold bonus lands');

  for (let i = 0; i < 10; i++) skills.allocate(actor, 'resonance_circuit'); // now at 20
  assert.equal(actors.stats(actor).maxResonance, 5, 'effective level 20 — still 5, never 6 (StatBlock cap 8 is deliberately unreachable)');
});

// ===========================================================================
// manaReturnPercent — O-84/D-53 micro-scope: Runeblade class base composes
// to 8 with no hand-set stats; other two classes get nothing (0).
// ===========================================================================

test('manaReturnPercent: a freshly-spawned Runeblade composes to 8 with no hand-set stats; Ravager/Emberwright compose to 0', async () => {
  const ctx = await makeCtx(6);
  const actors = ctx.get('actors');

  const runeblade = spawnActor(actors, 'runeblade', 10);
  assert.equal(actors.stats(runeblade).manaReturnPercent, 8, '03 §2.4: "Base manaReturnPercent for the Runeblade class is 8"');

  const ravager = spawnActor(actors, 'ravager', 10);
  assert.equal(actors.stats(ravager).manaReturnPercent, 0, '03 gives no base for Ravager — D-53: give nothing, not an invented number');

  const emberwright = spawnActor(actors, 'emberwright', 10);
  assert.equal(actors.stats(emberwright).manaReturnPercent, 0, '03 gives no base for Emberwright — D-53: give nothing, not an invented number');
});

test('resonance_circuit.manaReturnPercent composes on top of the class base — 05 §7.2 L1: 8 + 4 = 12; the doc\'s own printed example at slvl 4: 8 + 6.4 = 14.4', async () => {
  const ctx = await makeCtx(7);
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const actor = spawnActor(actors, 'runeblade', 30);

  skills.allocate(actor, 'resonance_circuit'); // slvl 1
  approx(actors.stats(actor).manaReturnPercent, 12, '05 §7.2 table row L1: total return % (base 8) column reads 12');

  for (let i = 0; i < 2; i++) skills.allocate(actor, 'resonance_circuit'); // slvl 3
  const s3 = skills.allocate(actor, 'resonance_circuit'); // slvl 4
  void s3;
  approx(actors.stats(actor).manaReturnPercent, 14.4, '05 §14 L3242\'s own worked example: resonance_circuit 4 -> manaReturnPercent 8 + 6.4 = 14.4%');
});

// ===========================================================================
// bloodthirst — lifeSteal 3 -> 20.1
// ===========================================================================

test('bloodthirst: lifeSteal is 3 at slvl 1 and 20.1 at slvl 20', async () => {
  const ctx = await makeCtx(8);
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const actor = spawnActor(actors, 'ravager', 30);

  skills.allocate(actor, 'bloodthirst');
  approx(actors.stats(actor).lifeSteal, 3, 'lifeSteal at slvl 1');
  for (let i = 0; i < 19; i++) skills.allocate(actor, 'bloodthirst');
  approx(actors.stats(actor).lifeSteal, 20.1, 'lifeSteal at slvl 20');
});

// ===========================================================================
// mana_weave — maxMana/manaRegen/damageTakenToMana
// ===========================================================================

test('mana_weave: maxMana/manaRegen/damageTakenToMana at slvl 1 and slvl 20', async () => {
  const ctx = await makeCtx(9);
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const actor = spawnActor(actors, 'emberwright', 30);

  skills.allocate(actor, 'mana_weave');
  const s1 = actors.stats(actor);
  // maxMana is a flat term inside derive()'s parenthesis, not read verbatim
  // off sources.skills — check the SOURCE layer directly for the skill's
  // own contribution instead of the derived total.
  approx(actor.sources.skills.maxMana, 12, 'maxMana contribution at slvl 1');
  approx(s1.manaRegen >= 0.8 ? actor.sources.skills.manaRegen : NaN, 0.8, 'manaRegen contribution at slvl 1');
  approx(s1.damageTakenToMana, 10, 'damageTakenToMana at slvl 1');

  for (let i = 0; i < 19; i++) skills.allocate(actor, 'mana_weave');
  approx(actor.sources.skills.maxMana, 126, 'maxMana contribution at slvl 20');
  approx(actor.sources.skills.manaRegen, 7.45, 'manaRegen contribution at slvl 20');
  approx(actors.stats(actor).damageTakenToMana, 29, 'damageTakenToMana at slvl 20 (cap 30 not yet reached)');
});

// ===========================================================================
// incinerate — fireDamagePercent
// ===========================================================================

test('incinerate: fireDamagePercent is 12 at slvl 1 and 88 at slvl 20', async () => {
  const ctx = await makeCtx(10);
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const actor = spawnActor(actors, 'emberwright', 30);

  skills.allocate(actor, 'incinerate');
  approx(actors.stats(actor).fireDamagePercent, 12, 'fireDamagePercent at slvl 1');
  for (let i = 0; i < 19; i++) skills.allocate(actor, 'incinerate');
  approx(actors.stats(actor).fireDamagePercent, 88, 'fireDamagePercent at slvl 20');
});

// ===========================================================================
// iron_skin <- shield_stance synergy (the one synergy landing inside a
// passiveStats key — see src/skills/passive.js's own header)
// ===========================================================================

test('iron_skin.defensePercent receives the +4%/source-level synergy from shield_stance (05 §3.4 table: 25 alone, 105 with shield_stance 20)', async () => {
  const ctx = await makeCtx(11);
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const actor = spawnActor(actors, 'ravager', 30);

  skills.allocate(actor, 'iron_skin'); // slvl 1, no shield_stance yet
  approx(actors.stats(actor).defensePercent, 25, 'iron_skin alone at slvl 1, no synergy source allocated');

  for (let i = 0; i < 20; i++) skills.allocate(actor, 'shield_stance');
  approx(actors.stats(actor).defensePercent, 105, 'iron_skin slvl 1 + shield_stance 20 synergy (25 + 4x20)');
});

// ===========================================================================
// stats:dirty emission — exactly once per passive allocate(), none for a
// non-passive allocate()
// ===========================================================================

test('allocate() of a passive emits stats:dirty exactly once; allocate() of a non-passive emits none', async () => {
  const ctx = await makeCtx(12);
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const actor = spawnActor(actors, 'ravager', 30);

  let dirtyCount = 0;
  ctx.events.on('stats:dirty', () => { dirtyCount++; });

  skills.allocate(actor, 'bloodthirst'); // passive
  assert.equal(dirtyCount, 1, 'a passive allocate() must emit stats:dirty exactly once');

  skills.allocate(actor, 'cleaving_strike'); // non-passive, does not touch sources.skills
  assert.equal(dirtyCount, 1, 'a non-passive allocate() must not emit stats:dirty (it cannot change the skills layer)');

  skills.respec(actor);
  assert.equal(dirtyCount, 2, 'respec() must emit stats:dirty once when it actually refunded points');

  assert.equal(skills.respec(actor), 0, 'an already-empty respec() refunds 0');
  assert.equal(dirtyCount, 2, 'a no-op respec() (refunded 0) must not emit stats:dirty again');
});

// ===========================================================================
// D-46 sanity: type:'passive' matches the eight named in the ticket brief,
// no hard-coded "nine" anywhere in the engine (checked indirectly: the
// filter above already proves the count is data-derived, not literal).
// ===========================================================================

test('respec() clears every passive contribution back to the class base', async () => {
  const ctx = await makeCtx(13);
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const actor = spawnActor(actors, 'ravager', 30);

  for (let i = 0; i < 20; i++) skills.allocate(actor, 'bloodthirst');
  for (let i = 0; i < 20; i++) skills.allocate(actor, 'shield_stance');
  assert.ok(actors.stats(actor).lifeSteal > 0);
  assert.ok(actors.stats(actor).dodgeChance > 0);

  skills.respec(actor);
  assert.equal(actors.stats(actor).lifeSteal, 0, 'lifeSteal back to 0 after respec');
  assert.equal(actors.stats(actor).dodgeChance, 0, 'dodgeChance back to 0 after respec');
  assert.equal(actors.stats(actor).blockChance, 0, 'blockChance back to 0 after respec');
  assert.equal(actors.stats(actor).thorns, 0, 'thorns back to 0 after respec');
});
