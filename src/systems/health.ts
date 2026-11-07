// Player health: crash injuries (belted, so only hard impacts hurt), being hit by cars on foot, slow regen,
// injury effects under 40 (slower run, camera sway, red vignette), treatment at the clinic, and being
// knocked out: fade to black, wake at the clinic with a capped bill, job cancelled, heat cleared.
import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { World } from '../world';
import type { Poi } from './map/cityMap';
import { exitVehicle } from './player';
import { toast } from './hud';
import { closeChat } from './chat';
import type { TaxiJob } from './economy/taxi';
import { hurtBurst } from './hurtFx';

const H = TUNING.health;

let vignette: HTMLElement;
let deathEl: HTMLElement;
let hpEl: HTMLElement;
let hpBar: HTMLElement;
let lastShownHp = -1;

export function createHealthUi(): void {
  const ui = document.getElementById('ui')!;
  vignette = document.createElement('div');
  vignette.id = 'vignette';
  ui.appendChild(vignette);
  hpEl = document.createElement('div');
  hpEl.id = 'hp';
  hpEl.className = 'shadow';
  hpEl.innerHTML = '<span>♥</span><div class="bar"><div></div></div>';
  ui.appendChild(hpEl);
  hpBar = hpEl.querySelector('.bar div') as HTMLElement;
  deathEl = document.createElement('div');
  deathEl.id = 'death';
  deathEl.innerHTML = '<div class="t">LIGHTS OUT</div><div class="s">Somebody called an ambulance…</div>';
  ui.appendChild(deathEl);
}

const burstAt = new THREE.Vector3();
const burstDir = new THREE.Vector3();

/** Damage the player. (dirX, dirZ): direction of the blow, if known (sprays the hurt particles that way). */
export function hurtPlayer(w: World, amount: number, dirX = 0, dirZ = 0): void {
  const p = w.player;
  if (p.dead || amount <= 0) return;
  p.health = Math.max(0, p.health - amount);
  p.lastHurt = w.time;
  vignette.style.setProperty('--flash', '1');
  const strength = amount * TUNING.hurtFx.strengthPerDamage;
  const v = p.vehicle;
  if (v) {
    // belted in: the burst comes out of the driver's window (left-hand drive, so the car's +X side), no stains
    const [hx, hy] = v.spec.halfExtents;
    burstAt.set(hx + 0.05, hy + 0.35, 0.2).applyMatrix4(v.mesh.matrixWorld);
    burstDir.set(1, 0, 0).transformDirection(v.mesh.matrixWorld);
    hurtBurst(w, burstAt.x, burstAt.y, burstAt.z, strength, burstDir.x + dirX, burstDir.z + dirZ, w.city.heightAt(burstAt.x, burstAt.z, burstAt.y), false);
  } else {
    const m = p.mesh.position;
    const flung = p.knockT > 0; // thrown by a car: the dots go with you
    hurtBurst(w, m.x, m.y + 1.2, m.z, strength, dirX, dirZ, Math.max(w.city.heightAt(m.x, m.z, m.y), m.y), true, flung ? p.knockX : 0, flung ? p.knockZ : 0);
  }
  if (p.health <= 0) die(w);
}

function die(w: World) {
  const p = w.player;
  p.dead = true;
  p.deadT = 0;
  if (w.chat.open) closeChat(w);
  if (p.vehicle) exitVehicle(w);
  p.mesh.rotation.x = -Math.PI / 2; // lying down
}

function wakeUp(w: World) {
  const p = w.player;
  const clinic = w.city.pois.find((q) => q.kind === 'clinic') ?? w.city.taxiRanks[0];
  const fee = Math.min(w.cash, H.deathFeeCap);
  w.cash -= fee;
  p.health = H.max;
  p.dead = false;
  p.knockT = 0;
  p.mesh.rotation.x = 0;
  p.body.setTranslation({ x: clinic.x, y: w.city.heightAt(clinic.x, clinic.z) + 1.2, z: clinic.z }, true);
  p.facing = Math.atan2(clinic.curbX - clinic.x, clinic.curbZ - clinic.z);
  // the world moved on while you were out
  w.dayNight.hour = (w.dayNight.hour + (H.deathTimeSkip * 24) / TUNING.time.realSecondsPerGameDay) % 24;
  // inventory is kept, except anything stolen or illegal (the police took it)
  const inv = w.inventory;
  let confiscated = 0;
  for (let i = 0; i < inv.slots.length; i++) {
    const it = inv.slots[i];
    if (it && (it.stolen || it.illegal)) {
      inv.slots[i] = null;
      confiscated++;
    }
  }
  // current job cancelled, police lose interest
  w.jobs.get<TaxiJob>('taxi')?.cancel(w);
  w.police.heat = 0;
  w.police.stars = 0;
  w.police.loseTimer = 0;
  w.police.trackUntil = 0;
  w.police.searchUntil = 0;
  const lost = confiscated ? ` · ${confiscated} stolen item${confiscated > 1 ? 's' : ''} confiscated` : '';
  toast(w, `Patched up at ${clinic.name}<br><span style="font-size:16px">Hospital bill: $${fee}${lost}</span>`, 4);
}

/** Clinic door within reach (on foot, hurt), or null. */
export function clinicNearby(w: World): Poi | null {
  const p = w.player;
  if (p.vehicle || p.health >= H.max) return null;
  const pos = p.mesh.position;
  for (const q of w.city.pois) if (q.kind === 'clinic' && Math.hypot(q.x - pos.x, q.z - pos.z) < H.clinicRange) return q;
  return null;
}
export function clinicFee(w: World): number {
  return Math.min(w.cash, Math.ceil((H.max - w.player.health) * H.clinicFeePerHp));
}
export function treatAtClinic(w: World): void {
  const fee = clinicFee(w);
  w.cash -= fee;
  w.player.health = H.max;
  toast(w, `Patched up · $${fee}`, 2);
}

export function updateHealth(w: World, dt: number): void {
  const p = w.player;
  // ---- damage from events ----
  for (const e of w.events) {
    if (e.type === 'crash' && p.vehicle) hurtPlayer(w, Math.max(0, e.dv - H.beltedSafeImpact) * H.crashHurtPerMs);
  }
  // ---- hit by a car while on foot ----
  if (!p.vehicle && !p.dead && w.started) {
    const pp = p.mesh.position;
    const check = (px: number, py: number, pz: number, heading: number, speed: number, halfW: number, halfL: number) => {
      if (Math.abs(py - pp.y) > TUNING.map.levelTolerance) return; // other floors / interiors / bridge levels
      if (Math.abs(speed) < H.footHitMinSpeed) return;
      const dx = pp.x - px, dz = pp.z - pz;
      const fx = Math.sin(heading), fz = Math.cos(heading);
      const along = dx * fx + dz * fz, side = dx * fz - dz * fx;
      if (Math.abs(along) > halfL + 0.4 || Math.abs(side) > halfW + 0.4) return;
      if (w.time - p.lastHurt < 0.6) return; // one hit per contact
      const dir = Math.sign(speed);
      p.knockT = 0.6;
      p.knockX = fx * dir * Math.abs(speed) * H.footKnockback + Math.sign(side || 1) * fz * 2;
      p.knockZ = fz * dir * Math.abs(speed) * H.footKnockback - Math.sign(side || 1) * fx * 2;
      hurtPlayer(w, Math.abs(speed) * H.footHitPerMs, fx * dir, fz * dir);
      w.audio.thud?.(pp.x, pp.z, Math.abs(speed));
    };
    for (const c of w.traffic) check(c.px, c.py, c.pz, c.heading, c.speed, c.halfW, c.halfL);
    for (const c of w.police.cars) check(c.px, c.py, c.pz, c.heading, c.speed, c.halfW, c.halfL);
  }
  // ---- regen ----
  if (!p.dead && p.health < H.max && w.time - p.lastHurt > H.regenDelay) p.health = Math.min(H.max, p.health + H.regenPerSec * dt);

  // ---- death sequence ----
  if (p.dead) {
    p.deadT += dt;
    deathEl.style.opacity = String(Math.min(1, p.deadT / H.deathFade));
    deathEl.style.display = 'flex';
    if (p.deadT > H.deathScreen) wakeUp(w);
  } else if (deathEl.style.display !== 'none') {
    const o = Math.max(0, Number(deathEl.style.opacity || '0') - dt * 1.5);
    deathEl.style.opacity = String(o);
    if (o <= 0) deathEl.style.display = 'none';
  }

  // ---- HUD + injury effects ----
  const hp = Math.round(p.health);
  if (hp !== lastShownHp) {
    lastShownHp = hp;
    hpEl.style.display = hp < H.max && w.started ? 'flex' : 'none';
    hpBar.style.width = `${hp}%`;
    hpBar.style.background = hp > 60 ? '#06d6a0' : hp > H.injuredBelow ? '#ffd166' : '#ef476f';
  }
  const injured = !p.dead && p.health < H.injuredBelow ? 1 - p.health / H.injuredBelow : 0;
  const flash = Math.max(0, Number(vignette.style.getPropertyValue('--flash') || '0') - dt * 2.5);
  vignette.style.setProperty('--flash', flash.toFixed(2));
  vignette.style.opacity = String(Math.min(1, injured * 0.8 + flash * 0.6));
}

/** Small camera wobble while badly hurt (radians to add to the camera's yaw/pitch). */
export function injurySway(w: World): number {
  const p = w.player;
  if (p.dead || p.health >= H.injuredBelow) return 0;
  return Math.sin(w.time * 1.7) * H.swayAmount * (1 - p.health / H.injuredBelow);
}
