// Speech bubbles and status icons over people's heads (complaints, shouts, "📞 999…" while calling).
// A fixed pool of DOM elements positioned by projecting world points each frame.
import * as THREE from 'three';
import type { World } from '../world';

interface Bubble {
  el: HTMLElement;
  text: HTMLElement;
  bar: HTMLElement;
  target: { pos: THREE.Vector3 } | null;
  until: number;
  progress: (() => number) | null; // 0..1 progress bar (phone calls), or null
  key: string;
}

const POOL = 12;
const pool: Bubble[] = [];
const v = new THREE.Vector3();

export function createBubbles(): void {
  const ui = document.getElementById('ui')!;
  for (let i = 0; i < POOL; i++) {
    const el = document.createElement('div');
    el.className = 'bubble';
    el.innerHTML = '<span class="t"></span><div class="pb"><div></div></div>';
    el.style.display = 'none';
    ui.appendChild(el);
    pool.push({ el, text: el.querySelector('.t') as HTMLElement, bar: el.querySelector('.pb div') as HTMLElement, target: null, until: 0, progress: null, key: '' });
  }
}

/**
 * Show text over someone's head. `key` lets a caller replace its own bubble (one per person).
 * `progress` (optional) drives a small bar, used for the visible 999 call window.
 */
export function say(w: World, target: { pos: THREE.Vector3 }, text: string, seconds: number, key = '', progress: (() => number) | null = null): void {
  let b = key ? pool.find((p) => p.key === key && p.target) : undefined;
  if (!b) b = pool.find((p) => !p.target) ?? pool.reduce((a, p) => (p.until < a.until ? p : a));
  b.target = target;
  b.until = w.time + seconds;
  b.progress = progress;
  b.key = key;
  b.text.textContent = text;
  b.bar.parentElement!.style.display = progress ? 'block' : 'none';
  b.el.classList.toggle('alert', text.startsWith('📞') || text.startsWith('📹'));
}

export function clearBubble(key: string): void {
  for (const b of pool) if (b.key === key) { b.target = null; b.el.style.display = 'none'; }
}

export function updateBubbles(w: World): void {
  const cam = w.camera;
  const W = window.innerWidth, H = window.innerHeight;
  for (const b of pool) {
    if (!b.target) continue;
    if (w.time > b.until) {
      b.target = null;
      b.el.style.display = 'none';
      continue;
    }
    v.copy(b.target.pos);
    v.y += 2.15;
    const dist = v.distanceTo(cam.position);
    v.project(cam);
    const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 && dist < 45;
    b.el.style.display = visible ? 'block' : 'none';
    if (!visible) continue;
    b.el.style.transform = `translate(${((v.x + 1) / 2) * W}px, ${((1 - v.y) / 2) * H}px) translate(-50%, -100%)`;
    if (b.progress) b.bar.style.width = `${Math.round(Math.min(1, b.progress()) * 100)}%`;
  }
}
