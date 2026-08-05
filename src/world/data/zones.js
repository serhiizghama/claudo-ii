// src/world/data/zones.js
//
// WRLD-1 — the four `ZoneDescriptor`s (01-data-model.md §9.1's shape),
// exactly the "gameplay numbers live in data, not in code" split
// ARCHITECTURE.md rule 9 requires. Node-safe: no `three`, no `document`/
// `window`/`performance.now()` — checked by `tools/check-imports.mjs`,
// which names `src/world/data/` as one of its five required roots.
//
// ---------------------------------------------------------------------------
// Sourcing, per zone — see this ticket's report for the full reasoning
// ---------------------------------------------------------------------------
// - `ashen_wastes`: 01-data-model.md §9.1's own worked example, copied
//   verbatim (every field).
// - `last_bastion`: 07-world-gen.md §2.1's own descriptor, copied verbatim
//   (every field).
// - `bonereach` / `altar_of_instruction`: `id`/`displayName`/`kind`/`sizeX`/
//   `sizeZ`/`monsterLevel` come from 01 §9.1's four-zone summary table;
//   `generator` is read off that same table's own comment enum
//   (`'bsp_rooms'` for `kind:'dungeon'`, `'arena'` for `kind:'arena'`);
//   `surfaces` come from 07-world-gen.md §1.6's per-zone surface table.
//   Every other field (packCount, packSize, densityTarget, champChance,
//   uniqueChance, bestiary, lightingPreset, fogPreset, ambientAudio,
//   treasureClass, exits, entryTags, chestCount, propBudget) is not given
//   anywhere in this ticket's authorized reading — 07-world-gen.md §§4-5,
//   where the real Bonereach/Altar generators (and presumably these
//   numbers) live, are out of WRLD-1's scope (the backlog's two-file rule:
//   "a ticket that needs a fourth file is two tickets", and §§4/5 belong to
//   WRLD-9/WRLD-10 per 07 §12 steps 9-10). Every such field below is
//   marked ASSIGNED and is a placeholder for whichever later ticket
//   actually builds that zone's content. Two cross-references were
//   possible without reading §§4/5 and are used instead of inventing
//   values: `bonereach.entryTags` includes `'descent'`, the exact tag
//   `ashen_wastes.exits[0].tag` already uses; `altar_of_instruction
//   .entryTags` includes `'altar_entry'`, the exact tag
//   `bonereach.exits[0].tag` uses.

/** Placeholder perimeter-wall collider dimensions — WRLD-1's own stand-in
 * geometry (see `src/world/index.js`'s header for why a wall exists at
 * all). No spec value exists for either number; both are ASSIGNED. Real
 * per-zone geometry (props, terrain, ravines, halls) replaces this
 * entirely in the tickets that build each generator (07 §12 steps 3, 6, 9,
 * 10). Kept here, not in `index.js`, per rule 9 — even a placeholder
 * number is a number, not code. */
export const BOUNDARY_WALL_THICKNESS = 0.5; // metres — ASSIGNED
export const BOUNDARY_WALL_HEIGHT = 4.0; // metres — ASSIGNED

export const ZONE_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: 'last_bastion',
    displayName: 'Last Bastion',
    kind: 'town',
    generator: 'handauthored',
    sizeX: 60,
    sizeZ: 60,
    cellSize: 0,
    monsterLevel: 0,
    packCount: Object.freeze({ min: 0, max: 0 }),
    packSize: Object.freeze({ min: 0, max: 0 }),
    densityTarget: 0,
    champChance: 0,
    uniqueChance: 0,
    bestiary: Object.freeze([]),
    surfaces: Object.freeze(['stone', 'dirt', 'sand', 'water']),
    lightingPreset: 'bastion_night',
    fogPreset: 'bastion',
    ambientAudio: 'bastion',
    treasureClass: null,
    exits: Object.freeze([Object.freeze({ toZone: 'ashen_wastes', tag: 'portal_from_town' })]),
    entryTags: Object.freeze(['town_start', 'from_wastes', 'town_portal_return']),
    chestCount: Object.freeze({ min: 0, max: 0 }),
    propBudget: 520,
  }),
  Object.freeze({
    id: 'ashen_wastes',
    displayName: 'Ashen Wastes',
    kind: 'open',
    generator: 'ridgewalk',
    sizeX: 96,
    sizeZ: 96,
    cellSize: 24,
    monsterLevel: 6,
    packCount: Object.freeze({ min: 9, max: 14 }),
    packSize: Object.freeze({ min: 5, max: 12 }),
    densityTarget: 0.0125,
    champChance: 0.16,
    uniqueChance: 0.06,
    bestiary: Object.freeze(['bone_ranker', 'carrion_swarm', 'ashen_archer', 'dust_shaman', 'blight_crawler']),
    surfaces: Object.freeze(['ash', 'dirt', 'stone', 'bone']),
    lightingPreset: 'wastes_dusk',
    fogPreset: 'wastes',
    ambientAudio: 'wastes',
    treasureClass: 'tc_wastes',
    exits: Object.freeze([Object.freeze({ toZone: 'bonereach', tag: 'descent' })]),
    entryTags: Object.freeze(['portal_from_town', 'descent_return']),
    chestCount: Object.freeze({ min: 2, max: 4 }),
    propBudget: 900,
  }),
  Object.freeze({
    id: 'bonereach',
    displayName: 'Bonereach',
    kind: 'dungeon',
    generator: 'bsp_rooms',
    sizeX: 112,
    sizeZ: 112,
    cellSize: 0,
    monsterLevel: 11,
    // Below this line: ASSIGNED — 07 §4 (the BSP hall generator) is out of
    // this ticket's scope; these are placeholders for WRLD-9.
    packCount: Object.freeze({ min: 10, max: 16 }), // ASSIGNED
    packSize: Object.freeze({ min: 4, max: 10 }), // ASSIGNED
    densityTarget: 0.014, // ASSIGNED
    champChance: 0.18, // ASSIGNED
    uniqueChance: 0.05, // ASSIGNED
    // 07 §4.1, verbatim. `maulsmith` is listed there as `hammerfell_brute` —
    // the same archetype under its pre-D-2 name (06 §15 D-2, §5.4).
    bestiary: Object.freeze(['bone_ranker', 'ashen_archer', 'dust_shaman', 'maulsmith',
      'blight_crawler', 'carrion_swarm']),
    surfaces: Object.freeze(['stone', 'bone', 'dirt', 'water']),
    lightingPreset: 'bonereach_dark', // ASSIGNED
    fogPreset: 'bonereach', // ASSIGNED
    ambientAudio: 'bonereach', // ASSIGNED
    treasureClass: 'tc_bonereach', // ASSIGNED
    exits: Object.freeze([Object.freeze({ toZone: 'altar_of_instruction', tag: 'altar_entry' })]), // ASSIGNED
    // 'descent' matches ashen_wastes.exits[0].tag above — a real
    // cross-reference, not an invention.
    entryTags: Object.freeze(['descent', 'altar_return']), // ASSIGNED
    chestCount: Object.freeze({ min: 1, max: 3 }), // ASSIGNED
    propBudget: 650, // ASSIGNED
  }),
  Object.freeze({
    id: 'altar_of_instruction',
    displayName: 'Altar of Instruction',
    kind: 'arena',
    generator: 'arena',
    sizeX: 48,
    sizeZ: 48,
    cellSize: 0,
    monsterLevel: 15,
    // Below this line: ASSIGNED — 07 §5 (the fixed arena) is out of this
    // ticket's scope; these are placeholders for WRLD-10.
    packCount: Object.freeze({ min: 1, max: 1 }), // ASSIGNED — a single boss pack
    packSize: Object.freeze({ min: 1, max: 6 }), // ASSIGNED — boss + adds
    densityTarget: 0, // ASSIGNED — fixed arena, not density-placed
    champChance: 0, // ASSIGNED
    uniqueChance: 0, // ASSIGNED
    bestiary: Object.freeze(['bone_ranker', 'ashen_archer']), // 07 §5.1, verbatim — the approach packs; Molgrim himself is M6
    surfaces: Object.freeze(['stone', 'ash', 'bone']),
    lightingPreset: 'altar_instruction', // ASSIGNED
    fogPreset: 'altar', // ASSIGNED
    ambientAudio: 'altar', // ASSIGNED
    treasureClass: 'tc_altar', // ASSIGNED
    exits: Object.freeze([]), // ASSIGNED — dead end pending WRLD-10
    // 'altar_entry' matches bonereach.exits[0].tag above.
    entryTags: Object.freeze(['altar_entry']), // ASSIGNED
    chestCount: Object.freeze({ min: 0, max: 0 }), // ASSIGNED
    propBudget: 300, // ASSIGNED
  }),
]);

/** `zoneId -> ZoneDescriptor`, built once at module load for
 * `world.descriptor()`'s O(1) lookup — never rebuilt, never mutated. */
export const ZONE_DESCRIPTORS_BY_ID = Object.freeze(
  ZONE_DESCRIPTORS.reduce((acc, d) => {
    acc[d.id] = d;
    return acc;
  }, {}),
);
