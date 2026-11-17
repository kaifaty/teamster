// The scene's public types: what MapView gives the scene and what it gets back.

import type { ArtIndex, TaskSummary } from "../../types";
import type { Constellation } from "../constellations";
import type { Star } from "../fleet";
import type { Camera, Galaxy, Insets, Size } from "../layout";
import type { Placement } from "../placement";

export interface ShipEntry {
  task: TaskSummary;
  placement: Placement;
}

export interface GalaxyModel {
  stars: Star[];
  /** Where the stars stand and how large they are drawn: see galaxyLayout. */
  layout: Galaxy;
  /** Stars drawn together under a faint cloud of their own colour. */
  constellations: Constellation[];
}

export interface SceneOptions {
  host: HTMLElement;
  onEnter: (repo: string) => void;
  onLeave: () => void;
  onPick: (slug: string) => void;
  onHover: (slug: string | null) => void;
  /** The star under the pointer in the galaxy, so that its label shows even while it waits for the zoom. */
  onHoverStar?: (repo: string | null) => void;
  /** The shapes of the galaxy's world and of the system's, and the camera over the one shown, for the labels. */
  onCamera: (worlds: { galaxy: Size; system: Size }, camera: Camera) => void;
  /** Labels wait until the flight and any system texture loading finish. */
  onFlight: (flying: boolean) => void;
  /** The labels over the canvas: the wheel and a pinch over them move the camera too. */
  labels?: HTMLElement;
  onLost: () => void;
  onSystemError: (error: unknown) => void;
}

export interface FleetScene {
  setGalaxy(model: GalaxyModel): void;
  /** The repositories' own pictures; whatever is missing stays shared art. */
  setArt(art: ArtIndex): void;
  /** Shows system `repo`, or the galaxy for null, flying there unless motion is reduced. */
  setView(repo: string | null): void;
  /**
   * The ships to show. A ship missing from `entries` leaves for the sun from the roadstead and fades from anywhere else.
   */
  setShips(entries: ShipEntry[]): void;
  setSelected(slug: string | null): void;
  setHovered(slug: string | null): void;
  /**
   * The parts of the window the map's panels cover: a system is laid out in the rest, and the galaxy is fitted above
   * the bottom one, the control panel.
   */
  setInsets(insets: Insets): void;
  setActive(active: boolean): void;
  dispose(): void;
}

/** Seconds of the flight between the galaxy and a system. */
export const FLIGHT_SECONDS = 0.9;
