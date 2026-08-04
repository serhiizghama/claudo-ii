// tests/ai/brains.test.js
//
// AI-6 acceptance tests for `src/ai/brains/{swarm,archer,shaman,maulsmith,
// crawler}.js` + `src/ai/index.js`'s dispatch wiring — the remaining five
// archetypes of `06-monsters-ai.md` §2.2-2.6 / §3.4-3.8.
//
// Four sections, each named after the acceptance criterion it proves:
//   MB18 — every archetype's hitTick at IAS 0 against §2's printed columns.
//   MB19 — the Maulsmith/Crawler floors, proven at the extreme IAS the
//          affix/tier tables can produce (60, `swift`'s own +60 — see
//          `docs/spec/06-monsters-ai.md` §6.1: `swift` is the ONLY affix
//          that grants monster IAS, and no difficulty tier grants any; both
//          transcribed independently while writing this file).
//   SCENARIO — one real, live `AiSystem.fixedUpdate` scenario per
//          archetype: spawned by hand (`ai.setTarget`, same M2 precedent
//          `tests/ai/melee.test.js` already established), walks, attacks,
//          deals real damage through the real `combat` pipeline. This is
//          the "prove the brain is alive" half `12-testing.md`'s own rule
//          demands — "a brain that never attacks has an infinite TTK and
//          fails loudly, but a brain that attacks the wrong thing can land
//          inside the band by accident."
//   MB2  — TTK per archetype per reference build, against `06` §2.7's own
//          printed bands. Computed as EV arithmetic (life / DPS, the exact
//          numbers `06` §2.7 itself prints — see that section's own text:
//          "using the same per-landed-hit figures... and the same
//          intervals" as `03-combat-math.md` §11.2's calibration), the same
//          "transcribe from spec text, do not re-derive the mitigation
//          pipeline a second time" precedent `tools/balance.mjs`'s own
//          header sets for `05-skills.md`'s S/B rows. This is deliberately
//          NOT a live simulation against a reconstructed Ravager/
//          Emberwright/Runeblade fixture (their exact gear/attribute kits
//          live in `tools/balance.mjs#CLASS_KITS`, a file this ticket does
//          not own and should not fork) — the SCENARIO section above is
//          what proves the brain itself is real; this section proves the
//          bestiary numbers it fights on top of land inside the printed
//          band. Both are reported, never conflated.
//
// Node-safe: `node:test` + `node:assert/strict` only, no `three`, no DOM.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ActorsSystem } from '../../src/actors/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { CombatSystem } from '../../src/combat/packet.js';
import { composeStats } from '../../src/actors/stats.js';
import { AiSystem, BRAIN_STATE } from '../../src/ai/index.js';
import { BESTIARY, lifeMult } from '../../src/ai/data/bestiary.js';
import { registerPack, addPackMember } from '../../src/ai/perception.js';
import { biteTicks, BITE_CYCLE_TICKS } from '../../src/ai/brains/swarm.js';
import { ashShotTicks, ASH_SHOT_CYCLE_TICKS } from '../../src/ai/brains/archer.js';
import { dustBoltTicks, raiseRankerTicks, hasteDustTicks, DUST_BOLT_CYCLE_TICKS } from '../../src/ai/brains/shaman.js';
import { crushingSlamTicks } from '../../src/ai/brains/maulsmith.js';
import { detonateTicks } from '../../src/ai/brains/crawler.js';
import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';

const FIXED_DT = 1 / 60;

function makeCtx() {
  const systems = new Map();
  return {
    config: {},
    events: new EventBus(),
    time: { elapsed: 0, raw: 0, dt: FIXED_DT, fixed: FIXED_DT, alpha: 0, scale: 1, frame: 0, step: 0 },
    rng: new Rng(0xa6b6a1e6),
    get(id) { if (!systems.has(id)) throw new Error(`stub ctx.get: '${id}' not registered`); return systems.get(id); },
    peek(id) { return systems.get(id); },
    has(id) { return systems.has(id); },
    _systems: systems,
  };
}

async function makeWorld() {
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
  return { ctx, actors, combat, ai };
}

function spawnPlayer(actors, x, z, vitality = 20) {
  const p = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 10, team: 0, x, z });
  Object.assign(p.attributes, { strength: 0, dexterity: 0, vitality, energy: 0 });
  composeStats(p);
  p.life = p.stats.maxLife;
  return p;
}

function step(ctx, ai, combat) {
  ctx.time.step++;
  ctx.time.frame++;
  ai.fixedUpdate(FIXED_DT, ctx);
  combat.fixedUpdate(FIXED_DT, ctx);
}

// ===========================================================================
// MB18 — hitTick at IAS 0 against §2's printed tick columns.
// ===========================================================================

test('MB18: every archetype hitTick at IAS 0 matches 06 §2\'s printed tick columns exactly', () => {
  const rows = [
    ['carrion_swarm attack', biteTicks(0), [13, 4, 16]],
    ['ashen_archer ash_shot', ashShotTicks(0), [40, 2, 24]],
    ['dust_shaman dust_bolt', dustBoltTicks(0), [30, 4, 25]],
    ['dust_shaman raise_ranker', raiseRankerTicks(0), [63, 6, 33]],
    ['dust_shaman haste_dust', hasteDustTicks(0), [33, 5, 24]],
    ['maulsmith crushing_slam', crushingSlamTicks(0), [72, 8, 51]],
    ['blight_crawler detonate', detonateTicks(0), [51, 3, 0]],
  ];

  const lines = ['', 'archetype/action        | computed W/S/R | spec W/S/R | hitTick'];
  for (const [name, ticks, expected] of rows) {
    const [ew, es, er] = expected;
    lines.push(`${name.padEnd(24)} | ${ticks.windTicks}/${ticks.activeTicks}/${ticks.recTicks}`.padEnd(60) + `| ${ew}/${es}/${er} | ${ticks.hitTick}`);
    assert.equal(ticks.windTicks, ew, `${name}: windTicks`);
    assert.equal(ticks.activeTicks, es, `${name}: activeTicks`);
    assert.equal(ticks.recTicks, er, `${name}: recTicks`);
    assert.equal(ticks.hitTick, ew, `${name}: hitTick === tick0 + windTicks (tick0=0)`);
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
});

// ===========================================================================
// MB19 — the Maulsmith's wind-up floor (0.90 s) and the Crawler's fuse floor
// (0.85 s), at the extreme IAS the affix/tier tables can produce.
// ===========================================================================

test('MB19: maulsmith wind-up floor and crawler fuse floor hold at the extreme IAS (60, `swift`) — and beyond', () => {
  // `06` §6.1's affix table: `swift` is the ONLY monster affix granting
  // `increasedAttackSpeed` (+60), and §11 grants no IAS at any difficulty
  // tier — independently re-checked (`grep -n "increasedAttackSpeed"
  // docs/spec/06-monsters-ai.md`) while writing this test. 60 is therefore
  // the real ceiling; 1000 is tested alongside it purely to demonstrate the
  // floor is a structural property of the formula, not a value that merely
  // happens to hold at 60.
  const EXTREME_IAS = 60;
  const lines = [''];

  for (const ias of [0, EXTREME_IAS, 1000]) {
    const slam = crushingSlamTicks(ias);
    const windSeconds = slam.windTicks / 60;
    lines.push(`maulsmith crushing_slam @ IAS ${ias}: windTicks=${slam.windTicks} (${windSeconds.toFixed(4)}s) activeTicks=${slam.activeTicks} recTicks=${slam.recTicks}`);
    assert.ok(windSeconds >= 0.90 - 1e-9, `maulsmith wind-up must never fall below 0.90s (got ${windSeconds}s @ IAS ${ias})`);

    const fuse = detonateTicks(ias);
    const fuseSeconds = fuse.windTicks / 60;
    lines.push(`blight_crawler detonate @ IAS ${ias}: windTicks=${fuse.windTicks} (${fuseSeconds.toFixed(4)}s) — IAS scaling: none, ever`);
    assert.ok(fuseSeconds >= 0.85 - 1e-9, `crawler fuse must never fall below 0.85s (got ${fuseSeconds}s @ IAS ${ias})`);
    assert.equal(fuse.windTicks, 51, 'crawler fuse is a fixed 51 ticks regardless of IAS — the floor holds because IAS never reaches the formula at all');
  }

  // The swift-affix worked example, §2.5's own arithmetic, cross-checked:
  // "1.20 x 0.625 = 0.75s -> floored to 0.90s".
  const swift = crushingSlamTicks(EXTREME_IAS);
  assert.equal(swift.windTicks, 54, '0.90s floored, in ticks (round(0.90*60))');
  lines.push(`\nExtreme IAS used: ${EXTREME_IAS} (the 'swift' affix, 06 §6.1 — the only monster IAS source; no difficulty tier grants any)`);
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
});

// ===========================================================================
// SCENARIO — one live fixedUpdate run per archetype: proves the brain
// actually walks/attacks/deals damage, not just that its tick math is right.
// ===========================================================================

test('SCENARIO carrion_swarm: bites on schedule and deals damage', async () => {
  const { ctx, actors, combat, ai } = await makeWorld();
  const player = spawnPlayer(actors, 0, 0);
  const swarm = ai.spawnOne('carrion_swarm', 6, 0, 10, 'normal', []);
  assert.ok(swarm, 'fixture sanity: swarm spawned');
  ai.setTarget(swarm, player.id);
  assert.equal(ai.brainOf(swarm).state, 'chase');

  const hits = [];
  ctx.events.on('combat:hit-request', ({ source }) => { if (source === swarm) hits.push(ctx.time.step); });
  let damage = 0;
  ctx.events.on('actor:damage', (p) => { if (p.target === player) damage += p.result.total; });

  const startDist = actors.distance(swarm, player);
  for (let i = 0; i < 600 && !player.dead; i++) step(ctx, ai, combat);
  const midDist = actors.distance(swarm, player);

  assert.ok(midDist < startDist, `WALKS: distance decreased (${startDist.toFixed(2)} -> ${midDist.toFixed(2)})`);
  assert.ok(hits.length > 0, 'ATTACKS: at least one bite hit-request');
  for (let k = 1; k < hits.length; k++) assert.equal(hits[k] - hits[k - 1], BITE_CYCLE_TICKS, 'SWINGS ON SCHEDULE');
  assert.ok(damage > 0, `DEALS DAMAGE: player took ${damage.toFixed(2)}`);
  // eslint-disable-next-line no-console
  console.log(`\ncarrion_swarm: ${hits.length} bites landed, ${damage.toFixed(2)} damage dealt over ${ctx.time.step} steps (${(ctx.time.step / 60).toFixed(2)}s)`);
});

test('SCENARIO carrion_swarm: scatters (flee) once a pack drops below 40% alive, and resumes chase after 3.0 s', async () => {
  const { ctx, actors, combat, ai } = await makeWorld();
  const player = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 10, team: 0, x: 0, z: 0 });

  const PACK_ID = 501;
  const members = [];
  for (let i = 0; i < 5; i++) {
    const m = ai.spawnOne('carrion_swarm', 6, i * 0.5, 10, 'normal', []);
    assert.ok(m, 'fixture sanity: pack member spawned');
    ai.setTarget(m, player.id);
    members.push(m);
  }
  registerPack(ai._perception, PACK_ID, 6, 1, 8.0);
  for (const m of members) assert.equal(addPackMember(ai._perception, PACK_ID, m), true);

  // Kill 3 of 5 (60% dead, alive 2/5 = 40% — strictly below the 0.40
  // threshold requires < 0.40, so kill a 4th to be unambiguous: 1/5 = 20%).
  for (let i = 0; i < 4; i++) {
    combat.applyDirect(members[i], 999, 'physical', player.id, 'player_attack');
  }
  assert.equal(members[4].dead, false, 'fixture sanity: the survivor is still alive');
  assert.equal(ai.brainOf(members[4]).state, 'flee', 'C2: the survivor scattered — alive/count = 1/5 = 20% < 40%');

  const fleeStartDist = actors.distance(members[4], player);
  step(ctx, ai, combat);
  const fleeDist = actors.distance(members[4], player);
  assert.ok(fleeDist > fleeStartDist || Math.abs(fleeDist - fleeStartDist) > 0, 'fleeing member actually moved');

  // C3: now >= fleeUntilStep (180 ticks after the scatter) returns to chase.
  for (let i = 0; i < 200 && ai.brainOf(members[4]).state === 'flee'; i++) step(ctx, ai, combat);
  assert.equal(ai.brainOf(members[4]).state, 'chase', 'C3: flee -> chase once fleeUntilStep elapses');
});

test('SCENARIO ashen_archer: retreats when close, approaches when far, holds and fires in the 6-14 m band', async () => {
  const { ctx, actors, combat, ai } = await makeWorld();

  // Approach band.
  {
    const player = spawnPlayer(actors, 0, 0);
    const archer = ai.spawnOne('ashen_archer', 20, 0, 10, 'normal', []);
    ai.setTarget(archer, player.id);
    const d0 = actors.distance(archer, player);
    for (let i = 0; i < 300; i++) step(ctx, ai, combat);
    const d1 = actors.distance(archer, player);
    assert.ok(d1 < d0, `APPROACH: distance decreased (${d0.toFixed(2)} -> ${d1.toFixed(2)})`);
  }

  // Retreat band.
  {
    const player = spawnPlayer(actors, 0, 40);
    const archer = ai.spawnOne('ashen_archer', 2, 40, 10, 'normal', []);
    ai.setTarget(archer, player.id);
    const d0 = actors.distance(archer, player);
    for (let i = 0; i < 60; i++) step(ctx, ai, combat);
    const d1 = actors.distance(archer, player);
    assert.ok(d1 > d0, `RETREAT: distance increased when starting inside 6m (${d0.toFixed(2)} -> ${d1.toFixed(2)})`);
  }

  // Hold band — fires.
  {
    const player = spawnPlayer(actors, 0, 80);
    const archer = ai.spawnOne('ashen_archer', 8, 80, 10, 'normal', []);
    ai.setTarget(archer, player.id);
    const hits = [];
    ctx.events.on('combat:hit-request', ({ source }) => { if (source === archer) hits.push(ctx.time.step); });
    let damage = 0;
    ctx.events.on('actor:damage', (p) => { if (p.target === player) damage += p.result.total; });
    for (let i = 0; i < 400; i++) step(ctx, ai, combat);
    assert.ok(hits.length > 0, 'HOLD: at least one ash_shot fired');
    for (let k = 1; k < hits.length; k++) assert.equal(hits[k] - hits[k - 1], ASH_SHOT_CYCLE_TICKS, 'SWINGS ON SCHEDULE');
    assert.ok(damage > 0, `DEALS DAMAGE: ${damage.toFixed(2)}`);
    // eslint-disable-next-line no-console
    console.log(`\nashen_archer: ${hits.length} shots landed, ${damage.toFixed(2)} damage dealt (hold band, no physics registered => LOS assumed true)`);
  }
});

test('SCENARIO dust_shaman: chases from range, holds and bolts in band, backs away when close, and casts haste_dust on nearby allies', async () => {
  const { ctx, actors, combat, ai } = await makeWorld();

  // Chase.
  {
    const player = spawnPlayer(actors, 0, 0);
    const shaman = ai.spawnOne('dust_shaman', 20, 0, 10, 'normal', []);
    ai.setTarget(shaman, player.id);
    const d0 = actors.distance(shaman, player);
    for (let i = 0; i < 200; i++) step(ctx, ai, combat);
    assert.ok(actors.distance(shaman, player) < d0, 'CHASE: distance decreased from 20m');
  }

  // Hold band — dust_bolt.
  {
    const player = spawnPlayer(actors, 0, 40);
    const shaman = ai.spawnOne('dust_shaman', 7, 40, 10, 'normal', []);
    ai.setTarget(shaman, player.id);
    const hits = [];
    ctx.events.on('combat:hit-request', ({ source }) => { if (source === shaman) hits.push(ctx.time.step); });
    let damage = 0;
    ctx.events.on('actor:damage', (p) => { if (p.target === player) damage += p.result.total; });
    for (let i = 0; i < 400; i++) step(ctx, ai, combat);
    assert.ok(hits.length > 0, 'HOLD: at least one dust_bolt fired');
    for (let k = 1; k < hits.length; k++) assert.equal(hits[k] - hits[k - 1], DUST_BOLT_CYCLE_TICKS, 'SWINGS ON SCHEDULE');
    assert.ok(damage > 0, `DEALS DAMAGE: ${damage.toFixed(2)}`);
    // eslint-disable-next-line no-console
    console.log(`\ndust_shaman: ${hits.length} bolts landed, ${damage.toFixed(2)} damage dealt`);
  }

  // Back away.
  {
    const player = spawnPlayer(actors, 0, 80);
    const shaman = ai.spawnOne('dust_shaman', 2, 80, 10, 'normal', []);
    ai.setTarget(shaman, player.id);
    const d0 = actors.distance(shaman, player);
    for (let i = 0; i < 60; i++) step(ctx, ai, combat);
    assert.ok(actors.distance(shaman, player) > d0, 'BACK AWAY: distance increased when starting inside 6m');
  }

  // haste_dust — real cast, real buff grant on nearby allies (O-87: the
  // movement-speed half has real effect on every archetype but bone_ranker).
  {
    const player = spawnPlayer(actors, 0, 120);
    const shaman = ai.spawnOne('dust_shaman', 7, 120, 10, 'normal', []);
    ai.setTarget(shaman, player.id);
    const allies = [
      ai.spawnOne('carrion_swarm', 6, 121, 10, 'normal', []),
      ai.spawnOne('carrion_swarm', 8, 121, 10, 'normal', []),
      ai.spawnOne('carrion_swarm', 7, 122, 10, 'normal', []),
    ];
    for (const a of allies) assert.ok(a, 'fixture sanity: ally spawned');
    let hasted = 0;
    for (let i = 0; i < 800 && hasted === 0; i++) {
      step(ctx, ai, combat);
      hasted = allies.filter((a) => ai._hasteStore.hasteUntilStep[a.poolIndex] >= ctx.time.step).length;
    }
    assert.ok(hasted >= 3, `HASTE_DUST: at least 3 nearby monster allies carry the buff (got ${hasted})`);

    // raise_ranker: the guard holds — no live `actors.resurrectableCorpses`
    // this milestone (see brains/shaman.js's own header) — reviveCredits
    // must still read 1 (never spent) after a long run.
    for (let i = 0; i < 200; i++) step(ctx, ai, combat);
    assert.equal(ai._shamanStore.reviveCredits[shaman.poolIndex], 1, 'O-87/09-gap: raise_ranker never fires — actors.resurrectableCorpses does not exist yet');
    assert.equal(typeof actors.resurrectableCorpses, 'undefined', 'confirms the guard\'s precondition: ActorsSystem does not forward resurrectableCorpses this milestone');
  }
});

test('SCENARIO maulsmith: commits to the slam (zero re-decision mid-wind-up) and lands a 220% hit', async () => {
  const { ctx, actors, combat, ai } = await makeWorld();
  const player = spawnPlayer(actors, 0, 0, 60); // extra vitality — a landed slam at mlvl10 is large
  const maulsmith = ai.spawnOne('maulsmith', 2.5, 0, 10, 'normal', []);
  assert.ok(maulsmith, 'fixture sanity: maulsmith spawned');
  ai.setTarget(maulsmith, player.id);

  let hitStep = null;
  let hitTotal = 0;
  ctx.events.on('combat:hit-request', ({ source }) => { if (source === maulsmith && hitStep === null) hitStep = ctx.time.step; });
  ctx.events.on('actor:damage', (p) => { if (p.target === player) hitTotal += p.result.total; });

  // Drive to the swing start, then watch the committed window: position and
  // facing must not move at all (S6 already satisfied; no re-decision, no
  // re-aim per §3.4/§3.5).
  let sawSwingStart = false;
  let frozenX = null;
  let frozenZ = null;
  let violated = false;
  for (let i = 0; i < 300; i++) {
    step(ctx, ai, combat);
    const swinging = ai._brains.swingActive[maulsmith.poolIndex] === 1;
    if (swinging && !sawSwingStart) { sawSwingStart = true; frozenX = maulsmith.x; frozenZ = maulsmith.z; }
    else if (swinging && sawSwingStart) {
      if (maulsmith.x !== frozenX || maulsmith.z !== frozenZ) violated = true;
    }
    if (hitStep !== null) break;
  }

  assert.ok(sawSwingStart, 'the slam actually started');
  assert.ok(!violated, 'COMMITTED: position never moved during the wind-up/active/recovery window');
  assert.ok(hitStep !== null, 'ATTACKS: crushing_slam landed a hit-request');
  assert.ok(hitTotal > 0, `DEALS DAMAGE: ${hitTotal.toFixed(2)} (220% of row damage)`);

  const row = BESTIARY.maulsmith;
  const mMult = 1 + 0.2200 * (10 - 1) + 0.00750 * (10 - 1) ** 2; // damageMult(10), transcribed independently
  const expectedMin = Math.round(row.baseMinDamage * 2.20 * mMult);
  assert.ok(hitTotal >= expectedMin * 0.05, 'sanity: landed damage is on the order of the 220% row minimum (post-mitigation, not asserting exact post-DEF total)');
  // eslint-disable-next-line no-console
  console.log(`\nmaulsmith: 1 slam landed at step ${hitStep}, ${hitTotal.toFixed(2)} damage dealt, wind-up never interrupted`);
});

test('SCENARIO blight_crawler: T1 lights the fuse in range, detonates once, and dies from its own blast', async () => {
  const { ctx, actors, combat, ai } = await makeWorld();
  const player = spawnPlayer(actors, 0, 0, 60);
  const crawler = ai.spawnOne('blight_crawler', 1.0, 0, 10, 'normal', []);
  assert.ok(crawler, 'fixture sanity: crawler spawned');
  ai.setTarget(crawler, player.id);

  let hitTotal = 0;
  let hits = 0;
  ctx.events.on('combat:hit-request', ({ source, target }) => { if (source === crawler && target === player) hits++; });
  ctx.events.on('actor:damage', (p) => { if (p.target === player) hitTotal += p.result.total; });
  let crawlerDied = null;
  ctx.events.on('actor:death', (p) => { if (p.actor === crawler) crawlerDied = { killer: p.killer }; });

  for (let i = 0; i < 200 && crawlerDied === null; i++) step(ctx, ai, combat);

  assert.equal(hits, 1, 'ATTACKS: exactly one detonation packet emitted');
  assert.ok(hitTotal > 0, `DEALS DAMAGE (poison): ${hitTotal.toFixed(2)}`);
  assert.ok(crawlerDied !== null, 'the Crawler dies from its own detonation');
  assert.equal(crawler.dead, true);
  // eslint-disable-next-line no-console
  console.log(`\nblight_crawler: 1 detonation, ${hitTotal.toFixed(2)} poison damage dealt, crawler self-destructed`);
});

test('blight_crawler T4: 25.0 s of chase without reaching T1 lights the fuse anyway', async () => {
  const { ctx, actors, combat, ai } = await makeWorld();
  // Player far enough that one decision tick cannot close to T1 (1.2 m).
  const player = spawnPlayer(actors, 0, 0);
  const crawler = ai.spawnOne('blight_crawler', 50, 0, 10, 'normal', []);
  ai.setTarget(crawler, player.id);

  const idx = crawler.poolIndex;
  // Force T4's clock: as if 25.0 s (1500 ticks) already elapsed in chase.
  // `chaseEnteredStep` must stay non-negative (< 0 is the "unset" sentinel
  // `stepCrawlerBrain` itself re-stamps on sight — see that function's own
  // first line), so this jumps `ctx.time.step` forward instead of pushing
  // `chaseEnteredStep` negative.
  ctx.time.step = 2000;
  ai._crawlerStore.chaseEnteredStep[idx] = 2000 - 1500;
  ai.fixedUpdate(FIXED_DT, ctx);
  assert.equal(ai.brainOf(crawler).state, 'attack', 'T4 fired: the fuse lit despite being nowhere near T1 range');
  assert.equal(ai._brains.swingActive[idx], 1);
});

// ===========================================================================
// MB2 — TTK per archetype per reference build, `06` §2.7's own bands.
// EV arithmetic, transcribed independently from §2.7's printed table (see
// this file's header for why this is not a live three-fixture simulation).
// ===========================================================================

const MLVL = 10;

// life at mlvl10, cross-checked against §2.2-2.6's own printed tables while
// writing this file.
const LIFE_AT_10 = Object.freeze({
  carrion_swarm: 40, ashen_archer: 66, dust_shaman: 75, maulsmith: 185, blight_crawler: 53,
});

// `06` §2.7's own table, transcribed verbatim: { dps, ttk, band }.
const MB2_TABLE = Object.freeze({
  carrion_swarm: {
    ravager: { dps: 42.19, ttk: 0.95 }, emberwright: { dps: 47.73, ttk: 0.84 }, runeblade: { dps: 47.27, ttk: 0.85 },
    band: [0.5, 1.5],
  },
  ashen_archer: {
    ravager: { dps: 41.01, ttk: 1.61 }, emberwright: { dps: 35.80, ttk: 1.84 }, runeblade: { dps: 45.98, ttk: 1.44 },
    band: [1.2, 3.0],
  },
  dust_shaman: {
    ravager: { dps: 40.59, ttk: 1.85 }, emberwright: { dps: 35.80, ttk: 2.09 }, runeblade: { dps: 40.39, ttk: 1.86 },
    band: [1.5, 3.2],
  },
  maulsmith: {
    ravager: { dps: 30.23, ttk: 6.12 }, emberwright: { dps: 47.73, ttk: 3.88 }, runeblade: { dps: 41.15, ttk: 4.50 },
    band: [3.5, 7.5],
  },
  blight_crawler: {
    ravager: { dps: 43.28, ttk: 1.22 }, emberwright: { dps: 47.73, ttk: 1.11 }, runeblade: { dps: 48.46, ttk: 1.09 },
    band: [0.7, 1.8],
  },
});

test('MB2: TTK per archetype per reference build lands inside 06 §2.7\'s band (bone_ranker itself is AI-2\'s own, unchanged, gate)', () => {
  const lines = [''];
  for (const [archId, row] of Object.entries(MB2_TABLE)) {
    const life = Math.round(BESTIARY[archId].baseLife * lifeMult(MLVL));
    assert.equal(life, LIFE_AT_10[archId], `${archId}: bestiary life at mlvl10 matches 06 §2's own printed table`);
    for (const build of ['ravager', 'emberwright', 'runeblade']) {
      const { dps, ttk } = row[build];
      const computedTtk = life / dps; // the exact arithmetic 06 §2.7's own TTK column is
      const [lo, hi] = row.band;
      lines.push(`${archId.padEnd(15)} vs ${build.padEnd(11)}: life=${life} dps=${dps} -> TTK=${computedTtk.toFixed(2)}s (spec prints ${ttk}s) band=[${lo},${hi}]`);
      assert.ok(Math.abs(computedTtk - ttk) < 0.02, `${archId}/${build}: life/dps reproduces the spec's own printed TTK to within rounding`);
      assert.ok(computedTtk >= lo && computedTtk <= hi, `${archId}/${build}: TTK ${computedTtk.toFixed(2)}s inside band [${lo},${hi}]`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
});

// ===========================================================================
// O-105 — the swarm.js avoidance nudge has a real, measurable effect when
// `physics` is registered (with it absent, every other test above already
// proves the straight-line fallback still works).
// ===========================================================================

test('O-105: two carrion_swarm members forced to overlap separate over time when physics.overlapCircle is live', async () => {
  const ctx = makeCtx();
  const physics = new PhysicsSystem();
  await physics.init(ctx);
  physics.rebuild();
  ctx._systems.set('physics', physics);
  const actors = new ActorsSystem();
  await actors.init(ctx);
  ctx._systems.set('actors', actors);
  const combat = new CombatSystem();
  await combat.init(ctx);
  ctx._systems.set('combat', combat);
  const ai = new AiSystem();
  await ai.init(ctx);
  ctx._systems.set('ai', ai);

  const target = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 10, team: 0, x: 0, z: 100 });
  target.life = 1e6;

  // Two members spawned on top of each other (both well outside bite range
  // of the distant target, so both stay in `chase`, both steering at the
  // exact same point every step — the worst case for interpenetration).
  const a = ai.spawnOne('carrion_swarm', 0, 0, 10, 'normal', []);
  const b = ai.spawnOne('carrion_swarm', 0.05, 0, 10, 'normal', []);
  assert.ok(a && b, 'fixture sanity: both members spawned');
  ai.setTarget(a, target.id);
  ai.setTarget(b, target.id);

  const startSep = actors.distance(a, b);
  for (let i = 0; i < 30; i++) step(ctx, ai, combat);
  const endSep = actors.distance(a, b);

  // eslint-disable-next-line no-console
  console.log(`\nO-105 nudge: two overlapping carrion_swarm members, separation ${startSep.toFixed(4)}m -> ${endSep.toFixed(4)}m over 30 steps (physics.overlapCircle live, no physics.separate() called)`);
  assert.ok(endSep > startSep, `the avoidance nudge increased separation between two forced-overlapping members (${startSep.toFixed(4)}m -> ${endSep.toFixed(4)}m)`);
});
