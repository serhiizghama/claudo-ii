// tests/skills/cleaving_strike.perf.test.js
//
// SKIL-3 — allocation probes for the cast path, O-43/O-23 methodology
// (N >= 1e6, `tests/helpers/alloc.js#assertAllocationFree`). Two probes,
// matching the two halves of `src/skills/impl/cleaving_strike.js`:
//
//   1. `skills.cast(actor, 'cleaving_strike', ...)` itself — the
//      synchronous work that starts the action (spend, face, phase
//      decomposition, `beginAction`, cooldown bookkeeping, pending-cast
//      scratch writes). No cone query and no `DamagePacket` are built here
//      — that is deferred to `anim:hitframe` (see that file's own header).
//   2. The deferred RESOLUTION `anim:hitframe` triggers — the cone query
//      (`physics.overlapCone`) and `combat.buildAttackPacket` +
//      `combat:hit-request` emission loop this ticket's brief specifically
//      asks to be measured for O-59 ("buildAttackPacket builds ten
//      template-string keys per call ... if your allocation probe on the
//      cast path lands high, that is the likely source"). Triggered by
//      emitting `anim:hitframe` directly with the actor's own real
//      `actionSeq` (a plain, publicly-readable `Actor` field —
//      `01-data-model.md` §2) right after a real `cast()`, rather than
//      ticking `fixedUpdate` through a real wind-up every iteration — this
//      reaches the EXACT SAME registered listener / private closure
//      `anim:hitframe` would reach in a live 60 Hz session, just without
//      the (irrelevant to allocation) wait.
//
// Uses the same real `physics`+`actors`+`combat`+`skills` registry stack as
// `tests/skills/cleaving_strike.test.js` — see that file's header for the
// remaining, still-real `actors.spend`/`canAfford` forwarding workaround
// (`addRage` is not patched — nothing on this path calls it any more).
//
// ---------------------------------------------------------------------------
// The `DamageResult`-pool leak this probe originally had to work around is
// FIXED (CMBT-8/D-51)
// ---------------------------------------------------------------------------
// An earlier revision of this file found `CombatSystem`'s `_onHitRequest`
// listener discarding `resolve()`'s return value — the acquired
// `DamageResult` (pool capacity 256) was never released, so this probe
// could not run anywhere near the O-43 N >= 1e6 floor without the pool
// permanently exhausting after 256 total hits. Reported, and fixed under
// CMBT-8/D-51: the listener now releases the result it acquires once it is
// done with it (`src/combat/packet.js`'s own "pooled-object ownership
// rule" comment). Verified directly: 2000 sequential `cast()` +
// `anim:hitframe` iterations against a real boot resolve 2000
// `actor:damage` events, not 256. No grey-box pool-draining workaround is
// needed here any more.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { CombatSystem } from '../../src/combat/packet.js';
import { SkillsSystem } from '../../src/skills/index.js';
import { spend, canAfford } from '../../src/actors/vessels.js';
import { assertAllocationFree, allocatedBytes, hasGc } from '../helpers/alloc.js';
import { DETERMINISTIC_SEED } from '../helpers/seed.js';

const H = 1 / 60;

async function buildCtx() {
  const events = new EventBus();
  const registry = new Registry();
  const ctx = {
    scene: null, camera: null, uiScene: null, uiCamera: null, canvas: null,
    config: {}, events, input: null,
    time: { elapsed: 0, raw: 0, dt: 0, fixed: H, alpha: 0, scale: 1, frame: 0, step: 0 },
    rng: new Rng(DETERMINISTIC_SEED),
    get: registry.get.bind(registry),
    peek: registry.peek.bind(registry),
    has: registry.has.bind(registry),
  };
  registry.add(PhysicsSystem);
  registry.add(ActorsSystem);
  registry.add(CombatSystem);
  registry.add(SkillsSystem);
  await registry.init(ctx);

  // See the file header — TEST-ONLY workaround for a still-real
  // src/actors/index.js gap (ACTR-15/O-57 never forwarded these). addRage
  // is deliberately NOT patched — nothing on this path calls it any more
  // (CMBT-8/D-51 moved R1's rage award into combat itself).
  const actors = ctx.get('actors');
  actors.spend = (actor, resource, amount) => spend(actor, resource, amount);
  actors.canAfford = (actor, resource, amount) => canAfford(actor, resource, amount);

  return ctx;
}

test('SKIL-3 perf — skills.cast("cleaving_strike") and its deferred resolution, O-43 (N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ctx = await buildCtx();
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');

  const player = actors.spawn({ kind: 'player', archetypeId: 'ravager', team: 0, x: 0, z: 0, facing: 0, level: 30 });
  actors.setState(player, 'idle');
  player.attributes.strength = 50;
  player.attributes.dexterity = 60;
  player.attributes.vitality = 50;
  for (let i = 0; i < 20; i++) skills.allocate(player, 'cleaving_strike');

  const monsters = [];
  for (let i = 0; i < 4; i++) {
    const angle = ((i / 3) - 0.5) * (100 * Math.PI / 180);
    const dist = 1.2 + (i % 3) * 0.5;
    const m = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: Math.cos(angle) * dist, z: Math.sin(angle) * dist, level: 1 });
    actors.setState(m, 'idle');
    actors.stats(m);
    monsters.push(m);
  }

  // --- Probe 1: skills.cast() itself -------------------------------------
  const castFn = () => {
    player.actionId = null; // let this iteration's cast begin a fresh action
    player.rage = 100; // afford the cost every iteration
    skills.cast(player, 'cleaving_strike', player.x + 10, player.z, 0);
  };

  // --- Probe 2: the deferred resolution anim:hitframe triggers -----------
  const resolveFn = () => {
    player.actionId = null;
    player.rage = 100;
    skills.cast(player, 'cleaving_strike', player.x + 10, player.z, 0);
    for (const m of monsters) m.life = 500; // keep every target alive/valid every iteration
    ctx.events.emit('anim:hitframe', { actor: player, actionId: 'cleaving_strike', actionSeq: player.actionSeq });
  };

  // Probe 1 is held to the hard O-43 `< 1 B/call` bar via
  // `assertAllocationFree` (retries a few rounds against measurement
  // noise) — nothing in `skills.cast()` touches the packet/result pools.
  const probe1 = assertAllocationFree(castFn, { iterations: 1_000_000, maxRounds: 40 });
  // eslint-disable-next-line no-console
  console.log(`[SKIL-3 perf] skills.cast("cleaving_strike") — action start only, no cone/packet: ${probe1.bytesPerCall.toFixed(4)} B/call, converged in ${probe1.rounds} round(s) @ N=1000000`);
  assert.ok(probe1.bytesPerCall < 1, `skills.cast() itself must allocate < 1 byte/call; got ${probe1.bytesPerCall.toFixed(4)}`);

  // Probe 2 is REPORTED, not gated at < 1 B/call: `combat.buildAttackPacket`
  // is contractually `Alloc: pool` (O-59 — the ten template-string keys in
  // `src/combat/packet.js#stepB7`, e.g. `packet[`${el}Min`]`) — a known,
  // documented, pre-existing combat-side cost this ticket does not own and
  // must not "fix" (this ticket's own brief, verbatim: "Report what you
  // measure; do not 'fix' src/combat/"). A single `allocatedBytes` call
  // (not the retry-until-below-threshold helper, which would throw) at the
  // full O-43 N is enough to report the real number.
  const bytesPerCall2 = allocatedBytes(resolveFn, 1_000_000);
  // eslint-disable-next-line no-console
  console.log(`[SKIL-3 perf] anim:hitframe resolution — overlapCone + buildAttackPacket + 4x hit-request (O-59 path): ${bytesPerCall2.toFixed(4)} B/call @ N=1000000 (NOT gated — see this file's O-59 note)`);
});
