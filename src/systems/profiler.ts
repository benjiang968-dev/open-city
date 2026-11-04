// Frame profiler: per-system CPU time each frame, plus a spike counter (frames over the budget in the last
// N seconds) and the worst frame with its breakdown. Shown in the F3 overlay. Allocation-free per frame.
import { TUNING } from '../tuning';

const NAMES = [
  'sim', 'player', 'vehicles', 'traffic', 'police-drive', 'physics', 'crashes', 'peds', 'chat', 'jobs', 'theft', 'memory',
  'police', 'audio', 'sync', 'daynight', 'weather', 'city', 'camera', 'hud', 'minimap', 'debug', 'render', 'fx',
] as const;
export type ProfName = (typeof NAMES)[number];

export class Profiler {
  readonly names = NAMES;
  private idx = new Map<string, number>(NAMES.map((n, i) => [n, i]));
  cur = new Float64Array(NAMES.length); // ms this frame
  private started = new Float64Array(NAMES.length);
  /** Real frame times (ms) with timestamps, ring buffer. */
  private times = new Float64Array(1200);
  private stamps = new Float64Array(1200);
  private head = 0;
  worstMs = 0;
  worstAt = 0;
  worstParts = new Float64Array(NAMES.length);
  cpuMs = 0; // CPU time of the last frame (sum of the top-level sections)
  frameCount = 0;

  begin(n: ProfName): void {
    this.started[this.idx.get(n)!] = performance.now();
  }
  end(n: ProfName): void {
    const i = this.idx.get(n)!;
    this.cur[i] += performance.now() - this.started[i];
  }
  startFrame(): void {
    this.cur.fill(0);
  }
  /** Record a finished frame. `realMs` is the time since the previous frame (what the player feels). */
  endFrame(realMs: number, nowS: number): void {
    this.frameCount++;
    this.times[this.head] = realMs;
    this.stamps[this.head] = nowS;
    this.head = (this.head + 1) % this.times.length;
    // the 'sim' section contains player..crashes; everything else is top level
    let cpu = 0;
    for (let i = 0; i < NAMES.length; i++) if (i === 0 || i > 6) cpu += this.cur[i];
    this.cpuMs = cpu;
    // the worst frame is judged on CPU time too, so a slow headless GPU doesn't hide the cause
    const score = Math.max(realMs, cpu);
    if (nowS - this.worstAt > TUNING.debug.spikeWindow || score > this.worstMs) {
      if (score > this.worstMs || nowS - this.worstAt > TUNING.debug.spikeWindow) {
        this.worstMs = score;
        this.worstAt = nowS;
        this.worstParts.set(this.cur);
      }
    }
  }
  /** Frames over the spike threshold within the window. */
  spikes(nowS: number): number {
    let n = 0;
    for (let i = 0; i < this.times.length; i++) {
      if (this.stamps[i] > 0 && nowS - this.stamps[i] <= TUNING.debug.spikeWindow && this.times[i] > TUNING.debug.spikeMs) n++;
    }
    return n;
  }
  /** Top three sections of the worst frame, e.g. "render 12.1 · physics 3.0 · peds 1.2". */
  worstBreakdown(): string {
    const order = NAMES.map((n, i) => [n, this.worstParts[i]] as const)
      .filter(([n]) => n !== 'sim')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    return order.map(([n, ms]) => `${n} ${ms.toFixed(1)}`).join(' · ');
  }
  /** Current frame's top sections. */
  breakdown(): string {
    const order = NAMES.map((n, i) => [n, this.cur[i]] as const).filter(([n]) => n !== 'sim').sort((a, b) => b[1] - a[1]).slice(0, 4);
    return order.map(([n, ms]) => `${n} ${ms.toFixed(1)}`).join(' · ');
  }
}
