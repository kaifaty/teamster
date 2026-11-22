import { CanvasTextMetrics, Container, Graphics, Rectangle, Sprite, Text, type TextStyleOptions, type Texture } from "pixi.js";
import { statusLabels } from "../../lib/projectTasks";
import type { Camera, Rect, Size } from "../layout";
import { BUILDING_HEIGHT, BUILDING_WIDTH, buildingRect, type Region, type Site } from "./layout";

function label(value: string, style: TextStyleOptions) {
  const text = new Text({ text: value, style: { fontFamily: "system-ui", align: "center", fill: 0xfff9e6, ...style } });
  text.anchor.set(0.5, 0);
  return text;
}

// Break long slugs as well as words. Only change the GPU text when the visible lines change.
function fitText(text: Text, value: string, width: number, limit: number) {
  if (CanvasTextMetrics.measureText(value, text.style).width <= width && !value.includes("\n")) {
    text.text = value;
    return;
  }
  const wrap = text.style.clone();
  wrap.wordWrap = wrap.breakWords = true;
  wrap.wordWrapWidth = width;
  const lines = CanvasTextMetrics.measureText(value, wrap).lines;
  if (lines.length <= limit) {
    text.text = lines.join("\n");
    return;
  }
  let last = lines[limit - 1]!.trimEnd();
  while (last && CanvasTextMetrics.measureText(last + "…", text.style).width > width) last = last.slice(0, -1);
  text.text = [...lines.slice(0, limit - 1), last + "…"].join("\n");
}

export function countryLabels(regions: Region[]) {
  const counts = new Map<string, number>();
  const names = regions.sort((a, b) => b.sites.length - a.sites.length).map(region => {
    const stems = [...region.project.matchAll(/[-._/ ](?=.)/g)].map(match => region.project.slice(0, match.index));
    for (const stem of [...stems, region.project]) counts.set(stem, (counts.get(stem) ?? 0) + 1);
    return { region, stems };
  });
  return names.map(({ region, stems }) => {
    const common = stems.filter(stem => counts.get(stem)! > 1).pop();
    return countryLabel(region, common === undefined ? undefined : common.length + 1);
  });
}

function countryLabel(region: Region, suffixStart?: number) {
  const view = new Container({ eventMode: "none" });
  view.position.copyFrom(region.label);
  const name = view.addChild(label(region.project, {
    fontFamily: ["Iowan Old Style", "Georgia", "serif"], fontSize: 27, fontWeight: "600", lineHeight: 29,
    fill: 0xfff8df, stroke: { color: 0x314434, width: 2.5, join: "round" },
  }));
  const biome = view.addChild(label(region.biome === "forest" ? "ХВОЙНОЕ ПОГРАНИЧЬЕ" : "ВУЛКАНИЧЕСКОЕ ПЛАТО", {
    fontSize: 10, fontWeight: "bold", letterSpacing: 1, stroke: { color: 0x314434, width: 2 },
  }));
  // Prefer a project-name separator to breaking a slug in the middle of a word.
  const title = region.project;
  const split = suffixStart ?? [...title.matchAll(/[-._/\s]+/g)].map(match => match.index + match[0].length)
    .sort((a, b) => Math.abs(a - title.length / 2) - Math.abs(b - title.length / 2))[0];
  const twoLines = split ? title.slice(0, split).trimEnd() + "\n" + title.slice(split) : title;
  const fullWidth = CanvasTextMetrics.measureText(title, name.style).width;
  const splitWidth = CanvasTextMetrics.measureText(twoLines, name.style).width;
  function resize(zoom: number, compact: boolean) {
    const pixels = compact ? Math.max(10, Math.min(21, 52 * zoom)) : 27;
    view.scale.set(1 / zoom);
    name.scale.set(pixels / 27);
    const width = Math.max(40, Math.min(340, region.labelWidth * zoom));
    const wrap = compact && fullWidth * name.scale.x > width;
    if (wrap) name.scale.set(Math.max(10 / 27, Math.min(name.scale.x, width / splitWidth)));
    const available = Math.ceil(width / name.scale.x);
    // Keep the distinguishing suffix when the shared prefix would use up both lines.
    const compactTitle = suffixStart !== undefined && splitWidth > available ? title.slice(suffixStart) : twoLines;
    fitText(name, wrap ? compactTitle : title, available, compact ? 2 : 1);
    biome.visible = !compact;
    name.y = -(name.height + (compact ? 0 : biome.height)) / 2;
    biome.y = name.y + name.height;
  }
  return { view, resize };
}

const phases = {
  active: { sign: 0x245646, tint: 0xd1e9ca, plate: 0x27382f, mark: "•" },
  needs_input: { sign: 0x7b491d, tint: 0xffe0a1, plate: 0x563b25, mark: "?" },
  blocked: { sign: 0x863d37, tint: 0xffd0b9, plate: 0x513530, mark: "−" },
  ready: { sign: 0x304f63, tint: 0xceeafa, plate: 0x2c4049, mark: "✓" },
};

function statusMarker(status: Site["task"]["status"]) {
  const { sign, tint, mark } = phases[status];
  const marker = new Container();
  const shape = marker.addChild(new Graphics());
  switch (status) {
    case "active": shape.circle(0, 0, 8.5); break;
    case "needs_input": shape.poly([0, -11, 11, 0, 0, 11, -11, 0]); break;
    case "blocked": shape.regularPoly(0, 0, 9, 8, Math.PI / 8); break;
    case "ready": shape.roundRect(-8.5, -8.5, 17, 17, 3); break;
  }
  shape.fill(sign).stroke({ color: tint, width: 1.5 });
  marker.addChild(label(mark, { fontSize: 13, fontWeight: "bold" })).anchor.set(0.5);
  return marker;
}

function nameplate(site: Site, parentTitle: string | undefined) {
  const { task } = site, phase = phases[task.status];
  const view = new Container();
  const background = view.addChild(new Graphics());
  const name = view.addChild(label(task.title, { fontSize: 12, fontWeight: "600", lineHeight: 15 }));
  const rows = [name, view.addChild(label(statusLabels[task.status], { fontSize: 11, fill: phase.tint }))];
  const meta = (value: string) => rows.push(view.addChild(label(value, { fontSize: 10.5, fill: 0xefe9cf })));
  const parent = parentTitle && `Родитель · ${parentTitle}`;
  if (parent) meta(parent);
  const counts = [];
  if (site.children) counts.push(`Подзадачи ${site.accepted}/${site.children}`);
  if (site.dependents.length) counts.push(`Блокирует ${site.dependents.length}`);
  if (counts.length) meta(counts.join(" · "));
  const hosts = { github: new Set<string>(), forgejo: new Set<string>() };
  for (const pr of task.pull_requests) hosts[pr.provider].add(pr.url);
  const providers = [];
  if (hosts.github.size) providers.push(`GitHub ${hosts.github.size}`);
  if (hosts.forgejo.size) providers.push(`Forgejo ${hosts.forgejo.size}`);
  if (providers.length) meta(`PR · ${providers.join(" · ")}`);

  const area = new Rectangle();
  let previousWidth = 0, previousSelected = false;
  function resize(maxWidth: number, selected: boolean) {
    if (maxWidth === previousWidth && selected === previousSelected) return;
    previousWidth = maxWidth;
    previousSelected = selected;
    fitText(name, task.title, maxWidth - 16, selected ? 3 : 2);
    if (parent) fitText(rows[2]!, parent, maxWidth - 16, 1);
    let width = 0, y = 4;
    for (const row of rows) {
      row.y = y;
      y += row.height + 1;
      width = Math.max(width, row.width);
    }
    width = Math.ceil(width) + 16;
    area.x = -width / 2;
    area.width = width;
    area.height = Math.ceil(y) + 3;
    background.clear().roundRect(area.x, 0, width, area.height, 4)
      .fill({ color: phase.plate, alpha: 0.96 }).stroke({ color: selected ? 0xfffae0 : phase.tint, width: selected ? 2.5 : 1 });
  }
  return { view, area, resize };
}

export function siteView(site: Site, texture: Texture, parentTitle: string | undefined) {
  const view = new Container({ label: site.task.id });
  view.position.copyFrom(site);
  const sprite = view.addChild(new Sprite(texture));
  sprite.anchor.set(0.5, 1);
  sprite.scale.set(Math.min(BUILDING_WIDTH / texture.width, BUILDING_HEIGHT / texture.height));
  const marker = view.addChild(statusMarker(site.task.status));
  let plate: ReturnType<typeof nameplate> | undefined;

  function preparePlate(zoom: number, selected: boolean) {
    if (!plate) {
      plate = nameplate(site, parentTitle);
      view.addChild(plate.view);
      plate.view.visible = false;
    }
    plate.resize(Math.round(Math.max(102, Math.min(218, 182 * zoom))), selected);
    plate.view.scale.set(1 / zoom);
    return plate;
  }

  function resize(zoom: number, compact: boolean, selected: boolean) {
    const diameter = compact ? Math.max(5, Math.min(17, 22 * zoom)) : 17;
    const units = diameter / zoom;
    marker.scale.set(units / 17);
    marker.position.set(BUILDING_WIDTH / 2 - units / 2, -BUILDING_HEIGHT + units / 2);
    if (!compact || plate) preparePlate(zoom, selected);
  }

  function update(camera: Camera, size: Size, detailZoom: number, compact: boolean, selected: boolean, hovered: boolean) {
    const { zoom } = camera;
    const x = camera.tx + site.x * zoom, y = camera.ty + site.y * zoom;
    view.zIndex = selected ? 2 : hovered ? 1 : 0;
    const show = (!compact || selected || hovered) && x >= 0 && x <= size.width && y >= 0 && y <= size.height;
    if (!show) {
      if (plate) plate.view.visible = false;
      return;
    }
    const shown = preparePlate(detailZoom, selected);
    shown.view.visible = true;
    const screenScale = zoom / detailZoom;
    const edge = shown.area.width * screenScale / 2 + 3;
    const above = (selected || hovered) && y + shown.area.height * screenScale > size.height;
    shown.view.position.set((Math.max(edge, Math.min(size.width - edge, x)) - x) / zoom,
      above ? -BUILDING_HEIGHT - shown.area.height / detailZoom : 0);
  }
  function hitTarget(camera: Camera) {
    const building = buildingRect(site, camera);
    let plateBounds: Rect | undefined;
    if (plate?.view.visible) {
      const { zoom } = camera;
      const scale = plate.view.scale.x * zoom;
      const x0 = camera.tx + (site.x + plate.view.x) * zoom + plate.area.x * scale;
      const y0 = camera.ty + (site.y + plate.view.y) * zoom;
      plateBounds = { x0, y0, x1: x0 + plate.area.width * scale, y1: y0 + plate.area.height * scale };
    }
    return { id: site.task.id, building, plate: plateBounds, priority: view.zIndex };
  }

  return { view, resize, update, hitTarget };
}
