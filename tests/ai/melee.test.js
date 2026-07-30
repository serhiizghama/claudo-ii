// tests/ai/melee.test.js
//
// AI-2 acceptance test for `src/ai/index.js` + `src/ai/brains/melee.js`.
//
// `06-monsters-ai.md` §13 step 2's own deliverable text, verbatim, is this
// ticket's own criterion (the backlog's `06.S01`-`06.S04` do not exist — see
// the ticket brief): "A Bone Ranker spawned by hand in the M1 test map walks
// to the player, swings on schedule, deals damage, dies, and awards XP."
//
// Extended per the orchestrator's review of the first round: the M2 gate's
// item ⑨ reads "a mob damages the player, the player dies and respawns."
// Respawn is PLYR-8 (`src/player/death.js`, M6) and out of reach here — but
// "the player dies" is squarely in reach (`combat` kills any actor without
// distinguishing `kind`), so this file now runs TWO independent fights in
// one scenario, sharing one continuous step timeline and one trace:
//
//   Fight A — the Ranker's own real schedule alone kills the player (no
//             scripted counter-attack at all for this pair). Closes item ⑨'s
//             in-scope half: `actor:death` with the PLAYER as victim.
//   Fight B — the original sequence, unchanged: the player's scripted
//             counter-attack (`combat.applyDirect`, out-of-scope player/
//             skills territory) kills the Ranker, which awards XP.
//
// Both pairs are processed by the SAME `ai.fixedUpdate`/`combat.fixedUpdate`
// calls every step (it iterates every live brain), at different world
// positions so neither fight interferes with the other's targeting/range
// checks — one scenario, two real deaths, one trace, exactly as asked.
//
// `console.log`s a step-by-step trace throughout (rule 12: "a boolean pass
// proves nothing here; the trace is the deliverable") and asserts against
// the actual recorded `actor:death` PAYLOADS (victim/killer identity), never
// inferred from `life <= 0`.
//
// Fixture pattern (real `ActorsSystem`/`ActorPool`, real `CombatSystem`,
// `composeStats`/`setSourceLayer` imported directly for the PLAYER fixtures
// only) matches `tests/combat/*.test.js`'s own established style — see
// `packet.test.js`/`xp.test.js`'s "Fixture helpers" sections, referenced
// throughout below. Neither Ranker is ever given a composed `StatBlock` —
// see `src/ai/index.js`'s header for why that is correct, not an omission.
//
// Node-safe: `node:test` + `node:assert/strict` only, no `three`, no DOM.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ActorsSystem } from '../../src/actors/index.js';
import { CombatSystem } from '../../src/combat/packet.js';
import { composeStats } from '../../src/actors/stats.js';
import { AiSystem } from '../../src/ai/index.js';
import { BESTIARY, lifeMult, damageMult, defenseMult, arMult, xpMult, flatDR } from '../../src/ai/data/bestiary.js';
import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';

const FIXED_DT = 1 / 60;
const ATTACK_CYCLE_TICKS = 84; // 1.40 s attackTime, 06 §2.1 — cross-checked against the trace below

/** Same stub-`ctx` shape `tests/combat/packet.test.js#makeStubCtx` already
 * uses (a live `EventBus`/`Rng`, a `Map`-backed `get`/`peek`/`has`) — kept
 * local rather than importing `tests/helpers/actor.js#makeStubCtx` because
 * this scenario needs to MUTATE `time.step` in place every simulated step,
 * which is exactly what `ctx.time` being a plain, caller-owned object
 * already supports either way; no functional difference, just avoiding an
 * extra cross-file dependency for a five-line object literal. */
function makeCtx() {
  const systems = new Map();
  return {
    config: {},
    events: new EventBus(),
    time: { elapsed: 0, raw: 0, dt: FIXED_DT, fixed: FIXED_DT, alpha: 0, scale: 1, frame: 0, step: 0 },
    rng: new Rng(0x0b04e7a5), // fixed seed — deterministic trace, reproducible on every run
    get(id) {
      if (!systems.has(id)) throw new Error(`stub ctx.get: '${id}' not registered`);
      return systems.get(id);
    },
    peek(id) {
      return systems.get(id);
    },
    has(id) {
      return systems.has(id);
    },
    _systems: systems,
  };
}

test('AI-2: a hand-spawned Bone Ranker walks to the player, swings on schedule, deals damage — and either side can die from it', async () => {
  const ctx = makeCtx();

  const actors = new ActorsSystem();
  await actors.init(ctx);
  ctx._systems.set('actors', actors);

  const combat = new CombatSystem();
  await combat.init(ctx);
  ctx._systems.set('combat', combat);

  const ai = new AiSystem();
  await ai.init(ctx);
  ctx._systems.set('ai', ai);

  const MLVL = 10; // 06 §2.1's own table row: Life 88, Damage 11-22, DEF 67, AR 199, XP 36 — cross-checked below.

  // Cross-check spawnOne's own mlvl-scaling arithmetic against 06 §2.1's
  // printed table row for mlvl 10, before the scenario runs at all — shared
  // by both Rankers below (same archetype, same mlvl).
  const expectedLife = Math.round(BESTIARY.bone_ranker.baseLife * lifeMult(MLVL));
  const expectedMinDmg = Math.round(BESTIARY.bone_ranker.baseMinDamage * damageMult(MLVL));
  const expectedMaxDmg = Math.round(BESTIARY.bone_ranker.baseMaxDamage * damageMult(MLVL));
  const expectedDef = Math.round(BESTIARY.bone_ranker.baseDefense * defenseMult(MLVL));
  const expectedAR = Math.round(BESTIARY.bone_ranker.baseAttackRating * arMult(MLVL));
  const expectedXp = Math.round(BESTIARY.bone_ranker.baseXp * xpMult(MLVL) * 1.0 * 1.0); // rank normal x1, Instruction x1
  assert.equal(expectedLife, 88, '06 §2.1 table: mlvl10 Life 88');
  assert.equal(expectedMinDmg, 11, '06 §2.1 table: mlvl10 Damage 11-22 (min)');
  assert.equal(expectedMaxDmg, 22, '06 §2.1 table: mlvl10 Damage 11-22 (max)');
  assert.equal(expectedDef, 67, '06 §2.1 table: mlvl10 DEF 67');
  assert.equal(expectedAR, 199, '06 §2.1 table: mlvl10 AR 199');
  assert.equal(flatDR(MLVL), 1, '06 §2.1 table: mlvl10 flat DR 1');

  // ── Fight A fixture — a FRAGILE player (no allocated vitality beyond the
  // Ravager class base, clvl 10 -> maxLife 73) and a Ranker with no scripted
  // counter-attack opposing it at all: whatever kills this player is the
  // Ranker's own real hit-request schedule, nothing else. Placed at z=0. ──
  const playerA = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 10, team: 0, x: 0, z: 0 });
  assert.ok(playerA, 'fixture sanity: player A spawned');
  composeStats(playerA); // attributes left at createActorRecord's {0,0,0,0} default — no extra vitality allocated
  playerA.life = playerA.stats.maxLife;

  const rankerA = ai.spawnOne('bone_ranker', 8, 0, MLVL, 'normal', []);
  assert.ok(rankerA, 'fixture sanity: Ranker A spawned');
  ai.setTarget(rankerA, playerA.id);
  assert.equal(ai.brainOf(rankerA).state, 'chase', 'Ranker A: setTarget bypassed dormant straight into chase');

  // ── Fight B fixture — the ORIGINAL scenario, unchanged: a healthy player
  // (clvl 10 + 20 allocated vitality -> maxLife 153) whose own scripted
  // counter-attack kills the Ranker before the Ranker's schedule can kill
  // it. Placed at z=20 so it never interacts with Fight A. ──
  const playerB = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 10, team: 0, x: 0, z: 20 });
  assert.ok(playerB, 'fixture sanity: player B spawned');
  Object.assign(playerB.attributes, { strength: 0, dexterity: 0, vitality: 20, energy: 0 });
  composeStats(playerB);
  playerB.life = playerB.stats.maxLife;

  const rankerB = ai.spawnOne('bone_ranker', 8, 20, MLVL, 'normal', []);
  assert.ok(rankerB, 'fixture sanity: Ranker B spawned');
  ai.setTarget(rankerB, playerB.id);
  assert.equal(ai.brainOf(rankerB).state, 'chase', 'Ranker B: setTarget bypassed dormant straight into chase');

  for (const [ranker, expected] of [[rankerA, expectedLife], [rankerB, expectedLife]]) {
    assert.equal(ranker.life, expected, 'spawnOne set actor.life from the bestiary row');
    assert.equal(ranker.baseXp, BESTIARY.bone_ranker.baseXp, 'spawnOne set actor.baseXp (the documented forward-compat gap, src/combat/xp.js)');
  }

  // ── Trace instrumentation — one shared trace, tagged [A]/[B] ──
  const trace = [];
  const fightA = { hitRequestCount: 0, hitRequestSteps: [], damageTaken: 0, chaseSteps: [], lastState: null, deathEvent: null };
  const fightB = { hitRequestCount: 0, hitRequestSteps: [], damageTaken: 0, chaseSteps: [], lastState: null, deathEvent: null, xpGained: null };

  ctx.events.on('combat:hit-request', ({ source, target: hitTarget }) => {
    if (source === rankerA) {
      fightA.hitRequestCount++;
      fightA.hitRequestSteps.push(ctx.time.step);
      trace.push(`  [A][step ${ctx.time.step}] combat:hit-request emitted — Ranker A -> ${hitTarget === playerA ? 'player A' : 'target'}`);
    } else if (source === rankerB) {
      fightB.hitRequestCount++;
      fightB.hitRequestSteps.push(ctx.time.step);
      trace.push(`  [B][step ${ctx.time.step}] combat:hit-request emitted — Ranker B -> ${hitTarget === playerB ? 'player B' : 'target'}`);
    }
  });
  ctx.events.on('actor:damage', (payload) => {
    if (payload.target === playerA) {
      fightA.damageTaken += payload.result.total;
      trace.push(`  [A][step ${ctx.time.step}] actor:damage -> player A: outcome=${payload.result.outcome} total=${payload.result.total.toFixed(2)} crit=${payload.result.crit} (player A life ${playerA.life.toFixed(2)}/${playerA.stats.maxLife})`);
    } else if (payload.target === rankerA) {
      trace.push(`  [A][step ${ctx.time.step}] actor:damage -> Ranker A: outcome=${payload.result.outcome} total=${payload.result.total.toFixed(2)} (Ranker A life ${rankerA.life.toFixed(2)}/${expectedLife})`);
    } else if (payload.target === playerB) {
      fightB.damageTaken += payload.result.total;
      trace.push(`  [B][step ${ctx.time.step}] actor:damage -> player B: outcome=${payload.result.outcome} total=${payload.result.total.toFixed(2)} crit=${payload.result.crit} (player B life ${playerB.life.toFixed(2)}/${playerB.stats.maxLife})`);
    } else if (payload.target === rankerB) {
      trace.push(`  [B][step ${ctx.time.step}] actor:damage -> Ranker B: outcome=${payload.result.outcome} total=${payload.result.total.toFixed(2)} (Ranker B life ${rankerB.life.toFixed(2)}/${expectedLife})`);
    }
  });
  ctx.events.on('actor:death', (payload) => {
    if (payload.actor === playerA) {
      fightA.deathEvent = { actor: payload.actor, killer: payload.killer };
      trace.push(`  [A][step ${ctx.time.step}] actor:death — PLAYER A killed by ${payload.killer === rankerA ? 'Ranker A' : 'someone else'}`);
    } else if (payload.actor === rankerB) {
      fightB.deathEvent = { actor: payload.actor, killer: payload.killer };
      trace.push(`  [B][step ${ctx.time.step}] actor:death — RANKER B killed by ${payload.killer === playerB ? 'player B' : 'someone else'}`);
    } else {
      // Fight A's kill still runs the generic death/XP pipeline in the other
      // direction (killer=Ranker A, victim=player A) — `awardXp` reads
      // `victim.baseXp`, which a player actor never has, so this is the
      // documented `Number.isFinite(...) ? ... : 0` fallback firing (see
      // `src/combat/xp.js`), not a real XP grant. Logged, not asserted on.
      trace.push(`  [step ${ctx.time.step}] actor:death — ${payload.actor === playerA ? 'PLAYER A' : payload.actor === rankerB ? 'RANKER B' : 'other'} killed by other`);
    }
  });
  ctx.events.on('xp:gain', (payload) => {
    if (payload.actor === playerB) {
      fightB.xpGained = payload.amount;
      trace.push(`  [B][step ${ctx.time.step}] xp:gain — ${payload.amount} XP awarded to player B`);
    } else {
      trace.push(`  [step ${ctx.time.step}] xp:gain — ${payload.amount} XP awarded to ${payload.actor === rankerA ? 'Ranker A (the documented baseXp-fallback noise, not a real grant)' : 'actor'}`);
    }
  });

  // ── Fight B's scripted player counter-attack — the ORIGINAL mechanism,
  // unchanged. Fight A gets NO counter-attack at all (see file header): the
  // Ranker's own real schedule is the only thing that touches player A's
  // life. `combat.applyDirect` ("mitigation-free, for scripted damage",
  // 02-api-contracts.md §8) is the documented, sanctioned entry point for
  // driving the player's side of Fight B — building a real player attacker
  // is `player`/`skills` territory, out of this ticket's scope. ──
  const PLAYER_HIT_INTERVAL_STEPS = 60;
  const PLAYER_HIT_DAMAGE = 20;
  let lastPlayerBHitStep = -Infinity;

  const MAX_STEPS = 3000; // 50 s headroom — comfortably covers both fights, including a fragile player A absorbing several real swings
  let bothDeathsAt = null;

  for (let i = 0; i < MAX_STEPS; i++) {
    ctx.time.step++;
    ctx.time.frame++;

    ai.fixedUpdate(FIXED_DT, ctx); // drives BOTH Rankers' brains — one call, per 06 §3.2
    combat.fixedUpdate(FIXED_DT, ctx);

    // `ai.brainOf()` returns a REUSED scratch object (Alloc: no, per
    // 02-api-contracts.md §12 — same discipline as motion.js's `MoveResult`):
    // the two calls below alias the SAME object, so each one's `.state` is
    // copied out into a plain string IMMEDIATELY, before the other call
    // overwrites it. Holding `brainOf()`'s return value itself across the
    // second call (as an earlier draft of this file did) silently aliases
    // both fights' entries onto whichever brain was queried last — a
    // test-only bug, caught by the trace looking wrong, not a production one.
    const brainAObj = ai.brainOf(rankerA);
    const stateA = brainAObj ? brainAObj.state : null;
    const distA = actors.distance(rankerA, playerA);
    if (stateA !== null && stateA !== fightA.lastState) {
      trace.push(`  [A][step ${ctx.time.step}] Ranker A brain: ${fightA.lastState ?? '(none)'} -> ${stateA} (dist=${distA.toFixed(2)}m)`);
      fightA.lastState = stateA;
    }
    if (stateA === 'chase') fightA.chaseSteps.push(distA);

    const brainBObj = ai.brainOf(rankerB);
    const stateB = brainBObj ? brainBObj.state : null;
    const distB = actors.distance(rankerB, playerB);
    if (stateB !== null && stateB !== fightB.lastState) {
      trace.push(`  [B][step ${ctx.time.step}] Ranker B brain: ${fightB.lastState ?? '(none)'} -> ${stateB} (dist=${distB.toFixed(2)}m)`);
      fightB.lastState = stateB;
    }
    if (stateB === 'chase') fightB.chaseSteps.push(distB);

    // Fight B only: the scripted player counter-attack.
    if (!rankerB.dead && !playerB.dead && distB <= 2.5 && (ctx.time.step - lastPlayerBHitStep) >= PLAYER_HIT_INTERVAL_STEPS) {
      lastPlayerBHitStep = ctx.time.step;
      const result = combat.applyDirect(rankerB, PLAYER_HIT_DAMAGE, 'physical', playerB.id, 'player_attack');
      trace.push(`  [B][step ${ctx.time.step}] player B scripted attack -> Ranker B: ${PLAYER_HIT_DAMAGE} physical (Ranker B life now ${rankerB.life.toFixed(2)}, killed=${result.killed})`);
    }

    if (i % 60 === 0) {
      trace.push(`[step ${ctx.time.step}] A: state=${stateA ?? 'n/a'} dist=${distA.toFixed(2)}m rankerLife=${rankerA.life.toFixed(2)} playerLife=${playerA.life.toFixed(2)}/${playerA.stats.maxLife}  |  B: state=${stateB ?? 'n/a'} dist=${distB.toFixed(2)}m rankerLife=${rankerB.life.toFixed(2)} playerLife=${playerB.life.toFixed(2)}/${playerB.stats.maxLife}`);
    }

    if (playerA.dead && rankerB.dead && bothDeathsAt === null) {
      bothDeathsAt = ctx.time.step;
      trace.push(`[step ${ctx.time.step}] Both deaths confirmed (player A dead, Ranker B dead) — stopping the scenario.`);
      break;
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\n=== AI-2 scenario trace (bone_ranker mlvl${MLVL}; Fight A: Ranker kills fragile player; Fight B: player kills Ranker) ===\n${trace.join('\n')}\n=== end trace ===\n`);

  // ── Fight A — "the player dies" half of gate item ⑨ ──
  assert.ok(fightA.chaseSteps.length > 0, 'FIGHT A WALKS: Ranker A spent real time in chase');
  assert.ok(fightA.chaseSteps[0] > fightA.chaseSteps[fightA.chaseSteps.length - 1], `FIGHT A WALKS: distance strictly decreased during chase (${fightA.chaseSteps[0].toFixed(2)}m -> ${fightA.chaseSteps[fightA.chaseSteps.length - 1].toFixed(2)}m)`);
  assert.ok(fightA.hitRequestCount > 0, 'FIGHT A ATTACKS: Ranker A emitted at least one combat:hit-request');
  for (let k = 1; k < fightA.hitRequestSteps.length; k++) {
    assert.equal(fightA.hitRequestSteps[k] - fightA.hitRequestSteps[k - 1], ATTACK_CYCLE_TICKS, `FIGHT A SWINGS ON SCHEDULE: consecutive hit-requests exactly ${ATTACK_CYCLE_TICKS} ticks apart (steps ${fightA.hitRequestSteps[k - 1]} -> ${fightA.hitRequestSteps[k]})`);
  }
  assert.ok(fightA.damageTaken > 0, `FIGHT A DEALS DAMAGE: player A actually took damage from Ranker A (total ${fightA.damageTaken})`);
  assert.equal(playerA.dead, true, 'FIGHT A: player A is dead');
  assert.ok(fightA.deathEvent !== null, 'FIGHT A: actor:death was emitted for player A (asserted on the event, not inferred from life <= 0)');
  assert.equal(fightA.deathEvent.actor, playerA, 'FIGHT A: the dead actor recorded on the event is player A');
  assert.equal(fightA.deathEvent.killer, rankerA, 'FIGHT A: Ranker A is recorded as the killer');

  // ── Fight B — the original criterion, unchanged ──
  assert.ok(fightB.chaseSteps.length > 0, 'FIGHT B WALKS: Ranker B spent real time in chase');
  assert.ok(fightB.chaseSteps[0] > fightB.chaseSteps[fightB.chaseSteps.length - 1], `FIGHT B WALKS: distance strictly decreased during chase (${fightB.chaseSteps[0].toFixed(2)}m -> ${fightB.chaseSteps[fightB.chaseSteps.length - 1].toFixed(2)}m)`);
  assert.ok(fightB.hitRequestCount > 0, 'FIGHT B ATTACKS: Ranker B emitted at least one combat:hit-request');
  for (let k = 1; k < fightB.hitRequestSteps.length; k++) {
    assert.equal(fightB.hitRequestSteps[k] - fightB.hitRequestSteps[k - 1], ATTACK_CYCLE_TICKS, `FIGHT B SWINGS ON SCHEDULE: consecutive hit-requests exactly ${ATTACK_CYCLE_TICKS} ticks apart (steps ${fightB.hitRequestSteps[k - 1]} -> ${fightB.hitRequestSteps[k]})`);
  }
  assert.ok(fightB.damageTaken > 0, `FIGHT B DEALS DAMAGE: player B actually took damage from Ranker B (total ${fightB.damageTaken})`);
  assert.equal(rankerB.dead, true, 'FIGHT B: Ranker B is dead');
  assert.ok(fightB.deathEvent !== null, 'FIGHT B: actor:death was emitted for Ranker B (asserted on the event, not inferred from life <= 0)');
  assert.equal(fightB.deathEvent.actor, rankerB, 'FIGHT B: the dead actor recorded on the event is Ranker B');
  assert.equal(fightB.deathEvent.killer, playerB, 'FIGHT B: player B is recorded as the killer');
  assert.ok(fightB.xpGained !== null && fightB.xpGained > 0, 'FIGHT B AWARDS XP: xp:gain fired for player B with a positive amount');
  assert.equal(fightB.xpGained, expectedXp, `FIGHT B AWARDS XP: exact amount matches xpForMonster(mlvl10, normal, baseXp7, clvl10, instruction) = ${expectedXp}`);

  assert.ok(bothDeathsAt !== null, `Both deaths were observed within ${MAX_STEPS} steps (at step ${bothDeathsAt})`);
});
