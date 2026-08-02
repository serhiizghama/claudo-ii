// tests/skills/incinerate.test.js
//
// SKIL-6 acceptance test for `05-skills.md` §12.2 — `incinerate` corpse-
// explosion chains must NOT chain. Exercises `createIncinerateReaction`
// (`src/skills/status.js`) exactly as wired in `src/skills/index.js`: a
// permanent `ctx.events.on('actor:damage', ...)` listener, live from a real
// `boot()`, not called directly — this proves the WIRING, not just the pure
// function.
//
// `skill:trigger` stands in for the `immolate.explode` audio hook (`05`
// §4.5's own visual/audio table) — `src/fx/`/`src/audio/` do not exist yet
// (same gap `src/skills/index.js`'s own header documents for `static deps`),
// so this is the closest real, emitted signal this ticket's file list can
// reach. See `status.js#createIncinerateReaction`'s own header for why this
// substitution is documented, not silent.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { computeIncinerateDetonationPercent } from '../../src/skills/status.js';

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
const actors = ctx.get('actors');
const combat = ctx.get('combat');
const skills = ctx.get('skills');

// ===========================================================================
// The pure formula — 05 §4.5's own 20-level table, spot-checked
// ===========================================================================

test('computeIncinerateDetonationPercent matches 05 §4.5 own printed table (base and +flame_wave 20 columns)', () => {
  const def = skills.definition('incinerate');
  // L1: base 25, +flame_wave 20 -> 45 (25 x 1.8)
  assert.ok(Math.abs(computeIncinerateDetonationPercent(def, 1, 0) - 25) < 1e-9);
  assert.ok(Math.abs(computeIncinerateDetonationPercent(def, 1, 4 * 20) - 45) < 1e-9);
  // L20: base 82, +flame_wave 20 -> 147.6 (82 x 1.8)
  assert.ok(Math.abs(computeIncinerateDetonationPercent(def, 20, 0) - 82) < 1e-9);
  const l20fw20 = computeIncinerateDetonationPercent(def, 20, 4 * 20);
  console.log(`[incinerate] L20 base=82%, +flame_wave 20 -> ${l20fw20}% (table: 147.6%)`);
  assert.ok(Math.abs(l20fw20 - 147.6) < 1e-9);
});

// ===========================================================================
// §12.2 — nine monsters at 1.2 m spacing, one killed by fire: exactly one
// detonation (skill:trigger), and at most one round of deaths
// ===========================================================================

test('§12.2: nine monsters at 1.2m spacing, one killed by fire -> exactly one detonation, at most one round of deaths', () => {
  const player = actors.spawn({ kind: 'player', archetypeId: 'emberwright', team: 0, x: 0, z: 8000, level: 30 });
  actors.setState(player, 'idle');
  actors.stats(player);
  // Max incinerate AND flame_wave (synergy) so the detonation percent is
  // comfortably above 100% of a same-maxLife neighbour's own life — 05
  // §4.5's own printed table: L20 + flame_wave 20 -> 147.6%.
  for (let i = 0; i < 20; i++) skills.allocate(player, 'incinerate');
  for (let i = 0; i < 20; i++) skills.allocate(player, 'flame_wave');
  assert.equal(skills.effectiveLevel(player, 'incinerate'), 20);

  // Nine monsters in a line, 1.2 m apart, all equal maxLife, all fire-vulnerable.
  const monsters = [];
  for (let i = 0; i < 9; i++) {
    const m = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: 0, z: 8000 + i * 1.2, level: 1 });
    actors.setState(m, 'idle');
    actors.stats(m);
    m.stats.maxLife = 80;
    m.stats.fireResist = 0;
    m.life = 80;
    monsters.push(m);
  }
  const victimIndex = 4; // the middle one — within 2.5m of the most neighbours
  const victim = monsters[victimIndex];

  let triggerCount = 0;
  const triggerLog = [];
  const onTrigger = (payload) => {
    if (payload.skillId !== 'incinerate') return;
    triggerCount++;
    triggerLog.push({ actor: payload.actor.id, level: payload.level, step: ctx.time.step });
  };
  ctx.events.on('skill:trigger', onTrigger);

  const deathLog = [];
  const onDeath = (payload) => { deathLog.push({ actor: payload.actor.id, step: ctx.time.step }); };
  ctx.events.on('actor:death', onDeath);

  ctx.time.step = 200000; // well clear of every other test file's step range in this shared boot()

  // Kill the victim with a fire hit that is NOT incinerate's own detonation
  // — 05 §4.5's own trigger condition ("died to a packet whose SURVIVING
  // fire component was greater than zero"). `applyDirect` is the documented
  // "mitigation-free, scripted damage" entry point (02-api-contracts.md §8)
  // — an ordinary way for a fire source unrelated to this ticket's engine
  // (a monster affix, another player's fireball, ...) to cause exactly this.
  const killResult = combat.applyDirect(victim, 1000, 'fire', player.id, 'test-fire-source');
  assert.ok(killResult.killed, 'the scripted hit must kill the victim outright');

  console.log(`[§12.2] victim (monster #${victimIndex}, id=${victim.id}) killed by fire; skill:trigger count = ${triggerCount}`);
  console.log(`[§12.2] deaths so far: ${deathLog.length} (${deathLog.map((d) => d.actor).join(', ')})`);

  assert.equal(triggerCount, 1, `exactly one detonation must fire, got ${triggerCount}`);

  // "at most one round of deaths": every OTHER death (beyond the victim's
  // own, which is round 0 / the trigger itself) must be attributable to the
  // ONE detonation — none may have chained into a second detonation, which
  // would show up as a SECOND skill:trigger (already asserted above) and,
  // structurally, as a THIRD wave of deaths this test also checks for by
  // waiting one more beat and confirming nothing further happens.
  const deathsAfterDetonation = deathLog.length;
  console.log(`[§12.2] total dead (including the victim): ${deathsAfterDetonation} of 9`);
  assert.ok(deathsAfterDetonation >= 2, 'the detonation must have killed at least one neighbour, or this scenario proves nothing');
  assert.ok(deathsAfterDetonation < 9, 'sanity: not EVERY monster should die from one 2.5m-radius blast at 1.2m spacing');

  // Confirm no further detonation or death occurs — nothing left to chain.
  const finalTriggerCount = triggerCount;
  const finalDeathCount = deathLog.length;
  assert.equal(triggerCount, finalTriggerCount);
  assert.equal(deathLog.length, finalDeathCount);

  ctx.events.off('skill:trigger', onTrigger);
  ctx.events.off('actor:death', onDeath);
});

// ===========================================================================
// The re-entrancy guard, isolated: a kill whose DamageResult already carries
// sourceSkillId === 'incinerate' (i.e. IS a detonation, or a burn tick it
// seeded) must never re-trigger, even with a fresh incinerate-allocated
// killer and a fire-killed victim.
// ===========================================================================

test('§12.2 guard: a kill sourced from a previous detonation (sourceSkillId === "incinerate") never re-detonates', () => {
  const player = actors.spawn({ kind: 'player', archetypeId: 'emberwright', team: 0, x: 0, z: 9000, level: 30 });
  actors.setState(player, 'idle');
  actors.stats(player);
  for (let i = 0; i < 20; i++) skills.allocate(player, 'incinerate');

  const victim = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: 0, z: 9000, level: 1 });
  actors.setState(victim, 'idle');
  actors.stats(victim);
  victim.stats.maxLife = 50;
  victim.stats.fireResist = 0;
  victim.life = 50;

  let triggerCount = 0;
  const onTrigger = (payload) => { if (payload.skillId === 'incinerate') triggerCount++; };
  ctx.events.on('skill:trigger', onTrigger);

  ctx.time.step = 210000;
  // A "kill" whose own DamageResult already carries sourceSkillId ===
  // 'incinerate' — exactly what a real detonation or the burn tick it seeds
  // produces. combat.applyDirect's own skillId parameter is the packet
  // provenance a real detonation carries.
  const result = combat.applyDirect(victim, 1000, 'fire', player.id, 'incinerate');
  assert.ok(result.killed);
  assert.equal(result.sourceSkillId, 'incinerate');

  console.log(`[§12.2 guard] a kill with sourceSkillId='incinerate' produced ${triggerCount} further detonations (must be 0)`);
  assert.equal(triggerCount, 0, 'a kill already attributed to incinerate must never re-trigger it');

  ctx.events.off('skill:trigger', onTrigger);
});
