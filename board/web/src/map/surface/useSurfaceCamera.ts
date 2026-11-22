import { computed, onBeforeUnmount, onMounted, shallowRef, watch, type Ref } from "vue";
import { clampCamera, fitCamera, zoomCamera, type Camera } from "../layout/camera";
import { freeView, NO_INSETS, type Point, type Size } from "../layout/geometry";
import { createInput, listen } from "../scene/input";
import type { SurfaceLayout } from "./layout";

const NAMEPLATE_ZOOM = 0.78;
const CLOSE_ZOOM = 1.5;

export function containSurfaceCamera(next: Camera, layout: SurfaceLayout, view: Size): Camera {
  const camera = clampCamera(next, layout.world, view);
  // At a corner of the world's bounding box the entire screen could still be offshore.
  // Keep land in view, including the ground between buildings.
  const insetX = Math.min(80 * camera.zoom, view.width / 4);
  const insetY = Math.min(80 * camera.zoom, view.height / 4);
  if (layout.landRows.some(row =>
    camera.tx + row.x1 * camera.zoom >= insetX && camera.tx + row.x0 * camera.zoom <= view.width - insetX &&
    camera.ty + row.y1 * camera.zoom >= insetY && camera.ty + row.y0 * camera.zoom <= view.height - insetY)) return camera;

  // Offshore, bring the nearest building back into view.
  let distance = Infinity;
  let dx = 0, dy = 0;
  for (const site of layout.sites.values()) {
    const x = camera.tx + site.x * camera.zoom, y = camera.ty + site.y * camera.zoom;
    const shiftX = Math.max(insetX - x, Math.min(0, view.width - insetX - x));
    const shiftY = Math.max(insetY - y, Math.min(0, view.height - insetY - y));
    const d = shiftX * shiftX + shiftY * shiftY;
    if (d < distance) { distance = d; dx = shiftX; dy = shiftY; }
  }
  return clampCamera({ ...camera, tx: camera.tx + dx, ty: camera.ty + dy }, layout.world, view);
}

export function useSurfaceCamera(
  field: Ref<HTMLElement | null>, layout: Readonly<Ref<SurfaceLayout>>,
  selectedId: Readonly<Ref<string | null>>, select: (id: string) => void,
) {
  const camera = shallowRef<Camera>({ zoom: 1, tx: 0, ty: 0 });
  const size = shallowRef<Size>({ width: 0, height: 0 });
  const compact = computed(() => camera.value.zoom < NAMEPLATE_ZOOM);
  let atHome = true;
  const bounds = computed(() => {
    const { tx, ty, zoom } = camera.value;
    return { x: -tx / zoom, y: -ty / zoom, width: size.value.width / zoom, height: size.value.height / zoom };
  });
  function available(): Size {
    const view = size.value;
    const el = field.value;
    const card = selectedId.value && el?.closest(".project-map")?.querySelector(".task-panel")?.getBoundingClientRect();
    if (!el || !card) return view;
    const stage = el.getBoundingClientRect();
    const right = Math.max(0, stage.right - card.left), bottom = Math.max(0, stage.bottom - card.top);
    // The card floats at the right or bottom. Use the larger uncovered rectangle.
    return freeView(view, right * view.height < bottom * view.width ? { ...NO_INSETS, right } : { ...NO_INSETS, bottom });
  }
  function fit(view: Size) {
    const world = layout.value.world;
    const inset = { width: Math.max(1, view.width - 24), height: Math.max(1, view.height - 24) };
    const zoom = world.width && view.width ? Math.min(1, fitCamera(world, inset).zoom) : 1;
    return clampCamera({ zoom, tx: 0, ty: 0 }, world, view);
  }
  function move(next: Camera, factor = 1, at?: Point) {
    const view = available();
    const zoomed = zoomCamera(next, factor, at ?? { x: view.width / 2, y: view.height / 2 }, fit(view), CLOSE_ZOOM);
    camera.value = containSurfaceCamera(zoomed, layout.value, view);
  }
  function centre(at: Point, zoom: number, view = available()) {
    atHome = false;
    camera.value = containSurfaceCamera({ zoom, tx: view.width / 2 - at.x * zoom, ty: view.height / 2 - at.y * zoom }, layout.value, view);
  }
  function focusTask(id: string) {
    const site = layout.value.sites.get(id);
    if (site) centre(site, 1);
  }
  function focusProject(project: string) {
    const region = layout.value.regions.get(project);
    if (!region) return;
    const { x0, x1, y0, y1 } = region.bounds;
    const view = available();
    const zoom = Math.min(1, fitCamera({ width: x1 - x0, height: y1 - y0 }, view).zoom);
    if (zoom >= NAMEPLATE_ZOOM) {
      centre({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, zoom, view);
    } else {
      const distance = (p: Point) => Math.hypot(p.x - region.label.x, p.y - region.label.y);
      const site = region.sites.reduce((a, b) => distance(a) < distance(b) ? a : b);
      centre({ x: (site.x + region.label.x) / 2, y: (site.y + region.label.y) / 2 }, 1, view);
    }
  }
  function home() {
    atHome = true;
    camera.value = fit(available());
  }
  function initialView() {
    if (selectedId.value !== null && layout.value.sites.has(selectedId.value)) focusTask(selectedId.value);
    else home();
  }
  function pan(from: Camera, dx: number, dy: number) {
    atHome = false;
    move({ ...from, tx: from.tx + dx, ty: from.ty + dy });
  }
  function zoomBy(factor: number, at?: Point) {
    atHome = false;
    move(camera.value, factor, at);
  }
  watch(() => layout.value.coastline, (next, old) => {
    if (!old || !next) initialView();
    else if (atHome) home();
    else move(camera.value);
  });

  let observer: ResizeObserver;
  let unlisten: () => void;
  onMounted(() => {
    const el = field.value!;
    function resize() {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      const before = size.value;
      if (width === before.width && height === before.height) return;
      size.value = { width, height };
      if (!before.width && atHome) initialView();
      else if (atHome) home();
      else pan(camera.value, (width - before.width) / 2, (height - before.height) / 2);
    }
    resize();
    observer = new ResizeObserver(resize);
    observer.observe(el);
    const input = createInput({
      now: () => performance.now(), origin: () => el.getBoundingClientRect(),
      viewport: available, camera: () => camera.value,
      onMap: () => true, paused: () => false, stopGlide() {}, hover() {}, leave() {},
      capture: id => el.setPointerCapture(id),
      cursor: style => { el.style.cursor = style; },
      pan: (dx, dy) => pan(camera.value, dx, dy), drag: pan, zoom: zoomBy, fit: home,
      click(at) {
        // Pointer capture delivers the release to the field, even for a tap on a building.
        const box = el.getBoundingClientRect();
        const hits = el.ownerDocument.elementsFromPoint(box.left + at.x, box.top + at.y);
        if (!el.contains(hits[0] ?? null)) return;
        // A neighbouring touch target can extend over the visible building.
        const hit = hits.find(node => node.matches(".building, .plate")) ?? hits[0];
        const button = hit?.closest<HTMLElement>("[data-task-id]");
        if (button) select(button.dataset.taskId!);
      },
    });
    unlisten = listen(el, el, input);
  });
  onBeforeUnmount(() => { observer?.disconnect(); unlisten?.(); });
  return { camera, bounds, compact, focusTask, focusProject, home, zoomBy };
}
