// What the scene's layers share. A layer draws one part of the map in its own container: the scene puts the containers
// on the stage in the order of its lists, redraws the galaxy's layers when the model changes and calls every layer once
// a frame.
//
// To add a new object to the galaxy:
//   1. a module in galaxy/ whose create function returns a GalaxyLayer: its own root, its Pixi objects and the state
//      of its animation, freed by dispose();
//   2. one line in the galaxy's list of layers in index.ts, where it stands among the others;
//   3. a field of GalaxyModel in types.ts for what it shows, filled in by MapView;
//   4. its label, if it has one, in MapView.

import type { Container } from "pixi.js";
import type { Point, Size, SystemFrame } from "../layout";
import type { GalaxyModel } from "./types";

/** The frame's clock: seconds since the scene began, the step of this frame, and whether motion is reduced. */
export interface Clock {
  time: number;
  dt: number;
  still: boolean;
}

/** What a galaxy layer draws by: the model, the galaxy's world and where the stars stand in it. */
export interface GalaxyDraw {
  model: GalaxyModel;
  world: Size;
  stars: ReadonlyMap<string, Point>;
}

export interface GalaxyLayer {
  readonly root: Container;
  /** Draws the layer afresh: the model, the window or the layout changed. */
  draw(scene: GalaxyDraw): void;
  /** Moves what moves, once a frame while the galaxy is shown. */
  frame?(clock: Readonly<Clock>): void;
  /** Frees the layer's container and whatever else it made. */
  dispose(): void;
}

export interface SystemLayer {
  readonly root: Container;
  /** Lays the layer out in the system's frame: the window, the panels or the system changed. */
  layout(frame: SystemFrame): void;
  /** Moves what moves, once a frame while a system is shown. */
  frame(clock: Readonly<Clock>): void;
  dispose(): void;
}

/** What is under a point of the map. */
export type Hit =
  | { kind: "star"; repo: string }
  | { kind: "research" }
  | { kind: "machine"; id: string }
  | { kind: "ship"; slug: string };
