import { computed, onBeforeUnmount, onMounted, shallowRef, watch, type Ref } from "vue";
import { clampCamera, fitCamera, zoomCamera, type Camera } from "../layout/camera";
import type { Point, Size } from "../layout/geometry";
import { createInput, listen } from "../scene/input";
import type { SurfaceLayout } from "./layout";

const NAMEPLATE_ZOOM = 0.78;
const CLOSE_ZOOM = 1.5;

export function containSurfaceCamera(next: Camera, layout: SurfaceLayout, view: Size): Camera {
  const camera = clampCamera(next, layout.world, view);
  // At a corner of the world's bounding box the entire screen could still be offshore.
  // Keep at least one clearing within reach, moving only as far as the nearest one needs.
  const insetX = Math.min(80 * camera.zoom, view.width / 4);
  const insetY = Math.min(80 * camera.zoom, view.height / 4);
  let distance = Infinity;
  let dx = 0, dy = 0;
  for (const site of layout.sites.values()) {
    const x = camera.tx + site.x * camera.zoom, y = camera.ty + site.y * camera.zoom;
    const shiftX = Math.max(insetX - x, Math.min(0, view.width - insetX - x));
    const shiftY = Math.max(insetY - y, Math.min(0, view.height - insetY - y));
    if (!shiftX && !shiftY) return camera;
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
  let current = camera.value;
  let frame = 0;
  const size = shallowRef<Size>({ width: 0, height: 0 });
  const compact = computed(() => camera.value.zoom < NAMEPLATE_ZOOM);
  let atHome = true;
  const bounds = computed(() => {
    const { tx, ty, zoom } = camera.value;
    return { x: -tx / zoom, y: -ty / zoom, width: size.value.width / zoom, height: size.value.height / zoom };
  });
  const fit = computed(() => {
    const world = layout.value.world, view = size.value;
    const inset = { width: Math.max(1, view.width - 24), height: Math.max(1, view.height - 24) };
    const zoom = world.width && view.width ? Math.min(1, fitCamera(world, inset).zoom) : 1;
    return clampCamera({ zoom, tx: 0, ty: 0 }, world, view);
  });
  function move(next: Camera, factor = 1, at = { x: size.value.width / 2, y: size.value.height / 2 }) {
    const zoomed = zoomCamera(next, factor, at, fit.value, CLOSE_ZOOM);
    // Apply every delta and pinch anchor in order, then present one camera per frame.
    current = containSurfaceCamera(zoomed, layout.value, size.value);
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      camera.value = current;
    });
  }
  function centre(at: Point, zoom: number) {
    atHome = false;
    move({ zoom, tx: size.value.width / 2 - at.x * zoom, ty: size.value.height / 2 - at.y * zoom });
  }
  function focusTask(id: string) {
    const site = layout.value.sites.get(id);
    if (site) centre(site, 1);
  }
  function focusProject(project: string) {
    const region = layout.value.regions.get(project);
    if (!region) return;
    const { x0, x1, y0, y1 } = region.bounds;
    const zoom = Math.min(1, fitCamera({ width: x1 - x0, height: y1 - y0 }, size.value).zoom);
    if (zoom >= NAMEPLATE_ZOOM) {
      centre({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, zoom);
    } else {
      const distance = (p: Point) => Math.hypot(p.x - region.label.x, p.y - region.label.y);
      const site = region.sites.reduce((a, b) => distance(a) < distance(b) ? a : b);
      centre({ x: (site.x + region.label.x) / 2, y: (site.y + region.label.y) / 2 }, 1);
    }
  }
  function home() {
    atHome = true;
    current = fit.value;
    camera.value = current;
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
    move(current, factor, at);
  }
  watch(layout, (next, old) => {
    if (!old.sites.size || !next.sites.size) initialView();
    else if (atHome) home();
    else move(current);
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
      else pan(current, (width - before.width) / 2, (height - before.height) / 2);
    }
    resize();
    observer = new ResizeObserver(resize);
    observer.observe(el);
    const input = createInput({
      now: () => performance.now(), origin: () => el.getBoundingClientRect(),
      viewport: () => size.value, camera: () => current,
      onMap: () => true, paused: () => false, stopGlide() {}, hover() {}, leave() {},
      capture: id => el.setPointerCapture(id),
      cursor: style => { el.style.cursor = style; },
      pan: (dx, dy) => pan(current, dx, dy), drag: pan, zoom: zoomBy, fit: home,
      click(at) {
        // Pointer capture delivers the release to the field, even for a tap on a building.
        const box = el.getBoundingClientRect();
        const button = el.ownerDocument.elementFromPoint(box.left + at.x, box.top + at.y)?.closest<HTMLElement>("[data-task-id]");
        if (button && el.contains(button)) select(button.dataset.taskId!);
      },
    });
    unlisten = listen(el, el, input);
  });
  onBeforeUnmount(() => { observer?.disconnect(); unlisten?.(); cancelAnimationFrame(frame); });
  return { camera, bounds, compact, focusTask, focusProject, home, zoomBy };
}
