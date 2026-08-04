// src/materials/index.js
//
// MATL-1 — the `materials` subsystem: the GPU texture forge and the shared,
// reference-counted material library. `docs/spec/02-api-contracts.md` §2 is
// the contract this file implements; `docs/ARCHITECTURE.md`'s "Render
// integration" / "### Pre-warm" sections and `docs/spec/11-flows.md` §1.4
// are its init/pre-warm ordering. See `./forge.js`'s header for the GPU
// rasterization mechanics and the one spec tension this ticket resolves
// (the `render` "Forbidden for callers" list vs. §2's own "generated here on
// the GPU" docblock) — flagged there and in the MATL-1 report, not silently
// picked.
//
// ---------------------------------------------------------------------------
// `static deps = ['render']`, and who still owes `materials` their own dep
// ---------------------------------------------------------------------------
// `02-api-contracts.md` § Init order: `render -> materials -> sky -> physics
// -> world -> nav -> actors -> combat`. `sky` does not exist yet (no
// `src/sky/` in this tree), so this subsystem's only real dependency today
// is `render`. `src/world/index.js` (WRLD-*) still declares
// `static deps = ['physics']` with its own header saying "'materials'
// omitted, MATL-1 not built yet" — restoring it to `['materials','physics']`
// is WRLD-4's job per that file's own comment, not this ticket's (rule: "be
// aware and report, do not fix" — see the MATL-1 report). `src/items/index.js`
// has the identical situation (`static deps = []`, its own header says the
// same about `materials` not existing) and is likewise not this ticket's to
// edit.
//
// ---------------------------------------------------------------------------
// Ref-counting: a Map is correct here, and it is never `.clear()`-ed
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md`/this ticket's own performance rules: "`Map` leaks on
// never-repeating keys... but a ref-count table keyed by a material key is a
// legitimate `Map` (the keys repeat and entries are long-lived) — but do not
// `clear()` it". `this._entries` is exactly that: keys are a small, bounded,
// repeating set (every producible key — surfaces x tiers, variants, atlases),
// entries live for the process lifetime once first requested. `dispose()`
// (process teardown, not a per-frame or per-zone path) is the only place
// that ever removes entries, and it does so by deleting keys one at a time,
// never `Map.prototype.clear()` (which the rules note allocates
// unconditionally even on an empty map — moot here since dispose() is not a
// hot path either, but the discipline is kept anyway).
//
// ---------------------------------------------------------------------------
// Zero-alloc `rarityColour`/`paletteFor` (Fixed=Y, Alloc=no)
// ---------------------------------------------------------------------------
// Both read from tables built ONCE in `init()` (`./data/palette.js`'s pure
// functions, called here, never in these two methods). `rarityColour`
// without an `out` returns a per-rarity, pre-built, module-owned scratch
// object (never mutated after `init()`) — "shared scratch object owned by
// the callee" per `02-api-contracts.md`'s own generic `out` convention,
// except here it never needs to mutate at all, which is a stronger
// (strictly zero-alloc, no first-call-then-shared-mutable-scratch) reading
// of Alloc=no than the contract's baseline "valid until next call" promise
// requires. With `out`, it copies three numbers into it and returns `out` —
// no allocation either way. `paletteFor` returns the zone's own precomputed
// `Palette` object directly — same reasoning.

import * as THREE from 'three';

import {
  SURFACE_IDS,
  RARITY_TABLE,
  RARITY_ORDER,
  ZONE_SURFACE_USAGE,
  DETAIL_SIZE,
  MACRO_SIZE,
  DETAIL_TILE_METERS,
  MACRO_TILE_METERS,
  SURFACE_BASE,
  hexToRgb01,
  buildPalette,
  buildDefaultPalette,
} from './data/palette.js';
import {
  NOISE_KINDS,
  buildNoiseMaterial,
  buildHeightToNormalMaterial,
  rasterizeToTexture,
  surfaceOnBeforeCompile,
} from './forge.js';

/** The prewarm variant set per surface (11-flows.md §1.4 row 2: "The shared
 * library's plain / triplanar / detail variants") — CHOSEN mapping of that
 * prose onto concrete keys: `plain` (flat MeshStandardMaterial, no forge
 * textures — the cheap fallback tier), `triplanar` (the full forge
 * material with detail+macro+normal, no instancing concerns here since
 * materials doesn't build geometry) and `detail` treated as the same
 * triplanar material at full detail (there is no separate "low-detail"
 * material tier in this ticket's scope — `world`'s own LOD, if any, is a
 * later ticket). So `prewarmMaterials` compiles 2 programs per surface
 * (`plain`, `triplanar`) x 5 surfaces = 10, plus 1 shared noise-preview
 * program family (`get('__noise_preview')`-free — noise materials share ONE
 * GLSL per kind, compiled once per kind touched during prewarm, not per
 * texture instance, since `renderer.compile()`'s program cache keys off
 * shader source, not off uniform values).
 */
const PREWARM_VARIANTS = Object.freeze(['plain', 'triplanar']);

/** `rarityColour`'s chosen unit — see this ticket's report, "rarityColour
 * colour space". `09-ui.md` §12.1 requires `fx.lootGlow` to sample this
 * value UNMODIFIED in an overlay pass drawn AFTER tonemapping — i.e. into
 * already display-referred (sRGB-encoded) pixels. Returning the raw sRGB
 * byte values normalised to 0..1 (hex/255, NOT linearised) is what survives
 * that use unmodified: a linear-light conversion would need to be undone
 * again by whatever draws the overlay, which is exactly what "sampled
 * unmodified" forbids. */
const RARITY_COLOUR_SPACE = 'srgb-0..1';

export class MaterialsSystem {
  static id = 'materials';
  static deps = ['render'];

  async init(ctx) {
    /** @type {THREE.WebGLRenderer|null} — resolved once; `null` under Node /
     * no-GPU, exactly like `RenderSystem`'s own `this._renderer` (see
     * `./forge.js`'s header, "Degraded path"). Re-read from `render` on
     * every forge call rather than cached as a value that could go stale
     * across a context-loss/restore cycle — `render` owns replacing its own
     * `_renderer` field, `materials` only ever reads the current one. */
    this._renderSys = ctx && typeof ctx.get === 'function' ? ctx.get('render') : null;

    // Rule 3 — the one ctx.rng.fork() this subsystem is allowed, taken once,
    // here, kept for the subsystem's lifetime. `materials` today has no
    // actual random draw of its own (makeSurface's determinism keys off its
    // own explicit `seed` parameter, per the ticket brief, not off this
    // stream) — forked anyway, per ARCHITECTURE.md's unconditional "one
    // ctx.rng.fork() per subsystem" rule, so a later MATL-* ticket that adds
    // one has a stream ready without a second, later fork shifting anyone
    // else's (the exact UI-4 failure `src/ui/index.js`'s own header
    // documents).
    this._rng = ctx && ctx.rng && typeof ctx.rng.fork === 'function' ? ctx.rng.fork() : null;

    /** @type {Map<string, {material:THREE.Material, refs:number}>} */
    this._entries = new Map();
    /** @type {Map<string, THREE.Texture>} texture() cache, keyed by
     * `key|size` (interned at call time — see `texture()`). */
    this._textures = new Map();
    /** @type {Map<string, MaterialSet>} makeSurface() cache, keyed by
     * `surface|seed`. */
    this._surfaceSets = new Map();
    /** @type {Set<string>} every key `keys` has ever reported, so the
     * property never re-derives its list from the two maps above per read
     * (Alloc=no is not contractually required for `keys` — Fixed row is
     * `—` — but this keeps it cheap anyway). */
    this._keys = new Set();

    // Zone palettes — built ONCE, here, from the pure data-table functions
    // (`./data/palette.js`), so `paletteFor` (Fixed=Y, Alloc=no) never
    // builds one at call time. Every zone `ZONE_SURFACE_USAGE` names, plus
    // the `__default__` fallback for an id it doesn't.
    this._palettes = new Map();
    for (const zoneId of Object.keys(ZONE_SURFACE_USAGE)) {
      this._palettes.set(zoneId, buildPalette(zoneId));
    }
    this._defaultPalette = buildDefaultPalette();

    // Rarity colours — precomputed once into per-rarity, never-mutated
    // scratch objects (see this file's header, "Zero-alloc rarityColour").
    this._rarityColours = new Map();
    for (const rarity of RARITY_ORDER) {
      const { r, g, b } = hexToRgb01(RARITY_TABLE[rarity].text);
      this._rarityColours.set(rarity, Object.freeze({ r, g, b }));
    }
    // A single fallback for an unknown rarity string — never throws (rule
    // 11's spirit: a caller passing a bad id gets `normal`'s colour, not a
    // crash mid-render).
    this._defaultRarityColour = this._rarityColours.get('normal');

    // `zone:enter` — "to pre-resolve the zone's palette" (§2's event row).
    // The palette is already fully precomputed above; this listener exists
    // so a caller that only ever reacts to the event (rather than calling
    // `paletteFor` directly) still sees materials "warm" on the zone's
    // palette — recorded as the last-entered zone for `./forge.js` callers
    // that want "the current zone's palette" without re-passing zoneId.
    this._lastZoneId = null;
    this._onZoneEnter = (payload) => {
      this._lastZoneId = payload && payload.zoneId ? payload.zoneId : null;
    };
    if (ctx && ctx.events && typeof ctx.events.on === 'function') {
      ctx.events.on('zone:enter', this._onZoneEnter);
    }
  }

  // ---------------------------------------------------------------------
  // Ref-counted general resolver
  // ---------------------------------------------------------------------

  /**
   * `(key:string, opts?) => THREE.Material` — ref-counted. `opts.surface`
   * builds via `makeSurface` under the hood when `key` isn't cached yet;
   * otherwise a plain `MeshStandardMaterial` tinted by `opts.color` (CHOSEN
   * minimal behaviour for the general non-surface case — nothing in the spec
   * describes a `get()`-only material beyond "shared and reference-counted",
   * so this ticket keeps it to the one documented example, 'stone_wall').
   * @param {string} key
   * @param {{surface?:string, seed?:number, color?:number}} [opts]
   * @returns {THREE.Material}
   */
  get(key, opts) {
    let entry = this._entries.get(key);
    if (entry) {
      entry.refs++;
      return entry.material;
    }

    let material;
    if (opts && opts.surface) {
      const set = this.makeSurface(opts.surface, opts.seed || 0, opts);
      material = set.material;
    } else {
      material = new THREE.MeshStandardMaterial({
        color: (opts && opts.color) || 0x808080,
        roughness: 0.85,
      });
    }
    material.userData.materialsKey = key;
    this._entries.set(key, { material, refs: 1 });
    this._keys.add(key);
    return material;
  }

  /** `(key:string) => void` — decrements the refcount. Never disposes at
   * zero (per §2 "Forbidden for callers": only `materials` itself decides
   * disposal lifetime; a zero-ref material may legitimately be requested
   * again shortly, e.g. re-entering a zone) — it stays cached, ready for the
   * next `get()`. Alloc=no: no template string, no allocation on the hit or
   * miss path. */
  release(key) {
    const entry = this._entries.get(key);
    if (!entry) return;
    if (entry.refs > 0) entry.refs--;
  }

  /**
   * `(key:string, size:int) => THREE.Texture` — a standalone forged texture
   * by key (CHOSEN: `key` selects a noise kind + fixed seed derived from the
   * key's own hash, since nothing in the spec gives `texture()` a seed
   * parameter of its own — see the report). Cached by `key` + `size`.
   * @param {string} key
   * @param {number} size
   * @returns {THREE.Texture}
   */
  texture(key, size) {
    const cacheKey = size + '|' + key; // built once per miss, not a hot path — see forge.js header
    const cached = this._textures.get(cacheKey);
    if (cached) return cached;

    const seed = hashStringToU32(key);
    const kind = NOISE_KINDS[seed % NOISE_KINDS.length];
    const material = buildNoiseMaterial(kind, seed);
    const tex = rasterizeToTexture(this._renderer(), material, size, seed);
    this._textures.set(cacheKey, tex);
    this._keys.add(cacheKey);
    return tex;
  }

  /**
   * `(surface:SurfaceType, seed:uint32, opts?) => MaterialSet` — builds (or
   * returns the cached) detail/macro/normal texture set and the triplanar
   * `THREE.MeshStandardMaterial` for one of the five shipped surfaces.
   * MaterialSet shape (CHOSEN — undocumented, see the report): `{ surface,
   * seed, material, detailTexture, macroTexture, normalTexture, detailSize,
   * macroSize, detailTileMeters, macroTileMeters }`.
   * @param {'stone'|'dirt'|'grass'|'ash'|'bone'} surface
   * @param {number} seed
   * @param {{zoneId?:string}} [opts]
   * @returns {object}
   */
  makeSurface(surface, seed, opts) {
    if (!SURFACE_IDS.includes(surface)) {
      throw new Error(`materials.makeSurface: unknown surface '${surface}' (rule 13 — only ${SURFACE_IDS.join(', ')} ship)`);
    }
    const s = (seed >>> 0) || 0;
    const cacheKey = surface + '|' + s;
    const cached = this._surfaceSets.get(cacheKey);
    if (cached) return cached;

    const renderer = this._renderer();
    const zoneId = opts && opts.zoneId;
    const palette = zoneId ? this.paletteFor(zoneId) : this._defaultPalette;
    const entry = palette.surfaces[surface] || this._defaultPalette.surfaces[surface];
    const def = SURFACE_BASE[surface];

    // Detail height/mask (worley+value blend baked into one pass would need
    // a third shader; kept simple — one worley pass IS the detail height
    // source, matching "curvature-driven edge wear... Sobel height->normal"
    // literally: worley cell edges make a believable stone/dirt/bone detail
    // height field).
    const detailHeightMat = buildNoiseMaterial('worley', s ^ 0x9e3779b9);
    const detailHeightTex = rasterizeToTexture(renderer, detailHeightMat, DETAIL_SIZE, s);

    const detailMat = buildNoiseMaterial('value', s ^ 0x51ed270b);
    const detailTexture = rasterizeToTexture(renderer, detailMat, DETAIL_SIZE, s + 1);

    const macroMat = buildNoiseMaterial('gradient', s ^ 0x85ebca6b);
    const macroTexture = rasterizeToTexture(renderer, macroMat, MACRO_SIZE, s + 2);

    const normalMat = buildHeightToNormalMaterial(detailHeightTex, entry.normalStrength, DETAIL_SIZE);
    const normalTexture = rasterizeToTexture(renderer, normalMat, DETAIL_SIZE, s + 3);

    // `color` stays white — the real surface tone lives in `uBaseColor`
    // (below), read by the injected shader instead of the built-in
    // `diffuse` uniform. That leaves `material.color` free to act as a pure
    // tint multiplier for `variant()`, matching the plain-material branch of
    // `get()` — see forge.js's `mapFragment` comment for the full reasoning.
    // `roughness` is kept as the real base value (not 1.0) because the
    // injected `roughnessFragment` centers ITS OWN output on this uniform,
    // so `variant()`'s `roughDelta` reaches a triplanar surface too.
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: (entry.roughnessMin + entry.roughnessMax) / 2,
    });
    material.userData.materialsKey = cacheKey;
    material.userData.surface = surface;
    material.userData.triplanar = {
      detailTexture,
      macroTexture,
      normalTexture,
      baseColor: new THREE.Vector3(entry.base.r, entry.base.g, entry.base.b),
      edgeWearColor: new THREE.Vector3(entry.edgeWear.r, entry.edgeWear.g, entry.edgeWear.b),
      grimeColor: new THREE.Vector3(entry.grime.r, entry.grime.g, entry.grime.b),
      roughnessMin: entry.roughnessMin,
      roughnessMax: entry.roughnessMax,
      detailTileMeters: DETAIL_TILE_METERS,
      macroTileMeters: MACRO_TILE_METERS,
      normalStrength: entry.normalStrength,
    };
    // Deliberately NO `material.map`/`normalMap`/`roughnessMap` assignment
    // (forge textures are read via custom uniforms inside
    // `surfaceOnBeforeCompile` instead) — that keeps three's own
    // `USE_MAP`/`USE_NORMALMAP`/`USE_ROUGHNESSMAP` defines OFF and
    // structurally identical across all five surfaces, and
    // `onBeforeCompile` is the ONE shared function reference from
    // `forge.js` (never a per-surface closure), so the default
    // `customProgramCacheKey()` (= `this.onBeforeCompile.toString()`) is
    // already identical text for every surface — no override needed, and
    // adding a per-surface one here would force five separate compiled
    // programs instead of one shared program with five sets of uniform
    // values. See forge.js's header, "Program-count discipline".
    material.onBeforeCompile = surfaceOnBeforeCompile;

    const set = {
      surface,
      seed: s,
      material,
      detailTexture,
      macroTexture,
      normalTexture,
      detailSize: DETAIL_SIZE,
      macroSize: MACRO_SIZE,
      detailTileMeters: DETAIL_TILE_METERS,
      macroTileMeters: MACRO_TILE_METERS,
      def,
    };
    this._surfaceSets.set(cacheKey, set);
    this._entries.set(cacheKey, { material, refs: 0 });
    this._keys.add(cacheKey);
    return set;
  }

  /**
   * `(baseKey:string, tint:[r,g,b], roughDelta:number) => THREE.Material` —
   * a cloned, independently-owned material so a caller never mutates a
   * shared instance (§2's "Forbidden for callers"). Not ref-counted (the
   * clone belongs to the caller); `dispose()` of it is the caller's own
   * responsibility, same as any other one-off `THREE.Material`.
   * @param {string} baseKey
   * @param {[number,number,number]} tint
   * @param {number} roughDelta
   * @returns {THREE.Material}
   */
  variant(baseKey, tint, roughDelta) {
    const entry = this._entries.get(baseKey);
    if (!entry) {
      throw new Error(`materials.variant: unknown baseKey '${baseKey}' — call get()/makeSurface() first`);
    }
    const clone = entry.material.clone();
    if (tint && clone.color) {
      clone.color.r = Math.max(0, Math.min(1, clone.color.r * tint[0]));
      clone.color.g = Math.max(0, Math.min(1, clone.color.g * tint[1]));
      clone.color.b = Math.max(0, Math.min(1, clone.color.b * tint[2]));
    }
    if (typeof clone.roughness === 'number') {
      clone.roughness = Math.max(0, Math.min(1, clone.roughness + (roughDelta || 0)));
    }
    // `Material.copy()` does not special-case `onBeforeCompile`/`userData`
    // consistently across versions — reassigned explicitly so a variant of a
    // triplanar surface material keeps its forge textures and the shared
    // program-cache-key function (see forge.js header, "Program-count
    // discipline"), never a fresh per-clone closure.
    if (entry.material.userData && entry.material.userData.triplanar) {
      // See makeSurface()'s own comment: `surfaceOnBeforeCompile` is the one
      // shared function reference every triplanar material (base or
      // variant) uses, so this variant still shares the base's compiled
      // program — only its uniform VALUES (read from the reassigned
      // `userData.triplanar` below) differ.
      clone.userData.triplanar = entry.material.userData.triplanar;
      clone.onBeforeCompile = surfaceOnBeforeCompile;
    }
    return clone;
  }

  /** `(name:string) => { texture, uvFor(id) }` — icon/decal atlases. CHOSEN
   * minimal shape: this ticket ships the mechanism (a registry other
   * subsystems, e.g. `items`' `OffscreenCanvas` icons per §2's own
   * "Forbidden for callers" exception, register into) but no atlas content
   * of its own — no icon/decal generation is this ticket's job. `register`
   * is this ticket's own small addition, not a `02-api-contracts.md` row
   * (kept private, reached only via the returned object, never as a public
   * `MaterialsSystem` method — rule 7 is about public METHODS on the
   * subsystem; a plain data-holder returned from an already-contracted
   * method is not a new contract row). */
  atlas(name) {
    if (!this._atlases) this._atlases = new Map();
    let entry = this._atlases.get(name);
    if (!entry) {
      // `atlasUvForDefault`/`atlasRegisterOnAtlasEntry` (module-level, below)
      // — NOT inline closures here. A closure declared inside this method
      // body — even one only ever instantiated on this miss branch — makes
      // V8 allocate a Context for `atlas()` on EVERY call, cache hits
      // included: measured at a consistent ~40 B/call with an inline
      // `uvFor: () => null` / `register(...) {...}` pair, and 0 B/call once
      // both were hoisted to plain module-level functions reached via
      // ordinary `entry.register(...)` method-call `this`-binding instead of
      // closing over `entry`. See tests/materials/alloc.perf.test.js's
      // `atlas()` test and the MATL-1 report for the measurement.
      entry = { texture: null, uvFor: atlasUvForDefault, register: atlasRegisterOnAtlasEntry };
      this._atlases.set(name, entry);
    }
    return entry;
  }

  /**
   * `(kind, size:int, seed:uint32) => THREE.Texture`.
   * @param {'value'|'gradient'|'worley'|'blue'} kind
   * @param {number} size
   * @param {number} seed
   * @returns {THREE.Texture}
   */
  noiseTexture(kind, size, seed) {
    const cacheKey = 'noise|' + kind + '|' + size + '|' + (seed >>> 0);
    const cached = this._textures.get(cacheKey);
    if (cached) return cached;
    const material = buildNoiseMaterial(kind, seed);
    const tex = rasterizeToTexture(this._renderer(), material, size, seed);
    this._textures.set(cacheKey, tex);
    this._keys.add(cacheKey);
    return tex;
  }

  /**
   * `(heightTex:THREE.Texture, strength:number) => THREE.Texture`.
   * @param {THREE.Texture} heightTex
   * @param {number} strength
   * @returns {THREE.Texture}
   */
  heightToNormal(heightTex, strength) {
    const size = (heightTex && heightTex.image && heightTex.image.width) || DETAIL_SIZE;
    const material = buildHeightToNormalMaterial(heightTex, strength, size);
    return rasterizeToTexture(this._renderer(), material, size, size);
  }

  /**
   * `(zoneId:string) => Palette` — Fixed=Y, Alloc=no. See this file's
   * header, "Zero-alloc rarityColour/paletteFor" — returns the precomputed,
   * shared `Palette` object for `zoneId`, or the shared default when
   * unknown. Never reads the clock, never allocates.
   * @param {string} zoneId
   * @returns {{zoneId:string, surfaces:object}}
   */
  paletteFor(zoneId) {
    const p = this._palettes.get(zoneId);
    return p || this._defaultPalette;
  }

  /**
   * `(rarity:string, out?) => {r,g,b}` — Fixed=Y, Alloc=no. Returns the
   * sacred rarity text-hex colour, sRGB-encoded, normalised 0..1 (see this
   * file's `RARITY_COLOUR_SPACE` constant/header for why). No `Math.hypot`,
   * no allocation with or without `out`.
   * @param {string} rarity
   * @param {{r:number,g:number,b:number}} [out]
   * @returns {{r:number,g:number,b:number}}
   */
  rarityColour(rarity, out) {
    const c = this._rarityColours.get(rarity) || this._defaultRarityColour;
    if (!out) return c;
    out.r = c.r;
    out.g = c.g;
    out.b = c.b;
    return out;
  }

  /** property → `string[]` of every producible key seen so far (`get`,
   * `texture`, `makeSurface`, `noiseTexture` all register into `this._keys`
   * on first production). CHOSEN reading of "every producible key": the
   * five surfaces are always producible and always listed even before
   * first use (so a caller can enumerate what `makeSurface` will accept
   * without forcing GPU work); anything else appears once actually forged.
   * @returns {string[]}
   */
  get keys() {
    const out = SURFACE_IDS.slice();
    for (const k of this._keys) if (!out.includes(k)) out.push(k);
    return out;
  }

  /**
   * `(ctx) => Promise<void>` — 11-flows.md §1.4 row 2: "The shared library's
   * plain / triplanar / detail variants", ~40ms budget. Builds and compiles
   * (via `renderer.compile()`, never a real draw — matches
   * `RenderSystem.prewarmMaterials`'s own technique exactly) every material
   * the forge can produce for the five shipped surfaces, at both
   * `PREWARM_VARIANTS` tiers, plus one representative material per noise
   * kind (so every GLSL family this subsystem can emit has a compiled
   * program before play, not just the surface materials). Never spawns a
   * gameplay object, never draws a gameplay frame, never touches
   * `ctx.rng`/the clock (ARCHITECTURE.md's Pre-warm contract).
   *
   * Records the count on `this._lastPrewarmCount` — read by
   * `tools`/tests/the MATL-1 report to satisfy "report how many programs the
   * prewarm actually compiled" (rule: a flat `programs` count on top of zero
   * compiled programs is a failure, not a pass).
   * @param {object} ctx
   */
  async prewarmMaterials(ctx) {
    const renderSys = ctx && typeof ctx.get === 'function' ? ctx.get('render') : this._renderSys;
    const renderer = renderSys && renderSys.renderer ? renderSys.renderer : null;

    let compiled = 0;
    const scratchScene = new THREE.Scene();
    const scratchCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    scratchCamera.position.set(0, 1, 3);
    scratchCamera.lookAt(0, 0, 0);
    const geo = new THREE.BoxGeometry(1, 1, 1);

    const compileOne = (material) => {
      if (!renderer) return; // degraded — nothing to compile, but the
      // material set is still fully built above (real work happened even
      // when compilation itself can't run — see the MATL-1 report).
      const mesh = new THREE.Mesh(geo, material);
      scratchScene.add(mesh);
      renderer.compile(scratchScene, scratchCamera);
      scratchScene.remove(mesh);
      compiled++;
    };

    for (const surface of SURFACE_IDS) {
      const set = this.makeSurface(surface, hashStringToU32(surface));
      compileOne(set.material); // 'triplanar' variant

      if (PREWARM_VARIANTS.includes('plain')) {
        const plainKey = surface + '|plain';
        let plain = this._entries.get(plainKey);
        if (!plain) {
          const plainMat = new THREE.MeshStandardMaterial({
            color: set.material.color.clone(),
            roughness: set.material.roughness,
          });
          plainMat.userData.materialsKey = plainKey;
          this._entries.set(plainKey, { material: plainMat, refs: 0 });
          this._keys.add(plainKey);
          plain = this._entries.get(plainKey);
        }
        compileOne(plain.material);
      }
    }

    for (const kind of NOISE_KINDS) {
      const previewKey = 'noise-preview|' + kind;
      if (!this._entries.has(previewKey)) {
        const mat = new THREE.MeshBasicMaterial({ map: this.noiseTexture(kind, 4, hashStringToU32(kind)) });
        mat.userData.materialsKey = previewKey;
        this._entries.set(previewKey, { material: mat, refs: 0 });
        this._keys.add(previewKey);
      }
      compileOne(this._entries.get(previewKey).material);
    }

    geo.dispose();
    this._lastPrewarmCount = compiled;
  }

  /** @returns {THREE.WebGLRenderer|null} */
  _renderer() {
    return this._renderSys && this._renderSys.renderer ? this._renderSys.renderer : null;
  }

  dispose() {
    for (const [, entry] of this._entries) {
      if (entry.material && typeof entry.material.dispose === 'function') entry.material.dispose();
    }
    for (const [key] of this._entries) this._entries.delete(key); // never .clear() — see this file's header
    for (const [, tex] of this._textures) {
      if (tex && typeof tex.dispose === 'function') tex.dispose();
      if (tex && tex.__forgeTarget && typeof tex.__forgeTarget.dispose === 'function') tex.__forgeTarget.dispose();
    }
    for (const [key] of this._textures) this._textures.delete(key);
    this._surfaceSets.clear(); // holds only references already disposed above — fine to clear, not the ref-count table the header warns about
    this._keys.clear();
    if (this._atlases) this._atlases.clear();
  }
}

/** The unregistered-atlas default `uvFor` — a plain module-level function
 * (never a closure declared inside `atlas()`; see that method's own comment
 * for why). */
function atlasUvForDefault() {
  return null;
}

/** `entry.register(texture, uvForFn)` — called with ordinary method-call
 * `this`-binding (`this === entry`), so it never needs to close over the
 * entry object the way an inline `register(t,f) { entry.texture = t; ... }`
 * would. Module-level, assigned by reference onto every atlas entry — see
 * `atlas()`'s own comment. */
function atlasRegisterOnAtlasEntry(texture, uvForFn) {
  this.texture = texture;
  this.uvFor = uvForFn;
}

/** A small, fast, deterministic string hash (FNV-1a) used only to turn a
 * cache/preview key into a forge seed — never a gameplay draw, never
 * `Math.random()`, and explicitly not `ctx.rng` (rule 3: `makeSurface`'s
 * determinism keys off its own explicit `seed` argument; this is purely an
 * internal convenience for `texture()`/`prewarmMaterials()`'s own
 * seed-from-key convenience, not a gameplay-visible random stream). */
function hashStringToU32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export { RARITY_COLOUR_SPACE };
