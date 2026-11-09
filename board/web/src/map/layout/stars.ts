// Where the galaxy's stars stand: the lattice, the constellations and the parts of the galaxy kept clear of them.

import { fuelColumnRect, type FuelColumn } from "./fuel";
import {
  constellationKey,
  LABEL_ZOOM,
  starFootprint,
  starSize,
  type Galaxy,
  type Groups,
  type LabelledLattice,
  type Lattice,
  type StarShape,
} from "./galaxy";
import { hashName, type Point, type Rect, type Size } from "./geometry";
import { machineColumnRect, machineNoteRoom, type MachineColumn } from "./machines";
import { RESEARCH_SIZE, researchPosition } from "./research";

/** Two steps of the lattice differ by this ratio, so that a galaxy that gains or loses a star usually keeps its lattice. */
const SPACING_LADDER = 1.08;
/** The stars share the free part of the galaxy with a quarter more room than they take, so that it fills evenly. */
const SPARE = 1.25;
/** The share of a step a star stands off its node, so that the rows do not look ruled. */
const NODE_JITTER = 0.12;

/**
 * The parts of the galaxy where no star stands: the science station, the fuel tanks and the machines' reactors
 * with their labels, and the parts `covered` by the map's own panels.
 */
export function galaxyKeepOuts(size: Size, covered: readonly Rect[], machines: MachineColumn | null = null, fuel: FuelColumn | null = null): Rect[] {
  const station = researchPosition(size, covered, machines, fuel);
  const result: Rect[] = [
    { x0: station.x - 150, y0: station.y - RESEARCH_SIZE / 2 - 40, x1: station.x + 150, y1: station.y + RESEARCH_SIZE / 2 + 85 },
  ];
  // Each whole column, the gaps between its rows too: a star there could never show its label, see MapView.
  for (const rect of [machines ? machineColumnRect(machines) : null, machines ? machineNoteRoom(machines) : null, fuel ? fuelColumnRect(fuel) : null]) {
    if (rect) result.push(rect);
  }
  return [...result, ...covered];
}

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
/**
 * A number in [0, 1) from a name, its bits mixed well: names that differ in their last letter, like art-1 and art-2,
 * land far apart.
 */
function unit(name: string): number {
  let hash = hashName(name);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return ((hash ^ (hash >>> 16)) >>> 0) / 2 ** 32;
}

/** The region the stars stand in, a little in from the edges; the keep-outs take the panels and the columns. */
function galaxyRegion(size: Size): Rect {
  return { x0: 50, y0: 40, x1: size.width - 50, y1: size.height - 30 };
}

function freeArea(region: Rect, blocked: readonly Rect[]): number {
  let area = 0;
  for (let x = region.x0 + 10; x < region.x1; x += 20) {
    for (let y = region.y0 + 10; y < region.y1; y += 20) {
      if (!blocked.some((rect) => x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1)) area += 400;
    }
  }
  return area;
}

/** The nodes of a hexagonal lattice over the region, each row shifted by half a step; none inside `blocked`. */
function latticeNodes(region: Rect, blocked: readonly Rect[], spacing: number): Point[] {
  const nodes: Point[] = [];
  const rowStep = (spacing * Math.sqrt(3)) / 2;
  for (let row = 0, y = region.y0 + rowStep / 2; y < region.y1; row++, y += rowStep) {
    for (let x = region.x0 + spacing / 2 + (row % 2 ? spacing / 2 : 0); x < region.x1; x += spacing) {
      if (!blocked.some((rect) => x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1)) nodes.push({ x, y });
    }
  }
  return nodes;
}

/** The star alone, without its label: no two of these overlap, nor the keep-outs. */
function starCore(star: StarShape, at: Point, lattice: Lattice): Rect {
  const glow = starSize(star.live, lattice) * 1.15 + 4;
  return { x0: at.x - glow, y0: at.y - glow, x1: at.x + glow, y1: at.y + glow };
}

/** Stars of another constellation, or one in a constellation and one in none, keep this many steps apart when they can. */
const STRANGER_STEPS = 1.5;
/** A constellation's stars look this many steps around its middle for a place. */
const GATHER_STEPS = 6;

/** The reach a constellation of `count` stars needs around its middle, in world units. */
const reachOf = (count: number, spacing: number) => spacing * (1.2 + Math.sqrt(count) * 0.7);

/**
 * Where constellation `name` of `count` stars may have its middle, the most open first, at most `limit` of them: free
 * nodes with the most free room around them within its reach, the nearest nodes counting most, so that it settles in open
 * sky rather than around the science station, along a column or at the edge; and away from the middles in `taken`, so
 * that two constellations do not run into each other. Equal nodes go by the constellation's name.
 */
export function centreChoices(
  name: string,
  count: number,
  nodes: readonly Point[],
  spacing: number,
  taken: ReadonlyMap<Point, number>,
  limit = 24,
): Point[] {
  const reach = reachOf(count, spacing);
  const scored = nodes.map((node, index) => {
    let room = 0;
    for (const other of nodes) {
      const distance = Math.hypot(other.x - node.x, other.y - node.y);
      if (distance < reach) room += 1 - distance / reach;
    }
    for (const [at, size] of taken) {
      const apart = reach + reachOf(size, spacing);
      const gap = Math.hypot(at.x - node.x, at.y - node.y);
      if (gap < apart) room -= nodes.length * (1 - gap / apart);
    }
    return { node, score: room + unit(`${name}#${index}`) * 0.01 };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.node);
}

/**
 * Places the stars on one lattice. A star takes the nearest node to its home, within a few steps, where it and its
 * label fit; failing that, the nearest node where the star itself fits, its label left to wait for the zoom, which
 * `crowded` counts. The stars of a constellation come first, gathered around its middle; every star keeps
 * STRANGER_STEPS from the stars it does not share a constellation with, where it can.
 */
function placeStars(
  stars: readonly StarShape[],
  region: Rect,
  blocked: readonly Rect[],
  lattice: LabelledLattice,
  previous: ReadonlyMap<string, Point> | null,
  groups: Groups = new Map(),
): { places: Map<string, Point>; crowded: number } {
  const { spacing } = lattice;
  const slack = 30;
  const inside = (rect: Rect) => rect.x0 >= region.x0 - slack && rect.y0 >= region.y0 - slack && rect.x1 <= region.x1 + slack && rect.y1 <= region.y1 + slack;
  const nodes = latticeNodes(region, blocked, spacing);
  const rooms: Rect[] = [...blocked];
  const cores: Rect[] = [...blocked];
  const places = new Map<string, Point>();
  const free = (rect: Rect, taken: Rect[]) => inside(rect) && !taken.some((other) => overlaps(rect, other));
  const fits = (star: StarShape, at: Point) => free(starFootprint(star, at, lattice), rooms);
  const put = (star: StarShape, at: Point, labelled: boolean) => {
    places.set(star.repo, at);
    cores.push(starCore(star, at, lattice));
    rooms.push(labelled ? starFootprint(star, at, lattice) : starCore(star, at, lattice));
  };
  // The largest first: they need the most room.
  const area = (star: StarShape) => {
    const rect = starFootprint(star, { x: 0, y: 0 }, lattice);
    return (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
  };
  const groupOf = (star: StarShape) => groups.get(star.repo) ?? "";
  // A constellation's stars first, a constellation at a time; the largest first within each, and among the rest.
  const order = [...stars].sort(
    (a, b) => +!groupOf(a) - +!groupOf(b) || groupOf(a).localeCompare(groupOf(b)) || area(b) - area(a) || a.repo.localeCompare(b.repo),
  );
  const members = new Map<string, StarShape[]>();
  for (const star of order) if (groupOf(star)) members.set(groupOf(star), [...(members.get(groupOf(star)) ?? []), star]);
  // A constellation's stars stand on a lattice of half the step, so that they and their labels pack close together.
  const fine = members.size ? latticeNodes(region, blocked, spacing / 2) : [];
  const homeOf = (star: StarShape): Point => ({
    x: region.x0 + unit(star.repo) * (region.x1 - region.x0),
    y: region.y0 + unit(`${star.repo}#y`) * (region.y1 - region.y0),
  });
  /** The node stands at least STRANGER_STEPS from every placed star of another constellation, or none when `star` has one. */
  const apart = (star: StarShape, at: Point) => {
    if (!members.size) return true;
    const group = groupOf(star);
    for (const [repo, place] of places) {
      const other = groups.get(repo) ?? "";
      if (other === group || Math.hypot(place.x - at.x, place.y - at.y) >= spacing * STRANGER_STEPS) continue;
      return false;
    }
    return true;
  };
  // A star keeps its place while it still fits there.
  for (const star of order) {
    const before = previous?.get(star.repo);
    if (before && fits(star, before)) put(star, before, true);
  }
  /**
   * A constellation's star with its label stands this far from what stands inside the galaxy, the science station, so
   * that the cloud does not take it in; the panels and the columns along the edges need no more than the label's room.
   */
  const margin = spacing * 0.6;
  const inner = blocked.filter((rect) => rect.x0 > region.x0 && rect.y0 > region.y0 && rect.x1 < region.x1 && rect.y1 < region.y1);
  const clear = (star: StarShape, at: Point) => {
    const room = starFootprint(star, at, lattice);
    const wide = { x0: room.x0 - margin, y0: room.y0 - margin, x1: room.x1 + margin, y1: room.y1 + margin };
    return !inner.some((rect) => overlaps(wide, rect));
  };
  /**
   * Puts `list` around `centre`, each star on the free spot of the fine lattice nearest it, and tells how far they spread:
   * the sum of their squared distances from their own middle, more for every star close to the science station, and a
   * great deal for every star left without a spot.
   */
  const gather = (list: readonly StarShape[], centre: Point): number => {
    const spots = fine
      .map((node) => ({ node, distance: Math.hypot(node.x - centre.x, node.y - centre.y) }))
      .filter((item) => item.distance <= spacing * GATHER_STEPS)
      .sort((a, b) => a.distance - b.distance);
    const placed: Point[] = [];
    let left = 0;
    let close = 0;
    for (const star of list) {
      const spot = spots.find((item) => fits(star, item.node) && apart(star, item.node));
      if (!spot) {
        left++;
        continue;
      }
      if (!clear(star, spot.node)) close++;
      put(star, spot.node, true);
      placed.push(spot.node);
    }
    if (!placed.length) return left * 1e12;
    const middle = { x: placed.reduce((sum, at) => sum + at.x, 0) / placed.length, y: placed.reduce((sum, at) => sum + at.y, 0) / placed.length };
    return placed.reduce((sum, at) => sum + (at.x - middle.x) ** 2 + (at.y - middle.y) ** 2, 0) + close * spacing ** 2 * 2 + left * 1e12;
  };
  // The constellations first, the largest first: each tries the most open middles and keeps the one where its stars
  // stand closest together.
  const taken = new Map<Point, number>();
  for (const [name, list] of [...members].sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b))) {
    const waiting = list.filter((star) => !places.has(star.repo));
    if (!waiting.length) continue;
    let best: { centre: Point; spread: number } | null = null;
    for (const centre of centreChoices(name, list.length, nodes, spacing, taken)) {
      const mark = { rooms: rooms.length, cores: cores.length };
      const spread = gather(waiting, centre);
      for (const star of waiting) places.delete(star.repo);
      rooms.length = mark.rooms;
      cores.length = mark.cores;
      if (!best || spread < best.spread) best = { centre, spread };
    }
    if (!best) continue;
    gather(waiting, best.centre);
    taken.set(best.centre, list.length);
  }
  let crowded = 0;
  for (const star of order) {
    if (places.has(star.repo)) continue;
    const home = homeOf(star);
    const nearest = nodes
      .map((node) => ({ node, distance: Math.hypot((node.x - home.x) / 1.4, node.y - home.y) }))
      .sort((a, b) => a.distance - b.distance);
    const near = nearest.filter((item) => item.distance <= spacing * 3.5).map((item) => item.node);
    // Apart from strangers near home, else apart anywhere, nearest first, else wherever it fits near home.
    const node =
      near.find((candidate) => fits(star, candidate) && apart(star, candidate)) ??
      (members.size ? nearest.find((item) => fits(star, item.node) && apart(star, item.node))?.node : undefined) ??
      near.find((candidate) => fits(star, candidate));
    if (node) {
      const off = { x: node.x + (unit(`${star.repo}#jx`) - 0.5) * NODE_JITTER * spacing, y: node.y + (unit(`${star.repo}#jy`) - 0.5) * NODE_JITTER * spacing * 0.8 };
      put(star, fits(star, off) ? off : node, true);
      continue;
    }
    const keepOuts = rooms.slice(0, blocked.length);
    const room = nearest.find((item) => free(starCore(star, item.node, lattice), cores) && free(starCore(star, item.node, lattice), keepOuts));
    // A busy star without its label's room waits for the zoom; any star without room for itself makes the lattice
    // narrow too. In a galaxy fuller than its room it may touch another star, but never a panel or the station.
    if (star.live || !room) crowded++;
    const squeezed = room ?? nearest.find((item) => free(starCore(star, item.node, lattice), keepOuts));
    put(star, squeezed?.node ?? nearest[0]?.node ?? home, false);
  }
  return { places, crowded };
}

/**
 * The stars of the repositories on a lattice that follows their count: every star gets an equal share of the free part
 * of the galaxy with some to spare, so a few stars stand wide apart and many fill it densely, without clumps or empty
 * patches. The rows of the lattice are shifted by half a step, so a label below a star falls between the stars of the
 * next row. A busy star claims the room of its label as well. Each star takes the free node nearest its home, a point
 * from its name, the largest first; the stars of a constellation (`groups`) come first and gather around its middle, and
 * the others keep a little apart from them. A star keeps its place from `previous` while it fits there and the lattice
 * and the constellations hold. When
 * busy labels find no room, the step narrows, to about three quarters; what still does not fit waits for the zoom. A
 * crowded galaxy also draws its stars smaller. The labels' room is reserved at `labelZoom`, the zoom of the full view.
 */
export function galaxyLayout(
  stars: readonly StarShape[],
  size: Size,
  blocked: readonly Rect[],
  previous: Galaxy | null = null,
  labelZoom = LABEL_ZOOM,
  groups: Groups = new Map(),
): Galaxy {
  const key = constellationKey(groups);
  const region = galaxyRegion(size);
  const ideal = Math.sqrt(freeArea(region, blocked) / (Math.max(1, stars.length) * SPARE));
  const rungOf = (spacing: number) => Math.round(Math.log(spacing) / Math.log(SPACING_LADDER));
  const top = rungOf(ideal);
  const attempt = (rung: number, previousPlaces: ReadonlyMap<string, Point> | null): Galaxy => {
    const spacing = SPACING_LADDER ** rung;
    const scale = Math.min(1, Math.max(0.6, spacing / 120));
    const placed = placeStars(stars, region, blocked, { spacing, scale, labelZoom }, previousPlaces, groups);
    return { places: placed.places, spacing, scale, labelZoom, world: size, crowded: placed.crowded, groups: key };
  };
  // The lattice of the previous layout, with the stars in their places, while it is near the ideal one and crowds no
  // more labels out than a fresh layout would: then a star moves only when it must.
  const kept = previous && previous.world.width === size.width && previous.world.height === size.height && previous.groups === key ? previous : null;
  const keptRung = kept ? rungOf(kept.spacing) : null;
  const sticky = keptRung !== null && keptRung <= top + 1 && keptRung >= top - 4 ? attempt(keptRung, kept!.places) : null;
  if (sticky && !sticky.crowded) return sticky;
  let best: Galaxy | null = null;
  for (let rung = top; rung >= top - 4; rung--) {
    const fresh = attempt(rung, null);
    if (!best || fresh.crowded < best.crowded) best = fresh;
    if (!fresh.crowded) break;
  }
  const result = sticky && sticky.crowded <= best!.crowded ? sticky : best;
  return result!;
}
