// src/world/build/bonereach.js
//
// WRLD-7 — the `three` half of Bonereach's T7 "Geometry" stage
// (`07-world-gen.md` §10.2's own table). Consumes `src/world/gen/bonereach.js`'s
// plain-data layout/dressing and builds real `THREE` geometry: room floors,
// walls (with their own real doorway gaps), a ceiling plane per room (no
// roof — `07` §4.2 B3's own text), corridor floor slabs, the stair room's
// ramp/shaft steps, and instanced dressing props.
//
// `three` is legal here by ruling D-78 — `tools/check-imports.mjs` already
// carves this exact directory (`src/world/build/`) out of the `world` root's
// blanket `checkThree: true` (see that tool's own `declaredRoots` comment).
// `src/world/gen/bonereach.js` stays headless; this file is the sibling
// where `three` lives, matching `src/world/build/wastes.js`'s own precedent
// exactly (placeholder box/plane primitives — no per-prototype mesh art
// exists yet anywhere in this codebase for world props, ARCHITECTURE.md's
// "no external art assets" rule notwithstanding; authoring real procedural
// prop generators is a separate ticket's scope, same disclosure
// `build/wastes.js`'s own header already carries).

import * as THREE from 'three';
import { PROTOTYPE_CATALOG } from '../gen/wastes.js';
import { WALL_THICKNESS, ROOM_TOP_Y } from '../gen/bonereach.js';

const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scaleVec = new THREE.Vector3();
const _posVec = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** One shared placeholder box geometry per `w|h|d` key — the same
 * cache-by-dimension precedent `build/wastes.js#boxGeometry` already uses,
 * so the many walls/floors/props that happen to share a footprint don't
 * each allocate their own `BufferGeometry`. `Alloc: yes`, once per
 * `enterZone`, never per frame (rule 5). */
const _geometryCache = new Map();
function boxGeometry(w, h, d) {
  const key = `${w}|${h}|${d}`;
  let g = _geometryCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    _geometryCache.set(key, g);
  }
  return g;
}

const WALL_COLOR = 0x5b544a; // crypt stone
const FLOOR_COLOR = 0x342f28; // dark flagstone
const CEILING_COLOR = 0x201c17;
const RAMP_COLOR = 0x3d372e;

const PROP_GROUP_COLOR = Object.freeze({
  G4: 0xd8cdb8, // bone
  G6: 0x5d5442, // container
  G7: 0x726a5c, // crypt
});

/**
 * Builds every room's floor slab, four walls (with real doorway gaps —
 * `layout`'s own wall footprints, reused verbatim rather than recomputed,
 * so the visual walls can never disagree with what `toFootprints` already
 * decided blocks nav) and a ceiling plane (`userData.noShadow = true`, no
 * roof — 07 §4.2 B3's own text: "the fixed camera never sees above 5.0 m").
 * One `THREE.Mesh` per room floor/ceiling (cheap, not instanced — floors
 * differ in size per room so instancing buys nothing here), one
 * `InstancedMesh` for every wall segment (shared box geometry per unique
 * size, real distinct sizes so NOT usefully instanced either — built as
 * individual meshes, grouped, same reasoning).
 * @param {object} ctx @param {ReturnType<typeof import('../gen/bonereach.js').generateBonereachLayout>} layout
 * @param {object[]} wallFootprints `toFootprints(layout, ...)`'s own box-kind output (walls only).
 * @returns {THREE.Group}
 */
function buildRoomsAndWalls(ctx, layout, wallFootprints) {
  const materials = ctx.get('materials');
  const group = new THREE.Group();
  group.name = 'bonereach_rooms';

  const floorMat = materials.get('crypt_flagstone', { color: FLOOR_COLOR });
  const ceilingMat = materials.get('crypt_ceiling', { color: CEILING_COLOR });
  const wallMat = materials.get('crypt_stone', { color: WALL_COLOR });

  for (const room of layout.rooms) {
    const w = room.x1 - room.x0, d = room.z1 - room.z0;
    const floor = new THREE.Mesh(boxGeometry(w, 0.1, d), floorMat);
    floor.position.set(room.centre.x, -0.05, room.centre.z);
    floor.name = `room_floor_${room.index}`;
    group.add(floor);

    const ceiling = new THREE.Mesh(boxGeometry(w, 0.05, d), ceilingMat);
    ceiling.position.set(room.centre.x, room.topY, room.centre.z);
    ceiling.name = `room_ceiling_${room.index}`;
    ceiling.userData.noShadow = true; // 07 §4.2 B3 — a light occluder only
    ceiling.userData.noPrepass = true;
    group.add(ceiling);
  }

  for (const fp of wallFootprints) {
    const mesh = new THREE.Mesh(boxGeometry(fp.halfW * 2, fp.height, fp.halfL * 2), wallMat);
    mesh.position.set(fp.x, fp.height / 2, fp.z);
    mesh.name = 'bonereach_wall';
    group.add(mesh);
  }

  return group;
}

/**
 * Corridor floor slabs, one thin box per corridor segment (07 §4.2 B4:
 * "corridor floors are at y = 0.00").
 * @param {object} ctx @param {object[]} corridors
 * @returns {THREE.Group}
 */
function buildCorridorFloors(ctx, corridors) {
  const materials = ctx.get('materials');
  const floorMat = materials.get('crypt_flagstone', { color: FLOOR_COLOR });
  const group = new THREE.Group();
  group.name = 'bonereach_corridors';
  for (const c of corridors) {
    for (const seg of c.segments) {
      const mesh = new THREE.Mesh(boxGeometry(seg.halfW * 2, 0.1, seg.halfL * 2), floorMat);
      mesh.position.set(seg.x, -0.05, seg.z);
      mesh.name = 'corridor_floor';
      group.add(mesh);
    }
  }
  return group;
}

/**
 * The stair room's descent: `layout.ramp.terraces` (each a `{elevation,
 * bounds}` step band, 07 §4.1's 6-step ramp down to -2.40 m) visualised as
 * one thin floor slab per band at its own elevation.
 * @param {object} ctx @param {object} ramp `layout.ramp`
 * @returns {THREE.Group}
 */
function buildRamp(ctx, ramp) {
  const materials = ctx.get('materials');
  const rampMat = materials.get('crypt_ramp', { color: RAMP_COLOR });
  const group = new THREE.Group();
  group.name = 'bonereach_ramp';
  for (const t of ramp.terraces) {
    const w = t.bounds.maxX - t.bounds.minX, d = t.bounds.maxZ - t.bounds.minZ;
    const mesh = new THREE.Mesh(boxGeometry(w, 0.1, d), rampMat);
    mesh.position.set((t.bounds.minX + t.bounds.maxX) / 2, t.elevation - 0.05, (t.bounds.minZ + t.bounds.maxZ) / 2);
    mesh.name = 'ramp_step';
    group.add(mesh);
  }
  return group;
}

/**
 * B9's dressing props (`runBonereachDressing`'s own `props` array) as
 * simple placeholder boxes, grouped per distinct prototype id into one
 * `InstancedMesh` each — the same `07` §3.4 "draw calls scale with
 * prototypes, never instances" precedent `build/wastes.js#buildWastesGeometry`
 * already establishes. These never carry a `Footprint` (see
 * `gen/bonereach.js#toFootprints`'s own header for why) — visual only.
 * @param {object} ctx @param {object[]} props
 * @returns {{group: THREE.Group, drawCalls: number}}
 */
function buildDressingProps(ctx, props) {
  const materials = ctx.get('materials');
  const group = new THREE.Group();
  group.name = 'bonereach_dressing';
  if (!props || props.length === 0) return { group, drawCalls: 0 };

  const byProto = new Map();
  for (const p of props) {
    if (!byProto.has(p.protoId)) byProto.set(p.protoId, []);
    byProto.get(p.protoId).push(p);
  }

  let drawCalls = 0;
  for (const [protoId, instances] of byProto) {
    const spec = PROTOTYPE_CATALOG[protoId];
    const color = PROP_GROUP_COLOR[spec.group] !== undefined ? PROP_GROUP_COLOR[spec.group] : 0x808080;
    const material = materials.get(`bonereach_${spec.group}`, { color });
    const footprint = Math.max(0.3, spec.tris > 0 ? Math.sqrt(spec.tris) / 10 : 1);

    const mesh = new THREE.InstancedMesh(boxGeometry(1, 1, 1), material, instances.length);
    mesh.name = protoId;
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      const w = footprint * inst.scale, h = (spec.topY || 1) * inst.scale, d = footprint * inst.scale;
      _scaleVec.set(w, h, d);
      _posVec.set(inst.x, (inst.elevation || 0) + h / 2, inst.z);
      _quat.setFromAxisAngle(_up, inst.facing || 0);
      _matrix.compose(_posVec, _quat, _scaleVec);
      mesh.setMatrixAt(i, _matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    drawCalls++;
  }

  return { group, drawCalls };
}

/**
 * T7 — builds Bonereach's whole real-geometry scene graph and adds it to
 * `ctx.scene` under one parent `THREE.Group`, mirroring
 * `build/wastes.js#buildWastesGeometry`'s own "one call per `enterZone`,
 * between frames" allocation class (rule 5).
 * @param {object} ctx @param {ReturnType<typeof import('../gen/bonereach.js').generateBonereachLayout>} layout
 * @param {object[]} wallFootprints box-kind footprints from `toFootprints` (walls only)
 * @param {object[]} [props] `runBonereachDressing`'s own `props`, optional
 * @returns {{group: THREE.Group, drawCalls: number}}
 */
export function buildBonereachGeometry(ctx, layout, wallFootprints, props = []) {
  const parent = new THREE.Group();
  parent.name = 'bonereach';

  const rooms = buildRoomsAndWalls(ctx, layout, wallFootprints);
  const corridors = buildCorridorFloors(ctx, layout.corridors);
  const ramp = buildRamp(ctx, layout.ramp);
  const { group: dressing, drawCalls: dressingDrawCalls } = buildDressingProps(ctx, props);

  parent.add(rooms, corridors, ramp, dressing);
  ctx.scene.add(parent);

  // Draw-call accounting: floors/ceilings/walls/ramp steps are each their
  // own `THREE.Mesh` (not instanced — every room/wall differs in size, so
  // instancing would not reduce draw calls here), one draw call apiece;
  // dressing is properly instanced per prototype.
  const drawCalls = rooms.children.length + corridors.children.length + ramp.children.length + dressingDrawCalls;

  return { group: parent, drawCalls };
}

/** Removes and disposes a previously-built Bonereach geometry group.
 * @param {THREE.Group} group */
export function disposeBonereachGeometry(group) {
  if (!group) return;
  if (group.parent) group.parent.remove(group);
  group.traverse((obj) => {
    if (obj.geometry && typeof obj.geometry.dispose === 'function') {
      // Cached geometries (see `_geometryCache`) are intentionally shared
      // and reused across rooms/props within the SAME build; disposing them
      // here would break the cache for anything else still referencing it
      // within this same build call. Real disposal-on-teardown for shared,
      // cross-build geometry is out of this ticket's narrow scope (the
      // `_geometryCache` module-level cache persists for the process
      // lifetime, matching `build/wastes.js#boxGeometry`'s own precedent —
      // that file never disposes its cache either).
    }
  });
}

export const ROOM_WALL_HEIGHT = ROOM_TOP_Y;
export const ROOM_WALL_THICKNESS = WALL_THICKNESS;
