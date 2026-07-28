// src/dev/debugview.js
//
// TEMPORARY — M0 ONLY. Replaced wholesale by `ACTR-6` (the real actor
// mesh/skeleton) and `world` (the real ground/terraces) — see
// docs/ARCHITECTURE.md's ownership map. This file exists only so PLYR-1's
// acceptance criterion ("a capsule walks to the clicked point", checked live
// in a browser) is observable at all: today the scene is otherwise a bare
// colour-clear, no mesh anywhere. Explicitly authorised by PLYR-1's brief,
// on exactly these terms — see that ticket's report.
//
// Lives in `src/dev/` (the harness/orchestrator directory `src/dev/shots.js`,
// TEST-3, already occupies), never in `src/player/` or `src/actors/`: `three`
// is fine here, unlike in `src/player/` (which must stay Node-loadable — see
// that file's header).
//
// ---------------------------------------------------------------------------
// How this gets driven — not through the registry
// ---------------------------------------------------------------------------
// This is not a subsystem: no `static id`/`static deps`, never passed to
// `registry.add()`. docs/PROGRESS.md O-12 grants each ticket exactly two
// `src/main.js` lines, by name; PLYR-1's grant was spent registering
// `PlayerSystem`. Instead, `src/player/index.js#init()` dynamically
// `import()`s this module — gated behind `typeof window !== 'undefined'`, a
// runtime check, so `src/player/`'s own static import graph never mentions
// `three` or this file — and drives `update()`/`dispose()` on it directly.
// See that file's header, "The dev-only capsule/ground view".
//
// ---------------------------------------------------------------------------
// Position source: the same `renderX`/`renderZ` substitute `player` uses
// ---------------------------------------------------------------------------
// `11-flows.md` says the capsule must follow the actor's interpolated
// (`renderX`/`renderZ`) position, never the raw simulation (`x`/`z`) one —
// but ACTR-1 does not implement the `actors` interpolation `update()` yet
// (`renderX`/`renderZ` are set once at spawn and never touched again; see
// `src/player/index.js`'s header, "The renderX/renderZ gap", for the full
// reasoning). This file cannot reach `player`'s private computed value
// (there is no runtime path between two non-subsystem, undriven modules), so
// `update()` below recomputes the identical `lerp(prevX, x, alpha)` locally
// from the same actor record — three lines, duplicated on purpose rather
// than coupled, since both call sites are meant to collapse to
// `actor.renderX`/`renderZ` the moment that field is real.
//
// Zero allocation per frame (rule 6): only `.position.set()` on already-built
// meshes. Everything built in `init()` is freed in `dispose()`.
//
// ---------------------------------------------------------------------------
// Materials are `MeshBasicMaterial` — unlit — ON PURPOSE, do not "upgrade"
// ---------------------------------------------------------------------------
// The scene carries ZERO lights: `render.addLight` is a documented but
// unimplemented row of `02-api-contracts.md` §1 (a later RNDR ticket), and
// `sky` (the other plausible light source) does not exist before M8. A
// physically-based material (`MeshStandardMaterial`/`MeshPhysicalMaterial`)
// renders flat black with no light to reflect — confirmed live: PLYR-1's
// first pass used `MeshStandardMaterial` and `tools/capture.mjs --shot
// boot_clean` came back `nonBlankPixels=0/921600`, a fully black frame,
// geometry drawn (`drawCalls:3`) but invisible. `MeshBasicMaterial` ignores
// lighting entirely and paints exactly its own `color` — the only material
// type that is guaranteed visible in a zero-light scene. Do not add a light
// to fix this instead: `ARCHITECTURE.md`'s "Render integration" section
// warns that the *visible* point-light count is baked into every shader
// program's cache key, so an uncoordinated light here would recompile every
// lit material in the scene the moment `render`/`sky` add their own later —
// the exact 640-900 ms hitch class that section documents. Real lighting
// arrives with `sky`/`RNDR-4` in M8; this file goes back to a lit material
// only when that lands (and likely not even then — ACTR-6/`world` replace
// these meshes outright before it matters).

import * as THREE from 'three';

/** Metres. ASSIGNED — plenty of room for an M0 empty-scene click-to-move
 * check; `world`'s real zone bounds replace this outright. */
const GROUND_SIZE = 40;

/** Placeholder colours only — `materials`/`world` own real art (M1/M5+).
 * Chosen so the capsule, the ground and the renderer's clear colour
 * (`0x0b0e14`, `src/render/index.js`) are all clearly distinct under the
 * unlit `MeshBasicMaterial` above (no light to shade any of them toward
 * black) — this is a debug view; readability is the whole job. */
const GROUND_COLOR = 0x3a4a35;
const CAPSULE_COLOR = 0xd8c9a0;

/** Fallback capsule dimensions if no player actor exists yet at `init()`
 * time (should not happen — `player.init()` spawns one first — but this
 * file has no reason to assume that ordering forever). Matches
 * `src/actors/pool.js`'s own `DEFAULT_ACTOR_RADIUS`/`DEFAULT_ACTOR_HEIGHT`. */
const FALLBACK_RADIUS = 0.36;
const FALLBACK_HEIGHT = 1.8;

export class DebugView {
  constructor() {
    this._groundGeometry = null;
    this._groundMaterial = null;
    this._groundMesh = null;
    this._capsuleGeometry = null;
    this._capsuleMaterial = null;
    this._capsuleMesh = null;
  }

  /**
   * Builds both meshes and adds them to `ctx.scene`. `Alloc: yes` — called
   * exactly once, from `player.init()`, never per-frame (rule 6 governs the
   * frame-critical path only).
   * @param {{scene:object, get:(id:string)=>object}} ctx
   */
  init(ctx) {
    this._groundGeometry = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
    // MeshBasicMaterial — unlit, on purpose. See the file header,
    // "Materials are MeshBasicMaterial ... do not upgrade".
    this._groundMaterial = new THREE.MeshBasicMaterial({ color: GROUND_COLOR });
    this._groundMesh = new THREE.Mesh(this._groundGeometry, this._groundMaterial);
    this._groundMesh.rotation.x = -Math.PI / 2; // lay flat on XZ, normal up +Y
    this._groundMesh.position.set(0, 0, 0);
    ctx.scene.add(this._groundMesh);

    const actor = ctx.get('actors').player;
    const radius = (actor && actor.radius) || FALLBACK_RADIUS;
    const height = (actor && actor.height) || FALLBACK_HEIGHT;
    // THREE.CapsuleGeometry(radius, height, capSegments, radialSegments):
    // its own `height` param is only the straight middle section — the two
    // hemispherical caps add `radius` on each end. Solve for that middle
    // section so the whole capsule's total height matches the actor's.
    const middle = Math.max(height - radius * 2, 0.01);
    this._capsuleGeometry = new THREE.CapsuleGeometry(radius, middle, 4, 8);
    // MeshBasicMaterial — unlit, on purpose. See the file header,
    // "Materials are MeshBasicMaterial ... do not upgrade".
    this._capsuleMaterial = new THREE.MeshBasicMaterial({ color: CAPSULE_COLOR });
    this._capsuleMesh = new THREE.Mesh(this._capsuleGeometry, this._capsuleMaterial);
    ctx.scene.add(this._capsuleMesh);

    this.update(0, ctx); // correctly placed before the first real frame
  }

  /**
   * Zero allocation — mutates the existing capsule's position in place.
   * @param {number} dt - unused; kept for shape-parity with the subsystem
   *   `update(dt, ctx)` convention `player` calls this through.
   * @param {object} ctx
   */
  update(dt, ctx) { // eslint-disable-line no-unused-vars
    const actor = ctx.get('actors').player;
    if (!actor || !this._capsuleMesh) return;

    // See the file header, "Position source" — the renderX/renderZ
    // substitute, computed locally rather than read off a field nobody
    // writes yet.
    const alpha = ctx.time ? ctx.time.alpha : 0;
    const x = actor.prevX + (actor.x - actor.prevX) * alpha;
    const y = actor.prevY + (actor.y - actor.prevY) * alpha;
    const z = actor.prevZ + (actor.z - actor.prevZ) * alpha;

    // The capsule geometry is centred on its own middle; lift it so its
    // base sits at ground level (actor.y is the feet height, per
    // 01-data-model.md §2).
    this._capsuleMesh.position.set(x, y + actor.height / 2, z);
  }

  /** Removes both meshes from their parent and frees every GPU resource
   * this file allocated. Safe to call more than once. */
  dispose() {
    if (this._groundMesh) {
      if (this._groundMesh.parent) this._groundMesh.parent.remove(this._groundMesh);
      this._groundMesh = null;
    }
    if (this._capsuleMesh) {
      if (this._capsuleMesh.parent) this._capsuleMesh.parent.remove(this._capsuleMesh);
      this._capsuleMesh = null;
    }
    if (this._groundGeometry) {
      this._groundGeometry.dispose();
      this._groundGeometry = null;
    }
    if (this._groundMaterial) {
      this._groundMaterial.dispose();
      this._groundMaterial = null;
    }
    if (this._capsuleGeometry) {
      this._capsuleGeometry.dispose();
      this._capsuleGeometry = null;
    }
    if (this._capsuleMaterial) {
      this._capsuleMaterial.dispose();
      this._capsuleMaterial = null;
    }
  }
}
