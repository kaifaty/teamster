import { computed, onBeforeUnmount, onMounted, shallowRef, watch, type Ref } from "vue";
import { fitCamera, zoomCamera, type Camera } from "../layout/camera";
import type { Point, Size } from "../layout/geometry";
import { createInput, listen } from "../scene/input";
import { BANK_WIDTH, type Region, type SurfaceLayout } from "./layout";

const FAR: Camera = { zoom: 0.5, tx: 0, ty: 0 };
const NAMEPLATE_ZOOM = 0.78;

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
  function centre(at: Point, zoom: number) {
    atHome = false;
    camera.value = { zoom, tx: size.value.width / 2 - at.x * zoom, ty: size.value.height / 2 - at.y * zoom };
  }
  function focusTask(id: string) {
    const site = layout.value.sites.get(id);
    if (site) centre(site, 1);
  }
  function frame(regions: Region[]) {
    if (!regions.length) return;
    let left = Infinity, right = -Infinity, bottom = 0;
    for (const region of regions) {
      const nameX = (region.bank + 0.5) * BANK_WIDTH;
      left = Math.min(left, nameX - 96);
      right = Math.max(right, nameX + 96);
      for (const site of region.sites) {
        left = Math.min(left, site.x - 110);
        right = Math.max(right, site.x + 110);
        bottom = Math.max(bottom, site.y + 92);
      }
    }
    const top = 48;
    const fit = fitCamera({ width: right - left, height: bottom - top }, size.value);
    if (fit.zoom >= NAMEPLATE_ZOOM) {
      centre({ x: (left + right) / 2, y: (top + bottom) / 2 }, Math.min(1, fit.zoom));
    } else if (regions.length > 1) {
      frame([regions[0]!]);
    } else {
      const first = regions[0]!.sites[0]!;
      centre({ x: first.x, y: first.y - 24 }, 1);
    }
  }
  function focusProject(project: string) {
    const region = layout.value.regions.get(project);
    if (region) frame([region]);
  }
  function home() {
    frame([...layout.value.regions.values()].sort((a, b) => a.bank - b.bank).slice(0, 2));
    atHome = true;
  }
  function initialView() {
    if (selectedId.value !== null && layout.value.sites.has(selectedId.value)) focusTask(selectedId.value);
    else home();
  }
  function pan(from: Camera, dx: number, dy: number, resizing = false) {
    if (!resizing) atHome = false;
    camera.value = { ...from, tx: from.tx + dx, ty: from.ty + dy };
  }
  function zoomBy(factor: number, at = { x: size.value.width / 2, y: size.value.height / 2 }) {
    atHome = false;
    camera.value = zoomCamera(camera.value, factor, at, FAR);
  }
  watch(layout, (next, old) => {
    if (![...old.regions.keys()].some(project => next.regions.has(project))) initialView();
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
      else if (before.width !== width && atHome) home();
      else pan(camera.value, (width - before.width) / 2, (height - before.height) / 2, true);
    }
    resize();
    observer = new ResizeObserver(resize);
    observer.observe(el);
    const input = createInput({
      now: () => performance.now(), origin: () => el.getBoundingClientRect(),
      viewport: () => size.value, camera: () => camera.value,
      onMap: () => true, paused: () => false, stopGlide() {}, hover() {}, leave() {},
      capture: id => el.setPointerCapture(id),
      cursor: style => { el.style.cursor = style; },
      pan: (dx, dy) => pan(camera.value, dx, dy), drag: pan, zoom: zoomBy, fit: home,
      click(at) {
        // Pointer capture delivers the release to the field, even for a tap on a building.
        const box = el.getBoundingClientRect();
        const button = el.ownerDocument.elementFromPoint(box.left + at.x, box.top + at.y)?.closest<HTMLElement>("[data-task-id]");
        if (button && el.contains(button)) select(button.dataset.taskId!);
      },
    });
    unlisten = listen(el, el, input);
  });
  onBeforeUnmount(() => { observer?.disconnect(); unlisten?.(); });
  return { camera, bounds, compact, focusTask, focusProject, home, zoomBy };
}
