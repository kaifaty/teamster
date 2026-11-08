// Colours the scene draws with. Space is dark in both of the board's themes; the fleets use the board's dark
// --codex and --claude hues (styles.css), which read well on it.

import type { Family } from "./fleet";

export const SPACE = {
  void: "#05070d",
  star: "#e9eefc",
  orbit: "#a0bedc",
  route: "#c8d7f0",
  fix: "#ebaa46",
  gold: "#f3c64e",
  alarm: "#ff5a4a",
  ok: "#5fc48c",
  select: "#ffffff",
  hover: "#c8d7f0",
  sleep: "#a9cdf0",
  gauge: "#1a2130",
  /** A ship whose CI failed: smoke, sparks and the glow of a fire under the plating. */
  smoke: "#5d5550",
  spark: "#ffd38a",
  burn: "#ff3c1e",
  /** Patches of the fix rounds: plain steel plates with darker seams and bright rivets. */
  plate: "#8b8f97",
  seam: "#3c3f46",
  rivet: "#d6d9de",
  /** A storm over a star in trouble, and its lightning. */
  storm: "#17121f",
  stormEdge: "#3a2d4a",
  lightning: "#e6dcff",
  /** The dim warning light of an empty fuel tank. */
  empty: "#ff7a50",
  /** The research station's glow, its watch beams and probes. */
  research: "#5fd6c8",
} as const;

/** `escort` tints the reviewer's drone: the family's hue, light enough that the art's paint still shows. */
export const FLEET: Record<Family, { hull: string; engine: string; escort: string }> = {
  codex: { hull: "#7ea6f5", engine: "#ffb648", escort: "#b4ccff" },
  claude: { hull: "#e59472", engine: "#74d6e8", escort: "#ffc2a6" },
};

/**
 * Suns differ by repository, so that a system is told apart at a glance: a small turn of the art's hue in
 * degrees, or a cold star that keeps the art's surface in pale blue, with the colour of the glow.
 */
export const SUN_KINDS: readonly { hue: number; cold?: boolean; glow: string }[] = [
  { hue: 0, glow: "#ff9a3c" },
  { hue: 16, glow: "#ffd76a" },
  { hue: -16, glow: "#ff6a4a" },
  { hue: 0, cold: true, glow: "#8fc0ff" },
];
