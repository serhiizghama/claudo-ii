// src/ai/brains/crawler.js
//
// AI-6 — `06-monsters-ai.md` §2.6 (`blight_crawler` datasheet) and §3.8
// (the fuse). Shape follows `./melee.js`: brain state lives in `AiSystem`'s
// parallel arrays, never on `actor.state`; the hit packet is filled by hand
// via `combat.scratchPacket()`.
//
// ---------------------------------------------------------------------------
// What this file implements — T1 and T4 only, reported not hidden
// ---------------------------------------------------------------------------
// §2.6 lists four trigger conditions (T1-T4). This file implements:
//   T1 — `dist(crawler, target) <= 1.2 m` with LOS: lights the fuse.
//   T4 — 25.0 s of `chase` without reaching T1: lights the fuse anyway
//        (§2.6's own words: "removes itself... immediately" — i.e. the SAME
//        fuse-start action as T1, just a different trigger condition, not a
//        silent despawn).
// NOT implemented:
//   T2 — "the Crawler's life would drop to <= 0 from any source... the
//        lethal damage is applied AFTER the fuse starts, so the Crawler
//        survives its own fuse." This needs intercepting a damage result
//        BEFORE `combat` finalises `target.dead`, which no sanctioned `ai`
//        entry point exposes (`combat` is the only system that resolves
//        `actor:damage`, per `ARCHITECTURE.md`) — reported, not guessed at.
//   T3 — the sympathetic chain (`physics.overlapCircle`, 0.25 s delay,
//        depth cap 3). Also gated OFF at Instruction difficulty (`06`
//        §11.3), which is this milestone's only reachable tier (no
//        difficulty-tier plumbing reaches `ai.spawnOne` yet — `06` §13 step
//        11, unbuilt) — implementing a chain that can never fire under this
//        milestone's own settings was judged not worth the added surface
//        (multi-actor iteration, delayed sympathetic scheduling) inside this
//        ticket's time budget. A real, reported gap.
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`, no
// `Math.random()`.

import { BESTIARY, damageMult } from '../data/bestiary.js';

export const CRAWLER_ARCHETYPES = Object.freeze(new Set(['blight_crawler']));

const FIXED_HZ = 60;
const FIXED_DT = 1 / 60;
const CRAWLER_TURN_RATE = Math.PI * 2; // rad/s — same placeholder class as melee.js's MELEE_TURN_RATE

// `06` §2.6, transcribed verbatim.
const DETONATE_RANGE = 1.2; // T1 (attackRange)
const DETONATE_W = 0.85;
const DETONATE_S = 0.05;
const POISON_DURATION_S = 1.0; // packet.poisonDuration — combined with combat's own base window per §2.6's own "4.0 + 1.0 = 5.0 s" note
const T4_TIMEOUT_S = 25.0;

const DECISION_CADENCE_TICKS = 6; // 06 §3.2 — reached only outside a lit fuse

/** `detonate`'s ticks. Deliberately ignores `iasPercent` entirely — §2.6:
 * "IAS scaling: none, ever." Passing any value, including the extreme the
 * affix/tier tables can produce, changes nothing (MB19). No `recTicks`: the
 * Crawler dies on `hitTick`, there is no recovery phase. Exported for
 * MB18/MB19. */
export function detonateTicks(iasPercent = 0) {
  void iasPercent; // intentionally unused — see this function's own doc comment
  const windTicks = Math.max(2, Math.round(DETONATE_W * FIXED_HZ));
  const activeTicks = Math.round(DETONATE_S * FIXED_HZ);
  return { windTicks, activeTicks, recTicks: 0, hitTick: windTicks };
}

// Precomputed once, at module load — see `shaman.js`'s identical comment on
// its own `DUST_BOLT_TICKS_0` for why `lightFuse` reuses this frozen object
// rather than calling `detonateTicks(0)` inline every time the fuse lights.
const DETONATE_TICKS_0 = Object.freeze(detonateTicks(0));

/** @param {number} maxBrains same cap `AiSystem` sizes `_brains` to. */
export function createCrawlerStore(maxBrains) {
  return {
    maxBrains,
    chaseEnteredStep: new Int32Array(maxBrains).fill(-1),
  };
}

/**
 * One fixed step of the `blight_crawler` brain. Same call contract as
 * `melee.js#stepMeleeBrain`. `Alloc: no`.
 */
export function stepCrawlerBrain(ctx, actors, physics, actor, target, brains, idx, BRAIN_STATE, store, hasteStore) {
  const step = ctx.time.step;

  if (brains.swingActive[idx] === 1 && brains.hitTickStep[idx] === step) {
    detonate(ctx, actor, target);
    brains.hitTickStep[idx] = -1;
    return true; // the Crawler is dead — nothing further to decide, ever
  }

  if (brains.swingActive[idx] === 1) return false; // B2 — no exit, no re-decision, ever (not even after the tick, since detonate() above always fires the same step)

  if (brains.state[idx] !== BRAIN_STATE.chase) return false;

  if (store.chaseEnteredStep[idx] < 0) store.chaseEnteredStep[idx] = step;

  if (step < brains.nextDecisionStep[idx]) {
    moveTowards(actors, actor, target, hasteStore, idx, step);
    return false;
  }
  brains.nextDecisionStep[idx] = step + DECISION_CADENCE_TICKS;

  if (target.dead) return true;

  const inRange = actors.inRange(actor, target, DETONATE_RANGE);
  const hasLos = !physics || typeof physics.lineOfSight !== 'function'
    || physics.lineOfSight(actor.x, actor.z, target.x, target.z, 1 /* MASK.WORLD, 02-api-contracts.md §4 */);
  const timedOut = (step - store.chaseEnteredStep[idx]) >= Math.round(T4_TIMEOUT_S * FIXED_HZ);

  if ((inRange && hasLos) || timedOut) {
    lightFuse(ctx, actor, brains, idx, BRAIN_STATE);
  } else {
    moveTowards(actors, actor, target, hasteStore, idx, step);
  }
  return true;
}

function lightFuse(ctx, actor, brains, idx, BRAIN_STATE) {
  const step = ctx.time.step;
  const ticks = DETONATE_TICKS_0;
  brains.state[idx] = BRAIN_STATE.attack;
  brains.swingActive[idx] = 1;
  brains.hitTickStep[idx] = step + ticks.windTicks;
  brains.attackReadyStep[idx] = step + ticks.windTicks + ticks.activeTicks; // irrelevant — the actor is dead by then
}

/** B3: goal is the target's PREDICTED position, `target + targetVelocity ×
 * 0.30 s`. This ticket does not track a per-target velocity sample (no
 * sanctioned `ai` entry point exposes one — `Actor` carries no velocity
 * field per `01-data-model.md` §2, only `x`/`z`), so this steers at the
 * target's CURRENT position instead — a real, reported simplification. The
 * 0.30 s lead only matters against a strafing player; a stationary or
 * closing one (this ticket's own MB2 fixtures) is unaffected. */
function moveTowards(actors, actor, target, hasteStore, idx, step) {
  const dx = target.x - actor.x;
  const dz = target.z - actor.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > 1e-6) {
    let runSpeed = BESTIARY.blight_crawler.runSpeed;
    if (hasteStore) runSpeed *= hasteMultOf(hasteStore, idx, step);
    const inv = (runSpeed * FIXED_DT) / dist;
    actors.moveTo(actor, dx * inv, dz * inv);
  }
  actors.face(actor, target.x, target.z, CRAWLER_TURN_RATE);
}

/** Local re-implementation, see `swarm.js#hasteMultOf`'s own comment. */
function hasteMultOf(hasteStore, idx, step) {
  return idx < hasteStore.maxBrains && hasteStore.hasteUntilStep[idx] >= step ? 1.20 : 1;
}

/** `06` §2.6: poison packet (row total, `poisonDuration 1.0`, `attackRating
 * 0` — always hits, never blockable/dodgeable), then the Crawler kills
 * itself through the same `combat` pipeline every other death in this
 * codebase runs through (`applyDirect`, the documented "mitigation-free,
 * scripted damage" entry point — `melee.test.js`'s own Fight B precedent
 * for a scripted kill) rather than writing `actor.dead` directly, so
 * `actor:death`/XP/corpse-suppression all fire normally. */
function detonate(ctx, actor, target) {
  const combat = ctx.get('combat');
  if (!combat) return;

  if (!target.dead && typeof combat.scratchPacket === 'function') {
    const packet = combat.scratchPacket();
    if (packet) {
      const row = BESTIARY[actor.archetypeId];
      const mlvl = actor.level;
      packet.sourceId = actor.id;
      packet.sourceGen = actor.generation;
      packet.sourceSkillId = 'detonate';
      packet.sourceLevel = 0;
      packet.team = actor.team;
      packet.poisonMin = Math.round(row.baseMinDamage * damageMult(mlvl));
      packet.poisonMax = Math.round(row.baseMaxDamage * damageMult(mlvl));
      packet.poisonDuration = POISON_DURATION_S;
      packet.attackRating = 0; // always hits
      packet.attackerLevel = mlvl;
      packet.blockable = false;
      packet.dodgeable = false;
      ctx.events.emit('combat:hit-request', { source: actor, target, packet });
      combat.releasePacket(packet);
    }
  }

  if (!actor.dead && typeof combat.applyDirect === 'function') {
    combat.applyDirect(actor, Math.max(1, actor.life), 'physical', actor.id, 'detonate');
  }
}
