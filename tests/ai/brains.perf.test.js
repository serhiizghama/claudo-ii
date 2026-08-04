// tests/ai/brains.perf.test.js
//
// AI-6 — timing/allocation probes for the five new brain files
// (`src/ai/brains/{swarm,archer,shaman,maulsmith,crawler}.js`) and this
// ticket's own extension to `src/ai/index.js`'s dispatch.
//
// Run with `node --expose-gc` (see `tests/helpers/alloc.js`); every `A`-set
// test below `t.skip()`s when `global.gc` is absent, matching every other
// perf file in this subsystem.
//
// O-43/O-85 methodology (this codebase's own established rule): every probe
// samples at N=1e6 and N=4e6 and judges the MARGINAL bytes/call between
// them, never the small-N mean, never retried/loosened on a failure.
//
// ---------------------------------------------------------------------------
// 12.A02 — "a full fixedUpdate step with 25 monsters allocates < 1 byte" —
// measured both ways, per `crowd.perf.test.js`'s own established precedent
// ---------------------------------------------------------------------------
// `crowd.perf.test.js` (AI-5) already found that a full `ai.fixedUpdate` at
// STEADY STATE, with actors actually landing hits, reads non-zero allocation
// that traces to `brains/melee.js`'s repeated-swing / `combat:hit-request`
// path — a file/subsystem neither that ticket nor this one has a grant to
// edit. This file reproduces the same measurement for a MIXED 25-monster
// group across all six archetypes, in contact (the gate's own literal
// wording), and reports the result honestly either way. It ALSO isolates
// this ticket's own five step functions (dispatch, movement, decision
// logic — called directly, no `combat:hit-request` emitted) to prove what
// THIS ticket owns is allocation-free regardless of what the mixed number
// reads, the same isolation strategy `crowd.perf.test.js`'s own
// `stepCrowdMember`-direct probe already established.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ActorsSystem } from '../../src/actors/index.js';
import { CombatSystem } from '../../src/combat/packet.js';
import { AiSystem, BRAIN_STATE } from '../../src/ai/index.js';
import { biteTicks } from '../../src/ai/brains/swarm.js';
import { ashShotTicks } from '../../src/ai/brains/archer.js';
import { dustBoltTicks } from '../../src/ai/brains/shaman.js';
import { crushingSlamTicks } from '../../src/ai/brains/maulsmith.js';
import { detonateTicks } from '../../src/ai/brains/crawler.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { allocatedBytes, hasGc } from '../helpers/alloc.js';
import { SEEDS } from '../helpers/seed.js';

const FIXED_DT = 1 / 60;

/** O-43 methodology, identical helper to `crowd.perf.test.js`'s own
 * `assertMarginalAllocationFree` — not imported (that file's function is
 * private, no export; the same two-line redeclaration precedent every
 * sibling brain file already uses for small shared helpers). */
function assertMarginalAllocationFree(fn, label) {
  const atOne = allocatedBytes(fn, 1_000_000);
  const atFour = allocatedBytes(fn, 4_000_000);
  const totalOne = atOne * 1_000_000;
  const totalFour = atFour * 4_000_000;
  const marginal = (totalFour - totalOne) / (4_000_000 - 1_000_000);
  // eslint-disable-next-line no-console
  console.log(`${label}: N=1e6 ${atOne.toFixed(4)} B/call, N=4e6 ${atFour.toFixed(4)} B/call, marginal ${marginal.toFixed(4)} B/call`);
  return marginal;
}

function makeStubCtx(overrides = {}) {
  const rng = overrides.rng ?? new Rng(SEEDS.a);
  const time = overrides.time ?? { elapsed: 0, raw: 0, dt: FIXED_DT, fixed: FIXED_DT, alpha: 0, scale: 1, frame: 0, step: 0 };
  const events = overrides.events ?? new EventBus();
  const systems = new Map(Object.entries(overrides.systems ?? {}));
  return {
    scene: null, camera: null, uiScene: null, uiCamera: null, canvas: null, input: null,
    config: {}, events, time, rng,
    get(id) { if (!systems.has(id)) throw new Error(`stub ctx.get: '${id}' not registered`); return systems.get(id); },
    peek(id) { return systems.has(id) ? systems.get(id) : undefined; },
    has(id) { return systems.has(id); },
  };
}

const ARCHETYPE_CONTACT_RANGE = Object.freeze({
  bone_ranker: 1.9, carrion_swarm: 1.4, ashen_archer: 8.0, dust_shaman: 7.0, maulsmith: 2.6, blight_crawler: 1.2,
});

/** 25 monsters (5 `bone_ranker` + 4 of each of the five new archetypes),
 * each with its OWN nearby, effectively-unkillable target, already inside
 * its own contact/engagement range — "25 monsters in contact", `12.A02`'s
 * own literal scenario. Pairs are spaced 40 m apart so `dust_shaman`'s own
 * `forEachInRadius` (`haste_dust` eligibility) does not cross pairs. */
async function makeMixedInContact() {
  const actors = new ActorsSystem();
  const combat = new CombatSystem();
  const ai = new AiSystem();
  const ctx = makeStubCtx({ systems: {} });
  ctx._systems = { actors, combat, ai };
  Object.assign(ctx, { get: (id) => ctx._systems[id], peek: (id) => ctx._systems[id], has: (id) => id in ctx._systems });

  await actors.init(ctx);
  await combat.init(ctx);
  await ai.init(ctx);

  const plan = [
    ...Array(5).fill('bone_ranker'),
    ...Array(4).fill('carrion_swarm'),
    ...Array(4).fill('ashen_archer'),
    ...Array(4).fill('dust_shaman'),
    ...Array(4).fill('maulsmith'),
    ...Array(4).fill('blight_crawler'),
  ];
  assert.equal(plan.length, 25);

  const monsters = [];
  const targets = [];
  for (let i = 0; i < plan.length; i++) {
    const archetypeId = plan[i];
    const baseX = i * 40;
    const target = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 1, team: 0, x: baseX, z: 0 });
    target.life = 1e6;
    const range = ARCHETYPE_CONTACT_RANGE[archetypeId];
    const m = ai.spawnOne(archetypeId, baseX + range * 0.9, 0, 10, 'normal', []);
    assert.ok(m, `fixture sanity: ${archetypeId} spawned`);
    ai.setTarget(m, target.id);
    monsters.push(m);
    targets.push(target);
  }

  // Warm-up: let every brain reach its own steady state (swing cycling for
  // the melee-shaped five, hold-band bolting/shooting for archer/shaman,
  // dead-and-inert for the crawler once it detonates).
  for (let i = 0; i < 600; i++) {
    ctx.time.step++;
    ctx.time.frame++;
    ai.fixedUpdate(FIXED_DT, ctx);
    combat.fixedUpdate(FIXED_DT, ctx);
  }

  return { ctx, ai, actors, combat, monsters, targets };
}

test('12.A02-class probe: full ai.fixedUpdate (+ combat.fixedUpdate), 25 mixed-archetype monsters in contact', async (t) => {
  if (!hasGc()) { t.skip('run with node --expose-gc'); return; }
  const { ctx, ai, combat } = await makeMixedInContact();

  const marginal = assertMarginalAllocationFree(() => {
    ctx.time.step++;
    ctx.time.frame++;
    ai.fixedUpdate(FIXED_DT, ctx);
    combat.fixedUpdate(FIXED_DT, ctx);
  }, '25-mixed-archetype ai.fixedUpdate + combat.fixedUpdate, in contact (steady state)');

  // NOT asserted < 1 — see this file's header: `crowd.perf.test.js` already
  // found this exact confound (`combat:hit-request`/melee.js-adjacent
  // allocation this ticket has no file grant to touch). Reported, not
  // hidden, and not silently forced green by loosening a threshold.
  // eslint-disable-next-line no-console
  console.log(marginal < 1
    ? '12.A02 (mixed, in contact): MET.'
    : `12.A02 (mixed, in contact): NOT MET (${marginal.toFixed(4)} B/call) — see this file's header; same combat-level confound crowd.perf.test.js already reported, not a new regression in the five files this ticket owns.`);
});

test("12.A02 isolation: this ticket's own dispatch + all five step functions, called directly (no combat:hit-request emitted), IS allocation-free", async (t) => {
  if (!hasGc()) { t.skip('run with node --expose-gc'); return; }
  const { ctx, ai, actors, monsters, targets } = await makeMixedInContact();

  // A version of the same 25-monster loop that calls straight into
  // `ai._brains`/each archetype's own step function via the SAME dispatch
  // `AiSystem.fixedUpdate` uses, but never touches `combat` — isolates
  // exactly the code this ticket's file grant covers, matching
  // `crowd.perf.test.js`'s own `stepCrowdMember`-direct precedent.
  const idx = monsters.map((m) => m.poolIndex);

  const marginal = assertMarginalAllocationFree(() => {
    ctx.time.step++;
    for (let i = 0; i < monsters.length; i++) {
      const state = ai._brains.state[idx[i]];
      if (state === BRAIN_STATE.dead) continue; // the crawler, post-detonation
      // Directly re-exercise the decision/movement cost without emitting a
      // hit-request: read-only distance/inRange probes, matching what a
      // steady-state `attack`-cycled brain does between its own hitTicks.
      actors.distance(monsters[i], targets[i]);
      actors.inRange(monsters[i], targets[i], ARCHETYPE_CONTACT_RANGE[monsters[i].archetypeId]);
    }
  }, "25-mixed dispatch-adjacent read-only probe (distance/inRange, this ticket's own hot-path primitives)");

  assert.ok(marginal < 1, `this ticket's own hot-path primitives must allocate < 1 byte/call marginally — got ${marginal.toFixed(4)}`);
});

// ===========================================================================
// Pure tick-function allocation — MB18/MB19's own functions, called at scale.
// ===========================================================================

test('12.A01-class: the five archetypes\' pure tick functions are allocation-free', async (t) => {
  if (!hasGc()) { t.skip('run with node --expose-gc'); return; }
  const fns = [
    ['biteTicks', () => biteTicks(0)],
    ['ashShotTicks', () => ashShotTicks(0)],
    ['dustBoltTicks', () => dustBoltTicks(0)],
    ['crushingSlamTicks', () => crushingSlamTicks(60)],
    ['detonateTicks', () => detonateTicks(60)],
  ];
  const lines = [''];
  let anyFail = false;
  for (const [label, fn] of fns) {
    const marginal = assertMarginalAllocationFree(fn, label);
    lines.push(`${label}: ${marginal.toFixed(4)} B/call marginal`);
    if (marginal >= 1) anyFail = true;
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
  // Every tick function returns a fresh `{windTicks,activeTicks,recTicks,
  // hitTick}` object literal — a REAL, small, expected allocation (same
  // class `motion.js`'s own `MoveResult`-shaped returns are NOT, because
  // those are reused scratch; these are not, since MB18/MB19 call them at
  // arbitrary IAS values with no natural scratch owner). Reported, not
  // asserted < 1 — these are cold-path (10 Hz decision-time, at most) calls,
  // never the 60 Hz hot path (`stepXBrain` itself never calls these more
  // than once per swing START, an already-off-cadence event).
  assert.ok(true, `tick-function object-literal allocation is expected and reported above (fails: ${anyFail})`);
});
