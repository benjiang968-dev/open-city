// Keyboard + mouse input. Abstracted into actions so touch controls can feed the same state later.

export interface InputState {
  keys: Set<string>; // currently held KeyboardEvent.code values
  pressed: Set<string>; // went down this frame
  mouseDX: number; // accumulated mouse movement this frame
  mouseDY: number;
  mouseMovedAt: number; // timestamp (s) of last mouse movement
  pointerLocked: boolean;
  anyKeyPressed: boolean; // for the title screen
  /** When true (chat open) game actions are ignored. */
  blocked: boolean;
  /** Set before the game releases the mouse lock itself (chat, pause), so it isn't read as "player pressed Esc". */
  expectUnlock: boolean;
  /** The mouse lock was lost without the game asking (usually Esc): opens the pause menu. */
  lockLost: boolean;
  wheel: number; // mouse wheel steps this frame (+ = down/next)
  mouse0: boolean; // left button held (game action)
  lockUnavailable: boolean; // the page can't lock the mouse (sandboxed frame): clicks act directly
}

export function createInput(canvas: HTMLCanvasElement): InputState {
  canvas.tabIndex = 0;
  let lookDragging = false;
  const s: InputState = {
    keys: new Set(),
    pressed: new Set(),
    mouseDX: 0,
    mouseDY: 0,
    mouseMovedAt: -100,
    pointerLocked: false,
    anyKeyPressed: false,
    blocked: false,
    expectUnlock: false,
    lockLost: false,
    wheel: 0,
    mouse0: false,
    lockUnavailable: false,
  };
  const release = () => {
    s.keys.clear(); s.pressed.clear(); s.mouse0 = false; s.mouseDX = 0; s.mouseDY = 0; s.wheel = 0; lookDragging = false;
  };
  const editable = (target: EventTarget | null) => target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('mouseup', (e) => {
    if (e.button === 2) lookDragging = false;
    if (e.button === 0) s.mouse0 = false;
  });
  document.addEventListener('pointerlockerror', () => {
    s.lockUnavailable = true;
  });
  window.addEventListener('wheel', (e) => {
    if (!s.blocked && (e.target === canvas || s.pointerLocked) && e.deltaY !== 0) s.wheel += Math.sign(e.deltaY);
  }, { passive: true });
  window.addEventListener('keydown', (e) => {
    s.anyKeyPressed = true;
    if (s.blocked || editable(e.target)) return;
    if (e.repeat && !s.keys.has(e.code)) return; // a held key after focus loss needs a fresh press
    if (!s.keys.has(e.code)) s.pressed.add(e.code);
    s.keys.add(e.code);
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F3', 'F4', 'Tab'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    s.keys.delete(e.code);
  });
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
  window.addEventListener('mousedown', (e) => {
    s.anyKeyPressed = true;
    if (e.target !== canvas && !s.pointerLocked) release();
    if (e.target === canvas) { canvas.focus({ preventScroll: true }); if (e.button === 2 && !s.blocked) lookDragging = true; }
    if (e.button === 0 && !s.blocked && (s.pointerLocked || s.lockUnavailable) && e.target === canvas) s.mouse0 = true;
  });
  canvas.addEventListener('click', () => {
    if (!s.blocked && document.pointerLockElement !== canvas) {
      // requestPointerLock returns a promise in modern browsers; ignore rejections (e.g. headless)
      const r = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (r && typeof r.catch === 'function') r.catch(() => { s.lockUnavailable = true; });
    }
  });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    if (s.pointerLocked && !locked) {
      release();
      if (s.expectUnlock) s.expectUnlock = false;
      else s.lockLost = true;
    }
    s.pointerLocked = locked;
  });
  window.addEventListener('mousemove', (e) => {
    if ((!s.pointerLocked && !lookDragging) || s.blocked) return;
    s.mouseDX += e.movementX;
    s.mouseDY += e.movementY;
    s.mouseMovedAt = performance.now() / 1000;
  });
  return s;
}

export function endInputFrame(s: InputState): void {
  s.pressed.clear();
  s.mouseDX = 0;
  s.mouseDY = 0;
  s.wheel = 0;
  s.anyKeyPressed = false;
}

/** Action helpers so systems never read raw key codes directly. */
export const act = {
  forward: (s: InputState) => !s.blocked && (s.keys.has('KeyW') || s.keys.has('ArrowUp')),
  back: (s: InputState) => !s.blocked && (s.keys.has('KeyS') || s.keys.has('ArrowDown')),
  left: (s: InputState) => !s.blocked && (s.keys.has('KeyA') || s.keys.has('ArrowLeft')),
  right: (s: InputState) => !s.blocked && (s.keys.has('KeyD') || s.keys.has('ArrowRight')),
  run: (s: InputState) => !s.blocked && (s.keys.has('ShiftLeft') || s.keys.has('ShiftRight')),
  jump: (s: InputState) => !s.blocked && s.pressed.has('Space'),
  handbrake: (s: InputState) => !s.blocked && s.keys.has('Space'),
  interact: (s: InputState) => !s.blocked && s.pressed.has('KeyE'),
  horn: (s: InputState) => !s.blocked && s.keys.has('KeyH'),
  reset: (s: InputState) => !s.blocked && s.pressed.has('KeyR'),
  debug: (s: InputState) => s.pressed.has('F3') || s.pressed.has('Backquote'), // backtick too: F3 is often a browser or laptop media key
  physDebug: (s: InputState) => s.pressed.has('F4'), // collision shapes near the player
};
