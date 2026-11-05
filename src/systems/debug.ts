// F3 debug overlay: fps, player position, vehicle speed, current job, heat level, seed.
import type { World } from '../world';
import { formatClock } from './dayNight';
import { TUNING } from '../tuning';
import { HOLD_GO, HOLD_RED } from './junctions';

/** Traffic at a glance: cars waiting at red lights / held at other junctions, lane changes, rule breaks. */
function trafficLine(w: World): string {
  let red = 0, held = 0;
  for (const c of w.traffic) if (c.phase === 'wait') { if (c.hold === HOLD_RED) red++; else if (c.hold !== HOLD_GO) held++; }
  const st = w.trafficSim.stats;
  return `${red} at red · ${held} giving way · ${st.laneChanges} lane changes · red runs ${st.redRuns} · ring entries ${st.ringEntries} (no yield ${st.yieldFails})`;
}

let el: HTMLElement | null = null;
let lastUpdate = 0;

export function createDebug(_w: World): void {
  el = document.createElement('div');
  el.id = 'debug';
  document.getElementById('ui')!.appendChild(el);
}

export function updateDebug(w: World): void {
  if (!el) return;
  el.style.display = w.debugVisible ? 'block' : 'none';
  if (!w.debugVisible || w.time - lastUpdate < 0.2) return;
  lastUpdate = w.time;
  const p = w.player.mesh.position;
  const v = w.player.vehicle;
  const info = w.renderer.info.render;
  const pd = w.pedDensity;
  el.textContent = [
    `fps      ${w.fps.toFixed(0)}   cpu ${w.prof.cpuMs.toFixed(1)} ms`,
    `spikes   ${w.prof.spikes(w.time)} frames >33ms in 10s · worst ${w.prof.worstMs.toFixed(0)} ms`,
    `worst@   ${w.prof.worstBreakdown()}`,
    `seed     ${w.seed}`,
    `pos      ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`,
    `vehicle  ${v ? `${v.spec.label}  ${(v.speed * 3.6).toFixed(0)} km/h  hp ${v.health.toFixed(0)}  slip ${v.slip.toFixed(2)}  ${v.owned ? 'yours' : v.stolen ? 'STOLEN' : ''}` : 'on foot'}`,
    `job      ${w.jobs.debugText ? w.jobs.debugText() : '-'}`,
    `health   ${w.player.health.toFixed(0)}${w.player.dead ? ' (knocked out)' : ''}`,
    `heat     ${w.police.stars ?? 0}★ (${(w.police.heat ?? 0).toFixed(0)} pts) ${w.police.seen ? 'SEEN' : ''}`,
    `time     ${formatClock(w.dayNight.hour)} · ${w.weather.kind} (grip ×${w.weather.grip.toFixed(2)})`,
    `world    ${w.traffic.length} cars · ${w.peds.filter((p) => p.active).length}/${w.peds.length} peds · ${w.vehicles.length} drivable`,
    `traffic  ${trafficLine(w)}`,
    `people   target ${pd.target} (real ${pd.real.toFixed(0)} in ${TUNING.peds.density.radius} m, budget ${w.settings.pedBudget}) · active ${pd.active} · near ${pd.near}`,
    `render   ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris`,
  ].join('\n');
}
