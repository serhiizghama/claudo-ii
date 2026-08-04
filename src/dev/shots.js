// src/dev/shots.js
//
// TEST-3 — the named-shot registry and the lockstep frame pump
// (docs/spec/12-testing.md §9's "the simulation is stepped in lockstep by
// src/dev/shots.js").
//
// ---------------------------------------------------------------------------
// What lives here, and what does not
// ---------------------------------------------------------------------------
// A "shot" is a named, fully-deterministic point in the simulation that
// `tools/capture.mjs` (and, later, TEST-15's `tools/baseline.mjs`) freezes
// into a PNG. Each entry in `SHOTS` describes:
//   - `id`          the shot's name — the key it is registered under, repeated
//                    here so a consumer holding just the descriptor object
//                    still knows its own name.
//   - `description` what the shot pins (12-testing.md §9.1's "What it pins"
//                    column), verbatim.
//   - `milestone`   which milestone introduces it (12-testing.md §9.1's
//                    "From" column) — never used for logic, only so a bless
//                    diff or a report can say *why* a shot exists.
//   - `steps`       how many ADDITIONAL fixed steps to pump via
//                    `engine.frame(FIXED_DT)` — never rAF — before the pixels
//                    are read. This is on top of whatever `src/main.js`'s own
//                    boot sequence already ran (`BOOT_FRAMES = 3`, landed by
//                    the time `window.__READY__` is observed — see
//                    `src/main.js`'s header, "Lockstep vs rAF"). `boot_clean`
//                    is captured at exactly that point, so `steps: 0`.
//   - `setup`       optional `(engine, ctx) => void`, run once before the
//                    pump — e.g. a future `dense_combat` shot spawning
//                    monsters. `boot_clean` needs none (`null`); the field
//                    exists so later shots slot into this same shape without
//                    a redesign, per this ticket's brief.
//
// `boot_clean` (M0), `ui_clean` (M2, UI-1 — see its own entry below for why
// it needs `steps: 1` and a `setup` that clears `ctx.scene`), `actor_ranker`
// (M2, dev-only) and, as of ACTR-11, three more dev-only M2 shots —
// `actor_walk_phase0`/`33`/`66` —
// are registered today. `ui_clean` is the one M2 row `12-testing.md` §9.1
// actually pins (the twelve-shot baseline) — the other M2 entries here are
// all dev-only, never blessed. `12-testing.md` §9.1 names ten more
// (`town_overview`, `dense_combat`, …) arriving in M3–M7 — those are
// explicitly out of this ticket's scope; adding them is whichever later
// ticket lands the subsystem each one depends on (world, ai, items,
// skills…).
//
// This module does NOT touch `three` or the DOM directly, and has zero side
// effects at import time — it is imported by `tools/capture.mjs` (Node) to
// read the registry, and both `pumpShot`'s AND (when present) a shot's
// `setup`'s source are injected into the browser page verbatim (see
// `tools/capture.mjs`'s header for why) to actually run them there.
//
// ---------------------------------------------------------------------------
// `pumpShot` — AND a shot's own `setup` — must survive
// `Function.prototype.toString()` + `eval`
// ---------------------------------------------------------------------------
// `tools/capture.mjs` cannot reach into the headless page's own `Engine`
// instance (`window.__ENGINE__`) from Node — it lives in a different JS
// realm, and that page is serving a PRODUCTION BUILD (`dist/`), which has no
// servable path back to this repo's un-bundled `src/` files — so neither
// `pumpShot` nor `setup` can rely on a fresh `import()` of a source module
// once they're running in the page. So both run INSIDE the page instead:
// `capture.mjs` takes `pumpShot.toString()` (and, if the shot has one,
// `shot.setup.toString()`) and evaluates each in the page. That only works if
// the function closes over nothing outside its own parameter list — no
// imported `FIXED_DT`, no reference to `SHOTS`, no `import()` of another
// module, nothing. `pumpShot` gets `(engine, steps, fixedDt)` passed in
// explicitly; a shot's `setup` gets `(engine, ctx)` — `ctx` is
// `window.__ENGINE__.ctx` (`src/core/engine.js`'s constructor stores it there
// verbatim), which is how `setup` reaches `ctx.scene`/`ctx.get(id)` without
// ever importing anything itself. A `setup` that needs a `three`-touching
// helper (e.g. an archetype's mesh builder) must reach it through something
// the ALREADY-RUNNING app exposes on that live object graph — see
// `actor_ranker`'s own entry below for the concrete pattern
// (`ctx.get('actors').__archetypeVisuals`) — never through a fresh import of
// its own.

import { FIXED_DT } from '../core/engine.js';

export { FIXED_DT };

/** @typedef {{ id: string, description: string, milestone: string, steps: number, setup: ((engine: object, ctx: object) => (void | Promise<void>)) | null }} ShotDescriptor */

/** @type {Record<string, ShotDescriptor>} */
export const SHOTS = {
  boot_clean: {
    id: 'boot_clean',
    description: 'the first frame, empty scene, camera at rest',
    milestone: 'M0',
    steps: 0,
    setup: null,
  },
  // UI-1 — one of 12-testing.md §9.1's twelve pinned shots (the only M2 row
  // there — see this ticket's report). `12-testing.md` §9.1 defines this
  // shot's whole purpose in six words: "the overlay with no world behind
  // it" — NOT "whatever boot_clean happens to show, plus an overlay".
  //
  // `ui` (src/ui/) is a DOM+CSS overlay outside `#game`'s WebGL canvas
  // (ARCHITECTURE.md's ownership map) and draws nothing into
  // `ctx.scene`/`ctx.uiScene` at U0 (`09 §15`: "Nothing draws yet"), so the
  // "overlay" half of this shot's definition is trivially satisfied — a DOM
  // overlay is invisible to a canvas screenshot by construction regardless.
  // The "no world" half is NOT free: by the time any shot's frame is read,
  // `src/dev/debugview.js` (PLYR-1, not this ticket's) has already added a
  // ground plane and a capsule to `ctx.scene` (see that file's own header —
  // it exists solely so PLYR-1's click-to-move is visible, and is explicitly
  // "TEMPORARY — M0 ONLY", replaced by `world`/ACTR-6's real meshes later).
  // Left alone, this shot is pixel-identical to `boot_clean` — confirmed
  // live before this fix — which is exactly the coupling `12-testing.md`
  // §9.1 named this shot to prevent: every future change to the ground
  // plane, the camera or the player placeholder would break `ui_clean` for
  // reasons that have nothing to do with `ui`.
  //
  // The fix is a `setup` (this file's own machinery, not a change to
  // `render`/`main.js`/`player`, none of which this ticket owns): remove
  // every child `ctx.scene` currently holds before the frame renders. This
  // reads through the live, already-loaded object graph the exact way
  // `actor_ranker`'s `setup` does (`ctx.scene` is a real `THREE.Scene` –
  // `three` is already resident in the page; nothing is imported here) —
  // `ctx.scene.children` holds ONLY `debugview.js`'s two meshes today (grep
  // confirms no other module calls `ctx.scene.add`), so clearing it removes
  // exactly the ground/capsule and nothing render-owned: `render` clears via
  // `renderer.setClearColor()` (src/render/index.js), never `scene.
  // background`, so what's left after this `setup` runs is the renderer's
  // own placeholder clear colour — infrastructure, not "world" — with
  // nothing drawn over it, which is "the overlay with no world behind it",
  // literally. This page is torn down right after the screenshot (capture.
  // mjs's own `browser.close()`), so skipping `dispose()` on the removed
  // meshes leaks nothing that outlives the process — the same non-concern
  // `actor_ranker`'s own extra meshes already accept.
  //
  // `steps: 1`, not `0` — this file's own header trap: "`steps: 0` captures
  // the frame BEFORE `setup` runs, because `render()` only happens inside
  // `frame()`." `ui_clean`'s first cut used `steps: 0` with `setup: null`,
  // which is exactly why nothing of this shot's own ran at all and the PNG
  // came back identical to `boot_clean`'s. One extra `engine.frame(FIXED_DT)`
  // after this `setup` forces the one render pass that actually reflects the
  // emptied scene before the canvas is read.
  //
  // UI-2 addendum — `ctx.get('ui').setScreen('game')`: UI-2 (`09 §15` U1)
  // taught the HUD to gate itself on the active screen (`09-ui.md:2128`'s
  // vignette-gating principle, generalised — see `src/ui/hud.js#setVisible`
  // and `src/ui/index.js#setScreen`), because a boot-time regression showed
  // the plinth drawing over `character_create` (the real post-boot screen,
  // `src/main.js`'s B12). `boot_clean` — `setup: null`, `ui` never even
  // constructed on that path — is unaffected. But left alone here, this
  // shot would go back to matching `12-testing.md` §9.1's letter ("no world
  // behind it") while silently failing its own purpose: `ui_clean` exists
  // to guard the overlay, and a HUD hidden by the very screen this shot
  // boots into is not a guard, it's a blind spot. One more line puts `ui`
  // on the screen where the HUD is supposed to be visible, so the shot
  // actually exercises what U1 built. `ctx.get('ui')` reads through the
  // live, already-constructed object graph exactly the way `actor_ranker`'s
  // own `setup` reads `ctx.get('actors')` below — no import, no closure
  // over anything outside this function's own `(engine, ctx)` parameters
  // (this file's header, "must survive toString()+eval"). `setVisible`
  // writes a `display` style synchronously, so the one extra `frame()`
  // this shot already runs is enough to paint it — no `steps` bump needed.
  ui_clean: {
    id: 'ui_clean',
    description: "the UI overlay on the game screen (12-testing.md §9.1's \"the overlay with no world behind it\") — U1's plinth/orbs/XP bar, over a scene cleared of debugview.js's placeholder ground/capsule — AND, as of M4 (ACTR-21, D-49), the life orb reads filled rather than the old fixture's 0/73: O-67 (vessels never filled on spawn) closed, so a freshly spawned actor now starts at full life — AND, as of PLYR-4, that full reading is 55/55, not the 73/73 this fixture showed until today: PlayerSystem.init() used to spawn the player without an explicit level, so actors.spawn() silently fell through to SPAWN_SPEC_DEFAULTS.level === 10 (a monster-oriented default), making the player accidentally level 10 (maxLife 73) even though the \"Lv 1\" label right next to the orb already said otherwise; PLYR-4 fixed the spawn (PLACEHOLDER_LEVEL = 1, plus ProgressTracker.seedFromActor()), so a fresh character now spawns at its real level 1 (maxLife 55) and 55/55 is what actually matches the Lv 1 label beside it. The rage orb stays 0/100, correctly — rage is a build-up resource that starts empty",
    milestone: 'M2',
    steps: 1,
    // Zero free variables — see this file's header, "pumpShot — AND a
    // shot's own setup — must survive toString()+eval". Reads/mutates only
    // its own `ctx` parameter.
    setup: (engine, ctx) => {
      const children = ctx.scene.children.slice();
      for (let i = 0; i < children.length; i++) ctx.scene.remove(children[i]);
      ctx.get('ui').setScreen('game');
    },
  },
  // ACTR-6 — dev-only, NOT one of 12-testing.md §9.1's twelve pinned shots
  // (the only M2 row there is UI-1's `ui_clean`; there is no M2 actor shot —
  // see this ticket's report). Used for `08 §11 step 4`'s acceptance
  // criterion: the Bone Ranker, L0, static bind pose, measured 40x81 px at
  // 1 draw call. Never blessed under `tests/fixtures/shots/` — do not add it
  // there; `--bless` on this shot is a mistake, not a new baseline.
  actor_ranker: {
    id: 'actor_ranker',
    description: 'the Bone Ranker (L0, static bind pose), clear of the placeholder capsule, camera at rest — 08 §11 step 4\'s 40x81 px / 1 draw call measurement',
    milestone: 'M2',
    // 1, not 0 — `boot_clean` captures the exact B13 boot frame because
    // `render(ctx)` runs unconditionally as step 5 of every `frame()` call
    // (`src/core/engine.js`), including the `BOOT_FRAMES` already pumped
    // during boot itself, so 0 EXTRA steps still shows whatever was last
    // rendered. `setup` (below) runs AFTER that last boot render, adding the
    // Ranker to `ctx.scene` — with 0 further steps, `capture.mjs`'s
    // screenshot would read back that SAME stale pre-setup frame (verified:
    // this shot's own PNG came back byte-identical to `boot_clean`'s until
    // this was corrected to 1). One extra `engine.frame(FIXED_DT)` forces
    // exactly one more render pass, now with the Ranker present, before the
    // canvas is read. Still fully deterministic — `frame()` is fed the fixed
    // `FIXED_DT` constant either way, never a wall-clock `dt`.
    steps: 1,
    // Zero free variables — see this file's header, "pumpShot — AND a
    // shot's own setup — must survive toString()+eval". This function reads
    // ONLY its own parameters; it never imports anything and never closes
    // over a module-scope value, so `tools/capture.mjs` can lift its source
    // into the page exactly like it already does for `pumpShot`.
    //
    // `ctx.get('actors').__archetypeVisuals` is `src/actors/index.js`'s
    // dev-only escape hatch (ACTR-6, see that file's own comment on the
    // field) — a plain `{ archetypeId: (ctx, opts) => {built, dispose} }`
    // map. Calling through it, rather than importing `bone_ranker.js`
    // directly here, is what makes this `setup` runnable inside a page that
    // only has the built `dist/` bundle: `ctx.get('actors')` is a real,
    // already-constructed object on the live app's own graph, not a fresh
    // module import.
    // x: 1.1, not 0 — `src/player/index.js`'s placeholder player (and
    // `src/dev/debugview.js`'s debug capsule) already spawn at the world
    // origin (`PLACEHOLDER_ARCHETYPE_ID`, x=0/z=0), and `steps: 1` above
    // means one player fixedUpdate also runs before this frame is read.
    // Placing the Ranker at the same point would overlap/occlude it behind
    // that capsule, contaminating the pixel measurement this shot exists
    // for. 1.1 m clears it cleanly (confirmed live — see this ticket's
    // report) while staying well inside the 1280x720 frame at this camera's
    // distance/pitch.
    setup: (engine, ctx) => {
      ctx.get('actors').__archetypeVisuals.bone_ranker(ctx, { x: 1.1, z: 0 });
    },
  },

  // ACTR-11 — three dev-only walk-phase shots, `08 §11 step 5`'s own visual
  // half of the acceptance criterion ("three walk shots at phase 0.0 / 0.33
  // / 0.66"). Dev-only exactly like `actor_ranker` above (M2, not one of
  // `12-testing.md` §9.1's twelve pinned shots — there is no M2 walk shot
  // there either) — never blessed under `tests/fixtures/shots/`.
  //
  // Each `setup` below poses ONLY the Bone Ranker's six leg bones
  // (`UpLeg*`/`Leg*`/`Foot*`) via `08` §5.4's own thigh/knee/ankle formula,
  // duplicating `src/actors/clips.js#GAIT_PARAMS.walk`'s literal numbers and
  // `gaitAngles`' formula rather than importing that module — see this
  // file's header, "pumpShot — AND a shot's own setup — must survive
  // toString()+eval": a shot's `setup` runs inside a page serving only the
  // built `dist/` bundle and cannot `import` anything, including
  // `clips.js`. `steps: 1` for the same reason `actor_ranker` needs it (see
  // that entry, above) — one extra `engine.frame(FIXED_DT)` after `setup`
  // adds the Ranker AND applies this pose before the canvas is read.
  //
  // Posing mechanics: `08` §5.1: "write bone quaternions: q = bindLocal ·
  // euler(delta)" — `buildBoneRanker` already leaves every bone's
  // `quaternion` at exactly its bind-local value (`rig.js#localQuat`), so
  // right-multiplying by a local-X axis-angle delta here (`applyLegX`,
  // duplicating `clips.test.js`'s own quaternion-composition reasoning —
  // see that file for why local-X is the confirmed sagittal-swing axis for
  // these bones) gives exactly `bindLocal · euler(delta)` without needing to
  // read `rig.js`'s tables again — the live `THREE.Bone.quaternion` already
  // holds `bindLocal`. Only the six leg bones are touched; pelvis/spine/arm
  // motion (also part of `clips.js`'s locomotion write) is left out of these
  // shots — the acceptance criterion is phrased as "walk shots", not a
  // full-body pose comparison, and duplicating the whole pelvis/spine
  // waveform into three more zero-closure functions was judged not worth
  // the triplicated surface area for a dev-only visual aid.
  actor_walk_phase0: {
    id: 'actor_walk_phase0',
    description: "the Bone Ranker's walk cycle at phase 0.0 (08 §5.4) — dev-only, 08 §11 step 5's shot 1 of 3",
    milestone: 'M2',
    steps: 1,
    setup: (engine, ctx) => {
      const spawned = ctx.get('actors').__archetypeVisuals.bone_ranker(ctx, { x: 1.1, z: 0 });
      const A_t = 21, base_k = 7, A_k = 46, A_a = 12, stanceK = 23; // walk, clips.js GAIT_PARAMS.walk
      function lobe(x, p) { const s = Math.sin(x); return s > 0 ? Math.pow(s, p) : 0; }
      function gait(phase, sideOffset) {
        const a = 2 * Math.PI * phase + sideOffset;
        return {
          thigh: A_t * Math.sin(a),
          knee: -(base_k + A_k * lobe(a - 0.55, 1.5) + stanceK * lobe(a + Math.PI + 0.4, 2)),
          ankle: A_a * Math.sin(a - 1.9),
        };
      }
      function applyLegX(bone, deg) {
        if (!bone) return;
        const rad = (deg * Math.PI) / 180;
        const dqx = Math.sin(rad / 2), dqw = Math.cos(rad / 2);
        const q = bone.quaternion;
        const rx = q.w * dqx + q.x * dqw;
        const ry = q.y * dqw + q.z * dqx;
        const rz = q.z * dqw - q.y * dqx;
        const rw = q.w * dqw - q.x * dqx;
        bone.quaternion.set(rx, ry, rz, rw);
      }
      function boneByName(name) {
        const bones = spawned.built.skeleton.bones;
        for (let i = 0; i < bones.length; i++) if (bones[i].name === name) return bones[i];
        return null;
      }
      const PHASE = 0;
      const rightAngles = gait(PHASE, 0);
      const leftAngles = gait(PHASE, Math.PI);
      applyLegX(boneByName('UpLegR'), rightAngles.thigh);
      applyLegX(boneByName('LegR'), rightAngles.knee);
      applyLegX(boneByName('FootR'), rightAngles.ankle);
      applyLegX(boneByName('UpLegL'), leftAngles.thigh);
      applyLegX(boneByName('LegL'), leftAngles.knee);
      applyLegX(boneByName('FootL'), leftAngles.ankle);
      spawned.built.skeleton.bones[0].updateMatrixWorld(true);
    },
  },
  actor_walk_phase33: {
    id: 'actor_walk_phase33',
    description: "the Bone Ranker's walk cycle at phase 0.33 (08 §5.4) — dev-only, 08 §11 step 5's shot 2 of 3",
    milestone: 'M2',
    steps: 1,
    setup: (engine, ctx) => {
      const spawned = ctx.get('actors').__archetypeVisuals.bone_ranker(ctx, { x: 1.1, z: 0 });
      const A_t = 21, base_k = 7, A_k = 46, A_a = 12, stanceK = 23; // walk, clips.js GAIT_PARAMS.walk
      function lobe(x, p) { const s = Math.sin(x); return s > 0 ? Math.pow(s, p) : 0; }
      function gait(phase, sideOffset) {
        const a = 2 * Math.PI * phase + sideOffset;
        return {
          thigh: A_t * Math.sin(a),
          knee: -(base_k + A_k * lobe(a - 0.55, 1.5) + stanceK * lobe(a + Math.PI + 0.4, 2)),
          ankle: A_a * Math.sin(a - 1.9),
        };
      }
      function applyLegX(bone, deg) {
        if (!bone) return;
        const rad = (deg * Math.PI) / 180;
        const dqx = Math.sin(rad / 2), dqw = Math.cos(rad / 2);
        const q = bone.quaternion;
        const rx = q.w * dqx + q.x * dqw;
        const ry = q.y * dqw + q.z * dqx;
        const rz = q.z * dqw - q.y * dqx;
        const rw = q.w * dqw - q.x * dqx;
        bone.quaternion.set(rx, ry, rz, rw);
      }
      function boneByName(name) {
        const bones = spawned.built.skeleton.bones;
        for (let i = 0; i < bones.length; i++) if (bones[i].name === name) return bones[i];
        return null;
      }
      const PHASE = 0.33;
      const rightAngles = gait(PHASE, 0);
      const leftAngles = gait(PHASE, Math.PI);
      applyLegX(boneByName('UpLegR'), rightAngles.thigh);
      applyLegX(boneByName('LegR'), rightAngles.knee);
      applyLegX(boneByName('FootR'), rightAngles.ankle);
      applyLegX(boneByName('UpLegL'), leftAngles.thigh);
      applyLegX(boneByName('LegL'), leftAngles.knee);
      applyLegX(boneByName('FootL'), leftAngles.ankle);
      spawned.built.skeleton.bones[0].updateMatrixWorld(true);
    },
  },
  actor_walk_phase66: {
    id: 'actor_walk_phase66',
    description: "the Bone Ranker's walk cycle at phase 0.66 (08 §5.4) — dev-only, 08 §11 step 5's shot 3 of 3",
    milestone: 'M2',
    steps: 1,
    setup: (engine, ctx) => {
      const spawned = ctx.get('actors').__archetypeVisuals.bone_ranker(ctx, { x: 1.1, z: 0 });
      const A_t = 21, base_k = 7, A_k = 46, A_a = 12, stanceK = 23; // walk, clips.js GAIT_PARAMS.walk
      function lobe(x, p) { const s = Math.sin(x); return s > 0 ? Math.pow(s, p) : 0; }
      function gait(phase, sideOffset) {
        const a = 2 * Math.PI * phase + sideOffset;
        return {
          thigh: A_t * Math.sin(a),
          knee: -(base_k + A_k * lobe(a - 0.55, 1.5) + stanceK * lobe(a + Math.PI + 0.4, 2)),
          ankle: A_a * Math.sin(a - 1.9),
        };
      }
      function applyLegX(bone, deg) {
        if (!bone) return;
        const rad = (deg * Math.PI) / 180;
        const dqx = Math.sin(rad / 2), dqw = Math.cos(rad / 2);
        const q = bone.quaternion;
        const rx = q.w * dqx + q.x * dqw;
        const ry = q.y * dqw + q.z * dqx;
        const rz = q.z * dqw - q.y * dqx;
        const rw = q.w * dqw - q.x * dqx;
        bone.quaternion.set(rx, ry, rz, rw);
      }
      function boneByName(name) {
        const bones = spawned.built.skeleton.bones;
        for (let i = 0; i < bones.length; i++) if (bones[i].name === name) return bones[i];
        return null;
      }
      const PHASE = 0.66;
      const rightAngles = gait(PHASE, 0);
      const leftAngles = gait(PHASE, Math.PI);
      applyLegX(boneByName('UpLegR'), rightAngles.thigh);
      applyLegX(boneByName('LegR'), rightAngles.knee);
      applyLegX(boneByName('FootR'), rightAngles.ankle);
      applyLegX(boneByName('UpLegL'), leftAngles.thigh);
      applyLegX(boneByName('LegL'), leftAngles.knee);
      applyLegX(boneByName('FootL'), leftAngles.ankle);
      spawned.built.skeleton.bones[0].updateMatrixWorld(true);
    },
  },

  // UI-7 — one of `12-testing.md` §9.1's twelve pinned shots, M3's own row.
  // §9.1 describes this shot as "the grid + rare comparison tooltip + the
  // paperdoll" — the paperdoll is UI-10 (M4), not built anywhere in this
  // tree yet. Ruling D-22/O-60 (recorded before this ticket started): this
  // shot IS captured and committed under this same name in M3, as the
  // two-thirds M3 owns — the populated grid plus a rare tooltip with LIVE
  // comparison, deliberately without the paperdoll. UI-10 extends this same
  // `setup` and re-blesses the same shot name in M4 (`12` §9.3's own
  // sanctioned "a shot's setup grows, the name doesn't" pattern) — see this
  // entry's own `description` string below, which names the paperdoll, UI-10
  // and M4 explicitly per D-22's own honesty requirement (O-50 is the
  // regression a vague description here would risk repeating).
  //
  // Every item instance below is a hand-built `ItemInstance` literal (`01
  // -data-model.md` §5.3 shape), not a `items.rollItem()` draw — this shot
  // needs a DETERMINISTIC, reliably-comparable trio (two equipped rings
  // plus a rare ring with known affixes) every run; `rollItem`'s own base/
  // affix picks are real RNG draws that could just as easily land on a
  // completely different base or roll zero affixes, which would make this
  // shot flicker between "shows two comparison panels with real deltas" and
  // "shows one panel with none" from one seed to the next. Real, already-
  // accepted data only: every `baseId`/affix `id` below exists in
  // `src/items/data/bases.js`/`data/affixes.js` today (ITEM-2/ITEM-5..8,
  // landed) — this shot invents no game content, only the specific
  // combination.
  //
  // Zero free variables (this file's own header, "must survive
  // toString()+eval") — `makeItem` is declared INSIDE `setup`, closing over
  // nothing but `setup`'s own `items` parameter.
  // UI-10 (M4) re-bless — D-40/D-22/O-60. The M3 half of this ruling
  // (recorded above, on `inventory_full`'s own original entry, before this
  // ticket started) said UI-10 would "extend this same setup and re-bless
  // the same shot name" once the paperdoll existed. It now does: the ONLY
  // change below is `ui.openInventory()` -> `ui.toggleInventory()` (this
  // ticket's own `toggleInventory` pairing — `09` §11.2's `I` binding now
  // opens the character sheet alongside the inventory, see `./ui/index.js`)
  // and this `description` string. Every fixture — the nine filler items in
  // the inventory grid, the two equipped rings, the hovered rare ring's
  // live two-panel comparison — is untouched, so the diff a maintainer sees
  // against the OLD `inventory_full` fixture is exactly "the sheet panel
  // and its paperdoll are now present", not a re-shuffled scene.
  inventory_full: {
    id: 'inventory_full',
    description: 'the populated inventory grid (nine real items across every equipment category, ALL nine cells unobscured) plus a rare ring\'s tooltip with LIVE two-panel comparison (ring1 + ring2, real delta chips) — AND, as of UI-10 (M4, D-40/D-22/O-60), the character sheet opened as `I`\'s real pair-open behaviour, its ten equipment slots (ring1/ring2 populated, the rest empty), and the uiScene paperdoll rendered into its computed viewport rectangle, fully visible — THAT is this fixture\'s job (D-40: prove the paperdoll renders at all; nothing else guards that). What it does NOT guard: the tooltip\'s own anchor (260,240) sits over the sheet\'s left column, so the comparison stack covers part of the derived-stat block (Damage/Attack Rating/Defence/Chance to Block) and some attribute rows — a deliberate trade, not an oversight. The geometry makes all three (clear stat block, clear grid, visible paperdoll) impossible at once: a comparison panel is 288px min-width, the only gap that avoids both the sheet and the grid is ~212px wide with the ~40px paperdoll centered in it, so any anchor that clears the stat block instead fully hides the paperdoll (measured: 0/3000 sample px of its bbox visible) — confirmed by direct trial, not assumed. The stat block\'s own guard is `tests/ui/sheet.test.js` (16 tests + the <=104-node assert), not this pixel fixture; do not read a diff here as a character-sheet regression — AND, as of PLYR-4, the HUD life orb visible faintly behind the semi-transparent sheet panel now reads 55/104 rather than the previous 73/104: PlayerSystem.init() used to spawn the player without an explicit level, so actors.spawn() silently fell through to SPAWN_SPEC_DEFAULTS.level === 10 (maxLife 73); PLYR-4 fixed the spawn to the real level 1 (maxLife 55). The sheet\'s own derived Life stat (104) is unaffected — it is recomputed live from this setup\'s own `actor.level = 20` / `attributes.strength = 40` staging mutation, independent of the spawn-time life value PLYR-4 touched',
    milestone: 'M3',
    // §2.6's tooltip fade is `rate 26/s` on the game clock, integrated from
    // `dt` (never a CSS transition) — 20 steps at FIXED_DT (1/60 s) is
    // ~0.33 s of sim time, comfortably past the point the fade settles
    // (1 - e^(-26*0.33)) > 0.9998), so the captured frame shows the
    // tooltip/comparison panels at their full, settled opacity rather than
    // mid-fade.
    steps: 20,
    setup: (engine, ctx) => {
      const items = ctx.get('items');
      const ui = ctx.get('ui');
      const player = ctx.get('player');
      const actor = player && player.actor;
      if (!items || !ui || !actor) return;

      ui.setScreen('game');

      // Dev-only staging mutation, the same "reach into the live object
      // graph directly" precedent `actor_walk_phase0`'s own bone-posing
      // already sets (see this file's header) — clears every reqLevel/
      // reqStr this shot's own fixtures below need, deterministically,
      // without depending on a real level-up/stat-allocation flow that has
      // nothing to do with what this shot pins.
      actor.level = 20;
      if (actor.attributes) actor.attributes.strength = 40;
      // UI-10 re-bless: a real name, not the archetype's own display name
      // repeated twice in the sheet's header ("Ravager — Level 20 Ravager"
      // read oddly before this line existed) — same dev-staging-mutation
      // precedent as `actor.level`/`actor.attributes.strength` just above.
      actor.name = 'Verrin';

      let uid = 50000;
      function makeItem(baseId, overrides) {
        const base = items.base(baseId);
        const o = overrides || {};
        return {
          uid: uid++,
          baseId,
          rarity: o.rarity || 'normal',
          ilvl: o.ilvl || (base ? base.reqLevel : 1),
          identified: o.identified === undefined ? true : o.identified,
          quantity: 1,
          rolls: o.rolls || { defense: 0, superior: 0, damageMin: base && base.weapon ? base.weapon.minDamage : 0, damageMax: base && base.weapon ? base.weapon.maxDamage : 0 },
          affixes: o.affixes || [],
          uniqueId: null, uniqueValues: [], nameOverride: o.nameOverride || null,
          durability: base ? base.maxDurability : 1, maxDurability: base ? base.maxDurability : 1,
          sockets: [], socketCount: 0,
          grid: null, slot: null, ground: null,
        };
      }

      // The populated grid — one item per major category/footprint shape,
      // real base ids, `items.autoPlace` (ITEM-10, real first-fit packing).
      const fillerIds = [
        'axe_battle_normal', 'sword_short_normal', 'armour_quilted_normal',
        'gloves_wraps_normal', 'boots_hide_normal', 'helm_cap_normal',
        'shield_buckler_normal', 'belt_sash_normal', 'amulet_cord',
      ];
      for (let i = 0; i < fillerIds.length; i++) {
        items.autoPlace('inventory', makeItem(fillerIds[i], {}));
      }

      // Two equipped rings — real affixes, distinct values, so the
      // comparison's own delta chips are genuinely non-zero on screen (not
      // just structurally present).
      const ring1 = makeItem('ring_iron', { rarity: 'normal', affixes: [{ id: 'pfx_life_1', kind: 'prefix', values: [11] }] });
      const ring2 = makeItem('ring_iron', { rarity: 'magic', affixes: [{ id: 'sfx_res_all_1', kind: 'suffix', values: [5, 5, 5, 5, 5, 5] }] });
      items.equip(actor, ring1, 'ring1');
      items.equip(actor, ring2, 'ring2');

      // The hovered rare ring — identified (so the full name/property block
      // renders, not the "Unidentified" state), carrying both a fire-flat
      // pair and an all-resistances affix so both a "pair merge" and a
      // "resistance merge" property line are visible with live deltas
      // against both equipped rings at once.
      const hoverRing = makeItem('ring_iron', {
        rarity: 'rare',
        identified: true,
        nameOverride: { headIndex: 0, tailIndex: 0, code: 0, en: 'Widow\'s Grasp', ru: 'Хватка Вдовы' },
        affixes: [
          { id: 'pfx_flat_fire_1', kind: 'prefix', values: [4, 10] },
          { id: 'sfx_res_all_1', kind: 'suffix', values: [8, 8, 8, 8, 8, 8] },
        ],
      });

      // UI-10 re-bless: `toggleInventory()` now pairs the character sheet
      // (with its paperdoll) alongside the inventory — the real `I`-key
      // production path (`09` §11.2), not a special-cased dev call. Net
      // effect on a fresh, closed panel is identical to the old
      // `openInventory()` call this replaces (both panels start closed, so
      // one toggle opens them), plus the sheet now comes along.
      ui.toggleInventory();
      // Both live paths this ticket's clause 4 covers, exercised together:
      // `setCompareHeld(true)` (the Ctrl-held path) AND `showTooltip`'s own
      // `compare` argument (the open-time path) both say "on" here, which
      // is the steady state any real play session reaches the moment Ctrl
      // is held over an item — not a contrived one-path-only demo.
      ui.setCompareHeld(true);
      ui.showTooltip(hoverRing, 260, 240, true);
    },
  },

  // ITEM-15 — dev-only, NOT one of `12-testing.md` §9.1's twelve pinned
  // shots (there is no M3 icon row there — icons are step 11 of `04-items.md`
  // §12, the last M3 step, and `12` §9.1 was fixed before it landed). Never
  // blessed under `tests/fixtures/shots/` — same `actor_ranker`/
  // `actor_walk_phase*` precedent this file's own header already documents:
  // determinism is proven by `tools/imagediff.mjs` (or a manual hash
  // compare) finding two separate `capture.mjs --shot ui_icons` runs
  // byte-identical, never by a committed baseline.
  //
  // ---------------------------------------------------------------------
  // Round 3 correction — the frame must actually SHOW the icons
  // ---------------------------------------------------------------------
  // `04-items.md` §12 step 11's own acceptance and `09-ui.md` §15 U6
  // ("renders one of every base at every rarity in a CONTACT SHEET") are
  // both explicit that this shot's job is a human-visible sheet, not a
  // side-effect proof with an unrelated frame. An earlier version of this
  // entry called `items.icon()` for its side effect only and left the
  // captured WebGL frame as `ui_clean`'s cleared-scene state — two captures
  // came back byte-identical, which is real but PROVES NOTHING about the
  // icons (a frame with no icons in it is trivially stable). That is the
  // exact O-50 failure shape a shot's `description` promising more than its
  // pixels deliver: caught before landing, fixed here.
  //
  // `items.icon()` returns a 2D `OffscreenCanvas` bitmap — it has no owned
  // place in the WebGL scene (`ctx.scene`) and `ui`'s real DOM wiring for it
  // is a different, not-yet-built ticket (`src/ui/inventory.js` still draws
  // its own placeholder glyph — grep confirms: "Icon placeholders —
  // items.icon() does not exist yet (ITEM-15)"), and `src/ui/` is out of
  // this ticket's file grant regardless. But `src/dev/shots.js` is dev-only
  // TOOLING, not production `ui` — ARCHITECTURE.md's ownership map keeps
  // `src/dev/` separate from every subsystem directory for exactly this
  // reason, and a shot's `setup` composing a subsystem's generated output
  // onto a visible surface is already the established pattern here
  // (`actor_ranker`/`actor_walk_phase*` build real `three` meshes from
  // `actors`' output). This entry does the equivalent for 2D bitmaps: it
  // builds its OWN plain DOM `<canvas>` (`document.createElement('canvas')`
  // — legal here because `setup` runs INSIDE THE PAGE, a real browser realm,
  // and `src/dev/` is not one of `tools/check-imports.mjs`'s scanned N-surface
  // roots — see that tool's own root list), draws every generated icon
  // bitmap into it via `drawImage`, and appends it to `document.body` at a
  // z-index (`999999999`) far above `ui`'s own root (`src/ui/style.js`:
  // `.cl2-ui { z-index: 1000; }`) so it is what `page.locator('#game')
  // .screenshot()` actually captures — that call clips a full COMPOSITED
  // page screenshot to `#game`'s bounding rect (confirmed by how `ui_clean`
  // itself already captures `ui`'s DOM overlay, which also lives outside the
  // `<canvas id="game">` element), not a canvas-internals readback, so any
  // opaque, higher-z-index DOM content covering that same screen region is
  // exactly what ends up in the PNG.
  //
  // Layout: all 305 tiles (61 equipment bases x 5 rarities, `04-items.md`
  // §12 step 11's literal count — nothing was trimmed for legibility) in a
  // 20-column x 16-row grid (320 cells, 15 left blank), each cell exactly
  // 64x45 px (1280/20, 720/16 — both exact, no rounding drift), each icon
  // bitmap uniformly scaled to CONTAIN within its cell (aspect preserved,
  // centred, 1 px padding) via `drawImage`. Fill order is row-major over
  // `items.bases` filtered to equipment, x `RARITIES` in order — the same
  // deterministic order `tools/iconbench.mjs` and the previous round's
  // side-effect-only version both already used, so there is nothing new to
  // desynchronise. At this cell size fine per-base detail (rivet counts,
  // gem facets) is not resolvable by eye — silhouette, material colour and
  // the rarity frame/glow/mark are — which is enough for a human to see
  // that 305 real, distinct icons are present, the actual job this shot has
  // (`tools/iconbench.mjs`'s FNV-1a hash pass is the precise distinctness
  // proof; this sheet is the visual one, and the two are complementary, not
  // redundant — a hash cannot show a human that a shield looks like a
  // shield).
  //
  // Zero free variables (this file's header, "must survive toString()+eval")
  // — every local (`RARITIES`, `equipmentBases`, the grid constants, `sheet`,
  // `col`/`row`) is declared inside `setup`, closing over nothing but its
  // own `(engine, ctx)` parameters.
  //
  // SCOPE GAP — disclosed here (and in the `description` string below, which
  // is where a reader actually meets this shot), not just in
  // `src/items/icons/recipes.js`'s own header: the 305 icons drawn onto this
  // sheet are real, distinct, in-budget renders (`tools/iconbench.mjs`
  // proves both) from a WORKING ENGINE against GENERIC recipes — they are
  // not yet the DESIGNED icons. `04-items.md` §11.1 is a 61-row table of
  // hand-authored per-base parameters (crescent spans, back-spike positions,
  // rivet/prong counts, gem hues, named `haft`/`pommel` shapes...) that this
  // ticket's recipes do not transcribe; each recipe is driven only by
  // `ItemBase.surface`/`.tier`/`.iconSeed` instead. Closing that gap is a
  // later content-authoring pass over the same primitives library, not a
  // re-open of this ticket. Two smaller, same-reason simplifications: the
  // `-22°` rotation `09-ui.md` §7.3 specifies for weapons in a footprint
  // taller than it is wide is not applied, and that same section's iconSeed
  // tint band ("value ±8%") is read as a MULTIPLICATIVE shift on HSL
  // lightness (`l * (1 + valMul)`), not an absolute one — an unstated but
  // plausible reading of "±8%" that a content pass revisiting §11.1 should
  // re-confirm.
  ui_icons: {
    id: 'ui_icons',
    description: "dev-only, NOT one of 12-testing.md §9.1's twelve pinned shots — a 20x16-cell (64x45 px) contact sheet of all 305 real items.icon() renders (04-items.md §12 step 11 / 09-ui.md §15 U6: 61 equipment bases x 5 rarities, RARITIES order, row-major), each bitmap drawImage'd aspect-preserved into its cell; composited on a plain DOM <canvas> appended to document.body at z-index 999999999 (above ui's own z-index:1000 root) so page.locator('#game').screenshot() — which clips a composited page screenshot, not a canvas-internals readback — actually captures it. SCOPE GAP: these are real, distinct, in-budget renders from a WORKING ENGINE against GENERIC recipes parameterised only by surface/tier/iconSeed — NOT YET 04-items.md §11.1's 61 hand-authored per-base parameters (crescent spans, back-spike positions, rivet/prong counts, gem hues, named haft/pommel shapes); closing that gap is a later content-authoring pass, not this ticket's. Two smaller simplifications for that same pass to revisit: the -22° tall-weapon rotation of 09-ui.md §7.3 is skipped, and that section's iconSeed 'value ±8%' tint is read as a multiplicative HSL-lightness shift, not an absolute one",
    milestone: 'M3',
    steps: 1,
    setup: (engine, ctx) => {
      const children = ctx.scene.children.slice();
      for (let i = 0; i < children.length; i++) ctx.scene.remove(children[i]);

      const items = ctx.get('items');
      if (!items || typeof items.icon !== 'function') return;

      const RARITIES = ['normal', 'superior', 'magic', 'rare', 'unique'];
      const bases = items.bases;
      const equipmentBases = [];
      for (let i = 0; i < bases.length; i++) {
        const b = bases[i];
        const isEquipment = (b.category === 'weapon' && b.id !== 'unarmed') || b.category === 'armour' || b.category === 'jewelry';
        if (isEquipment) equipmentBases.push(b);
      }

      const VIEW_W = 1280, VIEW_H = 720;
      const COLS = 20, ROWS = 16; // 320 cells for 305 tiles — see this entry's header
      const TILE_W = VIEW_W / COLS;
      const TILE_H = VIEW_H / ROWS;

      const sheet = document.createElement('canvas');
      sheet.id = 'cl2-dev-icon-sheet';
      sheet.width = VIEW_W;
      sheet.height = VIEW_H;
      sheet.style.position = 'fixed';
      sheet.style.left = '0px';
      sheet.style.top = '0px';
      sheet.style.width = VIEW_W + 'px';
      sheet.style.height = VIEW_H + 'px';
      sheet.style.zIndex = '999999999';
      sheet.style.pointerEvents = 'none';
      document.body.appendChild(sheet);

      const g = sheet.getContext('2d');
      g.fillStyle = '#0b0e14';
      g.fillRect(0, 0, VIEW_W, VIEW_H);

      let uid = 900000;
      let col = 0;
      let row = 0;
      for (let i = 0; i < equipmentBases.length; i++) {
        const base = equipmentBases[i];
        for (let r = 0; r < RARITIES.length; r++) {
          const rarity = RARITIES[r];
          if (row < ROWS) {
            const icon = items.icon({
              uid: uid++,
              baseId: base.id,
              rarity,
              ilvl: base.reqLevel || 1,
              identified: true,
              quantity: 1,
              rolls: { defense: 0, superior: rarity === 'superior' ? 10 : 0, damageMin: 0, damageMax: 0 },
              affixes: [],
              uniqueId: null, uniqueValues: [], nameOverride: null,
              durability: base.maxDurability, maxDurability: base.maxDurability,
              sockets: [], socketCount: 0,
              grid: null, slot: null, ground: null,
            });
            if (icon) {
              const dx = col * TILE_W, dy = row * TILE_H;
              const pad = 1;
              const availW = TILE_W - pad * 2, availH = TILE_H - pad * 2;
              const scale = Math.min(availW / icon.width, availH / icon.height);
              const dw = icon.width * scale, dh = icon.height * scale;
              const ox = dx + (TILE_W - dw) / 2, oy = dy + (TILE_H - dh) / 2;
              g.drawImage(icon, ox, oy, dw, dh);
            }
          }
          col++;
          if (col >= COLS) { col = 0; row++; }
        }
      }
    },
  },

  // UI-9 — D-40: `12-testing.md:540`'s own M4 row ("the tree at 29
  // allocated points"), owned by this ticket because no backlog row does
  // (see this ticket's report). One of `12` §9.1's twelve pinned shots.
  //
  // ---------------------------------------------------------------------
  // Why this setup calls `player.fixedUpdate` and `skills.allocate`
  // directly, not `player.spendSkillPoint`
  // ---------------------------------------------------------------------
  // `player.spendSkillPoint(skillId)` is contracted
  // (`02-api-contracts.md:1184`) but not implemented anywhere in
  // `src/player/` (checked live; `src/player/` is out of this ticket's file
  // grant regardless — see `src/ui/tree.js`'s own header for the full O-69-
  // style guard `Tree#_onConfirmClick` already carries for this exact gap).
  // This fixture is staged the same way `inventory_full`'s own setup stages
  // its scene (direct calls into the ALREADY-CONSTRUCTED live subsystem
  // graph, `ctx.get(id)`, never a fresh import — this file's own header,
  // "must survive toString()+eval"):
  //   1. `player.grantXp(1e9, 0)` then a direct `player.fixedUpdate(...)`
  //      call — the REAL level-up path (PLYR-4's `ProgressTracker`, `03
  //      -combat-math.md` §10.4's XP table): level 1 -> 30 in one pass,
  //      `hudState().skillPoints` becomes 29 (`level - 1`, no class ever
  //      pre-spends a starting point today — `CLASS_START_KIT` is PLYR-6,
  //      M6, unimplemented). This is the "legitimate path" the ticket's
  //      brief asks for, spelled out here: XP, not a hand-set `actor.level`.
  //   2. `skills.allocate(actor, skillId)` x29, in ascending-tier order (so
  //      `sunder`'s own prerequisite — `bloodletting >= 3` — is already
  //      real by the time `sunder` is reached, the same ordering
  //      `Tree#_onConfirmClick` uses for CONFIRM) — `skills.allocate` is
  //      real, accepted, contracted (SKIL-1) and is exactly what the
  //      missing `spendSkillPoint` would call internally.
  //   3. `player._progress.skillPoints = 0` — a direct field write on the
  //      live `ProgressTracker` (same "dev-mutation of the live graph"
  //      tier as `inventory_full`'s own `actor.level = 20` line), standing
  //      in for the bookkeeping half of the missing `spendSkillPoint` so
  //      the header reads "0 remaining" rather than "29 remaining" over a
  //      fully-allocated tree — disclosed here and in this ticket's report,
  //      not silently faked.
  // The distribution below sums to exactly 29, respects every `maxLevel`
  // cap (20) and `sunder`'s own prerequisite: cleaving_strike 6,
  // bloodletting 3, whirlwind 4, bloodthirst 2, sunder 3 (carnage = 18);
  // ram_charge 3, shield_stance 3, war_cry 2, iron_skin 2, last_stand 1
  // (unyielding = 11).
  skill_tree_ravager: {
    id: 'skill_tree_ravager',
    description: "the skill tree screen at 29 allocated points across both Ravager trees (12-testing.md §9.1's own row, D-40) — the node lattice with every node's badge showing its real allocated level, the connector canvas's prerequisite edge (bloodletting -> sunder, satisfied) and its five synergy edges, cleaving_strike SELECTED and HOVERED (round 2, coordinator review: criterion 3 needs the detail card actually populated, not empty — describe()'s own N/N+1 pair is visible in the two mono columns) which also lights criterion 6's cleaving_strike -> whirlwind synergy edge at full alpha/thickness while every other edge dims to 12%, header reading 0 skill points remaining. player.spendSkillPoint is unimplemented (out of this ticket's file grant) — the 29 points are staged via real player.grantXp + player.fixedUpdate (the level 1->30 XP path) then real skills.allocate calls in tier order, with the header's remaining-points bookkeeping patched directly on the live ProgressTracker to read 0 — see this entry's own header for the full disclosure. KNOWN, EXPECTED placeholders: the detail card's DESCRIPTION/SYNERGIES/REQUIRES labels and the header's skill-points line read `[missing]tree.*` — O-70, none of those i18n keys exist in src/ui/i18n.js yet (out of this ticket's file grant); every one is routed through ui.t()'s documented fallback, never hardcoded English. When those keys land, THIS FRAME WILL LEGITIMATELY CHANGE — read that future diff as scheduled i18n work landing, not a regression",
    milestone: 'M4',
    steps: 1,
    setup: (engine, ctx) => {
      const ui = ctx.get('ui');
      const player = ctx.get('player');
      const skills = ctx.get('skills');
      if (!ui || !player || !skills) return;

      ui.setScreen('game');

      player.grantXp(1e9, 0);
      player.fixedUpdate(1 / 60, ctx); // processes the whole level 1 -> 30 climb in one pass (PLYR-4's ProgressTracker)

      const actor = player.actor;
      if (!actor) return;

      const alloc = [
        ['cleaving_strike', 6], ['ram_charge', 3], // tier 1
        ['bloodletting', 3], ['whirlwind', 4], ['shield_stance', 3], // tier 6
        ['bloodthirst', 2], ['war_cry', 2], ['iron_skin', 2], // tier 12
        ['sunder', 3], ['last_stand', 1], // tier 18 — sunder after bloodletting, above
      ];
      for (const [skillId, count] of alloc) {
        for (let i = 0; i < count; i++) skills.allocate(actor, skillId);
      }
      if (player._progress) player._progress.skillPoints = 0; // see this entry's own header, point 3

      ui.toggleSkillTree();

      // Round 2 (coordinator review): criterion 3 is "the detail card shows
      // describe() at level N and N+1" — the panel's hardest feature and
      // `describe`'s own reason to exist (SKIL-12) — and an unselected
      // panel shows none of it. `__select`/`__hoverNode` are `tree.js`'s
      // own dev-only escape hatches (double-underscore, `src/actors/
      // index.js`'s `__archetypeVisuals` convention this file's header
      // already leans on for `actor_ranker`) — reached here the same way
      // this file's OTHER setups reach into the live, already-constructed
      // object graph (`ctx.get('actors').__archetypeVisuals`, `ui._target
      // ._targetActor` in `target.perf.test.js`), never a fresh import.
      // `cleaving_strike` is the natural choice: criterion 6 is its
      // synergy edge to `whirlwind`, so one selection demonstrates the
      // detail card AND lights that edge in the same frame. Select and
      // hover are independent flags in `tree.js` (hover drives connector
      // focus; selection drives the detail card) — both are set here so
      // the frame shows both effects at once, matching what a real player
      // sees while the cursor sits on the node they just clicked.
      if (ui._tree) {
        ui._tree.__select('cleaving_strike');
        ui._tree.__hoverNode('cleaving_strike');
      }
    },
  },

  // WRLD-6 (D-69) — `12 §9.1` assigns these two to M5 and `12:625` requires
  // them in the baseline; no backlog row owned them until D-69 granted them
  // here. Two seeds of the same generator (Ashen Wastes, `runIndex` 0 and 8
  // — `world.seedFor` hashes each into a different `Rng` seed) is what
  // proves the generator, not one lucky frame — picked by actually running
  // both headlessly first (`generateRidgewalkLayout`) and comparing: seed A
  // is 10/16 connected macro cells (entry cell 2, exit cell 12, a ravine
  // present); seed B is 14/16 connected (entry cell 3, exit cell 12, also a
  // ravine, but a visibly denser, more sprawling layout) — genuinely
  // different cell counts and entry points, not two near-identical rolls.
  //
  // `world.requestZone` is called directly here (not through `player`'s
  // `fixedUpdate`, the only path `02-api-contracts.md` names for it) —
  // every other dev shot in this file already reaches straight into a
  // subsystem's public surface (`ui.toggleSkillTree()`, `skills.allocate()`)
  // rather than simulating a full player-driven flow, and `requestZone`
  // is a real, public, `Fixed:Y` method on `world` (O-71) — there is
  // nothing player-specific about calling it from a shot's own `setup`.
  // `steps: 3` (not `1`): `requestZone` only LATCHES here, before any frame
  // has run; the real `enterZone` chain (T5->T8->T9->T12, including this
  // ticket's own T7 geometry build) fires inside the ENGINE's phase 4b, on
  // the first pumped frame — three steps gives the orbit-locked camera
  // (`player`'s per-frame follow) a little room to settle onto the
  // teleported player before the pixels are read, the same reasoning
  // `inventory_full`'s own `steps: 20` documents for its own settle window,
  // scaled down here since nothing here animates a UI transition.
  wastes_seed_a: {
    id: 'wastes_seed_a',
    description: "Ashen Wastes, runIndex 0 (world seed 0xc7a123d4): a 10-of-16 connected macro-cell layout with a ravine, viewed from the player's spawn point after `enterZone` (T6 layout, this ticket's own R8 dressing + R9 boundary, T7 geometry, T8 physics, T9 nav — O-99's real `nav.groundY` — all real, not stubbed). The frame shows the dressed ground cell the player lands on (ash_flats, forced by A1) and whatever neighbouring cells/props/ridge-wall silhouette fall inside the fixed 3/4 camera's frustum from that one spawn position — it does NOT show the ravine, the exit stair, or the full 96x96 m zone (the camera never frames the whole zone, by design — `docs/ARCHITECTURE.md`'s fixed orbit rig). Prop geometry is this ticket's own placeholder primitive shapes (a scaled box per prototype — see `src/world/build/wastes.js`'s header): real per-prototype mesh art is a separate, later ticket's scope, not built here. Every prop renders as a flat black silhouette because no light illuminates a `MeshStandardMaterial` yet: `sky` (the subsystem that would add a directional sun) does not exist in this codebase and this ticket does not stub it (its own binding instruction). The green backdrop and the pale capsule are NOT this ticket's geometry at all — they are `src/dev/debugview.js`'s (PLYR-1) own TEMPORARY, unlit `MeshBasicMaterial` placeholder ground plane and player capsule, still resident in `ctx.scene` because this shot's `setup` does not clear it the way `ui_clean`'s does; this ticket builds no ground-tile mesh of its own (out of scope — WRLD-6 is props/boundary, not the ground surface kit), so without `debugview.js`'s placeholder the frame would show only the black props on the bare clear colour. Read the black shapes as this ticket's real, seeded R8/R9 output; read the green ground and the capsule as pre-existing dev scaffolding this ticket did not touch. HONEST LIMIT (coordinator round 2): this frame does NOT read as evidence of a different MAP SHAPE — only of different LOCAL DRESSING. The entry cell is always ash_flats (A1, forced, identical archetype in every seed), the camera never frames enough of the zone to show macro layout (spine/branches/other archetypes), and every prop here (ash_flats draws only from G2's 4 rubble prototypes) is an unlit black silhouette with no colour/texture cue to distinguish prototypes from one another. What genuinely differs between this frame and `wastes_seed_b`'s is dressing DENSITY and ARRANGEMENT near the same kind of spawn point (measured: 486 vs. 638 placed props, 10 vs. 14 connected cells) — real, seed-driven variation, but a narrower claim than 'two different maps'.",
    milestone: 'M5',
    steps: 3,
    setup: (engine, ctx) => {
      const world = ctx.get('world');
      if (!world) return;
      world.requestZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
    },
  },

  wastes_seed_b: {
    id: 'wastes_seed_b',
    description: "Ashen Wastes, runIndex 8 (world seed 0xbfa1173c): a denser 14-of-16 connected macro-cell layout with a different entry cell (3, vs. seed A's 2) and a ravine, viewed from the player's spawn point the same way `wastes_seed_a` is — see that entry's own description for what is and is not in frame (this shot shows a different spawn cell's own dressing, still only the local camera frustum, never the whole zone; same placeholder prop geometry, same real T6-T9 pipeline, same lighting caveat — see that entry's own note on the black silhouettes / `debugview.js`'s placeholder ground+capsule, all identical here). Comparing this frame against `wastes_seed_a` shows a visibly denser cluster concentrated toward one side here versus clutter spread across most of the frame there — a real, seed-driven difference in dressing density/arrangement (measured: 638 vs. 486 placed props). HONEST LIMIT, same as `wastes_seed_a`'s own note: this is NOT evidence the two seeds produce different macro MAP shapes — both spawn on the same forced ash_flats archetype (A1), the camera never frames enough of the zone to show the spine/branches/other archetypes, and nothing here distinguishes prototype from prototype visually (no light, no colour). The proof that the generator varies structurally is programmatic (connected-cell count 10 vs. 14, different entry cell 2 vs. 3, different archetype mix — see this ticket's test suite), not this pixel frame alone.",
    milestone: 'M5',
    steps: 3,
    setup: (engine, ctx) => {
      const world = ctx.get('world');
      if (!world) return;
      world.requestZone('ashen_wastes', 'portal_from_town', { runIndex: 8 });
    },
  },

  // WRLD-7 — one of `12-testing.md` §9.1's twelve pinned shots (the M5 row
  // this milestone's own backlog assigns to Bonereach), granted by this
  // ticket's own brief ("exactly one shot — bonereach_hall").
  //
  // ---------------------------------------------------------------------
  // Why runIndex 15, not 0 — a real, checked constraint, not an arbitrary pick
  // ---------------------------------------------------------------------
  // The camera follows the PLAYER, and nothing in this codebase repositions
  // the player to a zone's own `entry()` point on a zone change — checked
  // directly: `src/player/index.js` has no `zone:ready`/`zone:enter`
  // listener at all (grep confirms). `wastes_seed_a`/`b` get away with this
  // because the player's own placeholder spawn (world origin, 0,0) happens
  // to sit inside Ashen Wastes' own walkable area regardless. For
  // Bonereach, world origin (0,0) is a fixed point relative to the ROOT
  // rectangle and can land ANYWHERE relative to a given seed's own rooms —
  // inside a room, grazing a wall, or inside solid rock outright. Checked
  // headlessly across `runIndex` 0-19 (`world.seedFor('bonereach',
  // runIndex)`, world seed 0): most land in rock or within 1 m of a wall;
  // `runIndex 15` (seed 0x197a99d5) is the best of that sample — origin
  // sits 3.0 m clear of every wall, inside room 10 (21x18 m, `centre:
  // {x:6,z:6}`), a real dressed hall interior rather than a wall closeup or
  // a black screen. This is disclosed, not hidden: this shot's own camera
  // position is a happy accident of where the placeholder player already
  // is, not a deliberate `descent`-entry framing — a future ticket wiring
  // player-to-entry repositioning on zone change would let this (and every
  // other zone's own shot) actually frame the real entry point.
  //
  // 14 rooms this seed (17 requested — see this ticket's own report for
  // how often requested and achieved diverge across the 600-layout sweep,
  // a proven mathematical ceiling in 07 §4.2 B2's own numbers, not a bug),
  // 14 corridors (13 tree + 1 loop), entry room 1, stair room 13, two vault
  // rooms (6, 9), no flooded room this seed.
  //
  // `steps: 3` — same reasoning as `wastes_seed_a`/`b`'s own entries:
  // `requestZone` only LATCHES here; the real `enterZone` chain (including
  // this ticket's own T7 geometry build) fires on the engine's next pumped
  // frame, and a few more steps let the orbit-locked camera settle before
  // the pixels are read.
  bonereach_hall: {
    id: 'bonereach_hall',
    description: "Bonereach, runIndex 15 (world seed 0, `world.seedFor('bonereach',15)` = 0x197a99d5): a real 14-room BSP hall (17 requested, 14 achieved this seed — see this ticket's own report for the proven B2 ceiling that makes 17/18 unreachable and 12-16 the realistic range), 14 corridors (13 tree-spanning + 1 loop edge), after a real `enterZone` (T6 layout — B1-B8/B10, this ticket's own generator — T7 geometry: room floors/walls/ceilings, corridor floor slabs, the stair room's 6-step ramp, instanced B9 dressing props — T8 physics, T9 nav, all real, not stubbed). The camera follows the player, which nothing repositions to the zone's own `descent` entry on a zone change (a real, pre-existing gap — see this entry's own header comment, 'Why runIndex 15, not 0'); at the player's own placeholder spawn (world origin), this seed lands cleanly inside room 10 (21x18 m), 3 m clear of every wall — the frame shows that room's own dressed floor/walls/ceiling and whatever else falls inside the fixed 3/4 camera's frustum from that one point. It does NOT show the entry room, the stair room, the ramp/shaft, the vault rooms, or the whole 112x112 m zone (the camera never frames the whole zone, by design). Every wall/floor/ceiling/prop renders as a flat BLACK silhouette, camouflaged against the renderer's own black clear colour — the exact same, already-documented reason `wastes_seed_a`/`b` render their own props black: `materials.get()` (this ticket's own `build/bonereach.js`, same as `build/wastes.js`) returns a real `THREE.MeshStandardMaterial`, and no directional light exists anywhere in this codebase yet (`sky`, the subsystem that would add one, is unbuilt) — a PBR material with zero incident light renders pure black regardless of its own tint. What IS visible (the green wedges) is `src/dev/debugview.js`'s own pre-existing placeholder ground plane — deliberately `MeshBasicMaterial` (unlit, so it stays visible without a light source) — showing through wherever this ticket's own (real, present, but black-on-black) geometry does not cover it; read the black shapes as this ticket's own real T7 output and the green as pre-existing dev scaffolding this ticket did not touch, same as `wastes_seed_a`'s own note. HONEST LIMIT: nav/physics blocking for this zone comes from `gen/bonereach.js#toFootprints`'s own 'rock' footprints (root-rectangle-minus-rooms-minus-corridors), NOT from the visual room walls this frame shows — see that file's header for why (`src/nav/index.js#rebuild()` does not forward GroundRegions from any zone, a real, disclosed pre-existing gap this ticket found, not introduced).",
    milestone: 'M5',
    steps: 3,
    setup: (engine, ctx) => {
      const world = ctx.get('world');
      if (!world) return;
      world.requestZone('bonereach', 'descent', { runIndex: 15 });
    },
  },

  // AI-7 (D-69) — the fourth and last M5 shot. `12-testing.md` §9.1 assigns
  // `dense_combat` to M5 and `12`:625 requires it in the baseline; no
  // backlog row owned it until D-69 granted it here.
  //
  // ---------------------------------------------------------------------
  // Why runIndex 18 — measured headlessly first, not picked
  // ---------------------------------------------------------------------
  // `src/main.js` boots with `worldSeed = 0`, so a shot's only lever on
  // which layout it gets is `runIndex`. All 20 of `runIndex` 0-19 were run
  // headlessly through the real `world.enterZone` + this ticket's own
  // `zone:ready` spawn pass, counting how many monsters sit inside `06`
  // §10.3's 34 m activation radius of the biggest pack's centre — the
  // number that decides whether this frame is "dense combat" or "one pack
  // standing around". `runIndex 18` (seed `0xb9a10dca`) wins by a wide
  // margin: **6 of its 9 packs, 47 of its 68 monsters** activate together,
  // against 27 for the next best (16) and 7 for the worst (14). Measured,
  // not assumed — same discipline `wastes_seed_a`'s own entry used.
  //
  // ---------------------------------------------------------------------
  // THE BLOCKER a reviewer must know before looking at the pixels
  // ---------------------------------------------------------------------
  // **`AiSystem` is not registered in `src/main.js`.** `boot()`'s registry
  // (`src/main.js`:445-456) adds render/materials/physics/world/actors/
  // player/nav/combat/skills/ui/items/save — twelve systems, no `ai` — and
  // `index.html` calls `boot()` with no `opts.systems`, so the page
  // `tools/capture.mjs` drives has no `ai` subsystem at all. Nothing in
  // `src/ai/` has ever run in the real application; AI-2 through AI-7 are
  // reachable only from tests. `src/main.js` is lead-owned and outside
  // AI-7's file grant, so this is reported, not fixed.
  // CONSEQUENCE: until that one `registry.add(AiSystem)` line lands, this
  // shot's `setup` finds no `ai`, spawns nothing, and the captured frame is
  // `wastes_seed_*`'s Ashen Wastes at a different seed with NO monsters in
  // it. The `setup` below degrades to exactly that rather than throwing.
  //
  // ---------------------------------------------------------------------
  // What the frame will show ONCE `ai` is registered
  // ---------------------------------------------------------------------
  // Ashen Wastes at runIndex 18, the player teleported onto the centre of
  // the zone's biggest pack (8 `carrion_swarm`) with that pack's brains
  // hand-targeted at the player through `ai.setTarget` — the documented
  // hand-activation hook (`src/ai/index.js`'s own header, "`setTarget`
  // bypasses perception"), the same "reach a subsystem's real public
  // surface from a dev shot" licence `ui.toggleSkillTree()` /
  // `skills.allocate()` already take here. Measured on the headless run of
  // exactly this sequence: **47 monsters across 6 packs activate, 24 sit
  // within 25 m of the player, 17 within 18 m and 16 within 12 m**, and
  // after the 200 pumped steps the anchor pack has closed from 2.38-3.98 m to 0.03-0.65 m — a real
  // surrounded-by-a-swarm frame, which is what `dense_combat` is for
  // (`06` §10.3's "10-25 on screen" and, later, FX-5's `readability.mjs`).
  //
  // HONEST LIMITS, all of them:
  //  - Rendering: identical to `wastes_seed_a`/`b`'s — no `sky` subsystem
  //    exists, so nothing lights a `MeshStandardMaterial` and every monster
  //    and prop renders as a flat black silhouette; the green ground and
  //    the pale capsule are `src/dev/debugview.js`'s unlit placeholders.
  //  - Every pack in frame is a SINGLE archetype, not a mixed roster. That
  //    is not this file's templates failing: `src/world/spawn.js` step 2
  //    draws `PackDescriptor.archetypeId` uniformly from
  //    `descriptor.bestiary` (bestiary ids), while `06` §5.1 specifies
  //    `S3.weighted(bestiaryWeights(cell))` (template ids). Until `world`
  //    draws template ids, `ai.spawnPack` correctly takes the §5.1 bestiary
  //    branch — "a bestiary id spawns `count` identical monsters" — and no
  //    mixed pack can appear in ANY frame. Reported by AI-7, not fixed
  //    (`src/world/` is another subsystem's directory).
  //  - No damage is exchanged: `combat` resolves hits, but nothing here
  //    drives a player attack, so this is a converged-and-swinging frame,
  //    not a mid-kill one.
  //  - `steps: 200` is the convergence window measured above (the anchor
  //    pack reaches contact well inside it) plus room for the orbit-locked
  //    camera to settle, the same reasoning `inventory_full`'s `steps: 20`
  //    documents.
  dense_combat: {
    id: 'dense_combat',
    description: "Ashen Wastes, runIndex 18 (world seed 0, `world.seedFor('ashen_wastes',18)` = 0xb9a10dca) with AI-7's real zone:ready spawn pass: the player standing at the centre of the zone's largest pack while it and its neighbours converge. Measured headlessly on exactly this sequence: 9 packs / 68 monsters placed by world's WRLD-9 spawn plan, 6 packs / 47 monsters inside 06 §10.3's 34 m activation radius, 24 monsters within 25 m of the player, 17 within 18 m, 16 within 12 m, the 8-strong anchor pack (carrion_swarm) closed from 2.38-3.98 m to 0.03-0.65 m over the 200 pumped steps (each member really walked 1.93-3.94 m; measured at exactly step 200, not extrapolated). INCOMPLETE against 12-testing.md §9.1's own definition of this shot, deliberately and by scope: §9.1 asks for '22 monsters, 4 skill effects, 9 ground items'. The monster half is here (24 within 25 m). The other two thirds are NOT: no `fx` subsystem exists in this codebase at all (so no skill effect can be drawn), and nothing in this frame drops loot (no kill happens — see below), so there are 0 ground items. §9.1 also calls this 'the readability gate AND the performance gate' for readability.mjs/profile.mjs; as registered here it can serve neither yet. Whoever owns FX-5 and the loot half must extend THIS setup rather than register a second shot — 12 §9.3's own sanctioned 'a shot's setup grows, the name doesn't' pattern, the same way inventory_full grew in M4. KNOWN BLOCKER, read this before reading the pixels: AiSystem is NOT registered in src/main.js (boot()'s registry adds 12 systems and `ai` is not one of them; index.html passes no opts.systems), so nothing under src/ai/ runs in the real application at all — until one `registry.add(AiSystem)` line lands, this frame contains NO monsters and is simply the Ashen Wastes at a new seed. src/main.js is lead-owned and outside AI-7's grant; reported, not fixed. Same rendering caveats as wastes_seed_a/b, verbatim: no `sky` subsystem exists, so no light reaches any MeshStandardMaterial and every monster, prop and ridge renders as a flat black silhouette; the green ground plane and the pale capsule are src/dev/debugview.js's unlit MeshBasicMaterial placeholders, not this ticket's geometry. Every pack in frame is a SINGLE archetype rather than a mixed roster — src/world/spawn.js draws PackDescriptor.archetypeId uniformly from descriptor.bestiary (bestiary ids) where 06 §5.1 specifies S3.weighted(bestiaryWeights(cell)) (template ids), so ai.spawnPack correctly takes §5.1's 'a bestiary id spawns count identical monsters' branch and no mixed pack can appear in any frame yet; a world-side gap AI-7 reported and did not fix. No damage is exchanged in this frame: the pack is converged and swinging, nothing drives a player attack.",
    milestone: 'M5',
    steps: 200,
    // Zero free variables — see this file's header, "pumpShot — AND a
    // shot's own setup — must survive toString()+eval". Everything below is
    // reached through the injected `ctx`; the inner `zone:ready` listener
    // closes only over `setup`'s own parameter, the same pattern
    // `skill_tree_ravager`'s own `makeItem` already uses.
    setup: (engine, ctx) => {
      const world = ctx.get('world');
      if (!world) return;
      world.requestZone('ashen_wastes', 'portal_from_town', { runIndex: 18 });
      // `requestZone` only LATCHES; the real `enterZone` chain fires inside
      // the engine's phase 4b on the first pumped frame. The player can only
      // be moved onto a pack after that, so the rest hangs off `zone:ready`.
      ctx.events.on('zone:ready', () => {
        const ai = ctx.peek('ai');
        const actors = ctx.peek('actors');
        if (!ai || !actors || !ai._spawnStore) return; // see this entry's KNOWN BLOCKER
        const player = actors.player;
        const store = ai._spawnStore;
        if (!player || store.count === 0) return;
        let best = 0;
        for (let s = 1; s < store.count; s++) {
          if (store.memberCount[s] > store.memberCount[best]) best = s;
        }
        actors.teleport(player, store.centerX[best], store.centerZ[best]);
        for (let i = 0; i < store.memberCount[best]; i++) {
          const member = actors.byId(store.memberIds[store.memberStart[best] + i]);
          if (member) ai.setTarget(member, player.id);
        }
      });
    },
  },
};

/** @returns {string[]} every registered shot name, sorted. */
export function listShotNames() {
  return Object.keys(SHOTS).sort();
}

/**
 * @param {string} name
 * @returns {ShotDescriptor}
 * @throws if `name` is not registered — the message lists every valid name,
 *   so a typo'd `--shot` is diagnosable from the error alone.
 */
export function getShot(name) {
  const shot = SHOTS[name];
  if (!shot) {
    throw new Error(`shots.js: unknown shot "${name}" (valid: ${listShotNames().join(', ')})`);
  }
  return shot;
}

/**
 * The lockstep pump: runs `steps` fixed steps through `engine.frame(fixedDt)`
 * — never `requestAnimationFrame`, never a wall-clock `dt` — so a shot's
 * pixels are a pure function of the seed and the step count, not of how long
 * anything took to run (12-testing.md §9.2). Deliberately free of every
 * closure — see this file's header — so its source can be lifted verbatim
 * into a page context that has no access to this module at all.
 *
 * @param {{ frame: (dt: number) => number }} engine - anything shaped like
 *   `src/core/engine.js`'s `Engine` (duck-typed, not imported, so this stays
 *   evaluable outside this module's own realm).
 * @param {number} steps
 * @param {number} fixedDt
 * @returns {number} the number of steps actually pumped (always `steps`;
 *   returned so a caller can log/assert on it without re-deriving it).
 */
export function pumpShot(engine, steps, fixedDt) {
  let ran = 0;
  for (let i = 0; i < steps; i++) {
    engine.frame(fixedDt);
    ran += 1;
  }
  return ran;
}
