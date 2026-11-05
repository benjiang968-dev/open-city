// The single typed World object shared by every system. No globals: systems receive `w`.
import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Rng } from './rng';
import type { InputState } from './systems/input';
import type { CityMap } from './systems/map/cityMap';
import type { PlayerState } from './systems/player';
import type { Vehicle } from './systems/vehicles';
import type { TrafficCar, TrafficSim } from './systems/traffic';
import type { JunctionState } from './systems/junctions';
import type { TrafficPopulation } from './systems/trafficPopulation';
import type { SignalHeads } from './systems/signalHeads';
import type { Ped } from './systems/pedestrians';
import type { PoliceState } from './systems/police';
import type { JobManager } from './systems/economy/jobManager';
import type { CameraState } from './systems/camera';
import type { DayNightState } from './systems/dayNight';
import type { AudioState } from './systems/audio';
import type { HudState } from './systems/hud';
import type { ChatState } from './systems/chat';
import type { DialogueProvider } from './npc/providers/provider';
import type { WeatherState } from './systems/weather';
import type { Profiler } from './systems/profiler';
import type { SettingsState } from './systems/settings';
import type { ItemsState } from './systems/worldItems';
import type { InventoryState } from './systems/inventory';
import type { CombatState } from './systems/combat';
import type { CrowdRender } from './systems/crowdRender';
import type { PedDensityState } from './systems/pedDensity';
import type { ParkedState } from './systems/parkedCars';
import type { HurtFxState } from './systems/hurtFx';
import type { PhysDebugState } from './systems/physicsDebug';
import type { Look } from './systems/render/look';

/** Things that happen in the world. NPC memory, police heat and jobs all listen to these. */
export type GameEvent =
  | { type: 'pedHit'; pedId: number; x: number; z: number; speed: number }
  | { type: 'carHit'; targetKind: 'traffic' | 'police' | 'parked'; x: number; z: number; speed: number }
  | { type: 'crash'; x: number; z: number; damage: number; dv: number }
  | { type: 'fareComplete'; x: number; z: number; pay: number }
  | { type: 'enterCar'; x: number; z: number; carId: number; seen: boolean }
  | { type: 'speeding'; x: number; z: number; speed: number }
  | { type: 'busted'; x: number; z: number }
  | { type: 'assault'; pedId: number; x: number; z: number; weapon: string }
  | { type: 'harassment'; pedId: number; x: number; z: number; weapon: string }
  | { type: 'vandalism'; x: number; z: number; what: string }
  | { type: 'menace'; x: number; z: number }
  /** The player hurt a dog; `pedId` is its owner (dog walker). */
  | { type: 'dogHurt'; pedId: number; x: number; z: number; cause: 'car' | 'thrown' | 'melee'; weapon: string }
  /**
   * You took a car that isn't yours. ownerId: the owner's ped id (-1: abandoned); ownerSaw: the owner noticed
   * and is coming after you; alarm: its alarm is sounding; forced: you smashed the window to get in.
   */
  | { type: 'carTheft'; x: number; z: number; carId: number; ownerId: number; ownerSaw: boolean; alarm: boolean; forced: boolean }
  | { type: 'policeCalled'; x: number; z: number; byPed: number };

export interface World {
  seed: number;
  rng: Rng;
  R: typeof RAPIER;
  physics: RAPIER.World;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  input: InputState;
  cam: CameraState;
  dayNight: DayNightState;
  weather: WeatherState;
  /** Baked surface maps and the uniforms every world material shares (render/look.ts). */
  look: Look;
  prof: Profiler;
  settings: SettingsState;
  itemsState: ItemsState;
  inventory: InventoryState;
  combat: CombatState;
  crowd: CrowdRender;
  hurtFx: HurtFxState;
  /** F4 collision view (physicsDebug.ts). */
  physDebug: PhysDebugState;
  /** Crowd density from the map: busyness per walk link, the target around the player (pedDensity.ts). */
  pedDensity: PedDensityState;
  /** Every parked car on the map, the pool of drivable stand-ins near you, the instanced parked-car meshes. */
  parked: ParkedState;
  /** The map (road and walk graphs, places, lookups). Every system reads the city through this interface. */
  city: CityMap;
  player: PlayerState;
  vehicles: Vehicle[];
  /** AI traffic cars driving now (the preset's count; the rest wait in trafficSim.pool). */
  traffic: TrafficCar[];
  trafficSim: TrafficSim;
  trafficPop: TrafficPopulation;
  /** Junction control: moves, conflicts, signal phases and lights (junctions.ts). */
  junctions: JunctionState;
  signalHeads: SignalHeads;
  peds: Ped[];
  police: PoliceState;
  jobs: JobManager;
  cash: number;
  audio: AudioState;
  hud: HudState;
  chat: ChatState;
  dialogue: DialogueProvider;
  started: boolean;
  paused: boolean;
  time: number; // real seconds since load
  frameDt: number;
  fps: number;
  debugVisible: boolean;
  /** Events raised this frame; cleared after all systems update. */
  events: GameEvent[];
  /** Collider handle -> what it belongs to, for collision attribution. */
  colliderOwner: Map<number, { kind: 'vehicle' | 'traffic' | 'police' | 'static' | 'ped'; id: number }>;
}

export function emit(w: World, e: GameEvent): void {
  w.events.push(e);
}
