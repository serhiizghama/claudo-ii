// tests/actors/actr22.test.js
//
// ACTR-22/D-52/O-57 acceptance tests: the seven remaining "Stats and
// vessels" (`02-api-contracts.md` §7) methods — `addLife`, `addMana`,
// `addRage`, `addResonance`, `spend`, `canAfford`, `lifeFraction` — wired
// as thin forwards on `ActorsSystem` over the already-accepted pure engines
// in `src/actors/vessels.js` (ACTR-8). `node:test` + `node:assert/strict`
// only, matching every sibling file in this directory.
//
// Scope: the wiring only. `vessels.js`'s own numeric behaviour (fractional
// carry, decay, the `03-combat-math.md` §2.4 rates) is ACTR-8's own gate
// (tests/actors/vessels.test.js) and is not re-tested here except as much
// as a scenario needs the forwarded method to actually do something real.
//
// Every test below reaches the seven methods via a live, registry-resolved
// `ctx.get('actors')` (this ticket's own acceptance criterion) — never
// `new ActorsSystem()` used directly as the surface under test, and never a
// monkey-patched instance (that is exactly the bug this ticket closes —
// see the report) — because that is how `combat`/`skills`/`player` will
// actually reach them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { DETERMINISTIC_SEED } from '../helpers/seed.js';

// ---------------------------------------------------------------------------
// A real registry-resolved ctx — same wiring src/main.js does, and the same
// helper tests/actors/actr15.test.js already established for this file's
// sibling ticket.
// ---------------------------------------------------------------------------

async function makeRegistryCtx() {
  const events = new EventBus();
  const registry = new Registry();
  const ctx = {
    scene: null,
    camera: null,
    uiScene: null,
    uiCamera: null,
    canvas: null,
    config: {},
    events,
    input: null,
    time: { elapsed: 0, raw: 0, dt: 0, fixed: 1 / 60, alpha: 0, scale: 1, frame: 0, step: 0 },
    rng: new Rng(DETERMINISTIC_SEED),
    get: registry.get.bind(registry),
    peek: registry.peek.bind(registry),
    has: registry.has.bind(registry),
  };
  registry.add(PhysicsSystem);
  registry.add(ActorsSystem);
  await registry.init(ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// 1. addLife / addMana / addRage / addResonance — clamp to [0, max], return
//    the actual delta applied (never the requested amount verbatim once a
//    clamp bites).
// ---------------------------------------------------------------------------

test('actors.addLife(actor, amount, sourceId) adds, clamps to maxLife, and returns the actual delta', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  // A bare 'monster' actor's maxLife floors at CAPS' lo=1 (stats.js), which
  // would make the clamp barely meaningful; a real player class gives a
  // real pool to clamp against.
  const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 10 });
  const maxLife = actors.stats(actor).maxLife;
  assert.ok(maxLife > 10, 'ravager must have a real maxLife pool for this test to be meaningful');

  actor.life = maxLife - 5;
  const delta = actors.addLife(actor, 100, 0); // sourceId accepted, not read (vessels.js's own contract)
  assert.equal(delta, 5, 'addLife must return the ACTUAL amount applied, clamped, not the requested 100');
  assert.equal(actor.life, maxLife, 'actor.life must clamp to maxLife');
});

test('actors.addMana(actor, amount) adds and clamps to maxMana', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  // A bare 'monster' actor has no CLASS_TABLE row (ZERO_CLASS -> baseMana 0),
  // so maxMana would be 0 and every clamp would trivially hold; a real
  // player class (ravager, baseMana 10) actually exercises the add.
  const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 1 });
  const maxMana = actors.stats(actor).maxMana;

  actor.mana = 0;
  const delta = actors.addMana(actor, 3);
  assert.equal(delta, 3);
  assert.equal(actor.mana, 3);

  const overflowDelta = actors.addMana(actor, maxMana + 999);
  assert.equal(actor.mana, maxMana);
  assert.equal(overflowDelta, maxMana - 3);
});

test('actors.addRage(actor, amount) adds and clamps to maxRage', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  // ZERO_CLASS (a bare 'monster') has baseRage 0, which would make this
  // clamp trivial; ravager's baseRage 100 (03 §2.4) actually exercises it.
  const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 1 });
  const maxRage = actors.stats(actor).maxRage;
  assert.ok(maxRage > 0, 'ravager must have a nonzero maxRage for this test to be meaningful');

  assert.equal(actor.rage, 0, 'a freshly spawned actor starts with 0 rage');
  const delta = actors.addRage(actor, maxRage + 50);
  assert.equal(delta, maxRage);
  assert.equal(actor.rage, maxRage);
});

test('actors.addResonance(actor, amount) adds and clamps to maxResonance', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  // ZERO_CLASS has baseResonance 0; runeblade's baseResonance 3 (03 §2.4)
  // actually exercises the clamp.
  const actor = actors.spawn({ kind: 'player', archetypeId: 'runeblade', level: 1 });
  const maxResonance = actors.stats(actor).maxResonance;
  assert.ok(maxResonance > 0, 'runeblade must have a nonzero maxResonance for this test to be meaningful');

  const delta = actors.addResonance(actor, maxResonance + 10);
  assert.equal(delta, maxResonance);
  assert.equal(actor.resonance, maxResonance);
});

// ---------------------------------------------------------------------------
// 2. canAfford / spend — the resource gate, atomic, fails safe on an
//    unrecognised resource string.
// ---------------------------------------------------------------------------

test('actors.canAfford(actor, resource, amount) reads without mutating', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });
  actor.mana = 10;

  assert.equal(actors.canAfford(actor, 'mana', 10), true);
  assert.equal(actors.canAfford(actor, 'mana', 11), false);
  assert.equal(actor.mana, 10, 'canAfford must never mutate');
  assert.equal(actors.canAfford(actor, 'not_a_resource', 0), false, 'an unrecognised resource must fail safe, not read an arbitrary field');
});

test('actors.spend(actor, resource, amount) is atomic: false and no mutation if short', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });
  actor.mana = 5;

  assert.equal(actors.spend(actor, 'mana', 10), false, 'spend must fail when short');
  assert.equal(actor.mana, 5, 'a failed spend must not mutate the resource at all');

  assert.equal(actors.spend(actor, 'mana', 5), true);
  assert.equal(actor.mana, 0);
});

test("actors.spend(actor, resource, 'all') spends floor(actor[resource]) and fails below 1 — blade_seal's own contract (03 §2.4)", async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });

  actor.resonance = 2.7;
  assert.equal(actors.spend(actor, 'resonance', 'all'), true);
  assert.ok(Math.abs(actor.resonance - 0.7) < 1e-9, `expected the fractional remainder 0.7 to survive, got ${actor.resonance}`);

  actor.resonance = 0.9;
  assert.equal(actors.spend(actor, 'resonance', 'all'), false, "'all' must fail below 1, per vessels.js#spend's own contract");
  assert.equal(actor.resonance, 0.9, 'a failed \'all\' spend must not mutate');
});

// ---------------------------------------------------------------------------
// 3. lifeFraction — 0..1.
// ---------------------------------------------------------------------------

test('actors.lifeFraction(actor) reads life/maxLife, clamped 0..1', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });
  const maxLife = actors.stats(actor).maxLife;

  actor.life = maxLife / 2;
  assert.ok(Math.abs(actors.lifeFraction(actor) - 0.5) < 1e-9);

  actor.life = 0;
  assert.equal(actors.lifeFraction(actor), 0);

  actor.life = maxLife;
  assert.equal(actors.lifeFraction(actor), 1);
});

// ---------------------------------------------------------------------------
// 4. Two actors never cross-contaminate — every forward targets only the
//    actor passed in.
// ---------------------------------------------------------------------------

test('the seven forwards affect only the targeted actor', async () => {
  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const a = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 10 });
  const b = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 10 });

  actors.addLife(a, -1000, 0);
  actors.addMana(a, 1000);
  actors.addRage(a, 1000);
  actors.addResonance(a, 1000);

  assert.equal(a.rage, actors.stats(a).maxRage);
  assert.equal(b.rage, 0, 'forwards on a must not touch b');
  assert.equal(b.resonance, 0, 'forwards on a must not touch b');
});
