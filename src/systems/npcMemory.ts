// Turns world events into NPC memories and relationship changes, and makes bystanders flee violence.
import { TUNING } from '../tuning';
import type { World, GameEvent } from '../world';
import { remember, adjustRelationship, type MemoryKind } from '../npc/npc';
import { startFlee } from './pedestrians';

const N = TUNING.npc;

export function updateNpcMemory(w: World): void {
  const hour = w.dayNight.hour, day = w.dayNight.day;
  for (const e of w.events) {
    const near = (r: number) => w.peds.filter((p) => p.active && !p.hidden && Math.hypot(p.pos.x - ('x' in e ? e.x : 0), p.pos.z - ('z' in e ? e.z : 0)) < r);
    const mem = (kind: MemoryKind, note: string, rel: number, radius = TUNING.peds.memoryRadius, skip = -1) => {
      for (const p of near(radius)) {
        if (p.id === skip) continue;
        remember(p.npc, kind, note, hour, day);
        adjustRelationship(p.npc, rel);
      }
    };
    switch (e.type) {
      case 'pedHit': {
        const victim = w.peds[e.pedId];
        remember(victim.npc, 'hitMe', `ran me over doing ${Math.round(e.speed * 3.6)} km/h`, hour, day);
        adjustRelationship(victim.npc, N.relationshipOnHit);
        victim.npc.mood = Math.max(-1, victim.npc.mood - 0.6);
        mem('hitSomeone', `knocked down ${victim.npc.name.split(' ')[0]} with a car`, -20, TUNING.peds.memoryRadius, e.pedId);
        for (const p of near(30)) if (p.id !== e.pedId && p.state !== 'talk') startFlee(p, e.x, e.z);
        break;
      }
      case 'carHit':
        mem('rammedCar', e.targetKind === 'police' ? 'rammed a police car' : 'smashed into another car', -8);
        for (const p of near(18)) if (p.state === 'walk' || p.state === 'idle') startFlee(p, e.x, e.z, 3);
        break;
      case 'crash':
        if (e.damage > 8) mem('crashed', 'crashed a car right in front of me', -3, 25);
        break;
      case 'speeding':
        mem('speeding', `tore past at ${Math.round(e.speed * 3.6)} km/h`, -4, 14);
        break;
      case 'fareComplete':
        mem('fareDone', 'dropped off a taxi passenger', N.relationshipOnFareNearby, 25);
        break;
      case 'assault':
      case 'harassment': {
        const victim = w.peds[e.pedId];
        const name = victim ? victim.npc.name.split(' ')[0] : 'someone';
        mem('sawAssault', e.type === 'assault' ? `attacked ${name} with a ${e.weapon.toLowerCase()}` : `threw stuff at ${name}`, e.type === 'assault' ? -15 : -6, 30, e.pedId);
        if (e.type === 'assault') for (const p of near(18)) if (p.id !== e.pedId && (p.state === 'walk' || p.state === 'idle')) startFlee(p, e.x, e.z, 4);
        break;
      }
      case 'dogHurt': {
        const owner = w.peds[e.pedId];
        const DG = TUNING.dogs;
        if (owner) {
          remember(owner.npc, 'hurtMyDog', e.cause === 'car' ? 'ran my dog over' : `hurt my dog with a ${e.weapon.toLowerCase()}`, hour, day);
          adjustRelationship(owner.npc, DG.relationshipOwner);
          owner.npc.mood = Math.max(-1, owner.npc.mood - DG.ownerMoodDrop);
        }
        const name = owner ? owner.npc.name.split(' ')[0] : 'someone';
        mem('sawDogHurt', `hurt ${name}'s dog`, DG.relationshipWitness, TUNING.peds.memoryRadius, e.pedId);
        for (const p of near(DG.bystanderFleeRadius)) if (p.id !== e.pedId && (p.state === 'walk' || p.state === 'idle')) startFlee(p, e.x, e.z, DG.bystanderFleeTime);
        break;
      }
      case 'vandalism':
        mem('vandalism', `smashed up ${e.what.startsWith('a ') ? e.what : 'a ' + e.what.toLowerCase()}`, -6, 25);
        break;
      case 'busted':
        mem('busted', 'got arrested by the police', -5, 40);
        break;
      case 'carTheft': {
        const label = w.vehicles[e.carId]?.spec.label.toLowerCase() ?? 'car';
        const owner = e.ownerId >= 0 ? w.peds[e.ownerId] : null;
        // the owner (if around at all) knows it was you and holds a grudge
        if (owner && owner.active) {
          remember(owner.npc, 'stoleMyCar', e.ownerSaw ? `stole my ${label} right in front of me` : `stole my ${label}`, hour, day);
          adjustRelationship(owner.npc, N.relationshipOnCarTheft);
          owner.npc.mood = Math.max(-1, owner.npc.mood - 0.5);
        }
        const name = owner ? `${owner.npc.name.split(' ')[0]}'s` : 'an abandoned';
        const radius = e.alarm ? TUNING.witness.radius.carTheftAlarm : TUNING.peds.memoryRadius;
        mem('sawCarTheft', e.forced ? `smashed the window of ${name} ${label} and drove off in it` : `drove off in ${name} ${label}`, N.relationshipOnSawTheft, radius, e.ownerId);
        break;
      }
    }
  }
}

export function describeEvent(e: GameEvent): string {
  return e.type;
}
