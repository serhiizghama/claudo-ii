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
  ui_clean: {
    id: 'ui_clean',
    description: "the UI overlay with no world behind it (12-testing.md §9.1) — the empty #ui skeleton (09 §15 U0) over a scene cleared of debugview.js's placeholder ground/capsule",
    milestone: 'M2',
    steps: 1,
    // Zero free variables — see this file's header, "pumpShot — AND a
    // shot's own setup — must survive toString()+eval". Reads/mutates only
    // its own `ctx` parameter.
    setup: (engine, ctx) => {
      const children = ctx.scene.children.slice();
      for (let i = 0; i < children.length; i++) ctx.scene.remove(children[i]);
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
