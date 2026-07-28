// tests/helpers/actor.js
//
// TEST-1 — a minimal stub actor + stub `ctx` builder, for the tests that
// need a live `ctx` before a real one exists. `12-testing.md` §4.1: "A test
// file that needs a live `ctx` builds a stub from `tests/helpers/`, never a
// real engine."
//
// Scope: the `actors` subsystem does not exist yet (ACTR-1 is the next
// ticket) and this file does not attempt to anticipate its shape. The stub
// actor below carries exactly the ten fields `tests/helpers/hash.js` needs
// per `12-testing.md` §7 — nothing more. The *full* Actor record is
// `01-data-model.md` §2's, and ACTR-1 owns it; do not extend
// `STUB_ACTOR_FIELDS` speculatively to "look more real" — a field added
// here that ACTR-1 doesn't end up shipping is a field every test using
// this stub silently depends on.
//
// Resolved: `12-testing.md` §7 names a `secondary` slot to hash, but
// `01-data-model.md` §2's Actor record has no field literally called that.
// `secondary: 'rage' | 'resonance' | null` (§2.3, line 415) lives on the
// *class archetype* record, not on Actor, and it is a string naming which
// resource is "the" secondary one for that class — constant for the whole
// run, so hashing it would tell a determinism check nothing and would
// silently hide a real divergence in the resource it names. The Actor
// record's own resource fields (§2 lines 286–288) are numeric: `rage`,
// `resonance`, `stamina`. This stub hashes all three numeric fields rather
// than the one archetype string, and hashes all three regardless of class
// (a helper with no actor-class knowledge hashing all of a class's
// possible secondary slots is strictly safer than guessing which one is
// "active"; a class without a given resource just holds it at 0, which is
// itself a stable, hashable value). `stamina` is included even though
// `config.stamina` currently defaults to `false` (`BACKLOG.md`, a
// Post-M9 feature) — it's an inert 0 today and needs no future edit here
// once that flag flips.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';
import { DETERMINISTIC_SEED } from './seed.js';

/** The exact field set `tests/helpers/hash.js` hashes per §7. Exported so a
 * test can assert "this stub carries what the hash needs" without
 * duplicating the literal list. */
export const STUB_ACTOR_FIELDS = Object.freeze([
  'id', 'x', 'z', 'life', 'mana', 'rage', 'resonance', 'stamina', 'state', 'actionSeq',
]);

let nextStubActorId = 1;

/**
 * A fresh stub actor. Every field `hash.js` needs is present with a sane
 * default; pass `overrides` to set only what a given test cares about.
 *
 * `id` auto-increments per call (starting at 1) so that a test building
 * several stub actors in a row gets distinct, hash-sortable ids without
 * having to invent them — call `resetStubActorIds()` in a test that needs
 * its ids to start from a known value (e.g. to keep a literal expected-hash
 * assertion stable across unrelated test-file changes).
 *
 * @param {Partial<Record<'id'|'x'|'z'|'life'|'mana'|'rage'|'resonance'|'stamina'|'state'|'actionSeq', any>>} [overrides]
 * @returns {{id:number,x:number,z:number,life:number,mana:number,rage:number,resonance:number,stamina:number,state:string,actionSeq:number}}
 */
export function makeStubActor(overrides = {}) {
  return {
    id: nextStubActorId++,
    x: 0,
    z: 0,
    life: 100,
    mana: 100,
    rage: 0,
    resonance: 0,
    stamina: 0,
    state: 'idle',
    actionSeq: 0,
    ...overrides,
  };
}

/**
 * Resets the auto-increment counter `makeStubActor` uses for `id`. Node
 * runs each test *file* in its own process but shares module state across
 * `test()` blocks within one file — call this in a file that builds many
 * stub actors across several tests and wants ids to start from a known
 * value in each one.
 * @param {number} [start]
 */
export function resetStubActorIds(start = 1) {
  nextStubActorId = start;
}

/**
 * A fresh stub ground item — the three fields `hash.js` needs per §7
 * (`uid, x, z`). `items` (the subsystem) is an M3-milestone concern; this
 * is deliberately just as thin as `makeStubActor`.
 * @param {Partial<Record<'uid'|'x'|'z', any>>} [overrides]
 * @returns {{uid:number,x:number,z:number}}
 */
let nextStubItemUid = 1;
export function makeStubGroundItem(overrides = {}) {
  return {
    uid: nextStubItemUid++,
    x: 0,
    z: 0,
    ...overrides,
  };
}

/** @param {number} [start] */
export function resetStubItemUids(start = 1) {
  nextStubItemUid = start;
}

/**
 * A stub `ctx.time`, matching the eight-field shape `ARCHITECTURE.md` and
 * `src/core/engine.js` (CORE-2) define: `{ elapsed, raw, dt, fixed, alpha,
 * scale, frame, step }`. All zeroed/at-rest by default except `dt`/`fixed`,
 * which default to one real fixed step (`1/60`) so a test that plugs this
 * straight into a `fixedUpdate(h, ctx)` call gets a plausible `h`.
 * @param {Partial<{elapsed:number,raw:number,dt:number,fixed:number,alpha:number,scale:number,frame:number,step:number}>} [overrides]
 */
export function makeStubTime(overrides = {}) {
  return {
    elapsed: 0,
    raw: 0,
    dt: 1 / 60,
    fixed: 1 / 60,
    alpha: 0,
    scale: 1,
    frame: 0,
    step: 0,
    ...overrides,
  };
}

/**
 * A stub `ctx`. Carries every key `docs/ARCHITECTURE.md`'s "Subsystem
 * interface" section promises on `ctx`, so a test that destructures a
 * field off the returned object never hits a silent `undefined` it wasn't
 * expecting — but only `rng`, `time`, `events`, `config`, and the
 * `get`/`peek`/`has` trio are ever *real*. `scene`, `camera`, `uiScene`,
 * `uiCamera`, `canvas` and `input` are `null` unless overridden: building
 * real ones needs `three`/DOM (`render`'s and CORE-7's own domains, with
 * their own tests), and `12-testing.md` §2's N/B boundary means gameplay
 * unit tests should never need them to be real.
 *
 * `get`/`peek`/`has` mirror `src/core/registry.js`'s (CORE-3) contract —
 * `get` throws on a missing/unready id, `peek`/`has` never throw — against
 * a plain `Map` the test populates via `overrides.systems: { id: instance
 * }`. There is no init-order machinery here (no `resolve()`, no topo
 * sort): everything passed in `systems` is "ready" immediately, because a
 * stub ctx exists to give a unit test *a* live-shaped ctx, not to
 * re-implement subsystem boot.
 *
 * @param {object} [overrides]
 * @param {Rng} [overrides.rng] - defaults to `new Rng(DETERMINISTIC_SEED)`.
 * @param {object} [overrides.time] - defaults to `makeStubTime()`.
 * @param {EventBus} [overrides.events] - defaults to a fresh `EventBus`
 *   (Node-safe, cheap — no reason to default this to `null`).
 * @param {object} [overrides.config] - defaults to `{}`.
 * @param {Record<string, object>} [overrides.systems] - id -> instance,
 *   backing `get`/`peek`/`has`. Defaults to `{}` (no subsystem is ready).
 * @returns {object} a stub `ctx`.
 */
export function makeStubCtx(overrides = {}) {
  const rng = overrides.rng ?? new Rng(DETERMINISTIC_SEED);
  const time = overrides.time ?? makeStubTime();
  const events = overrides.events ?? new EventBus();
  const config = overrides.config ?? {};
  const systems = new Map(Object.entries(overrides.systems ?? {}));

  return {
    scene: overrides.scene ?? null,
    camera: overrides.camera ?? null,
    uiScene: overrides.uiScene ?? null,
    uiCamera: overrides.uiCamera ?? null,
    canvas: overrides.canvas ?? null,
    input: overrides.input ?? null,
    config,
    events,
    time,
    rng,
    get(id) {
      if (!systems.has(id)) {
        throw new Error(`stub ctx.get: '${id}' is not in this stub's systems map`);
      }
      return systems.get(id);
    },
    peek(id) {
      return systems.has(id) ? systems.get(id) : undefined;
    },
    has(id) {
      return systems.has(id);
    },
  };
}
