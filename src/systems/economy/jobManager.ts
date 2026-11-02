// Job registry. Each money system lives in its own file, registers here, and exposes HUD text + map markers.
import type { World } from '../../world';

export interface JobMarker {
  x: number;
  z: number;
  color: string; // CSS colour for the minimap
  kind: 'pickup' | 'dropoff' | 'tip';
}

export interface JobSystem {
  id: string;
  label: string;
  update(w: World, dt: number): void;
  /** One-line status for the HUD banner ('' if idle). */
  status(w: World): string;
  markers(w: World): JobMarker[];
  debug(w: World): string;
}

export class JobManager {
  systems: JobSystem[] = [];
  private w: World | null = null;
  register(s: JobSystem): void {
    this.systems.push(s);
  }
  bind(w: World): void {
    this.w = w;
  }
  get<T extends JobSystem>(id: string): T | undefined {
    return this.systems.find((s) => s.id === id) as T | undefined;
  }
  update(w: World, dt: number): void {
    for (const s of this.systems) s.update(w, dt);
  }
  statusText(): string {
    const w = this.w;
    if (!w) return '';
    return this.systems.map((s) => s.status(w)).filter(Boolean).join('<br>');
  }
  markers(): JobMarker[] {
    const w = this.w;
    if (!w) return [];
    return this.systems.flatMap((s) => s.markers(w));
  }
  debugText(): string {
    const w = this.w;
    if (!w) return '-';
    return this.systems.map((s) => `${s.id}: ${s.debug(w)}`).join(' | ');
  }
}
