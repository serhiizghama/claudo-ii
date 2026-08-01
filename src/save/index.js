// src/save/index.js
//
// SAVE-1 — the `save` subsystem shell and `validate()` (schema v1's
// fifteen invariants, `01-data-model.md` §10.3; ruling D-27). This is the
// SAVE-2/SAVE-3 subsystem's first ticket: no `localStorage`, no live
// save/load loop, no migrations. `src/save/` stays fully headless — no
// `three`, no `document`/`window`, no `performance.now()`
// (`tools/check-imports.mjs` now scans it as a full root, checkThree AND
// checkGlobals both true).
//
// ---------------------------------------------------------------------------
// Why `validate()` and `meta()` are the only methods this ticket attaches
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §16 contracts fourteen methods total. `hasSlot`/
// `load`/`save`/`deleteSlot`/`loadStash`/`saveStash`/`settings`/
// `saveSettings`/`migrate`/`quarantine`/`setAutosave`/`requestAutosave`/
// `exportSlot`/`importSlot`/`estimateBytes` all need `localStorage` and/or
// migrations, neither of which exists yet (SAVE-2/SAVE-3, both M6) — adding
// any of them here, even as a stub, is exactly the "public method invented
// before its ticket" mistake rule 7 warns against (the same discipline
// `src/items/index.js`'s own header documents for ITEM-1's `rollDrop` etc.).
// `SCHEMA_VERSION` (a static property, not a method) is genuinely just an
// integer constant (`./schema.js`), needed by `validate()`'s own `version`
// argument.
//
// `meta()` IS in scope, on direct instruction (orchestrator round 2): it
// has its own `02` §16 row (`() => SaveMeta`), and `src/main.js`'s B11
// boot stage gates on `typeof save.meta === 'function'` — without it, a
// real, registered `save` still leaves B11 permanently `'skipped'`. This is
// NOT a stub that lies: with no persistence layer at all (SAVE-2 is M6, no
// `localStorage` read ever happens), the honest answer to "what character
// slots exist" is "none" — `slots: [null, null, null]` is exactly
// `01-data-model.md` §10.2's own shape for that state, not an invented
// value standing in for a real one. See `meta()`'s own comment.
//
// ---------------------------------------------------------------------------
// No `ctx.rng.fork()` — the O-36/O-54 trap this ticket's brief warns about
// ---------------------------------------------------------------------------
// A schema validator draws no randomness — there is nothing in `validate()`
// that could legitimately consume a `Rng` draw. Taking a fork anyway (to
// "future-proof" for SAVE-2/3) would be the ITEM-4-precedent mistake in
// reverse: an unused stream nobody spends, sitting on `ctx.rng`'s snapshot
// for `tests/core/boot.test.js`'s `prewarm` test to trip over for no gain.
// Matches the precedent already set by `physics`/`nav`/`world`/`combat`'s
// own `index.js` headers ("no ctx.rng.fork() — draws no randomness").
//
// ---------------------------------------------------------------------------
// `static deps = ['items', 'player']` — matches 02 §16 exactly
// ---------------------------------------------------------------------------
// Both are real, already-registered subsystems by the time `save` lands
// (M3), so — unlike `items`'s own `materials` omission — no deviation from
// the contracted deps line is needed here.
//
// `world` is deliberately NOT a declared dep (02 §16 does not list it
// either): `validate()`'s invariant 15 (currentZone resolution) is the only
// thing that ever wants it, and `validate()` only ever runs well after boot
// has completed — by which point `world` (registered earlier in
// `src/main.js`'s B4 block, and with no dependency on `save`) is always
// ready regardless of topological tie-breaking. `init()` below reaches it
// with `ctx.peek('world')` (never throws) purely so a test that boots a
// minimal ctx without `world` still gets a well-formed (if permissive)
// `validate()` rather than a crash — see `./schema.js`'s `KNOWN_ZONE_IDS`
// fallback.
//
// ---------------------------------------------------------------------------
// tests/core/boot.test.js — granted, round 2
// ---------------------------------------------------------------------------
// That file's stub-`Save`-via-`opts.systems` collision (UI-1/O-54's own
// precedent, one subsystem id over) is fixed IN that file, not worked
// around here — see its own diff/comment for the repair (assert boot
// reaches its stages with the real, always-registered `save`, not that a
// stub can be injected in its place).

import { SCHEMA_VERSION, validate as validateSave, KNOWN_ZONE_IDS } from './schema.js';

export class SaveSystem {
  static id = 'save';
  static deps = ['items', 'player'];

  /** `02-api-contracts.md` §16: `SCHEMA_VERSION` — static property → `int`. */
  static SCHEMA_VERSION = SCHEMA_VERSION;

  /** @param {object} ctx */
  async init(ctx) {
    this._items = ctx.get('items'); // hard dep — always ready here (static deps)
    this._player = ctx.get('player'); // hard dep, unused by validate() today; kept for SAVE-2/3
    // Soft — see the file header on why `world` is not a declared dep.
    this._world = typeof ctx.peek === 'function' ? ctx.peek('world') : undefined;
  }

  /**
   * `02-api-contracts.md` §16: `meta() => SaveMeta`. No `localStorage` read
   * — SAVE-2 is M6, so no character has ever been persisted in this build.
   * `slots` is honestly `[null, null, null]` every call: `01-data-model.md`
   * §10.2's own literal shape for "exactly 3 entries, null for an empty
   * slot", which is what every slot genuinely is when nothing has ever
   * been written. `createdAt`/`updatedAt` are documented as "informational
   * only, never read by the sim" (§10.2) — `0` is the honest sentinel for
   * "no write has ever happened" here, not a guess at a real timestamp.
   *
   * @returns {{ schemaVersion: number, createdAt: number, updatedAt: number, slots: (object|null)[] }}
   */
  meta() {
    return {
      schemaVersion: SCHEMA_VERSION,
      createdAt: 0,
      updatedAt: 0,
      slots: [null, null, null],
    };
  }

  /**
   * `02-api-contracts.md` §16: `validate(obj, version) => { ok, failures }`
   * — the fifteen invariants. Thin delegation to the pure engine in
   * `./schema.js`, wired to this instance's real `items`/`world`
   * references.
   *
   * @param {object} obj - a `CharacterSave` (or a `StashSave` for the item
   *   invariants — see `./schema.js#collectItems`).
   * @param {number} version - the `SCHEMA_VERSION` to validate against.
   * @returns {{ ok: boolean, failures: string[] }}
   */
  validate(obj, version) {
    const world = this._world;
    return validateSave(obj, version, {
      itemBase: (id) => this._items.base(id),
      itemAffix: (id) => this._items.affix(id),
      itemUnique: (id) => this._items.unique(id),
      zoneResolves: (zoneId) => {
        if (world && typeof world.descriptor === 'function') {
          try {
            world.descriptor(zoneId);
            return true;
          } catch {
            return false;
          }
        }
        return KNOWN_ZONE_IDS.includes(zoneId);
      },
    });
  }
}
