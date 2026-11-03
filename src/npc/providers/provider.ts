// The dialogue provider interface. Game code only ever talks to this, so a scripted provider and an
// LLM provider (behind a server proxy, never with a key in the client) are interchangeable.
import type { NpcProfile } from '../npc';

/** Structured things an NPC can do as a result of a conversation. The game applies them. */
export type NpcAction =
  | { type: 'offerJob'; job: 'taxi'; detail: string } // NPC asks to be driven somewhere (becomes a fare)
  | { type: 'acceptRide' } // NPC accepts the player's offer of a ride
  | { type: 'refuse' } // NPC refuses to deal with the player
  | { type: 'giveTip'; poiId: number } // NPC points to a place (e.g. where fares are waiting)
  | { type: 'callPolice' } // NPC reports the player
  | { type: 'trade'; item: string; price: number }; // NPC sells the player something small

export interface DialogueWorldInfo {
  hour: number;
  clock: string;
  isNight: boolean;
  weather: 'clear' | 'cloudy' | 'fog' | 'rain' | 'storm' | 'snow';
  playerInCar: boolean;
  playerCarLabel: string | null;
  wantedStars: number;
  cash: number;
  npcWorkplace: string;
  npcHome: string;
  nearestPlace: string;
  /** Taxi ranks the NPC can mention, with the one that has a fare waiting first. */
  taxiRanks: { poiId: number; name: string; street: string; hasFare: boolean }[];
  /** Short things other NPCs nearby have seen the player do (for gossip). */
  gossip: string[];
  /** Named places for "where is X" questions. */
  places: { poiId: number; name: string; kind: string; street: string }[];
}

export interface DialogueRequest {
  npc: Readonly<NpcProfile>;
  playerText: string;
  world: DialogueWorldInfo;
}

export interface DialogueReply {
  text: string;
  action?: NpcAction;
  relationshipDelta?: number; // applied by the game, clamped to -100..100
  moodDelta?: number;
}

export interface DialogueProvider {
  readonly id: string;
  reply(req: DialogueRequest): Promise<DialogueReply>;
}
