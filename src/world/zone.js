// src/world/zone.js
//
// WRLD-4 — the `requestZone` latch and the between-frame service point.
// `02-api-contracts.md` §5 / `07-world-gen.md` §10.2 name `world.enterZone`
// (`Fixed: N`, does the real work — teardown, geometry, `physics.rebuild()`,
// `nav.rebuild()`, the events) and `world.requestZone` (`Fixed: Y, Alloc: no`
// — the only zone-change entry point `player`'s `fixedUpdate` may call). No
// method existed anywhere to bridge the two; that gap is this ticket.
//
// ---------------------------------------------------------------------------
// D-66 — this file, not a second `enterZone`
// ---------------------------------------------------------------------------
// `src/world/index.js` (WRLD-1/WRLD-3) already runs the real emission chain
// end to end: `zone:enter` (T5) -> statics added, `physics.rebuild()` (T8)
// -> `nav.rebuild(instance)` -> `nav:rebuilt`/`instance.navVersion` mirrored
// (T9) -> `zone:ready` (T12). D-66 rules that this file does not reimplement
// any of that — it owns the LATCH (`requestZoneLatch`) and the SERVICE POINT
// (`serviceZoneRequestOnce`), and the service point causes T5->T8->T9->T12 to
// fire, in order, by calling the one real `enterZone` that already exists —
// it never emits an event or calls `physics`/`nav` itself. `index.js` wires
// both functions onto `WorldSystem` as `requestZone`/`serviceZoneRequest`
// (rule 7 / O-71 — a contract method must be reachable as a method on the
// subsystem the contract names), the same "index.js: thin forward, the real
// logic lives in its own file" shape `src/nav/index.js`'s NAV-2/4/5 addenda
// and `src/physics/index.js`'s PHYS-2/4/5 addenda already use.
//
// ---------------------------------------------------------------------------
// The latch — `Fixed: Y, Alloc: no` (rule 5 / O-59 / `12-testing.md` §4.5)
// ---------------------------------------------------------------------------
// `requestZoneLatch` is the one call site `07-world-gen.md` §10.2's own T1
// row and `11-flows.md`'s A-2 both name as running FROM `player`'s
// `fixedUpdate` (unlike `enterZone`, which `02-api-contracts.md` §5 forbids
// there outright — it disposes geometry and allocates a new nav grid).
// `Alloc: no` on a method reachable from the 60 Hz sim loop is a hard
// requirement, not a nice-to-have: no object literal, no template string,
// no array push per call. `createZoneRequestState()` builds the entire
// pending-request record — including the scratch `opts` object handed to
// `enterZone` on service — exactly once, in `WorldSystem`'s own constructor
// (`index.js`'s wiring), and every latch call after that only assigns
// primitive fields onto it.
//
// `false` when a request is already pending (the exact contract wording,
// `02-api-contracts.md` §5 / `11-flows.md` A-2) — never queued, never
// overwritten. The caller (`player`) is expected to hold its own intent and
// retry the latch, not for this file to buffer more than one.
//
// ---------------------------------------------------------------------------
// The service point — reused scratch, not a defensive copy
// ---------------------------------------------------------------------------
// `serviceZoneRequestOnce` is what `src/core/engine.js`'s phase 4b already
// calls, by name (`world.serviceZoneRequest()`), between `lateUpdate` and
// `render` — see that file's own comment at the call site. It is `Fixed`-
// exempt (it never runs inside a `fixedUpdate` body; the engine's own phase
// ordering is what makes that true, not anything in this file) and is not
// itself contracted anywhere in `02-api-contracts.md` (O-1 — the name is
// settled by the shipped engine call site, not by this ticket; a future
// ticket may add the row).
//
// `state._optsScratch` is reused, never reallocated, as the `opts` object
// handed to `world.enterZone(zoneId, entryTag, opts)`. This is safe only
// because `enterZone` reads `opts.runIndex`/`opts.difficulty` synchronously,
// at the very top of its body, before any `await` — it never retains the
// object past that point (`src/world/index.js`'s `enterZone`, first three
// lines). Reusing it here costs nothing and avoids a second allocation on
// top of `enterZone`'s own already-documented `Alloc: yes`.
//
// `enterZone` is declared `async` but this ticket's `index.js` never awaits
// anything inside it (see that file's own header) — calling it runs the
// full T5->T8->T9->T12 chain synchronously before `enterZone(...)` returns
// control to this function, so `serviceZoneRequestOnce` does not need to be
// `async` itself, and the engine's fire-and-forget call
// (`world.serviceZoneRequest();`, no `await`) already gets the real,
// synchronous effect on the same frame.
//
// Node-safe: no `three`, no `document`/`window`/`performance.now()`.

/**
 * Builds one pending-request record, including its own reusable `opts`
 * scratch object. Called exactly once, by `WorldSystem`'s constructor —
 * never per-frame, never per-request (see the file header, "The latch").
 * @returns {{
 *   pending: boolean,
 *   zoneId: string,
 *   entryTag: string,
 *   runIndex: number,
 *   difficulty: string,
 *   _optsScratch: {runIndex: number, difficulty: string},
 * }}
 */
export function createZoneRequestState() {
  return {
    pending: false,
    zoneId: '',
    entryTag: '',
    runIndex: 0,
    difficulty: '',
    _optsScratch: { runIndex: 0, difficulty: '' },
  };
}

/**
 * `02-api-contracts.md` §5 / `11-flows.md` A-2: `requestZone(zoneId,
 * entryTag, opts?) => boolean`. `Fixed: Y, Alloc: no` — safe to call from
 * `player`'s `fixedUpdate`. Latches `{zoneId, entryTag, runIndex,
 * difficulty}` onto `state` and returns `true`; returns `false` without
 * touching `state` when a request is already pending.
 * @param {ReturnType<typeof createZoneRequestState>} state
 * @param {string} zoneId
 * @param {string} entryTag
 * @param {{runIndex?: number, difficulty?: string}} [opts]
 * @returns {boolean}
 */
export function requestZoneLatch(state, zoneId, entryTag, opts) {
  if (state.pending) return false;
  state.pending = true;
  state.zoneId = zoneId;
  state.entryTag = entryTag;
  state.runIndex = opts && Number.isInteger(opts.runIndex) ? opts.runIndex : 0;
  // Same default `enterZone` itself falls back to (`src/world/index.js`),
  // kept identical here so a request serviced later behaves exactly like a
  // direct `enterZone` call with the same `opts`.
  state.difficulty = (opts && opts.difficulty) || 'instruction';
  return true;
}

/**
 * The service point: called once per frame by `WorldSystem.serviceZoneRequest`
 * (itself called by `src/core/engine.js` phase 4b, between `lateUpdate` and
 * `render`). A no-op when nothing is pending. When a request is pending,
 * clears the latch FIRST (so a caller inspecting `state.pending` from inside
 * `enterZone`'s own emitted events already sees it cleared, and so a
 * synchronous re-latch during those events is accepted rather than dropped
 * as "already pending"), then drives the real `enterZone` — which is what
 * actually runs T5->T8->T9->T12, in order (see the file header, D-66).
 * @param {ReturnType<typeof createZoneRequestState>} state
 * @param {{enterZone: (zoneId: string, entryTag: string, opts?: object) => Promise<object>}} world
 */
export function serviceZoneRequestOnce(state, world) {
  if (!state.pending) return;
  state.pending = false;

  const opts = state._optsScratch;
  opts.runIndex = state.runIndex;
  opts.difficulty = state.difficulty;

  world.enterZone(state.zoneId, state.entryTag, opts);
}
