// NPC identity, personality, routine, mood, relationship and memory. Pure data, no rendering.
import { Rng } from '../rng';
import { FIRST_NAMES, LAST_NAMES, JOBS } from '../names';
import type { CityData, Poi } from '../systems/cityGen';
import { TUNING } from '../tuning';

export type Personality = 'friendly' | 'grumpy' | 'nervous' | 'chatty' | 'posh' | 'laidback';
export const PERSONALITIES: Personality[] = ['friendly', 'grumpy', 'nervous', 'chatty', 'posh', 'laidback'];

export type MemoryKind =
  | 'hitMe' // you knocked me down
  | 'hitSomeone' // you knocked someone down near me
  | 'crashed' // you crashed a car near me
  | 'rammedCar' // you rammed another car near me
  | 'speeding' // you tore past me
  | 'fareDone' // you dropped off a taxi fare near me
  | 'chatted' // we talked
  | 'insulted' // you were rude to me
  | 'complimented'
  | 'busted' // I saw the police catch you
  | 'assaulted' // you hit me with something
  | 'sawAssault' // I saw you attack someone
  | 'vandalism' // I saw you smash up a car
  | 'stoleMyCar' // you stole my car
  | 'sawCarTheft'; // I saw you take someone's car

export interface MemoryEntry {
  kind: MemoryKind;
  hour: number; // game hour it happened
  day: number;
  note: string; // short human-readable description, also fed to an LLM provider later
}

export interface RoutineStop {
  fromHour: number; // routine entry active from this hour until the next entry
  poiId: number;
}

export interface NpcProfile {
  id: number;
  name: string;
  job: string;
  personality: Personality;
  homePoi: number;
  workPoi: number;
  routine: RoutineStop[];
  mood: number; // -1 (awful day) .. 1 (great day)
  relationship: number; // -100..100 toward the player
  memory: MemoryEntry[]; // newest last, max TUNING.npc.memorySize
  /** Things the player and NPC said, newest last (kept short). */
  history: { who: 'player' | 'npc'; text: string }[];
  timesTalked: number;
  archetype: string; // adult, jogger, delivery, tourist, elderly, parent, kid, dogwalker
}

export function generateNpc(id: number, rng: Rng, city: CityData): NpcProfile {
  const homes = city.pois.filter((p) => p.kind === 'apartment');
  const works = city.pois.filter((p) => ['office', 'cafe', 'diner', 'shop', 'bar', 'hotel', 'gym', 'clinic', 'market', 'garage', 'marina'].includes(p.kind));
  const leisure = city.pois.filter((p) => ['park', 'cafe', 'bar', 'beach', 'pier', 'diner', 'market'].includes(p.kind));
  const home = (homes.length ? rng.pick(homes) : rng.pick(city.pois)) as Poi;
  const work = rng.pick(works);
  const jobFor: Record<string, string[]> = {
    office: ['accountant', 'lawyer', 'software developer'], cafe: ['barista', 'chef'], diner: ['chef', 'barista'],
    shop: ['shop owner', 'florist', 'security guard'], bar: ['bartender', 'street musician'], hotel: ['hotel receptionist', 'chef'],
    gym: ['lifeguard', 'security guard'], clinic: ['nurse'], market: ['fisher', 'shop owner'], garage: ['mechanic'],
    marina: ['dock worker', 'fisher'],
  };
  const job = rng.chance(0.15) ? rng.pick(['student', 'retired teacher', 'painter', 'courier']) : rng.pick(jobFor[work.kind] ?? JOBS);
  const fun = rng.pick(leisure);
  const fun2 = rng.pick(leisure);
  const start = rng.int(6, 10);
  const end = start + rng.int(6, 9);
  return {
    id,
    name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
    job,
    personality: rng.pick(PERSONALITIES),
    homePoi: home.id,
    workPoi: work.id,
    routine: [
      { fromHour: 0, poiId: home.id },
      { fromHour: start - 1, poiId: fun2.id },
      { fromHour: start, poiId: work.id },
      { fromHour: Math.min(23, end), poiId: fun.id },
      { fromHour: Math.min(23.5, end + rng.int(2, 4)), poiId: home.id },
    ],
    mood: rng.range(-0.4, 0.8),
    relationship: 0,
    memory: [],
    history: [],
    timesTalked: 0,
    archetype: 'adult',
  };
}

export function routineTarget(npc: NpcProfile, hour: number): number {
  let poi = npc.routine[0].poiId;
  for (const r of npc.routine) if (hour >= r.fromHour) poi = r.poiId;
  return poi;
}

export function remember(npc: NpcProfile, kind: MemoryKind, note: string, hour: number, day: number): void {
  // don't fill memory with repeats of the same thing within the same hour
  const last = npc.memory[npc.memory.length - 1];
  if (last && last.kind === kind && last.day === day && Math.abs(last.hour - hour) < 0.5) return;
  npc.memory.push({ kind, note, hour, day });
  while (npc.memory.length > TUNING.npc.memorySize) npc.memory.shift();
}

export function adjustRelationship(npc: NpcProfile, delta: number): void {
  npc.relationship = Math.max(-100, Math.min(100, npc.relationship + delta));
}
