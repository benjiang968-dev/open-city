// The single typed World object shared by every system. No globals: systems receive `w`.
import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Rng } from './rng';
import type { InputState } from './systems/input';
import type { CityData } from './systems/cityGen';
import type { PlayerState } from './systems/player';
import type { Vehicle } from './systems/vehicles';
import type { TrafficCar } from './systems/traffic';
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
  prof: Profiler;
  settings: SettingsState;
  itemsState: ItemsState;
  inventory: InventoryState;
  combat: CombatState;
  city: CityData;
  player: PlayerState;
  vehicles: Vehicle[];
  traffic: TrafficCar[];
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
  colliderOwner: Map<number, { kind: 'vehicle' | 'traffic' | 'police' | 'static'; id: number }>;
}

export function emit(w: World, e: GameEvent): void {
  w.events.push(e);
}
