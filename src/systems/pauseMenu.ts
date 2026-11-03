// Pause menu: Esc / P (or losing the mouse lock) pauses the world. Resume, graphics quality, mute, controls.
import type { World } from '../world';
import { applyQuality, QUALITIES, type Quality } from './settings';
import { toggleMute } from './audio';
import { TUNING } from '../tuning';

let root: HTMLElement;
let qualityBtns: Record<Quality, HTMLButtonElement>;
let muteBtn: HTMLButtonElement;

const LABEL: Record<Quality, string> = { low: 'Low', medium: 'Medium', high: 'High' };

export function createPauseMenu(w: World): void {
  root = document.createElement('div');
  root.id = 'pause';
  const q = TUNING.quality;
  const desc = (k: Quality) =>
    `${Math.round(q[k].resolutionScale * 100)}% resolution · ${q[k].shadows ? `${q[k].shadowMapSize}px shadows` : 'no shadows'} · ${q[k].pedBudget} people nearby`;
  root.innerHTML = `
    <div class="panel" role="dialog" aria-label="Paused">
      <h2>Paused</h2>
      <button class="primary" id="pause-resume">Resume</button>
      <div class="group">
        <div class="label">Graphics quality</div>
        <div class="seg">${QUALITIES.map((k) => `<button id="q-${k}" data-q="${k}">${LABEL[k]}</button>`).join('')}</div>
        <div class="desc" id="q-desc"></div>
      </div>
      <button id="pause-mute">Sound: on</button>
      <div class="controls">
        <b>Controls</b><br>
        W/S walk · A/D turn · Shift run · Space jump / handbrake · E use / talk / pick up<br>
        1–9 or mouse wheel: hotbar · Left click (or F): throw / swing · Q drop · R flip car · H horn<br>
        N weather · M mute · \` or F3 stats · Esc or P pause
      </div>
    </div>`;
  document.getElementById('ui')!.appendChild(root);
  qualityBtns = Object.fromEntries(QUALITIES.map((k) => [k, root.querySelector(`#q-${k}`) as HTMLButtonElement])) as Record<Quality, HTMLButtonElement>;
  const descEl = root.querySelector('#q-desc') as HTMLElement;
  const refresh = () => {
    for (const k of QUALITIES) qualityBtns[k].classList.toggle('on', w.settings.quality === k);
    descEl.textContent = desc(w.settings.quality);
    muteBtn.textContent = `Sound: ${w.audio.muted ? 'off' : 'on'}`;
  };
  for (const k of QUALITIES) qualityBtns[k].addEventListener('click', () => { applyQuality(w, k); refresh(); });
  muteBtn = root.querySelector('#pause-mute') as HTMLButtonElement;
  muteBtn.addEventListener('click', () => { toggleMute(w.audio); refresh(); });
  root.querySelector('#pause-resume')!.addEventListener('click', () => {
    closePause(w);
    // resuming from a click is a user gesture, so the mouse can be locked again
    const c = w.renderer.domElement as HTMLCanvasElement & { requestPointerLock(): unknown };
    const r = c.requestPointerLock() as Promise<void> | undefined;
    if (r && typeof r.catch === 'function') r.catch(() => {});
  });
  (root as HTMLElement & { refresh?: () => void }).refresh = refresh;
  refresh();
}

export function openPause(w: World): void {
  if (w.paused || !w.started) return;
  w.paused = true;
  w.input.keys.clear();
  if (document.pointerLockElement) {
    w.input.expectUnlock = true;
    document.exitPointerLock();
  }
  (root as HTMLElement & { refresh?: () => void }).refresh?.();
  root.style.display = 'flex';
  (root.querySelector('#pause-resume') as HTMLButtonElement).focus();
}

export function closePause(w: World): void {
  if (!w.paused) return;
  w.paused = false;
  w.input.keys.clear();
  root.style.display = 'none';
}

/** Called once per frame before the simulation: handles the pause keys and a lost mouse lock. */
export function updatePauseKeys(w: World): void {
  const inp = w.input;
  const toggle = inp.pressed.has('Escape') || inp.pressed.has('KeyP');
  if (inp.lockLost) {
    inp.lockLost = false;
    if (w.started && !w.paused && !w.chat.open) openPause(w);
    return;
  }
  if (!toggle || !w.started || w.chat.open) return;
  if (w.paused) closePause(w);
  else openPause(w);
}
