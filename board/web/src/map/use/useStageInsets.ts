// The parts of the stage the map's own panels cover, measured whenever the window, the toolbar or the panels change: a
// system is laid out in the rest, and no star stands under the log.

import { nextTick, onBeforeUnmount, onMounted, shallowRef, watch, type Ref } from "vue";
import { fitCamera, type Insets, type Rect } from "../layout";
import type { GalaxyModel } from "./useGalaxyModel";
import type { MapPanels } from "./useMapPanels";

export function useStageInsets(host: Readonly<Ref<HTMLElement | null>>, model: GalaxyModel, panels: MapPanels, scheduleLabels: () => void) {
  const { world } = model;
  const { repo, narrow, dockFolded, fleetVisible, compactDock } = panels;

  /**
   * Measures the parts of the window the panels cover, for the scene to lay a system out in the rest: the toolbar, the
   * list at the side and the folded dock. What opens over the map does not move the system. Each measure in a system
   * sets `insets` anew.
   */
  const insets = shallowRef<Insets>({ top: 0, right: 0, bottom: 0, left: 0 });
  function measureInsets() {
    const stage = host.value?.getBoundingClientRect();
    const root = host.value?.closest(".map");
    if (!stage || !root || !stage.width || !stage.height) return;
    const toolbar = root.querySelector<HTMLElement>(".toolbar")?.getBoundingClientRect();
    const top = toolbar ? Math.max(0, Math.round(toolbar.bottom - stage.top + 6)) : 0;
    host.value!.style.setProperty("--below-toolbar", `${top}px`);
    if (!repo.value) return;
    const panel = fleetVisible.value && !narrow.value ? root.querySelector<HTMLElement>(".fleet")?.getBoundingClientRect() : null;
    const dock = dockFolded.value ? root.querySelector<HTMLElement>(".dock")?.getBoundingClientRect() : null;
    insets.value = {
      top,
      right: panel ? Math.max(0, Math.round(stage.right - panel.left + 6)) : 0,
      bottom: dock ? Math.max(0, Math.round(stage.bottom - dock.top + 6)) : insets.value.bottom,
      left: 0,
    };
  }

  /**
   * Measures, for the window, the part of the world under the ship's log, where no star stands, and the full view's zoom.
   * A narrow dock is measured folded: what opens over the map does not move the stars. The galaxy's dock is measured
   * only while the galaxy shows: a system folds it.
   */
  let coveredFor = "";
  function measureCovered() {
    if (!dockFolded.value || repo.value) return;
    const stage = host.value?.getBoundingClientRect();
    const dock = host.value?.querySelector<HTMLElement>(".dock")?.getBoundingClientRect();
    const toolbar = host.value?.closest(".map")?.querySelector<HTMLElement>(".toolbar")?.getBoundingClientRect();
    if (!stage || !dock || !stage.width || !stage.height) return;
    const key = `${Math.round(stage.width)}x${Math.round(stage.height)}/${world.value.width}/${Math.round(toolbar?.bottom ?? 0)}`;
    if (key === coveredFor) return;
    coveredFor = key;
    const fit = fitCamera(world.value, { width: stage.width, height: stage.height });
    const margin = 12;
    const toWorld = (x: number, y: number) => ({ x: (x - stage.left - fit.tx) / fit.zoom, y: (y - stage.top - fit.ty) / fit.zoom });
    const from = toWorld(dock.left - margin, dock.top - margin);
    const to = toWorld(dock.right + margin, dock.bottom + margin);
    const parts: Rect[] = [{ x0: from.x, y0: from.y, x1: to.x, y1: Math.max(to.y, world.value.height) }];
    // The toolbar runs along the top: the columns at the edges start under it.
    if (toolbar) parts.push({ x0: 0, y0: 0, x1: world.value.width, y1: Math.max(0, toWorld(0, toolbar.bottom + margin).y) });
    model.covered.value = parts;
    model.fullZoom.value = fit.zoom;
  }

  // On a wide window the scale is part of the dock's shape: hidden, it leaves its corner to the stars.
  watch(panels.replayShown, () => {
    if (compactDock.value) return;
    coveredFor = "";
    void nextTick(() => {
      measureCovered();
      scheduleLabels();
    });
  });
  // The dock changes its shape across the breakpoint and between the galaxy and a system: it is measured again.
  watch([narrow, repo], () => {
    coveredFor = "";
    void nextTick(() => {
      measureCovered();
      measureInsets();
    });
  });
  // The open dock covers the map. Once it folds, a resize made meanwhile is measured and the star labels come back.
  watch(dockFolded, (folded) => {
    if (!folded) return;
    void nextTick(() => {
      measureCovered();
      measureInsets();
      scheduleLabels();
    });
  });
  watch(fleetVisible, () => void nextTick(measureInsets));
  watch(world, () => void nextTick(measureCovered));

  let stageObserver: ResizeObserver | null = null;
  onMounted(() => {
    if (!host.value) return;
    stageObserver = new ResizeObserver(() => {
      measureCovered();
      measureInsets();
    });
    stageObserver.observe(host.value);
    // The toolbar wraps on a narrower window: the list and a system start below it.
    const toolbar = host.value.closest(".map")?.querySelector(".toolbar");
    if (toolbar) stageObserver.observe(toolbar);
  });
  onBeforeUnmount(() => stageObserver?.disconnect());

  return { insets, measureInsets };
}
