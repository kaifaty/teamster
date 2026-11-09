// The stars' labels placed for the camera: measured when they change, laid out in an animation frame when the camera,
// the pointer or another label moves, so that none covers another, a busy star or a panel.

import { nextTick, onBeforeUnmount, ref, watch, type Ref } from "vue";
import { placeLabels, type StarLabel } from "../declutter";
import { fuelColumnRect, labelDrop, machineColumnRect, starSize, type Camera, type Rect, type Size } from "../layout";
import type { GalaxyModel } from "./useGalaxyModel";
import type { OverlayLabels } from "./useOverlayLabels";

/** A quiet star shows its name once a step of the galaxy's lattice is this many pixels on the screen. */
export const QUIET_NAMES_PX = 110;

export function useStarLabels(overlay: Readonly<Ref<HTMLElement | null>>, repo: Readonly<Ref<string | null>>, model: GalaxyModel, labels: OverlayLabels) {
  const hoveredStar = ref<string | null>(null);
  let lastCamera: Camera | null = null;
  let labelFrame = 0;
  /** The labels' sizes in pixels, measured when they change; the camera does not change them. */
  const labelSizes = new Map<string, Size>();

  function measureLabels() {
    labelSizes.clear();
    for (const el of overlay.value?.querySelectorAll<HTMLElement>("[data-star]") ?? []) {
      labelSizes.set(el.dataset.star!, { width: el.offsetWidth, height: el.offsetHeight });
    }
    scheduleLabels();
  }

  function scheduleLabels() {
    cancelAnimationFrame(labelFrame);
    labelFrame = requestAnimationFrame(placeStarLabels);
  }

  /** The scene's camera moved: the labels follow it. */
  function setCamera(camera: Camera) {
    lastCamera = camera;
    scheduleLabels();
  }

  /**
   * Places the star labels for the camera, the most pressing first: alarms, then systems waiting for you, then the
   * busiest. Each stands around its star where it covers no other label, busy star or panel; one with no room waits for
   * the zoom, except an alarm's or the one under the pointer.
   */
  function placeStarLabels() {
    const box = overlay.value;
    const camera = lastCamera;
    if (!box || !camera || repo.value) return;
    const frame = box.getBoundingClientRect();
    const relative = (rect: DOMRect): Rect => ({ x0: rect.left - frame.left, y0: rect.top - frame.top, x1: rect.right - frame.left, y1: rect.bottom - frame.top });
    const root = box.closest(".map") ?? box;
    const obstacles = [...root.querySelectorAll<HTMLElement>(".toolbar, .dock, .overlay .station, .overlay .tank, .overlay .machine, .overlay .machine-note, .overlay .constellation")]
      .filter((el) => el.offsetParent !== null)
      .map((el) => relative(el.getBoundingClientRect()));
    // The machines' stations and the tanks are drawn on the canvas: each whole column keeps the labels off, the gaps between
    // its rows too, so that no star's label stands across a station's wings or a tank's lamps.
    const column = model.machineColumn.value;
    const fuel = model.fuelColumn.value;
    for (const rect of [column ? machineColumnRect(column) : null, fuel ? fuelColumnRect(fuel) : null]) {
      if (!rect) continue;
      obstacles.push({
        x0: camera.tx + rect.x0 * camera.zoom,
        y0: camera.ty + rect.y0 * camera.zoom,
        x1: camera.tx + rect.x1 * camera.zoom,
        y1: camera.ty + rect.y1 * camera.zoom,
      });
    }
    const layout = model.galaxy.value;
    const names = layout.spacing * camera.zoom >= QUIET_NAMES_PX;
    const placed: StarLabel[] = [];
    for (const star of model.starList.value) {
      const point = layout.places.get(star.repo);
      const size = labelSizes.get(star.repo);
      const pointed = hoveredStar.value === star.repo;
      if (!point || !size || (!star.live && !names && !pointed)) continue;
      const x = camera.tx + point.x * camera.zoom;
      const y = camera.ty + point.y * camera.zoom;
      // A star off the screen has no label: there is nothing for it to name.
      if (x < 0 || y < 0 || x > frame.width || y > frame.height) continue;
      const ring = star.live ? starSize(star.live, layout) * 1.25 + 26 * layout.scale : starSize(0, layout) * 1.15;
      placed.push({
        id: star.repo,
        x,
        y,
        ...size,
        radius: ring * camera.zoom,
        drop: (star.live ? labelDrop(star.live, layout) : ring + 4) * camera.zoom,
        priority: pointed ? 1e9 : star.attention ? 1e6 + star.attention * 100 + star.live : star.ready ? 1e4 + star.ready * 10 + star.live : star.live,
        forced: pointed || star.attention > 0,
        solid: star.live > 0,
      });
    }
    const spots = placeLabels(placed, obstacles, { x0: 0, y0: 0, x1: frame.width, y1: frame.height });
    for (const el of box.querySelectorAll<HTMLElement>("[data-star]")) {
      const spot = spots.get(el.dataset.star!) ?? null;
      el.style.visibility = spot ? "visible" : "hidden";
      if (!spot) continue;
      el.style.setProperty("--dx", `${spot.dx}px`);
      el.style.setProperty("--dy", `${spot.dy}px`);
    }
  }

  watch([labels.starLabels, repo], () => void nextTick(measureLabels), { flush: "post" });
  // The machines', the tanks' and the constellations' labels are obstacles for the stars' ones.
  watch([labels.machineLabels, labels.machineNoteStyle, labels.tankLabels, labels.constellationLabels], () => void nextTick(scheduleLabels), { flush: "post" });
  watch(hoveredStar, scheduleLabels);
  onBeforeUnmount(() => cancelAnimationFrame(labelFrame));

  return { hoveredStar, scheduleLabels, setCamera };
}
