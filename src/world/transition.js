// src/world/transition.js
//
// WRLD-10 — `07-world-gen.md` §10 in full: the T1-T15 transition envelope
// (350 / 600 / 350 ms), zone retention keyed by `(zoneId, seed)`, the T13
// restore, the town portal, and the four query methods `02-api-contracts.md`
// §5 assigns to `world` and that nothing has implemented until now
// (`setExitSealed`, `openPortal`/`closePortal`/`portalAt`, `interactableAt`,
// `openChest`).
//
// ---------------------------------------------------------------------------
// D-66 again — this file NEVER re-implements `enterZone`
// ---------------------------------------------------------------------------
// `src/world/zone.js` (WRLD-4) owns the `requestZone` latch and the between-
// frame service point; `src/world/index.js` owns the one real `enterZone`
// and its T5->T8->T9->T12 emission chain. This file adds a THIRD layer on
// top of both and calls neither's internals:
//
//   `beginTransition()`  -> starts the fade, disables control        (T1)
//   `advanceTransition()`-> at the end of fade-out calls
//                           `world.requestZone(...)` — the SAME latch
//                           `player` uses, serviced by the SAME engine
//                           phase-4b service point, which runs the SAME
//                           `enterZone`                              (T3-T12)
//                        -> holds black to a constant 600 ms, then fades in,
//                           then re-enables control                  (T14/T15)
//
// So a transition driven through this file and a bare `world.enterZone()`
// call run byte-for-byte the same generation path. That is deliberate: O-106
// was paid for by a harness that was "in the exact shape of the real
// pipeline" and was not the real pipeline. There is exactly one pipeline
// here and this file is a caller of it, never a copy of it.
//
// ---------------------------------------------------------------------------
// The clock — dt, never a wall clock
// ---------------------------------------------------------------------------
// `tools/check-imports.mjs` scans `src/world/` for `performance.now()`,
// `document` and `window` and fails on any of them, so the envelope is
// integrated from `ctx.time.raw` (the engine's own unscaled, already-clamped
// per-frame delta) inside `world.update()` — presentation, never
// `fixedUpdate`. `07` §10.1 requires exactly this of the fade anyway ("driven
// by `ui` from `lateUpdate` (integrated from `dt`, never a CSS transition)").
//
// Two consequences, stated rather than hidden:
//   1. `ctx.time.raw` is clamped to 0.10 s by `src/core/engine.js`, so a
//      single frame that really took 600 ms is counted as 100 ms of engine
//      time here. The BLACK-WINDOW PAD (`TRANSITION_MS.black`) is therefore
//      a floor on engine time, and the real wall-clock cost of the work done
//      inside the black window is measured by the harness that calls
//      `enterZone`, not by this file. `tests/world/wrld10.test.js` reports
//      real `performance.now()` deltas around real `enterZone` calls for
//      exactly that reason.
//   2. `state.lastLeg.*` are engine-time milliseconds, and are labelled as
//      such everywhere they are read back. They are not a wall clock and no
//      acceptance number in this ticket's report is taken from them.
//
// ---------------------------------------------------------------------------
// Retention — the key is `(zoneId, seed)`, and `seed` already carries runIndex
// ---------------------------------------------------------------------------
// `07` §13's own "Not requested, and why": *"`enterZone(zoneId, entryTag,
// { runIndex })` carries enough for `world` to recognise a retained instance
// by `(zoneId, seed)` internally. No new parameter, no new method."*
// `seed = hash(worldSeed, zoneId, runIndex)` (`src/world/index.js#seedFor`),
// so a re-entry with a different `runIndex` produces a different seed and
// therefore MISSES the retained record — which is precisely §10.4's rule
// that an exit/descent regenerates with `runIndex + 1` while a portal return
// keeps `runIndex` unchanged and gets the identical zone back.
//
// `01-data-model.md` §9.3 caps live instances at two: the town plus one
// field zone. `RETAINED_FIELD_CAP = 1` enforces that literally — retaining a
// second field zone evicts the first.
//
// What retention means here, exactly (§10.4):
//   - The `ZoneInstance` object itself is kept, with its `chests`,
//     `packs`, `portals`, `entries`, `groundItems`, `cleared`,
//     `bossDefeated`, `monstersKilled`.
//   - The T6 layout products are kept too, so a retained re-entry SKIPS the
//     generator entirely (§10.4: "skips T6 entirely, re-runs T7-T9 from the
//     same seed"). `src/world/index.js` reads them back out of
//     `retained.gen`.
//   - The Three.js scene graph is NOT kept. `index.js`'s existing
//     `_disposeWastesGeometry`/`_disposeBonereachGeometry` still run on every
//     transition, so GPU memory is freed exactly as §10.4 requires.
//
// ---------------------------------------------------------------------------
// Ordering deviation from §10.2's table, and why
// ---------------------------------------------------------------------------
// §10.2 lists T12 (`zone:ready`) BEFORE T13 (restore chest flags / pack
// `aliveCount` / ground items). Taken literally that is unimplementable for
// two of the three: `ai` spawns the packs from `world.packs` inside its own
// `zone:ready` listener (`src/ai/index.js#_onZoneReady`), synchronously,
// before `events.emit` returns — so pack state restored AFTER `zone:ready`
// would be restored onto a zone that has already respawned every cleared
// pack, and §10.4's "a pack with `spawned && aliveCount === 0` is not
// respawned" could never hold.
//
// This file therefore splits T13 in two, at the only seam where each half
// can actually work:
//   - `applyRetainedState()` — chest `opened`, pack `spawned`/`aliveCount`,
//     `cleared`, `bossDefeated`, portals and dynamic entries — runs just
//     BEFORE `zone:ready` (call it T13a).
//   - `restoreGroundItems()` — the re-drop — runs just AFTER `zone:ready`
//     (T13b), which is where §10.2 puts it and where it belongs: `items`
//     has no ordering dependency on it.
// Reported as a spec/implementation divergence, not silently taken.
//
// ---------------------------------------------------------------------------
// Node-safe: no `three`, no `document`/`window`/`performance.now()`.
// ---------------------------------------------------------------------------

// ===========================================================================
// Constants
// ===========================================================================

/**
 * `07` §10.1's envelope, in milliseconds.
 *
 * ---------------------------------------------------------------------------
 * §10.1's three stage numbers did not add up to its own stated total
 * ---------------------------------------------------------------------------
 * §10.1 drew the envelope as `350 | 600 | 350` and then said "Target total:
 * <= 1 100 ms", with a ruler whose ticks (0 / 350 / 1 100) implied a 400 ms
 * black window — three numbers, no two consistent. This file implemented the
 * three STAGE numbers literally and exposed both totals rather than picking
 * one quietly. **O-142 ruled the stages correct and 1 100 an arithmetic
 * slip**; §10.1 and §10.3 now say 1 300, so `statedTotal` is gone and there
 * is one total again.
 *
 * `hardFail` is §10.1's "Hard fail: 2 500 ms".
 *
 * Kept here rather than under `src/world/data/` only because this ticket's
 * file grant creates exactly one source file; these are pacing constants,
 * not balance numbers the harness reads (`ARCHITECTURE.md` rule 9's target),
 * but the placement is disclosed in this ticket's report all the same.
 */
export const TRANSITION_MS = Object.freeze({
  fadeOut: 350,
  black: 600,
  fadeIn: 350,
  /** §10.1's "Target total", and what the three stages sum to (O-142). */
  envelopeTotal: 1300,
  hardFail: 2500,
});

/** `07` §10.5: the town-side pad is fixed geometry at `(0, -17)`. */
export const TOWN_PORTAL_PAD = Object.freeze({ x: 0, z: -17 });

/** `07` §10.5 "Placement": `nav.snap(player.x, player.z + 1.5, 3.0)`, and
 * the return entry sits 2.2 m south of the pad. */
export const TOWN_PORTAL_FORWARD_Z = 1.5;
export const TOWN_PORTAL_SNAP_RADIUS = 3.0;
export const TOWN_PORTAL_RETURN_OFFSET_Z = 2.2;

/** `07` §10.5 step 2's own literals. `portal_return` is registered on the
 * FIELD zone at portal-open time and is not in any shipped
 * `descriptor.entryTags` — see `src/world/index.js#entry`'s WRLD-10 note for
 * how a dynamically registered entry is accepted. */
export const PORTAL_RETURN_TAG = 'portal_return';
export const TOWN_ZONE_ID = 'last_bastion';
/** The town's own arrival tag for a portal trip, from §10.5 step 2's
 * `world.openPortal(px, pz, 'last_bastion', 'town_portal_return')` — and it
 * IS in the shipped `last_bastion.entryTags`. */
export const TOWN_PORTAL_ENTRY_TAG = 'town_portal_return';

/** `07` §9.3's own sample `radius: 2.4` — the interaction disc used for
 * every `Interactable` this file synthesises. ASSIGNED for the chest/portal/
 * exit kinds: §9.3 gives one number and no per-kind table. */
export const INTERACT_RADIUS = 2.4;

/** `01-data-model.md` §9.3 — "Two zone instances are live at most (current +
 * the town)". The town is always one of them, so exactly one field zone may
 * be retained beside it. */
export const RETAINED_FIELD_CAP = 1;

const HALF_PI = Math.PI / 2;

// ===========================================================================
// State
// ===========================================================================

/**
 * Every mutable bit of WRLD-10 state, built ONCE in `WorldSystem`'s
 * constructor — never per-frame and never per-transition (rule 6). Every
 * `out`-style record below is a reused scratch; the `Alloc: no` rows in
 * `02-api-contracts.md` §5 (`portalAt`, `interactableAt`, `setExitSealed`,
 * `openPortal`, `closePortal`, `openChest`) are honoured by writing into
 * these instead of returning fresh objects.
 * @returns {object}
 */
export function createTransitionState() {
  return {
    // ── the envelope ─────────────────────────────────────────────────────
    /** `'idle' | 'fade_out' | 'black' | 'fade_in'`. */
    phase: 'idle',
    /** ms spent in the current phase (engine time — see the file header). */
    phaseMs: 0,
    /** ms since `beginTransition` (engine time). */
    legMs: 0,
    /** 0 = fully visible, 1 = fully black. `ui` reads this. */
    fade: 0,
    /** the pending leg's destination, latched at `beginTransition`. */
    zoneId: '',
    entryTag: '',
    runIndex: 0,
    difficulty: '',
    /** true once this leg has handed the request to `world.requestZone`. */
    requested: false,
    /** Reused `opts` for the `requestZone` call — same discipline as
     * `./zone.js`'s own `_optsScratch`. */
    _optsScratch: { runIndex: 0, difficulty: '' },
    /** Last completed leg's engine-time breakdown. Reused, never replaced. */
    lastLeg: {
      zoneId: '', entryTag: '',
      fadeOutMs: 0, blackMs: 0, fadeInMs: 0, totalMs: 0,
      hardFail: false, complete: false,
    },

    // ── retention ────────────────────────────────────────────────────────
    /** `'zoneId#seed' -> RetainedRecord`. At most `RETAINED_FIELD_CAP` field
     * zones plus the town. */
    retained: new Map(),

    // ── portals ──────────────────────────────────────────────────────────
    /** Next `portalId`. Ids start at 1 so `portalAt` can return `0` for
     * "none" (`02-api-contracts.md` §5's own signature). */
    nextPortalId: 1,
    /** `07` §10.5 "One at a time" — `world` tracks exactly one. `0` = none. */
    townPortalId: 0,
    /** The field zone the live town portal points back at, and the seed that
     * identifies its retained instance. */
    townPortalZoneId: '',
    townPortalSeed: 0,

    // ── sealed exits ─────────────────────────────────────────────────────
    /** `'zoneId|exitTag' -> true` for every exit `setExitSealed` has sealed.
     * Survives a zone change, which is the whole point of the method taking
     * a `zoneId` rather than acting on the current zone only. */
    sealed: new Map(),

    // ── scratches (Alloc: no) ────────────────────────────────────────────
    _interactableScratch: {
      id: 0, kind: '', x: 0, z: 0, radius: 0,
      npcId: null, chestId: 0, portalId: 0,
      toZone: null, toEntryTag: null, enabled: true, promptKey: '',
    },
    _portalFrom: { x: 0, z: 0 },
    _portalTo: { zone: '', entryTag: '' },
    _portalPoint: { x: 0, y: 0, z: 0 },
    _snapOut: { x: 0, y: 0, z: 0 },
    /** Reused bag for the `items.groundItemsNear` sweep at teardown/restore.
     * Grown once, on demand, never per call. */
    _groundOut: [],
  };
}

// ===========================================================================
// §10.4 — retention, keyed by `(zoneId, seed)`
// ===========================================================================

/**
 * The retention key. `seed` already folds `worldSeed`, `zoneId` and
 * `runIndex` (`src/world/index.js#seedFor`), so this pair is a complete
 * identity for "the same instance of the same zone".
 * @param {string} zoneId @param {number} seed @returns {string}
 */
export function retentionKey(zoneId, seed) {
  return `${zoneId}#${seed >>> 0}`;
}

/**
 * `07` §10.4's rule, as a predicate. The town is retained unconditionally
 * ("built once at boot and never disposed"); a field zone is retained only
 * when the player is leaving it for the town THROUGH THE OPEN TOWN PORTAL
 * that points back at it. Any other departure — the descent, the ascent,
 * entering a different field zone — disposes it.
 * @param {object} state @param {object|null} previous the outgoing `ZoneInstance`
 * @param {string} nextZoneId
 * @returns {boolean}
 */
export function shouldRetain(state, previous, nextZoneId) {
  if (!previous) return false;
  if (previous.descriptor && previous.descriptor.kind === 'town') return true;
  if (nextZoneId !== TOWN_ZONE_ID) return false;
  return state.townPortalId !== 0 && state.townPortalZoneId === previous.zoneId;
}

/**
 * T3-time bookkeeping, called from `enterZone` immediately after
 * `zone:teardown` is emitted and before anything is disposed.
 *
 * Snapshots the outgoing zone's ground items onto `previous.groundItems`
 * (`01-data-model.md` §9.2's own field — nothing else has ever written it),
 * then either retains or drops the instance per `shouldRetain`.
 *
 * @param {object} state
 * @param {object} ctx
 * @param {object|null} previous the outgoing `ZoneInstance`
 * @param {string} nextZoneId
 * @param {object|null} gen the T6 layout products for `previous` (see the
 *   file header) — kept so a retained re-entry can skip the generator.
 * @returns {boolean} whether `previous` was retained
 */
export function retainOnTeardown(state, ctx, previous, nextZoneId, gen) {
  if (!previous) return false;

  snapshotGroundItems(state, ctx, previous);

  const key = retentionKey(previous.zoneId, previous.seed);
  const keep = shouldRetain(state, previous, nextZoneId);

  if (!keep) {
    state.retained.delete(key);
    // §10.4: "Taking the descent instead — Wastes -> Bonereach — disposes
    // the retained Wastes instance and closes any open town portal, because
    // the cap is two and the town always occupies one."
    if (previous.descriptor && previous.descriptor.kind !== 'town' && nextZoneId !== TOWN_ZONE_ID) {
      dropRetainedField(state);
      closePortalRecord(state, ctx, previous, state.townPortalId);
    }
    return false;
  }

  const isTown = previous.descriptor && previous.descriptor.kind === 'town';
  if (!isTown) evictFieldRetentionsExcept(state, key);

  state.retained.set(key, {
    zoneId: previous.zoneId,
    seed: previous.seed >>> 0,
    runIndex: previous.runIndex,
    isTown,
    instance: previous,
    gen: gen || null,
  });
  return true;
}

/** Drops every retained FIELD zone (the town is never evicted). @private */
function dropRetainedField(state) {
  for (const [k, rec] of state.retained) {
    if (!rec.isTown) state.retained.delete(k);
  }
}

/** Keeps at most `RETAINED_FIELD_CAP` field zones, always preferring the one
 * about to be written. @private */
function evictFieldRetentionsExcept(state, keepKey) {
  let fields = 0;
  for (const [k, rec] of state.retained) {
    if (rec.isTown || k === keepKey) continue;
    fields++;
    if (fields >= RETAINED_FIELD_CAP) state.retained.delete(k);
  }
}

/**
 * The lookup `enterZone` performs before it decides whether to run T6.
 * @param {object} state @param {string} zoneId @param {number} seed
 * @returns {object|null} the retained record, or `null`
 */
export function retainedFor(state, zoneId, seed) {
  return state.retained.get(retentionKey(zoneId, seed)) || null;
}

/**
 * T13a — everything that must be restored BEFORE `zone:ready` fires (see
 * the file header's ordering note). Mutates `instance` in place.
 *
 * - chest `opened` flags, matched by `chest.id` (the layout is bit-identical
 *   on a retained re-entry, so ids line up by construction);
 * - `cleared`, `bossDefeated`, `monstersKilled`;
 * - packs: a pack that was spawned and is now empty is REMOVED from
 *   `instance.packs`, which is the list `ai`'s spawn pass reads — that is
 *   what makes §10.4's "a pack with `spawned && aliveCount === 0` is not
 *   respawned" true. A partially killed pack has its `count` lowered to the
 *   survivor count.
 * - portals and dynamically-registered entries (`portal_return`).
 *
 * @param {object} state @param {object} instance the freshly built `ZoneInstance`
 * @param {object|null} retained
 * @returns {object|null} a small report, or `null` when nothing was retained
 */
export function applyRetainedState(state, instance, retained) {
  if (!retained || !retained.instance) return null;
  const old = retained.instance;

  instance.cleared = old.cleared;
  instance.bossDefeated = old.bossDefeated;
  instance.monstersKilled = old.monstersKilled;
  instance.createdAtStep = old.createdAtStep;

  // ── chests ──────────────────────────────────────────────────────────────
  let chestsRestored = 0;
  for (let i = 0; i < instance.chests.length; i++) {
    const c = instance.chests[i];
    for (let j = 0; j < old.chests.length; j++) {
      if (old.chests[j].id !== c.id) continue;
      if (old.chests[j].opened) { c.opened = true; chestsRestored++; }
      break;
    }
  }

  // ── packs ───────────────────────────────────────────────────────────────
  let packsDropped = 0;
  let packsReduced = 0;
  const kept = [];
  for (let i = 0; i < instance.packs.length; i++) {
    const p = instance.packs[i];
    let prev = null;
    for (let j = 0; j < old.packs.length; j++) {
      if (old.packs[j].id === p.id) { prev = old.packs[j]; break; }
    }
    if (!prev || !prev.spawned) { kept.push(p); continue; }
    if (prev.aliveCount <= 0) { packsDropped++; continue; } // §10.4 — cleared, never respawned
    if (prev.aliveCount < p.count) { p.count = prev.aliveCount; packsReduced++; }
    p.spawned = false;
    p.aliveCount = 0;
    if (Array.isArray(p.members)) p.members.length = 0;
    kept.push(p);
  }
  if (packsDropped > 0) instance.packs = kept;

  // ── portals + dynamic entries ───────────────────────────────────────────
  instance.portals.length = 0;
  for (let i = 0; i < old.portals.length; i++) instance.portals.push(old.portals[i]);
  for (const [tag, e] of old.entries) {
    if (!instance.entries.has(tag)) instance.entries.set(tag, e);
  }

  // ── ground items: carry the snapshot over for T13b ──────────────────────
  instance.groundItems = old.groundItems;

  return { chestsRestored, packsDropped, packsReduced, groundItems: instance.groundItems.length };
}

// ===========================================================================
// §10.4 — ground items across a portal round trip
// ===========================================================================

/**
 * T3 — records every ground item currently lying in `instance`, so T13b can
 * put back anything `items` cleared. `items` owns the registry; `world` only
 * ever reads it through the contracted `groundItemsNear` and writes it back
 * through the contracted `dropToGround` (`02-api-contracts.md` §9).
 * @private
 */
function snapshotGroundItems(state, ctx, instance) {
  const items = ctx && typeof ctx.peek === 'function' ? ctx.peek('items') : null;
  if (!items || typeof items.groundItemsNear !== 'function') return;

  const out = state._groundOut;
  if (out.length < 512) out.length = 512;
  const n = items.groundItemsNear(0, 0, 1e9, out);

  const snap = instance.groundItems;
  snap.length = 0;
  for (let i = 0; i < n; i++) {
    const item = out[i];
    if (!item) continue;
    const g = item.ground;
    snap.push({
      item,
      x: g ? g.x : 0,
      z: g ? g.z : 0,
      expiresAtStep: g ? g.expiresAtStep : 0,
    });
  }
}

/**
 * T13b — re-drops every snapshotted ground item that is no longer on the
 * floor. Idempotent: an item `items` never cleared is left exactly where it
 * is, so this is safe whether or not `items` depopulates on `zone:teardown`
 * (today it does not — see this ticket's report).
 *
 * §10.4 wants the original `expiresAtStep` to keep ticking. `items`'
 * registry stamps a fresh timeout inside `dropToGround` and exposes no way
 * to set it, so the original value is written back onto `item.ground` (which
 * IS the record `01-data-model.md` §5.3 defines) and the divergence with the
 * registry's own parallel array is reported rather than papered over.
 *
 * @param {object} state @param {object} ctx @param {object} instance
 * @returns {number} how many items were actually re-dropped
 */
export function restoreGroundItems(state, ctx, instance) {
  const snap = instance.groundItems;
  if (!snap || snap.length === 0) return 0;

  const items = ctx && typeof ctx.peek === 'function' ? ctx.peek('items') : null;
  if (!items || typeof items.dropToGround !== 'function') return 0;

  const out = state._groundOut;
  if (out.length < 512) out.length = 512;
  const live = typeof items.groundItemsNear === 'function' ? items.groundItemsNear(0, 0, 1e9, out) : 0;

  let restored = 0;
  for (let i = 0; i < snap.length; i++) {
    const rec = snap[i];
    let present = false;
    for (let j = 0; j < live; j++) {
      if (out[j] === rec.item) { present = true; break; }
    }
    if (present) continue;
    items.dropToGround(rec.item, rec.x, rec.z);
    if (rec.item.ground) rec.item.ground.expiresAtStep = rec.expiresAtStep;
    restored++;
  }
  return restored;
}

// ===========================================================================
// §9.3 — `Interactable`s
// ===========================================================================

/**
 * `01-data-model.md` §9.2 wants `chests: [{ id, x, z, opened, treasureClass }]`;
 * the three generators emit their own richer record (`unsnappedPosition`,
 * `facing`, `subSeed`, `cell`/`room`) with no `id` and no `opened`. This
 * normalises one into the other, in place, preserving every generator field
 * so nothing downstream loses data.
 * @param {object[]} chests @returns {object[]} the same array
 */
export function normalizeChests(chests) {
  for (let i = 0; i < chests.length; i++) {
    const c = chests[i];
    if (c.id === undefined) c.id = i;
    if (c.x === undefined) c.x = c.unsnappedPosition ? c.unsnappedPosition.x : 0;
    if (c.z === undefined) c.z = c.unsnappedPosition ? c.unsnappedPosition.z : 0;
    if (c.opened === undefined) c.opened = false;
  }
  return chests;
}

/** Pushes one `Interactable` (`07` §9.3's exact field set). @private */
function pushInteractable(list, rec) {
  list.push({
    id: rec.id,
    kind: rec.kind,
    x: rec.x,
    z: rec.z,
    radius: rec.radius,
    npcId: rec.npcId || null,
    chestId: rec.chestId || 0,
    portalId: rec.portalId || 0,
    toZone: rec.toZone || null,
    toEntryTag: rec.toEntryTag || null,
    enabled: rec.enabled !== false,
    promptKey: rec.promptKey,
  });
}

/**
 * Builds the current zone's `Interactable[]`: one per chest, one per exit
 * (from `descriptor.exits` plus the generator's own trigger rect), the town's
 * fixed portal pad, and anything the generator already emitted (the Altar's
 * `altar_tablet`, WRLD-8). Ids are assigned densely, in that order, so
 * `interactableAt`'s "break ties by lower id" is stable.
 *
 * @param {object} state
 * @param {object} instance
 * @param {{exit?: object|null}} [opts] the generator's exit record
 *   (`{toZone, toEntryTag, trigger:{x,z,width,depth}}`), when the zone has one
 * @returns {object[]} `instance.interactables`
 */
export function buildInteractables(state, instance, opts = {}) {
  const pre = instance.interactables.slice(); // generator-authored (Altar tablet)
  const list = instance.interactables;
  list.length = 0;
  let id = 0;

  for (let i = 0; i < instance.chests.length; i++) {
    const c = instance.chests[i];
    pushInteractable(list, {
      id: id++, kind: 'chest', x: c.x, z: c.z, radius: INTERACT_RADIUS,
      chestId: c.id, enabled: !c.opened, promptKey: 'prompt.openChest',
    });
  }

  const exit = opts.exit || null;
  if (exit && exit.trigger) {
    const sealed = state.sealed.get(`${instance.zoneId}|${exit.toEntryTag}`) === true;
    pushInteractable(list, {
      id: id++, kind: 'exit', x: exit.trigger.x, z: exit.trigger.z,
      radius: Math.max(exit.trigger.width, exit.trigger.depth) / 2,
      toZone: exit.toZone, toEntryTag: exit.toEntryTag,
      enabled: !sealed,
      promptKey: sealed ? 'ui.exit.sealed' : 'ui.exit',
    });
  }

  // `07` §10.5: "The town-side pad is fixed geometry at (0, -17) in
  // INTERACTABLES, always present, lit only when a portal is open." The
  // hand-authored town data file (07 §12 step 3) was never built, so the pad
  // is declared here — the only place in the codebase that knows it exists.
  if (instance.descriptor && instance.descriptor.kind === 'town') {
    const open = state.townPortalId !== 0;
    pushInteractable(list, {
      id: id++, kind: 'portal', x: TOWN_PORTAL_PAD.x, z: TOWN_PORTAL_PAD.z,
      radius: INTERACT_RADIUS, portalId: state.townPortalId,
      toZone: open ? state.townPortalZoneId : null,
      toEntryTag: open ? PORTAL_RETURN_TAG : null,
      enabled: open, promptKey: 'ui.portal.enter',
    });
  }

  for (let i = 0; i < pre.length; i++) {
    const it = pre[i];
    pushInteractable(list, {
      id: id++, kind: it.kind, x: it.x, z: it.z, radius: it.radius,
      npcId: it.npcId, chestId: it.chestId, portalId: it.portalId,
      toZone: it.toZone, toEntryTag: it.toEntryTag,
      enabled: it.enabled, promptKey: it.promptKey,
    });
  }

  return list;
}

/**
 * `02-api-contracts.md` §5 / `07` §9.3: the NEAREST ENABLED interactable
 * whose disc overlaps the query, ties broken by lower `id`. Returns a shared
 * scratch record (`Alloc: no`) — copy what you need, never stash it.
 * @param {object} state @param {object|null} instance
 * @param {number} x @param {number} z @param {number} radius
 * @returns {object|null}
 */
export function interactableAt(state, instance, x, z, radius) {
  if (!instance) return null;
  const list = instance.interactables;
  let best = null;
  let bestD2 = 0;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it.enabled) continue;
    const dx = it.x - x;
    const dz = it.z - z;
    const d2 = dx * dx + dz * dz;
    const reach = it.radius + radius;
    if (d2 > reach * reach) continue;
    if (best === null || d2 < bestD2 || (d2 === bestD2 && it.id < best.id)) {
      best = it;
      bestD2 = d2;
    }
  }
  if (best === null) return null;
  const s = state._interactableScratch;
  s.id = best.id; s.kind = best.kind; s.x = best.x; s.z = best.z; s.radius = best.radius;
  s.npcId = best.npcId; s.chestId = best.chestId; s.portalId = best.portalId;
  s.toZone = best.toZone; s.toEntryTag = best.toEntryTag;
  s.enabled = best.enabled; s.promptKey = best.promptKey;
  return s;
}

/**
 * `02-api-contracts.md` §5: `setExitSealed(zoneId, exitTag, sealed)` —
 * "flips one `Interactable` between its transition and its sealed prompt".
 * The flag is remembered per `(zoneId, exitTag)` so it survives the zone
 * being regenerated, and is applied immediately when that zone is current.
 * @param {object} state @param {object|null} instance the CURRENT instance
 * @param {string} zoneId @param {string} exitTag @param {boolean} sealed
 */
export function setExitSealed(state, instance, zoneId, exitTag, sealed) {
  const key = `${zoneId}|${exitTag}`;
  if (sealed) state.sealed.set(key, true);
  else state.sealed.delete(key);

  if (!instance || instance.zoneId !== zoneId) return;
  const list = instance.interactables;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (it.kind !== 'exit' || it.toEntryTag !== exitTag) continue;
    it.enabled = !sealed;
    it.promptKey = sealed ? 'ui.exit.sealed' : 'ui.exit';
  }
}

/**
 * `02-api-contracts.md` §5: `openChest(chestId) => boolean` — `false` if it
 * was already open. Flips the chest's own `opened` flag (which is what
 * §10.4 preserves across a portal round trip) and disables its prompt.
 * @param {object} state @param {object|null} instance @param {number} chestId
 * @returns {boolean}
 */
export function openChest(state, instance, chestId) {
  if (!instance) return false;
  for (let i = 0; i < instance.chests.length; i++) {
    const c = instance.chests[i];
    if (c.id !== chestId) continue;
    if (c.opened) return false;
    c.opened = true;
    const list = instance.interactables;
    for (let j = 0; j < list.length; j++) {
      if (list[j].kind === 'chest' && list[j].chestId === chestId) list[j].enabled = false;
    }
    return true;
  }
  return false;
}

// ===========================================================================
// §10.5 — the town portal
// ===========================================================================

/**
 * `02-api-contracts.md` §5 / `07` §10.5:
 * `openPortal(fromX, fromZ, toZone, toEntryTag) => int portalId`.
 *
 * Returns `0` when the portal is refused, which is exactly the "the
 * consumable is not spent" signal §10.5's rule table needs:
 *   - refused in the town ("Not in town");
 *   - refused in the Altar while the boss lives ("Not in the Altar");
 *   - refused when the destination has no retained instance to hang the
 *     town-side pad on (the town is retained from boot, so in practice this
 *     only fires in a harness that never entered the town).
 *
 * On success it registers BOTH ends with the SAME id — the field-side pad at
 * the snapped position and the town-side pad at the fixed `(0, -17)` — so
 * `portalAt` resolves either end (§10.5 step 4), registers the
 * `portal_return` entry on the field zone 2.2 m south of the pad, and emits
 * `portal:open`.
 *
 * @param {object} state @param {object} ctx @param {object} world
 * @param {number} fromX @param {number} fromZ
 * @param {string} toZone @param {string} toEntryTag
 * @returns {number} the new `portalId`, or `0` when refused
 */
export function openPortal(state, ctx, world, fromX, fromZ, toZone, toEntryTag) {
  const instance = world.current;
  if (!instance) return 0;
  if (instance.descriptor.kind === 'town') return 0; // §10.5 "Not in town"
  if (instance.descriptor.kind === 'arena' && !instance.bossDefeated) return 0; // §10.5 "Not in the Altar"

  const destKey = findRetainedKeyForZone(state, toZone);
  if (!destKey) return 0;
  const dest = state.retained.get(destKey);

  // §10.5 "One at a time" — opening a second town portal closes the first.
  if (state.townPortalId !== 0) closePortal(state, ctx, world, state.townPortalId);

  // §10.5 "Placement": `nav.snap(player.x, player.z + 1.5, 3.0)`; on failure
  // the portal opens on the player's own cell.
  let px = fromX;
  let pz = fromZ + TOWN_PORTAL_FORWARD_Z;
  const nav = typeof ctx.peek === 'function' ? ctx.peek('nav') : null;
  if (nav && typeof nav.snap === 'function') {
    const snapped = nav.snap(px, pz, TOWN_PORTAL_SNAP_RADIUS, state._snapOut);
    if (snapped) { px = snapped.x; pz = snapped.z; }
    else { px = fromX; pz = fromZ; }
  }

  const portalId = state.nextPortalId++;

  instance.entries.set(PORTAL_RETURN_TAG, {
    x: px,
    z: pz + TOWN_PORTAL_RETURN_OFFSET_Z,
    facing: -HALF_PI,
  });
  instance.portals.push({
    id: portalId, x: px, z: pz,
    toZone, toEntryTag, open: true,
  });
  dest.instance.portals.push({
    id: portalId, x: TOWN_PORTAL_PAD.x, z: TOWN_PORTAL_PAD.z,
    toZone: instance.zoneId, toEntryTag: PORTAL_RETURN_TAG, open: true,
  });

  state.townPortalId = portalId;
  state.townPortalZoneId = instance.zoneId;
  state.townPortalSeed = instance.seed >>> 0;

  const from = state._portalFrom;
  from.x = px; from.z = pz;
  const to = state._portalTo;
  to.zone = toZone; to.entryTag = toEntryTag;
  const point = state._portalPoint;
  point.x = px; point.z = pz;
  point.y = typeof world.groundHeight === 'function' ? world.groundHeight(px, pz) : 0;
  ctx.events.emit('portal:open', { from, to, point });

  return portalId;
}

/** Finds the retention key of the (single) retained instance for `zoneId`.
 * @private */
function findRetainedKeyForZone(state, zoneId) {
  for (const [k, rec] of state.retained) {
    if (rec.zoneId === zoneId) return k;
  }
  return null;
}

/**
 * `02-api-contracts.md` §5: `closePortal(portalId) => void`. Marks both ends
 * closed — the live instance's copy and every retained instance's copy —
 * and clears `townPortalId` when it was the town portal.
 * @param {object} state @param {object} ctx @param {object} world @param {number} portalId
 */
export function closePortal(state, ctx, world, portalId) {
  if (!portalId) return;
  closePortalRecord(state, ctx, world.current, portalId);
}

/** Shared body of `closePortal`, usable with any instance (including one
 * being torn down, which no longer is `world.current`). @private */
function closePortalRecord(state, ctx, instance, portalId) {
  if (!portalId) return;
  if (instance) markPortalClosed(instance, portalId);
  for (const [, rec] of state.retained) markPortalClosed(rec.instance, portalId);
  if (state.townPortalId === portalId) {
    state.townPortalId = 0;
    state.townPortalZoneId = '';
    state.townPortalSeed = 0;
  }
  void ctx;
}

/** @private */
function markPortalClosed(instance, portalId) {
  if (!instance) return;
  for (let i = 0; i < instance.portals.length; i++) {
    if (instance.portals[i].id === portalId) instance.portals[i].open = false;
  }
  const list = instance.interactables;
  if (!list) return;
  for (let i = 0; i < list.length; i++) {
    if (list[i].kind === 'portal' && list[i].portalId === portalId) {
      list[i].enabled = false;
      list[i].portalId = 0;
      list[i].toZone = null;
      list[i].toEntryTag = null;
    }
  }
}

/**
 * `02-api-contracts.md` §5: `portalAt(x, z, radius) => int portalId | 0`.
 * Resolves either end (§10.5 step 4) because both ends live in their own
 * zone's `portals` array under one id. Only OPEN portals resolve.
 * @param {object|null} instance @param {number} x @param {number} z @param {number} radius
 * @returns {number}
 */
export function portalAt(instance, x, z, radius) {
  if (!instance) return 0;
  let bestId = 0;
  let bestD2 = 0;
  for (let i = 0; i < instance.portals.length; i++) {
    const p = instance.portals[i];
    if (!p.open) continue;
    const dx = p.x - x;
    const dz = p.z - z;
    const d2 = dx * dx + dz * dz;
    const reach = INTERACT_RADIUS + radius;
    if (d2 > reach * reach) continue;
    if (bestId === 0 || d2 < bestD2) { bestId = p.id; bestD2 = d2; }
  }
  return bestId;
}

/**
 * Turns a resolved portal into a transition. NOT in `02-api-contracts.md`
 * §5 — the contract stops at `portalAt`, and `07` §10.5 step 4 says only
 * "player emits `portal:use`" while `ARCHITECTURE.md`'s event table names
 * `world` as `portal:use`'s emitter. Those two disagree; this file follows
 * `ARCHITECTURE.md` (the binding document) and emits it here, and exposes
 * this method because nothing else can carry a portal record into
 * `beginTransition`. Disclosed in this ticket's report as an addition.
 *
 * @param {object} state @param {object} ctx @param {object} world @param {number} portalId
 * @returns {boolean} whether a transition was started
 */
export function usePortal(state, ctx, world, portalId) {
  const instance = world.current;
  if (!instance || !portalId) return false;
  let portal = null;
  for (let i = 0; i < instance.portals.length; i++) {
    if (instance.portals[i].id === portalId && instance.portals[i].open) { portal = instance.portals[i]; break; }
  }
  if (!portal) return false;

  const from = state._portalFrom;
  from.x = portal.x; from.z = portal.z;
  const to = state._portalTo;
  to.zone = portal.toZone; to.entryTag = portal.toEntryTag;
  const point = state._portalPoint;
  point.x = portal.x; point.z = portal.z;
  point.y = typeof world.groundHeight === 'function' ? world.groundHeight(portal.x, portal.z) : 0;
  ctx.events.emit('portal:use', { from, to, point });

  // A portal round trip never regenerates: `runIndex` is carried unchanged
  // (§10.4), which is what makes `seedFor` produce the retained seed again.
  return beginTransition(state, ctx, world, portal.toZone, portal.toEntryTag, {
    runIndex: retainedRunIndexFor(state, portal.toZone, instance.runIndex),
    difficulty: instance.difficulty,
  });
}

/** The `runIndex` a retained instance of `zoneId` was built with, so a
 * portal return reproduces its seed exactly. Falls back to the current
 * zone's own `runIndex` when nothing is retained. @private */
function retainedRunIndexFor(state, zoneId, fallback) {
  for (const [, rec] of state.retained) {
    if (rec.zoneId === zoneId) return rec.runIndex;
  }
  return fallback;
}

// ===========================================================================
// §5 "Listens: actor:death" — pack bookkeeping and the boss's exit portal
// ===========================================================================

/**
 * `02-api-contracts.md` §5's own `Listens` row. Three jobs, all of them
 * writes to `ZoneInstance` fields that have no other writer anywhere in the
 * codebase (`monstersKilled`, `monstersAlive`, `cleared`, `bossDefeated`):
 *
 *  1. decrement the dead actor's `PackDescriptor.aliveCount`, found by
 *     scanning `pack.members` — the `ActorRef[]` `ai`'s spawn pass fills
 *     (`01-data-model.md` §9.5, "filled at spawn"). `ai.spawnOne` hardcodes
 *     `packId: 0` on every actor and `ai.brainOf` exposes no `packId`, so
 *     `members` is the ONLY mapping from a dead actor back to its pack that
 *     exists today. Reported.
 *  2. mark the zone `cleared` once every spawned pack is empty. This is what
 *     §10.4's "Cleared packs ... a pack with `spawned && aliveCount === 0`
 *     is not respawned" reads back on the next entry.
 *  3. open the arena's exit portal when a boss dies (`07` §5.4 — the record
 *     `src/world/gen/altar.js` already emits, closed).
 *
 * Runs inside `fixedUpdate` (that is where `combat` emits `actor:death`), so
 * it allocates nothing and reads no clock.
 *
 * @param {object} state @param {object} world @param {object} payload `{ actor, killer, point }`
 */
export function onActorDeath(state, world, payload) {
  const instance = world.current;
  if (!instance || !payload || !payload.actor) return;
  const actor = payload.actor;
  if (actor.kind !== 'monster') return;

  instance.monstersKilled++;
  if (instance.monstersAlive > 0) instance.monstersAlive--;

  const packs = instance.packs;
  for (let i = 0; i < packs.length; i++) {
    const members = packs[i].members;
    if (!Array.isArray(members)) continue;
    let hit = false;
    for (let j = 0; j < members.length; j++) {
      if (members[j] && members[j].id === actor.id) { hit = true; break; }
    }
    if (!hit) continue;
    if (packs[i].aliveCount > 0) packs[i].aliveCount--;
    break;
  }

  let anyAlive = false;
  for (let i = 0; i < packs.length; i++) {
    if (packs[i].spawned && packs[i].aliveCount > 0) { anyAlive = true; break; }
  }
  if (!anyAlive) instance.cleared = true;

  if (actor.rank === 'boss') {
    instance.bossDefeated = true;
    for (let i = 0; i < instance.portals.length; i++) instance.portals[i].open = true;
  }
}

/**
 * Called immediately after `zone:ready` — `ai`'s spawn pass has just written
 * `spawned`/`aliveCount` onto every `PackDescriptor`, so this is the first
 * moment `monstersAlive` can be known. Also runs T13b.
 * @param {object} state @param {object} ctx @param {object} instance
 * @returns {number} ground items re-dropped
 */
export function finishZoneRestore(state, ctx, instance) {
  let alive = 0;
  for (let i = 0; i < instance.packs.length; i++) alive += instance.packs[i].aliveCount | 0;
  instance.monstersAlive = alive;
  if (alive > 0) instance.cleared = false;
  return restoreGroundItems(state, ctx, instance);
}

// ===========================================================================
// §10.1 / §10.2 — the transition envelope, T1 and T14/T15
// ===========================================================================

/**
 * T1 — latch the destination, start the fade, disable control. Returns
 * `false` when a transition is already running (the same
 * one-at-a-time discipline `world.requestZone` itself has).
 *
 * @param {object} state @param {object} ctx @param {object} world
 * @param {string} zoneId @param {string} entryTag
 * @param {{runIndex?: number, difficulty?: string}} [opts]
 * @returns {boolean}
 */
export function beginTransition(state, ctx, world, zoneId, entryTag, opts) {
  if (state.phase !== 'idle') return false;

  state.phase = 'fade_out';
  state.phaseMs = 0;
  state.legMs = 0;
  state.fade = 0;
  state.requested = false;
  state.zoneId = zoneId;
  state.entryTag = entryTag;
  state.runIndex = opts && Number.isInteger(opts.runIndex) ? opts.runIndex : 0;
  state.difficulty = (opts && opts.difficulty) || 'instruction';

  const leg = state.lastLeg;
  leg.zoneId = zoneId; leg.entryTag = entryTag;
  leg.fadeOutMs = 0; leg.blackMs = 0; leg.fadeInMs = 0; leg.totalMs = 0;
  leg.hardFail = false; leg.complete = false;

  setControl(ctx, false);
  void world;
  return true;
}

/**
 * T14/T15 — advance the envelope by one frame. Called from
 * `world.update(dt, ctx)`; a no-op (and allocation-free) when idle.
 *
 * The black window is a CONSTANT 600 ms of engine time, padded exactly as
 * §10.3 requires ("the black window is padded to a constant 600 ms so that
 * the pacing is identical on a fast machine and a slow one, and the slack is
 * spent, not saved"). The zone request is handed to `world.requestZone` at
 * the very start of the black phase, so the engine's own phase-4b service
 * point runs `enterZone` on that same frame.
 *
 * @param {object} state @param {object} ctx @param {object} world
 * @param {number} dtSeconds fallback when `ctx.time.raw` is unavailable
 */
export function advanceTransition(state, ctx, world, dtSeconds) {
  if (state.phase === 'idle') return;

  const raw = ctx.time && typeof ctx.time.raw === 'number' ? ctx.time.raw : dtSeconds;
  const ms = (raw > 0 ? raw : 0) * 1000;
  state.phaseMs += ms;
  state.legMs += ms;

  if (state.phase === 'fade_out') {
    state.fade = Math.min(1, state.phaseMs / TRANSITION_MS.fadeOut);
    if (state.phaseMs < TRANSITION_MS.fadeOut) return;
    state.lastLeg.fadeOutMs = state.phaseMs;
    state.fade = 1;
    state.phase = 'black';
    // Carry the overshoot rather than dropping it, so a frame that lands
    // past a phase boundary does not stretch the whole envelope.
    state.phaseMs -= TRANSITION_MS.fadeOut;
    // T2..T12 — the ONE real pipeline. `requestZone` is `Fixed: Y, Alloc:
    // no`; the engine services it between `lateUpdate` and `render`.
    const o = state._optsScratch;
    o.runIndex = state.runIndex;
    o.difficulty = state.difficulty;
    state.requested = world.requestZone(state.zoneId, state.entryTag, o);
    return;
  }

  if (state.phase === 'black') {
    state.fade = 1;
    if (state.phaseMs < TRANSITION_MS.black) return;
    state.lastLeg.blackMs = state.phaseMs;
    state.phase = 'fade_in';
    state.phaseMs -= TRANSITION_MS.black;
    return;
  }

  // fade_in
  state.fade = Math.max(0, 1 - state.phaseMs / TRANSITION_MS.fadeIn);
  if (state.phaseMs < TRANSITION_MS.fadeIn) return;
  state.lastLeg.fadeInMs = state.phaseMs;
  state.lastLeg.totalMs = state.legMs;
  state.lastLeg.hardFail = state.legMs > TRANSITION_MS.hardFail;
  state.lastLeg.complete = true;
  if (state.lastLeg.hardFail) {
    // §10.1: "Hard fail: 2 500 ms, logged with a per-stage breakdown to the
    // console and to `render.stats`." The console half is here; the
    // `render.stats` half is a write into a field `render` owns and this
    // ticket's grant does not reach — reported, not silently skipped.
    const l = state.lastLeg;
    // eslint-disable-next-line no-console
    console.warn(`[world] transition HARD FAIL ${l.totalMs.toFixed(0)} ms > ${TRANSITION_MS.hardFail} ms`
      + ` (${l.zoneId}/${l.entryTag}: fadeOut ${l.fadeOutMs.toFixed(0)} + black ${l.blackMs.toFixed(0)} + fadeIn ${l.fadeInMs.toFixed(0)})`);
  }
  state.fade = 0;
  state.phase = 'idle';
  state.phaseMs = 0;
  setControl(ctx, true);
}

/** `07` §10.1: "`player.setControlEnabled(false)` for the whole window".
 * Guarded — a headless harness has no `player`. @private */
function setControl(ctx, on) {
  const player = typeof ctx.peek === 'function' ? ctx.peek('player') : null;
  if (player && typeof player.setControlEnabled === 'function') player.setControlEnabled(on);
}
