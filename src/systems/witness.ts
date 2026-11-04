// Witnesses and 999 calls. A crime (knocking someone down with a car, assault, harassment, vandalism,
// ramming, waving a weapon) is seen by people with line of sight. Each reacts by archetype and personality:
// call 999 (phone at the ear for a visible 2–3 s, then heat rises and police are sent to the spot), film it,
// run, or come over and confront you. Police who see it themselves react instantly.
// Hitting or knocking down a caller before they finish stops the call; that's the fair window.
// Hurting a dog (M3) is a serious crime: the owner always calls (unless knocked down), and people nearby react
// strongly; even without line of sight they hear the yelp.
import { TUNING } from '../tuning';
import type { World, GameEvent } from '../world';
import type { Ped } from './pedestrians';
import { startFlee } from './pedestrians';
import { say, clearBubble } from './bubbles';
import { LINES, pick } from '../npc/reactionLines';
import { remember } from '../npc/npc';
import { addHeat, dispatchTo, policeCanSee } from './police';
import { toast } from './hud';

const WT = TUNING.witness;
type CrimeKind = keyof typeof WT.heat;
type Reaction = 'call' | 'film' | 'flee' | 'confront';

interface Crime {
  id: number;
  kind: CrimeKind;
  x: number;
  z: number;
  heat: number;
  reported: boolean; // first completed call sets the full heat; later callers add a little
  victim: number; // ped id of the victim (for a dog: its owner), or -1
}

let nextCrime = 1;
const crimes = new Map<number, Crime>();

export interface WitnessStats {
  callsStarted: number;
  callsCompleted: number;
  callsInterrupted: number;
  filming: number;
  /** Completed calls per crime kind, and who made the last one (tests). */
  completedByKind: Record<string, number>;
  lastCaller: number;
}
export const witnessStats: WitnessStats = { callsStarted: 0, callsCompleted: 0, callsInterrupted: 0, filming: 0, completedByKind: {}, lastCaller: -1 };

function crimeFromEvent(e: GameEvent): { kind: CrimeKind; x: number; z: number; victim: number; radius?: number } | null {
  switch (e.type) {
    case 'pedHit': return { kind: 'pedHit', x: e.x, z: e.z, victim: e.pedId };
    case 'assault': return { kind: 'assault', x: e.x, z: e.z, victim: e.pedId };
    case 'harassment': return { kind: 'harassment', x: e.x, z: e.z, victim: e.pedId };
    case 'vandalism': return { kind: 'vandalism', x: e.x, z: e.z, victim: -1 };
    case 'menace': return { kind: 'menace', x: e.x, z: e.z, victim: -1 };
    case 'dogHurt': return { kind: 'dogAttack', x: e.x, z: e.z, victim: e.pedId };
    // the owner (if they noticed) is the victim: they chase you first and may call afterwards (pedestrians 'chase').
    // While the alarm sounds, everyone within earshot has turned to look, so the witness radius grows
    case 'carTheft': return { kind: 'carTheft', x: e.x, z: e.z, victim: e.ownerSaw ? e.ownerId : -1, radius: e.alarm ? WT.radius.carTheftAlarm : undefined };
    case 'carHit':
      if (e.speed < 6 || e.targetKind === 'parked') return null;
      return { kind: e.targetKind === 'police' ? 'ramPolice' : 'ramming', x: e.x, z: e.z, victim: -1 };
    default: return null;
  }
}

function pickReaction(ped: Ped, kind: CrimeKind): Reaction {
  if (ped.archetype === 'kid') return 'flee';
  const base = WT.byArchetype[ped.archetype as keyof typeof WT.byArchetype] ?? WT.byArchetype.adult;
  const mod = WT.personality[ped.npc.personality];
  const dog = kind === 'dogAttack';
  const DA = WT.dogAttackReaction;
  const weights: [Reaction, number][] = [
    ['call', base.call * mod.call * (kind === 'menace' || kind === 'harassment' ? 0.6 : 1) * (dog ? DA.call : 1)],
    ['film', base.film * mod.film * (dog ? DA.film : 1)],
    ['flee', base.flee * mod.flee * (dog ? DA.flee : 1)],
    ['confront', base.confront * mod.confront * (kind === 'pedHit' || kind === 'menace' ? 0.3 : 1) * (dog ? DA.confront : 1)],
  ];
  let r = Math.random() * weights.reduce((a, [, v]) => a + v, 0);
  for (const [k, v] of weights) {
    r -= v;
    if (r <= 0) return k;
  }
  return 'flee';
}

/** Line of sight from a person's eyes to a point on the ground (static geometry only). */
export function canSee(w: World, ped: Ped, x: number, z: number): boolean {
  const R = w.R;
  const ox = ped.pos.x, oy = ped.pos.y + 1.6 * ped.scale, oz = ped.pos.z;
  const dx = x - ox, dy = 1.0 - oy, dz = z - oz;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1.5) return true;
  const hit = w.physics.castRay(new R.Ray({ x: ox, y: oy, z: oz }, { x: dx / d, y: dy / d, z: dz / d }), d - 0.5, true, R.QueryFilterFlags.ONLY_FIXED);
  return !hit;
}

/** Start a visible 999 call (also used when someone threatens to call during a conversation). */
export function startCall(w: World, ped: Ped, crime: { x: number; z: number; heat: number; kind: string; id?: number }): void {
  if (ped.state === 'down' || ped.hidden || !ped.active) return;
  ped.state = 'phone';
  ped.phoneMode = 'call';
  ped.phoneT = WT.callTimeMin + Math.random() * (WT.callTimeMax - WT.callTimeMin);
  ped.report = { x: crime.x, z: crime.z, heat: crime.heat, kind: crime.id !== undefined ? String(crime.id) : crime.kind };
  const total = ped.phoneT;
  const cr = crime.id !== undefined ? crimes.get(crime.id) : undefined;
  const kind = cr ? cr.kind : crime.kind;
  const lines = kind === 'dogAttack' ? (cr && cr.victim === ped.id ? LINES.callingMyDog : LINES.callingDog) : kind === 'carTheft' ? LINES.callingTheft : LINES.calling;
  say(w, ped, pick(lines), total + 0.2, `ped${ped.id}`, () => 1 - ped.phoneT / total);
  witnessStats.callsStarted++;
}

function startFilming(w: World, ped: Ped) {
  ped.state = 'phone';
  ped.phoneMode = 'film';
  ped.phoneT = WT.filmTime;
  ped.report = null;
  say(w, ped, pick(LINES.filming), 2.5, `ped${ped.id}`);
  remember(ped.npc, 'sawAssault', 'got filmed causing trouble (it is all over the gossip now)', w.dayNight.hour, w.dayNight.day);
  witnessStats.filming++;
}

/** Per frame: turn this frame's crime events into witness reactions; advance calls in progress. */
export function updateWitnesses(w: World, dt: number): void {
  for (const e of w.events) {
    if (e.type === 'policeCalled') {
      // someone in a conversation decided to call: they get the phone out like anyone else
      const ped = w.peds[e.byPed];
      if (ped) startCall(w, ped, { x: ped.pos.x, z: ped.pos.z, heat: TUNING.police.callPoliceHeat, kind: 'callIn' });
      continue;
    }
    const c = crimeFromEvent(e);
    if (!c) continue;
    const crime: Crime = { id: nextCrime++, kind: c.kind, x: c.x, z: c.z, heat: WT.heat[c.kind], reported: false, victim: c.victim };
    crimes.set(crime.id, crime);
    // police who saw it react at once
    if (policeCanSee(w, c.x, c.z)) {
      addHeat(w, crime.heat);
      crime.reported = true;
    }
    // the victim (if any) decides whether to call once the flinch is over
    if (c.victim >= 0) {
      const v = w.peds[c.victim];
      if (c.kind === 'dogAttack') { if (v) ownerCalls(w, v, crime); }
      else if (v && v.archetype !== 'kid' && Math.random() < WT.victimCall[v.npc.personality]) v.report = { x: c.x, z: c.z, heat: crime.heat, kind: String(crime.id) };
    }
    // bystanders with line of sight
    const radius = c.radius ?? WT.radius[c.kind];
    const nearby = w.peds
      .filter((p) => p.active && !p.hidden && p.id !== c.victim && p.state !== 'down' && p.state !== 'phone' && p.state !== 'talk' && !p.reserved)
      .map((p) => ({ p, d: Math.hypot(p.pos.x - c.x, p.pos.z - c.z) }))
      .filter((o) => o.d < radius)
      .sort((a, b) => a.d - b.d)
      .slice(0, WT.maxWitnesses);
    for (const { p, d } of nearby) {
      const heard = c.kind === 'dogAttack' && d < TUNING.dogs.yelpHearRadius; // a yelp carries round corners
      if (!heard && !canSee(w, p, c.x, c.z)) continue;
      const r = pickReaction(p, c.kind);
      if (r === 'call') startCall(w, p, { x: c.x, z: c.z, heat: crime.heat, kind: c.kind, id: crime.id });
      else if (r === 'film') startFilming(w, p);
      else if (r === 'confront' && p.followId < 0) { p.state = 'confront'; p.timer = TUNING.reactions.confrontTime; p.shoutT = 0; }
      else startFlee(p, c.x, c.z);
      // shocked out loud (callers and filmers already show their phone bubble)
      if (c.kind === 'dogAttack' && (r === 'flee' || r === 'confront')) say(w, p, pick(LINES.dogWitness), 2.4, `ped${p.id}`);
    }
  }
  // calls and filming in progress
  for (const ped of w.peds) {
    if (!ped.phoneMode) continue;
    if (ped.state !== 'phone') {
      // knocked down, hit or scared off mid-call: the call never happened
      if (ped.phoneMode === 'call') { witnessStats.callsInterrupted++; clearBubble(`ped${ped.id}`); }
      ped.phoneMode = null;
      ped.report = null;
      continue;
    }
    ped.phoneT -= dt;
    if (ped.phoneT > 0) continue;
    if (ped.phoneMode === 'call' && ped.report) completeCall(w, ped);
    ped.phoneMode = null;
    ped.report = null;
    startFlee(ped, w.player.mesh.position.x, w.player.mesh.position.z, 4);
  }
}

function completeCall(w: World, ped: Ped) {
  const r = ped.report!;
  const crime = crimes.get(Number(r.kind));
  let heat = r.heat;
  if (crime) {
    heat = crime.reported ? WT.extraCallerHeat : crime.heat;
    crime.reported = true;
  }
  dispatchTo(w, r.x, r.z, heat);
  witnessStats.callsCompleted++;
  const kind = crime ? crime.kind : r.kind;
  witnessStats.completedByKind[kind] = (witnessStats.completedByKind[kind] ?? 0) + 1;
  witnessStats.lastCaller = ped.id;
  say(w, ped, "📞 They're on their way!", 2, `ped${ped.id}`);
  toast(w, '<span style="font-size:18px">📞 Someone reported you to the police</span>', 2.2);
}

/**
 * A dog's owner always reports it unless knocked down: after their scream ('yell', see hurtDog) or a flinch,
 * or straight away. Already on the phone? Then this is what they report.
 */
function ownerCalls(w: World, owner: Ped, crime: Crime) {
  if (owner.state === 'down' || owner.hidden || !owner.active) return;
  const report = { x: crime.x, z: crime.z, heat: crime.heat, kind: String(crime.id) };
  if ((owner.state === 'phone' && owner.phoneMode === 'call') || owner.state === 'yell' || owner.state === 'flinch') {
    // stopped filming to scream: drop the film here, or the phone loop below would wipe this report with it
    if (owner.state !== 'phone' && owner.phoneMode === 'film') owner.phoneMode = null;
    owner.report = report;
    return;
  }
  startCall(w, owner, { ...report, kind: crime.kind, id: crime.id });
}

/** Called by the victim's flinch handler (and a dog owner's scream): if they decided to call, they start now. */
export function victimMaybeCalls(w: World, ped: Ped): boolean {
  if (!ped.report) return false;
  const r = ped.report;
  ped.report = null;
  startCall(w, ped, { x: r.x, z: r.z, heat: r.heat, kind: r.kind, id: Number(r.kind) });
  return true;
}

export function startFleeFrom(w: World, ped: Ped) {
  startFlee(ped, w.player.mesh.position.x, w.player.mesh.position.z);
}
