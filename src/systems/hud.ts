// HUD: cash, wanted stars, clock, speedometer + car health, interaction prompt, job banner, toasts.
import { TUNING } from '../tuning';
import type { World } from '../world';
import { formatClock } from './dayNight';
import { WEATHER_ICON } from './weather';

export interface HudState {
  root: HTMLElement;
  title: HTMLElement;
  cash: HTMLElement;
  stars: HTMLElement;
  clock: HTMLElement;
  prompt: HTMLElement;
  job: HTMLElement;
  toast: HTMLElement;
  speedo: HTMLElement;
  speedVal: HTMLElement;
  healthBar: HTMLElement;
  help: HTMLElement;
  toastUntil: number;
  shownCash: number;
  last: Record<string, string>;
}

export function createHud(): HudState {
  const root = document.getElementById('ui')!;
  const el = (id: string, cls = 'shadow', html = '') => {
    const d = document.createElement('div');
    d.id = id;
    d.className = cls;
    d.innerHTML = html;
    d.style.display = id === 'prompt' || id === 'job' || id === 'speedo' ? 'none' : '';
    root.appendChild(d);
    return d;
  };
  const cash = el('cash');
  const stars = el('stars');
  const clock = el('clock');
  const prompt = el('prompt');
  const job = el('job');
  const toast = el('toast');
  const speedo = el('speedo', 'shadow', '<div class="v">0</div><div class="u">km/h</div><div id="health"><div></div></div>');
  const help = el('help', 'shadow', 'W/S or ↑/↓ walk · A/D or ←/→ turn · Shift run · Space jump / handbrake · E enter car / talk<br>Mouse look (click to lock) · R flip car · H horn · F3 or ` stats · N weather · M mute · Esc pause');
  for (const d of [cash, stars, clock, help]) d.style.visibility = 'hidden';
  return {
    root, title: document.getElementById('title')!, cash, stars, clock, prompt, job, toast, speedo,
    speedVal: speedo.querySelector('.v') as HTMLElement, healthBar: speedo.querySelector('#health div') as HTMLElement,
    help, toastUntil: 0, shownCash: 0, last: {},
  };
}

export function showHud(h: HudState, cash = 0): void {
  h.shownCash = cash;
  h.title.style.display = 'none';
  for (const d of [h.cash, h.stars, h.clock, h.help]) d.style.visibility = 'visible';
  setTimeout(() => (h.help.style.opacity = '0.4'), 15000);
}

export function toast(w: World, html: string, seconds = 2.5): void {
  w.hud.toast.innerHTML = html;
  w.hud.toast.style.opacity = '1';
  w.hud.toastUntil = w.time + seconds;
}

/** Only touch the DOM when text actually changes. */
function set(h: HudState, key: string, el: HTMLElement, html: string) {
  if (h.last[key] === html) return;
  h.last[key] = html;
  el.innerHTML = html;
}
function show(el: HTMLElement, on: boolean) {
  const v = on ? 'block' : 'none';
  if (el.style.display !== v) el.style.display = v;
}

export function updateHud(w: World, dt: number): void {
  const h = w.hud;
  if (!w.started) return;
  // cash counts up smoothly
  h.shownCash += (w.cash - h.shownCash) * Math.min(1, dt * 6);
  if (Math.abs(w.cash - h.shownCash) < 0.5) h.shownCash = w.cash;
  set(h, 'cash', h.cash, `$${Math.round(h.shownCash).toLocaleString()}`);
  const s = w.police.stars;
  let st = '';
  for (let i = 1; i <= TUNING.police.maxStars; i++) st += `<span class="${i <= s ? 'on' : 'off'}">★</span>`;
  set(h, 'stars', h.stars, st);
  h.stars.classList.toggle('flash', s > 0 && w.police.seen);
  set(h, 'clock', h.clock, `${WEATHER_ICON[w.weather.kind]} ${formatClock(w.dayNight.hour)}`);

  const prompt = w.chat.open ? '' : w.player.prompt;
  show(h.prompt, !!prompt);
  set(h, 'prompt', h.prompt, prompt);

  const jobText = w.jobs.statusText();
  show(h.job, !!jobText);
  set(h, 'job', h.job, jobText);

  const v = w.player.vehicle;
  show(h.speedo, !!v);
  if (v) {
    set(h, 'speed', h.speedVal, String(Math.round(Math.abs(v.speed) * 3.6)));
    const pct = Math.round((v.health / v.maxHealth) * 100);
    const hb = `${pct}`;
    if (h.last.health !== hb) {
      h.last.health = hb;
      h.healthBar.style.width = `${pct}%`;
      h.healthBar.style.background = pct > 50 ? '#06d6a0' : pct > 20 ? '#ffd166' : '#ef476f';
    }
  }
  if (h.toastUntil && w.time > h.toastUntil) {
    h.toast.style.opacity = '0';
    h.toastUntil = 0;
  }
}
