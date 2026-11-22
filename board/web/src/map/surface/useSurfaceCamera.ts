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
  let current = camera.value;
  let frame = 0;
  const size = shallowRef<Size>({ width: 0, height: 0 });
  let view = size.value;
  let panel: HTMLElement | null = null;
  const compact = computed(() => camera.value.zoom < NAMEPLATE_ZOOM);
  let atHome = true;
  const bounds = computed(() => {
    const { tx, ty, zoom } = camera.value;
    return { x: -tx / zoom, y: -ty / zoom, width: size.value.width / zoom, height: size.value.height / zoom };
  });
  function fit(view: Size) {
    const world = layout.value.world;
    const inset = { width: Math.max(1, view.width - 24), height: Math.max(1, view.height - 24) };
    const zoom = world.width && view.width ? Math.min(1, fitCamera(world, inset).zoom) : 1;
    return clampCamera({ zoom, tx: 0, ty: 0 }, world, view);
  }
  function present() {
    cancelAnimationFrame(frame);
    frame = 0;
    camera.value = current;
  }
  function move(next: Camera, factor = 1, at?: Point, immediate = false) {
    const fitted = fit(view);
    const zoomed = zoomCamera(next, factor, at ?? { x: view.width / 2, y: view.height / 2 }, fitted, CLOSE_ZOOM);
    // At the fitted scale both axes are centred, even after a pan or a round trip through the zoom controls.
    atHome = zoomed.zoom <= fitted.zoom * (1 + 1e-9);
    current = atHome ? fitted : containSurfaceCamera(zoomed, layout.value, view);
    // Accumulate the input deltas and present one camera per frame.
    if (immediate) present();
    else if (!frame) frame = requestAnimationFrame(present);
  }
  function centre(at: Point, zoom: number) {
    atHome = false;
    current = containSurfaceCamera({ zoom, tx: view.width / 2 - at.x * zoom, ty: view.height / 2 - at.y * zoom }, layout.value, view);
    present();
  }
  function focusTask(id: string) {
    const site = layout.value.sites.get(id);
    if (site) centre(site, 1);
  }
  function focusProject(project: string) {
    const region = layout.value.regions.get(project);
    if (!region) return;
    const { x0, x1, y0, y1 } = region.bounds;
    const zoom = Math.min(1, fitCamera({ width: x1 - x0, height: y1 - y0 }, view).zoom);
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
    current = fit(view);
    present();
  }
  function initialView() {
    if (selectedId.value !== null && layout.value.sites.has(selectedId.value)) focusTask(selectedId.value);
    else home();
  }
  function pan(dx: number, dy: number) {
    const from = current;
    move({ ...from, tx: from.tx + dx, ty: from.ty + dy });
  }
  function zoomBy(factor: number, at?: Point) {
    move(current, factor, at);
  }
  watch(layout, (next, old) => {
    if (!old.sites.size || !next.sites.size) return initialView();
    const coastChanged = next.coastline !== old.coastline;
    if (atHome) {
      if (coastChanged) home();
      return;
    }

    const cam = current, fallback = { ...cam };
    let nearest = Infinity, removed = Infinity, tx = cam.tx, ty = cam.ty;
    // The selected building takes priority while visible. Otherwise follow the nearest surviving landmark.
    function anchor(from: Point, to: Point | undefined, selected = false) {
      const x = from.x * cam.zoom + cam.tx, y = from.y * cam.zoom + cam.ty;
      let visible = x >= 0 && x <= view.width && y >= 0 && y <= view.height;
      if (selected && !visible && field.value) {
        // A building below a floating side card can also be visible outside the free rectangle.
        const el = field.value, box = el.getBoundingClientRect();
        visible = el.contains(el.ownerDocument.elementFromPoint(box.left + x, box.top + y));
      }
      const distance = selected && visible ? -1 : Math.hypot(x - view.width / 2, y - view.height / 2);
      if (!to) {
        removed = Math.min(removed, distance);
        return;
      }
      if (distance >= nearest) return;
      nearest = distance;
      tx = cam.tx + (from.x - to.x) * cam.zoom;
      ty = cam.ty + (from.y - to.y) * cam.zoom;
      fallback.tx = visible ? tx : view.width / 2 - to.x * cam.zoom;
      fallback.ty = visible ? ty : view.height / 2 - to.y * cam.zoom;
    }
    for (const region of old.regions.values()) {
      anchor(region.label, next.regions.get(region.project)?.label);
      for (const site of region.sites) anchor(site, next.sites.get(site.task.id), site.task.id === selectedId.value);
    }
    if (nearest === Infinity) home();
    else if (removed < nearest) move(fallback, 1, undefined, true);
    else if (coastChanged || tx !== cam.tx || ty !== cam.ty) move({ ...cam, tx, ty }, 1, undefined, true);
  }, { flush: "post" });

  let observer: ResizeObserver;
  function measure() {
    const el = field.value!;
    const stage = el.getBoundingClientRect(), { width, height } = stage;
    if (!width || !height) return false;
    const before = size.value, previousView = view;
    if (width !== before.width || height !== before.height) size.value = { width, height };
    const nextPanel = selectedId.value ? el.closest(".project-map")?.querySelector<HTMLElement>(".task-panel") ?? null : null;
    if (nextPanel !== panel) {
      if (panel) observer.unobserve(panel);
      if (nextPanel) observer.observe(nextPanel);
      panel = nextPanel;
    }
    const card = panel?.getBoundingClientRect();
    view = size.value;
    if (card) {
      const right = Math.max(0, stage.right - card.left), bottom = Math.max(0, stage.bottom - card.top);
      // The card floats at the right or bottom. Use the larger uncovered rectangle.
      view = freeView(view, right * height < bottom * width ? { ...NO_INSETS, right } : { ...NO_INSETS, bottom });
    }
    return before !== size.value || previousView.width !== view.width || previousView.height !== view.height;
  }
  watch(selectedId, id => {
    if (!field.value || !observer || !measure() || id !== null) return;
    if (atHome) home();
    else {
      current = clampCamera(current, layout.value.world, view);
      present();
    }
  }, { flush: "post" });

  let unlisten: () => void;
  onMounted(() => {
    const el = field.value!;
    function resize() {
      const before = size.value;
      if (!measure()) return;
      const site = panel && selectedId.value !== null && layout.value.sites.get(selectedId.value);
      if (!before.width) initialView();
      else if (atHome) home();
      else if (site) centre(site, Math.max(current.zoom, fit(view).zoom));
      else move({
        ...current, tx: current.tx + (size.value.width - before.width) / 2, ty: current.ty + (size.value.height - before.height) / 2,
      }, 1, undefined, true);
    }
    observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    let dragged = { x: 0, y: 0 };
    const input = createInput({
      now: () => performance.now(), origin: () => el.getBoundingClientRect(),
      viewport: () => view, camera: () => { dragged = { x: 0, y: 0 }; return current; },
      onMap: () => true, paused: () => false, stopGlide() {}, hover() {}, leave() {},
      capture: id => el.setPointerCapture(id),
      cursor: style => { el.style.cursor = style; },
      pan, drag(_, x, y) {
        // A live layout update can move the camera between two events of the same drag.
        pan(x - dragged.x, y - dragged.y);
        dragged = { x, y };
      },
      zoom: zoomBy, fit: home,
      click(at) {
        // Pointer capture delivers the release to the field, even for a tap on a building.
        const box = el.getBoundingClientRect();
        const x = box.left + at.x, y = box.top + at.y;
        const hits = el.ownerDocument.elementsFromPoint(x, y);
        if (!el.contains(hits[0] ?? null)) return;
        const art = hits.find(node => node.matches(".building, .plate"))?.closest<HTMLElement>("[data-task-id]");
        if (art) return select(art.dataset.taskId!);

        // Expanded touch targets overlap. In the space between drawings, prefer the nearest visible building.
        const card = panel?.getBoundingClientRect();
        let distance = Infinity, nearest: string | undefined;
        for (const target of hits) {
          if (!(target instanceof HTMLElement) || !target.dataset.taskId) continue;
          const building = target.querySelector(".building")!.getBoundingClientRect();
          const left = Math.max(box.left, building.left), right = Math.min(box.right, building.right);
          const top = Math.max(box.top, building.top), bottom = Math.min(box.bottom, building.bottom);
          if (left >= right || top >= bottom) continue;
          if (card && card.left <= left && card.right >= right && card.top <= top && card.bottom >= bottom) continue;
          const d = Math.hypot(x - building.left - building.width / 2, y - building.top - building.height / 2);
          if (d < distance) { distance = d; nearest = target.dataset.taskId; }
        }
        if (nearest !== undefined) select(nearest);
      },
    });
    unlisten = listen(el, el, input);
  });
  onBeforeUnmount(() => { observer?.disconnect(); unlisten?.(); cancelAnimationFrame(frame); });
  return { camera, bounds, compact, focusTask, focusProject, home, zoomBy };
}
