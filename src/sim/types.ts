/**
 * Shared types for the simulation layer.
 *
 * Kept in their own module so sim/, render/ and ui/ can refer to the same
 * shapes without creating runtime import cycles.
 */

import type * as THREE from 'three';
import type { Terrain } from './terrain';
import type { Track } from './track';
import type { CarSim } from './car';
import type { AIController } from './ai';
import type { RaceAudio } from '../audio/raceAudio';
import type { Dust } from '../render/dust';

/** What both a human and the AI produce. Everything else derives from this. */
export interface DriveInput {
  throttle: number;
  brake: number;
  /** -1 = right, +1 = left. Positive yaw turns toward screen-left. */
  steer: number;
  handbrake: boolean;
  boost: boolean;
}

export const NEUTRAL_INPUT: Readonly<DriveInput> = Object.freeze({
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  boost: false,
});

/** Power-up kinds. Owned by items.ts, carried on the car. */
export type ItemKind = 'banana' | 'rocket' | 'shield' | 'turbo' | null;

export interface MenuApi {
  showScreen(name: string): void;
  showCountdown(text: string | null): void;
  showNotice(text: string, ms?: number): void;
  updateHud(state: HudState): void;
  setMinimap(data: MinimapData | null): void;
  setResults(data: ResultsData): void;
  setTelemetry(dist: number, speedKmh: number, wrapLength: number): void;
}

export interface HudState {
  visible?: boolean;
  speedKmh?: number;
  lap?: number;
  lapsTotal?: number;
  position?: number;
  total?: number;
  clock?: number;
  bestLap?: number | null;
  boost?: number;
  raceProgress?: number;
  drift?: boolean;
  item?: ItemKind;
  standings?: StandingRow[];
}

export interface StandingRow {
  name: string;
  color: string;
  lap: number;
  me: boolean;
  finished: boolean;
}

export interface MinimapCar {
  x: number;
  z: number;
  isPlayer: boolean;
  color: string;
}

export interface MinimapData {
  track: [number, number][];
  cars: MinimapCar[];
}

export interface ResultRow {
  name: string;
  time: number | null;
  gap: number | null;
  isPlayer: boolean;
}

export interface ResultsData {
  position: number;
  total: number;
  totalTime: number | null;
  bestLap: number | null;
  laps: number[];
  standings: ResultRow[];
}

export interface Settings {
  quality: 'HIGH' | 'MEDIUM' | 'LOW';
  sound: boolean;
}

/** Everything the simulation is allowed to reach out to. */
export interface SimEnv {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  terrain: Terrain;
  track: Track;
  audio: RaceAudio;
  dust: Dust;
  autopilot: boolean;
  markBloom?: (root: THREE.Object3D) => void;
  menu: MenuApi | null;
}

export type { CarSim, AIController, Terrain, Track, RaceAudio, Dust };
