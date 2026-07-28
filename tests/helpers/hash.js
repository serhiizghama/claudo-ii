// tests/helpers/hash.js
//
// TEST-1 — the state hash: a stable FNV-1a over a canonical projection of
// the world, exactly as specified in docs/spec/12-testing.md §7
// ("Determinism testing" / the state hash), which is itself the test-side
// half of docs/ARCHITECTURE.md's "Determinism contract". `12.D04`–`12.D07`
// (600-step replay, per-stream draw counters, three substep schedules) all
// compare two of these hashes for equality.
//
// Scope note (read this before touching the field lists below): the
// `actors` and `items` subsystems do not exist yet — ACTR-1 is the next
// ticket, `items` is an M3-milestone subsystem. §7's actor/item field
// lists are honoured here in full, but `hashState()` takes plain arrays of
// actor-shaped / item-shaped objects rather than reaching into a live
// `ctx` for `ctx.get('actors')`/`ctx.get('items')` (which would throw —
// neither id is registered today, and reaching into a registry at all
// would bind this file to a runtime that doesn't exist). Both arrays
// default to empty. When ACTR-1 and `items` land, their owners assemble
// the arrays this function already knows how to hash — nothing here needs
// to change for that to work, which is the point.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

/** The standard FNV-1a 32-bit constants (Fowler/Noll/Vo). */
const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

/**
 * FNV-1a over a JS string, treated byte-by-byte via `charCodeAt` (every
 * character this file ever feeds it is ASCII — numbers, punctuation, field
 * names — so there is no multi-byte encoding question to get wrong).
 * 32-bit: §7 says "a stable FNV-1a" without naming a width, and 32 bits is
 * the FNV default and enough headroom for what this is used for — a
 * same-process equality check between two runs of the same seed, not a
 * cross-run content-addressed store, so a 1-in-4-billion false-equal on a
 * genuinely different state is not a real risk. `hashState`'s return type
 * (a plain uint32 number) is the whole public contract; widening to 64-bit
 * later (via BigInt) would not need to change any call site that just
 * compares two return values with `===`.
 * @param {string} str
 * @returns {number} a uint32.
 */
export function fnv1a32(str) {
  let hash = FNV_OFFSET_BASIS_32;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0;
  }
  return hash >>> 0;
}

// --- The canonical projection ---------------------------------------------
//
// These three arrays are the *entire* mechanism that keeps presentation
// state out of the hash. `projectActor`/`projectItem`/`projectRngStream`
// below only ever read the named fields off whatever object they're
// given — never `JSON.stringify(actor)`, never `Object.entries`, never a
// spread. So a real Actor record (ACTR-1's, per `01-data-model.md` §2)
// that also carries a mesh reference, an animation mixer, a render-side
// interpolation buffer, or anything else no one has invented yet, cannot
// reach this hash by accident: there is no code path that reads a field
// this list doesn't name. That is what "excluded by construction" means
// here, as opposed to "excluded because nobody has added it yet".
//
// `secondary` vs. `rage`/`resonance`/`stamina`: `12-testing.md` §7 names a
// `secondary` slot to hash. `01-data-model.md` §2's Actor record has no
// field literally called that — `secondary: 'rage' | 'resonance' | null`
// (§2.3) lives on the *class archetype* record, not on Actor, and it is a
// string naming which resource is "the" secondary one for that class,
// constant for the whole run. Hashing that string would tell a
// determinism check nothing and would silently hide a real divergence in
// the resource it names. The Actor record's own resource fields are
// numeric (§2): `rage`, `resonance`, `stamina`. This hashes all three
// numeric values instead of the one archetype string — a projection with
// no actor-class knowledge hashing all of a class's possible secondary
// slots is strictly safer than guessing which one is "active", and a
// class without a given resource just holds it at 0, which is itself a
// stable, hashable value.
const ACTOR_FIELDS = ['id', 'x', 'z', 'life', 'mana', 'rage', 'resonance', 'stamina', 'state', 'actionSeq'];
const ITEM_FIELDS = ['uid', 'x', 'z'];
const RNG_FIELDS = ['s0', 's1', 's2', 's3'];

function projectActor(actor) {
  return ACTOR_FIELDS.map((f) => `${f}=${actor[f]}`).join(',');
}

function projectItem(item) {
  return ITEM_FIELDS.map((f) => `${f}=${item[f]}`).join(',');
}

// `stream` is anything exposing public `s0..s3` — a real `src/core/rng.js`
// `Rng` instance qualifies as-is (those are plain instance fields, not
// hidden behind a getter), and so does a plain `{s0,s1,s2,s3}` snapshot
// object, which is what makes this usable both against a live subsystem
// fork and against a recorded/replayed state.
function projectRngStream(name, stream) {
  return `${name}:${RNG_FIELDS.map((f) => `${f}=${stream[f]}`).join(',')}`;
}

/**
 * The state hash. A stable FNV-1a over a canonical projection of the
 * world: every actor's `id, x, z, life, mana, rage, resonance, stamina,
 * state, actionSeq` (the numeric resource fields standing in for §7's
 * `secondary` slot — see `ACTOR_FIELDS` above for why), every ground
 * item's `uid, x, z`, the RNG position of each named stream, and
 * `ctx.time.step` — `12-testing.md` §7's field list.
 *
 * Traversal order is canonicalized, never "as given": `actors` is sorted
 * by `id`, `items` by `uid`, and RNG stream names are sorted
 * lexicographically, before any of them are read — two worlds that differ
 * only in which order their actors happen to sit in an array (insertion
 * order, pool reuse order, iteration order of a `Map`, ...) hash
 * identically, as they must for a *state* hash. Every array is copied
 * before sorting (`.slice()`) — this function never mutates what it's
 * given.
 *
 * `ctx.time.step` is the only clock field this function (or anything it
 * calls) ever reads. `frame`, `alpha`, `dt`, `elapsed`, `raw` and `scale`
 * are presentation/interpolation state per `ARCHITECTURE.md`'s `ctx.time`
 * documentation and are structurally absent from this function's
 * signature — there is no parameter they could be passed through even by
 * mistake.
 *
 * @param {object} world
 * @param {Array<object>} [world.actors] - actor-shaped objects; each must
 *   carry the eight `ACTOR_FIELDS` above. Defaults to `[]` — correct
 *   behaviour today, since no `actors` subsystem exists yet.
 * @param {Array<object>} [world.items] - ground-item-shaped objects; each
 *   must carry the three `ITEM_FIELDS` above. Defaults to `[]`.
 * @param {Record<string, {s0:number,s1:number,s2:number,s3:number}>} [world.rngStreams]
 *   - a map of stream name -> RNG state (an `Rng` instance or a
 *   `{s0,s1,s2,s3}` snapshot). Defaults to `{}`. Name each stream after
 *   the subsystem that owns it (`ARCHITECTURE.md`'s "one fork per
 *   subsystem" rule), e.g. `{ world: worldRng, items: itemsRng }`.
 * @param {number} world.step - `ctx.time.step`. Required; the fixed-step
 *   simulation clock, not the render frame.
 * @returns {number} a uint32 hash.
 */
export function hashState({ actors = [], items = [], rngStreams = {}, step } = {}) {
  if (typeof step !== 'number' || !Number.isInteger(step)) {
    throw new TypeError('hashState: world.step (ctx.time.step) is required and must be an integer');
  }

  const actorLines = actors
    .slice()
    .sort((a, b) => a.id - b.id)
    .map(projectActor);

  const itemLines = items
    .slice()
    .sort((a, b) => a.uid - b.uid)
    .map(projectItem);

  const streamNames = Object.keys(rngStreams).sort();
  const streamLines = streamNames.map((name) => projectRngStream(name, rngStreams[name]));

  const canonical = [
    `step=${step}`,
    `actors[${actorLines.length}]:${actorLines.join(';')}`,
    `items[${itemLines.length}]:${itemLines.join(';')}`,
    `rng[${streamLines.length}]:${streamLines.join(';')}`,
  ].join('|');

  return fnv1a32(canonical);
}

/**
 * Convenience wrapper: pulls `step` off a real `ctx.time.step` so call
 * sites holding an actual `ctx` don't have to unpack it by hand. This is
 * also where the "presentation is structurally excluded" guarantee is
 * easiest to see: `ctx.time.frame`/`.alpha`/`.dt` are right there on the
 * same object and this function still never touches them, because
 * `hashState` never gave it a parameter to put them in.
 * @param {{time: {step: number}}} ctx
 * @param {{actors?: object[], items?: object[], rngStreams?: object}} [world]
 * @returns {number}
 */
export function hashStateFromCtx(ctx, { actors = [], items = [], rngStreams = {} } = {}) {
  return hashState({ actors, items, rngStreams, step: ctx.time.step });
}

/**
 * Same value as `hashState`, formatted as a fixed-width 8-hex-digit
 * string — for failure output (`12-testing.md` §12's `expected=/actual=`
 * lines read better as hex than as a signed/unsigned decimal uint32) and
 * for fixture files.
 * @param {Parameters<typeof hashState>[0]} world
 * @returns {string}
 */
export function hashStateHex(world) {
  return hashState(world).toString(16).padStart(8, '0');
}
