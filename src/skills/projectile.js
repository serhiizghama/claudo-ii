// src/skills/projectile.js
//
// SKIL-4 — the `Projectile` pool (`01-data-model.md:1691`) and its flight
// simulation: `spawnProjectile`/`killProjectile`/`projectileCount`
// (`02-api-contracts.md` §10), driven every fixed step from
// `SkillsSystem#fixedUpdate` (`./index.js`). `ember_bolt` (`./impl/bolt.js`)
// is this ticket's only spawner — `rune_strike` is explicitly NOT a
// projectile (D-43, `05-skills.md:979`: "a landed melee hit like any other").
//
// Node-safe: no `three`, no DOM/browser global, no `performance.now()`
// anywhere in this file (`tools/check-imports.mjs` sweeps `src/skills/` with
// `checkGlobals: true`). No `Math.random()` — flight is a deterministic
// straight-line sweep against `physics`, drawing no randomness of its own.
//
// ---------------------------------------------------------------------------
// D-47 — the pool size, and the "refuse vs. evict" tension, resolved
// ---------------------------------------------------------------------------
// `01-data-model.md:1691` is the only place the number lives: `Projectile |
// skills | 128 / 256 / 384 / 512 | oldest projectile expires early`. The four
// values below are that row, LOD-tiered exactly like `src/actors/index.js`'s
// own `POOL_CAPACITY` (same table shape, same "largest preset, not an
// arbitrary round number" fallback for a config-less test `ctx` — see that
// file's own comment on `DEFAULT_POOL_CAPACITY`, mirrored here as
// `DEFAULT_PROJECTILE_POOL_CAPACITY`). `config.q` itself carries no
// `projectileBudget` field (`src/core/config.js`'s `QUALITY_PRESETS` has no
// such key, and that file is not in this ticket's file list to add one to) —
// so, like `src/combat/packet.js`'s own `CLASS_SCALE_TABLE` gap-3, this file
// keys its OWN small table off `ctx.config.quality` (the preset NAME string,
// which config.js does expose) rather than off a `ctx.config.q.*` budget
// field that does not exist. Flagged in this ticket's report as the same
// class of gap `packet.js` already established a precedent for.
//
// The actual tension: `01`'s own overflow policy for this row says "oldest
// projectile expires early" (an EVICT policy); `02-api-contracts.md` §10's
// own prose ("the pool cap is what keeps a Runeblade `unity` burst from
// allocating") and this ticket's own acceptance criterion #3 ("refuses
// rather than allocates when full") both describe a REFUSE policy instead.
// The two are not simultaneously "evict AND refuse" for the SAME call —
// eviction, by construction, always makes room and therefore never returns
// `0`; refusal, by construction, never evicts a live projectile to make
// room. This file implements **REFUSE**: `spawnProjectile` returns `0` and
// leaves every existing projectile untouched once the pool is dry. Three
// independent reasons, not just "the criterion said so":
//   1. The criterion is the literal, checkable bar this ticket is graded
//      against ("spawnProjectile returns 0 and projectileCount never exceeds
//      the cap") — an eviction policy cannot produce that observable
//      behaviour (a spawn past capacity would still succeed, just at another
//      slot's expense).
//   2. `02-api-contracts.md`'s own stated REASON for the cap ("what keeps a
//      Runeblade `unity` burst from allocating") is about bounding
//      ALLOCATION, not about bounding the number of SIMULTANEOUSLY VISIBLE
//      bolts — an eviction policy still lets `unity` "allocate" (spawn)
//      without limit, it just silently deletes older bolts to pay for it,
//      which does not read as "the cap is what keeps it from allocating".
//   3. `spawnProjectile`'s own contracted return type, `int id | 0`
//      (`02-api-contracts.md` §10), only makes sense as written if `0` is a
//      real, reachable outcome — an eviction-only pool would never need it.
// `01`'s "oldest expires early" language is recorded here, not applied — the
// same "disagreements are recorded, not applied" discipline `05-skills.md`
// §1.1 states for its own relationship to `03-combat-math.md`. A future
// ticket that wants graceful degradation (evict-then-serve, trading a
// least-important bolt for a new one) can still build it on top of this
// pool's `release()`/`acquire()` primitives without changing this file's own
// contracted behaviour — nothing here forecloses that.
//
// ---------------------------------------------------------------------------
// Flight — a bounded per-step sweep chain against `physics.sweepProjectile`
// ---------------------------------------------------------------------------
// `physics.sweepProjectile(x,z,dx,dz,radius,mask,excludeId,out) => Hit`
// (PHYS-5, accepted, `src/physics/sweep.js`) is a SINGLE swept test against
// both static geometry and dynamic bodies for one displacement vector, with
// exactly ONE `excludeId`. Pierce ("passes through and re-resolves on every
// actor along its path, once each" — `05-skills.md:1129`) needs to keep
// sweeping PAST an already-hit body for the REMAINDER of the same step's
// displacement, which one `excludeId` alone cannot express once more than
// one body has already been hit in the same step (a rare but real case —
// two body circles closer together than the projectile's own per-step
// travel distance). This file resolves it with two complementary
// mechanisms, not one:
//   - `excludeId` is always set to the MOST RECENTLY hit actor for the
//     CONTINUATION sweep within the same step — the cheap, common-case fix
//     (physics's own dynamic-body loop skips that actor's slot entirely, no
//     re-detection at t=0).
//   - A small, fixed-capacity per-projectile "already hit" list
//     (`PIERCE_HIT_CAPACITY` slots, `hitActorIds`/`hitCounts` below) is the
//     AUTHORITATIVE guard: every detected actor hit is checked against it
//     BEFORE any damage is credited, regardless of what `excludeId` was
//     passed. A hit against an actor already in the list is treated as a
//     transparent pass-through (advance the origin, re-exclude, keep
//     sweeping) — never a second credit. This is what makes "each body
//     exactly once" hold structurally rather than by the excludeId
//     coincidence alone. The owner's own `actorId` is seeded into the list
//     at spawn (`spawnProjectile`, below) so the bolt can never damage its
//     own caster, using the exact same mechanism as pierce rather than a
//     second, parallel exclusion path.
// The loop is bounded (`MAX_SWEEP_ITERATIONS`) purely as a defensive
// safety valve — the remaining displacement strictly shrinks every
// iteration (physics reports the hit point on the current sub-segment,
// never behind the sweep origin), so it terminates on any sane geometry;
// the bound exists only so a pathological data case degrades to "stop
// early" rather than an infinite loop.
//
// A hit against `STATIC_LAYER` (`hit.actorId === 0` with `hit.hit === true`
// on a mask that includes the static bit) ends the flight immediately, no
// damage — a projectile does not pierce walls.
//
// ---------------------------------------------------------------------------
// Damage — `combat.buildSpellPacket`, then this SKILL's own packet riders
// ---------------------------------------------------------------------------
// `combat.buildSpellPacket(source, skillId, level)` is `combat`'s own,
// already-accepted pipeline (CMBT-1) — this file never computes a damage
// number itself (`02-api-contracts.md` §10's own "Forbidden for callers:
// never compute a skill's damage"). What IS this skill's own, per
// `05-skills.md`'s `ember_bolt` `DamagePacket` row ("B8 riders |
// `attackRating = 0` -> always hits (03 §5.1, R2 skipped). `dodgeable
// false`, `blockable false`"), is layered on top of the built packet via the
// `alwaysHits` flag on the spawn spec — the same "mutate the packet's own
// rider fields after `combat.build*Packet()` returns it" technique
// `impl/rune_strike.js` uses for its own `manaReturnPercent` doubling. This
// is skill-specific packet customisation done in THIS file (owned), never an
// edit to `src/combat/`.
//
// ---------------------------------------------------------------------------
// Zero-allocation discipline
// ---------------------------------------------------------------------------
// Every per-slot field below is a typed array (or, for the two string-valued
// fields `skillId`/`element`, a plain `Array` of INTERNED STRING REFERENCES
// set once per spawn — no string is ever constructed here, only assigned
// from a caller-supplied literal, so this does not violate the "no
// allocation in the hot path" rule the same way a fixed-size numeric array
// does not). `fixedUpdate`'s sweep loop reuses one `Hit`-shaped scratch
// object (`_hitScratch`) and one `combat:hit-request` payload scratch
// (`_hitRequestPayload`) across every projectile and every iteration — never
// constructed per call. `array.length = 0` is never used on a pooled array.
// No `Map` anywhere. `Math.hypot` is never used (`Math.sqrt(x*x+z*z)` only).

/** `01-data-model.md:1691`, the four LOD tiers verbatim. Gameplay/engine
 * NUMBER, not logic — kept as a flat frozen table per `ARCHITECTURE.md` rule
 * 9, the same "table lives here since this ticket has no `data/` file for
 * it" reasoning `src/actors/index.js`'s own `POOL_CAPACITY` comment gives
 * for the identical situation. */
export const PROJECTILE_POOL_SIZE_BY_QUALITY = Object.freeze({
  low: 128, medium: 256, high: 384, ultra: 512,
});

/** Fallback for a config-less `ctx` (a bare test stub) — the LARGEST defined
 * tier, not an arbitrary round number, mirroring `src/actors/index.js`'s own
 * `DEFAULT_POOL_CAPACITY` choice and its stated reasoning exactly. */
export const DEFAULT_PROJECTILE_POOL_CAPACITY = PROJECTILE_POOL_SIZE_BY_QUALITY.ultra;

/** Resolves a pool capacity from `ctx.config.quality` — see the file header,
 * D-47.
 * @param {object} ctx
 * @returns {number}
 */
export function projectilePoolCapacityFor(ctx) {
  const quality = ctx && ctx.config && ctx.config.quality;
  return PROJECTILE_POOL_SIZE_BY_QUALITY[quality] ?? DEFAULT_PROJECTILE_POOL_CAPACITY;
}

/** Per-projectile "already resolved against this actor" list capacity — see
 * the file header. `05-skills.md` §1.5's own pack-occupancy table gives
 * pierce exactly 3 bodies for its reference pack; this is generous headroom
 * above that (plus the owner's own seeded slot), the same "comfortably above
 * the documented ceiling" style `src/skills/impl/cleaving_strike.js`'s own
 * `MAX_CONE_TARGETS` comment uses against its own reference figure. */
const PIERCE_HIT_CAPACITY = 8;

/** Safety valve on the per-step sweep-continuation loop — see the file
 * header. Never expected to bind on real geometry (the remaining
 * displacement strictly shrinks every iteration); it exists only so a
 * pathological data case stops rather than loops forever. */
const MAX_SWEEP_ITERATIONS = PIERCE_HIT_CAPACITY + 2;

function resetSlotFields(pool, slot) {
  pool._active[slot] = 0;
  pool._x[slot] = 0; pool._z[slot] = 0;
  pool._dirX[slot] = 0; pool._dirZ[slot] = 0;
  pool._speed[slot] = 0;
  pool._life[slot] = 0;
  pool._radius[slot] = 0;
  pool._mask[slot] = 0;
  pool._sourceId[slot] = 0; pool._sourceGen[slot] = 0;
  pool._team[slot] = 0;
  pool._level[slot] = 0;
  pool._pierce[slot] = 0;
  pool._alwaysHits[slot] = 0;
  pool._skillId[slot] = null;
  pool._hitCount[slot] = 0;
  const base = slot * PIERCE_HIT_CAPACITY;
  for (let i = 0; i < PIERCE_HIT_CAPACITY; i++) pool._hitActorIds[base + i] = 0;
}

/** Fixed-capacity `Projectile` pool — free-list of indices, no `Map`, safe
 * double-release, byte-identical discipline to `src/combat/packet.js`'s own
 * `PacketPool`. See the file header for the flight/damage/allocation
 * reasoning.
 */
export class ProjectilePool {
  /** @param {number} capacity */
  constructor(capacity) {
    this._capacity = capacity;

    this._active = new Uint8Array(capacity);
    this._x = new Float64Array(capacity);
    this._z = new Float64Array(capacity);
    this._dirX = new Float64Array(capacity);
    this._dirZ = new Float64Array(capacity);
    this._speed = new Float64Array(capacity);
    this._life = new Float64Array(capacity);
    this._radius = new Float64Array(capacity);
    this._mask = new Int32Array(capacity);
    this._sourceId = new Int32Array(capacity);
    this._sourceGen = new Int32Array(capacity);
    this._team = new Int32Array(capacity);
    this._level = new Int32Array(capacity);
    this._pierce = new Uint8Array(capacity);
    this._alwaysHits = new Uint8Array(capacity);
    /** Plain `Array` of interned string references (`'ember_bolt'`, ...) —
     * see the file header's "Zero-allocation discipline" section. */
    this._skillId = new Array(capacity).fill(null);

    this._hitActorIds = new Int32Array(capacity * PIERCE_HIT_CAPACITY);
    this._hitCount = new Int32Array(capacity);

    this._freeSlots = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this._freeSlots[i] = i;
    this._freeCount = capacity;

    /** Reused across every `fixedUpdate` sweep call — never reallocated. */
    this._hitScratch = {
      hit: false, x: 0, z: 0, nx: 0, nz: 0, distance: 0, fraction: 0,
      surface: 'stone', actorId: 0, staticHandle: 0,
    };
    /** Reused `combat:hit-request` payload — mutated and emitted
     * synchronously, never stashed (same discipline as
     * `impl/cleaving_strike.js`'s own `hitRequestPayload`). */
    this._hitRequestPayload = { source: null, target: null, packet: null };
  }

  get capacity() {
    return this._capacity;
  }

  /** `02-api-contracts.md` §10: `projectileCount` property -> `int`. */
  get count() {
    return this._capacity - this._freeCount;
  }

  /** @param {number} slot @param {number} actorId @returns {boolean} */
  _hasHit(slot, actorId) {
    const base = slot * PIERCE_HIT_CAPACITY;
    const n = this._hitCount[slot];
    for (let i = 0; i < n; i++) {
      if (this._hitActorIds[base + i] === actorId) return true;
    }
    return false;
  }

  /** Records `actorId` as resolved for this projectile's whole flight. A
   * full list (extremely unlikely — `PIERCE_HIT_CAPACITY` bodies pierced by
   * ONE bolt) degrades to "stop recording, keep flying" rather than
   * throwing or growing — the same "bounded, graceful" discipline every
   * other fixed-capacity scratch in this codebase uses.
   * @param {number} slot @param {number} actorId */
  _recordHit(slot, actorId) {
    const n = this._hitCount[slot];
    if (n >= PIERCE_HIT_CAPACITY) return;
    this._hitActorIds[slot * PIERCE_HIT_CAPACITY + n] = actorId;
    this._hitCount[slot] = n + 1;
  }

  /**
   * `02-api-contracts.md` §10: `spawnProjectile(spec) => int id | 0`. See
   * the file header, D-47, for why a dry pool returns `0` rather than
   * evicting. The owner (`spec.sourceId`) is seeded into the per-flight
   * "already hit" list so it can never be hit by its own bolt, using the
   * exact same mechanism pierce uses — not a second exclusion path.
   * @param {{x:number,z:number,dirX:number,dirZ:number,speed:number,
   *   lifetime:number,radius:number,pierce:boolean,mask:number,
   *   sourceId:number,sourceGen:number,team:number,skillId:string,
   *   level:number,alwaysHits:boolean}} spec
   * @returns {number} int id (`slot + 1`), or `0` if the pool is dry.
   */
  spawnProjectile(spec) {
    if (this._freeCount === 0) return 0; // D-47 — refuse, never evict, never grow.
    const slot = this._freeSlots[--this._freeCount];
    resetSlotFields(this, slot);

    this._active[slot] = 1;
    this._x[slot] = spec.x;
    this._z[slot] = spec.z;
    this._dirX[slot] = spec.dirX;
    this._dirZ[slot] = spec.dirZ;
    this._speed[slot] = spec.speed;
    this._life[slot] = spec.lifetime;
    this._radius[slot] = spec.radius;
    this._mask[slot] = spec.mask;
    this._sourceId[slot] = spec.sourceId;
    this._sourceGen[slot] = spec.sourceGen;
    this._team[slot] = spec.team;
    this._level[slot] = spec.level;
    this._pierce[slot] = spec.pierce ? 1 : 0;
    this._alwaysHits[slot] = spec.alwaysHits ? 1 : 0;
    this._skillId[slot] = spec.skillId;

    this._recordHit(slot, spec.sourceId); // never hit your own caster

    return slot + 1;
  }

  /** `02-api-contracts.md` §10: `killProjectile(id) => void`. Safe no-op on
   * a stale/already-dead id — same discipline `PacketPool#release` (and
   * every other pool in this codebase) documents.
   * @param {number} id */
  killProjectile(id) {
    const slot = id - 1;
    if (slot < 0 || slot >= this._capacity) return;
    if (!this._active[slot]) return;
    resetSlotFields(this, slot);
    this._freeSlots[this._freeCount++] = slot;
  }

  dispose() {
    this._freeCount = 0;
  }
}

/**
 * Resolves one landed hit for a live projectile against `actorId` — builds
 * the spell packet, applies this skill's own `alwaysHits` rider (see the
 * file header), emits `combat:hit-request`, releases the packet. A no-op
 * (never crashes) if the target or the owner has despawned since spawn.
 * @param {ProjectilePool} pool
 * @param {number} slot
 * @param {number} actorId
 * @param {{actors:object, combat:object, events:object}} deps
 */
function resolveProjectileHit(pool, slot, actorId, deps) {
  const target = deps.actors.byId(actorId);
  if (!target || target.dead) return;
  const source = deps.actors.byId(pool._sourceId[slot]);
  if (!source) return; // owner despawned mid-flight — degrade, don't crash

  const packet = deps.combat.buildSpellPacket(source, pool._skillId[slot], pool._level[slot]);
  if (!packet) return; // DamagePacket pool exhausted — combat's own warn already fired

  if (pool._alwaysHits[slot]) {
    packet.attackRating = 0; // 03 §5.1: attackRating 0 -> always hits, R2 skipped
    packet.dodgeable = false;
    packet.blockable = false;
  }
  packet.originX = pool._x[slot];
  packet.originZ = pool._z[slot];

  const payload = pool._hitRequestPayload;
  payload.source = source;
  payload.target = target;
  payload.packet = packet;
  deps.events.emit('combat:hit-request', payload);
  deps.combat.releasePacket(packet);
}

/**
 * Advances every live projectile by one fixed step: lifetime, the bounded
 * sweep-continuation chain (pierce/owner exclusion via the per-flight hit
 * list), damage resolution on a new actor hit, and death on lifetime expiry
 * or a static (wall) hit. See the file header for the full reasoning.
 * Called from `SkillsSystem#fixedUpdate` — never reads `dt`/wall clock
 * itself, `h` is the caller's own fixed step.
 * @param {ProjectilePool} pool
 * @param {number} h fixed step seconds (always `1/60`)
 * @param {{physics:object, actors:object, combat:object, events:object}} deps
 */
export function advanceProjectiles(pool, h, deps) {
  const physics = deps.physics;
  if (!physics) return; // physics not wired into this ctx — degrade, no-op

  for (let slot = 0; slot < pool._capacity; slot++) {
    if (!pool._active[slot]) continue;

    pool._life[slot] -= h;
    if (pool._life[slot] <= 0) {
      pool.killProjectile(slot + 1);
      continue;
    }

    let ox = pool._x[slot];
    let oz = pool._z[slot];
    let remDx = pool._dirX[slot] * pool._speed[slot] * h;
    let remDz = pool._dirZ[slot] * pool._speed[slot] * h;
    const mask = pool._mask[slot];
    const radius = pool._radius[slot];
    const hit = pool._hitScratch;

    // Start each step excluding the most recently resolved actor for THIS
    // flight (spawn seeds it with the owner — see spawnProjectile above);
    // the persistent hit list (`_hasHit`) is the authoritative guard, this
    // is only the cheap common-case skip.
    let excludeId = pool._hitCount[slot] > 0 ? pool._hitActorIds[slot * PIERCE_HIT_CAPACITY + pool._hitCount[slot] - 1] : 0;

    let alive = true;
    for (let iter = 0; iter < MAX_SWEEP_ITERATIONS; iter++) {
      physics.sweepProjectile(ox, oz, remDx, remDz, radius, mask, excludeId, hit);
      if (!hit.hit) {
        ox += remDx;
        oz += remDz;
        break;
      }

      if (hit.actorId === 0) {
        // Static geometry — the bolt dies here, no damage (does not pierce walls).
        ox = hit.x; oz = hit.z;
        pool.killProjectile(slot + 1);
        alive = false;
        break;
      }

      const newRemDx = remDx - (hit.x - ox);
      const newRemDz = remDz - (hit.z - oz);
      ox = hit.x; oz = hit.z;
      remDx = newRemDx; remDz = newRemDz;
      excludeId = hit.actorId;
      // Write the real impact position into the pool BEFORE resolving —
      // `resolveProjectileHit` reads `pool._x[slot]`/`pool._z[slot]` for
      // `packet.originX`/`.originZ` (R4's frontal-hit/block check), and
      // without this write it would read the STALE pre-step position for
      // every hit but the loop's very last one (the `if (alive)` block
      // below only runs once, after the whole loop finishes) — a real bug
      // for any future `blockable: true` projectile, caught and fixed here
      // before it shipped silently wrong. `ember_bolt` itself never
      // observes the difference (`alwaysHits` forces `blockable: false`),
      // which is exactly why this needed a second look rather than trusting
      // "the tests pass".
      pool._x[slot] = ox; pool._z[slot] = oz;

      if (!pool._hasHit(slot, hit.actorId)) {
        pool._recordHit(slot, hit.actorId);
        resolveProjectileHit(pool, slot, hit.actorId, deps);

        if (!pool._pierce[slot]) {
          pool.killProjectile(slot + 1);
          alive = false;
          break;
        }
      }
      // Already-hit body (or a just-credited pierce hit): fall through and
      // keep sweeping the remainder of this step's displacement, now
      // excluding it.

      if (remDx * remDx + remDz * remDz < 1e-12) break; // remainder exhausted
    }

    if (alive) {
      pool._x[slot] = ox;
      pool._z[slot] = oz;
    }
  }
}
