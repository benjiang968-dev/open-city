// All sound is synthesised with WebAudio: engine, tyre screech, horns, thuds, siren, cash chime. No files.
import { TUNING } from '../tuning';
import type { World } from '../world';

const A = TUNING.audio;

export interface AudioState {
  ctx: AudioContext | null;
  master: GainNode | null;
  muted: boolean;
  engineOsc: OscillatorNode[];
  engineGain: GainNode | null;
  engineFilter: BiquadFilterNode | null;
  screechGain: GainNode | null;
  sirenOsc: OscillatorNode | null;
  sirenGain: GainNode | null;
  noise: AudioBuffer | null;
  listenerX: number;
  listenerZ: number;
  horn?: (x: number, z: number) => void;
  thud?: (x: number, z: number, strength: number) => void;
  chime?: () => void;
  thunder?: () => void;
  pickup?: () => void;
  setRain?: (amount: number) => void;
}

export function createAudio(): AudioState {
  return {
    ctx: null, master: null, muted: false, engineOsc: [], engineGain: null, engineFilter: null, screechGain: null,
    sirenOsc: null, sirenGain: null, noise: null, listenerX: 0, listenerZ: 0,
  };
}

/** Must be called from a user gesture (the title-screen key press). */
export function startAudio(s: AudioState): void {
  if (s.ctx) return;
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return;
  }
  s.ctx = ctx;
  const master = ctx.createGain();
  master.gain.value = A.masterVolume;
  master.connect(ctx.destination);
  s.master = master;

  // noise buffer shared by screech and thuds
  const len = ctx.sampleRate * 1.5;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  s.noise = buf;

  // engine: sawtooth + detuned square through a low-pass
  const eg = ctx.createGain();
  eg.gain.value = 0;
  const ef = ctx.createBiquadFilter();
  ef.type = 'lowpass';
  ef.frequency.value = 600;
  ef.Q.value = 2;
  ef.connect(eg);
  eg.connect(master);
  for (const [type, mul, vol] of [['sawtooth', 1, 0.6], ['square', 0.5, 0.35], ['triangle', 2, 0.3]] as const) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = A.engineIdleHz * mul;
    const g = ctx.createGain();
    g.gain.value = vol;
    o.connect(g);
    g.connect(ef);
    o.start();
    (o as OscillatorNode & { mul: number }).mul = mul;
    s.engineOsc.push(o);
  }
  s.engineGain = eg;
  s.engineFilter = ef;

  // tyre screech: band-passed looping noise
  const sn = ctx.createBufferSource();
  sn.buffer = buf;
  sn.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1700;
  bp.Q.value = 4;
  const sg = ctx.createGain();
  sg.gain.value = 0;
  sn.connect(bp);
  bp.connect(sg);
  sg.connect(master);
  sn.start();
  s.screechGain = sg;

  // siren: square wave swept by an LFO
  const so = ctx.createOscillator();
  so.type = 'square';
  so.frequency.value = 900;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.7;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 300;
  lfo.connect(lfoGain);
  lfoGain.connect(so.frequency);
  const sfilt = ctx.createBiquadFilter();
  sfilt.type = 'lowpass';
  sfilt.frequency.value = 2200;
  const sgain = ctx.createGain();
  sgain.gain.value = 0;
  so.connect(sfilt);
  sfilt.connect(sgain);
  sgain.connect(master);
  so.start();
  lfo.start();
  s.sirenOsc = so;
  s.sirenGain = sgain;

  const distGain = (x: number, z: number) => Math.max(0, 1 - Math.hypot(x - s.listenerX, z - s.listenerZ) / 90);
  s.horn = (x, z) => {
    const g0 = distGain(x, z) * A.hornVolume;
    if (g0 <= 0.01) return;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(g0, t + 0.02);
    g.gain.setValueAtTime(g0, t + 0.38);
    g.gain.linearRampToValueAtTime(0, t + 0.45);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1800;
    f.connect(g);
    g.connect(master);
    for (const hz of [392, 494]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = hz;
      o.connect(f);
      o.start(t);
      o.stop(t + 0.5);
    }
  };
  s.thud = (x, z, strength) => {
    const g0 = distGain(x, z) * Math.min(1, strength / 15) * 0.9;
    if (g0 <= 0.01) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.setValueAtTime(g0, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + 0.4);
  };
  // rain: high-passed noise loop, volume follows the weather
  const rn = ctx.createBufferSource();
  rn.buffer = buf;
  rn.loop = true;
  const rf = ctx.createBiquadFilter();
  rf.type = 'highpass';
  rf.frequency.value = 1200;
  const rg = ctx.createGain();
  rg.gain.value = 0;
  rn.connect(rf);
  rf.connect(rg);
  rg.connect(master);
  rn.start();
  s.setRain = (amount) => rg.gain.setTargetAtTime(amount * 0.12, ctx.currentTime, 0.5);
  s.thunder = () => {
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.5;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 160;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.8);
    src.connect(f);
    f.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + 2.9);
  };
  s.pickup = () => {
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + 0.16);
  };
  s.chime = () => {
    const t = ctx.currentTime;
    [988, 1319, 1568].forEach((hz, k) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + k * 0.09);
      g.gain.linearRampToValueAtTime(0.18, t + k * 0.09 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + k * 0.09 + 0.5);
      o.connect(g);
      g.connect(master);
      o.start(t + k * 0.09);
      o.stop(t + k * 0.09 + 0.55);
    });
  };
}

const GEARS = [0, 7, 14, 22, 31, 41, 60]; // m/s gear boundaries for a fake gearbox

export function toggleMute(s: AudioState): void {
  if (!s.master) return;
  s.muted = !s.muted;
  s.master.gain.value = s.muted ? 0 : A.masterVolume;
}

export function updateAudio(w: World, _dt: number): void {
  const s = w.audio;
  if (!s.ctx || !s.engineGain) return;
  const t = s.ctx.currentTime;
  const p = w.player.mesh.position;
  s.listenerX = p.x;
  s.listenerZ = p.z;
  const v = w.player.vehicle;
  if (v && !v.wrecked) {
    const sp = Math.abs(v.speed);
    let g = 0;
    while (g < GEARS.length - 2 && sp > GEARS[g + 1]) g++;
    const frac = (sp - GEARS[g]) / (GEARS[g + 1] - GEARS[g]);
    const rpm = Math.min(1, (g === 0 ? 0.15 : 0.35) + frac * 0.65 + (v.throttle !== 0 && sp < 1 ? 0.25 : 0));
    const hz = A.engineIdleHz + (A.engineMaxHz - A.engineIdleHz) * rpm * (v.type === 'pickup' ? 0.8 : v.type === 'hatchback' ? 1.15 : 1);
    for (const o of s.engineOsc) o.frequency.setTargetAtTime(hz * (o as OscillatorNode & { mul: number }).mul, t, 0.05);
    s.engineFilter!.frequency.setTargetAtTime(400 + rpm * 1400 + (v.throttle !== 0 ? 500 : 0), t, 0.08);
    s.engineGain.gain.setTargetAtTime(0.12 + (v.throttle !== 0 ? 0.1 : 0) + rpm * 0.05, t, 0.1);
    const scr = v.slip > A.screechSlipThreshold && sp > 5 ? Math.min(0.35, (v.slip - A.screechSlipThreshold) * 0.9) : 0;
    s.screechGain!.gain.setTargetAtTime(scr, t, 0.05);
  } else {
    s.engineGain.gain.setTargetAtTime(0, t, 0.15);
    s.screechGain!.gain.setTargetAtTime(0, t, 0.05);
  }
  if (v && w.input.keys.has('KeyH') && !w.input.blocked && (w.time % 0.5) < w.frameDt) s.horn?.(p.x, p.z);
  // siren volume from the nearest chasing police car
  let nearest = Infinity;
  for (const c of w.police.cars ?? []) {
    const ct = c.body.translation();
    nearest = Math.min(nearest, Math.hypot(ct.x - p.x, ct.z - p.z));
  }
  const sv = nearest < 200 ? (1 - nearest / 200) * 0.09 : 0;
  s.sirenGain!.gain.setTargetAtTime(sv, t, 0.2);
  // crash thuds for the player's car
  for (const e of w.events) if (e.type === 'crash') s.thud?.(e.x, e.z, e.damage + 6);
}
