import { Container, Graphics, GraphicsPath, Matrix, type Texture } from "pixi.js";
import type { Biome, Site, SurfaceLayout } from "./layout";

export function createLand(layout: SurfaceLayout, textures: Record<Biome, Texture>) {
  const view = new Container({ eventMode: "none" });
  const shore = view.addChild(new Graphics());
  const land = view.addChild(new Graphics());
  const borders = view.addChild(new Graphics());
  const roads = view.addChild(new Graphics());
  const coast = new GraphicsPath(layout.coastline);
  const outlines: GraphicsPath[] = [];

  for (const region of layout.regions.values()) {
    const path = new GraphicsPath(region.outline, true);
    outlines.push(path);
    const texture = textures[region.biome];
    const { x0, x1, y0, y1 } = region.bounds;
    const width = Math.min(texture.width, x1 - x0), height = Math.min(texture.height, y1 - y0);
    // The atlas centres and crops a tile to each country and repeats it over larger countries.
    const scale = Math.max(width / texture.width, height / texture.height);
    const matrix = new Matrix(scale, 0, 0, scale,
      x0 + (width - texture.width * scale) / 2, y0 + (height - texture.height * scale) / 2);
    land.path(path).fill({ texture, matrix, textureSpace: "global" });
  }

  for (const child of layout.sites.values()) {
    const parent = child.task.parent_id === null ? undefined : layout.sites.get(child.task.parent_id);
    if (!parent) continue;
    const startY = parent.y - 9, endY = child.y - 9, bendY = child.y + 10;
    const dx = child.x - parent.x;
    roads.moveTo(parent.x, startY).quadraticCurveTo(parent.x + dx / 2, bendY, child.x, endY)
      .stroke({ color: 0x665742, width: 5, cap: "round" });
    // The dotted centre follows the same quadratic as the road.
    const steps = Math.ceil((Math.hypot(dx / 2, bendY - startY) + Math.hypot(dx / 2, endY - bendY)) / 9);
    for (let i = 0; i < steps; i++) {
      const t = i / steps, u = 1 - t;
      roads.circle(parent.x + dx * t, u * u * startY + 2 * t * u * bendY + t * t * endY, 1.6);
    }
    roads.fill(0xeeddb6);
  }

  function scaleBorders(zoom: number) {
    if (!outlines.length) return;
    shore.clear().path(coast).fill(0xe8dfb4).stroke({ color: 0xa7c9b9, width: 10 / zoom, join: "round" });
    shore.path(coast).stroke({ color: 0xe2dfb7, width: 5 / zoom, join: "round" });
    borders.clear();
    for (const [width, color] of [[2.8, 0x454b3e], [0.9, 0xece0ae]] as const) {
      for (const path of outlines) borders.path(path);
      borders.stroke({ width: width / zoom, color, join: "round" });
    }
  }
  return { view, scaleBorders };
}

export function drawSelection(g: Graphics, links: readonly [Site, Site][], selected: Site | undefined, layout: SurfaceLayout) {
  g.clear();
  if (!selected) return;
  for (const site of layout.sites.values()) {
    if (site.task.id === selected.task.parent_id || site.task.parent_id === selected.task.id) {
      g.ellipse(site.x, site.y - 26, 39, 27).fill({ color: 0x304238, alpha: 0.65 }).stroke({ color: 0xfff0bf, width: 2 });
    }
  }
  for (const [from, to] of links) {
    // Land beside the roof, clear of the nameplate. A vertical link goes around both sites.
    const across = Math.abs(to.x - from.x) > 90;
    const exit = across && from.x > to.x ? -1 : 1;
    const entry = across ? -exit : 1;
    const bend = across ? Math.min(110, Math.abs(to.x - from.x) / 3) : 115;
    const x1 = from.x + exit * 34, y1 = from.y - 25;
    const x2 = to.x + entry * 41, y2 = to.y - 25;
    const curve = new GraphicsPath().moveTo(x1, y1)
      .bezierCurveTo(x1 + exit * bend, y1 - 40, x2 + entry * bend, y2 - 40, x2, y2);
    g.path(curve).stroke({ color: 0x423a33, width: 5.5 });
    g.path(curve).stroke({ color: 0xffdf89, width: 2.8 });
    const length = Math.hypot(bend, 40), dx = -entry * bend / length, dy = 40 / length;
    g.poly([x2 + dx, y2 + dy, x2 - 12 * dx - 6 * dy, y2 - 12 * dy + 6 * dx,
      x2 - 9 * dx, y2 - 9 * dy, x2 - 12 * dx + 6 * dy, y2 - 12 * dy - 6 * dx])
      .fill(0xffdf89).stroke({ color: 0x433b34, width: 1.25, join: "round" });
  }
}
