// Real Rapier geometry checks for streamed furnished rooms, without a GPU dependency.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const canvas = () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, strokeRect() {}, fillText() {} }) });
globalThis.document = { createElement: canvas };
try {
  const mod = await server.ssrLoadModule('/src/systems/interiors/index.ts');
  const { SolidTags } = await server.ssrLoadModule('/src/systems/objects/solidKinds.ts');
  const { TUNING } = await server.ssrLoadModule('/src/tuning.ts');
  const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const P = TUNING.player, capsule = P.capsuleHalfHeight + P.capsuleRadius;
  const body = physics.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0));
  const collider = physics.createCollider(RAPIER.ColliderDesc.capsule(P.capsuleHalfHeight, P.capsuleRadius), body);
  const cc = physics.createCharacterController(P.ccOffset);
  cc.enableAutostep(P.autostepHeight, P.autostepMinWidth, true); cc.enableSnapToGround(P.snapToGround);
  cc.setMaxSlopeClimbAngle(P.maxSlopeDeg * Math.PI / 180);
  cc.setMinSlopeSlideAngle(P.minSlopeSlideDeg * Math.PI / 180);
  const w = {
    R: RAPIER, physics, scene: new THREE.Scene(), started: true, paused: false, time: 10,
    city: { spawn: { x: 0, z: 0 }, pois: ['shop', 'office', 'warehouse', 'garage', 'home', 'cafe', 'home', 'home', 'home', 'shop', 'office', 'garage', 'cafe', 'warehouse'].map((kind, id) => ({ id, kind, name: kind, x: id * 25, z: 0, door: { x: id * 25, z: 1 } })),
      isBlocked: () => false, isRoad: () => false, isWater: () => false, heightAt: () => 0, solidTags: new SolidTags() },
    player: { body, collider, mesh: new THREE.Group(), vehicle: null, dead: false, vy: 0 },
    cam: { focus: new THREE.Vector3(), yaw: 0 }, input: { keys: new Set(), pressed: new Set(), blocked: false },
    hud: { toast: { style: {} }, toastUntil: 0 },
  };
  const S = mod.createInteriors(w);
  assert.equal(S.entries.length, 14);
  assert.deepEqual(S.entries.slice(0,6).map(e=>e.poiId),[0,1,2,3,4,5],'published six-entry prefix must remain stable');
  const motion = (x, z, ticks = 120) => {
    for (let n = 0; n < ticks; n++) {
      const p = body.translation();
      cc.computeColliderMovement(collider, { x: x / ticks, y: -1 / 60, z: z / ticks });
      const d = cc.computedMovement(); body.setNextKinematicTranslation({ x: p.x + d.x, y: p.y + d.y, z: p.z + d.z }); physics.step();
    }
    return body.translation();
  };
  const set = (e, x, y, z) => { body.setTranslation({ x: e.origin.x + x, y: e.origin.y + y + capsule + 0.03, z: e.origin.z + z }, true); physics.step(); };
  const summary = [];
  for (const e of S.entries) {
    assert.equal(mod.enterInterior(w, S, e.id), true); physics.step();
    assert.equal(S.active, e.id); assert.ok(e.colliders.length > 20);
    // The usable hinged door blocks the threshold when closed and opens the same collider.
    w.input.pressed.add('KeyO'); mod.interiorInteraction(w, S);
    assert.equal(e.door.open, false);
    for (let n = 0; n < 120; n++) mod.updateInteriors(w, S, 1 / 60);
    physics.step();
    const doorRay = () => physics.castRay(new RAPIER.Ray({ x: e.origin.x, y: e.origin.y + 1.1, z: e.origin.z + 5 }, { x: 0, y: 0, z: 1 }), 2, true, RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC);
    assert.equal(doorRay()?.collider.handle, e.door.collider.handle, `${e.kind}: closed door collision`);
    w.input.pressed.add('KeyO'); mod.interiorInteraction(w, S);
    assert.equal(e.door.open, true);
    for (let n = 0; n < 120; n++) mod.updateInteriors(w, S, 1 / 60);
    physics.step(); assert.equal(doorRay(), null, `${e.kind}: open doorway`);
    const floor = physics.castRay(new RAPIER.Ray({ x: e.origin.x, y: e.origin.y + 1, z: e.origin.z + 3 }, { x: 0, y: -1, z: 0 }), 2, true, RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC);
    assert.ok(floor && Math.abs(floor.timeOfImpact - 1) < 0.02, `${e.kind}: solid floor`);
    set(e, 0, 0, 3.8); const wall = motion(7, 0);
    assert.ok(wall.x < e.origin.x + 4.9, `${e.kind}: side wall holds`);
    assert.ok(wall.y >= e.origin.y + capsule - 0.05, `${e.kind}: never below floor`);
    if (e.upstairs) {
      set(e, 3.5, 0, -4.7); const top = motion(0, 12, 150);
      assert.ok(top.y > e.origin.y + 3.1 + capsule, `${e.kind}: stairs ascend (${top.y - e.origin.y})`);
      const bottom = motion(0, -12, 150);
      assert.ok(bottom.y < e.origin.y + 0.15 + capsule, `${e.kind}: stairs descend (${bottom.y - e.origin.y})`);
    }
    assert.equal(mod.exitInterior(w, S), true); physics.step(); assert.equal(S.active, null);
    assert.ok(Math.abs(body.translation().y - (capsule + 0.04)) < 0.01);
    summary.push({ kind: e.kind, colliders: e.colliders.length, stairs: e.upstairs ? 'up/down pass' : 'none', drawMeshes: e.room.children.length });
  }
  console.log(JSON.stringify({ pass: true, rooms: summary })); physics.free();
} finally { await server.close(); }
