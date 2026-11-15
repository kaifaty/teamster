// The parts of the stage the map's own panels cover, measured whenever the window, the toolbar or the panels change: the
// galaxy is fitted above the control panel at the bottom, a system is laid out in what the toolbar, the list at the side
// and the control panel leave free, and no star stands under the toolbar.

import { nextTick, onBeforeUnmount, onMounted, shallowRef, watch, type Ref } from "vue";
import { fitCamera, freeView, NO_INSETS, type Insets, type Rect } from "../layout";
import type { GalaxyModel } from "./useGalaxyModel";
import type { MapPanels } from "./useMapPanels";

export function useStageInsets(host: Readonly<Ref<HTMLElement | null>>, model: GalaxyModel, panels: MapPanels, scheduleLabels: () => void) {
  const { world } = model;
  const { repo, narrow, fleetVisible } = panels;

  /**
   * The parts of the window the panels cover: the toolbar, the list at the side and the control panel. The scene fits
   * the galaxy above the control panel and lays a system out in the rest. What opens over the map from the control panel
   * does not count: its own box keeps its size.
   */
  const insets = shallowRef<Insets>(NO_INSETS);
  function measureInsets() {
    const stage = host.value?.getBoundingClientRect();
    const root = host.value?.closest(".map");
    if (!stage || !root || !stage.width || !stage.height) return;
    const toolbar = root.querySelector<HTMLElement>(".toolbar")?.getBoundingClientRect();
    const top = toolbar ? Math.max(0, Math.round(toolbar.bottom - stage.top + 6)) : 0;
    const panel = host.value?.querySelector<HTMLElement>(".console")?.getBoundingClientRect();
    const bottom = panel ? Math.max(0, Math.round(stage.bottom - panel.top)) : 0;
    host.value!.style.setProperty("--below-toolbar", `${top}px`);
    host.value!.style.setProperty("--console-room", `${bottom}px`);
    host.value!.style.setProperty("--stage-height", `${Math.round(stage.height)}px`);
    const list = repo.value && fleetVisible.value && !narrow.value ? root.querySelector<HTMLElement>(".fleet")?.getBoundingClientRect() : null;
    const next = { top, right: list ? Math.max(0, Math.round(stage.right - list.left + 6)) : 0, bottom, left: 0 };
    const now = insets.value;
    if (next.top !== now.top || next.right !== now.right || next.bottom !== now.bottom) insets.value = next;
    measureCovered(stage, toolbar ?? null, bottom);
  }

  /**
   * Measures, for the window, the part of the galaxy's world under the toolbar, where no star stands, and the full view's
   * zoom. Only while the galaxy shows: a system's toolbar has other buttons.
   */
  let coveredFor = "";
  function measureCovered(stage: DOMRect, toolbar: DOMRect | null, bottom: number) {
    if (repo.value) return;
    const key = `${Math.round(stage.width)}x${Math.round(stage.height)}/${bottom}/${world.value.width}/${Math.round(toolbar?.bottom ?? 0)}`;
    if (key === coveredFor) return;
    coveredFor = key;
    const fit = fitCamera(world.value, freeView({ width: stage.width, height: stage.height }, { ...NO_INSETS, bottom }));
    const margin = 12;
    const parts: Rect[] = [];
    // The toolbar runs along the top: no star stands under it.
    if (toolbar) parts.push({ x0: 0, y0: 0, x1: world.value.width, y1: Math.max(0, (toolbar.bottom + margin - stage.top - fit.ty) / fit.zoom) });
    model.covered.value = parts;
    model.fullZoom.value = fit.zoom;
  }

  // The control panel changes its shape across the breakpoint, and the toolbar between the galaxy and a system.
  watch([narrow, repo], () => {
    coveredFor = "";
    void nextTick(() => {
      measureInsets();
      scheduleLabels();
    });
  });
  watch(fleetVisible, () => void nextTick(measureInsets));
  watch(world, () => void nextTick(measureInsets));

  let stageObserver: ResizeObserver | null = null;
  onMounted(() => {
    if (!host.value) return;
    stageObserver = new ResizeObserver(() => measureInsets());
    stageObserver.observe(host.value);
    // The toolbar wraps on a narrower window, and the control panel changes its height with its rows.
    const toolbar = host.value.closest(".map")?.querySelector(".toolbar");
    if (toolbar) stageObserver.observe(toolbar);
    const panel = host.value.querySelector(".console");
    if (panel) stageObserver.observe(panel);
  });
  onBeforeUnmount(() => stageObserver?.disconnect());

  return { insets, measureInsets };
}
