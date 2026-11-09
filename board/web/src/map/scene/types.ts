// The scene's public types: what MapView gives the scene and what it gets back.

import type { ArtIndex, MachineStatus, TaskSummary } from "../../types";
import type { Rings } from "../../lib/machines";
import type { Constellation } from "../constellations";
import type { Family, Star } from "../fleet";
import type { Camera, FuelColumn, Galaxy, Insets, MachineColumn, Size } from "../layout";
import type { Placement } from "../placement";

export interface ShipEntry {
  task: TaskSummary;
  placement: Placement;
}

/** What the science station shows: see research.ts. */
export interface ResearchMarks {
  running: boolean;
  /** Lessons that wait for a decision. */
  proposed: number;
  /** Studies whose analyst waits for the human's answer: the dish sends out rings. */
  waiting: number;
  probes: string[];
}

/** A machine's reactor: its glow tells the machine's status, its rings how much of each resource is in use. */
export interface MachineMark {
  id: string;
  status: MachineStatus;
  rings: Rings;
}

/** A subscription's fuel tank, as the scene draws it. */
export interface TankMark {
  key: string;
  executor: Family;
  /** Weekly limit left in percent, the height of the fuel in the glass; null when unknown. */
  fuel: number | null;
  /** Little or nothing left: the fuel runs red and a warning light blinks. */
  low: boolean;
  /** Exhausted, limited or logged out: the tank turns grey. */
  bad: boolean;
  /** The account kept for the orchestrator: the admiral's badge crowns it. */
  admiral: boolean;
  /** Lamps that burn beside the tank, one per day left until it refills: 0 to DAY_LAMPS. */
  lamps: number;
  /** It refills within a day: its one lamp blinks. */
  soon: boolean;
}

export interface GalaxyModel {
  stars: Star[];
  /** Where the stars stand and how large they are drawn: see galaxyLayout. */
  layout: Galaxy;
  tanks: TankMark[];
  /** Where the tanks stand: see fuelPositions; null without subscriptions. */
  fuel: FuelColumn | null;
  /** Stars drawn together under a faint cloud of their own colour. */
  constellations: Constellation[];
  /** null: no station, the server tells nothing about research. */
  research: ResearchMarks | null;
  machines: MachineMark[];
  /** Where the machines' stations stand: see machinePositions; null without machines. */
  machineColumn: MachineColumn | null;
}

export interface SceneOptions {
  host: HTMLElement;
  onEnter: (repo: string) => void;
  onLeave: () => void;
  onPick: (slug: string) => void;
  onHover: (slug: string | null) => void;
  /** The star under the pointer in the galaxy, so that its label shows even while it waits for the zoom. */
  onHoverStar?: (repo: string | null) => void;
  /** The science station was clicked. */
  onResearch: () => void;
  /** A machine's reactor was clicked. */
  onMachine?: (id: string) => void;
  /** The shapes of the galaxy's world and of the system's, and the camera over the one shown, for the labels. */
  onCamera: (worlds: { galaxy: Size; system: Size }, camera: Camera) => void;
  /** The labels over the canvas: the wheel and a pinch over them move the camera too. */
  labels?: HTMLElement;
  onLost: () => void;
}

export interface FleetScene {
  setGalaxy(model: GalaxyModel): void;
  /** The repositories' own pictures; whatever is missing stays shared art. */
  setArt(art: ArtIndex): void;
  /** Shows system `repo`, or the galaxy for null, flying there unless motion is reduced. */
  setView(repo: string | null): void;
  /**
   * The ships to show. A ship missing from `entries` leaves: by `departures` when given (a slug it lacks fades),
   * otherwise into the sun from the roadstead and fading from anywhere else.
   */
  setShips(entries: ShipEntry[], departures?: ReadonlyMap<string, "dive" | "fade">): void;
  setSelected(slug: string | null): void;
  /** The machine whose card is open: its station is marked like a selected ship. */
  setMachine(id: string | null): void;
  setHovered(slug: string | null): void;
  /** The parts of the window the map's panels cover: a system is laid out in the rest. */
  setInsets(insets: Insets): void;
  setActive(active: boolean): void;
  dispose(): void;
}

/** Seconds of the flight between the galaxy and a system. */
export const FLIGHT_SECONDS = 0.9;
