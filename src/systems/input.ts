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
}

export function createInput(canvas: HTMLCanvasElement): InputState {
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
  };
  window.addEventListener('wheel', (e) => {
    if (!s.blocked && e.deltaY !== 0) s.wheel += Math.sign(e.deltaY);
  }, { passive: true });
  window.addEventListener('keydown', (e) => {
    s.anyKeyPressed = true;
    if (s.blocked) return;
    if (!s.keys.has(e.code)) s.pressed.add(e.code);
    s.keys.add(e.code);
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F3', 'Tab'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    s.keys.delete(e.code);
  });
  window.addEventListener('blur', () => s.keys.clear());
  window.addEventListener('mousedown', () => {
    s.anyKeyPressed = true;
  });
  canvas.addEventListener('click', () => {
    if (!s.blocked && document.pointerLockElement !== canvas) {
      // requestPointerLock returns a promise in modern browsers; ignore rejections (e.g. headless)
      const r = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (r && typeof r.catch === 'function') r.catch(() => {});
    }
  });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    if (s.pointerLocked && !locked) {
      if (s.expectUnlock) s.expectUnlock = false;
      else s.lockLost = true;
    }
    s.pointerLocked = locked;
  });
  window.addEventListener('mousemove', (e) => {
    if (!s.pointerLocked || s.blocked) return;
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
};
