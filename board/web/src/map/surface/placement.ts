import { hashName, type Point } from "../layout/geometry";

// Integer lattice coordinates keep a corner identical on both sides of a border.
const DX = 124, DY = 60, SHORE = 48;
const CORNERS = [{ x: 0, y: -2 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: 0, y: 2 }, { x: -1, y: 1 }, { x: -1, y: -1 }];
const key = (p: Point) => `${p.x},${p.y}`;
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const NEIGHBOURS = CORNERS.map((p, i) => add(p, CORNERS[(i + 1) % CORNERS.length]!));
const origin = { x: 0, y: 0 };

function growCountries(counts: number[]) {
  const coast = new Map([[key(origin), origin]]);
  const rows = new Map<number, { left: number; right: number }>();

  function nearest(frontier: Map<string, Point>, seed: Point) {
    let best: Point | undefined;
    let distance = Infinity;
    for (const cell of frontier.values()) {
      // Grow from either end of a row. Land stays connected and cannot enclose an empty pocket.
      const row = rows.get(cell.y);
      if (row && cell.x !== row.left - 2 && cell.x !== row.right + 2) continue;
      // Squared distance on the regular hex lattice, before stretching it to fit the buildings.
      const d = 3 * (cell.x - seed.x) ** 2 + (cell.y - seed.y) ** 2;
      if (d < distance) {
        best = cell;
        distance = d;
      }
    }
    return best!;
  }

  const countries = counts.map(count => {
    const seed = nearest(coast, origin);
    const frontier = new Map([[key(seed), seed]]);
    const cells: Point[] = [];
    // One clearing for the country name, one for each current task.
    while (cells.length < count + 1) {
      const cell = nearest(frontier, seed);
      cells.push(cell);
      const row = rows.get(cell.y);
      rows.set(cell.y, { left: Math.min(row?.left ?? cell.x, cell.x), right: Math.max(row?.right ?? cell.x, cell.x) });
      for (const step of NEIGHBOURS) {
        const next = add(cell, step);
        const span = rows.get(next.y);
        if (span && next.x >= span.left && next.x <= span.right) continue;
        coast.set(key(next), next);
        frontier.set(key(next), next);
      }
      coast.delete(key(cell));
      frontier.delete(key(cell));
    }
    return cells;
  });
  return { countries, rows };
}

function contours(cells: Point[]) {
  const members = new Set(cells.map(key));
  const edges = new Map<string, Point>();
  for (const cell of cells) {
    NEIGHBOURS.forEach((step, i) => {
      if (members.has(key(add(cell, step)))) return;
      const from = add(cell, CORNERS[i]!);
      edges.set(key(from), add(cell, CORNERS[(i + 1) % CORNERS.length]!));
    });
  }
  const rings: Point[][] = [];
  while (edges.size) {
    const start = edges.values().next().value!;
    const ring: Point[] = [];
    let p = start;
    do {
      ring.push(p);
      const next = edges.get(key(p))!;
      edges.delete(key(p));
      p = next;
    } while (key(p) !== key(start));
    rings.push(ring);
  }
  return rings;
}

export function placeTerritories(counts: number[]) {
  const { countries, rows } = growCountries(counts);
  const cells = countries.flat();
  if (!cells.length) return { world: { width: 0, height: 0 }, landRows: [], coastline: "", territories: [] };
  const xs = cells.map(p => p.x), ys = cells.map(p => p.y);
  const left = Math.min(...xs) - 1, top = Math.min(...ys) - 2;
  const world = { width: (Math.max(...xs) + 1 - left) * DX + 2 * SHORE, height: (Math.max(...ys) + 2 - top) * DY + 2 * SHORE };
  // Each occupied row is solid land. These strips meet even where two hexes touch diagonally.
  const landRows = [...rows].map(([y, span]) => ({
    x0: (span.left - left - 0.5) * DX + SHORE, x1: (span.right - left + 0.5) * DX + SHORE,
    y0: (y - top - 1.5) * DY + SHORE, y1: (y - top + 1.5) * DY + SHORE,
  }));
  function shifted(p: Point, spread: number) {
    const noise = hashName(key(p)), range = 2 * spread + 1;
    return {
      x: (p.x - left) * DX + SHORE + noise % range - spread,
      y: (p.y - top) * DY + SHORE + (noise >>> 12) % range - spread,
    };
  }
  const vertex = (p: Point) => shifted(p, 30);

  const borders = countries.map(contours), coast = contours(cells);
  const touching = new Map<string, number>();
  for (const ring of [...borders.flat(), ...coast]) {
    for (const p of ring) touching.set(key(p), (touching.get(key(p)) ?? 0) + 1);
  }
  function outline(rings: Point[][]) {
    return rings.map(ring => {
      const corners = ring.map(vertex);
      const midpoints = corners.map((p, i) => {
        const next = corners[(i + 1) % corners.length]!;
        return `${(p.x + next.x) / 2} ${(p.y + next.y) / 2}`;
      });
      let path = "M" + midpoints[midpoints.length - 1];
      corners.forEach((p, i) => {
        // Both countries round a bend through the same corner. Three-way junctions stay fixed.
        path += touching.get(key(ring[i]!)) === 3
          ? `L${p.x} ${p.y}L${midpoints[i]}` : `Q${p.x} ${p.y} ${midpoints[i]}`;
      });
      return path + "Z";
    }).join("");
  }

  const territories = countries.map((country, i) => {
    const clearings = country.map(p => shifted(p, 14));
    const boundary = borders[i]!.flat().map(vertex);
    const x = boundary.map(p => p.x), y = boundary.map(p => p.y);
    const x0 = Math.min(...x), x1 = Math.max(...x), y0 = Math.min(...y), y1 = Math.max(...y);
    const middle = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    const distance = (p: Point) => Math.hypot(p.x - middle.x, p.y - middle.y);
    const index = clearings.reduce((best, p, j) => distance(p) < distance(clearings[best]!) ? j : best, 0);
    const anchor = clearings.splice(index, 1)[0]!;
    const cell = country[index]!;
    // Borrow space for the name on each side that faces another clearing of this country.
    const room = (side: number) => country.some(p => p.y === cell.y && p.x === cell.x + side * 2) ? DX * 1.6 : DX * 0.9;
    const leftRoom = room(-1), rightRoom = room(1);
    const label = { x: anchor.x + (rightRoom - leftRoom) / 2, y: anchor.y };
    return { outline: outline(borders[i]!), label, labelWidth: leftRoom + rightRoom, clearings, bounds: { x0, y0, x1, y1 } };
  });
  return { world, landRows, coastline: outline(coast), territories };
}
