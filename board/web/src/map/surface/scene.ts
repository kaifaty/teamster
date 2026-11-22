import { Assets, Container, FillGradient, Graphics, WebGLRenderer, WebGPURenderer, type Texture } from "pixi.js";
import type { Camera, Point, Rect, Size } from "../layout";
import cabin from "./art/cabin.svg?no-inline";
import forest from "./art/forest.webp";
import foundry from "./art/foundry.svg?no-inline";
import volcanic from "./art/volcanic.webp";
import { countryLabels, siteView } from "./labels";
import { createLand, drawSelection } from "./land";
import { overlaps, pickSurfaceSite, type Site, type SurfaceLayout } from "./layout";

export async function createSurfaceScene(backend: "webgpu" | "webgl", redraw: () => void) {
  const canvas = document.createElement("canvas");
  const options = {
    canvas, width: 1, height: 1, resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true, antialias: true, gcActive: false,
  };
  // Probe the actual presentation canvas. Keep a fresh canvas for each renderer.
  const adapter = backend === "webgpu" && canvas.getContext("webgpu") && await navigator.gpu?.requestAdapter();
  if (backend === "webgpu" && !adapter) throw new Error("WebGPU adapter or canvas context unavailable");
  const context = backend === "webgl" && (canvas.getContext("webgl2", { antialias: true, stencil: true }) ??
    canvas.getContext("webgl", { antialias: true, stencil: true }));
  if (backend === "webgl" && !context) throw new Error("WebGL canvas context unavailable");

  // Load the reusable art before allocating a device. Scene nodes and GPU allocations belong to each attempt.
  const [woods, basalt, cabinArt, foundryArt] = await Promise.all([
    Assets.load<Texture>({ src: forest, data: { autoGenerateMipmaps: true, addressMode: "repeat" } }),
    Assets.load<Texture>({ src: volcanic, data: { autoGenerateMipmaps: true, addressMode: "repeat" } }),
    Assets.load<Texture>({ src: cabin, data: { width: 76, height: 52, resolution: 3, autoGenerateMipmaps: true } }),
    Assets.load<Texture>({ src: foundry, data: { width: 76, height: 56, resolution: 3, autoGenerateMipmaps: true } }),
  ]);
  const device = adapter ? await adapter.requestDevice() : undefined;
  const renderer = adapter ? new WebGPURenderer() : new WebGLRenderer();
  function releaseRenderer() {
    try {
      renderer.destroy({ removeView: true });
    } finally {
      device?.destroy();
    }
  }
  try {
    if (renderer instanceof WebGPURenderer && adapter && device) {
      await renderer.init({ ...options, gpu: { adapter, device } });
    } else if (renderer instanceof WebGLRenderer && context) {
      // Pixi accepts a WebGL 1 context here too. Its option type only declares WebGL 2.
      await renderer.init({ ...options, context: context as WebGL2RenderingContext });
    }
  } catch (error) {
    releaseRenderer();
    throw error;
  }
  canvas.dataset.renderer = renderer.name;
  canvas.setAttribute("aria-hidden", "true");
  // Pointer listeners belong to the shared camera.
  renderer.events.setTargetElement(null!);
  // In 8.22 GC is the only scheduler client. Free scene objects explicitly and let the idle renderer sleep.
  renderer.scheduler.destroy();
  renderer.runners.contextChange.add({ contextChange: redraw });
  const stage = new Container();
  const sea = new FillGradient({
    type: "radial", center: { x: 0.5, y: 0.5 }, outerRadius: Math.SQRT1_2, textureSize: 128,
    colorStops: [{ offset: 0, color: 0x9dbeb0 }, { offset: 1, color: 0x719d9a }],
  });
  const ocean = stage.addChild(new Graphics({ eventMode: "none" }).rect(0, 0, 1, 1).fill(sea));
  const world = stage.addChild(new Container({ isRenderGroup: true }));
  const coarse = matchMedia("(pointer: coarse)").matches;

  let atlas: SurfaceLayout | undefined;
  let land: ReturnType<typeof createLand>;
  let selection: Graphics;
  let names: ReturnType<typeof countryLabels> = [];
  let sites: ReturnType<typeof siteView>[] = [];
  let lastDetailZoom = 0, lastCompact: boolean | undefined;
  let lastCamera: Camera;
  let lastSize: Size | undefined;
  let lastSelected: string | null = null;

  function build(layout: SurfaceLayout) {
    for (const child of world.removeChildren()) child.destroy({ children: true, context: true });
    land = createLand(layout, { forest: woods, volcanic: basalt });
    world.addChild(land.view);
    selection = world.addChild(new Graphics({ eventMode: "none" }));
    const namesLayer = world.addChild(new Container({ eventMode: "none" }));
    const sitesLayer = world.addChild(new Container());
    sitesLayer.sortableChildren = true;
    names = countryLabels([...layout.regions.values()]);
    for (const name of names) namesLayer.addChild(name.view);
    sites = [];
    for (const region of layout.regions.values()) {
      for (const site of region.sites) {
        const parent = site.task.parent_id === null ? undefined : layout.sites.get(site.task.parent_id);
        const item = siteView(site, region.biome === "forest" ? cabinArt : foundryArt, parent?.task.title);
        sitesLayer.addChild(item.view);
        sites.push(item);
      }
    }
  }

  function draw(layout: SurfaceLayout, camera: Camera, size: Size, detailZoom: number, compact: boolean,
                selected: string | null, hovered: string | null, links: readonly [Site, Site][]) {
    if (!size.width || !size.height) return;
    if (size !== lastSize) {
      renderer.resize(size.width, size.height);
      ocean.scale.set(size.width, size.height);
      lastSize = size;
    }
    const changed = layout !== atlas;
    if (changed) build(layout);
    world.position.set(camera.tx, camera.ty);
    world.scale.set(camera.zoom);
    if (changed || detailZoom !== lastDetailZoom || compact !== lastCompact) {
      land.scaleBorders(detailZoom);
      const taken: Rect[] = [];
      for (const name of names) {
        name.view.visible = true;
        name.resize(detailZoom, compact);
        if (compact) {
          const bounds = name.view.getLocalBounds(), scale = name.view.scale.x;
          const x0 = name.view.x + bounds.x * scale, y0 = name.view.y + bounds.y * scale;
          const box = { x0, y0, x1: x0 + bounds.width * scale, y1: y0 + bounds.height * scale };
          name.view.visible = !taken.some(other => overlaps(other, box));
          if (name.view.visible) taken.push(box);
        }
      }
      for (const item of sites) item.resize(detailZoom, compact, item.view.label === selected);
      lastDetailZoom = detailZoom;
      lastCompact = compact;
    }
    if (changed || selected !== lastSelected) {
      drawSelection(selection, links, selected === null ? undefined : layout.sites.get(selected), layout);
    }
    for (const item of sites) item.update(camera, size, detailZoom, compact, item.view.label === selected, item.view.label === hovered);
    lastCamera = camera;
    atlas = layout;
    lastSelected = selected;
    renderer.render(stage);
  }

  return {
    canvas, draw,
    hit(at: Point, covered?: Rect) {
      if (!lastSize) return null;
      return pickSurfaceSite(at, lastSize, sites.map(site => site.hitTarget(lastCamera)), coarse, covered);
    },
    async present(draw: () => void) {
      if (!device) {
        draw();
        if (context && context.isContextLost()) throw new Error("WebGL context lost during the first render");
        return;
      }
      device.pushErrorScope("validation");
      device.pushErrorScope("out-of-memory");
      device.pushErrorScope("internal");
      try {
        draw();
      } finally {
        const errors = await Promise.all([device.popErrorScope(), device.popErrorScope(), device.popErrorScope()]);
        const error = errors.find(Boolean);
        if (error) throw new Error(error.message);
      }
    },
    destroy() {
      stage.destroy({ children: true, context: true });
      sea.destroy();
      releaseRenderer();
    },
  };
}

export type SurfaceScene = Awaited<ReturnType<typeof createSurfaceScene>>;
